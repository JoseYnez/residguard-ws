import type { TxClient } from "../../../core/db/with_transaction";

// Acceso a datos del recurso waivers (billing.waivers). El alta va SIEMPRE por
// billing.sp_waive_charge (vía sancionada: bloquea el cargo, inserta la
// condonación y recalcula payment_status); la reversión es soft-delete del
// waiver + billing.sp_refresh_charge_payment_status del cargo.

export interface Waiver {
  readonly id: string;
  readonly chargeId: string;
  readonly communityId: string;
  readonly unitId: string;
  readonly unitCode: string;
  readonly concept: string;
  /** Periodo del cargo condonado; null los tres si el cargo es SUELTO. */
  readonly periodLabel: string | null;
  readonly periodStart: string | null;
  readonly periodEnd: string | null;
  readonly amount: number;
  readonly reason: string;
  readonly authorizedBy: string | null;
  readonly authorizedByName: string | null;
  /** Estado del CARGO leído junto con la condonación (post-recálculo). */
  readonly chargeAppliedAmount: number;
  readonly chargeBalance: number;
  readonly chargePaymentStatus: string;
  readonly status: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Cargo bloqueado, con lo necesario para topar el monto a condonar. */
export interface ChargeForWaiver {
  readonly appliedAmount: number;
  readonly covered: number;
  readonly balance: number;
  readonly paymentStatus: string;
}

export interface ListWaiversInput {
  readonly communityId: string;
  readonly page: number;
  readonly pageSize: number;
  readonly chargeId?: string | null;
  readonly unitId?: string | null;
  readonly from?: string | null;
  readonly to?: string | null;
}

const SELECT_COLUMNS = `
  w.id, w.charge_id, c.community_id, c.unit_id, u.code AS unit_code,
  f.concept,
  fp.label AS period_label,
  fp.period_start::text AS period_start,
  fp.period_end::text   AS period_end,
  w.waived_amount::text AS amount, w.reason,
  w.authorized_by, au.full_name AS authorized_by_name,
  c.applied_amount::text AS charge_applied_amount,
  (c.applied_amount - cov.covered)::text AS charge_balance,
  c.payment_status AS charge_payment_status,
  w.status, w.created_at, w.updated_at
`;

/**
 * Condonaciones con el contexto del cargo. El JOIN con `fee_periods` es LEFT a
 * propósito: un cargo SUELTO no tiene periodo y con un INNER su condonación
 * desaparecería del historial (residguard_ws/CLAUDE.md §3).
 */
const FROM_JOINS = `
  FROM billing.waivers w
  JOIN billing.charges c
    ON c.customer_id = w.customer_id AND c.id = w.charge_id
  JOIN billing.fees f
    ON f.customer_id = c.customer_id AND f.id = c.fee_id
  LEFT JOIN billing.fee_periods fp
    ON fp.customer_id = c.customer_id AND fp.id = c.period_id
  JOIN community.units u
    ON u.customer_id = c.customer_id AND u.id = c.unit_id
  -- Espejo de identidad (solo lectura): nombre para mostrar de quien autorizó.
  LEFT JOIN core.users au
    ON au.customer_id = w.customer_id AND au.id = w.authorized_by
  LEFT JOIN LATERAL (
    SELECT COALESCE((SELECT SUM(pa.amount) FROM billing.payment_allocations pa
                      WHERE pa.charge_id = c.id AND pa.status <> 'deleted'), 0)
         + COALESCE((SELECT SUM(w2.waived_amount) FROM billing.waivers w2
                      WHERE w2.charge_id = c.id AND w2.status <> 'deleted'), 0) AS covered
  ) cov ON true
`;

interface WaiverRow {
  id: string;
  charge_id: string;
  community_id: string;
  unit_id: string;
  unit_code: string;
  concept: string;
  period_label: string | null;
  period_start: string | null;
  period_end: string | null;
  amount: string;
  reason: string;
  authorized_by: string | null;
  authorized_by_name: string | null;
  charge_applied_amount: string;
  charge_balance: string;
  charge_payment_status: string;
  status: string;
  created_at: Date;
  updated_at: Date;
}

function mapRow(row: WaiverRow): Waiver {
  return {
    id: row.id,
    chargeId: row.charge_id,
    communityId: row.community_id,
    unitId: row.unit_id,
    unitCode: row.unit_code,
    concept: row.concept,
    periodLabel: row.period_label,
    periodStart: row.period_start,
    periodEnd: row.period_end,
    amount: Number(row.amount),
    reason: row.reason,
    authorizedBy: row.authorized_by,
    authorizedByName: row.authorized_by_name,
    chargeAppliedAmount: Number(row.charge_applied_amount),
    chargeBalance: Number(row.charge_balance),
    chargePaymentStatus: row.charge_payment_status,
    status: row.status,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export const waiversRepository = {
  /**
   * Bloquea el cargo (FOR UPDATE) y devuelve su saldo pendiente. null =
   * inexistente, de otra comunidad o dado de baja → 404 en la route.
   *
   * El lock es lo que hace fiable el tope del monto: `sp_waive_charge` y
   * `sp_register_payment` toman el MISMO lock antes de insertar, así que entre
   * este cálculo y la inserción no cabe un pago ni otra condonación. Sin él,
   * dos condonaciones concurrentes podrían cubrir el cargo por encima de su
   * importe (la BD solo exige `waived_amount > 0`).
   */
  async lockChargeForWaiver(
    tx: TxClient,
    communityId: string,
    chargeId: string,
  ): Promise<ChargeForWaiver | null> {
    const result = await tx.query<{
      applied_amount: string;
      covered: string;
      payment_status: string;
    }>(
      `SELECT c.applied_amount::text AS applied_amount,
              ( COALESCE((SELECT SUM(pa.amount) FROM billing.payment_allocations pa
                           WHERE pa.charge_id = c.id AND pa.status <> 'deleted'), 0)
              + COALESCE((SELECT SUM(w.waived_amount) FROM billing.waivers w
                           WHERE w.charge_id = c.id AND w.status <> 'deleted'), 0)
              )::text AS covered,
              c.payment_status
         FROM billing.charges c
        WHERE c.id = $1 AND c.community_id = $2 AND c.status = 'active'
          FOR UPDATE OF c`,
      [chargeId, communityId],
    );
    const row = result.rows[0];
    if (row === undefined) {
      return null;
    }
    const appliedAmount = Number(row.applied_amount);
    const covered = Number(row.covered);
    return {
      appliedAmount,
      covered,
      balance: Number((appliedAmount - covered).toFixed(2)),
      paymentStatus: row.payment_status,
    };
  },

  /**
   * Condona el cargo vía billing.sp_waive_charge y devuelve la fila creada.
   *
   * El procedure no expone el id (no tiene INOUT, a diferencia de
   * `sp_register_payment`), así que la fila se relee como la ÚLTIMA
   * condonación del cargo. Es determinista porque quien llama mantiene el
   * cargo bloqueado desde {@link lockChargeForWaiver}: ninguna otra
   * transacción puede insertar un waiver para este cargo mientras tanto, y el
   * id es UUIDv7 (ordenado por tiempo de generación), luego el máximo es el
   * recién insertado.
   */
  async create(
    tx: TxClient,
    chargeId: string,
    amount: number,
    reason: string,
  ): Promise<Waiver> {
    // authorized_by va NULL: el procedure lo resuelve con el GUC audit.user_id
    // (el actor de la sesión), que withTransaction ya fijó.
    await tx.query(`CALL billing.sp_waive_charge($1, $2, $3, NULL)`, [
      chargeId,
      amount,
      reason,
    ]);

    const created = await tx.query<WaiverRow>(
      `SELECT ${SELECT_COLUMNS}
       ${FROM_JOINS}
        WHERE w.charge_id = $1 AND w.status = 'active'
        ORDER BY w.id DESC
        LIMIT 1`,
      [chargeId],
    );
    const row = created.rows[0];
    if (row === undefined) {
      throw new Error("sp_waive_charge no dejó rastro de la condonación creada");
    }
    return mapRow(row);
  },

  /** Historial de condonaciones de la comunidad (paginado, más reciente primero). */
  async list(
    tx: TxClient,
    input: ListWaiversInput,
  ): Promise<{ items: Waiver[]; total: number }> {
    const chargeId = input.chargeId ?? null;
    const unitId = input.unitId ?? null;
    const from = input.from ?? null;
    const to = input.to ?? null;
    const offset = (input.page - 1) * input.pageSize;

    const where = `
      WHERE c.community_id = $1
        AND w.status <> 'deleted'
        AND ($2::uuid IS NULL OR w.charge_id = $2::uuid)
        AND ($3::uuid IS NULL OR c.unit_id   = $3::uuid)
        -- ::date recorta el instante en la zona de la SESIÓN (config.dbTimezone),
        -- no en UTC: "del 1 al 15" son los días de la comunidad.
        AND ($4::date IS NULL OR w.created_at::date >= $4::date)
        AND ($5::date IS NULL OR w.created_at::date <= $5::date)
    `;

    const totalResult = await tx.query<{ count: string }>(
      `SELECT count(*)::bigint AS count ${FROM_JOINS} ${where}`,
      [input.communityId, chargeId, unitId, from, to],
    );
    const total = Number(totalResult.rows[0]?.count ?? 0);

    const itemsResult = await tx.query<WaiverRow>(
      `SELECT ${SELECT_COLUMNS}
       ${FROM_JOINS}
       ${where}
        ORDER BY w.created_at DESC, w.id DESC
        LIMIT $6 OFFSET $7`,
      [input.communityId, chargeId, unitId, from, to, input.pageSize, offset],
    );

    return { items: itemsResult.rows.map(mapRow), total };
  },

  /** Una condonación de la comunidad (activa o ya revertida). null = fuera. */
  async getById(tx: TxClient, communityId: string, id: string): Promise<Waiver | null> {
    const result = await tx.query<WaiverRow>(
      `SELECT ${SELECT_COLUMNS}
       ${FROM_JOINS}
        WHERE w.id = $1 AND c.community_id = $2 AND w.status <> 'deleted'`,
      [id, communityId],
    );
    const row = result.rows[0];
    return row === undefined ? null : mapRow(row);
  },

  /**
   * Revierte la condonación: baja lógica del waiver y recálculo del estatus de
   * cobro del cargo (vía sancionada). `false` = no existe, no es de esta
   * comunidad o ya estaba revertida.
   *
   * El filtro de comunidad va DENTRO del UPDATE (no en una lectura previa):
   * una sola sentencia decide y actúa, sin ventana entre comprobar y escribir.
   */
  async softDelete(tx: TxClient, communityId: string, id: string): Promise<boolean> {
    const result = await tx.query<{ charge_id: string }>(
      `UPDATE billing.waivers w
          SET status = 'deleted'
        WHERE w.id = $1
          AND w.status <> 'deleted'
          AND EXISTS (
                SELECT 1 FROM billing.charges c
                 WHERE c.customer_id  = w.customer_id
                   AND c.id           = w.charge_id
                   AND c.community_id = $2
              )
        RETURNING w.charge_id`,
      [id, communityId],
    );
    const chargeId = result.rows[0]?.charge_id;
    if (chargeId === undefined) {
      return false;
    }
    // El cargo vuelve a pending/partial según lo que quede cubierto.
    await tx.query(`CALL billing.sp_refresh_charge_payment_status($1)`, [chargeId]);
    return true;
  },
};
