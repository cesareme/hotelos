// Unit tests of the VAT books core (Finanzas · lote «iva-modelos»): period
// helpers, Decimal rounding and the pure row builders (invoice, supplier
// bill, expense). No database. Run from apps/api with
//   node --import tsx --test src/modules/accounting/__tests__/vat-books.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Prisma } from "@prisma/client";
import {
  LEGACY_VAT_BOOK_CANCELLATION_SUFFIX,
  VAT_BOOK_CANCELLATION_SUFFIX,
  VAT_BOOK_SUPERSEDED_SUFFIX,
  cancellationSourceId,
  fiscalPeriodForDate,
  fromPersistedRow,
  inferRate,
  invoiceSeries,
  invoiceSourceType,
  legacyCancellationSourceId,
  madridDay,
  normalizeNif,
  parseFiscalPeriod,
  periodFromRange,
  periodsOfYear,
  round2,
  summarizeVatRows,
  supersededSourceId,
  taxGroupsFromLines,
  toVatBookCreateInput,
  toVatBookRowDto,
  vatBookDocumentId,
  vatRowsFromExpense,
  vatRowsFromInvoice,
  vatRowsFromSupplierBill,
  type InvoiceForBooks,
  type SupplierBillForBooks
} from "../vat-books.service.js";

const D = (value: string | number) => new Prisma.Decimal(value);

function invoice(overrides: Partial<InvoiceForBooks> = {}): InvoiceForBooks {
  return {
    id: "inv_1",
    propertyId: "prop_123",
    invoiceNumber: "FAC-2026-000001",
    invoiceType: "F1",
    status: "issued",
    issuedAt: new Date("2026-05-10T10:00:00.000Z"),
    cancelledAt: null,
    customerTaxId: "b12345674",
    customerName: "Cliente SL",
    taxBreakdownJson: null,
    seriesCode: null,
    simplified: false,
    rectifyingForId: null,
    lines: [{ total: D("110.00"), taxRate: D("10.00"), taxCode: "ES_IVA_10", taxCalificacion: "S1", taxFigure: "IVA" }],
    ...overrides
  };
}

describe("periods", () => {
  it("parses quarters, months and years with their bounds and AEAT codes", () => {
    const q3 = parseFiscalPeriod("2026-Q3");
    assert.deepEqual([q3.type, q3.from, q3.to, q3.aeatPeriod, q3.quarter], ["quarterly", "2026-07-01", "2026-09-30", "3T", 3]);
    const feb = parseFiscalPeriod("2028-02");
    assert.deepEqual([feb.type, feb.from, feb.to, feb.aeatPeriod, feb.quarter], ["monthly", "2028-02-01", "2028-02-29", "02", 1]);
    const year = parseFiscalPeriod("2026");
    assert.deepEqual([year.type, year.from, year.to, year.aeatPeriod], ["annual", "2026-01-01", "2026-12-31", "0A"]);
    assert.equal(parseFiscalPeriod("2026-q4").code, "2026-Q4");
  });

  it("rejects malformed or disallowed periods with a Spanish 400 INVALID_PERIOD", () => {
    for (const bad of ["2026-Q5", "2026-13", "26-Q1", "", "1999-Q1"]) {
      assert.throws(() => parseFiscalPeriod(bad), (error: { statusCode?: number; details?: { code?: string }; message: string }) => error.statusCode === 400 && (error.details?.code === "INVALID_PERIOD" || /años 2000 y 2100/.test(error.message)));
    }
    assert.throws(() => parseFiscalPeriod("2026", ["quarterly", "monthly"]), (error: { details?: { code?: string } }) => error.details?.code === "INVALID_PERIOD");
  });

  it("assigns a day to its period under each periodicity", () => {
    assert.equal(fiscalPeriodForDate("2026-09-15", "quarterly").code, "2026-Q3");
    assert.equal(fiscalPeriodForDate("2026-09-15", "monthly").code, "2026-09");
    assert.equal(fiscalPeriodForDate("2026-12-31", "quarterly").code, "2026-Q4");
  });

  it("recognises natural ranges and refuses partial ones", () => {
    assert.equal(periodFromRange("2026-07-01", "2026-09-30")?.code, "2026-Q3");
    assert.equal(periodFromRange("2026-07-01", "2026-07-31")?.code, "2026-07");
    assert.equal(periodFromRange("2026-01-01", "2026-12-31")?.code, "2026");
    assert.equal(periodFromRange("2026-07-02", "2026-09-30"), null);
    assert.equal(periodFromRange("2026-07-01", "2026-09-29"), null);
    assert.equal(periodsOfYear(2026, "quarterly").length, 4);
    assert.equal(periodsOfYear(2026, "monthly").length, 12);
  });

  it("converts timestamps to Madrid calendar days", () => {
    assert.equal(madridDay(new Date("2026-03-31T22:30:00.000Z")), "2026-04-01");
    assert.equal(madridDay(new Date("2026-12-31T23:30:00.000Z")), "2027-01-01");
    assert.equal(madridDay(new Date("2026-07-12T15:39:35.165Z")), "2026-07-12");
  });
});

