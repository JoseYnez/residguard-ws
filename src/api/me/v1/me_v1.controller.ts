import type { FastifyRequest } from "fastify";
import { config } from "../../../config";
import { requireAuth } from "../../../core/auth/authenticate";
import { contextFor } from "../../../core/auth/community_access";
import { withTransaction } from "../../../core/db/with_transaction";
import { translatePgError, type MutationResult } from "../../../core/http/pg_errors";
import type { UnitChargeStatement } from "../../reports/v1/reports_v1.repository";
import {
  normalizeVisitInput,
  type RawVisitInput,
} from "../../visits/v1/visits_v1.controller";
import type { Visit, VisitEvent } from "../../visits/v1/visits_v1.repository";
import { chargesRepository, type Charge } from "../../charges/v1/charges_v1.repository";
import {
  claimedChargesError,
  resolveFiles,
  type ClaimedChargeInput,
} from "../../payment-evidence/v1/payment_evidence_v1.controller";
import {
  paymentEvidenceRepository,
  type Evidence,
} from "../../payment-evidence/v1/payment_evidence_v1.repository";
import { storageClient } from "../../../core/storage/storage_client";
import { meRepository, type MyPayment, type MyUnit } from "./me_v1.repository";

// Orquestación del recurso me. No hay preHandler de alcance que garantizar:
// el "alcance" ES el usuario del token (claims.sub), y la pertenencia de cada
// unidad la resuelve el repositorio por el vínculo del padrón.

