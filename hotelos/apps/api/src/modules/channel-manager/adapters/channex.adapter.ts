// Channex aggregator adapter (rate grid v2 · the realistic route to production).
//
// Why Channex: Booking.com has paused onboarding of new connectivity
// providers and Expedia EQC needs a signed provider agreement; Channex is an
// already-certified channel manager with a REST/JSON API and a self-service
// staging environment (https://staging.channex.io) where a property, room
// types, rate plans and even a Booking.com test connection can be created
// without any commercial step. One Channex "property" fans out to every OTA
// connected on the Channex side — Booking, Expedia, Airbnb, Vrbo, Hotelbeds…
//
// API (https://docs.channex.io):
//   auth        header `user-api-key: <key>` on every request
//   ARI         POST /api/v1/restrictions  { values: [{ property_id, rate_plan_id, date | date_from+date_to,
//                    rate, rates:[{occupancy, rate}], min_stay_arrival, min_stay_through, max_stay,
//                    closed_to_arrival, closed_to_departure, stop_sell }] }
//               POST /api/v1/availability  { values: [{ property_id, room_type_id, date | date_from+date_to, availability }] }
//   bookings    GET  /api/v1/booking_revisions/feed?filter[property_id]=…     then POST /api/v1/booking_revisions/:id/ack
//   channels    GET  /api/v1/channels?filter[property_id]=…                    (OTAs connected on the Channex side)
//   Limits: Channex documents a per-key throttle (HTTP 429 with Retry-After);
//   we declare 60 req/min and 1.000 values per request (their documented max).
//
// Answer semantics (docs.channex.io/api-v.1-documentation/ari): a value with
// wrong data is REJECTED FROM THE UPDATE and reported as a warning in a
// 200 response — `meta.warnings[]` echoes the value (property_id,
// rate_plan_id | room_type_id, date | date_from/date_to…) plus
// `warning: { field: [message] }`; the other values are applied. The parser
// maps such a warning back to the item it echoes and marks it rejected. A 4xx
// (bad_request with `details: string[]`, unauthorized, too_many_requests) is
// a request-level refusal: nothing of the batch is confirmed.
//
// Restriction vocabulary of POST /restrictions: rate, rates, min_stay_arrival,
// min_stay_through, min_stay, max_stay, closed_to_arrival,
// closed_to_departure, stop_sell. There is no advance-booking field:
// minAdvanceDays / maxAdvanceDays are reported as a warning, never sent.
//
// Modes: stub/sandbox → in-process simulator validating the same JSON;
// real → HTTPS to CHANNEX_BASE_URL (staging by default; production is
// https://app.channex.io, set explicitly once certified).
//
// Credentials: { apiKey, propertyId (Channex property id), webhookSecret? }.

