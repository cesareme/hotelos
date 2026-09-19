# Runbook · Núcleo de IA (`@hotelos/ai-core`): configuración, puertas, comprobaciones sin clave y humo manual con clave

Diseño: [`docs/design/AI-CORE.md`](../design/AI-CORE.md). Informe de la tanda: `docs/audits/TANDA-L6A-AI-CORE-2026-09-18.md`. Estado el 2026-09-18: el `.env` local **no** tiene clave utilizable (`AI_PROVIDER_API_KEY=change-me`, sin `AI_PROVIDER`), así que todo el API responde por reglas con etiqueta «Sin modelo configurado». El humo con clave de §4 está **documentado y no ejecutado**: requiere las decisiones del propietario (cuenta, DPA, retención cero, límite de gasto) que recoge el diseño §17.

Convenciones: comandos desde `hotelos/` salvo indicación; `pnpm` siempre a través de `corepack pnpm`; nunca reiniciar la instancia de demo en `:3000` (para probar se arranca una instancia propia en `:3904` y se mata al terminar); nunca un documento de identidad real sin DPA/ZDR; la clave nunca se escribe en un fichero versionado.

## 1 · Configuración (`.env`)

| Variable | Obligatoria | Defecto | Efecto |
| --- | --- | --- | --- |
| `AI_PROVIDER` | no | `none` | `none` = respuestas por reglas; `anthropic` = modelo real; `openai` está retirado: se acepta por compatibilidad, se trata como `none` con aviso `[ai.config] AI_PROVIDER=openai no está soportado…` y `validate:env` también lo avisa (corrección 1 · WT-03) |
| `AI_PROVIDER_API_KEY` | sí, si `AI_PROVIDER!=none` | — | Secreta. Los marcadores `change-me`, `changeme`, `todo`, `your-key-here`, `placeholder` cuentan como «sin clave» |
| `AI_MODEL` | no | `claude-sonnet-5` | Modelo de respuestas. La familia `claude-fable-*` / `claude-mythos-*` está vetada (retención de 30 días): con ella la IA se desactiva entera con aviso (§4.9) |
| `AI_MODEL_CLASSIFY` | no | `claude-haiku-4-5-20251001` | Clasificación y enrutado (admite `temperature`; caché solo ≥ 4 096 tokens) |
| `AI_MODEL_INSIGHTS` | no | `claude-opus-5` | Informes e insights (L6b) |
| `AI_REQUEST_TIMEOUT_MS` | no | `20000` | Timeout por intento (texto). Rango 1000-600000 |
| `AI_DOCUMENT_TIMEOUT_MS` | no | `120000` | Timeout por intento en extracción de documentos/imágenes |
| `AI_MONTHLY_BUDGET_EUR_DEFAULT` | no | `25` | Presupuesto mensual por propiedad cuando `configurationJson.monthlyBudgetEur` no está. `0` bloquea. Formato `decimal` con punto (`12.5`; `12,5` o `abc` fallan en `validate:env` y el API avisa) |
| `AI_RATE_LIMIT_PER_MINUTE` | no | `60` | Llamadas al modelo por minuto y organización (token bucket en memoria, por proceso). Rango 1-10000 |
| `AI_USD_EUR_RATE` | sí, si `AI_PROVIDER=anthropic` | — | Tipo de cambio para `cost_eur` y el presupuesto mensual. Formato `decimal` con punto (`0.92`, rango 0.01-10). **Sin él (o con `0,92`) la IA no arranca**: `configured:false` con motivo `budget_unavailable`, aviso en el arranque y readiness `provider` en `error` (corrección 1 · SEC-05) |
| `AI_INFERENCE_GEO` | no | — | Se envía como `inference_geo` solo a los modelos que lo admiten (Sonnet 5 / Opus 5); a Haiku 4.5 nunca (corrección 1 · CFC-03) |

