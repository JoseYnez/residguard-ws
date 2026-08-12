import type { TxClient } from "../../../core/db/with_transaction";

// Acceso a datos del recurso reports: agregados DERIVADOS del dominio billing.
// No hay tabla propia y no se escribe nada. RLS filtra el tenant; la comunidad
// ya viene autorizada por requireCommunityAccess.
//
// CUATRO REGLAS QUE GOBIERNAN TODO EL SQL DE ESTE ARCHIVO
//
// 1. El ingreso se atribuye a la comunidad VÍA payment_allocations → charges.
//    `billing.payments` no tiene community_id (un depósito puede cubrir cargos
//    de varias comunidades, y su encabezado no sabe de cuál es cada peso), así
//    que sumar depósitos inventaría dinero. Mismo camino que
//    billing.fn_get_community_balance.
//
// 2. El lado CAJA no filtra `charges.status` — igual que fn_get_community_balance
//    y a propósito: el dinero que entró no desaparece porque el cargo se borre
//    después. Lo que anula un ingreso es el soft-delete de la aplicación o del
//    pago. Filtrar aquí rompería el invariante
//    `openingBalance + income − outflow = closingBalance`, que es justamente la
//    prueba de que este reporte está bien.
//    El lado DEVENGADO (cobranza, adeudo) sí exige `status = 'active'`: un cargo
//    anulado no se debió cobrar nunca. No hay contradicción — el servicio solo
//    deja anular un cargo mientras NO tenga dinero aplicado.
//
// 3. Los saldos por cargo se calculan EN CONJUNTO (LEFT JOIN LATERAL), no
//    llamando a billing.fn_get_charge_balance fila por fila: mismo criterio que
//    la función (aplicaciones + condonaciones activas) y mismo estilo que
//    charges_v1.repository.ts. Ese criterio no mira el status del PAGO, y no
//    hace falta: anular un pago soft-borra también sus aplicaciones.
//
// 4. El JOIN con periodos no existe aquí, pero su consecuencia sí: un cargo
//    SUELTO no tiene `period_start`, así que el devengado lo ubica
//    `COALESCE(period_start, due_date)`. Sin ese COALESCE toda venta de tarjetas
//    y toda multa caería fuera de cualquier rango.
//
// 5. Los TRASPASOS entre cajas son suma cero para la comunidad: NUNCA entran a
//    income/outflow ni al saldo comunitario. Solo aparecen en el desglose por
//    caja (columnas propias transfersIn/transfersOut) y en las tarjetas cuando
//    el filtro de caja está activo. El desglose por caja se calcula SIEMPRE
//    sobre los datos sin filtrar y de las MISMAS consultas que alimentan los
//    totales (una sola fuente): la suma de sus filas — con el bucket "sin
//    caja" para el histórico — reproduce los totales de la comunidad.

/** Suma en centavos: dos NUMERIC(14,2) sumados como floats derivan, y estas
 *  cifras se muestran una al lado de la otra (y deben cuadrar entre sí). */
function addMoney(...values: number[]): number {
  return values.reduce((cents, value) => cents + Math.round(value * 100), 0) / 100;
}

/** NUMERIC llega como texto para no perder precisión en el driver. */
function money(raw: string | null | undefined): number {
  return raw === null || raw === undefined ? 0 : Number(raw);
}

/** Proporción sobre el total ∈ [0,1]; 0 si no hay total (evita 0/0 = NaN). */
function shareOf(amount: number, total: number): number {
  return total === 0 ? 0 : Math.round((amount / total) * 10000) / 10000;
}

export interface ReportRangeInput {
  readonly communityId: string;
  readonly from: string;
  readonly to: string;
  /** UUID de caja, `"none"` (solo movimientos sin caja) o null (todo). Acota
   *  el lado CAJA del resumen; el devengado nunca se filtra. */
  readonly cashAccountId?: string | null;
}

export interface CashFlowSide {
  readonly operations: number;
  readonly adjustments: number;
  readonly total: number;
}

export interface AgingBucket {
  readonly label: string;
  readonly amount: number;
}

export interface CategoryShare {
  readonly categoryId: string;
  readonly name: string;
  readonly amount: number;
  readonly share: number;
}

export interface FeeShare {
  readonly feeId: string;
  readonly concept: string;
  readonly amount: number;
  readonly share: number;
}

export interface MethodShare {
  readonly method: string;
  readonly amount: number;
  readonly share: number;
}

/** Una fila del desglose por caja. `cashAccountId`/`name` null = el bucket
 *  "sin caja" (movimientos que no la declararon — todo el histórico). */
export interface CashAccountBreakdownRow {
  readonly cashAccountId: string | null;
  readonly name: string | null;
  readonly openingBalance: number;
  readonly income: number;
  readonly outflow: number;
  readonly transfersIn: number;
  readonly transfersOut: number;
  readonly closingBalance: number;
}

export interface ReportSummary {
  readonly range: { readonly from: string; readonly to: string; readonly timezone: string };
  readonly cash: {
    readonly openingBalance: number;
    readonly income: CashFlowSide;
    readonly outflow: CashFlowSide;
    readonly transfersIn: number;
    readonly transfersOut: number;
    readonly closingBalance: number;
  };
  readonly cashAccounts: CashAccountBreakdownRow[];
  readonly collections: {
    readonly charged: number;
    readonly collected: number;
    readonly waived: number;
    readonly outstanding: number;
    readonly collectionRate: number;
  };
  readonly overdue: {
    readonly asOf: string;
    readonly total: number;
    readonly buckets: AgingBucket[];
  };
  readonly expensesByCategory: CategoryShare[];
  readonly incomeByFee: FeeShare[];
  readonly incomeByMethod: MethodShare[];
}

// --- Resultado del periodo (ingresos − egresos, sin saldos) --------------------

export interface PeriodResultInput {
  readonly communityId: string;
  readonly from: string;
  readonly to: string;
}

/**
 * Un renglón del desglose de ingresos del resultado: la misma cuota partida por
 * el PERIODO del cargo que se cobró. Es la diferencia con `incomeByFee` del
 * resumen, que agrupa solo por cuota — aquí un depósito de julio que cubrió
 * mayo, junio y julio de Mantenimiento son tres renglones.
 *
 * `periodId` null = cargo SUELTO (una venta de tarjetas no devenga periodo).
 * `periodLabel` null = ese cargo, o un periodo SIN alias propio: el nombre
 * derivado del rango no se calcula aquí ni allá, el renglón se queda con su
 * concepto a secas. El alias viaja resuelto por JOIN con `fee_periods` (no por
 * las columnas copiadas en el cargo), así que renombrar un periodo se lee
 * renombrado — igual que en el detalle de pagos.
 */
export interface FeePeriodShare {
  readonly feeId: string;
  readonly concept: string;
  readonly periodId: string | null;
  readonly periodLabel: string | null;
  readonly amount: number;
}

/** Un rubro de gasto del rango. Sin `share`: el consumidor de este reporte
 *  reparte sobre el total de SU lado (que incluye los movimientos manuales),
 *  no sobre el de operaciones. */
export interface CategoryAmount {
  readonly categoryId: string;
  readonly name: string;
  readonly amount: number;
}

/**
 * El periodo leído como estado de resultados: lo que entró, lo que salió y los
 * dos desgloses que los explican. Deliberadamente SIN saldos (inicial/final),
 * sin cobranza devengada y sin antigüedad — eso responde "cuánto dinero hay" y
 * lo publica `summary`; esto responde "cómo le fue al periodo".
 *
 * Sale de las MISMAS consultas de caja que el resumen (mismos WHERE, mismo
 * recorte a día), así que sus totales son los de `cash.income` / `cash.outflow`
 * de `summary` sin filtro de caja. Lo que cambia es el GROUP BY del ingreso.
 */
export interface PeriodResult {
  readonly range: { readonly from: string; readonly to: string; readonly timezone: string };
  readonly income: CashFlowSide;
  readonly outflow: CashFlowSide;
  readonly incomeByFeePeriod: FeePeriodShare[];
  readonly expensesByCategory: CategoryAmount[];
}

export interface UnitDebt {
  readonly unitId: string;
  readonly unitCode: string;
  readonly charged: number;
  readonly paid: number;
  readonly waived: number;
  readonly balance: number;
  readonly overdue: number;
  readonly oldestDueDate: string | null;
}

export interface UnitDebtTotals {
  readonly charged: number;
  readonly paid: number;
  readonly waived: number;
  readonly balance: number;
  readonly overdue: number;
}

export interface ListUnitDebtInput {
  readonly communityId: string;
  readonly page: number;
  readonly pageSize: number;
  readonly onlyDebtors: boolean;
}

// --- Movimientos (el mismo dinero del resumen, renglón por renglón) -----------

/** De qué tabla salió el renglón. */
export type MovementKind = "payment" | "expense" | "adjustment" | "transfer";

export interface MovementCashAccountRef {
  readonly id: string;
  readonly name: string;
}

/**
 * UN movimiento de dinero. El importe viaja SIGNADO (+ entró, − salió) porque
 * el saldo acumulado es su suma corrida: partirlo en dos columnas obligaría a
 * cada consumidor a recomponer el signo para sumarlo.
 */
export interface Movement {
  /** Id del registro de origen (pago, gasto, ajuste o traspaso). No es único
   *  entre tipos por sí solo — la identidad de la fila es (kind, id). */
  readonly id: string;
  readonly kind: MovementKind;
  /** Fecha de NEGOCIO del movimiento, recortada en la zona de operación. */
  readonly movedOn: string;
  /** Qué fue: las cuotas cubiertas, el concepto del gasto, el motivo. */
  readonly concept: string;
  /** Contexto propio del tipo: las unidades, el rubro y proveedor, las cajas
   *  de un traspaso. null cuando el tipo no aporta ninguno. */
  readonly detail: string | null;
  /** billing.payment_method; null en un traspaso (no lo declara). */
  readonly method: string | null;
  readonly reference: string | null;
  /** Caja por la que pasó; null = no declarada. En un traspaso, la caja del
   *  lado que el filtro está mirando. */
  readonly cashAccount: MovementCashAccountRef | null;
  readonly amount: number;
  /** Saldo del alcance DESPUÉS de este movimiento (saldo inicial + la suma
   *  corrida hasta aquí). Ver {@link reportsRepository.movements}. */
  readonly balance: number;
}

