import type { FastifyRequest } from "fastify";
import { contextFor } from "../../../core/auth/community_access";
import { withTransaction } from "../../../core/db/with_transaction";
import {
  chargesRepository,
  type Charge,
  type ListChargesInput,
} from "./charges_v1.repository";

// Orquestación del recurso charges (solo lectura). El acceso a la unidad ya
// lo garantizó requireUnitAccess.

export const chargesController = {
  async list(
    req: FastifyRequest,
    input: ListChargesInput,
  ): Promise<{ items: Charge[]; total: number }> {
    return withTransaction(contextFor(req), (tx) => chargesRepository.list(tx, input));
  },
};
