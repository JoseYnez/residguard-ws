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
  type UnitChargeStatement,
  type UnitStatement,
  type UnitStatementInput,
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
   * Estado de cuenta de una unidad. Una sola transacción por el mismo motivo
   * que los demás: el saldo anterior, los renglones y los totales se validan
   * entre sí (`anterior + cargos − abonos = final`), y leídos en transacciones
   * distintas un pago que entrara a la mitad los haría discrepar. `null` =
   * unidad inexistente o fuera de la comunidad → 404.
   */
  async unitStatement(
    req: FastifyRequest,
    input: UnitStatementInput,
  ): Promise<(UnitStatement & { timezone: string }) | null> {
    const result = await withTransaction(contextFor(req), (tx) =>
      reportsRepository.unitStatement(tx, input),
    );
    if (result === null) {
      return null;
    }
    // La zona viaja con la respuesta, como en los demás reportes: los días del
    // estado de cuenta son los de la operación, y el PDF tiene que decirlo.
    return { ...result, timezone: config.dbTimezone };
  },

  /**
   * Estado de cuenta V2 (por cargo). Una sola transacción por el mismo motivo
   * que la V1: los renglones y los totales se validan entre sí
   * (`cargos − pagado − condonado = saldo`), y leídos en transacciones
   * distintas un pago que entrara a la mitad los haría discrepar. `null` =
   * unidad inexistente o fuera de la comunidad → 404.
   */
  async unitChargeStatement(
    req: FastifyRequest,
    input: UnitStatementInput,
  ): Promise<(UnitChargeStatement & { timezone: string }) | null> {
    const result = await withTransaction(contextFor(req), (tx) =>
      reportsRepository.unitChargeStatement(tx, input),
    );
    if (result === null) {
      return null;
    }
    // La zona viaja con la respuesta, igual que en la V1: las fechas de pago de
    // esta vista son días recortados en la zona de operación, y el PDF tiene
    // que poder decirlo.
    return { ...result, timezone: config.dbTimezone };
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
