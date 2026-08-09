import type { TxClient } from "../../../core/db/with_transaction";

// Acceso a datos del recurso members (community.members): el padrón de personas
// de una comunidad. Las consultas llegan acotadas a una comunidad ya autorizada
// (requireCommunityAccess) y el RLS filtra el tenant. Sin DELETE físico: baja =
// status='deleted'.
//
// `userId` se expone en la salida pero NO se acepta como entrada: toda fila
// nace con user_id NULL y el vínculo se fija únicamente por el flujo de
// invitación (POST .../members/:memberId/invitation): la plataforma responde el
// userId (creado o existente), `linkUser` siembra el espejo core.users en la
// misma transacción y fija members.user_id. No hay servicio de sincronización
// de identidad aparte — el espejo se puebla cuando un usuario se vuelve
// relevante para ResidGuard, es decir, aquí.
//
// Tampoco hay `memberType`: el rol (owner/tenant/resident) califica a la
// RELACIÓN persona↔unidad —alguien es propietario de una unidad y arrendatario
// de otra—, así que vive en unit-members/v1. Este recurso responde QUIÉN es la
// persona; el rol se lee por unidad.
//
// TELÉFONOS: viven en community.member_phones (0..N por persona, cada uno con
// baja lógica propia). El `phone` de la salida es DERIVADO: el teléfono vigente
// más antiguo (el "principal" de facto). El detalle expone la lista completa;
// alta y baja de números van por el subrecurso /phones.

export interface MemberPhone {
  readonly id: string;
  readonly phone: string;
  readonly label: string | null;
  readonly createdAt: string;
}

