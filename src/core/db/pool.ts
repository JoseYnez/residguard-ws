import { Pool } from "pg";
import { config } from "../../config";

/**
 * Privado de core/db: SOLO with_transaction.ts puede importarlo (y server.ts
 * para el cierre ordenado vía closePool). El resto del servicio recibe `tx`
 * dentro de withTransaction — nunca el pool (sin contexto de auditoría/tenant
 * no hay SQL).
 */
export const pool = new Pool({
    connectionString: config.databaseUrl,
    max: 10,
    // Falla rápido si la BD no acepta conexiones, en vez de colgar el request.
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
});

// Sin este listener, un error en un cliente OCIOSO (restart/failover de
// Postgres, corte de red) emite 'error' sin manejador y TUMBA el proceso.
// Con él, el cliente roto se descarta y el pool crea conexiones nuevas.
pool.on("error", (err) => {
    // eslint-disable-next-line no-console
    console.error("[pool] error en cliente idle de PostgreSQL:", err.message);
});

/** Cierre ordenado del pool (shutdown del proceso). */
export async function closePool(): Promise<void> {
    await pool.end();
}
