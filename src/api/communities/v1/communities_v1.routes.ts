import type { FastifyInstance } from "fastify";
import type { StructureVerifierTypeProvider } from "structure-verifier/fastify";
import { requireCommunityAccess } from "../../../core/auth/community_access";
import { PERMISSIONS } from "../../../core/auth/permissions";
import { requirePermission } from "../../../core/auth/require_permission";
import { communityIdParamV1V } from "../../common/common_v1.verifier";
import { communitiesController } from "./communities_v1.controller";
import {
  balanceQueryV1V,
  communityBalanceV1V,
  communityListV1V,
  communityV1V,
  errorResponseV1V,
  listCommunitiesQueryV1V,
} from "./communities_v1.verifier";

// Recurso communities/v1: SOLO LECTURA. Es el punto de entrada del alcance del
// usuario — lista únicamente las comunidades donde tiene membresía activa
// (community.community_members) y expone el saldo derivado de la caja.

export async function communitiesV1Routes(instance: FastifyInstance): Promise<void> {
  const app = instance.withTypeProvider<StructureVerifierTypeProvider>();

  // Listar comunidades accesibles (paginado)
  app.get(
    "/communities",
    {
      schema: { querystring: listCommunitiesQueryV1V, response: { 200: communityListV1V } },
      // Sin requireCommunityAccess: no hay :communityId que validar. El alcance
      // lo aplica el ACCESS_JOIN del repositorio (solo comunidades con membresía).
      preHandler: requirePermission(PERMISSIONS.communitiesRead),
    },
    async (req, reply) => {
      const q = req.query;
      const { items, total } = await communitiesController.list(req, {
        page: q.page,
        pageSize: q.pageSize,
        search: q.search ?? null,
      });
      return reply.code(200).send({ items, total, page: q.page, pageSize: q.pageSize });
    },
  );

  // Obtener una (dentro del alcance)
  app.get(
    "/communities/:communityId",
    {
      schema: {
        params: communityIdParamV1V,
        response: { 200: communityV1V, 404: errorResponseV1V },
      },
      // El alcance también va por el JOIN del repositorio: fuera de él → 404.
      preHandler: requirePermission(PERMISSIONS.communitiesRead),
    },
    async (req, reply) => {
      const found = await communitiesController.getById(req, req.params.communityId);
      if (found === null) {
        return reply.code(404).send({ error: "not_found", message: null });
      }
      return reply.code(200).send(found);
    },
  );

  // Saldo de la caja de la comunidad (derivado, opcionalmente a fecha de corte)
  app.get(
    "/communities/:communityId/balance",
    {
      schema: {
        params: communityIdParamV1V,
        querystring: balanceQueryV1V,
        response: { 200: communityBalanceV1V, 404: errorResponseV1V },
      },
      preHandler: [requirePermission(PERMISSIONS.communitiesRead), requireCommunityAccess()],
    },
    async (req, reply) => {
      const toDate = req.query.toDate ?? null;
      const balance = await communitiesController.getBalance(
        req,
        req.params.communityId,
        toDate,
      );
      if (balance === null) {
        return reply.code(404).send({ error: "not_found", message: null });
      }
      return reply
        .code(200)
        .send({ communityId: req.params.communityId, balance, toDate });
    },
  );
}
