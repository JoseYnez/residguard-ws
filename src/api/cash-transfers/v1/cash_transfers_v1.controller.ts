import type { FastifyRequest } from "fastify";
import { requireAuth } from "../../../core/auth/authenticate";
import { contextFor } from "../../../core/auth/community_access";
import { withTransaction } from "../../../core/db/with_transaction";
import { translatePgError, type MutationResult } from "../../../core/http/pg_errors";
import {
  cashTransfersRepository,
  type CashTransfer,
  type CreateCashTransferInput,
  type ListCashTransfersInput,
  type UpdateCashTransferInput,
} from "./cash_transfers_v1.repository";

// Orquestación del recurso cash-transfers. El acceso a la comunidad de la
// ruta ya lo garantizó requireCommunityAccess. Las reglas de negocio se
// validan aquí para dar mensaje claro; los CHECKs y FKs de la BD son el
// respaldo: origen ≠ destino, monto > 0, y ambas cajas existentes, ACTIVAS
// y de la comunidad de la ruta.

const SAME_ACCOUNT: MutationResult<never> = {
  ok: false,
  error: {
    kind: "invalid",
    message: "La caja de origen y la de destino deben ser distintas.",
  },
};

const INVALID_ACCOUNTS: MutationResult<never> = {
  ok: false,
  error: {
    kind: "invalid",
    message: "Ambas cajas deben existir, estar activas y pertenecer a la comunidad.",
  },
};

const PG_MESSAGES = {
  check: "El monto debe ser positivo y las cajas de origen y destino distintas.",
  reference: "Alguna de las cajas no existe en la comunidad o está fuera de tu alcance.",
} as const;

export const cashTransfersController = {
  async list(
    req: FastifyRequest,
    input: ListCashTransfersInput,
  ): Promise<{ items: CashTransfer[]; total: number }> {
    return withTransaction(contextFor(req), (tx) => cashTransfersRepository.list(tx, input));
  },

  async getById(
    req: FastifyRequest,
    communityId: string,
    id: string,
  ): Promise<CashTransfer | null> {
    return withTransaction(contextFor(req), (tx) =>
      cashTransfersRepository.getById(tx, communityId, id),
    );
  },

  async create(
    req: FastifyRequest,
    communityId: string,
    input: CreateCashTransferInput,
  ): Promise<MutationResult<CashTransfer>> {
    if (input.fromCashAccountId === input.toCashAccountId) {
      return SAME_ACCOUNT;
    }
    const claims = requireAuth(req);
    try {
      return await withTransaction(
        contextFor(req),
        async (tx): Promise<MutationResult<CashTransfer>> => {
          // Ambas cajas dentro de la MISMA transacción que el INSERT: existir,
          // estar activas y ser de la comunidad de la ruta.
          const active = await cashTransfersRepository.findActiveCashAccountIds(tx, communityId, [
            input.fromCashAccountId,
            input.toCashAccountId,
          ]);
          if (!active.has(input.fromCashAccountId) || !active.has(input.toCashAccountId)) {
            return INVALID_ACCOUNTS;
          }
          const transfer = await cashTransfersRepository.create(
            tx,
            claims.customerId,
            communityId,
            input,
          );
          return { ok: true, value: transfer };
        },
      );
    } catch (err) {
      return { ok: false, error: translatePgError(err, PG_MESSAGES) };
    }
  },

  /** `null` (fuera de ok/error) cuando el traspaso no existe → 404. */
  async update(
    req: FastifyRequest,
    communityId: string,
    id: string,
    input: UpdateCashTransferInput,
  ): Promise<MutationResult<CashTransfer> | null> {
    try {
      return await withTransaction(
        contextFor(req),
        async (tx): Promise<MutationResult<CashTransfer> | null> => {
          const current = await cashTransfersRepository.getById(tx, communityId, id);
          if (current === null) {
            return null;
          }
          // Origen/destino EFECTIVOS tras el parche: lo que llega pisa lo actual.
          const fromId = input.fromCashAccountId ?? current.fromCashAccountId;
          const toId = input.toCashAccountId ?? current.toCashAccountId;
          if (fromId === toId) {
            return SAME_ACCOUNT;
          }
          // Solo si cambia alguna caja se revalidan ambas (una caja desactivada
          // DESPUÉS del traspaso no debe impedir editar el monto o el motivo).
          if (input.fromCashAccountId !== undefined || input.toCashAccountId !== undefined) {
            const active = await cashTransfersRepository.findActiveCashAccountIds(
              tx,
              communityId,
              [fromId, toId],
            );
            if (!active.has(fromId) || !active.has(toId)) {
              return INVALID_ACCOUNTS;
            }
          }
          const transfer = await cashTransfersRepository.update(tx, communityId, id, input);
          if (transfer === null) {
            return null;
          }
          return { ok: true, value: transfer };
        },
      );
    } catch (err) {
      return { ok: false, error: translatePgError(err, PG_MESSAGES) };
    }
  },

  async softDelete(req: FastifyRequest, communityId: string, id: string): Promise<boolean> {
    return withTransaction(contextFor(req), (tx) =>
      cashTransfersRepository.softDelete(tx, communityId, id),
    );
  },
};
