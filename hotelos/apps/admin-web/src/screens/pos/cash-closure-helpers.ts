// Cierre de caja (arqueo) — pure helpers of screens/pos/CashClosureScreen.tsx
// (Tanda 6 · lote 6-E). No React, no network, no import.meta: the unit test
// screens/pos/__tests__/cash-closure-helpers.test.mts runs this file under
// `node --test`.
//
// Money on the closure wire travels as decimal strings ("118.00", see
// packages/shared/src/pos-types.ts): every sum here works in integer cents so a
// count typed by a cashier round-trips exactly, and the strings only become
// numbers to be painted (lib/format money()).

import type { CashClosureCloseRequest, CashClosureStatus, CashClosureWire, CashMethod, CashMethodFigures } from "@hotelos/shared";
import type { CocoaTone } from "../../components/cocoa/cocoa-tones";
import { toNumber } from "../../lib/format";

/** Canonical methods in counting order (mirror of CASH_METHODS in packages/shared/src/pos-types.ts; type-only import keeps it aligned). */
export const CASH_METHODS: readonly CashMethod[] = Object.freeze(["cash", "card_terminal", "card_online", "bank_transfer", "payment_link", "other"]);

/** Spanish label of a canonical payment method (PaymentMethod enum) as counted in a closure. */
export const CASH_METHOD_LABELS: Readonly<Record<CashMethod, string>> = Object.freeze({
  cash: "Efectivo",
  card_terminal: "Tarjeta (datáfono)",
  card_online: "Tarjeta en línea",
  bank_transfer: "Transferencia",
  payment_link: "Enlace de pago",
  other: "Otros"
});

/** Label of any payment method string (legacy free text included): the dictionary entry or the raw value. */
export function paymentMethodLabel(method: string): string {
  const key = method.trim().toLowerCase();
  if (key in CASH_METHOD_LABELS) return CASH_METHOD_LABELS[key as CashMethod];
  switch (key) {
    case "card":
    case "tarjeta":
    case "datafono":
    case "datáfono":
      return CASH_METHOD_LABELS.card_terminal;
    case "efectivo":
      return CASH_METHOD_LABELS.cash;
    case "transfer":
    case "transferencia":
      return CASH_METHOD_LABELS.bank_transfer;
    default:
      return method;
  }
}

export const CLOSURE_STATUS_LABELS: Readonly<Record<CashClosureStatus, string>> = Object.freeze({
  open: "Abierta",
  closed: "Cerrada",
  approved: "Aprobada"
});

export function closureStatusLabel(status: string): string {
  return status in CLOSURE_STATUS_LABELS ? CLOSURE_STATUS_LABELS[status as CashClosureStatus] : status;
}

/** Badge tone of a closure status: open counts still pending (warning), closed awaits sign-off (info), approved is done (success). */
export function closureStatusTone(status: string): CocoaTone {
  switch (status) {
    case "open":
      return "warning";
    case "closed":
      return "info";
    case "approved":
      return "success";
    default:
      return "neutral";
  }
}

/** Reception cash of the whole property (`outletId: "*"`). */
export const RECEPTION_OUTLET = "*";

/** «Recepción» for the property-wide closure, the outlet name otherwise (its board id as a last resort). */
export function closureOutletLabel(closure: Pick<CashClosureWire, "outletId" | "outletName">): string {
  if (closure.outletId === RECEPTION_OUTLET) return "Recepción";
  return closure.outletName?.trim() || closure.outletId;
}

// ── cents arithmetic ─────────────────────────────────────────────────────────

/** Decimal string or number → integer cents (null for a blank or non-finite value: "" is «not counted», never 0). */
export function toCents(value: string | number | null | undefined): number | null {
  if (typeof value === "string" && value.trim() === "") return null;
  const parsed = toNumber(value);
  if (parsed === null) return null;
  return Math.round(parsed * 100);
}

/** Integer cents → decimal string with two places ("-3.50", "0.00"). */
export function fromCents(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

/**
 * Amount typed by a cashier ("118,50", "118.50", "", "  ") → decimal string
 * with two places; "" counts as 0 (a method not counted is 0 on the API too).
 * Null when the text is not a non-negative amount.
 */
export function parseCountedAmount(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed === "") return "0.00";
  const cents = toCents(trimmed);
  if (cents === null || cents < 0) return null;
  return fromCents(cents);
}

// ── denominations ────────────────────────────────────────────────────────────

/** Euro notes and coins, largest first; face values as decimal strings (the API accepts strings byte for byte). */
export const EUR_DENOMINATIONS: readonly string[] = Object.freeze(["500", "200", "100", "50", "20", "10", "5", "2", "1", "0.50", "0.20", "0.10", "0.05", "0.02", "0.01"]);

export type DenominationQuantities = Readonly<Record<string, number>>;

/** Σ face × quantity of a physical count, as a decimal string ("0.00" for an empty count). */
export function sumDenominations(quantities: DenominationQuantities): string {
  let total = 0;
  for (const [denomination, quantity] of Object.entries(quantities)) {
    const face = toCents(denomination);
    if (face === null || !Number.isInteger(quantity) || quantity <= 0) continue;
    total += face * quantity;
  }
  return fromCents(total);
}

