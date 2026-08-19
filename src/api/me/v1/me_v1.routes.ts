import type { FastifyInstance } from "fastify";
import type { StructureVerifierTypeProvider } from "structure-verifier/fastify";
import { config } from "../../../config";
import { PERMISSIONS } from "../../../core/auth/permissions";
import { requirePermission } from "../../../core/auth/require_permission";
import { idParamV1V, unitIdParamV1V } from "../../common/common_v1.verifier";
import { meController } from "./me_v1.controller";
import { pageQueryFields } from "../../common/common_v1.verifier";
import { Verifiers as V } from "structure-verifier";
import {
  chargeListV1V,
  createMyEvidenceV1V,
  createVisitV1V,
  errorResponseV1V,
  evidenceFileLinkV1V,
  evidenceFileParamV1V,
  evidenceListV1V,
  evidenceV1V,
  listMyEvidenceQueryV1V,
  listMyVisitsQueryV1V,
  myUnitListV1V,
  unitChargeStatementV1V,
  unitStatementQueryV1V,
  visitDetailV1V,
  visitListV1V,
  visitV1V,
} from "./me_v1.verifier";

// Recurso me/v1: la AUTOCONSULTA del residente — sus unidades y su estado de
// cuenta. Es la primera superficie del servicio cuya frontera de alcance NO es
// community_members: un residente no ve la comunidad, ve LO SUYO, y "lo suyo"
// lo define el vínculo del padrón (members.user_id = sub) que dejó el flujo de
// invitación. Por eso estas rutas no llevan requireCommunityAccess(): la
// pertenencia la resuelve el repositorio con la cadena
// sub → members → unit_members → units (fuera de la cadena → 404).
//
// El permiso sigue siendo la primera frontera (403): `self_units.read` /
// `self_statement.read`, concedidos por el rol `community_resident` (y por
// community_admin — la anti-escalada de la superficie tenant exige que quien
// concede el rol tenga sus permisos, y de paso el operador puede probar el
// portal con sus propias unidades si las tiene).

// Solo paginación: el listado es SIEMPRE de cargos abiertos (openOnly lo fija
// el controller) — el formulario no filtra por fechas ni estatus.
const myUnitChargesQueryV1V = new V.ObjectNotNull({ ...pageQueryFields() }, { strictMode: true });

