import type { TxClient } from "../../../core/db/with_transaction";

// Acceso a datos del recurso charges (solo lectura). El saldo se calcula en
// la misma consulta con las aplicaciones/condonaciones activas (mismo
// criterio que billing.fn_get_charge_balance, pero en set para no llamar a
// la función por fila). `overdue` es SIEMPRE derivado (residguard_db 04).

export interface Charge {
  readonly id: string;
  readonly unitId: string;
  readonly unitCode: string;
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

export interface CreateChargeInput {
  readonly feeId: string;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly appliedAmount: number;
  readonly dueDate: string;
}

/** Generación de cargos de una cuota en un rango (delega en el procedure). */
export interface GenerateForFeeInput {
  readonly feeId: string;
  readonly from?: string | null;
  readonly to?: string | null;
  readonly dueDay?: number | null;
  readonly amount?: number | null;
}

/** Filtros del listado: por comunidad (todas sus unidades), por unidad, o
 *  ambos (comunidad acotada a una unidad). Al menos uno viene de la ruta. */
export interface ListChargesInput {
  readonly communityId?: string | null;
  readonly unitId?: string | null;
  readonly page: number;
  readonly pageSize: number;
  readonly paymentStatus?: string | null;
  readonly overdueOnly?: boolean | null;
  /** Solo cargos abiertos: activos y con saldo pendiente (los cobrables). */
  readonly openOnly?: boolean | null;
  readonly from?: string | null;
  readonly to?: string | null;
}

interface ChargeRow {
  id: string;
  unit_id: string;
  unit_code: string;
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
    unitCode: row.unit_code,
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
  JOIN community.units u
    ON u.customer_id = c.customer_id AND u.id = c.unit_id
  LEFT JOIN LATERAL (
    SELECT COALESCE((SELECT SUM(pa.amount) FROM billing.payment_allocations pa
                      WHERE pa.charge_id = c.id AND pa.status <> 'deleted'), 0)
         + COALESCE((SELECT SUM(w.waived_amount) FROM billing.waivers w
                      WHERE w.charge_id = c.id AND w.status <> 'deleted'), 0) AS covered
  ) cov ON true
`;

export const chargesRepository = {
  /** Cargos del alcance pedido (paginado), con saldo y `overdue` derivados. */
  async list(tx: TxClient, input: ListChargesInput): Promise<{ items: Charge[]; total: number }> {
    const communityId = input.communityId ?? null;
    const unitId = input.unitId ?? null;
    // Los dos filtros son opcionales en el WHERE, así que sin ninguno la
    // consulta devolvería TODOS los cargos del tenant, saltándose la frontera
    // de comunidad. Hoy las dos rutas inyectan uno desde la URL; este guard
    // impide que una ruta futura convierta ese vacío lógico en una fuga.
    if (communityId === null && unitId === null) {
      throw new Error(
        "chargesRepository.list exige communityId o unitId: sin alcance devolvería el tenant completo",
      );
    }
    const paymentStatus = input.paymentStatus ?? null;
    const overdueOnly = input.overdueOnly === true;
    const openOnly = input.openOnly === true;
    const from = input.from ?? null;
    const to = input.to ?? null;
    const offset = (input.page - 1) * input.pageSize;

    const where = `
      WHERE ($1::uuid IS NULL OR c.community_id = $1)
        AND ($2::uuid IS NULL OR c.unit_id = $2)
        AND c.status != 'deleted'
        AND ($3::billing.charge_status IS NULL OR c.payment_status = $3::billing.charge_status)
        AND ($4::boolean IS NOT TRUE
             OR (c.due_date < CURRENT_DATE AND cov.covered < c.applied_amount))
        AND ($5::boolean IS NOT TRUE
             OR (c.status = 'active' AND cov.covered < c.applied_amount))
        AND ($6::date IS NULL OR c.due_date >= $6::date)
        AND ($7::date IS NULL OR c.due_date <= $7::date)
    `;

    const totalResult = await tx.query<{ count: string }>(
      `SELECT count(*)::bigint AS count ${FROM_WITH_BALANCE} ${where}`,
      [communityId, unitId, paymentStatus, overdueOnly, openOnly, from, to],
    );
    const total = Number(totalResult.rows[0]?.count ?? 0);

    const itemsResult = await tx.query<ChargeRow>(
      `SELECT c.id, c.unit_id, u.code AS unit_code, c.community_id, c.fee_id, f.concept,
              c.period_start::text AS period_start, c.period_end::text AS period_end,
              c.applied_amount::text AS applied_amount,
              (c.applied_amount - cov.covered)::text AS balance,
              c.due_date::text AS due_date, c.payment_status,
              (c.due_date < CURRENT_DATE AND cov.covered < c.applied_amount) AS overdue,
              c.status, c.created_at, c.updated_at
         ${FROM_WITH_BALANCE} ${where}
        ORDER BY c.due_date DESC, u.code ASC, c.id DESC
        LIMIT $8 OFFSET $9`,
      [
        communityId,
        unitId,
        paymentStatus,
        overdueOnly,
        openOnly,
        from,
        to,
        input.pageSize,
        offset,
      ],
    );

    return { items: itemsResult.rows.map(mapRow), total };
  },

  /**
   * Periodicidad y fin de vigencia de una cuota ACTIVA de la comunidad
   * (id + code de la ruta). null si no existe, no es de la comunidad o no está
   * activa — el controller lo convierte en error de negocio antes de generar.
   */
  async feeForGeneration(
    tx: TxClient,
    communityId: string,
    feeId: string,
  ): Promise<{ periodicity: string; effectiveTo: string | null } | null> {
    const result = await tx.query<{ periodicity: string; effective_to: string | null }>(
      `SELECT periodicity, effective_to::text AS effective_to
         FROM billing.fees
        WHERE id = $1 AND community_id = $2 AND status = 'active'`,
      [feeId, communityId],
    );
    const row = result.rows[0];
    return row === undefined
      ? null
      : { periodicity: row.periodicity, effectiveTo: row.effective_to };
  },

  /**
   * Genera los cargos de la cuota en el rango vía el procedure sancionado
   * billing.sp_generate_charges_for_fee (largo/paso por periodicidad, sin
   * duplicados). Devuelve cuántos cargos se crearon (INOUT p_created_count).
   */
  async generateForFee(tx: TxClient, input: GenerateForFeeInput): Promise<number> {
    const result = await tx.query<{ p_created_count: number | null }>(
      `CALL billing.sp_generate_charges_for_fee($1, $2::date, $3::date, $4::int, $5, NULL)`,
      [input.feeId, input.from ?? null, input.to ?? null, input.dueDay ?? null, input.amount ?? null],
    );
    return Number(result.rows[0]?.p_created_count ?? 0);
  },

  /**
   * Unidades ACTIVAS de la comunidad entre las pedidas (id + code). Si el
   * resultado trae menos que las pedidas, alguna no existe / no es de la
   * comunidad / no está activa — el controller lo convierte en error de
   * negocio antes de insertar nada.
   */
  async resolveActiveUnits(
    tx: TxClient,
    communityId: string,
    unitIds: readonly string[],
  ): Promise<{ id: string; code: string }[]> {
    const result = await tx.query<{ id: string; code: string }>(
      `SELECT id, code FROM community.units
        WHERE community_id = $1 AND id = ANY($2::uuid[]) AND status = 'active'
        ORDER BY code`,
      [communityId, [...unitIds]],
    );
    return result.rows;
  },

  /**
   * Crea o reusa el PERIODO de la cuota para el rango (via sancionada
   * billing.sp_ensure_fee_period) y devuelve su id. Se llama UNA vez por
   * registro multi-unidad: todos los cargos cuelgan del mismo periodo. Puede
   * lanzar 23P01 (ex_fee_periods_no_overlap: el rango solapa otro periodo) o
   * P0002 (cuota no activa para el tenant).
   */
  async ensurePeriod(tx: TxClient, input: CreateChargeInput): Promise<string> {
    const call = await tx.query<{ p_period_id: string | null }>(
      `CALL billing.sp_ensure_fee_period($1, $2::date, $3::date, $4::date, NULL, NULL, NULL)`,
      [input.feeId, input.periodStart, input.periodEnd, input.dueDate],
    );
    const periodId = call.rows[0]?.p_period_id ?? null;
    if (periodId === null) {
      throw new Error("sp_ensure_fee_period no devolvió el id del periodo");
    }
    return periodId;
  },

  /**
   * Inserta un cargo del periodo dado tomando el contexto (tenant/comunidad)
   * de la unidad y exigiendo que la cuota sea de esa MISMA comunidad y esté
   * activa. Devuelve null si la unidad no está activa o la cuota no está
   * disponible (0 filas insertadas). Puede lanzar 23505 (uq_charges_period_unit:
   * la unidad ya tiene cargo de ese periodo) o 23514 (ck_charges_period).
   */
  async create(
    tx: TxClient,
    unitId: string,
    periodId: string,
    input: CreateChargeInput,
  ): Promise<Charge | null> {
    const result = await tx.query<ChargeRow>(
      `WITH ins AS (
         INSERT INTO billing.charges
           (customer_id, community_id, fee_id, period_id, unit_id,
            period_start, period_end, applied_amount, due_date)
         SELECT u.customer_id, u.community_id, f.id, $7, u.id,
                $3::date, $4::date, $5, $6::date
           FROM community.units u
           JOIN billing.fees f
             ON f.customer_id  = u.customer_id
            AND f.community_id = u.community_id
            AND f.id           = $2
            AND f.status       = 'active'
          WHERE u.id = $1 AND u.status = 'active'
         RETURNING customer_id, id, unit_id, community_id, fee_id, period_start,
                   period_end, applied_amount, due_date, payment_status, status,
                   created_at, updated_at
       )
       SELECT ins.id, ins.unit_id, u.code AS unit_code, ins.community_id, ins.fee_id, f.concept,
              ins.period_start::text AS period_start, ins.period_end::text AS period_end,
              ins.applied_amount::text AS applied_amount,
              ins.applied_amount::text AS balance,
              ins.due_date::text AS due_date, ins.payment_status,
              (ins.due_date < CURRENT_DATE) AS overdue,
              ins.status, ins.created_at, ins.updated_at
         FROM ins
         JOIN billing.fees f    ON f.customer_id = ins.customer_id AND f.id = ins.fee_id
         JOIN community.units u ON u.customer_id = ins.customer_id AND u.id = ins.unit_id`,
      [
        unitId,
        input.feeId,
        input.periodStart,
        input.periodEnd,
        input.appliedAmount,
        input.dueDate,
        periodId,
      ],
    );
    const row = result.rows[0];
    return row === undefined ? null : mapRow(row);
  },
};
