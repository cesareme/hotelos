# Tanda L6a · Núcleo de IA (`packages/ai-core`) — informe de cierre (2026-09-18)

**Encargo:** parte «núcleo» de la fila L6 del plan `docs/audits/TANDA-5-PLAN-2026-09-15.md` (§3): `packages/ai-core` (cliente Anthropic sobre `fetch`, tool runner con HITL, salidas estructuradas, caché de prompt, coste real, reintentos, timeouts) sustituyendo `lib/llm.ts`; `AiTool.execute` real sobre los servicios existentes con `canExecuteToolForModules` + `evaluateAiSafety` + `evaluatePolicyGate` + `automationLevel` + confirmación + `recordToolCall` + auditoría `actorType "ai"`; prompts desde `ai_prompt_versions`; redacción de PII antes del proveedor; `aiEnabled` respetado; modelos `claude-sonnet-5` / `claude-haiku-4-5-20251001` / `claude-opus-5` (nunca la familia Fable, por retención); respaldo determinista honesto sin clave; presupuesto mensual por propiedad y rate limit; evaluaciones por herramienta; retirada de `apps/ai-gateway`. Reconocimiento previo: `tandaL6a-recon.md` (scratchpad del orquestador). Diseño resultante: `docs/design/AI-CORE.md`; operación: `docs/runbooks/ai-core.md`.

**Ronda de corrección 1 (2026-09-18, misma fecha; §10):** 27 hallazgos de la revisión (7 seguridad/PII/HITL confirmados, 10 cliente/fallback/coste y workspace confirmados, 10 bajos) corregidos en el worktree, sin tocar ficheros prohibidos; las cifras de §3, §4 y §5.5 y las líneas de §5.1-§5.4 están actualizadas a la corrección.

**Integración final (2026-09-19; §11):** verificación funcional sin clave del integrador por `app.inject` (`tests/integration/l6a-integrador.test.mts`, 21/21, organización aislada con usuarios de las plantillas de T8a y permisos reales de `GET /users/me`) y con una instancia propia del worktree en `:3904` (`RBAC_STRICT=true`, sin auth de demo; 26/26 sondas, incluidas lecturas con los usuarios de demo T8a de Faranda); puertas re-medidas (§3); anclas de §5 re-verificadas línea a línea sobre la rama; BD limpia (§11.4). Ningún fichero prohibido tocado; nada ejecutado en `~/anfitorio-demo/hotelos`; `:3000` sin reiniciar.

**Base y método:** worktree `~/anfitorio-demo-wt-l6a` (rama `tanda-l6a`) sobre HEAD `99dc3c3` (L2 commiteada), **sin commit**; nada ejecutado ni editado en el árbol principal (allí trabaja la Tanda L3 en paralelo); ningún fichero prohibido tocado (`server.ts`, `security/route-permissions.ts` y partials, `packages/database/prisma/**`, `packages/shared/src/{permissions,types}.ts`, nav, `App.tsx`, rutas, `Sidebar.tsx`, `docs/api-contracts.md`, `tests/api-route-permissions-contract.test.mjs`, `CLAUDE.md`, dinero/fiscal): lo que hace falta ahí está en §5 con la línea exacta. Sin dependencias externas nuevas; sin `prisma migrate`; el API de la demo (`:3000`) no se ha reiniciado. La BD local se comparte con L3 y con la carga de Sage 200: las suites de integración usan organizaciones propias (`org_l6a_*`) y no cuentan filas de Faranda como invariante. Sin clave en el `.env` (`AI_PROVIDER_API_KEY=change-me`): todos los tests son sin red (fetch simulado) y el humo con clave está documentado y **no ejecutado** (runbook §4).

## 1 · Lotes

| Lote | Alcance ejecutado | Dónde |
| --- | --- | --- |
| L6a-1 · paquete | `@hotelos/ai-core`: `config` (lista negra `claude-(fable|mythos)`, marcadores de clave, defectos de modelo), `capabilities` (sampling / effort / mínimos de caché / páginas por modelo), `client` (fetch a `/v1/messages`, `count_tokens`, `/v1/models/{id}`; 3 intentos en 429/5xx/red con `retry-after`; timeout por intento), `messages` (`complete`, `structured`, `extractFromDocument`, `extractIdentityDocument`, `extractJsonFromImage`, `classify`, `insight`, `promptFrom`; tool use; `output_config.format`; bloques `image`/`document` con guardas 10 MB / 32 MB / 100-600 páginas; `cache_control` por mínimo de tokens), `pricing` (tabla fechada 2026-06-24, coste USD/EUR), `redaction` (PII reversible por llamada), `rate-limit` (token bucket por organización), `errors`/`labels` en español, `evals/*.json`. 39 ficheros · 5.164 líneas (fuente 2.924, tests 2.041). | `packages/ai-core/**`, `tsconfig.base.json:17-18` |
| L6a-2 · shim y configuración | `lib/llm.ts` → envoltorio de 119 líneas sobre ai-core con los seis nombres históricos más `llmExtractJsonFromDocument`, `llmStructured`, `llmClassify`; `lib/ai-config.ts` (única lectura de `AI_*`), `lib/ai-client.ts` (instancia única + limitador + fuente de prompts), `lib/llm-pricing.ts`; sección IA de `env.ts:710-742` (5 variables nuevas, `AI_MODEL` documentado, `openai` degradado); `env:census:write` regeneró `scripts/env-contract.json`, `.env.example`, `deploy/.env.production.example`. OpenAI retirado del shim (`provider_unsupported`). | `apps/api/src/lib/*`, `env.ts`, ejemplos |
| L6a-3 · tool runner | `@hotelos/ai-core/runner` (puertas 1-8, `WRITE_ALWAYS_CONFIRMS`, `runTool`, `confirmTool`, vocabulario de `status`, alias legados, presupuesto, normalización de `automationLevel`); `modules/ai-operations/tool-runner.service.ts` (ports Prisma, 403/429/404 tipados); 25 implementaciones en `modules/ai-operations/tools/*` (14 lecturas/borradores, 11 escrituras); `packages/ai-tools/src/{registry,safety,tool-names}.ts` (`effect` en toda definición, 46 definiciones nuevas → 146/146, 0 huérfanas; `TOOL_RISK_KEYS` + `evaluateAiSafetyForTool`); 12 claves nuevas en `packages/compliance/src/risk-matrix.ts`; `pipeline.service.ts` (`monthToDateCostEur`, `updateToolCall`, `isSuccess`/`isAwaiting`); `lib/http-error.ts` (`TooManyRequestsError`, `ForbiddenError` con `details`). | `packages/ai-core/src/runner/**`, `apps/api/src/modules/ai-operations/**`, `packages/ai-tools`, `packages/compliance` |
| L6a-4 · llamadores honestos, prompts, evaluaciones, retirada del gateway | `messaging` (`answerGuestQuestion` por el runner, respeta `aiEnabled` de propiedad y conversación, prompt publicado `guest_message_reply` v2), `compliance-assistant`, `reservation-agent`, `property-mapper` por el runner; comandos `ai/scan-id-document.command.ts` y `onboarding/suggest-mapping.command.ts` (listos, sin cablear en `server.ts`); `ai/check-in.command.ts` con `evaluateToolGates`; `assistant.service.ts` (`mode: "llm"` solo si un modelo respondió); `governance.service.ts` (prompts publicados con caché 60 s vía `setAiPromptSource`, evaluaciones sobre `EVAL_SUITES` del paquete, `costDashboard` con `hasRealCost` y `projectedMonthlyEur: null`); `property-ai.service.ts` (checks `provider` y `budget`, guardrails a `BadRequestError`); retirada de `apps/ai-gateway` (8 ficheros), `dual-mode-engine.ts`, `dev:ai`, `observability.ts:9`, tres `COPY` de Dockerfiles, 6 contratos raíz, 5 variables (`RETIRED_KEYS` de `validate-env.mjs`); `packages/ai-tools/src/onboarding/agents.ts`; tests `tests/integration/l6a-*.test.mts` (17) y 9 ficheros unitarios nuevos (60). `apps/api/package.json` + `@hotelos/ai-core` y enlace con `corepack pnpm install --offline` (el lockfile cambia en el worktree). | `apps/api/src/modules/**`, `tests/**`, `deploy/**`, `package.json` |
| L6a-5 · documentación | `docs/design/AI-CORE.md` (367 líneas), `docs/runbooks/ai-core.md` (251), este informe. Sin código. | `docs/**` |
| Integrador (2026-09-19) | `tests/integration/l6a-integrador.test.mts` (21 casos: HTTP como T8a, runner por servicio con permisos reales, cliente con fetch simulado); sonda `:3904`; puertas re-medidas; §5 re-verificado; §11. Sin cambios de código de producto. | `tests/integration/**`, `docs/**` |

## 2 · Estado del árbol (`git -C ~/anfitorio-demo-wt-l6a status`, 2026-09-18)

