import { config } from "../../config";

// Cliente HTTP de push-service (proyecto notificacion_project) por el canal
// server-to-server: `X-Api-Key` emitida para el par (cliente, residguard-app).
// Mismo espíritu que storage_client: no decide nada, transporta.
//
// Un solo uso hoy: ENCOLAR un aviso a usuarios (por su user_id global, el
// mismo `members.user_id` que este servicio ya guarda al vincular una persona
// del padrón). push-service abre el aviso en abanico a los dispositivos que
// cada usuario tenga registrados; si nadie tiene, responde igual con
// deliveriesTotal = 0 — no es un error.
//
// APAGADO SIN CONFIG: con PUSH_WS_BASE_URL / PUSH_API_KEY vacías, `enabled`
// es false y `enqueue` no sale a la red. Así un despliegue sin push-service
// sigue operando: avisar es un extra del negocio, nunca su condición.
//
// ⚠ La API key es POR TENANT (así la emite push-service). Hoy hay un solo
// cliente real y basta `config.pushApiKey`; con más tenants esto debe volverse
// un mapa tenant → key, igual que en storage.

export interface PushEnqueueInput {
    /** user_id globales (auth.users.id) de los destinatarios. 1..5000. */
    readonly recipients: readonly string[];
    readonly title: string;
    readonly body?: string;
    /** A dónde navega la SPA al tocar la notificación (ruta relativa al origen). */
    readonly clickUrl?: string;
    /** Colapsa avisos repetidos del mismo hecho. */
    readonly tag?: string;
    readonly urgency?: "very_low" | "low" | "normal" | "high";
    readonly ttlSec?: number;
    /** Reintentar el encolado no avisa dos veces. */
    readonly idempotencyKey?: string;
    /** Payload libre para la SPA. */
    readonly data?: Record<string, unknown>;
    /** Correlación con este dominio (no viaja al navegador). */
    readonly metadata?: Record<string, unknown>;
}

export interface PushEnqueueResult {
    readonly id: string;
    readonly deduplicated: boolean;
    readonly deliveriesTotal: number;
    readonly recipientsWithDevices: readonly string[];
    readonly recipientsWithoutDevices: readonly string[];
}

/** Fallo con respuesta de push-service (4xx/5xx) o de transporte (status 0). */
export interface PushFailure {
    readonly ok: false;
    /** 0 = no hubo respuesta (red, timeout, DNS). */
    readonly status: number;
    readonly error: string;
    readonly message: string;
}

export interface PushSuccess<T> {
    readonly ok: true;
    readonly status: number;
    readonly value: T;
}

export type PushResponse<T> = PushSuccess<T> | PushFailure;

// Corto a propósito: el que llama nunca espera esto en el camino del usuario,
// pero tampoco hay que dejar una promesa colgada minutos si push-service no
// contesta.
const TIMEOUT_MS = 5_000;

async function request<T>(options: {
    readonly method: "GET" | "POST";
    readonly path: string;
    readonly body?: unknown;
}): Promise<PushResponse<T>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
        const response = await fetch(`${config.pushWsBaseUrl}${options.path}`, {
            method: options.method,
            headers: {
                "X-Api-Key": config.pushApiKey,
                ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
            },
            ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
            signal: controller.signal,
        });

        const text = await response.text();
        const parsed: unknown = text.length === 0 ? null : safeJson(text);

        if (!response.ok) {
            const body = (parsed ?? {}) as { error?: unknown; message?: unknown };
            return {
                ok: false,
                status: response.status,
                error: typeof body.error === "string" ? body.error : "http_error",
                message:
                    typeof body.message === "string"
                        ? body.message
                        : `push-service respondió ${response.status}`,
            };
        }

        return { ok: true, status: response.status, value: parsed as T };
    } catch (err) {
        const aborted = err instanceof Error && err.name === "AbortError";
        return {
            ok: false,
            status: 0,
            error: aborted ? "timeout" : "network_error",
            message: aborted
                ? `push-service no respondió en ${TIMEOUT_MS} ms`
                : err instanceof Error
                  ? err.message
                  : "fallo de red hablando con push-service",
        };
    } finally {
        clearTimeout(timer);
    }
}

function safeJson(text: string): unknown {
    try {
        return JSON.parse(text);
    } catch {
        return null;
    }
}

export const pushClient = {
    /** false = sin PUSH_WS_BASE_URL / PUSH_API_KEY: el canal está apagado. */
    get enabled(): boolean {
        return config.pushWsBaseUrl.length > 0 && config.pushApiKey.length > 0;
    },

    /**
     * Encola un aviso. 201 nuevo / 200 deduplicado — los dos son éxito. Con el
     * canal apagado devuelve un failure `disabled` sin tocar la red, para que
     * el llamador lo registre y siga.
     */
    async enqueue(input: PushEnqueueInput): Promise<PushResponse<PushEnqueueResult>> {
        if (!this.enabled) {
            return {
                ok: false,
                status: 0,
                error: "disabled",
                message: "push-service no está configurado (PUSH_WS_BASE_URL / PUSH_API_KEY)",
            };
        }
        return request<PushEnqueueResult>({
            method: "POST",
            path: "/v1/push/messages",
            body: input,
        });
    },
};
