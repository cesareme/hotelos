// Vrbo adapter.
//
// Two execution modes, selected by env var:
//
//   VRBO_ADAPTER_MODE=stub   (default) — deterministic in-process responses.
//   VRBO_ADAPTER_MODE=real             — hits the real Vrbo (Expedia Group)
//                                        software-partner REST+JSON API.
//
// Vrbo rides on the Expedia Group platform and reuses the EQC OAuth2 client-
// credentials flow, but with SEPARATE credentials, a separate token cache (see
// vrbo/auth.ts) and a separate listing namespace.
//
// Real-mode endpoints (override the base via VRBO_API_BASE_URL for sandbox):
//   POST {base}/vrbo/availability-rates  (availability + rates + restrictions)
//   GET  {base}/vrbo/reservations        (reservations pull)
//   POST oauth /authentication/v1/token  (token exchange — same host as Expedia)
//
//   Docs: https://developers.expediagroup.com/vrbo
//
// SHARP EDGE: Expedia and Vrbo share the OAuth host but require DIFFERENT
// client_id/client_secret pairs. The two adapters keep independent token caches
// so connecting one never invalidates the other.
//
// CREDENTIALS:
//   channel.credentialsJson must contain { client_id, client_secret }. Optional:
//   { listingId / propertyId } to scope the message.

import type {
  AdapterResult,
  ChannelAdapter,
  ChannelContext,
  ExternalReservationDTO
} from "../adapter.types.js";
import { VrboOAuthError, getAccessToken } from "./vrbo/auth.js";
import { getJson, postJson } from "./vrbo/http.js";
import {
  buildAvailabilityPayload,
  buildRatesPayload,
  buildRestrictionsPayload
} from "./vrbo/payload.js";
import {
  buildStubCompetitorRates,
  buildStubReservations,
  isInvalidCredentials,
  seedHash,
  simulateLatency
} from "./stub-utils.js";

const PROVIDER = "vrbo" as const;
const DEFAULT_API_BASE_URL = "https://services.expediapartnercentral.com";

type AdapterMode = "stub" | "real";

function resolveMode(): AdapterMode {
  return process.env.VRBO_ADAPTER_MODE === "real" ? "real" : "stub";
}

function resolveBaseUrl(): string {
  const base = process.env.VRBO_API_BASE_URL || DEFAULT_API_BASE_URL;
  return base.endsWith("/") ? base.slice(0, -1) : base;
}

function endpoint(path: string): string {
  return `${resolveBaseUrl()}${path}`;
}

function listingId(channel: ChannelContext): string | undefined {
  const creds = channel.credentialsJson;
  const id = creds?.listingId ?? creds?.propertyId;
  return typeof id === "string" ? id : undefined;
}

// Parser for the Vrbo Reservations API.
//
// Vrbo returns a flat JSON shape — usually `reservations: [...]` on the root,
// where each entry looks like:
//
//   {
//     "reservationId": "VRBO-93481",
//     "propertyId":    "VRBO-1",
//     "status":        "BOOKED" | "CANCELLED" | ...,
//     "guestArrival":  "YYYY-MM-DD",
//     "guestDeparture":"YYYY-MM-DD",
//     "guestName":     "Jane Doe",
//     "guestEmail":    "...",
//     "totalAmount":   289.0,
//     "currency":      "EUR"
//   }
//
// Some legacy responses use `reservation_id`/`property_id` and a nested
// `guest:{firstName,lastName}` object — we accept both. Anything we cannot
// parse falls through to a raw-body entry so deduplication still works.
export function parseVrboReservationsJson(body: string): ExternalReservationDTO[] {
  const trimmed = body.trim();
  if (trimmed.length === 0) return [];
  let json: unknown;
  try {
    json = JSON.parse(trimmed);
  } catch {
    return [];
  }
  const root = (json as Record<string, unknown>) ?? {};
  const list = Array.isArray(root.reservations)
    ? root.reservations
    : Array.isArray(root.Reservations)
      ? root.Reservations
      : Array.isArray(json)
        ? (json as unknown[])
        : null;
  if (!list) {
    // Single-reservation webhook delivery (Vrbo notification mode).
    if (root.reservationId || root.reservation_id) return [normaliseVrboReservation(root)];
    return [];
  }
  const out: ExternalReservationDTO[] = [];
  for (const entry of list) {
    if (!entry || typeof entry !== "object") continue;
    out.push(normaliseVrboReservation(entry as Record<string, unknown>));
  }
  return out;
}

