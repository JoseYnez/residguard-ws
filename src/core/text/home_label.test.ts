import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { homeLabel } from "./home_label";

describe("homeLabel", () => {
    it("nombra el domicilio por su tipo, en minúscula", () => {
        assert.equal(homeLabel({ unitType: "house", unitTower: null, unitCode: "426-A" }), "casa 426-A");
        assert.equal(homeLabel({ unitType: "lot", unitTower: null, unitCode: "15" }), "lote 15");
    });

    it("intercala la torre entre el tipo y el código", () => {
        assert.equal(
            homeLabel({ unitType: "apartment", unitTower: "Torre B", unitCode: "302" }),
            "departamento Torre B 302",
        );
    });

    it("cubre todos los tipos de community.unit_type", () => {
        const labels = ["apartment", "house", "lot", "commercial_local", "parking", "storage"].map(
            (unitType) => homeLabel({ unitType, unitTower: null, unitCode: "1" }),
        );
        assert.deepEqual(labels, [
            "departamento 1",
            "casa 1",
            "lote 1",
            "local comercial 1",
            "estacionamiento 1",
            "bodega 1",
        ]);
    });

    it("trata la torre vacía o en blanco como ausente", () => {
        assert.equal(homeLabel({ unitType: "house", unitTower: "", unitCode: "7" }), "casa 7");
        assert.equal(homeLabel({ unitType: "house", unitTower: "  ", unitCode: "7" }), "casa 7");
    });

    it("cae a domicilio con un tipo desconocido, nunca al código crudo", () => {
        assert.equal(homeLabel({ unitType: "penthouse", unitTower: null, unitCode: "9" }), "domicilio 9");
    });

    it("nunca dice unidad", () => {
        assert.doesNotMatch(homeLabel({ unitType: "x", unitTower: "T", unitCode: "1" }), /unidad/i);
    });
});
