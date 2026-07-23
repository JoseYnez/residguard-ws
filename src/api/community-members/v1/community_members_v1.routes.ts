import type { FastifyInstance } from "fastify";
import type { StructureVerifierTypeProvider } from "structure-verifier/fastify";
import { requireCommunityAccess } from "../../../core/auth/community_access";
import { PERMISSIONS } from "../../../core/auth/permissions";
import { requirePermission } from "../../../core/auth/require_permission";
import {
  communityIdParamV1V,
  communityScopedIdParamV1V,
} from "../../common/common_v1.verifier";
import { communityMembersController } from "./community_members_v1.controller";
import {
  communityMemberListV1V,
  communityMemberV1V,
  createCommunityMemberV1V,
  errorResponseV1V,
  listCommunityMembersQueryV1V,
} from "./community_members_v1.verifier";

// Recurso community-members/v1: quién puede VER cada comunidad. Gestionable
// por cualquier miembro activo de la comunidad (v1 sin roles). El PRIMER
// miembro de una comunidad se siembra desde la consola de la cuenta o el
// proceso de sincronización — sin membresía inicial nadie la alcanza.

export async function communityMembersV1Routes(instance: FastifyInstance): Promise<void> {
  const app = instance.withTypeProvider<StructureVerifierTypeProvider>();

  // Listar miembros de la comunidad (paginado)
  app.get(
    "/communities/:communityId/members",
    {
      schema: {
        params: communityIdParamV1V,
        querystring: listCommunityMembersQueryV1V,
        response: { 200: communityMemberListV1V, 404: errorResponseV1V },
      },
      preHandler: [requirePermission(PERMISSIONS.communityMembersRead), requireCommunityAccess()],
    },
    async (req, reply) => {
      const q = req.query;
      const { items, total } = await communityMembersController.list(req, {
        communityId: req.params.communityId,
        page: q.page,
        pageSize: q.pageSize,
        search: q.search ?? null,
      });
      return reply.code(200).send({ items, total, page: q.page, pageSize: q.pageSize });
    },
  );

  // Otorgar acceso a un usuario
  app.post(
    "/communities/:communityId/members",
    {
      schema: {
        params: communityIdParamV1V,
        body: createCommunityMemberV1V,
        response: {
          201: communityMemberV1V,
          400: errorResponseV1V,
          404: errorResponseV1V,
          409: errorResponseV1V,
        },
      },
      preHandler: [requirePermission(PERMISSIONS.communityMembersCreate), requireCommunityAccess()],
    },
    async (req, reply) => {
      const result = await communityMembersController.create(
        req,
        req.params.communityId,
        req.body.userId,
      );
      if (!result.ok) {
        const status = result.error.kind === "conflict" ? 409 : 400;
        return reply.code(status).send({ error: result.error.kind, message: result.error.message });
      }
      return reply.code(201).send(result.value);
    },
  );

  // Revocar acceso (baja lógica)
  app.delete(
    "/communities/:communityId/members/:id",
    {
      // Revocar acceso es baja lógica → se autoriza con `.update`.
      schema: { params: communityScopedIdParamV1V },
      preHandler: [requirePermission(PERMISSIONS.communityMembersUpdate), requireCommunityAccess()],
    },
    async (req, reply) => {
      const deleted = await communityMembersController.softDelete(
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
