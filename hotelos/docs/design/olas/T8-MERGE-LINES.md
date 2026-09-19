# Tanda T8 · Reputación y reseñas — mergeLines EXACTAS para el orquestador

**Para:** el orquestador/integrador que fusiona el worktree `~/anfitorio-demo-wt-t8/hotelos` (rama `tanda-t8`,
base `776782a`) sobre el árbol principal tras L5. **Qué es:** cada hunk que la Tanda T8 NO pudo escribir porque el
fichero tiene otro dueño (L5, L3-A, L3-B, L3-E, L6a) o vive fuera del repo, con la **línea vigente** en `776782a`
(re-verificada hoy con `sed -n` sobre el worktree; ningún fichero prohibido está modificado en `git status`) y el
**texto exacto** a insertar. Si L5 desplaza las líneas, el ancla es el texto citado (única en el fichero), no el número.
Numeración: «tras :N» = insertar después de la línea N tal como está hoy; «sustituye :N» = reemplazar esa línea.

> **Re-base del integrador (2026-09-19 04:24):** el árbol principal ya está en `ca24ed6` («Merge branch 'tanda-l6a'») con L5
> editando `server.ts` sin commit, así que los números de este documento (base `776782a`) han cambiado: `server.ts` imports
> :106-107, `registerLedgerImportRoutes(app);` :2883, `POST …/respond` :3262-3263, `QualityCaseResolved` :3275, `surveys.read`
> :3286, `/health` `checks.schedulers` :1708-1715, bloque pms-shadow :8713-8728 y cierre de la función :8729; `env.ts` spread
> :762 (import :22, doc :697 sin cambio); `registry.ts` :152 con la firma de 6 argumentos de L6a
> (`…, "medium", true, "read"` → `"high", true, "read"`); `seed.ts` :901/:962/:1060; `docs/api-contracts.md` :464/:466;
> `CLAUDE.md` :115/:288; `schema.prisma` modelos :1878/:1890/:1939 y `UtilityMeter` :1961; migración de T8 →
> `20260919124000_reputacion` (tras `20260919120000_operaciones_l5_backfill_parte_titular`). L6a ya aporta
> `packages/ai-core` (`client/redaction/messages/runner`), `lib/ai-client.ts` `getAiCore()` y `tool-runner.service.ts`, así
> que §13 se aplica ya. La versión canónica y completa de estas mergeLines, ancladas por TEXTO, está en
> `docs/audits/TANDA-8-REPUTACION-2026-09-19.md` §7; ante cualquier discrepancia manda el ancla de texto.

Verificación de anclas sin red (debe imprimir exactamente lo citado en cada sección):

```bash
cd ~/anfitorio-demo-wt-t8/hotelos
sed -n '109p;110p;2873p;8804p;8805p' apps/api/src/server.ts
sed -n '52p;172p' apps/api/src/security/route-permissions.ts
sed -n '22p;696p;752p' apps/api/src/lib/env.ts
sed -n '4,8p' apps/api/src/lib/scheduler-leader.ts
sed -n '42,43p' apps/worker/src/index.ts
sed -n '40,44p;51,56p;228p' apps/worker/src/scheduler.ts
sed -n '380p' apps/api/src/modules/integrations/email/email-reservation.service.ts
sed -n '66,67p;144p;179p' apps/api/src/modules/notifications/event-hooks.service.ts
sed -n '3265p;3276p' apps/api/src/server.ts
sed -n '133p' packages/ai-tools/src/registry.ts
sed -n '895p;993p' packages/database/prisma/seed.ts
```

Orden de aplicación recomendado: §15 (parche de esquema, opcional y último) ← §1-§4 (API: rutas, permisos,
entorno, scheduler) → §3.4 (`env-census --write`, UNA vez, tras L6a y T8) → §6-§9 → §10-§12 (docs/CSV) → §5 solo
si se decide la cola del worker → §13 cuando L6a aterrice. Puerta final: §16.

---

## 1 · `apps/api/src/server.ts` (dueño L5 · 4 hunks; el bloque de schedulers es el único obligatorio para el bot)

### 1.1 Imports (tras :110)

Líneas vigentes:

```
109: import { registerLedgerImportRoutes } from "./modules/accounting/ledger-import.routes.js";
110: import { startPmsShadowJob } from "./modules/pms-shadow/pms-shadow.job.js";
```

Insertar tras :110:

```ts
// Reputación y reseñas (Tanda T8): /reputation/properties/:propertyId/{inbox,sources,runs,imports,
// sources/:id,sources/:id/sync} y /reputation/reviews/:id{,/draft,/quality-case}
// (modules/reputation/reputation.routes.ts; permisos en modules/reputation/route-permissions.partial.ts);
// job diario del líder (modules/reputation/reputation-sync.job.ts) en el bloque de schedulers.
import { registerReputationRoutes } from "./modules/reputation/reputation.routes.js";
import { reputationSyncIntervalMs, startReputationSyncJob } from "./modules/reputation/reputation-sync.job.js";
```

### 1.2 Registro de rutas (tras :2873)

Línea vigente:

```
2873:   registerLedgerImportRoutes(app);
```

Insertar tras :2873 (forma mínima; las 8 rutas del motor genérico `:3246-3277` NO se mueven):

```ts
  // Reputación y reseñas (Tanda T8 · T8-D): bandeja, detalle/PATCH/borrador/caso de
  // una reseña, fuentes, sincronización manual, ejecuciones e importación CSV
  // (/reputation/properties/:propertyId/* y /reputation/reviews/:id/*).
  registerReputationRoutes(app); // Reputación y reseñas (Tanda T8)
```

Variante completa (recomendada en cuanto existan `GOOGLE_BUSINESS_*` en el entorno: sin `collectorOptions` toda
fuente Google nace `unavailable` con `GOOGLE_NO_CLIENT_REASON` aunque el `.env` tenga los ids; `server.ts` ya lee
`process.env` directamente en `:8665` y `:8793`, mismo estilo):

```ts
  registerReputationRoutes(app, {
    collectorOptions: {
      ...(process.env.GOOGLE_BUSINESS_CLIENT_ID ? { googleClientId: process.env.GOOGLE_BUSINESS_CLIENT_ID } : {}),
      ...(process.env.GOOGLE_BUSINESS_CLIENT_SECRET ? { googleClientSecret: process.env.GOOGLE_BUSINESS_CLIENT_SECRET } : {}),
      ...(process.env.GOOGLE_BUSINESS_REDIRECT_URI ? { googleRedirectUri: process.env.GOOGLE_BUSINESS_REDIRECT_URI } : {})
    }
  }); // Reputación y reseñas (Tanda T8)
```

### 1.3 Bloque de scheduler (ENTRE :8804 y :8805)

Líneas vigentes (`:8804` cierra el bloque `if (schedulerLeader && process.env.PMS_SHADOW_JOB_DISABLED !== "true") {`
de `:8789-8804`; `:8805` cierra la función):

```
8804:   }
8805: }
```

Insertar entre :8804 y :8805 (patrón `:8789-8804`: el arranque del módulo conserva `runAtBoot` + log, su
temporizador propio se detiene y lo sustituye uno que exige `holdsSchedulerLease()` en cada vuelta; `unref`;
`SIGTERM`/`SIGINT`). `schedulerLeader` es la constante de `:8592`; `holdsSchedulerLease` ya está importado en `:49`.
Cada vuelta toma además `pg_try_advisory_xact_lock(hashtext('reputation.sync'))` dentro del job
(`reputation-sync.job.ts:70-91`), así que la vuelta de arranque sin lease tampoco duplica reseñas ni casos:

