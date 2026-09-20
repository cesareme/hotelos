// Documents · local disk adapter (Tanda T9 · lote T9-03, design §4.2).
//
// Files live under `dir` with the storage key as the relative path
// (org/<org>/prop/<prop>/doc/<doc>/<sha256>.<ext>). Safety: the key is
// validated by the strict regex of storage.ts AND the resolved path must stay
// inside `dir` (belt and braces against `..`, absolute paths, backslashes).
// Writes are atomic (temp file in the same directory + rename), directories
// are created on demand, the sha256 is computed from the plaintext while
// writing. With encryptAtRest the file on disk is the EHD1 envelope of
// at-rest-encryption.ts; get() decrypts envelopes and passes plaintext files
// through, so the flag can be switched on later without a rewrite.

import { randomBytes } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { isAbsolute, resolve, sep } from "node:path";
import { AT_REST_MAGIC, AT_REST_OVERHEAD_BYTES, decryptAtRest, encryptAtRest, isAtRestEnvelope, parseFieldKey, plaintextSizeOfEnvelope } from "./at-rest-encryption.js";
import { sha256Hex } from "./inline-storage.js";
import {
  DEFAULT_DOCUMENT_MAX_BYTES,
  DocumentStorageError,
  assertStorageKey,
  assertWithinLimit,
  mimeTypeForKey,
  type DocumentStorage,
  type GetResult,
  type HeadResult,
  type PutInput,
  type PutResult
} from "./storage.js";

export type DiskStorageOptions = {
  dir: string;
  encryptAtRest?: boolean;
  fieldKeyBase64?: string;
  maxBytes?: number;
};

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: string }).code === "ENOENT";
}

export class DiskDocumentStorage implements DocumentStorage {
  readonly kind = "disk" as const;
  readonly dir: string;
  private readonly key: Buffer | null;
  private readonly maxBytes: number;

  constructor(options: DiskStorageOptions) {
    if (!options.dir || typeof options.dir !== "string") {
      throw new DocumentStorageError("DOCUMENT_STORAGE_CONFIG_INVALID", "El almacén en disco necesita un directorio (DOCUMENT_STORAGE_DIR).");
    }
    this.dir = resolve(options.dir);
    this.maxBytes = options.maxBytes ?? DEFAULT_DOCUMENT_MAX_BYTES;
    // Fail fast: a disk store configured to encrypt without a usable key must
    // not boot and silently write plaintext.
    this.key = options.encryptAtRest ? parseFieldKey(options.fieldKeyBase64) : null;
  }

  get encrypts(): boolean {
    return this.key !== null;
  }

  /** Absolute path of a key; rejects anything that would escape `dir`. */
  resolvePath(rawKey: string): string {
    const key = assertStorageKey(rawKey);
    if (isAbsolute(key) || key.includes("\\") || key.split("/").some((segment) => segment === "." || segment === "..")) {
      throw new DocumentStorageError("DOCUMENT_STORAGE_KEY_INVALID", "Clave de almacén no válida.");
    }
    const full = resolve(this.dir, key);
    if (!full.startsWith(this.dir + sep)) {
      throw new DocumentStorageError("DOCUMENT_STORAGE_KEY_INVALID", "Clave de almacén fuera del directorio del almacén.");
    }
    return full;
  }

  async put(input: PutInput): Promise<PutResult> {
    const key = assertStorageKey(input.key);
    assertWithinLimit(input.bytes.byteLength, this.maxBytes);
    const path = this.resolvePath(key);
    const parent = path.slice(0, path.lastIndexOf(sep));
    const plain = Buffer.from(input.bytes.buffer, input.bytes.byteOffset, input.bytes.byteLength);
    const sha256 = sha256Hex(plain);
    const payload = this.key ? encryptAtRest(plain, this.key) : plain;
    const tmp = `${path}.tmp-${randomBytes(6).toString("hex")}`;
    try {
      await mkdir(parent, { recursive: true });
      await writeFile(tmp, payload, { flag: "wx", mode: 0o600 });
      await rename(tmp, path);
    } catch (error) {
      await rm(tmp, { force: true }).catch(() => undefined);
      throw new DocumentStorageError("DOCUMENT_STORAGE_IO", "No se pudo escribir el fichero en el almacén en disco.", { cause: error });
    }
    return { key, sha256, sizeBytes: plain.length };
  }

  async get(key: string): Promise<GetResult | null> {
    const path = this.resolvePath(key);
    let raw: Buffer;
    try {
      raw = await readFile(path);
    } catch (error) {
      if (isMissing(error)) return null;
      throw new DocumentStorageError("DOCUMENT_STORAGE_IO", "No se pudo leer el fichero del almacén en disco.", { cause: error });
    }
    let bytes: Buffer;
    if (isAtRestEnvelope(raw)) {
      if (!this.key) {
        throw new DocumentStorageError("DOCUMENT_STORAGE_CIPHERTEXT_INVALID", "El fichero está cifrado y el almacén no tiene clave (DOCUMENT_ENCRYPT_AT_REST).");
      }
      bytes = decryptAtRest(raw, this.key);
    } else {
      bytes = raw;
    }
    return { bytes, mimeType: mimeTypeForKey(key) };
  }

  async delete(key: string): Promise<void> {
    const path = this.resolvePath(key);
    try {
      await rm(path, { force: true });
    } catch (error) {
      throw new DocumentStorageError("DOCUMENT_STORAGE_IO", "No se pudo borrar el fichero del almacén en disco.", { cause: error });
    }
  }

  async head(key: string): Promise<HeadResult | null> {
    const path = this.resolvePath(key);
    try {
      const info = await stat(path);
      if (!info.isFile()) return null;
      // The envelope magic decides whether the size on disk includes the overhead.
      const handle = await open(path, "r");
      let encrypted = false;
      try {
        const probe = Buffer.alloc(AT_REST_MAGIC.length);
        const { bytesRead } = await handle.read(probe, 0, probe.length, 0);
        encrypted = bytesRead === probe.length && probe.equals(AT_REST_MAGIC) && info.size >= AT_REST_OVERHEAD_BYTES;
      } finally {
        await handle.close();
      }
      return { sizeBytes: encrypted ? plaintextSizeOfEnvelope(info.size) : info.size };
    } catch (error) {
      if (isMissing(error)) return null;
      throw new DocumentStorageError("DOCUMENT_STORAGE_IO", "No se pudo consultar el fichero del almacén en disco.", { cause: error });
    }
  }
}
