# AI-CORE · Núcleo de IA (`packages/ai-core`) — contrato tal como quedó implementado (Tanda L6a)

Fecha: 2026-09-18. Rama `tanda-l6a` sobre HEAD `99dc3c3` (L2 commiteada), sin commit. Rutas relativas a `hotelos/`; toda referencia `fichero:línea` está tomada del árbol de la tanda. Este documento describe lo que **existe**, no lo propuesto en el reconocimiento (`tandaL6a-recon.md`, Anexo A): donde la implementación se separó de la propuesta se dice explícitamente. Lo que queda para L6b (asistente unificado con memoria, briefing diario, respuesta a reseñas desde el panel, móvil) está en §16.

Leyenda: **[V]** verificado en el árbol (fichero:línea o comando ejecutado) · **[S]** decisión abierta para el propietario (§17).

**Corrección 1 (2026-09-18, revisión de seguridad/PII/HITL, cliente/coste y workspace; informe §10).** Cambian: razonamiento explícito por modelo (`thinking`/`effort`, §3, §5.1), `inference_geo` solo a modelos que lo admiten (§3), respuestas truncadas y JSON inválido como fallo **con telemetría** (§5.7, §9), `budget_unavailable` sin tipo de cambio (§2, §12), nombres en texto libre, `knownPii` y `redactSystem` (§7), PII redactada en `ai_tool_calls` (§10.2), `confirmTool` con reclamación atómica, ámbito de propiedad, caducidad, re-evaluación de puertas y rol de aprobación (§10.3, §10.5), gate `requiresConfirmation` en lecturas (§10.1), evaluaciones con puertas y una fila por caso (§13), `sendGuestMessage` solo como `ai` (§11), `lib/llm.ts` sin cubo `unscoped` (§8) y `retry-after` por encima del tope sin reintento (§4). Las anclas de línea de `src/{config,client,errors,messages,redaction}.ts` y `src/runner/runner.ts` se recalcularon en las secciones reescritas; las que no se tocaron pueden estar desplazadas unas líneas (buscar por el símbolo citado).

---

## 0 · Resumen en diez líneas

1. `@hotelos/ai-core` es un paquete **puro**: sin Prisma, sin `process.env`, sin dependencias externas (solo `workspace:*`; `zod` se retiró en la corrección 1: no había ningún import), con `fetchImpl` inyectable [V `packages/ai-core/package.json`, `tests/ai-core-contract.test.mjs:42-56`].
2. Cliente Anthropic sobre `fetch` (`/v1/messages`, `/v1/messages/count_tokens`, `/v1/models/{id}`), con reintentos, timeouts y errores tipados [V `src/client.ts`].
3. Modelos por rol: `claude-sonnet-5` (defecto), `claude-haiku-4-5-20251001` (clasificación), `claude-opus-5` (insights); la familia `claude-fable-*` / `claude-mythos-*` está **vetada** por retención (30 días) y desactiva la IA con aviso: en ningún fichero fuente puede aparecer el identificador `claude-fable-5-1` [V `src/config.ts:12-26`, `tests/ai-core-contract.test.mjs:58-69`].
4. Sin clave utilizable todo devuelve `{ configured:false, reason, message }` sin tocar la red; nunca se simula una respuesta [V `src/messages.ts:8`, `src/labels.ts`].
5. PII redactada antes del proveedor con mapa reversible por llamada; nunca sobre bytes (imágenes/PDF) [V `src/redaction.ts`].
6. Coste real desde `usage` con tabla de precios fechada y tipo de cambio configurable: `0` solo sin llamada al modelo, `NULL` cuando hubo llamada sin `usage` o sin tipo de cambio [V `src/pricing.ts`, `src/runner/runner.ts:142-150`].
7. Tool runner con HITL: ocho puertas en orden fijo, toda escritura queda `awaiting_confirmation`, solo el runner registra `ai_tool_calls` y auditoría con `actorType: "ai"` [V `src/runner/runner.ts:1-15`].
8. 25 herramientas con `execute` real en el API (14 lecturas/borradores, 11 escrituras); todo lo de dinero/fiscal queda sin `execute` (`tool_not_implemented`) [V `apps/api/src/modules/ai-operations/tools/index.ts`].
9. Presupuesto mensual por propiedad en `PropertyAiSetting.configurationJson.monthlyBudgetEur` (defecto `AI_MONTHLY_BUDGET_EUR_DEFAULT`) y rate limit por organización (token bucket en memoria) [V `src/runner/budget.ts`, `src/rate-limit.ts`].
10. `apps/api/src/lib/llm.ts` es un envoltorio fino (119 líneas) que conserva los seis nombres históricos; `apps/ai-gateway` se retiró [V `git status` del worktree].

---

## 1 · El paquete

| Elemento | Valor [V] |
|---|---|
| Nombre / alias | `@hotelos/ai-core` → `packages/ai-core/src/index.ts`; `@hotelos/ai-core/runner` → `packages/ai-core/src/runner/index.ts` (`tsconfig.base.json:17-18`). El runner **no** se re-exporta desde el índice (`src/index.ts:3-4`). |
| Dependencias | `@hotelos/shared`, `@hotelos/ai-tools`, `@hotelos/compliance`, `@hotelos/product` (`workspace:*`), `zod ^3.25.0`; dev `typescript` (`package.json:13-22`). Ninguna externa nueva. |
| Scripts | `typecheck: tsc --noEmit`; `test: node --experimental-strip-types --import ./src/__tests__/register-ts-loader.mjs --test 'src/**/__tests__/*.test.mjs'` (patrón de `packages/compliance`). Raíz: `test:ai-core` (`package.json:30`). |
| Tamaño | 39 ficheros · 5.164 líneas: fuente 2.924 (núcleo 1.939 + runner 985), tests 2.041 (núcleo 1.194 + runner 847), cargadores 64, evals JSON 103, metadatos 32. |
| Tests | 103/103 (14 ficheros: núcleo 63, runner 40), sin red (fetch simulado), 0,3 s. |
| Consumidores en el API | `lib/ai-config.ts` (única lectura de `AI_*`), `lib/ai-client.ts` (instancia única), `lib/llm.ts` (shim), `lib/llm-pricing.ts` (re-export), `modules/ai-operations/tool-runner.service.ts`, `modules/ai-operations/tools/*`, `modules/ai/{check-in,scan-id-document}.command.ts`, `modules/onboarding/suggest-mapping.command.ts`, `modules/{messaging,compliance,pms,mapper,assistant}` y `governance.service.ts`. |

Garantías que fijan los contratos raíz (`tests/ai-core-contract.test.mjs`): el shim no contiene `api.anthropic.com` ni `api.openai.com` y mide ≤ 120 líneas; ningún fichero de `packages/ai-core/src` (fuera de tests) contiene `process.env` ni importa `@hotelos/database`; `apps/api/src/lib/ai-config.ts` es el **único** lector de `AI_*` en el API; `PRICING_TABLE_DATE` tiene forma de fecha; las cinco variables nuevas están en `.env.example` y `deploy/.env.production.example`; no queda rastro de `ai-gateway` salvo `RETIRED_KEYS` de `scripts/validate-env.mjs`.

---

## 2 · Configuración: `AiConfig`

`resolveAiConfig(input: AiConfigInput): AiConfig` (`src/config.ts:115-146`) recibe **cadenas crudas** (el API las lee en `apps/api/src/lib/ai-config.ts:19-33` y las pasa; el paquete nunca toca `process.env`).

```ts
type AiConfig = {
  provider: "anthropic" | "none";
  configured: boolean;
  reason?: AiErrorCode;                 // siempre presente cuando configured:false
  apiKey?: string;
  models: { default: string; classify: string; insights: string };
  timeoutMs: number;                    // defecto 20_000
  documentTimeoutMs: number;            // defecto 120_000
  monthlyBudgetEurDefault: number;      // defecto 25
  rateLimitPerMinute: number;           // defecto 60
  usdEurRate: number | null;            // con proveedor es OBLIGATORIO (corrección 1 · SEC-05): null → budget_unavailable
  inferenceGeo?: string;
  invalidInputs?: string[];             // variables presentes pero no numéricas ("0,92", "abc"): el API las avisa, nunca las aplica en silencio
};
```

Orden de decisión (`config.ts:138-144`): proveedor vacío o `none` → `not_configured`; proveedor distinto de `anthropic` (p. ej. `openai`, que `lib/llm.ts` ya no implementa) → `provider_unsupported`; **cualquier** modelo de los tres roles que case `FORBIDDEN_MODEL_PATTERN = /^claude-(fable|mythos)/i` → `model_forbidden`; clave vacía o marcador (`""`, `change-me`, `changeme`, `todo`, `your-key-here`, `placeholder`; `PLACEHOLDER_API_KEYS`) → `not_configured`; **sin tipo de cambio USD→EUR utilizable** (ausente, `0`, negativo o no numérico como `0,92`) → `budget_unavailable` (corrección 1 · SEC-05: sin él `cost_eur` quedaría NULL, el gasto del mes sería 0 y el presupuesto mensual por propiedad no se aplicaría nunca). Los defectos de modelo son `DEFAULT_MODELS`. El API avisa por consola en los tres casos de degradación y por cada variable no numérica (`warnIfDegraded`, `ai-config.ts`), expone `describeAiHealthCheck()` para `/health` (sin la clave; añade `reason=<código>` cuando no está configurado) y `aiConfigSummary()` para el readiness (check `provider` en `error` con `budget_unavailable`). La configuración se cachea por proceso (`getAiConfig`).

