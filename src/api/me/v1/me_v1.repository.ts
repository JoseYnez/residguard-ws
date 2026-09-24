import type { TxClient } from "../../../core/db/with_transaction";
import { plainExcerpt } from "../../../core/text/markdown_plain";
import {
  announcementsRepository,
  AUDIENCE_MATCHES_USER,
  EXCERPT_LENGTH,
} from "../../announcements/v1/announcements_v1.repository";
import {
  buildPaymentDetail,
  PAYMENT_DETAIL_COLUMNS,
  PAYMENT_DETAIL_JOINS,
  type PaymentDetail,
  type PaymentRow,
} from "../../payments/v1/payments_v1.repository";
import {
  reportsRepository,
  type UnitChargeStatement,
} from "../../reports/v1/reports_v1.repository";
import {
  mapVisit,
  visitsRepository,
  VISIT_COLUMNS,
  VISIT_FROM,
  VISIT_STATE_EXPR,
  type CreateVisitInput,
  type Visit,
  type VisitEvent,
  type VisitRow,
} from "../../visits/v1/visits_v1.repository";

// Acceso a datos del recurso me (autoconsulta del residente). La frontera de
// alcance aquí NO es community_members: es el VÍNCULO del padrón — la cadena
// sub → members.user_id → unit_members → units. Un usuario sin filas
// vinculadas simplemente no tiene unidades; una unidad ajena es un 404
// indistinguible de inexistente, igual que en el resto del servicio.
//
// El RLS sigue acotando el tenant (claim del token), así que un mismo usuario
// con unidades en OTRO cliente no las ve desde esta sesión: la tripleta manda.

export interface MyUnit {
  readonly unitId: string;
  readonly unitCode: string;
  readonly unitTower: string | null;
  readonly unitType: string;
  readonly address: string | null;
  readonly memberType: string;
  readonly communityId: string;
  readonly communityName: string;
}

interface MyUnitRow {
  unit_id: string;
  unit_code: string;
  unit_tower: string | null;
  unit_type: string;
  address: string | null;
  member_type: string;
  community_id: string;
  community_name: string;
}

/** Un cargo MÍO que el pago cubrió (una aplicación, con su contexto legible). */
export interface MyPaymentCover {
  /** Concepto de la cuota, con las piezas ("Tarjeta de acceso ×2"). */
  readonly concept: string;
  /** Nombre del periodo (label propio o derivado); null = cargo suelto. */
  readonly period: string | null;
  readonly unitCode: string;
  /** Torre y tipo de la unidad: el portal la nombra por su tipo ("casa 426-A"). */
  readonly unitTower: string | null;
  readonly unitType: string;
  /** Lo que ESTA aplicación puso sobre el cargo (≤ su importe). */
  readonly amount: number;
}

/** Un pago REGISTRADO que tocó alguna de mis unidades (ver listMyPayments). */
export interface MyPayment {
  readonly id: string;
  /** Total del depósito. */
  readonly amount: number;
  /** Lo aplicado a MIS unidades (≤ amount). */
  readonly appliedToMyUnits: number;
  readonly method: string;
  readonly reference: string | null;
  readonly paidAt: string;
  /** Códigos de MIS unidades que el pago cubrió. */
  readonly unitCodes: string[];
  /** Qué cubrió en MIS unidades, aplicación por aplicación. */
  readonly covers: MyPaymentCover[];
}

interface MyPaymentRow {
  id: string;
  amount: string;
  method: string;
  reference: string | null;
  paid_at: Date;
  applied_to_mine: string;
  unit_codes: string[];
  covers: {
    concept: string;
    period: string | null;
    unitCode: string;
    unitTower: string | null;
    unitType: string;
    amount: number;
  }[];
}

/** Un pago MÍO en detalle: la MISMA forma que ve el operador (con ella la app
 *  dibuja el mismo recibo) más el nombre de la comunidad, que el residente no
 *  tiene de dónde sacar — no tiene selector de alcance. */
export interface MyPaymentDetail extends PaymentDetail {
  readonly communityName: string;
}

