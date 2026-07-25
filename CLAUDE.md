# CLAUDE.md — residguard_ws (API de negocio de ResidGuard)

> Versión 1.0 — 2026-07-12
>
> Estándar de implementación de la API de negocio de ResidGuard. Subordinado a
> [../residguard_db/CLAUDE.md](../residguard_db/CLAUDE.md) (objetos de BD). La
> arquitectura replica la de `admin_ws` (plataforma admin_project); si un
> patrón no está descrito aquí, aplica el de ese servicio.

---

## 0. Propósito y stack

`residguard_ws` es la API de negocio de ResidGuard: comunidades, unidades,
miembros de unidad, cargos (lectura), pagos, gastos y movimientos manuales de
caja. **No emite tokens**: la autenticación la hace el `auth_ws` de la
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
│   │   ├── communities/v1/          ← comunidades accesibles (solo lectura) + saldo
│   │   ├── community-members/v1/    ← relación usuario↔comunidad (visibilidad)
│   │   ├── units/v1/                ← unidades (CRUD)
│   │   ├── unit-members/v1/         ← personas↔unidad (CRUD)
│   │   ├── fees/v1/                 ← cuotas por comunidad (CRUD)
│   │   ├── charges/v1/              ← cargos por comunidad/unidad (lectura con saldo) + registro multi-unidad
│   │   ├── payments/v1/             ← pagos (sp_register_payment) + anulación
│   │   ├── expense-categories/v1/   ← rubros de gasto por comunidad (CRUD)
│   │   ├── expenses/v1/             ← gastos ejercidos (CRUD)
│   │   └── fund-adjustments/v1/     ← movimientos manuales de caja (CRUD)
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
   - Códigos: convención `recurso.accion` (28 en total). La baja es lógica y
     en general se autoriza con `.update` (igual que en `admin_ws`);
     **`units.delete` es la excepción**: la baja de unidades tiene permiso
     propio. `payments.revoke` es `execute` (operación sancionada, no una
     edición).
   - `src/core/auth/permissions.ts` es el espejo tipado del seed:
     `requirePermission` solo acepta `PermissionCode`, así que un código
     inexistente es error de compilación (en `admin_ws` son strings sueltos).
     **Añadir un permiso obliga a tocar ese archivo Y el seed SQL.**
   - Roles `system_default` sembrados: `community_admin` (catálogo completo) y
     `community_reader` (los 9 códigos de lectura).
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
   - `GET /communities` y `GET /communities/:communityId` no llevan preHandler
     de alcance: lo aplica el `ACCESS_JOIN` del repositorio.
   - `payments` (no cuelga de comunidad) → el controller valida contra los
     cargos tocados: registrar/anular exige alcanzar **todas** sus
     comunidades; consultar basta con **alguna**.
6. Recurso fuera del alcance → **404**, indistinguible de inexistente.
   El **primer** miembro de una comunidad se siembra desde la consola de la
   cuenta o el proceso de sincronización (sin membresía inicial nadie la ve).

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
  encabezado + `billing.sp_refresh_charge_payment_status` por cargo; saldo de
  comunidad → `billing.fn_get_community_balance`. `payment_status` nunca se
  escribe a mano; `overdue` SIEMPRE se deriva en lectura.
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
| `PERMISSIONS_STALE_GRACE_MINUTES` | Gracia de permisos cacheados si `auth_ws` cae — default 15, `0` = fallar cerrado |
| `RESIDGUARD_APP_CODE` | appCode de ResidGuard (ancla de autorización) — default `residguard-app` |
| `CORS_ORIGINS` | Lista blanca separada por comas (SPA dev: `http://localhost:4204`) |
| `PORT` / `HOST` | Servicio (default 3003) |
| `LOG_LEVEL` | pino |

Validada al boot con structure-verifier; si falta algo, el proceso no arranca.

---

## 7. Pendientes conocidos (fuera de esta versión)

- Cargos: lectura por comunidad (`GET /communities/:communityId/charges`, con
  filtro `unitId` opcional) o por unidad (`GET /units/:unitId/charges`, la
  fuente del flujo de pagos), y registro multi-unidad
  (`POST /communities/:communityId/charges` con `unitIds[]`, permiso
  `charges.create`: un cargo por unidad en una transacción todo-o-nada; la
  cuota debe ser activa y de la comunidad, y el solapamiento responde 409 vía
  `ex_charges_no_overlap` nombrando la unidad). Edición/baja de cargos siguen
  pendientes.
- Condonaciones (`billing.sp_waive_charge`) sin endpoint.
- Roles **por comunidad**. Ya hay distinción admin/lector
  (`community_admin` / `community_reader`), pero el permiso se resuelve sobre
  la **tripleta** (cliente, app, usuario): es el mismo para TODAS las
  comunidades del usuario. Un usuario que administre una comunidad y solo
  consulte otra no se puede modelar hoy — exigiría una tabla de roles en
  `community.community_members` y cruzarla con el permiso de plataforma.
- Sincronización del espejo `core.customers`/`core.users`
  (`role_identity_sync`) — servicio aparte.
