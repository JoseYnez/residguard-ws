import type { FastifyRequest } from "fastify";
import { requireAuth } from "../../../core/auth/authenticate";
import { contextFor } from "../../../core/auth/community_access";
import { withTransaction } from "../../../core/db/with_transaction";
import { translatePgError, type MutationResult } from "../../../core/http/pg_errors";
import {
  membersRepository,
  type CreateMemberInput,
  type CreatePhoneInput,
  type ListMembersInput,
  type Member,
  type MemberDetail,
  type MemberPhone,
  type UpdateMemberInput,
} from "./members_v1.repository";

// Orquestación del recurso members. El acceso a la comunidad de la ruta ya lo
// garantizó requireCommunityAccess (preHandler); aquí solo se ejecuta la
// transacción de negocio y se traducen los errores esperables.

const PG_MESSAGES = {
  conflict: "Ya hay una persona registrada con ese correo en esta comunidad.",
  reference: "La comunidad indicada no existe en esta cuenta.",
} as const;

const PHONE_PG_MESSAGES = {
  conflict: "La persona ya tiene registrado ese teléfono.",
  reference: "La persona indicada no existe en esta comunidad.",
} as const;

export const membersController = {
  async list(
    req: FastifyRequest,
    input: ListMembersInput,
  ): Promise<{ items: Member[]; total: number }> {
    return withTransaction(contextFor(req), (tx) => membersRepository.list(tx, input));
  },

  async getById(
    req: FastifyRequest,
    communityId: string,
    id: string,
  ): Promise<MemberDetail | null> {
    return withTransaction(contextFor(req), (tx) =>
      membersRepository.getById(tx, communityId, id),
    );
  },

  async create(
    req: FastifyRequest,
    communityId: string,
    input: CreateMemberInput,
  ): Promise<MutationResult<MemberDetail>> {
    const claims = requireAuth(req);
    try {
      const member = await withTransaction(contextFor(req), (tx) =>
        membersRepository.create(tx, claims.customerId, communityId, input),
      );
      return { ok: true, value: member };
    } catch (err) {
      return { ok: false, error: translatePgError(err, PG_MESSAGES) };
    }
  },

  /** `null` (fuera de ok/error) cuando la persona no existe → 404 en la route. */
  async update(
    req: FastifyRequest,
    communityId: string,
    id: string,
    input: UpdateMemberInput,
  ): Promise<MutationResult<MemberDetail> | null> {
    try {
      const member = await withTransaction(contextFor(req), (tx) =>
        membersRepository.update(tx, communityId, id, input),
      );
      if (member === null) {
        return null;
      }
      return { ok: true, value: member };
    } catch (err) {
      return { ok: false, error: translatePgError(err, PG_MESSAGES) };
    }
  },

  async softDelete(req: FastifyRequest, communityId: string, id: string): Promise<boolean> {
    return withTransaction(contextFor(req), (tx) =>
      membersRepository.softDelete(tx, communityId, id),
    );
  },

  // --- Teléfonos ---------------------------------------------------------------

  /** `null` cuando la persona no existe en la comunidad → 404 en la route. */
  async addPhone(
    req: FastifyRequest,
    communityId: string,
    memberId: string,
    input: CreatePhoneInput,
  ): Promise<MutationResult<MemberPhone> | null> {
    const claims = requireAuth(req);
    try {
      return await withTransaction(contextFor(req), async (tx) => {
        const exists = await membersRepository.exists(tx, communityId, memberId);
        if (!exists) {
          return null;
        }
        const phone = await membersRepository.addPhone(
          tx,
          claims.customerId,
          communityId,
          memberId,
          input,
        );
        return { ok: true as const, value: phone };
      });
    } catch (err) {
      return { ok: false, error: translatePgError(err, PHONE_PG_MESSAGES) };
    }
  },

  async removePhone(
    req: FastifyRequest,
    communityId: string,
    memberId: string,
    id: string,
  ): Promise<boolean> {
    return withTransaction(contextFor(req), (tx) =>
      membersRepository.softDeletePhone(tx, communityId, memberId, id),
    );
  },
};
