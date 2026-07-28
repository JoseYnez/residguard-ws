import { Verifiers as V } from "structure-verifier";
import {
  errorResponseV1V,
  ISO_DATE_REGEX,
  ISO_DATETIME_REGEX,
  MONEY_MAX,
  pageQueryFields,
  UUID_REGEX,
} from "../../common/common_v1.verifier";

// Contratos del recurso payments (billing.payments). Un pago es UN depósito
// que se reparte entre 1..N cargos (posiblemente de distintas unidades) vía
// billing.payment_allocations; el monto debe igualar la SUMA de aplicaciones
// (lo garantizan el controller y billing.sp_register_payment).

export const PAYMENT_METHODS = ["cash", "transfer", "card", "check", "other"] as const;

// --- Entrada: registrar (POST /payments) --------------------------------------
export const createPaymentV1V = new V.ObjectNotNull(
  {
    amount: new V.NumberNotNull({ min: 0.01, max: MONEY_MAX, maxDecimalPlaces: 2 }),
    method: new V.StringNotNull({ in: [...PAYMENT_METHODS] }),
    // Instante del pago (billing.payments.paid_at es TIMESTAMPTZ). Exige offset
    // explícito: el cliente resuelve la fecha-hora en SU zona y la manda ya
    // anclada, así el servidor no tiene que suponer nada. Ausente = now().
    paidAt: new V.String({ regex: ISO_DATETIME_REGEX }),
    reference: new V.String({ maxLength: 200 }),
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

// --- Entrada: listar (GET /payments) --------------------------------------------
// communityId es OBLIGATORIO: el depósito no cuelga de una comunidad; se lista
// por los cargos que cubrió, y el alcance del actor se valida sobre esa comunidad.
export const listPaymentsQueryV1V = new V.ObjectNotNull(
  {
    ...pageQueryFields(),
    communityId: new V.StringNotNull({ regex: UUID_REGEX }),
    method: new V.String({ in: [...PAYMENT_METHODS] }),
    from: new V.String({ regex: ISO_DATE_REGEX }),
    to: new V.String({ regex: ISO_DATE_REGEX }),
  },
  { strictMode: true },
);

// --- Salida: una aplicación --------------------------------------------------------
export const paymentAllocationV1V = new V.ObjectNotNull({
  id: new V.StringNotNull(),
  chargeId: new V.StringNotNull(),
  unitId: new V.StringNotNull(),
  unitCode: new V.StringNotNull(),
  communityId: new V.StringNotNull(),
  concept: new V.StringNotNull(),
  amount: new V.NumberNotNull(),
  /** Periodo del cargo cubierto (mismos campos que `periods` del listado): el
   *  detalle dice a QUÉ periodo se aplicó cada parte del depósito. `label`
   *  null = sin alias propio; el cliente deriva uno del rango. */
  periodLabel: new V.String(),
  periodStart: new V.StringNotNull(),
  periodEnd: new V.StringNotNull(),
});

// --- Salida: un pago (encabezado) ----------------------------------------------------
export const paymentV1V = new V.ObjectNotNull({
  id: new V.StringNotNull(),
  amount: new V.NumberNotNull(),
  method: new V.StringNotNull(),
  paidAt: new V.StringNotNull(),
  reference: new V.String(),
  status: new V.StringNotNull(),
  createdAt: new V.StringNotNull(),
  updatedAt: new V.StringNotNull(),
});

// --- Salida: un pago con sus aplicaciones ---------------------------------------------
export const paymentDetailV1V = new V.ObjectNotNull({
  id: new V.StringNotNull(),
  amount: new V.NumberNotNull(),
  method: new V.StringNotNull(),
  paidAt: new V.StringNotNull(),
  reference: new V.String(),
  status: new V.StringNotNull(),
  createdAt: new V.StringNotNull(),
  updatedAt: new V.StringNotNull(),
  allocations: new V.ArrayNotNull(paymentAllocationV1V),
});

// --- Salida: listado paginado (con el monto aplicado a la comunidad filtrada) ---------
export const paymentListItemV1V = new V.ObjectNotNull({
  id: new V.StringNotNull(),
  amount: new V.NumberNotNull(),
  method: new V.StringNotNull(),
  paidAt: new V.StringNotNull(),
  reference: new V.String(),
  status: new V.StringNotNull(),
  createdAt: new V.StringNotNull(),
  updatedAt: new V.StringNotNull(),
  /** Parte del depósito aplicada a cargos de la comunidad del filtro. */
  allocatedToCommunity: new V.NumberNotNull(),
  /** Unidades (de esa comunidad) cuyas aplicaciones cubre el pago. */
  units: new V.ArrayNotNull(
    new V.ObjectNotNull({
      id: new V.StringNotNull(),
      code: new V.StringNotNull(),
    }),
  ),
  /** Periodos (distintos, cronológicos) de los cargos cubiertos. `label` null
   *  = sin alias propio; el cliente deriva uno del rango. */
  periods: new V.ArrayNotNull(
    new V.ObjectNotNull({
      id: new V.StringNotNull(),
      label: new V.String(),
      periodStart: new V.StringNotNull(),
      periodEnd: new V.StringNotNull(),
    }),
  ),
});

export const paymentListV1V = new V.ObjectNotNull({
  items: new V.ArrayNotNull(paymentListItemV1V),
  total: new V.NumberNotNull(),
  page: new V.NumberNotNull(),
  pageSize: new V.NumberNotNull(),
});

export { errorResponseV1V };
