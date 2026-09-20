// Documents · S3-compatible adapter (Tanda T9 · lote T9-03, design §4.2).
//
// Path-style requests (`<endpoint>/<bucket>/<key>`) signed with sigv4.ts over
// an injectable fetch (tests pass a fake; production passes globalThis.fetch).
// No SDK, no account: César picks an EU S3-compatible provider later and only
// fills the DOCUMENT_S3_* variables. Encryption at rest is delegated to the
// provider through SSE (`x-amz-server-side-encryption: AES256`) when the
// config asks for it; the adapter never applies the AES-GCM envelope itself.
// Errors are typed DocumentStorageError: 403 → DOCUMENT_STORAGE_FORBIDDEN,
// other non-2xx → DOCUMENT_STORAGE_UPSTREAM (with upstreamStatus), network
// failure → DOCUMENT_STORAGE_IO. 404 on GET/HEAD is `null`, on DELETE a no-op.

import { sha256Hex } from "./inline-storage.js";
import { EMPTY_PAYLOAD_SHA256, signRequest, uriEncode } from "./sigv4.js";
import {
  DEFAULT_DOCUMENT_MAX_BYTES,
  DocumentStorageError,
  assertStorageKey,
  assertWithinLimit,
  mimeTypeForKey,
  type DocumentStorage,
  type DocumentsS3Config,
  type GetResult,
  type HeadResult,
  type PutInput,
  type PutResult
} from "./storage.js";

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: Uint8Array; signal?: AbortSignal }) => Promise<{
  status: number;
  headers: { get(name: string): string | null };
  arrayBuffer(): Promise<ArrayBuffer>;
}>;

/** SEC-07: every request to the provider aborts after this long (a stalled endpoint must not pin an upload or a download). */
export const DEFAULT_S3_REQUEST_TIMEOUT_MS = 30_000;

export type S3StorageOptions = {
  s3: DocumentsS3Config;
  fetchImpl: FetchLike;
  /** Ask the provider for server-side encryption (AES256) on every PUT. */
  sse?: boolean;
  maxBytes?: number;
  /** Per-request timeout in ms (AbortSignal.timeout); 0 disables. */
  requestTimeoutMs?: number;
  /** Clock (tests pin it). */
  now?: () => Date;
};

export class S3DocumentStorage implements DocumentStorage {
  readonly kind = "s3" as const;
  private readonly cfg: DocumentsS3Config;
  private readonly fetchImpl: FetchLike;
  private readonly sse: boolean;
  private readonly maxBytes: number;
  private readonly requestTimeoutMs: number;
  private readonly now: () => Date;
  private readonly endpoint: URL;

