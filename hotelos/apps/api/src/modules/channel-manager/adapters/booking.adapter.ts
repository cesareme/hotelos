// Booking.com adapter.
//
// Three execution modes, selected by env var:
//
//   BOOKING_ADAPTER_MODE=stub    (default) — deterministic in-process responses.
//   BOOKING_ADAPTER_MODE=sandbox          — REAL HTTP round-trip against a local
//                                           mock (default http://localhost:3000),
//                                           using the same XML builders + http
//                                           wrapper as real mode but skipping
//                                           OAuth. Proves the full network path
//                                           end-to-end with no external creds.
//   BOOKING_ADAPTER_MODE=real             — hits the real Booking Connectivity
//                                           API via OAuth2 + XML over HTTPS.
//
// Real-mode endpoints (override the base via BOOKING_API_BASE_URL):
//   POST {base}/hotels/xml/availability    (inventory push)
//   POST {base}/hotels/xml/rates           (rate push)
//   POST {base}/hotels/xml/restrictions    (CTA / CTD / MinLOS / MaxLOS)
//   GET  {base}/hotels/xml/reservations    (reservations pull)
//   POST oauth.booking.com/oauth2/token    (token exchange)
//
// Sandbox-mode endpoints (override the base via BOOKING_SANDBOX_URL; default
// http://localhost:3000): the adapter POSTs the same XML bodies to the loopback
// mock at POST {base}/channel-manager/_sandbox/booking, which echoes a realistic
// success envelope. No OAuth is performed (a placeholder token is sent).
//
// CREDENTIALS:
//   channel.credentialsJson must contain { client_id, client_secret } at minimum.
//   Optional: { scope, hotelId }. We treat client_secret as a high-value secret
//   that rotates via a vault flow (NOT through the Prisma field-encryption
//   extension introduced in Sprint 32 — credentialsJson stays plain JSON in DB
//   today; a follow-up sprint moves it behind credentialsSecretRef).
//
// RATE LIMITS:
//   Booking enforces ~100 req/min per hotelId. The aggregator batches per
//   sync job, but a per-channel queue would still belong here (see the
//   `// TODO(rate-limit)` markers below).

import type {
  AdapterResult,
  AvailabilityPushItem,
  ChannelAdapter,
  ChannelContext,
  ExternalReservationDTO,
  RatePushItem,
  RestrictionPushItem
} from "../adapter.types.js";
import { BookingOAuthError, getAccessToken } from "./booking/oauth.js";
import { getXml, postXml } from "./booking/http.js";
import { buildAvailabilityXml, buildRatesXml, buildRestrictionsXml } from "./booking/xml.js";
import {
  buildStubCompetitorRates,
  buildStubReservations,
  isInvalidCredentials,
  seedHash,
  simulateLatency
} from "./stub-utils.js";

const PROVIDER = "booking" as const;
const DEFAULT_API_BASE_URL = "https://supply-xml.booking.com";
// Loopback default for sandbox mode: the API hosts its own mock endpoint.
const DEFAULT_SANDBOX_URL = "http://localhost:3000";
// Single path the sandbox mock listens on; the real Distribution paths
// (/hotels/xml/...) are folded into the JSON body as `op` for visibility.
const SANDBOX_PATH = "/channel-manager/_sandbox/booking";
// Placeholder bearer sent to the local mock — sandbox does not do OAuth.
const SANDBOX_TOKEN = "sandbox-no-auth";

type AdapterMode = "stub" | "sandbox" | "real";

function resolveMode(): AdapterMode {
  const mode = (process.env.BOOKING_ADAPTER_MODE ?? "").toLowerCase();
  if (mode === "real") return "real";
  if (mode === "sandbox") return "sandbox";
  return "stub";
}

function resolveBaseUrl(mode: AdapterMode): string {
  const base =
    mode === "sandbox"
      ? process.env.BOOKING_SANDBOX_URL || DEFAULT_SANDBOX_URL
      : process.env.BOOKING_API_BASE_URL || DEFAULT_API_BASE_URL;
  return base.endsWith("/") ? base.slice(0, -1) : base;
}

function endpoint(mode: AdapterMode, path: string): string {
  // In sandbox mode every operation hits the one loopback mock path; the
  // intended Distribution path is preserved in the request body for the mock.
  if (mode === "sandbox") return `${resolveBaseUrl(mode)}${SANDBOX_PATH}`;
  return `${resolveBaseUrl(mode)}${path}`;
}

// Best-effort error extraction from a Booking-shaped XML response.
function extractErrorsFromXml(body: string): string[] {
  const errors: string[] = [];
  const errorRegex = /<error[^>]*>([^<]*)<\/error>/gi;
  let m: RegExpExecArray | null;
  while ((m = errorRegex.exec(body)) !== null) {
    const text = m[1]?.trim();
    if (text) errors.push(text);
  }
  if (errors.length === 0 && body.length > 0) {
    errors.push(`Unexpected response body (truncated): ${body.slice(0, 200)}`);
  }
  return errors;
}