Variables del API (`apps/api/src/lib/env.ts:710-742`, censadas en `scripts/env-contract.json` con `readBy: apps/api/src/lib/ai-config.ts`): `AI_PROVIDER` (enum `none|anthropic|openai`, defecto `none`), `AI_PROVIDER_API_KEY` (secreta, obligatoria si `AI_PROVIDER!=none`), `AI_MODEL` (vacío = `claude-sonnet-5`), `AI_MODEL_CLASSIFY` (`claude-haiku-4-5-20251001`), `AI_MODEL_INSIGHTS` (`claude-opus-5`), `AI_REQUEST_TIMEOUT_MS` (1000-600000, 20000), `AI_DOCUMENT_TIMEOUT_MS` (1000-600000, 120000), `AI_MONTHLY_BUDGET_EUR_DEFAULT` (formato `decimal` ≥ 0 con punto; 25; 0 bloquea), `AI_RATE_LIMIT_PER_MINUTE` (1-10000, 60), `AI_USD_EUR_RATE` (formato `decimal` 0.01-10 con punto; obligatoria cuando `AI_PROVIDER=anthropic`: sin ella la IA queda desactivada con `budget_unavailable`), `AI_INFERENCE_GEO` (opcional; nunca se envía a Haiku 4.5). El formato `decimal` es nuevo en el contrato de entorno (corrección 1 · WT-02: `env.ts` `schemaFor` y `scripts/validate-env.mjs` `checkFormat` rechazan la coma decimal en vez de degradar en silencio). `AI_PROVIDER=openai` sigue en el enum por compatibilidad, pero `validateEnv`/`validate-env` avisan de que está retirado (WT-03). Retiradas con el gateway: `AI_GATEWAY_MODE`, `AI_GATEWAY_URL`, `API_BASE_URL`, `OCR_PROVIDER_API_KEY`, `SPEECH_PROVIDER_API_KEY` (`scripts/validate-env.mjs` `RETIRED_KEYS`).

---

## 3 · Capacidades por modelo

`modelCapabilities(model)` resuelve por **prefijo** del identificador (los alias fechados comparten fila) (`src/capabilities.ts:19-40`):

| Prefijo | `sampling` (temperature/top_p/top_k) | `effort` (`output_config.effort`) | `thinking` | `thinkingOffSafe` | `inferenceGeo` | `cacheMinTokens` | `contextTokens` | `maxPdfPages` |
|---|---|---|---|---|---|---|---|---|
| `claude-sonnet-5` | no (400 si se envía) | sí | `adaptive` (por defecto razona si se omite) | sí | sí | 1 024 | 1 000 000 | 600 |
| `claude-haiku-4-5` | sí | no | `budget` (solo con `budget_tokens`; nunca se envía) | no | **no** (400) | 4 096 | 200 000 | 100 |
| `claude-opus-5` | no | sí | `adaptive` | no (desactivarlo tiene modos de fallo documentados) | sí | 512 | 1 000 000 | 600 |
| desconocido | no | no | `none` | no | no | 4 096 | 200 000 | 100 |

Consecuencias en el cuerpo enviado (`send`, `src/messages.ts:520-560`): `temperature` solo con `sampling`; `cache_control` en `system` solo si `opts.cache.system` y la estimación (`estimateTokens` = caracteres/4) alcanza `cacheMinTokens`; `inference_geo` **solo** si `caps.inferenceGeo` (corrección 1 · CFC-03: con `AI_INFERENCE_GEO=eu` las clasificaciones en Haiku 4.5 devolvían 400 no reintentable). Los tres llamadores históricos que pasaban `temperature` (mapper 0.1, compliance 0.3, reservation-agent 0.1) siguen pasándola y el núcleo la descarta en Sonnet 5 / Opus 5.

**Razonamiento (`resolveReasoning`, `messages.ts:442-449`; corrección 1 · CFC-01).** Sonnet 5 y Opus 5 razonan por defecto (effort `high`) cuando se omite `thinking`, y `max_tokens` acota pensamiento **más** respuesta: con los `max_tokens` del catálogo (150-1 500) la respuesta llegaba vacía y facturada. Regla: sin `thinking` ni `effort` → Sonnet 5 envía `thinking: { type: "disabled" }` (barato y seguro) y Opus 5 `thinking: { type: "adaptive" }` con `effort: "low"`; `effort` pedido sin `thinking` → adaptativo con ese effort (`insight` sigue en `medium`); `thinking: "disabled"` solo se admite hasta `high` (con `xhigh|max` pasa a adaptativo); Haiku 4.5 y desconocidos no llevan `thinking` ni `effort`. Con razonamiento activo el `max_tokens` enviado es `max(pedido, MIN_MAX_TOKENS_WITH_THINKING = 2 048)`.

---

## 4 · Cliente (`createAnthropicClient`)

`src/client.ts:116-250`. Cabeceras `x-api-key`, `anthropic-version: 2023-06-01`, `accept: application/json`; base `https://api.anthropic.com` (inyectable). Tres métodos:

- `createMessage(body, { timeoutMs, signal?, beforeAttempt? })` → `POST /v1/messages`; valida que la respuesta tenga `content[]` y `usage` (`client.ts:236-242`).
- `countTokens(body)` → `POST /v1/messages/count_tokens`.
- `getModel(id)` → `GET /v1/models/{id}` (para el humo manual, `docs/runbooks/ai-core.md`).

**Política de reintentos** (`client.ts:5-10, 138-228`): máximo `MAX_RETRIES = 2` (**3 intentos**) en HTTP `429`, en **cualquier 5xx** (`isRetryableStatus`: `status >= 500`, incluye 500/502/503/504/529) y en fallos de red (`TypeError` de fetch). Espera antes del reintento *n*: `retry-after` (segundos o fecha HTTP, `parseRetryAfter`) si viene; si no, `500 ms · 2^n` más jitter ≤ 250 ms; siempre con tope de 30 s (`retryDelayMs`). Un `retry-after` **mayor** que el tope no se recorta ni se reintenta dentro de la petición (corrección 1 · CFC-10, `client.ts:223`): sale al instante como `rate_limited` con el `retryAfterMs` real, y la espera total por llamada queda acotada por 3 × `timeoutMs` + 2 × 30 s. **Nunca** se reintenta en 400/401/402/403/404/413: `AiError("provider_error", retryable:false, status, providerType)` con `providerType = error.type` del cuerpo (p. ej. `overloaded_error` solo aparece en 529, que sí se reintenta). Un 429 agotado sale como `AiError("rate_limited", retryable:true, retryAfterMs?)`.

**Timeouts**: cada intento tiene su propio `AbortController` con `timeoutMs` (`client.ts:141-146`); al vencer → `AiError("timeout")` **sin reintento**. Valores por defecto: `config.timeoutMs` = 20 s para texto y `config.documentTimeoutMs` = 120 s para `extractFromDocument`, `extractIdentityDocument` y `extractJsonFromImage` (corrección 1 · CFC-08: las dos últimas usaban el de texto; el OCR de fechas del Centro de cumplimiento también pasa ahora `documentTimeoutMs`). Una `signal` externa abortada también produce `timeout` («cancelada por el llamador»).

**Rate limit por organización**: `beforeAttempt` se invoca antes de **cada** intento; el núcleo cuelga ahí `limiter.acquire(ctx.organizationId)` (`acquireOrThrow`, `messages.ts`).

---

## 5 · Núcleo de mensajes (`createAiCore`)

`createAiCore({ config, client?, fetchImpl?, limiter?, promptSource?, now?, sleep?, random? }): AiCore` (`src/messages.ts:444-773`). En el API la instancia única la construye `lib/ai-client.ts:27-41` con el limitador de `config.rateLimitPerMinute` y una fuente de prompts de registro tardío (`setAiPromptSource`, que `governance.service.ts:406` rellena con `getPublishedPrompt`).

### 5.1 Tipos del contrato (`messages.ts:39-195`)

- `AiContext { organizationId; propertyId?; userId?; toolName; purpose: complete|classify|extract|insight; correlationId?; conversationId? }`.
- `AiOptions { model?: "default"|"classify"|"insights"|<id literal>; maxTokens?; temperature?; effort?: low|medium|high|xhigh|max; thinking?: "adaptive"|"disabled"; timeoutMs?; cache?: { system: boolean; ttl?: "5m"|"1h" }; redactPii? (defecto true); piiKinds?; roomNumbers?; knownPii?: { kind, value }[]; redactSystem? (defecto false); inferenceGeo?; tools?: AiModelTool[]; toolChoice?: "auto"|"any"|"none"|{ name }; signal? }` (`messages.ts:87-107`). Un identificador literal vetado lanza `model_forbidden` (`resolveModel`). `thinking`/`effort` se resuelven por modelo (§3); `knownPii` y `redactSystem` en §7.
- `AiResult<T> = (AiSuccessMeta & T) | AiNotConfigured`, con `AiSuccessMeta { configured:true; provider:"anthropic"; model; usage { tokensInput, tokensOutput, cacheReadTokens, cacheWriteTokens }; tokensInput; tokensOutput; costUsd; costEur; latencyMs; stopReason; truncated (= stop_reason max_tokens); toolUses: AiToolUse[] }` y `AiNotConfigured { configured:false; reason; message; telemetry? }` (`telemetry` presente cuando el modelo **sí** respondió con `stop_reason: "refusal"`: el coste se registra igualmente; `refusal()`).
- `AiTelemetry` (= `AiErrorTelemetry` de `errors.ts`) `{ model, tokensInput, tokensOutput, cacheReadTokens, costUsd, costEur, latencyMs }` y `telemetryFromAiResult()`: lo que el runner persiste una sola vez. Desde la corrección 1 (CFC-02) también viaja en `AiError.telemetry` cuando el error se produce **después** de una respuesta facturada (`invalid_output`, `truncated`), para que la fila `failed` lleve modelo, tokens y coste.

### 5.2 Funciones

