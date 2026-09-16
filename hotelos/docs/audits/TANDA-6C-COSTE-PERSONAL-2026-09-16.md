# Tanda 6c · Coste de personal importado (nómina agregada) · Cierre y carga de Faranda — 16 de septiembre de 2026

**Para:** César. **Encargo:** llevar al ERP el informe de RRHH «coste de nómina 1-ene → 31-ago 2026»
de CELUISMA S.A. (Faranda, `organizationId cmrhw9jy30002fyvb6tsdiugt`, sociedad `le_5a1bd74b`,
8 centros) como coste de personal devengado en el diario PGC (640 / 642) y como línea `labor` por
departamento USALI, **sin guardar ningún dato por persona**. **Método:** documento de diseño
(`docs/design/FINANZAS-COSTE-PERSONAL.md`, síntesis de dos propuestas verificada por un juez) → lotes
L0 (schema + migración + tipos) → L1 ∥ L2 ∥ L4 (servicio de importación y contabilización; USALI por
centro de coste y headcount; front) → L3 (rutas, permisos, esquemas, CLI) → L5 (runbook §18) → L6 (puertas, dry-run, apply único,
comprobaciones SQL y HTTP) → corrector 6c en dos rondas (25 hallazgos, §10) → **integración final
(este documento, 16/09 21:30 CEST): puertas definitivas, dry-run repetido, re-verificación SQL,
decisiones abiertas**. Todo sobre la demo local (Postgres local; API :3000 y Vite :5173 **sin
reiniciar**: las comprobaciones HTTP de §4.5 se hicieron con la app montada in-process con `app.inject`
y el token de la Owner de Faranda; el Modelo 303 de §4.7 se leyó del :3000 en marcha, solo lectura).

**Resultado en una línea:** el lote `cmu4d93ri0000fyajr2krjs55` está contabilizado: **48 asientos
nuevos (2026/62 → 2026/109)**, 640 D 1.891.222,19 · 642 D 551.336,97 · 465 H 1.891.222,19 · 476 H
551.336,97 (Σ 2.442.559,16 €); los 61 asientos previos, las 25 facturas, los 33 envíos VeriFactu y el
Modelo 303 2026-Q3 están **intactos**; un segundo apply devuelve `PAYROLL_IMPORT_DUPLICATE` sin
escribir nada; el integrador final repitió el dry-run el 16/09 a las 21:20 CEST (duplicado sobre ese
lote, 48 solapes, `canPost: no`, recuentos de BD idénticos antes y después, §4.7) y **no** ha vuelto a
aplicar ni ha usado `--replace`. Ningún fichero del repositorio contiene nombres ni datos por persona: el agregado real
vive en `<raíz git>/pilots/faranda-celuisma/nomina-2026-ene-ago.json` (carpeta git-ignored).

## 1. Alcance y qué cambia

| Tema | Antes | Ahora (working tree 16/09) |
|---|---|---|
| Coste de personal en el diario | Ninguno: 61 asientos de facturación y cobros; el PyG de la sociedad carecía de su partida mayor | 48 asientos `payroll_cost_import` (uno por centro × mes, fechados el último día del mes) con D 640 / D 642 por departamento USALI y H 465 / H 476 por el total; 2.442.559,16 € en ocho meses |
| USALI | `640/641/642 → admin_general.labor` (todo el personal en Administración y general) | La línea `labor` se enruta por el **centro de coste `usali`** del apunte (`source: "cost_center"`): Habitaciones 910.384,67 · A&B 546.288,21 · POM 195.314,10 · Ventas y marketing 17.043,96 · A&G 773.528,22 (sociedad, ene-ago 2026); sumas y saldos, PyG PGC y `reconciliation` no cambian |
| Headcount USALI | Recibos de nómina (no existen para Faranda) → nulo | `employeesReported` del informe por centro × mes (o Σ empleados de las celdas donde no hay referencia) → `statistics.headcount` con `headcountSource: "payroll_cost_import"` y `ratios.laborPerEmployee` |
| Datos personales | — | El formato de importación es agregado por construcción (centro × mes × grupo × departamento); el ERP guarda solo agregados; los tests usan cifras sintéticas |
| Trazabilidad | — | Lote `PayrollCostImport` (hash de contenido, mapeo aplicado, totales, `journalEntryIds`, `reversalJournalEntryIds`), 363 `PayrollCostLine`, 40 `PayrollCostReference`, evento de auditoría `PAYROLL_COST_IMPORT_POSTED` encadenado (sha256) |

## 2. Lotes y ficheros (working tree, sin commit)

| Lote | Ficheros | Tamaño |
|---|---|---|
| L0 · Schema, migración y tipos | `packages/database/prisma/schema.prisma` (+123/−2: enum `PayrollCostImportStatus`, modelos `PayrollCostImport` / `PayrollCostLine` / `PayrollCostReference`, `@@index([costCenterId])` en `JournalLine`); `packages/database/prisma/migrations/20260916120000_coste_personal_importado/migration.sql` (155 líneas); `packages/shared/src/payroll-cost-types.ts` (621, nuevo), `accounting-types.ts` (+2), `financial-statements-types.ts` (+21/−1), `index.ts` (+4) | 9/9 migraciones aplicadas, drift 0 |
| L1 · Parser, regla, servicio, informe | `apps/api/src/modules/payroll/cost-import.parser.ts` (1.000), `cost-import.posting.ts` (192), `cost-import.service.ts` (1.015), `cost-report.service.ts` (488); `apps/api/src/modules/treasury/permissions.ts` (+2, `PAYROLL_READ_KEYS`); tests `__tests__/cost-import-parser.test.mts` (413), `cost-import-posting.test.mts` (136), `cost-report.test.mts` (206); `tests/integration/payroll-cost-import.test.mts` (551) | — |
| L2 · USALI por centro de coste y headcount | `apps/api/src/modules/financial-statements/source.ts` (+159/−20), `usali.service.ts` (+116/−29), `__tests__/memory-source.mts` (+22/−6), `__tests__/usali-cost-centre.test.mts` (415, nuevo); `tests/integration/usali-cost-centre.test.mts` (392) | — |
| L3 · Rutas, permisos, esquemas, tenencia, CLI | `apps/api/src/modules/payroll/cost-import.routes.ts` (118), `route-permissions.partial.ts` (32); `apps/api/src/security/route-permissions.ts` (+6); `apps/api/src/server.ts` (+8); `apps/api/src/lib/tenancy.ts` (+6); `apps/api/src/schemas/payroll-cost.schemas.ts` (193) + `__tests__/cost-import-schemas.test.mts` (166); `apps/api/src/scripts/import-payroll-cost.ts` (421) + `__tests__/import-payroll-cost.test.mts` (200); `apps/api/package.json` (+1, `payroll:import-cost`); `docs/api-contracts.md` (+1); `tests/integration/payroll-cost-routes.test.mts` (226) | 7 rutas `/payroll/cost-imports*` y `/payroll/cost-report` |
| L4 · Front | `apps/admin-web/src/screens/payroll/PayrollScreen.tsx` (+373/−11, pestaña «Coste de personal»), `PayrollCostImportDrawer.tsx` (398, nuevo), `payroll-cost-helpers.ts` (518, nuevo), `__tests__/payroll-cost-helpers.test.mts` (438), `__tests__/payroll-cost-screen-contract.test.mts` (167); `services/payrollApi.ts` (+84/−5), `finance-contracts.ts` (+27/−2), `__tests__/finance-api-surface.test.mts` (+46/−2); `screens/finance/UsaliScreen.tsx` (+10/−2, badge «Centro de coste»); `screens/accounting/accounting-ui.ts` (+1) | — |
| L5 · Docs | `docs/runbooks/finanzas-contabilidad.md` (+585/−4: §1.1, §1.8, §3, §4 paso 0, §8, §13, §14 y nueva §18.1-18.12); `docs/design/FINANZAS-COSTE-PERSONAL.md` (318, nuevo) | — |
| L6 · Carga y auditoría | `docs/audits/TANDA-6C-COSTE-PERSONAL-2026-09-16.md` (este documento) | BD local escrita **una** vez |
| Corrector 6c (dos rondas) e integración final | Correcciones dentro de los ficheros de L1-L5 (§10); `apps/admin-web/src/screens/accounting/actor-label.ts` (+1, etiqueta del actor de sistema), `apps/admin-web/.discoverability-whitelist.json` (+1, `PayrollCostImportDrawer`); re-pin a CELUISMA de `tests/integration/{fiscal-models,structure-e2e,structure-l2,structure-l5}.test.mts`; este informe (§3, §4.7, §6, §7, §10) y runbook §18.10 / §18.12; salida del dry-run repetido en `<raíz git>/pilots/faranda-celuisma/NOMINA-DRY-RUN-2026-09-16.md` (git-ignored) | BD local: **0** escrituras adicionales |

