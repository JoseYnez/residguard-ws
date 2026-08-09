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

    // Cajas: catálogo por comunidad de los lugares donde vive el dinero
    // ("Caja chica", "Cuenta BBVA"). NO es el método de pago: el método dice
    // CÓMO se movió el dinero; la caja, A DÓNDE llegó. Baja lógica con `.update`.
    cashAccountsRead: "cash_accounts.read",
    cashAccountsCreate: "cash_accounts.create",
    cashAccountsUpdate: "cash_accounts.update",

    // Traspasos entre cajas de la MISMA comunidad. Suma cero para la comunidad
    // (nunca tocan su saldo ni los ingresos/egresos de reportes): solo mueven
    // saldo entre cajas. Baja lógica con `.update`, como fund_adjustments.
    cashTransfersRead: "cash_transfers.read",
    cashTransfersCreate: "cash_transfers.create",
    cashTransfersUpdate: "cash_transfers.update",

    // Reportes financieros de una comunidad: estado de caja por rango, cobranza
    // del periodo, cartera vencida y adeudo por unidad. Recurso propio y NO la
    // suma de `charges.read` + `payments.read` + `expenses.read` +
    // `fund_adjustments.read`: conceder el AGREGADO es una decisión distinta de
    // conceder cada detalle (un miembro de junta puede necesitar los totales sin
    // ver el padrón ni quién pagó qué). Exigir los cuatro dejaría además la
    // pantalla a medias para casi todo el mundo, que es peor que negarla entera.
    // Solo `.read`: un reporte deriva, nunca escribe.
    reportsRead: "reports.read",

    // --- Catálogo RESERVADO de plataforma (decisión #23 de admin_project) ----
    // Códigos `platform_*` del catálogo de residguard-app, pero sembrados por
    // admin_project (09_tenant_admin_api.sql + 99_patch_residguard_resident_role.sql),
    // NO por el seed de ResidGuard: son la autorización de la superficie tenant
    // de admin_ws (invitar usuarios del cliente desde esta app). Este servicio
    // los exige en los endpoints de invitación del padrón como fast-fail; la
    // frontera real la re-aplica admin_ws sobre el MISMO token en cada llamada,
    // así que aunque este guard mintiera, la plataforma denegaría.
    platformUsersRead: "platform_users.read",
    platformUsersInvite: "platform_users.invite",

    // --- Autoconsulta del RESIDENTE (portal, rutas /me/*) --------------------
    // Autorizan leer LO PROPIO: las unidades vinculadas al usuario del token
    // (members.user_id = sub) y su estado de cuenta. La frontera de alcance
    // aquí NO es community_members (un residente no ve la comunidad): es el
    // vínculo del padrón — por eso las rutas /me/* no llevan
    // requireCommunityAccess y resuelven la pertenencia por la cadena
    // sub → members.user_id → unit_members → units. Los concede el rol
    // `community_resident` (y también community_admin: la anti-escalada de la
    // superficie tenant exige que quien concede un rol tenga sus permisos).
    // Sembrados por admin_project/db/99_patch_residguard_self_service.sql.
    selfUnitsRead: "self_units.read",
    selfStatementRead: "self_statement.read",

    // Registro previo de visitas del residente (rutas /me/visits). Mismo
    // alcance que el resto de /me/*: la cadena del padrón. `.update` autoriza
    // CANCELAR — la baja es lógica y se autoriza con `.update`, como manda la
    // convención; no hay edición de un pase (se cancela y se registra otro,
    // igual que un pago).
    selfVisitsRead: "self_visits.read",
    selfVisitsCreate: "self_visits.create",
    selfVisitsUpdate: "self_visits.update",

    // --- Visitas del lado de la OPERACIÓN (bitácora y caseta) ---------------
    // `visits.read` cubre la bitácora de la comunidad Y resolver un código en
    // caseta: consultar un pase no es abrir la puerta, y separarlo permite que
    // un lector de junta vea el registro sin poder dejar entrar a nadie.
    //
    // Registrar la entrada es `execute` y no `create` por la misma razón que
    // `payments.revoke`: es una vía sancionada —revalida vigencia, ventana
    // horaria, días y tope de entradas con el pase BLOQUEADO— y no el alta de
    // un registro cualquiera.
    //
    // NO existe `visits.create`: en esta versión el pase nace SOLO del
    // residente (decisión del usuario). El operador consulta y valida.
    visitsRead: "visits.read",
    visitsCheckin: "visits.checkin",
} as const;

/** Unión de todos los códigos FUNCIONALES del catálogo. El guard solo acepta
 *  estos. Los códigos de pantalla (`SCREEN_PERMISSIONS`) quedan FUERA a
 *  propósito: ver el comentario de ese objeto. */
export type PermissionCode = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

// Permisos de PANTALLA (decisión #24 de la plataforma): filas kind='screen'
// del mismo catálogo de BD. Conceden ABRIR una vista de residguard_app —
// existen porque pantalla y recurso dejaron de ser 1:1 (`reports.read`
// guardaba CUATRO rutas: statement, statement-v2, reports y movements) — y
// los consume SOLO el front (guard de ruta + poda del menú).
//
// ⚠ INVARIANTE — un código de pantalla NUNCA es frontera de seguridad. Este
// servicio no exige ninguno: cada endpoint conserva su código funcional de
// `PERMISSIONS`. La separación en dos objetos es lo que hace el invariante
// ESTRUCTURAL: `requirePermission` solo acepta `PermissionCode`, así que
// `requirePermission(SCREEN_PERMISSIONS.units)` no compila. NO fusionar los
// dos objetos ni ensanchar `PermissionCode` — eso degradaría el invariante a
// una convención.
//
// Se listan aquí (y no solo en el front) porque este archivo es el espejo
// declarado del catálogo de BD: si BD y espejo divergen, alguien lo nota
// leyendo UN archivo. Mismo pacto de sincronía del encabezado, contra
// `admin_project/db/99_patch_residguard_screens.sql` (BD ya sembradas) y
// `99_seed_residguard_app.sql` (builds nuevos).
export const SCREEN_PERMISSIONS = {
    communities: "screens.communities",
    units: "screens.units",
    members: "screens.members",
    directory: "screens.directory",
    fees: "screens.fees",
    charges: "screens.charges",
    statement: "screens.statement",
    statementV2: "screens.statement_v2",
    payments: "screens.payments",
    expenseCategories: "screens.expense_categories",
    expenses: "screens.expenses",
    fundAdjustments: "screens.fund_adjustments",
    cashAccounts: "screens.cash_accounts",
    reports: "screens.reports",
    movements: "screens.movements",
    myUnits: "screens.my_units",
    myStatement: "screens.my_statement",
    myVisits: "screens.my_visits",
    visits: "screens.visits",
    gate: "screens.gate",
} as const;

/** Unión de los códigos de pantalla. Ningún guard de este servicio los acepta. */
export type ScreenPermissionCode =
    (typeof SCREEN_PERMISSIONS)[keyof typeof SCREEN_PERMISSIONS];
