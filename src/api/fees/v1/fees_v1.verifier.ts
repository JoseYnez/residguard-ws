import { Verifiers as V } from "structure-verifier";
import {
  errorResponseV1V,
  ISO_DATE_REGEX,
  MONEY_MAX,
  pageQueryFields,
} from "../../common/common_v1.verifier";

// Contratos del recurso fees (billing.fees): catálogo de cuotas por comunidad
// (concepto, monto base, periodicidad y vigencia). La lectura alimenta el
// selector del registro de cargos (POST /units/:unitId/charges); el CRUD
// permite administrarlo. Baja lógica.

export const PERIODICITIES = [
  "monthly",
  "bimonthly",
  "quarterly",
  "semiannual",
  "annual",
  "one_time",
] as const;

// --- Entrada: crear (POST /communities/:communityId/fees) ---------------------
export const createFeeV1V = new V.ObjectNotNull(
  {
    concept: new V.StringNotNull({ minLength: 1, maxLength: 500 }),
    baseAmount: new V.NumberNotNull({ min: 0, max: MONEY_MAX, maxDecimalPlaces: 2 }),
    periodicity: new V.StringNotNull({ in: [...PERIODICITIES] }),
    effectiveFrom: new V.StringNotNull({ regex: ISO_DATE_REGEX }),
    /** Fin de vigencia; ausente/null = sin fin. */
    effectiveTo: new V.String({ regex: ISO_DATE_REGEX }),
  },
  { strictMode: true },
);

// --- Entrada: actualizar (PATCH /communities/:communityId/fees/:id) -----------
export const updateFeeV1V = new V.ObjectNotNull(
  {
    concept: new V.String({ minLength: 1, maxLength: 500 }),
    baseAmount: new V.Number({ min: 0, max: MONEY_MAX, maxDecimalPlaces: 2 }),
    periodicity: new V.String({ in: [...PERIODICITIES] }),
    effectiveFrom: new V.String({ regex: ISO_DATE_REGEX }),
    /** null = limpiar (la cuota queda sin fin de vigencia). */
    effectiveTo: new V.String({ regex: ISO_DATE_REGEX }),
    status: new V.String({ in: ["active", "inactive"] }),
  },
  { strictMode: true },
);

// --- Entrada: listar (GET /communities/:communityId/fees) ---------------------
export const listFeesQueryV1V = new V.ObjectNotNull(
  {
    ...pageQueryFields(),
    search: new V.String({ maxLength: 200 }),
    status: new V.String({ in: ["active", "inactive"] }),
    /** Solo cuotas vigentes en esta fecha (effective_from/effective_to). */
    activeOn: new V.String({ regex: ISO_DATE_REGEX }),
  },
  { strictMode: true },
);

// --- Salida: una cuota ---------------------------------------------------------
export const feeV1V = new V.ObjectNotNull({
  id: new V.StringNotNull(),
  communityId: new V.StringNotNull(),
  concept: new V.StringNotNull(),
  baseAmount: new V.NumberNotNull(),
  periodicity: new V.StringNotNull(),
  effectiveFrom: new V.StringNotNull(),
  effectiveTo: new V.String(),
  status: new V.StringNotNull(),
  createdAt: new V.StringNotNull(),
  updatedAt: new V.StringNotNull(),
});

// --- Salida: listado paginado ---------------------------------------------------
export const feeListV1V = new V.ObjectNotNull({
  items: new V.ArrayNotNull(feeV1V),
  total: new V.NumberNotNull(),
  page: new V.NumberNotNull(),
  pageSize: new V.NumberNotNull(),
});

export { errorResponseV1V };
