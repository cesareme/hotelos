// Cierre del día — pure helpers of the persisted run report
// (NightAuditReportWire, packages/shared/src/pos-types.ts) painted by
// screens/operations/NightAuditScreen.tsx (Tanda 6 · lote 6-E). No React, no
// network: screens/operations/__tests__/night-audit-report.test.mts runs this
// file under `node --test`.

import type {
  NightAuditPreflightBlockerWire,
  NightAuditReopenReasonCode,
  NightAuditReportWire,
  NightAuditRoomChargeItem,
  NightAuditRunWire,
  NightAuditStepStatus,
  NightAuditStepWire
} from "@hotelos/shared";
import type { CocoaTone } from "../../components/cocoa/cocoa-tones";
import { STATUS_LABELS } from "../../content/actions";
import { date, time } from "../../lib/format";
import { paymentMethodLabel } from "../pos/cash-closure-helpers";

/** Step ids of night-audit.service.ts → what the operator reads. */
export const NIGHT_AUDIT_STEP_LABELS: Readonly<Record<string, string>> = Object.freeze({
  validate_open_folios: "Revisión de folios abiertos",
  snapshot_room_status: "Estado de las habitaciones",
  post_room_charges: "Cargos de alojamiento",
  process_no_shows: "No-shows",
  close_settled_folios: "Folios liquidados",
  revenue_snapshot: "Producción del día",
  payments_summary: "Resumen de cobros",
  reconcile_payments: "Resumen de cobros",
  cash_closures: "Cierres de caja",
  advance_business_date: "Avance de la fecha de negocio"
});

export function stepLabel(step: string): string {
  return NIGHT_AUDIT_STEP_LABELS[step] ?? step.replace(/_/g, " ");
}

export const STEP_STATUS_LABELS: Readonly<Record<NightAuditStepStatus, string>> = Object.freeze({
  ok: "Correcto",
  warning: "Con avisos",
  skipped: "Omitido",
  failed: STATUS_LABELS.failed
});

export function stepStatusLabel(status: string): string {
  return status in STEP_STATUS_LABELS ? STEP_STATUS_LABELS[status as NightAuditStepStatus] : status;
}

export function stepTone(status: string): CocoaTone {
  switch (status) {
    case "ok":
      return "success";
    case "warning":
      return "warning";
    case "failed":
      return "danger";
    default:
      return "neutral";
  }
}

/** Run status (NightAuditStatus, plus the legacy `running` / `pending` of older rows) → Spanish. */
export const RUN_STATUS_LABELS: Readonly<Record<string, string>> = Object.freeze({
  completed: STATUS_LABELS.completed,
  failed: STATUS_LABELS.failed,
  in_progress: STATUS_LABELS.inProgress,
  running: STATUS_LABELS.inProgress,
  not_started: STATUS_LABELS.pending,
  pending: STATUS_LABELS.pending,
  reopened: "Reabierto"
});

export function runStatusLabel(status: string): string {
  return RUN_STATUS_LABELS[status] ?? status;
}

export function runStatusTone(status: string): CocoaTone {
  switch (status) {
    case "completed":
      return "success";
    case "failed":
      return "danger";
    case "in_progress":
    case "running":
      return "info";
    case "reopened":
      return "warning";
    default:
      return "neutral";
  }
}

// ── Tanda L5 (L5-D): review / reopening trace and actions ────────────────────

/** Reason codes of POST …/night-audit/runs/:runId/reopen (REOPEN_REASON_CODES of the API) → what the operator picks. */
export const REOPEN_REASON_LABELS: Readonly<Record<NightAuditReopenReasonCode, string>> = Object.freeze({
  missing_charge: "Cargo no contabilizado",
  wrong_charge: "Cargo erróneo",
  no_show_error: "No-show mal procesado",
  payment_correction: "Corrección de cobro",
  audit_finding: "Hallazgo de la revisión",
  other: "Otro motivo (indicar en el texto)"
});

export const REOPEN_REASON_CODES: readonly NightAuditReopenReasonCode[] = Object.freeze(Object.keys(REOPEN_REASON_LABELS) as NightAuditReopenReasonCode[]);

export function reopenReasonLabel(code: string | null | undefined): string {
  if (!code) return "—";
  return (REOPEN_REASON_LABELS as Record<string, string>)[code] ?? code;
}

/** Review state of a run as the drawer reads it («Pendiente de revisión», «Revisado», «Reabierto»…). */
export type RunReviewState = "not_applicable" | "pending_review" | "reviewed" | "reopened";

export function runReviewState(run: Pick<NightAuditRunWire, "status" | "reviewedByUserId" | "reopenedByUserId">): RunReviewState {
  // Corrector L5 (OP-04): un día reabierto y vuelto a cerrar es `completed` de nuevo
  // (la traza de reapertura sigue en el cajón): su revisión vuelve a estar pendiente.
  if (run.status === "reopened") return run.reviewedByUserId ? "reviewed" : "reopened";
  if (run.status !== "completed") return "not_applicable";
  return run.reviewedByUserId ? "reviewed" : "pending_review";
}

