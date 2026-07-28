import type { FastifyRequest } from "fastify";
import { requireAuth } from "../../../core/auth/authenticate";
import { contextFor } from "../../../core/auth/community_access";
import { withTransaction } from "../../../core/db/with_transaction";
import { translatePgError, type MutationResult } from "../../../core/http/pg_errors";
import {
  communitiesRepository,
  type Community,
  type CreateCommunityInput,
  type UpdateCommunityInput,
} from "./communities_v1.repository";

// Orquestación del recurso communities: contexto de auditoría desde el token
// y UNA transacción de negocio por endpoint. El alcance por membresía lo
// aplica el repository (JOIN con community_members).

const PG_MESSAGES = {
  conflict: "Ya existe una comunidad con ese código en la cuenta.",
  // 23503 al insertar la membresía del creador: el usuario del token no está
  // en el espejo core.users (cuenta sin sincronizar). La comunidad NO se crea:
  // el fallo tira la transacción entera, que es lo correcto — una comunidad
  // sin su primer miembro sería invisible para todo el mundo.
  reference: "Tu usuario aún no está sincronizado en esta cuenta.",
} as const;

export const communitiesController = {
  async list(
    req: FastifyRequest,
    input: { page: number; pageSize: number; search?: string | null; status?: string | null },
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

  async create(
    req: FastifyRequest,
    input: CreateCommunityInput,
  ): Promise<MutationResult<Community>> {
    const claims = requireAuth(req);
    try {
      const community = await withTransaction(contextFor(req), (tx) =>
        communitiesRepository.create(tx, claims.customerId, claims.sub, input),
      );
      return { ok: true, value: community };
    } catch (err) {
      return { ok: false, error: translatePgError(err, PG_MESSAGES) };
    }
  },

  /** `null` (fuera de ok/error) cuando no existe/está fuera → 404 en la route. */
  async update(
    req: FastifyRequest,
    communityId: string,
    input: UpdateCommunityInput,
  ): Promise<MutationResult<Community> | null> {
    const claims = requireAuth(req);
    try {
      const community = await withTransaction(contextFor(req), (tx) =>
        communitiesRepository.update(tx, claims.sub, communityId, input),
      );
      if (community === null) {
        return null;
      }
      return { ok: true, value: community };
    } catch (err) {
      return { ok: false, error: translatePgError(err, PG_MESSAGES) };
    }
  },

  async softDelete(req: FastifyRequest, communityId: string): Promise<boolean> {
    const claims = requireAuth(req);
    return withTransaction(contextFor(req), (tx) =>
      communitiesRepository.softDelete(tx, claims.sub, communityId),
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
