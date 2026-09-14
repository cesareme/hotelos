import { createHash } from "node:crypto";

// VeriFactu "huella" per RD 1007/2023 and Orden HAC/1177/2024 (anexo I and
// the AEAT technical note "Detalle de las especificaciones técnicas para
// generación de la huella o hash de los registros de facturación").
//
// RegistroAlta — SHA-256 hex (upper-case) over the `&`-joined key=value list:
//   IDEmisorFactura          NIF of the issuer
//   NumSerieFactura          invoice number (incl. series prefix)
//   FechaExpedicionFactura   dd-mm-yyyy
//   TipoFactura              F1 (full), F2 (simplified), R1..R5, F3
//   CuotaTotal               total tax quota, 2 decimals, dot separator
//   ImporteTotal             total invoice amount (tax included), 2 decimals
//   Huella                   previous record's huella ("" for the first record)
//   FechaHoraHusoGenRegistro ISO-8601 with the Europe/Madrid offset
//
// RegistroAnulacion — same algorithm over:
//   IDEmisorFacturaAnulada, NumSerieFacturaAnulada, FechaExpedicionFacturaAnulada,
//   Huella (previous record), FechaHoraHusoGenRegistro
//
// The chain is ONE sequence of records per obligado (altas and anulaciones
// interleaved by generation time): the previous huella of an anulación may be
// an alta and vice versa.

export type VerifactuInvoiceType = "F1" | "F2" | "F3" | "R1" | "R2" | "R3" | "R4" | "R5";

export type VerifactuHashInput = {
  emitterTaxId: string;
  invoiceNumber: string;
  issuedAt: string;
  invoiceType: VerifactuInvoiceType;
  vatTotal: number;
  invoiceTotal: number;
  previousHash?: string | null;
};

const SPANISH_DATE_RE = /^\d{2}-\d{2}-\d{4}$/;
const OFFSET_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/;

function parseIso(iso: string): Date {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) throw new Error(`Invalid date: ${iso}`);
  return d;
}

/** dd-mm-yyyy of an ISO timestamp, using the Europe/Madrid calendar day. */
export function formatVerifactuDate(iso: string): string {
  if (SPANISH_DATE_RE.test(iso)) return iso;
  const d = parseIso(iso);
  const local = new Date(d.getTime() + madridOffsetMinutes(d) * 60_000);
  const dd = String(local.getUTCDate()).padStart(2, "0");
  const mm = String(local.getUTCMonth() + 1).padStart(2, "0");
  const yyyy = local.getUTCFullYear();
  return `${dd}-${mm}-${yyyy}`;
}

/** Legacy name kept for callers that predate formatVerifactuDate. */
function formatDateSpanish(iso: string): string {
  return formatVerifactuDate(iso);
}

export function formatVerifactuAmount(n: number): string {
  const rounded = Math.round((Math.abs(n) + Number.EPSILON) * 100) / 100;
  const value = n < 0 ? -rounded : rounded;
  // Never emit "-0.00".
  return (value === 0 ? 0 : value).toFixed(2);
}

function formatAmount(n: number): string {
  return formatVerifactuAmount(n);
}

/**
 * Last Sunday of a month at 01:00 UTC — the instant EU summer time starts
 * (March) and ends (October), per Directive 2000/84/EC. Computed, not
 * approximated: the previous fixed-day heuristic (29-Mar / 25-Oct) produced a
 * wrong offset in years where the last Sunday falls earlier.
 */
export function lastSundayOfMonthUtc(year: number, monthIndex: number): Date {
  // Day 0 of the next month is the last day of `monthIndex`.
  const lastDay = new Date(Date.UTC(year, monthIndex + 1, 0));
  const dayOfWeek = lastDay.getUTCDay();
  return new Date(Date.UTC(year, monthIndex, lastDay.getUTCDate() - dayOfWeek, 1, 0, 0));
}

/** Europe/Madrid UTC offset (minutes) in force at the given instant: 60 (CET) or 120 (CEST). */
export function madridOffsetMinutes(at: Date): number {
  const year = at.getUTCFullYear();
  const dstStart = lastSundayOfMonthUtc(year, 2); // March
  const dstEnd = lastSundayOfMonthUtc(year, 9); // October
  const t = at.getTime();
  return t >= dstStart.getTime() && t < dstEnd.getTime() ? 120 : 60;
}

