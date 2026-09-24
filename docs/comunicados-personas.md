# Comunicados — grupos por PERSONAS (plan v2)

> Extiende `docs/comunicados.md` (BD/ws) y `residguard_app/docs/comunicados.md`
> (pantallas). Si algo aquí choca con un `CLAUDE.md`, mandan las reglas del
> `CLAUDE.md`.
>
> Estado: **PLAN, sin implementar** (2026-09-22). Las decisiones ⚠ de §2 están
> pendientes de confirmar.

---

## 1. Qué se busca

Que un grupo de audiencia pueda ser **una lista de personas** («el comité»,
«los tres de la junta», «Ana y Luis»), además de la regla por tipo y torre que
existe hoy. El plan v1 lo dejó fuera a propósito («grupos de lista manual quedan
para v2 como otro tipo de grupo, sin romper el modelo»); dos cosas lo traen de
vuelta:

- En producción **0 de 86 unidades tienen torre**, así que del modelo v1 solo
  sirve en la práctica el eje de tipo, y con tres tipos no se describe un
  comité.
- Un comunicado dirigido a personas concretas es un caso real de administración
  (convocar a la mesa directiva, avisarle a los morosos de un edificio).

**Sigue fuera:** guardias y personal sin unidad (no están en el padrón, y la
audiencia sale del padrón), grupos anidados, y mezclar personas con regla en un
mismo grupo (ver §2.1).

## 2. Decisiones de diseño

1. ⚠ **Un grupo es por REGLA o por PERSONAS, no las dos cosas.** Un grupo por
   personas lleva `member_ids` y nada en `member_types`/`towers`; uno por regla
   lleva lo de hoy y `member_ids` NULL. La BD lo hace cumplir con un CHECK. Se
   descarta combinar («propietarios de Torre A, y además Ana») porque el alcance
   dejaría de poder decirse en una frase, y la pantalla tendría que explicar si
   Ana suma o filtra. Si algún día hace falta, es un CHECK menos, no un modelo
   nuevo.
2. **Sigue siendo el padrón el que manda.** `member_ids` apunta a
   `community.members` y la persona se evalúa EN VIVO igual que hoy: si se da de
   baja del padrón, sale del grupo sola; si pierde su unidad, también (el JOIN
   con `unit_members` activo se conserva). La lista dice QUIÉNES, el padrón dice
   si siguen contando. Es la misma razón por la que `towers` no tiene FK: un id
   que ya no existe en la lista es inofensivo, no una fila huérfana.
3. **Regla congelada, personas vivas — igual que hoy.** Al publicar se copia
   `member_ids` a `announcements.audience_member_ids`. Editar el grupo después
   no cambia a quién iba un comunicado publicado.
4. **Una sola definición de «¿está en la audiencia?»** — `AUDIENCE_MATCH_FROM`
   y `AUDIENCE_MATCHES_USER` ganan un tercer predicado y NADA más cambia de
   lógica: conteo, destinatarios del push, lista del residente y lecturas siguen
   saliendo del mismo fragmento.
5. **Arreglo, no tabla puente.** `member_ids UUID[]` sigue la forma de los otros
   dos ejes y hace trivial la copia congelada al publicar. Una tabla
   `audience_group_members` con FK sería más «correcta» y obligaría a una
   segunda tabla para el snapshot. Tope: **100 personas por grupo** (un comité
   son diez; más que eso es una torre, y para eso está la regla).
6. **El ws valida que las personas sean de la comunidad.** Al crear o editar:
   `count(*)` de `community.members` activos con esos ids y esa `community_id`
   debe ser igual a la cardinalidad; si no, 400 con el mensaje «N de las personas
   no están en el padrón de esta comunidad». Sin esto, un id de otra comunidad
   sería silenciosamente ignorado por el JOIN y el operador vería un alcance
   menor sin saber por qué.
7. **La respuesta trae nombres, no solo ids.** El grupo devuelve
   `members: [{ id, fullName }]` resueltos en vivo (solo los que siguen
   activos), para que la lista de grupos, el selector del editor y el alcance
   puedan decir «Ana Pérez, Luis Gómez y 3 más» sin una segunda petición. Los
   ids siguen viajando en `memberIds` para editar.
8. **Sin permisos nuevos.** Son los mismos `announcements.groups.*`; la
   paridad a cuatro lados no se toca.

## 3. Base de datos

### 3.1 `communication.audience_groups`

```sql
ALTER TABLE communication.audience_groups
    ADD COLUMN member_ids UUID[];                         -- NULL = grupo por regla

ALTER TABLE communication.audience_groups
    ADD CONSTRAINT ck_audience_groups_member_ids
        CHECK (member_ids IS NULL OR cardinality(member_ids) BETWEEN 1 AND 100),
    -- Por regla O por personas: nunca ambas, nunca ninguna.
    DROP CONSTRAINT ck_audience_groups_criteria,
    ADD CONSTRAINT ck_audience_groups_criteria CHECK (
        (member_ids IS NULL     AND (member_types IS NOT NULL OR towers IS NOT NULL))
     OR (member_ids IS NOT NULL AND  member_types IS NULL     AND towers IS NULL)
    );
```

