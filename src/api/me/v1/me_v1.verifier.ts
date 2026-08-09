import { Verifiers as V } from "structure-verifier";
import { errorResponseV1V } from "../../common/common_v1.verifier";
import { unitChargeStatementV1V, unitStatementQueryV1V } from "../../reports/v1/reports_v1.verifier";

// Contratos del recurso me/v1: la AUTOCONSULTA del residente. Todo lo que sale
// de aquí es del usuario del token — no hay parámetro de comunidad ni de
// persona: la pertenencia la resuelve el servidor por el vínculo del padrón
// (members.user_id = sub).

// --- Salida: una unidad MÍA ---------------------------------------------------
// La asignación vista desde el usuario: la unidad con su comunidad y el rol de
// la relación (owner/tenant/resident). Trae la comunidad porque el residente no
// tiene selector de alcance: sus unidades pueden repartirse en varias.
export const myUnitV1V = new V.ObjectNotNull({
  unitId: new V.StringNotNull(),
  unitCode: new V.StringNotNull(),
  unitTower: new V.String(),
  unitType: new V.StringNotNull(),
  address: new V.String(),
  /** Rol de la RELACIÓN persona↔unidad (owner | tenant | resident). */
  memberType: new V.StringNotNull(),
  communityId: new V.StringNotNull(),
  communityName: new V.StringNotNull(),
});

// --- Salida: mis unidades -----------------------------------------------------
// SIN paginación, a propósito (excepción documentada al §5 del CLAUDE.md): el
// conjunto está acotado por naturaleza — las unidades de UNA persona — y un
// residente típico tiene una o dos. Paginar obligaría al portal a orquestar
// páginas para pintar una lista de tres filas.
export const myUnitListV1V = new V.ObjectNotNull({
  items: new V.ArrayNotNull(myUnitV1V),
});

// El estado de cuenta reusa el contrato COMPLETO de la V2 de reports
// (unitChargeStatementV1V): misma fila por cargo, mismos totales — es la misma
// información con otra frontera de autorización.
export { errorResponseV1V, unitChargeStatementV1V, unitStatementQueryV1V };
