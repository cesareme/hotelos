// Unit tests · tributos locales y asiento 631 propuesto (Tanda ACT · L2). Sin BD:
// el constructor puro del asiento (líneas por estado y paidWith, cuadre,
// concepto, ICIO → 231, 409 tipados por contribuyente y por recibo no pagable),
// las cuentas por defecto, los mapeadores fila → DTO (vencido derivado, estado
// del asiento), la proyección para alertas, el KPI de carga fiscal, el JSON de
// plazos y el calendario del ejercicio. Desde apps/api:
//   node --import tsx --test src/modules/real-estate/__tests__/property-tax.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Prisma, type PropertyTax, type PropertyTaxReceipt } from "@prisma/client";
import { dec, utcDay } from "../../payables/money.js";
import { realEstateErrorCodeOf } from "../errors.js";
import {
  CAPITALIZABLE_TAX_ACCOUNT,
  DEFAULT_TAX_ACCOUNT,
  RECEIPT_COUNTER_ACCOUNTS,
  TAX_LIABILITY_ACCOUNT,
  buildReceiptEntryProposal,
  buildReceiptPaymentProposal,
  buildTaxCalendar,
  computeAnnualTaxBurden,
  defaultTaxAccountCode,
  expectedReceiptInputOf,
  installmentsJsonInput,
  receiptAlertInput,
  receiptDebitAccount,
  receiptLabel,
  toPropertyTaxReceiptRecord,
  toPropertyTaxRecord,
  type ReceiptEntryReceiptInput,
  type ReceiptEntryTaxInput
} from "../property-tax.service.js";
import { expectedReceiptsFor } from "../tax-calendar.js";

const TODAY = "2026-09-20";
const CREATED = new Date("2026-09-20T10:00:00.000Z");

const ibi: ReceiptEntryTaxInput = { kind: "ibi", taxpayer: "sociedad", accountCode: "631", capitalizable: false, fiscalReference: "IBI-0001234" };

function receipt(overrides: Partial<ReceiptEntryReceiptInput> = {}): ReceiptEntryReceiptInput {
  return { status: "pagado", fiscalYear: 2026, period: "anual", amount: "12000.00", surchargeAmount: "0", paidAt: "2026-10-15", paidWith: "bank", dueTo: "2026-11-20", ...overrides };
}

const codeOf = (fn: () => unknown): string | null => {
  try {
    fn();
  } catch (error) {
    return realEstateErrorCodeOf(error);
  }
  return null;
};

const statusOf = (fn: () => unknown): number | null => {
  try {
    fn();
  } catch (error) {
    return (error as { statusCode?: number }).statusCode ?? null;
  }
  return null;
};

function taxRow(overrides: Partial<PropertyTax> = {}): PropertyTax {
  return {
    id: "ptx_1",
    organizationId: "org_act",
    propertyId: "prop_act",
    assetId: "rea_1",
    unitId: null,
    kind: "ibi",
    taxpayer: "sociedad",
    authorityName: "Ayuntamiento de prueba",
    ineMunicipalityCode: null,
    fiscalReference: "IBI-0001234",
    taxBase: dec("3250000"),
    ratePct: dec("0.4525"),
    expectedAnnualAmount: dec("12000"),
    periodicity: "anual",
    voluntaryFrom: null,
    voluntaryTo: null,
    directDebit: false,
    directDebitBonusPct: null,
    installmentsJson: null,
    accountCode: "631",
    capitalizable: false,
    legalBasis: null,
    status: "activo",
    createdAt: CREATED,
    updatedAt: CREATED,
    ...overrides
  };
}

function receiptRow(overrides: Partial<PropertyTaxReceipt> = {}): PropertyTaxReceipt {
  return {
    id: "ptr_1",
    taxId: "ptx_1",
    fiscalYear: 2026,
    period: "anual",
    issuedAt: null,
    dueFrom: utcDay("2026-09-01"),
    dueTo: utcDay("2026-11-20"),
    amount: dec("12000"),
    surchargeAmount: dec("0"),
    status: "previsto",
    paidAt: null,
    paidWith: null,
    journalEntryId: null,
    capexProjectId: null,
    documentId: null,
    appealRef: null,
    notes: null,
    createdAt: CREATED,
    updatedAt: CREATED,
    ...overrides
  };
}

