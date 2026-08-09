import { Verifiers as V } from "structure-verifier";
import { errorResponseV1V, pageQueryFields } from "../../common/common_v1.verifier";

// Contratos del recurso members (community.members): el padrón de personas de
// una comunidad, con sus teléfonos (community.member_phones) como subrecurso.
//
// Dos campos que sí tiene unit-members y aquí NO existen, a propósito:
//   * `userId` — se registra a la persona, no al usuario. Sale en la respuesta
//     (siempre null hoy) para no romper el contrato el día que se pueda
//     vincular, pero no entra por ninguna vía.
//   * `memberType` — el rol califica a la RELACIÓN persona↔unidad (alguien es
//     propietario de una unidad y arrendatario de otra), así que se pide y se
//     devuelve en unit-members/v1, nunca aquí.
//
// El `phone` de la salida es DERIVADO (el teléfono vigente más antiguo); solo
// entra en el POST de alta, como comodidad para capturar el primer número. A
// partir de ahí los teléfonos se gestionan por /phones y el PATCH no lo acepta.

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// --- Entrada: crear (POST /communities/:communityId/members) -----------------
export const createMemberV1V = new V.ObjectNotNull(
  {
    fullName: new V.StringNotNull({ minLength: 1, maxLength: 200 }),
    /** Primer teléfono de la persona (opcional); crea su fila en /phones. */
    phone: new V.String({ maxLength: 50 }),
    email: new V.String({ maxLength: 320, regex: EMAIL_REGEX }),
    notes: new V.String({ maxLength: 2000 }),
  },
  { strictMode: true },
);

// --- Entrada: actualizar (PATCH /communities/:communityId/members/:id) -------
export const updateMemberV1V = new V.ObjectNotNull(
  {
    fullName: new V.String({ minLength: 1, maxLength: 200 }),
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
  },
  { strictMode: true },
);

// --- Entrada: agregar teléfono (POST .../members/:memberId/phones) -----------
export const createMemberPhoneV1V = new V.ObjectNotNull(
  {
    phone: new V.StringNotNull({ minLength: 1, maxLength: 50 }),
    label: new V.String({ maxLength: 50 }),
  },
  { strictMode: true },
);

// --- Salida: un teléfono de la persona ---------------------------------------
export const memberPhoneV1V = new V.ObjectNotNull({
  id: new V.StringNotNull(),
  phone: new V.StringNotNull(),
  label: new V.String(),
  createdAt: new V.StringNotNull(),
});

// --- Salida: vínculo persona↔usuario (GET .../members/:memberId/user) --------
// El userId sale de la fila local; email e invitationPending los informa la
// plataforma (admin_ws) en el momento — null cuando no hay vínculo o cuando la
// plataforma no pudo responder por ese usuario.
export const memberUserLinkV1V = new V.ObjectNotNull({
  userId: new V.String(),
  email: new V.String(),
  invitationPending: new V.Boolean(),
});

// Campos comunes de la persona; el listado deriva phone/unitCodes y el
// detalle agrega la lista completa de teléfonos.
const memberFields = {
  id: new V.StringNotNull(),
  communityId: new V.StringNotNull(),
  /** Usuario vinculado. Hoy SIEMPRE null (ver el encabezado). */
  userId: new V.String(),
  fullName: new V.StringNotNull(),
  /** Teléfono principal derivado (el vigente más antiguo). */
  phone: new V.String(),
  email: new V.String(),
  notes: new V.String(),
  /** Códigos de las unidades vigentes de la persona, ordenados. */
  unitCodes: new V.ArrayNotNull(new V.StringNotNull()),
  status: new V.StringNotNull(),
  createdAt: new V.StringNotNull(),
  updatedAt: new V.StringNotNull(),
};

// --- Salida: una persona del padrón (item de listado) ------------------------
export const memberV1V = new V.ObjectNotNull({ ...memberFields });

// --- Salida: detalle con teléfonos (GET one, POST, PATCH) --------------------
export const memberDetailV1V = new V.ObjectNotNull({
  ...memberFields,
  phones: new V.ArrayNotNull(memberPhoneV1V),
});

// --- Salida: listado paginado -----------------------------------------------
export const memberListV1V = new V.ObjectNotNull({
  items: new V.ArrayNotNull(memberV1V),
  total: new V.NumberNotNull(),
  page: new V.NumberNotNull(),
  pageSize: new V.NumberNotNull(),
});

export { errorResponseV1V };
