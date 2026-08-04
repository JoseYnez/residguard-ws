import type { FastifyInstance } from "fastify";
import type { StructureVerifierTypeProvider } from "structure-verifier/fastify";
import { requireCommunityAccess } from "../../../core/auth/community_access";
import { PERMISSIONS } from "../../../core/auth/permissions";
import { requirePermission } from "../../../core/auth/require_permission";
import {
  communityIdParamV1V,
  communityScopedIdParamV1V,
} from "../../common/common_v1.verifier";
import { fundAdjustmentsController } from "./fund_adjustments_v1.controller";
import type { UpdateFundAdjustmentInput } from "./fund_adjustments_v1.repository";
import {
  createFundAdjustmentV1V,
  errorResponseV1V,
  fundAdjustmentListV1V,
  fundAdjustmentV1V,
  listFundAdjustmentsQueryV1V,
  updateFundAdjustmentV1V,
} from "./fund_adjustments_v1.verifier";

// Recurso fund-adjustments/v1: movimientos manuales de la caja de una
// comunidad (saldo inicial, conciliaciones, ingresos/salidas no ligados a
// cuotas). CRUD anidado bajo /communities/:communityId. Baja lógica.

/** Cuerpo del PATCH → UpdateFundAdjustmentInput (null en NOT NULL = "no
 *  tocar"; null en anulables = "limpiar"). */
function toUpdateInput(body: {
  amount?: number | null;
  reason?: string | null;
  adjustedAt?: string | null;
  method?: string | null;
  authorizedBy?: string | null;
  cashAccountId?: string | null;
}): UpdateFundAdjustmentInput {
  return {
    ...(body.amount !== null && body.amount !== undefined && { amount: body.amount }),
    ...(body.reason !== null && body.reason !== undefined && { reason: body.reason }),
    ...(body.adjustedAt !== null &&
      body.adjustedAt !== undefined && { adjustedAt: body.adjustedAt }),
    ...(body.method !== null && body.method !== undefined && { method: body.method }),
    // Anulables: se incluyen aunque sean null (null = limpiar).
    ...(body.authorizedBy !== undefined && { authorizedBy: body.authorizedBy }),
    ...(body.cashAccountId !== undefined && { cashAccountId: body.cashAccountId }),
  };
}

export async function fundAdjustmentsV1Routes(instance: FastifyInstance): Promise<void> {
  const app = instance.withTypeProvider<StructureVerifierTypeProvider>();

  // Listar (paginado)
  app.get(
    "/communities/:communityId/fund-adjustments",
    {
      schema: {
        params: communityIdParamV1V,
        querystring: listFundAdjustmentsQueryV1V,
        response: { 200: fundAdjustmentListV1V, 404: errorResponseV1V },
      },
      preHandler: [requirePermission(PERMISSIONS.fundAdjustmentsRead), requireCommunityAccess()],
    },
    async (req, reply) => {
      const q = req.query;
      const { items, total } = await fundAdjustmentsController.list(req, {
        communityId: req.params.communityId,
        page: q.page,
        pageSize: q.pageSize,
        from: q.from ?? null,
        to: q.to ?? null,
        method: q.method ?? null,
        cashAccountId: q.cashAccountId ?? null,
        search: q.search ?? null,
      });
      return reply.code(200).send({ items, total, page: q.page, pageSize: q.pageSize });
    },
  );

  // Obtener uno
  app.get(
    "/communities/:communityId/fund-adjustments/:id",
    {
      schema: {
        params: communityScopedIdParamV1V,
        response: { 200: fundAdjustmentV1V, 404: errorResponseV1V },
      },
      preHandler: [requirePermission(PERMISSIONS.fundAdjustmentsRead), requireCommunityAccess()],
    },
    async (req, reply) => {
      const found = await fundAdjustmentsController.getById(
        req,
        req.params.communityId,
        req.params.id,
      );
      if (found === null) {
        return reply.code(404).send({ error: "not_found", message: null });
      }
      return reply.code(200).send(found);
    },
  );

  // Crear
  app.post(
    "/communities/:communityId/fund-adjustments",
    {
      schema: {
        params: communityIdParamV1V,
        body: createFundAdjustmentV1V,
        response: {
          201: fundAdjustmentV1V,
          400: errorResponseV1V,
          404: errorResponseV1V,
        },
      },
      preHandler: [requirePermission(PERMISSIONS.fundAdjustmentsCreate), requireCommunityAccess()],
    },
    async (req, reply) => {
      const b = req.body;
      const result = await fundAdjustmentsController.create(req, req.params.communityId, {
        amount: b.amount,
        reason: b.reason,
        adjustedAt: b.adjustedAt ?? null,
        method: b.method,
        authorizedBy: b.authorizedBy ?? null,
        cashAccountId: b.cashAccountId ?? null,
      });
      if (!result.ok) {
        return reply.code(400).send({ error: result.error.kind, message: result.error.message });
      }
      return reply.code(201).send(result.value);
    },
  );

  // Actualizar (parcial)
  app.patch(
    "/communities/:communityId/fund-adjustments/:id",
    {
      schema: {
        params: communityScopedIdParamV1V,
        body: updateFundAdjustmentV1V,
        response: {
          200: fundAdjustmentV1V,
          400: errorResponseV1V,
          404: errorResponseV1V,
        },
      },
      preHandler: [requirePermission(PERMISSIONS.fundAdjustmentsUpdate), requireCommunityAccess()],
    },
    async (req, reply) => {
      const result = await fundAdjustmentsController.update(
        req,
        req.params.communityId,
        req.params.id,
        toUpdateInput(req.body),
      );
      if (result === null) {
        return reply.code(404).send({ error: "not_found", message: null });
      }
      if (!result.ok) {
        return reply.code(400).send({ error: result.error.kind, message: result.error.message });
      }
      return reply.code(200).send(result.value);
    },
  );

  // Baja lógica
  app.delete(
    "/communities/:communityId/fund-adjustments/:id",
    {
      // Baja lógica → se autoriza con `.update`.
      schema: { params: communityScopedIdParamV1V },
      preHandler: [requirePermission(PERMISSIONS.fundAdjustmentsUpdate), requireCommunityAccess()],
    },
    async (req, reply) => {
      const deleted = await fundAdjustmentsController.softDelete(
        req,
        req.params.communityId,
        req.params.id,
      );
      if (!deleted) {
        return reply.code(404).send({ error: "not_found", message: null });
      }
      return reply.code(204).send();
    },
  );
}