`pnpm-lock.yaml` figura modificado (+52) desde antes de la tanda; ningún lote lo ha tocado. Ningún
fichero de la Tanda C de Cocoa 22 (lista `tandaC-files.txt`) ha sido editado.

## 3. Puertas (2026-09-16, working tree completo, sin commit)

Resultado definitivo tras la ronda 2 del corrector (desde `hotelos/`; logs `r2-gate*.log` en el
scratchpad del orquestador). Antes del apply (L6) las mismas puertas daban: typecheck 15/0/1, contratos
444/445, unitarios API 1.593, front 1.013/1.014 (`actor-label`), integración 356/367 (6 pins de la
sociedad antigua) y discoverability con 1 huérfana; las tres ámbar de entonces (inventario Cocoa,
`actor-label`, whitelist) eran de registro / etiqueta del front y no afectaban a la carga en BD; las dos
del front y los 6 pins quedaron corregidos en la ronda 2.

| # | Puerta | Comando | Resultado final |
|---|---|---|---|
| 1 | Typecheck de todo el workspace | `corepack pnpm run typecheck:all` | **15 PASS · 0 FAIL · 1 SKIP** explícito (`apps/guest-web`, deuda conocida) · 22,7 s |
| 2 | Unitarios API | `corepack pnpm --filter @hotelos/api test` | **1.598 tests · 1.597 pass · 0 fail · 1 skipped** (preexistente) · 495 suites · 5,7 s |
| 3 | Unitarios front | `cd apps/api && TSX_TSCONFIG_PATH=../admin-web/tsconfig.json node --import tsx --test $(find ../admin-web/src -path '*/__tests__/*.test.mts')` (`apps/admin-web/package.json` no tiene script `test`) | **85 ficheros · 1.017 tests · 1.017 pass · 0 fail** · 308 suites (incluye `payroll-cost-helpers` y `payroll-cost-screen-contract`) |
| 4 | Contratos raíz | `node --test tests/*.test.mjs` | **445 · 444 pass · 1 fail** — la única roja es `cocoa-22-contract` regla 15 «inventario al día» (fichero de la Tanda C, ver 6); el test 13 «la deuda global no crece» pasa (313 = 313) |
| 5 | Discoverability | `node scripts/check-discoverability.mjs` | **OK**: 223/223 pantallas alcanzables · 188/188 URLs · 0 enlaces rotos · 0 claves retiradas · placeholders 16/20 |
| 6 | Inventario Cocoa 22 + contrato | `node scripts/cocoa-22-inventory.mjs --summary` · `node --test tests/cocoa-22-contract.test.mjs` | 223 pantallas · 90.339 líneas · **313 puntos de deuda (sin crecer)** · `inlineStyles` 801/801; el JSON comprometido (`docs/design/cocoa-22-inventory.json`, Tanda C) dice 222 / 89.457 → regla 15 roja por construcción (17/18). Lo regenera el propietario del fichero con `node scripts/cocoa-22-inventory.mjs` |
| 7 | Migraciones Prisma | `corepack pnpm --filter @hotelos/database db:migrate:status` · `db:drift:check` | **9 migraciones · «Database schema is up to date!» · «No difference detected.»** |
| 8 | Integración API | `cd apps/api && node --env-file-if-exists=../../.env --import tsx --test "../../tests/integration/*.test.mts"` | **369 tests · 363 pass · 0 fail · 6 skipped** · 72 suites (5 skips de entorno de siempre + 1 auto-skip transitorio de `structure-l5` «BD no en reposo» por suites hermanas; el fichero solo: 14/14, 0 skips). Las tres suites de la tanda (`payroll-cost-import`, `payroll-cost-routes`, `usali-cost-centre`) en verde |
| 9 | Lint | `corepack pnpm --filter <pkg> lint` (api, admin-web, shared, database) | **exit 2 en los 4** por infraestructura preexistente: «ESLint couldn't find an eslint.config.(js\|mjs\|cjs) file» (no existe `eslint.config.*` ni `.eslintrc` en el repo; solo `packages/config/eslint.config.mjs`, no referenciado). No lintea código; no atribuible a la tanda |

`allGreen: false` únicamente por 4/6 (inventario Cocoa de la Tanda C) y 9 (ESLint sin configuración),
ambos ajenos a la Tanda 6c.

## 4. Carga real de Faranda: dry-run → apply → comprobaciones

### 4.1 Estado previo (solo lectura, guardado antes de tocar nada)

`SELECT id, status, entry_number, reversed_by_id FROM journal_entries WHERE organization_id = 'cmrhw9jy30002fyvb6tsdiugt' ORDER BY entry_number`
→ **61 filas: 52 `posted` / 9 `reversed`, `max(entry_number)` 61**, 150 líneas, Σ debe = Σ haber =
2.595,00; por origen: `invoice` 13 posted + 9 reversed, `invoice_cancellation` 8, `invoice_rectification`
4, `payment` 23, `payment_refund` 4. Invariantes: **25 facturas** (`invoices` por `property_id` de la
organización), **33 envíos VeriFactu**, **0 `cost_centers`** (en toda la BD), **0 `payroll_periods`**,
0 lotes / 0 líneas / 0 referencias de coste importado. Cuentas 47x con movimiento: `4759` (1 línea ·
H 3,18), `477.10` (14 · D 23,65 / H 61,48), `477.21` (6 · D 1,74 / H 34,30). Ventas 70x del libro
(posted) por mes: 2026-07 10,33 · 2026-09 251,70. Ejercicios fiscales de la organización: ninguno
(no hay periodos cerrados). Modelo 303 2026-Q3 (API :3000, ruta antigua, solo lectura): base
devengada 578,66 · cuota 74,94 · resultado 74,94 · 37 filas emitidas · declarante `CELUISMA S.A. ·
A33615980`.

### 4.2 Dry-run

```
cd apps/api && node --env-file-if-exists=../../.env --import tsx src/scripts/import-payroll-cost.ts \
  --file <raíz git>/pilots/faranda-celuisma/nomina-2026-ene-ago.json --organization cmrhw9jy30002fyvb6tsdiugt
```

Salida (exit 0, «Nada escrito»): fichero `json · utf-8 · 102.995 bytes · origen informe_rrhh`, hash
`e4ed6a76d1c7d50c…`, periodo 2026-01 → 2026-08, **363 filas normalizadas (363 del fichero) · 48 celdas
centro × mes · 40 referencias**; OC agrega las etiquetas `OFICINA ASTURIAS + OFICINA MADRID + REG.
CORUÑA`; **etiquetas sin mapear: ninguna**; **1 aviso**: «línea 167: coste_total 1047.75 ≠ bruto + SS
1579.67; se contabiliza bruto + SS»; `canPost: sí`.

