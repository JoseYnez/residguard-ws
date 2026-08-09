import type { FastifyInstance } from "fastify";
import type { StructureVerifierTypeProvider } from "structure-verifier/fastify";
import { config } from "../../../config";
import { PERMISSIONS } from "../../../core/auth/permissions";
import { requirePermission } from "../../../core/auth/require_permission";
import { unitIdParamV1V } from "../../common/common_v1.verifier";
import { meController } from "./me_v1.controller";
import {
  errorResponseV1V,
  myUnitListV1V,
  unitChargeStatementV1V,
  unitStatementQueryV1V,
} from "./me_v1.verifier";

// Recurso me/v1: la AUTOCONSULTA del residente — sus unidades y su estado de
// cuenta. Es la primera superficie del servicio cuya frontera de alcance NO es
// community_members: un residente no ve la comunidad, ve LO SUYO, y "lo suyo"
// lo define el vínculo del padrón (members.user_id = sub) que dejó el flujo de
// invitación. Por eso estas rutas no llevan requireCommunityAccess(): la
// pertenencia la resuelve el repositorio con la cadena
// sub → members → unit_members → units (fuera de la cadena → 404).
//
// El permiso sigue siendo la primera frontera (403): `self_units.read` /
// `self_statement.read`, concedidos por el rol `community_resident` (y por
// community_admin — la anti-escalada de la superficie tenant exige que quien
// concede el rol tenga sus permisos, y de paso el operador puede probar el
// portal con sus propias unidades si las tiene).

export async function meV1Routes(instance: FastifyInstance): Promise<void> {
  const app = instance.withTypeProvider<StructureVerifierTypeProvider>();

  // Mis unidades vigentes, en todas mis comunidades.
  app.get(
    "/me/units",
    {
      schema: {
        response: { 200: myUnitListV1V },
      },
      preHandler: [requirePermission(PERMISSIONS.selfUnitsRead)],
    },
    async (req, reply) => {
      const items = await meController.listMyUnits(req);
      return reply.code(200).send({ items });
    },
  );

  // Estado de cuenta (vista por cargo, contrato idéntico a la V2 de reports)
  // de una unidad MÍA.
  app.get(
    "/me/units/:unitId/statement",
    {
      schema: {
        params: unitIdParamV1V,
        querystring: unitStatementQueryV1V,
        response: { 200: unitChargeStatementV1V, 400: errorResponseV1V, 404: errorResponseV1V },
      },
      preHandler: [requirePermission(PERMISSIONS.selfStatementRead)],
    },
    async (req, reply) => {
      const q = req.query;
      // Mismo rechazo que reports: un estado de cuenta vacío se lee como "no
      // devengué nada", que no es lo que pasó con un rango invertido.
      if (q.from > q.to) {
        return reply.code(400).send({
          error: "invalid",
          message: "La fecha inicial no puede ser posterior a la final.",
        });
      }
      const statement = await meController.myUnitStatement(req, {
        unitId: req.params.unitId,
        from: q.from,
        to: q.to,
        page: q.page,
        pageSize: q.pageSize,
      });
      if (statement === null) {
        return reply.code(404).send({ error: "not_found", message: null });
      }
      const { unit, items, total, totals } = statement;
      // `timezone`: la zona con la que se recortaron los días (DB_TIMEZONE),
      // igual que en reports — el cliente debe poder decir en qué días está
      // expresado el estado de cuenta.
      return reply.code(200).send({
        unit,
        items,
        total,
        page: q.page,
        pageSize: q.pageSize,
        timezone: config.dbTimezone,
        totals,
      });
    },
  );
}
