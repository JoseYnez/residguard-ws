import { Verifiers as V } from "structure-verifier";
import {
  errorResponseV1V,
  pageQueryFields,
  UUID_REGEX,
} from "../../common/common_v1.verifier";

// Contratos del recurso community-members: la relación usuario <-> comunidad
// (community.community_members). Es la tabla de VISIBILIDAD: define qué
// comunidades —y por tanto qué unidades— puede ver el usuario del token.

// --- Entrada: listar (GET /communities/:communityId/members) ----------------
export const listCommunityMembersQueryV1V = new V.ObjectNotNull(
  {
    ...pageQueryFields(),
    search: new V.String({ maxLength: 200 }),
  },
  { strictMode: true },
);

// --- Entrada: otorgar acceso (POST /communities/:communityId/members) -------
export const createCommunityMemberV1V = new V.ObjectNotNull(
  {
    userId: new V.StringNotNull({ regex: UUID_REGEX }),
  },
  { strictMode: true },
);

// --- Salida: una membresía ----------------------------------------------------
export const communityMemberV1V = new V.ObjectNotNull({
  id: new V.StringNotNull(),
  communityId: new V.StringNotNull(),
  userId: new V.StringNotNull(),
  fullName: new V.StringNotNull(),
  email: new V.StringNotNull(),
  status: new V.StringNotNull(),
  createdAt: new V.StringNotNull(),
  updatedAt: new V.StringNotNull(),
});

// --- Salida: listado paginado ---------------------------------------------------
export const communityMemberListV1V = new V.ObjectNotNull({
  items: new V.ArrayNotNull(communityMemberV1V),
  total: new V.NumberNotNull(),
  page: new V.NumberNotNull(),
  pageSize: new V.NumberNotNull(),
});

export { errorResponseV1V };
