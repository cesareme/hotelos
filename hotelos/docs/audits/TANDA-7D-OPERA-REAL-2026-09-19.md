# Tanda 7d · Carga real de OPERA Cloud (5 hoteles) — 19 de septiembre de 2026

**Para:** César y el orquestador. **Encargo (19/09/2026):** «estas son las reservas exportadas de OPERA que
tenemos en el sistema para los periodos indicados» — 10 informes R&A reales (estancias 01/08-18/09/2026 y
llegadas 18/09/2026-31/12/2028 de Rías Altas, Los Tilos, Pathos, Marsol y Alisas), guardados FUERA del repo
(`~/anfitorio-demo/pilots/faranda-celuisma/opera-real/`, git-ignorado). **Este documento** cubre la tanda
completa: preparación y t0 (código + tests, preprocesado reproducible, retirada de la demo de Rías Altas e
inventario de RA), tramos t1-t6 (inventario, llegadas y estancias de RA, LT, PG, MC y AS), t7 (verificación
global), t8 (corrección tras la revisión) y t9 (verificación final del integrador, §8). Sin nombres ni cifras de huéspedes individuales: solo recuentos agregados, códigos, identificadores de
lote y decisiones. Detalle operativo en `docs/runbooks/reservas-importacion.md` §19 (resultado en §19.10), huecos
cerrados en `docs/runbooks/opera-modo-sombra.md` §15 y diseño en `docs/design/OPERA-CLOUD-MODO-SOMBRA.md` §11.
Informe externo (mapas completos, lotes, recuentos frente a OPERA, preguntas a recepción, SQL):
`~/anfitorio-demo/pilots/faranda-celuisma/opera-real/INFORME-CARGA-2026-09-19.md`.

**Resultado en una línea:** las **13.347 reservas reales** de OPERA están en la BD local en **10 lotes `sync`
reversibles con 0 errores y 0 omitidas** (RA 1.970 · LT 2.124 · PG 2.050 · MC 5.403 · AS 1.800), el inventario de
los 5 hoteles es el de OPERA (30 tipos con código OPERA, 396 habitaciones activas; 19 tipos y 200 habitaciones
sintéticas desactivadas), la demo de Rías Altas está fuera, y la verificación cuadra con OPERA en todo lo
comparable: recuentos por estado, 148 habitaciones en casa a 18/09 (AS 23 · LT 28 · MC 52 · PG 23 · RA 22),
llegadas 18/09 (144) y 19/09 (82), room-nights de agosto (8.972), `verify` 45/45, cronograma de RA por API =
BD, 0 duplicados, huéspedes 13.436 = 89 + 13.347, invariantes intactas (facturas 33 · VeriFactu 41 · permisos
250 · roles Faranda 24 · lotes de ingresos sombra 2 · asientos 143.279) y suite del API en verde (2.351 tests).
**Matiz honesto (revisión t8):** «0 omitidas» y «= OPERA» valen frente al prep filtrado: de las 15.724 filas
brutas de los xlsx, 1.754 no se cargan a propósito (1.737 filas de pseudo rooms PM / PI —masters de grupo y uso
de casa, todas con importe 0 €—, 16 day-use y 1 cancelada de 734 noches) y 479 son filas repetidas de
marcadores; `verify --in` lo muestra ahora hotel a hotel (tabla «OPERA bruto → cargado», §4). **Corrección t8
(04:45-04:50 CEST):** garantía persistida en `guarantee_type` (7.434), `price_source = quoted` en las 4.779
llegadas con total estimado, `deposit_paid` (63), habitación + `Stay` repuestas en 25 de las 26 cerradas
blanqueadas, 19 tipos sintéticos `sellable = false`, 13 habitaciones de RA limpias; 0 fallos, invariantes
idénticas.

## 1. Cambios de código (worktree `~/anfitorio-demo-wt-opera`, rama `tanda-opera`, sin commit)

