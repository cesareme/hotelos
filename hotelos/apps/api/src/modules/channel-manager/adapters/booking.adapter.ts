// Booking.com adapter (rate grid v2 · contract-ready, validated against the
// local simulator).
//
// HONEST STATUS (2026-09): Booking.com has PAUSED onboarding of new
// connectivity providers, so Anfitorio cannot obtain client_id/client_secret
// today. This adapter therefore runs in `stub`/`sandbox` (in-process simulator
// that validates the real OTA 2003B v1.1 shapes) and is wired for `real` mode
// so that, the day credentials exist, only Channel.mode and the credentials
// change. The realistic route to Booking/Expedia in production is the Channex
// aggregator (see channex.adapter.ts and docs/channel-manager-connectivity.md).
//
// Real-mode surface:
//   auth   POST https://connectivity-authentication.booking.com/token-based-authentication/exchange
//          { client_id, client_secret } → { jwt } (1 h, cached per channel, <= 30/h)   (booking/auth.ts)
//   rates  POST {BOOKING_API_BASE_URL}/hotels/ota/OTA_HotelRateAmountNotif
//   avail  POST {BOOKING_API_BASE_URL}/hotels/ota/OTA_HotelAvailNotif   (availability AND restrictions)
//   res    GET  https://secure-supply-xml.booking.com/hotels/ota/OTA_HotelResNotif?hotel_ids=…
//          then POST the OTA_HotelResNotifRS ack to the same host (the
//          extranet serves reservations from secure-supply-xml.booking.com,
//          not from the ARI host; `hotel_ids` is the documented parameter —
//          a plural list — without it Booking returns every hotel of the
//          provider account). A non-default BOOKING_API_BASE_URL (a mock)
//          serves both ARI and reservations, so tests point one variable.
//   Headers: Authorization: Bearer <jwt>; Content-Type: text/xml.
//
// Rate limits (Booking Connectivity): ~10.000 requests/min globally per
// provider and 75-700/min per endpoint depending on the message; we declare
// the conservative per-endpoint figure (75/min) in capabilities() and let
// drain.service batch up to 1.000 messages per request.
//
// Credentials (decrypted by channels.service): { client_id, client_secret,
// hotelId } (+ optional simulator: { failEvery, latencyMs } in sandbox).
// `hotelId` is the HotelCode of every message: sandbox and real refuse to push
// without it (only the credential-less stub gets a placeholder).
//
// Token exchange failures: 5xx / network / 429 are transient (the exchange
// endpoint has its own outages and its 30/h cap); only 400/401/403 mean the
// client credentials themselves are wrong (definitive).

import type {
  AdapterCapabilities,
  AdapterDeps,
  AdapterResult,
  AvailabilityPushItem,
  ChannelAdapter,
  ChannelContext,
  ExternalReservationDTO,
  PullReservationsResult,
  RatePushItem,
  RestrictionPushItem,
  TestCredentialsResult
} from "../adapter.types.js";
import { failedResult } from "../adapter.types.js";
import { BookingAuthError, extractClientCredentials, getBookingJwt } from "./booking/auth.js";
import {
  buildAvailNotifXml,
  buildRateAmountNotifXml,
  buildResNotifAckXml,
  buildRestrictionsNotif,
  parseOtaResponse,
  parseResNotifXml,
  unsupportedOccupancyKeys
} from "./booking/xml.js";
import { executePush, type ParsedProviderResponse } from "./execute.js";
import { buildStubCompetitorRates, buildStubReservations } from "./stub-utils.js";
import { httpRequest, joinUrl } from "./transport.js";

const PROVIDER = "booking" as const;
export const DEFAULT_BOOKING_API_BASE_URL = "https://supply-xml.booking.com";
export const DEFAULT_BOOKING_RESERVATIONS_BASE_URL = "https://secure-supply-xml.booking.com";
const SANDBOX_HOTEL_CODE = "SBX-HOTEL";
const MISSING_HOTEL_ID = "Falta hotelId (código del hotel en Booking.com) en las credenciales del canal.";

