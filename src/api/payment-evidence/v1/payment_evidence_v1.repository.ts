import type { TxClient } from "../../../core/db/with_transaction";
import type { StorageFileMetadata } from "../../../core/storage/storage_client";

// Acceso a datos del recurso payment-evidence. La VERIFICACIÓN va SIEMPRE por
// billing.sp_verify_payment_evidence (vía sancionada: bloquea la evidencia,
// delega en sp_register_payment y estampa el vínculo); el rechazo es un UPDATE
// condicionado al estado (el CHECK de la tabla respalda el invariante).
//
// Dos fronteras de alcance sobre las MISMAS consultas:
//   * operador — membresía activa en la comunidad de la evidencia (cm)
//   * residente — la cadena del padrón: e.member_id → members.user_id = sub
// Igual que en visitas, lo que cambia es la frontera, no el contrato.

export interface EvidenceFile {
  readonly id: string;
  readonly storageFileId: string;
  readonly filename: string;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly sha256: string;
}

/** Un cargo que el remitente DIJO cubrir, resuelto EN VIVO (concepto y
 *  periodo vigentes, estatus de cobro actual). `claimedAmount` es la
 *  parcialidad declarada; null solo en declaraciones previas a la columna. */
export interface ClaimedCharge {
  readonly chargeId: string;
  readonly concept: string;
  readonly quantity: number;
  readonly appliedAmount: number;
  readonly claimedAmount: number | null;
  readonly periodLabel: string | null;
  readonly periodStart: string | null;
  readonly periodEnd: string | null;
  readonly paymentStatus: string;
}

/** Referencia mínima al pago creado al verificar (el detalle vive en /payments). */
export interface EvidencePaymentRef {
  readonly id: string;
  readonly amount: number;
  readonly method: string;
  readonly paidAt: string;
}