describe("cuentas por defecto (§6)", () => {
  it("631 salvo el ICIO capitalizable (231); la cuenta explícita del tributo manda", () => {
    assert.equal(defaultTaxAccountCode("ibi", false), DEFAULT_TAX_ACCOUNT);
    assert.equal(defaultTaxAccountCode("icio", false), "631");
    assert.equal(defaultTaxAccountCode("icio", true), CAPITALIZABLE_TAX_ACCOUNT);
    assert.equal(receiptDebitAccount({ kind: "ibi", capitalizable: false, accountCode: "631" }), "631");
    assert.equal(receiptDebitAccount({ kind: "icio", capitalizable: true, accountCode: "631" }), "231", "ICIO capitalizable con el 631 por defecto → 231");
    assert.equal(receiptDebitAccount({ kind: "icio", capitalizable: true, accountCode: "2110" }), "2110", "la cuenta explícita no se pisa");
    assert.equal(receiptDebitAccount({ kind: "icio", capitalizable: false, accountCode: "631" }), "631");
    assert.deepEqual(RECEIPT_COUNTER_ACCOUNTS, { cash: "570", card: "5721", bank: "572" }, "copia de EXPENSE_COUNTER_ACCOUNTS");
    assert.equal(TAX_LIABILITY_ACCOUNT, "475");
  });
});

