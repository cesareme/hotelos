// Airbnb adapter.
//
// Two execution modes, selected by env var:
//
//   AIRBNB_ADAPTER_MODE=stub   (default) — deterministic in-process responses.
//   AIRBNB_ADAPTER_MODE=real             — hits the real Airbnb Software Partner
//                                          API (REST/JSON, OAuth2 + API key).
//
// Real-mode endpoints (override the base via AIRBNB_API_BASE_URL for sandbox):
//   PUT  {base}/v2/listings/{listingId}/pricing             (rates)
//   PUT  {base}/v2/listings/{listingId}/calendar            (availability)
//   PUT  {base}/v2/listings/{listingId}/availability_rules  (restrictions)
//   GET  {base}/v2/reservations?updated_at[gte]=<ISO>       (reservations poll)
//   GET  {base}/v2/listings                                 (testCredentials probe)
//   POST oauth /v2/oauth2/authorizations                    (token exchange)
//
//   Docs: https://developer.airbnb.com
//
// Every Airbnb call needs BOTH a bearer token AND the X-Airbnb-API-Key header
// (the public client id) — see airbnb/auth.ts. Reservations are normally
// delivered via webhook; the GET poll here is the fallback path.
//
// Sharp edge: Airbnb has no "rate plan" concept — every listing is a single
// inventory unit with one price ladder. The aggregator filters RatePushItem
// down to the canonical rate plan (typically BAR) before push.

import type {
  AdapterResult,
  ChannelAdapter,
  ChannelContext,
  ExternalReservationDTO
} from "../adapter.types.js";
import { AirbnbOAuthError, getAccessToken, getApiKey } from "./airbnb/auth.js";
import { getJson, putJson } from "./airbnb/http.js";
import {
  buildAvailabilityRulesPayload,
  buildCalendarPayload,
  buildPricingPayload
} from "./airbnb/payload.js";
import {
  buildStubCompetitorRates,
  buildStubReservations,
  isInvalidCredentials,
  seedHash,
  simulateLatency
} from "./stub-utils.js";

const PROVIDER = "airbnb" as const;
const DEFAULT_API_BASE_URL = "https://api.airbnb.com";

type AdapterMode = "stub" | "real";

function resolveMode(): AdapterMode {
  return process.env.AIRBNB_ADAPTER_MODE === "real" ? "real" : "stub";
}

function resolveBaseUrl(): string {
  const base = process.env.AIRBNB_API_BASE_URL || DEFAULT_API_BASE_URL;
  return base.endsWith("/") ? base.slice(0, -1) : base;
}

function endpoint(path: string): string {
  return `${resolveBaseUrl()}${path}`;
}

function listingId(channel: ChannelContext): string {
  const id = channel.credentialsJson?.listingId;
  return typeof id === "string" && id.length > 0 ? id : "unknown";
}

// Parser for Airbnb's `GET /v2/reservations` JSON envelope.
//
// Airbnb returns a top-level `reservations: [...]` array. Each entry is shaped
// roughly like:
//
//   {
//     "reservation_code": "HM4ABCDE",
//     "listing_id": "12345",
//     "status": "accepted" | "cancelled" | "pending" | ...,
//     "guest": { "first_name": "...", "last_name": "...", "email": "..." },
//     "check_in":  "YYYY-MM-DD",
//     "check_out": "YYYY-MM-DD",
//     "total_amount": "289.00",
//     "total_paid_amount_native_currency": "289.00",
//     "currency": "EUR",
//     "nights": 3
//   }
//
// Older webhook deliveries use a flatter shape with `code` / `guest_first_name`
// fields — we accept both. The full raw entry is stashed in payloadJson so a
// stricter parser can replace this later without losing fidelity.
export function parseReservationsJson(body: string): ExternalReservationDTO[] {
  const trimmed = body.trim();
  if (trimmed.length === 0) return [];
  let json: unknown;
  try {
    json = JSON.parse(trimmed);
  } catch {
    return [];
  }
  const root = (json as Record<string, unknown>) ?? {};
  const candidates = [
    root.reservations,
    root.Reservations,
    Array.isArray(json) ? json : null
  ].find((x): x is unknown[] => Array.isArray(x));
  if (!candidates) {
    // Single-reservation webhook delivery.
    if (root.reservation_code || root.code) return [normaliseAirbnbReservation(root)];
    return [];
  }
  const out: ExternalReservationDTO[] = [];
  for (const entry of candidates) {
    if (!entry || typeof entry !== "object") continue;
    out.push(normaliseAirbnbReservation(entry as Record<string, unknown>));
  }
  return out;
}

