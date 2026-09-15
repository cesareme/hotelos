// Bank reconciliation · pure matching engine (no database).
//
// Rules (lote tesoreria-banca):
//   · amount must match to the cent (or, for a card settlement, gross − fee
//     within `maxFeePct` of the gross);
//   · the document date must be within ±`dayTolerance` days of the bank
//     operation date (auto-match) — up to `lowDayTolerance` for a "low"
//     suggestion that is only offered, never applied;
//   · a reference / PSP reference / invoice number found in the bank line's
//     text lifts the confidence to "high".
// Direction is enforced: inflows (+) only match collections, outflows (−)
// only match payments out.
//
// `suggest` ranks candidates for ONE line; `autoMatch` walks a statement and
// pairs each line with at most one candidate (and each candidate with at most
// one line), applying only high/medium suggestions.

import { dec, fromCents, round2, type Dec } from "../treasury/money.js";

export type CandidateKind = "payment" | "card_settlement" | "supplier_bill" | "payroll_period" | "commission_accrual";

export type MatchCandidate = {
  kind: CandidateKind;
  id: string;
  /** Positive magnitude. */
  amount: Dec;
  direction: "in" | "out";
  /** Document date (payment createdAt, bill dueDate, period end, accrual date…). */
  date: Date;
  /** Tokens that identify the document on the bank text (PSP ref, invoice number, NIF…). */
  references: string[];
  label: string;
  /** Card settlement batches: the fee the acquirer may have deducted (default 3 %). */
  maxFeePct?: number;
};

export type BankLineLike = {
  id: string;
  txDate: Date;
  /** Signed: + inflow, − outflow. */
  amount: Dec;
  text: string;
};

export type Confidence = "high" | "medium" | "low";

export type Suggestion = {
  candidate: MatchCandidate;
  confidence: Confidence;
  score: number;
  daysApart: number;
  referenceHit: boolean;
  /** Card settlements: gross − line amount (0 for exact matches). */
  fee: Dec;
  reason: string;
};

export type MatchingOptions = {
  dayTolerance?: number;
  lowDayTolerance?: number;
};

const DEFAULTS: Required<MatchingOptions> = { dayTolerance: 3, lowDayTolerance: 10 };

function normaliseToken(value: string): string {
  // Accents stripped (nómina ≡ nomina), then only letters and digits are kept.
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

export function daysApart(a: Date, b: Date): number {
  return Math.abs(Math.round((a.getTime() - b.getTime()) / 86_400_000));
}

function referenceHit(text: string, references: string[]): boolean {
  const haystack = normaliseToken(text);
  if (!haystack) return false;
  return references.some((ref) => {
    const token = normaliseToken(ref);
    return token.length >= 4 && haystack.includes(token);
  });
}

/** Rank the candidates that could explain one bank line (best first). */
export function suggest(line: BankLineLike, candidates: MatchCandidate[], options: MatchingOptions = {}): Suggestion[] {
  const opts = { ...DEFAULTS, ...options };
  const lineAmount = round2(line.amount);
  if (lineAmount.isZero()) return [];
  const direction: "in" | "out" = lineAmount.isPositive() ? "in" : "out";
  const magnitude = lineAmount.abs();
  const out: Suggestion[] = [];

  for (const candidate of candidates) {
    if (candidate.direction !== direction) continue;
    const candidateAmount = round2(candidate.amount);
    let fee = dec(0);
    if (!candidateAmount.equals(magnitude)) {
      if (candidate.kind !== "card_settlement") continue;
      // Acquirer deducts its fee before crediting: 0 < gross − net ≤ maxFeePct % of gross.
      fee = candidateAmount.minus(magnitude);
      const maxFee = round2(candidateAmount.mul(candidate.maxFeePct ?? 3).div(100));
      if (fee.lte(0) || fee.gt(maxFee)) continue;
    }
    const days = daysApart(line.txDate, candidate.date);
    if (days > opts.lowDayTolerance) continue;
    const hit = referenceHit(line.text, candidate.references);
    let confidence: Confidence;
    if (days <= opts.dayTolerance && hit) confidence = "high";
    else if (days <= opts.dayTolerance) confidence = "medium";
    else confidence = "low";
    // Score: exactness first, then reference, then proximity.
    const score = (fee.isZero() ? 100 : 80) + (hit ? 50 : 0) + Math.max(0, opts.lowDayTolerance - days);
    const reason = [
      fee.isZero() ? "importe exacto" : `importe neto de comisión ${fee.toFixed(2)}`,
      `${days} día(s) de diferencia`,
      hit ? "referencia encontrada" : null
    ]
      .filter(Boolean)
      .join(" · ");
    out.push({ candidate, confidence, score, daysApart: days, referenceHit: hit, fee, reason });
  }

  return out.sort((a, b) => b.score - a.score || a.daysApart - b.daysApart);
}

export type AutoMatchResult = {
  matched: Array<{ lineId: string; suggestion: Suggestion }>;
  unmatched: string[];
};

/** Greedy pass over a statement: best high/medium suggestion per line, one line per candidate. */
export function autoMatch(lines: BankLineLike[], candidates: MatchCandidate[], options: MatchingOptions = {}): AutoMatchResult {
  const used = new Set<string>();
  const matched: AutoMatchResult["matched"] = [];
  const unmatched: string[] = [];
  for (const line of lines) {
    const ranked = suggest(line, candidates, options).filter((s) => s.confidence !== "low" && !used.has(`${s.candidate.kind}:${s.candidate.id}`));
    const best = ranked[0];
    if (!best) {
      unmatched.push(line.id);
      continue;
    }
    // An ambiguous tie between two exact candidates is left to a human.
    const second = ranked[1];
    if (second && second.score === best.score && second.confidence === best.confidence) {
      unmatched.push(line.id);
      continue;
    }
    used.add(`${best.candidate.kind}:${best.candidate.id}`);
    matched.push({ lineId: line.id, suggestion: best });
  }
  return { matched, unmatched };
}

/**
 * Card settlement batches: captured card_terminal payments grouped by calendar
 * day become one candidate each (the acquirer settles per day, net of fee).
 */
export function buildCardSettlementCandidates(
  payments: Array<{ id: string; amountCents: number; capturedAt: Date }>,
  options: { maxFeePct?: number } = {}
): Array<MatchCandidate & { paymentIds: string[] }> {
  const byDay = new Map<string, { cents: number; ids: string[]; date: Date }>();
  for (const payment of payments) {
    const day = payment.capturedAt.toISOString().slice(0, 10);
    const bucket = byDay.get(day) ?? { cents: 0, ids: [], date: new Date(`${day}T00:00:00Z`) };
    bucket.cents += payment.amountCents;
    bucket.ids.push(payment.id);
    byDay.set(day, bucket);
  }
  return Array.from(byDay.entries()).map(([day, bucket]) => ({
    kind: "card_settlement" as const,
    id: `card:${day}`,
    amount: fromCents(bucket.cents),
    direction: "in" as const,
    date: bucket.date,
    references: [],
    label: `Liquidación datáfono ${day} (${bucket.ids.length} cobro(s))`,
    maxFeePct: options.maxFeePct ?? 3,
    paymentIds: bucket.ids
  }));
}
