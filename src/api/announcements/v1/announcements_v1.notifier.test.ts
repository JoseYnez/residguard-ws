import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
    announcementClickUrl,
    announcementMessage,
    batchRecipients,
} from "./announcements_v1.notifier";

describe("announcementMessage", () => {
    it("nombra la comunidad en el título y arranca el cuerpo con el del comunicado", () => {
        const message = announcementMessage({
            communityName: "Residencial Uno",
            title: "Corte de agua",
            body: "## Aviso\n\nEl **martes** no habrá agua de 9 a 14 h.",
        });
        assert.equal(message.title, "Nuevo comunicado · Residencial Uno");
        assert.equal(message.body, "Corte de agua — Aviso El martes no habrá agua de 9 a 14 h.");
    });

    it("sin cuerpo, el aviso es solo el título del comunicado", () => {
        const message = announcementMessage({
            communityName: "Residencial Uno",
            title: "Junta el sábado",
            body: "   ",
        });
        assert.equal(message.body, "Junta el sábado");
    });

    it("un cuerpo largo se recorta sin partir palabras", () => {
        const message = announcementMessage({
            communityName: "C",
            title: "T",
            body: "palabra ".repeat(60),
        });
        // "T — " + extracto de 120
        assert.ok(message.body.length <= 4 + 120);
        assert.ok(message.body.endsWith("…"));
    });
});

describe("batchRecipients", () => {
    it("una audiencia chica es un solo lote", () => {
        assert.deepEqual(batchRecipients(["a", "b"], 5_000), [["a", "b"]]);
    });

    it("parte en lotes del tamaño pedido sin perder ni repetir a nadie", () => {
        const ids = Array.from({ length: 11 }, (_, i) => `u${i}`);
        const batches = batchRecipients(ids, 5);
        assert.deepEqual(
            batches.map((b) => b.length),
            [5, 5, 1],
        );
        assert.deepEqual(batches.flat(), ids);
    });

    it("audiencia vacía: ningún lote (nada que encolar)", () => {
        assert.deepEqual(batchRecipients([], 5_000), []);
    });
});

describe("announcementClickUrl", () => {
    it("abre el portal en ESE comunicado (patrón de /my-payments?payment=)", () => {
        assert.equal(announcementClickUrl("abc"), "/my-announcements?announcement=abc");
    });
});
