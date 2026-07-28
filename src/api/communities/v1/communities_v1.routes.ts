import type { FastifyInstance } from "fastify";
import type { StructureVerifierTypeProvider } from "structure-verifier/fastify";
import { requireCommunityAccess } from "../../../core/auth/community_access";
import { PERMISSIONS } from "../../../core/auth/permissions";
import { requirePermission } from "../../../core/auth/require_permission";
import { communityIdParamV1V } from "../../common/common_v1.verifier";
import { communitiesController } from "./communities_v1.controller";
import type { UpdateCommunityInput } from "./communities_v1.repository";
import {
  balanceQueryV1V,
  communityBalanceV1V,
  communityListV1V,
  communityV1V,
  createCommunityV1V,
  errorResponseV1V,
  listCommunitiesQueryV1V,
  updateCommunityV1V,
} from "./communities_v1.verifier";

// Recurso communities/v1: CRUD. Es el punto de entrada del alcance del usuario
// — lista únicamente las comunidades donde tiene membresía activa
// (community.community_members) y expone el saldo derivado de la caja.
//
// Las rutas de LECTURA/ESCRITURA de la comunidad en sí no llevan
// `requireCommunityAccess()`: ese preHandler exige la comunidad ACTIVA, y con
// él desactivar una comunidad sería un viaje sin retorno (nadie podría editarla
// ni reactivarla). Su alcance lo aplica el repository con el mismo JOIN de
// membresía, admitiendo `inactive`. Lo conserva `/balance` —un saldo solo tiene
// sentido en operación—, y lo conservan las rutas ANIDADAS (unidades, cuotas,
// cargos…): desactivar una comunidad debe cerrar de golpe lo que cuelga de ella.

/** Cuerpo del PATCH → UpdateCommunityInput (campo ausente = "no tocar";
 *  `address` viaja aunque sea null: null = limpiar). */
function toUpdateInput(body: {
  code?: string | null;
  name?: string | null;
  address?: string | null;
  status?: string | null;
}): UpdateCommunityInput {
  return {
    ...(body.code !== null && body.code !== undefined && { code: body.code }),
    ...(body.name !== null && body.name !== undefined && { name: body.name }),
    ...(body.status !== null && body.status !== undefined && { status: body.status }),
    ...(body.address !== undefined && { address: body.address }),
  };
}

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
        status: q.status ?? null,
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

  // Crear. El actor queda como primer miembro (misma transacción): sin eso
  // acabaría de crear una comunidad que ni él mismo vería.
  app.post(
    "/communities",
    {
      schema: {
        body: createCommunityV1V,
        response: { 201: communityV1V, 400: errorResponseV1V, 409: errorResponseV1V },
      },
      preHandler: requirePermission(PERMISSIONS.communitiesCreate),
    },
    async (req, reply) => {
      const b = req.body;
      const result = await communitiesController.create(req, {
        code: b.code,
        name: b.name,
        address: b.address ?? null,
      });
      if (!result.ok) {
        const status = result.error.kind === "conflict" ? 409 : 400;
        return reply.code(status).send({ error: result.error.kind, message: result.error.message });
      }
      return reply.code(201).send(result.value);
    },
  );

  // Actualizar (parcial). Incluye activar/desactivar por `status`.
  app.patch(
    "/communities/:communityId",
    {
      schema: {
        params: communityIdParamV1V,
        body: updateCommunityV1V,
        response: {
          200: communityV1V,
          400: errorResponseV1V,
          404: errorResponseV1V,
          409: errorResponseV1V,
        },
      },
      preHandler: requirePermission(PERMISSIONS.communitiesUpdate),
    },
    async (req, reply) => {
      const result = await communitiesController.update(
        req,
        req.params.communityId,
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

  // Baja lógica. Autorizada con `communities.update`: la convención de la
  // plataforma reserva un `.delete` propio para excepciones (units), y esta no
  // lo es. Lo que cuelga de la comunidad no se toca — deja de ser alcanzable.
  app.delete(
    "/communities/:communityId",
    {
      schema: { params: communityIdParamV1V },
      preHandler: requirePermission(PERMISSIONS.communitiesUpdate),
    },
    async (req, reply) => {
      const deleted = await communitiesController.softDelete(req, req.params.communityId);
      if (!deleted) {
        return reply.code(404).send({ error: "not_found", message: null });
      }
      return reply.code(204).send();
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
