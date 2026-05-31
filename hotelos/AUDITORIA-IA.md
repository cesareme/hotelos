# Auditoría del Módulo de Inteligencia Artificial — HotelOS

**Fecha:** 2026-05-21 · **Revisión:** tras remediación P0 + P1 + P2 (esta versión sustituye a la auditoría inicial).
**Alcance:** Todo lo etiquetado como "IA": `apps/api/src/modules/{ai,ai-operations,onboarding}`, `apps/api/src/lib/llm.ts`, `apps/ai-gateway`, `packages/{ai-tools,onboarding}`, pantallas `apps/admin-web/src/screens/aiOperations/*` + onboarding + copiloto de recepción, la zona "Operaciones de IA" del Sidebar.
**Método:** revisión de código + verificación en navegador/API. Para cada capacidad se indica el mecanismo real (LLM / visión / reglas / determinista) y la comprensibilidad para **recepcionista**, **director** y **propietario**.

---

## 0. Veredicto ejecutivo (actualizado)

La auditoría inicial concluía: *"no hay IA real (todo reglas/regex/simulación), no es comprensible para los tres perfiles, y la UI sobre-promete"*. **Eso se ha corregido en su mayor parte.**

Estado actual en una frase: **IA real y conectable, segura por defecto (apagada sin clave), comprensible en español y con revisión humana.**

- **IA real conectable:** existe una capa de proveedor LLM (`apps/api/src/lib/llm.ts`, texto **y** visión) configurable por entorno (`AI_PROVIDER` + `AI_PROVIDER_API_KEY`). **Cinco** funciones la usan de verdad: borrador de respuesta al huésped, copiloto de recepción, OCR de documentos, evaluaciones de gobernanza y asistente de mapping en el onboarding. Sin clave, todas **degradan con elegancia** (reglas / entrada manual / "no ejecutada"), por lo que la demo sigue funcionando.
- **Honestidad:** la UI distingua siempre **"✨ Generado por IA" vs "📋 Generado por reglas"**, las evaluaciones ya **no fabrican puntuaciones** (quedan "skipped" sin clave), y se eliminaron las fugas de desarrollo y los botones/pantallas muertos.
- **Comprensibilidad:** todo el módulo está **en español**, con una **vista de propietario** en lenguaje claro y la zona técnica **restringida por rol** (un recepcionista ya no aterriza en dashboards de ingeniería).
- **Sigue pendiente:** en la demo no hay clave puesta (por diseño), el catálogo de ~110 "tools" sigue siendo mayormente metadatos (solo un puñado está cableado), y el motor de onboarding sigue siendo determinista con el LLM solo como asistente (decisión correcta).

**Calificación de comprensibilidad:** Recepcionista 🟢 · Director 🟢 · Propietario 🟢 (antes: 🔴/🟠/🔴).

---

## 1. Qué cambió desde la auditoría inicial

| Hallazgo inicial | Estado ahora |
|---|---|
| No hay LLM/OCR en el producto | ✅ Capa LLM (texto + visión) real y configurable por env; 5 funciones la usan |
| `recordToolCall` es código muerto → telemetría a 0 | ✅ Se registra en cada función de IA; "Actividad de la IA" refleja datos reales |
| Evaluaciones = simulación por hash ("pass rate" falso) | ✅ Runner real (test suite + checks sobre salida real); sin clave → "skipped", sin números falsos |
| Check-in "por escaneo" sin OCR (el cliente teclea) | ✅ OCR por visión: botón "Escanear documento (IA)" en el alta prerellena los campos para revisión |
| Recepcionista: IA invisible (botón "AI Assistant" muerto) | ✅ **Copiloto de recepción** (borrador de respuesta con indicador IA/reglas) + botón muerto eliminado |
| Sin vista de propietario | ✅ **"La IA de tu hotel, en claro"** (lenguaje natural, decisiones, coste, qué hace/qué no) |
| Módulo en inglés (mercado español) | ✅ 5 pantallas + navegación + nombres de políticas traducidos a español |
| Fuga "SPRINT 51" en la UI; 3 superficies de config muertas | ✅ Fugas quitadas; placeholders (`AISettings`, `AISetupCenter`, `AISetupForm`) retirados del menú |
| Zona de IA abierta a todos los roles | ✅ Gating por permisos (`permissionsAny`) — oculta la zona técnica a recepción |
| Promesa vs realidad (UI dice "AI classifies") | ✅ Etiquetas honestas IA/reglas en todas las superficies |
| Onboarding (extracción/mapping) sin IA | ✅ LLM como **asistente** de mapping (baja confianza), con motor determinista intacto |