```ts

  // Reputación y reseñas (Tanda T8 · T8-C): job diario del líder — sincroniza las
  // fuentes de reseñas de las propiedades con reputation_quality, analiza (diccionario
  // o IA por ReputationAiPort), abre casos review_negative (score10 < 6) y purga por
  // retención; cada vuelta bajo pg_try_advisory_xact_lock(hashtext('reputation.sync'))
  // (modules/reputation/reputation-sync.job.ts). Vive aquí porque apps/worker no
  // depende de @hotelos/api. Disable with REPUTATION_SYNC_DISABLED=true. Como el modo
  // sombra: el arranque del módulo (runAtBoot + log) conserva la cadencia, pero su
  // temporizador propio se detiene y lo sustituye uno que exige el lease en cada vuelta.
  if (schedulerLeader && process.env.REPUTATION_SYNC_DISABLED !== "true") {
    const reputationIntervalMs = reputationSyncIntervalMs(Number(process.env.REPUTATION_SYNC_INTERVAL_MS ?? 86_400_000));
    const reputationSync = startReputationSyncJob({
      log: app.log,
      intervalMs: reputationIntervalMs,
      runAtBoot: process.env.REPUTATION_SYNC_RUN_AT_BOOT !== "false",
      collectorOptions: {
        ...(process.env.GOOGLE_BUSINESS_CLIENT_ID ? { googleClientId: process.env.GOOGLE_BUSINESS_CLIENT_ID } : {}),
        ...(process.env.GOOGLE_BUSINESS_CLIENT_SECRET ? { googleClientSecret: process.env.GOOGLE_BUSINESS_CLIENT_SECRET } : {}),
        ...(process.env.GOOGLE_BUSINESS_REDIRECT_URI ? { googleRedirectUri: process.env.GOOGLE_BUSINESS_REDIRECT_URI } : {})
      }
    });
    reputationSync.stop();
    const reputationTick = async () => {
      if (!(await holdsSchedulerLease())) return;
      await reputationSync.runNow();
    };
    const reputationTimer = setInterval(() => {
      void reputationTick().catch((error) => app.log.error({ err: error }, "[reputation.sync.job] failed"));
    }, reputationIntervalMs);
    reputationTimer.unref();
    const reputationJob = { stop: () => clearInterval(reputationTimer) };
    process.once("SIGTERM", reputationJob.stop);
    process.once("SIGINT", reputationJob.stop);
  }
```

Notas: `reputationSyncIntervalMs` devuelve 24 h si el valor no es finito o es < 60 000 ms (`reputation-sync.job.ts:52-54`);
`runNow()` devuelve `null` si ya hay una vuelta en curso (anti-solape, `:118-121`). `app.log` (pino) cumple
`ReputationSyncLogger` (`(obj, msg?) => void`): comprobado con `tsc` sobre un fichero de prueba (§16.1).

### 1.5 Tres correcciones en las rutas vivas del motor genérico (`:3252-3277`; T8F-04 y HP-01, ronda de corrección 1)

Líneas vigentes (`sed -n '3252,3254p;3265p;3276p'`):

```
3252:   app.post("/reputation/reviews/:id/respond", async (request) => {
3253:     const propertyId = await assertPropertyEntityAccess(request, { entity: "guestReview", id: (request.params as { id: string }).id });
3254:     return transitionAdvancedRecord({ context: request.userContext, propertyId, moduleCode: "reputation_quality", entityType: "guest_review", entityId: (request.params as { id: string }).id, status: "responded", auditAction: "ReviewResponseSent", requiredPermissions: ["reputation.respond"], payload: request.body as never, correlationId: createId("corr") });
3265:     return transitionAdvancedRecord({ context: request.userContext, propertyId, moduleCode: "reputation_quality", entityType: "quality_case", entityId: (request.params as { id: string }).id, status: "updated", auditAction: "QualityCaseResolved", requiredPermissions: ["quality_cases.manage"], payload: request.body as never, correlationId: createId("corr") });
3276:     return createAdvancedRecord({ context: request.userContext, propertyId, moduleCode: "reputation_quality", entityType: "survey_response", auditAction: "SurveyResponseReceived", requiredPermissions: ["surveys.read"], payload: { ...requireObjectBody(request.body), surveyId: (request.params as { id: string }).id }, correlationId: createId("corr") });
```

(a) **HP-01 · un borrador rechazado en revisión humana no se publica tal cual.** Insertar ENTRE `:3253` y `:3254`
(import junto a §1.1: `import { assertDraftPublishable } from "./modules/reputation/review-draft.service.js";`):

```ts
    // Reputación (Tanda T8): 409 REVIEW_DRAFT_REJECTED si el texto es el borrador cuyo ítem HITL fue rechazado (texto editado → pasa).
    await assertDraftPublishable({ reviewId: (request.params as { id: string }).id, responseBody: (request.body as { responseBody?: string; body?: string } | null)?.responseBody ?? (request.body as { body?: string } | null)?.body });
```

(b) **T8F-04 · «Cambiar estado» del panel de Calidad auditaba `QualityCaseResolved` en toda transición.** En `:3265`
sustituir `auditAction: "QualityCaseResolved"` por:

```ts
auditAction: ["resolved", "closed"].includes(String((request.body as { status?: string } | null)?.status ?? "")) ? "QualityCaseResolved" : "QualityCaseUpdated"
```

(`tests/advanced-modules-contract.test.mjs` no pina `QualityCaseResolved`; `QualityDashboard.tsx` → `QualityCaseDrawer` →
`PATCH /quality/cases/:id` con `{ status: in_progress | resolved | closed }`.)

(c) **T8F-04 · «Registrar respuesta» con solo `surveys.read`.** En `:3276` sustituir `requiredPermissions: ["surveys.read"]`
por `requiredPermissions: ["surveys.manage"]` y en `security/route-permissions.ts` la entrada `POST /surveys/:id/responses`
(hoy `["surveys.read"]`, `:395`) por `["surveys.manage"]`. El front ya solo ofrece «Registrar respuesta» con
`surveys.manage` (`SurveysDashboard.tsx`, corrección T8F-04). Si el propietario prefiere que un auditor registre
respuestas a mano, dejar `surveys.read` y anotarlo en §17.

### 1.4 `/health` (opcional · tras :1705)

Líneas vigentes `:1696-1705` (`checks.schedulers = { ok: true, message: … };` cierra en `:1705` con `    };`).
`SubCheck` (`:1630-1634`) = `{ ok: boolean; latencyMs?: number; message?: string; … }`. Insertar tras :1705:

```ts
    // Reputación (Tanda T8): el job diario corre solo en el líder; REPUTATION_SYNC_DISABLED lo apaga.
    checks.reputationSync = {
      ok: true,
      message: !schedulerLeader
        ? "disabled on this instance (RUN_SCHEDULERS=false)"
        : process.env.REPUTATION_SYNC_DISABLED === "true"
          ? "disabled (REPUTATION_SYNC_DISABLED=true)"
          : `enabled (every ${Math.round(reputationSyncIntervalMs(Number(process.env.REPUTATION_SYNC_INTERVAL_MS ?? 86_400_000)) / 3_600_000)} h · lease + advisory lock)`
    };
```

---

## 2 · `apps/api/src/security/route-permissions.ts` (dueño L5 · 2 líneas)

Líneas vigentes:

```
52:  import { rbacRoutePermissions } from "../modules/rbac/route-permissions.partial.js";
171:    // RBAC por departamento (Tanda 8a · L1): 24 entradas, ver modules/rbac/route-permissions.partial.ts.
172:    ...rbacRoutePermissions,
```

Insertar tras :52:

```ts
import { reputationRoutePermissions } from "../modules/reputation/route-permissions.partial.js";
```

Insertar tras :172:

```ts
  // Reputación y reseñas (Tanda T8): 12 entradas, ver modules/reputation/route-permissions.partial.ts.
  ...reputationRoutePermissions,
```

Sin cambios en `:391` ni `:1218` (las 8 rutas del motor siguen en `server.ts`; `tests/advanced-modules-contract.test.mjs:10,122`
sigue encontrando `/reputation/reviews/:id/respond` en `server.ts`). Tras la fusión `tests/api-route-permissions-contract.test.mjs`
exige igualdad rutas ↔ manifiesto (935 + 12 en el recuento de L2; recontar tras L5) y `apps/api/src/modules/reputation/__tests__/reputation-routes.test.mts`
sigue verde (comprueba que las 8 rutas vivas siguen en `server.ts` y que el partial no las repite).

---

