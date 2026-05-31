import { createHash, randomBytes } from "node:crypto";

// RFC 3161 Time-Stamp Protocol (TSP) client.
//
// This module produces RFC 3161 TimeStampReq DER blobs, POSTs them to a TSA,
// and returns the encapsulated TimeStampToken bytes that XAdES-T embeds inside
// <xades:EncapsulatedTimeStamp>.
//
// The "stub" mode is dependency-free and synthesizes a deterministic, byte-
// shaped blob suitable for unit-testing pipeline plumbing. It is NOT a valid
// RFC 3161 TimeStampToken and MUST NEVER be used to produce signatures
// submitted to AEAT, BizkaiBus, ATC, or any other regulator. Production
// deployments must point at a qualified TSA (eFirma, FNMT, IZENPE, Sectigo,
// DigiCert, etc.) and use mode: "real".

export type TsaMode = "stub" | "real";

export type TsaClientOptions = {
  mode: TsaMode;
  tsaUrl?: string;
  /** Hash algorithm used in TimeStampReq. RFC 3161 supports SHA-256 widely. */
  hashAlgorithm?: "sha256";
  /** Optional override for network fetch (testing). */
  fetchImpl?: typeof fetch;
  /** Request timeout in milliseconds for the real-mode HTTP POST. */
  timeoutMs?: number;
};

export type TimestampResult = {
  /** DER-encoded RFC 3161 TimeStampToken (the embedded ContentInfo). */
  token: Buffer;
  /** Base64 string ready to drop into <xades:EncapsulatedTimeStamp>. */
  tokenBase64: string;
  /** Time at which the request was issued (client clock; informational only). */
  requestedAt: string;
  /** Which TSA URL produced the token, or "stub" for synthetic. */
  source: string;
  mode: TsaMode;
};

export const DEFAULT_TSA_URL = "http://timestamp.digicert.com";

// ---------------------------------------------------------------------------
// Minimal ASN.1 DER helpers
// ---------------------------------------------------------------------------

function derLength(len: number): Buffer {
  if (len < 0x80) return Buffer.from([len]);
  const bytes: number[] = [];
  let n = len;
  while (n > 0) {
    bytes.unshift(n & 0xff);
    n >>>= 8;
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function derTLV(tag: number, value: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), derLength(value.length), value]);
}

function derSequence(...children: Buffer[]): Buffer {
  return derTLV(0x30, Buffer.concat(children));
}

function derInteger(n: number): Buffer {
  // Supports small positive integers (TSP version, nonce-as-bigint encoded
  // separately).
  const bytes: number[] = [];
  let x = n;
  if (x === 0) return derTLV(0x02, Buffer.from([0]));
  while (x > 0) {
    bytes.unshift(x & 0xff);
    x >>>= 8;
  }
  // Prepend 0x00 if top bit set (positive integer).
  if (bytes[0] & 0x80) bytes.unshift(0);
  return derTLV(0x02, Buffer.from(bytes));
}

function derIntegerFromBytes(bytes: Buffer): Buffer {
  // Strip leading zeros but preserve at least one byte; prepend 0x00 if MSB set.
  let start = 0;
  while (start < bytes.length - 1 && bytes[start] === 0) start += 1;
  let value = bytes.subarray(start);
  if (value[0] & 0x80) value = Buffer.concat([Buffer.from([0]), value]);
  return derTLV(0x02, value);
}

function derOctetString(b: Buffer): Buffer {
  return derTLV(0x04, b);
}

function derBoolean(v: boolean): Buffer {
  return derTLV(0x01, Buffer.from([v ? 0xff : 0x00]));
}

// OID encoding (BER subidentifier rules).
function derObjectIdentifier(oid: string): Buffer {
  const parts = oid.split(".").map((p) => Number.parseInt(p, 10));
  if (parts.length < 2) throw new Error(`Invalid OID: ${oid}`);
  const first = parts[0]! * 40 + parts[1]!;
  const out: number[] = [first];
  for (let i = 2; i < parts.length; i += 1) {
    let v = parts[i]!;
    const sub: number[] = [v & 0x7f];
    v >>>= 7;
    while (v > 0) {
      sub.unshift((v & 0x7f) | 0x80);
      v >>>= 7;
    }
    out.push(...sub);
  }
  return derTLV(0x06, Buffer.from(out));
}

