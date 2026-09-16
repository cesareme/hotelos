// Unit tests of the pure helpers of the Proveedores, gastos e inmovilizado lot
// (Tanda 6 · Finanzas · lote 6-E). Run with the front unit command:
//   cd apps/api && TSX_TSCONFIG_PATH=../admin-web/tsconfig.json node --import tsx --test \
//     $(find ../admin-web/src -path '*/__tests__/*.test.mts')

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  accountLabel,
  accountOptions,
  addDays,
  amountOf,
  attachmentRejection,
  base64OfDataUrl,
  decimalInput,
  describeFailure,
  isExpenseAccount,
  isInvestmentAccount,
  isTreasuryAccount,
  maxCoefficientLabel,
  periodLabel,
  previousMonthPeriod,
  quotaOf,
  to2
} from "../payables-helpers";

const account = (code: string, name: string, isPostable = true) => ({
  id: code,
  code,
  name,
  kind: "expense",
  accountType: "expense",
  group: Number(code[0]),
  level: 3,
  isPostable,
  parentId: null,
  parentCode: code.slice(0, 2),
  usaliDepartment: null,
  usaliLine: null
});

describe("payables-helpers · decimales", () => {
  it("normalises es-ES and wire inputs to 2-decimal strings", () => {
    assert.equal(decimalInput("12,5"), "12.50");
    assert.equal(decimalInput("1.234,56"), "1234.56");
    assert.equal(decimalInput("100"), "100.00");
    assert.equal(decimalInput(" 0.21 "), "0.21");
  });

  it("rejects more than 2 decimals, text and empty input", () => {
    assert.equal(decimalInput("12.345"), null);
    assert.equal(decimalInput("12,345"), null);
    assert.equal(decimalInput("abc"), null);
    assert.equal(decimalInput(""), null);
  });

  it("amountOf tolerates wire strings and invalid input", () => {
    assert.equal(amountOf("106.00"), 106);
    assert.equal(amountOf("24,50"), 24.5);
    assert.equal(amountOf(""), 0);
    assert.equal(amountOf(null), 0);
  });

  it("quotaOf rounds to the cent like the API (half-up)", () => {
    assert.equal(quotaOf(100, 21), 21);
    assert.equal(quotaOf(1, 21), 0.21);
    assert.equal(quotaOf(10.05, 10), 1.01);
    assert.equal(to2(106), "106.00");
  });
});

describe("payables-helpers · fechas y periodos", () => {
  it("addDays proposes the due date from the payment term without a time-zone slide", () => {
    assert.equal(addDays("2026-09-10", 30), "2026-10-10");
    assert.equal(addDays("2026-12-31", 1), "2027-01-01");
  });

  it("previousMonthPeriod is the usual month to depreciate", () => {
    assert.equal(previousMonthPeriod("2026-09-16"), "2026-08");
    assert.equal(previousMonthPeriod("2026-01-05"), "2025-12");
  });

  it("periodLabel prints «mes año» in es-ES and leaves malformed codes alone", () => {
    assert.match(periodLabel("2026-08"), /ago.*2026/);
    assert.equal(periodLabel("2026"), "2026");
  });
});

describe("payables-helpers · adjuntos", () => {
  it("accepts PDF / JPEG / PNG up to 512 KiB and rejects the rest in Spanish", () => {
    assert.equal(attachmentRejection({ type: "application/pdf", size: 512 * 1024 }), null);
    assert.equal(attachmentRejection({ type: "image/png", size: 10 }), null);
    assert.match(attachmentRejection({ type: "image/gif", size: 10 }) ?? "", /PDF|JPEG|PNG/);
    assert.match(attachmentRejection({ type: "application/pdf", size: 512 * 1024 + 1 }) ?? "", /512 KiB/);
  });

  it("base64OfDataUrl strips the data: prefix", () => {
    assert.equal(base64OfDataUrl("data:application/pdf;base64,JVBERi0="), "JVBERi0=");
    assert.equal(base64OfDataUrl("JVBERi0="), "JVBERi0=");
  });
});

describe("payables-helpers · cuentas y errores", () => {
  it("filters the pickers by group and hides headers", () => {
    const chart = [account("6", "Compras y gastos", false), account("629", "Otros servicios"), account("216", "Mobiliario"), account("572", "Bancos"), account("4300", "Clientes"), account("600", "Compras")];
    assert.deepEqual(accountOptions(chart, isExpenseAccount).map((o) => o.value), ["600", "629"]);
    assert.deepEqual(accountOptions(chart, isInvestmentAccount).map((o) => o.value), ["216"]);
    assert.deepEqual(accountOptions(chart, isTreasuryAccount).map((o) => o.value), ["572"]);
    assert.equal(accountOptions(chart, isExpenseAccount)[1].label, "629 · Otros servicios");
    assert.equal(accountLabel(chart, "216"), "216 · Mobiliario");
    assert.equal(accountLabel(chart, "999"), "999");
    assert.equal(accountLabel(chart, null), "—");
  });

  it("maxCoefficientLabel formats the LIS table maximum", () => {
    assert.match(maxCoefficientLabel("mobiliario"), /^10\s?%$/);
    assert.match(maxCoefficientLabel("informatica"), /^25\s?%$/);
  });

  it("describeFailure keeps the details.code and maps it to the Spanish sentence", () => {
    const failure = describeFailure({ message: "raw", status: 409, details: { code: "PREVIOUS_PERIOD_MISSING", pendingPeriods: ["2026-07", "2026-08"] } }, "fallback");
    assert.equal(failure.code, "PREVIOUS_PERIOD_MISSING");
    assert.match(failure.message, /mes a mes/);
    assert.match(failure.message, /2026-07, 2026-08/);
    const plain = describeFailure(new Error("El archivo está vacío."), "fallback");
    assert.equal(plain.code, null);
    assert.equal(plain.message, "El archivo está vacío.");
    assert.equal(describeFailure(undefined, "fallback").message, "fallback");
  });
});
