import type { FastifyRequest } from "fastify";
import { contextFor } from "../../../core/auth/community_access";
import { config } from "../../../config";
import { withTransaction } from "../../../core/db/with_transaction";
import {
  reportsRepository,
  type ListMovementsInput,
  type ListUnitDebtInput,
  type Movement,
  type MovementTotals,
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

  /**
   * Movimientos del rango. Una sola transacción por el mismo motivo que el
   * resumen: los saldos de corte y los renglones se validan entre sí
   * (`inicial + entradas − salidas = final`), y leídos en transacciones
   * distintas un pago que entre a la mitad haría que el reporte se
   * contradijera solo.
   */
  async movements(
    req: FastifyRequest,
    input: ListMovementsInput,
  ): Promise<{
    items: Movement[];
    total: number;
    totals: MovementTotals;
    timezone: string;
  }> {
    const result = await withTransaction(contextFor(req), (tx) =>
      reportsRepository.movements(tx, input),
    );
    // La zona viaja con la respuesta, como en el resumen: los días del reporte
    // son los de la operación, no los del dispositivo que lo abre, y el PDF
    // tiene que poder decirlo.
    return { ...result, timezone: config.dbTimezone };
  },
};
