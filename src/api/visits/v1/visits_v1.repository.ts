import { randomBytes } from "node:crypto";
import type { TxClient } from "../../../core/db/with_transaction";

// Acceso a datos del dominio `access`: el pase pre-registrado (access.visits) y
// la bitácora de caseta (access.visit_events).
//
// Este archivo es el NÚCLEO del dominio y lo consumen DOS superficies con
// fronteras de autorización distintas: `visits/v1` (operación y caseta, alcance
// por comunidad) y `me/v1` (el portal, alcance por el vínculo del padrón). La
// información es la misma; lo que cambia es quién puede pedirla — mismo patrón
// que reports ↔ me para el estado de cuenta.
//
// DOS COSAS QUE NUNCA SE ALMACENAN:
//   * el conteo de entradas → access.fn_get_visit_entry_count(id)
//   * el estado derivado (vencido/agotado/programado) → se calcula en el SELECT
// Ambos contra CURRENT_DATE/LOCALTIME, que la sesión evalúa en DB_TIMEZONE (la
// zona de operación de la comunidad, no la del equipo que consulta).

// --- El código del pase -------------------------------------------------------
// Alfabeto Crockford base32: los 32 símbolos sin I, L, O ni U — no se confunden
// al leerlos ni al dictarlos por teléfono, y no forman palabras accidentales.
// 32 divide exacto a 256, así que `byte % 32` es uniforme sin sesgo ni rechazo.
const CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const CODE_LENGTH = 8;

/** 8 símbolos ≈ 40 bits (1.1e12 combinaciones): no se adivina a fuerza bruta. */
export function generateVisitCode(): string {
    const bytes = randomBytes(CODE_LENGTH);
    let code = "";
    for (const byte of bytes) {
        code += CODE_ALPHABET[byte % CODE_ALPHABET.length];
    }
    return code;
}

// --- Tipos --------------------------------------------------------------------

/** Estado DERIVADO del pase (nada de esto vive en una columna). */
export type VisitState = "active" | "scheduled" | "expired" | "exhausted" | "cancelled";

/**
 * Veredicto de la caseta ante un código. `ok` es el único que abre; el resto
 * son razones NOMBRADAS a propósito: el guardia necesita saber POR QUÉ no pasa
 * (un 404 lo dejaría adivinando), y cada razón tiene una respuesta distinta
 * —"llama al residente", "vuelve el lunes", "ya entró"—.
 */
export type VisitVerdict =
    | "ok"
    | "cancelled"
    | "not_yet_valid"
    | "expired"
    | "wrong_weekday"
    | "out_of_window"
    | "exhausted"
    | "unit_inactive"
    | "member_inactive";

export interface Visit {
    readonly id: string;
    readonly communityId: string;
    readonly unitId: string;
    readonly unitCode: string;
    readonly unitTower: string | null;
    readonly memberId: string;
    readonly memberName: string;
    readonly code: string;
    readonly visitType: string;
    readonly scheduleType: string;
    readonly visitorName: string;
    readonly visitorCompany: string | null;
    readonly visitorPhone: string | null;
    readonly vehiclePlate: string | null;
    readonly companions: number;
    readonly validFrom: string;
    readonly validTo: string;
    readonly timeFrom: string | null;
    readonly timeTo: string | null;
    /** Días ISO permitidos (1 = lunes … 7 = domingo). Vacío salvo recurrentes.
     *  Mutable a propósito: el serializador de structure-verifier no acepta un
     *  `readonly` array, y esta es la forma de salida. */
    readonly weekdays: number[];
    readonly maxEntries: number | null;
    readonly requiresId: boolean;
    readonly notes: string | null;
    readonly visitStatus: string;
    readonly state: VisitState;
    readonly entryCount: number;
    readonly lastEntryAt: string | null;
    readonly createdAt: string;
    readonly updatedAt: string;
}

