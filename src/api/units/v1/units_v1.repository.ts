import type { TxClient } from "../../../core/db/with_transaction";

// Acceso a datos del recurso units (community.units). Todas las consultas
// llegan ya acotadas a una comunidad del alcance del actor (preHandler
// requireCommunityAccess) y el RLS filtra el tenant. Sin DELETE físico:
// la baja es UPDATE status='deleted'.

export interface Unit {
  readonly id: string;
  readonly communityId: string;
  readonly code: string;
  readonly tower: string | null;
  readonly number: string | null;
  readonly letter: string | null;
  readonly unitType: string;
  readonly address: string | null;
  readonly status: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateUnitInput {
  readonly code: string;
  readonly tower?: string | null;
  readonly number?: string | null;
  readonly letter?: string | null;
  readonly unitType: string;
  readonly address?: string | null;
}

export interface UpdateUnitInput {
  readonly code?: string;
  readonly tower?: string | null;
  readonly number?: string | null;
  readonly letter?: string | null;
  readonly unitType?: string;
  readonly address?: string | null;
  readonly status?: string;
}

export interface ListUnitsInput {
  readonly communityId: string;
  readonly page: number;
  readonly pageSize: number;
  readonly search?: string | null;
  readonly unitType?: string | null;
  readonly status?: string | null;
}

const SELECT_COLUMNS = `
  id, community_id, code, tower, number, letter, unit_type, address,
  status, created_at, updated_at
`;

interface UnitRow {
  id: string;
  community_id: string;
  code: string;
  tower: string | null;
  number: string | null;
  letter: string | null;
  unit_type: string;
  address: string | null;
  status: string;
  created_at: Date;
  updated_at: Date;
}

function mapRow(row: UnitRow): Unit {
  return {
    id: row.id,
    communityId: row.community_id,
    code: row.code,
    tower: row.tower,
    number: row.number,
    letter: row.letter,
    unitType: row.unit_type,
    address: row.address,
    status: row.status,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export const unitsRepository = {
  /** Unidades de la comunidad (paginado). Sin filtro de status oculta 'deleted'. */
  async list(tx: TxClient, input: ListUnitsInput): Promise<{ items: Unit[]; total: number }> {
    const search = input.search ?? null;
    const unitType = input.unitType ?? null;
    const status = input.status ?? null;
    const offset = (input.page - 1) * input.pageSize;

    const where = `
      WHERE community_id = $1
        AND ($2::text IS NULL OR code ILIKE '%' || $2 || '%' OR tower ILIKE '%' || $2 || '%')
        AND ($3::community.unit_type IS NULL OR unit_type = $3::community.unit_type)
        AND ( ($4::public.record_status IS NULL AND status != 'deleted')
           OR status = $4::public.record_status )
    `;

    const totalResult = await tx.query<{ count: string }>(
      `SELECT count(*)::bigint AS count FROM community.units ${where}`,
      [input.communityId, search, unitType, status],
    );
    const total = Number(totalResult.rows[0]?.count ?? 0);

    const itemsResult = await tx.query<UnitRow>(
      `SELECT ${SELECT_COLUMNS} FROM community.units ${where}
        ORDER BY code
        LIMIT $5 OFFSET $6`,
      [input.communityId, search, unitType, status, input.pageSize, offset],
    );

    return { items: itemsResult.rows.map(mapRow), total };
  },

  /** Una unidad de la comunidad. null si no existe o está dada de baja. */
  async getById(tx: TxClient, communityId: string, id: string): Promise<Unit | null> {
    const result = await tx.query<UnitRow>(
      `SELECT ${SELECT_COLUMNS} FROM community.units
        WHERE id = $1 AND community_id = $2 AND status != 'deleted'`,
      [id, communityId],
    );
    const row = result.rows[0];
    return row === undefined ? null : mapRow(row);
  },

  /** Inserta una unidad. Puede lanzar 23505 (code duplicado en la comunidad). */
  async create(
    tx: TxClient,
    customerId: string,
    communityId: string,
    input: CreateUnitInput,
  ): Promise<Unit> {
    const result = await tx.query<UnitRow>(
      `INSERT INTO community.units
         (customer_id, community_id, code, tower, number, letter, unit_type, address)
       VALUES ($1, $2, $3, $4, $5, $6, $7::community.unit_type, $8)
       RETURNING ${SELECT_COLUMNS}`,
      [
        customerId,
        communityId,
        input.code,
        input.tower ?? null,
        input.number ?? null,
        input.letter ?? null,
        input.unitType,
        input.address ?? null,
      ],
    );
    return mapRow(result.rows[0]!);
  },

  /** Actualización parcial. Devuelve null si no existe (o está 'deleted'). */
  async update(
    tx: TxClient,
    communityId: string,
    id: string,
    input: UpdateUnitInput,
  ): Promise<Unit | null> {
    const sets: string[] = [];
    const params: unknown[] = [];
    let i = 1;

    const push = (column: string, value: unknown, cast = ""): void => {
      sets.push(`${column} = $${i}${cast}`);
      params.push(value);
      i += 1;
    };

    if (input.code !== undefined) push("code", input.code);
    if (input.tower !== undefined) push("tower", input.tower);
    if (input.number !== undefined) push("number", input.number);
    if (input.letter !== undefined) push("letter", input.letter);
    if (input.unitType !== undefined) push("unit_type", input.unitType, "::community.unit_type");
    if (input.address !== undefined) push("address", input.address);
    if (input.status !== undefined) push("status", input.status, "::public.record_status");

    if (sets.length === 0) {
      return this.getById(tx, communityId, id);
    }

    params.push(id, communityId);
    const result = await tx.query<UnitRow>(
      `UPDATE community.units SET ${sets.join(", ")}
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
      `UPDATE community.units SET status = 'deleted'
        WHERE id = $1 AND community_id = $2 AND status != 'deleted'`,
      [id, communityId],
    );
    return (result.rowCount ?? 0) > 0;
  },
};
