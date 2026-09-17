# Tanda 7 · Importación masiva de reservas desde CSV o XLSX · Cierre, correcciones y demo de Rías Altas — 16/17 de septiembre de 2026

**Para:** César. **Encargo (16/09/2026):** «poder subir reservas en bulk partiendo de un formato Excel o CSV».
**Método:** documento de diseño escrito antes de codificar (`docs/design/RESERVAS-IMPORTACION-MASIVA.md`) →
lotes L0 (schema, migración, tipos) → L1 ∥ L4 ∥ L5 (lector XLSX sin dependencias + parser + mapeo +
normalización; pestaña «Importar» del front; runbook) → L2 (servicio, disponibilidad, plantilla, tres
parámetros aditivos de `createReservation`) → L3 (rutas, permisos, esquemas, CLI, `api-contracts.md`) →
L6 (primera demo, 17/09 01:15-01:30 CEST) → **ronda de revisión** (9 hallazgos confirmados por los revisores
funcional, de seguridad y de front, todos corregidos, §4) → **integración final (este documento, 17/09
02:30-02:50 CEST):** demo rehecha con el código corregido (dry-run → apply → idempotencia → segundo lote desde
XLSX → deshacer), verificación SQL, puertas completas, inventario Cocoa 22 regenerado y decisiones abiertas.
Todo sobre la demo local (Postgres local; API :3000 y Vite :5173 **sin reiniciar**: :3000 sirve el código
anterior y responde 404 a las rutas nuevas; el CLI usa su propio proceso con el código del working tree).

**Resultado en una línea:** el fichero `reservas-demo-rias-altas.csv` (30 reservas ficticias, huéspedes
`@example.com`) está importado en Rías Altas como lote **`cmu4t43gh0000fyu01qbc20ri`** (`imported`, 30 creadas
= **29 `confirmed` + 1 `cancelled`**, RES-00121 → RES-00150, 11.362,40 €, 5 habitaciones asignadas, 27 huéspedes
nuevos + 3 reutilizados, autor `usr_system_reservation_import`); el mismo contenido como `.xlsx` da **el mismo
hash** y su reimportación devuelve **409 `RESERVATION_IMPORT_DUPLICATE`** sin escribir nada; un segundo lote de 5
filas importado **desde XLSX** (`cmu4t4ygm0000fywcuis0txkx`) se **deshizo** (5 canceladas · 0 conservadas ·
`undone`; el segundo deshacer responde `alreadyUndone`); cupo tipo × noche nunca excedido; ninguna fila
persistida lleva datos personales ni «[valor omitido]»; invariantes de Faranda intactas (**25 facturas · 33
envíos VeriFactu · 109 asientos · 1 lote de nómina**). **Las 9 puertas en verde** (§3). Solo queda el reinicio
del API :3000, que hace el orquestador (§8).

## 1. Alcance y qué cambia

| Tema | Antes | Ahora (working tree 17/09) |
|---|---|---|
| Carga masiva de reservas | Solo la rooming list de grupos (`tx.reservation.create` directo: sin huésped, sin folio, sin disponibilidad) y el alta unitaria | Pestaña Recepción › Reservas › **Importar** (`/recepcion/reservas/importar`), 6 rutas `/properties/:propertyId/reservations/imports*` y CLI `reservations:import`; cada fila nace por **`createReservation`** (lock por tipo, disponibilidad, código con reintento, huésped principal, folio, auditoría, evento) |
| Formato | — | Plantilla oficial CSV (BOM, «;», CRLF, 33 columnas + 2 ejemplos) y XLSX (hoja «Reservas» + «Instrucciones»); ficheros de terceros por **mapeo de columnas** con sinónimos ES/EN; separador `;` `,` tab `\|` autodetectado; UTF-8 o Windows-1252; XLSX leído sin dependencias (`lib/xlsx-lite.ts`) con guarda contra notaciones científicas gigantes (SEC-T7-01) |
| Seguridad de la carga | — | Preview idéntica al commit, disponibilidad con la **misma regla de rango** que el PMS, duplicados en fichero y en BD (referencia sin distinguir mayúsculas), idempotencia por hash (409; el hash no depende del día ni de «histórico») y por `referencia_externa` (fila omitida), lote `processing` antes de la primera reserva, **deshacer** por `bookingSource = import:<id>` con reclamación de 15 min |
| Fechas pasadas | — | La frontera es **hoy en la zona horaria de la propiedad** (la misma que `createReservation`), no la fecha de negocio; si la fecha de negocio va por detrás, la preview lo avisa (T7-FUN-01) |
| Datos personales | — | El fichero no se guarda; `reservation_import_rows` guarda solo nº de fila, referencia, fechas, tipo/tarifa, código o error; los mensajes citan columna y fila, nunca valores: la red de seguridad borra solo valores **personales** y como token completo (T7-FUN-02; §4.2 para el ajuste de la integración); el informe CSV de la pantalla neutraliza fórmulas (SEC-T7-02) |
| Correos | — | `bookerEmail` **nunca** se rellena (0 de 30 en la demo): un lote no dispara la plantilla `reservation_confirmed` |
| Modelo | — | Enum `ReservationImportStatus` (5 valores) + `reservation_imports` / `reservation_import_rows`; migración `20260916130000_reservas_importacion` (1 tipo, 2 tablas, 7 índices, 1 FK cascade); `Reservation` sin columnas nuevas |
| Front | — | `ReservationImportScreen` (asistente de 4 pasos, **0 `style={`**, 0 puntos de deuda Cocoa 22), acción «Importar reservas» en la lista y en ⌘K solo para los roles con la pestaña, autor del lote siempre con etiqueta («Sistema · importación masiva de reservas»), foco y región viva accesibles |

## 2. Lotes y ficheros (working tree, sin commit)