import type {
  AdapterCapabilities,
  AdapterDeps,
  AdapterRejection,
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
import { buildStubReservations } from "./stub-utils.js";
import { httpRequest, joinUrl } from "./transport.js";

const PROVIDER = "channex" as const;
export const DEFAULT_CHANNEX_BASE_URL = "https://staging.channex.io";

export const CHANNEX_CAPABILITIES: AdapterCapabilities = {
  rates: true,
  availability: true,
  restrictions: true,
  reservationsPull: true,
  occupancyPricing: true,
  derivedPricing: true,
  maxItemsPerRequest: 1000,
  rateLimitPerMinute: 60
};

export function channexBaseUrl(): string {
  return process.env.CHANNEX_BASE_URL || DEFAULT_CHANNEX_BASE_URL;
}

export function channexApiKey(channel: ChannelContext): string | null {
  const creds = channel.credentials ?? {};
  const key = creds.apiKey ?? creds.api_key ?? creds.CHANNEX_API_KEY ?? creds.userApiKey;
  return typeof key === "string" && key.length > 0 ? key : null;
}

export function channexPropertyId(channel: ChannelContext): string {
  const creds = channel.credentials ?? {};
  const id = channel.externalPropertyCode ?? creds.propertyId ?? creds.property_id ?? creds.channexPropertyId;
  if (typeof id === "string" && id.length > 0) return id;
  return channel.mode === "stub" ? "sbx-property" : "";
}

type ChannexValue = Record<string, unknown>;

export function buildRestrictionValues(propertyId: string, items: RatePushItem[]): { values: ChannexValue[]; rejected: AdapterRejection[] } {
  const values: ChannexValue[] = [];
  const rejected: AdapterRejection[] = [];
  items.forEach((item, itemIndex) => {
    const value: ChannexValue = { property_id: propertyId, rate_plan_id: item.externalRateCode, date: item.date };
    if (item.pricingModel === "obp" && item.occupancyPrices) {
      const rates = Object.entries(item.occupancyPrices)
        .filter(([k, v]) => /^\d+$/.test(k) && Number.isFinite(v))
        .map(([k, v]) => ({ occupancy: Number(k), rate: round2(v) }));
      if (rates.length === 0 && item.amount === undefined) {
        rejected.push({ itemIndex, code: "missing_rate", message: "Sin precio por ocupación ni precio base." });
        return;
      }
      if (rates.length > 0) value.rates = rates;
      if (item.amount !== undefined) value.rate = round2(item.amount);
    } else {
      if (item.amount === undefined || !Number.isFinite(item.amount)) {
        rejected.push({ itemIndex, code: "missing_rate", message: "Sin precio." });
        return;
      }
      value.rate = round2(item.amount);
    }
    values.push(value);
  });
  return { values, rejected };
}

export function buildRestrictionOnlyValues(propertyId: string, items: RestrictionPushItem[]): { values: ChannexValue[]; rejected: AdapterRejection[]; warnings: string[] } {
  const values: ChannexValue[] = [];
  const rejected: AdapterRejection[] = [];
  let advanceDropped = 0;
  items.forEach((item, itemIndex) => {
    if (!item.externalRateCode) {
      rejected.push({ itemIndex, code: "unmapped_rate_plan", message: "Channex aplica las restricciones por rate plan: falta externalRateCode." });
      return;
    }
    const value: ChannexValue = {
      property_id: propertyId,
      rate_plan_id: item.externalRateCode,
      date: item.date,
      closed_to_arrival: item.cta,
      closed_to_departure: item.ctd,
      stop_sell: item.closed || item.stopSell
    };
    if (typeof item.minStay === "number") value.min_stay_arrival = item.minStay;
    if (typeof item.minStayThrough === "number") value.min_stay_through = item.minStayThrough;
    if (typeof item.maxStay === "number") value.max_stay = item.maxStay;
    if (typeof item.minAdvanceDays === "number" || typeof item.maxAdvanceDays === "number") advanceDropped++;
    values.push(value);
  });
  const warnings = advanceDropped > 0 ? [`Channex no admite restricciones de antelación (min/max advance days): ${advanceDropped} item(s) las omiten.`] : [];
  return { values, rejected, warnings };
}

export function buildAvailabilityValues(propertyId: string, items: AvailabilityPushItem[]): ChannexValue[] {
  return items.map((item) => ({ property_id: propertyId, room_type_id: item.externalRoomCode, date: item.date, availability: Math.max(0, Math.floor(item.count)) }));
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Field errors of a Channex warning object (`warning: { field: [msg] }`) as one line; null when the warning carries none. */
function warningFieldErrors(w: Record<string, unknown>): string | null {
  const fields = isRecord(w.warning) ? w.warning : isRecord(w.errors) ? w.errors : null;
  if (!fields) return null;
  const parts = Object.entries(fields).map(([field, msgs]) => `${field}: ${(Array.isArray(msgs) ? msgs : [msgs]).map(String).join(", ")}`);
  return parts.length ? parts.join("; ") : null;
}

/** Index of the sent value a Channex warning echoes (same product id and date / date range), or -1. */
function matchWarningToValue(w: Record<string, unknown>, sent: ChannexValue[]): number {
  return sent.findIndex((v) => {
    const sameProduct = (w.rate_plan_id !== undefined && w.rate_plan_id === v.rate_plan_id) || (w.room_type_id !== undefined && w.room_type_id === v.room_type_id);
    if (!sameProduct) return false;
    if (typeof v.date === "string") {
      if (w.date === v.date) return true;
      return typeof w.date_from === "string" && typeof w.date_to === "string" && w.date_from <= v.date && v.date <= w.date_to;
    }
    return w.date_from === v.date_from && w.date_to === v.date_to;
  });
}

/**
 * Channex answers 200 {data, meta: {warnings: [...]}}: every warning that
 * carries `warning: {field: [msg]}` and echoes a sent value means THAT value
 * was rejected from the update (the rest was applied); string warnings are
 * notices. A 4xx {errors: {code, title, details: string[]}} refuses the whole
 * request. `sent` (the values in request order) is what lets a warning be
 * mapped back to its item; without it a field warning is a request-level
 * warning and the batch stays confirmed.
 */
export function parseChannexPushResponse(body: string, itemCount: number, sent: ChannexValue[] = []): ParsedProviderResponse {
  let json: unknown;
  try {
    json = body.length ? JSON.parse(body) : {};
  } catch {
    return { ok: false, accepted: 0, rejected: [], errors: ["Channex respondió un cuerpo no JSON."] };
  }
  const obj = isRecord(json) ? json : {};
  const errors = isRecord(obj.errors) ? obj.errors : null;
  if (errors) {
    const details = Array.isArray(errors.details)
      ? errors.details.map(String)
      : isRecord(errors.details)
        ? Object.entries(errors.details).map(([k, v]) => `${k}: ${isRecord(v) ? Object.entries(v).map(([f, m]) => `${f}: ${(Array.isArray(m) ? m : [m]).map(String).join(", ")}`).join("; ") : String(v)}`)
        : [];
    const head = `${String(errors.code ?? "error")}: ${String(errors.title ?? "Channex rechazó la petición")}`;
    return { ok: false, accepted: 0, rejected: [], errors: [details.length ? `${head} (${details.join(" | ")})` : head] };
  }
  const meta = isRecord(obj.meta) ? obj.meta : {};
  const warnings: string[] = [];
  const rejectedByIndex = new Map<number, AdapterRejection>();
  for (const w of Array.isArray(meta.warnings) ? meta.warnings : []) {
    if (typeof w === "string") {
      warnings.push(w);
      continue;
    }
    if (!isRecord(w)) {
      warnings.push(JSON.stringify(w));
      continue;
    }
    const fieldErrors = warningFieldErrors(w);
    if (fieldErrors === null) {
      warnings.push(typeof w.message === "string" ? w.message : JSON.stringify(w));
      continue;
    }
    const index = matchWarningToValue(w, sent);
    if (index >= 0 && index < itemCount) {
      if (!rejectedByIndex.has(index)) rejectedByIndex.set(index, { itemIndex: index, code: "channex_warning", message: `Channex rechazó el value: ${fieldErrors}` });
    } else {
      warnings.push(`Aviso de Channex sin value identificable: ${fieldErrors}`);
    }
  }
  const rejected = [...rejectedByIndex.values()].sort((a, b) => a.itemIndex - b.itemIndex);
  return { ok: true, accepted: Math.max(0, itemCount - rejected.length), rejected, errors: [], warnings };
}

/** Merges local (pre-send) rejections with the provider's, re-indexing the provider's answer onto the original item indexes. */
function mergeRejections(localRejected: AdapterRejection[], sentIndexes: number[], result: AdapterResult): AdapterResult {
  if (localRejected.length === 0) return result;
  const remapped = result.rejected.map((r) => ({ ...r, itemIndex: sentIndexes[r.itemIndex] ?? r.itemIndex }));
  return { ...result, rejected: [...localRejected, ...remapped].sort((a, b) => a.itemIndex - b.itemIndex) };
}

export function createChannexAdapter(deps: AdapterDeps = {}): ChannelAdapter {
  function headers(channel: ChannelContext): Record<string, string> {
    return { "Content-Type": "application/json", Accept: "application/json", "user-api-key": channexApiKey(channel) ?? "sandbox-no-key" };
  }

  function guard(channel: ChannelContext): AdapterResult | null {
    if (channel.mode !== "stub" && !channexApiKey(channel)) {
      return failedResult({ errors: ["Falta apiKey de Channex (user-api-key) en las credenciales del canal."], retryable: false });
    }
    if (!channexPropertyId(channel)) {
      return failedResult({ errors: ["Falta propertyId de Channex en las credenciales del canal."], retryable: false });
    }
    return null;
  }

  async function post(channel: ChannelContext, path: "restrictions" | "availability", values: ChannexValue[], itemCount: number): Promise<AdapterResult> {
    return executePush({
      channel,
      provider: "channex",
      endpoint: path,
      url: joinUrl(channexBaseUrl(), `/api/v1/${path}`),
      headers: headers(channel),
      body: JSON.stringify({ values }),
      itemCount,
      deps,
      parse: (body, count) => parseChannexPushResponse(body, count, values)
    });
  }

  async function pushWithLocalRejections(
    channel: ChannelContext,
    path: "restrictions" | "availability",
    built: { values: ChannexValue[]; rejected: AdapterRejection[]; warnings?: string[] },
    total: number
  ): Promise<AdapterResult> {
    const g = guard(channel);
    if (g) return g;
    const localWarnings = built.warnings ?? [];
    if (built.values.length === 0) {
      return { ok: true, accepted: 0, rejected: built.rejected, errors: [], latencyMs: 0, requestHash: "", responseHash: "", warnings: localWarnings, raw: { provider: PROVIDER, mode: channel.mode, skipped: "nothing to send" } };
    }
    const rejectedSet = new Set(built.rejected.map((r) => r.itemIndex));
    const sentIndexes = Array.from({ length: total }, (_, i) => i).filter((i) => !rejectedSet.has(i));
    const result = await post(channel, path, built.values, built.values.length);
    const merged = mergeRejections(built.rejected, sentIndexes, result);
    return localWarnings.length ? { ...merged, warnings: [...(merged.warnings ?? []), ...localWarnings] } : merged;
  }

  return {
    providerCode: PROVIDER,
    capabilities: () => CHANNEX_CAPABILITIES,

    async pushRates({ channel, items }: { channel: ChannelContext; items: RatePushItem[] }) {
      return pushWithLocalRejections(channel, "restrictions", buildRestrictionValues(channexPropertyId(channel), items), items.length);
    },

    async pushRestrictions({ channel, items }: { channel: ChannelContext; items: RestrictionPushItem[] }) {
      return pushWithLocalRejections(channel, "restrictions", buildRestrictionOnlyValues(channexPropertyId(channel), items), items.length);
    },

    async pushAvailability({ channel, items }: { channel: ChannelContext; items: AvailabilityPushItem[] }) {
      return pushWithLocalRejections(channel, "availability", { values: buildAvailabilityValues(channexPropertyId(channel), items), rejected: [] }, items.length);
    },

    async pullReservations({ channel, since, cursor }): Promise<PullReservationsResult> {
      if (channel.mode !== "real") {
        return { ok: true, reservations: buildStubReservations(channel.id, since, PROVIDER), nextCursor: null };
      }
      const key = channexApiKey(channel);
      if (!key) return { ok: false, reservations: [], nextCursor: cursor ?? null, errors: ["Falta apiKey de Channex."] };
      const qs = new URLSearchParams({ "filter[property_id]": channexPropertyId(channel), "pagination[limit]": "100" });
      if (cursor) qs.set("pagination[page]", cursor);
      const res = await httpRequest({ url: joinUrl(channexBaseUrl(), `/api/v1/booking_revisions/feed?${qs.toString()}`), method: "GET", headers: headers(channel), timeoutMs: deps.timeoutMs, fetchImpl: deps.fetchImpl, now: deps.now });
      if (!res.ok) return { ok: false, reservations: [], nextCursor: cursor ?? null, errors: [res.errorMessage ?? `booking_revisions/feed respondió ${res.status}`] };
      let json: Record<string, unknown>;
      try {
        json = JSON.parse(res.body) as Record<string, unknown>;
      } catch {
        return { ok: false, reservations: [], nextCursor: cursor ?? null, errors: ["Respuesta no JSON de Channex."] };
      }
      const rows = Array.isArray(json.data) ? (json.data as Array<Record<string, unknown>>) : [];
      const reservations = rows.map((row, i) => {
        const attrs = (row.attributes && typeof row.attributes === "object" ? row.attributes : {}) as Record<string, unknown>;
        const status = String(attrs.status ?? "new").toLowerCase();
        return {
          externalReference: String(row.id ?? attrs.unique_id ?? `channex-unknown-${i}`),
          status: status === "cancelled" ? "cancelled" : status === "modified" ? "modified" : "confirmed",
          payloadJson: {
            provider: PROVIDER,
            channelId: channel.id,
            otaName: attrs.ota_name ?? null,
            otaReservationCode: attrs.ota_reservation_code ?? null,
            guestName: attrs.customer && typeof attrs.customer === "object" ? `${(attrs.customer as Record<string, unknown>).name ?? ""} ${(attrs.customer as Record<string, unknown>).surname ?? ""}`.trim() : null,
            arrivalDate: attrs.arrival_date ?? null,
            departureDate: attrs.departure_date ?? null,
            totalAmount: attrs.amount !== undefined ? Number(attrs.amount) : null,
            currency: attrs.currency ?? null,
            raw: row
          }
        };
      });
      const meta = (json.meta && typeof json.meta === "object" ? json.meta : {}) as Record<string, unknown>;
      const nextCursor = meta.next_page !== undefined && meta.next_page !== null ? String(meta.next_page) : null;
      return { ok: true, reservations, nextCursor };
    },

    async acknowledgeReservations({ channel, ids }) {
      if (ids.length === 0 || channel.mode !== "real") return { ok: true };
      const errors: string[] = [];
      for (const id of ids) {
        const res = await httpRequest({ url: joinUrl(channexBaseUrl(), `/api/v1/booking_revisions/${encodeURIComponent(id)}/ack`), method: "POST", headers: headers(channel), body: "{}", timeoutMs: deps.timeoutMs, fetchImpl: deps.fetchImpl, now: deps.now });
        if (!res.ok) errors.push(`${id}: ${res.errorMessage ?? `HTTP ${res.status}`}`);
      }
      return errors.length ? { ok: false, errors } : { ok: true };
    },

    async testCredentials({ channel }): Promise<TestCredentialsResult> {
      if (channel.mode === "stub") return { ok: true, metadata: { provider: PROVIDER, mode: "stub", note: "Modo stub: no se verifica ninguna credencial." } };
      const g = guard(channel);
      if (g) return { ok: false, error: g.errors.join("; ") };
      if (channel.mode === "sandbox") {
        const probe = await post(channel, "availability", [{ property_id: channexPropertyId(channel), room_type_id: "PROBE", date: new Date().toISOString().slice(0, 10), availability: 0 }], 1);
        return probe.ok ? { ok: true, metadata: { provider: PROVIDER, mode: "sandbox", propertyId: channexPropertyId(channel), responseHash: probe.responseHash } } : { ok: false, error: probe.errors.join("; ") };
      }
      const res = await httpRequest({ url: joinUrl(channexBaseUrl(), `/api/v1/channels?filter[property_id]=${encodeURIComponent(channexPropertyId(channel))}`), method: "GET", headers: headers(channel), timeoutMs: deps.timeoutMs, fetchImpl: deps.fetchImpl, now: deps.now });
      if (!res.ok) return { ok: false, error: res.errorMessage ?? `GET /api/v1/channels respondió ${res.status}` };
      let count = 0;
      try {
        const json = JSON.parse(res.body) as { data?: unknown[] };
        count = Array.isArray(json.data) ? json.data.length : 0;
      } catch {
        return { ok: false, error: "Respuesta no JSON de Channex." };
      }
      return { ok: true, metadata: { provider: PROVIDER, mode: "real", propertyId: channexPropertyId(channel), connectedChannels: count } };
    }
  };
}

/** OTAs connected on the Channex side for this property (real mode only; the simulator lists two). */
export async function listChannexConnectedChannels(channel: ChannelContext, deps: AdapterDeps = {}): Promise<{ ok: boolean; channels: Array<{ id: string; channel: string; title: string; active: boolean }>; error?: string }> {
  if (channel.mode !== "real") {
    return {
      ok: true,
      channels: [
        { id: "sbx-channel-booking", channel: "BookingCom", title: "Booking.com (simulado)", active: true },
        { id: "sbx-channel-expedia", channel: "Expedia", title: "Expedia (simulado)", active: true }
      ]
    };
  }
  const key = channexApiKey(channel);
  if (!key) return { ok: false, channels: [], error: "Falta apiKey de Channex." };
  const res = await httpRequest({
    url: joinUrl(channexBaseUrl(), `/api/v1/channels?filter[property_id]=${encodeURIComponent(channexPropertyId(channel))}`),
    method: "GET",
    headers: { Accept: "application/json", "user-api-key": key },
    timeoutMs: deps.timeoutMs,
    fetchImpl: deps.fetchImpl,
    now: deps.now
  });
  if (!res.ok) return { ok: false, channels: [], error: res.errorMessage ?? `HTTP ${res.status}` };
  try {
    const json = JSON.parse(res.body) as { data?: Array<{ id: string; attributes?: Record<string, unknown> }> };
    return {
      ok: true,
      channels: (json.data ?? []).map((row) => ({
        id: String(row.id),
        channel: String(row.attributes?.channel ?? ""),
        title: String(row.attributes?.title ?? ""),
        active: Boolean(row.attributes?.is_active)
      }))
    };
  } catch {
    return { ok: false, channels: [], error: "Respuesta no JSON de Channex." };
  }
}

export const channexAdapter: ChannelAdapter = createChannexAdapter();
