# Comunicados — plan de BD, permisos y ws

> Documento hermano: `residguard_app/docs/comunicados.md` (pantallas). Si algo
> aquí choca con un `CLAUDE.md`, mandan las reglas del `CLAUDE.md`.
>
> Estado: **FASES 1 A 6 IMPLEMENTADAS** (2026-09-21/22), sin commitear — el
> diff vive en el working tree de `residguard_db`, `residguard_ws`,
> `residguard_app` y `admin_project/db`. Las decisiones ⚠ de §2 quedaron
> **confirmadas** por el usuario y se implementaron tal cual.
>
> Falta la **fase 7**: aplicar los patches y desplegar (ver §6). La
> verificación LOCAL ya está hecha: tests, BD desechable, integración del SQL
> real y la app manejada en el navegador con mocks.

---

## 1. Qué se busca

Que la administración publique comunicados a los residentes desde ResidGuard y
sepa si llegaron: redactar (texto enriquecido + adjuntos), elegir a quién va
(un **grupo**: todos, solo propietarios, una torre…), publicar con aviso push,
y ver cuántos lo leyeron. El residente los lee en su portal, con contador de no
leídos.

Decisiones ya tomadas por el usuario:

| Tema | Decisión |
| --- | --- |
| Audiencia | Por **grupos** (todos, solo propietarios, etc.) |
| Contenido | Texto enriquecido + adjuntos (imágenes / PDF) |
| Lectura | Se registra quién leyó; el admin ve el conteo |
| Publicación | Borrador → publicar, con push al publicar |

**Fuera de v1:** programar publicación a futuro (el ws es stateless, no hay
scheduler que dispare el push), comentarios/respuestas, vigencia con caducidad
automática, canal correo (smtp-service), grupos de lista manual (comité).

> Los grupos de lista manual tienen ya su plan v2: `docs/comunicados-personas.md`
> (grupos por PERSONAS, excluyentes con la regla; sin implementar).

## 2. Decisiones de diseño

1. ⚠ **Un grupo es una REGLA sobre el padrón, no una lista.** Criterios v1:
   `member_types` (owner/tenant/resident — ya vive en `unit_members.member_type`)
   y `towers` (`units.tower`); `NULL` = sin filtro en ese eje. "Propietarios de
   Torre B" es UN grupo con los dos criterios. Nadie mantiene la lista: alta o
   baja en el padrón = entra o sale del grupo. "Todos" no es una fila: es
   `audience_group_id IS NULL`. Los grupos de lista manual (comité, mesa
   directiva) quedan para v2 como otro tipo de grupo, sin romper el modelo.
2. ⚠ **Regla congelada, personas vivas.** Al publicar, la regla del grupo se
   COPIA al comunicado (`audience_member_types`, `audience_towers`,
   `audience_label`). Editar o borrar el grupo después no cambia a quién iba un
   comunicado ya publicado. Las PERSONAS sí se evalúan en vivo: quien llega a
   la comunidad la semana siguiente ve el reglamento fijado; quien se da de
   baja deja de verlo. La audiencia es inmutable tras publicar.
3. **Una sola definición de "¿está en la audiencia?"** Un fragmento SQL
   (`AUDIENCE_MATCH`) en el repositorio, usado en los dos sentidos: comunicado →
   usuarios (push, denominador del conteo) y usuario → comunicados (lista del
   residente). Misma razón que el veredicto único de visitas.
4. ⚠ **Texto enriquecido = Markdown acotado guardado como TEXTO.** Negritas,
   cursivas, encabezado, listas, enlaces. Sin HTML en BD ni en el contrato: no
   hay nada que sanitizar en el servidor, y el push necesita texto plano de
   todos modos. El render vive en la SPA (ver doc hermano). Sin dependencias
   nuevas.
5. **El conteo habla de CUENTAS, no de padrón.** Hoy en prod 5 de 141 miembros
   tienen cuenta. El detalle del operador devuelve las tres cifras: leyeron /
   con cuenta en la audiencia / personas del padrón en la audiencia — para que
   "3 de 5" no se lea como alcance total.
6. **Marcar leído es explícito:** `POST /me/announcements/:id/read`, no un GET
   con efecto lateral. Idempotente.
7. **Editar tras publicar sí** (título, cuerpo, adjuntos: erratas), estampa
   `edited_at` y NO re-avisa. **Archivar** lo saca del portal del residente y lo
   conserva para el operador. Baja lógica = `status='deleted'` como todo.
8. ⚠ **Schema nuevo `communication`** (no cabe en `community`, que es estructura
   física, ni en `access`). Archivo `06_communication_tables.sql`; el de roles
   se renumera a `07_roles_and_security.sql` (regla §16.2 de la BD).
