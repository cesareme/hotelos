// Unit tests of the Modelo 303 arithmetic and the settlement lines derived
// from it (Finanzas · lote «iva-modelos»). No database: rows come from the
// pure builders of vat-books.service.ts. Run from apps/api with
//   node --import tsx --test src/modules/accounting/__tests__/modelo-303.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Prisma } from "@prisma/client";
import {
  COMPENSATION_CHAIN_MAX_DEPTH,
  LEDGER_CROSS_CHECK_STATUSES,
  MONTHLY_INFORMATIVE_303_AVISO,
  PMS_SHADOW_REVENUE_SOURCE_TYPE,
  SAGE_JOURNAL_SOURCE_TYPE,
  SAGE_NO_CENTRE_AVISO,
  applyOpeningCompensation,
  compensationChainAviso,
  compute303,
  crossCheckExclusionAvisos,
  historicalSettlementsAviso,
  isNonAccrualVatEntry,
  isSageSettlementPattern,
  ledgerRateOf,
  previousFiscalPeriod,
  resolveCarriedCompensation,
  resolveSettlementPeriod,
  type CompensationChainDeps
} from "../modelo-303.service.js";
import { parseFiscalPeriod } from "../vat-books.service.js";
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

describe("ledger cross-check exclusions (Tanda L3-C)", () => {
  it("leaves out the OPERA shadow revenue entries (pms_shadow_revenue): they accrue 477 with no book row", () => {
    assert.equal(PMS_SHADOW_REVENUE_SOURCE_TYPE, "pms_shadow_revenue");
    assert.equal(isNonAccrualVatEntry({ sourceType: "pms_shadow_revenue", entryKind: "normal" }), true);
    assert.equal(isNonAccrualVatEntry({ sourceType: "sage200_journal", entryKind: "normal" }), false, "an imported Sage devengo counts; only the settlement PATTERN is screened");
    assert.equal(isNonAccrualVatEntry({ sourceType: "payroll_cost_import", entryKind: "normal" }), false);
  });

  it("recognises the settlement pattern of a Sage 200 entry by its accounts (4750/4700 together with 477/472), never by the rate", () => {
    assert.equal(SAGE_JOURNAL_SOURCE_TYPE, "sage200_journal");
    assert.equal(isSageSettlementPattern("sage200_journal", ["477.10", "477.21", "472.21", "4750"]), true, "Liquidación IVA 2026-Q2");
    assert.equal(isSageSettlementPattern("sage200_journal", ["472.21", "4700"]), true, "settlement to offset");
    assert.equal(isSageSettlementPattern("sage200_journal", ["4750", "572"]), false, "Pago liquidación IVA: no accrual account, nothing to exclude");
    assert.equal(isSageSettlementPattern("sage200_journal", ["477.10", "705.1", "4300"]), false, "an ordinary imported sale is a devengo");
    assert.equal(isSageSettlementPattern("sage200_journal", ["4759", "477.10"]), false, "4759 is not a settlement account");
    assert.equal(isSageSettlementPattern("invoice", ["477.10", "4750"]), false, "native entries are governed by sourceType (vat_settlement)");
    assert.equal(isSageSettlementPattern("sage200_journal", []), false);
  });

  it("names every exclusion with its count in Spanish, and nothing when nothing was excluded", () => {
    assert.deepEqual(crossCheckExclusionAvisos({ liquidacion: 0, cierreApertura: 0, pmsSombra: 0, liquidacionSage: 0 }), []);
    const avisos = crossCheckExclusionAvisos({ liquidacion: 1, cierreApertura: 2, pmsSombra: 3, liquidacionSage: 18 });
    assert.equal(avisos.length, 4);
    assert.match(avisos[0]!, /^1 asiento de liquidación del IVA excluido del cotejo/);
    assert.match(avisos[1]!, /^2 asientos de cierre o apertura de ejercicio excluidos del cotejo/);
    assert.match(avisos[2]!, /^3 asientos de ingresos de OPERA en modo sombra \(pms_shadow_revenue\) excluidos del cotejo/);
    assert.match(avisos[3]!, /^18 asientos de liquidación importados de Sage excluidos del cotejo \(patrón 4750\/4700 junto a 477\/472\)\.$/);
    assert.match(crossCheckExclusionAvisos({ liquidacion: 0, cierreApertura: 0, pmsSombra: 0, liquidacionSage: 1 })[0]!, /^1 asiento de liquidación importado de Sage excluido/);
  });

  // FIX-1 · F3 (B-5): the cross-check is aggregated in the database (two $queryRaw, no findMany, no bound); the
  // aggregated query itself is pinned by tests/integration/fiscal-models.test.mts. What stays pure here is the rate
  // text of an aggregated row and the aviso of the imported settlements.
  it("reads the rate of an aggregated ledger row from its text (code, sub-account suffix or «21 %» of the description) and rejects the rest", () => {
    assert.equal(ledgerRateOf("21")?.toFixed(2), "21.00");
    assert.equal(ledgerRateOf("10.00")?.toFixed(2), "10.00");
    assert.equal(ledgerRateOf("7,5")?.toFixed(2), "7.50", "a comma decimal from the description");
    assert.equal(ledgerRateOf(" 4 ")?.toFixed(2), "4.00");
    assert.equal(ledgerRateOf("ES_IVA_21"), null);
    assert.equal(ledgerRateOf(""), null);
    assert.equal(ledgerRateOf(null), null);
  });

  it("names the imported settlements of the period in Spanish (singular and plural), nothing when there are none", () => {
    assert.equal(historicalSettlementsAviso(0), null);
    assert.equal(historicalSettlementsAviso(1), "1 liquidación importada de Sage en el periodo (histórica, no contabilizada por ehotelOS).");
    assert.equal(historicalSettlementsAviso(3), "3 liquidaciones importadas de Sage en el periodo (históricas, no contabilizadas por ehotelOS).");
  });
});

