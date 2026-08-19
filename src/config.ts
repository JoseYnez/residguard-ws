import "dotenv/config";
import { Verifiers as V } from "structure-verifier";

// Validación del entorno al boot: si falta algo, el proceso no arranca.
// Las propiedades no declaradas de process.env se descartan.
const envV = new V.ObjectNotNull({
    DATABASE_URL: new V.StringNotNull({ minLength: 1 }),
    AUTH_WS_BASE_URL: new V.StringNotNull({ minLength: 1 }),
    // Base de admin_ws (sin barra final): la SUPERFICIE TENANT `/tenant/v1` con
    // la que este servicio invita usuarios del cliente (decisión #23 de
    // admin_project). Distinta de AUTH_WS_BASE_URL: auth_ws emite/valida
    // sesiones; admin_ws administra identidades. Las llamadas viajan con el
    // access token del usuario final — no hay credencial de servicio.
    ADMIN_WS_BASE_URL: new V.StringNotNull({ minLength: 1 }),
    // Código del rol (auth.roles.code) que se asigna al invitar a una persona
    // del padrón. Debe existir como rol asignable de residguard-app en la
    // plataforma (sembrado por 99_patch_residguard_resident_role.sql).
    RESIDENT_ROLE_CODE: new V.StringNotNull({
        defaultValue: "community_resident",
        minLength: 1,
        maxLength: 64,
    }),
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
    // Zona horaria de OPERACIÓN, fijada en cada sesión de PostgreSQL.
    // El instante de un pago llega ya resuelto desde el navegador (ISO-8601
    // con su offset), así que esto NO decide qué se guarda. Decide cómo se
    // agrupa por día: `paid_at::date`, `now()` y `CURRENT_DATE` se evalúan en
    // la zona de la sesión, y con la sesión en UTC un pago de las 19:00 cae en
    // el día siguiente — se saldría del corte de saldo y del filtro de fechas.
    // Es una sola zona a propósito: el calendario de negocio es el de la
    // comunidad, no el de cada equipo que captura.
    DB_TIMEZONE: new V.StringNotNull({
        defaultValue: "America/Mexico_City",
        minLength: 1,
        maxLength: 64,
    }),
    // Tope de vigencia (días) de un pase de visita. Existe para que no queden
    // pases eternos que nadie recuerda haber creado: un recurrente de servicio
    // se renueva, no se emite "para siempre". La BD no lo conoce — es política
    // de negocio, no integridad.
    // Base de storage-service (sin barra final): donde viven los ARCHIVOS de
    // las evidencias de pago. La SPA sube directo con el Bearer del usuario;
    // este servicio usa el canal server-to-server (X-Api-Key) para validar
    // los archivos que una evidencia declara y para emitir los enlaces
    // firmados de descarga TRAS validar el alcance de la evidencia — el RBAC
    // de storage es por app, no por recurso, y la frontera por recurso vive
    // aqui.
    STORAGE_WS_BASE_URL: new V.StringNotNull({ minLength: 1 }),
    // API key emitida por storage-service para el par (cliente, residguard-app).
    // ⚠ Es POR TENANT: con un solo cliente real basta esta env; el dia que
    // haya dos, esto debe volverse un mapa tenant → key.
    STORAGE_API_KEY: new V.StringNotNull({ minLength: 1 }),
    // Vigencia (segundos) de los enlaces firmados de descarga que este
    // servicio emite. Corta a proposito: el enlace se pide al momento de ver
    // el comprobante, no se almacena.
    STORAGE_LINK_TTL_SEC: new V.NumberNotNull({
        defaultValue: 300,
        min: 30,
        max: 3600,
        maxDecimalPlaces: 0,
    }),
    VISIT_MAX_VALIDITY_DAYS: new V.NumberNotNull({
        defaultValue: 180,
        min: 1,
        max: 3650,
        maxDecimalPlaces: 0,
    }),
    // Tope de pases VIGENTES por unidad (freno anti-abuso del portal: una
    // unidad no necesita cientos de códigos vivos a la vez).
    VISIT_MAX_ACTIVE_PER_UNIT: new V.NumberNotNull({
        defaultValue: 100,
        min: 1,
        max: 10000,
        maxDecimalPlaces: 0,
    }),
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

// A admin_ws viaja el access token del usuario: por HTTP plano un on-path se lo
// queda (y con él, la superficie tenant completa de ese usuario).
if (isProd && !env.ADMIN_WS_BASE_URL.startsWith("https://")) {
    // eslint-disable-next-line no-console
    console.error("En producción ADMIN_WS_BASE_URL debe usar https://");
    process.exit(1);
}

// A storage viaja la API key del servicio: por HTTP plano un on-path se la
// queda (y con ella, el bucket completo del cliente).
if (isProd && !env.STORAGE_WS_BASE_URL.startsWith("https://")) {
    // eslint-disable-next-line no-console
    console.error("En producción STORAGE_WS_BASE_URL debe usar https://");
    process.exit(1);
}

export const config = {
    databaseUrl: env.DATABASE_URL,
    authWsBaseUrl: env.AUTH_WS_BASE_URL,
    adminWsBaseUrl: env.ADMIN_WS_BASE_URL.replace(/\/+$/u, ""),
    residentRoleCode: env.RESIDENT_ROLE_CODE,
    storageWsBaseUrl: env.STORAGE_WS_BASE_URL.replace(/\/+$/u, ""),
    storageApiKey: env.STORAGE_API_KEY,
    storageLinkTtlSec: env.STORAGE_LINK_TTL_SEC,
    residguardAppCode: env.RESIDGUARD_APP_CODE,
    permissionsStaleGraceMs: env.PERMISSIONS_STALE_GRACE_MINUTES * 60_000,
    corsOrigins: env.CORS_ORIGINS.split(",")
        .map((o) => o.trim())
        .filter((o) => o.length > 0),
    dbTimezone: env.DB_TIMEZONE,
    visitMaxValidityDays: env.VISIT_MAX_VALIDITY_DAYS,
    visitMaxActivePerUnit: env.VISIT_MAX_ACTIVE_PER_UNIT,
    port: env.PORT,
    host: env.HOST,
    logLevel: env.LOG_LEVEL,
} as const;
