import { Verifiers as V } from "structure-verifier";
import {
  errorResponseV1V,
  ISO_DATE_REGEX,
  MONEY_MAX,
  pageQueryFields,
  UUID_REGEX,
} from "../../common/common_v1.verifier";

// Contratos del recurso fund-adjustments (billing.fund_adjustments):
// movimientos MANUALES de la caja de una comunidad — saldo inicial de
// migración, conciliaciones, ingresos/salidas no ligados a cuotas. El monto
// va CON SIGNO (+ entra dinero, − sale) y nunca es cero.

// Espejo de `billing.payment_method`, el MISMO catálogo que usan pagos y
// gastos: las tres puntas de la caja se concilian con el mismo vocabulario.
// `other` es el movimiento que no pasó por ningún instrumento (el saldo inicial
// de una migración, un ajuste contable).
export const PAYMENT_METHODS = ["cash", "transfer", "deposit", "card", "check", "other"] as const;

// --- Entrada: crear (POST /communities/:communityId/fund-adjustments) ---------
export const createFundAdjustmentV1V = new V.ObjectNotNull(
  {
    /** CON SIGNO: positivo entra, negativo sale. Nunca cero. */
    amount: new V.NumberNotNull({ min: -MONEY_MAX, max: MONEY_MAX, maxDecimalPlaces: 2 }),
    reason: new V.StringNotNull({ minLength: 1, maxLength: 500 }),
    adjustedAt: new V.String({ regex: ISO_DATE_REGEX }),
    method: new V.StringNotNull({ in: [...PAYMENT_METHODS] }),
    authorizedBy: new V.String({ regex: UUID_REGEX }),
  },
  { strictMode: true },
);

// --- Entrada: actualizar (PATCH .../fund-adjustments/:id) ----------------------
export const updateFundAdjustmentV1V = new V.ObjectNotNull(
  {
    amount: new V.Number({ min: -MONEY_MAX, max: MONEY_MAX, maxDecimalPlaces: 2 }),
    reason: new V.String({ minLength: 1, maxLength: 500 }),
    adjustedAt: new V.String({ regex: ISO_DATE_REGEX }),
    method: new V.String({ in: [...PAYMENT_METHODS] }),
    authorizedBy: new V.String({ regex: UUID_REGEX }),
  },
  { strictMode: true },
);

// --- Entrada: listar (GET .../fund-adjustments) ----------------------------------
export const listFundAdjustmentsQueryV1V = new V.ObjectNotNull(
  {
    ...pageQueryFields(),
    from: new V.String({ regex: ISO_DATE_REGEX }),
    to: new V.String({ regex: ISO_DATE_REGEX }),
    method: new V.String({ in: [...PAYMENT_METHODS] }),
    search: new V.String({ maxLength: 200 }),
  },
  { strictMode: true },
);

// --- Salida: un movimiento --------------------------------------------------------------
export const fundAdjustmentV1V = new V.ObjectNotNull({
  id: new V.StringNotNull(),
  communityId: new V.StringNotNull(),
  amount: new V.NumberNotNull(),
  reason: new V.StringNotNull(),
  adjustedAt: new V.StringNotNull(),
  method: new V.StringNotNull(),
  authorizedBy: new V.String(),
  status: new V.StringNotNull(),
  createdAt: new V.StringNotNull(),
  updatedAt: new V.StringNotNull(),
});

// --- Salida: listado paginado ---------------------------------------------------------------
export const fundAdjustmentListV1V = new V.ObjectNotNull({
  items: new V.ArrayNotNull(fundAdjustmentV1V),
  total: new V.NumberNotNull(),
  page: new V.NumberNotNull(),
  pageSize: new V.NumberNotNull(),
});

export { errorResponseV1V };
