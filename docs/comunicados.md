# Comunicados — plan de BD, permisos y ws

> Documento hermano: `residguard_app/docs/comunicados.md` (pantallas). Si algo
> aquí choca con un `CLAUDE.md`, mandan las reglas del `CLAUDE.md`.
>
> Estado: **PLANEACIÓN** (2026-09-20). Nada implementado. Las decisiones
> marcadas ⚠ en §2 están recomendadas pero sin confirmar.

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

### 3.3 Entregables

- `06_communication_tables.sql` + renumerar roles a `07_` + bloque en `init.sql`
  (A/B) y grants/RLS en el Bloque C (`GRANT USAGE`, default privileges, 4
  políticas `tenant_scope_*`).
- `patch_announcements.sql` idempotente para staging/prod.
- Validación: BD desechable desde `init.sql`; init viejo + patch ×2 ≡ init nuevo.

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

1. **BD** — §3 completo + validación en BD desechable.
2. **Permisos** — los dos SQL + los dos espejos TS.
3. **ws operación** — grupos, comunicados, publish, reads, preview.
4. **ws residente + push** — `/me/announcements*`, notifier, tests de las
   funciones puras (mensaje, extracto).
5. **app operación** y 6. **app residente** — ver doc hermano.
7. **Verificación y despliegue** — orden: `patch_announcements.sql` (residguard_db)
   → `patch_announcements_platform.sql` (auth_db) → ws + app JUNTOS. Sin env nuevas.

## 7. Riesgos

- Renumerar `06_roles_and_security.sql` toca referencias en `CLAUDE.md` de la BD
  y comentarios de patches: hacerlo en un cambio aparte y primero.
- `announcement_reads` audita cada lectura en `audit.event_log`: volumen bajo
  hoy (5 cuentas), a vigilar si crece la adopción.
- Permiso por tripleta: quien administra dos comunidades publica en ambas
  (limitación ya conocida, §7 del CLAUDE.md).
