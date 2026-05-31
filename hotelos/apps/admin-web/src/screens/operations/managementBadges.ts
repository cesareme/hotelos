// Management workspace shared badge helpers.
//
// Tone maps for the GeneralManager and OperationsDirector dashboards. The
// canonical type unions (`health`, `severity`) stay in the data layer; this
// file only maps them to Cocoa color tokens and Spanish-language labels so
// both screens render badges identically.

export type ManagementHealth = "ok" | "warn" | "error";
export type ManagementSeverity = "critical" | "warning";
export type ManagementTone = "success" | "warning" | "danger" | "info" | "neutral";

export const HEALTH_LABEL: Record<ManagementHealth, string> = {
  ok: "OK",
  warn: "ATENCIÓN",
  error: "CRÍTICO"
};

export const HEALTH_TONE: Record<ManagementHealth, ManagementTone> = {
  ok: "success",
  warn: "warning",
  error: "danger"
};

export const SEVERITY_TONE: Record<ManagementSeverity, ManagementTone> = {
  critical: "danger",
  warning: "warning"
};

/** Map a Kpi.tone literal to the Cocoa badge tone palette. */
export function kpiToneToCocoa(
  tone: "ok" | "warn" | "error" | "info"
): ManagementTone {
  if (tone === "ok") return "success";
  if (tone === "warn") return "warning";
  if (tone === "error") return "danger";
  return "info";
}

/** Resolve a Cocoa tone to a CSS color token (used by inline label colors). */
export function toneToColorToken(tone: ManagementTone): string {
  switch (tone) {
    case "success":
      return "var(--cocoa-success)";
    case "warning":
      return "var(--cocoa-warning)";
    case "danger":
      return "var(--cocoa-danger)";
    case "info":
      return "var(--cocoa-info)";
    case "neutral":
    default:
      return "var(--cocoa-label)";
  }
}
