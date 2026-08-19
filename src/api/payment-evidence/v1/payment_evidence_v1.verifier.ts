import { Verifiers as V } from "structure-verifier";
import {
  errorResponseV1V,
  ISO_DATE_REGEX,
  ISO_DATETIME_REGEX,
  MONEY_MAX,
  pageQueryFields,
  UUID_REGEX,
} from "../../common/common_v1.verifier";
import { PAYMENT_METHODS } from "../../payments/v1/payments_v1.verifier";

// Contratos del recurso payment-evidence (billing.payment_evidence): el
// comprobante que el residente ENVÍA (o ventanilla captura) diciendo que pagó.
// No es un pago: el pago nace al VERIFICAR (billing.sp_verify_payment_evidence,
// que delega en sp_register_payment) — por eso el cuerpo de la verificación es
// el MISMO contrato que el de POST /payments.

/** Espejo de `billing.payment_evidence_status`. */
export const EVIDENCE_STATUSES = ["pending_review", "verified", "rejected"] as const;

/** Espejo de `billing.evidence_source`. */
export const EVIDENCE_SOURCES = ["resident", "operator"] as const;

/** Tope de archivos por evidencia: dos fotos y un PDF ya es un envío gordo. */
export const EVIDENCE_MAX_FILES = 5;

// Campos declarados, compartidos por las dos altas (residente y ventanilla).
// `declaredPaidAt` con offset OBLIGATORIO — misma regla que payments.paidAt.
const declaredFields = {
  declaredAmount: new V.NumberNotNull({ min: 0.01, max: MONEY_MAX, maxDecimalPlaces: 2 }),
  declaredPaidAt: new V.String({ regex: ISO_DATETIME_REGEX }),
  declaredMethod: new V.StringNotNull({ in: [...PAYMENT_METHODS] }),
  reference: new V.String({ maxLength: 200 }),
  notes: new V.String({ maxLength: 1000 }),
};

// --- Entrada: enviar (POST /me/payment-evidence) ------------------------------
// El residente NO reparte a cargos: declara monto/fecha/método y adjunta. Los
// archivos ya viven en storage (la SPA los subió con el Bearer del usuario);
// aquí viajan solo sus ids. AL MENOS UNO: una evidencia sin comprobante no
// evidencia nada.
export const createMyEvidenceV1V = new V.ObjectNotNull(
  {
    unitId: new V.StringNotNull({ regex: UUID_REGEX }),
    ...declaredFields,
    fileIds: new V.ArrayNotNull(new V.StringNotNull({ regex: UUID_REGEX }), {
      minLength: 1,
      maxLength: EVIDENCE_MAX_FILES,
    }),
  },
  { strictMode: true },
);

// --- Entrada: capturar en ventanilla (POST /payment-evidence) -----------------
// El operador sí nombra al miembro (el residente es SIEMPRE él mismo). Los
// archivos son opcionales: el comprobante en papel que le llevaron no siempre
// se digitaliza.
export const createEvidenceV1V = new V.ObjectNotNull(
  {
    unitId: new V.StringNotNull({ regex: UUID_REGEX }),
    memberId: new V.StringNotNull({ regex: UUID_REGEX }),
    ...declaredFields,
    fileIds: new V.Array(new V.StringNotNull({ regex: UUID_REGEX }), {
      maxLength: EVIDENCE_MAX_FILES,
    }),
  },
  { strictMode: true },
);

// --- Entrada: listar (GET /payment-evidence) ----------------------------------
// communityId OBLIGATORIO: la bandeja es de una comunidad y el alcance del
// actor se valida sobre ella. `status` default en el controller:
// pending_review (la bandeja ES lo pendiente; lo demás se consulta a pedido).
export const listEvidenceQueryV1V = new V.ObjectNotNull(
  {
    ...pageQueryFields(),
    communityId: new V.StringNotNull({ regex: UUID_REGEX }),
    status: new V.String({ in: [...EVIDENCE_STATUSES] }),
    unitId: new V.String({ regex: UUID_REGEX }),
    from: new V.String({ regex: ISO_DATE_REGEX }),
    to: new V.String({ regex: ISO_DATE_REGEX }),
  },
  { strictMode: true },
);

// --- Entrada: listar las mías (GET /me/payment-evidence) ----------------------
export const listMyEvidenceQueryV1V = new V.ObjectNotNull(
  {
    ...pageQueryFields(),
    unitId: new V.String({ regex: UUID_REGEX }),
    status: new V.String({ in: [...EVIDENCE_STATUSES] }),
  },
  { strictMode: true },
);

