# CLAUDE.md — residguard_ws (API de negocio de ResidGuard)

> Versión 1.0 — 2026-07-12
>
> Estándar de implementación de la API de negocio de ResidGuard. Subordinado a
> [../residguard_db/CLAUDE.md](../residguard_db/CLAUDE.md) (objetos de BD). La
> arquitectura replica la de `admin_ws` (plataforma admin_project); si un
> patrón no está descrito aquí, aplica el de ese servicio.

---

## 0. Propósito y stack

`residguard_ws` es la API de negocio de ResidGuard: comunidades (CRUD),
unidades, miembros de unidad, cargos (lectura), pagos, gastos, movimientos
manuales de caja y los reportes financieros derivados de todo ello. **No emite tokens**: la autenticación la hace el `auth_ws` de la
plataforma; este servicio solo **valida** el access token (firma Ed25519
local contra el JWKS, cacheado) y acota el alcance por comunidad.

Stack: Node.js LTS + TypeScript estricto, Fastify ≥ 5 (`trustProxy: true`),
`structure-verifier` + adaptador Fastify, `pg` con un solo pool, `jose` para
verificar JWT. Conecta como **`role_app`** (RLS tenant-scoped, sin DELETE
físico). Servicio stateless.

---

## 1. Estructura de carpetas

```
residguard_ws/
├── src/
│   ├── api/
│   │   ├── common/                  ← verifiers compartidos (params, paginación, error)
│   │   ├── communities/v1/          ← comunidades accesibles (CRUD) + saldo
│   │   ├── community-members/v1/    ← relación usuario↔comunidad (visibilidad), bajo /access
│   │   ├── members/v1/              ← padrón de personas (CRUD) + invitación/vínculo a usuario de plataforma
│   │   ├── units/v1/                ← unidades (CRUD)
│   │   ├── unit-members/v1/         ← personas↔unidad (CRUD)
│   │   ├── fees/v1/                 ← cuotas por comunidad (CRUD)
│   │   ├── fee-periods/v1/          ← periodos de cuota (lista/alta/baja; la generación de cargos los crea sola)
│   │   ├── charges/v1/              ← cargos por comunidad/unidad (lectura con saldo) + registro multi-unidad + cargo suelto (sin periodo) + anulación
│   │   ├── payments/v1/             ← pagos (sp_register_payment) + anulación
│   │   ├── waivers/v1/              ← condonaciones por cargo (sp_waive_charge) + historial + reversión
│   │   ├── expense-categories/v1/   ← rubros de gasto por comunidad (CRUD)
│   │   ├── expenses/v1/             ← gastos ejercidos (CRUD)
│   │   ├── fund-adjustments/v1/     ← movimientos manuales de caja (CRUD)
│   │   ├── reports/v1/              ← agregados financieros por comunidad (solo GET): estado de caja por rango, cobranza devengada, antigüedad y adeudo por unidad
│   │   └── me/v1/                   ← autoconsulta del residente (/me/units, /me/units/:id/statement): alcance por vínculo del padrón, no por community_members
│   ├── core/
│   │   ├── db/                      ← pool + with_transaction (GUCs auditoría + tenant)
│   │   ├── audit/                   ← AuditContext + builder
│   │   ├── auth/
│   │   │   ├── access_token.ts      ← verificación local Ed25519 (JWKS de auth_ws)
│   │   │   ├── authenticate.ts      ← hook onRequest global
│   │   │   ├── permissions.ts       ← catálogo tipado de códigos (espejo del seed)
│   │   │   ├── permissions_client.ts ← permisos efectivos vía auth_ws + caché por sid
│   │   │   ├── require_permission.ts ← preHandler de permiso (403)
│   │   │   └── community_access.ts  ← alcance por comunidad (preHandlers + helpers)
│   │   ├── platform/
│   │   │   └── tenant_admin_client.ts ← cliente de la superficie tenant de admin_ws (invitaciones)
│   │   └── http/                    ← error handler + traducción de errores PG
│   ├── config.ts
│   └── server.ts
└── CLAUDE.md
```

