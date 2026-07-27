import type { TxClient } from "../../../core/db/with_transaction";

// Acceso a datos del recurso fee-periods (billing.fee_periods). Las consultas
// llegan acotadas a una comunidad del alcance del actor (requireCommunityAccess)
// y el RLS filtra el tenant; el WHERE por community_id ata ademas el periodo a
// la cuota DE ESA comunidad (una cuota ajena responde como inexistente). El
// alta va SIEMPRE por billing.sp_ensure_fee_period (via sancionada, create-or-
// reuse); la baja es logica y solo procede sin cargos vivos.

export interface FeePeriod {
  readonly id: string;
  readonly feeId: string;
  readonly communityId: string;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly dueDate: string;
  readonly amount: number | null;
  readonly label: string | null;
  readonly chargesCount: number;
  readonly status: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateFeePeriodInput {
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly dueDate?: string | null;
  readonly amount?: number | null;
  readonly label?: string | null;
}

export interface ListFeePeriodsInput {
  readonly communityId: string;
  readonly feeId: string;
  readonly page: number;
  readonly pageSize: number;
}

// chargesCount solo cuenta cargos VIVOS: es el dato que la UI muestra y el que
// decide si la baja procede.
const SELECT_COLUMNS = `
  fp.id, fp.fee_id, fp.community_id,
  fp.period_start::text AS period_start, fp.period_end::text AS period_end,
  fp.due_date::text AS due_date, fp.amount::text AS amount, fp.label,
  (SELECT count(*)::int FROM billing.charges c
    WHERE c.customer_id = fp.customer_id AND c.period_id = fp.id
      AND c.status <> 'deleted') AS charges_count,
  fp.status, fp.created_at, fp.updated_at
`;

interface FeePeriodRow {
  id: string;
  fee_id: string;
  community_id: string;
  period_start: string;
  period_end: string;
  due_date: string;
  amount: string | null;
  label: string | null;
  charges_count: number;
  status: string;
  created_at: Date;
  updated_at: Date;
}

function mapRow(row: FeePeriodRow): FeePeriod {
  return {
    id: row.id,
    feeId: row.fee_id,
    communityId: row.community_id,
    periodStart: row.period_start,
    periodEnd: row.period_end,
    dueDate: row.due_date,
    amount: row.amount === null ? null : Number(row.amount),
    label: row.label,
    chargesCount: row.charges_count,
    status: row.status,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export const feePeriodsRepository = {
  /** true si la cuota existe (no borrada) y pertenece a la comunidad. */
  async feeExists(tx: TxClient, communityId: string, feeId: string): Promise<boolean> {
    const result = await tx.query(
      `SELECT 1 FROM billing.fees
        WHERE id = $1 AND community_id = $2 AND status != 'deleted'`,
      [feeId, communityId],
    );
    return (result.rowCount ?? 0) > 0;
  },

  /** Periodos de la cuota (paginado, cronologico). Oculta los borrados. */
  async list(
    tx: TxClient,
    input: ListFeePeriodsInput,
  ): Promise<{ items: FeePeriod[]; total: number }> {
    const offset = (input.page - 1) * input.pageSize;

    const where = `
      FROM billing.fee_periods fp
     WHERE fp.fee_id = $1
       AND fp.community_id = $2
       AND fp.status != 'deleted'
    `;

    const totalResult = await tx.query<{ count: string }>(
      `SELECT count(*)::bigint AS count ${where}`,
      [input.feeId, input.communityId],
    );
    const total = Number(totalResult.rows[0]?.count ?? 0);

    const itemsResult = await tx.query<FeePeriodRow>(
      `SELECT ${SELECT_COLUMNS} ${where}
        ORDER BY fp.period_start DESC, fp.id DESC
        LIMIT $3 OFFSET $4`,
      [input.feeId, input.communityId, input.pageSize, offset],
    );

    return { items: itemsResult.rows.map(mapRow), total };
  },

  /**
   * Alta via billing.sp_ensure_fee_period (create-or-reuse por rango exacto:
   * repetir un periodo existente lo devuelve tal cual en vez de fallar). Puede
   * lanzar 23P01 (ex_fee_periods_no_overlap) o P0002 (cuota no activa).
   */
  async create(tx: TxClient, feeId: string, input: CreateFeePeriodInput): Promise<FeePeriod> {
    const call = await tx.query<{ p_period_id: string | null }>(
      `CALL billing.sp_ensure_fee_period($1, $2::date, $3::date, $4::date, $5, $6, NULL)`,
      [
        feeId,
        input.periodStart,
        input.periodEnd,
        input.dueDate ?? null,
        input.amount ?? null,
        input.label ?? null,
      ],
    );
    const periodId = call.rows[0]?.p_period_id ?? null;
    if (periodId === null) {
      throw new Error("sp_ensure_fee_period no devolvió el id del periodo");
    }

    const created = await tx.query<FeePeriodRow>(
      `SELECT ${SELECT_COLUMNS} FROM billing.fee_periods fp WHERE fp.id = $1`,
      [periodId],
    );
    const row = created.rows[0];
    if (row === undefined) {
      throw new Error("sp_ensure_fee_period no dejó rastro del periodo");
    }
    return mapRow(row);
  },

  /**
   * Baja logica, SOLO sin cargos vivos: un periodo con cargos activos es parte
   * del estado de cuenta y borrarlo lo dejaria colgando de una fila 'deleted'.
   * 'deleted' = no existia; 'has-charges' = existe pero tiene cargos.
   */
  async softDelete(
    tx: TxClient,
    communityId: string,
    feeId: string,
    id: string,
  ): Promise<"deleted" | "not-found" | "has-charges"> {
    const result = await tx.query(
      `UPDATE billing.fee_periods fp SET status = 'deleted'
        WHERE fp.id = $1
          AND fp.fee_id = $2
          AND fp.community_id = $3
          AND fp.status != 'deleted'
          AND NOT EXISTS (
              SELECT 1 FROM billing.charges c
               WHERE c.customer_id = fp.customer_id
                 AND c.period_id   = fp.id
                 AND c.status <> 'deleted')`,
      [id, feeId, communityId],
    );
    if ((result.rowCount ?? 0) > 0) {
      return "deleted";
    }

    const exists = await tx.query(
      `SELECT 1 FROM billing.fee_periods
        WHERE id = $1 AND fee_id = $2 AND community_id = $3 AND status != 'deleted'`,
      [id, feeId, communityId],
    );
    return (exists.rowCount ?? 0) > 0 ? "has-charges" : "not-found";
  },
};
