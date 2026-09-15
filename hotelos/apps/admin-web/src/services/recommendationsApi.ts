// Frontend client for the rate grid recommendations layer (revenue module,
// apps/api/src/modules/revenue/recommendations.routes.ts).
//
// The editor paints `suggestedPrice` per cell and lets the user accept a
// suggestion, which becomes a draft patch like any manual edit. On save /
// publish the editor calls `applyRecommendations` for the decided cells
// AFTER a successful bulk-update (cierre 2026-09-15), passing the
// `journalId` of that write, `currentPrice` = the price the hotelier saw
// before the change and `suggestedPrice` = the suggestion shown, so no
// «applied» row is left orphaned when the bulk-update fails (400/409). A
// draft with rejections only is recorded without any bulk-update. The API
// persists the RevenueRecommendation rows (status "applied" / "rejected")
// and returns the engine's patches, which the editor does NOT need (the
// draft already carries the accepted or adjusted price). Apply never writes
// rate_days.
//
// Real routes:
//   GET  /properties/:id/rate-grid/recommendations?from&to&ratePlanId&roomTypeIds → RateRecommendationsResponse
//        `roomTypeIds` (or the `roomTypeId` of a cell) that belong to another property or are
//        inactive answer 400 `{ code: "UNKNOWN_IDS", roomTypeIds }` (same contract as rateGridApi);
//        the editor only sends ids taken from its own grid, so it never hits it.
//   POST /properties/:id/rate-grid/recommendations/apply
//        window form: { from, to, ratePlanId, roomTypeIds?, dates?, reason?, includeRestrictions?, minConfidence? }
//        cell form:   { from, to, ratePlanId, reason?, journalId?, cells: [{ roomTypeId, date, action, currentPrice?, suggestedPrice?, appliedPrice?, reason? }] }
//        (ApplyBodySchema in apps/api/src/modules/revenue/recommendations.routes.ts; `cells` is
//        exclusive with dates/roomTypeIds). The editor uses the cell form: the user decided per
//        cell and `appliedPrice` is the FINAL price written by bulk-update (accept = the
//        suggested one, adjust = the user's value, reject = persisted as "rejected", no patch);
//        `currentPrice` is persisted as currentValueJson.price and `suggestedPrice` as
//        recommendedValueJson.shownPrice instead of / next to the engine's recalculation.
//   GET/PUT /properties/:id/rate-grid/recommendations/config
import { apiRequest } from "./api-client";
import type { RateGridCellPatch, RateRecommendationsResponse } from "@hotelos/shared";

export type { RateRecommendationsResponse };

export type FetchRecommendationsInput = {
  from: string;
  to: string;
  /** Omitted = the property's active BAR plan. */
  ratePlanId?: string;
  roomTypeIds?: string[];
  signal?: AbortSignal;
};

export function fetchRecommendations(
  propertyId: string,
  input: FetchRecommendationsInput
): Promise<RateRecommendationsResponse> {
  const query: Record<string, string | number | undefined> = { from: input.from, to: input.to };
  if (input.ratePlanId) query.ratePlanId = input.ratePlanId;
  if (input.roomTypeIds && input.roomTypeIds.length > 0) query.roomTypeIds = input.roomTypeIds.join(",");
  return apiRequest<RateRecommendationsResponse>(`/properties/${propertyId}/rate-grid/recommendations`, {
    query,
    signal: input.signal
  });
}

/** One per-cell decision of the cell form (`ApplyCellSchema`, strict). */
export type ApplyRecommendationCell = {
  roomTypeId: string;
  date: string;
  /** accept = publish the suggested price · adjust = publish `appliedPrice` · reject = record only. */
  action: "accept" | "adjust" | "reject";
  /** Base price the hotelier saw when deciding (persisted as currentValueJson.price instead of the engine's recalculation). */
  currentPrice?: number | null;
  /** Price the editor showed as suggestion (persisted as recommendedValueJson.shownPrice; fallback when the engine has none). */
  suggestedPrice?: number | null;
  /** FINAL price that goes to bulk-update (mandatory for "adjust"; sent for "accept" too). */
  appliedPrice?: number | null;
  /** Reject reason / free text (≤ 200 chars). */
  reason?: string | null;
};

/** Body of POST …/recommendations/apply (`ApplyBodySchema`, strict). */
export type ApplyRecommendationsInput = {
  from: string;
  to: string;
  ratePlanId: string;
  /** Window form only (exclusive with `cells`). */
  roomTypeIds?: string[];
  /** Window form only: subset of dates inside [from, to]; omitted = every day of the window. */
  dates?: string[];
  /** Cell form: the user's decisions per (roomType, date); dates must fall inside [from, to]. */
  cells?: ApplyRecommendationCell[];
  /** Journal entry of the bulk-update that carried these prices (sent AFTER that write succeeds). */
  journalId?: string | null;
  reason?: string;
  /** Also emit the suggested restrictions (minLos / cta) in the patches. Default false. */
  includeRestrictions?: boolean;
  /** Window form only: accept recommendations below this confidence? Default: the engine's holdBelow (40). */
  minConfidence?: number;
};

export type ApplyRecommendationsResponse = {
  propertyId: string;
  ratePlanId: string;
  from: string;
  to: string;
  /** Recommendations persisted (status "applied") = patches returned. */
  applied: number;
  /** Cells persisted as "rejected" (cell form only). */
  rejected?: number;
  /** `applied` + `rejected`. */
  recorded?: number;
  journalId?: string | null;
  skipped: Array<{ roomTypeId: string; date: string; reason: string }>;
  /** Patches the editor may send to bulk-update (the editor owns the write). */
  patches: RateGridCellPatch[];
  /** Suggested `reason` for the bulk-update journal entry. */
  reason: string;
  recommendationIds: string[];
};

export function applyRecommendations(
  propertyId: string,
  body: ApplyRecommendationsInput
): Promise<ApplyRecommendationsResponse> {
  return apiRequest<ApplyRecommendationsResponse>(`/properties/${propertyId}/rate-grid/recommendations/apply`, {
    method: "POST",
    body
  });
}
