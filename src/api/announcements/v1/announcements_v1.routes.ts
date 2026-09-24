import type { FastifyInstance } from "fastify";
import type { StructureVerifierTypeProvider } from "structure-verifier/fastify";
import { requireCommunityAccess } from "../../../core/auth/community_access";
import { PERMISSIONS } from "../../../core/auth/permissions";
import { requirePermission } from "../../../core/auth/require_permission";
import {
    communityIdParamV1V,
    communityScopedIdParamV1V,
} from "../../common/common_v1.verifier";
import { announcementsController } from "./announcements_v1.controller";
import {
    announcementDetailV1V,
    announcementFileLinkV1V,
    announcementFileParamV1V,
    announcementListV1V,
    announcementReaderListV1V,
    audienceGroupListV1V,
    audienceGroupV1V,
    audiencePreviewQueryV1V,
    audiencePreviewV1V,
    createAnnouncementV1V,
    createAudienceGroupV1V,
    errorResponseV1V,
    listAnnouncementsQueryV1V,
    listAudienceGroupsQueryV1V,
    listReadersQueryV1V,
    updateAnnouncementV1V,
    updateAudienceGroupV1V,
} from "./announcements_v1.verifier";

// Recurso announcements/v1: los COMUNICADOS del lado de la operación —
// redactar, publicar, ver quién leyó— y los GRUPOS DE AUDIENCIA con los que se
// elige a quién van. Todo anidado bajo /communities/:communityId con
// requireCommunityAccess(); el portal del residente vive en me/v1 y comparte
// con este recurso la definición de la audiencia (AUDIENCE_MATCH del
// repositorio), igual que las dos superficies de visitas.
//
// Los grupos NO tienen pantalla propia (son una pestaña de comunicados) pero sí
// permisos propios: definir audiencias y escribir son atribuciones distintas.

/** Lista separada por comas del querystring → arreglo, o null si viene vacía.
 *  La vista previa se pide ANTES de guardar nada, así que la regla viaja suelta
 *  en la URL en vez de en un cuerpo. */
function parseList(raw: string | null | undefined): string[] | null {
    if (raw === null || raw === undefined) {
        return null;
    }
    const items = raw
        .split(",")
        .map((item) => item.trim())
        .filter((item) => item.length > 0);
    return items.length === 0 ? null : items;
}

