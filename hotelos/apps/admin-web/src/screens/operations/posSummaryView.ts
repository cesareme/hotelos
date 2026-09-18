// Pure view helpers of the POS board (Operaciones › Punto de venta › Comandas),
// Tanda L3 · lote P1 «POS front honesto». No React, no api-client: the module
// loads under node --test (screens/operations/__tests__/pos-dashboard-summary.test.mts)
// and only reads the wire shape of GET /pos/cash-summary (services/posApi.ts,
// mirror of apps/api/src/modules/pos/pos-cash-closure.service.ts).
//
//   · posCashWarnings(summary)        what the arqueo does NOT contain, as notices
//     (open tickets are not revenue; rows without settlement or without
//     closedAt; counters that failed; a property without time zone);
//   · degradedCounters(summary)       which side counters must paint «—»;
//   · cashSummaryOutletOptions(rows)  outlet filter options from the summary
//     itself (board ids the endpoint understands; orphan rows skipped);
//   · outletRowLabel(row)             name of a per-outlet row (orphan FK named honestly);
//   · invoiceSeries(number)           the REAL series of a ticket's simplified
//     invoice = prefix of the number the API returns («SIM-2026-000001» →
//     «SIM», «SIM-RA-2026-000001» → «SIM»; decision §6.15: the UI never hard-codes it);
//   · timeZoneLabel(summary)          zone of the window, or the UTC fallback named.
// Amounts and counts go through lib/format (Intl es-ES · Europe/Madrid).

import type { CocoaTone } from "../../components/cocoa/cocoa-tones";
import { money, number, plural } from "../../lib/format";
import type { PosCashSummary, PosCashSummaryOutlet } from "../../services/posApi";

/** The slice of the summary the notices read (small fixtures in tests). */
export type PosCashSummaryLike = Pick<PosCashSummary, "openTickets" | "totals" | "unplaceable" | "degraded" | "timeZone" | "timeZoneSource">;

export type PosCashWarningKind = "degraded" | "open_tickets" | "unsettled" | "unplaceable" | "time_zone";

export type PosCashWarning = {
  kind: PosCashWarningKind;
  tone: CocoaTone;
  title: string;
  message: string;
  /** Number of tickets the notice is about (absent for the time-zone and degraded notices). */
  count?: number;
  /** Amount the notice is about (absent for the time-zone and degraded notices). */
  amount?: number;
};

/** Side counters of the summary that go through `safe()` in the API (labels of `degraded[]`). */
export const POS_CASH_COUNTER_LABELS = Object.freeze({
  openTickets: "comandas abiertas",
  unplaceable: "comandas cerradas sin fecha de cierre"
}) as Readonly<Record<string, string>>;

export const TIME_ZONE_WARNING_TITLE = "Zona horaria del hotel no configurada";
export const UTC_FALLBACK_LABEL = "UTC · zona horaria del hotel no configurada";

/** Spanish name of a `degraded[]` label (the raw label when unknown, never hidden). */
export function degradedCounterLabel(label: string): string {
  return POS_CASH_COUNTER_LABELS[label] ?? label;
}

/** Which side counters failed in the API and must paint «—» instead of a confident zero (QC-06). */
export function degradedCounters(summary: Pick<PosCashSummary, "degraded">): { openTickets: boolean; unplaceable: boolean } {
  const degraded = Array.isArray(summary.degraded) ? summary.degraded : [];
  return { openTickets: degraded.includes("openTickets"), unplaceable: degraded.includes("unplaceable") };
}

/**
 * Notices of an arqueo, in reading order: failed counters first (the reader
 * must know the figures below are unreliable), then what is pending or
 * unattributed, then the time-zone fallback. Empty when the count is clean.
 */
