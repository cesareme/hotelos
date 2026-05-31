// Hotelbeds adapter.
//
// Two execution modes, selected by env var:
//
//   HOTELBEDS_ADAPTER_MODE=stub   (default) — deterministic in-process responses.
//   HOTELBEDS_ADAPTER_MODE=real             — hits the real Hotelbeds APItude
//                                             REST/JSON API.
//
// Auth is SIGNATURE-BASED, not OAuth: every request carries `Api-key` and
//   X-Signature = SHA256(apiKey + secret + epochSeconds)
// recomputed per call (see hotelbeds/auth.ts). There is no token to cache.
//
// Real-mode endpoints (override the base via HOTELBEDS_API_BASE_URL for sandbox):
//   POST {base}/hotel-content-api/1.0/rates        (net rates)
//   POST {base}/hotel-content-api/1.0/inventory    (allotment / availability)
//   POST {base}/hotel-content-api/1.0/restrictions (stop-sell / MLOS)
//   GET  {base}/hotel-api/1.0/bookings             (reservations pull)
//   GET  {base}/hotel-api/1.0/status               (testCredentials probe)
//
//   Docs: https://developer.hotelbeds.com
//
// SHARP EDGE — TIMESTAMP DRIFT: the signature embeds the current epoch SECOND.
// If the host clock drifts from Hotelbeds' server clock, signatures are rejected
// with a 403 that looks like a bad key. Keep the host NTP-synced.
//
// Sharp edge: Hotelbeds is a wholesaler — rates pushed here are NET rates resold
// with their own markup; the aggregator marks these channels as
// channelType="wholesaler" so the parity monitor treats sub-parity gaps as
// expected.

import type {
  AdapterResult,
  ChannelAdapter,
  ChannelContext,
  ExternalReservationDTO
} from "../adapter.types.js";
import { HotelbedsAuthError, buildSignature, hasCredentials } from "./hotelbeds/auth.js";
import { signedRequest } from "./hotelbeds/http.js";
import {
  buildInventoryPayload,
  buildRatesPayload,
  buildRestrictionsPayload
} from "./hotelbeds/payload.js";
import {
  buildStubCompetitorRates,
  buildStubReservations,
  isInvalidCredentials,
  seedHash,
  simulateLatency
} from "./stub-utils.js";

const PROVIDER = "hotelbeds" as const;
const DEFAULT_API_BASE_URL = "https://api.hotelbeds.com";

type AdapterMode = "stub" | "real";

function resolveMode(): AdapterMode {
  return process.env.HOTELBEDS_ADAPTER_MODE === "real" ? "real" : "stub";
}

function resolveBaseUrl(): string {
  const base = process.env.HOTELBEDS_API_BASE_URL || DEFAULT_API_BASE_URL;
  return base.endsWith("/") ? base.slice(0, -1) : base;
}

function endpoint(path: string): string {
  return `${resolveBaseUrl()}${path}`;
}

