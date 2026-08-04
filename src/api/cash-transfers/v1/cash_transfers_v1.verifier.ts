import { Verifiers as V } from "structure-verifier";
import {
  errorResponseV1V,
  ISO_DATE_REGEX,
  MONEY_MAX,
  pageQueryFields,
  UUID_REGEX,
} from "../../common/common_v1.verifier";

// Contratos del recurso cash-transfers (billing.cash_account_transfers):
// traspaso de dinero entre dos cajas de la MISMA comunidad ("corte de caja
// chica" → banco). Suma cero para la comunidad: nunca toca el saldo
// comunitario, solo mueve saldo entre cajas. El monto es SIEMPRE positivo:
// la dirección la dan las cajas (origen → destino), no el signo.

// --- Entrada: crear (POST /communities/:communityId/cash-transfers) ----------
export const createCashTransferV1V = new V.ObjectNotNull(
  {
    fromCashAccountId: new V.StringNotNull({ regex: UUID_REGEX }),
    toCashAccountId: new V.StringNotNull({ regex: UUID_REGEX }),
    /** Estrictamente positivo (la BD lo respalda con CHECK amount > 0). */
    amount: new V.NumberNotNull({ min: 0.01, max: MONEY_MAX, maxDecimalPlaces: 2 }),
    transferredAt: new V.String({ regex: ISO_DATE_REGEX }),
    reason: new V.StringNotNull({ minLength: 1, maxLength: 500 }),
    authorizedBy: new V.String({ regex: UUID_REGEX }),
  },
  { strictMode: true },
);

// --- Entrada: actualizar (PATCH .../cash-transfers/:id) ----------------------
export const updateCashTransferV1V = new V.ObjectNotNull(
  {
    fromCashAccountId: new V.String({ regex: UUID_REGEX }),
    toCashAccountId: new V.String({ regex: UUID_REGEX }),
    amount: new V.Number({ min: 0.01, max: MONEY_MAX, maxDecimalPlaces: 2 }),
    transferredAt: new V.String({ regex: ISO_DATE_REGEX }),
    reason: new V.String({ minLength: 1, maxLength: 500 }),
    authorizedBy: new V.String({ regex: UUID_REGEX }),
  },
  { strictMode: true },
);

// --- Entrada: listar (GET .../cash-transfers) --------------------------------
export const listCashTransfersQueryV1V = new V.ObjectNotNull(
  {
    ...pageQueryFields(),
    from: new V.String({ regex: ISO_DATE_REGEX }),
    to: new V.String({ regex: ISO_DATE_REGEX }),
    /** Traspasos donde esa caja sea origen O destino. */
    cashAccountId: new V.String({ regex: UUID_REGEX }),
  },
  { strictMode: true },
);

// --- Salida: referencia a una caja (para pintar nombres sin otra petición) ---
const cashAccountRefV1V = new V.ObjectNotNull({
  id: new V.StringNotNull(),
  name: new V.StringNotNull(),
});

// --- Salida: un traspaso -----------------------------------------------------
export const cashTransferV1V = new V.ObjectNotNull({
  id: new V.StringNotNull(),
  communityId: new V.StringNotNull(),
  fromCashAccountId: new V.StringNotNull(),
  toCashAccountId: new V.StringNotNull(),
  fromCashAccount: cashAccountRefV1V,
  toCashAccount: cashAccountRefV1V,
  amount: new V.NumberNotNull(),
  transferredAt: new V.StringNotNull(),
  reason: new V.StringNotNull(),
  authorizedBy: new V.String(),
  status: new V.StringNotNull(),
  createdAt: new V.StringNotNull(),
  updatedAt: new V.StringNotNull(),
});

// --- Salida: listado paginado ------------------------------------------------
export const cashTransferListV1V = new V.ObjectNotNull({
  items: new V.ArrayNotNull(cashTransferV1V),
  total: new V.NumberNotNull(),
  page: new V.NumberNotNull(),
  pageSize: new V.NumberNotNull(),
});

export { errorResponseV1V };