describe("buildReceiptEntryProposal · líneas por estado y paidWith", () => {
  it("pagado por banco: D 631 / H 572 por el importe, fecha contable = paidAt, concepto «IBI 2026 · <centro> · <referencia>»", () => {
    const proposal = buildReceiptEntryProposal({ tax: ibi, receipt: receipt(), propertyLabel: "RA", today: TODAY });
    assert.equal(proposal.entryDate, "2026-10-15");
    assert.equal(proposal.description, "IBI 2026 · RA · IBI-0001234");
    assert.equal(proposal.reference, "IBI-0001234");
    assert.equal(proposal.total, "12000.00");
    assert.equal(proposal.debitAccountCode, "631");
    assert.equal(proposal.creditAccountCode, "572");
    assert.deepEqual(
      proposal.lines.map((line) => [line.accountCode, line.debit, line.credit]),
      [
        ["631", 12000, 0],
        ["572", 0, 12000]
      ]
    );
    assert.match(proposal.lines[0]!.description ?? "", /IBI 2026 · cuota/);
    assert.match(proposal.lines[1]!.description ?? "", /Pago IBI 2026 \(15\/10\/2026\)/);
  });

  it("recurrido después de pagar (paidAt conservado, ACT-REV-10) sigue siendo un recibo pagado: H 57x, no 475", () => {
    const proposal = buildReceiptEntryProposal({ tax: ibi, receipt: receipt({ status: "recurrido", paidAt: "2026-10-15", paidWith: "bank" }), propertyLabel: "RA", today: TODAY });
    assert.equal(proposal.creditAccountCode, "572");
    assert.equal(proposal.entryDate, "2026-10-15");
  });

  it("buildReceiptPaymentProposal (ACT-REV-04): D 475 / H 57x por cuota + recargo, fecha = paidAt (hoy si falta), 409 sin importe", () => {
    const payment = buildReceiptPaymentProposal({ tax: ibi, receipt: receipt({ surchargeAmount: "600.00" }), propertyLabel: "RA", today: TODAY });
    assert.equal(payment.debitAccountCode, TAX_LIABILITY_ACCOUNT);
    assert.equal(payment.creditAccountCode, "572");
    assert.equal(payment.entryDate, "2026-10-15");
    assert.equal(payment.total, "12600.00");
    assert.equal(payment.description, "Pago IBI 2026 · RA · IBI-0001234");
    assert.deepEqual(
      payment.lines.map((line) => [line.accountCode, line.debit, line.credit]),
      [
        ["475", 12600, 0],
        ["572", 0, 12600]
      ]
    );
    assert.match(payment.lines[1]!.description ?? "", /Pago IBI 2026 \(15\/10\/2026\)/);
    assert.equal(buildReceiptPaymentProposal({ tax: ibi, receipt: receipt({ paidAt: null, paidWith: "cash" }), propertyLabel: "RA", today: TODAY }).entryDate, TODAY);
    assert.equal(buildReceiptPaymentProposal({ tax: ibi, receipt: receipt({ paidWith: "card" }), propertyLabel: "RA", today: TODAY }).creditAccountCode, "5721");
    assert.throws(() => buildReceiptPaymentProposal({ tax: ibi, receipt: receipt({ amount: "0.00", surchargeAmount: "0.00" }), propertyLabel: "RA", today: TODAY }), (error: unknown) => realEstateErrorCodeOf(error) === "RECEIPT_NOT_PAYABLE");
  });

  it("pagado en caja → 570, con tarjeta → 5721, sin paidWith → 572 (banco)", () => {
    assert.equal(buildReceiptEntryProposal({ tax: ibi, receipt: receipt({ paidWith: "cash" }), propertyLabel: "RA", today: TODAY }).creditAccountCode, "570");
    assert.equal(buildReceiptEntryProposal({ tax: ibi, receipt: receipt({ paidWith: "card" }), propertyLabel: "RA", today: TODAY }).creditAccountCode, "5721");
    assert.equal(buildReceiptEntryProposal({ tax: ibi, receipt: receipt({ paidWith: null }), propertyLabel: "RA", today: TODAY }).creditAccountCode, "572");
  });

  it("recibido / domiciliado / recurrido sin pagar → H 475 y fecha contable = dueTo (hoy sin ventana)", () => {
    for (const status of ["recibido", "domiciliado", "recurrido"]) {
      const proposal = buildReceiptEntryProposal({ tax: ibi, receipt: receipt({ status, paidAt: null, paidWith: null }), propertyLabel: "RA", today: TODAY });
      assert.equal(proposal.creditAccountCode, "475", status);
      assert.equal(proposal.entryDate, "2026-11-20", status);
      assert.deepEqual(proposal.lines.map((line) => [line.accountCode, line.debit, line.credit]), [
        ["631", 12000, 0],
        ["475", 0, 12000]
      ]);
      assert.match(proposal.lines[1]!.description ?? "", /pendiente de pago/);
    }
    const noWindow = buildReceiptEntryProposal({ tax: ibi, receipt: receipt({ status: "recibido", paidAt: null, dueTo: null }), propertyLabel: "RA", today: TODAY });
    assert.equal(noWindow.entryDate, TODAY);
  });

  it("recargo: importe = cuota + recargo en las dos líneas, cuadre exacto al céntimo", () => {
    const proposal = buildReceiptEntryProposal({ tax: ibi, receipt: receipt({ amount: "1000.00", surchargeAmount: "50.00" }), propertyLabel: "RA", today: TODAY });
    assert.equal(proposal.total, "1050.00");
    assert.deepEqual(proposal.lines.map((line) => [line.debit, line.credit]), [
      [1050, 0],
      [0, 1050]
    ]);
    assert.match(proposal.lines[0]!.description ?? "", /cuota 1000.00 \+ recargo 50.00/);
    for (const [amount, surcharge] of [
      ["0.01", "0"],
      ["999999.99", "0.01"],
      ["333.30", "12.34"],
      ["1234.56", "7.89"]
    ] as const) {
      const p = buildReceiptEntryProposal({ tax: ibi, receipt: receipt({ amount, surchargeAmount: surcharge }), propertyLabel: "RA", today: TODAY });
      const debit = p.lines.reduce((acc, line) => acc.plus(line.debit), dec(0));
      const credit = p.lines.reduce((acc, line) => acc.plus(line.credit), dec(0));
      assert.ok(debit.equals(credit), `${amount} + ${surcharge}: ${debit.toFixed(2)} ≠ ${credit.toFixed(2)}`);
      assert.equal(p.total, dec(amount).plus(surcharge).toFixed(2));
    }
  });

  it("ICIO capitalizable → D 231; periodo distinto de anual y sin referencia fiscal en el concepto", () => {
    const icio: ReceiptEntryTaxInput = { kind: "icio", taxpayer: "sociedad", accountCode: "231", capitalizable: true, fiscalReference: null };
    const proposal = buildReceiptEntryProposal({ tax: icio, receipt: receipt({ period: "unico", amount: "48000.00" }), propertyLabel: "LT", today: TODAY });
    assert.equal(proposal.debitAccountCode, "231");
    assert.equal(proposal.description, "ICIO 2026 (unico) · LT");
    assert.equal(proposal.reference, undefined);
    const stillDefault = buildReceiptEntryProposal({ tax: { ...icio, accountCode: "631" }, receipt: receipt(), propertyLabel: "LT", today: TODAY });
    assert.equal(stillDefault.debitAccountCode, "231", "un ICIO capitalizable que conserva el 631 por defecto va al 231");
    assert.equal(receiptLabel("iae", 2026, "PAC-02"), "IAE 2026 (PAC-02)");
    assert.equal(receiptLabel("residuos", 2025, "anual"), "Tasa de residuos 2025");
  });

  it("409 TAXPAYER_NOT_ENTITY cuando el contribuyente no es la sociedad", () => {
    for (const taxpayer of ["propietario_tercero", "arrendatario"]) {
      const run = () => buildReceiptEntryProposal({ tax: { ...ibi, taxpayer }, receipt: receipt(), propertyLabel: "RA", today: TODAY });
      assert.equal(codeOf(run), "TAXPAYER_NOT_ENTITY", taxpayer);
      assert.equal(statusOf(run), 409);
    }
  });

  it("409 RECEIPT_NOT_PAYABLE: recibo previsto, o sin importe", () => {
    const previsto = () => buildReceiptEntryProposal({ tax: ibi, receipt: receipt({ status: "previsto", paidAt: null }), propertyLabel: "RA", today: TODAY });
    assert.equal(codeOf(previsto), "RECEIPT_NOT_PAYABLE");
    assert.equal(statusOf(previsto), 409);
    const zero = () => buildReceiptEntryProposal({ tax: ibi, receipt: receipt({ status: "recibido", amount: "0", surchargeAmount: "0" }), propertyLabel: "RA", today: TODAY });
    assert.equal(codeOf(zero), "RECEIPT_NOT_PAYABLE");
    // El contribuyente se comprueba antes que el estado.
    assert.equal(codeOf(() => buildReceiptEntryProposal({ tax: { ...ibi, taxpayer: "arrendatario" }, receipt: receipt({ status: "previsto" }), propertyLabel: "RA", today: TODAY })), "TAXPAYER_NOT_ENTITY");
  });
});

