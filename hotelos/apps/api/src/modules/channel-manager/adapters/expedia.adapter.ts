// Expedia adapter.
//
// Two execution modes, selected by env var:
//
//   EXPEDIA_ADAPTER_MODE=stub   (default) — deterministic in-process responses.
//   EXPEDIA_ADAPTER_MODE=real             — hits the real Expedia EQC / Rapid
//                                           "Quick Connect" REST+JSON API via
//                                           OAuth2 client_credentials.
//
// Real-mode endpoints (override the base via EXPEDIA_API_BASE_URL for sandbox):
//   POST {base}/eqc/ar    (availability + rates + restrictions, AR message — JSON)
//   GET  {base}/eqc/br    (reservations / booking retrieval)
//   POST oauth /authentication/v1/token  (token exchange)
//
//   Docs: https://developers.expediagroup.com/eqc
//
// CREDENTIALS:
//   channel.credentialsJson must contain { client_id, client_secret }. Optional:
//   { resortID / eqcId } to scope the AR message. client_secret is a high-value
//   secret handled exactly like Booking (plain credentialsJson today; moves
//   behind credentialsSecretRef in a later sprint).

import type {
  AdapterResult,
  ChannelAdapter,
  ChannelContext,
  ExternalReservationDTO
} from "../adapter.types.js";
import { ExpediaOAuthError, getAccessToken } from "./expedia/auth.js";
import { getJson, postJson } from "./expedia/http.js";
import {
  buildAvailabilityPayload,
  buildRatesPayload,
  buildRestrictionsPayload
} from "./expedia/payload.js";
import {
  buildStubCompetitorRates,
  buildStubReservations,
  isInvalidCredentials,
  seedHash,
  simulateLatency
} from "./stub-utils.js";

const PROVIDER = "expedia" as const;
const DEFAULT_API_BASE_URL = "https://services.expediapartnercentral.com";

type AdapterMode = "stub" | "real";

function resolveMode(): AdapterMode {
  return process.env.EXPEDIA_ADAPTER_MODE === "real" ? "real" : "stub";
}

function resolveBaseUrl(): string {
  const base = process.env.EXPEDIA_API_BASE_URL || DEFAULT_API_BASE_URL;
  return base.endsWith("/") ? base.slice(0, -1) : base;
}

function endpoint(path: string): string {
  return `${resolveBaseUrl()}${path}`;
}

function resortId(channel: ChannelContext): string | undefined {
  const creds = channel.credentialsJson;
  const id = creds?.resortID ?? creds?.resortId ?? creds?.eqcId;
  return typeof id === "string" ? id : undefined;
}

// Coarse XML/JSON parser for the Expedia EQC BR (Booking Retrieval) message.
//
// The EQC "Quick Connect" spec emits BookingNotification XML envelopes shaped
// roughly like:
//
//   <BookingNotifRQ>
//     <Bookings>
//       <Booking ConfirmationNumber="..." Status="Book">
//         <RoomStays>
//           <RoomStay RatePlanCode="..." RoomTypeCode="..." Start="YYYY-MM-DD" End="YYYY-MM-DD">
//             <Total Amount="123.45" Currency="EUR"/>
//             <GuestList>
//               <Guest><GivenName>...</GivenName><Surname>...</Surname></Guest>
//             </GuestList>
//           </RoomStay>
//         </RoomStays>
//       </Booking>
//     </Bookings>
//   </BookingNotifRQ>
//
// EQC can also emit JSON (newer accounts) with a `Bookings:[{ConfirmationNumber,
// Status, RoomStays:[...]}]` shape. We accept both — for the demo this is
// regex-based and intentionally lenient. The full raw body is always stashed
// on payloadJson.rawBody so a richer parser can replace this later without
// data loss.
//
// SHARP EDGE: nested CDATA, namespaces, or repeated bookings inside a single
// BookingNotifRQ envelope may be mis-parsed. We fall back to a single raw
// entry whenever no <Booking> blocks are detected.
export function parseBookingsBody(body: string): ExternalReservationDTO[] {
  const trimmed = body.trim();
  if (trimmed.length === 0) return [];

  // 1) Try JSON first when it looks like JSON.
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const json = JSON.parse(trimmed) as unknown;
      const list = pickBookingsFromJson(json);
      if (list.length > 0) return list;
    } catch {
      /* fall through to XML */
    }
  }

  // 2) XML BookingNotification envelopes — regex extraction.
  const out: ExternalReservationDTO[] = [];
  const bookingRegex = /<Booking\b([^>]*)>([\s\S]*?)<\/Booking>/gi;
  let m: RegExpExecArray | null;
  while ((m = bookingRegex.exec(trimmed)) !== null) {
    const attrs = m[1] ?? "";
    const inner = m[2] ?? "";
    const confirmation =
      /\bConfirmationNumber="([^"]+)"/i.exec(attrs)?.[1] ??
      /<ConfirmationNumber>([^<]+)<\/ConfirmationNumber>/i.exec(inner)?.[1] ??
      `unknown-${out.length}`;
    const status = (/\bStatus="([^"]+)"/i.exec(attrs)?.[1] ?? "unknown").toLowerCase();
    const roomStay = /<RoomStay\b([^>]*)>([\s\S]*?)<\/RoomStay>/i.exec(inner);
    const roomAttrs = roomStay?.[1] ?? "";
    const roomInner = roomStay?.[2] ?? "";
    const start = /\bStart="([^"]+)"/i.exec(roomAttrs)?.[1] ?? null;
    const end = /\bEnd="([^"]+)"/i.exec(roomAttrs)?.[1] ?? null;
    const roomType = /\bRoomTypeCode="([^"]+)"/i.exec(roomAttrs)?.[1] ?? null;
    const ratePlan = /\bRatePlanCode="([^"]+)"/i.exec(roomAttrs)?.[1] ?? null;
    const amountStr = /\bAmount="([^"]+)"/i.exec(roomInner)?.[1] ?? null;
    const currency = /\bCurrency(?:Code)?="([^"]+)"/i.exec(roomInner)?.[1] ?? null;
    const given = /<GivenName>([^<]+)<\/GivenName>/i.exec(roomInner)?.[1] ?? "";
    const surname = /<Surname>([^<]+)<\/Surname>/i.exec(roomInner)?.[1] ?? "";
    const guestName = [given, surname].filter(Boolean).join(" ").trim() || null;
    out.push({
      externalReference: confirmation,
      status,
      payloadJson: {
        provider: PROVIDER,
        guestName,
        arrivalDate: start,
        departureDate: end,
        roomTypeCode: roomType,
        ratePlanCode: ratePlan,
        totalAmount: amountStr !== null ? Number.parseFloat(amountStr) : null,
        currency,
        rawXml: m[0]
      }
    });
  }
  return out;
}

