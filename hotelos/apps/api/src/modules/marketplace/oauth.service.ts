// OAuth2 server (Authorization Code + Client Credentials) para apps externas.
//
// Espejo del flujo Apaleo: la cadena instala una App del marketplace y la
// autoriza con scopes concretos (`reservations.read`, `folios.write`,
// `webhooks.subscribe`, etc.). La App recibe access + refresh tokens y
// consume la API REST con `Authorization: Bearer ...`.
//
// Compatible con PKCE (S256) — obligatorio para SPA / mobile apps que no
// pueden custodiar un client_secret.

import { prisma } from "@hotelos/database";
import { createHash, randomBytes } from "node:crypto";
import { BadRequestError, NotFoundError, UnauthorizedError } from "../../lib/http-error.js";

const AUTH_CODE_TTL_MS = 10 * 60 * 1000; // 10 min
const ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000; // 1h
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 días

export const OAUTH_SCOPES = [
  "reservations.read",
  "reservations.write",
  "guests.read",
  "folios.read",
  "folios.write",
  "invoices.read",
  "rooms.read",
  "properties.read",
  "webhooks.subscribe",
  "messaging.send"
] as const;

export type OAuthScope = (typeof OAUTH_SCOPES)[number];

function hashToken(raw: string): string {
  return createHash("sha256").update(raw, "utf8").digest("hex");
}

function generateToken(prefix: string): string {
  return `${prefix}_${randomBytes(32).toString("base64url")}`;
}

// ---------------------------------------------------------------------------
// Authorization Code flow
// ---------------------------------------------------------------------------

/**
 * Issue an authorization code after the user has consented in the /oauth/authorize
 * UI. Returns the raw code (must be redirected to redirect_uri). Code TTL = 10 min.
 */
export async function issueAuthorizationCode(input: {
  appId: string;
  organizationId: string;
  propertyId?: string;
  userId?: string;
  redirectUri: string;
  scopes: string[];
  codeChallenge?: string;
  codeChallengeMethod?: "S256" | "plain";
}): Promise<{ code: string; expiresAt: string }> {
  const code = generateToken("ac");
  const expiresAt = new Date(Date.now() + AUTH_CODE_TTL_MS);
  await prisma.oAuthAuthorizationCode.create({
    data: {
      appId: input.appId,
      organizationId: input.organizationId,
      propertyId: input.propertyId,
      userId: input.userId,
      codeHash: hashToken(code),
      codeChallenge: input.codeChallenge,
      codeChallengeMethod: input.codeChallengeMethod,
      redirectUri: input.redirectUri,
      scopes: input.scopes,
      expiresAt
    }
  });
  return { code, expiresAt: expiresAt.toISOString() };
}

/**
 * Exchange an authorization code for an access + refresh token pair.
 * Implements PKCE verification when codeChallenge was set.
 */
export async function exchangeCodeForToken(input: {
  code: string;
  clientId: string;
  clientSecret?: string;
  redirectUri: string;
  codeVerifier?: string;
}): Promise<{ accessToken: string; refreshToken: string; expiresIn: number; scope: string }> {
  const codeHash = hashToken(input.code);
  const auth = await prisma.oAuthAuthorizationCode.findUnique({ where: { codeHash } });
  if (!auth || auth.consumedAt) throw new UnauthorizedError("Invalid or already-used code.");
  if (auth.expiresAt < new Date()) throw new UnauthorizedError("Code expired.");
  if (auth.redirectUri !== input.redirectUri) throw new UnauthorizedError("redirect_uri mismatch.");

  const app = await prisma.developerApp.findUnique({ where: { id: auth.appId } });
  if (!app) throw new NotFoundError("App not found.");
  if (app.clientId !== input.clientId) throw new UnauthorizedError("client_id mismatch.");

  // PKCE verification (S256). If codeChallenge was set, verifier MUST match.
  if (auth.codeChallenge) {
    if (!input.codeVerifier) throw new UnauthorizedError("code_verifier required.");
    if (auth.codeChallengeMethod === "S256") {
      const expected = createHash("sha256").update(input.codeVerifier).digest("base64url");
      if (expected !== auth.codeChallenge) throw new UnauthorizedError("PKCE verification failed.");
    } else if (auth.codeChallengeMethod === "plain") {
      if (input.codeVerifier !== auth.codeChallenge) throw new UnauthorizedError("PKCE verification failed.");
    }
  } else {
    // No PKCE → require client_secret.
    if (!app.clientSecretHash || !input.clientSecret) {
      throw new UnauthorizedError("client_secret required when PKCE not used.");
    }
    if (hashToken(input.clientSecret) !== app.clientSecretHash) {
      throw new UnauthorizedError("Invalid client_secret.");
    }
  }

  // Mark code as consumed (single-use).
  await prisma.oAuthAuthorizationCode.update({
    where: { id: auth.id },
    data: { consumedAt: new Date() }
  });

  // Issue tokens.
  const accessToken = generateToken("at");
  const refreshToken = generateToken("rt");
  const accessExpiresAt = new Date(Date.now() + ACCESS_TOKEN_TTL_MS);
  const refreshExpiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_MS);
  await prisma.oAuthToken.createMany({
    data: [
      {
        appId: app.id,
        organizationId: auth.organizationId,
        propertyId: auth.propertyId,
        userId: auth.userId,
        kind: "access",
        tokenHash: hashToken(accessToken),
        scopes: auth.scopes,
        expiresAt: accessExpiresAt
      },
      {
        appId: app.id,
        organizationId: auth.organizationId,
        propertyId: auth.propertyId,
        userId: auth.userId,
        kind: "refresh",
        tokenHash: hashToken(refreshToken),
        scopes: auth.scopes,
        expiresAt: refreshExpiresAt
      }
    ]
  });

  return {
    accessToken,
    refreshToken,
    expiresIn: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
    scope: auth.scopes.join(" ")
  };
}

