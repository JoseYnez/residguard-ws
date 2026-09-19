import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { evidenceRejectedClickUrl, evidenceRejectedMessage } from "./payment_evidence_v1.notifier";

describe("evidenceRejectedMessage", () => {
    it("da el motivo y qué hacer", () => {
        assert.deepEqual(evidenceRejectedMessage("La foto no se lee"), {
            title: "Tu comprobante fue rechazado",
            body: "Motivo: La foto no se lee. Corrígelo y envíalo de nuevo.",
        });
    });

    it("no duplica el punto final del motivo", () => {
        assert.equal(
            evidenceRejectedMessage("El monto no coincide.  ").body,
            "Motivo: El monto no coincide. Corrígelo y envíalo de nuevo.",
        );
    });

    it("aplana saltos de línea", () => {
        assert.equal(
            evidenceRejectedMessage("Falta la referencia\n\ny la fecha").body,
            "Motivo: Falta la referencia y la fecha. Corrígelo y envíalo de nuevo.",
        );
    });

    it("recorta un motivo largo sin partir palabras y conserva la instrucción", () => {
        const { body } = evidenceRejectedMessage("palabra ".repeat(60));
        const note = body.slice("Motivo: ".length, body.indexOf(". Corrígelo"));
        assert.ok(note.length <= 141, `motivo de ${note.length} caracteres`);
        assert.ok(note.endsWith("palabra…"));
        assert.ok(body.endsWith("Corrígelo y envíalo de nuevo."));
    });
});

describe("evidenceRejectedClickUrl", () => {
    it("abre la pestaña de evidencias en ESA evidencia", () => {
        assert.equal(evidenceRejectedClickUrl("e1"), "/my-payments?tab=evidencias&evidence=e1");
    });
});
