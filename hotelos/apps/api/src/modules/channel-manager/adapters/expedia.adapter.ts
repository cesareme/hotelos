// Expedia adapter (rate grid v2 · EQC XML, contract-ready against the local
// simulator).
//
// Expedia QuickConnect is XML with the credentials in the body (an EQC
// username/password pair issued per connectivity provider, NOT OAuth — the v1
// "v3 JSON + OAuth" description was wrong):
//   AR  POST {EXPEDIA_API_BASE_URL}/eqc/ar   AvailRateUpdateRQ   (rates, availability, restrictions)
//   BR  POST {EXPEDIA_API_BASE_URL}/eqc/br   BookingRetrievalRQ  (pending bookings)
//   BC  POST {EXPEDIA_API_BASE_URL}/eqc/bc   BookingConfirmRQ    (ack with our confirmation number)
//   Default base: https://services.expediapartnercentral.com · Content-Type: text/xml.
//
// HONEST STATUS: Anfitorio has no EQC account (EQC onboarding requires a
// signed connectivity agreement and certification). `stub`/`sandbox` run
// against the in-process simulator that enforces the AR schema; `real` mode is
// wired but unused. The production route for Expedia is Channex.
//
// EQC semantics that drain.service must know: AR is all-or-nothing — one bad
// element rejects the whole message (no per-item RecordID), so a failing batch
// marks every delivery of the batch rejected with the same error. Error codes
// 4xxx are Expedia system errors ("please retry"): transient, they go through
// the backoff; 1xxx (authentication) and 2xxx/3xxx (schema, business) are
// definitive. A <Success> that wraps <Warning> children is still a success:
// the update was applied and the warnings are kept in the sync job.
//
// EQC AR has no advance-booking restriction: minAdvanceDays / maxAdvanceDays
// of an item are reported as a warning instead of being dropped in silence.
//
// "Probar conexión" in real mode is a READ (BookingRetrievalRQ, pending
// bookings): the previous AvailRateUpdateRQ probe with a RoomType "PROBE"
// was a write against production that Expedia rejects (unknown room type),
// so the check could never pass. The sandbox keeps the AR probe because the
// simulator only knows AR.
//
// Credentials: { username, password, hotelId } (+ simulator in sandbox).
// `hotelId` is mandatory in sandbox/real: <Hotel id=""/> never leaves the box.

import type {
  AdapterCapabilities,
  AdapterDeps,
  AdapterResult,
  AvailabilityPushItem,
  ChannelAdapter,
  ChannelContext,
  PullReservationsResult,
  RatePushItem,
  RestrictionPushItem,
  TestCredentialsResult
} from "../adapter.types.js";
import { failedResult } from "../adapter.types.js";
import { executePush, type ParsedProviderResponse } from "./execute.js";
import {
  buildAvailRateUpdateAvailabilityXml,
  buildAvailRateUpdateRatesXml,
  buildAvailRateUpdateRestrictionsXml,
  buildBookingConfirmXml,
  buildBookingRetrievalXml,
  isTransientEqcCode,
  parseBookingRetrievalXml,
  parseEqcResponse,
  type EqcAuth
} from "./expedia/xml.js";
import { buildStubCompetitorRates, buildStubReservations } from "./stub-utils.js";
import { httpRequest, joinUrl } from "./transport.js";

const PROVIDER = "expedia" as const;
export const DEFAULT_EXPEDIA_API_BASE_URL = "https://services.expediapartnercentral.com";
const MISSING_HOTEL_ID = "Falta hotelId (id de la propiedad en Expedia) en las credenciales del canal.";

export const EXPEDIA_CAPABILITIES: AdapterCapabilities = {
  rates: true,
  availability: true,
  restrictions: true,
  reservationsPull: true,
  occupancyPricing: true,
  derivedPricing: false,
  maxItemsPerRequest: 500,
  rateLimitPerMinute: 60
};

function baseUrl(): string {
  return process.env.EXPEDIA_API_BASE_URL || DEFAULT_EXPEDIA_API_BASE_URL;
}