export interface Evidence {
  readonly id: string;
  readonly communityId: string;
  readonly unitId: string;
  readonly unitCode: string;
  readonly memberId: string;
  readonly memberName: string;
  readonly declaredAmount: number;
  readonly declaredPaidAt: string | null;
  readonly declaredMethod: string;
  readonly reference: string | null;
  readonly notes: string | null;
  readonly source: string;
  readonly evidenceStatus: string;
  readonly payment: EvidencePaymentRef | null;
  readonly resolvedAt: string | null;
  readonly resolvedBy: string | null;
  readonly resolutionNote: string | null;
  readonly files: EvidenceFile[];
  readonly claimedCharges: ClaimedCharge[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateEvidenceInput {
  readonly customerId: string;
  readonly communityId: string;
  readonly unitId: string;
  readonly memberId: string;
  readonly source: "resident" | "operator";
  readonly declaredAmount: number;
  readonly declaredPaidAt: string | null;
  readonly declaredMethod: string;
  readonly reference: string | null;
  readonly notes: string | null;
  /** Metadata YA validada contra storage (el espejo que se copia). */
  readonly files: readonly StorageFileMetadata[];
  /** Cargos que el remitente dice cubrir, con su parcialidad — YA validados
   *  por el caller (cargos activos de LA UNIDAD, sin repetidos, suma dentro
   *  del monto declarado). */
  readonly claimedCharges: readonly { readonly chargeId: string; readonly amount: number }[];
}

export interface VerifyEvidenceInput {
  readonly evidenceId: string;
  readonly amount: number;
  readonly method: string;
  readonly paidAt?: string | null;
  readonly reference?: string | null;
  readonly cashAccountId?: string | null;
  readonly allocations: ReadonlyArray<{ readonly chargeId: string; readonly amount: number }>;
}

export interface ListEvidenceInput {
  readonly communityId: string;
  readonly page: number;
  readonly pageSize: number;
  readonly status?: string | null;
  readonly unitId?: string | null;
  readonly from?: string | null;
  readonly to?: string | null;
}

// Unidad, persona y pago viajan resueltos para que el cliente no cruce
// catálogos. LEFT JOIN payments: solo las verificadas lo tienen.
const EVIDENCE_COLUMNS = `
  e.id, e.community_id, e.unit_id, u.code AS unit_code,
  e.member_id, m.full_name AS member_name,
  e.declared_amount::text AS declared_amount, e.declared_paid_at,
  e.declared_method, e.reference, e.notes, e.source, e.evidence_status,
  p.id AS payment_id, p.amount::text AS payment_amount,
  p.method AS payment_method, p.paid_at AS payment_paid_at,
  e.resolved_at, e.resolved_by, e.resolution_note,
  e.created_at, e.updated_at,
  COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
             'id', f.id, 'storageFileId', f.storage_file_id,
             'filename', f.filename, 'contentType', f.content_type,
             'sizeBytes', f.size_bytes, 'sha256', f.sha256)
           ORDER BY f.created_at)
      FROM billing.payment_evidence_files f
     WHERE f.customer_id = e.customer_id
       AND f.evidence_id = e.id
       AND f.status = 'active'
  ), '[]'::jsonb) AS files,
  COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
             'chargeId', pec.charge_id,
             'concept', f2.concept,
             'quantity', c2.quantity,
             'appliedAmount', c2.applied_amount,
             'claimedAmount', pec.claimed_amount,
             'periodLabel', fp2.label,
             'periodStart', fp2.period_start,
             'periodEnd', fp2.period_end,
             'paymentStatus', c2.payment_status)
           ORDER BY fp2.period_start NULLS LAST, c2.due_date)
      FROM billing.payment_evidence_charges pec
      JOIN billing.charges c2
        ON c2.customer_id = pec.customer_id AND c2.id = pec.charge_id
      JOIN billing.fees f2
        ON f2.customer_id = c2.customer_id AND f2.id = c2.fee_id
      -- LEFT: un cargo SUELTO no tiene periodo (regla de todo SQL de cargos).
      LEFT JOIN billing.fee_periods fp2
        ON fp2.customer_id = c2.customer_id AND fp2.id = c2.period_id
     WHERE pec.customer_id = e.customer_id
       AND pec.evidence_id = e.id
       AND pec.status = 'active'
  ), '[]'::jsonb) AS claimed_charges
`;

const EVIDENCE_FROM = `
  FROM billing.payment_evidence e
  JOIN community.units u
    ON u.customer_id = e.customer_id AND u.id = e.unit_id
  JOIN community.members m
    ON m.customer_id = e.customer_id AND m.id = e.member_id
  LEFT JOIN billing.payments p
    ON p.customer_id = e.customer_id AND p.id = e.payment_id
`;

interface EvidenceRow {
  id: string;
  community_id: string;
  unit_id: string;
  unit_code: string;
  member_id: string;
  member_name: string;
  declared_amount: string;
  declared_paid_at: Date | null;
  declared_method: string;
  reference: string | null;
  notes: string | null;
  source: string;
  evidence_status: string;
  payment_id: string | null;
  payment_amount: string | null;
  payment_method: string | null;
  payment_paid_at: Date | null;
  resolved_at: Date | null;
  resolved_by: string | null;
  resolution_note: string | null;
  created_at: Date;
  updated_at: Date;
  files: EvidenceFile[];
  claimed_charges: ClaimedCharge[];
}

function mapRow(row: EvidenceRow): Evidence {
  return {
    id: row.id,
    communityId: row.community_id,
    unitId: row.unit_id,
    unitCode: row.unit_code,
    memberId: row.member_id,
    memberName: row.member_name,
    declaredAmount: Number(row.declared_amount),
    declaredPaidAt: row.declared_paid_at === null ? null : row.declared_paid_at.toISOString(),
    declaredMethod: row.declared_method,
    reference: row.reference,
    notes: row.notes,
    source: row.source,
    evidenceStatus: row.evidence_status,
    payment:
      row.payment_id !== null &&
      row.payment_amount !== null &&
      row.payment_method !== null &&
      row.payment_paid_at !== null
        ? {
            id: row.payment_id,
            amount: Number(row.payment_amount),
            method: row.payment_method,
            paidAt: row.payment_paid_at.toISOString(),
          }
        : null,
    resolvedAt: row.resolved_at === null ? null : row.resolved_at.toISOString(),
    resolvedBy: row.resolved_by,
    resolutionNote: row.resolution_note,
    files: row.files,
    claimedCharges: row.claimed_charges,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

async function fetchById(tx: TxClient, id: string): Promise<Evidence | null> {
  const result = await tx.query<EvidenceRow>(
    `SELECT ${EVIDENCE_COLUMNS} ${EVIDENCE_FROM}
      WHERE e.id = $1 AND e.status != 'deleted'`,
    [id],
  );
  const row = result.rows[0];
  return row === undefined ? null : mapRow(row);
}

export const paymentEvidenceRepository = {
  /**
   * Alta de la evidencia con sus archivos, en la transacción del caller. El
   * caller YA resolvió la comunidad (del alcance del operador o de la cadena
   * del padrón) y YA validó los archivos contra storage: aquí solo se escribe.
   * Las FKs compuestas rechazan unidad/persona de otra comunidad.
   */
  async create(tx: TxClient, input: CreateEvidenceInput): Promise<Evidence> {
    const created = await tx.query<{ id: string }>(
      `INSERT INTO billing.payment_evidence
         (customer_id, community_id, unit_id, member_id,
          declared_amount, declared_paid_at, declared_method,
          reference, notes, source)
       VALUES ($1, $2, $3, $4, $5, $6::timestamptz, $7::billing.payment_method,
               $8, $9, $10::billing.evidence_source)
       RETURNING id`,
      [
        input.customerId,
        input.communityId,
        input.unitId,
        input.memberId,
        input.declaredAmount,
        input.declaredPaidAt,
        input.declaredMethod,
        input.reference,
        input.notes,
        input.source,
      ],
    );
    const evidenceId = created.rows[0]?.id;
    if (evidenceId === undefined) {
      throw new Error("el alta de la evidencia no devolvió id");
    }

    for (const file of input.files) {
      await tx.query(
        `INSERT INTO billing.payment_evidence_files
           (customer_id, evidence_id, storage_file_id,
            filename, content_type, size_bytes, sha256)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          input.customerId,
          evidenceId,
          file.id,
          file.filename,
          file.contentType,
          file.sizeBytes,
          file.sha256,
        ],
      );
    }

    for (const claim of input.claimedCharges) {
      await tx.query(
        `INSERT INTO billing.payment_evidence_charges
            (customer_id, evidence_id, charge_id, claimed_amount)
         VALUES ($1, $2, $3, $4)`,
        [input.customerId, evidenceId, claim.chargeId, claim.amount],
      );
    }

    const evidence = await fetchById(tx, evidenceId);
    if (evidence === null) {
      throw new Error("el alta de la evidencia no dejó rastro");
    }
    return evidence;
  },

  /**
   * Quién paga por esta unidad cuando el operador no nombró a nadie: el padrón
   * de la unidad, EL DUEÑO PRIMERO.
   *
   * El orden no es cosmético — es la respuesta a "¿a nombre de quién queda el
   * comprobante?" cuando en el mostrador solo se dijo la unidad. Owner antes
   * que tenant y que resident (el titular de la cuenta es quien responde por
   * el adeudo); a igualdad de rol, el vínculo más antiguo, y `id` como último
   * desempate para que dos capturas de la misma unidad no elijan a personas
   * distintas por el capricho del plan.
   *
   * Solo vínculos y personas VIGENTES: una baja del padrón no vuelve a
   * aparecer firmando recibos. `null` = la unidad no tiene a nadie asignado,
   * que el controller traduce a un error de negocio (la columna es NOT NULL).
   */
  async resolveUnitMember(tx: TxClient, unitId: string): Promise<string | null> {
    const result = await tx.query<{ member_id: string }>(
      `SELECT um.member_id
         FROM community.unit_members um
         JOIN community.members m
           ON m.customer_id = um.customer_id
          AND m.community_id = um.community_id
          AND m.id = um.member_id
        WHERE um.unit_id = $1
          AND um.status = 'active'
          AND m.status = 'active'
        ORDER BY (um.member_type = 'owner') DESC, um.created_at, um.id
        LIMIT 1`,
      [unitId],
    );
    return result.rows[0]?.member_id ?? null;
  },

  /**
   * ¿Cuántos de estos cargos son ACTIVOS y de ESTA unidad? Debe igualar el
   * número de ids distintos antes de aceptar la declaración — un cargo de otra
   * unidad (o inexistente) tumba el alta con mensaje de negocio, no un 23503.
   */
  async countUnitCharges(
    tx: TxClient,
    unitId: string,
    chargeIds: readonly string[],
  ): Promise<number> {
    if (chargeIds.length === 0) {
      return 0;
    }
    const result = await tx.query<{ count: string }>(
      `SELECT count(*)::bigint AS count
         FROM billing.charges c
        WHERE c.id = ANY($1::uuid[])
          AND c.unit_id = $2
          AND c.status = 'active'`,
      [[...chargeIds], unitId],
    );
    return Number(result.rows[0]?.count ?? 0);
  },

  /**
   * Bandeja de la comunidad (paginada). Ordena por antigüedad ASCENDENTE
   * cuando se piden pendientes —la bandeja es una COLA y el que más lleva
   * esperando va primero— y descendente para los históricos.
   */
  async list(
    tx: TxClient,
    input: ListEvidenceInput,
  ): Promise<{ items: Evidence[]; total: number }> {
    const status = input.status ?? null;
    const unitId = input.unitId ?? null;
    const from = input.from ?? null;
    const to = input.to ?? null;
    const offset = (input.page - 1) * input.pageSize;

    const where = `
      WHERE e.community_id = $1
        AND e.status != 'deleted'
        AND ($2::billing.payment_evidence_status IS NULL
             OR e.evidence_status = $2::billing.payment_evidence_status)
        AND ($3::uuid IS NULL OR e.unit_id = $3::uuid)
        -- ::date recorta en la zona de la sesión (config.dbTimezone), igual
        -- que el filtro de pagos: los días son los de la comunidad.
        AND ($4::date IS NULL OR e.created_at::date >= $4::date)
        AND ($5::date IS NULL OR e.created_at::date <= $5::date)
    `;
    const params = [input.communityId, status, unitId, from, to];

    const totalResult = await tx.query<{ count: string }>(
      `SELECT count(*)::bigint AS count FROM billing.payment_evidence e ${where}`,
      params,
    );
    const total = Number(totalResult.rows[0]?.count ?? 0);

    const order =
      status === "pending_review"
        ? "e.created_at ASC, e.id ASC"
        : "e.created_at DESC, e.id DESC";
    const itemsResult = await tx.query<EvidenceRow>(
      `SELECT ${EVIDENCE_COLUMNS} ${EVIDENCE_FROM} ${where}
        ORDER BY ${order}
        LIMIT $6 OFFSET $7`,
      [...params, input.pageSize, offset],
    );

    return { items: itemsResult.rows.map(mapRow), total };
  },

  /**
   * Una evidencia, visible si el actor alcanza SU comunidad. null =
   * inexistente o fuera de alcance (404 indistinguible).
   */
  async getById(tx: TxClient, userId: string, id: string): Promise<Evidence | null> {
    const result = await tx.query<EvidenceRow>(
      `SELECT ${EVIDENCE_COLUMNS} ${EVIDENCE_FROM}
         JOIN community.community_members cm
           ON cm.customer_id  = e.customer_id
          AND cm.community_id = e.community_id
          AND cm.user_id      = $2
          AND cm.status       = 'active'
        WHERE e.id = $1 AND e.status != 'deleted'`,
      [id, userId],
    );
    const row = result.rows[0];
    return row === undefined ? null : mapRow(row);
  },

  /**
   * Verifica vía billing.sp_verify_payment_evidence (bloquea la evidencia,
   * registra el pago por sp_register_payment y estampa el vínculo) y devuelve
   * la evidencia ya verificada.
   */
  async verify(tx: TxClient, input: VerifyEvidenceInput): Promise<Evidence> {
    await tx.query(
      `CALL billing.sp_verify_payment_evidence(
         $1, $2, $3::billing.payment_method, $4::jsonb,
         COALESCE($5::timestamptz, now()), $6, $7::uuid, NULL)`,
      [
        input.evidenceId,
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
    const evidence = await fetchById(tx, input.evidenceId);
    if (evidence === null) {
      throw new Error("sp_verify_payment_evidence no dejó rastro de la evidencia");
    }
    return evidence;
  },

  /**
   * Rechaza (con motivo). Condicionado al estado EN el UPDATE: dos operadores
   * rechazando a la vez —o rechazando una ya verificada— dejan exactamente un
   * ganador; el CHECK de la tabla respalda el invariante. 0 filas = el caller
   * decide entre inexistente y "ya atendida".
   */
  async reject(
    tx: TxClient,
    userId: string,
    id: string,
    note: string,
  ): Promise<Evidence | null> {
    const result = await tx.query<{ id: string }>(
      `UPDATE billing.payment_evidence
          SET evidence_status = 'rejected',
              resolved_at     = now(),
              resolved_by     = $2,
              resolution_note = $3
        WHERE id = $1
          AND status = 'active'
          AND evidence_status = 'pending_review'
        RETURNING id`,
      [id, userId, note],
    );
    if ((result.rowCount ?? 0) === 0) {
      return null;
    }
    return fetchById(tx, id);
  },

  /** ¿Existe y en qué estado está? Sin filtro de alcance (para respuestas 409 vs 404). */
  async getStatus(
    tx: TxClient,
    id: string,
  ): Promise<{ communityId: string; evidenceStatus: string } | null> {
    const result = await tx.query<{ community_id: string; evidence_status: string }>(
      `SELECT community_id, evidence_status
         FROM billing.payment_evidence
        WHERE id = $1 AND status != 'deleted'`,
      [id],
    );
    const row = result.rows[0];
    return row === undefined
      ? null
      : { communityId: row.community_id, evidenceStatus: row.evidence_status };
  },

  /**
   * El archivo de una evidencia (solo la referencia a storage). El caller YA
   * validó el alcance de la evidencia — este lookup solo confirma que el
   * archivo le pertenece.
   */
  async getFileRef(
    tx: TxClient,
    evidenceId: string,
    fileId: string,
  ): Promise<{ storageFileId: string } | null> {
    const result = await tx.query<{ storage_file_id: string }>(
      `SELECT storage_file_id
         FROM billing.payment_evidence_files
        WHERE id = $2 AND evidence_id = $1 AND status = 'active'`,
      [evidenceId, fileId],
    );
    const row = result.rows[0];
    return row === undefined ? null : { storageFileId: row.storage_file_id };
  },

  /**
   * Regresa a pending_review la evidencia vinculada a un pago ANULADO — se
   * llama DENTRO de la transacción de la anulación (payments.softDelete). El
   * rastro de la verificación queda en audit.event_log; la fila renace limpia
   * (el CHECK exige pending_review sin resolución).
   */
  async resetByPaymentId(tx: TxClient, paymentId: string): Promise<number> {
    const result = await tx.query(
      `UPDATE billing.payment_evidence
          SET evidence_status = 'pending_review',
              payment_id      = NULL,
              resolved_at     = NULL,
              resolved_by     = NULL,
              resolution_note = NULL
        WHERE payment_id = $1 AND status != 'deleted'`,
      [paymentId],
    );
    return result.rowCount ?? 0;
  },

  // --- La frontera del RESIDENTE (cadena del padrón) --------------------------
  // Mismas proyecciones, otra frontera: e.member_id → members.user_id = sub.
  // El residente ve las evidencias de SUS filas del padrón — incluidas las que
  // ventanilla capturó a su nombre, que es exactamente lo que espera ver.

  async listMine(
    tx: TxClient,
    userId: string,
    input: {
      readonly page: number;
      readonly pageSize: number;
      readonly unitId?: string | null;
      readonly status?: string | null;
    },
  ): Promise<{ items: Evidence[]; total: number }> {
    const unitId = input.unitId ?? null;
    const status = input.status ?? null;
    const offset = (input.page - 1) * input.pageSize;

    const where = `
      WHERE m.user_id = $1
        AND m.status  = 'active'
        AND e.status != 'deleted'
        AND ($2::uuid IS NULL OR e.unit_id = $2::uuid)
        AND ($3::billing.payment_evidence_status IS NULL
             OR e.evidence_status = $3::billing.payment_evidence_status)
    `;
    const params = [userId, unitId, status];

    const totalResult = await tx.query<{ count: string }>(
      `SELECT count(*)::bigint AS count
         FROM billing.payment_evidence e
         JOIN community.members m
           ON m.customer_id = e.customer_id AND m.id = e.member_id
        ${where}`,
      params,
    );
    const total = Number(totalResult.rows[0]?.count ?? 0);

    const itemsResult = await tx.query<EvidenceRow>(
      `SELECT ${EVIDENCE_COLUMNS} ${EVIDENCE_FROM} ${where}
        ORDER BY e.created_at DESC, e.id DESC
        LIMIT $4 OFFSET $5`,
      [...params, input.pageSize, offset],
    );

    return { items: itemsResult.rows.map(mapRow), total };
  },

  /** Una evidencia MÍA. null = ajena o inexistente (404 indistinguible). */
  async getMine(tx: TxClient, userId: string, id: string): Promise<Evidence | null> {
    const result = await tx.query<EvidenceRow>(
      `SELECT ${EVIDENCE_COLUMNS} ${EVIDENCE_FROM}
        WHERE e.id = $1
          AND e.status != 'deleted'
          AND m.user_id = $2
          AND m.status  = 'active'`,
      [id, userId],
    );
    const row = result.rows[0];
    return row === undefined ? null : mapRow(row);
  },
};
