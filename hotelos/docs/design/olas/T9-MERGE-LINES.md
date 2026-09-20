# Tanda T9 · Documentos y digitalización con IA — mergeLines EXACTAS para el orquestador

**Para:** el orquestador/integrador que fusiona el worktree `~/anfitorio-demo-wt-t9/hotelos` (rama `tanda-t9`,
base `f77820d` «chore(puertas): scripts/gates.sh») sobre `main` junto a los carriles **CHK** (check-in automatizado) y
**fix1** (IVA: régimen y compensación inicial). **Qué es:** por cada fichero COMPARTIDO que T9 tocó (otro carril puede
haberlo tocado también), el hunk con su **línea vigente en `f77820d`** («tras :N» = insertar después de esa línea tal como
está en la base; «sustituye :N» = reemplazar) y una **ANCLA DE TEXTO única** en el fichero: si CHK o fix1 desplazan las
líneas, manda el ancla, no el número. El texto exacto de cada hunk es el del worktree (`git -C ~/anfitorio-demo-wt-t9
diff f77820d -- hotelos/<fichero>`); aquí se transcribe entero cuando es corto y por anclas cuando es largo. Precedente:
`T8-MERGE-LINES.md`. Los ficheros EXCLUSIVOS de T9 (todo `apps/api/src/modules/documents/*`, `apps/admin-web/src/screens/documents/*`,
`services/documentsApi.ts` / `goodsReceiptsApi.ts`, `schemas/documents.schemas.ts`, `packages/shared/src/documents-types.ts`,
`email-documents.service.ts`, `scripts/seed-documents-demo*.ts`, `docs/runbooks/documentos-digitalizacion.md`,
`tests/documentos-*.test.mjs`, `tests/integration/{documents-*,goods-receipts,t9-email-documents}.test.mts`, la migración
`20260920120000_documentos_digitalizacion`) se toman del worktree tal cual y no aparecen aquí.

Verificación de anclas sin red (cada línea debe imprimir exactamente lo citado en su sección):

```bash
cd ~/anfitorio-demo/hotelos   # árbol principal, ANTES de fusionar
sed -n '116p;768p;770p;1769p;2911p;5482p;5487p;8489p;8822,8824p' apps/api/src/server.ts
sed -n '53p;175p;724,725p' apps/api/src/security/route-permissions.ts
sed -n '23p;42p;776p;926p' apps/api/src/lib/env.ts
sed -n '483p' apps/api/src/lib/tenancy.ts
sed -n '251p;2384p' packages/shared/src/permissions.ts
sed -n '294p' packages/shared/src/types.ts
sed -n '12p' packages/shared/src/index.ts
sed -n '91p;111p;131p;146p;215p' packages/shared/src/payables-types.ts
sed -n '341,342p;4126p;4134p;4152p;4159,4160p' packages/database/prisma/schema.prisma
sed -n '249p' packages/ai-tools/src/registry.ts
sed -n '36p' packages/ai-tools/src/tool-names.ts
sed -n '10p;39p;50p' apps/api/src/modules/ai-operations/tools/index.ts
sed -n '14p' apps/api/src/schemas/index.ts
sed -n '19p' apps/api/src/schemas/email-connections.schemas.ts
sed -n '35p;62p;363p;395p;527p;612p;641p' apps/api/src/modules/integrations/email/email-reservation.service.ts
sed -n '36p;145p;167p' apps/api/src/modules/payables/payables.routes.ts
sed -n '35p' apps/api/src/modules/payables/route-permissions.partial.ts
sed -n '31p;34p;529p;534p;686p;750p;814p;855p;910p;1077p' apps/api/src/modules/payables/supplier-bills.service.ts
sed -n '14p;74p;85p' apps/api/src/modules/fnb-inventory/fnb-inventory.service.ts
sed -n '7p;547p' apps/api/src/modules/gdpr/gdpr.service.ts
sed -n '64p' packages/compliance/src/retention-policy.ts
sed -n '112p;224p;226p;283p' apps/admin-web/src/App.tsx
sed -n '132p' apps/admin-web/src/screens/users/users-rbac.ts
sed -n '106p;204p' deploy/docker-compose.production.yml
sed -n '51p' deploy/systemd/anfitorio-api.service
sed -n '181p;474p;644p' apps/api/src/modules/developer/api-reference.service.ts
sed -n '216,217p;333p;503p;505p;507p' docs/api-contracts.md
sed -n '540p;572p;639p;694p;1160p;1165p;1191p' CLAUDE.md
```

Orden de aplicación recomendado: §6 (esquema + migración, DESPUÉS de fix1) → §1-§4 (API) → §5 (shared) → §7 (IA) →
§8-§10 (correo, payables, inventario/GDPR/retención) → §11-§12 (front, deploy) → §13 (docs) → §3.4 (`env:census:write`,
UNA vez, el último en fusionar) → §14 (post-fusión: `db:migrate:deploy`, reinicio, `tools/sync`, `rbac:sync`) → §15 (puerta).

---

## 1 · `apps/api/src/server.ts` (dueño compartido con CHK · 6 hunks)

### 1.1 Imports (tras :116)

Línea vigente (ancla única):

```
116: import { createAiCoreReputationPort } from "./modules/reputation/reputation-ai.core-adapter.js";
```

Insertar tras :116:

```ts
// Documentos y digitalización con IA (Tanda T9): captura/registro/descarga/archivo
// (modules/documents/documents.routes.ts; permisos en modules/documents/route-permissions.partial.ts),
// pipeline de clasificación/extracción/cotejo (modules/documents/pipeline.routes.ts +
// pipeline.service.ts; permisos en pipeline-route-permissions.partial.ts) y puerto de IA
// sobre ai-core (documents-ai.port.ts / documents-ai.core-adapter.ts). La configuración
// del almacén (DOCUMENT_*) se resuelve UNA vez en modules/documents/documents.config.ts.
import { registerDocumentsRoutes } from "./modules/documents/documents.routes.js";
import { registerDocumentPipelineRoutes } from "./modules/documents/pipeline.routes.js";
import { registerDocumentWorkflowRoutes } from "./modules/documents/workflow.routes.js";
import { registerDocumentArchiveRoutes } from "./modules/documents/archive.routes.js";
import { startDocumentsRetentionJob } from "./modules/documents/documents-retention.job.js";
import { runDocumentPipeline } from "./modules/documents/pipeline.service.js";
import { describeDocumentStorageHealth, getDocumentsUploadBodyLimit } from "./modules/documents/documents.config.js";
import { setDocumentsAiPort } from "./modules/documents/documents-ai.port.js";
import { createAiCoreDocumentsPort } from "./modules/documents/documents-ai.core-adapter.js";
```

### 1.2 `/health` · `dependencies.objectStorage` (sustituye :1769; ancla `objectStorage: "unconfigured"` dentro de `buildHealthResponse({`)

Líneas vigentes:

```
1763:     const legacy = buildHealthResponse({
1769:         objectStorage: "unconfigured"
```

(a) Insertar ANTES de `    // Construimos también la respuesta legacy para los consumidores actuales.` (línea previa a :1763):

```ts
    // Documentos (Tanda T9): tipo del almacén que sirve el API — inline (sin
    // configurar nada), disk o s3 — o "unconfigured" si la configuración no
    // permite construir el adaptador. Fuera de `checks`: no degrada `status`;
    // /health es público, así que nunca lleva rutas, endpoints ni buckets
    // (modules/documents/documents.config.ts). DependencyStatus de
    // packages/config solo admite ok|degraded|unconfigured: el builder legacy
    // recibe ok/unconfigured y la respuesta expone el tipo real.
    const objectStorage = describeDocumentStorageHealth();

```

(b) Sustituir :1769 `        objectStorage: "unconfigured"` por:

```ts
        objectStorage: objectStorage === "unconfigured" ? "unconfigured" : "ok"
```

(c) En el `return { ...legacy,` inmediato, insertar tras la línea `      ...legacy,`:

```ts
      dependencies: { ...legacy.dependencies, objectStorage },
```

Contrato: `docs/manual/60-sistemas.md:436` decía `unconfigured` en la demo → ahora `inline` (T9-05b); el worker sigue
reportando `objectStorage: "unconfigured"` (`apps/worker/src/index.ts:96/248`, no sirve documentos).

### 1.3 Registro de rutas (tras :2911)

Línea vigente (ancla única): `2911:   registerLedgerImportRoutes(app);` (inmediatamente antes del comentario
`  // Reputación y reseñas (Tanda T8 · T8-D): bandeja, detalle/PATCH/borrador/caso de`).

Insertar tras :2911:

```ts
  // Documentos y digitalización con IA (Tanda T9): captura (subida/foto/valija),
  // registro, descarga, acciones y archivo (/properties/:propertyId/documents*,
  // /documents/:id*) con el bodyLimit del contrato (DOCUMENT_UPLOAD_BODY_LIMIT; con
  // una configuración inválida el API arranca igual, /health dice «unconfigured»
  // y las subidas responden 500 tipado: en producción el contrato ya aborta antes);
  // cada captura lanza el pipeline (clasificación, extracción con IA o reglas,
  // cotejo y propuesta) en segundo plano con la correlación de la petición; el
  // pipeline persiste su propio fallo (extraction_failed), aquí solo se registra.
  registerDocumentsRoutes(app, {
    uploadBodyLimit: getDocumentsUploadBodyLimit(),
    onCaptured: (documentId: string, correlationId: string) =>
      runDocumentPipeline(documentId, { trigger: "capture", correlationId }).catch((error: unknown) => {
        app.log.error({ err: error, documentId, correlationId }, "[documents] el pipeline tras la captura falló");
      })
  });
  registerDocumentPipelineRoutes(app);
  // Flujo de la oficina (Tanda T9 · T9-08): asignar, revisar, aprobar (factura /
  // gasto / recepción / tarea / archivo), rechazar, archivar, dividir / unir,
  // tareas con plazo y valija con hoja de remesa (modules/documents/workflow.routes.ts;
  // permisos en workflow-route-permissions.partial.ts).
  registerDocumentWorkflowRoutes(app);
  // Archivo, KPIs, ajustes por organización y retención (Tanda T9 · T9-13):
  // /organizations/:organizationId/documents/{archive,kpis,settings,:id/block|unblock|purge}
  // (modules/documents/archive.routes.ts; permisos en archive-route-permissions.partial.ts).
  registerDocumentArchiveRoutes(app);
```

