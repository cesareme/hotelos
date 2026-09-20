# Runbook · Documentos y digitalización con IA (Tanda T9)

Fuente: diseño [`docs/design/DOCUMENTOS-DIGITALIZACION.md`](../design/DOCUMENTOS-DIGITALIZACION.md) (§3 marco legal, §4 captura,
§5 IA, §6 flujo centro → oficina, §7 contabilización y archivo, §9 API, §12 demo). Código: `apps/api/src/modules/documents/*`
(almacén `storage/{storage,inline-storage,disk-storage,s3-storage,index}.ts`; captura y bandeja `documents.service.ts` +
`documents.routes.ts` + `route-permissions.partial.ts`; pipeline `pipeline.service.ts` + `pipeline.routes.ts` +
`pipeline-route-permissions.partial.ts` con el puerto `documents-ai.{port,rules,core-adapter}.ts`, `pdf-text.ts`,
`einvoice-parser.ts`, `validation.ts`, `matching.ts`, `proposal.ts`, `sage-lookup.ts`; oficina `actions.service.ts`,
`workflow.service.ts`, `split-merge.service.ts`, `dispatch.service.ts` + `workflow.routes.ts` +
`workflow-route-permissions.partial.ts`; archivo, KPIs, ajustes y retención `archive.service.ts`, `kpis.service.ts`,
`settings.service.ts`, `retention.service.ts`, `retention-rules.ts`, `documents-retention.job.ts` + `archive.routes.ts` +
`archive-route-permissions.partial.ts`; recepciones y cotejo `goods-receipts.{service,routes}.ts`,
`bill-matching.service.ts`; entorno `env.partial.ts`; configuración `documents.config.ts`), buzón
`apps/api/src/modules/integrations/email/email-documents.service.ts`, esquemas `apps/api/src/schemas/documents.schemas.ts`,
contrato compartido `packages/shared/src/documents-types.ts`, front `apps/admin-web/src/screens/documents/*` +
`services/documentsApi.ts` + `services/goodsReceiptsApi.ts`, seed ficticio `apps/api/src/scripts/seed-documents-demo.ts`
(dataset puro `seed-documents-demo.dataset.ts`). Rutas, cuerpos y permisos: `docs/api-contracts.md` «Documentos (Tanda T9)».

**Todos los datos de este documento son ficticios**: proveedores «… Demo SL», NIF calculados, usuarios `@example.com`.
Nunca se pega aquí una factura real ni el nombre de una persona.

Estado 2026-09-20: escrito en el worktree de la Tanda T9 (rama `tanda-t9`) con los lotes T9-01…T9-13 presentes en el árbol;
el contrato documental `tests/documentos-docs-contract.test.mjs` ata las tablas de §2, §6 y §7 al código.

## 1 · Qué es y qué NO promete

- **Hace**: captura cada documento que llega al centro (subida, foto desde la PWA, buzón de correo del centro, factura
  electrónica XML) como `IncomingDocument` con **número de registro** `DOC-<código del centro>-<año>-<secuencia>`, hash
  SHA-256, formato original y páginas; lo clasifica y extrae campos (con IA cuando hay proveedor, por reglas cuando no,
  §5); lo valida en servidor (NIF, proveedor, sumas, IVA, duplicados, retención, cotejo con albaranes) y **propone** una
  acción; lo lleva del centro a la oficina con SLA, cola y valija con hoja de remesa (§4); al aprobarlo crea la factura de
  proveedor en borrador (`SupplierBill.source = digitized | e_invoice`), el gasto, la recepción de mercancía o la tarea
  con plazo, o lo archiva; conserva el archivo con retención legal, bloqueo y purga (§8) y lo hace consultable por texto.
- **No hace**: **no permite destruir el papel**. La copia es «digital no certificada» (Orden EHA/962/2007 art. 7): el
  original se conserva 6 años (art. 30 CCom) y viaja a la oficina con su número de registro; la ficha, la captura y la hoja
  de remesa lo dicen en un texto legal fijo. Tampoco: OCR de imágenes sin proveedor de IA (una foto sin capa de texto se
  rellena a mano), homologación ante la AEAT, envío de estados de la factura electrónica a la SPFE (queda a la espera de la
  orden ministerial), lectura de buzones IMAP ni configuración de escáneres (scan-to-email al buzón del centro, §3).

## 2 · Configuración (`.env`, sección «Documentos» del contrato `apps/api/src/lib/env.ts`)

Variables de `apps/api/src/modules/documents/env.partial.ts` (las lee solo `documents.config.ts` a través del contrato;
`node scripts/env-census.mjs --write` regenera `.env.example` y `deploy/.env.production.example`):

| Variable | Defecto | Uso |
|---|---|---|
| `DOCUMENT_STORAGE_KIND` | `inline` | Almacén: `inline` (base64 en la fila, tope 2 MiB, solo demo), `disk` (ficheros bajo `DOCUMENT_STORAGE_DIR`, cifrados en reposo) o `s3` (endpoint compatible S3 con firma SigV4 propia, sin SDK). |
| `DOCUMENT_STORAGE_DIR` | — (obligatoria con `disk`) | Directorio raíz del almacén en disco; `validate-env` exige que exista en el host. |
| `DOCUMENT_S3_ENDPOINT` | — (obligatoria con `s3`) | Origen del endpoint (path-style `<endpoint>/<bucket>/<clave>`); HTTPS en producción; **región europea** (evita la comunicación del art. 22 RD 1619/2012). |
| `DOCUMENT_S3_REGION` | — (obligatoria con `s3`) | Región de la firma SigV4 (p. ej. `eu-central-1`). |
| `DOCUMENT_S3_BUCKET` | — (obligatoria con `s3`) | Bucket privado; el API sirve los ficheros, nunca hay URL firmadas públicas. |
| `DOCUMENT_S3_ACCESS_KEY_ID` | — (obligatoria con `s3`) | Id de la clave de acceso. |
| `DOCUMENT_S3_SECRET_ACCESS_KEY` | — (obligatoria con `s3`, secreto) | Clave secreta (nunca en el repo ni en logs). |
| `DOCUMENT_MAX_BYTES` | `26214400` (25 MiB) | Tamaño máximo por fichero (413 `DOCUMENT_TOO_LARGE`, calculado antes de decodificar el base64). |
| `DOCUMENT_UPLOAD_BODY_LIMIT` | `41943040` (40 MiB) | `bodyLimit` de Fastify en las rutas de subida (JSON base64 ≈ 4/3 del fichero). |
| `DOCUMENT_ENCRYPT_AT_REST` | `true` | AES-256-GCM por fichero en `disk` con la clave de campos (`HOTELOS_FIELD_KEY` → `ENCRYPTION_KEY`); en `s3` pide cifrado del proveedor (`x-amz-server-side-encryption: AES256`). Sin clave válida el almacén en disco no arranca. |
| `DOCUMENT_RETENTION_JOB_DISABLED` | `false` (sección «Schedulers») | `true` desactiva el job diario de retención (§8). |

