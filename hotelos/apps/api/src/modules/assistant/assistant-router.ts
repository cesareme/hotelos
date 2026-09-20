// Router por reglas del asistente unificado (Tanda L6b · L6b-02). Puro: sin BD ni modelo.
//
// routeByRules(question, tools) enruta SOBRE EL CATÁLOGO YA FILTRADO por RBAC y superficie
// (catalogFor): una herramienta que el usuario no puede ver nunca sale elegida. Reglas:
//   1. Keywords: cada herramienta puntúa con la suma de longitudes (normalizadas) de sus keywords
//      que coinciden (keywordMatchesQuestion: un token → subcadena; varios → todas las palabras,
//      en cualquier orden). Las frases largas y específicas pesan más que una palabra suelta.
//   2. Otra fecha: si la pregunta nombra otra fecha que hoy (mentionsAnotherDate), las lecturas
//      `todayScoped` (get_*_today, llegadas/VIP/turno del copiloto…) quedan fuera.
//   3. Copiloto: como mucho UNA herramienta del copiloto — la de detectIntent (su árbitro entre
//      intenciones) si puntuó; si no, la mejor puntuada; y si detectIntent reconoce la intención
//      pero ninguna keyword normalizada coincidió (p. ej. «v.i.p»), entra con puntuación mínima.
//   4. Conflictos: dos candidatas que compiten por las mismas palabras de la pregunta (excluidas las
//      genéricas: hoy, ahora, qué…) se resuelven por puntuación — «¿qué saldo pendiente hay por
//      cobrar?» es get_open_balance (saldo·pendiente·cobrar·por cobrar) y no la llegada con saldo del
//      copiloto (saldo pendiente); candidatas sobre palabras distintas COMPONEN («llegadas y salidas
//      de hoy» → dos herramientas), como el router histórico.
// Sin proveedor, las 19 preguntas sugeridas (6 del chat + 10 presets del copiloto + 3 CHK) enrutan a
// exactamente una herramienta (assistant-router.test.mts).

import { COPILOT_PRESET_QUESTIONS, detectIntent, type CopilotIntent } from "../copilot/copilot.service.js";
import { copilotToolName, type AssistantSurface, type AssistantTool } from "./assistant-catalog.js";
import { keywordMatchesQuestion, mentionsAnotherDate, normalizeForRouting } from "./assistant.tools.js";

export type RuleMatch = {
  tool: AssistantTool;
  /** Suma de longitudes normalizadas de las keywords coincidentes (1 = solo por detectIntent). */
  score: number;
  keywords: string[];
};

export type RouteByRulesResult = {
  routedBy: "rules";
  /** Herramientas elegidas, de mayor a menor puntuación (vacío = sin enrutar). */
  tools: AssistantTool[];
  /** Todas las candidatas tras las reglas 1-3 (incluidas las descartadas por conflicto), de mayor a menor. */
  candidates: RuleMatch[];
  intent: CopilotIntent;
  anotherDate: boolean;
};

/** Palabras que no identifican tema: no cuentan para decidir si dos candidatas compiten por las mismas palabras. */
const GENERIC_TOKENS: ReadonlySet<string> = new Set([
  "hoy", "ahora", "mismo", "ya", "de", "del", "la", "el", "los", "las", "un", "una", "unos", "unas", "que", "cual", "cuales",
  "cuantas", "cuantos", "quien", "quienes", "hay", "tengo", "tenemos", "tiene", "tienen", "con", "por", "para", "y", "o", "e",
  "en", "a", "al", "es", "son", "esta", "estan", "siguen", "sigue", "dame", "dime", "me", "mi", "se", "lo", "le", "les", "sus", "su"
]);

function tokensOf(text: string): string[] {
  return normalizeForRouting(text).split(" ").filter((token) => token.length > 0);
}

/** Palabras de la pregunta que cubre una keyword: sus tokens si tiene varios; si tiene uno, las palabras que lo contienen. */
function coveredTokens(keyword: string, questionTokens: readonly string[]): string[] {
  const kwTokens = tokensOf(keyword);
  if (kwTokens.length === 0) return [];
  if (kwTokens.length === 1) return questionTokens.filter((token) => token.includes(kwTokens[0]!));
  return kwTokens;
}

function isTodayScoped(tool: AssistantTool): boolean {
  return tool.todayScoped || tool.name.endsWith("_today");
}

function byScoreThenName(a: RuleMatch, b: RuleMatch): number {
  return b.score - a.score || a.tool.name.localeCompare(b.tool.name);
}

