// Expedia QuickConnect (EQC) Availability & Rates XML builders (rate grid v2).
//
// The v1 adapter described EQC as "v3 JSON": it is not. EQC AR is XML over
// HTTPS with the credentials INSIDE the body:
//
//   POST https://services.expediapartnercentral.com/eqc/ar
//   <AvailRateUpdateRQ xmlns="http://www.expediaconnect.com/EQC/AR/2007/02">
//     <Authentication username="EQC…" password="…"/>
//     <Hotel id="12345"/>
//     <AvailRateUpdate>
//       <DateRange from="2026-06-01" to="2026-06-01"/>
//       <RoomType id="EX-DBL" closed="false">
//         <Inventory totalInventoryAvailable="5"/>
//         <RatePlan id="RP-BAR" closed="false">
//           <Rate currency="EUR"><PerDay rate="129.00"/></Rate>
//           <Restrictions minLOS="2" maxLOS="14" closedToArrival="false" closedToDeparture="false"/>
//         </RatePlan>
//       </RoomType>
//     </AvailRateUpdate>
//   </AvailRateUpdateRQ>
//   Response: <AvailRateUpdateRS><Success/></AvailRateUpdateRS>, or
//   <Success><Warning code="3260">…</Warning></Success> when the update was
//   applied with notices, or <Error code="…">text</Error>. Error codes: 1xxx
//   authentication, 2xxx/3xxx schema and business (definitive), 4xxx system
//   ("please retry": transient).
//
// The availability message carries only the inventory: RoomType@closed is
// owned by the restrictions message (an omitted attribute is "no change" in
// EQC AR), otherwise a stop sell pushed seconds earlier would be reopened by
// the availability push that follows it.
//
// Booking retrieval (/eqc/br) and confirmation (/eqc/bc) use the sibling BR/BC
// namespaces (…/EQC/BR/2007/02, …/EQC/BC/2007/09) with the same Authentication
// element. One <AvailRateUpdate> per item in item order.

import type { AvailabilityPushItem, RatePushItem, RestrictionPushItem } from "../../adapter.types.js";
import { EQC_AR_NS, xmlAttr, xmlElements } from "../../sandbox/simulator.js";

export const EQC_BR_NS = "http://www.expediaconnect.com/EQC/BR/2007/02";
export const EQC_BC_NS = "http://www.expediaconnect.com/EQC/BC/2007/09";

const XML_DECL = '<?xml version="1.0" encoding="UTF-8"?>';

function esc(value: string | number | boolean): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function money(value: number): string {
  return (Math.round(value * 100) / 100).toFixed(2);
}

export type EqcAuth = { username: string; password: string; hotelId: string };

function open(root: string, ns: string, auth: EqcAuth): string {
  return `${XML_DECL}\n<${root} xmlns="${ns}">\n<Authentication username="${esc(auth.username)}" password="${esc(auth.password)}"/>\n<Hotel id="${esc(auth.hotelId)}"/>`;
}

export function buildAvailRateUpdateRatesXml(auth: EqcAuth, items: RatePushItem[]): string {
  const updates = items
    .map((item) => {
      const rate =
        item.pricingModel === "obp" && item.occupancyPrices
          ? Object.entries(item.occupancyPrices)
              .filter(([k, v]) => /^\d+$/.test(k) && Number.isFinite(v))
              .map(([k, v]) => `<PerOccupancy rate="${money(v)}" occupancy="${esc(k)}"/>`)
              .join("")
          : `<PerDay rate="${money(item.amount ?? Number.NaN)}"/>`;
      return `<AvailRateUpdate><DateRange from="${esc(item.date)}" to="${esc(item.date)}"/><RoomType id="${esc(item.externalRoomCode)}"><RatePlan id="${esc(item.externalRateCode)}"><Rate currency="${esc(item.currency)}">${rate}</Rate></RatePlan></RoomType></AvailRateUpdate>`;
    })
    .join("\n");
  return `${open("AvailRateUpdateRQ", EQC_AR_NS, auth)}\n${updates}\n</AvailRateUpdateRQ>`;
}

export function buildAvailRateUpdateAvailabilityXml(auth: EqcAuth, items: AvailabilityPushItem[]): string {
  const updates = items
    .map(
      (item) =>
        `<AvailRateUpdate><DateRange from="${esc(item.date)}" to="${esc(item.date)}"/><RoomType id="${esc(item.externalRoomCode)}"><Inventory totalInventoryAvailable="${Math.max(0, Math.floor(item.count))}"/></RoomType></AvailRateUpdate>`
    )
    .join("\n");
  return `${open("AvailRateUpdateRQ", EQC_AR_NS, auth)}\n${updates}\n</AvailRateUpdateRQ>`;
}