- **Demo local**: sin variables → `inline`; `/health` responde `dependencies.objectStorage = inline` (valores posibles:
  `unconfigured | inline | disk | s3`; `unconfigured` = configuración inválida, el API arranca igual en desarrollo y la
  primera subida responde 500 `DOCUMENT_STORAGE_CONFIG_INVALID`; en producción el contrato aborta el arranque).
- **VPS (`disk`)**: `DOCUMENT_STORAGE_KIND=disk` + `DOCUMENT_STORAGE_DIR=/var/lib/anfitorio/documents`. En
  `deploy/docker-compose.production.yml` es el volumen `documents-data:/var/lib/anfitorio/documents` montado solo en `api`
  (el worker no sirve documentos); en `deploy/systemd/anfitorio-api.service`, `ReadWritePaths=/var/lib/anfitorio/documents`
  (con `ProtectSystem=full`). **Backup**: junto al `pg_dump` de `deploy/scripts/deploy.sh`, `docker run --rm -v
  <proyecto>_documents-data:/data -v $PWD/backups:/out alpine tar czf /out/documents-<fecha>.tgz -C /data .`; sin la clave
  de cifrado los ficheros son ilegibles (guardar `ENCRYPTION_KEY` con el backup). `deploy.sh` no lo automatiza (decisión de
  §11).
- **S3 en la UE**: las cinco `DOCUMENT_S3_*`; `s3-storage.ts` firma SigV4 sobre `fetch` (sin SDK); clave de objeto
  `org/<organizationId>/prop/<propertyId>/doc/<documentId>/<sha256>.<ext>` construida siempre en servidor; migración
  `disk → s3` por script que copia y actualiza `storageKind` / `storageKey` (no incluido en la tanda).
- Lista blanca de subida (`magic-bytes.ts`): `application/pdf`, `image/jpeg`, `image/png`, `image/tiff`, `application/xml`
  / `text/xml`, comprobada por MIME **y** magic bytes; nada de HTML/SVG.

## 3 · Buzón por centro (`purpose = documents`)

- Una `EmailConnection` por centro (Gmail Workspace o Microsoft 365 por OAuth; **IMAP sigue sin estar disponible**) con
  `configJson.purpose = "documents"`: Configuración › IA › Conectores de correo (`EmailConnectorsScreen`) lo ofrece como
  «Documentos del centro» («cada adjunto PDF/imagen/XML crea un documento entrante en este centro; el cuerpo del correo no
  se guarda»). Los escáneres multifunción se configuran con **scan-to-email** a ese buzón (PDF 200-300 ppp, dúplex).
- El poller (`email-reservation.service.ts`, contexto de sistema de la organización de la conexión) pide solo mensajes
  con adjuntos: Gmail `has:attachment newer_than:3d` (+ `from:<dominio>` si la conexión filtra), Graph
  `$filter=hasAttachments eq true`; los adjuntos se descargan de forma perezosa. Un correo de reseña de un portal (asunto
  del clasificador de T8) sigue siendo `review_notification` aunque llegue a un buzón `documents`.
- `email-documents.service.ts` crea **un `IncomingDocument` por adjunto** con extensión `pdf | jpg | jpeg | png | tif | tiff
  | xml` (`source = email`, `physicalStatus = not_applicable`, `emailMetaJson = { messageId, attachmentId, from, subject,
  receivedAt, connectionId }`), lo entrega a `captureIncomingDocuments` (lista blanca, sha256, registro, almacén) y lanza el
  pipeline con `trigger: email`. Dedupe en dos capas: `(messageId, attachmentId)` ya ingerido → `ignored:
  already_ingested`; mismo sha256 en la organización → `ignored: duplicate` (409 `DOCUMENT_DUPLICATE_FILE` interno) con el
  registro original. El `InboundEmail` queda `documents_ingested` o `documents_ignored` (motivo por adjunto en
  `draftJson`); el cuerpo solo como `snippet` (≤ 280 caracteres).
- `POST /properties/:propertyId/email/ingest` («Probar con un correo pegado») **no reenvía adjuntos** hoy (el cast del
  cuerpo en `server.ts` omite `attachments`): sirve para probar el clasificador, no la captura (lote T9-07, abierto).

## 4 · Flujo centro → oficina, paso a paso

Estados (`IncomingDocumentStatus`, tabla completa en `workflow.service.ts` `TRANSITIONS`): `captured → sent_to_office →
in_review → approved → posted` (factura) · `in_review → posted` (gasto, recepción) · `in_review → archived` (tarea,
archivo) · `in_review → returned_to_centre → captured` (recaptura) · `in_review → rejected` · `captured → archived`
(carta / contrato / otro desde el centro). Cualquier otro par → 409 `DOCUMENT_STATUS_TRANSITION { from, action }`. Ejes
independientes: `extractionStatus` (pending · done · failed · skipped), `physicalStatus` (at_centre · in_transit ·
at_office · filed · not_applicable) y las banderas `blockedAt` / `deletedAt` (§8).

