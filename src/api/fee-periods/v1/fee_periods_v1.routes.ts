import type { FastifyInstance } from "fastify";
import type { StructureVerifierTypeProvider } from "structure-verifier/fastify";
import { requireCommunityAccess } from "../../../core/auth/community_access";
import { PERMISSIONS } from "../../../core/auth/permissions";
import { requirePermission } from "../../../core/auth/require_permission";
import { feePeriodsController } from "./fee_periods_v1.controller";
import {
  createFeePeriodV1V,
  errorResponseV1V,
  feePeriodListV1V,
  feePeriodV1V,
  feeScopedIdParamV1V,
  feeScopedParamV1V,
  listFeePeriodsQueryV1V,
} from "./fee_periods_v1.verifier";

// Recurso fee-periods/v1: los periodos de una cuota, anidados bajo ella
// (/communities/:communityId/fees/:feeId/periods). La generación de cargos los
// crea sola; aquí se listan (la web deriva de esta lista la SUGERENCIA del
// siguiente periodo), se crean por adelantado y se dan de baja mientras no
// tengan cargos vivos.

export async function feePeriodsV1Routes(instance: FastifyInstance): Promise<void> {
  const app = instance.withTypeProvider<StructureVerifierTypeProvider>();

  // Listar (paginado, cronologico descendente)
  app.get(
    "/communities/:communityId/fees/:feeId/periods",
    {
      schema: {
        params: feeScopedParamV1V,
        querystring: listFeePeriodsQueryV1V,
        response: { 200: feePeriodListV1V, 404: errorResponseV1V },
      },
      preHandler: [requirePermission(PERMISSIONS.feePeriodsRead), requireCommunityAccess()],
    },
    async (req, reply) => {
      const q = req.query;
      const result = await feePeriodsController.list(req, {
        communityId: req.params.communityId,
        feeId: req.params.feeId,
        page: q.page,
        pageSize: q.pageSize,
      });
      if (result === null) {
        return reply.code(404).send({ error: "not_found", message: null });
      }
      return reply
        .code(200)
        .send({ items: result.items, total: result.total, page: q.page, pageSize: q.pageSize });
    },
  );

  // Crear (create-or-reuse: repetir un rango existente devuelve ese periodo)
  app.post(
    "/communities/:communityId/fees/:feeId/periods",
    {
      schema: {
        params: feeScopedParamV1V,
        body: createFeePeriodV1V,
        response: {
          201: feePeriodV1V,
          400: errorResponseV1V,
          404: errorResponseV1V,
          409: errorResponseV1V,
        },
      },
      preHandler: [requirePermission(PERMISSIONS.feePeriodsCreate), requireCommunityAccess()],
    },
    async (req, reply) => {
      const b = req.body;
      const result = await feePeriodsController.create(
        req,
        req.params.communityId,
        req.params.feeId,
        {
          periodStart: b.periodStart,
          periodEnd: b.periodEnd,
          dueDate: b.dueDate ?? null,
          amount: b.amount ?? null,
          label: b.label ?? null,
        },
      );
      if (result === null) {
        return reply.code(404).send({ error: "not_found", message: null });
      }
      if (!result.ok) {
        const status = result.error.kind === "conflict" ? 409 : 400;
        return reply.code(status).send({ error: result.error.kind, message: result.error.message });
      }
      return reply.code(201).send(result.value);
    },
  );

  // Baja lógica → se autoriza con `.update` (convención general). Un periodo
  // con cargos vivos no se puede dar de baja: 409 con el motivo.
  app.delete(
    "/communities/:communityId/fees/:feeId/periods/:id",
    {
      schema: { params: feeScopedIdParamV1V },
      preHandler: [requirePermission(PERMISSIONS.feePeriodsUpdate), requireCommunityAccess()],
    },
    async (req, reply) => {
      const outcome = await feePeriodsController.softDelete(
        req,
        req.params.communityId,
        req.params.feeId,
        req.params.id,
      );
      if (outcome === "not-found") {
        return reply.code(404).send({ error: "not_found", message: null });
      }
      if (outcome === "has-charges") {
        return reply.code(409).send({
          error: "conflict",
          message: "El periodo tiene cargos vivos; anúlalos antes de darlo de baja.",
        });
      }
      return reply.code(204).send();
    },
  );
}
