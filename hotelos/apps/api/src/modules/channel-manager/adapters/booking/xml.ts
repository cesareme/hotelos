// OTA 2003B v1.1 builders and parsers for the Booking.com Connectivity API
// (rate grid v2 · replaces the placeholder <rates>/<availability> XML of v1).
//
// Endpoints these bodies are POSTed to (real mode):
//   https://supply-xml.booking.com/hotels/ota/OTA_HotelRateAmountNotif   (rates)
//   https://supply-xml.booking.com/hotels/ota/OTA_HotelAvailNotif        (availability + restrictions)
//   https://supply-xml.booking.com/hotels/ota/OTA_HotelResNotif          (reservations: GET, then POST ack)
//
// Element shapes (OTA_HotelRateAmountNotifRQ, per developers.booking.com
// ota-rateamountnotif: CurrencyCode and DecimalPlaces sit on BaseByGuestAmt,
// NumberOfGuests only for OBP/LOS pricing):
//   <RateAmountMessages HotelCode="12345">
//     <RateAmountMessage>
//       <StatusApplicationControl Start="2026-06-01" End="2026-06-01" InvTypeCode="BK-DBL" RatePlanCode="RP-BAR"/>
//       <Rates><Rate><BaseByGuestAmts>
//         <BaseByGuestAmt NumberOfGuests="2" AmountAfterTax="129.00" DecimalPlaces="2" CurrencyCode="EUR"/>
//       </BaseByGuestAmts></Rate></Rates>
//     </RateAmountMessage>
//   </RateAmountMessages>
// (OTA_HotelAvailNotifRQ, per ota-hotelavailnotif: ONE RestrictionStatus per
// AvailStatusMessage — the OTA schema allows 0..1 — so a restriction item
// becomes three messages (Master, Arrival, Departure) that repeat the same
// StatusApplicationControl; the LengthsOfStay and the advance-booking offsets
// ride on the Master message. LengthOfStay carries no TimeUnit, as in the
// extranet's own examples):
//   <AvailStatusMessages HotelCode="12345">
//     <AvailStatusMessage BookingLimit="5">
//       <StatusApplicationControl Start=".." End=".." InvTypeCode="BK-DBL"/>
//     </AvailStatusMessage>
//     <AvailStatusMessage>
//       <StatusApplicationControl Start=".." End=".." InvTypeCode="BK-DBL" RatePlanCode="RP-BAR"/>
//       <LengthsOfStay><LengthOfStay MinMaxMessageType="SetMinLOS" Time="2"/></LengthsOfStay>
//       <RestrictionStatus Status="Open" Restriction="Master" MinAdvancedBookingOffset="1D" MaxAdvancedBookingOffset="90D"/>
//     </AvailStatusMessage>
//     <AvailStatusMessage>
//       <StatusApplicationControl Start=".." End=".." InvTypeCode="BK-DBL" RatePlanCode="RP-BAR"/>
//       <RestrictionStatus Status="Close" Restriction="Arrival"/>
//     </AvailStatusMessage>
//   </AvailStatusMessages>
//
// Rates and availability: one message per item, in item order. Restrictions:
// three messages per item, and the builder returns the message → item map so
// the adapter can translate a RecordID of the RS back to the item (the
// simulator numbers RecordID by message; the extranet documents Code /
// ShortText / Details without RecordID, which the parser treats as request
// level).

import type { AvailabilityPushItem, RatePushItem, RestrictionPushItem } from "../../adapter.types.js";
import { OTA_NS, xmlAttr, xmlElements } from "../../sandbox/simulator.js";

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

function money(value: number): string {
  return (Math.round(value * 100) / 100).toFixed(2);
}

function rqOpen(root: string): string {
  return `${XML_DECL}\n<${root} ${attr("xmlns", OTA_NS)} ${attr("Version", "1.1")} ${attr("TimeStamp", new Date().toISOString())} ${attr("EchoToken", `anf-${Date.now()}`)}>`;
}

function statusApplicationControl(date: string, invTypeCode: string, ratePlanCode?: string): string {
  const parts = [attr("Start", date), attr("End", date), attr("InvTypeCode", invTypeCode)];
  if (ratePlanCode) parts.push(attr("RatePlanCode", ratePlanCode));
  return `<StatusApplicationControl ${parts.join(" ")}/>`;
}

/** Occupancy keys that are numeric guest counts ("1", "2"…); extraAdult/extraChild are supplements. */
function guestAmounts(item: RatePushItem): Array<{ guests?: number; amount: number }> {
  if (item.pricingModel === "obp" && item.occupancyPrices) {
    const rows = Object.entries(item.occupancyPrices)
      .filter(([k, v]) => /^\d+$/.test(k) && Number.isFinite(v))
      .map(([k, v]) => ({ guests: Number(k), amount: v }))
      .sort((a, b) => a.guests - b.guests);
    if (rows.length > 0) return rows;
  }
  return [{ amount: item.amount ?? Number.NaN }];
}

