# Runbook · Asistente ehotelOS unificado (Tanda L6b · asistente de IA)

Fuente: diseño [`docs/design/AI-CORE.md`](../design/AI-CORE.md) (§5.3 tool use, §6 coste, §7 redacción de PII, §10 tool
runner, §14 telemetría, §16.11 y §17 decisiones), [`docs/design/CHECKIN-AUTOMATIZADO-IA.md`](../design/CHECKIN-AUTOMATIZADO-IA.md)
§5 (recepcionista IA: bot del huésped y copiloto) e informes `docs/audits/TANDA-L6A-AI-CORE-2026-09-18.md`,
`TANDA-CHK-CHECKIN-IA-2026-09-19.md` y `TANDA-L6B-ASISTENTE-2026-09-20.md`. Código: núcleo conversacional
`apps/api/src/modules/assistant/assistant-core.service.ts` (`runAssistantTurn`), catálogo `assistant-catalog.ts`
(`ASSISTANT_CATALOG`, `catalogFor`), router por reglas `assistant-router.ts` (`routeByRules`, `SUGGESTED_QUESTIONS`), prompts
`assistant-prompts.ts`, memoria `assistant-memory.service.ts`, fachada `assistant.service.ts` (`answerQuestion`) y las 12
lecturas locales `assistant.tools.ts`; rutas `apps/api/src/routes/assistant.routes.ts` (plugin Fastify, 6 rutas), manifiesto
`security/route-permissions.ts`, resolver de tenencia `assistantConversation` en `lib/tenancy.ts`; alias del copiloto
`modules/copilot/copilot.service.ts` (`answerCopilot`, `COPILOT_RESOLVERS`) y bot del huésped
`modules/checkin/guest-bot.service.ts` (`answerWithModelViaCore`, `classifyWithCore`); modelo `packages/database/prisma/schema.prisma`
(`AssistantConversation`, `AssistantMessage`), migración `packages/database/prisma/migrations/20260920170000_asistente_unificado/`,
cifrado `packages/database/src/crypto-fields.ts` (`PII_FIELDS.AssistantMessage`). Front: panel
`apps/admin-web/src/components/assistant/{AssistantPanel,AssistantThread}.tsx` + `assistant-context.ts` +
`assistant-panel-store.ts`, cliente `services/assistantApi.ts`, shell `layouts/BackOfficeLayout.tsx` (botón, menú compacto,
montaje del panel, superficie por categoría) y `components/CommandPalette.tsx` («Preguntar al asistente»), página
`screens/assistant/AssistantChatScreen.tsx` (`/asistente`), cola `screens/aiOperations/AiHumanReviewQueueScreen.tsx` +
`ai-review-labels.ts` (aprobar ejecuta) y pantallas honestas `AiOwnerSummaryScreen.tsx` / `AiPipelineStatusScreen.tsx` +
`ai-operations-labels.ts`. Rutas, cuerpos, permisos y códigos: `docs/api-contracts.md` «Asistente unificado (Tanda L6b · 2026-09-20)».

**Todos los datos de este documento son ficticios**: tenant de prueba `org_uxday` / `prop_uxday` («Hotel UXDAY (prueba)», seed
`db:seed:ux-day`, usuarios `recepcion|direccion|sistemas@uxday.test`, contraseña `uxday-demo` o `SEED_UXDAY_PASSWORD`),
`org_chk` / `prop_chk` para el bot del huésped (`db:seed:checkin`) y organizaciones `org_l2_l6b*` que la suite de integración
crea y destruye. Sobre los datos del cliente piloto el asistente solo lee; nunca se pega aquí un nombre de persona ni un
documento. Toda pregunta y respuesta persistida lleva marcadores `[NOMBRE_n]`, `[TEL_n]`, `[EMAIL_n]`, `[DOC_n]` en vez del dato.

Estado 2026-09-20: construido en el worktree del carril L6b (rama `tanda-l6b`, base `a069906` = main con CHK fusionado, BD
`hotelos_l6b`, API `:3933` · Vite `:5203`) en cuatro olas de lotes con ficheros exclusivos (L6b-01 modelo y migración · L6b-02
catálogo y router · L6b-03 cliente y componentes del panel · L6b-04 front honesto de IA · L6b-05 núcleo y memoria · L6b-06 rutas
y contratos · L6b-07 shell, ⌘K y `/asistente` · L6b-08 copiloto y bot sobre el núcleo · L6b-09 Pendientes IA ejecuta al aprobar ·
L6b-11 documentación). Sin proveedor de IA en el `.env` del carril (`AI_PROVIDER` ausente = `none`): todo lo descrito como «con
modelo» está cubierto por tests con `fetch` simulado y **no** por un humo con clave real (§12). Pendiente de fusión a `main` por
el orquestador (informe §6-§8).

## 1 · Configuración (`.env`) y qué pasa sin cada variable

El asistente no añade variables: usa las del núcleo de IA (`docs/runbooks/ai-core.md` §1) y el cifrado de la base de datos.

| Variable | Sin ella | Con ella |
|---|---|---|
| `AI_PROVIDER` (+ `AI_PROVIDER_API_KEY`, `AI_USD_EUR_RATE`) | `none`: cada turno se enruta por reglas (`routedBy: "rules"`, `mode: "deterministic"`), coste 0, nunca se simula un modelo; el bot del huésped clasifica por regex y responde con sus plantillas; el copiloto responde por reglas | `anthropic`: el turno llama a `getAiCore().complete` con `tools` (tool use, `AI_MODEL`, defecto `claude-sonnet-5`) y el bot clasifica con `classify` (`AI_MODEL_CLASSIFY`); sin `AI_USD_EUR_RATE` la IA no arranca (`budget_unavailable`) y todo sigue por reglas con aviso |
| `ENCRYPTION_KEY` | el API no arranca (cifrado obligatorio) | `assistant_messages.content` cifrado en reposo con el envelope `v1.` de `PII_FIELDS` |
| `AI_MONTHLY_BUDGET_EUR_DEFAULT` · `configurationJson.monthlyBudgetEur` · `AI_RATE_LIMIT_PER_MINUTE` | defectos 25 € y 60/min | las herramientas del registro que el modelo invoque pasan por las 8 puertas del runner (presupuesto → 403 `AI_BUDGET_EXCEEDED`; el núcleo cae a reglas con aviso); la llamada directa del turno al modelo solo pasa por el rate limit de ai-core (§12) |
| `HOTELOS_ALLOW_DEMO_AUTH` · `HOTELOS_DEMO_PERMISSION_UNION` · `RBAC_STRICT` | — | en el carril `HOTELOS_ALLOW_DEMO_AUTH=true`: una petición SIN `Authorization` cae al usuario de demo (`usr_123`) y escribe su memoria y telemetría en `org_123`; para probar RBAC y 401 reales arrancar la instancia con `HOTELOS_ALLOW_DEMO_AUTH=false HOTELOS_DEMO_PERMISSION_UNION=false RBAC_STRICT=true` (§11) |

