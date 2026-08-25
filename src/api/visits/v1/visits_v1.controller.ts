import type { FastifyRequest } from "fastify";
import { config } from "../../../config";
import { contextFor } from "../../../core/auth/community_access";
import { withTransaction } from "../../../core/db/with_transaction";
import type { BusinessError } from "../../../core/http/pg_errors";
import { storageClient, type StorageFileMetadata } from "../../../core/storage/storage_client";
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
    readonly accessMode: string;
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
    /** Política de reingreso; el verifier ya la acotó a free/normal/strict. */
    readonly accessMode?: string | null;
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
            accessMode: input.accessMode ?? "normal",
            requiresId: input.requiresId ?? false,
            notes: input.notes ?? null,
        },
    };
}

// --- Evidencia fotográfica de la entrada --------------------------------------

/** Lo que una foto de caseta puede ser. Sin PDF a propósito: esto documenta lo
 *  que había frente a la barrera, y un PDF no sale de una cámara. */
const GATE_PHOTO_CONTENT_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

/**
 * La regla que el verifier no puede expresar: la entrada exige AL MENOS una
 * foto, o el motivo por el que se registra sin ella — nunca ninguno de los dos
 * (la obligatoriedad es el punto de la feature) y nunca ambos (un motivo junto
 * a fotos es un dato que miente). Devuelve el mensaje del 400, o null si la
 * combinación es legal.
 *
 * Aplica SOLO aquí, en el endpoint de caseta: las salidas heredan su evento de
 * entrada y los eventos de dispositivo (checadores futuros) no pasan por esta
 * ruta — exentos por construcción, no por excepción.
 */
export function evidenceRuleError(
    fileIds: readonly string[],
    noEvidenceReason: string,
): string | null {
    if (new Set(fileIds).size !== fileIds.length) {
        return "La misma foto no puede adjuntarse dos veces a la entrada.";
    }
    if (fileIds.length === 0 && noEvidenceReason === "") {
        return "La entrada necesita al menos una foto, o el motivo por el que se registra sin ella.";
    }
    if (fileIds.length > 0 && noEvidenceReason !== "") {
        return "Una entrada con fotos no lleva motivo de 'sin evidencia': manda uno u otro.";
    }
    return null;
}

/**
 * Valida contra storage cada foto que la entrada declara y devuelve su metadata
 * (el espejo a copiar). Un id inexistente —o un archivo que no es imagen— tumba
 * el registro completo ANTES de abrir la transacción: no se abre una barrera
 * prometiendo evidencia que no existe. Misma mecánica que las evidencias de
 * pago, con la lista de tipos acotada a fotos.
 */
async function resolveGatePhotos(
    fileIds: readonly string[],
): Promise<{ ok: true; files: StorageFileMetadata[] } | { ok: false; message: string }> {
    const files: StorageFileMetadata[] = [];
    for (const fileId of fileIds) {
        const result = await storageClient.getFile(fileId);
        if (!result.ok) {
            return {
                ok: false,
                message:
                    result.status === 404
                        ? "Alguna de las fotos no existe en el almacén. Vuelve a tomarla."
                        : "No se pudo validar la foto contra el almacén de archivos. Intenta de nuevo.",
            };
        }
        if (!GATE_PHOTO_CONTENT_TYPES.has(result.value.contentType)) {
            return {
                ok: false,
                message: "La evidencia de caseta debe ser una foto (JPEG, PNG o WebP).",
            };
        }
        files.push(result.value);
    }
    return { ok: true, files };
}

/** El check-in ahora puede fallar por NEGOCIO (la regla de evidencia) además
 *  de por veredicto: `ok: false` es el 400, el veredicto sigue viajando en
 *  `value` y decide entre 201 y 409 como siempre. */
export type CheckInOutcome =
    | { readonly ok: true; readonly value: VisitWithVerdict }
    | { readonly ok: false; readonly error: BusinessError };

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
     * Registra la entrada. `null` → 404; `ok: false` → 400 (la regla de
     * evidencia); un veredicto distinto de `ok` → 409: el actor VE el pase pero
     * no puede consumirlo ahora, que es exactamente lo que 409 significa (mismo
     * criterio que anular un cargo con pagos).
     *
     * Las fotos se validan contra storage ANTES de abrir la transacción (HTTP
     * dentro de una tx es tiempo de lock regalado), y sus filas se insertan en
     * la MISMA transacción que el evento.
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
            readonly fileIds: readonly string[];
            readonly noEvidenceReason: string | null;
        },
    ): Promise<CheckInOutcome | null> {
        const reason = input.noEvidenceReason?.trim() ?? "";
        const ruleError = evidenceRuleError(input.fileIds, reason);
        if (ruleError !== null) {
            return { ok: false, error: { kind: "invalid", message: ruleError } };
        }

        const resolved = await resolveGatePhotos(input.fileIds);
        if (!resolved.ok) {
            return { ok: false, error: { kind: "invalid", message: resolved.message } };
        }

        const result = await withTransaction(contextFor(req), (tx) =>
            visitsRepository.checkIn(tx, communityId, visitId, {
                visitorName: input.visitorName,
                visitorDocument: input.visitorDocument,
                companions: input.companions,
                vehiclePlate: input.vehiclePlate,
                gate: input.gate,
                notes: input.notes,
                files: resolved.files,
                noEvidenceReason: reason === "" ? null : reason,
            }),
        );
        if (result === null) {
            return null;
        }
        return { ok: true, value: result };
    },

    /**
     * Registra la salida. `null` → 404; `recorded: false` → 409 (el pase existe
     * pero no tiene una entrada abierta que cerrar). A diferencia del check-in,
     * la vigencia NO se consulta: quien entró sale, aunque su pase haya vencido
     * mientras estaba adentro.
     */
    async checkOut(
        req: FastifyRequest,
        communityId: string,
        visitId: string,
        input: {
            readonly gate: string | null;
            readonly notes: string | null;
        },
    ): Promise<{ recorded: boolean; value: VisitWithVerdict } | null> {
        return withTransaction(contextFor(req), (tx) =>
            visitsRepository.checkOut(tx, communityId, visitId, input),
        );
    },

    /**
     * Enlace firmado de descarga de una foto de la bitácora. El alcance por
     * comunidad ya lo garantizó requireCommunityAccess; el lookup solo confirma
     * que el archivo pertenece a ese evento y ese pase — y entonces este
     * servicio emite el enlace con su API key. La SPA nunca descarga de storage
     * con el Bearer: el RBAC de storage es por app, no por recurso.
     */
    async eventFileLink(
        req: FastifyRequest,
        communityId: string,
        visitId: string,
        eventId: string,
        fileId: string,
    ): Promise<{ url: string; expiresAt: string } | "not_found" | "unavailable"> {
        const ref = await withTransaction(contextFor(req), (tx) =>
            visitsRepository.getEventFileRef(tx, communityId, visitId, eventId, fileId),
        );
        if (ref === null) {
            return "not_found";
        }
        const link = await storageClient.createDownloadLink(ref.storageFileId);
        if (!link.ok) {
            return link.status === 404 ? "not_found" : "unavailable";
        }
        return link.value;
    },
};
