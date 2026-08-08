import type { FastifyInstance } from "fastify";
import type { StructureVerifierTypeProvider } from "structure-verifier/fastify";
import { requireCommunityAccess } from "../../../core/auth/community_access";
import { PERMISSIONS } from "../../../core/auth/permissions";
import { requirePermission } from "../../../core/auth/require_permission";
import { communityIdParamV1V } from "../../common/common_v1.verifier";
import { reportsController } from "./reports_v1.controller";
import {
  communityUnitParamV1V,
  errorResponseV1V,
  movementListV1V,
  reportMovementsQueryV1V,
  reportSummaryQueryV1V,
  reportSummaryV1V,
  reportUnitsQueryV1V,
  unitChargeStatementV1V,
  unitDebtListV1V,
  unitStatementQueryV1V,
  unitStatementV1V,
} from "./reports_v1.verifier";

// Recurso reports/v1: los agregados financieros de UNA comunidad. Solo GET —
// un reporte deriva, nunca escribe, y por eso su recurso tiene un único código
// de permiso (`reports.read`).
//
// Ese código es propio y no la suma de los `.read` de cargos, pagos, gastos y
// caja: conceder el AGREGADO es una decisión distinta de conceder cada detalle.
// Consecuencia deliberada: quien tiene `reports.read` ve los totales de gasto de
// la comunidad aunque no pueda entrar a la pantalla de gastos.
//
// Ambas rutas conservan `requireCommunityAccess()` (exige la comunidad ACTIVA):
// el reporte de una comunidad desactivada no tiene sentido operativo, igual que
// su saldo (GET /communities/:communityId/balance).