// --- Entrada: verificar (POST /payment-evidence/:id/verification) -------------
// El MISMO contrato que POST /payments: verificar ES registrar el pago. La SPA
// lo precarga con lo declarado; el operador captura lo que el comprobante
// realmente dice (monto y fecha REALES pueden diferir de los declarados).
export const verifyEvidenceV1V = new V.ObjectNotNull(
  {
    amount: new V.NumberNotNull({ min: 0.01, max: MONEY_MAX, maxDecimalPlaces: 2 }),
    method: new V.StringNotNull({ in: [...PAYMENT_METHODS] }),
    paidAt: new V.String({ regex: ISO_DATETIME_REGEX }),
    reference: new V.String({ maxLength: 200 }),
    cashAccountId: new V.String({ regex: UUID_REGEX }),
    allocations: new V.ArrayNotNull(
      new V.ObjectNotNull(
        {
          chargeId: new V.StringNotNull({ regex: UUID_REGEX }),
          amount: new V.NumberNotNull({ min: 0.01, max: MONEY_MAX, maxDecimalPlaces: 2 }),
        },
        { strictMode: true },
      ),
      { minLength: 1, maxLength: 100 },
    ),
  },
  { strictMode: true },
);

// --- Entrada: rechazar (POST /payment-evidence/:id/rejection) -----------------
// El motivo es OBLIGATORIO (el CHECK de la tabla también lo exige): "rechazada"
// sin porqué solo genera la llamada telefónica que este flujo quería evitar.
export const rejectEvidenceV1V = new V.ObjectNotNull(
  {
    note: new V.StringNotNull({ minLength: 3, maxLength: 500 }),
  },
  { strictMode: true },
);

// --- Salida: un archivo adjunto ------------------------------------------------
export const evidenceFileV1V = new V.ObjectNotNull({
  id: new V.StringNotNull(),
  storageFileId: new V.StringNotNull(),
  filename: new V.StringNotNull(),
  contentType: new V.StringNotNull(),
  sizeBytes: new V.NumberNotNull(),
  sha256: new V.StringNotNull(),
});

// --- Salida: una evidencia -----------------------------------------------------
// `payment` viaja resuelto (si existe): el detalle del pago vive en /payments,
// aquí solo la referencia y el monto real para contrastar con lo declarado.
const evidencePaymentV1V = new V.Object({
  id: new V.StringNotNull(),
  amount: new V.NumberNotNull(),
  method: new V.StringNotNull(),
  paidAt: new V.StringNotNull(),
});

export const evidenceV1V = new V.ObjectNotNull({
  id: new V.StringNotNull(),
  communityId: new V.StringNotNull(),
  unitId: new V.StringNotNull(),
  unitCode: new V.StringNotNull(),
  memberId: new V.StringNotNull(),
  memberName: new V.StringNotNull(),
  declaredAmount: new V.NumberNotNull(),
  declaredPaidAt: new V.String(),
  declaredMethod: new V.StringNotNull(),
  reference: new V.String(),
  notes: new V.String(),
  source: new V.StringNotNull(),
  evidenceStatus: new V.StringNotNull(),
  payment: evidencePaymentV1V,
  resolvedAt: new V.String(),
  resolvedBy: new V.String(),
  resolutionNote: new V.String(),
  files: new V.ArrayNotNull(evidenceFileV1V),
  createdAt: new V.StringNotNull(),
  updatedAt: new V.StringNotNull(),
});

export const evidenceListV1V = new V.ObjectNotNull({
  items: new V.ArrayNotNull(evidenceV1V),
  total: new V.NumberNotNull(),
  page: new V.NumberNotNull(),
  pageSize: new V.NumberNotNull(),
});

// --- Salida: enlace firmado de descarga -----------------------------------------
// El enlace descarga SIN credencial hasta que vence: la SPA lo pide al momento
// de mostrar el archivo y no lo almacena.
export const evidenceFileLinkV1V = new V.ObjectNotNull({
  url: new V.StringNotNull(),
  expiresAt: new V.StringNotNull(),
});

// --- Parámetros de ruta ----------------------------------------------------------
export const evidenceFileParamV1V = new V.ObjectNotNull(
  {
    id: new V.StringNotNull({ regex: UUID_REGEX }),
    fileId: new V.StringNotNull({ regex: UUID_REGEX }),
  },
  { strictMode: true },
);

export { errorResponseV1V };
