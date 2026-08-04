import type { FastifyRequest } from "fastify";
import { requireAuth } from "../../../core/auth/authenticate";
import { contextFor } from "../../../core/auth/community_access";
import { withTransaction } from "../../../core/db/with_transaction";
import { translatePgError, type MutationResult } from "../../../core/http/pg_errors";
import {
  fundAdjustmentsRepository,
  type CreateFundAdjustmentInput,
  type FundAdjustment,
  type ListFundAdjustmentsInput,
  type UpdateFundAdjustmentInput,
} from "./fund_adjustments_v1.repository";

// Orquestación del recurso fund-adjustments. El acceso a la comunidad de la
// ruta ya lo garantizó requireCommunityAccess. El monto con signo nunca puede
// ser cero (se valida aquí; el check de BD es el respaldo). Si el movimiento
// declara caja, debe existir, estar ACTIVA y ser de la comunidad de la ruta
// (la FK compuesta de BD no mira el `status`).

const ZERO_AMOUNT: MutationResult<never> = {
  ok: false,
  error: { kind: "invalid", message: "El monto del movimiento no puede ser cero." },
};

const INVALID_CASH_ACCOUNT: MutationResult<never> = {
  ok: false,
  error: {
    kind: "invalid",
    message: "La caja no existe, no está activa o no pertenece a esta comunidad.",
  },
};

const PG_MESSAGES = {
  check: "El monto del movimiento no puede ser cero.",
  reference: "La comunidad o la caja no existen o están fuera de tu alcance.",
} as const;

export const fundAdjustmentsController = {
  async list(
    req: FastifyRequest,
    input: ListFundAdjustmentsInput,
  ): Promise<{ items: FundAdjustment[]; total: number }> {
    return withTransaction(contextFor(req), (tx) => fundAdjustmentsRepository.list(tx, input));
  },

  async getById(
    req: FastifyRequest,
    communityId: string,
    id: string,
  ): Promise<FundAdjustment | null> {
    return withTransaction(contextFor(req), (tx) =>
      fundAdjustmentsRepository.getById(tx, communityId, id),
    );
  },

  async create(
    req: FastifyRequest,
    communityId: string,
    input: CreateFundAdjustmentInput,
  ): Promise<MutationResult<FundAdjustment>> {
    if (input.amount === 0) {
      return ZERO_AMOUNT;
    }
    const claims = requireAuth(req);
    try {
      return await withTransaction(
        contextFor(req),
        async (tx): Promise<MutationResult<FundAdjustment>> => {
          // Con caja declarada: existir, estar activa y ser de la comunidad
          // de la ruta, dentro de la MISMA transacción que el INSERT.
          if (input.cashAccountId !== undefined && input.cashAccountId !== null) {
            const cashOk = await fundAdjustmentsRepository.activeCashAccountExists(
              tx,
              communityId,
              input.cashAccountId,
            );
            if (!cashOk) {
              return INVALID_CASH_ACCOUNT;
            }
          }
          const adjustment = await fundAdjustmentsRepository.create(
            tx,
            claims.customerId,
            communityId,
            input,
          );
          return { ok: true, value: adjustment };
        },
      );
    } catch (err) {
      return { ok: false, error: translatePgError(err, PG_MESSAGES) };
    }
  },

  /** `null` (fuera de ok/error) cuando el movimiento no existe → 404. */
  async update(
    req: FastifyRequest,
    communityId: string,
    id: string,
    input: UpdateFundAdjustmentInput,
  ): Promise<MutationResult<FundAdjustment> | null> {
    if (input.amount === 0) {
      return ZERO_AMOUNT;
    }
    try {
      return await withTransaction(
        contextFor(req),
        async (tx): Promise<MutationResult<FundAdjustment> | null> => {
          // Solo se valida si el PATCH cambia la caja (null = limpiar, no se
          // valida nada): editar otros campos de un movimiento viejo cuya caja
          // se retiró después sigue siendo legítimo.
          if (input.cashAccountId !== undefined && input.cashAccountId !== null) {
            const cashOk = await fundAdjustmentsRepository.activeCashAccountExists(
              tx,
              communityId,
              input.cashAccountId,
            );
            if (!cashOk) {
              return INVALID_CASH_ACCOUNT;
            }
          }
          const adjustment = await fundAdjustmentsRepository.update(tx, communityId, id, input);
          if (adjustment === null) {
            return null;
          }
          return { ok: true, value: adjustment };
        },
      );
    } catch (err) {
      return { ok: false, error: translatePgError(err, PG_MESSAGES) };
    }
  },

  async softDelete(req: FastifyRequest, communityId: string, id: string): Promise<boolean> {
    return withTransaction(contextFor(req), (tx) =>
      fundAdjustmentsRepository.softDelete(tx, communityId, id),
    );
  },
};
