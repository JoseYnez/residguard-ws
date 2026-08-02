import type { FastifyRequest } from "fastify";
import { contextFor } from "../../../core/auth/community_access";
import { config } from "../../../config";
import { withTransaction } from "../../../core/db/with_transaction";
import {
  reportsRepository,
  type ListUnitDebtInput,
  type ReportRangeInput,
  type ReportSummary,
  type UnitDebt,
  type UnitDebtTotals,
} from "./reports_v1.repository";

// Orquestación del recurso reports. Solo lectura: no hay vías sancionadas que
// invocar ni errores de PG que traducir — un reporte no viola constraints.
//
// El resumen sale de UNA sola transacción a propósito. Sus bloques se validan
// entre sí (`openingBalance + income − outflow = closingBalance`), y con una
// transacción por consulta dos de ellas podrían leer estados distintos: bastaría
// que entrara un pago a la mitad para que el saldo final no cuadrase con sus
// componentes y el reporte se contradijera solo.

export const reportsController = {
  async summary(req: FastifyRequest, input: ReportRangeInput): Promise<ReportSummary | null> {
    return withTransaction(contextFor(req), (tx) =>
      reportsRepository.summary(tx, input, config.dbTimezone),
    );
  },

  async unitDebt(
    req: FastifyRequest,
    input: ListUnitDebtInput,
  ): Promise<{ items: UnitDebt[]; total: number; totals: UnitDebtTotals }> {
    return withTransaction(contextFor(req), (tx) => reportsRepository.unitDebt(tx, input));
  },
};
