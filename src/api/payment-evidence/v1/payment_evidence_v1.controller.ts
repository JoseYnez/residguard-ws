import type { FastifyRequest } from "fastify";
import { requireAuth } from "../../../core/auth/authenticate";
import {
  contextFor,
  resolveUnitAccess,
  userHasCommunityAccess,
} from "../../../core/auth/community_access";
import { withTransaction } from "../../../core/db/with_transaction";
import { translatePgError, type MutationResult } from "../../../core/http/pg_errors";
import { storageClient, type StorageFileMetadata } from "../../../core/storage/storage_client";
import {
  paymentEvidenceRepository,
  type Evidence,
  type ListEvidenceInput,
} from "./payment_evidence_v1.repository";

// Orquestación del recurso payment-evidence. La evidencia pertenece a UNA
// comunidad (la de su unidad y su miembro), así que el alcance del operador se
// mide contra ella — mismo criterio que payments. La verificación reusa las
// validaciones previas del registro de pagos (suma exacta, sin cargos
// repetidos) porque ES un registro de pago.

const PG_MESSAGES = {
  conflict:
    "El mismo cargo aparece más de una vez en las aplicaciones, o el pago ya respalda otra evidencia.",
  check:
    "La evidencia ya fue atendida, o los cargos —y la caja destino— no son todos de su comunidad.",
  notFound: "La evidencia, alguno de los cargos o la caja destino no existe o no está activo.",
  reference: "La unidad o la persona no existe o no pertenece a esa comunidad.",
} as const;

/** Suma en centavos para comparar sin errores de flotante. */
function sumCents(amounts: readonly number[]): number {
  return amounts.reduce((acc, a) => acc + Math.round(a * 100), 0);
}

/** Campos declarados que comparten las dos altas. */
export interface DeclaredEvidenceInput {
  readonly declaredAmount: number;
  readonly declaredPaidAt?: string | null;
  readonly declaredMethod: string;
  readonly reference?: string | null;
  readonly notes?: string | null;
  readonly fileIds: readonly string[];
}

export interface VerifyInput {
  readonly amount: number;
  readonly method: string;
  readonly paidAt?: string | null;
  readonly reference?: string | null;
  readonly cashAccountId?: string | null;
  readonly allocations: ReadonlyArray<{ readonly chargeId: string; readonly amount: number }>;
}

/**
 * Valida contra storage cada archivo que la evidencia declara y devuelve su
 * metadata (el espejo a copiar). Un id inexistente —o de un bucket que la app
 * no alcanza: storage responde 404 igual— tumba el alta completa ANTES de
 * abrir la transacción: no se escribe una evidencia que promete archivos que
 * no existen.
 */
async function resolveFiles(
  fileIds: readonly string[],
): Promise<{ ok: true; files: StorageFileMetadata[] } | { ok: false; message: string }> {
  const files: StorageFileMetadata[] = [];
  for (const fileId of fileIds) {
    const result = await storageClient.getFile(fileId);
    if (!result.ok) {
      return {
        ok: false,
        message:
          result.status === 404
            ? "Alguno de los archivos adjuntos no existe. Vuelve a subir el comprobante."
            : "No se pudo validar el comprobante contra el almacén de archivos. Intenta de nuevo.",
      };
    }
    files.push(result.value);
  }
  return { ok: true, files };
}

