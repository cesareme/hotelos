// The ONE rule that decides which journal entries the statements aggregate
// (hallazgo t6#2) and its mirror in the in-memory source. Run from apps/api:
//   node --import tsx --test src/modules/financial-statements/__tests__/source.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ledgerEntryCounts, ledgerEntryIsBooked } from "../source.js";
import { MemorySource } from "./memory-source.mts";

describe("ledgerEntryCounts (statements) / ledgerEntryIsBooked (diario)", () => {
  it("counts a posted entry, never a draft, and neither half of a marked reversal pair", () => {
    assert.equal(ledgerEntryCounts({ status: "posted", reversedById: null, reversalOfId: null }), true);
    assert.equal(ledgerEntryCounts({ status: "draft", reversedById: null, reversalOfId: null }), false);
    // Reversed original: status reversed + reversedById (what reverseJournalEntry writes).
    assert.equal(ledgerEntryCounts({ status: "reversed", reversedById: "je_r", reversalOfId: null }), false);
    // Its reversal: posted, reversalOfId set. Was counted alone before the fix → double subtraction.
    assert.equal(ledgerEntryCounts({ status: "posted", reversedById: null, reversalOfId: "je_o" }), false);
    // Belt and braces: a link set on either side is enough, whatever the status says.
    assert.equal(ledgerEntryCounts({ status: "posted", reversedById: "je_r", reversalOfId: null }), false);
  });

  it("the diario keeps every booked entry, both halves of a reversal pair included", () => {
    assert.equal(ledgerEntryIsBooked({ status: "posted" }), true);
    assert.equal(ledgerEntryIsBooked({ status: "reversed" }), true);
    assert.equal(ledgerEntryIsBooked({ status: "draft" }), false);
  });
});

describe("modo opening_in_period (apertura importada dentro del periodo)", () => {
  const opening = (s: MemorySource, date: string, propertyId: string | null = null) =>
    s.post({ date, kind: "opening", propertyId, lines: [{ code: "572", debit: "5000.00" }, { code: "129", credit: "1000.00" }, { code: "100", credit: "4000.00" }] });
  const closing = (s: MemorySource, date: string, propertyId: string | null = null) =>
    s.post({ date, kind: "closing", propertyId, lines: [{ code: "572", credit: "5000.00" }, { code: "129", debit: "1000.00" }, { code: "100", debit: "4000.00" }] });
  const codesOf = async (s: MemorySource, from: string, to: string, propertyId: string | null = null) =>
    (await s.accountBalances({ organizationId: "org_t", propertyId, mode: "opening_in_period", from, to })).map((r) => `${r.code} ${r.debit.toFixed(2)}/${r.credit.toFixed(2)}`);

  it("includes an opening dated `from` that no closing precedes (first entry of an imported ledger)", async () => {
    const s = new MemorySource("org_t");
    opening(s, "2027-01-01");
    s.post({ date: "2027-06-30", lines: [{ code: "129", debit: "1000.00" }, { code: "113", credit: "1000.00" }] });
    assert.deepEqual(await codesOf(s, "2027-01-01", "2027-12-31"), ["100 0.00/4000.00", "129 0.00/1000.00", "572 5000.00/0.00"]);
    // Outside the range, or a movements read: never.
    assert.deepEqual(await codesOf(s, "2027-01-02", "2027-12-31"), []);
    assert.deepEqual((await s.accountBalances({ organizationId: "org_t", mode: "movements", from: "2027-01-01", to: "2027-12-31" })).map((r) => r.code), ["113", "129"]);
  });

  it("excludes an opening whose closing is dated from − 1 (balance_at(from − 1) already holds those balances)", async () => {
    const s = new MemorySource("org_t");
    closing(s, "2027-12-31");
    opening(s, "2028-01-01");
    assert.deepEqual(await codesOf(s, "2028-01-01", "2028-12-31"), []);
  });

  it("excludes an opening whose closing is inside the range before it, and includes one whose closing is already in balance_at(from − 1)", async () => {
    const straddle = new MemorySource("org_t");
    closing(straddle, "2027-12-31");
    opening(straddle, "2028-01-01");
    assert.deepEqual(await codesOf(straddle, "2027-07-01", "2028-06-30"), []);
    const early = new MemorySource("org_t");
    closing(early, "2027-12-30"); // dated before from − 1: balance_at(2027-12-31) includes it, the balances are zero
    opening(early, "2028-01-01");
    assert.equal((await codesOf(early, "2028-01-01", "2028-12-31")).length, 3);
  });

  it("pairs the opening with the closing of the same property (null = null) and ignores a draft closing", async () => {
    const s = new MemorySource("org_t");
    closing(s, "2027-12-31", "prop_a");
    opening(s, "2028-01-01", "prop_a");
    opening(s, "2028-01-01", null);
    assert.deepEqual(await codesOf(s, "2028-01-01", "2028-12-31", "prop_a"), []);
    assert.equal((await codesOf(s, "2028-01-01", "2028-12-31", null)).length, 3); // organisation-wide: the society-level opening has no closing
    assert.equal((await s.accountBalances({ organizationId: "org_t", unassignedOnly: true, mode: "opening_in_period", from: "2028-01-01", to: "2028-12-31" })).length, 3);
    const d = new MemorySource("org_t");
    d.post({ date: "2027-12-31", kind: "closing", status: "draft", lines: [{ code: "572", credit: "1.00" }, { code: "100", debit: "1.00" }] });
    opening(d, "2028-01-01");
    assert.equal((await codesOf(d, "2028-01-01", "2028-12-31")).length, 3);
    await assert.rejects(() => s.accountBalances({ organizationId: "org_t", mode: "opening_in_period", to: "2028-12-31" }), /requires from/);
  });
});