---

## 2. Cómo funciona ahora (mecanismo por capacidad)

| Capacidad | Estado | Mecanismo |
|---|---|---|
| **Capa de proveedor LLM** | 🟢 Real | `llm.ts`: `isLlmConfigured`, `llmComplete` (texto), `llmExtractDocument` (visión). Anthropic/OpenAI por env. Timeout + fallback. |
| **Borrador de respuesta al huésped** | 🟢 Real (con clave) | `createAiReplyDraft` → LLM si hay clave; si no, reglas. Marca `source: "ai" | "rules"` + `requiresHumanReview`. |
| **Copiloto de recepción (UI)** | 🟢 Real | `ReceptionCopilotScreen` (zona OPS): pega el mensaje del huésped → borrador editable con badge IA/reglas → enviar/copiar. La IA nunca envía sola. |
| **OCR de documento de identidad** | 🟢 Real (con clave-visión) | `llmExtractDocument` + `POST /ai/commands/scan-id-document` + botón en el alta. Sin clave → entrada manual. |
| **Evaluaciones de gobernanza** | 🟢 Real | `runEvaluation`: corre el prompt contra una batería de casos y puntúa la salida real con checks deterministas; sin clave → "skipped" (sin puntuación falsa). |
| **Asistente de mapping (onboarding)** | 🟢 Real (asistente) | `POST /onboarding/ai/suggest-mapping`: el LLM propone un destino del catálogo canónico; el humano lo revisa y aprueba. El motor determinista sigue siendo la base. |
| **Telemetría de IA** | 🟢 Real | `recordToolCall` se invoca en cada función → "Actividad de la IA" + "Coste" reales. |
| **Gobernanza / políticas / HITL / coste** | 🟢 Real | Control-plane con persistencia Prisma; nombres de políticas en español. |
| **Onboarding extracción/clasificación** | 🟡 Determinista | Reglas + alias + Levenshtein (correcto y explicable). El LLM solo asiste el mapping. |
| **Catálogo de ~110 "tools"** | 🟡 Metadatos | Solo un puñado cableado (reply, OCR, mapping suggest, eval). El resto siguen siendo descriptores. |
| **Intent parser (comandos)** | 🟡 Reglas | Regex; no convertido a LLM (menor prioridad). |
| **ai-gateway "modo real"** | 🟡 Determinista | Ejecuta el motor determinista; las funciones LLM viven en el API. |

---

## 3. Configuración — cómo se enciende

1. **Proveedor de IA (env):** define `AI_PROVIDER` (`anthropic` | `openai`) y `AI_PROVIDER_API_KEY`. Para el OCR, usa un modelo con **visión**. Opcional `AI_PROVIDER_MODEL`, `AI_REQUEST_TIMEOUT_MS`. Sin estas variables, todo degrada con elegancia.
2. **Por propiedad** (`PropertyAiScreen` → "Configuración de IA de la propiedad"): interruptor principal, nivel de automatización (`off` / `sugerir` / `sugerir y confirmar` (recomendado) / `autónomo`), aviso de IA al huésped (requisito legal), idiomas de voz.
3. **Por herramienta** (`AiToolRegistryScreen` → "Catálogo de herramientas de IA"): activar/desactivar cada herramienta, su nivel y el rol que aprueba; las críticas no pueden ser autónomas sin aprobador.
4. **Gobernanza** (`AiGovernanceScreen`): políticas (umbral HITL por confianza 0.85), prompts versionados, evaluaciones, incidencias, coste.
5. **Acceso:** la zona "Operaciones de IA" requiere un permiso de IA o de propietario (`ai.configure`, `ai_governance.read/configure`, `ai_tool_registry.manage`, `ai_prompts.manage`, `ai_incidents.read`, `owner.dashboard.read`); recepción no la ve. El **copiloto de recepción** vive en la zona OPS (sí visible para recepción).

