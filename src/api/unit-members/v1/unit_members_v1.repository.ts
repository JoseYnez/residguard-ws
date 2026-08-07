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

export interface ListUnitMembersInput {
  readonly unitId: string;
  readonly page: number;
  readonly pageSize: number;
  readonly search?: string | null;
  readonly memberType?: string | null;
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
