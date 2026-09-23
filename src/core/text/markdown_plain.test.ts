import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { markdownToPlain, plainExcerpt } from "./markdown_plain";

describe("markdownToPlain", () => {
    it("quita encabezados y colapsa los párrafos en una línea", () => {
        const source = "## Corte de agua\n\nEl **martes** no habrá agua.\n";
        assert.equal(markdownToPlain(source), "Corte de agua El martes no habrá agua.");
    });

    it("quita los marcadores de lista, con viñeta y numeradas", () => {
        const source = "- Cerrar llaves\n- Llenar tinacos\n\n1. Avisar\n2. Esperar";
        assert.equal(
            markdownToPlain(source),
            "Cerrar llaves Llenar tinacos Avisar Esperar",
        );
    });

    it("de un enlace seguro deja el texto, no la URL", () => {
        assert.equal(
            markdownToPlain("Ver el [reglamento](https://ejemplo.mx/r.pdf) completo"),
            "Ver el reglamento completo",
        );
    });

    it("un enlace con esquema raro pierde el envoltorio pero conserva lo escrito", () => {
        // No se "limpia" nada: esto es TEXTO, no HTML. Se muestra lo que el
        // autor escribió para que no desaparezca sin dejar rastro.
        assert.equal(
            markdownToPlain("[click](javascript:alert(1))"),
            "click javascript:alert(1)",
        );
    });

    it("cursiva y negrita anidadas quedan en texto llano", () => {
        assert.equal(markdownToPlain("**muy** *importante* y __esto__"), "muy importante y esto");
    });

    it("lo que no es markdown sale tal cual: no produce HTML ni lo escapa", () => {
        assert.equal(markdownToPlain("<script>alert(1)</script>"), "<script>alert(1)</script>");
    });

    it("texto vacío o solo espacios da cadena vacía", () => {
        assert.equal(markdownToPlain("   \n\n  "), "");
    });
});

describe("plainExcerpt", () => {
    it("deja intacto lo que cabe", () => {
        assert.equal(plainExcerpt("**Hola** a todos", 40), "Hola a todos");
    });

    it("corta en el último espacio y nunca pasa del tope", () => {
        const excerpt = plainExcerpt("Mantenimiento programado del elevador principal", 20);
        assert.equal(excerpt, "Mantenimiento…");
        assert.ok(excerpt.length <= 20);
    });

    it("una palabra más larga que el tope se corta donde toque", () => {
        const excerpt = plainExcerpt("Antidisestablishmentarianismo", 10);
        assert.equal(excerpt, "Antidises…");
        assert.ok(excerpt.length <= 10);
    });
});
