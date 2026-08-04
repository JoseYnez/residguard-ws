import type { FastifyInstance } from "fastify";
import type { StructureVerifierTypeProvider } from "structure-verifier/fastify";
import { requireCommunityAccess } from "../../../core/auth/community_access";
import { PERMISSIONS } from "../../../core/auth/permissions";
import { requirePermission } from "../../../core/auth/require_permission";
import { communityIdParamV1V } from "../../common/common_v1.verifier";
import { reportsController } from "./reports_v1.controller";
import {
  errorResponseV1V,
  reportSummaryQueryV1V,
  reportSummaryV1V,
  reportUnitsQueryV1V,
  unitDebtListV1V,
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