Prompts: los códigos `assistant_backoffice`, `assistant_reception` y `assistant_guest` se leen con `getAiCore().promptFrom(código,
respaldo)`: si en `ai_prompt_versions` hay una versión PUBLICADA con ese código (gobernanza, `/ai-operations/governance/prompts/*`)
manda ella (caché de 60 s por proceso); si no, el texto de `assistant-prompts.ts`. Hoy ninguno tiene fila publicada. Las reglas
comunes de los tres prompts: español, breve, solo datos devueltos por herramientas, citar la herramienta, toda escritura es una
PROPUESTA pendiente de una persona, sin documentos/teléfonos/correos completos salvo que la pregunta lo exija.

## 2 · Superficies

Un solo núcleo (`runAssistantTurn({ context, surface, question, conversationId?, screen?, correlationId })`) y tres superficies
(`ASSISTANT_SURFACES`): cada una fija el prompt, el subconjunto del catálogo y las preguntas sugeridas; el RBAC lo fija el
`UserContext` real de la petición (nunca una superficie amplía permisos).

| Superficie | Quién la usa | Actor (`assistant_conversations.user_id`) | Prompt | Catálogo visible | Escrituras al modelo | Sugeridas |
|---|---|---|---|---|---|---|
| `backoffice` (defecto) | panel del shell en cualquier pantalla fuera de la categoría «Recepción», página `/asistente`, ⌘K, `POST /assistant/chat` sin `surface` | el usuario de la sesión | `assistant_backoffice` | 12 locales + 10 del copiloto + lecturas del registro marcadas `backoffice` (§3), filtradas por sus claves y los módulos activos | las 13 con implementación cuyo módulo está activo y cuyos permisos tiene (siempre `awaiting_confirmation`) | 6 del chat + 3 CHK + 10 presets del copiloto (19) |
| `reception` | panel en las pantallas de la categoría «Recepción» del árbol (`assistantSurfaceForScreen`: Reservas, Huéspedes, cobros…; «Mi día» vive en «Hoy» y usa `backoffice`), `surface: "reception"` explícita y el alias `POST /copilot/ask` | el usuario de la sesión; en el alias el actor sintético `system:checkin:copilot` con SOLO `COPILOT_READ_PERMISSIONS` (`pms.reservation.read`, `folio.read`, `housekeeping.read`, `maintenance.read`, `guests.read`) | `assistant_reception` | como `backoffice` más las lecturas del registro marcadas `reception`; el alias ve las 10 `copilot_<intent>` y las lecturas locales que cubren sus 5 claves (10 de las 12 `get_*`: todas salvo `get_recent_revenue_snapshot` y `get_compliance_summary`), ninguna del registro (sin `ai.tool.execute`) | igual que `backoffice` (el alias ninguna) | 10 presets del copiloto + 3 CHK + 6 del chat |
| `guest` | bot del huésped (`POST /guest-portal/chat`, webhook de WhatsApp) SOLO cuando hay proveedor: la respuesta con modelo es un turno del núcleo y la clasificación usa el prompt `assistant_guest` como `system` | `guest:<conversationId>` (la conversación de mensajería identifica al huésped) con SOLO `ai.tool.execute` | `assistant_guest` | `answerGuestQuestion` (sin `pms.reservation.read` no ve `findReservation`, `matchGuestToReservation` ni `quoteAvailability`: no puede consultar reservas ajenas) | ninguna | ninguna (el bot conserva su clasificador y sus plantillas; las escrituras del bot —late check-out, peticiones, upgrade— siguen su propio `runAiTool` → `awaiting_confirmation`) |

Contexto de pantalla (`screen`, `normalizeScreenContext`): `{ screenKey, url?, entity?: { type, id }, commands?: [ids ⌘K] }`, cada
valor recortado a 120 caracteres y como mucho 20 comandos; el panel lo construye con `buildScreenContext` (clave de pantalla, URL sin
query ni hash, entidad por id si la ruta es una ficha —reserva, huésped, folio, organización, propiedad, categoría—, ids de los
comandos de la página): nunca nombres ni parámetros de búsqueda. Se guarda en `screen_context_json` de la conversación y viaja al
modelo dentro del mensaje del usuario («Pantalla actual: … / Ruta: … / Entidad en pantalla: … / Comandos disponibles: …»), no en `system`.

## 3 · Catálogo y permisos

`ASSISTANT_CATALOG` = 37 herramientas de lectura con nombre único: 12 locales del chat (`get_*`, `origin: "assistant"`), 10 del
copiloto (`copilot_<intent>`, `origin: "copilot"`, envuelven `COPILOT_RESOLVERS`) y 15 lecturas con `execute` del registro
`@hotelos/ai-tools` (`origin: "registry"`, `AI_READ_TOOL_NAMES`). Las locales tienen `run` y las ejecuta el núcleo; las del registro
no: las ejecuta `runAiTool` (puertas, HITL, presupuesto y telemetría del runner). Nada del catálogo escribe.

| Herramienta | Origen | Claves necesarias (todas) | Acotada a hoy |
|---|---|---|---|
| `get_arrivals_today` · `get_departures_today` · `get_occupancy_today` · `get_arrivals_without_room` | assistant | `pms.reservation.read` | sí |
| `get_in_house_guests` · `get_pickup_7d` · `get_incomplete_precheckins` | assistant | `pms.reservation.read` | no |
| `get_recent_revenue_snapshot` | assistant | `revenue.read` | no |
| `get_open_balance` | assistant | `folio.read` | no |
| `get_housekeeping_status` · `get_rooms_ready_for_delivery` | assistant | `housekeeping.read` | no |
| `get_compliance_summary` | assistant | `compliance.read` | no |
| `copilot_arrivals_no_clean_room` | copilot | `pms.reservation.read` + `housekeeping.read` | sí |
| `copilot_arrivals_pending_balance` · `copilot_shift_summary` | copilot | `pms.reservation.read` + `folio.read` | sí |
| `copilot_reservations_at_risk` · `copilot_late_checkouts` | copilot | `pms.reservation.read` | sí |
| `copilot_vips_arriving` | copilot | `pms.reservation.read` + `guests.read` | sí |
| `copilot_rooms_ready_for_delivery` · `copilot_overdue_hk_tasks` | copilot | `housekeeping.read` | no |
| `copilot_rooms_blocked` | copilot | `housekeeping.read` + `maintenance.read` | no |
| `copilot_open_incidents` | copilot | `maintenance.read` | no |
| `findReservation` · `quoteAvailability` (backoffice · reception · guest) · `matchGuestToReservation` · `answerGuestQuestion` (reception · guest) · `validateRoomAssignment` · `suggestRoomAssignment` · `checkGuestRegisterCompleteness` · `validateSpainGuestRegister` · `getHousekeepingBoard` (backoffice · reception) · `extractGuestIdentityFieldsTemporary` (reception) · `classifyOnboardingFile` · `analyzeReviewSentiment` · `classifyIncomingDocument` · `extractIncomingDocumentFields` · `draftReviewResponse` (backoffice) | registry | las de su definición en `packages/ai-tools/src/registry.ts` (`ai.tool.execute` + la clave del dominio, AI-CORE §11) y su módulo activo | no |

