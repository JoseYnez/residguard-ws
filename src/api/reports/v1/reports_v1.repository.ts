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

export interface ReportSummary {
  readonly range: { readonly from: string; readonly to: string; readonly timezone: string };
  readonly cash: {
    readonly openingBalance: number;
    readonly income: CashFlowSide;
    readonly outflow: CashFlowSide;
    readonly closingBalance: number;
  };
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
  amount: string;
}

interface AdjustmentsRow {
  inflow: string;
  outflow: string;
}

interface ExpenseCategoryRow {
  category_id: string;
  name: string;
  amount: string;
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

    // --- Ingresos por cuotas, desglosados por cuota y por método --------------
    // Una sola consulta alimenta tres cifras (total, por cuota, por método):
    // pedirlas por separado abre la puerta a que no sumen lo mismo.
    const income = await tx.query<IncomeRow>(
      `SELECT f.id AS fee_id, f.concept, p.method::text AS method, SUM(pa.amount)::text AS amount
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
        GROUP BY f.id, f.concept, p.method`,
      range,
    );

    // --- Movimientos manuales de caja, partidos por signo ---------------------
    const adjustments = await tx.query<AdjustmentsRow>(
      `SELECT COALESCE(SUM(amount)  FILTER (WHERE amount > 0), 0)::text AS inflow,
              COALESCE(SUM(-amount) FILTER (WHERE amount < 0), 0)::text AS outflow
         FROM billing.fund_adjustments
        WHERE community_id = $1
          AND status <> 'deleted'
          AND adjusted_at >= $2::date
          AND adjusted_at <= $3::date`,
      range,
    );

    // --- Gastos ejercidos, por rubro ------------------------------------------
    const expenses = await tx.query<ExpenseCategoryRow>(
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

    const incomeByFeeMap = new Map<string, { concept: string; amount: number }>();
    const incomeByMethodMap = new Map<string, number>();
    for (const row of income.rows) {
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
    const incomeFromCharges = addMoney(
      ...[...incomeByFeeMap.values()].map((fee) => fee.amount),
    );

    const adjustmentsRow = adjustments.rows[0];
    const adjustmentsIn = money(adjustmentsRow?.inflow);
    const adjustmentsOut = money(adjustmentsRow?.outflow);

    const expensesTotal = addMoney(...expenses.rows.map((row) => money(row.amount)));

    const incomeTotal = addMoney(incomeFromCharges, adjustmentsIn);
    const outflowTotal = addMoney(expensesTotal, adjustmentsOut);

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
        openingBalance: money(balanceRow.opening),
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
        closingBalance: money(balanceRow.closing),
      },
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
      expensesByCategory: expenses.rows.map((row) => ({
        categoryId: row.category_id,
        name: row.name,
        amount: money(row.amount),
        share: shareOf(money(row.amount), expensesTotal),
      })),
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
};
