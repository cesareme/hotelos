# Tanda T9 · Documentos y digitalización con IA · Integración y verificación — 19/20 de septiembre de 2026

**Para:** César. **Encargo (brief `tandaT9-impl-brief.md`):** digitalizar por centro los documentos de proveedor y la
correspondencia (captura por correo, foto móvil o subida; almacén con adaptador disco/S3; pipeline de clasificación y
extracción con IA y fallback por reglas; cotejo con albaranes; propuesta de factura de proveedor en borrador, gasto,
recepción o tarea; archivo con retención legal; RBAC; front Cocoa 22), reutilizando lo que ya existía (ai-core de L6a,
payables de L3, el buzón de T8, Sage real solo lectura). **Método:** diseño (`docs/design/DOCUMENTOS-DIGITALIZACION.md`)
→ reconocimiento delta de solo lectura (`scratchpad/T9/recon-delta.md`, línea base `scratchpad/T9/gates-base.json`) →
plan de 5 olas · 17 lotes (T9-01 … T9-15, con 05a/05b y 06a/06b) en el worktree `~/anfitorio-demo-wt-t9/hotelos` (rama
`tanda-t9`, base `f77820d`, BD propia `hotelos_t9` con la carga real de Sage/OPERA, puertos `:3921` / `:5191`) →
`gates.sh --quick` tras cada ola → puerta completa → tres revisores (funcional-runtime, seguridad-privacidad-RBAC,
regresiones-honestidad) → dedupe y refutación (18 confirmados · 2 refutados) → corrector (todos los confirmados
corregidos con test, más 13 hallazgos menores del dedupe) → puerta final → **integración (este documento).**

**Resultado en una línea:** el módulo `documents` funciona de punta a punta en el carril SIN clave de IA, SIN cuenta S3,
SIN buzón real y SIN escáner (todo degradado de forma honesta): un PDF, una foto o un XML Facturae capturados en un centro
reciben registro `DOC-<centro>-<año>-<n>`, sha256 y magic bytes; el pipeline por reglas extrae NIF / número / fechas /
importes / IVA y los coteja con el diccionario de proveedores y el libro de recibidas REALES de Sage (solo `SELECT`);
la oficina revisa el documento con el original al lado, lo aprueba y nace la factura de proveedor en `draft` por
payables (quien aprueba queda como registrador: separación de funciones de T8a), el gasto, la recepción de mercancía con
su movimiento de stock, o la tarea con plazo; el archivo busca por texto y aplica retención 6 / 10 / 6 / +1 años con
bloqueo, purga y supresión GDPR; la puerta completa final está en **12/14** con los dos rojos externos al carril (fila
CHK del CSV compartido; dos migraciones de fix1 aplicadas en la copia de BD), la integración **865 · 857 pass · 0 fail ·
8 skip**, e invariantes de Faranda idénticas al principio y al final. **Nada se ha fusionado ni desplegado**: la fusión
sigue `docs/design/olas/T9-MERGE-LINES.md` y las decisiones de §9 son de César.

---

## 1. Alcance y qué cambia

| Antes (recon delta, f77820d) | Ahora (verificado en el carril) |
|---|---|
| 12 columnas `*objectKey` sin almacén; `/health` `objectStorage: "unconfigured"` fijo | `apps/api/src/modules/documents/storage/*`: `inline` (demo, columna base64, caché LRU 8 MiB) · `disk` (AES-256-GCM en reposo con `HOTELOS_FIELD_KEY` / `ENCRYPTION_KEY`, tmp+rename, doble guarda de ruta) · `s3` (SigV4 propio verificado con los vectores oficiales, sin SDK ni cuenta, tiempo límite 30 s y tope de lectura); `/health dependencies.objectStorage = inline \| disk \| s3 \| unconfigured` |
| `classifyIncomingDocument` y `extractIncomingDocumentFields` existían en L6a sin consumidor; sin pipeline | Puerto `DocumentsAiPort` + reglas + adaptador ai-core (patrón T8): `classify → extract → validate → propose`, ejecutado por `runAiTool` (gobernanza, presupuesto, PII, coste) cuando hay proveedor y por reglas honestas cuando `AI_PROVIDER=none` (nunca campos inventados; una imagen sin proveedor es un formulario manual); herramienta 147.ª `proposeIncomingDocumentAction` (`erp_accounting`, `documents.review`, `high`, confirmación) |
| Facturas de proveedor solo a mano (`payables.create`); dos rutas heredadas sin líneas (`GET /properties/:id/supplier-bills`, `POST /supplier-bills/drafts`) | Aprobar un documento crea la factura en `draft` por `createSupplierBillInTx` (`receptionDate`, `source digitized \| e_invoice`, `matchStatus`, `incomingDocumentId`, líneas con `quantity` / `unitPrice` / `deliveryNoteRef`); gancho `posted` / `cancel` acotado por organización y centro; libro de recibidas por `receptionDate ?? issueDate`; rutas heredadas retiradas (manifiesto 948 → **981**) |
| `purchase_orders` 0 filas; sin albaranes; inventario solo por POS | `GoodsReceipt` + `GoodsReceiptLine` + `StockMovement` en la misma transacción; cotejo a 2 vías albarán ↔ factura (`POST …/supplier-bills/:billId/match`, tolerancias 2 % / 0 / 1,00 € por organización, `variance` y 409 `SUPPLIER_BILL_MATCH_REQUIRED` opcional al aprobar) |
| Buzón T8 solo `reservation_ai` / `pms_shadow` | Propósito `documents` sobre el conector existente: un documento por adjunto (pdf / jpeg / png / tiff / xml ≤ 25 MB), dedupe por sha256 y `(messageId, attachmentId)`, cuerpo del correo nunca guardado, `POST …/email/ingest` con `attachments` |
| Sin retención de documentos; `retention-policy.ts` sin `incoming_document` | Retención 31/12 + 6 (facturas, albaranes, contratos, correspondencia) / 10 (`extendedRetention`) / 4 (solo con datos personales sin efecto fiscal, `guestId`) / +1 (rechazados); bloqueo 12 meses antes de purgar, `legalHold`, purga que conserva registro, hash y auditoría; job diario del líder; `executeErasure` pseudonimiza (fiscal) o borra (no fiscal) |
| 250 claves; 69 pantallas; 946 rutas | 254 claves (`documents.capture \| review \| archive.read \| admin`, `ROLE_TEMPLATE_VERSION` 3 → 4 aditiva en 15 plantillas); +4 pantallas Cocoa a 0 `style={}` (Operaciones › Digitalizar, Finanzas › Proveedores › Documentos y Archivo, Compras › Recepciones) y Facturas recibidas con origen / cotejo / adjunto digitalizado / autorización por PIN; 277 → **287** tablas, 38 → **45** enums, 2 migraciones aditivas |
| Sin datos de demo | Seed FICTICIO `demo:seed-documents` (dry-run por defecto, allowlist `org_123 / prop_123`, `--purge --apply`): 2 usuarios, 3 proveedores con NIF calculado, 22 documentos con su estado final, 2 valijas, 3 facturas contabilizadas; 0 filas escritas en Faranda |

Sin dependencias nuevas; `pnpm-lock.yaml` ` M` +74/−25 es deuda previa del aprovisionamiento de carriles (idéntico en
CHK y fix1; §4.2 y §4.3) y **se excluye de la fusión**, como en todas las tandas anteriores.

---

## 2. Lotes y ficheros

`git status --porcelain` del worktree al cierre: **74 ` M`** (73 del carril + `pnpm-lock.yaml`) y **118 `??`** = 191
ficheros de la tanda; diff seguido +3.332 / −736 líneas (73 ficheros) y **34.663 líneas nuevas** en los 118 ficheros
sin seguimiento (sin contar los dos JSON de puertas): `apps/api/src/modules/documents/` 77 ficheros · 19.808 líneas (30
tests · 6.685), `apps/admin-web/src/screens/documents/` 14 · 4.743, `apps/api/src/scripts/seed-documents-demo*` 2 ·
2.145, `tests/integration/` 8 · 3.120, contratos raíz 2 · 566, `packages/` 3 · 1.141 (`documents-types.ts` + 2
`migration.sql`), docs 2 md · 1.343 + 2 JSON de puertas.

Convenciones que siguen TODOS los lotes: fixtures inventadas (`documents/__tests__/fixtures.ts`: «Lavandería Cantábrica
Demo SL», NIF con letra de control calculada, PDF ensamblados a mano), tenants aislados `org_l2_*` creados y borrados por
`tests/integration/helpers/l2-tenant.mts` con `farandaInvariants` antes y después, ningún nombre de persona, Sage solo
`SELECT`, ningún `pkill`, instancias propias por PID.

### Ola 1 · esquema, tipos, almacén, formulario (T9-01 … T9-04)

