import type { TxClient } from "../../../core/db/with_transaction";
import type { StorageFileMetadata } from "../../../core/storage/storage_client";
import { plainExcerpt } from "../../../core/text/markdown_plain";

// Acceso a datos de los COMUNICADOS (schema communication) y de sus grupos de
// audiencia. Acotado a una comunidad ya autorizada; RLS filtra el tenant. Sin
// DELETE físico: la baja es status='deleted'.
//
// ─── UNA SOLA DEFINICIÓN DE "¿ESTÁ EN LA AUDIENCIA?" ────────────────────────
// La regla se usa en los DOS sentidos —comunicado → personas (el conteo, los
// destinatarios del push) y persona → comunicados (la lista del residente, en
// me_v1.repository)— y por eso vive UNA vez, aquí, exportada. Dos
// implementaciones del mismo "¿le tocaba?" acabarían contradiciéndose, y la
// que se equivocara mandaría avisos a quien no debía o escondería el
// comunicado a quien sí.

/** Cuántos caracteres del cuerpo viajan en un extracto de lista/push. */
export const EXCERPT_LENGTH = 160;

/**
 * La audiencia es una REGLA sobre el padrón, evaluada EN VIVO: dos criterios
 * opcionales que se combinan con Y (NULL = sin filtro en ese eje).
 *
 * Correlaciona con `$1` = community_id, `$2` = member_types (o NULL) y
 * `$3` = towers (o NULL). Todo ACTIVO de punta a punta: una persona dada de
 * baja del padrón, o una unidad desactivada, salen de la audiencia solas — sin
 * que nadie mantenga una lista.
 *
 * `u.tower` puede ser NULL y entonces `NULL = ANY(...)` es NULL: una unidad sin
 * torre nunca casa con un filtro de torres, que es exactamente lo correcto.
 */
export const AUDIENCE_MATCH_FROM = `
  FROM community.members m
  JOIN community.unit_members um
    ON um.customer_id = m.customer_id AND um.member_id = m.id AND um.status = 'active'
  JOIN community.units u
    ON u.customer_id = m.customer_id AND u.id = um.unit_id AND u.status = 'active'
 WHERE m.community_id = $1
   AND m.status = 'active'
   AND ($2::community.member_type[] IS NULL OR um.member_type = ANY($2::community.member_type[]))
   AND ($3::text[] IS NULL OR u.tower = ANY($3::text[]))
`;

/**
 * El mismo predicado en el otro sentido: ¿casa ESTE usuario con la audiencia de
 * la fila `a` de announcements? Se inyecta como un EXISTS correlacionado, con
 * `$1` = user_id. Lo consume me_v1.repository (la lista del residente).
 *
 * Usa el SNAPSHOT del comunicado (`a.audience_*`), no el grupo: la audiencia
 * queda congelada al publicar y renombrar o borrar el grupo después no reescribe
 * a quién iba. Las PERSONAS, en cambio, se evalúan al vuelo.
 */
export const AUDIENCE_MATCHES_USER = `
  EXISTS (
    SELECT 1
      FROM community.members am
      JOIN community.unit_members aum
        ON aum.customer_id = am.customer_id AND aum.member_id = am.id AND aum.status = 'active'
      JOIN community.units au
        ON au.customer_id = am.customer_id AND au.id = aum.unit_id AND au.status = 'active'
     WHERE am.user_id      = $1
       AND am.status       = 'active'
       AND am.community_id = a.community_id
       AND (a.audience_member_types IS NULL
            OR aum.member_type = ANY(a.audience_member_types))
       AND (a.audience_towers IS NULL
            OR au.tower = ANY(a.audience_towers))
  )
`;

// ─── Audiencia EFECTIVA de una fila ────────────────────────────────────────
// Un BORRADOR todavía no tiene snapshot: su audiencia es la del grupo elegido,
// y cambia si el grupo cambia (es justo lo que el operador quiere ver mientras
// redacta). Un comunicado PUBLICADO usa su copia congelada. Esta expresión
// resuelve cuál manda; el resto de las consultas ya solo lee `eff_*`.
const WITH_EFFECTIVE_AUDIENCE = `
  SELECT a.*,
         CASE WHEN a.publication_status = 'draft' THEN g.name         ELSE a.audience_label        END AS eff_label,
         CASE WHEN a.publication_status = 'draft' THEN g.member_types ELSE a.audience_member_types END AS eff_member_types,
         CASE WHEN a.publication_status = 'draft' THEN g.towers       ELSE a.audience_towers       END AS eff_towers
    FROM communication.announcements a
    LEFT JOIN communication.audience_groups g
      ON g.customer_id = a.customer_id
     AND g.id          = a.audience_group_id
     AND g.status     <> 'deleted'
`;