Retiradas con el gateway: `AI_GATEWAY_MODE`, `AI_GATEWAY_URL`, `API_BASE_URL`, `OCR_PROVIDER_API_KEY`, `SPEECH_PROVIDER_API_KEY` (`RETIRED_KEYS` de `scripts/validate-env.mjs`). `corepack pnpm validate:env` sin argumentos valida `.env.example`, no el `.env`: para que avise de las retiradas que sigan en el fichero real hay que pasarlo explícitamente, `node scripts/validate-env.mjs .env --role app`. El `.env` local todavía conserva `OCR_PROVIDER_API_KEY` y `SPEECH_PROVIDER_API_KEY` con marcador: retirarlas cuando se toque el fichero.

Bloque de ejemplo para un entorno con clave (los valores de modelo son los defectos: se pueden omitir):

```dotenv
AI_PROVIDER=anthropic
AI_PROVIDER_API_KEY=<clave real de la consola del proveedor>
AI_MODEL=claude-sonnet-5
AI_MODEL_CLASSIFY=claude-haiku-4-5-20251001
AI_MODEL_INSIGHTS=claude-opus-5
AI_REQUEST_TIMEOUT_MS=20000
AI_DOCUMENT_TIMEOUT_MS=120000
AI_MONTHLY_BUDGET_EUR_DEFAULT=25
AI_RATE_LIMIT_PER_MINUTE=60
AI_USD_EUR_RATE=0.92
```

Notas: la configuración se resuelve **una vez por proceso** (`apps/api/src/lib/ai-config.ts`, `getAiConfig`): tras cambiar el `.env` hay que reiniciar el API. `corepack pnpm validate:env` comprueba el contrato de los ficheros de ejemplo (`AI_USD_EUR_RATE` obligatoria con `anthropic`, rangos de los enteros, decimales con punto); el `.env` real se valida con `node scripts/validate-env.mjs .env --role app`. Con `AI_PROVIDER=anthropic` sin `AI_USD_EUR_RATE` utilizable el API arranca en modo respaldo con aviso `[ai.config] AI_PROVIDER=anthropic sin AI_USD_EUR_RATE utilizable…` y `GET /health` muestra `reason=budget_unavailable`. Con clave, `GET /ai-operations/property/readiness` pasa el check `provider` a `ok` con el texto «Proveedor anthropic con modelo claude-sonnet-5 (clasificación: claude-haiku-4-5-20251001)».

## 2 · Puertas (comandos exactos)

```bash
corepack pnpm typecheck:all                       # 16 workspaces · 15 PASS · 1 SKIP (apps/guest-web, explícito)
corepack pnpm test                                # contratos raíz = node --test tests/*.test.mjs (61 ficheros)
corepack pnpm test:unit                           # = corepack pnpm --filter @hotelos/api test (unitarios, sin BD)
corepack pnpm test:integration                    # todas las suites (BD local migrada; comparte BD con otras tandas)
( cd apps/api && node --env-file-if-exists=../../.env --import tsx --test "../../tests/integration/l6a-*.test.mts" )   # solo las de IA (app.inject, org_l2_l6a*): 3 ficheros · 41 casos
corepack pnpm test:ai-core                        # = corepack pnpm --filter @hotelos/ai-core test (Node strip-types, sin red)
corepack pnpm env:census                          # comprobación del censo AI_*; env:census:write regenera contrato y ejemplos
corepack pnpm validate:env                        # .env.example y deploy/.env.production.example contra el contrato
node --test tests/ai-core-contract.test.mjs tests/ai-safety-matrix.test.mjs tests/brand-contract.test.mjs
```

Cifras medidas el 2026-09-19 en la rama `tanda-l6a` por el integrador (detalle en el informe §3 y §11; idénticas a las de la corrección 1 salvo la suite nueva): typecheck 15 PASS · 1 SKIP; contratos raíz 537/537 (con `pilots/*.csv` copiados a la raíz del worktree; sin ellos 529 con 2 skipped); unitarios API 2.313 (2.312 pass · 1 skipped); ai-core 119/119; worker 20/20; integración `l6a-*` 41/41 (`l6a-llamadores-honestos` 8 · `l6a-tool-runner` 12 · `l6a-integrador` 21); censo 146/146; `validate:env` OK.

## 3 · Comprobaciones sin clave (estado actual de la demo)

