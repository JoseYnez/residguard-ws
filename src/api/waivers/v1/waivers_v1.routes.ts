import type { FastifyInstance } from "fastify";
import type { StructureVerifierTypeProvider } from "structure-verifier/fastify";
import { requireCommunityAccess } from "../../../core/auth/community_access";
import { PERMISSIONS } from "../../../core/auth/permissions";
import { requirePermission } from "../../../core/auth/require_permission";
import {
  communityIdParamV1V,
  communityScopedIdParamV1V,
} from "../../common/common_v1.verifier";
import { waiversController } from "./waivers_v1.controller";
import {
  communityChargeParamV1V,
  createWaiverV1V,
  errorResponseV1V,
  listWaiversQueryV1V,
  waiverListV1V,
  waiverV1V,
} from "./waivers_v1.verifier";

// Recurso waivers/v1: CONDONAR un cargo (perdonar total o parcialmente su
// saldo, billing.sp_waive_charge), consultar el historial de la comunidad y
// REVERTIR una condonación (baja lógica + recálculo del estatus del cargo).
//
// Todo cuelga de /communities/:communityId — el alcance sale del preHandler,
// como en charges. Condonar es una operación sancionada con permiso propio
// (`waivers.create`, execute): no es editar el cargo ni anularlo.

export async function waiversV1Routes(instance: FastifyInstance): Promise<void> {
  const app = instance.withTypeProvider<StructureVerifierTypeProvider>();

  // Condonar un cargo. Sin `amount` se perdona TODO el saldo pendiente.
  app.post(
    "/communities/:communityId/charges/:chargeId/waivers",
    {
      schema: {
        params: communityChargeParamV1V,
        body: createWaiverV1V,
        response: {
          201: waiverV1V,
          400: errorResponseV1V,
          404: errorResponseV1V,
          409: errorResponseV1V,
        },
      },
      preHandler: [requirePermission(PERMISSIONS.waiversCreate), requireCommunityAccess()],
    },
    async (req, reply) => {
      const b = req.body;
      const result = await waiversController.create(
        req,
        req.params.communityId,
        req.params.chargeId,
        { amount: b.amount ?? null, reason: b.reason },
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

  // Historial de condonaciones de la comunidad. `chargeId` acota a un cargo
  // (lo que consume la ficha del cargo); `unitId`, a una unidad.
  app.get(
    "/communities/:communityId/waivers",
    {
      schema: {
        params: communityIdParamV1V,
        querystring: listWaiversQueryV1V,
        response: { 200: waiverListV1V, 404: errorResponseV1V },
      },
      preHandler: [requirePermission(PERMISSIONS.waiversRead), requireCommunityAccess()],
    },
    async (req, reply) => {
      const q = req.query;
      const { items, total } = await waiversController.list(req, {
        communityId: req.params.communityId,
        page: q.page,
        pageSize: q.pageSize,
        chargeId: q.chargeId ?? null,
        unitId: q.unitId ?? null,
        from: q.from ?? null,
        to: q.to ?? null,
      });
      return reply.code(200).send({ items, total, page: q.page, pageSize: q.pageSize });
    },
  );

  // Revertir una condonación: el cargo recupera ese saldo y vuelve a
  // pending/partial. Permiso propio (`waivers.revoke`, execute).
  app.delete(
    "/communities/:communityId/waivers/:id",
    {
      // Sin mapa de `response`: responde 204 sin cuerpo (misma convención que
      // las otras bajas del servicio).
      schema: { params: communityScopedIdParamV1V },
      preHandler: [requirePermission(PERMISSIONS.waiversRevoke), requireCommunityAccess()],
    },
    async (req, reply) => {
      const reverted = await waiversController.revoke(req, req.params.communityId, req.params.id);
      if (!reverted) {
        return reply.code(404).send({ error: "not_found", message: null });
      }
      return reply.code(204).send();
    },
  );
}
