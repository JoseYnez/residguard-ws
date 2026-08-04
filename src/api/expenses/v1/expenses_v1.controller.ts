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
// lo garantizó requireCommunityAccess; las FKs compuestas de BD validan que el
// rubro y la caja pertenezcan a esa misma comunidad. Lo que las FKs NO validan
// es el `status` de rubro y caja, así que eso se comprueba aquí antes de
// escribir.

const PG_MESSAGES = {
  reference: "El rubro de gasto o la caja no existen o no pertenecen a esta comunidad.",
  check: "El monto del gasto debe ser mayor a cero.",
} as const;

const INACTIVE_CATEGORY = "El rubro de gasto no existe o no pertenece a esta comunidad.";

const INVALID_CASH_ACCOUNT =
  "La caja no existe, no está activa o no pertenece a esta comunidad.";

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
      const outcome = await withTransaction(contextFor(req), async (tx) => {
        const usable = await expensesRepository.activeCategoryExists(
          tx,
          communityId,
          input.expenseCategoryId,
        );
        if (!usable) {
          return "bad_category" as const;
        }
        // Con caja declarada: existir, estar activa y ser de la comunidad de
        // la ruta (la FK compuesta de BD no mira el `status`).
        if (input.cashAccountId !== undefined && input.cashAccountId !== null) {
          const cashOk = await expensesRepository.activeCashAccountExists(
            tx,
            communityId,
            input.cashAccountId,
          );
          if (!cashOk) {
            return "bad_cash_account" as const;
          }
        }
        return expensesRepository.create(tx, claims.customerId, communityId, input);
      });
      if (outcome === "bad_category") {
        return { ok: false, error: { kind: "invalid", message: INACTIVE_CATEGORY } };
      }
      if (outcome === "bad_cash_account") {
        return { ok: false, error: { kind: "invalid", message: INVALID_CASH_ACCOUNT } };
      }
      return { ok: true, value: outcome };
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
      const outcome = await withTransaction(contextFor(req), async (tx) => {
        // Solo se valida si el PATCH cambia el rubro: editar otros campos de un
        // gasto viejo cuyo rubro se retiró después sigue siendo legítimo.
        if (input.expenseCategoryId !== undefined) {
          const usable = await expensesRepository.activeCategoryExists(
            tx,
            communityId,
            input.expenseCategoryId,
          );
          if (!usable) {
            return "bad_category" as const;
          }
        }
        // Igual con la caja: solo si el PATCH la cambia (null = limpiar, no
        // se valida nada).
        if (input.cashAccountId !== undefined && input.cashAccountId !== null) {
          const cashOk = await expensesRepository.activeCashAccountExists(
            tx,
            communityId,
            input.cashAccountId,
          );
          if (!cashOk) {
            return "bad_cash_account" as const;
          }
        }
        return expensesRepository.update(tx, communityId, id, input);
      });
      if (outcome === "bad_category") {
        return { ok: false, error: { kind: "invalid", message: INACTIVE_CATEGORY } };
      }
      if (outcome === "bad_cash_account") {
        return { ok: false, error: { kind: "invalid", message: INVALID_CASH_ACCOUNT } };
      }
      if (outcome === null) {
        return null;
      }
      return { ok: true, value: outcome };
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