| Fichero | Cambio | Por qué |
|---|---|---|
| `apps/api/src/modules/pms/reservation-import.service.ts` | `syncContext.statusMap = OPERA_CLOUD_PROFILE.statusMap` en vez de `{}` cuando no hay `profile` | Los literales reales `CHECKED OUT` / `CHECKED IN` / `RESERVED` / `NO SHOW` / `CANCELLED` resolvían a `INVALID_STATUS`. **Afecta también a la ruta HTTP** `POST …/reservations/imports` con `mode: "sync"` sin `profile` (antes inutilizable) |
| ídem | `tableOptions.cutBusinessDate = syncContext.businessDate` | Frontera de «llegada pasada» del destino `confirmed` = min(business date del corte, hoy): las 144 `RESERVED` con llegada 18/09 se cargaron el 19/09 |
| ídem | `arrivalCheckInAt(arrivalDate, timezone)` exportada + `fixStayCheckInAt` tras la transición `check_in` en `commitRow` y `commitSyncLinkedRow`; `timezone` viaja en `ReservationImportCatalogs` | `checkInReservation` crea la `Stay` con `checkinAt = ahora`; las 148 estancias en casa llevaban días alojadas. `check_in_and_out` no se toca (las `CHECKED OUT` nacen históricas 15:00 → 11:00) |
| ídem | `export` de `shadowCheckOut` | `demo-retire` hace el check-out de la demo exactamente como el check-out sombra |
| `apps/api/src/modules/pms/reservation-import.normalize.ts` | `cutBusinessDate?: IsoDate` en `NormalizeRowOptions` / `NormalizeTableOptions`; `frontier = mode === "sync" && cutBusinessDate < today ? cutBusinessDate : today` en la rama `create` de la frontera; `ReservationImportCatalogs.timezone` | Solo adelanta la frontera; `create` no cambia; los destinos con frontera relajada no cambian |
| `apps/api/src/scripts/import-opera-reports.ts` (**nuevo**, 1.762 líneas) | CLI con `prep`, `inventory`, `demo-retire`, `apply`, `undo`, `verify` (dry-run por defecto, `--apply`, `--json`, salida 0/1/2); contexto `systemContext` de `pms-shadow.rules.ts` (+ `property.map.manage` solo en `inventory`) | Sin script npm en `apps/api/package.json` (fichero fuera del alcance): `node --env-file-if-exists=../../.env --import tsx src/scripts/import-opera-reports.ts …` |
| `reservation-import.service.ts` (**t8**) | Columnas extra reconocidas por cabecera: `garantia` → `guaranteeType`, `importe_estimado` → `totalSource = quoted` (+ `estimatedRows`), `deposito_pagado` → `depositPaid` (`resolveExtraColumns`, `extraOf`, `AnalysedRow.extra`, `buildCreateReservationInput({ extra })`); `annotateRooms` no valida la habitación de una fila histórica; `closeSettledFolio` tras cancelación / no-show sombra | La garantía y el depósito cobrado de OPERA se persisten sin tocar `packages/shared` (33 campos canónicos intactos); un total tarifa × noches queda `price_source = quoted` y nunca pisa un total exacto (`diffFields`); una estancia cerrada no necesita habitación libre hoy; el folio de una cancelada / no-show queda `closed` como en la cancelación nativa |
| `reservation-import.normalize.ts` (**t8**) | `seenRooms[].historical`: `ROOM_DUPLICATE_IN_FILE` no salta entre dos filas históricas | Dos estancias cerradas solapadas en la misma habitación = cambio de habitación a mitad de estancia (OPERA deja la última en `ROOM`), no un choque |
| `import-opera-reports.ts` (**t8**) | `OPERA_EXTRA_FIELDS` (CSV de 36 columnas), `guaranteeOf`, `blankOverlappingRooms` conserva las dos `CHECKED OUT` solapadas, subcomando `backfill`, `verify --in <dir xlsx>` (tabla «OPERA bruto → cargado» + comprobaciones de garantía / `price_source` / `deposit_paid` / cerradas sin `Stay`), `inventory` marca `sellable = false` (`typesToUnsell`), `analyzeHotelReports` compartido por `prep` y `verify` | Corrección de lo ya cargado por el propio CLI (dry-run, `--json` con `before`, evento `RESERVATION_IMPORT_BACKFILLED` por propiedad) y verificación contra el bruto de OPERA, no contra el prep filtrado |
| Tests (`__tests__/import-opera-reports.test.mts` nuevo, 37 casos; `reservation-import-normalize.test.mts` +6; `reservation-import-sync.test.mts` +1; `reservation-import-service.test.mts` +5) | Filas INVENTADAS; ningún dato de los informes reales; en t8 los nombres del fixture del CLI se sustituyeron por otros claramente ficticios (uno coincidía por azar con un apellido real) | La prueba de `OUTPUT_DENYLIST` mete centinelas en las columnas prohibidas y comprueba que no aparecen en la salida |
| Docs | `reservas-importacion.md` §19 (+ §18.7), `opera-modo-sombra.md` §15 (+ línea en §14), `OPERA-CLOUD-MODO-SOMBRA.md` §11 | Formato real, decisiones, procedimiento, resultado y huecos |

No se tocan `inventory.engine.ts`, `pms.service.ts`, `audit.service.ts`, `packages/shared`, `schema.prisma`,
`apps/api/package.json` ni `pnpm-lock.yaml` (su ` M` previo sigue igual). `git status` del worktree al cierre: los 5
ficheros modificados del importador y sus tests, los 3 docs, el script nuevo con su test, este informe y el
`pnpm-lock.yaml` previo; nada más.

**Puertas (19/09/2026 04:44 CEST, t8):** `corepack pnpm --filter @hotelos/api test` **2.351 tests · 2.350 pass · 1
skipped (preexistente) · 0 fail** (t7: 2.339); `corepack pnpm --filter @hotelos/api typecheck` OK en t0 y t8.
`lint` del API **no ejecutable** de forma preexistente (`eslint .` sin `eslint.config` en `apps/api`).
**Puertas repetidas en t9 (05:10 CEST):** typecheck OK · test 2.351 · 2.350 pass · 1 skipped · 0 fail.

## 2. Decisiones del preprocesado (`prep`) y de la carga

1. **Referencia = `RESV_NAME_ID`** en los dos informes (único id común; `CONFIRMATION_NO` y `EXTERNAL_REFERENCE` a
   las notas). Las 144 `RESERVED` de estancias son las 144 llegadas del 18/09: el lote de llegadas las crea y el
   de estancias las encuentra enlazadas (`annotateSync` antes de `DUPLICATE_REFERENCE`): 45 `updated` (importe
   real en vez del estimado tarifa × noches; nombre completo de agencia / empresa) + 99 `unchanged`.
2. **Llegadas deduplicadas por `CONFIRMATION_NO`** (gana la primera fila): Rías Altas 855 → 383, Alisas 317 → 310.
3. **Pseudo rooms fuera** (`PI` / `PM`, 9000-9500): 1.737 filas; day-use (`NIGHTS = 0`) 16; 1 cancelada de 734 noches.
4. **`nombre` / `apellidos` ya separados** con la regla de `splitFullName`; 0 filas con nombre o apellidos vacíos.
5. **Habitación en blanco** en canceladas y no-show y en el solape habitación-noche con una fila VIVA. En t0-t7 la
   regla blanqueaba también el solape entre dos `CHECKED OUT` (AS 10 · LT 7 · MC 1 · PG 5 · RA 3 = 26 estancias
   cerradas sin habitación ni `Stay`); **t8** cambia la regla (dos cerradas solapadas = cambio de habitación a
   mitad de estancia, las dos conservan la habitación) y repone habitación + `Stay` en 25; la restante (AS,
   solapa a la alojada de la 114) sigue sin habitación por diseño.