| Lote | Ficheros | Nota |
|---|---|---|
| L0 · Schema, migración, tipos | `packages/database/prisma/schema.prisma` (+108); `prisma/migrations/20260916130000_reservas_importacion/migration.sql` (132); `packages/shared/src/reservation-import-types.ts` (nuevo), `index.ts` (+4) | 10/10 migraciones · drift 0 |
| L1 · XLSX-lite, parser, mapeo, normalización | `apps/api/src/lib/xlsx-lite.ts` + `__tests__/xlsx-lite.test.mts`; `modules/pms/reservation-import.{parser, mapping, normalize}.ts` + `__tests__/reservation-import-{parser, mapping, normalize}.test.mts` | puros, sin BD |
| L2 · Servicio, disponibilidad, plantilla, `createReservation` aditivo | `modules/pms/reservation-import.{service, availability, template}.ts`; `pms.service.ts` (`primaryGuestId`, `allowOverbooking`, `historical`, `todayInTimezone` exportado, `deletedAt: null` en la búsqueda por documento); `__tests__/reservation-import-{availability, service, template}.test.mts`; `tests/integration/reservation-import.test.mts` | — |
| L3 · Rutas, permisos, esquemas, CLI, docs API | `modules/pms/reservation-import.routes.ts`, `route-permissions.partial.ts`; `security/route-permissions.ts`; `server.ts`; `lib/tenancy.ts`; `schemas/reservation-import.schemas.ts` + tests; `scripts/import-reservations.ts`; `apps/api/package.json` (`reservations:import`); `docs/api-contracts.md` (bloque «Importación masiva de reservas (Tanda 7)» bajo «PMS»); `tests/integration/reservation-import-routes.test.mts` | 6 rutas |
| L4 · Front | `screens/reservations/ReservationImportScreen.tsx` (999 líneas, **0 `style={`**), `reservation-import-helpers.ts`, `__tests__/reservation-import-{helpers, screen-contract}.test.mts`; `services/reservationImportApi.ts`; `ReservasTabs.tsx`, `ReservationsListScreen.tsx`, `CocoaGlobalProvider.tsx`, `App.tsx`, `nav-tree.generated.json`, tests de rutas/árbol; `screens/accounting/actor-label.ts` (etiqueta del actor de sistema); `<raíz git>/pilots/{tanda5-nav-tree.csv, screens-inventory.csv}` | 189/189 URL |
| L5 · Docs | `docs/design/RESERVAS-IMPORTACION-MASIVA.md` (nuevo); `docs/runbooks/reservas-importacion.md` (nuevo) | — |
| Ronda de revisión | Correcciones de §4 sobre los ficheros anteriores (`normalize.ts`, `service.ts`, `pms.service.ts`, `xlsx-lite.ts`, `import-reservations.ts`, helpers y pantalla del front, `actor-label.ts`, tipos compartidos, docs) | 9 hallazgos + 7 adicionales |
| Integración final (este documento) | `reservation-import.normalize.ts` (+12: `FREE_TEXT_FIELDS`, §4.2) y su test (+14); `docs/runbooks/reservas-importacion.md` (§2.5 ficheros de demo, §15 regla de enmascarado); `docs/design/RESERVAS-IMPORTACION-MASIVA.md` (principio 10); `docs/design/cocoa-22-inventory.json` y §6 de `COCOA-22-MIGRACION.md` (regenerados); este informe. Fuera del repo (`<raíz git>/pilots/faranda-celuisma/`, git-ignored): `reservas-demo-rias-altas.csv` (30 filas · 7.219 bytes), `reservas-demo-rias-altas.xlsx` (8.220 bytes, `--export-xlsx`), `reservas-demo-rias-altas-lote2.csv` (5 filas · 1.438 bytes), `reservas-demo-rias-altas-lote2.xlsx` (3.738 bytes) y `RESERVAS-DRY-RUN-2026-09-16.md` (salida íntegra del CLI + SQL, 72 KB). El fichero `reservas-demo-rias-altas-undo.csv` de la primera demo se retiró (sustituido por `-lote2`) | BD local escrita en 4 pasos (undo del lote antiguo · apply · apply · undo) |

`pnpm-lock.yaml` figura modificado desde antes de la tanda; ningún lote lo ha tocado. En el árbol hay además
cuatro documentos de diseño sin seguimiento ajenos a esta tanda (`DOCUMENTOS-DIGITALIZACION.md`,
`FINANZAS-IMPORTACION-SAGE200.md`, `OPERA-CLOUD-MODO-SOMBRA.md`, `REPUTACION-REVIEWS.md`): el orquestador
decide si entran en este commit. `CLAUDE.md` no se ha tocado (§10-12).

## 3. Puertas (17/09/2026 02:30-02:50 CEST, working tree completo tras la ronda de revisión y la corrección de §4.2, sin commit)

| # | Puerta | Comando | Resultado |
|---|---|---|---|
| 1 | Typecheck de todo el workspace | `corepack pnpm run typecheck:all` | **15 PASS · 0 FAIL · 0 XFAIL · 1 SKIP** explícito (`apps/guest-web`, deuda conocida) · 16 workspaces · 19,6 s |
| 2 | Unitarios API | `corepack pnpm --filter @hotelos/api test` | **1.735 tests · 1.734 pass · 0 fail · 1 skipped** (preexistente) · 530 suites · 11,2 s. Baseline del brief 1.597/1.598 → +137 tests de la tanda (xlsx-lite, parser, mapeo, normalización, disponibilidad, servicio, plantilla, esquemas, rutas, más los de la ronda de revisión y el de §4.2) |
| 3 | Unitarios front | `cd apps/api && TSX_TSCONFIG_PATH=../admin-web/tsconfig.json node --import tsx --test $(find ../admin-web/src -path '*/__tests__/*.test.mts')` | **1.048 tests · 1.048 pass · 0 fail** · 316 suites. Baseline 1.017 → +31 (helpers, contrato de pantalla, rutas, árbol, `actor-label` con el actor nuevo) |
| 4 | Contratos raíz | `node --test tests/*.test.mjs` | **445 · 445 pass · 0 fail** (`api-route-permissions-contract`, `rbac-nav-contract`, `nav-tree-contract`, `admin-web-spanish-copy-contract`, `admin-web-no-raw-fetch`, `cocoa-22-contract`…) |
| 5 | Discoverability | `node scripts/check-discoverability.mjs` | **OK**: 224 pantallas escaneadas · **189/189 URL** cubiertas (188 → 189: nueva `/recepcion/reservas/importar`) · sidebar literals 0 · whitelisted 32 · route-validity: `SCREEN_COMPONENTS` 213, árbol 67/99/21/2 = 189, alias 24, enlaces rotos 0 · placeholders 16/20 |
| 6 | Árbol de navegación | `node scripts/build-nav-tree.mjs --check` | al día: 67 ítems · **99 pestañas** (98 + «Importar») · 205 redirecciones |
| 7 | Inventario Cocoa 22 + contrato | `node scripts/cocoa-22-inventory.mjs` · `node scripts/cocoa-22-waves.mjs --write` · `node --test tests/cocoa-22-contract.test.mjs` | 224 pantallas · 91.375 líneas · **313 puntos (sin crecer)**; `ReservationImportScreen.tsx` **0 puntos** (999 líneas, arquetipo asistente, 0 `style={`, 0 `<button>`/`<table>`/`<input>` crudos, 0 colores literales, cabecera Cocoa, `useTabHost`); techos `GLOBAL_CEILING` intactos: bo-card 26 · bo-* 78 · `<button>` 12 · `<table>` 3 · inputs crudos 4 · `style={}` 801 · colores literales 2; §6 de la migración: 10 pendientes · 129 puntos · 1 lote; **18/18** (regla 15 «inventario al día» incluida) |
| 8 | Migraciones Prisma | `corepack pnpm --filter @hotelos/database db:migrate:status` · `db:drift:check` | **10 migraciones · «Database schema is up to date!» · «No difference detected.»** |
| 9 | Integración API (Postgres local) | `cd apps/api && node --env-file-if-exists=../../.env --import tsx --test "../../tests/integration/*.test.mts"` | **390 tests · 384 pass · 0 fail · 6 skipped** · 78 suites · 31,0 s (skips: H2 folio sin seed 1, `INTEGRATION_RECEPTION_EMAIL` 4, `INTEGRATION_FNB_EMAIL` 1). Re-ejecución tras la corrección de §4.2 de las dos suites de la tanda: `reservation-import.test.mts` + `reservation-import-routes.test.mts` **21 tests · 20 pass · 0 fail · 1 skipped** (F&B) |
| 10 | Hash CSV = hash XLSX | dry-run de los dos ficheros (§5.2-5.3) | **`479702c0a3613fff47e356fba7e23b343b31e401d405c51a85a61e45c64e6c45`** en ambos; salida del dry-run idéntica línea a línea (`diff` vacío) |
| 11 | Lote 1 | `--apply` (§5.4) | `createdCount` **30** · `skippedCount` **0** · `errorCount` **0** · `warningCount` 8 · `imported` · `createdBy` **`usr_system_reservation_import`** |
| 12 | Reimportación | dry-run y `--apply` del XLSX sin `--force` (§5.5) | blocker y **409 `RESERVATION_IMPORT_DUPLICATE`** · exit 1 · «Nada escrito» |
| 13 | Lote 2 desde XLSX y deshacer | `--apply` del `.xlsx` + `--undo` × 2 (§5.6) | `format xlsx` · 5 creadas · `undoneCount` **5** · `undoKeptCount` **0** · `undone` · segundo `--undo` → `alreadyUndone` |
| 14 | Invariantes Faranda | SQL §6 | **25 · 33 · 109 · 1** antes del primer comando y después del último (también tras las suites de integración) |
| 15 | Filas persistidas sin datos personales | SQL §6 | **0** filas de los lotes nuevos con nombre, e-mail, teléfono, documento ni «[valor omitido]» |