export async function reportsV1Routes(instance: FastifyInstance): Promise<void> {
  const app = instance.withTypeProvider<StructureVerifierTypeProvider>();

  // Resumen financiero del rango: caja, cobranza, antigüedad y desgloses.
  app.get(
    "/communities/:communityId/reports/summary",
    {
      schema: {
        params: communityIdParamV1V,
        querystring: reportSummaryQueryV1V,
        response: { 200: reportSummaryV1V, 400: errorResponseV1V, 404: errorResponseV1V },
      },
      preHandler: [requirePermission(PERMISSIONS.reportsRead), requireCommunityAccess()],
    },
    async (req, reply) => {
      const q = req.query;
      // Rango invertido: se rechaza en la puerta en vez de devolver ceros. Un
      // reporte vacío se lee como "no hubo movimientos", que es otra cosa.
      if (q.from > q.to) {
        return reply.code(400).send({
          error: "invalid",
          message: "La fecha inicial no puede ser posterior a la final.",
        });
      }
      const summary = await reportsController.summary(req, {
        communityId: req.params.communityId,
        from: q.from,
        to: q.to,
        cashAccountId: q.cashAccountId ?? null,
      });
      if (summary === null) {
        return reply.code(404).send({ error: "not_found", message: null });
      }
      return reply.code(200).send(summary);
    },
  );

  // Movimientos del rango: el detalle, renglón por renglón, de las cifras de
  // caja del resumen. Mismo permiso y mismo alcance — es el mismo dinero.
  app.get(
    "/communities/:communityId/reports/movements",
    {
      schema: {
        params: communityIdParamV1V,
        querystring: reportMovementsQueryV1V,
        response: { 200: movementListV1V, 400: errorResponseV1V, 404: errorResponseV1V },
      },
      preHandler: [requirePermission(PERMISSIONS.reportsRead), requireCommunityAccess()],
    },
    async (req, reply) => {
      const q = req.query;
      // Mismo rechazo que el resumen: una lista vacía se lee como "no hubo
      // movimientos", que no es lo que pasó con un rango invertido.
      if (q.from > q.to) {
        return reply.code(400).send({
          error: "invalid",
          message: "La fecha inicial no puede ser posterior a la final.",
        });
      }
      const { items, total, totals, timezone } = await reportsController.movements(req, {
        communityId: req.params.communityId,
        from: q.from,
        to: q.to,
        cashAccountId: q.cashAccountId ?? null,
        page: q.page,
        pageSize: q.pageSize,
      });
      return reply
        .code(200)
        .send({ items, total, page: q.page, pageSize: q.pageSize, totals, timezone });
    },
  );

  // Estado de cuenta de UNA unidad: cargos, pagos y condonaciones intercalados
  // con saldo corrido, para un rango de días. La unidad viaja en la ruta bajo
  // su comunidad — el alcance lo da requireCommunityAccess y la pertenencia
  // unidad→comunidad la resuelve el repositorio (fuera de alcance → 404).
  app.get(
    "/communities/:communityId/reports/units/:unitId/statement",
    {
      schema: {
        params: communityUnitParamV1V,
        querystring: unitStatementQueryV1V,
        response: { 200: unitStatementV1V, 400: errorResponseV1V, 404: errorResponseV1V },
      },
      preHandler: [requirePermission(PERMISSIONS.reportsRead), requireCommunityAccess()],
    },
    async (req, reply) => {
      const q = req.query;
      // Mismo rechazo que el resumen y los movimientos: un estado de cuenta
      // vacío se lee como "la unidad no se movió", que no es lo que pasó con
      // un rango invertido.
      if (q.from > q.to) {
        return reply.code(400).send({
          error: "invalid",
          message: "La fecha inicial no puede ser posterior a la final.",
        });
      }
      const statement = await reportsController.unitStatement(req, {
        communityId: req.params.communityId,
        unitId: req.params.unitId,
        from: q.from,
        to: q.to,
        page: q.page,
        pageSize: q.pageSize,
      });
      if (statement === null) {
        return reply.code(404).send({ error: "not_found", message: null });
      }
      const { unit, items, total, totals, timezone } = statement;
      return reply
        .code(200)
        .send({ unit, items, total, page: q.page, pageSize: q.pageSize, timezone, totals });
    },
  );

  // Estado de cuenta V2 de UNA unidad: una fila por CARGO devengado en el rango,
  // con si ya está pagado, cuándo se pagó y de qué periodo es. Mismo permiso,
  // mismo alcance y mismo rango que la V1 — es la MISMA información leída desde
  // el cargo en vez de desde el movimiento, y por eso convive con ella en vez de
  // sustituirla: la V1 explica cómo se movió el saldo, la V2 en qué quedó cada
  // cargo.
  app.get(
    "/communities/:communityId/reports/units/:unitId/statement/charges",
    {
      schema: {
        params: communityUnitParamV1V,
        querystring: unitStatementQueryV1V,
        response: { 200: unitChargeStatementV1V, 400: errorResponseV1V, 404: errorResponseV1V },
      },
      preHandler: [requirePermission(PERMISSIONS.reportsRead), requireCommunityAccess()],
    },
    async (req, reply) => {
      const q = req.query;
      // Mismo rechazo que la V1: una lista vacía se lee como "la unidad no
      // devengó nada", que no es lo que pasó con un rango invertido.
      if (q.from > q.to) {
        return reply.code(400).send({
          error: "invalid",
          message: "La fecha inicial no puede ser posterior a la final.",
        });
      }
      const statement = await reportsController.unitChargeStatement(req, {
        communityId: req.params.communityId,
        unitId: req.params.unitId,
        from: q.from,
        to: q.to,
        page: q.page,
        pageSize: q.pageSize,
      });
      if (statement === null) {
        return reply.code(404).send({ error: "not_found", message: null });
      }
      const { unit, items, total, totals, timezone } = statement;
      return reply
        .code(200)
        .send({ unit, items, total, page: q.page, pageSize: q.pageSize, timezone, totals });
    },
  );

  // Adeudo por unidad (estado actual de la cartera), paginado.
  app.get(
    "/communities/:communityId/reports/units",
    {
      schema: {
        params: communityIdParamV1V,
        querystring: reportUnitsQueryV1V,
        response: { 200: unitDebtListV1V, 404: errorResponseV1V },
      },
      preHandler: [requirePermission(PERMISSIONS.reportsRead), requireCommunityAccess()],
    },
    async (req, reply) => {
      const q = req.query;
      const { items, total, totals } = await reportsController.unitDebt(req, {
        communityId: req.params.communityId,
        page: q.page,
        pageSize: q.pageSize,
        onlyDebtors: q.onlyDebtors ?? false,
      });
      return reply
        .code(200)
        .send({ items, total, page: q.page, pageSize: q.pageSize, totals });
    },
  );
}