Instancia propia (sin tocar `:3000`; es la que usó el integrador el 2026-09-19, informe §11.2): desde `apps/api`, `PORT=3904 HOTELOS_ALLOW_DEMO_AUTH=false HOTELOS_DEMO_PERMISSION_UNION=false RBAC_STRICT=true RUN_SCHEDULERS=false node --env-file-if-exists=../../.env --import tsx src/server.ts` (lista en ~3 s; `RUN_SCHEDULERS=false` para no competir por los leases con `:3000`; sin auth de demo, así que hace falta un usuario real). Usuarios de demo T8a de Faranda (contraseña en `packages/database/prisma/seed-rbac-demo.ts`, `DEMO_PASSWORD`): `direccion.general@faranda.test` (general_manager: `ai_governance.read`, `ai_evals.manage`, `ai_prompts.manage`, `audit.read`, `ai.high_risk.confirm`), `recepcion.rias@faranda.test` / `recepcion.tilos@faranda.test` (receptionist: `ai.tool.execute`, `pms.checkin.execute`, `maintenance.workorder.create`, `analytics.read`), `sistemas@faranda.test` (admin). Con ellos **solo lecturas** (`GET`, `POST /copilot/ask`): `POST /assistant/chat`, `scan-id-document` y las evaluaciones persisten filas en `ai_tool_calls`/`ai_evaluations` de Faranda; para escribir, crear una organización aislada con `tests/integration/helpers/l2-tenant.mts` (`createIsolatedTenant`, **antes** de arrancar: los espejos de tenant se hidratan al arrancar) y borrarla con `cleanupTenant`. Los `POST` sin cuerpo (`…/run`, `…/approve`) deben llevar `{}` o ninguna cabecera `content-type`: Fastify responde 400 «Body cannot be empty» antes del handler. Cerrar la instancia al terminar (`kill`, comprobar `lsof -nP -iTCP:3904 -sTCP:LISTEN`).

Sesión: `TOKEN=$(curl -sS -X POST "$API/auth/login" -H 'content-type: application/json' -d '{"email":"<usuario con ai.tool.execute>","password":"<contraseña>"}' | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).token')` con `API=http://localhost:3000` (demo) o `:3904` (instancia propia). Las rutas sin `:propertyId` toman la propiedad de la sesión o de la cabecera `x-property-id`.