| Grupo | Líneas | Bruto | SS empresa | 640 + 642 | Coste total del informe | Empleados (Σ celdas) |
|---|---:|---:|---:|---:|---:|---:|
| Estructura | 56 | 306.542,56 | 78.150,48 | 384.693,04 | 384.693,04 | 102 |
| Extras | 32 | 24.070,06 | 12.070,31 | 36.140,37 | 35.608,45 | 76 |
| Familia | 50 | 356.871,42 | 71.520,97 | 428.392,39 | 428.392,39 | 114 |
| Mantenimiento y obra | 41 | 110.897,80 | 32.033,22 | 142.931,02 | 142.931,02 | 75 |
| Operaciones | 184 | 1.092.840,35 | 357.561,99 | 1.450.402,34 | 1.450.402,34 | 757 |
| **Total** | **363** | **1.891.222,19** | **551.336,97** | **2.442.559,16** | **2.442.027,24** | 1.124 (media 128,75 con la referencia del informe) |

Coste por centro (ocho meses, 640 + 642): RA 456.161,66 · OC 838.515,91 · MC 372.743,74 · LT
325.143,84 · PG 235.745,39 · AS 214.248,62. FN y LL no aparecen en el informe: sin líneas ni asientos.

Matriz centro × mes (640 + 642 contabilizados = celda del dry-run; leída del diario en §4.7, B8):

| Centro | 01/26 | 02/26 | 03/26 | 04/26 | 05/26 | 06/26 | 07/26 | 08/26 | Total ene-ago | Asientos |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| RA | 45.464,65 | 48.564,91 | 48.600,20 | 53.324,69 | 62.410,85 | 68.382,80 | 61.381,54 | 68.032,02 | **456.161,66** | 2026/62 … 2026/104 (paso 6) |
| LT | 34.270,69 | 34.607,17 | 34.307,44 | 37.045,11 | 47.561,69 | 47.462,31 | 45.513,42 | 44.376,01 | **325.143,84** | 2026/63 … 2026/105 (paso 6) |
| PG | 22.805,08 | 20.019,74 | 30.287,51 | 33.973,28 | 35.749,80 | 32.591,42 | 29.229,44 | 31.089,12 | **235.745,39** | 2026/65 … 2026/107 (paso 6) |
| MC | 52.066,01 | 45.306,98 | 43.634,75 | 42.939,69 | 43.800,04 | 45.726,22 | 42.798,42 | 56.471,63 | **372.743,74** | 2026/66 … 2026/108 (paso 6) |
| AS | 23.979,74 | 23.288,70 | 23.982,34 | 24.966,94 | 26.150,47 | 31.767,65 | 29.483,94 | 30.628,84 | **214.248,62** | 2026/67 … 2026/109 (paso 6) |
| OC | 108.891,08 | 107.379,70 | 106.735,97 | 103.340,23 | 100.187,84 | 101.690,35 | 109.579,53 | 100.711,21 | **838.515,91** | 2026/64 … 2026/106 (paso 6) |
| **Total mes** | **287.477,25** | **279.167,20** | **287.548,21** | **295.589,94** | **315.860,69** | **327.620,75** | **317.986,29** | **331.308,83** | **2.442.559,16** | 6 por mes |

Por etiqueta original dentro de OC: OFICINA ASTURIAS 536.708,24 (56 líneas) · OFICINA MADRID
229.703,30 (24) · REG. CORUÑA 72.104,37 (10).

### 4.3 Apply (una sola vez, integrador de L6: 2026-09-16 19:20:04 → 19:20:05 CEST — 17:20 UTC en `posted_at` —, exit 0)

```
… --apply --confirm cmrhw9jy30002fyvb6tsdiugt
```

`[payroll:import-cost] lote cmu4d93ri0000fyajr2krjs55 contabilizado · nomina-2026-ene-ago.json ·
2026-01 → 2026-08 · 363 filas · 48 celdas centro × mes · Asientos: 48 (nº 62 → 109, ejercicio 2026) ·
640 = 465: 1.891.222,19 · 642 = 476: 551.336,97 · Total 2.442.559,16 · coste total del informe
2.442.027,24 (diferencia 531,92) · Empleados medios 128,75 · sociedad le_5a1bd74b · createdBy
cli:import-payroll-cost · Lotes sustituidos: ninguno`. Orden de numeración por mes: RA, LT, OC, PG, MC,
AS (2026/62 = RA · 2026-01 · 45.464,65 … 2026/109 = AS · 2026-08 · 30.628,84). Evento de auditoría
`aud_43788d08` · `PAYROLL_COST_IMPORT_POSTED` · actor `usr_system_payroll_cost_import` · entidad
`payroll_cost_import/cmu4d93ri0000fyajr2krjs55` · `correlation_id corr_payroll_cost_import` ·
sha256 encadenado.

### 4.4 Comprobaciones SQL (solo lectura; script en el scratchpad del integrador, consultas reproducibles en §9)

| Comprobación | Esperado | Real |
|---|---|---|
| `payroll_cost_imports` de la organización | 1 fila `posted` | **1** · `posted` · `informe_rrhh` · `nomina-2026-ene-ago.json` · 2026-01 → 2026-08 · `row_count` **363** · `total_gross` **1891222.19** · `total_employer_ss` **551336.97** · `total_cost` **2442559.16** · `reported_total_cost` **2442027.24** · `headcount_average` 128.75 · `array_length(journal_entry_ids,1)` **48** · reversos NULL · `legal_entity_id le_5a1bd74b` · `created_by cli:import-payroll-cost` |
| `payroll_cost_lines` | 363, todas con `cost_center_id` y `organization_id` | **363** · 0 sin `cost_center_id` · 0 con `organization_id` distinto · 6 centros · 8 meses · 48 celdas · Σ bruto 1.891.222,19 · Σ SS 551.336,97 · Σ total 2.442.559,16 · Σ informe 2.442.027,24 |
| `payroll_cost_references` | 40 | **40** · 5 centros (OC no tiene referencia en la hoja resumen) · 40 con empleados y ventas · Σ ventas sin IVA 4.335.144,05 · Σ empleados del informe 804 |
| `cost_centers` `type = 'usali'` | 21 (AS 4 · LT 3 · MC 4 · OC 4 · PG 3 · RA 3) | **21** activos, total de la tabla 21: AS `ADMIN_GENERAL,FNB,POM,ROOMS` · LT `ADMIN_GENERAL,FNB,ROOMS` · MC `ADMIN_GENERAL,FNB,POM,ROOMS` · OC `ADMIN_GENERAL,POM,ROOMS,SALES_MARKETING` · PG `FNB,POM,ROOMS` · RA `FNB,POM,ROOMS` |
| Asientos previos | 61 intactos | `diff` del volcado previo con `SELECT … WHERE entry_number <= 61` **sin diferencias** (mismos 61 ids, estados 52/9, números y `reversed_by_id`) |
| Asientos nuevos | 48 `payroll_cost_import` numerados 62..109, ejercicio 2026, último día de mes, 6 centros | **48** · min 62 · max 109 · 1 ejercicio (`2026`) · 0 con fecha distinta del último día del mes · 6 centros · 0 sin centro · 8 por centro (AS 67..109, LT 63..105, MC 66..108, OC 64..106, PG 65..107, RA 62..104) · 6 asientos por fecha (2026-01-31, 02-28, 03-31, 04-30, 05-31, 06-30, 07-31, 08-31) |
| `SELECT a.code, sum(debit), sum(credit) … WHERE source_type = 'payroll_cost_import' GROUP BY a.code` | 465 H 1.891.222,19 · 476 H 551.336,97 · 640 D 1.891.222,19 · 642 D 551.336,97 | **465** 48 líneas · H **1891222.19** · **476** 48 · H **551336.97** · **640** 168 · D **1891222.19** · **642** 167 · D **551336.97** (una celda con SS empresa 0,00 en un departamento no genera línea 642: `signedLine` devuelve `null` a 0) |
| Σ debe = Σ haber de los 48 | 2.442.559,16 | **2442559.16 = 2442559.16** · 431 líneas · 0 asientos descuadrados en toda la organización |
| Líneas 640 / 642 sin `cost_center_id` | 0 | **0** (las 96 líneas 465 / 476 no llevan centro de coste, por diseño) |
| 640 / 642 por centro de coste | — | 640: ROOMS 685.275,39 · ADMIN_GENERAL 628.709,87 · FNB 408.976,95 · POM 155.362,57 · SALES_MARKETING 12.897,41 · 642: ROOMS 225.109,28 · ADMIN_GENERAL 144.818,35 · FNB 137.311,26 · POM 39.951,53 · SALES_MARKETING 4.146,55 |
| Diario completo de la organización | 61 + 48 | **109 asientos · 581 líneas · Σ 2.445.154,16 = 2.445.154,16** (2.595,00 previos + 2.442.559,16 nuevos) |
| Invariantes | 25 facturas · 33 envíos · 0 `payroll_periods` | **25 · 33 · 0** |
| Cuentas 47x de IVA | sin líneas nuevas | `4759` 1 línea · `477.10` 14 · `477.21` 6, idénticas al estado previo; la única 47x nueva es `476` (SS acreedora, 48 líneas), que no es IVA |
| Ventas 70x del libro por mes | sin cambios | 2026-07 10,33 · 2026-09 251,70 |
| Modelo 303 2026-Q3 | sin cambios | JSON del API :3000 (código antiguo) **idéntico** antes y después salvo `generatedAt` (578,66 · 74,94 · 37 filas); el mismo resultado con el código nuevo in-process |