| Función | Qué envía | Qué devuelve |
|---|---|---|
| `complete({ system?, prompt | messages, maxTokens? }, ctx, opts)` | `messages` multi-turno o un solo `user`; `max_tokens` (defecto 1 024); PII redactada en prompt/messages y restaurada en `text` | `{ text }` |
| `structured<T>({ system?, prompt, schema, maxTokens? }, ctx, opts)` | igual + `output_config.format = { type: "json_schema", schema }` | `{ data: T }` validado localmente |
| `extractFromDocument<T>({ pages? | pdfBase64, pageCount?, schema, instruction, maxTokens? }, ctx, opts)` | bloques `image` (uno por página) y/o `document` (PDF), texto de instrucción, `output_config.format`; **sin** redacción (bytes); timeout 120 s; `max_tokens` 4 000 | `{ data: T, document: { pages, bytes, sha256 } }` (telemetría sin bytes) |
| `extractIdentityDocument(imageDataUrl, ctx, opts)` | `extractFromDocument` con `IDENTITY_DOCUMENT_SCHEMA` (todas las claves obligatorias, nulas si no se leen, más `confidence` por campo) e `IDENTITY_DOCUMENT_INSTRUCTION` en español; `max_tokens` 800; timeout de documentos (120 s) salvo `opts.timeoutMs` (corrección 1 · CFC-08) | `{ fields: DocFields, confidence: DocFieldConfidence }` (mismos campos que el `DocFields` histórico) |
| `extractJsonFromImage(imageDataUrl, instruction, ctx, opts)` | un bloque `image` + texto; guarda 10 MB; sin `output_config` (JSON libre); timeout de documentos | `{ data }`; sin JSON → `invalid_output` (o `truncated` si se cortó por `max_tokens`) **con `telemetry`** |
| `classify({ text, labels, system? }, ctx, opts)` | `structured` con esquema `{ label ∈ enum(labels), confidence, rationale }`, rol `classify`, `temperature: 0` (solo llega a Haiku) | `{ label, confidence ∈ [0,1], rationale? }` |
| `insight({ system?, prompt, maxTokens? }, ctx, opts)` | `complete` con rol `insights` y `effort: "medium"` (L6b lo consumirá) | `{ text }` |
| `promptFrom(code, fallback)` | lee `promptSource.getPublishedPrompt(code)` con caché de **60 s** por código; fallo o vacío → `fallback` (prompt en código) | `string` |
| `isConfigured()`, `providerName()`, `modelName(role)`, `getClient()` | — | `getClient()` es `null` sin configuración (humo manual) |

Sin `configured` **ninguna** de ellas hace fetch: devuelven `notConfigured()` con `reason = config.reason` y `message = labelFor(reason)` (`messages.ts:461-463`).

### 5.3 Tool use (sin consumidor en L6a)

`opts.tools` (`{ name, description, input_schema }`) y `opts.toolChoice` se envían tal cual (`messages.ts:508-510`; `toolChoiceBody`: `"auto"|"any"|"none"` → `{ type }`, `{ name }` → `{ type: "tool", name }`). La respuesta expone `toolUses[] = { id, name, input }` con el `input` **restaurado** de PII (`toolUsesFrom`, `messages.ts:402-410`) y `stopReason` (`"tool_use"` cuando el modelo llama a una herramienta). Para el segundo turno existe `toolResultBlock(toolUseId, content, isError)` (`messages.ts:246-248`) y `messages` admite bloques `tool_use` / `tool_result`, que también se redactan (`redactMessages`, `messages.ts:373-391`). Las 25 implementaciones del API declaran `modelInputSchema` (JSON Schema escrito a mano, `tools/context.ts:35`) para exponerlas al modelo en L6b; en L6a **ningún** flujo del API pasa `tools` al núcleo (`tool-use.test.mjs`, 3 tests, cubre el contrato).

### 5.4 Salidas estructuradas

`output_config.format = { type: "json_schema", schema }` se envía **tal cual** en el cuerpo (`messages.ts:497`), forma tomada de la referencia `claude-api` (`shared/model-migration.md:131-137`); **no se ha probado contra la API real** (sin clave): el humo manual lo confirma. La respuesta se valida localmente con `validateJsonSchema` (`messages.ts:340-370`: `required`, tipos primitivos, `enum`, `anyOf`, `properties`, `items`; sin `minimum`/`maxLength`, que el proveedor tampoco admite) y el JSON se extrae con `parseJsonObject` (tolera prosa o cercas). Fallo → `AiError("invalid_output")` con los primeros 5 incumplimientos en `details`. Todos los esquemas del API llevan `additionalProperties: false` en cada objeto (obligatorio en el proveedor): `IDENTITY_DOCUMENT_SCHEMA` (`messages.ts:221-242`), el de `classify` (`messages.ts:721-729`) y los de `tools/*.tools.ts`.

### 5.5 Bloques `image` / `document` y guardas

`extractFromDocument` (`messages.ts:611-667`) comprueba **antes** del fetch: cada imagen ≤ `MAX_IMAGE_BYTES` = 10 MB; petición total (imágenes + PDF) ≤ `MAX_REQUEST_BYTES` = 32 MB; páginas (las de `pages` más `pageCount` o la estimación `estimatePdfPages` por objetos `/Type /Page`) ≤ `maxPdfPages` del modelo (600 en Sonnet 5 / Opus 5, **100** en Haiku 4.5 y desconocidos). Incumplimiento → `AiError("payload_too_large")` (HTTP 413) con `details.bytes`/`pages`. La telemetría del documento es `{ pages, bytes, sha256 }`: nunca los bytes. `extractJsonFromImage` aplica solo la guarda de 10 MB.

### 5.6 `cache_control`

Solo en `system` (`systemBody`, `messages.ts:418-426`): con `opts.cache.system` y estimación ≥ `cacheMinTokens` el `system` viaja como `[{ type: "text", text, cache_control: { type: "ephemeral", ttl?: "1h" } }]`; si no, como cadena. Un prompt corto de clasificador (Haiku 4.5, mínimo 4 096) **no** cacheará aunque se pida. El coste aplica los multiplicadores de escritura 5 m ×1,25 / 1 h ×2 y lectura ×0,1 según `usage.cache_creation_input_tokens` / `cache_read_input_tokens` (`pricing.ts:26-31, 79-85`). En L6a ningún llamador activa `cache.system` todavía (los prompts publicados son cortos); el humo manual verifica `cache_read_input_tokens` con un `system` > 1 024 tokens.

### 5.7 `stop_reason`

`refusal` → `{ configured:false, reason:"refusal", telemetry }`; `tool_use` → `toolUses` no vacío (`meta()`). `max_tokens` (corrección 1 · CFC-01): con texto → `truncated:true` en el resultado (el llamador decide); **sin texto** (solo pensamiento) → `AiError("truncated")` con `telemetry` (`truncatedError`, `messages.ts:595-597`), que el runner persiste como `failed` con coste real; en `structured`/`extractFromDocument`/`extractJsonFromImage` un JSON incompleto por `max_tokens` también es `truncated`, y un JSON que no valida es `invalid_output` con `telemetry` (`structuredData`, `messages.ts:599-613`). `stop_details` se conserva en la respuesta cruda pero no se expone.

---

## 6 · Precios y coste

`src/pricing.ts`. `PRICING_TABLE_DATE = "2026-06-24"` (fecha de la tabla de la referencia `claude-api` usada en el reconocimiento; **actualizar en cada humo con clave**). USD por millón de tokens:

| Modelo (clave de `PRICING_TABLE`) | Entrada | Salida |
|---|---|---|
| `claude-sonnet-5` | 2 | 10 |
| `claude-haiku-4-5` y `claude-haiku-4-5-20251001` | 1 | 5 |
| `claude-opus-5` | 5 | 25 |

Multiplicadores (`PRICING_MULTIPLIERS`): escritura de caché 5 m ×1,25, 1 h ×2, lectura de caché ×0,1, lote ×0,5. `pricingForModel` acepta coincidencia exacta o por el prefijo más largo (`pricing.ts:49-59`).

`costFromUsage(usage, model, usdEurRate) → { usd, eur }` (`pricing.ts:69-91`), redondeo a 6 decimales:

- todos los tokens a 0 → `{ usd: 0, eur: 0 }`;
- modelo sin fila → `{ usd: null, eur: null }` (nunca se fabrica un coste);
- `usdEurRate` nulo, no numérico o ≤ 0 → `eur: null` (el USD sí se calcula y viaja en `outputJson.usage.costUsd`).

**Regla de persistencia en `ai_tool_calls.cost_eur`** (`runner.ts:142-150`, `telemetryColumns`): sin llamada al modelo (denegación, respaldo sin clave, escritura pendiente) → `tokens 0` y **`cost_eur = 0`** (coste real, no fabricado); hubo llamada y `costEur` es `null` (modelo desconocido o sin `AI_USD_EUR_RATE`) → la columna se **omite** (queda `NULL`); hubo llamada con coste → el importe. `AI_USD_EUR_RATE` es obligatoria en `validate-env` cuando `AI_PROVIDER=anthropic` (`env.ts:736-740`) precisamente para que el panel no muestre `NULL` en producción. El panel de gobernanza expone `hasRealCost` (alguna fila con `model` y `cost_eur` no nulos) y deja `projectedMonthlyEur: null` mientras no lo haya (`governance.service.ts:855-910`); el pipeline suma `cost_eur` del mes natural UTC (`pipeline.service.ts:244-252`, `monthToDateCostEur`).

`apps/api/src/lib/llm-pricing.ts` re-exporta `PRICING_TABLE_DATE`, `PRICING_TABLE`, `PRICING_MULTIPLIERS`, `costFromUsage`, `pricingForModel` (DOCUMENTOS §5.2).

---

## 7 · Redacción de PII

