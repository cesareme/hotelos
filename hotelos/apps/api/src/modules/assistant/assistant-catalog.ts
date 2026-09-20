// Catálogo unificado de herramientas del asistente ehotelOS (Tanda L6b · L6b-02).
//
// Una sola lista `ASSISTANT_CATALOG` con las tres procedencias que hoy conviven:
//   · origin "assistant" (12, kind "local"): ASSISTANT_TOOLS de assistant.tools.ts (lecturas Prisma
//     con `source`; 3 presets CHK incluidos). `run(ctx)` ejecuta la lectura.
//   · origin "copilot"   (10, kind "local"): los resolvers del copiloto de recepción
//     (COPILOT_RESOLVERS, copilot.service.ts) como herramientas `copilot_<intent>`; sus keywords son
//     las INTENT_KEYWORDS del copiloto más sinónimos de los presets. `run(ctx)` envuelve el resolver
//     con un DegradedCollector (misma semántica que answerCopilot: `degraded[]` en la respuesta).
//   · origin "registry"  (15, kind "registry"): las lecturas del registro @hotelos/ai-tools con
//     `execute` (AI_READ_TOOL_NAMES, ai-operations/tools/index.ts). Sin `run`: las ejecuta el
//     núcleo conversacional (L6b-05) por `runAiTool` (puertas, HITL, presupuesto y telemetría del
//     runner); aquí solo se describen para el router y para el modelo (modelInputSchema).
//
// RBAC y superficie: `catalogFor({ permissions, surface })` devuelve lo que ESE usuario puede ver en
// ESA superficie (backoffice · reception · guest). Los permisos de las herramientas locales son
// claves existentes de packages/shared/src/permissions.ts (lectura del dominio consultado); los de
// las del registro son los de su definición (incluyen ai.tool.execute). El modelo, cuando lo haya,
// solo recibe el catálogo ya filtrado: una herramienta que no está no se puede invocar.
//
// Honestidad: nada de este catálogo escribe. Las escrituras del registro (assignRoom, checkIn…) no
// figuran: siguen el flujo awaiting_confirmation del tool runner fuera del asistente.

import type { JsonSchema } from "@hotelos/ai-core";
import { getToolDefinition, type HotelOsToolName } from "@hotelos/ai-tools";
import type { PermissionKey } from "@hotelos/shared";
import { createDegradedCollector } from "../../lib/degraded.js";
import { AI_READ_TOOL_NAMES, AI_TOOL_IMPLEMENTATIONS } from "../ai-operations/tools/index.js";
import { COPILOT_RESOLVERS, INTENT_KEYWORDS, type CopilotResolvedIntent } from "../copilot/copilot.service.js";
import { ASSISTANT_TOOLS, type ToolResult } from "./assistant.tools.js";

export type AssistantSurface = "backoffice" | "reception" | "guest";
export const ASSISTANT_SURFACES: readonly AssistantSurface[] = Object.freeze(["backoffice", "reception", "guest"]);

export type AssistantToolKind = "local" | "registry";
export type AssistantToolOrigin = "assistant" | "copilot" | "registry";

/**
 * Contexto mínimo para ejecutar una herramienta local (sin UserContext: RBAC ya filtró el catálogo).
 * `logScope`: prefijo del aviso de degradación (`[<scope>] <consulta> failed → degraded fallback`);
 * por defecto `assistant.copilot`, y `copilot.ask` cuando el turno viene del alias /copilot/ask
 * (contrato L2-06: /copilot/ask nombra en su propio log la consulta que falló).
 */
export type AssistantRunContext = { organizationId: string; propertyId: string; correlationId?: string; logScope?: string };

