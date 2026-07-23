import { decodeProtectedHeader, jwtVerify } from "jose";
import { config } from "../../config";
import { resolveVerificationKey } from "./jwks";

// Verificación LOCAL del access token. residguard_ws nunca emite ni llama a
// auth_ws para validar: comprueba firma Ed25519 + exp + issuer contra la clave
// PÚBLICA del JWKS y exige que el token pertenezca a ESTA app (ResidGuard).
// El tenant viaja SIEMPRE como claim (`customer_id`), nunca como parámetro.

/** Emisor esperado (auth_ws es el único firmador de la plataforma). */
const ISSUER = "auth_ws";

/** Claims verificados del access token (espejo del contrato de auth_ws). */
export interface AccessTokenClaims {
  /** user_id global (claim `sub`) — es el id del espejo core.users. */
  readonly sub: string;
  /** app_customer_user_id (la tripleta) — claim `acu`. */
  readonly acu: string;
  /** customer_id (tenant) — viaja como claim, nunca como parámetro. */
  readonly customerId: string;
  /** app_id de la contratación cliente-app. */
  readonly appId: string;
  /** session id (claim `sid`). */
  readonly sid: string;
  /** iat del JWT (segundos UNIX). */
  readonly issuedAt: number;
  /** exp del JWT (segundos UNIX). */
  readonly expiresAt: number;
}

/**
 * Verifica un access token. Devuelve los claims si la firma es válida, está
 * vigente, el issuer es auth_ws y la clave pertenece a ESTA app
 * (`config.residguardAppCode`); en cualquier otro caso devuelve null
 * (respuesta opaca: no se distingue el motivo). Un token de otra app —aunque
 * su firma sea válida— se rechaza aquí.
 */
export async function verifyAccessToken(token: string): Promise<AccessTokenClaims | null> {
  let header: { alg?: string; kid?: string };
  try {
    header = decodeProtectedHeader(token);
  } catch {
    return null;
  }
  if (header.alg !== "EdDSA" || typeof header.kid !== "string") {
    return null;
  }

  const resolved = await resolveVerificationKey(header.kid);
  if (resolved === null) {
    return null;
  }
  // Ancla de autorización: la clave debe ser la de la app ResidGuard. Esto fija
  // que app_id sea el propio sin necesidad de conocer su UUID (el `kid` mapea
  // 1:1 a un par cliente-app y el JWKS etiqueta cada clave con su appCode).
  if (resolved.appCode !== config.residguardAppCode) {
    return null;
  }

  try {
    const { payload } = await jwtVerify(token, resolved.key, {
      issuer: ISSUER,
      algorithms: ["EdDSA"],
    });
    if (
      typeof payload.sub !== "string" ||
      typeof payload.acu !== "string" ||
      typeof payload.customer_id !== "string" ||
      typeof payload.app_id !== "string" ||
      typeof payload.sid !== "string" ||
      typeof payload.iat !== "number" ||
      typeof payload.exp !== "number"
    ) {
      return null;
    }
    return {
      sub: payload.sub,
      acu: payload.acu,
      customerId: payload.customer_id,
      appId: payload.app_id,
      sid: payload.sid,
      issuedAt: payload.iat,
      expiresAt: payload.exp,
    };
  } catch {
    // Firma inválida, expirado o issuer distinto.
    return null;
  }
}
