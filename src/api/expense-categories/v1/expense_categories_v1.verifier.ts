import { Verifiers as V } from "structure-verifier";
import { errorResponseV1V, pageQueryFields } from "../../common/common_v1.verifier";

// Contratos del recurso expense-categories (billing.expense_categories):
// catálogo de rubros de gasto que cada comunidad define para clasificar sus
// egresos ("Jardinería", "Vigilancia", ...).

// --- Entrada: crear (POST /communities/:communityId/expense-categories) ------
export const createExpenseCategoryV1V = new V.ObjectNotNull(
  {
    name: new V.StringNotNull({ minLength: 1, maxLength: 100 }),
    description: new V.String({ maxLength: 500 }),
  },
  { strictMode: true },
);

// --- Entrada: actualizar (PATCH .../expense-categories/:id) ------------------
export const updateExpenseCategoryV1V = new V.ObjectNotNull(
  {
    name: new V.String({ minLength: 1, maxLength: 100 }),
    description: new V.String({ maxLength: 500 }),
    status: new V.String({ in: ["active", "inactive"] }),
  },
  { strictMode: true },
);

// --- Entrada: listar (GET .../expense-categories) -----------------------------
export const listExpenseCategoriesQueryV1V = new V.ObjectNotNull(
  {
    ...pageQueryFields(),
    search: new V.String({ maxLength: 100 }),
    status: new V.String({ in: ["active", "inactive"] }),
  },
  { strictMode: true },
);

// --- Salida: un rubro --------------------------------------------------------------
export const expenseCategoryV1V = new V.ObjectNotNull({
  id: new V.StringNotNull(),
  communityId: new V.StringNotNull(),
  name: new V.StringNotNull(),
  description: new V.String(),
  status: new V.StringNotNull(),
  createdAt: new V.StringNotNull(),
  updatedAt: new V.StringNotNull(),
});

// --- Salida: listado paginado ---------------------------------------------------------
export const expenseCategoryListV1V = new V.ObjectNotNull({
  items: new V.ArrayNotNull(expenseCategoryV1V),
  total: new V.NumberNotNull(),
  page: new V.NumberNotNull(),
  pageSize: new V.NumberNotNull(),
});

export { errorResponseV1V };
