import type { FastifyRequest } from "fastify";
import { requireAuth } from "../../../core/auth/authenticate";
import {
  contextFor,
  userHasCommunityAccess,
} from "../../../core/auth/community_access";
import { withTransaction } from "../../../core/db/with_transaction";
import { translatePgError, type MutationResult } from "../../../core/http/pg_errors";
import {
  paymentsRepository,
  type ListPaymentsInput,
  type PaymentDetail,
  type PaymentListItem,
  type RegisterPaymentInput,
} from "./payments_v1.repository";

// Orquestación del recurso payments. Un pago no cuelga de una comunidad, así
// que el alcance se valida contra los CARGOS que toca: para registrar, TODOS
// los cargos deben ser de comunidades del actor; para consultar basta que
// alguno lo sea; para anular, de nuevo TODOS.

const PG_MESSAGES = {
  conflict: "El mismo cargo aparece más de una vez en las aplicaciones.",
  // check_violation cubre dos reglas de la sp: la suma exacta (que el
  // controller ya validó, así que en la práctica no llega) y el cargo de otra
  // comunidad que la caja declarada.
  check: "Los cargos del pago no corresponden a la comunidad de la caja destino.",
  notFound: "Alguno de los cargos —o la caja destino— no existe o no está activo.",
} as const;

/** Suma en centavos para comparar sin errores de flotante. */
function sumCents(amounts: readonly number[]): number {
  return amounts.reduce((acc, a) => acc + Math.round(a * 100), 0);
}

export const paymentsController = {
  async register(
    req: FastifyRequest,
    input: RegisterPaymentInput,
  ): Promise<MutationResult<PaymentDetail>> {
    const claims = requireAuth(req);

    // Validaciones de negocio previas (respuesta tipada sin tocar la sp):
    // la suma debe cuadrar exacto y no puede repetirse un cargo.
    const chargeIds = input.allocations.map((a) => a.chargeId);
    const distinct = new Set(chargeIds);
    if (distinct.size !== chargeIds.length) {
      return { ok: false, error: { kind: "invalid", message: PG_MESSAGES.conflict } };
    }
    if (sumCents(input.allocations.map((a) => a.amount)) !== Math.round(input.amount * 100)) {
      return { ok: false, error: { kind: "invalid", message: PG_MESSAGES.check } };
    }

    try {
      const payment = await withTransaction(contextFor(req), async (tx) => {
        // Frontera de alcance: todos los cargos deben ser de comunidades
        // donde el actor tiene membresía activa.
        const accessible = await paymentsRepository.countAccessibleCharges(
          tx,
          claims.sub,
          [...distinct],
        );
        if (accessible !== distinct.size) {
          return null;
        }
        return paymentsRepository.register(tx, claims.sub, input);
      });
      if (payment === null) {
        return {
          ok: false,
          error: {
            kind: "invalid",
            message: "Alguno de los cargos no existe o está fuera de tu alcance.",
          },
        };
      }
      return { ok: true, value: payment };
    } catch (err) {
      return { ok: false, error: translatePgError(err, PG_MESSAGES) };
    }
  },

  /** null = comunidad fuera del alcance del actor (la ruta responde 404). */
  async list(
    req: FastifyRequest,
    input: ListPaymentsInput,
  ): Promise<{ items: PaymentListItem[]; total: number } | null> {
    const claims = requireAuth(req);
    return withTransaction(contextFor(req), async (tx) => {
      const allowed = await userHasCommunityAccess(tx, claims.sub, input.communityId);
      if (!allowed) {
        return null;
      }
      return paymentsRepository.list(tx, input);
    });
  },

  async getById(req: FastifyRequest, id: string): Promise<PaymentDetail | null> {
    const claims = requireAuth(req);
    return withTransaction(contextFor(req), (tx) =>
      paymentsRepository.getById(tx, claims.sub, id),
    );
  },

  /**
   * Anula el pago. "not_found" si no existe, si no le queda ninguna aplicación
   * activa o si el actor no ve ninguna de sus comunidades; "forbidden" si lo ve
   * pero no alcanza TODAS (anular afecta cargos de comunidades ajenas).
   */
  async softDelete(
    req: FastifyRequest,
    id: string,
  ): Promise<"deleted" | "not_found" | "forbidden"> {
    const claims = requireAuth(req);
    return withTransaction(contextFor(req), async (tx) => {
      const exists = await paymentsRepository.exists(tx, id);
      if (!exists) {
        return "not_found";
      }
      const touched = await paymentsRepository.getTouchedCommunities(tx, id);
      // Un pago sin aplicaciones activas no lo alcanza NINGUNA comunidad: no
      // hay nada contra lo que medir el alcance del actor, así que se responde
      // opaco. Tratarlo como "alcanzable" abriría la anulación a cualquiera
      // con `payments.revoke` del tenant.
      if (touched.length === 0) {
        return "not_found";
      }
      const reachesAll = await paymentsRepository.userReachesAllCommunities(
        tx,
        claims.sub,
        touched,
      );
      if (!reachesAll) {
        // ¿Ve al menos una? → 403; ninguna → opaco 404.
        const visible = await paymentsRepository.getById(tx, claims.sub, id);
        return visible === null ? "not_found" : "forbidden";
      }
      const deleted = await paymentsRepository.softDelete(tx, id);
      return deleted ? "deleted" : "not_found";
    });
  },
};
