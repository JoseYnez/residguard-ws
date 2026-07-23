import type { FastifyInstance } from "fastify";
import type { StructureVerifierTypeProvider } from "structure-verifier/fastify";
import { requireCommunityAccess } from "../../../core/auth/community_access";
import { PERMISSIONS } from "../../../core/auth/permissions";
import { requirePermission } from "../../../core/auth/require_permission";
import {
  communityIdParamV1V,
  communityScopedIdParamV1V,
} from "../../common/common_v1.verifier";
import { expenseCategoriesController } from "./expense_categories_v1.controller";
import {
  createExpenseCategoryV1V,
  errorResponseV1V,
  expenseCategoryListV1V,
  expenseCategoryV1V,
  listExpenseCategoriesQueryV1V,
  updateExpenseCategoryV1V,
} from "./expense_categories_v1.verifier";

// Recurso expense-categories/v1: catálogo de rubros de gasto por comunidad.
// CRUD anidado bajo /communities/:communityId. Baja lógica.

export async function expenseCategoriesV1Routes(instance: FastifyInstance): Promise<void> {
  const app = instance.withTypeProvider<StructureVerifierTypeProvider>();

  // Listar (paginado)
  app.get(
    "/communities/:communityId/expense-categories",
    {
      schema: {
        params: communityIdParamV1V,
        querystring: listExpenseCategoriesQueryV1V,
        response: { 200: expenseCategoryListV1V, 404: errorResponseV1V },
      },
      preHandler: [requirePermission(PERMISSIONS.expenseCategoriesRead), requireCommunityAccess()],
    },
    async (req, reply) => {
      const q = req.query;
      const { items, total } = await expenseCategoriesController.list(req, {
        communityId: req.params.communityId,
        page: q.page,
        pageSize: q.pageSize,
        search: q.search ?? null,
        status: q.status ?? null,
      });
      return reply.code(200).send({ items, total, page: q.page, pageSize: q.pageSize });
    },
  );

  // Obtener uno
  app.get(
    "/communities/:communityId/expense-categories/:id",
    {
      schema: {
        params: communityScopedIdParamV1V,
        response: { 200: expenseCategoryV1V, 404: errorResponseV1V },
      },
      preHandler: [requirePermission(PERMISSIONS.expenseCategoriesRead), requireCommunityAccess()],
    },
    async (req, reply) => {
      const found = await expenseCategoriesController.getById(
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
    "/communities/:communityId/expense-categories",
    {
      schema: {
        params: communityIdParamV1V,
        body: createExpenseCategoryV1V,
        response: {
          201: expenseCategoryV1V,
          400: errorResponseV1V,
          404: errorResponseV1V,
          409: errorResponseV1V,
        },
      },
      preHandler: [requirePermission(PERMISSIONS.expenseCategoriesCreate), requireCommunityAccess()],
    },
    async (req, reply) => {
      const result = await expenseCategoriesController.create(req, req.params.communityId, {
        name: req.body.name,
        description: req.body.description ?? null,
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
    "/communities/:communityId/expense-categories/:id",
    {
      schema: {
        params: communityScopedIdParamV1V,
        body: updateExpenseCategoryV1V,
        response: {
          200: expenseCategoryV1V,
          400: errorResponseV1V,
          404: errorResponseV1V,
          409: errorResponseV1V,
        },
      },
      preHandler: [requirePermission(PERMISSIONS.expenseCategoriesUpdate), requireCommunityAccess()],
    },
    async (req, reply) => {
      const b = req.body;
      const result = await expenseCategoriesController.update(
        req,
        req.params.communityId,
        req.params.id,
        {
          ...(b.name !== null && b.name !== undefined && { name: b.name }),
          ...(b.status !== null && b.status !== undefined && { status: b.status }),
          ...(b.description !== undefined && { description: b.description }),
        },
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
    "/communities/:communityId/expense-categories/:id",
    {
      // Baja lógica → se autoriza con `.update`.
      schema: { params: communityScopedIdParamV1V },
      preHandler: [requirePermission(PERMISSIONS.expenseCategoriesUpdate), requireCommunityAccess()],
    },
    async (req, reply) => {
      const deleted = await expenseCategoriesController.softDelete(
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
