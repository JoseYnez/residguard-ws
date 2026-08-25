import type { FastifyInstance } from "fastify";
import type { StructureVerifierTypeProvider } from "structure-verifier/fastify";
import { config } from "../../../config";
import { requireCommunityAccess } from "../../../core/auth/community_access";
import { PERMISSIONS } from "../../../core/auth/permissions";
import { requirePermission } from "../../../core/auth/require_permission";
import {
    communityIdParamV1V,
    communityScopedIdParamV1V,
} from "../../common/common_v1.verifier";
import { visitsController } from "./visits_v1.controller";
import {
    checkInVisitV1V,
    checkOutVisitV1V,
    errorResponseV1V,
    listVisitsQueryV1V,
    visitCodeParamV1V,
    visitDetailV1V,
    visitEventFileLinkV1V,
    visitEventFileParamV1V,
    visitListV1V,
    visitVerdictV1V,
} from "./visits_v1.verifier";

// Recurso visits/v1: el lado de la OPERACIÓN del registro previo de visitas —
// la bitácora de la comunidad y la caseta. Alcance por comunidad
// (requireCommunityAccess), a diferencia de /me/visits, que resuelve la
// pertenencia por el vínculo del padrón.
//
// SIN alta: en esta versión el pase nace SOLO del residente (por eso no existe
// `visits.create` en el catálogo). El operador consulta; el vigilante abre.
//
// LA CASETA SON DOS PASOS, a propósito:
//   GET  .../visits/by-code/:code   resuelve y da el veredicto — NO consume
//   POST .../visits/:id/entries     registra la entrada
// Fundirlos en uno haría que un escaneo accidental gastara una entrada del
// pase, y le quitaría al guardia la pantalla de confirmación que necesita para
// cotejar a quién espera la unidad.