`allGreen: true`. El reinicio del API :3000 (§8.1) no es una puerta sino el paso que falta para que :3000 sirva el
código nuevo (hoy `GET …/reservations/imports` responde 404 en :3000 y 200 en la app montada en proceso).

## 4. Hallazgos de la ronda de revisión y correcciones

### 4.1 Hallazgos confirmados por los revisores (todos corregidos antes de esta integración)

| Id | Hallazgo | Corrección (verificada) |
|---|---|---|
| **T7-FUN-01** | La frontera «llegada pasada» usaba la fecha de negocio (2026-09-13 en Rías Altas, night audit sin ejecutar) y `createReservation` usa **hoy** en la zona horaria de la propiedad: la preview aceptaba filas que el commit rechazaría | `ReservationImportCatalogs.today` (= `todayInTimezone(property.timezone)`, exportado desde `pms.service.ts`) decide `PAST_ARRIVAL` / `HISTORICAL` / `IN_HOUSE_PAST` / `FAR_FUTURE`; `businessDate` queda informativa y, si va por detrás, la preview añade un aviso de fichero (visible en la demo: «La fecha de negocio de la propiedad (2026-09-13) va por detrás del calendario (hoy 2026-09-17)…»). La preview devuelve `today`; el CLI lo imprime; la pantalla dice «hoy en la propiedad» |
| **T7-FUN-02** | `stripRowValues` enmascaraba cualquier celda del fichero que apareciera en un mensaje (códigos de catálogo, trozos de palabra): ««Estado» [valor omitido]» en la primera demo | `personalValuesOf` devuelve solo las celdas personales y `stripRowValues` sustituye solo tokens completos (`giu`, lookbehind/lookahead `\p{L}\p{N}`); el servicio guarda `personalValues` por fila. Ajuste adicional de la integración en §4.2 |
| **SEC-T7-01** | DoS en el lector XLSX por notación científica gigante (`9E900000000`) | `xlsx-lite.ts` `MAX_SCIENTIFIC_DIGITS = 400`: se conserva como texto con aviso «se conserva como texto»; tests unitarios y de lector con libro sintético (< 500 ms) |
| **SEC-T7-02** | Inyección de fórmulas en el informe CSV que descarga la pantalla (`=HYPERLINK`, `+1+1`, `@SUM`) | `csvCell` (front) antepone `'` y entrecomilla toda celda de texto que empiece por `= + - @ tab CR`; los números no se tocan. `csv.ts` del API **no** cambia (rompía la plantilla oficial: «+34 600 111 001» → `PHONE_DROPPED`); documentado en su comentario |
| **FUX-01** | Puerta front roja: faltaba la etiqueta del actor `usr_system_reservation_import` | `actor-label.ts`: `usr_system_reservation_import: "importación masiva de reservas"` + `LEGACY_SYSTEM_ACTOR_IDS` (traduce el antiguo `createdBy "cli:import-reservations"` de los lotes de la primera demo) |
| **FUX-02** | «Autor» del lote con id crudo en la lista de importaciones | CLI: `CREATED_BY = SYSTEM_USER_ID` (el lote 1 de esta demo lleva `usr_system_reservation_import`; `deviceId "cli:import-reservations"`); front: `importAuthorLabel(createdBy, session)` con `useCurrentUserProfile()` |
| **FUX-03** | Un fallo de re-preview borraba la preview anterior | Se conserva la preview con el callout de error; `previewStale` deshabilita «Importar» hasta una re-preview correcta |
| **FUX-04** | Mapeo de columnas a ciegas (sin ejemplo por columna) | API: `ReservationImportPreviewRow.cells` (celdas crudas ≤ 200 caracteres, solo en la muestra, nunca persistidas); front: `exampleForColumn` con fallback a `exampleForField` |
| **FUX-05** | Preview obsoleta tras importar (pasos 2-3 alcanzables) | `discardPreview()` tras el 201; solo queda «Nueva importación» |

Hallazgos adicionales cerrados en la misma ronda: **T7-FUN-03** (el hash cambiaba con «histórico»/el día:
`contentHashRowsOf` normaliza sin frontera temporal; verificado en la demo: mismo hash CSV/XLSX), **T7-FUN-04**
(`referencia_externa` contra BD sin distinguir mayúsculas), **T7-FUN-05** (huésped borrado no se reutiliza por
documento en `createReservation`), **T7-FUN-06** (deshacer un lote `processing` en curso → 409
`RESERVATION_IMPORT_UNDO_IN_PROGRESS` durante 15 min; el cierre del commit no pisa `undone` y cancela las
creaciones tardías), **T7-FUN-07** (`allowOverbooking` se pasa a `createReservation` siempre que la opción
esté activa), **FUX-07** (bloqueos duplicados en la pantalla), **FUX-08** («Deshacer» exige solo
`pms.reservation.modify`), **FUX-09** (botón «Importar reservas» solo para los roles con la pestaña), **FUX-10**
(una única `CocoaLiveRegion`, región de paso con foco).

### 4.2 Corrección de la integración: palabras de «notas» y «peticiones» mutilaban los mensajes (T7-FUN-02 bis)

En el primer dry-run de esta integración, con el código de la ronda ya aplicado, tres avisos seguían mostrando
«[valor omitido]»: fila 5 «…con la nota interna «[valor omitido] con el cliente»» (la nota de la fila decía
«Confirmar antes del 20/10»), fila 6 «…serial numérico de [valor omitido]: comprueba la [valor omitido]» (nota
«Fecha copiada como número de serie de Excel») y fila 19 ««Estado» [valor omitido]» (nota «Cancelada por la
clienta el 10/09»). Causa: `personalValuesOf` tokenizaba también `peticiones` y `notas`, y cualquier palabra
corriente de una nota («confirmar», «fecha», «Excel», «cancelada», «con», «del»…) se borraba del mensaje de su
propia fila. Corrección (`reservation-import.normalize.ts`, +12 líneas): `FREE_TEXT_FIELDS = { peticiones, notas }`
se protegen **solo como celda completa**; los campos de identidad (nombre, apellidos, e-mail, teléfono,
documento) siguen como celda y como palabras ≥ 3 caracteres, así que un nombre o documento escrito dentro de
una nota sigue cubierto. Test nuevo en `reservation-import-normalize.test.mts` («las palabras de «notas» y
«peticiones» no mutilan los mensajes de la fila»); el test T7-FUN-02 existente se ajusta (la nota «Llega tarde,
cuna» aporta solo la celda). Tras el cambio: **0 «[valor omitido]»** en el dry-run, en el apply y en las 35
filas persistidas de los dos lotes nuevos (SQL §6). Runbook §15 y diseño (principio 10) actualizados. Puertas
2, 1 y 9 (suites de la tanda) re-ejecutadas en verde. Las 2 filas con «[valor omitido]» que quedan en
`reservation_import_rows` pertenecen al lote de la primera demo (`cmu4q4uwy…`, ya `undone`): son datos
persistidos por el código anterior, no código.

### 4.3 Observaciones (no bloquean)

