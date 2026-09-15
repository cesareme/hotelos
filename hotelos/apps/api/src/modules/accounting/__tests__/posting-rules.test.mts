// Unit tests of the canonical posting rules (Finanzas · lote ledger). Pure:
// no database. Every case asserts the LITERAL lines of the asiento and that
// it balances to the cent. Run from apps/api with
//   node --import tsx --test src/modules/accounting/__tests__/posting-rules.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CUSTOMER_ACCOUNT,
  assertBalanced,
  buildCardSettlementEntry,
  cashSaleSourceId,
  cashSaleTreasuryAccount,
  issuanceSourceKeys,
  buildCashClosureDifferenceEntry,
  buildClosingEntry,
  buildCommissionAccrualEntry,
  buildCommissionSettlementEntry,
  buildDepreciationEntry,
  buildExpenseEntry,
  buildInvoiceEntry,
  buildInvoiceReversalEntry,
  buildOpeningEntry,
  buildPaymentEntry,
  buildPayrollPaymentEntry,
  buildPayrollSlipEntry,
  buildPosSaleEntry,
  buildRefundEntry,
  buildRegularizationEntry,
  buildSupplierBillEntry,
  buildSupplierBillPaymentEntry,
  buildVatSettlementEntry,
  splitGross,
  treasuryAccountFor,
  vatOutputAccount,
  type RuleEntry,
  type RuleLine
} from "../posting-rules.js";
import { Prisma } from "@prisma/client";
import { CUSTOMER_ACCOUNT_CODE } from "../../../../../../packages/shared/src/accounting-types.js";

const D = Prisma.Decimal;

/** `[account, debit, credit]` triples sorted by account then side — the literal cuadre of a case. */
function lines(entry: RuleEntry): Array<[string, string, string]> {
  return entry.lines.map((l): [string, string, string] => [l.accountCode, l.debit, l.credit]).sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]) || a[2].localeCompare(b[2]));
}

function totals(entry: RuleEntry): { debit: string; credit: string } {
  const sum = (side: "debit" | "credit") => entry.lines.reduce((acc, l) => acc.plus(l[side]), new D(0)).toFixed(2);
  return { debit: sum("debit"), credit: sum("credit") };
}

function line(entry: RuleEntry, accountCode: string): RuleLine {
  const found = entry.lines.find((l) => l.accountCode === accountCode);
  assert.ok(found, `line ${accountCode} present`);
  return found;
}

const ORG = "org_test";
const PROP = "prop_test";

describe("splitGross / helpers", () => {
  it("splits a gross amount HALF_UP per rate", () => {
    assert.deepEqual(splitGross(new D("121.00"), 21), { base: new D("100.00"), quota: new D("21.00") });
    assert.equal(splitGross(new D("12.10"), 10).base.toFixed(2), "11.00");
    assert.equal(splitGross(new D("12.50"), 21).base.toFixed(2), "10.33");
    assert.equal(splitGross(new D("12.50"), 21).quota.toFixed(2), "2.17");
    assert.equal(splitGross(new D("-50.00"), 10).base.toFixed(2), "-45.45");
    assert.equal(splitGross(new D("-50.00"), 10).quota.toFixed(2), "-4.55");
    assert.equal(splitGross(new D("30.00"), 0).quota.toFixed(2), "0.00");
  });

  it("maps rates to 477.xx and methods to treasury accounts", () => {
    assert.equal(vatOutputAccount(21), "477.21");
    assert.equal(vatOutputAccount(10), "477.10");
    assert.equal(vatOutputAccount(4), "477.04");
    assert.equal(vatOutputAccount(7), "477.07");
    assert.deepEqual(treasuryAccountFor("cash", null), { accountCode: "570", warning: null });
    assert.deepEqual(treasuryAccountFor("card_terminal", "card"), { accountCode: "5721", warning: null });
    assert.deepEqual(treasuryAccountFor(null, "card"), { accountCode: "5721", warning: null });
    assert.deepEqual(treasuryAccountFor(null, "bank_transfer"), { accountCode: "572", warning: null });
    assert.deepEqual(treasuryAccountFor("payment_link", null), { accountCode: "5722", warning: null });
    assert.deepEqual(treasuryAccountFor(null, "ota_virtual_card"), { accountCode: "5721", warning: null });
    const unknown = treasuryAccountFor(null, "cheque");
    assert.equal(unknown.accountCode, "572");
    assert.match(unknown.warning ?? "", /desconocido/);
  });
});

