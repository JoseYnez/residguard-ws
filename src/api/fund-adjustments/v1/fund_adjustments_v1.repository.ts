import type { TxClient } from "../../../core/db/with_transaction";

// Acceso a datos del recurso fund-adjustments (billing.fund_adjustments).
// Acotado a una comunidad ya autorizada; RLS filtra el tenant. El saldo de la
// comunidad NUNCA se almacena: lo deriva billing.fn_get_community_balance.

export interface FundAdjustment {
  readonly id: string;
  readonly communityId: string;
  readonly amount: number;
  readonly reason: string;
  readonly adjustedAt: string;
  /** Por dónde se movió el dinero (`billing.payment_method`). */
  readonly method: string;
  readonly authorizedBy: string | null;
  readonly status: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateFundAdjustmentInput {
  readonly amount: number;
  readonly reason: string;
  readonly adjustedAt?: string | null;
  readonly method: string;
  readonly authorizedBy?: string | null;
}

export interface UpdateFundAdjustmentInput {
  readonly amount?: number;
  readonly reason?: string;
  readonly adjustedAt?: string;
  readonly method?: string;
  readonly authorizedBy?: string | null;
}

export interface ListFundAdjustmentsInput {
  readonly communityId: string;
  readonly page: number;
  readonly pageSize: number;
  readonly from?: string | null;
  readonly to?: string | null;
  readonly method?: string | null;
  readonly search?: string | null;
}

const SELECT_COLUMNS = `
  id, community_id, amount::text AS amount, reason, adjusted_at::text AS adjusted_at,
  method, authorized_by, status, created_at, updated_at
`;

interface FundAdjustmentRow {
  id: string;
  community_id: string;
  amount: string;
  reason: string;
  adjusted_at: string;
  method: string;
  authorized_by: string | null;
  status: string;
  created_at: Date;
  updated_at: Date;
}

function mapRow(row: FundAdjustmentRow): FundAdjustment {
  return {
    id: row.id,
    communityId: row.community_id,
    amount: Number(row.amount),
    reason: row.reason,
    adjustedAt: row.adjusted_at,
    method: row.method,
    authorizedBy: row.authorized_by,
    status: row.status,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export const fundAdjustmentsRepository = {
  async list(
    tx: TxClient,
    input: ListFundAdjustmentsInput,
  ): Promise<{ items: FundAdjustment[]; total: number }> {
    const from = input.from ?? null;
    const to = input.to ?? null;
    const search = input.search ?? null;
    const method = input.method ?? null;
    const offset = (input.page - 1) * input.pageSize;

    const where = `
      WHERE community_id = $1
        AND status != 'deleted'
        AND ($2::date IS NULL OR adjusted_at >= $2::date)
        AND ($3::date IS NULL OR adjusted_at <= $3::date)
        AND ($4::text IS NULL OR reason ILIKE '%' || $4 || '%')
        AND ($5::billing.payment_method IS NULL OR method = $5::billing.payment_method)
    `;

    const totalResult = await tx.query<{ count: string }>(
      `SELECT count(*)::bigint AS count FROM billing.fund_adjustments ${where}`,
      [input.communityId, from, to, search, method],
    );
    const total = Number(totalResult.rows[0]?.count ?? 0);

    const itemsResult = await tx.query<FundAdjustmentRow>(
      `SELECT ${SELECT_COLUMNS} FROM billing.fund_adjustments ${where}
        ORDER BY adjusted_at DESC, id DESC
        LIMIT $6 OFFSET $7`,
      [input.communityId, from, to, search, method, input.pageSize, offset],
    );

    return { items: itemsResult.rows.map(mapRow), total };
  },

  async getById(tx: TxClient, communityId: string, id: string): Promise<FundAdjustment | null> {
    const result = await tx.query<FundAdjustmentRow>(
      `SELECT ${SELECT_COLUMNS} FROM billing.fund_adjustments
        WHERE id = $1 AND community_id = $2 AND status != 'deleted'`,
      [id, communityId],
    );
    const row = result.rows[0];
    return row === undefined ? null : mapRow(row);
  },

  /** Inserta un movimiento. Puede lanzar 23514 (amount = 0). */
  async create(
    tx: TxClient,
    customerId: string,
    communityId: string,
    input: CreateFundAdjustmentInput,
  ): Promise<FundAdjustment> {
    const result = await tx.query<FundAdjustmentRow>(
      `INSERT INTO billing.fund_adjustments
         (customer_id, community_id, amount, reason, adjusted_at, method, authorized_by)
       VALUES ($1, $2, $3, $4, COALESCE($5::date, CURRENT_DATE), $6::billing.payment_method, $7)
       RETURNING ${SELECT_COLUMNS}`,
      [
        customerId,
        communityId,
        input.amount,
        input.reason,
        input.adjustedAt ?? null,
        input.method,
        input.authorizedBy ?? null,
      ],
    );
    return mapRow(result.rows[0]!);
  },

  /** Actualización parcial. Devuelve null si no existe (o está 'deleted'). */
  async update(
    tx: TxClient,
    communityId: string,
    id: string,
    input: UpdateFundAdjustmentInput,
  ): Promise<FundAdjustment | null> {
    const sets: string[] = [];
    const params: unknown[] = [];
    let i = 1;

    const push = (column: string, value: unknown, cast = ""): void => {
      sets.push(`${column} = $${i}${cast}`);
      params.push(value);
      i += 1;
    };

    if (input.amount !== undefined) push("amount", input.amount);
    if (input.reason !== undefined) push("reason", input.reason);
    if (input.adjustedAt !== undefined) push("adjusted_at", input.adjustedAt, "::date");
    if (input.method !== undefined) push("method", input.method, "::billing.payment_method");
    if (input.authorizedBy !== undefined) push("authorized_by", input.authorizedBy, "::uuid");

    if (sets.length === 0) {
      return this.getById(tx, communityId, id);
    }

    params.push(id, communityId);
    const result = await tx.query<FundAdjustmentRow>(
      `UPDATE billing.fund_adjustments SET ${sets.join(", ")}
        WHERE id = $${i} AND community_id = $${i + 1} AND status != 'deleted'
        RETURNING ${SELECT_COLUMNS}`,
      params,
    );
    const row = result.rows[0];
    return row === undefined ? null : mapRow(row);
  },

  async softDelete(tx: TxClient, communityId: string, id: string): Promise<boolean> {
    const result = await tx.query(
      `UPDATE billing.fund_adjustments SET status = 'deleted'
        WHERE id = $1 AND community_id = $2 AND status != 'deleted'`,
      [id, communityId],
    );
    return (result.rowCount ?? 0) > 0;
  },
};
