import type { FastifyInstance } from "fastify";
import type { StructureVerifierTypeProvider } from "structure-verifier/fastify";
import { requireCommunityAccess } from "../../../core/auth/community_access";
import { PERMISSIONS } from "../../../core/auth/permissions";
import { requirePermission } from "../../../core/auth/require_permission";
import {
  communityIdParamV1V,
  communityScopedIdParamV1V,
} from "../../common/common_v1.verifier";
import { cashAccountsController } from "./cash_accounts_v1.controller";
import {
  cashAccountListV1V,
  cashAccountV1V,
  createCashAccountV1V,
  errorResponseV1V,
  listCashAccountsQueryV1V,
  updateCashAccountV1V,
} from "./cash_accounts_v1.verifier";

// Recurso cash-accounts/v1: catálogo de cajas por comunidad (dónde vive su
// dinero). CRUD anidado bajo /communities/:communityId. Baja lógica. El
// detalle y el listado incluyen el saldo DERIVADO de cada caja.

export async function cashAccountsV1Routes(instance: FastifyInstance): Promise<void> {
  const app = instance.withTypeProvider<StructureVerifierTypeProvider>();

  // Listar (paginado)
  app.get(
    "/communities/:communityId/cash-accounts",
    {
      schema: {
        params: communityIdParamV1V,
        querystring: listCashAccountsQueryV1V,
        response: { 200: cashAccountListV1V, 404: errorResponseV1V },
      },
      preHandler: [requirePermission(PERMISSIONS.cashAccountsRead), requireCommunityAccess()],
    },
    async (req, reply) => {
      const q = req.query;
      const { items, total } = await cashAccountsController.list(req, {
        communityId: req.params.communityId,
        page: q.page,
        pageSize: q.pageSize,
        search: q.search ?? null,
        status: q.status ?? null,
      });
      return reply.code(200).send({ items, total, page: q.page, pageSize: q.pageSize });
    },
  );

  // Obtener una
  app.get(
    "/communities/:communityId/cash-accounts/:id",
    {
      schema: {
        params: communityScopedIdParamV1V,
        response: { 200: cashAccountV1V, 404: errorResponseV1V },
      },
      preHandler: [requirePermission(PERMISSIONS.cashAccountsRead), requireCommunityAccess()],
    },
    async (req, reply) => {
      const found = await cashAccountsController.getById(
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
    "/communities/:communityId/cash-accounts",
    {
      schema: {
        params: communityIdParamV1V,
        body: createCashAccountV1V,
        response: {
          201: cashAccountV1V,
          400: errorResponseV1V,
          404: errorResponseV1V,
          409: errorResponseV1V,
        },
      },
      preHandler: [requirePermission(PERMISSIONS.cashAccountsCreate), requireCommunityAccess()],
    },
    async (req, reply) => {
      const result = await cashAccountsController.create(req, req.params.communityId, {
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
    "/communities/:communityId/cash-accounts/:id",
    {
      schema: {
        params: communityScopedIdParamV1V,
        body: updateCashAccountV1V,
        response: {
          200: cashAccountV1V,
          400: errorResponseV1V,
          404: errorResponseV1V,
          409: errorResponseV1V,
        },
      },
      preHandler: [requirePermission(PERMISSIONS.cashAccountsUpdate), requireCommunityAccess()],
    },
    async (req, reply) => {
      const b = req.body;
      const result = await cashAccountsController.update(
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
    "/communities/:communityId/cash-accounts/:id",
    {
      // Baja lógica → se autoriza con `.update`.
      schema: { params: communityScopedIdParamV1V },
      preHandler: [requirePermission(PERMISSIONS.cashAccountsUpdate), requireCommunityAccess()],
    },
    async (req, reply) => {
      const deleted = await cashAccountsController.softDelete(
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
