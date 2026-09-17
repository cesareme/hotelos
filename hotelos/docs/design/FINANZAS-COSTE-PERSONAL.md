# Finanzas · Coste de personal importado — nómina agregada, PGC y USALI por centro de coste

Diseño de la **Tanda 6c · Coste de personal importado** para el encargo de César (Faranda = CELUISMA S.A., 8 centros de trabajo bajo un NIF; informe de RRHH «coste de nómina 1-ene → 31-ago 2026»). Fecha: 2026-09-16. Documento de diseño final: síntesis de dos propuestas (A modelo dedicado, B reutilización de nóminas) verificada por un juez independiente; los lotes L0-L6 de §9 lo implementan. Estado 2026-09-16: L0-L5 implementados sobre el working tree (schema + migración `20260916120000_coste_personal_importado`, servicio, USALI por centro de coste, rutas + CLI, front, runbook §18); L6 (carga real de Faranda) pendiente del integrador. Correspondencia con el runbook `docs/runbooks/finanzas-contabilidad.md`: §1.1 (catálogo `payroll_cost_import`, `PayrollCostImportStatus`, enums documentales), §1.8 (modelos), §3 (escritores/lectores), §4 paso 0 (centro de coste `usali`), §8 (`source: "cost_center"`, headcount, `laborPerEmployee`), §13 (7 rutas), §14 (`payroll:import-cost`) y §18.1-18.12 (esta tanda). Se apoya en la Tanda 6b (`docs/design/FINANZAS-ESTRUCTURA-SOCIETARIA.md`: sociedad, centros, ámbito R11, `resolveLedgerScope`).

Leyenda: **[V]** verificado (código leído con fichero:línea, SQL sobre la BD local o cálculo sobre el fichero agregado) · **[I]** inferido (decisión de diseño pendiente de confirmar con César).

Fuentes de trabajo: `packages/database/prisma/schema.prisma` (`CostCenter` 785-795, `JournalLine` 3669-3677, `PayrollPeriod` 5118-5120), `apps/api/src/modules/accounting/{posting-rules.ts:65-77,142-162, chart-of-accounts.service.ts:45-91}`, `apps/api/src/modules/treasury/{ledger-bridge.ts, permissions.ts}`, `apps/api/src/modules/financial-statements/{source.ts, usali.service.ts, usali-mapping.service.ts:50-54}`, `apps/api/src/lib/finance-scope.ts:189-292`, `apps/admin-web/src/screens/payroll/PayrollScreen.tsx`, `docs/runbooks/finanzas-contabilidad.md` (§1.1, §4, §13, §17), `tests/rbac-nav-contract.test.mjs:344,461`, y el agregado **sin datos personales** `<raíz git>/pilots/faranda-celuisma/nomina-2026-ene-ago.json` (carpeta git-ignored).

---

## §1 · Resumen y motivación

1. **Qué entrega César.** Un Excel de RRHH por empleado (hojas Operaciones, Extras, Estructura, Mant-Obra, Familia y una hoja resumen «2026» con empleados, habitaciones y ventas por centro y mes). **Se agrega fuera del repositorio** a centro × mes × grupo × departamento: 363 líneas, 8 etiquetas de centro (ALISAS, MARSOL, PATHOS, RIAS ALTAS, TILOS, OFICINA ASTURIAS, OFICINA MADRID, REG. CORUÑA), 5 grupos (`operaciones` · `extras` · `estructura` · `mantenimiento_obra` · `familia`), 14 etiquetas de departamento ya mapeadas a 5 departamentos USALI (`rooms`, `fnb`, `pom`, `admin_general`, `sales_marketing`) y 40 referencias (empleados del informe, inventario de habitaciones, ventas sin IVA) [V cálculo sobre el JSON].
2. **Por qué importa para el PGC.** Hoy el diario de Faranda tiene 61 asientos y ningún coste de personal: el PyG de la sociedad está incompleto en su partida mayor (2,44 M€ en ocho meses). La nómina real de ehotelOS (`PayrollPeriod` → recibos por persona → asiento `payroll_slip`) no existe para Faranda ni va a existir a corto plazo: la gestoría calcula las nóminas fuera. El ERP debe **devengar el coste** (D 640 sueldos y salarios / D 642 Seguridad Social a cargo de la empresa) por centro de trabajo y mes con lo que RRHH ya sabe.
3. **Por qué importa para USALI.** El coste de personal es la línea `labor` de cada departamento y la clave del GOP comparable. Hoy `640/641/642 → admin_general.labor` [V runbook §4]: todo el personal cae en Administración y general y el GOP de Habitaciones o de A&B sale falso. `JournalLine.costCenterId` y `CostCenter` existen desde hace tiempo pero el lector USALI (`source.ts accountBalances`) agrupa solo por cuenta [V]. Esta tanda enruta la línea `labor`/`other_expense` por el **centro de coste USALI** del apunte, para el coste importado y para cualquier asiento futuro con centro de coste.
4. **GDPR: agregación sin nombres.** El formato de importación es agregado por construcción (no admite columnas de persona); el ERP guarda solo agregados; ningún fichero del repo contiene nombres ni datos por persona; los tests usan cifras sintéticas; el agregado real vive en `pilots/` (git-ignored). La memoria del ERP no necesita más: el desglose por persona sigue en la gestoría.
5. **Modelo dedicado y trazable** (`PayrollCostImport` lote · `PayrollCostLine` agregado · `PayrollCostReference` referencia), **nunca `PayrollPeriod`** (§1.1). Cada lote sabe qué fichero lo originó (hash de contenido normalizado), qué mapeo se aplicó, qué asientos generó y cuáles lo revirtieron.
6. **Un asiento por (centro, mes)** fechado el último día del mes, `sourceType payroll_cost_import`, líneas D 640 / D 642 por departamento USALI con `costCenterId` del `CostCenter { propertyId, code: USALI en mayúsculas, type "usali" }` creado al vuelo, y H 465 / H 476 por el total. **Simplificación documentada**: devengo del coste empresa; sin IRPF ni SS del trabajador (el pago y las retenciones se registran aparte, §10).
7. **Política de datos:** `coste_total` del fichero es **informativo** (se guarda como `reportedTotalCost`); se contabiliza **siempre bruto + SS empresa** y se avisa si difieren más de 0,01. En Faranda 640 + 642 = **2.442.559,16 €** (bruto 1.891.222,19 + SS 551.336,97), no los 2.442.027,24 € del resumen del informe: una fila (RA · 2026-04 · extras · «4 CAF/REST») trae un coste total 531,92 € inferior a bruto + SS [V, §10].
8. **Idempotencia en tres capas:** mismo contenido vivo → 409 `PAYROLL_IMPORT_DUPLICATE`; mismo centro × mes ya contabilizado → 409 `PAYROLL_IMPORT_OVERLAP`; con `replace: true` se revierten los lotes afectados **enteros** y se crea el lote nuevo en la misma transacción. Reverso completo e idempotente del lote. Todo bajo un advisory lock por organización, sin índices parciales escritos a mano.
9. **Permisos y ámbito:** lectura `payroll.read`, escritura `payroll.manage` en la ruta (Dirección tiene `payroll.manage` pero **no** `accounting.journal.post` [V rbac-nav:461]); el servicio acepta cualquiera de `PAYROLL_WRITE_KEYS`. Un lote es visible y actuable solo cuando **todos** sus centros están en el ámbito del usuario; el informe de toda la sociedad exige `accounting.entity.read` (R11 de la Tanda 6b).
10. **Entregables:** 7 rutas `/payroll/cost-imports*` y `/payroll/cost-report`, CLI `payroll:import-cost` (dry-run por defecto), pestaña «Coste de personal» en Nóminas con drawer de importación, matriz centros × meses, dos gráficos de barras y lista de lotes; runbook §18; carga real de Faranda: **48 asientos nuevos numerados 62..109** en el ejercicio 2026, los 61 previos intactos.

### 1.1 Alternativas descartadas

