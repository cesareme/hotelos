// OAuth2 helper for the Airbnb Software Partner API.
//
// Airbnb exchanges partner credentials for a bearer token via:
//   POST https://api.airbnb.com/v2/oauth2/authorizations
//   Headers: X-Airbnb-API-Key: <client id>
//   Content-Type: application/json
//   body: { "grant_type": "client_credentials", "client_id": ..., "client_secret": ... }
//   Docs: https://developer.airbnb.com/docs/authentication (partner login required)
//
// Response shape (subset):
//   { "access_token": "...", "token_type": "Bearer", "expires_in": 86400 }
//
// Unlike the form-encoded flows used by Booking/Expedia, Airbnb's authorization
// endpoint takes a JSON body AND requires the API key in a header on EVERY
// request (token alone is not enough). We expose getApiKey() so the adapter can
// attach X-Airbnb-API-Key on subsequent listing/calendar/pricing calls.
//
// We cache tokens in-memory keyed by channelId, expiring 60s early.

import type { ChannelContext } from "../../adapter.types.js";

type CachedToken = {
  accessToken: string;
  expiresAt: number; // epoch ms
};

const tokenCache = new Map<string, CachedToken>();

const DEFAULT_OAUTH_URL = "https://api.airbnb.com/v2/oauth2/authorizations";
const REFRESH_SKEW_MS = 60_000; // refresh 60s before the server expiry

function readOauthUrl(): string {
  return process.env.AIRBNB_OAUTH_URL || DEFAULT_OAUTH_URL;
}

function extractClientCreds(
  channel: ChannelContext
): { clientId: string; clientSecret: string } | null {
  const creds = channel.credentialsJson;
  if (!creds) return null;
  const clientId = creds.client_id ?? creds.clientId ?? creds.apiKey;
  const clientSecret = creds.client_secret ?? creds.clientSecret;
  if (typeof clientId !== "string" || clientId.length === 0) return null;
  if (typeof clientSecret !== "string" || clientSecret.length === 0) return null;
  return { clientId, clientSecret };
}

// The X-Airbnb-API-Key header value (the public client id) is required on every
// API call, including the ones that carry a bearer token.
export function getApiKey(channel: ChannelContext): string | null {
  const creds = extractClientCreds(channel);
  return creds ? creds.clientId : null;
}

export class AirbnbOAuthError extends Error {
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "AirbnbOAuthError";
    this.status = status;
  }
}

export async function getAccessToken(channel: ChannelContext): Promise<string> {
  const cached = tokenCache.get(channel.id);
  const now = Date.now();
  if (cached && cached.expiresAt > now) {
    return cached.accessToken;
  }

  const creds = extractClientCreds(channel);
  if (!creds) {
    throw new AirbnbOAuthError("Airbnb credentials missing client_id or client_secret");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);

  let res: Response;
  try {
    res = await fetch(readOauthUrl(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "X-Airbnb-API-Key": creds.clientId
      },
      body: JSON.stringify({
        grant_type: "client_credentials",
        client_id: creds.clientId,
        client_secret: creds.clientSecret
      }),
      signal: controller.signal
    });
  } catch (err) {
    throw new AirbnbOAuthError(
      `OAuth network error: ${err instanceof Error ? err.message : String(err)}`
    );
  } finally {
    clearTimeout(timeout);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new AirbnbOAuthError(`OAuth endpoint returned ${res.status}: ${text.slice(0, 200)}`, res.status);
  }

  let json: unknown;
  try {
    json = await res.json();
  } catch (err) {
    throw new AirbnbOAuthError(`OAuth response not JSON: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!json || typeof json !== "object") {
    throw new AirbnbOAuthError("OAuth response was not an object");
  }
  const payload = json as Record<string, unknown>;
  const accessToken = payload.access_token;
  const expiresIn = payload.expires_in;
  if (typeof accessToken !== "string" || accessToken.length === 0) {
    throw new AirbnbOAuthError("OAuth response missing access_token");
  }
  const ttlSeconds = typeof expiresIn === "number" && expiresIn > 0 ? expiresIn : 86400;
  const expiresAt = now + ttlSeconds * 1000 - REFRESH_SKEW_MS;

  tokenCache.set(channel.id, { accessToken, expiresAt });
  return accessToken;
}

export function clearTokenCache(channelId?: string): void {
  if (channelId === undefined) {
    tokenCache.clear();
  } else {
    tokenCache.delete(channelId);
  }
}
