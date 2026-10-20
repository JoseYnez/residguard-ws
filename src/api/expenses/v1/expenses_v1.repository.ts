import type { TxClient } from "../../../core/db/with_transaction";
import type { StorageFileMetadata } from "../../../core/storage/storage_client";

// Acceso a datos del recurso expenses (billing.expenses + billing.expense_files).
// Acotado a una comunidad ya autorizada; RLS filtra el tenant. La FK compuesta
// de BD garantiza que el rubro sea del MISMO tenant y la MISMA comunidad
// (23503 si no). Sin DELETE físico: baja = status='deleted'.
//
// Los COMPROBANTES (expense_files) son filas de referencia: los bytes viven en
// storage-service y aquí queda el id de storage + un espejo de metadata. El
// id que sale al cliente es el de la FILA, no el de storage: por ese id pide
// el enlace firmado y por ese id dice qué conserva al editar.

/** Caja resuelta (id + nombre) para que el cliente no cruce catálogos. */
export interface ExpenseCashAccountRef {
  readonly id: string;
  readonly name: string;
}

/** Un comprobante como lo ve el cliente (sin id de storage ni huella). */
export interface ExpenseFile {
  readonly id: string;
  readonly filename: string;
  readonly contentType: string;
  readonly sizeBytes: number;
}

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
  readonly cashAccount: ExpenseCashAccountRef | null;
  // Mutable a propósito: la respuesta tipada del verifier no admite readonly.
  readonly files: ExpenseFile[];
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
  readonly cashAccountId?: string | null;
  /** Comprobantes YA validados contra storage (metadata espejada). */
  readonly files?: readonly StorageFileMetadata[];
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
  readonly cashAccountId?: string | null;
  /** Conjunto COMPLETO de comprobantes que el gasto debe quedar llevando
   *  (ya validados). `undefined` = no tocar los adjuntos. */
  readonly files?: readonly StorageFileMetadata[];
}

export interface ListExpensesInput {
  readonly communityId: string;
  readonly page: number;
  readonly pageSize: number;
  readonly expenseCategoryId?: string | null;
  readonly method?: string | null;
  readonly cashAccountId?: string | null;
  readonly from?: string | null;
  readonly to?: string | null;
  readonly search?: string | null;
}

// LEFT JOIN a la caja: el gasto histórico no la declara.
const SELECT = `
  SELECT e.id, e.community_id, e.expense_category_id, ec.name AS category_name,
         e.concept, e.amount::text AS amount, e.expense_date::text AS expense_date,
         e.method, e.vendor_name, e.reference, e.authorized_by,
         ca.id AS cash_account_id, ca.name AS cash_account_name,
         e.status, e.created_at, e.updated_at
    FROM billing.expenses e
    JOIN billing.expense_categories ec
      ON ec.customer_id = e.customer_id AND ec.id = e.expense_category_id
    LEFT JOIN billing.cash_accounts ca
      ON ca.customer_id = e.customer_id AND ca.id = e.cash_account_id
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
  cash_account_id: string | null;
  cash_account_name: string | null;
  status: string;
  created_at: Date;
  updated_at: Date;
}

interface ExpenseFileRow {
  id: string;
  expense_id: string;
  filename: string;
  content_type: string;
  size_bytes: string;
}

function mapRow(row: ExpenseRow, files: ExpenseFile[]): Expense {
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
    cashAccount:
      row.cash_account_id !== null && row.cash_account_name !== null
        ? { id: row.cash_account_id, name: row.cash_account_name }
        : null,
    files,
    status: row.status,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

/**
 * Comprobantes ACTIVOS de un conjunto de gastos, agrupados por gasto y en
 * orden de subida. Una segunda consulta y no un JOIN: un JOIN multiplicaría
 * las filas del listado por archivo y rompería la paginación.
 */
async function filesByExpense(
  tx: TxClient,
  expenseIds: readonly string[],
): Promise<Map<string, ExpenseFile[]>> {
  const grouped = new Map<string, ExpenseFile[]>();
  if (expenseIds.length === 0) {
    return grouped;
  }
  const result = await tx.query<ExpenseFileRow>(
    `SELECT id, expense_id, filename, content_type, size_bytes
       FROM billing.expense_files
      WHERE expense_id = ANY($1::uuid[]) AND status = 'active'
      ORDER BY created_at, id`,
    [expenseIds],
  );
  for (const row of result.rows) {
    const list = grouped.get(row.expense_id) ?? [];
    list.push({
      id: row.id,
      filename: row.filename,
      contentType: row.content_type,
      sizeBytes: Number(row.size_bytes),
    });
    grouped.set(row.expense_id, list);
  }
  return grouped;
}

async function insertFiles(
  tx: TxClient,
  customerId: string,
  expenseId: string,
  files: readonly StorageFileMetadata[],
): Promise<void> {
  for (const file of files) {
    await tx.query(
      `INSERT INTO billing.expense_files
         (customer_id, expense_id, storage_file_id, filename, content_type, size_bytes, sha256)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        customerId,
        expenseId,
        file.id,
        file.filename,
        file.contentType,
        file.sizeBytes,
        file.sha256,
      ],
    );
  }
}

