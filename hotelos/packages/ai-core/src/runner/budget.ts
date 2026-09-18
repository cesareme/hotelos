// Presupuesto mensual de IA por propiedad. Sin columna nueva (schema.prisma
// es de la Tanda L3): el importe vive en PropertyAiSetting.configurationJson
// bajo `monthlyBudgetEur` y, si falta, en AI_MONTHLY_BUDGET_EUR_DEFAULT
// (AiConfig.monthlyBudgetEurDefault). El gasto acumulado del mes natural (UTC)
// es la suma de ai_tool_calls.cost_eur (pipeline.service monthToDateCostEur).

export const MONTHLY_BUDGET_KEY = "monthlyBudgetEur";

/**
 * Importe del presupuesto: `configurationJson.monthlyBudgetEur` numérico y ≥ 0 → ese
 * valor; null, ausente, no numérico o negativo → `defaultEur`.
 */
export function monthlyBudgetEurOf(configurationJson: unknown, defaultEur: number): number {
  const fallback = Number.isFinite(defaultEur) && defaultEur >= 0 ? defaultEur : 0;
  if (!configurationJson || typeof configurationJson !== "object" || Array.isArray(configurationJson)) return fallback;
  const raw = (configurationJson as Record<string, unknown>)[MONTHLY_BUDGET_KEY];
  if (raw === null || raw === undefined) return fallback;
  const value = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() !== "" ? Number(raw) : Number.NaN;
  if (!Number.isFinite(value) || value < 0) return fallback;
  return value;
}

/**
 * true cuando el gasto del mes alcanza el presupuesto. Presupuesto 0 → siempre
 * excedido (la propiedad no admite gasto); null → sin límite.
 */
export function isBudgetExceeded(mtdEur: number, budgetEur: number | null): boolean {
  if (budgetEur === null || budgetEur === undefined) return false;
  if (!Number.isFinite(budgetEur) || budgetEur <= 0) return true;
  const spent = Number.isFinite(mtdEur) && mtdEur > 0 ? mtdEur : 0;
  return spent >= budgetEur;
}

export type BudgetStatus = { budgetEur: number | null; spentEur: number; remainingEur: number | null; exceeded: boolean };

export function budgetStatus(mtdEur: number, budgetEur: number | null): BudgetStatus {
  const spent = Number.isFinite(mtdEur) && mtdEur > 0 ? mtdEur : 0;
  const exceeded = isBudgetExceeded(spent, budgetEur);
  return {
    budgetEur,
    spentEur: spent,
    remainingEur: budgetEur === null ? null : Math.max(0, budgetEur - spent),
    exceeded
  };
}
