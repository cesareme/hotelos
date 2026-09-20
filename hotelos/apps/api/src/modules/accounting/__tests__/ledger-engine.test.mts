// Unit tests of the pure parts of the ledger engine and the report builders
// (Finanzas · lote ledger). No database. Run from apps/api with
//   node --import tsx --test src/modules/accounting/__tests__/ledger-engine.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Prisma } from "@prisma/client";
import {
  JOURNAL_CSV_HEADER,
  csvCell,
  journalEntriesToCsv,
  ledgerToCsv,
  localDateInTz,
  money,
  moneyString,
  nextDay,
  normalizeJournalLines,
  previousDay,
  sumMoney,
  type AccountBalanceRow,
  type JournalEntryView
} from "../accounting.service.js";
import { trialBalanceRows } from "../trial-balance.service.js";
import { classifyBalanceSheet } from "../balance-sheet.service.js";
import { pnlFromBalances } from "../reporting.service.js";
import { formatReport, parseFlags, validateFlags } from "../../../scripts/accounting-replay.js";
import { cashSettlementOf } from "../projection.js";
import { CUSTOMER_ACCOUNT } from "../posting-rules.js";
import { formatPlan, parseFlags as parseRelabelFlags, validateFlags as validateRelabelFlags } from "../../../scripts/accounting-relabel-customer-account.js";
import { LEDGER_ERROR_CODES, CUSTOMER_ACCOUNT_CODE } from "../../../../../../packages/shared/src/accounting-types.js";

const D = Prisma.Decimal;

describe("cash settlement of a simplified invoice (t6#1)", () => {
  it("reads paidWith / posOrderId from the frozen snapshot, falls back to the linked ticket, never for F1 or a folio F2", () => {
    assert.deepEqual(cashSettlementOf({ simplified: true, snapshotJson: { version: 1, paidWith: "cash", posOrderId: "pos_1" } }, null), { paidWith: "cash", posOrderId: "pos_1" });
    assert.deepEqual(cashSettlementOf({ simplified: true, snapshotJson: { paidWith: "card_terminal", posOrderId: null } }, null), { paidWith: "card_terminal", posOrderId: null });
    assert.deepEqual(cashSettlementOf({ simplified: true, snapshotJson: { paidWith: "card_terminal" } }, { id: "pos_9", settlement: "card" }), { paidWith: "card_terminal", posOrderId: "pos_9" });
    assert.deepEqual(cashSettlementOf({ simplified: true, snapshotJson: null }, { id: "pos_2", settlement: "cash" }), { paidWith: "cash", posOrderId: "pos_2" });
    assert.equal(cashSettlementOf({ simplified: true, snapshotJson: { version: 1 } }, null), null, "a simplified invoice on a folio (no paidWith) keeps the receivable");
    assert.equal(cashSettlementOf({ simplified: true, snapshotJson: { paidWith: "bank_transfer" } }, null), null);
    assert.equal(cashSettlementOf({ simplified: false, snapshotJson: { paidWith: "cash", posOrderId: "pos_1" } }, { id: "pos_1", settlement: "cash" }), null, "never for an F1");
    assert.equal(cashSettlementOf({ simplified: true, snapshotJson: {} }, { id: "pos_3", settlement: "room" }), null, "a room charge is not settled in the act");
  });

  it("the ledger rules and the shared contract agree on 4300 and on FISCAL_YEAR_CLOSED (t6#3, t6#4)", () => {
    assert.equal(CUSTOMER_ACCOUNT, CUSTOMER_ACCOUNT_CODE);
    assert.equal(CUSTOMER_ACCOUNT_CODE, "4300");
    assert.ok(LEDGER_ERROR_CODES.includes("FISCAL_YEAR_CLOSED"));
    assert.ok(LEDGER_ERROR_CODES.includes("FISCAL_PERIOD_CLOSED"));
  });
});