export interface MovementTotals {
  /** Suma de los movimientos positivos del rango, en positivo. */
  readonly income: number;
  /** Suma de los negativos, en positivo. */
  readonly outflow: number;
  /** Saldo al día ANTERIOR a `from`, del alcance filtrado. */
  readonly openingBalance: number;
  /**
   * Saldo al cierre de `to` según `fn_get_community_balance` /
   * `fn_get_cash_account_balance` — la MISMA fuente que el resumen, y no la
   * suma de los renglones de abajo. Que ambas cifras coincidan es lo que
   * prueba que la lista está completa; el cliente compara y avisa si no.
   */
  readonly closingBalance: number;
}

export interface ListMovementsInput {
  readonly communityId: string;
  readonly from: string;
  readonly to: string;
  /** UUID de caja, `"none"` (solo lo que no declaró caja) o null (comunidad). */
  readonly cashAccountId?: string | null;
  readonly page: number;
  readonly pageSize: number;
}

// --- Estado de cuenta por unidad ----------------------------------------------

/** De qué tabla salió el renglón del estado de cuenta. */
export type StatementEntryKind = "charge" | "payment" | "waiver";

/**
 * UN movimiento del estado de cuenta de una unidad. El importe viaja SIGNADO
 * sobre la DEUDA: + la aumenta (cargo), − la baja (pago o condonación) — el
 * saldo deudor es su suma corrida, igual que el saldo de caja en Movement.
 */
export interface StatementEntry {
  /** Id del registro de origen; la identidad de la fila es (kind, id). */
  readonly id: string;
  readonly kind: StatementEntryKind;
  /** Fecha de NEGOCIO: devengo del cargo, día del pago o de la condonación. */
  readonly movedOn: string;
  readonly concept: string;
  /** Periodo del cargo, nota del suelto o motivo de la condonación. */
  readonly detail: string | null;
  /** billing.payment_method; solo en pagos. */
  readonly method: string | null;
  readonly reference: string | null;
  readonly amount: number;
  /** Saldo deudor DESPUÉS de este movimiento. */
  readonly balance: number;
}

export interface StatementTotals {
  /** Deuda al día ANTERIOR a `from`. */
  readonly openingBalance: number;
  readonly charged: number;
  readonly paid: number;
  readonly waived: number;
  /** openingBalance + charged − paid − waived. */
  readonly closingBalance: number;
}

export interface UnitStatement {
  readonly unit: { readonly id: string; readonly code: string };
  readonly items: StatementEntry[];
  readonly total: number;
  readonly totals: StatementTotals;
}

export interface UnitStatementInput {
  readonly communityId: string;
  readonly unitId: string;
  readonly from: string;
  readonly to: string;
  readonly page: number;
  readonly pageSize: number;
}

/**
 * UN cargo del estado de cuenta V2 — la misma fila que lista la consulta de
 * cargos (charges_v1), respondiendo además las tres preguntas que en el ledger
 * V1 hay que reconstruir renglón por renglón: si ya está pagado, CUÁNDO se pagó
 * y de qué periodo es.
 *
 * No lleva saldo corrido: en esta vista cada renglón se cierra solo (importe −
 * pagado − condonado = saldo), así que sumar la columna de saldos no significa
 * nada. Lo que cuadra es el total del rango.
 */
export interface ChargeStatementEntry {
  readonly id: string;
  /** "Mantenimiento", "Tarjeta de acceso ×2" — concepto de la cuota + piezas. */
  readonly concept: string;
  /** Periodo del cargo ya legible (etiqueta propia o derivada del rango);
   *  null = cargo SUELTO, que no devenga periodo. */
  readonly period: string | null;
  readonly periodStart: string | null;
  readonly periodEnd: string | null;
  /** Detalle libre del cargo (folios, motivo de la multa). */
  readonly note: string | null;
  readonly quantity: number;
  /** Día de DEVENGO — `COALESCE(period_start, due_date)`, el mismo con el que
   *  el resto del reporte ubica un cargo en el tiempo. Es lo que el rango
   *  filtra. */
  readonly accruedOn: string;
  readonly dueDate: string;
  readonly appliedAmount: number;
  /** Cubierto con DINERO (aplicaciones activas), sin importar cuándo entró. */
  readonly paid: number;
  readonly waived: number;
  /** appliedAmount − paid − waived: lo que el cargo sigue debiendo. */
  readonly balance: number;
  /** `billing.charge_status` tal cual lo mantiene la BD (pending | partial |
   *  paid | waived) — el mismo valor que muestra la pantalla de Cargos. */
  readonly paymentStatus: string;
  readonly overdue: boolean;
  /** Fecha del ÚLTIMO pago aplicado al cargo; null si nunca recibió dinero.
   *  Con el cargo saldado es el día en que quedó cubierto. */
  readonly paidOn: string | null;
  /** Cuántos DEPÓSITOS distintos lo tocaron (2 = se pagó en dos exhibiciones);
   *  `paidOn` es la fecha del último. */
  readonly paymentCount: number;
  /** Fecha de la última condonación; null si no se condonó nada. */
  readonly waivedOn: string | null;
}

/**
 * Totales del rango COMPLETO (no de la página). Dos invariantes por
 * construcción:
 *
 *     charged − paid − waived = balance
 *     openingBalance + balance = closingBalance
 *
 * OJO con los dos saldos: aquí se miden SOBRE EL CARGO, no sobre el
 * movimiento. El `openingBalance` es lo que sigue debiéndose de lo devengado
 * ANTES del rango — con todo su historial de pagos aplicado, incluso el que
 * entró después — y no "la deuda que había ese día", que es lo que responde el
 * saldo anterior del ledger V1. Un cargo de enero pagado en agosto pesa en el
 * saldo anterior de la V1 (en agosto todavía no había entrado el dinero) y no
 * pesa aquí (el cargo acabó saldado). Las dos cifras son correctas y contestan
 * preguntas distintas: cómo se movió el saldo, y en qué quedó cada cargo.
 */
export interface ChargeStatementTotals {
  /** Saldo pendiente de los cargos devengados ANTES de `from`. */
  readonly openingBalance: number;
  readonly charged: number;
  readonly paid: number;
  readonly waived: number;
  /** Pendiente de los cargos DEL RANGO (charged − paid − waived). */
  readonly balance: number;
  /** Saldo pendiente de todo lo devengado hasta el cierre de `to`. */
  readonly closingBalance: number;
  /** Parte del `closingBalance` cuyos cargos ya vencieron. */
  readonly overdue: number;
  /** Cuántos de los cargos del rango ya no deben nada (pagados o condonados). */
  readonly settledCount: number;
}

export interface UnitChargeStatement {
  readonly unit: { readonly id: string; readonly code: string };
  readonly items: ChargeStatementEntry[];
  readonly total: number;
  readonly totals: ChargeStatementTotals;
}

/** Centinela del filtro de caja: solo los movimientos SIN caja declarada. */
export const CASH_ACCOUNT_NONE = "none";

/**
 * Condición de caja para UNA columna, compuesta en TS y no como un OR gigante
 * en SQL: sin filtro no hay condición que el planificador tenga que descartar,
 * y la consulta se lee igual que la regla. El nombre de columna es siempre un
 * literal de este archivo — nunca entrada del usuario.
 */
function cashAccountFilterSql(column: string, filter: string | null, param: string): string {
  if (filter === null) return "";
  return filter === CASH_ACCOUNT_NONE
    ? `\n       AND ${column} IS NULL`
    : `\n       AND ${column} = ${param}::uuid`;
}

/** Tramos de antigüedad de la cartera vencida, en el orden en que se muestran.
 *  Siempre se devuelven los cuatro (con 0 los vacíos): a una tabla a la que le
 *  faltan renglones se le lee "ese tramo no existe" en vez de "ese tramo está
 *  limpio". */
const AGING_LABELS = ["1-30", "31-60", "61-90", "90+"] as const;

/**
 * Estado de cada cargo ACTIVO de la comunidad: lo aplicado, lo cubierto con
 * dinero, lo condonado y el saldo. `$1` = communityId, siempre.
 *
 * Es la definición ÚNICA de "saldo de un cargo" para todo el reporte: la
 * cobranza, la antigüedad y el adeudo por unidad salen de aquí, de modo que las
 * tres cifras no pueden discrepar entre sí.
 */
const CHARGE_STATE_CTE = `
  charge_state AS (
    SELECT c.unit_id,
           c.due_date,
           -- Devengo: el periodo que AMPARA el cargo; el suelto (sin periodo) se
           -- ubica por su vencimiento.
           COALESCE(c.period_start, c.due_date) AS accrual_date,
           c.applied_amount,
           COALESCE(pa.paid, 0)   AS paid,
           COALESCE(wv.waived, 0) AS waived,
           c.applied_amount - COALESCE(pa.paid, 0) - COALESCE(wv.waived, 0) AS balance
      FROM billing.charges c
      LEFT JOIN LATERAL (
        SELECT SUM(a.amount) AS paid
          FROM billing.payment_allocations a
         WHERE a.charge_id = c.id AND a.status <> 'deleted'
      ) pa ON true
      LEFT JOIN LATERAL (
        SELECT SUM(w.waived_amount) AS waived
          FROM billing.waivers w
         WHERE w.charge_id = c.id AND w.status <> 'deleted'
      ) wv ON true
     WHERE c.community_id = $1
       AND c.status = 'active'
  )
`;

/**
 * Agregado por unidad sobre `charge_state`. El corte del vencido es
 * `CURRENT_DATE` (hoy en DB_TIMEZONE): la cartera se reporta en su estado
 * ACTUAL, no reconstruida a una fecha pasada — reconstruirla exigiría fechar
 * también las aplicaciones y condonaciones, y eso es otro reporte.
 */