9. La audiencia sale del **padrón**: guardias y personal sin vínculo a unidad
   no reciben comunicados en v1. El operador los ve por su pantalla.

## 3. Base de datos

### 3.1 Types

- `communication.announcement_status`: `draft`, `published`, `archived`
  (estado de PUBLICACIÓN; ortogonal a `status public.record_status`).

### 3.2 Tablas (todas con columnas estándar, FKs compuestas, RLS, 2 triggers)

**`communication.audience_groups`** — `community_id`, `name`,
`description`, `member_types community.member_type[]` NULL,
`towers TEXT[]` NULL. `uq (customer_id, community_id, lower(name)) WHERE status <> 'deleted'`.
`ck`: arreglos no vacíos cuando no son NULL; al menos un criterio presente (un
grupo sin criterios sería "Todos", que ya existe implícito).

**`communication.announcements`** — `community_id`, `title`, `body` (markdown),
`publication_status` (default `draft`), `audience_group_id` NULL (FK compuesta
`(customer_id, community_id, audience_group_id)`), snapshot
`audience_label TEXT`, `audience_member_types`, `audience_towers`,
`is_pinned BOOLEAN`, `published_at`, `published_by`, `edited_at`,
`archived_at`. `ck`: `published_at` no nulo ⇔ estado ≠ `draft`. Índice
`(customer_id, community_id, publication_status, is_pinned DESC, published_at DESC)`.
Clave de tenant `uq (customer_id, id)`.

**`communication.announcement_files`** — calco de `access.visit_event_files`:
`announcement_id`, `storage_file_id`, `filename`, `content_type`,
`size_bytes`, `sha256`, `sort_order`.

**`communication.announcement_reads`** — `announcement_id`, `user_id`,
`read_at`. `uq (customer_id, announcement_id, user_id)`; alta con
`ON CONFLICT DO NOTHING`. Lleva triggers estándar (la regla §11 no exceptúa).

### 3.3 Entregables — HECHO (2026-09-20, sin commitear)

- `06_communication_tables.sql` (schema, type y las 4 tablas con columnas
  estándar, FKs compuestas, claves de tenant, unicidad parcial, índices por FK
  y los dos triggers) + renumeración de roles a `07_roles_and_security.sql`
  (cambio aparte, con sus referencias en `CLAUDE.md` de la BD, `init.sql` y
  `05_access_tables.sql`) + bloque `B.9` en `init.sql` y grants/RLS en el
  Bloque C (`REVOKE` de PUBLIC, `GRANT USAGE`, 4 grants de tabla, default
  privileges y 4 políticas `tenant_scope_*`).
- `patch_announcements.sql` idempotente (guard → ROLLBACK inocuo al repetir).
- Dos afinados respecto al plan, ambos por el §13 del `CLAUDE.md` de la BD:
  los CHECK de arreglo no vacío usan `cardinality()` y **no** `array_length()`
  (`array_length('{}',1)` devuelve `NULL` y un CHECK que evalúa a `NULL` PASA),
  y `uq_announcement_reads_announcement_user` es un índice único **parcial**
  (`WHERE status <> 'deleted'`), así que el `ON CONFLICT` del alta debe repetir
  el predicado para que la inferencia lo encuentre.
- Validación en Docker (`postgres:17`), tres BD desechables ya borradas:
  init.sql nuevo ≡ init.sql de master + `patch_announcements.sql` (dump con
  privilegios y dueños: idéntico salvo el token aleatorio `\restrict` de
  pg_dump 17); la segunda aplicación del patch aborta con el guard; y la cadena
  modular `pre_setup → 00…07` ≡ init.sql **sin una sola diferencia en
  `communication`**. Prueba funcional como `role_app` (RLS activo): 7 rechazos
  esperados (unicidad de nombre ignorando mayúsculas, grupo sin criterios,
  arreglo vacío, las dos direcciones del CHECK de `published_at`, escritura
  cruzada de tenant, `DELETE` denegado), marcar leído dos veces deja una fila,
  el soft delete libera la unicidad parcial, y los 8 triggers registraron en
  `audit.event_log`.
- ⚠ **Deriva PREEXISTENTE detectada de paso** (no tocada, es de otro cambio):
  `07_roles_and_security.sql` —antes `06_`— nunca recibió lo de
  `patch_payment_evidence.sql`. Una instalación por scripts modulares deja
  `billing.payment_evidence`, `payment_evidence_files` y
  `payment_evidence_charges` **sin RLS y sin grants**, y sin el `GRANT EXECUTE`
  de `sp_verify_payment_evidence`. `init.sql` sí los tiene (producción se
  instaló de ahí). Arreglarlo son 3 bloques RLS + 4 grants en ese archivo.

