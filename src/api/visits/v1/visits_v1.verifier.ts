import { Verifiers as V } from "structure-verifier";
import {
    errorResponseV1V,
    ISO_DATE_REGEX,
    pageQueryFields,
} from "../../common/common_v1.verifier";

// Contratos del dominio `access`. El contrato del PASE es uno solo y lo
// comparten las dos superficies —la caseta y el portal— por la misma razón que
// el estado de cuenta comparte el suyo con reports: es la misma información con
// otra frontera de autorización, y dos contratos se separarían con el tiempo.

/** Hora del día sin zona (columnas TIME): HH:MM o HH:MM:SS. */
export const TIME_REGEX = /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/;

/** Código del pase: 8 símbolos Crockford base32 (sin I, L, O ni U). */
export const VISIT_CODE_REGEX = /^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{8}$/;

export const VISIT_TYPES = ["guest", "service", "delivery", "other", "event"] as const;
export const SCHEDULE_TYPES = ["single", "period", "recurring"] as const;
/** Política de reingreso POR PASE. Solo `strict` cambia el veredicto. */
export const ACCESS_MODES = ["free", "normal", "strict"] as const;
export const VISIT_STATES = [
    "active",
    "scheduled",
    "expired",
    "exhausted",
    "cancelled",
] as const;

// --- Salida: un pase ----------------------------------------------------------
export const visitV1V = new V.ObjectNotNull({
    id: new V.StringNotNull(),
    communityId: new V.StringNotNull(),
    unitId: new V.StringNotNull(),
    unitCode: new V.StringNotNull(),
    unitTower: new V.String(),
    /** Persona del padrón que emitió el pase (quién autorizó la visita). */
    memberId: new V.StringNotNull(),
    memberName: new V.StringNotNull(),
    /** El secreto que abre la puerta; la SPA lo vuelve QR. */
    code: new V.StringNotNull(),
    visitType: new V.StringNotNull(),
    scheduleType: new V.StringNotNull(),
    /** ETIQUETA sin verificar del visitante esperado; nunca decide el acceso. */
    visitorName: new V.StringNotNull(),
    visitorCompany: new V.String(),
    visitorPhone: new V.String(),
    vehiclePlate: new V.String(),
    companions: new V.NumberNotNull(),
    validFrom: new V.StringNotNull(),
    validTo: new V.StringNotNull(),
    timeFrom: new V.String(),
    timeTo: new V.String(),
    /** Días ISO permitidos (1 = lunes … 7 = domingo). Vacío salvo recurrentes. */
    weekdays: new V.ArrayNotNull(new V.NumberNotNull()),
    maxEntries: new V.Number(),
    /** Política de reingreso: free | normal | strict. */
    accessMode: new V.StringNotNull(),
    requiresId: new V.BooleanNotNull(),
    notes: new V.String(),
    /** Lo DECIDIDO: active | cancelled. */
    visitStatus: new V.StringNotNull(),
    /** Lo DERIVADO: active | scheduled | expired | exhausted | cancelled. */
    state: new V.StringNotNull(),
    entryCount: new V.NumberNotNull(),
    lastEntryAt: new V.String(),
    /** El último movimiento fue una entrada: hay una entrada sin su salida. */
    openEntry: new V.BooleanNotNull(),
    createdAt: new V.StringNotNull(),
    updatedAt: new V.StringNotNull(),
});

export const visitListV1V = new V.ObjectNotNull({
    items: new V.ArrayNotNull(visitV1V),
    total: new V.NumberNotNull(),
    page: new V.NumberNotNull(),
    pageSize: new V.NumberNotNull(),
});

// --- Salida: el veredicto de la caseta ---------------------------------------
// `valid` es lo único que el guardia necesita para decidir; `reason` es lo que
// necesita para EXPLICAR. Se devuelven juntos y el pase completo va al lado:
// un pase cancelado se muestra, no se esconde detrás de un 404.
export const visitVerdictV1V = new V.ObjectNotNull({
    visit: visitV1V,
    valid: new V.BooleanNotNull(),
    /** ok | cancelled | not_yet_valid | expired | wrong_weekday |
     *  out_of_window | already_inside | exhausted | unit_inactive |
     *  member_inactive */
    reason: new V.StringNotNull(),
    /** Zona con la que se evaluaron el día y la ventana horaria (DB_TIMEZONE). */
    timezone: new V.StringNotNull(),
    /**
     * Teléfono de quien emitió el pase, SOLO cuando el veredicto es
     * `already_inside`: es el momento en que el guardia necesita llamar para
     * aclarar, y el único en que se expone. En cualquier otro veredicto viaja
     * null aunque el miembro tenga teléfono.
     */
    memberPhone: new V.String(),
});

// --- Salida: un evento de la bitácora ----------------------------------------
export const visitEventV1V = new V.ObjectNotNull({
    id: new V.StringNotNull(),
    visitId: new V.String(),
    unitId: new V.StringNotNull(),
    unitCode: new V.StringNotNull(),
    eventType: new V.StringNotNull(),
    occurredAt: new V.StringNotNull(),
    source: new V.StringNotNull(),
    gate: new V.String(),
    visitorName: new V.String(),
    visitorDocument: new V.String(),
    companions: new V.Number(),
    vehiclePlate: new V.String(),
    notes: new V.String(),
    /** Nombre del usuario que lo registró (espejo core.users); NULL si fue un
     *  dispositivo. NO es un campo capturado: sale de created_by. */
    recordedBy: new V.String(),
});