Las 4 rutas de recepciones y la de cotejo NO se registran aquí: van dentro de `registerPayablesRoutes(app)` (§9.2).

### 1.4 Puerto de IA (tras :8489)

Línea vigente (ancla única): `8489:   if (isLlmConfigured()) setReputationAiPort(createAiCoreReputationPort());`

Insertar tras :8489:

```ts
  // IA de documentos (Tanda T9 · §5): con proveedor configurado el puerto pasa por ai-core (extractFromDocument/classify con PII enmascarada y presupuesto por hotel); sin clave sigue el fallback por reglas (regex + diccionario de proveedores). Solo en el proceso que escucha, como el de reputación.
  if (isLlmConfigured()) setDocumentsAiPort(createAiCoreDocumentsPort());
```

### 1.5 Job de retención (ENTRE :8823 y :8824 · patrón del bloque de reputación :8800-8823)

Líneas vigentes (`:8822` cierra el bloque de reputación, `:8823` cierra su `if`, `:8824` cierra la función):

```
8822:     shutdown.register("reputation.sync.job", reputationJob.stop);
8823:   }
8824: }
```

Insertar entre :8823 y :8824 (`schedulerLeader` y `holdsSchedulerLease` ya existen: son los del bloque de reputación):

```ts

  // Documentos (Tanda T9 · T9-13): job diario de retención del líder — bloquea los
  // documentos con retentionUntil vencido, purga los bloqueados hace 12 meses (fichero
  // fuera del almacén, searchText y campos pseudonimizados, deletedAt) salvo legalHold,
  // relanza la extracción atascada (> 10 min pending) y aplica la decisión autónoma;
  // cada vuelta bajo pg_try_advisory_xact_lock(hashtext('documents.retention'))
  // (modules/documents/documents-retention.job.ts). Vive aquí porque apps/worker no
  // depende de @hotelos/api. Disable with DOCUMENT_RETENTION_JOB_DISABLED=true. Como
  // reputación: el arranque del módulo (runAtBoot + log) conserva la cadencia, pero su
  // temporizador propio se detiene y lo sustituye uno que exige el lease en cada vuelta.
  if (schedulerLeader && process.env.DOCUMENT_RETENTION_JOB_DISABLED !== "true") {
    const retentionIntervalMs = 86_400_000;
    const documentsRetention = startDocumentsRetentionJob({ log: app.log, intervalMs: retentionIntervalMs, runAtBoot: true });
    documentsRetention.stop();
    const retentionTick = async () => {
      if (!(await holdsSchedulerLease())) return;
      await documentsRetention.runNow();
    };
    const retentionTimer = setInterval(() => {
      void retentionTick().catch((error) => app.log.error({ err: error }, "[documents.retention.job] failed"));
    }, retentionIntervalMs);
    retentionTimer.unref();
    shutdown.register("documents.retention.job", () => clearInterval(retentionTimer));
  }
```

`server.ts` lee `process.env.DOCUMENT_RETENTION_JOB_DISABLED` → `scripts/env-contract.json` lo registra en `readBy`
(regenerado por §3.4; sin él `tests/env-contract.test.mjs` «readBy … desactualizado» sale en rojo).

### 1.6 Retirada de las rutas heredadas de facturas de proveedor (T9-15, dosier §3.4)

Borrar :768 `  createSupplierBillDraft,` y :770 `  listSupplierBills,` del import de `./modules/accounting/accounting.service.js`
(quedan `createJournalEntryDraft`, `listJournalEntries`, `postJournalEntry`), y borrar el bloque :5482-5506 completo
(ancla de inicio `  app.get("/properties/:propertyId/supplier-bills", async (request) => {`, ancla de fin: la línea en
blanco anterior a `  // ---- Bank reconciliation (Sprint 21 · Track 1) ----`), dejando en su lugar el comentario:

```ts
  // Tanda T9 (documentos · lote T9-15, dosier §3.4): las dos rutas heredadas de facturas de
  // proveedor de este bloque (lista por propiedad y alta de borrador sin líneas) se retiraron
  // del API y del manifiesto; responden 404. Canónicas: GET|POST /properties/:propertyId/payables/
  // supplier-bills (modules/payables/payables.routes.ts, payables.read / payables.create) y la
  // factura digitalizada nace de POST /properties/:propertyId/documents/:id/approve
  // (modules/documents/workflow.routes.ts, action create_supplier_bill).
```

En `apps/api/src/modules/accounting/accounting.service.ts` (mismo commit): `listSupplierBills` (`export async function
listSupplierBills(propertyId: string): Promise<SupplierBillDraft[]>`, final del fichero) se borra; `createSupplierBillDraft`
queda con JSDoc `@deprecated Tanda T9 (T9-15)` porque `tests/withholding-tax-posting-contract.test.mjs:82-99` pina sus
campos de retención; la cabecera «Legacy exports server.ts still imports» se actualiza. El pin
`tests/withholding-tax-posting-contract.test.mjs:93` «exposes retention fields on the canonical supplier-bill HTTP route…»
se re-ancló en el worktree (puerta de ola 5, fichero exclusivo de T9: CHK y fix1 no lo tocan; se toma tal cual): comprueba
que `app.post("/supplier-bills/drafts"` NO está en `server.ts` (líneas de código, no comentarios), que
`POST /properties/:propertyId/payables/supplier-bills` reenvía `request.body` a `createSupplierBill`, que el `billSchema`
de `modules/payables/supplier-bills.service.ts` lleva `retentionRate` / `retentionRowCode` y que `tx.supplierBill.create`
persiste `retentionRate` / `retentionAmount` / `rowCode` (12/12 en verde).

## 2 · `apps/api/src/security/route-permissions.ts` (dueño compartido con CHK · 3 hunks)

Líneas vigentes:

```
53: import { reputationRoutePermissions } from "../modules/reputation/route-permissions.partial.js";
175:   ...reputationRoutePermissions,
724:   { method: "GET", path: "/properties/:propertyId/supplier-bills", permissions: ["accounting.journal.post"], riskLevel: "medium" },
725:   { method: "POST", path: "/supplier-bills/drafts", permissions: ["ai.tool.execute"], riskLevel: "medium" },
```

Insertar tras :53:

```ts
// Documentos y digitalización con IA (Tanda T9): captura, registro, descarga y
// archivo (modules/documents/route-permissions.partial.ts · lote T9-05a) y
// pipeline de clasificación/extracción/cotejo (modules/documents/
// pipeline-route-permissions.partial.ts · lote T9-06a). Claves documents.capture /
// documents.review / documents.archive.read / documents.admin del catálogo v4 (T9-02).
import { documentsRoutePermissions } from "../modules/documents/route-permissions.partial.js";
import { documentPipelineRoutePermissions } from "../modules/documents/pipeline-route-permissions.partial.js";
// Flujo de la oficina, dividir / unir, tareas y valija (modules/documents/
// workflow-route-permissions.partial.ts · lote T9-08): documents.review (high) en
// assign / review / approve / reject / archive; la clave extra de la acción al
// aprobar la exige el servicio.
import { documentWorkflowRoutePermissions } from "../modules/documents/workflow-route-permissions.partial.js";
// Archivo, KPIs, ajustes por organización y retención (modules/documents/
// archive-route-permissions.partial.ts · lote T9-13): documents.archive.read /
// documents.review (medium, + R11 en el servicio) y documents.admin (high en
// ajustes; critical en block / unblock / purge).
import { documentArchiveRoutePermissions } from "../modules/documents/archive-route-permissions.partial.js";
```

Insertar tras :175:

```ts
  // Documentos y digitalización (Tanda T9): ver modules/documents/route-permissions.partial.ts
  // (captura/registro/descarga/archivo) y modules/documents/pipeline-route-permissions.partial.ts (pipeline).
  ...documentsRoutePermissions,
  ...documentPipelineRoutePermissions,
  ...documentWorkflowRoutePermissions,
  ...documentArchiveRoutePermissions,
```

Sustituir :724-725 por el comentario:

```ts
  // Tanda T9 (T9-15): las entradas heredadas GET /properties/:propertyId/supplier-bills y POST /supplier-bills/drafts
  // se retiraron con sus rutas (canónicas en modules/payables/route-permissions.partial.ts).
```

Resultado: manifiesto **948 → 983 → 981** (+9 +2 +12 +7 del módulo, +5 en el partial de payables §9.3, −2 heredadas);
`tests/api-route-permissions-contract.test.mjs` 32/32 exige igualdad con las rutas registradas: aplicar §1.3, §1.6 y §9.2 a
la vez. Las 4 rutas `authenticated` de lectura y las 4 de pipeline/split/merge/hoja van con `permissions: []` (el manifiesto
no expresa disyunciones; `requireAnyPermission` en el servicio). `tests/rbac-nav-contract.test.mjs:313` `loadManifest` solo lee
ficheros llamados exactamente `route-permissions.partial.ts`: los otros tres partials del módulo son invisibles para el contrato
de navegación (no enlaza sus rutas hoy; ampliar el filtro si algún ítem del árbol las cita).

