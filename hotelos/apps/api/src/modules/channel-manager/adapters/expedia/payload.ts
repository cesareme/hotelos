// JSON payload builders for the Expedia EQC ("Quick Connect") REST API.
//
// EQC v3 takes JSON (v2 was XML). Availability + rates are pushed together to
// the /eqc/ar endpoint; restrictions ride the same AR message. Reservations are
// pulled from /eqc/br (booking retrieval).
//
// Schemas referenced (partner login required):
//   AR (Availability & Rates) → https://developers.expediagroup.com/eqc/lodging/products/ar
//   BR (Booking Retrieval)    → https://developers.expediagroup.com/eqc/lodging/products/br
//
// The shapes below mirror Expedia's published examples. Production deployments
// must align field names with the certified schema for the connected property.
// The objects returned here are plain JSON-serializable structures; the adapter
// JSON.stringify()s them before handing off to http.postJson().

import type {
  AvailabilityPushItem,
  RatePushItem,
  RestrictionPushItem
} from "../../adapter.types.js";

export type ExpediaArPayload = {
  Authentication?: { resortID?: string };
  AvailRateUpdate: Array<Record<string, unknown>>;
};

// ---------- rates ----------
// Each AvailRateUpdate entry carries a date range + a RateAmountUpdate. We emit
// one node per (ratePlanId, date) item; EQC collapses contiguous dates server-
// side, but the aggregator can pack ranges in a later sprint.
export function buildRatesPayload(items: RatePushItem[], resortId?: string): ExpediaArPayload {
  const updates = items.map((item) => ({
    DateRange: { From: item.date, To: item.date },
    RateAmountUpdate: {
      RatePlanID: item.ratePlanId,
      Rate: {
        Currency: item.currency,
        BaseByGuestAmt: Number(item.amount.toFixed(2))
      }
    }
  }));
  return withAuth({ AvailRateUpdate: updates }, resortId);
}

// ---------- availability ----------
// Inventory is expressed as Inv count per (roomTypeId, date).
export function buildAvailabilityPayload(
  items: AvailabilityPushItem[],
  resortId?: string
): ExpediaArPayload {
  const updates = items.map((item) => ({
    DateRange: { From: item.date, To: item.date },
    RoomTypeID: item.roomTypeId,
    Inv: { TotalInventoryAvailable: item.count }
  }));
  return withAuth({ AvailRateUpdate: updates }, resortId);
}

// ---------- restrictions ----------
// MinLOS / MaxLOS / CTA / CTD / stop-sell ride the same AR envelope as a
// RestrictionStatus + StayRestriction block per (roomTypeId, ratePlanId?, date).
export function buildRestrictionsPayload(
  items: RestrictionPushItem[],
  resortId?: string
): ExpediaArPayload {
  const updates = items.map((item) => {
    const node: Record<string, unknown> = {
      DateRange: { From: item.date, To: item.date },
      RoomTypeID: item.roomTypeId
    };
    if (item.ratePlanId) node.RatePlanID = item.ratePlanId;
    const stay: Record<string, unknown> = {};
    if (typeof item.minStay === "number") stay.MinLOS = item.minStay;
    if (typeof item.maxStay === "number") stay.MaxLOS = item.maxStay;
    if (Object.keys(stay).length > 0) node.StayRestriction = stay;
    const status: Record<string, unknown> = {};
    if (typeof item.cta === "boolean") status.ClosedToArrival = item.cta;
    if (typeof item.ctd === "boolean") status.ClosedToDeparture = item.ctd;
    if (typeof item.closed === "boolean") status.Closed = item.closed;
    if (Object.keys(status).length > 0) node.RestrictionStatus = status;
    return node;
  });
  return withAuth({ AvailRateUpdate: updates }, resortId);
}

function withAuth(payload: { AvailRateUpdate: Array<Record<string, unknown>> }, resortId?: string): ExpediaArPayload {
  if (resortId) {
    return { Authentication: { resortID: resortId }, ...payload };
  }
  return payload;
}
