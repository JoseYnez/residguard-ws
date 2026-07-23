import type { FastifyInstance } from "fastify";
import type { StructureVerifierTypeProvider } from "structure-verifier/fastify";
import { requireCommunityAccess } from "../../../core/auth/community_access";
import { PERMISSIONS } from "../../../core/auth/permissions";
import { requirePermission } from "../../../core/auth/require_permission";
import {
  communityIdParamV1V,
  communityScopedIdParamV1V,
} from "../../common/common_v1.verifier";
import { unitsController } from "./units_v1.controller";
import type { UpdateUnitInput } from "./units_v1.repository";
import {
  createUnitV1V,
  errorResponseV1V,
  listUnitsQueryV1V,
  unitListV1V,
  unitV1V,
  updateUnitV1V,
} from "./units_v1.verifier";

// Recurso units/v1: CRUD de unidades, SIEMPRE anidado bajo una comunidad del
// alcance del actor (/communities/:communityId/units). La baja es lógica
// (DELETE → status='deleted').

/** Cuerpo del PATCH → UpdateUnitInput (null en NOT NULL = "no tocar";
 *  null en anulables = "limpiar"). */
function toUpdateInput(body: {
  code?: string | null;
  tower?: string | null;
  number?: string | null;
  letter?: string | null;
  unitType?: string | null;
  address?: string | null;
  status?: string | null;
}): UpdateUnitInput {
  return {
    ...(body.code !== null && body.code !== undefined && { code: body.code }),
    ...(body.unitType !== null && body.unitType !== undefined && { unitType: body.unitType }),
    ...(body.status !== null && body.status !== undefined && { status: body.status }),
    // Anulables: se incluyen aunque sean null (null = limpiar).
    ...(body.tower !== undefined && { tower: body.tower }),
    ...(body.number !== undefined && { number: body.number }),
    ...(body.letter !== undefined && { letter: body.letter }),
    ...(body.address !== undefined && { address: body.address }),
  };
}

export async function unitsV1Routes(instance: FastifyInstance): Promise<void> {
  const app = instance.withTypeProvider<StructureVerifierTypeProvider>();

  // Listar (paginado)
  app.get(
    "/communities/:communityId/units",
    {
      schema: {
        params: communityIdParamV1V,
        querystring: listUnitsQueryV1V,
        response: { 200: unitListV1V, 404: errorResponseV1V },
      },
      preHandler: [requirePermission(PERMISSIONS.unitsRead), requireCommunityAccess()],
    },
    async (req, reply) => {
      const q = req.query;
      const { items, total } = await unitsController.list(req, {
        communityId: req.params.communityId,
        page: q.page,
        pageSize: q.pageSize,
        search: q.search ?? null,
        unitType: q.unitType ?? null,
        status: q.status ?? null,
      });
      return reply.code(200).send({ items, total, page: q.page, pageSize: q.pageSize });
    },
  );

  // Obtener una
  app.get(
    "/communities/:communityId/units/:id",
    {
      schema: {
        params: communityScopedIdParamV1V,
        response: { 200: unitV1V, 404: errorResponseV1V },
      },
      preHandler: [requirePermission(PERMISSIONS.unitsRead), requireCommunityAccess()],
    },
    async (req, reply) => {
      const found = await unitsController.getById(req, req.params.communityId, req.params.id);
      if (found === null) {
        return reply.code(404).send({ error: "not_found", message: null });
      }
      return reply.code(200).send(found);
    },
  );

  // Crear
  app.post(
    "/communities/:communityId/units",
    {
      schema: {
        params: communityIdParamV1V,
        body: createUnitV1V,
        response: {
          201: unitV1V,
          400: errorResponseV1V,
          404: errorResponseV1V,
          409: errorResponseV1V,
        },
      },
      preHandler: [requirePermission(PERMISSIONS.unitsCreate), requireCommunityAccess()],
    },
    async (req, reply) => {
      const b = req.body;
      const result = await unitsController.create(req, req.params.communityId, {
        code: b.code,
        tower: b.tower ?? null,
        number: b.number ?? null,
        letter: b.letter ?? null,
        unitType: b.unitType,
        address: b.address ?? null,
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
    "/communities/:communityId/units/:id",
    {
      schema: {
        params: communityScopedIdParamV1V,
        body: updateUnitV1V,
        response: {
          200: unitV1V,
          400: errorResponseV1V,
          404: errorResponseV1V,
          409: errorResponseV1V,
        },
      },
      preHandler: [requirePermission(PERMISSIONS.unitsUpdate), requireCommunityAccess()],
    },
    async (req, reply) => {
      const result = await unitsController.update(
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

  // Baja lógica
  app.delete(
    "/communities/:communityId/units/:id",
    {
      // La baja sigue siendo lógica (soft delete), pero se autoriza con su
      // propio `units.delete` — excepción a la convención general de `.update`.
      schema: { params: communityScopedIdParamV1V },
      preHandler: [requirePermission(PERMISSIONS.unitsDelete), requireCommunityAccess()],
    },
    async (req, reply) => {
      const deleted = await unitsController.softDelete(
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