describe("compensación inicial y vista mensual informativa (FIX-1 · F3, B-2 / E-02 / E-03)", () => {
  it("applies the opening balance of the settings from its period on, never before, never without a period or amount", () => {
    const settings = { openingCompensation: 42024.02, openingCompensationPeriod: "2025-Q2" };
    assert.equal(applyOpeningCompensation(settings, "2025-04-01").toFixed(2), "42024.02", "the period itself");
    assert.equal(applyOpeningCompensation(settings, "2025-10-01").toFixed(2), "42024.02", "a later period");
    assert.equal(applyOpeningCompensation(settings, "2025-01-01").toFixed(2), "0.00", "an earlier period");
    assert.equal(applyOpeningCompensation({ openingCompensation: 42024.02, openingCompensationPeriod: null }, "2025-04-01").toFixed(2), "0.00", "no period → never");
    assert.equal(applyOpeningCompensation({ openingCompensation: 0, openingCompensationPeriod: "2025-Q2" }, "2025-04-01").toFixed(2), "0.00");
    assert.equal(applyOpeningCompensation({ openingCompensation: 100, openingCompensationPeriod: "2025-02" }, "2025-02-01").toFixed(2), "100.00", "a monthly code");
    assert.equal(applyOpeningCompensation({ openingCompensation: 100, openingCompensationPeriod: "garbage" }, "2025-02-01").toFixed(2), "0.00", "an unreadable code never applies");
    assert.equal(applyOpeningCompensation({ openingCompensation: 100.005, openingCompensationPeriod: "2025-Q1" }, "2025-01-01").toFixed(2), "100.01", "rounded to cents");
  });

  it("compute303 carries the opening balance into 110 / 78 / 87: 78 = min(110, 46) and the rest stays pending", () => {
    // Emitidas 1.000 @21 (cuota 210) and no recibidas: 46 = 210; a pending 42.024,02 is applied only up to 210.
    const rows = issued("inv_oc", "FAC-OC-1", "1210.00", "21");
    const computation = compute303({ rows, settings: SETTINGS, compensacionPendiente: D("42024.02") });
    assert.equal(casilla(computation, "46"), 210);
    assert.equal(casilla(computation, "110"), 42024.02);
    assert.equal(casilla(computation, "78"), 210);
    assert.equal(casilla(computation, "87"), 41814.02);
    assert.equal(casilla(computation, "71"), 0);
    assert.equal(computation.totales.compensacionPendienteFinal, 41814.02);
  });

  it("resolveSettlementPeriod: a month asked to a quarterly sociedad is a 400 PERIOD_MISMATCH unless the informative view is allowed", () => {
    assert.throws(() => resolveSettlementPeriod({ period: "2026-01" }, "quarterly", null, { allowMonthlyInformative: false }), (error: { details?: { code?: string } }) => error.details?.code === "PERIOD_MISMATCH");
    const month = resolveSettlementPeriod({ period: "2026-01" }, "quarterly", null, { allowMonthlyInformative: true });
    assert.deepEqual([month.code, month.type, month.from, month.to, month.informativo], ["2026-01", "monthly", "2026-01-01", "2026-01-31", true]);
    // The flag never changes a quarter, a monthly sociedad or the legacy range form.
    assert.equal(resolveSettlementPeriod({ period: "2026-Q1" }, "quarterly", null, { allowMonthlyInformative: true }).informativo, undefined);
    assert.equal(resolveSettlementPeriod({ period: "2026-01" }, "monthly", null, { allowMonthlyInformative: true }).informativo, undefined);
    assert.throws(() => resolveSettlementPeriod({ period: "2026-Q1" }, "monthly", null, { allowMonthlyInformative: true }), (error: { details?: { code?: string } }) => error.details?.code === "PERIOD_MISMATCH", "a quarter to a monthly sociedad is still a mismatch");
    assert.equal(resolveSettlementPeriod({ fromDate: "2026-01-01", toDate: "2026-01-31" }, "quarterly", null, { allowMonthlyInformative: true }).informativo, true);
    assert.match(MONTHLY_INFORMATIVE_303_AVISO, /^Vista mensual informativa: la sociedad liquida por trimestres; no presentable\.$/);
  });

  it("the centre-breakdown aviso of a Sage period is one shared sentence (API and screens read the same constant)", () => {
    assert.equal(SAGE_NO_CENTRE_AVISO, "Desglose por centro no disponible para lotes Sage sin delegación: las filas importadas no llevan centro.");
  });
});