**T9-01 · Esquema y migración** — `packages/database/prisma/schema.prisma` (+403 líneas: 10 modelos `IncomingDocument`,
`DocumentFile`, `DocumentPage`, `DocumentExtraction`, `DocumentAction`, `DocumentDispatchBatch`, `GoodsReceipt`,
`GoodsReceiptLine`, `BillLineMatch`, `DocumentSettings`; 7 enums; columnas nuevas en `supplier_bills` y
`supplier_bill_lines`) y `migrations/20260920120000_documentos_digitalizacion/migration.sql` (386 líneas: cabecera de la
casa + salida VERBATIM de `migrate diff --from-migrations … --to-schema-datamodel` con BD sombra creada y borrada; 7
`CREATE TYPE`, 2 `ALTER TABLE ADD COLUMN`, 10 `CREATE TABLE`, 21 índices, 7 FK `ON DELETE CASCADE`; 0 `DROP`, 0
extensión). *Cómo:* nunca `migrate dev` (vería las migraciones de fix1 aplicadas sin carpeta y propondría reset);
timestamp posterior a las dos de fix1. *Tests:* `migrations-squash`, `finanzas-schema`, `sage200-schema`,
`legal-identity-readers`, `retention-policy` 45/45; typecheck database y api 0. *Verificación:* `db:migrate:deploy` →
19 migraciones; `db:migrations:check` 287 / 45 OK; `db:install:check` en BD limpia «sin drift»; `db:drift:check` con
EXACTAMENTE los 3 ítems heredados de fix1; API en `:3921` `/health` healthy. Decisiones declaradas: `registryYear` +
`registrySeq` con unicidad por centro y año; `Decimal(12,3)` en cantidades; catálogos `String` (no enum) en
`extractionStatus`, `source`, `matchStatus`, etc.

**T9-02 · Tipos y claves** — `packages/shared/src/documents-types.ts` (nuevo, 727 líneas: catálogos `as const`,
`IncomingDocumentRecord/Detail`, `DocumentChecks`, `DocumentProposal`, requests de todas las rutas, `DocumentKpis`,
`DocumentSettingsDto`, recepciones y cotejo, `DOCUMENT_ERROR_CODES`), `payables-types.ts` (+`SUPPLIER_BILL_SOURCES`,
`SUPPLIER_BILL_MATCH_STATUSES`, campos nuevos en request y DTO), `types.ts` (4 `PermissionKey`), `permissions.ts` (4
claves, 30 concesiones en 15 plantillas, `ROLE_TEMPLATE_VERSION = 4` aditiva), `index.ts`, `tests/documentos-contract.test.mjs`
(12 tests: matriz exacta de tenedores, mínimo privilegio, versión aditiva por tamaños v3, catálogos exactos).
*Verificación:* `rbac:sync --dry-run` contra `hotelos_t9`: «+4 created · 45 topped up · 69 behind v4 · 0 revocaciones».
Los pines de `rbac-sod-contract` (250 → 254, versión 3 → 4), `rbac-catalog.test` y `rbac-sync.test` los re-ancló el
integrador de ola (fuera de la lista del lote, declarado).

**T9-03 · Almacén y utilidades puras** — 23 ficheros nuevos bajo `modules/documents/`: `storage/{storage,at-rest-encryption,
inline-storage,disk-storage,sigv4,s3-storage,index}.ts`, `magic-bytes.ts` (lista blanca de 6 MIME, firmas, XML con raíz
svg/html rechazado), `pdf-text.ts` (extractor propio: ObjStm, Flate, ASCIIHex, WinAnsi + Differences, Type0 por
ToUnicode, saltos de línea por posición; límites 5 MiB / 200 páginas; nunca lanza), `einvoice-parser.ts` (Facturae 3.2.x
y UBL 2.1, totales cuadrados, firma solo estructural), `registry-number.ts` (`pg_advisory_xact_lock` + `MAX(registry_seq)+1`),
`retention-rules.ts` (31/12 + años, festivos nacionales + Viernes Santo, `dueAtFor`), `env.partial.ts` (11 variables
`DOCUMENT_*`), 9 suites: **80/80**; SigV4 verificada contra los dos vectores públicos de AWS; `env-contract` 9/9.
*Verificación:* humo con tsx (disk cifrado put/get/head, pdf-text, Facturae y UBL, registro `DOC-CDEF-2026-000001`).

**T9-04 · Front base** — `CocoaFileInput` (+`multiple`, `capture`, `onPickMany`), `screens/documents/documents-helpers.ts`
(etiquetas ≤ 28 caracteres, tonos, `DOCUMENT_ERROR_MESSAGES` `satisfies Record<DocumentErrorCode,string>`, SLA en calendario
de Madrid), `capture-compress.ts` (≤ 1.600 px / JPEG 0,82 solo en navegador), `screens/payables/SupplierBillForm.tsx`
(extraído de `SupplierBillsScreen.tsx`, 950 → 634 líneas; modo `review`), whitelist e inventario Cocoa regenerados.
*Tests:* 25 nuevos; suite front 1.874 (1 fail ajeno: `users-rbac` por las claves de T9-02, re-anclado en ola); contratos
Cocoa / español / no-raw-fetch 28/28. *Verificación en navegador* (`:5191` sobre `:3921`): alta de factura a 1.280 y 400 px
→ `201`.

### Ola 2 · captura, configuración, pipeline (T9-05a, T9-05b, T9-06a, T9-06b)

**T9-05a · Captura y cola** — `documents.service.ts`, `documents.routes.ts`, `route-permissions.partial.ts` (9 rutas),
`documents-audit.ts`, `documents-dto.ts`, `schemas/documents.schemas.ts` (`.strict()`, base64 estricto, `source` del
cliente solo `upload | mobile | api`). Orden de escritura: validar TODOS los ficheros (413 por tamaño estimado antes de
decodificar, MIME + magic, sha256, dedupe) → `storage.put` → transacción (registro bajo advisory lock, documento, fichero
original, páginas) → borrado de la clave si falla. Cola de la oficina por organización con la regla R11 (centro en ámbito,
`accounting.entity.read` o asignación total; si no 404 `ENTITY_SCOPE_REQUIRED`). *Tests:* 41 unitarios;
`tests/integration/documents-upload.test.mts` **18/18** (201 con `DOC-L2A-2026-000001`, 413, 400 MIME / content mismatch,
409 duplicado + `allowDuplicate`, 403, 404 opaco cross-tenant, descarga con cabeceras y bytes idénticos, auditoría sin
bytes, bandeja con cursor y filtros, send-to-office y 409 de estado, recaptura). *Verificación:* `:3921` con
`DOCUMENT_STORAGE_KIND=disk`: fichero cifrado en `org/<org>/prop/<prop>/doc/<id>/<sha>.pdf`, `encrypted=t`.

**T9-05b · Configuración y cableado** — `documents.config.ts` (config memoizada; `getDocumentsUploadBodyLimit()` no
lanzante), `lib/env.ts` (sección «Documentos», `processEnvironment()`), `lib/tenancy.ts` (resolvers `incomingDocument`,
`goodsReceipt`), `security/route-permissions.ts` (spreads), `server.ts` (imports, `/health`, registro de rutas con
`onCaptured = runDocumentPipeline`, puerto de IA), `schemas/index.ts`, `.env.example` / `.env.production.example` /
`scripts/env-contract.json` regenerados con `env-census`, `docker-compose.production.yml` (volumen `documents-data`),
`systemd/anfitorio-api.service` (`ReadWritePaths=/var/lib/anfitorio/documents`). *Tests:* `documents-config.test.mts`
18/18; `tests/integration/documents-health.test.mts` 4/4. *Verificación:* `:3923` con disk → `objectStorage: "disk"` y el
directorio nunca aparece en el cuerpo; sin variables → `inline`; disk sin `DIR` → arranca degradado con el contrato como
causa. El rojo `env-contract` («example de `DOCUMENT_STORAGE_DIR` con format path») se corrigió en la ola siguiente
(`productionExample`).

**T9-06a · Pipeline e IA** — `documents-ai.port.ts`, `documents-ai.rules.ts` (clasificación por palabras con confianza
0,35-0,95; NIF del cliente nunca es el emisor; NIF con letra incorrecta baja a 0,3 con aviso), `extraction-schemas.ts`
(esquemas JSON por tipo con `{value, confidence, page}`), `documents-ai.core-adapter.ts` (`runAiTool` con `execute`
explícito → `core.extractFromDocument`; tramos de ≤ 20 imágenes; `aiAllowedKinds`; denegación / cuota / salida inválida →
reglas con nota honesta), `pipeline.service.ts` (carga original → texto → classify → extract → lookups reales → `validateDocument`
→ `buildProposal` → autonomía → transacción + `enqueueReview` una sola vez + auditoría `DOCUMENT_CLASSIFIED / EXTRACTED`),
`pipeline.routes.ts` (`POST …/classify`, `POST …/extract`, 503 `AI_PROVIDER_UNAVAILABLE` con `force` sin proveedor),
`registry.ts` / `tool-names.ts` / `documents.tools.ts` / `tools/index.ts` (147.ª herramienta), `ai-review-labels.ts`
(«Documento digitalizado»). *Tests:* 30 unitarios + `tools-coverage` 7/7 (147/147) + `documents-pipeline.test.mts`
**6/6** (proveedor SIMULADO + runner REAL → `ai_tool_calls` +2 con `pdfBase64` omitido). *Verificación:* `:3921` + Vite:
factura → `text_rules`, 7 checks, propuesta `create_supplier_bill` 2 líneas; XML Facturae → confianza 1 sin llamar a
`extract`; `/hoy/pendientes-ia` muestra «Documento digitalizado».

