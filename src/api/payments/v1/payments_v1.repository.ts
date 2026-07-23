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
}

export interface PaymentDetail extends Payment {
  readonly allocations: PaymentAllocation[];
}

export interface PaymentListItem extends Payment {
  readonly allocatedToCommunity: number;
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
  };
}

async function fetchAllocations(tx: TxClient, paymentId: string): Promise<PaymentAllocation[]> {
  const result = await tx.query<AllocationRow>(
    `SELECT pa.id, pa.charge_id, pa.unit_id, u.code AS unit_code,
            c.community_id, f.concept, pa.amount::text AS amount
       FROM billing.payment_allocations pa
       JOIN billing.charges c ON c.customer_id = pa.customer_id AND c.id = pa.charge_id
       JOIN billing.fees f    ON f.customer_id = c.customer_id  AND f.id = c.fee_id
       JOIN community.units u ON u.customer_id = pa.customer_id AND u.id = pa.unit_id
      WHERE pa.payment_id = $1 AND pa.status != 'deleted'
      ORDER BY u.code`,
    [paymentId],
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
   * creada. El id se recupera de la propia transacción: la fila insertada en
   * ella es la única visible con created_at = transaction_timestamp() y
   * created_by = actor (el id uuid_v7 ordena por tiempo → la última).
   */
  async register(
    tx: TxClient,
    userId: string,
    input: RegisterPaymentInput,
  ): Promise<PaymentDetail> {
    await tx.query(
      `CALL billing.sp_register_payment($1, $2::billing.payment_method, $3::jsonb, COALESCE($4::timestamptz, now()), $5)`,
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

    const created = await tx.query<PaymentRow>(
      `SELECT ${SELECT_COLUMNS}
         FROM billing.payments
        WHERE created_at = transaction_timestamp()
          AND created_by = $1
        ORDER BY id DESC
        LIMIT 1`,
      [userId],
    );
    const row = created.rows[0];
    if (row === undefined) {
      throw new Error("sp_register_payment no dejó rastro del pago creado");
    }
    return { ...mapRow(row), allocations: await fetchAllocations(tx, row.id) };
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
     WHERE c.community_id = $1
       AND p.status != 'deleted'
       AND ($2::billing.payment_method IS NULL OR p.method = $2::billing.payment_method)
       AND ($3::date IS NULL OR p.paid_at::date >= $3::date)
       AND ($4::date IS NULL OR p.paid_at::date <= $4::date)
    `;

    const totalResult = await tx.query<{ count: string }>(
      `SELECT count(DISTINCT p.id)::bigint AS count ${fromWhere}`,
      [input.communityId, method, from, to],
    );
    const total = Number(totalResult.rows[0]?.count ?? 0);

    const itemsResult = await tx.query<PaymentRow & { allocated: string }>(
      `SELECT p.id, p.amount::text AS amount, p.method, p.paid_at, p.reference,
              p.status, p.created_at, p.updated_at,
              SUM(pa.amount)::text AS allocated
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
      })),
      total,
    };
  },

  /**
   * Un pago con sus aplicaciones, visible si CUALQUIERA de sus aplicaciones
   * toca una comunidad del alcance del usuario. null = inexistente/fuera.
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
    return { ...mapRow(row), allocations: await fetchAllocations(tx, row.id) };
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

  /** ¿Tiene el usuario membresía activa en TODAS estas comunidades? */
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
