import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";

// Finanzas · fix:ledger (2026-09-16): guards the corrections of hallazgos
// t6#1 / t6#3 / t6#4 / t6#7 / t6#13 at source level (no database):
//   · ONE customer account (4300) shared by every writer;
//   · the engine refuses asientos inside a CLOSED fiscal year;
//   · the projection never scans Payment reversal rows as captures;
//   · the mayor is a bounded SQL query, never the whole diario in memory;
//   · a cash sale (simplified invoice settled in the act) is keyed pos_ticket.

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const shared = read("packages/shared/src/accounting-types.ts");
const rules = read("apps/api/src/modules/accounting/posting-rules.ts");
const engine = read("apps/api/src/modules/accounting/accounting.service.ts");
const projection = read("apps/api/src/modules/accounting/projection.ts");
const snapshot = read("apps/api/src/modules/invoicing/invoice-snapshot.ts");
const payments = read("apps/api/src/modules/payments/payments.service.ts");
const folio = read("apps/api/src/modules/folio/folio.service.ts");
const relabel = read("apps/api/src/modules/accounting/customer-account-relabel.ts");
const cli = read("apps/api/src/scripts/accounting-relabel-customer-account.ts");

describe("Finanzas · fix:ledger · contrato del libro diario", () => {
  it("t6#4 · the customer receivable is ONE shared sub-account (4300) for every writer", () => {
    assert.match(shared, /export const CUSTOMER_ACCOUNT_CODE = "4300" as const;/);
    assert.match(rules, /import \{ CUSTOMER_ACCOUNT_CODE \} from "\.\.\/\.\.\/\.\.\/\.\.\/\.\.\/packages\/shared\/src\/accounting-types\.js";/);
    assert.match(rules, /export const CUSTOMER_ACCOUNT: string = CUSTOMER_ACCOUNT_CODE;/);
    assert.doesNotMatch(rules, /CUSTOMER_ACCOUNT = "430"/, "posting-rules must not hard-code the 3-digit header");
    // The invoicing / payments / folio writers (other lots) share the same value: a divergence here splits the sub-ledger again.
    assert.match(snapshot, /export const CUSTOMER_ACCOUNT_CODE = "4300";/);
    assert.match(payments, /import \{ CUSTOMER_ACCOUNT_CODE \} from "\.\.\/invoicing\/invoice-snapshot\.js";/);
    assert.match(folio, /import \{ CUSTOMER_ACCOUNT_CODE \} from "\.\.\/invoicing\/invoice-snapshot\.js";/);
    for (const [name, source] of [["payments.service", payments], ["folio.service", folio], ["invoice-snapshot", snapshot], ["posting-rules", rules], ["projection", projection]]) {
      assert.doesNotMatch(source, /accountCode: "430"[,\s}]/, `${name} must not post to 430 directly`);
    }
  });

  it("t6#4 · the 430 → 4300 sanitation is a dry-run-by-default, audited, closed-year-safe CLI", () => {
    assert.match(relabel, /LEGACY_CUSTOMER_ACCOUNT_CODE = "430"/);
    assert.match(relabel, /CLOSED_FISCAL_YEAR_ENTRIES/);
    assert.match(relabel, /ACCOUNTING_CUSTOMER_ACCOUNT_RELABELED/);
    assert.match(relabel, /pg_advisory_xact_lock/);
    assert.match(relabel, /CUSTOMER_RELABEL_MISMATCH/, "the update count is verified inside the transaction");
    assert.match(cli, /--apply requires --confirm/);
    assert.match(cli, /reclasificación D 4300 \/ H 430/, "legalised books: reclassification entry, not a relabel");
  });

  it("t6#3 · the engine refuses an asiento dated inside a closed fiscal year (typed 409) on post, draft and reversal", () => {
    assert.match(engine, /export async function assertEntryDateOpen\(/);
    assert.match(engine, /ledgerConflict\("FISCAL_YEAR_CLOSED"/);
    assert.match(engine, /select: \{ id: true, code: true, status: true \}/, "resolveFiscalYear reads the year status");
    assert.match(engine, /if \(!input\.ignoreClosedPeriod\) await assertEntryDateOpen\(input\.organizationId, propertyId, entryDate, fiscalYear\);/);
    const draftPosting = engine.slice(engine.indexOf("async function postDraftJournalEntry"));
    assert.match(draftPosting, /await assertEntryDateOpen\(entry\.organizationId, entry\.propertyId, entryDate/);
    const draftCreation = engine.slice(engine.indexOf("export async function createJournalEntryDraft"), engine.indexOf("async function postDraftJournalEntry"));
    assert.match(draftCreation, /await assertEntryDateOpen\(input\.organizationId, input\.propertyId, entryDate/);
    assert.match(shared, /"FISCAL_YEAR_CLOSED"/);
  });

  it("t6#7 · the replay and the projection never treat a Payment reversal row as a capture or a legacy refund", () => {
    const candidates = projection.slice(projection.indexOf("async function paymentCandidates"), projection.indexOf("async function posCandidates"));
    assert.match(candidates, /reversalOfId: null, status: \{ in: \["captured", "refunded"\] \}/);
    const capture = projection.slice(projection.indexOf("export async function postPaymentCapture"), projection.indexOf("export async function postPaymentRefund"));
    assert.match(capture, /if \(row\.reversalOfId\) return ignored\(\);/);
    const refund = projection.slice(projection.indexOf("export async function postPaymentRefund"), projection.indexOf("// POS cash / card tickets"));
    assert.match(refund, /if \(row\.reversalOfId\) return ignored\(\);/);
  });

  it("t6#1 · a simplified invoice settled in the act is keyed pos_ticket and never posts a 4300 entry", () => {
    assert.match(rules, /settledInAct\?: CashSettlement \| null;/);
    assert.match(rules, /sourceType: settled \? "pos_ticket"/);
    assert.match(rules, /INVOICE_CASH_SALE_NOT_SIMPLIFIED/);
    assert.match(projection, /export function cashSettlementOf\(/);
    assert.match(projection, /settledInAct: cashSettlementOf\(row, linkedPosOrder\)/);
    const issuance = projection.slice(projection.indexOf("export async function postInvoiceIssuance"), projection.indexOf("async function reverseSupersededInvoice"));
    assert.match(issuance, /if \(doc\.settledInAct\) \{/);
    assert.match(issuance, /findIssuanceEntry\(client, doc\.organizationId, doc\)/);
    const invoiceCandidates = projection.slice(projection.indexOf("async function invoiceCandidates"), projection.indexOf("async function paymentCandidates"));
    assert.match(invoiceCandidates, /const fromTicket = settled !== null && settled\.posOrderId !== null;/);
    assert.match(invoiceCandidates, /if \(inWindow\(issuedDay, from, to\) && !fromTicket\)/);
  });

  it("t6#13 · the mayor is one bounded SQL query with whole-window totals", () => {
    const ledger = engine.slice(engine.indexOf("export async function getAccountLedger"), engine.indexOf("export function previousDay"));
    assert.match(ledger, /FROM journal_lines jl\s+JOIN journal_entries je ON je\.id = jl\.journal_entry_id/);
    assert.match(ledger, /ORDER BY je\.entry_date ASC, je\.entry_number ASC NULLS LAST, je\.id ASC, jl\.id ASC/);
    assert.match(ledger, /LIMIT \$\{cap \+ 1\}/);
    assert.doesNotMatch(ledger, /journalEntry\.findMany/, "the diario is not loaded to filter it in memory");
    assert.doesNotMatch(ledger, /journalEntryId: \{ in:/, "no IN (<every id of the window>)");
    assert.match(ledger, /closingBalance: openingBalance\.plus\(totalDebit\)\.minus\(totalCredit\)\.toFixed\(2\)/);
    assert.match(shared, /Σ debit \/ Σ credit of the WHOLE window/);
  });
});