1. **Capturar (centro, `documents.capture`)** — Operaciones › **Digitalizar** (`/operaciones/digitalizar`,
   `DocumentCaptureScreen`): «Digitalizar» abre `DocumentCaptureDrawer` (varios ficheros, PDF multipágina; en el móvil
   «Hacer foto» con compresión en cliente) → `POST /properties/:propertyId/documents { files[], kindHint?, note?,
   allowDuplicate?, splitPages? }` → 201 con el **número de registro** por fichero; la pantalla lo muestra y ofrece
   «Imprimir etiqueta» (`DocumentLabelDialog`) para escribirlo en el papel. Tira de KPI (capturados hoy · pendientes de
   enviar · en valija · devueltos) y aviso fijo «Copia digital no certificada: conserva el papel». Mismo sha256 en la
   organización → 409 `DOCUMENT_DUPLICATE_FILE` salvo «permitir copia» (`allowDuplicate`). La clasificación y la
   extracción corren en segundo plano (`extractionStatus pending → done`), independientes del estado.
2. **Enviar a la oficina** — fila «Enviar a la oficina» → `POST …/documents/:id/send-to-office` (`sentAt`, SLA en marcha:
   2 días laborables por defecto, `DocumentSettings.officeSlaBusinessDays`). Con `autoSendToOffice` el envío es automático.
3. **Valija (papel)** — selección múltiple → «Cerrar valija (N)» → `POST …/documents/dispatch-batches { documentIds }`:
   lote numerado por centro, los documentos pasan a `in_transit` y se genera la **hoja de remesa** (PDF con los números de
   registro y el texto legal; `GET …/dispatch-batches/:batchId/sheet`). La oficina «recibe la valija» (`POST
   …/dispatch-batches/:batchId/receive { receivedIds }`) → `at_office`; lo que no llega sigue `in_transit`.
4. **Oficina (`documents.review`)** — Finanzas › Proveedores y gastos › **Documentos** (`/finanzas/proveedores/documentos`,
   `IncomingDocumentsScreen`): lista filtrable (Pendientes · En revisión · Aprobados · Devueltos · Archivo, «solo
   vencidos»), visor del original (`DocumentViewer`, miniaturas, «cortar aquí» → `split` / `merge`) y panel de revisión
   (`DocumentReviewPane`: pasos Clasificado → Extraído → Validado → Propuesta, campos con confianza, comprobaciones, formulario
   de la acción). Ámbito por el selector de Finanzas: un centro lee `GET /properties/:id/documents`; «toda la sociedad»
   (`accounting.entity.read` u organización) lee la cola `GET /organizations/:id/documents/queue` con los KPI de
   `GET …/kpis`. La misma cola aparece en Hoy › Pendientes de la IA con la etiqueta «Documento digitalizado» (una revisión
   por documento, también sin proveedor). Pasos: **asignar** (`POST …/assign`, autoasigna al revisor) → **revisar** (`POST
   …/review { reviewedFields, kind?, note }`: los campos corregidos prevalecen sobre la extracción y se recalculan
   comprobaciones y propuesta; no ejecuta nada) → **aprobar** (`POST …/approve { action, supplierBill? | expense? |
   goodsReceipt? | task?, override? }`): ninguna comprobación en `fail` salvo `override.reason` (409
   `DOCUMENT_CHECKS_FAILED { failed }`). Acciones y clave EXTRA además de `documents.review`: `create_supplier_bill` →
   `payables.create` (factura en **borrador** con `incomingDocumentId`, `receptionDate` = día de captura, `source
   digitized | e_invoice`, `documentObjectKey` = clave del original; quien aprueba queda como **registrador** y por
   separación de funciones no podrá aprobarla ni pagarla); `create_expense` → `accounting.journal.post` (ticket o factura
   sin NIF; `paidWith` lo fija el revisor, `vatDeductible:false` sin NIF; contabiliza en el acto → `posted`);
   `create_goods_receipt` → `purchase_orders.receive` (recepción `received` + líneas; movimiento de stock solo con artículo y
   ubicación; 409 `GOODS_RECEIPT_DUPLICATE` por proveedor + nº de albarán → `posted`); `create_task` (tarea `respond | pay
   | file | forward | verify` con `dueAt` de §3.5: +10 naturales notificación, +10 hábiles requerimiento AEAT, +20
   naturales multa de tráfico, +4 hábiles estado de e-factura → `archived`); `archive` (→ `archived`, `retentionUntil`).
   **Rechazar** (`POST …/reject { reason, note?, returnToCentre?, duplicateOfId? }`): `illegible | missing_pages | other`
   con `returnToCentre:true` → `returned_to_centre` + notificación in-app al capturador, que vuelve a capturar con un
   fichero nuevo (`POST …/recapture`, mismo registro); `duplicate | not_ours | other` → `rejected` (final, retención +1
   año, enlace al duplicado).
5. **Contabilizar la factura (payables)** — Finanzas › Proveedores y gastos › Facturas recibidas: la factura nace `draft`
   (columna Origen «Digitalizada» / «e-factura», enlace al documento, `matchStatus`); **otra** persona con
   `payables.approve` la aprueba (`DocumentSettings.requireMatchForApproval` → 409 `SUPPLIER_BILL_MATCH_REQUIRED` con
   varianza o albaranes pendientes) y `accounting.journal.post` la contabiliza; el gancho de `postSupplierBill` pasa el
   documento a `posted` (y `cancelSupplierBill` lo devuelve a `in_review`). El libro de recibidas fecha por
   `receptionDate ?? issueDate`. «Cotejar con albarán» → `POST …/supplier-bills/:billId/match { goodsReceiptIds?, auto? }`
   (2 vías: nº de albarán citado o descripción + cantidad + precio con tolerancias 2 % / 0 / 1,00 €; `matchStatus none |
   partial | full | variance`; la recepción pasa a `billed` cuando todas sus líneas casan).
6. **Archivo y KPIs** — Finanzas › Proveedores y gastos › **Archivo** (`/finanzas/proveedores/archivo`,
   `DocumentArchiveScreen`): búsqueda por texto extraído, tipo, centro, proveedor, fechas, importe y nº de registro sobre
   los `posted | archived | rejected`; detalle con hash, formato, retención, bloqueo legal y descarga del original; bloquear
   / desbloquear / purgar solo con `documents.admin`. Recepciones: Operaciones › Compras e inventario › Recepciones
   (`/operaciones/compras/recepciones`, `GoodsReceiptsScreen`, módulo `procurement_inventory`).