// OIDs used in TSP.
const OID_SHA256 = "2.16.840.1.101.3.4.2.1";

// AlgorithmIdentifier ::= SEQUENCE { algorithm OID, parameters ANY DEFINED BY algorithm OPTIONAL }
function algorithmIdentifierSha256(): Buffer {
  return derSequence(derObjectIdentifier(OID_SHA256), derTLV(0x05, Buffer.alloc(0)));
}

// ---------------------------------------------------------------------------
// TimeStampReq builder
// ---------------------------------------------------------------------------

/**
 * Build an RFC 3161 TimeStampReq:
 *
 *   TimeStampReq ::= SEQUENCE {
 *     version            INTEGER  { v1(1) },
 *     messageImprint     MessageImprint,
 *     reqPolicy          TSAPolicyId OPTIONAL,
 *     nonce              INTEGER OPTIONAL,
 *     certReq            BOOLEAN DEFAULT FALSE,
 *     extensions         [0] IMPLICIT Extensions OPTIONAL
 *   }
 *
 *   MessageImprint ::= SEQUENCE {
 *     hashAlgorithm  AlgorithmIdentifier,
 *     hashedMessage  OCTET STRING
 *   }
 */
export function buildTimeStampReq(messageDigest: Buffer, nonce?: Buffer): Buffer {
  const messageImprint = derSequence(algorithmIdentifierSha256(), derOctetString(messageDigest));
  const children: Buffer[] = [derInteger(1), messageImprint];
  if (nonce && nonce.length > 0) children.push(derIntegerFromBytes(nonce));
  // certReq = TRUE (request TSA certificate be returned so signers can verify).
  children.push(derBoolean(true));
  return derSequence(...children);
}

// ---------------------------------------------------------------------------
// TimeStampResp parser (extracts the TimeStampToken ContentInfo)
// ---------------------------------------------------------------------------

type TLV = { tag: number; len: number; header: number; value: Buffer; raw: Buffer };

function readTLV(buf: Buffer, offset: number): TLV {
  if (offset >= buf.length) throw new Error("TSP response truncated");
  const tag = buf[offset]!;
  let lenByte = buf[offset + 1]!;
  let headerLen = 2;
  let len = 0;
  if (lenByte < 0x80) {
    len = lenByte;
  } else {
    const lenBytes = lenByte & 0x7f;
    if (lenBytes === 0 || lenBytes > 4) throw new Error("Unsupported DER length");
    headerLen = 2 + lenBytes;
    for (let i = 0; i < lenBytes; i += 1) len = (len << 8) | buf[offset + 2 + i]!;
  }
  const value = buf.subarray(offset + headerLen, offset + headerLen + len);
  const raw = buf.subarray(offset, offset + headerLen + len);
  return { tag, len, header: headerLen, value, raw };
}

/**
 * Extract the TimeStampToken (ContentInfo) bytes from a TimeStampResp.
 *
 *   TimeStampResp ::= SEQUENCE {
 *     status          PKIStatusInfo,
 *     timeStampToken  TimeStampToken OPTIONAL
 *   }
 *
 *   PKIStatusInfo ::= SEQUENCE { status PKIStatus, statusString ..., failInfo ... }
 *   TimeStampToken ::= ContentInfo  (a SEQUENCE starting with tag 0x30)
 *
 * Returns the DER bytes of the ContentInfo, which is what XAdES embeds.
 *
 * NOTE: this parser is intentionally partial — it pulls the token out and
 * surfaces an error PKIStatus, but does NOT cryptographically verify the
 * embedded CMS SignedData. Verification is left to a downstream library.
 */