Filtro en dos pasos: `catalogFor({ permissions, surface })` (todas las claves concedidas y la superficie declarada) y, en el núcleo y
en `GET /assistant/tools`, `visibleCatalogFor` añade `canExecuteToolForModules` para las del registro (módulos activos de la propiedad).
El modelo solo recibe el catálogo ya filtrado (`toModelTools`: nombre, descripción, `input_schema`); una herramienta que pida fuera de
él se deniega sin consultar el registro y se avisa en `notices`. Las **escrituras** no están en el catálogo: `writeToolsFor` ofrece al
modelo (solo `backoffice` y `reception`) las 13 escrituras con implementación —`assignRoom`, `blockRoomForMaintenance`,
`checkInReservation`, `createHousekeepingTask`, `createServiceRequest`, `createWorkOrder`, `markRoomClean`, `markRoomInspected`,
`prepareGuestRegisterRecord`, `proposeIncomingDocumentAction`, `queueSesHospedajesSubmission`, `resolveWorkOrder`, `sendGuestMessage`—
cuyo módulo está activo y cuyos permisos tiene el usuario; el runner las deja SIEMPRE `awaiting_confirmation` (`WRITE_ALWAYS_CONFIRMS`).

Preguntas sugeridas (`SUGGESTED_QUESTIONS`, 19 sin repetir): 6 del chat (`ASSISTANT_SUGGESTED_QUESTIONS`, las de `AssistantChatScreen`),
3 presets CHK (`CHECKIN_SUGGESTED_QUESTIONS`) y 10 presets del copiloto (`COPILOT_PRESET_QUESTIONS`); `suggestedQuestionsFor(surface,
tools)` solo devuelve las que responde una herramienta visible para ESE usuario (nunca se sugiere lo que no puede contestar). En el
tenant UXDAY, recepción y dirección ven 31 herramientas en `backoffice` (12 + 10 + 9 del registro) y las 19 sugeridas.

## 4 · Enrutado sin proveedor y con proveedor

**Sin proveedor** (`getAiCore().isConfigured()` false) `routeByRules(question, catálogoFiltrado)`: (1) cada herramienta puntúa con la
suma de longitudes normalizadas de sus keywords coincidentes (`keywordMatchesQuestion`: un token → subcadena; varios → todas las palabras
en cualquier orden); (2) si la pregunta nombra otra fecha (`mentionsAnotherDate`, corrector FIX-1) quedan fuera las lecturas acotadas a
hoy; (3) como mucho UNA herramienta del copiloto: la de `detectIntent` si puntuó, si no la mejor puntuada, y si `detectIntent` reconoce la
intención sin keyword (p. ej. «v.i.p») entra con puntuación mínima; (4) candidatas que compiten por las mismas palabras no genéricas se
resuelven por puntuación («¿qué saldo pendiente hay por cobrar?» → `get_open_balance`, no la llegada con saldo del copiloto); temas
distintos componen («llegadas y salidas de hoy» → dos herramientas). Las 19 sugeridas enrutan a exactamente una herramienta
(`assistant-router.test.mts`): cobertura 100 % sin proveedor. Sin herramienta enrutada la respuesta lista hasta 8 sugeridas de la
superficie. Las lecturas del registro con entrada obligatoria (`findReservation`, `quoteAvailability`…) responden «necesita datos
concretos: …» por reglas (el router no extrae parámetros; `BadRequestError` de `parseToolInput` capturado, sin fila en `ai_tool_calls`).
El «hoy» de las 12 locales es el de `Property.timezone` (`propertyToday`); los 10 resolvers del copiloto siguen calculándolo en UTC (§12).

**Con proveedor** `answerByModel`: `system` = prompt de la superficie; `messages` = los últimos 10 mensajes de la conversación
(`memoryToModelMessages`: solo `user`/`assistant`, contiguos fusionados, nunca empieza por `assistant`) + contexto de pantalla + pregunta;
`tools` = catálogo filtrado + escrituras de `writeToolsFor`, `toolChoice: "auto"`, `maxTokens` 700; bucle de hasta `MAX_MODEL_TURNS` = 3
turnos con `toolResultBlock` (cada `tool_result` recortado a 6 000 caracteres); si el modelo sigue pidiendo herramientas al agotar los
turnos se responde con lo obtenido. Respaldo por reglas CON aviso (`notices`, `routedBy: "rules"`) ante `AiError` (proveedor caído,
timeout, rechazo del modelo, salida truncada), `configured: false` o 403/429 del runner o de ai-core; el coste ya facturado se conserva en
`cost`. `mode` es honesto: `llm` SOLO si un modelo respondió de verdad (`deriveAssistantMode`), haya o no clave. Pregunta vacía → 400;
> 2 000 caracteres → 400 (`MAX_QUESTION_CHARS`).

## 5 · Memoria y PII

Tablas (migración `20260920170000_asistente_unificado`, aditiva y reversible: 2 `CREATE TABLE`, 2 índices, 1 FK, 0 enums, 0 columnas en
tablas existentes, 0 backfill): `assistant_conversations` (`organization_id`, `property_id`, `user_id`, `surface`, `title`,
`screen_context_json`, `status` open | archived, `last_message_at`; índice por organización + propiedad + usuario + último mensaje) y
`assistant_messages` (`conversation_id` FK `ON DELETE CASCADE`, `role` user | assistant | tool, `content`, `tool_calls_json`, `routed_by`
rules | model, `model`, `tokens_input`, `tokens_output`, `cost_eur` DECIMAL(12,6)). Contrato: `tests/assistant-schema-contract.test.mjs`
(localiza la migración por sufijo `_asistente_unificado`: sobrevive a un renumerado en la fusión).