/**
 * Occupancy keys the OTA_HotelRateAmountNotif message cannot carry: Booking
 * prices per NumberOfGuests only, so supplements such as extraAdult /
 * extraChild are reported as a warning instead of being dropped in silence.
 */
export function unsupportedOccupancyKeys(items: RatePushItem[]): string[] {
  const keys = new Set<string>();
  for (const item of items) for (const k of Object.keys(item.occupancyPrices ?? {})) if (!/^\d+$/.test(k)) keys.add(k);
  return [...keys].sort();
}

export function buildRateAmountNotifXml(input: { hotelCode: string; items: RatePushItem[] }): string {
  const messages = input.items
    .map((item) => {
      const amounts = guestAmounts(item)
        .map(
          (a) =>
            `<BaseByGuestAmt${a.guests !== undefined ? ` ${attr("NumberOfGuests", a.guests)}` : ""} ${attr("AmountAfterTax", money(a.amount))} ${attr("DecimalPlaces", 2)} ${attr("CurrencyCode", item.currency)}/>`
        )
        .join("");
      return [
        "<RateAmountMessage>",
        statusApplicationControl(item.date, item.externalRoomCode, item.externalRateCode),
        `<Rates><Rate><BaseByGuestAmts>${amounts}</BaseByGuestAmts></Rate></Rates>`,
        "</RateAmountMessage>"
      ].join("");
    })
    .join("\n");
  return `${rqOpen("OTA_HotelRateAmountNotifRQ")}\n<RateAmountMessages ${attr("HotelCode", input.hotelCode)}>\n${messages}\n</RateAmountMessages>\n</OTA_HotelRateAmountNotifRQ>`;
}

export function buildAvailNotifXml(input: { hotelCode: string; items: AvailabilityPushItem[] }): string {
  const messages = input.items
    .map(
      (item) =>
        `<AvailStatusMessage ${attr("BookingLimit", Math.max(0, Math.floor(item.count)))}>${statusApplicationControl(item.date, item.externalRoomCode)}</AvailStatusMessage>`
    )
    .join("\n");
  return `${rqOpen("OTA_HotelAvailNotifRQ")}\n<AvailStatusMessages ${attr("HotelCode", input.hotelCode)}>\n${messages}\n</AvailStatusMessages>\n</OTA_HotelAvailNotifRQ>`;
}

export type RestrictionsNotif = {
  xml: string;
  /** Message index (the RecordID the simulator answers with) → index of the item that produced it. */
  itemIndexByMessage: number[];
};

/** Booking advance-booking offsets: `nD` (days), max 360D per the extranet doc. */
function advanceOffset(days: number): string {
  return `${Math.min(360, Math.max(1, Math.floor(days)))}D`;
}

/**
 * Restrictions → OTA_HotelAvailNotifRQ. One AvailStatusMessage per
 * RestrictionStatus (Master / Arrival / Departure), every one repeating the
 * StatusApplicationControl of the item: the OTA schema admits at most one
 * RestrictionStatus per message. Master = the whole (room, plan) is closed;
 * plan-level `closed` and room-level `stopSell` both map onto it (Booking has
 * one switch). LengthsOfStay and the advance-booking offsets go on the
 * Master message.
 */
