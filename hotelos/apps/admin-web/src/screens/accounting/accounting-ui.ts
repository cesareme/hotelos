// Contabilidad · pure helpers shared by the Cocoa 22 finance screens of the
// lote 6-C (Diario, Mayor, Plan de cuentas, Ajustes, Exportar a gestoría,
// estados contables). No JSX: this module is not a screen (the discoverability
// walker and the Cocoa contract only read `.tsx`), so it can hold the Spanish
// vocabularies, the chart-of-accounts option builders, the money parsing of
// the manual entry form and the blob download every screen of the lot repeats
// (the «Ámbito» of a money screen lives in services/financeScope.ts since L7).
//
// Formatting still goes through lib/format (money · number · date); nothing
// here formats a figure on its own.

import type { ChartAccountView, JournalEntryView } from "@hotelos/shared";
import type { CocoaSelectOption } from "../../components/cocoa";
import type { CocoaTone } from "../../components/cocoa";
import type { NamedDownload } from "../../services/accountingApi";
import { isoDate } from "../../lib/format";
import type { NavGateState } from "../../navigation/useEnabledModules";

// Actor labels (`createdBy` → «Sistema · re-proyección contable» / «por …»)
// live in ./actor-label.ts (pure, unit-tested) and are re-exported here so the
// screens keep a single import.
export { actorHint, actorLabel, isSystemActor, SYSTEM_ACTOR_LABELS, type ActorLabel, type ActorSession } from "./actor-label";

// ---------------------------------------------------------------------------
// Downloads
// ---------------------------------------------------------------------------