| Alternativa | Por qué se descarta | Conf. |
|---|---|---|
| Reutilizar `PayrollPeriod` con `source: "import"` | `@@unique([organizationId, periodCode, propertyId])` colisiona con un periodo real del mismo centro y mes; sus recibos son por persona (el headcount USALI cuenta `staffProfileId`); no tiene columna `source`; `GET /payroll/periods` listaría los lotes con acciones «calcular»/«pagar» que no aplican | V schema:5118 |
| Referencias (empleados, habitaciones, ventas) en un JSONB del lote | El informe de coste y el fallback de headcount necesitan consultas relacionales por (centro, mes); la unicidad `(importId, propertyId, periodCode)` es gratis en tabla y la migración la genera Prisma | V |
| Subcuentas `640.x` / `642.x` por departamento | Dos fuentes de verdad del departamento (subcuenta y centro de coste); `it` no tiene subcuenta; las nóminas reales ya propagan `contract.costCenterId` [V posting-rules:708-709]; el enrutado por centro de coste sirve también a asientos manuales | V |
| Índice único parcial «un lote vivo por hash» escrito a mano en la migración | Riesgo de drift entre schema y migración (`db:drift:check`); el mismo efecto se obtiene con `pg_advisory_xact_lock` por organización dentro de la transacción, el mecanismo que ya usa la numeración del diario | V |
| Tratar `coste_total ≠ bruto + SS` como error | El fichero real de Faranda no podría importarse (una fila descuadrada); el asiento cuadra por construcción y la cifra del informe se conserva para conciliar con el Excel de César | V cálculo |
| Enrutar USALI por `cost_centers.id` | Duplicaría filas en el consolidado (RA/ROOMS y LT/ROOMS son centros de coste distintos) y claves en el drawer de cuentas; se agrupa por `(type, code)` | V |

---

## §2 · Modelo de datos

```
Organization ── LegalEntity (resolveLedgerScope) ── Property (centro; sin FK desde las tablas nuevas, convención payroll_periods)
 └── PayrollCostImport   (LOTE: hash, estado draft→posted→reversed, mapeo aplicado, totales, asientos y reversos)
      ├── PayrollCostLine       (AGREGADO: etiqueta ORIGINAL del centro × mes × grupo × departamento → propertyId, usaliDepartment, costCenterId)
      └── PayrollCostReference  (REFERENCIA del informe por propertyId × mes: empleados, inventario de habitaciones, ventas sin IVA)
Diario: JournalEntry { sourceType payroll_cost_import, sourceId <importId>:<propertyId>:<periodCode>, propertyId } → JournalLine { costCenterId → CostCenter { propertyId, code ROOMS|FNB|…, type "usali" } }
```

**`PayrollCostImportStatus`** (enum Prisma, tras `DepreciationRunStatus`): `draft` · `posted` · `reversed`.

| Modelo (`@@map`) | Columnas | Índices y unicidad |
|---|---|---|
| **`PayrollCostImport`** (`payroll_cost_imports`) | `id`; `organizationId`; `legalEntityId?` (de `resolveLedgerScope`, nunca de `organization.taxId/legalName`); `source` (`csv` · `json` · `informe_rrhh`, enum documental); `fileName?`; `contentHash` (sha256 hex de filas + referencias normalizadas: el mismo para el CSV y el JSON equivalentes); `periodFrom` / `periodTo` (`YYYY-MM`); `status`; `rowCount`; `totalGross` / `totalEmployerSs` / `totalCost` (`Decimal(14,2)`, `totalCost = Σ(gross + employerSs)`); `reportedTotalCost?` (Σ `coste_total` del fichero, informativo); `headcountAverage?` (`Decimal(8,2)`); `mappingJson` (`{ centres, departments, groups }` aplicado); `journalEntryIds[]`; `reversalJournalEntryIds[]`; `notes?`; `createdBy?`; `createdAt`; `postedAt?`; `reversedAt?`; `reversedBy?`; `reversalReason?` | `@@index([organizationId, status, periodFrom, periodTo])` · `@@index([organizationId, contentHash])` |
| **`PayrollCostLine`** (`payroll_cost_lines`) | `id`; `importId` (FK → lote, `onDelete: Cascade`); `organizationId` (desnormalizado, sin FK: filtros de solape y del informe sin join); `propertyId`; `workCenterLabel` (**etiqueta original**: OFICINA ASTURIAS / OFICINA MADRID / REG. CORUÑA → OC); `costGroup` (enum documental de 5 valores); `departmentLabel` (original); `usaliDepartment` (`rooms` · `fnb` · `other_operated` · `admin_general` · `it` · `sales_marketing` · `pom`); `costCenterId?` (se rellena al contabilizar); `periodCode`; `gross` / `employerSs` / `totalCost` (`= gross + employerSs`); `reportedTotalCost?`; `headcount` (`Decimal(8,2)`, empleados de la celda) | `@@unique([importId, workCenterLabel, periodCode, costGroup, departmentLabel])` · `@@index([importId, propertyId, periodCode])` · `@@index([propertyId, periodCode])` · `@@index([organizationId, periodCode])` |
| **`PayrollCostReference`** (`payroll_cost_references`) | `id`; `importId` (FK Cascade); `organizationId`; `propertyId`; `workCenterLabel?`; `periodCode`; `employeesReported?` (`Decimal(8,2)`); `roomsAvailableReported?` (**inventario** de habitaciones del informe, no habitaciones-noche); `netSalesReported?` (`Decimal(14,2)`) | `@@unique([importId, propertyId, periodCode])` · `@@index([propertyId, periodCode])` · `@@index([organizationId, periodCode])` |
| `JournalLine` | sin columnas nuevas | `@@index([costCenterId])` tras `@@index([accountCode])` (lector USALI por centro de coste) |
| `JournalEntry` | sin columnas nuevas; `payroll_cost_import` en el comentario `///` del catálogo de `sourceType` (el contrato `finanzas-schema-contract` pina el bloque) | — |
| `CostCenter` [V schema:785-795] | **sin cambios**: filas `{ propertyId, code: "ROOMS" \| "FNB" \| "POM" \| "SALES_MARKETING" \| "ADMIN_GENERAL" \| "OTHER_OPERATED" \| "IT", name: USALI_DEPARTMENTS[dept], type: "usali", active: true }` por `upsert` sobre `propertyId_code` en la misma transacción del asiento; los seeds demo (`operating` / `cost`) no se enrutan | `@@unique([propertyId, code])` (existente) |

**Clave natural de línea con la etiqueta original.** `(centroCode, mes, grupo, departamento)` tiene 30 colisiones en OC (tres etiquetas van al mismo centro); `(centro, mes, grupo, departamento)` tiene 0 [V cálculo]. El parser fusiona filas idénticas sumando importes y empleados (con aviso) → nunca `P2002`.

**Migración** `packages/database/prisma/migrations/20260916120000_coste_personal_importado/migration.sql`: SQL de `prisma migrate diff --from-schema-datasource --to-schema-datamodel --script` **verbatim** bajo una cabecera al estilo `20260916100000` (nombre, lote, comando generador, «reviewed by hand», lista aditiva, pre-checks: 8 migraciones, drift 0, 266 tablas / 30 enums, 61 asientos Faranda, 0 `cost_centers`, 4 funciones / 4 triggers). Esperado: 3 `CREATE TABLE`, 1 `CREATE TYPE`, 2 `FOREIGN KEY`, índices incluido `journal_lines_cost_center_id_idx`; después `db:migrate:status` 9/9, `db:drift:check` «No difference detected.», `check-migrations-vs-schema` 269 tablas / 31 enums. Nada escrito a mano.

**Tipos wire** (`packages/shared/src/payroll-cost-types.ts`, reexportado desde `index.ts`; dinero como `MoneyString` `"1234.56"`): `PAYROLL_COST_GROUPS`, `PAYROLL_COST_GROUP_LABELS_ES`, `PayrollCostMapping`, `PayrollCostRowDto`, `PayrollCostCentreMonthDto`, `PayrollCostImportPreview`, `PayrollCostImportEntryDto`, `PayrollCostLineDto`, `PayrollCostReferenceDto`, `PayrollCostImportRecord`, `PayrollCostImportDetail`, `PayrollCostImportCreateResult`, `PayrollCostReportCell`, `PayrollCostReport`, `PAYROLL_COST_ERROR_CODES`. Además `"payroll_cost_import"` en `JOURNAL_SOURCE_TYPES` (`accounting-types.ts`) y en `financial-statements-types.ts` `UsaliAmountSource = UsaliMappingSource | "cost_center"` (**sin ampliar `UsaliMappingSource`**: rompería `buildCoverage` y `SOURCE_LABELS` del front), `UsaliAccountAmount.source: UsaliAmountSource`, `UsaliStatistics.headcount? / headcountSource?`, `UsaliRatios.laborPerEmployee?`.

