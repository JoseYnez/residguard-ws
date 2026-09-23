import type { FastifyBaseLogger } from "fastify";
import { pushClient } from "../../../core/push/push_client";
import { plainExcerpt } from "../../../core/text/markdown_plain";

// Aviso push "nuevo comunicado". Se dispara al PUBLICAR, después del commit,
// con el mismo contrato que los demás avisos del servicio: NUNCA lanza, NUNCA
// se espera, y si push-service no contesta el aviso se pierde y queda en el log.
// Publicar no puede fallar porque el canal de avisos esté caído.
//
// A diferencia de los avisos de pago o de caseta —que son POR UNIDAD— este es
// UNO solo para toda la audiencia: el comunicado es el mismo para todos y
// push-service ya abre el abanico a los dispositivos de cada usuario.
//
// EL ACTOR SÍ LO RECIBE si está en la audiencia. No es un descuido: un
// administrador que además vive en la comunidad quiere ver su comunicado llegar
// como lo ven los demás, y es la única forma barata de comprobar que el canal
// funciona.

/** Un comunicado sigue siendo noticia días después: el residente lo ve cuando
 *  lo ve, y no hay nada que caduque en 24 h como una visita en la puerta. */
const ANNOUNCEMENT_TTL_SEC = 7 * 86_400;

/** Cuánto cuerpo cabe en la notificación. Corto a propósito: el sistema
 *  operativo recorta sin avisar y el texto completo está a un toque. */
const BODY_EXCERPT_LENGTH = 120;

/** Tope de destinatarios por llamada que acepta push-service. */
const MAX_RECIPIENTS_PER_BATCH = 5_000;

export interface AnnouncementPublishedNotice {
    readonly announcementId: string;
    readonly communityId: string;
    readonly communityName: string;
    readonly title: string;
    /** Cuerpo en markdown acotado; aquí se vuelve texto plano. */
    readonly body: string;
    readonly recipientUserIds: readonly string[];
}

/** Ruta de la SPA al tocar el aviso: "Comunicados" abierto en ESTE. */
export function announcementClickUrl(announcementId: string): string {
    return `/my-announcements?announcement=${announcementId}`;
}

/**
 * Texto del aviso. Puro y exportado para poder probarlo sin red ni Fastify.
 *
 * El título dice QUÉ llegó y DE DÓNDE ("Nuevo comunicado · Residencial Uno"):
 * quien vive en dos comunidades necesita distinguirlas sin abrir nada. El
 * cuerpo lleva el título del comunicado y, si cabe, cómo empieza.
 */
export function announcementMessage(notice: {
    readonly communityName: string;
    readonly title: string;
    readonly body: string;
}): { title: string; body: string } {
    const excerpt = plainExcerpt(notice.body, BODY_EXCERPT_LENGTH);
    return {
        title: `Nuevo comunicado · ${notice.communityName}`,
        body: excerpt === "" ? notice.title : `${notice.title} — ${excerpt}`,
    };
}

/** Parte la audiencia en lotes del tamaño que acepta push-service. */
export function batchRecipients(
    userIds: readonly string[],
    size = MAX_RECIPIENTS_PER_BATCH,
): string[][] {
    const batches: string[][] = [];
    for (let i = 0; i < userIds.length; i += size) {
        batches.push(userIds.slice(i, i + size));
    }
    return batches;
}

export const announcementsNotifier = {
    /**
     * Encola el aviso de un comunicado recién publicado. Audiencia vacía o
     * canal apagado → nada (ni log: una comunidad sin cuentas es lo normal hoy).
     *
     * `idempotencyKey` y `tag` por comunicado y lote: reintentar la publicación
     * no avisa dos veces, y dos avisos del mismo comunicado se colapsan en
     * pantalla.
     */
    published(log: FastifyBaseLogger, notice: AnnouncementPublishedNotice): void {
        if (!pushClient.enabled || notice.recipientUserIds.length === 0) {
            return;
        }
        const message = announcementMessage(notice);
        const batches = batchRecipients(notice.recipientUserIds);

        batches.forEach((recipients, index) => {
            const key =
                batches.length === 1
                    ? `announcement-${notice.announcementId}`
                    : `announcement-${notice.announcementId}-${index}`;
            void pushClient
                .enqueue({
                    recipients,
                    title: message.title,
                    body: message.body,
                    clickUrl: announcementClickUrl(notice.announcementId),
                    // El tag NO lleva el índice del lote: dos lotes son un
                    // detalle del transporte, y en la pantalla del residente
                    // siguen siendo el mismo comunicado.
                    tag: `announcement-${notice.announcementId}`,
                    urgency: "normal",
                    ttlSec: ANNOUNCEMENT_TTL_SEC,
                    idempotencyKey: key,
                    data: {
                        kind: "announcement_published",
                        announcementId: notice.announcementId,
                        communityId: notice.communityId,
                    },
                    metadata: { communityId: notice.communityId },
                })
                .then((result) => {
                    if (!result.ok) {
                        log.warn(
                            {
                                announcementId: notice.announcementId,
                                batch: index,
                                status: result.status,
                                error: result.error,
                            },
                            `push: no se pudo encolar el aviso de comunicado: ${result.message}`,
                        );
                        return;
                    }
                    log.info(
                        {
                            announcementId: notice.announcementId,
                            batch: index,
                            pushMessageId: result.value.id,
                            deliveries: result.value.deliveriesTotal,
                            withoutDevices: result.value.recipientsWithoutDevices.length,
                        },
                        "push: aviso de comunicado encolado",
                    );
                })
                .catch((err: unknown) => {
                    log.error(
                        { err, announcementId: notice.announcementId },
                        "push: fallo inesperado al encolar",
                    );
                });
        });
    },
};