1. **Fecha de negocio atrasada.** `business_dates."current_date"` de Rías Altas es 2026-09-13 (hoy
   2026-09-17): la auditoría nocturna no se ha ejecutado cuatro días. El importador avisa y trata como pasadas
   las llegadas anteriores a **hoy** (T7-FUN-01); ninguna fila de la demo lo es. Decisión §10-11.
2. **Cadena de auditoría en memoria (deuda 12(c)).** Los cuatro comandos que escriben (`--undo` del lote
   antiguo, `--apply` × 2, `--undo`) se ejecutaron con el API :3000 arriba (sirve el código anterior; no lo
   reinicia este lote), como en la Tanda 6c: el CLI hidrata la cadena desde Postgres y vacía las colas al
   terminar; :3000 rehidrata al reiniciar. `audit_events` 16.844 → 16.923 (demo) → 16.943 (suites de integración).
3. **Deshacer no borra fichas de huésped.** El lote 2 creó 1 huésped nuevo («Vera Lindqvist», ficticia) y
   reutilizó 4; tras el deshacer la ficha nueva sigue en la organización (56 → 84 huéspedes en total con los
   27 del lote 1). Es coherente con la cancelación del PMS; decisión §10-10.
4. **Referencias de reservas canceladas.** Tras deshacer el lote antiguo, sus 30 referencias
   (`IMP-RA-2026-001…030`) vuelven a estar disponibles con aviso `REFERENCE_REUSED_CANCELLED`; la demo nueva usa
   `101…130` para que César vea filas «válidas» sin ese aviso. Tras el apply, el XLSX equivalente muestra 29
   omitidas por referencia activa + 1 a crear (fila 19, cancelada) + el blocker de hash (§5.5).
5. **Regla de rango frente a cupo por noche, histórico y overbooking** no se ejercitan sobre Faranda a
   propósito (120 habitaciones, sin llegadas pasadas ni cupo que exceder); cubiertos por
   `reservation-import-availability.test.mts` y `tests/integration/reservation-import.test.mts` (org aislada).
6. **`deposit_amount`**: `NULL` con la celda vacía (RES-00126, RES-00145) y `0.00` con «0» (RES-00121);
   coherente con el alta por pantalla.

## 5. Demo de Rías Altas: dry-run → XLSX → apply → idempotencia → lote 2 desde XLSX → deshacer

Todo desde `hotelos/apps/api` con `node --env-file-if-exists=../../.env --import tsx
src/scripts/import-reservations.ts …` (`--property cmrhw9jy40003fyvbuu2ec2w7`); salida íntegra en
`<raíz git>/pilots/faranda-celuisma/RESERVAS-DRY-RUN-2026-09-16.md`.

### 5.0 Estado previo y retirada del lote de la primera demo

Antes de tocar nada: invariantes 25 · 33 · 109 · 1, 56 huéspedes en la organización, 16.844 `audit_events`,
último código RES-00120, 2 lotes en toda la BD (`cmu4q4uwy…` `imported` 30/30 de la primera demo, creado con
el código anterior, y `cmu4q6u0t…` `undone`). Como pedía la ronda de revisión, el lote `cmu4q4uwy0000fyezs6bxnt2v`
se deshizo con el CLI (`--undo … --reason "Demo rehecha con el código corregido (ronda 1)…"`, 00:39:48 UTC): **29
canceladas · 0 conservadas** (RES-00104 ya estaba cancelada desde el fichero), lote `undone`.

### 5.1 Fichero de demo (`reservas-demo-rias-altas.csv`, 30 filas ficticias)

Cabecera oficial de 33 columnas (`RESERVATION_IMPORT_FIELDS`), BOM UTF-8, «;», CRLF. Tipos y tarifas **reales**
de Rías Altas (`room_types`: DBL «Doble Estándar» 60 hab. máx. 2 · DSV «Doble Superior Vista Ría» 30/2 · IND
«Individual» 10/1 · JSU «Junior Suite» 15/3 · SRA «Suite Rías Altas» 5/4; `rate_plans`: BAR, BAR-BB, BAR-NR).
Llegadas 2026-10-12 → 2026-12-05 (todas dentro de los 90 días siguientes a hoy), 13 nacionalidades,
referencias `IMP-RA-2026-101…130`, huéspedes inventados con e-mail `@example.com` y documentos con letra de
control válida. Lo que demuestra cada grupo de filas:

| Filas | Qué demuestra | Resultado |
|---|---|---|
| 3, 4, 11 | Huéspedes **ya existentes** en la organización (fichas creadas por la primera demo: Antón Souto, Clara Bermúdez, Marek Nowak) → **reutilización por documento**, la ficha no se toca | `GUEST_REUSED` × 3; RES-00123, RES-00124 y RES-00131 enlazan a las fichas existentes |
| 1, 3, 4, 7, 12 | Habitación concreta (112 DBL · 102 IND · 602 JSU · 413 DSV · 617 SRA) por `assignRoom` con `canAssignRoom` | 5 `assigned_room_id` · 5 eventos `ROOM_ASSIGNED` |
| 2, 10, 15 | Fechas `DD/MM/YYYY`; `noches` en vez de `salida` (2, 8, 15); tipo por **nombre** («Doble Superior Vista Ría») y régimen en texto («Alojamiento y desayuno») | resueltas sin aviso |
| 5 | `estado = tentativa` | `TENTATIVE_AS_CONFIRMED`: RES-00125 `confirmed` con `internal_notes` «Importada como tentativa: confirmar con el cliente (lote …)» |
| 6 | Llegada y salida como **serial de Excel** (46308 · 46310) e importe vacío | `DATE_FROM_SERIAL` × 2 → 2026-10-13 → 2026-10-15; `TOTAL_QUOTED` 196,00 (BAR 98 × 2) |
| 8 | `habitaciones = 2` (4 adultos, código de grupo) | RES-00128 `rooms_count` 2, cuenta 2 en el cupo |
| 13, 25 | Importe vacío con BAR (25 además con **tarifa vacía**) | `TOTAL_QUOTED` 306,00 y 232,00; 25 `RATE_PLAN_DEFAULTED` → BAR |
| 19 | `estado = cancelada` | `CANCELLED_AT_IMPORT`: RES-00139 creada y cancelada en el mismo commit (evento `RESERVATION_CANCELLED`) |
| resto | Canales (directo, web, booking, expedia, airbnb, agencia, empresa, telefono, email, walk-in, grupo, gds, mayorista), segmentos (leisure, corporate, ota, group, wholesale, deportes, boda, mice), métodos de pago (tarjeta, transferencia, efectivo, bono, prepago, «prepago OTA», «factura a empresa»), documentos (DNI, NIE, PAS, pasaporte, TIE), VIP «sí»/«no», hora de llegada, empresa/agencia/grupo, depósitos, niños/bebés en JSU/SRA | todos normalizados sin aviso (0 `*_UNKNOWN`) |

`reservas-demo-rias-altas-lote2.csv` (5 filas `IMP-RA-2026-U11…U15`, 9-13 de diciembre, sin habitación)
reutiliza **4 huéspedes** (Marek Nowak, Alba Rodeiro, Camille Dubois, Clara Bermúdez) y crea **1 nuevo** (Vera
Lindqvist) para que el deshacer muestre qué cancela y qué conserva.

### 5.2 Dry-run del CSV (`--export-xlsx …/reservas-demo-rias-altas.xlsx`, exit 0)

`csv · utf-8 · separador «;» · 7.219 bytes · 30 filas de datos · 33 columnas · hoy (propiedad) 2026-09-17 ·
fecha de negocio 2026-09-13 (por detrás del calendario) · moneda EUR · tarifa por defecto BAR`. Mapeo efectivo
33/33 columnas por sinónimo, ninguna sin mapear, **1 aviso de fichero** (fecha de negocio atrasada, §4.3-1), 0
blockers, **`canImport: sí`**.

