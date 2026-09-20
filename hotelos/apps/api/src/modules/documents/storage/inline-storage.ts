// Documents · inline adapter (Tanda T9 · lote T9-03, design §4.2 "Demo local").
//
// The bytes are persisted by the caller in the DocumentFile.inline column as
// base64 (encodeInline / decodeInline); every reader (downloads, pipeline,
// split / merge, dispatch) decodes that column. The Map here is only a small
// read cache for the last puts, BOUNDED by bytes (cacheMaxBytes, 8 MiB by
// default) with LRU eviction (SEC-04: an unbounded Map grew with every upload
// until the process restarted). Cap of inlineMaxBytes (2 MiB by default) per
// file: anything bigger belongs on disk or S3. Used when DOCUMENT_STORAGE_KIND
// is unset: a demo works out of the box and a restart re-hydrates rows on
// demand through restoreInlineRecord.

import { createHash } from "node:crypto";
import {
  DEFAULT_INLINE_MAX_BYTES,
  assertStorageKey,
  assertWithinLimit,
  type DocumentStorage,
  type GetResult,
  type HeadResult,
  type PutInput,
  type PutResult
} from "./storage.js";

export type InlineRecord = { key: string; mimeType: string; base64: string; sha256: string; sizeBytes: number };

export function encodeInline(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
}

export function decodeInline(base64: string): Buffer {
  return Buffer.from(base64, "base64");
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Read cache of the inline adapter: at most this many bytes stay in memory (LRU). */
export const DEFAULT_INLINE_CACHE_MAX_BYTES = 8 * 1024 * 1024;

export class InlineDocumentStorage implements DocumentStorage {
  readonly kind = "inline" as const;
  /** Insertion order = recency (Map): the oldest entry is evicted first. */
  private readonly entries = new Map<string, { bytes: Buffer; mimeType: string; sha256: string }>();
  private readonly maxBytes: number;
  private readonly cacheMaxBytes: number;
  private cached = 0;

  constructor(options: { inlineMaxBytes?: number; maxBytes?: number; cacheMaxBytes?: number } = {}) {
    const inlineMax = options.inlineMaxBytes ?? DEFAULT_INLINE_MAX_BYTES;
    this.maxBytes = options.maxBytes !== undefined ? Math.min(inlineMax, options.maxBytes) : inlineMax;
    this.cacheMaxBytes = options.cacheMaxBytes ?? DEFAULT_INLINE_CACHE_MAX_BYTES;
  }

  private remember(key: string, entry: { bytes: Buffer; mimeType: string; sha256: string }): void {
    this.forget(key);
    if (entry.bytes.length > this.cacheMaxBytes) return;
    this.entries.set(key, entry);
    this.cached += entry.bytes.length;
    for (const [oldest, old] of this.entries) {
      if (this.cached <= this.cacheMaxBytes) break;
      this.entries.delete(oldest);
      this.cached -= old.bytes.length;
    }
  }

  private forget(key: string): void {
    const previous = this.entries.get(key);
    if (!previous) return;
    this.entries.delete(key);
    this.cached -= previous.bytes.length;
  }

  private touch(key: string): { bytes: Buffer; mimeType: string; sha256: string } | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry;
  }

  async put(input: PutInput): Promise<PutResult> {
    const key = assertStorageKey(input.key);
    assertWithinLimit(input.bytes.byteLength, this.maxBytes, "El fichero (almacén inline)");
    const bytes = Buffer.from(input.bytes.buffer, input.bytes.byteOffset, input.bytes.byteLength);
    const sha256 = sha256Hex(bytes);
    this.remember(key, { bytes: Buffer.from(bytes), mimeType: input.mimeType, sha256 });
    return { key, sha256, sizeBytes: bytes.length };
  }

  async get(key: string): Promise<GetResult | null> {
    const entry = this.touch(assertStorageKey(key));
    return entry ? { bytes: Buffer.from(entry.bytes), mimeType: entry.mimeType } : null;
  }

  async delete(key: string): Promise<void> {
    this.forget(assertStorageKey(key));
  }

  async head(key: string): Promise<HeadResult | null> {
    const entry = this.entries.get(assertStorageKey(key));
    return entry ? { sizeBytes: entry.bytes.length } : null;
  }

  /** Serialised form for DocumentFile.inline (null when the key is not in memory). */
  toInlineRecord(key: string): InlineRecord | null {
    const entry = this.entries.get(assertStorageKey(key));
    if (!entry) return null;
    return { key, mimeType: entry.mimeType, base64: encodeInline(entry.bytes), sha256: entry.sha256, sizeBytes: entry.bytes.length };
  }

  /** Re-hydrates one row into memory (boot / lazy load); the sha256 is recomputed, never trusted. */
  restoreInlineRecord(record: Pick<InlineRecord, "key" | "mimeType" | "base64">): PutResult {
    const bytes = decodeInline(record.base64);
    const key = assertStorageKey(record.key);
    assertWithinLimit(bytes.length, this.maxBytes, "El fichero (almacén inline)");
    const sha256 = sha256Hex(bytes);
    this.remember(key, { bytes, mimeType: record.mimeType, sha256 });
    return { key, sha256, sizeBytes: bytes.length };
  }

  get size(): number {
    return this.entries.size;
  }

  /** Bytes retained by the read cache (never above cacheMaxBytes). */
  get cachedBytes(): number {
    return this.cached;
  }
}