async function pushXml({
  channel,
  mode,
  path,
  xml,
  itemCount,
  opName
}: {
  channel: ChannelContext;
  mode: Exclude<AdapterMode, "stub">;
  path: string;
  xml: string;
  itemCount: number;
  opName: string;
}): Promise<AdapterResult> {
  // TODO(rate-limit): per-channel token bucket (100 req/min) should wrap this call.
  // Sandbox mode does a real HTTP round-trip but against a local mock that does
  // not authenticate, so we skip OAuth and send a placeholder bearer.
  let token: string;
  if (mode === "sandbox") {
    token = SANDBOX_TOKEN;
  } else {
    try {
      token = await getAccessToken(channel);
    } catch (err) {
      const message = err instanceof BookingOAuthError ? err.message : err instanceof Error ? err.message : String(err);
      return { ok: false, pushed: 0, errors: [`OAuth failed during ${opName}: ${message}`], latencyMs: 0 };
    }
  }

  const result = await postXml({ url: endpoint(mode, path), token, xml });
  if (result.ok) {
    return {
      ok: true,
      pushed: itemCount,
      latencyMs: result.latencyMs,
      raw: {
        provider: PROVIDER,
        mode,
        status: result.status,
        requestHash: result.requestHash,
        responseHash: result.responseHash
      }
    };
  }
  const errors =
    result.errorMessage !== undefined ? [result.errorMessage] : extractErrorsFromXml(result.body);
  return {
    ok: false,
    pushed: 0,
    errors,
    latencyMs: result.latencyMs,
    raw: {
      provider: PROVIDER,
      mode,
      status: result.status,
      requestHash: result.requestHash,
      responseHash: result.responseHash
    }
  };
}

// Coarse XML parser for /reservations. This is intentionally regex-based —
// the Distribution reservation envelope is small + flat enough that a real
// SAX parser is overkill for our current usage pattern (we only need
// externalReference + status; everything else stays in payloadJson).
//
// SHARP EDGE: if Booking ever embeds CDATA, namespaces, or nested guest blocks
// with the same tag names, this parser will mis-extract. The fall-back of
// stashing the whole raw XML on payloadJson means the aggregator can still
// dedupe by externalReference even if the inner fields are wrong.
export function parseReservationsXml(xml: string): ExternalReservationDTO[] {
  const out: ExternalReservationDTO[] = [];
  const blockRegex = /<reservation\b([^>]*)>([\s\S]*?)<\/reservation>/gi;
  let blockMatch: RegExpExecArray | null;
  while ((blockMatch = blockRegex.exec(xml)) !== null) {
    const attrs = blockMatch[1] ?? "";
    const inner = blockMatch[2] ?? "";
    const idMatch = /\b(?:id|reservation_id|booking_id)="([^"]+)"/i.exec(attrs);
    const statusAttr = /\bstatus="([^"]+)"/i.exec(attrs);
    const statusInner = /<status>([^<]+)<\/status>/i.exec(inner);
    const externalReference = idMatch?.[1] ?? `unknown-${out.length}`;
    const status = (statusAttr?.[1] ?? statusInner?.[1] ?? "unknown").toLowerCase();
    out.push({
      externalReference,
      status,
      payloadJson: {
        provider: PROVIDER,
        rawXml: blockMatch[0]
      }
    });
  }
  return out;
}

