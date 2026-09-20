// Documents · two-way matching of supplier-bill lines against goods-receipt
// lines (Tanda T9 · lote T9-06b, design §7.2 «Cotejo a 2 vías»). Pure: no
// database, no clock; the caller passes the receipts of the same supplier and
// centre and the organisation's tolerances (DocumentSettings).
//
// How a bill line finds its receipt line:
//   1. by reference: the delivery-note number quoted on the line
//      (`deliveryNoteRef`) or anywhere on the invoice (`citedReferences`)
//      restricts the candidates to that receipt; inside it, the best line by
//      description / quantity / price / amount wins;
//   2. by content: description normalised (no accents, no case, no
//      punctuation) equal or with enough shared tokens, plus at least one of
//      quantity, unit price or base within tolerance (so two lines that only
//      share a description are not glued together);
//   3. amounts (rare: lines without quantity or price on one side) by base
//      within `amountToleranceAbs`.
// A receipt line is consumed by at most one bill line. Variances are
// bill − receipt. The global status follows SupplierBill.matchStatus:
// none (nothing matched) · variance (some match outside tolerance) · full
// (every bill line matched within tolerance) · partial (the rest).
//
// Amounts are Prisma.Decimal through payables/money.ts (never float);
// quantities keep 3 decimals, unit prices 4, bases 2.

import type { SupplierBillMatchStatus } from "@hotelos/shared";
import { Prisma } from "@prisma/client";
import { dec, round2, ZERO, type Decimal } from "../payables/money.js";

export type NumberLike = number | string | Decimal;

/** Tolerances of the organisation (`DocumentSettings`, design §7.2): % of unit price, units of quantity, EUR of base. */
export type MatchTolerances = {
  priceTolerancePct: NumberLike;
  quantityTolerance: NumberLike;
  amountToleranceAbs: NumberLike;
};

/** Defaults of the schema (price 2 %, quantity 0, amount 1,00 €). */
export const DEFAULT_MATCH_TOLERANCES: Readonly<MatchTolerances> = Object.freeze({
  priceTolerancePct: "2.00",
  quantityTolerance: "0.000",
  amountToleranceAbs: "1.00"
});

/** A bill line as extracted or as stored (`SupplierBillLine`); `id` only when persisted. */
export type BillLineLike = {
  id?: string | null;
  lineNo?: number | null;
  description: string;
  quantity?: NumberLike | null;
  unitPrice?: NumberLike | null;
  /** Base without VAT; derived from quantity × unitPrice when absent. */
  base?: NumberLike | null;
  /** Delivery-note number quoted on the line. */
  deliveryNoteRef?: string | null;
};

export type GoodsReceiptLineLike = {
  id: string;
  lineNo?: number | null;
  description: string;
  quantityReceived: NumberLike;
  unitPrice?: NumberLike | null;
  base?: NumberLike | null;
};

/** A goods receipt of the same supplier and centre (the caller filters by supplier, centre and status). */
export type GoodsReceiptLike = {
  id: string;
  propertyId?: string | null;
  supplierId?: string | null;
  supplierTaxId?: string | null;
  deliveryNoteNumber: string;
  deliveryDate?: string | null;
  status?: string | null;
  lines: GoodsReceiptLineLike[];
};

export type MatchedBy = "reference" | "description" | "amount";

/** Draft of a `BillLineMatch` row (status always `auto`; a person confirms or rejects later). */
export type BillLineMatchDraft = {
  supplierBillLineId?: string;
  /** 1-based position of the bill line in the input (for lines not yet persisted). */
  billLineNo: number;
  goodsReceiptId: string;
  goodsReceiptLineId: string;
  /** Decimal(12,3) as string, or null when neither side has a quantity. */
  matchedQuantity: string | null;
  /** Base of the receipt line (what was received), 2 decimals, or the bill base when the receipt has none. */
  matchedBase: string | null;
  /** bill − receipt, 3 decimals; null when a side has no quantity. */
  quantityVariance: string | null;
  /** bill − receipt unit price, 4 decimals; null when a side has no price. */
  priceVariance: string | null;
  status: "auto";
  withinTolerance: boolean;
  matchedBy: MatchedBy;
};

