// Comunicaciones · resultado honesto de un envío (Tanda L8 · lote L8-03).
//
// The dispatcher records a delivery attempted WITHOUT a configured provider
// with `status = "sent"` and `errorMessage = "SIMULADO: …"` (apps/api
// modules/notifications/dispatcher.service.ts, attemptSend). Painting those
// rows «enviado» in green and adding them to «entregadas» was a false success
// (recon L8 «Éxitos falsos» nº 3). This module is the single place where the
// screen derives what really happened from a delivery row: the badge, the
// status filter and the KPIs all go through it. Pure (no React, no DOM) so it
// runs under node:test.

import type { CocoaTone } from "../../components/cocoa/cocoa-tones";

/** Wire status persisted by the API (`notification_deliveries.status`). */
export type DeliveryStatus = "pending" | "queued" | "sent" | "failed" | "bounced";

/** What really happened: the wire status, with `sent` split into a real «sent» and a «simulated» one. */
export type DeliveryOutcome = DeliveryStatus | "simulated";

export type DeliveryOutcomeInput = {
  status: DeliveryStatus;
  errorMessage?: string | null;
};

/** Marker the dispatcher writes at the start of `errorMessage` when the send never left the box. */
export const SIMULATED_MARK = /^SIMULADO/i;

/** true for a row recorded as `sent` without a real provider: nothing was delivered. */
export function isSimulatedDelivery(row: DeliveryOutcomeInput): boolean {
  return row.status === "sent" && SIMULATED_MARK.test(row.errorMessage ?? "");
}

/** `sent` + «SIMULADO…» → "simulated"; every other row keeps its wire status (a failed row is failed even if its message mentions a simulation). */
export function deliveryOutcome(row: DeliveryOutcomeInput): DeliveryOutcome {
  return isSimulatedDelivery(row) ? "simulated" : row.status;
}

export const DELIVERY_OUTCOME_LABEL: Record<DeliveryOutcome, string> = {
  pending: "pendiente",
  queued: "en cola",
  sent: "enviado",
  simulated: "simulado",
  failed: "fallido",
  bounced: "rebotado"
};

/** Only a real send is a success; a simulated one is a warning (nothing reached the guest), like a queued row. */
export function deliveryOutcomeTone(outcome: DeliveryOutcome): CocoaTone {
  if (outcome === "sent") return "success";
  if (outcome === "failed" || outcome === "bounced") return "danger";
  return "warning";
}

export type SentCounts = {
  /** `sent` rows that went through a provider. */
  real: number;
  /** `sent` rows recorded without a provider («SIMULADO»): never «entregadas». */
  simulated: number;
};

/** Splits the `sent` rows of a list into real and simulated; failed / queued / bounced rows count in neither. */
export function splitSentCounts(rows: readonly DeliveryOutcomeInput[]): SentCounts {
  let real = 0;
  let simulated = 0;
  for (const row of rows) {
    const outcome = deliveryOutcome(row);
    if (outcome === "sent") real += 1;
    else if (outcome === "simulated") simulated += 1;
  }
  return { real, simulated };
}

// ---- status filter of the deliveries tab ----

/** "" = every row; otherwise an outcome. The API only understands wire statuses, so «simulado» is resolved client-side. */
export type OutcomeFilter = "" | DeliveryOutcome;

export const OUTCOME_FILTER_OPTIONS: Array<{ value: OutcomeFilter; label: string }> = [
  { value: "", label: "Todos los estados" },
  { value: "sent", label: DELIVERY_OUTCOME_LABEL.sent },
  { value: "simulated", label: DELIVERY_OUTCOME_LABEL.simulated },
  { value: "failed", label: DELIVERY_OUTCOME_LABEL.failed },
  { value: "queued", label: DELIVERY_OUTCOME_LABEL.queued },
  { value: "bounced", label: DELIVERY_OUTCOME_LABEL.bounced }
];

/** `status` query param for GET /notifications/deliveries: «simulado» (and «enviado») ask the API for `sent`; the screen then narrows with matchesOutcomeFilter. */
export function apiStatusForOutcomeFilter(filter: string): DeliveryStatus | undefined {
  if (filter === "") return undefined;
  if (filter === "simulated") return "sent";
  return filter as DeliveryStatus;
}

/** Row-level counterpart of apiStatusForOutcomeFilter: keeps the rows whose real outcome is the selected one. */
export function matchesOutcomeFilter(row: DeliveryOutcomeInput, filter: string): boolean {
  return filter === "" || deliveryOutcome(row) === filter;
}
