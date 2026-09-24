import type { FastifyRequest } from "fastify";
import { requireAuth } from "../../../core/auth/authenticate";
import { contextFor } from "../../../core/auth/community_access";
import { withTransaction, type TxClient } from "../../../core/db/with_transaction";
import { translatePgError, type MutationResult } from "../../../core/http/pg_errors";
import { storageClient, type StorageFileMetadata } from "../../../core/storage/storage_client";
import { announcementsNotifier } from "./announcements_v1.notifier";
import {
    announcementsRepository,
    type AnnouncementDetail,
    type AnnouncementReader,
    type AnnouncementSummary,
    type AudienceGroup,
    type AudienceReach,
    type AudienceRule,
    type ListAnnouncementsInput,
} from "./announcements_v1.repository";

// Orquestación de los comunicados. El acceso a la comunidad de la ruta ya lo
// garantizó requireCommunityAccess; el permiso, requirePermission.
//
// Tres decisiones viven aquí y no en la BD:
//   * La AUDIENCIA solo se toca en borrador (publicado = audiencia inmutable).
//   * Publicar es un UPDATE condicionado al estado: si otro publicó primero,
//     409 y ningún push repetido.
//   * El push sale DESPUÉS del commit y nunca se espera: un comunicado
//     publicado no puede deshacerse porque push-service esté caído.

const PG_MESSAGES = {
    conflict: "Ya existe un grupo de audiencia con ese nombre en la comunidad.",
    reference: "La comunidad o el grupo de audiencia no existen o están fuera de tu alcance.",
    check: "El grupo de audiencia necesita al menos un criterio (tipo de persona o torre).",
} as const;

/** Adjuntos: se validan uno por uno contra storage-service ANTES de guardar
 *  nada, y se espeja su metadata. Un id inventado no llega a la BD.
 *
 *  `kept` son los adjuntos que el comunicado YA tiene, por id de SU FILA: es el
 *  id que expone el detalle, así que al re-guardar la SPA devuelve esos ids y
 *  no los de storage. Se reusan con su metadata espejada, sin preguntar a
 *  storage por un id que allí no existe. */
async function resolveFiles(
    fileIds: readonly string[],
    kept: ReadonlyMap<string, StorageFileMetadata> = new Map(),
): Promise<{ ok: true; files: StorageFileMetadata[] } | { ok: false; message: string }> {
    const files: StorageFileMetadata[] = [];
    for (const fileId of fileIds) {
        const existing = kept.get(fileId);
        if (existing !== undefined) {
            files.push(existing);
            continue;
        }
        const result = await storageClient.getFile(fileId);
        if (!result.ok) {
            return {
                ok: false,
                message:
                    result.status === 404
                        ? "Uno de los archivos adjuntos no existe o ya no está disponible."
                        : `No se pudo validar el archivo adjunto: ${result.message}`,
            };
        }
        files.push(result.value);
    }
    return { ok: true, files };
}

/** La regla que se usa para contar y para avisar: la CONGELADA si ya se
 *  publicó; la del grupo mientras es borrador. */
async function ruleForReaders(
    tx: TxClient,
    communityId: string,
    announcement: AnnouncementSummary,
): Promise<AudienceRule> {
    if (announcement.publicationStatus !== "draft") {
        return {
            memberTypes: announcement.audienceMemberTypes,
            towers: announcement.audienceTowers,
        };
    }
    if (announcement.audienceGroupId === null) {
        return { memberTypes: null, towers: null };
    }
    const group = await announcementsRepository.getGroupById(
        tx,
        communityId,
        announcement.audienceGroupId,
    );
    return {
        memberTypes: group?.memberTypes ?? null,
        towers: group?.towers ?? null,
    };
}