Resumen: **válidas 22 · con avisos 8 · con errores 0 · omitidas 0 · histórico 0 · a crear 30**. Importes: del
fichero 10.628,40 · cotizados 734,00 EUR. Incidencias (11, todas avisos): filas 3, 4 y 11 `GUEST_REUSED` · fila 5
`TENTATIVE_AS_CONFIRMED` · fila 6 `DATE_FROM_SERIAL` × 2 + `TOTAL_QUOTED` · fila 13 `TOTAL_QUOTED` · fila 19
`CANCELLED_AT_IMPORT` · fila 25 `RATE_PLAN_DEFAULTED` + `TOTAL_QUOTED`; **ningún mensaje con «[valor omitido]»**.
Disponibilidad (regla de rango, BD + filas anteriores): DBL cupo 60 · pedidas 12 · pico BD 0 · pico fichero 1 ·
DSV 30/6/0/0 · IND 10/4/0/1 · JSU 15/5/0/1 · SRA 5/4/0/0; sin noches excedidas ni filas rechazadas por la regla
de rango. Duplicados: 0 · 0 · 0.

### 5.3 Ida y vuelta XLSX

`--export-xlsx` escribió `reservas-demo-rias-altas.xlsx` (8.220 bytes, hoja «Reservas», 30 filas, celdas como
texto). Dry-run del `.xlsx` (exit 0): **mismo hash `479702c0…6c45`**, mismo resumen 22/8/0/0/30, la salida
completa del dry-run **idéntica** salvo la línea del fichero (`diff` vacío). El lector XLSX-lite y el parser CSV
producen la misma tabla normalizada.

### 5.4 Apply del lote 1 (una sola vez: 17/09 02:44:03 → 02:44:06 CEST; `created_at` 2026-09-17 00:44:04.866 UTC; exit 0)

`[reservations:import] lote cmu4t43gh0000fyu01qbc20ri · Importada (imported) · reservas-demo-rias-altas.csv ·
csv · Filas: 30 · creadas 30 · omitidas 0 · con error 0 · con avisos 8 · Llegadas: 2026-10-12 → 2026-12-05 ·
total 11.362,40 EUR · createdBy usr_system_reservation_import · hash 479702c0…6c45`. Códigos consecutivos
**RES-00121 → RES-00150** (el último previo era RES-00120). Auditoría: `RESERVATION_IMPORT_COMMITTED` (actor
`usr_system_reservation_import`, correlación `corr_reservation_import`, 00:44:05.987 UTC) + 30
`RESERVATION_CREATED` + 5 `ROOM_ASSIGNED` + 1 `RESERVATION_CANCELLED`.

### 5.5 Idempotencia (nada escrito)

- Dry-run del `.xlsx` tras el apply → **exit 1**: blocker `RESERVATION_IMPORT_DUPLICATE` «Este fichero ya se
  importó (lote cmu4t43gh0000fyu01qbc20ri, 2026-09-17): deshaz el lote anterior o activa «Importar de todos
  modos»»; por fila: 29 omitidas `DUPLICATE_REFERENCE`, 29 `POSSIBLE_DUPLICATE` (mismo huésped + llegada + tipo)
  y **1 a crear** (fila 19: su referencia vive en la reserva **cancelada** RES-00139, aviso
  `REFERENCE_REUSED_CANCELLED`).
- `--apply` del `.xlsx` sin `--force` → **`RESERVATION_IMPORT_DUPLICATE (409)` · Lote afectado:
  cmu4t43gh0000fyu01qbc20ri (imported) · Nada escrito.** · exit 1. Recuentos idénticos antes y después.
  **No se ha ejecutado `--force`.**

### 5.6 Lote 2 desde XLSX y deshacer (17/09 02:44:44 → 02:44:47 CEST)

- Dry-run de `reservas-demo-rias-altas-lote2.csv` con `--export-xlsx` (exit 0): 5 filas, hash
  `e218f980…fbe9`, **4 × `GUEST_REUSED` por documento**, 0 errores, `canImport: sí`, importes del fichero
  1.780,00; `reservas-demo-rias-altas-lote2.xlsx` (3.738 bytes).
- `--apply` **del `.xlsx`** → lote **`cmu4t4ygm0000fywcuis0txkx`** `imported` · `format xlsx` · 5 creadas ·
  **RES-00151 → RES-00155** · 1 huésped nuevo + 4 reutilizados · mismo hash que el CSV.
- `--undo cmu4t4ygm0000fywcuis0txkx --reason "Demo Tanda 7: segunda importación de prueba (XLSX) deshecha para
  demostrar la reversibilidad"` → «deshecho · Deshecha (undone) · Reservas cancelada: **5** · conservada: **0**»
  con los 5 ids; SQL: las 5 `cancelled`, `undo_outcome = cancelled` en las 5 filas, `undone_by
  usr_system_reservation_import`, `undone_at` 00:44:46.148 UTC, auditoría `RESERVATION_IMPORT_UNDONE`.
- Segundo `--undo` → «ya estaba deshecho (2026-09-17T00:44:46.148Z, usr_system_reservation_import): nada
  escrito» (`alreadyUndone: true`), exit 0.
- El lote 1 sigue intacto después (29 `confirmed` + 1 `cancelled`).

## 6. Verificación SQL (solo lectura, tras el segundo deshacer; consultas reproducibles en §9)

| Comprobación | Esperado | Real |
|---|---|---|
| `reservation_imports` de la propiedad | 4 lotes (2 de la primera demo, ambos `undone`, + 2 nuevos) | **4**: `cmu4q4uwy…` `undone` 30/30 · `undone_count` 29 · `cli:import-reservations` · `cmu4q6u0t…` `undone` 5/5 · `cmu4t43gh…` **`imported`** 30/30/0/0/8 · 11.362,40 · llegadas 2026-10-12 → 2026-12-05 · **`usr_system_reservation_import`** · `cmu4t4ygm…` `undone` 5/5/0/0/4 · `xlsx` · 1.780,00 · `undone_count` 5 · `undo_kept_count` 0. Total de la tabla en toda la BD: 4 (las suites de integración limpian sus organizaciones) |
| Reservas del lote 1 por `booking_source = import:cmu4t43gh…` | 29 `confirmed` + 1 `cancelled` | **`confirmed` 29** (RES-00121…RES-00150, Σ `rooms_count` 30, Σ 11.166,40) · **`cancelled` 1** (RES-00139, 196,00) |
| Filas del lote 1 | 30 sin datos personales | **30** `created` · 30 con `reservation_id` · 0 con `error_code` · 8 con `warnings_json` ≠ `[]`; búsqueda de nombres, e-mails, teléfonos, documentos y del literal «valor omitido» en `warnings_json`/`error_message` de los dos lotes nuevos: **0 filas** |
| Huésped principal / folio / habitación / booker / referencia | 30 / 30 abiertos / 5 / 0 / 30 | **30** con `reservation_guests.is_primary` · **30** folios `open` · **5** `assigned_room_id` (112 RES-00121 · 102 RES-00123 · 602 RES-00124 · 413 RES-00127 · 617 RES-00132) · **`booker_email` NULL en las 30** · `external_reference` 30 |
| Huéspedes de la organización | 56 + 27 (lote 1) + 1 (lote 2) = 84 | **84**; lote 1: **27 nuevos · 3 reutilizados**; lote 2: **1 nuevo · 4 reutilizados**; 84 también tras el deshacer (las fichas no se borran, §4.3-3) |
| Estados especiales | — | RES-00125 `confirmed` + `internal_notes` «Importada como tentativa: confirmar con el cliente…» · RES-00128 `rooms_count` 2 / `adults` 4 · RES-00139 `cancelled` · RES-00145 `rate_plan` BAR (defaulted) · RES-00146 `children` 1 / `infants` 1 · canal/`source_code`/segmento/régimen/`payment_method`/`vip_flag`/`estimated_arrival_time` tal como se normalizaron |
| Cupo tipo × noche (`generate_series` sobre `confirmed \| checked_in`) | 0 noches excedidas | **0**; picos en la ventana del lote (12/10 → 08/12): DBL 2/60 · DSV 1/30 · IND 2/10 · JSU 2/15 · SRA 1/5 |
| Lote 2 tras el deshacer | 5 `cancelled` | **5 `cancelled`** (RES-00151…00155), `undo_outcome cancelled` × 5 |
| Rías Altas en total | 14 + 29 · 9 · 18 + 29 + 1 + 5 | `confirmed` **43** (14 previas + 29 del lote 1) · `checked_out` **9** · `cancelled` **53** (18 previas al inicio de esta integración —incluidas las 5 de la primera demo deshecha y la fila cancelada del lote antiguo— + 29 del lote antiguo deshecho + 1 fila `cancelada` del lote 1 + 5 del lote 2 deshecho) |
| Auditoría (`correlation_id = corr_reservation_import`, desde 00:40 UTC) | — | `RESERVATION_CREATED` 35 · `ROOM_ASSIGNED` 5 · `RESERVATION_CANCELLED` 6 · `RESERVATION_IMPORT_COMMITTED` 2 · `RESERVATION_IMPORT_UNDONE` 1 (+ el `UNDONE` del lote antiguo a las 00:39:49) |
| Invariantes Faranda | 25 · 33 · 109 · 1 | **25 facturas · 33 envíos VeriFactu · 109 asientos · 1 lote de nómina** (idénticos antes del primer comando, después del segundo deshacer y después de las suites de integración) |
| Fecha de negocio | informativa | `business_dates."current_date"` = 2026-09-13 (hoy 2026-09-17) |
| Migraciones | 10 · drift 0 | **10** aplicadas (última `20260916130000_reservas_importacion`) · «No difference detected.» |

