import type { FastifyInstance } from "fastify";
import type { StructureVerifierTypeProvider } from "structure-verifier/fastify";
import { requireCommunityAccess } from "../../../core/auth/community_access";
import { PERMISSIONS } from "../../../core/auth/permissions";
import { requirePermission } from "../../../core/auth/require_permission";
import {
  communityIdParamV1V,
  communityScopedIdParamV1V,
} from "../../common/common_v1.verifier";
import { expensesController } from "./expenses_v1.controller";
import type { UpdateExpenseInput } from "./expenses_v1.repository";
import {
  createExpenseV1V,
  errorResponseV1V,
  expenseListV1V,
  expenseV1V,
  listExpensesQueryV1V,
  updateExpenseV1V,
} from "./expenses_v1.verifier";

// Recurso expenses/v1: gastos (egresos) ejercidos por una comunidad. CRUD
// anidado bajo /communities/:communityId. Baja lógica; el saldo de la caja
// se deriva (GET /communities/:communityId/balance).

/** Cuerpo del PATCH → UpdateExpenseInput (null en NOT NULL = "no tocar";
 *  null en anulables = "limpiar"). */
function toUpdateInput(body: {
  expenseCategoryId?: string | null;
  concept?: string | null;
  amount?: number | null;
  expenseDate?: string | null;
  method?: string | null;
  vendorName?: string | null;
  reference?: string | null;
  authorizedBy?: string | null;
  cashAccountId?: string | null;
}): UpdateExpenseInput {
  return {
    ...(body.expenseCategoryId !== null &&
      body.expenseCategoryId !== undefined && { expenseCategoryId: body.expenseCategoryId }),
    ...(body.concept !== null && body.concept !== undefined && { concept: body.concept }),
    ...(body.amount !== null && body.amount !== undefined && { amount: body.amount }),
    ...(body.expenseDate !== null &&
      body.expenseDate !== undefined && { expenseDate: body.expenseDate }),
    ...(body.method !== null && body.method !== undefined && { method: body.method }),
    // Anulables: se incluyen aunque sean null (null = limpiar).
    ...(body.vendorName !== undefined && { vendorName: body.vendorName }),
    ...(body.reference !== undefined && { reference: body.reference }),
    ...(body.authorizedBy !== undefined && { authorizedBy: body.authorizedBy }),
    ...(body.cashAccountId !== undefined && { cashAccountId: body.cashAccountId }),
  };
}

export async function expensesV1Routes(instance: FastifyInstance): Promise<void> {
  const app = instance.withTypeProvider<StructureVerifierTypeProvider>();

  // Listar (paginado)
  app.get(
    "/communities/:communityId/expenses",
    {
      schema: {
        params: communityIdParamV1V,
        querystring: listExpensesQueryV1V,
        response: { 200: expenseListV1V, 404: errorResponseV1V },
      },
      preHandler: [requirePermission(PERMISSIONS.expensesRead), requireCommunityAccess()],
    },
    async (req, reply) => {
      const q = req.query;
      const { items, total } = await expensesController.list(req, {
        communityId: req.params.communityId,
        page: q.page,
        pageSize: q.pageSize,
        expenseCategoryId: q.expenseCategoryId ?? null,
        method: q.method ?? null,
        cashAccountId: q.cashAccountId ?? null,
        from: q.from ?? null,
        to: q.to ?? null,
        search: q.search ?? null,
      });
      return reply.code(200).send({ items, total, page: q.page, pageSize: q.pageSize });
    },
  );

  // Obtener uno
  app.get(
    "/communities/:communityId/expenses/:id",
    {
      schema: {
        params: communityScopedIdParamV1V,
        response: { 200: expenseV1V, 404: errorResponseV1V },
      },
      preHandler: [requirePermission(PERMISSIONS.expensesRead), requireCommunityAccess()],
    },
    async (req, reply) => {
      const found = await expensesController.getById(req, req.params.communityId, req.params.id);
      if (found === null) {
        return reply.code(404).send({ error: "not_found", message: null });
      }
      return reply.code(200).send(found);
    },
  );

  // Crear
  app.post(
    "/communities/:communityId/expenses",
    {
      schema: {
        params: communityIdParamV1V,
        body: createExpenseV1V,
        response: {
          201: expenseV1V,
          400: errorResponseV1V,
          404: errorResponseV1V,
        },
      },
      preHandler: [requirePermission(PERMISSIONS.expensesCreate), requireCommunityAccess()],
    },
    async (req, reply) => {
      const b = req.body;
      const result = await expensesController.create(req, req.params.communityId, {
        expenseCategoryId: b.expenseCategoryId,
        concept: b.concept,
        amount: b.amount,
        expenseDate: b.expenseDate,
        method: b.method,
        vendorName: b.vendorName ?? null,
        reference: b.reference ?? null,
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
    "/communities/:communityId/expenses/:id",
    {
      schema: {
        params: communityScopedIdParamV1V,
        body: updateExpenseV1V,
        response: {
          200: expenseV1V,
          400: errorResponseV1V,
          404: errorResponseV1V,
        },
      },
      preHandler: [requirePermission(PERMISSIONS.expensesUpdate), requireCommunityAccess()],
    },
    async (req, reply) => {
      const result = await expensesController.update(
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
    "/communities/:communityId/expenses/:id",
    {
      // Baja lógica → se autoriza con `.update`.
      schema: { params: communityScopedIdParamV1V },
      preHandler: [requirePermission(PERMISSIONS.expensesUpdate), requireCommunityAccess()],
    },
    async (req, reply) => {
      const deleted = await expensesController.softDelete(
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