export function extractTimeStampToken(resp: Buffer): Buffer {
  const outer = readTLV(resp, 0);
  if (outer.tag !== 0x30) throw new Error("TimeStampResp: expected outer SEQUENCE");
  // First child: PKIStatusInfo (SEQUENCE).
  const status = readTLV(outer.value, 0);
  if (status.tag !== 0x30) throw new Error("TimeStampResp: expected PKIStatusInfo SEQUENCE");
  const pkiStatus = readTLV(status.value, 0);
  if (pkiStatus.tag !== 0x02) throw new Error("TimeStampResp: expected PKIStatus INTEGER");
  // PKIStatus: 0 = granted, 1 = grantedWithMods. >=2 are rejections.
  const code = pkiStatus.value.length > 0 ? pkiStatus.value[pkiStatus.value.length - 1]! : 0;
  if (code > 1) {
    throw new Error(`TSA rejected request: PKIStatus=${code}`);
  }
  // Second child of outer (offset = status.raw.length): TimeStampToken (ContentInfo).
  if (outer.value.length <= status.raw.length) {
    throw new Error("TimeStampResp: missing TimeStampToken");
  }
  const token = readTLV(outer.value, status.raw.length);
  if (token.tag !== 0x30) throw new Error("TimeStampResp: expected ContentInfo SEQUENCE");
  return Buffer.from(token.raw);
}

// ---------------------------------------------------------------------------
// Client surface
// ---------------------------------------------------------------------------

/**
 * Hash the input bytes and obtain a TimeStampToken.
 *
 * In stub mode this produces a deterministic, well-formed-looking but
 * cryptographically meaningless blob so that XAdES-T plumbing can be tested
 * offline. In real mode it issues a TimeStampReq to `tsaUrl`.
 */
export async function fetchTimestamp(
  data: Buffer | string,
  options: TsaClientOptions
): Promise<TimestampResult> {
  const bytes = typeof data === "string" ? Buffer.from(data, "utf-8") : data;
  const digest = createHash("sha256").update(bytes).digest();
  const requestedAt = new Date().toISOString();

  if (options.mode === "stub") {
    return buildStubToken(digest, requestedAt);
  }

  const tsaUrl = options.tsaUrl ?? DEFAULT_TSA_URL;
  const nonce = randomBytes(16);
  const req = buildTimeStampReq(digest, nonce);

  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 15_000);
  let resp: Response;
  try {
    resp = await fetchImpl(tsaUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/timestamp-query",
        Accept: "application/timestamp-reply"
      },
      // Buffer is a Uint8Array at runtime; cast to BodyInit for the DOM fetch typings.
      body: new Uint8Array(req.buffer, req.byteOffset, req.byteLength) as unknown as BodyInit,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeout);
  }
  if (!resp.ok) {
    throw new Error(`TSA HTTP error: ${resp.status} ${resp.statusText}`);
  }
  const respBytes = Buffer.from(await resp.arrayBuffer());
  const token = extractTimeStampToken(respBytes);
  return {
    token,
    tokenBase64: token.toString("base64"),
    requestedAt,
    source: tsaUrl,
    mode: "real"
  };
}

/**
 * Deterministic synthetic TimeStampToken for unit tests and sandbox runs.
 *
 * The shape is a DER SEQUENCE so that downstream tooling that only checks
 * "is this a base64-encoded DER blob?" will tolerate it. It is NOT signed and
 * MUST NOT be relayed to AEAT.
 */
function buildStubToken(digest: Buffer, requestedAt: string): TimestampResult {
  const stamp = createHash("sha256").update(digest).update(requestedAt).digest();
  const marker = Buffer.from("HOTELOS-XADES-T-STUB", "utf-8");
  // SEQUENCE { OCTET STRING marker, OCTET STRING digest, OCTET STRING stamp,
  //            UTF8String requestedAt }
  const body = derSequence(
    derOctetString(marker),
    derOctetString(digest),
    derOctetString(stamp),
    derTLV(0x0c, Buffer.from(requestedAt, "utf-8"))
  );
  return {
    token: body,
    tokenBase64: body.toString("base64"),
    requestedAt,
    source: "stub",
    mode: "stub"
  };
}