---

## 4. Comprensibilidad por perfil (actualizado)

### 4.1 Recepcionista — 🟢
Tiene una superficie de IA propia y útil: el **Copiloto de recepción** (zona OPS), en español claro, con la garantía *"la IA nunca envía nada sola"* y el indicador honesto **IA/reglas**. El **OCR** ("Escanear documento (IA)") le ahorra teclear el DNI. No se topa con dashboards de ingeniería (gateados por rol).

### 4.2 Director de hotel — 🟢 (antes 🟠)
Las pantallas de Gobernanza / Actividad / Revisión humana / Coste están **en español** y con jerga sustituida (telemetría→"actividad de la IA", pass rate→"tasa de aprobación", HITL→"revisión humana" explicada). Puede ver decisiones, coste, políticas (con nombres en español) y por qué una evaluación quedó "skipped". Quedan editores de JSON crudo para configuración avanzada (aceptable para un perfil de gestión técnica).

### 4.3 Propietario — 🟢 (antes 🔴)
Existe **"La IA de tu hotel, en claro"** (`AiOwnerSummaryScreen`): qué hace la IA en lenguaje natural, controles de seguridad (revisión humana, aviso al huésped), decisiones (pendientes/aprobadas/rechazadas), coste estimado y un bloque honesto **"qué hace y qué NO hace"**. Sin JSON ni latencias.

---

## 5. Lo que queda (honesto)

- **Demo sin clave:** por diseño no hay `AI_PROVIDER_API_KEY` puesta, así que la demo en vivo muestra los caminos de fallback (reglas / manual / "skipped"). Con clave válida, las cinco funciones operan con modelo real (vías verificadas end-to-end con clave de prueba → llamada real al proveedor).
- **Catálogo de tools:** ~110 descriptores; solo un subconjunto está cableado a ejecución real. Falta cablear el resto (o reducir el catálogo a lo real).
- **Onboarding:** el motor sigue siendo determinista (correcto); el LLM solo asiste el mapping de baja confianza. Falta (opcional) extracción/clasificación asistida por LLM.
- **Intent parser / chat general:** sigue por reglas (regex); no hay aún un asistente conversacional general.
- **Evaluaciones:** suite de pruebas real solo para `guest_message_reply`; ampliar a más prompts.
- **i18n de datos:** nombres de políticas traducidos; los `promptCode` y el JSON de configuración se mantienen como identificadores/datos (correcto).

---

## 6. Scorecard (actualizado)

| Dimensión | Antes | Ahora |
|---|---|---|
| ¿Hay IA real? | 🔴 No | 🟢 Sí, conectable (5 funciones), segura por defecto |
| Telemetría real | 🔴 Código muerto | 🟢 Registrada en cada función |
| Evaluaciones honestas | 🔴 Simulación falsa | 🟢 Reales / "skipped" sin clave |
| Honestidad UI (IA vs reglas) | 🔴 Sobre-promete | 🟢 Indicador IA/reglas en todas |
| Comprensible — recepcionista | 🔴 | 🟢 Copiloto + OCR |
| Comprensible — director | 🟠 | 🟢 Español + sin jerga |
| Comprensible — propietario | 🔴 | 🟢 Vista de propietario |
| Idioma (mercado español) | 🔴 Inglés | 🟢 Español |
| Control de acceso a la zona IA | 🔴 Abierta | 🟢 Gateada por rol |
| Limpieza (fugas/placeholders) | 🔴 | 🟢 Eliminados |
| Onboarding (migración) | 🟢 Real determinista | 🟢 + asistente LLM |
| Control plane (gobernanza/HITL) | 🟢 Real | 🟢 Real (en español) |

**Resumen:** el módulo de IA pasa de *"AI-native = marketing"* a **IA real conectable, honesta, en español y con revisión humana**. La arquitectura de gobernanza/HITL y el pipeline de migración (que ya eran sólidos) ahora conviven con funciones de IA que se encienden con una clave de proveedor y degradan con elegancia sin ella. Lo que resta es **amplitud** (cablear más tools, más suites de evaluación, extracción asistida en onboarding) y **activación** (poner la clave del proveedor en cada entorno).
