import type { FastifyBaseLogger } from "fastify";
import { pushClient } from "../../../core/push/push_client";
import type { Visit } from "./visits_v1.repository";

// Avisos push del dominio `access`. Primer caso de uso de la plataforma de
// notificaciones: "tu visita llegó a la caseta".
//
// Contrato con quien llama: NUNCA lanza y NUNCA se espera. El check-in ya
// quedó commiteado cuando esto corre; si push-service no contesta, el aviso se
// pierde y queda en el log — la caseta no puede depender de un servicio
// externo para abrir una puerta.

/** Vida del aviso en el push service: una visita de hace una hora ya no es "llegó". */
const ARRIVAL_TTL_SEC = 3_600;

/** Ruta de la SPA a la que navega la notificación al tocarla. */
const MY_VISITS_ROUTE = "/my-visits";

export const visitsNotifier = {
    /**
     * Encola "llegó tu visita" a los usuarios vinculados de la unidad. Vacío
     * de destinatarios o canal apagado → no hace nada (ni log: es lo normal en
     * una unidad sin residentes con cuenta).
     *
     * idempotencyKey por EVENTO de entrada: un reintento del mismo check-in no
     * avisa dos veces, y una segunda entrada del mismo pase (recurrentes) sí.
     * `tag` por PASE: dos avisos del mismo pase se colapsan en pantalla.
     */
    arrival(
        log: FastifyBaseLogger,
        visit: Visit,
        checkIn: { readonly eventId: string; readonly notifyUserIds: readonly string[] },
    ): void {
        if (!pushClient.enabled || checkIn.notifyUserIds.length === 0) {
            return;
        }

        const unit = visit.unitTower ? `${visit.unitTower} ${visit.unitCode}` : visit.unitCode;

        void pushClient
            .enqueue({
                recipients: checkIn.notifyUserIds,
                title: "Visita en caseta",
                body: `${visit.visitorName} llegó a la unidad ${unit}`,
                clickUrl: MY_VISITS_ROUTE,
                tag: `visit-${visit.id}`,
                urgency: "high",
                ttlSec: ARRIVAL_TTL_SEC,
                idempotencyKey: `visit-${visit.id}-entry-${checkIn.eventId}`,
                data: { kind: "visit_arrived", visitId: visit.id, eventId: checkIn.eventId },
                metadata: { communityId: visit.communityId, unitId: visit.unitId },
            })
            .then((result) => {
                if (!result.ok) {
                    log.warn(
                        { visitId: visit.id, status: result.status, error: result.error },
                        `push: no se pudo encolar el aviso de llegada: ${result.message}`,
                    );
                    return;
                }
                log.info(
                    {
                        visitId: visit.id,
                        pushMessageId: result.value.id,
                        deliveries: result.value.deliveriesTotal,
                        withoutDevices: result.value.recipientsWithoutDevices.length,
                    },
                    "push: aviso de llegada encolado",
                );
            })
            .catch((err: unknown) => {
                // pushClient no lanza, pero el contrato de este módulo es no
                // dejar NUNCA una promesa rechazada suelta.
                log.error({ err, visitId: visit.id }, "push: fallo inesperado al encolar");
            });
    },
};
