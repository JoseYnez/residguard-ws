import type { FastifyRequest } from "fastify";
import { config } from "../../../config";
import { requireAuth } from "../../../core/auth/authenticate";
import { contextFor } from "../../../core/auth/community_access";
import { withTransaction } from "../../../core/db/with_transaction";
import { translatePgError, type MutationResult } from "../../../core/http/pg_errors";
import {
  tenantAdminClient,
  type TenantAdminFailure,
} from "../../../core/platform/tenant_admin_client";
import {
  membersRepository,
  type CreateMemberInput,
  type CreatePhoneInput,
  type ListMembersInput,
  type Member,
  type MemberDetail,
  type MemberPhone,
  type UpdateMemberInput,
} from "./members_v1.repository";

// Orquestación del recurso members. El acceso a la comunidad de la ruta ya lo
// garantizó requireCommunityAccess (preHandler); aquí solo se ejecuta la
// transacción de negocio y se traducen los errores esperables.
//
// INVITACIÓN (vínculo persona↔usuario): este controller además habla con la
// superficie tenant de admin_ws. El orden importa: primero la plataforma
// (invite: identidad + acceso + rol + correo), después la transacción local
// (espejo core.users + members.user_id). Si lo local fallara con el invite ya
// hecho, reintentar el MISMO botón converge: la plataforma es idempotente por
// email y linkUser es idempotente por userId.

const PG_MESSAGES = {
  conflict: "Ya hay una persona registrada con ese correo en esta comunidad.",
  reference: "La comunidad indicada no existe en esta cuenta.",
} as const;

const PHONE_PG_MESSAGES = {
  conflict: "La persona ya tiene registrado ese teléfono.",
  reference: "La persona indicada no existe en esta comunidad.",
} as const;

const LINK_PG_MESSAGES = {
  conflict: "Ese usuario ya está vinculado a otra persona de esta comunidad.",
  reference: "El usuario no está disponible en esta cuenta.",
} as const;

/** El access token crudo del request: viaja tal cual hacia admin_ws, que
 *  deriva de él la empresa/app y re-aplica los permisos `platform_*`. */
function bearerOf(req: FastifyRequest): string {
  const header = req.headers.authorization ?? "";
  return header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
}

/** Códigos con los que estos flujos pueden responder: los esperables de
 *  admin_ws pasan tal cual; cualquier otro (un 5xx suyo) se degrada a 502. */
export type PlatformFlowStatus = 400 | 401 | 403 | 404 | 409 | 429 | 502 | 503;

const PLATFORM_PASSTHROUGH: readonly PlatformFlowStatus[] = [400, 401, 403, 404, 409, 429];

/** Fallo HTTP tipado de los flujos que tocan la plataforma. */
export interface PlatformFlowError {
  readonly status: PlatformFlowStatus;
  readonly error: string;
  readonly message: string;
}

export type PlatformFlowResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: PlatformFlowError };

/** Estado del vínculo de la persona con la plataforma. */
export interface MemberUserLink {
  readonly userId: string | null;
  /** Email de la CUENTA de plataforma (puede diferir del email del padrón). */
  readonly email: string | null;
  /** null = hay vínculo pero la plataforma no pudo informar su estado. */
  readonly invitationPending: boolean | null;
}

/** admin_ws no respondió → 503 (no un 403: el permiso no se pudo evaluar). */
function translatePlatformFailure(failure: TenantAdminFailure): PlatformFlowError {
  if (failure.status === 0) {
    return {
      status: 503,
      error: "platform_unavailable",
      message: "La plataforma de usuarios no respondió. Intenta de nuevo en un momento.",
    };
  }
  const passthrough = PLATFORM_PASSTHROUGH.find((s) => s === failure.status);
  return {
    status: passthrough ?? 502,
    error: failure.error,
    message: failure.message,
  };
}

function flowError(
  status: PlatformFlowStatus,
  error: string,
  message: string,
): PlatformFlowResult<never> {
  return { ok: false, error: { status, error, message } };
}

