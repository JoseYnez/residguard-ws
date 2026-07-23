// Catálogo de permisos de ResidGuard: la lista canónica de códigos que este
// servicio exige. Es el espejo en TypeScript de las filas sembradas en
// `auth.permissions` (schema del sistema de auth de la plataforma) con el
// `app_id` de la app `residguard-app`.
//
// Por qué existe este archivo (y admin_ws no lo tiene): allí los códigos viven
// como strings literales inline en cada `requirePermission("...")`, así que una
// divergencia entre el catálogo de BD y el código no la detecta el compilador
// — se manifiesta como un 403 silencioso en producción. Aquí el guard solo
// acepta `PermissionCode`, de modo que un código inexistente o mal escrito es
// un error de compilación.
//
// INVARIANTE: este objeto y el seed SQL
// `admin_project/db/09_seed_residguard_app.sql` deben mantenerse sincronizados.
// Al añadir un permiso hay que tocar LOS DOS. Un permiso que exista aquí pero
// no en BD deniega a todo el mundo (incluido el superadmin: el comodín
// `grants_all_permissions` solo expande sobre permisos que existan para la app).
//
// Convención heredada de la plataforma (CLAUDE.md §3 de admin_project):
// `recurso.accion`, con `resource` como prefijo literal del `code`, y
// `action_type` ∈ read/create/update/delete/execute. NO se catalogan permisos
// `.delete`: la baja es lógica y se autoriza con `.update`, igual que en
// admin_ws.

export const PERMISSIONS = {
    // Comunidades: solo lectura en este servicio (el alta la hace la consola).
    communitiesRead: "communities.read",

    // Membresías de comunidad: la frontera de visibilidad del servicio.
    communityMembersRead: "community_members.read",
    communityMembersCreate: "community_members.create",
    communityMembersUpdate: "community_members.update",

    // Unidades. Excepción a la convención "sin .delete": la baja (lógica) de
    // unidades se autoriza con permiso propio, separado de la edición.
    unitsRead: "units.read",
    unitsCreate: "units.create",
    unitsUpdate: "units.update",
    unitsDelete: "units.delete",

    // Personas asociadas a una unidad.
    unitMembersRead: "unit_members.read",
    unitMembersCreate: "unit_members.create",
    unitMembersUpdate: "unit_members.update",

    // Cargos: solo lectura (su generación no tiene endpoint todavía).
    chargesRead: "charges.read",

    // Pagos. Anular NO es `.update`: es una operación sancionada distinta
    // (soft-delete + recálculo de estatus de cargos), por eso `execute`.
    paymentsRead: "payments.read",
    paymentsCreate: "payments.create",
    paymentsRevoke: "payments.revoke",

    // Rubros de gasto.
    expenseCategoriesRead: "expense_categories.read",
    expenseCategoriesCreate: "expense_categories.create",
    expenseCategoriesUpdate: "expense_categories.update",

    // Gastos ejercidos.
    expensesRead: "expenses.read",
    expensesCreate: "expenses.create",
    expensesUpdate: "expenses.update",

    // Movimientos manuales de caja.
    fundAdjustmentsRead: "fund_adjustments.read",
    fundAdjustmentsCreate: "fund_adjustments.create",
    fundAdjustmentsUpdate: "fund_adjustments.update",
} as const;

/** Unión de todos los códigos del catálogo. El guard solo acepta estos. */
export type PermissionCode = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

/** Lista plana del catálogo (útil para diagnóstico y para pruebas de paridad). */
export const ALL_PERMISSION_CODES: readonly PermissionCode[] =
    Object.values(PERMISSIONS);