export const meController = {
  async listMyUnits(req: FastifyRequest): Promise<MyUnit[]> {
    const claims = requireAuth(req);
    return withTransaction(contextFor(req), (tx) => meRepository.listMyUnits(tx, claims.sub));
  },

  /** Mis pagos REGISTRADOS (dinero aplicado a cargos de mis unidades). */
  async listMyPayments(
    req: FastifyRequest,
    input: { readonly page: number; readonly pageSize: number },
  ): Promise<{ items: MyPayment[]; total: number }> {
    const claims = requireAuth(req);
    return withTransaction(contextFor(req), (tx) =>
      meRepository.listMyPayments(tx, claims.sub, input),
    );
  },

  /** `null` cuando la unidad no es del usuario (o no existe) → 404 en la route. */
  async myUnitStatement(
    req: FastifyRequest,
    input: {
      readonly unitId: string;
      readonly from: string;
      readonly to: string;
      readonly page: number;
      readonly pageSize: number;
    },
  ): Promise<UnitChargeStatement | null> {
    const claims = requireAuth(req);
    return withTransaction(contextFor(req), (tx) =>
      meRepository.myUnitStatement(tx, claims.sub, input),
    );
  },

  // --- Mis visitas -----------------------------------------------------------

  async listMyVisits(
    req: FastifyRequest,
    input: {
      readonly page: number;
      readonly pageSize: number;
      readonly unitId?: string | null;
      readonly state?: string | null;
    },
  ): Promise<{ items: Visit[]; total: number }> {
    const claims = requireAuth(req);
    return withTransaction(contextFor(req), (tx) =>
      meRepository.listMyVisits(tx, claims.sub, input),
    );
  },

  /** `null` cuando el pase no es del usuario (o no existe) → 404. */
  async myVisit(req: FastifyRequest, visitId: string): Promise<Visit | null> {
    const claims = requireAuth(req);
    return withTransaction(contextFor(req), (tx) => meRepository.myVisit(tx, claims.sub, visitId));
  },

  /** El pase MÁS sus entradas y salidas de caseta. `null` → 404 en la route. */
  async myVisitDetail(
    req: FastifyRequest,
    visitId: string,
  ): Promise<{ visit: Visit; events: VisitEvent[] } | null> {
    const claims = requireAuth(req);
    return withTransaction(contextFor(req), (tx) =>
      meRepository.myVisitDetail(tx, claims.sub, visitId),
    );
  },

  /**
   * Registra un pase para una unidad mía.
   *
   * Devuelve `null` (→ 404) cuando la unidad no es del usuario: mismo criterio
   * que el resto del servicio — fuera de alcance es indistinguible de
   * inexistente, y aquí además evita que alguien descubra unidades ajenas
   * probando ids.
   */
  async createMyVisit(
    req: FastifyRequest,
    input: RawVisitInput,
  ): Promise<MutationResult<Visit> | null> {
    const claims = requireAuth(req);

    const normalized = normalizeVisitInput(input);
    if (!normalized.ok) {
      return normalized;
    }

    try {
      return await withTransaction(contextFor(req), async (tx) => {
        const scope = await meRepository.myUnitScope(tx, claims.sub, input.unitId);
        if (scope === null) {
          return null;
        }

        // Freno anti-abuso: se cuenta DENTRO de la transacción, así que dos
        // altas simultáneas no pueden colarse las dos por encima del tope.
        const active = await meRepository.countActiveVisitsForUnit(tx, input.unitId);
        if (active >= config.visitMaxActivePerUnit) {
          return {
            ok: false as const,
            error: {
              kind: "conflict" as const,
              message:
                `Esta unidad ya tiene ${config.visitMaxActivePerUnit} visitas vigentes. ` +
                "Cancela alguna antes de registrar otra.",
            },
          };
        }

        const visit = await meRepository.createMyVisit(
          tx,
          claims.sub,
          claims.customerId,
          normalized.value,
        );
        return visit === null ? null : { ok: true as const, value: visit };
      });
    } catch (err) {
      return {
        ok: false,
        error: translatePgError(err, {
          check: "Los datos de la visita no son válidos: revisa fechas, horario y días.",
          reference: "La unidad no existe o está fuera de tu alcance.",
        }),
      };
    }
  },

  /** `null` cuando el pase no es del usuario (o no existe) → 404. */
  async cancelMyVisit(req: FastifyRequest, visitId: string): Promise<Visit | null> {
    const claims = requireAuth(req);
    return withTransaction(contextFor(req), (tx) =>
      meRepository.cancelMyVisit(tx, claims.sub, visitId),
    );
  },

  // --- Mis comprobantes de pago ----------------------------------------------

  async listMyEvidence(
    req: FastifyRequest,
    input: {
      readonly page: number;
      readonly pageSize: number;
      readonly unitId?: string | null;
      readonly status?: string | null;
    },
  ): Promise<{ items: Evidence[]; total: number }> {
    const claims = requireAuth(req);
    return withTransaction(contextFor(req), (tx) =>
      paymentEvidenceRepository.listMine(tx, claims.sub, input),
    );
  },

  /** `null` cuando la evidencia no es del usuario (o no existe) → 404. */
  async myEvidence(req: FastifyRequest, id: string): Promise<Evidence | null> {
    const claims = requireAuth(req);
    return withTransaction(contextFor(req), (tx) =>
      paymentEvidenceRepository.getMine(tx, claims.sub, id),
    );
  },

  /**
   * Envía un comprobante por una unidad MÍA. La persona del padrón NO llega
   * del cliente: la deriva `myUnitScope` del usuario del token — el residente
   * es siempre él mismo. Los archivos se validan contra storage ANTES de
   * abrir la transacción (la SPA ya los subió con el Bearer del usuario).
   *
   * `null` (→ 404) cuando la unidad no es del usuario: fuera de alcance es
   * indistinguible de inexistente.
   */
  async createMyEvidence(
    req: FastifyRequest,
    input: {
      readonly unitId: string;
      readonly declaredAmount: number;
      readonly declaredPaidAt?: string | null;
      readonly declaredMethod: string;
      readonly reference?: string | null;
      readonly notes?: string | null;
      readonly fileIds: readonly string[];
      readonly claimedCharges: readonly ClaimedChargeInput[];
    },
  ): Promise<MutationResult<Evidence> | null> {
    const claims = requireAuth(req);

    const resolved = await resolveFiles(input.fileIds);
    if (!resolved.ok) {
      return { ok: false, error: { kind: "invalid", message: resolved.message } };
    }

    try {
      return await withTransaction(contextFor(req), async (tx) => {
        const scope = await meRepository.myUnitScope(tx, claims.sub, input.unitId);
        if (scope === null) {
          return null;
        }
        // Los cargos declarados deben ser de ESTA unidad (que ya es mía), sin
        // repetidos y con la suma dentro del monto declarado: mismas reglas
        // que la captura del operador.
        const claimError = claimedChargesError(input.claimedCharges, input.declaredAmount);
        if (claimError !== null) {
          return { ok: false as const, error: { kind: "invalid" as const, message: claimError } };
        }
        if (input.claimedCharges.length > 0) {
          const owned = await paymentEvidenceRepository.countUnitCharges(
            tx,
            input.unitId,
            input.claimedCharges.map((c) => c.chargeId),
          );
          if (owned !== input.claimedCharges.length) {
            return {
              ok: false as const,
              error: {
                kind: "invalid" as const,
                message: "Alguno de los cargos marcados ya no existe. Recarga e intenta de nuevo.",
              },
            };
          }
        }
        const evidence = await paymentEvidenceRepository.create(tx, {
          customerId: claims.customerId,
          communityId: scope.communityId,
          unitId: input.unitId,
          memberId: scope.memberId,
          source: "resident",
          declaredAmount: input.declaredAmount,
          declaredPaidAt: input.declaredPaidAt ?? null,
          declaredMethod: input.declaredMethod,
          reference: input.reference ?? null,
          notes: input.notes ?? null,
          files: resolved.files,
          claimedCharges: input.claimedCharges,
        });
        return { ok: true as const, value: evidence };
      });
    } catch (err) {
      return {
        ok: false,
        error: translatePgError(err, {
          reference: "La unidad no existe o está fuera de tu alcance.",
          check: "Los datos del comprobante no son válidos.",
        }),
      };
    }
  },

  /**
   * Cargos ABIERTOS de una unidad mía — lo que el formulario de "enviar
   * comprobante" ofrece marcar. Reusa la consulta del recurso charges (misma
   * proyección, mismo saldo derivado); lo que cambia es la frontera: la
   * cadena del padrón en lugar de la membresía de comunidad. `null` = la
   * unidad no es mía (404 indistinguible de inexistente).
   */
  async myUnitOpenCharges(
    req: FastifyRequest,
    input: { readonly unitId: string; readonly page: number; readonly pageSize: number },
  ): Promise<{ items: Charge[]; total: number } | null> {
    const claims = requireAuth(req);
    return withTransaction(contextFor(req), async (tx) => {
      const scope = await meRepository.myUnitScope(tx, claims.sub, input.unitId);
      if (scope === null) {
        return null;
      }
      return chargesRepository.list(tx, {
        unitId: input.unitId,
        page: input.page,
        pageSize: input.pageSize,
        openOnly: true,
      });
    });
  },

  /**
   * Enlace firmado de descarga de un archivo de una evidencia MÍA. Misma
   * mecánica que el lado del operador: primero la propiedad, después el
   * enlace con la API key del servicio.
   */
  async myEvidenceFileLink(
    req: FastifyRequest,
    evidenceId: string,
    fileId: string,
  ): Promise<{ url: string; expiresAt: string } | "not_found" | "unavailable"> {
    const claims = requireAuth(req);
    const ref = await withTransaction(contextFor(req), async (tx) => {
      const mine = await paymentEvidenceRepository.getMine(tx, claims.sub, evidenceId);
      if (mine === null) {
        return null;
      }
      return paymentEvidenceRepository.getFileRef(tx, evidenceId, fileId);
    });
    if (ref === null) {
      return "not_found";
    }
    const link = await storageClient.createDownloadLink(ref.storageFileId);
    if (!link.ok) {
      return link.status === 404 ? "not_found" : "unavailable";
    }
    return link.value;
  },
};