/**
 * Client credentials flow — server-to-server, no user consent.
 * Used by partners with always-on integrations (channel managers, accounting
 * sync, etc.).
 */
export async function clientCredentialsToken(input: {
  clientId: string;
  clientSecret: string;
  scopes?: string[];
}): Promise<{ accessToken: string; expiresIn: number; scope: string }> {
  const app = await prisma.developerApp.findUnique({ where: { clientId: input.clientId } });
  if (!app || !app.clientSecretHash) throw new UnauthorizedError("Unknown app.");
  if (hashToken(input.clientSecret) !== app.clientSecretHash) {
    throw new UnauthorizedError("Invalid client_secret.");
  }
  if (app.status !== "active") throw new UnauthorizedError(`App is ${app.status}.`);

  // Validate requested scopes are a subset of the app's allowed scopes.
  const requested = input.scopes ?? app.scopes;
  const invalid = requested.filter((s) => !app.scopes.includes(s));
  if (invalid.length > 0) throw new BadRequestError(`Unsupported scopes: ${invalid.join(", ")}`);

  const accessToken = generateToken("at");
  const expiresAt = new Date(Date.now() + ACCESS_TOKEN_TTL_MS);
  await prisma.oAuthToken.create({
    data: {
      appId: app.id,
      organizationId: app.organizationId,
      kind: "access",
      tokenHash: hashToken(accessToken),
      scopes: requested,
      expiresAt
    }
  });
  return { accessToken, expiresIn: Math.floor(ACCESS_TOKEN_TTL_MS / 1000), scope: requested.join(" ") };
}

/** Validate an access token presented by an inbound request. */
export async function validateAccessToken(rawToken: string): Promise<{
  appId: string;
  organizationId: string;
  propertyId: string | null;
  scopes: string[];
} | null> {
  const tokenHash = hashToken(rawToken);
  const row = await prisma.oAuthToken.findUnique({ where: { tokenHash } });
  if (!row || row.kind !== "access") return null;
  if (row.revokedAt || row.expiresAt < new Date()) return null;
  // Update last used (fire and forget).
  prisma.oAuthToken
    .update({ where: { id: row.id }, data: { lastUsedAt: new Date() } })
    .catch(() => {});
  return {
    appId: row.appId,
    organizationId: row.organizationId,
    propertyId: row.propertyId,
    scopes: row.scopes
  };
}

/** Rotate a refresh token into a new access + refresh pair. */
export async function refreshAccessToken(input: {
  refreshToken: string;
  clientId: string;
}): Promise<{ accessToken: string; refreshToken: string; expiresIn: number; scope: string }> {
  const tokenHash = hashToken(input.refreshToken);
  const row = await prisma.oAuthToken.findUnique({ where: { tokenHash } });
  if (!row || row.kind !== "refresh") throw new UnauthorizedError("Invalid refresh token.");
  if (row.revokedAt || row.expiresAt < new Date()) throw new UnauthorizedError("Refresh token expired.");
  const app = await prisma.developerApp.findUnique({ where: { id: row.appId } });
  if (!app || app.clientId !== input.clientId) throw new UnauthorizedError("client_id mismatch.");

  // Issue new tokens (rotation).
  const accessToken = generateToken("at");
  const newRefreshToken = generateToken("rt");
  const accessExpiresAt = new Date(Date.now() + ACCESS_TOKEN_TTL_MS);
  const refreshExpiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_MS);
  await prisma.$transaction([
    prisma.oAuthToken.update({ where: { id: row.id }, data: { revokedAt: new Date() } }),
    prisma.oAuthToken.create({
      data: {
        appId: app.id,
        organizationId: row.organizationId,
        propertyId: row.propertyId,
        userId: row.userId,
        kind: "access",
        tokenHash: hashToken(accessToken),
        scopes: row.scopes,
        expiresAt: accessExpiresAt
      }
    }),
    prisma.oAuthToken.create({
      data: {
        appId: app.id,
        organizationId: row.organizationId,
        propertyId: row.propertyId,
        userId: row.userId,
        kind: "refresh",
        tokenHash: hashToken(newRefreshToken),
        scopes: row.scopes,
        expiresAt: refreshExpiresAt,
        rotatedFromId: row.id
      }
    })
  ]);
  return {
    accessToken,
    refreshToken: newRefreshToken,
    expiresIn: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
    scope: row.scopes.join(" ")
  };
}
