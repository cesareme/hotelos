// Prompts de sistema del asistente unificado (Tanda L6b · L6b-05). Puro: sin BD ni modelo.
//
// Un prompt por superficie (backoffice · reception · guest). El núcleo conversacional
// (assistant-core.service.ts) lo lee con `getAiCore().promptFrom(código, respaldo)`: si en
// ai_prompt_versions hay una versión PUBLICADA con ese código (gobernanza, L6a lote 4) manda
// ella; si no, el texto de aquí. Los códigos son `assistant_<surface>`.
//
// Reglas comunes a los tres prompts (AI-CORE §5.3 / CHK §5): el modelo solo conoce las
// herramientas que recibe en `tools` (catálogo ya filtrado por RBAC, superficie y módulos);
// nunca inventa datos que no haya devuelto una herramienta; toda escritura queda pendiente de
// una persona (el núcleo lo garantiza por runAiTool → awaiting_confirmation, y el prompt lo
// dice para que el modelo lo explique así). Español, breve, sin PII innecesaria.

import type { AssistantSurface } from "./assistant-catalog.js";

/** Código del prompt publicado (ai_prompt_versions.promptCode) por superficie. */
export const ASSISTANT_PROMPT_CODES: Readonly<Record<AssistantSurface, string>> = Object.freeze({
  backoffice: "assistant_backoffice",
  reception: "assistant_reception",
  guest: "assistant_guest"
});

const COMMON_RULES =
  "Reglas: (1) Responde SIEMPRE en español, de forma breve y concreta (máximo 6 frases o una lista corta). " +
  "(2) Usa únicamente los datos que devuelvan las herramientas disponibles; si ninguna herramienta responde a la pregunta, dilo y sugiere cómo reformularla. " +
  "(3) Nunca inventes cifras, nombres, reservas ni políticas. " +
  "(4) Cuando cites un dato, indica de qué herramienta procede. " +
  "(5) Toda acción que modifique datos (asignar habitación, hacer check-in, enviar mensajes, crear tareas o partes) queda como PROPUESTA pendiente de que una persona la confirme: nunca afirmes que se ha ejecutado. " +
  "(6) No repitas documentos de identidad, teléfonos ni correos completos en la respuesta salvo que la pregunta lo exija.";

/** Texto en código (respaldo) por superficie. */
export const ASSISTANT_SYSTEM_PROMPTS: Readonly<Record<AssistantSurface, string>> = Object.freeze({
  backoffice:
    "Eres el Asistente ehotelOS del back office de un hotel en España. Ayudas a dirección y administración con datos operativos y comerciales " +
    "de la propiedad activa (llegadas, salidas, ocupación, ingresos, pickup, saldos, pisos, cumplimiento, documentos y reputación). " +
    COMMON_RULES,
  reception:
    "Eres el copiloto de recepción de un hotel en España (Asistente ehotelOS). Ayudas al personal del mostrador en el turno actual: " +
    "llegadas y salidas de hoy, habitaciones listas para entregar, pre-check-ins, parte de viajeros, saldos pendientes, VIP, incidencias y tareas de pisos. " +
    "Prioriza lo accionable ahora mismo. " +
    COMMON_RULES,
  guest:
    "Eres el recepcionista virtual de un hotel en España (Asistente ehotelOS) y hablas con un huésped sobre SU reserva. " +
    "Responde con cortesía y en el idioma del huésped si lo reconoces; si no, en español. Solo puedes usar datos de su propia reserva y la información pública del hotel " +
    "(horarios, servicios, precios de tarifa): nunca datos de otros huéspedes ni descuentos. Cualquier petición (late check-out, servicios, cambios) se traslada a recepción, " +
    "que la confirmará. " +
    COMMON_RULES
});

export function promptCodeFor(surface: AssistantSurface): string {
  return ASSISTANT_PROMPT_CODES[surface];
}

export function fallbackPromptFor(surface: AssistantSurface): string {
  return ASSISTANT_SYSTEM_PROMPTS[surface];
}

/** Contexto de la pantalla desde la que se pregunta (espejo de AssistantScreenContext del panel): tipo e id, nunca nombres. */
export type AssistantScreenContext = {
  screenKey: string;
  url?: string;
  entity?: { type: string; id: string };
  /** Ids de los comandos ⌘K que ofrece la pantalla (sin etiquetas). */
  commands?: string[];
};