/** Rows to send as `counts` (only denominations with a positive quantity, largest first). */
export function denominationRows(quantities: DenominationQuantities): Array<{ denomination: string; quantity: number }> {
  return EUR_DENOMINATIONS.filter((d) => (quantities[d] ?? 0) > 0).map((d) => ({ denomination: d, quantity: quantities[d] }));
}

// ── differences ──────────────────────────────────────────────────────────────

export type DifferenceKind = "balanced" | "surplus" | "shortage" | "pending";

/** Sign of a difference string: positive = sobrante, negative = faltante, null = not counted yet. */
export function differenceKind(difference: string | null | undefined): DifferenceKind {
  const cents = toCents(difference ?? null);
  if (cents === null) return "pending";
  if (cents === 0) return "balanced";
  return cents > 0 ? "surplus" : "shortage";
}

export const DIFFERENCE_LABELS: Readonly<Record<DifferenceKind, string>> = Object.freeze({
  balanced: "Cuadra",
  surplus: "Sobrante",
  shortage: "Faltante",
  pending: "Sin recuento"
});

export function differenceTone(difference: string | null | undefined): CocoaTone {
  switch (differenceKind(difference)) {
    case "balanced":
      return "success";
    case "surplus":
      return "warning";
    case "shortage":
      return "danger";
    default:
      return "neutral";
  }
}

export type CountedByMethod = Readonly<Record<CashMethod, string>>;

export type MethodPreview = { method: CashMethod; expected: string; counted: string | null; difference: string | null };

/**
 * Per-method figures to paint: for an open closure the expected amounts stored
 * at opening and the amounts typed so far (counted/difference null when the
 * text is not an amount); for a closed/approved one the figures the API signed.
 */
export function methodPreview(closure: Pick<CashClosureWire, "status" | "byMethod">, typed?: CountedByMethod): MethodPreview[] {
  return CASH_METHODS.map((method) => {
    const figures: CashMethodFigures = closure.byMethod[method] ?? { expected: "0.00", counted: null, difference: null };
    if (closure.status !== "open" || !typed) return { method, expected: figures.expected, counted: figures.counted, difference: figures.difference };
    const counted = parseCountedAmount(typed[method] ?? "");
    const expected = toCents(figures.expected) ?? 0;
    const countedCents = counted === null ? null : toCents(counted);
    return { method, expected: figures.expected, counted, difference: countedCents === null ? null : fromCents(countedCents - expected) };
  });
}

/** Σ of a column of the preview, as a decimal string (null entries count as 0). */
export function sumPreview(rows: readonly MethodPreview[], column: "expected" | "counted" | "difference"): string {
  return fromCents(rows.reduce((sum, row) => sum + (toCents(row[column]) ?? 0), 0));
}

/** Methods whose expected amount is not zero or that were counted: the ones worth a row in a compact table. */
export function relevantMethods(rows: readonly MethodPreview[]): MethodPreview[] {
  const relevant = rows.filter((row) => (toCents(row.expected) ?? 0) !== 0 || (toCents(row.counted) ?? 0) !== 0 || row.method === "cash");
  return relevant.length > 0 ? relevant : rows.slice(0, 1);
}

// ── close request ────────────────────────────────────────────────────────────

export type CloseDraft = {
  counted: CountedByMethod;
  useDenominations: boolean;
  quantities: DenominationQuantities;
  notes: string;
};

export type CloseRequestResult = { ok: true; body: CashClosureCloseRequest } | { ok: false; error: string };

/**
 * Body of POST …/cash-closures/:id/close from the form draft. When the physical
 * count is on, the cash counted IS the sum of denominations (the API rejects a
 * mismatch with 400 CASH_COUNT_MISMATCH, so the form never lets them diverge).
 */
export function buildCloseRequest(draft: CloseDraft): CloseRequestResult {
  const countedByMethod: Partial<Record<CashMethod, number>> = {};
  for (const method of CASH_METHODS) {
    const text = method === "cash" && draft.useDenominations ? sumDenominations(draft.quantities) : (draft.counted[method] ?? "");
    const parsed = parseCountedAmount(text);
    if (parsed === null) return { ok: false, error: `El importe contado de «${CASH_METHOD_LABELS[method]}» no es válido: escribe una cantidad igual o mayor que cero.` };
    const cents = toCents(parsed) ?? 0;
    if (cents !== 0) countedByMethod[method] = cents / 100;
  }
  const body: CashClosureCloseRequest = { countedByMethod };
  if (draft.useDenominations) {
    const rows = denominationRows(draft.quantities);
    if (rows.length > 0) body.counts = rows;
  }
  const notes = draft.notes.trim();
  if (notes) body.notes = notes;
  return { ok: true, body };
}

/** Empty typed amounts (one "" per method). */
export function emptyCounted(): Record<CashMethod, string> {
  const out = {} as Record<CashMethod, string>;
  for (const method of CASH_METHODS) out[method] = "";
  return out;
}

// ── permissions ──────────────────────────────────────────────────────────────

/** True when the session may run an action: unknown grants (null) let the API decide. */
export function canDo(granted: readonly string[] | null | undefined, permission: string): boolean {
  if (!granted) return true;
  return granted.includes(permission);
}

/** Permission keys of the closure routes (apps/api/src/modules/pos/route-permissions.partial.ts). */
export const CLOSURE_PERMISSIONS = Object.freeze({
  open: "pos.order.pay",
  close: "pos.order.pay",
  approve: "accounting.journal.post"
});