export function buildRestrictionsNotif(input: { hotelCode: string; items: RestrictionPushItem[] }): RestrictionsNotif {
  const messages: string[] = [];
  const itemIndexByMessage: number[] = [];
  input.items.forEach((item, itemIndex) => {
    const control = statusApplicationControl(item.date, item.externalRoomCode, item.externalRateCode);
    const los: string[] = [];
    if (typeof item.minStay === "number") los.push(`<LengthOfStay ${attr("MinMaxMessageType", "SetMinLOS")} ${attr("Time", item.minStay)}/>`);
    if (typeof item.maxStay === "number") los.push(`<LengthOfStay ${attr("MinMaxMessageType", "SetMaxLOS")} ${attr("Time", item.maxStay)}/>`);
    if (typeof item.minStayThrough === "number") los.push(`<LengthOfStay ${attr("MinMaxMessageType", "SetForwardMinStay")} ${attr("Time", item.minStayThrough)}/>`);
    const master = [attr("Status", item.closed || item.stopSell ? "Close" : "Open"), attr("Restriction", "Master")];
    if (typeof item.minAdvanceDays === "number" && item.minAdvanceDays > 0) master.push(attr("MinAdvancedBookingOffset", advanceOffset(item.minAdvanceDays)));
    if (typeof item.maxAdvanceDays === "number" && item.maxAdvanceDays > 0) master.push(attr("MaxAdvancedBookingOffset", advanceOffset(item.maxAdvanceDays)));
    const statuses = [
      `<RestrictionStatus ${master.join(" ")}/>`,
      `<RestrictionStatus ${attr("Status", item.cta ? "Close" : "Open")} ${attr("Restriction", "Arrival")}/>`,
      `<RestrictionStatus ${attr("Status", item.ctd ? "Close" : "Open")} ${attr("Restriction", "Departure")}/>`
    ];
    statuses.forEach((status, i) => {
      messages.push(["<AvailStatusMessage>", control, i === 0 && los.length ? `<LengthsOfStay>${los.join("")}</LengthsOfStay>` : "", status, "</AvailStatusMessage>"].join(""));
      itemIndexByMessage.push(itemIndex);
    });
  });
  const xml = `${rqOpen("OTA_HotelAvailNotifRQ")}\n<AvailStatusMessages ${attr("HotelCode", input.hotelCode)}>\n${messages.join("\n")}\n</AvailStatusMessages>\n</OTA_HotelAvailNotifRQ>`;
  return { xml, itemIndexByMessage };
}

export function buildRestrictionsNotifXml(input: { hotelCode: string; items: RestrictionPushItem[] }): string {
  return buildRestrictionsNotif(input).xml;
}

export type OtaResponse = {
  success: boolean;
  errors: Array<{ code: string; shortText: string; recordId?: number }>;
  warnings: string[];
};

export function parseOtaResponse(body: string): OtaResponse {
  const errors = xmlElements(body, "Error").map((e) => {
    const rec = xmlAttr(e.tag, "RecordID");
    return {
      code: xmlAttr(e.tag, "Code") ?? "unknown",
      shortText: xmlAttr(e.tag, "ShortText") ?? e.inner.trim() ?? "",
      ...(rec !== null && rec !== "" && Number.isInteger(Number(rec)) ? { recordId: Number(rec) } : {})
    };
  });
  const warnings = xmlElements(body, "Warning").map((w) => xmlAttr(w.tag, "ShortText") ?? w.inner.trim());
  const success = /<Success\s*\/>/.test(body) || /<Success>/.test(body);
  return { success: success && errors.length === 0, errors, warnings };
}

// ---------------------------------------------------------------- reservations

export type BookingReservation = {
  externalReference: string;
  /** commit | modify | cancel (OTA ResStatus, lower-cased) */
  status: string;
  arrivalDate: string | null;
  departureDate: string | null;
  guestName: string | null;
  totalAmount: number | null;
  currency: string | null;
  rawXml: string;
};

/** Parses an OTA_HotelResNotifRQ feed (GET OTA_HotelResNotif) into flat DTOs. */
export function parseResNotifXml(xml: string): BookingReservation[] {
  return xmlElements(xml, "HotelReservation").map((r, i) => {
    const unique = xmlElements(r.inner, "UniqueID")[0];
    const stay = xmlElements(r.inner, "TimeSpan")[0];
    const total = xmlElements(r.inner, "Total")[0];
    const given = xmlElements(r.inner, "GivenName")[0]?.inner.trim() ?? "";
    const surname = xmlElements(r.inner, "Surname")[0]?.inner.trim() ?? "";
    const status = (xmlAttr(r.tag, "ResStatus") ?? "commit").toLowerCase();
    return {
      externalReference: (unique ? xmlAttr(unique.tag, "ID") : null) ?? `booking-unknown-${i}`,
      status,
      arrivalDate: stay ? xmlAttr(stay.tag, "Start") : null,
      departureDate: stay ? xmlAttr(stay.tag, "End") : null,
      guestName: `${given} ${surname}`.trim() || null,
      totalAmount: total && xmlAttr(total.tag, "AmountAfterTax") !== null ? Number(xmlAttr(total.tag, "AmountAfterTax")) : null,
      currency: total ? xmlAttr(total.tag, "CurrencyCode") : null,
      rawXml: r.tag + r.inner
    };
  });
}

/** OTA_HotelResNotifRS acknowledging the given reservation ids (POST OTA_HotelResNotif). */
export function buildResNotifAckXml(ids: string[]): string {
  const rows = ids.map((id) => `<HotelReservation><UniqueID ${attr("Type", 14)} ${attr("ID", id)}/></HotelReservation>`).join("");
  return `${rqOpen("OTA_HotelResNotifRS")}<Success/><HotelReservations>${rows}</HotelReservations></OTA_HotelResNotifRS>`;
}