6. **Tipo físico** de la habitación cuando la categoría reservada difiere (AS 16 + 17 · LT 10 · RA 20); 15
   habitaciones con dos categorías resueltas por moda (listadas para recepción en el informe externo).
7. **Ocupación**: `PERSONS` 0 → 1; > máximo del tipo → recorte con nota (1 fila, LT).
8. **Importes**: `SHARE_AMOUNT_PER_STAY` (estancias, exacto → `price_source = file`) y `SHARE_AMOUNT × noches`
   (llegadas, estimado → desde t8 columna `importe_estimado` y `price_source = quoted` en las 4.779 no enlazadas;
   las 144 enlazadas tienen el total exacto del lote de estancias y ya sin la nota «importe estimado»); 0 € →
   `0,00` (345 cortesías / uso de casa / bloques con tarifa en el master); `tarifa` vacía e ignorada
   (`mapping: { tarifa: null }`): las 13.347 con el plan BAR por defecto y Rate Grid vacía.
9. **Canal / segmento / pago / garantía** por diccionarios con test: 0 `CHANNEL_UNKNOWN`, 0 `SEGMENT_UNKNOWN` en
   los 10 lotes. `DEPOSIT_PAID` → `deposit_amount` y, desde t8, también `deposit_paid` (63 reservas, 12.309,08 €);
   `VIP` → `vipFlag` (3); garantía a las notas y, desde t8, a `guarantee_type` (7.434; el resto traía el literal
   de estado `CHECKED IN` / `CHECKED OUT`, que no es garantía).
10. **Orden de carga por hotel**: `inventory` → `apply --feed arrivals` → `apply --feed inhouse` (§19.5 del runbook),
    con `pg_dump` antes de cada tramo (11 copias, 61,9 → 70,5 MB) y dry-run con `--json` antes de cada `--apply`.
11. **`OUTPUT_DENYLIST`** (usuarios de OPERA, tarjeta, dirección, acompañantes, membresías, marcadores): 0 correos y
    0 tarjetas en los 15 CSV y en los logs; los logs `--json` solo llevan recuentos y códigos.
12. **Reproducible**: dos ejecuciones del prep → mismos sha256 de los 10 CSV y de los 5 `inventario.json`.

## 3. Tramos ejecutados (BD local, 19/09/2026 02:07-03:30 CEST)

| Tramo | Paso | Resultado |
|---|---|---|
| t0 02:07 | Copia, `--undo` de 4 lotes de la demo de RA, `demo-retire`, `inventory --apply` RA, dry-runs RA | 110 reservas de demo → 13 `checked_out` + 97 `cancelled`, 0 ocupadas; RA: 6 tipos OPERA, 75 re-tipadas, 27 creadas, 45 desactivadas, 5 tipos sintéticos desactivados (102 activas) |
| t1 02:21 | RA llegadas `--apply` | lote `cmu7n7c2g0000fyd38pppgps0`: 383 filas · 383 creadas · 0 · 0 err · 26 avisos |
| t2 02:34 | RA estancias `--apply` | `cmu7nnkca0000fyl4vbkufvmp`: 1.620 · 1.587 creadas · 14 actualizadas · 19 sin cambio · 0 err |
| t3 02:40-02:42 | LT inventario (5 tipos, 74/18/18/4), llegadas, estancias | `cmu7nwad60000fyccfk2wxx17`: 493 · 493 · 0 err · `cmu7nxlg20000fyk3huyn1dw0`: 1.683 · 1.631 · 4 · 48 · 0 err |
| t4 02:48-02:50 | PG inventario (4 tipos, 35/20/21/3), llegadas, estancias | `cmu7o6l1h0000fy8dqaub1mca`: 459 · 459 · 0 err · `cmu7o7pxb0000fyq9rglhimsh`: 1.617 · 1.591 · 11 · 15 · 0 err |
| t5 02:56-03:01 | MC inventario (9 tipos, 34/51/51/4), llegadas (3.278, en `nohup`), estancias | `cmu7oi72b0000fyc8v6m2rn8l`: 3.278 · 3.278 · 0 err · `cmu7olqui0000fycb75mp5xno`: 2.135 · 2.125 · 1 · 9 · 0 err |
| t6 03:07-03:09 | AS inventario (6 tipos, 13/49/65/3), llegadas, estancias | `cmu7ovk2d0000fyiqr94dj8am`: 310 · 310 · 0 err · `cmu7owpj40000fy2z2w5dg05f`: 1.513 · 1.490 · 15 · 8 · 0 err |
| t7 03:19-03:30 | Verificación global (SQL, `verify` × 5, API :3909, suite) | Este documento y el informe externo |
| (L5, árbol principal) 03:48-03:59 | 11 night audits con preflight forzado: RA 09-13 → 09-18 (6), LT 09-14 → 09-18 (5) | Fuera de esta tanda; estado resultante y consecuencias en §5.8-§5.10 |
| t8 04:45-04:50 | Copia `pre-t8-correccion-20260919-0445.dump`; `prep` regenerado (36 columnas, v1 en `prep/v1-t7/`, mismos recuentos por estado); `backfill --apply` × 5; `inventory --apply` × 5; `markRoomClean` × 13 en RA; `verify --in` × 5 | 7.459 reservas corregidas (RA 776 · LT 843 · PG 1.049 · MC 4.070 · AS 721): `guarantee_type` 7.434 · `price_source` → `quoted` 4.779 · nota «importe estimado» retirada 144 · `deposit_paid` 63 · habitación + `Stay` 25 · 0 fallos; 19 tipos `sellable = false`; 13 habitaciones limpias; `verify --in` «Todo cuadra» en los 5 (13 comprobaciones cada uno) |
| t9 05:10-05:17 | Verificación final del integrador: batería SQL `t9-verify.sql`, `verify --in` × 5, API en instancia propia :3909 (parada después), cotejo de usuarios de OPERA, puertas | §8: todo = t8 y = OPERA; 0 usuarios de OPERA en la BD; sin escrituras de datos (6 eventos de auditoría de inicio de sesión) |