describe("money", () => {
  it("rounds half away from zero to cents", () => {
    assert.equal(round2(D("2.675")).toString(), "2.68");
    assert.equal(round2(D("-2.675")).toString(), "-2.68");
    assert.equal(round2(D("10.004")).toString(), "10");
  });

  it("groups gross lines per rate with the contract-B rounding (12.50 @21 → 10.33 + 2.17)", () => {
    const groups = taxGroupsFromLines([{ total: D("12.50"), taxRate: D("21.00"), taxCode: "ES_IVA_21", taxCalificacion: "S1", taxFigure: null }]);
    assert.equal(groups.length, 1);
    assert.equal(groups[0]!.base.toString(), "10.33");
    assert.equal(groups[0]!.quota.toString(), "2.17");
    assert.equal(groups[0]!.figure, "IVA");
  });

  it("infers the legacy rate from quota / base snapping to a Spanish rate", () => {
    assert.equal(inferRate(D("1000"), D("210")).toString(), "21");
    assert.equal(inferRate(D("100"), D("10.01")).toString(), "10");
    assert.equal(inferRate(D("0"), D("10")).toString(), "0");
  });

  it("normalises NIFs and derives the series", () => {
    assert.equal(normalizeNif(" b-12345674 "), "B12345674");
    assert.equal(normalizeNif(""), null);
    assert.equal(invoiceSeries("FAC-2026-000123", null), "FAC-2026");
    assert.equal(invoiceSeries("FAC-2026-000123", "FS"), "FS");
    assert.equal(invoiceSeries(null, null), null);
  });
});