function pickBookingsFromJson(json: unknown): ExternalReservationDTO[] {
  const out: ExternalReservationDTO[] = [];
  const root = (json as { Bookings?: unknown; bookings?: unknown }) ?? {};
  const list = Array.isArray(root.Bookings) ? root.Bookings : Array.isArray(root.bookings) ? root.bookings : null;
  if (!list) return out;
  for (const entry of list) {
    if (!entry || typeof entry !== "object") continue;
    const b = entry as Record<string, unknown>;
    const confirmation =
      (typeof b.ConfirmationNumber === "string" && b.ConfirmationNumber) ||
      (typeof b.confirmationNumber === "string" && b.confirmationNumber) ||
      `unknown-${out.length}`;
    const status = ((typeof b.Status === "string" && b.Status) || "unknown").toLowerCase();
    const stays = Array.isArray(b.RoomStays) ? b.RoomStays : Array.isArray(b.roomStays) ? b.roomStays : [];
    const stay = stays[0] && typeof stays[0] === "object" ? (stays[0] as Record<string, unknown>) : null;
    out.push({
      externalReference: confirmation,
      status,
      payloadJson: {
        provider: PROVIDER,
        guestName: pickGuestName(b),
        arrivalDate: stay?.Start ?? stay?.start ?? null,
        departureDate: stay?.End ?? stay?.end ?? null,
        roomTypeCode: stay?.RoomTypeCode ?? stay?.roomTypeCode ?? null,
        ratePlanCode: stay?.RatePlanCode ?? stay?.ratePlanCode ?? null,
        totalAmount: pickTotalAmount(stay),
        currency: pickTotalCurrency(stay),
        rawJson: entry
      }
    });
  }
  return out;
}

function pickGuestName(booking: Record<string, unknown>): string | null {
  const guest = booking.PrimaryGuest ?? booking.primaryGuest ?? booking.Guest;
  if (!guest || typeof guest !== "object") return null;
  const g = guest as Record<string, unknown>;
  const given = typeof g.GivenName === "string" ? g.GivenName : typeof g.givenName === "string" ? g.givenName : "";
  const surname = typeof g.Surname === "string" ? g.Surname : typeof g.surname === "string" ? g.surname : "";
  return [given, surname].filter(Boolean).join(" ").trim() || null;
}

function pickTotalAmount(stay: Record<string, unknown> | null): number | null {
  if (!stay) return null;
  const total = stay.Total ?? stay.total;
  if (total && typeof total === "object") {
    const t = total as Record<string, unknown>;
    const amount = t.Amount ?? t.amount;
    if (typeof amount === "number") return amount;
    if (typeof amount === "string") {
      const parsed = Number.parseFloat(amount);
      return Number.isFinite(parsed) ? parsed : null;
    }
  }
  return null;
}