const PER_UNIT_CTE = `
  per_unit AS (
    SELECT unit_id,
           SUM(applied_amount) AS charged,
           SUM(paid)           AS paid,
           SUM(waived)         AS waived,
           SUM(balance)        AS balance,
           -- Vencido: solo la parte SIN cubrir de los cargos ya vencidos.
           -- GREATEST porque un cargo sobrepagado no debe generar un "vencido
           -- negativo" que compense la deuda de otro.
           SUM(CASE WHEN due_date < CURRENT_DATE THEN GREATEST(balance, 0) ELSE 0 END) AS overdue,
           -- Desde cuándo arrastra: el vencimiento más antiguo sin cubrir (si
           -- algo tiene vencido, es ése).
           MIN(due_date) FILTER (WHERE balance > 0) AS oldest_due_date
      FROM charge_state
     GROUP BY unit_id
  )
`;

/** Unidades de la comunidad con su adeudo. `$1` = communityId, `$2` = onlyDebtors.
 *  LEFT JOIN: una unidad sin cargos aparece en ceros — es información, no un
 *  hueco (y desaparecería en cuanto se le genere el primer cargo). */
const UNIT_DEBT_FROM = `
    FROM community.units u
    LEFT JOIN per_unit p ON p.unit_id = u.id
   WHERE u.community_id = $1
     AND u.status <> 'deleted'
     AND ($2::boolean IS NOT TRUE OR COALESCE(p.balance, 0) > 0)
`;

interface BalancesRow {
  opening: string | null;
  closing: string | null;
  as_of: string;
}

interface IncomeRow {
  fee_id: string;
  concept: string;
  method: string;
  cash_account_id: string | null;
  amount: string;
}

interface AdjustmentsRow {
  cash_account_id: string | null;
  inflow: string;
  outflow: string;
}

interface ExpenseCategoryRow {
  category_id: string;
  name: string;
  cash_account_id: string | null;
  amount: string;
}

/** Filas del resultado del periodo: sin caja, porque ese reporte es SIEMPRE la
 *  comunidad entera (acotarlo a una caja convierte "cuánto entró" en "cuánto
 *  entró ahí", que es la pregunta que responde el resumen). */
interface FeePeriodIncomeRow {
  fee_id: string;
  concept: string;
  period_id: string | null;
  period_label: string | null;
  amount: string;
}

interface AdjustmentTotalsRow {
  inflow: string;
  outflow: string;
}

interface ExpenseCategoryTotalRow {
  category_id: string;
  name: string;
  amount: string;
}

interface CashAccountBalancesRow {
  id: string;
  name: string;
  opening: string | null;
  closing: string | null;
}

interface TransferFlowsRow {
  cash_account_id: string;
  transfers_in: string;
  transfers_out: string;
}

interface CollectionsRow {
  charged: string;
  collected: string;
  waived: string;
}

interface AgingRow {
  bucket: string;
  amount: string;
}

interface MovementRow {
  id: string;
  kind: string;
  moved_on: string;
  amount: string;
  method: string | null;
  reference: string | null;
  concept: string | null;
  detail: string | null;
  cash_account_id: string | null;
  cash_account_name: string | null;
  /** Suma corrida SIN el saldo inicial (se le suma en TS). */
  running: string;
}

interface MovementTotalsRow {
  count: string;
  income: string;
  outflow: string;
}

interface ScopeBalancesRow {
  opening: string | null;
  closing: string | null;
}

/**
 * Saldos de corte del alcance que se está listando: la comunidad entera, UNA
 * caja, o el bucket "sin caja".
 *
 * Salen de las mismas funciones que el resumen (`fn_get_community_balance` /
 * `fn_get_cash_account_balance`) y con los mismos cortes —el día ANTERIOR a
 * `from` y el propio `to`—, así que el saldo inicial de esta lista es
 * literalmente el mismo número que la tarjeta del otro reporte.
 *
 * El bucket "sin caja" no tiene función propia: se deriva por DIFERENCIA
 * (comunidad − todas sus cajas), igual que el desglose del resumen. Eso
 * garantiza que los tres alcances sumen exacto en vez de casi.
 */
async function scopeBalances(
  tx: TxClient,
  communityId: string,
  from: string,
  to: string,
  filter: string | null,
): Promise<{ opening: number; closing: number }> {
  if (filter !== null && filter !== CASH_ACCOUNT_NONE) {
    const result = await tx.query<ScopeBalancesRow>(
      `SELECT billing.fn_get_cash_account_balance($1::uuid, ($2::date - 1))::text AS opening,
              billing.fn_get_cash_account_balance($1::uuid, $3::date)::text       AS closing`,
      [filter, from, to],
    );
    const row = result.rows[0];
    return { opening: money(row?.opening), closing: money(row?.closing) };
  }

  const result = await tx.query<ScopeBalancesRow & { accounts_opening: string; accounts_closing: string }>(
    `SELECT billing.fn_get_community_balance($1, ($2::date - 1))::text AS opening,
            billing.fn_get_community_balance($1, $3::date)::text       AS closing,
            COALESCE((SELECT SUM(billing.fn_get_cash_account_balance(ca.id, ($2::date - 1)))
                        FROM billing.cash_accounts ca
                       WHERE ca.community_id = $1 AND ca.status <> 'deleted'), 0)::text
              AS accounts_opening,
            COALESCE((SELECT SUM(billing.fn_get_cash_account_balance(ca.id, $3::date))
                        FROM billing.cash_accounts ca
                       WHERE ca.community_id = $1 AND ca.status <> 'deleted'), 0)::text
              AS accounts_closing`,
    [communityId, from, to],
  );
  const row = result.rows[0];
  const opening = money(row?.opening);
  const closing = money(row?.closing);
  if (filter === null) {
    return { opening, closing };
  }
  return {
    opening: addMoney(opening, -money(row?.accounts_opening)),
    closing: addMoney(closing, -money(row?.accounts_closing)),
  };
}

/**
 * Los tres orígenes del estado de cuenta de UNA unidad, ya signados sobre su
 * DEUDA. `$1` = communityId, `$2` = unitId.
 *
 * Mismas reglas que el resto del archivo, aplicadas al sujeto unidad:
 *
 * - El cargo se ubica por su DEVENGO — `COALESCE(period_start, due_date)` — y
 *   el JOIN con `fee_periods` es LEFT (regla 4): un cargo suelto no tiene
 *   periodo y con un INNER la venta desaparecería del estado de cuenta.
 * - Los tres lados exigen `c.status = 'active'`: es el criterio de
 *   `fn_get_charge_balance` (CHARGE_STATE_CTE), así que el saldo final del
 *   estado de cuenta reproduce el `balance` del adeudo por unidad.
 * - Un ABONO es la parte del depósito aplicada a cargos de ESTA unidad
 *   (`payment_allocations.unit_id`, denormalizado), un renglón por depósito —
 *   la misma unidad de captura que la pantalla de Pagos. No mira el status del
 *   PAGO más allá de `<> 'deleted'`: anular un pago soft-borra también sus
 *   aplicaciones (regla 3).
 * - La CONDONACIÓN baja la deuda pero NO es dinero; viaja como renglón propio
 *   para que el lector vea por qué el saldo bajó sin que nadie pagara.
 */
const STATEMENT_ENTRIES_CTE = `
  entries AS (
    SELECT c.id::text AS id, 'charge'::text AS kind,
           COALESCE(c.period_start, c.due_date) AS moved_on,
           f.concept || CASE WHEN c.quantity > 1 THEN ' ×' || c.quantity ELSE '' END AS concept,
           -- El contexto del cargo: su periodo (etiqueta propia o derivada) o,
           -- en un suelto, la nota de la venta.
           COALESCE(fp.label,
                    billing.fn_format_period_es(c.period_start, c.period_end),
                    c.note) AS detail,
           NULL::text AS method, NULL::text AS reference,
           c.applied_amount AS amount,
           c.created_at
      FROM billing.charges c
      JOIN billing.fees f ON f.customer_id = c.customer_id AND f.id = c.fee_id
      LEFT JOIN billing.fee_periods fp
        ON fp.customer_id = c.customer_id AND fp.id = c.period_id
     WHERE c.community_id = $1
       AND c.unit_id = $2
       AND c.status = 'active'

    UNION ALL

    SELECT p.id::text, 'payment'::text,
           -- ::date recorta el instante en la zona de la SESIÓN (DB_TIMEZONE),
           -- igual que summary y movements.
           p.paid_at::date,
           string_agg(DISTINCT f.concept, ', ' ORDER BY f.concept),
           NULL::text,
           p.method::text, p.reference,
           -SUM(pa.amount),
           p.created_at
      FROM billing.payment_allocations pa
      JOIN billing.payments p ON p.customer_id = pa.customer_id AND p.id = pa.payment_id
      JOIN billing.charges  c ON c.customer_id = pa.customer_id AND c.id = pa.charge_id
      JOIN billing.fees     f ON f.customer_id = c.customer_id  AND f.id = c.fee_id
     WHERE c.community_id = $1
       AND pa.unit_id = $2
       AND pa.status <> 'deleted'
       AND p.status  <> 'deleted'
       AND c.status   = 'active'
     GROUP BY p.id, p.paid_at, p.method, p.reference, p.created_at

    UNION ALL

    SELECT w.id::text, 'waiver'::text, w.created_at::date,
           'Condonación — ' || f.concept,
           w.reason,
           NULL::text, NULL::text,
           -w.waived_amount,
           w.created_at
      FROM billing.waivers w
      JOIN billing.charges c ON c.customer_id = w.customer_id AND c.id = w.charge_id
      JOIN billing.fees    f ON f.customer_id = c.customer_id AND f.id = c.fee_id
     WHERE c.community_id = $1
       AND c.unit_id = $2
       AND w.status <> 'deleted'
       AND c.status  = 'active'
  )
`;

