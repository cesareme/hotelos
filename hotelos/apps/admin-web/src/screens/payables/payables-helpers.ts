// Proveedores, gastos e inmovilizado · PURE helpers of the lot (Tanda 6 ·
// Finanzas · lote 6-E): labels and tones of the wire enums, decimal parsing of
// the string-controlled Cocoa inputs, calendar helpers, the inline attachment
// reader (≤ 512 KiB, PDF/JPEG/PNG), account-picker filters and the failure
// describer. Since Tanda T9 (lote T9-11) also the origin and match vocabularies
// of a supplier bill (`source` · `matchStatus`), `openBillAttachment` (inline
// base64 as before, or the binary of the digitised document by its
// `downloadPath`, with the network and the window injected) and
// `billApprovalBlock` (which gate stopped an approval and what the screen can
// offer: supervisor PIN, match, nothing). No React, no api-client:
// screens/payables/__tests__ runs this file under `node --test`; the hooks live
// in payables-shared.ts.

import type { ExpensePaidWith, FixedAssetCategory, FixedAssetStatus, InlineAttachment, RetentionRowCode, SupplierBillMatchStatus, SupplierBillSource, SupplierBillStatus } from "@hotelos/shared";
import { FIXED_ASSET_MAX_COEFFICIENT_PCT } from "@hotelos/shared";
import type { ChartAccountView } from "@hotelos/shared";
import { financeErrorCode, financeErrorDetails, financeErrorMessage } from "../../services/finance-contracts";
import { openBlob } from "../../components/billing/download";
import { date, isoDate, percent, toNumber } from "../../lib/format";
import { STATUS_LABELS } from "../../content/actions";
import type { CocoaTone } from "../../components/cocoa/cocoa-tones";

// ---------------------------------------------------------------------------
// Labels and tones of the wire enums
// ---------------------------------------------------------------------------

export const BILL_STATUS_LABELS: Record<SupplierBillStatus, string> = {
  draft: STATUS_LABELS.draft,
  approved: "Aprobada",
  posted: "Contabilizada",
  paid: "Pagada",
  cancelled: "Anulada"
};

export const BILL_STATUS_TONES: Record<SupplierBillStatus, CocoaTone> = {
  draft: "neutral",
  approved: "info",
  posted: "accent",
  paid: "success",
  cancelled: "danger"
};

/** Origen de la factura (Tanda T9, `SupplierBill.source`): alta manual, digitalizada desde un documento, factura electrónica. */
export const BILL_SOURCE_LABELS: Record<SupplierBillSource, string> = {
  manual: "Manual",
  digitized: "Digitalizada",
  e_invoice: "e-factura"
};

export const BILL_SOURCE_TONES: Record<SupplierBillSource, CocoaTone> = { manual: "neutral", digitized: "info", e_invoice: "accent" };

/** Cotejo con albaranes (`SupplierBill.matchStatus`): sin cotejar · parcial · completo · diferencias fuera de tolerancia. */
export const BILL_MATCH_LABELS: Record<SupplierBillMatchStatus, string> = {
  none: "Sin cotejar",
  partial: "Parcial",
  full: "Completo",
  variance: "Diferencias"
};

export const BILL_MATCH_TONES: Record<SupplierBillMatchStatus, CocoaTone> = { none: "neutral", partial: "warning", full: "success", variance: "danger" };

/** Label of a wire `source`; an unknown value (older API) reads as manual. */
export function billSourceLabel(source: string | null | undefined): string {
  return (source && (BILL_SOURCE_LABELS as Record<string, string>)[source]) || BILL_SOURCE_LABELS.manual;
}

export function billSourceTone(source: string | null | undefined): CocoaTone {
  return (source && (BILL_SOURCE_TONES as Record<string, CocoaTone>)[source]) || BILL_SOURCE_TONES.manual;
}