function pickTotalCurrency(stay: Record<string, unknown> | null): string | null {
  if (!stay) return null;
  const total = stay.Total ?? stay.total;
  if (total && typeof total === "object") {
    const t = total as Record<string, unknown>;
    const c = t.Currency ?? t.currency ?? t.CurrencyCode;
    return typeof c === "string" ? c : null;
  }
  return null;
}

// Best-effort error extraction from an EQC JSON response body.
function extractErrors(result: { ok: boolean; status: number; body: string; errorMessage?: string }): string[] {
  if (result.errorMessage !== undefined) return [result.errorMessage];
  try {
    const json = JSON.parse(result.body) as Record<string, unknown>;
    const errors = json.Errors ?? json.errors ?? json.error;
    if (Array.isArray(errors)) {
      return errors.map((e) => (typeof e === "string" ? e : JSON.stringify(e)));
    }
    if (typeof errors === "string") return [errors];
  } catch {
    /* fall through */
  }
  return [`EQC returned ${result.status} (truncated): ${result.body.slice(0, 200)}`];
}

async function pushAr({
  channel,
  json,
  itemCount,
  opName
}: {
  channel: ChannelContext;
  json: string;
  itemCount: number;
  opName: string;
}): Promise<AdapterResult> {
  let token: string;
  try {
    token = await getAccessToken(channel);
  } catch (err) {
    const message =
      err instanceof ExpediaOAuthError ? err.message : err instanceof Error ? err.message : String(err);
    return { ok: false, pushed: 0, errors: [`OAuth failed during ${opName}: ${message}`], latencyMs: 0 };
  }

  const result = await postJson({ url: endpoint("/eqc/ar"), token, json });
  const raw = {
    provider: PROVIDER,
    mode: "real",
    status: result.status,
    requestHash: result.requestHash,
    responseHash: result.responseHash
  };
  if (result.ok) {
    return { ok: true, pushed: itemCount, latencyMs: result.latencyMs, raw };
  }
  return { ok: false, pushed: 0, errors: extractErrors(result), latencyMs: result.latencyMs, raw };
}