**T9-06b · Validación, cotejo, propuesta, Sage** — `validation.ts` (`validateDocument` → 7 checks `nif · supplier ·
totals · vat · duplicate · retention · match` con `details` reutilizables), `matching.ts` (`matchBillToReceipts`:
referencia citada → descripción normalizada Jaccard ≥ 0,5 → importe ±1,00; línea de albarán consumida una vez),
`proposal.ts` (`buildProposal`: factura / gasto sin NIF / albarán / notificación con plazo 10-20 naturales o 10 hábiles /
carta con plazo / archivo), `sage-lookup.ts` (`findSageSupplierByNif`, `findSageReceivedByNifAndNumber`,
`findSageReceivedFuzzy`, agregación por `sourceId` porque Sage guarda una fila por documento Y tipo; nunca > 20 filas).
*Tests:* **59/59**. *Verificación con Sage real (solo `SELECT`, cifras, sin NIF impresos):* NIF con 1.362 recibidas →
proveedor encontrado con 8 cuentas 400/410 distintas (la hipótesis «400/410 por hotel» se confirma: 458 NIF con varias
cuentas, hasta 16); factura ficticia con número real → `duplicate FAIL source sage200`; propuesta con `payableAccountCode
410` y `supplierProposal.fromSage`.

### Ola 3 · correo, flujo, recepciones (T9-07, T9-08, T9-09)

**T9-07 · Buzón `documents`** — `email-documents.service.ts` (nuevo: `isDocumentAttachment`, `ingestDocumentAttachments`
con deps inyectables, dedupe por `(messageId, attachmentId)` y sha256, `documents_ingested | documents_ignored`),
`email-reservation.service.ts` (propósito `documents`, `gmailQueryFor` `has:attachment newer_than:3d`, adjuntos perezosos
para Gmail y Graph, rama tras el clasificador de reseñas de T8), `email-connections.schemas.ts`, `EmailConnectorsScreen.tsx`
(tercera opción sin «Dominio remitente», estados de bandeja). *Tests:* 29 unitarios; `t9-email-documents.test.mts`
**8/8**; `t8-email-review-notification` 2/2 intacto. *Verificación:* `:3921` + `:5191`: conexión `manual / documents` →
`documents_ingested` → `DOC-L2A-2026-000001` con `source email` y `physicalStatus not_applicable`.

**T9-08 · Flujo de la oficina** — `workflow.service.ts` (tabla §6.1 = 30 transiciones + reasignación `in_review --assign-->
in_review`, `assertWorkflowAllowed`: bloqueado → 409 `DOCUMENT_BLOCKED`, purgado → 404), `actions.service.ts` (assign /
review / approve / reject / archive / tareas / autonomía; `create_supplier_bill` = `documents.review` + `payables.create`
con SoD, `create_expense` = `accounting.journal.post`, `create_goods_receipt` = `purchase_orders.receive`; override con
motivo si hay checks en `fail`), `dispatch.service.ts` (valija por centro bajo advisory lock, hoja de remesa PDF con
texto legal), `split-merge.service.ts`, `workflow.routes.ts` (12 rutas), `supplier-bills.service.ts` (+343 líneas:
`createSupplierBillInTx`, `assertMatchForApproval`, adjunto → `{documentId, downloadPath}`, ganchos `posted` / `cancel`,
libro por `receptionDate`). *Tests:* 22 unitarios; payables 21/21; `documents-workflow.test.mts` **15/15** (hoy 20/20 con
los 5 casos del corrector). *Verificación:* `:3925` (el `:3921` lo ocupaba otro lote) 21/21 pasos por HTTP con auth
real: aprobar → factura `draft / digitized` → SoD 409 al registrador → aprobación por la dirección → contabilización →
documento `posted`; valija y hoja; `receive`.

**T9-09 · Recepciones y cotejo** — `goods-receipts.service.ts` (`createGoodsReceiptInTx`: unicidad por número normalizado,
artículo por id / sku / nombre, ubicación activa, `StockMovement receipt` en la misma transacción; `recordStockMovement(input,
tx?)` en `fnb-inventory.service.ts` sin romper llamadores), `goods-receipts.routes.ts` (4 rutas), `bill-matching.service.ts`
(`matchSupplierBill` idempotente: respeta cotejos humanos, excluye líneas cotejadas con otras facturas, recepción `billed`
solo cuando todas sus líneas están cubiertas), `payables.routes.ts` + partial (5 filas). *Tests:* 36 unitarios;
`goods-receipts.test.mts` **13/13**; `l2-modulos-operaciones` 21/21 y `demo-seed-contract` 9/9 (firma de
`recordStockMovement`). *Verificación:* `:3925` 12 pasos por HTTP (201, 409 duplicado, 403 sin `procurement.manage`,
`match` `full` y `variance` con `priceVariance 0.2400`, `dispute`, 404 desde otro centro).

### Ola 4 · front (T9-10, T9-11, T9-12)

**T9-10 · Operaciones › Digitalizar** — `services/documentsApi.ts` (34 rutas tipadas, `useApiData`), `goodsReceiptsApi.ts`,
`DocumentCaptureScreen.tsx` (KPI del día, bandeja, «Enviar a la oficina», «Dividir», «Cerrar valija (N)»),
`DocumentCaptureDrawer.tsx` (zona de arrastre, «Hacer foto» `capture=environment`, compresión, un POST por tipo sugerido),
`DocumentLabelDialog.tsx` (etiqueta imprimible con aviso «copia digital no certificada»), fila CSV `/operaciones/digitalizar`
(ítem propio de Operaciones, módulo `core`, porque `ProcurementDashboard` tiene gate `procurement_inventory` y los centros
no la verían), `App.tsx`, `nav-tree.generated.json`. *Tests:* 16/16; `build-nav-tree --check` al día (70 · 100 · 205);
`check-route-access` 15 × 193. *Verificación en navegador* con tenant aislado: drop de PDF + PNG → 2 × `201`, etiqueta,
envío, valija (`201` + hoja PDF), split 3 páginas «1-2, 3»; 400 px en una columna.

**T9-11 · Facturas recibidas** — `SupplierBillsScreen.tsx` (columnas Origen / Cotejo, «Ver documento», «Ver adjunto»,
«Cotejar con albarán», callout de tramo con «Autorizar con supervisor» → `SupervisorPinDialog` → reintento con
`supervisorAuthorizationId`), `payables-helpers.ts` (`billApprovalBlock`, `openBillAttachment`), `payablesApi.ts`
(sobrecarga de `approveSupplierBill`, `downloadSupplierBillAttachment`), `finance-contracts.ts` (mensajes de los 20 códigos +
`RBAC_SOD_CONFLICT`, `RBAC_LEVEL_EXCEEDED`, `SUPPLIER_BILL_MATCH_REQUIRED`). *Tests:* 21/21 helpers; suite front 1.899.
*Verificación en navegador:* factura digitalizada 181,50 € → cotejo `full` → aprobada; factura 6.050 € → 403
`RBAC_LEVEL_EXCEEDED` → PIN del owner → `201` autorización → aprobada.

**T9-12 · Oficina: Documentos, Archivo, Recepciones** — `IncomingDocumentsScreen.tsx` (segmentos Pendientes / En revisión /
Aprobados / Devueltos / Archivo, cola agrupada por centro, KPIs, selector de revisor, `?id=` y `#doc_`),
`DocumentReviewPane.tsx` (pasos, campos con confianza y página, 7 comprobaciones, `SupplierBillForm` en modo `review`,
borradores de gasto / recepción / tarea, override con motivo), `DocumentViewer.tsx` (PDF en iframe `#page=N&zoom=Z`),
`DocumentArchiveScreen.tsx` (filtros, metadatos legales, block / unblock / purge con motivo), `GoodsReceiptsScreen.tsx`,
`ProveedoresTabs.tsx`, `ComprasInventarioTabs.tsx`, 3 filas CSV. *Tests:* 17/17; `build-nav-tree --check` al día (70 · 104
· 205 con la fila CHK del CSV compartido). *Verificación en navegador:* cola de la sociedad con SLA «Vence en 2 días» →
«Empezar revisión» → «Aprobar y crear factura» → factura `draft / digitized` en Facturas recibidas con proveedor dado de
alta; «Cortar aquí»; archivo con retención 31/12/2032; recepción manual `201`.

### Ola 5 · archivo, seed, cierre (T9-13, T9-14, T9-15)

**T9-13 · Archivo, KPIs, ajustes, retención, GDPR** — `archive.service.ts`, `retention.service.ts` (bloqueo = `retentionUntil
≤ hoy` sin `legalHold`; purga = bloqueado ≥ 12 meses: `storage.delete`, inline y texto a `null`, campos de texto a
«[purgado]», `deletedAt`; registro / hash / auditoría sobreviven), `documents-retention.job.ts` (tick diario del líder bajo
`pg_try_advisory_xact_lock`, `runAtBoot`), `kpis.service.ts` (`DocumentKpis` con `safe()` → `degraded[]`),
`settings.service.ts`, `archive.routes.ts` (7 rutas), `gdpr.service.ts` (paso `IncomingDocument` en `executeErasure`),
`retention-policy.ts` (`incoming_document`), `server.ts` (scheduler tras reputación). *Tests:* 36 unitarios;
`documents-retention.test.mts` **14/14**. *Verificación:* `:3927` con `RUN_SCHEDULERS=true` y el resto de jobs apagados:
«[documents.retention.job] tick {blocked 0, purged 0, reextracted 0, autonomous 0}», apagado ordenado con el job en
`steps`.