describe("mapeadores fila → DTO", () => {
  it("toPropertyTaxRecord: dinero con dos decimales, tipo con cuatro, plazos tal cual", () => {
    const record = toPropertyTaxRecord(taxRow({ installmentsJson: [{ label: "PAC-01", dueFrom: "03-01", dueTo: "03-31", pct: "50.00" }] as unknown as Prisma.JsonValue, directDebitBonusPct: dec("5") }));
    assert.equal(record.taxBase, "3250000.00");
    assert.equal(record.ratePct, "0.4525");
    assert.equal(record.expectedAnnualAmount, "12000.00");
    assert.equal(record.directDebitBonusPct, "5.00");
    assert.deepEqual(record.installmentsJson, [{ label: "PAC-01", dueFrom: "03-01", dueTo: "03-31", pct: "50.00" }]);
    assert.equal(record.status, "activo");
    assert.equal(record.createdAt, CREATED.toISOString());
    assert.equal(toPropertyTaxRecord(taxRow({ installmentsJson: Prisma.JsonNull as unknown as Prisma.JsonValue })).installmentsJson, null);
    assert.equal(toPropertyTaxRecord(taxRow({ ratePct: null, taxBase: null })).ratePct, null);
  });

  it("toPropertyTaxReceiptRecord: `overdue` derivado y estado del asiento solo con asiento enlazado", () => {
    const dueYesterday = toPropertyTaxReceiptRecord(receiptRow({ status: "recibido", dueTo: utcDay("2026-09-19") }), TODAY, null);
    assert.equal(dueYesterday.overdue, true);
    assert.equal(dueYesterday.dueTo, "2026-09-19");
    assert.equal(dueYesterday.journalEntryStatus, null);
    assert.equal(toPropertyTaxReceiptRecord(receiptRow({ status: "recurrido", dueTo: utcDay("2026-09-19") }), TODAY, null).overdue, true, "el recurso no suspende el plazo");
    assert.equal(toPropertyTaxReceiptRecord(receiptRow({ status: "pagado", dueTo: utcDay("2026-09-19"), paidAt: utcDay("2026-09-25"), paidWith: "bank" }), TODAY, null).overdue, false);
    assert.equal(toPropertyTaxReceiptRecord(receiptRow({ status: "recibido", dueTo: null }), TODAY, null).overdue, false, "sin ventana no vence");
    assert.equal(toPropertyTaxReceiptRecord(receiptRow({ status: "previsto", dueTo: utcDay("2026-11-20") }), TODAY, null).overdue, false);
    const linked = toPropertyTaxReceiptRecord(receiptRow({ status: "pagado", journalEntryId: "je_1", paidAt: utcDay("2026-10-15"), paidWith: "bank" }), TODAY, "draft");
    assert.equal(linked.journalEntryId, "je_1");
    assert.equal(linked.journalEntryStatus, "draft");
    assert.equal(linked.paidAt, "2026-10-15");
    assert.equal(linked.amount, "12000.00");
    assert.equal(linked.surchargeAmount, "0.00");
    // Un estado sin asiento enlazado nunca se expone.
    assert.equal(toPropertyTaxReceiptRecord(receiptRow(), TODAY, "posted").journalEntryStatus, null);
  });

  it("receiptAlertInput: importe total o null si es cero; expectedReceiptInputOf conserva el calendario del tributo", () => {
    const alert = receiptAlertInput(receiptRow({ status: "recibido", surchargeAmount: dec("50") }), "ibi", "prop_act");
    assert.deepEqual(alert, { id: "ptr_1", propertyId: "prop_act", taxKind: "ibi", fiscalYear: 2026, period: "anual", status: "recibido", dueTo: "2026-11-20", amount: "12050.00" });
    assert.equal(receiptAlertInput(receiptRow({ amount: dec(0) }), "ibi", "prop_act").amount, null);
    const input = expectedReceiptInputOf(taxRow({ ineMunicipalityCode: "28079", voluntaryFrom: null, voluntaryTo: null }));
    assert.deepEqual(expectedReceiptsFor(input, 2026), [{ period: "anual", dueFrom: "2026-10-01", dueTo: "2026-11-30", amount: "12000.00" }], "Madrid: tabla municipal");
    const supletorio = expectedReceiptsFor(expectedReceiptInputOf(taxRow()), 2026);
    assert.deepEqual(supletorio, [{ period: "anual", dueFrom: "2026-09-01", dueTo: "2026-11-20", amount: "12000.00" }], "sin INE: supletorio LGT 62.3");
  });

  it("installmentsJsonInput: pct Decimal → cadena de dos decimales; null borra; undefined no toca", () => {
    assert.deepEqual(installmentsJsonInput([{ label: "PAC-01", dueFrom: "03-01", dueTo: "03-31", pct: dec("33.3") }]), [{ label: "PAC-01", dueFrom: "03-01", dueTo: "03-31", pct: "33.30" }]);
    assert.equal(installmentsJsonInput(null), Prisma.JsonNull);
    assert.equal(installmentsJsonInput(undefined), undefined);
  });
});