## 4. Permisos (paridad a cuatro lados)

| Código | action_type | kind |
| --- | --- | --- |
| `announcements.read` / `.create` / `.update` | read/create/update | functional |
| `announcements.publish` | execute | functional |
| `audience_groups.read` / `.create` / `.update` | read/create/update | functional |
| `self_announcements.read` | read | functional |
| `screens.announcements` | read | screen |
| `screens.my_announcements` | read | screen |

- `announcements.publish` es `execute` aparte: publicar dispara un push a toda
  la audiencia y no se deshace; redactar borradores es otra cosa.
- Archivar, fijar y baja lógica → `.update`. Los grupos se administran DENTRO de
  la pantalla de comunicados (sin pantalla propia). Marcar leído lo cubre
  `self_announcements.read`.
- Roles: `community_resident` → `self_announcements.read` +
  `screens.my_announcements`; `community_admin` y **`admin`** (el operativo de
  prod) → los 10; `community_reader` → los dos `.read` + `screens.announcements`.
- Archivos: `admin_project/db/99_patch_residguard_announcements.sql` +
  `residguard_db/externos/patch_announcements_platform.sql` (ids literales,
  re-materialización preservando exclusiones `inactive`, patrón de
  `patch_visits_platform.sql`) + `src/core/auth/permissions.ts` +
  `residguard_app/.../core/session/permissions.ts`.

## 5. Endpoints

### 5.1 Operación — `api/announcements/v1` (anidado, `requireCommunityAccess()`)

| Ruta | Permiso | Notas |
| --- | --- | --- |
| `GET /communities/:cid/announcements` | `announcements.read` | Paginado; filtros `publicationStatus`, `q`. Cada fila trae `readCount` y `audienceAccounts` |
| `GET …/announcements/:id` | `.read` | Cuerpo, adjuntos con enlace firmado, las tres cifras de §2.5 |
| `GET …/announcements/:id/reads` | `.read` | Paginado; `filter=read|unread` sobre las cuentas de la audiencia (nombre, domicilio, `readAt`) |
| `POST …/announcements` | `.create` | Siempre nace `draft`. Valida adjuntos con `storageClient.getFile` |
| `PATCH …/announcements/:id` | `.update` | Audiencia solo en `draft`; en `published` estampa `edited_at`. También `isPinned` |
| `POST …/announcements/:id/publish` | `.publish` | `draft → published` con `UPDATE … WHERE publication_status='draft'` (409 si ya no lo es); congela la regla; tras el commit dispara el notifier |
| `POST …/announcements/:id/archive` | `.update` | `published → archived` |
| `DELETE …/announcements/:id` | `.update` | Baja lógica |
| `GET/POST/PATCH/DELETE /communities/:cid/audience-groups[/:id]` | `audience_groups.*` | CRUD de cuatro archivos estándar |
| `GET /communities/:cid/audience-groups/preview?memberTypes=&towers=` | `audience_groups.read` | Personas / con cuenta que casan con la regla, ANTES de guardar o publicar |

Topes: título 140, cuerpo 10 000 caracteres, 10 adjuntos, `image/*` y
`application/pdf` (el tamaño lo impone el bucket).

### 5.2 Residente — dentro de `api/me/v1` (cadena del padrón, sin `communityId`)

| Ruta | Permiso | Notas |
| --- | --- | --- |
| `GET /me/announcements` | `self_announcements.read` | Solo `published`, de las comunidades de MIS unidades y que casen con `AUDIENCE_MATCH`. Fijados primero, luego `published_at DESC`. Trae `read`, extracto en texto plano y `communityName` |
| `GET /me/announcements/unread-count` | ídem | Para el badge |
| `GET /me/announcements/:id` | ídem | Cuerpo + adjuntos con enlace firmado; fuera de audiencia → 404 |
| `POST /me/announcements/:id/read` | ídem | Idempotente, 204 |

### 5.3 Push — `announcements_v1.notifier.ts`

Patrón de `payments_v1.notifier.ts` (nunca lanza, nunca se espera):
`title` = "Nuevo comunicado · {communityName}", `body` = título + extracto
plano, `clickUrl` = `/my-announcements?announcement=<id>`, `tag` =
`idempotencyKey` = `announcement-<id>`, `ttlSec` 7 días,
`data.kind = 'announcement_published'`. Destinatarios = `user_id` distintos de
la audiencia, en lotes de ≤ 5000. El actor SÍ lo recibe si está en la audiencia.
Helper puro nuevo `core/text/markdown_plain.ts` (+ test) para el extracto.

## 6. Fases