**T9-14 · Seed y runbook** — `seed-documents-demo.ts` + `seed-documents-demo.dataset.ts` (dataset puro y determinista
por `--seed`; fase 1 en una transacción; fase 2 por los servicios reales: captura → pipeline → valija → oficina → cotejo →
aprobación y contabilización por otra persona), script `demo:seed-documents`, `docs/runbooks/documentos-digitalizacion.md`
(11 secciones; §6.1 = unión exacta de los partials; §7 = códigos de error), `tests/documentos-docs-contract.test.mjs` (7
tests que atan runbook ↔ partials ↔ env ↔ seed y prohíben el nombre de la organización real). *Verificación:* `--dry-run` →
`--apply` 22/22 → `--apply` idempotente 0 filas nuevas → `--purge --apply` 13 contadores a 0 → `--apply` de nuevo; recorrido
en navegador con `documentos.centro@example.com` (Digitalizar: 20 capturados hoy) y `documentos.oficina@example.com`
(Documentos: Pendientes con «Vence en 2 días» y «Vencido hace 5 días»).

**T9-15 · Integrador de tanda** — retirada de las 2 rutas heredadas (`server.ts`, `route-permissions.ts`,
`accounting.service.ts` con `createSupplierBillDraft` `@deprecated`), `tests/invoice-accounting-contract.test.mjs`,
`docs/api-contracts.md` (sección «Documentos y digitalización (Tanda T9 · 2026-09-19)», 35 rutas, «981 entradas»),
`docs/runbooks/finanzas-contabilidad.md`, `docs/design/DOCUMENTOS-DIGITALIZACION.md` (15 marcadores «[actualizado
2026-09-19]»), `docs/design/olas/T9-MERGE-LINES.md` (16 secciones con anclas de texto), `CLAUDE.md`. Puerta completa,
integración completa por `test:integration` (860 · 850 · 2 fail heredados de UX-1), seed purgado, invariantes idénticas.
Los pines ajenos que dejó en rojo (`withholding-tax-posting-contract`, `gates.sh` puerta «integración» sin loader tsx,
`l3-cancelacion` por `PAST_ARRIVAL_DATE`) los cerró el paso de puertas (§3).

---

## 3. Puertas con cifras

Todas con `NAV_TREE_CSV=/Users/cfernandez/anfitorio-demo/pilots/tanda5-nav-tree.csv bash scripts/gates.sh [--quick] --json
<f>` desde el worktree, BD `hotelos_t9`. JSON en `scratchpad/T9/gates-*.json` (línea base, olas, corrector, final) y, en el
repo, `docs/audits/T9-corrector-gates-{quick,full}.json`.

| Puerta | Base (19/09 21:26) | Ola 1 | Ola 2 | Ola 3 | Ola 4 | Ola 5 | T9-15 completa | Corrector completa | **Final (20/09 08:07)** |
|---|---|---|---|---|---|---|---|---|---|
| typecheck:all | 15 PASS | 15 | 15 | 15 | 15 | 15 | 15 | 15 | **15 PASS · 0 FAIL · 1 SKIP** |
| api unit | 2.871 / 1 skip | 2.951 | 3.100 | 3.181 | 3.217 | 3.217 | 3.217 | 3.242 | **3.242 · 3.241 pass · 0 fail · 1 skip** |
| admin-web unit | 1.849 / 1 skip | 1.874 | 1.874 | 1.890 | 1.916 (5 fail CHK) | 1.916 (5 fail CHK) | 1.916 | 1.916 | **1.916 · 1.915 · 0 · 1** |
| ai-core | 119 | 119 | 119 | 119 | 119 | 119 | 119 | 119 | **119/119** |
| worker | 34 | 34 | 34 | 34 | 34 | 34 | 34 | 34 | **34/34** |
| contratos raíz | 589 / 2 skip | 601 | 601 | 601 | 608 (2 fail CHK) | 608 (2 fail CHK) | 608 | 608 | **608 · 606 · 0 · 2** |
| discoverability | 192 URLs | 192 | 192 | 193 | 197 (1 roto CHK) | 197 (1 roto CHK) | 196 | 196 | **196 URLs · 0 rotos** |
| nav-tree --check | al día 69·100·205 | al día | al día | rojo (sin `--csv` en el quick) | al día (con la fila CHK) | al día | rojo (stale por CHK) | rojo | **rojo (stale por CHK; árbol generado 70 · 103 · 205)** |
| route-access | 15 × 192 | 192 | 192 | 193 | 197 | 197 | 196 | 196 | **15 × 196** |
| cocoa waves | al día | al día | al día | al día | rojo (§6) | al día | al día | al día | **§6 al día** |
| rbac:sync dry-run | OK | OK (+4) | OK (+4) | OK | OK | OK | OK (+4) | OK (+0) | **OK (+0 sobre `hotelos_t9`; +4 en `main`)** |
| migrate status + drift | rojo (3 ítems fix1) | rojo | rojo | rojo | rojo | rojo | rojo | rojo | **rojo: status 20/20 al día; drift = los 3 ítems de fix1** |
| admin-web build | — | — | — | — | — | — | OK 2,81 s | OK 2,90 s | **OK 2,76 s** |
| integración | — | — | — | — | — | — | 860 · 852 · 0 · 8 | 865 · 856 · 1 (flake) · 8 | **865 · 857 pass · 0 fail · 8 skip** |
| **Verdes** | 11/12 | 11/12 | 11/12 | 10/12 | 7/12 | 8/12 | 12/14 | 11/14 | **12/14** |

Notas:

- **Los dos rojos finales son externos al carril y se cierran en la fusión.** (1) `nav-tree --check`: la fila 292 del CSV
  compartido (`CheckInAutomationSettingsScreen;/hoy/check-in-automatizado`, carril CHK, mtime 04:36) no tiene pantalla ni
  loader en este árbol; incluirla en `nav-tree.generated.json` ponía en rojo admin-web unit (5), contratos (2) y
  discoverability (1 enlace roto), así que el JSON del worktree se regeneró desde el CSV sin esa única fila (diff = 1
  entrada, `scratchpad/T9/nav-tree.shared-csv.json` vs `nav-tree.sinchk.json`) y `--check` contra el CSV compartido queda
  «stale». (2) `migrate status + drift`: `hotelos_t9` tiene aplicadas `20260920100000_iva_regimen` y
  `20260920110000_iva_compensacion_inicial` (fix1, ya en `main` por `242be35` / `f2ac4f7`) sin carpeta en la base
  `f77820d`; `db:drift:check` sale 2 con EXACTAMENTE `VatBookRegime`, `vat_book_entries.regime` + índice y
  `vat_settings.opening_compensation*`; ya era rojo en la línea base y corregirlo exigiría `DROP COLUMN` sobre el libro de
  recibidas real (prohibido); `db:install:check` en BD limpia demuestra drift 0 (`scratchpad/T9/drift-t9-down-foreign-iva.sql`
  quedó sin aplicar a propósito).
- Las olas 4-5 salieron 7-8/12 por la misma fila CHK (el CSV compartido cambió a las 04:36 entre T9-10 y T9-12) y por el
  inventario Cocoa sin regenerar; ninguno era de código T9.
- La puerta «integración» de `scripts/gates.sh` fallaba por construcción (67/67 al cargar: `node --test` desde la raíz sin
  `--import tsx` ni el cwd `apps/api` → `ERR_MODULE_NOT_FOUND @hotelos/database`), idéntico en `main`; el paso de puertas
  la corrigió (`scripts/gates.sh:37`, con `--env-file-if-exists=../../.env`). **Incidente:** en los runs 1-2 de esa puerta,
  12 suites con `process.env.DATABASE_URL ??= …/hotelos` sin cargar antes el `.env` corrieron contra la BD PRINCIPAL
  `hotelos` (`P2022 supplier_bills.reception_date does not exist`); crearon y limpiaron sus tenants de prueba (0
  organizaciones / propiedades / usuarios de prueba residuales, verificado solo lectura; filas bajo `org_123` no
  auditadas). El corrector cerró la trampa: `package.json` `test:integration` con `--env-file-if-exists=../../.env` y helper
  `tests/integration/helpers/load-env.mts` en las 2 suites que no cargaban el `.env` antes del `??=`.
- El único fallo de integración del run del corrector (856 · 1) fue `l2-persistencia-plataforma.test.mts` L2-04 («orden
  descendente»: dos `offline_sync_records` en el mismo milisegundo), ajeno a T9, verde en la suite sola y en el run
  final. Los 2 fallos de `l3-cancelacion` del run de T9-15 (400 `PAST_ARRIVAL_DATE` desde UX-1) se corrigieron en el
  test con `allowPastArrival` en los dos casos de no-show (sin skips ni asserts debilitados).
