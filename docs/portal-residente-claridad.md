# Portal del residente más claro — plan del ws (residguard_ws)

> Rama: `portal-residente-claridad` (sale de `staging`). Documento hermano:
> `residguard_app/docs/portal-residente-claridad.md`. Si algo aquí choca con
> `CLAUDE.md`, mandan las reglas de `CLAUDE.md`.
>
> Estado: **PLAN, sin implementar** (2026-09-18).

---

## 1. Qué se busca

El residente no entiende "unidad" ni tiene a la mano su recibo ni el comprobante
que originó cada pago. Este trabajo:

1. Deja de decir "unidad" al residente (push, y los datos que la app necesita
   para nombrar el domicilio por su tipo).
2. Le da al residente el detalle de un pago suyo, suficiente para que la app
   dibuje el MISMO recibo que emite el administrador.
3. Expone la evidencia ligada a un pago dentro del detalle del pago, para el
   residente y para el administrador.
4. Reescribe los avisos push y agrega el que falta: comprobante rechazado.

**Sin cambios de BD y sin permisos nuevos.** Se despliega JUNTO con la app (hay
campos nuevos de contrato que la app lee).

## 2. Vocabulario (regla única, compartida con la app)

| Caso | Texto | Ejemplo |
| --- | --- | --- |
| Se nombra UN domicilio concreto | tipo en minúscula + torre + código | `casa 426-A`, `departamento Torre B 302`, `lote 15` |
| Genérico, singular | `domicilio` | "tu domicilio" |
| Genérico, plural / menú | `domicilios` | "Mis domicilios" |

- El tipo sale de `community.units.unit_type` con las mismas etiquetas que la
  app (`UNIT_TYPE_LABELS`): apartment→departamento, house→casa, lot→lote,
  commercial_local→local comercial, parking→estacionamiento, storage→bodega.
- **Solo superficies del residente.** Todo lo administrativo (rutas
  `/communities/...`, mensajes de error de operador, logs) sigue diciendo
  "unidad".
- Helper nuevo y puro: `core/text/home_label.ts` →
  `homeLabel({ unitType, unitTower, unitCode })`. Lo usan los dos notifiers.
  Reemplaza al `unitLabel()` local de `visits_v1.notifier.ts`.

## 3. Endpoints

### 3.1 `GET /me/payments/:id` (NUEVO)

- Permiso: `self_statement.read` (el mismo de `GET /me/payments`).
- Alcance: cadena del padrón (`sub → members.user_id → unit_members → units`).
  El pago es "mío" si tiene al menos UNA aplicación activa sobre una unidad
  mía. Si no → 404 con la misma redacción que inexistente.
- Solo pagos `active` (un pago anulado no emite recibo y ya no viaja en la
  lista).
- Respuesta: **la misma forma que el detalle del operador** (`PaymentDetail`):
  `id, amount, method, paidAt, reference, cashAccount, status, createdByName,
  allocations[], createdAt, updatedAt` + `communityName` + `evidence` (§3.3).
- `allocations`: **todas** las del depósito, no solo las mías. Decisión tomada:
  el recibo imprime el depósito completo — un mismo folio con dos cifras
  distintas confunde. Cada aplicación trae además `unitType` y `unitTower`
  para que la app la nombre por tipo.
- Reusar el SELECT de aplicaciones de `payments_v1.repository.ts` (extraerlo si
  hace falta) en vez de escribir uno paralelo: el mismo cargo debe llamarse
  igual en el recibo del operador y en el del residente.

### 3.2 `createdByName` en el detalle de pago (operador y residente)

Hoy el detalle no resuelve `payments.created_by` y el recibo imprime "—" en
"Recibido por". JOIN a `core.users` por `(customer_id, id)` (PK compuesta) →
nombre para mostrar; `null` si no hay fila de espejo.

### 3.3 `evidence` dentro del detalle de pago

Campo nuevo en `GET /communities/:cid/payments/:id` y en `GET /me/payments/:id`:

```
evidence: null | {
  id, evidenceStatus, source,            // 'resident' | 'operator'
  files: [{ id, filename, contentType, sizeBytes }]
}
```

