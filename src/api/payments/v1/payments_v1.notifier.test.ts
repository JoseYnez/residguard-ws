import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { paymentClickUrl, paymentMessage, type PaymentUnitNotice } from "./payments_v1.notifier";

const UNIT: PaymentUnitNotice = {
    unitId: "u1",
    unitCode: "426-A",
    unitTower: null,
    unitType: "house",
    amount: 800,
    covers: ["Mantenimiento, Septiembre-2026"],
    notifyUserIds: [],
};

describe("paymentMessage", () => {
    it("dice cuánto, de qué domicilio y qué cubrió", () => {
        assert.deepEqual(paymentMessage(UNIT), {
            title: "Recibimos tu pago",
            body: "$800.00 de tu casa 426-A. Cubre: Mantenimiento, Septiembre-2026.",
        });
    });

    it("nombra completos hasta dos cargos", () => {
        const { body } = paymentMessage({
            ...UNIT,
            covers: ["Mantenimiento, Agosto-2026", "Mantenimiento, Septiembre-2026"],
        });
        assert.equal(
            body,
            "$800.00 de tu casa 426-A. Cubre: Mantenimiento, Agosto-2026; Mantenimiento, Septiembre-2026.",
        );
    });

    it("con más de dos cargos nombra el primero y cuenta el resto", () => {
        const { body } = paymentMessage({
            ...UNIT,
            covers: ["Mantenimiento, Septiembre-2026", "Agua, Septiembre-2026", "Tarjeta de acceso ×2"],
        });
        assert.equal(body, "$800.00 de tu casa 426-A. Cubre: Mantenimiento, Septiembre-2026 y 2 más.");
    });

    it("sin cargos resueltos omite la frase, no la deja colgando", () => {
        assert.equal(paymentMessage({ ...UNIT, covers: [] }).body, "$800.00 de tu casa 426-A.");
    });

    it("usa torre y tipo, y nunca dice unidad", () => {
        const { title, body } = paymentMessage({
            ...UNIT,
            unitType: "apartment",
            unitTower: "Torre B",
            unitCode: "302",
        });
        assert.match(body, /de tu departamento Torre B 302\./);
        assert.doesNotMatch(`${title} ${body}`, /unidad/i);
    });
});

describe("paymentClickUrl", () => {
    it("abre Mis pagos en ESE pago", () => {
        assert.equal(paymentClickUrl("abc"), "/my-payments?payment=abc");
    });
});
