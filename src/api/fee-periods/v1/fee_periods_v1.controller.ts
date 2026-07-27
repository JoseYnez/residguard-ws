import type { FastifyRequest } from "fastify";
import { contextFor } from "../../../core/auth/community_access";
import { withTransaction } from "../../../core/db/with_transaction";
import { translatePgError, type MutationResult } from "../../../core/http/pg_errors";
import {
  feePeriodsRepository,
  type CreateFeePeriodInput,
  type FeePeriod,
  type ListFeePeriodsInput,
} from "./fee_periods_v1.repository";

// Orquestación del recurso fee-periods. El acceso a la comunidad ya lo
// garantizó requireCommunityAccess; que la CUOTA sea de esa comunidad se
// verifica aquí (fuera del alcance → null → 404, indistinguible de inexistente).

const PG_MESSAGES = {
  overlap: "El rango se solapa con otro periodo de la cuota.",
  check: "El rango o el monto del periodo no son válidos.",
  notFound: "La cuota no está disponible para la comunidad.",
} as const;

export const feePeriodsController = {
  /** `null` cuando la cuota no existe en la comunidad → 404 en la route. */
  async list(
    req: FastifyRequest,
    input: ListFeePeriodsInput,
  ): Promise<{ items: FeePeriod[]; total: number } | null> {
    return withTransaction(contextFor(req), async (tx) => {
      const exists = await feePeriodsRepository.feeExists(tx, input.communityId, input.feeId);
      if (!exists) {
        return null;
      }
      return feePeriodsRepository.list(tx, input);
    });
  },

  /** `null` (fuera de ok/error) cuando la cuota no existe → 404 en la route. */
  async create(
    req: FastifyRequest,
    communityId: string,
    feeId: string,
    input: CreateFeePeriodInput,
  ): Promise<MutationResult<FeePeriod> | null> {
    // Cross-field que el verifier no cubre (mismo criterio que ck_fee_periods_period).
    if (input.periodEnd < input.periodStart) {
      return {
        ok: false,
        error: { kind: "invalid", message: "El fin del periodo no puede ser anterior al inicio." },
      };
    }
    try {
      return await withTransaction(contextFor(req), async (tx) => {
        const exists = await feePeriodsRepository.feeExists(tx, communityId, feeId);
        if (!exists) {
          return null;
        }
        const period = await feePeriodsRepository.create(tx, feeId, input);
        return { ok: true as const, value: period };
      });
    } catch (err) {
      return { ok: false, error: translatePgError(err, PG_MESSAGES) };
    }
  },

  /** `null` cuando el periodo no existe en la cuota/comunidad → 404. */
  async updateLabel(
    req: FastifyRequest,
    communityId: string,
    feeId: string,
    id: string,
    label: string | null,
  ): Promise<FeePeriod | null> {
    return withTransaction(contextFor(req), (tx) =>
      feePeriodsRepository.updateLabel(tx, communityId, feeId, id, label),
    );
  },

  async softDelete(
    req: FastifyRequest,
    communityId: string,
    feeId: string,
    id: string,
  ): Promise<"deleted" | "not-found" | "has-charges"> {
    return withTransaction(contextFor(req), (tx) =>
      feePeriodsRepository.softDelete(tx, communityId, feeId, id),
    );
  },
};
