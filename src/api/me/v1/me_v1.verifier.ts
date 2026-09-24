import { Verifiers as V } from "structure-verifier";
import { errorResponseV1V, pageQueryFields, UUID_REGEX } from "../../common/common_v1.verifier";
import { paymentDetailFields } from "../../payments/v1/payments_v1.verifier";
import { unitChargeStatementV1V, unitStatementQueryV1V } from "../../reports/v1/reports_v1.verifier";

// Contratos del recurso me/v1: la AUTOCONSULTA del residente. Todo lo que sale
// de aquí es del usuario del token — no hay parámetro de comunidad ni de
// persona: la pertenencia la resuelve el servidor por el vínculo del padrón
// (members.user_id = sub).

// --- Salida: una unidad MÍA ---------------------------------------------------
// La asignación vista desde el usuario: la unidad con su comunidad y el rol de
// la relación (owner/tenant/resident). Trae la comunidad porque el residente no
// tiene selector de alcance: sus unidades pueden repartirse en varias.
export const myUnitV1V = new V.ObjectNotNull({
  unitId: new V.StringNotNull(),
  unitCode: new V.StringNotNull(),
  unitTower: new V.String(),
  unitType: new V.StringNotNull(),
  address: new V.String(),
  /** Rol de la RELACIÓN persona↔unidad (owner | tenant | resident). */
  memberType: new V.StringNotNull(),
  communityId: new V.StringNotNull(),
  communityName: new V.StringNotNull(),
});

// --- Salida: mis unidades -----------------------------------------------------
// SIN paginación, a propósito (excepción documentada al §5 del CLAUDE.md): el
// conjunto está acotado por naturaleza — las unidades de UNA persona — y un
// residente típico tiene una o dos. Paginar obligaría al portal a orquestar
// páginas para pintar una lista de tres filas.
export const myUnitListV1V = new V.ObjectNotNull({
  items: new V.ArrayNotNull(myUnitV1V),
});

// --- Mis pagos registrados ------------------------------------------------------
// El dinero YA asentado sobre cargos de mis unidades (la evidencia es la
// promesa; esto es el hecho). Paginado: los pagos se acumulan con los años.
export const listMyPaymentsQueryV1V = new V.ObjectNotNull(
  { ...pageQueryFields() },
  { strictMode: true },
);

/** Un cargo mío que el pago cubrió: concepto + periodo legibles y lo aplicado. */
export const myPaymentCoverV1V = new V.ObjectNotNull({
  concept: new V.StringNotNull(),
  /** Nombre del periodo (label o derivado); null = cargo suelto. */
  period: new V.String(),
  unitCode: new V.StringNotNull(),
  /** Torre y tipo: el portal nombra el domicilio por su tipo ("casa 426-A"). */
  unitTower: new V.String(),
  unitType: new V.StringNotNull(),
  amount: new V.NumberNotNull(),
});

export const myPaymentV1V = new V.ObjectNotNull({
  id: new V.StringNotNull(),
  /** Total del depósito. */
  amount: new V.NumberNotNull(),
  /** Lo aplicado a MIS unidades (≤ amount cuando el depósito cubrió más). */
  appliedToMyUnits: new V.NumberNotNull(),
  method: new V.StringNotNull(),
  reference: new V.String(),
  paidAt: new V.StringNotNull(),
  unitCodes: new V.ArrayNotNull(new V.StringNotNull()),
  /** Qué cubrió en mis unidades, aplicación por aplicación. */
  covers: new V.ArrayNotNull(myPaymentCoverV1V),
});

export const myPaymentListV1V = new V.ObjectNotNull({
  items: new V.ArrayNotNull(myPaymentV1V),
  total: new V.NumberNotNull(),
  page: new V.NumberNotNull(),
  pageSize: new V.NumberNotNull(),
});

// --- Un pago mío en detalle -----------------------------------------------------
// La MISMA forma que el detalle del operador (paymentDetailV1V) —con ella la
// app dibuja el mismo recibo— más `communityName`: el residente no tiene
// selector de comunidad del cual sacar el nombre que encabeza el recibo.
export const myPaymentDetailV1V = new V.ObjectNotNull({
  ...paymentDetailFields(),
  communityName: new V.StringNotNull(),
});

// El estado de cuenta reusa el contrato COMPLETO de la V2 de reports
// (unitChargeStatementV1V): misma fila por cargo, mismos totales — es la misma
// información con otra frontera de autorización.
export { errorResponseV1V, unitChargeStatementV1V, unitStatementQueryV1V };