- Otras verificaciones fuera de `gates.sh`: `db:migrations:check` «20 migraciones → 287 tablas / 45 enums, en
  sincronía»; `db:install:check` (`INSTALL_TEST_DB=hotelos_t9_install_test`) OK 20 migraciones → 287 tablas, 79 permisos,
  sin drift (el script termina con «line 136: FOREIGN_OBJECTS: unbound variable» tras el OK solo con `--json`: bug del
  script, fuera de la tanda); `tests/documentos-contract` 12/12; `tests/documentos-docs-contract` 7/7; las 7 suites T9 de
  integración verdes en todos los runs (health 4, upload 18, pipeline 6, workflow 20, retention 14, goods-receipts 13,
  email 8).

---

## 4. Hallazgos de los tres revisores: confirmados, refutados, corregidos

Tres revisores (funcional-runtime `RV-*`, seguridad-privacidad-RBAC `SEC-*`, regresiones-honestidad `R*`) sobre el
carril con instancia propia y tenants aislados. Tras el dedupe: **18 confirmados** (2 altos funcionales, 1 alto de
seguridad, 15 medios) y **2 refutados**. El corrector los corrigió todos con test (unitario y de integración) y además
13 hallazgos menores que el dedupe le pasó (§4.4). Ficheros del corrector en `T9-MERGE-LINES.md` §16.1.

### 4.1 Confirmados y corregidos

| Id | Sev. | Hallazgo (evidencia en runtime) | Corrección (test) |
|---|---|---|---|
| RV-01 | alta | Dividir un escaneo no separaba nada: el pipeline de cada trozo leía el PDF físico completo (`pipeline.service.ts:628`), escribía filas `DocumentPage` de TODAS las páginas y extraía campos de las otras facturas; `merge` duplicaba filas | `IncomingDocument.sourcePagesJson` (migración `20260920130000_documentos_split_paginas_retencion`), `selectSourcePages` recorta texto, filas y `pageCount`; el PDF completo no viaja al modelo (aviso `pdf_split_text_only`); `merge` por `pageCount`. `pipeline-fallback`, `split-merge-pages`, integración `documents-workflow` «RV-01» con `multiInvoicePdf`: cada trozo extrae SOLO su factura |
| RV-02 | alta | 9 rutas rebajadas a `riskLevel: authenticated` (bandeja, detalle, descarga, imagen de página, hoja de remesa, split, merge, classify, extract) se servían sin token y sobre CUALQUIER organización con `HOTELOS_ALLOW_DEMO_AUTH=true` (`requireAnyPermission` eximía al platform admin del fallback demo) | `requireRealSession` en los handlers de `documents / pipeline / workflow.routes.ts` → 401 al fallback sin token; verificado en `:3921` (9 × 401 con `prop_123`, `/users/me` anónimo 200) y por integración `callAnonymous`; textos de los 3 partials, api-contracts y runbook corregidos (SEC-06) |
| RV-03 | media | Tras repartir todas las páginas, el origen quedaba como cascarón `captured` con `pageCount 0`, seguía en la bandeja con «Enviar» habilitado y entraba en la cola y la valija | Origen repartido entero → `archived` + `mergedIntoId` = primer trozo + retención; origen parcial renumerado con `sourcePagesJson`; `send-to-office` sobre `pageCount 0` → 409 `DOCUMENT_STATUS_TRANSITION` `reason no_pages` |
| RV-04 | media | Los documentos que llegaban a `posted` (factura contabilizada, gasto, recepción) nunca recibían `retentionUntil`: el job no los bloqueaba ni purgaba y el archivo mostraba «—» | `retentionUntil` en `postSupplierBill`, `approve create_expense` / `create_goods_receipt` y barrido «retention» del job para `posted` sin fecha (`retention.test`, integración) |
| RV-05 | media | Correspondencia de proveedores retenida 4 años (diseño §8: `letterRetentionYears` 6; §3.2: art. 30 CCom) | Defecto 6 en `retention-rules.ts`, `settings.service.ts`, `schema @default` + migración; 4 solo con `guestId` (`personalDataRetentionYears`); docs |
| RV-06 | media | `DocumentSettings.autoSendToOffice` se persistía pero nadie lo leía | Aplicado al terminar el pipeline de `capture` / `email`: `UPDATE` condicional `captured → sent_to_office`, `DOCUMENT_SENT` `actorType system` `automatic:true`, aviso a revisores |
| RV-07 | media | El nº de factura corregido por el revisor (`reviewedFields.invoiceNumber`) se ignoraba en la re-propuesta y en la factura creada (`documentNumber` de la extracción original prevalecía) | `applyReviewedFields`: `invoiceNumber` / `deliveryNoteNumber` revisados fijan `documentNumber`; integración: `proposal.supplierBill.invoiceNumber` sigue al revisado |
| RV-08 | media | Una e-factura XML subida no podía marcarse `source e_invoice` (400) ni el servidor lo derivaba: entraba `upload / at_centre` y la factura nacía `digitized` | `captureIncomingDocuments` deriva `source e_invoice` + `physicalStatus not_applicable` cuando el XML es Facturae / UBL reconocido; la factura nace `e_invoice` (`DOCUMENT_CLIENT_SOURCES` sigue sin admitir `e_invoice` del cliente, por diseño) |
| RV-09 | media | `POST /properties/:propertyId/email/ingest` descartaba `attachments` (declarado por T9-07): un correo con PDF sobre un buzón `documents` respondía `documents_ignored` | `server.ts` reenvía `attachments` con `bodyLimit = DOCUMENT_UPLOAD_BODY_LIMIT`; el caso «un correo con un PDF» de `t9-email-documents` pasa a HTTP |
| RV-10 | media | Sin aviso a la oficina al enviar un documento ni aviso diario por SLA vencido (§6.3) | `office-notifications.ts`: aviso a `documents.review` del centro al enviar (agrupado por hora, sin remitente) y paso «sla» diario del job a `documents.admin` (`office-notifications.test`, `retention.test`, integración) |
| RV-11 | media | `checks.totals` en `fail` sin líneas ni total extraídos (todo albarán, tique o imagen sin proveedor) obligaba a `override.reason` para aprobar cualquier recepción o gasto | `checkTotals`: sin líneas ni total → `warn needsManual`; albarán / tique nunca `fail` salvo contradicción; factura mantiene `fail` con total impreso sin líneas o total ≠ suma |
| SEC-01 | alta | Escritura cross-tenant: `incomingDocumentId` y `source` del cuerpo de `POST/PATCH …/payables/supplier-bills` se persistían sin comprobar tenencia; `post` y `cancel` mutaban después ese documento por id sin ámbito y creaban una notificación en la organización ajena (sonda: el documento `approved` del tenant B pasó a `in_review` desde el tenant A) | `assertLinkedDocumentFieldsAllowed`: por HTTP `incomingDocumentId` y `source ≠ manual` → 400; origen `documents` recomprueba tenencia → 404 `DOCUMENT_NOT_FOUND`; `PATCH` conserva enlace y procedencia; `post` y `cancel` acotados por `organizationId + propertyId` (`supplier-bill-link.test`, integración cross-tenant sin efecto) |
| SEC-02 | media | PII del remitente en la auditoría inmutable: la nota «Correo de <from> · Asunto: …» iba al `afterJson` de `DOCUMENT_CAPTURED`, que ni la purga ni `executeErasure` tocan | `afterJson` de `DOCUMENT_CAPTURED / FILE_ADDED / RECAPTURED` sin nota; en correo sin `fileName`, solo `email:{messageId, attachmentId, connectionId}`; `captureNote` en columna propia (purgable); cabecera de `documents-audit.ts` |
| SEC-03 | media | En producción el almacén por defecto era `inline` (base64 en Postgres sin cifrar, tope 2 MiB): nada obligaba a `disk` / `s3` con `NODE_ENV=production` | `DOCUMENT_STORAGE_KIND` `required.when NODE_ENV=production` + `productionExample disk`, `DOCUMENT_STORAGE_DIR` `productionExample /var/lib/anfitorio/documents`; regla «inline no se admite en producción» en `lib/env.ts` y `validate-env.mjs`; ejemplos regenerados con `env-census` (`env.test`, `env-contract`) |
| SEC-04 | media | Fuga de memoria en el almacén inline (el de la demo): cada `put` retenía una copia de los bytes en un `Map` del singleton que nadie leía ni vaciaba | Caché LRU acotada por bytes (`cacheMaxBytes` 8 MiB, `cachedBytes`), `put` sigue sirviendo `get` (`storage-inline.test`) |
| R2 | media | El bloque «Estado verificado (Tanda T9)» de `CLAUDE.md` estaba desfasado (cifras de nav-tree, route-access, dry-run +4, integración, contratos, `gates.sh`) | Reescrito con las cifras finales; este integrador lo vuelve a re-anclar tras la puerta final (§7) |
| R3 | media | Los runs 1-2 de la puerta escribieron tenants de prueba en la BD PRINCIPAL y la trampa seguía abierta (`test:integration` y las suites con `DATABASE_URL ??=` sin `--env-file`) | `package.json` `test:integration` con `--env-file-if-exists=../../.env`; helper `tests/integration/helpers/load-env.mts` en `api-integration` y `rbac-scope` (las otras 32 ya cargaban el `.env` antes del `??=`, verificado); incidente anotado (§3) |
| R4 | media | 9 rutas `authenticated` con `permissions: []` (disyunción `capture ∨ review` solo en el servicio) sin ningún caso HTTP del 403 para split / merge / classify / extract / sheet | Integración: sesión `auditor` (solo `archive.read`) → 403 en bandeja, detalle, classify, extract, split, merge y hoja; 200 en descarga. El `anyOf` del manifiesto queda pendiente (§8) |

