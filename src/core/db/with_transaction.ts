import type { PoolClient } from "pg";
import type { AuditContext } from "../audit/audit_context";
import { pool } from "./pool";

export type TxClient = PoolClient;

/**
 * Única puerta a la BD: abre la transacción, setea los 6 GUCs de auditoría
 * más `app.current_customer_id` (tenant activo / RLS — residguard_db
 * CLAUDE.md §10.4/§15.2) con scope de transacción, y confirma o revierte.
 * Un endpoint = una transacción.
 */
export async function withTransaction<T>(
    ctx: AuditContext,
    fn: (tx: TxClient) => Promise<T>,
): Promise<T> {
    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        await client.query(
            `SELECT set_config('audit.user_id',            $1, true),
                    set_config('audit.user_session',       $2, true),
                    set_config('audit.app_name',           $3, true),
                    set_config('audit.action',             $4, true),
                    set_config('audit.ip_address',         $5, true),
                    set_config('audit.stack_trace',        $6, true),
                    set_config('app.current_customer_id',  $7, true)`,
            [
                ctx.userId,
                ctx.sessionId ?? "",
                ctx.appName,
                ctx.action,
                ctx.ipAddress ?? "",
                ctx.requestId,
                ctx.customerId,
            ],
        );
        const result = await fn(client);
        await client.query("COMMIT");
        return result;
    } catch (err) {
        try {
            await client.query("ROLLBACK");
        } catch {
            // conexión rota: release la descarta igualmente
        }
        throw err;
    } finally {
        client.release();
    }
}
