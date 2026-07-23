import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { verifyAccessToken, type AccessTokenClaims } from "./access_token";

// Hook global de autenticación: salvo rutas públicas, todo request exige un
// access token Bearer válido (firma Ed25519 local + app ResidGuard). Los
// claims verificados quedan en `request.auth` para que los endpoints
// construyan el AuditContext y acoten el alcance por comunidad.

declare module "fastify" {
  interface FastifyRequest {
    /** Claims del access token validado; presente solo tras pasar el hook. */
    auth?: AccessTokenClaims;
  }
}

/** Rutas sin autenticación. */
const DEFAULT_PUBLIC_PATHS = ["/health"];

function readBearerToken(req: FastifyRequest): string | null {
  const header = req.headers.authorization;
  if (header === undefined || !header.startsWith("Bearer ")) {
    return null;
  }
  return header.slice("Bearer ".length);
}

/**
 * Recupera los claims ya validados de un request autenticado. Lanza si se
 * invoca en una ruta sin el hook (bug de cableado, no condición de runtime).
 */
export function requireAuth(req: FastifyRequest): AccessTokenClaims {
  if (req.auth === undefined) {
    throw new Error("requireAuth llamado en una ruta sin hook de autenticación");
  }
  return req.auth;
}

/**
 * Registra el hook `onRequest` de autenticación. Debe registrarse ANTES de las
 * rutas protegidas. `publicPaths` extiende la lista exenta.
 */
export function registerAuthentication(
  app: FastifyInstance,
  options: { publicPaths?: readonly string[] } = {},
): void {
  const publicPaths = new Set<string>([...DEFAULT_PUBLIC_PATHS, ...(options.publicPaths ?? [])]);

  app.addHook("onRequest", async (req: FastifyRequest, reply: FastifyReply) => {
    // El preflight CORS (OPTIONS) no lleva Bearer: lo resuelve el handler de
    // CORS, nunca este hook (autenticarlo lo rompería con un 401).
    if (req.method === "OPTIONS") {
      return;
    }
    const routeUrl = req.routeOptions.url;
    // Ruta no emparejada (404) o pública: el hook no aplica.
    if (routeUrl === undefined || publicPaths.has(routeUrl)) {
      return;
    }

    const token = readBearerToken(req);
    if (token === null) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    const claims = await verifyAccessToken(token);
    if (claims === null) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    req.auth = claims;
  });
}
