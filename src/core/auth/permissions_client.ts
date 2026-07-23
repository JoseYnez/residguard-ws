import { config } from "../../config";

// Cliente de permisos contra auth_ws (decisión #22 de la plataforma): auth_ws
// es la fuente de verdad operativa de los permisos — el mismo endpoint que
// consume el front (GET /auth/sessions/current/permissions) alimenta la
// autorización de endpoints de este servicio. auth_ws re-verifica la firma Y la
// validez de la sesión en BD, así que una sesión revocada pierde acceso aunque
// su JWT siga criptográficamente vigente.
//
// DIFERENCIA CLAVE CON admin_ws: allí, si auth_ws no responde, se degrada al
// resolver local `auth.fn_has_permission(acu, code)` porque comparte la BD de
// la plataforma. residguard_ws NO tiene schema `auth` en su base — no existe
// resolver local al que degradar. En su lugar servimos la ÚLTIMA respuesta
// conocida de auth_ws más allá de su TTL, durante una ventana de gracia
// acotada. Esto conserva el invariante que importa: nunca se concede un permiso
// que auth_ws no haya afirmado. Lo que se relaja es la frescura (un permiso
// revocado puede tardar hasta la gracia en aplicarse), no la frontera.
//
// Sin caché previa y con auth_ws caído no hay nada que servir: el llamador
// responde 503. Fallar cerrado es la única opción segura ahí.

/** Ventana de frescura: desfase máximo entre un cambio de permisos y su aplicación. */
const CACHE_TTL_MS = 60_000;
/** Timeout de la consulta: mejor degradar rápido que colgar el request. */
const FETCH_TIMEOUT_MS = 3_000;
/** Tope de entradas: al superarlo se purgan las inservibles (barrido perezoso). */
const CACHE_MAX_ENTRIES = 5_000;

export type PermissionsLookup =
    /** Respuesta fresca de auth_ws (o caché dentro del TTL). */
    | { readonly kind: "ok"; readonly permissions: ReadonlySet<string> }
    /**
     * auth_ws inalcanzable, pero teníamos una respuesta suya vigente dentro de
     * la ventana de gracia. Se autoriza con ella y se registra la degradación.
     */
    | { readonly kind: "stale"; readonly permissions: ReadonlySet<string>; readonly ageMs: number }
    /** auth_ws rechazó el token/sesión (revocada): más autoridad que la firma local. */
    | { readonly kind: "unauthorized" }
    /** auth_ws inalcanzable y sin caché utilizable: el llamador falla cerrado. */
    | { readonly kind: "unavailable" };

interface CacheEntry {
    readonly permissions: ReadonlySet<string>;
    /** Hasta cuándo se sirve sin volver a preguntar. */
    readonly freshUntilMs: number;
    /** Hasta cuándo se sirve como `stale` si auth_ws no responde. */
    readonly staleUntilMs: number;
}

const cache = new Map<string, CacheEntry>();

function pruneIfNeeded(nowMs: number): void {
    if (cache.size <= CACHE_MAX_ENTRIES) {
        return;
    }
    // Se purga por `staleUntilMs`, no por `freshUntilMs`: una entrada vencida
    // pero dentro de la gracia sigue siendo útil ante una caída de auth_ws.
    for (const [sid, entry] of cache) {
        if (entry.staleUntilMs <= nowMs) {
            cache.delete(sid);
        }
    }
    // Si tras purgar sigue desbordada (avalancha de sesiones), se vacía: la
    // caché es una optimización, nunca un requisito de correctitud.
    if (cache.size > CACHE_MAX_ENTRIES) {
        cache.clear();
    }
}

/** Caché utilizable como degradación, o null si ya venció la gracia. */
function staleFallback(sid: string, nowMs: number): PermissionsLookup {
    const entry = cache.get(sid);
    if (entry === undefined || entry.staleUntilMs <= nowMs) {
        return { kind: "unavailable" };
    }
    return {
        kind: "stale",
        permissions: entry.permissions,
        ageMs: nowMs - (entry.freshUntilMs - CACHE_TTL_MS),
    };
}

/**
 * Permisos efectivos de la sesión `sid`, consultados a auth_ws con el Bearer
 * del request. Cachea por sesión durante el TTL y conserva la entrada como
 * degradación durante la ventana de gracia configurada.
 */
export async function getSessionPermissions(
    sid: string,
    bearerToken: string,
): Promise<PermissionsLookup> {
    const now = Date.now();
    const hit = cache.get(sid);
    if (hit !== undefined && hit.freshUntilMs > now) {
        return { kind: "ok", permissions: hit.permissions };
    }

    let response: Response;
    try {
        response = await fetch(`${config.authWsBaseUrl}/auth/sessions/current/permissions`, {
            headers: { authorization: `Bearer ${bearerToken}` },
            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
    } catch {
        return staleFallback(sid, now);
    }

    // 401 es una respuesta CON autoridad: la sesión ya no vale. Se descarta la
    // caché — servirla como `stale` mantendría viva una sesión revocada.
    if (response.status === 401) {
        cache.delete(sid);
        return { kind: "unauthorized" };
    }
    if (!response.ok) {
        return staleFallback(sid, now);
    }

    let body: { permissions?: unknown };
    try {
        body = (await response.json()) as { permissions?: unknown };
    } catch {
        return staleFallback(sid, now);
    }
    if (!Array.isArray(body.permissions)) {
        return staleFallback(sid, now);
    }

    const permissions: ReadonlySet<string> = new Set(
        body.permissions.filter((p): p is string => typeof p === "string"),
    );
    pruneIfNeeded(now);
    cache.set(sid, {
        permissions,
        freshUntilMs: now + CACHE_TTL_MS,
        staleUntilMs: now + CACHE_TTL_MS + config.permissionsStaleGraceMs,
    });
    return { kind: "ok", permissions };
}

/** Invalida la caché de una sesión (p. ej. tras revocarla desde soporte). */
export function invalidateSessionPermissions(sid: string): void {
    cache.delete(sid);
}