### 4.2 Refutados (con motivo)

| Id | Hallazgo | Por qué se refuta |
|---|---|---|
| SEC-05 | `pnpm-lock.yaml` modificado en el worktree (+74/−25) «sin declarar», riesgo de cadena de suministro | Hecho cierto, defecto no: el lock se regeneró en el aprovisionamiento del worktree por el orquestador (mtime 21:16:34 = segundo de creación; primer fichero de T9 51 min después); es byte-idéntico en los tres worktrees chk / fix1 / t9 (sha256 `006857cd…`) y a la instantánea previa del orquestador; deuda 12(a) conocida desde antes de L2 / L6a; `scripts/merge-lane.sh:30` ya lo excluye del commit y ningún merge previo lo incluyó; pasa `pnpm install --frozen-lockfile --lockfile-only --offline` contra los `package.json` de HEAD. Residuo real y ajeno: el lock COMMITEADO está desfasado desde `82005f1` (2026-06-29) y rompe los despliegues con `--frozen-lockfile` (`README-INSTALL.md:188` documenta la solución: commit aparte en `main`) |
| R1 | «Regresión de honestidad»: ningún lote declaró la modificación del lock | Idem: ningún lote ejecutó `pnpm install`; el diff es el mismo md5 `88729fd8…` que ya citaba el informe de UX-1 el 2026-09-19 antes de T9; L3, L5, L6a, T8 y UX-1 lo documentan como «no es de esta tanda, excluir»; el procedimiento del orquestador (`tanda-carril-v3.js:108`: `git add -A hotelos && git reset -q hotelos/pnpm-lock.yaml`) ya toma la decisión. Matiz: `apps/api/package.json` SÍ está ` M` (+1 script `demo:seed-documents`, sin dependencias) |

### 4.3 Verificación del integrador sobre las correcciones (solo lectura, 20/09 08:1x)

- `grep requireRealSession apps/api/src/modules/documents/*.routes.ts` → 14 usos (RV-02); `server.ts:2846-2852` reenvía
  `attachments` (RV-09); `packages/shared/src/payables-types.ts:478` `SUPPLIER_BILL_MATCH_REQUIRED` (R8);
  `DOCUMENT_ERROR_CODES` = 20 (R8, RV-17); `ROLE_TEMPLATE_VERSION = 4`; `ALL_TOOL_NAMES` pinado en 147; `schema.prisma` 287
  modelos / 45 enums; los 4 partials del módulo suman 9 + 2 + 12 + 7 = 30 rutas y el de payables 5.
- Migración del corrector `20260920130000_documentos_split_paginas_retencion`: tres `ALTER` aditivos y reversibles
  (`source_pages_json JSONB`, `capture_note TEXT`, `letter_retention_years DEFAULT 6`), ninguna fila tocada.
- BD `hotelos_t9` (`SELECT`): 0 organizaciones residuales (`org_l2_% / org_rbac% / org_t9% / org_doc%`), 3
  organizaciones, 0 `incoming_documents` (seed purgado), 22 filas terminadas en `_prisma_migrations` (20 carpetas + las 2
  de fix1), 4 claves `documents.%` en `permissions` (escritas por los arranques del API del carril: por eso el dry-run
  final dice +0).
- Puertos `:3921` / `:5191` sin listeners; `:3000` (PID 4986) y `:5173` no se han tocado en ningún momento de la tanda.

### 4.4 Hallazgos menores del dedupe corregidos por el corrector (sin ficha propia en la lista de confirmados)

RV-12 descargas de un documento bloqueado sin `documents.admin` → 404 opaco (`assertVisible`); RV-13 `assign` exige
`documents.review` del asignado en el centro (400 con `missing`); RV-14 `DocumentKpis.officeSlaBusinessDays` desde el API
(el front dejaba el SLA en una constante); RV-15 `listUsersInScope` solo con `users.read`; RV-16
`GoodsReceiptRecord.receivedByName` (la columna «Recibido por» pintaba un id); RV-17 `pages/:n/image`: original como
página 1 si es imagen, si no 404 `DOCUMENT_PAGE_IMAGE_UNAVAILABLE` distinto del opaco; RV-18 columna `captureNote` y
`searchText` con título y nota (la nota se perdía al correr el pipeline: declarado por T9-05a); RV-19 `cancelSupplierBill`
deja `supplierBillId null`, `rejectNote` con el motivo y `retentionUntil null`; SEC-06 textos de partials / docs que
afirmaban «sesión real exigida» sin serlo; SEC-07 S3 con `AbortSignal.timeout` 30 s y tope `maxBytes` en GET; SEC-08
tenant de la revisión (`org_l2_t9rvmu9ay4tru3ww`) y proveedores de sonda ya inexistentes (0 residuales); R5
`T9-MERGE-LINES` §16.2 atribuye los 14 ficheros «fuera de lista» a sus lotes; R6 JSON de puertas del corrector en
`docs/audits/` y no en el scratchpad; R8 `SUPPLIER_BILL_MATCH_REQUIRED` en `PayablesErrorCode` y los 3 códigos 400 de
recepciones en `DOCUMENT_ERROR_CODES` (16 → 20) con contrato, front y runbook; R9 cabecera de `documentsApi.ts` y fila
`objectStorage` de `docs/manual/60-sistemas.md` (`unconfigured` → `inline` en la demo).

### 4.5 Lo que el corrector dejó SIN corregir a propósito

- `anyOf` en `ApiRoutePermission` / `assertRoutePermission`: las 9 rutas siguen `authenticated` con `requireRealSession`
  (401) + `requireAnyPermission` (403); expresar «`capture` o `review`» en el manifiesto tocaría el parser del contrato,
  `access-decision`, `api-reference` y la matriz `route-access` (15 × 196). Pendiente §8.
- `source: "e_invoice"` enviado por el cliente sigue dando 400 (la derivación es del servidor por MIME + `parseEInvoice`).
- Los dos rojos externos (`nav-tree --check` por CHK; drift por fix1) y el flake ajeno de `l2-persistencia-plataforma`.
- Las filas que otras suites hubieran creado bajo `org_123` en la BD principal durante los runs 1-2 de T9-15 (solo se
  verificó, en lectura, la ausencia de organizaciones / usuarios de prueba residuales).

---

## 5. Qué es real y qué no (degradación honesta)

| Pieza | Sin clave / cuenta / hardware (estado del carril) | Con lo que César aporte |
|---|---|---|
| IA (`AI_PROVIDER=none`) | Clasificación por palabras (confianza 0,35-0,95) y extracción por regex sobre la capa de texto del PDF o el XML; una imagen sin proveedor es `unknown 0` con aviso `image_without_provider` y formulario manual; `POST …/extract {force:true}` → 503 `AI_PROVIDER_UNAVAILABLE` | Los tres ejecutores L6a por `runAiTool` (política por hotel, presupuesto, PII enmascarada, coste en `ai_tool_calls`); verificado con proveedor SIMULADO + runner REAL en integración; nunca con clave real |
| Almacén | `inline` en Postgres (demo; caché acotada) o `disk` cifrado con la clave del `.env` (verificado en runtime) | `s3` (SigV4 propio verificado con los vectores oficiales de AWS y un servidor simulado; sin cuenta real) o `disk` en `/var/lib/anfitorio/documents` con el volumen / `ReadWritePaths` ya preparados |
| Buzón | Conector `manual` y `POST …/email/ingest` con adjuntos (verificado); Gmail / Graph escritos y probados con fakes | OAuth de Gmail Workspace o Microsoft 365 por centro; IMAP sigue fuera (`imapflow` prohibida) |
| Escáner | Ninguno: subida, foto por la PWA (`capture=environment`, compresión) y correo | Scan-to-email al buzón del centro (configuración del aparato) |
| Sage | Diccionario de proveedores (3.720 filas / 2.172 NIF) y libro de recibidas (10.446 filas) REALES solo `SELECT`; `suppliers` de Faranda = 0 y nada se escribe: el alta «desde Sage» se materializa solo al aprobar en la organización que aprueba | Relanzar `third_parties` con `createSuppliers:true` en Faranda solo con autorización, backup y API parado |
| Cotejo | 2 vías albarán ↔ factura | 3 vías con pedidos: fuera de T9 (`purchase_orders` 0 filas; `PurchaseOrder` sin `organizationId` ni cantidades recibidas) |
| Copia digital | «No certificada»: el papel se conserva (ehotelOS no es software homologado por la Orden EHA/962/2007) | Homologar o integrar un software homologado (decisión aparte) |
| Demo sin login (`usr_123`) y plantillas v3 de `org_123` / Faranda | Sin `documents.*` → 403 en captura; el seed `demo:seed-documents` da las claves a Recepción / Administración / Local Super Admin de `org_123` | `rbac:sync` real tras la fusión (+4 claves, 45 roles) |

