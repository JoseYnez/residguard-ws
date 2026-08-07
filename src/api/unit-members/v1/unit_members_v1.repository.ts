import type { TxClient } from "../../../core/db/with_transaction";

// Acceso a datos del recurso unit-members (community.unit_members): la relación
// PURA persona↔unidad. Los datos de la persona viven en el padrón
// (community.members) y aquí solo se referencian por member_id; el rol
// (member_type) sí es de la relación. Sin DELETE físico: baja = status='deleted'.
//
// Dos vistas del mismo hecho:
//   * por UNIDAD (¿quiénes están en la 426-A?) — lecturas de /units/:unitId/members
//   * por MIEMBRO (¿qué unidades tiene Ana?) — CRUD de /members/:memberId/units
// Las mutaciones van SIEMPRE por miembro: la pantalla de Miembros es la única
// superficie de gestión de la relación.

/** La relación vista desde la unidad: quién, con datos del padrón. */
export interface UnitMember {
  readonly id: string;
  readonly unitId: string;
  readonly memberId: string;
  readonly memberType: string;
  readonly fullName: string;
  /** Teléfono principal derivado del padrón (el vigente más antiguo). */
  readonly phone: string | null;
  readonly email: string | null;
  readonly status: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** La relación vista desde el miembro: qué unidad, con datos de la unidad. */
export interface MemberUnit {
  readonly id: string;
  readonly unitId: string;
  readonly memberId: string;
  readonly memberType: string;
  readonly unitCode: string;
  readonly unitTower: string | null;
  readonly unitType: string;
  readonly status: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** One row of the community DIRECTORY: an assignment with the unit's locating
 *  data and the person's full contact (every active phone, not just the
 *  primary — the directory exists to hand over the contact). */
export interface DirectoryEntry {
  readonly id: string;
  readonly unitId: string;
  readonly unitCode: string;
  readonly unitTower: string | null;
  readonly unitAddress: string | null;
  readonly unitType: string;
  readonly memberId: string;
  readonly fullName: string;
  readonly memberType: string;
  readonly email: string | null;
  readonly phones: { phone: string; label: string | null }[];
}

export interface ListUnitMembersInput {
  readonly unitId: string;
  readonly page: number;
  readonly pageSize: number;
  readonly search?: string | null;
  readonly memberType?: string | null;
}

export interface ListDirectoryInput {
  readonly communityId: string;
  readonly page: number;
  readonly pageSize: number;
  readonly search?: string | null;
}

export interface ListMemberUnitsInput {
  readonly communityId: string;
  readonly memberId: string;
  readonly page: number;
  readonly pageSize: number;
}

export interface AssignMemberUnitInput {
  readonly unitId: string;
  readonly memberType: string;
}

// --- Vista por unidad --------------------------------------------------------

const UNIT_VIEW_COLUMNS = `
  um.id, um.unit_id, um.member_id, um.member_type, um.status,
  um.created_at, um.updated_at,
  m.full_name, m.email::text AS email, pp.phone AS primary_phone
`;

const UNIT_VIEW_FROM = `
  FROM community.unit_members um
  JOIN community.members m ON m.id = um.member_id
  LEFT JOIN LATERAL (
    SELECT p.phone
      FROM community.member_phones p
     WHERE p.member_id = m.id AND p.status = 'active'
     ORDER BY p.created_at, p.id
     LIMIT 1
  ) pp ON TRUE
`;

interface UnitViewRow {
  id: string;
  unit_id: string;
  member_id: string;
  member_type: string;
  status: string;
  created_at: Date;
  updated_at: Date;
  full_name: string;
  email: string | null;
  primary_phone: string | null;
}

function mapUnitViewRow(row: UnitViewRow): UnitMember {
  return {
    id: row.id,
    unitId: row.unit_id,
    memberId: row.member_id,
    memberType: row.member_type,
    fullName: row.full_name,
    phone: row.primary_phone,
    email: row.email,
    status: row.status,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

// --- Vista por miembro -------------------------------------------------------

const MEMBER_VIEW_COLUMNS = `
  um.id, um.unit_id, um.member_id, um.member_type, um.status,
  um.created_at, um.updated_at,
  u.code AS unit_code, u.tower AS unit_tower, u.unit_type::text AS unit_type
`;

const MEMBER_VIEW_FROM = `
  FROM community.unit_members um
  JOIN community.units u ON u.id = um.unit_id
`;

interface MemberViewRow {
  id: string;
  unit_id: string;
  member_id: string;
  member_type: string;
  status: string;
  created_at: Date;
  updated_at: Date;
  unit_code: string;
  unit_tower: string | null;
  unit_type: string;
}

function mapMemberViewRow(row: MemberViewRow): MemberUnit {
  return {
    id: row.id,
    unitId: row.unit_id,
    memberId: row.member_id,
    memberType: row.member_type,
    unitCode: row.unit_code,
    unitTower: row.unit_tower,
    unitType: row.unit_type,
    status: row.status,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export const unitMembersRepository = {
  /** Miembros de la unidad (paginado), con los datos del padrón. El search
   *  alcanza nombre y correo de la persona. Oculta 'deleted'. */
  async list(
    tx: TxClient,
    input: ListUnitMembersInput,
  ): Promise<{ items: UnitMember[]; total: number }> {
    const search = input.search ?? null;
    const memberType = input.memberType ?? null;
    const offset = (input.page - 1) * input.pageSize;

    const where = `
      WHERE um.unit_id = $1
        AND um.status != 'deleted'
        AND ($2::text IS NULL OR m.full_name ILIKE '%' || $2 || '%' OR m.email ILIKE '%' || $2 || '%')
        AND ($3::community.member_type IS NULL OR um.member_type = $3::community.member_type)
    `;

    const totalResult = await tx.query<{ count: string }>(
      `SELECT count(*)::bigint AS count
         FROM community.unit_members um
         JOIN community.members m ON m.id = um.member_id
        ${where}`,
      [input.unitId, search, memberType],
    );
    const total = Number(totalResult.rows[0]?.count ?? 0);

    const itemsResult = await tx.query<UnitViewRow>(
      `SELECT ${UNIT_VIEW_COLUMNS} ${UNIT_VIEW_FROM} ${where}
        ORDER BY m.full_name
        LIMIT $4 OFFSET $5`,
      [input.unitId, search, memberType, input.pageSize, offset],
    );

    return { items: itemsResult.rows.map(mapUnitViewRow), total };
  },

  /** Un miembro de la unidad. null si no existe o está dado de baja. */
  async getById(tx: TxClient, unitId: string, id: string): Promise<UnitMember | null> {
    const result = await tx.query<UnitViewRow>(
      `SELECT ${UNIT_VIEW_COLUMNS} ${UNIT_VIEW_FROM}
        WHERE um.id = $1 AND um.unit_id = $2 AND um.status != 'deleted'`,
      [id, unitId],
    );
    const row = result.rows[0];
    return row === undefined ? null : mapUnitViewRow(row);
  },

  /**
   * El DIRECTORIO de la comunidad (paginado): cada asignación vigente con la
   * unidad que la ubica y el contacto completo de la persona (todos sus
   * teléfonos activos, del principal en adelante). Solo lo vigente: unidad y
   * persona activas — un directorio lista a quien se puede contactar HOY.
   * El search alcanza código/torre/dirección de la unidad y nombre de la
   * persona (el filtrado fino lo hace el cliente sobre la lista drenada).
   */
  async listDirectory(
    tx: TxClient,
    input: ListDirectoryInput,
  ): Promise<{ items: DirectoryEntry[]; total: number }> {
    const search = input.search ?? null;
    const offset = (input.page - 1) * input.pageSize;

    // FROM/JOINs y WHERE separados: la consulta de items intercala su LATERAL
    // de teléfonos entre ambos (los JOIN van antes del WHERE).
    const joins = `
      FROM community.unit_members um
      JOIN community.units u   ON u.id = um.unit_id
      JOIN community.members m ON m.id = um.member_id
    `;
    const where = `
      WHERE um.community_id = $1
        AND um.status != 'deleted'
        AND u.status  = 'active'
        AND m.status  = 'active'
        AND ($2::text IS NULL
             OR u.code      ILIKE '%' || $2 || '%'
             OR u.tower     ILIKE '%' || $2 || '%'
             OR u.address   ILIKE '%' || $2 || '%'
             OR m.full_name ILIKE '%' || $2 || '%')
    `;

    const totalResult = await tx.query<{ count: string }>(
      `SELECT count(*)::bigint AS count ${joins} ${where}`,
      [input.communityId, search],
    );
    const total = Number(totalResult.rows[0]?.count ?? 0);

    interface DirectoryRow {
      id: string;
      unit_id: string;
      unit_code: string;
      unit_tower: string | null;
      unit_address: string | null;
      unit_type: string;
      member_id: string;
      full_name: string;
      member_type: string;
      email: string | null;
      phones: { phone: string; label: string | null }[];
    }

    // El LATERAL agrega TODOS los teléfonos activos de la persona (json_agg,
    // del más antiguo — el principal — en adelante). Va solo en la consulta de
    // items: no participa en el WHERE, así que el count no lo necesita.
    const itemsResult = await tx.query<DirectoryRow>(
      `SELECT um.id, um.member_type,
              u.id AS unit_id, u.code AS unit_code, u.tower AS unit_tower,
              u.address AS unit_address, u.unit_type::text AS unit_type,
              m.id AS member_id, m.full_name, m.email::text AS email,
              COALESCE(ph.phones, '[]'::json) AS phones
       ${joins}
       LEFT JOIN LATERAL (
         SELECT json_agg(json_build_object('phone', p.phone, 'label', p.label)
                         ORDER BY p.created_at, p.id) AS phones
           FROM community.member_phones p
          WHERE p.member_id = m.id AND p.status = 'active'
       ) ph ON TRUE
       ${where}
       ORDER BY u.code, m.full_name
       LIMIT $3 OFFSET $4`,
      [input.communityId, search, input.pageSize, offset],
    );

    return {
      items: itemsResult.rows.map((row) => ({
        id: row.id,
        unitId: row.unit_id,
        unitCode: row.unit_code,
        unitTower: row.unit_tower,
        unitAddress: row.unit_address,
        unitType: row.unit_type,
        memberId: row.member_id,
        fullName: row.full_name,
        memberType: row.member_type,
        email: row.email,
        phones: row.phones,
      })),
      total,
    };
  },

  /** ¿Existe la persona (no eliminada) en la comunidad? Para el 404 de las
   *  rutas /members/:memberId/units antes de listar o mutar. */
  async memberExists(tx: TxClient, communityId: string, memberId: string): Promise<boolean> {
    const result = await tx.query(
      `SELECT 1 FROM community.members
        WHERE id = $1 AND community_id = $2 AND status != 'deleted'`,
      [memberId, communityId],
    );
    return (result.rowCount ?? 0) > 0;
  },

  /** Unidades del miembro (paginado), con los datos de la unidad. */
  async listByMember(
    tx: TxClient,
    input: ListMemberUnitsInput,
  ): Promise<{ items: MemberUnit[]; total: number }> {
    const offset = (input.page - 1) * input.pageSize;

    const where = `
      WHERE um.member_id = $1
        AND um.community_id = $2
        AND um.status != 'deleted'
    `;

    const totalResult = await tx.query<{ count: string }>(
      `SELECT count(*)::bigint AS count FROM community.unit_members um ${where}`,
      [input.memberId, input.communityId],
    );
    const total = Number(totalResult.rows[0]?.count ?? 0);

    const itemsResult = await tx.query<MemberViewRow>(
      `SELECT ${MEMBER_VIEW_COLUMNS} ${MEMBER_VIEW_FROM} ${where}
        ORDER BY u.code
        LIMIT $3 OFFSET $4`,
      [input.memberId, input.communityId, input.pageSize, offset],
    );

    return { items: itemsResult.rows.map(mapMemberViewRow), total };
  },

  /**
   * Asigna una unidad al miembro. Puede lanzar 23505 (el miembro ya está
   * vigente en esa unidad) o 23503 (la unidad no existe en esa comunidad — la
   * FK compuesta (customer, community, unit) rechaza unidades ajenas).
   */
  async assign(
    tx: TxClient,
    customerId: string,
    communityId: string,
    memberId: string,
    input: AssignMemberUnitInput,
  ): Promise<MemberUnit> {
    const result = await tx.query<{ id: string }>(
      `INSERT INTO community.unit_members
         (customer_id, community_id, unit_id, member_id, member_type)
       VALUES ($1, $2, $3, $4, $5::community.member_type)
       RETURNING id`,
      [customerId, communityId, input.unitId, memberId, input.memberType],
    );
    const id = result.rows[0]!.id;
    return (await this.getAssignmentById(tx, communityId, memberId, id))!;
  },

  /** Una asignación del miembro (vista por miembro). null si no existe. */
  async getAssignmentById(
    tx: TxClient,
    communityId: string,
    memberId: string,
    id: string,
  ): Promise<MemberUnit | null> {
    const result = await tx.query<MemberViewRow>(
      `SELECT ${MEMBER_VIEW_COLUMNS} ${MEMBER_VIEW_FROM}
        WHERE um.id = $1 AND um.member_id = $2 AND um.community_id = $3
          AND um.status != 'deleted'`,
      [id, memberId, communityId],
    );
    const row = result.rows[0];
    return row === undefined ? null : mapMemberViewRow(row);
  },

  /** Cambia el rol de una asignación. null si no existe (o está 'deleted'). */
  async updateAssignment(
    tx: TxClient,
    communityId: string,
    memberId: string,
    id: string,
    memberType: string,
  ): Promise<MemberUnit | null> {
    const result = await tx.query(
      `UPDATE community.unit_members SET member_type = $1::community.member_type
        WHERE id = $2 AND member_id = $3 AND community_id = $4 AND status != 'deleted'`,
      [memberType, id, memberId, communityId],
    );
    if ((result.rowCount ?? 0) === 0) {
      return null;
    }
    return this.getAssignmentById(tx, communityId, memberId, id);
  },

  /** Baja lógica de una asignación. false si no existía o ya estaba de baja. */
  async softDeleteAssignment(
    tx: TxClient,
    communityId: string,
    memberId: string,
    id: string,
  ): Promise<boolean> {
    const result = await tx.query(
      `UPDATE community.unit_members SET status = 'deleted'
        WHERE id = $1 AND member_id = $2 AND community_id = $3 AND status != 'deleted'`,
      [id, memberId, communityId],
    );
    return (result.rowCount ?? 0) > 0;
  },
};