### 4.5 Comprobaciones HTTP (app in-process con `buildApiServer()` + `app.inject`, token de la Owner de Faranda; API :3000 sin reiniciar)

| Petición | Resultado |
|---|---|
| `GET /payroll/cost-report?from=2026-01&to=2026-08` | 200 · `totals.lines` 363 · `gross` "1891222.19" · `employerSs` "551336.97" · **`totalCost` "2442559.16"** · `reportedTotalCost` "2442027.24" · `headcount` "1124.00" (Σ celdas) · `employeesReported` "100.50" (media mensual de la referencia, 5 centros) · `headcountEffective` "128.75" (`headcountSource` "reference"; OC sin referencia usa Σ celdas) · `costPerEmployee` "18971.33" · `ledgerNetSales` "10.33" · `netSalesReported` "4335144.05" · `laborPctReference` "56.34" · `laborPctLedger` "23645296.81" (sin sentido: ventas del libro 10,33 €, §6) · `roomsInventory` 932 (ERP, incluye FN 399 y LL 102 sin nómina) · `roomsInventoryReported` 385 · `roomsAvailable` 214.992 · `costPerAvailableRoom` "11.36" · 8 centros · `byGroup` con los cinco grupos de §4.2 |
| `GET /payroll/cost-imports` | 200 · **1 lote** `cmu4d93ri0000fyajr2krjs55 posted` · 363 filas · 2442559.16 · 48 asientos |
| `GET /payroll/cost-imports/cmu4d93ri0000fyajr2krjs55` | 200 · `lines` 363 · `references` 40 · `entries` 48 (2026/62 RA 2026-01-31 … 2026/109 AS 2026-08-31, `fiscalYearCode` "2026") · `reversals` 0 |
| `GET /accounting/usali/pnl?from=2026-01-01&to=2026-08-31&propertyId=cmrhw9jy40003fyvbuu2ec2w7` (RA) | 200 · **`rooms.labor` 206.432,38** (640 155.531,22 + 642 50.901,16) · **`fnb.labor` 197.997,75** (148.257,08 + 49.740,67) · **`pom.labor` 51.731,53** (39.146,16 + 12.585,37) · las 6 cuentas 640 / 642 con **`source: "cost_center"`** (la 705 con `source: "account"`) · `reconciliation` `{ pgcRevenue 10.33, pgcExpense 456161.66, pgcResult −456151.33, usaliNetIncomePlusUnassigned −456151.33, **ok: true** }` · `statistics.headcount` 26 · **`headcountSource: "payroll_cost_import"`** · `ratios.laborPerEmployee` "17544.68" · GOP −456.151,33 · `unassigned` 0,00 |
| `GET /accounting/usali/pnl?from=2026-01-01&to=2026-08-31` (sociedad) | 200 · `rooms.labor` 910.384,67 · `fnb.labor` 546.288,21 · `admin_general.labor` 773.528,22 (`source: "account"`: 640 / 642 ya resuelven a A&G por cuenta, se conserva la fuente original) · `sales_marketing.labor` 17.043,96 · `pom.labor` 195.314,10 · Σ labor **2.442.559,16** · `reconciliation.ok true` (`pgcExpense` 2442559.16) · `statistics.headcount` 129 (128,75 redondeado) · `laborPerEmployee` "18934.57" · GOP −2.442.548,83 |
| `GET /fiscal/models/303?period=2026-Q3` | 200 · base 578,66 · cuota 74,94 · resultado 74,94 · 37 filas emitidas: idéntico al previo |

Quedan pendientes de reproducir contra `http://localhost:3000` cuando el orquestador reinicie el API
(hoy las rutas `/payroll/cost-imports` y `/payroll/cost-report` responden 404 en :3000 porque el
proceso sirve el código anterior) y el recorrido en navegador de Nóminas › Coste de personal.

### 4.6 Idempotencia

Segundo `--apply --confirm cmrhw9jy30002fyvb6tsdiugt` sin `--replace` → **exit 1**:
`PAYROLL_IMPORT_DUPLICATE (409): Este fichero ya se importó (lote cmu4d93ri0000fyajr2krjs55,
contabilizado). Usa replace para sustituirlo. · Nada escrito.` Recuentos antes y después idénticos:
1 lote · 363 líneas · 109 asientos · 21 centros de coste. **No se ha ejecutado `--replace` sobre
Faranda** (dejaría 48 reversos + 48 asientos nuevos).

### 4.7 Re-verificación del integrador final (2026-09-16, 21:20 CEST, solo lectura)

**Dry-run repetido** (mismo comando de §4.2, dos pasadas: texto y `--json`; salida completa en
`<raíz git>/pilots/faranda-celuisma/NOMINA-DRY-RUN-2026-09-16.md`): **exit 1 · `canPost: no`** ·
363 filas normalizadas · 48 celdas · 40 referencias · 0 etiquetas sin mapear · 0 errores · 2 avisos
(línea 167; OFICINA ASTURIAS · RECEPCION → `rooms`) · **duplicado**: «el mismo contenido ya está
importado en el lote cmu4d93ri0000fyajr2krjs55 (posted, nomina-2026-ene-ago.json, 2026-01 →
2026-08) → usa --replace» · **48 solapes** (todas las celdas) · «Nada escrito (dry-run)». Recuentos de
BD antes y después de las dos pasadas, idénticos: 109 asientos · 581 líneas · 1 lote · 363 líneas de
lote · 40 referencias · 21 centros de coste · 15.237 `audit_events`. Como la validación no es limpia
(duplicado), **no se ejecutó `--apply`** y, por regla, tampoco `--replace`.

**SQL** (script `r3-verify.sql` del scratchpad del integrador, 30 consultas; todas de lectura):

