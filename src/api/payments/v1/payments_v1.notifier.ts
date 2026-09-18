import type { FastifyBaseLogger } from "fastify";
import { pushClient } from "../../../core/push/push_client";

// Aviso push "se registró un pago a tu unidad". Lo disparan las DOS vías por
// las que nace un pago —el registro directo en ventanilla y la verificación
// de una evidencia— después del commit, con el mismo contrato que el aviso
// de caseta: NUNCA lanza, NUNCA se espera, y si push-service no contesta el
// aviso se pierde y queda en el log.
//
// Un depósito puede cubrir cargos de VARIAS unidades (registro multi-unidad),
// y los destinatarios son por unidad: va UN aviso por unidad alcanzada, con
// el monto que le tocó a esa unidad — al residente de la 12 no le importa que
// el mismo depósito también pagó la 14.

/** Un pago aplicado a una unidad, ya resuelto a quién avisar. */
export interface PaymentUnitNotice {
    readonly unitId: string;
    readonly unitCode: string;
    /** Lo aplicado a ESTA unidad (no el total del depósito). */
    readonly amount: number;
    readonly notifyUserIds: readonly string[];
}

export interface PaymentRegisteredNotice {
    readonly paymentId: string;
    readonly communityId: string;
    readonly units: readonly PaymentUnitNotice[];
}

/** Un pago sigue siendo noticia días después: el residente lo ve cuando lo ve. */
const PAYMENT_TTL_SEC = 7 * 86_400;

/** Ruta de la SPA a la que navega la notificación al tocarla. */
const MY_STATEMENT_ROUTE = "/my-statement";

const MXN = new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN" });

/** Texto del aviso. Puro y exportado para poder probarlo sin red ni Fastify. */
export function paymentMessage(unit: PaymentUnitNotice): { title: string; body: string } {
    return {
        title: "Pago registrado",
        body: `Se registró un pago de ${MXN.format(unit.amount)} a la unidad ${unit.unitCode}`,
    };
}

export const paymentsNotifier = {
    /**
     * Encola un aviso por unidad alcanzada. Unidades sin destinatarios o canal
     * apagado → nada (ni log: es lo normal en una unidad sin residentes con
     * cuenta).
     *
     * idempotencyKey por (pago, unidad): un reintento del mismo registro no
     * avisa dos veces. `tag` igual: dos avisos del mismo pago a la misma
     * unidad se colapsan en pantalla.
     */
    registered(log: FastifyBaseLogger, notice: PaymentRegisteredNotice): void {
        if (!pushClient.enabled) {
            return;
        }
        for (const unit of notice.units) {
            if (unit.notifyUserIds.length === 0) {
                continue;
            }
            const message = paymentMessage(unit);
            const key = `payment-${notice.paymentId}-unit-${unit.unitId}`;
            void pushClient
                .enqueue({
                    recipients: unit.notifyUserIds,
                    title: message.title,
                    body: message.body,
                    clickUrl: MY_STATEMENT_ROUTE,
                    tag: key,
                    urgency: "normal",
                    ttlSec: PAYMENT_TTL_SEC,
                    idempotencyKey: key,
                    data: {
                        kind: "payment_registered",
                        paymentId: notice.paymentId,
                        unitId: unit.unitId,
                        amount: unit.amount,
                    },
                    metadata: { communityId: notice.communityId, unitId: unit.unitId },
                })
                .then((result) => {
                    if (!result.ok) {
                        log.warn(
                            {
                                paymentId: notice.paymentId,
                                unitId: unit.unitId,
                                status: result.status,
                                error: result.error,
                            },
                            `push: no se pudo encolar el aviso de pago: ${result.message}`,
                        );
                        return;
                    }
                    log.info(
                        {
                            paymentId: notice.paymentId,
                            unitId: unit.unitId,
                            pushMessageId: result.value.id,
                            deliveries: result.value.deliveriesTotal,
                            withoutDevices: result.value.recipientsWithoutDevices.length,
                        },
                        "push: aviso de pago encolado",
                    );
                })
                .catch((err: unknown) => {
                    log.error({ err, paymentId: notice.paymentId }, "push: fallo inesperado al encolar");
                });
        }
    },
};