Cada recurso sigue la anatomía de cuatro archivos (`*_v1.routes.ts` /
`*_v1.verifier.ts` / `*_v1.controller.ts` / `*_v1.repository.ts`), misma
responsabilidad por archivo que en `admin_ws`.

---

## 2. Autenticación y autorización

1. **Verificación local del access token** (hook `onRequest` global, salvo
   `/health`): firma Ed25519 contra la clave pública del JWKS de `auth_ws`
   (cache en memoria, TTL horas, refresco por `kid` desconocido). El token
   debe pertenecer a la **app ResidGuard** (`RESIDGUARD_APP_CODE`).
2. Claims: `sub` (user_id = `core.users.id`), `acu`, `customer_id` (tenant),
   `app_id`, `sid`. **El tenant sale siempre del claim, nunca de un parámetro.**
3. **DOS fronteras ortogonales, y toda ruta declara las dos.** No se sustituyen:

   | Frontera | Responde | Dónde | Falla con |
   |---|---|---|---|
   | **PERMISO** | QUÉ puede hacer el actor | `requirePermission(code)` | **403** |
   | **ALCANCE** | SOBRE QUÉ comunidad | `requireCommunityAccess()` / `requireUnitAccess()` | **404** |

   Tener `units.create` no autoriza a crear unidades en una comunidad ajena, y
   pertenecer a una comunidad no autoriza a capturar gastos en ella. El permiso
   va **primero** en el array de preHandlers: es la comprobación barata (caché
   en memoria, sin BD) y no revela si el recurso existe.

4. **Permisos (RBAC de plataforma)**. El catálogo vive en `auth.permissions`
   del sistema de auth con el `app_id` de `residguard-app`, sembrado por
   `admin_project/db/99_seed_residguard_app.sql`, y se gestiona desde
   `admin_ws` (que ya es genérico por app). Este servicio **solo valida**; no
   expone CRUD de permisos ni de roles.
   - Códigos: convención `recurso.accion` (41 en total). La baja es lógica y
     en general se autoriza con `.update` (igual que en `admin_ws`);
     **`units.delete` es la excepción**: la baja de unidades tiene permiso
     propio. `payments.revoke`, `charges.revoke`, `waivers.create` y
     `waivers.revoke` son `execute` (operaciones sancionadas, no ediciones — y
     los cargos ni siquiera tienen `.update`).
   - `src/core/auth/permissions.ts` es el espejo tipado del seed:
     `requirePermission` solo acepta `PermissionCode`, así que un código
     inexistente es error de compilación (en `admin_ws` son strings sueltos).
     **Añadir un permiso obliga a tocar ese archivo Y el seed SQL.**
   - Roles `system_default` sembrados: `community_admin` (catálogo completo) y
     `community_reader` (los 14 códigos de lectura — `reports.read` incluido:
     un lector de comunidad existe precisamente para consultar).
   - Fuente de verdad operativa: `GET /auth/sessions/current/permissions` de
     `auth_ws`, cacheado por `sid` (TTL 60 s) — una sesión revocada pierde
     acceso aunque su JWT siga vigente.
   - **Degradación**: `residguard_db` no tiene schema `auth`, así que aquí NO
     existe el resolver local `fn_has_permission` al que degrada `admin_ws`. Si
     `auth_ws` no responde se sirve la última respuesta suya conocida durante
     `PERMISSIONS_STALE_GRACE_MINUTES` (log en `warn`); sin caché utilizable →
     **503**. Nunca se concede un permiso que `auth_ws` no haya afirmado: se
     relaja la frescura, no la frontera.

