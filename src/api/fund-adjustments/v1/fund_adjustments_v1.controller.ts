import type { FastifyRequest } from "fastify";
import { requireAuth } from "../../../core/auth/authenticate";
import { contextFor } from "../../../core/auth/community_access";
import { withTransaction } from "../../../core/db/with_transaction";
import { translatePgError, type MutationResult } from "../../../core/http/pg_errors";
import {
  fundAdjustmentsRepository,
  type CreateFundAdjustmentInput,
  type FundAdjustment,
  type ListFundAdjustmentsInput,
  type UpdateFundAdjustmentInput,
} from "./fund_adjustments_v1.repository";

// Orquestación del recurso fund-adjustments. El acceso a la comunidad de la
// ruta ya lo garantizó requireCommunityAccess. El monto con signo nunca puede
// ser cero (se valida aquí; el check de BD es el respaldo).

const ZERO_AMOUNT: MutationResult<never> = {
  ok: false,
  error: { kind: "invalid", message: "El monto del movimiento no puede ser cero." },
};

const PG_MESSAGES = {
  check: "El monto del movimiento no puede ser cero.",
  reference: "La comunidad no existe o está fuera de tu alcance.",
} as const;

export const fundAdjustmentsController = {
  async list(
    req: FastifyRequest,
    input: ListFundAdjustmentsInput,
  ): Promise<{ items: FundAdjustment[]; total: number }> {
    return withTransaction(contextFor(req), (tx) => fundAdjustmentsRepository.list(tx, input));
  },

  async getById(
    req: FastifyRequest,
    communityId: string,
    id: string,
  ): Promise<FundAdjustment | null> {
    return withTransaction(contextFor(req), (tx) =>
      fundAdjustmentsRepository.getById(tx, communityId, id),
    );
  },

  async create(
    req: FastifyRequest,
    communityId: string,
    input: CreateFundAdjustmentInput,
  ): Promise<MutationResult<FundAdjustment>> {
    if (input.amount === 0) {
      return ZERO_AMOUNT;
    }
    const claims = requireAuth(req);
    try {
      const adjustment = await withTransaction(contextFor(req), (tx) =>
        fundAdjustmentsRepository.create(tx, claims.customerId, communityId, input),
      );
      return { ok: true, value: adjustment };
    } catch (err) {
      return { ok: false, error: translatePgError(err, PG_MESSAGES) };
    }
  },

  /** `null` (fuera de ok/error) cuando el movimiento no existe → 404. */
  async update(
    req: FastifyRequest,
    communityId: string,
    id: string,
    input: UpdateFundAdjustmentInput,
  ): Promise<MutationResult<FundAdjustment> | null> {
    if (input.amount === 0) {
      return ZERO_AMOUNT;
    }
    try {
      const adjustment = await withTransaction(contextFor(req), (tx) =>
        fundAdjustmentsRepository.update(tx, communityId, id, input),
      );
      if (adjustment === null) {
        return null;
      }
      return { ok: true, value: adjustment };
    } catch (err) {
      return { ok: false, error: translatePgError(err, PG_MESSAGES) };
    }
  },

  async softDelete(req: FastifyRequest, communityId: string, id: string): Promise<boolean> {
    return withTransaction(contextFor(req), (tx) =>
      fundAdjustmentsRepository.softDelete(tx, communityId, id),
    );
  },
};
