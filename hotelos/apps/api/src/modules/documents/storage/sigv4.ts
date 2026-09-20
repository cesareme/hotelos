// Documents · AWS Signature Version 4 by hand (Tanda T9 · lote T9-03).
//
// The repo rule forbids new dependencies, so there is no aws-sdk: this is the
// SigV4 algorithm (HMAC-SHA256) as documented by AWS for S3 ("Authenticating
// Requests: Using the Authorization Header"), sufficient for path-style PUT /
// GET / DELETE / HEAD against any S3-compatible endpoint. Pure: no I/O, the
// caller injects the date so the tests can pin the official AWS test vectors.
//
// Headers always signed: host, x-amz-content-sha256, x-amz-date (+ any header
// the caller passes, e.g. content-type, x-amz-server-side-encryption).

import { createHash, createHmac } from "node:crypto";

export type SigV4Credentials = { accessKeyId: string; secretAccessKey: string; sessionToken?: string };

export type SignRequestInput = {
  method: string;
  url: URL;
  /** Extra headers to send and sign (names case-insensitive). */
  headers?: Record<string, string>;
  /** Hex SHA-256 of the body ("UNSIGNED-PAYLOAD" is accepted but not used by our adapter). */
  payloadSha256: string;
  credentials: SigV4Credentials;
  region: string;
  service?: string;
  /** Signing time (defaults to now); pinned by the tests. */
  date?: Date;
};

export type SignedRequest = {
  /** All headers to send, including Authorization, host, x-amz-date and x-amz-content-sha256. */
  headers: Record<string, string>;
  canonicalRequest: string;
  stringToSign: string;
  signature: string;
  credentialScope: string;
  signedHeaders: string;
};

export const EMPTY_PAYLOAD_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

export function sha256Hex(data: Uint8Array | string): string {
  return createHash("sha256").update(data).digest("hex");
}

function hmac(key: Uint8Array | string, data: string): Buffer {
  return createHmac("sha256", key).update(data, "utf8").digest();
}

/** AWS "UriEncode": unreserved chars untouched, everything else %XX upper-case; `/` kept unless encodeSlash. */
export function uriEncode(value: string, encodeSlash: boolean): string {
  let out = "";
  for (const ch of value) {
    if (/[A-Za-z0-9\-_.~]/.test(ch) || (ch === "/" && !encodeSlash)) {
      out += ch;
      continue;
    }
    for (const byte of Buffer.from(ch, "utf8")) out += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return out;
}

/** yyyyMMdd'T'HHmmss'Z' and yyyyMMdd of a Date (UTC). */
export function amzDate(date: Date): { amzDate: string; dateStamp: string } {
  const iso = date.toISOString(); // 2013-05-24T00:00:00.000Z
  const dateStamp = iso.slice(0, 10).replace(/-/g, "");
  const time = iso.slice(11, 19).replace(/:/g, "");
  return { amzDate: `${dateStamp}T${time}Z`, dateStamp };
}

function canonicalQuery(url: URL): string {
  const pairs: Array<[string, string]> = [];
  for (const [name, value] of url.searchParams) pairs.push([uriEncode(name, true), uriEncode(value, true)]);
  pairs.sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0) : a[0] < b[0] ? -1 : 1));
  return pairs.map(([n, v]) => `${n}=${v}`).join("&");
}

function canonicalPath(url: URL): string {
  // URL.pathname is already percent-encoded by WHATWG rules; decode once and
  // re-encode with the AWS rules so `$`, `(`, `!`… get %XX exactly once.
  const decoded = decodeURIComponent(url.pathname || "/");
  return uriEncode(decoded === "" ? "/" : decoded, false);
}

function hostHeader(url: URL): string {
  return url.host; // includes the port when non-default, as AWS expects
}

/** Signing key: kSecret → kDate → kRegion → kService → kSigning. */
export function signingKey(secretAccessKey: string, dateStamp: string, region: string, service: string): Buffer {
  const kDate = hmac(`AWS4${secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  return hmac(kService, "aws4_request");
}

export function signRequest(input: SignRequestInput): SignedRequest {
  const service = input.service ?? "s3";
  const { amzDate: amz, dateStamp } = amzDate(input.date ?? new Date());
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(input.headers ?? {})) headers[name.toLowerCase()] = value;
  headers.host = hostHeader(input.url);
  headers["x-amz-date"] = amz;
  headers["x-amz-content-sha256"] = input.payloadSha256;
  if (input.credentials.sessionToken) headers["x-amz-security-token"] = input.credentials.sessionToken;

  const names = Object.keys(headers).sort();
  const canonicalHeaders = names.map((name) => `${name}:${headers[name]!.trim().replace(/\s+/g, " ")}\n`).join("");
  const signedHeaders = names.join(";");
  const canonicalRequest = [input.method.toUpperCase(), canonicalPath(input.url), canonicalQuery(input.url), canonicalHeaders, signedHeaders, input.payloadSha256].join("\n");
  const credentialScope = `${dateStamp}/${input.region}/${service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amz, credentialScope, sha256Hex(canonicalRequest)].join("\n");
  const signature = createHmac("sha256", signingKey(input.credentials.secretAccessKey, dateStamp, input.region, service)).update(stringToSign, "utf8").digest("hex");
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${input.credentials.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return { headers, canonicalRequest, stringToSign, signature, credentialScope, signedHeaders };
}