  constructor(options: S3StorageOptions) {
    const s3 = options.s3;
    for (const field of ["endpoint", "region", "bucket", "accessKeyId", "secretAccessKey"] as const) {
      if (!s3?.[field]) {
        throw new DocumentStorageError("DOCUMENT_STORAGE_CONFIG_INVALID", `El almacén S3 necesita el campo ${field} (DOCUMENT_S3_*).`);
      }
    }
    let endpoint: URL;
    try {
      endpoint = new URL(s3.endpoint);
    } catch (error) {
      throw new DocumentStorageError("DOCUMENT_STORAGE_CONFIG_INVALID", "DOCUMENT_S3_ENDPOINT no es una URL válida.", { cause: error });
    }
    if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(s3.bucket)) {
      throw new DocumentStorageError("DOCUMENT_STORAGE_CONFIG_INVALID", "DOCUMENT_S3_BUCKET no es un nombre de bucket válido.");
    }
    this.cfg = s3;
    this.endpoint = endpoint;
    this.fetchImpl = options.fetchImpl;
    this.sse = options.sse ?? true;
    this.maxBytes = options.maxBytes ?? DEFAULT_DOCUMENT_MAX_BYTES;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_S3_REQUEST_TIMEOUT_MS;
    this.now = options.now ?? (() => new Date());
  }

  /** Path-style object URL: <endpoint>/<bucket>/<key> (key segments URI-encoded once). */
  objectUrl(key: string): URL {
    const base = this.endpoint.pathname.replace(/\/+$/, "");
    const url = new URL(this.endpoint.toString());
    url.pathname = `${base}/${this.cfg.bucket}/${uriEncode(assertStorageKey(key), false)}`;
    url.search = "";
    return url;
  }

  private async request(method: "PUT" | "GET" | "DELETE" | "HEAD", key: string, body?: Uint8Array, extraHeaders: Record<string, string> = {}) {
    const url = this.objectUrl(key);
    const payloadSha256 = body ? sha256Hex(body) : EMPTY_PAYLOAD_SHA256;
    const signed = signRequest({
      method,
      url,
      headers: extraHeaders,
      payloadSha256,
      credentials: { accessKeyId: this.cfg.accessKeyId, secretAccessKey: this.cfg.secretAccessKey, ...(this.cfg.sessionToken ? { sessionToken: this.cfg.sessionToken } : {}) },
      region: this.cfg.region,
      service: "s3",
      date: this.now()
    });
    try {
      return await this.fetchImpl(url.toString(), { method, headers: signed.headers, ...(body ? { body } : {}), ...(this.requestTimeoutMs > 0 ? { signal: AbortSignal.timeout(this.requestTimeoutMs) } : {}) });
    } catch (error) {
      throw new DocumentStorageError("DOCUMENT_STORAGE_IO", "No se pudo contactar con el almacén S3.", { cause: error });
    }
  }

  private fail(status: number, action: string): never {
    if (status === 403) {
      throw new DocumentStorageError("DOCUMENT_STORAGE_FORBIDDEN", `El almacén S3 rechazó ${action} (403: credenciales o permisos del bucket).`, { upstreamStatus: status });
    }
    throw new DocumentStorageError("DOCUMENT_STORAGE_UPSTREAM", `El almacén S3 devolvió ${status} al ${action}.`, { upstreamStatus: status });
  }

  async put(input: PutInput): Promise<PutResult> {
    const key = assertStorageKey(input.key);
    assertWithinLimit(input.bytes.byteLength, this.maxBytes);
    // content-length is set by fetch itself from the body; signing it by hand would break under undici.
    const headers: Record<string, string> = { "content-type": input.mimeType };
    if (this.sse) headers["x-amz-server-side-encryption"] = "AES256";
    const response = await this.request("PUT", key, input.bytes, headers);
    if (response.status < 200 || response.status >= 300) this.fail(response.status, "guardar el fichero");
    return { key, sha256: sha256Hex(input.bytes), sizeBytes: input.bytes.byteLength };
  }

  async get(key: string): Promise<GetResult | null> {
    const response = await this.request("GET", key);
    if (response.status === 404) return null;
    if (response.status < 200 || response.status >= 300) this.fail(response.status, "leer el fichero");
    // SEC-07: a body above the module cap is never read into memory (announced or actual length).
    const announced = Number(response.headers.get("content-length") ?? "");
    if (Number.isFinite(announced) && announced > this.maxBytes) this.tooLarge(announced);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > this.maxBytes) this.tooLarge(bytes.length);
    return { bytes, mimeType: mimeTypeForKey(key) };
  }

  private tooLarge(sizeBytes: number): never {
    throw new DocumentStorageError("DOCUMENT_STORAGE_UPSTREAM", `El almacén S3 devolvió un objeto de ${sizeBytes} bytes, por encima del tope de ${this.maxBytes} bytes.`, { upstreamStatus: 200 });
  }

  async delete(key: string): Promise<void> {
    const response = await this.request("DELETE", key);
    if (response.status === 404 || (response.status >= 200 && response.status < 300)) return;
    this.fail(response.status, "borrar el fichero");
  }

  async head(key: string): Promise<HeadResult | null> {
    const response = await this.request("HEAD", key);
    if (response.status === 404) return null;
    if (response.status < 200 || response.status >= 300) this.fail(response.status, "consultar el fichero");
    const length = Number(response.headers.get("content-length") ?? "0");
    return { sizeBytes: Number.isFinite(length) ? length : 0 };
  }
}