- 57 ficheros con seguimiento cambiados (+1.796 / −1.333), de los que 10 borrados (`apps/ai-gateway/*` ×8, `modules/onboarding/ai-engine/dual-mode-engine.ts`, `tests/ai-gateway-contract.test.mjs`).
- 67 ficheros nuevos de código y tests (≈ 8.840 líneas): `packages/ai-core` 39 (5.164), API 24 (`lib/{ai-client,ai-config,llm-pricing}.ts`, `lib/__tests__/{ai-config,llm}.test.mts`, `modules/ai-operations/tool-runner.service.ts`, `tools/*` ×9, `__tests__/*` ×5, `modules/ai/scan-id-document.command.ts`, `modules/ai/__tests__/*`, `modules/assistant/__tests__/*`, `modules/onboarding/suggest-mapping.command.ts`), `packages/ai-tools/src/onboarding/agents.ts`, `tests/ai-core-contract.test.mjs`, `tests/integration/l6a-{llamadores-honestos,tool-runner}.test.mts`; más los tres documentos de este lote.
- `pnpm-lock.yaml` modificado (importer `packages/ai-core` añadido, `apps/ai-gateway` retirado, dependencia `@hotelos/ai-core` de `apps/api`): lo decide el orquestador (§6.7); CI instala con `--frozen-lockfile`.
- Ningún `git add/commit/stash/checkout`.

## 3 · Puertas (última medición: integrador, 2026-09-19 00:17-00:18, desde el worktree; idénticas a las del cierre de la corrección 1 salvo la suite nueva de integración)

| Puerta | Comando | Resultado | Referencia anterior |
| --- | --- | --- | --- |
| Typecheck de todos los workspaces | `corepack pnpm typecheck:all` | **16 workspaces · 15 PASS · 0 FAIL · 1 SKIP** (apps/guest-web, explícito) · 20,2 s (2026-09-19). `apps/ai-gateway` fuera, `packages/ai-core` dentro | L2: 15 PASS · 1 SKIP (16 workspaces con el gateway) |
| Contratos raíz | `node --test --test-reporter=tap tests/*.test.mjs` (61 ficheros) | **537 tests · 537 pass · 0 fail · 0 skipped** (2026-09-19, con `pilots/*.csv` copiados a `~/anfitorio-demo-wt-l6a/pilots/`; sin ellos 529 · 527 pass · 2 skipped). Incluye `ai-core-contract` (7), `ai-safety-matrix` (+1), `brand-contract`, `env-contract` | L2: 532/532 (61 ficheros; −3 del `ai-gateway-contract` retirado, +7 nuevos, ajustes en observability/concierge/safety/onboarding) |
| Unitarios API | `corepack pnpm --filter @hotelos/api test` | **2.313 tests · 2.312 pass · 1 skipped · 0 fail** (2026-09-19; +69 sobre L2: 60 nuevos de IA del lote 4 y +4 de la corrección en `llm`, `ai-config` y `tool-runner`; `env.test` +1, `http-error-fastify` +2, `property-ai-readiness` ampliado) | L2: 2.244 (2.243 pass · 1 skipped) |
| Núcleo de IA | `corepack pnpm --filter @hotelos/ai-core test` (= `test:ai-core`) | **119/119 · 0 fail** (2026-09-19; 14 ficheros: núcleo 70, runner 49); sin red | no existía |
| Integración IA | `cd apps/api && node --env-file-if-exists=../../.env --import tsx --test "../../tests/integration/l6a-*.test.mts"` | **41/41 · 0 fail** (2026-09-19; 3 ficheros: `l6a-llamadores-honestos` 8, `l6a-tool-runner` 12, `l6a-integrador` 21; organizaciones `org_l2_l6a*` borradas al terminar; Faranda idéntica antes y después; `ai_tool_calls` globales 46 → 46) | corrección 1: 20/20 (2 ficheros) |
| Worker | `corepack pnpm --filter @hotelos/worker test` | **20/20 · 0 fail** (2026-09-19) | L2: 20/20 |
| Front (admin-web) | `TSX_TSCONFIG_PATH=../admin-web/tsconfig.json node --import tsx --test $(find ../admin-web/src -path "*/__tests__/*.test.mts")` desde `apps/api` | **1.219/1.219 · 0 fail** (puerta 5 del orquestador tras la corrección 1; 0 ficheros de `apps/admin-web` tocados en la tanda) | L2: 1.219/1.219 |
| Instancia propia `:3904` (integrador, §11.2) | `PORT=3904 HOTELOS_ALLOW_DEMO_AUTH=false HOTELOS_DEMO_PERMISSION_UNION=false RBAC_STRICT=true RUN_SCHEDULERS=false node --env-file-if-exists=../../.env --import tsx src/server.ts` desde `apps/api` + sonda HTTP | **26/26 sondas · 0 errores del servidor** (2026-09-19); arranque en 3 s; instancia cerrada al terminar (`lsof :3904` vacío) | — |
| Integración completa (46 ficheros, referencia medida por L6a-4 en el mismo worktree, log `l6a4-integration.log`; hoy son 47 ficheros con `l6a-integrador`) | `corepack pnpm test:integration` | 651 tests · 642 pass · **1 fail** · 8 skipped · 15,7 s. El fallo es `tests/integration/ledger-import-routes.test.mts` (contabilidad, ajeno a la IA): el hook `after` «Faranda y org_123 no cambian» halló `org123Entries` 65 frente a 57 esperados; BD compartida con L3 y con la carga de Sage 200 durante la ejecución. Las 12 suites `l2-*` (incluida `l2-modulos-ia`, que fija las formas sin proveedor y los `status` legados) y las 2 `l6a-*` en verde. No repetida ni en la corrección ni por el integrador para no competir por la BD con L3 (las tres suites `l6a-*` sí, 41/41) | L2: 633 · 626 pass · 0 fail · 7 skips |
| Censo de variables | `corepack pnpm env:census` | **146 leídas · 146 documentadas · ficheros en sincronía** | L2: 135/135 (+5 IA nuevas, +`AI_DOCUMENT_TIMEOUT_MS`/`AI_INFERENCE_GEO`, −5 del gateway, más las de L2/L3) |
| Contrato de marca | `node --test tests/brand-contract.test.mjs` (dentro de los 529; repetido tras escribir los tres documentos, §9) | verde; `packages/ai-core/src/**` es raíz visible; `docs/runbooks/ai-core.md` se escanea (raíz `docs/runbooks/*.md`) y no contiene la marca antigua | — |
| Build admin-web | no ejecutado: ningún fichero de `apps/admin-web` cambia en la tanda | — | — |

## 4 · Lo entregado, en cifras

- **Paquete** `@hotelos/ai-core`: 39 ficheros · 5.712 líneas tras la corrección 1 (fuente 3.256, tests 2.456); `package.json` con `typecheck` y `test` y sin dependencias externas (`zod` retirado: no tenía import); alias `@hotelos/ai-core` y `@hotelos/ai-core/runner`; 0 lecturas de `process.env`, 0 importaciones de `@hotelos/database` (contrato raíz).
- **Cliente**: 3 intentos en 429 / cualquier 5xx / fallo de red, `retry-after` respetado, tope 30 s, sin reintento en 400-404/413 ni en timeout; timeouts 20 s (texto) / 120 s (documentos).
- **Modelos**: `claude-sonnet-5` / `claude-haiku-4-5-20251001` / `claude-opus-5`; lista negra `/^claude-(fable|mythos)/i` que desactiva la IA con aviso; ningún fichero fuente contiene el identificador vetado (`tests/ai-core-contract.test.mjs:58-69`).
- **Registro**: 146 definiciones (71 `read` / 75 `write`; low 51 · medium 54 · high 37 · critical 4), 146 nombres, 0 huérfanas (antes 100 / 141 / 41). 20 nombres mapeados a claves de la matriz de riesgo; 12 claves nuevas.
- **Herramientas con `execute` real**: 25 (14 lecturas/borradores: `findReservation`, `matchGuestToReservation`, `validateRoomAssignment`, `quoteAvailability`, `checkGuestRegisterCompleteness`, `validateSpainGuestRegister`, `getHousekeepingBoard`, `classifyOnboardingFile`, `analyzeReviewSentiment`, `classifyIncomingDocument`, `extractIncomingDocumentFields`, `extractGuestIdentityFieldsTemporary`, `draftReviewResponse`, `answerGuestQuestion`; 11 escrituras siempre `awaiting_confirmation`: `assignRoom`, `checkInReservation`, `createWorkOrder`, `blockRoomForMaintenance`, `resolveWorkOrder`, `createHousekeepingTask`, `markRoomClean`, `markRoomInspected`, `prepareGuestRegisterRecord`, `queueSesHospedajesSubmission`, `sendGuestMessage`). Dinero/fiscal (folio, pagos, facturas, contabilidad, capex, tarifas) sin `execute` → `tool_not_implemented` (503).
- **Llamadores por el runner** (grep `runAiTool`): messaging, compliance-assistant (×2), reservation-agent, property-mapper, scan-id-document.command, suggest-mapping.command; check-in.command con `evaluateToolGates`. 100 % de las escrituras con confirmación; `ai_tool_calls` persistidas con coste (0 sin llamada al modelo; calculado con la tabla y `AI_USD_EUR_RATE` cuando hay `usage`; NULL si hubo llamada sin tipo de cambio); `actorType "ai"` en `AI_TOOL_EXECUTED | AI_TOOL_CONFIRMATION_REQUESTED | AI_TOOL_DENIED | AI_TOOL_FAILED`; presupuesto (403 `AI_BUDGET_EXCEEDED`) y rate limit (429 `AI_RATE_LIMITED`) probados por integración; PII redactada (`[NOMBRE_1]`, `[TEL_1]`) probada con nombres inventados.
- **Sin clave**: asistente `mode: "deterministic"`, `scan_id_document` `skipped`, borradores por reglas, evaluaciones `skipped`, readiness `provider` en `warn`, coste `hasRealCost:false` / `projectedMonthlyEur:null`.
- **Gateway**: retirado (383 líneas fuente, 8 ficheros, 6 contratos, 3 Dockerfiles, `dev:ai`, `observability.ts`, 5 variables).
- **Tests nuevos**: 119 (ai-core) + 64 (unitarios API) + 41 (integración: 20 de los lotes + 21 del integrador) + 8 (contratos raíz: 7 `ai-core-contract` + 1 `ai-safety-matrix`) = **232** (211 tras la corrección 1; 187 en el cierre del lote 5).