describe("rows from invoices", () => {
  it("builds one emitidas row per rate from the persisted breakdown", () => {
    const result = vatRowsFromInvoice({
      invoice: invoice({
        taxBreakdownJson: [
          { figure: "IVA", impuesto: "01", calificacion: "S1", ratePercent: 10, base: 100, quota: 10 },
          { figure: "IVA", impuesto: "01", calificacion: "S1", ratePercent: 21, base: 50, quota: 10.5 }
        ],
        lines: []
      }),
      organizationId: "org_test",
      periodicity: "quarterly"
    });
    assert.equal(result.rows.length, 2);
    const ten = result.rows.find((row) => row.rate.equals(10))!;
    assert.deepEqual([ten.book, ten.date, ten.series, ten.number, ten.counterpartyNif, ten.sourceType, ten.sourceId, ten.period], ["emitidas", "2026-05-10", "FAC-2026", "FAC-2026-000001", "B12345674", "invoice", "inv_1", "2026-Q2"]);
    assert.equal(ten.base.toString(), "100");
    assert.equal(ten.quota.toString(), "10");
    assert.equal(ten.total.toString(), "110");
    assert.deepEqual(result.avisos, []);
    const dto = toVatBookRowDto(ten);
    assert.equal(dto.total, 110);
    assert.equal(dto.rate, 10);
    assert.equal(ten.regime, null, "los escritores nativos no clasifican (FIX-1 · F2)");
    assert.equal(dto.regime, null);
  });

  it("falls back to the gross lines when the invoice has no breakdown (legacy)", () => {
    const result = vatRowsFromInvoice({ invoice: invoice(), organizationId: "org_test", periodicity: "monthly" });
    assert.equal(result.rows.length, 1);
    assert.equal(result.rows[0]!.base.toString(), "100");
    assert.equal(result.rows[0]!.quota.toString(), "10");
    assert.equal(result.rows[0]!.period, "2026-05");
  });

  it("keeps rectificativas negative and tags them", () => {
    const result = vatRowsFromInvoice({
      invoice: invoice({ id: "rec_1", invoiceNumber: "REC-2026-000001", invoiceType: "R1", rectifyingForId: "inv_1", lines: [{ total: D("-55.00"), taxRate: D("10.00"), taxCode: "ES_IVA_10", taxCalificacion: "S1", taxFigure: "IVA" }] }),
      organizationId: "org_test",
      periodicity: "quarterly"
    });
    assert.equal(result.rows[0]!.sourceType, "rectification");
    assert.equal(result.rows[0]!.base.toString(), "-50");
    assert.equal(result.rows[0]!.quota.toString(), "-5");
    assert.equal(result.rows[0]!.total.toString(), "-55");
  });

  it("writes negating rows for a cancellation dated on the cancellation day", () => {
    const cancelled = invoice({ status: "cancelled", cancelledAt: new Date("2026-07-01T05:00:00.000Z") });
    const issue = vatRowsFromInvoice({ invoice: cancelled, organizationId: "org_test", periodicity: "quarterly" });
    const cancellation = vatRowsFromInvoice({ invoice: cancelled, organizationId: "org_test", periodicity: "quarterly", kind: "cancellation" });
    assert.equal(issue.rows[0]!.quota.toString(), "10");
    assert.equal(cancellation.rows[0]!.quota.toString(), "-10");
    assert.equal(cancellation.rows[0]!.date, "2026-07-01");
    assert.equal(cancellation.rows[0]!.period, "2026-Q3");
    assert.equal(cancellation.rows[0]!.sourceId, "inv_1#anulacion");
    assert.equal(vatRowsFromInvoice({ invoice: invoice(), organizationId: "org_test", periodicity: "quarterly", kind: "cancellation" }).rows.length, 0);
  });

  it("tags simplified invoices, skips drafts and warns on 0 % subject lines and missing NIF", () => {
    assert.equal(invoiceSourceType({ invoiceType: "F2", rectifyingForId: null, simplified: false }), "simplified");
    assert.equal(invoiceSourceType({ invoiceType: "F1", rectifyingForId: null, simplified: true }), "simplified");
    assert.equal(vatRowsFromInvoice({ invoice: invoice({ status: "draft", issuedAt: null }), organizationId: "org_test", periodicity: "quarterly" }).rows.length, 0);
    const zero = vatRowsFromInvoice({
      invoice: invoice({ customerTaxId: null, lines: [{ total: D("10.00"), taxRate: D("0"), taxCode: "ES_UNKNOWN_0", taxCalificacion: "S1", taxFigure: null }] }),
      organizationId: "org_test",
      periodicity: "quarterly"
    });
    assert.equal(zero.rows[0]!.rate.toString(), "0");
    assert.equal(zero.rows[0]!.base.toString(), "10");
    assert.equal(zero.avisos.length, 2);
    assert.match(zero.avisos[0]!, /0 %/);
    assert.match(zero.avisos[1]!, /sin NIF/);
  });
});

