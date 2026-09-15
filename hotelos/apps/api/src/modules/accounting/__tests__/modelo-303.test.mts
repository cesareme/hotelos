// Unit tests of the Modelo 303 arithmetic and the settlement lines derived
// from it (Finanzas · lote «iva-modelos»). No database: rows come from the
// pure builders of vat-books.service.ts. Run from apps/api with
//   node --import tsx --test src/modules/accounting/__tests__/modelo-303.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Prisma } from "@prisma/client";
import { LEDGER_CROSS_CHECK_STATUSES, compute303, isNonAccrualVatEntry, resolveSettlementPeriod } from "../modelo-303.service.js";
import { settlementLinesFrom } from "../vat-settlement.service.js";
import { ZERO, vatRowsFromInvoice, vatRowsFromSupplierBill, type InvoiceForBooks, type VatBookRow } from "../vat-books.service.js";

const D = (value: string | number) => new Prisma.Decimal(value);
const SETTINGS = { prorrataPct: null, regime: "general" as const, taxFigure: "IVA" as const };

function issued(id: string, number: string, gross: string, rate: string, extra: Partial<InvoiceForBooks> = {}): VatBookRow[] {
  return vatRowsFromInvoice({
    invoice: {
      id,
      propertyId: "prop_t",
      invoiceNumber: number,
      invoiceType: extra.invoiceType ?? "F1",
      status: "issued",
      issuedAt: new Date("2026-05-10T10:00:00.000Z"),
      cancelledAt: null,
      customerTaxId: "B12345674",
      customerName: "Cliente",
      taxBreakdownJson: null,
      seriesCode: null,
      simplified: false,
      rectifyingForId: null,
      lines: [{ total: D(gross), taxRate: D(rate), taxCode: `ES_IVA_${rate}`, taxCalificacion: "S1", taxFigure: "IVA" }],
      ...extra
    },
    organizationId: "org_t",
    periodicity: "quarterly"
  }).rows;
}

function received(id: string, base: string, rate: string, quota: string, retention = "0", investmentGood = false): VatBookRow[] {
  return vatRowsFromSupplierBill({
    bill: {
      id,
      propertyId: "prop_t",
      supplierName: "Proveedor",
      supplierTaxId: "B99999997",
      invoiceNumber: id,
      issueDate: new Date("2026-05-20T00:00:00.000Z"),
      postedAt: null,
      createdAt: new Date(),
      baseTotal: D(base),
      taxTotal: D(quota),
      total: D(base).plus(D(quota)).minus(D(retention)),
      retentionAmount: D(retention),
      status: "posted",
      lines: [{ base: D(base), taxRate: D(rate), quota: D(quota), retention: D(retention), investmentGood }]
    },
    organizationId: "org_t",
    periodicity: "quarterly"
  }).rows;
}

const casilla = (computation: ReturnType<typeof compute303>, code: string): number => {
  const box = computation.casillas.find((entry) => entry.casilla === code);
  assert.ok(box, `casilla ${code} missing`);
  return box.importe;
};

/** The lot's canonical case: 2 invoices @10 %, 1 rectificativa, 1 received @21 % with 15 % retention. */
function canonicalRows(): VatBookRow[] {
  return [
    ...issued("inv1", "FAC-1", "110.00", "10"),
    ...issued("inv2", "FAC-2", "3300.00", "10"),
    ...issued("rec1", "REC-1", "-55.00", "10", { invoiceType: "R1", rectifyingForId: "inv1" }),
    ...received("bill1", "1000.00", "21", "210.00", "150.00")
  ];
}

