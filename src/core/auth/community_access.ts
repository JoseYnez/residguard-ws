import type { FastifyReply, FastifyRequest } from "fastify";
import { buildAuditContext, type AuditContext } from "../audit/audit_context";
import { withTransaction, type TxClient } from "../db/with_transaction";
import { requireAuth } from "./authenticate";

// Autorización por ALCANCE de comunidad. residguard_ws no consulta permisos de
// plataforma: la frontera de visibilidad es community.community_members — el
// usuario del token (`sub`) solo ve/opera las comunidades donde tiene una
// membresía activa, y a través de ellas sus unidades y demás recursos.
//
// Convención de respuesta: un recurso fuera del alcance del actor responde
// 404, indistinguible de uno inexistente (misma convención que admin_ws §6).

/**
 * Contexto de auditoría del actor autenticado. El tenant sale SIEMPRE del
 * claim `customer_id` del token (activa el RLS), nunca de un parámetro.
 */
export function contextFor(req: FastifyRequest): AuditContext {
    const claims = requireAuth(req);
    return buildAuditContext(req, {
        userId: claims.sub,
        sessionId: claims.sid,
        customerId: claims.customerId,
    });
}

/**
 * ¿Tiene el usuario membresía activa en la comunidad? La comunidad debe estar
 * activa; el RLS ya acota al tenant de la transacción.
 */
export async function userHasCommunityAccess(
    tx: TxClient,
    userId: string,
    communityId: string,
): Promise<boolean> {
    const result = await tx.query(
        `SELECT 1
           FROM community.community_members cm
           JOIN community.communities c
             ON c.customer_id = cm.customer_id AND c.id = cm.community_id
          WHERE cm.community_id = $1
            AND cm.user_id      = $2
            AND cm.status       = 'active'
            AND c.status        = 'active'`,
        [communityId, userId],
    );
    return (result.rowCount ?? 0) > 0;
}

/**
 * ¿Alcanza el usuario la unidad? Resuelve unidad → comunidad → membresía en
 * una sola consulta. Devuelve el community_id de la unidad o null si la
 * unidad no existe / está eliminada / su comunidad no está activa / queda
 * fuera del alcance.
 *
 * La unidad se admite `inactive` (dada de baja pero gestionable: el detalle
 * sigue siendo consultable y reactivable); la COMUNIDAD no — desactivarla
 * cierra el acceso a todo lo que cuelga de ella, igual que en
 * `userHasCommunityAccess`.
 */
export async function resolveUnitAccess(
    tx: TxClient,
    userId: string,
    unitId: string,
): Promise<{ communityId: string } | null> {
    const result = await tx.query<{ community_id: string }>(
        `SELECT u.community_id
           FROM community.units u
           JOIN community.communities c
             ON c.customer_id = u.customer_id AND c.id = u.community_id
           JOIN community.community_members cm
             ON cm.customer_id = u.customer_id AND cm.community_id = u.community_id
          WHERE u.id        = $1
            AND u.status   <> 'deleted'
            AND c.status    = 'active'
            AND cm.user_id  = $2
            AND cm.status   = 'active'`,
        [unitId, userId],
    );
    const row = result.rows[0];
    return row === undefined ? null : { communityId: row.community_id };
}

/**
 * preHandler para rutas /communities/:communityId/*: exige membresía activa
 * del actor en esa comunidad. La comprobación abre su propia transacción (es
 * la frontera de autorización, separada de la transacción de negocio del
 * handler). Sin acceso → 404 (indistinguible de inexistente).
 */
export function requireCommunityAccess() {
    return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
        const claims = requireAuth(req);
        const { communityId } = req.params as { communityId: string };
        const allowed = await withTransaction(contextFor(req), (tx) =>
            userHasCommunityAccess(tx, claims.sub, communityId),
        );
        if (!allowed) {
            return reply.code(404).send({ error: "not_found", message: null });
        }
    };
}

/**
 * preHandler para rutas /units/:unitId/*: exige que la unidad exista y que su
 * comunidad esté dentro del alcance del actor. Sin acceso → 404.
 */
export function requireUnitAccess() {
    return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
        const claims = requireAuth(req);
        const { unitId } = req.params as { unitId: string };
        const found = await withTransaction(contextFor(req), (tx) =>
            resolveUnitAccess(tx, claims.sub, unitId),
        );
        if (found === null) {
            return reply.code(404).send({ error: "not_found", message: null });
        }
    };
}
