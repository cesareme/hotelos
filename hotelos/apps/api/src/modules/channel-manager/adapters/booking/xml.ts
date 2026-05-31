// XML builders for the Booking.com Distribution / Connectivity API.
//
// The endpoints accept text/xml; charset=utf-8 with a vaguely-XHTML-style
// schema. The exact element names + attributes vary per product version; the
// canonical reference lives at https://developers.booking.com (partner login
// required). We use placeholder element names that mirror Booking's published
// XML examples — production deployments must align these with the certified
// schema for the connected hotel.
//
// Schemas referenced:
//   availability  → https://developers.booking.com/connectivity/docs/availability
//   rates         → https://developers.booking.com/connectivity/docs/rates
//   restrictions  → https://developers.booking.com/connectivity/docs/restrictions
//
// All builders return well-formed UTF-8 XML strings with the XML declaration.
// Values that may contain user-supplied content (none today, but defensive)
// are escaped via escapeXml().

import type {
  AvailabilityPushItem,
  RatePushItem,
  RestrictionPushItem
} from "../../adapter.types.js";

const XML_DECL = '<?xml version="1.0" encoding="UTF-8"?>';

export function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function attr(name: string, value: string | number | boolean): string {
  return `${name}="${escapeXml(String(value))}"`;
}

// ---------- availability ----------
// Booking expects per-(room_id, date) inventory counts. Multiple <room> nodes
// per <availability> envelope; each <room> can carry one or more <date> nodes.
// We emit one <room> per item for simplicity — the aggregator may pack later.
//
// Example shape:
//   <availability>
//     <room id="ROOM-101">
//       <date value="2026-05-20" rooms_to_sell="5"/>
//     </room>
//   </availability>
export function buildAvailabilityXml(items: AvailabilityPushItem[]): string {
  const rooms = items
    .map((item) => {
      return [
        `  <room ${attr("id", item.roomTypeId)}>`,
        `    <date ${attr("value", item.date)} ${attr("rooms_to_sell", item.count)}/>`,
        `  </room>`
      ].join("\n");
    })
    .join("\n");
  return `${XML_DECL}\n<availability>\n${rooms}\n</availability>`;
}

// ---------- rates ----------
// Per-(rate_plan_id, date) prices. The currency comes from the hotel
// configuration on Booking's side, but we emit it as an attribute so an audit
// trail captures what *we* sent.
//
//   <rates>
//     <rate rate_plan_id="RP-FLEX" date="2026-05-20" price="129.00" currency="EUR"/>
//   </rates>
export function buildRatesXml(items: RatePushItem[]): string {
  const nodes = items
    .map((item) => {
      return `  <rate ${attr("rate_plan_id", item.ratePlanId)} ${attr("date", item.date)} ${attr(
        "price",
        item.amount.toFixed(2)
      )} ${attr("currency", item.currency)}/>`;
    })
    .join("\n");
  return `${XML_DECL}\n<rates>\n${nodes}\n</rates>`;
}

// ---------- restrictions ----------
// Booking models restrictions as a flat list of <restriction> nodes scoped by
// (room_type_id, rate_plan_id?, date). Unset attributes are simply omitted.
//
//   <restrictions>
//     <restriction room_type_id="ROOM-101" rate_plan_id="RP-FLEX" date="2026-05-20"
//                  min_stay="2" max_stay="14" cta="true" ctd="false" closed="false"/>
//   </restrictions>
export function buildRestrictionsXml(items: RestrictionPushItem[]): string {
  const nodes = items
    .map((item) => {
      const parts: string[] = [];
      parts.push(attr("room_type_id", item.roomTypeId));
      if (item.ratePlanId) parts.push(attr("rate_plan_id", item.ratePlanId));
      parts.push(attr("date", item.date));
      if (typeof item.minStay === "number") parts.push(attr("min_stay", item.minStay));
      if (typeof item.maxStay === "number") parts.push(attr("max_stay", item.maxStay));
      if (typeof item.cta === "boolean") parts.push(attr("cta", item.cta));
      if (typeof item.ctd === "boolean") parts.push(attr("ctd", item.ctd));
      if (typeof item.closed === "boolean") parts.push(attr("closed", item.closed));
      return `  <restriction ${parts.join(" ")}/>`;
    })
    .join("\n");
  return `${XML_DECL}\n<restrictions>\n${nodes}\n</restrictions>`;
}