export async function meV1Routes(instance: FastifyInstance): Promise<void> {
  const app = instance.withTypeProvider<StructureVerifierTypeProvider>();

  // Mis unidades vigentes, en todas mis comunidades.
  app.get(
    "/me/units",
    {
      schema: {
        response: { 200: myUnitListV1V },
      },
      preHandler: [requirePermission(PERMISSIONS.selfUnitsRead)],
    },
    async (req, reply) => {
      const items = await meController.listMyUnits(req);
      return reply.code(200).send({ items });
    },
  );

  // Estado de cuenta (vista por cargo, contrato idéntico a la V2 de reports)
  // de una unidad MÍA.
  app.get(
    "/me/units/:unitId/statement",
    {
      schema: {
        params: unitIdParamV1V,
        querystring: unitStatementQueryV1V,
        response: { 200: unitChargeStatementV1V, 400: errorResponseV1V, 404: errorResponseV1V },
      },
      preHandler: [requirePermission(PERMISSIONS.selfStatementRead)],
    },
    async (req, reply) => {
      const q = req.query;
      // Mismo rechazo que reports: un estado de cuenta vacío se lee como "no
      // devengué nada", que no es lo que pasó con un rango invertido.
      if (q.from > q.to) {
        return reply.code(400).send({
          error: "invalid",
          message: "La fecha inicial no puede ser posterior a la final.",
        });
      }
      const statement = await meController.myUnitStatement(req, {
        unitId: req.params.unitId,
        from: q.from,
        to: q.to,
        page: q.page,
        pageSize: q.pageSize,
      });
      if (statement === null) {
        return reply.code(404).send({ error: "not_found", message: null });
      }
      const { unit, items, total, totals } = statement;
      // `timezone`: la zona con la que se recortaron los días (DB_TIMEZONE),
      // igual que en reports — el cliente debe poder decir en qué días está
      // expresado el estado de cuenta.
      return reply.code(200).send({
        unit,
        items,
        total,
        page: q.page,
        pageSize: q.pageSize,
        timezone: config.dbTimezone,
        totals,
      });
    },
  );

  // --- Mis visitas -----------------------------------------------------------
  // El registro previo de visitas del residente. La comunidad NUNCA viaja en la
  // ruta ni en el cuerpo: se deriva de la unidad, y la unidad se valida contra
  // la cadena del padrón. Un residente no conoce el id de su comunidad y no
  // tiene por qué.

  // Mis pases (paginado, a diferencia de /me/units: las visitas se acumulan).
  app.get(
    "/me/visits",
    {
      schema: {
        querystring: listMyVisitsQueryV1V,
        response: { 200: visitListV1V },
      },
      preHandler: [requirePermission(PERMISSIONS.selfVisitsRead)],
    },
    async (req, reply) => {
      const q = req.query;
      const { items, total } = await meController.listMyVisits(req, {
        page: q.page,
        pageSize: q.pageSize,
        unitId: q.unitId ?? null,
        state: q.state ?? null,
      });
      return reply.code(200).send({ items, total, page: q.page, pageSize: q.pageSize });
    },
  );

  // Un pase mío CON su bitácora: las entradas y salidas que anotó la caseta.
  // Es la misma forma que devuelve el detalle del operador (`visitDetailV1V`)
  // porque es el mismo hecho: quién llegó y a qué hora. Lo que cambia es la
  // frontera —aquí la propiedad, allá la comunidad—, no el contrato.
  app.get(
    "/me/visits/:id",
    {
      schema: {
        params: idParamV1V,
        response: { 200: visitDetailV1V, 404: errorResponseV1V },
      },
      preHandler: [requirePermission(PERMISSIONS.selfVisitsRead)],
    },
    async (req, reply) => {
      const detail = await meController.myVisitDetail(req, req.params.id);
      if (detail === null) {
        return reply.code(404).send({ error: "not_found", message: null });
      }
      return reply.code(200).send(detail);
    },
  );

  // Registrar una visita. El código llega en la respuesta: es lo que el
  // residente comparte, y no hay segunda oportunidad de pedirlo (bueno, sí: el
  // GET de arriba — el código NO es de un solo uso ni se oculta después).
  app.post(
    "/me/visits",
    {
      schema: {
        body: createVisitV1V,
        response: {
          201: visitV1V,
          400: errorResponseV1V,
          404: errorResponseV1V,
          409: errorResponseV1V,
        },
      },
      preHandler: [requirePermission(PERMISSIONS.selfVisitsCreate)],
    },
    async (req, reply) => {
      const b = req.body;
      const result = await meController.createMyVisit(req, {
        unitId: b.unitId,
        visitType: b.visitType ?? null,
        scheduleType: b.scheduleType ?? null,
        visitorName: b.visitorName,
        visitorCompany: b.visitorCompany ?? null,
        visitorPhone: b.visitorPhone ?? null,
        vehiclePlate: b.vehiclePlate ?? null,
        companions: b.companions ?? null,
        validFrom: b.validFrom,
        validTo: b.validTo ?? null,
        timeFrom: b.timeFrom ?? null,
        timeTo: b.timeTo ?? null,
        weekdays: b.weekdays ?? null,
        maxEntries: b.maxEntries ?? null,
        accessMode: b.accessMode ?? null,
        requiresId: b.requiresId ?? null,
        notes: b.notes ?? null,
      });
      if (result === null) {
        return reply.code(404).send({ error: "not_found", message: null });
      }
      if (!result.ok) {
        const status = result.error.kind === "conflict" ? 409 : 400;
        return reply.code(status).send({ error: result.error.kind, message: result.error.message });
      }
      return reply.code(201).send(result.value);
    },
  );

  // Cancelar un pase mío. Baja lógica → se autoriza con `.update`.
  //
  // Devuelve el pase (no 204) porque el cliente pinta el estado resultante, y
  // el pase CANCELADO sigue existiendo a propósito: la caseta tiene que poder
  // decir "cancelado" en vez de "no existe" cuando alguien llegue con el QR ya
  // compartido.
  app.delete(
    "/me/visits/:id",
    {
      schema: {
        params: idParamV1V,
        response: { 200: visitV1V, 404: errorResponseV1V },
      },
      preHandler: [requirePermission(PERMISSIONS.selfVisitsUpdate)],
    },
    async (req, reply) => {
      const cancelled = await meController.cancelMyVisit(req, req.params.id);
      if (cancelled === null) {
        return reply.code(404).send({ error: "not_found", message: null });
      }
      return reply.code(200).send(cancelled);
    },
  );

  // --- Mis comprobantes de pago ----------------------------------------------
  // El residente ENVÍA la evidencia de un pago que ya hizo; el operador la
  // atiende en su bandeja (verificar = registrar el pago | rechazar). Los
  // ARCHIVOS no pasan por aquí: la SPA los sube directo a storage-service con
  // el Bearer del usuario y este servicio recibe solo los ids — los valida
  // contra storage y espeja su metadata. La comunidad, como en visitas, se
  // DERIVA de la unidad; el residente no la conoce ni tiene por qué.

  // Mis comprobantes, con su estado (¿ya lo vieron? ¿me lo rechazaron?).
  app.get(
    "/me/payment-evidence",
    {
      schema: {
        querystring: listMyEvidenceQueryV1V,
        response: { 200: evidenceListV1V },
      },
      preHandler: [requirePermission(PERMISSIONS.selfPaymentEvidenceRead)],
    },
    async (req, reply) => {
      const q = req.query;
      const { items, total } = await meController.listMyEvidence(req, {
        page: q.page,
        pageSize: q.pageSize,
        unitId: q.unitId ?? null,
        status: q.status ?? null,
      });
      return reply.code(200).send({ items, total, page: q.page, pageSize: q.pageSize });
    },
  );

  // Un comprobante mío. Misma forma que ve el operador (evidenceV1V): es el
  // mismo hecho; cambia la frontera, no el contrato.
  app.get(
    "/me/payment-evidence/:id",
    {
      schema: {
        params: idParamV1V,
        response: { 200: evidenceV1V, 404: errorResponseV1V },
      },
      preHandler: [requirePermission(PERMISSIONS.selfPaymentEvidenceRead)],
    },
    async (req, reply) => {
      const found = await meController.myEvidence(req, req.params.id);
      if (found === null) {
        return reply.code(404).send({ error: "not_found", message: null });
      }
      return reply.code(200).send(found);
    },
  );

  // Enlace firmado de descarga de un archivo mío (para re-ver lo que envié).
  app.get(
    "/me/payment-evidence/:id/files/:fileId/link",
    {
      schema: {
        params: evidenceFileParamV1V,
        response: { 200: evidenceFileLinkV1V, 404: errorResponseV1V, 503: errorResponseV1V },
      },
      preHandler: [requirePermission(PERMISSIONS.selfPaymentEvidenceRead)],
    },
    async (req, reply) => {
      const link = await meController.myEvidenceFileLink(req, req.params.id, req.params.fileId);
      if (link === "not_found") {
        return reply.code(404).send({ error: "not_found", message: null });
      }
      if (link === "unavailable") {
        return reply.code(503).send({
          error: "storage_unavailable",
          message: "El almacén de archivos no respondió. Intenta de nuevo.",
        });
      }
      return reply.code(200).send(link);
    },
  );

  // Cargos ABIERTOS de una unidad mía: lo que el formulario de envío ofrece
  // marcar ("¿qué estás pagando?"). Mismo contrato que el recurso charges;
  // frontera por la cadena del padrón. Gate: el permiso de ENVIAR — este
  // listado existe para ese formulario, no es el estado de cuenta (que tiene
  // su propio permiso y su propia pantalla).
  app.get(
    "/me/units/:unitId/charges",
    {
      schema: {
        params: unitIdParamV1V,
        querystring: myUnitChargesQueryV1V,
        response: { 200: chargeListV1V, 404: errorResponseV1V },
      },
      preHandler: [requirePermission(PERMISSIONS.selfPaymentEvidenceCreate)],
    },
    async (req, reply) => {
      const q = req.query;
      const result = await meController.myUnitOpenCharges(req, {
        unitId: req.params.unitId,
        page: q.page,
        pageSize: q.pageSize,
      });
      if (result === null) {
        return reply.code(404).send({ error: "not_found", message: null });
      }
      return reply
        .code(200)
        .send({ items: result.items, total: result.total, page: q.page, pageSize: q.pageSize });
    },
  );

  // Enviar un comprobante. Nace pending_review; no hay edición ni cancelación
  // del residente — si fue un error, el operador lo rechaza y se envía otro.
  app.post(
    "/me/payment-evidence",
    {
      schema: {
        body: createMyEvidenceV1V,
        response: {
          201: evidenceV1V,
          400: errorResponseV1V,
          404: errorResponseV1V,
        },
      },
      preHandler: [requirePermission(PERMISSIONS.selfPaymentEvidenceCreate)],
    },
    async (req, reply) => {
      const b = req.body;
      const result = await meController.createMyEvidence(req, {
        unitId: b.unitId,
        declaredAmount: b.declaredAmount,
        declaredPaidAt: b.declaredPaidAt ?? null,
        declaredMethod: b.declaredMethod,
        reference: b.reference ?? null,
        notes: b.notes ?? null,
        fileIds: b.fileIds,
        chargeIds: b.chargeIds ?? [],
      });
      if (result === null) {
        return reply.code(404).send({ error: "not_found", message: null });
      }
      if (!result.ok) {
        return reply.code(400).send({ error: result.error.kind, message: result.error.message });
      }
      return reply.code(201).send(result.value);
    },
  );
}