describe("Factura emitida (D 4300 / H 705.x / H 477.tipo)", () => {
  it("121,00 € alojamiento 10 % → 4300 121,00 / 705.1 110,00 / 477.10 11,00", () => {
    const entry = buildInvoiceEntry({
      organizationId: ORG,
      propertyId: PROP,
      invoiceId: "inv_1",
      invoiceNumber: "FAC-2026-000001",
      entryDate: "2026-09-10",
      customerName: "Cliente Prueba",
      lines: [{ description: "Alojamiento 1 noche", total: "121.00", ratePercent: 10, category: "accommodation" }],
      total: "121.00",
      taxTotal: "11.00",
      kind: "issued"
    });
    assert.deepEqual(lines(entry), [
      ["4300", "121.00", "0.00"],
      ["477.10", "0.00", "11.00"],
      ["705.1", "0.00", "110.00"]
    ]);
    assert.deepEqual(totals(entry), { debit: "121.00", credit: "121.00" });
    assert.equal(entry.sourceType, "invoice");
    assert.equal(entry.sourceId, "inv_1");
    assert.equal(entry.reference, "FAC-2026-000001");
    assert.equal(line(entry, "477.10").taxRateCode, "10");
    assert.equal(line(entry, "477.10").taxBase, "110.00");
    assert.equal(line(entry, "705.1").taxRateCode, "10");
    assert.deepEqual(entry.warnings, []);
    assert.match(entry.description, /Factura FAC-2026-000001 · Cliente Prueba/);
  });

  it("mixed departments and rates: bases by department, quotas by rate, tourist tax to 4759, N1 without quota", () => {
    // Faranda FAC-2026-000016 as issued: 100 alojamiento 10 % + 10 minibar 10 % + 40 restaurante 10 % + 30 spa 21 % + 12 parking 21 % + 3,50 tasa 10 % + 20 no sujeta.
    const entry = buildInvoiceEntry({
      organizationId: ORG,
      propertyId: PROP,
      invoiceId: "inv_16",
      invoiceNumber: "FAC-2026-000016",
      entryDate: "2026-09-14",
      lines: [
        { description: "Alojamiento", total: "100.00", ratePercent: 10, category: "accommodation" },
        { description: "Minibar", total: "10.00", ratePercent: 10, category: "food_beverage" },
        { description: "Restaurante", total: "40.00", ratePercent: 10, category: "food_beverage" },
        { description: "Spa", total: "30.00", ratePercent: 21, category: "general_services" },
        { description: "Parking", total: "12.00", ratePercent: 21, category: "general_services" },
        { description: "Tasa turística", total: "3.50", ratePercent: 10, category: "tourist_tax" },
        { description: "Penalización no-show", total: "20.00", ratePercent: 0, calificacion: "N1", category: "not_subject" }
      ],
      breakdown: [
        { figure: "IVA", calificacion: "S1", ratePercent: 21, base: "34.71", quota: "7.29" },
        { figure: "IVA", calificacion: "S1", ratePercent: 10, base: "139.55", quota: "13.95" },
        { figure: "IVA", calificacion: "N1", ratePercent: 0, base: "20.00", quota: "0.00" }
      ],
      total: "215.50",
      taxTotal: "21.24",
      kind: "issued"
    });
    // Group 10 %: 153.50 gross → base 139.55 (100→90.91, 10→9.09, 40→36.36, 3.50→3.18 = 139.54; the cent goes to the largest line).
    // Revenue lines are split by (account, rate) so each carries its taxRateCode: 705.3 at 21 % (34.71) and 705.3 not subject (20.00).
    assert.deepEqual(lines(entry), [
      ["4300", "215.50", "0.00"],
      ["4759", "0.00", "3.18"],
      ["477.10", "0.00", "13.95"],
      ["477.21", "0.00", "7.29"],
      ["705.1", "0.00", "90.92"],
      ["705.2", "0.00", "45.45"],
      ["705.3", "0.00", "20.00"],
      ["705.3", "0.00", "34.71"]
    ]);
    assert.deepEqual(entry.lines.filter((l) => l.accountCode === "705.3").map((l) => l.taxRateCode).sort(), ["0", "21"]);
    assert.deepEqual(totals(entry), { debit: "215.50", credit: "215.50" });
    assert.equal(line(entry, "477.21").taxBase, "34.71");
    assert.deepEqual(entry.warnings, []);
  });

  it("legacy line without category posts to 705 with a warning; unknown-tax line at 0 % warns too", () => {
    const entry = buildInvoiceEntry({
      organizationId: ORG,
      propertyId: PROP,
      invoiceId: "inv_5",
      invoiceNumber: "FAC-2026-000005",
      entryDate: "2026-09-14",
      lines: [{ description: "AUDIT-T2 cargo facturable", total: "12.10", ratePercent: 0, category: null }],
      total: "12.10",
      taxTotal: "0.00",
      kind: "issued"
    });
    assert.deepEqual(lines(entry), [
      ["4300", "12.10", "0.00"],
      ["705", "0.00", "12.10"]
    ]);
    assert.equal(entry.warnings.length, 2);
    assert.match(entry.warnings[0]!, /sin tipo impositivo/);
    assert.match(entry.warnings[1]!, /sin categoría fiscal: contabilizada en 705/);
  });

  it("refuses an invoice whose header does not match its lines (INVOICE_TOTALS_MISMATCH)", () => {
    assert.throws(
      () =>
        buildInvoiceEntry({
          organizationId: ORG,
          propertyId: PROP,
          invoiceId: "inv_bad",
          invoiceNumber: null,
          entryDate: "2026-09-14",
          lines: [{ total: "121.00", ratePercent: 10, category: "accommodation" }],
          total: "121.00",
          taxTotal: "21.00",
          kind: "issued"
        }),
      (error: unknown) => (error as { details?: { code?: string } }).details?.code === "INVOICE_TOTALS_MISMATCH"
    );
  });
});