| Bloque | Esperado | Real |
|---|---|---|
| A · asientos previos (`source_type <> 'payroll_cost_import'`) | 61 · 52 posted / 9 reversed · nº 1..61 · 150 líneas · Σ 2.595,00 = 2.595,00 | **61 · 52 / 9 · 1..61 · 150 · 2.595,00 = 2.595,00**; por origen `invoice` 13 + 9 rev · `invoice_cancellation` 8 · `invoice_rectification` 4 · `payment` 23 · `payment_refund` 4; 0 previos con nº > 61 y 0 nuevos con nº ≤ 61 |
| B · asientos nuevos | 48 · nº 62..109 · 6 centros · 8 fechas fin de mes · ejercicio 2026 · 48 `source_id` distintos · 0 reversados | **48 · 62..109 · 6 · 8 · 2026 · 48 · 0** (0 sin centro, 0 con fecha distinta del último día, 0 no `posted`); por centro 8 cada uno (RA 62..104, LT 63..105, OC 64..106, PG 65..107, MC 66..108, AS 67..109) |
| B · cuadre | 0 asientos descuadrados en la organización; Σ debe = Σ haber | **0** · **2.442.559,16 = 2.442.559,16** (431 líneas) |
| B · por cuenta | 640 D 1.891.222,19 · 642 D 551.336,97 · 465 H 1.891.222,19 · 476 H 551.336,97 | **idéntico**: 640 168 líneas · 642 167 · 465 48 · 476 48 |
| B · 640 / 642 sin `property_id` o sin `cost_center_id`, con centro de coste de otro centro o no `usali` | 0 / 0 / 0 / 0 | **0 / 0 / 0 / 0** |
| B · 640 / 642 por centro de coste | — | 640: ROOMS 685.275,39 · ADMIN_GENERAL 628.709,87 · FNB 408.976,95 · POM 155.362,57 · SALES_MARKETING 12.897,41 · 642: ROOMS 225.109,28 · ADMIN_GENERAL 144.818,35 · FNB 137.311,26 · POM 39.951,53 · SALES_MARKETING 4.146,55 |
| B · matriz centro × mes y totales por mes | 48 celdas = dry-run | **48 celdas idénticas** a la tabla de §4.2; por mes 287.477,25 · 279.167,20 · 287.548,21 · 295.589,94 · 315.860,69 · 327.620,75 · 317.986,29 · 331.308,83 |
| C · lote | 1 `posted` · `row_count` 363 · 1.891.222,19 / 551.336,97 / 2.442.559,16 / informe 2.442.027,24 · 48 ids · 0 reversos · `le_5a1bd74b` · `cli:import-payroll-cost` | **idéntico**; `headcount_average` 128,75; los 48 `journal_entry_ids` existen y son los 48 asientos; 0 lotes en otras organizaciones |
| C · líneas del lote | 363 · 6 centros · 8 meses · 48 celdas · 0 sin `cost_center_id` · 5 grupos · 5 departamentos USALI · 8 etiquetas de centro | **363 · 6 · 8 · 48 · 0 · 5 · 5 · 8** (14 etiquetas de departamento); Σ bruto / SS / total / informe = las del lote; Σ empleados 1.124; por grupo = tabla de §4.2; **1 sola línea** con `reported_total_cost ≠ total_cost` (RA · 2026-04 · extras · «4 CAF/REST», §5); 0 líneas cuyo `cost_center_id` no sea el `usali` de su centro con `code = upper(usali_department)` |
| C · referencias | 40 · 5 centros | **40 · 5** (OC sin referencia) · Σ empleados 804 · Σ ventas 4.335.144,05 · inventarios 53 / 54 / 56 / 57 / 85 / 92 / 95 |
| D · `cost_centers` | 21 `usali` activos (AS 4 · LT 3 · MC 4 · OC 4 · PG 3 · RA 3), tabla completa 21 | **21 / 21**, códigos = departamento USALI en mayúsculas con nombre en español |
| E · invariantes | 25 facturas · 33 envíos VeriFactu · 0 `payroll_periods` · 0 recibos | **25 (14 issued · 8 cancelled · 3 rectified) · 33 accepted · 0 · 0** |
| E · diario completo | 109 · 581 · Σ 2.445.154,16 | **109 · 581 · 2.445.154,16 = 2.445.154,16** |
| E · cuentas 47x | sin líneas nuevas de IVA | `4759` 1 · `477.10` 14 · `477.21` 6 (idénticas al previo) + `476` 48 (SS acreedora, no IVA) |
| E · ventas 70x del libro por mes | sin cambios | 2026-07 10,33 · 2026-09 251,70 |
| E · sociedad y ejercicios | CEL · A33615980 · CELUISMA S.A. · 8 centros · 0 ejercicios | **idéntico** |

**Modelo 303 2026-Q3** (`GET /fiscal/models/303?period=2026-Q3` en el :3000 en marcha, token de la
Owner): declarante `CELUISMA S.A. · A33615980`, sociedad `le_5a1bd74b`, casillas 04 423,62 · 07 155,04 ·
**27 74,94 · 71 74,94**, totales base 578,66 / cuota 74,94 / resultado 74,94 — idéntico a §4.1 y §4.4
(la forma `?year=2026&period=Q3` que citaba el runbook §18.10 responde 400; corregida).

**Auditoría.** `aud_43788d08` (`PAYROLL_COST_IMPORT_POSTED`, actor `usr_system_payroll_cost_import`,
entidad `payroll_cost_import/cmu4d93ri0000fyajr2krjs55`, `corr_payroll_cost_import`) enlaza con el
hash del evento inmediatamente anterior (`previous_hash` correcto). Existe además un evento
`aud_35a7eeba` `PAYROLL_COST_IMPORTED` (20:15 CEST, actor la Owner de Faranda, entidad
`cmu4f8yuk000mfy6eqy6f4g0g`) de un **borrador** creado y borrado por una prueba de la ronda del
corrector: sin fila en `payroll_cost_imports` ni asientos; residuo normal de la cadena global (nunca se
borra trail, `CLAUDE.md` «Residuos esperados»). Los 35 eventos restantes de Faranda posteriores al
apply son reservas / check-in / housekeeping de las suites de integración (0 facturas, 0 asientos).
2 organizaciones en la BD, 0 residuales de prueba.

**Repositorio.** `/pilots/` ignorado (`.gitignore:6`); 0 ficheros del repo con «EMPLEADO» seguido de
un nombre (grep sobre `hotelos/` sin `node_modules`); 0 ficheros temporales entre los 25 nuevos y 28
modificados del working tree; ningún fichero de `tandaC-files.txt` ni `pnpm-lock.yaml` tocados por esta
integración.

## 5. Hallazgo para César: 531,92 € de diferencia con el informe

El informe de RRHH suma **2.442.027,24 €** de coste total; el ERP ha contabilizado **2.442.559,16 €**
(bruto 1.891.222,19 + SS empresa 551.336,97). La diferencia, **531,92 €**, está en **una sola celda**:
`RIAS ALTAS · 2026-04 · extras · «4 CAF/REST»` (línea 167 del agregado), cuyo `coste_total` es
1.047,75 mientras que su bruto + SS suma 1.579,67. El resto de las 362 celdas cuadran al céntimo
(los cinco grupos coinciden salvo `extras`: 36.140,37 contabilizado frente a 35.608,45 del informe).
Política aplicada (diseño §1.7 y §10.1-5): se contabiliza **siempre bruto + SS empresa** (el asiento
cuadra por construcción) y la cifra del informe se conserva en `reported_total_cost` para conciliar
con el Excel; el CLI y la vista previa lo avisan. Si el Excel tiene razón (por ejemplo una SS de
extras mal sumada), hay que corregir el agregado y re-importar el rango completo con `--replace`;
si es un error de la hoja, no hay nada que hacer en el ERP.

## 6. Decisiones abiertas para César

Ninguna bloquea el uso del lote cargado; cada una dice qué hay hoy por defecto y qué haría falta.

