import { Verifiers as V } from "structure-verifier";
import {
  errorResponseV1V,
  ISO_DATE_REGEX,
  MONEY_MAX,
  pageQueryFields,
  UUID_REGEX,
} from "../../common/common_v1.verifier";

// Contratos del recurso charges (billing.charges): estado de cuenta por
// comunidad (todas sus unidades) o por unidad, y REGISTRO de una cuota sobre
// UNA O VARIAS unidades por un periodo (un cargo por unidad, transacción
// todo-o-nada). Edición/condonación siguen sin endpoint; el estatus de cobro
// lo mantienen los procedures de pago.

export const PAYMENT_STATUSES = ["pending", "partial", "paid", "waived"] as const;

// --- Entrada: crear (POST /communities/:communityId/charges) -------------------
export const createChargesV1V = new V.ObjectNotNull(
  {
    feeId: new V.StringNotNull({ regex: UUID_REGEX }),
    /** Unidades de la comunidad a las que se asigna la cuota (sin repetir). */
    unitIds: new V.ArrayNotNull(new V.StringNotNull({ regex: UUID_REGEX }), {
      minLength: 1,
      maxLength: 500,
    }),
    periodStart: new V.StringNotNull({ regex: ISO_DATE_REGEX }),
    periodEnd: new V.StringNotNull({ regex: ISO_DATE_REGEX }),
    /** Monto aplicado a CADA unidad (puede diferir del base de la cuota). */
    appliedAmount: new V.NumberNotNull({ min: 0, max: MONEY_MAX, maxDecimalPlaces: 2 }),
    dueDate: new V.StringNotNull({ regex: ISO_DATE_REGEX }),
  },
  { strictMode: true },
);

// --- Entrada: generar (POST /communities/:communityId/charges/generate) --------
// Genera los cargos de UNA cuota sobre TODAS sus unidades activas, en el rango
// dado (default: su vigencia). El largo/paso de cada cargo lo define la
// periodicidad de la cuota; one_time genera uno solo. Idempotente (sin duplicados).
export const generateChargesV1V = new V.ObjectNotNull(
  {
    feeId: new V.StringNotNull({ regex: UUID_REGEX }),
    /** Inicio del rango (default: inicio de vigencia de la cuota). */
    from: new V.String({ regex: ISO_DATE_REGEX }),
    /** Fin del rango (default: fin de vigencia). Requerido si la cuota no lo tiene. */
    to: new V.String({ regex: ISO_DATE_REGEX }),
    /** Día de vencimiento dentro de cada periodo (1..31, acotado al fin). */
    dueDay: new V.Number({ min: 1, max: 31, maxDecimalPlaces: 0 }),
    /** Monto por unidad (default: monto base de la cuota). */
    amount: new V.Number({ min: 0, max: MONEY_MAX, maxDecimalPlaces: 2 }),
  },
  { strictMode: true },
);

// --- Entrada: listar (GET /communities/:communityId/charges y
// GET /units/:unitId/charges) ---------------------------------------------------
export const listChargesQueryV1V = new V.ObjectNotNull(
  {
    ...pageQueryFields(),
    /** Solo en la variante por comunidad: acotar a una unidad concreta. */
    unitId: new V.String({ regex: UUID_REGEX }),
    paymentStatus: new V.String({ in: [...PAYMENT_STATUSES] }),
    /** Solo cargos vencidos y no cubiertos (due_date < hoy). */
    overdueOnly: new V.Boolean(),
    from: new V.String({ regex: ISO_DATE_REGEX }),
    to: new V.String({ regex: ISO_DATE_REGEX }),
  },
  { strictMode: true },
);

// --- Salida: un cargo -------------------------------------------------------------
export const chargeV1V = new V.ObjectNotNull({
  id: new V.StringNotNull(),
  unitId: new V.StringNotNull(),
  /** Código de la unidad (community.units.code), para mostrar sin re-consultar. */
  unitCode: new V.StringNotNull(),
  communityId: new V.StringNotNull(),
  feeId: new V.StringNotNull(),
  concept: new V.StringNotNull(),
  periodStart: new V.StringNotNull(),
  periodEnd: new V.StringNotNull(),
  appliedAmount: new V.NumberNotNull(),
  /** Saldo pendiente = applied - (pagos + condonaciones activas). */
  balance: new V.NumberNotNull(),
  dueDate: new V.StringNotNull(),
  paymentStatus: new V.StringNotNull(),
  /** DERIVADO en lectura: vencido y no cubierto. Nunca se almacena. */
  overdue: new V.BooleanNotNull(),
  status: new V.StringNotNull(),
  createdAt: new V.StringNotNull(),
  updatedAt: new V.StringNotNull(),
});

// --- Salida: listado paginado --------------------------------------------------------
export const chargeListV1V = new V.ObjectNotNull({
  items: new V.ArrayNotNull(chargeV1V),
  total: new V.NumberNotNull(),
  page: new V.NumberNotNull(),
  pageSize: new V.NumberNotNull(),
});

// --- Salida: alta múltiple (201) — un cargo creado por unidad ------------------------
export const createdChargesV1V = new V.ObjectNotNull({
  items: new V.ArrayNotNull(chargeV1V),
  total: new V.NumberNotNull(),
});

// --- Salida: generación (201) — cuántos cargos se crearon --------------------------
export const generatedChargesV1V = new V.ObjectNotNull({
  created: new V.NumberNotNull(),
});

export { errorResponseV1V };