/** Las dos cifras de alcance de una fila: personas del padrón y de ellas
 *  cuántas tienen cuenta. Correlaciona con la audiencia EFECTIVA. */
const AUDIENCE_COUNTS_LATERAL = `
  LEFT JOIN LATERAL (
    SELECT count(DISTINCT m.id)::int      AS people,
           count(DISTINCT m.user_id)::int AS accounts
      FROM community.members m
      JOIN community.unit_members um
        ON um.customer_id = m.customer_id AND um.member_id = m.id AND um.status = 'active'
      JOIN community.units u
        ON u.customer_id = m.customer_id AND u.id = um.unit_id AND u.status = 'active'
     WHERE m.community_id = a.community_id
       AND m.status = 'active'
       AND (a.eff_member_types IS NULL OR um.member_type = ANY(a.eff_member_types))
       AND (a.eff_towers       IS NULL OR u.tower        = ANY(a.eff_towers))
  ) aud ON true
`;

const READ_COUNT = `
  (SELECT count(*)::int
     FROM communication.announcement_reads r
    WHERE r.customer_id     = a.customer_id
      AND r.announcement_id = a.id
      AND r.status          = 'active') AS read_count
`;

const FILE_COUNT = `
  (SELECT count(*)::int
     FROM communication.announcement_files f
    WHERE f.customer_id     = a.customer_id
      AND f.announcement_id = a.id
      AND f.status          = 'active') AS file_count
`;

// --- Tipos del dominio -------------------------------------------------------

export interface AnnouncementFile {
    readonly id: string;
    readonly storageFileId: string;
    readonly filename: string;
    readonly contentType: string;
    readonly sizeBytes: number;
    readonly sortOrder: number;
}

/** Fila de la bandeja del operador. */
export interface AnnouncementSummary {
    readonly id: string;
    readonly communityId: string;
    readonly title: string;
    readonly excerpt: string;
    readonly publicationStatus: string;
    readonly isPinned: boolean;
    readonly audienceGroupId: string | null;
    readonly audienceLabel: string | null;
    readonly audienceMemberTypes: string[] | null;
    readonly audienceTowers: string[] | null;
    readonly publishedAt: string | null;
    readonly editedAt: string | null;
    readonly archivedAt: string | null;
    /** Cuántas CUENTAS lo marcaron como leído. */
    readonly readCount: number;
    /** Cuántas cuentas hay en la audiencia (el denominador honesto). */
    readonly audienceAccounts: number;
    /** Cuántas PERSONAS del padrón hay en la audiencia (tengan cuenta o no). */
    readonly audiencePeople: number;
    readonly fileCount: number;
    readonly status: string;
    readonly createdAt: string;
    readonly updatedAt: string;
}

export interface AnnouncementDetail extends AnnouncementSummary {
    readonly body: string;
    readonly files: AnnouncementFile[];
}

export interface AudienceGroup {
    readonly id: string;
    readonly communityId: string;
    readonly name: string;
    readonly description: string | null;
    readonly memberTypes: string[] | null;
    readonly towers: string[] | null;
    /** Alcance de la regla HOY (personas del padrón / de ellas, con cuenta). */
    readonly people: number;
    readonly accounts: number;
    readonly status: string;
    readonly createdAt: string;
    readonly updatedAt: string;
}

export interface AudienceReach {
    readonly people: number;
    readonly accounts: number;
}

/** Una cuenta de la audiencia y si ya leyó (el detalle de lecturas). */
export interface AnnouncementReader {
    readonly userId: string;
    readonly fullName: string;
    readonly homes: string;
    readonly readAt: string | null;
}

export interface AudienceRule {
    readonly memberTypes: string[] | null;
    readonly towers: string[] | null;
}

export interface ListAnnouncementsInput {
    readonly communityId: string;
    readonly page: number;
    readonly pageSize: number;
    readonly publicationStatus?: string | null;
    readonly search?: string | null;
}

export interface CreateAnnouncementInput {
    readonly title: string;
    readonly body: string;
    readonly audienceGroupId: string | null;
    readonly isPinned: boolean;
    readonly files: readonly {
        readonly id: string;
        readonly filename: string;
        readonly contentType: string;
        readonly sizeBytes: number;
        readonly sha256: string;
    }[];
}

