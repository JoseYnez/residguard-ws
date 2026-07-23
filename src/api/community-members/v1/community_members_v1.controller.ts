import type { FastifyRequest } from "fastify";
import { requireAuth } from "../../../core/auth/authenticate";
import { contextFor } from "../../../core/auth/community_access";
import { withTransaction } from "../../../core/db/with_transaction";
import { translatePgError, type MutationResult } from "../../../core/http/pg_errors";
import {
  communityMembersRepository,
  type CommunityMember,
  type ListCommunityMembersInput,
} from "./community_members_v1.repository";

// Orquestación del recurso community-members. El acceso a la comunidad de la
// ruta ya lo garantizó requireCommunityAccess (preHandler); aquí solo se
// ejecuta la transacción de negocio y se traducen los errores esperables.

const PG_MESSAGES = {
  conflict: "El usuario ya es miembro de esta comunidad.",
  reference: "El usuario no existe en la plataforma (o pertenece a otra cuenta).",
} as const;

export const communityMembersController = {
  async list(
    req: FastifyRequest,
    input: ListCommunityMembersInput,
  ): Promise<{ items: CommunityMember[]; total: number }> {
    return withTransaction(contextFor(req), (tx) => communityMembersRepository.list(tx, input));
  },

  async create(
    req: FastifyRequest,
    communityId: string,
    userId: string,
  ): Promise<MutationResult<CommunityMember>> {
    const claims = requireAuth(req);
    try {
      const member = await withTransaction(contextFor(req), (tx) =>
        communityMembersRepository.create(tx, claims.customerId, communityId, userId),
      );
      return { ok: true, value: member };
    } catch (err) {
      return { ok: false, error: translatePgError(err, PG_MESSAGES) };
    }
  },

  async softDelete(req: FastifyRequest, communityId: string, id: string): Promise<boolean> {
    return withTransaction(contextFor(req), (tx) =>
      communityMembersRepository.softDelete(tx, communityId, id),
    );
  },
};