export const expediaAdapter: ChannelAdapter = {
  providerCode: PROVIDER,

  async pushRates({ channel, items }): Promise<AdapterResult> {
    if (resolveMode() === "stub") {
      const latencyMs = await simulateLatency(seedHash(channel.id, "pushRates", items.length));
      if (isInvalidCredentials(channel.credentialsJson)) {
        return { ok: false, pushed: 0, errors: ["Expedia EQC credentials missing or invalid"], latencyMs };
      }
      // REAL CALL: POST /eqc/ar with AR (Availability + Rate) batch JSON envelope.
      return { ok: true, pushed: items.length, latencyMs, raw: { stub: true, provider: PROVIDER } };
    }
    const json = JSON.stringify(buildRatesPayload(items, resortId(channel)));
    return pushAr({ channel, json, itemCount: items.length, opName: "pushRates" });
  },

  async pushAvailability({ channel, items }): Promise<AdapterResult> {
    if (resolveMode() === "stub") {
      const latencyMs = await simulateLatency(seedHash(channel.id, "pushAvail", items.length));
      if (isInvalidCredentials(channel.credentialsJson)) {
        return { ok: false, pushed: 0, errors: ["Expedia EQC credentials missing or invalid"], latencyMs };
      }
      // REAL CALL: POST /eqc/ar (same endpoint, different node subset).
      return { ok: true, pushed: items.length, latencyMs, raw: { stub: true, provider: PROVIDER } };
    }
    const json = JSON.stringify(buildAvailabilityPayload(items, resortId(channel)));
    return pushAr({ channel, json, itemCount: items.length, opName: "pushAvailability" });
  },

  async pushRestrictions({ channel, items }): Promise<AdapterResult> {
    if (resolveMode() === "stub") {
      const latencyMs = await simulateLatency(seedHash(channel.id, "pushRestr", items.length));
      if (isInvalidCredentials(channel.credentialsJson)) {
        return { ok: false, pushed: 0, errors: ["Expedia EQC credentials missing or invalid"], latencyMs };
      }
      // REAL CALL: POST /eqc/ar (RestrictionStatus / StayRestriction nodes).
      return { ok: true, pushed: items.length, latencyMs, raw: { stub: true, provider: PROVIDER } };
    }
    const json = JSON.stringify(buildRestrictionsPayload(items, resortId(channel)));
    return pushAr({ channel, json, itemCount: items.length, opName: "pushRestrictions" });
  },

  async fetchReservations({ channel, since }) {
    if (resolveMode() === "stub") {
      await simulateLatency(seedHash(channel.id, "fetchRes"));
      if (isInvalidCredentials(channel.credentialsJson)) {
        return { ok: false, reservations: [], errors: ["Expedia EQC credentials missing or invalid"] };
      }
      // REAL CALL: GET /eqc/br?modifiedSince=<ISO>.
      return { ok: true, reservations: buildStubReservations(channel.id, since, PROVIDER) };
    }

    let token: string;
    try {
      token = await getAccessToken(channel);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, reservations: [], errors: [`OAuth failed during fetchReservations: ${message}`] };
    }
    const url = `${endpoint("/eqc/br")}?modifiedSince=${encodeURIComponent(since.toISOString())}`;
    const result = await getJson({ url, token });
    if (!result.ok) {
      return { ok: false, reservations: [], errors: extractErrors(result) };
    }
    // parseBookingsBody handles both EQC XML (BookingNotifRQ) and the newer
    // JSON envelope. If nothing parses, we keep the raw body around so the
    // aggregator can still dedupe by response hash.
    try {
      const reservations = parseBookingsBody(result.body);
      if (reservations.length > 0) return { ok: true, reservations };
      return {
        ok: true,
        reservations: [
          {
            externalReference: `expedia-raw-${result.responseHash.slice(0, 12)}`,
            status: "unknown",
            payloadJson: { provider: PROVIDER, raw: result.body }
          }
        ]
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        ok: true,
        reservations: [
          {
            externalReference: `expedia-raw-${result.responseHash.slice(0, 12)}`,
            status: "unknown",
            payloadJson: { provider: PROVIDER, raw: result.body, parseError: message }
          }
        ]
      };
    }
  },

  async testCredentials({ channel }) {
    if (resolveMode() === "stub") {
      await simulateLatency(seedHash(channel.id, "testCreds"));
      if (isInvalidCredentials(channel.credentialsJson)) {
        return { ok: false, error: "Credentials missing or rejected" };
      }
      return { ok: true, metadata: { eqcId: channel.credentialsJson?.eqcId ?? "STUB-EXP", provider: PROVIDER } };
    }
    // Real mode: validate via an OAuth round trip. Short-circuit when there are
    // no creds so test runs never touch the network just to confirm the obvious.
    if (isInvalidCredentials(channel.credentialsJson)) {
      return { ok: false, error: "Expedia EQC credentials missing or invalid" };
    }
    try {
      await getAccessToken(channel);
      return { ok: true, metadata: { provider: PROVIDER, mode: "real" } };
    } catch (err) {
      const message =
        err instanceof ExpediaOAuthError ? err.message : err instanceof Error ? err.message : String(err);
      return { ok: false, error: message };
    }
  },

  async fetchCompetitorRates({ channel, dateRange }) {
    await simulateLatency(seedHash(channel.id, "fetchComp"));
    return { ok: true, rates: buildStubCompetitorRates(channel.id, dateRange, PROVIDER) };
  }
};

// ── Spec-extension surface ────────────────────────────────────────────────
// The Sprint-58 OTA spec asked for three legacy-shaped helpers alongside the
// full ChannelAdapter contract: parseInbound (normalise an inbound payload to
// ExternalReservationDTO[]), pushAvailability (lightweight ack), healthCheck
// (mode + note). These wrap the richer methods above without changing the
// adapter contract used by the aggregator.

export function parseInbound(payload: string | object): ExternalReservationDTO[] {
  const body = typeof payload === "string" ? payload : JSON.stringify(payload);
  return parseBookingsBody(body);
}

export async function pushAvailability(
  roomTypeId: string,
  dateRange: { start: string; end: string },
  available: number
): Promise<{ acknowledged: boolean }> {
  const mode = resolveMode();
  if (mode === "stub") {
    // Deterministic sandbox ack — the cells underneath are exercised by the
    // ChannelAdapter.pushAvailability path in tests.
    void roomTypeId;
    void dateRange;
    void available;
    return { acknowledged: true };
  }
  // Production: refuse to do real I/O from this lightweight surface — callers
  // should go through the full ChannelAdapter contract with credentials.
  return { acknowledged: false };
}

export type ExpediaHealth =
  | { ok: true; mode: "sandbox" | "production"; note: string }
  | { ok: false; mode: "sandbox" | "production"; errorMessage: string };

export function healthCheck(): ExpediaHealth {
  const mode: "sandbox" | "production" = resolveMode() === "real" ? "production" : "sandbox";
  if (mode === "sandbox") {
    return {
      ok: true,
      mode,
      note: "Expedia EQC adapter running in sandbox mode — deterministic stub responses only."
    };
  }
  return { ok: false, mode, errorMessage: "Expedia EQC requires EXPEDIA client_id/client_secret credentials" };
}
