# Evidencias en gastos — plan

> 2026-10-19. Decisiones cerradas ese día (ver §9): solo operadores en v1,
> adjuntos opcionales, tope 5, sin orden, galería estilo comprobante
> (`evidence-files`) y se pueden quitar al editar. Implementación en curso.

## 1. Qué se quiere

Que un gasto (`billing.expenses`) pueda llevar **comprobantes adjuntos** (la
factura en PDF, la foto del ticket, el recibo del jardinero) y que esos
comprobantes se **vean** desde la pantalla de gastos: cuántos trae cada gasto,
y abrirlos (imágenes en pantalla completa, PDF descargable).

## 2. Lo que ya existe y se reutiliza

Hay tres adjuntos iguales en la plataforma, calcados columna por columna:

| Precedente | Tabla | Quién sube | Quién mira |
|---|---|---|---|
| Evidencias de pago | `billing.payment_evidence_files` | residente / ventanilla | operador y residente |
| Fotos de caseta | `access.visit_event_files` | vigilante | operador y residente |
| Comunicados | `communication.announcement_files` | operador | operador y audiencia |

Mecánica común (NO se inventa nada nuevo):

* Los **bytes viven en storage-service**. La SPA sube DIRECTO con el Bearer del
  usuario (`POST /v1/files`, permiso `storage.files.write`). residguard_ws solo
  guarda `storage_file_id` + espejo de metadata (`filename`, `content_type`,
  `size_bytes`, `sha256`).
* Al guardar, el ws **valida cada id contra storage** por el canal
  `X-Api-Key` (`storageClient.getFile`) y copia el espejo. Un id inexistente
  tumba el alta completa ANTES de escribir.
* La **descarga es brokered**: `GET …/files/:fileId/link` valida el alcance y
  emite un enlace firmado de vigencia corta (`storageClient.createDownloadLink`).
  Razón: el RBAC de storage es por app, no por recurso.
* En la SPA: `attachment-picker` (shared/ui) para elegir/fotografiar,
  `StorageRepository.upload` con path `expenses/<uuid>/<name>` (nonce aleatorio:
  storage REEMPLAZA en path ocupado), y una galería presentacional que recibe
  `files` + `previews` (mapa id → URL firmada) y emite `download`.

El precedente **más cercano es comunicados**: el operador redacta, adjunta,
y después puede EDITAR el conjunto (quitar un archivo, añadir otro). Los gastos
también se editan (PATCH), así que se copia ese contrato: `fileIds` es la lista
COMPLETA de lo que el gasto debe llevar (ids ya guardados + ids recién subidos);
lo que no viene se da de baja lógica.

## 3. Base de datos (`residguard_db`)

Patch nuevo `patch_expense_files.sql` + espejo en `04_billing_tables.sql` e
`init.sql`:

1. **Clave de tenant en `billing.expenses`**: hoy NO existe
   `uq_expenses_customer_id UNIQUE (customer_id, id)` (solo hay
   `idx_expenses_customer_id`). Es destino obligatorio de la FK compuesta
   (§3.3.5 del estándar), así que el patch la añade con
   `ALTER TABLE … ADD CONSTRAINT`. Sobre una tabla viva es barato (índice
   único nuevo). El `idx_expenses_customer_id` queda redundante; se puede
   dejar o retirar en el mismo patch (recomendado retirarlo, para que init≡patch).
2. **Tabla `billing.expense_files`**, calca de `access.visit_event_files`:
   `id`, `customer_id`, `expense_id`, `storage_file_id`, `filename`,
   `content_type`, `size_bytes`, `sha256`, columnas de control. FK compuesta
   `(customer_id, expense_id) → billing.expenses (customer_id, id)`, CHECKs de
   tamaño y sha256, índice único parcial `(customer_id, expense_id,
   storage_file_id) WHERE status <> 'deleted'`, índices por `expense_id`, por
   `(customer_id, sha256)` y `(status, created_at)`, dos triggers, RLS
   `tenant_scope_expense_files`, `GRANT SELECT, INSERT, UPDATE … TO role_app`.
   Sin `sort_order` (⚠ ver pregunta 4).