export const bookingAdapter: ChannelAdapter = {
  providerCode: PROVIDER,

  async pushRates({ channel, items }): Promise<AdapterResult> {
    const mode = resolveMode();
    if (mode === "stub") {
      const latencyMs = await simulateLatency(seedHash(channel.id, "pushRates", items.length));
      if (isInvalidCredentials(channel.credentialsJson)) {
        return { ok: false, pushed: 0, errors: ["Booking.com credentials missing or invalid"], latencyMs };
      }
      return { ok: true, pushed: items.length, latencyMs, raw: { stub: true, provider: PROVIDER } };
    }
    const xml = buildRatesXml(items);
    return pushXml({ channel, mode, path: "/hotels/xml/rates", xml, itemCount: items.length, opName: "pushRates" });
  },

  async pushAvailability({ channel, items }): Promise<AdapterResult> {
    const mode = resolveMode();
    if (mode === "stub") {
      const latencyMs = await simulateLatency(seedHash(channel.id, "pushAvail", items.length));
      if (isInvalidCredentials(channel.credentialsJson)) {
        return { ok: false, pushed: 0, errors: ["Booking.com credentials missing or invalid"], latencyMs };
      }
      return { ok: true, pushed: items.length, latencyMs, raw: { stub: true, provider: PROVIDER } };
    }
    const xml = buildAvailabilityXml(items);
    return pushXml({ channel, mode, path: "/hotels/xml/availability", xml, itemCount: items.length, opName: "pushAvailability" });
  },

  async pushRestrictions({ channel, items }): Promise<AdapterResult> {
    const mode = resolveMode();
    if (mode === "stub") {
      const latencyMs = await simulateLatency(seedHash(channel.id, "pushRestr", items.length));
      if (isInvalidCredentials(channel.credentialsJson)) {
        return { ok: false, pushed: 0, errors: ["Booking.com credentials missing or invalid"], latencyMs };
      }
      return { ok: true, pushed: items.length, latencyMs, raw: { stub: true, provider: PROVIDER } };
    }
    const xml = buildRestrictionsXml(items);
    return pushXml({ channel, mode, path: "/hotels/xml/restrictions", xml, itemCount: items.length, opName: "pushRestrictions" });
  },

  async fetchReservations({ channel, since }) {
    const mode = resolveMode();
    // Sandbox mode shares stub's reservation-pull behaviour: the loopback mock
    // is a push target only (it has no reservation feed to read back), so we
    // return deterministic reservations rather than GET the mock.
    if (mode === "stub" || mode === "sandbox") {
      const latencyMs = await simulateLatency(seedHash(channel.id, "fetchRes"));
      void latencyMs;
      if (mode === "stub" && isInvalidCredentials(channel.credentialsJson)) {
        return { ok: false, reservations: [], errors: ["Booking.com credentials missing or invalid"] };
      }
      return { ok: true, reservations: buildStubReservations(channel.id, since, PROVIDER) };
    }

    let token: string;
    try {
      token = await getAccessToken(channel);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, reservations: [], errors: [`OAuth failed during fetchReservations: ${message}`] };
    }
    const url = `${endpoint(mode, "/hotels/xml/reservations")}?last_change=${encodeURIComponent(since.toISOString())}`;
    const result = await getXml({ url, token });
    if (!result.ok) {
      const errors =
        result.errorMessage !== undefined ? [result.errorMessage] : extractErrorsFromXml(result.body);
      return { ok: false, reservations: [], errors };
    }
    try {
      const reservations = parseReservationsXml(result.body);
      return { ok: true, reservations };
    } catch (err) {
      // Parser fall-back: stash the raw XML so the aggregator can at least
      // dedupe by externalReference once it has a proper parser.
      const message = err instanceof Error ? err.message : String(err);
      return {
        ok: true,
        reservations: [
          {
            externalReference: `booking-raw-${result.responseHash.slice(0, 12)}`,
            status: "unknown",
            payloadJson: { provider: PROVIDER, rawXml: result.body, parseError: message }
          }
        ]
      };
    }
  },

  async testCredentials({ channel }) {
    const mode = resolveMode();
    if (mode === "stub") {
      await simulateLatency(seedHash(channel.id, "testCreds"));
      if (isInvalidCredentials(channel.credentialsJson)) {
        return { ok: false, error: "Credentials missing or rejected" };
      }
      return { ok: true, metadata: { hotelId: channel.credentialsJson?.hotelId ?? "STUB-BKG", provider: PROVIDER } };
    }
    if (mode === "sandbox") {
      // Sandbox: prove the real HTTP path works by POSTing a probe to the local
      // mock. No OAuth, no real creds required — this is exactly the round-trip
      // validation a hotelier runs before going live.
      const probe = buildAvailabilityXml([]);
      const result = await postXml({ url: endpoint(mode, "/hotels/xml/availability"), token: SANDBOX_TOKEN, xml: probe });
      if (result.ok) {
        return {
          ok: true,
          metadata: { provider: PROVIDER, mode: "sandbox", status: result.status, responseHash: result.responseHash }
        };
      }
      return {
        ok: false,
        error: result.errorMessage ?? `Sandbox mock returned ${result.status}`
      };
    }
    // Real mode: validate by performing an OAuth round trip. We deliberately
    // short-circuit if there are no creds at all so test runs don't hit the
    // network just to confirm what we already know.
    if (isInvalidCredentials(channel.credentialsJson)) {
      return { ok: false, error: "Booking.com credentials missing or invalid" };
    }
    try {
      await getAccessToken(channel);
      return { ok: true, metadata: { provider: PROVIDER, mode: "real" } };
    } catch (err) {
      const message = err instanceof BookingOAuthError ? err.message : err instanceof Error ? err.message : String(err);
      return { ok: false, error: message };
    }
  },

  async fetchCompetitorRates({ channel, dateRange }) {
    // Competitor rates aren't part of Booking's Distribution surface; the data
    // would come from a separate Demand API. For both stub and real mode we
    // currently return deterministic placeholder data so the UI keeps
    // rendering.
    await simulateLatency(seedHash(channel.id, "fetchComp"));
    return { ok: true, rates: buildStubCompetitorRates(channel.id, dateRange, PROVIDER) };
  }
};