describe("Rectificativa y anulación (sentido contrario, importes positivos)", () => {
  it("rectificativa por diferencias −50,00 € alojamiento 10 % → 705.1 45,45 / 477.10 4,55 / 4300 50,00", () => {
    const entry = buildInvoiceEntry({
      organizationId: ORG,
      propertyId: PROP,
      invoiceId: "rect_2",
      invoiceNumber: "REC-2026-000002",
      entryDate: "2026-09-14",
      lines: [{ description: "Reversión: habitación", total: "-50.00", ratePercent: 10, category: "accommodation" }],
      breakdown: [{ figure: "IVA", calificacion: "S1", ratePercent: 10, base: "-45.45", quota: "-4.55" }],
      total: "-50.00",
      taxTotal: "-4.55",
      kind: "rectification",
      rectifyingForId: "inv_15",
      rectifyingForNumber: "FAC-2026-000015"
    });
    assert.deepEqual(lines(entry), [
      ["4300", "0.00", "50.00"],
      ["477.10", "4.55", "0.00"],
      ["705.1", "45.45", "0.00"]
    ]);
    assert.equal(entry.sourceType, "invoice_rectification");
    assert.ok(entry.lines.every((l) => !l.debit.startsWith("-") && !l.credit.startsWith("-")), "never a negative line");
    assert.match(entry.description, /rectifica FAC-2026-000015/);
  });

  it("anulación = inverse of the issuance entry, balanced", () => {
    const doc = {
      organizationId: ORG,
      propertyId: PROP,
      invoiceId: "inv_3",
      invoiceNumber: "FAC-2026-000003",
      entryDate: "2026-09-13",
      lines: [
        { description: "minibar", total: "12.10", ratePercent: 21, category: null },
        { description: "noche", total: "110.00", ratePercent: 10, category: "accommodation" }
      ],
      total: "122.10",
      taxTotal: "12.10",
      kind: "issued" as const
    };
    const issued = buildInvoiceEntry(doc);
    const reversal = buildInvoiceReversalEntry(doc, { sourceType: "invoice_cancellation", sourceId: "inv_3", entryDate: "2026-09-15", reason: "error" });
    assert.deepEqual(lines(issued), [
      ["4300", "122.10", "0.00"],
      ["477.10", "0.00", "10.00"],
      ["477.21", "0.00", "2.10"],
      ["705", "0.00", "10.00"],
      ["705.1", "0.00", "100.00"]
    ]);
    assert.deepEqual(lines(reversal), [
      ["4300", "0.00", "122.10"],
      ["477.10", "10.00", "0.00"],
      ["477.21", "2.10", "0.00"],
      ["705", "10.00", "0.00"],
      ["705.1", "100.00", "0.00"]
    ]);
    assert.equal(reversal.entryKind, "reversal");
    assert.equal(reversal.entryDate, "2026-09-15");
  });
});

