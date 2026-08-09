import type { FastifyRequest } from "fastify";
import { config } from "../../../config";
import { requireAuth } from "../../../core/auth/authenticate";
import { contextFor } from "../../../core/auth/community_access";
import { withTransaction } from "../../../core/db/with_transaction";
import { translatePgError, type MutationResult } from "../../../core/http/pg_errors";
import type { UnitChargeStatement } from "../../reports/v1/reports_v1.repository";
import {
  normalizeVisitInput,
  type RawVisitInput,
} from "../../visits/v1/visits_v1.controller";
import type { Visit } from "../../visits/v1/visits_v1.repository";
import { meRepository, type MyUnit } from "./me_v1.repository";

// Orquestación del recurso me. No hay preHandler de alcance que garantizar:
// el "alcance" ES el usuario del token (claims.sub), y la pertenencia de cada
// unidad la resuelve el repositorio por el vínculo del padrón.

export const meController = {
  async listMyUnits(req: FastifyRequest): Promise<MyUnit[]> {
    const claims = requireAuth(req);
    return withTransaction(contextFor(req), (tx) => meRepository.listMyUnits(tx, claims.sub));
  },

  /** `null` cuando la unidad no es del usuario (o no existe) → 404 en la route. */
  async myUnitStatement(
    req: FastifyRequest,
    input: {
      readonly unitId: string;
      readonly from: string;
      readonly to: string;
      readonly page: number;
      readonly pageSize: number;
    },
  ): Promise<UnitChargeStatement | null> {
    const claims = requireAuth(req);
    return withTransaction(contextFor(req), (tx) =>
      meRepository.myUnitStatement(tx, claims.sub, input),
    );
  },

  // --- Mis visitas -----------------------------------------------------------

  async listMyVisits(
    req: FastifyRequest,
    input: {
      readonly page: number;
      readonly pageSize: number;
      readonly unitId?: string | null;
      readonly state?: string | null;
    },
  ): Promise<{ items: Visit[]; total: number }> {
    const claims = requireAuth(req);
    return withTransaction(contextFor(req), (tx) =>
      meRepository.listMyVisits(tx, claims.sub, input),
    );
  },

  /** `null` cuando el pase no es del usuario (o no existe) → 404. */
  async myVisit(req: FastifyRequest, visitId: string): Promise<Visit | null> {
    const claims = requireAuth(req);
    return withTransaction(contextFor(req), (tx) => meRepository.myVisit(tx, claims.sub, visitId));
  },

  /**
   * Registra un pase para una unidad mía.
   *
   * Devuelve `null` (→ 404) cuando la unidad no es del usuario: mismo criterio
   * que el resto del servicio — fuera de alcance es indistinguible de
   * inexistente, y aquí además evita que alguien descubra unidades ajenas
   * probando ids.
   */
  async createMyVisit(
    req: FastifyRequest,
    input: RawVisitInput,
  ): Promise<MutationResult<Visit> | null> {
    const claims = requireAuth(req);

    const normalized = normalizeVisitInput(input);
    if (!normalized.ok) {
      return normalized;
    }

    try {
      return await withTransaction(contextFor(req), async (tx) => {
        const scope = await meRepository.myUnitScope(tx, claims.sub, input.unitId);
        if (scope === null) {
          return null;
        }

        // Freno anti-abuso: se cuenta DENTRO de la transacción, así que dos
        // altas simultáneas no pueden colarse las dos por encima del tope.
        const active = await meRepository.countActiveVisitsForUnit(tx, input.unitId);
        if (active >= config.visitMaxActivePerUnit) {
          return {
            ok: false as const,
            error: {
              kind: "conflict" as const,
              message:
                `Esta unidad ya tiene ${config.visitMaxActivePerUnit} visitas vigentes. ` +
                "Cancela alguna antes de registrar otra.",
            },
          };
        }

        const visit = await meRepository.createMyVisit(
          tx,
          claims.sub,
          claims.customerId,
          normalized.value,
        );
        return visit === null ? null : { ok: true as const, value: visit };
      });
    } catch (err) {
      return {
        ok: false,
        error: translatePgError(err, {
          check: "Los datos de la visita no son válidos: revisa fechas, horario y días.",
          reference: "La unidad no existe o está fuera de tu alcance.",
        }),
      };
    }
  },

  /** `null` cuando el pase no es del usuario (o no existe) → 404. */
  async cancelMyVisit(req: FastifyRequest, visitId: string): Promise<Visit | null> {
    const claims = requireAuth(req);
    return withTransaction(contextFor(req), (tx) =>
      meRepository.cancelMyVisit(tx, claims.sub, visitId),
    );
  },
};
