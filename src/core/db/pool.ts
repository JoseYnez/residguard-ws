import { Pool } from "pg";
import { config } from "../../config";

/**
 * Privado de core/db: SOLO with_transaction.ts puede importarlo. El resto
 * del servicio recibe `tx` dentro de withTransaction — nunca el pool
 * (sin contexto de auditoría/tenant no hay SQL).
 */
export const pool = new Pool({ connectionString: config.databaseUrl });
