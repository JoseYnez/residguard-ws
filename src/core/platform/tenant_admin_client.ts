import { config } from "../../config";

// Cliente HTTP de la SUPERFICIE TENANT de admin_ws (decisión #23 de
// admin_project): invitar usuarios del cliente y consultar su estado desde
// esta app. Espejo mínimo de `admin_project/libs/platform-tenant-admin`,
// reescrito aquí a propósito: una dependencia `file:../admin_project/...`
// rompe los builds de plataforma (Nixpacks solo copia este repo — mismo
// motivo por el que structure-verifier se publicó en npm), y de los 12
// métodos de la librería este servicio solo necesita cinco.
//
// No decide nada: transporta. El access token del USUARIO viaja tal cual en
// el Authorization — admin_ws deriva de sus claims la empresa y la app, y
// aplica los permisos `platform_*`. No hay credencial de servicio que filtrar,
// y no existe ningún parámetro con el que pedir datos de otro cliente.

/** Fallo con respuesta de admin_ws (4xx/5xx) o de transporte (status 0). */
export interface TenantAdminFailure {
    readonly ok: false;
    /** 0 = no hubo respuesta (red, timeout, DNS). */
    readonly status: number;
    /** Código del cuerpo tipado de admin_ws (`forbidden`, `not_found`, …). */
    readonly error: string;
    readonly message: string;
}

export interface TenantAdminSuccess<T> {
    readonly ok: true;
    readonly status: number;
    readonly value: T;
}

export type TenantAdminResponse<T> = TenantAdminSuccess<T> | TenantAdminFailure;

/** Un miembro del cliente en la plataforma (identidad global acotada). */
export interface PlatformMember {
    readonly userId: string;
    readonly alias: string;
    readonly email: string;
    readonly status: string;
    /** true = todavía no fijó su contraseña (invitación sin canjear). */
    readonly invitationPending: boolean;
}

/** Un rol asignable de la app dentro del cliente. */
export interface AssignableRole {
    readonly id: string;
    readonly code: string;
    readonly name: string;
    /** false = el actor no tiene todos los permisos del rol; no puede darlo. */
    readonly assignable: boolean;
}

export interface InviteInput {
    readonly email: string;
    /** Solo se usa si la identidad global no existe todavía. */
    readonly fullName: string;
    readonly apps: readonly { readonly appId: string; readonly roleIds: readonly string[] }[];
}

export interface InvitationResult {
    readonly userId: string;
}

const TIMEOUT_MS = 10_000;

async function request<T>(options: {
    readonly method: "GET" | "POST";
    readonly path: string;
    readonly accessToken: string;
    readonly body?: unknown;
}): Promise<TenantAdminResponse<T>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
        const response = await fetch(`${config.adminWsBaseUrl}${options.path}`, {
            method: options.method,
            headers: {
                Authorization: `Bearer ${options.accessToken}`,
                ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
            },
            ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
            signal: controller.signal,
        });

        const text = await response.text();
        const parsed: unknown = text.length === 0 ? null : safeJson(text);

        if (!response.ok) {
            const body = (parsed ?? {}) as { error?: unknown; message?: unknown; errors?: unknown };
            return {
                ok: false,
                status: response.status,
                error: typeof body.error === "string" ? body.error : "http_error",
                message:
                    typeof body.message === "string"
                        ? body.message
                        : // 400 de validación de structure-verifier: `{ errors: [...] }`.
                          body.errors !== undefined
                          ? JSON.stringify(body.errors)
                          : `admin_ws respondió ${response.status}`,
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
                ? `admin_ws no respondió en ${TIMEOUT_MS} ms`
                : err instanceof Error
                  ? err.message
                  : "fallo de red hablando con admin_ws",
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

/** Segmento de ruta: los ids son UUID, pero nunca se concatena sin escapar. */
function seg(value: string): string {
    return encodeURIComponent(value);
}

export const tenantAdminClient = {
    /** Estado de un miembro del cliente (para `invitationPending`). */
    async getMember(accessToken: string, userId: string): Promise<TenantAdminResponse<PlatformMember>> {
        return request<PlatformMember>({
            method: "GET",
            path: `/tenant/v1/members/${seg(userId)}`,
            accessToken,
        });
    },

    /** Roles asignables de la app (para localizar el rol de residente). */
    async listAssignableRoles(
        accessToken: string,
        appId: string,
    ): Promise<TenantAdminResponse<{ items: AssignableRole[] }>> {
        return request<{ items: AssignableRole[] }>({
            method: "GET",
            path: `/tenant/v1/apps/${seg(appId)}/roles`,
            accessToken,
        });
    },

    /**
     * Invita (o re-usa la identidad si el email ya tiene cuenta: multipertenencia).
     * El correo, el token y su caducidad los gestiona admin_ws; el token crudo
     * nunca viaja en la respuesta. La respuesta es idéntica exista o no la
     * cuenta — a propósito: no se puede enumerar quién tiene usuario.
     */
    async invite(accessToken: string, input: InviteInput): Promise<TenantAdminResponse<InvitationResult>> {
        return request<InvitationResult>({
            method: "POST",
            path: "/tenant/v1/members/invitations",
            accessToken,
            body: input,
        });
    },

    /** Reemite el token y reenvía el correo. Respuesta uniforme (204). */
    async resendInvitation(accessToken: string, userId: string): Promise<TenantAdminResponse<unknown>> {
        return request<unknown>({
            method: "POST",
            path: `/tenant/v1/members/${seg(userId)}/invitations/resend`,
            accessToken,
        });
    },

    /** Anula la invitación viva. No toca la identidad ni el acceso. */
    async cancelInvitation(accessToken: string, userId: string): Promise<TenantAdminResponse<unknown>> {
        return request<unknown>({
            method: "POST",
            path: `/tenant/v1/members/${seg(userId)}/invitations/cancel`,
            accessToken,
        });
    },
};
