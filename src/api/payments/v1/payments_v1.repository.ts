import type { TxClient } from "../../../core/db/with_transaction";
import {
  paymentEvidenceRepository,
  type PaymentEvidenceSummary,
} from "../../payment-evidence/v1/payment_evidence_v1.repository";

// Acceso a datos del recurso payments. El alta va SIEMPRE por
// billing.sp_register_payment (vía sancionada: valida suma exacta, bloquea
// cada cargo y recalcula payment_status); la baja es soft-delete del
// encabezado + sus aplicaciones + recálculo por cargo con
// billing.sp_refresh_charge_payment_status.

/** Caja a la que entró el depósito (null = sin declarar). */
export interface PaymentCashAccountRef {
  readonly id: string;
  readonly name: string;
}

export interface Payment {
  readonly id: string;
  /** Comunidad dueña del depósito. Todos sus cargos son de ella (lo garantiza
   *  billing.sp_register_payment al derivarla de los cargos). */
  readonly communityId: string;
  readonly amount: number;
  readonly method: string;
  readonly paidAt: string;
  readonly reference: string | null;
  readonly cashAccount: PaymentCashAccountRef | null;
  readonly status: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface PaymentAllocation {
  readonly id: string;
  readonly chargeId: string;
  readonly unitId: string;
  readonly unitCode: string;
  /** Torre y tipo de la unidad: el recibo que saca el RESIDENTE la nombra por
   *  su tipo ("casa 426-A"); el del operador sigue leyendo el código. */
  readonly unitTower: string | null;
  readonly unitType: string;
  readonly communityId: string;
  readonly concept: string;
  readonly amount: number;
  /** Periodo del cargo cubierto, resuelto EN VIVO (igual que `periods` del
   *  listado): un periodo renombrado después del pago se lee ya renombrado.
   *  `label` null = sin alias propio; el cliente deriva uno del rango. Los TRES
   *  van null cuando el cargo es SUELTO (una venta de tarjetas no devenga
   *  periodo); el concepto y la cantidad son entonces toda su identidad. */
  readonly periodLabel: string | null;
  readonly periodStart: string | null;
  readonly periodEnd: string | null;
  /** Lo cubierto, legible ("Mantenimiento ×2" / "Septiembre-2026"; periodo null
   *  en un cargo suelto). INTERNOS: alimentan el aviso push y el verifier de
   *  salida los descarta — el cliente arma su propia etiqueta. */
  readonly coverConcept: string;
  readonly coverPeriod: string | null;
}

export interface PaymentDetail extends Payment {
  /** Quién capturó el pago ("Recibido por" del recibo): `payments.created_by`
   *  resuelto contra el espejo core.users. null = sin fila de espejo. */
  readonly createdByName: string | null;
  readonly allocations: PaymentAllocation[];
  /** Comprobante que respalda el pago. null = no hay (pago de ventanilla sin
   *  archivo) o el actor no puede verlo (operador sin `payment_evidence.read`). */
  readonly evidence: PaymentEvidenceSummary | null;
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
  /** Conceptos (distintos) de las CUOTAS de esos cargos, alfabéticos. Es lo
   *  que el depósito pagó ("Mantenimiento", "Tarjeta de acceso"); se resuelve
   *  EN VIVO contra `billing.fees` —igual que el periodo— así que renombrar la
   *  cuota se lee renombrado en el historial de pagos. */
  readonly concepts: string[];
}

export interface RegisterPaymentInput {
  readonly amount: number;
  readonly method: string;
  readonly paidAt?: string | null;
  readonly reference?: string | null;
  readonly cashAccountId?: string | null;
  readonly allocations: ReadonlyArray<{ readonly chargeId: string; readonly amount: number }>;
}

export interface ListPaymentsInput {
  readonly communityId: string;
  readonly page: number;
  readonly pageSize: number;
  readonly method?: string | null;
  readonly cashAccountId?: string | null;
  readonly from?: string | null;
  readonly to?: string | null;
}

// La caja del depósito viaja resuelta (id + nombre) para que el cliente no
// tenga que cruzar catálogos. LEFT JOIN: el pago histórico no declara caja.
//
// `created_by_name`: quién capturó el pago, contra el espejo core.users (PK
// compuesta customer_id + id). LEFT JOIN: un usuario sin fila de espejo deja
// el nombre en null y el recibo imprime "—", no desaparece el pago.
export const PAYMENT_DETAIL_COLUMNS = `
  p.id, p.community_id, p.amount::text AS amount, p.method, p.paid_at, p.reference,
  ca.id AS cash_account_id, ca.name AS cash_account_name,
  cu.full_name AS created_by_name,
  p.status, p.created_at, p.updated_at
`;

export const PAYMENT_DETAIL_JOINS = `
  LEFT JOIN billing.cash_accounts ca
    ON ca.customer_id = p.customer_id AND ca.id = p.cash_account_id
  LEFT JOIN core.users cu
    ON cu.customer_id = p.customer_id AND cu.id = p.created_by
`;

export interface PaymentRow {
  id: string;
  community_id: string;
  amount: string;
  method: string;
  paid_at: Date;
  reference: string | null;
  cash_account_id: string | null;
  cash_account_name: string | null;
  /** Solo lo traen las consultas de DETALLE (PAYMENT_DETAIL_COLUMNS). */
  created_by_name?: string | null;
  status: string;
  created_at: Date;
  updated_at: Date;
}

export function mapRow(row: PaymentRow): Payment {
  return {
    id: row.id,
    communityId: row.community_id,
    amount: Number(row.amount),
    method: row.method,
    // Instante absoluto: `pg` lee el TIMESTAMPTZ como un Date de JS (que es un
    // punto en el tiempo, no una lectura de reloj) y `toISOString` lo emite en
    // UTC. El cliente lo vuelve a su zona al pintarlo, así que el reloj que ve
    // el usuario es el suyo aunque el servidor esté en otro continente.
    paidAt: row.paid_at.toISOString(),
    reference: row.reference,
    cashAccount:
      row.cash_account_id !== null && row.cash_account_name !== null
        ? { id: row.cash_account_id, name: row.cash_account_name }
        : null,
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
  unit_tower: string | null;
  unit_type: string;
  community_id: string;
  concept: string;
  amount: string;
  period_label: string | null;
  period_start: string | null;
  period_end: string | null;
  cover_concept: string;
  cover_period: string | null;
}

function mapAllocationRow(row: AllocationRow): PaymentAllocation {
  return {
    id: row.id,
    chargeId: row.charge_id,
    unitId: row.unit_id,
    unitCode: row.unit_code,
    unitTower: row.unit_tower,
    unitType: row.unit_type,
    communityId: row.community_id,
    concept: row.concept,
    amount: Number(row.amount),
    periodLabel: row.period_label,
    periodStart: row.period_start,
    periodEnd: row.period_end,
    coverConcept: row.cover_concept,
    coverPeriod: row.cover_period,
  };
}

/**
 * Aplicaciones activas del pago. UNA sola consulta para las dos superficies
 * —el detalle del operador y `GET /me/payments/:id` del residente— porque el
 * mismo cargo debe llamarse igual en el recibo que emite el administrador y en
 * el que saca el residente.
 *
 * `memberUserId` es la frontera del OPERADOR: un depósito puede repartirse
 * entre comunidades y solo se devuelven las de comunidades donde el actor
 * tiene membresía activa. Sin ese filtro, ver un pago por una sola de sus
 * comunidades filtraría unidad, concepto e importe de las demás.
 *
 * Con `null` NO se filtra: es la lectura del residente, cuyo alcance ya midió
 * el caller sobre el pago (al menos una aplicación sobre una unidad suya). Ve
 * el depósito COMPLETO a propósito — un mismo folio con dos cifras distintas
 * confunde más de lo que protege.
 */
export async function fetchPaymentAllocations(
  tx: TxClient,
  paymentId: string,
  memberUserId: string | null,
): Promise<PaymentAllocation[]> {
  const result = await tx.query<AllocationRow>(
    `SELECT pa.id, pa.charge_id, pa.unit_id, u.code AS unit_code,
            u.tower AS unit_tower, u.unit_type::text AS unit_type,
            c.community_id, f.concept, pa.amount::text AS amount,
            -- Nombre LEGIBLE de lo cubierto, con el mismo alias que el estado
            -- de cuenta y "Mis pagos" (concepto con piezas + periodo propio o
            -- derivado). No viaja en el contrato: lo usa el aviso push.
            f.concept || CASE WHEN c.quantity > 1 THEN ' ×' || c.quantity ELSE '' END
              AS cover_concept,
            COALESCE(fp.label, billing.fn_format_period_es(c.period_start, c.period_end))
              AS cover_period,
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
       -- LEFT: un cargo SUELTO (venta de tarjetas) no tiene periodo. Con un
       -- INNER, su aplicación desaparecería del detalle y la suma de las
       -- aplicaciones mostradas no cuadraría con el monto del depósito.
       LEFT JOIN billing.fee_periods fp
         ON fp.customer_id = c.customer_id AND fp.id = c.period_id
       JOIN community.units u ON u.customer_id = pa.customer_id AND u.id = pa.unit_id
      WHERE pa.payment_id = $1 AND pa.status != 'deleted'
        AND ($2::uuid IS NULL OR EXISTS (
              SELECT 1
                FROM community.community_members cm
               WHERE cm.customer_id  = c.customer_id
                 AND cm.community_id = c.community_id
                 AND cm.user_id      = $2::uuid
                 AND cm.status       = 'active'))
      ORDER BY u.code, c.due_date, c.created_at`,
    [paymentId, memberUserId],
  );
  return result.rows.map(mapAllocationRow);
}

/**
 * Arma el detalle a partir del encabezado ya leído (con PAYMENT_DETAIL_COLUMNS)
 * — el punto único donde nace un `PaymentDetail`, para que el del operador y
 * el del residente no puedan divergir en forma.
 */
export async function buildPaymentDetail(
  tx: TxClient,
  row: PaymentRow,
  scope: {
    /** Frontera de las aplicaciones (ver `fetchPaymentAllocations`). */
    readonly memberUserId: string | null;
    /** `false` = el actor no puede ver comprobantes → `evidence: null`. */
    readonly includeEvidence: boolean;
    /** Frontera del comprobante en el portal (ver `getSummaryByPaymentId`). */
    readonly residentUserId?: string | null;
  },
): Promise<PaymentDetail> {
  return {
    ...mapRow(row),
    createdByName: row.created_by_name ?? null,
    allocations: await fetchPaymentAllocations(tx, row.id, scope.memberUserId),
    evidence: scope.includeEvidence
      ? await paymentEvidenceRepository.getSummaryByPaymentId(tx, {
          paymentId: row.id,
          communityId: row.community_id,
          residentUserId: scope.residentUserId ?? null,
        })
      : null,
  };
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
      `CALL billing.sp_register_payment($1, $2::billing.payment_method, $3::jsonb, COALESCE($4::timestamptz, now()), $5, $6::uuid, NULL)`,
      [
        input.amount,
        input.method,
        JSON.stringify(
          input.allocations.map((a) => ({ charge_id: a.chargeId, amount: a.amount })),
        ),
        input.paidAt ?? null,
        input.reference ?? null,
        input.cashAccountId ?? null,
      ],
    );
    const paymentId = call.rows[0]?.p_payment_id ?? null;
    if (paymentId === null) {
      throw new Error("sp_register_payment no devolvió el id del pago creado");
    }

    const created = await tx.query<PaymentRow>(
      `SELECT ${PAYMENT_DETAIL_COLUMNS} FROM billing.payments p ${PAYMENT_DETAIL_JOINS} WHERE p.id = $1`,
      [paymentId],
    );
    const row = created.rows[0];
    if (row === undefined) {
      throw new Error("sp_register_payment no dejó rastro del pago creado");
    }
    // El alcance ya se validó antes de llamar (todos los cargos son del actor),
    // así que el filtro de las aplicaciones no resta nada aquí. Sin comprobante:
    // un pago recién registrado por esta vía no respalda evidencia alguna (la
    // verificación estampa el vínculo DESPUÉS, en su propia sp).
    return buildPaymentDetail(tx, row, { memberUserId: userId, includeEvidence: false });
  },