---

## §3 · Contabilización

### 3.1 Regla contable (pura, `cost-import.posting.ts`)

Por celda (centro, mes) del plan se construye **un** `RuleEntry` con `signedLine` / `assertBalanced` de `posting-rules.ts` y las constantes ya existentes `SALARIES_ACCOUNT = "640"`, `EMPLOYER_SS_ACCOUNT = "642"`, `WAGES_PAYABLE_ACCOUNT = "465"`, `SOCIAL_SECURITY_ACCOUNT = "476"` [V posting-rules:65-77]:

| Campo | Valor |
|---|---|
| `sourceType` / `sourceId` | `payroll_cost_import` / `<importId>:<propertyId>:<periodCode>` (nunca el sufijo `#n` del puente: cada lote lleva un `importId` nuevo; el reverso usa `reversal:<id>`) |
| `entryDate` | último día del mes (`lastDayOfMonth`, UTC, bisiestos: `2028-02` → 29) |
| `description` / `reference` | «Coste de personal MM/AAAA · <Property.code o nombre> (importado)» / `periodCode` |
| Líneas | por departamento USALI ordenado por clave: D `640` bruto y D `642` SS empresa, ambas con `costCenterId` y descripción «Sueldos y salarios · <departamento>» / «Seguridad Social empresa · <departamento>»; después H `465` Σ bruto («Remuneraciones pendientes de pago · coste importado») y H `476` Σ SS empresa («Seguridad Social acreedora · coste importado») |
| Casos límite | `signedLine` devuelve `null` a 0 y cambia de lado un importe negativo (nunca una línea negativa); celda toda a 0 → sin asiento + aviso; plan sin celdas → 400 `PAYROLL_IMPORT_EMPTY` |

**Ejemplo sintético** (centro `HD`, febrero 2026; Habitaciones bruto 10.000,00 / SS 3.000,00; A&B bruto 5.000,00 / SS 1.500,00):

| Cuenta | Centro de coste | Debe | Haber |
|---|---|---:|---:|
| 640 Sueldos y salarios · Habitaciones | `HD/ROOMS` | 10.000,00 | |
| 640 Sueldos y salarios · Alimentos y bebidas | `HD/FNB` | 5.000,00 | |
| 642 Seguridad Social empresa · Habitaciones | `HD/ROOMS` | 3.000,00 | |
| 642 Seguridad Social empresa · Alimentos y bebidas | `HD/FNB` | 1.500,00 | |
| 465 Remuneraciones pendientes de pago | — | | 15.000,00 |
| 476 Seguridad Social acreedora | — | | 4.500,00 |
| **Total** (`entryDate` 2026-02-28, `sourceId` `imp_1:HD:2026-02`) | | **19.500,00** | **19.500,00** |

### 3.2 Transacción, locks y orden de guardas (`cost-import.service.ts`)

Una transacción interactiva propia `prisma.$transaction(async (tx) => …, { maxWait: 15_000, timeout: 180_000 })` (patrón `periods.service.ts:294-295`; el timeout de 60 s del motor solo aplica cuando abre la suya) que empieza con `SELECT pg_advisory_xact_lock(hashtext('payroll_cost_import:' || organizationId))`. Orden de locks constante (importación → numeración del motor) → sin interbloqueos.

Orden de guardas de `createPayrollCostImport` (cada una falla antes de escribir nada):

1. Permisos: `requireAnyPermission(PAYROLL_WRITE_KEYS)` → 403.
2. Parseo y filas → 400 `PAYROLL_IMPORT_INVALID { errors: [{ line, message }] }` (cabecera inválida, mes no `YYYY-MM`, importes no numéricos o negativos, empleados negativos).
3. Grupo → 400 `PAYROLL_IMPORT_GROUP_INVALID { labels }`; `organizationId` del JSON distinto de la organización → 400 `PAYROLL_IMPORT_ORGANIZATION_MISMATCH`.
4. Centros → 400 `PAYROLL_IMPORT_CENTRE_UNMAPPED { labels, rows }` (la preview no lanza: los devuelve en `unmappedCentres` con sugerencias). Departamentos → 400 `PAYROLL_IMPORT_DEPARTMENT_UNMAPPED { labels }`; departamento que no admite `labor` (`utilities`, `misc_income`, `management_fees`, `non_operating`, `below_ebitda`) → 400 `USALI_LINE_NOT_ADMITTED { department }`.
5. Tenencia y ámbito: `prisma.property.findMany({ where: { id: { in }, organizationId } })` + `assertFinanceReadScopeMany(context, propertyIds)` → 404 opaco `PROPERTY_NOT_FOUND` / `ENTITY_SCOPE_REQUIRED` (los `propertyId` del mapeo llegan anidados en el cuerpo y el hook global no los concede).
6. Dentro de la transacción: duplicado (`findFirst { organizationId, contentHash, status ≠ reversed }` → 409 `PAYROLL_IMPORT_DUPLICATE { importId, status, fileName, postedAt }`) y solape (`payrollCostLine.findMany { organizationId, import.status = posted, OR celdas }` → 409 `PAYROLL_IMPORT_OVERLAP { overlaps }`), salvo `replace: true` → `reverseImportInTx` de cada lote afectado **entero** (un draft duplicado pasa a `reversed` con motivo «sustituido por <id nuevo>») y `replacedImportIds`.
7. `payrollCostImport.create` (`draft` si `post = false`; `legalEntityId` de `resolveLedgerScope(context, {}, tx)`), `payrollCostLine.createMany`, `payrollCostReference.createMany` (una por (centro, mes); varias etiquetas del mismo centro → suma con aviso).
8. Si `post`: `postImportInTx` → `ensureUsaliCostCentres` (upsert `propertyId_code`), `buildPayrollCostEntries`, y por cada asiento `ledger().postJournalEntry({ …, db: tx })`; si `record.created === false` → 409 `PAYROLL_IMPORT_ENTRY_EXISTS` (defensivo). Update del lote (`posted`, `journalEntryIds`, `postedAt`, `headcountAverage`) y `payrollCostLine.updateMany` con `costCenterId`.
9. Fuera de la transacción: `recordAuditEvent` (`PAYROLL_COST_IMPORTED` / `PAYROLL_COST_IMPORT_POSTED` / `PAYROLL_COST_IMPORT_REVERSED`, `entityType payroll_cost_import`, before/after con hash, fichero, periodo, totales, asientos, `replacedImportIds`, mapeo).

Todo asiento lleva `propertyId`, así que el 400 `WORK_CENTER_REQUIRED` del motor (R4 de la Tanda 6b) es inalcanzable; el motor sí aplica 404 `PROPERTY_NOT_FOUND` y 409 `FISCAL_PERIOD_CLOSED` / `FISCAL_YEAR_CLOSED` (periodos cerrados), y en ese caso **todo** (lote, líneas, referencias, centros de coste, asientos) hace rollback: nada queda a medias.

### 3.3 Estados, reverso e idempotencia

