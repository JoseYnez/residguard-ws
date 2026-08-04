import type { TxClient } from "../../../core/db/with_transaction";

// Acceso a datos del recurso cash-accounts (billing.cash_accounts).
// Acotado a una comunidad ya autorizada; RLS filtra el tenant. Sin DELETE
// físico: la baja es status='deleted' (el nombre queda reutilizable).
//
// El saldo por caja NUNCA se almacena: lo deriva
// billing.fn_get_cash_account_balance (pagos + ajustes − gastos + traspasos
// netos), mismo principio que fn_get_community_balance para la comunidad.

export interface CashAccount {
  readonly id: string;
  readonly communityId: string;
  readonly name: string;
  readonly description: string | null;
  /** Saldo actual derivado; una caja recién creada vale 0. */
  readonly balance: number;
  readonly status: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ListCashAccountsInput {
  readonly communityId: string;
  readonly page: number;
  readonly pageSize: number;
  readonly search?: string | null;
  readonly status?: string | null;
}

// El ::text preserva el NUMERIC exacto de la función; el mapeo lo vuelve
// number de JSON (convención de dinero del servicio).
const SELECT_COLUMNS = `
  ca.id, ca.community_id, ca.name, ca.description,
  billing.fn_get_cash_account_balance(ca.id)::text AS balance,
  ca.status, ca.created_at, ca.updated_at
`;

interface CashAccountRow {
  id: string;
  community_id: string;
  name: string;
  description: string | null;
  /** NULL solo para cajas eliminadas, que estas consultas ya excluyen. */
  balance: string | null;
  status: string;
  created_at: Date;
  updated_at: Date;
}

function mapRow(row: CashAccountRow): CashAccount {
  return {
    id: row.id,
    communityId: row.community_id,
    name: row.name,
    description: row.description,
    balance: Number(row.balance ?? "0"),
    status: row.status,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export const cashAccountsRepository = {
  async list(
    tx: TxClient,
    input: ListCashAccountsInput,
  ): Promise<{ items: CashAccount[]; total: number }> {
    const search = input.search ?? null;
    const status = input.status ?? null;
    const offset = (input.page - 1) * input.pageSize;

    const where = `
      WHERE ca.community_id = $1
        AND ($2::text IS NULL OR ca.name ILIKE '%' || $2 || '%')
        AND ( ($3::public.record_status IS NULL AND ca.status != 'deleted')
           OR ca.status = $3::public.record_status )
    `;

    const totalResult = await tx.query<{ count: string }>(
      `SELECT count(*)::bigint AS count FROM billing.cash_accounts ca ${where}`,
      [input.communityId, search, status],
    );
    const total = Number(totalResult.rows[0]?.count ?? 0);

    const itemsResult = await tx.query<CashAccountRow>(
      `SELECT ${SELECT_COLUMNS} FROM billing.cash_accounts ca ${where}
        ORDER BY ca.name
        LIMIT $4 OFFSET $5`,
      [input.communityId, search, status, input.pageSize, offset],
    );

    return { items: itemsResult.rows.map(mapRow), total };
  },

  async getById(tx: TxClient, communityId: string, id: string): Promise<CashAccount | null> {
    const result = await tx.query<CashAccountRow>(
      `SELECT ${SELECT_COLUMNS} FROM billing.cash_accounts ca
        WHERE ca.id = $1 AND ca.community_id = $2 AND ca.status != 'deleted'`,
      [id, communityId],
    );
    const row = result.rows[0];
    return row === undefined ? null : mapRow(row);
  },

  /** Inserta una caja. Puede lanzar 23505 (nombre duplicado en la comunidad). */
  async create(
    tx: TxClient,
    customerId: string,
    communityId: string,
    input: { name: string; description?: string | null },
  ): Promise<CashAccount> {
    // Sin fn_get_cash_account_balance en el RETURNING: una caja recién
    // insertada no tiene movimientos que la referencien, su saldo es 0 por
    // definición (y el snapshot del INSERT ni siquiera la vería).
    const result = await tx.query<Omit<CashAccountRow, "balance">>(
      `INSERT INTO billing.cash_accounts (customer_id, community_id, name, description)
       VALUES ($1, $2, $3, $4)
       RETURNING id, community_id, name, description, status, created_at, updated_at`,
      [customerId, communityId, input.name, input.description ?? null],
    );
    return mapRow({ ...result.rows[0]!, balance: "0" });
  },

  /** Actualización parcial. Devuelve null si no existe (o está 'deleted'). */
  async update(
    tx: TxClient,
    communityId: string,
    id: string,
    input: { name?: string; description?: string | null; status?: string },
  ): Promise<CashAccount | null> {
    const sets: string[] = [];
    const params: unknown[] = [];
    let i = 1;

    const push = (column: string, value: unknown, cast = ""): void => {
      sets.push(`${column} = $${i}${cast}`);
      params.push(value);
      i += 1;
    };

    if (input.name !== undefined) push("name", input.name);
    if (input.description !== undefined) push("description", input.description);
    if (input.status !== undefined) push("status", input.status, "::public.record_status");

    if (sets.length === 0) {
      return this.getById(tx, communityId, id);
    }

    params.push(id, communityId);
    const result = await tx.query<{ id: string }>(
      `UPDATE billing.cash_accounts SET ${sets.join(", ")}
        WHERE id = $${i} AND community_id = $${i + 1} AND status != 'deleted'
        RETURNING id`,
      params,
    );
    if (result.rows[0] === undefined) {
      return null;
    }
    // Relectura en la misma transacción: el saldo derivado no puede resolverse
    // en el RETURNING del UPDATE.
    return this.getById(tx, communityId, id);
  },

  async softDelete(tx: TxClient, communityId: string, id: string): Promise<boolean> {
    const result = await tx.query(
      `UPDATE billing.cash_accounts SET status = 'deleted'
        WHERE id = $1 AND community_id = $2 AND status != 'deleted'`,
      [id, communityId],
    );
    return (result.rowCount ?? 0) > 0;
  },
};
