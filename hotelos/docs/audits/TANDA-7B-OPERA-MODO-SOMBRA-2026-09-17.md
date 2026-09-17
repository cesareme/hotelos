# Tanda 7b · OPERA Cloud en modo sombra · Cierre, correcciones y demo de Rías Altas — 17 de septiembre de 2026

**Para:** César. **Encargo (16/09/2026):** «seguir con OPERA Cloud como sistema de registro en España y extraer su
información a diario o en bulk hacia Anfitorio (modo sombra)». **Método:** diseño previo verificado contra la
documentación de Oracle (`docs/design/OPERA-CLOUD-MODO-SOMBRA.md`, leyenda [V]/[S]) → L0 (schema, migración
`20260917100000_opera_modo_sombra`, tipos, perfil «OPERA Cloud») → L1 ∥ L2 ∥ L5 (modo `sync` del importador de
la Tanda 7; importador de ingresos diarios con lector XML propio; runbook) → L3 (rutas, ingest por clave de API,
conector de correo, CLI `pms-shadow:pull`, job del líder) → L4 (panel «Modo sombra OPERA») → ronda de corrección
(SC-01…11, SEC-01…10, FUX-7B-01…09, todas cerradas antes de esta integración) → **integración final (este
documento, 17/09 11:15-11:40 CEST):** ficheros sintéticos con las columnas literales de Oracle, demo completa
en la BD local (perfil, adopción, dos cortes de reservas, salidas, ingresos contabilizados y revertidos, ingest
por clave de API, reconciliación con desviación provocada y alerta resuelta), verificación SQL, tres
correcciones de código con test, puertas completas, inventario Cocoa 22 regenerado y decisiones abiertas. Todo
sobre la demo local (Postgres local; API :3000 arrancado a las 10:39 con el código de la tanda **anterior** a
las dos últimas correcciones de la ronda, SEC-04 y SC-07, de las 10:44-10:45; sin reiniciar: lo hace el
orquestador, §9).

**Resultado en una línea:** Rías Altas tiene un perfil de modo sombra `RIAS` (5 room types, 3 rate codes, 13
source codes, 9 payment types, 8 transaction codes → cuentas PGC/USALI); las 29 reservas activas de la demo de
la Tanda 7 (`IMP-RA-2026-101…130`) quedan gobernadas por OPERA; el corte de llegadas del 17/09 (32 filas) creó
**2** reservas (RES-00156 con **check-in sombra** en la 119 y RES-00157), dejó **29 sin cambios** y omitió 1
waitlist; el del 18/09 (34 filas) creó **3** (RES-00158, RES-00159 con rate code sin mapear → BAR + alerta, y
RES-00160 = **reactivación** de la cancelada IMP-RA-2026-119), **actualizó 3** (RES-00122 fechas, RES-00126 tipo
e importe, RES-00134 tarifa e importe), **canceló 1** (RES-00133), dejó 26 sin cambios y abrió la alerta de
**ausencia** de RES-00127 (nunca cancelación automática); el `departure_all` del 19/09 hizo el **check-out
sombra** de RES-00156 (folio cerrado, `Stay` cerrada, 119 sucia); el XML `GEN_XMLBO_REVENUE` del 16/09 se
contabilizó como asiento **nº 110** (6 líneas, 4.120,60 = 4.120,60, centros ROOMS / FNB / OTHER_OPERATED) y el
`findeptcodes` del 15/09 como nº 111, **revertido** por el nº 112; la reconciliación del 16/09 con una
desviación provocada (Arrival Rooms 3 frente a 2) abrió `OPERA_RECON_COUNT_MISMATCH`, Carmen la resolvió con
motivo y el Manager Report corregido dejó el día **en verde** (`lastReconciledDate` 2026-09-16). Invariantes de
Faranda intactas (**25 facturas · 33 envíos VeriFactu · 109 asientos previos + 3 de la tanda · 1 lote de
nómina**); ninguna reserva ajena a las sincronizadas cambió (diff de las 105 → 110 reservas de RA: solo las 4
tocadas a propósito y las 5 nuevas); **0 datos personales** en 9 runs, 5 alertas y 68 filas de lote. Tres
hallazgos de la demo corregidos en código con test (§4). **Las 11 puertas en verde** (§3).

## 1. Alcance y qué cambia

| Tema | Antes (Tanda 7) | Ahora (working tree 17/09) |
|---|---|---|
| Sistema de registro | Anfitorio crea reservas desde un CSV/XLSX (modo crear) | OPERA Cloud sigue mandando; Anfitorio recibe cada día un **corte** (feed) y lo aplica en modo **sincronizar**: fila nueva → `createReservation`; conocida con cambios → `updateReservationShadow` (sin correos ni eventos de dominio); conocida sin cambios → `unchanged` (hash por fila); cancelación / no-show / check-in / check-out → transición; reserva conocida ausente → **alerta**, nunca cancelación automática |
| Clave de identidad | `referencia_externa` como duplicado | Nº de confirmación de OPERA (`RESERVATION_ID` del export Responsys [V]) = `Reservation.externalReference` + enlace `PmsShadowLink` (único por hotel y confirmación, único por reserva); una reserva local con la misma referencia y sin enlace es `OPERA_CONFLICT_LOCAL_RESERVATION` (fila omitida, alerta) |
| Perfil de mapeo | Sinónimos ES/EN sugeridos | Perfil «OPERA Cloud» **explícito** columna a columna: 33 cabeceras de `RESPONSYS_RESV_AUTO` [V] y 19 de `departure_all` [V]; estados OPERA (34 grafías → 6 destinos); diccionarios por hotel (`mappingJson`: room types, rate codes, market / source codes, payment types, pseudo rooms) y transaction codes → cuenta PGC + departamento USALI (`trxMappingJson`) |
| Ingresos | — | Asiento diario por hotel y business date (`sourceType pms_shadow_revenue`, `sourceId <propertyId>:<fecha>`): H 705.x por transaction code con centro USALI, H 477.xx por impuesto, D 4300 por el total; cobros opcionales (`includePayments`); código sin mapear **bloquea** el día; reverso y `replace` en una transacción; periodo cerrado → rollback |
| Entrada de ficheros | Subida a mano | `POST /integrations/pms-shadow/ingest` (pública, `X-Api-Key` de una `DeveloperApp` con scope `pms.shadow.ingest[:<propertyId>]`), buzón de correo con propósito `pms_shadow`, CLI `pms-shadow:pull` (carpeta SFTP o fichero suelto; modo HTTP recomendado; modo directo con los API parados), subida manual desde el panel o desde Reservas › Importar con `?modo=sync&perfil=opera_cloud` |
| Vigilancia | — | Job del líder cada 15 min: `OPERA_FEED_LATE` por feed `required` sin fichero a la hora prevista + 120 min; runs `processing` de más de 30 min → `failed`. Reconciliación diaria (13 métricas de §5.4, tolerancias 0 hab. / 1,00 € / 0,05 €) al recibir `revenue` / `stats` y a demanda; 11 códigos de alerta con resolución auditada |
| Modelo | `ReservationImport` (+ `optionsJson`) | + `pms_shadow_profiles`, `pms_shadow_links`, `pms_shadow_runs`, `pms_shadow_revenue_imports`, `pms_shadow_alerts` (migración aditiva; `ReservationImport.optionsJson` gana `mode`, `feed`, `businessDate`, `horizonDays`, `shadowRunId`, `sync`) |
| Front | Pestaña Importar | Pestaña «Modo sombra OPERA» en Configuración › Módulos e integraciones (`PmsShadowScreen.tsx`, 0 `style={`), asistente de importación en modo sync con el mapeo bloqueado y la columna «Acción», propósito `pms_shadow` en el conector de correo |
| GDPR | Fila sin PII | Ficheros nunca persistidos; runs, alertas y JSON solo con nº de confirmación, códigos OPERA, métricas e importes; `NAME_ON_CARD` jamás se lee; `OPERA_FEED_COLUMNS_CHANGED` nunca cita las columnas recibidas (con «Delimited Data» sin cabecera serían datos del huésped) |

## 2. Lotes y ficheros (working tree, sin commit)

