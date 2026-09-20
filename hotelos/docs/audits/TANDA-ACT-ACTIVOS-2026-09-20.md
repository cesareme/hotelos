# Tanda ACT · Activo inmobiliario (asset management por centro) · Integración y verificación — 20 de septiembre de 2026

**Para:** César. **Encargo (`tandaACT-brief.md` / `tandaACT-impl-brief.md`, 2026-09-17):** «módulo de gestión del activo
donde subir toda la información de la finca: documentación legal, planos, proyectos, licencias; impuestos a la propiedad
cuando la sociedad es propietaria (IBI, IAE, tasas)». Fuente de verdad `docs/design/ASSET-MANAGEMENT-INMOBILIARIO.md`
(ficha e inmueble con referencia catastral, titularidad y cargas, documentación con vigencias y alertas, tributos con
calendario y contabilización 631, tenencias, inspecciones obligatorias, CAPEX y activos fijos, valoración, RBAC
`asset_manager`, front Cocoa 22). **Método:** diseño → reconocimiento (`scratchpad/tandaACT-recon.md`, 18-09) → delta de
solo lectura sobre la base real (`scratchpad/ACT/recon-delta.md`, línea base `scratchpad/ACT/gates-base.json` 12/12) → 6 olas ·
16 lotes (ACT-L0a, L0b, L1, L2, L3, L4, L5, L6, L7, F0, F1, F2, F3, F4, D1, Z; después la ronda de revisión ACT-REV y este cierre ACT-INT) en el worktree
`~/anfitorio-demo-wt-act/hotelos` (rama `tanda-act`, base **`a069906`** = fusión de CHK en main, BD propia **`hotelos_act`**
—copia de la viva con la contabilidad real de Sage, solo lectura sobre Faranda—, puertos **:3925** API / **:5195** Vite) →
`gates.sh --quick` tras cada ola → puerta completa pre-revisión (`scratchpad/ACT/gates-full.json`, 14/14) → informe (ACT-Z) →
**dos revisores (funcional-runtime · seguridad-datos-regresiones), dedupe + refutación, corrector con test por hallazgo (§7)**
→ puerta completa final (`scratchpad/ACT/gates-final.json`, 13/14; el único rojo es externo al carril, §4) → **este cierre
(ACT-INT: informe, bloque de estado y commit en la rama `tanda-act`).

**Resultado en una línea:** el módulo `apps/api/src/modules/real-estate` (**42 rutas en 6 partials**, manifiesto 1.031 →
**1.073**, 10 modelos + 12 columnas en `capex_projects`, migración aditiva `20260920170000_activo_inmobiliario`, 0 enums, 0
claves RBAC nuevas) y el ítem **Finanzas › Activo inmobiliario** (6 pantallas Cocoa 22 bajo `/finanzas/activo-inmobiliario`)
funcionan de punta a punta en el carril con el tenant aislado `org_act`: ficha con unidad registral, hipoteca, tasación,
tenencia y **KPIs y alertas completos**; tributos con recibos previstos y **asiento 631 propuesto en borrador** que
contabiliza un contable (`POST /journal-entries/:id/post`); documentos con fichero sobre el almacén de T9; obras con
aprobación por ruta propia (`POST /capex-projects/:id/approve`), ejecución leída del diario por prefijos 21x y
capitalización sin asiento; inspecciones, pólizas y motor de alertas calculado en cada lectura; vista de grupo con
calendario anual y CSV. La ronda de revisión (§7) levantó **12 hallazgos confirmados** (6 altos: rutas de documentos sin
registrar, `PATCH` heredado de capex sin máquina, asiento 631 duplicable, borrador H 475 de un recibo pagado, aprobación
de obras imposible por HTTP, ficha sin KPIs ni alertas) **+ 11 menores, todos corregidos con test**, y **1 refutado**.
Puerta completa final **13/14**: la única roja (`nav-tree --check`) la causa el CSV compartido con 4 filas del carril
RRHH sin pantalla en este worktree (§4); integración **1.060 · 1.052 pass · 0 fail · 8 skip** con las 6 suites
`real-estate-*`. **Commit en la rama `tanda-act`** por este lote (sha en el informe estructurado), `pnpm-lock.yaml`
(deuda previa) **excluido**; nada fusionado ni desplegado. Quedan las decisiones de §10 que solo César puede tomar y la
deuda de §9 (docs desalineadas, asiento huérfano del demo, hook pre-commit que git no encuentra).

---

## 1. Encargo y base