1. ~~**BD**~~ **HECHA** — ver §3.3.
2. ~~**Permisos**~~ **HECHA** — los 10 códigos en los CUATRO lados:
   `admin_project/db/99_patch_residguard_announcements.sql`,
   `residguard_db/externos/patch_announcements_platform.sql` (ids literales,
   incluye el rol `admin` de producción y la re-materialización que preserva
   exclusiones), `residguard_ws/src/core/auth/permissions.ts` y
   `residguard_app/src/app/core/session/permissions.ts`.
3. ~~**ws operación**~~ **HECHA** — `api/announcements/v1` (cuatro archivos):
   CRUD de comunicados, `publish` (409 si ya no es borrador), `archive`,
   lecturas con filtro, enlace firmado de adjuntos, CRUD de grupos y
   `audience-groups/preview`. `AUDIENCE_MATCH` vive UNA vez en el repositorio.
4. ~~**ws residente + push**~~ **HECHA** — `/me/announcements`,
   `/unread-count`, detalle, `POST …/read` (idempotente) y enlace de adjunto;
   `announcements_v1.notifier.ts` (lotes de ≤5000, tag/idempotencyKey por
   comunicado) y `core/text/markdown_plain.ts`. 40 tests del ws en verde.
5. ~~**app operación**~~ y 6. ~~**app residente**~~ **HECHAS** — ver doc hermano.
7. **Verificación y despliegue** — PENDIENTE. Orden: `patch_announcements.sql`
   (residguard_db) → `patch_announcements_platform.sql` (auth_db) +
   **re-sync de las tripletas** → ws + app JUNTOS. Sin env nuevas.

## 7. Riesgos

- ~~Renumerar `06_roles_and_security.sql` toca referencias en `CLAUDE.md` de la BD
  y comentarios de patches: hacerlo en un cambio aparte y primero.~~ Hecho como
  cambio aparte (`git mv` + 4 referencias: `CLAUDE.md` §16.2 y la nota de los
  archivos de objetos, la equivalencia de `init.sql` y el encabezado de
  `05_access_tables.sql`). Ningún patch lo mencionaba.
- `announcement_reads` audita cada lectura en `audit.event_log`: volumen bajo
  hoy (5 cuentas), a vigilar si crece la adopción.
- Permiso por tripleta: quien administra dos comunidades publica en ambas
  (limitación ya conocida, §7 del CLAUDE.md).

---

## 8. Cómo se verificó (2026-09-21/22)

Todo LOCAL; nada aplicado a staging ni a producción.

**BD** — tres bases desechables en el contenedor Docker `postgres` (imagen
`postgres:17`): init nuevo ≡ init de master + patch (dump con privilegios y
dueños idéntico salvo el token aleatorio `\restrict` de pg_dump 17); el patch
repetido aborta con su guard; y la cadena modular `pre_setup → 00…07` ≡
init.sql **sin una sola diferencia en `communication`**. Prueba funcional como
`role_app` con RLS activo: 7 rechazos esperados y los caminos felices.

**ws** — `npm test`: 40 tests (extracto de markdown, mensaje y lotes del push).
Y una prueba de INTEGRACIÓN del SQL real contra una BD creada desde `init.sql`
(43 aserciones entre las dos mitades): la regla de audiencia en los dos
sentidos, la regla congelada al publicar vs. las personas evaluadas en vivo,
publicar dos veces, marcar leído dos veces, archivar y baja lógica. El script
vivió en el scratchpad — no quedó en el repo.

**app** — `ng test`: 1167 tests en 88 archivos, incluidos los 25 del markdown
(con los intentos de inyección) y los 6 del store del residente. Manejada en el
navegador con mocks (`allowFakeAuth` temporal, revertido): se publicó un
comunicado de punta a punta y se comprobó que el residente de la Torre A NO ve
el de la Torre B, que el badge del nav baja al leer, que la vista previa escapa
`<script>` en el navegador real y que el diálogo de publicar repite audiencia,
alcance y extracto. Móvil 375 y tema claro incluidos.

**Lo que NO se pudo probar localmente:** el push de verdad (no hay service
worker en `ng serve`) y las descargas firmadas de adjuntos (storage-service no
corre en desarrollo; el mock devuelve un data URL).

## 9. Desviación consciente del plan

La **tarjeta de «Últimos comunicados» en el Home** (§3 del doc de la app) NO se
implementó. El Home de hoy no lee datos de ninguna feature: se arma solo con el
nav, la sesión y los pines, y meterle un store de `features/me` sería el primer
acoplamiento de esa clase. El aviso ya llega por dos caminos que sí existen —el
badge del nav, visible desde cualquier pantalla, y el atajo de la cuadrícula—,
así que se deja para decidir aparte en vez de forzarlo aquí.
