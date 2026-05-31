import { createHmac, timingSafeEqual } from "node:crypto";

const ALG = "HS256";
const HEADER_B64 = base64url(Buffer.from(JSON.stringify({ alg: ALG, typ: "JWT" })));

export type JwtClaims = {
  sub: string;
  sessionId: string;
  organizationId: string;
  propertyId: string;
  deviceId: string;
  iat?: number;
  exp?: number;
};

function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/=+$/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function base64urlDecode(input: string): Buffer {
  const padded = input.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((input.length + 3) % 4);
  return Buffer.from(padded, "base64");
}

function getSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret || secret === "change-me") {
    console.error(`[jwt] JWT_SECRET is ${JSON.stringify(secret)} (length ${secret?.length}). process.env keys with JWT prefix:`, Object.keys(process.env).filter((k) => k.startsWith("JWT")));
    throw new Error("JWT_SECRET environment variable must be set (not 'change-me').");
  }
  return secret;
}

function sign(payload: Buffer): string {
  return base64url(createHmac("sha256", getSecret()).update(payload).digest());
}

export function signJwt(claims: JwtClaims, ttlSeconds = 60 * 60 * 12): string {
  const now = Math.floor(Date.now() / 1000);
  const fullClaims: JwtClaims = { ...claims, iat: now, exp: now + ttlSeconds };
  const payloadB64 = base64url(Buffer.from(JSON.stringify(fullClaims)));
  const signingInput = `${HEADER_B64}.${payloadB64}`;
  const signature = sign(Buffer.from(signingInput));
  return `${signingInput}.${signature}`;
}

export type VerifyJwtResult = { ok: true; claims: JwtClaims } | { ok: false; reason: string };

export function verifyJwt(token: string): VerifyJwtResult {
  if (typeof token !== "string") return { ok: false, reason: "Token must be a string." };
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "Malformed token." };
  const [headerB64, payloadB64, signatureB64] = parts;

  let header: { alg?: string; typ?: string };
  try {
    header = JSON.parse(base64urlDecode(headerB64).toString("utf-8"));
  } catch {
    return { ok: false, reason: "Invalid header." };
  }
  if (header.alg !== ALG) return { ok: false, reason: `Unsupported alg: ${header.alg}.` };

  const expected = sign(Buffer.from(`${headerB64}.${payloadB64}`));
  const provided = signatureB64;
  if (expected.length !== provided.length) return { ok: false, reason: "Bad signature length." };
  if (!timingSafeEqual(Buffer.from(expected), Buffer.from(provided))) {
    return { ok: false, reason: "Signature mismatch." };
  }

  let claims: JwtClaims;
  try {
    claims = JSON.parse(base64urlDecode(payloadB64).toString("utf-8"));
  } catch {
    return { ok: false, reason: "Invalid payload." };
  }
  const now = Math.floor(Date.now() / 1000);
  if (typeof claims.exp !== "number" || claims.exp < now) {
    return { ok: false, reason: "Token expired." };
  }
  if (!claims.sub || !claims.sessionId || !claims.organizationId || !claims.propertyId || !claims.deviceId) {
    return { ok: false, reason: "Missing required claims." };
  }
  return { ok: true, claims };
}