## 3 · `apps/api/src/lib/env.ts` (dueño compartido con L6a/T8 vía partials · 4 hunks + regeneración)

Líneas vigentes:

```
23: import { REPUTATION_ENV_CONTRACT } from "../modules/reputation/env.partial.js";
42:   | "Pagos"
776:   ...REPUTATION_ENV_CONTRACT,
926: export function effectiveValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
```

### 3.1 Insertar tras :23

```ts
import { DOCUMENTS_ENV_CONTRACT } from "../modules/documents/env.partial.js";
```

### 3.2 Insertar tras :42 (unión `EnvSection`; sin esta línea el partial no tipa: `DocumentsEnvContract` usa la sección «Documentos»)

```ts
  | "Documentos"
```

### 3.3 Insertar tras :776

```ts
  // Documentos (Tanda T9): modules/documents/env.partial.ts — almacén de los
  // documentos capturados (DOCUMENT_STORAGE_KIND inline|disk|s3, DOCUMENT_STORAGE_DIR,
  // DOCUMENT_S3_*, DOCUMENT_MAX_BYTES, DOCUMENT_UPLOAD_BODY_LIMIT y
  // DOCUMENT_ENCRYPT_AT_REST · sección Documentos) y el interruptor del job de
  // retención (DOCUMENT_RETENTION_JOB_DISABLED · sección Schedulers). El módulo las
  // lee SOLO en modules/documents/documents.config.ts vía effectiveValue +
  // processEnvironment (su env-partial.test prohíbe lecturas directas del entorno).
  ...DOCUMENTS_ENV_CONTRACT,
```

Insertar tras el cierre de `effectiveValue` (:926-928, antes de `/** Evaluate the \`{ when }\` grammar (see EnvRequired) against effective values. */` :930):

```ts
/**
 * The live process environment for module configs that must not reference it
 * themselves (Tanda T9: modules/documents/documents.config.ts resolves every
 * DOCUMENT_* variable with effectiveValue(processEnvironment(), name); its
 * env-partial contract test forbids direct reads inside modules/documents).
 */
export function processEnvironment(): NodeJS.ProcessEnv {
  return process.env;
}

```

### 3.4 Regeneración (UNA sola vez, el ÚLTIMO en fusionar: T8, L6a, CHK y T9 escriben la misma sección)

```bash
node scripts/env-census.mjs --write    # regenera .env.example, deploy/.env.production.example y scripts/env-contract.json
node --test tests/env-contract.test.mjs
```

Las 11 `DOCUMENT_*` salen como «documentadas que ningún código lee» (AVISO, no error; `readBy: []`) porque
`documents.config.ts` las lee con `readVariable("NOMBRE")` y `scripts/env-census.mjs` no reconoce ese patrón; opción:
añadir a `PATTERNS` del censo `/\breadVariable\(\s*["']([A-Z][A-Z0-9_]+)["']/g` (fichero fuera de T9). `DOCUMENT_STORAGE_DIR` lleva
`productionExample` y no `example` (T9-05b): `.env.example` la deja vacía para que `validate-env --role app` no exija el
directorio en el host. No copiar `.env.example` / `.env.production.example` / `env-contract.json` del worktree a mano.

## 4 · `apps/api/src/lib/tenancy.ts` (dueño compartido · 1 hunk)

Línea vigente (ancla única): `483:   emailConnection: byProperty("Conexión de correo no encontrada.", (id) =>`

Insertar ANTES de :483 (dentro de `const RESOLVERS = {`, tras el resolver `complianceDocument` que termina en `  ),`):

```ts
  // Documentos y digitalización (Tanda T9): documento entrante y recepción de
  // mercancía pertenecen al hotel de la fila (rutas /properties/:propertyId/documents/:id
  // y /goods-receipts/:id); fuera del ámbito del usuario → 404 opaco.
  incomingDocument: byProperty("Documento no encontrado.", (id) =>
    prisma.incomingDocument.findUnique({ where: { id }, select: selectProperty })
  ),
  goodsReceipt: byProperty("Recepción de mercancía no encontrada.", (id) =>
    prisma.goodsReceipt.findUnique({ where: { id }, select: selectProperty })
  ),
```

## 5 · `packages/shared/src/{permissions,types,index,payables-types}.ts` (dueño compartido con CHK/8a)

### 5.1 `permissions.ts` (17 hunks)

(a) Catálogo (tras :251 `  "payables.pay": "Order supplier payments and SEPA remittances",`):

```ts
  // Tanda T9 (documentos y digitalización con IA, docs/design/DOCUMENTOS-DIGITALIZACION.md §6.2)
  "documents.capture": "Capture incoming documents at the work centre (upload, photo, dispatch bag) and send them to the office",
  "documents.review": "Review digitised documents at the office: assign, correct the extracted fields, approve the proposed action or reject",
  "documents.archive.read": "Search and read the document archive (originals, metadata, retention)",
  "documents.admin": "Administer the document module: retention, legal hold, block and purge, AI extraction settings of the organisation",
```

(b) `ROLE_PERMISSION_MAP`: en cada plantilla, tras la ÚLTIMA clave del array (ancla = la última línea del array de esa
plantilla en la base, que pierde su ausencia de coma), añadir el comentario `    // Documentos y digitalización (Tanda T9) · <letras>`
y las claves. Plantilla (línea base de apertura `  <rol>: [`) → claves:

| Plantilla (base) | Ancla (última clave hoy) | Añadir |
|---|---|---|
| `receptionist` (:376) · hunk :465 | `"ai.tool.execute"` | `documents.capture` (· C) |
| `front_office_manager` · hunk :654 | `"ai.high_risk.confirm"` | `documents.capture` |
| `housekeeping_manager` · hunk :723 | `"ai.high_risk.confirm"` | `documents.capture` |
| `maintenance_manager` · hunk :822 | `"ai.high_risk.confirm"` | `documents.capture` |
| `fnb_manager` · hunk :920 | `"ai.high_risk.confirm"` | `documents.capture` |
| `admin_clerk` (:986) · hunk :1053 | `"ai.tool.execute"` (tras `// M23 IA · C`) | `documents.capture`, `documents.review`, `documents.archive.read` (· V C A) |
| `manager` (:1057) · hunk :1287 | `"onboarding.manage_cutover"` | `documents.capture`, `documents.archive.read` (· V C) |
| `operations_director` · hunk :1426 | `"onboarding.go_live"` | `documents.capture`, `documents.archive.read` |
| `accountant` (:1494) · hunk :1569 | `"ai.high_risk.confirm"` | `documents.review`, `documents.archive.read` (· V A) |
| `controller` (:1573) · hunk :1675 | `"ai.high_risk.confirm"` | `documents.review`, `documents.archive.read`, `documents.admin` (· V A E) |
| `compliance` · hunk :1771 | `"ai_tool_registry.manage"` | `documents.archive.read` (· V) |
| `general_manager` · hunk :1965 | `"security.break_glass"` (tras `// Emergencia · §4.8 / regla L0`) | las cuatro (· V C A E) |
| `owner` (:1969) · hunk :2055 | `"ai_incidents.read"` | `documents.review`, `documents.archive.read`, `documents.admin` |
| `auditor` · hunk :2152 | `"onboarding.view_sensitive"` | `documents.archive.read` |
| `admin` (:2156) · hunk :2237 | `"security.break_glass"` | las cuatro |

(c) Versión (sustituye :2384 `export const ROLE_TEMPLATE_VERSION = 3;` → `= 4;`) y sus dos JSDoc: en el bloque que termina
`* ROLE_TEMPLATE_REVOCATIONS); no template loses a key.` añadir antes del ` */`:

```ts
 * Version 4 (Tanda T9 · documentos y digitalización, 2026-09-19): aditiva —
 * las cuatro claves `documents.*` (capture, review, archive.read, admin) se
 * reparten entre 15 plantillas según el diseño §6.2; ninguna plantilla pierde
 * claves y ROLE_TEMPLATE_REVOCATIONS no cambia.
```

y en el JSDoc de `ROLE_TEMPLATE_REVOCATIONS` (termina `* audited run (ROLE_TEMPLATE_UPGRADED with revoked = []).`):

```ts
 *
 * Version 4 (Tanda T9 · documentos y digitalización, 2026-09-19) removes nothing
 * either: it ADDS documents.capture / documents.review / documents.archive.read /
 * documents.admin to 15 templates (design §6.2); this record is unchanged.
```

Pins que cambian con la v4 (ficheros de test, ya ajustados en el worktree: tomar del worktree): `tests/rbac-sod-contract.test.mjs`
(catálogo 250 → 254, `ROLE_TEMPLATE_VERSION = 4`), `apps/api/src/lib/__tests__/rbac-catalog.test.mts`,
`apps/api/src/scripts/__tests__/rbac-sync.test.mts`. Si CHK añade claves, la cifra 254 sube en `rbac-sod-contract` y en
`tests/documentos-contract.test.mjs` (que fija «cada plantilla conserva exactamente las claves de la v3 y solo suma documents.*»:
una clave de CHK en una plantilla obliga a actualizar la instantánea de ese test).

### 5.2 `types.ts` (tras :294 `  | "payables.pay"`)

```ts
  // Tanda T9 (documentos y digitalización con IA): captura en el centro, revisión
  // en la oficina, lectura del archivo y administración (retención, bloqueo, purga).
  | "documents.capture"
  | "documents.review"
  | "documents.archive.read"
  | "documents.admin"
```