export const BOOKING_CAPABILITIES: AdapterCapabilities = {
  rates: true,
  availability: true,
  restrictions: true,
  reservationsPull: true,
  occupancyPricing: true,
  derivedPricing: false,
  maxItemsPerRequest: 1000,
  rateLimitPerMinute: 75
};

function baseUrl(): string {
  return process.env.BOOKING_API_BASE_URL || DEFAULT_BOOKING_API_BASE_URL;
}

/** Reservations host: the extranet's secure host, unless BOOKING_API_BASE_URL was pointed elsewhere (a mock serves both). */
export function reservationsBaseUrl(): string {
  const ari = process.env.BOOKING_API_BASE_URL;
  return ari && ari !== DEFAULT_BOOKING_API_BASE_URL ? ari : DEFAULT_BOOKING_RESERVATIONS_BASE_URL;
}

/**
 * HotelCode of the messages. `null` when the channel has no hotel id in
 * sandbox/real (the caller refuses the push); only the credential-less stub
 * gets the placeholder, so a placeholder can never reach the extranet.
 */
export function hotelCodeFor(channel: ChannelContext): string | null {
  const creds = channel.credentials ?? {};
  const code = channel.externalPropertyCode ?? creds.hotelId ?? creds.hotel_id ?? creds.hotelCode;
  if (typeof code === "string" && code.length > 0) return code;
  if (typeof code === "number") return String(code);
  return channel.mode === "stub" ? SANDBOX_HOTEL_CODE : null;
}

/** Transient exchange failures: no HTTP status (thrown before/without a response), network (0), throttled (429) or 5xx. */
export function isTransientAuthStatus(status: number | undefined): boolean {
  return status === undefined || status === 0 || status === 429 || status >= 500;
}

/**
 * Turns an OTA_*RS body into per-item accept/reject counts. `itemIndexByMessage`
 * translates a RecordID (message index) to the item that produced the message
 * when the builder emitted several messages per item (restrictions); a
 * RecordID outside the request is a request-level error (never a silent
 * confirmation of the wrong item).
 */
export function parseOtaPushResponse(body: string, itemCount: number, itemIndexByMessage?: number[]): ParsedProviderResponse {
  const rs = parseOtaResponse(body);
  const requestLevel = rs.errors.filter((e) => e.recordId === undefined).map((e) => `${e.code}: ${e.shortText}`);
  const rejectedByItem = new Map<number, { code: string; message: string }>();
  for (const e of rs.errors) {
    if (e.recordId === undefined) continue;
    const itemIndex = itemIndexByMessage ? itemIndexByMessage[e.recordId] : e.recordId;
    if (itemIndex === undefined || !Number.isInteger(itemIndex) || itemIndex < 0 || itemIndex >= itemCount) {
      requestLevel.push(`${e.code}: ${e.shortText} (RecordID ${e.recordId} fuera de rango)`);
      continue;
    }
    if (!rejectedByItem.has(itemIndex)) rejectedByItem.set(itemIndex, { code: e.code, message: e.shortText });
  }
  if (requestLevel.length > 0) return { ok: false, accepted: 0, rejected: [], errors: requestLevel, warnings: rs.warnings };
  const rejected = [...rejectedByItem.entries()].sort((a, b) => a[0] - b[0]).map(([itemIndex, r]) => ({ itemIndex, code: r.code, message: r.message }));
  if (!rs.success && rejected.length === 0) return { ok: false, accepted: 0, rejected: [], errors: ["Booking.com no confirmó la petición (sin <Success/>)."], warnings: rs.warnings };
  return { ok: true, accepted: Math.max(0, itemCount - rejected.length), rejected, errors: [], warnings: rs.warnings };
}

function withWarnings(result: AdapterResult, warnings: string[]): AdapterResult {
  if (warnings.length === 0) return result;
  return { ...result, warnings: [...(result.warnings ?? []), ...warnings] };
}