export type AssistantTool = {
  /** Único en el catálogo: `get_*` (assistant), `copilot_<intent>` (copiloto) o el nombre del registro. */
  name: string;
  description: string;
  /** Palabras clave en español para el router por reglas (semántica de keywordMatchesQuestion). */
  keywords: string[];
  /** Claves existentes de PERMISSIONS; todas necesarias. */
  requiredPermissions: PermissionKey[];
  surfaces: AssistantSurface[];
  /** JSON Schema de la entrada que ve el modelo (herramientas sin parámetros → objeto vacío). */
  modelInputSchema: JsonSchema;
  /** "local" ejecuta aquí con `run`; "registry" la ejecuta el runner (runAiTool). */
  kind: AssistantToolKind;
  origin: AssistantToolOrigin;
  /** Intención del copiloto (solo origin "copilot"). */
  intent?: CopilotResolvedIntent;
  /** Nombre canónico del registro (solo origin "registry"). */
  registryName?: HotelOsToolName;
  /** Lectura acotada al día de la propiedad: el router la descarta si la pregunta nombra otra fecha. */
  todayScoped: boolean;
  run?: (ctx: AssistantRunContext) => Promise<ToolResult>;
};

const NO_INPUT_SCHEMA: JsonSchema = Object.freeze({ type: "object", additionalProperties: false, properties: {} }) as JsonSchema;
const STAFF_SURFACES: readonly AssistantSurface[] = Object.freeze(["backoffice", "reception"]);

// ---------------------------------------------------------------------------
// origin "assistant": permisos por herramienta (lectura del dominio consultado)
// ---------------------------------------------------------------------------

const LOCAL_TOOL_SPECS: Readonly<Record<string, { requiredPermissions: PermissionKey[]; todayScoped?: boolean }>> = {
  get_arrivals_today: { requiredPermissions: ["pms.reservation.read"] },
  get_departures_today: { requiredPermissions: ["pms.reservation.read"] },
  get_in_house_guests: { requiredPermissions: ["pms.reservation.read"] },
  get_occupancy_today: { requiredPermissions: ["pms.reservation.read"] },
  get_recent_revenue_snapshot: { requiredPermissions: ["revenue.read"] },
  get_pickup_7d: { requiredPermissions: ["pms.reservation.read"] },
  get_open_balance: { requiredPermissions: ["folio.read"] },
  get_housekeeping_status: { requiredPermissions: ["housekeeping.read"] },
  get_compliance_summary: { requiredPermissions: ["compliance.read"] },
  // Presets CHK: llegadas de hoy sin habitación (reservas), pre-check-ins (reservas), listas para entregar (pisos).
  get_arrivals_without_room: { requiredPermissions: ["pms.reservation.read"], todayScoped: true },
  get_incomplete_precheckins: { requiredPermissions: ["pms.reservation.read"] },
  get_rooms_ready_for_delivery: { requiredPermissions: ["housekeeping.read"] }
};

function buildLocalTools(): AssistantTool[] {
  return ASSISTANT_TOOLS.map((tool) => {
    const spec = LOCAL_TOOL_SPECS[tool.name];
    if (!spec) throw new Error(`assistant-catalog: la herramienta ${tool.name} de ASSISTANT_TOOLS no tiene permisos declarados en LOCAL_TOOL_SPECS.`);
    return {
      name: tool.name,
      description: tool.description,
      keywords: [...tool.keywords],
      requiredPermissions: [...spec.requiredPermissions],
      surfaces: [...STAFF_SURFACES],
      modelInputSchema: NO_INPUT_SCHEMA,
      kind: "local",
      origin: "assistant",
      todayScoped: spec.todayScoped ?? tool.name.endsWith("_today"),
      run: (ctx) => tool.run({ organizationId: ctx.organizationId, propertyId: ctx.propertyId })
    } satisfies AssistantTool;
  });
}

// ---------------------------------------------------------------------------
// origin "copilot": los 10 intents como herramientas copilot_<intent>
// ---------------------------------------------------------------------------

export function copilotToolName(intent: CopilotResolvedIntent): string {
  return `copilot_${intent}`;
}