export interface Member {
  readonly id: string;
  readonly communityId: string;
  readonly userId: string | null;
  readonly fullName: string;
  /** Teléfono principal derivado (el vigente más antiguo); null sin teléfonos. */
  readonly phone: string | null;
  readonly email: string | null;
  readonly notes: string | null;
  /**
   * Códigos de las unidades vigentes de la persona, ordenados (arreglo mutable
   * a propósito: el tipo de respuesta que infiere el verifier de Fastify no
   * admite ReadonlyArray). El listado los muestra en una sola celda: cuántas
   * son se ve contándolas, y CUÁLES son es lo que el operador necesita.
   */
  readonly unitCodes: string[];
  readonly status: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Miembro con su lista completa de teléfonos (GET detalle y mutaciones). */
export interface MemberDetail extends Member {
  // Arreglo mutable a propósito: el tipo de respuesta que infiere el verifier
  // de Fastify no admite ReadonlyArray.
  readonly phones: MemberPhone[];
}

export interface CreateMemberInput {
  readonly fullName: string;
  /** Primer teléfono de la persona; crea la fila en member_phones. */
  readonly phone?: string | null;
  readonly email?: string | null;
  readonly notes?: string | null;
}

export interface UpdateMemberInput {
  readonly fullName?: string;
  readonly email?: string | null;
  readonly notes?: string | null;
  readonly status?: string;
}

export interface ListMembersInput {
  readonly communityId: string;
  readonly page: number;
  readonly pageSize: number;
  readonly search?: string | null;
}

export interface CreatePhoneInput {
  readonly phone: string;
  readonly label?: string | null;
}

// El teléfono principal y las unidades son derivados; el LATERAL toma el
// vigente más antiguo (mismo orden que la lista completa del detalle) y la
// subconsulta agrega los códigos de unidad por `code` (mismo orden que la
// lista de asignaciones del miembro en unit-members/v1).
const SELECT_COLUMNS = `
  m.id, m.community_id, m.user_id, m.full_name, m.email::text AS email,
  m.notes, m.status, m.created_at, m.updated_at,
  pp.phone AS primary_phone,
  (SELECT COALESCE(json_agg(u.code ORDER BY u.code), '[]'::json)
     FROM community.unit_members um
     JOIN community.units u ON u.id = um.unit_id
    WHERE um.member_id = m.id AND um.status != 'deleted') AS unit_codes
`;

const FROM_MEMBERS = `
  FROM community.members m
  LEFT JOIN LATERAL (
    SELECT p.phone
      FROM community.member_phones p
     WHERE p.member_id = m.id AND p.status = 'active'
     ORDER BY p.created_at, p.id
     LIMIT 1
  ) pp ON TRUE
`;

interface MemberRow {
  id: string;
  community_id: string;
  user_id: string | null;
  full_name: string;
  email: string | null;
  notes: string | null;
  status: string;
  created_at: Date;
  updated_at: Date;
  primary_phone: string | null;
  unit_codes: string[];
}

interface PhoneRow {
  id: string;
  phone: string;
  label: string | null;
  created_at: Date;
}

function mapRow(row: MemberRow): Member {
  return {
    id: row.id,
    communityId: row.community_id,
    userId: row.user_id,
    fullName: row.full_name,
    phone: row.primary_phone,
    email: row.email,
    notes: row.notes,
    unitCodes: row.unit_codes,
    status: row.status,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function mapPhoneRow(row: PhoneRow): MemberPhone {
  return {
    id: row.id,
    phone: row.phone,
    label: row.label,
    createdAt: row.created_at.toISOString(),
  };
}

export const membersRepository = {
  /** Personas del padrón de la comunidad (paginado). Oculta las 'deleted'.
   *  El search también alcanza cualquier teléfono vigente de la persona. */
  async list(tx: TxClient, input: ListMembersInput): Promise<{ items: Member[]; total: number }> {
    const search = input.search ?? null;
    const offset = (input.page - 1) * input.pageSize;

    const where = `
      WHERE m.community_id = $1
        AND m.status != 'deleted'
        AND ($2::text IS NULL OR m.full_name ILIKE '%' || $2 || '%' OR m.email ILIKE '%' || $2 || '%'
             OR EXISTS (SELECT 1 FROM community.member_phones ph
                         WHERE ph.member_id = m.id AND ph.status = 'active'
                           AND ph.phone ILIKE '%' || $2 || '%'))
    `;

    const totalResult = await tx.query<{ count: string }>(
      `SELECT count(*)::bigint AS count FROM community.members m ${where}`,
      [input.communityId, search],
    );
    const total = Number(totalResult.rows[0]?.count ?? 0);

    const itemsResult = await tx.query<MemberRow>(
      `SELECT ${SELECT_COLUMNS} ${FROM_MEMBERS} ${where}
        ORDER BY m.full_name
        LIMIT $3 OFFSET $4`,
      [input.communityId, search, input.pageSize, offset],
    );

    return { items: itemsResult.rows.map(mapRow), total };
  },

  /** Una persona del padrón con sus teléfonos. null si no existe o está de baja. */
  async getById(tx: TxClient, communityId: string, id: string): Promise<MemberDetail | null> {
    const result = await tx.query<MemberRow>(
      `SELECT ${SELECT_COLUMNS} ${FROM_MEMBERS}
        WHERE m.id = $1 AND m.community_id = $2 AND m.status != 'deleted'`,
      [id, communityId],
    );
    const row = result.rows[0];
    if (row === undefined) {
      return null;
    }
    const phones = await this.listPhones(tx, communityId, id);
    return { ...mapRow(row), phones };
  },

  /** ¿Existe la persona (no eliminada) en la comunidad? Para el 404 de los
   *  subrecursos (/phones) antes de mutar. */
  async exists(tx: TxClient, communityId: string, id: string): Promise<boolean> {
    const result = await tx.query(
      `SELECT 1 FROM community.members
        WHERE id = $1 AND community_id = $2 AND status != 'deleted'`,
      [id, communityId],
    );
    return (result.rowCount ?? 0) > 0;
  },

  /**
   * Inserta una persona en el padrón; si trae teléfono, crea también su primera
   * fila en member_phones (misma transacción). Puede lanzar 23505 (ya hay
   * alguien con ese email en la comunidad) o 23503 (la comunidad no existe en
   * el tenant). `user_id` no se parametriza: nace NULL por omisión.
   */
  async create(
    tx: TxClient,
    customerId: string,
    communityId: string,
    input: CreateMemberInput,
  ): Promise<MemberDetail> {
    const result = await tx.query<{ id: string }>(
      `INSERT INTO community.members
         (customer_id, community_id, full_name, email, notes)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [customerId, communityId, input.fullName, input.email ?? null, input.notes ?? null],
    );
    const id = result.rows[0]!.id;

    const phone = input.phone ?? null;
    if (phone !== null) {
      await tx.query(
        `INSERT INTO community.member_phones (customer_id, community_id, member_id, phone)
         VALUES ($1, $2, $3, $4)`,
        [customerId, communityId, id, phone],
      );
    }

    // Relee con los derivados (teléfono principal, unitCodes) ya calculados.
    return (await this.getById(tx, communityId, id))!;
  },

  /** Actualización parcial. Devuelve null si no existe (o está 'deleted'). */
  async update(
    tx: TxClient,
    communityId: string,
    id: string,
    input: UpdateMemberInput,
  ): Promise<MemberDetail | null> {
    const sets: string[] = [];
    const params: unknown[] = [];
    let i = 1;

    const push = (column: string, value: unknown, cast = ""): void => {
      sets.push(`${column} = $${i}${cast}`);
      params.push(value);
      i += 1;
    };

    if (input.fullName !== undefined) push("full_name", input.fullName);
    if (input.email !== undefined) push("email", input.email);
    if (input.notes !== undefined) push("notes", input.notes);
    if (input.status !== undefined) push("status", input.status, "::public.record_status");

    if (sets.length === 0) {
      return this.getById(tx, communityId, id);
    }

    params.push(id, communityId);
    const result = await tx.query(
      `UPDATE community.members SET ${sets.join(", ")}
        WHERE id = $${i} AND community_id = $${i + 1} AND status != 'deleted'`,
      params,
    );
    if ((result.rowCount ?? 0) === 0) {
      return null;
    }
    return this.getById(tx, communityId, id);
  },

  /**
   * Baja lógica de la persona Y de lo que cuelga de ella (teléfonos y
   * asignaciones de unidad vigentes): un padrón dado de baja no debe seguir
   * apareciendo en las unidades ni conservar números "vivos" huérfanos.
   * false si no existía o ya estaba de baja.
   */
  async softDelete(tx: TxClient, communityId: string, id: string): Promise<boolean> {
    const result = await tx.query(
      `UPDATE community.members SET status = 'deleted'
        WHERE id = $1 AND community_id = $2 AND status != 'deleted'`,
      [id, communityId],
    );
    if ((result.rowCount ?? 0) === 0) {
      return false;
    }
    await tx.query(
      `UPDATE community.member_phones SET status = 'deleted'
        WHERE member_id = $1 AND status != 'deleted'`,
      [id],
    );
    await tx.query(
      `UPDATE community.unit_members SET status = 'deleted'
        WHERE member_id = $1 AND status != 'deleted'`,
      [id],
    );
    return true;
  },

  // --- Vínculo persona↔usuario (members.user_id + espejo core.users) ---------

  /**
   * Vincula la persona al usuario de plataforma. Dos pasos en la MISMA
   * transacción:
   *
   *   1. Upsert del espejo core.users — sin fila ahí la FK compuesta
   *      fk_members_users rechazaría el vínculo. El espejo lleva UNA FILA POR
   *      TENANT del mismo usuario global (PK compuesta customer_id+id): la
   *      misma persona puede pertenecer a dos clientes de ResidGuard, y cada
   *      tenant siembra y refresca la suya.
   *   2. members.user_id, solo si estaba sin vincular.
   *
   * Puede lanzar 23505 (uq_members_customer_community_user: ese usuario ya está
   * vinculado a otra persona de la comunidad; o uq_users_customer_email: otro
   * usuario del tenant ya usa ese email en el espejo) o 23503 (fk_members_users).
   */
  async linkUser(
    tx: TxClient,
    customerId: string,
    communityId: string,
    memberId: string,
    user: { readonly id: string; readonly fullName: string; readonly email: string },
  ): Promise<"linked" | "not-found" | "linked-to-other"> {
    await tx.query(
      `INSERT INTO core.users (id, customer_id, full_name, email)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (customer_id, id) DO UPDATE
          SET full_name = EXCLUDED.full_name,
              email     = EXCLUDED.email,
              status    = 'active'`,
      [user.id, customerId, user.fullName, user.email],
    );

    const result = await tx.query(
      `UPDATE community.members SET user_id = $1
        WHERE id = $2 AND community_id = $3 AND status != 'deleted' AND user_id IS NULL`,
      [user.id, memberId, communityId],
    );
    if ((result.rowCount ?? 0) > 0) {
      return "linked";
    }

    // 0 filas: o la persona no existe, o ya estaba vinculada. Reintentar la
    // MISMA invitación es idempotente (mismo userId → "linked").
    const current = await tx.query<{ user_id: string | null }>(
      `SELECT user_id FROM community.members
        WHERE id = $1 AND community_id = $2 AND status != 'deleted'`,
      [memberId, communityId],
    );
    const row = current.rows[0];
    if (row === undefined) {
      return "not-found";
    }
    return row.user_id === user.id ? "linked" : "linked-to-other";
  },

  /** Quita el vínculo (user_id = NULL). NO toca la cuenta de plataforma ni sus
   *  accesos: eso se administra en admin_ws. false si la persona no existe. */
  async unlinkUser(tx: TxClient, communityId: string, memberId: string): Promise<boolean> {
    const exists = await this.exists(tx, communityId, memberId);
    if (!exists) {
      return false;
    }
    await tx.query(
      `UPDATE community.members SET user_id = NULL
        WHERE id = $1 AND community_id = $2 AND status != 'deleted' AND user_id IS NOT NULL`,
      [memberId, communityId],
    );
    return true;
  },

  // --- Teléfonos (community.member_phones) -----------------------------------

  /** Teléfonos vigentes de la persona, del más antiguo (el principal) al más
   *  nuevo. El JOIN ancla el miembro a la comunidad de la ruta. */
  async listPhones(
    tx: TxClient,
    communityId: string,
    memberId: string,
  ): Promise<MemberPhone[]> {
    const result = await tx.query<PhoneRow>(
      `SELECT p.id, p.phone, p.label, p.created_at
         FROM community.member_phones p
         JOIN community.members m ON m.id = p.member_id
        WHERE p.member_id = $1 AND m.community_id = $2 AND p.status = 'active'
        ORDER BY p.created_at, p.id`,
      [memberId, communityId],
    );
    return result.rows.map(mapPhoneRow);
  },

  /**
   * Agrega un teléfono a la persona. Puede lanzar 23505 (ese número ya está
   * vigente para la persona) o 23503 (la persona no existe en esa comunidad —
   * la FK compuesta lo remata aunque el controller ya haya verificado).
   */
  async addPhone(
    tx: TxClient,
    customerId: string,
    communityId: string,
    memberId: string,
    input: CreatePhoneInput,
  ): Promise<MemberPhone> {
    const result = await tx.query<PhoneRow>(
      `INSERT INTO community.member_phones (customer_id, community_id, member_id, phone, label)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, phone, label, created_at`,
      [customerId, communityId, memberId, input.phone, input.label ?? null],
    );
    return mapPhoneRow(result.rows[0]!);
  },

  /** Baja lógica de un teléfono. false si no existía o ya estaba de baja. */
  async softDeletePhone(
    tx: TxClient,
    communityId: string,
    memberId: string,
    id: string,
  ): Promise<boolean> {
    const result = await tx.query(
      `UPDATE community.member_phones SET status = 'deleted'
        WHERE id = $1 AND member_id = $2 AND community_id = $3 AND status != 'deleted'`,
      [id, memberId, communityId],
    );
    return (result.rowCount ?? 0) > 0;
  },
};
