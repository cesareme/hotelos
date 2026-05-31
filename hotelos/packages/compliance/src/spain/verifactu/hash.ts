import { createHash } from "node:crypto";

// Real VeriFactu hash per RD 1007/2023 and Orden HFP/1177/2024.
// The "huella" is SHA-256 hex (uppercase) over a canonical concatenation of:
//   IDEmisorFactura  : NIF of the issuer
//   NumSerieFactura  : invoice number (incl. series prefix)
//   FechaExpedicionFactura : dd-mm-yyyy
//   TipoFactura      : F1 (full), F2 (simplified), R1..R5 (rectifying), F3, etc.
//   CuotaTotal       : sum of VAT amount, 2 decimals, dot separator
//   ImporteTotal     : total invoice amount (with VAT), 2 decimals, dot separator
//   Huella           : previous record's huella ("" if first record in chain)
//   FechaHoraHusoGenRegistro : ISO-8601 with timezone offset (Europe/Madrid)
//
// Format: key=value separated by `&`. SHA-256 hex upper-case.

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

function formatDateSpanish(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) throw new Error(`Invalid date: ${iso}`);
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const yyyy = d.getUTCFullYear();
  return `${dd}-${mm}-${yyyy}`;
}

function formatAmount(n: number): string {
  return (Math.round(n * 100) / 100).toFixed(2);
}

function formatIsoWithMadridOffset(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) throw new Error(`Invalid date: ${iso}`);
  const month = d.getUTCMonth() + 1;
  const day = d.getUTCDate();
  const dst = month > 3 && month < 10
    ? true
    : month === 3
      ? day >= 29
      : month === 10
        ? day <= 25
        : false;
  const offsetMinutes = dst ? 120 : 60;
  const adjusted = new Date(d.getTime() + offsetMinutes * 60_000);
  const yyyy = adjusted.getUTCFullYear();
  const mm = String(adjusted.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(adjusted.getUTCDate()).padStart(2, "0");
  const hh = String(adjusted.getUTCHours()).padStart(2, "0");
  const mi = String(adjusted.getUTCMinutes()).padStart(2, "0");
  const ss = String(adjusted.getUTCSeconds()).padStart(2, "0");
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const oh = String(Math.floor(Math.abs(offsetMinutes) / 60)).padStart(2, "0");
  const om = String(Math.abs(offsetMinutes) % 60).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}T${hh}:${mi}:${ss}${sign}${oh}:${om}`;
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
  const hash = createHash("sha256").update(canonical, "utf-8").digest("hex").toUpperCase();
  return { canonical, hash };
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
