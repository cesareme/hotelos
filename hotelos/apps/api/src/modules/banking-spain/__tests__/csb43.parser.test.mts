// Unit tests · AEB Cuaderno 43 parser (lote tesoreria-banca). Fixture:
// fixtures/norma43-hotel-ejemplo.n43 — a synthetic, anonymised statement laid
// out strictly per the specification (80 columns; entity/office/account/owner
// fictitious). Run from apps/api with
//   node --import tsx --test src/modules/banking-spain/__tests__/csb43.parser.test.mts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { buildCcc, buildIban, ibanFromCcc, parseCsb43, parseCsb43File, reconcileMovements } from "../csb43.parser.js";
import { validateIban } from "../sepa-norma19.generator.js";

const FIXTURE = new URL("./fixtures/norma43-hotel-ejemplo.n43", import.meta.url);
const content = readFileSync(FIXTURE, "utf8");

describe("CSB43 · registro 11 (cabecera de cuenta)", () => {
  it("reads entity, office, account, dates, sign 2 = haber (positive opening balance), currency and owner", () => {
    const file = parseCsb43File(content);
    assert.equal(file.accounts.length, 1);
    const account = file.accounts[0]!;
    assert.equal(account.bankCode, "2100");
    assert.equal(account.branchCode, "0418");
    assert.equal(account.accountNumber, "0200051332");
    assert.equal(account.fromDate, "2026-09-01");
    assert.equal(account.toDate, "2026-09-05");
    assert.equal(account.initialBalanceCents, 1_250_000);
    assert.equal(account.initialBalance, 12500);
    assert.equal(account.currency, "EUR");
    assert.equal(account.ownerName, "HOTEL EJEMPLO SL");
  });

  it("derives the CCC control digits and a valid Spanish IBAN from the account", () => {
    const account = parseCsb43File(content).accounts[0]!;
    assert.equal(account.ccc.length, 20);
    assert.equal(account.ccc.slice(0, 8), "21000418");
    assert.equal(account.ccc.slice(10), "0200051332");
    assert.equal(account.iban.length, 24);
    assert.ok(account.iban.startsWith("ES"));
    assert.ok(validateIban(account.iban), `IBAN ${account.iban} must pass mod-97`);
    assert.equal(ibanFromCcc(account.ccc), account.iban);
    // Known reference: BBAN 2100 0418 45 0200051332 is the classic CCC example → ES91 2100 0418 4502 0005 1332.
    assert.equal(buildCcc("2100", "0418", "0200051332"), "21000418450200051332");
    assert.equal(buildIban("ES", "21000418450200051332"), "ES9121000418450200051332");
  });
});

describe("CSB43 · registro 22/23 (movimientos)", () => {
  const account = parseCsb43File(content).accounts[0]!;

  it("reads 6 movements with the AEB sign convention: 1 = debe (cargo, negative), 2 = haber (abono, positive)", () => {
    assert.equal(account.movements.length, 6);
    const [transfer, tpv, fee, supplier, payroll, commission] = account.movements;
    assert.deepEqual([transfer!.amountCents, transfer!.side], [250_000, "credit"]);
    assert.deepEqual([tpv!.amountCents, tpv!.side], [9_750, "credit"]);
    assert.deepEqual([fee!.amountCents, fee!.side], [-1_240, "debit"]);
    assert.deepEqual([supplier!.amountCents, supplier!.side], [-181_500, "debit"]);
    assert.deepEqual([payroll!.amountCents, payroll!.side], [-157_300, "debit"]);
    assert.deepEqual([commission!.amountCents, commission!.side], [-1_500, "debit"]);
    assert.equal(transfer!.amount, 2500);
    assert.equal(fee!.amount, -12.4);
  });

  it("reads operation/value dates, common and own concept codes, document and references at their positions", () => {
    const transfer = account.movements[0]!;
    assert.equal(transfer.operationDate, "2026-09-02");
    assert.equal(transfer.valueDate, "2026-09-02");
    assert.equal(transfer.conceptCode, "04");
    assert.equal(transfer.ownConceptCode, "000");
    assert.equal(transfer.documentNumber, "0");
    assert.equal(transfer.referenceA, null);
    assert.equal(transfer.referenceB, "RES-2026-0450");
    const fee = account.movements[2]!;
    assert.equal(fee.conceptCode, "17");
  });

  it("joins the two 38-char concept fields of every registro 23 and keeps them in order", () => {
    const transfer = account.movements[0]!;
    assert.deepEqual(transfer.descriptions, ["TRANSFERENCIA DE VIAJES NORTE SL RES-2026-0450 GRUPO SEPTIEMBRE"]);
    const supplier = account.movements[3]!;
    assert.deepEqual(supplier.descriptions, ["TRANSFERENCIA A SUMINISTROS NOROESTE PAGO FACTURA F-2026-118"]);
  });

  it("computes running balances in integer cents from the opening balance", () => {
    const running = account.movements.map((m) => m.runningBalanceCents);
    assert.deepEqual(running, [1_500_000, 1_509_750, 1_508_510, 1_327_010, 1_169_710, 1_168_210]);
    assert.equal(account.movements[5]!.runningBalance, 11682.1);
  });

  it("gives every movement a stable fingerprint, distinct even for identical movements", () => {
    const fingerprints = account.movements.map((m) => m.fingerprint);
    assert.equal(new Set(fingerprints).size, 6);
    assert.deepEqual(parseCsb43File(content).accounts[0]!.movements.map((m) => m.fingerprint), fingerprints, "re-parsing yields the same fingerprints");
    // Duplicate the first movement (and its concept line): the copy gets its own fingerprint.
    const lines = content.split("\n");
    const dup = [lines[0], lines[1], lines[2], lines[1], lines[2], ...lines.slice(3)].join("\n");
    const parsed = parseCsb43File(dup).accounts[0]!;
    assert.equal(parsed.movements.length, 7);
    assert.notEqual(parsed.movements[0]!.fingerprint, parsed.movements[1]!.fingerprint);
  });
});

