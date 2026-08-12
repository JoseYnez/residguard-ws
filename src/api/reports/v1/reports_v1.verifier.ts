import { Verifiers as V } from "structure-verifier";
import {
  errorResponseV1V,
  ISO_DATE_REGEX,
  pageQueryFields,
  UUID_REGEX,
} from "../../common/common_v1.verifier";

/** Filtro de caja del resumen: un UUID de caja, o el centinela `none` para
 *  acotar a los movimientos SIN caja declarada (el bucket que sirve para
 *  auditar qué quedó sin asignar). Ausente = toda la comunidad. */
const CASH_ACCOUNT_FILTER_REGEX = new RegExp(
  `^(none|${UUID_REGEX.source.slice(1, -1)})$`,
);

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
    /** Acota el lado CAJA (cash + desgloses de gasto/ingreso) a una caja, o a
     *  los movimientos sin caja (`none`). El lado DEVENGADO (collections,
     *  overdue) NO se filtra: la deuda no "pertenece" a una caja. */
    cashAccountId: new V.String({ regex: CASH_ACCOUNT_FILTER_REGEX }),
  },
  { strictMode: true },
);

// --- Entrada: resultado del periodo (GET .../reports/period-result) ------------
// Mismo rango de negocio que el resumen y SIN filtro de caja: este reporte es
// siempre la comunidad entera. Acotarlo a una caja convertiría "cuánto entró"
// en "cuánto entró ahí", que es otra pregunta — y la responde el resumen.
export const reportPeriodResultQueryV1V = new V.ObjectNotNull(
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

// --- Entrada: estado de cuenta por unidad (GET .../reports/units/:unitId/statement)
// Los dos ids viajan en la ruta: la comunidad es el alcance (requireCommunityAccess)
// y la unidad, el sujeto del estado de cuenta. No hay verifier común para esta
// pareja — el recurso units usa /units/:unitId sin comunidad — así que se
// declara aquí.
export const communityUnitParamV1V = new V.ObjectNotNull(
  {
    communityId: new V.StringNotNull({ regex: UUID_REGEX }),
    unitId: new V.StringNotNull({ regex: UUID_REGEX }),
  },
  { strictMode: true },
);

// Mismo rango de negocio que el resumen y los movimientos: días `YYYY-MM-DD`
// recortados en la zona de operación. El saldo anterior se corta al día
// ANTERIOR a `from`, igual que el saldo inicial de caja.
export const unitStatementQueryV1V = new V.ObjectNotNull(
  {
    ...pageQueryFields(),
    from: new V.StringNotNull({ regex: ISO_DATE_REGEX }),
    to: new V.StringNotNull({ regex: ISO_DATE_REGEX }),
  },
  { strictMode: true },
);

// --- Entrada: movimientos (GET .../reports/movements) --------------------------
// Mismo rango de negocio y mismo filtro de caja que el resumen: es el DETALLE
// de sus cifras de caja, así que cualquier divergencia en los parámetros sería
// una divergencia en los números.
export const reportMovementsQueryV1V = new V.ObjectNotNull(
  {
    ...pageQueryFields(),
    from: new V.StringNotNull({ regex: ISO_DATE_REGEX }),
    to: new V.StringNotNull({ regex: ISO_DATE_REGEX }),
    /** Acota a una caja, o a lo que no declaró ninguna (`none`). Los traspasos
     *  entre cajas SOLO aparecen con una caja concreta seleccionada. */
    cashAccountId: new V.String({ regex: CASH_ACCOUNT_FILTER_REGEX }),
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
  /** Traspasos entre cajas del rango. Solo significan algo con el filtro de
   *  caja activo (entra/sale de ESA caja); a nivel comunidad son suma cero y
   *  viajan en 0 — NUNCA se suman a income/outflow. */
  transfersIn: new V.NumberNotNull(),
  transfersOut: new V.NumberNotNull(),
  /** Saldo al cierre de `to`. Invariante: opening + income − outflow
   *  + transfersIn − transfersOut = closing. */
  closingBalance: new V.NumberNotNull(),
});

// Una fila del desglose por caja. La fila con `cashAccountId` null es el
// bucket "sin caja": pagos/gastos/ajustes que no declararon caja (todo el
// histórico previo a la funcionalidad). La suma de filas = totales de la
// comunidad (los traspasos se cancelan entre filas).
const cashAccountBreakdownV1V = new V.ObjectNotNull({
  /** null = movimientos sin caja declarada. */
  cashAccountId: new V.String(),
  /** null solo en la fila "sin caja". */
  name: new V.String(),
  openingBalance: new V.NumberNotNull(),
  /** Pagos + ajustes positivos del rango que entraron a ESTA caja. */
  income: new V.NumberNotNull(),
  /** Gastos + ajustes negativos del rango que salieron de ESTA caja. */
  outflow: new V.NumberNotNull(),
  transfersIn: new V.NumberNotNull(),
  transfersOut: new V.NumberNotNull(),
  /** opening + income − outflow + transfersIn − transfersOut. */
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
  /** Desglose del lado caja por caja destino (+ la fila "sin caja"). SIEMPRE
   *  viaja completo, aunque el filtro `cashAccountId` esté activo: la tabla
   *  del desglose no cambia con el filtro, solo las tarjetas del resumen. */
  cashAccounts: new V.ArrayNotNull(cashAccountBreakdownV1V),
  expensesByCategory: new V.ArrayNotNull(expenseCategoryShareV1V),
  incomeByFee: new V.ArrayNotNull(feeShareV1V),
  incomeByMethod: new V.ArrayNotNull(methodShareV1V),
});

// --- Salida: resultado del periodo ---------------------------------------------

/**
 * Un renglón del desglose de ingresos del resultado: la cuota partida por el
 * PERIODO del cargo cobrado. Un depósito de julio que cubrió mayo, junio y
 * julio de Mantenimiento son tres renglones — por eso este desglose no cabía
 * en el resumen, donde el mismo dinero es una sola fila por cuota.
 *
 * Sin `share`: el consumidor reparte sobre el total de su lado (que incluye los
 * movimientos manuales de caja), no sobre el de operaciones.
 */
const feePeriodShareV1V = new V.ObjectNotNull({
  feeId: new V.StringNotNull(),
  concept: new V.StringNotNull(),
  /** null = cargo SUELTO (no devenga periodo). */
  periodId: new V.String(),
  /** Alias VIGENTE del periodo; null en un suelto o en un periodo sin alias
   *  propio — el nombre derivado del rango no se calcula, el renglón se queda
   *  con su concepto a secas. */
  periodLabel: new V.String(),
  amount: new V.NumberNotNull(),
});

const categoryAmountV1V = new V.ObjectNotNull({
  categoryId: new V.StringNotNull(),
  name: new V.StringNotNull(),
  amount: new V.NumberNotNull(),
});

/**
 * El periodo como estado de resultados: entró, salió, y los desgloses que lo
 * explican. Sin saldos, sin cobranza devengada y sin antigüedad a propósito —
 * eso responde "cuánto dinero hay" y lo publica `summary`.
 *
 * `income.total` y `outflow.total` son los mismos de `cash` en el resumen sin
 * filtro de caja: salen de las mismas consultas.
 */
export const reportPeriodResultV1V = new V.ObjectNotNull({
  range: rangeV1V,
  income: cashFlowSideV1V,
  outflow: cashFlowSideV1V,
  incomeByFeePeriod: new V.ArrayNotNull(feePeriodShareV1V),
  expensesByCategory: new V.ArrayNotNull(categoryAmountV1V),
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

// --- Salida: movimientos -------------------------------------------------------

const movementCashAccountV1V = new V.Object({
  id: new V.StringNotNull(),
  name: new V.StringNotNull(),
});

const movementV1V = new V.ObjectNotNull({
  /** Id del registro de origen. La identidad de la fila es (kind, id): un pago
   *  y un gasto no comparten espacio de ids, pero tampoco lo garantizan. */
  id: new V.StringNotNull(),
  /** payment | expense | adjustment | transfer. */
  kind: new V.StringNotNull(),
  /** Fecha de NEGOCIO (`YYYY-MM-DD`), recortada en la zona de operación. */
  movedOn: new V.StringNotNull(),
  concept: new V.StringNotNull(),
  /** Contexto del tipo: unidades, rubro y proveedor, cajas del traspaso. */
  detail: new V.String(),
  /** billing.payment_method; null en un traspaso. */
  method: new V.String(),
  reference: new V.String(),
  cashAccount: movementCashAccountV1V,
  /** SIGNADO: + entró, − salió. */
  amount: new V.NumberNotNull(),
  /** Saldo del alcance DESPUÉS de este movimiento. */
  balance: new V.NumberNotNull(),
});

// --- Salida: estado de cuenta por unidad ---------------------------------------

/**
 * UN movimiento del estado de cuenta. El importe viaja SIGNADO sobre la DEUDA
 * de la unidad: + la aumenta (cargo), − la baja (pago aplicado o condonación).
 * `balance` es el saldo deudor DESPUÉS del movimiento — saldo anterior más la
 * suma corrida — igual que el saldo acumulado de los movimientos de caja.
 */
const statementEntryV1V = new V.ObjectNotNull({
  /** Id del registro de origen (cargo, pago o condonación). La identidad de la
   *  fila es (kind, id), como en los movimientos. */
  id: new V.StringNotNull(),
  /** charge | payment | waiver. */
  kind: new V.StringNotNull(),
  /** Fecha de NEGOCIO: el devengo del cargo (periodo o vencimiento del suelto),
   *  el día del pago, el día de la condonación. */
  movedOn: new V.StringNotNull(),
  /** Qué fue: "Mantenimiento", "Tarjeta de acceso ×2", las cuotas cubiertas. */
  concept: new V.StringNotNull(),
  /** Contexto del tipo: el periodo del cargo ("Enero-2026"), la nota del
   *  suelto, el motivo de la condonación. null cuando no aporta ninguno. */
  detail: new V.String(),
  /** billing.payment_method; solo en pagos. */
  method: new V.String(),
  reference: new V.String(),
  /** SIGNADO: + cargo (sube la deuda), − abono (la baja). */
  amount: new V.NumberNotNull(),
  /** Saldo deudor de la unidad DESPUÉS de este movimiento. */
  balance: new V.NumberNotNull(),
});

export const unitStatementV1V = new V.ObjectNotNull({
  /** La unidad del estado de cuenta, resuelta por el servidor: el PDF no debe
   *  depender de la lista de unidades que el cliente tenga en memoria. */
  unit: new V.ObjectNotNull({
    id: new V.StringNotNull(),
    code: new V.StringNotNull(),
  }),
  items: new V.ArrayNotNull(statementEntryV1V),
  total: new V.NumberNotNull(),
  page: new V.NumberNotNull(),
  pageSize: new V.NumberNotNull(),
  /** Zona en la que se recortaron los días (DB_TIMEZONE), como los demás
   *  reportes: el PDF tiene que poder decir en qué días está expresado. */
  timezone: new V.StringNotNull(),
  /** Totales del rango COMPLETO, no de la página. Invariante:
   *  openingBalance + charged − paid − waived = closingBalance. */
  totals: new V.ObjectNotNull({
    /** Deuda de la unidad al día ANTERIOR a `from`. */
    openingBalance: new V.NumberNotNull(),
    charged: new V.NumberNotNull(),
    /** Cubierto con dinero dentro del rango (por fecha de pago). */
    paid: new V.NumberNotNull(),
    /** Cubierto con condonaciones dentro del rango. NO es dinero. */
    waived: new V.NumberNotNull(),
    /** Deuda al cierre de `to`. */
    closingBalance: new V.NumberNotNull(),
  }),
});

// --- Salida: estado de cuenta por unidad, V2 (por cargo) -----------------------

/**
 * UN cargo del estado de cuenta V2. A diferencia de la V1 no hay movimientos
 * intercalados ni saldo corrido: la fila es el CARGO y se cierra sola
 * (`appliedAmount − paid − waived = balance`), y trae las tres cosas que en el
 * ledger hay que reconstruir a mano — si está pagado, cuándo se pagó y de qué
 * periodo es.
 */
const chargeStatementEntryV1V = new V.ObjectNotNull({
  /** Id del CARGO (`billing.charges.id`) — aquí sí identifica la fila sola. */
  id: new V.StringNotNull(),
  /** "Mantenimiento", "Tarjeta de acceso ×2". */
  concept: new V.StringNotNull(),
  /** Periodo ya legible ("Enero-2026", "Cuota extraordinaria bardas");
   *  null = cargo SUELTO, que no devenga periodo. */
  period: new V.String(),
  periodStart: new V.String(),
  periodEnd: new V.String(),
  /** Detalle libre del cargo (folios, motivo de la multa). */
  note: new V.String(),
  quantity: new V.NumberNotNull(),
  /** Día de DEVENGO (`YYYY-MM-DD`): el inicio del periodo o, en un suelto, su
   *  vencimiento. Es el día por el que el rango filtra. */
  accruedOn: new V.StringNotNull(),
  dueDate: new V.StringNotNull(),
  appliedAmount: new V.NumberNotNull(),
  /** Cubierto con DINERO, sin importar cuándo entró. */
  paid: new V.NumberNotNull(),
  waived: new V.NumberNotNull(),
  balance: new V.NumberNotNull(),
  /** billing.charge_status: pending | partial | paid | waived. */
  paymentStatus: new V.StringNotNull(),
  overdue: new V.BooleanNotNull(),
  /** Fecha del ÚLTIMO pago aplicado; null si nunca recibió dinero. */
  paidOn: new V.String(),
  /** Cuántos depósitos distintos lo tocaron — `paidOn` es la fecha del último. */
  paymentCount: new V.NumberNotNull(),
  /** Fecha de la última condonación; null si no se condonó nada. */
  waivedOn: new V.String(),
});

export const unitChargeStatementV1V = new V.ObjectNotNull({
  /** La unidad, resuelta por el servidor (mismo motivo que en la V1). */
  unit: new V.ObjectNotNull({
    id: new V.StringNotNull(),
    code: new V.StringNotNull(),
  }),
  items: new V.ArrayNotNull(chargeStatementEntryV1V),
  total: new V.NumberNotNull(),
  page: new V.NumberNotNull(),
  pageSize: new V.NumberNotNull(),
  /** Zona en la que se recortaron los días (DB_TIMEZONE), como los demás
   *  reportes. */
  timezone: new V.StringNotNull(),
  /** Totales del rango COMPLETO, no de la página. Dos invariantes:
   *  `charged − paid − waived = balance` y
   *  `openingBalance + balance = closingBalance`. */
  totals: new V.ObjectNotNull({
    /** Pendiente de lo devengado ANTES de `from`. Medido sobre el CARGO (con
     *  todos sus pagos aplicados, incluso los posteriores), no sobre la deuda
     *  que había ese día — que es lo que responde el saldo anterior de la V1. */
    openingBalance: new V.NumberNotNull(),
    charged: new V.NumberNotNull(),
    paid: new V.NumberNotNull(),
    waived: new V.NumberNotNull(),
    /** Pendiente de los cargos DEL RANGO. */
    balance: new V.NumberNotNull(),
    /** Pendiente de todo lo devengado hasta el cierre de `to`. */
    closingBalance: new V.NumberNotNull(),
    /** Parte del `closingBalance` cuyos cargos ya vencieron. */
    overdue: new V.NumberNotNull(),
    /** Cuántos cargos del rango ya no deben nada. */
    settledCount: new V.NumberNotNull(),
  }),
});

export const movementListV1V = new V.ObjectNotNull({
  items: new V.ArrayNotNull(movementV1V),
  total: new V.NumberNotNull(),
  page: new V.NumberNotNull(),
  pageSize: new V.NumberNotNull(),
  /** Zona en la que se recortaron los días (DB_TIMEZONE), igual que el resumen:
   *  el reporte impreso tiene que decir en qué días está expresado. */
  timezone: new V.StringNotNull(),
  /** Totales del rango COMPLETO, no de la página. `closingBalance` viene de la
   *  misma función que el resumen (no de sumar los renglones): que coincida con
   *  `openingBalance + income − outflow` es la prueba de que la lista está
   *  completa. */
  totals: new V.ObjectNotNull({
    income: new V.NumberNotNull(),
    outflow: new V.NumberNotNull(),
    openingBalance: new V.NumberNotNull(),
    closingBalance: new V.NumberNotNull(),
  }),
});

export { errorResponseV1V };