export interface UpdateAnnouncementInput {
    readonly title?: string;
    readonly body?: string;
    readonly audienceGroupId?: string | null;
    readonly isPinned?: boolean;
}

// --- Filas crudas ------------------------------------------------------------

interface AnnouncementRow {
    id: string;
    community_id: string;
    title: string;
    body_head: string;
    publication_status: string;
    is_pinned: boolean;
    audience_group_id: string | null;
    eff_label: string | null;
    eff_member_types: string[] | null;
    eff_towers: string[] | null;
    published_at: Date | null;
    edited_at: Date | null;
    archived_at: Date | null;
    read_count: number;
    audience_accounts: number | null;
    audience_people: number | null;
    file_count: number;
    status: string;
    created_at: Date;
    updated_at: Date;
}

interface AnnouncementDetailRow extends AnnouncementRow {
    body: string;
}

interface AudienceGroupRow {
    id: string;
    community_id: string;
    name: string;
    description: string | null;
    member_types: string[] | null;
    towers: string[] | null;
    people: number | null;
    accounts: number | null;
    status: string;
    created_at: Date;
    updated_at: Date;
}

/** Columnas de un grupo + su alcance de HOY. El LATERAL repite la regla de
 *  `AUDIENCE_MATCH_FROM` porque aquí correlaciona con la fila del grupo (g.*)
 *  en vez de con parámetros; es la misma condición, sin parámetros sueltos. */
const GROUP_COLUMNS = `
  g.id, g.community_id, g.name, g.description,
  g.member_types::text[] AS member_types, g.towers,
  reach.people, reach.accounts,
  g.status::text AS status, g.created_at, g.updated_at
`;

const GROUP_REACH_LATERAL = `
  LEFT JOIN LATERAL (
    SELECT count(DISTINCT m.id)::int      AS people,
           count(DISTINCT m.user_id)::int AS accounts
      FROM community.members m
      JOIN community.unit_members um
        ON um.customer_id = m.customer_id AND um.member_id = m.id AND um.status = 'active'
      JOIN community.units u
        ON u.customer_id = m.customer_id AND u.id = um.unit_id AND u.status = 'active'
     WHERE m.community_id = g.community_id
       AND m.status = 'active'
       AND (g.member_types IS NULL OR um.member_type = ANY(g.member_types))
       AND (g.towers       IS NULL OR u.tower        = ANY(g.towers))
  ) reach ON true
`;

const SUMMARY_COLUMNS = `
  a.id, a.community_id, a.title, left(a.body, 400) AS body_head,
  a.publication_status::text AS publication_status, a.is_pinned,
  a.audience_group_id, a.eff_label,
  a.eff_member_types::text[] AS eff_member_types, a.eff_towers,
  a.published_at, a.edited_at, a.archived_at,
  aud.people AS audience_people, aud.accounts AS audience_accounts,
  ${READ_COUNT}, ${FILE_COUNT},
  a.status::text AS status, a.created_at, a.updated_at
`;

function mapSummary(row: AnnouncementRow): AnnouncementSummary {
    return {
        id: row.id,
        communityId: row.community_id,
        title: row.title,
        excerpt: plainExcerpt(row.body_head, EXCERPT_LENGTH),
        publicationStatus: row.publication_status,
        isPinned: row.is_pinned,
        audienceGroupId: row.audience_group_id,
        audienceLabel: row.eff_label,
        audienceMemberTypes: row.eff_member_types,
        audienceTowers: row.eff_towers,
        publishedAt: row.published_at?.toISOString() ?? null,
        editedAt: row.edited_at?.toISOString() ?? null,
        archivedAt: row.archived_at?.toISOString() ?? null,
        readCount: row.read_count,
        audienceAccounts: row.audience_accounts ?? 0,
        audiencePeople: row.audience_people ?? 0,
        fileCount: row.file_count,
        status: row.status,
        createdAt: row.created_at.toISOString(),
        updatedAt: row.updated_at.toISOString(),
    };
}

function mapGroup(row: AudienceGroupRow): AudienceGroup {
    return {
        id: row.id,
        communityId: row.community_id,
        name: row.name,
        description: row.description,
        memberTypes: row.member_types,
        towers: row.towers,
        people: row.people ?? 0,
        accounts: row.accounts ?? 0,
        status: row.status,
        createdAt: row.created_at.toISOString(),
        updatedAt: row.updated_at.toISOString(),
    };
}