## 5 · Líneas exactas para el orquestador (ficheros prohibidos en la tanda)

Todas las referencias son a la rama `tanda-l6a` (HEAD `99dc3c3`); si L3 desplaza líneas, buscar por el texto citado. **Re-verificadas por el integrador el 2026-09-19 sobre el worktree** (`grep -n` / `sed -n`): `server.ts` 60-62 (tres imports que quedan huérfanos), 360 (`import { createCheckInFromScanConfirmation, executeConfirmation }`), 1633 (`const checks: Record<string, SubCheck> = {};`), 1679-1682 (`checks.sesHospedajes = { … };`), 5782 y 5787 (rutas del Centro de cumplimiento), 6544-6586 (handler `scan-id-document`, cierre `});` en 6586), 6592-6672 (handler `suggest-mapping`, cierre en 6672), 8401-8422 (bloque `app.get("/ai/tool-calls", …)`, cierre `});` en 8422: la ruta nueva va **después de la 8422**); `createId` (l.39), `BadRequestError` (l.50) y `assertEntityAccess` (l.53) ya están importados en `server.ts`; `route-permissions.ts` 964 (`GET /ai/tool-calls`); `docs/api-contracts.md` 365 (viñeta `GET /ai/tool-calls`); `CLAUDE.md` 255 («Estado verificado (Tanda L2 …»), 267-268 (cifras L2, no se tocan); `.github/workflows/ci.yml` 73-74 (`API unit tests` / `run: pnpm test:unit`); `apps/api/package.json` 38 (`"@hotelos/ai-core": "workspace:*"`, ya en el worktree). `packages/shared/src/permissions.ts`: **sin cambios** (la ruta reutiliza `ai.tool.execute` y `ai.high_risk.confirm`). Si al fusionar `server.ts` no está en 99dc3c3 (L3), los números cambian pero los textos citados no.

### 5.1 `apps/api/src/server.ts`

1. Imports (junto a la línea 360, `import { createCheckInFromScanConfirmation, executeConfirmation } from "./modules/ai/check-in.command.js";`):

```ts
import { describeAiHealthCheck } from "./lib/ai-config.js";
import { confirmToolCall } from "./modules/ai-operations/tool-runner.service.js";
import { scanIdDocumentCommand } from "./modules/ai/scan-id-document.command.js";
import { suggestMappingCommand } from "./modules/onboarding/suggest-mapping.command.js";
```

2. `/health` (tras `checks.sesHospedajes = { … };`, líneas 1679-1682; `checks` es `Record<string, SubCheck>`, línea 1633):

```ts
    // Tanda L6a: proveedor de IA, modelos, presupuesto por defecto y rate limit (nunca la clave).
    checks.ai = describeAiHealthCheck();
```

3. Handler `POST /ai/commands/scan-id-document` (sustituir el cuerpo completo de las líneas 6544-6586 por):

```ts
  app.post("/ai/commands/scan-id-document", async (request) => {
    const body = (request.body ?? {}) as { imageDataUrl?: string };
    if (!body.imageDataUrl) throw new BadRequestError("imageDataUrl is required.");
    return scanIdDocumentCommand({ context: request.userContext, imageDataUrl: body.imageDataUrl, correlationId: createId("corr") });
  });
```

   Con ello `llmExtractDocument` y `recordToolCall` dejan de usarse en `server.ts`. Corrección 1 (WT-01): tras sustituir los dos cuerpos (puntos 3 y 4) quedan **tres imports huérfanos** que hay que borrar, porque `tsconfig.base.json` no activa `noUnusedLocals`: la línea 60 (`import { isLlmConfigured, llmComplete, llmExtractDocument } from "./lib/llm.js";` — usos solo en 6549/6552, 6606 y 6618), la línea 61 (`import { recordToolCall } from "./modules/ai-operations/pipeline.service.js";` — usos solo en 6557 y 6649: `recordToolCall` NO se usa en ningún otro punto de `server.ts`) y la línea 62 (`import { MAPPING_CATALOGS } from "@hotelos/ai-tools";` — usos solo en 6598-6600). Formas de respuesta y fila `scan_id_document` (`completed | skipped | failed`) idénticas: `tests/integration/l2-modulos-ia.test.mts:140-148` y `l6a-llamadores-honestos.test.mts:105` siguen verdes. Hasta la fusión, con clave, los dos handlers antiguos ya **no** llaman al proveedor: `lib/llm.ts` responde `context_required` a las llamadas sin organización (corrección 1 · CFC-06/SEC-01) y la ruta devuelve `configured:false, source:"manual"` con fila `skipped`.

4. Handler `POST /onboarding/ai/suggest-mapping` (sustituir el cuerpo completo de las líneas 6592-6672 por):

```ts
  app.post("/onboarding/ai/suggest-mapping", async (request) => {
    const body = (request.body ?? {}) as { sourceValue?: string; targetType?: string };
    if (!body.sourceValue || !body.targetType) throw new BadRequestError("sourceValue and targetType are required.");
    return suggestMappingCommand({ context: request.userContext, sourceValue: body.sourceValue, targetType: body.targetType, correlationId: createId("corr") });
  });
```

   (`llmComplete`, `isLlmConfigured` y `MAPPING_CATALOGS` dejan de usarse en ese bloque.) Mientras las tres `suggest*Mapping` del registro se traten como escritura (§5.8), el comando responde `suggestion: null` con aviso de pendiente.

5. Rutas del Centro de cumplimiento (corrección 1 · CFC-04; sin este cambio, con clave, ambas responden siempre por reglas de forma silenciosa). Línea 5782, sustituir `return getComplianceAssistant((request.params as { propertyId: string }).propertyId);` por:

```ts
    return getComplianceAssistant((request.params as { propertyId: string }).propertyId, { context: request.userContext, correlationId: createId("corr") });
```

   y línea 5787, sustituir `return extractComplianceDocumentDates(body.imageDataUrl);` por:

```ts
    return extractComplianceDocumentDates(body.imageDataUrl, { context: request.userContext, correlationId: createId("corr") });
```

6. Ruta de confirmación (después del bloque `app.get("/ai/tool-calls", …)` de las líneas 8401-8422, es decir, tras el `});` de la 8422; el resolver de tenancy `aiToolCallConfirmation` ya existe, §5.3; `assertEntityAccess`, `BadRequestError` y `createId` ya están importados):

```ts
  // Tanda L6a: decisión humana sobre una llamada de herramienta awaiting_confirmation (tool runner).
  app.post("/ai/tool-calls/:id/confirm", async (request) => {
    const { id } = request.params as { id: string };
    await assertEntityAccess(request, { entity: "aiToolCallConfirmation", id });
    const body = (request.body ?? {}) as { decision?: "approve" | "reject"; notes?: string };
    if (body.decision !== "approve" && body.decision !== "reject") throw new BadRequestError("decision debe ser approve | reject.");
    return confirmToolCall({ context: request.userContext, toolCallId: id, decision: body.decision, ...(body.notes !== undefined ? { notes: body.notes } : {}), correlationId: createId("corr") });
  });
```

### 5.2 `apps/api/src/security/route-permissions.ts`

Después de la línea 964 (`{ method: "GET", path: "/ai/tool-calls", permissions: ["audit.read"], riskLevel: "high" },`):

```ts
  { method: "POST", path: "/ai/tool-calls/:id/confirm", permissions: ["ai.tool.execute"], riskLevel: "high" },
```

Motivo de `ai.tool.execute` + `high` y no `critical` + `ai.high_risk.confirm`: el runner ya exige `ai.high_risk.confirm` para las herramientas high/critical y para cualquier `requiresApprovalRole` (`packages/ai-core/src/runner/runner.ts:67, 554`; corrección 1 · SEC-04) y los permisos propios de cada herramienta; así recepción puede confirmar `createWorkOrder` (low) sin la clave de alto riesgo, como prueba `l6a-tool-runner.test.mts:139`. Alternativa más restrictiva (decisión §6.11): `permissions: ["ai.tool.execute", "ai.high_risk.confirm"], riskLevel: "critical"`. `tests/api-route-permissions-contract.test.mjs` exige la entrada en cuanto exista la ruta.

### 5.3 `apps/api/src/lib/tenancy.ts` — HECHO en la corrección 1 (WT-08; nada que aplicar)

`tenancy.ts` no es un fichero prohibido, así que el resolver se implementó en la tanda: `aiToolCallConfirmation` (`lib/tenancy.ts:877-891`, después del bloque `pendingConfirmation`), distinto del `aiToolCall` que ya existía (`tenancy.ts:755`, por organización y cualquier estado, para `GET /ai/tool-calls/:id`). Solo resuelve filas `awaiting_confirmation` sin `confirmed_by`; decididas, caducadas, reclamadas o ajenas → el mismo 404 opaco («Llamada de herramienta no encontrada.»). `TenantEntity` es `keyof typeof RESOLVERS`, así que la unión se amplía sola. Cubierto por `tests/integration/l6a-tool-runner.test.mts` («assertEntityAccess(aiToolCallConfirmation) solo resuelve filas pendientes sin reclamar»).

### 5.4 `docs/api-contracts.md`

Después de la línea 365 (viñeta `GET /ai/tool-calls …`; corrección 1 · WT-06: antes decía 366, que es la línea en blanco siguiente):

```markdown
- `POST /ai/tool-calls/:id/confirm` (`ai.tool.execute`, Tanda L6a): decisión humana sobre una fila `awaiting_confirmation` del tool runner. Cuerpo `{ decision: "approve" | "reject", notes? }`. `approve` re-evalúa `aiEnabled`, el ajuste por herramienta y el presupuesto (403 `AI_DISABLED_FOR_PROPERTY` / `AI_BUDGET_EXCEEDED`), reclama la fila de forma atómica (dos aprobaciones concurrentes ejecutan una sola vez), ejecuta la herramienta con la entrada validada de la fila y responde `{ status: "succeeded", toolCallId, output, configured }` o `{ status: "failed", toolCallId, reason, message }`; `reject` responde `{ status: "rejected", toolCallId }`. Las herramientas high|critical y las que exigen un rol de aprobación requieren además `ai.high_risk.confirm` (403 `AI_TOOL_CONFIRM_FORBIDDEN`). Una fila pendiente de más de 24 h responde 409 `AI_CONFIRMATION_EXPIRED` y pasa a `rejected`. 404 «Llamada de herramienta no encontrada.» con id inexistente, de otra organización, de otra propiedad, ya reclamado o que no espera confirmación. Al cerrar la fila, `input_json` y la propuesta se persisten redactados (sin PII). Toda escritura de las 25 herramientas con `execute` queda en `awaiting_confirmation`; las lecturas y borradores se ejecutan al instante. Presupuesto mensual agotado → 403 `AI_BUDGET_EXCEEDED` (`propertyId`, `budgetEur`, `spentEur`); límite por organización → 429 `AI_RATE_LIMITED` (`details.retryAfterSeconds`). `ai_tool_calls.status` ∈ `succeeded | failed | pending | awaiting_confirmation | rejected | completed | skipped`; `cost_eur` es 0 solo cuando no hubo llamada al modelo y NULL cuando la hubo sin `usage` o sin `AI_USD_EUR_RATE`. `GET /health` expone `checks.ai` (proveedor, modelos, presupuesto por defecto, rate limit; nunca la clave).
```

### 5.5 `CLAUDE.md`

Nuevo bloque «Estado verificado (Tanda L6a · Núcleo de IA, 2026-09-18; rama `tanda-l6a` sin commit; `:3000` sin reiniciar; informe `docs/audits/TANDA-L6A-AI-CORE-2026-09-18.md`)» delante del bloque de L2 (línea 255):

```markdown
- `packages/ai-core` nuevo (39 ficheros · 5.712 líneas; alias `@hotelos/ai-core` y `@hotelos/ai-core/runner`);
  `apps/ai-gateway` retirado (16 workspaces: uno sale, otro entra); `lib/llm.ts` = shim de 147 líneas;
  registro 146 definiciones / 146 nombres / 0 huérfanas; 25 herramientas con `execute` real
  (14 lecturas/borradores · 11 escrituras siempre `awaiting_confirmation`); modelos
  claude-sonnet-5 / claude-haiku-4-5-20251001 / claude-opus-5, familia Fable/Mythos vetada;
  ronda de corrección 1 (27 hallazgos: confirmación atómica por propiedad con caducidad y
  re-evaluación de puertas, PII redactada en ai_tool_calls, thinking/effort por modelo,
  budget_unavailable sin tipo de cambio, evaluaciones con puertas y filas, llm.ts sin cubo
  «unscoped»; informe §10)
- typecheck-all: 15 PASS · 0 FAIL · 1 SKIP explícito (apps/guest-web) · 22,3 s
- unitarios api 2.313 (2.312 pass · 1 skipped · 0 fail) · ai-core 119/119 (`corepack pnpm test:ai-core`)
  · contratos raíz 537/537 (medidos con `pilots/*.csv` presentes; sin ellos 529 con 2 skipped)
  · worker 20/20 · front 1.219/1.219 · integración `l6a-*` 41/41 (3 ficheros; el integrador
  añadió `l6a-integrador.test.mts`, 21 casos) · integración completa (referencia L6a-4, no
  repetida después) 651 tests · 642 pass · 1 fail ajeno (`ledger-import-routes`, BD compartida
  con la carga Sage) · 8 skips · censo env 146/146 · validate-env OK
- integrador (2026-09-19): sin clave, por app.inject y con instancia propia `:3904`
  (RBAC_STRICT, sin auth de demo; 26/26 sondas, usuarios T8a de Faranda solo en lectura):
  asistente `deterministic`, copiloto por reglas, scan `skipped`, check-in pending→completed
  y `rejected` «IA desactivada en esta propiedad» con aiEnabled=false, evaluación `skipped`,
  readiness provider `warn`, coste sin coste real; runner: lectura succeeded cost_eur 0 actor
  ai, escritura awaiting → confirm; aprobar en Pendientes IA NO ejecuta (solo confirmToolCall);
  403 AI_BUDGET_EXCEEDED · 429 AI_RATE_LIMITED · PII `[NOMBRE_1]/[DOC_1]/[TEL_1]/[EMAIL_1]/
  [TARJETA_1]` · system prompt leído de ai_prompt_versions v2; BD limpia (46 ai_tool_calls)
- humo con clave documentado y NO ejecutado (`docs/runbooks/ai-core.md` §4)
```

Además, en la línea 161 («contratos 281/281 · unitarios api 504/504 · integración 31/31 · env 135/135», bloque histórico) no se cambia nada; la referencia viva pasa a ser este bloque. `§Deuda técnica`: añadir «`AiIntent`/`AiIntentName` en `packages/shared/src/types.ts:23-37, 354-363` sin consumidor desde la retirada del gateway (Tanda L6a)».

### 5.6 `.github/workflows/ci.yml` (raíz git)

Después del paso `API unit tests` (líneas 73-74, `run: pnpm test:unit`) del job `contract-tests`:

```yaml
      - name: AI core unit tests (packages/ai-core, Node strip-types, sin red)
        run: pnpm test:ai-core
```

(Node 22 en CI: `--experimental-strip-types` e `import … with { type: "json" }` disponibles; el paso no necesita BD.)

### 5.7 `packages/shared/src/types.ts`

`AiIntentName` (líneas 23-37) y `AiIntent` (354-363) quedan sin consumidor fuera del propio fichero tras retirar `apps/ai-gateway` (grep en `apps/` y `packages/`: solo `types.ts`). Decisión: retirar ambos tipos o conservarlos para el asistente unificado de L6b (que definirá su propio contrato de intención). No se borra nada en la tanda.

### 5.8 Fuera de la lista prohibida pero pendiente (decisión del orquestador)

- `packages/ai-tools/src/registry.ts:184-187`: las tres `suggest*Mapping` (`suggestRoomTypeMapping`, `suggestRatePlanMapping`, `suggestChannelMapping`) llevan `requiresConfirmation` sin `effect` explícito y la heurística las trata como escritura (`awaiting_confirmation`); para que `suggest-mapping.command.ts` devuelva la sugerencia hay que añadir el sexto argumento `"read"` a esas tres llamadas a `advancedTool(…)` (también a `suggestRoomMapping`, línea 185, si se quiere coherencia). Cambio de una palabra por línea; `tools-coverage.test.mts` no lo pina.
- `pnpm-lock.yaml`: aceptar la regeneración (`corepack pnpm install --offline` ya la produjo en el worktree).
- `.env` local: retirar `OCR_PROVIDER_API_KEY` y `SPEECH_PROVIDER_API_KEY` (marcadores; `RETIRED_KEYS`).

## 6 · Decisiones para el propietario (detalle en `docs/design/AI-CORE.md` §17)

1. **Clave y DPA**: cuenta, Data Processing Addendum, límite de gasto en la consola, custodia de la clave (`deploy/.env.production.example:447-482`). Sin esto el humo de `docs/runbooks/ai-core.md` §4 no se ejecuta.
2. **Retención cero (ZDR)**: solicitarla antes de procesar documentos de identidad o PDF reales (los bytes viajan íntegros; la familia Fable se vetó precisamente por retención de 30 días).
3. **Bedrock UE vs API directa e `inference_geo`**: el cliente solo habla con la API directa; `AI_INFERENCE_GEO` se envía como `inference_geo` (no admitido en Haiku 4.5). Bedrock exigiría otro cliente/SDK (fuera de L6a).
4. **Presupuesto por hotel**: 25 € por defecto para las 8 propiedades vía `configurationJson.monthlyBudgetEur`; importes reales por centro y si hace falta tabla propia cuando L3 libere `schema.prisma`.
5. **Autonomía de escrituras**: `WRITE_ALWAYS_CONFIRMS = true`; ninguna escritura sin persona aunque el nivel sea `autonomous`. Si alguna de bajo riesgo debe serlo, es cambio de L6b.
6. **SDK oficial** (`@anthropic-ai/sdk`) frente al cliente `fetch` sin dependencias.
7. **Lockfile**: regeneración obligada por el importer nuevo y el retirado.
8. **OpenAI**: retirado del shim; el valor sigue en el enum de `env.ts:713` por compatibilidad.
9. **Identificadores de modelo**: alias fechado de Haiku frente a `claude-haiku-4-5`; confirmar en el humo (§4.1 del runbook).
10. **Tipo de cambio `AI_USD_EUR_RATE`**: fuente y periodicidad.
11. **Permisos de la ruta de confirmación** (§5.2).
12. **Vocabulario de `status`**: unión de 7 valores hasta que L3 libere el schema.
13. **Matriz de riesgo frente al registro para `createWorkOrder`** (verificado por el integrador, §11.1): `packages/compliance/src/risk-matrix.ts:17` (`create_maintenance_task` exige `maintenance.workorder.manage`) frente a `packages/ai-tools/src/registry.ts:225` (`createWorkOrder` exige `maintenance.workorder.create`). Con sus permisos reales, una recepcionista (plantilla T8a: `create` sin `manage`) queda **denegada al proponer** (`denied`, `reason: "safety"`, «Missing permissions: maintenance.workorder.manage.») aunque **sí puede confirmar** la propuesta de mantenimiento o dirección. Decisión: alinear `risk-matrix.ts:17` a `["maintenance.workorder.create", "ai.tool.execute"]` (una línea, fichero no prohibido) o mantener la asimetría a propósito.
14. **Las tres `suggest*Mapping` como lectura** (`registry.ts:184-187`, §5.8): mientras no lleven `effect: "read"`, `POST /onboarding/ai/suggest-mapping` responderá `suggestion: null` con aviso de pendiente incluso con clave.
15. **Módulo `ai_front_desk` en el check-in por escaneo**: `check-in.command.ts:52` `CHECK_IN_REQUIRES_FRONT_DESK_MODULE = false` (la puerta de módulo se sustituye por la de permisos porque la ruta no está condicionada al módulo y no es de los activados por defecto). Para exigirlo: la constante a `true` y activar el módulo en las propiedades (y en `tests/integration/l2-persistencia-plataforma.test.mts:217`).
16. **Aprobar en «Pendientes IA» no ejecuta** (verificado, §11.1): la cola de revisión humana cierra la revisión; la herramienta solo se ejecuta con `confirmToolCall` (servicio) o, tras la fusión, con `POST /ai/tool-calls/:id/confirm`. Hasta entonces las escrituras `high|critical` propuestas por la IA no pueden ejecutarse desde el front. Decidir si la pantalla de Pendientes IA (L6b) llama a la ruta de confirmación al aprobar un ítem `ai_tool_call`.

## 7 · Deuda anotada

**Prisma (`packages/database/prisma/**`, fichero de L3)**: `AiToolCall.status` sigue siendo `String` libre (dos vocabularios conviven); sin columnas `confirmationId`, `promptVersionId`, `costUsd` (el USD va en `outputJson.usage`); presupuesto en `PropertyAiSetting.configurationJson` en lugar de tabla; rate limit sin tabla (memoria por proceso); `AiPromptVersion` sin `organizationId` ni `model`; `AiPolicy` sin unique `(organizationId, propertyId, code)`; `AiHumanReviewItem` sin `decidedAt`; `PropertyAiSetting.aiEnabled` nace `true` (`lib/tenant-hydration.ts:236-244`); `AiPendingConfirmation` y `AiToolCall` enlazados solo por `outputJson.confirmationId`.

**admin-web (no tocado en L6a; L6b)**: `ai-operations-labels.ts:81-91` no mapea `skipped` ni las claves de readiness `provider`/`budget` (se pintan en crudo); `AiOwnerSummaryScreen.tsx:163-168` «Encendida · En uso» solo por `aiEnabled`; `AiPipelineStatusScreen.tsx:321` «Coste» ahora recibe `costMtdEur` real (0 sin clave) pero sin distinguir NULL; `AssistantChatScreen.tsx:130-132` badge «Con/Sin modelo» por `mode` (ya honesto desde el API); `GeneralManagerScreen.tsx:679` «Insights de IA» sobre reglas; sin pantalla para confirmar `ai_tool_calls` pendientes (la cola de revisión humana solo cubre high/critical); guías (`guideContent.ts`) sin aviso de respuesta por reglas.

**Móvil**: `services/api.ts:67-107` llama a `/ai/commands/check-in-from-scan` y `/ai/confirmations/:id/execute` sin `Authorization` y simula éxito en `catch`; `AICommandCenterScreen.tsx:29` confianza fija.

**Otros**: `apps/api/src/lib/llm.ts` mantiene `provider: string` en `LlmMeta` por compatibilidad; los llamadores históricos sin `ctx` ya no comparten ningún cubo (`context_required`, corrección 1) pero siguen respondiendo por reglas hasta §5.1; `RunnerContext.roles` no se rellena desde el API (`UserContext` sin `templateKey`: el rol de aprobación se satisface con `ai.high_risk.confirm`); la reclamación de la confirmación usa `confirmed_by` sin columna nueva (un proceso caído entre reclamar y cerrar deja la fila pendiente reclamada, resolución manual); `runEvaluation` aplica puertas y filas propias en lugar de `runAiTool` porque la ruta no le pasa `UserContext`; `audit_events.after_json` de `AI_GUEST_REPLY_DRAFTED` conserva la pregunta y el borrador en claro (auditoría, no telemetría; fuera de esta corrección); el prompt del asistente de cumplimiento y del parser de reservas siguen en código (sin `ai_prompt_versions`); `packages/ai-core` no tiene `lint` efectivo (eslint 9 sin flat config, como el resto del monorepo); `tests/safety.test.mjs` y `observability-contract` ajustados a la retirada del gateway.

## 8 · Riesgos residuales y lo no ejecutado

- **Sin clave**: `output_config.format` (forma cruda), `cache_read_input_tokens`, `stop_reason: tool_use`, el alias fechado de Haiku y los precios de `PRICING_TABLE` (2026-06-24) solo se confirman con el humo manual (runbook §4); hasta entonces son afirmaciones de la referencia `claude-api`, no observaciones.
- **Handlers sin cablear**: `scan-id-document` y `suggest-mapping` siguen ejecutando el cuerpo antiguo de `server.ts` hasta aplicar §5.1; desde la corrección 1, con clave, no llaman al proveedor (`context_required` → `skipped`), así que la imagen del DNI ya no sale ni se persisten sus valores, pero tampoco funcionan hasta la fusión. Lo mismo para `GET /compliance/properties/:id/assistant` y `POST /compliance/ocr/extract-dates` (§5.1 punto 5).
- **Rate limit por proceso**, **`retry-after` largo sin reintento** (el llamador recibe 429 con `retryAfterSeconds`) y **coste NULL solo con modelo fuera de la tabla de precios**: límites conocidos (diseño §16).
- **Ruta de confirmación inexistente**: las 11 escrituras pendientes solo pueden decidirse por el servicio `confirmToolCall` o por la cola de revisión humana (que no ejecuta la herramienta).
- **Integración completa**: 1 fallo ajeno (`ledger-import-routes`, invariantes de `org_123` alteradas por otra suite o por la carga de Sage en la BD compartida) medido por L6a-4; no repetido en L6a-5.
- **Contratos L2** con vocabulario legado (`completed`/`skipped`/`pending`) y **`docs/api-contracts.md:365`** sin actualizar hasta §5.4.
- **Comportamientos observados por el integrador que conviene conocer** (§11.1): (a) una lectura Prisma sin modelo (`getHousekeepingBoard`, `findReservation`) responde `executed` con `configured: true` (no dependía de un modelo; la fila lleva `model` NULL y `cost_eur` 0) — solo las herramientas que necesitan modelo devuelven `configured: false`; (b) un `execute` que lanza un error de dominio al confirmar (p. ej. bloquear un parte sin habitación → `BadRequestError` 400 «La orden de trabajo no está vinculada a ninguna habitación.») deja la fila `failed` con ese mensaje, audita `AI_TOOL_FAILED` (`actorType: "ai"`) y propaga el error al llamador (la ruta responderá 400); (c) las peticiones `POST` sin cuerpo con `content-type: application/json` reciben 400 de Fastify («Body cannot be empty…») antes del handler: `POST …/evaluations/:id/run` y `…/review/:id/approve` deben enviarse con `{}` o sin la cabecera (afecta a clientes, no al API).

## 9 · Verificación de este lote (L6a-5)

- Ficheros creados (solo los tres exclusivos): `docs/design/AI-CORE.md`, `docs/runbooks/ai-core.md`, `docs/audits/TANDA-L6A-AI-CORE-2026-09-18.md`. Ningún otro fichero tocado; ningún `git add/commit`.
- `node --test tests/brand-contract.test.mjs` verde tras escribir los tres documentos (`docs/runbooks/*.md` es raíz visible; `docs/audits` y `docs/design/olas` son históricos; `docs/design/AI-CORE.md` no es raíz visible pero tampoco usa la marca antigua).
- El identificador `claude-fable-5-1` está PROHIBIDO en todo el código y la configuración (familia con retención de 30 días) y aparece una sola vez por fichero en los tres documentos, siempre en la frase que lo prohíbe (en el runbook, la asignación de §4.9 declarada prohibida en producción); comprobado con `grep -n` sobre `docs/design/AI-CORE.md`, `docs/runbooks/ai-core.md` y este informe.
- Sin nombres de personas en los tres documentos; textos en español.

## 10 · Ronda de corrección 1 (2026-09-18) — hallazgos de la revisión y su estado

Revisión con tres lentes (seguridad-pii-hitl, cliente-fallback-coste, workspace-tests-contratos); 0 fallos de puertas; 17 hallazgos confirmados y 10 bajos. Todo corregido en el worktree `~/anfitorio-demo-wt-l6a` sin tocar ficheros prohibidos ni `schema.prisma`, sin dependencias nuevas (se retira `zod` de `packages/ai-core`) y con `corepack pnpm install --offline` para el enlace (el lockfile vuelve a cambiar: decisión del orquestador). Los scripts de reproducción de los revisores (scratchpad `l6a-sec-runner-repro.mjs`, `l6a-review-repro*.mjs`, `l6a-sec-api-repro.test.mts`) ya no reproducen: H1-H7 en NO-REPRO y S1/S2 del test API en rojo (la ruta viva responde `configured:false` sin `fetch`).

| Id | Corrección | Dónde | Test |
| --- | --- | --- | --- |
| SEC-01 (high) | `lib/llm.ts`: con clave, una llamada sin `ctx.organizationId` no llama al proveedor → `{ configured:false, reason:"context_required" }`; los handlers antiguos de `server.ts` responden `skipped` hasta §5.1 (imagen del DNI y valores nunca salen ni se persisten). Líneas de fusión en §5.1 (puntos 3, 4 y 5) | `apps/api/src/lib/llm.ts:44-76` | `lib/__tests__/llm.test.mts` («con clave pero sin organización → context_required y fetch nunca invocado»); repro S1/S2 del revisor en rojo |
| SEC-02 (high) | `confirmTool` reclama la fila con una transición condicional (`UPDATE … WHERE status='awaiting_confirmation' AND confirmed_by IS NULL`, `count` 0 → 404 opaco); el rechazo es la propia transición condicional; el port `updateToolCall(id, patch, guard?)` devuelve `{ count }` (`updateMany`) | `packages/ai-core/src/runner/runner.ts:608`, `runner/types.ts` (`ToolCallGuard`), `pipeline.service.ts:229`, `tool-runner.service.ts:114` | `runner/__tests__/confirm.test.mjs` («dos aprobaciones concurrentes… ejecutan UNA sola vez»), `tests/integration/l6a-tool-runner.test.mts` (dos `confirmToolCall` en paralelo sobre Prisma: una `succeeded`, otra 404, `work_orders` +1) |
| SEC-03 (medium) | Misma propiedad que la fila (`row.propertyId === ctx.propertyId`, si no 404 opaco) y ejecución con la propiedad de la fila; re-evaluación al aprobar de `aiEnabled` (403 `AI_DISABLED_FOR_PROPERTY`), `PropertyAiToolSetting.enabled`/nivel `off` (403) y presupuesto (403 `AI_BUDGET_EXCEEDED`); caducidad `CONFIRMATION_TTL_MS` = 24 h desde `createdAt` (fila → `rejected`, revisión cerrada, auditoría `system`, 409 `AI_CONFIRMATION_EXPIRED`) | `runner.ts:516, 532-544, 587-605`, `tool-runner.service.ts:305, 325-327` | `confirm.test.mjs` (propiedad B, re-evaluación, caducidad), `tool-runner.test.mts` (404 propiedad B, 409, 403 ×2), integración (propiedad B misma organización) |
| SEC-04 (medium) | `requiresApprovalRole` (de la fila o del ajuste por herramienta) se exige: rol en `ctx.roles` (nuevo, opcional) o `ai.high_risk.confirm`; 403 con `details.requiresApprovalRole` | `runner.ts:549-563` | `confirm.test.mjs` («requiresApprovalRole… exige ese rol en ctx.roles o ai.high_risk.confirm») |
| SEC-05 (medium) | `resolveAiConfig`: proveedor + clave sin tipo de cambio utilizable → `configured:false, reason:"budget_unavailable"` (código, etiqueta y 503 nuevos); aviso en el arranque, `/health` con `reason=`, readiness `provider` en `error` | `packages/ai-core/src/config.ts:115-146`, `errors.ts`, `labels.ts`, `apps/api/src/lib/ai-config.ts`, `property-ai.service.ts` | `config.test.mjs`, `ai-config.test.mts`, `llm.test.mts` («sin tipo de cambio la IA no arranca») |
| SEC-06 (medium) | `redactForTelemetry` (sanitizado + redactor de PII con marcadores sin mapa, un redactor por fila) en `inputJson`, `outputJson.output`/`record` y `details`; la fila pendiente conserva la entrada ejecutable y la propuesta, que `confirmTool` sustituye por copias redactadas al cerrar (`ToolCallPatch.inputJson`); `createAiReplyDraft` persiste `{ draftChars, model, source }` en vez del borrador restaurado | `runner.ts:126-133, 303-305, 523-526`, `messaging.service.ts` | `runner.test.mjs` («telemetría sin PII»), `confirm.test.mjs` («al cerrar la fila, inputJson y la propuesta se persisten redactados») |
| SEC-07 (medium) | Nombres tras fórmulas de presentación/despedida (`NAME_INTRO_RE`), `opts.knownPii` (siembra en `markerFor`), `opts.redactSystem`, `+34` normalizado al mismo marcador; `answerGuestQuestion` siembra nombre/correo/teléfonos del huésped de la conversación (`knownGuestPii`) | `redaction.ts:79-87, 299-303`, `messages.ts:87-107, 520-527`, `tools/messaging.tools.ts:32-49` | `redaction.test.mjs` (2 nuevos), `messages.test.mjs` («knownPii… redactSystem») |
| SEC-08 (low) | `policy.requiresConfirmation` detiene también las lecturas (`mustConfirm`) | `runner.ts:286` | `runner.test.mjs` («gate allowed:true con requiresConfirmation:true… awaiting_confirmation también en lecturas») |
| SEC-09 / CFC-05 (low / medium) | `runEvaluation`: organización obligatoria (sin `unscoped`), `aiEnabled` y presupuesto antes de empezar y antes de cada caso, una fila `ai_tool_calls` `runAiSafetyEvaluation` por caso con coste real y auditoría `ai` (`recordCase`) | `governance.service.ts:605-720` | integración `l6a-tool-runner.test.mts` («runEvaluation con clave simulada → completed con una fila por caso… aiEnabled=false → skipped… presupuesto agotado → skipped») |
| SEC-10 (low) | `sendGuestMessage` solo `senderType: "ai"` | `tools/messaging.tools.ts:29` | esquema zod (`z.enum(["ai"])`); `tools-coverage` verde |
| CFC-01 (high) | `resolveReasoning`: Sonnet 5 → `thinking: disabled` sin `effort`; Opus 5 → adaptativo con `effort: low`; `effort` pedido → adaptativo; `disabled` solo hasta `high`; Haiku sin `thinking`; `max_tokens` ≥ 2 048 con razonamiento; truncado sin texto → `AiError("truncated")` con telemetría (no éxito facturado) | `messages.ts:442-449, 529-547, 595-597, 636-638` | `messages.test.mjs` (3 tests), `capabilities.test.mjs`, `tests/ai-core-contract.test.mjs` |
| CFC-02 (medium) | `AiError.telemetry` (`invalid_output`, `truncated`); `runTool`/`confirmTool` persisten `failed` con modelo/tokens/`cost_eur` y `usage`; `llmExtractJsonFromImage` devuelve tokens y coste reales con `data: {}` | `errors.ts:73-84`, `messages.ts:599-613`, `runner.ts:395-413, 620-637`, `llm.ts:109-119` | `runner.test.mjs` («AiError con telemetría → fila failed con modelo, tokens y coste»), `llm.test.mts`, `labels.test.mjs` |
| CFC-03 (medium) | `inferenceGeo` en `MODEL_CAPABILITY_TABLE` (false en Haiku 4.5); `send()` solo lo envía si el modelo lo admite | `capabilities.ts`, `messages.ts:537` | `messages.test.mjs`, `capabilities.test.mjs`, contrato raíz |
| CFC-04 (medium) | Líneas 5782/5787 de `server.ts` añadidas a §5.1 punto 5 (fichero prohibido); el servicio no cambia | §5.1 | — |
| CFC-06 (medium) | Igual que SEC-01: sin cubo `unscoped` (contrato raíz lo prohíbe) | `llm.ts`, `tests/ai-core-contract.test.mjs` | `llm.test.mts` |
| CFC-07 (low) | `LlmNotConfigured.telemetry` conserva el coste de un rechazo | `llm.ts:36, 64-66` | `llm.test.mts` (tipo) |
| CFC-08 (low) | `extractIdentityDocument`, `extractJsonFromImage` y el OCR de fechas usan `documentTimeoutMs`; el timeout sigue sin reintentarse (decisión: no duplicar 120 s dentro de una petición HTTP) | `messages.ts`, `compliance-assistant.service.ts` | `document.test.mjs` |
| CFC-09 (low) | Igual que SEC-07 | — | `redaction.test.mjs` |
| CFC-10 (low) | `retry-after` > 30 s → sin espera ni reintento (`rate_limited` con `retryAfterMs` real) | `client.ts:223` | `client-retries.test.mjs` |
| WT-01 (medium) | §5.1 punto 3 corregido: borrar las líneas 60, 61 y 62 de `server.ts` (`recordToolCall` no se usa en ningún otro punto) | §5.1 | — |
| WT-02 (medium) | Formato `decimal` en el contrato de entorno (`env.ts` `schemaFor`, `validate-env.mjs` `checkFormat`, `env-census.mjs` `formatLabel`): `AI_MONTHLY_BUDGET_EUR_DEFAULT` (≥ 0) y `AI_USD_EUR_RATE` (0.01-10); `AiConfig.invalidInputs` con aviso `[ai.config] … valor no numérico`; `env:census:write` regeneró contrato y ejemplos (146/146) | `env.ts`, `scripts/*.mjs`, `config.ts`, `ai-config.ts` | `env.test.mts`, `config.test.mjs`, `ai-config.test.mts` |
| WT-03 (low) | `openai` sigue en el enum por compatibilidad, pero `validateEnv` y `validate-env` avisan «AI_PROVIDER=openai está retirado»; mensaje «Define AI_PROVIDER=anthropic» | `env.ts`, `validate-env.mjs` | `env.test.mts` |
| WT-04 (low) | `zod` retirado de `packages/ai-core/package.json` (`install --offline`) | `package.json` | typecheck ai-core |
| WT-05 (low) | `README.md` sin `npm run dev:ai` | `README.md:32-36` | — |
| WT-06 (low) | Anclas corregidas: `docs/api-contracts.md` 366 → 365 (§5.4); `runner.ts:51, 456-458` → `67, 554` (§5.2); las de `AI-CORE.md` recalculadas en las secciones reescritas y nota de desplazamiento en la cabecera | §5.2, §5.4, `docs/design/AI-CORE.md` | — |
| WT-07 (low) | Bloque de `CLAUDE.md` (§5.5) con contratos raíz 537/537 medidos con `pilots/*.csv` presentes (529 · 2 skipped sin ellos) | §5.5 | `node --test tests/*.test.mjs` |
| WT-08 (medium) | Resolver `aiToolCallConfirmation` implementado y probado (§5.3) | `lib/tenancy.ts:877-891` | integración `l6a-tool-runner.test.mts` |
| WT-09 (low) | Runbook §1: `validate:env` valida `.env.example`; el `.env` real con `node scripts/validate-env.mjs .env --role app` | `docs/runbooks/ai-core.md` | — |
| WT-10 (low) | Contrato raíz: `llm.ts` ≤ 160 líneas (147 hoy) | `tests/ai-core-contract.test.mjs` | `node --test tests/ai-core-contract.test.mjs` |

Puertas tras la corrección (todas desde el worktree): typecheck:all 15 PASS · 0 FAIL · 1 SKIP; contratos raíz 537/537; unitarios API 2.313 (2.312 pass · 1 skipped); ai-core 119/119; integración `l6a-*` 20/20 (organizaciones `org_l6a*` borradas, Faranda idéntica); censo env 146/146 y `validate:env` OK. La integración completa (46 ficheros) no se ha repetido en esta ronda (BD compartida con L3 y la carga Sage). `git status` del worktree: 83 entradas; `git diff --stat` 59 ficheros con seguimiento (+1.990 / −1.343) más los nuevos.

## 11 · Verificación del integrador (2026-09-19)

Método: worktree `~/anfitorio-demo-wt-l6a/hotelos` (rama `tanda-l6a`, sin commit), `.env` sin clave (`AI_PROVIDER_API_KEY=change-me`, sin `AI_PROVIDER`), nada ejecutado en `~/anfitorio-demo/hotelos`, `:3000` sin reiniciar. Dos vías, ambas con organizaciones aisladas de `helpers/l2-tenant.mts` (`org_l2_l6a*`) y usuarios creados con las **plantillas de T8a** (`provisionDefaultTemplateRoles` + `applyRoleTemplate`: owner, general_manager, receptionist, admin y, añadidos por la suite, manager y maintenance), autenticados por `POST /auth/login` real con `RBAC_STRICT=true`, `HOTELOS_ALLOW_DEMO_AUTH=false` y `HOTELOS_DEMO_PERMISSION_UNION=false`; los contextos del runner llevan los permisos **reales** de `GET /users/me` (recepción 75 claves, mantenimiento 25, dirección de hotel 205). Faranda y org_123 solo se leen.

### 11.1 `app.inject` · `tests/integration/l6a-integrador.test.mts` (21/21, 4,0-4,4 s; también en el scratchpad del orquestador `l6a-integrador/`)

| # | Qué | Resultado observado |
| --- | --- | --- |
| 1 | Asistente (recepción): `GET /assistant/tools`, `POST /assistant/chat` | 9 herramientas; `mode: "deterministic"` (la respuesta no contiene `"llm"`); fila `answerAnalyticsQuestion` `succeeded` con `model` NULL |
| 2 | Copiloto (recepción): `GET /copilot/presets`, `POST /copilot/ask` | 10 presets; «Resume el turno actual» → `intent shift_summary`, `source aggregated`, `degraded []`, sin claves `mode`/`model` ni texto «llm/modelo de lenguaje/claude»; pregunta fuera de catálogo → `intent unknown`, `source router` |
| 3 | `POST /ai/commands/scan-id-document` (recepción) | 200 `configured:false`, `source manual`, «OCR no configurado. Introduzca los datos manualmente o configure un proveedor de IA.»; fila `scan_id_document` `skipped`, `model` NULL, sin base64 |
| 4 | Comando de check-in por escaneo (recepción, reserva creada en el hotel A) | `confirmation_required` → fila `checkInReservation` `pending` (`requiredConfirmation true`, reserva sigue `confirmed`); `POST /ai/confirmations/:id/execute` → `executed`, reserva `checked_in`, fila `completed` con `confirmedBy`, auditoría `AI_TOOL_EXECUTED` actor `ai` (SES avisó `SES_ESTABLISHMENT_INCOMPLETE`, tratado como warning). Con `aiEnabled=false` en la propiedad: `rejected` «IA desactivada en esta propiedad.», sin parte de viajeros, fila `rejected` `ai_disabled_for_property`, auditoría `AI_TOOL_DENIED` actor `ai` |
| 5 | Gobernanza: prompts (dirección general), políticas, coste (owner), readiness (owner), evaluación (sistemas), dashboard (owner) | `guest_message_reply` → `currentPublishedVersion v2`; `hasRealCost false`, `projectedMonthlyEur null`, `totalCostEur 0`; readiness `provider` `warn` «Sin modelo configurado: la IA responde por reglas y las funciones de modelo quedan omitidas.» y `ready false`; evaluación `skipped` «No hay proveedor de IA configurado; la evaluación no se ejecutó. Configure AI_PROVIDER + AI_PROVIDER_API_KEY.»; `costMtdEur 0` |
| 6 | Pendientes IA: `GET /ai-operations/review/queue`, `/stats` (owner) | 200, cola vacía al empezar; stats `{ pending 0, … }` |
| 7 | Runner · lectura (`getHousekeepingBoard` {} y `findReservation` por código) con el contexto real de recepción | `executed`, `configured true` (lectura Prisma: no dependía de un modelo), 3 habitaciones; fila `succeeded`, `cost_eur 0`, `model` NULL, `tokens_input 0`, `userId` de recepción; auditoría `[AI_TOOL_EXECUTED:ai]` |
| 8 | Runner · `createWorkOrder` propuesta por **recepción** (`maintenance.workorder.create` sin `manage`) | `denied`, `reason safety`, «Missing permissions: maintenance.workorder.manage.» (matriz `create_maintenance_task`, `risk-matrix.ts:17`) — nada ejecutado; decisión §6.13 |
| 9 | Runner · `createWorkOrder` (habitación 101) propuesta por **mantenimiento**, confirmada por **recepción** | `awaiting_confirmation` (work_orders 0 → 0, fila `requiredConfirmation true`, `cost_eur 0`, `[AI_TOOL_CONFIRMATION_REQUESTED:ai]`); `confirmToolCall approve` → `succeeded`, work_orders 0 → 1, `confirmedBy` recepción, auditorías `[REQUESTED:ai, APPROVED:user, EXECUTED:ai]`; segunda confirmación → 404 opaco |
| 10 | Runner · `blockRoomForMaintenance` (high) propuesta por **dirección de hotel** | `awaiting_confirmation` + ítem `pending` en `GET /ai-operations/review/queue?status=pending` (`relatedEntityType ai_tool_call`); `confirmToolCall` por recepción → 403 `AI_TOOL_CONFIRM_FORBIDDEN` (sin `ai.high_risk.confirm`), fila intacta; `POST /ai-operations/review/:id/approve` (dirección general) → 200 pero la fila sigue `awaiting_confirmation` y `blocksRoom false` (**aprobar en la cola no ejecuta**); `confirmToolCall approve` por dirección → `succeeded`, `blocksRoom true`, revisión `approved` (tolerancia «ya decidida») |
| 11 | Runner · confirmación cuya ejecución falla en el dominio (bloquear un parte sin habitación) | fila `failed` «La orden de trabajo no está vinculada a ninguna habitación.», `AI_TOOL_FAILED` actor `ai`, `BadRequestError` 400 propagado; nada escrito |
| 12 | `GET /ai/tool-calls?envelope=1` (owner, `audit.read`) | 11 filas de la organización: `blockRoomForMaintenance:failed|succeeded`, `createWorkOrder:succeeded|rejected`, `findReservation:succeeded`, `getHousekeepingBoard:succeeded`, `checkInReservation:rejected|completed`, `scan_id_document:skipped`, `answerAnalyticsQuestion:succeeded` |
| 13 | Presupuesto: `configurationJson.monthlyBudgetEur 0,01` + fila previa `cost_eur 0,02` | `ForbiddenError` 403 `AI_BUDGET_EXCEEDED { budgetEur 0.01, spentEur 0.02, propertyId }`, `execute` no invocado, fila `rejected` `budget_exceeded` |
| 14 | Rate limit (`AI_RATE_LIMIT_PER_MINUTE=1`, fetch simulado): `analyzeReviewSentiment` por recepción ×2 | 1.ª `executed` con `claude-haiku-4-5-20251001`, `output_config.format json_schema`, fila `succeeded` `cost_eur 0,000315` (100/50 tokens × 0,9); 2.ª `TooManyRequestsError` 429 `AI_RATE_LIMITED` con `retryAfterSeconds ≥ 1`, fetch no invocado |
| 15 | PII (texto INVENTADO): `answerGuestQuestion` «Hola, soy Ludmila Ferreiro Castiñeira, mi DNI es 12345678Z, mi teléfono 612 345 678 y mi correo ludmila.ferreiro@example.org; pagué con la tarjeta 4111 1111 1111 1111. ¿Tienen parking?» | el cuerpo enviado lleva `[NOMBRE_1]`, `[DOC_1]`, `[TEL_1]`, `[EMAIL_1]`, `[TARJETA_1]` y ninguno de los valores; el `system` **empieza por el contenido publicado en `ai_prompt_versions` (`guest_message_reply` v2, 211 caracteres)**; la respuesta vuelve con el nombre restaurado; fila `succeeded`, `claude-sonnet-5`, `cost_eur 0,00063`, `inputJson`/`outputJson` sin ninguno de los valores |
| 16 | Prompts publicados: código nuevo en borrador (HTTP, dirección general con `ai_prompts.manage`) y otro publicado | borrador → `promptFrom` devuelve el texto en código; `POST …/publish` por dirección general → 403 (tabla global: solo administrador de plataforma); publicado por servicio → `promptFrom` devuelve el contenido de la fila y `GET …/prompts/:code/versions` lo lista `published`; filas borradas al terminar |
| 17-21 | Cliente con fetch simulado | tool use: `tools[]`/`tool_choice {type:auto}` en el cuerpo, `stop_reason tool_use`, `toolUses` con la PII restaurada, URL `https://api.anthropic.com/v1/messages`, `anthropic-version 2023-06-01`; structured: `output_config.format { type: json_schema, schema }`, `thinking { type: disabled }` y sin `temperature` en Sonnet 5, JSON inválido → `AiError invalid_output` con telemetría (40 tokens); documento: bloque `document application/pdf` + `text`, telemetría `{ pages 2, bytes 50, sha256 }` sin bytes, `costUsd 0,005 / costEur 0,0045`; reintentos: 429 + `retry-after: 1` → 2 fetch (1,5-1,6 s), 500 → reintento, 400 → 1 fetch y `AiError` no reintentable `status 400`; coste: 1000/200 tokens + 500 de caché leída en Sonnet 5 → `costUsd 0,0041 · costEur 0,00369`, modelo desconocido → `null`, sin tokens → 0 |

### 11.2 Instancia propia `:3904` (26/26 sondas; scripts `setup-3904.mts` / `check-3904.mjs` / `teardown-3904.mts` en el scratchpad del orquestador)

Arranque desde `apps/api` con `PORT=3904 HOTELOS_ALLOW_DEMO_AUTH=false HOTELOS_DEMO_PERMISSION_UNION=false RBAC_STRICT=true RUN_SCHEDULERS=false node --env-file-if-exists=../../.env --import tsx src/server.ts` (la organización aislada se crea **antes** porque los espejos de tenant se hidratan al arrancar); listo en 3 s; 0 entradas `level 50` en el log; matada al terminar (`lsof -iTCP:3904` vacío).

- Salud y auth: `GET /health` 200 con checks `database, redis, sentry, verifactu, sesHospedajes, schedulers, env` y **sin `checks.ai`** (llega con §5.1 punto 2); `POST /assistant/chat` sin sesión → 401; `POST /ai/tool-calls/xyz/confirm` → 404 (la ruta no existe hasta la fusión).
- Organización aislada (owner, dirección general, recepción, sistemas): mismas etiquetas que en 11.1 — asistente `deterministic`; copiloto «¿Qué habitaciones puedo entregar ahora?» → `rooms_ready_for_delivery`, `source room`, `degraded []`; scan `configured:false` «OCR no configurado…»; readiness `provider warn` / `ready false`; coste `hasRealCost false`, `projectedMonthlyEur null`, `budgetDefaultEur 25`; prompts `guest_message_reply v2`; evaluación `skipped` con motivo; Pendientes IA 0; dashboard `costMtdEur 0` (`callsTotal 2`); `GET /ai/tool-calls` → `scan_id_document:skipped`, `answerAnalyticsQuestion:succeeded`.
- **Usuarios de demo T8a de Faranda, solo lectura** (`direccion.general@faranda.test`, `recepcion.rias@faranda.test`; contraseña de `seed-rbac-demo.ts`): readiness de Rías Altas (`aiEnabled=false` en BD) → `{ enabled: warn, provider: warn, … }`, `ready false`; Los Tilos → `provider warn` «Sin modelo configurado…», `ready false`; `governance/cost` → `hasRealCost false`, `projectedMonthlyEur null`, `totalCostEur 0`; Pendientes IA 0; dashboard de Los Tilos `costMtdEur 0` (`callsTotal 0`); `GET /ai/tool-calls` de Rías Altas `total 2` (las dos filas históricas `guest_message_reply`); recepción: 9 herramientas del asistente, 10 presets, «Resume el turno actual» → `shift_summary`, `source aggregated`, `degraded []`; `governance/cost` 200 (recepción lleva `analytics.read`). Ninguna escritura en Faranda (ni `POST /assistant/chat`): `ai_tool_calls` de Faranda 2 antes y después; 0 eventos de login nuevos en su auditoría.

### 11.3 Puertas re-medidas (2026-09-19 00:17-00:18; §3)

typecheck:all 15 PASS · 0 FAIL · 1 SKIP (20,2 s); ai-core 119/119; contratos raíz 537/537; worker 20/20; unitarios API 2.313 (2.312 pass · 1 skipped); integración `l6a-*` 41/41 (3 ficheros). Front 1.219/1.219 según la puerta 5 del orquestador (0 ficheros de admin-web en la tanda). Integración completa no repetida (BD compartida con L3 y Sage; referencia §3).

### 11.4 Limpieza y estado de la BD compartida (psql, solo SELECT, tras las dos vías)

`organizations org_l2_*` 0 · organizaciones con «l6a» 0 · `users *.l2.l6a*` 0 · `work_orders` de `org_l2_*` 0 · `ai_tool_calls` 46 en total (Faranda 2, `org_l2_*` 0) · `audit_events actor_type='ai'` 2 · `ai_prompt_versions` 3 (0 `l6a_integrador_*`) · `ai_human_review_items` 6 · `ai_pending_confirmations` 0 · `ai_evaluations` 2 — idéntico al baseline del recon §2.8. Las tres suites `l6a-*` borran sus organizaciones en `after` (`cleanupTenant`), incluida la auditoría de la organización de prueba; nada residual que limpiar a mano.

### 11.5 Ficheros tocados por el integrador

`tests/integration/l6a-integrador.test.mts` (nuevo, 21 casos), este informe (§3, §4, §5, §6, §8, §11), `docs/design/AI-CORE.md` (§16-§18) y `docs/runbooks/ai-core.md` (§2-§3). Ningún fichero prohibido; ningún fichero de código de producto; sin `git add/commit`; `pnpm-lock.yaml` sin cambios adicionales; `git status` del worktree: 85 entradas (84 + la suite nueva).