- Se resuelve por `billing.payment_evidence.payment_id` (índice único parcial:
  a lo más una evidencia por pago).
- Los enlaces firmados NO viajan aquí: la app los pide con los endpoints que ya
  existen (`/me/payment-evidence/:id/files/:fileId/link` y el equivalente de
  operador), que ya validan alcance.
- Operador: el campo solo se llena si el token trae `payment_evidence.read`;
  sin él viaja `null` (no es 403: el detalle del pago sigue siendo legible).
- Residente: solo si la evidencia es de una unidad suya (misma cadena).

### 3.4 `GET /me/payments` y `GET /me/units` — tipo de unidad

- `/me/payments`: `covers[]` gana `unitType` y `unitTower` (hoy solo `unitCode`).
  `unitCodes` se conserva por compatibilidad.
- `/me/units` ya trae `unitType`/`unitTower`: sin cambio.
- `/me/payment-evidence*` y `/me/visits*`: agregar `unitType` (y `unitTower`
  donde falte) a la fila, para que el detalle y el pase digan "casa 426-A".

## 4. Notificaciones push

Textos finales (título · cuerpo):

| kind | Título | Cuerpo | Al tocar |
| --- | --- | --- | --- |
| `payment_registered` | Recibimos tu pago | `$800.00 de tu casa 426-A. Cubre: Mantenimiento, Septiembre-2026.` | `/my-payments?payment=<id>` |
| `visit_arrived` | Llegó tu visita | `Juan Pérez entró por caseta y va a tu casa 426-A.` | `/my-visits` |
| `visit_exhausted` | Llegó tu visita | `Juan Pérez entró y va a tu casa 426-A. Su pase ya no tiene entradas. Si va a volver, créale uno nuevo.` | `/my-visits` |
| `visit_left` | Tu visita ya salió | `Juan Pérez salió por caseta.` | `/my-visits` |
| `evidence_rejected` (NUEVO) | Tu comprobante fue rechazado | `Motivo: <resolution_note>. Corrígelo y envíalo de nuevo.` | `/my-payments?tab=evidencias&evidence=<id>` |

Notas de implementación:

- `paymentMessage` necesita `unitType`, `unitTower` y los conceptos cubiertos
  POR unidad. `PaymentUnitNotice` gana `covers: string[]` (concepto + periodo,
  mismo alias que el estado de cuenta). Con más de 2 covers:
  `Cubre: Mantenimiento, Septiembre-2026 y 2 más.`
- `evidence_rejected`: se dispara en el controller de rechazo
  (`payment_evidence_v1.controller.ts`) DESPUÉS del commit, con
  `unitLinkedUserIds(tx, evidence.unitId)` igual que la verificación.
  `idempotencyKey` = `evidence-rejected:<evidenceId>`; TTL 7 días (como el
  pago). El motivo se recorta a ~140 caracteres para el cuerpo.
- Los `kind`, `tag` e `idempotencyKey` existentes NO cambian: solo el texto y la
  ruta del pago. La app ya navega por `url`.
- Actualizar las pruebas de los mensajes (`arrivalMessage`, `departureMessage`,
  `paymentMessage` son puras y exportadas justo para eso).

## 5. Orden de trabajo

1. `core/text/home_label.ts` + pruebas.
2. `createdByName` y `evidence` en el detalle de pago del operador.
3. `GET /me/payments/:id` (routes → verifier → controller → repository).
4. `unitType`/`unitTower` en `/me/payments`, `/me/payment-evidence*`, `/me/visits*`.
5. Notifiers: textos nuevos + `evidence_rejected`.
6. `tsc` + pruebas; smoke SQL contra una BD desechable creada de `init.sql`
   (la BD local está desactualizada).

## 6. Fuera de este repo (ya hecho, 2026-09-18)

Correos con **botón** en vez de URL a la vista, en `admin_project` (no es repo
git): invitación y aviso de acceso (`admin_ws/src/core/mailer/mailer.ts`) y
recuperación de clave (`auth_ws/src/core/mailer/mailer.ts`). El `text` plano
conserva la URL como alternativa. Falta redesplegar admin_ws y auth_ws.