describe("Venta al contado con factura simplificada (t6#1: un solo asiento pos_ticket, nunca 4300)", () => {
  const simplified = {
    organizationId: ORG,
    propertyId: PROP,
    invoiceId: "inv_sim_1",
    invoiceNumber: "SIM-2026-000007",
    entryDate: "2026-09-16",
    lines: [{ description: "Menú", total: "12.00", ratePercent: 10, category: "food_beverage" }],
    breakdown: [{ figure: "IVA", calificacion: "S1", ratePercent: 10, base: "10.91", quota: "1.09" }],
    total: "12.00",
    taxTotal: "1.09",
    kind: "simplified" as const
  };

  it("the customer account of every rule is the shared 4300 (t6#4)", () => {
    assert.equal(CUSTOMER_ACCOUNT, "4300");
    assert.equal(CUSTOMER_ACCOUNT, CUSTOMER_ACCOUNT_CODE);
    assert.equal(cashSaleTreasuryAccount("cash"), "570");
    assert.equal(cashSaleTreasuryAccount("card_terminal"), "5721");
  });

  it("ticket 12,00 € menú 10 % en efectivo → 570 12,00 / 705.2 10,91 / 477.10 1,09 keyed pos_ticket/<ticket>", () => {
    const entry = buildInvoiceEntry({ ...simplified, settledInAct: { paidWith: "cash", posOrderId: "pos_631ea95e" } });
    assert.deepEqual(lines(entry), [
      ["477.10", "0.00", "1.09"],
      ["570", "12.00", "0.00"],
      ["705.2", "0.00", "10.91"]
    ]);
    assert.deepEqual(totals(entry), { debit: "12.00", credit: "12.00" });
    assert.equal(entry.sourceType, "pos_ticket", "same key as the synchronous TPV entry");
    assert.equal(entry.sourceId, "pos_631ea95e");
    assert.ok(!entry.lines.some((l) => l.accountCode === "4300"), "a sale settled in the act never touches the receivable");
    assert.match(entry.description, /Venta al contado SIM-2026-000007 \(efectivo\)/);
    assert.equal(line(entry, "477.10").taxBase, "10.91");
  });

  it("datáfono → 5721; without a ticket the key is pos_ticket/<invoiceId>; the inverse returns the treasury", () => {
    const walkIn = buildInvoiceEntry({ ...simplified, invoiceId: "inv_sim_2", settledInAct: { paidWith: "card_terminal", posOrderId: null } });
    assert.equal(line(walkIn, "5721").debit, "12.00");
    assert.equal(walkIn.sourceType, "pos_ticket");
    assert.equal(walkIn.sourceId, "inv_sim_2");
    const reversal = buildInvoiceReversalEntry({ ...simplified, invoiceId: "inv_sim_2", settledInAct: { paidWith: "card_terminal", posOrderId: null } }, { sourceType: "invoice_cancellation", sourceId: "inv_sim_2", entryDate: "2026-09-17", reason: "error" });
    assert.deepEqual(lines(reversal), [
      ["477.10", "1.09", "0.00"],
      ["5721", "0.00", "12.00"],
      ["705.2", "10.91", "0.00"]
    ]);
    assert.equal(reversal.sourceType, "invoice_cancellation");
  });

  it("issuance keys: pos_ticket/<ticket> then pos_ticket/<invoice> when settled in the act; invoice / rectification otherwise", () => {
    assert.deepEqual(issuanceSourceKeys({ invoiceId: "inv_a", kind: "simplified", settledInAct: { paidWith: "cash", posOrderId: "pos_1" } }), [
      { sourceType: "pos_ticket", sourceId: "pos_1" },
      { sourceType: "pos_ticket", sourceId: "inv_a" }
    ]);
    assert.deepEqual(issuanceSourceKeys({ invoiceId: "inv_b", kind: "simplified", settledInAct: { paidWith: "cash", posOrderId: null } }), [{ sourceType: "pos_ticket", sourceId: "inv_b" }]);
    assert.deepEqual(issuanceSourceKeys({ invoiceId: "inv_c", kind: "issued", settledInAct: null }).map((k) => k.sourceType), ["invoice", "invoice_rectification"]);
    assert.deepEqual(issuanceSourceKeys({ invoiceId: "inv_d", kind: "rectification" }).map((k) => k.sourceType), ["invoice_rectification", "invoice"]);
    assert.equal(cashSaleSourceId({ invoiceId: "inv_e", settledInAct: null }), "inv_e");
  });

  it("an F1 (folio) invoice flagged as settled in the act is refused: a cash sale needs a simplified invoice", () => {
    assert.throws(
      () => buildInvoiceEntry({ ...simplified, kind: "issued", settledInAct: { paidWith: "cash", posOrderId: "pos_x" } }),
      (e: unknown) => (e as { details?: { code?: string } }).details?.code === "INVOICE_CASH_SALE_NOT_SIMPLIFIED"
    );
    const plain = buildInvoiceEntry({ ...simplified, settledInAct: null });
    assert.equal(line(plain, "4300").debit, "12.00", "a simplified invoice on a folio keeps the receivable");
    assert.equal(plain.sourceType, "invoice");
  });
});