- `draft` → `POST /:id/post` (misma transacción: lock, duplicado, solape, `postImportInTx`); `posted` → 409 `PAYROLL_IMPORT_ALREADY_POSTED`; `reversed` → 409 `PAYROLL_IMPORT_REVERSED`.
- **Reverso** (`reversePayrollCostImport({ importId, reason, entryDate? })`): motivo vacío → 400 `JOURNAL_REVERSAL_REASON_REQUIRED`; `reversed` → devuelve el lote (`alreadyReversed: true`, idempotente); `draft` → `reversed` sin asientos; `posted` → por cada `journalEntryId`: si ya tiene `reversedById` se reutiliza, si `status ≠ posted` se salta, si no `ledger().reverseJournalEntry({ entryDate: input.entryDate ?? entry.entryDate, description "Reverso coste de personal <mes> · <centro> — <motivo>", reference periodCode, db: tx })` (conserva `costCenterId` [V accounting.service:767]). Solo se reversan asientos cuyos ids están en `journalEntryIds` del lote: los 61 asientos previos de Faranda no se tocan nunca.
- Mes cerrado a posteriori → 409 `FISCAL_PERIOD_CLOSED` / `FISCAL_YEAR_CLOSED` AUNQUE el cuerpo traiga una `entryDate` abierta (corrector 6c · contable-6C-02, `assertOriginalPeriodOpen`): la regla de lectura de los estados excluye la pareja marcada entera, así que un reverso fechado fuera alteraría el periodo cerrado; el camino es reabrir el periodo (runbook §18.5). `entryDate` solo mueve el reverso entre periodos abiertos.
- `replace` exige `post: true` (400, contable-6C-01) y solo revierte lotes cuyos centros están TODOS en el ámbito R11 del usuario (404 opaco, SEC-6C-01); la preview y los 409 enmascaran fichero y fecha de los lotes fuera de ámbito (SEC-6C-04). Topes por lote: ≤ 24 meses, ≤ 240 celdas, ≤ 5.000 filas (SEC-6C-03); topes por valor en el parser (SEC-6C-02).
- Re-importación tras reverso: el hash queda libre y el `importId` es nuevo → `sourceId` nuevos. `replace` reversa lotes **enteros**: importar un rango parcial que solapa con un lote mayor elimina los meses no re-importados → la preview lista los lotes afectados con su rango; regla: **reimportar siempre el rango completo**.

### 3.4 Simplificaciones documentadas

| Simplificación | Consecuencia | Dónde se registra |
|---|---|---|
| Devengo del coste empresa: bruto y SS empresa; **sin IRPF ni SS del trabajador** (no hay 4751 ni desglose de 476 por trabajador/empresa) | 465 recoge el bruto (no el líquido); el pago real (D 465 / H 572) y el pago a la TGSS (D 476 / H 572) se registran aparte por tesorería; el Modelo 111 no se alimenta de estos asientos | §10, runbook §18.4 |
| Sin IVA | Ninguna cuenta 47x de IVA → Modelo 303 invariante | runbook §18.10 |
| `coste_total` informativo | Se avisa si difiere de bruto + SS; nunca bloquea; se conserva en `reportedTotalCost` | §1.7, §10 |
| Un asiento por (centro, mes), no por grupo | El grupo (`operaciones`, `familia`…) vive en las líneas del lote y en el informe, no en el diario; el diario distingue por centro de coste (departamento) | §4 |
| Un lote por ejercicio como máximo | Transacción larga bajo dos locks (48 asientos + upserts + `createMany`); `timeout` 180 s | §10 riesgos |

---

## §4 · USALI por centro de coste y headcount

**Lector** (`source.ts accountBalances({ byCostCentre: true })`): dos SQL. Sin el flag, la actual **byte-idéntica** (balance, PyG, ECPN, memoria, PyG por centro y gestoría indexan por código y se romperían con filas partidas). Con el flag, `LEFT JOIN cost_centers cc ON cc.id = jl.cost_center_id`, `cc.type, cc.code` en `SELECT` y `GROUP BY` (**por `(type, code)`, nunca por `id`**: el consolidado funde RA/ROOMS y LT/ROOMS), `ORDER BY a.code, cost_centre_code NULLS FIRST`; `costCentre` solo cuando ambos no son nulos; la partición suma exactamente el total de la cuenta.

**Enrutado** (`usali.service.ts routeByCostCentre(row, resolved)`, tras `resolveUsaliForCode`): si `row.costCentre.type === "usali"`, `code.toLowerCase()` ∈ `USALI_DEPARTMENTS`, `resolved.usaliLine ∈ { labor, other_expense }` e `isAdmittedUsali(dept, line)` [V usali-mapping:50-54] → departamento del centro de coste con `source: "cost_center"` (si coincide con el resuelto se conserva la fuente original); en cualquier otro caso devuelve `resolved`. `revenue`, `cost_of_sales`, honorarios, no operativos y bajo EBITDA **nunca se mueven**; `utilities.labor` no está admitida → no se mueve; centros `operating` / `cost` se ignoran.

**Invariantes por construcción:** `pgcRevenue` / `pgcExpense` se acumulan antes del enrutado → `reconciliation`, GOP, EBITDA y resultado no cambian con o sin flag (solo cambia el reparto entre departamentos de la línea `labor`). `accountsByDepartment` se funde por `code|line` para no duplicar filas en el drawer; `mergeRows` usa la clave `code|cc.type|cc.code` conservando `costCentre`. `byCostCentre: true` en las cuatro llamadas que alimentan `computeUsaliPnl` (`buildUsaliPnl`, `compareUsaliProperties` ×3). No se tocan `corporateUsaliBases`, `pnl-by-property`, `allocation`, `annual-accounts`, `usali-mapping.service` ni `statement-render`.

**Advertencia de alcance:** el enrutado afecta a **cualquier** apunte con `cost_center_id` de tipo `usali` — nóminas reales cuyo contrato tenga centro de coste, asientos manuales —. Es la capacidad buscada (un solo origen de verdad del departamento) y se avisa en runbook §4 paso 0 y §18.6.

**Headcount** (sin método nuevo en `FinancialStatementsSource`; `MemorySource` conserva su contrato): `headcountByProperty` → recibos de nómina como hoy (`source: "payroll_slips"`); si no hay, lotes `posted` → `PayrollCostReference.employeesReported` por (centro, mes) y, en su defecto, Σ `PayrollCostLine.headcount` de la celda; media de los meses **con dato** (2 decimales, `averageMonthlyHeadcount`); `source: "payroll_cost_import"`. `headcount()` → `Math.round(Σ medias)`; sin datos → `null` (**nunca 0**: contrato de la memoria y del aviso de reparto). Motivo de la prioridad: Σ empleados por celda sobrecuenta a quien figura en dos grupos (AS 2026-08: 25 por celdas frente a 16 en el informe) [V cálculo]. Salida: `statistics.headcount / headcountSource`, `ratios.laborPerEmployee = Σ labor / headcount` (`null` si headcount nulo o 0). Beneficio colateral: `pnl-by-property` y `allocation` obtienen headcount importado para Faranda.

---

## §5 · API

Fichero `apps/api/src/modules/payroll/cost-import.routes.ts` (`registerPayrollCostRoutes(app)`, rutas solo con literal de cadena) y partial **`route-permissions.partial.ts`** (nombre exacto que lee `rbac-nav-contract`; una entrada por línea `{ method, path, permissions, riskLevel }`). Registro en `security/route-permissions.ts` (`...payrollRoutePermissions,` en línea propia) y `server.ts` (`registerPayrollCostRoutes(app)` tras `registerStructureRoutes`). Esquemas zod en `apps/api/src/schemas/payroll-cost.schemas.ts` (`.strict` con mensaje en español; `STRICT_BODY` redeclarado porque `payroll-commissions.schemas.ts` no lo exporta [V]).