Claves `documents.*` por plantilla (`packages/shared/src/permissions.ts`, versión 4, aditiva):

| Plantilla | `documents.capture` | `documents.review` | `documents.archive.read` | `documents.admin` |
|---|---|---|---|---|
| Recepción (`receptionist`) · Jefatura de recepción · Gobernanta · Encargado de mantenimiento · Jefatura de A&B | sí | — | — | — |
| Dirección de hotel (`manager`) · Dirección de operaciones | sí | — | sí | — |
| Administración de hotel (`admin_clerk`) | sí | sí | sí | — |
| Contabilidad (`accountant`) | — | sí | sí | — |
| Dirección financiera (`controller`) · Propiedad (`owner`) | — | sí | sí | sí |
| Auditoría interna · Cumplimiento | — | — | sí | — |
| Dirección general · Administración de sistema (`admin`) · Emergencia | sí | sí | sí | sí |

Las plantillas de una organización reciben las claves nuevas con `corepack pnpm --filter @hotelos/api rbac:sync` (sin
`--dry-run`; aditivo). Las lecturas «capture **o** review» (bandeja, detalle, descarga, classify/extract, split/merge, hoja de
remesa) van en el manifiesto como `authenticated`: el handler exige sesión real (`requireRealSession` → 401 al fallback demo
sin token, porque el gate solo lo rechaza en high / critical) y el servicio aplica la disyunción con el mismo 403 del gate.

## 5 · IA (`AI_PROVIDER`, ai-core)

- **Sin proveedor (`AI_PROVIDER=none`, defecto)**: `documents-ai.rules.ts`. Clasificación por palabras sobre la capa de
  texto (FACTURA / INVOICE → `invoice`; ALBARÁN / DELIVERY NOTE → `delivery_note`; TICKET / RECIBO → `receipt`;
  NOTIFICACIÓN / REQUERIMIENTO / AGENCIA TRIBUTARIA / DGT → `administrative_notice`; CONTRATO → `contract`; sin palabras →
  `unknown` o el `kindHint` del capturador con confianza 0,3). Extracción por expresiones regulares (`source text_rules`):
  NIF con dígito de control, fechas, «Nº factura», base, «IVA xx %», retención IRPF, TOTAL, líneas «descripción cantidad
  precio importe», referencias de albarán; XML Facturae / UBL → `einvoice-parser.ts` con confianza 1 (`source
  e_invoice`); una imagen sin capa de texto → sin campos (`image_without_provider`), formulario manual. El texto de un PDF
  lo lee `pdf-text.ts` (FlateDecode, Tj/TJ, ToUnicode; sin OCR). Las comprobaciones y la propuesta (§4) corren igual.
- **Con proveedor**: `AI_PROVIDER=anthropic`, `AI_PROVIDER_API_KEY` y `AI_MODEL` explícito (`AI_DOCUMENT_TIMEOUT_MS`,
  120 s por defecto). `documents-ai.core-adapter.ts` llama SIEMPRE a través del tool runner de ai-core
  (`runAiTool`): gates de módulo, permisos, presupuesto mensual por hotel, rate limit, telemetría en `ai_tool_calls`
  (`inputJson` sin bytes, marcador «<base64 omitido, n caracteres>») y auditoría `actorType: ai`. Herramientas del
  registro (`packages/ai-tools/src/registry.ts`): `classifyIncomingDocument` (low, lectura), `extractIncomingDocumentFields`
  (medium, lectura, confirmación) y `proposeIncomingDocumentAction` (high, `documents.review`, escritura con confirmación).
  Salida estructurada con esquema por tipo (`extraction-schemas.ts`, `{ value, confidence, page }` por campo); imágenes en
  tramos de ≤ 20 páginas, PDF como un solo bloque; **coste** y tokens en `DocumentExtraction` desde la telemetría del runner
  (`aiCostEur` en los KPI). Cualquier fallo del proveedor (sin clave, presupuesto, política, salida inválida) cae a las
  reglas con una nota honesta (`ai_denied:<motivo>`, `llm_error:<código>`) en `warningsJson`; `POST …/classify` y
  `POST …/extract` con `force:true` exigen proveedor y responden 503 `AI_PROVIDER_UNAVAILABLE` si falta.
- **Gobernanza**: `DocumentSettings.aiAllowedKinds` (por defecto `invoice`, `delivery_note`, `receipt`; `[]` = todos los
  que permita ai-core) decide qué tipos viajan al proveedor — cartas y notificaciones **solo** tras firmar el encargo de
  tratamiento (§11). Autonomía por centro con `PropertyAiToolSetting` de `proposeIncomingDocumentAction`: con nivel
  `autonomous` y **todas** las comprobaciones `ok`, el job de retención (§8, paso 4) aplica sola la propuesta, pero solo
  `archive` o `create_supplier_bill` **en borrador** (nunca aprueba ni contabiliza) y deja un ítem informativo en la cola.
  El coste de referencia del diseño (§5.1) es 0,02-0,08 $ por factura; la elección de modelo y de residencia es de César.

## 6 · Rutas y permisos

### 6.1 Tabla exacta (manifiesto `security/route-permissions.ts` ← partials del módulo)

Fuente: `modules/documents/route-permissions.partial.ts`, 9 entradas · `modules/documents/pipeline-route-permissions.partial.ts`,
2 entradas · `modules/documents/workflow-route-permissions.partial.ts`, 12 entradas ·
`modules/documents/archive-route-permissions.partial.ts`, 7 entradas · y las 5 filas de la Tanda T9 de
`modules/payables/route-permissions.partial.ts` (recepciones y cotejo). «—» = `authenticated` (sesión real exigida por el
handler con `requireRealSession`: 401 sin token; la disyunción de claves la exige el servicio con el mismo 403). El riesgo
es el del manifiesto.