type CopilotToolSpec = { description: string; extraKeywords: string[]; requiredPermissions: PermissionKey[]; todayScoped: boolean };

const COPILOT_TOOL_SPECS: Readonly<Record<CopilotResolvedIntent, CopilotToolSpec>> = {
  arrivals_no_clean_room: {
    description: "Llegadas de hoy con habitación asignada que todavía no está limpia, con el estado de pisos de cada una.",
    extraKeywords: ["habitación sin limpiar", "habitacion sin limpiar", "llegadas sin habitación lista", "llegadas sin habitacion lista"],
    requiredPermissions: ["pms.reservation.read", "housekeeping.read"],
    todayScoped: true
  },
  arrivals_pending_balance: {
    description: "Llegadas de hoy con saldo pendiente en el folio (para cobrar antes del check-in).",
    extraKeywords: ["llegan con saldo", "llegadas con saldo", "llegan hoy con saldo"],
    requiredPermissions: ["pms.reservation.read", "folio.read"],
    todayScoped: true
  },
  rooms_ready_for_delivery: {
    description: "Habitaciones que se pueden entregar ahora mismo (limpias o inspeccionadas y libres), agrupadas por tipo, con acceso al Room Rack.",
    extraKeywords: ["puedo entregar", "habitaciones entregables"],
    requiredPermissions: ["housekeeping.read"],
    todayScoped: false
  },
  reservations_at_risk: {
    description: "Reservas en riesgo ahora: posibles no-show (llegada de hoy sin check-in pasadas las 19:00) y late check-out sin cerrar.",
    extraKeywords: ["reservas en riesgo", "riesgo de problema", "no-show", "no show"],
    requiredPermissions: ["pms.reservation.read"],
    todayScoped: true
  },
  shift_summary: {
    description: "Resumen del turno: llegadas, salidas, alojados ahora, cancelaciones, no-shows e ingresos del día.",
    extraKeywords: ["resumen del turno", "turno actual", "resumen del dia"],
    requiredPermissions: ["pms.reservation.read", "folio.read"],
    todayScoped: true
  },
  late_checkouts: {
    description: "Huéspedes con salida hoy que todavía no han hecho check-out (late check-out).",
    extraKeywords: ["late check-out", "late check-outs", "late checkouts", "salida tardia"],
    requiredPermissions: ["pms.reservation.read"],
    todayScoped: true
  },
  rooms_blocked: {
    description: "Habitaciones bloqueadas o fuera de servicio y el motivo (avería abierta o bloqueo manual).",
    extraKeywords: ["habitaciones bloqueadas", "out of order"],
    requiredPermissions: ["housekeeping.read", "maintenance.read"],
    todayScoped: false
  },
  vips_arriving: {
    description: "Huéspedes VIP (código VIP o nivel de fidelización alto) con llegada prevista hoy.",
    extraKeywords: ["vips hoy", "vip llega", "vips llegan"],
    requiredPermissions: ["pms.reservation.read", "guests.read"],
    todayScoped: true
  },
  open_incidents: {
    description: "Partes de mantenimiento abiertos o en curso, con habitación y prioridad.",
    extraKeywords: ["incidencias abiertas", "partes abiertos", "averias abiertas", "avería abierta", "averia abierta"],
    requiredPermissions: ["maintenance.read"],
    todayScoped: false
  },
  overdue_hk_tasks: {
    description: "Tareas de pisos pendientes desde hace más de dos horas (retrasadas), por habitación.",
    extraKeywords: ["tareas de housekeeping", "tareas hk"],
    requiredPermissions: ["housekeeping.read"],
    todayScoped: false
  }
};

export const COPILOT_RESOLVED_INTENTS: readonly CopilotResolvedIntent[] = Object.freeze(Object.keys(COPILOT_RESOLVERS) as CopilotResolvedIntent[]);

