// Booking.com Connectivity token exchange (rate grid v2 · replaces the v1
// OAuth2 client-credentials helper, which pointed at an endpoint Booking does
// not operate).
//
// Booking issues a short-lived JWT for the Connectivity APIs through
//   POST https://connectivity-authentication.booking.com/token-based-authentication/exchange
//   Content-Type: application/json
//   { "client_id": "...", "client_secret": "..." }  →  { "jwt": "..." }
// The JWT is valid for ~1 hour and the exchange endpoint is limited to
// 30 calls per hour per client — so we cache the token per channel (55 min)
// and count exchanges in a sliding hour: the 31st attempt fails locally
// instead of getting the client blocked.
//
// Single-flight: concurrent pushes after expiry share ONE exchange.
// Credentials never leave this module; they are read from the decrypted
// `channel.credentials` on every refresh so a rotated secret takes effect on
// the next refresh without a manual cache reset.

import type { AdapterDeps, ChannelContext } from "../../adapter.types.js";
import { httpRequest } from "../transport.js";

export const DEFAULT_BOOKING_AUTH_URL = "https://connectivity-authentication.booking.com/token-based-authentication/exchange";
export const BOOKING_JWT_TTL_MS = 55 * 60 * 1000;
export const BOOKING_MAX_EXCHANGES_PER_HOUR = 30;

type CachedToken = { jwt: string; expiresAt: number };

const tokenCache = new Map<string, CachedToken>();
const inflight = new Map<string, Promise<string>>();
const exchangeLog = new Map<string, number[]>();

export class BookingAuthError extends Error {
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "BookingAuthError";
    this.status = status;
  }
}

export function readBookingAuthUrl(): string {
  return process.env.BOOKING_OAUTH_URL || DEFAULT_BOOKING_AUTH_URL;
}

export function extractClientCredentials(channel: ChannelContext): { clientId: string; clientSecret: string } | null {
  const creds = channel.credentials;
  if (!creds) return null;
  const clientId = creds.client_id ?? creds.clientId;
  const clientSecret = creds.client_secret ?? creds.clientSecret;
  if (typeof clientId !== "string" || clientId.length === 0) return null;
  if (typeof clientSecret !== "string" || clientSecret.length === 0) return null;
  return { clientId, clientSecret };
}

function recordExchange(channelId: string, now: number): void {
  const window = (exchangeLog.get(channelId) ?? []).filter((t) => now - t < 60 * 60 * 1000);
  window.push(now);
  exchangeLog.set(channelId, window);
}

function exchangesInLastHour(channelId: string, now: number): number {
  return (exchangeLog.get(channelId) ?? []).filter((t) => now - t < 60 * 60 * 1000).length;
}

export async function getBookingJwt(channel: ChannelContext, deps: AdapterDeps = {}): Promise<string> {
  const now = (deps.now ?? Date.now)();
  const cached = tokenCache.get(channel.id);
  if (cached && cached.expiresAt > now) return cached.jwt;
  const pending = inflight.get(channel.id);
  if (pending) return pending;
  const refresh = exchange(channel, deps, now).finally(() => inflight.delete(channel.id));
  inflight.set(channel.id, refresh);
  return refresh;
}

async function exchange(channel: ChannelContext, deps: AdapterDeps, now: number): Promise<string> {
  const creds = extractClientCredentials(channel);
  if (!creds) throw new BookingAuthError("Faltan client_id / client_secret de Booking.com en las credenciales del canal.");
  if (exchangesInLastHour(channel.id, now) >= BOOKING_MAX_EXCHANGES_PER_HOUR) {
    throw new BookingAuthError(`Límite de ${BOOKING_MAX_EXCHANGES_PER_HOUR} intercambios de token por hora alcanzado para este canal.`, 429);
  }
  recordExchange(channel.id, now);
  const res = await httpRequest({
    url: readBookingAuthUrl(),
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ client_id: creds.clientId, client_secret: creds.clientSecret }),
    timeoutMs: deps.timeoutMs ?? 15_000,
    fetchImpl: deps.fetchImpl,
    now: deps.now
  });
  if (!res.ok) {
    throw new BookingAuthError(
      res.errorMessage ? `Token exchange: ${res.errorMessage}` : `Token exchange respondió ${res.status}: ${res.body.slice(0, 200)}`,
      res.status
    );
  }
  let json: unknown;
  try {
    json = JSON.parse(res.body);
  } catch {
    throw new BookingAuthError("Token exchange: la respuesta no es JSON.");
  }
  const jwt = json && typeof json === "object" ? (json as Record<string, unknown>).jwt ?? (json as Record<string, unknown>).access_token : undefined;
  if (typeof jwt !== "string" || jwt.length === 0) throw new BookingAuthError("Token exchange: la respuesta no trae `jwt`.");
  tokenCache.set(channel.id, { jwt, expiresAt: now + BOOKING_JWT_TTL_MS });
  return jwt;
}

export function clearBookingTokenCache(channelId?: string): void {
  if (channelId === undefined) {
    tokenCache.clear();
    inflight.clear();
    exchangeLog.clear();
  } else {
    tokenCache.delete(channelId);
    inflight.delete(channelId);
    exchangeLog.delete(channelId);
  }
}

/** Test-only inspector. */
export function __peekBookingToken(channelId: string): CachedToken | undefined {
  return tokenCache.get(channelId);
}