- **Ámbito**: una conversación por usuario + propiedad + superficie; toda lectura, reapertura y borrado se acota a
  (`organizationId`, `propertyId`, `userId`); la de otro usuario de la MISMA propiedad, otra propiedad u otra organización es el mismo
  404 opaco «Conversación no encontrada.» aunque se conozca el id (resolver `assistantConversation`: solo resuelve filas del propio
  usuario y la propiedad de la FILA manda sobre la cabecera `x-property-id`). Título = primera pregunta recortada a 80 caracteres;
  ventana del modelo 10 mensajes; lista ≤ 50 (20 por defecto); detalle con los 200 mensajes más recientes.
- **Redacción (marcadores irreversibles) y su límite**: pregunta y respuesta se pasan por `redactForTelemetry` (marcadores `[NOMBRE_n]`,
  `[TEL_n]`, `[EMAIL_n]`, `[DOC_n]`, `[TARJETA_n]` sin mapa) ANTES de persistir en memoria y en `ai_tool_calls`; el turno devuelto al
  usuario conserva la pregunta original. El contexto que se reenvía al modelo en turnos posteriores también lleva marcadores. **Límite
  honesto (corrector L6b · REV-02 / L6B-REV-03)**: el redactor de `packages/ai-core/src/redaction.ts` reconoce documentos, teléfonos,
  correos, tarjetas y nombres con tratamiento («Sr./Sra./Don…») o fórmula de presentación («me llamo», «a nombre de»…), **no un nombre
  suelto** («¿Tiene reserva Nombre Apellido para hoy?» conserva el nombre). Por eso: (1) `title` va cifrado como `content` (abajo);
  (2) la fila `answerAnalyticsQuestion` guarda de la pregunta solo su huella (`input_json.questionChars` + `questionSha256`, 16 hex),
  nunca el texto; (3) `screen` solo admite ids seguros (`normalizeScreenContext`, misma regla `SAFE_ID` que el panel: la entidad se
  descarta si el id no es seguro, la `url` pierde `?`/`#` y los segmentos no seguros pasan a `_`). Lo que sí queda con el nombre en
  claro dentro del cifrado es `assistant_messages.content` (y el título): solo legible con `ENCRYPTION_KEY`.
- **Cifrado en reposo**: `PII_FIELDS.AssistantMessage = ["content"]` y `PII_FIELDS.AssistantConversation = ["title"]` (envelope `v1.`,
  sin `*_lookup_hash`: nunca se busca por igualdad de contenido ni de título; sin migración: cifra la extensión de Prisma y las filas
  anteriores en claro se leen tal cual hasta que se reescriben); `SELECT left(content, 3)` en `assistant_messages` y
  `SELECT left(title, 3)` en `assistant_conversations` (filas nuevas) devuelven `v1.`.
- **Retención**: política **90 días** desde `last_message_at` (decisión D5 del informe), aplicada por el scheduler del API
  (`server.ts` `[assistant.purge]`, bajo el líder `RUN_SCHEDULERS` + `scheduler_leases` como SES/VeriFactu; corrector L6B-REV-07):
  `purgeAssistantConversations({ retentionDays })` borra toda conversación con `last_message_at` anterior al límite (mensajes por la FK
  en cascada) cada `ASSISTANT_MEMORY_PURGE_INTERVAL_MS` (6 h); `ASSISTANT_MEMORY_RETENTION_DAYS` (defecto 90) fija el plazo y
  `ASSISTANT_MEMORY_PURGE_DISABLED=true` lo apaga. Las instancias de carril (`RUN_SCHEDULERS=false`) no purgan. El borrado manual sigue
  siendo por conversación (`DELETE /assistant/conversations/:id`, 204).
- **Supresión RGPD**: `gdpr.service.ts` `executeErasure` borra las conversaciones (y mensajes) de los actores `guest:<conversationId>`
  de las conversaciones de mensajería del interesado (`eraseAssistantConversationsOfUsers`; fila `AssistantConversation · deleted` en el
  resumen) y el dosier DSAR incluye ese hilo (`AssistantConversation` / `AssistantMessage`). Las conversaciones del PERSONAL que
  mencionan al huésped no se pueden localizar por sujeto (cifradas y redactadas): las agota la retención de 90 días.
- **Actores sintéticos**: el alias `/copilot/ask` corre con el `UserContext` REAL de la petición (`server.ts` pasa
  `request.userContext`; corrector L6B-REV-04): sus claves filtran el catálogo (sin `folio.read` no hay saldos ni resumen del turno) y
  la memoria es la conversación `reception` del usuario. El actor `system:checkin:copilot` solo se usa cuando el `propertyId` del cuerpo
  no es la propiedad activa del contexto (404 opaco de existencia). El bot del huésped mantiene una conversación por conversación de
  mensajería (`guest:<conversationId>`, solo con proveedor; sin proveedor no escribe nada en `assistant_*`); en esa superficie el
  `conversationId` de cualquier herramienta lo fija el actor, nunca el modelo (L6B-REV-12), y `knownGuestPii` se acota a la propiedad.

## 6 · Trazabilidad: citas, coste y fila `answerAnalyticsQuestion`

Cada `AssistantTurn` (v2, aditivo sobre v1) dice de dónde sale cada dato y quién respondió:

- `citations[]` = lecturas intentadas: `{ tool, source, ok, summary, aiToolCallId?, costEur? }` con `source` `prisma:…` /
  `copilot:<source>` (locales, `costEur: 0`) o `runner:<nombre>` con `aiToolCallId` (registro; su coste vive en la fila del runner);
  `toolCalls[]` es la vista v1 de lo mismo. Las propuestas pendientes van en `pendingToolCalls[]` (sin cita) y las denegaciones en `notices`.
- `routedBy` rules | model, `mode` deterministic | llm, `cost: { model, tokensInput, tokensOutput, eur }` (por reglas
  `{ null, 0, 0, 0 }`; con modelo el uso real y `eur: null` solo si hubo llamada sin tipo de cambio o modelo fuera de la tabla de
  precios), `conversationId`, `correlationId` (cabecera `x-correlation-id` si viaja; si no, `corr_*` nuevo), `generatedAt`.
