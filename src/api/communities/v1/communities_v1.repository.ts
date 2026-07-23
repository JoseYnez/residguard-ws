import type { TxClient } from "../../../core/db/with_transaction";

// Acceso a datos del recurso communities. Solo lectura: el alcance del actor
// (usuario del token) se resuelve SIEMPRE via community.community_members —
// una comunidad sin membresía activa es invisible, además del RLS de tenant.

export interface Community {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly address: string | null;
  readonly status: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ListCommunitiesInput {
  readonly userId: string;
  readonly page: number;
  readonly pageSize: number;
  readonly search?: string | null;
}

interface CommunityRow {
  id: string;
  code: string;
  name: string;
  address: string | null;
  status: string;
  created_at: Date;
  updated_at: Date;
}

function mapRow(row: CommunityRow): Community {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    address: row.address,
    status: row.status,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

/** JOIN de alcance: comunidades con membresía activa del usuario. */
const ACCESS_JOIN = `
  JOIN community.community_members cm
    ON cm.customer_id = c.customer_id
   AND cm.community_id = c.id
   AND cm.user_id = $1
   AND cm.status = 'active'
`;

export const communitiesRepository = {
  /** Comunidades visibles para el usuario (paginado). */
  async list(
    tx: TxClient,
    input: ListCommunitiesInput,
  ): Promise<{ items: Community[]; total: number }> {
    const search = input.search ?? null;
    const offset = (input.page - 1) * input.pageSize;

    const where = `
      WHERE c.status = 'active'
        AND ($2::text IS NULL OR c.name ILIKE '%' || $2 || '%' OR c.code ILIKE '%' || $2 || '%')
    `;

    const totalResult = await tx.query<{ count: string }>(
      `SELECT count(*)::bigint AS count FROM community.communities c ${ACCESS_JOIN} ${where}`,
      [input.userId, search],
    );
    const total = Number(totalResult.rows[0]?.count ?? 0);

    const itemsResult = await tx.query<CommunityRow>(
      `SELECT c.id, c.code, c.name, c.address, c.status, c.created_at, c.updated_at
         FROM community.communities c ${ACCESS_JOIN} ${where}
        ORDER BY c.name
        LIMIT $3 OFFSET $4`,
      [input.userId, search, input.pageSize, offset],
    );

    return { items: itemsResult.rows.map(mapRow), total };
  },

  /** Una comunidad del alcance del usuario. null = inexistente o fuera de alcance. */
  async getById(tx: TxClient, userId: string, communityId: string): Promise<Community | null> {
    const result = await tx.query<CommunityRow>(
      `SELECT c.id, c.code, c.name, c.address, c.status, c.created_at, c.updated_at
         FROM community.communities c ${ACCESS_JOIN}
        WHERE c.id = $2 AND c.status = 'active'`,
      [userId, communityId],
    );
    const row = result.rows[0];
    return row === undefined ? null : mapRow(row);
  },

  /** Saldo de la caja (derivado por billing.fn_get_community_balance). */
  async getBalance(
    tx: TxClient,
    communityId: string,
    toDate: string | null,
  ): Promise<number | null> {
    const result = await tx.query<{ balance: string | null }>(
      `SELECT billing.fn_get_community_balance($1, $2::date)::text AS balance`,
      [communityId, toDate],
    );
    const balance = result.rows[0]?.balance ?? null;
    return balance === null ? null : Number(balance);
  },
};