function buildCopilotTools(): AssistantTool[] {
  return COPILOT_RESOLVED_INTENTS.map((intent) => {
    const spec = COPILOT_TOOL_SPECS[intent];
    const resolver = COPILOT_RESOLVERS[intent];
    return {
      name: copilotToolName(intent),
      description: spec.description,
      keywords: Array.from(new Set([...INTENT_KEYWORDS[intent], ...spec.extraKeywords])),
      requiredPermissions: [...spec.requiredPermissions],
      surfaces: [...STAFF_SURFACES],
      modelInputSchema: NO_INPUT_SCHEMA,
      kind: "local",
      origin: "copilot",
      intent,
      todayScoped: spec.todayScoped,
      run: async (ctx) => {
        const collector = createDegradedCollector(ctx.logScope ?? "assistant.copilot", { propertyId: ctx.propertyId, intent, correlationId: ctx.correlationId ?? null });
        const body = await resolver({ propertyId: ctx.propertyId, safe: collector.safe });
        return {
          ok: true,
          data: { intent, answer: body.answer, items: body.items, suggestions: body.suggestions, degraded: collector.degraded },
          source: `copilot:${body.source}`,
          generatedAt: body.generatedAt
        };
      }
    } satisfies AssistantTool;
  });
}

// ---------------------------------------------------------------------------
// origin "registry": lecturas con execute del registro (las ejecuta el runner)
// ---------------------------------------------------------------------------

type RegistryToolSpec = { keywords: string[]; surfaces: AssistantSurface[] };

// Superficies según el diseño CHK §5 (bot del huésped: su reserva, preguntas y precios; copiloto de
// recepción: identidad, parte de viajeros, asignación; back office: documentos y reputación).
const REGISTRY_TOOL_SPECS: Readonly<Partial<Record<HotelOsToolName, RegistryToolSpec>>> = {
  findReservation: { keywords: ["buscar reserva", "busca la reserva", "localizador", "código de reserva", "codigo de reserva", "número de reserva", "numero de reserva", "find reservation"], surfaces: ["backoffice", "reception", "guest"] },
  matchGuestToReservation: { keywords: ["qué reserva es", "que reserva es", "documento escaneado", "identificar huésped", "identificar huesped", "match guest"], surfaces: ["reception", "guest"] },
  validateRoomAssignment: { keywords: ["puedo asignar la habitación", "puedo asignar la habitacion", "validar asignación", "validar asignacion", "validate room"], surfaces: ["backoffice", "reception"] },
  quoteAvailability: { keywords: ["disponibilidad", "precio de la noche", "cuánto cuesta", "cuanto cuesta", "noche extra", "upgrade", "cotizar", "availability"], surfaces: ["backoffice", "reception", "guest"] },
  suggestRoomAssignment: { keywords: ["sugerir habitación", "sugerir habitacion", "qué habitación le doy", "que habitacion le doy", "mejor habitación para", "mejor habitacion para", "suggest room"], surfaces: ["backoffice", "reception"] },
  checkGuestRegisterCompleteness: { keywords: ["parte de viajeros incompleto", "faltan datos del parte", "datos del parte de viajeros", "completitud del parte"], surfaces: ["backoffice", "reception"] },
  validateSpainGuestRegister: { keywords: ["validar parte de viajeros", "validar el parte", "ses hospedajes", "parte de viajeros válido", "parte de viajeros valido"], surfaces: ["backoffice", "reception"] },
  getHousekeepingBoard: { keywords: ["tablero de pisos", "tablero de limpieza", "housekeeping board", "tareas abiertas de pisos", "estado por habitación", "estado por habitacion"], surfaces: ["backoffice", "reception"] },
  classifyOnboardingFile: { keywords: ["clasificar fichero", "fichero de onboarding", "qué tipo de fichero", "que tipo de fichero", "classify file"], surfaces: ["backoffice"] },
  analyzeReviewSentiment: { keywords: ["sentimiento de la reseña", "sentimiento de la resena", "analizar reseña", "analizar resena", "review sentiment"], surfaces: ["backoffice"] },
  classifyIncomingDocument: { keywords: ["clasificar documento", "qué tipo de documento", "que tipo de documento", "documento entrante", "classify document"], surfaces: ["backoffice"] },
  extractIncomingDocumentFields: { keywords: ["extraer campos del documento", "extraer datos de la factura", "extraer campos", "extract fields"], surfaces: ["backoffice"] },
  extractGuestIdentityFieldsTemporary: { keywords: ["escanear documento", "escanear dni", "escanear pasaporte", "leer el documento de identidad", "scan id"], surfaces: ["reception"] },
  draftReviewResponse: { keywords: ["responder a la reseña", "responder a la resena", "borrador de respuesta a la reseña", "borrador de respuesta a la resena", "draft review response"], surfaces: ["backoffice"] },
  answerGuestQuestion: { keywords: ["responder al huésped", "responder al huesped", "pregunta del huésped", "pregunta del huesped", "guest question"], surfaces: ["reception", "guest"] }
};

