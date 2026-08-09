import type { TxClient } from "../../../core/db/with_transaction";
import {
  reportsRepository,
  type UnitChargeStatement,
} from "../../reports/v1/reports_v1.repository";
import {
  mapVisit,
  visitsRepository,
  VISIT_COLUMNS,
  VISIT_FROM,
  VISIT_STATE_EXPR,
  type CreateVisitInput,
  type Visit,
  type VisitRow,
} from "../../visits/v1/visits_v1.repository";

// Acceso a datos del recurso me (autoconsulta del residente). La frontera de
// alcance aquí NO es community_members: es el VÍNCULO del padrón — la cadena
// sub → members.user_id → unit_members → units. Un usuario sin filas
// vinculadas simplemente no tiene unidades; una unidad ajena es un 404
// indistinguible de inexistente, igual que en el resto del servicio.
//
// El RLS sigue acotando el tenant (claim del token), así que un mismo usuario
// con unidades en OTRO cliente no las ve desde esta sesión: la tripleta manda.

export interface MyUnit {
  readonly unitId: string;
  readonly unitCode: string;
  readonly unitTower: string | null;
  readonly unitType: string;
  readonly address: string | null;
  readonly memberType: string;
  readonly communityId: string;
  readonly communityName: string;
}

interface MyUnitRow {
  unit_id: string;
  unit_code: string;
  unit_tower: string | null;
  unit_type: string;
  address: string | null;
  member_type: string;
  community_id: string;
  community_name: string;
}

// Todo ACTIVO de punta a punta: el vínculo del padrón, la asignación, la
// unidad y la comunidad. El portal muestra lo vigente; el historial (unidades
// vendidas, asignaciones cerradas) es de las pantallas de operación.
const MY_UNITS_CHAIN = `
  FROM community.members m
  JOIN community.unit_members um
    ON um.member_id = m.id AND um.status = 'active'
  JOIN community.units u
    ON u.id = um.unit_id AND u.status = 'active'
  JOIN community.communities c
    ON c.id = m.community_id AND c.status = 'active'
 WHERE m.user_id = $1 AND m.status = 'active'
`;