describe("accounting-relabel-customer-account CLI (flags, dry-run by default)", () => {
  it("parses --org / --apply --confirm / --json, refuses apply without matching confirm", () => {
    const dry = parseRelabelFlags(["--org", "org_a", "--dry-run"]);
    assert.deepEqual(dry, { orgs: ["org_a"], apply: false, confirm: [], json: false, help: false });
    assert.doesNotThrow(() => validateRelabelFlags(dry));
    assert.throws(() => validateRelabelFlags(parseRelabelFlags(["--org", "org_a", "--apply"])), /--confirm/);
    assert.throws(() => validateRelabelFlags(parseRelabelFlags(["--org", "org_a", "--apply", "--confirm", "org_b"])), /does not match/);
    assert.throws(() => validateRelabelFlags(parseRelabelFlags([])), /--org/);
    assert.throws(() => parseRelabelFlags(["--bogus"]), /Unknown flag/);
    assert.equal(parseRelabelFlags(["-h"]).help, true);
    const apply = parseRelabelFlags(["--org", "org_a", "--org", "org_b", "--apply", "--confirm", "org_a", "--confirm", "org_b", "--json"]);
    assert.doesNotThrow(() => validateRelabelFlags(apply));
    assert.equal(apply.json, true);
  });

  it("formats a plan with its breakdown and blocking reasons", () => {
    const text = formatPlan({
      organizationId: "org_a",
      fromCode: "430",
      toCode: "4300",
      fromAccountId: "acc_430",
      toAccountId: "acc_4300",
      lines: 61,
      entries: 61,
      debit: "1487.00",
      credit: "1108.00",
      bySourceType: [{ sourceType: "invoice", entries: 22, lines: 22, debit: "1364.90", credit: "0.00" }],
      closedYearEntries: 0,
      blocking: []
    });
    assert.match(text, /plan \(dry-run\) · 430 → 4300/);
    assert.match(text, /líneas: 61 en 61 asientos · debe 1487.00 · haber 1108.00/);
    assert.match(text, /invoice\s+22 líneas/);
    const blocked = formatPlan({ organizationId: "org_a", fromCode: "430", toCode: "4300", fromAccountId: null, toAccountId: null, lines: 0, entries: 0, debit: "0.00", credit: "0.00", bySourceType: [], closedYearEntries: 2, blocking: ["TARGET_ACCOUNT_MISSING", "CLOSED_FISCAL_YEAR_ENTRIES"] });
    assert.match(blocked, /BLOQUEADO: TARGET_ACCOUNT_MISSING, CLOSED_FISCAL_YEAR_ENTRIES/);
    assert.match(blocked, /ejercicio cerrado: 2/);
  });
});

function code(error: unknown): string | undefined {
  return (error as { details?: { code?: string } }).details?.code;
}

describe("money helpers", () => {
  it("rounds HALF_UP to the cent and never floats", () => {
    assert.equal(moneyString("0.1"), "0.10");
    assert.equal(sumMoney(["0.1", "0.2"]).toFixed(2), "0.30");
    assert.equal(money(1.005).toFixed(2), "1.01");
    assert.equal(money("-1.005").toFixed(2), "-1.01");
    assert.equal(money(new D("12.345")).toFixed(2), "12.35");
    assert.throws(() => money("abc"), /no es un número válido/);
    assert.throws(() => money(Number.NaN), /no es un número válido/);
  });

  it("calendar day in the property time zone and day arithmetic", () => {
    // 23:30 UTC on 14/09 is 01:30 on 15/09 in Madrid (CEST) and 00:30 on 15/09 in Canarias (WEST).
    const instant = new Date("2026-09-14T23:30:00.000Z");
    assert.equal(localDateInTz(instant, "Europe/Madrid"), "2026-09-15");
    assert.equal(localDateInTz(instant, "Atlantic/Canary"), "2026-09-15");
    assert.equal(localDateInTz(new Date("2026-09-14T22:30:00.000Z"), "Atlantic/Canary"), "2026-09-14");
    assert.equal(localDateInTz(instant, "Not/AZone"), "2026-09-15");
    assert.equal(previousDay("2026-01-01"), "2025-12-31");
    assert.equal(nextDay("2026-12-31"), "2027-01-01");
  });
});