| # | Comprobación | Comando | Esperado |
| --- | --- | --- | --- |
| 3.1 | Readiness: proveedor en aviso | `curl -sS "$API/ai-operations/property/readiness?propertyId=$PROP" -H "Authorization: Bearer $TOKEN"` | seis checks; `provider` → `status: "warn"`, «Sin modelo configurado: la IA responde por reglas y las funciones de modelo quedan omitidas.»; `budget` → `ok` con «Presupuesto mensual: <presupuesto> (gastado <gasto>).» (25 € por defecto o el importe de `configurationJson.monthlyBudgetEur`) |
| 3.2 | Asistente determinista | `curl -sS -X POST "$API/assistant/chat" -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{"question":"¿Cuántas llegadas hay hoy?"}'` | `mode: "deterministic"` (nunca `llm` sin modelo); fila `answerAnalyticsQuestion` en `ai_tool_calls` con `status succeeded` |
| 3.3 | Escaneo de documento omitido | `curl -sS -X POST "$API/ai/commands/scan-id-document" -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{"imageDataUrl":"data:image/png;base64,iVBORw0KGgo="}'` | 200 `{ configured:false, fields:{}, source:"manual", message:"OCR no configurado. Introduzca los datos manualmente o configure un proveedor de IA." }`; fila `scan_id_document` con `status skipped`, `model` NULL, `cost_eur` 0 |
| 3.4 | Borrador de respuesta por reglas | `curl -sS -X POST "$API/conversations/$CONV/ai-draft" -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{"guestQuestion":"¿Tienen parking?"}'` | `source: "rules"`; fila `guest_message_reply` `completed` con `model` NULL y `cost_eur` 0; `audit_events.actor_type = 'ai'`. Con `aiEnabled=false` en la propiedad o en la conversación: `rules` **sin** fila |
| 3.5 | Evaluación omitida | `curl -sS -X POST "$API/ai-operations/governance/evaluations/$EVAL/run" -H "Authorization: Bearer $TOKEN"` | `status: "skipped"`, motivo «No hay proveedor de IA configurado», `score`/`passRate` nulos |
| 3.6 | Coste honesto | `curl -sS "$API/ai-operations/governance/cost" -H "Authorization: Bearer $TOKEN"` | `hasRealCost: false`, `projectedMonthlyEur: null`, `budgetDefaultEur: 25`; `GET /ai-operations/pipeline/dashboard` → `costMtdEur: 0` |
| 3.8 | Sin tipo de cambio (corrección 1 · SEC-05) | arrancar con `AI_PROVIDER=anthropic AI_PROVIDER_API_KEY=<clave> ` y sin `AI_USD_EUR_RATE` en `:3904` | aviso `[ai.config] AI_PROVIDER=anthropic sin AI_USD_EUR_RATE utilizable…`; `GET /health` → `checks.ai.message` termina en `reason=budget_unavailable`; readiness `provider` → `error` «Presupuesto de IA no aplicable…»; ninguna llamada al proveedor |
| 3.7 | Proveedor no soportado | arrancar con `AI_PROVIDER=openai` en `:3904` | aviso en consola `[ai.config] AI_PROVIDER=openai no está soportado en la Tanda L6a…`; readiness `provider` → `error` «Proveedor de IA no soportado: la IA responde por reglas hasta corregir la configuración.» |
| 3.9 | Copiloto por reglas | `curl -sS -X POST "$API/copilot/ask" -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{"question":"Resume el turno actual"}'` | `intent: "shift_summary"`, `source: "aggregated"`, `degraded: []`, sin claves `mode`/`model` (nunca anuncia un modelo); pregunta fuera de catálogo → `intent: "unknown"`, `source: "router"` |
| 3.10 | Pendientes IA y confirmación | `curl -sS "$API/ai-operations/review/queue?status=pending" -H "Authorization: Bearer $TOKEN"` | las escrituras `high|critical` propuestas por el runner aparecen como ítems `ai_tool_call`; **aprobar en la cola cierra la revisión pero no ejecuta**: la ejecución es `confirmToolCall` (servicio) o `POST /ai/tool-calls/:id/confirm` tras la fusión (hasta entonces esa ruta responde 404). Con la IA apagada en la propiedad, `POST /ai/commands/check-in-from-scan` responde `rejected` «IA desactivada en esta propiedad.» sin escribir el parte de viajeros |

SQL de apoyo (solo lectura, `psql "$DATABASE_URL"`):

```sql
SELECT tool_name, status, model, tokens_input, tokens_output, cost_eur, latency_ms, error_message, created_at
  FROM ai_tool_calls ORDER BY created_at DESC LIMIT 10;
SELECT action, actor_type, entity_type, entity_id, created_at
  FROM audit_events WHERE actor_type = 'ai' ORDER BY created_at DESC LIMIT 10;
```

## 4 · Humo manual con clave — documentado, NO ejecutado

Requisitos previos (decisiones del propietario, diseño §17): cuenta del proveedor con DPA firmado y límite de gasto configurado en su consola; retención cero (ZDR) solicitada **antes** de enviar documentos reales (hasta entonces solo la imagen inventada de §4.7); `AI_USD_EUR_RATE` fijado; una propiedad de pruebas (no un centro real) con `aiEnabled=true`; usuario con `ai.tool.execute` (y `ai.high_risk.confirm` para confirmar escrituras high/critical). Coste estimado del humo completo: < 0,05 USD (todas las llamadas usan `max_tokens` ≤ 200).

Instancia propia (nunca `:3000`), con las variables exportadas en la shell (o `node --env-file=<fichero> --import tsx src/server.ts` desde `apps/api`):

```bash
export ANTHROPIC_KEY='<clave real>'            # solo en la shell; nunca en un fichero versionado
export AI_PROVIDER=anthropic AI_PROVIDER_API_KEY="$ANTHROPIC_KEY" AI_USD_EUR_RATE=0.92
PORT=3904 RUN_SCHEDULERS=false corepack pnpm --filter @hotelos/api dev     # en otra terminal
API=http://localhost:3904
H=(-H "x-api-key: $ANTHROPIC_KEY" -H "anthropic-version: 2023-06-01" -H "content-type: application/json")
```