`cardinality()`, nunca `array_length()` (la trampa ya documentada: un CHECK
NULL pasa). Sin FK sobre el arreglo (§2.2). `COMMENT ON COLUMN` diciendo que
NULL = grupo por regla y que la pertenencia se evalúa contra el padrón activo.

### 3.2 `communication.announcements`

```sql
ALTER TABLE communication.announcements
    ADD COLUMN audience_member_ids UUID[],                -- snapshot; NULL = sin filtro
    ADD CONSTRAINT ck_announcements_audience_member_ids
        CHECK (audience_member_ids IS NULL OR cardinality(audience_member_ids) > 0);
```

Sin CHECK de exclusividad aquí: el snapshot copia lo que el grupo tenía y el
grupo ya lo garantiza.

### 3.3 Entregables

- `06_communication_tables.sql`: las dos columnas y los CHECK en su sitio (no
  como ALTER al final), comentarios de cabecera de la tabla actualizados.
- `init.sql`: bloque B.9 idéntico (regla §16 de la BD: modular ≡ init.sql).
- `patch_announcements_people.sql`: idempotente con guardia sobre
  `information_schema.columns` (`member_ids` ya existe → `RAISE` y aborta),
  todo en UNA transacción, bloque DO de verificación al final. Sin grants ni
  RLS: las tablas y sus políticas no cambian.
- Validación como la v1: init.sql fresco vs init.sql de master + patch (dumps
  idénticos), patch aplicado dos veces (la segunda aborta en la guardia),
  cadena modular `pre_setup → 00…07` ≡ init.sql en `communication`.

## 4. ws — `api/announcements/v1` y `api/me/v1`

### 4.1 La regla (repositorio de announcements)

Los dos fragmentos exportados ganan el tercer eje; **cada consulta que los usa
pasa un parámetro más** (`$4::uuid[]`):

```sql
-- AUDIENCE_MATCH_FROM (comunicado → personas)
   AND ($4::uuid[] IS NULL OR m.id = ANY($4::uuid[]))
-- AUDIENCE_MATCHES_USER (persona → comunicados)
   AND (a.audience_member_ids IS NULL OR am.id = ANY(a.audience_member_ids))
```

Lugares que cambian, todos en `announcements_v1.repository.ts`:

| Pieza | Cambio |
| --- | --- |
| `WITH_EFFECTIVE_AUDIENCE` | `eff_member_ids` (borrador: del grupo; publicado: del snapshot) |
| `AUDIENCE_COUNTS_LATERAL` | tercer predicado sobre `a.eff_member_ids` |
| `GROUP_COLUMNS` / reach del grupo | `g.member_ids` y el predicado en el LATERAL del grupo |
| `publish()` | cuarto subconsulta escalar: `audience_member_ids = g.member_ids` |
| `audienceReach`, `audienceUserIds`, `listReaders` | pasan `rule.memberIds` como `$4` |
| `frozenRule` | devuelve también `audience_member_ids` (es lo que lee el notifier al publicar) |
| `createGroup` / `updateGroup` | columna `member_ids` (`::uuid[]`), y la validación de §2.6 antes del INSERT/UPDATE |
| `mapGroup` | `memberIds` + `members` (subconsulta `jsonb_agg` sobre `community.members` activos, ordenada por nombre) |
| `AudienceRule` (tipo) | `memberIds: string[] \| null` |

`me_v1.repository.ts` no cambia una línea: consume `AUDIENCE_MATCHES_USER`.
Ese es justamente el motivo de que la regla viva una sola vez.

### 4.2 Contrato

- **Grupo (entrada)** — `memberIds: string[] | null` (uuid, 1..100). El
  controlador aplica la exclusividad antes que la BD, con mensaje: «Un grupo es
  por regla o por personas, no las dos cosas» (400). Sin criterio alguno sigue
  siendo 400 con el mensaje de hoy.
- **Grupo (salida)** — `memberIds: string[] | null` y
  `members: { id: string; fullName: string }[]` (vacío en grupos por regla).
- **Vista previa** — `GET …/audience-groups/preview?memberIds=a,b,c` (misma
  forma que `memberTypes`/`towers`: lista separada por comas; `maxLength` 3700
  = 100 uuid). El controlador rechaza mezclar `memberIds` con los otros dos.
- **Comunicado (salida)** — `audienceMemberIds` junto a `audienceMemberTypes`
  y `audienceTowers`, para que el detalle del operador pueda nombrar a quién fue
  aunque el grupo ya no exista. Sin nombres aquí: el detalle ya trae la lista de
  lecturas, que es la misma gente con nombre y domicilio.
- El **residente** no ve nada nuevo: su lista y su detalle no exponen la
  audiencia (decisión v1: quién más lo recibió no es asunto del lector).

### 4.3 Tests

- `announcements_v1.repository` (integración contra BD de init.sql, como en
  v1): grupo por personas → alcance = las que están activas y con unidad; una
  se da de baja → sale del conteo y del push; publicar congela la lista y
  editar el grupo después no la cambia; id de otra comunidad → 400.
