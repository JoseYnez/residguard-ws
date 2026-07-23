import { Verifiers as V } from "structure-verifier";
import { errorResponseV1V, pageQueryFields } from "../../common/common_v1.verifier";

// Contratos del recurso units (community.units). unit_type es el ENUM de BD.

export const UNIT_TYPES = [
  "apartment",
  "house",
  "lot",
  "commercial_local",
  "parking",
  "storage",
] as const;

// --- Entrada: crear (POST /communities/:communityId/units) ------------------
export const createUnitV1V = new V.ObjectNotNull(
  {
    code: new V.StringNotNull({ minLength: 1, maxLength: 50 }),
    tower: new V.String({ maxLength: 50 }),
    number: new V.String({ maxLength: 20 }),
    letter: new V.String({ maxLength: 10 }),
    unitType: new V.StringNotNull({ in: [...UNIT_TYPES] }),
    address: new V.String({ maxLength: 500 }),
  },
  { strictMode: true },
);

// --- Entrada: actualizar (PATCH /communities/:communityId/units/:id) --------
export const updateUnitV1V = new V.ObjectNotNull(
  {
    code: new V.String({ minLength: 1, maxLength: 50 }),
    tower: new V.String({ maxLength: 50 }),
    number: new V.String({ maxLength: 20 }),
    letter: new V.String({ maxLength: 10 }),
    unitType: new V.String({ in: [...UNIT_TYPES] }),
    address: new V.String({ maxLength: 500 }),
    status: new V.String({ in: ["active", "inactive"] }),
  },
  { strictMode: true },
);

// --- Entrada: listar (GET /communities/:communityId/units) ------------------
export const listUnitsQueryV1V = new V.ObjectNotNull(
  {
    ...pageQueryFields(),
    search: new V.String({ maxLength: 100 }),
    unitType: new V.String({ in: [...UNIT_TYPES] }),
    status: new V.String({ in: ["active", "inactive"] }),
  },
  { strictMode: true },
);

// --- Salida: una unidad --------------------------------------------------------
export const unitV1V = new V.ObjectNotNull({
  id: new V.StringNotNull(),
  communityId: new V.StringNotNull(),
  code: new V.StringNotNull(),
  tower: new V.String(),
  number: new V.String(),
  letter: new V.String(),
  unitType: new V.StringNotNull(),
  address: new V.String(),
  status: new V.StringNotNull(),
  createdAt: new V.StringNotNull(),
  updatedAt: new V.StringNotNull(),
});

// --- Salida: listado paginado ---------------------------------------------------
export const unitListV1V = new V.ObjectNotNull({
  items: new V.ArrayNotNull(unitV1V),
  total: new V.NumberNotNull(),
  page: new V.NumberNotNull(),
  pageSize: new V.NumberNotNull(),
});

export { errorResponseV1V };