// Todo ACTIVO de punta a punta: el vínculo del padrón, la asignación, la
// unidad y la comunidad. El portal muestra lo vigente; el historial (unidades
// vendidas, asignaciones cerradas) es de las pantallas de operación.
const MY_UNITS_CHAIN = `
  FROM community.members m
  JOIN community.unit_members um
    ON um.member_id = m.id AND um.status = 'active'
  JOIN community.units u
    ON u.id = um.unit_id AND u.status = 'active'
  JOIN community.communities c
    ON c.id = m.community_id AND c.status = 'active'
 WHERE m.user_id = $1 AND m.status = 'active'
`;

// --- Comunicados del residente ------------------------------------------------
// Proyección de LECTURA: el residente ve el comunicado, no su maquinaria (la
// regla de audiencia, el conteo de lecturas, el snapshot). Lo único suyo que
// añade es `read`.

export interface MyAnnouncement {
  readonly id: string;
  readonly communityId: string;
  readonly communityName: string;
  readonly title: string;
  /** Dos renglones de la tarjeta: el cuerpo sin markdown, ya recortado. */
  readonly excerpt: string;
  readonly isPinned: boolean;
  readonly publishedAt: string;
  /** No nulo = se corrigió tras publicar; la tarjeta dice "editado". */
  readonly editedAt: string | null;
  /** Quién lo redactó (null = su cuenta no está en el espejo core.users). */
  readonly createdByName: string | null;
  readonly fileCount: number;
  readonly read: boolean;
}

export interface MyAnnouncementFile {
  readonly id: string;
  readonly filename: string;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly sortOrder: number;
}

export interface MyAnnouncementDetail extends MyAnnouncement {
  readonly body: string;
  readonly files: MyAnnouncementFile[];
}

interface MyAnnouncementRow {
  id: string;
  community_id: string;
  community_name: string;
  title: string;
  body_head: string;
  is_pinned: boolean;
  published_at: Date;
  edited_at: Date | null;
  created_by_name: string | null;
  file_count: number;
  read: boolean;
}

// La comunidad se JOINea activa: desactivarla cierra el portal de todo lo que
// cuelga de ella, igual que en el resto del servicio. El autor sale del espejo
// core.users con LEFT JOIN: una cuenta sin sincronizar no esconde el aviso.
const MY_ANNOUNCEMENT_FROM = `
  FROM communication.announcements a
  JOIN community.communities c
    ON c.customer_id = a.customer_id AND c.id = a.community_id AND c.status = 'active'
  LEFT JOIN core.users cu
    ON cu.customer_id = a.customer_id AND cu.id = a.created_by
`;

const MY_ANNOUNCEMENT_COLUMNS = `
  a.id, a.community_id, c.name AS community_name, a.title,
  left(a.body, 400) AS body_head, a.is_pinned, a.published_at, a.edited_at,
  cu.full_name AS created_by_name,
  (SELECT count(*)::int
     FROM communication.announcement_files f
    WHERE f.customer_id     = a.customer_id
      AND f.announcement_id = a.id
      AND f.status          = 'active') AS file_count,
  EXISTS (SELECT 1
            FROM communication.announcement_reads r
           WHERE r.customer_id     = a.customer_id
             AND r.announcement_id = a.id
             AND r.user_id         = $1
             AND r.status          = 'active') AS read
`;

function mapMyAnnouncement(row: MyAnnouncementRow): MyAnnouncement {
  return {
    id: row.id,
    communityId: row.community_id,
    communityName: row.community_name,
    title: row.title,
    excerpt: plainExcerpt(row.body_head, EXCERPT_LENGTH),
    isPinned: row.is_pinned,
    publishedAt: row.published_at.toISOString(),
    editedAt: row.edited_at?.toISOString() ?? null,
    createdByName: row.created_by_name,
    fileCount: row.file_count,
    read: row.read,
  };
}