describe("rows from supplier bills and expenses", () => {
  const bill: SupplierBillForBooks = {
    id: "bill_1",
    propertyId: "prop_123",
    supplierName: "Asesores SL",
    supplierTaxId: "B99999997",
    invoiceNumber: "A-77",
    issueDate: new Date("2026-05-20T00:00:00.000Z"),
    postedAt: null,
    createdAt: new Date("2026-05-21T00:00:00.000Z"),
    baseTotal: D("1500.00"),
    taxTotal: D("315.00"),
    total: D("1665.00"),
    retentionAmount: D("150.00"),
    status: "posted",
    lines: [
      { base: D("1000.00"), taxRate: D("21.00"), quota: D("210.00"), retention: D("150.00"), investmentGood: false },
      { base: D("500.00"), taxRate: D("21.00"), quota: D("105.00"), retention: D("0"), investmentGood: true }
    ]
  };

  it("splits lines into recibidas and bienes de inversión per rate", () => {
    const result = vatRowsFromSupplierBill({ bill, organizationId: "org_test", periodicity: "quarterly" });
    assert.equal(result.rows.length, 2);
    const current = result.rows.find((row) => row.book === "recibidas")!;
    const investment = result.rows.find((row) => row.book === "bienes_inversion")!;
    assert.deepEqual([current.base.toString(), current.quota.toString(), current.retention.toString(), current.total.toString(), current.deductible], ["1000", "210", "150", "1210", true]);
    assert.deepEqual([investment.base.toString(), investment.quota.toString(), investment.date, investment.period], ["500", "105", "2026-05-20", "2026-Q2"]);
    assert.deepEqual(result.avisos, []);
  });

  it("ignores non-posted bills and infers the rate of legacy header-only bills", () => {
    assert.equal(vatRowsFromSupplierBill({ bill: { ...bill, status: "draft" }, organizationId: "org_test", periodicity: "quarterly" }).rows.length, 0);
    const legacy = vatRowsFromSupplierBill({ bill: { ...bill, lines: [], baseTotal: D("0"), taxTotal: D("21.00"), total: D("121.00"), supplierTaxId: null }, organizationId: "org_test", periodicity: "quarterly" });
    assert.equal(legacy.rows.length, 1);
    assert.deepEqual([legacy.rows[0]!.base.toString(), legacy.rows[0]!.rate.toString(), legacy.rows[0]!.quota.toString(), legacy.rows[0]!.deductible], ["100", "21", "21", false]);
    assert.equal(legacy.avisos.length, 2);
  });

  it("marks tickets without NIF as non-deductible and negates cancellations", () => {
    const expense = { id: "exp_1", propertyId: null, date: new Date("2026-05-02T00:00:00.000Z"), supplierName: "Ferretería", supplierNif: null, concept: "Tornillos", accountCode: "622", base: D("10.00"), taxRate: D("21.00"), quota: D("2.10"), total: D("12.10"), vatDeductible: true, cancelledAt: new Date("2026-05-03T10:00:00.000Z") };
    const issue = vatRowsFromExpense({ expense, organizationId: "org_test", periodicity: "quarterly" });
    assert.equal(issue.rows[0]!.deductible, false);
    assert.match(issue.avisos[0]!, /ticket sin NIF/);
    const cancellation = vatRowsFromExpense({ expense, organizationId: "org_test", periodicity: "quarterly", kind: "cancellation" });
    assert.equal(cancellation.rows[0]!.quota.toString(), "-2.1");
    assert.equal(cancellation.rows[0]!.sourceId, "exp_1#anulacion");
  });

  it("summarises rows per rate with wire numbers", () => {
    const rows = vatRowsFromSupplierBill({ bill, organizationId: "org_test", periodicity: "quarterly" }).rows;
    const summary = summarizeVatRows(rows);
    assert.deepEqual([summary.filas, summary.base, summary.cuota, summary.total, summary.retencion], [2, 1500, 315, 1815, 150]);
    assert.deepEqual(summary.porTipo, [{ rate: 21, filas: 2, base: 1500, cuota: 315, total: 1815, retencion: 150 }]);
  });
});

describe("sourceId convention of the counter-rows (Tanda L3-C)", () => {
  it("exposes ONE convention (#anulacion / #sustituida) and only recognises the legacy :anulacion to purge it", () => {
    assert.equal(VAT_BOOK_CANCELLATION_SUFFIX, "#anulacion");
    assert.equal(VAT_BOOK_SUPERSEDED_SUFFIX, "#sustituida");
    assert.equal(LEGACY_VAT_BOOK_CANCELLATION_SUFFIX, ":anulacion");
    assert.equal(cancellationSourceId("inv_1"), "inv_1#anulacion");
    assert.equal(supersededSourceId("inv_1"), "inv_1#sustituida");
    assert.equal(legacyCancellationSourceId("inv_1"), "inv_1:anulacion");
    for (const sourceId of ["inv_1", "inv_1#anulacion", "inv_1#sustituida", "inv_1:anulacion"]) assert.equal(vatBookDocumentId(sourceId), "inv_1");
  });

  it("derives the negating #sustituida rows of an original replaced by a rectificativa «S», dated on the substitute's issue day", () => {
    const original = invoice({ status: "rectified", rectificationType: null });
    const superseded = vatRowsFromInvoice({ invoice: original, organizationId: "org_test", periodicity: "quarterly", kind: "superseded", supersededAt: new Date("2026-07-05T10:00:00.000Z") });
    assert.equal(superseded.rows.length, 1);
    const row = superseded.rows[0]!;
    assert.deepEqual([row.sourceType, row.sourceId, row.date, row.period, row.number], ["invoice", "inv_1#sustituida", "2026-07-05", "2026-Q3", "FAC-2026-000001"]);
    assert.deepEqual([row.base.toString(), row.quota.toString(), row.total.toString(), row.rate.toString()], ["-100", "-10", "-110", "10"]);
    assert.deepEqual(superseded.avisos, []);
    // The substitute's own rows keep its id and stay positive: the book nets like the ledger (original reversed + substitute posted).
    const substitute = vatRowsFromInvoice({
      invoice: invoice({ id: "rec_s", invoiceNumber: "REC-2026-000002", invoiceType: "R1", rectifyingForId: "inv_1", rectificationType: "S", issuedAt: new Date("2026-07-05T10:00:00.000Z"), lines: [{ total: D("55.00"), taxRate: D("10.00"), taxCode: "ES_IVA_10", taxCalificacion: "S1", taxFigure: "IVA" }] }),
      organizationId: "org_test",
      periodicity: "quarterly"
    });
    assert.deepEqual([substitute.rows[0]!.sourceType, substitute.rows[0]!.sourceId, substitute.rows[0]!.quota.toString()], ["rectification", "rec_s", "5"]);
    const net = superseded.rows[0]!.quota.plus(substitute.rows[0]!.quota).plus(vatRowsFromInvoice({ invoice: original, organizationId: "org_test", periodicity: "quarterly" }).rows[0]!.quota);
    assert.equal(net.toString(), "5");
  });

  it("writes no superseded rows without the substitute's issue instant, on drafts, or for a cancellation without cancelledAt", () => {
    assert.equal(vatRowsFromInvoice({ invoice: invoice(), organizationId: "org_test", periodicity: "quarterly", kind: "superseded" }).rows.length, 0);
    assert.equal(vatRowsFromInvoice({ invoice: invoice({ status: "draft", issuedAt: null }), organizationId: "org_test", periodicity: "quarterly", kind: "superseded", supersededAt: new Date() }).rows.length, 0);
    assert.equal(vatRowsFromInvoice({ invoice: invoice(), organizationId: "org_test", periodicity: "quarterly", kind: "cancellation" }).rows.length, 0);
  });
});

