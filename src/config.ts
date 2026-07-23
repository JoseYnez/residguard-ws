import "dotenv/config";
import { Verifiers as V } from "structure-verifier";

// Validación del entorno al boot: si falta algo, el proceso no arranca.
// Las propiedades no declaradas de process.env se descartan.
const envV = new V.ObjectNotNull({
    DATABASE_URL: new V.StringNotNull({ minLength: 1 }),
    AUTH_WS_BASE_URL: new V.StringNotNull({ minLength: 1 }),
    // appCode de ResidGuard en el catálogo de la plataforma (core.apps.code del
    // sistema de auth). Es el ancla de autorización del resource server: un
    // access token solo se acepta si su clave de firma (JWK del JWKS) pertenece
    // a este appCode — un token de otra app se rechaza aunque su firma sea válida.
    RESIDGUARD_APP_CODE: new V.StringNotNull({
        defaultValue: "residguard-app",
        minLength: 1,
        maxLength: 64,
    }),
    // Ventana de gracia (minutos) durante la cual, si auth_ws no responde, se
    // siguen sirviendo los permisos cacheados de una sesión aunque su TTL haya
    // vencido. A diferencia de admin_ws, este servicio no comparte la BD de la
    // plataforma y no tiene resolver local al que degradar. Nunca concede un
    // permiso que auth_ws no haya afirmado: solo relaja la frescura. 0 = fallar
    // cerrado en cuanto vence el TTL.
    PERMISSIONS_STALE_GRACE_MINUTES: new V.NumberNotNull({
        defaultValue: 15,
        min: 0,
        max: 1440,
    }),
    // Lista blanca de orígenes CORS, separados por coma. Vacío = ningún origen
    // cruzado (mismo origen sigue funcionando). Como las peticiones llevan
    // credenciales, NUNCA se refleja un origen fuera de esta lista.
    CORS_ORIGINS: new V.StringNotNull({ defaultValue: "" }),
    PORT: new V.NumberNotNull({ defaultValue: 3003, min: 1, max: 65535 }),
    HOST: new V.StringNotNull({ defaultValue: "0.0.0.0" }),
    LOG_LEVEL: new V.StringNotNull({
        defaultValue: "info",
        in: ["fatal", "error", "warn", "info", "debug", "trace"],
    }),
});

const result = envV.safeCheck(process.env);

if (!result.success) {
    // eslint-disable-next-line no-console
    console.error("Configuración de entorno inválida:", result.error.errorsObj);
    process.exit(1);
}

const env = result.value;

const isProd = process.env.NODE_ENV === "production";

// El JWKS de auth_ws es el ÚNICO ancla de confianza para validar tokens: en
// producción debe viajar por HTTPS o un atacante on-path podría inyectar claves.
if (isProd && !env.AUTH_WS_BASE_URL.startsWith("https://")) {
    // eslint-disable-next-line no-console
    console.error("En producción AUTH_WS_BASE_URL debe usar https://");
    process.exit(1);
}

export const config = {
    databaseUrl: env.DATABASE_URL,
    authWsBaseUrl: env.AUTH_WS_BASE_URL,
    residguardAppCode: env.RESIDGUARD_APP_CODE,
    permissionsStaleGraceMs: env.PERMISSIONS_STALE_GRACE_MINUTES * 60_000,
    corsOrigins: env.CORS_ORIGINS.split(",")
        .map((o) => o.trim())
        .filter((o) => o.length > 0),
    port: env.PORT,
    host: env.HOST,
    logLevel: env.LOG_LEVEL,
} as const;