/** Label of a wire `matchStatus`; an unknown value (older API) reads as «Sin cotejar». */
export function billMatchLabel(status: string | null | undefined): string {
  return (status && (BILL_MATCH_LABELS as Record<string, string>)[status]) || BILL_MATCH_LABELS.none;
}

export function billMatchTone(status: string | null | undefined): CocoaTone {
  return (status && (BILL_MATCH_TONES as Record<string, CocoaTone>)[status]) || BILL_MATCH_TONES.none;
}

export const PAID_WITH_LABELS: Record<ExpensePaidWith, string> = { cash: "Efectivo", card: "Tarjeta", bank: "Banco" };

/** Default counter account of each payment means (mirrors expenses.service.ts EXPENSE_COUNTER_ACCOUNTS). */
export const PAID_WITH_DEFAULT_ACCOUNT: Record<ExpensePaidWith, "570" | "5721" | "572"> = { cash: "570", card: "5721", bank: "572" };

export const EXPENSE_COUNTER_ACCOUNT_OPTIONS: Array<{ value: "570" | "572" | "5721" | "5722"; label: string }> = [
  { value: "570", label: "570 · Caja" },
  { value: "572", label: "572 · Bancos" },
  { value: "5721", label: "5721 · Tarjeta de empresa" },
  { value: "5722", label: "5722 · Tarjeta (otra cuenta)" }
];

export const ASSET_CATEGORY_LABELS: Record<FixedAssetCategory, string> = {
  mobiliario: "Mobiliario",
  instalaciones: "Instalaciones técnicas",
  informatica: "Equipos informáticos",
  construcciones: "Construcciones",
  vehiculos: "Vehículos",
  intangible: "Inmovilizado intangible",
  otro: "Otro inmovilizado"
};

export const ASSET_STATUS_LABELS: Record<FixedAssetStatus, string> = {
  active: STATUS_LABELS.active,
  fully_depreciated: "Amortizado",
  disposed: "Dado de baja"
};

export const ASSET_STATUS_TONES: Record<FixedAssetStatus, CocoaTone> = { active: "success", fully_depreciated: "neutral", disposed: "danger" };

export const RUN_STATUS_LABELS: Record<string, string> = { posted: "Contabilizada", reversed: "Revertida", draft: STATUS_LABELS.draft, preview: "Vista previa" };
export const RUN_STATUS_TONES: Record<string, CocoaTone> = { posted: "success", reversed: "danger", draft: "neutral", preview: "info" };

/** Max annual coefficient (%) of a category as a formatted label («10 %»). */
export function maxCoefficientLabel(category: FixedAssetCategory): string {
  return percent(FIXED_ASSET_MAX_COEFFICIENT_PCT[category], { maximumFractionDigits: 0 });
}

export const RETENTION_ROW_OPTIONS: Array<{ value: RetentionRowCode; label: string }> = [
  { value: "02", label: "Profesionales · modelo 111 (casilla 02)" },
  { value: "03", label: "Actividades agrarias · modelo 111 (casilla 03)" },
  { value: "L01", label: "Arrendamientos urbanos · modelo 115" }
];

/** VAT rates the API accepts (21 · 10 · 4 · 0 and the IGIC 7 · 3 · 2). */
export const TAX_RATE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "21", label: percent(21, { maximumFractionDigits: 0 }) },
  { value: "10", label: percent(10, { maximumFractionDigits: 0 }) },
  { value: "4", label: percent(4, { maximumFractionDigits: 0 }) },
  { value: "0", label: `${percent(0, { maximumFractionDigits: 0 })} · exento o no sujeto` },
  { value: "7", label: `${percent(7, { maximumFractionDigits: 0 })} · IGIC` },
  { value: "3", label: `${percent(3, { maximumFractionDigits: 0 })} · IGIC` },
  { value: "2", label: `${percent(2, { maximumFractionDigits: 0 })} · IGIC` }
];

