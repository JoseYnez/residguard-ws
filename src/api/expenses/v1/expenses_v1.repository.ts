import type { TxClient } from "../../../core/db/with_transaction";

// Acceso a datos del recurso expenses (billing.expenses). Acotado a una
// comunidad ya autorizada; RLS filtra el tenant. La FK compuesta de BD
// garantiza que el rubro sea del MISMO tenant y la MISMA comunidad (23503 si
// no). Sin DELETE físico: baja = status='deleted'.

export interface Expense {
  readonly id: string;
  readonly communityId: string;
  readonly expenseCategoryId: string;
  readonly categoryName: string;
  readonly concept: string;
  readonly amount: number;
  readonly expenseDate: string;
  readonly method: string;
  readonly vendorName: string | null;
  readonly reference: string | null;
  readonly authorizedBy: string | null;
  readonly status: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateExpenseInput {
  readonly expenseCategoryId: string;
  readonly concept: string;
  readonly amount: number;
  readonly expenseDate: string;
  readonly method: string;
  readonly vendorName?: string | null;
  readonly reference?: string | null;
  readonly authorizedBy?: string | null;
}

export interface UpdateExpenseInput {
  readonly expenseCategoryId?: string;
  readonly concept?: string;
  readonly amount?: number;
  readonly expenseDate?: string;
  readonly method?: string;
  readonly vendorName?: string | null;
  readonly reference?: string | null;
  readonly authorizedBy?: string | null;
}

export interface ListExpensesInput {
  readonly communityId: string;
  readonly page: number;
  readonly pageSize: number;
  readonly expenseCategoryId?: string | null;
  readonly method?: string | null;
  readonly from?: string | null;
  readonly to?: string | null;
  readonly search?: string | null;
}

const SELECT = `
  SELECT e.id, e.community_id, e.expense_category_id, ec.name AS category_name,
         e.concept, e.amount::text AS amount, e.expense_date::text AS expense_date,
         e.method, e.vendor_name, e.reference, e.authorized_by,
         e.status, e.created_at, e.updated_at
    FROM billing.expenses e
    JOIN billing.expense_categories ec
      ON ec.customer_id = e.customer_id AND ec.id = e.expense_category_id
`;

interface ExpenseRow {
  id: string;
  community_id: string;
  expense_category_id: string;
  category_name: string;
  concept: string;
  amount: string;
  expense_date: string;
  method: string;
  vendor_name: string | null;
  reference: string | null;
  authorized_by: string | null;
  status: string;
  created_at: Date;
  updated_at: Date;
}

function mapRow(row: ExpenseRow): Expense {
  return {
    id: row.id,
    communityId: row.community_id,
    expenseCategoryId: row.expense_category_id,
    categoryName: row.category_name,
    concept: row.concept,
    amount: Number(row.amount),
    expenseDate: row.expense_date,
    method: row.method,
    vendorName: row.vendor_name,
    reference: row.reference,
    authorizedBy: row.authorized_by,
    status: row.status,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export const expensesRepository = {
  async list(tx: TxClient, input: ListExpensesInput): Promise<{ items: Expense[]; total: number }> {
    const categoryId = input.expenseCategoryId ?? null;
    const method = input.method ?? null;
    const from = input.from ?? null;
    const to = input.to ?? null;
    const search = input.search ?? null;
    const offset = (input.page - 1) * input.pageSize;

    const where = `
      WHERE e.community_id = $1
        AND e.status != 'deleted'
        AND ($2::uuid IS NULL OR e.expense_category_id = $2::uuid)
        AND ($3::billing.payment_method IS NULL OR e.method = $3::billing.payment_method)
        AND ($4::date IS NULL OR e.expense_date >= $4::date)
        AND ($5::date IS NULL OR e.expense_date <= $5::date)
        AND ($6::text IS NULL OR e.concept ILIKE '%' || $6 || '%' OR e.vendor_name ILIKE '%' || $6 || '%')
    `;

    const totalResult = await tx.query<{ count: string }>(
      `SELECT count(*)::bigint AS count
         FROM billing.expenses e
         JOIN billing.expense_categories ec
           ON ec.customer_id = e.customer_id AND ec.id = e.expense_category_id
        ${where}`,
      [input.communityId, categoryId, method, from, to, search],
    );
    const total = Number(totalResult.rows[0]?.count ?? 0);

    const itemsResult = await tx.query<ExpenseRow>(
      `${SELECT} ${where}
        ORDER BY e.expense_date DESC, e.id DESC
        LIMIT $7 OFFSET $8`,
      [input.communityId, categoryId, method, from, to, search, input.pageSize, offset],
    );

    return { items: itemsResult.rows.map(mapRow), total };
  },

  async getById(tx: TxClient, communityId: string, id: string): Promise<Expense | null> {
    const result = await tx.query<ExpenseRow>(
      `${SELECT}
        WHERE e.id = $1 AND e.community_id = $2 AND e.status != 'deleted'`,
      [id, communityId],
    );
    const row = result.rows[0];
    return row === undefined ? null : mapRow(row);
  },

  /** Inserta un gasto. Puede lanzar 23503 (rubro de otra comunidad) / 23514. */
  async create(
    tx: TxClient,
    customerId: string,
    communityId: string,
    input: CreateExpenseInput,
  ): Promise<Expense> {
    const inserted = await tx.query<{ id: string }>(
      `INSERT INTO billing.expenses
         (customer_id, community_id, expense_category_id, concept, amount,
          expense_date, method, vendor_name, reference, authorized_by)
       VALUES ($1, $2, $3, $4, $5, $6::date, $7::billing.payment_method, $8, $9, $10)
       RETURNING id`,
      [
        customerId,
        communityId,
        input.expenseCategoryId,
        input.concept,
        input.amount,
        input.expenseDate,
        input.method,
        input.vendorName ?? null,
        input.reference ?? null,
        input.authorizedBy ?? null,
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
    input: UpdateExpenseInput,
  ): Promise<Expense | null> {
    const sets: string[] = [];
    const params: unknown[] = [];
    let i = 1;

    const push = (column: string, value: unknown, cast = ""): void => {
      sets.push(`${column} = $${i}${cast}`);
      params.push(value);
      i += 1;
    };

    if (input.expenseCategoryId !== undefined) push("expense_category_id", input.expenseCategoryId, "::uuid");
    if (input.concept !== undefined) push("concept", input.concept);
    if (input.amount !== undefined) push("amount", input.amount);
    if (input.expenseDate !== undefined) push("expense_date", input.expenseDate, "::date");
    if (input.method !== undefined) push("method", input.method, "::billing.payment_method");
    if (input.vendorName !== undefined) push("vendor_name", input.vendorName);
    if (input.reference !== undefined) push("reference", input.reference);
    if (input.authorizedBy !== undefined) push("authorized_by", input.authorizedBy, "::uuid");

    if (sets.length === 0) {
      return this.getById(tx, communityId, id);
    }

    params.push(id, communityId);
    const result = await tx.query<{ id: string }>(
      `UPDATE billing.expenses SET ${sets.join(", ")}
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
      `UPDATE billing.expenses SET status = 'deleted'
        WHERE id = $1 AND community_id = $2 AND status != 'deleted'`,
      [id, communityId],
    );
    return (result.rowCount ?? 0) > 0;
  },
};