export function routeByRules(question: string, tools: readonly AssistantTool[]): RouteByRulesResult {
  const anotherDate = mentionsAnotherDate(question);
  const intent = detectIntent(question);
  const questionTokens = tokensOf(question);

  // 1 + 2 · keywords sobre las herramientas admisibles.
  const scored: RuleMatch[] = [];
  for (const tool of tools) {
    if (anotherDate && isTodayScoped(tool)) continue;
    const keywords = tool.keywords.filter((keyword) => keywordMatchesQuestion(keyword, question));
    if (keywords.length === 0) continue;
    scored.push({ tool, keywords, score: keywords.reduce((sum, keyword) => sum + normalizeForRouting(keyword).length, 0) });
  }

  // 3 · una sola herramienta del copiloto.
  const copilotMatches = scored.filter((match) => match.tool.origin === "copilot").sort(byScoreThenName);
  let copilotChoice: RuleMatch | null = copilotMatches.find((match) => match.tool.intent === intent) ?? copilotMatches[0] ?? null;
  if (!copilotChoice && intent !== "unknown") {
    const intentTool = tools.find((tool) => tool.name === copilotToolName(intent));
    if (intentTool && !(anotherDate && isTodayScoped(intentTool))) copilotChoice = { tool: intentTool, score: 1, keywords: [] };
  }
  const candidates = [...scored.filter((match) => match.tool.origin !== "copilot"), ...(copilotChoice ? [copilotChoice] : [])].sort(byScoreThenName);

  // 4 · conflictos por las mismas palabras: gana la puntuación; temas distintos componen.
  const taken = new Set<string>();
  const chosen: RuleMatch[] = [];
  for (const match of candidates) {
    const covered = new Set(match.keywords.flatMap((keyword) => coveredTokens(keyword, questionTokens)).filter((token) => !GENERIC_TOKENS.has(token)));
    const conflicts = Array.from(covered).some((token) => taken.has(token));
    if (conflicts) continue;
    for (const token of covered) taken.add(token);
    chosen.push(match);
  }

  return { routedBy: "rules", tools: chosen.map((match) => match.tool), candidates, intent, anotherDate };
}

// ---------------------------------------------------------------------------
// Preguntas sugeridas por superficie (cobertura 100 % por reglas)
// ---------------------------------------------------------------------------

export type SuggestedQuestion = {
  id: string;
  label: string;
  question: string;
  /** Herramienta del catálogo que responde por reglas (assistant-router.test.mts lo fija). */
  tool: string;
};

/** Las 6 de apps/admin-web/src/screens/assistant/AssistantChatScreen.tsx (SUGGESTED_QUESTIONS), con su herramienta. */
export const ASSISTANT_SUGGESTED_QUESTIONS: readonly SuggestedQuestion[] = Object.freeze([
  { id: "arrivals_today", label: "Llegadas de hoy", question: "¿Cuántas llegadas tengo hoy?", tool: "get_arrivals_today" },
  { id: "occupancy_today", label: "Ocupación", question: "¿Cuál es la ocupación ahora mismo?", tool: "get_occupancy_today" },
  { id: "pickup_7d", label: "Pickup 7 días", question: "Dame el pickup de los últimos 7 días", tool: "get_pickup_7d" },
  { id: "open_balance", label: "Saldo por cobrar", question: "¿Qué saldo pendiente hay por cobrar?", tool: "get_open_balance" },
  { id: "housekeeping_status", label: "Estado de pisos", question: "Estado de pisos hoy", tool: "get_housekeeping_status" },
  { id: "compliance_summary", label: "Cumplimiento", question: "Resumen de cumplimiento normativo", tool: "get_compliance_summary" }
]);

/** Los 3 presets CHK del copiloto de recepción (diseño CHECKIN-AUTOMATIZADO-IA §5). */
export const CHECKIN_SUGGESTED_QUESTIONS: readonly SuggestedQuestion[] = Object.freeze([
  { id: "arrivals_without_room", label: "Llegadas sin habitación", question: "¿Qué llegadas de hoy siguen sin habitación asignada?", tool: "get_arrivals_without_room" },
  { id: "incomplete_precheckins", label: "Pre-check-ins incompletos", question: "¿Qué pre-check-ins están incompletos?", tool: "get_incomplete_precheckins" },
  { id: "rooms_ready_for_delivery", label: "Listas para entregar", question: "¿Qué habitaciones están listas para entregar?", tool: "get_rooms_ready_for_delivery" }
]);

/** Los 10 presets del copiloto (COPILOT_PRESET_QUESTIONS), con su herramienta copilot_<intent>. */
export const COPILOT_SUGGESTED_QUESTIONS: readonly SuggestedQuestion[] = Object.freeze(
  COPILOT_PRESET_QUESTIONS.map((preset) => ({ id: `copilot_${preset.id}`, label: preset.label, question: preset.question, tool: `copilot_${preset.id}` }))
);

export const SUGGESTED_QUESTIONS: Readonly<Record<AssistantSurface, readonly SuggestedQuestion[]>> = Object.freeze({
  backoffice: [...ASSISTANT_SUGGESTED_QUESTIONS, ...CHECKIN_SUGGESTED_QUESTIONS, ...COPILOT_SUGGESTED_QUESTIONS],
  reception: [...COPILOT_SUGGESTED_QUESTIONS, ...CHECKIN_SUGGESTED_QUESTIONS, ...ASSISTANT_SUGGESTED_QUESTIONS],
  // El bot del huésped tiene su propia clasificación (guest-bot.service.ts); sin sugerencias de personal.
  guest: []
});

/** Las 19 (6 + 3 + 10), sin repetir. */
export const ALL_SUGGESTED_QUESTIONS: readonly SuggestedQuestion[] = Object.freeze([...ASSISTANT_SUGGESTED_QUESTIONS, ...CHECKIN_SUGGESTED_QUESTIONS, ...COPILOT_SUGGESTED_QUESTIONS]);

/** Sugerencias de la superficie cuya herramienta está en el catálogo filtrado del usuario (nunca se sugiere lo que no puede responder). */
export function suggestedQuestionsFor(surface: AssistantSurface, tools: readonly AssistantTool[]): SuggestedQuestion[] {
  const visible = new Set(tools.map((tool) => tool.name));
  return SUGGESTED_QUESTIONS[surface].filter((suggestion) => visible.has(suggestion.tool));
}