// Las visitas reusan el contrato del dominio access por la misma razón: el pase
// que ve el residente y el que ve la caseta son el MISMO objeto. Dos contratos
// separados divergirían con el primer campo nuevo.
export {
  createVisitV1V,
  listMyVisitsQueryV1V,
  myVisitEventFileParamV1V,
  visitDetailV1V,
  visitEventFileLinkV1V,
  visitListV1V,
  visitV1V,
} from "../../visits/v1/visits_v1.verifier";

// Las evidencias de pago reusan el contrato del recurso payment-evidence: el
// comprobante que ve el residente y el que atiende el operador son el MISMO
// objeto — cambia la frontera (la cadena del padrón), no el contrato.
export {
  createMyEvidenceV1V,
  evidenceFileLinkV1V,
  evidenceFileParamV1V,
  evidenceListV1V,
  evidenceV1V,
  listMyEvidenceQueryV1V,
} from "../../payment-evidence/v1/payment_evidence_v1.verifier";

// El checklist de cargos del envío reusa el contrato del recurso charges: el
// cargo que el residente marca y el que lista el operador son el MISMO objeto.
export { chargeListV1V } from "../../charges/v1/charges_v1.verifier";

// --- Comunicados dirigidos a MÍ -----------------------------------------------
// Proyección de LECTURA: el residente ve el comunicado, no su maquinaria. Del
// contrato del operador NO viaja nada de la audiencia (a quién más le llegó no
// es asunto suyo) ni el conteo de lecturas; lo que se añade es `read`.
export const listMyAnnouncementsQueryV1V = new V.ObjectNotNull(
  { ...pageQueryFields() },
  { strictMode: true },
);

export const myAnnouncementV1V = new V.ObjectNotNull({
  id: new V.StringNotNull(),
  communityId: new V.StringNotNull(),
  communityName: new V.StringNotNull(),
  title: new V.StringNotNull(),
  excerpt: new V.StringNotNull(),
  isPinned: new V.BooleanNotNull(),
  publishedAt: new V.StringNotNull(),
  /** No nulo = corregido tras publicar (la tarjeta dice "editado"). */
  editedAt: new V.String(),
  /** Quién lo redactó; null si su cuenta no está en el espejo core.users. */
  createdByName: new V.String(),
  fileCount: new V.NumberNotNull(),
  read: new V.BooleanNotNull(),
});

export const myAnnouncementFileV1V = new V.ObjectNotNull({
  id: new V.StringNotNull(),
  filename: new V.StringNotNull(),
  contentType: new V.StringNotNull(),
  sizeBytes: new V.NumberNotNull(),
  sortOrder: new V.NumberNotNull(),
});

export const myAnnouncementDetailV1V = new V.ObjectNotNull({
  id: new V.StringNotNull(),
  communityId: new V.StringNotNull(),
  communityName: new V.StringNotNull(),
  title: new V.StringNotNull(),
  excerpt: new V.StringNotNull(),
  isPinned: new V.BooleanNotNull(),
  publishedAt: new V.StringNotNull(),
  editedAt: new V.String(),
  createdByName: new V.String(),
  fileCount: new V.NumberNotNull(),
  read: new V.BooleanNotNull(),
  /** Markdown acotado tal cual se guardó: el render vive en la SPA. */
  body: new V.StringNotNull(),
  files: new V.ArrayNotNull(myAnnouncementFileV1V),
});

export const myAnnouncementListV1V = new V.ObjectNotNull({
  items: new V.ArrayNotNull(myAnnouncementV1V),
  total: new V.NumberNotNull(),
  page: new V.NumberNotNull(),
  pageSize: new V.NumberNotNull(),
});

/** El número del badge del nav, y nada más. */
export const unreadAnnouncementCountV1V = new V.ObjectNotNull({
  count: new V.NumberNotNull(),
});

/** Params de un adjunto: /me/announcements/:id/files/:fileId/link */
export const myAnnouncementFileParamV1V = new V.ObjectNotNull(
  {
    id: new V.StringNotNull({ regex: UUID_REGEX }),
    fileId: new V.StringNotNull({ regex: UUID_REGEX }),
  },
  { strictMode: true },
);

/** El enlace firmado reusa el contrato de los demás adjuntos del portal. */
export { announcementFileLinkV1V } from "../../announcements/v1/announcements_v1.verifier";