export const RUN_REVIEW_LABELS: Readonly<Record<RunReviewState, string>> = Object.freeze({
  not_applicable: "—",
  pending_review: "Pendiente de revisión",
  reviewed: "Revisado",
  reopened: "Reabierto"
});

export function runReviewTone(state: RunReviewState): CocoaTone {
  switch (state) {
    case "reviewed":
      return "success";
    case "pending_review":
      return "info";
    case "reopened":
      return "warning";
    default:
      return "neutral";
  }
}

/** Which T8a actions a run admits, given the session's permissions (pure: the API re-checks). */
export function runActionsFor(
  run: Pick<NightAuditRunWire, "status" | "reviewedByUserId">,
  can: (permission: "night_audit.review" | "night_audit.reopen") => boolean
): { review: boolean; reopen: boolean } {
  const completed = run.status === "completed";
  // Corrector L5 (OP-04): un día reabierto que ya no es el último cerrado no se re-ejecuta;
  // sus correcciones se revisan sobre el run reabierto (el último cerrado se vuelve a cerrar).
  const reviewable = completed || run.status === "reopened";
  return {
    review: reviewable && !run.reviewedByUserId && can("night_audit.review"),
    reopen: completed && can("night_audit.reopen")
  };
}

/** Whether a session may close over blockers («Cerrar de todos modos»): the run key, nothing else. */
export function canForceClose(can: (permission: "night_audit.run") => boolean): boolean {
  return can("night_audit.run");
}

// ── Tanda UX-2 (D8 · F-D3): honest close banner and the review of the last run ──

/**
 * What the close banner offers (pure; the API re-checks):
 *   run          preflight green and the session holds night_audit.run → «Cerrar día»
 *   force        blockers and the run key → «Cerrar de todos modos» (reason dialog)
 *   review-only  preflight green WITHOUT the run key (dirección: manager /
 *                general_manager only review) → no button, the text says who closes
 *   blocked      blockers without the run key → no button, «Abrir cola operativa»
 * Never a «Cerrar día» that would answer 403 (P7).
 */
export type CloseAction = "run" | "force" | "blocked" | "review-only";

export function closeActionFor(preflight: { canClose: boolean } | null | undefined, can: (permission: "night_audit.run") => boolean): CloseAction {
  const canRun = canForceClose(can);
  if (preflight?.canClose) return canRun ? "run" : "review-only";
  return canRun ? "force" : "blocked";
}

export const CLOSE_BANNER_TITLES: Readonly<Record<CloseAction, string>> = Object.freeze({
  run: "Puedes cerrar el día",
  force: "No puedes cerrar todavía",
  blocked: "No puedes cerrar todavía",
  "review-only": "Comprobaciones en verde"
});

/** Body of the banner for a session without the run key and a green preflight (P7: says who closes). */
export const CLOSE_REVIEW_ONLY_TEXT = "Las comprobaciones están en verde; el cierre lo ejecuta recepción o auditoría nocturna y tú lo revisas cuando esté hecho.";

/** Label of the fix the blocked banner and ⌘K offer without the run key (same destination as the arrivals / departures / folios checks). */
export const OPEN_QUEUE_LABEL = "Abrir cola operativa";

type ReviewableRun = Pick<NightAuditRunWire, "id" | "status" | "reviewedByUserId" | "businessDate" | "completedAt">;

/**
 * The most recent run (newest business date; latest completion on a tie) when
 * it still awaits its income review by this session; null otherwise (reviewed,
 * failed, in progress, or without night_audit.review).
 */
export function latestRunToReview<T extends ReviewableRun>(runs: readonly T[], can: (permission: "night_audit.review" | "night_audit.reopen") => boolean): T | null {
  const latest = [...runs].sort((a, b) => b.businessDate.localeCompare(a.businessDate) || (b.completedAt ?? "").localeCompare(a.completedAt ?? ""))[0];
  if (!latest) return null;
  return runActionsFor(latest, can).review ? latest : null;
}

/** «Cierre del 18/09/2026 hecho a las 08:00» · reopened day: «Día del 18/09/2026 reabierto, pendiente de revisión». */
export function reviewCalloutTitle(run: Pick<NightAuditRunWire, "status" | "businessDate" | "completedAt">): string {
  const day = date(run.businessDate, "short");
  if (run.status === "reopened") return `Día del ${day} reabierto, pendiente de revisión`;
  return `Cierre del ${day} hecho a las ${time(run.completedAt)}`;
}

/** Toast of a successful review: «Cierre del 18/09/2026 marcado como revisado». */
export function reviewedToast(run: Pick<NightAuditRunWire, "businessDate">): string {
  return `Cierre del ${date(run.businessDate, "short")} marcado como revisado`;
}

/** Figures of the close_settled_folios step for the drawer; null on runs older than the step. */
export type SettledFoliosSummary = { closed: number; pendingInvoice: number; withBalance: number; totalWithBalance: string; leftOpen: number };

