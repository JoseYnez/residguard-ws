import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { arrivalMessage, departureMessage, isExhaustedByThisEntry } from "./visits_v1.notifier";
import type { Visit } from "./visits_v1.repository";

// Solo los campos que leen los mensajes; el resto del pase no participa.
function visit(overrides: Partial<Visit> = {}): Visit {
    return {
        id: "v1",
        communityId: "c1",
        unitId: "u1",
        unitCode: "426-A",
        unitTower: null,
        unitType: "house",
        visitorName: "Juan Pérez",
        maxEntries: null,
        entryCount: 1,
        ...overrides,
    } as Visit;
}

describe("arrivalMessage", () => {
    it("llegada normal: nombra el domicilio por su tipo", () => {
        const message = arrivalMessage(visit());
        assert.equal(message.kind, "visit_arrived");
        assert.equal(message.title, "Llegó tu visita");
        assert.equal(message.body, "Juan Pérez entró por caseta y va a tu casa 426-A.");
        assert.equal(message.ttlSec, 3_600);
    });

    it("entrada que agota el pase: mismo título, avisa que ya no hay entradas", () => {
        const message = arrivalMessage(visit({ maxEntries: 1, entryCount: 1 }));
        assert.equal(message.kind, "visit_exhausted");
        assert.equal(message.title, "Llegó tu visita");
        assert.equal(
            message.body,
            "Juan Pérez entró y va a tu casa 426-A. Su pase ya no tiene entradas. Si va a volver, créale uno nuevo.",
        );
        assert.equal(message.ttlSec, 86_400);
    });

    it("con entradas restantes no es agotamiento", () => {
        assert.equal(isExhaustedByThisEntry(visit({ maxEntries: 3, entryCount: 2 })), false);
        assert.equal(arrivalMessage(visit({ maxEntries: 3, entryCount: 2 })).kind, "visit_arrived");
    });

    it("usa torre y tipo", () => {
        const message = arrivalMessage(
            visit({ unitType: "apartment", unitTower: "Torre B", unitCode: "302" }),
        );
        assert.match(message.body, /va a tu departamento Torre B 302\.$/);
    });
});

describe("departureMessage", () => {
    it("dice que salió, sin nombrar el domicilio", () => {
        assert.deepEqual(departureMessage(visit()), {
            kind: "visit_left",
            title: "Tu visita ya salió",
            body: "Juan Pérez salió por caseta.",
            ttlSec: 3_600,
        });
    });
});

describe("ningún aviso de caseta dice unidad", () => {
    it("en título ni en cuerpo", () => {
        const all = [
            arrivalMessage(visit()),
            arrivalMessage(visit({ maxEntries: 1 })),
            departureMessage(visit()),
        ];
        for (const message of all) {
            assert.doesNotMatch(`${message.title} ${message.body}`, /unidad/i);
        }
    });
});
