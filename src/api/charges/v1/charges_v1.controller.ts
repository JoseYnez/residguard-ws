import type { FastifyRequest } from "fastify";
import { contextFor } from "../../../core/auth/community_access";
import { withTransaction } from "../../../core/db/with_transaction";
import {
  asPgError,
  translatePgError,
  type BusinessError,
  type MutationResult,
} from "../../../core/http/pg_errors";
import {
  chargesRepository,
  type AddUnitChargeInput,
  type Charge,
  type CreateChargeInput,
  type GenerateForFeeInput,
  type ListChargesInput,
} from "./charges_v1.repository";

// Orquestación del recurso charges. El alcance (comunidad o unidad de la
// ruta) ya lo garantizó el preHandler; el tenant sale del token (RLS).

/** Entrada del alta múltiple: la misma cuota/periodo sobre 1..N unidades. */
export interface CreateChargesInput extends CreateChargeInput {
  readonly unitIds: readonly string[];
}

/** Entrada del alta SUELTA: el mismo concepto/cantidad sobre 1..N unidades. */
export interface AddUnitChargesInput extends AddUnitChargeInput {
  readonly unitIds: readonly string[];
}

/** Error de negocio lanzado desde el loop de inserción para abortar la
 *  transacción completa (todo-o-nada) conservando el mensaje por unidad. */
class ChargeCreationError extends Error {
  constructor(readonly business: BusinessError) {
    super(business.message);
    this.name = "ChargeCreationError";
  }
}