---

## 6. Fusión (referencia)

`docs/design/olas/T9-MERGE-LINES.md` (16 secciones, anclas de TEXTO por fichero compartido con CHK / fix1 / L6a / T8;
línea base `f77820d`): §1 `server.ts` (6 hunks), §2 `route-permissions.ts`, §3 `env.ts` (+ regeneración UNA vez, el
último), §4 `tenancy.ts`, §5 `permissions / types / index / payables-types`, §6 esquema y las dos migraciones **después
de** `20260920100000_iva_regimen` y `20260920110000_iva_compensacion_inicial` (si CHK añade carpetas ≥ `20260920120000`,
subir el sufijo en carpeta y cabecera), §7 IA, §8 correo, §9 payables (26 hunks), §10 varios, §11 front + CSV (regenerar
`nav-tree.generated.json` con la fila CHK ya resuelta), §12 deploy, §13 docs, §14 post-fusión en orden
(`db:migrate:deploy` + `db:generate` → reiniciar `:3000` → `POST /ai-operations/tools/sync` → `rbac:sync --dry-run` y,
solo con autorización, `rbac:sync` → `env:census:write` → nav-tree / Cocoa → seed de demo), §15 puerta final de T9-15 y
diff del drift, §16 corrector (ficheros, autoría de los 14 «fuera de lista», puerta). `pnpm-lock.yaml` **excluido**.

---

## 7. Ficheros tocados por esta integración y verificación propia

Solo dos ficheros, los únicos permitidos al integrador: `docs/audits/TANDA-T9-DOCUMENTOS-2026-09-19.md` (este documento,
nuevo) y `CLAUDE.md` (bloque «Estado verificado (Tanda T9 …)» re-anclado a la puerta final, referencia a este informe,
línea en «Docs prioritarios» y corrección de la deuda 17, que aún decía que `POST …/email/ingest` no reenviaba
`attachments` y que `PayablesErrorCode` no incluía `SUPPLIER_BILL_MATCH_REQUIRED`: ambos cerrados por el corrector).
Sin `git add / commit / stash / checkout`, sin servidores arrancados, sin escrituras en BD (solo los `SELECT` de §4.3),
`pnpm-lock.yaml` intacto. Contratos de estos ficheros y `gates.sh --quick` tras la edición: cifras en el informe
estructurado del integrador y en `scratchpad/T9/gates-integrador-quick.json`.

---

## 8. Pendientes y deuda que deja la tanda

**Antes o durante la fusión (orquestador):**

1. Aplicar las mergeLines y regenerar `nav-tree.generated.json` desde el CSV compartido una vez fusionado CHK (cierra el
   rojo `nav-tree --check` y los 5 + 2 + 1 pins que la fila CHK pone en rojo en este árbol).
2. `db:migrate:deploy` en `main` (las dos carpetas T9 tras las de fix1 → drift 0, como demuestra `db:install:check`).
3. Reiniciar `:3000` y `POST /ai-operations/tools/sync` (146 → 147; el registro no se sincroniza al arrancar).
4. `rbac:sync` real (escribe `permissions` / `role_permissions` de las 3 organizaciones: solo con autorización); hasta
   entonces `org_123`, Faranda y el fallback demo no tienen `documents.*`.
5. `node scripts/env-census.mjs --write` el último (T8, L6a, CHK y T9 escriben la misma sección); el censo sigue avisando
   de 10 `DOCUMENT_*` «que ningún código lee» porque `documents.config.ts` lee por `readVariable` (patrón que
   `env-census.mjs` no reconoce; `env-partial.test` prohíbe `process.env` en el módulo).
6. `apps/api/docs/openapi.yaml:13772` y `:13803` siguen documentando las dos rutas retiradas (doc estático; solo lo lee
   `brand-contract`); comentarios en `payables.routes.ts:17` y `vat-books.service.ts:900`.
7. Docs con frases ya superadas por el corrector: `docs/runbooks/documentos-digitalizacion.md` §11 («`POST …/email/ingest`
   no reenvía adjuntos») y :17 (cita la sección de api-contracts como «Documentos (Tanda T9)»; el título real es
   «Documentos y digitalización (Tanda T9 · 2026-09-19)»), `T9-MERGE-LINES.md` §14.6 (pins de `attachments` y
   `PayablesErrorCode` ya cerrados).
8. `apps/admin-web/src/services/emailApi.ts` sigue con dos propósitos de buzón (`EmailConnectorsScreen` amplía el tipo
   localmente con un cast documentado).
9. `tests/integration/helpers/l2-tenant.mts` `FARANDA_EXPECTED_INVARIANTS` (25 · 33 · 4.951 · 34 · 110) desfasada
   respecto a la carga real (25 · 33 · 143.228 · 50 · 13.457); las suites comparan baseline vs final, no la constante.
10. `scripts/check-fresh-install.sh --json` termina con «FOREIGN_OBJECTS: unbound variable» tras el OK.

**Deuda funcional del módulo (con dueño en el diseño §13 y en `CLAUDE.md` deuda 17):**

11. `anyOf` en el manifiesto de rutas para expresar `documents.capture ∨ documents.review` (hoy `authenticated` + guarda de
    sesión + disyunción en el servicio; `rbac-nav-contract` `loadManifest` además solo lee ficheros llamados exactamente
    `route-permissions.partial.ts`, así que no ve los partials `pipeline- / workflow- / archive-`).
12. Índice GIN `pg_trgm` sobre `incoming_documents.search_text` (migración propia con `previewFeatures postgresqlExtensions`).
13. Subida solo JSON base64 (`bodyLimit` 40 MiB): multipart pendiente.
14. `split` lógico (los trozos comparten bytes y extraen solo sus páginas por la capa de texto: un trozo escaneado sin
    texto es formulario manual); `merge` no cierra los `AiHumanReviewItem` pendientes de los absorbidos; la hoja de remesa
    cuelga del primer documento del lote (si se purga, desaparece).
15. Sin columna `IncomingDocument.duplicateOfId` (el enlace del rechazo por duplicado va en `rejectNote` y en la
    auditoría) ni `GoodsReceipt.supplierName` (nombre libre en `note`); `create_expense` y el alta de proveedor no son
    atómicos con la transición del documento (sus servicios abren su propia transacción).
16. Sin OCR: imágenes sin proveedor → formulario manual; miniaturas rasterizadas nunca (`imageFileId` siempre null).
17. Clasificación por reglas sin calibración; `contract / other / unknown / e_invoice_status` reutilizan el esquema de
    carta; `findSageReceivedFuzzy` lee ≤ 20 filas por tipo (ventana ±3 días).
18. Detectado en la revisión y fuera del alcance de T9 (deuda 17 d/e): la remesa `POST /treasury/sepa/supplier-payments`
    (`payables.pay`) no pasa por `assertSupplierBillPaymentAuthorized`, y `GET /dashboards/procurement` lee
    `supplier.findMany({ active: true })` sin `organizationId`.
19. El seed da `documents.*` también a «Local Super Admin» de `org_123` (rol custom) y la purga no lo revierte; los
    documentos por correo y e-factura del seed se capturan con el contexto del usuario del centro (no del poller).
20. `avgHoursCentreToOffice` se calcula como media `sentAt → decidedAt` (instrucción del lote) mientras el comentario del
    tipo compartido dice «entre capturedAt y sentAt»: alinear uno de los dos.
21. Sin `checks.documentsRetention` en `/health` (reputación sí lo tiene); `withAdvisoryLock` reutilizado de
    `reputation-lock.ts` (avisos con prefijo `[reputation.lock]`).

---

## 9. Decisiones para César (opción por defecto YA aplicada en el carril)

