// Importación masiva de reservas (Tanda 7 · L4). Typed client of
// apps/api/src/modules/pms/reservation-import.routes.ts on the contracts of
// packages/shared/src/reservation-import-types.ts (design
// docs/design/RESERVAS-IMPORTACION-MASIVA.md §7; runbook
// docs/runbooks/reservas-importacion.md):
//
//   POST /properties/:propertyId/reservations/imports/preview   previewReservationImport (never writes)         pms.reservation.create
//   POST /properties/:propertyId/reservations/imports           createReservationImport (201, even `failed`)    create + modify
//   GET  /properties/:propertyId/reservations/imports           listReservationImports (newest first)           pms.reservation.read
//   GET  /properties/:propertyId/reservations/imports/template  downloadReservationImportTemplate → NamedDownload
//   GET  /properties/:propertyId/reservations/imports/:id       getReservationImport (lote + filas SIN datos personales)
//   POST /properties/:propertyId/reservations/imports/:id/undo  undoReservationImport (idempotente: alreadyUndone)  pms.reservation.modify
//
// The browser ALWAYS sends the bytes as `contentBase64` (CSV included): the API
// decides the encoding (utf-8 → windows-1252) and the format (`format` >
// extension > signature); `file.text()` would destroy latin1 (design §1.1).
// Errors arrive as details.code (RESERVATION_IMPORT_*) and are mapped by
// reservationImportErrorMessage on top of finance-contracts; a 413 of Fastify
// (bodyLimit 8 MiB) reads as «El fichero supera el tamaño admitido (5 MB)».
// Only `import type` from @hotelos/shared: the Spanish sentences per code are
// redeclared here, typed against the contract.

import type {
  ReservationImportCreateBody,
  ReservationImportDetail,
  ReservationImportErrorCode,
  ReservationImportFormat,
  ReservationImportListQuery,
  ReservationImportPreview,
  ReservationImportPreviewBody,
  ReservationImportRecord,
  ReservationImportResult,
  ReservationImportUndoBody,
  ReservationImportUndoResult
} from "@hotelos/shared";
import { date, number, plural } from "../lib/format";
import type { NamedDownload } from "./accountingApi";
import { getActivePropertyId } from "./activeProperty";
import { apiRequest, apiRequestBlob } from "./api-client";
import { compactQuery, downloadFilename, financeErrorCode, financeErrorDetails, financeErrorMessage, financeErrorStatus } from "./finance-contracts";

export type {
  ReservationImportCreateBody,
  ReservationImportDetail,
  ReservationImportFormat,
  ReservationImportListQuery,
  ReservationImportPreview,
  ReservationImportPreviewBody,
  ReservationImportRecord,
  ReservationImportResult,
  ReservationImportUndoBody,
  ReservationImportUndoResult
} from "@hotelos/shared";

const enc = encodeURIComponent;

/** Base path of the six routes for a property. */
export function reservationImportsPath(propertyId: string = getActivePropertyId()): string {
  return `/properties/${enc(propertyId)}/reservations/imports`;
}

/** File name of the official template per format (the API names it in Content-Disposition; this is the fallback). */
export const RESERVATION_IMPORT_TEMPLATE_FILE_NAMES: Readonly<Record<ReservationImportFormat, string>> = Object.freeze({
  csv: "plantilla-reservas.csv",
  xlsx: "plantilla-reservas.xlsx"
});

/** Parses, maps and validates the file without writing anything: rows with their verdict, availability, duplicates, `canImport` and blockers. */
export function previewReservationImport(body: ReservationImportPreviewBody, propertyId: string = getActivePropertyId()): Promise<ReservationImportPreview> {
  return apiRequest<ReservationImportPreview>(`${reservationImportsPath(propertyId)}/preview`, { method: "POST", body });
}

/** Creates the lot and one reservation per valid row through createReservation (201 whenever the lot exists, even `failed`). 400 RESERVATION_IMPORT_INVALID without `omitirInvalidas` · 409 RESERVATION_IMPORT_DUPLICATE without `force`. */
export function createReservationImport(body: ReservationImportCreateBody, propertyId: string = getActivePropertyId()): Promise<ReservationImportResult> {
  return apiRequest<ReservationImportResult>(reservationImportsPath(propertyId), { method: "POST", body });
}

/** Lots of the property, newest first (no rows); `limit` 1..200 (50 by default). */
export function listReservationImports(query: ReservationImportListQuery = {}, propertyId: string = getActivePropertyId()): Promise<ReservationImportRecord[]> {
  return apiRequest<ReservationImportRecord[]>(reservationImportsPath(propertyId), { query: compactQuery({ status: query.status, limit: query.limit }) });
}

/** The lot with its rows ordered by row number (opaque 404 outside the property or the organisation). */
export function getReservationImport(importId: string, propertyId: string = getActivePropertyId()): Promise<ReservationImportDetail> {
  return apiRequest<ReservationImportDetail>(`${reservationImportsPath(propertyId)}/${enc(importId)}`);
}

/** Cancels every reservation of the lot still without check-in (kept otherwise); idempotent (`alreadyUndone`). 409 RESERVATION_IMPORT_UNDO_IN_PROGRESS while another undo holds the claim (15 min). */
export function undoReservationImport(importId: string, body: ReservationImportUndoBody = {}, propertyId: string = getActivePropertyId()): Promise<ReservationImportUndoResult> {
  return apiRequest<ReservationImportUndoResult>(`${reservationImportsPath(propertyId)}/${enc(importId)}/undo`, { method: "POST", body });
}