export const PAYABLE_ACCOUNT_OPTIONS: Array<{ value: "" | "400" | "410" | "4100" | "4109"; label: string }> = [
  { value: "", label: "Automática (400 compras · 410 servicios)" },
  { value: "400", label: "400 · Proveedores" },
  { value: "410", label: "410 · Acreedores por prestación de servicios" },
  { value: "4100", label: "4100 · Acreedores (euros)" },
  { value: "4109", label: "4109 · Acreedores, facturas pendientes de recibir" }
];

// ---------------------------------------------------------------------------
// Decimals and dates of string-controlled inputs
// ---------------------------------------------------------------------------

const DECIMAL_2 = /^-?\d+(?:\.\d{1,2})?$/;

/**
 * Normalise what the user typed in a decimal input («1.234,56», «12,5», «12.5»)
 * to the wire string with 2 decimals («1234.56»); null when it is not a number
 * with at most 2 decimals (the API answers 400 VALIDATION_ERROR otherwise).
 */
export function decimalInput(raw: string): string | null {
  const text = raw.trim();
  if (!text) return null;
  // «1.234,56» → «1234.56»; «12,5» → «12.5»; «12.5» stays.
  const normalised = text.includes(",") ? text.replace(/\./g, "").replace(",", ".") : text;
  if (!DECIMAL_2.test(normalised)) return null;
  const value = Number(normalised);
  return Number.isFinite(value) ? to2(value) : null;
}

/** Number → wire string with exactly 2 decimals (half-up to the cent). */
export function to2(value: number): string {
  return (Math.round(value * 100) / 100).toFixed(2);
}

/** Number of a decimal wire string or user input; 0 when empty or invalid. */
export function amountOf(raw: string | null | undefined): number {
  return toNumber(decimalInput(raw ?? "") ?? raw ?? null) ?? 0;
}

/** Cent-rounded quota of a base at a percent rate (what the API computes per line). */
export function quotaOf(base: number, ratePct: number): number {
  return Math.round(base * ratePct) / 100;
}

/** Today's calendar day in Madrid («2026-09-16»). */
export function todayIso(): string {
  return isoDate(new Date()) ?? new Date().toISOString().slice(0, 10);
}

/** `days` after a calendar day (pure UTC arithmetic, no time-zone slide). */
export function addDays(day: string, days: number): string {
  const [y, m, d] = day.split("-").map(Number);
  const next = new Date(Date.UTC(y, m - 1, d + days));
  return `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, "0")}-${String(next.getUTCDate()).padStart(2, "0")}`;
}

/** «2026-08» of the month before the given day (default today): the usual month to depreciate. */
export function previousMonthPeriod(day = todayIso()): string {
  const [y, m] = day.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 2, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** «ago 2026» of a «2026-08» period; the code itself when malformed. */
export function periodLabel(period: string): string {
  return /^\d{4}-\d{2}$/.test(period) ? date(`${period}-01`, "monthYear") : period;
}

export const PERIOD_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

// ---------------------------------------------------------------------------
// Inline attachments (≤ 512 KiB PDF / JPEG / PNG, base64 in the request)
// ---------------------------------------------------------------------------

export const ATTACHMENT_MAX_BYTES = 512 * 1024;
export const ATTACHMENT_ACCEPT = "application/pdf,image/jpeg,image/png";
const ATTACHMENT_MIME = new Set(["application/pdf", "image/jpeg", "image/png"]);

/** Spanish reason a file cannot travel as an inline attachment, or null when it can. */
export function attachmentRejection(file: { type: string; size: number }): string | null {
  if (!ATTACHMENT_MIME.has(file.type)) return "El adjunto debe ser un PDF, una imagen JPEG o una imagen PNG.";
  if (file.size > ATTACHMENT_MAX_BYTES) return "El adjunto supera los 512 KiB: comprímelo o guárdalo fuera y anota la referencia.";
  return null;
}

/** Base64 payload of a `data:` URL produced by FileReader.readAsDataURL (the raw string when it has no prefix). */
export function base64OfDataUrl(dataUrl: string): string {
  const comma = dataUrl.indexOf(",");
  return comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
}

/**
 * Open the browser file picker from a CocoaButton (there is no Cocoa file
 * control yet; a raw `<input type="file">` in a screen counts as inventory debt).
 * Resolves null when the user dismisses the dialog.
 */
export function pickFile(accept = ATTACHMENT_ACCEPT): Promise<File | null> {
  return new Promise((resolve) => {
    if (typeof document === "undefined") {
      resolve(null);
      return;
    }
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.onchange = () => resolve(input.files?.[0] ?? null);
    input.oncancel = () => resolve(null);
    input.click();
  });
}

/** Read a picked file as the inline attachment of the request; rejects with a Spanish Error when it is not admissible. */
export function readAttachment(file: File): Promise<InlineAttachment> {
  const rejection = attachmentRejection(file);
  if (rejection) return Promise.reject(new Error(rejection));
  const mimeType = file.type as InlineAttachment["mimeType"];
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("No se pudo leer el archivo."));
    reader.onload = () => {
      const base64 = base64OfDataUrl(typeof reader.result === "string" ? reader.result : "");
      if (!base64) {
        reject(new Error("El archivo está vacío."));
        return;
      }
      resolve({ fileName: file.name, mimeType, base64 });
    };
    reader.readAsDataURL(file);
  });
}