| # | Decisión | Defecto aplicado | Alternativas y lo que hace falta |
|---|---|---|---|
| 1 | Almacén en el VPS | `disk` cifrado AES-256-GCM (`HOTELOS_FIELD_KEY` / `ENCRYPTION_KEY`) en desarrollo y VPS: `DOCUMENT_STORAGE_KIND=disk`, `DOCUMENT_STORAGE_DIR=/var/lib/anfitorio/documents` (systemd `ReadWritePaths`, volumen `documents-data` en compose); `inline` solo demo y RECHAZADO en producción; `DOCUMENT_MAX_BYTES` 25 MB, `DOCUMENT_UPLOAD_BODY_LIMIT` 40 MB | S3 compatible en la UE (`DOCUMENT_S3_*`: proveedor, región, bucket, credenciales; adaptador SigV4 listo, SSE-S3); alta del directorio en el backup (`deploy.sh` no lo automatiza); las `OBJECT_STORAGE_*` del `.env` quedan sin lector: retirarlas |
| 2 | Buzón de captura por centro | Solo el código: propósito `documents` sobre el conector existente (Gmail Workspace o Microsoft 365 por OAuth), adjuntos pdf / jpeg / png / tiff / xml ≤ 25 MB, dedupe; sin cuenta, la captura es subida manual y foto por la PWA | Un buzón `docs-<centro>@…` por centro + `GMAIL_CLIENT_ID/SECRET` o `MS_CLIENT_ID/SECRET`; IMAP fuera |
| 3 | Escáneres MFP | Ninguno en la tanda | Scan-to-email al buzón del centro (200-300 ppp, dúplex): configuración del aparato |
| 4 | Retención legal | 6 años (art. 30 CCom) desde el 31/12 del ejercicio para facturas, albaranes, contratos y correspondencia; +10 con `extendedRetention` (bienes de inversión); 4 solo con datos personales sin efecto fiscal (`guestId`); rechazados +1; bloqueo 12 meses antes de purgar; `legalHold`; EL PAPEL SE CONSERVA (copia digital no certificada); valores en `DocumentSettings` por organización (`documents.admin`) | Política de retención firmada y registro de actividades de tratamiento; homologar / integrar software homologado (Orden EHA/962/2007) si se quiere destruir papel |
| 5 | Quién registra y quién aprueba (SoD T8a) | `documents.review` para `admin_clerk` y `accountant` (revisan y crean el `SupplierBill` en borrador quedando como registradores); aprueban `manager / operations_director / controller / general_manager / owner` por tramo (T1 50 € … ABOVE_T4) y paga `controller`; `documents.capture` para recepción y jefaturas; `documents.archive.read` para review + `manager / operations_director / auditor / compliance`; `documents.admin` para `controller / general_manager / owner`; `admin` las 4; `ROLE_TEMPLATE_VERSION` 4 aditiva; rutas heredadas `POST /supplier-bills/drafts` y `GET /properties/:id/supplier-bills` retiradas | Otra matriz de plantillas (`permissions.ts`, 15 plantillas); `rbac:sync` real tras la fusión (escribe `role_permissions`: autorización) |
| 6 | Proveedores de Faranda (`suppliers` 0 frente a 3.720 terceros Sage) | NADA se escribe en Faranda: el pipeline busca el NIF en `ledger_third_parties` (`SELECT`), propone «alta desde Sage» y la materializa como `Supplier` solo al aprobar en la organización que aprueba; el check de duplicado mira también `vat_book_entries` recibidas `sage200` por NIF + número; `invoiceNumber` verbatim como el «Número» de Sage | Relanzar `third_parties` con `createSuppliers:true` en Faranda (backup, API parado, autorización) |
| 7 | IA | `AI_PROVIDER=none` → todo por `text_rules` / manual (extractor propio de PDF + regex + XML determinista); con clave, los ejecutores L6a por `runAiTool`; `aiAllowedKinds` por organización (cartas y notificaciones excluidas hasta el encargo) | `AI_PROVIDER=anthropic` + `AI_PROVIDER_API_KEY` + `AI_MODEL` (`AI_MODEL_CLASSIFY` existe), DPA / encargo de tratamiento, ZDR e `inference_geo`; 50 facturas reales anonimizadas para medir acierto, latencia y coste |
| 8 | Extracción en segundo plano | Sin cola ni scheduler nuevo: la captura responde 201 `extractionStatus pending` y lanza el pipeline tras la respuesta en el mismo proceso (`setImmediate` + catch → `failed`; `POST …/extract` lo relanza; el job diario barre los `pending` > 10 min); con `provider none` es instantáneo | Job bajo lease del líder (patrón `reputation-sync.job`) si se quieren reintentos automáticos |
| 9 | Nivel `autonomous` por centro (`PropertyAiToolSetting` de `proposeIncomingDocumentAction`) | Solo archivar cartas / contratos / otros con todos los checks ok y crear `SupplierBill` en `draft`; nunca aprobar ni contabilizar; `AiHumanReviewItem` informativo siempre; la decisión autónoma la ejecuta el job, no el pipeline | Ampliar / restringir por centro desde la cola IA |
| 10 | Tolerancias, SLA, menú | 2 % precio / 0 cantidad / 1,00 € importe; SLA oficina 2 días laborables; `autoSendToOffice false`; la oficina central (`kind office`) también captura; «Digitalizar» ítem propio de Operaciones (`core`, roles recepcion \| administracion \| direccion \| fnb \| pisos \| mantenimiento \| admin); «Documentos» y «Archivo» pestañas de Finanzas › Proveedores y gastos; «Recepciones» pestaña de Compras e inventario (gate `procurement_inventory`) | `PATCH /organizations/:id/documents/settings` (`documents.admin`) para tolerancias / SLA / envío automático; CSV del árbol para el menú |
| 11 | Móvil | PWA con `CocoaFileInput capture=environment` y compresión en el navegador (sin `expo-camera` / `expo-image-picker`, lockfile intacto) | App nativa: fuera |
| 12 | BD del carril | El drift de 3 ítems heredados de fix1 se acepta como línea base documentada (criterio de verde: EXACTAMENTE esos 3) | Fusionar fix1 y rebasar T9 (drift 0), o recrear `hotelos_t9` desde un dump coherente con `f77820d` |
| 13 | Cotejo a 3 vías | Fuera de T9 (`purchase_orders` 0 filas; `PurchaseOrder` sin `organizationId` ni cantidades recibidas); 2 vías con `purchaseOrderLineId` previsto | Lote L7 opcional cuando los pedidos sean persistentes |
| 14 | Demo | Fallback sin login (`usr_123`) y plantillas v3 de `org_123` / Faranda sin `documents.*` hasta el `rbac:sync`; el seed `demo:seed-documents` cubre el walkthrough con `documentos.centro@example.com` / `documentos.oficina@example.com` | Dar `documents.capture` / `documents.review` a la unión demo, o ejecutar `rbac:sync` |

---

## 10. Mensaje de commit propuesto (español, sin trailers)

```
feat(documentos): módulo documents — captura, pipeline IA con fallback, flujo centro→oficina, recepciones y archivo (Tanda T9)

Diseño docs/design/DOCUMENTOS-DIGITALIZACION.md (correcciones «[actualizado 2026-09-19]»),
runbook docs/runbooks/documentos-digitalizacion.md, mergeLines docs/design/olas/T9-MERGE-LINES.md,
informe docs/audits/TANDA-T9-DOCUMENTOS-2026-09-19.md.

Lotes: T9-01 esquema (10 tablas, 7 enums, columnas en supplier_bills/lines; migraciones aditivas
20260920120000_documentos_digitalizacion y 20260920130000_documentos_split_paginas_retencion tras las de
fix1) · T9-02 claves documents.capture/review/archive.read/admin (catálogo 254, plantillas v4 aditiva) ·
T9-03 almacén inline/disk (AES-GCM)/s3 (SigV4 propio), registro DOC-<centro>-<año>-<n>, magic bytes,
pdf-text, einvoice-parser, retención · T9-04 SupplierBillForm extraído + campos T9 en payables ·
T9-05a/b captura, descarga binaria, cola, env DOCUMENT_*, /health objectStorage, compose/systemd ·
T9-06a/b pipeline (ai-core con reglas honestas, proposeIncomingDocumentAction 147.ª herramienta,
validación/cotejo/propuesta con diccionario Sage solo lectura) · T9-07 buzón purpose=documents ·
T9-08 flujo de la oficina (assign/review/approve/reject/archive/split/merge/tareas/valija; factura draft
por payables con SoD; gancho posted/cancel) · T9-09 recepciones de mercancía + StockMovement en tx y
cotejo a 2 vías (SUPPLIER_BILL_MATCH_REQUIRED) · T9-10/11/12 front Cocoa (Operaciones › Digitalizar,
Finanzas › Proveedores › Documentos y Archivo, Compras › Recepciones, Facturas recibidas con origen/cotejo)
· T9-13 archivo, KPIs, ajustes, job de retención del líder, GDPR · T9-14 seed demo:seed-documents ficticio
+ contrato documental · T9-15 retirada de GET /properties/:propertyId/supplier-bills y
POST /supplier-bills/drafts (manifiesto 981), docs, CLAUDE.md.

Corrector (18 hallazgos confirmados + 13 menores, todos con test): split lógico por páginas físicas
(sourcePagesJson), sesión real en las 9 rutas authenticated, enlace factura↔documento solo desde el flujo
(400/404 cross-tenant; post/cancel acotados), retentionUntil al contabilizar, cartas 6 años,
autoSendToOffice operativo, número revisado en la propuesta, XML → e_invoice, attachments en
POST …/email/ingest, avisos a la oficina y SLA diario, totals en warn sin líneas, auditoría sin PII,
DOCUMENT_STORAGE_KIND obligatoria en producción (inline rechazado), caché inline acotada, S3 con tiempo
límite, test:integration con el .env del carril.

Puerta final 12/14 (typecheck 15 · api 3.242 · admin-web 1.916 · contratos 608 · integración 865/857/0/8);
rojos externos: nav-tree por la fila CHK del CSV compartido y drift por las 2 migraciones de fix1 en la
copia de BD. Sin dependencias; pnpm-lock.yaml excluido; nada al VPS; Faranda solo lectura.

Post-fusión: db:migrate:deploy + db:generate, reinicio :3000 + POST /ai-operations/tools/sync,
rbac:sync (autorización), env:census:write, nav-tree/Cocoa regenerados. Decisiones de César en el
informe §9 (S3/disco, buzón, escáneres, retención, IA con clave y DPA).
```
