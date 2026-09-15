// Unit tests · bank reconciliation matching engine (pure, no database).
//   node --import tsx --test src/modules/banking/__tests__/matching.core.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { dec } from "../../treasury/money.js";
import { autoMatch, buildCardSettlementCandidates, suggest, type BankLineLike, type MatchCandidate } from "../matching.core.js";

const day = (d: string): Date => new Date(`${d}T00:00:00Z`);
const line = (id: string, txDate: string, amount: string, text = ""): BankLineLike => ({ id, txDate: day(txDate), amount: dec(amount), text });

const candidates: MatchCandidate[] = [
  { kind: "payment", id: "pay_1", amount: dec("2500.00"), direction: "in", date: day("2026-09-01"), references: ["RES-2026-0450"], label: "Cobro transferencia 2500" },
  { kind: "payment", id: "pay_2", amount: dec("2500.00"), direction: "in", date: day("2026-09-20"), references: [], label: "Cobro transferencia 2500 (otro)" },
  { kind: "supplier_bill", id: "bill_1", amount: dec("1815.00"), direction: "out", date: day("2026-09-04"), references: ["F-2026-118", "B11111111"], label: "Factura F-2026-118" },
  { kind: "payroll_period", id: "per_1", amount: dec("1573.00"), direction: "out", date: day("2026-08-31"), references: ["2026-08", "nomina"], label: "Nóminas 2026-08" },
  { kind: "commission_accrual", id: "acc_1", amount: dec("15.00"), direction: "out", date: day("2026-09-03"), references: ["booking"], label: "Comisión booking" }
];

describe("suggest · rules importe + fecha ±3 + referencia", () => {
  it("exact amount + reference within 3 days → high; exact amount only → medium; up to 10 days → low; beyond → nothing", () => {
    const high = suggest(line("l1", "2026-09-02", "2500.00", "TRANSFERENCIA VIAJES NORTE RES-2026-0450"), candidates);
    assert.equal(high[0]!.candidate.id, "pay_1");
    assert.equal(high[0]!.confidence, "high");
    assert.equal(high[0]!.referenceHit, true);
    assert.equal(high[0]!.daysApart, 1);
    const medium = suggest(line("l2", "2026-09-03", "2500.00"), candidates);
    assert.equal(medium[0]!.candidate.id, "pay_1");
    assert.equal(medium[0]!.confidence, "medium");
    const low = suggest(line("l3", "2026-09-09", "2500.00"), candidates);
    assert.equal(low[0]!.candidate.id, "pay_1");
    assert.equal(low[0]!.confidence, "low");
    const none = suggest(line("l4", "2026-10-15", "2500.00"), candidates);
    assert.deepEqual(none, []);
  });

  it("never crosses direction: an outflow only matches documents to pay, an inflow only collections", () => {
    const out = suggest(line("l5", "2026-09-04", "-1815.00", "PAGO FACTURA F-2026-118"), candidates);
    assert.deepEqual(out.map((s) => [s.candidate.id, s.confidence]), [["bill_1", "high"]]);
    const wrongSign = suggest(line("l6", "2026-09-04", "1815.00"), candidates);
    assert.deepEqual(wrongSign, []);
  });

  it("matches references case-insensitively and ignoring punctuation (nómina → nomina, 2026-08 → 202608)", () => {
    const s = suggest(line("l7", "2026-09-02", "-1573.00", "NÓMINAS 2026/08 PERSONAL"), candidates);
    assert.equal(s[0]!.candidate.id, "per_1");
    assert.equal(s[0]!.confidence, "high");
  });

  it("card settlement: net = gross − fee within the acquirer cap (3 %) matches the daily batch and reports the fee", () => {
    const batch = buildCardSettlementCandidates([
      { id: "p1", amountCents: 6_000, capturedAt: new Date("2026-09-02T09:15:00Z") },
      { id: "p2", amountCents: 4_000, capturedAt: new Date("2026-09-02T22:40:00Z") },
      { id: "p3", amountCents: 5_000, capturedAt: new Date("2026-09-03T08:00:00Z") }
    ]);
    assert.equal(batch.length, 2);
    const b2 = batch.find((b) => b.id === "card:2026-09-02")!;
    assert.equal(b2.amount.toFixed(2), "100.00");
    assert.deepEqual(b2.paymentIds, ["p1", "p2"]);
    const ok = suggest(line("l8", "2026-09-03", "97.50", "LIQUIDACION TPV"), batch);
    assert.equal(ok[0]!.candidate.id, "card:2026-09-02");
    assert.equal(ok[0]!.fee.toFixed(2), "2.50");
    assert.equal(ok[0]!.confidence, "medium");
    const tooBigFee = suggest(line("l9", "2026-09-03", "96.00"), batch);
    assert.deepEqual(tooBigFee.map((s) => s.candidate.id), [], "4 % fee exceeds the cap");
    const exact = suggest(line("l10", "2026-09-03", "50.00"), batch);
    assert.equal(exact[0]!.candidate.id, "card:2026-09-03");
    assert.equal(exact[0]!.fee.toFixed(2), "0.00");
  });
});

describe("autoMatch · una línea por documento, ambigüedad a revisión humana", () => {
  it("applies only high/medium, uses each candidate once and leaves ties unmatched", () => {
    const lines = [
      line("a", "2026-09-02", "2500.00", "RES-2026-0450"),
      line("b", "2026-09-04", "-1815.00", "F-2026-118"),
      line("c", "2026-09-03", "-12.40", "COMISION MANTENIMIENTO"),
      line("d", "2026-09-05", "-15.00", "COMISION BOOKING")
    ];
    const result = autoMatch(lines, candidates);
    assert.deepEqual(
      result.matched.map((m) => [m.lineId, m.suggestion.candidate.id, m.suggestion.confidence]),
      [
        ["a", "pay_1", "high"],
        ["b", "bill_1", "high"],
        ["d", "acc_1", "high"]
      ]
    );
    assert.deepEqual(result.unmatched, ["c"]);
  });

  it("two equally good exact candidates for one line → unmatched (never a coin toss)", () => {
    const twins: MatchCandidate[] = [
      { kind: "payment", id: "x", amount: dec("10.00"), direction: "in", date: day("2026-09-02"), references: [], label: "x" },
      { kind: "payment", id: "y", amount: dec("10.00"), direction: "in", date: day("2026-09-02"), references: [], label: "y" }
    ];
    const result = autoMatch([line("t", "2026-09-02", "10.00")], twins);
    assert.deepEqual(result.matched, []);
    assert.deepEqual(result.unmatched, ["t"]);
  });

  it("a low-confidence suggestion is never applied automatically", () => {
    const result = autoMatch([line("z", "2026-09-09", "2500.00")], candidates);
    assert.deepEqual(result.matched, []);
    assert.deepEqual(result.unmatched, ["z"]);
  });
});