## 7. Cómo usarlo paso a paso

### 7.1 Desde la pantalla (Recepción › Reservas › Importar, roles recepción · dirección · comercial · admin)

1. **Fichero.** «Descargar plantilla CSV» o «XLSX» (33 columnas en español con 2 filas de ejemplo ficticias),
   rellenarla o usar un fichero de terceros; subirla con el selector (CSV/XLSX, ≤ 5 MB, ≤ 5.000 filas). La
   propiedad activa es el destino.
2. **Columnas.** La pantalla propone el mapeo columna → campo por sinónimos ES/EN y muestra un ejemplo real de
   cada columna; se corrige con los selectores. Obligatorios: `llegada`, `tipo_habitacion`, `nombre`,
   `apellidos` (o una columna de nombre completo) y `salida` o `noches`.
3. **Revisión.** KPIs válidas / avisos / errores, tabla por fila con filtro de estado, callouts de
   disponibilidad y duplicados, interruptores «omitir filas inválidas», «permitir overbooking» e «histórico».
   Con errores y sin «omitir», «Importar» queda deshabilitado; si el mismo fichero ya se importó, aparece el
   bloqueo `RESERVATION_IMPORT_DUPLICATE` («Importar de todos modos» para forzar).
4. **Resultado.** Reservas creadas con enlace al detalle, filas omitidas y errores, «Descargar informe CSV»
   (sin datos del huésped) y «Deshacer importación». La sección «Importaciones anteriores» lista los lotes con
   estado, contadores y autor, y permite deshacer los que sigan vivos (cancela las reservas sin check-in).

### 7.2 Desde el CLI (`hotelos/`; F = `<raíz git>/pilots/faranda-celuisma`; P = `cmrhw9jy40003fyvbuu2ec2w7`)

```bash
corepack pnpm --filter @hotelos/api reservations:import -- --template csv --out /tmp/plantilla-reservas.csv          # plantilla oficial
corepack pnpm --filter @hotelos/api reservations:import -- --file $F/reservas-demo-rias-altas.csv --property $P       # dry-run: tabla, resumen, disponibilidad; exit 0 solo si canImport
corepack pnpm --filter @hotelos/api reservations:import -- --file $F/reservas-demo-rias-altas.csv --property $P --apply   # crea el lote (con los API parados)
corepack pnpm --filter @hotelos/api reservations:import -- --undo <importId> --property $P --reason "Fichero equivocado"  # deshacer (idempotente)
```

Opciones: `--skip-invalid`, `--allow-overbooking`, `--historical`, `--force`, `--mapping <json>`, `--sheet`,
`--sample <n>`, `--export-xlsx <ruta>`, `--json`. Salidas 0 / 1 / 2 (runbook §12.7, cotejado con el script).

### 7.3 Después de importar

Comprobar por SQL (runbook §13, consultas 1-10 ejecutadas tal cual en esta demo) y, con el API arriba, `GET
/properties/<id>/reservations/imports` y `…/imports/<importId>`; abrir Recepción › Reservas › Lista filtrando
por llegadas del lote (origen «Importada»), abrir una reserva y comprobar huésped principal, folio abierto y
habitación asignada.

## 8. Pendientes tras la integración

### 8.1 Solo el orquestador: reiniciar el API :3000 y reproducir las lecturas por HTTP

Hoy `GET /properties/cmrhw9jy40003fyvbuu2ec2w7/reservations/imports` responde **404** en :3000 (código
anterior) y `GET …/reservations?limit=1` 200. Tras el reinicio, con el token de Carmen del scratchpad
(`carmen-3000.token`, caduca 17/09 05:00 CEST):

```bash
T=$(cat <scratchpad>/carmen-3000.token); P=cmrhw9jy40003fyvbuu2ec2w7; B=http://localhost:3000/properties/$P/reservations/imports
curl -s -H "Authorization: Bearer $T" "$B" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log(j.length, j.map(l=>`${l.id} ${l.status} ${l.createdCount}/${l.rowCount} ${l.createdBy}`))})'   # 4 lotes
curl -s -H "Authorization: Bearer $T" "$B/cmu4t43gh0000fyu01qbc20ri" | grep -c 'example.com\|valor omitido'    # 0 (sin PII)
curl -s -H "Authorization: Bearer $T" "$B/cmu4t43gh0000fyu01qbc20ri" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log(j.status, j.rows.length, j.today, j.businessDate)})'   # imported 30
curl -sI -H "Authorization: Bearer $T" "$B/template?format=csv" | grep -i 'content-\|cache'      # text/csv · attachment · no-store
curl -s -o /tmp/plantilla.xlsx -w '%{http_code} %{size_download}\n' -H "Authorization: Bearer $T" "$B/template?format=xlsx"   # 200
```

Después, recorrido en navegador como Carmen en :5173: Recepción › Reservas › **Importar** (subir
`reservas-demo-rias-altas-lote2.csv` → «Columnas» con ejemplos por columna → «Revisión» con 4 avisos
`GUEST_REUSED` y 5 `REFERENCE_REUSED_CANCELLED` → **no** importar, o importar y deshacer desde «Importaciones
anteriores», donde el lote 1 aparece con autor «Sistema · importación masiva de reservas»); Recepción › Reservas
› Lista filtrando llegadas 12/10 → 08/12 de 2026; abrir RES-00121 (habitación 112, folio abierto), RES-00123
(ficha reutilizada) y RES-00125 (nota interna de tentativa).

### 8.2 Commit