describe("régimen de la fila (FIX-1 · F2)", () => {
  it("VatBookRow → DTO y createMany conservan regime; los escritores nativos escriben null; la fila persistida vuelve con su régimen", () => {
    const bill: SupplierBillForBooks = {
      id: "bill_f2",
      propertyId: "prop_1",
      supplierName: "Proveedor UE",
      supplierTaxId: "DE123456789",
      invoiceNumber: "F-1",
      issueDate: new Date("2026-05-20T00:00:00.000Z"),
      postedAt: null,
      createdAt: new Date(),
      baseTotal: D("100.00"),
      taxTotal: D("21.00"),
      total: D("121.00"),
      retentionAmount: D("0"),
      status: "posted",
      lines: [{ base: D("100.00"), taxRate: D("21.00"), quota: D("21.00"), retention: D("0"), investmentGood: false }]
    };
    const base = vatRowsFromSupplierBill({ bill, organizationId: "org_test", periodicity: "quarterly" }).rows[0]!;
    assert.equal(base.regime, null);
    assert.equal(toVatBookCreateInput(base).regime, null);
    const isp = { ...base, regime: "isp" as const };
    assert.equal(toVatBookRowDto(isp).regime, "isp");
    assert.equal(toVatBookCreateInput(isp).regime, "isp");
    const persisted = {
      id: "vbe_1",
      organizationId: "org_test",
      propertyId: null,
      book: "recibidas",
      date: new Date("2026-05-20T00:00:00.000Z"),
      series: null,
      number: "F-1",
      counterpartyNif: "DE123456789",
      counterpartyName: "Proveedor UE",
      base: D("100.00"),
      rate: D("21.00"),
      quota: D("21.00"),
      total: D("121.00"),
      retention: D("0.00"),
      taxFigure: "IVA",
      surchargeRate: null,
      surchargeQuota: null,
      sourceType: "sage200",
      sourceId: "1:2026::F-1:DE123456789",
      period: "2026-Q2",
      deductible: true,
      regime: "aib" as string | null
    };
    assert.equal(fromPersistedRow(persisted).regime, "aib");
    assert.equal(fromPersistedRow({ ...persisted, regime: null }).regime, null, "sin clasificar");
    assert.equal(toVatBookRowDto(fromPersistedRow(persisted)).regime, "aib");
    const expense = { id: "exp_f2", propertyId: null, date: new Date("2026-05-02T00:00:00.000Z"), supplierName: "Ferretería", supplierNif: "B12345674", concept: "Tornillos", base: D("10.00"), taxRate: D("21.00"), quota: D("2.10"), total: D("12.10"), vatDeductible: true, cancelledAt: null };
    assert.equal(vatRowsFromExpense({ expense, organizationId: "org_test", periodicity: "quarterly" }).rows[0]!.regime, null);
  });
});