export const paymentEvidenceController = {
  /**
   * Captura en ventanilla (source=operator). La comunidad se deriva de la
   * unidad; el actor debe alcanzarla. El miembro debe ser de esa misma
   * comunidad — la FK compuesta lo rechaza y aquí se traduce a error legible.
   */
  async create(
    req: FastifyRequest,
    input: DeclaredEvidenceInput & { readonly unitId: string; readonly memberId: string },
  ): Promise<MutationResult<Evidence> | null> {
    const claims = requireAuth(req);

    const resolved = await resolveFiles(input.fileIds);
    if (!resolved.ok) {
      return { ok: false, error: { kind: "invalid", message: resolved.message } };
    }

    try {
      return await withTransaction(contextFor(req), async (tx) => {
        const scope = await resolveUnitAccess(tx, claims.sub, input.unitId);
        if (scope === null) {
          return null;
        }
        const evidence = await paymentEvidenceRepository.create(tx, {
          customerId: claims.customerId,
          communityId: scope.communityId,
          unitId: input.unitId,
          memberId: input.memberId,
          source: "operator",
          declaredAmount: input.declaredAmount,
          declaredPaidAt: input.declaredPaidAt ?? null,
          declaredMethod: input.declaredMethod,
          reference: input.reference ?? null,
          notes: input.notes ?? null,
          files: resolved.files,
        });
        return { ok: true as const, value: evidence };
      });
    } catch (err) {
      return { ok: false, error: translatePgError(err, PG_MESSAGES) };
    }
  },

  /** null = comunidad fuera del alcance del actor (la ruta responde 404). */
  async list(
    req: FastifyRequest,
    input: ListEvidenceInput,
  ): Promise<{ items: Evidence[]; total: number } | null> {
    const claims = requireAuth(req);
    return withTransaction(contextFor(req), async (tx) => {
      const allowed = await userHasCommunityAccess(tx, claims.sub, input.communityId);
      if (!allowed) {
        return null;
      }
      return paymentEvidenceRepository.list(tx, input);
    });
  },

  async getById(req: FastifyRequest, id: string): Promise<Evidence | null> {
    const claims = requireAuth(req);
    return withTransaction(contextFor(req), (tx) =>
      paymentEvidenceRepository.getById(tx, claims.sub, id),
    );
  },

  /**
   * Verifica la evidencia: registra el pago (vía sancionada) y estampa el
   * vínculo. null → 404 (fuera de alcance o inexistente). El "ya atendida"
   * llega como conflict (409): la evidencia existe y el actor la ve, pero otro
   * operador le ganó — que es información, no un misterio.
   */
  async verify(
    req: FastifyRequest,
    id: string,
    input: VerifyInput,
  ): Promise<MutationResult<Evidence> | null> {
    const claims = requireAuth(req);

    // Mismas validaciones previas que el registro directo de pagos.
    const chargeIds = input.allocations.map((a) => a.chargeId);
    const distinct = new Set(chargeIds);
    if (distinct.size !== chargeIds.length) {
      return { ok: false, error: { kind: "invalid", message: PG_MESSAGES.conflict } };
    }
    if (sumCents(input.allocations.map((a) => a.amount)) !== Math.round(input.amount * 100)) {
      return {
        ok: false,
        error: {
          kind: "invalid",
          message: "La suma de las aplicaciones debe igualar el monto del pago.",
        },
      };
    }

    try {
      return await withTransaction(contextFor(req), async (tx) => {
        const visible = await paymentEvidenceRepository.getById(tx, claims.sub, id);
        if (visible === null) {
          return null;
        }
        if (visible.evidenceStatus !== "pending_review") {
          return {
            ok: false as const,
            error: {
              kind: "conflict" as const,
              message: "Esta evidencia ya fue atendida (verificada o rechazada).",
            },
          };
        }
        const evidence = await paymentEvidenceRepository.verify(tx, {
          evidenceId: id,
          amount: input.amount,
          method: input.method,
          paidAt: input.paidAt ?? null,
          reference: input.reference ?? null,
          cashAccountId: input.cashAccountId ?? null,
          allocations: input.allocations,
        });
        return { ok: true as const, value: evidence };
      });
    } catch (err) {
      return { ok: false, error: translatePgError(err, PG_MESSAGES) };
    }
  },

  /**
   * Rechaza con motivo. null → 404; "ya atendida" → conflict, igual que
   * verify (el UPDATE condicionado al estado es quien decide al ganador).
   */
  async reject(
    req: FastifyRequest,
    id: string,
    note: string,
  ): Promise<MutationResult<Evidence> | null> {
    const claims = requireAuth(req);
    return withTransaction(contextFor(req), async (tx) => {
      const visible = await paymentEvidenceRepository.getById(tx, claims.sub, id);
      if (visible === null) {
        return null;
      }
      const rejected = await paymentEvidenceRepository.reject(tx, claims.sub, id, note);
      if (rejected === null) {
        return {
          ok: false as const,
          error: {
            kind: "conflict" as const,
            message: "Esta evidencia ya fue atendida (verificada o rechazada).",
          },
        };
      }
      return { ok: true as const, value: rejected };
    });
  },

  /**
   * Enlace firmado de descarga de un archivo. La autorización POR RECURSO vive
   * aquí: primero el alcance de la evidencia (comunidad del actor), después el
   * enlace con la API key del servicio. El enlace resultante descarga sin
   * credencial hasta vencer — vigencia corta, no se almacena.
   */
  async fileLink(
    req: FastifyRequest,
    evidenceId: string,
    fileId: string,
  ): Promise<{ url: string; expiresAt: string } | "not_found" | "unavailable"> {
    const claims = requireAuth(req);
    const ref = await withTransaction(contextFor(req), async (tx) => {
      const visible = await paymentEvidenceRepository.getById(tx, claims.sub, evidenceId);
      if (visible === null) {
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

export { resolveFiles };
