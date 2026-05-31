// JSON payload builders for the Hotelbeds APItude API.
//
// Hotelbeds is a wholesaler/bedbank: rates pushed here are NET rates that they
// resell with their own markup. Inventory is allotment-based (a block of rooms
// released to the channel), and rates/restrictions are keyed by the Hotelbeds
// rate-plan ("rate key") + room code.
//
// Schemas referenced:
//   Cache / availability  → https://developer.hotelbeds.com/documentation/hotels/booking-api/api-reference/
//   Rates / inventory     → https://developer.hotelbeds.com/documentation/hotels/content-api/api-reference/
//
// The objects returned here are plain JSON-serializable structures; the adapter
// JSON.stringify()s them before handing off to http.signedRequest().

import type {
  AvailabilityPushItem,
  RatePushItem,
  RestrictionPushItem
} from "../../adapter.types.js";

export type HotelbedsRatesPayload = {
  rates: Array<{ from: string; to: string; rateKey: string; net: number; currency: string }>;
};

export type HotelbedsInventoryPayload = {
  inventory: Array<{ from: string; to: string; roomCode: string; allotment: number }>;
};

export type HotelbedsRestrictionsPayload = {
  restrictions: Array<Record<string, unknown>>;
};

// ---------- rates ----------
// Net rates per (rateKey, date). Single-day windows; the aggregator may pack
// contiguous ranges later.
export function buildRatesPayload(items: RatePushItem[]): HotelbedsRatesPayload {
  return {
    rates: items.map((item) => ({
      from: item.date,
      to: item.date,
      rateKey: item.ratePlanId,
      net: Number(item.amount.toFixed(2)),
      currency: item.currency
    }))
  };
}

// ---------- availability ----------
// Allotment release per (roomCode, date).
export function buildInventoryPayload(items: AvailabilityPushItem[]): HotelbedsInventoryPayload {
  return {
    inventory: items.map((item) => ({
      from: item.date,
      to: item.date,
      roomCode: item.roomTypeId,
      allotment: item.count
    }))
  };
}

// ---------- restrictions ----------
// Stop-sell + MLOS/MaxLOS + CTA/CTD per (roomCode, rateKey?, date).
export function buildRestrictionsPayload(items: RestrictionPushItem[]): HotelbedsRestrictionsPayload {
  return {
    restrictions: items.map((item) => {
      const node: Record<string, unknown> = {
        from: item.date,
        to: item.date,
        roomCode: item.roomTypeId
      };
      if (item.ratePlanId) node.rateKey = item.ratePlanId;
      if (typeof item.minStay === "number") node.minimumStay = item.minStay;
      if (typeof item.maxStay === "number") node.maximumStay = item.maxStay;
      if (typeof item.cta === "boolean") node.closedToArrival = item.cta;
      if (typeof item.ctd === "boolean") node.closedToDeparture = item.ctd;
      if (typeof item.closed === "boolean") node.stopSale = item.closed;
      return node;
    })
  };
}
