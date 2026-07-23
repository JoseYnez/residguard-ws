import type { TxClient } from "../../../core/db/with_transaction";

// Acceso a datos del recurso expense-categories (billing.expense_categories).
// Acotado a una comunidad ya autorizada; RLS filtra el tenant. Sin DELETE
// físico: la baja es status='deleted' (el nombre queda reutilizable).

export interface ExpenseCategory {
  readonly id: string;
  readonly communityId: string;
  readonly name: string;
  readonly description: string | null;
  readonly status: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ListExpenseCategoriesInput {
  readonly communityId: string;
  readonly page: number;
  readonly pageSize: number;
  readonly search?: string | null;
  readonly status?: string | null;
}

const SELECT_COLUMNS = `
  id, community_id, name, description, status, created_at, updated_at
`;

interface ExpenseCategoryRow {
  id: string;
  community_id: string;
  name: string;
  description: string | null;
  status: string;
  created_at: Date;
  updated_at: Date;
}

function mapRow(row: ExpenseCategoryRow): ExpenseCategory {
  return {
    id: row.id,
    communityId: row.community_id,
    name: row.name,
    description: row.description,
    status: row.status,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export const expenseCategoriesRepository = {
  async list(
    tx: TxClient,
    input: ListExpenseCategoriesInput,
  ): Promise<{ items: ExpenseCategory[]; total: number }> {
    const search = input.search ?? null;
    const status = input.status ?? null;
    const offset = (input.page - 1) * input.pageSize;

    const where = `
      WHERE community_id = $1
        AND ($2::text IS NULL OR name ILIKE '%' || $2 || '%')
        AND ( ($3::public.record_status IS NULL AND status != 'deleted')
           OR status = $3::public.record_status )
    `;

    const totalResult = await tx.query<{ count: string }>(
      `SELECT count(*)::bigint AS count FROM billing.expense_categories ${where}`,
      [input.communityId, search, status],
    );
    const total = Number(totalResult.rows[0]?.count ?? 0);

    const itemsResult = await tx.query<ExpenseCategoryRow>(
      `SELECT ${SELECT_COLUMNS} FROM billing.expense_categories ${where}
        ORDER BY name
        LIMIT $4 OFFSET $5`,
      [input.communityId, search, status, input.pageSize, offset],
    );

    return { items: itemsResult.rows.map(mapRow), total };
  },

  async getById(tx: TxClient, communityId: string, id: string): Promise<ExpenseCategory | null> {
    const result = await tx.query<ExpenseCategoryRow>(
      `SELECT ${SELECT_COLUMNS} FROM billing.expense_categories
        WHERE id = $1 AND community_id = $2 AND status != 'deleted'`,
      [id, communityId],
    );
    const row = result.rows[0];
    return row === undefined ? null : mapRow(row);
  },

  /** Inserta un rubro. Puede lanzar 23505 (nombre duplicado en la comunidad). */
  async create(
    tx: TxClient,
    customerId: string,
    communityId: string,
    input: { name: string; description?: string | null },
  ): Promise<ExpenseCategory> {
    const result = await tx.query<ExpenseCategoryRow>(
      `INSERT INTO billing.expense_categories (customer_id, community_id, name, description)
       VALUES ($1, $2, $3, $4)
       RETURNING ${SELECT_COLUMNS}`,
      [customerId, communityId, input.name, input.description ?? null],
    );
    return mapRow(result.rows[0]!);
  },

  /** Actualización parcial. Devuelve null si no existe (o está 'deleted'). */
  async update(
    tx: TxClient,
    communityId: string,
    id: string,
    input: { name?: string; description?: string | null; status?: string },
  ): Promise<ExpenseCategory | null> {
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
    const result = await tx.query<ExpenseCategoryRow>(
      `UPDATE billing.expense_categories SET ${sets.join(", ")}
        WHERE id = $${i} AND community_id = $${i + 1} AND status != 'deleted'
        RETURNING ${SELECT_COLUMNS}`,
      params,
    );
    const row = result.rows[0];
    return row === undefined ? null : mapRow(row);
  },

  async softDelete(tx: TxClient, communityId: string, id: string): Promise<boolean> {
    const result = await tx.query(
      `UPDATE billing.expense_categories SET status = 'deleted'
        WHERE id = $1 AND community_id = $2 AND status != 'deleted'`,
      [id, communityId],
    );
    return (result.rowCount ?? 0) > 0;
  },
};