- **Una fila `answerAnalyticsQuestion` por turno** en `ai_tool_calls` (`recordToolCall`): `status` succeeded, `automation_level`
  suggest, `user_id` del actor, `conversation_id` = `assistant_conversations.id` (sin FK: `RunnerContext.conversationId` deja de ser la
  conversación de mensajería), `input_json` `{ question, surface, conversationId, screen }` y `output_json` `{ routedBy, mode, toolCalls,
  citations, pendingToolCalls, notices, answerChars }` redactados, `latency_ms`; por reglas `model` NULL, `tokens_*` 0 y `cost_eur` 0
  (AI-CORE §6: sin llamada → 0); con modelo `model`, tokens y coste reales (NULL solo si hubo llamada sin coste calculable). Las
  herramientas del registro que el turno ejecute tienen ADEMÁS su propia fila del runner (`source: "chat"`, mismo `conversation_id`).
- El mensaje `assistant` de la memoria copia `routed_by`, `model`, tokens, `cost_eur` y las citas en `tool_calls_json`; `GET
  /assistant/conversations/:id` las devuelve por mensaje (`cost` solo en los del asistente).
- Front: badge «Por reglas» / «Modelo» (`routedByOf`: v2 `routedBy` manda; sin él, `mode` v1), lista «Fuentes» «herramienta · fuente ·
  coste» (`costLabel`: «sin coste» para 0/null, 4 decimales si hay), coste del turno; en «Actividad de la IA» (L6b-04) un `cost_eur`
  NULL se pinta «—» con título «hubo llamada sin tipo de cambio», nunca «0,00 €», y `skipped` es «omitida (sin modelo)».

SQL de apoyo (solo lectura, `psql "$DATABASE_URL"`; `created_at` se guarda en UTC):

```sql
SELECT created_at, organization_id, user_id, status, model, tokens_input, tokens_output, cost_eur, conversation_id,
       output_json->>'routedBy' AS routed_by, latency_ms
  FROM ai_tool_calls WHERE tool_name = 'answerAnalyticsQuestion' ORDER BY created_at DESC LIMIT 10;
SELECT c.id, c.surface, c.user_id, c.title, c.last_message_at, count(m.id) AS mensajes
  FROM assistant_conversations c LEFT JOIN assistant_messages m ON m.conversation_id = c.id
 WHERE c.organization_id = '<org>' GROUP BY c.id ORDER BY c.last_message_at DESC;
```

## 7 · HITL: pendientes y confirmación

- Toda escritura que el modelo invoque pasa por `runAiTool` → `awaiting_confirmation` (fila en `ai_tool_calls` con la entrada EJECUTABLE
  sin redactar —SEC-06 del runner— y, si el riesgo es high | critical, ítem `ai_tool_call` en `ai_human_review_items`); el turno la
  devuelve en `pendingToolCalls[]` `{ id, toolName, summary, riskLevel, createdAt, conversationId, correlationId, input }` con `input`
  REDACTADO. Sin proveedor el router por reglas solo enruta lecturas: el asistente no genera propuestas (sí el bot del huésped y
  `POST /ai/commands/*`).
- `GET /assistant/pending` (`ai.tool.execute`): filas `awaiting_confirmation` sin reclamar (`confirmed_by IS NULL`) de la propiedad activa
  cuyo `conversation_id` es una conversación del PROPIO usuario en esa propiedad (≤ 100, más recientes primero, `input` redactado,
  `summary` = descripción en español de la implementación, `riskLevel` de la definición). Las propuestas nacidas fuera del asistente o
  desde una conversación ya borrada no aparecen (decisión D6; la vista completa de la propiedad sigue en `GET /ai/tool-calls`, que exige
  `audit.read`).
- Decisión: `POST /ai/tool-calls/:id/confirm { decision: approve | reject, notes? }` (`ai.tool.execute`): `confirmTool` re-evalúa las
  puertas y exige los `requiredPermissions` de la herramienta más `ai.high_risk.confirm` para high | critical (y `requiresApprovalRole`
  si la fila o el ajuste lo fijan); faltas → 403 `AI_TOOL_CONFIRM_FORBIDDEN { missing, requiresApprovalRole? }`; fila de más de 24 h →
  409 `AI_CONFIRMATION_EXPIRED` (se rechaza en el acto); propiedad ajena o fila ya decidida → 404 opaco; al aprobar se ejecuta con la
  entrada registrada (p. ej. `createWorkOrder` → `work_orders` +1, fila `succeeded` con `confirmed_by`) y desaparece de
  `GET /assistant/pending`. El panel y `/asistente` pintan cada pendiente como tarjeta con «Aprobar» / «Rechazar».
- Cola «Pendientes IA» (`/hoy/pendientes-ia`, L6b-09): los ítems `ai_tool_call` llevan el badge «Ejecuta al aprobar» y sus botones son
  «Aprobar y ejecutar» / «Rechazar», que llaman a la ruta de confirmación (no al `approve` de la cola, que solo cerraba la revisión y
  dejaba la fila pendiente: AI-CORE §16.15, decisión §17.16 aplicada); resultados «Ejecutada» · «Ejecución fallida» · «Rechazada» ·
  «Sin permiso» (403, nombra las claves que faltan) · «Caducada» (409) · «Ya no pendiente». El resto de ítems de la cola no cambia.

## 8 · Rutas y manifiesto

Manifiesto `security/route-permissions.ts`: 1 031 → **1 035** entradas (+4; `tools` y `chat` ya existían); `rbac:sync -- --dry-run`
sin claves nuevas. La propiedad activa es la del contexto (`:propertyId` → cabecera `x-property-id` → primera asignada); una cabecera
fuera de ámbito responde el 404 opaco «Propiedad no encontrada.» del hook de `server.ts` antes del handler.