Totales de los 10 lotes: **13.491 filas · 13.347 creadas · 45 actualizadas · 99 sin cambio · 0 omitidas · 0
errores** · 10.905 avisos (`POSSIBLE_DUPLICATE` heurístico 3.204, `HISTORICAL` 5.765, `CANCELLED_AT_IMPORT` 2.437,
`OVERBOOKING` 49, `LONG_STAY` 3, `SYNC_DIFF` 45; 0 `ROOM_UNAVAILABLE`, 0 `OPERA_CONFLICT_LOCAL_RESERVATION`). Σ
importes en BD: llegadas 1.687.714,02 € · estancias 2.737.681,62 €. En la tabla `reservation_imports` quedan además
7 lotes `undone` (4 de la demo deshechos en t0 y 3 anteriores a la tanda).

## 4. Verificación global (t7)

| Comprobación | Resultado |
|---|---|
| Por estado (5 hoteles) | = OPERA menos pseudo / day-use / > 365: confirmed 4.923 · checked_in 148 · checked_out 5.765 · no_show 74 · cancelled 2.437 = 13.347 (13.364 `RESV_NAME_ID` distintos − 16 − 1) |
| `verify` del CLI | RA, LT, PG, MC, AS: 9/9 OK cada uno («Todo cuadra»), logs `prep/logs/<HOTEL>-verify-t7.txt` |
| En casa a 18/09 por habitación | 148 = OPERA habitación por habitación; `rooms.status = occupied` 148; `stays in_house` 148 con `checkin_at` = llegada 15:00 local; 21 alojados con salida prevista 18/09 seguían CHECKED IN en OPERA al corte (AS 2 · LT 9 · PG 7 · RA 3) y así quedan |
| Llegadas 18/09 · 19/09 | confirmed AS 23 · LT 52 · MC 10 · PG 26 · RA 33 = 144 (+ 3 CHECKED IN con llegada 18/09 en LT, PG, RA) · 19/09 AS 16 · LT 5 · MC 15 · PG 16 · RA 30 = 82 |
| RN agosto 2026 | AS 1.500 · LT 1.728 · MC 2.147 · PG 1.401 · RA 2.196 = 8.972 (LT = History & Forecast de 7b) |
| OPERA bruto → cargado (`verify --in`, t8) | Estancias brutas 10.322 = 8.568 escritas + 1.737 pseudo PM/PI (AS 88 · LT 486 · MC 495 · PG 119 · RA 549) + 16 day-use + 1 de 734 noches; llegadas brutas 5.402 = 4.923 escritas + 479 filas repetidas de marcadores (RA 472 · AS 7). Por `RESV_STATUS` (bruto → escritas): CHECKED OUT AS 1.137 → 1.065 · LT 1.728 → 1.260 · MC 1.755 → 1.282 · PG 1.085 → 983 · RA 1.704 → 1.175; CHECKED IN 30 → 23 · 42 → 28 · 64 → 52 · 36 → 23 · 34 → 22 (206 → 148: 58 masters PM/PI en casa en la pantalla de OPERA); CANCELLED 396 → 386 · 338 → 327 · 790 → 777 · 578 → 574 · 386 → 373; NO SHOW 16 · 16 · 14 · 12 → 11 · 17; RESERVED 23 · 52 · 10 · 26 · 33 sin excluir |
| Tipos y habitaciones | activos = OPERA (tipos 6/5/9/4/6; habitaciones 62/92/85/55/102); tipos sintéticos activos 0 y, desde t8, `sellable = false` los 19; `rate_days` huérfanos RA 900 · LT 1.460; 0 `rate_days` en los 30 tipos OPERA |
| Garantía, precio y depósito (t8) | `guarantee_type` 7.434 (DG 3.866 · CC 2.182 · 4P 954 · DP-REC 278 · DB 41 · 6P 35 · DP 31 · VC 23 · PD 22 · GM 2); `price_source` `file` 8.568 (exacto) / `quoted` 4.779 (estimado tarifa × noches, sin nota en las 144 enlazadas); `deposit_paid` 63; `checked_out` sin habitación ni `Stay` 1 (AS 114); `stays` 5.903 → 5.928 |
| Cupo por noche y tipo | ≤ habitaciones activas en 27/30 tipos; 3 excesos propios de OPERA: MC DND2 (19 noches de 2027, hasta 17/12: bloques de grupo), LT DND3 (26/09/2026, 7/6 llegadas sin habitación), PG DND2 (04/09/2026, 26/25: 1 solape histórico blanqueado); 0 dobles asignaciones físicas |
| Cronograma RA por API | instancia propia :3909 (`RUN_SCHEDULERS=false`, `TENANT_BOOTSTRAP_SKIP=true`, parada después): `GET …/reservations?from=2026-09-01&to=2026-10-01&status=confirmed,checked_in` → 175 = 153 + 22, `X-Total-Count 175`, 172 con habitación; noches 18/09 52 · 19/09 65 = SQL |
| Duplicados por referencia | 0; enlaces sombra 13.381 = 13.347 + 34 de la demo |
| Huéspedes | 13.436 = 89 + 13.347 (una ficha por reserva) |
| Folios | Al cierre de t7: 5.765 `closed` + 7.582 `open`; 0 líneas, 0 cargos, 0 facturas. **Tras L5 (03:48-03:59):** 153 líneas `room` = 15.867,35 € en 47 reservas reales en casa de RA (70 / 7.314,63 € / 21) y LT (83 / 8.552,72 € / 26), 12 de ellas noches posteriores a la salida (1.152,74 €); los folios de canceladas / no-show de RA y LT los cerró el audit (`close_settled_folios`), los 1.778 de PG / MC / AS siguen `open` hasta su primer audit (el importador ya los cierra desde t8) |
| Invariantes | facturas 33 (RA 25) · VeriFactu 41 (RA 33) · permisos 250 · roles Faranda 24 · `pms_shadow_revenue_imports` 2 · `journal_entries` 143.279 · huéspedes 13.436 — idénticas antes y después de cada tramo, de la instancia :3909 y de t8 |
| Auditoría | 4 eventos no persistidos por colisión de id corto (RA llegadas 1 `RoomAssigned`; PG estancias 1 `RESERVATION_CANCELLED`; MC llegadas 1 `ROOM_ASSIGNED` + 1 `ReservationCreated`); datos intactos; **cadena hash rota en 4 puntos** (UTC): `audit_events` PG 2026-09-19 00:50:23.761 y MC 00:58:26.374, `event_stream` RA 00:22:00.338 y MC 00:58:38.027 (§5.4) |
| Fechas de negocio | Al cierre de t7: RA 09-13 · LT 09-14 · PG 09-16 · MC 09-17 · AS 09-19 (fila creada por el primer dry-run); `night_audit_runs` 0. **Tras L5:** RA = LT = AS = 2026-09-19 (11 runs `completed`, preflight forzado), MC 09-17, PG 09-16; 108 llegadas del 18/09 `confirmed` con llegada anterior a la fecha de negocio (RA 33 · LT 52 · AS 23) |
| Housekeeping RA (t8) | 16 habitaciones activas `dirty` heredadas de la demo → 13 vacantes limpias por `markRoomClean` (`ROOM_MARKED_CLEAN` × 13); 104, 117 y 411 (ocupadas por huéspedes reales) se dejan: el servicio pondría `status = clean` y rompería la ocupación |