/** Open an inline attachment (base64 + mime) in a new tab through an object URL. */
export function openInlineAttachment(base64: string, mimeType: string): boolean {
  if (typeof window === "undefined") return false;
  try {
    const bytes = atob(base64);
    const buffer = new Uint8Array(bytes.length);
    for (let i = 0; i < bytes.length; i += 1) buffer[i] = bytes.charCodeAt(i);
    const url = URL.createObjectURL(new Blob([buffer], { type: mimeType }));
    const opened = window.open(url, "_blank", "noopener");
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    return opened !== null;
  } catch {
    return false;
  }
}

/** What GET …/supplier-bills/:id/attachment answers (payablesApi.SupplierBillAttachment), as far as opening it needs. */
export type BillAttachmentLike = {
  inline: boolean;
  base64?: string | null;
  mimeType?: string | null;
  /** Tanda T9 (T9-08): binary route of the digitised document (`GET …/documents/:id/file`). */
  downloadPath?: string | null;
  documentObjectKey?: string | null;
};

/** Where the bytes of an attachment come from: the JSON itself (inline base64), the binary route of the document, or nowhere. */
export type BillAttachmentSource = "inline" | "download" | "none";

export function billAttachmentSource(attachment: BillAttachmentLike): BillAttachmentSource {
  if (attachment.inline && attachment.base64 && attachment.mimeType) return "inline";
  if (attachment.downloadPath) return "download";
  return "none";
}

export type OpenBillAttachmentDeps = {
  /** Fetches the binary of `downloadPath` (the screen passes payablesApi.downloadSupplierBillAttachment). */
  fetchBlob: (downloadPath: string) => Promise<Blob>;
  /** Opens a Blob in a new tab; false when the browser blocked the window (default: components/billing/download openBlob). */
  openBlob?: (blob: Blob) => boolean;
  /** Opens an inline base64 attachment (default: openInlineAttachment). */
  openInline?: (base64: string, mimeType: string) => boolean;
};

export type OpenBillAttachmentResult = { source: BillAttachmentSource; opened: boolean };

/**
 * Open the attachment of a supplier bill: an inline one (≤ 512 KiB, base64 in
 * the JSON) as before; a digitised one (Tanda T9) by its `downloadPath`
 * (`?inline=1`, audited DOCUMENT_DOWNLOADED) as a Blob in a new tab. `opened`
 * is false when the browser blocked the window; `source: "none"` when the
 * bill has no attachment the browser can show (the screen says so).
 */