describe("compute303", () => {
  it("fills 04/06 (10 %), 28/29 (soportado), 27, 45, 46, 64, 66, 69 and 71 from the books", () => {
    const computation = compute303({ rows: canonicalRows(), settings: SETTINGS, compensacionPendiente: ZERO });
    assert.equal(casilla(computation, "04"), 3050);
    assert.equal(casilla(computation, "06"), 305);
    assert.equal(casilla(computation, "01"), 0);
    assert.equal(casilla(computation, "07"), 0);
    assert.equal(casilla(computation, "27"), 305);
    assert.equal(casilla(computation, "28"), 1000);
    assert.equal(casilla(computation, "29"), 210);
    assert.equal(casilla(computation, "30"), 0);
    assert.equal(casilla(computation, "45"), 210);
    assert.equal(casilla(computation, "46"), 95);
    assert.equal(casilla(computation, "64"), 95);
    assert.equal(casilla(computation, "65"), 100);
    assert.equal(casilla(computation, "66"), 95);
    assert.equal(casilla(computation, "110"), 0);
    assert.equal(casilla(computation, "78"), 0);
    assert.equal(casilla(computation, "69"), 95);
    assert.equal(casilla(computation, "71"), 95);
    assert.deepEqual([computation.totales.aIngresar, computation.totales.aCompensar, computation.totales.resultado], [95, 0, 95]);
    assert.deepEqual(computation.avisos, []);
  });

  it("applies the pending compensation (110 → 78 → 87) and leaves the remainder to pay", () => {
    const computation = compute303({ rows: canonicalRows(), settings: SETTINGS, compensacionPendiente: D("40.00") });
    assert.equal(casilla(computation, "110"), 40);
    assert.equal(casilla(computation, "78"), 40);
    assert.equal(casilla(computation, "87"), 0);
    assert.equal(casilla(computation, "71"), 55);
    const larger = compute303({ rows: canonicalRows(), settings: SETTINGS, compensacionPendiente: D("120.00") });
    assert.equal(casilla(larger, "78"), 95);
    assert.equal(casilla(larger, "87"), 25);
    assert.equal(casilla(larger, "71"), 0);
    assert.equal(larger.totales.compensacionPendienteFinal, 25);
  });

  it("yields a negative result to offset and accumulates it in the pending compensation", () => {
    const computation = compute303({ rows: [...issued("inv1", "FAC-1", "110.00", "10"), ...received("bill1", "1000.00", "21", "210.00")], settings: SETTINGS, compensacionPendiente: D("5.00") });
    assert.equal(casilla(computation, "71"), -200);
    assert.equal(casilla(computation, "78"), 0);
    assert.equal(casilla(computation, "87"), 5);
    assert.deepEqual([computation.totales.aIngresar, computation.totales.aCompensar, computation.totales.compensacionPendienteFinal], [0, 200, 205]);
  });

  it("applies the prorrata to the deductible quota, keeps investment goods in 30/31 and excludes non-deductible rows", () => {
    const rows = [...received("bill1", "1000.00", "21", "210.00"), ...received("bill2", "500.00", "21", "105.00", "0", true)];
    const nonDeductible = { ...received("bill3", "100.00", "21", "21.00")[0]!, deductible: false };
    const computation = compute303({ rows: [...rows, nonDeductible], settings: { ...SETTINGS, prorrataPct: 50 }, compensacionPendiente: ZERO });
    assert.equal(casilla(computation, "28"), 1000);
    assert.equal(casilla(computation, "29"), 105);
    assert.equal(casilla(computation, "30"), 500);
    assert.equal(casilla(computation, "31"), 52.5);
    assert.equal(casilla(computation, "45"), 157.5);
    assert.ok(computation.avisos.some((aviso) => /Prorrata general del 50 %/.test(aviso)));
    assert.ok(computation.avisos.some((aviso) => /1 fila\(s\) de recibidas con cuota no deducible \(21.00 €\)/.test(aviso)));
  });

  it("reports unmapped rates and 0 % operations without inventing boxes", () => {
    const rows = [...issued("inv5", "FAC-5", "105.00", "5"), ...issued("inv0", "FAC-0", "10.00", "0")];
    const computation = compute303({ rows, settings: SETTINGS, compensacionPendiente: ZERO });
    const five = computation.casillas.find((box) => box.clave === "DEV_CUOTA_5");
    assert.ok(five && five.casilla === null && five.importe === 5);
    assert.equal(computation.casillas.find((box) => box.clave === "INFO_OPERACIONES_0")?.importe, 10);
    assert.ok(computation.avisos.some((aviso) => /Tipo 5 % sin casilla asignada/.test(aviso)));
    assert.ok(computation.avisos.some((aviso) => /Operaciones al 0 %/.test(aviso)));
    assert.equal(casilla(computation, "27"), 5);
  });
});