export const membersController = {
  async list(
    req: FastifyRequest,
    input: ListMembersInput,
  ): Promise<{ items: Member[]; total: number }> {
    return withTransaction(contextFor(req), (tx) => membersRepository.list(tx, input));
  },

  async getById(
    req: FastifyRequest,
    communityId: string,
    id: string,
  ): Promise<MemberDetail | null> {
    return withTransaction(contextFor(req), (tx) =>
      membersRepository.getById(tx, communityId, id),
    );
  },

  async create(
    req: FastifyRequest,
    communityId: string,
    input: CreateMemberInput,
  ): Promise<MutationResult<MemberDetail>> {
    const claims = requireAuth(req);
    try {
      const member = await withTransaction(contextFor(req), (tx) =>
        membersRepository.create(tx, claims.customerId, communityId, input),
      );
      return { ok: true, value: member };
    } catch (err) {
      return { ok: false, error: translatePgError(err, PG_MESSAGES) };
    }
  },

  /** `null` (fuera de ok/error) cuando la persona no existe → 404 en la route. */
  async update(
    req: FastifyRequest,
    communityId: string,
    id: string,
    input: UpdateMemberInput,
  ): Promise<MutationResult<MemberDetail> | null> {
    try {
      const member = await withTransaction(contextFor(req), (tx) =>
        membersRepository.update(tx, communityId, id, input),
      );
      if (member === null) {
        return null;
      }
      return { ok: true, value: member };
    } catch (err) {
      return { ok: false, error: translatePgError(err, PG_MESSAGES) };
    }
  },

  async softDelete(req: FastifyRequest, communityId: string, id: string): Promise<boolean> {
    return withTransaction(contextFor(req), (tx) =>
      membersRepository.softDelete(tx, communityId, id),
    );
  },

  // --- Vínculo persona↔usuario (invitación vía plataforma) ---------------------

  /**
   * Invita a la persona del padrón como usuario de la plataforma y la vincula.
   * Un solo botón para ambos casos: si el email ya tiene cuenta (p. ej. la
   * misma persona en OTRA comunidad), admin_ws devuelve el userId existente sin
   * emitir token —la respuesta es idéntica a propósito— y aquí solo se vincula.
   *
   * NO inserta en community_members: un residente ve *sus unidades*, no la
   * comunidad. El alcance de operador sigue siendo cosa de /access.
   */
  async invite(
    req: FastifyRequest,
    communityId: string,
    memberId: string,
  ): Promise<PlatformFlowResult<MemberDetail>> {
    const claims = requireAuth(req);
    const bearer = bearerOf(req);

    // 1. La persona, en una transacción de solo lectura: existe, sin vincular
    //    y con correo (el correo del padrón ES la identidad que se invita).
    const member = await withTransaction(contextFor(req), (tx) =>
      membersRepository.getById(tx, communityId, memberId),
    );
    if (member === null) {
      return flowError(404, "not_found", "La persona no existe en esta comunidad.");
    }
    if (member.userId !== null) {
      return flowError(409, "conflict", "La persona ya está vinculada a un usuario.");
    }
    if (member.email === null) {
      return flowError(
        400,
        "invalid",
        "La persona no tiene correo registrado: captúralo antes de invitarla.",
      );
    }

    // 2. El rol de residente, localizado por código entre los asignables de
    //    ESTA app. Fallar aquí es configuración de plataforma, no permiso.
    const roles = await tenantAdminClient.listAssignableRoles(bearer, claims.appId);
    if (!roles.ok) {
      return { ok: false, error: translatePlatformFailure(roles) };
    }
    const residentRole = roles.value.items.find((r) => r.code === config.residentRoleCode);
    if (residentRole === undefined) {
      return flowError(
        503,
        "platform_misconfigured",
        `El rol de residente (${config.residentRoleCode}) no está sembrado en la plataforma.`,
      );
    }
    if (!residentRole.assignable) {
      return flowError(
        403,
        "forbidden",
        "No puedes conceder el rol de residente: te faltan sus permisos en esta aplicación.",
      );
    }

    // 3. La plataforma: identidad + membresía + acceso a esta app + rol + correo.
    const invited = await tenantAdminClient.invite(bearer, {
      email: member.email,
      fullName: member.fullName,
      apps: [{ appId: claims.appId, roleIds: [residentRole.id] }],
    });
    if (!invited.ok) {
      return { ok: false, error: translatePlatformFailure(invited) };
    }

    // 4. Lo local: espejo core.users + members.user_id, misma transacción.
    try {
      return await withTransaction(contextFor(req), async (tx) => {
        const outcome = await membersRepository.linkUser(tx, claims.customerId, communityId, memberId, {
          id: invited.value.userId,
          fullName: member.fullName,
          email: member.email!,
        });
        if (outcome === "not-found") {
          return flowError(404, "not_found", "La persona no existe en esta comunidad.");
        }
        if (outcome === "linked-to-other") {
          return flowError(409, "conflict", "La persona ya está vinculada a otro usuario.");
        }
        const detail = await membersRepository.getById(tx, communityId, memberId);
        return { ok: true as const, value: detail! };
      });
    } catch (err) {
      const business = translatePgError(err, LINK_PG_MESSAGES);
      return flowError(business.kind === "conflict" ? 409 : 400, business.kind, business.message);
    }
  },

  /** Estado del vínculo: userId local + `invitationPending` según plataforma. */
  async getUserLink(
    req: FastifyRequest,
    communityId: string,
    memberId: string,
  ): Promise<PlatformFlowResult<MemberUserLink> | null> {
    const bearer = bearerOf(req);
    const member = await withTransaction(contextFor(req), (tx) =>
      membersRepository.getById(tx, communityId, memberId),
    );
    if (member === null) {
      return null;
    }
    if (member.userId === null) {
      return { ok: true, value: { userId: null, email: null, invitationPending: null } };
    }
    const platform = await tenantAdminClient.getMember(bearer, member.userId);
    if (!platform.ok) {
      // 404 = el usuario ya no es miembro del cliente (o quedó fuera del
      // alcance del actor): el vínculo local existe igual — se informa sin
      // estado de invitación en lugar de romper la pantalla.
      if (platform.status === 404) {
        return { ok: true, value: { userId: member.userId, email: null, invitationPending: null } };
      }
      return { ok: false, error: translatePlatformFailure(platform) };
    }
    return {
      ok: true,
      value: {
        userId: member.userId,
        email: platform.value.email,
        invitationPending: platform.value.invitationPending,
      },
    };
  },

  /** Reenvía el correo de invitación (respuesta uniforme: si la cuenta ya está
   *  activa, la plataforma simplemente no emite nada). null → 404. */
  async resendInvitation(
    req: FastifyRequest,
    communityId: string,
    memberId: string,
  ): Promise<PlatformFlowResult<true> | null> {
    return this.invitationAction(req, communityId, memberId, (bearer, userId) =>
      tenantAdminClient.resendInvitation(bearer, userId),
    );
  },

  /** Anula la invitación viva. No toca la identidad, el acceso ni el vínculo. */
  async cancelInvitation(
    req: FastifyRequest,
    communityId: string,
    memberId: string,
  ): Promise<PlatformFlowResult<true> | null> {
    return this.invitationAction(req, communityId, memberId, (bearer, userId) =>
      tenantAdminClient.cancelInvitation(bearer, userId),
    );
  },

  /** Esqueleto común de resend/cancel: persona → vínculo → plataforma. */
  async invitationAction(
    req: FastifyRequest,
    communityId: string,
    memberId: string,
    action: (bearer: string, userId: string) => Promise<{ ok: true } | TenantAdminFailure>,
  ): Promise<PlatformFlowResult<true> | null> {
    const bearer = bearerOf(req);
    const member = await withTransaction(contextFor(req), (tx) =>
      membersRepository.getById(tx, communityId, memberId),
    );
    if (member === null) {
      return null;
    }
    if (member.userId === null) {
      return flowError(409, "conflict", "La persona no tiene un usuario vinculado.");
    }
    const result = await action(bearer, member.userId);
    if (!result.ok) {
      return { ok: false, error: translatePlatformFailure(result) };
    }
    return { ok: true, value: true };
  },

  /** Desvincula (user_id = NULL). La cuenta de plataforma y sus accesos quedan
   *  intactos: quitarle el acceso a la app es cosa de admin_ws. false → 404. */
  async unlinkUser(req: FastifyRequest, communityId: string, memberId: string): Promise<boolean> {
    return withTransaction(contextFor(req), (tx) =>
      membersRepository.unlinkUser(tx, communityId, memberId),
    );
  },

  // --- Teléfonos ---------------------------------------------------------------

  /** `null` cuando la persona no existe en la comunidad → 404 en la route. */
  async addPhone(
    req: FastifyRequest,
    communityId: string,
    memberId: string,
    input: CreatePhoneInput,
  ): Promise<MutationResult<MemberPhone> | null> {
    const claims = requireAuth(req);
    try {
      return await withTransaction(contextFor(req), async (tx) => {
        const exists = await membersRepository.exists(tx, communityId, memberId);
        if (!exists) {
          return null;
        }
        const phone = await membersRepository.addPhone(
          tx,
          claims.customerId,
          communityId,
          memberId,
          input,
        );
        return { ok: true as const, value: phone };
      });
    } catch (err) {
      return { ok: false, error: translatePgError(err, PHONE_PG_MESSAGES) };
    }
  },

  async removePhone(
    req: FastifyRequest,
    communityId: string,
    memberId: string,
    id: string,
  ): Promise<boolean> {
    return withTransaction(contextFor(req), (tx) =>
      membersRepository.softDeletePhone(tx, communityId, memberId, id),
    );
  },
};
