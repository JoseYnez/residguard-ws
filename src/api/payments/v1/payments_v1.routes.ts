import type { FastifyInstance } from "fastify";
import type { StructureVerifierTypeProvider } from "structure-verifier/fastify";
import { PERMISSIONS } from "../../../core/auth/permissions";
import { requirePermission } from "../../../core/auth/require_permission";
import { idParamV1V } from "../../common/common_v1.verifier";
import { paymentsController } from "./payments_v1.controller";
import {
  createPaymentV1V,
  errorResponseV1V,
  listPaymentsQueryV1V,
  paymentDetailV1V,
  paymentListV1V,
} from "./payments_v1.verifier";

// Recurso payments/v1: registrar un depósito repartido entre 1..N cargos
// (billing.sp_register_payment, vía sancionada), consultarlo y anularlo.
// El alcance no usa preHandler (el pago no cuelga de una comunidad): se
// valida en el controller contra los cargos que el pago toca.

export async function paymentsV1Routes(instance: FastifyInstance): Promise<void> {
  const app = instance.withTypeProvider<StructureVerifierTypeProvider>();

  // Registrar un pago (depósito + aplicaciones)
  app.post(
    "/payments",
    {
      schema: {
        body: createPaymentV1V,
        response: { 201: paymentDetailV1V, 400: errorResponseV1V, 409: errorResponseV1V },
      },
      // El permiso dice QUÉ puede hacer; el alcance (TODAS las comunidades de
      // los cargos tocados) lo sigue validando el controller.
      preHandler: requirePermission(PERMISSIONS.paymentsCreate),
    },
    async (req, reply) => {
      const b = req.body;
      const result = await paymentsController.register(req, {
        amount: b.amount,
        method: b.method,
        paidAt: b.paidAt ?? null,
        reference: b.reference ?? null,
        cashAccountId: b.cashAccountId ?? null,
        allocations: b.allocations.map((a) => ({ chargeId: a.chargeId, amount: a.amount })),
      });
      if (!result.ok) {
        const status = result.error.kind === "conflict" ? 409 : 400;
        return reply.code(status).send({ error: result.error.kind, message: result.error.message });
      }
      return reply.code(201).send(result.value);
    },
  );

  // Listar pagos de una comunidad (por sus cargos cubiertos)
  app.get(
    "/payments",
    {
      schema: {
        querystring: listPaymentsQueryV1V,
        response: { 200: paymentListV1V, 404: errorResponseV1V },
      },
      preHandler: requirePermission(PERMISSIONS.paymentsRead),
    },
    async (req, reply) => {
      const q = req.query;
      const result = await paymentsController.list(req, {
        communityId: q.communityId,
        page: q.page,
        pageSize: q.pageSize,
        method: q.method ?? null,
        cashAccountId: q.cashAccountId ?? null,
        from: q.from ?? null,
        to: q.to ?? null,
      });
      if (result === null) {
        return reply.code(404).send({ error: "not_found", message: null });
      }
      return reply
        .code(200)
        .send({ items: result.items, total: result.total, page: q.page, pageSize: q.pageSize });
    },
  );

  // Obtener un pago con sus aplicaciones
  app.get(
    "/payments/:id",
    {
      schema: {
        params: idParamV1V,
        response: { 200: paymentDetailV1V, 404: errorResponseV1V },
      },
      preHandler: requirePermission(PERMISSIONS.paymentsRead),
    },
    async (req, reply) => {
      const found = await paymentsController.getById(req, req.params.id);
      if (found === null) {
        return reply.code(404).send({ error: "not_found", message: null });
      }
      return reply.code(200).send(found);
    },
  );

  // Anular un pago (baja lógica + recálculo de estatus de sus cargos)
  app.delete(
    "/payments/:id",
    {
      schema: { params: idParamV1V },
      // Anular no es `.update`: es una operación sancionada aparte (soft-delete
      // + recálculo de estatus de cargos), con su propio permiso `execute`.
      preHandler: requirePermission(PERMISSIONS.paymentsRevoke),
    },
    async (req, reply) => {
      const outcome = await paymentsController.softDelete(req, req.params.id);
      if (outcome === "not_found") {
        return reply.code(404).send({ error: "not_found", message: null });
      }
      if (outcome === "forbidden") {
        return reply.code(403).send({ error: "forbidden", message: null });
      }
      return reply.code(204).send();
    },
  );
}