export const announcementsRepository = {
    // ─── Comunicados ────────────────────────────────────────────────────────

    async list(
        tx: TxClient,
        input: ListAnnouncementsInput,
    ): Promise<{ items: AnnouncementSummary[]; total: number }> {
        const status = input.publicationStatus ?? null;
        const search = input.search ?? null;
        const offset = (input.page - 1) * input.pageSize;

        const where = `
          WHERE a.community_id = $1
            AND a.status <> 'deleted'
            AND ($2::text IS NULL OR a.publication_status::text = $2)
            AND ($3::text IS NULL OR a.title ILIKE '%' || $3 || '%' OR a.body ILIKE '%' || $3 || '%')
        `;

        const totalResult = await tx.query<{ count: string }>(
            `SELECT count(*)::bigint AS count
               FROM communication.announcements a ${where}`,
            [input.communityId, status, search],
        );
        const total = Number(totalResult.rows[0]?.count ?? 0);

        // Fijados primero y el resto de nuevo a viejo. `published_at` va NULL en
        // los borradores: COALESCE con created_at los ordena por cuándo se
        // escribieron en vez de mandarlos todos juntos al final.
        const itemsResult = await tx.query<AnnouncementRow>(
            `SELECT ${SUMMARY_COLUMNS}
               FROM (${WITH_EFFECTIVE_AUDIENCE}) a
               ${AUDIENCE_COUNTS_LATERAL}
               ${where}
              ORDER BY a.is_pinned DESC, COALESCE(a.published_at, a.created_at) DESC
              LIMIT $4 OFFSET $5`,
            [input.communityId, status, search, input.pageSize, offset],
        );

        return { items: itemsResult.rows.map(mapSummary), total };
    },

    async getById(
        tx: TxClient,
        communityId: string,
        id: string,
    ): Promise<AnnouncementDetail | null> {
        const result = await tx.query<AnnouncementDetailRow>(
            `SELECT ${SUMMARY_COLUMNS}, a.body
               FROM (${WITH_EFFECTIVE_AUDIENCE}) a
               ${AUDIENCE_COUNTS_LATERAL}
              WHERE a.id = $2 AND a.community_id = $1 AND a.status <> 'deleted'`,
            [communityId, id],
        );
        const row = result.rows[0];
        if (row === undefined) {
            return null;
        }
        const files = await this.listFiles(tx, id);
        return { ...mapSummary(row), body: row.body, files };
    },

    async listFiles(tx: TxClient, announcementId: string): Promise<AnnouncementFile[]> {
        const result = await tx.query<{
            id: string;
            storage_file_id: string;
            filename: string;
            content_type: string;
            size_bytes: string;
            sort_order: number;
        }>(
            `SELECT id, storage_file_id, filename, content_type, size_bytes, sort_order
               FROM communication.announcement_files
              WHERE announcement_id = $1 AND status = 'active'
              ORDER BY sort_order, created_at`,
            [announcementId],
        );
        return result.rows.map((row) => ({
            id: row.id,
            storageFileId: row.storage_file_id,
            filename: row.filename,
            contentType: row.content_type,
            sizeBytes: Number(row.size_bytes),
            sortOrder: row.sort_order,
        }));
    },

    /**
     * Los adjuntos ACTIVOS de un comunicado, indexados por el id de su fila
     * (el que expone el detalle), con la metadata que `replaceFiles` necesita
     * para volver a darlos de alta. Acotado a la comunidad: el id de otro
     * comunicado no se reusa aquí.
     */
    async keptFiles(
        tx: TxClient,
        communityId: string,
        announcementId: string,
    ): Promise<Map<string, StorageFileMetadata>> {
        const result = await tx.query<{
            id: string;
            storage_file_id: string;
            filename: string;
            content_type: string;
            size_bytes: string;
            sha256: string;
        }>(
            `SELECT f.id, f.storage_file_id, f.filename, f.content_type, f.size_bytes, f.sha256
               FROM communication.announcement_files f
               JOIN communication.announcements a
                 ON a.customer_id = f.customer_id AND a.id = f.announcement_id
              WHERE f.announcement_id = $2
                AND a.community_id    = $1
                AND a.status         <> 'deleted'
                AND f.status          = 'active'`,
            [communityId, announcementId],
        );
        return new Map(
            result.rows.map((row) => [
                row.id,
                {
                    id: row.storage_file_id,
                    filename: row.filename,
                    contentType: row.content_type,
                    sizeBytes: Number(row.size_bytes),
                    sha256: row.sha256,
                },
            ]),
        );
    },

    /** Referencia de storage de un adjunto, ya acotado a su comunicado. Trae
     *  además el nombre y el tipo: quien emite el enlace los devuelve para que
     *  la SPA sepa si lo abre en el visor o lo descarga. */
    async fileRef(
        tx: TxClient,
        announcementId: string,
        fileId: string,
    ): Promise<{ storageFileId: string; filename: string; contentType: string } | null> {
        const result = await tx.query<{
            storage_file_id: string;
            filename: string;
            content_type: string;
        }>(
            `SELECT storage_file_id, filename, content_type
               FROM communication.announcement_files
              WHERE id = $2 AND announcement_id = $1 AND status = 'active'`,
            [announcementId, fileId],
        );
        const row = result.rows[0];
        return row === undefined
            ? null
            : {
                  storageFileId: row.storage_file_id,
                  filename: row.filename,
                  contentType: row.content_type,
              };
    },

    /** Nace SIEMPRE borrador: publicar es un acto aparte (y con otro permiso). */
    async create(
        tx: TxClient,
        customerId: string,
        communityId: string,
        input: CreateAnnouncementInput,
    ): Promise<string> {
        const inserted = await tx.query<{ id: string }>(
            `INSERT INTO communication.announcements
               (customer_id, community_id, title, body, audience_group_id, is_pinned)
             VALUES ($1, $2, $3, $4, $5, $6)
             RETURNING id`,
            [
                customerId,
                communityId,
                input.title,
                input.body,
                input.audienceGroupId,
                input.isPinned,
            ],
        );
        const announcementId = inserted.rows[0]!.id;

        let sortOrder = 0;
        for (const file of input.files) {
            await tx.query(
                `INSERT INTO communication.announcement_files
                   (customer_id, announcement_id, storage_file_id,
                    filename, content_type, size_bytes, sha256, sort_order)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
                [
                    customerId,
                    announcementId,
                    file.id,
                    file.filename,
                    file.contentType,
                    file.sizeBytes,
                    file.sha256,
                    sortOrder,
                ],
            );
            sortOrder += 1;
        }

        return announcementId;
    },

    /**
     * Edición parcial. `edited_at` se estampa SOLO si cambió el texto y el
     * comunicado ya estaba publicado: fijar o archivar mueven `updated_at`,
     * pero al residente no se le dice "editado" por eso.
     */
    async update(
        tx: TxClient,
        communityId: string,
        id: string,
        input: UpdateAnnouncementInput,
    ): Promise<boolean> {
        const sets: string[] = [];
        const params: unknown[] = [];
        let i = 1;

        const push = (column: string, value: unknown, cast = ""): void => {
            sets.push(`${column} = $${i}${cast}`);
            params.push(value);
            i += 1;
        };

        if (input.title !== undefined) push("title", input.title);
        if (input.body !== undefined) push("body", input.body);
        if (input.audienceGroupId !== undefined) {
            push("audience_group_id", input.audienceGroupId, "::uuid");
        }
        if (input.isPinned !== undefined) push("is_pinned", input.isPinned);

        if (sets.length === 0) {
            return true;
        }

        if (input.title !== undefined || input.body !== undefined) {
            sets.push("edited_at = CASE WHEN publication_status = 'draft' THEN edited_at ELSE now() END");
        }

        params.push(id, communityId);
        const result = await tx.query(
            `UPDATE communication.announcements SET ${sets.join(", ")}
              WHERE id = $${i} AND community_id = $${i + 1} AND status <> 'deleted'`,
            params,
        );
        return (result.rowCount ?? 0) > 0;
    },

    /** Reemplaza los adjuntos: baja lógica de los viejos y alta de los nuevos. */
    async replaceFiles(
        tx: TxClient,
        customerId: string,
        announcementId: string,
        files: CreateAnnouncementInput["files"],
    ): Promise<void> {
        await tx.query(
            `UPDATE communication.announcement_files SET status = 'deleted'
              WHERE announcement_id = $1 AND status <> 'deleted'`,
            [announcementId],
        );
        let sortOrder = 0;
        for (const file of files) {
            await tx.query(
                `INSERT INTO communication.announcement_files
                   (customer_id, announcement_id, storage_file_id,
                    filename, content_type, size_bytes, sha256, sort_order)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
                [
                    customerId,
                    announcementId,
                    file.id,
                    file.filename,
                    file.contentType,
                    file.sizeBytes,
                    file.sha256,
                    sortOrder,
                ],
            );
            sortOrder += 1;
        }
    },

    /**
     * draft → published, CONGELANDO la regla del grupo en el comunicado.
     *
     * El UPDATE lleva `publication_status = 'draft'` en el WHERE: si otra
     * petición publicó primero, afecta 0 filas y el controller responde 409 —
     * nadie dispara el push dos veces.
     */
    async publish(
        tx: TxClient,
        communityId: string,
        id: string,
        publishedBy: string,
    ): Promise<boolean> {
        // Las tres copias salen de subconsultas escalares sobre el MISMO grupo:
        // con `audience_group_id` en NULL ("Todos") no devuelven fila y el
        // snapshot queda en NULL, que es exactamente "sin filtro".
        const group = `
          SELECT %COL%
            FROM communication.audience_groups g
           WHERE g.customer_id = a.customer_id
             AND g.id          = a.audience_group_id
             AND g.status     <> 'deleted'
        `;
        const result = await tx.query(
            `UPDATE communication.announcements a
                SET publication_status    = 'published',
                    published_at          = now(),
                    published_by          = $3::uuid,
                    audience_label        = (${group.replace("%COL%", "g.name")}),
                    audience_member_types = (${group.replace("%COL%", "g.member_types")}),
                    audience_towers       = (${group.replace("%COL%", "g.towers")})
              WHERE a.id = $2
                AND a.community_id = $1
                AND a.status <> 'deleted'
                AND a.publication_status = 'draft'`,
            [communityId, id, publishedBy],
        );
        return (result.rowCount ?? 0) > 0;
    },

    /** published → archived. Sale del portal del residente, se queda para el
     *  operador. Solo desde `published`: archivar un borrador no significa nada. */
    async archive(tx: TxClient, communityId: string, id: string): Promise<boolean> {
        const result = await tx.query(
            `UPDATE communication.announcements
                SET publication_status = 'archived', archived_at = now()
              WHERE id = $2 AND community_id = $1
                AND status <> 'deleted'
                AND publication_status = 'published'`,
            [communityId, id],
        );
        return (result.rowCount ?? 0) > 0;
    },

    async softDelete(tx: TxClient, communityId: string, id: string): Promise<boolean> {
        const result = await tx.query(
            `UPDATE communication.announcements SET status = 'deleted'
              WHERE id = $2 AND community_id = $1 AND status <> 'deleted'`,
            [communityId, id],
        );
        return (result.rowCount ?? 0) > 0;
    },

    /**
     * Las CUENTAS de la audiencia y si ya leyeron. Una persona puede figurar en
     * dos unidades: se agrupa por usuario y se juntan sus domicilios, para que
     * la lista tenga una fila por quien recibe, no por relación.
     *
     * `homes` junta SOLO los domicilios por los que entra a la audiencia (el
     * JOIN ya viene filtrado por la regla): a quien le llegó un aviso de la
     * Torre B se le muestra su departamento de la Torre B, no el de la A —
     * poner los dos haría dudar al operador de si la regla funcionó.
     */
    async listReaders(
        tx: TxClient,
        input: {
            readonly communityId: string;
            readonly announcementId: string;
            readonly rule: AudienceRule;
            readonly filter: "read" | "unread" | null;
            readonly page: number;
            readonly pageSize: number;
        },
    ): Promise<{ items: AnnouncementReader[]; total: number }> {
        // El filtro va FUERA del GROUP BY: `read_at` es un alias de salida y un
        // HAVING no puede nombrarlo (ni queda `r` en el FROM, que es una
        // subconsulta escalar). Envolver el agrupado lo resuelve sin repetirla.
        const filterSql =
            input.filter === "read"
                ? "WHERE read_at IS NOT NULL"
                : input.filter === "unread"
                  ? "WHERE read_at IS NULL"
                  : "";

        // La lectura entra como subconsulta ESCALAR y no como JOIN para no
        // tocar `AUDIENCE_MATCH_FROM`: esa definición se comparte con el
        // conteo, la vista previa y los destinatarios del push, y solo esta
        // consulta necesita saber quién ya leyó.
        const grouped = `
          SELECT m.user_id,
                 min(m.full_name) AS full_name,
                 string_agg(DISTINCT u.code, ', ' ORDER BY u.code) AS homes,
                 max((SELECT r.read_at
                        FROM communication.announcement_reads r
                       WHERE r.customer_id     = m.customer_id
                         AND r.announcement_id = $4
                         AND r.user_id         = m.user_id
                         AND r.status          = 'active')) AS read_at
          ${AUDIENCE_MATCH_FROM}
            AND m.user_id IS NOT NULL
          GROUP BY m.user_id
        `;
        const filtered = `SELECT * FROM (${grouped}) g ${filterSql}`;

        const params = [
            input.communityId,
            input.rule.memberTypes,
            input.rule.towers,
            input.announcementId,
        ];

        const totalResult = await tx.query<{ count: string }>(
            `SELECT count(*)::bigint AS count FROM (${filtered}) t`,
            params,
        );
        const total = Number(totalResult.rows[0]?.count ?? 0);

        const itemsResult = await tx.query<{
            user_id: string;
            full_name: string;
            homes: string | null;
            read_at: Date | null;
        }>(
            // Primero quienes faltan: esa es la lista sobre la que el operador
            // actúa (recordarles, llamarles); los que ya leyeron son historia.
            `SELECT * FROM (${filtered}) t
              ORDER BY (read_at IS NULL) DESC, full_name
              LIMIT $5 OFFSET $6`,
            [...params, input.pageSize, (input.page - 1) * input.pageSize],
        );

        return {
            items: itemsResult.rows.map((row) => ({
                userId: row.user_id,
                fullName: row.full_name,
                homes: row.homes ?? "",
                readAt: row.read_at?.toISOString() ?? null,
            })),
            total,
        };
    },

    /** Las dos cifras de alcance de una regla suelta (la vista previa). */
    async audienceReach(
        tx: TxClient,
        communityId: string,
        rule: AudienceRule,
    ): Promise<AudienceReach> {
        const result = await tx.query<{ people: number; accounts: number }>(
            `SELECT count(DISTINCT m.id)::int AS people,
                    count(DISTINCT m.user_id)::int AS accounts
             ${AUDIENCE_MATCH_FROM}`,
            [communityId, rule.memberTypes, rule.towers],
        );
        const row = result.rows[0];
        return { people: row?.people ?? 0, accounts: row?.accounts ?? 0 };
    },

    /** A quién avisar: los user_id DISTINTOS de la audiencia. El actor SÍ entra
     *  si le tocaba — publicar para todos incluye a quien publica. */
    async audienceUserIds(
        tx: TxClient,
        communityId: string,
        rule: AudienceRule,
    ): Promise<string[]> {
        const result = await tx.query<{ user_id: string }>(
            `SELECT DISTINCT m.user_id
             ${AUDIENCE_MATCH_FROM}
               AND m.user_id IS NOT NULL`,
            [communityId, rule.memberTypes, rule.towers],
        );
        return result.rows.map((row) => row.user_id);
    },

    /** La regla YA CONGELADA de un comunicado (lo que usa el push tras publicar). */
    async frozenRule(
        tx: TxClient,
        communityId: string,
        id: string,
    ): Promise<{ rule: AudienceRule; title: string; body: string; label: string | null } | null> {
        const result = await tx.query<{
            audience_member_types: string[] | null;
            audience_towers: string[] | null;
            audience_label: string | null;
            title: string;
            body: string;
        }>(
            `SELECT audience_member_types::text[] AS audience_member_types,
                    audience_towers, audience_label, title, body
               FROM communication.announcements
              WHERE id = $2 AND community_id = $1 AND status <> 'deleted'`,
            [communityId, id],
        );
        const row = result.rows[0];
        if (row === undefined) {
            return null;
        }
        return {
            rule: { memberTypes: row.audience_member_types, towers: row.audience_towers },
            title: row.title,
            body: row.body,
            label: row.audience_label,
        };
    },

    // ─── Grupos de audiencia ────────────────────────────────────────────────

    async listGroups(
        tx: TxClient,
        input: { communityId: string; page: number; pageSize: number; status?: string | null },
    ): Promise<{ items: AudienceGroup[]; total: number }> {
        const status = input.status ?? null;
        const offset = (input.page - 1) * input.pageSize;
        const where = `
          WHERE g.community_id = $1
            AND ( ($2::public.record_status IS NULL AND g.status <> 'deleted')
               OR g.status = $2::public.record_status )
        `;

        const totalResult = await tx.query<{ count: string }>(
            `SELECT count(*)::bigint AS count
               FROM communication.audience_groups g ${where}`,
            [input.communityId, status],
        );

        const itemsResult = await tx.query<AudienceGroupRow>(
            `SELECT ${GROUP_COLUMNS}
               FROM communication.audience_groups g
               ${GROUP_REACH_LATERAL}
               ${where}
              ORDER BY g.name
              LIMIT $3 OFFSET $4`,
            [input.communityId, status, input.pageSize, offset],
        );

        return {
            items: itemsResult.rows.map(mapGroup),
            total: Number(totalResult.rows[0]?.count ?? 0),
        };
    },

    async getGroupById(
        tx: TxClient,
        communityId: string,
        id: string,
    ): Promise<AudienceGroup | null> {
        const result = await tx.query<AudienceGroupRow>(
            `SELECT ${GROUP_COLUMNS}
               FROM communication.audience_groups g
               ${GROUP_REACH_LATERAL}
              WHERE g.id = $2 AND g.community_id = $1 AND g.status <> 'deleted'`,
            [communityId, id],
        );
        const row = result.rows[0];
        return row === undefined ? null : mapGroup(row);
    },

    async createGroup(
        tx: TxClient,
        customerId: string,
        communityId: string,
        input: {
            name: string;
            description: string | null;
            memberTypes: readonly string[] | null;
            towers: readonly string[] | null;
        },
    ): Promise<AudienceGroup> {
        const inserted = await tx.query<{ id: string }>(
            `INSERT INTO communication.audience_groups
               (customer_id, community_id, name, description, member_types, towers)
             VALUES ($1, $2, $3, $4, $5::community.member_type[], $6::text[])
             RETURNING id`,
            [
                customerId,
                communityId,
                input.name,
                input.description,
                input.memberTypes,
                input.towers,
            ],
        );
        // Se relee para devolver el grupo CON su alcance, que es lo primero que
        // el formulario muestra ("llega a 12 personas, 5 con cuenta").
        return (await this.getGroupById(tx, communityId, inserted.rows[0]!.id))!;
    },

    async updateGroup(
        tx: TxClient,
        communityId: string,
        id: string,
        input: {
            name?: string;
            description?: string | null;
            memberTypes?: readonly string[] | null;
            towers?: readonly string[] | null;
            status?: string;
        },
    ): Promise<AudienceGroup | null> {
        const sets: string[] = [];
        const params: unknown[] = [];
        let i = 1;

        const push = (column: string, value: unknown, cast = ""): void => {
            sets.push(`${column} = $${i}${cast}`);
            params.push(value);
            i += 1;
        };

        if (input.name !== undefined) push("name", input.name);
        if (input.description !== undefined) push("description", input.description);
        if (input.memberTypes !== undefined) {
            push("member_types", input.memberTypes, "::community.member_type[]");
        }
        if (input.towers !== undefined) push("towers", input.towers, "::text[]");
        if (input.status !== undefined) push("status", input.status, "::public.record_status");

        if (sets.length === 0) {
            return this.getGroupById(tx, communityId, id);
        }

        params.push(id, communityId);
        const result = await tx.query(
            `UPDATE communication.audience_groups SET ${sets.join(", ")}
              WHERE id = $${i} AND community_id = $${i + 1} AND status <> 'deleted'`,
            params,
        );
        if ((result.rowCount ?? 0) === 0) {
            return null;
        }
        // Relectura: el alcance cambia con la regla, y el formulario lo pinta
        // al cerrar el diálogo.
        return this.getGroupById(tx, communityId, id);
    },

    /** Cuántos BORRADORES vivos apuntan al grupo (los que quedarían en "Todos"). */
    async draftsUsingGroup(tx: TxClient, communityId: string, groupId: string): Promise<number> {
        const result = await tx.query<{ count: number }>(
            `SELECT count(*)::int AS count
               FROM communication.announcements
              WHERE community_id       = $1
                AND audience_group_id  = $2
                AND status            <> 'deleted'
                AND publication_status = 'draft'`,
            [communityId, groupId],
        );
        return result.rows[0]?.count ?? 0;
    },

    async softDeleteGroup(tx: TxClient, communityId: string, id: string): Promise<boolean> {
        const result = await tx.query(
            `UPDATE communication.audience_groups SET status = 'deleted'
              WHERE id = $2 AND community_id = $1 AND status <> 'deleted'`,
            [communityId, id],
        );
        return (result.rowCount ?? 0) > 0;
    },

    /** Las torres que EXISTEN hoy en la comunidad: el selector del formulario
     *  de grupos se arma con esto, no con texto libre. */
    async communityTowers(tx: TxClient, communityId: string): Promise<string[]> {
        const result = await tx.query<{ tower: string }>(
            `SELECT DISTINCT tower
               FROM community.units
              WHERE community_id = $1 AND status = 'active' AND tower IS NOT NULL AND tower <> ''
              ORDER BY tower`,
            [communityId],
        );
        return result.rows.map((row) => row.tower);
    },
};