## 5. Desviaciones con causa (ninguna bloqueante)

1. **Sobreventa de categoría en OPERA** (MC DND2 en 4 semanas de grupo de 2027: un bloque preasignado a las 12 DND2
   físicas y otro sin habitación en la misma categoría; LT DND3 el 26/09): cada exceso lleva su aviso
   `OVERBOOKING` en `reservation_import_rows`; a preguntar a recepción si se reubican.
2. **Avisos `OVERBOOKING` de los lotes de estancias** (RA 10 · LT 2 · PG 11 · MC 1 · AS 12): regla de rango del PMS que
   suma reservas ya enlazadas por referencia; el recuento por noche en BD no supera el cupo en ningún caso.
3. **21 due-out del 18/09 en casa** (fiel al fichero de OPERA) y **26 estancias cerradas sin habitación** por la
   regla de solape de t0 → corregido en t8 (regla nueva + `backfill`: 25 repuestas, 1 sigue sin habitación por
   solapar a la alojada de AS 114).
4. **Colisión de ids cortos de auditoría** (`aud_`/`evt_` + 8 hex) con eventos previos del mismo día: 4 eventos
   perdidos en 3 lotes y **cadena hash rota en 4 puntos** (UTC: `audit_events` PG 00:50:23.761 y MC 00:58:26.374;
   `event_stream` RA 00:22:00.338 y MC 00:58:38.027; una cancelación, dos asignaciones de habitación y un alta
   sin traza). `audit.service.ts` líneas 76 y 107, fuera del alcance de esta tanda: **tarea para el orquestador**
   (ampliar el id o reintentar con otro ante `Unique constraint failed`); no se ha reparado la cadena.
8. **Night audits de L5 sobre reservas reales (03:48-03:59 CEST, [alto], abierto):** 11 cierres con preflight
   forzado en RA (09-13 → 09-18) y LT (09-14 → 09-18) 8-20 min después de t7 y antes de los check-ins de
   recepción, justo lo que el runbook §19.8 pedía no hacer. (a) 108 llegadas reales del 18/09 siguen `confirmed`
   con llegada anterior a la fecha de negocio (RA 33 · LT 52 · AS 23): el preflight las lista como «no-shows sin
   resolver» (`canClose = false`) y el cierre del 19/09 las convertiría en `no_show` con penalización; el
   check-in por endpoint solo cabe hoy (ventana ±1 día). (b) 153 líneas `room` = 15.867,35 € sobre 47 folios
   reales (contradice la decisión 3 del brief salvo decisión explícita); Mi día RA 6.312,68 € / LT 5.751,57 € de
   saldo pendiente. Decisiones para el orquestador: hacer hoy los 108 check-ins (o pausar el cierre del 19/09
   en RA / LT / AS) y conservar o anular las 153 líneas. Nada de esto lo toca esta tanda.
