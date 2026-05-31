// JSON payload builders for the Airbnb Software Partner API.
//
// Airbnb has no "rate plan" concept — each listing is a single inventory unit
// with one price ladder. Calendar (availability + min nights) and pricing are
// PUT against the listing as date-keyed arrays.
//
// Schemas referenced (partner login required):
//   Calendar → https://developer.airbnb.com/docs/listings-calendar
//   Pricing  → https://developer.airbnb.com/docs/listings-pricing
//
// The objects returned here are plain JSON-serializable structures; the adapter
// JSON.stringify()s them before handing off to http.putJson().

import type {
  AvailabilityPushItem,
  RatePushItem,
  RestrictionPushItem
} from "../../adapter.types.js";

export type AirbnbPricingPayload = {
  daily_prices: Array<{ date: string; native_price: number; native_currency: string }>;
};

export type AirbnbCalendarPayload = {
  calendar: Array<{ date: string; available: boolean; availability: number }>;
};

export type AirbnbAvailabilityRulesPayload = {
  availability_rules: Array<Record<string, unknown>>;
};

// ---------- rates ----------
// PUT /v2/listings/{listingId}/pricing  →  { daily_prices: [...] }
export function buildPricingPayload(items: RatePushItem[]): AirbnbPricingPayload {
  return {
    daily_prices: items.map((item) => ({
      date: item.date,
      native_price: Number(item.amount.toFixed(2)),
      native_currency: item.currency
    }))
  };
}

// ---------- availability ----------
// PUT /v2/listings/{listingId}/calendar  →  { calendar: [...] }
export function buildCalendarPayload(items: AvailabilityPushItem[]): AirbnbCalendarPayload {
  return {
    calendar: items.map((item) => ({
      date: item.date,
      available: item.count > 0,
      availability: item.count
    }))
  };
}

// ---------- restrictions ----------
// PUT /v2/listings/{listingId}/availability_rules  →  { availability_rules: [...] }
// Airbnb has no CTD; we map cta → closed_for_checkin and closed → blocked.
export function buildAvailabilityRulesPayload(
  items: RestrictionPushItem[]
): AirbnbAvailabilityRulesPayload {
  return {
    availability_rules: items.map((item) => {
      const rule: Record<string, unknown> = { date: item.date };
      if (typeof item.minStay === "number") rule.min_nights = item.minStay;
      if (typeof item.maxStay === "number") rule.max_nights = item.maxStay;
      if (typeof item.cta === "boolean") rule.closed_for_checkin = item.cta;
      if (typeof item.ctd === "boolean") rule.closed_for_checkout = item.ctd;
      if (typeof item.closed === "boolean") rule.available = !item.closed;
      return rule;
    })
  };
}