Todo el working tree de la tanda (§2) sigue sin commit; `pilots/` es git-ignored (los cinco ficheros de demo
viven fuera del repo). Los cuatro documentos de diseño ajenos listados en §2 no forman parte de la tanda.
`pnpm-lock.yaml` no lo ha tocado ningún lote.

### 8.3 Retirar la demo cuando César la haya visto

`corepack pnpm --filter @hotelos/api reservations:import -- --undo cmu4t43gh0000fyu01qbc20ri --property
cmrhw9jy40003fyvbuu2ec2w7 --reason "Demo retirada"` cancela las 29 confirmadas (las fichas de huésped, los
folios y la cancelada RES-00139 se conservan, como en cualquier cancelación).

## 9. Consultas y comandos reproducibles

Desde `hotelos/` (`psql "$(grep -E '^DATABASE_URL=' .env | cut -d= -f2- | tr -d '"')"`; lote 1
`cmu4t43gh0000fyu01qbc20ri`, lote 2 `cmu4t4ygm0000fywcuis0txkx`, propiedad `cmrhw9jy40003fyvbuu2ec2w7`,
organización `cmrhw9jy30002fyvb6tsdiugt`). Las consultas 1-10 del runbook §13 se ejecutaron tal cual; estas son
las variantes de §6 (salida completa en `RESERVAS-DRY-RUN-2026-09-16.md` §9).

```sql
-- Reservas del lote 1 por estado (29 confirmed RES-00121…RES-00150 · 1 cancelled RES-00139)
SELECT status, count(*), min(code), max(code), sum(rooms_count), round(sum(total_amount), 2)
FROM reservations WHERE property_id = 'cmrhw9jy40003fyvbuu2ec2w7'
  AND booking_source = 'import:cmu4t43gh0000fyu01qbc20ri' AND deleted_at IS NULL GROUP BY 1 ORDER BY 1;

-- Huésped principal, folio abierto, habitación, booker_email y referencia (30 · 30 · 5 · 0 · 30)
SELECT count(*) AS reservas,
       count(*) FILTER (WHERE EXISTS (SELECT 1 FROM reservation_guests rg WHERE rg.reservation_id = r.id AND rg.is_primary)) AS con_huesped,
       count(*) FILTER (WHERE EXISTS (SELECT 1 FROM folios f WHERE f.reservation_id = r.id AND f.status = 'open')) AS folio_open,
       count(*) FILTER (WHERE r.assigned_room_id IS NOT NULL) AS con_habitacion,
       count(*) FILTER (WHERE r.booker_email IS NOT NULL) AS con_booker_email,
       count(*) FILTER (WHERE r.external_reference IS NOT NULL) AS con_referencia
FROM reservations r WHERE r.booking_source = 'import:cmu4t43gh0000fyu01qbc20ri' AND r.deleted_at IS NULL;

-- Huéspedes nuevos frente a reutilizados por lote (27 · 3 y 1 · 4) y total de la organización (84)
SELECT i.id, count(*) FILTER (WHERE g.created_at >= i.created_at) AS nuevos, count(*) FILTER (WHERE g.created_at < i.created_at) AS reutilizados
FROM reservation_imports i JOIN reservations r ON r.booking_source = 'import:' || i.id
JOIN reservation_guests rg ON rg.reservation_id = r.id AND rg.is_primary JOIN guests g ON g.id = rg.guest_id
WHERE i.id IN ('cmu4t43gh0000fyu01qbc20ri', 'cmu4t4ygm0000fywcuis0txkx') GROUP BY i.id;
SELECT count(*) FROM guests WHERE organization_id = 'cmrhw9jy30002fyvb6tsdiugt' AND deleted_at IS NULL;

-- Ningún valor personal ni «[valor omitido]» en las filas persistidas de los lotes nuevos (0)
SELECT count(*) FROM reservation_import_rows WHERE import_id IN ('cmu4t43gh0000fyu01qbc20ri', 'cmu4t4ygm0000fywcuis0txkx')
  AND (warnings_json::text ~* 'example\.com|vilari|kowalski|souto|nowak|20202020|AB1234567|valor omitido'
       OR coalesce(error_message, '') ~* 'example\.com|valor omitido');

-- Cupo tipo × noche nunca excedido (0 filas) — consulta 6 del runbook §13
WITH noches AS (
  SELECT r.room_type_id, d::date AS noche, sum(r.rooms_count) AS ocupadas FROM reservations r
  CROSS JOIN LATERAL generate_series(r.arrival_date, r.departure_date - 1, interval '1 day') AS d
  WHERE r.property_id = 'cmrhw9jy40003fyvbuu2ec2w7' AND r.status IN ('confirmed', 'checked_in') AND r.deleted_at IS NULL GROUP BY 1, 2
), cupo AS (
  SELECT room_type_id, count(*) AS cupo FROM rooms WHERE property_id = 'cmrhw9jy40003fyvbuu2ec2w7' AND sellable AND maintenance_status <> 'blocked' GROUP BY 1
)
SELECT rt.code, n.noche, n.ocupadas, c.cupo FROM noches n JOIN room_types rt ON rt.id = n.room_type_id JOIN cupo c ON c.room_type_id = n.room_type_id
WHERE n.ocupadas > c.cupo ORDER BY 1, 2;

-- Lote 2 deshecho (5 cancelled · undo_outcome cancelled × 5 · undone 5/0)
SELECT status, count(*) FROM reservations WHERE booking_source = 'import:cmu4t4ygm0000fywcuis0txkx' GROUP BY 1;
SELECT row_number, reservation_code, undo_outcome FROM reservation_import_rows WHERE import_id = 'cmu4t4ygm0000fywcuis0txkx' ORDER BY 1;
SELECT status, undone_count, undo_kept_count, undo_reason FROM reservation_imports WHERE id = 'cmu4t4ygm0000fywcuis0txkx';

-- Auditoría de la demo (2 COMMITTED · 1 UNDONE · 35 CREATED · 5 ROOM_ASSIGNED · 6 CANCELLED)
SELECT action, count(*) FROM audit_events WHERE correlation_id = 'corr_reservation_import' AND created_at >= '2026-09-17 00:40' GROUP BY 1 ORDER BY 1;

-- Invariantes de Faranda (25 · 33 · 109 · 1)
SELECT (SELECT count(*) FROM invoices i JOIN properties p ON p.id = i.property_id WHERE p.organization_id = 'cmrhw9jy30002fyvb6tsdiugt') AS facturas,
       (SELECT count(*) FROM verifactu_submissions s JOIN invoices i ON i.id = s.invoice_id JOIN properties p ON p.id = i.property_id WHERE p.organization_id = 'cmrhw9jy30002fyvb6tsdiugt') AS verifactu,
       (SELECT count(*) FROM journal_entries WHERE organization_id = 'cmrhw9jy30002fyvb6tsdiugt') AS asientos,
       (SELECT count(*) FROM payroll_cost_imports WHERE organization_id = 'cmrhw9jy30002fyvb6tsdiugt') AS lotes_nomina;
```

