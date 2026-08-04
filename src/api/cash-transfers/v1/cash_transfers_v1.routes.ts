import type { FastifyInstance } from "fastify";
import type { StructureVerifierTypeProvider } from "structure-verifier/fastify";
import { requireCommunityAccess } from "../../../core/auth/community_access";
import { PERMISSIONS } from "../../../core/auth/permissions";
import { requirePermission } from "../../../core/auth/require_permission";
import {
  communityIdParamV1V,
  communityScopedIdParamV1V,
} from "../../common/common_v1.verifier";
import { cashTransfersController } from "./cash_transfers_v1.controller";
import type { UpdateCashTransferInput } from "./cash_transfers_v1.repository";
import {
  cashTransferListV1V,
  cashTransferV1V,
  createCashTransferV1V,
  errorResponseV1V,
  listCashTransfersQueryV1V,
  updateCashTransferV1V,
} from "./cash_transfers_v1.verifier";

// Recurso cash-transfers/v1: traspasos entre dos cajas de la MISMA comunidad
// (suma cero para la comunidad). CRUD anidado bajo /communities/:communityId.
// Baja lógica.

/** Cuerpo del PATCH → UpdateCashTransferInput (null en NOT NULL = "no
 *  tocar"; null en anulables = "limpiar"). */
function toUpdateInput(body: {
  fromCashAccountId?: string | null;
  toCashAccountId?: string | null;
  amount?: number | null;
  transferredAt?: string | null;
  reason?: string | null;
  authorizedBy?: string | null;
}): UpdateCashTransferInput {
  return {
    ...(body.fromCashAccountId !== null &&
      body.fromCashAccountId !== undefined && { fromCashAccountId: body.fromCashAccountId }),
    ...(body.toCashAccountId !== null &&
      body.toCashAccountId !== undefined && { toCashAccountId: body.toCashAccountId }),
    ...(body.amount !== null && body.amount !== undefined && { amount: body.amount }),
    ...(body.transferredAt !== null &&
      body.transferredAt !== undefined && { transferredAt: body.transferredAt }),
    ...(body.reason !== null && body.reason !== undefined && { reason: body.reason }),
    // Anulable: se incluye aunque sea null (null = limpiar).
    ...(body.authorizedBy !== undefined && { authorizedBy: body.authorizedBy }),
  };
}

export async function cashTransfersV1Routes(instance: FastifyInstance): Promise<void> {
  const app = instance.withTypeProvider<StructureVerifierTypeProvider>();

  // Listar (paginado)
  app.get(
    "/communities/:communityId/cash-transfers",
    {
      schema: {
        params: communityIdParamV1V,
        querystring: listCashTransfersQueryV1V,
        response: { 200: cashTransferListV1V, 404: errorResponseV1V },
      },
      preHandler: [requirePermission(PERMISSIONS.cashTransfersRead), requireCommunityAccess()],
    },
    async (req, reply) => {
      const q = req.query;
      const { items, total } = await cashTransfersController.list(req, {
        communityId: req.params.communityId,
        page: q.page,
        pageSize: q.pageSize,
        from: q.from ?? null,
        to: q.to ?? null,
        cashAccountId: q.cashAccountId ?? null,
      });
      return reply.code(200).send({ items, total, page: q.page, pageSize: q.pageSize });
    },
  );

  // Obtener uno
  app.get(
    "/communities/:communityId/cash-transfers/:id",
    {
      schema: {
        params: communityScopedIdParamV1V,
        response: { 200: cashTransferV1V, 404: errorResponseV1V },
      },
      preHandler: [requirePermission(PERMISSIONS.cashTransfersRead), requireCommunityAccess()],
    },
    async (req, reply) => {
      const found = await cashTransfersController.getById(
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
    "/communities/:communityId/cash-transfers",
    {
      schema: {
        params: communityIdParamV1V,
        body: createCashTransferV1V,
        response: {
          201: cashTransferV1V,
          400: errorResponseV1V,
          404: errorResponseV1V,
        },
      },
      preHandler: [requirePermission(PERMISSIONS.cashTransfersCreate), requireCommunityAccess()],
    },
    async (req, reply) => {
      const b = req.body;
      const result = await cashTransfersController.create(req, req.params.communityId, {
        fromCashAccountId: b.fromCashAccountId,
        toCashAccountId: b.toCashAccountId,
        amount: b.amount,
        transferredAt: b.transferredAt ?? null,
        reason: b.reason,
        authorizedBy: b.authorizedBy ?? null,
      });
      if (!result.ok) {
        return reply.code(400).send({ error: result.error.kind, message: result.error.message });
      }
      return reply.code(201).send(result.value);
    },
  );

  // Actualizar (parcial)
  app.patch(
    "/communities/:communityId/cash-transfers/:id",
    {
      schema: {
        params: communityScopedIdParamV1V,
        body: updateCashTransferV1V,
        response: {
          200: cashTransferV1V,
          400: errorResponseV1V,
          404: errorResponseV1V,
        },
      },
      preHandler: [requirePermission(PERMISSIONS.cashTransfersUpdate), requireCommunityAccess()],
    },
    async (req, reply) => {
      const result = await cashTransfersController.update(
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
    "/communities/:communityId/cash-transfers/:id",
    {
      // Baja lógica → se autoriza con `.update`.
      schema: { params: communityScopedIdParamV1V },
      preHandler: [requirePermission(PERMISSIONS.cashTransfersUpdate), requireCommunityAccess()],
    },
    async (req, reply) => {
      const deleted = await cashTransfersController.softDelete(
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