5. **Alcance por comunidad**: la frontera de visibilidad es
   **`community.community_members`** — el usuario del token solo ve/opera las
   comunidades donde tiene una membresía activa, y a través de ellas sus
   unidades, cargos, pagos, gastos y movimientos.
   - Rutas `/communities/:communityId/*` → preHandler `requireCommunityAccess()`.
   - Rutas `/units/:unitId/*` → preHandler `requireUnitAccess()` (unidad →
     comunidad → membresía en una consulta).
   - El recurso **communities** (GET lista/detalle, POST, PATCH, DELETE) no
     lleva preHandler de alcance: lo aplica el `ACCESS_JOIN` del repositorio.
     Y a propósito, porque `requireCommunityAccess()` exige la comunidad
     **activa**: con él, desactivar una comunidad sería un viaje sin retorno
     (nadie podría editarla ni reactivarla). El JOIN del repositorio admite
     `inactive` y solo excluye `deleted`. `/balance` sí lo conserva.
   - `payments` **sí** cuelga de una comunidad (`billing.payments.community_id`,
     derivada de sus cargos por `sp_register_payment`), pero su ruta no está
     anidada, así que el alcance lo valida el controller: consultar y anular se
     miden contra `p.community_id`; **registrar** se valida cargo por cargo,
     porque la comunidad del depósito no existe hasta que la sp la deriva.
6. Recurso fuera del alcance → **404**, indistinguible de inexistente.
   El **primer** miembro de una comunidad lo crea `POST /communities` en la
   misma transacción (el actor queda como miembro de lo que acaba de crear);
   para las comunidades que llegan por el seed o el proceso de sincronización,
   la membresía inicial viene de ahí. Sin membresía nadie la ve.

---

## 3. Acceso a BD

- Rol **`role_app`**: SELECT/INSERT/UPDATE en tablas de negocio, solo SELECT
  en el espejo `core.*`. **DELETE no existe**: baja = `UPDATE status='deleted'`
  (soft delete; los triggers llenan `deleted_at/by`).
- **RLS activo** en todas las tablas tenant-scoped: `withTransaction` fija
  `app.current_customer_id` (claim del token) + los 6 GUCs `audit.*` al abrir
  cada transacción. El pool no se exporta; un endpoint = una transacción;
  cero SQL fuera de `withTransaction`.
- **Vías sancionadas de billing**: registrar pago →
  `billing.sp_register_payment`; anular pago → soft-delete de aplicaciones +
  encabezado + `billing.sp_refresh_charge_payment_status` por cargo; condonar →
  `billing.sp_waive_charge`; revertir condonación → soft-delete del waiver +
  `sp_refresh_charge_payment_status`; cargo suelto → `billing.sp_add_unit_charge`;
  saldo de comunidad → `billing.fn_get_community_balance`. `payment_status`
  nunca se escribe a mano; `overdue` SIEMPRE se deriva en lectura.
- **Un pago pertenece a UNA comunidad.** `sp_register_payment` la deriva de los
  cargos aplicados y **rechaza** (400) el depósito repartido entre comunidades:
  quien recibe dinero de dos registra dos pagos. La caja declarada debe ser de
  esa misma comunidad — y eso ya no depende del procedimiento, lo impone la FK
  compuesta `(customer_id, community_id, cash_account_id)`.
- **Tope del monto a condonar**: la BD solo exige `waived_amount > 0`, así que
  el límite (saldo pendiente) lo pone el servicio — y lo pone con el cargo
  **bloqueado** (`SELECT … FOR UPDATE OF c` en la misma transacción que el
  CALL, que vuelve a tomar el mismo lock). Sin ese lock, dos condonaciones
  simultáneas podrían cubrir un cargo por encima de su importe.
- **Dos formas de cargo.** El DEVENGADO cuelga de un periodo de cuota (uno por
  periodo y unidad, `uq_charges_period_unit`). El SUELTO no tiene periodo
  (`period_id`, `period_start` y `period_end` van null juntos) y es
  **repetible**: es la venta de dos tarjetas de acceso o una multa, y
  registrarlo dos veces son dos ventas. Consecuencia para todo SQL nuevo que
  toque cargos: el JOIN con `billing.fee_periods` es **LEFT**, siempre — con un
  INNER, las ventas desaparecen del estado de cuenta y de los pagos.
