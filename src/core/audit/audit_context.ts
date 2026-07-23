import type { FastifyRequest } from "fastify";

/** audit.app_name: siempre el servicio ejecutor. */
export const APP_NAME = "residguard_ws";

/**
 * Contexto de auditoría de una request. Se construye en el controller, una
 * vez por request, y viaja hasta withTransaction, que lo vuelca en los GUCs
 * `audit.*` (+ `app.current_customer_id` para RLS) al abrir la transacción.
 *
 * En residguard_ws no hay endpoints anónimos de negocio: userId, sessionId y
 * customerId vienen SIEMPRE del access token validado. El tenant nunca viaja
 * como parámetro — RLS filtra todas las tablas de negocio por ese GUC.
 */
export interface AuditContext {
    readonly userId: string;
    readonly sessionId: string | null;
    readonly appName: string;
    /** "<MÉTODO> <ruta>" del endpoint. */
    readonly action: string;
    readonly ipAddress: string | null;
    /** request.id de Fastify: correlaciona logs ↔ audit.event_log.stack_trace. */
    readonly requestId: string;
    /** Tenant del token (claim `customer_id`). Obligatorio: activa el RLS. */
    readonly customerId: string;
}

export function buildAuditContext(
    req: FastifyRequest,
    actor: { userId: string; sessionId?: string; customerId: string },
): AuditContext {
    return {
        userId: actor.userId,
        sessionId: actor.sessionId ?? null,
        appName: APP_NAME,
        action: `${req.method} ${req.routeOptions.url ?? req.url}`,
        ipAddress: req.ip ?? null,
        requestId: String(req.id),
        customerId: actor.customerId,
    };
}