/** Longitud máxima de la ruta (`url`) del contexto. */
const SCREEN_URL_MAX = 120;
/** Comandos ⌘K máximos que viajan con el contexto. */
const SCREEN_COMMANDS_MAX = 20;
/** Segmento de ruta que ocupa el hueco de un id sin serlo (espejo de RESERVED_SEGMENTS del panel). */
const RESERVED_SEGMENTS: ReadonlySet<string> = new Set(["nueva", "nuevo", "new", "crear", "create", "editar", "edit", "lista", "list"]);
/** Segmento de ruta que no es un id seguro (un nombre, %20, texto libre) y se sustituye en `url`. */
export const UNSAFE_SEGMENT_PLACEHOLDER = "_";

/**
 * Id «seguro» (misma regla que components/assistant/assistant-context.ts SAFE_ID): alfanumérico con `_ . : -`,
 * ≤ 80 caracteres, sin espacios ni codificación (%20). Lo que descarta un nombre.
 */
export const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}$/;

/** Cadena que cumple SAFE_ID (recortada de espacios) o null. */
export function safeId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return SAFE_ID.test(text) ? text : null;
}

/**
 * Ruta segura (pura): sin origen, sin query string ni hash, con barra inicial; cada segmento debe ser un id seguro o
 * un segmento reservado («nueva», «lista»…), los demás se sustituyen por `_` (nunca un nombre ni texto libre).
 * Recortada a SCREEN_URL_MAX. Null si no queda nada.
 */
export function safeScreenUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  let path = value.trim();
  if (!path) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(path)) path = path.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i, "") || "/";
  const cut = path.search(/[?#]/);
  if (cut >= 0) path = path.slice(0, cut);
  const segments = path
    .split("/")
    .filter((segment) => segment.length > 0)
    .map((segment) => (SAFE_ID.test(segment) || RESERVED_SEGMENTS.has(segment.toLowerCase()) ? segment : UNSAFE_SEGMENT_PLACEHOLDER));
  const url = `/${segments.join("/")}`;
  return url.length > SCREEN_URL_MAX ? url.slice(0, SCREEN_URL_MAX) : url;
}

/**
 * Normaliza lo que llega del cliente (corrector L6b · REV-03: el núcleo aplica la misma regla que el panel, así que un
 * cliente distinto — curl, app móvil — tampoco puede meter nombres ni query strings en screen_context_json ni en la
 * telemetría): screenKey, entity.type, entity.id y commands solo si cumplen SAFE_ID (la entidad se descarta entera si
 * no), url = ruta sin `?`/`#` con los segmentos no seguros sustituidos. Null sin screenKey válida.
 */
export function normalizeScreenContext(value: unknown): AssistantScreenContext | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const screenKey = safeId(raw.screenKey);
  if (!screenKey) return null;
  const screen: AssistantScreenContext = { screenKey };
  const url = safeScreenUrl(raw.url);
  if (url) screen.url = url;
  const entity = raw.entity;
  if (entity && typeof entity === "object") {
    const type = safeId((entity as Record<string, unknown>).type);
    const id = safeId((entity as Record<string, unknown>).id);
    if (type && id) screen.entity = { type, id };
  }
  if (Array.isArray(raw.commands)) {
    const commands: string[] = [];
    for (const command of raw.commands) {
      const id = safeId(command);
      if (!id || commands.includes(id)) continue;
      commands.push(id);
      if (commands.length >= SCREEN_COMMANDS_MAX) break;
    }
    if (commands.length > 0) screen.commands = commands;
  }
  return screen;
}

/** Bloque de texto para el modelo con el contexto de pantalla (va en el mensaje del usuario, no en `system`). */
export function renderScreenContext(screen: AssistantScreenContext | null | undefined): string {
  if (!screen) return "";
  const lines = [`Pantalla actual: ${screen.screenKey}`];
  if (screen.url) lines.push(`Ruta: ${screen.url}`);
  if (screen.entity) lines.push(`Entidad en pantalla: ${screen.entity.type} ${screen.entity.id}`);
  if (screen.commands && screen.commands.length > 0) lines.push(`Comandos disponibles en la pantalla: ${screen.commands.join(", ")}`);
  return lines.join("\n");
}

/** Mensaje de usuario completo: contexto de pantalla (si lo hay) + pregunta. */
export function composeUserMessage(question: string, screen: AssistantScreenContext | null | undefined): string {
  const context = renderScreenContext(screen);
  return context ? `${context}\n\nPregunta: ${question}` : question;
}
