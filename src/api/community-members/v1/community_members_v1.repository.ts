import type { TxClient } from "../../../core/db/with_transaction";

// Acceso a datos del recurso community-members (community.community_members).
// El JOIN con core.users (espejo, solo lectura) aporta nombre/email para la
// UI. La baja de acceso es lógica (status='deleted'); re-otorgar crea fila
// nueva (la unicidad parcial ignora soft-deleted).

export interface CommunityMember {
  readonly id: string;
  readonly communityId: string;
  readonly userId: string;
  readonly fullName: string;
  readonly email: string;
  readonly status: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ListCommunityMembersInput {
  readonly communityId: string;
  readonly page: number;
  readonly pageSize: number;
  readonly search?: string | null;
}

interface CommunityMemberRow {
  id: string;
  community_id: string;
  user_id: string;
  full_name: string;
  email: string;
  status: string;
  created_at: Date;
  updated_at: Date;
}

function mapRow(row: CommunityMemberRow): CommunityMember {
  return {
    id: row.id,
    communityId: row.community_id,
    userId: row.user_id,
    fullName: row.full_name,
    email: row.email,
    status: row.status,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

const SELECT = `
  SELECT cm.id, cm.community_id, cm.user_id, u.full_name, u.email::text AS email,
         cm.status, cm.created_at, cm.updated_at
    FROM community.community_members cm
    JOIN core.users u
      ON u.customer_id = cm.customer_id AND u.id = cm.user_id
`;

export const communityMembersRepository = {
  /** Membresías de una comunidad (paginado, con datos del espejo de usuario). */
  async list(
    tx: TxClient,
    input: ListCommunityMembersInput,
  ): Promise<{ items: CommunityMember[]; total: number }> {
    const search = input.search ?? null;
    const offset = (input.page - 1) * input.pageSize;

    const where = `
      WHERE cm.community_id = $1
        AND cm.status != 'deleted'
        AND ($2::text IS NULL OR u.full_name ILIKE '%' || $2 || '%' OR u.email ILIKE '%' || $2 || '%')
    `;

    const totalResult = await tx.query<{ count: string }>(
      `SELECT count(*)::bigint AS count
         FROM community.community_members cm
         JOIN core.users u ON u.customer_id = cm.customer_id AND u.id = cm.user_id
        ${where}`,
      [input.communityId, search],
    );
    const total = Number(totalResult.rows[0]?.count ?? 0);

    const itemsResult = await tx.query<CommunityMemberRow>(
      `${SELECT} ${where}
        ORDER BY u.full_name
        LIMIT $3 OFFSET $4`,
      [input.communityId, search, input.pageSize, offset],
    );

    return { items: itemsResult.rows.map(mapRow), total };
  },

  /**
   * Otorga acceso: inserta la membresía. Puede lanzar 23505 (el usuario ya es
   * miembro) o 23503 (usuario inexistente en el espejo o de otro tenant).
   */
  async create(
    tx: TxClient,
    customerId: string,
    communityId: string,
    userId: string,
  ): Promise<CommunityMember> {
    const inserted = await tx.query<{ id: string }>(
      `INSERT INTO community.community_members (customer_id, community_id, user_id)
       VALUES ($1, $2, $3)
       RETURNING id`,
      [customerId, communityId, userId],
    );
    const id = inserted.rows[0]!.id;
    const result = await tx.query<CommunityMemberRow>(`${SELECT} WHERE cm.id = $1`, [id]);
    return mapRow(result.rows[0]!);
  },

  /** Revoca el acceso (soft delete), acotado a la comunidad de la ruta. */
  async softDelete(tx: TxClient, communityId: string, id: string): Promise<boolean> {
    const result = await tx.query(
      `UPDATE community.community_members
          SET status = 'deleted'
        WHERE id = $1 AND community_id = $2 AND status != 'deleted'`,
      [id, communityId],
    );
    return (result.rowCount ?? 0) > 0;
  },
};
