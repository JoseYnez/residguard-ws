import type { FastifyInstance } from "fastify";
import type { StructureVerifierTypeProvider } from "structure-verifier/fastify";
import { requireCommunityAccess, requireUnitAccess } from "../../../core/auth/community_access";
import { PERMISSIONS } from "../../../core/auth/permissions";
import { requirePermission } from "../../../core/auth/require_permission";
import {
  communityIdParamV1V,
  communityMemberParamV1V,
  communityMemberScopedIdParamV1V,
  unitIdParamV1V,
  unitScopedIdParamV1V,
} from "../../common/common_v1.verifier";
import { unitMembersController } from "./unit_members_v1.controller";
import {
  assignMemberUnitV1V,
  directoryListV1V,
  errorResponseV1V,
  listDirectoryQueryV1V,
  listMemberUnitsQueryV1V,
  listUnitMembersQueryV1V,
  memberUnitListV1V,
  memberUnitV1V,
  unitMemberListV1V,
  unitMemberV1V,
  updateMemberUnitV1V,
} from "./unit_members_v1.verifier";

// Recurso unit-members/v1: la relación PURA persona↔unidad (member_id apunta
// al padrón; los datos de la persona ya no se duplican aquí). Un miembro puede
// tener 1..N unidades de su comunidad, con un rol por unidad.
//
// Dos superficies sobre la misma tabla:
//   * /units/:unitId/members — SOLO LECTURA: quiénes están en la unidad, con
//     nombre y contacto resueltos desde el padrón.
//   * /communities/:communityId/members/:memberId/units — el CRUD: la pantalla
//     de Miembros es la única superficie de gestión (asignar, cambiar rol,
//     quitar). Alcance por comunidad; el miembro inexistente responde 404.

export async function unitMembersV1Routes(instance: FastifyInstance): Promise<void> {
  const app = instance.withTypeProvider<StructureVerifierTypeProvider>();

  // --- Vista por unidad (solo lectura) ---------------------------------------

  // Listar miembros de la unidad (paginado)
  app.get(
    "/units/:unitId/members",
    {
      schema: {
        params: unitIdParamV1V,
        querystring: listUnitMembersQueryV1V,
        response: { 200: unitMemberListV1V, 404: errorResponseV1V },
      },
      preHandler: [requirePermission(PERMISSIONS.unitMembersRead), requireUnitAccess()],
    },
    async (req, reply) => {
      const q = req.query;
      const { items, total } = await unitMembersController.list(req, {
        unitId: req.params.unitId,
        page: q.page,
        pageSize: q.pageSize,
        search: q.search ?? null,
        memberType: q.memberType ?? null,
      });
      return reply.code(200).send({ items, total, page: q.page, pageSize: q.pageSize });
    },
  );

  // Obtener un miembro de la unidad
  app.get(
    "/units/:unitId/members/:id",
    {
      schema: {
        params: unitScopedIdParamV1V,
        response: { 200: unitMemberV1V, 404: errorResponseV1V },
      },
      preHandler: [requirePermission(PERMISSIONS.unitMembersRead), requireUnitAccess()],
    },
    async (req, reply) => {
      const found = await unitMembersController.getById(req, req.params.unitId, req.params.id);
      if (found === null) {
        return reply.code(404).send({ error: "not_found", message: null });
      }
      return reply.code(200).send(found);
    },
  );

  // El DIRECTORIO de contacto de la comunidad (paginado): cada asignación
  // vigente con su unidad (código/torre/dirección) y el contacto completo de
  // la persona (todos sus teléfonos activos). Es la vista de consulta "¿quién
  // está en la 426-A y cómo le llamo?" — solo lectura, mismo permiso de
  // lectura de la relación.
  app.get(
    "/communities/:communityId/directory",
    {
      schema: {
        params: communityIdParamV1V,
        querystring: listDirectoryQueryV1V,
        response: { 200: directoryListV1V, 404: errorResponseV1V },
      },
      preHandler: [requirePermission(PERMISSIONS.unitMembersRead), requireCommunityAccess()],
    },
    async (req, reply) => {
      const q = req.query;
      const { items, total } = await unitMembersController.listDirectory(req, {
        communityId: req.params.communityId,
        page: q.page,
        pageSize: q.pageSize,
        search: q.search ?? null,
      });
      return reply.code(200).send({ items, total, page: q.page, pageSize: q.pageSize });
    },
  );

  // --- Vista por miembro (CRUD) ----------------------------------------------

  // Unidades del miembro (paginado)
  app.get(
    "/communities/:communityId/members/:memberId/units",
    {
      schema: {
        params: communityMemberParamV1V,
        querystring: listMemberUnitsQueryV1V,
        response: { 200: memberUnitListV1V, 404: errorResponseV1V },
      },
      preHandler: [requirePermission(PERMISSIONS.unitMembersRead), requireCommunityAccess()],
    },
    async (req, reply) => {
      const q = req.query;
      const result = await unitMembersController.listByMember(req, {
        communityId: req.params.communityId,
        memberId: req.params.memberId,
        page: q.page,
        pageSize: q.pageSize,
      });
      if (result === null) {
        return reply.code(404).send({ error: "not_found", message: null });
      }
      return reply
        .code(200)
        .send({ items: result.items, total: result.total, page: q.page, pageSize: q.pageSize });
    },
  );

  // Asignar una unidad al miembro
  app.post(
    "/communities/:communityId/members/:memberId/units",
    {
      schema: {
        params: communityMemberParamV1V,
        body: assignMemberUnitV1V,
        response: {
          201: memberUnitV1V,
          400: errorResponseV1V,
          404: errorResponseV1V,
          409: errorResponseV1V,
        },
      },
      preHandler: [requirePermission(PERMISSIONS.unitMembersCreate), requireCommunityAccess()],
    },
    async (req, reply) => {
      const result = await unitMembersController.assign(
        req,
        req.params.communityId,
        req.params.memberId,
        { unitId: req.body.unitId, memberType: req.body.memberType },
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

  // Cambiar el rol de una asignación
  app.patch(
    "/communities/:communityId/members/:memberId/units/:id",
    {
      schema: {
        params: communityMemberScopedIdParamV1V,
        body: updateMemberUnitV1V,
        response: {
          200: memberUnitV1V,
          400: errorResponseV1V,
          404: errorResponseV1V,
        },
      },
      preHandler: [requirePermission(PERMISSIONS.unitMembersUpdate), requireCommunityAccess()],
    },
    async (req, reply) => {
      const updated = await unitMembersController.updateAssignment(
        req,
        req.params.communityId,
        req.params.memberId,
        req.params.id,
        req.body.memberType,
      );
      if (updated === null) {
        return reply.code(404).send({ error: "not_found", message: null });
      }
      return reply.code(200).send(updated);
    },
  );

  // Quitar la asignación (baja lógica)
  app.delete(
    "/communities/:communityId/members/:memberId/units/:id",
    {
      // Baja lógica → se autoriza con `.update`.
      schema: { params: communityMemberScopedIdParamV1V },
      preHandler: [requirePermission(PERMISSIONS.unitMembersUpdate), requireCommunityAccess()],
    },
    async (req, reply) => {
      const deleted = await unitMembersController.removeAssignment(
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