describe("Cobros, devoluciones y TPV", () => {
  it("cobro en efectivo 121,00 → 570 121,00 / 4300 121,00; tarjeta → 5721; transferencia → 572", () => {
    const cash = buildPaymentEntry({ organizationId: ORG, propertyId: PROP, paymentId: "pay_1", entryDate: "2026-09-10", amount: 121, methodCode: "cash", reference: "FAC-2026-000001" });
    assert.deepEqual(lines(cash), [
      ["4300", "0.00", "121.00"],
      ["570", "121.00", "0.00"]
    ]);
    assert.equal(cash.sourceType, "payment");
    const card = buildPaymentEntry({ organizationId: ORG, propertyId: PROP, paymentId: "pay_2", entryDate: "2026-09-10", amount: "70.00", methodCode: null, method: "card" });
    assert.deepEqual(lines(card), [
      ["4300", "0.00", "70.00"],
      ["5721", "70.00", "0.00"]
    ]);
    const transfer = buildPaymentEntry({ organizationId: ORG, propertyId: PROP, paymentId: "pay_3", entryDate: "2026-09-10", amount: "22.10", methodCode: "bank_transfer" });
    assert.equal(line(transfer, "572").debit, "22.10");
  });

  it("devolución 20,00 con tarjeta → 4300 20,00 / 5721 20,00 keyed by the refund id", () => {
    const refund = buildRefundEntry({ organizationId: ORG, propertyId: PROP, paymentId: "pay_2", refundId: "ref_1", entryDate: "2026-09-14", amount: "20.00", methodCode: "card_terminal" });
    assert.deepEqual(lines(refund), [
      ["4300", "20.00", "0.00"],
      ["5721", "0.00", "20.00"]
    ]);
    assert.equal(refund.sourceType, "payment_refund");
    assert.equal(refund.sourceId, "ref_1");
  });

  it("venta TPV al contado 12,10 € restaurante 10 % → 570 12,10 / 705.2 11,00 / 477.10 1,10", () => {
    const sale = buildPosSaleEntry({ organizationId: ORG, propertyId: PROP, orderId: "pos_1", entryDate: "2026-09-12", total: "12.10", taxTotal: "1.10", ratePercent: 10, settlement: "cash", outletType: "restaurant" });
    assert.deepEqual(lines(sale), [
      ["477.10", "0.00", "1.10"],
      ["570", "12.10", "0.00"],
      ["705.2", "0.00", "11.00"]
    ]);
    assert.deepEqual(sale.warnings, []);
    const spa = buildPosSaleEntry({ organizationId: ORG, propertyId: PROP, orderId: "pos_2", entryDate: "2026-09-12", total: "60.50", taxTotal: null, ratePercent: 21, settlement: "card", outletType: "spa" });
    assert.deepEqual(lines(spa), [
      ["477.21", "0.00", "10.50"],
      ["5721", "60.50", "0.00"],
      ["705.3", "0.00", "50.00"]
    ]);
    assert.equal(spa.warnings.length, 1);
  });
});

