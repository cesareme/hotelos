// OAuth2 client-credentials helper for the Expedia EQC / Rapid "Quick Connect"
// API.
//
// Expedia issues short-lived bearer tokens via:
//   POST https://api.expediapartnercentral.com/authentication/v1/token
//   Content-Type: application/x-www-form-urlencoded
//   body: grant_type=client_credentials&client_id=...&client_secret=...
//   Docs: https://developers.expediagroup.com/eqc/products/authentication
//
// Response shape (subset):
//   { "access_token": "...", "token_type": "Bearer", "expires_in": 1800 }
//
// We cache tokens in-memory keyed by channelId. The cached entry expires
// (expires_in - 60s) before the server-side expiry so we never use a token in
// the final minute of its life. Production should add a per-channel single-
// flight mutex to avoid a refresh stampede after expiry.
//
// SECURITY: client_secret never leaves this module. credentialsJson is read on
// every refresh so a rotated secret takes effect on the next refresh window.

import type { ChannelContext } from "../../adapter.types.js";

type CachedToken = {
  accessToken: string;
  expiresAt: number; // epoch ms
};

const tokenCache = new Map<string, CachedToken>();

const DEFAULT_OAUTH_URL = "https://api.expediapartnercentral.com/authentication/v1/token";
const REFRESH_SKEW_MS = 60_000; // refresh 60s before the server expiry

function readOauthUrl(): string {
  return process.env.EXPEDIA_OAUTH_URL || DEFAULT_OAUTH_URL;
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

export class ExpediaOAuthError extends Error {
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "ExpediaOAuthError";
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
    throw new ExpediaOAuthError("Expedia EQC credentials missing client_id or client_secret");
  }

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: creds.clientId,
    client_secret: creds.clientSecret
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
    throw new ExpediaOAuthError(
      `OAuth network error: ${err instanceof Error ? err.message : String(err)}`
    );
  } finally {
    clearTimeout(timeout);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new ExpediaOAuthError(`OAuth token endpoint returned ${res.status}: ${text.slice(0, 200)}`, res.status);
  }

  let json: unknown;
  try {
    json = await res.json();
  } catch (err) {
    throw new ExpediaOAuthError(`OAuth response not JSON: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!json || typeof json !== "object") {
    throw new ExpediaOAuthError("OAuth response was not an object");
  }
  const payload = json as Record<string, unknown>;
  const accessToken = payload.access_token;
  const expiresIn = payload.expires_in;
  if (typeof accessToken !== "string" || accessToken.length === 0) {
    throw new ExpediaOAuthError("OAuth response missing access_token");
  }
  const ttlSeconds = typeof expiresIn === "number" && expiresIn > 0 ? expiresIn : 1800;
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
