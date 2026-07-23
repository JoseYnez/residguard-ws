import type { FastifyRequest } from "fastify";
import { requireAuth } from "../../../core/auth/authenticate";
import { contextFor } from "../../../core/auth/community_access";
import { withTransaction } from "../../../core/db/with_transaction";
import { translatePgError, type MutationResult } from "../../../core/http/pg_errors";
import {
  expensesRepository,
  type CreateExpenseInput,
  type Expense,
  type ListExpensesInput,
  type UpdateExpenseInput,
} from "./expenses_v1.repository";

// Orquestación del recurso expenses. El acceso a la comunidad de la ruta ya
// lo garantizó requireCommunityAccess; la FK compuesta de BD valida que el
// rubro pertenezca a esa misma comunidad.

const PG_MESSAGES = {
  reference: "El rubro de gasto no existe o no pertenece a esta comunidad.",
  check: "El monto del gasto debe ser mayor a cero.",
} as const;

export const expensesController = {
  async list(
    req: FastifyRequest,
    input: ListExpensesInput,
  ): Promise<{ items: Expense[]; total: number }> {
    return withTransaction(contextFor(req), (tx) => expensesRepository.list(tx, input));
  },

  async getById(req: FastifyRequest, communityId: string, id: string): Promise<Expense | null> {
    return withTransaction(contextFor(req), (tx) =>
      expensesRepository.getById(tx, communityId, id),
    );
  },

  async create(
    req: FastifyRequest,
    communityId: string,
    input: CreateExpenseInput,
  ): Promise<MutationResult<Expense>> {
    const claims = requireAuth(req);
    try {
      const expense = await withTransaction(contextFor(req), (tx) =>
        expensesRepository.create(tx, claims.customerId, communityId, input),
      );
      return { ok: true, value: expense };
    } catch (err) {
      return { ok: false, error: translatePgError(err, PG_MESSAGES) };
    }
  },

  /** `null` (fuera de ok/error) cuando el gasto no existe → 404 en la route. */
  async update(
    req: FastifyRequest,
    communityId: string,
    id: string,
    input: UpdateExpenseInput,
  ): Promise<MutationResult<Expense> | null> {
    try {
      const expense = await withTransaction(contextFor(req), (tx) =>
        expensesRepository.update(tx, communityId, id, input),
      );
      if (expense === null) {
        return null;
      }
      return { ok: true, value: expense };
    } catch (err) {
      return { ok: false, error: translatePgError(err, PG_MESSAGES) };
    }
  },

  async softDelete(req: FastifyRequest, communityId: string, id: string): Promise<boolean> {
    return withTransaction(contextFor(req), (tx) =>
      expensesRepository.softDelete(tx, communityId, id),
    );
  },
};
