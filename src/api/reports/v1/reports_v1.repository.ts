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
