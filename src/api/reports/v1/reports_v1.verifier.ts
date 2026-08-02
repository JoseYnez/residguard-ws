import { Verifiers as V } from "structure-verifier";
import {
  errorResponseV1V,
  ISO_DATE_REGEX,
  pageQueryFields,
} from "../../common/common_v1.verifier";

// Contratos del recurso reports: agregados DERIVADOS de billing (cargos, pagos,
// condonaciones, gastos y movimientos de caja) para una comunidad. Solo lectura;
// no hay tabla `reports` ni nada que escribir.
//
// DOS TOTALES DISTINTOS, y el contrato los separa a propósito:
//   * `cash`        — CAJA: dinero que entró, salió y quedó, en el rango.
//   * `collections` — DEVENGADO: lo que se debió cobrar del periodo y cuánto se
//                     cobró de ello.
// No cuadran entre sí: un pago de julio sobre la cuota de mayo entra a la caja
// de julio y a la cobranza de mayo. Cualquier consumidor que los sume está
// contando dos veces.

// --- Entrada: resumen (GET .../reports/summary) --------------------------------
// `from`/`to` son fechas de NEGOCIO (`YYYY-MM-DD`), no instantes: el recorte a
// día lo hace PostgreSQL en la zona de operación (DB_TIMEZONE), que es la que el
// propio payload devuelve en `range.timezone`. Enviar un ISO con offset aquí
// sería pedirle a la SPA que decidiera la zona del reporte, y la zona del
// reporte es la de la comunidad, no la del dispositivo que lo abre.
export const reportSummaryQueryV1V = new V.ObjectNotNull(
  {
    from: new V.StringNotNull({ regex: ISO_DATE_REGEX }),
    to: new V.StringNotNull({ regex: ISO_DATE_REGEX }),
  },
  { strictMode: true },
);

// --- Entrada: adeudo por unidad (GET .../reports/units) ------------------------
export const reportUnitsQueryV1V = new V.ObjectNotNull(
  {
    ...pageQueryFields(),
    /** Solo unidades con saldo pendiente (> 0). Omitido = todas. */
    onlyDebtors: new V.Boolean(),
  },
  { strictMode: true },
);

// --- Salida: piezas del resumen ------------------------------------------------

const rangeV1V = new V.ObjectNotNull({
  from: new V.StringNotNull(),
  to: new V.StringNotNull(),
  /** Zona en la que se recortaron los días (DB_TIMEZONE del servicio). */
  timezone: new V.StringNotNull(),
});

const cashFlowSideV1V = new V.ObjectNotNull({
  /** Aplicaciones de pago hacia cargos de la comunidad (lado ingreso) o gastos
   *  ejercidos (lado egreso). */
  operations: new V.NumberNotNull(),
  /** Movimientos manuales de caja del signo correspondiente, en positivo. */
  adjustments: new V.NumberNotNull(),
  total: new V.NumberNotNull(),
});

const cashV1V = new V.ObjectNotNull({
  /** Saldo al día ANTERIOR a `from` — el punto de partida del rango. */
  openingBalance: new V.NumberNotNull(),
  income: cashFlowSideV1V,
  outflow: cashFlowSideV1V,
  /** Saldo al cierre de `to`. Invariante: opening + income − outflow = closing. */
  closingBalance: new V.NumberNotNull(),
});

const collectionsV1V = new V.ObjectNotNull({
  /** Devengado del rango: cargos cuyo periodo cae dentro (los sueltos, por su
   *  vencimiento — no tienen periodo). */
  charged: new V.NumberNotNull(),
  /** Cubierto con dinero, sin importar CUÁNDO se pagó. */
  collected: new V.NumberNotNull(),
  /** Cubierto con condonaciones. NO es dinero: nunca entra a `cash`. */
  waived: new V.NumberNotNull(),
  /** charged − collected − waived. */
  outstanding: new V.NumberNotNull(),
  /** collected / charged ∈ [0,1]; 0 cuando no se devengó nada. */
  collectionRate: new V.NumberNotNull(),
});

const agingBucketV1V = new V.ObjectNotNull({
  /** '1-30' | '31-60' | '61-90' | '90+' (días de atraso). */
  label: new V.StringNotNull(),
  amount: new V.NumberNotNull(),
});

const overdueV1V = new V.ObjectNotNull({
  /** Fecha de corte del vencido: HOY en la zona de operación. La cartera se
   *  reporta en su estado ACTUAL, no reconstruida a una fecha pasada. */
  asOf: new V.StringNotNull(),
  total: new V.NumberNotNull(),
  buckets: new V.ArrayNotNull(agingBucketV1V),
});

const expenseCategoryShareV1V = new V.ObjectNotNull({
  categoryId: new V.StringNotNull(),
  name: new V.StringNotNull(),
  amount: new V.NumberNotNull(),
  /** Proporción sobre el total del desglose ∈ [0,1]. */
  share: new V.NumberNotNull(),
});

const feeShareV1V = new V.ObjectNotNull({
  feeId: new V.StringNotNull(),
  concept: new V.StringNotNull(),
  amount: new V.NumberNotNull(),
  share: new V.NumberNotNull(),
});

const methodShareV1V = new V.ObjectNotNull({
  /** billing.payment_method: cash | transfer | card | check | other. */
  method: new V.StringNotNull(),
  amount: new V.NumberNotNull(),
  share: new V.NumberNotNull(),
});

// --- Salida: resumen -----------------------------------------------------------
export const reportSummaryV1V = new V.ObjectNotNull({
  range: rangeV1V,
  cash: cashV1V,
  collections: collectionsV1V,
  overdue: overdueV1V,
  expensesByCategory: new V.ArrayNotNull(expenseCategoryShareV1V),
  incomeByFee: new V.ArrayNotNull(feeShareV1V),
  incomeByMethod: new V.ArrayNotNull(methodShareV1V),
});

// --- Salida: adeudo por unidad -------------------------------------------------
export const unitDebtV1V = new V.ObjectNotNull({
  unitId: new V.StringNotNull(),
  unitCode: new V.StringNotNull(),
  /** Total devengado a la unidad (cargos activos, todo su historial). */
  charged: new V.NumberNotNull(),
  paid: new V.NumberNotNull(),
  waived: new V.NumberNotNull(),
  /** charged − paid − waived: lo que la unidad debe HOY. */
  balance: new V.NumberNotNull(),
  /** Parte del saldo cuyos cargos ya vencieron. */
  overdue: new V.NumberNotNull(),
  /** Vencimiento del cargo impago más antiguo; null si no debe nada vencido. */
  oldestDueDate: new V.String(),
});

export const unitDebtListV1V = new V.ObjectNotNull({
  items: new V.ArrayNotNull(unitDebtV1V),
  total: new V.NumberNotNull(),
  page: new V.NumberNotNull(),
  pageSize: new V.NumberNotNull(),
  /** Totales de TODAS las unidades del filtro, no solo de la página. */
  totals: new V.ObjectNotNull({
    charged: new V.NumberNotNull(),
    paid: new V.NumberNotNull(),
    waived: new V.NumberNotNull(),
    balance: new V.NumberNotNull(),
    overdue: new V.NumberNotNull(),
  }),
});

export { errorResponseV1V };