```bash
# Secuencia completa de la demo (desde hotelos/apps/api; F = <raíz git>/pilots/faranda-celuisma; P = cmrhw9jy40003fyvbuu2ec2w7)
cli() { node --env-file-if-exists=../../.env --import tsx src/scripts/import-reservations.ts "$@"; }
cli --undo cmu4q4uwy0000fyezs6bxnt2v --property $P --reason "Demo rehecha con el código corregido (ronda 1)"     # 29 canceladas (lote de la primera demo)
cli --file $F/reservas-demo-rias-altas.csv --property $P --export-xlsx $F/reservas-demo-rias-altas.xlsx           # exit 0, hash 479702c0…
cli --file $F/reservas-demo-rias-altas.xlsx --property $P                                                        # exit 0, mismo hash
cli --file $F/reservas-demo-rias-altas.csv --property $P --apply                                                 # lote 1 cmu4t43gh0000fyu01qbc20ri
cli --file $F/reservas-demo-rias-altas.xlsx --property $P                                                        # exit 1, blocker RESERVATION_IMPORT_DUPLICATE
cli --file $F/reservas-demo-rias-altas.xlsx --property $P --apply                                                # 409 RESERVATION_IMPORT_DUPLICATE, nada escrito
cli --file $F/reservas-demo-rias-altas-lote2.csv --property $P --export-xlsx $F/reservas-demo-rias-altas-lote2.xlsx   # exit 0, hash e218f980…
cli --file $F/reservas-demo-rias-altas-lote2.xlsx --property $P --apply                                          # lote 2 cmu4t4ygm0000fywcuis0txkx (xlsx)
cli --undo cmu4t4ygm0000fywcuis0txkx --property $P --reason "Demo Tanda 7: segunda importación de prueba (XLSX) deshecha…"   # 5 canceladas
cli --undo cmu4t4ygm0000fywcuis0txkx --property $P                                                               # alreadyUndone
```

## 10. Decisiones abiertas para César (diseño §11.1, con la evidencia de la demo)

| # | Decisión | Estado por defecto en esta tanda | Evidencia en Rías Altas | Si César prefiere otra cosa |
|---|---|---|---|---|
| 1 | **«Tentativa» como confirmada** | Se crea `confirmed` con aviso `TENTATIVE_AS_CONFIRMED` y nota interna; consume inventario y la auditoría nocturna la trata como cualquier confirmada | RES-00125 (fila 5) | Hace falta una transición `draft → confirmed` en el PMS (tanda posterior, sin cambio en el importador) |
| 2 | **Histórico** (`historico: true` / `--historical`): llegadas anteriores a **hoy** como estancia cerrada atómica (`checked_out`, folio `closed`, `Stay` solo con habitación), sin cargos, SES ni correos | Sin `historico`, una llegada anterior a hoy es error `PAST_ARRIVAL` | No ejercitado en la demo (cubierto por integración) | Ingresos históricos en el libro o partes SES retroactivos serían otra tanda (night audit histórico) |
| 3 | **Overbooking explícito** (`permitirOverbooking` / `--allow-overbooking`) crea por encima del cupo con aviso y `afterJson.overbooking` | Nunca por defecto: la fila es error `NO_AVAILABILITY` | No hubo cupo que exceder | Basta ocultar el interruptor: el servicio sigue rechazando sin el flag |
| 4 | **Referencias externas de reservas canceladas/no-show reutilizables** (imprescindible para reimportar tras deshacer) | Aviso `REFERENCE_REUSED_CANCELLED`; se crea una reserva **nueva** | Tras el apply, el mismo fichero reimportaría solo la fila 19 (cancelada); las 30 referencias del lote antiguo deshecho volvieron a estar libres | Bloquear también las canceladas y exigir borrar antes de reimportar |
| 5 | **Permisos**: importar exige `pms.reservation.create` **y** `pms.reservation.modify`; deshacer `modify`; leer y plantilla `read` | Todas las plantillas con `create` tienen `modify`; sin claves nuevas → sin `rbac:sync` | Carmen (Owner) lee, previsualiza y descarga por HTTP | Un permiso propio `pms.reservation.import` exigiría `rbac:sync` sobre Faranda y tocar 10 plantillas |
| 6 | **Sin confirmaciones por e-mail a los importados** (`bookerEmail` vacío; el e-mail vive en la ficha del huésped) | Ningún correo por lote | `booker_email` NULL en las 30 | Flag de supresión del evento `ReservationCreated` + remitente/plantilla: extensión aditiva |
| 7 | **Tarifas BAR-BB / BAR-NR sin parrilla** en Rías Altas | La cotización de un importe vacío solo funciona con BAR; el importador prefiere `importe_total` del fichero | Filas 6, 13 y 25 cotizadas con BAR (734,00 €); las filas BAR-BB/BAR-NR llevan importe | Publicar sus parrillas en Rate Grid v2 |
| 8 | **Fechas `DD/MM` sin configuración de ambigüedad** | Un fichero `MM/DD/YYYY` se leería mal cuando el día ≤ 12; la plantilla recomienda ISO | Filas 2, 10 y 15 en `DD/MM/YYYY` correctas | Opción `dateOrder: dmy \| mdy` en el cuerpo: aditiva |
| 9 | **Completar fichas de huésped desde el fichero** | Nunca se actualiza una ficha existente; solo aviso `GUEST_NAME_MISMATCH` cuando el apellido difiere | Filas 3, 4 y 11 reutilizan fichas sin tocarlas | Rellenar solo campos vacíos de la ficha reutilizada: cambio pequeño en `resolveGuest`, decisión de negocio |
| 10 | **Deshacer conserva las fichas de huésped creadas por el lote** (nuevo, §4.3-3) | El deshacer cancela reservas; las fichas nuevas quedan (como cualquier cancelación) | Lote 2: 1 ficha nueva sigue tras el `undo`; organización 56 → 84 con la demo | Borrado lógico de las fichas creadas por el lote y sin otra reserva: cambio acotado en `undoReservationImport` |
| 11 | **Fecha de negocio atrasada** (nuevo, §4.3-1) | La frontera de «pasado» es hoy; la preview avisa si la fecha de negocio va por detrás | Rías Altas: 2026-09-13 frente a 2026-09-17; ninguna fila afectada | Ejecutar la auditoría nocturna antes de importar, o bloquear la importación mientras haya días sin cerrar |
| 12 | **Enmascarado de texto libre** (§4.2) | `peticiones` y `notas` se protegen como celda completa; identidad también por palabras | 0 «[valor omitido]» en la demo; el test GDPR sigue en verde | Volver a tokenizar las notas (máximo enmascarado) a costa de mensajes mutilados |
| 13 | **Enlace del runbook desde `CLAUDE.md` «Docs prioritarios»** y fila «Importar» en `pilots/tanda5-nav-tree.md` §1 (ficheros fuera de los lotes) | No tocados por ningún lote | — | Añadirlos en el commit del orquestador |

## 11. Documentos relacionados

- `docs/design/RESERVAS-IMPORTACION-MASIVA.md` — diseño (formato, lector XLSX, pipeline, modelo, API, CLI, front, lotes, riesgos, decisiones; principios actualizados con la ronda de revisión).
- `docs/runbooks/reservas-importacion.md` — runbook operativo (plantilla, mapeo, códigos de fila, disponibilidad, duplicados, histórico, deshacer, permisos, límites, CLI §12 cotejado con el script, SQL §13 ejecutado sobre los lotes de esta demo, GDPR §15, FAQ).
- `docs/api-contracts.md` — bloque «Importación masiva de reservas (Tanda 7)» bajo «PMS».
- `<raíz git>/pilots/faranda-celuisma/RESERVAS-DRY-RUN-2026-09-16.md` — salida íntegra del CLI (undo del lote antiguo, dry-run, apply, 409, lote 2, deshacer × 2) y de la verificación SQL.
- `docs/audits/TANDA-6C-COSTE-PERSONAL-2026-09-16.md` — patrón de referencia (parser puro, `analyse` compartido, lote con hash, CLI dry-run) y precedente de la etiqueta `actor-label`.
- `docs/design/COCOA-22-MIGRACION.md` §6 y `docs/design/cocoa-22-inventory.json` — inventario Cocoa 22 regenerado con la pantalla nueva.