| Método y ruta | Clave (riesgo) | Cuerpo / query | Respuesta |
|---|---|---|---|
| `POST /payroll/cost-imports/preview` | `payroll.manage` (medium) | `{ organizationId?, format: "csv" \| "json", content ≤ 1.000.000 caracteres, mapping?: PayrollCostMapping, replace? }` | 200 `PayrollCostImportPreview` (nunca escribe; `unmappedCentres[].suggestions`; `canPost = sin errores ∧ sin pendientes ∧ (¬duplicateOf ∧ overlaps vacíos ∨ replace)`) |
| `POST /payroll/cost-imports` | `payroll.manage` (high) | preview + `{ fileName? ≤ 200, source?: csv \| json \| informe_rrhh, post? (default true), notes? ≤ 2000 }` | 201 `PayrollCostImportCreateResult` (`entries`, `replacedImportIds`) |
| `GET /payroll/cost-imports` | `payroll.read` (medium) | `{ organizationId?, status?, from?, to? (solape con periodFrom/periodTo), limit? 1..200 }` | 200 `PayrollCostImportRecord[]` (`createdAt` desc; solo lotes cuyos centros estén **todos** en ámbito; sin líneas) |
| `GET /payroll/cost-imports/:id` | `payroll.read` (medium) | `assertEntityAccess(request, { entity: "payrollCostImport", id })` (resolver nuevo en `lib/tenancy.ts` tras `payrollPeriod`) | 200 `PayrollCostImportDetail` (líneas, referencias, asientos y reversos con número, ejercicio, estado, `totalDebit`) |
| `POST /payroll/cost-imports/:id/post` | `payroll.manage` (high) | `{ replace? }` | 200 `PayrollCostImportCreateResult` |
| `POST /payroll/cost-imports/:id/reverse` | `payroll.manage` (critical, espejo de `/payroll/periods/:id/pay`) | `{ reason 3..500, entryDate?: YYYY-MM-DD }` | 200 `PayrollCostImportRecord` (idempotente) |
| `GET /payroll/cost-report` | `payroll.read` (medium; **nunca** `accounting.read` ni `analytics.read`: invariantes `finance-report-keys` / `route-read-keys`) | `{ from, to (YYYY-MM, to ≥ from, ≤ 24 meses), propertyId?, group? }`; `assertFinanceReadScope(context, propertyId ?? null)` antes del servicio | 200 `PayrollCostReport` |

**Permisos en el servicio:** `PAYROLL_READ_KEYS = ["payroll.read", "payroll.manage", "accounting.journal.post"]` (nuevo en `treasury/permissions.ts`); escrituras `requireAnyPermission(PAYROLL_WRITE_KEYS)`. El manifiesto es «todas las claves», por eso la ruta pide **solo** `payroll.manage`: con `["payroll.manage", "accounting.journal.post"]` Dirección recibiría 403 [V rbac-nav:461]. Las rutas high/critical rechazan el fallback demo sin token.

**Ámbito (R11):** un lote es visible/actuable cuando todos los `propertyId` que toca están en el ámbito (`assertFinanceReadScopeMany`); el listado filtra con `propertyWithinScope`; `cost-report` sin `propertyId` = toda la sociedad → `accounting.entity.read` o contexto sin asignaciones, si no 404 `ENTITY_SCOPE_REQUIRED` (patrón `financial-statements.routes.ts:118-123`).

**Informe** (`cost-report.service.ts buildPayrollCostReport` + función pura `aggregatePayrollCostReport`): líneas de lotes `posted`, referencias (el último `postedAt` gana), ventas netas del libro por centro × mes con una sola `$queryRaw` sobre cuentas `70%` (misma regla de exclusión que `LEDGER_ENTRY_COUNTS_SQL` / `ledgerWhere`: sin borradores, sin reversados ni reversos, sin regularización/cierre/apertura), inventario `room.count({ propertyId, active: true })`. Derivados por celda: `headcount = employeesReported ?? headcountLines` (con `headcountSource`), `costPerEmployee`, `roomsAvailable = (roomsInventoryReported ?? roomsInventory) × daysInMonth`, `costPerAvailableRoom`, `laborPctLedger = totalCost / ledgerNetSales`, `laborPctReference = totalCost / netSalesReported`, `byGroup`, `byDepartment`; `group` filtra solo las líneas de coste (ventas y referencia no); `null` con denominador 0. `totals` de sociedad añaden `headcountAverage` y `costPerEmployeeAverage`.

### 5.1 Códigos de error

| Código | Status | `details` | Cuándo |
|---|---|---|---|
| `VALIDATION_ERROR` | 400 | issues zod (español) | clave desconocida, formato inválido, rango > 24 meses, motivo corto |
| `PAYROLL_IMPORT_INVALID` | 400 | `{ errors: [{ line, message }] }` | cabecera, mes, importes negativos o no numéricos |
| `PAYROLL_IMPORT_EMPTY` | 400 | — | sin líneas de coste (o todas a 0) |
| `PAYROLL_IMPORT_GROUP_INVALID` | 400 | `{ labels }` | grupo fuera de los 5 canónicos y sin mapeo |
| `PAYROLL_IMPORT_ORGANIZATION_MISMATCH` | 400 | — | `organizationId` del JSON ≠ organización |
| `PAYROLL_IMPORT_CENTRE_UNMAPPED` | 400 | `{ labels, rows }` | etiqueta de centro sin `Property` |
| `PAYROLL_IMPORT_DEPARTMENT_UNMAPPED` | 400 | `{ labels }` | etiqueta de departamento sin USALI |
| `USALI_LINE_NOT_ADMITTED` | 400 | `{ department }` | departamento que no admite `labor` |
| `PROPERTY_NOT_FOUND` / `ENTITY_SCOPE_REQUIRED` | 404 (opaco) | — | centro de otra organización o fuera de ámbito |
| `PAYROLL_IMPORT_NOT_FOUND` | 404 (opaco) | — | lote inexistente o de otra organización (`GET /payroll/cost-imports/:id`, `post`, `reverse`) |
| `PAYROLL_IMPORT_DUPLICATE` | 409 | `{ importId, status, fileName, postedAt }` | mismo hash vivo sin `replace` |
| `PAYROLL_IMPORT_OVERLAP` | 409 | `{ overlaps: [{ importId, fileName, periodFrom, periodTo, propertyId, periodCode }] }` | celda ya contabilizada sin `replace` |
| `PAYROLL_IMPORT_ALREADY_POSTED` / `PAYROLL_IMPORT_REVERSED` | 409 | — | `post` sobre un lote no `draft` |
| `PAYROLL_IMPORT_ENTRY_EXISTS` | 409 | `{ sourceId }` | el puente devolvió `created: false` (defensivo) |
| `JOURNAL_REVERSAL_REASON_REQUIRED` | 400 | — | reverso sin motivo |
| `FISCAL_PERIOD_CLOSED` / `FISCAL_YEAR_CLOSED` | 409 | del motor | mes o ejercicio cerrado (rollback completo) |

---

## §6 · Formato de importación (CSV y JSON)

**CSV** (cabecera obligatoria; nombres de columna sin mayúsculas ni acentos; separador `;`, o `,` si no hay `;`; decimales con coma o punto y miles opcionales «1.234,56»; mes `YYYY-MM` o `MM/YYYY`; BOM y latin1 admitidos —el CLI decodifica; en HTTP el navegador entrega texto UTF-8—; columnas desconocidas → aviso; fila con error → `errors` con nº de línea 1-based):

```
centro;mes;grupo;departamento;salario_bruto;coste_ss;coste_total;empleados[;ventas_sin_iva;hab_disponibles;usali]
```

Ejemplo sintético (dos centros, un mes; las tres columnas opcionales alimentan `PayrollCostReference` por (centro, mes) y `usali` fija el departamento sin diccionario):

```
centro;mes;grupo;departamento;salario_bruto;coste_ss;coste_total;empleados;ventas_sin_iva;hab_disponibles;usali
HOTEL DEMO;2026-02;operaciones;3 RECEPCIO;6.000,00;1.800,00;7.800,00;3;42.000,00;40;rooms
HOTEL DEMO;2026-02;operaciones;6 PISOS;4.000,00;1.200,00;5.200,00;4;42.000,00;40;rooms
HOTEL DEMO;2026-02;operaciones;5 COCINA;5.000,00;1.500,00;6.500,00;2;42.000,00;40;fnb
OFICINA DEMO;02/2026;estructura;ADMINISTRACION;3.500,00;1.050,00;4.550,00;2;;;admin_general
```

Produce el asiento de §3.1 para `HD` (Habitaciones 10.000 / 3.000; A&B 5.000 / 1.500) y otro para la oficina (640 3.500 · 642 1.050 con centro de coste `ADMIN_GENERAL`).

**JSON**: el del agregado de Faranda (`lineas[]`, `referencia[]`, `mapping.centros/grupos`, `organizationId`, `fuente`) o `{ rows: PayrollCostRowDto[] }`. Ejemplo sintético:

```json
{
  "fuente": "Informe RRHH (agregado fuera del ERP)",
  "organizationId": "org_demo",
  "periodo": { "desde": "2026-02", "hasta": "2026-02" },
  "mapping": { "centros": { "HOTEL DEMO": "HD", "OFICINA DEMO": "OC" }, "grupos": { "mant-obra": "mantenimiento_obra" } },
  "lineas": [
    { "centro": "HOTEL DEMO", "centroCode": "HD", "mes": "2026-02", "grupo": "operaciones", "departamento": "3 RECEPCIO",
      "usaliDepartment": "rooms", "salarioBruto": 6000, "costeSs": 1800, "costeTotal": 7800, "empleados": 3 }
  ],
  "referencia": [
    { "centroCode": "HD", "mes": "2026-02", "empleadosInforme": 9, "habitacionesDisponibles": 40, "ventasSinIva": 42000 }
  ]
}
```

**Normalización y hash:** etiquetas `trim` + espacios colapsados + mayúsculas (acentos conservados); importes a 2 decimales; filas con la misma clave se fusionan sumando (aviso «filas N y M fusionadas»); `contentHash` = sha256 del JSON canónico de filas + referencias ordenadas por `(workCenterLabel, periodCode, costGroup, departmentLabel)` → el mismo CSV y JSON equivalentes dan el mismo hash, independiente de formato, espacios y BOM.

**Mapeo (`applyPayrollCostMapping`, puro), por orden de prioridad:**

| Dimensión | 1º | 2º | 3º | Sin mapear |
|---|---|---|---|---|
| Centro | `mapping.centres[label]` → `propertyId` | `centroCode` del fichero ≡ `Property.code` | etiqueta ≡ `code` / `name` / `tradeName` normalizados | preview: `unmappedCentres` con `suggestions`; create: 400 |
| Departamento | `mapping.departments[label]` | `usali` / `usaliDepartment` del fichero | diccionario: `RECEP*` / `PISOS` / `SIN DEPARTAMENTO` → `rooms`; `CAF*` / `REST*` / `COCINA` → `fnb`; `MANTENIM*` → `pom`; `DIRECCI*` / `ADMINISTRACION` / `PROPIEDAD` → `admin_general`; `COMERCIAL` → `sales_marketing` | `unmappedDepartments`; create: 400 |
| Grupo | `mapping.groups[label]` | `mapping.grupos` del JSON (`mant-obra` → `mantenimiento_obra`) | valor canónico | 400 `PAYROLL_IMPORT_GROUP_INVALID` |

---

## §7 · CLI

`apps/api/src/scripts/import-payroll-cost.ts` (estilo `migrate-faranda-celuisma.ts`: `parseFlags`, `USAGE`, `assertConfirmMatches`, exit 2 uso · 1 fallo · 0 ok), script npm `payroll:import-cost`:

```
cd apps/api && node --env-file-if-exists=../../.env --import tsx src/scripts/import-payroll-cost.ts \
  --file <json|csv> --organization <organizationId> [--dry-run | --apply --confirm <organizationId>] [--replace] [--json] [--help]
# equivalente: corepack pnpm --filter @hotelos/api payroll:import-cost -- --file … --organization …
```

- Lectura: `Buffer` → `TextDecoder("utf-8", { fatal: true })`, si falla `latin1`; quita BOM; formato por extensión o primer carácter `{` / `[`.
- Contexto de sistema: `userId usr_system_payroll_cost_import`, `deviceId cli:import-payroll-cost`, permisos `payroll.manage`, `payroll.read`, `accounting.journal.post`, `accounting.read`, `accounting.entity.read`, sin `assignedPropertyIds` (ámbito de toda la sociedad); `createdBy "cli:import-payroll-cost"`, `correlationId "corr_payroll_cost_import"`, `source informe_rrhh` cuando el JSON trae `fuente`.
- **Dry-run (defecto)**: cabecera (organización, sociedad vía `resolveLedgerScope`, fichero, hash, periodo), tabla centro × mes (código, mes, líneas, bruto, SS, total, empleados, empleados del informe), totales por grupo, avisos (discrepancias de `coste_total` con nº de línea), etiquetas sin mapear, `duplicateOf` / `overlaps` / `payrollPeriodsPosted`, `canPost` y «Nada escrito»; exit 1 si hay errores, centros sin mapear o duplicado/solape sin `--replace`.
- **`--apply --confirm <orgId>`**: `hydrateAuditChainFromPostgres`, `createPayrollCostImport` (audita), `flushAuditQueues` + `flushAccountingProjection` + `flushExtraProjections` antes de `$disconnect`; imprime `importId`, nº de asientos, primer/último número y ejercicio, totales 640/642/465/476, `reportedTotalCost` y diferencia, `replacedImportIds`; `--json` vuelca el resultado; 409 duplicado/solape sin `--replace` → mensaje con `importId` y exit 1.
- Dry-run esperado sobre Faranda: 363 filas, 48 pares centro × mes (OC agrega tres etiquetas), 40 referencias, 0 sin mapear, 1 aviso de `coste_total` (RA · 2026-04 · extras · «4 CAF/REST», −531,92), bruto 1.891.222,19 · SS 551.336,97 · total 2.442.559,16 (informe 2.442.027,24), `canPost`, exit 0. **Nunca `--replace` sobre Faranda** (dejaría 48 reversos + 48 asientos nuevos).

---

## §8 · Front (Cocoa 22)

Restricciones verificadas: **cero** `style={` nuevos bajo `screens/` (techo global 801 = total vivo; `PayrollScreen` ≤ 9); ningún `.tsx` nuevo bajo `screens/` salvo `PayrollCostImportDrawer.tsx` (un `PayrollCostTab.tsx` fallaría la regla 7); sin `.bo-*`, `<table>`, `<button>`, `<input>` crudos, colores literales, emojis ni inglés; `fetch(` solo en `api-client`; `CocoaTable` / `CocoaPage` / `CocoaSegmentedControl` no se tocan (tanda C).

| Pieza | Diseño |
|---|---|
| **Pestaña «Coste de personal»** (`PayrollScreen.tsx`, `view "cost"`) | `CocoaKpiStrip` (coste total del rango · coste por empleado · personal s/ ventas con `deltaLabel` «s/ ventas del libro» · empleados medios; `degraded={!report}`); fila de controles `cocoa-row` con dos `CocoaSelect size="small" inline` «Desde» / «Hasta» (`monthOptions`), `CocoaSelect` «Grupo» (6 valores: Todos + 5 grupos; no `SegmentedControl`, pensado para ≤ 4), `CocoaButton` «Importar informe» (deshabilitado sin `payroll.manage` + `cocoa-note` explicativa) y refrescar; el centro viene del `FinanceScopeSelector` existente (sin centro = toda la sociedad) |
| **Matriz centros × meses** (`CocoaSection` + `CocoaTable<MetricRow>`) | Columnas dinámicas (etiqueta + un mes por columna + Total, patrón `UsaliScreen`); por centro filas «Empleados» / «Coste» / «Coste por empleado» / «% s/ ventas»; expandir centro con `CocoaButton variant="plain" aria-expanded aria-controls` (Set en estado; `CocoaTable` no tiene filas expandibles) → filas «· <departamento USALI>»; última fila «Sociedad»; celdas ya derivadas en servidor, el front solo formatea (`payroll-cost-helpers.ts`, puro) |
| **Gráficos** | `CocoaGrid columns={12}` + 2 × `CocoaSpan cols={6} min={320}` con `CocoaChart.Bars` monoserie: «Coste de personal por mes» y «Ventas netas por mes (libro o referencia)» (ventas = libro si > 0, si no referencia; `salesSource` en `hint`) |
| **Drawer de importación** (`PayrollCostImportDrawer.tsx`, `CocoaDrawer side="right" size="lg"`) | 1 · Fichero o texto: `CocoaFileInput accept=".csv,.json" maxBytes={1_000_000}` + `CocoaInput multiline` «…o pega aquí el CSV / JSON» + `cocoa-note` con el formato + «Previsualizar». 2 · Mapeo (solo si hay pendientes): `CocoaSelect` por etiqueta de centro (`centreSelectOptions(finance.structure, finance.active)`) y por departamento (`USALI_LABOR_DEPARTMENT_LABELS`); cambiar re-previsualiza. 3 · Vista previa: badges Filas / Centros × meses / Errores / Avisos, `CocoaStat` bruto / SS / total / empleados medios, tabla `byCentreMonth`, errores en `CocoaCallout tone="danger"`, avisos en lista, `CocoaCallout tone="warning"` para duplicado / solapes (lista los lotes que se revertirían **enteros** con su rango) / periodos de nómina real contabilizados + `CocoaSwitch` «Sustituir los lotes anteriores (reverso + lote nuevo)». Pie: cancelar + «Contabilizar» (`disabled={!preview?.canPost}`) → resultado `CocoaCallout tone="success"` «N asientos contabilizados (nº X–Y, ejercicio Z)» + lista de asientos («2026/62 · RA · ene 2026 · 45.123,00 €») |
| **Lista de importaciones** (`CocoaSection` «Importaciones») | `CocoaTable` (fecha, fichero/origen, periodo, filas, coste total, estado `CocoaBadge` Borrador/Contabilizado/Revertido, asientos) con `rowActions` «Contabilizar» (draft) y «Revertir» (posted, destructive) solo con `payroll.manage`; `CocoaDialog tone="destructive"` «Revertir la importación» con motivo obligatorio → toast + refresco |
| **USALI** (`UsaliScreen.tsx`, mínimo) | En el drawer de cuentas por departamento, `CocoaBadge tone="info"` «Centro de coste» cuando `account.source === "cost_center"`; `SOURCE_LABELS` sin cambios |
| **Servicios** | `services/payrollApi.ts` (7 funciones), `finance-contracts.ts` (mensajes en español por código, §5.1), `accounting-ui.ts` (`payroll_cost_import: "Coste de personal importado"` en `SOURCE_TYPE_LABELS`) |