| Ruta | Clave(s) | Riesgo |
|---|---|---|
| `POST /properties/:propertyId/documents` | `documents.capture` | medium |
| `POST /properties/:propertyId/documents/:id/files` | `documents.capture` | medium |
| `GET /properties/:propertyId/documents` | — (servicio: `documents.capture` o `documents.review`) | authenticated |
| `GET /properties/:propertyId/documents/:id` | — (servicio: `documents.capture` o `documents.review`) | authenticated |
| `GET /properties/:propertyId/documents/:id/file` | — (servicio: `documents.capture`, `documents.review` o `documents.archive.read`) | authenticated |
| `GET /properties/:propertyId/documents/:id/pages/:n/image` | — (servicio: `documents.capture`, `documents.review` o `documents.archive.read`) | authenticated |
| `POST /properties/:propertyId/documents/:id/send-to-office` | `documents.capture` | medium |
| `POST /properties/:propertyId/documents/:id/recapture` | `documents.capture` | medium |
| `GET /organizations/:organizationId/documents/queue` | `documents.review` (+ ámbito R11) | medium |
| `POST /properties/:propertyId/documents/:id/classify` | — (servicio: `documents.capture` o `documents.review`) | authenticated |
| `POST /properties/:propertyId/documents/:id/extract` | — (servicio: `documents.capture` o `documents.review`) | authenticated |
| `POST /properties/:propertyId/documents/:id/assign` | `documents.review` | high |
| `POST /properties/:propertyId/documents/:id/review` | `documents.review` | high |
| `POST /properties/:propertyId/documents/:id/approve` | `documents.review` (+ la clave de la acción, §4) | high |
| `POST /properties/:propertyId/documents/:id/reject` | `documents.review` | high |
| `POST /properties/:propertyId/documents/:id/archive` | `documents.review` | high |
| `POST /properties/:propertyId/documents/:id/split` | — (servicio: `documents.capture` o `documents.review`) | authenticated |
| `POST /properties/:propertyId/documents/:id/merge` | — (servicio: `documents.capture` o `documents.review`) | authenticated |
| `POST /properties/:propertyId/documents/:id/actions` | `documents.review` | medium |
| `PATCH /properties/:propertyId/documents/:id/actions/:actionId` | `documents.review` | medium |
| `POST /properties/:propertyId/documents/dispatch-batches` | `documents.capture` | medium |
| `POST /properties/:propertyId/documents/dispatch-batches/:batchId/receive` | `documents.review` | medium |
| `GET /properties/:propertyId/documents/dispatch-batches/:batchId/sheet` | — (servicio: `documents.capture` o `documents.review`) | authenticated |
| `GET /organizations/:organizationId/documents/archive` | `documents.archive.read` (+ ámbito R11; bloqueados solo con `documents.admin`, `includeBlocked` y `reason`) | medium |
| `GET /organizations/:organizationId/documents/kpis` | `documents.review` (+ ámbito R11) | medium |
| `GET /organizations/:organizationId/documents/settings` | `documents.admin` | high |
| `PATCH /organizations/:organizationId/documents/settings` | `documents.admin` | high |
| `POST /organizations/:organizationId/documents/:id/block` | `documents.admin` | critical |
| `POST /organizations/:organizationId/documents/:id/unblock` | `documents.admin` | critical |
| `POST /organizations/:organizationId/documents/:id/purge` | `documents.admin` | critical |
| `POST /properties/:propertyId/goods-receipts` | `procurement.manage` | high |
| `GET /properties/:propertyId/goods-receipts` | `inventory.read` | medium |
| `GET /properties/:propertyId/goods-receipts/:id` | `inventory.read` | medium |
| `POST /properties/:propertyId/goods-receipts/:id/dispute` | `procurement.manage` | high |
| `POST /properties/:propertyId/payables/supplier-bills/:billId/match` | `procurement.manage` | high |

### 6.2 Notas

- Ámbito R11 (cola, archivo, KPIs): un centro del ámbito, toda la sociedad con `accounting.entity.read` u organización, o
  «todos los centros» cuando las asignaciones los cubren; si no, 404 opaco `ENTITY_SCOPE_REQUIRED`.
- Tenencia: `:propertyId` por el hook global de `server.ts` y `:organizationId` por `assertEntityAccess`; el documento se
  recomprueba contra el centro y la organización (404 opaco `DOCUMENT_NOT_FOUND`). Los bloqueados por retención son
  invisibles salvo `documents.admin`; los purgados nunca se listan.
- Las dos rutas de subida llevan `bodyLimit` propio (`DOCUMENT_UPLOAD_BODY_LIMIT`); las descargas responden
  `content-disposition` (`?inline=1`), `x-content-type-options: nosniff`, `cache-control: private, no-store` y quedan
  auditadas (`DOCUMENT_DOWNLOADED`).

## 7 · Códigos de error (`DOCUMENT_ERROR_CODES`, `packages/shared/src/documents-types.ts`)

Todo 4xx/5xx tipado lleva `details.code`; el front traduce con `DOCUMENT_ERROR_MESSAGES`
(`screens/documents/documents-helpers.ts`).