/**
 * El estado de cuenta V2, visto desde el CARGO: una fila por cargo ACTIVO de la
 * unidad, con lo que se le aplicó, lo que se le condonó, su saldo y las fechas
 * que cierran la historia de esa fila. `$1` = communityId, `$2` = unitId.
 *
 * Mismas reglas que el resto del archivo, y a propósito las MISMAS que la
 * consulta de cargos (charges_v1.repository.ts), que es de donde sale esta
 * vista:
 *
 * - `status = 'active'` y el saldo agregado en LATERAL (regla 3): el saldo de
 *   cada fila reproduce el de la pantalla de Cargos y el de
 *   `fn_get_charge_balance`, y el total del rango reproduce el adeudo de la
 *   unidad cuando el rango abarca todo su historial.
 * - JOIN LEFT con `fee_periods` (§3 de CLAUDE.md): un cargo SUELTO no tiene
 *   periodo, y con un INNER la venta de tarjetas desaparecería de la vista.
 * - El cargo se ubica por su DEVENGO, `COALESCE(period_start, due_date)`
 *   (regla 4) — el mismo día con el que el ledger V1 lo ordena, para que las
 *   dos versiones metan los mismos cargos en el mismo rango.
 * - `payment_status` viaja como lo mantiene la BD (vías sancionadas), no
 *   derivado aquí: es el mismo estatus que muestra la pantalla de Cargos, y dos
 *   definiciones del mismo badge es como dejan de coincidir.
 *
 * LAS FECHAS DE PAGO salen de las aplicaciones ACTIVAS del cargo: `paid_on` es
 * la del último depósito que lo tocó — en un cargo saldado, el día en que quedó
 * cubierto — y `payment_count` dice si hubo más de uno, que es lo que impide
 * leer esa fecha como "el día en que se pagó todo" cuando fueron dos
 * exhibiciones. El pago borrado no cuenta por partida doble (`pa.status` y
 * `p.status`): anular un pago soft-borra ambas cosas.
 */
const CHARGE_STATEMENT_CTE = `
  unit_charges AS (
    SELECT c.id::text AS id,
           f.concept || CASE WHEN c.quantity > 1 THEN ' ×' || c.quantity ELSE '' END AS concept,
           COALESCE(fp.label,
                    billing.fn_format_period_es(c.period_start, c.period_end)) AS period,
           c.period_start::text AS period_start,
           c.period_end::text   AS period_end,
           c.note,
           c.quantity,
           COALESCE(c.period_start, c.due_date) AS accrued_on,
           c.due_date,
           c.applied_amount,
           COALESCE(pay.paid, 0)  AS paid,
           COALESCE(wv.waived, 0) AS waived,
           c.applied_amount - COALESCE(pay.paid, 0) - COALESCE(wv.waived, 0) AS balance,
           c.payment_status::text AS payment_status,
           pay.last_paid_on,
           COALESCE(pay.payment_count, 0) AS payment_count,
           wv.last_waived_on,
           c.created_at
      FROM billing.charges c
      JOIN billing.fees f ON f.customer_id = c.customer_id AND f.id = c.fee_id
      LEFT JOIN billing.fee_periods fp
        ON fp.customer_id = c.customer_id AND fp.id = c.period_id
      LEFT JOIN LATERAL (
        SELECT SUM(pa.amount)       AS paid,
               -- ::date recorta el instante en la zona de la SESIÓN
               -- (DB_TIMEZONE), igual que summary, movements y el ledger V1.
               MAX(p.paid_at::date) AS last_paid_on,
               count(DISTINCT p.id) AS payment_count
          FROM billing.payment_allocations pa
          JOIN billing.payments p
            ON p.customer_id = pa.customer_id AND p.id = pa.payment_id
         WHERE pa.charge_id = c.id
           AND pa.status <> 'deleted'
           AND p.status  <> 'deleted'
      ) pay ON true
      LEFT JOIN LATERAL (
        SELECT SUM(w.waived_amount)    AS waived,
               MAX(w.created_at::date) AS last_waived_on
          FROM billing.waivers w
         WHERE w.charge_id = c.id AND w.status <> 'deleted'
      ) wv ON true
     WHERE c.community_id = $1
       AND c.unit_id = $2
       AND c.status = 'active'
  )
`;

/**
 * El rango del estado de cuenta V2 acota por DEVENGO, no por fecha de pago: el
 * sujeto de la vista es el cargo. Un cargo de marzo pagado en agosto pertenece
 * a marzo, y su fila dice que se pagó en agosto — que es exactamente la
 * pregunta que la V1 obliga a reconstruir. `$3` = from, `$4` = to.
 *
 * Es una CONDICIÓN y no un WHERE porque los totales la usan dentro de FILTER:
 * los saldos de corte necesitan ver también los cargos de fuera del rango.
 */
const IN_RANGE = `accrued_on >= $3::date AND accrued_on <= $4::date`;

interface StatementUnitRow {
  id: string;
  code: string;
}

/**
 * La unidad del estado de cuenta, resuelta por el SERVIDOR: el contrato la
 * devuelve para que el PDF no dependa de la lista que el cliente tenga en
 * memoria. `null` = no existe en esa comunidad para el tenant (o está borrada):
 * fuera de alcance → 404, indistinguible de inexistente. La unidad INACTIVA sí
 * responde — dar de baja una unidad no borra su historia, y su estado de cuenta
 * es justo lo que alguien cerrando cuentas viene a buscar (mismo criterio que
 * resolveUnitAccess). Las dos versiones del estado de cuenta la resuelven aquí,
 * de una sola forma.
 */
async function selectStatementUnit(
  tx: TxClient,
  communityId: string,
  unitId: string,
): Promise<{ id: string; code: string } | null> {
  const result = await tx.query<StatementUnitRow>(
    `SELECT u.id, u.code
       FROM community.units u
      WHERE u.community_id = $1
        AND u.id = $2
        AND u.status <> 'deleted'`,
    [communityId, unitId],
  );
  const row = result.rows[0];
  return row === undefined ? null : { id: row.id, code: row.code };
}

interface ChargeStatementEntryRow {
  id: string;
  concept: string;
  period: string | null;
  period_start: string | null;
  period_end: string | null;
  note: string | null;
  quantity: number;
  accrued_on: string;
  due_date: string;
  applied_amount: string;
  paid: string;
  waived: string;
  balance: string;
  payment_status: string;
  overdue: boolean;
  paid_on: string | null;
  payment_count: string;
  waived_on: string | null;
}

interface ChargeStatementTotalsRow {
  count: string;
  opening: string;
  charged: string;
  paid: string;
  waived: string;
  balance: string;
  closing: string;
  overdue: string;
  settled: string;
}

interface StatementTotalsRow {
  count: string;
  opening: string;
  charged: string;
  paid: string;
  waived: string;
}

interface StatementEntryRow {
  id: string;
  kind: string;
  moved_on: string;
  concept: string;
  detail: string | null;
  method: string | null;
  reference: string | null;
  amount: string;
  /** Suma corrida SIN el saldo anterior (se le suma en TS). */
  running: string;
}

interface UnitDebtRow {
  unit_id: string;
  unit_code: string;
  charged: string;
  paid: string;
  waived: string;
  balance: string;
  overdue: string;
  oldest_due_date: string | null;
}

interface UnitDebtTotalsRow {
  count: string;
  charged: string;
  paid: string;
  waived: string;
  balance: string;
  overdue: string;
}