export const meRepository = {
  /**
   * Las unidades vigentes del usuario, en todas sus comunidades (una persona
   * por comunidad en el padrón; el mismo user_id las enlaza). Sin paginación:
   * el conjunto está acotado por naturaleza (ver el verifier).
   */
  async listMyUnits(tx: TxClient, userId: string): Promise<MyUnit[]> {
    const result = await tx.query<MyUnitRow>(
      `SELECT u.id        AS unit_id,
              u.code      AS unit_code,
              u.tower     AS unit_tower,
              u.unit_type::text AS unit_type,
              u.address,
              um.member_type::text AS member_type,
              c.id        AS community_id,
              c.name      AS community_name
         ${MY_UNITS_CHAIN}
        ORDER BY c.name, u.code`,
      [userId],
    );
    return result.rows.map((row) => ({
      unitId: row.unit_id,
      unitCode: row.unit_code,
      unitTower: row.unit_tower,
      unitType: row.unit_type,
      address: row.address,
      memberType: row.member_type,
      communityId: row.community_id,
      communityName: row.community_name,
    }));
  },

  /**
   * Estado de cuenta (vista por cargo, misma consulta que la V2 de reports) de
   * una unidad MÍA. Primero la pertenencia: si la unidad no está vinculada al
   * usuario por la cadena del padrón → null (404, indistinguible de
   * inexistente). Después delega en reports con la comunidad ya resuelta — la
   * autorización cambió, la información es la misma.
   */
  async myUnitStatement(
    tx: TxClient,
    userId: string,
    input: {
      readonly unitId: string;
      readonly from: string;
      readonly to: string;
      readonly page: number;
      readonly pageSize: number;
    },
  ): Promise<UnitChargeStatement | null> {
    const owned = await tx.query<{ community_id: string }>(
      `SELECT c.id AS community_id
         ${MY_UNITS_CHAIN}
          AND u.id = $2
        LIMIT 1`,
      [userId, input.unitId],
    );
    const row = owned.rows[0];
    if (row === undefined) {
      return null;
    }
    return reportsRepository.unitChargeStatement(tx, {
      communityId: row.community_id,
      unitId: input.unitId,
      from: input.from,
      to: input.to,
      page: input.page,
      pageSize: input.pageSize,
    });
  },

  // --- Mis visitas -----------------------------------------------------------
  // El pase lo emite una PERSONA DEL PADRÓN para una de SUS unidades, así que
  // la misma cadena que resuelve "mis unidades" resuelve también quién puede
  // emitirlo y sobre qué. Nada de comunidad en la ruta: se deriva.

  /**
   * Resuelve la unidad como MÍA y devuelve con qué identidad del padrón la
   * tengo. Es el único punto donde el portal decide pertenencia — todo lo demás
   * cuelga de aquí. `null` = la unidad no es mía (o no existe) → 404.
   */
  async myUnitScope(
    tx: TxClient,
    userId: string,
    unitId: string,
  ): Promise<{ communityId: string; memberId: string } | null> {
    const result = await tx.query<{ community_id: string; member_id: string }>(
      `SELECT c.id AS community_id, m.id AS member_id
         ${MY_UNITS_CHAIN}
          AND u.id = $2
        LIMIT 1`,
      [userId, unitId],
    );
    const row = result.rows[0];
    return row === undefined
      ? null
      : { communityId: row.community_id, memberId: row.member_id };
  },

  /**
   * Mis pases, de todas mis unidades. Paginado (a diferencia de /me/units): un
   * residente activo acumula visitas con el tiempo, así que el conjunto NO está
   * acotado por naturaleza.
   *
   * El filtro `state` compara contra el estado DERIVADO, que ya viene calculado
   * en la proyección compartida: el portal no reimplementa "vencido".
   */
  async listMyVisits(
    tx: TxClient,
    userId: string,
    input: {
      readonly page: number;
      readonly pageSize: number;
      readonly unitId?: string | null;
      readonly state?: string | null;
    },
  ): Promise<{ items: Visit[]; total: number }> {
    const params = [userId, input.unitId ?? null, input.state ?? null];
    // El pase es mío si su unidad lo es Y lo emitió mi fila del padrón: un
    // copropietario no cancela los pases del otro.
    const where = `
      WHERE v.status <> 'deleted'
        AND v.member_id = m.id
        AND m.user_id   = $1
        AND m.status    = 'active'
        AND EXISTS (
              SELECT 1
                FROM community.unit_members um
               WHERE um.member_id = m.id
                 AND um.unit_id   = v.unit_id
                 AND um.status    = 'active'
            )
        AND ($2::uuid IS NULL OR v.unit_id = $2::uuid)
        AND ($3::text IS NULL OR (${VISIT_STATE_EXPR}) = $3::text)
    `;

    const totalResult = await tx.query<{ count: string }>(
      `SELECT count(*)::bigint AS count ${VISIT_FROM} ${where}`,
      params,
    );
    const total = Number(totalResult.rows[0]?.count ?? 0);

    const itemsResult = await tx.query<VisitRow>(
      `SELECT ${VISIT_COLUMNS} ${VISIT_FROM} ${where}
        ORDER BY v.valid_from DESC, v.created_at DESC
        LIMIT $4 OFFSET $5`,
      [...params, input.pageSize, (input.page - 1) * input.pageSize],
    );

    return { items: itemsResult.rows.map(mapVisit), total };
  },

  /** Un pase MÍO por id. `null` = ajeno o inexistente → 404. */
  async myVisit(tx: TxClient, userId: string, visitId: string): Promise<Visit | null> {
    const result = await tx.query<VisitRow>(
      `SELECT ${VISIT_COLUMNS} ${VISIT_FROM}
        WHERE v.id = $2
          AND v.status <> 'deleted'
          AND v.member_id = m.id
          AND m.user_id = $1
          AND m.status = 'active'`,
      [userId, visitId],
    );
    const row = result.rows[0];
    return row === undefined ? null : mapVisit(row);
  },

  /**
   * Registra un pase para una unidad mía. La comunidad y la identidad del
   * padrón NO llegan del cliente: las deriva `myUnitScope` del usuario del
   * token. `null` = la unidad no es mía.
   */
  async createMyVisit(
    tx: TxClient,
    userId: string,
    customerId: string,
    input: Omit<CreateVisitInput, "memberId">,
  ): Promise<Visit | null> {
    const scope = await this.myUnitScope(tx, userId, input.unitId);
    if (scope === null) {
      return null;
    }
    return visitsRepository.create(tx, customerId, scope.communityId, {
      ...input,
      memberId: scope.memberId,
    });
  },

  /** Cancela un pase MÍO. `null` = ajeno o inexistente → 404. */
  async cancelMyVisit(tx: TxClient, userId: string, visitId: string): Promise<Visit | null> {
    const owned = await this.myVisit(tx, userId, visitId);
    if (owned === null) {
      return null;
    }
    return visitsRepository.cancel(tx, owned.communityId, visitId);
  },

  /** Pases vigentes de una unidad mía — el tope anti-abuso del alta. */
  async countActiveVisitsForUnit(tx: TxClient, unitId: string): Promise<number> {
    return visitsRepository.countActiveForUnit(tx, unitId);
  },
};
