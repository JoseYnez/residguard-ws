import { Verifiers as V } from "structure-verifier";
import {
  errorResponseV1V,
  ISO_DATE_REGEX,
  MONEY_MAX,
  pageQueryFields,
  UUID_REGEX,
} from "../../common/common_v1.verifier";

// Contratos del recurso expenses (billing.expenses): gasto EJERCIDO por una
// comunidad (egreso). Registro simple, sin flujo de aprobación ni pagos
// parciales en esta versión.

// Espejo de `billing.payment_method`, el MISMO tipo que usan los pagos: un solo
// catálogo para las dos puntas de la caja. `deposit` es el depósito bancario en
// ventanilla/cajero (un gasto pagado depositando en la cuenta del proveedor).
export const PAYMENT_METHODS = ["cash", "transfer", "deposit", "card", "check", "other"] as const;

// --- Entrada: crear (POST /communities/:communityId/expenses) -----------------
export const createExpenseV1V = new V.ObjectNotNull(
  {
    expenseCategoryId: new V.StringNotNull({ regex: UUID_REGEX }),
    concept: new V.StringNotNull({ minLength: 1, maxLength: 500 }),
    amount: new V.NumberNotNull({ min: 0.01, max: MONEY_MAX, maxDecimalPlaces: 2 }),
    expenseDate: new V.StringNotNull({ regex: ISO_DATE_REGEX }),
    method: new V.StringNotNull({ in: [...PAYMENT_METHODS] }),
    vendorName: new V.String({ maxLength: 200 }),
    reference: new V.String({ maxLength: 200 }),
    authorizedBy: new V.String({ regex: UUID_REGEX }),
    // Caja de la que salió el dinero (billing.cash_accounts). OPCIONAL: el
    // histórico no la declara y una comunidad sin catálogo sigue capturando.
    cashAccountId: new V.String({ regex: UUID_REGEX }),
  },
  { strictMode: true },
);

// --- Entrada: actualizar (PATCH .../expenses/:id) ------------------------------
export const updateExpenseV1V = new V.ObjectNotNull(
  {
    expenseCategoryId: new V.String({ regex: UUID_REGEX }),
    concept: new V.String({ minLength: 1, maxLength: 500 }),
    amount: new V.Number({ min: 0.01, max: MONEY_MAX, maxDecimalPlaces: 2 }),
    expenseDate: new V.String({ regex: ISO_DATE_REGEX }),
    method: new V.String({ in: [...PAYMENT_METHODS] }),
    vendorName: new V.String({ maxLength: 200 }),
    reference: new V.String({ maxLength: 200 }),
    authorizedBy: new V.String({ regex: UUID_REGEX }),
    // Anulable: null explícito la limpia (gasto sin caja declarada).
    cashAccountId: new V.String({ regex: UUID_REGEX }),
  },
  { strictMode: true },
);

// --- Entrada: listar (GET .../expenses) ------------------------------------------
export const listExpensesQueryV1V = new V.ObjectNotNull(
  {
    ...pageQueryFields(),
    expenseCategoryId: new V.String({ regex: UUID_REGEX }),
    method: new V.String({ in: [...PAYMENT_METHODS] }),
    // Filtra por la caja de la que salió el gasto (opcional).
    cashAccountId: new V.String({ regex: UUID_REGEX }),
    from: new V.String({ regex: ISO_DATE_REGEX }),
    to: new V.String({ regex: ISO_DATE_REGEX }),
    search: new V.String({ maxLength: 200 }),
  },
  { strictMode: true },
);

// --- Salida: la caja del gasto (null = gasto sin caja declarada) ---------------------
const expenseCashAccountV1V = new V.Object({
  id: new V.StringNotNull(),
  name: new V.StringNotNull(),
});

// --- Salida: un gasto ----------------------------------------------------------------
export const expenseV1V = new V.ObjectNotNull({
  id: new V.StringNotNull(),
  communityId: new V.StringNotNull(),
  expenseCategoryId: new V.StringNotNull(),
  categoryName: new V.StringNotNull(),
  concept: new V.StringNotNull(),
  amount: new V.NumberNotNull(),
  expenseDate: new V.StringNotNull(),
  method: new V.StringNotNull(),
  vendorName: new V.String(),
  reference: new V.String(),
  authorizedBy: new V.String(),
  cashAccount: expenseCashAccountV1V,
  status: new V.StringNotNull(),
  createdAt: new V.StringNotNull(),
  updatedAt: new V.StringNotNull(),
});

// --- Salida: listado paginado -----------------------------------------------------------
export const expenseListV1V = new V.ObjectNotNull({
  items: new V.ArrayNotNull(expenseV1V),
  total: new V.NumberNotNull(),
  page: new V.NumberNotNull(),
  pageSize: new V.NumberNotNull(),
});

export { errorResponseV1V };
