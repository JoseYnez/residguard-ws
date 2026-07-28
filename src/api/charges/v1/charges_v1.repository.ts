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
  /** Periodo del cargo; null = cargo SUELTO (no devenga periodo — §4 de la BD). */
  readonly periodId: string | null;
  /** Nombre propio del periodo ("Cuota extraordinaria bardas"); null = sin
   *  etiqueta (el cliente deriva una del rango) o cargo suelto. */
  readonly periodLabel: string | null;
  readonly concept: string;
  /** Rango del periodo; null en un cargo suelto (viaja con `periodId`). */
  readonly periodStart: string | null;
  readonly periodEnd: string | null;
  /** Piezas que cubre el cargo (2 tarjetas). Siempre 1 en un cargo devengado. */
  readonly quantity: number;
  readonly appliedAmount: number;
  readonly balance: number;
  readonly dueDate: string;
  readonly paymentStatus: string;
  readonly overdue: boolean;
  /** Detalle libre del cargo (folios, motivo de la multa). */
  readonly note: string | null;
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

/**
 * Alta de un cargo SUELTO: la venta de N tarjetas de acceso, una multa. No hay
 * periodo — la cuota (`one_time`) solo presta concepto y precio unitario — y por
 * eso se puede repetir cuantas veces haga falta sobre la misma unidad.
 * `appliedAmount` es el TOTAL; omitirlo deja que el procedure calcule
 * base_amount × quantity.
 */
export interface AddUnitChargeInput {
  readonly feeId: string;
  readonly quantity: number;
  readonly appliedAmount?: number | null;
  readonly dueDate?: string | null;
  readonly note?: string | null;
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
  period_id: string | null;
  period_label: string | null;
  concept: string;
  period_start: string | null;
  period_end: string | null;
  quantity: number;
  applied_amount: string;
  balance: string;
  due_date: string;
  payment_status: string;
  overdue: boolean;
  note: string | null;
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
    periodId: row.period_id,
    periodLabel: row.period_label,
    concept: row.concept,
    periodStart: row.period_start,
    periodEnd: row.period_end,
    quantity: Number(row.quantity),
    appliedAmount: Number(row.applied_amount),
    balance: Number(row.balance),
    dueDate: row.due_date,
    paymentStatus: row.payment_status,
    overdue: row.overdue,
    note: row.note,
    status: row.status,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

/** Columnas del contrato Charge. Una sola definición para el listado y para la
 *  relectura tras un alta: si divergen, `mapRow` recibe filas incompletas. */
const CHARGE_COLUMNS = `
  c.id, c.unit_id, u.code AS unit_code, c.community_id, c.fee_id,
  c.period_id, fp.label AS period_label, f.concept,
  c.period_start::text AS period_start, c.period_end::text AS period_end,
  c.quantity, c.applied_amount::text AS applied_amount,
  (c.applied_amount - cov.covered)::text AS balance,
  c.due_date::text AS due_date, c.payment_status,
  (c.due_date < CURRENT_DATE AND cov.covered < c.applied_amount) AS overdue,
  c.note, c.status, c.created_at, c.updated_at
`;

/** Cargos con saldo: aplicaciones y condonaciones activas agregadas por cargo. */
const FROM_WITH_BALANCE = `
  FROM billing.charges c
  JOIN billing.fees f
    ON f.customer_id = c.customer_id AND f.id = c.fee_id
  -- LEFT: un cargo SUELTO no tiene periodo. Con un INNER, una venta de tarjetas
  -- desaparecería del estado de cuenta y del picker de pagos.
  LEFT JOIN billing.fee_periods fp
    ON fp.customer_id = c.customer_id AND fp.id = c.period_id
  JOIN community.units u
    ON u.customer_id = c.customer_id AND u.id = c.unit_id
  LEFT JOIN LATERAL (
    SELECT COALESCE((SELECT SUM(pa.amount) FROM billing.payment_allocations pa
                      WHERE pa.charge_id = c.id AND pa.status <> 'deleted'), 0)
         + COALESCE((SELECT SUM(w.waived_amount) FROM billing.waivers w
                      WHERE w.charge_id = c.id AND w.status <> 'deleted'), 0) AS covered
  ) cov ON true
`;

/** Un cargo por id, con saldo y `overdue` derivados. Módulo (no método) para
 *  que el alta pueda releer la fila recién creada sin `this`. */
async function selectChargeById(tx: TxClient, id: string): Promise<Charge | null> {
  const result = await tx.query<ChargeRow>(
    `SELECT ${CHARGE_COLUMNS} ${FROM_WITH_BALANCE} WHERE c.id = $1`,
    [id],
  );
  const row = result.rows[0];
  return row === undefined ? null : mapRow(row);
}

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
      `SELECT ${CHARGE_COLUMNS}
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
         RETURNING customer_id, id, unit_id, community_id, fee_id, period_id,
                   period_start, period_end, quantity, applied_amount, due_date,
                   payment_status, note, status, created_at, updated_at
       )
       SELECT ins.id, ins.unit_id, u.code AS unit_code, ins.community_id, ins.fee_id,
              ins.period_id, fp.label AS period_label, f.concept,
              ins.period_start::text AS period_start, ins.period_end::text AS period_end,
              ins.quantity, ins.applied_amount::text AS applied_amount,
              ins.applied_amount::text AS balance,
              ins.due_date::text AS due_date, ins.payment_status,
              (ins.due_date < CURRENT_DATE) AS overdue,
              ins.note, ins.status, ins.created_at, ins.updated_at
         FROM ins
         JOIN billing.fees f         ON f.customer_id  = ins.customer_id AND f.id  = ins.fee_id
         JOIN billing.fee_periods fp ON fp.customer_id = ins.customer_id AND fp.id = ins.period_id
         JOIN community.units u      ON u.customer_id  = ins.customer_id AND u.id  = ins.unit_id`,
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