| Código | HTTP | Cuándo | Mensaje del API |
|---|---|---|---|
| `VALIDATION_ERROR` | 400 | Cuerpo o query fuera del esquema zod (`.strict()`), cursor inválido, `assignedTo` fuera de la organización, `reason` ausente con `includeBlocked` | «<Qué> no válido: <ruta>: <detalle>» (+ `issues[]`) |
| `DOCUMENT_MIME_NOT_ALLOWED` | 400 | MIME declarado fuera de la lista blanca | «Tipo de fichero no admitido: <mime>. Admitidos: PDF, JPEG, PNG, TIFF y XML.» |
| `DOCUMENT_CONTENT_MISMATCH` | 400 | Los magic bytes no coinciden con el MIME (HTML/SVG disfrazado incluido) | «El contenido del fichero no corresponde al tipo declarado (<mime>).» |
| `DOCUMENT_ACTION_INVALID_FOR_KIND` | 400 | Cuerpo de otra acción en `approve`; archivar desde el centro un tipo con efecto fiscal | «El cuerpo «<clave>» no corresponde a la acción «<acción>».» / «Desde el centro solo se archivan cartas, contratos y otros documentos sin efecto fiscal…» |
| `DOCUMENT_NOT_FOUND` | 404 | Documento inexistente, de otro centro / organización, purgado, bloqueado sin `documents.admin`; también valija, hoja de remesa o tarea inexistentes | «Documento no encontrado.» |
| `PROPERTY_NOT_FOUND` | 404 | Centro inexistente o de otra organización | «Propiedad no encontrada.» |
| `ENTITY_SCOPE_REQUIRED` | 404 | Cola, archivo o KPIs sin centro y sin ámbito de sociedad (R11) | «Ámbito no disponible: indica el centro de trabajo asignado (propertyId).» |
| `DOCUMENT_DUPLICATE_FILE` | 409 | Mismo sha256 en la organización (o repetido en el envío) sin `allowDuplicate`; mismo fichero en `files` / `recapture` | «El fichero «<nombre>» ya existe en la organización (registro <n.º>).» |
| `DOCUMENT_STATUS_TRANSITION` | 409 | Par (estado, acción) fuera de la tabla §6.1, carrera entre dos peticiones, papel fuera del centro al cerrar la valija, tarea ya cerrada, purga sin bloqueo | «La acción «<acción>» no es válida en el estado «<estado>».» (`details { from, action }`) |
| `DOCUMENT_BLOCKED` | 409 | Documento bloqueado por retención vencida (cualquier acción salvo `unblock` / `purge`); bloquear dos veces; pipeline sobre un purgado | «El documento está bloqueado por retención vencida…» |
| `DOCUMENT_LEGAL_HOLD` | 409 | `purge` con `legalHold` | «El documento está bajo retención legal (legalHold): no se puede purgar.» |
| `GOODS_RECEIPT_DUPLICATE` | 409 | Recepción del mismo proveedor con el mismo nº de albarán | «Ya existe una recepción del mismo proveedor con el albarán «<n.º>».» |
| `SUPPLIER_BILL_MATCH_REQUIRED` | 409 | `approveSupplierBill` con `requireMatchForApproval`: varianza fuera de tolerancia o albaranes pendientes con líneas de compra | «El cotejo con los albaranes tiene diferencias fuera de tolerancia…» / «El proveedor tiene <n> albarán(es) pendientes de cotejar…» |
| `DOCUMENT_TOO_LARGE` | 413 | Fichero mayor que `DOCUMENT_MAX_BYTES` (calculado antes de decodificar) o que el tope inline | «El fichero «<nombre>» supera el tamaño máximo admitido (<bytes> bytes).» |
| `AI_PROVIDER_UNAVAILABLE` | 503 | `classify` / `extract` con `force:true` sin proveedor o con el proveedor caído | «El proveedor de IA no está disponible para esta extracción.» (`details.reason`) |
| `DOCUMENT_CHECKS_FAILED` | 409 | `approve` con alguna comprobación en `fail` sin `override.reason` | «Hay comprobaciones en fallo (<claves>): corrígelas o aprueba con override.reason.» (`details.failed[]`) |
| `DOCUMENT_PAGE_IMAGE_UNAVAILABLE` | 404 | `GET …/pages/:n/image` de un documento existente sin imagen de esa página (PDF sin rasterizar, o página > 1 de una captura de imagen); distinto del 404 opaco | «No hay imagen de la página <n>: el original no está rasterizado (usa GET …/file).» (`details.pageNo`) |
| `INVENTORY_ITEM_INVALID` | 400 | Recepción (`create_goods_receipt` / alta manual) con una línea que apunta a un artículo de inventario inexistente en el centro | «Línea <n>: el artículo de inventario no existe en este centro.» (`details.lineNo`, `inventoryItemId`) |
| `STOCK_LOCATION_INVALID` | 400 | Recepción con una ubicación de almacén inexistente en el centro | «La ubicación de stock no existe en este centro o está inactiva.» (`details.stockLocationId`) |
| `STOCK_QUANTITY_TOO_SMALL` | 400 | Recepción con una cantidad que, a dos decimales, queda en cero para el movimiento de almacén | «Línea <n>: la cantidad recibida redondea a 0,00 y no puede entrar en el inventario (2 decimales).» (`details.lineNo`) |

Códigos internos del almacén que no están en el contrato compartido y salen tal cual en `details.code` (500):
`DOCUMENT_STORAGE_CONFIG_INVALID`, `DOCUMENT_STORAGE_IO`, `DOCUMENT_STORAGE_KEY_INVALID`, `DOCUMENT_STORAGE_FORBIDDEN`,
`DOCUMENT_STORAGE_UPSTREAM`. Los 4xx propios de las recepciones (`INVENTORY_ITEM_INVALID`, `STOCK_LOCATION_INVALID`,
`STOCK_QUANTITY_TOO_SMALL`, `SUPPLIER_REQUIRED`, `SUPPLIER_NIF_INVALID`) son de payables y se documentan allí.

## 8 · Retención, bloqueo, purga y GDPR

- **`retentionUntil`** se fija al archivar / contabilizar / rechazar (`retention-rules.ts`): 31/12 del ejercicio del
  documento (`documentDate ?? capturedAt`) + **6 años** (facturas, albaranes, tickets, contratos, notificaciones;
  `retentionYearsDefault`), **+10** con `extendedRetention` (bienes de inversión, cuotas a compensar;
  `extendedRetentionYears`), **6** también para cartas y «otro» (correspondencia de proveedores, art. 30 CCom;
  `letterRetentionYears`, diseño §8) salvo las que nombran a una persona (`guestId`): **4** (datos personales sin efecto
  fiscal, AEPD 148/2019; regla fija), **+1** para los rechazados. Los documentos contabilizados (factura `posted`, gasto,
  recepción) reciben su `retentionUntil` al pasar a `posted` y el job la completa a los que quedaron sin ella. `legalHold` impide bloquear y purgar. Ajustes por organización (`GET/PATCH …/documents/settings`,
  `documents.admin`; sin fila valen los defectos): SLA 2 días laborables, `autoSendToOffice false`, `aiAllowedKinds`
  [invoice, delivery_note, receipt], tolerancias 2,00 % / 0,000 / 1,00 €, `requireMatchForApproval false`, retención 6 / 6
  / 10 años; auditoría `DOCUMENT_SETTINGS_UPDATED` con los campos cambiados.