describe("compute303 · régimen de las filas (FIX-1 · F2, B-4)", () => {
  const withRegime = (rows: VatBookRow[], regime: VatBookRow["regime"]): VatBookRow[] => rows.map((row) => ({ ...row, regime }));
  /** Interior 1000 @21 · autofactura ISP 500 @21 · autofactura AIB 100 @21 · venta exenta 656.000 @0 · recibidas interior 1000, ISP 500, AIB 100, DUA 300 (todas @21). */
  function regimeRows(): VatBookRow[] {
    return [
      ...issued("inv1", "FAC-1", "1210.00", "21"),
      ...withRegime(issued("auto1", "AUTO-1", "605.00", "21", { customerTaxId: null }), "isp"),
      ...withRegime(issued("auto2", "AUTO-2", "121.00", "21", { customerTaxId: null }), "aib"),
      ...withRegime(issued("ar2", "AR-2", "656000.00", "0", { customerTaxId: "FR12345678901" }), "exento_no_sujeto"),
      ...received("bill1", "1000.00", "21", "210.00"),
      ...withRegime(received("bill-isp", "500.00", "21", "105.00"), "isp"),
      ...withRegime(received("bill-aib", "100.00", "21", "21.00"), "aib"),
      ...withRegime(received("dua1", "300.00", "21", "63.00"), "importacion")
    ];
  }

  it("las autofacturas ISP/AIB salen de 07/09 hacia 12/13 y 10/11; las recibidas AIB/DUA salen de 28/29 hacia 36/37 y 32/33; la ISP soportada se queda en 28/29 (formulario oficial, SEC-08); la exenta va a 120 sin cuota", () => {
    const computation = compute303({ rows: regimeRows(), settings: SETTINGS, compensacionPendiente: ZERO });
    assert.deepEqual([casilla(computation, "07"), casilla(computation, "09")], [1000, 210], "07/09 solo interior");
    assert.deepEqual([casilla(computation, "10"), casilla(computation, "11")], [100, 21], "AIB autofactura");
    assert.deepEqual([casilla(computation, "12"), casilla(computation, "13")], [500, 105], "ISP autofactura");
    assert.equal(casilla(computation, "27"), 336, "27 = 09 + 11 + 13");
    assert.deepEqual([casilla(computation, "28"), casilla(computation, "29")], [1500, 315], "28/29 = interior + ISP soportada (corrector SEC-08: el formulario deduce la ISP en 28/29)");
    assert.deepEqual([casilla(computation, "32"), casilla(computation, "33")], [300, 63], "DUA");
    assert.deepEqual([casilla(computation, "36"), casilla(computation, "37")], [100, 21], "AIB recibida corriente");
    assert.deepEqual([casilla(computation, "38"), casilla(computation, "39")], [0, 0], "38/39 reservadas a AIB de bienes de inversión: sin filas, 0");
    assert.deepEqual([computation.casillas.find((box) => box.casilla === "38")?.clave, computation.casillas.find((box) => box.casilla === "39")?.clave], ["DED_BASE_AIB_INVERSION", "DED_CUOTA_AIB_INVERSION"]);
    assert.equal(casilla(computation, "45"), 399, "45 = 29 + 33 + 37 + 39 (la ISP ya está en 29)");
    assert.equal(casilla(computation, "46"), -63);
    assert.equal(casilla(computation, "71"), -63);
    assert.equal(casilla(computation, "120"), 656000, "exenta / no sujeta por localización: base en 120");
    assert.deepEqual([casilla(computation, "122"), casilla(computation, "123")], [0, 0], "122/123 declaradas a 0 con clave");
    assert.equal(computation.casillas.find((box) => box.clave === "INFO_OPERACIONES_0"), undefined, "sin filas al 0 % sin régimen no hay aviso «sin casilla»");
    assert.ok(!computation.avisos.some((aviso) => /Operaciones al 0 %/.test(aviso)));
    assert.ok(computation.avisos.some((aviso) => /casilla 120/.test(aviso)));
    assert.ok(computation.avisos.some((aviso) => /inversión del sujeto pasivo/.test(aviso) && /28\/29/.test(aviso)), "aviso informativo de la ISP en 28/29");
    assert.ok(!computation.avisos.some((aviso) => /38\/39/.test(aviso)), "ya no hay aviso «validar 38/39 con la gestoría»");
    // Agregados por régimen.
    assert.deepEqual([computation.isp.devengado.base.toFixed(2), computation.isp.devengado.cuota.toFixed(2), computation.isp.devengado.filas], ["500.00", "105.00", 1]);
    assert.deepEqual([computation.isp.deducible.base.toFixed(2), computation.isp.deducible.cuota.toFixed(2), computation.isp.deducible.filas], ["500.00", "105.00", 1], "informativo: incluido en 28/29");
    assert.deepEqual([computation.aib.devengado.base.toFixed(2), computation.aib.deducible.cuota.toFixed(2), computation.aibInversion.filas], ["100.00", "21.00", 0]);
    assert.deepEqual([computation.totales.cuotaIspDeducible, computation.totales.cuotaAibInversion, computation.totales.baseDeducible], [105, 0, 1900]);
    // AIB de un bien de inversión (libro bienes_inversion, régimen aib) → 38/39 y entra en la 45.
    const withInvestment = compute303({ rows: [...regimeRows(), ...withRegime(received("bi-aib", "2000.00", "21", "420.00", "0", true), "aib")], settings: SETTINGS, compensacionPendiente: ZERO });
    assert.deepEqual([casilla(withInvestment, "38"), casilla(withInvestment, "39"), casilla(withInvestment, "36"), casilla(withInvestment, "30"), casilla(withInvestment, "45")], [2000, 420, 100, 0, 819]);
    assert.deepEqual([withInvestment.aibInversion.filas, withInvestment.totales.cuotaAibInversion], [1, 420]);
    assert.deepEqual([computation.importacion.base.toFixed(2), computation.importacion.cuota.toFixed(2), computation.importacion.filas], ["300.00", "63.00", 1]);
    assert.deepEqual([computation.exentoNoSujeto.base.toFixed(2), computation.exentoNoSujeto.cuota.toFixed(2), computation.exentoNoSujeto.filas], ["656000.00", "0.00", 1]);
    assert.equal(computation.noSujetas.toFixed(2), "0.00");
    // Vista contable (477 por tipo, para la liquidación y el cotejo): TODAS las emitidas al 21 %; la de casillas, solo las interiores.
    const ledger21 = computation.devengado.find((bucket) => bucket.rate.equals(21))!;
    const interior21 = computation.devengadoInterior.find((bucket) => bucket.rate.equals(21))!;
    assert.deepEqual([ledger21.base.toFixed(2), ledger21.cuota.toFixed(2), ledger21.filas], ["1600.00", "336.00", 3]);
    assert.deepEqual([interior21.base.toFixed(2), interior21.cuota.toFixed(2), interior21.filas], ["1000.00", "210.00", 1]);
    assert.equal(computation.deductibleRows.length, 4, "las cuatro recibidas deducibles siguen en la vista contable");
    assert.deepEqual([computation.totales.baseAutofacturasIspAib, computation.totales.cuotaIsp, computation.totales.cuotaAib, computation.totales.cuotaImportacion, computation.totales.baseExentoNoSujeto], [600, 105, 21, 63, 656000]);
  });

  it("la 71 (y la 27 y la 45) es invariante frente a las mismas filas sin régimen, que van a 07/09 y 28/29 con el aviso de 0 % sin casilla", () => {
    const withRegimeRows = regimeRows();
    const withoutRegime = withRegime(withRegimeRows, null);
    const classified = compute303({ rows: withRegimeRows, settings: SETTINGS, compensacionPendiente: ZERO });
    const legacy = compute303({ rows: withoutRegime, settings: SETTINGS, compensacionPendiente: ZERO });
    assert.equal(casilla(legacy, "71"), casilla(classified, "71"));
    assert.equal(casilla(legacy, "27"), casilla(classified, "27"));
    assert.equal(casilla(legacy, "45"), casilla(classified, "45"));
    assert.deepEqual([casilla(legacy, "07"), casilla(legacy, "09")], [1600, 336], "sin régimen todo es interior");
    assert.deepEqual([casilla(legacy, "28"), casilla(legacy, "29")], [1900, 399]);
    assert.deepEqual([casilla(legacy, "10"), casilla(legacy, "12"), casilla(legacy, "32"), casilla(legacy, "36"), casilla(legacy, "38"), casilla(legacy, "120")], [0, 0, 0, 0, 0, 0]);
    assert.equal(legacy.casillas.find((box) => box.clave === "INFO_OPERACIONES_0")?.importe, 656000, "la exenta sin régimen sigue «sin casilla»");
    assert.ok(legacy.avisos.some((aviso) => /Operaciones al 0 %/.test(aviso)));
    assert.equal(legacy.totales.baseAutofacturasIspAib, 0);
  });

  it("la prorrata se aplica también a las cuotas ISP (dentro de 29) / AIB / importación (33, 37 y 39)", () => {
    const computation = compute303({ rows: regimeRows(), settings: { ...SETTINGS, prorrataPct: 50 }, compensacionPendiente: ZERO });
    assert.deepEqual([casilla(computation, "29"), casilla(computation, "33"), casilla(computation, "37"), casilla(computation, "39"), casilla(computation, "45")], [157.5, 31.5, 10.5, 0, 199.5]);
    assert.ok(computation.avisos.some((aviso) => /casillas 29, 31, 33, 37 y 39/.test(aviso)));
  });
});

