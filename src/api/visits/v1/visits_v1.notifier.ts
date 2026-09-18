import type { FastifyBaseLogger } from "fastify";
import { pushClient } from "../../../core/push/push_client";
import type { Visit } from "./visits_v1.repository";

// Avisos push del dominio `access`: lo que pasa en la caseta se lo cuenta el
// servicio a los residentes de la unidad. Dos hechos viajan hoy:
//
//   * "tu visita llegó" — cada entrada registrada.
//   * "tu pase se agotó" — la entrada que consume la última de `max_entries`.
//
// Los dos ocurren en el MISMO instante (un pase solo se gasta al registrar una
// entrada), así que van en UN solo aviso cuyo texto cambia, y no en dos pushes
// seguidos: dos vibraciones por un solo hecho físico es ruido, y con `tag` por
// pase el segundo aviso pisaría al primero en pantalla de todos modos. La SPA
// distingue los casos por `data.kind`.
//
// Contrato con quien llama: NUNCA lanza y NUNCA se espera. El check-in ya
// quedó commiteado cuando esto corre; si push-service no contesta, el aviso se
// pierde y queda en el log — la caseta no puede depender de un servicio
// externo para abrir una puerta.

/** Vida del aviso en el push service: una visita de hace una hora ya no es "llegó". */
const ARRIVAL_TTL_SEC = 3_600;

/**
 * Un pase agotado sigue siendo noticia horas después —el residente tiene que
 * registrar otro si espera a la misma persona—, así que el aviso espera más
 * a un dispositivo apagado que el de una simple llegada.
 */
const EXHAUSTED_TTL_SEC = 86_400;

/** Ruta de la SPA a la que navega la notificación al tocarla. */
const MY_VISITS_ROUTE = "/my-visits";

/** Lo que cambia entre "llegó" y "llegó y con esta se acabó el pase". */
export interface ArrivalMessage {
    readonly kind: "visit_arrived" | "visit_exhausted";
    readonly title: string;
    readonly body: string;
    readonly ttlSec: number;
}

/**
 * ¿Esta entrada consumió la última del pase? Se decide por el CONTEO releído
 * tras el INSERT y no por el veredicto: en un pase estricto el veredicto
 * releído dice `already_inside` antes que `exhausted`, y aquí la pregunta es
 * otra — si queda alguna entrada para la próxima vez.
 */
export function isExhaustedByThisEntry(visit: Visit): boolean {
    return visit.maxEntries !== null && visit.entryCount >= visit.maxEntries;
}

/** Texto del aviso. Puro y exportado para poder probarlo sin red ni Fastify. */
export function arrivalMessage(visit: Visit): ArrivalMessage {
    const unit = visit.unitTower ? `${visit.unitTower} ${visit.unitCode}` : visit.unitCode;
    const arrived = `${visit.visitorName} llegó a la unidad ${unit}`;

    if (!isExhaustedByThisEntry(visit)) {
        return {
            kind: "visit_arrived",
            title: "Visita en caseta",
            body: arrived,
            ttlSec: ARRIVAL_TTL_SEC,
        };
    }

    // `maxEntries` no es null aquí (lo garantiza isExhaustedByThisEntry).
    const max = visit.maxEntries ?? visit.entryCount;
    const spent =
        max === 1
            ? "Su pase era de una sola entrada y ya quedó usado"
            : `Su pase ya usó sus ${max} entradas y quedó agotado`;
    return {
        kind: "visit_exhausted",
        title: "Visita en caseta · pase agotado",
        body: `${arrived}. ${spent}: si vuelve, registra un pase nuevo.`,
        ttlSec: EXHAUSTED_TTL_SEC,
    };
}

export const visitsNotifier = {
    /**
     * Encola el aviso de la entrada a los usuarios vinculados de la unidad.
     * Vacío de destinatarios o canal apagado → no hace nada (ni log: es lo
     * normal en una unidad sin residentes con cuenta).
     *
     * idempotencyKey por EVENTO de entrada: un reintento del mismo check-in no
     * avisa dos veces, y una segunda entrada del mismo pase (recurrentes) sí.
     * `tag` por PASE: dos avisos del mismo pase se colapsan en pantalla — el
     * más reciente es el que importa, y si fue el que agotó el pase, mejor.
     */
    arrival(
        log: FastifyBaseLogger,
        visit: Visit,
        checkIn: { readonly eventId: string; readonly notifyUserIds: readonly string[] },
    ): void {
        if (!pushClient.enabled || checkIn.notifyUserIds.length === 0) {
            return;
        }

        const message = arrivalMessage(visit);

        void pushClient
            .enqueue({
                recipients: checkIn.notifyUserIds,
                title: message.title,
                body: message.body,
                clickUrl: MY_VISITS_ROUTE,
                tag: `visit-${visit.id}`,
                urgency: "high",
                ttlSec: message.ttlSec,
                idempotencyKey: `visit-${visit.id}-entry-${checkIn.eventId}`,
                data: {
                    kind: message.kind,
                    visitId: visit.id,
                    eventId: checkIn.eventId,
                    entryCount: visit.entryCount,
                    maxEntries: visit.maxEntries,
                },
                metadata: { communityId: visit.communityId, unitId: visit.unitId },
            })
            .then((result) => {
                if (!result.ok) {
                    log.warn(
                        { visitId: visit.id, kind: message.kind, status: result.status, error: result.error },
                        `push: no se pudo encolar el aviso de caseta: ${result.message}`,
                    );
                    return;
                }
                log.info(
                    {
                        visitId: visit.id,
                        kind: message.kind,
                        pushMessageId: result.value.id,
                        deliveries: result.value.deliveriesTotal,
                        withoutDevices: result.value.recipientsWithoutDevices.length,
                    },
                    "push: aviso de caseta encolado",
                );
            })
            .catch((err: unknown) => {
                // pushClient no lanza, pero el contrato de este módulo es no
                // dejar NUNCA una promesa rechazada suelta.
                log.error({ err, visitId: visit.id }, "push: fallo inesperado al encolar");
            });
    },
};