describe("CSB43 · registro 33 / 88 (totales)", () => {
  it("reads counts, totals and the final balance and reports no warnings on a consistent file", () => {
    const file = parseCsb43File(content);
    const account = file.accounts[0]!;
    assert.equal(account.debitCount, 4);
    assert.equal(account.creditCount, 2);
    assert.equal(account.debitTotalCents, 341_540);
    assert.equal(account.creditTotalCents, 259_750);
    assert.equal(account.finalBalanceCents, 1_168_210);
    assert.equal(account.finalBalance, 11682.1);
    assert.equal(account.computedFinalBalanceCents, account.finalBalanceCents);
    assert.deepEqual(account.warnings, []);
    assert.equal(file.records, 15);
    assert.equal(file.declaredRecords, 14);
    assert.deepEqual(file.warnings, []);
  });

  it("warns (never silently) when the declared totals or the 88 count do not match", () => {
    const tampered = content.replace("0000400000000341540", "0000300000000341540").replace(/000014 *$/m, "000099");
    const file = parseCsb43File(tampered);
    assert.ok(file.accounts[0]!.warnings.some((w) => w.includes("apuntes declarados")), JSON.stringify(file.accounts[0]!.warnings));
    assert.ok(file.warnings.some((w) => w.includes("Registro 88")), JSON.stringify(file.warnings));
  });

  it("warns when the account has no closing 33 record and when a 22 precedes any 11", () => {
    const lines = content.split("\n").filter((l) => !l.startsWith("33") && !l.startsWith("88"));
    const file = parseCsb43File(lines.join("\n"));
    assert.ok(file.accounts[0]!.warnings.some((w) => w.includes("Falta el registro 33")));
    assert.equal(file.accounts[0]!.movements.every((m) => m.fingerprint.length === 40), true);
    const orphan = parseCsb43File(lines.slice(1).join("\n"));
    assert.equal(orphan.accounts.length, 0);
    assert.ok(orphan.warnings[0]!.includes("fuera de una cuenta"));
  });

  it("keeps the legacy parseCsb43 signature (accounts only)", () => {
    assert.equal(parseCsb43(content).length, 1);
  });
});

describe("CSB43 · conciliación en memoria (vista previa)", () => {
  it("matches inflows by exact cents + reference (high) or ±3 days (medium), never outflows", () => {
    const account = parseCsb43File(content).accounts[0]!;
    const result = reconcileMovements(account.movements, [
      { paymentId: "pay_transfer", amount: 2500, pspReference: "RES-2026-0450", createdAt: new Date("2026-09-10T00:00:00Z") },
      { paymentId: "pay_tpv", amount: 97.5, pspReference: null, createdAt: new Date("2026-09-04T00:00:00Z") },
      { paymentId: "pay_fee_lookalike", amount: 12.4, pspReference: null, createdAt: new Date("2026-09-03T00:00:00Z") }
    ]);
    assert.deepEqual(result.matches.map((m) => [m.movementIndex, m.paymentId, m.confidence]), [
      [0, "pay_transfer", "high"],
      [1, "pay_tpv", "medium"]
    ]);
    assert.deepEqual(result.unmatchedPayments, ["pay_fee_lookalike"]);
    assert.deepEqual(result.unmatchedMovements, [2, 3, 4, 5]);
  });
});
