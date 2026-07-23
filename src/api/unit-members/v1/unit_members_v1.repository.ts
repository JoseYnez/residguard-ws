import type { TxClient } from "../../../core/db/with_transaction";

// Acceso a datos del recurso unit-members (community.unit_members). Las
// consultas llegan acotadas a una unidad ya autorizada (requireUnitAccess) y
// el RLS filtra el tenant. Sin DELETE físico: baja = status='deleted'.

export interface UnitMember {
  readonly id: string;
  readonly unitId: string;
  readonly userId: string | null;
  readonly memberType: string;
  readonly fullName: string;
  readonly phone: string | null;
  readonly email: string | null;
  readonly status: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateUnitMemberInput {
  readonly memberType: string;
  readonly fullName: string;
  readonly phone?: string | null;
  readonly email?: string | null;
  readonly userId?: string | null;
}

export interface UpdateUnitMemberInput {
  readonly memberType?: string;
  readonly fullName?: string;
  readonly phone?: string | null;
  readonly email?: string | null;
  readonly userId?: string | null;
  readonly status?: string;
}

export interface ListUnitMembersInput {
  readonly unitId: string;
  readonly page: number;
  readonly pageSize: number;
  readonly search?: string | null;
  readonly memberType?: string | null;
}

const SELECT_COLUMNS = `
  id, unit_id, user_id, member_type, full_name, phone, email::text AS email,
  status, created_at, updated_at
`;

interface UnitMemberRow {
  id: string;
  unit_id: string;
  user_id: string | null;
  member_type: string;
  full_name: string;
  phone: string | null;
  email: string | null;
  status: string;
  created_at: Date;
  updated_at: Date;
}

function mapRow(row: UnitMemberRow): UnitMember {
  return {
    id: row.id,
    unitId: row.unit_id,
    userId: row.user_id,
    memberType: row.member_type,
    fullName: row.full_name,
    phone: row.phone,
    email: row.email,
    status: row.status,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export const unitMembersRepository = {
  /** Miembros de la unidad (paginado). Sin filtro de status oculta 'deleted'. */
  async list(
    tx: TxClient,
    input: ListUnitMembersInput,
  ): Promise<{ items: UnitMember[]; total: number }> {
    const search = input.search ?? null;
    const memberType = input.memberType ?? null;
    const offset = (input.page - 1) * input.pageSize;

    const where = `
      WHERE unit_id = $1
        AND status != 'deleted'
        AND ($2::text IS NULL OR full_name ILIKE '%' || $2 || '%' OR email ILIKE '%' || $2 || '%')
        AND ($3::community.member_type IS NULL OR member_type = $3::community.member_type)
    `;

    const totalResult = await tx.query<{ count: string }>(
      `SELECT count(*)::bigint AS count FROM community.unit_members ${where}`,
      [input.unitId, search, memberType],
    );
    const total = Number(totalResult.rows[0]?.count ?? 0);

    const itemsResult = await tx.query<UnitMemberRow>(
      `SELECT ${SELECT_COLUMNS} FROM community.unit_members ${where}
        ORDER BY full_name
        LIMIT $4 OFFSET $5`,
      [input.unitId, search, memberType, input.pageSize, offset],
    );

    return { items: itemsResult.rows.map(mapRow), total };
  },

  /** Un miembro de la unidad. null si no existe o está dado de baja. */
  async getById(tx: TxClient, unitId: string, id: string): Promise<UnitMember | null> {
    const result = await tx.query<UnitMemberRow>(
      `SELECT ${SELECT_COLUMNS} FROM community.unit_members
        WHERE id = $1 AND unit_id = $2 AND status != 'deleted'`,
      [id, unitId],
    );
    const row = result.rows[0];
    return row === undefined ? null : mapRow(row);
  },

  /**
   * Inserta un miembro. Puede lanzar 23505 (usuario o email ya asociados a la
   * unidad) o 23503 (userId inexistente en el espejo o de otro tenant).
   */
  async create(
    tx: TxClient,
    customerId: string,
    unitId: string,
    input: CreateUnitMemberInput,
  ): Promise<UnitMember> {
    const result = await tx.query<UnitMemberRow>(
      `INSERT INTO community.unit_members
         (customer_id, unit_id, user_id, member_type, full_name, phone, email)
       VALUES ($1, $2, $3, $4::community.member_type, $5, $6, $7)
       RETURNING ${SELECT_COLUMNS}`,
      [
        customerId,
        unitId,
        input.userId ?? null,
        input.memberType,
        input.fullName,
        input.phone ?? null,
        input.email ?? null,
      ],
    );
    return mapRow(result.rows[0]!);
  },

  /** Actualización parcial. Devuelve null si no existe (o está 'deleted'). */
  async update(
    tx: TxClient,
    unitId: string,
    id: string,
    input: UpdateUnitMemberInput,
  ): Promise<UnitMember | null> {
    const sets: string[] = [];
    const params: unknown[] = [];
    let i = 1;

    const push = (column: string, value: unknown, cast = ""): void => {
      sets.push(`${column} = $${i}${cast}`);
      params.push(value);
      i += 1;
    };

    if (input.memberType !== undefined) push("member_type", input.memberType, "::community.member_type");
    if (input.fullName !== undefined) push("full_name", input.fullName);
    if (input.phone !== undefined) push("phone", input.phone);
    if (input.email !== undefined) push("email", input.email);
    if (input.userId !== undefined) push("user_id", input.userId);
    if (input.status !== undefined) push("status", input.status, "::public.record_status");

    if (sets.length === 0) {
      return this.getById(tx, unitId, id);
    }

    params.push(id, unitId);
    const result = await tx.query<UnitMemberRow>(
      `UPDATE community.unit_members SET ${sets.join(", ")}
        WHERE id = $${i} AND unit_id = $${i + 1} AND status != 'deleted'
        RETURNING ${SELECT_COLUMNS}`,
      params,
    );
    const row = result.rows[0];
    return row === undefined ? null : mapRow(row);
  },

  /** Baja lógica (status='deleted'). false si no existía o ya estaba de baja. */
  async softDelete(tx: TxClient, unitId: string, id: string): Promise<boolean> {
    const result = await tx.query(
      `UPDATE community.unit_members SET status = 'deleted'
        WHERE id = $1 AND unit_id = $2 AND status != 'deleted'`,
      [id, unitId],
    );
    return (result.rowCount ?? 0) > 0;
  },
};
