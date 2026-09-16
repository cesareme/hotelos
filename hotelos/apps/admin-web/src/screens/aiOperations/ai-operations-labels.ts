// Spanish labels for the AI settings and activity screens of the property
// (Cocoa 22 · ola 10 · lote 10-B · fix qa#3 and qa#11). The API ships the
// readiness checklist (GET /ai-operations/property/readiness) with English
// `label`/`detail` strings next to a stable `key`, and the pipeline dashboard
// (GET /ai-operations/pipeline/dashboard) with tool-call statuses in English
// (`succeeded`, `completed`, `awaiting_confirmation`…). The screens map by key
// and status here and fall back to the raw text for values they do not know.
// Pure module (no JSX) so it is unit-testable.

import type { CocoaTone } from "../../components/cocoa";
import { plural } from "../../lib/format";

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
  automation_level: "Nivel de automatización"
};

/** Title of a readiness check by its API key; unknown keys keep the API label. */
export function readinessCheckLabel(check: Pick<ReadinessCheckLike, "key" | "label">): string {
  return READINESS_CHECK_LABEL[check.key] ?? check.label;
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
    default:
      return check.detail;
  }
}

// ---- tool-call statuses (AiPipelineStatusScreen) -------------------------------

/** Statuses the governance and pipeline services emit for a tool call (governance.service.ts). */
export const CALL_STATUS_LABEL: Record<string, string> = {
  succeeded: "completada",
  completed: "completada",
  failed: "fallida",
  rejected: "rechazada",
  pending: "pendiente",
  running: "en curso",
  awaiting_confirmation: "pendiente de confirmar",
  confirmed: "confirmada",
  cancelled: "cancelada"
};

/** Spanish label of a tool-call status (case-insensitive); unknown values are shown as received. */
export function callStatusLabel(status: string): string {
  return CALL_STATUS_LABEL[status.toLowerCase()] ?? status;
}

/** Badge tone of a tool-call status: finished well → success, failed/rejected → danger, anything in flight → warning. */
export function callStatusTone(status: string): CocoaTone {
  const s = status.toLowerCase();
  if (s === "succeeded" || s === "completed" || s === "confirmed") return "success";
  if (s === "failed" || s === "rejected") return "danger";
  return "warning";
}