export const chargesController = {
  async list(
    req: FastifyRequest,
    input: ListChargesInput,
  ): Promise<{ items: Charge[]; total: number }> {
    return withTransaction(contextFor(req), (tx) => chargesRepository.list(tx, input));
  },

  /**
   * Anula (baja lógica) un cargo de la comunidad.
   *
   * `null` = inexistente/fuera de alcance → 404 en la route. `ok: false` con
   * kind `conflict` = tiene pagos aplicados o condonaciones activas: el dinero
   * manda, primero se anula el pago (o se revierte la condonación) y luego el
   * cargo. La comprobación vive DENTRO del UPDATE (ver el repository).
   */
  async revoke(
    req: FastifyRequest,
    communityId: string,
    id: string,
  ): Promise<MutationResult<void> | null> {
    return withTransaction(contextFor(req), async (tx) => {
      if (await chargesRepository.softDelete(tx, communityId, id)) {
        return { ok: true, value: undefined };
      }
      if (await chargesRepository.revocationBlocked(tx, communityId, id)) {
        return {
          ok: false,
          error: {
            kind: "conflict",
            message:
              "El cargo tiene pagos aplicados o condonaciones: anúlalos antes de anular el cargo.",
          },
        };
      }
      return null;
    });
  },

  /**
   * Genera los cargos de UNA cuota sobre TODAS sus unidades activas en el rango
   * dado (default: su vigencia). El largo/paso lo define la periodicidad de la
   * cuota; one_time genera uno solo. Idempotente: no crea duplicados. Devuelve
   * cuántos cargos se crearon.
   */
  async generate(
    req: FastifyRequest,
    communityId: string,
    input: GenerateForFeeInput,
  ): Promise<MutationResult<number>> {
    // Cross-field que el verifier no cubre.
    if (input.from != null && input.to != null && input.to < input.from) {
      return {
        ok: false,
        error: { kind: "invalid", message: "El fin del rango no puede ser anterior al inicio." },
      };
    }

    try {
      const created = await withTransaction(contextFor(req), async (tx) => {
        const fee = await chargesRepository.feeForGeneration(tx, communityId, input.feeId);
        if (fee === null) {
          throw new ChargeCreationError({
            kind: "invalid",
            message: "La cuota no está disponible para la comunidad.",
          });
        }
        // Cuota recurrente sin fin de vigencia: exige acotar el rango con `to`.
        if (fee.periodicity !== "one_time" && fee.effectiveTo === null && input.to == null) {
          throw new ChargeCreationError({
            kind: "invalid",
            message: "La cuota no tiene fin de vigencia; indica la fecha final del rango (to).",
          });
        }

        try {
          return await chargesRepository.generateForFee(tx, input);
        } catch (err) {
          if (err instanceof ChargeCreationError) {
            throw err;
          }
          // Errores esperables del procedure → negocio (lo no mapeado → 500).
          throw new ChargeCreationError(
            translatePgError(err, {
              overlap: "Ya existe un cargo que solapa el periodo para alguna unidad.",
              check: "El monto o el periodo de generación no son válidos.",
              notFound: "La cuota no está disponible para la comunidad.",
            }),
          );
        }
      });
      return { ok: true, value: created };
    } catch (err) {
      if (err instanceof ChargeCreationError) {
        return { ok: false, error: err.business };
      }
      throw err;
    }
  },

  /**
   * Registra la cuota sobre TODAS las unidades pedidas (un cargo por unidad)
   * en una sola transacción: si una unidad falla (solapamiento, cuota no
   * disponible), no se crea ninguno.
   */
  async create(
    req: FastifyRequest,
    communityId: string,
    input: CreateChargesInput,
  ): Promise<MutationResult<Charge[]>> {
    // Cross-field que el verifier no cubre.
    if (input.periodEnd < input.periodStart) {
      return {
        ok: false,
        error: { kind: "invalid", message: "El fin del periodo no puede ser anterior al inicio." },
      };
    }
    const distinct = [...new Set(input.unitIds)];
    if (distinct.length !== input.unitIds.length) {
      return {
        ok: false,
        error: { kind: "invalid", message: "La misma unidad aparece más de una vez." },
      };
    }

    try {
      const items = await withTransaction(contextFor(req), async (tx) => {
        // Todas las unidades deben existir, ser de ESTA comunidad y estar
        // activas — se valida antes de insertar nada.
        const units = await chargesRepository.resolveActiveUnits(tx, communityId, distinct);
        if (units.length !== distinct.length) {
          throw new ChargeCreationError({
            kind: "invalid",
            message: "Alguna unidad no existe o no está activa en la comunidad.",
          });
        }

        // El PERIODO primero, y una sola vez: todos los cargos del alta cuelgan
        // de la misma fila (create-or-reuse; un rango que solape otro periodo
        // de la cuota aborta aquí, antes de tocar unidad alguna).
        let periodId: string;
        try {
          periodId = await chargesRepository.ensurePeriod(tx, input);
        } catch (err) {
          const pg = asPgError(err);
          if (pg?.code === "23P01") {
            throw new ChargeCreationError({
              kind: "conflict",
              message: "El rango se solapa con otro periodo de la cuota.",
            });
          }
          if (pg?.code === "P0002") {
            throw new ChargeCreationError({
              kind: "invalid",
              message: "La cuota no está disponible para la comunidad.",
            });
          }
          throw err;
        }

        const created: Charge[] = [];
        for (const unit of units) {
          try {
            const charge = await chargesRepository.create(tx, unit.id, periodId, input);
            if (charge === null) {
              // 0 filas con la unidad ya validada → la cuota no está activa
              // o no pertenece a esta comunidad.
              throw new ChargeCreationError({
                kind: "invalid",
                message: "La cuota no está disponible para la comunidad.",
              });
            }
            created.push(charge);
          } catch (err) {
            if (err instanceof ChargeCreationError) {
              throw err;
            }
            // Errores esperables de PG, con la unidad que falló en el mensaje.
            const pg = asPgError(err);
            if (pg?.code === "23505") {
              // uq_charges_period_unit: la unidad ya tiene cargo del periodo.
              throw new ChargeCreationError({
                kind: "conflict",
                message: `La unidad ${unit.code} ya tiene un cargo de ese periodo.`,
              });
            }
            if (pg?.code === "23514") {
              throw new ChargeCreationError({
                kind: "invalid",
                message: `El periodo o el monto del cargo no son válidos (unidad ${unit.code}).`,
              });
            }
            if (pg?.code === "23503") {
              throw new ChargeCreationError({
                kind: "invalid",
                message: "La cuota no existe o no pertenece a la comunidad.",
              });
            }
            throw err;
          }
        }
        return created;
      });
      return { ok: true, value: items };
    } catch (err) {
      if (err instanceof ChargeCreationError) {
        return { ok: false, error: err.business };
      }
      throw err;
    }
  },

  /**
   * Registra un cargo SUELTO — un concepto no recurrente y repetible: la venta
   * de N tarjetas de acceso, una multa — sobre cada unidad pedida, en una sola
   * transacción todo-o-nada.
   *
   * No tiene periodo (la cuota `one_time` solo presta concepto y precio) y por
   * eso NO es idempotente: llamarlo dos veces con la misma unidad registra dos
   * ventas. Esa es justo la diferencia con {@link create}, donde
   * `uq_charges_period_unit` limita a un cargo por periodo y unidad.
   */
  async addAdhoc(
    req: FastifyRequest,
    communityId: string,
    input: AddUnitChargesInput,
  ): Promise<MutationResult<Charge[]>> {
    // A diferencia del alta devengada, aquí repetir una unidad SÍ es legítimo
    // (dos ventas a la misma casa), así que no se deduplica: cada aparición
    // registra su propio cargo.
    try {
      const items = await withTransaction(contextFor(req), async (tx) => {
        // La cuota debe existir en ESTA comunidad, estar activa y ser one_time.
        // El procedure lo revalida (es la frontera real), pero comprobarlo aquí
        // convierte un P0002/22023 genérico en un mensaje que dice qué arreglar.
        const fee = await chargesRepository.feeForGeneration(tx, communityId, input.feeId);
        if (fee === null) {
          throw new ChargeCreationError({
            kind: "invalid",
            message: "La cuota no está disponible para la comunidad.",
          });
        }
        if (fee.periodicity !== "one_time") {
          throw new ChargeCreationError({
            kind: "invalid",
            message:
              "Solo las cuotas de pago único admiten cargos sueltos; " +
              "una cuota recurrente se cobra por periodo.",
          });
        }

        // Las unidades, antes de insertar nada (mismo criterio que `create`).
        const distinct = [...new Set(input.unitIds)];
        const units = await chargesRepository.resolveActiveUnits(tx, communityId, distinct);
        if (units.length !== distinct.length) {
          throw new ChargeCreationError({
            kind: "invalid",
            message: "Alguna unidad no existe o no está activa en la comunidad.",
          });
        }
        const codeById = new Map(units.map((u) => [u.id, u.code]));

        const created: Charge[] = [];
        for (const unitId of input.unitIds) {
          try {
            const charge = await chargesRepository.addUnitCharge(tx, unitId, input);
            if (charge === null) {
              // El id existe (la sp lo devolvió) pero la relectura no lo ve:
              // no hay lectura parcial que salvar, se aborta la transacción.
              throw new ChargeCreationError({
                kind: "invalid",
                message: "No se pudo leer el cargo recién registrado.",
              });
            }
            created.push(charge);
          } catch (err) {
            if (err instanceof ChargeCreationError) {
              throw err;
            }
            const code = codeById.get(unitId) ?? unitId;
            throw new ChargeCreationError(
              translatePgError(err, {
                check: `La cantidad o el monto del cargo no son válidos (unidad ${code}).`,
                parameter: "La cuota no admite cargos sueltos: debe ser de pago único.",
                notFound: `La cuota o la unidad ${code} no están disponibles en la comunidad.`,
                reference: `La cuota o la unidad ${code} no están disponibles en la comunidad.`,
              }),
            );
          }
        }
        return created;
      });
      return { ok: true, value: items };
    } catch (err) {
      if (err instanceof ChargeCreationError) {
        return { ok: false, error: err.business };
      }
      throw err;
    }
  },
};