## 3 · `apps/api/src/lib/env.ts` (dueño L6a sección IA; T8 vía partial · 2 líneas + regeneración)

Líneas vigentes:

```
22:  import { PMS_SHADOW_ENV_CONTRACT } from "../modules/pms-shadow/env.partial.js";
752:   ...PMS_SHADOW_ENV_CONTRACT,
```

### 3.1 Insertar tras :22

```ts
import { REPUTATION_ENV_CONTRACT } from "../modules/reputation/env.partial.js";
```

### 3.2 Insertar tras :752

```ts
  // Reputación y reseñas (Tanda T8): job diario del líder (REPUTATION_SYNC_DISABLED,
  // REPUTATION_SYNC_INTERVAL_MS, REPUTATION_SYNC_RUN_AT_BOOT · sección Schedulers) y OAuth
  // de Google Business Profile (GOOGLE_BUSINESS_CLIENT_ID/SECRET/REDIRECT_URI · sección OTA)
  // en modules/reputation/env.partial.ts.
  ...REPUTATION_ENV_CONTRACT,
```

### 3.3 Opcional (sustituye la doc de `RUN_SCHEDULERS`, :696)

Línea vigente `:696` (`sed -n 696p`; `:697` es el cierre `  },` del bloque): `    doc: "Esta instancia ejecuta los schedulers in-process (SES, VeriFactu, pace, cupos, grupos, buzón, modo sombra OPERA). En multi-réplica solo UNA a true o se duplican envíos a AEAT. El worker la ignora (siempre false)."`
→ añadir `, reputación` tras `modo sombra OPERA`.

### 3.4 Regeneración (UNA sola vez, el último en fusionar: T8 y L6a editan la misma sección)

```bash
cd ~/anfitorio-demo/hotelos && node scripts/env-census.mjs --write
git -C ~/anfitorio-demo diff --stat -- hotelos/scripts/env-contract.json hotelos/.env.example hotelos/deploy/.env.production.example
node --test tests/env-contract.test.mjs
```

Sin la regeneración `tests/env-contract.test.mjs:28-42` falla dos veces: (a) `REPUTATION_SYNC_*`/`GOOGLE_BUSINESS_*`
aparecen como «leídas por el código sin documentar» (las lee `server.ts` en §1.2-§1.4: `readBy` cambia) y (b)
`scripts/env-contract.json` deja de coincidir con `ENV_CONTRACT`. Los seis nombres, secciones, formatos y defaults
los pina `apps/api/src/modules/reputation/__tests__/env-partial.test.mts` (ningún fichero de `modules/reputation`
lee `process.env`: el censo no cambia por ellos).

---

## 4 · `apps/api/src/lib/scheduler-leader.ts` (dueño L5 · comentario :4-8)

Líneas vigentes:

```
4:  * The eight in-process schedulers of server.ts (SES Hospedajes, VeriFactu,
5:  * channel drain, revenue pace, allotment release, group cut-off, mailbox poll,
6:  * PMS shadow) MUST run on exactly ONE instance. With more than one replica,
```

Sustituir :4 y :6 por:

```
 * The nine in-process schedulers of server.ts (SES Hospedajes, VeriFactu,
 * channel drain, revenue pace, allotment release, group cut-off, mailbox poll,
 * PMS shadow, reputation sync) MUST run on exactly ONE instance. With more than one replica,
```

(`:5` no cambia.) `apps/worker/src/index.ts:39-43` lista las responsabilidades que quedan en el API (`:42` es
`//   - PMS sombra: sincronización con el PMS de origen (OPERA sombra).` y `:43`, la última de la lista,
`//   - Drain del channel manager: vaciado de la cola de sincronización.`; `:44` es una línea `//` en blanco y `:45-47`
ya pertenecen al párrafo «Retirado aquí en L2-07…», que no debe partirse): añadir tras `:43`, como última línea de la
lista que exige `tests/worker-integration-contract.test.mjs:106`:

```
//   - Reputación: sincronización diaria de reseñas, análisis, alertas y purga (REPUTATION_SYNC_*).
```

(`tests/worker-integration-contract.test.mjs:106` solo exige que sigan las 8 existentes.)

---

## 5 · Worker · cola `reputation.maintenance` (SOLO si la decisión §17 #2 es «sí»; fichero de T8-F ya escrito)

`apps/worker/src/jobs/reputation-maintenance.job.ts` (372 l.) exporta `registerReputationMaintenanceQueue(boss, options)`,
`runReputationMaintenance`, `REPUTATION_MAINTENANCE_QUEUE = "reputation.maintenance"`, `REPUTATION_MAINTENANCE_CRON = "15 4 * * *"`;
su test vive en `jobs/__tests__/` (la lista exacta de `src/__tests__/` que pina `worker-integration-contract:117-121` no cambia).
Hoy el worker sigue con **4 colas** y todos sus contratos en verde; cablear la quinta toca **6 puntos**:

### 5.1 `apps/worker/src/scheduler.ts`

Líneas vigentes:

```
4:   import { runWebhookDeliveries } from "./jobs/webhook-delivery.job.js";
40:  export type JobQueueName =
41:    | "notifications.scheduled"
42:    | "notifications.retry"
43:    | "notifications.sending-sweep"
44:    | "webhooks.deliver";
51:  export const JOB_QUEUES: readonly JobQueueName[] = [
52:    "notifications.scheduled",
53:    "notifications.retry",
54:    "notifications.sending-sweep",
55:    "webhooks.deliver"
56:  ];
228:   );
```

- Tras :4: `import { registerReputationMaintenanceQueue } from "./jobs/reputation-maintenance.job.js";`
- Sustituir :44 por `  | "webhooks.deliver"` y añadir `  | "reputation.maintenance";`
- Sustituir :55 por `  "webhooks.deliver",` y añadir `  "reputation.maintenance"`
- Tras :228 (cierre del `track("schedule:notifications.sending-sweep", …)`, es decir, tras las 4 colas y sus crons):

```ts
  // Reputación (Tanda T8 · T8-F): purga del texto por retención (Google 30 d, resto
  // configJson.retentionDays o 730), plazos de respuesta vencidos y recorte del
  // historial de ejecuciones; un WorkerJobRun por tick vía withJobRun.
  await track("register:reputation.maintenance", registerReputationMaintenanceQueue(boss, {}));
```

**Contratos que fallan con esa forma** (los bucles exigen `boss.work("<cola>"`, `boss.schedule("<cola>", "<cron literal>"` y
`tick("<cola>"` literalmente en `scheduler.ts`): `apps/worker/src/__tests__/catalog.test.ts:52` y
`tests/worker-integration-contract.test.mjs:59`. Insertar como primera línea del cuerpo de ambos bucles:

```ts
      if (queue === "reputation.maintenance") continue; // registrada por jobs/reputation-maintenance.job.ts (probada en jobs/__tests__/reputation-maintenance.job.test.ts)
```

Alternativa sin tocar los bucles (patrón literal de las otras 4 colas; `registerReputationMaintenanceQueue` queda
solo para su test): en vez de la llamada anterior, tras :215 (cierre del `boss.work("webhooks.deliver", …)`):

```ts
  // Reputación (Tanda T8 · T8-F): purga por retención, plazos vencidos y recorte de ejecuciones.
  await boss.work(
    "reputation.maintenance",
    { batchSize: 1 },
    tick("reputation.maintenance", async () => {
      const summary = await runReputationMaintenance();
      console.log(`[reputation.maintenance] properties=${summary.properties} purged=${summary.purged} overdue=${summary.overdue} trimmed=${summary.trimmed}`);
      return summary;
    })
  );
```

y tras :228: `  await track("schedule:reputation.maintenance", boss.schedule("reputation.maintenance", "15 4 * * *", {}, { tz: "Europe/Madrid" }));`
(import: `import { runReputationMaintenance } from "./jobs/reputation-maintenance.job.js";`).

### 5.2 `apps/worker/src/__tests__/catalog.test.ts:39-49`