describe("MemorySource.reverse mirrors reverseJournalEntry", () => {
  it("swaps the sides, flags the original and drops the pair from the balances but not from the diario", async () => {
    const s = new MemorySource("org_t");
    const sale = s.post({ date: "2027-03-10", sourceType: "invoice", sourceId: "inv_9", reference: "FAC-9", lines: [{ code: "4300", debit: "121.00" }, { code: "705.1", credit: "100.00", taxRateCode: "21" }, { code: "477.21", credit: "21.00", taxRateCode: "21", taxBase: "100.00" }] });
    const reversal = s.reverse(sale.id!, { date: "2027-04-02", sourceType: "invoice_cancellation", sourceId: "inv_9" });
    assert.equal(reversal.kind, "reversal");
    assert.equal(reversal.reversalOfId, sale.id);
    assert.equal(reversal.date, "2027-04-02");
    assert.equal(reversal.reference, "FAC-9");
    assert.deepEqual(reversal.lines.map((l) => [l.code, l.debit ?? "0", l.credit ?? "0"]), [["4300", "0", "121.00"], ["705.1", "100.00", "0"], ["477.21", "21.00", "0"]]);
    assert.equal(sale.status, "reversed");
    assert.equal(sale.reversedById, reversal.id);
    // Idempotent and one-way, like the service.
    assert.equal(s.reverse(sale.id!), reversal);
    assert.throws(() => s.reverse(reversal.id!), /not reversible/);

    const movements = await s.accountBalances({ organizationId: "org_t", mode: "movements", from: "2027-01-01", to: "2027-12-31" });
    assert.deepEqual(movements, []);
    const at = await s.accountBalances({ organizationId: "org_t", mode: "balance_at", to: "2027-12-31" });
    assert.deepEqual(at, []);

    const rows: string[] = [];
    for await (const batch of s.journalLines({ organizationId: "org_t", from: "2027-01-01", to: "2027-12-31" })) rows.push(...batch.map((r) => `${r.entryDate} ${r.accountCode} ${r.debit.toFixed(2)}/${r.credit.toFixed(2)}`));
    assert.deepEqual(rows, ["2027-03-10 4300 121.00/0.00", "2027-03-10 705.1 0.00/100.00", "2027-03-10 477.21 0.00/21.00", "2027-04-02 4300 0.00/121.00", "2027-04-02 705.1 100.00/0.00", "2027-04-02 477.21 21.00/0.00"]);
  });

  it("a draft never counts anywhere and cannot be reversed", async () => {
    const s = new MemorySource("org_t");
    const draft = s.post({ date: "2027-03-10", status: "draft", lines: [{ code: "570", debit: "5.00" }, { code: "705.3", credit: "5.00" }] });
    assert.deepEqual(await s.accountBalances({ organizationId: "org_t", mode: "balance_at", to: "2027-12-31" }), []);
    const rows: unknown[] = [];
    for await (const batch of s.journalLines({ organizationId: "org_t", from: "2027-01-01", to: "2027-12-31" })) rows.push(...batch);
    assert.deepEqual(rows, []);
    assert.throws(() => s.reverse(draft.id!), /draft/);
  });
});
