import type { FastifyInstance } from "fastify";
import type { StructureVerifierTypeProvider } from "structure-verifier/fastify";
import { requireUnitAccess } from "../../../core/auth/community_access";
import { PERMISSIONS } from "../../../core/auth/permissions";
import { requirePermission } from "../../../core/auth/require_permission";
import { unitIdParamV1V } from "../../common/common_v1.verifier";
import { chargesController } from "./charges_v1.controller";
import {
  chargeListV1V,
  errorResponseV1V,
  listChargesQueryV1V,
} from "./charges_v1.verifier";

// Recurso charges/v1: SOLO LECTURA. Estado de cuenta de una unidad — qué
// cargos tiene, con saldo pendiente y vencimiento — para alimentar el flujo
// de pagos (POST /payments aplica contra estos cargos).

export async function chargesV1Routes(instance: FastifyInstance): Promise<void> {
  const app = instance.withTypeProvider<StructureVerifierTypeProvider>();

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
        unitId: req.params.unitId,
        page: q.page,
        pageSize: q.pageSize,
        paymentStatus: q.paymentStatus ?? null,
        overdueOnly: q.overdueOnly ?? null,
        from: q.from ?? null,
        to: q.to ?? null,
      });
      return reply.code(200).send({ items, total, page: q.page, pageSize: q.pageSize });
    },
  );
}