export async function announcementsV1Routes(instance: FastifyInstance): Promise<void> {
    const app = instance.withTypeProvider<StructureVerifierTypeProvider>();

    // ─── Grupos de audiencia ────────────────────────────────────────────────
    // Van ANTES que /announcements/:id porque Fastify enruta por prefijo y
    // `audience-groups` no debe caer nunca en el parámetro `:id`.

    app.get(
        "/communities/:communityId/audience-groups",
        {
            schema: {
                params: communityIdParamV1V,
                querystring: listAudienceGroupsQueryV1V,
                response: { 200: audienceGroupListV1V, 404: errorResponseV1V },
            },
            preHandler: [
                requirePermission(PERMISSIONS.audienceGroupsRead),
                requireCommunityAccess(),
            ],
        },
        async (req, reply) => {
            const q = req.query;
            const result = await announcementsController.listGroups(req, {
                communityId: req.params.communityId,
                page: q.page,
                pageSize: q.pageSize,
                status: q.status ?? null,
            });
            return reply.code(200).send({
                items: result.items,
                total: result.total,
                page: q.page,
                pageSize: q.pageSize,
                towers: result.towers,
            });
        },
    );

    // Vista previa de una regla ANTES de guardarla: "llega a 12 personas, 5 con
    // cuenta". La cifra que evita publicar al vacío.
    app.get(
        "/communities/:communityId/audience-groups/preview",
        {
            schema: {
                params: communityIdParamV1V,
                querystring: audiencePreviewQueryV1V,
                response: { 200: audiencePreviewV1V, 404: errorResponseV1V },
            },
            preHandler: [
                requirePermission(PERMISSIONS.audienceGroupsRead),
                requireCommunityAccess(),
            ],
        },
        async (req, reply) => {
            const reach = await announcementsController.previewAudience(
                req,
                req.params.communityId,
                {
                    memberTypes: parseList(req.query.memberTypes),
                    towers: parseList(req.query.towers),
                },
            );
            return reply.code(200).send(reach);
        },
    );

    app.get(
        "/communities/:communityId/audience-groups/:id",
        {
            schema: {
                params: communityScopedIdParamV1V,
                response: { 200: audienceGroupV1V, 404: errorResponseV1V },
            },
            preHandler: [
                requirePermission(PERMISSIONS.audienceGroupsRead),
                requireCommunityAccess(),
            ],
        },
        async (req, reply) => {
            const found = await announcementsController.getGroupById(
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

    app.post(
        "/communities/:communityId/audience-groups",
        {
            schema: {
                params: communityIdParamV1V,
                body: createAudienceGroupV1V,
                response: {
                    201: audienceGroupV1V,
                    400: errorResponseV1V,
                    404: errorResponseV1V,
                    409: errorResponseV1V,
                },
            },
            preHandler: [
                requirePermission(PERMISSIONS.audienceGroupsCreate),
                requireCommunityAccess(),
            ],
        },
        async (req, reply) => {
            const b = req.body;
            const result = await announcementsController.createGroup(req, req.params.communityId, {
                name: b.name,
                description: b.description ?? null,
                memberTypes: b.memberTypes ?? null,
                towers: b.towers ?? null,
            });
            if (!result.ok) {
                const status = result.error.kind === "conflict" ? 409 : 400;
                return reply
                    .code(status)
                    .send({ error: result.error.kind, message: result.error.message });
            }
            return reply.code(201).send(result.value);
        },
    );

    app.patch(
        "/communities/:communityId/audience-groups/:id",
        {
            schema: {
                params: communityScopedIdParamV1V,
                body: updateAudienceGroupV1V,
                response: {
                    200: audienceGroupV1V,
                    400: errorResponseV1V,
                    404: errorResponseV1V,
                    409: errorResponseV1V,
                },
            },
            preHandler: [
                requirePermission(PERMISSIONS.audienceGroupsUpdate),
                requireCommunityAccess(),
            ],
        },
        async (req, reply) => {
            const b = req.body;
            const result = await announcementsController.updateGroup(
                req,
                req.params.communityId,
                req.params.id,
                {
                    ...(b.name !== null && b.name !== undefined && { name: b.name }),
                    ...(b.description !== undefined && { description: b.description }),
                    // Los criterios SÍ admiten null: es "quitar este filtro".
                    ...(b.memberTypes !== undefined && { memberTypes: b.memberTypes }),
                    ...(b.towers !== undefined && { towers: b.towers }),
                    ...(b.status !== null && b.status !== undefined && { status: b.status }),
                },
            );
            if (result === null) {
                return reply.code(404).send({ error: "not_found", message: null });
            }
            if (!result.ok) {
                const status = result.error.kind === "conflict" ? 409 : 400;
                return reply
                    .code(status)
                    .send({ error: result.error.kind, message: result.error.message });
            }
            return reply.code(200).send(result.value);
        },
    );

    // Baja lógica → se autoriza con `.update`.
    app.delete(
        "/communities/:communityId/audience-groups/:id",
        {
            schema: { params: communityScopedIdParamV1V },
            preHandler: [
                requirePermission(PERMISSIONS.audienceGroupsUpdate),
                requireCommunityAccess(),
            ],
        },
        async (req, reply) => {
            const outcome = await announcementsController.softDeleteGroup(
                req,
                req.params.communityId,
                req.params.id,
            );
            if (outcome === "not_found") {
                return reply.code(404).send({ error: "not_found", message: null });
            }
            if (outcome !== "deleted") {
                const n = outcome.draftsUsing;
                return reply.code(409).send({
                    error: "conflict",
                    message:
                        (n === 1
                            ? "Un borrador usa este grupo"
                            : `${n} borradores usan este grupo`) +
                        ": cámbiales la audiencia o elimínalos antes de borrarlo. " +
                        "Sin grupo irían a «Todos». Si solo quieres dejar de ofrecerlo, desactívalo.",
                });
            }
            return reply.code(204).send();
        },
    );

    // ─── Comunicados ────────────────────────────────────────────────────────

    app.get(
        "/communities/:communityId/announcements",
        {
            schema: {
                params: communityIdParamV1V,
                querystring: listAnnouncementsQueryV1V,
                response: { 200: announcementListV1V, 404: errorResponseV1V },
            },
            preHandler: [
                requirePermission(PERMISSIONS.announcementsRead),
                requireCommunityAccess(),
            ],
        },
        async (req, reply) => {
            const q = req.query;
            const { items, total } = await announcementsController.list(req, {
                communityId: req.params.communityId,
                page: q.page,
                pageSize: q.pageSize,
                publicationStatus: q.publicationStatus ?? null,
                search: q.q ?? null,
            });
            return reply.code(200).send({ items, total, page: q.page, pageSize: q.pageSize });
        },
    );

    app.get(
        "/communities/:communityId/announcements/:id",
        {
            schema: {
                params: communityScopedIdParamV1V,
                response: { 200: announcementDetailV1V, 404: errorResponseV1V },
            },
            preHandler: [
                requirePermission(PERMISSIONS.announcementsRead),
                requireCommunityAccess(),
            ],
        },
        async (req, reply) => {
            const found = await announcementsController.getById(
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

    // Quién leyó y quién falta. Habla de CUENTAS: las personas del padrón sin
    // usuario de plataforma no pueden leer nada y por eso no salen aquí — su
    // número está en `audiencePeople` del detalle, para que "3 de 5" no se lea
    // como alcance total.
    app.get(
        "/communities/:communityId/announcements/:id/reads",
        {
            schema: {
                params: communityScopedIdParamV1V,
                querystring: listReadersQueryV1V,
                response: { 200: announcementReaderListV1V, 404: errorResponseV1V },
            },
            preHandler: [
                requirePermission(PERMISSIONS.announcementsRead),
                requireCommunityAccess(),
            ],
        },
        async (req, reply) => {
            const q = req.query;
            const result = await announcementsController.listReaders(req, {
                communityId: req.params.communityId,
                id: req.params.id,
                filter: q.filter === "read" || q.filter === "unread" ? q.filter : null,
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

    // Enlace firmado de un adjunto. La descarga NO va directa a storage: el
    // RBAC de storage es por app, no por recurso — la frontera por comunicado
    // vive aquí (mismo patrón que evidencias y fotos de caseta).
    app.get(
        "/communities/:communityId/announcements/:id/files/:fileId/link",
        {
            schema: {
                params: announcementFileParamV1V,
                response: {
                    200: announcementFileLinkV1V,
                    404: errorResponseV1V,
                    503: errorResponseV1V,
                },
            },
            preHandler: [
                requirePermission(PERMISSIONS.announcementsRead),
                requireCommunityAccess(),
            ],
        },
        async (req, reply) => {
            const link = await announcementsController.fileLink(
                req,
                req.params.communityId,
                req.params.id,
                req.params.fileId,
            );
            if (!link.ok) {
                if (link.reason === "not_found") {
                    return reply.code(404).send({ error: "not_found", message: null });
                }
                return reply
                    .code(503)
                    .send({ error: "storage_unavailable", message: link.message });
            }
            return reply.code(200).send({
                url: link.url,
                expiresAt: link.expiresAt,
                filename: link.filename,
                contentType: link.contentType,
            });
        },
    );

    // Siempre nace BORRADOR: publicar es otra ruta y otro permiso.
    app.post(
        "/communities/:communityId/announcements",
        {
            schema: {
                params: communityIdParamV1V,
                body: createAnnouncementV1V,
                response: {
                    201: announcementDetailV1V,
                    400: errorResponseV1V,
                    404: errorResponseV1V,
                    409: errorResponseV1V,
                },
            },
            preHandler: [
                requirePermission(PERMISSIONS.announcementsCreate),
                requireCommunityAccess(),
            ],
        },
        async (req, reply) => {
            const b = req.body;
            const result = await announcementsController.create(req, req.params.communityId, {
                title: b.title,
                body: b.body,
                audienceGroupId: b.audienceGroupId ?? null,
                isPinned: b.isPinned ?? false,
                fileIds: b.fileIds ?? [],
            });
            if (!result.ok) {
                const status = result.error.kind === "conflict" ? 409 : 400;
                return reply
                    .code(status)
                    .send({ error: result.error.kind, message: result.error.message });
            }
            return reply.code(201).send(result.value);
        },
    );

    app.patch(
        "/communities/:communityId/announcements/:id",
        {
            schema: {
                params: communityScopedIdParamV1V,
                body: updateAnnouncementV1V,
                response: {
                    200: announcementDetailV1V,
                    400: errorResponseV1V,
                    404: errorResponseV1V,
                    409: errorResponseV1V,
                },
            },
            preHandler: [
                requirePermission(PERMISSIONS.announcementsUpdate),
                requireCommunityAccess(),
            ],
        },
        async (req, reply) => {
            const b = req.body;
            const result = await announcementsController.update(
                req,
                req.params.communityId,
                req.params.id,
                {
                    ...(b.title !== null && b.title !== undefined && { title: b.title }),
                    ...(b.body !== null && b.body !== undefined && { body: b.body }),
                    // null es un valor válido: "Todos".
                    ...(b.audienceGroupId !== undefined && { audienceGroupId: b.audienceGroupId }),
                    ...(b.isPinned !== null && b.isPinned !== undefined && { isPinned: b.isPinned }),
                    ...(b.fileIds !== undefined && b.fileIds !== null && { fileIds: b.fileIds }),
                },
            );
            if (result === null) {
                return reply.code(404).send({ error: "not_found", message: null });
            }
            if (!result.ok) {
                const status = result.error.kind === "conflict" ? 409 : 400;
                return reply
                    .code(status)
                    .send({ error: result.error.kind, message: result.error.message });
            }
            return reply.code(200).send(result.value);
        },
    );

    // PUBLICAR: permiso propio (`execute`) porque dispara el push a toda la
    // audiencia y no se deshace. 409 si ya no era borrador — publicar dos veces
    // no manda dos avisos.
    app.post(
        "/communities/:communityId/announcements/:id/publish",
        {
            schema: {
                params: communityScopedIdParamV1V,
                response: {
                    200: announcementDetailV1V,
                    404: errorResponseV1V,
                    409: errorResponseV1V,
                },
            },
            preHandler: [
                requirePermission(PERMISSIONS.announcementsPublish),
                requireCommunityAccess(),
            ],
        },
        async (req, reply) => {
            const published = await announcementsController.publish(
                req,
                req.params.communityId,
                req.params.id,
            );
            if (published === null) {
                return reply.code(404).send({ error: "not_found", message: null });
            }
            if (!published) {
                return reply.code(409).send({
                    error: "conflict",
                    message: "El comunicado ya no es un borrador.",
                });
            }
            const detail = await announcementsController.getById(
                req,
                req.params.communityId,
                req.params.id,
            );
            return reply.code(200).send(detail!);
        },
    );

    // Archivar lo saca del portal del residente y lo conserva para el operador.
    // Es una edición del ciclo editorial → `.update`.
    app.post(
        "/communities/:communityId/announcements/:id/archive",
        {
            schema: {
                params: communityScopedIdParamV1V,
                response: {
                    200: announcementDetailV1V,
                    404: errorResponseV1V,
                    409: errorResponseV1V,
                },
            },
            preHandler: [
                requirePermission(PERMISSIONS.announcementsUpdate),
                requireCommunityAccess(),
            ],
        },
        async (req, reply) => {
            const archived = await announcementsController.archive(
                req,
                req.params.communityId,
                req.params.id,
            );
            if (archived === null) {
                return reply.code(404).send({ error: "not_found", message: null });
            }
            if (!archived) {
                return reply.code(409).send({
                    error: "conflict",
                    message: "Solo se archiva un comunicado publicado.",
                });
            }
            const detail = await announcementsController.getById(
                req,
                req.params.communityId,
                req.params.id,
            );
            return reply.code(200).send(detail!);
        },
    );

    // Baja lógica → se autoriza con `.update`.
    app.delete(
        "/communities/:communityId/announcements/:id",
        {
            schema: { params: communityScopedIdParamV1V },
            preHandler: [
                requirePermission(PERMISSIONS.announcementsUpdate),
                requireCommunityAccess(),
            ],
        },
        async (req, reply) => {
            const deleted = await announcementsController.softDelete(
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
