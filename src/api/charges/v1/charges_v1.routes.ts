import type { FastifyInstance } from "fastify";
import type { StructureVerifierTypeProvider } from "structure-verifier/fastify";
import {
  requireCommunityAccess,
  requireUnitAccess,
} from "../../../core/auth/community_access";
import { PERMISSIONS } from "../../../core/auth/permissions";
import { requirePermission } from "../../../core/auth/require_permission";
import {
  communityIdParamV1V,
  communityScopedIdParamV1V,
  unitIdParamV1V,
} from "../../common/common_v1.verifier";
import { chargesController } from "./charges_v1.controller";
import {
  chargeListV1V,
  createChargesV1V,
  createdChargesV1V,
  errorResponseV1V,
  generateChargesV1V,
  generatedChargesV1V,
  listChargesQueryV1V,
} from "./charges_v1.verifier";

// Recurso charges/v1: estado de cuenta por COMUNIDAD (todas sus unidades, con
// filtro opcional por unidad) o por unidad (alimenta el flujo de pagos),
// REGISTRO de una cuota sobre una o varias unidades de la comunidad (un cargo
// por unidad, transacción todo-o-nada) y ANULACIÓN de un cargo (baja lógica,
// solo mientras no tenga pagos ni condonaciones).

export async function chargesV1Routes(instance: FastifyInstance): Promise<void> {
  const app = instance.withTypeProvider<StructureVerifierTypeProvider>();

  // Listar por comunidad (todas las unidades; `unitId` opcional para acotar).
  app.get(
    "/communities/:communityId/charges",
    {
      schema: {
        params: communityIdParamV1V,
        querystring: listChargesQueryV1V,
        response: { 200: chargeListV1V, 404: errorResponseV1V },
      },
      preHandler: [requirePermission(PERMISSIONS.chargesRead), requireCommunityAccess()],
    },
    async (req, reply) => {
      const q = req.query;
      const { items, total } = await chargesController.list(req, {
        communityId: req.params.communityId,
        unitId: q.unitId ?? null,
        page: q.page,
        pageSize: q.pageSize,
        paymentStatus: q.paymentStatus ?? null,
        overdueOnly: q.overdueOnly ?? null,
        openOnly: q.openOnly ?? null,
        from: q.from ?? null,
        to: q.to ?? null,
      });
      return reply.code(200).send({ items, total, page: q.page, pageSize: q.pageSize });
    },
  );

  // Listar por unidad (estado de cuenta que consume el flujo de pagos).
  app.get(
    "/units/:unitId/charges",
    {
      schema: {
        params: unitIdParamV1V,
        querystring: listChargesQueryV1V,
        response: { 200: chargeListV1V, 404: errorResponseV1V },
      },
      preHandler: [requirePermission(PERMISSIONS.chargesRead), requireUnitAccess()],
    },
    async (req, reply) => {
      const q = req.query;
      const { items, total } = await chargesController.list(req, {
        // La unidad manda: viene de la ruta (el filtro de query se ignora aquí).
        unitId: req.params.unitId,
        page: q.page,
        pageSize: q.pageSize,
        paymentStatus: q.paymentStatus ?? null,
        overdueOnly: q.overdueOnly ?? null,
        openOnly: q.openOnly ?? null,
        from: q.from ?? null,
        to: q.to ?? null,
      });
      return reply.code(200).send({ items, total, page: q.page, pageSize: q.pageSize });
    },
  );

  // Registrar cargos: la misma cuota/periodo sobre 1..N unidades de la
  // comunidad. Todo-o-nada: si una unidad falla, no se crea ninguno.
  app.post(
    "/communities/:communityId/charges",
    {
      schema: {
        params: communityIdParamV1V,
        body: createChargesV1V,
        response: {
          201: createdChargesV1V,
          400: errorResponseV1V,
          404: errorResponseV1V,
          409: errorResponseV1V,
        },
      },
      preHandler: [requirePermission(PERMISSIONS.chargesCreate), requireCommunityAccess()],
    },
    async (req, reply) => {
      const b = req.body;
      const result = await chargesController.create(req, req.params.communityId, {
        feeId: b.feeId,
        unitIds: b.unitIds,
        periodStart: b.periodStart,
        periodEnd: b.periodEnd,
        appliedAmount: b.appliedAmount,
        dueDate: b.dueDate,
      });
      if (!result.ok) {
        const status = result.error.kind === "conflict" ? 409 : 400;
        return reply.code(status).send({ error: result.error.kind, message: result.error.message });
      }
      return reply.code(201).send({ items: result.value, total: result.value.length });
    },
  );

  // Anular un cargo (baja lógica). No es una edición: se autoriza con su
  // propio `charges.revoke` (execute), igual que anular un pago. 409 si el
  // cargo ya tiene dinero aplicado o condonaciones — ese cargo existió y su
  // rastro no se reescribe; primero se anula el pago.
  app.delete(
    "/communities/:communityId/charges/:id",
    {
      // Sin mapa de `response`: declararlo fija los estatus admitidos y este
      // endpoint responde 204 sin cuerpo (misma convención que las otras bajas).
      schema: { params: communityScopedIdParamV1V },
      preHandler: [requirePermission(PERMISSIONS.chargesRevoke), requireCommunityAccess()],
    },
    async (req, reply) => {
      const result = await chargesController.revoke(
        req,
        req.params.communityId,
        req.params.id,
      );
      if (result === null) {
        return reply.code(404).send({ error: "not_found", message: null });
      }
      if (!result.ok) {
        return reply.code(409).send({ error: result.error.kind, message: result.error.message });
      }
      return reply.code(204).send();
    },
  );

  // Generar la cuota sobre TODAS sus unidades activas en un rango (default: su
  // vigencia). El largo/paso de cada cargo lo define la periodicidad; one_time
  // genera uno solo. Idempotente: reejecutar no crea duplicados.
  app.post(
    "/communities/:communityId/charges/generate",
    {
      schema: {
        params: communityIdParamV1V,
        body: generateChargesV1V,
        response: {
          201: generatedChargesV1V,
          400: errorResponseV1V,
          404: errorResponseV1V,
          409: errorResponseV1V,
        },
      },
      preHandler: [requirePermission(PERMISSIONS.chargesCreate), requireCommunityAccess()],
    },
    async (req, reply) => {
      const b = req.body;
      const result = await chargesController.generate(req, req.params.communityId, {
        feeId: b.feeId,
        from: b.from ?? null,
        to: b.to ?? null,
        dueDay: b.dueDay ?? null,
        amount: b.amount ?? null,
      });
      if (!result.ok) {
        const status = result.error.kind === "conflict" ? 409 : 400;
        return reply.code(status).send({ error: result.error.kind, message: result.error.message });
      }
      return reply.code(201).send({ created: result.value });
    },
  );
}
