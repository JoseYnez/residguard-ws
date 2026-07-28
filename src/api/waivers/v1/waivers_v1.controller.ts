import type { FastifyRequest } from "fastify";
import { contextFor } from "../../../core/auth/community_access";
import { withTransaction } from "../../../core/db/with_transaction";
import { translatePgError, type MutationResult } from "../../../core/http/pg_errors";
import {
  waiversRepository,
  type ListWaiversInput,
  type Waiver,
} from "./waivers_v1.repository";

// Orquestación del recurso waivers. El alcance (la comunidad de la ruta) ya lo
// garantizó el preHandler; el tenant sale del token (RLS). Lo que se decide
// aquí es la regla de negocio que la BD no puede imponer sola: cuánto se puede
// condonar.

/** Entrada del alta. `amount` omitido = condonar TODO el saldo pendiente. */
export interface CreateWaiverInput {
  readonly amount?: number | null;
  readonly reason: string;
}

/** Comparación en centavos: el dinero viaja como número JSON y 0.1+0.2 no es
 *  0.3. El tope se decide sobre enteros. */
function cents(amount: number): number {
  return Math.round(amount * 100);
}

export const waiversController = {
  /**
   * Condona (total o parcialmente) un cargo de la comunidad.
   *
   * `null` = cargo inexistente, de otra comunidad o dado de baja → 404 en la
   * route. `conflict` = ya no queda saldo que perdonar. `invalid` = el monto
   * pedido excede el saldo pendiente.
   *
   * El cargo se bloquea ANTES de calcular el saldo y sigue bloqueado durante el
   * CALL, así que el tope no se puede burlar con dos peticiones simultáneas.
   */
  async create(
    req: FastifyRequest,
    communityId: string,
    chargeId: string,
    input: CreateWaiverInput,
  ): Promise<MutationResult<Waiver> | null> {
    return withTransaction(contextFor(req), async (tx) => {
      const charge = await waiversRepository.lockChargeForWaiver(tx, communityId, chargeId);
      if (charge === null) {
        return null;
      }

      if (cents(charge.balance) <= 0) {
        return {
          ok: false as const,
          error: {
            kind: "conflict" as const,
            message: "El cargo ya está cubierto: no queda saldo por condonar.",
          },
        };
      }

      // Sin monto = perdonar lo que quede pendiente (el caso normal: un cargo
      // incobrable). Con monto, nunca por encima de ese saldo.
      const amount = input.amount ?? charge.balance;
      if (cents(amount) > cents(charge.balance)) {
        return {
          ok: false as const,
          error: {
            kind: "invalid" as const,
            message: `El monto a condonar excede el saldo pendiente del cargo (${charge.balance.toFixed(2)}).`,
          },
        };
      }

      try {
        const waiver = await waiversRepository.create(tx, chargeId, amount, input.reason);
        return { ok: true as const, value: waiver };
      } catch (err) {
        // Última línea: el procedure revalida el cargo y el CHECK exige > 0.
        return {
          ok: false as const,
          error: translatePgError(err, {
            check: "El monto a condonar no es válido.",
            notFound: "El cargo no existe o no está activo.",
            reference: "El cargo no existe o no está activo.",
          }),
        };
      }
    });
  },

  /** Historial de condonaciones de la comunidad (filtros opcionales). */
  async list(
    req: FastifyRequest,
    input: ListWaiversInput,
  ): Promise<{ items: Waiver[]; total: number }> {
    return withTransaction(contextFor(req), (tx) => waiversRepository.list(tx, input));
  },

  /**
   * Revierte una condonación: baja lógica del waiver y recálculo del estatus de
   * cobro del cargo. `false` = inexistente, de otra comunidad o ya revertida
   * (→ 404). No hay conflicto posible: quitar una condonación solo puede
   * DEVOLVER saldo al cargo, nunca dejarlo sobrecubierto.
   */
  async revoke(req: FastifyRequest, communityId: string, id: string): Promise<boolean> {
    return withTransaction(contextFor(req), (tx) =>
      waiversRepository.softDelete(tx, communityId, id),
    );
  },
};
