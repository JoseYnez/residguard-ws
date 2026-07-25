import type { FastifyInstance } from "fastify";
import type { StructureVerifierTypeProvider } from "structure-verifier/fastify";
import { requireCommunityAccess } from "../../../core/auth/community_access";
import { PERMISSIONS } from "../../../core/auth/permissions";
import { requirePermission } from "../../../core/auth/require_permission";
import {
  communityIdParamV1V,
  communityScopedIdParamV1V,
} from "../../common/common_v1.verifier";
import { feesController } from "./fees_v1.controller";
import type { UpdateFeeInput } from "./fees_v1.repository";
import {
  createFeeV1V,
  errorResponseV1V,
  feeListV1V,
  feeV1V,
  listFeesQueryV1V,
  updateFeeV1V,
} from "./fees_v1.verifier";

// Recurso fees/v1: catálogo de cuotas por comunidad — concepto, monto base,
// periodicidad y vigencia. La lectura alimenta el registro de cargos
// (POST /units/:unitId/charges elige una de estas cuotas); el CRUD lo
// administra. Baja lógica.

/** Cuerpo del PATCH → UpdateFeeInput (null en NOT NULL = "no tocar";
 *  null en `effectiveTo` = "limpiar": la cuota queda sin fin de vigencia). */
function toUpdateInput(body: {
  concept?: string | null;
  baseAmount?: number | null;
  periodicity?: string | null;
  effectiveFrom?: string | null;
  effectiveTo?: string | null;
  status?: string | null;
}): UpdateFeeInput {
  return {
    ...(body.concept !== null && body.concept !== undefined && { concept: body.concept }),
    ...(body.baseAmount !== null &&
      body.baseAmount !== undefined && { baseAmount: body.baseAmount }),
    ...(body.periodicity !== null &&
      body.periodicity !== undefined && { periodicity: body.periodicity }),
    ...(body.effectiveFrom !== null &&
      body.effectiveFrom !== undefined && { effectiveFrom: body.effectiveFrom }),
    ...(body.status !== null && body.status !== undefined && { status: body.status }),
    // Anulable: se incluye aunque sea null (null = limpiar).
    ...(body.effectiveTo !== undefined && { effectiveTo: body.effectiveTo }),
  };
}

export async function feesV1Routes(instance: FastifyInstance): Promise<void> {
  const app = instance.withTypeProvider<StructureVerifierTypeProvider>();

  // Listar (paginado)
  app.get(
    "/communities/:communityId/fees",
    {
      schema: {
        params: communityIdParamV1V,
        querystring: listFeesQueryV1V,
        response: { 200: feeListV1V, 404: errorResponseV1V },
      },
      preHandler: [requirePermission(PERMISSIONS.feesRead), requireCommunityAccess()],
    },
    async (req, reply) => {
      const q = req.query;
      const { items, total } = await feesController.list(req, {
        communityId: req.params.communityId,
        page: q.page,
        pageSize: q.pageSize,
        search: q.search ?? null,
        status: q.status ?? null,
        activeOn: q.activeOn ?? null,
      });
      return reply.code(200).send({ items, total, page: q.page, pageSize: q.pageSize });
    },
  );

  // Obtener una
  app.get(
    "/communities/:communityId/fees/:id",
    {
      schema: {
        params: communityScopedIdParamV1V,
        response: { 200: feeV1V, 404: errorResponseV1V },
      },
      preHandler: [requirePermission(PERMISSIONS.feesRead), requireCommunityAccess()],
    },
    async (req, reply) => {
      const found = await feesController.getById(req, req.params.communityId, req.params.id);
      if (found === null) {
        return reply.code(404).send({ error: "not_found", message: null });
      }
      return reply.code(200).send(found);
    },
  );

  // Crear
  app.post(
    "/communities/:communityId/fees",
    {
      schema: {
        params: communityIdParamV1V,
        body: createFeeV1V,
        response: {
          201: feeV1V,
          400: errorResponseV1V,
          404: errorResponseV1V,
          409: errorResponseV1V,
        },
      },
      preHandler: [requirePermission(PERMISSIONS.feesCreate), requireCommunityAccess()],
    },
    async (req, reply) => {
      const b = req.body;
      const result = await feesController.create(req, req.params.communityId, {
        concept: b.concept,
        baseAmount: b.baseAmount,
        periodicity: b.periodicity,
        effectiveFrom: b.effectiveFrom,
        effectiveTo: b.effectiveTo ?? null,
      });
      if (!result.ok) {
        const status = result.error.kind === "conflict" ? 409 : 400;
        return reply.code(status).send({ error: result.error.kind, message: result.error.message });
      }
      return reply.code(201).send(result.value);
    },
  );

  // Actualizar (parcial)
  app.patch(
    "/communities/:communityId/fees/:id",
    {
      schema: {
        params: communityScopedIdParamV1V,
        body: updateFeeV1V,
        response: {
          200: feeV1V,
          400: errorResponseV1V,
          404: errorResponseV1V,
          409: errorResponseV1V,
        },
      },
      preHandler: [requirePermission(PERMISSIONS.feesUpdate), requireCommunityAccess()],
    },
    async (req, reply) => {
      const result = await feesController.update(
        req,
        req.params.communityId,
        req.params.id,
        toUpdateInput(req.body),
      );
      if (result === null) {
        return reply.code(404).send({ error: "not_found", message: null });
      }
      if (!result.ok) {
        const status = result.error.kind === "conflict" ? 409 : 400;
        return reply.code(status).send({ error: result.error.kind, message: result.error.message });
      }
      return reply.code(200).send(result.value);
    },
  );

  // Baja lógica
  app.delete(
    "/communities/:communityId/fees/:id",
    {
      // Baja lógica → se autoriza con `.update` (convención general).
      schema: { params: communityScopedIdParamV1V },
      preHandler: [requirePermission(PERMISSIONS.feesUpdate), requireCommunityAccess()],
    },
    async (req, reply) => {
      const deleted = await feesController.softDelete(req, req.params.communityId, req.params.id);
      if (!deleted) {
        return reply.code(404).send({ error: "not_found", message: null });
      }
      return reply.code(204).send();
    },
  );
}