function normaliseAirbnbReservation(entry: Record<string, unknown>): ExternalReservationDTO {
  const code =
    pickString(entry, "reservation_code") ??
    pickString(entry, "confirmation_code") ??
    pickString(entry, "code") ??
    `unknown-${Math.floor(Math.random() * 1_000_000)}`;
  const rawStatus = pickString(entry, "status") ?? "unknown";
  const status = mapAirbnbStatus(rawStatus);
  const guest = entry.guest && typeof entry.guest === "object" ? (entry.guest as Record<string, unknown>) : null;
  const firstName =
    pickString(guest ?? {}, "first_name") ??
    pickString(guest ?? {}, "firstName") ??
    pickString(entry, "guest_first_name") ??
    "";
  const lastName =
    pickString(guest ?? {}, "last_name") ??
    pickString(guest ?? {}, "lastName") ??
    pickString(entry, "guest_last_name") ??
    "";
  const guestName = [firstName, lastName].filter(Boolean).join(" ").trim() || null;
  const totalRaw =
    entry.total_amount ??
    entry.total_paid_amount_native_currency ??
    entry.total_paid_amount ??
    entry.totalAmount;
  let totalAmount: number | null = null;
  if (typeof totalRaw === "number") {
    totalAmount = totalRaw;
  } else if (typeof totalRaw === "string") {
    const parsed = Number.parseFloat(totalRaw);
    totalAmount = Number.isFinite(parsed) ? parsed : null;
  }
  return {
    externalReference: code,
    status,
    payloadJson: {
      provider: PROVIDER,
      listingId: pickString(entry, "listing_id") ?? pickString(entry, "listingId") ?? null,
      guestName,
      guestEmail: pickString(guest ?? {}, "email") ?? pickString(entry, "guest_email") ?? null,
      arrivalDate: pickString(entry, "check_in") ?? pickString(entry, "checkIn") ?? null,
      departureDate: pickString(entry, "check_out") ?? pickString(entry, "checkOut") ?? null,
      nights: typeof entry.nights === "number" ? entry.nights : null,
      totalAmount,
      currency: pickString(entry, "currency") ?? pickString(entry, "native_currency") ?? null,
      rawJson: entry
    }
  };
}

function pickString(obj: Record<string, unknown>, key: string): string | null {
  const v = obj[key];
  return typeof v === "string" && v.length > 0 ? v : null;
}

function mapAirbnbStatus(raw: string): string {
  const s = raw.toLowerCase();
  if (s === "accepted" || s === "confirmed") return "confirmed";
  if (s === "cancelled" || s === "canceled") return "cancelled";
  if (s === "denied" || s === "rejected") return "cancelled";
  if (s === "pending") return "pending";
  return s;
}

function extractErrors(result: { ok: boolean; status: number; body: string; errorMessage?: string }): string[] {
  if (result.errorMessage !== undefined) return [result.errorMessage];
  try {
    const json = JSON.parse(result.body) as Record<string, unknown>;
    const message = json.error_message ?? json.error ?? json.errors;
    if (typeof message === "string") return [message];
    if (Array.isArray(message)) return message.map((e) => (typeof e === "string" ? e : JSON.stringify(e)));
  } catch {
    /* fall through */
  }
  return [`Airbnb returned ${result.status} (truncated): ${result.body.slice(0, 200)}`];
}