| Lote | Ficheros | Nota |
|---|---|---|
| L0 · Schema, migración, tipos | `packages/database/prisma/schema.prisma`; `prisma/migrations/20260917100000_opera_modo_sombra/`; `packages/shared/src/{pms-shadow-types.ts, pms-shadow-profiles/opera-cloud.ts, accounting-types.ts, reservation-import-types.ts, index.ts}` | 11/11 migraciones · drift 0 |
| L1 · Modo sync | `apps/api/src/modules/pms/{reservation-import.sync.ts (nuevo), reservation-import.{mapping,normalize,service}.ts, pms.service.ts}`, `schemas/reservation-import.schemas.ts`, `__tests__/reservation-import-sync.test.mts`, `tests/integration/pms-shadow-sync.test.mts` | `updateReservationShadow`, check-in / check-out sombra, `computeMissing`, hash salado con (feed, business date) |
| L2 · Ingresos diarios | `apps/api/src/lib/xml-lite.ts` (+ test), `modules/pms-shadow/revenue-import.{parser,posting,service}.ts` (+ tests), `tests/integration/pms-shadow-revenue.test.mts` | XML `GEN_XMLBO_REVENUE`, `findeptcodes` XML / Delimited, `RESPONSYS_TRX` |
| L3 · Rutas, ingest, correo, CLI, job | `modules/pms-shadow/{pms-shadow.routes,pms-shadow.service,pms-shadow.rules,pms-shadow.job,ingest-auth,route-permissions.partial,env.partial}.ts`, `schemas/{pms-shadow,email-connections}.schemas.ts`, `scripts/pms-shadow-pull.ts`, `lib/{auth-context,tenancy,env}.ts`, `security/route-permissions.ts`, `server.ts`, `modules/marketplace/oauth.service.ts`, `modules/integrations/email/email-reservation.service.ts`, `modules/developer/api-reference.service.ts`, `docs/api-contracts.md`, `tests/integration/pms-shadow-routes.test.mts` | 15 rutas; el job vive en el API bajo el líder |
| L4 · Front | `apps/admin-web/src/screens/integrations/{PmsShadowScreen.tsx, pms-shadow-helpers.ts}` (+ tests), `screens/reservations/{ReservationImportScreen.tsx, reservation-import-sync.ts, reservation-import-helpers.ts}`, `screens/aiOperations/EmailConnectorsScreen.tsx`, `screens/tabs/configuracion/ModulosTabs.tsx`, `services/{pmsShadowApi,reservationImportApi,emailApi}.ts`, `App.tsx`, `navigation/nav-tree.generated.json`, tests de rutas y árbol; `<raíz git>/pilots/tanda5-nav-tree.csv` | 190/190 URL; 100 pestañas |
| L5 · Docs | `docs/design/OPERA-CLOUD-MODO-SOMBRA.md` (§10), `docs/runbooks/opera-modo-sombra.md` (nuevo), `docs/runbooks/reservas-importacion.md` (§18) | — |
| Ronda de corrección | SC-01…11, SEC-01…10, FUX-7B-01…09 sobre los ficheros anteriores (diseño §10 filas 18-26) | verificadas antes de esta integración |
| **Integración final (este documento)** | `apps/api/src/modules/pms-shadow/pms-shadow.service.ts` (+13: `computeReconciliation.declared`), `modules/pms/reservation-import.service.ts` (+4: pseudo room), `modules/pms/reservation-import.mapping.ts` (+5: avisos con mapeo explícito), `modules/pms/__tests__/reservation-import-mapping.test.mts` (+11), `tests/integration/pms-shadow-sync.test.mts` (+15, caso 9), `tests/integration/pms-shadow-routes.test.mts` (+22, `describe` final), `tests/integration/structure-e2e.test.mts` (+6: oráculo de Faranda), `docs/runbooks/opera-modo-sombra.md` (§5.2 flags, §10 job, §11 riesgos y roles, §13 FAQ, §14 +3 huecos), `docs/design/OPERA-CLOUD-MODO-SOMBRA.md` (§10 filas 27-30), `docs/api-contracts.md` (2 frases), `docs/design/cocoa-22-inventory.json` y `COCOA-22-MIGRACION.md` §6 (regenerados), este informe. **Fuera del repo** (`<raíz git>/pilots/faranda-celuisma/`, git-ignored): `opera/` con 9 ficheros sintéticos + `README.md` (§5.1) y `OPERA-DEMO-2026-09-17.md` (52 KB: salida íntegra del CLI, del script in-process, del panel por HTTP y de las SQL) | BD local escrita: 1 `developer_apps`, 1 perfil, 34 enlaces (29 adoptados por SQL + 5), 9 runs, 5 alertas (3 resueltas), 3 lotes de reservas, 2 lotes de ingresos, 3 asientos, 5 reservas, 5 huéspedes |

`pnpm-lock.yaml` figura modificado desde antes de la tanda (mtime 16/09 05:32); ningún lote lo ha tocado. Los
scripts de apoyo de la integración viven en el scratchpad (`t7b/gen.mjs` generador de ficheros, `t7b/demo.mts`
llamadas in-process como Carmen, `t7b/preview.mjs` dry-run por HTTP, `t7b/final.sql`) y no forman parte del repo.

## 3. Puertas (17/09/2026 11:28-11:37 CEST, working tree completo tras las correcciones de §4)

| # | Puerta | Comando | Resultado |
|---|---|---|---|
| 1 | Typecheck de todo el workspace | `corepack pnpm run typecheck:all` | **15 PASS · 0 FAIL · 0 XFAIL · 1 SKIP** explícito (`apps/guest-web`, deuda conocida) · 17,7 s |
| 2 | Unitarios API | `corepack pnpm --filter @hotelos/api test` | **1.901 tests · 1.900 pass · 0 fail · 1 skipped** (preexistente `PMS_HF_REAL_CSV`) · 583 suites · 4,5 s (brief 1.755 → +146; +1 de esta integración) |
| 3 | Unitarios front | `cd apps/api && TSX_TSCONFIG_PATH=../admin-web/tsconfig.json node --import tsx --test $(find ../admin-web/src -path '*/__tests__/*.test.mts')` | **1.086 · 1.086 pass · 0 fail** · 327 suites |
| 4 | Contratos raíz | `node --test tests/*.test.mjs` | **445 · 445 pass · 0 fail** (repetido tras las ediciones de docs: 445/445) |
| 5 | Discoverability | `node scripts/check-discoverability.mjs` | **OK**: 221 pantallas · **190/190 URL** · sidebar literals 0 · `SCREEN_COMPONENTS` 214 · árbol 67/100/21/2 · alias 24 · enlaces rotos 0 · placeholders 16/20 |
| 6 | Árbol de navegación | `node scripts/build-nav-tree.mjs --check` | al día: 67 ítems · **100 pestañas** · 205 redirecciones |
| 7 | Inventario Cocoa 22 + contrato | `node scripts/cocoa-22-inventory.mjs` · `node scripts/cocoa-22-waves.mjs --write` · `node --test tests/cocoa-22-contract.test.mjs` | 221 pantallas · 90.495 líneas · **194 puntos**; `style={}` **682 = GLOBAL_CEILING** (las pantallas nuevas de la tanda nacen a 0) · bo-* 0 · `<button>` crudos 0 · `<table>` 2 (excepción `data-cocoa-grid-table`) · inputs crudos 0 · colores literales 0; §6 del plan: 0 pendientes · 0 puntos · 0 lotes; contrato **18/18** (regla 15 «inventario al día» incluida) |
| 8 | Migraciones Prisma | `corepack pnpm --filter @hotelos/database db:migrate:status` · `db:drift:check` | **11 migraciones · «Database schema is up to date!» · «No difference detected.»** (solo el aviso preexistente `package.json#prisma`) |
| 9 | Integración API (Postgres local) | `cd apps/api && node --env-file-if-exists=../../.env --import tsx --test "../../tests/integration/*.test.mts"` | 2.ª pasada **429 tests · 422 pass · 0 fail · 7 skipped** · 85 suites · 6,8 s. Skips: los 6 conocidos (H2 folio 1, `INTEGRATION_RECEPTION_EMAIL` 4, `INTEGRATION_FNB_EMAIL` 1) + la sonda 303 de org_123 «solo con la BD en reposo». La 1.ª pasada falló **1**: el oráculo de Faranda de `structure-e2e.test.mts` contaba «61 asientos previos» sin excluir los `pms_shadow_revenue` que deja esta demo (INT-7B-04, §4); las tres suites de la tanda **39/39** (37 + 2 nuevos) |
| 10 | Worker | `cd apps/worker && node --import tsx --test src/__tests__/notification-dispatcher.test.ts` | **6/6** (`@hotelos/worker` no declara script `test`; el job del modo sombra vive en el API) |
| 11 | Build admin-web | `corepack pnpm --filter @hotelos/admin-web build` | **«✓ built in 2.38s»** · 0 errores · 0 warnings |

`allGreen: true`. Además: clave ligada al centro aceptada por el código del working tree (`authenticateIngestApiKey`
in-process → `propertyIds [RA]`, `allowsLT false`); CLI `--folder --dry-run` clasifica los 9 ficheros sin escribir.

## 4. Hallazgos de la demo y correcciones

### 4.1 Corregidos en código (con test) durante esta integración