| # | Decisión | Estado hoy (por defecto) | Si cambia |
|---|---|---|---|
| 1 | **OFICINA MADRID y REG. CORUÑA como centros propios** | No existen en el ERP: van a OC conservando la etiqueta en `work_center_label` (OFICINA ASTURIAS 536.708,24 · OFICINA MADRID 229.703,30 · REG. CORUÑA 72.104,37 en ocho meses; un asiento de OC por mes suma las tres) | Alta de dos `Property kind = office` (o `other`) con código (p. ej. `OM`, `RC`) en Configuración › Estructura societaria + reimportación del rango completo con `--replace` (reversa los 48 asientos y crea 64: 8 centros × 8 meses); USALI «corporativo» desglosado por sede |
| 2 | **Familia / administradores** (grupo `familia`: PROPIEDAD y administradores, 428.392,39 €) | 640 / 642 en `admin_general.labor` como el resto; no figura en la hoja resumen «2026» del informe pero es coste real | Si son retribuciones de administradores, el PGC las presenta también en 640 (nota en la memoria); separarlas es un mapeo `groups` a otro departamento admitido o una cuenta específica (`6400x`) en una tanda posterior; sin cambio de modelo |
| 3 | **Subcuentas 640.x / 642.x por departamento** | Descartadas (diseño §1.1): el departamento vive en el centro de coste `usali`, único origen de verdad también para nóminas reales y asientos manuales; sumas y saldos muestran 640 / 642 genéricas | Si la gestoría exige subcuentas: mapeo cuenta ← (640, centro de coste) en la exportación a gestoría, sin tocar asientos; o subcuentas en el plan y en la regla (cambio de regla + reimportación) |
| 4 | **Pago y retenciones** | Devengo del coste de empresa: D 640 / D 642, H 465 (1.891.222,19 acreedor) y H 476 (551.336,97 acreedor) quedan pendientes hasta que tesorería registre nómina líquida, TGSS y AEAT contra 465 / 476; sin IRPF (4751) ni SS del trabajador; el Modelo 111 no se alimenta de estos asientos | Importar dos columnas más (IRPF retenido, SS del trabajador) y una regla D 465 / H 4751 · H 476: extensión aditiva del formato (diseño §10.1-4); mientras tanto, 465 / 476 se saldan con los extractos bancarios |
| 5 | **Importación directa de `.xlsx`** | No construida a propósito: el Excel de RRHH es **por persona** y no debe entrar en el ERP (GDPR, runbook §18.1); la agregación se hizo fuera del repo y el ERP acepta CSV `;` o JSON agregados (drawer o CLI) | Opción a (recomendada, hoy posible): RRHH exporta la tabla dinámica agregada (centro × mes × grupo × departamento) como CSV `;` UTF-8 y la sube en Nóminas › Coste de personal; opción b: lector `.xlsx` en el API, que exige una librería (hoy no hay ninguna en `node_modules` y la regla lo impide) y garantizar que solo se persisten agregados — solo si la opción a falla en la práctica |
| 6 | **Ventas de referencia vs libro mayor** | El libro solo tiene ventas 70x desde julio (10,33 € en julio; 251,70 € en septiembre): la cobertura < 90 % deja la referencia del informe como fuente principal en todo el rango (`salesSource: "reference"`, 56,34 % de personal sobre ventas); `laborPctLedger` sigue disponible como dato bruto | Cargar la facturación histórica de 2026 (replay contable) para que el libro cubra ≥ 90 % y el ratio pase a `ledger` automáticamente, o aceptar la referencia como cifra de gestión |
| 7 | **Diferencia de 531,92 €** (línea 167) | Contabilizado bruto + SS (2.442.559,16); el informe (2.442.027,24) en `reported_total_cost` | §5: si el Excel tiene razón, corregir el agregado y reimportar con `--replace`; si no, nada |
| 8 | **Empleados de la oficina central** | OC no tiene referencia en la hoja resumen: usa Σ celdas (30 / 30 / 29 / 28 / 29 / 27 / 27 / 26); en los hoteles prima `employeesReported` (Σ celdas 1.124 frente a 804 del informe) | Pedir a RRHH la plantilla media de la oficina por mes (columna `empleadosInforme` para OC) o aceptar Σ celdas |
| 9 | **Personal de OFICINA ASTURIAS · RECEPCION en `rooms`** (34.236,25 €) | Respetado tal como lo mapeó el informe; el parser avisa | `mapping.departments` → `admin_general` (o la columna `usali`) + reimportación con `--replace` |
| 10 | **Inventario de habitaciones** | Informe 385 (5 hoteles; RA 95) frente al ERP 932 (incluye FN 399 y LL 102 sin nómina; RA 103 / 120 según la ficha); el coste por habitación disponible mezcla referencia (donde existe) y ERP | Fijar el inventario oficial por hotel en Estructura societaria y, si procede, quitar `habitacionesDisponibles` del informe |

Simplificación contable que conviene tener presente al leer el diario (no es decisión): se devenga el
coste de empresa (bruto + SS empresa); 465 queda por el bruto y 476 por la SS empresa; sin IRPF ni SS
del trabajador; la nómina no lleva IVA (Modelo 303 invariante) — runbook §18.4.

## 7. Pendientes tras la integración final

Resueltos en la ronda 2 del corrector: etiqueta del actor de sistema (`actor-label.ts`, FU-02),
`PayrollCostImportDrawer` en la whitelist de discoverability, los 6 pins de integración de la sociedad
antigua (re-pinados a `CEL · A33615980 · CELUISMA S.A.`, 8 centros: integración 363 pass · 0 fail) y el
informe / runbook desfasados (6C-02).