Sustituir :39 `  it("declara exactamente las cuatro colas pg-boss reales", () => {` por `cinco`; en la lista `:40-45`
insertar `      "reputation.maintenance",` entre `"notifications.sending-sweep",` y `"webhooks.deliver"` (orden alfabético).

### 5.3 `tests/worker-integration-contract.test.mjs`

- `:28` sustituir por `const WORKER_QUEUES = ["notifications.scheduled", "notifications.retry", "notifications.sending-sweep", "webhooks.deliver", "reputation.maintenance"];`
- `:55` sustituir `four` por `five`.
- `:59` (bucle): ver 5.1.

### 5.4 `apps/worker/src/index.ts:28-30`

Sustituir por:

```
// Este proceso ejecuta EXCLUSIVAMENTE las cinco colas pg-boss declaradas en
// scheduler.ts (JOB_QUEUES): notifications.scheduled, notifications.retry,
// notifications.sending-sweep, webhooks.deliver y reputation.maintenance. Cada ejecución escribe un
```

### 5.5 `docs/deployment.md`

- `:18` sustituir `4 colas (\`notifications.scheduled\`, \`notifications.retry\`, \`notifications.sending-sweep\`, \`webhooks.deliver\`)` por
  `5 colas (\`notifications.scheduled\`, \`notifications.retry\`, \`notifications.sending-sweep\`, \`webhooks.deliver\`, \`reputation.maintenance\`)`.
- `:31` sustituir `**cuatro colas pg-boss**` por `**cinco colas pg-boss**`.
- Tras `:40` (fila `webhooks.deliver`) añadir la fila:
  `| \`reputation.maintenance\` | \`15 4 * * *\` | Reputación (Tanda T8): retira el texto de las reseñas que superan la retención de su fuente (Google 30 días; resto \`retentionDays\` o 730), marca fuera de plazo las abiertas con \`slaTargetAt\` vencido y recorta el historial de ejecuciones por fuente a 20. Nunca borra filas. |`
- `:66` sustituir `(4 filas)` por `(5 filas)`.

