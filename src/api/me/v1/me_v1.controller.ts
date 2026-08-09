import type { FastifyRequest } from "fastify";
import { requireAuth } from "../../../core/auth/authenticate";
import { contextFor } from "../../../core/auth/community_access";
import { withTransaction } from "../../../core/db/with_transaction";
import type { UnitChargeStatement } from "../../reports/v1/reports_v1.repository";
import { meRepository, type MyUnit } from "./me_v1.repository";

// Orquestación del recurso me. No hay preHandler de alcance que garantizar:
// el "alcance" ES el usuario del token (claims.sub), y la pertenencia de cada
// unidad la resuelve el repositorio por el vínculo del padrón.

export const meController = {
  async listMyUnits(req: FastifyRequest): Promise<MyUnit[]> {
    const claims = requireAuth(req);
    return withTransaction(contextFor(req), (tx) => meRepository.listMyUnits(tx, claims.sub));
  },

  /** `null` cuando la unidad no es del usuario (o no existe) → 404 en la route. */
  async myUnitStatement(
    req: FastifyRequest,
    input: {
      readonly unitId: string;
      readonly from: string;
      readonly to: string;
      readonly page: number;
      readonly pageSize: number;
    },
  ): Promise<UnitChargeStatement | null> {
    const claims = requireAuth(req);
    return withTransaction(contextFor(req), (tx) =>
      meRepository.myUnitStatement(tx, claims.sub, input),
    );
  },
};