---

## §9 · Lotes

Ficheros **exclusivos** por lote; todos los tipos wire y los cambios de `packages/shared` van en L0 para que L1, L2 y L4 corran en paralelo sin tocar el mismo fichero. Orden: **L0 → {L1 ∥ L2 ∥ L4} → L3 (tras L1) → L5 (tras L1-L3) → L6**.

| Lote | Ficheros exclusivos | Tests y puertas |
|---|---|---|
| **L0 · Schema + migración + tipos** | `packages/database/prisma/schema.prisma`; `packages/database/prisma/migrations/20260916120000_coste_personal_importado/migration.sql`; `packages/shared/src/{payroll-cost-types.ts (nuevo), index.ts, accounting-types.ts, financial-statements-types.ts}` | `prisma validate`; `db:migrate:status` 9/9; `db:drift:check` «No difference detected.»; `check-migrations-vs-schema` 269 tablas / 31 enums; `tests/{migrations-squash-contract,finanzas-schema-contract,backoffice-contract}.test.mjs`; typecheck de shared, database, api y admin-web |
| **L1 · Parser + regla + servicio + informe** | `apps/api/src/modules/payroll/{cost-import.parser,cost-import.posting,cost-import.service,cost-report.service}.ts`; `apps/api/src/modules/treasury/permissions.ts` (`PAYROLL_READ_KEYS`); `apps/api/src/modules/payroll/__tests__/{cost-import-parser,cost-import-posting,cost-report}.test.mts`; `tests/integration/payroll-cost-import.test.mts` | `corepack pnpm --filter @hotelos/api typecheck` y `test` (1.511 previos + 3 suites sin BD); integración con org aislada `org_pc_<run>` (preview → unmapped; create 400/201; sourceId y fecha; cost centres `usali`; Σ640+Σ642 = Σ465+Σ476; DUPLICATE; OVERLAP; replace; draft → post; reverse idempotente; 404 de tenencia y ámbito; periodo cerrado → 409 y rollback; informe con venta manual 705.1); `tests/{legal-identity-readers-contract,estructura-integrador-fix-contract,finanzas-schema-contract}.test.mjs` |
| **L2 · USALI por centro de coste + headcount** | `apps/api/src/modules/financial-statements/{source.ts, usali.service.ts}`; `apps/api/src/modules/financial-statements/__tests__/{memory-source.mts, usali-cost-centre.test.mts}`; `tests/integration/usali-cost-centre.test.mts` | 73 tests previos de `financial-statements/__tests__` intactos + nuevos (rooms.labor 1300 / admin_general.labor 800 con cifras sintéticas; GOP/EBITDA/reconciliation idénticos con y sin flag; `averageMonthlyHeadcount` 10 y 12 → 11); integración `org_ucc_<run>` + `financial-statements`, `financial-statements-reversals`, `structure-l5`, `structure-e2e` sin cambios de cifras; typecheck api |
| **L3 · Rutas + partial + esquemas + tenencia + CLI + api-contracts** | `apps/api/src/modules/payroll/{cost-import.routes.ts, route-permissions.partial.ts}`; `apps/api/src/security/route-permissions.ts`; `apps/api/src/server.ts`; `apps/api/src/lib/tenancy.ts`; `apps/api/src/schemas/payroll-cost.schemas.ts`; `apps/api/src/modules/payroll/__tests__/cost-import-schemas.test.mts`; `apps/api/src/scripts/import-payroll-cost.ts` + `__tests__/import-payroll-cost.test.mts`; `apps/api/package.json`; `docs/api-contracts.md`; `tests/integration/payroll-cost-routes.test.mts` | typecheck y unit api (incl. `route-read-keys`, `finance-report-keys`); `tests/{api-route-permissions-contract,rbac-nav-contract,legal-structure-contract,legal-identity-readers-contract,finanzas-schema-contract}.test.mjs`; integración de rutas con `app.inject` (preview 200 con `unmappedCentres`; clave extra → 400; cost-report 3 meses; 404 opacos; 401 sin token; rango > 24 → 400); dry-run del CLI sobre Faranda con las cifras de §7 |
| **L4 · Front** | `apps/admin-web/src/screens/payroll/{PayrollScreen.tsx, PayrollCostImportDrawer.tsx, payroll-cost-helpers.ts}`; `apps/admin-web/src/screens/payroll/__tests__/{payroll-cost-helpers, payroll-cost-screen-contract}.test.mts`; `apps/admin-web/src/services/{payrollApi.ts, finance-contracts.ts, __tests__/finance-api-surface.test.mts}`; `apps/admin-web/src/screens/finance/UsaliScreen.tsx`; `apps/admin-web/src/screens/accounting/accounting-ui.ts` | typecheck admin-web; los 90 ficheros `__tests__/*.test.mts` + 2 nuevos (incl. `finance-api-surface`, `finance-scope-usage`, `configure-gate`); `tests/{admin-web-spanish-copy-contract, admin-web-no-raw-fetch, cocoa-22-contract}.test.mjs` (reglas 1-14 verdes; la 15 queda roja por construcción hasta que el integrador regenere el inventario: `inlineStyles` 801/801); `node scripts/check-discoverability.mjs` |
| **L5 · Docs** | `docs/runbooks/finanzas-contabilidad.md` (§1.1, §1.8, §3, §4 paso 0, §8, §13 «118 + 9 + 7 = 134», §14, nueva §18); `docs/design/FINANZAS-COSTE-PERSONAL.md` (este documento) | `tests/{finanzas-schema-contract, legal-structure-contract, legal-identity-readers-contract, api-route-permissions-contract}.test.mjs`; `grep -c payroll_cost_import` runbook ≥ 3; `## 4. USALI` y `## 1. Contrato de datos` literales |
| **L6 · Carga Faranda + auditoría** | `docs/audits/TANDA-6C-COSTE-PERSONAL-2026-09-16.md` | Puertas completas en verde antes del apply (typecheck-all 15/15, contratos, unit api y front, integración completa, discoverability); dry-run → apply **una vez**; SQL: 1 lote posted (363 filas, 40 referencias, 48 asientos 62..109, ejercicio 2026, último día de mes, 6 centros), 21 `cost_centers` `usali` (AS 4 · LT 3 · MC 4 · OC 4 · PG 3 · RA 3), 640 D 1.891.222,19 · 642 D 551.336,97 · 465 H 1.891.222,19 · 476 H 551.336,97, 0 líneas 640/642 sin centro de coste, 61 asientos previos intactos, 25 facturas, 33 envíos VeriFactu, 0 `payroll_periods`, 0 líneas nuevas en 47x de IVA; segundo apply → `PAYROLL_IMPORT_DUPLICATE` sin escrituras; `db:drift:check` y `db:migrate:status` tras el apply |