| Método y ruta | Claves · riesgo | Qué hace |
|---|---|---|
| `GET /assistant/tools?surface=` | — · authenticated | `{ surface, items: [{ name, description, keywords, kind, origin, riskLevel }], suggestedQuestions }` visibles para el usuario; sin claves de lectura `items: []` (nunca 403); superficie desconocida 400 |
| `POST /assistant/chat` | — · authenticated | `{ question, conversationId?, surface?, screen? }` → `AssistantTurn` v2; 400 pregunta vacía / > 2 000 / superficie desconocida / `conversationId` no textual; 404 opaco con `conversationId` ajeno o inexistente |
| `GET /assistant/conversations?surface=&limit=` | — · authenticated | `{ items: [{ id, title, surface, status, lastMessageAt, createdAt, messageCount }] }` del usuario en la propiedad activa |
| `GET /assistant/conversations/:id` | — · authenticated | resumen + `screenContext` + `messages[]` (200 más recientes, `cost` en los del asistente); 404 opaco si no es del usuario |
| `DELETE /assistant/conversations/:id` | — · authenticated | 204; mensajes en cascada; 404 opaco si no es del usuario |
| `GET /assistant/pending` | `ai.tool.execute` · low | `{ items }` de escrituras pendientes de las conversaciones del usuario (§7) |
| `POST /ai/tool-calls/:id/confirm` | `ai.tool.execute` (+ `ai.high_risk.confirm` en high · critical) · high | decide una propuesta (§7; ruta de L6a) |
| `POST /copilot/ask` · `GET /copilot/presets` | authenticated (alias CHK) | `answerCopilot` delega en el núcleo con superficie `reception` y el `UserContext` real de la petición (claves y memoria del usuario; corrector L6B-REV-04 — el actor `system:checkin:copilot` solo si el `propertyId` pedido no es la propiedad activa); devuelve EXACTAMENTE `CopilotAnswer` `{ intent, question, answer, items, suggestions, generatedAt, source, degraded }` sin `mode` ni `model` (el cuerpo del resolver se captura con un `AsyncLocalStorage`); pregunta fuera de catálogo → `intent: "unknown"`, `source: "router"`; sin consumidor en admin-web ni móvil (solo tests) |
| `POST /guest-portal/chat` · `POST /webhooks/whatsapp` | token del huésped / HMAC (CHK) | bot del huésped; con proveedor, respuesta y clasificación sobre el núcleo (superficie `guest`) |

Contrato completo (cuerpos, códigos, tests): `docs/api-contracts.md` «Asistente unificado (Tanda L6b · 2026-09-20)». Cliente
`services/assistantApi.ts` (`askAssistant`, `listConversations`, `getConversation`, `deleteConversation`, `listPending`,
`confirmToolCall`, `fetchAssistantTools`; todo por `apiRequest`, tolerante al envelope `{ items }` o al array plano).

## 9 · Front: panel, ⌘K y página

- **Panel** (`AssistantPanel`, `CocoaDrawer` lateral derecho; en móvil desde abajo) montado UNA vez en `BackOfficeLayout`: se abre desde
  el botón de la barra («Asistente ehotelOS», `aria-haspopup="dialog"`, `data-tour="assistant"`), la fila del menú compacto del usuario,
  ⌘K o el evento `hotelos-open-assistant` (`openAssistantWith({ question?, surface? })`, store `assistant-panel-store.ts`). Contenido:
  conversaciones del usuario («Nueva», «Eliminar»), hilo (`AssistantThread`: pregunta como callout, respuesta como tarjeta con badge de
  enrutado, coste y «Fuentes», pendientes con Aprobar / Rechazar; una sola live region `role="log"`), compositor multiline (Enter envía,
  Mayús+Enter salta de línea), sugeridas de la superficie y etiqueta «Con el contexto de esta pantalla · Back office | Recepción»;
  «Abrir asistente completo» solo si `/asistente` está en el menú del usuario. Un 404 del historial o de los pendientes no bloquea el
  chat («Historial no disponible»). Cocoa solo: 0 `style=` en los cuatro ficheros.
- **⌘K** (`CommandPalette`): con texto en la caja, el ÚLTIMO ítem es «Preguntar al asistente: “…”» (grupo «Acciones», badge «IA»); sin
  coincidencias es el único y Enter lo envía; abre el panel con la pregunta pendiente. ⌘K sobre el panel abierto lo cierra (un overlay
  a la vez) y la paleta recupera el foco si otro overlay se lo roba (guardia `focusin`). Sin atajo nuevo (D10).
- **Página `/asistente`** (`AssistantChat`, fila 79 del CSV de navegación, categoría «Hoy», roles direccion · recepcion · pisos ·
  mantenimiento · revenue · finanzas · comercial · fnb · admin · administracion · auditoria): mismo hilo, conversaciones y catálogo
  de herramientas, superficie `backoffice`, 6 sugeridas del chat. Las filas 19 y 31 del CSV retiran `FrontDeskCopilotScreen` y
  `ReceptionCopilotScreen` a `AssistantChat` (redirecciones del árbol generado).
- **Pantallas de IA honestas** (L6b-04): «Informe IA del día» con el tile «Estado de la IA» «Encendida · Sin modelo» mientras el check
  `provider` no esté en `ok` y «En uso · N acciones en 30 días» solo con llamadas reales; «Actividad» con `skipped` = «omitida (sin
  modelo)», coste NULL = «—» y `callsTotal` derivado de `byTool[].calls`; readiness con los checks `provider` y `budget` en español.

## 10 · Puertas y comandos exactos

Desde el directorio raíz del monorepo (`<worktree>/hotelos/`); en esta shell solo existe `corepack pnpm`:

```
bash scripts/gates.sh --quick --json <fichero>                      # tras cada ola (NAV_TREE_CSV=/Users/cfernandez/anfitorio-demo/pilots/tanda5-nav-tree.csv)
bash scripts/gates.sh --json <fichero>                              # completa al final (+ build admin-web + integración)
corepack pnpm run typecheck:all
corepack pnpm --filter @hotelos/api test                            # unitarios: modules/assistant/__tests__/{assistant-catalog (8), assistant-core (12),
                                                                    #   assistant-memory (5), assistant-router (19), assistant-mode}.test.mts,
                                                                    #   routes/__tests__/assistant-routes (14), modules/copilot/__tests__/copilot-core (7),
                                                                    #   modules/checkin/__tests__/guest-bot (21), developer/__tests__/api-reference
corepack pnpm --filter @hotelos/admin-web test                      # components/__tests__/{assistant-panel (22), CommandPalette (18)},
                                                                    #   screens/aiOperations/__tests__/{ai-operations-labels (19), ai-review-labels (19)}
node --test tests/*.test.mjs                                        # contratos raíz: assistant-schema-contract (7: migración por sufijo, 2 tablas, 0 enums,
                                                                    #   PII, vocabularios), api-route-permissions-contract (1035), brand-contract, …
(cd apps/api && node --env-file-if-exists=../../.env --import tsx --test --test-concurrency=1 ../../tests/integration/l6b-asistente.test.mts)
                                                                    #   10 casos, organizaciones org_l2_l6b* creadas y destruidas, STRICT_ENV, modelo simulado
                                                                    #   (también l6a-integrador, l6a-tool-runner, l2-modulos-ia, guest-bot, checkin-flow siguen verdes)
corepack pnpm --filter @hotelos/database db:migrate:deploy && corepack pnpm --filter @hotelos/database db:generate && corepack pnpm --filter @hotelos/database db:drift:check
corepack pnpm --filter @hotelos/database db:migrate:status          # 25/25 en el carril («Database schema is up to date!»)
node scripts/check-migrations-vs-schema.mjs                         # +2 tablas
corepack pnpm --filter @hotelos/api rbac:sync -- --dry-run          # sin claves nuevas
node scripts/build-nav-tree.mjs --check --csv <CSV>                 # filas 19/31 retire → AssistantChat (regenerar el JSON en la fusión)
node scripts/cocoa-22-inventory.mjs && node scripts/cocoa-22-waves.mjs --write   # inventario Cocoa (docs/design/cocoa-22-inventory.json) tras fusionar
```