describe("Factura recibida, pago y gasto", () => {
  it("factura de profesional 1.000 + 21 % − 15 % → 623 1.000 / 472.21 210 / 4751 150 / 400 1.060", () => {
    const bill = buildSupplierBillEntry({
      organizationId: ORG,
      billId: "sb_1",
      entryDate: "2026-09-05",
      supplierName: "Asesoría López",
      invoiceNumber: "A-2026-17",
      lines: [{ description: "Honorarios", expenseAccountCode: "623", base: "1000.00", taxRate: 21, quota: "210.00", retention: "150.00" }],
      total: "1060.00"
    });
    assert.deepEqual(lines(bill), [
      ["400", "0.00", "1060.00"],
      ["472.21", "210.00", "0.00"],
      ["4751", "0.00", "150.00"],
      ["623", "1000.00", "0.00"]
    ]);
    assert.equal(line(bill, "472.21").taxBase, "1000.00");
    assert.equal(bill.sourceType, "supplier_bill");
  });

  it("multi-line bill aggregates by expense account and rate; non-deductible VAT goes to the expense", () => {
    const bill = buildSupplierBillEntry({
      organizationId: ORG,
      billId: "sb_2",
      entryDate: "2026-09-05",
      supplierName: "Suministros SA",
      lines: [
        { expenseAccountCode: "628", base: "100.00", taxRate: 21, quota: "21.00" },
        { expenseAccountCode: "628", base: "50.00", taxRate: 21, quota: "10.50" },
        { expenseAccountCode: "622", base: "200.00", taxRate: 10, quota: "20.00" }
      ],
      total: "401.50",
      payableAccountCode: "410"
    });
    assert.deepEqual(lines(bill), [
      ["410", "0.00", "401.50"],
      ["472.10", "20.00", "0.00"],
      ["472.21", "31.50", "0.00"],
      ["622", "200.00", "0.00"],
      ["628", "150.00", "0.00"]
    ]);
    const nonDeductible = buildSupplierBillEntry({ organizationId: ORG, billId: "sb_3", entryDate: "2026-09-05", supplierName: "Bar", lines: [{ expenseAccountCode: "629", base: "10.00", taxRate: 10, quota: "1.00" }], total: "11.00", vatDeductible: false });
    assert.deepEqual(lines(nonDeductible), [
      ["400", "0.00", "11.00"],
      ["629", "11.00", "0.00"]
    ]);
    assert.throws(() => buildSupplierBillEntry({ organizationId: ORG, billId: "sb_bad", entryDate: "2026-09-05", supplierName: "X", lines: [{ expenseAccountCode: "622", base: "100.00", taxRate: 21, quota: "21.00" }], total: "100.00" }), (e: unknown) => (e as { details?: { code?: string } }).details?.code === "SUPPLIER_BILL_TOTALS_MISMATCH");
  });

  it("pago a proveedor 1.060 por banco → 400 1.060 / 572 1.060; gasto ticket 24,20 en efectivo → 629 20 / 472.21 4,20 / 570 24,20", () => {
    const payment = buildSupplierBillPaymentEntry({ organizationId: ORG, billId: "sb_1", entryDate: "2026-09-20", amount: "1060.00", paidWith: "bank", supplierName: "Asesoría López", invoiceNumber: "A-2026-17" });
    assert.deepEqual(lines(payment), [
      ["400", "1060.00", "0.00"],
      ["572", "0.00", "1060.00"]
    ]);
    assert.equal(payment.sourceType, "supplier_bill_payment");
    const expense = buildExpenseEntry({ organizationId: ORG, expenseId: "exp_1", entryDate: "2026-09-21", accountCode: "629", base: "20.00", taxRate: 21, quota: "4.20", total: "24.20", paidWith: "cash", vatDeductible: true, supplierName: "Ferretería", concept: "Bombillas" });
    assert.deepEqual(lines(expense), [
      ["472.21", "4.20", "0.00"],
      ["570", "0.00", "24.20"],
      ["629", "20.00", "0.00"]
    ]);
    const noVat = buildExpenseEntry({ organizationId: ORG, expenseId: "exp_2", entryDate: "2026-09-21", accountCode: "629", base: "20.00", taxRate: 21, quota: "4.20", total: "24.20", paidWith: "card", vatDeductible: false, supplierName: "Ferretería", concept: "Bombillas" });
    assert.deepEqual(lines(noVat), [
      ["5721", "0.00", "24.20"],
      ["629", "24.20", "0.00"]
    ]);
  });
});