9. **12 noches cobradas después de la salida (1.152,74 €)** por `post_room_charges` del cierre del 18/09 a
   alojados con salida 18/09 (RA 3 = 240,82 € · LT 9 = 911,92 €; ids de línea en el informe externo §7): sin
   mecanismo de anulación de líneas en el producto (solo alta y transferencia). Regla: los due-out del corte
   salen ANTES de cerrar ese día (runbook §19.8).
10. **Cronograma en vista mes truncado a 500 reservas** (`LiveTimelineWorkspace.tsx`, `limit: 500` sin cursor ni
    filtro de estado): agosto de 2026 tiene 1.089-1.582 reservas por hotel en la ventana de 32 días; las vistas
    semana / 14 días caben. Fuera de los ficheros de la tanda: documentado en el runbook §19.11 con propuesta.
11. **Residuos de la demo de RA con salida futura** (`RES-00006` 411, `RES-00007` 601, `RES-00008` 202,
    `RES-00156` 119: `checked_out` por el check-out sombra pero con `departure_date` hasta el 19-20/09): 9 pares
    demo / real solapados en el cronograma y 2 salidas de demo en Mi día. `PATCH` no admite cerradas: decisión
    (acortar `departure_date` al 19/09 por el orquestador o aceptarlas como historial), runbook §19.11.
12. **Huéspedes sin deduplicar** (una ficha por reserva: 953 nombres repetidos = 5.310 fichas; 13 nombres con ≥ 50
    fichas = 1.989 rooming-lists de grupo cargadas como personas): decisión de producto documentada en el runbook
    §19.11 (fichas de grupo, `GUEST_NAME_ID` como enlace opaco); no se ha fusionado nada.
5. **Fecha de negocio de AS creada por el dry-run** (`getCurrentBusinessDate` crea la fila si falta): AS no
   tendrá night audit del 18/09; sus 23 llegadas del 18/09 siguen `confirmed`.
6. **`--force` sobre `<HOTEL>-llegadas.csv` después de las estancias revertiría los 45 totales corregidos**:
   prohibido en el runbook (§19.7).
7. **Duplicidad de agente en t6**: dos instancias ejecutaron la misma secuencia; el hash de contenido por (feed,
   business date) devolvió 409 `RESERVATION_IMPORT_DUPLICATE` al segundo apply: un solo lote por feed en BD.
13. **Dobles asignaciones históricas visibles desde t8** (t9): 28 pares / 35 noches de estancias CERRADAS solapadas en
    la misma habitación (AS 9 / 11 · LT 9 / 13 · MC 1 / 1 · PG 5 / 5 · RA 4 / 5) = cambios de habitación a mitad de
    estancia que OPERA refleja con la última habitación y que t8 conserva a propósito; con alguna reserva viva: 0.
    En t7 la misma consulta daba 0 porque el prep las blanqueaba (y dejaba 26 cerradas sin habitación ni `Stay`).
14. **Escrituras concurrentes de otras sesiones sobre la BD compartida** (t9): durante la verificación otra sesión
    ejecutó una suite de integración como `usr_123` (11 `PROPERTY_SWITCHED`, `ROLE_CREATED_FROM_TEMPLATE`, 3
    `RESERVATION_CREATED` en RA borradas después: 0 reservas creadas hoy en RA). Las cadenas de auditoría
    conservan eventos de reservas que ya no existen; y las 4 sesiones de la instancia :3909 añadieron 2 puntos de
    bifurcación (deuda 12(c): tip en memoria por instancia; hoy 52 puntos / 127 eventos en `audit_events`).

## 6. Huecos y peticiones (detalle en el informe externo §6)

- **Configuración de OPERA a pedir:** `cf_roomtypes` (nombres y ocupación de las 12 categorías; 15 habitaciones con
  dos categorías), `cf_rooms` (Alisas 62 vistas de 78; Rías Altas 102 de 103), `cf_marketcodes`, `cf_origincodes`
  (CRS, HTP, SAL, SLC, XX, GPI, HSE), `cf_ratecodeheader` (para dejar de ignorar tarifas), garantías / pagos DB, EF,
  DEPFW, EXP.
- **Ingresos:** ningún informe por transaction code → `pms_shadow_revenue` vacío, 0 asientos; pedir
  `GEN_XMLBO_REVENUE` / `findeptcodes` por día y hotel.
- **Listado de en casa y salidas a 19/09** para cuadrar el primer día operado en ehotelOS.
- **Cortes futuros por `RESPONSYS_RESV_AUTO`**: enlazan por nº de confirmación y la carga bulk por
  `RESV_NAME_ID`: reindexar `pms_shadow_links.confirmation_no` o pedir `RESV_NAME_ID` en el export.
- **`guarantee_type`**: cerrado en t8 (columna extra `garantia` del prep reconocida por el importador; 7.434
  reservas con garantía). Un campo canónico en `RESERVATION_IMPORT_FIELDS` (`packages/shared`) sigue siendo
  decisión de producto; una reserva enlazada no actualiza la garantía (`ReservationShadowPatch`).
- **Importe de las llegadas**: `price_source = quoted` (t8) en las 4.779 con total tarifa × noches; pedir a OPERA
  el informe con total por reserva (o rate detail) para sustituirlo; `board_type` vacío aunque `PKBB*` son
  paquetes con desayuno (pendiente de `cf_ratecodeheader`).
- **BAR de los tipos OPERA**: 0 `rate_days` en los 30 tipos → cotizar / crear desde la UI y publicar BAR no
  funciona; plan en el runbook §19.11 (tarifas reales por temporada o BAR derivada de `SHARE_AMOUNT` con
  `RATE_CODE = BASE`); `rate_days` huérfanos de los tipos sintéticos (RA 900 · LT 1.460). Mapa código OPERA →
  tipo ahora en el runbook §19.11 para que recepción lo confirme.