export const meRepository = {
  /**
   * Las unidades vigentes del usuario, en todas sus comunidades (una persona
   * por comunidad en el padrón; el mismo user_id las enlaza). Sin paginación:
   * el conjunto está acotado por naturaleza (ver el verifier).
   */
  async listMyUnits(tx: TxClient, userId: string): Promise<MyUnit[]> {
    const result = await tx.query<MyUnitRow>(
      `SELECT u.id        AS unit_id,
              u.code      AS unit_code,
              u.tower     AS unit_tower,
              u.unit_type::text AS unit_type,
              u.address,
              um.member_type::text AS member_type,
              c.id        AS community_id,
              c.name      AS community_name
         ${MY_UNITS_CHAIN}
        ORDER BY c.name, u.code`,
      [userId],
    );
    return result.rows.map((row) => ({
      unitId: row.unit_id,
      unitCode: row.unit_code,
      unitTower: row.unit_tower,
      unitType: row.unit_type,
      address: row.address,
      memberType: row.member_type,
      communityId: row.community_id,
      communityName: row.community_name,
    }));
  },

  /**
   * Estado de cuenta (vista por cargo, misma consulta que la V2 de reports) de
   * una unidad MÍA. Primero la pertenencia: si la unidad no está vinculada al
   * usuario por la cadena del padrón → null (404, indistinguible de
   * inexistente). Después delega en reports con la comunidad ya resuelta — la
   * autorización cambió, la información es la misma.
   */
  async myUnitStatement(
    tx: TxClient,
    userId: string,
    input: {
      readonly unitId: string;
      readonly from: string;
      readonly to: string;
      readonly page: number;
      readonly pageSize: number;
    },
  ): Promise<UnitChargeStatement | null> {
    const owned = await tx.query<{ community_id: string }>(
      `SELECT c.id AS community_id
         ${MY_UNITS_CHAIN}
          AND u.id = $2
        LIMIT 1`,
      [userId, input.unitId],
    );
    const row = owned.rows[0];
    if (row === undefined) {
      return null;
    }
    return reportsRepository.unitChargeStatement(tx, {
      communityId: row.community_id,
      unitId: input.unitId,
      from: input.from,
      to: input.to,
      page: input.page,
      pageSize: input.pageSize,
    });
  },

  /**
   * Mis PAGOS registrados: los depósitos cuyo dinero se aplicó a cargos de
   * alguna de MIS unidades. Es la otra mitad de "Mis pagos" — la evidencia es
   * la promesa, esto es el dinero ya asentado (incluidos los pagos que el
   * operador registró sin comprobante de por medio).
   *
   * `amount` es el total del depósito; `appliedToMyUnits` lo que de él cayó en
   * mis unidades (difieren si el depósito también cubrió cargos de una unidad
   * que no es mía). Sin filtro de `charges.status`: el dinero aplicado es
   * historia de caja aunque el cargo se haya anulado después (misma regla que
   * los reportes). Paginado, más reciente primero.
   */
  async listMyPayments(
    tx: TxClient,
    userId: string,
    input: { readonly page: number; readonly pageSize: number },
  ): Promise<{ items: MyPayment[]; total: number }> {
    // DISTINCT: la misma unidad no debe entrar dos veces aunque el padrón la
    // enlace por más de un camino — duplicaría la suma aplicada.
    const MY_UNITS_SUBQUERY = `
      JOIN (
        SELECT DISTINCT u.id, u.code, u.tower, u.unit_type::text AS unit_type
          FROM community.members m
          JOIN community.unit_members um
            ON um.member_id = m.id AND um.status = 'active'
          JOIN community.units u
            ON u.id = um.unit_id AND u.status = 'active'
         WHERE m.user_id = $1 AND m.status = 'active'
      ) mu ON mu.id = ch.unit_id
    `;
    // fees/fee_periods: el "qué cubrió" legible por aplicación — mismo alias
    // que el estado de cuenta (concepto ×piezas + COALESCE(label, derivado)),
    // para que el mismo cargo se llame igual en las dos pantallas. LEFT en
    // fee_periods, siempre: un cargo suelto no tiene periodo.
    const FROM = `
      FROM billing.payments p
      JOIN billing.payment_allocations pa
        ON pa.payment_id = p.id AND pa.status = 'active'
      JOIN billing.charges ch
        ON ch.id = pa.charge_id
      JOIN billing.fees f
        ON f.customer_id = ch.customer_id AND f.id = ch.fee_id
      LEFT JOIN billing.fee_periods fp
        ON fp.customer_id = ch.customer_id AND fp.id = ch.period_id
      ${MY_UNITS_SUBQUERY}
     WHERE p.status = 'active'
    `;

    const totalResult = await tx.query<{ count: string }>(
      `SELECT count(DISTINCT p.id)::bigint AS count ${FROM}`,
      [userId],
    );
    const total = Number(totalResult.rows[0]?.count ?? 0);

    const itemsResult = await tx.query<MyPaymentRow>(
      `SELECT p.id,
              p.amount::text AS amount,
              p.method::text AS method,
              p.reference,
              p.paid_at,
              SUM(pa.amount)::text AS applied_to_mine,
              jsonb_agg(DISTINCT mu.code) AS unit_codes,
              jsonb_agg(
                jsonb_build_object(
                  'concept', f.concept
                    || CASE WHEN ch.quantity > 1 THEN ' ×' || ch.quantity ELSE '' END,
                  'period', COALESCE(fp.label,
                    billing.fn_format_period_es(ch.period_start, ch.period_end)),
                  'unitCode', mu.code,
                  'unitTower', mu.tower,
                  'unitType', mu.unit_type,
                  'amount', pa.amount
                )
                ORDER BY ch.due_date, ch.created_at
              ) AS covers
         ${FROM}
        GROUP BY p.id, p.amount, p.method, p.reference, p.paid_at, p.created_at
        ORDER BY p.paid_at DESC, p.created_at DESC
        LIMIT $2 OFFSET $3`,
      [userId, input.pageSize, (input.page - 1) * input.pageSize],
    );

    return {
      items: itemsResult.rows.map((row) => ({
        id: row.id,
        amount: Number(row.amount),
        appliedToMyUnits: Number(row.applied_to_mine),
        method: row.method,
        reference: row.reference,
        paidAt: row.paid_at.toISOString(),
        unitCodes: row.unit_codes,
        covers: row.covers,
      })),
      total,
    };
  },

  /**
   * Un pago MÍO en detalle — lo que la app necesita para dibujar el MISMO
   * recibo que emite el administrador. null = inexistente, anulado o ajeno
   * (404 indistinguible).
   *
   * "Mío" = tiene al menos UNA aplicación activa sobre una unidad mía (la
   * cadena del padrón, igual que listMyPayments). Solo pagos `active`: un pago
   * anulado no emite recibo y tampoco viaja en la lista.
   *
   * Las aplicaciones son TODAS las del depósito, no solo las mías: el recibo
   * imprime el depósito completo (un mismo folio con dos cifras distintas
   * confunde). El comprobante, en cambio, sí se acota a lo mío.
   */
  async myPayment(tx: TxClient, userId: string, id: string): Promise<MyPaymentDetail | null> {
    const result = await tx.query<PaymentRow & { community_name: string }>(
      `SELECT ${PAYMENT_DETAIL_COLUMNS}, co.name AS community_name
         FROM billing.payments p
         ${PAYMENT_DETAIL_JOINS}
         JOIN community.communities co
           ON co.customer_id = p.customer_id AND co.id = p.community_id
        WHERE p.id = $2
          AND p.status = 'active'
          AND EXISTS (
                SELECT 1
                  FROM billing.payment_allocations pa
                  JOIN community.unit_members um
                    ON um.unit_id = pa.unit_id AND um.status = 'active'
                  JOIN community.members m
                    ON m.id = um.member_id AND m.status = 'active'
                  JOIN community.units u
                    ON u.id = um.unit_id AND u.status = 'active'
                 WHERE pa.payment_id = p.id
                   AND pa.status = 'active'
                   AND m.user_id = $1)`,
      [userId, id],
    );
    const row = result.rows[0];
    if (row === undefined) {
      return null;
    }
    const detail = await buildPaymentDetail(tx, row, {
      memberUserId: null,
      includeEvidence: true,
      residentUserId: userId,
    });
    return { ...detail, communityName: row.community_name };
  },

  // --- Mis visitas -----------------------------------------------------------
  // El pase lo emite una PERSONA DEL PADRÓN para una de SUS unidades, así que
  // la misma cadena que resuelve "mis unidades" resuelve también quién puede
  // emitirlo y sobre qué. Nada de comunidad en la ruta: se deriva.

  /**
   * Resuelve la unidad como MÍA y devuelve con qué identidad del padrón la
   * tengo. Es el único punto donde el portal decide pertenencia — todo lo demás
   * cuelga de aquí. `null` = la unidad no es mía (o no existe) → 404.
   */
  async myUnitScope(
    tx: TxClient,
    userId: string,
    unitId: string,
  ): Promise<{ communityId: string; memberId: string } | null> {
    const result = await tx.query<{ community_id: string; member_id: string }>(
      `SELECT c.id AS community_id, m.id AS member_id
         ${MY_UNITS_CHAIN}
          AND u.id = $2
        LIMIT 1`,
      [userId, unitId],
    );
    const row = result.rows[0];
    return row === undefined
      ? null
      : { communityId: row.community_id, memberId: row.member_id };
  },

  /**
   * Mis pases, de todas mis unidades. Paginado (a diferencia de /me/units): un
   * residente activo acumula visitas con el tiempo, así que el conjunto NO está
   * acotado por naturaleza.
   *
   * El filtro `state` compara contra el estado DERIVADO, que ya viene calculado
   * en la proyección compartida: el portal no reimplementa "vencido".
   */
  async listMyVisits(
    tx: TxClient,
    userId: string,
    input: {
      readonly page: number;
      readonly pageSize: number;
      readonly unitId?: string | null;
      readonly state?: string | null;
    },
  ): Promise<{ items: Visit[]; total: number }> {
    const params = [userId, input.unitId ?? null, input.state ?? null];
    // El pase es mío si su unidad lo es Y lo emitió mi fila del padrón: un
    // copropietario no cancela los pases del otro.
    const where = `
      WHERE v.status <> 'deleted'
        AND v.member_id = m.id
        AND m.user_id   = $1
        AND m.status    = 'active'
        AND EXISTS (
              SELECT 1
                FROM community.unit_members um
               WHERE um.member_id = m.id
                 AND um.unit_id   = v.unit_id
                 AND um.status    = 'active'
            )
        AND ($2::uuid IS NULL OR v.unit_id = $2::uuid)
        AND ($3::text IS NULL OR (${VISIT_STATE_EXPR}) = $3::text)
    `;

    const totalResult = await tx.query<{ count: string }>(
      `SELECT count(*)::bigint AS count ${VISIT_FROM} ${where}`,
      params,
    );
    const total = Number(totalResult.rows[0]?.count ?? 0);

    const itemsResult = await tx.query<VisitRow>(
      `SELECT ${VISIT_COLUMNS} ${VISIT_FROM} ${where}
        ORDER BY v.valid_from DESC, v.created_at DESC
        LIMIT $4 OFFSET $5`,
      [...params, input.pageSize, (input.page - 1) * input.pageSize],
    );

    return { items: itemsResult.rows.map(mapVisit), total };
  },

  /**
   * Un pase MÍO por id. `null` = ajeno o inexistente → 404.
   *
   * Misma frontera que la lista (listMyVisits): lo emitió mi fila del padrón Y
   * esa fila SIGUE asignada a la unidad. Sin la segunda mitad, quien dejó una
   * casa podría seguir abriendo, cancelando y viendo las fotos de los pases de
   * esa casa con solo conservar el id.
   */
  async myVisit(tx: TxClient, userId: string, visitId: string): Promise<Visit | null> {
    const result = await tx.query<VisitRow>(
      `SELECT ${VISIT_COLUMNS} ${VISIT_FROM}
        WHERE v.id = $2
          AND v.status <> 'deleted'
          AND v.member_id = m.id
          AND m.user_id = $1
          AND m.status = 'active'
          AND EXISTS (
                SELECT 1
                  FROM community.unit_members um
                 WHERE um.member_id = m.id
                   AND um.unit_id   = v.unit_id
                   AND um.status    = 'active')`,
      [userId, visitId],
    );
    const row = result.rows[0];
    return row === undefined ? null : mapVisit(row);
  },

  /**
   * Un pase MÍO con su bitácora de caseta. `null` = ajeno o inexistente → 404.
   *
   * La propiedad se comprueba primero (`myVisit`) y sólo entonces se leen los
   * eventos, con la comunidad que salió del propio pase: así el residente nunca
   * nombra una comunidad, y `listEvents` conserva su firma por comunidad — la
   * misma consulta que lee la bitácora del operador, no una segunda copia que
   * pueda divergir.
   */
  async myVisitDetail(
    tx: TxClient,
    userId: string,
    visitId: string,
  ): Promise<{ visit: Visit; events: VisitEvent[] } | null> {
    const visit = await this.myVisit(tx, userId, visitId);
    if (visit === null) {
      return null;
    }
    const events = await visitsRepository.listEvents(tx, visit.communityId, visitId);
    return { visit, events };
  },

  /**
   * Registra un pase para una unidad mía. La comunidad y la identidad del
   * padrón NO llegan del cliente: las deriva `myUnitScope` del usuario del
   * token. `null` = la unidad no es mía.
   */
  async createMyVisit(
    tx: TxClient,
    userId: string,
    customerId: string,
    input: Omit<CreateVisitInput, "memberId">,
  ): Promise<Visit | null> {
    const scope = await this.myUnitScope(tx, userId, input.unitId);
    if (scope === null) {
      return null;
    }
    return visitsRepository.create(tx, customerId, scope.communityId, {
      ...input,
      memberId: scope.memberId,
    });
  },

  /** Cancela un pase MÍO. `null` = ajeno o inexistente → 404. */
  async cancelMyVisit(tx: TxClient, userId: string, visitId: string): Promise<Visit | null> {
    const owned = await this.myVisit(tx, userId, visitId);
    if (owned === null) {
      return null;
    }
    return visitsRepository.cancel(tx, owned.communityId, visitId);
  },

  /** Pases vigentes de una unidad mía — el tope anti-abuso del alta. */
  async countActiveVisitsForUnit(tx: TxClient, unitId: string): Promise<number> {
    return visitsRepository.countActiveForUnit(tx, unitId);
  },

  // ─── Comunicados dirigidos a MÍ ──────────────────────────────────────────
  // La pertenencia sale de la MISMA definición de audiencia que usa el lado de
  // la operación (AUDIENCE_MATCHES_USER del repositorio de announcements): el
  // comunicado se evalúa contra su regla CONGELADA y contra el padrón VIVO, así
  // que quien llegó ayer ve lo fijado y quien se dio de baja deja de verlo.
  // Una segunda implementación de "¿le tocaba?" acabaría contradiciendo a la
  // primera — mismo criterio que el veredicto único de visitas.

  /**
   * Mis comunicados publicados, fijados primero y el resto de nuevo a viejo.
   * Solo `published`: archivar lo saca del portal (y sigue vivo para el
   * operador).
   */
  async listMyAnnouncements(
    tx: TxClient,
    userId: string,
    input: { readonly page: number; readonly pageSize: number },
  ): Promise<{ items: MyAnnouncement[]; total: number }> {
    const where = `
      WHERE a.status = 'active'
        AND a.publication_status = 'published'
        AND ${AUDIENCE_MATCHES_USER}
    `;

    const totalResult = await tx.query<{ count: string }>(
      `SELECT count(*)::bigint AS count
         FROM communication.announcements a ${where}`,
      [userId],
    );

    const itemsResult = await tx.query<MyAnnouncementRow>(
      `SELECT ${MY_ANNOUNCEMENT_COLUMNS}
         ${MY_ANNOUNCEMENT_FROM}
         ${where}
        ORDER BY a.is_pinned DESC, a.published_at DESC
        LIMIT $2 OFFSET $3`,
      [userId, input.pageSize, (input.page - 1) * input.pageSize],
    );

    return {
      items: itemsResult.rows.map(mapMyAnnouncement),
      total: Number(totalResult.rows[0]?.count ?? 0),
    };
  },

  /** El número del badge: mis comunicados publicados que todavía no abro. */
  async myUnreadAnnouncementCount(tx: TxClient, userId: string): Promise<number> {
    const result = await tx.query<{ count: string }>(
      `SELECT count(*)::bigint AS count
         FROM communication.announcements a
        WHERE a.status = 'active'
          AND a.publication_status = 'published'
          AND ${AUDIENCE_MATCHES_USER}
          AND NOT EXISTS (
                SELECT 1 FROM communication.announcement_reads r
                 WHERE r.customer_id     = a.customer_id
                   AND r.announcement_id = a.id
                   AND r.user_id         = $1
                   AND r.status          = 'active')`,
      [userId],
    );
    return Number(result.rows[0]?.count ?? 0);
  },

  /** Un comunicado MÍO con su cuerpo y adjuntos. Fuera de audiencia → null. */
  async myAnnouncement(
    tx: TxClient,
    userId: string,
    announcementId: string,
  ): Promise<MyAnnouncementDetail | null> {
    const result = await tx.query<MyAnnouncementRow & { body: string }>(
      `SELECT ${MY_ANNOUNCEMENT_COLUMNS}, a.body
         ${MY_ANNOUNCEMENT_FROM}
        WHERE a.id = $2
          AND a.status = 'active'
          AND a.publication_status = 'published'
          AND ${AUDIENCE_MATCHES_USER}`,
      [userId, announcementId],
    );
    const row = result.rows[0];
    if (row === undefined) {
      return null;
    }
    const files = await announcementsRepository.listFiles(tx, announcementId);
    return {
      ...mapMyAnnouncement(row),
      body: row.body,
      files: files.map((file) => ({
        id: file.id,
        filename: file.filename,
        contentType: file.contentType,
        sizeBytes: file.sizeBytes,
        sortOrder: file.sortOrder,
      })),
    };
  },

  /**
   * Marca leído. IDEMPOTENTE: el índice único es PARCIAL
   * (`WHERE status <> 'deleted'`), así que el ON CONFLICT repite el predicado o
   * no infiere el índice y el segundo toque reventaría con un 23505.
   *
   * Devuelve false si el comunicado no es suyo (404, indistinguible).
   */
  async markMyAnnouncementRead(
    tx: TxClient,
    userId: string,
    customerId: string,
    announcementId: string,
  ): Promise<boolean> {
    const visible = await tx.query(
      `SELECT 1
         FROM communication.announcements a
        WHERE a.id = $2
          AND a.status = 'active'
          AND a.publication_status = 'published'
          AND ${AUDIENCE_MATCHES_USER}`,
      [userId, announcementId],
    );
    if ((visible.rowCount ?? 0) === 0) {
      return false;
    }
    await tx.query(
      `INSERT INTO communication.announcement_reads
         (customer_id, announcement_id, user_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (customer_id, announcement_id, user_id)
         WHERE status <> 'deleted'
       DO NOTHING`,
      [customerId, announcementId, userId],
    );
    return true;
  },

  /** Referencia de storage de un adjunto de un comunicado MÍO. */
  async myAnnouncementFileRef(
    tx: TxClient,
    userId: string,
    announcementId: string,
    fileId: string,
  ): Promise<{ storageFileId: string; filename: string; contentType: string } | null> {
    const mine = await this.myAnnouncement(tx, userId, announcementId);
    if (mine === null) {
      return null;
    }
    return announcementsRepository.fileRef(tx, announcementId, fileId);
  },
};
