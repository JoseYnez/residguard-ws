import type { FastifyRequest } from "fastify";
import { config } from "../../../config";
import { contextFor } from "../../../core/auth/community_access";
import { withTransaction } from "../../../core/db/with_transaction";
import type { BusinessError } from "../../../core/http/pg_errors";
import {
    visitsRepository,
    type ListVisitsInput,
    type Visit,
    type VisitEvent,
    type VisitWithVerdict,
} from "./visits_v1.repository";

// Orquestación del dominio `access` del lado de la OPERACIÓN. El acceso a la
// comunidad de la ruta ya lo garantizó requireCommunityAccess; aquí solo queda
// el negocio.

/**
 * El día de HOY en la zona de operación (DB_TIMEZONE), como YYYY-MM-DD.
 *
 * No es `new Date().toISOString().slice(0,10)`: eso da el día en UTC, y a las
 * 19:00 de México ya es el día siguiente allá — un pase registrado esa noche
 * "para hoy" nacería vencido. La BD evalúa CURRENT_DATE en esta misma zona
 * (§6 del CLAUDE.md), así que las dos mitades tienen que coincidir.
 */
export function todayInOperatingZone(): string {
    // 'en-CA' formatea como YYYY-MM-DD, que es justo el formato de negocio.
    return new Intl.DateTimeFormat("en-CA", { timeZone: config.dbTimezone }).format(new Date());
}