// Parser for Hotelbeds' Bedbank Hotel API response.
//
// The Hotel API returns BookingRS-shaped responses — historically XML and now
// also JSON. The two shapes we need to cope with:
//
//   XML:
//     <BookingRS>
//       <bookings>
//         <booking reference="HBK-7821" status="CONFIRMED">
//           <hotel code="HTB-2300" />
//           <holder name="Jane" surname="Doe"/>
//           <stay checkIn="YYYY-MM-DD" checkOut="YYYY-MM-DD"/>
//           <totalNet>289.00</totalNet>
//           <currency>EUR</currency>
//         </booking>
//       </bookings>
//     </BookingRS>
//
//   JSON: { "bookings": [ { "reference":"HBK-7821", "status":"CONFIRMED",
//                          "holder":{"name":"Jane","surname":"Doe"},
//                          "stay":{"checkIn":"...","checkOut":"..."},
//                          "totalNet":289.0, "currency":"EUR" } ] }
//
// Anything we cannot parse becomes a single raw entry so the aggregator can
// still dedupe by response hash.
export function parseBedbankBody(body: string): ExternalReservationDTO[] {
  const trimmed = body.trim();
  if (trimmed.length === 0) return [];

  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const json = JSON.parse(trimmed) as Record<string, unknown> | unknown[];
      const list = Array.isArray(json)
        ? json
        : Array.isArray((json as Record<string, unknown>).bookings)
          ? ((json as Record<string, unknown>).bookings as unknown[])
          : Array.isArray((json as Record<string, unknown>).Bookings)
            ? ((json as Record<string, unknown>).Bookings as unknown[])
            : [];
      const out: ExternalReservationDTO[] = [];
      for (const entry of list) {
        if (!entry || typeof entry !== "object") continue;
        const b = entry as Record<string, unknown>;
        const reference =
          (typeof b.reference === "string" && b.reference) ||
          (typeof b.bookingReference === "string" && b.bookingReference) ||
          `unknown-${out.length}`;
        const status = ((typeof b.status === "string" && b.status) || "unknown").toLowerCase();
        const holder = (b.holder ?? b.Holder) as Record<string, unknown> | undefined;
        const stay = (b.stay ?? b.Stay) as Record<string, unknown> | undefined;
        const totalNet = typeof b.totalNet === "number"
          ? b.totalNet
          : typeof b.totalNet === "string"
            ? Number.parseFloat(b.totalNet)
            : null;
        out.push({
          externalReference: reference,
          status,
          payloadJson: {
            provider: PROVIDER,
            guestName: holder
              ? [
                  typeof holder.name === "string" ? holder.name : "",
                  typeof holder.surname === "string" ? holder.surname : ""
                ]
                  .filter(Boolean)
                  .join(" ")
                  .trim() || null
              : null,
            arrivalDate: stay && typeof stay.checkIn === "string" ? stay.checkIn : null,
            departureDate: stay && typeof stay.checkOut === "string" ? stay.checkOut : null,
            totalNet,
            currency: typeof b.currency === "string" ? b.currency : null,
            rawJson: entry
          }
        });
      }
      if (out.length > 0) return out;
    } catch {
      /* fall through to XML */
    }
  }

  const out: ExternalReservationDTO[] = [];
  const bookingRegex = /<booking\b([^>]*)>([\s\S]*?)<\/booking>/gi;
  let m: RegExpExecArray | null;
  while ((m = bookingRegex.exec(trimmed)) !== null) {
    const attrs = m[1] ?? "";
    const inner = m[2] ?? "";
    const reference =
      /\breference="([^"]+)"/i.exec(attrs)?.[1] ??
      /<reference>([^<]+)<\/reference>/i.exec(inner)?.[1] ??
      `unknown-${out.length}`;
    const status = (
      /\bstatus="([^"]+)"/i.exec(attrs)?.[1] ??
      /<status>([^<]+)<\/status>/i.exec(inner)?.[1] ??
      "unknown"
    ).toLowerCase();
    const stayAttrs = /<stay\b([^/]*?)\/?>/i.exec(inner)?.[1] ?? "";
    const checkIn = /\bcheckIn="([^"]+)"/i.exec(stayAttrs)?.[1] ?? null;
    const checkOut = /\bcheckOut="([^"]+)"/i.exec(stayAttrs)?.[1] ?? null;
    const holderAttrs = /<holder\b([^/]*?)\/?>/i.exec(inner)?.[1] ?? "";
    const name = /\bname="([^"]+)"/i.exec(holderAttrs)?.[1] ?? "";
    const surname = /\bsurname="([^"]+)"/i.exec(holderAttrs)?.[1] ?? "";
    const guestName = [name, surname].filter(Boolean).join(" ").trim() || null;
    const totalNetStr = /<totalNet>([^<]+)<\/totalNet>/i.exec(inner)?.[1] ?? null;
    const currency = /<currency>([^<]+)<\/currency>/i.exec(inner)?.[1] ?? null;
    out.push({
      externalReference: reference,
      status,
      payloadJson: {
        provider: PROVIDER,
        guestName,
        arrivalDate: checkIn,
        departureDate: checkOut,
        totalNet: totalNetStr !== null ? Number.parseFloat(totalNetStr) : null,
        currency,
        rawXml: m[0]
      }
    });
  }
  return out;
}