export function posCashWarnings(summary: PosCashSummaryLike): PosCashWarning[] {
  const out: PosCashWarning[] = [];
  const degraded = Array.isArray(summary.degraded) ? summary.degraded : [];
  if (degraded.length > 0) {
    const labels = degraded.map(degradedCounterLabel).join(" y ");
    out.push({
      kind: "degraded",
      tone: "warning",
      title: "Indicadores no disponibles",
      message: `El cálculo de ${labels} falló en el servidor: se muestran como no disponibles, no como cero. Revisa el log del servidor antes de firmar el arqueo.`
    });
  }
  const open = summary.openTickets;
  if (!degraded.includes("openTickets") && open.count > 0) {
    out.push({
      kind: "open_tickets",
      tone: "warning",
      title: "Comandas abiertas en el rango",
      message: `${plural(open.count, "comanda abierta", "comandas abiertas")} por ${money(open.total)} siguen pendientes: no son ingreso y no entran en el arqueo hasta que se cierren.`,
      count: open.count,
      amount: open.total
    });
  }
  const unsettled = summary.totals.unsettled;
  if (unsettled.tickets > 0) {
    out.push({
      kind: "unsettled",
      tone: "warning",
      title: "Comandas cerradas sin forma de cobro",
      message: `${plural(unsettled.tickets, "comanda cerrada", "comandas cerradas")} por ${money(unsettled.total)} no tienen forma de cobro registrada: cuentan en el total, pero no en efectivo, tarjeta ni habitación.`,
      count: unsettled.tickets,
      amount: unsettled.total
    });
  }
  const unplaceable = summary.unplaceable;
  if (!degraded.includes("unplaceable") && unplaceable.tickets > 0) {
    out.push({
      kind: "unplaceable",
      tone: "danger",
      title: "Comandas cerradas sin fecha de cierre",
      message: `${plural(unplaceable.tickets, "comanda cerrada", "comandas cerradas")} por ${money(unplaceable.total)} no tienen fecha de cierre: ningún día las puede contar y quedan fuera de los totales de cualquier rango.`,
      count: unplaceable.tickets,
      amount: unplaceable.total
    });
  }
  if (summary.timeZoneSource === "utc_fallback") {
    out.push({
      kind: "time_zone",
      tone: "warning",
      title: TIME_ZONE_WARNING_TITLE,
      message: "El arqueo corta el día a medianoche UTC y no a la hora local: configura la zona horaria del centro para que el día de negocio coincida con la jornada."
    });
  }
  return out;
}

/** Zone the window was resolved in; the UTC fallback is named, never shown as a configured zone. */
export function timeZoneLabel(summary: Pick<PosCashSummary, "timeZone" | "timeZoneSource">): string {
  return summary.timeZoneSource === "utc_fallback" ? UTC_FALLBACK_LABEL : summary.timeZone;
}

export const ORPHAN_OUTLET_LABEL = "Punto de venta sin ficha";

/** Name of a per-outlet row; an orphan Outlet FK (name null) is named as such, never blank. */
export function outletRowLabel(row: Pick<PosCashSummaryOutlet, "outletName">): string {
  const name = row.outletName?.trim();
  return name ? name : ORPHAN_OUTLET_LABEL;
}

/**
 * Options of the outlet filter from the unfiltered summary: one per board
 * outlet id (`out_<type>`; several rows of one type share it, so it is
 * deduplicated), orphan rows skipped (their row id is not a filter the
 * endpoint accepts). Sorted as the summary is (by name, es).
 */
export function cashSummaryOutletOptions(rows: readonly Pick<PosCashSummaryOutlet, "outletId" | "outletName">[]): Array<{ value: string; label: string }> {
  const seen = new Set<string>();
  const out: Array<{ value: string; label: string }> = [];
  for (const row of rows) {
    if (!row.outletId || seen.has(row.outletId)) continue;
    seen.add(row.outletId);
    out.push({ value: row.outletId, label: outletRowLabel(row) });
  }
  return out;
}

/**
 * Series of an invoice number = its leading letters segment («SIM-2026-000001»,
 * «SIM-RA-2026-000001», «FAC-2026-000016» → SIM / SIM / FAC); null when there
 * is no number or it does not start with a series (a raw id is not a series).
 */
export function invoiceSeries(invoiceNumber: string | null | undefined): string | null {
  const value = invoiceNumber?.trim() ?? "";
  const match = /^([A-Za-z]{1,10})-/.exec(value);
  return match ? match[1].toUpperCase() : null;
}

/** «Serie SIM» for a badge next to the number; null when the number has no series. */
export function invoiceSeriesLabel(invoiceNumber: string | null | undefined): string | null {
  const series = invoiceSeries(invoiceNumber);
  return series ? `Serie ${series}` : null;
}

/** «N comandas · 12,50 €» caption of a counter (es-ES), used by the KPI tiles of the arqueo. */
export function ticketsCaption(count: number, amount: number): string {
  return `${plural(count, "comanda", "comandas")} · ${money(amount)}`;
}

/** Plain count for a KPI figure (es-ES grouping), kept here so the tile and the tests agree. */
export function countLabel(count: number): string {
  return number(count);
}
