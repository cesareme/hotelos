// Documents · object storage contract (Tanda T9 · lote T9-03, design §4.2).
//
// One interface, three adapters (inline-storage.ts, disk-storage.ts,
// s3-storage.ts) selected by DocumentsStorageConfig.kind. Nothing in this
// directory reads the environment: server.ts (lote T9-05b) builds the config
// object from the contract in ../env.partial.ts and calls createDocumentStorage
// (index.ts). Keys are ALWAYS built server-side with buildStorageKey and
// re-validated with isValidStorageKey before touching any backend: a key is
// never accepted from a client body.

import { HttpError } from "../../../lib/http-error.js";

export type DocumentStorageKind = "inline" | "disk" | "s3";

/** File extensions the store admits (derived from the MIME whitelist of ../magic-bytes.ts). */
export type StorageExtension = "pdf" | "jpg" | "png" | "tif" | "xml";

export const STORAGE_EXTENSIONS: readonly StorageExtension[] = Object.freeze(["pdf", "jpg", "png", "tif", "xml"]);

export const MIME_BY_EXTENSION: Readonly<Record<StorageExtension, string>> = Object.freeze({
  pdf: "application/pdf",
  jpg: "image/jpeg",
  png: "image/png",
  tif: "image/tiff",
  xml: "application/xml"
});

export type PutInput = { key: string; bytes: Uint8Array; mimeType: string };
export type PutResult = { key: string; sha256: string; sizeBytes: number };
export type GetResult = { bytes: Buffer; mimeType: string };
export type HeadResult = { sizeBytes: number };

export interface DocumentStorage {
  readonly kind: DocumentStorageKind;
  /** Stores `bytes` under `key` (validated) and returns the SHA-256 (hex) of the plaintext. */
  put(input: PutInput): Promise<PutResult>;
  /** Plaintext bytes or null when the key does not exist. */
  get(key: string): Promise<GetResult | null>;
  /** Idempotent: deleting a missing key is not an error. */
  delete(key: string): Promise<void>;
  /** Plaintext size or null when the key does not exist. */
  head(key: string): Promise<HeadResult | null>;
}

export type DocumentsS3Config = {
  /** Origin of the S3-compatible endpoint, e.g. https://s3.eu-central-1.example (path-style: /<bucket>/<key>). */
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Optional STS session token (x-amz-security-token). */
  sessionToken?: string;
};

export type DocumentsStorageConfig = {
  kind: DocumentStorageKind;
  /** disk: root directory (created on demand). */
  dir?: string;
  s3?: DocumentsS3Config;
  /** disk: AES-256-GCM envelope per file (at-rest-encryption.ts); s3: SSE header delegated to the provider. */
  encryptAtRest: boolean;
  /** base64 of 32 raw bytes (HOTELOS_FIELD_KEY / ENCRYPTION_KEY, resolved by the integrator); required when disk + encryptAtRest. */
  fieldKeyBase64?: string;
  /** Per-file cap applied by every adapter (DOCUMENT_MAX_BYTES). */
  maxBytes: number;
  /** Cap of the inline adapter (2 MiB by default: the bytes live in a database column). */
  inlineMaxBytes: number;
};

export const DEFAULT_DOCUMENT_MAX_BYTES = 25 * 1024 * 1024;
export const DEFAULT_INLINE_MAX_BYTES = 2 * 1024 * 1024;

export type DocumentStorageErrorCode =
  | "DOCUMENT_STORAGE_KEY_INVALID"
  | "DOCUMENT_TOO_LARGE"
  | "DOCUMENT_STORAGE_CONFIG_INVALID"
  | "DOCUMENT_STORAGE_KEY_MALFORMED"
  | "DOCUMENT_STORAGE_CIPHERTEXT_INVALID"
  | "DOCUMENT_STORAGE_IO"
  | "DOCUMENT_STORAGE_FORBIDDEN"
  | "DOCUMENT_STORAGE_UPSTREAM";

