import type { FastifyInstance } from "fastify";
import type { StructureVerifierTypeProvider } from "structure-verifier/fastify";
import { requireUnitAccess } from "../../../core/auth/community_access";
import { PERMISSIONS } from "../../../core/auth/permissions";
import { requirePermission } from "../../../core/auth/require_permission";
import { unitIdParamV1V, unitScopedIdParamV1V } from "../../common/common_v1.verifier";
import { unitMembersController } from "./unit_members_v1.controller";
import type { UpdateUnitMemberInput } from "./unit_members_v1.repository";
import {
  createUnitMemberV1V,
  errorResponseV1V,
  listUnitMembersQueryV1V,
  unitMemberListV1V,
  unitMemberV1V,
  updateUnitMemberV1V,
} from "./unit_members_v1.verifier";

// Recurso unit-members/v1: personas asociadas a una unidad (propietario,
// arrendatario, residente), anidado bajo /units/:unitId. La persona puede no
// estar registrada aún en la plataforma (userId null = relación simulada).

/** Cuerpo del PATCH → UpdateUnitMemberInput (null en NOT NULL = "no tocar";
 *  null en anulables = "limpiar"). */
function toUpdateInput(body: {
  memberType?: string | null;
  fullName?: string | null;
  phone?: string | null;
  email?: string | null;
  userId?: string | null;
  status?: string | null;
}): UpdateUnitMemberInput {
  return {
    ...(body.memberType !== null && body.memberType !== undefined && { memberType: body.memberType }),
    ...(body.fullName !== null && body.fullName !== undefined && { fullName: body.fullName }),
    ...(body.status !== null && body.status !== undefined && { status: body.status }),
    // Anulables: se incluyen aunque sean null (null = limpiar).
    ...(body.phone !== undefined && { phone: body.phone }),
    ...(body.email !== undefined && { email: body.email }),
    ...(body.userId !== undefined && { userId: body.userId }),
  };
}

export async function unitMembersV1Routes(instance: FastifyInstance): Promise<void> {
  const app = instance.withTypeProvider<StructureVerifierTypeProvider>();

  // Listar (paginado)
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

  // Obtener uno
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

  // Crear
  app.post(
    "/units/:unitId/members",
    {
      schema: {
        params: unitIdParamV1V,
        body: createUnitMemberV1V,
        response: {
          201: unitMemberV1V,
          400: errorResponseV1V,
          404: errorResponseV1V,
          409: errorResponseV1V,
        },
      },
      preHandler: [requirePermission(PERMISSIONS.unitMembersCreate), requireUnitAccess()],
    },
    async (req, reply) => {
      const b = req.body;
      const result = await unitMembersController.create(req, req.params.unitId, {
        memberType: b.memberType,
        fullName: b.fullName,
        phone: b.phone ?? null,
        email: b.email ?? null,
        userId: b.userId ?? null,
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
    "/units/:unitId/members/:id",
    {
      schema: {
        params: unitScopedIdParamV1V,
        body: updateUnitMemberV1V,
        response: {
          200: unitMemberV1V,
          400: errorResponseV1V,
          404: errorResponseV1V,
          409: errorResponseV1V,
        },
      },
      preHandler: [requirePermission(PERMISSIONS.unitMembersUpdate), requireUnitAccess()],
    },
    async (req, reply) => {
      const result = await unitMembersController.update(
        req,
        req.params.unitId,
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

  // Baja lógica
  app.delete(
    "/units/:unitId/members/:id",
    {
      // Baja lógica → se autoriza con `.update`.
      schema: { params: unitScopedIdParamV1V },
      preHandler: [requirePermission(PERMISSIONS.unitMembersUpdate), requireUnitAccess()],
    },
    async (req, reply) => {
      const deleted = await unitMembersController.softDelete(
        req,
        req.params.unitId,
        req.params.id,
      );
      if (!deleted) {
        return reply.code(404).send({ error: "not_found", message: null });
      }
      return reply.code(204).send();
    },
  );
}
