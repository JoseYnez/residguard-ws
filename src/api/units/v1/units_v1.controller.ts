import type { FastifyRequest } from "fastify";
import { requireAuth } from "../../../core/auth/authenticate";
import { contextFor } from "../../../core/auth/community_access";
import { withTransaction } from "../../../core/db/with_transaction";
import { translatePgError, type MutationResult } from "../../../core/http/pg_errors";
import {
  unitsRepository,
  type CreateUnitInput,
  type ListUnitsInput,
  type Unit,
  type UpdateUnitInput,
} from "./units_v1.repository";

// Orquestación del recurso units. El acceso a la comunidad de la ruta ya lo
// garantizó requireCommunityAccess; el tenant sale del token (RLS).

const PG_MESSAGES = {
  conflict: "Ya existe una unidad con ese código en la comunidad.",
  reference: "La comunidad no existe o está fuera de tu alcance.",
} as const;

export const unitsController = {
  async list(
    req: FastifyRequest,
    input: ListUnitsInput,
  ): Promise<{ items: Unit[]; total: number }> {
    return withTransaction(contextFor(req), (tx) => unitsRepository.list(tx, input));
  },

  async getById(req: FastifyRequest, communityId: string, id: string): Promise<Unit | null> {
    return withTransaction(contextFor(req), (tx) => unitsRepository.getById(tx, communityId, id));
  },

  async create(
    req: FastifyRequest,
    communityId: string,
    input: CreateUnitInput,
  ): Promise<MutationResult<Unit>> {
    const claims = requireAuth(req);
    try {
      const unit = await withTransaction(contextFor(req), (tx) =>
        unitsRepository.create(tx, claims.customerId, communityId, input),
      );
      return { ok: true, value: unit };
    } catch (err) {
      return { ok: false, error: translatePgError(err, PG_MESSAGES) };
    }
  },

  /** `null` (fuera de ok/error) cuando la unidad no existe → 404 en la route. */
  async update(
    req: FastifyRequest,
    communityId: string,
    id: string,
    input: UpdateUnitInput,
  ): Promise<MutationResult<Unit> | null> {
    try {
      const unit = await withTransaction(contextFor(req), (tx) =>
        unitsRepository.update(tx, communityId, id, input),
      );
      if (unit === null) {
        return null;
      }
      return { ok: true, value: unit };
    } catch (err) {
      return { ok: false, error: translatePgError(err, PG_MESSAGES) };
    }
  },

  async softDelete(req: FastifyRequest, communityId: string, id: string): Promise<boolean> {
    return withTransaction(contextFor(req), (tx) =>
      unitsRepository.softDelete(tx, communityId, id),
    );
  },
};
