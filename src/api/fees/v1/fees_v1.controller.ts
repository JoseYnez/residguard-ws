import type { FastifyRequest } from "fastify";
import { requireAuth } from "../../../core/auth/authenticate";
import { contextFor } from "../../../core/auth/community_access";
import { withTransaction } from "../../../core/db/with_transaction";
import { translatePgError, type MutationResult } from "../../../core/http/pg_errors";
import {
  feesRepository,
  type CreateFeeInput,
  type Fee,
  type ListFeesInput,
  type UpdateFeeInput,
} from "./fees_v1.repository";

// Orquestación del recurso fees. El acceso a la comunidad ya lo garantizó
// requireCommunityAccess; el tenant sale del token (RLS).

const PG_MESSAGES = {
  overlap: "Ya existe una cuota con ese concepto cuya vigencia se solapa.",
  reference: "La comunidad no existe o está fuera de tu alcance.",
  check: "El monto o la vigencia de la cuota no son válidos.",
} as const;

/** Cross-field que el verifier no cubre: la vigencia debe estar bien ordenada
 *  (mismo criterio que ck_fees_effective_range, con mensaje claro y sin BD). */
function invalidRange(from: string | undefined, to: string | null | undefined): boolean {
  return typeof from === "string" && typeof to === "string" && to < from;
}

export const feesController = {
  async list(
    req: FastifyRequest,
    input: ListFeesInput,
  ): Promise<{ items: Fee[]; total: number }> {
    return withTransaction(contextFor(req), (tx) => feesRepository.list(tx, input));
  },

  async getById(req: FastifyRequest, communityId: string, id: string): Promise<Fee | null> {
    return withTransaction(contextFor(req), (tx) => feesRepository.getById(tx, communityId, id));
  },

  async create(
    req: FastifyRequest,
    communityId: string,
    input: CreateFeeInput,
  ): Promise<MutationResult<Fee>> {
    if (invalidRange(input.effectiveFrom, input.effectiveTo)) {
      return {
        ok: false,
        error: { kind: "invalid", message: "El fin de vigencia no puede ser anterior al inicio." },
      };
    }
    const claims = requireAuth(req);
    try {
      const fee = await withTransaction(contextFor(req), (tx) =>
        feesRepository.create(tx, claims.customerId, communityId, input),
      );
      return { ok: true, value: fee };
    } catch (err) {
      return { ok: false, error: translatePgError(err, PG_MESSAGES) };
    }
  },

  /** `null` (fuera de ok/error) cuando la cuota no existe → 404 en la route. */
  async update(
    req: FastifyRequest,
    communityId: string,
    id: string,
    input: UpdateFeeInput,
  ): Promise<MutationResult<Fee> | null> {
    if (invalidRange(input.effectiveFrom, input.effectiveTo)) {
      return {
        ok: false,
        error: { kind: "invalid", message: "El fin de vigencia no puede ser anterior al inicio." },
      };
    }
    try {
      const fee = await withTransaction(contextFor(req), (tx) =>
        feesRepository.update(tx, communityId, id, input),
      );
      if (fee === null) {
        return null;
      }
      return { ok: true, value: fee };
    } catch (err) {
      return { ok: false, error: translatePgError(err, PG_MESSAGES) };
    }
  },

  async softDelete(req: FastifyRequest, communityId: string, id: string): Promise<boolean> {
    return withTransaction(contextFor(req), (tx) =>
      feesRepository.softDelete(tx, communityId, id),
    );
  },
};
