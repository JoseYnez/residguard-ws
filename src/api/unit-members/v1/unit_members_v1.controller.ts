import type { FastifyRequest } from "fastify";
import { requireAuth } from "../../../core/auth/authenticate";
import { contextFor } from "../../../core/auth/community_access";
import { withTransaction } from "../../../core/db/with_transaction";
import { translatePgError, type MutationResult } from "../../../core/http/pg_errors";
import {
  unitMembersRepository,
  type CreateUnitMemberInput,
  type ListUnitMembersInput,
  type UnitMember,
  type UpdateUnitMemberInput,
} from "./unit_members_v1.repository";

// Orquestación del recurso unit-members. El acceso a la unidad de la ruta ya
// lo garantizó requireUnitAccess (unidad → comunidad → membresía del actor).

const PG_MESSAGES = {
  conflict: "La persona ya está asociada a esta unidad.",
  reference: "El usuario indicado no existe en la plataforma (o pertenece a otra cuenta).",
} as const;

export const unitMembersController = {
  async list(
    req: FastifyRequest,
    input: ListUnitMembersInput,
  ): Promise<{ items: UnitMember[]; total: number }> {
    return withTransaction(contextFor(req), (tx) => unitMembersRepository.list(tx, input));
  },

  async getById(req: FastifyRequest, unitId: string, id: string): Promise<UnitMember | null> {
    return withTransaction(contextFor(req), (tx) =>
      unitMembersRepository.getById(tx, unitId, id),
    );
  },

  async create(
    req: FastifyRequest,
    unitId: string,
    input: CreateUnitMemberInput,
  ): Promise<MutationResult<UnitMember>> {
    const claims = requireAuth(req);
    try {
      const member = await withTransaction(contextFor(req), (tx) =>
        unitMembersRepository.create(tx, claims.customerId, unitId, input),
      );
      return { ok: true, value: member };
    } catch (err) {
      return { ok: false, error: translatePgError(err, PG_MESSAGES) };
    }
  },

  /** `null` (fuera de ok/error) cuando el miembro no existe → 404 en la route. */
  async update(
    req: FastifyRequest,
    unitId: string,
    id: string,
    input: UpdateUnitMemberInput,
  ): Promise<MutationResult<UnitMember> | null> {
    try {
      const member = await withTransaction(contextFor(req), (tx) =>
        unitMembersRepository.update(tx, unitId, id, input),
      );
      if (member === null) {
        return null;
      }
      return { ok: true, value: member };
    } catch (err) {
      return { ok: false, error: translatePgError(err, PG_MESSAGES) };
    }
  },

  async softDelete(req: FastifyRequest, unitId: string, id: string): Promise<boolean> {
    return withTransaction(contextFor(req), (tx) =>
      unitMembersRepository.softDelete(tx, unitId, id),
    );
  },
};