| Id | Hallazgo (visto en la demo) | Corrección (verificada) |
|---|---|---|
| **INT-7B-01** | La reconciliación que dispara un run `stats` / `revenue` no veía las métricas de **ese** run: sigue `processing` mientras se calcula y su `resultJson` aún no lleva `declared`. En la demo la desviación del Manager Report (Arrival Rooms 3) solo saltó al llegar el **siguiente** fichero (el Trial Balance), y el `transaction_total_today` del Trial Balance solo lo vería una reconciliación posterior | `computeReconciliation` recibe `declared` en memoria (prioridad sobre los runs cerrados del día) y `ingestPmsShadowFile` se lo pasa (`pms-shadow.service.ts`). Test: `pms-shadow-routes.test.mts` (`describe` final: stats con `arrivalRooms 99` → el propio run registra `mismatch` y abre la alerta con su `runId`; el corregido cuadra y la cierra sola). Verificado en la demo: el Manager Report corregido, ingerido con el CLI en modo directo (código corregido), reconcilió solo → `ok: true` (§5.7) |
| **INT-7B-02** | La fila con pseudo room `PM` (en `pseudoRoomTypes` del perfil) salía **error** `ROOM_TYPE_UNKNOWN` (run `partial`, alerta `OPERA_ROOM_TYPE_UNMAPPED` con el código PM) en vez de omitirse: `rowStatusFromIssues` da prioridad al error de la normalización sobre la omisión `OPERA_PSEUDO_ROOM` que el perfil añadía después | Al aplicar la omisión del perfil se retira el `ROOM_TYPE_UNKNOWN` de la misma celda (`reservation-import.service.ts`): fila `skipped`, sin alerta y sin entrar en `unmappedRoomTypes`. Test: `pms-shadow-sync.test.mts` caso (9). La alerta que dejó :3000 (código anterior) se resolvió con nota (§5.6) |
| **INT-7B-03** | Cada preview con el perfil OPERA emitía **9 avisos** «La columna «RATE_CODE» también parece «Tarifa», ya asignada a otra columna: queda sin mapear» (también `NAME_ON_CARD`, `ROOM_TYPE_TO_CHARGE`, `GUEST_MIDDLE_NAME`…): el sugeridor de sinónimos hablaba de columnas que el perfil mapea o ignora a propósito, y decía «sin mapear» de una columna mapeada | `applyMapping` filtra los avisos del sugeridor de las columnas del mapeo explícito (`reservation-import.mapping.ts`). Test: `reservation-import-mapping.test.mts` («con mapeo explícito no se avisa…»). El resto de avisos (fecha de negocio atrasada, columnas ignoradas) se conserva |
| **INT-7B-04** | `structure-e2e.test.mts` (oráculo de Faranda, solo lectura) contaba 61 asientos previos excluyendo solo `payroll_cost_import`: con el asiento diario de OPERA del 16/09, el del 15/09 y su reverso daba 64 | Excluye también `pms_shadow_revenue` y los reversos cuyo `reversalOfId` apunta a uno de ellos (con `OR [{ reversalOfId: null }, { notIn }]`: `reversalOfId` es nullable y un `NOT { in }` a secas dejaba 9). 61 asientos y 4300 = 379,00 se mantienen |

### 4.2 Corregidos en documentación