function extractErrors(result: { ok: boolean; status: number; body: string; errorMessage?: string }): string[] {
  if (result.errorMessage !== undefined) return [result.errorMessage];
  try {
    const json = JSON.parse(result.body) as Record<string, unknown>;
    const err = json.error as Record<string, unknown> | string | undefined;
    if (typeof err === "string") return [err];
    if (err && typeof err === "object" && typeof err.message === "string") return [err.message];
  } catch {
    /* fall through */
  }
  return [`Hotelbeds returned ${result.status} (truncated): ${result.body.slice(0, 200)}`];
}

async function pushSigned({
  channel,
  path,
  json,
  itemCount,
  opName
}: {
  channel: ChannelContext;
  path: string;
  json: string;
  itemCount: number;
  opName: string;
}): Promise<AdapterResult> {
  let auth;
  try {
    auth = buildSignature(channel);
  } catch (err) {
    const message =
      err instanceof HotelbedsAuthError ? err.message : err instanceof Error ? err.message : String(err);
    return { ok: false, pushed: 0, errors: [`Signature failed during ${opName}: ${message}`], latencyMs: 0 };
  }

  const result = await signedRequest({ url: endpoint(path), auth, json });
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

export const hotelbedsAdapter: ChannelAdapter = {
  providerCode: PROVIDER,

  async pushRates({ channel, items }): Promise<AdapterResult> {
    if (resolveMode() === "stub") {
      const latencyMs = await simulateLatency(seedHash(channel.id, "pushRates", items.length));
      if (isInvalidCredentials(channel.credentialsJson)) {
        return { ok: false, pushed: 0, errors: ["Hotelbeds credentials missing or invalid"], latencyMs };
      }
      // REAL CALL: POST /hotel-content-api/1.0/rates
      return { ok: true, pushed: items.length, latencyMs, raw: { stub: true, provider: PROVIDER } };
    }
    const json = JSON.stringify(buildRatesPayload(items));
    return pushSigned({ channel, path: "/hotel-content-api/1.0/rates", json, itemCount: items.length, opName: "pushRates" });
  },

  async pushAvailability({ channel, items }): Promise<AdapterResult> {
    if (resolveMode() === "stub") {
      const latencyMs = await simulateLatency(seedHash(channel.id, "pushAvail", items.length));
      if (isInvalidCredentials(channel.credentialsJson)) {
        return { ok: false, pushed: 0, errors: ["Hotelbeds credentials missing or invalid"], latencyMs };
      }
      // REAL CALL: POST /hotel-content-api/1.0/inventory
      return { ok: true, pushed: items.length, latencyMs, raw: { stub: true, provider: PROVIDER } };
    }
    const json = JSON.stringify(buildInventoryPayload(items));
    return pushSigned({
      channel,
      path: "/hotel-content-api/1.0/inventory",
      json,
      itemCount: items.length,
      opName: "pushAvailability"
    });
  },

  async pushRestrictions({ channel, items }): Promise<AdapterResult> {
    if (resolveMode() === "stub") {
      const latencyMs = await simulateLatency(seedHash(channel.id, "pushRestr", items.length));
      if (isInvalidCredentials(channel.credentialsJson)) {
        return { ok: false, pushed: 0, errors: ["Hotelbeds credentials missing or invalid"], latencyMs };
      }
      // REAL CALL: POST /hotel-content-api/1.0/restrictions
      return { ok: true, pushed: items.length, latencyMs, raw: { stub: true, provider: PROVIDER } };
    }
    const json = JSON.stringify(buildRestrictionsPayload(items));
    return pushSigned({
      channel,
      path: "/hotel-content-api/1.0/restrictions",
      json,
      itemCount: items.length,
      opName: "pushRestrictions"
    });
  },

  async fetchReservations({ channel, since }) {
    if (resolveMode() === "stub") {
      await simulateLatency(seedHash(channel.id, "fetchRes"));
      if (isInvalidCredentials(channel.credentialsJson)) {
        return { ok: false, reservations: [], errors: ["Hotelbeds credentials missing or invalid"] };
      }
      // REAL CALL: GET /hotel-api/1.0/bookings?modified_since=<ISO>
      return { ok: true, reservations: buildStubReservations(channel.id, since, PROVIDER) };
    }

    let auth;
    try {
      auth = buildSignature(channel);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, reservations: [], errors: [`Signature failed during fetchReservations: ${message}`] };
    }
    const url = `${endpoint("/hotel-api/1.0/bookings")}?modified_since=${encodeURIComponent(since.toISOString())}`;
    const result = await signedRequest({ url, auth, method: "GET" });
    if (!result.ok) {
      return { ok: false, reservations: [], errors: extractErrors(result) };
    }
    try {
      const reservations = parseBedbankBody(result.body);
      if (reservations.length > 0) return { ok: true, reservations };
      return {
        ok: true,
        reservations: [
          {
            externalReference: `hotelbeds-raw-${result.responseHash.slice(0, 12)}`,
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
            externalReference: `hotelbeds-raw-${result.responseHash.slice(0, 12)}`,
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
      return { ok: true, metadata: { hotelCode: channel.credentialsJson?.hotelCode ?? "STUB-HTB", provider: PROVIDER } };
    }
    // Real mode: confirm we can build a signature (i.e. apiKey + secret present).
    // Short-circuit before the network when creds are missing.
    if (!hasCredentials(channel)) {
      return { ok: false, error: "Hotelbeds credentials missing or invalid" };
    }
    try {
      const auth = buildSignature(channel);
      const result = await signedRequest({ url: endpoint("/hotel-api/1.0/status"), auth, method: "GET" });
      if (result.ok) {
        return { ok: true, metadata: { provider: PROVIDER, mode: "real" } };
      }
      return { ok: false, error: extractErrors(result)[0] };
    } catch (err) {
      const message =
        err instanceof HotelbedsAuthError ? err.message : err instanceof Error ? err.message : String(err);
      return { ok: false, error: message };
    }
  },

  async fetchCompetitorRates({ channel, dateRange }) {
    await simulateLatency(seedHash(channel.id, "fetchComp"));
    return { ok: true, rates: buildStubCompetitorRates(channel.id, dateRange, PROVIDER) };
  }
};

// ── Spec-extension surface ────────────────────────────────────────────────
// See the matching block in expedia.adapter.ts for the rationale: these three
// helpers expose the legacy-shaped (parseInbound / pushAvailability /
// healthCheck) surface alongside the full ChannelAdapter contract.

export function parseInbound(payload: string | object): ExternalReservationDTO[] {
  const body = typeof payload === "string" ? payload : JSON.stringify(payload);
  return parseBedbankBody(body);
}

export async function pushAvailability(
  roomTypeId: string,
  dateRange: { start: string; end: string },
  available: number
): Promise<{ acknowledged: boolean }> {
  const mode = resolveMode();
  if (mode === "stub") {
    void roomTypeId;
    void dateRange;
    void available;
    return { acknowledged: true };
  }
  return { acknowledged: false };
}

export type HotelbedsHealth =
  | { ok: true; mode: "sandbox" | "production"; note: string }
  | { ok: false; mode: "sandbox" | "production"; errorMessage: string };

export function healthCheck(): HotelbedsHealth {
  const mode: "sandbox" | "production" = resolveMode() === "real" ? "production" : "sandbox";
  if (mode === "sandbox") {
    return {
      ok: true,
      mode,
      note: "Hotelbeds Bedbank adapter running in sandbox mode — deterministic stub responses only."
    };
  }
  return {
    ok: false,
    mode,
    errorMessage: "Hotelbeds requires HOTELBEDS apiKey + secret credentials (SHA256-signed requests)"
  };
}