export function buildAvailRateUpdateRestrictionsXml(auth: EqcAuth, items: RestrictionPushItem[]): string {
  const updates = items
    .map((item) => {
      const restr: string[] = [];
      if (typeof item.minStay === "number") restr.push(`minLOS="${item.minStay}"`);
      if (typeof item.maxStay === "number") restr.push(`maxLOS="${item.maxStay}"`);
      restr.push(`closedToArrival="${item.cta}"`, `closedToDeparture="${item.ctd}"`);
      const plan = item.externalRateCode
        ? `<RatePlan id="${esc(item.externalRateCode)}" closed="${item.closed}"><Restrictions ${restr.join(" ")}/></RatePlan>`
        : "";
      return `<AvailRateUpdate><DateRange from="${esc(item.date)}" to="${esc(item.date)}"/><RoomType id="${esc(item.externalRoomCode)}" closed="${item.stopSell}">${plan}</RoomType></AvailRateUpdate>`;
    })
    .join("\n");
  return `${open("AvailRateUpdateRQ", EQC_AR_NS, auth)}\n${updates}\n</AvailRateUpdateRQ>`;
}

/** Booking retrieval request (EQC BR): pending bookings for the hotel. */
export function buildBookingRetrievalXml(auth: EqcAuth): string {
  return `${open("BookingRetrievalRQ", EQC_BR_NS, auth)}\n<ParamSet><Status>pending</Status></ParamSet>\n</BookingRetrievalRQ>`;
}

/** Booking confirmation (EQC BC): confirms the given bookings with our PMS confirmation numbers. */
export function buildBookingConfirmXml(auth: EqcAuth, bookings: Array<{ id: string; confirmNumber: string }>): string {
  const rows = bookings.map((b) => `<Booking id="${esc(b.id)}" type="Book" confirmNumber="${esc(b.confirmNumber)}"/>`).join("");
  return `${open("BookingConfirmRQ", EQC_BC_NS, auth)}\n${rows}\n</BookingConfirmRQ>`;
}

export type EqcResponse = { success: boolean; error: { code: string; message: string } | null; warnings: string[] };

/** EQC 4xxx = system error the provider asks to retry; everything else is definitive. */
export function isTransientEqcCode(code: string): boolean {
  return /^4\d{3}$/.test(code);
}

export function parseEqcResponse(body: string): EqcResponse {
  const warnings = xmlElements(body, "Warning").map((w) => `${xmlAttr(w.tag, "code") ?? "warning"}: ${w.inner.trim()}`);
  const err = xmlElements(body, "Error")[0];
  if (err) return { success: false, error: { code: xmlAttr(err.tag, "code") ?? "unknown", message: err.inner.trim() }, warnings };
  // <Success/> or <Success><Warning …/></Success>: both mean "applied".
  return { success: /<Success(\s[^>]*)?\/?>/.test(body), error: null, warnings };
}

export type EqcBooking = {
  id: string;
  type: string;
  status: string;
  arrivalDate: string | null;
  departureDate: string | null;
  guestName: string | null;
  totalAmount: number | null;
  currency: string | null;
  rawXml: string;
};

export function parseBookingRetrievalXml(body: string): EqcBooking[] {
  return xmlElements(body, "Booking").map((b, i) => {
    const stay = xmlElements(b.inner, "StayDate")[0];
    const total = xmlElements(b.inner, "Total")[0];
    const contact = xmlElements(b.inner, "Name")[0];
    return {
      id: xmlAttr(b.tag, "id") ?? `expedia-unknown-${i}`,
      type: xmlAttr(b.tag, "type") ?? "Book",
      status: (xmlAttr(b.tag, "status") ?? "pending").toLowerCase(),
      arrivalDate: stay ? xmlAttr(stay.tag, "arrival") : null,
      departureDate: stay ? xmlAttr(stay.tag, "departure") : null,
      guestName: contact ? `${xmlAttr(contact.tag, "givenName") ?? ""} ${xmlAttr(contact.tag, "surname") ?? ""}`.trim() || null : null,
      totalAmount: total && xmlAttr(total.tag, "amount") !== null ? Number(xmlAttr(total.tag, "amount")) : null,
      currency: total ? xmlAttr(total.tag, "currency") : null,
      rawXml: b.tag + b.inner
    };
  });
}