- **Job diario** (`documents-retention.job.ts`, arrancado por `server.ts` solo en el líder con `RUN_SCHEDULERS` y sin
  `DOCUMENT_RETENTION_JOB_DISABLED=true`; cada 24 h, también al arrancar; `pg_try_advisory_xact_lock(hashtext('documents.retention'))`
  → otra réplica lo salta): (1) `retentionUntil` vencido y sin `legalHold` → `blockedAt` (`DOCUMENT_BLOCKED`, actor
  `system`): el documento desaparece de bandejas y archivo salvo para `documents.admin` con `includeBlocked=1` y un
  `reason` auditado (`DOCUMENT_BLOCKED_READ`); (2) **12 meses** de bloqueo → **purga**: `storage.delete` de cada fichero
  (fuera del almacén), `inline`, texto de páginas, `searchText`, `emailMetaJson`, `reviewedFieldsJson` y propuesta vaciados,
  campos extraídos pseudonimizados («[purgado]»), `deletedAt`; la fila **nunca se borra** (registro, hash, tamaño y
  auditoría sobreviven; `DOCUMENT_PURGED`); (3) extracción atascada (> 10 min `pending`) → vuelve a lanzar el pipeline;
  (4) decisión autónoma de §5. Cada fallo va en `failed[]` del resultado, nunca se traga ni detiene el barrido.
- **Manual** (`documents.admin`, riesgo critical, cuerpo `{ reason, legalHold? }`): `block`, `unblock` y `purge`
  (solo con `blockedAt` y sin `legalHold` → 409 `DOCUMENT_LEGAL_HOLD`), auditados con actor `user`.
- **GDPR** (`eraseGuestDocuments`, llamado por `executeErasure` antes de pseudonimizar la fila `Guest`): documentos con
  `guestId` del sujeto → `searchText`, título, campos extraídos, campos revisados, meta del correo y texto de páginas
  pseudonimizados con los valores del sujeto (nombre, DNI, e-mail…) y, si el tipo **no** tiene efecto fiscal (`kind ∉
  invoice | delivery_note | receipt`), purga del fichero (`DOCUMENT_GDPR_ERASED`). Nunca se digitaliza por esta vía un
  documento de identidad de huésped.
- Auditoría del módulo (`recordAuditEvent`, entidad `incoming_document`): `DOCUMENT_CAPTURED`, `_FILE_ADDED`, `_SENT`,
  `_DOWNLOADED`, `_RECAPTURED`, `_CLASSIFIED`, `_EXTRACTED`, `_ACTION_PROPOSED` (actor `ai` / `system`), `_ASSIGNED`,
  `_REVIEWED`, `_APPROVED`, `_REJECTED`, `_ARCHIVED`, `_ACTION_CREATED`, `_ACTION_UPDATED`, `_AUTONOMOUS_DECISION`,
  `_SPLIT`, `_MERGED`, `_DISPATCHED`, `_DISPATCH_RECEIVED`, `_DISPATCH_SHEET_DOWNLOADED`, `_BLOCKED`, `_BLOCKED_READ`,
  `_UNBLOCKED`, `_PURGED`, `_GDPR_ERASED`; `GOODS_RECEIPT_CREATED`, `BILL_MATCHED`; nunca bytes ni claves del almacén.

## 9 · Seed de demo y purga (`demo:seed-documents`)

Script `apps/api/src/scripts/seed-documents-demo.ts` (dataset puro y determinista `seed-documents-demo.dataset.ts`; guarda
`assertDemoTarget` de `packages/database/prisma/lib/demo-guard.ts` con el entorno construido desde `--allow-real` /
`--confirm`, nunca `process.env`). Solo escribe en la allowlist demo (`org_123` / `prop_123` / `prop_canary`); un objetivo
real exige `--allow-real --confirm <organizationId|propertyId>` y aun así no es el uso previsto.

```bash
cd apps/api   # o desde la raíz con corepack pnpm --filter @hotelos/api demo:seed-documents -- <flags>
corepack pnpm --filter @hotelos/api demo:seed-documents -- --dry-run          # plan (solo lecturas), exit 0
corepack pnpm --filter @hotelos/api demo:seed-documents -- --apply            # siembra idempotente
corepack pnpm --filter @hotelos/api demo:seed-documents -- --purge --dry-run  # recuento de lo que borraría
corepack pnpm --filter @hotelos/api demo:seed-documents -- --purge --apply    # borra solo lo suyo
# flags: --property <id> (prop_123) · --seed <n> (42) · --json · --allow-real --confirm <id>
```

Qué crea (`--apply`; cada documento pasa por los servicios reales: captura → pipeline con `provider none` → valija → oficina):

