// OAuth2 client-credentials helper for the Booking.com Connectivity API.
//
// Booking issues short-lived bearer tokens via:
//   POST https://oauth.booking.com/oauth2/token
//   Content-Type: application/x-www-form-urlencoded
//   body: grant_type=client_credentials&client_id=...&client_secret=...&scope=...
//
// Response shape (subset):
//   { "access_token": "...", "token_type": "Bearer", "expires_in": 3600, "scope": "..." }
//
// We cache tokens in-memory keyed by channelId. The cached entry expires
// (expires_in - 60s) before the server-side expiry so we never use a token in
// the final minute of its life. A per-channelId single-flight mutex coalesces
// concurrent refreshes: when N parallel pushes race the first call after expiry,
// only ONE underlying token fetch is issued and the others await its promise.
//
// SECURITY: client_secret never leaves this module. credentialsJson is read on
// every refresh so a rotated secret takes effect on the next refresh window —
// callers do not need to invalidate the cache manually unless they want to
// force-rotate, in which case use clearTokenCache(channelId).

import type { ChannelContext } from "../../adapter.types.js";

type CachedToken = {
  accessToken: string;
  expiresAt: number; // epoch ms
};

const tokenCache = new Map<string, CachedToken>();

// Single-flight: per-channelId in-flight refresh promises. When a refresh is
// already running for a channelId, concurrent callers await the existing promise
// instead of issuing their own fetch. Entries are removed in a `finally` once
// the refresh settles (success or failure) so the next expiry can refresh again.
const inflight = new Map<string, Promise<string>>();

const DEFAULT_OAUTH_URL = "https://oauth.booking.com/oauth2/token";
const DEFAULT_SCOPE = "supply-distribution-api";
const REFRESH_SKEW_MS = 60_000; // refresh 60s before the server expiry

function readOauthUrl(): string {
  return process.env.BOOKING_OAUTH_URL || DEFAULT_OAUTH_URL;
}

function readScope(credentials: Record<string, unknown> | null): string {
  if (credentials && typeof credentials.scope === "string" && credentials.scope.length > 0) {
    return credentials.scope;
  }
  return process.env.BOOKING_OAUTH_SCOPE || DEFAULT_SCOPE;
}

function extractClientCreds(channel: ChannelContext): { clientId: string; clientSecret: string } | null {
  const creds = channel.credentialsJson;
  if (!creds) return null;
  const clientId = creds.client_id ?? creds.clientId;
  const clientSecret = creds.client_secret ?? creds.clientSecret;
  if (typeof clientId !== "string" || clientId.length === 0) return null;
  if (typeof clientSecret !== "string" || clientSecret.length === 0) return null;
  return { clientId, clientSecret };
}

export class BookingOAuthError extends Error {
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "BookingOAuthError";
    this.status = status;
  }
}

export async function getAccessToken(channel: ChannelContext): Promise<string> {
  const cached = tokenCache.get(channel.id);
  const now = Date.now();
  if (cached && cached.expiresAt > now) {
    return cached.accessToken;
  }

  // Single-flight: if a refresh for this channelId is already running, await it
  // rather than starting a second concurrent fetch.
  const pending = inflight.get(channel.id);
  if (pending) {
    return pending;
  }

  const refresh = refreshToken(channel, now).finally(() => {
    inflight.delete(channel.id);
  });
  inflight.set(channel.id, refresh);
  return refresh;
}

async function refreshToken(channel: ChannelContext, now: number): Promise<string> {
  const creds = extractClientCreds(channel);
  if (!creds) {
    throw new BookingOAuthError("Booking.com credentials missing client_id or client_secret");
  }

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: creds.clientId,
    client_secret: creds.clientSecret,
    scope: readScope(channel.credentialsJson)
  });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);

  let res: Response;
  try {
    res = await fetch(readOauthUrl(), {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json"
      },
      body: body.toString(),
      signal: controller.signal
    });
  } catch (err) {
    throw new BookingOAuthError(
      `OAuth network error: ${err instanceof Error ? err.message : String(err)}`
    );
  } finally {
    clearTimeout(timeout);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new BookingOAuthError(`OAuth token endpoint returned ${res.status}: ${text.slice(0, 200)}`, res.status);
  }

  let json: unknown;
  try {
    json = await res.json();
  } catch (err) {
    throw new BookingOAuthError(`OAuth response not JSON: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!json || typeof json !== "object") {
    throw new BookingOAuthError("OAuth response was not an object");
  }
  const payload = json as Record<string, unknown>;
  const accessToken = payload.access_token;
  const expiresIn = payload.expires_in;
  if (typeof accessToken !== "string" || accessToken.length === 0) {
    throw new BookingOAuthError("OAuth response missing access_token");
  }
  const ttlSeconds = typeof expiresIn === "number" && expiresIn > 0 ? expiresIn : 3600;
  const expiresAt = now + ttlSeconds * 1000 - REFRESH_SKEW_MS;

  tokenCache.set(channel.id, { accessToken, expiresAt });
  return accessToken;
}

export function clearTokenCache(channelId?: string): void {
  if (channelId === undefined) {
    tokenCache.clear();
    inflight.clear();
  } else {
    tokenCache.delete(channelId);
    inflight.delete(channelId);
  }
}

// Test-only inspector. Not exported from index — call via the file path.
export function __peekToken(channelId: string): CachedToken | undefined {
  return tokenCache.get(channelId);
}
