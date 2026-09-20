// Documents · at-rest encryption of stored files (Tanda T9 · lote T9-03,
// design §4.2 "Cifrado en reposo").
//
// File bytes never go through the PII field extension (crypto-fields.ts): the
// disk adapter wraps each object with AES-256-GCM using the same 32-byte key
// (HOTELOS_FIELD_KEY → ENCRYPTION_KEY, base64) that the integrator passes as
// DocumentsStorageConfig.fieldKeyBase64. Envelope layout, all binary:
//
//   "EHD1" (4 bytes magic) | iv (12) | auth tag (16) | ciphertext (n)
//
// A fresh random IV per object; the magic lets get() tell an encrypted file
// from a plaintext one written while encryptAtRest was off, so toggling the
// flag never makes old files unreadable.

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { DocumentStorageError } from "./storage.js";

export const AT_REST_MAGIC = Buffer.from("EHD1", "latin1");
export const AT_REST_IV_BYTES = 12;
export const AT_REST_TAG_BYTES = 16;
export const AT_REST_KEY_BYTES = 32;
/** Bytes added by the envelope: magic + iv + tag. */
export const AT_REST_OVERHEAD_BYTES = AT_REST_MAGIC.length + AT_REST_IV_BYTES + AT_REST_TAG_BYTES;

/** base64 (32 raw bytes) → key Buffer; throws DOCUMENT_STORAGE_KEY_MALFORMED otherwise. */
export function parseFieldKey(base64: string | undefined | null): Buffer {
  const trimmed = (base64 ?? "").trim();
  if (!trimmed) {
    throw new DocumentStorageError("DOCUMENT_STORAGE_KEY_MALFORMED", "Falta la clave de cifrado en reposo (base64 de 32 bytes).");
  }
  const key = Buffer.from(trimmed, "base64");
  if (key.length !== AT_REST_KEY_BYTES || key.toString("base64").replace(/=+$/, "") !== trimmed.replace(/=+$/, "")) {
    throw new DocumentStorageError("DOCUMENT_STORAGE_KEY_MALFORMED", "La clave de cifrado en reposo debe ser base64 de exactamente 32 bytes.");
  }
  return key;
}

export function isAtRestEnvelope(bytes: Uint8Array): boolean {
  return bytes.length >= AT_REST_OVERHEAD_BYTES && Buffer.from(bytes.buffer, bytes.byteOffset, AT_REST_MAGIC.length).equals(AT_REST_MAGIC);
}

export function encryptAtRest(plain: Uint8Array, key: Buffer): Buffer {
  const iv = randomBytes(AT_REST_IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([AT_REST_MAGIC, iv, tag, ciphertext]);
}

export function decryptAtRest(envelope: Uint8Array, key: Buffer): Buffer {
  if (!isAtRestEnvelope(envelope)) {
    throw new DocumentStorageError("DOCUMENT_STORAGE_CIPHERTEXT_INVALID", "El fichero no lleva la cabecera de cifrado EHD1.");
  }
  const buf = Buffer.from(envelope.buffer, envelope.byteOffset, envelope.byteLength);
  const ivStart = AT_REST_MAGIC.length;
  const tagStart = ivStart + AT_REST_IV_BYTES;
  const dataStart = tagStart + AT_REST_TAG_BYTES;
  const decipher = createDecipheriv("aes-256-gcm", key, buf.subarray(ivStart, tagStart));
  decipher.setAuthTag(buf.subarray(tagStart, dataStart));
  try {
    return Buffer.concat([decipher.update(buf.subarray(dataStart)), decipher.final()]);
  } catch (error) {
    throw new DocumentStorageError("DOCUMENT_STORAGE_CIPHERTEXT_INVALID", "No se pudo descifrar el fichero (clave distinta o contenido alterado).", { cause: error });
  }
}

/** Plaintext size implied by the size of an envelope on disk. */
export function plaintextSizeOfEnvelope(envelopeBytes: number): number {
  return Math.max(0, envelopeBytes - AT_REST_OVERHEAD_BYTES);
}