export type MatchResult = {
  matches: BillLineMatchDraft[];
  status: SupplierBillMatchStatus;
  /** 1-based bill lines without a receipt line. */
  unmatchedBillLines: number[];
};

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

const STOPWORDS = new Set(["de", "del", "la", "el", "los", "las", "y", "e", "o", "u", "en", "por", "con", "un", "una", "unos", "unas", "a", "al", "para", "ud", "uds", "unidad", "unidades"]);

/** Lower-case, no accents, no punctuation, single spaces. */
export function normalizeDescription(value: string | null | undefined): string {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/** Upper-case alphanumerics only ("ALB-2026/0042" → "ALB20260042"); empty string when nothing is left. */
export function normalizeReference(value: string | null | undefined): string {
  return String(value ?? "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

function tokensOf(normalized: string): Set<string> {
  const out = new Set<string>();
  for (const token of normalized.split(" ")) {
    if (token.length >= 2 && !STOPWORDS.has(token)) out.add(token);
  }
  return out;
}

/** 1 for equal normalised descriptions; otherwise the Jaccard index of their tokens (0..1). */
export function descriptionSimilarity(a: string, b: string): number {
  const na = normalizeDescription(a);
  const nb = normalizeDescription(b);
  if (na.length === 0 || nb.length === 0) return 0;
  if (na === nb) return 1;
  const ta = tokensOf(na);
  const tb = tokensOf(nb);
  if (ta.size === 0 || tb.size === 0) return 0;
  let shared = 0;
  for (const token of ta) if (tb.has(token)) shared++;
  const union = ta.size + tb.size - shared;
  return union === 0 ? 0 : shared / union;
}

/** Minimum similarity to accept a description-based match. */
export const DESCRIPTION_MATCH_THRESHOLD = 0.5;

// ---------------------------------------------------------------------------
// Amounts
// ---------------------------------------------------------------------------

/** Decimal of an optional figure; null for empty / absent / unparseable values (an extractor never breaks the matching). */
export function optDec(value: NumberLike | null | undefined): Decimal | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  if (typeof value === "number" && !Number.isFinite(value)) return null;
  try {
    const parsed = dec(typeof value === "string" ? value.trim().replace(",", ".") : value);
    return parsed.isNaN() || !parsed.isFinite() ? null : parsed;
  } catch {
    return null;
  }
}

function fmt(value: Decimal | null, places: number): string | null {
  return value === null ? null : value.toDecimalPlaces(places, Prisma.Decimal.ROUND_HALF_UP).toFixed(places);
}

/** Base of a line: the explicit base or quantity × unit price rounded to the cent; null when unknown. */
export function lineBase(line: { base?: NumberLike | null; quantity?: NumberLike | null; unitPrice?: NumberLike | null }): Decimal | null {
  const base = optDec(line.base);
  if (base !== null) return round2(base);
  const quantity = optDec(line.quantity);
  const unitPrice = optDec(line.unitPrice);
  if (quantity === null || unitPrice === null) return null;
  return round2(quantity.times(unitPrice));
}

type Side = { quantity: Decimal | null; unitPrice: Decimal | null; base: Decimal | null };

function billSide(line: BillLineLike): Side {
  return { quantity: optDec(line.quantity), unitPrice: optDec(line.unitPrice), base: lineBase(line) };
}

function receiptSide(line: GoodsReceiptLineLike): Side {
  return {
    quantity: optDec(line.quantityReceived),
    unitPrice: optDec(line.unitPrice),
    base: lineBase({ base: line.base, quantity: line.quantityReceived, unitPrice: line.unitPrice })
  };
}

type Comparison = {
  quantityVariance: Decimal | null;
  priceVariance: Decimal | null;
  amountVariance: Decimal | null;
  quantityOk: boolean | null;
  priceOk: boolean | null;
  amountOk: boolean | null;
  withinTolerance: boolean;
  /** Number of applicable checks that passed (ranking). */
  score: number;
};

function compare(bill: Side, receipt: Side, tolerances: MatchTolerances): Comparison {
  const priceTolerancePct = dec(tolerances.priceTolerancePct);
  const quantityTolerance = dec(tolerances.quantityTolerance);
  const amountToleranceAbs = dec(tolerances.amountToleranceAbs);

  const quantityVariance = bill.quantity !== null && receipt.quantity !== null ? bill.quantity.minus(receipt.quantity) : null;
  const priceVariance = bill.unitPrice !== null && receipt.unitPrice !== null ? bill.unitPrice.minus(receipt.unitPrice) : null;
  const amountVariance = bill.base !== null && receipt.base !== null ? bill.base.minus(receipt.base) : null;

  const quantityOk = quantityVariance === null ? null : quantityVariance.abs().lte(quantityTolerance);
  let priceOk: boolean | null = null;
  if (priceVariance !== null && receipt.unitPrice !== null) {
    priceOk = receipt.unitPrice.isZero() ? priceVariance.isZero() : priceVariance.abs().div(receipt.unitPrice.abs()).times(100).lte(priceTolerancePct);
  }
  const amountOk = amountVariance === null ? null : amountVariance.abs().lte(amountToleranceAbs);

  const applicable = [quantityOk, priceOk, amountOk].filter((v): v is boolean => v !== null);
  const withinTolerance = applicable.every(Boolean);
  const score = applicable.filter(Boolean).length;
  return { quantityVariance, priceVariance, amountVariance, quantityOk, priceOk, amountOk, withinTolerance, score };
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

type Candidate = { receipt: GoodsReceiptLike; line: GoodsReceiptLineLike; side: Side };

type Scored = { candidate: Candidate; similarity: number; comparison: Comparison; matchedBy: MatchedBy };

function pickBest(bill: BillLineLike, side: Side, candidates: Candidate[], tolerances: MatchTolerances, byReference: boolean): Scored | null {
  let best: Scored | null = null;
  for (const candidate of candidates) {
    const similarity = descriptionSimilarity(bill.description, candidate.line.description);
    const comparison = compare(side, candidate.side, tolerances);
    const anyApplicable = comparison.quantityOk !== null || comparison.priceOk !== null || comparison.amountOk !== null;
    const anyOk = comparison.score > 0;
    let matchedBy: MatchedBy;
    if (byReference) {
      // Inside the quoted delivery note: description alone or amounts alone are enough.
      if (similarity < DESCRIPTION_MATCH_THRESHOLD && !anyOk) continue;
      matchedBy = "reference";
    } else if (similarity >= DESCRIPTION_MATCH_THRESHOLD) {
      // Same description elsewhere: require one agreeing figure so recurring lines are not glued together.
      if (anyApplicable && !anyOk) continue;
      matchedBy = "description";
    } else if (comparison.amountOk === true && comparison.quantityOk !== false && comparison.priceOk !== false) {
      matchedBy = "amount";
    } else continue;
    const scored: Scored = { candidate, similarity, comparison, matchedBy };
    if (best === null || better(scored, best)) best = scored;
  }
  return best;
}

function better(a: Scored, b: Scored): boolean {
  if (a.similarity !== b.similarity) return a.similarity > b.similarity;
  if (a.comparison.score !== b.comparison.score) return a.comparison.score > b.comparison.score;
  const da = a.comparison.amountVariance?.abs() ?? null;
  const db = b.comparison.amountVariance?.abs() ?? null;
  if (da !== null && db !== null && !da.equals(db)) return da.lt(db);
  return false;
}

export type MatchOptions = {
  /** Delivery-note numbers quoted anywhere on the invoice (not on a specific line). */
  citedReferences?: ReadonlyArray<string> | null;
};

/**
 * Matches the lines of one bill against the lines of the given receipts.
 * Receipts must already be those of the same supplier and centre (and the
 * status the caller wants: `received` for open ones).
 */
export function matchBillToReceipts(
  billLines: ReadonlyArray<BillLineLike>,
  receipts: ReadonlyArray<GoodsReceiptLike>,
  tolerances: MatchTolerances = DEFAULT_MATCH_TOLERANCES,
  options: MatchOptions = {}
): MatchResult {
  const pool: Candidate[] = [];
  for (const receipt of receipts) {
    for (const line of receipt.lines) pool.push({ receipt, line, side: receiptSide(line) });
  }
  const consumed = new Set<string>();
  const available = (): Candidate[] => pool.filter((c) => !consumed.has(c.line.id));
  const cited = new Set((options.citedReferences ?? []).map(normalizeReference).filter((r) => r.length > 0));

  const matches: BillLineMatchDraft[] = [];
  const unmatched: number[] = [];

  billLines.forEach((bill, index) => {
    const billLineNo = bill.lineNo ?? index + 1;
    const side = billSide(bill);
    const lineRef = normalizeReference(bill.deliveryNoteRef);
    let picked: Scored | null = null;

    if (lineRef.length > 0) {
      const inReceipt = available().filter((c) => normalizeReference(c.receipt.deliveryNoteNumber) === lineRef);
      if (inReceipt.length > 0) picked = pickBest(bill, side, inReceipt, tolerances, true);
    }
    if (picked === null && cited.size > 0) {
      const inCited = available().filter((c) => cited.has(normalizeReference(c.receipt.deliveryNoteNumber)));
      if (inCited.length > 0) picked = pickBest(bill, side, inCited, tolerances, true);
    }
    if (picked === null) picked = pickBest(bill, side, available(), tolerances, false);

    if (picked === null) {
      unmatched.push(billLineNo);
      return;
    }
    consumed.add(picked.candidate.line.id);
    const { comparison, candidate } = picked;
    const matchedQuantity =
      side.quantity !== null && candidate.side.quantity !== null
        ? Prisma.Decimal.min(side.quantity, candidate.side.quantity)
        : (candidate.side.quantity ?? side.quantity);
    const matchedBase = candidate.side.base ?? side.base;
    matches.push({
      ...(bill.id ? { supplierBillLineId: bill.id } : {}),
      billLineNo,
      goodsReceiptId: candidate.receipt.id,
      goodsReceiptLineId: candidate.line.id,
      matchedQuantity: fmt(matchedQuantity, 3),
      matchedBase: fmt(matchedBase, 2),
      quantityVariance: fmt(comparison.quantityVariance, 3),
      priceVariance: fmt(comparison.priceVariance, 4),
      status: "auto",
      withinTolerance: comparison.withinTolerance,
      matchedBy: picked.matchedBy
    });
  });

  return { matches, status: matchStatusOf(matches, billLines.length), unmatchedBillLines: unmatched };
}

/** none · variance · full · partial from the drafts and the number of bill lines. */
export function matchStatusOf(matches: ReadonlyArray<Pick<BillLineMatchDraft, "withinTolerance">>, billLineCount: number): SupplierBillMatchStatus {
  if (matches.length === 0) return "none";
  if (matches.some((m) => !m.withinTolerance)) return "variance";
  return matches.length >= billLineCount ? "full" : "partial";
}

/** Sum of the matched bases (2 decimals) — informative for the reviewer. */
export function matchedBaseTotal(matches: ReadonlyArray<Pick<BillLineMatchDraft, "matchedBase">>): string {
  let total = ZERO;
  for (const m of matches) if (m.matchedBase !== null) total = total.plus(dec(m.matchedBase));
  return round2(total).toFixed(2);
}
