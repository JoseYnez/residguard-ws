import type { FastifyRequest } from "fastify";
import { requireAuth } from "../../../core/auth/authenticate";
import { contextFor } from "../../../core/auth/community_access";
import { withTransaction } from "../../../core/db/with_transaction";
import { translatePgError, type MutationResult } from "../../../core/http/pg_errors";
import { storageClient, type StorageFileMetadata } from "../../../core/storage/storage_client";
import {
  expensesRepository,
  type CreateExpenseInput,
  type Expense,
  type ListExpensesInput,
  type UpdateExpenseInput,
} from "./expenses_v1.repository";

// Orquestación del recurso expenses. El acceso a la comunidad de la ruta ya
// lo garantizó requireCommunityAccess; las FKs compuestas de BD validan que el
// rubro y la caja pertenezcan a esa misma comunidad. Lo que las FKs NO validan
// es el `status` de rubro y caja, así que eso se comprueba aquí antes de
// escribir.
//
// Los COMPROBANTES llegan como ids: de storage-service los recién subidos por
// la SPA, de FILA los que el gasto ya tiene (el id que expone el detalle). Se
// validan contra storage ANTES de abrir la transacción de escritura — un id
// inventado no llega a la BD — y su metadata se espeja en expense_files.

const PG_MESSAGES = {
  reference: "El rubro de gasto o la caja no existen o no pertenecen a esta comunidad.",
  check: "El monto del gasto debe ser mayor a cero.",
} as const;

const INACTIVE_CATEGORY = "El rubro de gasto no existe o no pertenece a esta comunidad.";

const INVALID_CASH_ACCOUNT =
  "La caja no existe, no está activa o no pertenece a esta comunidad.";

/** Lo que recibe el controller: el cuerpo del cliente, con los adjuntos aún
 *  como ids (el repository los recibe ya resueltos). */
export type CreateExpenseCommand = Omit<CreateExpenseInput, "files"> & {
  readonly fileIds?: readonly string[];
};

export type UpdateExpenseCommand = Omit<UpdateExpenseInput, "files"> & {
  readonly fileIds?: readonly string[];
};

/**
 * Valida contra storage-service cada comprobante declarado y devuelve su
 * metadata. `kept` son los que el gasto YA tiene, por id de SU FILA: se reusan
 * con la metadata espejada, sin preguntar a storage por un id que allí no
 * existe. Misma mecánica que comunicados y evidencias de pago.
 */
async function resolveFiles(
  fileIds: readonly string[],
  kept: ReadonlyMap<string, StorageFileMetadata> = new Map(),
): Promise<{ ok: true; files: StorageFileMetadata[] } | { ok: false; message: string }> {
  const files: StorageFileMetadata[] = [];
  for (const fileId of fileIds) {
    const existing = kept.get(fileId);
    if (existing !== undefined) {
      files.push(existing);
      continue;
    }
    const result = await storageClient.getFile(fileId);
    if (!result.ok) {
      return {
        ok: false,
        message:
          result.status === 404
            ? "Uno de los comprobantes no existe o ya no está disponible."
            : `No se pudo validar el comprobante adjunto: ${result.message}`,
      };
    }
    files.push(result.value);
  }
  return { ok: true, files };
}

