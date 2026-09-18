import type { TxClient } from "../db/with_transaction";

/**
 * A quién avisar de algo que le pasa a UNA unidad: los usuarios de plataforma
 * VINCULADOS a personas activas del padrón de esa unidad (`members.user_id`,
 * que se llena al invitar). Distinct porque una persona puede figurar en la
 * unidad con dos relaciones.
 *
 * Es el `user_id` GLOBAL (auth.users.id): push-service abre el aviso a los
 * dispositivos que ese usuario registró en (cliente, residguard-app). Lo
 * comparten los tres avisos del producto — llegada y salida de una visita,
 * pago registrado — para que "los residentes de la unidad" signifique lo mismo
 * en todos.
 *
 * `exceptUserId`: quien provocó el hecho no necesita que le avisen de él (el
 * operador que registró el pago, si además vive en esa unidad).
 */
export async function unitLinkedUserIds(
    tx: TxClient,
    unitId: string,
    exceptUserId: string | null = null,
): Promise<string[]> {
    const result = await tx.query<{ user_id: string }>(
        `SELECT DISTINCT m.user_id
           FROM community.unit_members um
           JOIN community.members m ON m.id = um.member_id
          WHERE um.unit_id = $1
            AND um.status = 'active'
            AND m.status = 'active'
            AND m.user_id IS NOT NULL
            AND ($2::uuid IS NULL OR m.user_id <> $2::uuid)`,
        [unitId, exceptUserId],
    );
    return result.rows.map((row) => row.user_id);
}