export const announcementsController = {
    // ─── Comunicados ────────────────────────────────────────────────────────

    async list(
        req: FastifyRequest,
        input: ListAnnouncementsInput,
    ): Promise<{ items: AnnouncementSummary[]; total: number }> {
        return withTransaction(contextFor(req), (tx) => announcementsRepository.list(tx, input));
    },

    async getById(
        req: FastifyRequest,
        communityId: string,
        id: string,
    ): Promise<AnnouncementDetail | null> {
        return withTransaction(contextFor(req), (tx) =>
            announcementsRepository.getById(tx, communityId, id),
        );
    },

    async create(
        req: FastifyRequest,
        communityId: string,
        input: {
            title: string;
            body: string;
            audienceGroupId: string | null;
            isPinned: boolean;
            fileIds: readonly string[];
        },
    ): Promise<MutationResult<AnnouncementDetail>> {
        const claims = requireAuth(req);
        const resolved = await resolveFiles(input.fileIds);
        if (!resolved.ok) {
            return { ok: false, error: { kind: "invalid", message: resolved.message } };
        }
        try {
            const created = await withTransaction(contextFor(req), async (tx) => {
                const id = await announcementsRepository.create(tx, claims.customerId, communityId, {
                    title: input.title,
                    body: input.body,
                    audienceGroupId: input.audienceGroupId,
                    isPinned: input.isPinned,
                    files: resolved.files,
                });
                return announcementsRepository.getById(tx, communityId, id);
            });
            return { ok: true, value: created! };
        } catch (err) {
            return { ok: false, error: translatePgError(err, PG_MESSAGES) };
        }
    },

    /**
     * Edición parcial. La AUDIENCIA solo se admite en borrador: después de
     * publicar, a quién iba el comunicado es historia y no se reescribe (§2 del
     * plan). Cambiar título/cuerpo/adjuntos sí se puede —son erratas— y estampa
     * `edited_at` sin volver a avisar.
     *
     * `null` = no existe (404); `{ok:false}` = petición inválida.
     */
    async update(
        req: FastifyRequest,
        communityId: string,
        id: string,
        input: {
            title?: string;
            body?: string;
            audienceGroupId?: string | null;
            isPinned?: boolean;
            fileIds?: readonly string[];
        },
    ): Promise<MutationResult<AnnouncementDetail> | null> {
        const claims = requireAuth(req);
        const kept =
            input.fileIds === undefined
                ? new Map<string, StorageFileMetadata>()
                : await withTransaction(contextFor(req), (tx) =>
                      announcementsRepository.keptFiles(tx, communityId, id),
                  );
        const resolved =
            input.fileIds === undefined
                ? ({ ok: true, files: [] } as const)
                : await resolveFiles(input.fileIds, kept);
        if (!resolved.ok) {
            return { ok: false, error: { kind: "invalid", message: resolved.message } };
        }
        try {
            const result = await withTransaction(contextFor(req), async (tx) => {
                const current = await announcementsRepository.getById(tx, communityId, id);
                if (current === null) {
                    return null;
                }
                // Solo un CAMBIO se rechaza: re-enviar la misma audiencia (un
                // PATCH que manda el comunicado entero) no reescribe nada.
                if (
                    input.audienceGroupId !== undefined &&
                    input.audienceGroupId !== current.audienceGroupId &&
                    current.publicationStatus !== "draft"
                ) {
                    return {
                        ok: false as const,
                        error: {
                            kind: "invalid" as const,
                            message:
                                "La audiencia de un comunicado publicado no se puede cambiar. " +
                                "Archívalo y publica uno nuevo si tiene que ir a otra gente.",
                        },
                    };
                }
                await announcementsRepository.update(tx, communityId, id, input);
                if (input.fileIds !== undefined) {
                    await announcementsRepository.replaceFiles(
                        tx,
                        claims.customerId,
                        id,
                        resolved.files,
                    );
                }
                const updated = await announcementsRepository.getById(tx, communityId, id);
                return { ok: true as const, value: updated! };
            });
            return result;
        } catch (err) {
            return { ok: false, error: translatePgError(err, PG_MESSAGES) };
        }
    },

    /**
     * draft → published: congela la audiencia, y DESPUÉS del commit dispara el
     * aviso push a las cuentas que casan con esa regla.
     *
     * Devuelve `null` si el comunicado no existe y `false` si ya no era
     * borrador (409): publicar dos veces no manda dos avisos.
     */
    async publish(
        req: FastifyRequest,
        communityId: string,
        id: string,
    ): Promise<boolean | null> {
        const claims = requireAuth(req);
        const outcome = await withTransaction(contextFor(req), async (tx) => {
            const current = await announcementsRepository.getById(tx, communityId, id);
            if (current === null) {
                return null;
            }
            const published = await announcementsRepository.publish(tx, communityId, id, claims.sub);
            if (!published) {
                return false;
            }
            // Ya con la regla CONGELADA: los destinatarios se resuelven contra
            // el snapshot, no contra el grupo (que podría cambiar mañana).
            const frozen = await announcementsRepository.frozenRule(tx, communityId, id);
            const recipients =
                frozen === null
                    ? []
                    : await announcementsRepository.audienceUserIds(tx, communityId, frozen.rule);
            const community = await tx.query<{ name: string }>(
                `SELECT name FROM community.communities WHERE id = $1`,
                [communityId],
            );
            return {
                announcementId: id,
                communityId,
                communityName: community.rows[0]?.name ?? "",
                title: frozen?.title ?? current.title,
                body: frozen?.body ?? "",
                recipientUserIds: recipients,
            };
        });

        if (outcome === null || outcome === false) {
            return outcome;
        }
        // Fuera de la transacción y sin await: el aviso es un extra del
        // negocio, nunca su condición.
        announcementsNotifier.published(req.log, outcome);
        return true;
    },

    /** published → archived. `null` inexistente, `false` no estaba publicado. */
    async archive(
        req: FastifyRequest,
        communityId: string,
        id: string,
    ): Promise<boolean | null> {
        return withTransaction(contextFor(req), async (tx) => {
            const current = await announcementsRepository.getById(tx, communityId, id);
            if (current === null) {
                return null;
            }
            return announcementsRepository.archive(tx, communityId, id);
        });
    },

    async softDelete(req: FastifyRequest, communityId: string, id: string): Promise<boolean> {
        return withTransaction(contextFor(req), (tx) =>
            announcementsRepository.softDelete(tx, communityId, id),
        );
    },

    /** Quién leyó y quién falta, sobre las CUENTAS de la audiencia. */
    async listReaders(
        req: FastifyRequest,
        input: {
            communityId: string;
            id: string;
            filter: "read" | "unread" | null;
            page: number;
            pageSize: number;
        },
    ): Promise<{ items: AnnouncementReader[]; total: number } | null> {
        return withTransaction(contextFor(req), async (tx) => {
            const announcement = await announcementsRepository.getById(tx, input.communityId, input.id);
            if (announcement === null) {
                return null;
            }
            const rule = await ruleForReaders(tx, input.communityId, announcement);
            return announcementsRepository.listReaders(tx, {
                communityId: input.communityId,
                announcementId: input.id,
                rule,
                filter: input.filter,
                page: input.page,
                pageSize: input.pageSize,
            });
        });
    },

    /** Enlace firmado de un adjunto, tras validar que el archivo es DE ese
     *  comunicado y el comunicado de la comunidad del alcance. */
    async fileLink(
        req: FastifyRequest,
        communityId: string,
        id: string,
        fileId: string,
    ): Promise<
        | { ok: true; url: string; expiresAt: string; filename: string; contentType: string }
        | { ok: false; reason: "not_found" | "storage_unavailable"; message: string | null }
    > {
        const found = await withTransaction(contextFor(req), async (tx) => {
            const announcement = await announcementsRepository.getById(tx, communityId, id);
            if (announcement === null) {
                return null;
            }
            const file = announcement.files.find((f) => f.id === fileId);
            return file ?? null;
        });
        if (found === null) {
            return { ok: false, reason: "not_found", message: null };
        }
        const link = await storageClient.createDownloadLink(found.storageFileId);
        if (!link.ok) {
            return { ok: false, reason: "storage_unavailable", message: link.message };
        }
        return {
            ok: true,
            url: link.value.url,
            expiresAt: link.value.expiresAt,
            filename: found.filename,
            contentType: found.contentType,
        };
    },

    // ─── Grupos de audiencia ────────────────────────────────────────────────

    async listGroups(
        req: FastifyRequest,
        input: { communityId: string; page: number; pageSize: number; status?: string | null },
    ): Promise<{ items: AudienceGroup[]; total: number; towers: string[] }> {
        return withTransaction(contextFor(req), async (tx) => {
            const { items, total } = await announcementsRepository.listGroups(tx, input);
            const towers = await announcementsRepository.communityTowers(tx, input.communityId);
            return { items, total, towers };
        });
    },

    async getGroupById(
        req: FastifyRequest,
        communityId: string,
        id: string,
    ): Promise<AudienceGroup | null> {
        return withTransaction(contextFor(req), (tx) =>
            announcementsRepository.getGroupById(tx, communityId, id),
        );
    },

    async createGroup(
        req: FastifyRequest,
        communityId: string,
        input: {
            name: string;
            description: string | null;
            memberTypes: readonly string[] | null;
            towers: readonly string[] | null;
        },
    ): Promise<MutationResult<AudienceGroup>> {
        const claims = requireAuth(req);
        if (input.memberTypes === null && input.towers === null) {
            return { ok: false, error: { kind: "invalid", message: PG_MESSAGES.check } };
        }
        try {
            const group = await withTransaction(contextFor(req), (tx) =>
                announcementsRepository.createGroup(tx, claims.customerId, communityId, input),
            );
            return { ok: true, value: group };
        } catch (err) {
            return { ok: false, error: translatePgError(err, PG_MESSAGES) };
        }
    },

    async updateGroup(
        req: FastifyRequest,
        communityId: string,
        id: string,
        input: {
            name?: string;
            description?: string | null;
            memberTypes?: readonly string[] | null;
            towers?: readonly string[] | null;
            status?: string;
        },
    ): Promise<MutationResult<AudienceGroup> | null> {
        try {
            const group = await withTransaction(contextFor(req), (tx) =>
                announcementsRepository.updateGroup(tx, communityId, id, input),
            );
            if (group === null) {
                return null;
            }
            return { ok: true, value: group };
        } catch (err) {
            return { ok: false, error: translatePgError(err, PG_MESSAGES) };
        }
    },

    /**
     * Baja lógica de un grupo. Se NIEGA mientras algún BORRADOR lo use: el
     * borrador no tiene snapshot, así que sin grupo su audiencia pasaría en
     * silencio a "Todos" y al publicarlo el aviso le llegaría a toda la
     * comunidad. Los publicados no cuentan: su audiencia ya quedó congelada.
     *
     * `deleted` | `not_found` | `{ draftsUsing }` (409).
     */
    async softDeleteGroup(
        req: FastifyRequest,
        communityId: string,
        id: string,
    ): Promise<"deleted" | "not_found" | { draftsUsing: number }> {
        return withTransaction(contextFor(req), async (tx) => {
            const draftsUsing = await announcementsRepository.draftsUsingGroup(tx, communityId, id);
            if (draftsUsing > 0) {
                return { draftsUsing };
            }
            const deleted = await announcementsRepository.softDeleteGroup(tx, communityId, id);
            return deleted ? "deleted" : "not_found";
        });
    },

    /** Vista previa de una regla ANTES de guardarla o publicar: la cifra que
     *  evita mandar un comunicado al vacío. */
    async previewAudience(
        req: FastifyRequest,
        communityId: string,
        rule: AudienceRule,
    ): Promise<AudienceReach> {
        return withTransaction(contextFor(req), (tx) =>
            announcementsRepository.audienceReach(tx, communityId, rule),
        );
    },
};