/** Lectura del registro sin ficha aquí: visible solo en back office y sin keywords (el modelo la elige por descripción). El test del catálogo la señala. */
const REGISTRY_DEFAULT_SPEC: RegistryToolSpec = { keywords: [], surfaces: ["backoffice"] };

function buildRegistryTools(): AssistantTool[] {
  return AI_READ_TOOL_NAMES.map((name) => {
    const impl = AI_TOOL_IMPLEMENTATIONS[name];
    const definition = getToolDefinition(name);
    const spec = REGISTRY_TOOL_SPECS[name] ?? REGISTRY_DEFAULT_SPEC;
    return {
      name,
      description: impl?.description ?? definition.description,
      keywords: [...spec.keywords],
      requiredPermissions: [...definition.requiredPermissions],
      surfaces: [...spec.surfaces],
      modelInputSchema: impl?.modelInputSchema ?? { type: "object" },
      kind: "registry",
      origin: "registry",
      registryName: name,
      todayScoped: false
    } satisfies AssistantTool;
  });
}

// ---------------------------------------------------------------------------
// Catálogo y filtro
// ---------------------------------------------------------------------------

function buildCatalog(): readonly AssistantTool[] {
  const tools = [...buildLocalTools(), ...buildCopilotTools(), ...buildRegistryTools()];
  const seen = new Set<string>();
  for (const tool of tools) {
    if (seen.has(tool.name)) throw new Error(`assistant-catalog: nombre de herramienta duplicado «${tool.name}».`);
    seen.add(tool.name);
  }
  return Object.freeze(tools);
}

/** Las 12 + 10 + 15 herramientas, sin filtrar. Para responder, usa siempre catalogFor. */
export const ASSISTANT_CATALOG: readonly AssistantTool[] = buildCatalog();

const CATALOG_BY_NAME: ReadonlyMap<string, AssistantTool> = new Map(ASSISTANT_CATALOG.map((tool) => [tool.name, tool]));

export function getAssistantTool(name: string): AssistantTool | null {
  return CATALOG_BY_NAME.get(name) ?? null;
}

/** Herramientas que ESE usuario puede ver en ESA superficie: todas sus claves concedidas y la superficie declarada. */
export function catalogFor(input: { permissions: readonly PermissionKey[]; surface: AssistantSurface }): AssistantTool[] {
  const granted = new Set<PermissionKey>(input.permissions);
  return ASSISTANT_CATALOG.filter((tool) => tool.surfaces.includes(input.surface) && tool.requiredPermissions.every((permission) => granted.has(permission)));
}

/** Descripción para el modelo (tools de ai-core): nombre, descripción e input_schema del catálogo ya filtrado. */
export function toModelTools(tools: readonly AssistantTool[]): Array<{ name: string; description: string; input_schema: JsonSchema }> {
  return tools.map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.modelInputSchema }));
}
