import type { FastifyReply, FastifyRequest } from "fastify";
import { requireAuth } from "./authenticate";
import type { PermissionCode } from "./permissions";
import { getSessionPermissions } from "./permissions_client";

// Autorización declarativa por endpoint. Es la segunda de las DOS fronteras de
// este servicio, y son ortogonales:
//
//   1. PERMISO (este archivo)      → QUÉ puede hacer el actor.  Sin él → 403.
//   2. ALCANCE (community_access)  → SOBRE QUÉ comunidad.       Fuera → 404.
//
// Ambas son necesarias: `units.create` no autoriza a crear unidades en una
// comunidad ajena, y pertenecer a una comunidad no autoriza a capturar gastos
// en ella. Toda ruta mutadora declara las dos, con el permiso PRIMERO — es la
// comprobación barata (caché en memoria, sin BD) y no revela si el recurso
// existe.
//
// Fuente de verdad: auth_ws (decisión #22). Ver `permissions_client` para la
// política de degradación; aquí solo se traduce su resultado a una respuesta.
//
// Un endpoint de negocio sin `requirePermission` es un bug, no un default.

/**
 * preHandler que exige el permiso `code` sobre la tripleta del token validado.
 * Debe ir tras el hook de autenticación (usa `req.auth`).
 *
 * - permiso efectivo        → deja pasar
 * - sin permiso             → 403
 * - sesión revocada         → 401 (auth_ws tiene más autoridad que la firma local)
 * - auth_ws caído sin caché → 503 (falla cerrado; no hay resolver local)
 */
export function requirePermission(code: PermissionCode) {
    return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
        const claims = requireAuth(req);
        // El hook de autenticación ya garantizó el formato del header.
        const bearerToken = (req.headers.authorization ?? "").slice("Bearer ".length);

        const lookup = await getSessionPermissions(claims.sid, bearerToken);

        if (lookup.kind === "unauthorized") {
            // auth_ws tiene más autoridad que la firma local: la sesión fue revocada.
            return reply.code(401).send({ error: "unauthorized", message: null });
        }

        if (lookup.kind === "unavailable") {
            // Sin respuesta de auth_ws y sin caché dentro de la gracia no hay
            // forma de saber qué puede hacer el actor: se falla cerrado.
            req.log.error(
                { permission: code, sid: claims.sid },
                "auth_ws no disponible y sin permisos cacheados: denegando",
            );
            return reply.code(503).send({ error: "unavailable", message: null });
        }

        if (lookup.kind === "stale") {
            req.log.warn(
                { permission: code, sid: claims.sid, ageMs: lookup.ageMs },
                "auth_ws no disponible: autorizando con permisos cacheados vencidos",
            );
        }

        if (!lookup.permissions.has(code)) {
            return reply.code(403).send({ error: "forbidden", message: null });
        }
    };
}