export const expensesRepository = {
  async list(tx: TxClient, input: ListExpensesInput): Promise<{ items: Expense[]; total: number }> {
    const categoryId = input.expenseCategoryId ?? null;
    const method = input.method ?? null;
    const cashAccountId = input.cashAccountId ?? null;
    const from = input.from ?? null;
    const to = input.to ?? null;
    const search = input.search ?? null;
    const offset = (input.page - 1) * input.pageSize;

    const where = `
      WHERE e.community_id = $1
        AND e.status != 'deleted'
        AND ($2::uuid IS NULL OR e.expense_category_id = $2::uuid)
        AND ($3::billing.payment_method IS NULL OR e.method = $3::billing.payment_method)
        AND ($4::uuid IS NULL OR e.cash_account_id = $4::uuid)
        AND ($5::date IS NULL OR e.expense_date >= $5::date)
        AND ($6::date IS NULL OR e.expense_date <= $6::date)
        AND ($7::text IS NULL OR e.concept ILIKE '%' || $7 || '%' OR e.vendor_name ILIKE '%' || $7 || '%')
    `;

    const totalResult = await tx.query<{ count: string }>(
      `SELECT count(*)::bigint AS count
         FROM billing.expenses e
         JOIN billing.expense_categories ec
           ON ec.customer_id = e.customer_id AND ec.id = e.expense_category_id
        ${where}`,
      [input.communityId, categoryId, method, cashAccountId, from, to, search],
    );
    const total = Number(totalResult.rows[0]?.count ?? 0);

    const itemsResult = await tx.query<ExpenseRow>(
      `${SELECT} ${where}
        ORDER BY e.expense_date DESC, e.id DESC
        LIMIT $8 OFFSET $9`,
      [input.communityId, categoryId, method, cashAccountId, from, to, search, input.pageSize, offset],
    );

    const files = await filesByExpense(
      tx,
      itemsResult.rows.map((row) => row.id),
    );
    return {
      items: itemsResult.rows.map((row) => mapRow(row, files.get(row.id) ?? [])),
      total,
    };
  },

  async getById(tx: TxClient, communityId: string, id: string): Promise<Expense | null> {
    const result = await tx.query<ExpenseRow>(
      `${SELECT}
        WHERE e.id = $1 AND e.community_id = $2 AND e.status != 'deleted'`,
      [id, communityId],
    );
    const row = result.rows[0];
    if (row === undefined) {
      return null;
    }
    const files = await filesByExpense(tx, [row.id]);
    return mapRow(row, files.get(row.id) ?? []);
  },

  /**
   * ¿Es el rubro ACTIVO y de esta comunidad? La FK compuesta
   * (customer_id, community_id, expense_category_id) ya impide usar un rubro de
   * otra comunidad, pero no mira `status`: sin esta comprobación se podrían
   * registrar gastos contra un rubro retirado del catálogo.
   */
  async activeCategoryExists(
    tx: TxClient,
    communityId: string,
    categoryId: string,
  ): Promise<boolean> {
    const result = await tx.query(
      `SELECT 1 FROM billing.expense_categories
        WHERE id = $1 AND community_id = $2 AND status = 'active'`,
      [categoryId, communityId],
    );
    return (result.rowCount ?? 0) > 0;
  },

  /**
   * ¿Es la caja ACTIVA y de esta comunidad? La FK compuesta
   * (customer_id, community_id, cash_account_id) ya impide usar una caja de
   * otra comunidad, pero no mira `status`: sin esta comprobación se podrían
   * registrar gastos contra una caja retirada del catálogo.
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

  /**
   * Los comprobantes ACTIVOS de un gasto, indexados por el id de su FILA (el
   * que expone el detalle), con la metadata que hace falta para volver a
   * darlos de alta sin preguntarle a storage. Acotado a la comunidad: el id de
   * un gasto ajeno no se reusa aquí. Mapa vacío si el gasto no existe.
   */
  async keptFiles(
    tx: TxClient,
    communityId: string,
    expenseId: string,
  ): Promise<Map<string, StorageFileMetadata>> {
    const result = await tx.query<{
      id: string;
      storage_file_id: string;
      filename: string;
      content_type: string;
      size_bytes: string;
      sha256: string;
    }>(
      `SELECT f.id, f.storage_file_id, f.filename, f.content_type, f.size_bytes, f.sha256
         FROM billing.expense_files f
         JOIN billing.expenses e
           ON e.customer_id = f.customer_id AND e.id = f.expense_id
        WHERE f.expense_id   = $2
          AND e.community_id = $1
          AND e.status      <> 'deleted'
          AND f.status       = 'active'`,
      [communityId, expenseId],
    );
    return new Map(
      result.rows.map((row) => [
        row.id,
        {
          id: row.storage_file_id,
          filename: row.filename,
          contentType: row.content_type,
          sizeBytes: Number(row.size_bytes),
          sha256: row.sha256,
        },
      ]),
    );
  },

  /** Referencia de storage de un comprobante, ya acotado a su gasto y a la
   *  comunidad de la ruta. null = no existe, no es de ese gasto, o el gasto
   *  está fuera de la comunidad — indistinguibles a propósito (404). */
  async fileRef(
    tx: TxClient,
    communityId: string,
    expenseId: string,
    fileId: string,
  ): Promise<{ storageFileId: string } | null> {
    const result = await tx.query<{ storage_file_id: string }>(
      `SELECT f.storage_file_id
         FROM billing.expense_files f
         JOIN billing.expenses e
           ON e.customer_id = f.customer_id AND e.id = f.expense_id
        WHERE f.id           = $3
          AND f.expense_id   = $2
          AND e.community_id = $1
          AND e.status      <> 'deleted'
          AND f.status       = 'active'`,
      [communityId, expenseId, fileId],
    );
    const row = result.rows[0];
    return row === undefined ? null : { storageFileId: row.storage_file_id };
  },

  /** Inserta un gasto (y sus comprobantes, en la misma transacción). Puede
   *  lanzar 23503 (rubro/caja de otra comunidad) / 23514. */
  async create(
    tx: TxClient,
    customerId: string,
    communityId: string,
    input: CreateExpenseInput,
  ): Promise<Expense> {
    const inserted = await tx.query<{ id: string }>(
      `INSERT INTO billing.expenses
         (customer_id, community_id, expense_category_id, concept, amount,
          expense_date, method, vendor_name, reference, authorized_by, cash_account_id)
       VALUES ($1, $2, $3, $4, $5, $6::date, $7::billing.payment_method, $8, $9, $10, $11)
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
        input.cashAccountId ?? null,
      ],
    );
    const expenseId = inserted.rows[0]!.id;
    await insertFiles(tx, customerId, expenseId, input.files ?? []);
    const created = await this.getById(tx, communityId, expenseId);
    return created!;
  },

  /** Actualización parcial. Devuelve null si no existe (o está 'deleted'). */
  async update(
    tx: TxClient,
    customerId: string,
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
    if (input.cashAccountId !== undefined) push("cash_account_id", input.cashAccountId, "::uuid");

    // El gasto se bloquea aunque el PATCH solo traiga adjuntos: dos ediciones
    // simultáneas del mismo conjunto de comprobantes se serializan aquí.
    const locked = await tx.query<{ id: string }>(
      `SELECT id FROM billing.expenses
        WHERE id = $1 AND community_id = $2 AND status != 'deleted'
        FOR UPDATE`,
      [id, communityId],
    );
    if (locked.rows[0] === undefined) {
      return null;
    }

    if (sets.length > 0) {
      params.push(id, communityId);
      await tx.query(
        `UPDATE billing.expenses SET ${sets.join(", ")}
          WHERE id = $${i} AND community_id = $${i + 1} AND status != 'deleted'`,
        params,
      );
    }

    if (input.files !== undefined) {
      await this.replaceFiles(tx, customerId, id, input.files);
    }

    return this.getById(tx, communityId, id);
  },

  /**
   * Deja al gasto con EXACTAMENTE estos comprobantes: baja lógica de los que
   * ya no vienen y alta de los que aún no tiene. Los que se conservan no se
   * tocan — conservan su id de fila y su lugar en el orden de subida (a
   * diferencia de comunicados, que los re-inserta todos).
   */
  async replaceFiles(
    tx: TxClient,
    customerId: string,
    expenseId: string,
    files: readonly StorageFileMetadata[],
  ): Promise<void> {
    const wanted = files.map((file) => file.id);
    await tx.query(
      `UPDATE billing.expense_files SET status = 'deleted'
        WHERE expense_id = $1
          AND status <> 'deleted'
          AND NOT (storage_file_id = ANY($2::uuid[]))`,
      [expenseId, wanted],
    );
    const present = await tx.query<{ storage_file_id: string }>(
      `SELECT storage_file_id FROM billing.expense_files
        WHERE expense_id = $1 AND status <> 'deleted'`,
      [expenseId],
    );
    const already = new Set(present.rows.map((row) => row.storage_file_id));
    const seen = new Set<string>();
    const fresh = files.filter((file) => {
      // El mismo archivo dos veces en la lista es un solo adjunto.
      if (already.has(file.id) || seen.has(file.id)) return false;
      seen.add(file.id);
      return true;
    });
    await insertFiles(tx, customerId, expenseId, fresh);
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
