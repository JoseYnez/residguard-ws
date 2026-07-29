import { Verifiers as V } from "structure-verifier";
import { errorResponseV1V, pageQueryFields } from "../../common/common_v1.verifier";

// Contratos del recurso members (community.members): el padrón de personas de
// una comunidad. A diferencia de unit-members, aquí `userId` NO forma parte de
// ninguna entrada — se registra a la persona, no al usuario. Sale en la
// respuesta (siempre null hoy) para no romper el contrato el día que se pueda
// vincular.

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const MEMBER_TYPES = ["owner", "tenant", "resident"] as const;

// --- Entrada: crear (POST /communities/:communityId/members) -----------------
export const createMemberV1V = new V.ObjectNotNull(
  {
    memberType: new V.StringNotNull({ in: [...MEMBER_TYPES] }),
    fullName: new V.StringNotNull({ minLength: 1, maxLength: 200 }),
    phone: new V.String({ maxLength: 50 }),
    email: new V.String({ maxLength: 320, regex: EMAIL_REGEX }),
    notes: new V.String({ maxLength: 2000 }),
  },
  { strictMode: true },
);

// --- Entrada: actualizar (PATCH /communities/:communityId/members/:id) -------
export const updateMemberV1V = new V.ObjectNotNull(
  {
    memberType: new V.String({ in: [...MEMBER_TYPES] }),
    fullName: new V.String({ minLength: 1, maxLength: 200 }),
    phone: new V.String({ maxLength: 50 }),
    email: new V.String({ maxLength: 320, regex: EMAIL_REGEX }),
    notes: new V.String({ maxLength: 2000 }),
    status: new V.String({ in: ["active", "inactive"] }),
  },
  { strictMode: true },
);

// --- Entrada: listar (GET /communities/:communityId/members) -----------------
export const listMembersQueryV1V = new V.ObjectNotNull(
  {
    ...pageQueryFields(),
    search: new V.String({ maxLength: 200 }),
    memberType: new V.String({ in: [...MEMBER_TYPES] }),
  },
  { strictMode: true },
);

// --- Salida: una persona del padrón -----------------------------------------
export const memberV1V = new V.ObjectNotNull({
  id: new V.StringNotNull(),
  communityId: new V.StringNotNull(),
  /** Usuario vinculado. Hoy SIEMPRE null (ver el repositorio). */
  userId: new V.String(),
  memberType: new V.StringNotNull(),
  fullName: new V.StringNotNull(),
  phone: new V.String(),
  email: new V.String(),
  notes: new V.String(),
  status: new V.StringNotNull(),
  createdAt: new V.StringNotNull(),
  updatedAt: new V.StringNotNull(),
});

// --- Salida: listado paginado -----------------------------------------------
export const memberListV1V = new V.ObjectNotNull({
  items: new V.ArrayNotNull(memberV1V),
  total: new V.NumberNotNull(),
  page: new V.NumberNotNull(),
  pageSize: new V.NumberNotNull(),
});

export { errorResponseV1V };