- Verifier: exclusividad (400 en las dos direcciones), tope 100, uuid inválido.
- `notifier.test.ts` no cambia: los destinatarios salen de `AUDIENCE_MATCH_FROM`.

## 5. App — `features/announcements/`

### 5.1 Dominio

- `AudienceGroup`: `memberIds: readonly string[] | null` y
  `members: readonly { id; fullName }[]`.
- `AudienceGroupDraft`: `kind: 'rule' | 'people'` + `memberIds`. El `kind` es
  solo de la UI (decide qué mitad del formulario se ve); al mandar, la mitad que
  no aplica viaja vacía → `null`.
- `validateAudienceGroupDraft`: por personas, «Elige al menos una persona» y el
  tope; por regla, lo de hoy.
- `describeGroup` / `describeReach`: «Ana Pérez, Luis Gómez y 3 más» (dos
  nombres y el resto contado; con ≤3, todos). La misma frase en la lista de
  grupos, en el selector del editor y en el diálogo de confirmación de publicar.

### 5.2 Formulario del grupo (`ui/audience-group-form`)

- Un **selector de modo** arriba (dos botones de segmento, mismo patrón que los
  filtros Todos/Faltan/Leyeron del detalle): «Por regla» / «Por personas». Al
  cambiar de modo se conserva lo tecleado en el otro hasta guardar, pero solo
  viaja el modo activo.
- **Por personas:** `<autocomplete>` sobre `MemberRepository.list(communityId)`
  (el mismo que usa el formulario de pago para la unidad), buscando por nombre y
  domicilio; cada elección se vuelve una **ficha con iniciales y una ×** debajo
  del campo (el trato de contactos que el usuario ya aprobó en Mis visitas: sin
  colores variados). Quien no tiene cuenta lleva la marca «sin cuenta» en la
  ficha — no se le quita, pero el operador ve que a esa persona el push no le
  llega.
- El **alcance en vivo** (`preview`) sigue funcionando igual: se relanza con
  `memberIds` en vez de la regla.
- `MemberRepository` se inyecta en el **contenedor** (`announcements.ts`), que
  le pasa al formulario las opciones ya armadas — el formulario sigue siendo
  presentacional (CLAUDE.md §4).

### 5.3 Lo demás

- Lista de grupos: la ficha del grupo dice la frase de §5.1 y un ícono distinto
  (`users` vs `filter`) para que por regla y por personas se distingan de un
  vistazo.
- Editor del comunicado: el selector de grupos y el alcance no cambian de
  forma; solo la frase.
- Detalle del operador: «Audiencia: Comité (Ana Pérez, Luis Gómez y 3 más)».
- Mocks: `SEED_GROUP_IDS[2]` = «Comité» con tres personas del `SEED_ROSTER`,
  reach calculado con el mismo predicado que ya simula el mock. `fileReplacements`
  y providers no cambian (mismos repositorios).
- Doc hermano (`residguard_app/docs/comunicados.md`) §2 y §6, y versión
  `0.0.82` (o la que toque al momento de desplegar).

## 6. Fases

1. **BD** — 06_, init.sql B.9, `patch_announcements_people.sql`, validación
   con BD desechable. STOP para revisión del diff.
2. **ws** — repositorio (§4.1), verifier y controlador (§4.2), tests (§4.3).
   `docs/comunicados.md` §5 actualizado con el contrato.
3. **App** — dominio, formulario, lista, editor, detalle, mocks, doc hermano.
   Verificación en navegador con mocks: crear «Comité», ver el alcance, publicar
   un borrador hacia él, y comprobar como residente que una persona del comité lo
   ve y una que no, no.
4. **Despliegue** — `patch_announcements_people.sql` en `residguard_db` de
   producción (solo lectura primero, como siempre) → ws + app JUNTOS. Sin
   cambios en `auth_db` ni en `admin_project`: no hay códigos nuevos.

Las reglas de trabajo son las de siempre: rama `comunicados`, sin commits hasta
que se pida, sin Prettier sobre archivos existentes, `git status` antes de
tocar.

## 7. Riesgos

- **Una persona en dos grupos** (uno por regla, otro por personas) recibe DOS
  comunicados si se publican dos; es lo esperado, no se deduplica entre
  comunicados. Dentro de un mismo comunicado el `DISTINCT` del conteo y del
  push ya cubren a quien tiene dos unidades.
- **Lista con gente sin cuenta.** Con 4 de 137 personas con cuenta en prod, un
  comité de cinco puede tener cero lectores posibles. El alcance ya dice «N con
  cuenta · M en el padrón»; la marca «sin cuenta» en la ficha (§5.2) lo dice
  antes de guardar.
- **Snapshot con ids que ya no existen.** Un comunicado publicado a un comité
  cuya persona se dio de baja sigue guardando su id; es correcto (dice a quién
  iba) y no rompe nada (el JOIN la descarta). El detalle del operador la mostrará
  en «Faltan» solo mientras esté activa, igual que hoy.
- **Tamaño del querystring del preview:** 100 uuid son ~3.7 KB, lejos del
  límite de cabeceras de Node (16 KB). El tope de 100 viene del CHECK, no del
  transporte.