### 5.3 `index.ts` (tras :12 `export * from "./payables-types.js";`)

```ts
// Documentos y digitalización con IA (Tanda T9 · L0): catálogos (tipos, estados,
// canales, acciones propuestas, motivos de rechazo, comprobaciones), DTOs de
// documento / extracción / propuesta, recepciones de mercancía, cotejo y códigos
// de error compartidos por el API y el admin-web.
export * from "./documents-types.js";
```

### 5.4 `payables-types.ts` (5 hunks; anclas únicas)

- Tras :91 `export type SupplierBillStatus = (typeof SUPPLIER_BILL_STATUSES)[number];` (y su línea en blanco): los
  catálogos `SUPPLIER_BILL_SOURCES = ["manual", "digitized", "e_invoice"]` / `SupplierBillSource` y
  `SUPPLIER_BILL_MATCH_STATUSES = ["none", "partial", "full", "variance"]` / `SupplierBillMatchStatus` con sus JSDoc (texto
  en el diff, 13 líneas).
- `SupplierBillLineRequest`, tras :111 `  investmentGood?: boolean;`: `quantity?: number | string | null;`,
  `unitPrice?: number | string | null;`, `deliveryNoteRef?: string | null;` (+ 2 JSDoc).
- `SupplierBillRequest`, tras :131 `  roomId?: string | null;`: `receptionDate?: IsoDay | null;`,
  `incomingDocumentId?: string | null;`, `source?: SupplierBillSource;` (+ 3 JSDoc).
- `SupplierBillLineDto`, tras :146 `  fixedAssetId: string | null;`: `quantity: string | null;`, `unitPrice: string | null;`,
  `deliveryNoteRef: string | null;` (+ JSDoc).
- `SupplierBillDto`, tras :215 `  status: SupplierBillStatus;` (antes de :216 `  hasAttachment: boolean;`):
  `receptionDate: IsoDay | null;`, `incomingDocumentId: string | null;`, `source: SupplierBillSource;`,
  `matchStatus: SupplierBillMatchStatus;` (+ JSDoc).

`SUPPLIER_BILL_STATUSES` y el enum Prisma `SupplierBillStatus` no cambian (`tests/finanzas-schema-contract`). Pendiente
declarado por T9-08/T9-09: `PayablesErrorCode` no incluye `SUPPLIER_BILL_MATCH_REQUIRED` ni los 400 de recepciones
(`INVENTORY_ITEM_INVALID`, `STOCK_LOCATION_INVALID`, `STOCK_QUANTITY_TOO_SMALL`), y `DocumentApproveResponse` no tipa los campos
extra del 200 de approve (`supplierBill`, `expense`, `goodsReceipt`, `action`, `sodNote`, `overriddenChecks`, `createdSupplierId`).

## 6 · Esquema y migración (`packages/database/prisma/schema.prisma` · 4 hunks + carpeta nueva)

Líneas vigentes:

```
341: (línea en blanco tras el cierre de `enum ApprovalStatus {` :335-340)
342: model Organization {
4126:   createdByUserId      String?   @map("created_by_user_id")
4134:   @@index([organizationId, issueDate])
4152:   fixedAssetId       String?  @map("fixed_asset_id")
4159: (línea en blanco tras el cierre de `model SupplierBillLine {` :4138-4158)
4160: /// Gasto menor / ticket pagado en el acto: D 6xx (base [+ cuota si no deducible]) / D 472.tipo / H 570|5721|572.
```

- Tras :341 (antes de `model Organization {`): los 7 enums `IncomingDocumentKind`, `IncomingDocumentStatus`,
  `IncomingDocumentSource`, `DocumentStorageKind`, `DocumentPhysicalStatus`, `GoodsReceiptStatus`, `DocumentActionStatus`
  (67 líneas, texto del diff; cada uno con su `///`).
- `model SupplierBill`, tras :4126: `receptionDate DateTime? @map("reception_date") @db.Date`, `incomingDocumentId String?
  @map("incoming_document_id")`, `source String @default("manual")`, `matchStatus String @default("none") @map("match_status")`
  (+ 4 `///`); tras :4134: `  @@index([incomingDocumentId])`.
- `model SupplierBillLine`, tras :4152: `quantity Decimal? @db.Decimal(12, 3)`, `unitPrice Decimal? @map("unit_price")
  @db.Decimal(12, 4)`, `deliveryNoteRef String? @map("delivery_note_ref")` (+ `///`) y, tras la relación
  `supplierBill SupplierBill @relation(...)`, `  /// Tanda T9: cotejos con líneas de albarán (bill_line_matches).` +
  `  matches            BillLineMatch[]`.
- Tras :4159 (antes de :4160): el bloque `// Tanda T9 · Documentos y digitalización con IA (…§8)` con los 10 modelos
  `IncomingDocument`, `DocumentFile`, `DocumentPage`, `DocumentExtraction`, `DocumentAction`, `DocumentDispatchBatch`,
  `GoodsReceipt`, `GoodsReceiptLine`, `BillLineMatch`, `DocumentSettings` (321 líneas, texto del diff). Resultado: 277 → **287
  modelos**, 38 → **45 enums** (`scripts/check-migrations-vs-schema.mjs` 287 / 45).

**Migración** `packages/database/prisma/migrations/20260920120000_documentos_digitalizacion/migration.sql` (carpeta nueva,
tomar del worktree; cabecera de la casa + SQL verbatim de `migrate diff --from-migrations`; 7 `CREATE TYPE`, 2 `ALTER TABLE … ADD
COLUMN`, 10 `CREATE TABLE`, 21 índices, 7 FK; sin `DROP`, sin `CREATE EXTENSION`). Reglas de orden:

1. En `main` se aplica DESPUÉS de las dos de fix1 (`20260920100000_iva_regimen`, `20260920110000_iva_compensacion_inicial`):
   el timestamp ya es posterior, así que `migrate deploy` las aplica en orden aunque se fusionen en cualquier orden.
2. Si CHK u otro carril añade carpetas con timestamp ≥ `20260920120000` antes de fusionar T9, subir el sufijo de la carpeta
   Y del nombre en la primera línea de la cabecera (patrón T8 «2026091912xxxx»); regex `^\d{14}_[a-z0-9_]+$`
   (`tests/migrations-squash-contract.test.mjs:33`).
3. Tras fusionar: `corepack pnpm --filter @hotelos/database db:migrate:deploy && corepack pnpm --filter @hotelos/database db:generate`;
   puertas `db:migrate:status` (N/N), `db:drift:check` **0** en `main` (la BD `hotelos` ya tiene las de fix1),
   `corepack pnpm run db:migrations:check` (287 tablas / 45 enums), `corepack pnpm run db:install:check` (instalación
   limpia, drift 0), `tests/migrations-squash-contract`.
4. **Drift heredado de `hotelos_t9`**: la BD del carril lleva aplicadas las dos de fix1 sin tener sus carpetas → `db:drift:check`
   sale 2 con EXACTAMENTE 3 ítems (enum `VatBookRegime`; `vat_book_entries.regime` + índice `(organization_id, book, regime)`;
   `vat_settings.opening_compensation` / `opening_compensation_period`). Es el criterio de verde de T9 hasta que fix1 se
   fusione o se recree `hotelos_t9`; no es código de T9 (diff pegado en §15).
5. Aplazado a una migración propia: índice GIN `pg_trgm` sobre `incoming_documents.search_text` (exige `previewFeatures =
   ["postgresqlExtensions"]` + `extensions = [pg_trgm]`).

## 7 · IA (dueño L6a) · `packages/ai-tools/src/{registry,tool-names}.ts`, `apps/api/src/modules/ai-operations/tools/{index,documents.tools}.ts`, `tools-coverage.test.mts`

- `registry.ts`, tras :249 `  advancedTool("extractIncomingDocumentFields", "compliance_hub", null, "medium", true, "read"),`:

```ts
  // Documentos y digitalización (Tanda T9 · lote T9-06a, erp_accounting): propuesta de acción de dominio sobre la última extracción
  // (factura en borrador, gasto, recepción, tarea o archivo); escritura → siempre awaiting_confirmation (§5.2).
  advancedTool("proposeIncomingDocumentAction", "erp_accounting", "documents.review", "high", true, "write"),
```

- `tool-names.ts`, sustituye :36:

```ts
// Tanda T9 (lote T9-06a): proposeIncomingDocumentAction (erp_accounting, documents.review) propone la acción de
// dominio sobre la última extracción del documento; escritura con confirmación.
export const DOCUMENTS_TOOL_NAMES = ["classifyIncomingDocument", "extractIncomingDocumentFields", "proposeIncomingDocumentAction"] as const;
```

- `tools/index.ts`: :10 import gana `, proposeIncomingDocumentActionTool`; :39 `// Escrituras (11)` → `(12)`; :50
  `  sendGuestMessageTool` → `  sendGuestMessageTool,` + `  proposeIncomingDocumentActionTool`; cabecera «14 lecturas … y 11
  escrituras» → «12 escrituras (… la 12.ª, proposeIncomingDocumentAction, es de la Tanda T9)».
- `tools/documents.tools.ts`: +37 líneas al final (`proposalSummary` + `proposeIncomingDocumentActionTool` con `preview` /
  `execute` sobre `proposeDocumentAction` de `modules/documents/pipeline.service.ts`), import `type { JsonValue } from
  "@hotelos/ai-core/runner"` y la cabecera actualizada (texto del diff).
- `__tests__/tools-coverage.test.mts`: :50 `"sendGuestMessage"` → `"sendGuestMessage",` + `"proposeIncomingDocumentAction"`;
  :97-99 `146` → `147` (×3) y el `deepEqual` de `DOCUMENTS_TOOL_NAMES` con el tercer nombre; :107+ 7 asserts del tool nuevo
  (effect write · erp_accounting · high · requiresConfirmation · `["documents.review", "ai.tool.execute"]`); :146 `25` → `26`;
  títulos «146/146» → «147/147», «11 escrituras» → «12». Herramientas **146 → 147**.
- Post-fusión: `POST /ai-operations/tools/sync` tras el reinicio del API (`ai_tool_registry` gana la fila de
  `proposeIncomingDocumentAction`; hasta entonces `setPropertyToolSetting` del tool nuevo responde 404).

## 8 · Correo (dueño L3-A/T8) · `schemas/index.ts`, `schemas/email-connections.schemas.ts`, `email-reservation.service.ts`

- `apps/api/src/schemas/index.ts`, tras :14 `export * from "./payroll-commissions.schemas.js";`:

```ts
// Documentos y digitalización (Tanda T9 · lote T9-05a): cuerpos de captura, ficheros, acciones y ajustes.
export * from "./documents.schemas.js";
```

- `email-connections.schemas.ts`, sustituye :18-19 (JSDoc + constante):

```ts
/**
 * `reservation_ai`: extraer reservas con IA (HITL) · `pms_shadow`: entregar los adjuntos al ingest del modo sombra ·
 * `documents` (Tanda T9 · T9-07): cada adjunto PDF / imagen / XML crea un IncomingDocument del centro (no exige fromDomain;
 * el buzón acepta facturas de cualquier proveedor y los filtros `fromDomain` / `subjectContains` son opcionales).
 */
export const EMAIL_CONNECTION_PURPOSES = ["reservation_ai", "pms_shadow", "documents"] as const;
```

- `email-reservation.service.ts` (+190 líneas, 23 hunks; T8 tocó el mismo fichero en `processNormalizedEmail` :384-391 y
  T9 respeta ese bloque). Anclas (línea base → cambio):
  - tras :29 `import { createAlertIfOpen, findProfile, ingestPmsShadowFile } from "../../pms-shadow/pms-shadow.service.js";`: imports
    de `./email-documents.service.js` (`documentsMaxBytes`, `ingestDocumentAttachments`, `isDocumentAttachment`,
    `EmailDocumentsOutcome`) y de `../../../schemas/documents.schemas.js` (`decodeBase64`, `base64DecodedSize`, `isBase64`) +
    `export { DOCUMENT_ATTACHMENT_EXTENSIONS, isDocumentAttachment } from "./email-documents.service.js";`
  - :35 `export const EMAIL_PURPOSES = ["reservation_ai", "pms_shadow"] as const;` → `[…, "documents"]` + JSDoc; nueva
    `export function purposeReadsAttachments(purpose)` (pms_shadow | documents).
  - `NormalizedAttachment` gana `attachmentId?: string`; `type NormalizedEmail` pasa a `export type`.
  - :62 `purposeOf`: `config.purpose === "documents" ? "documents" : …`; nueva `export function gmailQueryFor(options)`.
  - `fetchGmail` (:257) y `fetchGraph` (:299): `readsAttachments = purposeReadsAttachments(options.purpose)` sustituye a
    `options.purpose === "pms_shadow"` en la consulta, el filtro y la lista de adjuntos; `attachmentId` en cada adjunto;
    `bodyText` del propósito `documents` = solo `snippet` / `bodyPreview`.
  - :363 `processNormalizedEmail`: la conexión gana `configJson?: unknown`; ANTES de :395 `  if (!looksLikeBooking(email)) {`
    (y después del bloque T8 `review_notification`):
    `if (purposeOf(connection) === "documents") return (await processDocumentsEmail({ connection, email, correlationId })).row;`
  - tras `processShadowEmail` (:438-526): nuevo bloque `// ---- documents: un correo del buzón del centro → un IncomingDocument por adjunto`
    (`DocumentsEmailOutcome`, `DOCUMENTS_INBOUND_STATUSES`, `processDocumentsEmail`, 77 líneas).
  - :527 `pollConnection`: rama `if (purpose === "documents") { … return { processed, purpose, ingested, failed, ignored }; }`
    antes del bucle de reservas.
  - :612 `ingestManualEmail`: tipo `ManualEmailAttachment`, `normalizeManualAttachments`, parámetro `attachments?`, cuerpo
    opcional si hay adjuntos, `configJson` en la conexión pasada a `processNormalizedEmail`.
  - :641 `createConnection`: `purpose` acepta cualquier valor de `EMAIL_PURPOSES`.
  - Pendiente FUERA de T9 (T9-07): `server.ts` `POST /properties/:propertyId/email/ingest` castea `{ connectionId, from,
    subject, body }` y no reenvía `attachments` (una línea en el cast + `attachments: b.attachments`; con adjuntos grandes,
    `{ bodyLimit }` en esa ruta). `apps/admin-web/src/services/emailApi.ts:11-13,56` (`EmailConnectionPurpose`) sigue con 2
    propósitos: `EmailConnectorsScreen.tsx` amplía el tipo localmente (`MailboxPurpose`) con un cast documentado.

## 9 · Payables (dueño L3) · `supplier-bills.service.ts`, `payables.routes.ts`, `route-permissions.partial.ts`

### 9.1 `supplier-bills.service.ts` (+343 líneas, 26 hunks; anclas por línea base)

| Base | Ancla | Cambio |
|---|---|---|
| :31 | `// blocks, annotated in the audit.` | +13 líneas de cabecera «Tanda T9 (documentos · lote T9-08, diseño §7.1)» |
| :34 | `import type { Prisma } from "@prisma/client";` | + `import { SUPPLIER_BILL_SOURCES, type SupplierBillMatchStatus, type SupplierBillSource } from "@hotelos/shared";` |
| :69-70 | antes de `const lineSchema = z` | `export function decimalInput(scale)` (cantidades 12,3 · precios 12,4) |
| :80-81 | `investmentGood: z.boolean().optional()` de `lineSchema` | + `quantity`, `unitPrice`, `deliveryNoteRef` |
| :99 | `roomId: …` de `billSchema` | + `receptionDate`, `incomingDocumentId`, `source` (`SUPPLIER_BILL_SOURCES`) |
| :132 / :184 | `ComputedBillLine` / `computeBillTotals` | líneas computadas llevan `quantity` / `unitPrice` / `deliveryNoteRef` |
| :254 / :275 / :307 / :311 / :331 | `SupplierBillLineDto` / `SupplierBillDto` / `toLineDto` / `toDto` | DTO local emite los 7 campos nuevos (`dayOf`, `sourceOf`, `matchStatusOf`) |
| :528-534 | `export async function getSupplierBillAttachment` … `if (!match) return { inline: false…` | tipo `SupplierBillAttachment` (+ `documentId?`, `downloadPath?`), `documentIdOfStorageKey`, `documentDownloadPath`; una clave `org/…` responde `documentId` + `downloadPath` |
| :685-743 | `export async function createSupplierBill(` | `lineCreateData`, `createSupplierBillInTx(tx, …)` (alta dentro de la transacción del approve), `auditSupplierBillRegistered`; `createSupplierBill` los envuelve |
| :781 | `documentObjectKey,` en `updateSupplierBill` | `receptionDate` / `incomingDocumentId` / `source` conservan el valor si no vienen; `lines: { create: totals.lines.map(lineCreateData) }` |
| :813 | antes de `export async function approveSupplierBill` | `MatchGuardBill`, `matchGuardReason` (pura), `assertMatchForApproval` → 409 `SUPPLIER_BILL_MATCH_REQUIRED` |
| :823 | `  );` + `const row = await prisma.$transaction(` de approve | `await assertMatchForApproval(prisma, loaded);` |
| :875 | `investmentGood: l.investmentGood` en `postSupplierBill` | + `quantity`, `unitPrice`, `deliveryNoteRef` |
| :910 | `      date: before.issueDate,` (libro de recibidas) | `date: before.receptionDate ?? before.issueDate,` |
| :956 | `    });` antes de `return { row, entry };` | `tx.incomingDocument.updateMany({ … status: "approved" → "posted", postedAt })` |
| :1080 / :1102 / :1113 | `cancelSupplierBill` | `documentReturned`: el documento `approved \| posted` vuelve a `in_review` + `Notification` a `decidedBy`; `afterJson` con `incomingDocumentId` / `documentReturnedToReview` |

### 9.2 `payables.routes.ts` (3 hunks)

- Tras :36 `import { createSupplier, getSupplier, listSuppliers, updateSupplier } from "./suppliers.service.js";`:

```ts
// Tanda T9 (documentos · lote T9-09): recepciones de mercancía y cotejo factura–albarán.
import { matchSupplierBill } from "../documents/bill-matching.service.js";
import { registerGoodsReceiptRoutes } from "../documents/goods-receipts.routes.js";
```

- Antes de :145 `  // ── Expenses / tickets (property-owned) ───────────────────────────────────`:

```ts
  // Tanda T9 (diseño §7.2 / §9): cotejo a 2 vías con albaranes (procurement.manage).
  app.post("/properties/:propertyId/payables/supplier-bills/:billId/match", async (request) => {
    const params = request.params as BillParams;
    return matchSupplierBill({ context: request.userContext, propertyId: params.propertyId, billId: params.billId, body: request.body, correlationId: createId("corr") });
  });

```

- Antes de :167 `}` (cierre de `registerPayablesRoutes`):

```ts

  // ── Recepciones de mercancía (Tanda T9 · T9-09; rutas en modules/documents/goods-receipts.routes.ts, filas en el partial de este módulo) ──
  registerGoodsReceiptRoutes(app);
```

(+ 3 líneas de cabecera tras `// Registrado desde server.ts con \`registerPayablesRoutes(app)\` (integrador).`).

### 9.3 `route-permissions.partial.ts` (tras :35, que pierde su coma final)

```ts
  { method: "POST", path: "/properties/:propertyId/payables/expenses/:expenseId/reverse", permissions: ["accounting.journal.post"], riskLevel: "critical" },
  // Tanda T9 (documentos · T9-09, diseño §9): recepciones de mercancía (goods-receipts.routes.ts, registradas
  // desde payables.routes.ts) y cotejo factura–albarán. Las lecturas van con inventory.read: el diseño dice
  // «accounting.read | inventory.read», pero el manifiesto es una conjunción (assertPermissions) y accounting.read
  // se remapea a accounting.reports.read en este partial (requireAccountingReportsKey), así que la clave de
  // inventario es la que reparte el diseño entre recepción/economato y finanzas sin abrir los informes.
  { method: "POST", path: "/properties/:propertyId/goods-receipts", permissions: ["procurement.manage"], riskLevel: "high" },
  { method: "GET", path: "/properties/:propertyId/goods-receipts", permissions: ["inventory.read"], riskLevel: "medium" },
  { method: "GET", path: "/properties/:propertyId/goods-receipts/:id", permissions: ["inventory.read"], riskLevel: "medium" },
  { method: "POST", path: "/properties/:propertyId/goods-receipts/:id/dispute", permissions: ["procurement.manage"], riskLevel: "high" },
  { method: "POST", path: "/properties/:propertyId/payables/supplier-bills/:billId/match", permissions: ["procurement.manage"], riskLevel: "high" }
```

`tests/documentos-docs-contract.test.mjs` exige exactamente estas 5 filas (`/goods-receipts` o `/match`) en el partial de payables.

## 10 · `fnb-inventory.service.ts`, `gdpr.service.ts`, `packages/compliance/src/retention-policy.ts`

- `fnb-inventory.service.ts`: tras :14 `import { prisma } from "@hotelos/database";` → `import type { Prisma } from "@prisma/client";`;
  :74-85 `recordStockMovement(input: {…})` pasa a `recordStockMovement(input: {…}, tx?: Prisma.TransactionClient)` con
  `const db = tx ?? prisma;` y `return db.stockMovement.create({` (los llamadores actuales no cambian; comentario «Tanda T9
  (recepciones de mercancía, diseño §7.2)»).
- `gdpr.service.ts`: tras :7 `import { scrubReviewMetaForErasure } from "../reputation/review-meta.store.js";`:

```ts
// Documentos digitalizados (Tanda T9 · T9-13, diseño §3.4 / §7.5): documentos con guestId del sujeto →
// searchText / campos extraídos pseudonimizados y, sin efecto fiscal, purga del fichero.
import { eraseGuestDocuments } from "../documents/retention.service.js";
```

  y ANTES de :547 `  // --- Guest table: pseudonymize PII ---` el bloque `// --- IncomingDocument (Tanda T9 · §3.4 / §7.5)` (30
  líneas: `subjectGuests` → `subjectValues` → `eraseGuestDocuments({ organizationId, guestIds, subjectValues, actorUserId })` y
  dos entradas en `tables` `pseudonymized` / `deleted`; texto del diff).
- `retention-policy.ts`: la entrada `voice_command_draft` (termina :64 `    legalHoldAllowed: false` + :65 `  }`) pierde su
  cierre sin coma y se añade:

```ts
  },
  {
    // Tanda T9 (documentos digitalizados, diseño §3.2 / §7.5): 6 años desde el
    // 31/12 del ejercicio (CCom art. 30; 72 meses como referencia), fijados por
    // tipo en apps/api/src/modules/documents/retention-rules.ts; el job del API
    // bloquea al vencer y purga 12 meses después salvo legalHold.
    entityType: "incoming_document",
    mode: "manual_review",
    retentionMonths: 72,
    legalHoldAllowed: true,
    auditAction: "DOCUMENT_PURGED"
  }
```

## 11 · Front (dueño compartido con CHK/UX-1) · `App.tsx`, `users-rbac.ts`, `nav-tree.generated.json`, CSV, whitelist

### 11.1 `apps/admin-web/src/App.tsx` (3 hunks)

- Tras :112 `const EnergyDashboard = lazyNamed(() => import("./screens/operations/EnergyDashboard"), "EnergyDashboard");`:

```ts
// Tanda T9 · documentos: Operaciones › Digitalizar (captura del centro, ítem propio sin gate de módulo).
const DocumentCaptureScreen = lazyNamed(() => import("./screens/documents/DocumentCaptureScreen"), "DocumentCaptureScreen");
```

- En `SCREEN_COMPONENTS`, tras :224 `  InventoryDashboard: ComprasInventarioTabs,`:

```ts
  // Recepciones de mercancía y cotejo con facturas (Tanda T9 · lote T9-12)
  GoodsReceiptsScreen: ComprasInventarioTabs,
```

  y tras :226 `  EnergyDashboard,`: `  DocumentCaptureScreen,`
- Tras :283 `  FixedAssetsScreen: ProveedoresTabs,`:

```ts
  // Documentos digitalizados: bandeja y revisión de la oficina · archivo legal (Tanda T9 · lote T9-12)
  IncomingDocumentsScreen: ProveedoresTabs,
  DocumentArchiveScreen: ProveedoresTabs,
```

CHK añade `CheckInAutomationSettingsScreen` en el mismo mapa (`MiDiaTabs`): sin conflicto de líneas si CHK va en Hoy.

### 11.2 `apps/admin-web/src/screens/users/users-rbac.ts` (tras :132 `  payables: "M9",`)

```ts
  // Tanda T9 · documentos y digitalización: pestaña «Documentos» de Finanzas › Proveedores y gastos (M9).
  documents: "M9",
```

### 11.3 `~/anfitorio-demo/pilots/tanda5-nav-tree.csv` (FUERA del repo; dueño de `pilots/`) → `nav-tree.generated.json`

Filas presentes ya en el CSV compartido (líneas 291 y 293-295; la 292 es la de CHK `CheckInAutomationSettingsScreen`):

```
DocumentCaptureScreen;nueva (Tanda T9);keep;Operaciones;Digitalizar;/operaciones/digitalizar;;recepcion|administracion|direccion|fnb|pisos|mantenimiento|admin;core;Captura de facturas, albaranes y correspondencia en el centro (POST /properties/:id/documents) · sin gate de módulo para que todos los centros digitalicen.;9
IncomingDocumentsScreen;nueva (Tanda T9);merge-into;SupplierBillsScreen;Documentos;/finanzas/proveedores/documentos;Documentos;finanzas|direccion|administracion|admin|auditoria;core;Bandeja y revisión de documentos digitalizados (GET /organizations/:id/documents/queue).;4
DocumentArchiveScreen;nueva (Tanda T9);merge-into;SupplierBillsScreen;Archivo;/finanzas/proveedores/archivo;Archivo;finanzas|direccion|administracion|admin|auditoria;core;Archivo legal con búsqueda por texto extraído (GET /organizations/:id/documents/archive).;5
GoodsReceiptsScreen;nueva (Tanda T9);merge-into;ProcurementDashboard;Recepciones;/operaciones/compras/recepciones;Recepciones;direccion|fnb|finanzas|admin|administracion|auditoria;procurement_inventory;Recepciones de mercancía y cotejo con facturas (/properties/:id/goods-receipts).;2
```

`apps/admin-web/src/navigation/nav-tree.generated.json` NO se fusiona a mano: se regenera con
`node scripts/build-nav-tree.mjs --csv /Users/cfernandez/anfitorio-demo/pilots/tanda5-nav-tree.csv` (counts 69 → 70 ítems,
100 → 104 pestañas, 289 → 294 filas; el JSON del worktree ya incluye la fila de CHK porque estaba en el CSV al regenerar). Si
se fusiona T9 sin CHK, regenerar desde una copia del CSV sin la fila 292 (o `--check` saldrá stale por esa fila; hoy
`check-discoverability` avisa «1 URL sin componente» y `tests/nav-tree-contract` 2 fail por ella). Pins de recuento ya ajustados
en el worktree (tomar): `navigation/__tests__/{nav-tree,sidebar-menu,view-as}.test.mts`, `routes/__tests__/backoffice.routes.test.mts`
(193 → 197 rutas), `components/guide/__tests__/guideContent.test.mts`. `.discoverability-whitelist.json`: `$comment` gana las
frases de T9-04 / ola 3 / ola 4 y `screens` suma `SupplierBillForm`, `DocumentCaptureDrawer`, `DocumentLabelDialog`,
`GoodsReceiptForm`, `DocumentViewer` (tomar del worktree). `/Users/cfernandez/anfitorio-demo/pilots/screens-inventory.csv`:
4 filas nuevas para `tests/rbac-nav-contract` cuando el inventario esté en local (fila propuesta por T9-10 en su informe).

## 12 · Deploy · `docker-compose.production.yml`, `systemd/anfitorio-api.service`, `.env.example` / `.env.production.example` / `env-contract.json`

- `deploy/docker-compose.production.yml`: en el servicio **api** (NO en el worker, que tiene la misma línea `certs` en :141),
  tras :106 `      - ./certs:/certs:ro`: comentario de 8 líneas «Documentos (Tanda T9): almacén en disco …» +
  `      - documents-data:/var/lib/anfitorio/documents`; en `volumes:`, tras :204 `  caddy-config:`:

```yaml
  # Documentos (Tanda T9): almacén en disco del módulo de documentos (montado en api;
  # incluir en el backup junto al dump de Postgres, ver el comentario del servicio api).
  documents-data:
```

- `deploy/systemd/anfitorio-api.service`, tras :51 `ProtectSystem=full`:

```
# Tanda T9: almacén disk de los documentos capturados (DOCUMENT_STORAGE_KIND=disk,
# DOCUMENT_STORAGE_DIR=/var/lib/anfitorio/documents en api.env). ProtectSystem=full
# no bloquea /var, pero el directorio debe existir y pertenecer al usuario del
# servicio: crearlo con install-from-scratch.sh/deploy.sh (mkdir -p + chown
# anfitorio:anfitorio). Incluirlo en el backup junto al pg_dump.
ReadWritePaths=/var/lib/anfitorio/documents
```

- `.env.example` (tras `RUN_SCHEDULERS=true` y bloque `# ==== Documentos ====` tras `CHANNEX_BASE_URL=…`),
  `deploy/.env.production.example` (ídem) y `scripts/env-contract.json`: SOLO por `node scripts/env-census.mjs --write` (§3.4).
  `deploy/scripts/deploy.sh:280` (pg_dump) no copia el volumen `documents-data`: decisión de César (S3 o disco + backup).

## 13 · Docs (dueño integrador) · `CLAUDE.md`, `docs/api-contracts.md`, `docs/runbooks/finanzas-contabilidad.md`, `docs/design/DOCUMENTOS-DIGITALIZACION.md`, Cocoa 22

- `CLAUDE.md` (anclas): bloque «Estado verificado (Tanda T9 · Documentos y digitalización, 2026-09-19)» entre el bloque UX-1
  (:540-570) y `## Servicios en local Mac Pro` (:572); «Seeds»: :639 `Doce seeds, tres ámbitos.` → `Trece seeds…` y párrafo
  «Documentos ficticios (Tanda T9)» tras el de T8 (:694-701, termina `…runbook \`docs/runbooks/reputacion-reviews.md\` §7).`);
  «Deuda técnica» ítem 17 tras el 16 (:1160-1163); «Docs prioritarios» dos líneas tras :1190 (`docs/runbooks/auditoria-eventos.md`).
  Texto: el del worktree (T9-15).
- `docs/api-contracts.md` (anclas): :216-217 (las dos rutas heredadas → línea «Retiradas (Tanda T9 · lote T9-15…)»); «### Correo
  entrante» (:333): viñeta «Propósito `documents`» antes de `- \`DELETE /email/connections/:id\``; sección «## Documentos y
  digitalización (Tanda T9 · 2026-09-19)» ANTES de :503 `## Tanda L2 · Persistencia y API (2026-09-18)`; :505 «948 entradas» →
  «981 entradas»; :507 cabecera «Rutas retiradas (84: 82 de L2-02 + 2 de la Tanda T9…)» + fila «Facturas de proveedor heredadas».
  Si CHK añade rutas, sumar sus entradas a 981 y a la sección de CHK.
- `docs/runbooks/finanzas-contabilidad.md`: §3 (fila `suppliers … supplier_bills …` ampliada + 2 filas nuevas), §11 (rutas
  heredadas de proveedores retiradas), §13 (recuento + filas payables con las claves vigentes + match / goods-receipts +
  párrafo de rutas heredadas), §15 (fila «Documentos digitalizados»). Texto del worktree.
- `docs/design/DOCUMENTOS-DIGITALIZACION.md`: 15 marcadores «[actualizado 2026-09-19 …]» (§1.2, §1.4, §1.1 tabla, §2 filas
  Campos objectKey / IA / Pedidos / Correo, §6.2, §7.5, §8 migración, §10 montaje y servicios, §11 L0 y L2). Texto del worktree.
- `docs/design/COCOA-22-MIGRACION.md` y `docs/design/cocoa-22-inventory.json`: NO fusionar a mano; tras la fusión
  `node scripts/cocoa-22-inventory.mjs && node scripts/cocoa-22-waves.mjs --write` (T9 suma 9 ficheros bajo `screens/`:
  234 → 243 pantallas, 101.019 → 104.682 líneas, 176 → 175 puntos; `tests/cocoa-22-contract` regla 15).
- `apps/api/docs/openapi.yaml` (:13774, :13803): sigue listando las dos rutas retiradas (documento estático fuera de T9; solo
  `tests/brand-contract` lo lee, por la marca): retirar ambos bloques al fusionar.
- `docs/manual/60-sistemas.md:436`: `objectStorage` ya no es `unconfigured` en la demo sino `inline`.

## 14 · Post-fusión (orden)

1. Migración (§6): `db:migrate:deploy` + `db:generate`; `db:migrate:status` al día; `db:drift:check` 0 en `main`;
   `db:migrations:check` 287 / 45; `db:install:check`.
2. Reiniciar `:3000` (sirve código anterior) y luego `POST /ai-operations/tools/sync` (catálogo 146 → 147; el registro no se
   sincroniza al arrancar).
3. `corepack pnpm --filter @hotelos/api rbac:sync -- --dry-run` (debe decir +4 claves, 45 roles por completar, 69 gestionados
   «behind v4», 0 revocaciones) y, **solo con autorización** (escribe `permissions` / `role_permissions`), `rbac:sync` sin
   `--dry-run`; `--upgrade-templates` no es necesario (v4 aditiva). Hasta entonces las sesiones reales de `org_123` y Faranda no
   tienen `documents.*` (403 en captura); el fallback demo sin login (`usr_123`) tampoco: decidir si la unión demo gana
   `documents.capture` / `documents.review` para el walkthrough.
4. `node scripts/env-census.mjs --write` (§3.4) el último; `node scripts/build-nav-tree.mjs --csv …` (§11.3);
   `node scripts/cocoa-22-inventory.mjs && node scripts/cocoa-22-waves.mjs --write` (§13).
5. Seed de demo: `corepack pnpm --filter @hotelos/api demo:seed-documents -- --dry-run` y `-- --apply` sobre `org_123` /
   `prop_123` (idempotente por título; `--purge --apply` antes de cambiar el dataset). Invariantes de Faranda idénticas antes y
   después (helper `farandaInvariants` de `tests/integration/helpers/l2-tenant.mts`).
6. Pins fuera de T9 que quedan en rojo hasta que el integrador los toque (declarados por los lotes): `POST …/email/ingest`
   sin `attachments` (§8); `emailApi.ts` con 2 propósitos (§8); `PayablesErrorCode` /
   `DocumentApproveResponse` (§5.4); censo `readVariable` (§3.4); `openapi.yaml` (§13).

## 15 · Puerta final de T9 (T9-15, 2026-09-20, `scratchpad/T9/gates-final.json`) y diff del drift heredado

`NAV_TREE_CSV=/Users/cfernandez/anfitorio-demo/pilots/tanda5-nav-tree.csv bash scripts/gates.sh --json …` (completo, sin
`--quick`, BD `hotelos_t9`, worktree con T9-01…T9-15): **9/14** puertas en verde.

| Puerta | Resultado |
|---|---|
| typecheck:all | 15 PASS · 0 FAIL · 1 SKIP (explícito) · 20,7 s |
| api unit | 3.217 (3.216 pass · 0 fail · 1 skip) |
| admin-web unit | 1.916 (1.910 pass · **5 fail** · 1 skip) — `nav-tree.test.mts` ×3, `backoffice.routes.test.mts` ×1, `nav-item-tabs.test.mts` ×1: todos por la fila CHK `CheckInAutomationSettingsScreen` del CSV compartido (pestaña 104.ª sin pantalla en este árbol; se cierra al fusionar CHK) |
| ai-core · worker | 119/119 · 34/34 |
| contratos raíz | 608 (603 pass · **3 fail** · 2 skip) — `nav-tree-contract` ×2 (misma fila CHK) y `withholding-tax-posting-contract.test.mjs:93` (pinaba la ruta retirada `POST /supplier-bills/drafts`; re-anclado en la puerta de ola 5, §1.6: quedan 604 pass · **2 fail** · 2 skip, ambos de la fila CHK; `scratchpad/T9/gates-ola5.json`) |
| discoverability | 197 URLs · 1 enlace roto (`CheckInAutomationSettingsScreen`, CHK) · placeholders 16/20 |
| nav-tree --check · route-access · cocoa waves | al día (70 · 104 · 205) · OK 15 × 197 · §6 al día |
| rbac:sync --dry-run | OK (+4 claves `documents.*`, 0 escrituras) |
| migrate status + drift | 19/19 al día · `db:drift:check` exit 2 con EXACTAMENTE los 3 ítems heredados de fix1 (diff abajo) |
| admin-web build | OK (2,81 s) |
| integración (`gates.sh`) | **67/67 fail al cargar**: `gates.sh` lanza `node --test tests/integration/*.test.mts` desde la raíz sin `--import tsx` (`ERR_MODULE_NOT_FOUND @hotelos/database` en `helpers/l2-tenant.mts`); defecto del script (`scripts/gates.sh`, fuera de T9): debe ejecutarse como `test:integration` (`cd apps/api && node --import tsx --test --test-concurrency=1 ../../tests/integration/*.test.mts`) |
| integración (loader tsx, `--test-concurrency=1`, 176 s) | **860 (850 pass · 2 fail · 8 skip)** — los 2 fallos son `l3-cancelacion.test.mts` (la guarda UX-1 `PAST_ARRIVAL_DATE` rechaza las reservas con llegada pasada que crea el test: heredado de main); las 7 suites de T9 (`documents-{health,upload,pipeline,workflow,retention}`, `goods-receipts`, `t9-email-documents`) en verde |
| `db:migrations:check` | 19 migraciones → 287 tablas / 45 enums, en sincronía |
| `db:install:check` (`INSTALL_TEST_DB=hotelos_t9_install_test`) | OK: 19 migraciones → 287 tablas, 1 organización, 79 permisos, sin drift, sin objetos fuera de las migraciones (4 s); con `--json` el script termina con `FOREIGN_OBJECTS: unbound variable` (línea 136, tras el OK; fuera de T9) |
| Faranda (`farandaInvariants`) | idénticas al inicio y al final del lote: 25 facturas · 33 envíos VeriFactu · 143.228 asientos · 50 importaciones · 13.457 reservas; `countResidualTenants` = 0; seed de demo purgado (22 documentos, 24 ficheros, 6 recepciones, 8 cotejos, 4 facturas, 3 asientos, 2 usuarios, 3 proveedores) |

Delta de la tanda: manifiesto 948 → 983 → **981**; tablas 277 → **287** (enums 38 → 45); claves 250 → **254**; herramientas
146 → **147**; pantallas +4 / pestañas 100 → 104 (una es de CHK) / ítems 69 → 70.

Diff del drift heredado (`corepack pnpm --filter @hotelos/database db:drift:check` sobre `hotelos_t9`, exit 2):

```
[-] Removed enums
  - VatBookRegime
[*] Changed the `vat_book_entries` table
  [-] Removed index on columns (organization_id, book, regime)
  [-] Removed column `regime`
[*] Changed the `vat_settings` table
  [-] Removed column `opening_compensation`
  [-] Removed column `opening_compensation_period`
```

Los tres proceden de `20260920100000_iva_regimen` y `20260920110000_iva_compensacion_inicial` (carril fix1) aplicadas en la
copia `hotelos_t9`; en `main` con fix1 fusionado el drift es 0 (`db:install:check` lo demuestra sobre una BD limpia).

## 16 · Corrector T9 (revisión final, 2026-09-20) · hunks, autoría y puerta

Cierra los hallazgos confirmados de los tres revisores (funcional/runtime RV-01…RV-19, seguridad SEC-01…SEC-08,
regresiones R2…R9). Todo vive en el worktree `tanda-t9`; se fusiona junto con los lotes T9-01…T9-15 (mismo commit).

### 16.1 Ficheros del corrector (además de los de §1-§14)

| Ámbito | Fichero | Cambio |
|---|---|---|
| Esquema | `packages/database/prisma/schema.prisma` · `prisma/migrations/20260920130000_documentos_split_paginas_retencion/` | `IncomingDocument.sourcePagesJson` (páginas físicas del trozo) y `captureNote`; `DocumentSettings.letterRetentionYears` @default 4 → 6 (aditiva, reversible; `db:migrations:check` 20 → 287 / 45) |
| Pipeline | `modules/documents/pipeline.service.ts` | `parseSourcePages` / `selectSourcePages` (RV-01), `applyReviewedFields` con el número revisado (RV-07), `buildPipelineSearchText` con título y nota (RV-18), envío automático `autoSendToOffice` (RV-06) |
| Split / merge | `modules/documents/split-merge.service.ts` | `splitSourcePages`; origen renumerado o archivado con `mergedIntoId` (RV-03); merge por `pageCount` |
| Servicio | `modules/documents/documents.service.ts` | e-factura XML → `e_invoice` (RV-08), `captureNote`, auditoría sin nota / remitente (SEC-02), bloqueado → 404 en descargas (RV-12), imagen de página (RV-17), 409 sin páginas y aviso a la oficina (RV-10) |
| Avisos | `modules/documents/office-notifications.ts` (nuevo) | destinatarios por clave y ámbito, envío agrupado por hora, aviso diario del SLA |
| Retención | `modules/documents/retention-rules.ts` · `settings.service.ts` · `retention.service.ts` · `actions.service.ts` | cartas 6 años (`personalData` → 4), `retentionKindOf` movido a las reglas, `retentionUntil` en gasto / recepción y barrido de `posted` sin fecha (RV-04), paso SLA (RV-10), asignación solo a revisores (RV-13) |
| Payables | `modules/payables/supplier-bills.service.ts` | `assertLinkedDocumentFieldsAllowed` + tenencia del documento enlazado (SEC-01), `retentionUntil` al contabilizar, anulación con `supplierBillId` null + `rejectNote` (RV-19) |
| Rutas | `documents.routes.ts` · `pipeline.routes.ts` · `workflow.routes.ts` · `server.ts` (`/email/ingest`) | `requireRealSession` en las 9 rutas `authenticated` (RV-02 / SEC-06); `attachments` + `bodyLimit` en la ingesta manual (RV-09) |
| Validación | `modules/documents/validation.ts` | `totals` → `warn` + `needsManual` sin líneas ni total (RV-11) |
| Almacén | `storage/inline-storage.ts` · `storage/s3-storage.ts` · `env.partial.ts` · `lib/env.ts` · `scripts/validate-env.mjs` | caché LRU acotada (SEC-04), `AbortSignal.timeout` + tope de lectura (SEC-07), `DOCUMENT_STORAGE_KIND` obligatoria en producción e `inline` rechazado (SEC-03; ejemplos regenerados con `env:census:write`) |
| Compartido | `packages/shared/src/documents-types.ts` · `payables-types.ts` · `modules/documents/kpis.service.ts` · `goods-receipts.service.ts` | `DOCUMENT_ERROR_CODES` 16 → 20, `SUPPLIER_BILL_MATCH_REQUIRED` en `PayablesErrorCode` (R8), `DocumentKpis.officeSlaBusinessDays` (RV-14), `GoodsReceiptRecord.receivedByName` (RV-16) |
| Front | `screens/documents/{IncomingDocumentsScreen,DocumentReviewPane,GoodsReceiptsScreen}.tsx` · `documents-helpers.ts` · `services/{documentsApi,finance-contracts}.ts` · `docs/design/cocoa-22-inventory.json` (regenerado) | SLA de los KPIs, `users.read` antes de listar revisores (RV-15), nombre de quien recibe, catálogo de mensajes, cabecera al día (R9) |
| Tests | `modules/documents/__tests__/*` (+ `split-merge-pages`, `office-notifications`), `modules/payables/__tests__/supplier-bill-link.test.mts`, `tests/integration/documents-{workflow,upload,pipeline,retention}.test.mts`, `t9-email-documents.test.mts`, `tests/documentos-contract.test.mjs`, `tests/env-contract.test.mjs`, `lib/__tests__/env.test.mts`, `tests/integration/helpers/load-env.mts` (+ `api-integration`, `rbac-scope`), `package.json` (`test:integration` con `--env-file-if-exists`) | un test por corrección; R3: ninguna suite cae ya en la BD principal |
| Docs | `docs/api-contracts.md`, `docs/runbooks/documentos-digitalizacion.md`, `docs/manual/60-sistemas.md`, `CLAUDE.md`, los tres partials del manifiesto, `documents-audit.ts` | textos alineados con el comportamiento (SEC-06, R2, R9) |

### 16.2 Autoría de los 14 ficheros «fuera de lista» (R5)

`components/guide/guideContent.ts` y su test, `navigation/__tests__/{nav-tree,sidebar-menu,view-as}.test.mts`,
`routes/__tests__/backoffice.routes.test.mts`, `screens/users/users-rbac.ts`, `lib/__tests__/rbac-catalog.test.mts`,
`scripts/__tests__/rbac-sync.test.mts`, `developer/{api-reference.service.ts,__tests__/api-reference.test.mts}`,
`tests/rbac-sod-contract.test.mjs`, `tests/withholding-tax-posting-contract.test.mjs`: pins re-anclados por T9-02
(claves 250 → 254, `ROLE_TEMPLATE_VERSION` 3 → 4), T9-10 (ítems 69 → 70), T9-12 (rutas 192 → 196), T9-15
(147 herramientas; retenciones re-ancladas a la ruta canónica de payables) — solo cifras y etiquetas en español, ninguna
aserción retirada. `pnpm-lock.yaml`: según R1 (el orquestador decide). Atribúyanse así en el mensaje de commit.

### 16.3 Puerta del corrector (R6: JSON en `docs/audits/`, no en el scratchpad)

`docs/audits/T9-corrector-gates-quick.json` y `docs/audits/T9-corrector-gates-full.json` (`bash scripts/gates.sh
[--quick] --json`, `NAV_TREE_CSV=/Users/cfernandez/anfitorio-demo/pilots/tanda5-nav-tree.csv`, BD `hotelos_t9`): tres runs
completos; runs 1-2 con integración 865 (857 pass · 0 fail · 8 skip condicionales) con el `.env` del carril y rojos solo
`nav-tree --check` (fila CHK del CSV compartido) y «migrate status + drift» (3 ítems heredados de fix1, §15) — el run 2
además `cocoa waves` (§6 regenerado después con `cocoa-22-waves.mjs --write`); el run 3 (JSON guardado) queda **11/14** por
un flake ajeno a T9 en `l2-persistencia-plataforma.test.mts` L2-04 (856 · 1 fail: «orden descendente» con dos filas de
`offline_sync_records` en el mismo milisegundo; verde al lanzar la suite sola y en los runs 1-2). Sustituyen a
`scratchpad/T9/gates-final.json` y `gates-ola5.json` citados en §15 (efímeros). Los runs 1-2 de la puerta de T9-15 escribieron
tenants de prueba en la BD principal `hotelos` (suites con `DATABASE_URL ??= …/hotelos` sin `--env-file`): comprobado en
solo lectura que no quedan organizaciones `org_l2_%` / `org_rbac%` ni usuarios de prueba; las filas bajo `org_123` que otras
suites pudieran haber creado no se auditaron (R3, incidente a registrar en el informe de la tanda).