export function eqcAuthFor(channel: ChannelContext): EqcAuth | null {
  const creds = channel.credentials ?? {};
  const username = creds.username ?? creds.user ?? creds.eqcUsername;
  const password = creds.password ?? creds.eqcPassword;
  const hotelId = channel.externalPropertyCode ?? creds.hotelId ?? creds.hotel_id ?? creds.resortID ?? creds.resortId;
  if (channel.mode === "stub") {
    return {
      username: typeof username === "string" && username ? username : "EQC-STUB",
      password: typeof password === "string" && password ? password : "stub",
      hotelId: typeof hotelId === "string" || typeof hotelId === "number" ? String(hotelId) : "SBX-HOTEL"
    };
  }
  if (typeof username !== "string" || !username || typeof password !== "string" || !password) return null;
  return { username, password, hotelId: typeof hotelId === "string" || typeof hotelId === "number" ? String(hotelId) : "" };
}

export function parseEqcPushResponse(body: string, itemCount: number): ParsedProviderResponse {
  const rs = parseEqcResponse(body);
  if (rs.error) {
    return { ok: false, accepted: 0, rejected: [], errors: [`${rs.error.code}: ${rs.error.message}`], warnings: rs.warnings, retryable: isTransientEqcCode(rs.error.code) };
  }
  if (!rs.success) return { ok: false, accepted: 0, rejected: [], errors: ["Expedia no confirmó la petición (sin <Success/>)."], warnings: rs.warnings };
  return { ok: true, accepted: itemCount, rejected: [], errors: [], warnings: rs.warnings };
}

/** Items carrying an advance-booking restriction EQC AR cannot express. */
export function unsupportedAdvanceRestrictions(items: RestrictionPushItem[]): number {
  return items.filter((i) => typeof i.minAdvanceDays === "number" || typeof i.maxAdvanceDays === "number").length;
}