/** Official template (CSV with BOM, «;» and CRLF, or XLSX with the «Instrucciones» sheet) named by the API. */
export async function downloadReservationImportTemplate(format: ReservationImportFormat = "csv", propertyId: string = getActivePropertyId()): Promise<NamedDownload> {
  const response = await apiRequestBlob(`${reservationImportsPath(propertyId)}/template`, { query: { format } });
  return { blob: response.blob, filename: downloadFilename(response.contentDisposition, RESERVATION_IMPORT_TEMPLATE_FILE_NAMES[format]), contentType: response.contentType };
}

// ---------------------------------------------------------------------------
// Errors (details.code → Spanish; mirror of RESERVATION_IMPORT_ERROR_LABELS_ES)
// ---------------------------------------------------------------------------

export const RESERVATION_IMPORT_ERROR_MESSAGES: Readonly<Record<ReservationImportErrorCode, string>> = Object.freeze({
  VALIDATION_ERROR: "La petición no es válida.",
  RESERVATION_IMPORT_UNREADABLE: "No se ha podido leer el fichero: guárdalo como .xlsx normal o como CSV.",
  RESERVATION_IMPORT_TOO_LARGE: "El fichero supera el tamaño admitido (5 MB): pártelo o impórtalo por la herramienta de línea de comandos.",
  RESERVATION_IMPORT_TOO_MANY_ROWS: "El fichero supera las 5.000 filas: pártelo.",
  RESERVATION_IMPORT_EMPTY: "El fichero no tiene filas de datos o no hay ninguna reserva que crear.",
  RESERVATION_IMPORT_MAPPING_INCOMPLETE: "Faltan columnas obligatorias por mapear.",
  RESERVATION_IMPORT_MAPPING_CONFLICT: "El mapeo asigna un campo a dos columnas o cita una columna que no existe.",
  RESERVATION_IMPORT_INVALID: "Hay filas con errores: corrígelas o activa «Omitir filas inválidas».",
  RESERVATION_IMPORT_DUPLICATE: "Este fichero ya se importó: deshaz el lote anterior o activa «Importar de todos modos».",
  RESERVATION_IMPORT_NOT_FOUND: "Importación de reservas no encontrada.",
  RESERVATION_IMPORT_UNDO_IN_PROGRESS: "Otro deshacer de este lote está en curso: espera unos minutos."
});

const DEFAULT_IMPORT_ERROR = "No se pudo completar la importación de reservas.";

function isImportErrorCode(code: string | null): code is ReservationImportErrorCode {
  return code !== null && Object.prototype.hasOwnProperty.call(RESERVATION_IMPORT_ERROR_MESSAGES, code);
}

function detailString(details: Record<string, unknown> | null, key: string): string | null {
  const value = details?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function detailNumber(details: Record<string, unknown> | null, key: string): number | null {
  const value = details?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function detailStrings(details: Record<string, unknown> | null, key: string): string[] {
  const value = details?.[key];
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "") : [];
}

/**
 * Spanish message of an import error: the sentence of `details.code` plus the
 * datum the code carries — the duplicate lot (file name, date), the number of
 * rows with errors, the missing or conflicting fields, the row count — and the
 * 413 of the body limit as the «5 MB» sentence. Anything else falls back to
 * finance-contracts (API message, then `fallback`).
 */
export function reservationImportErrorMessage(error: unknown, fallback: string = DEFAULT_IMPORT_ERROR): string {
  if (financeErrorStatus(error) === 413) return RESERVATION_IMPORT_ERROR_MESSAGES.RESERVATION_IMPORT_TOO_LARGE;
  const code = financeErrorCode(error);
  const details = financeErrorDetails(error);
  const base = isImportErrorCode(code) ? RESERVATION_IMPORT_ERROR_MESSAGES[code] : financeErrorMessage(error, fallback);
  switch (code) {
    case "RESERVATION_IMPORT_DUPLICATE": {
      const lot = detailString(details, "fileName") ?? detailString(details, "importId");
      const when = detailString(details, "createdAt");
      const whenLabel = when ? date(when, "medium") : null;
      const suffix = lot ? ` (lote ${lot}${whenLabel && whenLabel !== "—" ? `, ${whenLabel}` : ""})` : "";
      return `Este fichero ya se importó${suffix}. Deshaz el lote anterior o activa «Importar de todos modos».`;
    }
    case "RESERVATION_IMPORT_INVALID": {
      const errorCount = detailNumber(details, "errorCount");
      return errorCount !== null && errorCount > 0 ? `Hay ${plural(errorCount, "fila con errores", "filas con errores")}: corrígelas o activa «Omitir filas inválidas».` : base;
    }
    case "RESERVATION_IMPORT_MAPPING_INCOMPLETE": {
      const missing = detailStrings(details, "missing");
      return missing.length > 0 ? `Faltan columnas obligatorias por mapear: ${missing.join(", ")}.` : base;
    }
    case "RESERVATION_IMPORT_MAPPING_CONFLICT": {
      const field = detailString(details, "field");
      const columns = detailStrings(details, "columns");
      if (field && columns.length > 0) return `El campo «${field}» está asignado a varias columnas (${columns.join(", ")}) o el mapeo cita una columna que no existe.`;
      return field ? `El campo «${field}» está asignado a varias columnas o el mapeo cita una columna que no existe.` : base;
    }
    case "RESERVATION_IMPORT_TOO_MANY_ROWS": {
      const rows = detailNumber(details, "rows");
      const max = detailNumber(details, "max");
      return rows !== null && max !== null ? `El fichero tiene ${number(rows)} filas de datos y el máximo es ${number(max)}: pártelo.` : base;
    }
    default:
      return base;
  }
}