export async function visitsV1Routes(instance: FastifyInstance): Promise<void> {
    const app = instance.withTypeProvider<StructureVerifierTypeProvider>();

    // Bitácora de pases de la comunidad (paginada).
    app.get(
        "/communities/:communityId/visits",
        {
            schema: {
                params: communityIdParamV1V,
                querystring: listVisitsQueryV1V,
                response: { 200: visitListV1V, 404: errorResponseV1V },
            },
            preHandler: [requirePermission(PERMISSIONS.visitsRead), requireCommunityAccess()],
        },
        async (req, reply) => {
            const q = req.query;
            const { items, total } = await visitsController.list(req, {
                communityId: req.params.communityId,
                page: q.page,
                pageSize: q.pageSize,
                unitId: q.unitId ?? null,
                search: q.search ?? null,
                state: q.state ?? null,
                visitType: q.visitType ?? null,
            });
            return reply.code(200).send({ items, total, page: q.page, pageSize: q.pageSize });
        },
    );

    // Detalle de un pase + su bitácora de entradas y salidas.
    app.get(
        "/communities/:communityId/visits/:id",
        {
            schema: {
                params: communityScopedIdParamV1V,
                response: { 200: visitDetailV1V, 404: errorResponseV1V },
            },
            preHandler: [requirePermission(PERMISSIONS.visitsRead), requireCommunityAccess()],
        },
        async (req, reply) => {
            const found = await visitsController.getById(
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

    // Caseta, paso 1: resolver el código. NO consume nada.
    //
    // Un pase cancelado, vencido o fuera de horario responde 200 con
    // `valid: false` y su razón — el guardia tiene que poder explicarle al
    // visitante qué pasó, y un 404 lo dejaría adivinando. Solo el código que no
    // existe en esta comunidad es 404.
    app.get(
        "/communities/:communityId/visits/by-code/:code",
        {
            schema: {
                params: visitCodeParamV1V,
                response: { 200: visitVerdictV1V, 404: errorResponseV1V },
            },
            preHandler: [requirePermission(PERMISSIONS.visitsRead), requireCommunityAccess()],
        },
        async (req, reply) => {
            const found = await visitsController.findByCode(
                req,
                req.params.communityId,
                req.params.code,
            );
            if (found === null) {
                return reply.code(404).send({ error: "not_found", message: null });
            }
            return reply.code(200).send({
                visit: found.visit,
                valid: found.verdict === "ok",
                reason: found.verdict,
                timezone: config.dbTimezone,
                contacts: found.contacts,
            });
        },
    );

    // Caseta, paso 2: registrar la entrada.
    //
    // El servidor RE-VALIDA con el pase bloqueado y nunca confía en el veredicto
    // que el guardia vio en pantalla: entre la consulta y el toque al botón el
    // residente pudo cancelar. Si ya no procede → 409 con la razón (el actor ve
    // el pase, pero no puede consumirlo ahora).
    //
    // 400 = la regla de evidencia: la entrada exige al menos una foto o el
    // motivo de registrarla sin ella (nunca ninguno, nunca ambos), y las fotos
    // deben existir en storage y ser imágenes.
    app.post(
        "/communities/:communityId/visits/:id/entries",
        {
            schema: {
                params: communityScopedIdParamV1V,
                body: checkInVisitV1V,
                response: {
                    201: visitVerdictV1V,
                    400: errorResponseV1V,
                    404: errorResponseV1V,
                    409: visitVerdictV1V,
                },
            },
            preHandler: [requirePermission(PERMISSIONS.visitsCheckin), requireCommunityAccess()],
        },
        async (req, reply) => {
            const b = req.body;
            const result = await visitsController.checkIn(
                req,
                req.params.communityId,
                req.params.id,
                {
                    visitorName: b.visitorName ?? null,
                    visitorDocument: b.visitorDocument ?? null,
                    companions: b.companions ?? null,
                    vehiclePlate: b.vehiclePlate ?? null,
                    gate: b.gate ?? null,
                    notes: b.notes ?? null,
                    fileIds: b.fileIds ?? [],
                    noEvidenceReason: b.noEvidenceReason ?? null,
                },
            );
            if (result === null) {
                return reply.code(404).send({ error: "not_found", message: null });
            }
            if (!result.ok) {
                return reply
                    .code(400)
                    .send({ error: result.error.kind, message: result.error.message });
            }
            const verdict = result.value;
            const payload = {
                visit: verdict.visit,
                valid: verdict.verdict === "ok",
                reason: verdict.verdict,
                timezone: config.dbTimezone,
                contacts: verdict.contacts,
            };
            return reply.code(verdict.verdict === "ok" ? 201 : 409).send(payload);
        },
    );

    // Enlace firmado de descarga de una foto de la bitácora. `visits.read`,
    // como todo lo que solo MUESTRA: quien puede leer la bitácora puede ver su
    // evidencia. El enlace vence solo (STORAGE_LINK_TTL_SEC) y la SPA lo pide
    // al momento de mostrar, nunca lo almacena.
    app.get(
        "/communities/:communityId/visits/:id/events/:eventId/files/:fileId/link",
        {
            schema: {
                params: visitEventFileParamV1V,
                response: {
                    200: visitEventFileLinkV1V,
                    404: errorResponseV1V,
                    503: errorResponseV1V,
                },
            },
            preHandler: [requirePermission(PERMISSIONS.visitsRead), requireCommunityAccess()],
        },
        async (req, reply) => {
            const link = await visitsController.eventFileLink(
                req,
                req.params.communityId,
                req.params.id,
                req.params.eventId,
                req.params.fileId,
            );
            if (link === "not_found") {
                return reply.code(404).send({ error: "not_found", message: null });
            }
            if (link === "unavailable") {
                return reply.code(503).send({
                    error: "storage_unavailable",
                    message: "El almacén de archivos no respondió. Intenta de nuevo.",
                });
            }
            return reply.code(200).send(link);
        },
    );

    // Caseta, el otro lado del mismo paso: registrar la SALIDA.
    //
    // Sin permiso propio: quien puede abrir para que alguien entre puede
    // registrar que se fue. Un código nuevo obligaría a tocar el catálogo de la
    // plataforma para autorizar la mitad menos delicada de la operación —y a
    // re-sembrarlo en producción— sin cerrar ninguna puerta que `visits.checkin`
    // no cierre ya.
    //
    // 409 = el pase existe pero no tiene una entrada abierta (nunca llegó, o ya
    // se registró su salida). Se responde con el pase completo, igual que el
    // check-in, para que la caseta muestre de qué pase habla.
    app.post(
        "/communities/:communityId/visits/:id/exits",
        {
            schema: {
                params: communityScopedIdParamV1V,
                body: checkOutVisitV1V,
                response: {
                    201: visitVerdictV1V,
                    404: errorResponseV1V,
                    409: visitVerdictV1V,
                },
            },
            preHandler: [requirePermission(PERMISSIONS.visitsCheckin), requireCommunityAccess()],
        },
        async (req, reply) => {
            const b = req.body;
            const result = await visitsController.checkOut(
                req,
                req.params.communityId,
                req.params.id,
                { gate: b.gate ?? null, notes: b.notes ?? null },
            );
            if (result === null) {
                return reply.code(404).send({ error: "not_found", message: null });
            }
            // `valid` sigue siendo el veredicto de ENTRADA del pase, no el de
            // esta operación: la salida no lo consulta. Un pase que venció con
            // el visitante adentro sale con `valid: false` y su salida quedó
            // registrada igual — que es justo lo que tenía que pasar.
            const payload = {
                visit: result.value.visit,
                valid: result.value.verdict === "ok",
                reason: result.value.verdict,
                timezone: config.dbTimezone,
                contacts: result.value.contacts,
            };
            return reply.code(result.recorded ? 201 : 409).send(payload);
        },
    );
}