Instancia propia del carril: `PORT=3933 RUN_SCHEDULERS=false TENANT_BOOTSTRAP_SKIP=true node --env-file-if-exists=../../.env
--import tsx src/server.ts` desde `apps/api` (otro puerto libre —`:3943`, `:3947`…— si `:3933` está ocupado por otro lote); Vite
`--port 5203` con `VITE_API_URL=http://127.0.0.1:3933`; matar por PID al terminar, nunca `pkill -f`. Las cifras de las puertas del
cierre están en el informe de la tanda §3 y en `docs/audits/ESTADO-VERIFICADO.md` (bloque L6b).

## 11 · Comprobaciones en runtime (sin proveedor, instancia propia)

Medidas el 2026-09-20 sobre `hotelos_l6b` con una instancia `:3943` arrancada con `HOTELOS_ALLOW_DEMO_AUTH=false
HOTELOS_DEMO_PERMISSION_UNION=false RBAC_STRICT=true` y el tenant UXDAY (`scratchpad/L6b/l6b11-runtime.sh` / `.log`). Sesión:
`TOKEN=$(curl -sS -X POST "$API/auth/login" -H 'content-type: application/json' -d '{"email":"recepcion@uxday.test","password":"uxday-demo"}' | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).token')`
con `API=http://127.0.0.1:3943`; `H="Authorization: Bearer $TOKEN"`.

| # | Comprobación | Comando | Observado |
|---|---|---|---|
| 11.1 | Catálogo por RBAC y superficie | `curl -sS "$API/assistant/tools" -H "$H"` · `…?surface=reception` · `…?surface=foo` | recepción: `surface backoffice`, 31 ítems (12 assistant · 10 copilot · 9 registry), 19 sugeridas; `reception`: 31 ítems, la primera sugerida `copilot_shift_summary`; `foo` → 400. Dirección: 31 ítems, 19 sugeridas |
| 11.2 | Turno por reglas con contexto | `curl -sS -X POST "$API/assistant/chat" -H "$H" -H 'content-type: application/json' -H 'x-correlation-id: corr_prueba' -d '{"question":"¿Cuántas llegadas tengo hoy?","surface":"reception","screen":{"screenKey":"FrontDeskDashboard","url":"/hoy","commands":["reservas-nueva"]}}'` | `mode deterministic`, `routedBy rules`, `surface reception`, `conversationId` nuevo, `correlationId corr_prueba`, `citations [get_arrivals_today · prisma:Reservation.arrivalDate=today(Property.timezone) · ok · costEur 0]`, `cost { model null, 0, 0, eur 0 }`, `pendingToolCalls []`, `notices []` |
| 11.3 | Memoria por `conversationId` | segundo `POST` con `"conversationId":"<id>"` y «¿Qué habitaciones están listas para entregar?» | mismo `conversationId`, cita `get_rooms_ready_for_delivery`; `GET /assistant/conversations?surface=reception` → 1 conversación, título «¿Cuántas llegadas tengo hoy?», `messageCount` 6 tras tres turnos |
| 11.4 | Redacción en memoria | tercer `POST` con un nombre y un teléfono ficticios en la pregunta; `GET /assistant/conversations/<id>` | el turno devuelve la pregunta intacta; en el detalle el mensaje `user` dice «… Sr. [NOMBRE_1], teléfono [TEL_1]?», `screenContext` con `screenKey`, `url` y `commands`, `cost` del asistente `{ null, 0, 0, 0 }`; `SELECT left(content,3) FROM assistant_messages` → `v1.` |
| 11.5 | Privacidad en la misma propiedad | como `direccion@uxday.test`: `GET /assistant/conversations`, `GET /assistant/conversations/<id>`, `POST /assistant/chat` con ese `conversationId` | la lista no la incluye; detalle 404; chat 404 «Conversación no encontrada.» |
| 11.6 | Pendientes | `curl -sS "$API/assistant/pending" -H "$H"` | 200 `{ items: [] }` (recepción tiene `ai.tool.execute`; sin proveedor no hay propuestas del asistente) |
| 11.7 | Alias del copiloto | `curl -sS -X POST "$API/copilot/ask" -H "$H" -H 'content-type: application/json' -d '{"question":"Resume el turno actual"}'` | `intent shift_summary`, `source aggregated`, 6 ítems, claves exactamente `intent, question, answer, items, suggestions, generatedAt, source, degraded` (sin `mode`/`model`) |
| 11.8 | Borrado y 401 | `curl -sS -o /dev/null -w '%{http_code}' -X DELETE "$API/assistant/conversations/<id>" -H "$H"`; luego `GET` del mismo id; `GET /assistant/pending` sin cabecera | 204 → 404; 401 |
| 11.9 | Telemetría | SQL de §6 | una fila `answerAnalyticsQuestion` por turno: `succeeded`, `model` NULL, tokens 0, `cost_eur 0.000000`, `conversation_id` = la conversación, `output_json.routedBy` rules, `latency_ms` 8-19 ms; el alias añade su fila con `user_id system:checkin:copilot` y su propia conversación |
| 11.10 | Pregunta vacía | `-d '{"question":"   "}'` | 400 «La pregunta no puede estar vacía.» sin fila ni conversación |

Con `HOTELOS_ALLOW_DEMO_AUTH=true` (el `.env` del carril) las mismas peticiones SIN `Authorization` responden 200 como el usuario de
demo `usr_123` y dejan memoria y telemetría en `org_123`: comprobado por error en la primera pasada (la conversación se borró; las 5 filas
`answerAnalyticsQuestion` de `org_123` de las 11:02 UTC quedan, sin PII). Camino con modelo (tool use, propuesta → `pending` →
`confirm` ejecuta `createWorkOrder`): cubierto por `assistant-core.test.mts` y `tests/integration/l6b-asistente.test.mts` §5 con
`fetch` simulado; en runtime solo con clave real (§12).

## 12 · Límites honestos y lo que solo César puede aportar

Qué NO hace el asistente hoy:

- **Sin humo con clave real**: tool use, respaldo por reglas ante 403/429 del proveedor, coste real por turno, clasificación del bot y
  prompts publicados están cubiertos solo por tests con `fetch` simulado (`assistant-core`, `guest-bot`, `l6b-asistente`).
- **Presupuesto (corregido, L6B-REV-01)**: la llamada directa del turno al modelo (`getAiCore().complete`) y la clasificación del bot
  (`classify`) pasan ahora por la puerta de propiedad de `assistant-gate.ts` (`aiEnabled`, nivel de automatización de la herramienta
  del turno distinto de `off`, presupuesto mensual: las puertas 3/4/7 del runner con los mismos ports); cerrada → reglas con aviso y 0
  llamadas. Sigue sin haber humo real: solo tests con `fetch` simulado (`assistant-core.test.mts` L6B-REV-01, `guest-bot.test.mts`).
- **Purga de memoria (corregido, L6B-REV-07)**: scheduler `[assistant.purge]` y supresión RGPD de los hilos `guest:<id>` (§5); las
  conversaciones del personal que mencionan a un huésped solo las agota la retención.
- **Copiloto**: los 10 resolvers de `copilot.service.ts` calculan «hoy» en UTC (`startOfDayUtc`), las 12 locales en `Property.timezone`;
  el alias recibe ya el `UserContext` de la petición (L6B-REV-04): memoria y telemetría a nombre del usuario; el manifiesto sigue en
  `authenticated` (el RBAC lo aplica el catálogo: sin claves de lectura la respuesta es `unknown`, nunca 403); una pregunta que el router
  resuelva con una lectura ajena al copiloto responde `intent: "unknown"` con la respuesta del núcleo e `items: []`.
- **Bot del huésped**: la pregunta compuesta (datos del hotel + reserva + mensaje) puede superar los 2 000 caracteres del núcleo → 400
  capturado → respuesta por reglas; la memoria del núcleo duplica el hilo de `conversations`/`messages`; sin proveedor no escribe nada.
- **Router por reglas**: no extrae parámetros (localizador, fechas) de la pregunta; las lecturas del registro con entrada obligatoria
  responden «necesita datos concretos». `AiIntent`/`AiIntentName` de `packages/shared/src/types.ts` siguen sin consumidor (el núcleo
  usa `AssistantTurn`/`routedBy`).
- **Permisos**: `GET /assistant/pending` solo lista propuestas de las conversaciones propias (D6); la plantilla `general_manager` no
  incluye `maintenance.workorder.manage`, que `registry.ts` y `risk-matrix.ts` exigen para proponer y confirmar
  `blockRoomForMaintenance` (en UXDAY se concedió a mano al rol «Dirección general» de `org_uxday` para la verificación de L6b-09).
- **Front**: el e2e del panel (`apps/admin-web/e2e/assistant-panel.spec.ts`, añadido por un lote concurrente el 2026-09-20 a las 13:10 y
  no verificado aquí) no corre en las puertas: el `@playwright/test` del repo espera `chromium_headless_shell-1243`, no instalada (los
  recorridos de L6b-07/L6b-09 usaron la 1228 con `PW_EXE` desde `scratchpad/L6b/l6b07-shots.cjs` y `l6b09-ui.cjs`), y el contrato
  `tests/seed-ux-day-contract.test.mjs` enumera ya las 12 specs de recepción (incluida esta, puerta de la ola 4); las etiquetas
  `AI_ERROR_LABELS_ES` de ai-core no se mapean en admin-web (se muestra el `message` del `ApiError`, ya en español); el compositor del
  pie del `CocoaDrawer` no se estira y el badge «OK» de cada cita se recorta en pantallas estrechas (cosmético); `AssistantChatScreen`
  duplica ~110 líneas de estado del panel (extraer `useAssistantConversation`).
- **Escrituras del huésped** (`createServiceRequest`, `sendGuestMessage`) siguen en el flujo propio del bot; `sendGuestMessage` solo
  como `ai`. Ninguna escritura se ejecuta sin persona: `WRITE_ALWAYS_CONFIRMS` (decisión AI-CORE §17.5 aplicada: sin autonomía en L6b).

Lo que solo César puede aportar:

| # | Necesidad / decisión | Bloquea |
|---|---|---|
| N1 | Clave de organización (`AI_PROVIDER=anthropic`, `AI_PROVIDER_API_KEY`, `AI_MODEL`, `AI_USD_EUR_RATE`), DPA firmado, retención cero (ZDR), residencia (API directa vs Bedrock UE) y límite de gasto en la consola (AI-CORE §17.1-3) | Todo el camino «con modelo»: tool use del asistente, clasificación y respuesta del bot, humo real de §11 |
| N2 | Autonomía de escrituras: si alguna de bajo riesgo (`createHousekeepingTask`, `markRoomClean`) puede ejecutarse sin persona con `automationLevel = autonomous` y aprobador registrado (AI-CORE §17.5) | Hoy todo `awaiting_confirmation`; sin cambio de código nada se ejecuta solo |
| N3 | Retención de la memoria del asistente: confirmar 90 días o fijar otro plazo por hotel y encargar el job de purga (y la cobertura RGPD de `assistant_*`) | Purga automática; hoy SQL manual acotado (§5) |
| N4 | Presupuesto mensual por hotel para el asistente (25 € por defecto, `configurationJson.monthlyBudgetEur`) y si el turno debe consultarlo antes de llamar al modelo | Gasto real con clave |
| N5 | Publicar (o no) los prompts `assistant_backoffice` / `assistant_reception` / `assistant_guest` en gobernanza y el texto del aviso de IA al huésped por hotel (AI Act art. 50) | Con clave: tono y límites de cada superficie; hasta entonces el respaldo en código |
| N6 | Alcance de `GET /assistant/pending` (solo conversaciones propias, D6, o toda la propiedad para quien tenga `ai.tool.execute`) y de las escrituras expuestas al modelo (las 13 con implementación, D3, o el subconjunto por superficie de CHK §5) | Una línea en `assistant.routes.ts` / `writeToolsFor` |
| N7 | Retirar `/copilot/*` (alias sin consumidor) y `AiIntent`/`AiIntentName`, o conservarlos para la app móvil | Limpieza en L7 |
| N8 | Plantilla `general_manager` con `maintenance.workorder.manage` (o solo confirmar lo que mantenimiento propone) y los seeds UXDAY | Proponer/confirmar `blockRoomForMaintenance` desde dirección |
| N9 | Instalar el navegador de Playwright del repo (`npx playwright install`, descarga) para un e2e reproducible del panel | e2e del panel en las puertas |
