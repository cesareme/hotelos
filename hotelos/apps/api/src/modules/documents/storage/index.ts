// Documents · storage factory (Tanda T9 · lote T9-03).
//
// createDocumentStorage(config) picks the adapter from
// DocumentsStorageConfig.kind. The config object is built by the integrator
// (server.ts, lote T9-05b) from the env contract; nothing here reads the
// environment. `deps.fetchImpl` defaults to the global fetch (Node ≥ 18) and
// is what the S3 tests replace.

import { DiskDocumentStorage } from "./disk-storage.js";
import { InlineDocumentStorage } from "./inline-storage.js";
import { S3DocumentStorage, type FetchLike } from "./s3-storage.js";
import { DEFAULT_DOCUMENT_MAX_BYTES, DEFAULT_INLINE_MAX_BYTES, DocumentStorageError, type DocumentStorage, type DocumentsStorageConfig } from "./storage.js";

export type CreateDocumentStorageDeps = { fetchImpl?: FetchLike; now?: () => Date };

export function createDocumentStorage(config: DocumentsStorageConfig, deps: CreateDocumentStorageDeps = {}): DocumentStorage {
  const maxBytes = config.maxBytes > 0 ? config.maxBytes : DEFAULT_DOCUMENT_MAX_BYTES;
  const inlineMaxBytes = config.inlineMaxBytes > 0 ? config.inlineMaxBytes : DEFAULT_INLINE_MAX_BYTES;
  switch (config.kind) {
    case "inline":
      return new InlineDocumentStorage({ inlineMaxBytes, maxBytes });
    case "disk":
      return new DiskDocumentStorage({
        dir: config.dir ?? "",
        encryptAtRest: config.encryptAtRest,
        ...(config.fieldKeyBase64 !== undefined ? { fieldKeyBase64: config.fieldKeyBase64 } : {}),
        maxBytes
      });
    case "s3": {
      if (!config.s3) {
        throw new DocumentStorageError("DOCUMENT_STORAGE_CONFIG_INVALID", "DOCUMENT_STORAGE_KIND=s3 exige las variables DOCUMENT_S3_*.");
      }
      const fetchImpl = deps.fetchImpl ?? (globalThis.fetch as unknown as FetchLike | undefined);
      if (!fetchImpl) {
        throw new DocumentStorageError("DOCUMENT_STORAGE_CONFIG_INVALID", "El almacén S3 necesita fetch (Node ≥ 18).");
      }
      return new S3DocumentStorage({ s3: config.s3, fetchImpl, sse: config.encryptAtRest, maxBytes, ...(deps.now ? { now: deps.now } : {}) });
    }
    default:
      throw new DocumentStorageError("DOCUMENT_STORAGE_CONFIG_INVALID", `DOCUMENT_STORAGE_KIND no admitido: ${String((config as { kind: unknown }).kind)}.`);
  }
}

export { DiskDocumentStorage } from "./disk-storage.js";
export { InlineDocumentStorage, encodeInline, decodeInline, sha256Hex } from "./inline-storage.js";
export { S3DocumentStorage, type FetchLike } from "./s3-storage.js";
export { signRequest, uriEncode, amzDate, EMPTY_PAYLOAD_SHA256 } from "./sigv4.js";
export * from "./at-rest-encryption.js";
export * from "./storage.js";
