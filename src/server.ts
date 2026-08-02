import Fastify from "fastify";
import {
    serializerCompiler,
    validatorCompiler,
    type StructureVerifierTypeProvider,
} from "structure-verifier/fastify";
import { config } from "./config";
import { registerAuthentication } from "./core/auth/authenticate";
import { closePool } from "./core/db/pool";
import { registerErrorHandler } from "./core/http/error_handler";
import { communitiesV1Routes } from "./api/communities/v1/communities_v1.routes";
import { communityMembersV1Routes } from "./api/community-members/v1/community_members_v1.routes";
import { membersV1Routes } from "./api/members/v1/members_v1.routes";
import { unitsV1Routes } from "./api/units/v1/units_v1.routes";
import { unitMembersV1Routes } from "./api/unit-members/v1/unit_members_v1.routes";
import { feesV1Routes } from "./api/fees/v1/fees_v1.routes";
import { feePeriodsV1Routes } from "./api/fee-periods/v1/fee_periods_v1.routes";
import { chargesV1Routes } from "./api/charges/v1/charges_v1.routes";
import { paymentsV1Routes } from "./api/payments/v1/payments_v1.routes";
import { waiversV1Routes } from "./api/waivers/v1/waivers_v1.routes";
import { expenseCategoriesV1Routes } from "./api/expense-categories/v1/expense_categories_v1.routes";
import { expensesV1Routes } from "./api/expenses/v1/expenses_v1.routes";
import { fundAdjustmentsV1Routes } from "./api/fund-adjustments/v1/fund_adjustments_v1.routes";
import { reportsV1Routes } from "./api/reports/v1/reports_v1.routes";

async function main(): Promise<void> {
    // En desarrollo usamos pino-pretty para que la línea de acceso salga limpia
    // (sin el envoltorio JSON). En producción se mantiene JSON para agregadores.
    const isProd = process.env.NODE_ENV === "production";
    const app = Fastify({
        trustProxy: true,
        logger: {
            level: config.logLevel,
            ...(isProd
                ? {}
                : {
                      transport: {
                          target: "pino-pretty",
                          options: {
                              colorize: true,
                              translateTime: false,
                              ignore: "pid,hostname,reqId,level,time",
                              messageFormat: "{msg}",
                              hideObject: true,
                          },
                      },
                  }),
        },
        // El log de acceso lo emitimos nosotros (hook onResponse) con un formato
        // legible; se desactiva el req/res en JSON de Fastify para no duplicar.
        disableRequestLogging: true,
    }).withTypeProvider<StructureVerifierTypeProvider>();

    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    registerErrorHandler(app);

    // Log de acceso legible: «fecha-hora método path status tiempo».
    app.addHook("onResponse", async (request, reply) => {
        const now = new Date();
        const pad = (n: number, w = 2) => String(n).padStart(w, "0");
        const ts =
            `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ` +
            `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}.${pad(now.getMilliseconds(), 3)}`;
        const ms = reply.elapsedTime.toFixed(1);
        request.log.info(
            `${ts} ${request.method} ${request.url} ${reply.statusCode} ${ms}ms`,
        );
    });

    // CORS manual (mismo patrón que admin_ws/auth_ws, sin plugin para evitar
    // incompatibilidades de versión). Solo se reflejan orígenes de la lista
    // blanca: como las peticiones llevan credenciales, NUNCA se permite un
    // origen arbitrario junto a Allow-Credentials. Se registra ANTES del hook
    // de autenticación para que incluso un 401 lleve cabeceras CORS.
    const allowedOrigins = new Set(config.corsOrigins);
    app.addHook("onRequest", async (req, reply) => {
        const origin = req.headers.origin;
        if (origin !== undefined && allowedOrigins.has(origin)) {
            reply.header("Access-Control-Allow-Origin", origin);
            reply.header("Vary", "Origin");
            reply.header("Access-Control-Allow-Methods", "GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS");
            reply.header("Access-Control-Allow-Headers", "Content-Type,Authorization");
            reply.header("Access-Control-Allow-Credentials", "true");
            reply.header("Access-Control-Max-Age", "86400");
        }
    });

    // Preflight: responde 204 con las cabeceras CORS ya fijadas por el hook.
    app.options("*", (_req, reply) => {
        reply.code(204).send();
    });

    app.get("/health", async () => ({ status: "ok" }));

    // Hook global de autenticación: valida el access token con la clave
    // pública de auth_ws antes de cada endpoint. Solo `/health` queda exento.
    registerAuthentication(app);

    // Rutas por recurso.
    await app.register(communitiesV1Routes);
    await app.register(communityMembersV1Routes);
    await app.register(membersV1Routes);
    await app.register(unitsV1Routes);
    await app.register(unitMembersV1Routes);
    await app.register(feesV1Routes);
    await app.register(feePeriodsV1Routes);
    await app.register(chargesV1Routes);
    await app.register(paymentsV1Routes);
    await app.register(waiversV1Routes);
    await app.register(expenseCategoriesV1Routes);
    await app.register(expensesV1Routes);
    await app.register(fundAdjustmentsV1Routes);
    await app.register(reportsV1Routes);

    await app.listen({ port: config.port, host: config.host });

    // Apagado ordenado (deploy/restart del contenedor: tini reenvía SIGTERM):
    // deja de aceptar conexiones, espera los requests en vuelo (app.close) y
    // cierra el pool de PostgreSQL. Idempotente ante señales repetidas; si el
    // cierre se atora, un segundo Ctrl+C / SIGTERM fuerza la salida.
    let shuttingDown = false;
    const shutdown = (signal: string): void => {
        if (shuttingDown) {
            process.exit(1);
        }
        shuttingDown = true;
        app.log.info(`${signal} recibido: cerrando residguard_ws…`);
        void app
            .close()
            .then(() => closePool())
            .then(() => process.exit(0))
            .catch((err) => {
                app.log.error(err, "fallo durante el apagado ordenado");
                process.exit(1);
            });
    };
    process.on("SIGTERM", () => shutdown("SIGTERM"));
    process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error("Fallo al arrancar residguard_ws:", err);
    process.exit(1);
});