export async function openBillAttachment(attachment: BillAttachmentLike, deps: OpenBillAttachmentDeps): Promise<OpenBillAttachmentResult> {
  const source = billAttachmentSource(attachment);
  if (source === "inline") return { source, opened: (deps.openInline ?? openInlineAttachment)(attachment.base64!, attachment.mimeType!) };
  if (source === "download") {
    const blob = await deps.fetchBlob(attachment.downloadPath!);
    return { source, opened: (deps.openBlob ?? openBlob)(blob) };
  }
  return { source, opened: false };
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type PayablesFailure = { code: string | null; message: string };

/** Spanish message + `details.code` of a payables / assets failure (a plain Error keeps its message). */
export function describeFailure(error: unknown, fallback: string): PayablesFailure {
  return { code: financeErrorCode(error), message: financeErrorMessage(error, fallback) };
}

/** Gates of POST …/supplier-bills/:id/approve the screen can act on (Tanda 8a RBAC · Tanda T9 §7.1). */
export type BillApprovalBlockCode = "RBAC_LEVEL_EXCEEDED" | "RBAC_SOD_CONFLICT" | "SUPPLIER_BILL_MATCH_REQUIRED";

export type BillApprovalBlock = {
  code: BillApprovalBlockCode;
  /** Spanish sentence with the tiers, the pending request or the match reason. */
  message: string;
  /** What the drawer offers: the supervisor PIN (lifts the tier), the match with the receipts, or nothing (SoD is decided by the API). */
  action: "supervisor" | "match" | null;
  tier: string | null;
  maxTier: string | null;
  /** Pending approval request the engine already holds (Hoy › Pendientes de aprobación), when the API names it. */
  requestId: string | null;
};

/** The approval gate behind a failed approve, or null when the failure is something else (shown through describeFailure). */
export function billApprovalBlock(error: unknown): BillApprovalBlock | null {
  const code = financeErrorCode(error);
  if (code !== "RBAC_LEVEL_EXCEEDED" && code !== "RBAC_SOD_CONFLICT" && code !== "SUPPLIER_BILL_MATCH_REQUIRED") return null;
  const details = financeErrorDetails(error);
  const text = (key: string): string | null => {
    const value = details?.[key];
    return typeof value === "string" && value.trim() ? value.trim() : null;
  };
  return {
    code,
    message: financeErrorMessage(error, "La aprobación necesita autorización."),
    action: code === "RBAC_LEVEL_EXCEEDED" ? "supervisor" : code === "SUPPLIER_BILL_MATCH_REQUIRED" ? "match" : null,
    tier: text("tier"),
    maxTier: text("maxTier"),
    requestId: text("requestId")
  };
}

// ---------------------------------------------------------------------------
// Chart of accounts filters for the pickers (postable accounts only)
// ---------------------------------------------------------------------------

export type AccountOption = { value: string; label: string };

/** «629 · Otros servicios» options of the postable accounts that pass `filter`, sorted by code. */
export function accountOptions(accounts: readonly ChartAccountView[], filter: (code: string) => boolean): AccountOption[] {
  return accounts
    .filter((a) => a.isPostable && filter(a.code))
    .sort((a, b) => a.code.localeCompare(b.code))
    .map((a) => ({ value: a.code, label: `${a.code} · ${a.name}` }));
}

/** Group 6 (expenses and purchases). */
export const isExpenseAccount = (code: string): boolean => /^6\d/.test(code);
/** 20x intangible · 21x tangible (investment goods). */
export const isInvestmentAccount = (code: string): boolean => /^2[01]\d/.test(code);
/** 57x cash and banks (payment counter accounts). */
export const isTreasuryAccount = (code: string): boolean => /^57\d/.test(code);

/** Name of an account code in the loaded chart, or the code alone. */
export function accountLabel(accounts: readonly ChartAccountView[], code: string | null | undefined): string {
  if (!code) return "—";
  const hit = accounts.find((a) => a.code === code);
  return hit ? `${hit.code} · ${hit.name}` : code;
}