| Elemento | Valor verificado |
|---|---|
| Base | `a069906` («Merge branch 'tanda-chk' — check-in automatizado y recepcionista IA (CHK) en main», 2026-09-20); rama `tanda-act`; worktree `/Users/cfernandez/anfitorio-demo-wt-act/hotelos` |
| BD | `hotelos_act` (`DATABASE_URL` del `.env` del worktree); 24 migraciones aplicadas y «No difference detected.» antes de ACT; **25** después (`db:migrate:status` «Database schema is up to date!», `db:drift:check` «No difference detected.», `check-migrations-vs-schema` «25 migración/es · schema 306 tablas / 46 enums · cadena 306 / 46 · OK») |
| Puertos | `:3925` API / `:5195` Vite del carril (instancias por lote, matadas por PID; `:3000` / `:5173` y el PID 4986 intocables) |
| Árbol al cierre (`git -C ~/anfitorio-demo-wt-act status --short`, tras la corrección) | **36 ` M`** del carril (+1.210 / −87, `git diff --numstat` sin el lock) + `pnpm-lock.yaml` ` M` (+64 / −25, **preexistente al primer lote, intocable: fuera del commit con `git reset -q hotelos/pnpm-lock.yaml`**) + **77 `??`** (25.765 líneas): `apps/api/src/modules/real-estate/` 32 ficheros de código · 5.808 líneas + 14 suites puras · 2.715; `apps/api/src/schemas/real-estate.schemas.ts` 625 + test 219; `apps/admin-web/src/screens/realEstate/` 7 · 6.515 + 7 tests · 2.377; `services/realEstateApi.ts` 840; `screens/tabs/finanzas/ActivoInmobiliarioTabs.tsx` 31; `tests/integration/real-estate-*.test.mts` 6 · 3.056; contratos raíz 2 · 638; `packages/` 3 · 1.938 (`real-estate-types.ts` 691, `migration.sql` 421, `seed-real-estate.ts` 826); `docs/runbooks/activo-inmobiliario.md` 485; este informe |
| Ficheros compartidos tocados (` M`) | `apps/api/src/server.ts` (+6: import + `registerRealEstateRoutes(app)` junto a `registerFixedAssetsRoutes`), `security/route-permissions.ts` (+6: import + spread del agregador), `lib/env.ts` (+13: `ACT_DEMO_PASSWORD`, `SEED_ACT_ALLOW_PRODUCTION`), `.env.example` (+11), `scripts/env-contract.json` (+27, censo regenerado), `modules/developer/api-reference.service.ts` (+21: etiquetas en español de `units/charges/valuations/tenures/receipts/works/inspections/insurances/real-estate/tax-calendar/propose-entry/capitalize/approve`), **`modules/assets/assets.service.ts` (+20: `updateCapexProject` respeta la máquina CAPEX_WORK, REV-02)**, **`modules/accounting/accounting.service.ts` (+8 / −3: `csvCell` neutraliza fórmulas, ACT-REV-05)**, `packages/database/prisma/schema.prisma` (+421), `prisma/lib/demo-guard.ts` (+`org_act`), `packages/database/package.json` (+`db:seed:real-estate`), `packages/shared/src/index.ts` (+5), `apps/admin-web/src/App.tsx` (+9), `screens/tabs/index.ts` (+2), `navigation/role-tokens.ts` (`activos` → `/finanzas/activo-inmobiliario`), `navigation/nav-tree.generated.json` (+86 / −5 regenerado), `components/guide/guideContent.ts` (+1), `docs/api-contracts.md` (+105: sección «Activo inmobiliario (Tanda ACT · 2026-09-20)» con las 42 rutas), `docs/design/ASSET-MANAGEMENT-INMOBILIARIO.md` (+6 / −2: notas «Estado tras la implementación» en §7 y §9), `docs/design/COCOA-22-MIGRACION.md` §6 y `cocoa-22-inventory.json` (regenerados: 252 pantallas · 175 puntos, techo 647 sin cambio), `docs/audits/ESTADO-VERIFICADO.md` (+65: bloque final) |
| Tests existentes editados (todos re-anclajes o ampliaciones, **0 skips nuevos, 0 asserts debilitados**: en `git diff -- tests apps/api/src/**/__tests__ apps/admin-web/src/**/__tests__` las 14 líneas `assert` eliminadas son recuentos y pines sustituidos por su nuevo valor) | Los tres pines de `DEMO_ORG_IDS` / seeds guardados que fija el brief: `tests/seed-ux-day-contract.test.mjs:119`, `tests/seed-checkin-contract.test.mjs:188`, `tests/demo-seed-contract.test.mjs:68-75` (+`seed-real-estate.ts` en la lista de seeds guardados); **además**: un cuarto pin literal de `DEMO_ORG_IDS` en `apps/api/src/scripts/__tests__/refresh-demo-dataset.test.mts:305-306` (L7 #1), un `it` NUEVO en `apps/api/src/modules/developer/__tests__/api-reference.test.mts` («Tanda ACT: las rutas del activo inmobiliario leen en español», 12 asserts + literal de «Capitalizar…» pinado en ACT-REV-06), 7 tests de navegación de admin-web re-anclados por el ítem y las 5 pestañas de F4 (`navigation/__tests__/{nav-tree,role-tokens,sidebar-menu,view-as}.test.mts`, `routes/__tests__/{backoffice.routes,route-access}.test.mts`, `screens/tabs/comercial/__tests__/tabs-b-containers.test.mts`: recuentos 70 → 71 ítems, 104 → 109 pestañas, 197 → 203 URLs, `roleHome("activos")`, «fifteen containers»), y, de la ronda de revisión, **`tests/rbac-nav-contract.test.mjs`** (+20 / −8: `loadManifest` lee `*route-permissions.partial.ts` y resuelve spreads anidados, ACT-REV-07) y **`apps/api/src/modules/accounting/__tests__/ledger-engine.test.mts`** (+11: `it` nuevo de `csvCell`) |
| Dependencias | ninguna nueva; `pnpm-lock.yaml` intacto por el carril |

Convenciones seguidas por todos los lotes: tenants aislados (`org_l2_*` de `tests/integration/helpers/l2-tenant.mts` con
`farandaInvariants` y limpieza; `org_act` para el seed), ningún nombre de persona (usuarios de prueba solo por correo
`*@act.test`), Sage solo `SELECT`, instancias propias por PID (nunca `pkill -f`), Cocoa 22 sin `style={}` inline nuevos
(techo 647 intacto), español en UI / código / docs, marca «ehotelOS».

---

## 2. Decisiones delegadas por César y defaults aplicados

Defaults del plan (`recon-delta.md` «Decisiones tomadas por el plan»), todos aplicados y verificados:

| # | Decisión | Default aplicado | Dónde se ve |
|---|---|---|---|
| 1 | Claves RBAC | **Las 4 de la Tanda 8a** (`real_estate.read`, `real_estate.manage`, `real_estate.documents.manage`, `property_tax.manage`; `permissions.ts:260-263`, catálogo v4 = 254 claves); **ninguna clave nueva** (`rbac:sync --dry-run`: «+0 created · 0 stale»). `asset_manager` = 29 claves (las 4); `controller` y `compliance` = read + manage + property_tax; `maintenance_manager`, `admin_clerk`, `manager` = read + documents.manage; `operations_director`, `accountant`, `general_manager`, `owner`, `auditor` = read | 6 partials `modules/real-estate/*-route-permissions.partial.ts`; design §7 nota «Estado tras la implementación» |
| 2 | Almacén de documentos | **El de la Tanda T9 tal cual** (`modules/documents/storage/*`, `buildStorageKey` con `documentId = red_…`), sin `DocumentFile`: `real_estate_documents` guarda `storageKind/storageKey/inline/sha256/sizeBytes/mimeType/encrypted`; `inline` / `disk` cifrado / `s3`; 40 MiB, 6 MIME, magic bytes, sesión real, 30 subidas/min | `documents.service.ts` (L3), runbook §5 |
| 3 | Tributos y asiento 631 | Recibo manual o **previsto** (`POST …/taxes/:taxId/receipts/generate`, idempotente por `installmentsJson` o calendario municipal) → `recibido/domiciliado → pagado` → **asiento propuesto en borrador** con `createJournalEntryDraft` (`POST …/receipts/:receiptId/propose-entry`, `sourceType property_tax_receipt`, 631 / 475 (recurrido) / 572 · 570 · 5721; `PropertyTaxReceipt.journalEntryId`); **nunca contabilizado automáticamente**: lo contabiliza `accountant` con `POST /journal-entries/:id/post` (`accounting.journal.post` + `ai.high_risk.confirm`); `createExpense` no se usa (no contamina el libro de IVA) | `property-tax.service.ts` (L2), runbook §4 |
| 4 | Valoraciones | Registro manual (`kind`, `valuedAt`, `value`, tasadora en texto) **sin asiento**; la ficha cachea la más reciente por `valuedAt` y deriva `valuePerRoom` | `real-estate.service.ts` (L1) |
| 5 | CAPEX / obras | Proyectos existentes (`CapexProject` + 12 columnas) con presupuesto, licencia (`licenceRequired`, `licenceDocumentId`; sin licencia no pasa a `in_progress`), ICIO y **ejecución leída de los asientos reales por prefijos de cuenta 21x** (`executionAccountPrefixes`, por defecto `211…219, 231, 232`; las 23x de Sage están vacías) o de las partidas; **capitalizar crea la fila de `FixedAsset` sin asiento** (los 21x ya vienen de Sage o de facturas `investmentGood`); aprobación por el motor existente (`asset.capex.approve`), expuesta desde §7.1 por la ruta propia `POST /capex-projects/:id/approve` | `works.service.ts`, `capex-execution.service.ts` (L4) |
| 6 | Sin OCR / digest / tesorería / USALI | Fechas a mano (sin `POST …/ocr/extract-dates`), alertas **calculadas en cada lectura** (sin scheduler ni `REAL_ESTATE_DIGEST_*`: `env` intacto salvo las 2 variables del seed), sin previstos en tesorería, sin fila FF&E en USALI ni tarjeta en cartera | runbook §11 |
| 7 | Navegación | Ítem **core** (sin `modulesAny`) en Finanzas, **orden 9** (tras Nóminas), roles `finanzas|direccion|admin|activos|auditoria`; `roleHome("activos")` pasa de `/cumplimiento/centro` a `/finanzas/activo-inmobiliario` | `pilots/tanda5-nav-tree.csv:295-300`, F4 |
| 8 | Tenant de prueba | **`org_act`** (`db:seed:real-estate`, idempotente, `--dry-run` / `--reset`, `assertDemoTarget`; `DEMO_ORG_IDS` + `org_act`, `DEMO_PROPERTY_IDS` sin cambio): sociedad `le_act`, `prop_act_a` propietaria / `prop_act_b` arrendataria de industria, 4 usuarios `*@act.test` con contraseña fija `Act-Demo-2026!` (`ACT_DEMO_PASSWORD`), ejercicio 2026 abierto, plan PGC Pymes; **0 filas escritas en Faranda ni en `org_123`** | `seed-real-estate.ts` (L7), runbook §9 |

Defaults de implementación declarados por los lotes (todos con test; a confirmar o cambiar):

- **L1**: referencia catastral del censo con forma inválida no bloquea el alta (unidad sin referencia); duplicado en la organización → 409 `UNIQUE_VIOLATION` genérico; tenencias resueltas / vencidas no admiten edición (409 `TENURE_INVALID_TRANSITION`); tenencia `propiedad` del alta con `startDate` = hoy; sin sociedad resoluble la ficha nace sin `legalEntityId`.
- **L2**: `propose-entry` admite `recurrido` con importe (H 475); pagar sin `paidWith` → `bank`, sin `paidAt` → hoy; con asiento enlazado (borrador o contabilizado) importes y pago congelados (409 `RECEIPT_ENTRY_EXISTS`) hasta desenlazar con `journalEntryId: null` (el borrador huérfano no se anula); generar previstos de un tributo de baja → 409 `PROPERTY_TAX_INACTIVE` (como `details.code` de un 409 genérico: no está en `REAL_ESTATE_ERROR_CODES`); carrera de dos `propose-entry` → el segundo borra su borrador y responde 409; `ratePct` con 4 decimales.
- **L3**: `complianceRequirementCode` desconocido se guarda sin sincronizar; una versión nueva hereda metadatos (no `legalHold`) y exige `file`; retirar la última versión no reactiva la anterior; DELETE responde 200 con `deletedAt`; listado con ficha inexistente → 404 `ASSET_NOT_FOUND`; sustituidas descargables, retiradas 404 opaco (el fichero permanece: sin job de purga; `retentionUntil` informativo).
- **L4**: PATCH `/work` transaccional (sin licencia no se escribe nada); documentos de licencia / proyecto / final de obra deben ser `RealEstateDocument` del mismo centro; ventana del diario `[startDate, targetEndDate ?? hoy]` también al capitalizar; `acquisitionDate` = fecha de capitalización; coste 0 → 400 sin alta; capitalizar exige solo `assets.manage`; `completed` es final; GET works recalcula y cachea `executedAmountLedger`.
- **L5**: preaviso de póliza eleva baja → media; `result: pendiente` deja la inspección programada; cerrar una `realizada` es archivo; `ComplianceItem.status` por transición; sucesora copia proveedor; recibos `recurrido` fuera del motor; PATCH sobre `cerrada` → 409. Umbrales 90 / 30 / 7 → baja ≤ 90 · media ≤ 30 · alta ≤ 7 (L0a: el brief solo fijaba media ≤ 30 y baja ≤ 90).
- **L6**: CSV de grupo sin línea de totales (3 líneas: BOM, `;`, CRLF, coma decimal, `attachment activo-inmobiliario-<what>-<año>.csv`); `documentsValidPct` con los días de aviso por defecto (30; 90 seguros / inspecciones); filas del grupo = centros visibles no cerrados (hoteles siempre, oficina / other solo con ficha); calendario con vencimiento del contrato y revisión de renta hasta `endDate`; `format` opcional (solo csv), `year` por defecto el actual; alertas de grupo = solo alta.
- **L7**: obra «Sustitución enfriadora» sembrada `in_progress` (no `approved`) para que exista `CAPEX_LICENCE_MISSING`; `ownerApprovedBy` null (SoD); 7 alertas en Norte (las 3 pedidas + `DOCUMENT_EXPIRING` baja + `TAX_DUE` baja ×3, por diseño); `prop_act_b` sin unidad ni recibos; `valuePerRoom` 81.666,67 (120 hab.); el `--reset` conserva organización, sociedad, centros, usuarios, roles, plan y ejercicio.
- **F0-F3**: `alertSeverityTone` baja → `info`; subida con `file` opcional (ficha «Sin fichero») y versión con `file` obligatorio; MIME deducido por extensión si el navegador no lo informa; `REAL_ESTATE_ERROR_MESSAGES` = `REAL_ESTATE_ERROR_CODES` ∪ extras (`DOCUMENT_STORAGE_IO`, `PROPERTY_TAX_INACTIVE`); «forbidden» con `CocoaState kind="error"` + `UI_STATES.forbidden`; totales del grupo calculados en cliente (verificados iguales a los del API); «Operar en este centro» confirma en `CocoaDialog`; tenencia nueva nace en borrador con «Activar»; «Capitalizar» exige `realEstateAssetId`; «Iniciar obra» / «Terminar» envían campos + `status` en una petición; enlace a Inmovilizado por `navigateTo("FixedAssetsScreen")`; fases de obra como `WorkStageFlow` (CocoaStepper es el control ±); «Vence en N días» ámbar dentro de `noticeDays`; tenencias solo lectura en Inspecciones y seguros; sin UI de alta manual de recibos ni de edición de tributos (solo API).

Defaults **modificados por la ronda de revisión** (§7.1; los bullets anteriores describen el estado del lote): L2 — desenlazar
(`journalEntryId: null`) un asiento propio **contabilizado** responde 409 `RECEIPT_ENTRY_EXISTS` (solo se desenlaza un borrador
propio, que se descarta); `propose-entry` rechaza cualquier asiento no anulado del recibo por (`organizationId`, `sourceType`,
`sourceId`); pagar con borrador propio **regenera** el borrador (D 631 / H 57x) y con asiento propio contabilizado propone el
**asiento de pago** D 475 / H 57x (`sourceType property_tax_receipt_payment`); `pagado → recurrido` permitido (conserva
`paidAt` / `paidWith`); recibos `recurrido` sin pagar **sí** entran en el motor de alertas. L1 — activar una tenencia (o
cambiar `kind` / `ibiPayer` de la vigente) **propone el `taxpayer` de los IBI** de la ficha; una `vigente` con `endDate`
pasado (`vencido` derivado) no admite edición. L3 — `cdeState wip` solo lo ve quien lo subió (o `real_estate.manage`);
`confidentiality solo_propiedad` solo `real_estate.manage` o plantilla `owner`. L4 — `acquisitionDate` del inmovilizado =
`acquisitionDate` del cuerpo | `targetEndDate` ya cumplido | hoy; `PATCH /capex-projects/:id` heredado respeta la máquina
CAPEX_WORK y rechaza cambios de estado sobre una obra capitalizada. L5 — `RealEstateInsurancePatchSchema` solo admite
`vigente | cancelada` (`REAL_ESTATE_INSURANCE_PATCH_STATUSES`). L6 — los periodos previstos sin recibo se publican con
`entityType property_tax`; etiquetas del calendario con fechas DD/MM/AAAA e importes en español.

---

## 3. Lote a lote (ficheros, rutas, tests, cifras)

Puertas por lote en `scratchpad/ACT/gates-<lote>.json` (todas `gates.sh --quick` con `NAV_TREE_CSV`); las de ola
(`gates-ola1…6.json`) las corrió el orquestador tras fusionar los ficheros compartidos. Cifras = tests api · admin-web ·
contratos raíz (base 3.569 · 2.014 · 765).

### Ola 1 · tipos, puros, esquema y migración (ACT-L0a, ACT-L0b)

**ACT-L0a · Tipos wire y puros** — `packages/shared/src/real-estate-types.ts` (688: catálogos `as const` de tenencia,
unidades, cargas, valoraciones, tributos / recibos, documentos, inspecciones, seguros, obras, alertas; DTOs; `RealEstateKpis`;
vista de grupo; **`REAL_ESTATE_ERROR_CODES` = 18**), `apps/api/src/schemas/real-estate.schemas.ts` (624, zod `.strict()`;
test 16), `modules/real-estate/{errors.ts, cadastral.ts (regex y dígitos de control), tax-calendar.ts (previstos por INE /
periodicidad / `installmentsJson`; municipal solo Madrid 28079, resto supletorio LGT 62.3), state-machines.ts (documento ·
inspección · recibo · tenencia · obra), vigencias.ts (`expiringSoonDays`), alerts.pure.ts (motor puro, 90 / 30 / 7)}` +
5 suites (44 tests), `packages/shared/src/index.ts` (+5). Puerta 12/12 · api **3.629**. Abiertos heredados: `schemas/index.ts`
sin `export * from "./real-estate.schemas.js"` (los lotes importan directo) y comentario `installmentsJson [{ label, dueOn
(MM-DD), pct }]` del schema frente al wire `{ label, dueFrom, dueTo, pct }` (§9).

**ACT-L0b · Schema y migración** — `schema.prisma` (+421: `RealEstateAsset`, `RealEstateUnit`, `RealEstateCharge`,
`RealEstateValuation`, `RealEstateTenure`, `PropertyTax`, `PropertyTaxReceipt`, `RealEstateDocument`,
`RealEstateInspection`, `RealEstateInsurance` + 12 columnas en `CapexProject`; catálogos `String` documentados con `///`,
sin enums) y `migrations/20260920170000_activo_inmobiliario/migration.sql` (421 líneas: cabecera de la casa + SQL
**verbatim** de `migrate diff --from-schema-datasource --to-schema-datamodel --script`; **10 `CREATE TABLE`, 12 `ADD
COLUMN`, 12 `CREATE INDEX` + 4 `CREATE UNIQUE INDEX`, 9 FK `ON DELETE CASCADE` internas, 0 `CREATE TYPE`, 0 `DROP`**;
posterior a `20260920160000_checkin_pago_en_recepcion`). Desviaciones deliberadas respecto a la tabla §4 del diseño
(brief): `PropertyTaxReceipt.journalEntryId` en vez de `expenseId`; `RealEstateDocument` con `storageKind/storageKey/
inline/encrypted/supersededById/complianceRequirementCode`; `RealEstateInspection.complianceRequirementCode`;
`RealEstateTenure` sin `baseFeePct/incentiveFeePct/pipDueAt`; `RealEstateAsset.protectionLevel` NOT NULL `none` y
`roomsCount`; `CapexProject` con `completionDocumentId/executionAccountPrefixes/executedAmountLedger`. Puerta 12/12
(api 3.569 en su ejecución, previa a la fusión de L0a) · ola 1 **12/12** api 3.629.

### Ola 2 · ficha, tenencia, valoraciones (ACT-L1)

**ACT-L1** — `modules/real-estate/{real-estate.service.ts (633), tenure.service.ts (150), core.routes.ts (100),
core-route-permissions.partial.ts (12 rutas), route-permissions.partial.ts (agregador: solo spreads),
real-estate.register.ts}`; `__tests__/real-estate-service.test.mts` (17); `tests/integration/real-estate-core.test.mts`
(8: alta 201 / 409 `ASSET_ALREADY_EXISTS`, unidades con referencia catastral y `INVALID_CADASTRAL_REFERENCE`, cargas,
valoraciones con caché, una tenencia vigente `TENURE_ALREADY_ACTIVE` / `TENURE_INVALID_TRANSITION`, 404 opaco cross-tenant,
`asset_manager` con ámbito `legal_entity`). Rutas: `GET|PUT|PATCH /properties/:propertyId/real-estate`, `POST …/units`,
`POST …/units/:unitId/charges`, `PATCH …/charges/:chargeId`, `GET|POST …/valuations`, `GET|POST …/tenures`, `PATCH
…/tenures/:tenureId`, `GET …/alerts` (`real_estate.read` / `real_estate.manage`). Puerta del lote **10/12** por dos ficheros
fuera del lote: `api-route-permissions-contract` exigía rutas literales en el agregador `real-estate.routes.ts` (→ el
orquestador lo renombró a `real-estate.register.ts` y retiró los stubs a `scratchpad/ACT/stubs-retirados`) y
`api-reference.test` R6 (etiquetas `units/charges/valuations/tenures/real-estate` → `api-reference.service.ts`). Ola 2
**12/12** · api **3.646**.

### Ola 3 · tributos, documentos, obras, inspecciones (ACT-L2 ∥ L3 ∥ L4 ∥ L5)

**ACT-L2 · Tributos** — `property-tax.service.ts` (717), `taxes.routes.ts` (85), `taxes-route-permissions.partial.ts` (9:
`GET|POST …/taxes`, `PATCH …/taxes/:taxId`, `POST …/taxes/:taxId/receipts`, `POST …/receipts/generate`, `GET …/receipts`,
`PATCH …/receipts/:receiptId`, `POST …/receipts/:receiptId/propose-entry`, `GET …/tax-calendar`; `property_tax.manage` /
`real_estate.read`), `__tests__/property-tax.test.mts` (14), `tests/integration/real-estate-taxes.test.mts` (11: previstos
idempotentes, transiciones, `RECEIPT_NOT_PAYABLE`, `RECEIPT_ENTRY_EXISTS`, `TAXPAYER_NOT_ENTITY`, `FISCAL_YEAR_CLOSED`
propagado, borrador 631/572 cuadrado y contabilizado por `accountant`). Puerta 11/12 (R6 ajeno).

**ACT-L3 · Documentos con fichero** — `documents.service.ts` (575), `documents.routes.ts` (101),
`documents-route-permissions.partial.ts` (6: `GET|POST …/documents`, `GET|PATCH|DELETE …/documents/:documentId`, `POST
…/documents/:documentId/versions`, `GET …/documents/:documentId/file`), `__tests__/real-estate-documents.test.mts` (15),
`tests/integration/real-estate-documents.test.mts` (12: subida base64 con sha256 y magic bytes, 413 / 400 MIME / content
mismatch, versión con `supersededById` y `DOCUMENT_SUPERSEDED`, `LEGAL_HOLD`, `DOCUMENT_NO_FILE`, descarga con bytes
idénticos, 404 opaco). **Cableado que faltaba** (L3 #1): `real-estate.register.ts` no llamaba a `registerRealEstateDocumentRoutes(app)` (las 6
rutas respondían 404 en `server.ts` aunque el partial estaba en el manifiesto; las suites y los lanzadores se autocableaban
con `app.hasRoute`, lo que ocultaba el fallo a la puerta) — corregido en la ronda de revisión (funcional-runtime-REV-01 y
seguridad-datos-regresiones-ACT-REV-02, §7.1). Puerta 11/12.

**ACT-L4 · Obras** — `works.service.ts` (292), `capex-execution.service.ts` (142), `works.routes.ts` (38),
`works-route-permissions.partial.ts` (3 en el lote, **4** desde §7.1 con `POST /capex-projects/:id/approve` `asset.capex.approve`: `GET …/works` `real_estate.read`; `PATCH /capex-projects/:id/work` `capex.create`;
`POST /capex-projects/:id/capitalize` `assets.manage`), `__tests__/capex-execution.test.mts` (13),
`tests/integration/real-estate-works.test.mts` (9: `LICENCE_REQUIRED`, ejecución `ledger` por prefijos 21x sobre asientos
posted del centro, `CAPEX_NOT_COMPLETED`, `CAPEX_ALREADY_CAPITALIZED`, `CAPEX_NOT_LINKED`, alta de `FixedAsset` sin
asiento). Hueco RBAC detectado (fuera del lote): `PATCH /capex-projects/:id` exige `capex.create` (manifiesto) y
`asset.capex.approve` (servicio) y ninguna plantilla reúne ambas → nadie aprobaba por HTTP bajo `RBAC_STRICT`; cerrado en
§7.1 con la ruta propia de aprobación (REV-05) y la máquina CAPEX_WORK en el `PATCH` heredado (REV-02). Puerta 11/12.

**ACT-L5 · Inspecciones, pólizas y alertas** — `inspections.service.ts` (511), `insurances.service.ts` (166),
`alerts.service.ts` (184: `getRealEstateAlerts(propertyId)`, `alertsByProperty`), `inspections.routes.ts` (61),
`inspections-route-permissions.partial.ts` (7: `GET|POST …/inspections`, `PATCH …/inspections/:inspectionId`, `GET|POST
…/insurances`, `PATCH …/insurances/:insuranceId`, `GET …/alerts` reescrito), `__tests__/inspections.test.mts` (16),
`tests/integration/real-estate-inspections.test.mts` (11: acta con defectos, `INSPECTION_INVALID_TRANSITION` con
`openDefects`, sucesora automática, `ComplianceItem` sincronizado, póliza que vence, motor con 7 tipos de alerta). Puerta
11/12. Ola 3 (orquestador: etiquetas R6 + `it` en `api-reference.test`) **12/12** · api **3.705**.

### Ola 4 · grupo, seed, cliente (ACT-L6, ACT-L7, ACT-F0)

**ACT-L6 · Vista de grupo, calendario, export** — `group.service.ts` (243), `calendar.service.ts` (329),
`export.service.ts` (143), `group.routes.ts` (56), `group-route-permissions.partial.ts` (4: `GET
/organizations/:organizationId/real-estate/overview | calendar | export`, `GET /properties/:propertyId/real-estate/calendar`;
`real_estate.read` + ámbito), `__tests__/{calendar,export}.test.mts` (17 + 16), `tests/integration/real-estate-group.test.mts`
(14). Puerta 10/12 por el lote seed (pin de `DEMO_ORG_IDS` y `env-contract`), no por L6.

**ACT-L7 · Tenant de prueba** — `packages/database/prisma/seed-real-estate.ts` (826; plan `--dry-run`, `--reset`,
`assertDemoTarget`), `tests/seed-real-estate-contract.test.mjs` (13), `demo-guard.ts`, `database/package.json`, `env.ts`,
`.env.example`, `env-contract.json`, pines de `DEMO_ORG_IDS`. Siembra verificada (`seed-l7-run3-reset.log`): 2 fichas · 1
unidad · 1 carga · 1 valoración · 2 tenencias · 4 tributos · 5 recibos · 11 documentos (metadatos, sin fichero) · 4
inspecciones · 2 pólizas · 1 obra con 2 partidas y 1 asiento `posted` 212/572 · 4 usuarios · 22 roles · 239 cuentas.
Puerta 10/12 (los mismos rojos; los pines se re-anclaron en la ola).

**ACT-F0 · Cliente y helpers del front** — `apps/admin-web/src/services/realEstateApi.ts` (838: 42 funciones tipadas, una
por ruta + `getRealEstateCalendar`; `apiRequest` / `apiRequestBlob`), `screens/realEstate/real-estate-helpers.ts` (625:
etiquetas, tonos, `REAL_ESTATE_ERROR_MESSAGES`, fechas, importes) + test (11). Puerta 10/12 (mismos rojos ajenos). Ola 4
**12/12** · api **3.738** · admin-web 2.025 · contratos 778.

### Ola 5 · pantallas (ACT-F1, ACT-F2, ACT-F3)

**ACT-F1** — `RealEstateAssetScreen.tsx` (1.217: KPIs, unidad / cargas, tenencia con «Activar» / «Resolver», valoraciones,
inspector de 90 días, formularios Cocoa) + test (11); `RealEstateGroupScreen.tsx` (514: tabla de centros, totales,
calendario anual, exportación CSV, detalle en `CocoaDrawer`) + test (8). **ACT-F2** — `RealEstateDocumentsScreen.tsx` (883:
subida con fichero, versión, visor `iframe` por `blob:`, descarga, filtros) + test (15); `RealEstateTaxesScreen.tsx` (1.050:
tributos, recibos con «Generar previstos», cambios de estado, «Proponer asiento», «Contabilizar» gateado por
`accounting.journal.post` + `ai.high_risk.confirm`, calendario tributario) + test (14). **ACT-F3** —
`RealEstateWorksScreen.tsx` (869: `WorkStageFlow`, licencia, «Iniciar obra» / «Terminar» / «Capitalizar», enlace a
Inmovilizado) + test (21); `RealEstateInspectionsScreen.tsx` (1.352: actas, defectos, cierre, pólizas con «Vence en N días»,
tenencias solo lectura) + test (16). Tests como `.test.mts` (el runner de admin-web no ejecuta `.tsx`). Puertas de lote
10/12 y ola 5 11/12 **por diseño de la ola**: `discoverability` (6 pantallas huérfanas hasta F4) y `cocoa-22` regla 15
(inventario sin regenerar). Techo Cocoa **647** sin cambio; 0 `style={}` nuevos.

### Ola 6 · navegación y documentación (ACT-F4, ACT-D1)

**ACT-F4 · Navegación** — 6 filas en `pilots/tanda5-nav-tree.csv:295-300` (ítem `RealEstateAssetScreen`
`/finanzas/activo-inmobiliario` orden 9 + `merge-into` `/documentacion`, `/tributos`, `/obras`, `/inspecciones`
«Inspecciones y seguros», `/grupo`), `nav-tree.generated.json` regenerado (71 ítems · 109 pestañas · 203 URLs),
`screens/tabs/finanzas/ActivoInmobiliarioTabs.tsx` (`NavItemTabs`, 6 cargadores perezosos), `App.tsx`, `tabs/index.ts`,
`role-tokens.ts`, `guideContent.ts`, 7 tests de navegación re-anclados, `cocoa-22-inventory.json` y `COCOA-22-MIGRACION.md`
§6 regenerados. Verificación en navegador (`rt-f4.mjs`, capturas `f4-01…08`): subida de PDF y visor, «Proponer asiento»
como `activos@act.test`, «Contabilizar» como `contabilidad@act.test` y asiento n.º 2 en el Diario, «Sin acceso» para
`recepcion@act.test` a 1.280 y 400 px. Puerta **12/12** · admin-web **2.111** · contratos **789** · discoverability **203**.

**ACT-D1 · Documentación** — `docs/runbooks/activo-inmobiliario.md` (456, §1-§11), `docs/api-contracts.md` (+104: 41
rutas con clave / riesgo, códigos, formato CSV, línea de remisión en «Real Estate, Assets, And Owner Dashboard»), notas
«Estado tras la implementación» en §7 y §9 del diseño, `tests/activo-inmobiliario-docs-contract.test.mjs` (11: rutas del
runbook = manifiesto, códigos = `REAL_ESTATE_ERROR_CODES`, mensajes del front verbatim, marca). Puerta 11/12 (`cocoa
waves --check` §6 desactualizado por las pantallas de la ola; el orquestador corrió `--write`). Ola 6 **12/12**.

**ACT-Z · Informe** — puerta completa pre-revisión (§4, 14/14), primera versión de este informe y del bloque de
`docs/audits/ESTADO-VERIFICADO.md`; verificación en runtime propia (§6, «antes de la corrección»).

**ACT-REV · Revisión y corrección** (20/09 13:20-14:56) — dos revisores, dedupe, refutación y corrector: 12 hallazgos
confirmados + 11 menores corregidos, 1 refutado, 3 sin corregir con motivo (§7); 51 ficheros tocados por el corrector
(servicios `property-tax`, `tenure`, `documents`, `works`, `alerts`, `calendar`, `real-estate`, `export`, `state-machines`,
`vigencias`, `insurances`; `assets.service.ts`, `accounting.service.ts`, `api-reference.service.ts`; esquemas y contrato
compartido; seed; 3 pantallas / cliente / helpers del front; 15 suites de test —2 nuevas: `works.test.mts`,
`tenure.test.mts`—; runbook, `api-contracts`, diseño, inventario Cocoa). api unit 3.738 → **3.753**, integración 1.048 →
**1.060**, manifiesto 1.072 → **1.073** (ruta `approve`). Puertas: `gates-quick-rev.json` 10/12 → `gates-full-rev.json`
11/14 → `gates-full-rev2.json` 13/14 → **`gates-final.json` 13/14** (§4).

**ACT-INT · Este lote (cierre)** — confirmación del árbol (§1), este informe (§7 y cifras finales), bloque final de
`ESTADO-VERIFICADO.md`, verificación en runtime propia tras la corrección (§6), hook pre-commit ejecutado a mano (§9.1 #16),
puerta `--quick` sobre el árbol final y **commit en `tanda-act`** (§11, §12).

---

## 4. Puertas con cifras

Todas con `NAV_TREE_CSV=/Users/cfernandez/anfitorio-demo/pilots/tanda5-nav-tree.csv bash scripts/gates.sh [--quick] --json
<f>` desde el worktree, BD `hotelos_act`; JSON en `scratchpad/ACT/gates-*.json`.

| Puerta | Base (20/09 08:57) | Ola 1 | Ola 2 | Ola 3 | Ola 4 | Ola 5 | Ola 6 | Completa pre-revisión (ACT-Z, 12:55) |
|---|---|---|---|---|---|---|---|---|
| typecheck:all | 15 PASS · 1 SKIP | 15 | 15 | 15 | 15 | 15 | 15 | **15 PASS · 0 FAIL · 1 SKIP (apps/guest-web)** |
| api unit | 3.569 (1 skip) | 3.629 | 3.646 | 3.705 | 3.738 | 3.738 | 3.738 | **3.738 · 3.737 pass · 0 fail · 1 skip (+169)** |
| admin-web unit | 2.014 (1 skip) | 2.014 | 2.014 | 2.014 | 2.025 | 2.110 | 2.111 | **2.111 · 2.110 · 0 · 1 (+97)** |
| ai-core | 119 | 119 | 119 | 119 | 119 | 119 | 119 | **119/119** |
| worker | 34 | 34 | 34 | 34 | 34 | 34 | 34 | **34/34** |
| contratos raíz | 765 (2 skip) | 765 | 765 | 765 | 778 | 778 | 789 | **789 · 787 · 0 · 2 (+24)** |
| discoverability | 197 URLs | 197 | 197 | 197 | 197 | rojo (6 huérfanas) | 203 | **203 URLs · 0 huérfanas · 0 rotos** |
| nav-tree --check | 70 · 104 · 205 | al día | al día | al día | al día | al día | 71 · 109 | **al día (71 ítems · 109 pestañas · 205 leg.)** |
| route-access | 15 × 197 | 197 | 197 | 197 | 197 | 197 | 203 | **15 tokens × 203 URLs** |
| cocoa waves --check | §6 al día | al día | al día | al día | al día | al día | al día | **§6 al día (techo 647 sin cambio)** |
| rbac:sync dry-run | OK | OK | OK | OK | OK | OK | OK | **OK: +0 claves · 0 stale · catálogo 254** |
| migrate status + drift | No difference | id. | id. | id. | id. | id. | id. | **25/25 «up to date» · «No difference detected.»** |
| admin-web build | — | — | — | — | — | — | — | **OK (built in 10,62 s)** |
| integración | — | — | — | — | — | — | — | **1.048 · 1.040 pass · 0 fail · 8 skip condicionales** (`--test-concurrency=1`, loader tsx, `.env` del carril; las 6 suites `real-estate-*` incluidas: 65 tests) |
| **Verdes** | 12/12 | 12/12 | 12/12 | 12/12 | 12/12 | 11/12 | 12/12 | 14/14 |

Ronda de revisión y corrección (todas con el mismo comando; JSON en `scratchpad/ACT-REV/`, `scratchpad/` y `scratchpad/ACT/`):

| Puerta | Revisor (13:20, quick) | Corrector quick (14:19) | Corrector completa 1 (14:26) | Corrector completa 2 (14:46) | **Final (14:56, completa)** |
|---|---|---|---|---|---|
| typecheck:all | 15 | 15 | 15 | 15 | **15 PASS · 0 FAIL · 1 SKIP · 24,3 s** |
| api unit | 3.738 | 3.753 | 3.753 | 3.753 | **3.753 · 3.752 pass · 0 fail · 1 skip** |
| admin-web unit | 2.111 | 2.111 | 2.111 | 2.111 | **2.111 · 2.110 · 0 · 1** |
| ai-core · worker | 119 · 34 | 119 · 34 | 119 · 34 | 119 · 34 | **119/119 · 34/34** |
| contratos raíz | 789 | **786 · 1 fail** (`cocoa-22` regla 15: inventario sin regenerar tras las pantallas tocadas → `node scripts/cocoa-22-inventory.mjs`) | 789 | 789 | **789 · 787 · 0 · 2** |
| discoverability | 203 | 203 | 203 | 203 | **203 URLs · presupuesto 16/20** |
| nav-tree --check | al día | **rojo (externo)** | rojo (externo) | rojo (externo) | **rojo (externo, nota abajo)** |
| route-access | 203 | 203 | 203 | 203 | **15 tokens × 203 URLs** |
| cocoa waves --check | al día | al día | **rojo** (§6 → `cocoa-22-waves.mjs --write`) | al día | **§6 al día** |
| rbac:sync dry-run · migrate + drift | OK | OK | OK | OK | **OK · 25/25 «No difference detected.»** |
| admin-web build | — | — | OK | OK | **OK (3,11 s)** |
| integración | — | — | **1.060 · 1.050 · 2 fail** (el resumen del gate no da nombres; la carpeta entera reejecutada en aislamiento → 0 fail; no reproducido) | 1.060 · 1.052 · 0 · 8 | **1.060 · 1.052 pass · 0 fail · 8 skip** |
| **Verdes** | 12/12 | 10/12 | 11/14 | 13/14 | **13/14** |

Notas:

- **`nav-tree --check` en rojo por causa EXTERNA al carril** (misma en las 4 ejecuciones desde las 14:19): el CSV compartido
  `/Users/cfernandez/anfitorio-demo/pilots/tanda5-nav-tree.csv` lo modificó el carril RRHH (mtime 20/09 14:21, sin commit
  en main): 304 filas, 4 nuevas (302-305: `HrEmployeesScreen`, `HrForecastScreen`, `HrOverviewScreen`,
  `DirectorLaborCostsScreen`) y `PayrollScreen` re-etiquetado «RRHH y nóminas» → 71 ítems · **113** pestañas, cuyas pantallas NO
  existen en este worktree. Regenerar aquí metería 4 pestañas huérfanas (207 URLs) y pondría en rojo `discoverability` y
  `route-access`, y editar el CSV compartido está prohibido; el corrector verificó `build-nav-tree --check` contra una copia
  sin esas 4 filas (`scratchpad/ACT/nav-tree-act-only.csv`) → «up to date (71 items, 109 tabs, 205 legacy)». El
  `nav-tree.generated.json` del carril queda en el estado ACT (203 URLs; diff vs HEAD = solo `RealEstateAssetScreen` y sus 5
  pestañas). **Al fusionar con `tanda-rrhh` el orquestador regenera en main** (esperado 71 · 113 · 207).
- Puerta completa pre-revisión (ACT-Z): 20/09 12:47-12:56, `gates-full.json`, exit 0, 14/14; las 6 suites
  `tests/integration/real-estate-{core,taxes,documents,works,inspections,group}.test.mts` entran en la puerta y,
  reejecutadas solas (`integration-real-estate-z.log`): 65 tests · 65 pass · 0 fail; tras la corrección son **77 tests**
  (2 casos nuevos en `taxes`, 1 en `works`, 1 en `core`, 1 en `documents`, 1 en `group` y los del cruce de partials), en verde
  en las dos puertas completas del corrector y en la final. Incidente sin efecto en ninguna puerta: una reejecución aislada
  cayó con `FATAL: sorry, too many clients already` (Postgres `max_connections` 100 agotado por la puerta completa de otro
  carril + instancias de otros worktrees + la propia `:3925`); tras parar la instancia propia volvió a verde.
- Deltas frente a la línea base (`gates-base.json`, 08:57), todos atribuibles a la tanda: api **+184** (3.569 → 3.753: 14
  suites puras de `modules/real-estate/__tests__` = 165 + `real-estate-schemas` 17 + `api-reference` +1 `it` + `ledger-engine`
  +1), admin-web **+97** (7 suites de `screens/realEstate/__tests__` = 96 + 1 de `tabs-b-containers`), contratos raíz **+24**
  (`activo-inmobiliario-docs-contract` 11 + `seed-real-estate-contract` 13), integración 1.048 → **1.060** (+12 de la
  corrección sobre la puerta pre-revisión), discoverability / route-access **197 → 203** URLs, nav-tree **70 · 104 → 71 ·
  109**, migraciones **24 → 25**, tablas **296 → 306** (enums 46 sin cambio), manifiesto de rutas **1.031 → 1.073** (+42),
  claves **254 = 254**, techo Cocoa **647 = 647**, skips **sin cambio** (1 · 1 · 2 · 8 condicionales de integración).
- Comprobaciones fuera de `gates.sh` (ACT-Z y ACT-INT): `db:migrate:status` «25 migrations found · Database schema is up to
  date!»; `db:drift:check` «No difference detected.»; `node scripts/check-migrations-vs-schema.mjs` «25 migración/es ·
  schema 306 tablas / 46 enums · cadena 306 / 46 · OK»; `rbac:sync -- --dry-run` «catalog 254 keys · +0 created · 0 stale · 91
  template roles · 69 behind v4 (heredado, el arranque nunca revoca)»; manifiesto cargado con tsx desde
  `security/route-permissions.ts`: **1.073 entradas, 42 de ACT** con las claves `asset.capex.approve`, `assets.manage`,
  `capex.create`, `property_tax.manage`, `real_estate.documents.manage`, `real_estate.manage`, `real_estate.read`.
- Los rojos intermedios (L1 10/12, L2-L5 11/12, L6-L7-F0 10/12, F1-F3 10/12, D1 11/12; corrector 10/12 y 11/14) fueron TODOS
  de ficheros fuera del lote que los declaró (contrato del agregador, etiquetas R6 de `api-reference`, pin de `DEMO_ORG_IDS`,
  `env-contract`, pantallas huérfanas hasta F4, inventario Cocoa y §6 sin regenerar, CSV compartido) y los cerró el orquestador
  o el corrector en la puerta siguiente; ningún lote debilitó un test ni añadió un skip.
- Durante la puerta completa de ACT-Z corría en paralelo la puerta completa de otro carril (`~/anfitorio-demo-wt-cierre/hotelos`,
  BD propia) y durante las del corrector las de L6b / UX-3: solo contención de CPU y conexiones.

---

## 5. Delta frente al dosier (`tandaACT-recon.md`, 18-09) y al diseño (17-09)

Entradas de `scratchpad/ACT/recon-delta.md` que condicionaron la implementación (verificadas sobre `a069906`):

| # | Afirmación del dosier / diseño | Estado real y consecuencia |
|---|---|---|
| 1 | `modules/documents` no existe; T9-L1 pendiente; regex de clave debe admitir `re/` | T9 fusionada: `storage/{storage,inline-storage,disk-storage,s3-storage,at-rest-encryption,sigv4}.ts`, `STORAGE_KEY_RE = org/<id>/prop/<id>/doc/<id>/<sha256>.<ext>` con `ID_SEGMENT [A-Za-z0-9_-]{1,64}` → ACT usa `documentId = red_…` **sin tocar `modules/documents/*`** ni la regex; `DocumentFile` exige `IncomingDocument` → ACT NO crea `DocumentFile` (metadatos en `real_estate_documents`); el job de retención de T9 solo borra claves de `DocumentFile` (las de ACT no se tocan); `sendBinary` no exportado → copiado (6 líneas) |
| 3 | Anclas del schema (`Property` :438, `CapexProject` :4331…) | schema 7.281 líneas: `Property` :518 (`cadastralReference` :566, `surfaceM2` :567), `CapexProject` :5196-5211, `FixedAsset` :5228, `JournalEntry` :4312 (`sourceType/sourceId`), Compliance* :6429-6526 → los 10 modelos se añadieron al final (+421) |
| 4 | `server.ts` registro :2846, capex :5990-6081, `PATCH /capex-projects/:id` sin `supervisorAuthorizationId` | 8.975 líneas: `registerFixedAssetsRoutes` :2962 (ACT registra en :2966-2968), capex `PATCH` :6260 (**sigue sin `supervisorAuthorizationId`**, §9.2); guardia global `pickPropertyId` → `grantPropertyAccess` cubre toda ruta `/properties/:propertyId/*` → **ACT no edita `tenancy.ts`** (`/capex-projects/:id/*` usa el resolver existente) |
| 5 | Manifiesto: 19 partials; capex :784 | 44 partials (+1 agregador ACT); capex `GET` `capex.read`, `POST/PATCH` `capex.create` (T8a); drafts `accounting.journal.post` + `post` `ai.high_risk.confirm`; el contrato acepta partials con 0 entradas y agregadores solo-spread, pero exige rutas literales en todo `*.routes.ts` → agregador renombrado `real-estate.register.ts` |
| 6 | `asset_manager` 27 claves, versión 2, 6 claves nuevas del diseño | `ROLE_TEMPLATE_VERSION = 4`; `asset_manager` 29 (sin `documents.*`); las 4 claves inmobiliarias existen desde T8a → **0 claves nuevas**; `accounting.journal.post` solo `accountant` → contabiliza el borrador |
| 7 | Techo Cocoa 679 | **647** (`cocoa-22-contract:175`); sin cambio tras 6 pantallas |
| 9 | `lib/env.ts` 2 variables «Schedulers» + digest | Sin scheduler / digest → solo las 2 variables del seed (`ACT_DEMO_PASSWORD`, `SEED_ACT_ALLOW_PRODUCTION`, sección «Seeds») + censo regenerado |
| 10 | `createExpense` contamina el libro de IVA; opción `skipVatBook` | No se usa: `JournalEntry draft` por `createJournalEntryDraft` (cuadre, cuentas, centro, ejercicio abierto → 409 `FISCAL_YEAR_CLOSED`); `expenses.service.ts` intacto |
| 11 | `createFixedAsset` asienta al capitalizar | Solo escribe el registro → capitalizar = fila sin asiento |
| 12 | Sage sintético (631 «IBI 2025» 41.940 €, 621 solo OC) | **Carga real hecha** (143.056 asientos `sage200_journal`): 631 real 2025/2026 en AS · LT · MC · OC · PG · RA; **621 en todos los centros** (la inferencia «7 en propiedad + OC arrendada» no vale → titularidad = decisión de César); 625 solo OC; plan de 10 dígitos con el centro en las cifras 5-6 mapeado a 210/211; **23x sin movimientos** → ejecución de capex leída de 21x por prefijos |
| 13 | 275 tablas; catastral NULL ×8 | 297 → **306** tablas; censo igual (catastral / superficie NULL ×8) |
| 14 | Diseño §7: 6 claves (223 → 229); §9 L0 toca `permissions` / manifiesto | Obsoleto: 4 claves de T8a; `permissions.ts` / `types.ts` / manifiesto capex intactos |
| 15 | CSV: orden Finanzas 1-8 | Orden 1 Facturación … 8 Nóminas → **ACT = 9** |
| 16 | `role-tokens.ts:251` `activos` → `/cumplimiento/centro` | Cambiado en F4 a `/finanzas/activo-inmobiliario` (comentario :216-222 actualizado) |
| 17 | Contratos: `DEMO_ORG_IDS` pineado en 2 tests | Pineado en **4** (`seed-ux-day`, `seed-checkin`, `demo-seed` guarded, `refresh-demo-dataset.test.mts:306`): los 4 re-anclados |
| 18 | `compliance-assistant` OCR :136 | `extractComplianceDocumentDates` :202; fuera de alcance |
| 19 | `App.tsx :110/:123`, `api-client.ts:292` | `lazyTab` :77-81, mapa :262-290; tab host `NavItemTabs` (`screens/tabs/NavItemTabs.tsx:53`), patrón `ProveedoresTabs.tsx`; `apiRequest` :225 / `apiRequestBlob` :369 |
| 20 | Runbook `finanzas-contabilidad.md` §3/§13; `CLAUDE.md` | `finanzas-schema-contract:206` es lista cerrada → los modelos ACT NO van a ese runbook (runbook propio); `CLAUDE.md` no se edita (bloques de estado en `ESTADO-VERIFICADO.md`) |
| 21 | Tests de integración | Helper `l2-tenant.mts` (`createIsolatedTenant`, `loginOrThrow`, `farandaInvariants`, `cleanupTenant`) reutilizado por las 6 suites; ejecución desde `apps/api` con `--env-file-if-exists=../../.env` |
| 23 | Seeds | Patrón `seed-checkin.ts` (`assertDemoTarget`, `deleteScoped`) → `seed-real-estate.ts` con `org_act` |

Puntos del dosier §4 que NO se ejecutaron tal cual (y por qué): `expenses.service.ts` (`skipVatBook`) — innecesario con el
borrador de asiento; `lib/tenancy.ts` (+7 resolvers) — cubierto por la guardia global; `modules/assets/assets.service.ts`
— la capitalización vive en `works.service.ts` sin tocar la aprobación; `treasury.service.ts`, `usali.service.ts`,
`statement-render.ts`, `dashboards/*` — fuera (decisión §2 #6); `seed-compliance.ts`, `property-provisioning.service.ts`
(CCAA) — fuera; `RealEstateContractsScreen` — no existe (pólizas y tenencias van en «Inspecciones y seguros»); `digest.service.ts`
/ `operations.routes.ts` / `kpis.service.ts` — no existen (alertas en `alerts.service.ts`, KPIs en `group.service.ts`).

---

## 6. Verificación en runtime

**Antes de la corrección (ACT-Z, 20/09 12:5x; documenta el estado que encontraron los revisores).** Instancias: API `PORT=3925 RUN_SCHEDULERS=false TENANT_BOOTSTRAP_SKIP=true node
--env-file-if-exists=../../.env --import tsx src/server.ts` desde `apps/api` del worktree (PID 42441, `/health` `healthy`,
`objectStorage inline`; log `scratchpad/ACT/api-3925-z.log`) y Vite `VITE_API_URL=http://127.0.0.1:3925 corepack pnpm
--filter @hotelos/admin-web dev --port 5195` (PID 45472, `vite-5195-z.log`); ambas paradas por PID al terminar. `:3925` y
`:5195` estaban libres al empezar.

**Smoke HTTP (`scratchpad/ACT/smoke-z.sh` → `smoke-z.out`, solo lectura, tenant `org_act` del seed L7 tal como lo dejó F4):**

| Usuario | Petición | Resultado |
|---|---|---|
| `activos@act.test` (`asset_manager`, ámbito `le_act`) | `GET /properties/prop_act_a/real-estate` | 200 · «Edificio Hotel ACT Norte» · 1 unidad · 1 valoración · tenencia `propiedad vigente` · `kpis` catastral 2.400.000,00 / tasación 9.800.000,00 / `valuePerRoom` 81.666,67 · **`taxes: []`, `annualTaxBurden null`, `openAlerts 0`, `alerts []`** (cableado pendiente §9.1) |
| | `GET …/taxes` · `…/receipts?year=2026` · `…/tax-calendar?year=2026` | 200 · 3 tributos (IBI 27.240 · IAE 3.900 · residuos 1.200, cuenta 631) · 5 recibos (PAC-01 `pagado` con asiento `posted` `cmu9ogn7r000lfy4t8y7wfjqp` —lo contabilizó F4—, PAC-02 / IAE / residuos / PAC-03 `previsto`) · calendario 10 eventos |
| | `GET …/alerts` | 200 · **7**: `INSPECTION_OVERDUE` alta · `CAPEX_LICENCE_MISSING` alta · `INSURANCE_EXPIRING` media · `DOCUMENT_EXPIRING` baja · `TAX_DUE` baja ×3 |
| | `GET …/calendar?year=2026` · `…/works` · `…/inspections` · `…/insurances` · `…/valuations` · `…/tenures` | 200 · 13 eventos · «Sustitución enfriadora» `in_progress` 48.000 / ejecutado **31.500 (`ledger`)** / licencia exigida sin documento (1 alerta) · OCA BT `vencida`, OCA ascensor `en_plazo` (10-03-2027), CEE 2031 · multirriesgo hasta 30-10-2026 (aviso 60) y RC hasta 31-03-2027 · ECO 805 30-06-2025 9.800.000 · propiedad desde 15-06-1998 |
| | `GET …/documents` | **404 «Route … not found»** (L3 #1: rutas de documentos sin llamar desde `real-estate.register.ts`; el partial existe → el manifiesto y los contratos las conocen) |
| | `GET /organizations/org_act/real-estate/overview` · `…/calendar?year=2026` · `…/export?format=csv&what=overview&year=2026` | 200 · 2 filas (Norte `propiedad` 2.400.000 / 9.800.000 / carga fiscal **32.340,00** / docs 88,89 % (87,50 % en el seed + 1 documento vivo que dejó F4) / insp. 66,67 % / 7 alertas, 2 altas; Sur `arrendamiento_industria` sin catastral / tasación / carga, docs 50 %, insp. 0 %, 2 altas) · totales 2 centros · 9 alertas (4 altas) · 16 eventos · CSV `text/csv` con BOM, `;`, 3 líneas, `attachment; filename="activo-inmobiliario-overview-2026.csv"` |
| | `GET /properties/prop_act_b/real-estate` · `…/alerts` | 200 · «Edificio Hotel ACT Sur» · 2 alertas: `DOCUMENT_EXPIRED` alta (CEE 2025), `INSPECTION_OVERDUE` alta |
| `contabilidad@act.test` (`accountant`) | `GET …/real-estate` · `GET …/receipts` · `POST …/taxes {}` | 200 (`real_estate.read`) · recibo PAC-01 con `journalEntryStatus posted` · **403 «requiere: property_tax.manage»** |
| `recepcion@act.test` (`receptionist`) | `GET …/real-estate` · `GET /organizations/org_act/real-estate/overview` | **403 «requiere: real_estate.read»** ×2 |

**Navegador (`scratchpad/ACT/rt-z.mjs`, Playwright del repo, solo lectura → `rt-z.json`; capturas
`scratchpad/ACT/capturas/z-01…z-10`; la parte con escritura —subida de PDF, «Proponer asiento», «Contabilizar»— la dejó
verificada F4 en `rt-f4.json` y `f4-01…08`):**

| Paso | Usuario | Visto |
|---|---|---|
| Aterrizaje | `activos@act.test` | `roleHome` = `/finanzas/activo-inmobiliario`; sidebar con «Activo inmobiliario»; 6 pestañas (Ficha · Documentación · Tributos · Obras · Inspecciones y seguros · Grupo); Ficha con KPIs (valor catastral, última tasación, valor por habitación 81.666,67 €, carga fiscal «—», alertas abiertas 0: §9.1), finca «PLENO DOMINIO» con referencia catastral, callout «Propietaria: ACT Pruebas Inmobiliarias SL · VIGENTE», «Próximos 90 días» con 6 vencimientos (`z-01`, 1.280 px); a 400 px las 6 pestañas y `scrollWidth` 400 = sin desbordamiento (`z-02`) |
| Documentación | id. | estado de error de la pantalla (0 filas) por el 404 del API (`z-03`; el `console.error` es el 404 del recurso); con las 2 líneas del §9.1 vuelve el listado (verificado por F2/F4 con el lanzador que cablea las rutas) |
| Tributos › Recibos | id. | 5 filas; el IBI PAC-01 «Pagado 15/06/2026 · Banco · Asiento contabilizado»; cajón sin botón «Contabilizar» para `asset_manager` (no tiene `accounting.journal.post`) (`z-04`) |
| Obras | id. | «Sustitución enfriadora» con aviso de licencia y ejecución 31.500,00 (`z-05`); segundo `console.error` = 404 del selector de documentos de licencia (degrada a campo de texto, F3 #4) |
| Inspecciones y seguros | id. | OCA BT «vencida», pólizas RC y multirriesgo (`z-06`) |
| Grupo | id. | 2 filas (Norte / Sur), totales 2.400.000,00 / 9.800.000,00, 2 botones «Exportar» (vista + calendario) (`z-07`) |
| Tributos › Recibos | `contabilidad@act.test` | aterriza en `/hoy/direccion`; ve el ítem; cajón del IBI con «Asiento contabilizado» y el botón «Contabilizar» presente (`z-08`); Diario con la línea «IBI 2026 (PAC-01)» |
| Activo inmobiliario | `recepcion@act.test` | aterriza en `/hoy`, sin ítem en el menú; URL directa → «Sin acceso · Tu perfil no tiene permiso para ver esta pantalla» a 1.280 y 400 px (`z-09`, `z-10`) |

Datos tocados en `org_act` por las verificaciones de la tanda (F4, aceptables o se rearman con `db:seed:real-estate --
--reset`): documento `red_94bd9059d8d1fec5` «escritura-prueba-f4» (vivo) + 2 retirados, recibo IBI PAC-01 con asiento
contabilizado n.º 2. ACT-Z no escribió nada (solo logins). Faranda: 0 escrituras en toda la tanda (todas las suites usan
tenants `org_l2_*` con limpieza; `farandaInvariants` idénticas).

**Tras la corrección (ACT-INT, tras la puerta final de las 14:56; instancia propia `PORT=3925 RUN_SCHEDULERS=false
TENANT_BOOTSTRAP_SKIP=true RBAC_STRICT=true HOTELOS_ALLOW_DEMO_AUTH=false HOTELOS_DEMO_PERMISSION_UNION=false node
--env-file-if-exists=../../.env --import tsx src/server.ts` desde `apps/api`, PID 37752, `/health` `healthy` a los 2 s, log
`scratchpad/ACT/api-3925-int.log`; smoke de solo lectura `scratchpad/ACT/smoke-int.mjs` + `smoke-int2.mjs` → `smoke-int.out`;
`:3925` / `:5195` con 0 listeners antes y después; 0 respuestas 5xx; el tenant `org_act` tal como lo dejó el `--reset` del
corrector):**

| # | Usuario · petición | Resultado |
|---|---|---|
| 1 | `activos@act.test` · `GET /properties/prop_act_a/real-estate` | 200 · `kpis` catastral 2.400.000,00 · tasación 9.800.000,00 · `valuePerRoom` 81.666,67 · **`annualTaxBurden` 32.340,00 · `documentsValidPct` 87,50 · `inspectionsOnTimePct` 66,67 · `openAlerts` 7** · `alerts` 7 (2 altas) · `taxes` 3 — REV-06 cerrado (antes: `[]`, `null`, 0) |
| 2-3 | `GET …/documents` · `?category=licencias` | **200 · 9 filas** (estados `sin_fecha / sustituido / caduca_pronto / vigente`; 0 con fichero: el seed son metadatos) · 200 · 1 — REV-01 cerrado (antes 404); el selector de licencia de Obras vuelve al `CocoaSelect` (F3 #4) |
| 4-5 | `GET /properties/prop_act_b/real-estate/documents` como `activos` / como `contabilidad@act.test` | 200 · 2 (`interno` + `solo_propiedad`) / **200 · 1 (`solo_propiedad` oculto al contable)** — ACT-REV-03 |
| 6-7 | `GET …/works` · `POST /capex-projects/<id>/approve` como `activos` | 200 · «Sustitución enfriadora» `in_progress` · ejecutado 31.500,00 (`ledger`) · 1 alerta · **403 «requiere: asset.capex.approve»** (la ruta existe; antes 404) — REV-05 |
| 8 | `GET /organizations/org_act/real-estate/overview` | 200 · 2 filas · Norte carga 32.340,00 / docs 87,50 % / insp. 66,67 % / 7 alertas **= la ficha** · totales 9 alertas |
| 9 | `GET …/calendar?year=2026` | 200 · 13 eventos · etiqueta «**Pagado el 15/06/2026** · IBI 2026 (PAC-01)» — REV-15 |
| 10 | `GET …/receipts?year=2026` | 200 · 5 · PAC-01 `pagado` 2026-06-15 · `journalEntryId null` (estado del seed) |
| 11 | `GET …/inspections` | 200 · 3 · `oca_ascensor` `legalBasis` «RD 355/2024 art. 11.4.a» — REV-16 |
| 12-13 | `recepcion@act.test` `GET …/real-estate` · `contabilidad@act.test` `POST …/taxes {}` | 403 «requiere: real_estate.read» · 403 «requiere: property_tax.manage» |
| 14-15 | `GET …/export?format=csv&what=calendar` · `what=overview` | 200 `text/csv; charset=utf-8` · `attachment; filename="activo-inmobiliario-calendar-2026.csv"` · 17 líneas · 200 · **bytes `EF BB BF`**, CRLF, 3 líneas |
| 16 | `POST …/receipts/ptr_act_a_ibi_2026_pac01/propose-entry` como `activos` | **409 `RECEIPT_ENTRY_EXISTS`** con `details.journalEntryId cmu9ogn7r000lfy4t8y7wfjqp` y mensaje «enlázalo (o anúlalo)» — REV-03 funciona **y destapa un resto del demo**: el asiento n.º 2 que contabilizó F4 quedó huérfano tras el `--reset` (§9.1 #15); nada escrito |

Datos en `org_act` tras la ronda (SELECT): 11 documentos vivos · 0 retirados · 0 con fichero; 5 recibos · 0 con asiento
enlazado; 2 asientos (`cmu9ogn7r000lfy4t8y7wfjqp` posted n.º 2 `property_tax_receipt` 15/06/2026 sin recibo que lo enlace, y
`je_act_a_enfriadora_1` posted re-sembrado como n.º 3); 1 obra `in_progress` sin capitalizar; 4 inspecciones · 2 pólizas; 0
organizaciones `org_l2_*` residuales; 25 migraciones aplicadas. La verificación con escritura en navegador (subida de PDF y
visor, «Proponer asiento», «Contabilizar») la dejó F4 en `rt-f4.json` / `f4-01…08` y la re-verificó el revisor funcional en
`:5195` (`scratchpad/ACT/REV/`); el corrector re-verificó en `:3925` (PID 75059) documentos 200, ficha = fila de grupo,
`solo_propiedad`, `approve` 403, etiquetas del calendario y OCA.

---

## 7. Hallazgos de los revisores (ronda del 20/09 13:20-14:56)

Proceso: dos revisores independientes sobre el worktree tras ACT-Z — **funcional-runtime** (instancia propia `:3925` +
Vite `:5195`, smokes `scratchpad/ACT/REV/smoke-rev.mts` y `smoke-rev2.mts` con tenants aislados y `org_act`, navegador) y
**seguridad-datos-regresiones** (`scratchpad/ACT-REV/verify.mts`, lectura del diff, puerta `ACT-REV/gates-quick-rev.json`
12/12) —, dedupe (REV-01 y REV-05 los levantaron ambos), refutación con contraprueba, corrector con test por hallazgo, dos
puertas completas (`gates-full-rev.json` 11/14 → `gates-full-rev2.json` 13/14) y puerta final `ACT/gates-final.json` 13/14.
Resultado: **12 confirmados** (10 funcional + 2 seguridad), **1 refutado**; el corrector cerró además **11 de menor
severidad** que no entraron en la lista confirmada por el corte (REV-12…17, ACT-REV-05…09) y dejó **3 sin corregir con
motivo** (§7.3). Los comentarios del código abrevian los ids (`ACT-REV-05` nombra tanto la ruta de aprobación
funcional-runtime-REV-05 como el `csvCell` de seguridad-datos-regresiones-ACT-REV-05); aquí se usa el id completo.

### 7.1 Confirmados y corregidos

| Id · sev. | Hallazgo (evidencia del revisor) | Corrección (fichero · test) | Verificado en ACT-INT (§6) |
|---|---|---|---|
| funcional-runtime-REV-01 · alta (dupe) | Las 6 rutas de documentos no existían en el producto: `real-estate.register.ts` no importaba ni llamaba a `registerRealEstateDocumentRoutes` → 404 «Route … not found» en `server.ts`, pestaña Documentación y selector de licencia de Obras rotos; los contratos estáticos no lo detectaban | `real-estate.register.ts` import + llamada; `real-estate-core.test.mts` cruza las **42** entradas de los partials con `app.hasRoute` (una entrada sin ruta rompe la puerta) | `GET …/documents` 200 (9) · `?category=licencias` 200 (1) |
| funcional-runtime-REV-02 · alta | `PATCH /capex-projects/:id` heredado escribía cualquier `status` sin máquina: `proposed → completed` sin aprobación ni licencia, capitalizar y volver a `proposed` conservando `capitalizedFixedAssetId`; `cancelled` sobre `completed` | `assets.service.ts` `updateCapexProject`: `assertTransition CAPEX_WORK` (409 `CAPEX_NOT_COMPLETED`), 409 `CAPEX_ALREADY_CAPITALIZED`, 409 `LICENCE_REQUIRED` para `in_progress` sin licencia, `approved → approved` 409 · `real-estate-works.test.mts` «PATCH heredado respeta la máquina…» | — (cubierto por integración) |
| funcional-runtime-REV-03 · alta | `journalEntryId: null` se admitía con asiento contabilizado y `propose-entry` solo miraba `receipt.journalEntryId` → segundo asiento D 631 por el mismo recibo (Σ 631 = 12.000 para un recibo de 6.000) | `property-tax.service.ts`: desenlazar un asiento propio `posted` → 409 `RECEIPT_ENTRY_EXISTS` (`details.journalEntryStatus`); desenlazar un borrador propio lo descarta; `propose-entry` rechaza cualquier asiento no anulado por (`organizationId`, `sourceType`, `sourceId`) · `real-estate-taxes.test.mts` ×2 + `property-tax.test.mts` | `propose-entry` sobre PAC-01 → 409 con `details.journalEntryId` (fila 16) |
| funcional-runtime-REV-04 · alta | Con borrador enlazado (D 631 / H 475) el recibo pasaba a `pagado` solo por estado; el borrador no se recalculaba y el contable contabilizaba H 475 de un recibo pagado por banco (la pantalla Tributos usaba ese camino) | pagar con borrador propio → **borrador regenerado** (H 57x; `RECEIPT_ENTRY_LINKED source regenerated`); con asiento propio `posted` → **borrador de pago** D 475 / H 57x (`sourceType property_tax_receipt_payment`, auditoría `RECEIPT_PAYMENT_ENTRY_PROPOSED`); `buildReceiptPaymentProposal` puro; front `PAID_FIELDS_LOCKED` alineado · unit + integración | — |
| funcional-runtime-REV-05 · alta (dupe) | Ninguna plantilla reúne `capex.create` (manifiesto del `PATCH`) + `asset.capex.approve` (servicio) → nadie aprobaba por HTTP; sin `approved`, `/work` responde 409 desde `proposed`: flujo de Obras muerto de extremo a extremo y botón «Aprobar» nunca habilitado | ruta propia **`POST /capex-projects/:id/approve`** (`works.routes.ts`, partial `asset.capex.approve` · high, `api-reference` «Aprobar el proyecto de inversión (nunca quien lo propuso).»); front `approveCapexProjectRequest` → `POST …/approve`, `canApprove = canDo(asset.capex.approve)`; runbook §3 / §6.1 / §6.2, `api-contracts`, diseño §7, `docs-contract` 41 → 42 · `approveProject` de la integración vía la ruta | `approve` como `activos` → 403 «requiere: asset.capex.approve» (no 404) |
| funcional-runtime-REV-06 · alta | `GET /properties/:id/real-estate` solo calculaba alertas de tenencia y devolvía `taxes: []`, `annualTaxBurden / documentsValidPct / inspectionsOnTimePct null`: la Ficha pintaba «Carga fiscal anual —» y «0 alertas» mientras `/alerts` y el grupo daban 7 y 32.340,00 | `getRealEstateAssetDetail` usa `getRealEstateAlerts`, lista `taxes` y `computeRealEstateKpis` ampliado con las definiciones del grupo (`computeAnnualTaxBurden`, `documentsValidPctOf`, `inspectionsOnTimePctOf`) · `real-estate-service.test.mts` + `real-estate-group.test.mts` (ficha = fila = `/alerts`) + core | `kpis` 32.340,00 / 87,50 / 66,67 / 7 (2 altas) = fila de grupo (filas 1 y 8) |
| funcional-runtime-REV-08 · media | Activar una tenencia no proponía `PropertyTax.taxpayer` según `ibiPayer` (diseño §5.1): con arrendamiento e `ibiPayer propietario` el IBI seguía a nombre de la sociedad y el módulo proponía el 631 de un tributo que paga un tercero | `tenure.service.ts` `ibiTaxpayerFor` + `proposeIbiTaxpayer` al activar o al cambiar `kind` / `ibiPayer` de la vigente (propiedad + propietario → `sociedad`, propiedad + arrendatario → `arrendatario`, inmueble de tercero → `propietario_tercero`); auditoría `PROPERTY_TAX_UPDATED source tenure` · `tenure.test.mts` + integración `taxes` | — |
| funcional-runtime-REV-09 · media | Un recibo vencido que pasaba a `recurrido` desaparecía del motor de alertas y del calendario (el servicio filtraba `previsto \| recibido \| domiciliado`; el motor puro sí lo etiqueta «(recurrido)») | `alerts.service.ts` `RECEIPT_STATUSES_WITH_ALERT` incluye `recurrido` (+ `paidAt null`) · integración `taxes` («TAX_OVERDUE (recurrido) persiste; pagar lo quita») + unit | — |
| funcional-runtime-REV-10 · media | Máquina RECEIPT con `pagado` final: no se podía recurrir un recibo pagado (diseño §5.1: «Recurrir» desde cualquier estado); el front replicaba la tabla | `state-machines.ts` `pagado: [recurrido]`; `isReceiptPaid / isReceiptOverdue` con `paidAt`; propuesta y calendario tratan `recurrido` con `paidAt` como pagado; copia del front `RECEIPT_TRANSITIONS` + mensaje; runbook §3 · unit / front / integración | — |
| funcional-runtime-REV-11 · media | Documentos `cdeState wip` visibles y descargables por cualquier `real_estate.read` (diseño §5.1: «hasta entonces solo lo ve quien lo subió»); sin acción «Publicar» | `documents.service.ts` `isDocumentVisibleTo`: `wip` solo `uploadedBy` (siempre el actor) o `real_estate.manage`, aplicado en listado y `requireDocument` (404 opaco en `file` / `PATCH` / `versions` / `supersedesId`); «Publicar» = `PATCH cdeState publicado` (documentado) · unit + integración `documents` | — |
| seguridad-datos-regresiones-ACT-REV-02 · media | Las suites de integración cableaban ellas mismas las rutas ausentes (`documents` en `real-estate-documents` y `real-estate-group`; `group` en `real-estate-group`) → puerta verde (1.048 · 0 fail) con el producto en 404; borrar la línea del register no rompía ninguna suite | fallback `hasRoute` sustituido por `assert.ok(app.hasRoute(...))` en las dos suites; cruce inverso manifiesto → `app.hasRoute` en `real-estate-core` | — |
| seguridad-datos-regresiones-ACT-REV-03 · media | `confidentiality = solo_propiedad` se guardaba, heredaba y pintaba pero ningún código lo aplicaba: cualquier plantilla con `real_estate.read` (manager, accountant, auditor, admin_clerk, maintenance_manager…) veía y descargaba, p. ej., el contrato de arrendamiento de industria de B con renta y fianza | `canSeePropertyOnlyDocuments` (`real_estate.manage` o asignación con plantilla `owner`) en listado y descarga; `api-contracts` y runbook §5; unit + integración | `contabilidad` en B ve 1 documento (`solo_propiedad` oculto), `activos` 2 (filas 4-5) |

Menores cerrados por el corrector (no entraron en la lista confirmada por el corte; todos con test):

- **funcional-runtime-REV-12** — fecha de alta del inmovilizado al capitalizar = fin de obra (`acquisitionDate` del cuerpo |
  `targetEndDate` ya cumplido | hoy; `capitalizationDateFor`, `CapexCapitalizeSchema`; cliente con cuerpo opcional; runbook §1,
  `api-contracts`; `works.test.mts` + integración) — antes siempre «hoy» (L4 #5d).
- **REV-13** — `REAL_ESTATE_ALERT_ENTITY_TYPES` + `property_tax`: los periodos previstos sin recibo enlazan al tributo (era
  L6 #3 / §9.1 #7); front «Tributo»; `calendar.test.mts` + integración `taxes`.
- **REV-14** — una tenencia `vigente` con `endDate` pasado (`vencido` derivado) ya no admite edición: 409
  `TENURE_INVALID_TRANSITION` (`deriveTenureStatus` antes de escribir); integración `core`.
- **REV-15** — etiquetas del calendario en español («Pagado el 15/06/2026», «18.000,00 €»; `formatDay` / `formatMoneyEs` en
  `vigencias.ts`); `vigencias.test.mts` + integración.
- **REV-16** — base legal de la OCA de ascensor del seed corregida a «RD 355/2024 art. 11.4.a»; re-sembrado con `--reset`.
- **REV-17** — `REAL_ESTATE_INSURANCE_PATCH_STATUSES` (`vigente | cancelada`) en el contrato compartido y en
  `RealEstateInsurancePatchSchema` (el guard redundante en runtime se retira); test de esquema.
- **seguridad-datos-regresiones-ACT-REV-05** — inyección de fórmulas en CSV: `csvCell` neutraliza `= + - @ \t \r` con
  apóstrofo y comillas en `real-estate/export.service.ts` y en `accounting.service.ts` (exportada); `export.test.mts` y
  `ledger-engine.test.mts`.
- **ACT-REV-06** — descripción del manifiesto de capitalizar pinada literalmente («Capitalizar el proyecto de inversión (alta en
  el registro de inmovilizado; sin asiento).», `api-reference.test`) para que no vuelva a sugerir un asiento.
- **ACT-REV-07** — `tests/rbac-nav-contract` `loadManifest` lee `*route-permissions.partial.ts` y resuelve spreads anidados: las
  42 entradas entran en el cruce plantilla × pantalla (0 huecos, sin `JUSTIFIED_GAPS` nuevos; era L1 #4 / §9.1 #9).
- **ACT-REV-08** — NIF de contraparte / titular / acreedor enmascarados `***123` en la auditoría de tenencias, unidades y
  cargas (`maskTaxId`, `auditProjectionOf`); unit.
- **ACT-REV-09** — runbook §5 documenta la cascada de la FK, que no existe `DELETE` de ficha, que el `--reset` del seed solo
  cubre `inline` y que no hay purga del almacén (solo documentación).

### 7.2 Refutados (con motivo)

- **funcional-runtime-REV-07** («el alta de la ficha no crea los `PropertyTax` IBI / IAE que fija el diseño §5»): el código
  coincide con la evidencia (`createRealEstateAsset` no crea tributos), pero la premisa está superada — el brief delega
  «tributos como registros manuales… nunca contabilizado automáticamente» sin excepción para el alta, la nota §9 del diseño
  separa ACT-L1 (ficha) de ACT-L2 (tributos con `POST …/real-estate/taxes`), el comentario `real-estate.service.ts` («Tributos:
  ACT-L2 … los rellena») documenta la decisión y este informe la recoge en §2 y §3; `createPropertyTax` /
  `generatePropertyTaxReceipts` existen y funcionan. Decisión de arquitectura documentada, no un hueco.

### 7.3 Lo que el corrector dejó sin corregir a propósito

- **seguridad-datos-regresiones-ACT-REV-10** (instancia huérfana en `:3925`): no existía — `lsof` 0 listeners antes y después
  (la instancia del corrector, PID 75059, parada por PID); nada que corregir.
- **ACT-REV-11** (baja): un `GET …/documents` respondió 403 en la primera carga de la pestaña Documentación (F4 #7); no
  reproducido ni acotado, sin cambio en `RealEstateDocumentsScreen` → §9.1 #14.
- **ACT-REV-12**: `pnpm-lock.yaml` intocable por regla (mtime 08:53, previo al carril) → fuera del commit (ACT-INT lo excluye
  con `git reset -q hotelos/pnpm-lock.yaml`).
- **Puerta `nav-tree --check`** en rojo por causa externa (CSV compartido con 4 filas RRHH sin pantalla en este worktree; §4):
  no corregible desde el worktree sin editar el CSV compartido ni sin arrastrar rutas de otro carril.

---

## 8. Qué es real y qué no (degradación honesta)

| Pieza | Estado en el carril (sin datos ni cuentas de César) | Con lo que César aporte |
|---|---|---|
| Ficha e inmueble | Datos manuales (referencia catastral validada solo en forma y dígitos de control; sin consulta al Catastro ni tasadora); `Property.cadastralReference` de Faranda sigue NULL ×8 y ninguna ficha real existe | Notas simples, certificaciones catastrales, tasaciones (§10 #2, #10) |
| Titularidad | `RealEstateTenure` por centro (propiedad / arrendamiento / industria / gestión…) sembrada solo en `org_act`; la BD de Faranda no la conoce y el diario real (621 en todos los centros) no permite inferirla | Contrato y contraparte por hotel (§10 #1) |
| Tributos | Recibos manuales o previstos por `installmentsJson` / calendario municipal (**solo Madrid 28079 verificado**; Santander, Oviedo, Teo, Carreño, Gijón y Oleiros en el supletorio LGT 62.3 01-09 → 20-11); asiento propuesto en borrador que asienta un contable; un asiento contabilizado no se desenlaza (409) y el pago con borrador lo regenera o propone el asiento de pago (§7.1); sin domiciliación conciliada ni previsión de tesorería | Ordenanzas y recibos 2025-2026 (§10 #3), decisión sobre devengo 1/12 e IAE (§10 #7) |
| Documentos | Almacén de T9 (`inline` en demo; `disk` cifrado o `s3` con la configuración de T9); sin OCR («fechas a mano»); sin job de purga (`retentionUntil` informativo); los 11 documentos del seed son metadatos sin fichero (el visor solo se abre con los subidos a mano); `cdeState wip` solo lo ve quien lo subió y `solo_propiedad` solo `real_estate.manage` / `owner` (§7.1) | Escrituras, licencias, CEE, actas, contratos (§10 #4), almacén y clave (§10 #8) |
| Obras | Ejecución por prefijos 21x del diario del centro (23x vacío en Sage), ICIO provisional, capitalización = fila de inmovilizado sin asiento con fecha de fin de obra; **aprobación por HTTP con `POST /capex-projects/:id/approve`** (`asset.capex.approve`: owner / general_manager / controller) y `PATCH` heredado con máquina de estados (§7.1) | Prefijos reales por centro y criterio de certificaciones (§10 #6) |
| Inspecciones y pólizas | Registro manual con máquina de estados, sucesora automática y `ComplianceItem` sincronizado; sin `SafetyCheck` / `ComplianceTask` / mantenimiento; `vence_pronto` no es estado del DTO | Actas OCA, contratos de conservación, pólizas (§10 #4, #5) |
| Alertas y calendario | Calculadas en cada lectura (ficha, `/alerts`, obras, grupo y calendario con las mismas definiciones desde §7.1); sin resumen diario ni correo | Responsable y umbrales (§10 #9) |
| USALI / cartera | Sin fila FF&E ni tarjeta en el cuadro de mando | Decisión del asesor (§10 #7) |
| Demo | Solo `org_act` (`db:seed:real-estate`); `org_123` y Faranda sin fichas; el fallback sin login (`usr_123`) no tiene `real_estate.*` | `rbac:sync` real no hace falta (0 claves nuevas); datos reales (§10) |

---

## 9. Deuda y pendientes que deja la tanda

### 9.1 Antes o durante la fusión (orquestador)

Cerrados por la ronda de revisión (se dejan numerados para que las referencias de los lotes sigan valiendo):

1. ~~Rutas de documentos en `real-estate.register.ts`~~ — cerrado (REV-01 / ACT-REV-02): registradas y cruzadas con
   `app.hasRoute` por `real-estate-core`; verificado 200 en §6.
2. ~~Ficha completa (`taxes`, `kpis`, `alerts`)~~ — cerrado (REV-06): ficha = fila de grupo = `/alerts`.
3. ~~Hueco RBAC de la aprobación de obras~~ — cerrado (REV-05 / REV-02): `POST /capex-projects/:id/approve` con
   `asset.capex.approve`; el `PATCH` heredado respeta la máquina.
7. ~~`REAL_ESTATE_ALERT_ENTITY_TYPES` sin `property_tax`~~ — cerrado (REV-13).
9. ~~`rbac-nav-contract` ciego a los partials con prefijo~~ — cerrado (ACT-REV-07).

Abiertos:

4. `apps/api/src/schemas/index.ts` sin `export * from "./real-estate.schemas.js";` (L0a; los lotes importan de
   `../../schemas/real-estate.schemas.js`; patrón hub de `documents.schemas`).
5. Comentario `installmentsJson [{ label, dueOn (MM-DD), pct }]` en `schema.prisma:7520` frente al wire `{ label, dueFrom,
   dueTo, pct }` que persiste L2 (cosmético; runbook §2 lo deja constancia).
6. `PROPERTY_TAX_INACTIVE` (L2 #3) no está en `REAL_ESTATE_ERROR_CODES` (va como `details.code` de un 409 genérico); si se
   añade al catálogo, quitarlo de `REAL_ESTATE_EXTRA_ERROR_CODES` del front (F0 #7d) y mover su fila en §7 del runbook (D1 #5).
8. Tipos duplicados en el front (F0 #2/#3, F2 #9, L6 #4): `RealEstateCalendarYear/Month/Property` (viven en
   `calendar.service.ts`), respuestas compuestas (`PropertyTaxWithReceipts`, `RealEstateWorksResponse`,
   `CapexCapitalizationResult`, `ProposedEntryPosted`…), 24 tipos de cuerpo espejo de `real-estate.schemas.ts` y
   `RECEIPT_TRANSITIONS` (`RealEstateTaxesScreen.tsx`, actualizado a mano por REV-10) → mover a
   `packages/shared/src/real-estate-types.ts`.
10. **Docs desalineadas** (fuera de los ficheros de este lote; un solo pase del orquestador): `docs/runbooks/activo-inmobiliario.md`
    §11 (`:469-470`) sigue diciendo «Cableado pendiente del orquestador: rutas de documentos en `real-estate.register.ts`
    (ACT-L3 #1), `taxes` / `kpis` / `alerts` completos en la ficha (…), hueco RBAC de la aprobación de obras (L4 #3)» — los
    tres están cerrados (§7.1; el propio runbook §10 `:458` ya dice «registradas desde `real-estate.register.ts` (ACT-REV-01)»)
    → retirar esas tres frases y dejar `schemas/index.ts`, `installmentsJson`, tipos y `RECEIPT_TRANSITIONS`; runbook §10 `:442`
    lleva `dev -- --port 5195` (la forma que funciona es `dev --port 5195`, F4 #6); `docs/api-contracts.md:842` «El
    manifiesto tiene **1031 entradas**» (real **1.073**; `api-route-permissions-contract` no pina la cifra); diseño §8 nombra 7
    pestañas y `RealEstateContractsScreen` (no existe; pólizas y tenencias van en «Inspecciones y seguros»); `pilots/tanda5-nav-tree.md`
    §1 Finanzas con 8 ítems (F4 #5); diseño §7 tabla original cita `real_estate.export` y «L4» (conservada como plan original
    con la nota de cabecera).
11. `DEMO_PROPERTY_IDS` no ampliado con `prop_act_a/b` (L7 #4: el seed acota por `deleteScoped`); si se quiere, hay 4 pines
    que actualizar.
12. `pnpm-lock.yaml` ` M` (+64 / −25) **preexistente** al carril: excluido del commit de ACT-INT (`git reset -q
    hotelos/pnpm-lock.yaml`), sigue modificado en el worktree → `git checkout -- hotelos/pnpm-lock.yaml` cuando el orquestador
    quiera limpiar (misma regla que T9 y CHK).
13. Post-fusión: `db:migrate:deploy` + `db:generate` en main (`20260920170000` es la última carpeta; si otro carril aporta una
    marca posterior no hay que renumerar, si aporta una anterior a la fusión sí), `node scripts/env-census.mjs --write` y `node
    scripts/cocoa-22-waves.mjs --write` el último en fusionar (ya regenerados aquí), **`nav-tree.generated.json` desde el CSV
    compartido** (ya lleva las 4 filas RRHH: esperado 71 · 113 · 207 al fusionar con `tanda-rrhh`, §4), reinicio de `:3000`;
    `rbac:sync` real NO hace falta (0 claves). `db:seed:real-estate` solo si se quiere el tenant de prueba en la BD de destino
    (dev / demo, nunca producción sin `SEED_ACT_ALLOW_PRODUCTION=1`).
14. Observado y no reproducido (ACT-REV-11, F4 #7): un `GET …/real-estate/documents` respondió 403 en la primera carga de la
    pestaña Documentación (las siguientes 200) — candidato: petición antes de fijar `x-property-id` tras el login; sin cambio en
    `RealEstateDocumentsScreen`.
15. **Resto en el tenant de demo `org_act`** (verificado en §6 fila 16): el asiento n.º 2 `cmu9ogn7r000lfy4t8y7wfjqp` (posted,
    D 631 / H 572 9.080,00, `source_type property_tax_receipt`, `source_id ptr_act_a_ibi_2026_pac01`) que contabilizó F4 quedó
    **huérfano** tras el `--reset` del corrector (el seed re-crea el recibo con `journalEntryId null` y solo borra los asientos
    de sus propios ids; la enfriadora se re-sembró como n.º 3) → «Proponer asiento» sobre el IBI PAC-01 responde 409
    `RECEIPT_ENTRY_EXISTS` en la demo. Arreglo de una llamada: `PATCH …/receipts/ptr_act_a_ibi_2026_pac01 { "journalEntryId":
    "cmu9ogn7r000lfy4t8y7wfjqp" }` (coherente: pagado por banco el 15/06 y el asiento es 631/572 de ese importe) o anular el
    asiento; opcionalmente ampliar el `--reset` para que anule los asientos `property_tax_receipt*` de sus recibos.
16. **El hook pre-commit no lo ejecuta git en este repositorio**: `core.hooksPath = .husky` (config del repo principal,
    `~/anfitorio-demo/.git/config`) se resuelve contra la raíz del árbol de trabajo (`<worktree>/.husky`, inexistente: el hook
    vive en `hotelos/.husky/pre-commit`) → `git hook run pre-commit` responde «cannot find a hook named pre-commit», igual en
    `~/anfitorio-demo` (sin `.husky` en la raíz); además el script hace `node scripts/…` relativo a `hotelos/`. ACT-INT lo ejecutó
    a mano (`bash .husky/pre-commit` desde `hotelos`, §11) antes del commit. Arreglo: `git config core.hooksPath hotelos/.husky`
    + `cd "$(git rev-parse --show-toplevel)/hotelos"` al principio del script (lo mismo vale para los commits de T9 y CHK, que
    tampoco pasaron por el hook).
17. Cosmético: los comentarios del código abrevian los ids de la revisión (`ACT-REV-05` = ruta `approve` y `csvCell`); §7 usa
    los ids completos.
18. El bloque «Estado verificado (Tanda ACT …)» de `docs/audits/ESTADO-VERIFICADO.md` lo reescribió ACT-INT con las cifras
    finales (el corrector lo había actualizado parcialmente: 42 rutas y documentos registrados, pero seguía con 14/14 y la
    lista de pendientes anterior).

### 9.2 Deuda funcional del módulo (con dueño en runbook §11 y diseño §10.2 / §11)

19. **`SafetyCheck` / mantenimiento**: las inspecciones no crean `SafetyCheck` ni `ComplianceTask`, ni tocan
    `maintenance.service.ts` (L5-A); solo `ComplianceItem` sincronizado por `complianceRequirementCode`.
20. **Tesorería**: sin `kind` de previstos para recibos domiciliados ni conciliación del cargo (el dosier lo situaba en
    `treasury.service.ts`, ACT-L4 del plan original).
21. **USALI FF&E**: sin fila informativa de reserva FF&E ni tarjeta en cartera (`usali.service.ts`, `statement-render.ts`,
    `dashboards/*` intactos).
22. **Resumen diario por correo** (`digest.service.ts`, `REAL_ESTATE_DIGEST_*`): no existe; alertas solo al leer.
23. **OCR / «Leer fechas»** (diseño §8, `compliance-assistant` :202): no existe ni en el API ni en el cliente.
24. **`PATCH /capex-projects/:id` sin `supervisorAuthorizationId`** (`server.ts:6260`; el dosier lo pedía junto a las rutas
    capex): la autorización por PIN de supervisor sigue solo en los flujos de facturas / pagos (`:4791-5130`); la nueva
    `POST …/approve` acepta `supervisorAuthorizationId` opcional pero delega en el motor existente.
25. **Comentario desfasado en `assets.service.ts:39-43` y `:418-424`** («above T4 the engine's double approval with an
    ownership second approver»): el código exige segunda firma de nivel `general_management`, no `ownership` (recon §6 #5).
26. **Datos reales de Faranda**: ninguna ficha, unidad, tributo, documento, inspección ni póliza; `cadastralReference`,
    `surfaceM2` NULL en los 8 centros; titularidad desconocida; IAE ausente del diario; calendario municipal solo Madrid.
27. Otros límites (runbook §11): sin paginación en los listados; sin job de retención / purga de ficheros retirados;
    `vence_pronto` no es estado de póliza; devengo 1/12, ICIO definitivo, plusvalía municipal y sociedad patrimonial fuera;
    el asiento propuesto necesita ejercicio abierto (los cerrados se enlazan a mano); `documentsValidPct` del grupo y de la
    ficha usa 30 / 90 días y no el `expiringSoonDays` del perfil de cumplimiento que sí lee el listado de documentos (L6 #8b).

---

## 10. Lo que solo César puede aportar (diseño §10.2, runbook §11; opción por defecto YA aplicada en el carril)

| # | Decisión / dato | Default aplicado | Alternativas y lo que hace falta |
|---|---|---|---|
| 1 | **Titularidad real de cada hotel** (propietaria / arrendataria local o de industria / gestora / franquicia, contraparte, plazos, preaviso, renta, quién paga IBI / seguro / obras) y si existe sociedad patrimonial | Ninguna ficha real; `org_act` con un caso de cada (propiedad y arrendamiento de industria) | Alta de la tenencia por centro con contrato como `RealEstateDocument`; `MULTI_ENTITY` si hay patrimonial |
| 2 | **Catastro y registro**: notas simples, escrituras, certificaciones catastrales (referencia de 20 caracteres, superficie, valor catastral suelo / construcción), CRU, cargas e hipotecas de los 7 hoteles y la oficina | `Property.cadastralReference` NULL ×8; regex y dígitos de control listos; índice único por organización | Alta de unidad + cargas; `cadastralReference` en `Property` la escribe Estructura (`organization.structure.manage`) o el módulo (`real_estate.manage`): decidir |
| 3 | **Ordenanzas y recibos** IBI, IAE, residuos, vados, terrazas 2025-2026 con domiciliación y plazos de Santander 39075, Oviedo 33044, Teo 15082, Carreño 33014, Gijón 33024 y Oleiros 15058 | Solo Madrid 28079 en `tax-calendar.ts`; el resto en el supletorio LGT 62.3; `installmentsJson` por tributo para fijar PAC a mano | Tabla municipal ampliada (1 fila por INE) o `installmentsJson` en cada tributo real |
| 4 | Licencias (actividad, apertura, obras, primera ocupación), registro turístico (solo LT y RA tienen n.º), CEE, actas OCA (BT, ascensores, PCI), contratos de conservación (RITE, PCI, legionela), planos, proyectos, Libro del Edificio | Catálogo de categorías y tipos, vigencias y alertas listos; 0 documentos reales | Subida por centro (`real_estate.documents.manage`) |
| 5 | **Pólizas** (RC, multirriesgo, pérdida de beneficios) con sumas, primas, vencimientos y preaviso | 625 solo en OC en Sage (seguros centralizados); 0 pólizas reales | Alta por centro; `noticeDays` por póliza (60 por defecto) |
| 6 | **Cuentas de ejecución de obras**: qué prefijos 21x / 23x por centro llevan la obra en Sage y si las certificaciones entran como `investmentGood` | `executionAccountPrefixes` por defecto `211…219, 231, 232`; 23x vacío | Prefijos por proyecto; criterio de capitalización |
| 7 | **Parámetros del asesor**: coeficiente 211 (2 % servicios / 3 % código), exención IAE por INCN de grupo, tipo de retención del alquiler, devengo 1/12 del IBI (`accrueLocalTaxesMonthly`), IIVTNU, reserva FF&E | Ninguno aplicado (no hay periodificación ni FF&E) | Decisión escrita del asesor antes de tocar contabilidad |
| 8 | **Almacén** en el VPS: `DOCUMENT_STORAGE_KIND=disk` con `DOCUMENT_STORAGE_DIR` (y la clave `HOTELOS_FIELD_KEY` en el backup) o S3 en la UE (`DOCUMENT_S3_*`) | El de T9 tal cual (`inline` en demo; `disk` verificado por T9) | Runbook de documentos §2 |
| 9 | Responsable del activo en central y **umbrales de aviso** si 90 / 30 / 7 no valen; resumen diario (sí / no, a quién) | 90 / 30 / 7 fijos en `alerts.pure.ts`; sin digest | Parámetro por organización + job del líder (patrón `reputation-sync.job`) |
| 10 | Tasaciones (ECO 805 u otras) y valor contable del edificio para que los KPIs de valor no estén en blanco | `RealEstateValuation` manual; `valuePerRoom` derivado | Alta por centro |
| 11 | **Claves**: mantener las 4 de T8a (default) o migrar a las 6 del diseño (`real_estate.export`, `documents.read/upload`, `taxes.manage`) | Las 4; exportación con `real_estate.read` + ámbito | `permissions.ts` + `types.ts` + `ROLE_TEMPLATE_VERSION` 5 + `rbac:sync` real |
| 12 | Quién contabiliza el recibo y quién capitaliza (SoD) | `accountant` contabiliza el borrador (`accounting.journal.post` + `ai.high_risk.confirm`); capitaliza `assets.manage` (`asset_manager`, `accountant`) sin asiento | Dar `property_tax.manage` a `accountant`, o un solo paso con posting interno |
| 13 | Ítem **core** en Finanzas orden 9 con roles `finanzas|direccion|admin|activos|auditoria` (`roleHome("activos")` = la Ficha) | Aplicado (F4) | CSV del árbol |
| 14 | Tenant de prueba `org_act` en la demo del VPS | Solo en `hotelos_act` | `db:seed:real-estate` en la BD de demo (nunca producción) |

---

## 11. Ficheros tocados por ACT-Z / ACT-INT y verificación propia

Solo los dos permitidos: `docs/audits/TANDA-ACT-ACTIVOS-2026-09-20.md` (este documento: escrito por ACT-Z, cerrado por
ACT-INT con §7, las cifras finales, §6 «tras la corrección» y §9) y `docs/audits/ESTADO-VERIFICADO.md` (bloque «Estado
verificado (Tanda ACT · Activo inmobiliario, 2026-09-20 …)» al final, reescrito por ACT-INT). Sin dependencias, sin
escrituras en BD (solo logins, lecturas y el 409 de la fila 16 de §6), `pnpm-lock.yaml` sin tocar. Instancias propias
`:3925` (ACT-Z PID 42441 y ACT-INT PID 37752) y `:5195` (ACT-Z PID 45472) paradas por PID; 0 listeners al terminar.
ACT-INT, como excepción a las reglas comunes fijada por el orquestador, **commitea en la rama `tanda-act`** (nunca en
`main`, nunca `push`): `git add -A hotelos` → `git reset -q hotelos/pnpm-lock.yaml` → `git -c user.name="cesareme" -c
user.email="yakutatsa@gmail.com" commit -F <mensaje>` con el mensaje de §12; antes, el script del hook pre-commit ejecutado a
mano desde `hotelos` (`bash .husky/pre-commit`: discoverability + `typecheck-all`; git no lo encuentra por sí mismo, §9.1
#16) y `bash scripts/gates.sh --quick --json scratchpad/ACT/gates-int.json` sobre el árbol final (cifras en el informe
estructurado del lote). Artefactos en `scratchpad/ACT/`: `gates-full.{json,log}` (pre-revisión), `gates-final.json`
(final), `gates-int.{json,log}`, `smoke-z.{sh,out}`, `rt-z.{mjs,json,out}`, `smoke-int.{mjs,out}`, `smoke-int2.mjs`,
`api-3925-{z,int}.log`, `vite-5195-z.log`, `capturas/z-01…z-10.png`, `edit-report-int.py`; de la revisión:
`scratchpad/ACT/REV/`, `scratchpad/ACT-REV/`, `scratchpad/gates-{quick-rev,full-rev,full-rev2}.json`. Contratos que leen
`docs/audits` (`brand-contract` lo trata como histórico) y los de la tanda, reejecutados tras la edición: cifras en el
informe estructurado.

---

## 12. Mensaje del commit (español; en el commit real va seguido de la línea `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`)

```
feat(activo-inmobiliario): módulo real-estate — finca, tenencia, tributos con asiento propuesto, documentos, obras, inspecciones y grupo (Tanda ACT)

Diseño docs/design/ASSET-MANAGEMENT-INMOBILIARIO.md (notas «Estado tras la implementación» §7/§9), runbook
docs/runbooks/activo-inmobiliario.md, contrato docs/api-contracts.md «Activo inmobiliario (Tanda ACT · 2026-09-20)»,
informe docs/audits/TANDA-ACT-ACTIVOS-2026-09-20.md, bloque en docs/audits/ESTADO-VERIFICADO.md.

Lotes: L0a tipos wire (REAL_ESTATE_ERROR_CODES 18), zod .strict(), puros (catastral, tax-calendar, state-machines,
vigencias, alerts.pure) · L0b schema (10 modelos + 12 columnas en capex_projects, 0 enums) y migración aditiva
20260920170000_activo_inmobiliario (SQL verbatim de migrate diff) · L1 ficha, unidades, cargas, valoraciones, tenencia
(12 rutas) · L2 tributos, recibos previstos, calendario municipal (Madrid; resto LGT 62.3) y asiento 631 propuesto en
borrador con createJournalEntryDraft (9) · L3 documentos con fichero sobre el almacén de T9 (6) · L4 obras: aprobación
por ruta propia, licencia, ICIO, ejecución por prefijos 21x del diario y capitalización sin asiento (4) · L5
inspecciones, pólizas y motor de alertas 90/30/7 calculado en lectura (7) · L6 vista de grupo, calendario anual y CSV
(4) · L7 tenant aislado org_act (db:seed:real-estate, *@act.test) · F0 realEstateApi.ts (42 funciones) y helpers ·
F1-F3 seis pantallas Cocoa 22 · F4 ítem Finanzas › Activo inmobiliario (orden 9, core, 6 URLs; roleHome activos) · D1
docs y contrato documental · Z informe · REV ronda de revisión (2 revisores, dedupe, refutación, corrector): 12
hallazgos confirmados + 11 menores corregidos con test (rutas de documentos registradas, PATCH heredado de capex con
máquina de estados, asiento 631 no duplicable y asiento de pago, POST /capex-projects/:id/approve, ficha con KPIs y
alertas completos, taxpayer del IBI según la tenencia, recurridos en el motor, pagado → recurrido, cdeState wip y
solo_propiedad aplicados, suites sin cableado de reserva, csvCell sin fórmulas, NIF enmascarados en auditoría), 1
refutado · INT cierre y commit.

42 rutas en 6 partials (manifiesto 1.031 → 1.073), 0 claves RBAC nuevas (las 4 de T8a; rbac:sync +0/0 stale), 254
claves, techo Cocoa 647 intacto, 0 style= nuevos. Puerta completa final 13/14: typecheck 15 · api 3.753 · admin-web
2.111 · ai-core 119 · worker 34 · contratos 789 · discoverability 203 · route-access 15 × 203 · cocoa waves · migrate
25/25 + drift 0 · build OK · integración 1.060 (1.052 pass · 0 fail · 8 skip; 6 suites real-estate-* incluidas);
nav-tree --check en rojo solo por el CSV compartido con 4 filas del carril RRHH sin pantalla aquí (regenerar en main al
fusionar). Sin dependencias; pnpm-lock.yaml excluido; nada al VPS; Faranda solo lectura.

Pendiente (informe §9): docs desalineadas (runbook §10/§11, api-contracts «1031 entradas», diseño §8), asiento n.º 2
huérfano en el demo org_act, hook pre-commit que git no resuelve en este repo, export de real-estate.schemas en
schemas/index.ts, tipos duplicados del front. Decisiones de César en §10 (titularidad, catastro, ordenanzas, pólizas,
prefijos 21x, asesor, almacén, umbrales).
```