`src/redaction.ts`. `createPiiRedactor(options)` crea un mapa **en memoria por llamada** marcador → valor; el mismo valor normalizado recibe siempre el mismo marcador (`markerFor`, `redaction.ts:256-266`); `restorePii(text, map)` y `restorePiiDeep(json, map)` deshacen la sustitución aunque el modelo devuelva el marcador sin corchetes o entre comillas latinas (`redaction.ts:319-340`). El núcleo lo aplica por defecto (`opts.redactPii !== false`) a `prompt`/`messages` (texto, `tool_result` y `input` de `tool_use` previos) y **no** a bloques `image`/`document` (`redactMessages`). `system` se redacta con el mismo mapa solo si `opts.redactSystem: true` (corrección 1 · SEC-07: pensado para contexto del huésped en instrucciones — memoria de conversación, briefing de L6b —; las instrucciones propias no se tocan por defecto). `opts.knownPii: { kind, value }[]` siembra en el mapa la PII estructurada que el llamador ya conoce (`createPiiRedactor({ knownPii })`, `redaction.ts:299-303`): recibe marcador antes de los detectores y `knownValueHits` la sustituye aunque aparezca sin tratamiento ni formato (`answerGuestQuestion` siembra nombre, correo y teléfonos del huésped de la conversación: `knownGuestPii`, `tools/messaging.tools.ts:32`). Restaura `text`, `data` y `toolUses[].input`.

Detectores y marcadores (`redaction.ts:48-152`, orden email → card → document → phone → name → room):

| Tipo | Marcador | Detección |
|---|---|---|
| correo | `[EMAIL_n]` | regex de correo |
| tarjeta | `[TARJETA_n]` | 13-19 dígitos con separadores y **Luhn** válido |
| documento | `[DOC_n]` | NIF/NIE/CIF con carácter de control válido (`classifySpanishTaxId` + `isValidSpanishTaxId` de `@hotelos/compliance`); pasaporte `[A-Z]{3}[0-9]{6}` o `[A-Z]{2}[0-9]{6,7}` |
| teléfono | `[TEL_n]` | `+`/`00` + 9-15 dígitos, o 9 dígitos nacionales que empiezan por 6-9; `+34 612 345 678` y `612 345 678` normalizan al mismo marcador |
| nombre | `[NOMBRE_n]` | ≤ 3 tokens capitalizados tras `Sr.`, `Sra.`, `Srta.`, `Don`, `Doña`, `D.`, `Dña.` (`NAME_RE`) **y** tras las fórmulas de presentación/despedida «soy», «somos», «me llamo», «se llama», «mi nombre es», «a nombre de», «mi/nuestra/su + hija|hijo|mujer|marido|esposa|esposo|pareja|madre|padre|hermana|hermano|amiga|amigo|compañera|compañero|acompañante», «firmado:», «atentamente,», «cordialmente,», «un saludo,», «saludos,» (`NAME_INTRO_RE`, `redaction.ts:81-87`; corrección 1 · SEC-07/CFC-09; un tratamiento tras la fórmula lo resuelve `NAME_RE`) |
| habitación | `[HAB_n]` | opcional (`roomNumbers: true`): «habitación 123», «hab. 12», «room 4» |

Un valor ya aprendido (p. ej. el nombre del primer turno) se sustituye en los textos siguientes aunque aparezca sin tratamiento (`knownValueHits`, `redaction.ts:184-204`). Las URL de datos y las cadenas base64 largas (≥ 64 caracteres) se **bloquean** antes de pasar los detectores (`lockBytes`, `redaction.ts:220-242`) para no romper bytes incrustados.

**Qué NO se redacta**: los bytes de imágenes y PDF viajan íntegros (política `packages/compliance/src/id-scan-policy.ts:9-29`: la imagen se descarta tras la extracción y nunca se persiste); un nombre sin tratamiento ni fórmula de presentación que no haya aparecido antes y no venga en `knownPii` (p. ej. «Ana llega mañana»); direcciones postales; fechas de nacimiento en texto libre; el `system` salvo `redactSystem`. Un fallo del redactor lanza `pii_redaction_failed` (HTTP 422) y la llamada **no** sale. Cobertura: `redaction.test.mjs` (12 tests con nombres inventados, incluidos texto libre y `knownPii`), `messages.test.mjs` (`knownPii` + `redactSystem`) y el test de integración `l6a-tool-runner.test.mts` («el cuerpo enviado al proveedor lleva `[NOMBRE_1]` y `[TEL_1]` y nunca los valores»).

---

## 8 · Rate limit por organización

`createRateLimiter({ perMinute, now? })` (`src/rate-limit.ts`): token bucket **en memoria por proceso** con recarga continua (`capacity / 60_000` por ms), una cubeta por clave (`organizationId`); `perMinute ≤ 0` desactiva el límite; `acquire` deniega con `retryAfterMs` cuando no queda un token. El núcleo lo llama antes de cada intento (§4) y convierte la denegación en `AiError("rate_limited", status 429, retryAfterMs)`; el API la traduce a `TooManyRequestsError` 429 con `details.code = "AI_RATE_LIMITED"` y `retryAfterSeconds` (`tool-runner.service.ts:244-247`, `lib/http-error.ts`). Sin Redis ni tabla: se reinicia con el proceso y no se comparte entre réplicas [S §17]. Corrección 1 (CFC-06 / SEC-01): el shim `lib/llm.ts` ya **no** tiene cubo `"unscoped"`: con clave, una llamada sin `ctx.organizationId` devuelve `{ configured:false, reason:"context_required" }` sin tocar el proveedor (`gate()`, `llm.ts:71-76`), de modo que los dos handlers antiguos de `server.ts` (scan-id-document y suggest-mapping) responden por reglas (`skipped`) hasta que el orquestador los cablee a los comandos del runner (informe §5.1).

---

## 9 · Errores tipados y etiquetas

`AiError { code, retryable, status?, providerType?, retryAfterMs?, details?, telemetry? }` con `toJSON()` sin `cause` ni `telemetry` (`src/errors.ts:68-108`). Códigos (`AiErrorCode`, 18): `not_configured`, `provider_unsupported`, `model_forbidden`, `budget_unavailable` (503; sin tipo de cambio), `ai_disabled_for_property`, `budget_exceeded`, `rate_limited`, `provider_error`, `timeout`, `invalid_output`, `truncated` (422; cortado por `max_tokens` sin contenido útil), `refusal`, `pii_redaction_failed`, `tool_unknown`, `tool_not_implemented`, `tool_denied`, `confirmation_expired` (409; fila pendiente de más de 24 h), `payload_too_large`. `httpStatusForAiError` sugiere 429 / 403 / 409 / 413 / 504 / 502 / 503 / 404 / 422. Nunca se lanza un `Error` genérico desde el paquete.

Etiquetas en español (`src/labels.ts`, `AI_ERROR_LABELS_ES`, reutilizables por admin-web y móvil): «Sin modelo configurado», «Proveedor de IA no soportado», «Modelo no permitido por la política de retención», «IA desactivada en esta propiedad», «Presupuesto mensual de IA agotado», «Límite de peticiones de IA alcanzado», «Error del proveedor de IA», «Tiempo de espera agotado», «Respuesta del modelo no válida», «El modelo rechazó la petición», «No se pudo anonimizar el texto», «Herramienta desconocida», «Herramienta sin ejecución disponible», «Herramienta no permitida», «Documento demasiado grande», y desde la corrección 1 «Presupuesto de IA no aplicable: falta el tipo de cambio USD→EUR (AI_USD_EUR_RATE)», «Respuesta del modelo truncada por el límite de tokens», «Confirmación caducada».

---

## 10 · Tool runner (`@hotelos/ai-core/runner`)

Puro: recibe `RunnerPorts` (`src/runner/types.ts:170-186`: `getDefinition`, `canExecute`, `getPropertySetting`, `getToolSetting`, `evaluatePolicyGate`, `monthToDateCostEur`, `recordToolCall`, `updateToolCall`, `enqueueReview`, `closeReview`, `audit`) y un `RunnerContext` (`types.ts:26-38`: organización, propiedad, usuario, permisos, módulos activos, `correlationId`, `source`, `locale`, `conversationId?`). `runnerContextFromToolContext`/`toolContextFromRunnerContext` convierten desde/hacia el `ToolContext` de `packages/shared/src/types.ts:343-352`.

### 10.1 Orden de puertas (`evaluateToolGates`, `runner.ts:205-293`)

1. **Definición del registro** (`ports.getDefinition(canonicalToolName(name))`; alias legado resuelto por `LEGACY_TOOL_NAME_ALIASES`, §10.5) → `tool_unknown`.
2. **Módulos y permisos** (`canExecuteToolForModules`, `packages/ai-tools/src/registry.ts`) → `module_disabled` («El módulo … no está activo en esta propiedad.») o `missing_permission`.
3. **`PropertyAiSetting.aiEnabled`** → `ai_disabled_for_property`.
4. **Ajuste por herramienta** (`PropertyAiToolSetting`): `enabled:false` → `tool_disabled`; nivel efectivo = `normalizeAutomationLevel(toolSetting.automationLevel ?? property.defaultAutomationLevel)` (los cuatro vocabularios del árbol convergen en `off|suggest|suggest_and_confirm|autonomous`, desconocido → `suggest_and_confirm`; `automation.ts`); `off` → `tool_disabled`.
5. **`evaluateAiSafetyForTool`** (`packages/ai-tools/src/safety.ts`): mapa camelCase → clave snake_case de la matriz (`TOOL_RISK_KEYS`, 20 entradas; 12 claves nuevas en `packages/compliance/src/risk-matrix.ts`); con clave delega en `evaluateAiSafety` (hechos + permisos); sin clave deriva de la definición (lectura low/medium permitida; escritura o high → confirmar; critical → aprobación `manager`). Nunca lanza. Rechazo firme (`denied`) → `safety`.
6. **`evaluatePolicyGate`** (`governance.service.ts:179-243`) con el vocabulario del gate (`toGateLevel`: `off→manual`, `suggest→suggest`, `suggest_and_confirm→confirm`, `autonomous→autonomous`). Sin filas en `ai_policies` el gate permite: el runner **no** se fía de él para las escrituras (paso 8).
7. **Presupuesto mensual**: `budgetStatus(monthToDateCostEur, property.monthlyBudgetEur)`; gasto ≥ presupuesto (o presupuesto 0) → `budget_exceeded` con `budgetEur`/`spentEur`; presupuesto `null` = sin límite.
8. **Modo**: `effect: "write"` → **siempre** `confirm` (`WRITE_ALWAYS_CONFIRMS = true`, `runner.ts:64`, aunque el nivel sea `autonomous` [S §17]); `effect: "read"` → `execute` salvo que el gate lo bloquee (`policy.allowed === false`), **pida confirmación** (`policy.requiresConfirmation`: confianza por debajo del umbral, revisión humana de alto riesgo; corrección 1 · SEC-08) o exista `requiresApprovalRole` (de la matriz o del ajuste por herramienta) → `confirm` (`mustConfirm`, `runner.ts:286`). Riesgo `high|critical` o `policy.requiresHumanReview` → además se encola revisión humana.