/** YYYY-MM-DDThh:mm:ss±hh:mm in Europe/Madrid local time (FechaHoraHusoGenRegistro). */
export function formatVerifactuTimestamp(iso: string): string {
  if (OFFSET_TIMESTAMP_RE.test(iso)) return iso;
  const d = parseIso(iso);
  const offsetMinutes = madridOffsetMinutes(d);
  const adjusted = new Date(d.getTime() + offsetMinutes * 60_000);
  const pad = (n: number) => String(n).padStart(2, "0");
  const yyyy = adjusted.getUTCFullYear();
  const mm = pad(adjusted.getUTCMonth() + 1);
  const dd = pad(adjusted.getUTCDate());
  const hh = pad(adjusted.getUTCHours());
  const mi = pad(adjusted.getUTCMinutes());
  const ss = pad(adjusted.getUTCSeconds());
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const oh = pad(Math.floor(Math.abs(offsetMinutes) / 60));
  const om = pad(Math.abs(offsetMinutes) % 60);
  return `${yyyy}-${mm}-${dd}T${hh}:${mi}:${ss}${sign}${oh}:${om}`;
}

function formatIsoWithMadridOffset(iso: string): string {
  return formatVerifactuTimestamp(iso);
}

function sha256Upper(canonical: string): string {
  return createHash("sha256").update(canonical, "utf-8").digest("hex").toUpperCase();
}

export function buildVerifactuCanonical(input: VerifactuHashInput): string {
  return [
    `IDEmisorFactura=${input.emitterTaxId}`,
    `NumSerieFactura=${input.invoiceNumber}`,
    `FechaExpedicionFactura=${formatDateSpanish(input.issuedAt)}`,
    `TipoFactura=${input.invoiceType}`,
    `CuotaTotal=${formatAmount(input.vatTotal)}`,
    `ImporteTotal=${formatAmount(input.invoiceTotal)}`,
    `Huella=${input.previousHash ?? ""}`,
    `FechaHoraHusoGenRegistro=${formatIsoWithMadridOffset(input.issuedAt)}`
  ].join("&");
}

export function computeVerifactuHash(input: VerifactuHashInput): {
  canonical: string;
  hash: string;
} {
  const canonical = buildVerifactuCanonical(input);
  return { canonical, hash: sha256Upper(canonical) };
}

export type VerifactuAnulacionHashInput = {
  /** IDEmisorFacturaAnulada — NIF snapshot the invoice was issued with. */
  emitterTaxId: string;
  /** NumSerieFacturaAnulada. */
  invoiceNumber: string;
  /** FechaExpedicionFacturaAnulada — dd-mm-yyyy (an ISO timestamp is converted). */
  issuedAt: string;
  /** Huella of the previous record in the chain (alta or anulación), null for the first record. */
  previousHash: string | null;
  /** FechaHoraHusoGenRegistro — YYYY-MM-DDThh:mm:ss±hh:mm (an ISO timestamp is converted to Europe/Madrid). */
  generatedAt: string;
};

export function buildVerifactuAnulacionCanonical(input: VerifactuAnulacionHashInput): string {
  return [
    `IDEmisorFacturaAnulada=${input.emitterTaxId}`,
    `NumSerieFacturaAnulada=${input.invoiceNumber}`,
    `FechaExpedicionFacturaAnulada=${formatVerifactuDate(input.issuedAt)}`,
    `Huella=${input.previousHash ?? ""}`,
    `FechaHoraHusoGenRegistro=${formatVerifactuTimestamp(input.generatedAt)}`
  ].join("&");
}

/** Huella of a RegistroAnulacion (contract E). */
export function computeVerifactuAnulacionHash(input: VerifactuAnulacionHashInput): { hash: string; canonical: string } {
  const canonical = buildVerifactuAnulacionCanonical(input);
  return { hash: sha256Upper(canonical), canonical };
}

export type VerifactuQrInput = {
  emitterTaxId: string;
  invoiceNumber: string;
  issuedAt: string;
  invoiceTotal: number;
  preProduction?: boolean;
};

export function buildVerifactuQrUrl(input: VerifactuQrInput): string {
  const base = input.preProduction
    ? "https://prewww2.aeat.es/wlpl/TIKE-CONT/ValidarQR"
    : "https://www2.agenciatributaria.gob.es/wlpl/TIKE-CONT/ValidarQR";
  const params = new URLSearchParams({
    nif: input.emitterTaxId,
    numserie: input.invoiceNumber,
    fecha: formatDateSpanish(input.issuedAt),
    importe: formatAmount(input.invoiceTotal)
  });
  return `${base}?${params.toString()}`;
}
