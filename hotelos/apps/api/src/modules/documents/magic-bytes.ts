// Documents · MIME whitelist and magic-byte sniffing (Tanda T9 · lote T9-03,
// design §4.2 "Subida"). The declared MIME type of an upload is checked
// against a whitelist AND the first bytes of the content; HTML / SVG (stored
// XSS) are never accepted, even wrapped in an XML declaration. Errors are
// HttpError 400 with a machine-readable details.code so the front can branch.

import { HttpError } from "../../lib/http-error.js";
import type { StorageExtension } from "./storage/storage.js";

export type AllowedDocumentMime = "application/pdf" | "image/jpeg" | "image/png" | "image/tiff" | "application/xml" | "text/xml";

export const ALLOWED_DOCUMENT_MIME_TYPES: readonly AllowedDocumentMime[] = Object.freeze(["application/pdf", "image/jpeg", "image/png", "image/tiff", "application/xml", "text/xml"]);

/** Canonical family of a whitelisted MIME (text/xml and application/xml are the same signature). */
export type SniffedMime = "application/pdf" | "image/jpeg" | "image/png" | "image/tiff" | "application/xml";

const EXTENSION_BY_MIME: Readonly<Record<SniffedMime, StorageExtension>> = Object.freeze({
  "application/pdf": "pdf",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/tiff": "tif",
  "application/xml": "xml"
});

export type DocumentMimeErrorCode = "DOCUMENT_MIME_NOT_ALLOWED" | "DOCUMENT_CONTENT_MISMATCH";

function mimeError(code: DocumentMimeErrorCode, message: string, extra: Record<string, unknown> = {}): HttpError {
  return new HttpError(400, message, true, { code, ...extra });
}

/** Lower-cased media type without parameters (`Text/XML; charset=utf-8` → `text/xml`). */
export function normalizeMimeType(raw: string | null | undefined): string {
  return String(raw ?? "")
    .split(";")[0]!
    .trim()
    .toLowerCase();
}

export function isAllowedDocumentMime(mimeType: string): mimeType is AllowedDocumentMime {
  return (ALLOWED_DOCUMENT_MIME_TYPES as readonly string[]).includes(normalizeMimeType(mimeType));
}

/** Canonical family of a whitelisted MIME; null when not whitelisted. */
export function canonicalDocumentMime(mimeType: string): SniffedMime | null {
  const normalized = normalizeMimeType(mimeType);
  if (!isAllowedDocumentMime(normalized)) return null;
  return normalized === "text/xml" ? "application/xml" : (normalized as SniffedMime);
}

export function extensionForMime(mimeType: string): StorageExtension | null {
  const canonical = canonicalDocumentMime(mimeType);
  return canonical ? EXTENSION_BY_MIME[canonical] : null;
}

function startsWith(bytes: Uint8Array, signature: number[], offset = 0): boolean {
  if (bytes.length < offset + signature.length) return false;
  for (let i = 0; i < signature.length; i++) if (bytes[offset + i] !== signature[i]) return false;
  return true;
}

const UTF8_BOM = [0xef, 0xbb, 0xbf];
const UTF16_LE_BOM = [0xff, 0xfe];
const UTF16_BE_BOM = [0xfe, 0xff];
const XML_DECL = [0x3c, 0x3f, 0x78, 0x6d, 0x6c]; // <?xml

/** `<?xml` after an optional BOM (UTF-8, UTF-16 LE/BE, with the UTF-16 declaration widened). */
function looksLikeXml(bytes: Uint8Array): boolean {
  if (startsWith(bytes, XML_DECL)) return true;
  if (startsWith(bytes, UTF8_BOM) && startsWith(bytes, XML_DECL, 3)) return true;
  if (startsWith(bytes, UTF16_LE_BOM)) {
    return XML_DECL.every((code, i) => bytes[2 + i * 2] === code && bytes[3 + i * 2] === 0x00);
  }
  if (startsWith(bytes, UTF16_BE_BOM)) {
    return XML_DECL.every((code, i) => bytes[2 + i * 2] === 0x00 && bytes[3 + i * 2] === code);
  }
  return false;
}

/** Text of the first 4 KiB, with UTF-16 NULs dropped, for the HTML/SVG root check. */
function headText(bytes: Uint8Array): string {
  const slice = bytes.subarray(0, 4096);
  let out = "";
  for (const byte of slice) if (byte !== 0) out += String.fromCharCode(byte);
  return out.toLowerCase();
}

/** True when the XML would render as markup in a browser (root svg/html, or a script element in the head). */
export function xmlLooksLikeMarkup(bytes: Uint8Array): boolean {
  const text = headText(bytes);
  return /<\s*(?:[a-z0-9_-]+:)?(?:svg|html|script)\b/i.test(text);
}

/**
 * Signature → canonical MIME, or null for anything the module does not admit
 * (HTML, SVG, ZIP, Office files, executables… all fall to null).
 */
export function sniffMime(bytes: Uint8Array): SniffedMime | null {
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) return "application/pdf"; // %PDF-
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47])) return "image/png";
  if (startsWith(bytes, [0x49, 0x49, 0x2a, 0x00]) || startsWith(bytes, [0x4d, 0x4d, 0x00, 0x2a])) return "image/tiff";
  if (looksLikeXml(bytes)) return xmlLooksLikeMarkup(bytes) ? null : "application/xml";
  return null;
}

/**
 * Whitelist + magic bytes. Returns the canonical MIME the bytes really are
 * (application/xml for text/xml). Throws HttpError 400 with details.code
 * DOCUMENT_MIME_NOT_ALLOWED (declared type outside the whitelist) or
 * DOCUMENT_CONTENT_MISMATCH (bytes do not match the declared type, including
 * HTML/SVG disguised as PDF or XML).
 */
export function assertContentMatches(mimeType: string, bytes: Uint8Array): SniffedMime {
  const declared = canonicalDocumentMime(mimeType);
  if (!declared) {
    throw mimeError("DOCUMENT_MIME_NOT_ALLOWED", `Tipo de fichero no admitido: ${normalizeMimeType(mimeType) || "(vacío)"}. Admitidos: PDF, JPEG, PNG, TIFF y XML.`, {
      mimeType: normalizeMimeType(mimeType),
      allowed: ALLOWED_DOCUMENT_MIME_TYPES
    });
  }
  const sniffed = sniffMime(bytes);
  if (sniffed !== declared) {
    throw mimeError("DOCUMENT_CONTENT_MISMATCH", `El contenido del fichero no corresponde al tipo declarado (${normalizeMimeType(mimeType)}).`, {
      mimeType: normalizeMimeType(mimeType),
      sniffed
    });
  }
  return sniffed;
}