### 10.2 `runTool` (`runner.ts:295-503`)

Registra en **todas** las ramas (`ports.recordToolCall` + `ports.audit` con `actorType: "ai"`) y es el único punto de telemetría (los adaptadores devuelven `AiTelemetry`; riesgo 7 del recon):

| Rama | `status` persistido | `outputJson` | Auditoría |
|---|---|---|---|
| denegada (puertas 1-7, o sin `execute`) | `rejected` (`errorMessage` = motivo) | `{ denied: { reason, message, riskLevel, details? } }` | `AI_TOOL_DENIED` |
| `confirm` | `awaiting_confirmation`, `required_confirmation = true` | `{ proposal (preview determinista), effect, gate, safety, requiresApprovalRole }`; `enqueueReview` si hay revisión humana | `AI_TOOL_CONFIRMATION_REQUESTED` |
| `execute` lanza `AiError` | `failed`; si el error lleva `telemetry` (`invalid_output`, `truncated`), con modelo/tokens/coste reales (corrección 1 · CFC-02) | `{ error: { code, message, retryAfterMs? }, usage? }`; devuelve `denied` con el código | `AI_TOOL_FAILED` |
| `execute` devuelve `configured:false` sin telemetría (sin clave) | `legacyStatus.notConfigured ?? "skipped"`, tokens 0, coste 0 | `{ configured:false, reason, message }` | `AI_TOOL_EXECUTED` (`configured:false`) |
| `execute` devuelve `configured:false` con telemetría (rechazo) | `failed` con modelo/tokens/coste reales | `{ configured:false, reason, usage }` | `AI_TOOL_FAILED` |
| éxito | `legacyStatus.succeeded ?? "succeeded"` | `{ output: redactado(record ?? output), usage }` | `AI_TOOL_EXECUTED` |

`inputJson`/`outputJson` pasan por `redactForTelemetry` (`runner.ts:126-133`; corrección 1 · SEC-06): `sanitizeForTelemetry` (URL de datos y base64 largos → marcador con el tamaño, `Buffer` → `{ bytes }`, cadenas > 8 000 caracteres recortadas; nunca bytes) **y después** el redactor de PII con marcadores sin mapa (irreversible a propósito; un único redactor por fila, así que un nombre aprendido en la entrada se sustituye también en la salida). Excepción necesaria: la fila `awaiting_confirmation` conserva la entrada ejecutable y la propuesta reales (la persona debe ver lo que aprueba y la confirmación ejecuta esa entrada); `confirmTool` las sustituye por la copia redactada al cerrar la fila (§10.3). Un `execute` puede devolver `{ output, telemetry, record }` para persistir `record` en lugar de `output` (`types.ts`); `record` también se redacta. Las **lecturas y borradores** (`classify*`, `draftReviewResponse`, `answerGuestQuestion`, `extract*`) se ejecutan al instante y persisten `required_confirmation = definition.requiresConfirmation`: la persona revisa el borrador **después**, no antes, salvo que el gate pida confirmación (§10.1 paso 8).

### 10.3 `confirmTool` (`runner.ts:510-669`; reescrita en la corrección 1)

Orden fijo:

1. **Carga y ámbito** (SEC-03): si la fila no existe, es de otra organización, es de **otra propiedad** (`row.propertyId !== ctx.propertyId`, `runner.ts:516`), ya fue reclamada (`confirmedBy`) o no está en `awaiting_confirmation` → `AiError("tool_unknown", 404)` **opaco** (`TOOL_CALL_NOT_FOUND_MESSAGE` = «Llamada de herramienta no encontrada.»). La ejecución corre siempre con la propiedad de la fila (el contexto del confirmador debe coincidir).
2. **Caducidad** (SEC-03): con `createdAt` y más de `CONFIRMATION_TTL_MS` (24 h, misma ventana que `AiPendingConfirmation` del check-in L2; `ttlMs` inyectable) la fila pasa a `rejected` con la guarda condicional, se cierra la revisión como rechazada, se audita `AI_TOOL_CONFIRMATION_REJECTED` con `actorType: "system"` y se responde `AiError("confirmation_expired", 409)`.
3. **Permisos** (SEC-04): los `requiredPermissions` de la definición; para `high|critical` además `ai.high_risk.confirm` (`HIGH_RISK_CONFIRM_PERMISSION`, `runner.ts:67`); y si la fila (`outputJson.requiresApprovalRole`) o el ajuste por herramienta (`PropertyAiToolSetting.requiresApprovalRole`) exigen un rol, ese rol debe estar en `ctx.roles` o, en su defecto, el confirmador debe tener `ai.high_risk.confirm` (`runner.ts:554`) → `tool_denied` 403 con `details.missing` y `details.requiresApprovalRole`. (`RunnerContext.roles` es opcional; el API todavía no lo rellena porque `UserContext` no expone los `templateKey`: la vía efectiva es la clave de alto riesgo.)
4. **Rechazo**: la propia transición a `rejected` es la reclamación (`updateToolCall(…, { status: "awaiting_confirmation", unclaimed: true })`); 0 filas → 404 opaco; después `AI_TOOL_CONFIRMATION_REJECTED` (`actorType: "user"`) y `closeReview("rejected")`.
5. **Re-evaluación al aprobar** (SEC-03): `aiEnabled` de la propiedad → `ai_disabled_for_property` 403; `PropertyAiToolSetting.enabled:false` o nivel `off` → `tool_denied` 403; presupuesto mensual (`monthToDateCostEur` vs `monthlyBudgetEur`) → `budget_exceeded` 403 con `budgetEur`/`spentEur`. La fila no cambia: se podrá confirmar cuando la puerta lo permita.
6. **Reclamación atómica** (SEC-02, `runner.ts:608`): `updateToolCall(row.id, { confirmedBy }, { status: "awaiting_confirmation", unclaimed: true })`; en el API es `UPDATE ai_tool_calls SET confirmed_by = $u WHERE id = $id AND status = 'awaiting_confirmation' AND confirmed_by IS NULL` (`updateMany`, `pipeline.service.ts:229`) y `count = 0` → 404 opaco. Dos aprobaciones concurrentes (o un doble clic) ejecutan **una** sola vez (test unitario y de integración sobre Prisma).
7. Audita `AI_TOOL_CONFIRMATION_APPROVED` (`actorType: "user"`), ejecuta con la **entrada validada de la fila** (`row.inputJson`), cierra la fila a `succeeded` (o `failed` si lanza, si el modelo rechaza o si no hay clave) con `confirmedBy`, latencia, modelo, tokens y coste (también cuando el `AiError` trae `telemetry`), sustituyendo `inputJson` y `outputJson.proposal` por sus copias **redactadas** (SEC-06: la PII solo vive en la fila mientras está pendiente), `closeReview("approved")` (tolera «ya decidida» desde la cola: `isReviewAlreadyDecided`) y audita `AI_TOOL_EXECUTED`/`AI_TOOL_FAILED` con `actorType: "ai"`.

`StoredToolCall` lleva ahora `createdAt` y `confirmedBy` (`runner/types.ts`); el port `updateToolCall(id, patch, guard?)` devuelve `{ count }` y `ToolCallPatch` admite `inputJson`. Límite conocido: si el proceso muere entre la reclamación y el cierre, la fila queda `awaiting_confirmation` con `confirmed_by` y ya no es confirmable (mejor un pendiente huérfano que una segunda ejecución); se detecta en `GET /ai/tool-calls` y se resuelve a mano.

### 10.4 Vocabulario de `status`, `recordAs` y `legacyStatus`

`TOOL_CALL_STATUSES` = `succeeded | failed | pending | awaiting_confirmation | rejected | completed | skipped` (`src/runner/status.ts`; columna `String` libre en Prisma). Decisión §6.7(a) del recon: el runner escribe `succeeded`/`awaiting_confirmation`/`rejected`/`failed`; los llamadores históricos conservan su vocabulario mediante `legacyStatus: { succeeded?, notConfigured? }` (`scan_id_document` → `completed`/`skipped`; `guest_message_reply` → `completed`/`completed`; `onboarding_mapping_suggest` → `completed`/`skipped`; el check-in L2 → `pending`→`completed`) y `recordAs` persiste el nombre legado mientras las puertas se evalúan con el canónico (`src/runner/tool-names.ts`: `scan_id_document → extractGuestIdentityFieldsTemporary`, `guest_message_reply → answerGuestQuestion`, `onboarding_mapping_suggest → suggestRoomTypeMapping`). El panel cuenta éxito con `isSuccess` (`succeeded|completed`) y espera con `isAwaiting` (`awaiting_confirmation|pending`) (`pipeline.service.ts:3, 293-294`). Los tests L2 (`l2-modulos-ia.test.mts`, `l2-persistencia-plataforma.test.mts`) siguen verdes sin cambios.

### 10.5 Servicio del API (`modules/ai-operations/tool-runner.service.ts`)