describe("KPI y calendario", () => {
  it("computeAnnualTaxBurden: solo tributos activos de la sociedad con importe previsto", () => {
    assert.equal(computeAnnualTaxBurden([]), null);
    assert.equal(computeAnnualTaxBurden([{ status: "activo", taxpayer: "sociedad", expectedAnnualAmount: null }]), null);
    assert.equal(
      computeAnnualTaxBurden([
        { status: "activo", taxpayer: "sociedad", expectedAnnualAmount: dec("12000") },
        { status: "activo", taxpayer: "sociedad", expectedAnnualAmount: "1000.50" },
        { status: "activo", taxpayer: "propietario_tercero", expectedAnnualAmount: "5000" },
        { status: "baja", taxpayer: "sociedad", expectedAnnualAmount: "700" }
      ]),
      "13000.50"
    );
  });

  it("buildTaxCalendar: inicio y fin del periodo por recibo (TAX_OVERDUE si venció sin pagar), pendientes sin generar solo de tributos activos, orden por fecha", () => {
    const calendar = buildTaxCalendar({
      year: 2026,
      today: TODAY,
      propertyId: "prop_act",
      taxes: [
        {
          tax: { id: "ptx_ibi", kind: "ibi", status: "activo", expected: [{ period: "anual", dueFrom: "2026-09-01", dueTo: "2026-11-20", amount: "12000.00" }] },
          receipts: [{ id: "ptr_ibi", fiscalYear: 2026, period: "anual", status: "pagado", dueFrom: "2026-09-01", dueTo: "2026-11-20", paidAt: "2026-10-15" }]
        },
        {
          tax: {
            id: "ptx_iae",
            kind: "iae",
            status: "activo",
            expected: [
              { period: "PAC-01", dueFrom: "2026-03-01", dueTo: "2026-03-31", amount: "333.30" },
              { period: "PAC-02", dueFrom: "2026-06-01", dueTo: "2026-06-30", amount: "333.30" },
              { period: "PAC-03", dueFrom: "2026-09-01", dueTo: "2026-09-30", amount: "333.40" }
            ]
          },
          receipts: [
            { id: "ptr_pac1", fiscalYear: 2026, period: "PAC-01", status: "previsto", dueFrom: "2026-03-01", dueTo: "2026-03-31", paidAt: null },
            { id: "ptr_pac0", fiscalYear: 2025, period: "PAC-03", status: "pagado", dueFrom: "2025-09-01", dueTo: "2025-09-30", paidAt: "2025-09-10" }
          ]
        },
        { tax: { id: "ptx_baja", kind: "vados", status: "baja", expected: [{ period: "anual", dueFrom: "2026-09-01", dueTo: "2026-11-20", amount: null }] }, receipts: [] }
      ]
    });
    assert.equal(calendar.year, 2026);
    assert.deepEqual(
      calendar.events.map((event) => [event.dueAt, event.kind, event.entityId, event.label]),
      [
        ["2026-03-01", "TAX_DUE", "ptr_pac1", "Inicio del periodo voluntario · IAE 2026 (PAC-01)"],
        ["2026-03-31", "TAX_OVERDUE", "ptr_pac1", "Vencido sin pagar · IAE 2026 (PAC-01)"],
        ["2026-09-01", "TAX_DUE", "ptr_ibi", "Inicio del periodo voluntario · IBI 2026"],
        ["2026-11-20", "TAX_DUE", "ptr_ibi", "Pagado el 15/10/2026 · IBI 2026"]
      ]
    );
    assert.ok(calendar.events.every((event) => event.entityType === "property_tax_receipt" && event.propertyId === "prop_act"));
    assert.deepEqual(calendar.pending, [
      { taxId: "ptx_iae", kind: "iae", period: "PAC-02", dueFrom: "2026-06-01", dueTo: "2026-06-30", amount: "333.30" },
      { taxId: "ptx_iae", kind: "iae", period: "PAC-03", dueFrom: "2026-09-01", dueTo: "2026-09-30", amount: "333.40" }
    ]);
  });
});