---

## §10 · Riesgos y decisiones abiertas para César

### 10.1 Decisiones que solo César puede tomar

| # | Decisión | Estado actual (por defecto en esta tanda) | Efecto si cambia |
|---|---|---|---|
| 1 | **OFICINA MADRID y REG. CORUÑA como centros propios.** Hoy no existen en el ERP y se asignan a OC (Oficina central) conservando la etiqueta original en `workCenterLabel` [V notas del agregado] | Un asiento de OC por mes suma las tres etiquetas; el informe y el desglose por etiqueta siguen disponibles en las líneas del lote | Alta de dos `Property kind=office` (o `other`) con `code` (p. ej. `OM`, `RC`) desde Estructura societaria; re-importación con `replace: true` del rango completo → asientos separados por centro y USALI «corporativo» desglosado |
| 2 | **Grupo `familia` (PROPIEDAD, administradores).** Va a 640/642 como el resto (departamento `admin_general`) | 428.392,39 € en ocho meses dentro de A&G · labor; no aparece en la hoja resumen «2026» del informe pero es coste real [V notas] | Si son retribuciones de administradores, el PGC las presenta también en 640 (con nota en la memoria); si César quiere separarlas, basta un mapeo `groups` a otro departamento admitido o una cuenta distinta en una tanda posterior; ningún cambio de modelo |
| 3 | **Cuentas 640.x / 642.x por departamento** en lugar de 640/642 genéricas + centro de coste | Descartado (§1.1): el departamento vive en `CostCenter`, un solo origen de verdad que también sirve a nóminas reales y manuales | Si la gestoría exige subcuentas en el balance de sumas y saldos, se añade un mapeo cuenta ← (640, centro de coste) en la exportación a gestoría sin tocar los asientos |
| 4 | **Pago y retenciones.** El asiento devenga bruto + SS empresa; 465 queda por el bruto y 476 por la SS empresa; sin 4751 (IRPF) ni SS del trabajador | El Modelo 111 no se alimenta de estos asientos; los pagos reales (nómina líquida, TGSS, AEAT) se registran por tesorería contra 465/476 cuando lleguen los extractos | Si César quiere el líquido y el 111 desde el ERP, hace falta importar además IRPF retenido y SS del trabajador por celda (dos columnas más) y una regla D 465 / H 4751 · H 476: extensión aditiva del formato, misma tabla de líneas |
| 5 | **Fila RA · 2026-04 · extras · «4 CAF/REST»**: `coste_total` 1.047,75 frente a bruto + SS 1.579,67 (−531,92) [V cálculo] | Se contabiliza 1.579,67 (bruto + SS); el 2.442.027,24 del informe se guarda como `reportedTotalCost`; el CLI y la preview lo avisan | Si el Excel tiene razón, corregir el agregado y re-importar con `replace`; si es un error del Excel, nada que hacer |
| 6 | **Reparto por persona en el futuro** (recibos de nómina en el ERP) | Fuera de alcance: el ERP guarda solo agregados (GDPR) | Cuando exista nómina real para un centro y mes, la preview avisa (`payrollPeriodsPosted`) para no devengar dos veces; la nómina real ya propaga `costCenterId` y entra en el mismo enrutado USALI |
| 7 | **Ventas del libro** (grupo 70 por centro y mes) solo existen desde julio 2026 en Faranda | `laborPctLedger` nulo de enero a junio; el informe y los gráficos caen a las ventas de referencia del informe (`salesSource` explícito) | Cargar la facturación histórica o aceptar la referencia como cifra de gestión |

### 10.2 Riesgos técnicos

| Riesgo | Mitigación |
|---|---|
| Σ `empleados` por celda sobrecuenta a quien figura en dos grupos (AS 2026-01: 12 vs 10; AS 2026-08: 25 vs 16) | Coste por empleado y headcount USALI priman `employeesReported` de la referencia; `headcountSource` explícito; caption del KPI y runbook §18.12 |
| Permisos: `["payroll.manage", "accounting.journal.post"]` en el partial daría 403 a Dirección | Ruta solo `payroll.manage`; servicio `requireAnyPermission`; partial con nombre y forma exactos; el informe con `payroll.read` |
| Ámbito R11 con `propertyId` anidados en el mapeo (el hook global no los concede) | Servicio: tenencia por organización + `assertFinanceReadScopeMany`; lotes visibles solo con todos los centros en ámbito; test de integración con `assignedPropertyIds` |
| API :3000 con cliente Prisma antiguo hasta el reinicio del orquestador | CLI y tests de integración usan su propio proceso; comprobaciones HTTP y UI condicionadas al reinicio; rutas high/critical exigen token |
| Transacción larga bajo dos advisory locks | `timeout` 180 s; un lote por ejercicio; rollback completo ante cualquier fallo |
| `created: false` silencioso del puente | El servicio lo comprueba y falla el lote (409 `PAYROLL_IMPORT_ENTRY_EXISTS`); imposible en la práctica por el `importId` nuevo |
| `replace` reversa lotes enteros | La preview lista los lotes afectados con su rango; regla «reimportar el rango completo» en UI y runbook |
| Reverso de un mes cerrado a posteriori | El servicio exige el periodo del asiento ORIGINAL abierto aunque `entryDate` sea otra (contable-6C-02): reabrir → revertir → cerrar; Faranda no tiene `fiscal_periods` hoy |
| `% s/ ventas` sin sentido con un libro casi vacío (10,33 € en Faranda) | `salesSource` por cobertura del libro (≥ 90 % de la referencia) en celdas, centros y sociedad; el front pinta el ratio de esa fuente (contable-6C-03) |
| `CostCenter` sin FK ni `organizationId`; un `usali` con `code` no canónico creado por otra vía | Pertenencia derivada de `propertyId`; upsert en la misma transacción; guard `code ∈ USALI_DEPARTMENTS` en el enrutado |
| Agrupar USALI por `cc.id` o cambiar la SQL sin flag | Agrupación por `(type, code)`; SQL sin flag byte-idéntica; tests de invariantes con y sin flag |
| Ampliar `UsaliMappingSource` rompería `buildCoverage` y `SOURCE_LABELS` | `UsaliAmountSource` solo en `UsaliAccountAmount.source`; `MemorySource` sin método nuevo |
| Cuerpo HTTP > 1 MiB (Fastify por defecto) y CSV latin1 desde el navegador | `content` ≤ 1.000.000 y `maxBytes` 1_000_000 (el JSON de Faranda pesa 103 KB); informes mayores o latin1 → CLI; «guardar como UTF-8» en la nota del drawer |
| Contratos que vigilan los ficheros nuevos | `legal-identity-readers` (nunca `organization.taxId/legalName` ni `property.legalName` → `resolveLedgerScope`), `estructura-integrador-fix` (importar de `@hotelos/shared`), `finanzas-schema-contract` (bloques `JournalEntry` / `JournalLine` sin columnas nuevas), `migrations-squash`, `api-route-permissions` (rutas con literal) |
| Cocoa regla 15 (inventario) roja tras L4 | Por construcción: `docs/design/cocoa-22-inventory.json` y `scripts/cocoa-22-inventory.mjs` son de la tanda C; el integrador ejecuta `node scripts/cocoa-22-inventory.mjs` tras fusionar; `inlineStyles` 801/801 |
| La carga real añade 48 asientos de 2026 a Faranda | Cualquier pin futuro sobre cifras USALI/PyG de Faranda 2026 cambia; documentado en la auditoría de L6; **nunca `--replace` sobre Faranda** |