`runAiTool({ context: UserContext, toolName, recordAs?, legacyStatus?, input, facts?, confidence?, execute?, preview?, correlationId, source?, locale?, conversationId? })` valida la entrada con el esquema zod de la implementación **antes** de registrar nada (400 en español, `tools/context.ts:47-56`), construye los ports Prisma sobre los servicios existentes (`buildRunnerPorts`, `tool-runner.service.ts:164-202`: `getPropertyAiSettings`, `propertyAiToolSetting`, `evaluatePolicyGate`, `recordToolCall`/`updateToolCall`/`monthToDateCostEur`, `enqueueReview`/`approveReview`/`rejectReview`, `recordAuditEvent`, `getEnabledModuleCodes`, `canExecuteToolForModules`, `TOOL_DEFINITIONS`) y traduce dos denegaciones a errores HTTP tipados: `budget_exceeded` → `ForbiddenError` 403 `AI_BUDGET_EXCEEDED` (`propertyId`, `budgetEur`, `spentEur`, `toolCallId`); `rate_limited` → `TooManyRequestsError` 429 `AI_RATE_LIMITED` (`retryAfterSeconds`). `confirmToolCall({ context, toolCallId, decision, notes?, correlationId })` envuelve `confirmTool` (404 `NotFoundError` opaco —también para otra propiedad de la misma organización, `tool-runner.service.ts:305`—, 403 `AI_TOOL_CONFIRM_FORBIDDEN`, 403 `AI_DISABLED_FOR_PROPERTY`, 403 `AI_BUDGET_EXCEEDED`, 409 `AI_CONFIRMATION_EXPIRED`, 429; `tool-runner.service.ts:320-330`). El resolver de tenancy para la ruta es `aiToolCallConfirmation` (`lib/tenancy.ts:877`; distinto de `aiToolCall`, que resuelve cualquier fila por organización para `GET /ai/tool-calls/:id`): solo resuelve filas `awaiting_confirmation` sin reclamar, y el resto es el mismo 404 opaco. Todas las dependencias son inyectables (`resetAiToolRunnerForTests`), lo que permite los 14 tests unitarios sin Prisma (`__tests__/tool-runner.test.mts`). La ruta `POST /ai/tool-calls/:id/confirm` **no existe todavía** (fichero prohibido en la tanda): la línea exacta está en el informe (`docs/audits/TANDA-L6A-AI-CORE-2026-09-18.md` §5).

---

## 11 · Herramientas con `execute` real (25) y excluidas

Registro: 146 definiciones (`TOOL_DEFINITIONS`; 71 `read` / 75 `write`; riesgo low 51 · medium 54 · high 37 · critical 4; `requiresConfirmation` 81), 146 nombres en `tool-names.ts`, **0 sin definición** (antes 100 / 141 / 41) [V evaluado con tsx desde `apps/api`]. `effect` es explícito en toda definición con implementación; en el resto se deriva (`requiresConfirmation → write`, `registry.ts:5-12, 40`).

| Efecto | Herramienta | Módulo | Riesgo | Permiso (además de `ai.tool.execute`) | Fichero |
|---|---|---|---|---|---|
| read | `findReservation` | pms_core | low | pms.reservation.read | `tools/pms.tools.ts` |
| read | `matchGuestToReservation` | pms_core | medium | pms.reservation.read | `tools/pms.tools.ts` |
| read | `validateRoomAssignment` | pms_core | medium | pms.reservation.read | `tools/pms.tools.ts` |
| read | `quoteAvailability` | pms_core | medium | pms.reservation.read | `tools/pms.tools.ts` |
| read | `checkGuestRegisterCompleteness` | spain_guest_register_compliance | low | guest_register.read | `tools/guest-register.tools.ts` |
| read | `validateSpainGuestRegister` | spain_guest_register_compliance | medium | guest_register.read | `tools/guest-register.tools.ts` |
| read | `getHousekeepingBoard` | housekeeping | low | housekeeping.read | `tools/operations.tools.ts` |
| read | `classifyOnboardingFile` | ai_onboarding_migration | medium | onboarding.ai_extract | `tools/documents.tools.ts` |
| read | `analyzeReviewSentiment` | reputation_quality | low | reputation.read | `tools/reputation.tools.ts` |
| read | `classifyIncomingDocument` | compliance_hub | low | — | `tools/documents.tools.ts` |
| read (borrador, `requiresConfirmation`) | `extractIncomingDocumentFields` | compliance_hub | medium | — | `tools/documents.tools.ts` |
| read (borrador) | `extractGuestIdentityFieldsTemporary` (`recordAs` `scan_id_document`) | spain_guest_register_compliance | medium | guest_register.create | `tools/guest-register.tools.ts` |
| read (borrador) | `draftReviewResponse` | reputation_quality | medium | reputation.respond | `tools/reputation.tools.ts` |
| read (borrador) | `answerGuestQuestion` (`recordAs` `guest_message_reply`) | ai_concierge | low | — | `tools/messaging.tools.ts` |
| write | `assignRoom` | pms_core | medium | pms.reservation.modify | `tools/pms.tools.ts` |
| write | `checkInReservation` | ai_front_desk | high | pms.checkin.execute | `tools/check-in.tools.ts` |
| write | `createWorkOrder` | maintenance | low | maintenance.workorder.create | `tools/operations.tools.ts` |
| write | `blockRoomForMaintenance` | maintenance | high | maintenance.workorder.manage | `tools/operations.tools.ts` |
| write | `resolveWorkOrder` | maintenance | medium | maintenance.workorder.manage | `tools/operations.tools.ts` |
| write | `createHousekeepingTask` | housekeeping | low | housekeeping.task.manage | `tools/operations.tools.ts` |
| write | `markRoomClean` | housekeeping | medium | housekeeping.task.manage | `tools/operations.tools.ts` |
| write | `markRoomInspected` | housekeeping | medium | housekeeping.task.manage | `tools/operations.tools.ts` |
| write | `prepareGuestRegisterRecord` | spain_guest_register_compliance | high | guest_register.create | `tools/guest-register.tools.ts` |
| write | `queueSesHospedajesSubmission` | compliance_hub | high | compliance.ses.submit | `tools/guest-register.tools.ts` |
| write | `sendGuestMessage` | ai_concierge | medium | — | `tools/messaging.tools.ts` |

Las 11 escrituras quedan **siempre** en `awaiting_confirmation` (§10.1 paso 8); `tools-coverage.test.mts` (7 tests) comprueba que el `effect` de cada implementación coincide con el del registro y que ninguna herramienta de dinero tiene `execute`.

**Excluidas a propósito (sin `execute` → `denied tool_not_implemented`, HTTP 503)**: todo el grupo folio/pagos/facturas (`getFolioBalance`, `postFolioCharge`, `createPaymentLink`, `recordPayment`, `issueInvoice`, `createRectifyingInvoice`), contabilidad y capex (`extractSupplierBill`, `suggestAccountingCoding`, `createSupplierBillDraft`, `matchBankTransaction`, `createJournalEntryDraft`, `explainFinancialVariance`, `createCapexProject`, `createCapexItem`, `calculateEnergyCapexROI`), tarifas y canales (`recommendRateChanges`, `recommendRestrictions`, `syncChannelRates`, `analyzeRateParity`, `detectPriceVariance`, `extractRatePlansFromSheet`, `suggestRatePlanMapping`), y el resto del catálogo (121 definiciones) hasta que cada consumidor lo pida. Las tres `suggest*Mapping` del onboarding (`registry.ts:184-187`) figuran con `requiresConfirmation` y sin `effect` explícito, por lo que la heurística las trata como escritura: `suggest-mapping.command.ts:11-16` responde con `suggestion: null` y aviso de pendiente hasta que se declare `effect: "read"` (informe §5).

Corrección 1 (SEC-10): `sendGuestMessage` solo admite `senderType: "ai"` (`AI_SENDER_TYPES`, `tools/messaging.tools.ts:29`): un texto generado por IA nunca sale firmado como personal y el aviso de IA del canal es obligatorio. Corrección 1 (SEC-07): `answerGuestQuestion` siembra en el redactor la PII conocida del huésped de la conversación (`knownGuestPii`, §7).

Llamadores que ya pasan por el runner [V grep `runAiTool`]: `messaging.service.ts:330` (`answerGuestQuestion` → `guest_message_reply`; respeta `PropertyAiSetting.aiEnabled` y `Conversation.aiEnabled` sin llamar al modelo, `messaging.service.ts:311-323`), `compliance-assistant.service.ts:94, 219` (`summarizeComplianceStatus`, fechas OCR), `reservation-agent.service.ts:325` (`parseReservationRequest`), `property-mapper.service.ts:237` (`extractPropertyMap`), `ai/scan-id-document.command.ts:65` y `onboarding/suggest-mapping.command.ts:115` (comandos listos; los handlers de `server.ts:6544-6672` siguen llamando al shim hasta que el orquestador los cablee, informe §5), `ai/check-in.command.ts:139` (`evaluateToolGates` + `recordToolCall` conservando `pending → completed` y los mensajes que fijan los tests L2). El asistente (`assistant.service.ts:43-44, 154`) declara `mode: "llm"` **solo** si un modelo respondió (`modelAnswered`) y registra `answerAnalyticsQuestion`.

---

## 12 · Presupuesto mensual por propiedad