export function createBookingAdapter(deps: AdapterDeps = {}): ChannelAdapter {
  type AuthOutcome = { ok: true; headers: Record<string, string> } | { ok: false; error: string; status?: number };

  async function authHeaders(channel: ChannelContext): Promise<AuthOutcome> {
    const headers: Record<string, string> = { "Content-Type": "text/xml; charset=utf-8", Accept: "text/xml, application/xml" };
    if (channel.mode !== "real") return { ok: true, headers: { ...headers, Authorization: "Bearer sandbox-no-auth" } };
    try {
      const jwt = await getBookingJwt(channel, deps);
      return { ok: true, headers: { ...headers, Authorization: `Bearer ${jwt}` } };
    } catch (err) {
      const message = err instanceof BookingAuthError ? err.message : err instanceof Error ? err.message : String(err);
      return { ok: false, error: message, status: err instanceof BookingAuthError ? err.status : undefined };
    }
  }

  /** Common pre-flight: credentials (sandbox), hotel id (sandbox/real). Null when the push may proceed. */
  function preflight(channel: ChannelContext): AdapterResult | null {
    if (channel.mode === "sandbox" && !extractClientCredentials(channel)) {
      return failedResult({ errors: ["Sandbox de Booking.com: faltan client_id / client_secret en las credenciales del canal."], retryable: false });
    }
    if (channel.mode !== "stub" && hotelCodeFor(channel) === null) {
      return failedResult({ errors: [MISSING_HOTEL_ID], retryable: false });
    }
    return null;
  }

  async function push(
    channel: ChannelContext,
    endpoint: "OTA_HotelRateAmountNotif" | "OTA_HotelAvailNotif",
    body: string,
    itemCount: number,
    itemIndexByMessage?: number[]
  ): Promise<AdapterResult> {
    const auth = await authHeaders(channel);
    if (!auth.ok) {
      return failedResult({ errors: [`Autenticación Booking.com: ${auth.error}`], retryable: isTransientAuthStatus(auth.status) });
    }
    return executePush({
      channel,
      provider: "booking",
      endpoint,
      url: joinUrl(baseUrl(), `/hotels/ota/${endpoint}`),
      headers: auth.headers,
      body,
      itemCount,
      deps,
      parse: (rs, count) => parseOtaPushResponse(rs, count, itemIndexByMessage)
    });
  }

  return {
    providerCode: PROVIDER,
    capabilities: () => BOOKING_CAPABILITIES,

    async pushRates({ channel, items }: { channel: ChannelContext; items: RatePushItem[] }) {
      const refused = preflight(channel);
      if (refused) return refused;
      const hotelCode = hotelCodeFor(channel) as string;
      const xml = buildRateAmountNotifXml({ hotelCode, items });
      const result = await push(channel, "OTA_HotelRateAmountNotif", xml, items.length);
      const dropped = unsupportedOccupancyKeys(items);
      return withWarnings(result, dropped.length ? [`Booking.com no admite suplementos por ocupación (${dropped.join(", ")}): no se envían, solo los precios por número de huéspedes.`] : []);
    },

    async pushAvailability({ channel, items }: { channel: ChannelContext; items: AvailabilityPushItem[] }) {
      const refused = preflight(channel);
      if (refused) return refused;
      const xml = buildAvailNotifXml({ hotelCode: hotelCodeFor(channel) as string, items });
      return push(channel, "OTA_HotelAvailNotif", xml, items.length);
    },

    async pushRestrictions({ channel, items }: { channel: ChannelContext; items: RestrictionPushItem[] }) {
      const refused = preflight(channel);
      if (refused) return refused;
      const notif = buildRestrictionsNotif({ hotelCode: hotelCodeFor(channel) as string, items });
      return push(channel, "OTA_HotelAvailNotif", notif.xml, items.length, notif.itemIndexByMessage);
    },

    async pullReservations({ channel, since, cursor }): Promise<PullReservationsResult> {
      if (channel.mode !== "real") {
        // The simulator has no reservation feed: deterministic stub reservations
        // keep the ingest path exercised (dedup by externalReference).
        return { ok: true, reservations: buildStubReservations(channel.id, since, PROVIDER), nextCursor: null };
      }
      const hotelCode = hotelCodeFor(channel);
      if (hotelCode === null) return { ok: false, reservations: [], nextCursor: cursor ?? null, errors: [MISSING_HOTEL_ID] };
      const auth = await authHeaders(channel);
      if (!auth.ok) return { ok: false, reservations: [], nextCursor: cursor ?? null, errors: [auth.error] };
      const res = await httpRequest({
        url: joinUrl(reservationsBaseUrl(), `/hotels/ota/OTA_HotelResNotif?hotel_ids=${encodeURIComponent(hotelCode)}`),
        method: "GET",
        headers: auth.headers,
        timeoutMs: deps.timeoutMs,
        fetchImpl: deps.fetchImpl,
        now: deps.now
      });
      if (!res.ok) return { ok: false, reservations: [], nextCursor: cursor ?? null, errors: [res.errorMessage ?? `OTA_HotelResNotif respondió ${res.status}`] };
      const reservations: ExternalReservationDTO[] = parseResNotifXml(res.body).map((r) => ({
        externalReference: r.externalReference,
        status: r.status === "cancel" ? "cancelled" : r.status === "modify" ? "modified" : "confirmed",
        payloadJson: {
          provider: PROVIDER,
          channelId: channel.id,
          guestName: r.guestName,
          arrivalDate: r.arrivalDate,
          departureDate: r.departureDate,
          totalAmount: r.totalAmount,
          currency: r.currency,
          rawXml: r.rawXml
        }
      }));
      return { ok: true, reservations, nextCursor: null };
    },

    async acknowledgeReservations({ channel, ids }) {
      if (ids.length === 0) return { ok: true };
      if (channel.mode !== "real") return { ok: true };
      const auth = await authHeaders(channel);
      if (!auth.ok) return { ok: false, errors: [auth.error] };
      const res = await httpRequest({
        url: joinUrl(reservationsBaseUrl(), "/hotels/ota/OTA_HotelResNotif"),
        method: "POST",
        headers: auth.headers,
        body: buildResNotifAckXml(ids),
        timeoutMs: deps.timeoutMs,
        fetchImpl: deps.fetchImpl,
        now: deps.now
      });
      return res.ok ? { ok: true } : { ok: false, errors: [res.errorMessage ?? `Ack respondió ${res.status}`] };
    },

    async testCredentials({ channel }): Promise<TestCredentialsResult> {
      if (channel.mode === "stub") {
        return { ok: true, metadata: { provider: PROVIDER, mode: "stub", hotelId: hotelCodeFor(channel), note: "Modo stub: no se verifica ninguna credencial." } };
      }
      if (!extractClientCredentials(channel)) {
        return { ok: false, error: "Faltan client_id / client_secret de Booking.com." };
      }
      const hotelCode = hotelCodeFor(channel);
      if (hotelCode === null) return { ok: false, error: MISSING_HOTEL_ID };
      if (channel.mode === "sandbox") {
        // Prove the full builder → schema validation path with an empty-safe probe.
        const probe = buildAvailNotifXml({ hotelCode, items: [{ date: new Date().toISOString().slice(0, 10), externalRoomCode: "PROBE", roomTypeId: "probe", count: 0 }] });
        const result = await push(channel, "OTA_HotelAvailNotif", probe, 1);
        return result.ok
          ? { ok: true, metadata: { provider: PROVIDER, mode: "sandbox", hotelId: hotelCode, responseHash: result.responseHash } }
          : { ok: false, error: result.errors.join("; ") || "El simulador rechazó la sonda." };
      }
      try {
        await getBookingJwt(channel, deps);
        return { ok: true, metadata: { provider: PROVIDER, mode: "real", hotelId: hotelCode } };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },

    async fetchCompetitorRates({ channel, dateRange }) {
      // Not part of the Connectivity surface (that is a Demand/Insights API):
      // deterministic placeholder so the parity monitor keeps working.
      return { ok: true, rates: buildStubCompetitorRates(channel.id, dateRange, PROVIDER) };
    }
  };
}

export const bookingAdapter: ChannelAdapter = createBookingAdapter();
