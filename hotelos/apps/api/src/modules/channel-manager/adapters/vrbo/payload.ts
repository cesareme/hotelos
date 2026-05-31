// JSON payload builders for the Vrbo (Expedia Group) software-partner API.
//
// Vrbo reuses the EQC AR (Availability & Rate) message shape but addresses a
// SEPARATE listing namespace: nodes are keyed by listingId / propertyId rather
// than the resort/roomType pair Expedia hotels use, and Vrbo is whole-unit only
// (no rate plans beyond the single unit price ladder).
//
// Schemas referenced (partner login required):
//   Vrbo Availability & Rates → https://developers.expediagroup.com/vrbo/products/availability-rates
//   Vrbo Reservations         → https://developers.expediagroup.com/vrbo/products/reservations
//
// The objects returned here are plain JSON-serializable structures; the adapter
// JSON.stringify()s them before handing off to http.postJson().

import type {
  AvailabilityPushItem,
  RatePushItem,
  RestrictionPushItem
} from "../../adapter.types.js";

export type VrboArPayload = {
  listingId?: string;
  availRateUpdate: Array<Record<string, unknown>>;
};

// ---------- rates ----------
// Whole-unit nightly rate per date. Vrbo has no rate-plan concept, so we collapse
// onto the listing; ratePlanId is retained as a tag for our own audit trail.
export function buildRatesPayload(items: RatePushItem[], listingId?: string): VrboArPayload {
  const updates = items.map((item) => ({
    dateRange: { from: item.date, to: item.date },
    rate: {
      ratePlanId: item.ratePlanId,
      currency: item.currency,
      nightlyAmount: Number(item.amount.toFixed(2))
    }
  }));
  return withListing({ availRateUpdate: updates }, listingId);
}

// ---------- availability ----------
// Whole-unit availability: count > 0 → bookable, 0 → blocked.
export function buildAvailabilityPayload(
  items: AvailabilityPushItem[],
  listingId?: string
): VrboArPayload {
  const updates = items.map((item) => ({
    dateRange: { from: item.date, to: item.date },
    unitId: item.roomTypeId,
    availability: { available: item.count > 0, units: item.count }
  }));
  return withListing({ availRateUpdate: updates }, listingId);
}

// ---------- restrictions ----------
// MinStay / MaxStay / CTA / CTD / closed per (unit, date).
export function buildRestrictionsPayload(
  items: RestrictionPushItem[],
  listingId?: string
): VrboArPayload {
  const updates = items.map((item) => {
    const node: Record<string, unknown> = {
      dateRange: { from: item.date, to: item.date },
      unitId: item.roomTypeId
    };
    if (item.ratePlanId) node.ratePlanId = item.ratePlanId;
    const stay: Record<string, unknown> = {};
    if (typeof item.minStay === "number") stay.minStay = item.minStay;
    if (typeof item.maxStay === "number") stay.maxStay = item.maxStay;
    if (typeof item.cta === "boolean") stay.closedToArrival = item.cta;
    if (typeof item.ctd === "boolean") stay.closedToDeparture = item.ctd;
    if (typeof item.closed === "boolean") stay.closed = item.closed;
    if (Object.keys(stay).length > 0) node.restriction = stay;
    return node;
  });
  return withListing({ availRateUpdate: updates }, listingId);
}

function withListing(payload: { availRateUpdate: Array<Record<string, unknown>> }, listingId?: string): VrboArPayload {
  if (listingId) {
    return { listingId, ...payload };
  }
  return payload;
}
