import type { FastifyInstance } from "fastify";
import type { StructureVerifierTypeProvider } from "structure-verifier/fastify";
import { requireCommunityAccess } from "../../../core/auth/community_access";
import { PERMISSIONS } from "../../../core/auth/permissions";
import { requirePermission } from "../../../core/auth/require_permission";
import {
  communityIdParamV1V,
  communityMemberParamV1V,
  communityMemberScopedIdParamV1V,
  communityScopedIdParamV1V,
} from "../../common/common_v1.verifier";
import { membersController } from "./members_v1.controller";
import type { UpdateMemberInput } from "./members_v1.repository";
import {
  createMemberPhoneV1V,
  createMemberV1V,
  errorResponseV1V,
  listMembersQueryV1V,
  memberDetailV1V,
  memberListV1V,
  memberPhoneV1V,
  updateMemberV1V,
} from "./members_v1.verifier";

// Recurso members/v1: el PADRÓN de la comunidad — quién vive, posee o arrienda,
// tenga o no cuenta en la plataforma (user_id nace siempre NULL).
//
// NO es el control de acceso. Quién VE la comunidad lo sigue decidiendo, en
// exclusiva, community-members/v1 (ruta /communities/:communityId/access, tabla
// community.community_members, permisos `community_members.*`). Dar de alta a
// alguien aquí no le concede visibilidad de nada; por eso son dos recursos con
// dos permisos, y no una sola pantalla que hiciera ambas cosas sin que se note.
//
// Tampoco lleva el ROL de la persona: owner/tenant/resident califica a la
// relación con una unidad concreta, y esa vive en unit-members/v1 (que también
// publica las unidades de una persona bajo /members/:memberId/units).
//
// TELÉFONOS: subrecurso /phones (0..N por persona, baja lógica independiente).
// Se autorizan con `members.*`: son datos de la persona, no un recurso con
// catálogo propio. El detalle del miembro ya incluye la lista completa, así
// que el subrecurso solo necesita alta y baja.

/** Cuerpo del PATCH → UpdateMemberInput (ausente = "no tocar"; null en
 *  anulables = "limpiar"). El teléfono ya no viaja aquí: vive en /phones. */
function toUpdateInput(body: {
  fullName?: string | null;
  email?: string | null;
  notes?: string | null;
  status?: string | null;
}): UpdateMemberInput {
  return {
    ...(body.fullName !== null && body.fullName !== undefined && { fullName: body.fullName }),
    ...(body.status !== null && body.status !== undefined && { status: body.status }),
    // Anulables: se incluyen aunque sean null (null = limpiar).
    ...(body.email !== undefined && { email: body.email }),
    ...(body.notes !== undefined && { notes: body.notes }),
  };
}

export async function membersV1Routes(instance: FastifyInstance): Promise<void> {
  const app = instance.withTypeProvider<StructureVerifierTypeProvider>();

  // Listar (paginado)
  app.get(
    "/communities/:communityId/members",
    {
      schema: {
        params: communityIdParamV1V,
        querystring: listMembersQueryV1V,
        response: { 200: memberListV1V, 404: errorResponseV1V },
      },
      preHandler: [requirePermission(PERMISSIONS.membersRead), requireCommunityAccess()],
    },
    async (req, reply) => {
      const q = req.query;
      const { items, total } = await membersController.list(req, {
        communityId: req.params.communityId,
        page: q.page,
        pageSize: q.pageSize,
        search: q.search ?? null,
      });
      return reply.code(200).send({ items, total, page: q.page, pageSize: q.pageSize });
    },
  );

  // Obtener una (detalle con teléfonos)
  app.get(
    "/communities/:communityId/members/:id",
    {
      schema: {
        params: communityScopedIdParamV1V,
        response: { 200: memberDetailV1V, 404: errorResponseV1V },
      },
      preHandler: [requirePermission(PERMISSIONS.membersRead), requireCommunityAccess()],
    },
    async (req, reply) => {
      const found = await membersController.getById(req, req.params.communityId, req.params.id);
      if (found === null) {
        return reply.code(404).send({ error: "not_found", message: null });
      }
      return reply.code(200).send(found);
    },
  );

  // Registrar
  app.post(
    "/communities/:communityId/members",
    {
      schema: {
        params: communityIdParamV1V,
        body: createMemberV1V,
        response: {
          201: memberDetailV1V,
          400: errorResponseV1V,
          404: errorResponseV1V,
          409: errorResponseV1V,
        },
      },
      preHandler: [requirePermission(PERMISSIONS.membersCreate), requireCommunityAccess()],
    },
    async (req, reply) => {
      const b = req.body;
      const result = await membersController.create(req, req.params.communityId, {
        fullName: b.fullName,
        phone: b.phone ?? null,
        email: b.email ?? null,
        notes: b.notes ?? null,
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
    "/communities/:communityId/members/:id",
    {
      schema: {
        params: communityScopedIdParamV1V,
        body: updateMemberV1V,
        response: {
          200: memberDetailV1V,
          400: errorResponseV1V,
          404: errorResponseV1V,
          409: errorResponseV1V,
        },
      },
      preHandler: [requirePermission(PERMISSIONS.membersUpdate), requireCommunityAccess()],
    },
    async (req, reply) => {
      const result = await membersController.update(
        req,
        req.params.communityId,
        req.params.id,
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

  // Baja lógica (arrastra teléfonos y asignaciones de unidad vigentes)
  app.delete(
    "/communities/:communityId/members/:id",
    {
      // Baja lógica → se autoriza con `.update`.
      schema: { params: communityScopedIdParamV1V },
      preHandler: [requirePermission(PERMISSIONS.membersUpdate), requireCommunityAccess()],
    },
    async (req, reply) => {
      const deleted = await membersController.softDelete(
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

  // Agregar teléfono
  app.post(
    "/communities/:communityId/members/:memberId/phones",
    {
      // Editar los datos de la persona → `.update` (igual que el PATCH).
      schema: {
        params: communityMemberParamV1V,
        body: createMemberPhoneV1V,
        response: {
          201: memberPhoneV1V,
          400: errorResponseV1V,
          404: errorResponseV1V,
          409: errorResponseV1V,
        },
      },
      preHandler: [requirePermission(PERMISSIONS.membersUpdate), requireCommunityAccess()],
    },
    async (req, reply) => {
      const result = await membersController.addPhone(
        req,
        req.params.communityId,
        req.params.memberId,
        { phone: req.body.phone, label: req.body.label ?? null },
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

  // Dar de baja un teléfono (baja lógica)
  app.delete(
    "/communities/:communityId/members/:memberId/phones/:id",
    {
      schema: { params: communityMemberScopedIdParamV1V },
      preHandler: [requirePermission(PERMISSIONS.membersUpdate), requireCommunityAccess()],
    },
    async (req, reply) => {
      const deleted = await membersController.removePhone(
        req,
        req.params.communityId,
        req.params.memberId,
        req.params.id,
      );
      if (!deleted) {
        return reply.code(404).send({ error: "not_found", message: null });
      }
      return reply.code(204).send();
    },
  );
}
