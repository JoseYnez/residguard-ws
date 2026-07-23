import { Verifiers as V } from "structure-verifier";
import {
  errorResponseV1V,
  ISO_DATE_REGEX,
  pageQueryFields,
} from "../../common/common_v1.verifier";

// Contratos del recurso communities: SOLO LECTURA en esta versión. Las
// comunidades se crean/administran desde la consola de la cuenta; aquí el
// usuario ve únicamente aquellas donde tiene membresía activa
// (community.community_members).

// --- Entrada: listar (GET /communities) -------------------------------------
export const listCommunitiesQueryV1V = new V.ObjectNotNull(
  {
    ...pageQueryFields(),
    search: new V.String({ maxLength: 200 }),
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