describe("Nómina, comisiones, amortización, IVA, datáfono, arqueo", () => {
  it("nómina 2.000 bruto, SS empresa 600, IRPF 300, SS trabajador 127 → 640 2.000 / 642 600 / 4751 300 / 476 727 / 465 1.573", () => {
    const slip = buildPayrollSlipEntry({ organizationId: ORG, slipId: "slip_1", periodCode: "2026-09", entryDate: "2026-09-30", grossSalary: "2000.00", ssEmployer: "600.00", irpfRetention: "300.00", ssEmployee: "127.00", netSalary: "1573.00" });
    assert.deepEqual(lines(slip), [
      ["465", "0.00", "1573.00"],
      ["4751", "0.00", "300.00"],
      ["476", "0.00", "727.00"],
      ["640", "2000.00", "0.00"],
      ["642", "600.00", "0.00"]
    ]);
    assert.deepEqual(totals(slip), { debit: "2600.00", credit: "2600.00" });
    assert.throws(() => buildPayrollSlipEntry({ organizationId: ORG, slipId: "slip_bad", periodCode: "2026-09", entryDate: "2026-09-30", grossSalary: "2000.00", ssEmployer: "600.00", irpfRetention: "300.00", ssEmployee: "127.00", netSalary: "1500.00" }), (e: unknown) => (e as { details?: { code?: string } }).details?.code === "PAYROLL_SLIP_MISMATCH");
    const pay = buildPayrollPaymentEntry({ organizationId: ORG, periodId: "per_1", periodCode: "2026-09", entryDate: "2026-09-30", amount: "1573.00" });
    assert.deepEqual(lines(pay), [
      ["465", "1573.00", "0.00"],
      ["572", "0.00", "1573.00"]
    ]);
  });

  it("comisión Booking 15 % sobre 200 → 629.1 30,00 / 410 30,00; liquidación → 410 / 572", () => {
    const accrual = buildCommissionAccrualEntry({ organizationId: ORG, propertyId: PROP, accrualId: "acc_1", entryDate: "2026-09-12", channelCode: "booking", amount: "30.00", baseAmount: "200.00", ratePct: "15.00", reference: "RES-1" });
    assert.deepEqual(lines(accrual), [
      ["410", "0.00", "30.00"],
      ["629.1", "30.00", "0.00"]
    ]);
    assert.match(accrual.description, /Comisión booking 15 % sobre 200.00 · RES-1/);
    const settlement = buildCommissionSettlementEntry({ organizationId: ORG, propertyId: PROP, settlementId: "set_1", entryDate: "2026-10-01", channelCode: "booking", amount: "30.00" });
    assert.deepEqual(lines(settlement), [
      ["410", "30.00", "0.00"],
      ["572", "0.00", "30.00"]
    ]);
  });

  it("amortización mensual: 681 agregada / 28xx por elemento", () => {
    const run = buildDepreciationEntry({
      organizationId: ORG,
      runId: "run_2026_09",
      period: "2026-09",
      entryDate: "2026-09-30",
      lines: [
        { fixedAssetId: "fa_1", name: "Mobiliario recepción", amount: "83.33", expenseAccountCode: "681", depreciationAccountCode: "2816" },
        { fixedAssetId: "fa_2", name: "Servidor", amount: "41.67", expenseAccountCode: "681", depreciationAccountCode: "2817" },
        { fixedAssetId: "fa_3", name: "PMS licencia", amount: "20.00", expenseAccountCode: "680", depreciationAccountCode: "2806" }
      ]
    });
    assert.deepEqual(lines(run), [
      ["2806", "0.00", "20.00"],
      ["2816", "0.00", "83.33"],
      ["2817", "0.00", "41.67"],
      ["680", "20.00", "0.00"],
      ["681", "125.00", "0.00"]
    ]);
    assert.equal(run.sourceType, "depreciation");
  });

  it("liquidación de IVA a ingresar y a compensar", () => {
    const toPay = buildVatSettlementEntry({ organizationId: ORG, period: "2026-Q3", entryDate: "2026-09-30", output: [{ ratePercent: 21, amount: "700.00" }, { ratePercent: 10, amount: "1200.00" }], input: [{ ratePercent: 21, amount: "400.00" }] });
    assert.deepEqual(lines(toPay), [
      ["472.21", "0.00", "400.00"],
      ["4750", "0.00", "1500.00"],
      ["477.10", "1200.00", "0.00"],
      ["477.21", "700.00", "0.00"]
    ]);
    const toCompensate = buildVatSettlementEntry({ organizationId: ORG, period: "2026-Q1", entryDate: "2026-03-31", output: [{ ratePercent: 10, amount: "100.00" }], input: [{ ratePercent: 21, amount: "250.00" }] });
    assert.deepEqual(lines(toCompensate), [
      ["4700", "150.00", "0.00"],
      ["472.21", "0.00", "250.00"],
      ["477.10", "100.00", "0.00"]
    ]);
    assert.equal(toPay.sourceId, `${ORG}:2026-Q3`);
  });

  it("liquidación datáfono 1.000 con 1,2 % → 572 988 / 626 12 / 5721 1.000; arqueo faltante y sobrante", () => {
    const card = buildCardSettlementEntry({ organizationId: ORG, propertyId: PROP, settlementId: "cs_1", entryDate: "2026-09-16", gross: "1000.00", fee: "12.00", reference: "Lote 42" });
    assert.deepEqual(lines(card), [
      ["572", "988.00", "0.00"],
      ["5721", "0.00", "1000.00"],
      ["626", "12.00", "0.00"]
    ]);
    const shortage = buildCashClosureDifferenceEntry({ organizationId: ORG, propertyId: PROP, closureId: "cc_1", entryDate: "2026-09-16", difference: "-3.50" });
    assert.deepEqual(lines(shortage), [
      ["570", "0.00", "3.50"],
      ["659", "3.50", "0.00"]
    ]);
    const surplus = buildCashClosureDifferenceEntry({ organizationId: ORG, propertyId: PROP, closureId: "cc_2", entryDate: "2026-09-17", difference: "1.20" });
    assert.deepEqual(lines(surplus), [
      ["570", "1.20", "0.00"],
      ["759", "0.00", "1.20"]
    ]);
    assert.throws(() => buildCashClosureDifferenceEntry({ organizationId: ORG, propertyId: PROP, closureId: "cc_3", entryDate: "2026-09-17", difference: "0.00" }));
  });
});