- **Dónde vive**: `PropertyAiSetting.configurationJson.monthlyBudgetEur` (`MONTHLY_BUDGET_KEY`, `src/runner/budget.ts:7`); numérico y ≥ 0 → ese importe; ausente, nulo, no numérico o negativo → `AiConfig.monthlyBudgetEurDefault` (`AI_MONTHLY_BUDGET_EUR_DEFAULT`, 25 € por defecto). `0` bloquea toda llamada de la propiedad; `null` en `PropertyAiSettingView.monthlyBudgetEur` significaría «sin límite», pero el port del API nunca lo produce (siempre resuelve el defecto, `tool-runner.service.ts:172-179`). Sin columna nueva porque `schema.prisma` pertenece a L3 [S §17].
- **Gasto**: suma de `ai_tool_calls.cost_eur` de la propiedad en el mes natural UTC (`monthToDateCostEur`, `pipeline.service.ts`); las filas con `cost_eur` NULL no suman. Corrección 1 (SEC-05): como sin tipo de cambio utilizable el núcleo no arranca (`budget_unavailable`, §2), ninguna llamada facturada queda sin `cost_eur` por esa causa (solo un modelo fuera de `PRICING_TABLE` lo dejaría NULL); las evaluaciones cuentan (una fila por caso, §13); los fallos tras respuesta facturada (`invalid_output`/`truncated`) también (§10.2). La confirmación de una fila pendiente vuelve a comprobar el presupuesto (§10.3).
- **Cómo cambiarlo**: `POST /ai-operations/property/settings` (`server.ts:3435-3455`; manifiesto `route-permissions.ts:426`: `ai.high_risk.confirm`, riesgo high; el brief lo llama PATCH, pero la ruta registrada es POST) con `{ propertyId, configurationJson: { …configuración actual…, monthlyBudgetEur: 40 } }`. `updatePropertyAiSettings` **sustituye** `configurationJson` entero cuando viene en el cuerpo (`property-ai.service.ts:181-184, 202`): hay que enviarlo completo (leerlo antes con `GET /ai-operations/property/settings?propertyId=…`). El readiness expone el check `budget` (`buildAiReadinessChecks`, `property-ai.service.ts:397-418`) y el panel de gobernanza `budgetDefaultEur`.

---

## 13 · Prompts publicados y evaluaciones

- `promptFrom(code, fallback)` lee la versión `published` de `ai_prompt_versions` a través de `getPublishedPrompt` (`governance.service.ts:392-406`) con caché de 60 s por código; `answerGuestQuestion` usa `promptFrom("guest_message_reply", <texto en código>)`, así que la v2 publicada de la semilla sustituye al prompt en código (`messaging.service.ts:340-342`). `AiPromptVersion` no tiene organización ni modelo (deuda prisma).
- Suites de evaluación en el paquete (`src/evals/*.json`: `guest_message_reply`, `draft_review_response`, `analyze_review_sentiment`; `EVAL_SUITES`, `getEvalSuite`, `scoreCase`) puntúan la salida **real** del modelo de forma determinista (100 si pasa, 40 si no: `maxChars`, `maxWords`, `mustMatch`, `mustNotMatch`). `runEvaluation` (`governance.service.ts:557-760`) las consume y sin clave deja la evaluación `skipped` con `score`/`passRate`/`sampleSize` nulos y coste `null`. Corrección 1 (CFC-05 / SEC-09): con clave, una evaluación gasta modelo como cualquier herramienta y pasa por las mismas puertas y la misma telemetría: organización obligatoria (sin cubo `unscoped`), `aiEnabled` de la propiedad y presupuesto mensual antes de empezar **y antes de cada caso** (con el gasto acumulado de la propia evaluación) → `skipped` con motivo; cada caso deja **una fila** `ai_tool_calls` `runAiSafetyEvaluation` (`succeeded|failed|skipped`, modelo, tokens, `cost_eur`, `inputJson { evaluationId, promptCode, caseId }`) con auditoría `actorType: "ai"` (`recordCase`, `governance.service.ts:639`), de modo que `monthToDateCostEur`, la puerta 7 del runner y el panel de coste la ven. No pasa por `runAiTool` porque `runEvaluation(id)` no recibe `UserContext` (la ruta de `server.ts` no lo pasa y el fichero es de L3); las puertas de módulo/permisos las cubre el manifiesto (`ai_evals.manage`).

---

## 14 · Auditoría y telemetría: dónde queda cada cosa

| Hecho | Tabla / campo |
|---|---|
| cada ejecución, pendiente, denegación o fallo de herramienta | `ai_tool_calls` (una fila por `runTool`; `updateToolCall` en la confirmación) con `tool_name` (canónico o `recordAs`), `status`, `input_json`/`output_json` sanitizados, `required_confirmation`, `confirmed_by`, `model`, `latency_ms`, `tokens_input`, `tokens_output`, `cost_eur`, `error_message`, `automation_level` |
| auditoría | `audit_events` con `actor_type = "ai"` y `action ∈ AI_TOOL_EXECUTED | AI_TOOL_CONFIRMATION_REQUESTED | AI_TOOL_DENIED | AI_TOOL_FAILED`; la decisión humana con `actor_type = "user"` y `AI_TOOL_CONFIRMATION_APPROVED | REJECTED`; `entity_type = "ai_tool_call"`, `correlation_id` del contexto |
| revisión humana | `ai_human_review_items` (`reviewType`/`relatedEntityType` = `ai_tool_call`) cuando hay `requiresHumanReview` (riesgo high/critical o gate) |
| confirmaciones del check-in L2 | `ai_pending_confirmations` (sin cambio de forma; `check-in.command.ts`) |
| documentos | solo `{ pages, bytes, sha256 }` y claves leídas con confianza; nunca valores ni bytes (`scan-id-document.command.ts:13-14`) |

---

## 15 · Diferencias respecto a la propuesta del recon (Anexo A)

- `MAX_RETRIES = 2` (3 intentos) y reintento en **cualquier** 5xx (la propuesta decía 429/500/529): decisión de implementación de L6a-1 conservadora con `retry-after` y tope de 30 s.
- `embeddings`: no existe, como se propuso.
- `extractIdentityDocument` mantiene el timeout de texto (20 s) salvo `opts.timeoutMs`; `extractFromDocument` genérico usa 120 s.
- `classify` fija `temperature: 0` (solo llega a Haiku 4.5) y `max_tokens` 300.
- `ToolCallStatus` es la unión de 7 valores (§10.4), no un enum nuevo (decisión §6.7(a)).
- La ruta de confirmación y el bloque `ai` de `/health` quedan para el orquestador (ficheros prohibidos); los comandos `scan-id-document` y `suggest-mapping` existen pero no están cableados en `server.ts`.
- Front: sin cambios en admin-web (el brief no lo preveía; deuda en el informe §7).

---

## 16 · Límites conocidos

1. **Rate limit por proceso**: token bucket en memoria; con dos réplicas del API el límite efectivo se duplica y se reinicia con cada arranque (sin Redis ni tabla).
2. **Coste `NULL` solo con modelo fuera de `PRICING_TABLE`**: la fila guarda `cost_eur` NULL y el USD solo en `output_json.usage`; el presupuesto no lo cuenta. Sin `AI_USD_EUR_RATE` la IA no arranca (`budget_unavailable`, corrección 1).
3. **Prompts publicados con caché de 60 s**: publicar una versión nueva tarda hasta un minuto en aplicarse por proceso.
4. **Tabla de precios estática** (`PRICING_TABLE_DATE`): hay que actualizarla a mano; el humo manual lo recuerda.
5. **`output_config.format` sin probar contra la API real** (sin clave): el humo lo confirma o se ajusta `messages.ts:497`.
6. **Caché de prompts**: ningún llamador activa `cache.system` todavía; el clasificador (Haiku 4.5) no cachea por debajo de 4 096 tokens.
7. **`temperature`** de los llamadores históricos se descarta en Sonnet 5 / Opus 5 (comportamiento distinto al del `llm.ts` anterior, que la fijaba en 0,3).
8. **Redacción por regex**: cubre nombres con tratamiento, con fórmula de presentación/despedida y los sembrados por `knownPii`; **no** un nombre suelto sin ninguna de esas pistas ni direcciones; los bytes de documentos viajan íntegros → DPA/ZDR antes de procesar documentos reales.
12. **Reclamación de la confirmación por `confirmed_by`** (sin columna nueva): un proceso que muera entre reclamar y cerrar deja la fila pendiente reclamada (no confirmable) → resolución manual; nunca doble ejecución.
13. **`RunnerContext.roles` vacío en el API**: `UserContext` no expone los `templateKey`, así que `requiresApprovalRole` se satisface hoy solo con `ai.high_risk.confirm` (§10.3). Rellenarlo desde `user_role_assignments` es trabajo de L6b/L3.
14. **Evaluaciones fuera de `runAiTool`**: puertas y filas propias en `runEvaluation` (§13) hasta que la ruta pase `UserContext`.
9. **Comandos no cableados** (`scan-id-document`, `suggest-mapping`) y **ruta de confirmación inexistente** hasta el lote final; mientras tanto, con clave, esos dos handlers antiguos responden `skipped`/`context_required` sin llamar al proveedor (§8); las tres `suggest*Mapping` se tratan como escritura.
10. **Contratos L2 con vocabulario legado** (`completed`/`skipped`/`pending`) conviven con el del runner: dos vocabularios en la misma columna hasta que L3 libere el schema.
11. **L6b**: asistente unificado (Ask + Copiloto + Agente de reservas) con memoria y `tools` del núcleo, briefing diario (`insight` con Opus 5), respuesta a reseñas desde el panel, móvil (`services/api.ts` sin `Authorization`), front honesto (`ai-operations-labels.ts` sin `skipped`, «Encendida · En uso» por `aiEnabled`).
15. **Aprobar en «Pendientes IA» no ejecuta** (verificado por el integrador, informe §11.1): `POST /ai-operations/review/:id/approve` cierra la revisión humana; la fila `ai_tool_calls` sigue `awaiting_confirmation` hasta `confirmToolCall` (que tolera la revisión «ya decidida»). Sin la ruta de confirmación, las escrituras `high|critical` propuestas por la IA no se pueden ejecutar desde el front.
16. **`configured: true` en lecturas sin modelo**: una herramienta Prisma (`getHousekeepingBoard`, `findReservation`) responde `executed` con `configured: true` porque no dependía de un modelo (la fila lleva `model` NULL y `cost_eur` 0); solo las que necesitan modelo devuelven `configured: false` sin clave. Un `execute` que lanza un `HttpError` de dominio al confirmar deja la fila `failed` con ese mensaje, audita `AI_TOOL_FAILED` y propaga el error (la ruta responderá con su código, p. ej. 400).
17. **Matriz de riesgo más estricta que el registro para `createWorkOrder`**: `risk-matrix.ts:17` exige `maintenance.workorder.manage`, el registro `maintenance.workorder.create`; recepción (plantilla T8a) queda denegada al proponer y puede confirmar (decisión §17.13).

