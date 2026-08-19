import { config } from "../../config";

// Cliente HTTP de storage-service (proyecto storage_project) por el canal
// server-to-server: `X-Api-Key` emitida para el par (cliente, residguard-app).
// Mismo espíritu que tenant_admin_client: no decide nada, transporta.
//
// Dos usos, los dos al servicio de las evidencias de pago:
//   * getFile     — validar que un archivo que una evidencia declara EXISTE en
//                   el bucket de la app y copiar su metadata (espejo en
//                   billing.payment_evidence_files).
//   * createLink  — emitir el enlace firmado de descarga DESPUÉS de que este
//                   servicio validó el alcance de la evidencia. El RBAC de
//                   storage es por app, no por recurso: si la SPA descargara
//                   directo con el Bearer, cualquier usuario con permiso de
//                   lectura del bucket podría bajar el comprobante de otro con
//                   solo el UUID. La frontera por recurso vive aquí.
//
// ⚠ La API key es POR TENANT (así la emite storage). Hoy hay un solo cliente
// real y basta `config.storageApiKey`; con más tenants esto debe volverse un
// mapa tenant → key (la env ya lo advierte).

/** Fallo con respuesta de storage (4xx/5xx) o de transporte (status 0). */
export interface StorageFailure {
    readonly ok: false;
    /** 0 = no hubo respuesta (red, timeout, DNS). */
    readonly status: number;
    readonly error: string;
    readonly message: string;
}

export interface StorageSuccess<T> {
    readonly ok: true;
    readonly status: number;
    readonly value: T;
}

export type StorageResponse<T> = StorageSuccess<T> | StorageFailure;

/** Metadata de un archivo lógico en storage (lo que este servicio espeja). */
export interface StorageFileMetadata {
    readonly id: string;
    readonly filename: string;
    readonly contentType: string;
    readonly sizeBytes: number;
    readonly sha256: string;
}

/** Enlace temporal firmado: descarga sin credencial hasta que vence. */
export interface StorageDownloadLink {
    readonly url: string;
    readonly expiresAt: string;
}

const TIMEOUT_MS = 10_000;

async function request<T>(options: {
    readonly method: "GET" | "POST";
    readonly path: string;
    readonly body?: unknown;
}): Promise<StorageResponse<T>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
        const response = await fetch(`${config.storageWsBaseUrl}${options.path}`, {
            method: options.method,
            headers: {
                "X-Api-Key": config.storageApiKey,
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
                        : `storage respondió ${response.status}`,
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
                ? `storage no respondió en ${TIMEOUT_MS} ms`
                : err instanceof Error
                  ? err.message
                  : "fallo de red hablando con storage",
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

// Respuesta cruda de storage (snake_case, como la emite su API).
interface RawFileResponse {
    id: string;
    filename: string;
    content_type: string;
    size_bytes: number;
    sha256: string;
}

interface RawLinkResponse {
    url: string;
    expires_at: string;
}

export const storageClient = {
    /**
     * Metadata de un archivo por id. 404 de storage (inexistente, borrado o de
     * un bucket que la app no alcanza) llega como failure con status 404 — el
     * caller lo convierte en su propio error de negocio.
     */
    async getFile(fileId: string): Promise<StorageResponse<StorageFileMetadata>> {
        const result = await request<RawFileResponse>({
            method: "GET",
            path: `/v1/files/${fileId}`,
        });
        if (!result.ok) {
            return result;
        }
        const raw = result.value;
        return {
            ok: true,
            status: result.status,
            value: {
                id: raw.id,
                filename: raw.filename,
                contentType: raw.content_type,
                sizeBytes: Number(raw.size_bytes),
                sha256: raw.sha256,
            },
        };
    },

    /**
     * Enlace firmado de descarga. Se emite al momento de mostrar el archivo y
     * con vigencia corta (config.storageLinkTtlSec): el enlace descarga SIN
     * credencial, así que no se almacena ni se comparte más allá de la vista.
     */
    async createDownloadLink(fileId: string): Promise<StorageResponse<StorageDownloadLink>> {
        const result = await request<RawLinkResponse>({
            method: "POST",
            path: `/v1/files/${fileId}/link`,
            body: { expires_in_sec: config.storageLinkTtlSec },
        });
        if (!result.ok) {
            return result;
        }
        return {
            ok: true,
            status: result.status,
            value: { url: result.value.url, expiresAt: result.value.expires_at },
        };
    },
};
