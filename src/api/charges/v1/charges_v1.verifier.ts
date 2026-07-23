import { Verifiers as V } from "structure-verifier";
import {
  errorResponseV1V,
  ISO_DATE_REGEX,
  pageQueryFields,
} from "../../common/common_v1.verifier";

// Contratos del recurso charges (billing.charges): SOLO LECTURA en esta
// versión. Expone los cargos de una unidad con su saldo pendiente para que el
// flujo de pagos sepa qué cubrir. La generación de cargos (asignar cuotas)
// es un flujo aparte, aún no expuesto.

export const PAYMENT_STATUSES = ["pending", "partial", "paid", "waived"] as const;

// --- Entrada: listar (GET /units/:unitId/charges) -----------------------------
export const listChargesQueryV1V = new V.ObjectNotNull(
  {
    ...pageQueryFields(),
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

export { errorResponseV1V };
