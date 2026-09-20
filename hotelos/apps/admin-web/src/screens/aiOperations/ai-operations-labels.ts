// Spanish labels for the AI settings and activity screens of the property
// (Cocoa 22 · ola 10 · lote 10-B · fix qa#3 and qa#11; Tanda L6b · lote 04).
// The API ships the readiness checklist (GET /ai-operations/property/readiness)
// with `label`/`detail` strings next to a stable `key`, and the pipeline
// dashboard (GET /ai-operations/pipeline/dashboard) with tool-call statuses in
// English (`succeeded`, `completed`, `awaiting_confirmation`, `skipped`…). The
// screens map by key and status here and fall back to the raw text for values
// they do not know. Pure module (no JSX) so it is unit-testable.

import type { CocoaTone } from "../../components/cocoa";
import { EMPTY, money, plural } from "../../lib/format";

// ---- readiness checklist (PropertyAiScreen) ----------------------------------

export type ReadinessStatus = "ok" | "warn" | "error";

/** One row of GET /ai-operations/property/readiness (property-ai.service.ts `aiReadiness`). */
export type ReadinessCheckLike = { key: string; label: string; status: ReadinessStatus; detail: string };

/**
 * Saved settings the detail sentence is rendered from. The API derives every
 * check from the same settings row, so the screen passes what it already
 * loaded (GET /ai-operations/property/settings); when a field is missing the
 * sentence stays generic instead of guessing.
 */
export type ReadinessContext = {
  voiceLocales?: string[];
  automationLevel?: string;
  /** Spanish label of `automationLevel` («Sugerir y confirmar»). */
  automationLevelLabel?: string;
  /** `configurationJson.autonomousApprovedBy` of the saved settings. */
  approvedBy?: string;
};

const READINESS_CHECK_LABEL: Record<string, string> = {
  enabled: "IA activada",
  disclosure: "Aviso de IA al huésped",
  voice_locales: "Idiomas de voz",
  automation_level: "Nivel de automatización",
  // Tanda L6a runtime checks (after the four setting checks): model provider and monthly budget.
  provider: "Proveedor de IA",
  budget: "Presupuesto de IA"
};

/** Title of a readiness check by its API key; unknown keys keep the API label. */
export function readinessCheckLabel(check: Pick<ReadinessCheckLike, "key" | "label">): string {
  return READINESS_CHECK_LABEL[check.key] ?? check.label;
}

// The runtime checks carry data only the API knows (the model id when the
// provider is configured, the typed reason when it is unusable, the budget and
// month-to-date amounts). Their Spanish sentence is kept when it carries that
// data; any other text (raw, English, empty) is replaced by the screen's own.
const PROVIDER_OK_DETAIL = /^Proveedor \S+ con modelo /;
const PROVIDER_ERROR_DETAIL = /: la IA responde por reglas hasta corregir la configuración\.$/;
const BUDGET_AMOUNTS_DETAIL = /^Presupuesto mensual.*€/;

function apiDetailIf(check: ReadinessCheckLike, pattern: RegExp): string | undefined {
  const detail = check.detail.trim();
  return detail && pattern.test(detail) ? detail : undefined;
}

/** Detail sentence of a readiness check by key + status; unknown keys keep the API detail. */
export function readinessDetail(check: ReadinessCheckLike, context: ReadinessContext = {}): string {
  const ok = check.status === "ok";
  switch (check.key) {
    case "enabled":
      return ok ? "La IA está activada para esta propiedad." : "La IA está desactivada: no se ejecutará ninguna función de IA en esta propiedad.";
    case "disclosure":
      return ok
        ? "Hay un aviso de IA al huésped configurado."
        : "No hay aviso de IA al huésped. Informar al huésped de que interviene la IA es un requisito legal.";
    case "voice_locales": {
      if (!ok) return "No hay idiomas de voz configurados: la IA de voz no tendría ningún idioma en el que responder.";
      const locales = context.voiceLocales ?? [];
      return locales.length > 0 ? `${plural(locales.length, "idioma configurado", "idiomas configurados")}: ${locales.join(", ")}.` : "Hay idiomas de voz configurados.";
    }
    case "automation_level": {
      const level = context.automationLevel;
      const autonomous = level === "autonomous";
      if (ok) {
        if (autonomous) return context.approvedBy ? `Modo autónomo, aprobado por ${context.approvedBy}.` : "Modo autónomo con responsable de aprobación registrado.";
        const label = context.automationLevelLabel ?? level;
        return label ? `Nivel de automatización por defecto: ${label}.` : "Nivel de automatización por defecto configurado.";
      }
      if (!level) return "El nivel de automatización no está listo: revisa el nivel por defecto y, si es autónomo, el responsable de aprobación.";
      return autonomous ? "El modo autónomo está activado sin un responsable de aprobación registrado." : "No se reconoce el nivel de automatización configurado.";
    }
    case "provider": {
      if (ok) return apiDetailIf(check, PROVIDER_OK_DETAIL) ?? "Proveedor de IA configurado: las funciones de modelo están disponibles.";
      if (check.status === "error") {
        return apiDetailIf(check, PROVIDER_ERROR_DETAIL) ?? "El proveedor de IA no es utilizable: la IA responde por reglas hasta corregir la configuración.";
      }
      return "Sin modelo configurado: la IA responde por reglas y las funciones de modelo quedan omitidas.";
    }
    case "budget": {
      const withAmounts = apiDetailIf(check, BUDGET_AMOUNTS_DETAIL);
      if (withAmounts) return withAmounts;
      if (ok) return "Presupuesto mensual de IA dentro del límite.";
      return check.status === "error"
        ? "Presupuesto mensual de IA agotado: la IA no llama al modelo hasta el mes siguiente."
        : "Presupuesto mensual de IA casi agotado: al alcanzarlo la IA dejará de llamar al modelo.";
    }
    default:
      return check.detail;
  }
}

