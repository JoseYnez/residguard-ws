import { importJWK, type CryptoKey } from "jose";
import { config } from "../../config";

// Cliente del JWKS de auth_ws (GET /auth/.well-known/keys). residguard_ws es un
// RESOURCE SERVER: valida los access tokens LOCALMENTE con la clave PÚBLICA de
// cada par cliente-app (Ed25519), sin poder emitir tokens y sin depender de
// auth_ws en caliente:
//
//   - El set de claves se cachea en memoria (TTL de horas).
//   - Ante un `kid` desconocido se refresca una vez (clave nueva / rotación),
//     con rate-limit anti-stampede.
//   - Si auth_ws está caído, la última caché válida sigue validando: un fallo
//     de red NUNCA tumba la autenticación de residguard_ws.
//
// Cada entrada conserva el `appCode` del JWK (miembro extra del JWKS de
// auth_ws) para que el verificador exija que el token pertenezca a ESTA app.

const JWKS_PATH = "/auth/.well-known/keys";

/** Horas: el material público cambia solo en alta/rotación de contrataciones. */
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
/** Ventana mínima entre refrescos forzados por `kid` desconocido (anti-stampede). */
const MIN_REFETCH_MS = 30 * 1000;
/** Corte de la petición al JWKS para no colgar el request si auth_ws no responde. */
const FETCH_TIMEOUT_MS = 5000;

export interface VerificationKey {
  /** Clave pública lista para `jwtVerify`. */
  readonly key: CryptoKey;
  /** appCode (core.apps.code) dueño de esta clave: ancla de autorización. */
  readonly appCode: string;
}

interface RawJwk {
  readonly kty?: string;
  readonly crv?: string;
  readonly x?: string;
  readonly alg?: string;
  readonly kid?: string;
  readonly appCode?: string;
}

let cache = new Map<string, VerificationKey>();
let cachedAt = 0;
let lastFetchAttempt = 0;
/** Single-flight: refrescos concurrentes comparten una sola petición. */
let inflight: Promise<boolean> | null = null;

async function fetchJwks(): Promise<Map<string, VerificationKey>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`${config.authWsBaseUrl}${JWKS_PATH}`, {
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`JWKS respondió ${res.status}`);
    }
    const body = (await res.json()) as { keys?: RawJwk[] };
    const next = new Map<string, VerificationKey>();
    for (const jwk of body.keys ?? []) {
      if (
        jwk.kty !== "OKP" ||
        jwk.crv !== "Ed25519" ||
        typeof jwk.x !== "string" ||
        typeof jwk.kid !== "string" ||
        typeof jwk.appCode !== "string"
      ) {
        // JWK incompleto o de otro tipo: no es seleccionable, se omite.
        continue;
      }
      const key = await importJWK({ kty: jwk.kty, crv: jwk.crv, x: jwk.x }, "EdDSA");
      // importJWK de una clave pública OKP devuelve siempre CryptoKey, no bytes.
      if (!(key instanceof Uint8Array)) {
        next.set(jwk.kid, { key, appCode: jwk.appCode });
      }
    }
    return next;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Refresca la caché. Devuelve true si trajo un set nuevo. Ante error (auth_ws
 * caído) NO descarta la caché previa: el servicio sigue validando con lo último
 * conocido. Single-flight + rate-limit para no martillar a auth_ws.
 */
async function refresh(): Promise<boolean> {
  if (inflight !== null) {
    return inflight;
  }
  lastFetchAttempt = Date.now();
  inflight = (async () => {
    try {
      const next = await fetchJwks();
      cache = next;
      cachedAt = Date.now();
      return true;
    } catch {
      return false; // se conserva la caché vigente
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/**
 * Resuelve la clave de verificación por `kid`. Refresca si la caché está
 * caducada o el `kid` no aparece (clave nueva / rotación), respetando el
 * rate-limit. Devuelve null si tras refrescar sigue sin existir.
 */
export async function resolveVerificationKey(kid: string): Promise<VerificationKey | null> {
  const now = Date.now();
  const fresh = now - cachedAt < CACHE_TTL_MS;
  const hit = cache.get(kid);

  if (hit !== undefined && fresh) {
    return hit;
  }
  // Caché caducada, o `kid` ausente y fuera de la ventana anti-stampede.
  if (!fresh || (hit === undefined && now - lastFetchAttempt > MIN_REFETCH_MS)) {
    await refresh();
    return cache.get(kid) ?? null;
  }
  return hit ?? null;
}
