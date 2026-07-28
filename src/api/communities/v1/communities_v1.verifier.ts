import { Verifiers as V } from "structure-verifier";
import {
  errorResponseV1V,
  ISO_DATE_REGEX,
  pageQueryFields,
} from "../../common/common_v1.verifier";

// Contratos del recurso communities. El usuario ve y administra únicamente
// aquellas donde tiene membresía activa (community.community_members); quien
// crea una comunidad queda como su primer miembro.

/** Estatus editables por el usuario. `deleted` es el soft delete: se alcanza
 *  por DELETE, nunca se elige en el formulario. */
export const COMMUNITY_STATUSES = ["active", "inactive"] as const;

// --- Entrada: listar (GET /communities) -------------------------------------
export const listCommunitiesQueryV1V = new V.ObjectNotNull(
  {
    ...pageQueryFields(),
    search: new V.String({ maxLength: 200 }),
    // Ausente = solo activas (lo que espera el selector de alcance de las
    // apps). `all` = activas + inactivas, para la pantalla de administración.
    status: new V.String({ in: [...COMMUNITY_STATUSES, "all"] }),
  },
  { strictMode: true },
);

// --- Entrada: crear (POST /communities) -------------------------------------
export const createCommunityV1V = new V.ObjectNotNull(
  {
    code: new V.StringNotNull({ minLength: 1, maxLength: 50 }),
    name: new V.StringNotNull({ minLength: 1, maxLength: 200 }),
    address: new V.String({ maxLength: 500 }),
  },
  { strictMode: true },
);

// --- Entrada: actualizar (PATCH /communities/:communityId) ------------------
export const updateCommunityV1V = new V.ObjectNotNull(
  {
    code: new V.String({ minLength: 1, maxLength: 50 }),
    name: new V.String({ minLength: 1, maxLength: 200 }),
    address: new V.String({ maxLength: 500 }),
    status: new V.String({ in: [...COMMUNITY_STATUSES] }),
  },
  { strictMode: true },
);

// --- Entrada: saldo (GET /communities/:communityId/balance) -----------------
export const balanceQueryV1V = new V.ObjectNotNull(
  {
    toDate: new V.String({ regex: ISO_DATE_REGEX }),
  },
  { strictMode: true },
);

// --- Salida: una comunidad ---------------------------------------------------
export const communityV1V = new V.ObjectNotNull({
  id: new V.StringNotNull(),
  code: new V.StringNotNull(),
  name: new V.StringNotNull(),
  address: new V.String(),
  status: new V.StringNotNull(),
  createdAt: new V.StringNotNull(),
  updatedAt: new V.StringNotNull(),
});

// --- Salida: listado paginado -------------------------------------------------
export const communityListV1V = new V.ObjectNotNull({
  items: new V.ArrayNotNull(communityV1V),
  total: new V.NumberNotNull(),
  page: new V.NumberNotNull(),
  pageSize: new V.NumberNotNull(),
});

// --- Salida: saldo de la caja --------------------------------------------------
export const communityBalanceV1V = new V.ObjectNotNull({
  communityId: new V.StringNotNull(),
  balance: new V.NumberNotNull(),
  toDate: new V.String(),
});

export { errorResponseV1V };