### 4.1 Los tres modelos existen (`GET /v1/models/{id}`)

```bash
for M in claude-sonnet-5 claude-haiku-4-5-20251001 claude-opus-5; do
  curl -sS "https://api.anthropic.com/v1/models/$M" "${H[@]}" \
    | node -pe 'const r=JSON.parse(require("fs").readFileSync(0,"utf8")); r.id ? `${r.id} · ${r.display_name ?? ""}` : JSON.stringify(r)'
done
```

Esperado: los tres identificadores con su `display_name`. Un `404 not_found_error` en el alias fechado de Haiku significa que hay que usar `claude-haiku-4-5` (cambiar `AI_MODEL_CLASSIFY`, el defecto de `packages/ai-core/src/config.ts:14`, `env.ts:725` y regenerar con `env:census:write`). Equivalente desde el núcleo: `getAiCore().getClient()?.getModel(id)`.

### 4.2 Recuento de tokens (`POST /v1/messages/count_tokens`)

```bash
curl -sS https://api.anthropic.com/v1/messages/count_tokens "${H[@]}" \
  -d '{"model":"claude-sonnet-5","messages":[{"role":"user","content":"Hola, ¿a qué hora es el desayuno?"}]}'
```

Esperado: `{ "input_tokens": <n> }` (n ≈ 15-25). Desde el núcleo: `getClient()?.countTokens({ model, messages })`.

### 4.3 Un `complete` de 20 tokens y su fila en `ai_tool_calls`

Cuerpo crudo (referencia de `usage`):

```bash
curl -sS https://api.anthropic.com/v1/messages "${H[@]}" \
  -d '{"model":"claude-sonnet-5","max_tokens":20,"messages":[{"role":"user","content":"Responde solo: OK"}]}' \
  | node -pe 'const r=JSON.parse(require("fs").readFileSync(0,"utf8")); JSON.stringify({stop:r.stop_reason, usage:r.usage})'
```

Esperado: `usage.input_tokens` > 0, `usage.output_tokens` ≤ 20, `stop_reason` `end_turn` o `max_tokens`. A través del núcleo (desde `apps/api`, misma shell con las variables):

```bash
cd apps/api && node --import tsx --input-type=module -e '
import { getAiCore } from "./src/lib/ai-client.ts";
const r = await getAiCore().complete({ prompt: "Responde solo: OK", maxTokens: 20 }, { organizationId: "humo", toolName: "humo", purpose: "complete" });
console.log(JSON.stringify({ configured: r.configured, model: r.model, usage: r.usage, costUsd: r.costUsd, costEur: r.costEur, latencyMs: r.latencyMs, stopReason: r.stopReason, text: r.text }, null, 2));'
```

Esperado: `configured:true`, `costUsd = (input·2 + output·10) / 1 000 000` (redondeo a 6 decimales), `costEur = costUsd · AI_USD_EUR_RATE`, `latencyMs` > 0. Fila persistida: pedir un borrador por la ruta (3.4) con la instancia `:3904` y comprobar

```sql
SELECT status, model, tokens_input, tokens_output, cost_eur, latency_ms
  FROM ai_tool_calls WHERE tool_name = 'guest_message_reply' ORDER BY created_at DESC LIMIT 1;
```

Esperado: `status completed`, `model claude-sonnet-5`, tokens > 0, `cost_eur` = `round((tokens_input·2 + tokens_output·10) / 1e6 · AI_USD_EUR_RATE, 6)` (sin caché), `latency_ms` > 0, y la respuesta HTTP con `source: "ai"` y el borrador precedido del aviso de IA al huésped. Si `cost_eur` es NULL: falta `AI_USD_EUR_RATE` o el modelo no está en `PRICING_TABLE` (`packages/ai-core/src/pricing.ts:18-23`).

### 4.4 Salida estructurada: la forma cruda de `output_config.format`