  /**
   * Pagos de la comunidad (paginado). El filtro es `p.community_id` —el
   * depósito ya declara de quién es— y no un cruce hacia los cargos: eso deja
   * el trabajo al índice (community_id, paid_at DESC) y saca del WHERE una
   * condición sobre una tabla que aquí solo aporta contexto de display.
   * `allocatedToCommunity` = suma de sus aplicaciones activas; con la comunidad
   * en el encabezado ya no puede ser una fracción del depósito, pero se
   * conserva porque una aplicación anulada suelta sí la separaría de `amount`.
   */
  async list(
    tx: TxClient,
    input: ListPaymentsInput,
  ): Promise<{ items: PaymentListItem[]; total: number }> {
    const method = input.method ?? null;
    const cashAccountId = input.cashAccountId ?? null;
    const from = input.from ?? null;
    const to = input.to ?? null;
    const offset = (input.page - 1) * input.pageSize;

    const fromWhere = `
      FROM billing.payments p
      JOIN billing.payment_allocations pa
        ON pa.customer_id = p.customer_id AND pa.payment_id = p.id AND pa.status != 'deleted'
      JOIN billing.charges c
        ON c.customer_id = pa.customer_id AND c.id = pa.charge_id
      -- INNER, a diferencia del periodo: charges.fee_id es NOT NULL —el cargo
      -- suelto también sale de una cuota, de ahí toma su concepto—, así que
      -- este JOIN no puede perder filas.
      JOIN billing.fees f
        ON f.customer_id = c.customer_id AND f.id = c.fee_id
      -- LEFT: un cargo SUELTO no tiene periodo. Con un INNER, un depósito que
      -- solo cubre ventas de tarjetas no aparecería en el listado.
      LEFT JOIN billing.fee_periods fp
        ON fp.customer_id = c.customer_id AND fp.id = c.period_id
      -- LEFT: el pago histórico no declara caja.
      LEFT JOIN billing.cash_accounts ca
        ON ca.customer_id = p.customer_id AND ca.id = p.cash_account_id
      JOIN community.units u
        ON u.customer_id = pa.customer_id AND u.id = pa.unit_id
     WHERE p.community_id = $1
       AND p.status != 'deleted'
       AND ($2::billing.payment_method IS NULL OR p.method = $2::billing.payment_method)
       AND ($3::uuid IS NULL OR p.cash_account_id = $3::uuid)
       -- ::date recorta el instante en la zona de la SESIÓN, que el pool fija a
       -- config.dbTimezone. Filtrar "del 1 al 15" significa así los días de la
       -- comunidad; en UTC, un pago de las 19:00 del 15 quedaría fuera.
       AND ($4::date IS NULL OR p.paid_at::date >= $4::date)
       AND ($5::date IS NULL OR p.paid_at::date <= $5::date)
    `;

    const totalResult = await tx.query<{ count: string }>(
      `SELECT count(DISTINCT p.id)::bigint AS count ${fromWhere}`,
      [input.communityId, method, cashAccountId, from, to],
    );
    const total = Number(totalResult.rows[0]?.count ?? 0);

    const itemsResult = await tx.query<
      PaymentRow & {
        allocated: string;
        units: PaymentUnitRef[];
        periods: PaymentPeriodRef[];
        concepts: string[];
      }
    >(
      `SELECT p.id, p.community_id, p.amount::text AS amount, p.method, p.paid_at, p.reference,
              ca.id AS cash_account_id, ca.name AS cash_account_name,
              p.status, p.created_at, p.updated_at,
              SUM(pa.amount)::text AS allocated,
              jsonb_agg(DISTINCT jsonb_build_object('id', u.id, 'code', u.code)) AS units,
              -- FILTER: los cargos SUELTOS no tienen periodo y sin él el
              -- agregado metería un objeto de puros null en la lista. Un pago
              -- que solo cubre ventas queda con la lista vacía (COALESCE
              -- abajo), que es exactamente lo que hay que decir.
              COALESCE(jsonb_agg(DISTINCT jsonb_build_object(
                'id', fp.id, 'label', fp.label,
                'periodStart', fp.period_start, 'periodEnd', fp.period_end))
                FILTER (WHERE fp.id IS NOT NULL), '[]'::jsonb) AS periods,
              -- Conceptos de las cuotas cubiertas. DISTINCT sobre el texto (y
              -- no sobre la cuota): dos cuotas homónimas dicen lo mismo en el
              -- listado, y el agregado ya los devuelve alfabéticos.
              jsonb_agg(DISTINCT f.concept) AS concepts
         ${fromWhere}
        GROUP BY p.id, p.community_id, p.amount, p.method, p.paid_at, p.reference,
                 ca.id, ca.name, p.status, p.created_at, p.updated_at
        ORDER BY p.paid_at DESC, p.id DESC
        LIMIT $6 OFFSET $7`,
      [input.communityId, method, cashAccountId, from, to, input.pageSize, offset],
    );

    return {
      items: itemsResult.rows.map((row) => ({
        ...mapRow(row),
        allocatedToCommunity: Number(row.allocated),
        units: row.units,
        // DISTINCT del agregado ordena por el jsonb, no por fecha: se reordena
        // aqui para que el listado lea cronologico.
        periods: [...row.periods].sort((a, b) => a.periodStart.localeCompare(b.periodStart)),
        concepts: row.concepts,
      })),
      total,
    };
  },