export const visitDetailV1V = new V.ObjectNotNull({
    visit: visitV1V,
    events: new V.ArrayNotNull(visitEventV1V),
});

// --- Entrada: listar pases de la comunidad -----------------------------------
export const listVisitsQueryV1V = new V.ObjectNotNull(
    {
        ...pageQueryFields(),
        unitId: new V.String(),
        /** Busca por nombre/empresa del visitante, código exacto o unidad. */
        search: new V.String({ maxLength: 100 }),
        state: new V.String({ in: [...VISIT_STATES] }),
        visitType: new V.String({ in: [...VISIT_TYPES] }),
    },
    { strictMode: true },
);

// --- Entrada: resolver un código en caseta -----------------------------------
export const visitCodeParamV1V = new V.ObjectNotNull(
    {
        communityId: new V.StringNotNull({
            regex: /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/,
        }),
        // Sin regex de formato a propósito: el guardia teclea, y un código mal
        // escrito debe responder "no existe" (404) igual que uno inventado —
        // un 400 de validación le diría que el formato correcto es otro.
        code: new V.StringNotNull({ minLength: 1, maxLength: 32 }),
    },
    { strictMode: true },
);

// --- Entrada: registrar la entrada -------------------------------------------
// Todo opcional: en caseta lo normal es un toque al botón. Lo que se captura
// aquí (y no en el pase) es lo que un humano SÍ verificó al abrir.
export const checkInVisitV1V = new V.ObjectNotNull(
    {
        /** Quién llegó de verdad. Si no viene, hereda la etiqueta del pase. */
        visitorName: new V.String({ maxLength: 150 }),
        /** Identificación cotejada; solo tiene sentido si alguien la miró. */
        visitorDocument: new V.String({ maxLength: 60 }),
        companions: new V.Number({ min: 0, max: 99, maxDecimalPlaces: 0 }),
        vehiclePlate: new V.String({ maxLength: 20 }),
        gate: new V.String({ maxLength: 60 }),
        notes: new V.String({ maxLength: 500 }),
    },
    { strictMode: true },
);

// --- Entrada: registrar la salida --------------------------------------------
// Mucho más corto que el check-in, y a propósito: quién sale, con cuántos y en
// qué coche ya se capturó al ENTRAR, y el servidor lo copia del propio evento
// de entrada. Volver a preguntarlo sería invitar a que las dos mitades del
// mismo paso por la caseta se contradigan.
export const checkOutVisitV1V = new V.ObjectNotNull(
    {
        gate: new V.String({ maxLength: 60 }),
        notes: new V.String({ maxLength: 500 }),
    },
    { strictMode: true },
);

// --- Entrada: registrar un pase (portal del residente) -----------------------
// El cuerpo NO trae comunidad ni miembro: los deriva el servidor de la unidad y
// del usuario del token. Traerlos sería dejar que el cliente declare su propio
// alcance.
export const createVisitV1V = new V.ObjectNotNull(
    {
        unitId: new V.StringNotNull({
            regex: /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/,
        }),
        visitType: new V.String({ in: [...VISIT_TYPES], defaultValue: "guest" }),
        scheduleType: new V.String({ in: [...SCHEDULE_TYPES], defaultValue: "single" }),
        visitorName: new V.StringNotNull({ minLength: 1, maxLength: 150 }),
        visitorCompany: new V.String({ maxLength: 150 }),
        visitorPhone: new V.String({ maxLength: 30 }),
        vehiclePlate: new V.String({ maxLength: 20 }),
        companions: new V.Number({ min: 0, max: 99, maxDecimalPlaces: 0, defaultValue: 0 }),
        validFrom: new V.StringNotNull({ regex: ISO_DATE_REGEX }),
        /** Si falta, el pase dura un solo día (el caso mayoritario). */
        validTo: new V.String({ regex: ISO_DATE_REGEX }),
        timeFrom: new V.String({ regex: TIME_REGEX }),
        timeTo: new V.String({ regex: TIME_REGEX }),
        /** Días ISO (1 = lunes … 7 = domingo). Obligatorio si es recurrente. */
        weekdays: new V.Array(new V.NumberNotNull({ min: 1, max: 7, maxDecimalPlaces: 0 })),
        /** Tope de entradas. Por defecto NULL = sin tope dentro de la vigencia. */
        maxEntries: new V.Number({ min: 1, max: 999, maxDecimalPlaces: 0 }),
        /** Política de reingreso. `normal` = el comportamiento de siempre. */
        accessMode: new V.String({ in: [...ACCESS_MODES], defaultValue: "normal" }),
        requiresId: new V.Boolean({ defaultValue: false }),
        notes: new V.String({ maxLength: 500 }),
    },
    { strictMode: true },
);

// --- Entrada: listar MIS pases ------------------------------------------------
export const listMyVisitsQueryV1V = new V.ObjectNotNull(
    {
        ...pageQueryFields(),
        unitId: new V.String(),
        state: new V.String({ in: [...VISIT_STATES] }),
    },
    { strictMode: true },
);

export { errorResponseV1V };
