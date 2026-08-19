import type { FastifyInstance } from "fastify";
import type { StructureVerifierTypeProvider } from "structure-verifier/fastify";
import { PERMISSIONS } from "../../../core/auth/permissions";
import { requirePermission } from "../../../core/auth/require_permission";
import { idParamV1V } from "../../common/common_v1.verifier";
import { paymentEvidenceController } from "./payment_evidence_v1.controller";
import {
  createEvidenceV1V,
  errorResponseV1V,
  evidenceFileLinkV1V,
  evidenceFileParamV1V,
  evidenceListV1V,
  evidenceV1V,
  listEvidenceQueryV1V,
  rejectEvidenceV1V,
  verifyEvidenceV1V,
} from "./payment_evidence_v1.verifier";

// Recurso payment-evidence/v1, lado de la OPERACIÓN: la bandeja de
// comprobantes de una comunidad, la captura en ventanilla y las dos
// resoluciones (verificar = registrar el pago | rechazar con motivo).
//
// El alcance no usa preHandler de ruta: la evidencia no viaja con communityId
// en la URL — el controller lo valida contra la comunidad de la evidencia (o
// de la unidad, al capturar), igual que payments.

export async function paymentEvidenceV1Routes(instance: FastifyInstance): Promise<void> {
  const app = instance.withTypeProvider<StructureVerifierTypeProvider>();

  // La bandeja de una comunidad. Sin `status` el controller sirve TODO; la SPA
  // manda pending_review por default (la bandeja ES lo pendiente).
  app.get(
    "/payment-evidence",
    {
      schema: {
        querystring: listEvidenceQueryV1V,
        response: { 200: evidenceListV1V, 404: errorResponseV1V },
      },
      preHandler: requirePermission(PERMISSIONS.paymentEvidenceRead),
    },
    async (req, reply) => {
      const q = req.query;
      const result = await paymentEvidenceController.list(req, {
        communityId: q.communityId,
        page: q.page,
        pageSize: q.pageSize,
        status: q.status ?? null,
        unitId: q.unitId ?? null,
        from: q.from ?? null,
        to: q.to ?? null,
      });
      if (result === null) {
        return reply.code(404).send({ error: "not_found", message: null });
      }
      return reply
        .code(200)
        .send({ items: result.items, total: result.total, page: q.page, pageSize: q.pageSize });
    },
  );

  // Una evidencia con sus archivos y (si la tiene) la referencia del pago.
  app.get(
    "/payment-evidence/:id",
    {
      schema: {
        params: idParamV1V,
        response: { 200: evidenceV1V, 404: errorResponseV1V },
      },
      preHandler: requirePermission(PERMISSIONS.paymentEvidenceRead),
    },
    async (req, reply) => {
      const found = await paymentEvidenceController.getById(req, req.params.id);
      if (found === null) {
        return reply.code(404).send({ error: "not_found", message: null });
      }
      return reply.code(200).send(found);
    },
  );

  // Enlace firmado de descarga de un archivo adjunto. La SPA lo pide al
  // momento de mostrar el comprobante (vigencia corta, no se almacena).
  app.get(
    "/payment-evidence/:id/files/:fileId/link",
    {
      schema: {
        params: evidenceFileParamV1V,
        response: { 200: evidenceFileLinkV1V, 404: errorResponseV1V, 503: errorResponseV1V },
      },
      preHandler: requirePermission(PERMISSIONS.paymentEvidenceRead),
    },
    async (req, reply) => {
      const link = await paymentEvidenceController.fileLink(
        req,
        req.params.id,
        req.params.fileId,
      );
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

  // Captura en ventanilla: alguien llevó su comprobante (o su ticket) al
  // escritorio. Nace pending_review COMO las del portal — que la haya tecleado
  // un operador no la exime de la verificación de quien registra pagos.
  app.post(
    "/payment-evidence",
    {
      schema: {
        body: createEvidenceV1V,
        response: { 201: evidenceV1V, 400: errorResponseV1V, 404: errorResponseV1V },
      },
      preHandler: requirePermission(PERMISSIONS.paymentEvidenceCreate),
    },
    async (req, reply) => {
      const b = req.body;
      const result = await paymentEvidenceController.create(req, {
        unitId: b.unitId,
        memberId: b.memberId,
        declaredAmount: b.declaredAmount,
        declaredPaidAt: b.declaredPaidAt ?? null,
        declaredMethod: b.declaredMethod,
        reference: b.reference ?? null,
        notes: b.notes ?? null,
        fileIds: b.fileIds ?? [],
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

  // VERIFICAR = registrar el pago. El cuerpo es el MISMO contrato que
  // POST /payments y el permiso también es el suyo: no hay código
  // `payment_evidence.verify` — quien puede registrar pagos puede verificar.
  app.post(
    "/payment-evidence/:id/verification",
    {
      schema: {
        params: idParamV1V,
        body: verifyEvidenceV1V,
        response: {
          201: evidenceV1V,
          400: errorResponseV1V,
          404: errorResponseV1V,
          409: errorResponseV1V,
        },
      },
      preHandler: requirePermission(PERMISSIONS.paymentsCreate),
    },
    async (req, reply) => {
      const b = req.body;
      const result = await paymentEvidenceController.verify(req, req.params.id, {
        amount: b.amount,
        method: b.method,
        paidAt: b.paidAt ?? null,
        reference: b.reference ?? null,
        cashAccountId: b.cashAccountId ?? null,
        allocations: b.allocations.map((a) => ({ chargeId: a.chargeId, amount: a.amount })),
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

  // Rechazar, con motivo obligatorio. `.update` y no un código propio: es la
  // única mutación directa del recurso (no hay edición de una evidencia).
  app.post(
    "/payment-evidence/:id/rejection",
    {
      schema: {
        params: idParamV1V,
        body: rejectEvidenceV1V,
        response: {
          200: evidenceV1V,
          404: errorResponseV1V,
          409: errorResponseV1V,
        },
      },
      preHandler: requirePermission(PERMISSIONS.paymentEvidenceUpdate),
    },
    async (req, reply) => {
      const result = await paymentEvidenceController.reject(req, req.params.id, req.body.note);
      if (result === null) {
        return reply.code(404).send({ error: "not_found", message: null });
      }
      if (!result.ok) {
        return reply.code(409).send({ error: result.error.kind, message: result.error.message });
      }
      return reply.code(200).send(result.value);
    },
  );
}