// ---- tool-call statuses (AiPipelineStatusScreen) -------------------------------

/**
 * Statuses the governance, pipeline and runner services emit for a tool call
 * (governance.service.ts, packages/ai-core runner/status.ts). `skipped` is the
 * rules-based fallback without a model (AI-CORE §8): nothing failed, nothing ran.
 */
export const CALL_STATUS_LABEL: Record<string, string> = {
  succeeded: "completada",
  completed: "completada",
  failed: "fallida",
  rejected: "rechazada",
  pending: "pendiente",
  running: "en curso",
  awaiting_confirmation: "pendiente de confirmar",
  confirmed: "confirmada",
  cancelled: "cancelada",
  skipped: "omitida (sin modelo)"
};

/** Spanish label of a tool-call status (case-insensitive); unknown values are shown as received. */
export function callStatusLabel(status: string): string {
  return CALL_STATUS_LABEL[status.toLowerCase()] ?? status;
}

/** Badge tone of a tool-call status: finished well → success, failed/rejected → danger, skipped (no model) → neutral, anything in flight → warning. */
export function callStatusTone(status: string): CocoaTone {
  const s = status.toLowerCase();
  if (s === "succeeded" || s === "completed" || s === "confirmed") return "success";
  if (s === "failed" || s === "rejected") return "danger";
  if (s === "skipped") return "neutral";
  return "warning";
}

// ---- cost and usage (AiPipelineStatusScreen, AiOwnerSummaryScreen) -------------

/**
 * Cost of a tool call or of a sum of them (Tanda L6b · lote 04; AI-CORE §6).
 * The runner leaves `cost_eur` NULL only when a model WAS called and the euro
 * amount could not be computed (model outside the pricing table or no
 * AI_USD_EUR_RATE); `0` is a real cost (no call: denial, rules-based fallback,
 * pending write). NULL is never painted as «0,00 €»: it shows «—» with the
 * reason as `title`.
 */
export const COST_UNKNOWN_TITLE = "hubo llamada sin tipo de cambio";

export function costLabel(costEur: number | null | undefined): { text: string; title?: string } {
  if (costEur === null || costEur === undefined || !Number.isFinite(costEur)) return { text: EMPTY, title: COST_UNKNOWN_TITLE };
  return { text: money(costEur) };
}

/** Tool calls of the cost window: GET /ai-operations/governance/cost has no `callsTotal`, it is the sum of `byTool[].calls`. */
export function costCallsTotal(cost: { byTool?: ReadonlyArray<{ calls: number }> } | null | undefined): number | undefined {
  if (!cost || !Array.isArray(cost.byTool)) return undefined;
  return cost.byTool.reduce((sum, row) => sum + (Number.isFinite(row.calls) ? row.calls : 0), 0);
}

export type AiUsageStatus = { value: "Encendida" | "Apagada"; caption: string; ok: boolean };

/**
 * «Estado de la IA» tile of the owner summary (Tanda L6b · lote 04): «En uso»
 * only with real tool calls in the cost window, «Sin modelo» while the
 * readiness `provider` check is not ok (the AI answers by rules); never «En uso»
 * by `aiEnabled` alone. `providerOk` / `callsTotal` undefined = that query has
 * not answered yet (or failed), so the caption says so instead of guessing.
 */
export function aiUsageStatus(input: { aiEnabled: boolean; providerOk: boolean | undefined; callsTotal: number | undefined; windowDays?: number }): AiUsageStatus {
  if (!input.aiEnabled) return { value: "Apagada", caption: "Sin uso", ok: false };
  if (input.providerOk === false) return { value: "Encendida", caption: "Sin modelo", ok: false };
  const days = input.windowDays ?? 30;
  if (input.callsTotal === undefined) return { value: "Encendida", caption: "Uso no disponible", ok: true };
  if (input.callsTotal > 0) return { value: "Encendida", caption: `En uso · ${plural(input.callsTotal, "acción", "acciones")} en ${days} días`, ok: true };
  return { value: "Encendida", caption: `Sin uso en ${days} días`, ok: true };
}