describe("settlement lines", () => {
  const chart = new Set(["477.21", "477.10", "477.04", "477", "472.21", "472.10", "472.04", "472", "4700", "4750"]);
  const hasAccount = (code: string) => chart.has(code);

  it("posts D 477.10 305 / H 472.21 210 / H 4750 95 for the canonical case and balances to the cent", () => {
    const computation = compute303({ rows: canonicalRows(), settings: SETTINGS, compensacionPendiente: ZERO });
    const plan = settlementLinesFrom(computation, hasAccount);
    assert.equal(plan.resultado, "to_pay");
    assert.equal(plan.importe.toString(), "95");
    assert.deepEqual(
      plan.lines.map((line) => [line.accountCode, line.debit.toString(), line.credit.toString(), line.taxRateCode, line.taxBase?.toString() ?? null]),
      [
        ["477.10", "305", "0", "10", "3050"],
        ["472.21", "0", "210", "21", "1000"],
        ["4750", "0", "95", null, null]
      ]
    );
    assert.equal(plan.totalDebit.toString(), "305");
    assert.equal(plan.totalCredit.toString(), "305");
    assert.deepEqual(plan.avisos, []);
  });

  it("credits 4700 with the compensation applied and debits 4700 on a negative result", () => {
    const withCompensation = settlementLinesFrom(compute303({ rows: canonicalRows(), settings: SETTINGS, compensacionPendiente: D("40.00") }), hasAccount);
    assert.deepEqual(withCompensation.lines.slice(2).map((line) => [line.accountCode, line.debit.toString(), line.credit.toString()]), [["4700", "0", "40"], ["4750", "0", "55"]]);
    assert.equal(withCompensation.totalDebit.toString(), withCompensation.totalCredit.toString());
    const negative = settlementLinesFrom(compute303({ rows: [...issued("inv1", "FAC-1", "110.00", "10"), ...received("bill1", "1000.00", "21", "210.00")], settings: SETTINGS, compensacionPendiente: ZERO }), hasAccount);
    assert.equal(negative.resultado, "to_offset");
    assert.deepEqual(negative.lines.map((line) => [line.accountCode, line.debit.toString(), line.credit.toString()]), [["477.10", "10", "0"], ["472.21", "0", "210"], ["4700", "200", "0"]]);
  });

  it("flips side for a rate with net negative quota and falls back to 477 when the subaccount is missing", () => {
    const rows = [...issued("rec1", "REC-1", "-55.00", "10", { invoiceType: "R1", rectifyingForId: "x" }), ...issued("inv7", "FAC-7", "107.00", "7")];
    const plan = settlementLinesFrom(compute303({ rows, settings: SETTINGS, compensacionPendiente: ZERO }), hasAccount);
    const ten = plan.lines.find((line) => line.taxRateCode === "10")!;
    assert.deepEqual([ten.accountCode, ten.debit.toString(), ten.credit.toString()], ["477.10", "0", "5"]);
    const seven = plan.lines.find((line) => line.taxRateCode === "7")!;
    assert.equal(seven.accountCode, "477");
    assert.ok(plan.avisos.some((aviso) => /477\.07 no existe/.test(aviso)));
    assert.equal(plan.totalDebit.toString(), plan.totalCredit.toString());
    assert.equal(plan.resultado, "to_pay");
    assert.equal(plan.importe.toString(), "2");
  });

  it("returns no lines when the period has no quotas", () => {
    const plan = settlementLinesFrom(compute303({ rows: [], settings: SETTINGS, compensacionPendiente: ZERO }), hasAccount);
    assert.equal(plan.lines.length, 0);
    assert.equal(plan.resultado, "zero");
  });
});

describe("resolveSettlementPeriod", () => {
  it("accepts period codes and natural legacy ranges, and enforces the periodicity", () => {
    assert.equal(resolveSettlementPeriod({ period: "2026-Q3" }, "quarterly").code, "2026-Q3");
    assert.equal(resolveSettlementPeriod({ fromDate: "2026-07-01", toDate: "2026-09-30" }).code, "2026-Q3");
    assert.equal(resolveSettlementPeriod({ fromDate: "2026-07-01", toDate: "2026-07-31" }, "monthly").code, "2026-07");
    const mismatch = (input: Parameters<typeof resolveSettlementPeriod>[0], periodicity: "quarterly" | "monthly") =>
      assert.throws(() => resolveSettlementPeriod(input, periodicity), (error: { statusCode?: number; details?: { code?: string } }) => error.statusCode === 400 && error.details?.code === "PERIOD_MISMATCH");
    mismatch({ period: "2026-07" }, "quarterly");
    mismatch({ period: "2026-Q3" }, "monthly");
    assert.throws(() => resolveSettlementPeriod({ fromDate: "2026-07-02", toDate: "2026-09-30" }), (error: { details?: { code?: string } }) => error.details?.code === "INVALID_PERIOD");
    assert.throws(() => resolveSettlementPeriod({ period: "2026" }), (error: { details?: { code?: string } }) => error.details?.code === "INVALID_PERIOD");
    assert.throws(() => resolveSettlementPeriod({}), (error: { details?: { code?: string } }) => error.details?.code === "INVALID_PERIOD");
  });
});

describe("ledger cross-check selection (t6#8)", () => {
  it("reads posted AND reversed entries so both halves of a cancelled invoice count in their own period", () => {
    assert.deepEqual([...LEDGER_CROSS_CHECK_STATUSES], ["posted", "reversed"]);
  });

  it("leaves out the settlement and the year-end close/open, never the accrual entries or their reversals", () => {
    assert.equal(isNonAccrualVatEntry({ sourceType: "vat_settlement", entryKind: "normal" }), true);
    assert.equal(isNonAccrualVatEntry({ sourceType: "closing", entryKind: "closing" }), true);
    assert.equal(isNonAccrualVatEntry({ sourceType: "opening", entryKind: "opening" }), true);
    assert.equal(isNonAccrualVatEntry({ sourceType: "invoice", entryKind: "normal" }), false);
    assert.equal(isNonAccrualVatEntry({ sourceType: "invoice_cancellation", entryKind: "reversal" }), false);
    assert.equal(isNonAccrualVatEntry({ sourceType: "reversal", entryKind: "reversal" }), false);
    assert.equal(isNonAccrualVatEntry({ sourceType: "regularization", entryKind: "regularization" }), false);
    assert.equal(isNonAccrualVatEntry({ sourceType: "supplier_bill", entryKind: "normal" }), false);
  });
});
