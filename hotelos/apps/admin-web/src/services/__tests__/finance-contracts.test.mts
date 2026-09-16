import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  ANNUAL_FISCAL_MODELS,
  FINANCE_ERROR_FALLBACK,
  FINANCE_ERROR_MESSAGES,
  annualAccountsQuery,
  cashClosureListQuery,
  compactQuery,
  downloadFilename,
  expenseListQuery,
  financeErrorCode,
  financeErrorMessage,
  financeErrorStatus,
  fiscalModelQuery,
  fixedAssetListQuery,
  hasFinanceErrorCode,
  isCapturedPayment,
  isPaymentIntent,
  journalQuery,
  ledgerQuery,
  monthPeriod,
  newClientRequestId,
  periodBounds,
  posTicketsQuery,
  previousPeriod,
  quarterPeriod,
  statementWindowQuery,
  supplierBillListQuery,
  supplierListQuery,
  treasuryScopeQuery,
  usaliPeriodsParam,
  vatBookQuery,
  yearPeriod
} from "../finance-contracts.ts";

// Mapping tests only: no network, no api-client (import.meta.env is not
// available under node --test), no React.

const shared = (file: string) => readFileSync(new URL(`../../../../../packages/shared/src/${file}`, import.meta.url), "utf8");

/** Every string literal of a `const X = [ … ] as const` block. */
function arrayLiterals(source: string, name: string): string[] {
  const block = source.match(new RegExp(`${name}\\s*=\\s*\\[([\\s\\S]*?)\\]\\s*as const`));
  assert.ok(block, `${name} not found`);
  return [...block[1].matchAll(/"([A-Z0-9_]+)"/g)].map((m) => m[1]);
}

/** Every string literal of a `type X = | "A" | "B"` union. */
function unionLiterals(source: string, name: string): string[] {
  const block = source.match(new RegExp(`type ${name}\\s*=([\\s\\S]*?);`));
  assert.ok(block, `${name} not found`);
  return [...block[1].matchAll(/"([A-Z0-9_]+)"/g)].map((m) => m[1]);
}

/** Every key of a `Object.freeze({ KEY: "KEY", … })` record. */
function frozenKeys(source: string, name: string): string[] {
  const block = source.match(new RegExp(`${name}\\s*=\\s*Object\\.freeze\\(\\{([\\s\\S]*?)\\}`));
  assert.ok(block, `${name} not found`);
  return [...block[1].matchAll(/^\s*([A-Z0-9_]+):/gm)].map((m) => m[1]);
}

describe("finance-contracts · details.code → mensaje en español", () => {
  it("covers every error code the shared finance contracts declare", () => {
    const codes = [
      ...arrayLiterals(shared("accounting-types.ts"), "LEDGER_ERROR_CODES"),
      ...frozenKeys(shared("payments-types.ts"), "PAYMENT_ERROR_CODES"),
      ...unionLiterals(shared("pos-types.ts"), "PosErrorCode"),
      ...unionLiterals(shared("payables-types.ts"), "PayablesErrorCode"),
      ...unionLiterals(shared("treasury-types.ts"), "TreasuryErrorCode")
    ];
    assert.ok(codes.length > 80, `expected the shared contracts to declare more than 80 codes, parsed ${codes.length}`);
    const missing = codes.filter((code) => !FINANCE_ERROR_MESSAGES[code]);
    assert.deepEqual(missing, [], `codes without a Spanish message: ${missing.join(", ")}`);
  });

  it("every message is a Spanish sentence without roadmap jargon", () => {
    for (const [code, message] of Object.entries(FINANCE_ERROR_MESSAGES)) {
      assert.ok(message.length > 15 && /[.]$/.test(message), `${code}: «${message}» must be a full sentence`);
      // `\b` is ASCII-only: «método» would match /\bTODO\b/i, so the jargon words are matched case-sensitively.
      assert.doesNotMatch(message, /\b(stub|mock|sandbox|coming soon)\b|TODO/, `${code} carries jargon`);
    }
  });

  it("maps a typed 4xx by its code, then falls back to the API message, then to the default", () => {
    const closed = { message: "raw api text", status: 409, details: { code: "FISCAL_YEAR_CLOSED", fiscalYearCode: "2025" } };
    assert.equal(financeErrorCode(closed), "FISCAL_YEAR_CLOSED");
    assert.equal(financeErrorStatus(closed), 409);
    assert.ok(hasFinanceErrorCode(closed, "FISCAL_YEAR_CLOSED"));
    assert.equal(financeErrorMessage(closed), FINANCE_ERROR_MESSAGES.FISCAL_YEAR_CLOSED);
    assert.equal(financeErrorMessage({ message: "Propiedad no encontrada.", status: 404 }), "Propiedad no encontrada.");
    assert.equal(financeErrorMessage({ message: "  ", details: { code: "NOT_IN_DICTIONARY" } }), FINANCE_ERROR_FALLBACK);
    assert.equal(financeErrorMessage(null, "sin datos"), "sin datos");
    assert.equal(financeErrorMessage("texto plano"), "texto plano");
    assert.equal(financeErrorCode(new Error("boom")), null);
    assert.equal(financeErrorStatus(new Error("boom")), null);
  });

  it("PSP_NOT_CONFIGURED appends the honest PSP note and PREVIOUS_PERIOD_MISSING lists the pending months", () => {
    const psp = { message: "x", status: 409, details: { code: "PSP_NOT_CONFIGURED", psp: { configured: false, message: "Configura STRIPE_SECRET_KEY o Redsys." } } };
    assert.equal(financeErrorMessage(psp), `${FINANCE_ERROR_MESSAGES.PSP_NOT_CONFIGURED} Configura STRIPE_SECRET_KEY o Redsys.`);
    assert.equal(financeErrorMessage({ details: { code: "PSP_NOT_CONFIGURED", psp: { message: "   " } } }), FINANCE_ERROR_MESSAGES.PSP_NOT_CONFIGURED);
    const pending = { status: 409, details: { code: "PREVIOUS_PERIOD_MISSING", pendingPeriods: ["2026-06", "2026-07"], latestPostedPeriod: "2026-05" } };
    assert.equal(financeErrorMessage(pending), `${FINANCE_ERROR_MESSAGES.PREVIOUS_PERIOD_MISSING} Contabiliza antes: 2026-06, 2026-07.`);
    assert.equal(financeErrorMessage({ details: { code: "PREVIOUS_PERIOD_MISSING", pendingPeriods: [] } }), FINANCE_ERROR_MESSAGES.PREVIOUS_PERIOD_MISSING);
  });
});

