// El cuerpo de un comunicado se guarda como MARKDOWN ACOTADO (negritas,
// cursivas, un encabezado, listas y enlaces). Este servicio nunca lo renderiza
// —eso es de la SPA— pero sí necesita su versión en TEXTO PLANO en dos lugares
// donde el formato no cabe:
//
//   * el cuerpo del aviso push (una línea en la pantalla bloqueada), y
//   * el extracto de dos renglones de la lista del portal.
//
// Por eso vive aquí y no en el notifier: la lista lo usa sin que haya push de
// por medio. Puro y sin dependencias, para poder probarlo sin red ni BD.
//
// NO es un sanitizador ni un renderer: no produce HTML, así que no hay nada que
// escapar. Si el texto trae `<script>`, sale tal cual —como TEXTO— y quien lo
// pinta decide (la SPA, con su propio renderer y el sanitizador de Angular
// detrás).

/** Lista blanca de esquemas en los enlaces; el resto pierde su envoltorio y
 *  queda como texto suelto, igual que en el renderer de la SPA. */
const SAFE_LINK = /^(https?:|mailto:)/i;

/**
 * Markdown acotado → texto plano en UNA línea.
 *
 * Quita los marcadores (`#`, `**`, `*`, `-`, `1.`), deja el TEXTO de los
 * enlaces (no la URL: en un push la URL es ruido, y el destino ya viaja en
 * `clickUrl`) y colapsa saltos y espacios. Los párrafos quedan separados por un
 * espacio: un salto de línea en una notificación no se ve, se pierde.
 */
export function markdownToPlain(source: string): string {
    return (
        source
            // Enlaces ANTES que el énfasis: `[**Reglamento**](url)` conserva su
            // texto y luego pierde los asteriscos como cualquier otro.
            .replace(/\[([^\]]*)\]\(([^)\s]*)[^)]*\)/g, (_match, text: string, url: string) =>
                SAFE_LINK.test(url) ? text : `${text} ${url}`.trim(),
            )
            // Encabezados y marcadores de lista, siempre al inicio de renglón.
            .replace(/^[ \t]*#{1,6}[ \t]+/gm, "")
            .replace(/^[ \t]*(?:[-*+]|\d+[.)])[ \t]+/gm, "")
            // Énfasis: primero el doble, si no `**x**` dejaría un `*x*` suelto.
            .replace(/\*\*([^*]+)\*\*/g, "$1")
            .replace(/__([^_]+)__/g, "$1")
            .replace(/\*([^*]+)\*/g, "$1")
            .replace(/_([^_]+)_/g, "$1")
            // Todo el espacio en blanco (incluidos los saltos) a un solo espacio.
            .replace(/\s+/g, " ")
            .trim()
    );
}

/**
 * Extracto de `maxLength` caracteres como máximo, cortado en el último espacio
 * para no partir una palabra, con puntos suspensivos si sobró texto.
 *
 * El corte cuenta el carácter `…` dentro del tope: lo que sale de aquí nunca
 * pasa de `maxLength`, que es lo que necesita quien lo mete en un push.
 */
export function plainExcerpt(source: string, maxLength: number): string {
    const plain = markdownToPlain(source);
    if (plain.length <= maxLength) {
        return plain;
    }
    const clipped = plain.slice(0, maxLength - 1);
    const lastSpace = clipped.lastIndexOf(" ");
    // Sin espacios (una palabra larguísima, una URL): se corta donde toque.
    const cut = lastSpace > 0 ? clipped.slice(0, lastSpace) : clipped;
    return `${cut.trimEnd()}…`;
}
