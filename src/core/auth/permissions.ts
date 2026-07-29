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
// `admin_project/db/99_seed_residguard_app.sql` deben mantenerse sincronizados.
// Al añadir un permiso hay que tocar LOS DOS. Un permiso que exista aquí pero
// no en BD deniega a todo el mundo (incluido el superadmin: el comodín
// `grants_all_permissions` solo expande sobre permisos que existan para la app).
// El seed es de ejecución única: sobre una BD ya sembrada, los códigos nuevos
// entran por `admin_project/db/99_patch_residguard_permissions.sql`.
//
// Convención heredada de la plataforma (CLAUDE.md §3 de admin_project):
// `recurso.accion`, con `resource` como prefijo literal del `code`, y
// `action_type` ∈ read/create/update/delete/execute. Por regla general NO se
// catalogan permisos `.delete` — la baja es lógica y se autoriza con `.update`,
// igual que en admin_ws — con dos excepciones explícitas: `units.delete` y
// `payments.revoke` (ver sus comentarios más abajo).

export const PERMISSIONS = {
    // Comunidades: CRUD desde la app. Quien crea una comunidad queda como su
    // primer miembro (si no, nadie la vería: la visibilidad es la membresía).
    // Sin `.delete`: la baja lógica se autoriza con `.update` (convención).
    communitiesRead: "communities.read",
    communitiesCreate: "communities.create",
    communitiesUpdate: "communities.update",

    // Membresías de comunidad: la frontera de visibilidad del servicio. Quién
    // VE la comunidad (usuarios registrados) — ruta /communities/:id/access.
    communityMembersRead: "community_members.read",
    communityMembersCreate: "community_members.create",
    communityMembersUpdate: "community_members.update",

    // Directorio de personas de la comunidad (el padrón): quién vive, posee o
    // arrienda, tenga o no cuenta en la plataforma — ruta
    // /communities/:id/members. Separado de `community_members.*` a propósito:
    // llevar el padrón y repartir accesos son atribuciones distintas, y una
    // fila del padrón no concede visibilidad de nada.
    membersRead: "members.read",
    membersCreate: "members.create",
    membersUpdate: "members.update",

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

    // Cuotas: catálogo por comunidad (la lectura alimenta el selector del
    // registro de cargos). Baja lógica autorizada con `.update`.
    feesRead: "fees.read",
    feesCreate: "fees.create",
    feesUpdate: "fees.update",

    // Periodos de cuota ("Mantenimiento 2026 → Enero"): la fila intermedia
    // cuota→cargos. La generación de cargos los crea sola (sp_ensure_fee_period);
    // estos códigos cubren verlos y administrarlos por adelantado. Baja lógica
    // autorizada con `.update`.
    feePeriodsRead: "fee_periods.read",
    feePeriodsCreate: "fee_periods.create",
    feePeriodsUpdate: "fee_periods.update",

    // Cargos: lectura del estado de cuenta y registro (asignar una cuota a una
    // unidad). La edición sigue sin endpoint.
    //
    // Anular NO es `.update` (que además no existe para cargos): es una
    // operación sancionada distinta —baja lógica de un cargo que no debió
    // existir, solo mientras nadie le haya aplicado dinero— por eso `execute`,
    // igual que `payments.revoke`. Condonar (perdonar la deuda de un cargo que
    // SÍ existió) es otra cosa: ver `waivers.*`.
    chargesRead: "charges.read",
    chargesCreate: "charges.create",
    chargesRevoke: "charges.revoke",

    // Condonaciones. Recurso propio y no una acción de `charges` porque la
    // condonación es un hecho contable aparte (billing.waivers), con su propio
    // rastro y su propia reversión. Condonar y revertir son `execute` (vías
    // sancionadas: sp_waive_charge / sp_refresh_charge_payment_status), no
    // ediciones — mismo criterio que `payments.revoke`.
    waiversRead: "waivers.read",
    waiversCreate: "waivers.create",
    waiversRevoke: "waivers.revoke",

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
