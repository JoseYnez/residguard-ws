import type { FastifyBaseLogger } from "fastify";
import { pushClient, type PushEnqueueInput } from "../../../core/push/push_client";
import { homeLabel } from "../../../core/text/home_label";
import type { Visit } from "./visits_v1.repository";

// Avisos push del dominio `access`: lo que pasa en la caseta se lo cuenta el
// servicio a los residentes de la unidad. Tres hechos viajan hoy:
//
//   * "tu visita llegó" — cada entrada registrada.
//   * "tu pase se agotó" — la entrada que consume la última de `max_entries`.
//   * "tu visita salió" — cada salida registrada.
//
// Llegada y agotamiento ocurren en el MISMO instante (un pase solo se gasta
// al registrar una entrada), así que van en UN solo aviso cuyo texto cambia,
// y no en dos pushes seguidos: dos vibraciones por un solo hecho físico es
// ruido, y con `tag` por pase el segundo aviso pisaría al primero en pantalla
// de todos modos. La salida sí es otro momento y otro aviso; comparte el
// `tag` para que en pantalla quede el último estado del pase, no una pila.
// La SPA distingue los casos por `data.kind`.
//
// Los textos se leen SIN contexto (pantalla bloqueada) y los lee un residente:
// nombran el domicilio por su tipo ("tu casa 426-A"), nunca "unidad".
//
// Contrato con quien llama: NUNCA lanza y NUNCA se espera. El evento ya
// quedó commiteado cuando esto corre; si push-service no contesta, el aviso se
// pierde y queda en el log — la caseta no puede depender de un servicio
// externo para abrir una puerta.

/** Vida del aviso en el push service: una visita de hace una hora ya no es "llegó". */
const GATE_EVENT_TTL_SEC = 3_600;

/**
 * Un pase agotado sigue siendo noticia horas después —el residente tiene que
 * registrar otro si espera a la misma persona—, así que el aviso espera más
 * a un dispositivo apagado que el de una simple llegada.
 */
const EXHAUSTED_TTL_SEC = 86_400;

/** Ruta de la SPA a la que navega la notificación al tocarla. */
const MY_VISITS_ROUTE = "/my-visits";

/** Lo que cambia entre "llegó", "llegó y con esta se acabó el pase" y "salió". */
export interface GateMessage {
    readonly kind: "visit_arrived" | "visit_exhausted" | "visit_left";
    readonly title: string;
    readonly body: string;
    readonly ttlSec: number;
}

/** El evento de caseta ya commiteado: su id y a quién avisar. */
export interface GateEventNotice {
    readonly eventId: string;
    readonly notifyUserIds: readonly string[];
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

/** Texto del aviso de entrada. Puro y exportado para poder probarlo sin red ni Fastify. */
export function arrivalMessage(visit: Visit): GateMessage {
    const home = homeLabel(visit);

    if (!isExhaustedByThisEntry(visit)) {
        return {
            kind: "visit_arrived",
            title: "Llegó tu visita",
            body: `${visit.visitorName} entró por caseta y va a tu ${home}.`,
            ttlSec: GATE_EVENT_TTL_SEC,
        };
    }

    // Mismo título que la llegada: para el residente el hecho es el mismo —
    // llegó su visita—; que el pase se haya gastado es el detalle del cuerpo.
    return {
        kind: "visit_exhausted",
        title: "Llegó tu visita",
        body:
            `${visit.visitorName} entró y va a tu ${home}. ` +
            "Su pase ya no tiene entradas. Si va a volver, créale uno nuevo.",
        ttlSec: EXHAUSTED_TTL_SEC,
    };
}

/** Texto del aviso de salida. */
export function departureMessage(visit: Visit): GateMessage {
    return {
        kind: "visit_left",
        title: "Tu visita ya salió",
        body: `${visit.visitorName} salió por caseta.`,
        ttlSec: GATE_EVENT_TTL_SEC,
    };
}

/**
 * Encola un aviso de caseta. Vacío de destinatarios o canal apagado → no hace
 * nada (ni log: es lo normal en una unidad sin residentes con cuenta).
 *
 * idempotencyKey por EVENTO: un reintento del mismo registro no avisa dos
 * veces, y una segunda entrada del mismo pase (recurrentes) sí. `tag` por
 * PASE: los avisos del mismo pase se colapsan en pantalla — el más reciente es
 * el que importa.
 */
function enqueueGateEvent(
    log: FastifyBaseLogger,
    visit: Visit,
    event: GateEventNotice,
    message: GateMessage,
    extra: Record<string, unknown> = {},
): void {
    if (!pushClient.enabled || event.notifyUserIds.length === 0) {
        return;
    }

    const input: PushEnqueueInput = {
        recipients: event.notifyUserIds,
        title: message.title,
        body: message.body,
        clickUrl: MY_VISITS_ROUTE,
        tag: `visit-${visit.id}`,
        urgency: "high",
        ttlSec: message.ttlSec,
        idempotencyKey: `visit-${visit.id}-event-${event.eventId}`,
        data: { kind: message.kind, visitId: visit.id, eventId: event.eventId, ...extra },
        metadata: { communityId: visit.communityId, unitId: visit.unitId },
    };

    void pushClient
        .enqueue(input)
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
}

export const visitsNotifier = {
    /** "Llegó tu visita" (o "llegó y con esta se agotó el pase"). */
    arrival(log: FastifyBaseLogger, visit: Visit, checkIn: GateEventNotice): void {
        enqueueGateEvent(log, visit, checkIn, arrivalMessage(visit), {
            entryCount: visit.entryCount,
            maxEntries: visit.maxEntries,
        });
    },

    /** "Salió tu visita". */
    departure(log: FastifyBaseLogger, visit: Visit, checkOut: GateEventNotice): void {
        enqueueGateEvent(log, visit, checkOut, departureMessage(visit));
    },
};