- **Reportes: dos totales que NO cuadran entre sí, y es correcto.** `reports/v1`
  publica el estado de **caja** (dinero que entró/salió en el rango) y la
  **cobranza** (lo devengado de ese periodo y cuánto está cubierto). Un pago de
  julio sobre la cuota de mayo es caja de julio y cobranza de mayo: sumarlos
  cuenta dos veces. Las condonaciones aparecen en cobranza y **nunca** en caja —
  no son dinero. Reglas del SQL: el ingreso se atribuye a la comunidad vía
  `payment_allocations → charges` (el depósito no tiene `community_id`); el lado
  caja NO filtra `charges.status` (igual que `fn_get_community_balance`, o se
  rompe el invariante `saldo_inicial + ingresos − egresos = saldo_final`, que es
  la prueba de que el reporte está bien) mientras que el devengado sí exige
  `status = 'active'`. Ojo: los reportes y `fn_get_community_balance` siguen
  atribuyendo el ingreso por el **cargo** aunque `payments.community_id` ya
  exista y para todo pago sano dé el mismo número — cambiar la atribución en un
  solo lado movería saldos históricos y rompería ese invariante; el devengo ubica el cargo por `COALESCE(period_start,
  due_date)` — sin ese COALESCE los cargos sueltos caen fuera de todo rango. La
  antigüedad y el adeudo por unidad son el estado **actual** de la cartera, no
  una reconstrucción a una fecha pasada.
- Errores esperables de PG (23505/23P01/23503/23514/P0002) se traducen a
  respuestas tipadas con `core/http/pg_errors.ts`; nunca burbujea el mensaje
  crudo.

---

## 4. Contexto de auditoría

| Campo | GUC | Origen |
|---|---|---|
| `userId` | `audit.user_id` | Claim `sub` (siempre presente) |
| `sessionId` | `audit.user_session` | Claim `sid` |
| `appName` | `audit.app_name` | Constante `'residguard_ws'` |
| `action` | `audit.action` | `"<MÉTODO> <ruta>"` |
| `ipAddress` | `audit.ip_address` | `request.ip` |
| `requestId` | `audit.stack_trace` | `request.id` de Fastify |
| `customerId` | `app.current_customer_id` | Claim `customer_id` del token — **siempre** |

---

## 5. Respuestas y errores

Mismas convenciones que `admin_ws` §6: 200/201/204; 400 validación
(`{ errors }`) o negocio tipado; 401 token inválido **o sesión revocada**
(`auth_ws` tiene más autoridad que la firma local); 403 sin el permiso
requerido, o cuando el actor VE el recurso pero no puede mutarlo (anular pago
multi-comunidad); 404 inexistente **o fuera de alcance**; 409 unicidad; 503
`auth_ws` inalcanzable sin permisos cacheados; 500 opaco con `requestId`.
Listados con paginación obligatoria (`page`/`pageSize`, tope 100). Fechas de
negocio (DATE) como `YYYY-MM-DD`; instantes como ISO-8601. Dinero como
número JSON (NUMERIC(14,2) en BD).

---

## 6. Configuración (env)

