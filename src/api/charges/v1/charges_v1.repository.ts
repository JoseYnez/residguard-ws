import type { TxClient } from "../../../core/db/with_transaction";

// Acceso a datos del recurso charges (solo lectura). El saldo se calcula en
// la misma consulta con las aplicaciones/condonaciones activas (mismo
// criterio que billing.fn_get_charge_balance, pero en set para no llamar a
// la función por fila). `overdue` es SIEMPRE derivado (residguard_db 04).

export interface Charge {
  readonly id: string;
  readonly unitId: string;
  readonly communityId: string;
  readonly feeId: string;
  readonly concept: string;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly appliedAmount: number;
  readonly balance: number;
  readonly dueDate: string;
  readonly paymentStatus: string;
  readonly overdue: boolean;
  readonly status: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ListChargesInput {
  readonly unitId: string;
  readonly page: number;
  readonly pageSize: number;
  readonly paymentStatus?: string | null;
  readonly overdueOnly?: boolean | null;
  readonly from?: string | null;
  readonly to?: string | null;
}

interface ChargeRow {
  id: string;
  unit_id: string;
  community_id: string;
  fee_id: string;
  concept: string;
  period_start: string;
  period_end: string;
  applied_amount: string;
  balance: string;
  due_date: string;
  payment_status: string;
  overdue: boolean;
  status: string;
  created_at: Date;
  updated_at: Date;
}

function mapRow(row: ChargeRow): Charge {
  return {
    id: row.id,
    unitId: row.unit_id,
    communityId: row.community_id,
    feeId: row.fee_id,
    concept: row.concept,
    periodStart: row.period_start,
    periodEnd: row.period_end,
    appliedAmount: Number(row.applied_amount),
    balance: Number(row.balance),
    dueDate: row.due_date,
    paymentStatus: row.payment_status,
    overdue: row.overdue,
    status: row.status,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

/** Cargos con saldo: aplicaciones y condonaciones activas agregadas por cargo. */
const FROM_WITH_BALANCE = `
  FROM billing.charges c
  JOIN billing.fees f
    ON f.customer_id = c.customer_id AND f.id = c.fee_id
  LEFT JOIN LATERAL (
    SELECT COALESCE((SELECT SUM(pa.amount) FROM billing.payment_allocations pa
                      WHERE pa.charge_id = c.id AND pa.status <> 'deleted'), 0)
         + COALESCE((SELECT SUM(w.waived_amount) FROM billing.waivers w
                      WHERE w.charge_id = c.id AND w.status <> 'deleted'), 0) AS covered
  ) cov ON true
`;

export const chargesRepository = {
  /** Cargos de la unidad (paginado), con saldo y `overdue` derivados. */
  async list(tx: TxClient, input: ListChargesInput): Promise<{ items: Charge[]; total: number }> {
    const paymentStatus = input.paymentStatus ?? null;
    const overdueOnly = input.overdueOnly === true;
    const from = input.from ?? null;
    const to = input.to ?? null;
    const offset = (input.page - 1) * input.pageSize;

    const where = `
      WHERE c.unit_id = $1
        AND c.status != 'deleted'
        AND ($2::billing.charge_status IS NULL OR c.payment_status = $2::billing.charge_status)
        AND ($3::boolean IS NOT TRUE
             OR (c.due_date < CURRENT_DATE AND cov.covered < c.applied_amount))
        AND ($4::date IS NULL OR c.due_date >= $4::date)
        AND ($5::date IS NULL OR c.due_date <= $5::date)
    `;

    const totalResult = await tx.query<{ count: string }>(
      `SELECT count(*)::bigint AS count ${FROM_WITH_BALANCE} ${where}`,
      [input.unitId, paymentStatus, overdueOnly, from, to],
    );
    const total = Number(totalResult.rows[0]?.count ?? 0);

    const itemsResult = await tx.query<ChargeRow>(
      `SELECT c.id, c.unit_id, c.community_id, c.fee_id, f.concept,
              c.period_start::text AS period_start, c.period_end::text AS period_end,
              c.applied_amount::text AS applied_amount,
              (c.applied_amount - cov.covered)::text AS balance,
              c.due_date::text AS due_date, c.payment_status,
              (c.due_date < CURRENT_DATE AND cov.covered < c.applied_amount) AS overdue,
              c.status, c.created_at, c.updated_at
         ${FROM_WITH_BALANCE} ${where}
        ORDER BY c.due_date DESC, c.id DESC
        LIMIT $6 OFFSET $7`,
      [input.unitId, paymentStatus, overdueOnly, from, to, input.pageSize, offset],
    );

    return { items: itemsResult.rows.map(mapRow), total };
  },
};