export interface VisitEvent {
    readonly id: string;
    readonly visitId: string | null;
    readonly unitId: string;
    readonly unitCode: string;
    readonly eventType: string;
    readonly occurredAt: string;
    readonly source: string;
    readonly gate: string | null;
    readonly visitorName: string | null;
    readonly visitorDocument: string | null;
    readonly companions: number | null;
    readonly vehiclePlate: string | null;
    readonly notes: string | null;
    /** Nombre del usuario que lo registró; NULL en eventos de dispositivo. */
    readonly recordedBy: string | null;
}

export interface CreateVisitInput {
    readonly unitId: string;
    readonly memberId: string;
    readonly visitType: string;
    readonly scheduleType: string;
    readonly visitorName: string;
    readonly visitorCompany: string | null;
    readonly visitorPhone: string | null;
    readonly vehiclePlate: string | null;
    readonly companions: number;
    readonly validFrom: string;
    readonly validTo: string;
    readonly timeFrom: string | null;
    readonly timeTo: string | null;
    readonly weekdays: readonly number[];
    readonly maxEntries: number | null;
    readonly requiresId: boolean;
    readonly notes: string | null;
}

// --- Días de la semana: bitmask ↔ arreglo ------------------------------------
// En BD es un SMALLINT (bit dow-1) porque así el CHECK "un recurrente sin días
// no existe" es una comparación; hacia fuera es un arreglo de días ISO, que es
// lo que un cliente puede pintar sin decodificar nada.

export function weekdaysToMask(weekdays: readonly number[]): number {
    return weekdays.reduce((mask, dow) => mask | (1 << (dow - 1)), 0);
}

export function maskToWeekdays(mask: number): number[] {
    const days: number[] = [];
    for (let dow = 1; dow <= 7; dow += 1) {
        if ((mask & (1 << (dow - 1))) !== 0) {
            days.push(dow);
        }
    }
    return days;
}

// --- Proyección compartida ----------------------------------------------------

/** Fila cruda de la proyección compartida. Exportada para `me/v1`, que arma su
 *  propio WHERE (la cadena del padrón) sobre las MISMAS columnas. */
export interface VisitRow {
    id: string;
    community_id: string;
    unit_id: string;
    unit_code: string;
    unit_tower: string | null;
    member_id: string;
    member_name: string;
    code: string;
    visit_type: string;
    schedule_type: string;
    visitor_name: string;
    visitor_company: string | null;
    visitor_phone: string | null;
    vehicle_plate: string | null;
    companions: number;
    valid_from: string;
    valid_to: string;
    time_from: string | null;
    time_to: string | null;
    weekdays_mask: number;
    max_entries: number | null;
    requires_id: boolean;
    notes: string | null;
    visit_status: string;
    state: VisitState;
    entry_count: number;
    last_entry_at: Date | null;
    created_at: Date;
    updated_at: Date;
}

// Orden de precedencia deliberado: lo DECIDIDO (cancelado) manda sobre lo
// derivado, y vencido manda sobre agotado — un pase agotado hace meses se lee
// mejor como "venció" que como "se acabaron las entradas".
export const VISIT_STATE_EXPR = `
  CASE
    WHEN v.visit_status = 'cancelled'                     THEN 'cancelled'
    WHEN CURRENT_DATE   > v.valid_to                      THEN 'expired'
    WHEN v.max_entries IS NOT NULL
     AND access.fn_get_visit_entry_count(v.id) >= v.max_entries THEN 'exhausted'
    WHEN CURRENT_DATE   < v.valid_from                    THEN 'scheduled'
    ELSE 'active'
  END
`;

// DATE y TIME salen con ::text para que lleguen tal cual (YYYY-MM-DD / HH:MM:SS)
// y no pasen por el parser de fechas de pg, que los volvería un Date con la
// zona del proceso — justo el desfase que la zona de operación evita.
export const VISIT_COLUMNS = `
  v.id, v.community_id, v.unit_id, u.code AS unit_code, u.tower AS unit_tower,
  v.member_id, m.full_name AS member_name,
  v.code, v.visit_type::text, v.schedule_type::text,
  v.visitor_name, v.visitor_company, v.visitor_phone, v.vehicle_plate, v.companions,
  v.valid_from::text, v.valid_to::text,
  v.time_from::text, v.time_to::text,
  v.weekdays_mask, v.max_entries, v.requires_id, v.notes,
  v.visit_status::text,
  ${VISIT_STATE_EXPR} AS state,
  access.fn_get_visit_entry_count(v.id) AS entry_count,
  (SELECT max(e.occurred_at)
     FROM access.visit_events e
    WHERE e.visit_id = v.id AND e.event_type = 'check_in' AND e.status = 'active'
  ) AS last_entry_at,
  v.created_at, v.updated_at
`;