export function settledFoliosSummary(report: Pick<NightAuditReportWire, "settledFolios"> | null | undefined): SettledFoliosSummary | null {
  const figures = report?.settledFolios;
  if (!figures) return null;
  return { ...figures, leftOpen: figures.pendingInvoice + figures.withBalance };
}

/** The forced close of a run: reason and the blockers the runner skipped; null when the run was not forced. */
export function preflightOverrideSummary(report: Pick<NightAuditReportWire, "preflightOverride"> | null | undefined): { reasonText: string; blockers: NightAuditPreflightBlockerWire[] } | null {
  const override = report?.preflightOverride;
  if (!override) return null;
  return { reasonText: override.reasonText, blockers: override.blockers ?? [] };
}

/** «2 · No-shows sin resolver» — one blocker as a list item (a failed count shows «—»). */
export function blockerLabel(blocker: Pick<NightAuditPreflightBlockerWire, "count" | "title">): string {
  return `${blocker.count ?? "—"} · ${blocker.title}`;
}

/** Folio line types of the revenue snapshot → Spanish. Unknown types are painted as they come. */
export const REVENUE_TYPE_LABELS: Readonly<Record<string, string>> = Object.freeze({
  room: "Alojamiento",
  accommodation: "Alojamiento",
  food_beverage: "Restauración",
  fnb: "Restauración",
  pos: "Punto de venta",
  minibar: "Minibar",
  spa: "Spa",
  parking: "Aparcamiento",
  laundry: "Lavandería",
  service: "Servicios",
  extra: "Extras",
  upsell: "Ventas adicionales",
  tax: "Impuestos",
  tourist_tax: "Tasa turística",
  city_tax: "Tasa turística",
  no_show: "Penalización por no presentarse",
  no_show_fee: "Penalización por no presentarse",
  cancellation: "Penalización por cancelación",
  cancellation_fee: "Penalización por cancelación",
  adjustment: "Ajustes",
  discount: "Descuentos",
  other: "Otros"
});

export function revenueTypeLabel(type: string): string {
  return REVENUE_TYPE_LABELS[type.trim().toLowerCase()] ?? type;
}

export { paymentMethodLabel };

export type LabelledAmount = { key: string; label: string; amount: string };

/** `Record<type, "12.50">` → rows sorted by amount desc, labelled in Spanish. */
export function labelledAmounts(byKey: Record<string, string> | undefined, label: (key: string) => string): LabelledAmount[] {
  if (!byKey) return [];
  return Object.entries(byKey)
    .map(([key, amount]) => ({ key, label: label(key), amount }))
    .sort((a, b) => Number(b.amount) - Number(a.amount));
}

export const ROOM_CHARGE_OUTCOME_LABELS: Readonly<Record<NightAuditRoomChargeItem["outcome"], string>> = Object.freeze({
  posted: "Cargado",
  already_posted: "Ya cargado",
  no_rate: "Sin tarifa",
  no_open_folio: "Sin folio abierto"
});

export function roomChargeOutcomeTone(outcome: NightAuditRoomChargeItem["outcome"]): CocoaTone {
  switch (outcome) {
    case "posted":
      return "success";
    case "already_posted":
      return "neutral";
    default:
      return "warning";
  }
}

export const PRICE_SOURCE_LABELS: Readonly<Record<NightAuditRoomChargeItem["priceSource"], string>> = Object.freeze({
  rate_plan: "plan de tarifas de la reserva",
  lowest_published: "tarifa publicada más baja",
  reservation_total: "total de la reserva repartido por noches",
  none: "sin precio"
});

/** Reservations the run could not charge (no rate / no open folio): the actionable list of the report. */
export function unchargedReservations(report: Pick<NightAuditReportWire, "roomCharges"> | null | undefined): NightAuditRoomChargeItem[] {
  if (!report) return [];
  return report.roomCharges.items.filter((item) => item.outcome === "no_rate" || item.outcome === "no_open_folio");
}

/** Steps that ended with a warning or a failure, in run order. */
export function stepsNeedingAttention(steps: readonly NightAuditStepWire[]): NightAuditStepWire[] {
  return steps.filter((step) => step.status === "warning" || step.status === "failed");
}

export type ReportSummary = {
  posted: number;
  totalPosted: string;
  withoutRate: number;
  revenueTotal: string;
  revenueLines: number;
  paymentsTotal: string;
  paymentsCount: number;
  noShows: number;
  noShowsCharged: string;
  warnings: number;
};

/** Figures of the report's KPI strip (already strings on the wire; counts as numbers). */
export function reportSummary(report: NightAuditReportWire): ReportSummary {
  return {
    posted: report.roomCharges.posted,
    totalPosted: report.roomCharges.totalPosted,
    withoutRate: report.roomCharges.withoutRate + report.roomCharges.withoutFolio,
    revenueTotal: report.revenue.total,
    revenueLines: report.revenue.lines,
    paymentsTotal: report.payments.total,
    paymentsCount: report.payments.count,
    noShows: report.noShows.processed,
    noShowsCharged: report.noShows.totalCharged,
    warnings: report.warnings.length
  };
}