| Id | Hallazgo | Corrección |
|---|---|---|
| **INT-7B-05** | Runbook §5.2: «`--move-to procesados` mueve a `<folder>/procesados/AAAA-MM-DD/`» y «dry-run lista feed, business date, hash, tamaño»; el CLI mueve a la carpeta indicada tal cual (ruta relativa al cwd del CLI, `apps/api` con `pnpm --filter`) y el dry-run lista nombre, tamaño y feed | Tabla de flags reescrita (ruta absoluta recomendada, marca de tiempo si el nombre existe) y descripción del modo directo |
| **INT-7B-06** | Runbook §13 FAQ: «El CLI **no** tiene modo directo contra la BD»; §10: «el job ejecuta la reconciliación de los business dates pendientes y reintenta los runs `received`». El CLI sí tiene modo directo (`--apply` sin `--ingest-url`) y el job solo emite `OPERA_FEED_LATE` y cierra runs `processing` de más de 30 min | FAQ y §10 corregidos; diseño §10 fila 30 |
| **INT-7B-07** | Runbook §11: riesgos `resolve` medium y `reverse` high (manifiesto: high y **critical**); las lecturas `accounting.read` de reconciliación e ingresos se remapean a `accounting.reports.read` (t6#9), así que Recepción **no** las lee | Tabla de rutas y fila de Recepción corregidas |
| **INT-7B-08** | Huecos no listados en §14 del runbook: signo de los cobros (XML negativo frente a `findeptcodes` positivo: la preview del Delimited da `totals.payments = -2.900,00`), fila de cabecera del export Responsys [S], adopción de reservas locales | Tres filas nuevas en §14 (decisiones 3, 4 y 1 de §11) |

### 4.3 Observaciones (no bloquean)

1. **:3000 sirve el código de las 10:39** (arranque) y las dos últimas correcciones de la ronda son de las
   10:44-10:45 (SEC-04 scope ligado al centro; SC-07 `departures` con offset −1). Consecuencia visible: la clave
   `pms.shadow.ingest:<RA>` recibió **401** en :3000; la app de demo lleva **los dos scopes** (ligado + de
   organización) hasta el reinicio (§9.1 explica cómo dejar solo el ligado). El código del working tree acepta
   la clave ligada (sonda in-process, §3) y la integración SEC-04 pasa.
2. **Sonda de la clave** (`sonda.csv`, 1 columna): al probarla la ruta ya tenía perfil y quedó un run `failed`
   («El fichero no tiene filas de datos tras la cabecera»), sin alerta. Se conserva (nada se borra); es el run
   nº 1 de la lista del panel.
3. **`OPERA_FEED_LATE` real del job**: a las 09:27 UTC (tick de los 15 min) el líder abrió la alerta de
   `departures` / 2026-09-16 (la programación por defecto espera el `departure_all` de ayer a las 06:30 + 2 h y la
   demo entregó el del 19/09). Resuelta con nota por Carmen: el job funciona sin intervención.
4. **Adopción por SQL** de las 29 reservas de la Tanda 7 (§5.3): no existe ruta de producto para «adoptar» una
   reserva local; sin adopción, el dry-run previo lo demostró: 29 × `OPERA_CONFLICT_LOCAL_RESERVATION`. Decisión
   §11-1.
5. **`sourceCode` guarda el valor del diccionario**, no el código OPERA crudo (L1): para que el primer corte
   saliera «sin cambios» el perfil de la demo mapea `DIR → directo`, `BDC → booking`… (sinónimos de canal de la
   Tanda 7 que ya llevaban las reservas). En un hotel cuyas reservas nazcan del sync se usarían los canónicos.
   Decisión §11-5.
6. **Estado `partial` de los lotes con omisiones por diseño** (waitlist, pseudo room): los 3 lotes de reservas
   de la demo son `partial` aunque 0 filas con error (regla T7 «skipped > 0 → partial»); el run sí distingue
   (`done` con `skipped 1`). Decisión §11-6.
7. **`preview.businessDate`** (nivel raíz, 2026-09-13 = fecha de negocio de la propiedad) frente a
   `preview.options.businessDate` (2026-09-17 = business date del corte): coherente con la Tanda 7 (informativo
   + aviso «va por detrás del calendario»), pero conviene que el asistente muestre la segunda en modo sync.
8. **Una suite de integración escribe y borra en el RA real** (audit_events con `usr_123`, 09:31 UTC: 3
   `RESERVATION_CREATED`, 1 `GUEST_CHECKED_OUT`, 1 parte SES; las reservas ya no existen): invariantes de Faranda
   intactas, pero contradice «Faranda solo lectura» de `CLAUDE.md`. Fuera del alcance de la tanda; anotado.
9. **Cadena de auditoría en memoria (deuda 12(c))**: perfil, tres resoluciones, reverso y la reingesta en modo
   directo se escribieron in-process con el API arriba (hidratación desde Postgres + vaciado de colas, como el
   CLI de la Tanda 7); :3000 rehidrata al reiniciar. `audit_events` 18.698 → 19.197 (demo + suites) → 19.672
   (2.ª pasada de integración).

## 5. Demo de Rías Altas (11:18-11:34 CEST; salida íntegra en `<raíz git>/pilots/faranda-celuisma/OPERA-DEMO-2026-09-17.md`)

Propiedad `cmrhw9jy40003fyvbuu2ec2w7` (RA, `Europe/Madrid`), organización `cmrhw9jy30002fyvb6tsdiugt`, hoy
2026-09-17, `business_dates."current_date"` 2026-09-13 (no avanza en modo sombra: los cortes llevan su
`businessDate` explícita). Estado previo: 25 · 33 · 109 · 1; RA 105 reservas (43 `confirmed` · 9 `checked_out`
· 53 `cancelled`), último código RES-00155, 84 huéspedes, 0 filas en las 5 tablas del modo sombra, 0
`developer_apps`.

### 5.1 Ficheros sintéticos (`<raíz git>/pilots/faranda-celuisma/opera/`, hotel code ficticio `RIAS`)

| Fichero | Feed · business date | Contenido (columnas / elementos [V]; hipótesis [S]) |
|---|---|---|
| `RESPONSYS_RESV_DAY_RIAS_20260917.csv` (5.750 B) | `arrivals` · 2026-09-17 | Export Responsys: 33 columnas literales [V], «,», fechas `YYYYMMDD` [V], fila de cabecera [S]; 32 filas: las 29 activas `IMP-RA` tal cual (RATE = importe ÷ noches ÷ habitaciones; códigos OPERA ficticios STD/SUPV/SGL/JRS/STE, BAR/BARBB/BARNR, DIR/BDC/CO/TA/PH/WEB/EXP/GRP/EM/WI/GDS/WS/ABB, VI/OTA/CL/TR/CA/VO; `NAME_ON_CARD` relleno en las VI) + `RIAS-2026-0201` (Checked In, hab. 119, hoy → 19/09) + `0202` (Reserved) + `0203` (Waitlist) |
| `RESPONSYS_RESV_DAY_RIAS_20260918.csv` (6.086 B) | `arrivals` · 2026-09-18 | Variante manual `_DAY` (incluye Cancelled [V]); 34 filas: `IMP-102` fechas +1 día, `IMP-106` STD → SUPV y RATE 153, `IMP-114` BAR → BARNR y RATE 69,30, `IMP-113` Cancelled, `IMP-107` **ausente**, `IMP-119` Reserved (cancelada en Anfitorio), `0203` Reserved, `0204` rate code `CORP` sin mapear, `0205` room type `PM` |
| `departure_all_RIAS_20260919.txt` (210 B) | `departures` · 2026-09-19 | Informe Departures: 19 columnas [V] en «Delimited Data» **sin cabecera** [S], «;» [S], `DD/MM/YYYY` [S]: hab. 119 «Checked Out» (enlazada) + hab. 305 sin enlace |
| `GEN_XMLBO_REVENUE_RIAS_20260916.xml` (4.927 B) | `revenue` · del XML | `revenue{hotel_code,date}` › `transaction_total{transaction_type}` › `transaction_code, description, total_amount, total_*_ledger` › `transaction_details/transaction{market_code, room_class, trx_amount…}` [V]; 8 códigos: 1000 3.200,00 · 2000 480,00 · 3000 60,00 · 8010 368,00 · 8021 12,60 · 9000 −900,00 · 9010 −2.500,00 · 9500 40,00 (cobros con signo «−» [S]); Σ 760,60 |
| `findeptcodes_RIAS_20260915.xml` (6.302 B) | `revenue` · 2026-09-15 | Informe `findeptcodes` en XML (modelo de datos BI Publisher, elementos `TRN_CODE` / `DESCRIPTION` / `DAY_GROSS` / `DAY_NET` / `MONTH_*` / `YEAR_*` / `BUSINESS_DATE` [S]) con 6 subtotales por grupo y Grand Total; Day Net 1000 2.980,00 · 2000 415,00 · 3000 45,00 · 8010 339,50 · 8021 9,45 · 9000 800,00 · 9010 2.100,00 · 9500 0,00 |
| `findeptcodes_RIAS_20260915_delimited.csv` (1.006 B) | `revenue` (solo preview) | El mismo informe en Delimited con cabecera «Trn. Code, Description, Day Gross, Day Net, …» [V cabeceras] [S formato] |
| `manager_report_RIAS_20260916.xml` / `_v2.xml` (1.988 B) | `stats` · 2026-09-16 | Manager Report (etiquetas [V]: Arrival Rooms, Departure Rooms, Rooms Occupied, % Rooms Occupied, No Show Rooms, Room Revenue, Total Revenue, Total Tax, Average Daily Rate, Revenue per Available Room, Reservations Made Today, Cancellations Made Today; XML [S] con `DESCRIPTION` + `DAY` / `MONTH` / `YEAR`); v1 con la **desviación provocada** Arrival Rooms 3, v2 corregido a 2 |
| `trial_balance_RIAS_20260916.xml` (964 B) | `stats` · 2026-09-16 | Trial Balance (XML [S]): 4 ledgers informativos + `TRANSACTION_TOTAL_TODAY` 760,60 |

Clasificación automática del CLI (`--folder --dry-run`, exit 0, nada escrito): departures 1 · revenue 3 · stats
3 · arrivals 2, todos reconocidos por nombre.

### 5.2 Perfil y clave de API

- **Perfil** (`PUT …/pms-shadow/profile` in-process como Carmen, auditoría `PMS_SHADOW_PROFILE_UPDATED`):
  `id cmu5bi8h30000fy62vxty7dzo`, `operaHotelCode RIAS`, `active`, buzón `opera-rias@example.com`, carpeta
  `/srv/sftp/opera/rias`, programación por defecto (arrivals 06:30/0, departures 06:30/−1, changes 06:30/−1 no
  requerido, revenue 07:00/−1, stats 07:00/−1 no requerido), `mappingJson` con 5 room types, `pseudoRoomTypes
  [PM, HOUSE]`, 3 rate codes, 7 market codes, 13 source codes, 9 payment types; `trxMappingJson` con los 8
  códigos de §8.3 del runbook (1000 → 705.1 rooms · 2000 → 705.2 fnb · 3000 → 705.3 other_operated · 8010 →
  477.10 · 8021 → 477.21 · 9000 → 570 · 9010 → 5721 · 9500 ignore). `GET …/profile` y `GET …/overview` en :3000
  (fail-open dev) lo devuelven.
- **Clave de API**: `developer_apps` `dapp_t7b_opera_rias_demo` («OPERA sombra · Rías Altas (demo Tanda 7b)»,
  `clientId cli_opera_rias_demo7b`, secreto de 40 hex solo en el scratchpad, hash sha256 en BD), scope
  `pms.shadow.ingest:cmrhw9jy40003fyvbuu2ec2w7` → **401** en :3000 (código anterior a SEC-04) y `propertyIds
  [RA]` / `allowsLT false` con el working tree; con el scope de organización añadido, la sonda respondió 202
  (§4.3-2).

### 5.3 Dry-run del corte 1 antes y después de la adopción (`POST …/reservations/imports/preview`, nada escrito)

- **Antes** (29 reservas locales sin enlace): 32 filas · 34 columnas (33 + `__importe_total_estimado`) · acciones
  **create 2 · skip 30** · incidencias `OPERA_TOTAL_ESTIMATED` 32, `OPERA_WAITLIST_SKIPPED` 1,
  **`OPERA_CONFLICT_LOCAL_RESERVATION` 29** · 0 PII en los mensajes · `canImport` sí. Regla §5.1 del diseño
  demostrada: una reserva creada por otra vía no se toca.
- **Adopción** (SQL, 29 filas en `pms_shadow_links`: `confirmation_no = external_reference`, `first_import_id` =
  lote de la Tanda 7 `cmu4t43gh0000fyu01qbc20ri`, `row_hash` centinela `adopted:tanda7:…`, `last_status
  confirmed`, `last_business_date 2026-09-16`).
- **Después**: acciones **create 2 · unchanged 29 · skip 1**; 29 filas con su `reservationCode` (RES-00121…150);
  hash del lote `23e2d0ed…b03e`.

### 5.4 Corte 1 por el CLI en modo HTTP (`pms-shadow:pull --file … --feed arrivals --business-date 2026-09-17 --apply`, clave por `PMS_SHADOW_API_KEY`)

Run **`cmu5bkqwp001vfyt9k4fu17bw`** `done` · `api_key` · 91 ms · **creadas 2 / actualizadas 0 / sin cambios 29 /
transiciones 0 / omitidas 1 / errores 0** · 0 alertas · lote `cmu5bkqxi001wfyt9r2gflp03` (`partial` por la
waitlist; `optionsJson.sync { updated 0, unchanged 29, transitioned 0 }`, `shadowRunId`, `source api_key`,
`createdBy developer_app:cli_opera_rias_demo7b`). Filas: `created` 2 (con `reservation_id`), `unchanged` 29 (sin
`reservation_id`, con `reservation_code`), `skipped` 1.
- **RES-00156** (`RIAS-2026-0201`): `checked_in` con **check-in sombra** (`GUEST_CHECKED_IN` con
  `overrideReason` «Check-in registrado en OPERA (corte 2026-09-17)»), habitación 119 `occupied`, `Stay
  in_house`, folio `open`, 196,00 (98 × 2), canal `direct` / source `web`, `credit_card`, `booker_email NULL`,
  `NAME_ON_CARD` no persistido.
- **RES-00157** (`RIAS-2026-0202`): `confirmed`, DSV, 447,00 (149 × 3), `booking_com`, `online_prepaid`.

### 5.5 Corte 2 (`--business-date 2026-09-18`)

Run **`cmu5blcxw003bfyt9zp9j1gj8`** `partial` · **creadas 3 / actualizadas 3 / sin cambios 26 / transiciones 1 /
omitidas 0 / errores 1** · alertas `OPERA_MISSING_IN_SNAPSHOT`, `OPERA_RATE_CODE_UNMAPPED`,
`OPERA_ROOM_TYPE_UNMAPPED` · lote `cmu5blcyj003cfyt94l5btx2s`.

| Fila | Referencia | Resultado | Evidencia SQL |
|---|---|---|---|
| 7 | IMP-RA-2026-102 (RES-00122) | `updated` · `SYNC_DIFF arrivalDate + departureDate` | 2026-10-13→15 pasa a **2026-10-14→16**; `RESERVATION_SHADOW_UPDATED` sin PII |
| 6 | IMP-RA-2026-106 (RES-00126) | `updated` · `roomTypeId + totalAmount` | DBL → **DSV**, 196,00 → **306,00** |
| 18 | IMP-RA-2026-114 (RES-00134) | `updated` · `ratePlanId + totalAmount` | BAR → **BAR-NR**, 231,00 → **207,90** |
| 17 | IMP-RA-2026-113 (RES-00133) | `transitioned` | **`cancelled`** («Cancelada en OPERA · 2026-09-18»), enlace `last_status cancelled` |
| — | IMP-RA-2026-107 (RES-00127) | ausente del corte (llegada 2026-10-16, dentro de la ventana de 30 días) | sigue `confirmed`; enlace `missing_streak 1`; alerta abierta con nº de confirmación, feed, fecha y racha |
| 23 | IMP-RA-2026-119 | `created` (reactivación, `REFERENCE_REUSED_CANCELLED`) | **RES-00160** `confirmed` nueva; RES-00139 sigue `cancelled`; el enlace apunta a la nueva |
| 3 | RIAS-2026-0203 | `created` (era waitlist) | **RES-00158** IND 144,00 |
| 11 | RIAS-2026-0204 | `created` con `OPERA_RATE_CODE_UNMAPPED` (CORP) | **RES-00159** con tarifa por defecto **BAR**, 176,00; alerta con `codes [CORP]` |
| 5 | RIAS-2026-0205 (room type PM) | `skipped` (`INVALID_SKIPPED` por `ROOM_TYPE_UNKNOWN`) → contado como **error** y alerta `OPERA_ROOM_TYPE_UNMAPPED [PM]` | **INT-7B-02**: con el código corregido la fila es `skipped` `OPERA_PSEUDO_ROOM` sin alerta; la alerta se resolvió con nota |
| resto | 26 referencias | `unchanged` | `last_business_date 2026-09-18`, `missing_streak 0` |

### 5.6 Salidas, ingresos, reverso y previsualización

- **Salidas** (`--feed departures --business-date 2026-09-19`): run **`cmu5bml170055fyt92gj30a3w`** `partial` ·
  transiciones 1 · errores 1 · `headerOverride true` (fichero sin cabecera → las 19 columnas del perfil). Fila 1
  casada por (habitación 119, 17/09, 19/09) con `RIAS-2026-0201` → **check-out sombra**: RES-00156 `checked_out`,
  `Stay checked_out` (`checkout_at` 09:22:20 UTC), folio **`closed`**, 119 `dirty`, enlace `checked_out`;
  fila 2 (hab. 305, sin enlace) → `SYNC_REQUIRES_REFERENCE` (error contado, nada creado).
- **Ingresos 16/09** (`--feed revenue`, fecha del XML): run **`cmu5bmlc80059fyt90u69y68i`** `done` · 7 líneas
  contabilizables + 1 ignorada · lote **`cmu5bmlcf005afyt9wbnrssd3`** `posted` (`totals revenue 3.740,00 · tax
  380,60 · payments 3.400,00 · other 40,00`; cuadre `sumTotalAmount 760,60`) · asiento **nº 110**
  (`pms_shadow_revenue`, `sourceId cmrhw9jy40003fyvbuu2ec2w7:2026-09-16`, `entry_date 2026-09-16`, `posted`):
  D 4300 4.120,60 · H 705.1 3.200,00 `ROOMS` · H 705.2 480,00 `FNB` · H 705.3 60,00 `OTHER_OPERATED` (centro creado
  por `ensureUsaliCostCentres`) · H 477.10 368,00 (`tax_rate_code 10`) · H 477.21 12,60 (`21`) → **4.120,60 =
  4.120,60**. Sin cobros (`includePayments` no viaja por el ingest: quedan en `totals.payments`).
- **Ingresos 15/09** (`findeptcodes` XML): run **`cmu5bno07005jfyt96s3m9dgr`** `done` · lote
  **`cmu5bno0d005kfyt9mq11qmda`** `posted` · asiento **nº 111** (D 4300 3.788,95 · H 705.1 2.980,00 · 705.2
  415,00 · 705.3 45,00 · 477.10 339,50 · 477.21 9,45). Avisos del parser: 7 filas de subtotal / total descartadas.
- **Reverso** (`reversePmsShadowRevenue` in-process como Carmen, motivo «Demo Tanda 7b: lote findeptcodes del
  15/09 revertido…»): lote `reversed`, `reversalJournalEntryIds [cmu5borhr0000fyshhri3wbwd]` = asiento **nº 112**
  (`source_type reversal`, `reversal_of_id` = nº 111, 6 líneas espejo, 3.788,95 = 3.788,95); nº 111 `reversed` con
  `reversed_by_id`; auditoría `PMS_SHADOW_REVENUE_REVERSED` + `JOURNAL_ENTRY_REVERSED`. Nunca `deleteMany`.
- **Previsualización** del `findeptcodes` Delimited (`previewPmsShadowRevenue`, nada escrito): 8 líneas mapeadas,
  `canPost` sí, `totals { revenue 3.440,00, tax 348,95, payments −2.900,00, other 0,00 }` (signo de los cobros,
  §11-3), avisos «7 fila(s) de subtotal / total descartadas» y «El informe no declara el business date».

### 5.7 Reconciliación con desviación provocada → alerta creada y resuelta

1. `manager_report_RIAS_20260916.xml` (`--feed stats --business-date 2026-09-16`): run
   `cmu5bnoaq005sfyt9vjhok358` `done`, 12 métricas declaradas; su reconciliación salió `ok: true` porque no veía
   sus propias métricas (**INT-7B-01**).
2. `trial_balance_RIAS_20260916.xml`: run `cmu5bnol4005tfyt9aic92t8s` `done`, `transactionTotalToday 760,60`;
   la reconciliación (ya con el Manager Report cerrado) detectó **arrivals: OPERA 3 · Anfitorio 2 (Δ −1)** →
   alerta **`OPERA_RECON_COUNT_MISMATCH`** `error` `cmu5bnolf005vfyt97pdc1w3r` (`expected {arrivals: "3"}`,
   `actual {arrivals: "2"}`, `runId` del Trial Balance). `GET …/reconciliation?businessDate=2026-09-16`: 13 filas
   = 1 `mismatch` (arrivals) · 9 `ok` (departures 0, rooms_occupied 0, occupancy_pct 0,00, no_shows 0,
   revenue_rooms 3.200,00, revenue_total 3.740,00, tax_total 380,60, revpar 26,67, transaction_total_today
   760,60) · 3 `missing` (adr sin habitaciones ocupadas, reservations_made y cancellations por diseño SC-04).
3. **Resolución** (`resolveAlert` in-process como Carmen, `PMS_SHADOW_ALERT_RESOLVED`): `resolvedAt`
   2026-09-17T09:25:14Z, `resolvedBy cmrhw9jyb0005fyvb4ykaumyc`, nota «Comprobado en OPERA: la tercera llegada
   del 16/09 es un walk-in sin reserva previa…».
4. `manager_report_RIAS_20260916_v2.xml` con el **CLI en modo directo** (código corregido): run
   `cmu5bvgvp0000fygwh8mitf1a` `done` · reconciliación **`ok: true`** con sus propias métricas · sin alerta nueva ·
   `GET …/overview`: `lastReconciledDate 2026-09-16`, `linkedReservations 34`, feeds arrivals `ok`, departures
   `late`, changes `pending`, revenue `ok`, stats `ok`.

Alertas finales (5): abiertas `OPERA_MISSING_IN_SNAPSHOT` (IMP-RA-2026-107) y `OPERA_RATE_CODE_UNMAPPED` (CORP),
para que César las vea en el panel; resueltas por Carmen `OPERA_RECON_COUNT_MISMATCH`, `OPERA_FEED_LATE`
(departures 16/09, abierta por el job, §4.3-3) y `OPERA_ROOM_TYPE_UNMAPPED` (PM, §4.1 INT-7B-02).

## 6. Verificación SQL (solo lectura, tras el último paso; consultas reproducibles en §10)

| Comprobación | Esperado | Real |
|---|---|---|
| Invariantes de Faranda | 25 · 33 · 109 previos · 1 | **25 facturas · 33 envíos VeriFactu · 109 asientos previos** (13 + 9 invoice, 8 cancelación, 4 rectificativa, 23 payment, 4 refund, 48 nómina) **+ 3 de la tanda = 112 · 1 lote de nómina**; idénticos antes de la demo, después y tras las dos pasadas de integración |
| Reservas de RA | 105 → 110 | `confirmed` **46** (43 − 1 cancelada + 4 nuevas) · `checked_out` **10** (9 + RES-00156) · `cancelled` **54** (53 + RES-00133); último código **RES-00160** |
| Ninguna reserva ajena cambió | diff antes/después = solo lo sincronizado | `diff` de las 105 filas previas: **4 cambiadas** (RES-00122 fechas · RES-00126 tipo e importe · RES-00133 estado · RES-00134 tarifa e importe) **+ 5 nuevas** (RES-00156…160); las otras 101 idénticas byte a byte |
| `IMP-RA-2026-1xx` (runbook §12-12) | 29 enlazadas + RES-00139 sin enlace | **31 filas**: 30 enlazadas (29 adoptadas + RES-00160) con `referencia_ok`, RES-00139 `cancelled` sin enlace; `missing_streak 1` solo en IMP-RA-2026-107 |
| Enlaces (§12-2) | 34 | **34**: `confirmed` 32 (28 adoptados) · `cancelled` 1 · `checked_out` 1; último corte 2026-09-19; `external_reference = confirmation_no` en los 34; **`booker_email` NULL en los 34** |
| Runs (§12-3) | 9 | arrivals `done` 1 (2/0/29/0/1/0) · `partial` 1 (3/3/26/1/0/1) · `failed` 1 (sonda) · departures `partial` 1 (0/0/0/1/0/1) · revenue `done` 2 (14 líneas / 2 ignoradas) · stats `done` 3 |
| Idempotencia (§12-4) | 0 filas | **0** (el mismo fichero y día → 409 `PMS_SHADOW_RUN_DUPLICATE`, verificado por la integración) |
| Asientos de la tanda cuadrados (§12-6) | 0 descuadrados | **0**; nº 110 `posted` 4.120,60 · nº 111 `reversed` 3.788,95 · nº 112 reverso 3.788,95 (6 líneas cada uno) |
| Lotes de ingresos (§12-7) | 1 no revertido por día | 16/09 `posted` · 15/09 `reversed`; **0** días con dos lotes vivos |
| Check-in / check-out sombra (§12-10) | RES-00156 | `checked_out`, con habitación, folio `closed`, `Stay checked_out` |
| Sin datos personales | 0 · 0 · 0 | **0** runs, **0** alertas y **0** de las **68** filas de los 3 lotes con nombre, apellido, e-mail, «valor omitido» ni `NAME_ON_CARD` (regex sobre los 34 nombres ficticios); 0 en las respuestas HTTP de runs y alertas |
| Cupo tipo × noche (T7 §6) | 0 excedidas | **0** |
| Auditoría de la demo (RA, actor `usr_system_pms_shadow` / Carmen) | — | `PMS_SHADOW_RUN_COMPLETED` 8 · `_FAILED` 1 · `PMS_SHADOW_PROFILE_UPDATED` 1 · `PMS_SHADOW_ALERT_RESOLVED` 3 · `PMS_SHADOW_REVENUE_POSTED` 2 · `_REVERSED` 1 · `RESERVATION_IMPORT_COMMITTED` 3 · `RESERVATION_CREATED` 5 · `RESERVATION_SHADOW_UPDATED` 3 · `RESERVATION_CANCELLED` 1 · `GUEST_CHECKED_IN` 1 · `GUEST_CHECKED_OUT` 1 · `FOLIO_CLOSED` 1 |
| Huéspedes | 84 + 5 | **89** (5 fichas nuevas: RIAS-2026-0201…0204 y la reactivación de IMP-RA-2026-119, que crea ficha nueva porque el export Responsys no trae documento ni e-mail y la reutilización nunca es por nombre) |
| Fecha de negocio | informativa | 2026-09-13 (no avanza en modo sombra; `resolveBusinessDate` usa hoy local cuando no se indica) |
| Migraciones | 11 · drift 0 | **11** aplicadas (última `20260917100000_opera_modo_sombra`) · «No difference detected.» |

## 7. Cómo usarlo paso a paso (César)

### 7.1 En OPERA Cloud (una vez por hotel; diseño §7, runbook §2, §4 y §5)

1. **Prerrequisitos** (§7.1): OPERA Controls General › `SCHEDULED REPORTS` activo; Exports › `GENERAL EXPORTS`
   + suscripción `OPP_EXP` (si no aparece Miscellaneous › Exports, pedirlo a Oracle); rol con las tasks de
   Exports y los report groups (Arrivals, Departures, Guests In-House, Financials, End of Day, Configuration);
   una cuenta de servicio **permanente** para programar (los informes dejan de generarse si su usuario se
   desactiva). Para SFTP, sin SR: Toolbox › System Setup › Outbound Domain Allowlist (host de Anfitorio, SFTP,
   22; aprobación con la task «Approve Outbound Domain Allowlisting»; hasta 6 h) y después SFTP Configuration
   (código, host, usuario, clave privada que genera Anfitorio, host key de `ssh-keyscan`, carpeta por hotel).
2. **Listados de configuración** (§7.4, PDF o Delimited, una vez): `cf_roomtypes`, `cf_rooms`,
   `cf_ratecodeheader`, `cf_marketcodes`, `cf_sourcecodes`, `cf_origincodes`, `cf_trxcodes1`,
   `cf_taxtypesbytrxcodes`, `cf_reservationtypes` → con ellos rellenamos el perfil (7.2-1).
3. **Paso 5, imprescindible antes de programar nada**: generar **una vez a mano** cada informe de §7.2 con
   Download As › Delimited Data **y** PDF, y el XML `GEN_XMLBO_REVENUE` de un día, y enviárnoslos (§8).
4. **Informes programados por e-mail** (Reports › Manage Reports › Manage Scheduled Reports › New; Español;
   Repeat cada 1 Days a las 06:00 tras el night audit; Email `opera-<código>@<dominio Anfitorio>` y además SFTP
   si existe; **un File Format por programación**): `departure_all` Delimited Data con Date Option = business
   date **− 1** (salidas de ayer ya «Checked Out»); `res_detail` Delimited Data business date + 0…+ 30 (y una
   segunda cada 7 días a + 540, snapshot de horizonte completo); `gibyroom`; `resreservyesterday` + `rescancel`
   + `nanoshow` (− 1); `findeptcodes` XML (− 1) si no hay XML de Revenue; `trial_balance` y `manager_report` XML
   (− 1) y en PDF; los dos últimos también por End of Day Final Reports › Email (el Trial Balance no se puede
   regenerar).
5. **Exports por SFTP** (Miscellaneous › Exports › General › New from Template): `GEN_XMLBO_REVENUE` (End of Day;
   preguntar a Oracle cuál de `GEN_XMLBO_REVENUE_DY` / `GEN_XMLBO_REV_DAY` es la vigente para días pasados);
   **no tocar nada salvo** Actions › Delivery Configuration → SFTP (código + carpeta); `Generate_Export_NA_Data`
   activo; opcional `RESPONSYS_RESV_AUTO` (Schedules › Daily, Hour 06, `.csv`). Sin SFTP: View Exports › Download
   cada día y subir por el panel (vía A).

### 7.2 En Anfitorio (runbook §3; roles Propietario, Dirección, Administrador)

1. **Perfil** (Configuración › Módulos e integraciones › **Modo sombra OPERA**, o `PUT
   /properties/<id>/pms-shadow/profile`): Hotel Code de Property Controls (`operaHotelCode`), feeds y horas
   (`scheduleJson`; `departures` con `-1`), diccionarios (`mappingJson.roomTypes` **obligatorio** para cada tipo
   que aparezca; `pseudoRoomTypes` PM / HOUSE; `rateCodes`; `marketCodes`; `sourceCodes`; `paymentTypes`),
   transaction codes → cuenta PGC + departamento USALI (`trxMappingJson`; un código sin entrada **bloquea** el
   día de ingresos), buzón y carpeta. La demo deja el de Rías Altas como plantilla (§5.2).
2. **Clave de API** (Desarrolladores › Aplicaciones, `POST /developer/apps`, permiso `developer.manage_webhooks`):
   una app **por hotel** con `scopes: ["pms.shadow.ingest:<propertyId>"]`; el secreto se muestra una sola vez;
   guardarlo en el VPS en un fichero de entorno con permisos 600 (`PMS_SHADOW_INGEST_URL`, `PMS_SHADOW_API_KEY`),
   nunca en argumentos ni en tickets.
3. **Buzón** (IA › Correo entrante, `POST /properties/<id>/email/connections`): `purpose pms_shadow`,
   `fromDomain` **obligatorio** (dominio del Report Scheduler, a confirmar con la primera entrega),
   `subjectContains` con el Hotel Code; buzón dedicado por hotel.
4. **Agente SFTP** (cron cada 15 min entre 06:00 y 12:00): `corepack pnpm --filter @hotelos/api pms-shadow:pull
   -- --property <id> --folder /srv/sftp/opera/<hotel> --move-to /srv/sftp/opera/<hotel>/procesados --apply
   --json` con la clave en el entorno; `find … -mtime +30 -delete` a las 03:00 (GDPR).
5. **Carga inicial** (histórico): XML `GEN_XMLBO_REV_DAY` por día pasado y un Responsys manual por rangos, con
   el CLI en modo directo **con los API parados**, o por el ingest HTTP con `--business-date`.

### 7.3 Cada día (lo que hace solo y lo que mira una persona)

Los cortes llegan (correo o SFTP + cron) → cada fichero es un run (`GET …/runs`, KPIs en el panel): las llegadas
crean / actualizan / transicionan reservas; el XML de ingresos contabiliza el asiento del día; `stats` reconcilia
(13 métricas; `lastReconciledDate` avanza cuando todo cuadra). Una persona revisa el panel: alertas abiertas
(`OPERA_MISSING_IN_SNAPSHOT` → comprobar en OPERA y cancelar a mano si procede; `OPERA_RATE_CODE_UNMAPPED` /
`OPERA_ROOM_TYPE_UNMAPPED` → completar el perfil; `OPERA_TRX_CODE_UNMAPPED` → mapear y contabilizar de nuevo;
`OPERA_FEED_LATE` → mirar el scheduler / SFTP y subir a mano; `OPERA_RECON_*` → comparar esperado / obtenido) y
las resuelve con motivo (auditado). Subida manual: panel › «Subir corte manual» o Reservas › Importar con
`?modo=sync&perfil=opera_cloud&feed=<feed>&fecha=<business date>` (dry-run con la columna «Acción» antes de
aplicar). Corregir un día de ingresos: `POST …/revenue` con `replace: true` (reverso + nuevo en una transacción)
o `POST …/revenue/:id/reverse`.

### 7.4 Retirar la demo cuando César la haya visto

`reservations:import --undo` de los lotes `cmu5bkqxi001wfyt9r2gflp03` y `cmu5blcyj003cfyt94l5btx2s` (cancela
RES-00157…160; RES-00156 se conserva por tener check-in); `POST …/revenue/cmu5bmlcf005afyt9wbnrssd3/reverse`
con motivo; las actualizaciones de RES-00122/126/134 y la cancelación de RES-00133 no se deshacen (OPERA manda:
corregirlas a mano en recepción); los enlaces adoptados se borran por SQL (`DELETE FROM pms_shadow_links WHERE
first_import_id = 'cmu4t43gh0000fyu01qbc20ri'`); la `DeveloperApp` se revoca o se borra; el perfil se pausa.

## 8. Lo que solo se cierra con las entregas reales de César (diseño §7.2 paso 5 y §7.6)

| Entrega | Qué desbloquea | Estado hoy |
|---|---|---|
| Hotel Code de Property Controls de los 7 hoteles ↔ códigos Anfitorio | `operaHotelCode` real (el `hotel_code` del XML se contrasta con el perfil: 409 `PMS_SHADOW_REVENUE_HOTEL_MISMATCH`) | `RIAS` ficticio |
| Hora habitual del night audit por hotel | `expectedTime` y `businessDateOffset` de cada feed; sin ella `OPERA_FEED_LATE` salta a horas equivocadas | programación por defecto 06:30 / 07:00 |
| Listados `cf_*` (§7.4) | `mappingJson` y `trxMappingJson` reales; criterio contable por transaction code validado con la gestoría (tasa turística, paquetes, paid-outs, city ledger) | diccionarios y 8 códigos ficticios |
| Salida real (Delimited Data + PDF) de `res_detail`, `gibyroom`, `resreservyesterday`, `rescancel`, `nanoshow` | Sinónimos de `arrivals` por informe, feeds `inhouse` y `changes` (hoy `undefined` → 400 `RESERVATION_IMPORT_PROFILE_UNSUPPORTED_FEED`), test de contrato por cabecera, cancelaciones / no-shows explícitos en vez de ausencias | Oracle no publica esas columnas en Cloud |
| Una salida real de `departure_all` y del export Responsys | Confirmar «Delimited Data» sin cabecera y su delimitador [S]; fila de cabecera del export [S]; máscara de fechas de los informes [S] | perfil con `headerless` + autodetección |
| XML `GEN_XMLBO_REVENUE` de un día + `findeptcodes` del mismo día + Trial Balance | Signo de los cobros [S] (hoy convenio negativo del XML; `includePayments` debe seguir en `false`); elementos del XML de `findeptcodes`, `manager_report` y `trial_balance` (BI Publisher [S]); regla Σ `total_amount` ≡ Transaction Total Today comprobada con datos reales | parsers con nombres de elemento por defecto y mapa sustituible |
| Dirección de correo del Report Scheduler | `fromDomain` del buzón (DKIM/SPF pendiente, runbook §13) | hueco documentado |
| Cuál de las dos plantillas «Revenue By Date» está vigente | histórico de ingresos | pregunta a Oracle |
| Para OHIP (fase 2): Enterprise ID, Chain Code, Region, Environment Type, Hotel IDs, dueño del app key | feed `ohip_delta` (hoy `failed` «no implementado») | fase 2 |
| Criterios de salida del modo sombra (30 días en verde, 0 alertas abiertas, mapeos completos) | cutover | decisión §8.1-9 del diseño |

## 9. Pendientes tras la integración

### 9.1 Solo el orquestador: reiniciar el API :3000 y dejar la clave de demo con el scope ligado

Tras el reinicio :3000 servirá SEC-04, SC-07 y las tres correcciones de §4.1. Entonces: `UPDATE developer_apps
SET scopes = ARRAY['pms.shadow.ingest:cmrhw9jy40003fyvbuu2ec2w7'] WHERE id = 'dapp_t7b_opera_rias_demo';` y
comprobar que el ingest sigue respondiendo 202/409 con esa clave y **401** con `propertyId` de Los Tilos. Después:
`test:integration` de nuevo (sin cambios esperados) y el recorrido en navegador que L4 dejó pendiente:
`/configuracion/modulos/modo-sombra` (KPIs 34 enlazadas · 2 alertas abiertas · último día conciliado 16/09; tabla
de feeds con `departures` en «Retrasado»; 9 cortes; resolver una alerta con motivo), el asistente
`/recepcion/reservas/importar?modo=sync&perfil=opera_cloud&feed=arrivals&fecha=2026-09-19` con
`RESPONSYS_RESV_DAY_RIAS_20260918.csv` (con todas las referencias ya enlazadas, la columna «Acción» debe ser casi
toda «Sin cambios», la fila PM «Omitida» y **sin** los 9 avisos «también parece»), y el propósito `pms_shadow` en
IA › Correo entrante.

### 9.2 Commit

Todo el working tree de la tanda (§2) sigue sin commit; `pilots/` es git-ignored. `pnpm-lock.yaml` no lo ha
tocado ningún lote. Documentos de diseño ajenos sin seguimiento (`DOCUMENTOS-DIGITALIZACION.md`,
`FINANZAS-IMPORTACION-SAGE200.md`, `REPUTACION-REVIEWS.md`): el orquestador decide.

### 9.3 Trabajo posterior identificado (no bloquea)

CLI `reservations:import` sin flags `--mode/--feed/--business-date` (L1; el modo sync va por el ingest o por el
asistente); `includePayments` como flag del cuerpo y no del perfil (L2); `PmsShadowRevenueImport` sin unicidad
por día (la impone el servicio bajo lock, diseño §10-13); conector IMAP con propósito `pms_shadow` no operativo
(`imapflow` no instalado); Gmail / Graph sin credenciales reales; `GET …/overview` sin `degraded[]`; los feeds de
reservas subidos desde el panel viajan al asistente T7 (lote `ReservationImport`, no run); `res_detail` /
`gibyroom` / `changes` a la espera de muestra.

## 10. Consultas y comandos reproducibles

Desde `hotelos/` (`psql "$(grep -E '^DATABASE_URL=' .env | cut -d= -f2- | tr -d '"')"`); las consultas 1-14 del
runbook §12 se ejecutaron tal cual con `<propertyId>` = `cmrhw9jy40003fyvbuu2ec2w7` y `<orgId>` =
`cmrhw9jy30002fyvb6tsdiugt` (salida completa en `OPERA-DEMO-2026-09-17.md`). Variantes de §6:

```sql
-- Invariantes (25 · 33 · 109 previos + 3 · 1)
SELECT (SELECT count(*) FROM invoices i JOIN properties p ON p.id = i.property_id WHERE p.organization_id = 'cmrhw9jy30002fyvb6tsdiugt') AS facturas,
       (SELECT count(*) FROM verifactu_submissions s JOIN invoices i ON i.id = s.invoice_id JOIN properties p ON p.id = i.property_id WHERE p.organization_id = 'cmrhw9jy30002fyvb6tsdiugt') AS verifactu,
       (SELECT count(*) FROM journal_entries WHERE organization_id = 'cmrhw9jy30002fyvb6tsdiugt' AND source_type NOT IN ('pms_shadow_revenue') AND source_id NOT LIKE 'reversal:cmu5bno0n%') AS asientos_previos,
       (SELECT count(*) FROM journal_entries WHERE organization_id = 'cmrhw9jy30002fyvb6tsdiugt') AS asientos_total,
       (SELECT count(*) FROM payroll_cost_imports WHERE organization_id = 'cmrhw9jy30002fyvb6tsdiugt') AS lotes_nomina;

-- Reservas IMP-RA con enlace y último estado (31 filas: 30 enlazadas + RES-00139 cancelada sin enlace)
SELECT r.external_reference, r.code, r.status, r.arrival_date::date, r.departure_date::date, r.total_amount, l.id IS NOT NULL AS enlazada, l.last_status, l.missing_streak
FROM reservations r LEFT JOIN pms_shadow_links l ON l.reservation_id = r.id
WHERE r.property_id = 'cmrhw9jy40003fyvbuu2ec2w7' AND r.external_reference LIKE 'IMP-RA-2026-1%' AND r.deleted_at IS NULL ORDER BY 1, 2;

-- Asiento del 16/09 por cuenta y centro (705.1 3200 ROOMS · 705.2 480 FNB · 705.3 60 OTHER_OPERATED · 477.10 368 · 477.21 12,60 · 4300 D 4120,60)
SELECT l.account_code, coalesce(cc.code, '—') AS centro, l.tax_rate_code, l.debit, l.credit, l.description
FROM journal_entries e JOIN journal_lines l ON l.journal_entry_id = e.id LEFT JOIN cost_centers cc ON cc.id = l.cost_center_id
WHERE e.organization_id = 'cmrhw9jy30002fyvb6tsdiugt' AND e.source_type = 'pms_shadow_revenue' AND e.source_id = 'cmrhw9jy40003fyvbuu2ec2w7:2026-09-16' AND e.status = 'posted' ORDER BY 1;

-- Reverso del 15/09: nº 111 reversed ↔ nº 112 (reversal_of_id), ambos 3.788,95 = 3.788,95
SELECT e.entry_number, e.source_type, e.status, e.reversal_of_id, sum(l.debit), sum(l.credit)
FROM journal_entries e JOIN journal_lines l ON l.journal_entry_id = e.id
WHERE e.id IN ('cmu5bno0n005lfyt956zckevn', 'cmu5borhr0000fyshhri3wbwd') GROUP BY 1, 2, 3, 4 ORDER BY 1;

-- Sin datos personales en runs, alertas y filas de los lotes sync (0 · 0 · 0 de 68)
SELECT (SELECT count(*) FROM pms_shadow_runs WHERE property_id = 'cmrhw9jy40003fyvbuu2ec2w7' AND (result_json::text || alerts_json::text || coalesce(error_message, '')) ~* 'vilari|kowalski|souto|ledo|ferro lamas|mato rey|costas|example\.com|valor omitido|uxia') AS runs,
       (SELECT count(*) FROM pms_shadow_alerts WHERE property_id = 'cmrhw9jy40003fyvbuu2ec2w7' AND (message || expected_json::text || actual_json::text) ~* 'vilari|kowalski|souto|ledo|ferro lamas|mato rey|costas|example\.com|valor omitido|uxia') AS alertas,
       (SELECT count(*) FROM reservation_import_rows ir JOIN pms_shadow_runs r ON r.reservation_import_id = ir.import_id WHERE r.property_id = 'cmrhw9jy40003fyvbuu2ec2w7' AND (ir.warnings_json::text || coalesce(ir.error_message, '')) ~* 'vilari|kowalski|souto|ledo|ferro lamas|mato rey|costas|example\.com|valor omitido|uxia') AS filas;
```

```bash
# Secuencia de la demo (desde hotelos/apps/api; O = <raíz git>/pilots/faranda-celuisma/opera; P = cmrhw9jy40003fyvbuu2ec2w7; clave en PMS_SHADOW_INGEST_URL / PMS_SHADOW_API_KEY)
pull() { node --env-file-if-exists=../../.env --import tsx src/scripts/pms-shadow-pull.ts --property $P "$@"; }
pull --folder $O --dry-run                                                                     # clasificación de los 9 ficheros, nada escrito
pull --file $O/RESPONSYS_RESV_DAY_RIAS_20260917.csv --feed arrivals --business-date 2026-09-17 --apply   # run cmu5bkqwp… done 2/0/29/0/1/0
pull --file $O/RESPONSYS_RESV_DAY_RIAS_20260918.csv --feed arrivals --business-date 2026-09-18 --apply   # run cmu5blcxw… partial 3/3/26/1/0/1 + 3 alertas
pull --file $O/departure_all_RIAS_20260919.txt --feed departures --business-date 2026-09-19 --apply      # run cmu5bml17… partial 0/0/0/1/0/1 (check-out sombra)
pull --file $O/GEN_XMLBO_REVENUE_RIAS_20260916.xml --feed revenue --apply                                # run cmu5bmlc8… done → asiento nº 110
pull --file $O/findeptcodes_RIAS_20260915.xml --feed revenue --apply                                     # run cmu5bno07… done → asiento nº 111 (revertido después: nº 112)
pull --file $O/manager_report_RIAS_20260916.xml --feed stats --business-date 2026-09-16 --apply          # run cmu5bnoaq… done (12 métricas)
pull --file $O/trial_balance_RIAS_20260916.xml --feed stats --business-date 2026-09-16 --apply           # run cmu5bnol4… done → OPERA_RECON_COUNT_MISMATCH
pull --file $O/manager_report_RIAS_20260916_v2.xml --feed stats --business-date 2026-09-16 --apply       # modo directo (sin --ingest-url): run cmu5bvgvp… done, reconciliación ok
curl -s "http://localhost:3000/properties/$P/pms-shadow/reconciliation?businessDate=2026-09-16"          # 10 ok · 3 missing (fail-open dev, sin token)
```

## 11. Decisiones abiertas para César (diseño §8.1 con la evidencia de la demo)

| # | Decisión | Por defecto hoy | Evidencia en Rías Altas | Si César prefiere otra cosa |
|---|---|---|---|---|
| 1 | **Adoptar reservas que ya existen en Anfitorio** como gobernadas por OPERA | No hay ruta: misma referencia sin enlace → `OPERA_CONFLICT_LOCAL_RESERVATION` (fila omitida + alerta) | Dry-run previo: 29 conflictos; la demo adoptó por SQL | Opción `adoptLocal` del importador (o CLI `pms-shadow:adopt`) que cree el enlace y aplique el diff, auditado; útil el día 1 en hoteles con reservas ya cargadas (Tanda 7, canales) |
| 2 | **Reserva ausente del snapshot**: alerta y cancelación manual (2 cortes → error) | Nunca se cancela sola | RES-00127: `missing_streak 1`, alerta abierta, reserva intacta | Cancelación automática tras N cortes con el feed `changes` como confirmación |
| 3 | **Signo de los cobros** en los ficheros de ingresos | Convenio del XML (negativos); `includePayments: false` | XML: `payments 3.400,00`; `findeptcodes` Delimited: `payments −2.900,00` | Se fija con la muestra real; hasta entonces el asiento solo lleva ingresos e impuestos (D 4300 por el total) |
| 4 | **Delimited Data sin cabecera** y delimitador; fila de cabecera del export Responsys | `departures` con `headerless`; `arrivals` con cabecera; separador autodetectado | Ambos formatos sintéticos procesados | Se ajusta el perfil con la primera muestra (una línea de `opera-cloud.ts`) |
| 5 | **`sourceCode` con el código OPERA crudo** o con el valor del diccionario | Guarda el valor del diccionario (canal canónico o sinónimo) | Perfil de demo con `DIR → directo`… para no «actualizar» 29 reservas en el primer corte | `normalizeRow` con diccionario de canal aparte para conservar `BDC`, `WEB`… (mejora L1/L4) |
| 6 | **Lote `partial` por omisiones de diseño** (waitlist, pseudo room) | Regla T7: `skipped > 0` → `partial` | 3 lotes `partial` con 0 errores (el run distingue: `done` con `skipped 1`) | `imported` cuando las omisiones son solo por diseño (waitlist, pseudo room, conflicto local) |
| 7 | **Business date por defecto** en modo sombra | Máx(fecha de negocio de Anfitorio, hoy local) + offset del feed (SC-02) | RA sigue en 2026-09-13; los cortes llevan fecha explícita | Ejecutar la auditoría nocturna de Anfitorio aunque OPERA sea el registro, o bloquear cortes sin `businessDate` |
| 8 | **Prospect / Requested → `confirmed`** con aviso; **Waitlist omitida** | Como la decisión 1 de la Tanda 7 | RIAS-2026-0203 omitida en el corte 1 y creada en el 2 al pasar a Reserved | Transición `draft → confirmed` en el PMS |
| 9 | **Nivel del asiento de ingresos**: agregado por transaction code y día | Sin facturas ni VeriFactu en Anfitorio (las emite OPERA + partner fiscal) | Asiento nº 110 de 6 líneas por 8 códigos | Por folio (`GEN_XMLBO_BILLS`) exigiría replicar clientes y series |
| 10 | **Dueño del app key OHIP** y vía del día 1 (B1 correo frente a B2 SFTP) | B1 para reservas y conciliación, B2 para el XML de ingresos; OHIP en fase 2 | El ingest acepta ambos orígenes (`source email` / `sftp` / `api_key` / `cli`) | Como partner, Anfitorio paga por llamada / evento |
| 11 | **Histórico**: cuántos meses regenerar con `GEN_XMLBO_REV_DAY` y desde qué fecha cargar reservas | 12 meses de ingresos; reservas desde 2026-01-01 | `findeptcodes` de un día pasado contabilizado y revertido | Más histórico = más ejecuciones manuales en OPERA (una por día) |
| 12 | **Criterios de salida** del modo sombra | 30 días en verde, 0 alertas abiertas, mapeos completos | `lastReconciledDate` 2026-09-16 tras 1 día | Se fijan en el runbook antes del piloto |

## 12. Documentos relacionados

- `docs/design/OPERA-CLOUD-MODO-SOMBRA.md` — diseño verificado contra Oracle (§1-§9) y desvíos de implementación (§10, filas 1-30; las 27-30 son de esta integración).
- `docs/runbooks/opera-modo-sombra.md` — runbook operativo (prerrequisitos en OPERA, alta en Anfitorio, informes y exports, CLI y cron, ingest, semántica del sync, ingresos con ejemplo cuadrado, reconciliación y alertas, job, permisos, SQL §12 ejecutadas en esta demo, FAQ, entregas de César y huecos §14).
- `docs/runbooks/reservas-importacion.md` §18 — modo sincronizar en el asistente de la Tanda 7.
- `docs/api-contracts.md` — bloque «Modo sombra OPERA Cloud (Tanda 7b)» y ampliación del importador (`mode`, `feed`, `businessDate`, `horizonDays`, `headerOverride`, `result.sync`, códigos 400 nuevos).
- `docs/audits/TANDA-7-RESERVAS-IMPORT-2026-09-16.md` — la Tanda 7 sobre la que se construye (lote `cmu4t43gh0000fyu01qbc20ri` = las 30 reservas `IMP-RA` de esta demo).
- `<raíz git>/pilots/faranda-celuisma/opera/README.md` y `OPERA-DEMO-2026-09-17.md` — ficheros sintéticos y salida íntegra de la demo (fuera del repo, git-ignored).
- `docs/design/COCOA-22-MIGRACION.md` §6 y `docs/design/cocoa-22-inventory.json` — inventario Cocoa 22 regenerado (221 pantallas · 194 puntos · `style={}` 682).
