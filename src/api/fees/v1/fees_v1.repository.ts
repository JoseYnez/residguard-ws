import type { TxClient } from "../../../core/db/with_transaction";

// Acceso a datos del recurso fees (billing.fees). Las consultas llegan ya
// acotadas a una comunidad del alcance del actor (requireCommunityAccess) y el
// RLS filtra el tenant. Sin DELETE físico: la baja es status='deleted'.

export interface Fee {
  readonly id: string;
  readonly communityId: string;
  readonly concept: string;
  readonly baseAmount: number;
  readonly periodicity: string;
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
  readonly status: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateFeeInput {
  readonly concept: string;
  readonly baseAmount: number;
  readonly periodicity: string;
  readonly effectiveFrom: string;
  readonly effectiveTo?: string | null;
}

export interface UpdateFeeInput {
  readonly concept?: string;
  readonly baseAmount?: number;
  readonly periodicity?: string;
  readonly effectiveFrom?: string;
  readonly effectiveTo?: string | null;
  readonly status?: string;
}

export interface ListFeesInput {
  readonly communityId: string;
  readonly page: number;
  readonly pageSize: number;
  readonly search?: string | null;
  readonly status?: string | null;
  readonly activeOn?: string | null;
}

const SELECT_COLUMNS = `
  id, community_id, concept, base_amount::text AS base_amount, periodicity,
  effective_from::text AS effective_from, effective_to::text AS effective_to,
  status, created_at, updated_at
`;

interface FeeRow {
  id: string;
  community_id: string;
  concept: string;
  base_amount: string;
  periodicity: string;
  effective_from: string;
  effective_to: string | null;
  status: string;
  created_at: Date;
  updated_at: Date;
}

function mapRow(row: FeeRow): Fee {
  return {
    id: row.id,
    communityId: row.community_id,
    concept: row.concept,
    baseAmount: Number(row.base_amount),
    periodicity: row.periodicity,
    effectiveFrom: row.effective_from,
    effectiveTo: row.effective_to,
    status: row.status,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export const feesRepository = {
  /** Cuotas de la comunidad (paginado). Sin filtro de status oculta 'deleted'. */
  async list(tx: TxClient, input: ListFeesInput): Promise<{ items: Fee[]; total: number }> {
    const search = input.search ?? null;
    const status = input.status ?? null;
    const activeOn = input.activeOn ?? null;
    const offset = (input.page - 1) * input.pageSize;

    const where = `
      WHERE community_id = $1
        AND ($2::text IS NULL OR concept ILIKE '%' || $2 || '%')
        AND ( ($3::public.record_status IS NULL AND status != 'deleted')
           OR status = $3::public.record_status )
        AND ($4::date IS NULL
             OR (effective_from <= $4::date
                 AND (effective_to IS NULL OR effective_to >= $4::date)))
    `;

    const totalResult = await tx.query<{ count: string }>(
      `SELECT count(*)::bigint AS count FROM billing.fees ${where}`,
      [input.communityId, search, status, activeOn],
    );
    const total = Number(totalResult.rows[0]?.count ?? 0);

    const itemsResult = await tx.query<FeeRow>(
      `SELECT ${SELECT_COLUMNS} FROM billing.fees ${where}
        ORDER BY concept, effective_from DESC
        LIMIT $5 OFFSET $6`,
      [input.communityId, search, status, activeOn, input.pageSize, offset],
    );

    return { items: itemsResult.rows.map(mapRow), total };
  },

  /** Una cuota de la comunidad. null si no existe o está dada de baja. */
  async getById(tx: TxClient, communityId: string, id: string): Promise<Fee | null> {
    const result = await tx.query<FeeRow>(
      `SELECT ${SELECT_COLUMNS} FROM billing.fees
        WHERE id = $1 AND community_id = $2 AND status != 'deleted'`,
      [id, communityId],
    );
    const row = result.rows[0];
    return row === undefined ? null : mapRow(row);
  },

  /** Inserta una cuota. Puede lanzar 23P01 (ex_fees_no_overlap: mismo concepto
   *  con vigencias solapadas) o 23514 (monto/vigencia inválidos). */
  async create(
    tx: TxClient,
    customerId: string,
    communityId: string,
    input: CreateFeeInput,
  ): Promise<Fee> {
    const result = await tx.query<FeeRow>(
      `INSERT INTO billing.fees
         (customer_id, community_id, concept, base_amount, periodicity, effective_from, effective_to)
       VALUES ($1, $2, $3, $4, $5::billing.periodicity, $6::date, $7::date)
       RETURNING ${SELECT_COLUMNS}`,
      [
        customerId,
        communityId,
        input.concept,
        input.baseAmount,
        input.periodicity,
        input.effectiveFrom,
        input.effectiveTo ?? null,
      ],
    );
    return mapRow(result.rows[0]!);
  },

  /** Actualización parcial. Devuelve null si no existe (o está 'deleted'). */
  async update(
    tx: TxClient,
    communityId: string,
    id: string,
    input: UpdateFeeInput,
  ): Promise<Fee | null> {
    const sets: string[] = [];
    const params: unknown[] = [];
    let i = 1;

    const push = (column: string, value: unknown, cast = ""): void => {
      sets.push(`${column} = $${i}${cast}`);
      params.push(value);
      i += 1;
    };

    if (input.concept !== undefined) push("concept", input.concept);
    if (input.baseAmount !== undefined) push("base_amount", input.baseAmount);
    if (input.periodicity !== undefined) push("periodicity", input.periodicity, "::billing.periodicity");
    if (input.effectiveFrom !== undefined) push("effective_from", input.effectiveFrom, "::date");
    if (input.effectiveTo !== undefined) push("effective_to", input.effectiveTo, "::date");
    if (input.status !== undefined) push("status", input.status, "::public.record_status");

    if (sets.length === 0) {
      return this.getById(tx, communityId, id);
    }

    params.push(id, communityId);
    const result = await tx.query<FeeRow>(
      `UPDATE billing.fees SET ${sets.join(", ")}
        WHERE id = $${i} AND community_id = $${i + 1} AND status != 'deleted'
        RETURNING ${SELECT_COLUMNS}`,
      params,
    );
    const row = result.rows[0];
    return row === undefined ? null : mapRow(row);
  },

  /** Baja lógica (status='deleted'). false si no existía o ya estaba de baja. */
  async softDelete(tx: TxClient, communityId: string, id: string): Promise<boolean> {
    const result = await tx.query(
      `UPDATE billing.fees SET status = 'deleted'
        WHERE id = $1 AND community_id = $2 AND status != 'deleted'`,
      [id, communityId],
    );
    return (result.rowCount ?? 0) > 0;
  },
};