Si la decisión es «no» (recomendación del recon §6 #2: la purga ya la hace el tick del API en `purgeExpiredBodies`),
no se toca nada de §5 y `reputation-maintenance.job.ts` queda como job disponible pero no cableado (su cabecera lo dice).

---

## 6 · `apps/api/src/modules/integrations/email/email-reservation.service.ts` (dueño L3-A · clasificador)

Líneas vigentes:

```
20:  import { enqueueReview, approveReview, rejectReview } from "../../ai-operations/human-review.service.js";
350: function looksLikeBooking(email: NormalizedEmail): boolean {
380:   if (!looksLikeBooking(email)) {
397:   const review = await enqueueReview({
```

Insertar tras :20:

```ts
// Reputación (Tanda T8): un correo de notificación de reseña no es una reserva
// (modules/reputation/review-email.parser.ts, clasificador puro sin red).
import { classifyInboundEmail } from "../../reputation/review-email.parser.js";
```

Insertar ANTES de :380 (después de `const base = { … };` que cierra en `:378` y de la línea en blanco `:379`):

```ts
  // Reputación (Tanda T8): TripAdvisor, HolidayCheck, Google y los correos de
  // Booking/Expedia cuyo asunto habla de una reseña quedan en `review_notification`
  // (los lee el colector `email` del tick diario: REPUTATION_SYNC_EMAIL_STATUSES) y
  // NO entran en el HITL email_reservation como reserva falsa.
  if (classifyInboundEmail({ messageId: email.messageId, fromAddress: email.from, subject: email.subject, snippet, bodyText: email.bodyText, receivedAt: email.receivedAt ?? null }) === "review_notification") {
    return prisma.inboundEmail.upsert({
      where: { connectionId_messageId: { connectionId: connection.id, messageId: email.messageId } },
      create: { ...base, status: "review_notification" },
      update: { status: "review_notification", snippet, detectedSource }
    });
  }

```

Comportamiento: un correo de `booking.com`/`expedia.com` **sin** asunto de reseña sigue siendo `reservation`
(`review-email.parser.ts:62-100`); el colector `email` solo produce reseñas si la propiedad tiene una fuente en modo
`email` para ese portal (`reputation-sync.service.ts:143-170`). Opcional (fichero de L5): el comentario de
`schema.prisma:1311` (`// received | ignored | review | reservation_created | error`) → añadir `| review_notification`.
Test a añadir en el lote que edite este fichero: un correo de `noreply@booking.com` con asunto «Nueva reseña de un
huésped» → fila `review_notification`, 0 ítems HITL.

---

## 7 · `apps/api/src/modules/notifications/event-hooks.service.ts:48-68` (sin dueño en L3/L5 → puede ir en el commit de T8)

Líneas vigentes:

```
63:      case "GuestPortalSignInRequested":
64:        await handleGuestPortalSignInRequested(event);
65:        return;
66:      default:
67:        return;
```

Insertar antes de :66 (**no-op documentado**, recomendado hasta que exista la plantilla y el responsable por hotel,
decisión §17 #5; hoy el evento ya cae en `default: return`, así que no hay `template_not_found` en los logs):

```ts
    case "ReviewReceived":
      // Reputación (Tanda T8): review-alerts.service.ts emite el evento al abrir un
      // caso review_negative (payload { score10, source, negative, qualityCaseId }).
      // No existe la plantilla `review_negative_received` ni el destinatario por
      // hotel (PropertyModule.configurationJson.reputation.defaultOwnerUserId):
      // hasta que el seed cree la plantilla y el propietario decida el canal, no se
      // despacha nada (el caso de calidad y la auditoría ya avisan en la bandeja).
      return;
```

Variante completa (cuando existan plantilla `review_negative_received` de canal `email` en `notification_templates`
y responsable por hotel): sustituir el `return;` anterior por `await handleReviewReceived(event); return;` y añadir el
handler tras el cierre de `handlePaymentCaptured` (la función ocupa `:144-179`; `:179` es su `}` de cierre, `:154` es
`const recipient = reservation.bookerEmail?.trim();` en su interior — insertar tras `:179`, nunca dentro):

```ts
async function handleReviewReceived(event: EventEnvelope): Promise<void> {
  if (!event.entityId || event.payload?.negative !== true) return;
  const review = await prisma.guestReview.findUnique({ where: { id: event.entityId }, select: { propertyId: true, source: true } });
  if (!review) return;
  const property = await prisma.property.findUnique({ where: { id: review.propertyId }, select: { organizationId: true, name: true } });
  if (!property) return;
  const module = await prisma.module.findFirst({ where: { code: "reputation_quality" }, select: { id: true } });
  const propertyModule = module ? await prisma.propertyModule.findFirst({ where: { propertyId: review.propertyId, moduleId: module.id }, select: { configurationJson: true } }) : null;
  const configuration = propertyModule?.configurationJson as { reputation?: { defaultOwnerUserId?: unknown } } | null;
  const ownerUserId = typeof configuration?.reputation?.defaultOwnerUserId === "string" ? configuration.reputation.defaultOwnerUserId : null;
  if (!ownerUserId) return;
  const owner = await prisma.user.findUnique({ where: { id: ownerUserId }, select: { email: true } });
  const recipient = owner?.email?.trim();
  if (!recipient) return;
  await dispatch({
    organizationId: property.organizationId,
    propertyId: review.propertyId,
    templateCode: "review_negative_received",
    channel: "email",
    recipient,
    notificationId: event.eventId,
    variables: {
      property_name: property.name,
      source: String(event.payload?.source ?? review.source),
      score10: String(event.payload?.score10 ?? ""),
      quality_case_id: String(event.payload?.qualityCaseId ?? ""),
      review_id: event.entityId
    }
  });
}
```

---

## 8 · `packages/database/prisma/seed.ts` (dueño L5-B3/L3 por bloques · 2 hunks)

### 8.1 `:892-896` (ítem HITL `rev_review_004` apunta a `grev_5521`, inexistente)

Líneas vigentes:

```
834:   const minutesAgo = (m: number) => new Date(Date.now() - m * 60 * 1000);
835:   const reviewItems: Array<{
895:       relatedEntityId: "grev_5521",
```

Insertar tras :834:

```ts
  // Tanda T8: rev_review_004 apunta a una reseña FICTICIA real (la peor de las
  // sembradas por `demo:seed-reputation` en prop_123) si ese seed ya corrió; si no,
  // conserva el marcador grev_5521. No se crea ninguna reseña aquí: l2-paginacion
  // .test.mts:653-666 pina prop_123 sin reseñas en 30 días.
  const demoReviewId =
    (await prisma.guestReview.findFirst({ where: { propertyId: "prop_123", source: { endsWith: "_demo" } }, orderBy: { rating: "asc" }, select: { id: true } }))?.id ?? "grev_5521";
```

Sustituir :895 por:

```ts
      relatedEntityId: demoReviewId,
```

### 8.2 `:993` (`summarizeReview` con `moduleCode "reputation"`, código inexistente)

Línea vigente: `      { toolName: "summarizeReview", moduleCode: "reputation", riskLevel: "low" },`
Sustituir por: `      { toolName: "summarizeReview", moduleCode: "reputation_quality", riskLevel: "low" },`

`tests/demo-seed-contract.test.mjs` no pina ninguna de las dos líneas.

---

## 9 · `apps/api/package.json` (compartido con L6a-final · 1 línea)

Línea vigente `:22`: `    "demo:fix-identity": "node --env-file-if-exists=../../.env --import tsx src/scripts/fix-demo-legal-identity.ts",`

Insertar tras :22:

```json
    "demo:seed-reputation": "node --env-file-if-exists=../../.env --import tsx src/scripts/seed-reputation-demo.ts",
```

Uso: `corepack pnpm --filter @hotelos/api demo:seed-reputation -- --dry-run` (ver `docs/runbooks/reputacion-reviews.md` §6).

---

## 10 · `~/anfitorio-demo/pilots/*.csv` (fuera del repo; dueño de `pilots/`)

Sin pantallas nuevas: `pilots/tanda5-nav-tree.csv` (filas 32, 38, 39, 227-229) y `nav-tree.generated.json` **no cambian**
(mismos ítems, pestañas «Reseñas/Encuestas/Calidad», tokens `comercial|direccion|admin|auditoria`, módulo
`reputation_quality`). Solo cambia `api_paths_principales`/`n_api` de `pilots/screens-inventory.csv` (columnas 11-12;
`tests/rbac-nav-contract.test.mjs:393-395` separa las rutas por espacios) para reflejar lo que las pantallas de T8-G
llaman de verdad (`apps/admin-web/src/services/reputationApi.ts:9-29`):

- Fila 32 (`ReputationDashboard`): columna 11 `/dashboards/reputation` → `/dashboards/reputation /reputation/properties/:propertyId/inbox /reputation/reviews/:id /reputation/reviews/:id/draft /reputation/reviews/:id/quality-case /reputation/reviews/:id/respond /reputation/properties/:propertyId/sources /reputation/properties/:propertyId/sources/:id /reputation/properties/:propertyId/sources/:id/sync /reputation/properties/:propertyId/runs /reputation/properties/:propertyId/imports`; columna 12 `1` → `11`.
- Fila 38 (`SurveysDashboard`): `/dashboards/surveys` → `/dashboards/surveys /surveys/properties/:propertyId /surveys/:id/responses`; `1` → `3`.
- Fila 39 (`QualityDashboard`): `/dashboards/quality` → `/dashboards/quality /quality/properties/:propertyId/cases /quality/cases/:id`; `1` → `3`.

Cruce RBAC esperado (`node --test tests/rbac-nav-contract.test.mjs` tras editar): los GET nuevos exigen
`reputation.read` (`inbox`, `reviews/:id`, `sources`, `runs`), `surveys.read`, `quality_cases.read`; los tokens de las
filas del árbol (`comercial` = sales, `direccion` = manager/operations_director/general_manager, `auditoria` = auditor,
`admin` = plataforma) tienen las tres claves de lectura (`permissions.ts:622-637, 952-968, 1191-1207, 1357-1359,
1884-1886, 2114-2116`) → 0 huecos nuevos; los POST/PATCH no cuentan (`:395` solo `GET`). Después: `node scripts/build-nav-tree.mjs --check`.

---

## 11 · `docs/api-contracts.md` (dueño L3-E · sección nueva)

Insertar ANTES de `:455` (`## Tanda L2 · Persistencia y API (2026-09-18)`), como sección de nivel 2. En `:457` el
recuento «**935 entradas**» pasa a `935 + 12` (recontar con `tests/api-route-permissions-contract.test.mjs` tras L5).

```markdown
## Reputación y reseñas (Tanda T8 · 2026-09-19)

Fuente: `docs/design/REPUTACION-REVIEWS.md`; código `apps/api/src/modules/reputation/*` (rutas `reputation.routes.ts`,
manifiesto `route-permissions.partial.ts`, esquemas `schemas/reputation.schemas.ts`); runbook
`docs/runbooks/reputacion-reviews.md`. Requisito: módulo `reputation_quality` activado en la propiedad (403 «El módulo
reputation_quality no está activado en esta propiedad.»); ámbito por `:propertyId` (404 opaco fuera del ámbito) y, en las
rutas de reseña por id, la propiedad de la FILA (`assertPropertyEntityAccess(guestReview)`). Sin claves nuevas:
`reputation.read` lee, `reputation.respond` escribe (reseñas **y** fuentes: no existe `reputation.manage`),
`quality_cases.manage` abre casos. Las 8 rutas del motor genérico (`GET /reputation/properties/:propertyId/reviews`,
`POST /reputation/reviews/:id/respond {responseBody}` (una sola vez; 409 «La reseña ya tiene respuesta.»), casos y
encuestas) siguen en `server.ts` sin cambios; ninguna ruta termina en `/dashboard`.

| Método y ruta | Permiso · riesgo | Cuerpo / consulta | Respuesta |
|---|---|---|---|
| `GET /reputation/properties/:propertyId/inbox` | `reputation.read` · medium | `?status=&source=&minScore=&maxScore=&category=&language=&sentiment=&responded=&overdue=&assignedUserId=&limit=(25, máx. 100)&cursor=&envelope=` | regla de compatibilidad de L2: array `ReviewInboxItem[]` salvo `?envelope=1` o `?cursor=` → `{ items, nextCursor, total }`; siempre cabeceras `X-Total-Count`/`X-Next-Cursor`; `status` es el efectivo (una fila con `respondedAt` se lee `responded`); filtros en memoria sobre las 500 más recientes hasta el parche T8-L0 |
| `GET /reputation/reviews/:id` | `reputation.read` · medium | — | `ReviewDetail` (nota sobre 10, categorías, estado efectivo, borrador + `draftReviewStatus` = estado vivo del ítem HITL `pending\|approved\|rejected\|escalated\|null`, plazo; nunca el texto si está purgado) |
| `PATCH /reputation/reviews/:id` | `reputation.respond` · high | `{ status?, assignedUserId?, slaTargetAt?, responseSource?, responseExternalState?, publish? }` (`.strict`, ≥ 1 clave); máquina `new → assigned → drafted → responded → closed` (+ `ignored` desde new/assigned) evaluada sobre el estado efectivo (una fila ya respondida por POST …/respond se reconcilia a `responded` en el propio PATCH y su ítem HITL pendiente se aprueba) | `ReviewDetail`; 409 `INVALID_TRANSITION`; 409 `REVIEW_NOT_REPLYABLE` si `publish` sin capacidad de respuesta; **nunca** escribe `responseBody` |
| `POST /reputation/reviews/:id/draft` | `reputation.respond` (+ `ai.tool.execute` solo con IA configurada) · high | `{ tone?: cordial\|formal\|breve, language? }` | 201 `ReviewDraftResult` (`requiresHumanReview: true`, ítem HITL `review_response`, `source: ai\|rules`); un solo ítem pendiente por reseña (el anterior se rechaza como «sustituido»); 409 `INVALID_TRANSITION` desde responded/closed/ignored |
| `POST /reputation/reviews/:id/quality-case` | `quality_cases.manage` + `reputation.read` · medium | `{ priority?, ownerUserId?, slaTargetAt?, title? }` | 201 `QualityCase` + `reviewId`; 409 `QUALITY_CASE_ALREADY_LINKED` |
| `GET /reputation/properties/:propertyId/sources` | `reputation.read` · low | `?includeDisabled=1` | `ReviewSourceDto[]` (estado honesto `pending\|connected\|degraded\|error\|disabled\|unavailable`, `lastError`, `runs` ≤ 20; nunca credenciales) |
| `POST /reputation/properties/:propertyId/sources` | `reputation.respond` · high | `{ provider, mode?, displayName?, weight? (0,1-2), retentionDays? (1-3650), externalLocationId?, externalAccountId?, isDemo? }` (`.strict`) | 201 `ReviewSourceDto`; 400 `REVIEW_SOURCE_CREDENTIALS_IN_CONFIG` si el cuerpo trae claves de credenciales |
| `PATCH /reputation/properties/:propertyId/sources/:id` | `reputation.respond` · high | `{ mode?, displayName?, weight?, retentionDays?, externalLocationId?, externalAccountId?, enabled? }` | `ReviewSourceDto` (estado recalculado por el colector) |
| `DELETE /reputation/properties/:propertyId/sources/:id` | `reputation.respond` · high | — | `ReviewSourceDto` con `status: disabled` (baja lógica; nunca borra) |
| `POST /reputation/properties/:propertyId/sources/:id/sync` | `reputation.respond` · high | — | `{ run, summary }` (tick manual de esa fuente bajo el advisory lock por propiedad; `run.status` `completed\|partial\|failed\|skipped`; 409 `REVIEW_SOURCE_DISABLED`; 409 `REPUTATION_SYNC_BUSY` si el tick diario u otra importación tienen el lock) |
| `GET /reputation/properties/:propertyId/runs` | `reputation.read` · low | `?limit=(50)&sourceId=` | `ReviewSourceRunDto[]` (todas las fuentes, las más recientes primero) |
| `POST /reputation/properties/:propertyId/imports` | `reputation.respond` · high | `{ source, scaleMax?, sourceId?, fileName?, contentBase64 \| rows[] }` (XOR; ≤ 4 MiB, ≤ 5.000 filas, 10/min); columnas `external_id, date, rating, scale_max, title, body, language, author, country, url` (alias en `review-csv.parser.ts:30-73`) | 201 `ImportResult { created, updated, duplicates, invalid[], total, sourceId, correlationId }` (bajo el advisory lock por propiedad); 400 `REVIEW_IMPORT_INVALID`; 409 `REPUTATION_SYNC_BUSY` si el tick u otra importación tienen el lock |

Errores tipados (`REPUTATION_ERROR_CODES`): `REVIEW_SOURCE_UNAVAILABLE`, `REVIEW_SOURCE_NOT_AUTHORIZED`,
`REVIEW_NOT_REPLYABLE`, `REVIEW_IMPORT_INVALID`, `REVIEW_IMPORT_DUPLICATE`, `REPUTATION_INSUFFICIENT_DATA`,
`REVIEW_ALREADY_RESPONDED`, `INVALID_TRANSITION`, `REPUTATION_SYNC_BUSY`, `REVIEW_DRAFT_REJECTED`. Auditoría: `ReviewUpdated`, `ReviewResponseDrafted`,
`ReviewSourceCreated/Updated/Disabled/Synced`, `ReviewsImported`, `ReviewReceived`, `QualityCaseCreated`.
Dashboards (contratos aditivos, `analytics.read`): `GET /dashboards/reputation` (+ `status`, `index30/90/365`,
`distribution`, `bySource`, `categories`, `inbox`, `degraded[]`), `GET /dashboards/general-manager` (+ `reputationIndex`;
el bloque `reputation` de L2 no cambia), `GET /dashboards/surveys` (NPS real) y `GET /dashboards/quality`
(`kpis.fromReviews`, `recentCases[].reviewId`). Variables: `REPUTATION_SYNC_DISABLED`, `REPUTATION_SYNC_INTERVAL_MS`
(24 h), `REPUTATION_SYNC_RUN_AT_BOOT`, `GOOGLE_BUSINESS_CLIENT_ID/SECRET/REDIRECT_URI`.
```

---

## 12 · `CLAUDE.md` (dueño integrador)

- `:115-116` líneas vigentes:
  ```
  - Schedulers integrados: SES (5min), pace (daily), allotment release
    (daily), group cutoff (daily), mailbox poll (5min), VeriFactu queue
  ```
  Sustituir por:
  ```
  - Schedulers integrados: SES (5min), pace (daily), allotment release
    (daily), group cutoff (daily), mailbox poll (5min), VeriFactu queue,
    PMS sombra (15min), reputación (24h · `REPUTATION_SYNC_*`, lease + advisory lock)
  ```
- `:258` («manifiesto = rutas registradas: 935»): el recuento vigente + 12 (`api-route-permissions-contract` da la cifra).
- Bloque nuevo «Estado verificado (Tanda T8 · Reputación y reseñas, 2026-09-19 …)» a continuación del último bloque de
  estado (hoy L3, `:31x`), con las cifras de la puerta final de §16 y el resumen de §18; y en «Docs prioritarios» dos líneas:
  ```
  - `docs/audits/TANDA-8-REPUTACION-2026-09-19.md` — cierre de la Tanda T8 · Reputación y reseñas: bot diario honesto por fuente, índice 0-100, bandeja con borrador HITL, encuestas y casos, seed ficticio; mergeLines y decisiones del propietario
  - `docs/runbooks/reputacion-reviews.md` — operación del módulo de reputación: tick, estados de fuente, importación CSV, borrador y respuesta, seed/purga, puertas y degradaciones sin el parche T8-L0 (`docs/design/olas/T8-SCHEMA-PATCH.md`)
  ```
- Si se cablea la cola del worker (§5): «worker 20/20» y «4 colas» donde aparezcan pasan a la cifra nueva.

---

## 13 · IA (dueño L6a) · `packages/ai-tools/src/registry.ts:133` y enganche del puerto

Línea vigente `:133`: `  advancedTool("draftReviewResponse", "reputation_quality", "reputation.respond", "medium", true),`
Sustituir por (L6a-3; el guardrail `tool-registry.service.ts:341-349` solo bloquea `autonomous` en high/critical: con
`medium` un administrador podría dejar el borrador en autónomo):

```ts
  advancedTool("draftReviewResponse", "reputation_quality", "reputation.respond", "high", true),
```

Enganche de ai-core (L6a-final, en el arranque del API o en `lib/llm.ts` shim): fichero NUEVO
`apps/api/src/modules/reputation/reputation-ai.core-adapter.ts` que implemente `ReputationAiPort`
(`reputation-ai.port.ts:80-84`: `describe()`, `analyzeReview(input)`, `draftResponse(input)`) sobre `structured`/`classify`
(análisis: `{ language, sentiment, summary ≤ 200, categories: CategoryMention[] }`, `source: "llm"`, `model`) y `complete`
(borrador ≤ 120 palabras, `source: "ai"`), pasando SIEMPRE por `redactPii` además de `maskReviewForLlm` (el texto ya llega
enmascarado); y una línea en el bootstrap:

```ts
import { setReputationAiPort } from "./modules/reputation/reputation-ai.port.js";
import { createAiCoreReputationPort } from "./modules/reputation/reputation-ai.core-adapter.js";
if (isLlmConfigured()) setReputationAiPort(createAiCoreReputationPort());
```

Sin esa línea todo sigue funcionando con `RulesReputationAi` (etiquetas honestas `dictionary`/`rules`,
`configured: false`, `provider: "none"`); los tests de T8 (`reputation-ai-rules`, `review-draft`, `reputation-sync-*`)
usan `resetReputationAiPort()` y no dependen del enganche. `createReviewDraft` exige además `ai.tool.execute` solo si
`describe().configured` (`review-draft.service.ts:81-82`).

---

## 14 · `apps/api/src/lib/auth-context.ts:78-98` (`PUBLIC_PREFIXES`) — sin cambio hoy

Ninguna de las 12 rutas es pública. Solo si algún día entra el callback OAuth de Google (T8-L5; hoy **no existe** la
ruta `GET /reputation/sources/:id/authorize-url` que menciona `env.partial.ts:63`, ni el callback), insertar tras `:92`
(`  "/integrations/email/oauth/callback",`): `  "/reputation/google/oauth/callback",` con su entrada `riskLevel: "public"`
en el partial y la comprobación de `state` firmado.

---

## 15 · Esquema (dueño L5) → `docs/design/olas/T8-SCHEMA-PATCH.md`

Bloque Prisma (§1), migración `20260919100000_reputacion_reviews` con backfill (§2), puertas (§3) y plan de activación
(§4). Se aplica en el árbol principal **después** de la última migración de L5; el código de T8 funciona igual antes y
después. Corrección a la instrucción original sobre `apps/api/src/scripts/refresh-demo-dataset.ts:206-224`: NO añadir
`reviewCategoryMention`/`reputationDailyScore` a `GUEST_REFERENCE_TABLES` (el bucle `:814-818` consulta `where: { guestId }`
y esas tablas no tienen `guest_id`); su test `:114-115` no cambia.

---

## 16 · Orden de aplicación y puerta final

1. Fusionar los ficheros exclusivos de T8-A…T8-I (todos `??`/` M` en `git -C ~/anfitorio-demo-wt-t8 status`, ninguno prohibido).
2. §1.1, §1.2, §2, §3.1-3.2, §1.3, §4 (API). 3. §6 (correo), §7 (hook), §8 (seed), §9 (script). 4. §10-§12 (CSV y docs).
5. §13 con L6a. 6. §3.4 UNA vez al final (`env-census --write`). 7. §15 (parche) cuando el propietario lo decida (§17 #9).
8. §5 solo con decisión «sí».

Puerta final (desde el árbol principal, BD en reposo; los tests de integración borran organizaciones aisladas):

```bash
cd ~/anfitorio-demo/hotelos
node scripts/typecheck-all.mjs
node --test tests/*.test.mjs
corepack pnpm --filter @hotelos/api test
corepack pnpm --filter @hotelos/worker test
cd apps/api && TSX_TSCONFIG_PATH=../admin-web/tsconfig.json node --import tsx --test $(find ../admin-web/src -path '*/__tests__/*.test.mts') && cd ../..
corepack pnpm --filter @hotelos/admin-web build
cd apps/api && node --env-file-if-exists=../../.env --import tsx --test --test-concurrency=1 ../../tests/integration/l8-reputation-*.test.mts ../../tests/integration/l2-motor-generico.test.mts ../../tests/integration/l2-paginacion.test.mts ../../tests/integration/l2-robustez.test.mts && cd ../..
node scripts/build-nav-tree.mjs --check
```

### 16.1 Comprobación de tipos de los hunks de `server.ts` y `route-permissions.ts` (hecha en el worktree)

Se compiló un fichero temporal `apps/api/src/modules/reputation/__scratch__/t8i-merge-check.ts` con el texto literal de
§1.2 (ambas variantes), §1.3, §1.4, §2 (`ApiRoutePermission[]` con el spread) y §3.2 (`EnvContract` con el spread) contra
`corepack pnpm --filter @hotelos/api typecheck`, y se borró después (no forma parte del worktree). Resultado: **0 errores**
(`tsc --noEmit` limpio con el fichero presente; `apps/api` PASS en `typecheck-all` sin él).

### 16.2 Cifras de la puerta en el worktree (T8-I, 2026-09-19, sin las mergeLines aplicadas)

`typecheck-all` 15 PASS · 0 FAIL · 1 SKIP (guest-web) · contratos raíz `node --test tests/*.test.mjs` 525 tests: 523 pass ·
2 skipped (`nav-tree-contract` «JSON = CSV» y `rbac-nav-contract` «cada plantilla…»: `pilots/*.csv` no existe bajo
`~/anfitorio-demo-wt-t8/`; en el árbol principal sí corren) · 0 fail · unitarios api 2.626: 2.625 pass · 1 skipped · 0 fail ·
worker 32/32 (20 + 12 de T8-F) · front 1.333: 1.332 pass · 1 skipped · 0 fail · `admin-web build` OK · integración
`l8-reputation-{sync,routes,dashboards}` 9 + 13 + 9 = 31/31. Los tres ficheros comparten la BD; desde la ronda de
corrección 1 sus hooks `after` solo comprueban que la organización aislada de CADA suite ha desaparecido (ya no el
recuento global de `org_l2_*`, que las suites hermanas mueven en paralelo), así que `node --test` con los tres ficheros
sin `--test-concurrency=1` también termina con EXIT 0; siguen exigiendo (b) las invariantes de Faranda (recuentos de
facturas, envíos VeriFactu, asientos, lotes Sage y reservas) idénticas, y con otro proceso
escribiendo en Faranda (API de `:3000` del árbol principal, carga Sage, scripts de L5) puede fallar (b) de forma
transitoria (ocurrió una vez a las 02:49; los cuatro muestreos posteriores de los cinco recuentos fueron estables y las
suites pasaron). Sin organizaciones residuales ni filas de reputación en la BD tras las suites.

---

## 17 · Decisiones para el propietario (recon §6, re-basadas al código de T8)

| # | Decisión | Estado en el código de T8 | Qué cambia según la respuesta |
|---|---|---|---|
| 1 | **Activar `reputation_quality` en Faranda** (exige `ai_concierge`: `module-manifest.ts:533`; 0 filas en los 8 centros; activar da 409 `MODULE_DEPENDENCIES_MISSING`) | Todo el módulo responde `module_off` honesto; pantallas «Módulo no activado»; el seed de demo NO activa módulos | Sí → `PATCH /properties/:p/modules/ai_concierge/enable` y luego `reputation_quality` (solo Rías Altas `cmrhw9jy40003fyvbuu2ec2w7` y Los Tilos `cmu1mifcp0000fyo1wzvq7txo` para empezar). Alternativa de producto: retirar `ai_concierge` de `dependencies` (toca `module-conflicts.test.mts:14-32`). |
| 2 | **Sede del mantenimiento**: solo tick del API (recomendado) o también cola `reputation.maintenance` en el worker | Tick del API purga y recorta (`purgeExpiredBodies`, ring buffer 20); el job del worker existe sin cablear | «Sí» → §5 (6 puntos de contrato). «No» → nada. |
| 3 | **Google Business Profile**: cuenta propietaria/gestora de cada perfil, OAuth `business.manage`, proyecto Cloud y solicitud de acceso (perfiles verificados 60+ días) | Colector con cliente HTTP inyectado; sin `GOOGLE_BUSINESS_*` la fuente nace `unavailable` («sin credenciales»); sin autorización `pending` | Aporta `GOOGLE_BUSINESS_CLIENT_ID/SECRET/REDIRECT_URI` (§3) + T8-L5 (callback OAuth, refresco de token, `credentialsJson` cifrado tras el parche). |
| 4 | **Booking.com / Expedia**: nombre del channel manager y si expone Review API (`review-api`) / alta como connectivity provider | Stubs honestos `unavailable` (`BOOKING_UNAVAILABLE_REASON`, `EXPEDIA_UNAVAILABLE_REASON`); mientras tanto CSV manual y correo | Con partner → colector real en T8-L5; sin partner → CSV + correo de notificación. |
| 5 | **TripAdvisor / HolidayCheck**: activar los correos de nueva reseña hacia un buzón dedicado y conectarlo (Gmail/Microsoft OAuth: `GMAIL_*`/`MS_*` hoy ausentes) | Colector `email` lee `InboundEmail` clasificados `review_notification` (§6); sin buzón → `EMAIL_NO_MAILBOX_REASON` | Buzón + §6 → reseñas con extracto (`bodyComplete: false`) y enlace al portal; nunca texto completo. |
| 6 | **Umbrales**: semáforo `8,5 / 6,0` sobre 10 y `85 / 70` sobre 100 (alineado con el director `GeneralManagerScreen`), caso automático por debajo de 6,0 (urgente < 4) | Constantes en `reputation-types.ts:179-187` (`SCORE10_POSITIVE/NEGATIVE`, `INDEX_GOOD/WARN`), bloque compartido con el front | Otro valor (p. ej. 8,0/80 como el GRI) = 1 cambio en el bloque `SHARED` (API y front a la vez). |
| 7 | **Responsables y SLA por hotel**: quién recibe la reseña negativa y en qué plazo (48/72/96 h por sentimiento hoy: `SLA_HOURS`) | `PropertyModule.configurationJson.reputation.defaultOwnerUserId` asigna el caso y la reseña; alerta por notificación = no-op (§7) | Nombres de usuario por hotel + canal (correo/in-app) → plantilla `review_negative_received` en el seed y §7 variante completa. |
| 8 | **Retención y aviso de privacidad**: 30 días Google (obligatorio por sus términos), 730 el resto; texto art. 14 RGPD con el DPO | `RETENTION_DAYS_GOOGLE = 30`, `RETENTION_DAYS_DEFAULT = 730`, editable por fuente (1-3650); la purga vacía título/cuerpo/respuesta y fragmentos, conserva nota y categorías | Otro plazo → `retentionDays` por fuente (PATCH) o defecto en `reputation-types.ts:198-200`. |
| 9 | **Parche de esquema T8-L0** (`T8-SCHEMA-PATCH.md`): aplicarlo tras L5 o seguir sobre JSON | Funciona sin él con degradaciones (runbook §9); `schemaPatchApplied: false` en el snapshot | Sí → §15 + lote T8-L0b (activación en código, `T8-SCHEMA-PATCH.md` §4). |
| 10 | **Encuestas/NPS**: enviar encuesta post-estancia a todos los huéspedes con e-mail; remitente por hotel y `EMAIL_PROVIDER` (hoy sin configurar → `SIMULADO`) | Encuestas y respuestas por las rutas del motor; NPS real en `/dashboards/surveys` y en el director; sin envío automático | Sí → lote de envío (plantilla + `dispatch`) fuera de T8. |
| 11 | **Clave para escribir fuentes**: `reputation.respond` (decisión de T8-D) frente a `integrations.connect` | Alta/cambio/baja/sync/importación de fuentes con `reputation.respond` (la tienen sales, front_office_manager, manager, break_glass) | `integrations.connect` → cambiar 6 entradas del partial (`route-permissions.partial.ts:40-47`) y `docs/api-contracts.md` §11; ningún cambio en `permissions.ts`. |
| 12 | **Ruta del borrador**: `POST /reputation/reviews/:id/draft` (T8-D) en vez de recuperar `…/ai-draft-response` (retirada en L2, `docs/api-contracts.md:466`); y **confirmar que aprobar en HITL nunca publica** | Hecho así; `approveReview` solo cambia el ítem; publicar exige `POST …/respond` iniciado por un usuario | Confirmar. |
| 13 | **IA**: proveedor y clave (`AI_PROVIDER=anthropic`, `AI_PROVIDER_API_KEY`), presupuesto mensual; depende de L6a | Sin clave: diccionario + plantilla con etiqueta honesta («IA no configurada») | Clave + §13 → análisis y borradores por modelo, con `redactPii`. |
| 14 | **Agregadores de pago** (DataForSEO/Outscraper/Apify) | No hay colector `aggregator`; recomendación **no** (ToS de los portales, RGPD) | — |
| 15 | **Tres retoques en las rutas vivas del motor (`server.ts`, §1.5)**: (a) 409 si se publica el texto de un borrador rechazado en revisión humana; (b) `QualityCaseUpdated` salvo cierre en `PATCH /quality/cases/:id`; (c) `POST /surveys/:id/responses` con `surveys.manage` | El API de T8 ya expone `assertDraftPublishable` y `draftReviewStatus`; el cajón bloquea el borrador rechazado y Encuestas solo ofrece «Registrar respuesta» con `surveys.manage` (ronda de corrección 1, HP-01 / T8F-04) | Aplicar §1.5 (a)-(c). Si un auditor debe registrar respuestas a mano, dejar (c) en `surveys.read` y devolver el botón al lector. |

---

## 18 · Resumen para `docs/audits/TANDA-8-REPUTACION-2026-09-19.md` (informe del integrador)

Secciones sugeridas y cifras a rellenar con la puerta final (§16):

1. **Qué se construyó** (por lote, ficheros exclusivos): T8-A tipos wire y bloque `SHARED` (4 ficheros); T8-B bot puro
   (17 fuente + 9 tests, 4.614 l.: normalización a `score10`, idioma, diccionario de 12 categorías, parser CSV, parser de
   correo, enmascarado, 6 colectores honestos, índice IRE, puerto de IA con reglas); T8-C servicios con Prisma
   (10 fuente + 5 tests + 1 integración, 4.118 l.: store sobre JSON, fuentes, bandeja, borrador HITL, alertas, tick,
   job del líder, snapshot del índice, `env.partial.ts`); T8-D rutas (12) + partial + esquemas zod + test estático +
   integración (1.448 l.); T8-E dashboards (5 modificados +281/−176, `reputation-summary.ts` 486 l., 3 tests 894 l.);
   T8-F job de mantenimiento del worker sin cablear (372 + 519 l.); T8-G front Cocoa 22 (8 fuente + 3 tests + 4
   pantallas modificadas, 0 `style={}` nuevos, inventario regenerado); T8-H seed ficticio (`seed-reputation-demo.ts`
   + dataset + test, 1.585 l.); T8-I esta documentación (3 ficheros).
2. **Qué es real y qué no**: ingesta real solo por CSV, filas JSON y correo de notificación (extracto); Google preparado
   sin credenciales (`unavailable`/`pending` honesto); Booking/Expedia `unavailable` por política de los portales;
   análisis por diccionario salvo IA (L6a); borrador por plantilla salvo IA; publicación solo manual (`POST …/respond`);
   índice calculado al vuelo (sin tabla) con `staleDays = 0`; 0 reseñas reales en la BD (solo ficticias del seed).
3. **Rutas y permisos**: 12 nuevas (`route-permissions.partial.ts`) + 8 del motor; 0 claves nuevas; manifiesto +12.
4. **Entorno**: 6 variables (`env.partial.ts`); regeneración única de `env-contract.json`/`.env.example`/`.env.production.example`.
5. **Schedulers**: +1 en el API (24 h, lease + advisory lock, `REPUTATION_SYNC_*`); worker sin cambios salvo decisión §17 #2.
6. **Esquema**: 0 migraciones en T8; parche T8-L0 entregado (`T8-SCHEMA-PATCH.md`: 3 tablas, +14/+27/+5 columnas, 2 uniques, 5 índices, 2 FK, backfill).
7. **Verificación** (rellenar): typecheck-all `__ PASS · __ FAIL · __ SKIP`; contratos raíz `___/___`; unitarios api
   `_____` (pass/skip/fail); worker `__/__`; front `_____/_____` (ficheros); admin-web build OK; integración
   `l8-reputation-{sync,routes,dashboards}` `__/__` + `l2-{motor-generico,paginacion,robustez}` sin regresión; verificación
   por `app.inject`/`:3908` con `comercial.galicia`, `direccion.rias` y la dirección (403 sin módulo, 200 con módulo
   activado en un tenant aislado, 404 opaco entre organizaciones); invariantes de Faranda idénticas antes y después.
8. **mergeLines aplicadas**: §1-§14 de este documento con la línea final donde quedó cada hunk.
9. **Decisiones del propietario**: tabla §17 con la respuesta o «pendiente».
10. **Pendientes**: T8-L5 (OAuth Google real, `credentialsJson`), T8-L0b (activación del parche), envío de encuestas,
    plantilla `review_negative_received`, `ModuleManager.tsx:54-57` «en memoria» (pin `sidebar-nav-contract:298-299`),
    `MoreScreen.tsx:37` en inglés, retirada de los placeholders `/desarrollo/*-ajustes` (CSV filas 227-229).