describe("normalizeJournalLines", () => {
  it("accepts balanced positive lines and rounds them", () => {
    const result = normalizeJournalLines([
      { accountCode: "430", debit: 121 },
      { accountCode: "705.1", credit: "110" },
      { accountCode: "477.10", credit: "11.004", taxRateCode: "10", taxBase: "110" }
    ]);
    assert.equal(result.totalDebit.toFixed(2), "121.00");
    assert.equal(result.totalCredit.toFixed(2), "121.00");
    assert.equal(result.lines[2]!.credit.toFixed(2), "11.00");
    assert.equal(result.lines[2]!.taxBase?.toFixed(2), "110.00");
  });

  it("rejects fewer than two lines, negative lines, both sides, unbalanced and bad codes with typed codes", () => {
    assert.throws(() => normalizeJournalLines([{ accountCode: "430", debit: 1 }]), (e: unknown) => code(e) === "JOURNAL_TOO_FEW_LINES");
    assert.throws(() => normalizeJournalLines([{ accountCode: "430", debit: -1 }, { accountCode: "570", credit: -1 }]), (e: unknown) => code(e) === "JOURNAL_NEGATIVE_LINE");
    assert.throws(() => normalizeJournalLines([{ accountCode: "430", debit: 1, credit: 1 }, { accountCode: "570", credit: 1 }]), (e: unknown) => code(e) === "JOURNAL_LINE_SIDE");
    assert.throws(() => normalizeJournalLines([{ accountCode: "430", debit: 1 }, { accountCode: "570", credit: 1.01 }]), (e: unknown) => code(e) === "JOURNAL_UNBALANCED");
    assert.throws(() => normalizeJournalLines([{ accountCode: "abc", debit: 1 }, { accountCode: "570", credit: 1 }]), (e: unknown) => code(e) === "ACCOUNT_CODE_INVALID");
    assert.throws(() => normalizeJournalLines([{ accountCode: "430", debit: 1 }, { accountCode: "570" }]), (e: unknown) => code(e) === "JOURNAL_LINE_SIDE");
  });
});

function entryView(overrides: Partial<JournalEntryView> = {}): JournalEntryView {
  return {
    id: "je_1",
    organizationId: "org",
    propertyId: null,
    entryNumber: 7,
    fiscalYearCode: "2026",
    fiscalYearId: null,
    entryDate: "2026-09-10",
    postedAt: null,
    status: "posted",
    entryKind: "normal",
    sourceType: "invoice",
    sourceId: "inv_1",
    description: "Factura FAC-1; con punto y coma",
    reference: "FAC-1",
    reversalOfId: null,
    reversedById: null,
    createdBy: null,
    currencyCode: "EUR",
    lines: [
      { id: "l1", accountId: "a1", accountCode: "430", accountName: "Clientes", debit: "121.00", credit: "0.00", description: null, taxRateCode: null, taxBase: null, costCenterId: null },
      { id: "l2", accountId: "a2", accountCode: "705.1", accountName: "Alojamiento", debit: "0.00", credit: "110.00", description: "Alojamiento", taxRateCode: "10", taxBase: null, costCenterId: null },
      { id: "l3", accountId: "a3", accountCode: "477.10", accountName: "IVA 10", debit: "0.00", credit: "11.00", description: "IVA 10 %", taxRateCode: "10", taxBase: "110.00", costCenterId: null }
    ],
    totalDebit: "121.00",
    totalCredit: "121.00",
    ...overrides
  };
}