describe("Regularización, cierre y apertura", () => {
  const balances = [
    { accountCode: "4300", accountName: "Clientes", kind: "asset", debit: "336.50", credit: "121.00" },
    { accountCode: "570", accountName: "Caja", kind: "asset", debit: "121.00", credit: "0.00" },
    { accountCode: "477.10", accountName: "IVA 10 %", kind: "liability", debit: "0.00", credit: "24.95" },
    { accountCode: "477.21", accountName: "IVA 21 %", kind: "liability", debit: "0.00", credit: "7.29" },
    { accountCode: "4759", accountName: "Tasa", kind: "liability", debit: "0.00", credit: "3.18" },
    { accountCode: "705.1", accountName: "Alojamiento", kind: "income", debit: "0.00", credit: "200.92" },
    { accountCode: "705.2", accountName: "Restauración", kind: "income", debit: "0.00", credit: "45.45" },
    { accountCode: "705.3", accountName: "Otros", kind: "income", debit: "0.00", credit: "54.71" },
    { accountCode: "629.1", accountName: "Comisiones", kind: "expense", debit: "30.00", credit: "0.00" },
    { accountCode: "410", accountName: "Acreedores", kind: "liability", debit: "0.00", credit: "30.00" }
  ];
  const base = { organizationId: ORG, fiscalYearId: "fy_2026", yearCode: "2026", entryDate: "2026-12-31", balances };

  it("regularización: 7xx al debe, 6xx al haber, 129 con el resultado (271,08)", () => {
    const reg = buildRegularizationEntry(base);
    assert.equal(reg.netResult.toFixed(2), "271.08");
    assert.deepEqual(lines(reg), [
      ["129", "0.00", "271.08"],
      ["629.1", "0.00", "30.00"],
      ["705.1", "200.92", "0.00"],
      ["705.2", "45.45", "0.00"],
      ["705.3", "54.71", "0.00"]
    ]);
    assert.equal(reg.entryKind, "regularization");
    assert.equal(reg.sourceId, "year-close:fy_2026:regularization");
  });

  it("cierre lleva cada cuenta de balance a cero (129 incluida) y la apertura la restaura", () => {
    const reg = buildRegularizationEntry(base);
    const closing = buildClosingEntry({ ...base, netResult: reg.netResult });
    assert.deepEqual(lines(closing), [
      ["129", "271.08", "0.00"],
      ["410", "30.00", "0.00"],
      ["4300", "0.00", "215.50"],
      ["4759", "3.18", "0.00"],
      ["477.10", "24.95", "0.00"],
      ["477.21", "7.29", "0.00"],
      ["570", "0.00", "121.00"]
    ]);
    assert.deepEqual(totals(closing), { debit: "336.50", credit: "336.50" });
    const opening = buildOpeningEntry(closing, { fiscalYearId: "fy_2026", nextYearCode: "2027", entryDate: "2027-01-01" });
    assert.deepEqual(lines(opening), [
      ["129", "0.00", "271.08"],
      ["410", "0.00", "30.00"],
      ["4300", "215.50", "0.00"],
      ["4759", "0.00", "3.18"],
      ["477.10", "0.00", "24.95"],
      ["477.21", "0.00", "7.29"],
      ["570", "121.00", "0.00"]
    ]);
    assert.equal(opening.entryKind, "opening");
    assert.match(opening.lines[0]!.description ?? "", /^Apertura 2027/);
    assertBalanced(opening.lines);
  });
});
