import { Verifiers as V } from "structure-verifier";
import { errorResponseV1V, pageQueryFields } from "../../common/common_v1.verifier";

// Contratos del recurso cash-accounts (billing.cash_accounts): catálogo de
// cajas de cada comunidad — los lugares donde vive su dinero ("Caja chica",
// "Cuenta BBVA"). NO es payment_method: el método dice CÓMO se movió el
// dinero; la caja, A DÓNDE llegó (o de dónde salió).

// --- Entrada: crear (POST /communities/:communityId/cash-accounts) -----------
export const createCashAccountV1V = new V.ObjectNotNull(
  {
    name: new V.StringNotNull({ minLength: 1, maxLength: 100 }),
    description: new V.String({ maxLength: 500 }),
  },
  { strictMode: true },
);

// --- Entrada: actualizar (PATCH .../cash-accounts/:id) -----------------------
export const updateCashAccountV1V = new V.ObjectNotNull(
  {
    name: new V.String({ minLength: 1, maxLength: 100 }),
    description: new V.String({ maxLength: 500 }),
    status: new V.String({ in: ["active", "inactive"] }),
  },
  { strictMode: true },
);

// --- Entrada: listar (GET .../cash-accounts) ---------------------------------
export const listCashAccountsQueryV1V = new V.ObjectNotNull(
  {
    ...pageQueryFields(),
    search: new V.String({ maxLength: 100 }),
    status: new V.String({ in: ["active", "inactive"] }),
  },
  { strictMode: true },
);

// --- Salida: una caja --------------------------------------------------------
export const cashAccountV1V = new V.ObjectNotNull({
  id: new V.StringNotNull(),
  communityId: new V.StringNotNull(),
  name: new V.StringNotNull(),
  description: new V.String(),
  /** Saldo actual DERIVADO (fn_get_cash_account_balance); nunca se almacena. */
  balance: new V.NumberNotNull(),
  status: new V.StringNotNull(),
  createdAt: new V.StringNotNull(),
  updatedAt: new V.StringNotNull(),
});

// --- Salida: listado paginado ------------------------------------------------
export const cashAccountListV1V = new V.ObjectNotNull({
  items: new V.ArrayNotNull(cashAccountV1V),
  total: new V.NumberNotNull(),
  page: new V.NumberNotNull(),
  pageSize: new V.NumberNotNull(),
});

export { errorResponseV1V };
