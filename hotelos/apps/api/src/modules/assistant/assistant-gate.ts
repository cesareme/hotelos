// Puerta de propiedad del camino CON modelo del asistente unificado (Tanda L6b · corrector
// L6B-REV-01). El núcleo (assistant-core.service.ts, answerByModel) y el clasificador del bot del
// huésped (guest-bot.service.ts, classifyWithCore) llaman al proveedor directamente, sin pasar por
// runAiTool, así que aquí se reproducen las puertas 3, 4 y 7 del runner (packages/ai-core/src/
// runner/runner.ts) con los MISMOS ports Prisma que usa tool-runner.service.ts:
//   3. PropertyAiSetting.aiEnabled                       → ai_disabled_for_property
//   4. ajuste por herramienta / nivel de automatización  → tool_disabled (enabled false o nivel off)
//   7. presupuesto mensual (gasto del mes ≥ presupuesto) → budget_exceeded
// La decisión (decideAssistantPropertyGate) es pura; evaluateAssistantPropertyGate carga los hechos.
// Nunca lanza: un fallo al leer la configuración cierra la puerta (nunca se abre por error; el
// núcleo responde por reglas con aviso).

import { budgetStatus, monthlyBudgetEurOf, normalizeAutomationLevel } from "@hotelos/ai-core/runner";
import { prisma } from "@hotelos/database";
import { getAiConfig } from "../../lib/ai-config.js";
import { monthToDateCostEur } from "../ai-operations/pipeline.service.js";
import { getPropertyAiSettings } from "../ai-operations/property-ai.service.js";

export type AssistantGateReason = "ai_disabled_for_property" | "tool_disabled" | "budget_exceeded" | "gate_unavailable";

export type AssistantPropertyGate = { allowed: true } | { allowed: false; reason: AssistantGateReason; notice: string };

export type AssistantGateInput = { organizationId: string; propertyId: string; toolName: string };

export type AssistantGateFacts = {
  aiEnabled: boolean;
  defaultAutomationLevel: string | null | undefined;
  /** Ajuste por herramienta (PropertyAiToolSetting) o null si no hay fila. */
  toolSetting: { enabled: boolean; automationLevel: string | null } | null;
  spentEur: number;
  budgetEur: number | null;
};

function fmtEur(value: number): string {
  return `${value.toFixed(2)} €`;
}

/** Decisión pura sobre los hechos ya cargados (mismo orden que el runner: 3 → 4 → 7). */
export function decideAssistantPropertyGate(facts: AssistantGateFacts, toolName: string): AssistantPropertyGate {
  if (!facts.aiEnabled) return { allowed: false, reason: "ai_disabled_for_property", notice: "La IA está desactivada en esta propiedad; he respondido por reglas." };
  if (facts.toolSetting && !facts.toolSetting.enabled) {
    return { allowed: false, reason: "tool_disabled", notice: `La herramienta ${toolName} está desactivada en esta propiedad; he respondido por reglas.` };
  }
  const level = normalizeAutomationLevel(facts.toolSetting?.automationLevel ?? facts.defaultAutomationLevel);
  if (level === "off") return { allowed: false, reason: "tool_disabled", notice: `La automatización de ${toolName} está apagada en esta propiedad (nivel off); he respondido por reglas.` };
  const budget = budgetStatus(facts.spentEur, facts.budgetEur);
  if (budget.exceeded) {
    return { allowed: false, reason: "budget_exceeded", notice: `Presupuesto mensual de IA agotado (${fmtEur(budget.spentEur)} de ${fmtEur(budget.budgetEur ?? 0)}); he respondido por reglas.` };
  }
  return { allowed: true };
}

/** Carga los hechos con los ports reales (Prisma) y decide; un fallo de lectura cierra la puerta. */
export async function evaluateAssistantPropertyGate(input: AssistantGateInput): Promise<AssistantPropertyGate> {
  try {
    const [settings, toolRow, spentEur] = await Promise.all([
      getPropertyAiSettings(input.propertyId),
      prisma.propertyAiToolSetting.findUnique({ where: { propertyId_toolName: { propertyId: input.propertyId, toolName: input.toolName } }, select: { enabled: true, automationLevel: true } }),
      monthToDateCostEur({ organizationId: input.organizationId, propertyId: input.propertyId })
    ]);
    return decideAssistantPropertyGate(
      {
        aiEnabled: settings.aiEnabled,
        defaultAutomationLevel: settings.defaultAutomationLevel,
        toolSetting: toolRow ? { enabled: toolRow.enabled, automationLevel: toolRow.automationLevel ?? null } : null,
        spentEur,
        budgetEur: monthlyBudgetEurOf(settings.configurationJson, getAiConfig().monthlyBudgetEurDefault)
      },
      input.toolName
    );
  } catch (error) {
    console.warn("[assistant.gate] property gate unavailable; answering by rules", { propertyId: input.propertyId, error: error instanceof Error ? error.message : String(error) });
    return { allowed: false, reason: "gate_unavailable", notice: "No se pudo comprobar la configuración de IA de la propiedad; he respondido por reglas." };
  }
}