describe("finance-contracts · query builders (mirror the zod query schemas)", () => {
  it("compactQuery drops empty values and sends booleans as 1/0", () => {
    assert.deepEqual(compactQuery({ a: "x", b: undefined, c: null, d: "", e: 0, f: true, g: false }), { a: "x", e: 0, f: "1", g: "0" });
  });

  it("journalQuery always asks for the envelope and never sends a null cursor", () => {
    assert.deepEqual(journalQuery(), { envelope: "1" });
    assert.deepEqual(journalQuery({ from: "2026-07-01", to: "2026-09-30", status: "posted", accountCode: "4300", q: "FAC-2026", limit: 100, cursor: null }), {
      from: "2026-07-01",
      to: "2026-09-30",
      status: "posted",
      accountCode: "4300",
      q: "FAC-2026",
      limit: 100,
      envelope: "1"
    });
    assert.equal(journalQuery({ cursor: "abc" }).cursor, "abc");
  });

  it("ledgerQuery and chart / list filters keep only the keys the routes accept", () => {
    assert.deepEqual(ledgerQuery({ from: "2026-01-01", propertyId: "p1" }, "csv"), { from: "2026-01-01", propertyId: "p1", format: "csv" });
    assert.deepEqual(ledgerQuery(), {});
    assert.deepEqual(supplierListQuery({ q: "Coca", active: true }), { q: "Coca", active: "true" });
    assert.deepEqual(supplierListQuery({ active: false, limit: 20 }), { active: "false", limit: 20 });
    assert.deepEqual(supplierBillListQuery({ status: "posted", dueBefore: "2026-10-01" }), { status: "posted", dueBefore: "2026-10-01" });
    assert.deepEqual(expenseListQuery({ paidWith: "cash", includeCancelled: true }), { paidWith: "cash", includeCancelled: "1" });
    assert.deepEqual(fixedAssetListQuery({ status: "active", q: "silla" }), { status: "active", q: "silla" });
    assert.deepEqual(treasuryScopeQuery({ propertyId: "p1", asOf: "2026-09-16" }), { propertyId: "p1", asOf: "2026-09-16" });
    assert.deepEqual(posTicketsQuery({ status: "closed", closedFrom: "2026-09-16", limit: 50 }), { status: "closed", closedFrom: "2026-09-16", limit: 50 });
    assert.deepEqual(cashClosureListQuery({ status: "open", outletId: "*" }), { status: "open", outletId: "*" });
    assert.deepEqual(vatBookQuery({ book: "emitidas", period: "2026-Q3" }), { book: "emitidas", period: "2026-Q3" });
  });

  it("fiscalModelQuery sends `year` to annual models (390 · 347 · 180) and `period` to the rest", () => {
    assert.deepEqual([...ANNUAL_FISCAL_MODELS], ["390", "347", "180"]);
    assert.deepEqual(fiscalModelQuery("303", { period: "2026-Q3", propertyId: "p1" }), { period: "2026-Q3", propertyId: "p1" });
    assert.deepEqual(fiscalModelQuery("111", { fromDate: "2026-07-01", toDate: "2026-09-30", periodType: "quarterly" }), { fromDate: "2026-07-01", toDate: "2026-09-30", periodType: "quarterly" });
    assert.deepEqual(fiscalModelQuery("390", { year: 2026 }), { year: "2026" });
    assert.deepEqual(fiscalModelQuery("347", { period: "2026-Q3" }), { year: "2026" }, "annual models derive the year from a period");
    assert.deepEqual(fiscalModelQuery("180", {}), {});
  });

  it("statement windows, comparative flag and the USALI periods parameter", () => {
    assert.deepEqual(statementWindowQuery({ from: "2026-01-01", to: "2026-06-30" }, "pdf"), { from: "2026-01-01", to: "2026-06-30", format: "pdf" });
    assert.deepEqual(annualAccountsQuery({ fiscalYearId: "fy1", comparative: true }), { fiscalYearId: "fy1", comparative: "1" });
    assert.deepEqual(annualAccountsQuery({ from: "2026-01-01", to: "2026-12-31", comparative: false }, "xlsx"), { from: "2026-01-01", to: "2026-12-31", comparative: "0", format: "xlsx" });
    assert.equal(
      usaliPeriodsParam([
        { from: "2026-01-01", to: "2026-03-31" },
        { from: "2026-04-01", to: "2026-06-30" }
      ]),
      "2026-01-01..2026-03-31,2026-04-01..2026-06-30"
    );
  });
});

