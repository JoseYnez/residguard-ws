import type { TxClient } from "../../../core/db/with_transaction";

// Acceso a datos del recurso payments. El alta va SIEMPRE por
// billing.sp_register_payment (vía sancionada: valida suma exacta, bloquea
// cada cargo y recalcula payment_status); la baja es soft-delete del
// encabezado + sus aplicaciones + recálculo por cargo con
// billing.sp_refresh_charge_payment_status.

export interface Payment {
  readonly id: string;
  readonly amount: number;
  readonly method: string;
  readonly paidAt: string;
  readonly reference: string | null;
  readonly status: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface PaymentAllocation {
  readonly id: string;
  readonly chargeId: string;
  readonly unitId: string;
  readonly unitCode: string;
  readonly communityId: string;
  readonly concept: string;
  readonly amount: number;
  /** Periodo del cargo cubierto, resuelto EN VIVO (igual que `periods` del
   *  listado): un periodo renombrado después del pago se lee ya renombrado.
   *  `label` null = sin alias propio; el cliente deriva uno del rango. */
  readonly periodLabel: string | null;
  readonly periodStart: string;
  readonly periodEnd: string;
}

export interface PaymentDetail extends Payment {
  readonly allocations: PaymentAllocation[];
}

/** Unidad alcanzada por un pago (contexto de display del listado). */
export interface PaymentUnitRef {
  readonly id: string;
  readonly code: string;
}

/** Periodo alcanzado por un pago. `label` null = sin alias propio (el cliente
 *  deriva uno del rango). */
export interface PaymentPeriodRef {
  readonly id: string;
  readonly label: string | null;
  readonly periodStart: string;
  readonly periodEnd: string;
}

export interface PaymentListItem extends Payment {
  readonly allocatedToCommunity: number;
  /** Unidades (de la comunidad filtrada) cuyas aplicaciones cubre el pago. */
  readonly units: PaymentUnitRef[];
  /** Periodos (distintos) de los cargos que el pago cubrió en la comunidad. */
  readonly periods: PaymentPeriodRef[];
}

export interface RegisterPaymentInput {
  readonly amount: number;
  readonly method: string;
  readonly paidAt?: string | null;
  readonly reference?: string | null;
  readonly allocations: ReadonlyArray<{ readonly chargeId: string; readonly amount: number }>;
}

export interface ListPaymentsInput {
  readonly communityId: string;
  readonly page: number;
  readonly pageSize: number;
  readonly method?: string | null;
  readonly from?: string | null;
  readonly to?: string | null;
}

const SELECT_COLUMNS = `
  id, amount::text AS amount, method, paid_at, reference, status, created_at, updated_at
`;

interface PaymentRow {
  id: string;
  amount: string;
  method: string;
  paid_at: Date;
  reference: string | null;
  status: string;
  created_at: Date;
  updated_at: Date;
}

function mapRow(row: PaymentRow): Payment {
  return {
    id: row.id,
    amount: Number(row.amount),
    method: row.method,
    // Instante absoluto: `pg` lee el TIMESTAMPTZ como un Date de JS (que es un
    // punto en el tiempo, no una lectura de reloj) y `toISOString` lo emite en
    // UTC. El cliente lo vuelve a su zona al pintarlo, así que el reloj que ve
    // el usuario es el suyo aunque el servidor esté en otro continente.
    paidAt: row.paid_at.toISOString(),
    reference: row.reference,
    status: row.status,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

interface AllocationRow {
  id: string;
  charge_id: string;
  unit_id: string;
  unit_code: string;
  community_id: string;
  concept: string;
  amount: string;
  period_label: string | null;
  period_start: string;
  period_end: string;
}

function mapAllocationRow(row: AllocationRow): PaymentAllocation {
  return {
    id: row.id,
    chargeId: row.charge_id,
    unitId: row.unit_id,
    unitCode: row.unit_code,
    communityId: row.community_id,
    concept: row.concept,
    amount: Number(row.amount),
    periodLabel: row.period_label,
    periodStart: row.period_start,
    periodEnd: row.period_end,
  };
}

/**
 * Aplicaciones activas del pago, SIEMPRE acotadas al alcance del usuario: un
 * depósito puede repartirse entre comunidades y solo se devuelven las de
 * comunidades donde el actor tiene membresía activa. Sin este filtro, ver un
 * pago por una sola de sus comunidades filtraría unidad, concepto e importe de
 * las demás.
 */
async function fetchAllocations(
  tx: TxClient,
  paymentId: string,
  userId: string,
): Promise<PaymentAllocation[]> {
  const result = await tx.query<AllocationRow>(
    `SELECT pa.id, pa.charge_id, pa.unit_id, u.code AS unit_code,
            c.community_id, f.concept, pa.amount::text AS amount,
            -- Periodo del cargo por JOIN con fee_periods (no por las columnas
            -- copiadas en el cargo): así el detalle muestra el alias VIGENTE,
            -- igual que la columna "Periodos" del listado. ::text porque
            -- period_start/end son DATE y el contrato viaja como YYYY-MM-DD.
            fp.label AS period_label,
            fp.period_start::text AS period_start,
            fp.period_end::text   AS period_end
       FROM billing.payment_allocations pa
       JOIN billing.charges c ON c.customer_id = pa.customer_id AND c.id = pa.charge_id
       JOIN billing.fees f    ON f.customer_id = c.customer_id  AND f.id = c.fee_id
       JOIN billing.fee_periods fp
         ON fp.customer_id = c.customer_id AND fp.id = c.period_id
       JOIN community.units u ON u.customer_id = pa.customer_id AND u.id = pa.unit_id
       JOIN community.community_members cm
         ON cm.customer_id  = c.customer_id
        AND cm.community_id = c.community_id
        AND cm.user_id      = $2
        AND cm.status       = 'active'
      WHERE pa.payment_id = $1 AND pa.status != 'deleted'
      ORDER BY u.code`,
    [paymentId, userId],
  );
  return result.rows.map(mapAllocationRow);
}

export const paymentsRepository = {
  /**
   * ¿Cuántos de estos cargos son ACTIVOS y de comunidades del alcance del
   * usuario? Debe igualar el número de chargeIds distintos antes de registrar.
   */
  async countAccessibleCharges(
    tx: TxClient,
    userId: string,
    chargeIds: readonly string[],
  ): Promise<number> {
    const result = await tx.query<{ count: string }>(
      `SELECT count(DISTINCT c.id)::bigint AS count
         FROM billing.charges c
         JOIN community.community_members cm
           ON cm.customer_id = c.customer_id
          AND cm.community_id = c.community_id
          AND cm.user_id = $2
          AND cm.status = 'active'
        WHERE c.id = ANY($1::uuid[])
          AND c.status = 'active'`,
      [[...chargeIds], userId],
    );
    return Number(result.rows[0]?.count ?? 0);
  },

  /**
   * Registra el depósito vía billing.sp_register_payment y devuelve la fila
   * creada. La sp devuelve el id por su INOUT `p_payment_id`.
   */
  async register(
    tx: TxClient,
    userId: string,
    input: RegisterPaymentInput,
  ): Promise<PaymentDetail> {
    // El id del pago sale del INOUT p_payment_id (fila que devuelve el CALL).
    // No se busca por timestamps: el trigger de auditoría estampa created_at
    // con clock_timestamp(), que NUNCA iguala transaction_timestamp().
    const call = await tx.query<{ p_payment_id: string | null }>(
      `CALL billing.sp_register_payment($1, $2::billing.payment_method, $3::jsonb, COALESCE($4::timestamptz, now()), $5, NULL)`,
      [
        input.amount,
        input.method,
        JSON.stringify(
          input.allocations.map((a) => ({ charge_id: a.chargeId, amount: a.amount })),
        ),
        input.paidAt ?? null,
        input.reference ?? null,
      ],
    );
    const paymentId = call.rows[0]?.p_payment_id ?? null;
    if (paymentId === null) {
      throw new Error("sp_register_payment no devolvió el id del pago creado");
    }

    const created = await tx.query<PaymentRow>(
      `SELECT ${SELECT_COLUMNS} FROM billing.payments WHERE id = $1`,
      [paymentId],
    );
    const row = created.rows[0];
    if (row === undefined) {
      throw new Error("sp_register_payment no dejó rastro del pago creado");
    }
    // El alcance ya se validó antes de llamar (todos los cargos son del actor),
    // así que el filtro de fetchAllocations no resta nada aquí.
    return { ...mapRow(row), allocations: await fetchAllocations(tx, row.id, userId) };
  },

  /**
   * Pagos con al menos una aplicación activa hacia cargos de la comunidad
   * (paginado). `allocatedToCommunity` = parte del depósito aplicada ahí.
   */
  async list(
    tx: TxClient,
    input: ListPaymentsInput,
  ): Promise<{ items: PaymentListItem[]; total: number }> {
    const method = input.method ?? null;
    const from = input.from ?? null;
    const to = input.to ?? null;
    const offset = (input.page - 1) * input.pageSize;

    const fromWhere = `
      FROM billing.payments p
      JOIN billing.payment_allocations pa
        ON pa.customer_id = p.customer_id AND pa.payment_id = p.id AND pa.status != 'deleted'
      JOIN billing.charges c
        ON c.customer_id = pa.customer_id AND c.id = pa.charge_id
      JOIN billing.fee_periods fp
        ON fp.customer_id = c.customer_id AND fp.id = c.period_id
      JOIN community.units u
        ON u.customer_id = pa.customer_id AND u.id = pa.unit_id
     WHERE c.community_id = $1
       AND p.status != 'deleted'
       AND ($2::billing.payment_method IS NULL OR p.method = $2::billing.payment_method)
       -- ::date recorta el instante en la zona de la SESIÓN, que el pool fija a
       -- config.dbTimezone. Filtrar "del 1 al 15" significa así los días de la
       -- comunidad; en UTC, un pago de las 19:00 del 15 quedaría fuera.
       AND ($3::date IS NULL OR p.paid_at::date >= $3::date)
       AND ($4::date IS NULL OR p.paid_at::date <= $4::date)
    `;

    const totalResult = await tx.query<{ count: string }>(
      `SELECT count(DISTINCT p.id)::bigint AS count ${fromWhere}`,
      [input.communityId, method, from, to],
    );
    const total = Number(totalResult.rows[0]?.count ?? 0);

    const itemsResult = await tx.query<
      PaymentRow & { allocated: string; units: PaymentUnitRef[]; periods: PaymentPeriodRef[] }
    >(
      `SELECT p.id, p.amount::text AS amount, p.method, p.paid_at, p.reference,
              p.status, p.created_at, p.updated_at,
              SUM(pa.amount)::text AS allocated,
              jsonb_agg(DISTINCT jsonb_build_object('id', u.id, 'code', u.code)) AS units,
              jsonb_agg(DISTINCT jsonb_build_object(
                'id', fp.id, 'label', fp.label,
                'periodStart', fp.period_start, 'periodEnd', fp.period_end)) AS periods
         ${fromWhere}
        GROUP BY p.id, p.amount, p.method, p.paid_at, p.reference, p.status,
                 p.created_at, p.updated_at
        ORDER BY p.paid_at DESC, p.id DESC
        LIMIT $5 OFFSET $6`,
      [input.communityId, method, from, to, input.pageSize, offset],
    );

    return {
      items: itemsResult.rows.map((row) => ({
        ...mapRow(row),
        allocatedToCommunity: Number(row.allocated),
        units: row.units,
        // DISTINCT del agregado ordena por el jsonb, no por fecha: se reordena
        // aqui para que el listado lea cronologico.
        periods: [...row.periods].sort((a, b) => a.periodStart.localeCompare(b.periodStart)),
      })),
      total,
    };
  },

  /**
   * Un pago con sus aplicaciones, visible si CUALQUIERA de sus aplicaciones
   * toca una comunidad del alcance del usuario. null = inexistente/fuera.
   * Las aplicaciones devueltas son solo las de comunidades del actor.
   */
  async getById(tx: TxClient, userId: string, id: string): Promise<PaymentDetail | null> {
    const result = await tx.query<PaymentRow>(
      `SELECT ${SELECT_COLUMNS}
         FROM billing.payments p
        WHERE p.id = $1
          AND p.status != 'deleted'
          AND EXISTS (
            SELECT 1
              FROM billing.payment_allocations pa
              JOIN billing.charges c
                ON c.customer_id = pa.customer_id AND c.id = pa.charge_id
              JOIN community.community_members cm
                ON cm.customer_id = c.customer_id
               AND cm.community_id = c.community_id
               AND cm.user_id = $2
               AND cm.status = 'active'
             WHERE pa.payment_id = p.id AND pa.status != 'deleted'
          )`,
      [id, userId],
    );
    const row = result.rows[0];
    if (row === undefined) {
      return null;
    }
    return { ...mapRow(row), allocations: await fetchAllocations(tx, row.id, userId) };
  },

  /** Comunidades (distintas) tocadas por las aplicaciones activas del pago. */
  async getTouchedCommunities(tx: TxClient, paymentId: string): Promise<string[]> {
    const result = await tx.query<{ community_id: string }>(
      `SELECT DISTINCT c.community_id
         FROM billing.payment_allocations pa
         JOIN billing.charges c ON c.customer_id = pa.customer_id AND c.id = pa.charge_id
        WHERE pa.payment_id = $1 AND pa.status != 'deleted'`,
      [paymentId],
    );
    return result.rows.map((r) => r.community_id);
  },

  /** ¿Es el pago visible (existe, activo)? Sin filtro de alcance. */
  async exists(tx: TxClient, id: string): Promise<boolean> {
    const result = await tx.query(
      `SELECT 1 FROM billing.payments WHERE id = $1 AND status != 'deleted'`,
      [id],
    );
    return (result.rowCount ?? 0) > 0;
  },

  /**
   * ¿Tiene el usuario membresía activa en TODAS estas comunidades?
   *
   * CUIDADO: la lista vacía es "todas de ninguna" = true. No es un permiso —
   * es el vacío lógico. Quien llame debe decidir ANTES qué hacer con un pago
   * sin comunidades alcanzables, o convertirá esta función en un fail-open.
   */
  async userReachesAllCommunities(
    tx: TxClient,
    userId: string,
    communityIds: readonly string[],
  ): Promise<boolean> {
    if (communityIds.length === 0) {
      return true;
    }
    const result = await tx.query<{ count: string }>(
      `SELECT count(*)::bigint AS count
         FROM community.community_members cm
        WHERE cm.community_id = ANY($1::uuid[])
          AND cm.user_id = $2
          AND cm.status = 'active'`,
      [[...communityIds], userId],
    );
    return Number(result.rows[0]?.count ?? 0) === communityIds.length;
  },

  /**
   * Anula el pago: soft-delete de sus aplicaciones activas y del encabezado,
   * y recalcula payment_status de cada cargo afectado (vía sancionada).
   */
  async softDelete(tx: TxClient, id: string): Promise<boolean> {
    const affected = await tx.query<{ charge_id: string }>(
      `UPDATE billing.payment_allocations
          SET status = 'deleted'
        WHERE payment_id = $1 AND status != 'deleted'
        RETURNING charge_id`,
      [id],
    );

    const result = await tx.query(
      `UPDATE billing.payments SET status = 'deleted'
        WHERE id = $1 AND status != 'deleted'`,
      [id],
    );
    if ((result.rowCount ?? 0) === 0) {
      return false;
    }

    const chargeIds = [...new Set(affected.rows.map((r) => r.charge_id))];
    for (const chargeId of chargeIds) {
      await tx.query(`CALL billing.sp_refresh_charge_payment_status($1)`, [chargeId]);
    }
    return true;
  },
};