describe("CSV exports", () => {
  it("diario: BOM, ; separator, comma decimals, quoted concept, one row per line", () => {
    const csv = journalEntriesToCsv([entryView()]);
    assert.ok(csv.startsWith("﻿"), "UTF-8 BOM");
    const rows = csv.slice(1).trimEnd().split("\r\n");
    assert.equal(rows[0], JOURNAL_CSV_HEADER.join(";"));
    assert.equal(rows.length, 4);
    assert.equal(rows[1], '2026-09-10;2026/7;430;"Factura FAC-1; con punto y coma";121,00;0,00;FAC-1;;;');
    assert.equal(rows[3], "2026-09-10;2026/7;477.10;IVA 10 %;0,00;11,00;FAC-1;;110,00;10");
  });

  it("csvCell neutraliza fórmulas (ACT-REV-05, paridad con real-estate/export.service.ts): =, +, -, @, tabulador y retorno al inicio", () => {
    assert.equal(csvCell("=1+1"), "\"'=1+1\"");
    assert.equal(csvCell("@SUM(A1)"), "\"'@SUM(A1)\"");
    assert.equal(csvCell("-cmd"), "\"'-cmd\"");
    assert.equal(csvCell("Factura FAC-1; con punto y coma"), "\"Factura FAC-1; con punto y coma\"");
    assert.equal(csvCell("FAC-1"), "FAC-1");
    assert.equal(csvCell(7), "7");
    assert.equal(csvCell(null), "");
  });

  it("mayor: opening, movements with running balance, closing", () => {
    const csv = ledgerToCsv({
      organizationId: "org",
      propertyId: null,
      accountCode: "430",
      accountName: "Clientes",
      kind: "asset",
      from: "2026-09-01",
      to: "2026-09-30",
      openingBalance: "10.00",
      movements: [{ journalEntryId: "je_1", entryNumber: 7, fiscalYearCode: "2026", entryDate: "2026-09-10", sourceType: "invoice", sourceId: "inv_1", description: "Factura", reference: "FAC-1", debit: "121.00", credit: "0.00", balance: "131.00" }],
      totals: { debit: "121.00", credit: "0.00" },
      closingBalance: "131.00",
      truncated: false
    });
    const rows = csv.slice(1).trimEnd().split("\r\n");
    assert.equal(rows[1], "2026-09-01;;430;Saldo inicial;;;10,00;");
    assert.equal(rows[2], "2026-09-10;2026/7;430;Factura;121,00;0,00;131,00;FAC-1");
    assert.equal(rows[3], "2026-09-30;;430;Saldo final;121,00;0,00;131,00;");
  });
});

function row(accountCode: string, kind: string, debit: string, credit: string, name = accountCode): AccountBalanceRow {
  return { accountId: `acc_${accountCode}`, accountCode, accountName: name, accountType: kind === "income" ? "revenue" : kind, kind, debit: new D(debit), credit: new D(credit) };
}

describe("report builders", () => {
  const rows = [
    row("430", "asset", "336.50", "121.00", "Clientes"),
    row("570", "asset", "121.00", "0.00", "Caja"),
    row("572", "asset", "201.08", "0.00", "Bancos"),
    row("216", "asset", "1000.00", "0.00", "Mobiliario"),
    row("2816", "asset", "0.00", "83.33", "AA mobiliario"),
    row("477.10", "liability", "0.00", "24.95"),
    row("4759", "liability", "0.00", "3.18"),
    row("410", "liability", "0.00", "30.00"),
    row("171", "liability", "0.00", "916.67", "Deuda LP"),
    row("100", "equity", "0.00", "300.00", "Capital"),
    row("705.1", "income", "0.00", "200.92"),
    row("705.2", "income", "0.00", "100.16"),
    row("629.1", "expense", "30.00", "0.00"),
    row("681", "expense", "83.33", "0.00"),
    row("662", "expense", "5.00", "0.00"),
    row("630", "expense", "3.30", "0.00")
  ];

  it("sumas y saldos: totals equal, saldo deudor / acreedor never both", () => {
    const built = trialBalanceRows(rows);
    assert.equal(built.totals.debit, built.totals.credit);
    assert.equal(built.balanced, true);
    const clientes = built.rows.find((r) => r.accountCode === "430")!;
    assert.deepEqual([clientes.debitBalance, clientes.creditBalance, clientes.balance], [215.5, 0, 215.5]);
    const iva = built.rows.find((r) => r.accountCode === "477.10")!;
    assert.deepEqual([iva.debitBalance, iva.creditBalance, iva.balance], [0, 24.95, 24.95]);
    assert.equal(built.totals.debitBalance, built.totals.creditBalance);
  });

  it("balance de situación: activo = pasivo + patrimonio (incl. resultado no regularizado)", () => {
    const sheet = classifyBalanceSheet(rows);
    assert.equal(sheet.assets.nonCurrent.map((i) => `${i.accountCode}:${i.amount}`).join(","), "216:1000,2816:-83.33");
    assert.equal(sheet.assets.current.map((i) => `${i.accountCode}:${i.amount}`).join(","), "430:215.5,570:121,572:201.08");
    assert.equal(sheet.assets.total, 1454.25);
    assert.equal(sheet.liabilities.nonCurrent[0]?.accountCode, "171");
    assert.equal(sheet.liabilities.total, 974.8);
    assert.equal(sheet.equity.retainedEarnings, 179.45);
    assert.equal(sheet.equity.total, 479.45);
    assert.equal(sheet.totalLiabPlusEquity, 1454.25);
    assert.equal(sheet.balanced, true);
  });

  it("PyG: headings, operating / financial / tax results", () => {
    const pnl = pnlFromBalances(rows.filter((r) => r.kind === "income" || r.kind === "expense"));
    assert.equal(pnl.revenueTotal, 301.08);
    assert.equal(pnl.expenseTotal, 121.63);
    assert.equal(pnl.netResult, 179.45);
    assert.equal(pnl.financialResult, -5);
    assert.equal(pnl.incomeTax, -3.3);
    assert.equal(pnl.operatingResult, 187.75);
    assert.equal(pnl.resultBeforeTax, 182.75);
    assert.deepEqual(pnl.sections.map((s) => `${s.code}:${s.total}`), ["1:301.08", "7:-30", "8:-83.33", "13:-5", "17:-3.3"]);
  });
});