function normaliseVrboReservation(entry: Record<string, unknown>): ExternalReservationDTO {
  const reference =
    pickVrboString(entry, "reservationId") ??
    pickVrboString(entry, "reservation_id") ??
    pickVrboString(entry, "id") ??
    `unknown-${Math.floor(Math.random() * 1_000_000)}`;
  const status = mapVrboStatus(pickVrboString(entry, "status") ?? "unknown");
  const guest = entry.guest && typeof entry.guest === "object" ? (entry.guest as Record<string, unknown>) : null;
  const guestName =
    pickVrboString(entry, "guestName") ??
    (guest
      ? [
          pickVrboString(guest, "firstName") ?? pickVrboString(guest, "first_name") ?? "",
          pickVrboString(guest, "lastName") ?? pickVrboString(guest, "last_name") ?? ""
        ]
          .filter(Boolean)
          .join(" ")
          .trim() || null
      : null);
  const totalRaw = entry.totalAmount ?? entry.total_amount ?? entry.total;
  let totalAmount: number | null = null;
  if (typeof totalRaw === "number") {
    totalAmount = totalRaw;
  } else if (typeof totalRaw === "string") {
    const parsed = Number.parseFloat(totalRaw);
    totalAmount = Number.isFinite(parsed) ? parsed : null;
  }
  return {
    externalReference: reference,
    status,
    payloadJson: {
      provider: PROVIDER,
      propertyId:
        pickVrboString(entry, "propertyId") ?? pickVrboString(entry, "property_id") ?? null,
      guestName,
      guestEmail:
        pickVrboString(entry, "guestEmail") ?? (guest ? pickVrboString(guest, "email") : null),
      arrivalDate:
        pickVrboString(entry, "guestArrival") ??
        pickVrboString(entry, "checkIn") ??
        pickVrboString(entry, "check_in") ??
        null,
      departureDate:
        pickVrboString(entry, "guestDeparture") ??
        pickVrboString(entry, "checkOut") ??
        pickVrboString(entry, "check_out") ??
        null,
      totalAmount,
      currency:
        pickVrboString(entry, "currency") ?? pickVrboString(entry, "currencyCode") ?? null,
      rawJson: entry
    }
  };
}

function pickVrboString(obj: Record<string, unknown>, key: string): string | null {
  const v = obj[key];
  return typeof v === "string" && v.length > 0 ? v : null;
}

function mapVrboStatus(raw: string): string {
  const s = raw.toLowerCase();
  if (s === "booked" || s === "confirmed") return "confirmed";
  if (s === "cancelled" || s === "canceled") return "cancelled";
  if (s === "modified" || s === "amended") return "modified";
  if (s === "pending" || s === "inquiry") return "pending";
  return s;
}

function extractErrors(result: { ok: boolean; status: number; body: string; errorMessage?: string }): string[] {
  if (result.errorMessage !== undefined) return [result.errorMessage];
  try {
    const json = JSON.parse(result.body) as Record<string, unknown>;
    const errors = json.errors ?? json.Errors ?? json.error;
    if (Array.isArray(errors)) {
      return errors.map((e) => (typeof e === "string" ? e : JSON.stringify(e)));
    }
    if (typeof errors === "string") return [errors];
  } catch {
    /* fall through */
  }
  return [`Vrbo returned ${result.status} (truncated): ${result.body.slice(0, 200)}`];
}

