// Normalización de los cuatro vocabularios de nivel de automatización que
// conviven en el árbol (riesgo 5 del recon): registro/property-ai
// (off | suggest | suggest_and_confirm | autonomous), gate de gobernanza
// (manual | suggest | confirm | autonomous, governance.service.ts:163), semilla
// (auto | assisted | manual_confirm) y demo-store (auto_apply_*, recommend_only…).
// Un valor desconocido nunca escala a autónomo: cae al nivel seguro.

export const AUTOMATION_LEVELS = ["off", "suggest", "suggest_and_confirm", "autonomous"] as const;
export type AutomationLevel = (typeof AUTOMATION_LEVELS)[number];

/** Vocabulario que consume evaluatePolicyGate (governance.service.ts:163). */
export type GateLevel = "manual" | "suggest" | "confirm" | "autonomous";

export const SAFE_AUTOMATION_LEVEL: AutomationLevel = "suggest_and_confirm";

const OFF = new Set(["off", "manual", "manual_only", "disabled", "none"]);
const SUGGEST = new Set(["suggest", "recommend_only", "recommend", "assisted", "suggest_only"]);
const CONFIRM = new Set(["suggest_and_confirm", "confirm", "approve_required", "manual_confirm", "confirm_required", "human_confirm"]);
const AUTONOMOUS = new Set(["autonomous", "auto", "automatic", "auto_apply"]);

export function isAutomationLevel(value: unknown): value is AutomationLevel {
  return typeof value === "string" && (AUTOMATION_LEVELS as readonly string[]).includes(value);
}

/**
 * Devuelve el nivel canónico. `fallback` (defecto suggest_and_confirm) cubre null,
 * vacío y valores no reconocidos.
 */
export function normalizeAutomationLevel(value: string | null | undefined, fallback: AutomationLevel = SAFE_AUTOMATION_LEVEL): AutomationLevel {
  const key = (value ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (!key) return fallback;
  if (OFF.has(key)) return "off";
  if (SUGGEST.has(key)) return "suggest";
  if (CONFIRM.has(key)) return "suggest_and_confirm";
  if (AUTONOMOUS.has(key) || key.startsWith("auto_apply_")) return "autonomous";
  return fallback;
}

/** Nivel canónico → vocabulario del gate de gobernanza. */
export function toGateLevel(level: AutomationLevel): GateLevel {
  switch (level) {
    case "off":
      return "manual";
    case "suggest":
      return "suggest";
    case "suggest_and_confirm":
      return "confirm";
    case "autonomous":
      return "autonomous";
    default:
      return "confirm";
  }
}