export function createExpediaAdapter(deps: AdapterDeps = {}): ChannelAdapter {
  const headers = { "Content-Type": "text/xml; charset=utf-8", Accept: "text/xml, application/xml" };

  async function push(channel: ChannelContext, body: string, itemCount: number): Promise<AdapterResult> {
    return executePush({ channel, provider: "expedia", endpoint: "ar", url: joinUrl(baseUrl(), "/eqc/ar"), headers, body, itemCount, deps, parse: parseEqcPushResponse });
  }

  function missingAuth(): AdapterResult {
    return failedResult({ errors: ["Faltan username / password EQC de Expedia en las credenciales del canal."], retryable: false });
  }

  /** Credentials + hotel id, or the refusal to send. */
  function authOrRefusal(channel: ChannelContext): { auth: EqcAuth } | { refused: AdapterResult } {
    const auth = eqcAuthFor(channel);
    if (!auth) return { refused: missingAuth() };
    if (!auth.hotelId) return { refused: failedResult({ errors: [MISSING_HOTEL_ID], retryable: false }) };
    return { auth };
  }

  return {
    providerCode: PROVIDER,
    capabilities: () => EXPEDIA_CAPABILITIES,

    async pushRates({ channel, items }: { channel: ChannelContext; items: RatePushItem[] }) {
      const gate = authOrRefusal(channel);
      if ("refused" in gate) return gate.refused;
      return push(channel, buildAvailRateUpdateRatesXml(gate.auth, items), items.length);
    },

    async pushAvailability({ channel, items }: { channel: ChannelContext; items: AvailabilityPushItem[] }) {
      const gate = authOrRefusal(channel);
      if ("refused" in gate) return gate.refused;
      return push(channel, buildAvailRateUpdateAvailabilityXml(gate.auth, items), items.length);
    },

    async pushRestrictions({ channel, items }: { channel: ChannelContext; items: RestrictionPushItem[] }) {
      const gate = authOrRefusal(channel);
      if ("refused" in gate) return gate.refused;
      const result = await push(channel, buildAvailRateUpdateRestrictionsXml(gate.auth, items), items.length);
      const unsupported = unsupportedAdvanceRestrictions(items);
      if (unsupported === 0) return result;
      return {
        ...result,
        warnings: [...(result.warnings ?? []), `Expedia (EQC AR) no admite restricciones de antelación: minAdvanceDays / maxAdvanceDays de ${unsupported} item(s) no se envían.`]
      };
    },

    async pullReservations({ channel, since, cursor }): Promise<PullReservationsResult> {
      if (channel.mode !== "real") {
        return { ok: true, reservations: buildStubReservations(channel.id, since, PROVIDER), nextCursor: null };
      }
      const auth = eqcAuthFor(channel);
      if (!auth) return { ok: false, reservations: [], nextCursor: cursor ?? null, errors: ["Faltan credenciales EQC."] };
      if (!auth.hotelId) return { ok: false, reservations: [], nextCursor: cursor ?? null, errors: [MISSING_HOTEL_ID] };
      const res = await httpRequest({ url: joinUrl(baseUrl(), "/eqc/br"), method: "POST", headers, body: buildBookingRetrievalXml(auth), timeoutMs: deps.timeoutMs, fetchImpl: deps.fetchImpl, now: deps.now });
      if (!res.ok) return { ok: false, reservations: [], nextCursor: cursor ?? null, errors: [res.errorMessage ?? `EQC BR respondió ${res.status}`] };
      const rs = parseEqcResponse(res.body);
      if (rs.error) return { ok: false, reservations: [], nextCursor: cursor ?? null, errors: [`${rs.error.code}: ${rs.error.message}`] };
      const reservations = parseBookingRetrievalXml(res.body).map((b) => ({
        externalReference: b.id,
        status: b.type === "Cancel" ? "cancelled" : b.type === "Modify" ? "modified" : "confirmed",
        payloadJson: {
          provider: PROVIDER,
          channelId: channel.id,
          guestName: b.guestName,
          arrivalDate: b.arrivalDate,
          departureDate: b.departureDate,
          totalAmount: b.totalAmount,
          currency: b.currency,
          rawXml: b.rawXml
        }
      }));
      return { ok: true, reservations, nextCursor: null };
    },

    async acknowledgeReservations({ channel, ids }) {
      if (ids.length === 0 || channel.mode !== "real") return { ok: true };
      const auth = eqcAuthFor(channel);
      if (!auth) return { ok: false, errors: ["Faltan credenciales EQC."] };
      const res = await httpRequest({
        url: joinUrl(baseUrl(), "/eqc/bc"),
        method: "POST",
        headers,
        body: buildBookingConfirmXml(auth, ids.map((id) => ({ id, confirmNumber: `ANF-${id}` }))),
        timeoutMs: deps.timeoutMs,
        fetchImpl: deps.fetchImpl,
        now: deps.now
      });
      return res.ok ? { ok: true } : { ok: false, errors: [res.errorMessage ?? `EQC BC respondió ${res.status}`] };
    },

    async testCredentials({ channel }): Promise<TestCredentialsResult> {
      if (channel.mode === "stub") return { ok: true, metadata: { provider: PROVIDER, mode: "stub", note: "Modo stub: no se verifica ninguna credencial." } };
      const auth = eqcAuthFor(channel);
      if (!auth) return { ok: false, error: "Faltan username / password EQC de Expedia." };
      if (!auth.hotelId) return { ok: false, error: MISSING_HOTEL_ID };
      if (channel.mode === "sandbox") {
        // The simulator only speaks AR: a closed-room probe is a valid AR
        // message it fully validates, including Authentication. Never sent to
        // Expedia (see real mode below).
        const probe = buildAvailRateUpdateAvailabilityXml(auth, [{ date: new Date().toISOString().slice(0, 10), externalRoomCode: "PROBE", roomTypeId: "probe", count: 0 }]);
        const result = await push(channel, probe, 1);
        return result.ok
          ? { ok: true, metadata: { provider: PROVIDER, mode: "sandbox", hotelId: auth.hotelId, responseHash: result.responseHash } }
          : { ok: false, error: result.errors.join("; ") || "Expedia rechazó la sonda." };
      }
      // Real: a read (pending bookings) proves credentials + hotel id without writing ARI.
      const res = await httpRequest({ url: joinUrl(baseUrl(), "/eqc/br"), method: "POST", headers, body: buildBookingRetrievalXml(auth), timeoutMs: deps.timeoutMs, fetchImpl: deps.fetchImpl, now: deps.now });
      if (!res.ok) return { ok: false, error: res.errorMessage ?? `EQC BR respondió HTTP ${res.status}` };
      const rs = parseEqcResponse(res.body);
      if (rs.error) return { ok: false, error: `${rs.error.code}: ${rs.error.message}` };
      return { ok: true, metadata: { provider: PROVIDER, mode: "real", hotelId: auth.hotelId, pendingBookings: parseBookingRetrievalXml(res.body).length, responseHash: res.responseHash } };
    },

    async fetchCompetitorRates({ channel, dateRange }) {
      return { ok: true, rates: buildStubCompetitorRates(channel.id, dateRange, PROVIDER) };
    }
  };
}

export const expediaAdapter: ChannelAdapter = createExpediaAdapter();
