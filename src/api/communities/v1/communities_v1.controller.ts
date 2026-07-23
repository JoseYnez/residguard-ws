import type { FastifyRequest } from "fastify";
import { requireAuth } from "../../../core/auth/authenticate";
import { contextFor } from "../../../core/auth/community_access";
import { withTransaction } from "../../../core/db/with_transaction";
import {
  communitiesRepository,
  type Community,
} from "./communities_v1.repository";

// Orquestación del recurso communities: contexto de auditoría desde el token
// y UNA transacción de negocio por endpoint. El alcance por membresía lo
// aplica el repository (JOIN con community_members).

export const communitiesController = {
  async list(
    req: FastifyRequest,
    input: { page: number; pageSize: number; search?: string | null },
  ): Promise<{ items: Community[]; total: number }> {
    const claims = requireAuth(req);
    return withTransaction(contextFor(req), (tx) =>
      communitiesRepository.list(tx, { ...input, userId: claims.sub }),
    );
  },

  async getById(req: FastifyRequest, communityId: string): Promise<Community | null> {
    const claims = requireAuth(req);
    return withTransaction(contextFor(req), (tx) =>
      communitiesRepository.getById(tx, claims.sub, communityId),
    );
  },

  /** null = comunidad inexistente/fuera de alcance (la ruta responde 404). */
  async getBalance(
    req: FastifyRequest,
    communityId: string,
    toDate: string | null,
  ): Promise<number | null> {
    return withTransaction(contextFor(req), (tx) =>
      communitiesRepository.getBalance(tx, communityId, toDate),
    );
  },
};
