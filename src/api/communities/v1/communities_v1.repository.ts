import type { TxClient } from "../../../core/db/with_transaction";

// Acceso a datos del recurso communities. El alcance del actor (usuario del
// token) se resuelve SIEMPRE via community.community_members — una comunidad
// sin membresía activa es invisible, además del RLS de tenant.
//
// Las mutaciones NO llevan preHandler de alcance: lo aplica el mismo JOIN de
// membresía de las lecturas (fuera de él → 404). Y a diferencia de
// `userHasCommunityAccess`, aquí la comunidad NO tiene que estar activa: si lo
// exigiera, desactivar una comunidad sería un viaje sin retorno (nadie podría
// volver a activarla). El criterio es status != 'deleted'.

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
  /**
   * `active` (DEFAULT, lo que espera el selector de alcance de las apps) ·
   * `inactive` · `all` (todo lo no eliminado, para la pantalla de
   * administración, que también gestiona las inactivas). El verifier de la
   * ruta es quien restringe los valores admitidos.
   */
  readonly status?: string | null;
}

export interface CreateCommunityInput {
  readonly code: string;
  readonly name: string;
  readonly address?: string | null;
}

export interface UpdateCommunityInput {
  readonly code?: string;
  readonly name?: string;
  readonly address?: string | null;
  readonly status?: string;
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
  /** Comunidades visibles para el usuario (paginado). Sin `status` explícito
   *  devuelve solo las activas (contrato histórico del selector de alcance). */
  async list(
    tx: TxClient,
    input: ListCommunitiesInput,
  ): Promise<{ items: Community[]; total: number }> {
    const search = input.search ?? null;
    const status = input.status ?? "active";
    const offset = (input.page - 1) * input.pageSize;

    // 'all' = todo lo no eliminado; cualquier otro valor filtra por ese estatus.
    // La comparación es `status::text` (no un cast del parámetro al enum): con
    // 'all' ese cast reventaría al planear, aunque la otra rama fuera la cierta.
    const where = `
      WHERE c.status != 'deleted'
        AND ($3::text = 'all' OR c.status::text = $3::text)
        AND ($2::text IS NULL OR c.name ILIKE '%' || $2 || '%' OR c.code ILIKE '%' || $2 || '%')
    `;

    const totalResult = await tx.query<{ count: string }>(
      `SELECT count(*)::bigint AS count FROM community.communities c ${ACCESS_JOIN} ${where}`,
      [input.userId, search, status],
    );
    const total = Number(totalResult.rows[0]?.count ?? 0);

    const itemsResult = await tx.query<CommunityRow>(
      `SELECT c.id, c.code, c.name, c.address, c.status, c.created_at, c.updated_at
         FROM community.communities c ${ACCESS_JOIN} ${where}
        ORDER BY c.name
        LIMIT $4 OFFSET $5`,
      [input.userId, search, status, input.pageSize, offset],
    );

    return { items: itemsResult.rows.map(mapRow), total };
  },

  /** Una comunidad del alcance del usuario. null = inexistente o fuera de
   *  alcance. Admite `inactive`: es el detalle que edita la consola para
   *  reactivarla. */
  async getById(tx: TxClient, userId: string, communityId: string): Promise<Community | null> {
    const result = await tx.query<CommunityRow>(
      `SELECT c.id, c.code, c.name, c.address, c.status, c.created_at, c.updated_at
         FROM community.communities c ${ACCESS_JOIN}
        WHERE c.id = $2 AND c.status != 'deleted'`,
      [userId, communityId],
    );
    const row = result.rows[0];
    return row === undefined ? null : mapRow(row);
  },

  /**
   * Crea la comunidad Y la membresía del actor en la misma transacción.
   *
   * La membresía no es un extra: la visibilidad del servicio ES
   * `community_members` (§2.5 del CLAUDE), así que sin ella el creador acabaría
   * de crear algo que no puede ver ni administrar. Puede lanzar 23505 (code
   * duplicado en el cliente) o 23503 (el usuario del token no existe en el
   * espejo `core.users` — cuenta sin sincronizar).
   */
  async create(
    tx: TxClient,
    customerId: string,
    userId: string,
    input: CreateCommunityInput,
  ): Promise<Community> {
    const result = await tx.query<CommunityRow>(
      `INSERT INTO community.communities (customer_id, code, name, address)
       VALUES ($1, $2, $3, $4)
       RETURNING id, code, name, address, status, created_at, updated_at`,
      [customerId, input.code, input.name, input.address ?? null],
    );
    const row = result.rows[0]!;

    await tx.query(
      `INSERT INTO community.community_members (customer_id, community_id, user_id)
       VALUES ($1, $2, $3)`,
      [customerId, row.id, userId],
    );

    return mapRow(row);
  },

  /** Actualización parcial dentro del alcance. null = inexistente/fuera. */
  async update(
    tx: TxClient,
    userId: string,
    communityId: string,
    input: UpdateCommunityInput,
  ): Promise<Community | null> {
    const sets: string[] = [];
    const params: unknown[] = [];
    let i = 1;

    const push = (column: string, value: unknown, cast = ""): void => {
      sets.push(`${column} = $${i}${cast}`);
      params.push(value);
      i += 1;
    };

    if (input.code !== undefined) push("code", input.code);
    if (input.name !== undefined) push("name", input.name);
    if (input.address !== undefined) push("address", input.address);
    if (input.status !== undefined) push("status", input.status, "::public.record_status");

    if (sets.length === 0) {
      return this.getById(tx, userId, communityId);
    }

    params.push(communityId, userId);
    // El UPDATE se acota por EXISTS de membresía (no por JOIN: un UPDATE ... FROM
    // no aplica aquí, y el subquery deja el alcance explícito en un solo sitio).
    const result = await tx.query<CommunityRow>(
      `UPDATE community.communities c SET ${sets.join(", ")}
        WHERE c.id = $${i} AND c.status != 'deleted'
          AND EXISTS (
                SELECT 1 FROM community.community_members cm
                 WHERE cm.customer_id  = c.customer_id
                   AND cm.community_id = c.id
                   AND cm.user_id      = $${i + 1}
                   AND cm.status       = 'active'
              )
        RETURNING c.id, c.code, c.name, c.address, c.status, c.created_at, c.updated_at`,
      params,
    );
    const row = result.rows[0];
    return row === undefined ? null : mapRow(row);
  },

  /**
   * Baja lógica de la comunidad. false = inexistente, ya de baja o fuera de
   * alcance. Lo que cuelga de ella (unidades, cuotas, cargos…) no se toca: deja
   * de ser alcanzable porque toda ruta anidada exige una comunidad activa.
   */
  async softDelete(tx: TxClient, userId: string, communityId: string): Promise<boolean> {
    const result = await tx.query(
      `UPDATE community.communities c SET status = 'deleted'
        WHERE c.id = $1 AND c.status != 'deleted'
          AND EXISTS (
                SELECT 1 FROM community.community_members cm
                 WHERE cm.customer_id  = c.customer_id
                   AND cm.community_id = c.id
                   AND cm.user_id      = $2
                   AND cm.status       = 'active'
              )`,
      [communityId, userId],
    );
    return (result.rowCount ?? 0) > 0;
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
