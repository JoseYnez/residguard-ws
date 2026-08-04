import type { TxClient } from "../../../core/db/with_transaction";

// Acceso a datos del recurso fund-adjustments (billing.fund_adjustments).
// Acotado a una comunidad ya autorizada; RLS filtra el tenant. El saldo de la
// comunidad NUNCA se almacena: lo deriva billing.fn_get_community_balance.

/** Caja resuelta (id + nombre) para que el cliente no cruce catálogos. */
export interface FundAdjustmentCashAccountRef {
  readonly id: string;
  readonly name: string;
}

export interface FundAdjustment {
  readonly id: string;
  readonly communityId: string;
  readonly amount: number;
  readonly reason: string;
  readonly adjustedAt: string;
  /** Por dónde se movió el dinero (`billing.payment_method`). */
  readonly method: string;
  readonly authorizedBy: string | null;
  readonly cashAccount: FundAdjustmentCashAccountRef | null;
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
  readonly cashAccountId?: string | null;
}

export interface UpdateFundAdjustmentInput {
  readonly amount?: number;
  readonly reason?: string;
  readonly adjustedAt?: string;
  readonly method?: string;
  readonly authorizedBy?: string | null;
  readonly cashAccountId?: string | null;
}

export interface ListFundAdjustmentsInput {
  readonly communityId: string;
  readonly page: number;
  readonly pageSize: number;
  readonly from?: string | null;
  readonly to?: string | null;
  readonly method?: string | null;
  readonly cashAccountId?: string | null;
  readonly search?: string | null;
}

const SELECT_COLUMNS = `
  fa.id, fa.community_id, fa.amount::text AS amount, fa.reason,
  fa.adjusted_at::text AS adjusted_at, fa.method, fa.authorized_by,
  ca.id AS cash_account_id, ca.name AS cash_account_name,
  fa.status, fa.created_at, fa.updated_at
`;

// LEFT JOIN a la caja: el movimiento histórico no la declara.
const FROM_JOINED = `
  FROM billing.fund_adjustments fa
  LEFT JOIN billing.cash_accounts ca
    ON ca.customer_id = fa.customer_id AND ca.id = fa.cash_account_id
`;

interface FundAdjustmentRow {
  id: string;
  community_id: string;
  amount: string;
  reason: string;
  adjusted_at: string;
  method: string;
  authorized_by: string | null;
  cash_account_id: string | null;
  cash_account_name: string | null;
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
    cashAccount:
      row.cash_account_id !== null && row.cash_account_name !== null
        ? { id: row.cash_account_id, name: row.cash_account_name }
        : null,
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
    const cashAccountId = input.cashAccountId ?? null;
    const offset = (input.page - 1) * input.pageSize;

    const where = `
      WHERE fa.community_id = $1
        AND fa.status != 'deleted'
        AND ($2::date IS NULL OR fa.adjusted_at >= $2::date)
        AND ($3::date IS NULL OR fa.adjusted_at <= $3::date)
        AND ($4::text IS NULL OR fa.reason ILIKE '%' || $4 || '%')
        AND ($5::billing.payment_method IS NULL OR fa.method = $5::billing.payment_method)
        AND ($6::uuid IS NULL OR fa.cash_account_id = $6::uuid)
    `;

    const totalResult = await tx.query<{ count: string }>(
      `SELECT count(*)::bigint AS count FROM billing.fund_adjustments fa ${where}`,
      [input.communityId, from, to, search, method, cashAccountId],
    );
    const total = Number(totalResult.rows[0]?.count ?? 0);

    const itemsResult = await tx.query<FundAdjustmentRow>(
      `SELECT ${SELECT_COLUMNS} ${FROM_JOINED} ${where}
        ORDER BY fa.adjusted_at DESC, fa.id DESC
        LIMIT $7 OFFSET $8`,
      [input.communityId, from, to, search, method, cashAccountId, input.pageSize, offset],
    );

    return { items: itemsResult.rows.map(mapRow), total };
  },

  async getById(tx: TxClient, communityId: string, id: string): Promise<FundAdjustment | null> {
    const result = await tx.query<FundAdjustmentRow>(
      `SELECT ${SELECT_COLUMNS} ${FROM_JOINED}
        WHERE fa.id = $1 AND fa.community_id = $2 AND fa.status != 'deleted'`,
      [id, communityId],
    );
    const row = result.rows[0];
    return row === undefined ? null : mapRow(row);
  },

  /**
   * ¿Es la caja ACTIVA y de esta comunidad? La FK compuesta
   * (customer_id, community_id, cash_account_id) ya impide usar una caja de
   * otra comunidad, pero no mira `status`: sin esta comprobación se podrían
   * registrar movimientos contra una caja retirada del catálogo.
   */
  async activeCashAccountExists(
    tx: TxClient,
    communityId: string,
    cashAccountId: string,
  ): Promise<boolean> {
    const result = await tx.query(
      `SELECT 1 FROM billing.cash_accounts
        WHERE id = $1 AND community_id = $2 AND status = 'active'`,
      [cashAccountId, communityId],
    );
    return (result.rowCount ?? 0) > 0;
  },

  /** Inserta un movimiento. Puede lanzar 23514 (amount = 0) o 23503 (caja de
   *  otra comunidad, por la FK compuesta). */
  async create(
    tx: TxClient,
    customerId: string,
    communityId: string,
    input: CreateFundAdjustmentInput,
  ): Promise<FundAdjustment> {
    const inserted = await tx.query<{ id: string }>(
      `INSERT INTO billing.fund_adjustments
         (customer_id, community_id, amount, reason, adjusted_at, method, authorized_by,
          cash_account_id)
       VALUES ($1, $2, $3, $4, COALESCE($5::date, CURRENT_DATE), $6::billing.payment_method, $7,
               $8)
       RETURNING id`,
      [
        customerId,
        communityId,
        input.amount,
        input.reason,
        input.adjustedAt ?? null,
        input.method,
        input.authorizedBy ?? null,
        input.cashAccountId ?? null,
      ],
    );
    const created = await this.getById(tx, communityId, inserted.rows[0]!.id);
    return created!;
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
    if (input.cashAccountId !== undefined) push("cash_account_id", input.cashAccountId, "::uuid");

    if (sets.length === 0) {
      return this.getById(tx, communityId, id);
    }

    params.push(id, communityId);
    const result = await tx.query<{ id: string }>(
      `UPDATE billing.fund_adjustments SET ${sets.join(", ")}
        WHERE id = $${i} AND community_id = $${i + 1} AND status != 'deleted'
        RETURNING id`,
      params,
    );
    if (result.rows[0] === undefined) {
      return null;
    }
    return this.getById(tx, communityId, id);
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