---

## 17 · Decisiones pendientes para el propietario

| # | Decisión | Estado en el árbol | Qué hace falta decidir |
|---|---|---|---|
| 1 | **Clave y DPA** | `.env` local con `AI_PROVIDER_API_KEY=change-me` (marcador) y sin `AI_PROVIDER`: todo en respaldo | Cuenta del proveedor, Data Processing Addendum firmado, límite de gasto en la consola y quién custodia la clave (`deploy/.env.production.example:447-482`) |
| 2 | **Retención cero (ZDR)** | Familia Fable vetada en código por su retención de 30 días; Sonnet 5 / Haiku 4.5 / Opus 5 no tienen ZDR por defecto | Solicitar ZDR para la organización antes de enviar imágenes de documentos de identidad o PDF con datos reales; hasta entonces solo imágenes inventadas (runbook §5.7) |
| 3 | **Bedrock UE vs API directa e `inference_geo`** | Cliente solo contra `api.anthropic.com`; `AI_INFERENCE_GEO` se envía como `inference_geo` top-level (`messages.ts:511`), no admitido en Haiku 4.5 | Si la residencia de datos exige UE: Bedrock (otro cliente/SDK y firma SigV4, fuera de L6a) o `inference_geo` con la API directa; confirmar en el humo qué modelos lo aceptan |
| 4 | **Presupuesto por hotel** | 25 € por defecto para las 8 propiedades; `configurationJson.monthlyBudgetEur` por propiedad; 0 bloquea | Importe por centro (y si la oficina central lleva 0), quién lo cambia (`ai.high_risk.confirm`) y si hace falta tabla propia en vez de `configurationJson` (schema de L3) |
| 5 | **Autonomía de escrituras** | `WRITE_ALWAYS_CONFIRMS = true`: ninguna de las 11 escrituras se ejecuta sin persona, ni con nivel `autonomous` (que además exige `configurationJson.autonomousApprovedBy`) | Si en L6b alguna escritura de bajo riesgo (`createHousekeepingTask`, `markRoomClean`) puede ser autónoma con `automationLevel = autonomous` y aprobador registrado |
| 6 | **SDK oficial** | Cliente sobre `fetch` sin dependencias (decisión del orquestador); la referencia recomienda `@anthropic-ai/sdk` | Adoptar el SDK (lockfile, streaming, Batches API) o mantener `fetch` |
| 7 | **Lockfile** | `pnpm-lock.yaml` cambia en el worktree (importer `packages/ai-core` nuevo, `apps/ai-gateway` retirado, `@hotelos/ai-core` en `apps/api`) | Aceptar la regeneración al fusionar (CI usa `--frozen-lockfile`) |
| 8 | **OpenAI** | Retirado del shim: `AI_PROVIDER=openai` → `provider_unsupported` con aviso; el enum de `env.ts:713` lo conserva por compatibilidad | Retirar el valor del enum y de los ejemplos, o mantener un segundo cliente |
| 9 | **Identificadores de modelo** | `claude-haiku-4-5-20251001` (alias fechado) por decisión del brief; la referencia recomienda `claude-haiku-4-5` | Confirmar los tres `GET /v1/models/{id}` en el humo y fijar el alias |
| 10 | **Tipo de cambio** | `AI_USD_EUR_RATE` obligatorio con proveedor; valor manual | Fuente y periodicidad de actualización (o guardar USD en columna propia cuando L3 libere el schema) |
| 11 | **Permisos de la ruta de confirmación** | Servicio listo; ruta pendiente | Manifiesto `["ai.tool.execute"]` riesgo high (el runner exige además `ai.high_risk.confirm` en high/critical) o `critical` con `ai.high_risk.confirm` para todas (informe §5) |
| 12 | **Vocabulario de `status`** | Unión de 7 valores (§10.4) | Normalizar a un enum cuando L3 libere `schema.prisma` y actualizar los tests L2 |
| 13 | **Matriz de riesgo vs registro (`createWorkOrder`)** | `risk-matrix.ts:17` `["maintenance.workorder.manage", "ai.tool.execute"]`; `registry.ts:225` `maintenance.workorder.create`; recepción denegada al proponer (`safety`), confirma sin problema (informe §11.1) | Alinear la matriz a `create` (una línea) o mantener la asimetría a propósito |
| 14 | **`suggest*Mapping` como lectura** | `registry.ts:184-187` sin `effect: "read"` → tratadas como escritura → `suggestion: null` con aviso | Añadir el sexto argumento `"read"` (informe §5.8) |
| 15 | **Módulo `ai_front_desk` en el check-in por escaneo** | `check-in.command.ts:52` `CHECK_IN_REQUIRES_FRONT_DESK_MODULE = false` (solo permisos) | Exigir el módulo (constante a `true` + activarlo en las propiedades y en el test L2) o dejarlo así |
| 16 | **Pendientes IA y ejecución** | Aprobar en la cola no ejecuta (§16.15); ruta de confirmación pendiente (informe §5.1 punto 6) | Si la pantalla de Pendientes IA (L6b) debe llamar a `POST /ai/tool-calls/:id/confirm` al aprobar un ítem `ai_tool_call` |

---

## 18 · Tests que fijan este contrato

- `packages/ai-core` (corrección 1: 119): `config` (7: + `budget_unavailable`, coma decimal e `invalidInputs`), `capabilities` (3: + `thinking`/`inferenceGeo`), `client-retries` (12: 429/5xx/red reintentan, 400/401/413 no, `retry-after`, `retry-after` > 30 s sin reintento, timeout sin reintento), `messages` (16: + razonamiento por modelo, `inference_geo` nunca a Haiku, truncado/`invalid_output` con telemetría, `knownPii` + `redactSystem`), `document` (6: guardas 10 MB / 32 MB / páginas, telemetría sin bytes, timeout de documentos en identidad e imagen), `pricing` (5), `redaction` (12: + nombres en texto libre, `knownPii`), `rate-limit` (4), `tool-use` (3), `labels` (2: 18 códigos); runner: `runner` (28: matriz de puertas, 100 % escrituras con confirmación, `aiEnabled` false, gate, gate `requiresConfirmation` en lecturas, presupuesto, `tool_not_implemented`, sin clave → `skipped`, PII redactada en la telemetría, `AiError` con telemetría → `failed` con coste), `confirm` (13: + concurrencia, propiedad, re-evaluación, caducidad, rol de aprobación, cierre redactado), `budget` (3), `automation-status` (5).
- API (unitarios, sin Prisma): `lib/__tests__/ai-config` (9: + `budget_unavailable` y avisos no numéricos), `lib/__tests__/llm` (14, `fetchImpl` simulado: `temperature` nunca a Sonnet/Opus, `context_required` sin fetch, `budget_unavailable`, tokens reales en `{}`), `lib/__tests__/env` (+ formato `decimal` y aviso `openai`), `ai-operations/__tests__/tool-runner` (19: + propiedad B, caducidad 409, `aiEnabled`/presupuesto al confirmar), `tools-coverage` (7), `pipeline-summary` (6), `governance-prompts` (3), `evals-score` (3), `ai/__tests__/scan-id-document` (5), `assistant/__tests__/assistant-mode` (3). Unitarios del API en total: 2 313 (2 312 pass · 1 skipped).
- Contratos raíz: `tests/ai-core-contract.test.mjs` (7: + razonamiento por modelo e `inference_geo`; `llm.ts` ≤ 160 líneas y sin `"unscoped"`), `tests/ai-safety-matrix.test.mjs` (+1: mapa de claves y matriz), `tests/brand-contract.test.mjs` (`packages/ai-core/src/**` es raíz visible). Total 537/537 con `pilots/*.csv` presentes.
- Integración (`app.inject`, organizaciones propias `org_l6a_*`): `tests/integration/l6a-llamadores-honestos.test.mts` (8) y `l6a-tool-runner.test.mts` (12: escritura pendiente, approve/reject, 404 opaco entre organizaciones, `aiEnabled=false`, presupuesto 403, rate limit 429 con fetch simulado, PII `[NOMBRE_1]`/`[TEL_1]`, visión simulada → `scan_id_document completed` con coste; corrección 1: dos confirmaciones concurrentes sobre Prisma → una ejecución, propiedad B de la misma organización → 404 y resolver `aiToolCallConfirmation`, evaluación con clave simulada → 5 filas con coste y `skipped` con `aiEnabled=false` o presupuesto agotado) y, del integrador (2026-09-19), `l6a-integrador.test.mts` (21: por HTTP como usuarios de las plantillas T8a con permisos reales de `GET /users/me` —asistente `deterministic`, copiloto por reglas, scan `skipped`, check-in pending → completed y `rejected` con `aiEnabled=false`, gobernanza y Pendientes IA—; runner por servicio —lectura `succeeded` con coste 0 y actor `ai`, recepción denegada por la matriz al proponer `createWorkOrder`, mantenimiento propone y recepción confirma, escritura high en la cola: aprobar no ejecuta y `confirmToolCall` sí, fallo de dominio al confirmar → `failed` + 400, `GET /ai/tool-calls`, presupuesto 403, rate limit 429, PII con cinco marcadores y `system` leído de `ai_prompt_versions`, ciclo borrador/publicado—; cliente con fetch simulado —tool use, `output_config.format`, documento PDF, reintentos 429/500 y no 400, coste con caché leída—). Total 41 en 3 ficheros.