3. Sin SP nuevo ni cambio de firma: el alta de archivos es INSERT directo desde
   el ws, en la MISMA transacción que el gasto.
4. **Prod**: aplicar el patch antes de desplegar ws+app (el INSERT nombra la
   tabla). Verificar con `pg_dump` que init nuevo ≡ base vieja + patch, en BD
   desechable del contenedor `postgres`.

## 4. Permisos

**Sin códigos nuevos** (mismo criterio que las fotos de caseta):

* Adjuntar viaja con `expenses.create` / `expenses.update`.
* Ver y descargar, con `expenses.read`.
* Lo único que debe tener quien captura gastos es `storage.files.write`. En
  prod: `admin` ya tiene los 4 `storage.files.*` y `community_admin` tiene
  `storage.files.write`. Pendiente comprobar por consulta (túnel 5436) si
  algún usuario con `expenses.create` por permiso DIRECTO carece de
  `storage.files.write`; si lo hay, un patch de plataforma de una línea.
* Igual que en evidencias, la SPA **oculta** el picker sin
  `storage.files.write` (excepción a "nunca ocultar botones": los archivos suben
  ANTES de filar el gasto, así que un picker sin permiso costaría uploads
  huérfanos + 403).

## 5. API (`residguard_ws`, `expenses/v1`)

Contrato ensanchante (el cliente viejo sigue funcionando):

| Verbo | Cambio |
|---|---|
| `POST /communities/:id/expenses` | body + `fileIds?: uuid[]` (máx. N, ⚠ pregunta 3). Controller: `resolveFiles` contra storage → INSERT gasto → INSERT archivos, una transacción. |
| `PATCH …/expenses/:id` | body + `fileIds?: uuid[]`. `undefined` = no tocar; array = lista completa (`replaceFiles`: baja lógica de los que no están + INSERT de los nuevos; los ya guardados se reusan con su espejo sin preguntar a storage, como comunicados). |
| `GET …/expenses` y `GET …/expenses/:id` | `expenseV1V` + `files: [{id, filename, contentType, sizeBytes}]`. En la lista se carga con una segunda query `WHERE expense_id = ANY($1)` agrupada en memoria (no N+1, no JOIN que multiplique filas). |
| `GET …/expenses/:id/files/:fileId/link` **nuevo** | `expenses.read` + `requireCommunityAccess()`. Busca el archivo del gasto en la comunidad de la ruta → `createDownloadLink`. 404 si no es suyo; 503 `storage_unavailable` si storage no responde. Mismo shape que `evidenceFileLinkV1V` (`{url, expiresAt}`). |

Repository: `listFilesFor(expenseIds)`, `keptFiles(expenseId, ids)`,
`insertFiles(tx, customerId, expenseId, files)`, `replaceFiles(...)`,
`fileRef(communityId, expenseId, fileId)`. Baja lógica del gasto NO toca los
archivos (los bytes se quedan en storage; precedente comunicados).

Errores: id inexistente en storage → 400 `invalid` con mensaje legible
("Uno de los archivos adjuntos no existe o ya no está disponible"); storage
caído al validar → 503.

## 6. SPA (`residguard_app`, `features/expenses`)

### Dominio y datos
* `Expense.files: readonly ExpenseFile[]` (`id, filename, contentType,
  sizeBytes`). `ExpenseDraft.fileIds: readonly string[]` (los ya guardados que
  se conservan) — los archivos NUEVOS van aparte, como en comunicados.
* `ExpenseRepository`: `create/update` mandan `fileIds`; método nuevo
  `fileLink(communityId, expenseId, fileId): Promise<string>`.
