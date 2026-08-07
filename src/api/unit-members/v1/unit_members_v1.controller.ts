import type { FastifyRequest } from "fastify";
import { requireAuth } from "../../../core/auth/authenticate";
import { contextFor } from "../../../core/auth/community_access";
import { withTransaction } from "../../../core/db/with_transaction";
import { translatePgError, type MutationResult } from "../../../core/http/pg_errors";
import {
  unitMembersRepository,
  type AssignMemberUnitInput,
  type DirectoryEntry,
  type ListDirectoryInput,
  type ListMemberUnitsInput,
  type ListUnitMembersInput,
  type MemberUnit,
  type UnitMember,
} from "./unit_members_v1.repository";

// Orquestación del recurso unit-members. Para las lecturas por unidad el
// acceso ya lo garantizó requireUnitAccess (unidad → comunidad → membresía);
// para las rutas por miembro, requireCommunityAccess — y el controller además
// resuelve el 404 del miembro inexistente antes de tocar la relación.

const PG_MESSAGES = {
  conflict: "La persona ya está asociada a esta unidad.",
  reference: "La unidad indicada no existe en esta comunidad.",
} as const;

export const unitMembersController = {
  // --- Vista por unidad (solo lectura) ---------------------------------------

  async list(
    req: FastifyRequest,
    input: ListUnitMembersInput,
  ): Promise<{ items: UnitMember[]; total: number }> {
    return withTransaction(contextFor(req), (tx) => unitMembersRepository.list(tx, input));
  },

  async getById(req: FastifyRequest, unitId: string, id: string): Promise<UnitMember | null> {
    return withTransaction(contextFor(req), (tx) =>
      unitMembersRepository.getById(tx, unitId, id),
    );
  },

  /** El directorio de contacto de la comunidad (solo lectura). */
  async listDirectory(
    req: FastifyRequest,
    input: ListDirectoryInput,
  ): Promise<{ items: DirectoryEntry[]; total: number }> {
    return withTransaction(contextFor(req), (tx) =>
      unitMembersRepository.listDirectory(tx, input),
    );
  },

  // --- Vista por miembro (CRUD) ----------------------------------------------

  /** `null` cuando el miembro no existe en la comunidad → 404 en la route. */
  async listByMember(
    req: FastifyRequest,
    input: ListMemberUnitsInput,
  ): Promise<{ items: MemberUnit[]; total: number } | null> {
    return withTransaction(contextFor(req), async (tx) => {
      const exists = await unitMembersRepository.memberExists(
        tx,
        input.communityId,
        input.memberId,
      );
      if (!exists) {
        return null;
      }
      return unitMembersRepository.listByMember(tx, input);
    });
  },

  /** `null` cuando el miembro no existe en la comunidad → 404 en la route. */
  async assign(
    req: FastifyRequest,
    communityId: string,
    memberId: string,
    input: AssignMemberUnitInput,
  ): Promise<MutationResult<MemberUnit> | null> {
    const claims = requireAuth(req);
    try {
      return await withTransaction(contextFor(req), async (tx) => {
        const exists = await unitMembersRepository.memberExists(tx, communityId, memberId);
        if (!exists) {
          return null;
        }
        const assignment = await unitMembersRepository.assign(
          tx,
          claims.customerId,
          communityId,
          memberId,
          input,
        );
        return { ok: true as const, value: assignment };
      });
    } catch (err) {
      return { ok: false, error: translatePgError(err, PG_MESSAGES) };
    }
  },

  /** `null` cuando la asignación no existe → 404 en la route. */
  async updateAssignment(
    req: FastifyRequest,
    communityId: string,
    memberId: string,
    id: string,
    memberType: string,
  ): Promise<MemberUnit | null> {
    return withTransaction(contextFor(req), (tx) =>
      unitMembersRepository.updateAssignment(tx, communityId, memberId, id, memberType),
    );
  },

  async removeAssignment(
    req: FastifyRequest,
    communityId: string,
    memberId: string,
    id: string,
  ): Promise<boolean> {
    return withTransaction(contextFor(req), (tx) =>
      unitMembersRepository.softDeleteAssignment(tx, communityId, memberId, id),
    );
  },
};
