import type { FastifyRequest } from "fastify";
import { requireAuth } from "../../../core/auth/authenticate";
import { contextFor } from "../../../core/auth/community_access";
import { withTransaction } from "../../../core/db/with_transaction";
import { translatePgError, type MutationResult } from "../../../core/http/pg_errors";
import {
  cashAccountsRepository,
  type CashAccount,
  type ListCashAccountsInput,
} from "./cash_accounts_v1.repository";

// Orquestación del recurso cash-accounts. El acceso a la comunidad de la
// ruta ya lo garantizó requireCommunityAccess.

const PG_MESSAGES = {
  conflict: "Ya existe una caja con ese nombre en la comunidad.",
  reference: "La comunidad no existe o está fuera de tu alcance.",
} as const;

export const cashAccountsController = {
  async list(
    req: FastifyRequest,
    input: ListCashAccountsInput,
  ): Promise<{ items: CashAccount[]; total: number }> {
    return withTransaction(contextFor(req), (tx) => cashAccountsRepository.list(tx, input));
  },

  async getById(
    req: FastifyRequest,
    communityId: string,
    id: string,
  ): Promise<CashAccount | null> {
    return withTransaction(contextFor(req), (tx) =>
      cashAccountsRepository.getById(tx, communityId, id),
    );
  },

  async create(
    req: FastifyRequest,
    communityId: string,
    input: { name: string; description?: string | null },
  ): Promise<MutationResult<CashAccount>> {
    const claims = requireAuth(req);
    try {
      const account = await withTransaction(contextFor(req), (tx) =>
        cashAccountsRepository.create(tx, claims.customerId, communityId, input),
      );
      return { ok: true, value: account };
    } catch (err) {
      return { ok: false, error: translatePgError(err, PG_MESSAGES) };
    }
  },

  async update(
    req: FastifyRequest,
    communityId: string,
    id: string,
    input: { name?: string; description?: string | null; status?: string },
  ): Promise<MutationResult<CashAccount> | null> {
    try {
      const account = await withTransaction(contextFor(req), (tx) =>
        cashAccountsRepository.update(tx, communityId, id, input),
      );
      if (account === null) {
        return null;
      }
      return { ok: true, value: account };
    } catch (err) {
      return { ok: false, error: translatePgError(err, PG_MESSAGES) };
    }
  },

  async softDelete(req: FastifyRequest, communityId: string, id: string): Promise<boolean> {
    return withTransaction(contextFor(req), (tx) =>
      cashAccountsRepository.softDelete(tx, communityId, id),
    );
  },
};