describe("finance-contracts · settlement periods", () => {
  it("derives quarter, month and year codes from a calendar day (UTC, never the browser zone)", () => {
    assert.equal(quarterPeriod("2026-09-16"), "2026-Q3");
    assert.equal(quarterPeriod("2026-12-31"), "2026-Q4");
    assert.equal(quarterPeriod(new Date(Date.UTC(2026, 0, 1))), "2026-Q1");
    assert.equal(monthPeriod("2026-09-16"), "2026-09");
    assert.equal(yearPeriod("2026-09-16"), "2026");
  });

  it("periodBounds returns inclusive calendar bounds and rejects anything else", () => {
    assert.deepEqual(periodBounds("2026-Q3"), { code: "2026-Q3", type: "quarterly", from: "2026-07-01", to: "2026-09-30" });
    assert.deepEqual(periodBounds("2026-Q1"), { code: "2026-Q1", type: "quarterly", from: "2026-01-01", to: "2026-03-31" });
    assert.deepEqual(periodBounds("2028-02"), { code: "2028-02", type: "monthly", from: "2028-02-01", to: "2028-02-29" });
    assert.deepEqual(periodBounds(" 2026 "), { code: "2026", type: "annual", from: "2026-01-01", to: "2026-12-31" });
    assert.equal(periodBounds("2026-Q5"), null);
    assert.equal(periodBounds("2026-13"), null);
    assert.equal(periodBounds("Q3"), null);
  });

  it("previousPeriod steps back inside the same periodicity across year ends", () => {
    assert.equal(previousPeriod("2026-Q1"), "2025-Q4");
    assert.equal(previousPeriod("2026-Q3"), "2026-Q2");
    assert.equal(previousPeriod("2026-01"), "2025-12");
    assert.equal(previousPeriod("2026"), "2025");
    assert.equal(previousPeriod("nope"), null);
  });
});

describe("finance-contracts · cobros y descargas", () => {
  it("discriminates a captured payment from a PSP intent", () => {
    const captured = { kind: "payment", id: "pay_1", idempotent: false } as never;
    const intent = { kind: "payment_intent", intent: { id: "pi_1" }, redirect: { method: "GET", url: "https://psp.example/x" }, idempotent: false } as never;
    assert.ok(isCapturedPayment(captured));
    assert.ok(!isPaymentIntent(captured));
    assert.ok(isPaymentIntent(intent));
    assert.ok(!isCapturedPayment(intent));
  });

  it("newClientRequestId is unique per call", () => {
    const a = newClientRequestId();
    const b = newClientRequestId();
    assert.ok(a.length >= 8 && b.length >= 8);
    assert.notEqual(a, b);
  });

  it("downloadFilename reads plain and RFC 5987 file names and falls back otherwise", () => {
    assert.equal(downloadFilename('attachment; filename="diario-2026-07-01-2026-09-30.csv"', "x.csv"), "diario-2026-07-01-2026-09-30.csv");
    assert.equal(downloadFilename("inline; filename=modelo-303-2026-Q3.pdf", "x.pdf"), "modelo-303-2026-Q3.pdf");
    assert.equal(downloadFilename("attachment; filename*=UTF-8''cuentas%20anuales.xlsx", "x.xlsx"), "cuentas anuales.xlsx");
    assert.equal(downloadFilename(null, "factura.pdf"), "factura.pdf");
    assert.equal(downloadFilename("attachment", "factura.pdf"), "factura.pdf");
  });
});
