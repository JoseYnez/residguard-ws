import { Verifiers as V } from "structure-verifier";

// Piezas de contrato compartidas por todos los recursos v1: parámetros de
// ruta UUID, paginación y error tipado. Cada recurso define sus propios
// cuerpos/salidas en su *_v1.verifier.ts.

export const UUID_REGEX =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** Fecha de negocio (columnas DATE): YYYY-MM-DD estricto. */
export const ISO_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

/** Instante (columnas TIMESTAMPTZ): fecha con hora opcional. */
export const ISO_DATETIME_REGEX = /^\d{4}-\d{2}-\d{2}([T ].*)?$/;

/** Dinero NUMERIC(14,2): positivo, máximo 2 decimales. */
export const MONEY_MAX = 999999999999.99;

// --- Parámetros de ruta ------------------------------------------------------

export const communityIdParamV1V = new V.ObjectNotNull(
  { communityId: new V.StringNotNull({ regex: UUID_REGEX }) },
  { strictMode: true },
);

export const communityScopedIdParamV1V = new V.ObjectNotNull(
  {
    communityId: new V.StringNotNull({ regex: UUID_REGEX }),
    id: new V.StringNotNull({ regex: UUID_REGEX }),
  },
  { strictMode: true },
);

export const unitIdParamV1V = new V.ObjectNotNull(
  { unitId: new V.StringNotNull({ regex: UUID_REGEX }) },
  { strictMode: true },
);

export const unitScopedIdParamV1V = new V.ObjectNotNull(
  {
    unitId: new V.StringNotNull({ regex: UUID_REGEX }),
    id: new V.StringNotNull({ regex: UUID_REGEX }),
  },
  { strictMode: true },
);

export const idParamV1V = new V.ObjectNotNull(
  { id: new V.StringNotNull({ regex: UUID_REGEX }) },
  { strictMode: true },
);

// --- Paginación --------------------------------------------------------------

/** Campos estándar de querystring paginada (tope de servidor: 100). */
export function pageQueryFields() {
  return {
    page: new V.NumberNotNull({ defaultValue: 1, min: 1, maxDecimalPlaces: 0 }),
    pageSize: new V.NumberNotNull({ defaultValue: 20, min: 1, max: 100, maxDecimalPlaces: 0 }),
  };
}

// --- Error tipado (400/404/409) ----------------------------------------------

export const errorResponseV1V = new V.ObjectNotNull({
  error: new V.StringNotNull(),
  message: new V.String(),
});