export const VISIT_FROM = `
  FROM access.visits v
  JOIN community.units   u ON u.id = v.unit_id
  JOIN community.members m ON m.id = v.member_id
`;

export function mapVisit(row: VisitRow): Visit {
    return {
        id: row.id,
        communityId: row.community_id,
        unitId: row.unit_id,
        unitCode: row.unit_code,
        unitTower: row.unit_tower,
        memberId: row.member_id,
        memberName: row.member_name,
        code: row.code,
        visitType: row.visit_type,
        scheduleType: row.schedule_type,
        visitorName: row.visitor_name,
        visitorCompany: row.visitor_company,
        visitorPhone: row.visitor_phone,
        vehiclePlate: row.vehicle_plate,
        companions: row.companions,
        validFrom: row.valid_from,
        validTo: row.valid_to,
        timeFrom: row.time_from,
        timeTo: row.time_to,
        weekdays: maskToWeekdays(row.weekdays_mask),
        maxEntries: row.max_entries,
        requiresId: row.requires_id,
        notes: row.notes,
        visitStatus: row.visit_status,
        state: row.state,
        entryCount: Number(row.entry_count),
        lastEntryAt: row.last_entry_at?.toISOString() ?? null,
        createdAt: row.created_at.toISOString(),
        updatedAt: row.updated_at.toISOString(),
    };
}

export interface VisitWithVerdict {
    readonly visit: Visit;
    readonly verdict: VisitVerdict;
}

/**
 * El pase MÁS su veredicto AHORA. Una sola definición del "¿puede pasar?", que
 * usan la consulta de caseta (por código) y el check-in (por id, con el pase ya
 * bloqueado): si vivieran en dos consultas, tarde o temprano una diría que sí y
 * la otra que no.
 *
 * El orden de los WHEN es el orden en que un guardia lo explicaría, y no es
 * negociable: lo DECIDIDO primero (cancelado), luego lo que rompe la cadena
 * (unidad o persona dadas de baja — un pase no sobrevive a la mudanza de quien
 * lo emitió), luego la vigencia, el día, el horario y por último el tope.
 *
 * `$1` es siempre la comunidad y `$2` el valor del filtro.
 */
async function evaluateVisit(
    tx: TxClient,
    communityId: string,
    filterSql: string,
    filterValue: string,
): Promise<VisitWithVerdict | null> {
    const result = await tx.query<VisitRow & { verdict: VisitVerdict }>(
        `SELECT ${VISIT_COLUMNS},
                CASE
                  WHEN v.visit_status = 'cancelled' THEN 'cancelled'
                  WHEN u.status <> 'active'         THEN 'unit_inactive'
                  WHEN m.status <> 'active'         THEN 'member_inactive'
                  WHEN CURRENT_DATE < v.valid_from  THEN 'not_yet_valid'
                  WHEN CURRENT_DATE > v.valid_to    THEN 'expired'
                  WHEN v.schedule_type = 'recurring'
                   AND (v.weekdays_mask::int & (1 << (EXTRACT(ISODOW FROM CURRENT_DATE)::int - 1))) = 0
                                                    THEN 'wrong_weekday'
                  WHEN v.time_from IS NOT NULL
                   AND (LOCALTIME < v.time_from OR LOCALTIME > v.time_to)
                                                    THEN 'out_of_window'
                  WHEN v.max_entries IS NOT NULL
                   AND access.fn_get_visit_entry_count(v.id) >= v.max_entries
                                                    THEN 'exhausted'
                  ELSE 'ok'
                END AS verdict
           ${VISIT_FROM}
          WHERE v.community_id = $1 AND ${filterSql} AND v.status <> 'deleted'`,
        [communityId, filterValue],
    );
    const row = result.rows[0];
    if (row === undefined) {
        return null;
    }
    return { visit: mapVisit(row), verdict: row.verdict };
}