```bash
curl -sS https://api.anthropic.com/v1/messages "${H[@]}" -d '{
  "model":"claude-sonnet-5","max_tokens":100,
  "messages":[{"role":"user","content":"Clasifica el sentimiento de: \"La habitación estaba impecable\""}],
  "output_config":{"format":{"type":"json_schema","schema":{"type":"object","additionalProperties":false,
    "required":["label","confidence"],"properties":{"label":{"type":"string","enum":["positivo","negativo","neutro"]},"confidence":{"type":"number"}}}}}
}' | node -pe 'const r=JSON.parse(require("fs").readFileSync(0,"utf8")); r.type==="error" ? "ERROR "+JSON.stringify(r.error) : r.content.map(b=>b.text).join("")'
```

Esperado: `200` y un texto que es JSON válido contra el esquema (`{"label":"positivo","confidence":0.9…}`). Si responde `400 invalid_request_error` mencionando `output_config`, la API **no** acepta esa forma: anotar el mensaje y ajustar `packages/ai-core/src/messages.ts:497` (`outputConfig.format`) según la referencia vigente. Desde el núcleo, el mismo caso: `getAiCore().classify({ text: "La habitación estaba impecable", labels: ["positivo","negativo","neutro"] }, ctx)` → `label`, `confidence`, `rationale`, con modelo `claude-haiku-4-5-20251001` (rol `classify`).

### 4.5 Caché de prompt: `system` > 1 024 tokens dos veces seguidas en Sonnet 5

```bash
SYS=$(node -e 'process.stdout.write("Normas internas del hotel de pruebas para el asistente. ".repeat(160))')   # ≈ 9 000 caracteres ≈ 2 000 tokens
BODY=$(node -e 'console.log(JSON.stringify({model:"claude-sonnet-5",max_tokens:20,system:[{type:"text",text:process.argv[1],cache_control:{type:"ephemeral"}}],messages:[{role:"user",content:"Resume las normas en cinco palabras."}]}))' "$SYS")
for i in 1 2; do
  curl -sS https://api.anthropic.com/v1/messages "${H[@]}" -d "$BODY" | node -pe 'JSON.stringify(JSON.parse(require("fs").readFileSync(0,"utf8")).usage)'
done
```

Esperado: primera llamada `cache_creation_input_tokens` > 0; segunda `cache_read_input_tokens` > 0 (mismo `system`, dentro de los 5 minutos). Desde el núcleo: `complete({ system: SYS, prompt }, ctx, { cache: { system: true } })` dos veces → `usage.cacheWriteTokens` y luego `usage.cacheReadTokens`; el coste aplica ×1,25 a la escritura y ×0,1 a la lectura. Si la segunda llamada no lee caché: comprobar que el `system` supera el mínimo del modelo (1 024 en Sonnet 5; 4 096 en Haiku 4.5, donde un `system` corto **nunca** cachea).

### 4.6 Tool use: `stop_reason: "tool_use"`

```bash
curl -sS https://api.anthropic.com/v1/messages "${H[@]}" -d '{
  "model":"claude-sonnet-5","max_tokens":200,
  "tools":[{"name":"quoteAvailability","description":"Cotiza disponibilidad para unas fechas.","input_schema":{"type":"object","additionalProperties":false,"required":["arrivalDate","departureDate"],"properties":{"arrivalDate":{"type":"string"},"departureDate":{"type":"string"},"adults":{"type":"integer"}}}}],
  "tool_choice":{"type":"tool","name":"quoteAvailability"},
  "messages":[{"role":"user","content":"Quiero una habitación doble del 3 al 5 de octubre de 2026 para dos adultos."}]
}' | node -pe 'const r=JSON.parse(require("fs").readFileSync(0,"utf8")); JSON.stringify({stop:r.stop_reason, tool:r.content.find(b=>b.type==="tool_use")})'
```

Esperado: `stop_reason: "tool_use"` y un bloque `tool_use` con `input.arrivalDate = "2026-10-03"`, `departureDate = "2026-10-05"`, `adults = 2`. Desde el núcleo: `complete({ prompt }, ctx, { tools: [...], toolChoice: { name: "quoteAvailability" } })` → `stopReason === "tool_use"` y `toolUses[0].input` con la PII restaurada. En L6a ningún flujo del API pasa `tools`; esta prueba solo valida el contrato para L6b.

