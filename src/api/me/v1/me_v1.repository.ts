import type { TxClient } from "../../../core/db/with_transaction";
import {
  reportsRepository,
  type UnitChargeStatement,
} from "../../reports/v1/reports_v1.repository";

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
};
