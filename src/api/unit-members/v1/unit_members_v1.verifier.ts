import { Verifiers as V } from "structure-verifier";
import {
  errorResponseV1V,
  pageQueryFields,
  UUID_REGEX,
} from "../../common/common_v1.verifier";

// Contratos del recurso unit-members (community.unit_members): la relación
// PURA persona↔unidad. Los datos de la persona (nombre, contacto) salen del
// padrón por member_id — aquí ya no viajan como entrada. Dos vistas:
//   * por unidad  (GET /units/:unitId/members)               — solo lectura
//   * por miembro (/communities/:cId/members/:memberId/units) — CRUD

export const MEMBER_TYPES = ["owner", "tenant", "resident"] as const;

// --- Entrada: asignar unidad (POST .../members/:memberId/units) --------------
export const assignMemberUnitV1V = new V.ObjectNotNull(
  {
    unitId: new V.StringNotNull({ regex: UUID_REGEX }),
    memberType: new V.StringNotNull({ in: [...MEMBER_TYPES] }),
  },
  { strictMode: true },
);

// --- Entrada: cambiar rol (PATCH .../members/:memberId/units/:id) ------------
export const updateMemberUnitV1V = new V.ObjectNotNull(
  {
    memberType: new V.StringNotNull({ in: [...MEMBER_TYPES] }),
  },
  { strictMode: true },
);

// --- Entrada: listar por unidad (GET /units/:unitId/members) ------------------
export const listUnitMembersQueryV1V = new V.ObjectNotNull(
  {
    ...pageQueryFields(),
    search: new V.String({ maxLength: 200 }),
    memberType: new V.String({ in: [...MEMBER_TYPES] }),
  },
  { strictMode: true },
);

// --- Entrada: listar por miembro (GET .../members/:memberId/units) -----------
export const listMemberUnitsQueryV1V = new V.ObjectNotNull(
  {
    ...pageQueryFields(),
  },
  { strictMode: true },
);

// --- Entrada: directorio (GET /communities/:communityId/directory) -----------
export const listDirectoryQueryV1V = new V.ObjectNotNull(
  {
    ...pageQueryFields(),
    search: new V.String({ maxLength: 200 }),
  },
  { strictMode: true },
);

// --- Salida: la relación vista desde la unidad --------------------------------
export const unitMemberV1V = new V.ObjectNotNull({
  id: new V.StringNotNull(),
  unitId: new V.StringNotNull(),
  memberId: new V.StringNotNull(),
  memberType: new V.StringNotNull(),
  fullName: new V.StringNotNull(),
  /** Teléfono principal derivado del padrón. */
  phone: new V.String(),
  email: new V.String(),
  status: new V.StringNotNull(),
  createdAt: new V.StringNotNull(),
  updatedAt: new V.StringNotNull(),
});

// --- Salida: la relación vista desde el miembro --------------------------------
export const memberUnitV1V = new V.ObjectNotNull({
  id: new V.StringNotNull(),
  unitId: new V.StringNotNull(),
  memberId: new V.StringNotNull(),
  memberType: new V.StringNotNull(),
  unitCode: new V.StringNotNull(),
  unitTower: new V.String(),
  unitType: new V.StringNotNull(),
  status: new V.StringNotNull(),
  createdAt: new V.StringNotNull(),
  updatedAt: new V.StringNotNull(),
});

// --- Salida: una fila del directorio -------------------------------------------
export const directoryEntryV1V = new V.ObjectNotNull({
  id: new V.StringNotNull(),
  unitId: new V.StringNotNull(),
  unitCode: new V.StringNotNull(),
  unitTower: new V.String(),
  unitAddress: new V.String(),
  unitType: new V.StringNotNull(),
  memberId: new V.StringNotNull(),
  fullName: new V.StringNotNull(),
  memberType: new V.StringNotNull(),
  email: new V.String(),
  /** TODOS los teléfonos activos de la persona, el principal primero. */
  phones: new V.ArrayNotNull(
    new V.ObjectNotNull({
      phone: new V.StringNotNull(),
      label: new V.String(),
    }),
  ),
});

// --- Salida: listados paginados -----------------------------------------------
export const unitMemberListV1V = new V.ObjectNotNull({
  items: new V.ArrayNotNull(unitMemberV1V),
  total: new V.NumberNotNull(),
  page: new V.NumberNotNull(),
  pageSize: new V.NumberNotNull(),
});

export const memberUnitListV1V = new V.ObjectNotNull({
  items: new V.ArrayNotNull(memberUnitV1V),
  total: new V.NumberNotNull(),
  page: new V.NumberNotNull(),
  pageSize: new V.NumberNotNull(),
});

export const directoryListV1V = new V.ObjectNotNull({
  items: new V.ArrayNotNull(directoryEntryV1V),
  total: new V.NumberNotNull(),
  page: new V.NumberNotNull(),
  pageSize: new V.NumberNotNull(),
});

export { errorResponseV1V };