/**
 * Typed error of the store. An HttpError (lib/http-error.ts) so the global
 * error handler of server.ts answers with the right status and a
 * machine-readable `details.code` without per-route mapping: 400 for an
 * invalid key, 413 for the size cap, 500 for configuration / I/O, 502 for an
 * S3 upstream failure (`upstreamStatus` carries the provider's status code).
 */
export class DocumentStorageError extends HttpError {
  readonly code: DocumentStorageErrorCode;
  readonly upstreamStatus?: number;
  constructor(code: DocumentStorageErrorCode, message: string, options: { statusCode?: number; upstreamStatus?: number; cause?: unknown } = {}) {
    super(options.statusCode ?? defaultStatusFor(code), message, true, { code, ...(options.upstreamStatus !== undefined ? { upstreamStatus: options.upstreamStatus } : {}) });
    this.name = "DocumentStorageError";
    this.code = code;
    if (options.upstreamStatus !== undefined) this.upstreamStatus = options.upstreamStatus;
    if (options.cause !== undefined) this.cause = options.cause;
  }
}

function defaultStatusFor(code: DocumentStorageErrorCode): number {
  switch (code) {
    case "DOCUMENT_STORAGE_KEY_INVALID":
      return 400;
    case "DOCUMENT_TOO_LARGE":
      return 413;
    case "DOCUMENT_STORAGE_FORBIDDEN":
    case "DOCUMENT_STORAGE_UPSTREAM":
      return 502;
    default:
      return 500;
  }
}

// Ids of this repo are `<prefix>_<16 hex>` (lib/ids.ts); older rows may carry
// cuid-like ids, hence the wider [A-Za-z0-9_-] class. The sha256 segment is
// strict lowercase hex. No dots in the id segments: `..` can never appear.
const ID_SEGMENT = "[A-Za-z0-9_-]{1,64}";
const STORAGE_KEY_RE = new RegExp(`^org/${ID_SEGMENT}/prop/${ID_SEGMENT}/doc/${ID_SEGMENT}/[a-f0-9]{64}\\.(?:${STORAGE_EXTENSIONS.join("|")})$`);

/** Strict shape `org/<org>/prop/<prop>/doc/<doc>/<sha256>.<ext>` (single line, no `..`, no leading slash). */
export function isValidStorageKey(key: unknown): key is string {
  return typeof key === "string" && key.length <= 320 && STORAGE_KEY_RE.test(key);
}

export function assertStorageKey(key: unknown): string {
  if (!isValidStorageKey(key)) {
    throw new DocumentStorageError("DOCUMENT_STORAGE_KEY_INVALID", "Clave de almacén no válida.");
  }
  return key;
}

export type BuildStorageKeyInput = {
  organizationId: string;
  propertyId: string;
  documentId: string;
  sha256: string;
  ext: StorageExtension | string;
};

/** `org/<organizationId>/prop/<propertyId>/doc/<documentId>/<sha256>.<ext>`; throws when any part is unsafe. */
export function buildStorageKey(input: BuildStorageKeyInput): string {
  const ext = String(input.ext).toLowerCase().replace(/^\./, "");
  const key = `org/${input.organizationId}/prop/${input.propertyId}/doc/${input.documentId}/${input.sha256.toLowerCase()}.${ext}`;
  return assertStorageKey(key);
}

/** Extension of a (valid) key. */
export function storageKeyExtension(key: string): StorageExtension {
  const dot = key.lastIndexOf(".");
  return key.slice(dot + 1) as StorageExtension;
}

/** MIME type implied by the extension of a valid key (the store never trusts a sidecar for this). */
export function mimeTypeForKey(key: string): string {
  return MIME_BY_EXTENSION[storageKeyExtension(key)];
}

export function assertWithinLimit(sizeBytes: number, maxBytes: number, what = "El fichero"): void {
  if (sizeBytes > maxBytes) {
    throw new DocumentStorageError("DOCUMENT_TOO_LARGE", `${what} supera el tamaño máximo admitido (${maxBytes} bytes).`);
  }
}