  /**
   * Un pago con sus aplicaciones, visible si el actor alcanza SU comunidad.
   * null = inexistente o fuera de alcance.
   *
   * El alcance se mide contra `p.community_id` y ya no recorriendo las
   * aplicaciones: el depósito declara de quién es. Eso además arregla un
   * agujero del modelo viejo — un pago cuyas aplicaciones estaban todas
   * anuladas no tocaba comunidad alguna y se volvía invisible para todos,
   * incluido su propio dueño.
   */
  async getById(
    tx: TxClient,
    userId: string,
    id: string,
    options: { readonly includeEvidence: boolean } = { includeEvidence: false },
  ): Promise<PaymentDetail | null> {
    const result = await tx.query<PaymentRow>(
      `SELECT ${PAYMENT_DETAIL_COLUMNS}
         FROM billing.payments p
         ${PAYMENT_DETAIL_JOINS}
         JOIN community.community_members cm
           ON cm.customer_id  = p.customer_id
          AND cm.community_id = p.community_id
          AND cm.user_id      = $2
          AND cm.status       = 'active'
        WHERE p.id = $1
          AND p.status != 'deleted'`,
      [id, userId],
    );
    const row = result.rows[0];
    if (row === undefined) {
      return null;
    }
    return buildPaymentDetail(tx, row, {
      memberUserId: userId,
      includeEvidence: options.includeEvidence,
    });
  },

  /**
   * Comunidad del pago, como lista de una sola entrada: la anulación mide el
   * alcance contra ella. Se conserva la forma de arreglo porque el controller
   * distingue "sin comunidad alcanzable" (pago inexistente → lista vacía) de
   * "alcanzable", y esa lógica no depende de cuántas haya.
   */
  async getTouchedCommunities(tx: TxClient, paymentId: string): Promise<string[]> {
    const result = await tx.query<{ community_id: string }>(
      `SELECT p.community_id
         FROM billing.payments p
        WHERE p.id = $1 AND p.status != 'deleted'`,
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

    // Si este pago respaldaba una evidencia verificada, la evidencia REGRESA a
    // pending_review en esta MISMA transacción: un "verificado" apuntando a un
    // pago anulado sería mentira, y el comprobante sigue pendiente de que
    // alguien lo atienda (de nuevo). El rastro queda en audit.event_log.
    await paymentEvidenceRepository.resetByPaymentId(tx, id);
    return true;
  },
};