describe("casilla 110 encadenada (corrector FIX-1 · SEC-01)", () => {
  const Q = (code: string) => parseFiscalPeriod(code, ["quarterly", "monthly"]);
  const CHAIN_SETTINGS = { ...SETTINGS, openingCompensation: 0, openingCompensationPeriod: null as string | null };
  /** 2025-Q4 liquidado por Sage (4700 = 2.948,03 al 01/01/2026); 2026-Q1 a compensar 200, Q2 +300, Q3 +10, ninguno asentado. */
  function deps(over: Partial<CompensationChainDeps> = {}): CompensationChainDeps {
    const rows: Record<string, VatBookRow[]> = {
      "2026-Q1": [...issued("q1", "F-1", "110.00", "10"), ...received("b1", "1000.00", "21", "210.00")],
      "2026-Q2": issued("q2", "F-2", "3300.00", "10"),
      "2026-Q3": issued("q3", "F-3", "110.00", "10")
    };
    return {
      settings: CHAIN_SETTINGS,
      isSettled: async (periodo) => periodo.code === "2025-Q4",
      ledgerBalance: async (from) => (from >= "2026-01-01" ? D("2948.03") : ZERO),
      rowsOf: async (periodo) => rows[periodo.code] ?? [],
      earliestBookDay: async () => "2025-01-01",
      ...over
    };
  }

  it("previousFiscalPeriod: trimestre y mes anteriores, con cambio de ejercicio", () => {
    assert.deepEqual([previousFiscalPeriod(Q("2026-Q1")).code, previousFiscalPeriod(Q("2026-Q3")).code, previousFiscalPeriod(Q("2026-01")).code, previousFiscalPeriod(Q("2026-05")).code], ["2025-Q4", "2026-Q2", "2025-12", "2026-04"]);
  });

  it("dos periodos consecutivos sin asiento no aplican dos veces el mismo saldo: la 110 de cada uno es el pendiente final del anterior", async () => {
    const q1 = await resolveCarriedCompensation(Q("2026-Q1"), deps());
    assert.deepEqual([q1.compensacion.toFixed(2), q1.encadenadaDesde, q1.truncada], ["2948.03", [], false], "el anterior (2025-Q4) está liquidado: saldo contable tal cual");
    const c1 = compute303({ rows: await deps().rowsOf(Q("2026-Q1")), settings: CHAIN_SETTINGS, compensacionPendiente: q1.compensacion });
    assert.deepEqual([casilla(c1, "46"), casilla(c1, "110"), casilla(c1, "78"), casilla(c1, "71"), c1.totales.compensacionPendienteFinal], [-200, 2948.03, 0, -200, 3148.03]);
    const q2 = await resolveCarriedCompensation(Q("2026-Q2"), deps());
    assert.deepEqual([q2.compensacion.toFixed(2), q2.encadenadaDesde], ["3148.03", ["2026-Q1"]], "Q2 arrastra el saldo y el resultado negativo de Q1");
    const c2 = compute303({ rows: await deps().rowsOf(Q("2026-Q2")), settings: CHAIN_SETTINGS, compensacionPendiente: q2.compensacion });
    assert.deepEqual([casilla(c2, "46"), casilla(c2, "78"), casilla(c2, "71"), c2.totales.compensacionPendienteFinal], [300, 300, 0, 2848.03]);
    const q3 = await resolveCarriedCompensation(Q("2026-Q3"), deps());
    assert.deepEqual([q3.compensacion.toFixed(2), q3.encadenadaDesde], ["2848.03", ["2026-Q1", "2026-Q2"]], "Q3 parte del pendiente final de Q2, no del saldo contable de 4700 (2.948,03) otra vez");
    const c3 = compute303({ rows: await deps().rowsOf(Q("2026-Q3")), settings: CHAIN_SETTINGS, compensacionPendiente: q3.compensacion });
    assert.deepEqual([casilla(c3, "78"), casilla(c3, "71"), c3.totales.compensacionPendienteFinal], [10, 0, 2838.03]);
    assert.ok(casilla(c2, "78") + casilla(c3, "78") <= 3148.03, "Σ78 nunca supera el saldo disponible");
    assert.equal(compensationChainAviso(q3.encadenadaDesde)?.includes("2026-Q1, 2026-Q2") && compensationChainAviso(q3.encadenadaDesde)?.includes("2 periodos sin asiento de liquidación"), true);
    assert.equal(compensationChainAviso([]), null);
    assert.match(compensationChainAviso(["2026-Q2"])!, /1 periodo sin asiento de liquidación/);
  });

  it("la cadena se detiene en el periodo anterior liquidado, en el primer periodo con libros, en el periodo del saldo inicial y en maxDepth", async () => {
    // Anterior liquidado: Q2 con Q1 asentado → saldo contable en Q2.from.
    const settledQ1 = await resolveCarriedCompensation(Q("2026-Q2"), deps({ isSettled: async (periodo) => periodo.code === "2026-Q1" }));
    assert.deepEqual([settledQ1.compensacion.toFixed(2), settledQ1.encadenadaDesde], ["2948.03", []]);
    // Sin libros antes de 2026-04-01: Q2 no encadena Q1 (no hay filas que calcular) y usa el saldo contable.
    const noBooks = await resolveCarriedCompensation(Q("2026-Q2"), deps({ earliestBookDay: async () => "2026-04-01" }));
    assert.deepEqual([noBooks.compensacion.toFixed(2), noBooks.encadenadaDesde], ["2948.03", []]);
    assert.deepEqual((await resolveCarriedCompensation(Q("2026-Q2"), deps({ earliestBookDay: async () => null }))).encadenadaDesde, [], "sin libros en absoluto");
    // Saldo inicial configurado desde 2026-Q2: la cadena no pasa de Q2 (su base es el saldo inicial, que el ledgerBalance ya incluye).
    const opening = await resolveCarriedCompensation(Q("2026-Q3"), deps({ settings: { ...CHAIN_SETTINGS, openingCompensation: 500, openingCompensationPeriod: "2026-Q2" }, ledgerBalance: async (from) => (from >= "2026-04-01" ? D("500.00") : ZERO) }));
    assert.deepEqual([opening.compensacion.toFixed(2), opening.encadenadaDesde], ["200.00", ["2026-Q2"]], "110(Q3) = 500 − 300 aplicados en Q2");
    // maxDepth: con 1 la cadena de Q3 solo alcanza Q2 y avisa que se truncó.
    const truncated = await resolveCarriedCompensation(Q("2026-Q3"), deps({ maxDepth: 1 }));
    assert.deepEqual([truncated.encadenadaDesde, truncated.truncada], [["2026-Q2"], true]);
    assert.equal(truncated.compensacion.toFixed(2), "2648.03", "parte del saldo contable en Q2.from (2.948,03) y aplica los 300 de Q2");
    assert.equal(COMPENSATION_CHAIN_MAX_DEPTH, 60);
  });
});