describe("accounting:replay CLI flags", () => {
  it("parses and validates", () => {
    const flags = parseFlags(["--org", "org_1", "--from", "2026-07-01", "--to", "2026-09-30", "--kinds", "invoice,payment", "--json"]);
    assert.deepEqual(flags, { org: "org_1", property: null, from: "2026-07-01", to: "2026-09-30", kinds: ["invoice", "payment"], apply: false, confirm: null, json: true, help: false });
    assert.equal(validateFlags(flags), null);
    assert.match(validateFlags(parseFlags(["--org", "org_1"])) ?? "", /--from y --to/);
    assert.match(validateFlags(parseFlags(["--org", "org_1", "--from", "2026-09-30", "--to", "2026-07-01"])) ?? "", /from ≤ to/);
    assert.match(validateFlags(parseFlags(["--org", "org_1", "--from", "2026-07-01", "--to", "2026-09-30", "--apply"])) ?? "", /--confirm org_1/);
    assert.equal(validateFlags(parseFlags(["--org", "org_1", "--from", "2026-07-01", "--to", "2026-09-30", "--apply", "--confirm", "org_1"])), null);
    assert.throws(() => parseFlags(["--kinds", "expense"]), /Unknown kind/);
    assert.throws(() => parseFlags(["--bogus"]), /Unknown flag/);
    assert.equal(parseFlags(["-h"]).help, true);
  });

  it("formats a report", () => {
    const text = formatReport({
      organizationId: "org_1",
      propertyId: null,
      from: "2026-07-01",
      to: "2026-09-30",
      apply: false,
      kinds: ["invoice"],
      scanned: 1,
      posted: 0,
      existing: 0,
      wouldPost: 1,
      skipped: 0,
      failed: 0,
      items: [{ kind: "invoice", sourceType: "invoice", sourceId: "inv_1", reference: "FAC-2026-000001", entryDate: "2026-07-12", amount: "12.50", status: "would_post", journalEntryId: null, entryNumber: null, message: null, warnings: ["sin categoría"] }],
      balanced: null,
      generatedAt: "2026-09-15T00:00:00.000Z"
    });
    assert.match(text, /dry-run/);
    assert.match(text, /pendientes \(dry-run\) 1/);
    assert.match(text, /\[would_post\] 2026-07-12 invoice\s+FAC-2026-000001\s+12\.50 · avisos: sin categoría/);
  });
});