/** Saves a blob the API named (CSV · PDF · XLSX) through a transient anchor. */
export function saveDownload(file: NamedDownload): void {
  if (typeof document === "undefined") return;
  const url = URL.createObjectURL(file.blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = file.filename;
  anchor.rel = "noopener";
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

// ---------------------------------------------------------------------------
// Vocabularies (JournalEntry.sourceType · status · Account.kind)
// ---------------------------------------------------------------------------

export const SOURCE_TYPE_LABELS: Readonly<Record<string, string>> = Object.freeze({
  folio_line: "Cargo en folio",
  payment: "Cobro",
  payment_refund: "Devolución de cobro",
  invoice: "Factura emitida",
  invoice_rectification: "Factura rectificativa",
  invoice_cancellation: "Anulación de factura",
  pos_ticket: "Venta del punto de venta",
  supplier_bill: "Factura recibida",
  supplier_bill_payment: "Pago a proveedor",
  expense: "Gasto",
  payroll_slip: "Nómina",
  payroll_payment: "Pago de nómina",
  commission: "Comisión",
  commission_settlement: "Liquidación de comisión",
  depreciation: "Amortización",
  vat_settlement: "Liquidación del IVA",
  cash_closure: "Cierre de caja",
  card_settlement: "Liquidación de datáfono",
  tourist_tax: "Tasa turística",
  manual: "Asiento manual",
  regularization: "Regularización",
  closing: "Cierre del ejercicio",
  opening: "Apertura del ejercicio",
  reversal: "Anulación",
  fixed_asset_disposal: "Baja de inmovilizado"
});

/** Filter options of the diario, in the order the hotelier reads them. */
export const SOURCE_TYPE_OPTIONS: readonly CocoaSelectOption[] = Object.entries(SOURCE_TYPE_LABELS).map(([value, label]) => ({ value, label }));

export function sourceTypeLabel(sourceType: string | null | undefined): string {
  if (!sourceType) return "—";
  return SOURCE_TYPE_LABELS[sourceType] ?? sourceType.replace(/_/g, " ");
}

export type EntryBadge = { label: string; tone: CocoaTone };

/** Status pill of an entry: a reversal entry says so; a reversed original says «Anulado». */
export function entryStatusBadge(entry: Pick<JournalEntryView, "status" | "entryKind" | "reversedById" | "reversalOfId">): EntryBadge {
  if (entry.status === "draft") return { label: "Borrador", tone: "neutral" };
  if (entry.reversedById || entry.status === "reversed") return { label: "Anulado", tone: "danger" };
  if (entry.entryKind === "reversal" || entry.reversalOfId) return { label: "Asiento de anulación", tone: "info" };
  if (entry.entryKind === "closing") return { label: "Cierre", tone: "warning" };
  if (entry.entryKind === "opening") return { label: "Apertura", tone: "warning" };
  if (entry.entryKind === "regularization") return { label: "Regularización", tone: "warning" };
  return { label: "Contabilizado", tone: "success" };
}

export const ENTRY_STATUS_OPTIONS: readonly CocoaSelectOption[] = [
  { value: "posted", label: "Contabilizados" },
  { value: "reversed", label: "Anulados" },
  { value: "draft", label: "Borradores" }
];

export const KIND_LABELS: Readonly<Record<string, string>> = Object.freeze({
  asset: "Activo",
  liability: "Pasivo",
  equity: "Patrimonio neto",
  income: "Ingresos",
  revenue: "Ingresos",
  expense: "Gastos"
});

export function kindLabel(kind: string | null | undefined): string {
  if (!kind) return "—";
  return KIND_LABELS[kind] ?? kind;
}

export function kindTone(kind: string | null | undefined): CocoaTone {
  switch (kind) {
    case "asset":
      return "info";
    case "liability":
      return "warning";
    case "equity":
      return "accent";
    case "income":
    case "revenue":
      return "success";
    case "expense":
      return "danger";
    default:
      return "neutral";
  }
}

export const KIND_OPTIONS: readonly CocoaSelectOption[] = [
  { value: "asset", label: "Activo" },
  { value: "liability", label: "Pasivo" },
  { value: "equity", label: "Patrimonio neto" },
  { value: "income", label: "Ingresos" },
  { value: "expense", label: "Gastos" }
];

/** PGC groups 1-7 (Pymes) with their official names. */
export const PGC_GROUP_LABELS: Readonly<Record<number, string>> = Object.freeze({
  1: "Financiación básica",
  2: "Activo no corriente",
  3: "Existencias",
  4: "Acreedores y deudores por operaciones comerciales",
  5: "Cuentas financieras",
  6: "Compras y gastos",
  7: "Ventas e ingresos"
});

export const PGC_GROUP_OPTIONS: readonly CocoaSelectOption[] = Object.entries(PGC_GROUP_LABELS).map(([value, label]) => ({ value, label: `${value} · ${label}` }));

export const MONTH_OPTIONS: readonly CocoaSelectOption[] = ["Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio", "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre"].map((label, index) => ({ value: String(index + 1), label }));

export const VAT_PERIODICITY_OPTIONS: readonly CocoaSelectOption[] = [
  { value: "quarterly", label: "Trimestral (régimen general)" },
  { value: "monthly", label: "Mensual (REDEME o gran empresa)" }
];

export const VAT_REGIME_OPTIONS: readonly CocoaSelectOption[] = [
  { value: "general", label: "Régimen general" },
  { value: "redeme", label: "Devolución mensual (REDEME)" },
  { value: "recargo", label: "Recargo de equivalencia" }
];

export const TAX_FIGURE_OPTIONS: readonly CocoaSelectOption[] = [
  { value: "IVA", label: "IVA (península y Baleares)" },
  { value: "IGIC", label: "IGIC (Canarias)" },
  { value: "IPSI", label: "IPSI (Ceuta y Melilla)" }
];

export function vatPeriodicityLabel(value: string): string {
  return value === "monthly" ? "Mensual" : "Trimestral";
}

export function vatRegimeLabel(value: string): string {
  return VAT_REGIME_OPTIONS.find((option) => option.value === value)?.label ?? value;
}

// ---------------------------------------------------------------------------
// Chart of accounts → select options (hierarchy by parentCode / level)
// ---------------------------------------------------------------------------

const INDENT = "  ";

export function accountOptionLabel(account: Pick<ChartAccountView, "code" | "name" | "level">, indent = true): string {
  const depth = indent ? Math.max(0, account.level - 1) : 0;
  return `${INDENT.repeat(depth)}${account.code} · ${account.name}`;
}

/**
 * Options of an account picker. Headers (`isPostable = false`) are listed
 * disabled so the hierarchy reads (grupo → subgrupo → cuenta → subcuenta) but
 * only postable accounts can be chosen; `postableOnly` drops the headers.
 */
export function chartSelectOptions(accounts: readonly ChartAccountView[], options: { postableOnly?: boolean; filter?: string } = {}): CocoaSelectOption[] {
  const needle = (options.filter ?? "").trim().toLowerCase();
  const sorted = [...accounts].sort((a, b) => a.code.localeCompare(b.code, "es"));
  const out: CocoaSelectOption[] = [];
  for (const account of sorted) {
    if (options.postableOnly && !account.isPostable) continue;
    if (needle && !`${account.code} ${account.name}`.toLowerCase().includes(needle)) continue;
    out.push({ value: account.code, label: accountOptionLabel(account, !needle), disabled: !account.isPostable });
  }
  return out;
}

/** «4300 · Clientes (euros)» of a code, or the code itself when the chart is not loaded. */
export function accountDisplay(accounts: readonly ChartAccountView[], code: string): string {
  const account = accounts.find((candidate) => candidate.code === code);
  return account ? `${account.code} · ${account.name}` : code;
}

// ---------------------------------------------------------------------------
// Money input of the manual entry (cents, never floats in the payload)
// ---------------------------------------------------------------------------

/** "1.234,56" · "1234.56" · "12" → cents (123456 · 123456 · 1200); null when empty; NaN when malformed. */
export function parseMoneyInput(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  // Spanish typing: thousands with dot, decimals with comma. A single dot with
  // two digits after it is read as the decimal separator ("12.50").
  let normalized = trimmed.replace(/\s/g, "");
  if (normalized.includes(",")) normalized = normalized.replace(/\./g, "").replace(",", ".");
  else if (/^\d{1,3}(\.\d{3})+$/.test(normalized)) normalized = normalized.replace(/\./g, "");
  if (!/^-?\d+(\.\d{1,2})?$/.test(normalized)) return Number.NaN;
  const [whole, fraction = ""] = normalized.replace("-", "").split(".");
  const cents = Number(whole) * 100 + Number((fraction + "00").slice(0, 2));
  return normalized.startsWith("-") ? -cents : cents;
}

/** 123456 → "1234.56" (the MoneyString the API accepts). */
export function centsToMoneyString(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

/** Numeric value of a MoneyString for painting through lib/format (never for arithmetic). */
export function moneyStringToNumber(value: string | null | undefined): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Tone of a signed figure: success when positive, danger when negative, neutral at zero. */
export function signTone(value: string | number | null | undefined): CocoaTone {
  const parsed = typeof value === "number" ? value : moneyStringToNumber(value);
  if (parsed === null || parsed === 0) return "neutral";
  return parsed > 0 ? "success" : "danger";
}

// ---------------------------------------------------------------------------
// Query string, permissions and property scope
// ---------------------------------------------------------------------------

/** `?cuenta=705.1` of the current URL (deep links between Diario, Mayor y Plan de cuentas). */
export function readQueryParam(name: string): string | null {
  if (typeof window === "undefined") return null;
  const value = new URLSearchParams(window.location.search).get(name);
  return value && value.trim() ? value.trim() : null;
}

/** `#<id>` of the current URL: the `navigateTo("JournalScreen", journalEntryId)` deep link of the TPV and cash-closure screens. */
export function readHashParam(): string | null {
  if (typeof window === "undefined") return null;
  const value = window.location.hash.replace(/^#/, "").trim();
  if (!value) return null;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Path + query for a deep link, dropping empty values. */
export function withQuery(path: string, params: Record<string, string | null | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== null && value !== undefined && value !== "") search.set(key, value);
  }
  const query = search.toString();
  return query ? `${path}?${query}` : path;
}

/**
 * The session may run an action when its granted permissions include the key.
 * Unknown permissions (profile still loading) do not hide the action: the API
 * answers 403 with a Spanish message if it must.
 */
export function canDo(gate: Pick<NavGateState, "grantedPermissions" | "isPlatformAdmin">, permission: string): boolean {
  if (gate.isPlatformAdmin) return true;
  if (gate.grantedPermissions === null) return true;
  return gate.grantedPermissions.includes(permission);
}

/** Calendar day of today in the hotel's zone (Europe/Madrid), for default filters. */
export function todayIso(): string {
  return isoDate(new Date()) ?? new Date().toISOString().slice(0, 10);
}

export function firstDayOfYear(iso: string = todayIso()): string {
  return `${iso.slice(0, 4)}-01-01`;
}

export function lastDayOfYear(iso: string = todayIso()): string {
  return `${iso.slice(0, 4)}-12-31`;
}