export interface ListVisitsInput {
    readonly communityId: string;
    readonly page: number;
    readonly pageSize: number;
    readonly unitId?: string | null;
    readonly search?: string | null;
    readonly state?: string | null;
    readonly visitType?: string | null;
}

export const visitsRepository = {
    /**
     * Bitácora de pases de una comunidad. `state` filtra por el estado DERIVADO
     * (el mismo CASE del SELECT, repetido en el WHERE porque un alias de
     * proyección no es referenciable ahí).
     */
    async list(
        tx: TxClient,
        input: ListVisitsInput,
    ): Promise<{ items: Visit[]; total: number }> {
        const params = [
            input.communityId,
            input.unitId ?? null,
            input.search ?? null,
            input.state ?? null,
            input.visitType ?? null,
        ];
        const where = `
          WHERE v.community_id = $1
            AND v.status <> 'deleted'
            AND ($2::uuid IS NULL OR v.unit_id = $2::uuid)
            AND ($3::text IS NULL OR v.visitor_name ILIKE '%' || $3 || '%'
                                  OR v.visitor_company ILIKE '%' || $3 || '%'
                                  OR v.code = upper($3)
                                  OR u.code ILIKE '%' || $3 || '%')
            AND ($4::text IS NULL OR (${VISIT_STATE_EXPR}) = $4::text)
            AND ($5::text IS NULL OR v.visit_type::text = $5::text)
        `;

        const totalResult = await tx.query<{ count: string }>(
            `SELECT count(*)::bigint AS count ${VISIT_FROM} ${where}`,
            params,
        );
        const total = Number(totalResult.rows[0]?.count ?? 0);

        const itemsResult = await tx.query<VisitRow>(
            `SELECT ${VISIT_COLUMNS} ${VISIT_FROM} ${where}
              ORDER BY v.valid_from DESC, v.created_at DESC
              LIMIT $6 OFFSET $7`,
            [...params, input.pageSize, (input.page - 1) * input.pageSize],
        );

        return { items: itemsResult.rows.map(mapVisit), total };
    },

    async getById(tx: TxClient, communityId: string, id: string): Promise<Visit | null> {
        const result = await tx.query<VisitRow>(
            `SELECT ${VISIT_COLUMNS} ${VISIT_FROM}
              WHERE v.id = $1 AND v.community_id = $2 AND v.status <> 'deleted'`,
            [id, communityId],
        );
        const row = result.rows[0];
        return row === undefined ? null : mapVisit(row);
    },

    /**
     * Resuelve un código en caseta. Devuelve el pase MÁS el veredicto: un pase
     * cancelado o vencido SÍ se devuelve (con su razón) porque el guardia tiene
     * que poder explicarle al visitante qué pasó. Solo el código inexistente es
     * un 404.
     *
     * La búsqueda es por (comunidad, código) y NO exige `v.status <> 'deleted'`
     * en el veredicto: un pase borrado sí desaparece (queda fuera del WHERE),
     * que es lo correcto — el borrado lógico es de la administración.
     */
    async findByCode(
        tx: TxClient,
        communityId: string,
        code: string,
    ): Promise<VisitWithVerdict | null> {
        return evaluateVisit(tx, communityId, "v.code = $2", code.trim().toUpperCase());
    },

    /**
     * Registra la ENTRADA de un visitante. Vía sancionada, en tres pasos dentro
     * de la misma transacción:
     *   1. bloquea el pase (`FOR UPDATE`),
     *   2. RE-EVALÚA el veredicto con el lock puesto,
     *   3. inserta el evento.
     *
     * El lock es lo que impide que dos escaneos simultáneos rebasen max_entries
     * (mismo criterio que el tope de las condonaciones): sin él, ambos leerían
     * "queda 1" antes de que ninguno inserte. Y NUNCA se confía en el veredicto
     * que el guardia vio en pantalla: entre la consulta y el toque al botón el
     * residente pudo cancelar.
     */
    async checkIn(
        tx: TxClient,
        communityId: string,
        visitId: string,
        input: {
            readonly visitorName: string | null;
            readonly visitorDocument: string | null;
            readonly companions: number | null;
            readonly vehiclePlate: string | null;
            readonly gate: string | null;
            readonly notes: string | null;
        },
    ): Promise<VisitWithVerdict | null> {
        const locked = await tx.query<{ id: string }>(
            `SELECT v.id
               FROM access.visits v
              WHERE v.id = $1 AND v.community_id = $2 AND v.status <> 'deleted'
              FOR UPDATE OF v`,
            [visitId, communityId],
        );
        if (locked.rows[0] === undefined) {
            return null;
        }

        const revalidated = await evaluateVisit(tx, communityId, "v.id = $2", visitId);
        if (revalidated === null) {
            return null;
        }
        if (revalidated.verdict !== "ok") {
            return revalidated;
        }

        await tx.query(
            `INSERT INTO access.visit_events (
                 customer_id, community_id, visit_id, unit_id,
                 event_type, source, gate,
                 visitor_name, visitor_document, companions, vehicle_plate, notes
             )
             SELECT v.customer_id, v.community_id, v.id, v.unit_id,
                    'check_in', 'gate', $3,
                    COALESCE($4, v.visitor_name), $5, COALESCE($6, v.companions), $7, $8
               FROM access.visits v
              WHERE v.id = $1 AND v.community_id = $2`,
            [
                visitId,
                communityId,
                input.gate,
                input.visitorName,
                input.visitorDocument,
                input.companions,
                input.vehiclePlate,
                input.notes,
            ],
        );

        // Relectura tras el INSERT: el conteo de entradas y el estado derivado
        // acaban de cambiar, y el cliente pinta el resultado del check-in.
        const after = await evaluateVisit(tx, communityId, "v.id = $2", visitId);
        return after;
    },

    /** Eventos de un pase, del más reciente al más antiguo. */
    async listEvents(tx: TxClient, communityId: string, visitId: string): Promise<VisitEvent[]> {
        const result = await tx.query<{
            id: string;
            visit_id: string | null;
            unit_id: string;
            unit_code: string;
            event_type: string;
            occurred_at: Date;
            source: string;
            gate: string | null;
            visitor_name: string | null;
            visitor_document: string | null;
            companions: number | null;
            vehicle_plate: string | null;
            notes: string | null;
            recorded_by: string | null;
        }>(
            // El usuario que registró NO es un campo capturado: sale de
            // created_by (que el trigger llena desde audit.user_id) contra el
            // espejo core.users. Un LEFT JOIN porque los eventos de dispositivo
            // no tienen usuario detrás.
            `SELECT e.id, e.visit_id, e.unit_id, u.code AS unit_code,
                    e.event_type::text, e.occurred_at, e.source::text, e.gate,
                    e.visitor_name, e.visitor_document, e.companions, e.vehicle_plate, e.notes,
                    cu.full_name AS recorded_by
               FROM access.visit_events e
               JOIN community.units u ON u.id = e.unit_id
               LEFT JOIN core.users cu ON cu.id = e.created_by AND cu.customer_id = e.customer_id
              WHERE e.visit_id = $1 AND e.community_id = $2 AND e.status = 'active'
              ORDER BY e.occurred_at DESC`,
            [visitId, communityId],
        );
        return result.rows.map((row) => ({
            id: row.id,
            visitId: row.visit_id,
            unitId: row.unit_id,
            unitCode: row.unit_code,
            eventType: row.event_type,
            occurredAt: row.occurred_at.toISOString(),
            source: row.source,
            gate: row.gate,
            visitorName: row.visitor_name,
            visitorDocument: row.visitor_document,
            companions: row.companions,
            vehiclePlate: row.vehicle_plate,
            notes: row.notes,
            recordedBy: row.recorded_by,
        }));
    },

    /**
     * Inserta un pase con código generado. El código se sortea aquí y no en la
     * BD porque el único escritor es este servicio; ante la (improbable)
     * colisión con `uq_visits_customer_code` se reintenta bajo SAVEPOINT — sin
     * él, el 23505 abortaría la transacción entera y el reintento sería inútil.
     */
    async create(
        tx: TxClient,
        customerId: string,
        communityId: string,
        input: CreateVisitInput,
    ): Promise<Visit> {
        const params = (code: string): unknown[] => [
            customerId,
            communityId,
            input.unitId,
            input.memberId,
            code,
            input.visitType,
            input.scheduleType,
            input.visitorName,
            input.visitorCompany,
            input.visitorPhone,
            input.vehiclePlate,
            input.companions,
            input.validFrom,
            input.validTo,
            input.timeFrom,
            input.timeTo,
            weekdaysToMask(input.weekdays),
            input.maxEntries,
            input.requiresId,
            input.notes,
        ];

        const sql = `
          INSERT INTO access.visits (
              customer_id, community_id, unit_id, member_id, code,
              visit_type, schedule_type,
              visitor_name, visitor_company, visitor_phone, vehicle_plate, companions,
              valid_from, valid_to, time_from, time_to, weekdays_mask,
              max_entries, requires_id, notes
          )
          VALUES ($1, $2, $3, $4, $5,
                  $6::access.visit_type, $7::access.schedule_type,
                  $8, $9, $10, $11, $12,
                  $13::date, $14::date, $15::time, $16::time, $17,
                  $18, $19, $20)
          RETURNING id`;

        const MAX_ATTEMPTS = 5;
        for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
            const code = generateVisitCode();
            await tx.query("SAVEPOINT visit_code");
            try {
                const inserted = await tx.query<{ id: string }>(sql, params(code));
                await tx.query("RELEASE SAVEPOINT visit_code");
                const created = await this.getById(tx, communityId, inserted.rows[0]!.id);
                return created!;
            } catch (err) {
                await tx.query("ROLLBACK TO SAVEPOINT visit_code");
                const isCodeCollision =
                    typeof err === "object" &&
                    err !== null &&
                    (err as { code?: string }).code === "23505" &&
                    (err as { constraint?: string }).constraint === "uq_visits_customer_code";
                if (!isCodeCollision || attempt === MAX_ATTEMPTS) {
                    throw err;
                }
            }
        }
        // Inalcanzable: el bucle sale por return o por throw.
        throw new Error("no se pudo generar un código de visita único");
    },

    /**
     * Cancela un pase (visit_status='cancelled'). NO es soft delete: un pase
     * cancelado tiene que seguir apareciendo por su código para que la caseta
     * pueda decir "cancelado" en vez de "no existe". Devuelve null si no
     * existe; el pase ya cancelado se devuelve tal cual (idempotente).
     */
    async cancel(tx: TxClient, communityId: string, visitId: string): Promise<Visit | null> {
        const result = await tx.query<{ id: string }>(
            `UPDATE access.visits
                SET visit_status = 'cancelled'
              WHERE id = $1 AND community_id = $2 AND status <> 'deleted'
              RETURNING id`,
            [visitId, communityId],
        );
        if (result.rows[0] === undefined) {
            return null;
        }
        return this.getById(tx, communityId, visitId);
    },

    /** Pases vigentes de una unidad — el tope anti-abuso del alta. */
    async countActiveForUnit(tx: TxClient, unitId: string): Promise<number> {
        const result = await tx.query<{ count: string }>(
            `SELECT count(*)::bigint AS count
               FROM access.visits v
              WHERE v.unit_id      = $1
                AND v.status       <> 'deleted'
                AND v.visit_status = 'active'
                AND v.valid_to     >= CURRENT_DATE`,
            [unitId],
        );
        return Number(result.rows[0]?.count ?? 0);
    },
};