async function pushArVrbo({
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
      err instanceof VrboOAuthError ? err.message : err instanceof Error ? err.message : String(err);
    return { ok: false, pushed: 0, errors: [`OAuth failed during ${opName}: ${message}`], latencyMs: 0 };
  }

  const result = await postJson({ url: endpoint("/vrbo/availability-rates"), token, json });
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

export const vrboAdapter: ChannelAdapter = {
  providerCode: PROVIDER,

  async pushRates({ channel, items }): Promise<AdapterResult> {
    if (resolveMode() === "stub") {
      const latencyMs = await simulateLatency(seedHash(channel.id, "pushRates", items.length));
      if (isInvalidCredentials(channel.credentialsJson)) {
        return { ok: false, pushed: 0, errors: ["Vrbo credentials missing or invalid"], latencyMs };
      }
      // REAL CALL: POST /vrbo/availability-rates (rate nodes).
      return { ok: true, pushed: items.length, latencyMs, raw: { stub: true, provider: PROVIDER } };
    }
    const json = JSON.stringify(buildRatesPayload(items, listingId(channel)));
    return pushArVrbo({ channel, json, itemCount: items.length, opName: "pushRates" });
  },

  async pushAvailability({ channel, items }): Promise<AdapterResult> {
    if (resolveMode() === "stub") {
      const latencyMs = await simulateLatency(seedHash(channel.id, "pushAvail", items.length));
      if (isInvalidCredentials(channel.credentialsJson)) {
        return { ok: false, pushed: 0, errors: ["Vrbo credentials missing or invalid"], latencyMs };
      }
      // REAL CALL: POST /vrbo/availability-rates (availability nodes).
      return { ok: true, pushed: items.length, latencyMs, raw: { stub: true, provider: PROVIDER } };
    }
    const json = JSON.stringify(buildAvailabilityPayload(items, listingId(channel)));
    return pushArVrbo({ channel, json, itemCount: items.length, opName: "pushAvailability" });
  },

  async pushRestrictions({ channel, items }): Promise<AdapterResult> {
    if (resolveMode() === "stub") {
      const latencyMs = await simulateLatency(seedHash(channel.id, "pushRestr", items.length));
      if (isInvalidCredentials(channel.credentialsJson)) {
        return { ok: false, pushed: 0, errors: ["Vrbo credentials missing or invalid"], latencyMs };
      }
      // REAL CALL: POST /vrbo/availability-rates (restriction nodes).
      return { ok: true, pushed: items.length, latencyMs, raw: { stub: true, provider: PROVIDER } };
    }
    const json = JSON.stringify(buildRestrictionsPayload(items, listingId(channel)));
    return pushArVrbo({ channel, json, itemCount: items.length, opName: "pushRestrictions" });
  },

  async fetchReservations({ channel, since }) {
    if (resolveMode() === "stub") {
      await simulateLatency(seedHash(channel.id, "fetchRes"));
      if (isInvalidCredentials(channel.credentialsJson)) {
        return { ok: false, reservations: [], errors: ["Vrbo credentials missing or invalid"] };
      }
      // REAL CALL: GET /vrbo/reservations?modifiedSince=<ISO>.
      return { ok: true, reservations: buildStubReservations(channel.id, since, PROVIDER) };
    }

    let token: string;
    try {
      token = await getAccessToken(channel);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, reservations: [], errors: [`OAuth failed during fetchReservations: ${message}`] };
    }
    const url = `${endpoint("/vrbo/reservations")}?modifiedSince=${encodeURIComponent(since.toISOString())}`;
    const result = await getJson({ url, token });
    if (!result.ok) {
      return { ok: false, reservations: [], errors: extractErrors(result) };
    }
    try {
      const reservations = parseVrboReservationsJson(result.body);
      if (reservations.length > 0) return { ok: true, reservations };
      return {
        ok: true,
        reservations: [
          {
            externalReference: `vrbo-raw-${result.responseHash.slice(0, 12)}`,
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
            externalReference: `vrbo-raw-${result.responseHash.slice(0, 12)}`,
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
      return { ok: true, metadata: { propertyId: channel.credentialsJson?.propertyId ?? "STUB-VRBO", provider: PROVIDER } };
    }
    if (isInvalidCredentials(channel.credentialsJson)) {
      return { ok: false, error: "Vrbo credentials missing or invalid" };
    }
    try {
      await getAccessToken(channel);
      return { ok: true, metadata: { provider: PROVIDER, mode: "real" } };
    } catch (err) {
      const message =
        err instanceof VrboOAuthError ? err.message : err instanceof Error ? err.message : String(err);
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
  return parseVrboReservationsJson(body);
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

export type VrboHealth =
  | { ok: true; mode: "sandbox" | "production"; note: string }
  | { ok: false; mode: "sandbox" | "production"; errorMessage: string };

export function healthCheck(): VrboHealth {
  const mode: "sandbox" | "production" = resolveMode() === "real" ? "production" : "sandbox";
  if (mode === "sandbox") {
    return {
      ok: true,
      mode,
      note: "Vrbo adapter running in sandbox mode — deterministic stub responses only."
    };
  }
  return {
    ok: false,
    mode,
    errorMessage: "Vrbo requires VRBO client_id/client_secret credentials (separate from Expedia EQC)"
  };
}
