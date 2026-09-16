// Cierre del día — pure helpers of the persisted run report
// (NightAuditReportWire, packages/shared/src/pos-types.ts) painted by
// screens/operations/NightAuditScreen.tsx (Tanda 6 · lote 6-E). No React, no
// network: screens/operations/__tests__/night-audit-report.test.mts runs this
// file under `node --test`.

import type { NightAuditReportWire, NightAuditRoomChargeItem, NightAuditStepStatus, NightAuditStepWire } from "@hotelos/shared";
import type { CocoaTone } from "../../components/cocoa/cocoa-tones";
import { STATUS_LABELS } from "../../content/actions";
import { paymentMethodLabel } from "../pos/cash-closure-helpers";

/** Step ids of night-audit.service.ts → what the operator reads. */
export const NIGHT_AUDIT_STEP_LABELS: Readonly<Record<string, string>> = Object.freeze({
  validate_open_folios: "Revisión de folios abiertos",
  snapshot_room_status: "Estado de las habitaciones",
  post_room_charges: "Cargos de alojamiento",
  process_no_shows: "No-shows",
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
  pending: STATUS_LABELS.pending
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
    default:
      return "neutral";
  }
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