| Qué | Detalle |
|---|---|
| RBAC (aditivo) | Claves de plantilla que faltan en «Recepción» (`receptionist`) y «Administración de hotel» (`admin_clerk`) de la organización y las 4 `documents.*` en los roles de `reception@example.com`; `rbac_version + 1` solo si cambió algo. Nunca revoca (mismo criterio que `rbac:sync`). |
| Usuarios | `documentos.centro@example.com` (Recepción, ámbito `prop_123`) y `documentos.oficina@example.com` (Administración de hotel, ámbito organización), contraseña **`hotelos-demo`**, sin MFA ni cambio obligatorio. `reception@example.com` (superusuario del seed base) aprueba y contabiliza las facturas (separación de funciones). |
| Proveedores | «Lavandería Cantábrica Demo SL» (628), «Distribuciones Hosteleras Demo SA» (600), «Suministros Técnicos Demo SL» (622), NIF calculados; un profesional autónomo ficticio con retención 15 % **sin** ficha (la oficina ve la propuesta de alta). |
| 22 documentos (`title` con prefijo `demo-documentos-`) | 12 facturas (9 PDF nativos, 3 PNG «foto de móvil» sin texto, 1 XML Facturae por `e_invoice`), 6 albaranes PDF, 4 de correspondencia (carta por correo, notificación con plazo, contrato, otro). |
| Estados finales | `captured` 2 (INV-01 foto, OTH-01) · `sent_to_office` 2 (INV-02 en valija; INV-10 IVA 5 % con SLA vencido) · `in_review` 3 (INV-09 no cuadra, INV-11 e-factura, INV-12 profesional 15 %) · `approved` 1 (INV-07: factura en borrador cotejada) · `posted` 9 (INV-04/05/06 contabilizadas con cotejo `full` / `variance` / `full`; 6 recepciones AL-04…AL-09, dos sin factura) · `returned_to_centre` 1 (INV-03 ilegible, notificación al centro) · `rejected` 1 (INV-08 reenviada por correo, duplicado de INV-02) · `archived` 3 (carta 6 años, contrato 6 años, notificación con tarea `respond` a +10 días). |
| Valija | Lote 1 (14 documentos) recibido en la oficina; lote 2 (INV-02, INV-10) en tránsito; hojas de remesa en el almacén. |
| Contabilidad | 3 facturas `posted` con asiento, libro de recibidas y `receptionDate`; 8 `BillLineMatch` (varianza de precio −3 % en AL-05). Asientos SOLO en la organización demo. |

Idempotente: un documento se reconoce por su `title` y se salta si existe; usuarios por e-mail, proveedores por NIF. Los
bytes dependen solo de `--seed` (cantidades) y de la fecha ancla (00:00 UTC del día): las fechas de los PDF se mueven con el
calendario, pero un documento ya sembrado no se vuelve a capturar. `--purge --apply` borra solo lo marcado: documentos por
título demo de la organización (con `storage.delete` de cada clave no inline), sus facturas con asientos / libro de IVA /
retenciones, recepciones y cotejos, revisiones de la cola, valijas, notificaciones, sesiones, asignaciones y usuarios demo,
proveedores demo por NIF. **Nunca `audit_events`** ni las claves añadidas a los roles. Comprobación de «0 restos»:

```sql
SELECT count(*) FROM incoming_documents WHERE title LIKE 'demo-documentos-%';
SELECT count(*) FROM users WHERE email IN ('documentos.centro@example.com', 'documentos.oficina@example.com');
SELECT count(*) FROM suppliers WHERE organization_id = 'org_123' AND name LIKE '% Demo S%';
```

Códigos de salida: 0 ok · 1 error (propiedad inexistente, fallo de BD o servicio, un documento que no llegó a su estado) ·
2 flags o guarda. Salida `--json` con el resumen completo (plan, usuarios, proveedores, documento a documento, valijas,
recuento por estado, avisos).

## 10 · Puertas

```bash
corepack pnpm --filter @hotelos/api exec tsc --noEmit -p tsconfig.json                     # typecheck api (0 errores)
node --test tests/documentos-docs-contract.test.mjs tests/demo-seed-contract.test.mjs tests/env-contract.test.mjs
node --test tests/documentos-contract.test.mjs tests/api-route-permissions-contract.test.mjs
cd apps/api && node --import tsx --test src/modules/documents/__tests__/*.test.mts        # unitarios del módulo
node --env-file=.env --test tests/integration/documents-{upload,pipeline,workflow,retention,health}.test.mts tests/integration/goods-receipts.test.mts tests/integration/t9-email-documents.test.mts
corepack pnpm --filter @hotelos/api demo:seed-documents -- --dry-run && corepack pnpm --filter @hotelos/api demo:seed-documents -- --apply
bash scripts/gates.sh --quick --json /tmp/gates.json                                        # ola; completo sin --quick al final
```

Invariantes de la organización real (los recuentos del helper de invariantes de `tests/integration/helpers/l2-tenant.mts`:
facturas, envíos VeriFactu, asientos, importaciones, reservas) idénticos antes y después del seed: el script solo toca la
allowlist demo.

## 11 · Límites y lo que solo César puede aportar

- **Límites de la tanda**: sin OCR (una imagen sin proveedor es un formulario manual); `split` es lógico (los trozos
  comparten los bytes del original y extraen solo sus páginas por la capa de texto: un trozo escaneado sin texto queda
  como formulario manual porque el PDF completo no se envía al modelo) y `merge` no cierra las revisiones pendientes de
  los absorbidos; la hoja de remesa
  cuelga del primer documento del lote (si se purga, la hoja desaparece); cotejo a 2 vías (los pedidos siguen en memoria:
  3 vías = lote L7 opcional); búsqueda `ILIKE` sin índice trigram (migración propia con `pg_trgm` cuando el archivo crezca);
  el buzón no expone `emailMeta` en la bandeja; `POST …/email/ingest` no reenvía adjuntos; el estado de la e-factura no se
  envía a la SPFE; las notificaciones son in-app (sin e-mail adjunto); el poller de correo depende de OAuth (sin IMAP).
- **Decisiones y datos de César** (diseño §12.2): (1) `AI_PROVIDER=anthropic` + clave + `AI_MODEL`, encargo de
  tratamiento (DPA/ZDR, `inference_geo`) — sin ello todo funciona por reglas y a mano; (2) un buzón `docs-<centro>@…` por
  centro (Gmail Workspace o Microsoft 365) y `GMAIL_CLIENT_ID/SECRET` o `MS_CLIENT_ID/SECRET`; (3) modelo y configuración
  de cada escáner (scan-to-email, 200-300 ppp, dúplex); (4) digitalización certificada: conservar el papel (defecto),
  homologar o integrar un software homologado; (5) almacén en el VPS (`disk` + volumen + backup) o S3 compatible en la UE
  (proveedor, región, bucket, credenciales); (6) política de retención firmada (6/10 años, cartas, `legalHold`) y registro de
  actividades de tratamiento; (7) tolerancias de cotejo, SLA de la oficina, centros con envío automático, quién revisa y
  aprueba, si la oficina central también captura; (8) 50 facturas reales anonimizadas para medir acierto, latencia y coste
  por modelo; (9) volumen por centro y mes; (10) régimen de cada sociedad (SII, > 8 M€) para el calendario de la e-factura.