### 4.7 Imagen de prueba INVENTADA en `scan-id-document`

Crear una imagen PNG **inventada** (por ejemplo, una captura de un rectángulo con el texto «DOCUMENTO DE PRUEBA · 00000000T · NOMBRE FICTICIO»); **nunca** un documento real ni la foto de una persona: sin DPA y ZDR los bytes viajan íntegros al proveedor.

```bash
IMG="data:image/png;base64,$(base64 -i prueba.png | tr -d '\n')"
curl -sS -X POST "$API/ai/commands/scan-id-document" -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d "{\"imageDataUrl\":\"$IMG\"}"
```

Esperado: `{ configured:true, fields:{ documentNumber:"00000000T", … }, source:"ai" }` (claves no leídas en `null`). Fila:

```sql
SELECT status, model, tokens_input, tokens_output, cost_eur, latency_ms, input_json, output_json
  FROM ai_tool_calls WHERE tool_name = 'scan_id_document' ORDER BY created_at DESC LIMIT 1;
```

Esperado: `status completed`, `model` con el de visión (`claude-sonnet-5`), `input_json = {"hasImage": true}` (nunca la imagen). **Ojo**: mientras el handler de `server.ts:6544-6586` no esté cableado al comando `scan-id-document.command.ts` (informe §5), la fila la escribe el propio handler y llega **sin** `cost_eur` y con `output_json.fields` (los valores leídos); tras el cableado la escribe el runner con coste real y solo las claves leídas y su confianza. Imagen > 10 MB → `413 payload_too_large`.

### 4.8 `temperature` no se envía a Sonnet 5 / Opus 5

Prueba negativa cruda (confirma la tabla de capacidades):

```bash
curl -sS https://api.anthropic.com/v1/messages "${H[@]}" \
  -d '{"model":"claude-sonnet-5","max_tokens":5,"temperature":0.3,"messages":[{"role":"user","content":"Di OK"}]}' | head -c 300; echo
```

Esperado: `400 invalid_request_error` (el modelo rechaza `temperature`). Si respondiera `200`, la tabla `MODEL_CAPABILITY_TABLE` (`packages/ai-core/src/capabilities.ts:20-22`) es más restrictiva de lo necesario: anotarlo. Prueba positiva del núcleo (fetch interceptado, desde `apps/api`):

```bash
cd apps/api && node --import tsx --input-type=module -e '
import { createAiCore, resolveAiConfig } from "@hotelos/ai-core";
const bodies = [];
const fetchImpl = async (url, init) => { bodies.push(JSON.parse(init.body)); return fetch(url, init); };
const config = resolveAiConfig({ provider: "anthropic", apiKey: process.env.AI_PROVIDER_API_KEY, usdEurRate: process.env.AI_USD_EUR_RATE });
const core = createAiCore({ config, fetchImpl });
const ctx = { organizationId: "humo", toolName: "humo", purpose: "complete" };
await core.complete({ prompt: "Di OK", maxTokens: 5 }, ctx, { temperature: 0.3 });
await core.complete({ prompt: "Di OK", maxTokens: 5 }, ctx, { model: "insights", temperature: 0.3 });
await core.complete({ prompt: "Di OK", maxTokens: 5 }, ctx, { model: "classify", temperature: 0.3 });
console.log(bodies.map((b) => `${b.model}: ${"temperature" in b ? `temperature=${b.temperature}` : "temperature no enviada"}`).join("\n"));'
```

Esperado: `claude-sonnet-5: temperature no enviada`, `claude-opus-5: temperature no enviada`, `claude-haiku-4-5-20251001: temperature=0.3`, y las tres llamadas con `200`.

### 4.9 Modelo vetado: el API arranca en modo respaldo con aviso

```bash
AI_MODEL_VETADO=claude-fable-5-1   # PROHIBIDO en producción (retención de 30 días): este identificador solo se usa aquí para comprobar el respaldo
PORT=3904 RUN_SCHEDULERS=false AI_MODEL="$AI_MODEL_VETADO" corepack pnpm --filter @hotelos/api dev
```