export const expensesController = {
  async list(
    req: FastifyRequest,
    input: ListExpensesInput,
  ): Promise<{ items: Expense[]; total: number }> {
    return withTransaction(contextFor(req), (tx) => expensesRepository.list(tx, input));
  },

  async getById(req: FastifyRequest, communityId: string, id: string): Promise<Expense | null> {
    return withTransaction(contextFor(req), (tx) =>
      expensesRepository.getById(tx, communityId, id),
    );
  },

  async create(
    req: FastifyRequest,
    communityId: string,
    command: CreateExpenseCommand,
  ): Promise<MutationResult<Expense>> {
    const claims = requireAuth(req);
    const { fileIds, ...input } = command;
    // Fuera de la transacción: una llamada HTTP por archivo no debe sostener
    // una conexión de BD, y un id inválido se rechaza antes de escribir nada.
    const resolved = await resolveFiles(fileIds ?? []);
    if (!resolved.ok) {
      return { ok: false, error: { kind: "invalid", message: resolved.message } };
    }
    try {
      const outcome = await withTransaction(contextFor(req), async (tx) => {
        const usable = await expensesRepository.activeCategoryExists(
          tx,
          communityId,
          input.expenseCategoryId,
        );
        if (!usable) {
          return "bad_category" as const;
        }
        // Con caja declarada: existir, estar activa y ser de la comunidad de
        // la ruta (la FK compuesta de BD no mira el `status`).
        if (input.cashAccountId !== undefined && input.cashAccountId !== null) {
          const cashOk = await expensesRepository.activeCashAccountExists(
            tx,
            communityId,
            input.cashAccountId,
          );
          if (!cashOk) {
            return "bad_cash_account" as const;
          }
        }
        return expensesRepository.create(tx, claims.customerId, communityId, {
          ...input,
          files: resolved.files,
        });
      });
      if (outcome === "bad_category") {
        return { ok: false, error: { kind: "invalid", message: INACTIVE_CATEGORY } };
      }
      if (outcome === "bad_cash_account") {
        return { ok: false, error: { kind: "invalid", message: INVALID_CASH_ACCOUNT } };
      }
      return { ok: true, value: outcome };
    } catch (err) {
      return { ok: false, error: translatePgError(err, PG_MESSAGES) };
    }
  },

  /** `null` (fuera de ok/error) cuando el gasto no existe → 404 en la route. */
  async update(
    req: FastifyRequest,
    communityId: string,
    id: string,
    command: UpdateExpenseCommand,
  ): Promise<MutationResult<Expense> | null> {
    const claims = requireAuth(req);
    const { fileIds, ...input } = command;

    // Adjuntos: los que el gasto ya tiene se reusan por id de fila; el resto se
    // valida contra storage. Lectura corta en su propia transacción, la llamada
    // HTTP fuera de cualquier transacción, y la escritura después.
    let files: StorageFileMetadata[] | undefined;
    if (fileIds !== undefined) {
      const kept = await withTransaction(contextFor(req), (tx) =>
        expensesRepository.keptFiles(tx, communityId, id),
      );
      const resolved = await resolveFiles(fileIds, kept);
      if (!resolved.ok) {
        return { ok: false, error: { kind: "invalid", message: resolved.message } };
      }
      files = resolved.files;
    }

    try {
      const outcome = await withTransaction(contextFor(req), async (tx) => {
        // Solo se valida si el PATCH cambia el rubro: editar otros campos de un
        // gasto viejo cuyo rubro se retiró después sigue siendo legítimo.
        if (input.expenseCategoryId !== undefined) {
          const usable = await expensesRepository.activeCategoryExists(
            tx,
            communityId,
            input.expenseCategoryId,
          );
          if (!usable) {
            return "bad_category" as const;
          }
        }
        // Igual con la caja: solo si el PATCH la cambia (null = limpiar, no
        // se valida nada).
        if (input.cashAccountId !== undefined && input.cashAccountId !== null) {
          const cashOk = await expensesRepository.activeCashAccountExists(
            tx,
            communityId,
            input.cashAccountId,
          );
          if (!cashOk) {
            return "bad_cash_account" as const;
          }
        }
        return expensesRepository.update(tx, claims.customerId, communityId, id, {
          ...input,
          ...(files !== undefined && { files }),
        });
      });
      if (outcome === "bad_category") {
        return { ok: false, error: { kind: "invalid", message: INACTIVE_CATEGORY } };
      }
      if (outcome === "bad_cash_account") {
        return { ok: false, error: { kind: "invalid", message: INVALID_CASH_ACCOUNT } };
      }
      if (outcome === null) {
        return null;
      }
      return { ok: true, value: outcome };
    } catch (err) {
      return { ok: false, error: translatePgError(err, PG_MESSAGES) };
    }
  },

  async softDelete(req: FastifyRequest, communityId: string, id: string): Promise<boolean> {
    return withTransaction(contextFor(req), (tx) =>
      expensesRepository.softDelete(tx, communityId, id),
    );
  },

  /**
   * Enlace firmado de descarga de un comprobante. La autorización POR RECURSO
   * vive aquí: primero el alcance (el gasto es de la comunidad de la ruta, que
   * requireCommunityAccess ya autorizó), después el enlace con la API key del
   * servicio. El enlace descarga sin credencial hasta vencer — vigencia corta,
   * no se almacena.
   */
  async fileLink(
    req: FastifyRequest,
    communityId: string,
    expenseId: string,
    fileId: string,
  ): Promise<{ url: string; expiresAt: string } | "not_found" | "unavailable"> {
    const ref = await withTransaction(contextFor(req), (tx) =>
      expensesRepository.fileRef(tx, communityId, expenseId, fileId),
    );
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