* `ExpenseStore.save(id, draft, newFiles)`: sube cada `File` a storage
  (`expenses/<uuid>/<name>`), concatena ids y llama al repo. Un upload que
  falla aborta y muestra el `StorageRepositoryError`. `freshness.changed('expenses')`
  como hoy. Mock: `ExpenseMockRepository` guarda `files` y el mock de storage ya
  existente (`core/storage`) sirve los previews.

### Formulario (`expense-form`)
* Bloque **"Comprobantes"** al final del grid: galería de los archivos ya
  guardados (miniatura + nombre + botón quitar, que solo saca el id de
  `draft.fileIds`) + `attachment-picker` para los nuevos (`accept` = whitelist
  del bucket `receipts`: jpeg/png/webp/pdf, 10 MB, `cameraFilePrefix`
  "comprobante").
* `dirty` considera `fileIds` y la lista de nuevos. Submit emite `{draft,
  newFiles}`.
* Opcional, nunca bloquea (⚠ pregunta 2).

### Ver los comprobantes
* **Columna "Comprobante"** en la tabla (`card: 'meta'`): "2 archivos" / "—",
  con filtro enum `Con comprobante` / `Sin comprobante` (para que el admin
  encuentre lo que falta por respaldar).
* **Visor**: acción de fila con icono `paperclip` (y entrada del menú
  contextual) que abre un sheet "Comprobantes del gasto" en SOLO LECTURA,
  disponible con `expenses.read` — así un `community_reader` los ve sin abrir
  el editor. Reusa la galería (`evidence-files` de payment-evidence o
  `announcement-media`; ⚠ pregunta 5). El host pide los enlaces firmados al
  abrir (`previews` por id, `busyFileId` para la descarga de PDF), igual que
  el detalle de evidencia.
* En el editor, las miniaturas de lo ya guardado usan el mismo enlace firmado
  (se piden al abrir el modal).

### Otros
* `DataKey`/`DATA_IMPACT`: sin clave nueva (los archivos son parte del gasto).
* `index.html` ya permite `blob:` en img-src y las URLs firmadas de
  storage-ws, así que no hay cambio de CSP.
* Tests: dominio (`validateExpenseDraft` con fileIds, `expenseDraftEqual`),
  store (save con uploads en orden y rollback de UI si falla), formulario
  (quitar/añadir marca dirty).

## 7. Orden de entrega y despliegue

1. DB: patch + espejos + smoke init≡patch.
2. ws: verifier/repository/controller/routes + `pnpm tsc` + test manual con
   mocks de storage.
3. app: dominio → datos → store → form → columnas/visor → mocks → tests.
4. Prod: patch de BD → (patch de plataforma si hace falta) → ws y app
   JUNTOS (la app hace `files.map` sobre un campo nuevo). Sin push ni commit
   hasta que el usuario revise el diff.

## 8. Fuera de alcance (v1)

* Portal del residente ("a dónde se va mi cuota"): no existe `/me/expenses`
  hoy; sería pantalla, permisos `self_expenses.read` + `screens.my_expenses`
  y grant a `community_resident`. Se propone como fase 2 (⚠ pregunta 1).
* Obligatoriedad con escape (foto o motivo, como caseta).
* Borrar los bytes en storage al quitar un adjunto.
* OCR / lectura del monto desde la factura.

## 9. Decisiones (cerradas 2026-10-19)

1. **Quién los ve:** solo operadores en la pantalla de gastos. El portal del
   residente queda como fase 2 (§8).
2. **Opcionales.** El histórico no los tiene y una captura sin factura a la
   mano no se bloquea. El filtro "Sin comprobante" encuentra los pendientes.
3. **Tope: 5 archivos por gasto** (`EXPENSE_MAX_FILES`), igual que evidencias.
4. **Sin `sort_order`:** orden de subida (`created_at, id`).
5. **Galería `evidence-files`** (miniaturas + lightbox, PDF descargable): es un
   recibo, no un flyer.
6. **Sí se pueden quitar al editar** (precedente comunicados); el rastro
   queda en `audit`.
