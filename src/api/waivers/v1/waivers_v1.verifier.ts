import { Verifiers as V } from "structure-verifier";
import {
  errorResponseV1V,
  ISO_DATE_REGEX,
  MONEY_MAX,
  pageQueryFields,
  UUID_REGEX,
} from "../../common/common_v1.verifier";

// Contratos del recurso waivers (billing.waivers): CONDONACIONES sobre un
// cargo. Condonar NO es anular: el cargo existió y su rastro se conserva —
// la condonación es una fila aparte que cubre (total o parcialmente) su saldo
// y deja el cargo en `waived`/`partial`. Anular (charges.revoke) borra
// lógicamente un cargo que no debió existir y el servicio lo rechaza en cuanto
// hay dinero o condonaciones de por medio.

// --- Parámetros de ruta -------------------------------------------------------

/** /communities/:communityId/charges/:chargeId/waivers */
export const communityChargeParamV1V = new V.ObjectNotNull(
  {
    communityId: new V.StringNotNull({ regex: UUID_REGEX }),
    chargeId: new V.StringNotNull({ regex: UUID_REGEX }),
  },
  { strictMode: true },
);

// --- Entrada: condonar (POST .../charges/:chargeId/waivers) -------------------
export const createWaiverV1V = new V.ObjectNotNull(
  {
    /** Monto a condonar. Omitido = TODO el saldo pendiente del cargo. El tope
     *  (saldo) lo aplica el controller con el cargo bloqueado: la BD solo
     *  exige > 0, así que sin ese tope cabría cubrir un cargo de más. */
    amount: new V.Number({ min: 0.01, max: MONEY_MAX, maxDecimalPlaces: 2 }),
    /** Motivo. Obligatorio: perdonar deuda ajena sin justificación escrita no
     *  es auditable, y billing.waivers.reason es NOT NULL. */
    reason: new V.StringNotNull({ minLength: 3, maxLength: 500 }),
  },
  { strictMode: true },
);

// --- Entrada: listar (GET /communities/:communityId/waivers) ------------------
export const listWaiversQueryV1V = new V.ObjectNotNull(
  {
    ...pageQueryFields(),
    /** Acotar al historial de UN cargo (lo que consume la ficha del cargo). */
    chargeId: new V.String({ regex: UUID_REGEX }),
    /** Acotar a una unidad de la comunidad. */
    unitId: new V.String({ regex: UUID_REGEX }),
    /** Rango por fecha de registro de la condonación (created_at). */
    from: new V.String({ regex: ISO_DATE_REGEX }),
    to: new V.String({ regex: ISO_DATE_REGEX }),
  },
  { strictMode: true },
);

// --- Salida: una condonación --------------------------------------------------
export const waiverV1V = new V.ObjectNotNull({
  id: new V.StringNotNull(),
  chargeId: new V.StringNotNull(),
  communityId: new V.StringNotNull(),
  unitId: new V.StringNotNull(),
  /** Código de la unidad del cargo, para mostrar sin re-consultar. */
  unitCode: new V.StringNotNull(),
  /** Concepto de la cuota del cargo condonado. */
  concept: new V.StringNotNull(),
  /** Periodo del cargo; los TRES van null si el cargo es SUELTO (una venta de
   *  tarjetas no devenga periodo). `periodLabel` null también cuando el periodo
   *  no tiene alias propio y el cliente lo deriva del rango. */
  periodLabel: new V.String(),
  periodStart: new V.String(),
  periodEnd: new V.String(),
  amount: new V.NumberNotNull(),
  reason: new V.StringNotNull(),
  /** Usuario que autorizó (core.users). Null si la fila viene de un proceso
   *  sin usuario de sesión. */
  authorizedBy: new V.String(),
  authorizedByName: new V.String(),
  /** Estado del CARGO tras la condonación: el cliente refresca la fila del
   *  estado de cuenta sin volver a pedir el listado. */
  chargeAppliedAmount: new V.NumberNotNull(),
  chargeBalance: new V.NumberNotNull(),
  chargePaymentStatus: new V.StringNotNull(),
  status: new V.StringNotNull(),
  createdAt: new V.StringNotNull(),
  updatedAt: new V.StringNotNull(),
});

// --- Salida: listado paginado -------------------------------------------------
export const waiverListV1V = new V.ObjectNotNull({
  items: new V.ArrayNotNull(waiverV1V),
  total: new V.NumberNotNull(),
  page: new V.NumberNotNull(),
  pageSize: new V.NumberNotNull(),
});

export { errorResponseV1V };
