import { Verifiers as V } from "structure-verifier";
import {
  errorResponseV1V,
  pageQueryFields,
  UUID_REGEX,
} from "../../common/common_v1.verifier";

// Contratos del recurso unit-members (community.unit_members): la relación
// persona <-> unidad. userId NULL = "relación simulada" (la persona aún no
// está registrada en la plataforma); al registrarse se le asigna userId.

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const MEMBER_TYPES = ["owner", "tenant", "resident"] as const;

// --- Entrada: crear (POST /units/:unitId/members) ----------------------------
export const createUnitMemberV1V = new V.ObjectNotNull(
  {
    memberType: new V.StringNotNull({ in: [...MEMBER_TYPES] }),
    fullName: new V.StringNotNull({ minLength: 1, maxLength: 200 }),
    phone: new V.String({ maxLength: 50 }),
    email: new V.String({ maxLength: 320, regex: EMAIL_REGEX }),
    userId: new V.String({ regex: UUID_REGEX }),
  },
  { strictMode: true },
);

// --- Entrada: actualizar (PATCH /units/:unitId/members/:id) ------------------
export const updateUnitMemberV1V = new V.ObjectNotNull(
  {
    memberType: new V.String({ in: [...MEMBER_TYPES] }),
    fullName: new V.String({ minLength: 1, maxLength: 200 }),
    phone: new V.String({ maxLength: 50 }),
    email: new V.String({ maxLength: 320, regex: EMAIL_REGEX }),
    userId: new V.String({ regex: UUID_REGEX }),
    status: new V.String({ in: ["active", "inactive"] }),
  },
  { strictMode: true },
);

// --- Entrada: listar (GET /units/:unitId/members) -----------------------------
export const listUnitMembersQueryV1V = new V.ObjectNotNull(
  {
    ...pageQueryFields(),
    search: new V.String({ maxLength: 200 }),
    memberType: new V.String({ in: [...MEMBER_TYPES] }),
  },
  { strictMode: true },
);

// --- Salida: un miembro ----------------------------------------------------------
export const unitMemberV1V = new V.ObjectNotNull({
  id: new V.StringNotNull(),
  unitId: new V.StringNotNull(),
  userId: new V.String(),
  memberType: new V.StringNotNull(),
  fullName: new V.StringNotNull(),
  phone: new V.String(),
  email: new V.String(),
  status: new V.StringNotNull(),
  createdAt: new V.StringNotNull(),
  updatedAt: new V.StringNotNull(),
});

// --- Salida: listado paginado -----------------------------------------------------
export const unitMemberListV1V = new V.ObjectNotNull({
  items: new V.ArrayNotNull(unitMemberV1V),
  total: new V.NumberNotNull(),
  page: new V.NumberNotNull(),
  pageSize: new V.NumberNotNull(),
});

export { errorResponseV1V };