| Pendiente | Detalle | Quién / dónde |
|---|---|---|
| Reinicio del API :3000 y de Vite :5173 | El proceso :3000 sirve el cliente Prisma y las rutas anteriores: `/payroll/cost-imports*` y `/payroll/cost-report` responden 404. Tras reiniciar: repetir los `GET` de §4.5 contra `http://localhost:3000` (esperado `cost-report` 200 · 8 meses · 8 centros · `totalCost` "2442559.16"), `test:integration` completo y el recorrido en navegador de Nóminas › Coste de personal como la Owner de Faranda (pestaña, matriz, cajón con el JSON en previsualización → duplicado) | Orquestador |
| Cocoa 22 regla 15 (inventario) | `node scripts/cocoa-22-inventory.mjs` al fusionar con la Tanda C: 223 ficheros / 90.339 líneas / `cocoaButtons` 1.041 / `cocoaTables` 285 / `cocoaInputs` 1.048 / `debtPoints` 313 (= 313) | Propietario de `docs/design/cocoa-22-inventory.json` (Tanda C) |
| ESLint sin configuración | `corepack pnpm --filter <pkg> lint` sale con exit 2 en api, admin-web, shared y database (ESLint 9 sin `eslint.config.*`; `packages/config/eslint.config.mjs` no referenciado). Infra preexistente | Fuera de la tanda |
| Comando de los unitarios front | `apps/admin-web/package.json` sin script `test` ni `tsx`: documentar / añadir el comando de §3 (puerta 3) para que sea reproducible | `apps/admin-web/package.json` |
| Cadena de auditoría en memoria | El CLI de L6 y las suites se ejecutaron con el API en marcha: la cadena en memoria del :3000 queda por detrás de la BD (`aud_43788d08` y posteriores); se resuelve al reiniciar (deuda 12(c)). El evento huérfano `aud_35a7eeba` (borrador borrado) no exige acción | `audit_events` |
| Runbook §17.13 | Cita `GET /fiscal/models/303?year=2026&period=Q3` (responde 400; la forma válida es `?period=2026-Q3`, corregida en §18.10). Texto de la Tanda 6b, no tocado | `docs/runbooks/finanzas-contabilidad.md` |
| Cifras de Faranda 2026 | Cualquier pin futuro sobre USALI / PyG de Faranda 2026 incluye 2.442.559,16 € de coste de personal (GOP de sociedad ene-ago −2.442.548,83); los 61 asientos previos y el 303 no cambian | Tests y probes que lean Faranda |
| `--replace` | Nunca sobre Faranda salvo decisión expresa de César (§6 #1, #7, #9): reversa el lote **entero** y crea los asientos nuevos en la misma transacción | runbook §18.5 |

## 8. Procedimiento de reverso

1. **API**: `POST /payroll/cost-imports/cmu4d93ri0000fyajr2krjs55/reverse` con
   `{ "reason": "<motivo ≥ 3 caracteres>" }` (permiso `payroll.manage`; riesgo `critical`, exige token
   real). Reversa los 48 asientos con `reverseJournalEntry` (uno por `journalEntryId`; descripción
   «Reverso coste de personal <mes> · <centro> — <motivo>», misma `entryDate`, conserva
   `costCenterId`), marca el lote `reversed` con `reversal_journal_entry_ids`, `reversed_at`,
   `reversed_by` y `reversal_reason`, y audita `PAYROLL_COST_IMPORT_REVERSED`. Idempotente: un
   segundo reverso devuelve el lote con `alreadyReversed: true`. Si un mes estuviera cerrado, el servicio
   responde 409 `FISCAL_PERIOD_CLOSED` AUNQUE el cuerpo traiga una `entryDate` abierta (corrector 6c,
   contable-6C-02: un reverso fechado fuera del mes cerrado haría desaparecer el 640/642 de ese mes en
   los estados sin que el mes abierto recibiera el abono): reabrir el periodo en Contabilidad › Periodos,
   revertir y volver a cerrar; `entryDate` solo mueve el reverso entre periodos abiertos (runbook §18.5).
   Nunca toca los 61 asientos previos: solo los ids de `journal_entry_ids` del lote.
2. **UI**: Nóminas › Coste de personal › «Importaciones» › acción «Revertir» del lote
   (`CocoaDialog` con motivo obligatorio) — requiere el API reiniciado.
3. **Re-importación** tras el reverso: el hash queda libre y el `importId` es nuevo → `sourceId`
   nuevos; reimportar siempre el rango completo (2026-01 → 2026-08).
4. Comprobación posterior: `SELECT status, array_length(reversal_journal_entry_ids,1) FROM
   payroll_cost_imports WHERE id = 'cmu4d93ri0000fyajr2krjs55'` → `reversed | 48`; los 48 asientos
   62..109 en `status = 'reversed'` con `reversed_by_id` a los 48 reversos nuevos (110..157); Σ 640 y
   Σ 642 netos 0,00 en el periodo.

## 9. Consultas y comandos reproducibles

```sql
-- organización Faranda
\set org '''cmrhw9jy30002fyvb6tsdiugt'''
SELECT status, row_count, total_gross, total_employer_ss, total_cost, reported_total_cost,
       array_length(journal_entry_ids,1) FROM payroll_cost_imports WHERE organization_id = :org;
SELECT count(*), count(*) FILTER (WHERE cost_center_id IS NULL) FROM payroll_cost_lines WHERE organization_id = :org;
SELECT count(*) FROM payroll_cost_references WHERE organization_id = :org;
SELECT p.code, count(*), string_agg(cc.code, ',' ORDER BY cc.code) FROM cost_centers cc
  JOIN properties p ON p.id = cc.property_id WHERE cc.type = 'usali' GROUP BY p.code ORDER BY p.code;
SELECT id, status, entry_number, reversed_by_id FROM journal_entries
  WHERE organization_id = :org ORDER BY entry_number;                       -- 109 filas (61 + 48)
SELECT a.code, sum(jl.debit), sum(jl.credit), count(*) FILTER (WHERE jl.cost_center_id IS NULL)
  FROM journal_lines jl JOIN accounts a ON a.id = jl.account_id
  JOIN journal_entries je ON je.id = jl.journal_entry_id
  WHERE je.organization_id = :org AND je.source_type = 'payroll_cost_import' GROUP BY a.code ORDER BY a.code;
SELECT (SELECT count(*) FROM invoices i JOIN properties p ON p.id = i.property_id WHERE p.organization_id = :org),
       (SELECT count(*) FROM verifactu_submissions v JOIN invoices i ON i.id = v.invoice_id
          JOIN properties p ON p.id = i.property_id WHERE p.organization_id = :org),
       (SELECT count(*) FROM payroll_periods WHERE organization_id = :org);   -- 25 · 33 · 0
```

```
# dry-run (no escribe) · apply (una vez) · segundo apply → PAYROLL_IMPORT_DUPLICATE
cd apps/api && node --env-file-if-exists=../../.env --import tsx src/scripts/import-payroll-cost.ts \
  --file <raíz git>/pilots/faranda-celuisma/nomina-2026-ene-ago.json --organization cmrhw9jy30002fyvb6tsdiugt [--apply --confirm cmrhw9jy30002fyvb6tsdiugt]
# tras el reinicio del API (token de la Owner de Faranda)
curl -H "Authorization: Bearer $TOKEN" "http://localhost:3000/payroll/cost-report?from=2026-01&to=2026-08"
curl -H "Authorization: Bearer $TOKEN" "http://localhost:3000/payroll/cost-imports"
curl -H "Authorization: Bearer $TOKEN" "http://localhost:3000/accounting/usali/pnl?from=2026-01-01&to=2026-08-31&propertyId=cmrhw9jy40003fyvbuu2ec2w7"
curl -H "Authorization: Bearer $TOKEN" "http://localhost:3000/fiscal/models/303?period=2026-Q3"
```

Operativa completa en `docs/runbooks/finanzas-contabilidad.md` §18 (§18.10 «Carga de Faranda»,
§18.5 reverso, §18.9 CLI); rutas en `docs/api-contracts.md` «Coste de personal importado (Tanda 6c)».

## 10. Corrector 6c (dos rondas, 2026-09-16): hallazgos, correcciones y puertas

Revisión adversarial de tres revisores (contable, seguridad, front/UX) sobre el working tree de la tanda:
12 hallazgos confirmados (7 alta / media) + 13 bajos. Estado tras la ronda 2 (working tree sin commit):

| ID | Sev. | Estado | Corrección o motivo | Dónde |
|---|---|---|---|---|
| contable-6C-01 | alta | corregido | `replace: true` exige `post: true`: 400 `VALIDATION_ERROR` en el esquema (`refine`) y repetido en el servicio; un borrador ya no revierte lotes contabilizados | `schemas/payroll-cost.schemas.ts`, `cost-import.service.ts` (`createPayrollCostImport`), `tests/integration/payroll-cost-import.test.mts` |
| contable-6C-02 | alta | corregido | `assertOriginalPeriodOpen`: el periodo y el ejercicio del asiento ORIGINAL deben estar abiertos aunque `entryDate` sea otra (409 `FISCAL_PERIOD_CLOSED` / `FISCAL_YEAR_CLOSED`); el runbook §18.5 y el §8 de este informe retiran la recomendación de «pasar una `entryDate` abierta»: reabrir → revertir → cerrar | `cost-import.service.ts` (`reverseImportInTx`), runbook §18.5, diseño §7, `docs/api-contracts.md` |
| contable-6C-03 | media | corregido | `salesSourceOf` con regla de cobertura (`PAYROLL_COST_LEDGER_COVERAGE_MIN` 0,9): `salesSource` en celdas, centros, meses y sociedad; `laborPctOf`, `salesBars` y el KPI «Personal s/ ventas» pintan la fuente principal (Faranda ene-ago: 56,34 % de referencia, julio `reference`) | `cost-report.service.ts`, `payroll-cost-types.ts`, `payroll-cost-helpers.ts`, `PayrollScreen.tsx` |
| SEC-6C-01 | alta | corregido | `replaceImportsInTx` exige `assertFinanceReadScopeMany` sobre las celdas de CADA lote afectado (404 opaco, como el reverso directo; rollback del lote nuevo); la preview con `replace` responde `canPost: false` con aviso; caso de integración «usuario solo-HA» | `cost-import.service.ts`, `tests/integration/payroll-cost-import.test.mts` |
| SEC-6C-02 | media | corregido | Topes por valor en el parser: `parseLabel` (≤ 200 caracteres, sin caracteres de control), `parseAmount` (< 10^12; empleados < 10^6), `parseRoomsInventory` (≤ 2^31-1) → 400 `PAYROLL_IMPORT_INVALID` con nº de línea, nunca un 500 de Prisma dentro de la transacción | `cost-import.parser.ts`, `payroll-cost-types.ts`, `cost-import-parser.test.mts` |
| SEC-6C-03 | media | corregido | `importLimitIssues`: ≤ 24 meses, ≤ 240 celdas (asientos), ≤ 5.000 filas por lote → 400 `PAYROLL_IMPORT_INVALID { errors }` (la preview los lista) | `cost-import.service.ts`, `payroll-cost-types.ts` |
| front-ux-FU-01 | alta | corregido | `runPreview` en dos pasadas: la primera sugerencia de centro se aplica y se re-previsualiza con ella; la etiqueta sigue listada en «2 · Mapeo» para confirmar o cambiar | `PayrollCostImportDrawer.tsx` |
| front-ux-FU-02 | alta | corregido | `usr_system_payroll_cost_import: "importación del coste de personal"` en `SYSTEM_ACTOR_LABELS` (front 1.017 / 1.017) | `screens/accounting/actor-label.ts` |
| front-ux-FU-03 | media | corregido | KPI «Coste por empleado» rotulado «acumulado del rango por empleado medio» con la división en el caption; pie de la matriz explica la columna «Total» | `PayrollScreen.tsx` |
| front-ux-FU-04 | media | corregido | `useEffect` sobre `open` reinicia fichero, previsualización, mapeo, resultado y errores en cada apertura | `PayrollCostImportDrawer.tsx` |
| front-ux-FU-05 | media | corregido | Tier `phone`: cada tarjeta lleva el centro (o «Sociedad»); solo el último mes y «Total» (los intermedios `showFrom: "tablet"`) | `PayrollScreen.tsx` |
| front-ux-FU-06 | media | corregido | `CocoaDatePicker` «Fecha de la anulación» (opcional) en el diálogo «Revertir», con la nota de reabrir el mes cerrado (coherente con 6C-02) | `PayrollScreen.tsx` |
| contable-6C-06 | baja | corregido | Aviso por (centro, departamento) cuando una oficina (`kind office`) enruta personal a `rooms` / `fnb` / `other_operated`; el dato se respeta | `cost-import.parser.ts` |
| contable-6C-07 | baja | corregido | Aviso único por fichero de los importes «1.234» (un solo punto y tres cifras) leídos como 1,23 | `cost-import.parser.ts` |
| contable-6C-08 | baja | corregido (ronda 2) | El aviso de nómina real ya contabilizada llega también a `warnings` del resultado de create / post (cajón y CLI `--apply` lo muestran, con el centro y el mes); sigue sin bloquear porque el lote importado puede ser la única nómina del centro | `cost-import.service.ts` (`payrollPeriodsWarning`), test de integración, runbook §18.1, `docs/api-contracts.md` |
| contable-6C-09 | baja | no procede | Con 6C-02, revertir un mes cerrado exige reabrirlo también cuando lo hace `replace` (misma guarda, runbook §18.5): una `entryDate` en `replace` no abriría ningún camino nuevo y reintroduciría el problema de 6C-02 | — |
| SEC-6C-04 | baja | corregido | `maskDuplicateRef` / `maskOverlapRefs`: `fileName` y `postedAt` a null en la preview y en los 409 para lotes con centros fuera del ámbito | `cost-import.service.ts` |
| SEC-6C-05 | baja | corregido | `ensureUsaliCostCentres` reutiliza el `CostCenter` existente sin reescribir `type` ni `active` (aviso si difiere) | `cost-import.service.ts` |
| SEC-6C-06 | baja | corregido | Un `updateMany` por pareja (centro, departamento) en vez de por línea (21 frente a 363 en Faranda) | `cost-import.service.ts` |
| front-ux-FU-07 | baja | corregido | Insignia «Cargando» y `aria-busy` en la matriz mientras llega un rango, grupo o ámbito nuevo | `PayrollScreen.tsx` |
| front-ux-FU-08 | baja | corregido | Tooltip del gráfico: «sin dato de empleados» en vez de «0 empleados» | `payroll-cost-helpers.ts` |
| front-ux-FU-09 | baja | corregido | La lista de importaciones solo repite el origen cuando hay `fileName` | `PayrollScreen.tsx` |
| front-ux-FU-10 | baja | corregido | Sin `payroll.manage` el cajón explica que tampoco puede previsualizar; el rechazo de fichero va bajo «No se pudo leer el fichero» | `PayrollCostImportDrawer.tsx` |
| front-ux-FU-11 | baja | corregido | KPI «Empleados medios» dice «sin dato de empleados» cuando no hay ninguno | `PayrollScreen.tsx` |
| front-ux-FU-12 | baja | corregido | El diálogo «Contabilizar» de un borrador ofrece «Sustituir los lotes anteriores» (`POST …/:id/post { replace }`) | `PayrollScreen.tsx` |

**Puertas tras la ronda 2** (desde `hotelos/`, working tree sin commit): typecheck `@hotelos/api` y
`@hotelos/admin-web` sin errores · unitarios API **1.598 · 1.597 pass · 0 fail · 1 skipped**
(preexistente) · unitarios front (comando de §3) **1.017 / 1.017** · contratos **445 · 444 pass · 1
fail** (solo la regla 15 del inventario Cocoa: `docs/design/cocoa-22-inventory.json` y
`scripts/cocoa-22-inventory.mjs` son de la Tanda C; delta actual 223 ficheros / 90.339 líneas /
`cocoaButtons` 1.041 / `cocoaTables` 285 / `cocoaInputs` 1.048 / `debtPoints` 313 = 313, la deuda no
crece; el propietario del fichero ejecuta `node scripts/cocoa-22-inventory.mjs`) · integración de la
tanda (`payroll-cost-import` + `payroll-cost-routes` + `usali-cost-centre`) **32 / 32** ·
`check-discoverability` OK · `build-nav-tree --check` al día. Los scripts de reproducción de los
revisores, re-ejecutados sobre el código corregido (organizaciones aisladas, borradas al final):
R1 (`post: false` + `replace`) → 400 `VALIDATION_ERROR { field: "replace" }`; R2 (reverso con
`entryDate` abierta de un mes cerrado) → 409 `FISCAL_PERIOD_CLOSED { periodCode: "2026-05" }`; C1 y C2
(reverso directo y `replace` por un usuario solo-HA) → 404 sin nada revertido; B / A / A' (empleados
10^7, etiqueta de 3.000 caracteres, NUL) → 400 `PAYROLL_IMPORT_INVALID`; sonda de Faranda:
`salesSource reference` en 2026-07 / 2026-08 (el ratio del libro, 23.645.296,81 %, ya no es la fuente
principal). Fuera del alcance de la tanda: `eslint .` en los workspaces falla por infra preexistente
(solo existe `packages/config/eslint.config.mjs`, no referenciado) y `structure-l6-l7-contract` puede
fallar una vez por la carrera de lectura de org_123 con suites hermanas (sola 14 / 14, deuda 15(f)).

Integración final (16/09, 21:30 CEST): puertas definitivas en §3, dry-run repetido y re-verificación SQL
en §4.7, decisiones abiertas en §6, pendientes en §7. BD local sin escrituras adicionales; sin `git add`
/ `commit`, sin tocar `pnpm-lock.yaml` ni los ficheros de la Tanda C, sin reiniciar servidores.
