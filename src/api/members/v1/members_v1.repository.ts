import type { TxClient } from "../../../core/db/with_transaction";

// Acceso a datos del recurso members (community.members): el padrón de personas
// de una comunidad. Las consultas llegan acotadas a una comunidad ya autorizada
// (requireCommunityAccess) y el RLS filtra el tenant. Sin DELETE físico: baja =
// status='deleted'.
//
// `userId` se expone en la salida pero NO se acepta como entrada: hoy toda fila
// nace con user_id NULL. Vincular a un usuario registrado exige que el espejo
// core.users esté poblado (sincronización de identidad, aún inexistente), y
// además es una decisión distinta de registrar a la persona — cuando llegue,
// será su propio endpoint.

export interface Member {
  readonly id: string;
  readonly communityId: string;
  readonly userId: string | null;
  readonly memberType: string;
  readonly fullName: string;
  readonly phone: string | null;
  readonly email: string | null;
  readonly notes: string | null;
  readonly status: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateMemberInput {
  readonly memberType: string;
  readonly fullName: string;
  readonly phone?: string | null;
  readonly email?: string | null;
  readonly notes?: string | null;
}

export interface UpdateMemberInput {
  readonly memberType?: string;
  readonly fullName?: string;
  readonly phone?: string | null;
  readonly email?: string | null;
  readonly notes?: string | null;
  readonly status?: string;
}

export interface ListMembersInput {
  readonly communityId: string;
  readonly page: number;
  readonly pageSize: number;
  readonly search?: string | null;
  readonly memberType?: string | null;
}

const SELECT_COLUMNS = `
  id, community_id, user_id, member_type, full_name, phone, email::text AS email,
  notes, status, created_at, updated_at
`;

interface MemberRow {
  id: string;
  community_id: string;
  user_id: string | null;
  member_type: string;
  full_name: string;
  phone: string | null;
  email: string | null;
  notes: string | null;
  status: string;
  created_at: Date;
  updated_at: Date;
}

function mapRow(row: MemberRow): Member {
  return {
    id: row.id,
    communityId: row.community_id,
    userId: row.user_id,
    memberType: row.member_type,
    fullName: row.full_name,
    phone: row.phone,
    email: row.email,
    notes: row.notes,
    status: row.status,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export const membersRepository = {
  /** Personas del padrón de la comunidad (paginado). Oculta las 'deleted'. */
  async list(tx: TxClient, input: ListMembersInput): Promise<{ items: Member[]; total: number }> {
    const search = input.search ?? null;
    const memberType = input.memberType ?? null;
    const offset = (input.page - 1) * input.pageSize;

    const where = `
      WHERE community_id = $1
        AND status != 'deleted'
        AND ($2::text IS NULL OR full_name ILIKE '%' || $2 || '%' OR email ILIKE '%' || $2 || '%'
                              OR phone     ILIKE '%' || $2 || '%')
        AND ($3::community.member_type IS NULL OR member_type = $3::community.member_type)
    `;

    const totalResult = await tx.query<{ count: string }>(
      `SELECT count(*)::bigint AS count FROM community.members ${where}`,
      [input.communityId, search, memberType],
    );
    const total = Number(totalResult.rows[0]?.count ?? 0);

    const itemsResult = await tx.query<MemberRow>(
      `SELECT ${SELECT_COLUMNS} FROM community.members ${where}
        ORDER BY full_name
        LIMIT $4 OFFSET $5`,
      [input.communityId, search, memberType, input.pageSize, offset],
    );

    return { items: itemsResult.rows.map(mapRow), total };
  },

  /** Una persona del padrón. null si no existe o está dada de baja. */
  async getById(tx: TxClient, communityId: string, id: string): Promise<Member | null> {
    const result = await tx.query<MemberRow>(
      `SELECT ${SELECT_COLUMNS} FROM community.members
        WHERE id = $1 AND community_id = $2 AND status != 'deleted'`,
      [id, communityId],
    );
    const row = result.rows[0];
    return row === undefined ? null : mapRow(row);
  },

  /**
   * Inserta una persona en el padrón. Puede lanzar 23505 (ya hay alguien con
   * ese email en la comunidad) o 23503 (la comunidad no existe en el tenant).
   * `user_id` no se parametriza: nace NULL por omisión.
   */
  async create(
    tx: TxClient,
    customerId: string,
    communityId: string,
    input: CreateMemberInput,
  ): Promise<Member> {
    const result = await tx.query<MemberRow>(
      `INSERT INTO community.members
         (customer_id, community_id, member_type, full_name, phone, email, notes)
       VALUES ($1, $2, $3::community.member_type, $4, $5, $6, $7)
       RETURNING ${SELECT_COLUMNS}`,
      [
        customerId,
        communityId,
        input.memberType,
        input.fullName,
        input.phone ?? null,
        input.email ?? null,
        input.notes ?? null,
      ],
    );
    return mapRow(result.rows[0]!);
  },

  /** Actualización parcial. Devuelve null si no existe (o está 'deleted'). */
  async update(
    tx: TxClient,
    communityId: string,
    id: string,
    input: UpdateMemberInput,
  ): Promise<Member | null> {
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
    if (input.notes !== undefined) push("notes", input.notes);
    if (input.status !== undefined) push("status", input.status, "::public.record_status");

    if (sets.length === 0) {
      return this.getById(tx, communityId, id);
    }

    params.push(id, communityId);
    const result = await tx.query<MemberRow>(
      `UPDATE community.members SET ${sets.join(", ")}
        WHERE id = $${i} AND community_id = $${i + 1} AND status != 'deleted'
        RETURNING ${SELECT_COLUMNS}`,
      params,
    );
    const row = result.rows[0];
    return row === undefined ? null : mapRow(row);
  },

  /** Baja lógica (status='deleted'). false si no existía o ya estaba de baja. */
  async softDelete(tx: TxClient, communityId: string, id: string): Promise<boolean> {
    const result = await tx.query(
      `UPDATE community.members SET status = 'deleted'
        WHERE id = $1 AND community_id = $2 AND status != 'deleted'`,
      [id, communityId],
    );
    return (result.rowCount ?? 0) > 0;
  },
};