function daysBetween(from: string, to: string): number {
    const ms = Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`);
    return Math.round(ms / 86_400_000) + 1;
}

/** Entrada del alta ya NORMALIZADA: lo que se manda a la BD. */
export interface NormalizedVisitInput {
    readonly unitId: string;
    readonly visitType: string;
    readonly scheduleType: string;
    readonly visitorName: string;
    readonly visitorCompany: string | null;
    readonly visitorPhone: string | null;
    readonly vehiclePlate: string | null;
    readonly companions: number;
    readonly validFrom: string;
    readonly validTo: string;
    readonly timeFrom: string | null;
    readonly timeTo: string | null;
    readonly weekdays: readonly number[];
    readonly maxEntries: number | null;
    readonly requiresId: boolean;
    readonly notes: string | null;
}

export interface RawVisitInput {
    readonly unitId: string;
    readonly visitType?: string | null;
    readonly scheduleType?: string | null;
    readonly visitorName: string;
    readonly visitorCompany?: string | null;
    readonly visitorPhone?: string | null;
    readonly vehiclePlate?: string | null;
    readonly companions?: number | null;
    readonly validFrom: string;
    readonly validTo?: string | null;
    readonly timeFrom?: string | null;
    readonly timeTo?: string | null;
    readonly weekdays?: readonly number[] | null;
    readonly maxEntries?: number | null;
    readonly requiresId?: boolean | null;
    readonly notes?: string | null;
}

/**
 * Normaliza y valida el alta de un pase. Es DELIBERADAMENTE indulgente donde
 * puede serlo —el residente elige "qué es" y el resto se deduce— y estricta
 * solo donde una interpretación equivocada dejaría un pase que no abre:
 *
 *   * `single` fija `validTo = validFrom`. El cliente ni siquiera manda el
 *     segundo día para una visita de hoy.
 *   * fuera de `recurring`, los días de la semana se descartan (no significan
 *     nada) en vez de rechazar la petición.
 *   * `recurring` SIN días sí se rechaza: sería un pase que no es válido nunca.
 *
 * Los CHECK de la BD vuelven a exigir todo esto; aquí se hace para poder
 * responder con un mensaje que el residente entienda, en vez de un 23514.
 */
export function normalizeVisitInput(
    input: RawVisitInput,
): { ok: true; value: NormalizedVisitInput } | { ok: false; error: BusinessError } {
    const invalid = (message: string): { ok: false; error: BusinessError } => ({
        ok: false,
        error: { kind: "invalid", message },
    });

    const scheduleType = input.scheduleType ?? "single";
    const validFrom = input.validFrom;
    const validTo =
        scheduleType === "single" ? validFrom : (input.validTo ?? validFrom);

    if (validTo < validFrom) {
        return invalid("La fecha final no puede ser anterior a la inicial.");
    }

    const today = todayInOperatingZone();
    if (validTo < today) {
        return invalid("La visita ya habría vencido: elige una fecha de hoy en adelante.");
    }

    const span = daysBetween(validFrom, validTo);
    if (span > config.visitMaxValidityDays) {
        return invalid(
            `Una visita no puede durar más de ${config.visitMaxValidityDays} días. ` +
                "Registra un periodo más corto y renuévalo cuando termine.",
        );
    }

    const timeFrom = input.timeFrom ?? null;
    const timeTo = input.timeTo ?? null;
    if ((timeFrom === null) !== (timeTo === null)) {
        return invalid("El horario necesita hora de inicio y de fin, o ninguna de las dos.");
    }
    if (timeFrom !== null && timeTo !== null && timeTo <= timeFrom) {
        // Sin cruce de medianoche: el modelo no representa un pase de 22:00 a
        // 02:00 (son dos días), así que se rechaza en vez de evaluarlo mal.
        return invalid("La hora de fin debe ser posterior a la de inicio.");
    }

    // Únicos y ordenados: el mismo día repetido pone el mismo bit, y ordenarlos
    // hace que la respuesta sea estable venga como venga la petición.
    const weekdays =
        scheduleType === "recurring"
            ? [...new Set(input.weekdays ?? [])].sort((a, b) => a - b)
            : [];
    if (scheduleType === "recurring" && weekdays.length === 0) {
        return invalid("Una visita recurrente necesita al menos un día de la semana.");
    }

    return {
        ok: true,
        value: {
            unitId: input.unitId,
            visitType: input.visitType ?? "guest",
            scheduleType,
            visitorName: input.visitorName.trim(),
            visitorCompany: input.visitorCompany ?? null,
            visitorPhone: input.visitorPhone ?? null,
            vehiclePlate: input.vehiclePlate?.trim().toUpperCase() ?? null,
            companions: input.companions ?? 0,
            validFrom,
            validTo,
            timeFrom,
            timeTo,
            weekdays,
            maxEntries: input.maxEntries ?? null,
            requiresId: input.requiresId ?? false,
            notes: input.notes ?? null,
        },
    };
}

export const visitsController = {
    async list(
        req: FastifyRequest,
        input: ListVisitsInput,
    ): Promise<{ items: Visit[]; total: number }> {
        return withTransaction(contextFor(req), (tx) => visitsRepository.list(tx, input));
    },

    /** `null` → 404 (inexistente o de otra comunidad). */
    async getById(
        req: FastifyRequest,
        communityId: string,
        id: string,
    ): Promise<{ visit: Visit; events: VisitEvent[] } | null> {
        return withTransaction(contextFor(req), async (tx) => {
            const visit = await visitsRepository.getById(tx, communityId, id);
            if (visit === null) {
                return null;
            }
            const events = await visitsRepository.listEvents(tx, communityId, id);
            return { visit, events };
        });
    },

    /** Consulta de caseta. `null` → 404: ese código no existe aquí. */
    async findByCode(
        req: FastifyRequest,
        communityId: string,
        code: string,
    ): Promise<VisitWithVerdict | null> {
        return withTransaction(contextFor(req), (tx) =>
            visitsRepository.findByCode(tx, communityId, code),
        );
    },

    /**
     * Registra la entrada. `null` → 404; un veredicto distinto de `ok` → 409:
     * el actor VE el pase pero no puede consumirlo ahora, que es exactamente lo
     * que 409 significa (mismo criterio que anular un cargo con pagos).
     */
    async checkIn(
        req: FastifyRequest,
        communityId: string,
        visitId: string,
        input: {
            readonly visitorName: string | null;
            readonly visitorDocument: string | null;
            readonly companions: number | null;
            readonly vehiclePlate: string | null;
            readonly gate: string | null;
            readonly notes: string | null;
        },
    ): Promise<VisitWithVerdict | null> {
        return withTransaction(contextFor(req), (tx) =>
            visitsRepository.checkIn(tx, communityId, visitId, input),
        );
    },
};