- **Housekeeping de RA:** 13 de las 16 «sucias» de la demo limpias en t8 por `markRoomClean`; 104, 117 y 411 se
  limpian por Housekeeping al salir los huéspedes reales.
- **Huéspedes:** una ficha por reserva sin deduplicar (5.310 fichas con nombre repetido; ~2.000 son rooming-lists
  de grupo): decidir fichas de grupo y conservar `GUEST_NAME_ID` como enlace opaco (runbook §19.11).
- **L5 (abierto, [alto]):** RA y LT ya cerrados hasta el 18/09 y AS nacida en 19/09 → decidir HOY los 108
  check-ins del 18/09 (o pausar el cierre del 19/09), qué hacer con las 153 líneas de alojamiento (15.867,35 €)
  y las 12 noches posteriores a la salida (1.152,74 €); PG y MC aún sin avanzar: hacer sus check-outs de due-out
  del 18/09 y check-ins ANTES de cerrar el 18/09 (§5.8-§5.9; runbook §19.8).
- **Auditoría:** cadena hash rota en 4 puntos por ids cortos (§5.4): tarea sobre `audit.service.ts` para el
  orquestador.
- **Cronograma mes** truncado a 500 (§5.10) y **residuos de la demo de RA** con salida futura (§5.11).

## 7. Comandos reproducibles

```bash
WT=~/anfitorio-demo-wt-opera/hotelos; OR=~/anfitorio-demo/pilots/faranda-celuisma/opera-real
cd $WT && corepack pnpm --filter @hotelos/api typecheck && corepack pnpm --filter @hotelos/api test
cd $WT/apps/api; RUN=(node --env-file-if-exists=../../.env --import tsx)
"${RUN[@]}" src/scripts/import-opera-reports.ts prep --in "$OR" --out "$OR/prep"
"${RUN[@]}" src/scripts/import-opera-reports.ts inventory --property <id> --plan "$OR/prep/<HOTEL>-inventario.json" [--apply]
"${RUN[@]}" src/scripts/import-opera-reports.ts apply --property <id> --file "$OR/prep/<HOTEL>-llegadas.csv" --feed arrivals --business-date 2026-09-18 [--apply] --json
"${RUN[@]}" src/scripts/import-opera-reports.ts apply --property <id> --file "$OR/prep/<HOTEL>-estancias.csv" --feed inhouse --business-date 2026-09-18 [--apply] --json
"${RUN[@]}" src/scripts/import-opera-reports.ts verify --property <id> --expected "$OR/prep/RESUMEN.json" --hotel <HOTEL>
"${RUN[@]}" src/scripts/import-opera-reports.ts verify --property <id> --in "$OR" --hotel <HOTEL>            # t8: contra los xlsx brutos (13 comprobaciones)
"${RUN[@]}" src/scripts/import-opera-reports.ts backfill --property <id> --hotel <HOTEL> --out "$OR/prep" [--apply] --json   # t8: corrección de lo cargado
psql "$DATABASE_URL" -f "$OR/prep/logs/t7-verify.sql"     # batería SQL de la verificación (solo lectura)
psql "$DATABASE_URL" -f "$OR/prep/logs/t9-verify.sql"     # t9: batería t7 + garantía / precio / L5 / auditoría / RBAC / dobles asignaciones (solo lectura)
cd $WT/apps/api && PORT=3909 RUN_SCHEDULERS=false TENANT_BOOTSTRAP_SKIP=true node --env-file-if-exists=../../.env --import tsx src/server.ts   # instancia propia; matar al terminar
curl -s "http://127.0.0.1:3909/properties/<RA>/reservations?from=2026-09-01&to=2026-10-01&status=confirmed,checked_in&limit=500&envelope=1" -H "authorization: Bearer <token>"   # 175
```

## 8. Verificación final del integrador (t9, 2026-09-19 05:10-05:17 CEST)

Sin cambios de datos desde t8: la BD está como la dejó la corrección. Comprobado por tres vías, todas de solo
lectura (la instancia :3909 solo escribió 6 eventos de auditoría de inicio de sesión):

