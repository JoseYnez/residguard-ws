// Traducción de errores esperables de PostgreSQL a resultados tipados: los
// constraints (uq_*/ck_*/ex_*/fk_*) y las excepciones de los procedures son
// la última línea de validación; el servicio las convierte en respuestas de
// negocio y NUNCA deja burbujear el mensaje crudo al cliente.

export type BusinessError =
    | { readonly kind: "conflict"; readonly message: string }
    | { readonly kind: "invalid"; readonly message: string };

export type MutationResult<T> =
    | { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly error: BusinessError };

interface PgError {
    code?: string;
}

export function asPgError(err: unknown): PgError | null {
    if (typeof err === "object" && err !== null && "code" in err) {
        return err as PgError;
    }
    return null;
}

/** Mensajes de negocio por clase de error; lo no mapeado se relanza (→ 500). */
export interface PgErrorMessages {
    /** 23505 unique_violation. */
    readonly conflict?: string;
    /** 23P01 exclusion_violation (rangos solapados). */
    readonly overlap?: string;
    /** 23503 foreign_key_violation (referencia inexistente o de otro alcance). */
    readonly reference?: string;
    /** 23514 check_violation. */
    readonly check?: string;
    /** P0002 no_data_found (procedures: registro inexistente para el tenant). */
    readonly notFound?: string;
}

export function translatePgError(err: unknown, messages: PgErrorMessages): BusinessError {
    const pg = asPgError(err);
    if (pg?.code === "23505" && messages.conflict !== undefined) {
        return { kind: "conflict", message: messages.conflict };
    }
    if (pg?.code === "23P01" && messages.overlap !== undefined) {
        return { kind: "conflict", message: messages.overlap };
    }
    if (pg?.code === "23503" && messages.reference !== undefined) {
        return { kind: "invalid", message: messages.reference };
    }
    if (pg?.code === "23514" && messages.check !== undefined) {
        return { kind: "invalid", message: messages.check };
    }
    if (pg?.code === "P0002" && messages.notFound !== undefined) {
        return { kind: "invalid", message: messages.notFound };
    }
    throw err;
}
