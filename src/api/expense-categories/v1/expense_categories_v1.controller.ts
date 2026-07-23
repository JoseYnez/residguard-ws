import type { FastifyRequest } from "fastify";
import { requireAuth } from "../../../core/auth/authenticate";
import { contextFor } from "../../../core/auth/community_access";
import { withTransaction } from "../../../core/db/with_transaction";
import { translatePgError, type MutationResult } from "../../../core/http/pg_errors";
import {
  expenseCategoriesRepository,
  type ExpenseCategory,
  type ListExpenseCategoriesInput,
} from "./expense_categories_v1.repository";

// Orquestación del recurso expense-categories. El acceso a la comunidad de la
// ruta ya lo garantizó requireCommunityAccess.

const PG_MESSAGES = {
  conflict: "Ya existe un rubro con ese nombre en la comunidad.",
  reference: "La comunidad no existe o está fuera de tu alcance.",
} as const;

export const expenseCategoriesController = {
  async list(
    req: FastifyRequest,
    input: ListExpenseCategoriesInput,
  ): Promise<{ items: ExpenseCategory[]; total: number }> {
    return withTransaction(contextFor(req), (tx) => expenseCategoriesRepository.list(tx, input));
  },

  async getById(
    req: FastifyRequest,
    communityId: string,
    id: string,
  ): Promise<ExpenseCategory | null> {
    return withTransaction(contextFor(req), (tx) =>
      expenseCategoriesRepository.getById(tx, communityId, id),
    );
  },

  async create(
    req: FastifyRequest,
    communityId: string,
    input: { name: string; description?: string | null },
  ): Promise<MutationResult<ExpenseCategory>> {
    const claims = requireAuth(req);
    try {
      const category = await withTransaction(contextFor(req), (tx) =>
        expenseCategoriesRepository.create(tx, claims.customerId, communityId, input),
      );
      return { ok: true, value: category };
    } catch (err) {
      return { ok: false, error: translatePgError(err, PG_MESSAGES) };
    }
  },

  async update(
    req: FastifyRequest,
    communityId: string,
    id: string,
    input: { name?: string; description?: string | null; status?: string },
  ): Promise<MutationResult<ExpenseCategory> | null> {
    try {
      const category = await withTransaction(contextFor(req), (tx) =>
        expenseCategoriesRepository.update(tx, communityId, id, input),
      );
      if (category === null) {
        return null;
      }
      return { ok: true, value: category };
    } catch (err) {
      return { ok: false, error: translatePgError(err, PG_MESSAGES) };
    }
  },

  async softDelete(req: FastifyRequest, communityId: string, id: string): Promise<boolean> {
    return withTransaction(contextFor(req), (tx) =>
      expenseCategoriesRepository.softDelete(tx, communityId, id),
    );
  },
};
