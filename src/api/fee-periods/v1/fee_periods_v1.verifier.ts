import { Verifiers as V } from "structure-verifier";
import {
  errorResponseV1V,
  ISO_DATE_REGEX,
  MONEY_MAX,
  pageQueryFields,
  UUID_REGEX,
} from "../../common/common_v1.verifier";

// Contratos del recurso fee-periods (billing.fee_periods): los periodos de una
// cuota ("Mantenimiento 2026 → Enero"). La generación de cargos los crea sola
// (sp_ensure_fee_period); estos endpoints los listan y permiten crearlos por
// adelantado o darlos de baja mientras no tengan cargos vivos.

// --- Parámetros de ruta (anidados bajo la cuota) ------------------------------
export const feeScopedParamV1V = new V.ObjectNotNull(
  {
    communityId: new V.StringNotNull({ regex: UUID_REGEX }),
    feeId: new V.StringNotNull({ regex: UUID_REGEX }),
  },
  { strictMode: true },
);

export const feeScopedIdParamV1V = new V.ObjectNotNull(
  {
    communityId: new V.StringNotNull({ regex: UUID_REGEX }),
    feeId: new V.StringNotNull({ regex: UUID_REGEX }),
    id: new V.StringNotNull({ regex: UUID_REGEX }),
  },
  { strictMode: true },
);

// --- Entrada: crear (POST /communities/:communityId/fees/:feeId/periods) ------
export const createFeePeriodV1V = new V.ObjectNotNull(
  {
    periodStart: new V.StringNotNull({ regex: ISO_DATE_REGEX }),
    periodEnd: new V.StringNotNull({ regex: ISO_DATE_REGEX }),
    /** Vencimiento nominal; ausente/null = period_end. */
    dueDate: new V.String({ regex: ISO_DATE_REGEX }),
    /** Monto nominal del periodo; ausente/null = fees.base_amount. */
    amount: new V.Number({ min: 0, max: MONEY_MAX, maxDecimalPlaces: 2 }),
    /** Nombre visible ("Cuota extraordinaria bardas"); ausente/null = derivado. */
    label: new V.String({ minLength: 1, maxLength: 200 }),
  },
  { strictMode: true },
);

// --- Entrada: listar (GET /communities/:communityId/fees/:feeId/periods) ------
export const listFeePeriodsQueryV1V = new V.ObjectNotNull(
  {
    ...pageQueryFields(),
  },
  { strictMode: true },
);

// --- Salida: un periodo --------------------------------------------------------
export const feePeriodV1V = new V.ObjectNotNull({
  id: new V.StringNotNull(),
  feeId: new V.StringNotNull(),
  communityId: new V.StringNotNull(),
  periodStart: new V.StringNotNull(),
  periodEnd: new V.StringNotNull(),
  dueDate: new V.StringNotNull(),
  amount: new V.Number(),
  label: new V.String(),
  /** Cargos VIVOS colgados del periodo (contexto para la UI y para la baja). */
  chargesCount: new V.NumberNotNull(),
  status: new V.StringNotNull(),
  createdAt: new V.StringNotNull(),
  updatedAt: new V.StringNotNull(),
});

// --- Salida: listado paginado ---------------------------------------------------
export const feePeriodListV1V = new V.ObjectNotNull({
  items: new V.ArrayNotNull(feePeriodV1V),
  total: new V.NumberNotNull(),
  page: new V.NumberNotNull(),
  pageSize: new V.NumberNotNull(),
});

export { errorResponseV1V };
