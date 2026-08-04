import type { TxClient } from "../../../core/db/with_transaction";

// Acceso a datos del recurso cash-transfers (billing.cash_account_transfers).
// Acotado a una comunidad ya autorizada; RLS filtra el tenant. Las FKs
// compuestas (customer_id, community_id, *_cash_account_id) → billing.cash_accounts
// ya garantizan que ambas cajas sean del mismo tenant Y de la misma comunidad.
// Suma cero: el traspaso nunca entra en fn_get_community_balance; solo mueve
// saldo entre cajas (fn_get_cash_account_balance lo suma en el destino y lo
// resta en el origen).

export interface CashAccountRef {
  readonly id: string;
  readonly name: string;
}

export interface CashTransfer {
  readonly id: string;
  readonly communityId: string;
  readonly fromCashAccountId: string;
  readonly toCashAccountId: string;
  /** Nombres resueltos por JOIN, para que la SPA pinte sin otra petición. */
  readonly fromCashAccount: CashAccountRef;
  readonly toCashAccount: CashAccountRef;
  readonly amount: number;
  readonly transferredAt: string;
  readonly reason: string;
  readonly authorizedBy: string | null;
  readonly status: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateCashTransferInput {
  readonly fromCashAccountId: string;
  readonly toCashAccountId: string;
  readonly amount: number;
  readonly transferredAt?: string | null;
  readonly reason: string;
  readonly authorizedBy?: string | null;
}

export interface UpdateCashTransferInput {
  readonly fromCashAccountId?: string;
  readonly toCashAccountId?: string;
  readonly amount?: number;
  readonly transferredAt?: string;
  readonly reason?: string;
  readonly authorizedBy?: string | null;
}

export interface ListCashTransfersInput {
  readonly communityId: string;
  readonly page: number;
  readonly pageSize: number;
  readonly from?: string | null;
  readonly to?: string | null;
  /** Traspasos donde esa caja sea origen O destino. */
  readonly cashAccountId?: string | null;
}

const SELECT_COLUMNS = `
  t.id, t.community_id, t.from_cash_account_id, t.to_cash_account_id,
  fca.name AS from_cash_account_name, tca.name AS to_cash_account_name,
  t.amount::text AS amount, t.transferred_at::text AS transferred_at,
  t.reason, t.authorized_by, t.status, t.created_at, t.updated_at
`;

// INNER a propósito: ambas FKs son NOT NULL y la baja de cajas es lógica
// (la fila sobrevive con status='deleted'), así que el JOIN siempre resuelve.
const FROM_JOINED = `
  FROM billing.cash_account_transfers t
  JOIN billing.cash_accounts fca
    ON fca.customer_id = t.customer_id AND fca.id = t.from_cash_account_id
  JOIN billing.cash_accounts tca
    ON tca.customer_id = t.customer_id AND tca.id = t.to_cash_account_id
`;

interface CashTransferRow {
  id: string;
  community_id: string;
  from_cash_account_id: string;
  to_cash_account_id: string;
  from_cash_account_name: string;
  to_cash_account_name: string;
  amount: string;
  transferred_at: string;
  reason: string;
  authorized_by: string | null;
  status: string;
  created_at: Date;
  updated_at: Date;
}

function mapRow(row: CashTransferRow): CashTransfer {
  return {
    id: row.id,
    communityId: row.community_id,
    fromCashAccountId: row.from_cash_account_id,
    toCashAccountId: row.to_cash_account_id,
    fromCashAccount: { id: row.from_cash_account_id, name: row.from_cash_account_name },
    toCashAccount: { id: row.to_cash_account_id, name: row.to_cash_account_name },
    amount: Number(row.amount),
    transferredAt: row.transferred_at,
    reason: row.reason,
    authorizedBy: row.authorized_by,
    status: row.status,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export const cashTransfersRepository = {
  async list(
    tx: TxClient,
    input: ListCashTransfersInput,
  ): Promise<{ items: CashTransfer[]; total: number }> {
    const from = input.from ?? null;
    const to = input.to ?? null;
    const cashAccountId = input.cashAccountId ?? null;
    const offset = (input.page - 1) * input.pageSize;

    const where = `
      WHERE t.community_id = $1
        AND t.status != 'deleted'
        AND ($2::date IS NULL OR t.transferred_at >= $2::date)
        AND ($3::date IS NULL OR t.transferred_at <= $3::date)
        AND ( $4::uuid IS NULL
           OR t.from_cash_account_id = $4::uuid
           OR t.to_cash_account_id = $4::uuid )
    `;

    const totalResult = await tx.query<{ count: string }>(
      `SELECT count(*)::bigint AS count FROM billing.cash_account_transfers t ${where}`,
      [input.communityId, from, to, cashAccountId],
    );
    const total = Number(totalResult.rows[0]?.count ?? 0);

    const itemsResult = await tx.query<CashTransferRow>(
      `SELECT ${SELECT_COLUMNS} ${FROM_JOINED} ${where}
        ORDER BY t.transferred_at DESC, t.id DESC
        LIMIT $5 OFFSET $6`,
      [input.communityId, from, to, cashAccountId, input.pageSize, offset],
    );

    return { items: itemsResult.rows.map(mapRow), total };
  },

  async getById(tx: TxClient, communityId: string, id: string): Promise<CashTransfer | null> {
    const result = await tx.query<CashTransferRow>(
      `SELECT ${SELECT_COLUMNS} ${FROM_JOINED}
        WHERE t.id = $1 AND t.community_id = $2 AND t.status != 'deleted'`,
      [id, communityId],
    );
    const row = result.rows[0];
    return row === undefined ? null : mapRow(row);
  },

  /** Ids de cajas ACTIVAS de la comunidad entre las pedidas (para que el
   *  controller valide origen/destino antes de escribir). */
  async findActiveCashAccountIds(
    tx: TxClient,
    communityId: string,
    ids: readonly string[],
  ): Promise<Set<string>> {
    const result = await tx.query<{ id: string }>(
      `SELECT id FROM billing.cash_accounts
        WHERE community_id = $1 AND status = 'active' AND id = ANY($2::uuid[])`,
      [communityId, [...ids]],
    );
    return new Set(result.rows.map((row) => row.id));
  },

  /** Inserta un traspaso. Puede lanzar 23514 (amount ≤ 0 o cajas iguales) o
   *  23503 (caja de otra comunidad/tenant, por las FKs compuestas). */
  async create(
    tx: TxClient,
    customerId: string,
    communityId: string,
    input: CreateCashTransferInput,
  ): Promise<CashTransfer> {
    const inserted = await tx.query<{ id: string }>(
      `INSERT INTO billing.cash_account_transfers
         (customer_id, community_id, from_cash_account_id, to_cash_account_id,
          amount, transferred_at, reason, authorized_by)
       VALUES ($1, $2, $3, $4, $5, COALESCE($6::date, CURRENT_DATE), $7, $8)
       RETURNING id`,
      [
        customerId,
        communityId,
        input.fromCashAccountId,
        input.toCashAccountId,
        input.amount,
        input.transferredAt ?? null,
        input.reason,
        input.authorizedBy ?? null,
      ],
    );
    // El RETURNING no puede resolver el JOIN a las cajas: relectura en la
    // misma transacción (la fila recién insertada es visible aquí).
    const transfer = await this.getById(tx, communityId, inserted.rows[0]!.id);
    return transfer!;
  },

  /** Actualización parcial. Devuelve null si no existe (o está 'deleted'). */
  async update(
    tx: TxClient,
    communityId: string,
    id: string,
    input: UpdateCashTransferInput,
  ): Promise<CashTransfer | null> {
    const sets: string[] = [];
    const params: unknown[] = [];
    let i = 1;

    const push = (column: string, value: unknown, cast = ""): void => {
      sets.push(`${column} = $${i}${cast}`);
      params.push(value);
      i += 1;
    };

    if (input.fromCashAccountId !== undefined)
      push("from_cash_account_id", input.fromCashAccountId, "::uuid");
    if (input.toCashAccountId !== undefined)
      push("to_cash_account_id", input.toCashAccountId, "::uuid");
    if (input.amount !== undefined) push("amount", input.amount);
    if (input.transferredAt !== undefined) push("transferred_at", input.transferredAt, "::date");
    if (input.reason !== undefined) push("reason", input.reason);
    if (input.authorizedBy !== undefined) push("authorized_by", input.authorizedBy, "::uuid");

    if (sets.length === 0) {
      return this.getById(tx, communityId, id);
    }

    params.push(id, communityId);
    const result = await tx.query<{ id: string }>(
      `UPDATE billing.cash_account_transfers SET ${sets.join(", ")}
        WHERE id = $${i} AND community_id = $${i + 1} AND status != 'deleted'
        RETURNING id`,
      params,
    );
    if (result.rows[0] === undefined) {
      return null;
    }
    // Relectura para resolver los nombres de caja (posiblemente recién cambiados).
    return this.getById(tx, communityId, id);
  },

  async softDelete(tx: TxClient, communityId: string, id: string): Promise<boolean> {
    const result = await tx.query(
      `UPDATE billing.cash_account_transfers SET status = 'deleted'
        WHERE id = $1 AND community_id = $2 AND status != 'deleted'`,
      [id, communityId],
    );
    return (result.rowCount ?? 0) > 0;
  },
};