export const reportsRepository = {
  /**
   * Resumen financiero de la comunidad para [from, to] (ambos inclusivos: son
   * días de negocio, no instantes). Devuelve `null` si la comunidad no existe
   * para el tenant — no debería ocurrir tras requireCommunityAccess, pero un
   * saldo NULL significa eso y no un cero.
   */
  async summary(
    tx: TxClient,
    input: ReportRangeInput,
    timezone: string,
  ): Promise<ReportSummary | null> {
    const { communityId, from, to } = input;
    const range = [communityId, from, to];

    // --- Saldos de corte y fecha de hoy ---------------------------------------
    // El saldo inicial es el del día ANTERIOR a `from`: con el de `from`, los
    // movimientos de ese día estarían contados dos veces (dentro del saldo y
    // otra vez entre los ingresos del rango).
    const balances = await tx.query<BalancesRow>(
      `SELECT billing.fn_get_community_balance($1, ($2::date - 1))::text AS opening,
              billing.fn_get_community_balance($1, $3::date)::text       AS closing,
              CURRENT_DATE::text                                         AS as_of`,
      range,
    );
    const balanceRow = balances.rows[0];
    if (balanceRow === undefined || balanceRow.opening === null) {
      return null;
    }

    // --- Cajas de la comunidad, con saldos de corte propios -------------------
    // Todas las NO borradas (una caja inactiva sigue teniendo saldo). El saldo
    // por caja lo deriva fn_get_cash_account_balance con los mismos cortes que
    // el comunitario; el del bucket "sin caja" no tiene función propia — se
    // deriva por diferencia (comunidad − cajas), lo que garantiza que el
    // desglose sume EXACTO al total.
    const cashAccountRows = await tx.query<CashAccountBalancesRow>(
      `SELECT ca.id, ca.name,
              billing.fn_get_cash_account_balance(ca.id, ($2::date - 1))::text AS opening,
              billing.fn_get_cash_account_balance(ca.id, $3::date)::text       AS closing
         FROM billing.cash_accounts ca
        WHERE ca.community_id = $1
          AND ca.status <> 'deleted'
        ORDER BY ca.name`,
      range,
    );

    // --- Ingresos por cuotas, desglosados por cuota, método y caja ------------
    // Una sola consulta alimenta cuatro cifras (total, por cuota, por método y
    // la columna de ingresos del desglose por caja): pedirlas por separado abre
    // la puerta a que no sumen lo mismo. La caja es la del ENCABEZADO del pago
    // (p.cash_account_id); NULL = el bucket "sin caja".
    const income = await tx.query<IncomeRow>(
      `SELECT f.id AS fee_id, f.concept, p.method::text AS method,
              p.cash_account_id, SUM(pa.amount)::text AS amount
         FROM billing.payment_allocations pa
         JOIN billing.payments p ON p.customer_id = pa.customer_id AND p.id = pa.payment_id
         JOIN billing.charges  c ON c.customer_id = pa.customer_id AND c.id = pa.charge_id
         JOIN billing.fees     f ON f.customer_id = c.customer_id  AND f.id = c.fee_id
        WHERE c.community_id = $1
          AND pa.status <> 'deleted'
          AND p.status  <> 'deleted'
          -- ::date recorta el instante en la zona de la SESIÓN, que el pool fija
          -- a DB_TIMEZONE. En UTC, un pago de las 19:00 caería al día siguiente.
          AND p.paid_at::date >= $2::date
          AND p.paid_at::date <= $3::date
        GROUP BY f.id, f.concept, p.method, p.cash_account_id`,
      range,
    );

    // --- Movimientos manuales de caja, partidos por signo y por caja ----------
    const adjustments = await tx.query<AdjustmentsRow>(
      `SELECT cash_account_id,
              COALESCE(SUM(amount)  FILTER (WHERE amount > 0), 0)::text AS inflow,
              COALESCE(SUM(-amount) FILTER (WHERE amount < 0), 0)::text AS outflow
         FROM billing.fund_adjustments
        WHERE community_id = $1
          AND status <> 'deleted'
          AND adjusted_at >= $2::date
          AND adjusted_at <= $3::date
        GROUP BY cash_account_id`,
      range,
    );

    // --- Gastos ejercidos, por rubro y por caja -------------------------------
    // El rubro se re-agrega en JS (una fila por rubro puede venir partida en
    // varias cajas); el ORDER final lo pone la composición.
    const expenses = await tx.query<ExpenseCategoryRow>(
      `SELECT ec.id AS category_id, ec.name, e.cash_account_id, SUM(e.amount)::text AS amount
         FROM billing.expenses e
         JOIN billing.expense_categories ec
           ON ec.customer_id = e.customer_id AND ec.id = e.expense_category_id
        WHERE e.community_id = $1
          AND e.status <> 'deleted'
          AND e.expense_date >= $2::date
          AND e.expense_date <= $3::date
        GROUP BY ec.id, ec.name, e.cash_account_id`,
      range,
    );

    // --- Traspasos entre cajas del rango, por caja y sentido ------------------
    // Suma cero para la comunidad (regla 5): solo alimentan las columnas
    // transfersIn/transfersOut del desglose y de las tarjetas filtradas.
    const transfers = await tx.query<TransferFlowsRow>(
      `SELECT x.cash_account_id,
              COALESCE(SUM(x.amount) FILTER (WHERE x.dir = 'in'), 0)::text  AS transfers_in,
              COALESCE(SUM(x.amount) FILTER (WHERE x.dir = 'out'), 0)::text AS transfers_out
         FROM (
           SELECT to_cash_account_id AS cash_account_id, amount, 'in'::text AS dir
             FROM billing.cash_account_transfers
            WHERE community_id = $1 AND status <> 'deleted'
              AND transferred_at >= $2::date AND transferred_at <= $3::date
           UNION ALL
           SELECT from_cash_account_id, amount, 'out'::text
             FROM billing.cash_account_transfers
            WHERE community_id = $1 AND status <> 'deleted'
              AND transferred_at >= $2::date AND transferred_at <= $3::date
         ) x
        GROUP BY x.cash_account_id`,
      range,
    );

    // --- Cobranza del periodo (DEVENGADO) ------------------------------------
    // Ojo: `collected` NO es el ingreso de caja del rango. Aquí es cuánto de lo
    // devengado en [from, to] está cubierto HOY, se haya pagado cuando se haya
    // pagado; allá es cuánto dinero entró en esas fechas. Sumar ambos es contar
    // dos veces.
    const collections = await tx.query<CollectionsRow>(
      `WITH ${CHARGE_STATE_CTE}
       SELECT COALESCE(SUM(applied_amount), 0)::text AS charged,
              COALESCE(SUM(paid), 0)::text           AS collected,
              COALESCE(SUM(waived), 0)::text         AS waived
         FROM charge_state
        WHERE accrual_date >= $2::date
          AND accrual_date <= $3::date`,
      range,
    );

    // --- Cartera vencida por antigüedad (a HOY) -------------------------------
    // Independiente del rango a propósito: lo que se debe hoy se debe hoy, mire
    // uno el mes que mire. `balance > 0` deja fuera los cargos ya cubiertos.
    const aging = await tx.query<AgingRow>(
      `WITH ${CHARGE_STATE_CTE}
       SELECT CASE
                WHEN CURRENT_DATE - due_date <= 30 THEN '1-30'
                WHEN CURRENT_DATE - due_date <= 60 THEN '31-60'
                WHEN CURRENT_DATE - due_date <= 90 THEN '61-90'
                ELSE '90+'
              END                    AS bucket,
              SUM(balance)::text     AS amount
         FROM charge_state
        WHERE balance > 0
          AND due_date < CURRENT_DATE
        GROUP BY 1`,
      [communityId],
    );

    // --- Composición del payload ---------------------------------------------

    // Filtro de caja del lado CAJA: null = sin filtro; "none" = solo los
    // movimientos SIN caja (clave null); un UUID = solo esa caja.
    const filter = input.cashAccountId ?? null;
    const filterActive = filter !== null;
    const filterKey: string | null = filter === "none" ? null : filter;

    // Acumulador del desglose: ingresos/egresos del rango por caja. La clave
    // "" representa el bucket "sin caja" (cash_account_id null).
    const perAccount = new Map<string, { income: number; outflow: number }>();
    const bump = (id: string | null, field: "income" | "outflow", amount: number): void => {
      const key = id ?? "";
      const acc = perAccount.get(key) ?? { income: 0, outflow: 0 };
      acc[field] = addMoney(acc[field], amount);
      perAccount.set(key, acc);
    };

    // Las MISMAS filas alimentan los totales (con el filtro aplicado) y el
    // desglose (siempre completo): una sola fuente, imposible que discrepen.
    const scopedIncome = filterActive
      ? income.rows.filter((row) => row.cash_account_id === filterKey)
      : income.rows;

    const incomeByFeeMap = new Map<string, { concept: string; amount: number }>();
    const incomeByMethodMap = new Map<string, number>();
    for (const row of scopedIncome) {
      const amount = money(row.amount);
      const fee = incomeByFeeMap.get(row.fee_id);
      incomeByFeeMap.set(row.fee_id, {
        concept: row.concept,
        amount: fee === undefined ? amount : addMoney(fee.amount, amount),
      });
      incomeByMethodMap.set(
        row.method,
        addMoney(incomeByMethodMap.get(row.method) ?? 0, amount),
      );
    }
    for (const row of income.rows) {
      bump(row.cash_account_id, "income", money(row.amount));
    }
    const incomeFromCharges = addMoney(
      ...[...incomeByFeeMap.values()].map((fee) => fee.amount),
    );

    const scopedAdjustments = filterActive
      ? adjustments.rows.filter((row) => row.cash_account_id === filterKey)
      : adjustments.rows;
    const adjustmentsIn = addMoney(...scopedAdjustments.map((row) => money(row.inflow)));
    const adjustmentsOut = addMoney(...scopedAdjustments.map((row) => money(row.outflow)));
    for (const row of adjustments.rows) {
      bump(row.cash_account_id, "income", money(row.inflow));
      bump(row.cash_account_id, "outflow", money(row.outflow));
    }

    const scopedExpenses = filterActive
      ? expenses.rows.filter((row) => row.cash_account_id === filterKey)
      : expenses.rows;
    // Re-agregado por rubro: las filas vienen partidas por caja.
    const expensesByCategoryMap = new Map<string, { name: string; amount: number }>();
    for (const row of scopedExpenses) {
      const category = expensesByCategoryMap.get(row.category_id);
      expensesByCategoryMap.set(row.category_id, {
        name: row.name,
        amount:
          category === undefined
            ? money(row.amount)
            : addMoney(category.amount, money(row.amount)),
      });
    }
    for (const row of expenses.rows) {
      bump(row.cash_account_id, "outflow", money(row.amount));
    }
    const expensesTotal = addMoney(
      ...[...expensesByCategoryMap.values()].map((category) => category.amount),
    );

    const incomeTotal = addMoney(incomeFromCharges, adjustmentsIn);
    const outflowTotal = addMoney(expensesTotal, adjustmentsOut);

    // --- Desglose por caja -----------------------------------------------------
    const transferFlows = new Map(
      transfers.rows.map((row) => [
        row.cash_account_id,
        { in: money(row.transfers_in), out: money(row.transfers_out) },
      ]),
    );

    const accountRows: CashAccountBreakdownRow[] = cashAccountRows.rows.map((row) => {
      const flows = perAccount.get(row.id) ?? { income: 0, outflow: 0 };
      const moved = transferFlows.get(row.id) ?? { in: 0, out: 0 };
      return {
        cashAccountId: row.id,
        name: row.name,
        openingBalance: money(row.opening),
        income: flows.income,
        outflow: flows.outflow,
        transfersIn: moved.in,
        transfersOut: moved.out,
        closingBalance: money(row.closing),
      };
    });

    // El bucket "sin caja" cierra por DIFERENCIA contra la comunidad: así la
    // suma de filas reproduce el total aunque el histórico no declare caja.
    // Sin traspasos por definición (un traspaso siempre nombra sus dos cajas).
    const looseFlows = perAccount.get("") ?? { income: 0, outflow: 0 };
    const looseRow: CashAccountBreakdownRow = {
      cashAccountId: null,
      name: null,
      openingBalance: addMoney(
        money(balanceRow.opening),
        ...accountRows.map((row) => -row.openingBalance),
      ),
      income: looseFlows.income,
      outflow: looseFlows.outflow,
      transfersIn: 0,
      transfersOut: 0,
      closingBalance: addMoney(
        money(balanceRow.closing),
        ...accountRows.map((row) => -row.closingBalance),
      ),
    };
    const cashAccountsBreakdown = [...accountRows, looseRow];

    // --- Tarjetas del bloque cash: comunidad, o la caja del filtro -------------
    // income/outflow ya vienen acotados por `scoped*`; los saldos y traspasos
    // salen de la fila correspondiente del desglose. Un UUID que no sea una
    // caja de ESTA comunidad no tiene fila → opaco, como todo fuera de alcance.
    let cashScope: CashAccountBreakdownRow | null = null;
    if (filterActive) {
      cashScope =
        filter === "none"
          ? looseRow
          : (accountRows.find((row) => row.cashAccountId === filter) ?? null);
      if (cashScope === null) {
        return null;
      }
    }

    const collectionsRow = collections.rows[0];
    const charged = money(collectionsRow?.charged);
    const collected = money(collectionsRow?.collected);
    const waived = money(collectionsRow?.waived);

    const agingByLabel = new Map(aging.rows.map((row) => [row.bucket, money(row.amount)]));
    const buckets = AGING_LABELS.map((label) => ({
      label,
      amount: agingByLabel.get(label) ?? 0,
    }));

    return {
      range: { from, to, timezone },
      cash: {
        // Con filtro activo, los saldos son los de ESA caja (o del bucket "sin
        // caja"); income/outflow ya vienen acotados por las filas `scoped*`.
        openingBalance:
          cashScope === null ? money(balanceRow.opening) : cashScope.openingBalance,
        income: {
          operations: incomeFromCharges,
          adjustments: adjustmentsIn,
          total: incomeTotal,
        },
        outflow: {
          operations: expensesTotal,
          adjustments: adjustmentsOut,
          total: outflowTotal,
        },
        // A nivel comunidad los traspasos se cancelan y viajan en 0 (regla 5).
        transfersIn: cashScope === null ? 0 : cashScope.transfersIn,
        transfersOut: cashScope === null ? 0 : cashScope.transfersOut,
        closingBalance:
          cashScope === null ? money(balanceRow.closing) : cashScope.closingBalance,
      },
      cashAccounts: cashAccountsBreakdown,
      collections: {
        charged,
        collected,
        waived,
        outstanding: addMoney(charged, -collected, -waived),
        collectionRate: shareOf(collected, charged),
      },
      overdue: {
        asOf: balanceRow.as_of,
        total: addMoney(...buckets.map((bucket) => bucket.amount)),
        buckets,
      },
      expensesByCategory: [...expensesByCategoryMap.entries()]
        .map(([categoryId, category]) => ({
          categoryId,
          name: category.name,
          amount: category.amount,
          share: shareOf(category.amount, expensesTotal),
        }))
        .sort((a, b) => b.amount - a.amount || a.name.localeCompare(b.name)),
      incomeByFee: [...incomeByFeeMap.entries()]
        .map(([feeId, fee]) => ({
          feeId,
          concept: fee.concept,
          amount: fee.amount,
          share: shareOf(fee.amount, incomeFromCharges),
        }))
        .sort((a, b) => b.amount - a.amount || a.concept.localeCompare(b.concept)),
      incomeByMethod: [...incomeByMethodMap.entries()]
        .map(([method, amount]) => ({
          method,
          amount,
          share: shareOf(amount, incomeFromCharges),
        }))
        .sort((a, b) => b.amount - a.amount || a.method.localeCompare(b.method)),
    };
  },

  /**
   * Resultado del periodo: ingresos, egresos y los dos desgloses que los
   * explican, para [from, to] (días de negocio, ambos inclusivos).
   *
   * Endpoint propio y no un campo más del resumen: el desglose de ingresos va
   * partido por CUOTA Y PERIODO, lo que multiplica sus renglones, y ese detalle
   * solo lo lee esta pantalla — colgarlo de `summary` engordaría también al
   * consumidor que no lo pide.
   *
   * Que los totales coincidan con los del resumen no depende de la suerte: son
   * las MISMAS tres consultas de caja (mismos JOINs, mismos WHERE, mismo
   * recorte a día) sin el filtro de caja, que este reporte no tiene. Lo único
   * que cambia es el GROUP BY del ingreso.
   *
   * Sin saldos de corte, así que no hay `null` que devolver: la existencia de
   * la comunidad ya la afirmó requireCommunityAccess.
   */
  async periodResult(
    tx: TxClient,
    input: PeriodResultInput,
    timezone: string,
  ): Promise<PeriodResult> {
    const { communityId, from, to } = input;
    const range = [communityId, from, to];

    // --- Ingresos por cuota Y PERIODO ----------------------------------------
    // El periodo sale del JOIN con `fee_periods` (LEFT — regla 4: un cargo
    // suelto no tiene periodo y con un INNER la venta de tarjetas se caería del
    // desglose y el total dejaría de cuadrar). El alias es el VIGENTE, no el
    // copiado en el cargo: renombrar un periodo se lee renombrado.
    const income = await tx.query<FeePeriodIncomeRow>(
      `SELECT f.id AS fee_id, f.concept,
              c.period_id::text AS period_id, fp.label AS period_label,
              SUM(pa.amount)::text AS amount
         FROM billing.payment_allocations pa
         JOIN billing.payments p ON p.customer_id = pa.customer_id AND p.id = pa.payment_id
         JOIN billing.charges  c ON c.customer_id = pa.customer_id AND c.id = pa.charge_id
         JOIN billing.fees     f ON f.customer_id = c.customer_id  AND f.id = c.fee_id
         LEFT JOIN billing.fee_periods fp
           ON fp.customer_id = c.customer_id AND fp.id = c.period_id
        WHERE c.community_id = $1
          AND pa.status <> 'deleted'
          AND p.status  <> 'deleted'
          -- ::date recorta el instante en la zona de la SESIÓN, que el pool fija
          -- a DB_TIMEZONE. En UTC, un pago de las 19:00 caería al día siguiente.
          AND p.paid_at::date >= $2::date
          AND p.paid_at::date <= $3::date
        GROUP BY f.id, f.concept, c.period_id, fp.label, fp.period_start
        -- Por concepto y, dentro de él, cronológico: multiplicado por periodo,
        -- un orden por monto dejaría los meses de una misma cuota salteados.
        -- Los sueltos (sin periodo) cierran su concepto.
        ORDER BY f.concept, fp.period_start NULLS LAST, fp.label NULLS LAST`,
      range,
    );

    // --- Movimientos manuales de caja, partidos por signo ---------------------
    const adjustments = await tx.query<AdjustmentTotalsRow>(
      `SELECT COALESCE(SUM(amount)  FILTER (WHERE amount > 0), 0)::text AS inflow,
              COALESCE(SUM(-amount) FILTER (WHERE amount < 0), 0)::text AS outflow
         FROM billing.fund_adjustments
        WHERE community_id = $1
          AND status <> 'deleted'
          AND adjusted_at >= $2::date
          AND adjusted_at <= $3::date`,
      range,
    );

    // --- Gastos ejercidos, por rubro -----------------------------------------
    const expenses = await tx.query<ExpenseCategoryTotalRow>(
      `SELECT ec.id AS category_id, ec.name, SUM(e.amount)::text AS amount
         FROM billing.expenses e
         JOIN billing.expense_categories ec
           ON ec.customer_id = e.customer_id AND ec.id = e.expense_category_id
        WHERE e.community_id = $1
          AND e.status <> 'deleted'
          AND e.expense_date >= $2::date
          AND e.expense_date <= $3::date
        GROUP BY ec.id, ec.name
        ORDER BY SUM(e.amount) DESC, ec.name`,
      range,
    );

    const incomeByFeePeriod: FeePeriodShare[] = income.rows.map((row) => ({
      feeId: row.fee_id,
      concept: row.concept,
      periodId: row.period_id,
      periodLabel: row.period_label,
      amount: money(row.amount),
    }));
    const expensesByCategory: CategoryAmount[] = expenses.rows.map((row) => ({
      categoryId: row.category_id,
      name: row.name,
      amount: money(row.amount),
    }));

    // Los totales se derivan de los MISMOS renglones que viajan: el desglose no
    // puede dejar de sumar su total porque no hay dos caminos que puedan
    // discrepar.
    const operationsIn = addMoney(...incomeByFeePeriod.map((row) => row.amount));
    const operationsOut = addMoney(...expensesByCategory.map((row) => row.amount));
    const adjustmentsRow = adjustments.rows[0];
    const adjustmentsIn = money(adjustmentsRow?.inflow);
    const adjustmentsOut = money(adjustmentsRow?.outflow);

    return {
      range: { from, to, timezone },
      income: {
        operations: operationsIn,
        adjustments: adjustmentsIn,
        total: addMoney(operationsIn, adjustmentsIn),
      },
      outflow: {
        operations: operationsOut,
        adjustments: adjustmentsOut,
        total: addMoney(operationsOut, adjustmentsOut),
      },
      incomeByFeePeriod,
      expensesByCategory,
    };
  },

  /**
   * Adeudo por unidad, paginado. Estado ACTUAL de la cartera (no admite corte
   * histórico — ver PER_UNIT_CTE). Los totales son los del filtro COMPLETO, no
   * los de la página: un pie de tabla que solo sumase la página mentiría en
   * cuanto hubiera una segunda.
   */
  async unitDebt(
    tx: TxClient,
    input: ListUnitDebtInput,
  ): Promise<{ items: UnitDebt[]; total: number; totals: UnitDebtTotals }> {
    const offset = (input.page - 1) * input.pageSize;
    const scope = [input.communityId, input.onlyDebtors];

    const totalsResult = await tx.query<UnitDebtTotalsRow>(
      `WITH ${CHARGE_STATE_CTE},
            ${PER_UNIT_CTE}
       SELECT count(*)::bigint                        AS count,
              COALESCE(SUM(p.charged), 0)::text       AS charged,
              COALESCE(SUM(p.paid), 0)::text          AS paid,
              COALESCE(SUM(p.waived), 0)::text        AS waived,
              COALESCE(SUM(p.balance), 0)::text       AS balance,
              COALESCE(SUM(p.overdue), 0)::text       AS overdue
       ${UNIT_DEBT_FROM}`,
      scope,
    );
    const totalsRow = totalsResult.rows[0];

    const itemsResult = await tx.query<UnitDebtRow>(
      `WITH ${CHARGE_STATE_CTE},
            ${PER_UNIT_CTE}
       SELECT u.id                                AS unit_id,
              u.code                              AS unit_code,
              COALESCE(p.charged, 0)::text        AS charged,
              COALESCE(p.paid, 0)::text           AS paid,
              COALESCE(p.waived, 0)::text         AS waived,
              COALESCE(p.balance, 0)::text        AS balance,
              COALESCE(p.overdue, 0)::text        AS overdue,
              p.oldest_due_date::text             AS oldest_due_date
       ${UNIT_DEBT_FROM}
        -- Quien más debe, primero: es el orden en el que se usa la lista.
        ORDER BY COALESCE(p.balance, 0) DESC, u.code
        LIMIT $3 OFFSET $4`,
      [...scope, input.pageSize, offset],
    );

    return {
      items: itemsResult.rows.map((row) => ({
        unitId: row.unit_id,
        unitCode: row.unit_code,
        charged: money(row.charged),
        paid: money(row.paid),
        waived: money(row.waived),
        balance: money(row.balance),
        overdue: money(row.overdue),
        oldestDueDate: row.oldest_due_date,
      })),
      total: Number(totalsRow?.count ?? 0),
      totals: {
        charged: money(totalsRow?.charged),
        paid: money(totalsRow?.paid),
        waived: money(totalsRow?.waived),
        balance: money(totalsRow?.balance),
        overdue: money(totalsRow?.overdue),
      },
    };
  },

  /**
   * Estado de cuenta de UNA unidad para [from, to]: cargos, pagos aplicados y
   * condonaciones intercalados en orden cronológico, cada uno con el saldo
   * deudor que dejó, más el saldo anterior al rango y los totales.
   *
   * Devuelve `null` si la unidad no existe en esa comunidad para el tenant (o
   * está borrada): fuera de alcance → 404, indistinguible de inexistente. La
   * unidad INACTIVA sí responde — dar de baja una unidad no borra su historia,
   * y su estado de cuenta es justo lo que alguien cerrando cuentas viene a
   * buscar (mismo criterio que resolveUnitAccess).
   *
   * TODO SALE DEL MISMO CTE (STATEMENT_ENTRIES_CTE): el saldo anterior es la
   * suma de lo previo a `from`, los totales la del rango, y el saldo corrido la
   * ventana sobre los renglones — así el invariante
   * `anterior + cargos − pagos − condonado = final` se cumple por construcción
   * y el saldo final reproduce el `balance` del adeudo por unidad.
   */
  async unitStatement(
    tx: TxClient,
    input: UnitStatementInput,
  ): Promise<UnitStatement | null> {
    const { communityId, unitId, from, to } = input;

    const unit = await selectStatementUnit(tx, communityId, unitId);
    if (unit === null) {
      return null;
    }

    const scope = [communityId, unitId, from, to];

    const totalsResult = await tx.query<StatementTotalsRow>(
      `WITH ${STATEMENT_ENTRIES_CTE}
       SELECT count(*) FILTER (WHERE moved_on >= $3::date AND moved_on <= $4::date)::bigint AS count,
              COALESCE(SUM(amount) FILTER (WHERE moved_on < $3::date), 0)::text AS opening,
              COALESCE(SUM(amount) FILTER (
                WHERE moved_on >= $3::date AND moved_on <= $4::date AND kind = 'charge'
              ), 0)::text AS charged,
              COALESCE(SUM(-amount) FILTER (
                WHERE moved_on >= $3::date AND moved_on <= $4::date AND kind = 'payment'
              ), 0)::text AS paid,
              COALESCE(SUM(-amount) FILTER (
                WHERE moved_on >= $3::date AND moved_on <= $4::date AND kind = 'waiver'
              ), 0)::text AS waived
         FROM entries`,
      scope,
    );
    const totalsRow = totalsResult.rows[0];
    const openingBalance = money(totalsRow?.opening);
    const charged = money(totalsRow?.charged);
    const paid = money(totalsRow?.paid);
    const waived = money(totalsRow?.waived);

    const itemsResult = await tx.query<StatementEntryRow>(
      `WITH ${STATEMENT_ENTRIES_CTE}
       SELECT e.id, e.kind, e.moved_on::text AS moved_on, e.concept, e.detail,
              e.method, e.reference, e.amount::text AS amount,
              -- Suma corrida en el MISMO orden en que se devuelven las filas;
              -- el saldo anterior se le suma en TS. La ventana se evalúa antes
              -- del LIMIT: paginar no la reinicia.
              SUM(e.amount) OVER (ORDER BY e.moved_on, e.created_at, e.id
                                  ROWS UNBOUNDED PRECEDING)::text AS running
         FROM entries e
        WHERE e.moved_on >= $3::date
          AND e.moved_on <= $4::date
        -- Cronológico ASCENDENTE: un estado de cuenta se lee del saldo
        -- anterior hacia abajo, igual que el libro de caja.
        ORDER BY e.moved_on, e.created_at, e.id
        LIMIT $5 OFFSET $6`,
      [...scope, input.pageSize, (input.page - 1) * input.pageSize],
    );

    return {
      unit: { id: unit.id, code: unit.code },
      items: itemsResult.rows.map((row) => ({
        id: row.id,
        kind: row.kind as StatementEntryKind,
        movedOn: row.moved_on,
        concept: row.concept,
        detail: row.detail,
        method: row.method,
        reference: row.reference,
        amount: money(row.amount),
        balance: addMoney(openingBalance, money(row.running)),
      })),
      total: Number(totalsRow?.count ?? 0),
      totals: {
        openingBalance,
        charged,
        paid,
        waived,
        closingBalance: addMoney(openingBalance, charged, -paid, -waived),
      },
    };
  },

  /**
   * Estado de cuenta V2 de UNA unidad para [from, to]: una fila por CARGO
   * devengado en el rango, con si ya está pagado, cuándo se pagó y de qué
   * periodo es.
   *
   * Es la consulta de cargos (charges_v1) acotada a una unidad y respondida
   * hasta el final: el ledger V1 dice que entró dinero un día, pero para saber
   * si la cuota de marzo quedó cubierta hay que ir casando renglones a mano.
   * Aquí cada cargo se cierra solo.
   *
   * NO hay saldo anterior ni saldo corrido, y no es una omisión: esta vista no
   * es un libro: no ordena movimientos en el tiempo, sino que audita cargos.
   * Un saldo corrido sobre filas que ya traen su propio saldo sumaría dos veces
   * lo mismo. Lo que sí cuadra es el pie: `cargos − pagado − condonado = saldo`.
   *
   * Devuelve `null` si la unidad no existe en esa comunidad (→ 404), igual que
   * la V1.
   */
  async unitChargeStatement(
    tx: TxClient,
    input: UnitStatementInput,
  ): Promise<UnitChargeStatement | null> {
    const { communityId, unitId, from, to } = input;

    const unit = await selectStatementUnit(tx, communityId, unitId);
    if (unit === null) {
      return null;
    }

    const scope = [communityId, unitId, from, to];

    // SIN WHERE, y a propósito: los saldos de corte necesitan los cargos de
    // FUERA del rango (el anterior mira lo devengado antes de `from`), así que
    // el recorte vive en los FILTER de cada agregado. Los dos invariantes salen
    // por construcción de que balance = applied − paid − waived:
    //   charged − paid − waived = balance   y   anterior + balance = final.
    const totalsResult = await tx.query<ChargeStatementTotalsRow>(
      `WITH ${CHARGE_STATEMENT_CTE}
       SELECT count(*) FILTER (WHERE ${IN_RANGE})::bigint    AS count,
              COALESCE(SUM(balance) FILTER (
                WHERE accrued_on < $3::date
              ), 0)::text                                    AS opening,
              COALESCE(SUM(applied_amount) FILTER (WHERE ${IN_RANGE}), 0)::text AS charged,
              COALESCE(SUM(paid)   FILTER (WHERE ${IN_RANGE}), 0)::text         AS paid,
              COALESCE(SUM(waived) FILTER (WHERE ${IN_RANGE}), 0)::text         AS waived,
              COALESCE(SUM(balance) FILTER (WHERE ${IN_RANGE}), 0)::text        AS balance,
              COALESCE(SUM(balance) FILTER (
                WHERE accrued_on <= $4::date
              ), 0)::text                                    AS closing,
              -- Vencido del saldo FINAL, no solo del rango: la tarjeta que lo
              -- califica es la del saldo final, y medirlo sobre otro conjunto
              -- haría que su nota hablara de otra cifra.
              COALESCE(SUM(balance) FILTER (
                WHERE accrued_on <= $4::date AND due_date < CURRENT_DATE AND balance > 0
              ), 0)::text                                    AS overdue,
              count(*) FILTER (WHERE ${IN_RANGE} AND balance <= 0)::bigint AS settled
         FROM unit_charges`,
      scope,
    );
    const totalsRow = totalsResult.rows[0];

    const itemsResult = await tx.query<ChargeStatementEntryRow>(
      `WITH ${CHARGE_STATEMENT_CTE}
       SELECT id, concept, period, period_start, period_end, note, quantity,
              accrued_on::text        AS accrued_on,
              due_date::text          AS due_date,
              applied_amount::text    AS applied_amount,
              paid::text              AS paid,
              waived::text            AS waived,
              balance::text           AS balance,
              payment_status,
              -- Derivado SIEMPRE en lectura (residguard_db §04), igual que en
              -- la consulta de cargos: vencido = pasó su fecha y sigue debiendo.
              (due_date < CURRENT_DATE AND balance > 0) AS overdue,
              last_paid_on::text      AS paid_on,
              payment_count::text     AS payment_count,
              last_waived_on::text    AS waived_on
         FROM unit_charges
        WHERE ${IN_RANGE}
        -- Cronológico ASCENDENTE por devengo, como la V1: el estado de cuenta
        -- se lee del cargo más viejo hacia abajo. created_at e id rompen el
        -- empate de dos cargos del mismo día (dos ventas sueltas).
        ORDER BY accrued_on, created_at, id
        LIMIT $5 OFFSET $6`,
      [...scope, input.pageSize, (input.page - 1) * input.pageSize],
    );

    return {
      unit,
      items: itemsResult.rows.map((row) => ({
        id: row.id,
        concept: row.concept,
        period: row.period,
        periodStart: row.period_start,
        periodEnd: row.period_end,
        note: row.note,
        quantity: Number(row.quantity),
        accruedOn: row.accrued_on,
        dueDate: row.due_date,
        appliedAmount: money(row.applied_amount),
        paid: money(row.paid),
        waived: money(row.waived),
        balance: money(row.balance),
        paymentStatus: row.payment_status,
        overdue: row.overdue,
        paidOn: row.paid_on,
        paymentCount: Number(row.payment_count),
        waivedOn: row.waived_on,
      })),
      total: Number(totalsRow?.count ?? 0),
      totals: {
        openingBalance: money(totalsRow?.opening),
        charged: money(totalsRow?.charged),
        paid: money(totalsRow?.paid),
        waived: money(totalsRow?.waived),
        balance: money(totalsRow?.balance),
        closingBalance: money(totalsRow?.closing),
        overdue: money(totalsRow?.overdue),
        settledCount: Number(totalsRow?.settled ?? 0),
      },
    };
  },

  /**
   * Los movimientos de dinero del rango, uno por renglón y en orden
   * cronológico: el mismo dinero que el resumen agrega, detallado.
   *
   * PAGOS, GASTOS y MOVIMIENTOS DE CAJA salen de las mismas tablas, con las
   * mismas reglas de atribución y el mismo recorte a día que `summary` — es lo
   * que hace que los totales de esta lista cuadren con el estado de caja. En
   * particular el ingreso se atribuye por `payment_allocations → charges`
   * (regla 1) y el lado caja NO filtra `charges.status` (regla 2).
   *
   * UN RENGLÓN POR DEPÓSITO, no por aplicación: el importe es lo que ese
   * depósito aplicó a cargos de ESTA comunidad, y sus conceptos y unidades
   * viajan agregados. Es la misma unidad que el usuario capturó y la misma que
   * lista la pantalla de Pagos.
   *
   * TRASPASOS solo con una caja concreta seleccionada (regla 5): a nivel
   * comunidad son suma cero y no mueven ningún saldo, así que serían renglones
   * que no explican nada. Con el filtro puesto sí mueven el saldo de ESA caja,
   * y sin ellos el saldo acumulado no cerraría.
   *
   * SALDO ACUMULADO: saldo inicial del alcance + la suma corrida en el orden de
   * la lista. Es el saldo DESPUÉS de ese movimiento, no una columna que sume
   * con las de arriba — filtrar u ordenar la tabla en el cliente no lo
   * recalcula, y no debe: sigue siendo el saldo que hubo en ese instante.
   */
  async movements(
    tx: TxClient,
    input: ListMovementsInput,
  ): Promise<{ items: Movement[]; total: number; totals: MovementTotals }> {
    const { communityId, from, to } = input;
    const filter = input.cashAccountId ?? null;
    // Solo una caja CONCRETA gasta parámetro: el centinela `none` es una
    // condición `IS NULL` y no lleva valor.
    const byAccount = filter !== null && filter !== CASH_ACCOUNT_NONE;
    const scope: unknown[] = byAccount ? [communityId, from, to, filter] : [communityId, from, to];
    const limitParam = byAccount ? "$5" : "$4";
    const offsetParam = byAccount ? "$6" : "$5";
    const offset = (input.page - 1) * input.pageSize;

    const balances = await scopeBalances(tx, communityId, from, to, filter);

    // Una fila por movimiento, ya signada: + entró, − salió.
    const movementsCte = `
      movements AS (
        SELECT p.id::text AS id, 'payment'::text AS kind, p.paid_at::date AS moved_on,
               SUM(pa.amount) AS amount, p.method::text AS method, p.reference,
               p.cash_account_id,
               string_agg(DISTINCT f.concept, ', ' ORDER BY f.concept) AS concept,
               string_agg(DISTINCT u.code, ', ' ORDER BY u.code)       AS detail,
               p.created_at
          FROM billing.payment_allocations pa
          JOIN billing.payments p ON p.customer_id = pa.customer_id AND p.id = pa.payment_id
          JOIN billing.charges  c ON c.customer_id = pa.customer_id AND c.id = pa.charge_id
          JOIN billing.fees     f ON f.customer_id = c.customer_id  AND f.id = c.fee_id
          JOIN community.units  u ON u.customer_id = pa.customer_id AND u.id = pa.unit_id
         WHERE c.community_id = $1
           AND pa.status <> 'deleted'
           AND p.status  <> 'deleted'
           -- ::date en la zona de la SESIÓN (DB_TIMEZONE), igual que summary.
           AND p.paid_at::date >= $2::date
           AND p.paid_at::date <= $3::date${cashAccountFilterSql("p.cash_account_id", filter, "$4")}
         GROUP BY p.id, p.paid_at, p.method, p.reference, p.cash_account_id, p.created_at

        UNION ALL

        SELECT e.id::text, 'expense'::text, e.expense_date,
               -e.amount, e.method::text, e.reference,
               e.cash_account_id,
               e.concept,
               -- Rubro y proveedor: el contexto que un gasto tiene y que su
               -- concepto no repite.
               NULLIF(concat_ws(' · ', ec.name, e.vendor_name), '') AS detail,
               e.created_at
          FROM billing.expenses e
          JOIN billing.expense_categories ec
            ON ec.customer_id = e.customer_id AND ec.id = e.expense_category_id
         WHERE e.community_id = $1
           AND e.status <> 'deleted'
           AND e.expense_date >= $2::date
           AND e.expense_date <= $3::date${cashAccountFilterSql("e.cash_account_id", filter, "$4")}

        UNION ALL

        -- El ajuste ya viene signado en la tabla: se copia tal cual.
        SELECT fa.id::text, 'adjustment'::text, fa.adjusted_at,
               fa.amount, fa.method::text, NULL::text,
               fa.cash_account_id,
               fa.reason, NULL::text,
               fa.created_at
          FROM billing.fund_adjustments fa
         WHERE fa.community_id = $1
           AND fa.status <> 'deleted'
           AND fa.adjusted_at >= $2::date
           AND fa.adjusted_at <= $3::date${cashAccountFilterSql("fa.cash_account_id", filter, "$4")}
        ${
          byAccount
            ? `
        UNION ALL

        -- Traspasos: solo con una caja seleccionada, y con el signo del lado
        -- que se está mirando. La caja del renglón es esa misma, no la otra.
        SELECT t.id::text, 'transfer'::text, t.transferred_at,
               CASE WHEN t.to_cash_account_id = $4::uuid THEN t.amount ELSE -t.amount END,
               NULL::text, NULL::text,
               $4::uuid,
               t.reason,
               concat('De ', fca.name, ' a ', tca.name),
               t.created_at
          FROM billing.cash_account_transfers t
          JOIN billing.cash_accounts fca
            ON fca.customer_id = t.customer_id AND fca.id = t.from_cash_account_id
          JOIN billing.cash_accounts tca
            ON tca.customer_id = t.customer_id AND tca.id = t.to_cash_account_id
         WHERE t.community_id = $1
           AND t.status <> 'deleted'
           AND t.transferred_at >= $2::date
           AND t.transferred_at <= $3::date
           AND (t.from_cash_account_id = $4::uuid OR t.to_cash_account_id = $4::uuid)`
            : ""
        }
      )
    `;

    const totalsResult = await tx.query<MovementTotalsRow>(
      `WITH ${movementsCte}
       SELECT count(*)::bigint                                            AS count,
              COALESCE(SUM(amount)  FILTER (WHERE amount > 0), 0)::text   AS income,
              COALESCE(SUM(-amount) FILTER (WHERE amount < 0), 0)::text   AS outflow
         FROM movements`,
      scope,
    );
    const totalsRow = totalsResult.rows[0];

    const itemsResult = await tx.query<MovementRow>(
      `WITH ${movementsCte}
       SELECT m.id, m.kind, m.moved_on::text AS moved_on, m.amount::text AS amount,
              m.method, m.reference, m.concept, m.detail,
              m.cash_account_id, ca.name AS cash_account_name,
              -- Suma corrida en el MISMO orden en que se devuelven las filas;
              -- el saldo inicial se le suma en TS (así no gasta un parámetro).
              -- La ventana se evalúa antes del LIMIT: paginar no la reinicia.
              SUM(m.amount) OVER (ORDER BY m.moved_on, m.created_at, m.id
                                  ROWS UNBOUNDED PRECEDING)::text AS running
         FROM movements m
         -- Sin customer_id en el CTE: la RLS ya acota el tenant y el id es la PK.
         LEFT JOIN billing.cash_accounts ca ON ca.id = m.cash_account_id
        -- Cronológico ASCENDENTE: un libro de caja se lee del saldo inicial
        -- hacia abajo, y es el orden que hace legible el saldo acumulado.
        ORDER BY m.moved_on, m.created_at, m.id
        LIMIT ${limitParam} OFFSET ${offsetParam}`,
      [...scope, input.pageSize, offset],
    );

    return {
      items: itemsResult.rows.map((row) => ({
        id: row.id,
        kind: row.kind as MovementKind,
        movedOn: row.moved_on,
        concept: row.concept ?? "",
        detail: row.detail,
        method: row.method,
        reference: row.reference,
        cashAccount:
          row.cash_account_id !== null && row.cash_account_name !== null
            ? { id: row.cash_account_id, name: row.cash_account_name }
            : null,
        amount: money(row.amount),
        balance: addMoney(balances.opening, money(row.running)),
      })),
      total: Number(totalsRow?.count ?? 0),
      totals: {
        income: money(totalsRow?.income),
        outflow: money(totalsRow?.outflow),
        openingBalance: balances.opening,
        closingBalance: balances.closing,
      },
    };
  },
};