| Variable | Uso |
|---|---|
| `DATABASE_URL` | Conexión como `role_app` |
| `AUTH_WS_BASE_URL` | JWKS `/auth/.well-known/keys` + permisos efectivos (https en producción) |
| `ADMIN_WS_BASE_URL` | Superficie tenant `/tenant/v1` de admin_ws: invitación de usuarios del cliente (decisión #23 de la plataforma). Viaja el access token del usuario final; https en producción |
| `RESIDENT_ROLE_CODE` | `auth.roles.code` que se asigna al invitar personas del padrón — default `community_resident` (sembrado por `admin_project/db/99_patch_residguard_resident_role.sql`) |
| `PERMISSIONS_STALE_GRACE_MINUTES` | Gracia de permisos cacheados si `auth_ws` cae — default 15, `0` = fallar cerrado |
| `RESIDGUARD_APP_CODE` | appCode de ResidGuard (ancla de autorización) — default `residguard-app` |
| `CORS_ORIGINS` | Lista blanca separada por comas (SPA dev: `http://localhost:4204`) |
| `DB_TIMEZONE` | Zona de operación fijada en cada sesión de PG — default `America/Mexico_City`. Solo afecta el recorte a día (`::date`, `CURRENT_DATE`, cortes de saldo), no el instante almacenado |
| `PORT` / `HOST` | Servicio (default 3003) |
| `LOG_LEVEL` | pino |

Validada al boot con structure-verifier; si falta algo, el proceso no arranca.

---

## 7. Pendientes conocidos (fuera de esta versión)

- **Edición** de cargos (monto, periodo, vencimiento): sin endpoint. Lo que ya
  existe es leer (`GET /communities/:communityId/charges` con filtro `unitId`
  opcional, `GET /units/:unitId/charges`), registrar
  (`POST /communities/:communityId/charges` con `unitIds[]`) y **anular**
  (`DELETE /communities/:communityId/charges/:id`, permiso `charges.revoke`).
  Corregir un cargo mal capturado se hace hoy anulándolo y registrándolo de
  nuevo — lo cual solo funciona mientras nadie le haya aplicado dinero.
- **Condonaciones**: ya tienen superficie propia (`waivers/v1`) — condonar
  (`POST /communities/:communityId/charges/:chargeId/waivers`, permiso
  `waivers.create`; sin `amount` se perdona TODO el saldo), historial
  (`GET /communities/:communityId/waivers` con filtros `chargeId`/`unitId`/
  fechas, `waivers.read`) y revertir (`DELETE /communities/:communityId/waivers/:id`,
  `waivers.revoke`). No confundir con anular: condonar perdona la deuda de un
  cargo que SÍ existió y conserva su rastro (`payment_status = 'waived'`);
  anular borra lógicamente un cargo que no debió existir, y por eso el servicio
  lo rechaza (409) en cuanto hay pagos o condonaciones de por medio. Lo que
  sigue **sin** endpoint es **editar** una condonación: se revierte y se
  registra de nuevo (una condonación no se reescribe, igual que un pago).
- Granularidad **por comunidad** del permiso. Ya hay distinción admin/lector
  (`community_admin` / `community_reader`), pero el permiso se resuelve sobre
  la **tripleta** (cliente, app, usuario): es el mismo para TODAS las
  comunidades del usuario. Un usuario que administre una comunidad y solo
  consulte otra no se puede modelar hoy.
  **Decisión: ResidGuard no almacena roles.** No habrá tabla ni columna de rol
  en `community.community_members` ni en ninguna otra — la autorización se
  gestiona íntegramente por los permisos del RBAC externo (catálogo y roles en
  `admin_ws`, permisos efectivos vía `auth_ws`), y este servicio solo valida.
  `community_members` responde **una** pregunta, el alcance (§2.5); el QUÉ
  puede hacer el actor no vive aquí. Si algún día el permiso necesita variar
  por comunidad, el cambio va en el RBAC de plataforma — acotar el grant a un
  ámbito — nunca en un rol local que reintroduzca la frontera del permiso
  dentro de la BD de negocio.
- Sincronización del espejo `core.users`: **absorbida por el flujo de
  invitación** (2026-08-08). `POST /communities/:communityId/members/:memberId/invitation`
  invita a la persona vía la superficie tenant de admin_ws (rol
  `RESIDENT_ROLE_CODE`, correo y activación los pone la plataforma), siembra el
  espejo `core.users` con el `userId` devuelto y fija `members.user_id` — un
  solo botón que también resuelve la multipertenencia (email con cuenta →
  admin_ws reutiliza la identidad y aquí solo se vincula; respuesta idéntica a
  propósito). Subrecursos: `GET/DELETE .../user` (estado del vínculo /
  desvincular) y `POST .../invitation/resend|cancel`. Permisos: el catálogo
  RESERVADO `platform_users.read`/`platform_users.invite` (decisión #23), que
  admin_ws re-aplica sobre el mismo token. **No** se inserta en
  `community_members`: un residente ve *sus unidades*, no la comunidad — esa
  autoconsulta ya existe en `me/v1` (`GET /me/units`,
  `GET /me/units/:unitId/statement`, permisos `self_units.read` /
  `self_statement.read` del rol `community_resident`; el estado de cuenta reusa
  la consulta V2 de reports con la pertenencia resuelta por el vínculo del
  padrón). El espejo `core.customers` sigue pendiente de sincronización
  (`role_identity_sync` se conserva para un backfill masivo).