async function putToListing({
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
  let token: string;
  let apiKey: string | null;
  try {
    token = await getAccessToken(channel);
    apiKey = getApiKey(channel);
  } catch (err) {
    const message =
      err instanceof AirbnbOAuthError ? err.message : err instanceof Error ? err.message : String(err);
    return { ok: false, pushed: 0, errors: [`OAuth failed during ${opName}: ${message}`], latencyMs: 0 };
  }
  if (!apiKey) {
    return { ok: false, pushed: 0, errors: [`Airbnb API key missing during ${opName}`], latencyMs: 0 };
  }

  const result = await putJson({ url: endpoint(path), token, apiKey, json });
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

export const airbnbAdapter: ChannelAdapter = {
  providerCode: PROVIDER,

  async pushRates({ channel, items }): Promise<AdapterResult> {
    if (resolveMode() === "stub") {
      const latencyMs = await simulateLatency(seedHash(channel.id, "pushRates", items.length));
      if (isInvalidCredentials(channel.credentialsJson)) {
        return { ok: false, pushed: 0, errors: ["Airbnb credentials missing or invalid"], latencyMs };
      }
      // REAL CALL: PUT /v2/listings/{listingId}/pricing { daily_prices: [...] }
      return { ok: true, pushed: items.length, latencyMs, raw: { stub: true, provider: PROVIDER } };
    }
    const json = JSON.stringify(buildPricingPayload(items));
    return putToListing({
      channel,
      path: `/v2/listings/${encodeURIComponent(listingId(channel))}/pricing`,
      json,
      itemCount: items.length,
      opName: "pushRates"
    });
  },

  async pushAvailability({ channel, items }): Promise<AdapterResult> {
    if (resolveMode() === "stub") {
      const latencyMs = await simulateLatency(seedHash(channel.id, "pushAvail", items.length));
      if (isInvalidCredentials(channel.credentialsJson)) {
        return { ok: false, pushed: 0, errors: ["Airbnb credentials missing or invalid"], latencyMs };
      }
      // REAL CALL: PUT /v2/listings/{listingId}/calendar { calendar: [...] }
      return { ok: true, pushed: items.length, latencyMs, raw: { stub: true, provider: PROVIDER } };
    }
    const json = JSON.stringify(buildCalendarPayload(items));
    return putToListing({
      channel,
      path: `/v2/listings/${encodeURIComponent(listingId(channel))}/calendar`,
      json,
      itemCount: items.length,
      opName: "pushAvailability"
    });
  },

  async pushRestrictions({ channel, items }): Promise<AdapterResult> {
    if (resolveMode() === "stub") {
      const latencyMs = await simulateLatency(seedHash(channel.id, "pushRestr", items.length));
      if (isInvalidCredentials(channel.credentialsJson)) {
        return { ok: false, pushed: 0, errors: ["Airbnb credentials missing or invalid"], latencyMs };
      }
      // REAL CALL: PUT /v2/listings/{listingId}/availability_rules
      return { ok: true, pushed: items.length, latencyMs, raw: { stub: true, provider: PROVIDER } };
    }
    const json = JSON.stringify(buildAvailabilityRulesPayload(items));
    return putToListing({
      channel,
      path: `/v2/listings/${encodeURIComponent(listingId(channel))}/availability_rules`,
      json,
      itemCount: items.length,
      opName: "pushRestrictions"
    });
  },

  async fetchReservations({ channel, since }) {
    if (resolveMode() === "stub") {
      await simulateLatency(seedHash(channel.id, "fetchRes"));
      if (isInvalidCredentials(channel.credentialsJson)) {
        return { ok: false, reservations: [], errors: ["Airbnb credentials missing or invalid"] };
      }
      // REAL CALL: GET /v2/reservations?updated_at[gte]=<since>&listing_id=<id>
      return { ok: true, reservations: buildStubReservations(channel.id, since, PROVIDER) };
    }

    let token: string;
    let apiKey: string | null;
    try {
      token = await getAccessToken(channel);
      apiKey = getApiKey(channel);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, reservations: [], errors: [`OAuth failed during fetchReservations: ${message}`] };
    }
    if (!apiKey) {
      return { ok: false, reservations: [], errors: ["Airbnb API key missing during fetchReservations"] };
    }
    const url = `${endpoint("/v2/reservations")}?updated_at[gte]=${encodeURIComponent(since.toISOString())}`;
    const result = await getJson({ url, token, apiKey });
    if (!result.ok) {
      return { ok: false, reservations: [], errors: extractErrors(result) };
    }
    try {
      const reservations = parseReservationsJson(result.body);
      if (reservations.length > 0) return { ok: true, reservations };
      return {
        ok: true,
        reservations: [
          {
            externalReference: `airbnb-raw-${result.responseHash.slice(0, 12)}`,
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
            externalReference: `airbnb-raw-${result.responseHash.slice(0, 12)}`,
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
      return { ok: true, metadata: { listingId: channel.credentialsJson?.listingId ?? "STUB-ABNB", provider: PROVIDER } };
    }
    // Real mode: validate by acquiring a token. Short-circuit when there are no
    // creds so test runs never touch the network just to confirm the obvious.
    if (isInvalidCredentials(channel.credentialsJson)) {
      return { ok: false, error: "Airbnb credentials missing or invalid" };
    }
    try {
      await getAccessToken(channel);
      return { ok: true, metadata: { provider: PROVIDER, mode: "real" } };
    } catch (err) {
      const message =
        err instanceof AirbnbOAuthError ? err.message : err instanceof Error ? err.message : String(err);
      return { ok: false, error: message };
    }
  },

  async fetchCompetitorRates({ channel, dateRange }) {
    // Airbnb does not expose competitor pricing in production; we still return
    // stubbed data so the parity monitor exercises the same code path as the
    // OTAs that do.
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
  return parseReservationsJson(body);
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

export type AirbnbHealth =
  | { ok: true; mode: "sandbox" | "production"; note: string }
  | { ok: false; mode: "sandbox" | "production"; errorMessage: string };

export function healthCheck(): AirbnbHealth {
  const mode: "sandbox" | "production" = resolveMode() === "real" ? "production" : "sandbox";
  if (mode === "sandbox") {
    return {
      ok: true,
      mode,
      note: "Airbnb adapter running in sandbox mode — deterministic stub responses only."
    };
  }
  return {
    ok: false,
    mode,
    errorMessage: "Airbnb requires AIRBNB client_id, client_secret and X-Airbnb-API-Key credentials"
  };
}