Esperado: (1) aviso en consola al primer uso de la configuración: `[ai.config] Un modelo AI_MODEL* pertenece a una familia vetada por la política de retención (claude-fable-* / claude-mythos-*): la IA queda desactivada hasta corregirlo.`; (2) `GET /ai-operations/property/readiness` → check `provider` con `status: "error"` y detalle «Modelo no permitido por la política de retención: la IA responde por reglas hasta corregir la configuración.»; (3) `POST /conversations/:id/ai-draft` → `source: "rules"` y fila `guest_message_reply` con `model` NULL, `cost_eur` 0 y `error_message = model_forbidden`; (4) ninguna petición sale hacia el proveedor (la clave, aunque válida, no se usa). Lo mismo ocurre con `AI_MODEL_CLASSIFY` o `AI_MODEL_INSIGHTS` vetados: la lista negra se aplica a los tres roles.

### 4.10 Cierre del humo

1. Matar la instancia propia: `lsof -iTCP:3904 -sTCP:LISTEN` → `kill <pid>`; comprobar que `:3000` no se tocó.
2. Borrar (una persona, con `DELETE` explícito y acotado por `created_at` y `tool_name`) las filas de `ai_tool_calls` y `audit_events` de la propiedad de pruebas; nunca las de una propiedad real.
3. Comparar la tabla de precios de la consola del proveedor con `PRICING_TABLE` y actualizar `PRICING_TABLE_DATE` (`packages/ai-core/src/pricing.ts:9`) si cambió.
4. Anotar en `docs/audits/TANDA-L6A-AI-CORE-2026-09-18.md` §8 la fecha, los `usage` observados, si `output_config.format` fue aceptado y el alias de Haiku válido.
5. Retirar la clave de la shell (`unset ANTHROPIC_KEY AI_PROVIDER_API_KEY`).

## 5 · Operación diaria

- **Presupuesto de una propiedad**: leer `GET /ai-operations/property/settings?propertyId=…`, copiar `configurationJson` entero, añadir `monthlyBudgetEur` y enviar `POST /ai-operations/property/settings` (`ai.high_risk.confirm`) con `{ propertyId, configurationJson: { …todo lo leído…, "monthlyBudgetEur": 40 } }`: el cuerpo **sustituye** el JSON completo. `0` bloquea la IA de esa propiedad (403 `AI_BUDGET_EXCEEDED` en cada herramienta); el readiness muestra `budget` en `warn` («casi agotado») a partir del 80 % del presupuesto y en `error` («agotado») al alcanzarlo.
- **Rate limit**: `AI_RATE_LIMIT_PER_MINUTE` (por organización y por proceso del API); un `429` con `details.code = "AI_RATE_LIMITED"` y `retryAfterSeconds` indica que se agotó. Con varias réplicas el límite efectivo se multiplica.
- **Errores que verá el front** (todos con texto en español): `503` sin proveedor (`not_configured`, `provider_unsupported`, `tool_not_implemented`), `403` presupuesto / IA desactivada / permisos de confirmación (`AI_BUDGET_EXCEEDED`, `AI_TOOL_CONFIRM_FORBIDDEN`), `429` rate limit, `422` salida no válida o rechazo del modelo, `413` documento demasiado grande, `502`/`504` proveedor caído o timeout (tras 3 intentos en 429/5xx/red).
- **Prompts**: publicar una versión en `ai_prompt_versions` (rutas `/ai-operations/governance/prompts/*`) tarda hasta 60 s en aplicarse por proceso (caché de `promptFrom`).
- **Confirmaciones pendientes**: las escrituras de las 11 herramientas quedan en `ai_tool_calls.status = awaiting_confirmation` (y en `ai_human_review_items` si el riesgo es high/critical). La ruta `POST /ai/tool-calls/:id/confirm` la añade el orquestador (informe §5); hasta entonces solo el servicio `confirmToolCall` y la cola de revisión humana pueden decidir.
- **Qué no hacer**: documentos reales sin DPA/ZDR; la clave en `.env.example`, en un commit o en un log; `AI_PROVIDER=openai` (se ignora); modelos de la familia Fable/Mythos; reiniciar `:3000` para probar.
