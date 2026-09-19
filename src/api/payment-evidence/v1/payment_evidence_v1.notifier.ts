import type { FastifyBaseLogger } from "fastify";
import { pushClient } from "../../../core/push/push_client";

// Aviso push "tu comprobante fue rechazado". La otra resolución de una
// evidencia —verificarla— ya avisa por el lado del pago (payments_v1.notifier:
// verificar ES registrar un pago); el rechazo no dejaba rastro fuera de la
// app, y la app le promete al residente "te avisaremos".
//
// Mismo contrato que los demás avisos: se dispara DESPUÉS del commit, NUNCA
// lanza y NUNCA se espera. Si push-service no contesta, el aviso se pierde y
// queda en el log — rechazar un comprobante no depende de un servicio externo.

export interface EvidenceRejectedNotice {
    readonly evidenceId: string;
    readonly communityId: string;
    readonly unitId: string;
    /** Motivo que capturó el operador (obligatorio al rechazar). */
    readonly resolutionNote: string;
    readonly notifyUserIds: readonly string[];
}

/** Un rechazo sigue siendo noticia días después (igual que un pago): el
 *  residente tiene que corregir y reenviar cuando lo vea. */
const EVIDENCE_REJECTED_TTL_SEC = 7 * 86_400;

/** Tope del motivo dentro del cuerpo: un push largo se corta sin aviso y lo
 *  que se perdería es justo la instrucción final. El motivo completo vive en
 *  el detalle de la evidencia, a un toque. */
const NOTE_MAX_CHARS = 140;

/** Ruta de la SPA al tocar el aviso: "Mis pagos", pestaña de evidencias,
 *  abierta en ESTA evidencia. */
export function evidenceRejectedClickUrl(evidenceId: string): string {
    return `/my-payments?tab=evidencias&evidence=${evidenceId}`;
}

/** Recorta en el último espacio antes del tope, para no partir una palabra. */
function clip(text: string, max: number): string {
    const flat = text.replace(/\s+/g, " ").trim();
    if (flat.length <= max) {
        return flat;
    }
    const cut = flat.slice(0, max);
    const lastSpace = cut.lastIndexOf(" ");
    return `${(lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

/** Texto del aviso. Puro y exportado para poder probarlo sin red ni Fastify. */
export function evidenceRejectedMessage(resolutionNote: string): { title: string; body: string } {
    // El motivo suele venir ya con punto final; no se duplica.
    const note = clip(resolutionNote, NOTE_MAX_CHARS).replace(/[.\s]+$/, "");
    return {
        title: "Tu comprobante fue rechazado",
        body: `Motivo: ${note}. Corrígelo y envíalo de nuevo.`,
    };
}

export const paymentEvidenceNotifier = {
    /**
     * Encola el aviso de rechazo. Sin destinatarios o canal apagado → nada.
     *
     * idempotencyKey por EVIDENCIA: una evidencia se rechaza una sola vez (el
     * UPDATE está condicionado a pending_review y "rechazada" es terminal),
     * así que un reintento del mismo rechazo no avisa dos veces.
     */
    rejected(log: FastifyBaseLogger, notice: EvidenceRejectedNotice): void {
        if (!pushClient.enabled || notice.notifyUserIds.length === 0) {
            return;
        }
        const message = evidenceRejectedMessage(notice.resolutionNote);
        const key = `evidence-rejected:${notice.evidenceId}`;
        void pushClient
            .enqueue({
                recipients: notice.notifyUserIds,
                title: message.title,
                body: message.body,
                clickUrl: evidenceRejectedClickUrl(notice.evidenceId),
                tag: key,
                urgency: "normal",
                ttlSec: EVIDENCE_REJECTED_TTL_SEC,
                idempotencyKey: key,
                data: { kind: "evidence_rejected", evidenceId: notice.evidenceId, unitId: notice.unitId },
                metadata: { communityId: notice.communityId, unitId: notice.unitId },
            })
            .then((result) => {
                if (!result.ok) {
                    log.warn(
                        { evidenceId: notice.evidenceId, status: result.status, error: result.error },
                        `push: no se pudo encolar el aviso de rechazo: ${result.message}`,
                    );
                    return;
                }
                log.info(
                    {
                        evidenceId: notice.evidenceId,
                        pushMessageId: result.value.id,
                        deliveries: result.value.deliveriesTotal,
                        withoutDevices: result.value.recipientsWithoutDevices.length,
                    },
                    "push: aviso de rechazo encolado",
                );
            })
            .catch((err: unknown) => {
                log.error({ err, evidenceId: notice.evidenceId }, "push: fallo inesperado al encolar");
            });
    },
};