  /**
   * Registra un cargo SUELTO sobre la unidad vía la vía sancionada
   * billing.sp_add_unit_charge y devuelve la fila creada. La sp exige cuota
   * ACTIVA y `one_time` de la comunidad de la unidad, y devuelve el id por su
   * INOUT `p_charge_id`.
   *
   * NO es idempotente, a propósito: dos llamadas registran dos ventas — es la
   * diferencia entre este alta y la de un cargo devengado, que
   * `uq_charges_period_unit` limita a uno por periodo y unidad.
   *
   * Puede lanzar P0002 (cuota o unidad fuera de alcance / no activas), 22023
   * (la cuota es recurrente) o 23514 (cantidad o monto inválidos).
   */
  async addUnitCharge(
    tx: TxClient,
    unitId: string,
    input: AddUnitChargeInput,
  ): Promise<Charge | null> {
    const call = await tx.query<{ p_charge_id: string | null }>(
      `CALL billing.sp_add_unit_charge($1, $2, $3::int, $4, $5::date, $6, NULL)`,
      [
        input.feeId,
        unitId,
        input.quantity,
        input.appliedAmount ?? null,
        input.dueDate ?? null,
        input.note ?? null,
      ],
    );
    const chargeId = call.rows[0]?.p_charge_id ?? null;
    if (chargeId === null) {
      throw new Error("sp_add_unit_charge no devolvió el id del cargo");
    }
    return selectChargeById(tx, chargeId);
  },

  /** Un cargo por id, con saldo y `overdue` derivados (misma forma que el
   *  listado). null = inexistente o de otro tenant (RLS). */
  getById(tx: TxClient, id: string): Promise<Charge | null> {
    return selectChargeById(tx, id);
  },

  /**
   * Baja lógica del cargo, SOLO si nadie le ha aplicado dinero.
   *
   * El guard va dentro del UPDATE, no en una lectura previa: `sp_register_payment`
   * toma `FOR UPDATE` sobre el cargo antes de insertar su aplicación, así que
   * comprobar y anular en la misma sentencia serializa las dos operaciones. Con
   * un SELECT previo cabría que un pago se colara entre la comprobación y el
   * UPDATE, y la aplicación quedaría colgando de un cargo eliminado.
   *
   * Las condonaciones bloquean igual: un cargo condonado sí existió (la deuda
   * se perdonó), anularlo reescribiría la historia y dejaría el waiver huérfano.
   *
   * `false` = no existía, no es de la comunidad, ya estaba de baja, o tiene
   * movimientos. Quién de las dos cosas lo dice {@link revocationBlocked}.
   */
  async softDelete(tx: TxClient, communityId: string, id: string): Promise<boolean> {
    const result = await tx.query(
      `UPDATE billing.charges c SET status = 'deleted'
        WHERE c.id = $1 AND c.community_id = $2 AND c.status = 'active'
          AND NOT EXISTS (
                SELECT 1 FROM billing.payment_allocations pa
                 WHERE pa.charge_id = c.id AND pa.status <> 'deleted'
              )
          AND NOT EXISTS (
                SELECT 1 FROM billing.waivers w
                 WHERE w.charge_id = c.id AND w.status <> 'deleted'
              )`,
      [id, communityId],
    );
    return (result.rowCount ?? 0) > 0;
  },

  /**
   * Diagnóstico tras un {@link softDelete} que no tocó filas: ¿fue porque el
   * cargo tiene movimientos (→ 409) o porque no existe/está fuera (→ 404)?
   * Solo se llama en ese caso, así que el camino feliz sigue siendo una
   * sentencia.
   */
  async revocationBlocked(tx: TxClient, communityId: string, id: string): Promise<boolean> {
    const result = await tx.query<{ blocked: boolean }>(
      `SELECT ( EXISTS (SELECT 1 FROM billing.payment_allocations pa
                         WHERE pa.charge_id = c.id AND pa.status <> 'deleted')
             OR EXISTS (SELECT 1 FROM billing.waivers w
                         WHERE w.charge_id = c.id AND w.status <> 'deleted')
              ) AS blocked
         FROM billing.charges c
        WHERE c.id = $1 AND c.community_id = $2 AND c.status = 'active'`,
      [id, communityId],
    );
    return result.rows[0]?.blocked ?? false;
  },
};
