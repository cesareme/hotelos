// OAuth2 client-credentials helper for Vrbo.
//
// Vrbo distribution rides on the Expedia Group platform and reuses the EQC
// OAuth2 client-credentials flow, but with SEPARATE credentials and a separate
// listing/property namespace. We keep a distinct token cache + env vars so a
// property can be connected to Expedia and Vrbo independently without the two
// integrations sharing (and accidentally invalidating) one bearer token.
//
//   POST https://api.expediapartnercentral.com/authentication/v1/token
//   Content-Type: application/x-www-form-urlencoded
//   body: grant_type=client_credentials&client_id=...&client_secret=...
//   Docs: https://developers.expediagroup.com/eqc/products/authentication
//
// SHARP EDGE: Expedia and Vrbo share the SAME OAuth host but expect DIFFERENT
// client_id/client_secret pairs (one per partner agreement). Mixing them yields
// a 401 that looks like an expiry. Each adapter therefore has its own cache and
// reads its own credentialsJson — never share a token across the two providers.

import type { ChannelContext } from "../../adapter.types.js";

type CachedToken = {
  accessToken: string;
  expiresAt: number; // epoch ms
};

const tokenCache = new Map<string, CachedToken>();

const DEFAULT_OAUTH_URL = "https://api.expediapartnercentral.com/authentication/v1/token";
const REFRESH_SKEW_MS = 60_000; // refresh 60s before the server expiry

function readOauthUrl(): string {
  return process.env.VRBO_OAUTH_URL || DEFAULT_OAUTH_URL;
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

export class VrboOAuthError extends Error {
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "VrboOAuthError";
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
    throw new VrboOAuthError("Vrbo credentials missing client_id or client_secret");
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
    throw new VrboOAuthError(
      `OAuth network error: ${err instanceof Error ? err.message : String(err)}`
    );
  } finally {
    clearTimeout(timeout);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new VrboOAuthError(`OAuth token endpoint returned ${res.status}: ${text.slice(0, 200)}`, res.status);
  }

  let json: unknown;
  try {
    json = await res.json();
  } catch (err) {
    throw new VrboOAuthError(`OAuth response not JSON: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!json || typeof json !== "object") {
    throw new VrboOAuthError("OAuth response was not an object");
  }
  const payload = json as Record<string, unknown>;
  const accessToken = payload.access_token;
  const expiresIn = payload.expires_in;
  if (typeof accessToken !== "string" || accessToken.length === 0) {
    throw new VrboOAuthError("OAuth response missing access_token");
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