| Comprobación | Resultado t9 |
|---|---|
| SQL (`opera-real/prep/logs/t9-verify.sql` → `t9-verify.out`) | reales 13.347 (confirmed 4.923 · checked_in 148 · checked_out 5.765 · no_show 74 · cancelled 2.437; AS 1.800 · LT 2.124 · MC 5.403 · PG 2.050 · RA 1.970) = t8 = OPERA menos pseudo / day-use / > 365; en casa 148 habitación por habitación; llegadas 18/09 144 (+ 3 en casa) · 19/09 82; RN agosto 8.972; duplicados 0; enlaces 13.347 (+ 34 demo); huéspedes 13.436 (13.347 vínculos, 13.347 distintos); `guarantee_type` 7.434 · `quoted` 4.779 / `file` 8.568 · `deposit_paid` 63 · cerradas sin `Stay` 1 |
| `verify --in` × 5 (`<HOTEL>-verify-t9.txt`) | 13/13 OK y «Todo cuadra» en los 5 hoteles; cuerpo idéntico a t8 |
| API :3909 (`t9-api-3909.txt`) | RA `GET …/reservations?from=2026-09-01&to=2026-10-01&status=confirmed,checked_in` = 175 (153 + 22, `X-Total-Count` 175, 172 con habitación) · LT = 302 (274 + 28, 146 con habitación); noches vivas RA 18/09 52 · 19/09 65 · 20/09 42 · … · 26/09 20 y LT 71 · 73 · 64 · 37 · 56 · 67 · 86 · 86 · 69 = SQL; vista semana RA (12-27/09, sin filtro) 430 items < 500, 24 residuos de demo, 1 habitación con dos barras el 19/09 (411); llegadas 18/09 · 19/09 por API = SQL en los 5; Mi día RA 30 llegadas · 12 salidas (10 + 2 demo) · 6.312,68 € pendiente, LT 5 · 2 · 5.751,57 €, PG 16 · 6 · 0, MC 15 · 23 · 0, AS 16 · 10 · 0; inventario por API = SQL (tipos activos 6 / 5 / 4 / 9 / 6 con código OPERA; habitaciones 102 / 92 / 55 / 85 / 62); RBAC `recepcion.rias` → LT 404 |
| Inventario | 30 tipos OPERA activos y vendibles; 19 sintéticos `active = false, sellable = false`; 0 `rate_days` en los tipos OPERA; huérfanos RA 900 · LT 1.460; cupo: 3 excesos de OPERA (MC DND2, LT DND3, PG DND2); dobles asignaciones con reserva viva 0 (entre cerradas 28 pares / 35 noches por diseño de t8, §5.13) |
| Usuarios de OPERA en la BD | **0**: 83 valores distintos de `INSERT_USER` / `UPDATE_USER` (42 con correo, 125 tokens) cotejados contra `users` (correo y nombre), `guests.email`, `reservations.notes`, `reservation_import_rows`, `audit_events` y `event_stream` → 0 en las 8 comprobaciones; 0 `@` en CSV y logs del prep; `users` 33 (Faranda 32), 0 creados hoy |
| Invariantes | facturas 33 (RA 25) · VeriFactu 41 (RA 33) · permisos 250 · roles Faranda 24 · asignaciones de rol vivas de Faranda 31 (+ 1 revocada) · `pms_shadow_revenue_imports` 2 · `journal_entries` 143.279 · `reservations` 13.466 filas antes y después de la instancia :3909 |
| Fechas de negocio / L5 | Sin cambios desde t8: RA = LT = AS 2026-09-19, MC 09-17, PG 09-16; `night_audit_runs` 11; 108 llegadas del 18/09 `confirmed` (RA 33 · LT 52 · AS 23); 153 líneas `room` = 15.867,35 € (12 posteriores a la salida = 1.152,74 €); 0 `no_show` desde el corte; folios reales cerrados 6.498 / abiertos 6.849 |
| Puertas | `corepack pnpm --filter @hotelos/api typecheck` OK · `test` 2.351 · 2.350 pass · 1 skipped · 0 fail |
| Docs | «formato real confirmado 2026-09-19» en `reservas-importacion.md` §19 (+ §19.12 con esta verificación), `opera-modo-sombra.md` §15 y `OPERA-CLOUD-MODO-SOMBRA.md` §11 |

**Estado de los hallazgos de la revisión** (identificadores del orquestador):

| Hallazgo | Estado | Dónde |
|---|---|---|
| FO-01 «0 omitidas» solo frente al prep filtrado | Cerrado (t8): `verify --in` contra los xlsx brutos, tabla «OPERA bruto → cargado» (1.754 excluidas a propósito + 479 repetidas), §0 y §5.1 del informe externo reescritos | §4, runbook §19.4 |
| FO-02 garantía no persistida | Cerrado (t8): columna extra `garantia` → `guarantee_type` en 7.434 | §1, §2.9 |
| FO-03 importes estimados como `file` | Cerrado (t8): `importe_estimado` → `price_source = quoted` en 4.779; `diffFields` no deja que un estimado pise un total exacto; tarifa BAR / Rate Grid vacía documentada como decisión de negocio | §2.8, §6 |
| FO-04 26 cerradas sin habitación ni `Stay` | Cerrado 25/26 (t8); la restante (AS) solapa a una alojada y se deja por diseño | §2.5, §5.3 |
| PII-01 cadena de auditoría rota (4 puntos) | Documentado, no reparado (`audit.service.ts` fuera del alcance): tarea para el orquestador | §5.4 |
| PII-02 huéspedes sin deduplicar | Documentado como decisión de producto (fichas de grupo, `GUEST_NAME_ID` como enlace opaco, no fusionar por nombre); nada fusionado | §5.12, runbook §19.11 |
| PII-04 Rate Grid vacía y mapa OPERA → tipo | Documentado: mapa en el runbook §19.11 y plan de BAR (real o derivada); no ejecutado (decisión de negocio) | §6 |
| OC-01 night audits de L5 antes de los check-ins (108 llegadas en trampa de no-show, 153 cargos) | Abierto, decisión urgente del orquestador (hoy); nada tocado por la tanda | §5.8, runbook §19.8 |
| OC-02 12 noches cobradas después de la salida (1.152,74 €) | Abierto, sin mecanismo de anulación de líneas en el producto | §5.9 |
| OC-03 cronograma «mes» truncado a 500 | Documentado con propuesta (cursor / filtro de estados); fuera de los ficheros de la tanda; las vistas semana y 14 días caben (RA 12-27/09 = 430 por API) | §5.10 |
| OC-04 residuos de la demo de RA con salida futura | Documentado con SQL propuesto (4 reservas, ids explícitos) o aceptarlas como historial; por API se ven 24 residuos en la semana y la 411 con dos barras | §5.11 |
| OC-05 documentos describían un estado superado y §5.5 negaba :3000 | Cerrado: runbook §19.8 / §19.10 / §19.12, informe externo §5.5-§5.6 / §7 / §9 y este documento describen el estado tras L5 y t9; `127.0.0.1:3000` es el API (`hotelos-api`) | este §8 |
