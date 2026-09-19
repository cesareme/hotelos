// Unit tests · Tanda 7c · L1 — regla contable pura: asientos Sage → asientos Anfitorio
// (exclusión de nativos §5.1, entryKind, mapa apunte a apunte, analítica, reparto por
// centro con residuo de céntimos §4.5, sourceId / reference §4.6), saldos sin diario §6
// (apertura, resumen, regularización, cierre, apertura(N+1) = cierre(N)), libros de IVA y
// reconciliación §5.2. Puros, sin base de datos. Desde apps/api:
//   node --import tsx --test src/modules/accounting/import/__tests__/ledger-import-posting.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { LEDGER_IMPORT_MAX_LINES_PER_ENTRY, LEDGER_IMPORT_SOURCE_TYPES, LEDGER_VAT_BOOK_SOURCE_TYPE, ledgerUnassignedPolicyForProperty, type LedgerAccountMapDto, type LedgerAnalyticsMapDto } from "@hotelos/shared";
import { PGC_PYMES_HOTEL_TEMPLATE, isPostableCode, splitUsaliRef } from "../../chart-of-accounts.service.js";
import { money, sumMoney } from "../../accounting.service.js";
import { groupJournalRows, parseCanonicalCsv, type CanonicalBalanceRow, type CanonicalJournalRow, type CanonicalVatRow } from "../ledger-import.canonical.js";
import { nativeInvoiceKey, resolveAccountMapping, type ChartLookup } from "../ledger-import.mapping.js";
import {
  NATIVE_PAYMENT_DATE_TOLERANCE_DAYS,
  buildBalanceEntries,
  buildJournalEntries,
  buildReconciliationRows,
  buildVatBookRows,
  checkOpeningContinuity,
  distributeSharedLines,
  isForeignNif,
  regimeOfVatRow,
  splitProportionally,
  type JournalPostingContext,
  type PlannedEntry
} from "../ledger-import.posting.js";
import { parseLedgerImportFile, parseSageVatBook } from "../sage200.parser.js";
import { BALANCES_2025, JOURNAL_OPENING_AND_JANUARY, JOURNAL_YEAR_END, NIF_LAVANDERIA, NIF_SUMINISTROS, PROPERTIES, VAT_RECIBIDAS_2026_Q3, aeatVatBookXlsx, balancesCanonicalCsv, journalImeCsv, journalXlsxCargoAbono, openingRows2026 } from "./fixtures/sage200-fixtures.mjs";

// ---------------------------------------------------------------------------
// Contexto común
// ---------------------------------------------------------------------------

const chart: ChartLookup = new Map(
  PGC_PYMES_HOTEL_TEMPLATE.map((account) => {
    const usali = splitUsaliRef(account.usali);
    return [account.code, { isPostable: isPostableCode(account.code), kind: account.kind, usaliDepartment: usali?.usaliDepartment ?? null, usaliLine: usali?.usaliLine ?? null, name: account.name }];
  })
);

/** Mapa de cuentas resuelto con las reglas 2-7 para las cuentas de las filas. */
function accountMapFor(rows: readonly { cuenta: string; tipo_iva?: string | null }[], explicit: LedgerAccountMapDto[] = []): Map<string, LedgerAccountMapDto> {
  const explicitMap = new Map(explicit.map((entry) => [entry.sourceAccount, entry]));
  const map = new Map<string, LedgerAccountMapDto>();
  for (const row of rows) {
    if (map.has(row.cuenta)) continue;
    map.set(row.cuenta, resolveAccountMapping(row.cuenta, { explicit: explicitMap, chart, porIva: row.tipo_iva ?? null }));
  }
  return map;
}

const ANALYTICS: LedgerAnalyticsMapDto[] = [
  { dimension: "delegacion", sourceCode: "RA", propertyId: "prop_ra", costCentreCode: null },
  { dimension: "delegacion", sourceCode: "LT", propertyId: "prop_lt", costCentreCode: null },
  { dimension: "delegacion", sourceCode: "MC", propertyId: "prop_mc", costCentreCode: null },
  { dimension: "delegacion", sourceCode: "OC", propertyId: "prop_oc", costCentreCode: null },
  { dimension: "departamento", sourceCode: "HAB", propertyId: null, costCentreCode: "ROOMS" },
  { dimension: "departamento", sourceCode: "ADM", propertyId: null, costCentreCode: "ADMIN_GENERAL" },
  { dimension: "departamento", sourceCode: "MANT", propertyId: null, costCentreCode: "POM" }
];

const properties = PROPERTIES.map((property) => ({ id: property.id, code: property.code, name: property.name }));
const FISCAL_2026 = { code: "2026", startDate: "2026-01-01", endDate: "2026-12-31" };

function context(overrides: Partial<JournalPostingContext> & { rows: readonly CanonicalJournalRow[] }): JournalPostingContext {
  const { rows, ...rest } = overrides;
  return {
    accountMap: accountMapFor(rows),
    analytics: { centreDimension: "delegacion", costCentreDimension: "departamento", unassignedPolicy: "office", map: ANALYTICS },
    properties,
    officePropertyId: "prop_oc",
    fiscalYear: FISCAL_2026,
    ...rest
  };
}

let orden = 0;
function row(partial: Partial<CanonicalJournalRow> & { asiento: string; cuenta: string }): CanonicalJournalRow {
  orden += 1;
  return {
    line: orden + 1,
    orden,
    empresa: "1",
    ejercicio: "2026",
    fecha: "2026-09-05",
    periodo: "9",
    debe: "0.00",
    haber: "0.00",
    concepto: null,
    documento: null,
    canal: null,
    delegacion: null,
    departamento: null,
    seccion: null,
    proyecto: null,
    serie: null,
    factura: null,
    su_factura_no: null,
    fecha_factura: null,
    nif: null,
    nombre: null,
    base_iva: null,
    tipo_iva: null,
    cuota_iva: null,
    tipo_factura: null,
    diario: null,
    contrapartida: null,
    ...partial
  };
}

function lineTriples(entry: PlannedEntry): Array<[string, string, string]> {
  return entry.lines.map((line) => [line.accountCode, line.debit, line.credit]);
}

function assertEntryBalanced(entry: PlannedEntry): void {
  const debit = sumMoney(entry.lines.map((line) => line.debit));
  const credit = sumMoney(entry.lines.map((line) => line.credit));
  assert.equal(debit.toFixed(2), credit.toFixed(2), `${entry.sourceId} cuadra`);
  assert.equal(entry.totalDebit, debit.toFixed(2));
  assert.equal(entry.totalCredit, credit.toFixed(2));
}

const fixtureRows = parseLedgerImportFile({ kind: "journal", content: journalImeCsv(), fileName: "diario-ime-2026-09.csv" }).rows;
const nativeIndex = { invoiceKeys: new Map([[nativeInvoiceKey("FAC-2026-000015")!, { invoiceId: "inv_15", invoiceNumber: "FAC-2026-000015", sourceType: "invoice", sourceId: "invoice/inv_15" }]]) };

// ---------------------------------------------------------------------------
// Diario
// ---------------------------------------------------------------------------

describe("buildJournalEntries · diario sintético de septiembre", () => {
  const result = buildJournalEntries(groupJournalRows(fixtureRows), context({ rows: fixtureRows, nativeIndex }));

  it("estados por asiento: planned / skipped_native; nada sin mapear ni sin centro", () => {
    assert.deepEqual([...result.statuses], [["1:2026:9:1501", "planned"], ["1:2026:9:1502", "skipped_native"], ["1:2026:9:1503", "planned"], ["1:2026:9:1504", "planned"], ["1:2026:9:1505", "skipped_native"], ["1:2026:9:1506", "planned"]]);
    assert.deepEqual(result.unmapped, []);
    assert.deepEqual(result.unmappedAnalytics, []);
    assert.deepEqual(result.centreRequired, []);
    assert.deepEqual(result.unbalanced, []);
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.closingDetected, []);
    assert.equal(result.entries.length, 5, "1501, 1503 (RA + LT), 1504 y 1506");
    for (const entry of result.entries) assertEntryBalanced(entry);
  });

  it("(a) exclusión de nativos: 1502 por Serie + Factura y 1505 (cobro) por el número en el documento, con el asiento nativo", () => {
    assert.deepEqual(result.skippedNative, [
      { sourceEntryNumber: "1502", sourcePeriod: "9", sourceChannel: null, series: "FAC-2026", number: "000015", invoiceNumber: "FAC-2026-000015", sourceType: "invoice", sourceId: "invoice/inv_15" },
      { sourceEntryNumber: "1505", sourcePeriod: "9", sourceChannel: null, series: null, number: "FAC-2026-000015", invoiceNumber: "FAC-2026-000015", sourceType: "invoice", sourceId: "invoice/inv_15" }
    ]);
    assert.ok(!result.entries.some((entry) => entry.source?.entryNumber === "1502" || entry.source?.entryNumber === "1505"));
    // Sin índice nativo se contabilizan los seis.
    const withoutIndex = buildJournalEntries(groupJournalRows(fixtureRows), context({ rows: fixtureRows }));
    assert.equal(withoutIndex.skippedNative.length, 0);
    assert.equal(withoutIndex.entries.length, 7);
  });

  it("(d)(e) asiento 1501: cuentas mapeadas, descripción «Sage <cuenta> · NIF · nombre» en el collapse, IVA con taxRateCode / taxBase, centro de coste solo en 6/7, sourceId y reference", () => {
    const entry = result.entries.find((candidate) => candidate.sourceId === "1:2026:9:1501")!;
    assert.ok(entry);
    assert.equal(entry.sourceType, LEDGER_IMPORT_SOURCE_TYPES.journal);
    assert.equal(entry.sourceType, "sage200_journal");
    assert.deepEqual([entry.entryDate, entry.entryKind, entry.propertyId, entry.propertyCode, entry.fiscalYearCode, entry.splitParts], ["2026-09-03", "normal", "prop_ra", "RA", "2026", 1]);
    assert.equal(entry.reference, "Sage 200 · asiento 2026/1501 · periodo 9 · diario 0");
    assert.equal(entry.description, "Electricidad septiembre");
    assert.deepEqual(lineTriples(entry), [["628.1", "250.00", "0.00"], ["472.21", "52.50", "0.00"], ["400", "0.00", "302.50"]]);
    assert.deepEqual(entry.lines.map((line) => line.costCenterCode), ["POM", null, null]);
    assert.deepEqual(entry.lines.map((line) => line.costCenterId), [null, null, null], "L2 resuelve costCenterCode → costCenterId");
    assert.deepEqual(entry.lines.map((line) => line.taxRateCode), [null, "21", null]);
    assert.equal(entry.lines[1]!.taxBase?.toFixed(2), "250.00");
    assert.equal(entry.lines[2]!.description, `Sage 4000000042 · ${NIF_SUMINISTROS} · SUMINISTROS ELECTRICOS DEL NOROESTE SL`);
    assert.deepEqual(entry.lines.map((line) => line.sourceAccount), ["6280001", "4720021", "4000000042"]);
    assert.deepEqual(entry.source, { companyCode: "1", fiscalYear: "2026", period: "9", entryNumber: "1501", channel: null });
  });

  it("(c) asiento 1503 en dos hoteles: una parte por centro con sufijo :<centro>, líneas de balance repartidas ∝ Σ|6/7|, cada parte cuadra y el consolidado por cuenta es exacto", () => {
    const parts = result.entries.filter((entry) => entry.source?.entryNumber === "1503");
    assert.deepEqual(parts.map((part) => [part.sourceId, part.propertyCode, part.splitParts]), [["1:2026:9:1503:LT", "LT", 2], ["1:2026:9:1503:RA", "RA", 2]]);
    const ra = parts.find((part) => part.propertyCode === "RA")!;
    const lt = parts.find((part) => part.propertyCode === "LT")!;
    assert.deepEqual(lineTriples(ra), [["629.1", "300.00", "0.00"], ["472.21", "63.00", "0.00"], ["410", "0.00", "363.00"]]);
    assert.deepEqual(lineTriples(lt), [["629.1", "100.00", "0.00"], ["472.21", "21.00", "0.00"], ["410", "0.00", "121.00"]]);
    assert.equal(ra.lines[1]!.taxBase?.toFixed(2), "300.00", "taxBase repartida con la misma proporción");
    assert.equal(lt.lines[1]!.taxBase?.toFixed(2), "100.00");
    assert.equal(ra.lines[2]!.description, `Sage 4100000007 · ${NIF_LAVANDERIA} · LAVANDERIA INDUSTRIAL DEL CANTABRICO SL`);
    assert.ok(ra.warnings.some((warning) => /repartido entre 2 centros/.test(warning)));
    const consolidated = new Map<string, ReturnType<typeof money>>();
    for (const part of parts) for (const line of part.lines) consolidated.set(line.accountCode, (consolidated.get(line.accountCode) ?? money(0)).plus(line.debit).minus(line.credit));
    assert.deepEqual([...consolidated].map(([code, net]) => [code, net.toFixed(2)]), [["629.1", "400.00"], ["472.21", "84.00"], ["410", "-484.00"]]);
  });

  it("(c) apuntes 6/7 sin analítica: política office → OC; block → centreRequired; property:<id> → ese centro", () => {
    const office = result.entries.find((entry) => entry.source?.entryNumber === "1504")!;
    assert.deepEqual([office.propertyId, office.propertyCode], ["prop_oc", "OC"]);
    assert.ok(office.warnings.some((warning) => /imputados por política a OC/.test(warning)));
    const blocked = buildJournalEntries(groupJournalRows(fixtureRows), context({ rows: fixtureRows, nativeIndex, analytics: { centreDimension: "delegacion", costCentreDimension: "departamento", unassignedPolicy: "block", map: ANALYTICS } }));
    assert.deepEqual(blocked.centreRequired, [{ sourceEntryNumber: "1504", sourcePeriod: "9", accounts: ["6210000"] }]);
    assert.equal(blocked.statuses.get("1:2026:9:1504"), "centre_required");
    assert.equal(blocked.entries.length, 4);
    const toHotel = buildJournalEntries(groupJournalRows(fixtureRows), context({ rows: fixtureRows, nativeIndex, analytics: { centreDimension: "delegacion", costCentreDimension: "departamento", unassignedPolicy: ledgerUnassignedPolicyForProperty("prop_mc"), map: ANALYTICS } }));
    assert.equal(toHotel.entries.find((entry) => entry.source?.entryNumber === "1504")?.propertyCode, "MC");
    const noOffice = buildJournalEntries(groupJournalRows(fixtureRows), context({ rows: fixtureRows, nativeIndex, officePropertyId: null }));
    assert.equal(noOffice.centreRequired.length, 1, "office sin oficina central → bloqueado");
  });

  it("(f) orden final por (fecha, nº Sage, centro) y asientos solo de balance con el centro común", () => {
    assert.deepEqual(result.entries.map((entry) => entry.sourceId), ["1:2026:9:1501", "1:2026:9:1503:LT", "1:2026:9:1503:RA", "1:2026:9:1504", "1:2026:9:1506"]);
    const payroll = result.entries.find((entry) => entry.source?.entryNumber === "1506")!;
    assert.deepEqual([payroll.propertyCode, payroll.lines.map((line) => line.costCenterCode)], ["LT", ["ADMIN_GENERAL", null]]);
    // Solo balance con todas las líneas en RA → propertyId RA; con centros distintos → sociedad (null).
    const rows = [row({ asiento: "77", cuenta: "5720000", debe: "10.00", delegacion: "RA" }), row({ asiento: "77", cuenta: "4300000123", haber: "10.00", delegacion: "RA" }), row({ asiento: "78", cuenta: "5720000", debe: "10.00", delegacion: "RA" }), row({ asiento: "78", cuenta: "5700000", haber: "10.00", delegacion: "LT" })];
    const onlyBalance = buildJournalEntries(groupJournalRows(rows), context({ rows }));
    assert.deepEqual(onlyBalance.entries.map((entry) => [entry.sourceId, entry.propertyId, entry.propertyCode]), [["1:2026:9:77", "prop_ra", "RA"], ["1:2026:9:78", null, "SOC"]]);
  });
});

describe("buildJournalEntries · reparto con residuo de céntimos", () => {
  it("shares por línea HALF_UP con el residuo al centro de mayor peso y corrección para que cada parte cuadre", () => {
    const rows = [
      row({ asiento: "90", cuenta: "6290001", debe: "1.00", delegacion: "RA" }),
      row({ asiento: "90", cuenta: "6290001", debe: "2.00", delegacion: "LT" }),
      row({ asiento: "90", cuenta: "4720021", debe: "0.05", tipo_iva: "21", base_iva: "0.24" }),
      row({ asiento: "90", cuenta: "4720010", debe: "0.05", tipo_iva: "10", base_iva: "0.50" }),
      row({ asiento: "90", cuenta: "4100000007", haber: "3.10" })
    ];
    const result = buildJournalEntries(groupJournalRows(rows), context({ rows }));
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.unbalanced, []);
    const parts = result.entries;
    assert.equal(parts.length, 2);
    for (const part of parts) assertEntryBalanced(part);
    const ra = parts.find((part) => part.propertyCode === "RA")!;
    const lt = parts.find((part) => part.propertyCode === "LT")!;
    // RA (peso 1/3): 0.05 → 0.02, 0.05 → 0.02, 3.10 → 1.03 → −0.99 ≠ −1.00: la corrección mueve 0.01 en la línea mayor.
    assert.deepEqual(lineTriples(ra), [["629.1", "1.00", "0.00"], ["472.21", "0.02", "0.00"], ["472.10", "0.02", "0.00"], ["410", "0.00", "1.04"]]);
    assert.deepEqual(lineTriples(lt), [["629.1", "2.00", "0.00"], ["472.21", "0.03", "0.00"], ["472.10", "0.03", "0.00"], ["410", "0.00", "2.06"]]);
    // Consolidado por cuenta exacto al céntimo y Σ partes = asiento Sage.
    const consolidated = new Map<string, ReturnType<typeof money>>();
    for (const part of parts) for (const line of part.lines) consolidated.set(line.accountCode, (consolidated.get(line.accountCode) ?? money(0)).plus(line.debit).minus(line.credit));
    assert.deepEqual([...consolidated].map(([code, net]) => [code, net.toFixed(2)]), [["629.1", "3.00"], ["472.21", "0.05"], ["472.10", "0.05"], ["410", "-3.10"]]);
    assert.equal(sumMoney(parts.map((part) => part.totalDebit)).toFixed(2), "3.10");
    // taxBase se reparte con la misma proporción y suma la base original.
    const bases = parts.map((part) => part.lines[1]!.taxBase!);
    assert.equal(sumMoney(bases).toFixed(2), "0.24");
  });

  it("splitProportionally y distributeSharedLines: Σ partes = importe; sin neto que absorber → null", () => {
    const shares = splitProportionally(money("100.00"), [money("1"), money("1"), money("1")], 2);
    assert.deepEqual(shares.map((share) => share.toFixed(2)), ["33.33", "33.33", "33.34"]);
    assert.equal(sumMoney(shares).toFixed(2), "100.00");
    assert.equal(distributeSharedLines([money("1"), money("-1")], [{ net: money("0"), taxBase: null }]), null);
    const split = distributeSharedLines([money("1"), money("2")], [{ net: money("-3.00"), taxBase: money("1.00") }]);
    assert.ok(split);
    assert.deepEqual(split.shares[0]!.map((share) => share.toFixed(2)), ["-1.00", "-2.00"]);
    assert.deepEqual(split.taxShares[0]!.map((share) => share.toFixed(2)), ["0.33", "0.67"]);
  });

  it("asiento 6/7 entre centros sin líneas de balance → error explicado; > LEDGER_IMPORT_MAX_LINES_PER_ENTRY líneas → error", () => {
    const transfer = [row({ asiento: "91", cuenta: "6290001", debe: "5.00", delegacion: "RA" }), row({ asiento: "91", cuenta: "7050001", haber: "5.00", delegacion: "LT" })];
    const result = buildJournalEntries(groupJournalRows(transfer), context({ rows: transfer }));
    assert.equal(result.statuses.get("1:2026:9:91"), "error");
    assert.match(result.errors[0]!.message, /sin líneas de balance/);
    const many: CanonicalJournalRow[] = [];
    for (let i = 0; i < LEDGER_IMPORT_MAX_LINES_PER_ENTRY; i += 1) many.push(row({ asiento: "92", cuenta: "6290001", debe: "1.00", delegacion: "RA" }));
    many.push(row({ asiento: "92", cuenta: "5720000", haber: String(LEDGER_IMPORT_MAX_LINES_PER_ENTRY) + ".00" }));
    const tooMany = buildJournalEntries(groupJournalRows(many), context({ rows: many }));
    assert.equal(tooMany.statuses.get("1:2026:9:92"), "error");
    assert.match(tooMany.errors[0]!.message, new RegExp(`máximo es ${LEDGER_IMPORT_MAX_LINES_PER_ENTRY}`));
    // Tope configurable (formato real: aperturas / cierres de Sage 200 de miles de líneas): el mismo
    // asiento de 501 líneas con maxLinesPerEntry 600 se planifica entero; con 500 explícito sigue fallando.
    const relaxed = buildJournalEntries(groupJournalRows(many), context({ rows: many, maxLinesPerEntry: 600 }));
    assert.deepEqual(relaxed.errors, []);
    assert.equal(relaxed.statuses.get("1:2026:9:92"), "planned");
    const relaxedEntries = relaxed.entries.filter((entry) => entry.source.entryNumber === "92");
    assert.equal(relaxedEntries.length, 1);
    assert.equal(relaxedEntries[0]!.lines.length, LEDGER_IMPORT_MAX_LINES_PER_ENTRY + 1);
    const explicit = buildJournalEntries(groupJournalRows(many), context({ rows: many, maxLinesPerEntry: 500 }));
    assert.equal(explicit.statuses.get("1:2026:9:92"), "error");
    assert.match(explicit.errors[0]!.message, /máximo es 500$/);
  });
});

describe("buildJournalEntries · entryKind, cuentas y analítica sin mapear, errores", () => {
  it("(b) periodo «Cierre ejercicio» → regularization, «Cierre Contabilidad» → closing, periodo 0 → opening; nivel sociedad; closingDetected", () => {
    const rows = [...parseLedgerImportFile({ kind: "journal", bytes: journalXlsxCargoAbono(JOURNAL_OPENING_AND_JANUARY), fileName: "a.xlsx" }).rows, ...parseLedgerImportFile({ kind: "journal", bytes: journalXlsxCargoAbono(JOURNAL_YEAR_END), fileName: "c.xlsx" }).rows];
    const result = buildJournalEntries(groupJournalRows(rows), context({ rows }));
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.entries.map((entry) => [entry.sourceId, entry.entryKind, entry.propertyId]), [
      ["1:2026:0:1", "opening", null],
      ["1:2026:1:1", "normal", null],
      ["1:2026:regularizacion:9001", "regularization", null],
      ["1:2026:cierre:9002", "closing", null]
    ]);
    assert.deepEqual(result.closingDetected, [
      { sourceEntryNumber: "1", sourcePeriod: "0", entryKind: "opening" },
      { sourceEntryNumber: "9001", sourcePeriod: "regularizacion", entryKind: "regularization" },
      { sourceEntryNumber: "9002", sourcePeriod: "cierre", entryKind: "closing" }
    ]);
    const regularization = result.entries[2]!;
    assert.deepEqual(lineTriples(regularization), [["705.1", "1000.00", "0.00"], ["628.1", "0.00", "250.00"], ["629.1", "0.00", "400.00"], ["621", "0.00", "500.00"], ["640", "0.00", "2000.00"], ["129", "2150.00", "0.00"]]);
    for (const entry of result.entries) assertEntryBalanced(entry);
    // Dos asientos nº 1 (periodos 0 y 1) → claves distintas, sin colisión.
    assert.equal(new Set(result.entries.map((entry) => entry.sourceId)).size, 4);
  });

  it("(b) sin periodo especial: 6/7 contra 129 a fin de ejercicio → regularization; solo balance + «cierre» → closing; solo balance + «apertura» el primer día → opening; el resto normal", () => {
    const rows = [
      row({ asiento: "500", cuenta: "7050001", debe: "10.00", fecha: "2026-12-31", periodo: "12", delegacion: "RA" }),
      row({ asiento: "500", cuenta: "1290000", haber: "10.00", fecha: "2026-12-31", periodo: "12" }),
      row({ asiento: "501", cuenta: "1000000", debe: "10.00", fecha: "2026-12-31", periodo: "12", concepto: "Cierre contabilidad 2026" }),
      row({ asiento: "501", cuenta: "5720000", haber: "10.00", fecha: "2026-12-31", periodo: "12", concepto: "Cierre contabilidad 2026" }),
      row({ asiento: "502", cuenta: "5720000", debe: "10.00", fecha: "2026-01-01", periodo: "1", concepto: "Apertura 2026" }),
      row({ asiento: "502", cuenta: "1000000", haber: "10.00", fecha: "2026-01-01", periodo: "1", concepto: "Apertura 2026" }),
      row({ asiento: "503", cuenta: "5720000", debe: "10.00", fecha: "2026-12-31", periodo: "12", concepto: "Pago proveedor" }),
      row({ asiento: "503", cuenta: "4000000042", haber: "10.00", fecha: "2026-12-31", periodo: "12", concepto: "Pago proveedor" })
    ];
    const result = buildJournalEntries(groupJournalRows(rows), context({ rows }));
    const kinds = new Map(result.entries.map((entry) => [entry.source!.entryNumber, entry.entryKind]));
    assert.deepEqual([...kinds], [["502", "opening"], ["500", "regularization"], ["501", "closing"], ["503", "normal"]]);
    assert.equal(result.closingDetected.length, 3);
  });

  it("cuenta sin mapa o bloqueada → unmapped con recuento y sugerencia; 472/477 por tipo sin PorIva → unmapped", () => {
    const rows = [row({ asiento: "60", cuenta: "9990000001", debe: "1.00", delegacion: "RA" }), row({ asiento: "60", cuenta: "4770000", haber: "1.00" }), row({ asiento: "61", cuenta: "9990000001", debe: "2.00", delegacion: "RA" }), row({ asiento: "61", cuenta: "5720000", haber: "2.00" })];
    const accountMap = accountMapFor(rows);
    accountMap.set("4770000", { sourceAccount: "4770000", action: "map_by_rate", accountCode: "477", carryCounterparty: false });
    accountMap.delete("9990000001");
    const result = buildJournalEntries(groupJournalRows(rows), context({ rows, accountMap, accountNames: new Map([["9990000001", "Cuenta rara"]]) }));
    assert.deepEqual(result.unmapped, [{ sourceAccount: "4770000", sourceName: null, lineCount: 1, suggestion: { sourceAccount: "4770000", action: "map_by_rate", accountCode: "477", carryCounterparty: false } }, { sourceAccount: "9990000001", sourceName: "Cuenta rara", lineCount: 2, suggestion: null }]);
    assert.deepEqual([result.statuses.get("1:2026:9:60"), result.statuses.get("1:2026:9:61")], ["unmapped", "unmapped"]);
    assert.equal(result.entries.length, 0);
  });

  it("delegación sin centro en el mapa → unmappedAnalytics (y política); departamento sin mapa → unmappedCostCentres (no bloquea)", () => {
    const rows = [row({ asiento: "70", cuenta: "6290001", debe: "1.00", delegacion: "ZZ", departamento: "XYZ" }), row({ asiento: "70", cuenta: "5720000", haber: "1.00" })];
    const result = buildJournalEntries(groupJournalRows(rows), context({ rows }));
    assert.deepEqual(result.unmappedAnalytics, [{ dimension: "delegacion", sourceCode: "ZZ", sourceName: null, lineCount: 1 }]);
    assert.deepEqual(result.unmappedCostCentres, [{ dimension: "departamento", sourceCode: "XYZ", sourceName: null, lineCount: 1 }]);
    assert.equal(result.entries[0]?.propertyCode, "OC", "sin centro conocido aplica la política office");
    assert.equal(result.entries[0]?.lines[0]?.costCenterCode, null);
  });

  it("fecha fuera del ejercicio → error; asiento Sage descuadrado → unbalanced con debe y haber", () => {
    const rows = [row({ asiento: "80", cuenta: "5720000", debe: "1.00", fecha: "2025-12-31", periodo: "12", ejercicio: "2025" }), row({ asiento: "80", cuenta: "1000000", haber: "1.00", fecha: "2025-12-31", periodo: "12", ejercicio: "2025" }), row({ asiento: "81", cuenta: "5720000", debe: "1.00" }), row({ asiento: "81", cuenta: "1000000", haber: "0.90" })];
    const result = buildJournalEntries(groupJournalRows(rows), context({ rows }));
    assert.equal(result.statuses.get("1:2025:12:80"), "error");
    assert.match(result.errors[0]!.message, /fuera del ejercicio 2026/);
    assert.deepEqual(result.unbalanced, [{ sourceEntryNumber: "81", sourcePeriod: "9", debit: "1.00", credit: "0.90" }]);
    assert.equal(result.statuses.get("1:2026:9:81"), "unbalanced");
  });

  it("(a) cobros: importe exacto + fecha ± 3 días contra paymentAmounts → skipped_native con aviso de heurística", () => {
    const rows = [row({ asiento: "85", cuenta: "5720000", debe: "1100.00", fecha: "2026-09-12", concepto: "Transferencia recibida" }), row({ asiento: "85", cuenta: "4300000123", haber: "1100.00", fecha: "2026-09-12", concepto: "Transferencia recibida" })];
    const paymentAmounts = new Map([["1100.00", [{ invoiceNumber: "FAC-2026-000015", sourceType: "payment", sourceId: "payment/pay_1", date: "2026-09-10" }]]]);
    const result = buildJournalEntries(groupJournalRows(rows), context({ rows, nativeIndex: { invoiceKeys: new Map(), paymentAmounts } }));
    assert.deepEqual(result.skippedNative, [{ sourceEntryNumber: "85", sourcePeriod: "9", sourceChannel: null, series: null, number: null, invoiceNumber: "FAC-2026-000015", sourceType: "payment", sourceId: "payment/pay_1" }]);
    assert.ok(result.warnings.some((warning) => warning.includes(`± ${NATIVE_PAYMENT_DATE_TOLERANCE_DAYS} días`)));
    // Fuera de la ventana o con otro importe: se importa.
    const far = buildJournalEntries(groupJournalRows(rows), context({ rows, nativeIndex: { invoiceKeys: new Map(), paymentAmounts: new Map([["1100.00", [{ invoiceNumber: null, sourceType: "payment", sourceId: "payment/pay_2", date: "2026-09-01" }]]]) } }));
    assert.equal(far.skippedNative.length, 0);
    assert.equal(far.entries.length, 1);
  });

  it("(a) cobros: la heurística importe + fecha exige el mismo centro cuando el cobro nativo y el asiento Sage lo tienen", () => {
    // Cobro de Sage de la delegación LT (12,50 el 11/09) y cobro nativo del mismo importe y fecha pero de RA: NO se excluye.
    const rows = [row({ asiento: "86", cuenta: "5700000", debe: "12.50", fecha: "2026-09-11", delegacion: "LT", concepto: "Cobro caja" }), row({ asiento: "86", cuenta: "4300000123", haber: "12.50", fecha: "2026-09-11", delegacion: "LT", concepto: "Cobro caja" })];
    const ref = { invoiceNumber: "FAC-2026-000015", sourceType: "payment", sourceId: "payment/pay_ra", date: "2026-09-12" };
    const otherCentre = buildJournalEntries(groupJournalRows(rows), context({ rows, nativeIndex: { invoiceKeys: new Map(), paymentAmounts: new Map([["12.50", [{ ...ref, propertyId: "prop_ra" }]]]) } }));
    assert.equal(otherCentre.skippedNative.length, 0);
    assert.equal(otherCentre.entries.length, 1);
    assert.equal(otherCentre.entries[0]!.propertyId, "prop_lt");
    // Mismo centro: se excluye como antes.
    const sameCentre = buildJournalEntries(groupJournalRows(rows), context({ rows, nativeIndex: { invoiceKeys: new Map(), paymentAmounts: new Map([["12.50", [{ ...ref, propertyId: "prop_lt" }]]]) } }));
    assert.equal(sameCentre.skippedNative.length, 1);
    assert.equal(sameCentre.skippedNative[0]!.sourceId, "payment/pay_ra");
    // Cobro nativo sin centro (compatibilidad) o asiento Sage sin analítica de centro: se compara solo por importe y fecha.
    const noCentre = buildJournalEntries(groupJournalRows(rows), context({ rows, nativeIndex: { invoiceKeys: new Map(), paymentAmounts: new Map([["12.50", [ref]]]) } }));
    assert.equal(noCentre.skippedNative.length, 1);
    const plain = rows.map((line) => ({ ...line, delegacion: null }));
    const noAnalytics = buildJournalEntries(groupJournalRows(plain), context({ rows: plain, nativeIndex: { invoiceKeys: new Map(), paymentAmounts: new Map([["12.50", [{ ...ref, propertyId: "prop_ra" }]]]) } }));
    assert.equal(noAnalytics.skippedNative.length, 1);
    // Líneas de dos centros distintos → sin centro único → se compara solo por importe y fecha.
    const mixed = [rows[0]!, { ...rows[1]!, delegacion: "MC" }];
    const mixedResult = buildJournalEntries(groupJournalRows(mixed), context({ rows: mixed, nativeIndex: { invoiceKeys: new Map(), paymentAmounts: new Map([["12.50", [{ ...ref, propertyId: "prop_ra" }]]]) } }));
    assert.equal(mixedResult.skippedNative.length, 1);
  });
});

// ---------------------------------------------------------------------------
// Saldos sin diario (§6)
// ---------------------------------------------------------------------------

const balanceRows2025 = parseCanonicalCsv("balances", balancesCanonicalCsv(BALANCES_2025, "2025", "2025")).rows;
const balanceMap = accountMapFor(balanceRows2025);
const FISCAL_2025 = { code: "2025", startDate: "2025-01-01", endDate: "2025-12-31" };

describe("buildBalanceEntries · §6", () => {
  const result = buildBalanceEntries(balanceRows2025, { accountMap: balanceMap, fiscalYear: FISCAL_2025, properties, unassignedPolicy: "block", companyCode: "1" });

  it("apertura (opening, nivel sociedad), resumen del periodo con Debe/Haber brutos, regularización (6/7 contra 129) y cierre; todo cuadra", () => {
    assert.deepEqual(result.unbalanced, []);
    assert.deepEqual(result.centreRequired, []);
    assert.deepEqual(result.unmapped, []);
    assert.deepEqual(result.entries.map((entry) => [entry.sourceId, entry.entryDate, entry.entryKind, entry.propertyCode, entry.sourceType]), [
      ["1:2025:apertura:SOC", "2025-01-01", "opening", "SOC", "sage200_balance"],
      ["1:2025:2025:RA", "2025-12-31", "normal", "RA", "sage200_balance"],
      ["1:2025:regularizacion:SOC", "2025-12-31", "regularization", "SOC", "sage200_balance"],
      ["1:2025:cierre:SOC", "2025-12-31", "closing", "SOC", "sage200_balance"]
    ]);
    for (const entry of result.entries) assertEntryBalanced(entry);
    const [opening, period, regularization, closing] = result.entries as [PlannedEntry, PlannedEntry, PlannedEntry, PlannedEntry];
    assert.deepEqual(lineTriples(opening), [["100", "0.00", "9000.00"], ["400", "0.00", "3000.00"], ["4300", "2000.00", "0.00"], ["572", "10000.00", "0.00"]]);
    assert.equal(opening.propertyId, null);
    assert.deepEqual(lineTriples(period), [["400", "3000.00", "0.00"], ["400", "0.00", "4000.00"], ["4300", "9000.00", "0.00"], ["4300", "0.00", "8000.00"], ["572", "8000.00", "0.00"], ["572", "0.00", "3000.00"], ["628.1", "4000.00", "0.00"], ["705.1", "0.00", "9000.00"]], "brutos, no netos");
    assert.equal(period.propertyId, "prop_ra", "un solo centro con 6/7: el resumen va a ese centro");
    assert.match(period.reference, /Sage 200 · saldos 2025 · RA/);
    assert.deepEqual(lineTriples(regularization), [["628.1", "0.00", "4000.00"], ["705.1", "9000.00", "0.00"], ["129", "0.00", "5000.00"]]);
    assert.deepEqual(lineTriples(closing), [["100", "9000.00", "0.00"], ["129", "5000.00", "0.00"], ["400", "4000.00", "0.00"], ["4300", "0.00", "3000.00"], ["572", "0.00", "15000.00"]]);
    assert.equal(result.balances.length, BALANCES_2025.length);
    assert.deepEqual(result.balances.find((balance) => balance.sourceAccount === "5720000"), { fiscalYearCode: "2025", periodCode: "2025", propertyId: null, propertyCode: "SOC", sourceAccount: "5720000", sourceName: "Bancos c/c", accountCode: "572", openingDebit: "10000.00", openingCredit: "0.00", periodDebit: "8000.00", periodCredit: "3000.00", closingBalance: "15000.00" });
  });

  it("apertura(N+1) = cierre(N) al céntimo (con el 129 tras la regularización); un céntimo de diferencia se informa por cuenta", () => {
    const opening2026 = parseCanonicalCsv("balances", balancesCanonicalCsv(openingRows2026(), "2026", "apertura")).rows;
    const ok = buildBalanceEntries(opening2026, { accountMap: balanceMap, fiscalYear: FISCAL_2026, properties, unassignedPolicy: "block", companyCode: "1", previousClosing: balanceRows2025 });
    assert.deepEqual(ok.continuity, { ok: true, differences: [] });
    assert.deepEqual(ok.entries.map((entry) => [entry.sourceId, entry.entryKind]), [["1:2026:apertura:SOC", "opening"]]);
    assertEntryBalanced(ok.entries[0]!);
    assert.deepEqual(lineTriples(ok.entries[0]!), [["100", "0.00", "9000.00"], ["400", "0.00", "4000.00"], ["4300", "3000.00", "0.00"], ["572", "15000.00", "0.00"], ["129", "0.00", "5000.00"]]);
    const broken = parseCanonicalCsv("balances", balancesCanonicalCsv(openingRows2026({ break: true }), "2026", "apertura")).rows;
    const bad = buildBalanceEntries(broken, { accountMap: balanceMap, fiscalYear: FISCAL_2026, properties, unassignedPolicy: "block", companyCode: "1", previousClosing: balanceRows2025 });
    assert.equal(bad.continuity?.ok, false);
    assert.deepEqual(bad.continuity?.differences, [{ accountCode: "572", closing: "15000.00", opening: "15000.01", delta: "0.01" }]);
    assert.ok(bad.unbalanced.length === 1 || bad.warnings.some((warning) => /129/.test(warning)), "la apertura rota descuadra en un céntimo: se lleva a 129 con aviso");
    // Versión pura por cuentas Sage.
    assert.deepEqual(checkOpeningContinuity(balanceRows2025, opening2026), { ok: true, differences: [] });
    assert.equal(checkOpeningContinuity(balanceRows2025, broken).differences[0]?.accountCode, "5720000");
  });

  it("periodo con 6/7 en varios centros: una parte por centro con las cuentas de balance de sociedad repartidas; sin delegación y block → centreRequired", () => {
    const rows: CanonicalBalanceRow[] = [
      { line: 2, empresa: "1", ejercicio: "2025", periodo: "2025-03", cuenta: "6280001", titulo: "Electricidad", delegacion: "RA", apertura_debe: "0.00", apertura_haber: "0.00", debe: "100.00", haber: "0.00", saldo_deudor: "100.00", saldo_acreedor: "0.00" },
      { line: 3, empresa: "1", ejercicio: "2025", periodo: "2025-03", cuenta: "6280001", titulo: "Electricidad", delegacion: "LT", apertura_debe: "0.00", apertura_haber: "0.00", debe: "200.00", haber: "0.00", saldo_deudor: "200.00", saldo_acreedor: "0.00" },
      { line: 4, empresa: "1", ejercicio: "2025", periodo: "2025-03", cuenta: "4720021", titulo: "IVA soportado", delegacion: null, apertura_debe: "0.00", apertura_haber: "0.00", debe: "63.00", haber: "0.00", saldo_deudor: "63.00", saldo_acreedor: "0.00" },
      { line: 5, empresa: "1", ejercicio: "2025", periodo: "2025-03", cuenta: "4000000", titulo: "Proveedores", delegacion: null, apertura_debe: "0.00", apertura_haber: "0.00", debe: "0.00", haber: "363.00", saldo_deudor: "0.00", saldo_acreedor: "363.00" }
    ];
    const map = accountMapFor(rows);
    const split = buildBalanceEntries(rows, { accountMap: map, fiscalYear: FISCAL_2025, properties, unassignedPolicy: "block", companyCode: "1" });
    assert.deepEqual(split.unbalanced, []);
    assert.deepEqual(split.entries.map((entry) => [entry.sourceId, entry.propertyCode, entry.entryDate]), [["1:2025:2025-03:LT", "LT", "2025-03-31"], ["1:2025:2025-03:RA", "RA", "2025-03-31"]]);
    for (const entry of split.entries) assertEntryBalanced(entry);
    assert.deepEqual(lineTriples(split.entries.find((entry) => entry.propertyCode === "RA")!), [["628.1", "100.00", "0.00"], ["472.21", "21.00", "0.00"], ["400", "0.00", "121.00"]]);
    assert.deepEqual(lineTriples(split.entries.find((entry) => entry.propertyCode === "LT")!), [["628.1", "200.00", "0.00"], ["472.21", "42.00", "0.00"], ["400", "0.00", "242.00"]]);
    assert.ok(split.entries[0]!.warnings.some((warning) => /repartido entre 2 centros/.test(warning)));
    assert.ok(split.warnings.some((warning) => /no se genera el asiento de apertura/.test(warning)), "2025-03 no es el primer periodo: sin apertura, avisado");
    const unassigned = rows.map((r) => ({ ...r, delegacion: null }));
    const blocked = buildBalanceEntries(unassigned, { accountMap: map, fiscalYear: FISCAL_2025, properties, unassignedPolicy: "block", companyCode: "1" });
    assert.deepEqual(blocked.centreRequired, [{ periodCode: "2025-03", propertyCode: "SOC", accounts: ["6280001"] }]);
    assert.equal(blocked.entries.length, 0);
    const office = buildBalanceEntries(unassigned, { accountMap: map, fiscalYear: FISCAL_2025, properties, unassignedPolicy: "office", officePropertyId: "prop_oc", companyCode: "1" });
    assert.deepEqual(office.entries.map((entry) => [entry.sourceId, entry.propertyCode]), [["1:2025:2025-03:OC", "OC"]]);
  });

  it("descuadre del periodo → LEDGER_IMPORT_UNBALANCED con periodo, centro, diferencia y cuentas; filas de otro ejercicio se ignoran con aviso; cuenta sin mapa → unmapped", () => {
    const rows = balanceRows2025.map((r) => (r.cuenta === "5720000" ? { ...r, debe: "8000.01" } : r));
    const result = buildBalanceEntries([...rows, { ...rows[0]!, ejercicio: "2024" }], { accountMap: balanceMap, fiscalYear: FISCAL_2025, properties, unassignedPolicy: "block", companyCode: "1" });
    assert.equal(result.unbalanced.length, 1);
    assert.deepEqual([result.unbalanced[0]!.periodCode, result.unbalanced[0]!.propertyCode, result.unbalanced[0]!.difference], ["2025", "RA", "0.01"]);
    assert.ok(result.unbalanced[0]!.accounts.some((account) => account.accountCode === "572"), "la cuenta con el céntimo de más aparece entre las de mayor importe");
    assert.ok(result.warnings.some((warning) => /1 filas de otros ejercicios/.test(warning)));
    const withoutMap = new Map(balanceMap);
    withoutMap.delete("6280001");
    const unmapped = buildBalanceEntries(balanceRows2025, { accountMap: withoutMap, fiscalYear: FISCAL_2025, properties, unassignedPolicy: "block", companyCode: "1" });
    assert.deepEqual(unmapped.unmapped.map((item) => [item.sourceAccount, item.sourceName, item.lineCount]), [["6280001", "Electricidad", 1]]);
    assert.equal(unmapped.entries.length, 0);
  });
});

// ---------------------------------------------------------------------------
// Libros de IVA y reconciliación
// ---------------------------------------------------------------------------

describe("buildVatBookRows", () => {
  it("filas VatBookRow con sourceType sage200, sourceId empresa:ejercicio:serie:factura[:NIF:recepción|fecha en recibidas][:R], periodo por periodicidad y NIF normalizado", () => {
    const vat = parseSageVatBook(aeatVatBookXlsx()).rows;
    const quarterly = buildVatBookRows(vat, { periodicity: "quarterly", organizationId: "org_test", propertyId: null });
    assert.deepEqual(quarterly.warnings, []);
    assert.deepEqual(quarterly.rows.map((r) => [r.book, r.sourceId, r.period, r.rate.toFixed(0), r.deductible]), [
      ["emitidas", "1:2026:FAC-2026:000010", "2026-Q3", "10", true],
      ["emitidas", "1:2026:FAC-2026:000011", "2026-Q3", "21", true],
      ["emitidas", "1:2026:REC-2026:000003:R", "2026-Q3", "10", true],
      ["recibidas", `1:2026:F:778:${NIF_SUMINISTROS}:2026-09-03`, "2026-Q3", "21", true],
      ["recibidas", `1:2026:L:91:${NIF_LAVANDERIA}:2026-09-05`, "2026-Q3", "21", true]
    ]);
    const first = quarterly.rows[0]!;
    assert.equal(first.sourceType, LEDGER_VAT_BOOK_SOURCE_TYPE);
    assert.equal(first.sourceType, "sage200");
    assert.deepEqual([first.organizationId, first.propertyId, first.date, first.series, first.number, first.counterpartyNif, first.counterpartyName, first.base.toFixed(2), first.quota.toFixed(2), first.total.toFixed(2), first.retention.toFixed(2), first.taxFigure, first.id], ["org_test", null, "2026-07-03", "FAC-2026", "000010", "A23456783", "VIAJES CANTABRICO SL", "1000.00", "100.00", "1100.00", "0.00", "IVA", null]);
    assert.equal(quarterly.rows[2]!.base.toFixed(2), "-100.00", "rectificativa con signo");
    const monthly = buildVatBookRows(vat, { periodicity: "monthly", organizationId: "org_test" });
    assert.deepEqual(monthly.rows.map((r) => r.period), ["2026-07", "2026-08", "2026-09", "2026-09", "2026-09"]);
  });

  it("misma factura repetida con el mismo tipo → se acumula con aviso; cuota deducible 0 → no deducible", () => {
    const vat = parseSageVatBook(aeatVatBookXlsx()).rows;
    const duplicated = buildVatBookRows([vat[3]!, vat[3]!, { ...vat[4]!, cuota_deducible: "0.00" }], { periodicity: "quarterly", organizationId: "org_test", companyCode: "7" });
    assert.equal(duplicated.rows.length, 2);
    assert.equal(duplicated.rows[0]!.base.toFixed(2), "500.00");
    assert.equal(duplicated.rows[0]!.sourceId, `7:2026:F:778:${NIF_SUMINISTROS}:2026-09-03`);
    assert.equal(duplicated.rows[1]!.deductible, false);
    assert.equal(duplicated.warnings.length, 1);
  });
});

describe("buildReconciliationRows · §5.2", () => {
  const ledgerOk = [
    { accountCode: "100", debit: "0.00", credit: "0.00", balance: "-9000.00", sourceTypes: ["sage200_balance"] },
    { accountCode: "129", debit: "0.00", credit: "0.00", balance: "0.00", sourceTypes: [] },
    { accountCode: "400", debit: "3000.00", credit: "4000.00", balance: "-4000.00", sourceTypes: ["sage200_balance"] },
    { accountCode: "4300", debit: "9000.00", credit: "8000.00", balance: "3000.00", sourceTypes: ["sage200_balance"] },
    { accountCode: "572", debit: "8000.00", credit: "3000.00", balance: "15000.00", sourceTypes: ["sage200_balance"] },
    { accountCode: "628.1", debit: "4000.00", credit: "0.00", sourceTypes: ["sage200_balance"] },
    { accountCode: "705.1", debit: "0.00", credit: "9000.00", sourceTypes: ["sage200_balance"] }
  ];

  it("ok cuando cada cuenta destino coincide al céntimo (delta = ehotelOS − Sage)", () => {
    const result = buildReconciliationRows(balanceRows2025, ledgerOk, { accountMap: balanceMap, accountNames: new Map([["572", "Bancos"]]) });
    assert.equal(result.status, "ok");
    assert.equal(result.differenceCount, 0);
    assert.equal(result.accountsCompared, 7);
    assert.deepEqual(result.summary, { nativeOnly: 0, missingInLedger: 0, amountDiff: 0, vatDiff: 0, tolerance: "0.00", criterion: result.summary.criterion });
    const bank = result.rows.find((r) => r.accountCode === "572")!;
    assert.deepEqual([bank.sourceAccounts, bank.accountName, bank.sourceDebit, bank.ledgerDebit, bank.diffDebit, bank.sourceBalance, bank.ledgerBalance, bank.diffBalance, bank.ok, bank.classification, bank.tolerance], [["5720000"], "Bancos", "8000.00", "8000.00", "0.00", "15000.00", "15000.00", "0.00", true, null, "0.00"]);
  });

  it("amount_diff, native_only, missing_in_ledger (diario sin la cuenta y cuenta Sage sin mapear) y tolerancia por asientos repartidos", () => {
    const ledger = ledgerOk.filter((r) => r.accountCode !== "628.1").map((r) => (r.accountCode === "572" ? { ...r, debit: "8000.02" } : r));
    ledger.push({ accountCode: "477.10", debit: "0.00", credit: "100.00", sourceTypes: ["invoice"] });
    const withoutMap = new Map(balanceMap);
    withoutMap.delete("7050001");
    const result = buildReconciliationRows(balanceRows2025, ledger, { accountMap: withoutMap });
    assert.equal(result.status, "differences");
    const byAccount = new Map(result.rows.map((r) => [r.accountCode, r]));
    assert.equal(byAccount.get("572")?.classification, "amount_diff");
    assert.equal(byAccount.get("572")?.diffDebit, "0.02");
    assert.equal(byAccount.get("477.10")?.classification, "native_only");
    assert.equal(byAccount.get("628.1")?.classification, "missing_in_ledger");
    assert.equal(byAccount.get("7050001")?.classification, "missing_in_ledger");
    assert.match(byAccount.get("7050001")?.note ?? "", /sin mapear/);
    assert.equal(byAccount.get("705.1")?.classification, "amount_diff", "cuenta solo en el diario pero de origen importado: diferencia de importe, no native_only");
    assert.deepEqual([result.summary.amountDiff, result.summary.nativeOnly, result.summary.missingInLedger], [2, 1, 2]);
    assert.equal(result.differenceCount, 5);
    // 0,01 × 2 asientos repartidos en 572 absorbe los 0,02 de diferencia.
    const tolerant = buildReconciliationRows(balanceRows2025, ledger, { accountMap: withoutMap, splitEntriesByAccount: new Map([["572", 2]]) });
    assert.equal(tolerant.rows.find((r) => r.accountCode === "572")?.ok, true);
    assert.equal(tolerant.rows.find((r) => r.accountCode === "572")?.tolerance, "0.02");
    assert.equal(tolerant.differenceCount, 4);
  });
});

// ---------------------------------------------------------------------------
// Correcciones de la revisión (Tanda 7c · ronda 1): C1, C3, C4, C5, C6, C9, SD-04, SD-05
// ---------------------------------------------------------------------------

describe("correcciones ronda 1 · libros de IVA (C1, C6)", () => {
  const vat = parseSageVatBook(aeatVatBookXlsx()).rows;

  it("C6 · dos proveedores que numeran «1» no se funden: el sourceId de recibidas lleva el NIF y salen dos filas sin aviso de repetida", () => {
    const base = vat.find((row) => row.libro === "recibidas")!;
    const rows = [
      { ...base, serie: null, numero: "1", nif: "A12345674", nombre: "PROVEEDOR UNO SL", base: "100.00", tipo_iva: "21", cuota: "21.00", total: "121.00" },
      { ...base, serie: null, numero: "1", nif: "A23456783", nombre: "PROVEEDOR DOS SL", base: "100.00", tipo_iva: "21", cuota: "21.00", total: "121.00" }
    ];
    const built = buildVatBookRows(rows, { periodicity: "quarterly", organizationId: "org_test", companyCode: "1" });
    assert.deepEqual(built.warnings, []);
    assert.deepEqual(built.rows.map((r) => [r.sourceId, r.counterpartyNif, r.base.toFixed(2)]), [["1:2026::1:A12345674:2026-09-03", "A12345674", "100.00"], ["1:2026::1:A23456783:2026-09-03", "A23456783", "100.00"]]);
    // Emitidas: la serie + número propios ya son únicos; sin NIF en la clave.
    assert.equal(built.rows.every((r) => r.book === "recibidas"), true);
    assert.equal(buildVatBookRows([vat[0]!], { periodicity: "quarterly", organizationId: "org_test" }).rows[0]!.sourceId, "1:2026:FAC-2026:000010");
  });

  it("C1 · con el índice nativo, la emitida FAC-2026-000010 (factura propia) y la recibida F/778 (ya contabilizada en ehotelOS) van a skippedNative y no al libro", () => {
    const nativeIndex = {
      invoiceKeys: new Map([[nativeInvoiceKey("FAC-2026-000010")!, { invoiceId: "inv_10", invoiceNumber: "FAC-2026-000010", sourceType: "invoice", sourceId: "inv_10" }]]),
      supplierBillKeys: new Map([[`${NIF_SUMINISTROS}|:778`, { invoiceId: null, invoiceNumber: "778", sourceType: "supplier_bill", sourceId: "sb_1" }]])
    };
    const built = buildVatBookRows(vat, { periodicity: "quarterly", organizationId: "org_test", nativeIndex });
    assert.deepEqual(built.rows.map((r) => r.sourceId), ["1:2026:FAC-2026:000011", "1:2026:REC-2026:000003:R", `1:2026:L:91:${NIF_LAVANDERIA}:2026-09-05`]);
    assert.deepEqual(built.skippedNative.map((r) => [r.sourceChannel, r.sourceEntryNumber, r.invoiceNumber, r.sourceType, r.sourceId, r.sourcePeriod]), [
      ["emitidas", "000010", "FAC-2026-000010", "invoice", "inv_10", "2026-Q3"],
      ["recibidas", "778", "778", "supplier_bill", "sb_1", "2026-Q3"]
    ]);
    assert.ok(built.warnings.some((warning) => /2 factura\(s\) del libro de Sage son documentos propios/.test(warning)));
    assert.equal(buildVatBookRows(vat, { periodicity: "quarterly", organizationId: "org_test" }).skippedNative.length, 0, "sin índice nativo no se excluye nada");
  });
});

describe("correcciones ronda 1 · reconciliación (C3, C4)", () => {
  function balanceRow(partial: Partial<CanonicalBalanceRow> & { cuenta: string; periodo: string }): CanonicalBalanceRow {
    return { line: 2, empresa: "1", ejercicio: "2026", titulo: null, delegacion: null, apertura_debe: "0.00", apertura_haber: "0.00", debe: "0.00", haber: "0.00", saldo_deudor: "0.00", saldo_acreedor: "0.00", ...partial };
  }

  it("C3 · balance mensual sobre un trimestre: Debe / Haber se suman y el saldo es el ACUMULADO de la última fila (no la suma de saldos)", () => {
    const rows = [balanceRow({ cuenta: "5720000", periodo: "2026-01", debe: "100.00", saldo_deudor: "100.00" }), balanceRow({ cuenta: "5720000", periodo: "2026-02", debe: "50.00", saldo_deudor: "150.00" })];
    const map = accountMapFor(rows);
    const result = buildReconciliationRows(rows, [{ accountCode: "572", debit: "150.00", credit: "0.00", balance: "150.00", sourceTypes: ["sage200_journal"] }], { accountMap: map });
    const bank = result.rows.find((r) => r.accountCode === "572")!;
    assert.deepEqual([bank.sourceDebit, bank.ledgerDebit, bank.sourceBalance, bank.ledgerBalance, bank.ok, bank.classification, result.status], ["150.00", "150.00", "150.00", "150.00", true, null, "ok"]);
    // Con delegaciones: la última fila de CADA (cuenta, delegación) se suma en el consolidado.
    const byCentre = [
      balanceRow({ cuenta: "5720000", periodo: "2026-01", delegacion: "RA", debe: "100.00", saldo_deudor: "100.00" }),
      balanceRow({ cuenta: "5720000", periodo: "2026-02", delegacion: "RA", debe: "50.00", saldo_deudor: "150.00" }),
      balanceRow({ cuenta: "5720000", periodo: "2026-01", delegacion: "LT", debe: "10.00", saldo_deudor: "10.00" })
    ];
    const consolidated = buildReconciliationRows(byCentre, [{ accountCode: "572", debit: "160.00", credit: "0.00", balance: "160.00" }], { accountMap: map });
    assert.deepEqual([consolidated.rows[0]!.sourceBalance, consolidated.rows[0]!.ok], ["160.00", true]);
  });

  it("C4 · cuenta de IVA por tipo (map_by_rate 477): 4770000 se compara con Σ 477.xx del diario; sin fila «sin mapear» ni amount_diff en 477.10 / 477.21", () => {
    const rows = [balanceRow({ cuenta: "4770000", periodo: "2026-09", haber: "31.00", saldo_acreedor: "31.00" }), balanceRow({ cuenta: "5720000", periodo: "2026-09", debe: "31.00", saldo_deudor: "31.00" })];
    const map = accountMapFor(rows, [{ sourceAccount: "4770000", action: "map_by_rate", accountCode: "477", carryCounterparty: false }]);
    const ledger = [
      { accountCode: "477.10", accountName: "IVA repercutido 10 %", debit: "0.00", credit: "10.00", balance: "-10.00", sourceTypes: ["sage200_journal"] },
      { accountCode: "477.21", accountName: "IVA repercutido 21 %", debit: "0.00", credit: "21.00", balance: "-21.00", sourceTypes: ["sage200_journal"] },
      { accountCode: "572", debit: "31.00", credit: "0.00", balance: "31.00", sourceTypes: ["sage200_journal"] }
    ];
    const result = buildReconciliationRows(rows, ledger, { accountMap: map, accountNames: new Map([["477", "IVA repercutido"]]) });
    assert.equal(result.status, "ok");
    assert.deepEqual(result.rows.map((r) => [r.accountCode, r.sourceAccounts, r.sourceCredit, r.ledgerCredit, r.sourceBalance, r.ledgerBalance, r.ok, r.accountName]), [
      ["477", ["4770000"], "31.00", "31.00", "-31.00", "-31.00", true, "IVA repercutido"],
      ["572", ["5720000"], "0.00", "0.00", "31.00", "31.00", true, null]
    ]);
    // Una 477.21 con mapa propio (4770021 → 477.21) NO se pliega al prefijo.
    const explicit = accountMapFor([...rows, { cuenta: "4770021" }], [{ sourceAccount: "4770000", action: "map_by_rate", accountCode: "477", carryCounterparty: false }]);
    const mixed = buildReconciliationRows([...rows, balanceRow({ cuenta: "4770021", periodo: "2026-09", haber: "21.00", saldo_acreedor: "21.00" })], ledger, { accountMap: explicit });
    assert.deepEqual(mixed.rows.filter((r) => r.accountCode.startsWith("477")).map((r) => [r.accountCode, r.sourceCredit, r.ledgerCredit]), [["477", "31.00", "10.00"], ["477.21", "21.00", "21.00"]]);
  });
});

describe("correcciones ronda 1 · saldos por delegación (C5) y destino inexistente (SD-05)", () => {
  it("C5 · fichero entero por delegación con cada delegación cuadrada: un asiento por centro, sin LEDGER_IMPORT_UNBALANCED de 0,00", () => {
    const rows: CanonicalBalanceRow[] = [
      { line: 2, empresa: "1", ejercicio: "2025", periodo: "2025-01", cuenta: "6290001", titulo: "Lavandería", delegacion: "RA", apertura_debe: "0.00", apertura_haber: "0.00", debe: "100.00", haber: "0.00", saldo_deudor: "100.00", saldo_acreedor: "0.00" },
      { line: 3, empresa: "1", ejercicio: "2025", periodo: "2025-01", cuenta: "5720000", titulo: "Bancos", delegacion: "RA", apertura_debe: "0.00", apertura_haber: "0.00", debe: "0.00", haber: "100.00", saldo_deudor: "0.00", saldo_acreedor: "100.00" },
      { line: 4, empresa: "1", ejercicio: "2025", periodo: "2025-01", cuenta: "6290001", titulo: "Lavandería", delegacion: "LT", apertura_debe: "0.00", apertura_haber: "0.00", debe: "200.00", haber: "0.00", saldo_deudor: "200.00", saldo_acreedor: "0.00" },
      { line: 5, empresa: "1", ejercicio: "2025", periodo: "2025-01", cuenta: "5720000", titulo: "Bancos", delegacion: "LT", apertura_debe: "0.00", apertura_haber: "0.00", debe: "0.00", haber: "200.00", saldo_deudor: "0.00", saldo_acreedor: "200.00" }
    ];
    const result = buildBalanceEntries(rows, { accountMap: accountMapFor(rows), fiscalYear: FISCAL_2025, properties, unassignedPolicy: "block", companyCode: "1" });
    assert.deepEqual(result.unbalanced, []);
    assert.deepEqual(result.entries.map((entry) => [entry.sourceId, entry.propertyCode, entry.totalDebit]), [["1:2025:2025-01:LT", "LT", "200.00"], ["1:2025:2025-01:RA", "RA", "100.00"]]);
    for (const entry of result.entries) assertEntryBalanced(entry);
    // Una delegación descuadrada con Σ neto = 0 entre centros: se señala ESA parte con su diferencia, no «SOC 0,00».
    const broken = rows.map((r) => (r.line === 3 ? { ...r, haber: "90.00", saldo_acreedor: "90.00" } : r.line === 5 ? { ...r, haber: "210.00", saldo_acreedor: "210.00" } : r));
    const bad = buildBalanceEntries(broken, { accountMap: accountMapFor(rows), fiscalYear: FISCAL_2025, properties, unassignedPolicy: "block", companyCode: "1" });
    assert.deepEqual(bad.unbalanced.map((item) => [item.propertyCode, item.difference]), [["RA", "10.00"], ["LT", "-10.00"]]);
    assert.equal(bad.entries.length, 0);
  });

  it("SD-05 · con isPostableCode, un destino inexistente (create 623.2 aún sin dar de alta) o cabecera deja la cuenta Sage unmapped con la propuesta, y una map_by_rate resuelta a una 477.xx inexistente igual", () => {
    const rows = [row({ asiento: "90", cuenta: "6230002", debe: "100.00", delegacion: "RA" }), row({ asiento: "90", cuenta: "4770000", haber: "100.00", tipo_iva: "5" })];
    const accountMap = accountMapFor(rows);
    accountMap.set("4770000", { sourceAccount: "4770000", action: "map_by_rate", accountCode: "477", carryCounterparty: false });
    assert.equal(accountMap.get("6230002")?.action, "create", "regla 6: 623.2 no existe en la plantilla");
    assert.equal(chart.has("477.05"), false, "IVA del 5 % sin subcuenta en la plantilla: la map_by_rate resuelve a una cuenta inexistente");
    const result = buildJournalEntries(groupJournalRows(rows), context({ rows, accountMap, isPostableCode: (code) => chart.get(code)?.isPostable === true }));
    assert.deepEqual(result.unmapped.map((item) => [item.sourceAccount, item.suggestion?.action, item.suggestion?.accountCode]), [["4770000", "map_by_rate", "477"], ["6230002", "create", "623.2"]]);
    assert.equal(result.statuses.get("1:2026:9:90"), "unmapped");
    assert.equal(result.entries.length, 0);
    // Sin la función (contexto de los tests puros) se confía en el mapa.
    const trusted = buildJournalEntries(groupJournalRows(rows), context({ rows, accountMap }));
    assert.equal(trusted.unmapped.length, 0);
    // Cabecera explícita en el mapa (62 es un grupo de dos dígitos, no postable) → unmapped también.
    const header = accountMapFor(rows, [{ sourceAccount: "6230002", action: "map", accountCode: "62", carryCounterparty: false }]);
    header.set("4770000", { sourceAccount: "4770000", action: "map", accountCode: "477.4", carryCounterparty: false });
    const blocked = buildJournalEntries(groupJournalRows(rows), context({ rows, accountMap: header, isPostableCode: (code) => chart.get(code)?.isPostable === true }));
    assert.deepEqual(blocked.unmapped.map((item) => item.sourceAccount), ["4770000", "6230002"]);
  });
});

describe("correcciones ronda 1 · apertura / cierre por estructura (C9) y cobros consumidos (SD-04)", () => {
  it("C9 · «Apertura cuenta bancaria nueva» 572 / 570 del 1 de enero y «Cierre de caja» 570 / 572 del 31 de diciembre son asientos normales; una apertura real (dos grupos) sigue siendo opening", () => {
    const rows = [
      row({ asiento: "5", cuenta: "5720000", debe: "300.00", fecha: "2026-01-01", periodo: "1", concepto: "Apertura cuenta bancaria nueva" }),
      row({ asiento: "5", cuenta: "5700000", haber: "300.00", fecha: "2026-01-01", periodo: "1", concepto: "Apertura cuenta bancaria nueva" }),
      row({ asiento: "6", cuenta: "5700000", debe: "20.00", fecha: "2026-12-31", periodo: "12", concepto: "Cierre de caja" }),
      row({ asiento: "6", cuenta: "5720000", haber: "20.00", fecha: "2026-12-31", periodo: "12", concepto: "Cierre de caja" }),
      row({ asiento: "7", cuenta: "5720000", debe: "10.00", fecha: "2026-01-01", periodo: "1", concepto: "Asiento de apertura" }),
      row({ asiento: "7", cuenta: "1000000", haber: "10.00", fecha: "2026-01-01", periodo: "1", concepto: "Asiento de apertura" })
    ];
    const result = buildJournalEntries(groupJournalRows(rows), context({ rows }));
    assert.deepEqual(result.entries.map((entry) => [entry.source!.entryNumber, entry.entryKind]), [["5", "normal"], ["7", "opening"], ["6", "normal"]]);
    assert.deepEqual(result.closingDetected.map((item) => item.sourceEntryNumber), ["7"]);
  });

  it("C9 · Excel sin columna de periodo: un traspaso 572 / 570 del 1 de enero (asiento 12) queda en el periodo 1, no en la apertura", () => {
    const csv = "Asiento;Fecha;Cuenta;Concepto;Debe;Haber;Ejercicio\n12;01/01/2026;5720000;Traspaso a caja;;300;2026\n12;01/01/2026;5700000;Traspaso a caja;300;;2026\n1;01/01/2026;5720000;Apertura;15000;;2026\n1;01/01/2026;1000000;Apertura;;15000;2026\n";
    const parsed = parseLedgerImportFile({ kind: "journal", content: csv, fileName: "d.csv" });
    assert.deepEqual(parsed.rows.map((r) => `${r.asiento}/${r.periodo}`), ["12/1", "12/1", "1/0", "1/0"]);
    const result = buildJournalEntries(groupJournalRows(parsed.rows), context({ rows: parsed.rows }));
    assert.deepEqual(result.entries.map((entry) => [entry.sourceId, entry.entryKind]), [["1:2026:0:1", "opening"], ["1:2026:1:12", "normal"]]);
  });

  it("SD-04 · un solo cobro propio de 100,00 excluye UN asiento de Sage (el que cita su factura), no todos los del mismo importe en ± 3 días", () => {
    const rows = [
      row({ asiento: "1601", cuenta: "4300000123", haber: "100.00", fecha: "2026-09-03", concepto: "Cobro" }),
      row({ asiento: "1601", cuenta: "5720000", debe: "100.00", fecha: "2026-09-03", concepto: "Cobro" }),
      row({ asiento: "1602", cuenta: "4300000456", haber: "100.00", fecha: "2026-09-04", concepto: "Cobro FAC-2026-000020" }),
      row({ asiento: "1602", cuenta: "5720000", debe: "100.00", fecha: "2026-09-04", concepto: "Cobro FAC-2026-000020" }),
      row({ asiento: "1603", cuenta: "4300000789", haber: "100.00", fecha: "2026-09-05", concepto: "Cobro" }),
      row({ asiento: "1603", cuenta: "5720000", debe: "100.00", fecha: "2026-09-05", concepto: "Cobro" })
    ];
    const paymentAmounts = new Map([["100.00", [{ invoiceNumber: "FAC-2026-000020", sourceType: "payment", sourceId: "pay_20", date: "2026-09-03" }]]]);
    const result = buildJournalEntries(groupJournalRows(rows), context({ rows, nativeIndex: { invoiceKeys: new Map(), paymentAmounts } }));
    assert.deepEqual(result.skippedNative.map((item) => [item.sourceEntryNumber, item.sourceId]), [["1602", "pay_20"]], "gana el asiento que cita la factura y el cobro se consume");
    assert.deepEqual(result.entries.map((entry) => entry.source!.entryNumber), ["1601", "1603"]);
    // Dos cobros propios → dos exclusiones (los dos más cercanos en fecha), el tercero se importa.
    const two = new Map([["100.00", [{ invoiceNumber: null, sourceType: "payment", sourceId: "pay_a", date: "2026-09-03" }, { invoiceNumber: null, sourceType: "payment", sourceId: "pay_b", date: "2026-09-05" }]]]);
    const both = buildJournalEntries(groupJournalRows(rows), context({ rows, nativeIndex: { invoiceKeys: new Map(), paymentAmounts: two } }));
    assert.deepEqual(both.skippedNative.map((item) => [item.sourceEntryNumber, item.sourceId]), [["1601", "pay_a"], ["1602", "pay_b"]]);
    assert.deepEqual(both.entries.map((entry) => entry.source!.entryNumber), ["1603"]);
  });
});

describe("regimeOfVatRow · régimen al importar (FIX-1 · F2)", () => {
  const vat = (over: Partial<Pick<CanonicalVatRow, "libro" | "nif" | "tipo_factura" | "clave_operacion" | "calificacion">>): Pick<CanonicalVatRow, "libro" | "nif" | "tipo_factura" | "clave_operacion" | "calificacion"> => ({ libro: "recibidas", nif: "B12345674", tipo_factura: "F1", clave_operacion: null, calificacion: null, ...over });

  it("recibidas: F5 → importacion (antes que la clave), «Inversión del Sujeto Pasivo» S → isp (antes que la clave), clave 09 → aib, clave 01 → interior, sin datos → null", () => {
    assert.equal(regimeOfVatRow(vat({ tipo_factura: "F5", clave_operacion: "09" })), "importacion");
    assert.equal(regimeOfVatRow(vat({ tipo_factura: "f5", nif: null })), "importacion");
    assert.equal(regimeOfVatRow(vat({ clave_operacion: "09", nif: "DE123456789" })), "aib");
    assert.equal(regimeOfVatRow(vat({ clave_operacion: "01" })), "interior");
    assert.equal(regimeOfVatRow(vat({})), null);
    assert.equal(regimeOfVatRow(vat({ clave_operacion: "07" })), null, "otras claves no se interpretan");
    // Corrector FIX-1 (F2-IMPORT-NO-ISP-RECIBIDAS): la columna AEAT «Inversión del Sujeto Pasivo» decide isp aunque la clave sea 01 (CH / CO de la carga real).
    assert.equal(regimeOfVatRow({ ...vat({ clave_operacion: "01", nif: "CHE123456789" }), inversion_sujeto_pasivo: "S" }), "isp");
    assert.equal(regimeOfVatRow({ ...vat({ clave_operacion: "09", nif: "DE123456789" }), inversion_sujeto_pasivo: "S" }), "isp", "la marca S manda sobre la clave 09");
    assert.equal(regimeOfVatRow({ ...vat({ clave_operacion: "01" }), inversion_sujeto_pasivo: "N" }), "interior");
    assert.equal(regimeOfVatRow({ ...vat({ tipo_factura: "F5" }), inversion_sujeto_pasivo: "S" }), "importacion", "el DUA sigue mandando");
  });

  it("emitidas: clave 09 → isp; clave 01 con calificación → interior; clave 01 sin calificación → interior solo con NIF; sin clave ni calificación → null SIEMPRE (F2-IMPORT-ISP-DEFAULT)", () => {
    // Corrector FIX-1: una emitida sin NIF de un libro SIN columnas clave / calificación (F2 simplificada) ya no sale «isp».
    assert.equal(regimeOfVatRow(vat({ libro: "emitidas", nif: null })), null, "sin clave ni calificación no se decide");
    assert.equal(regimeOfVatRow(vat({ libro: "emitidas", nif: null, tipo_factura: "F2" })), null, "venta simplificada sin NIF: sin clasificar");
    assert.equal(regimeOfVatRow(vat({ libro: "emitidas", nif: " ", clave_operacion: "" })), null, "NIF y clave en blanco cuentan como ausentes: sin clasificar");
    assert.equal(regimeOfVatRow(vat({ libro: "emitidas", nif: null, clave_operacion: "09" })), "isp", "clave 09 en emitidas: autofactura");
    assert.equal(regimeOfVatRow(vat({ libro: "emitidas", nif: null, calificacion: "S1" })), null, "una emitida calificada S1 sin NIF y sin clave es una venta a particular sin clave: sin clasificar");
    assert.equal(regimeOfVatRow(vat({ libro: "emitidas", nif: null, calificacion: "S1", clave_operacion: "01" })), "interior");
    assert.equal(regimeOfVatRow(vat({ libro: "emitidas", nif: "A23456783", clave_operacion: "01", calificacion: "S1" })), "interior");
    assert.equal(regimeOfVatRow(vat({ libro: "emitidas", nif: "A23456783", clave_operacion: "01" })), "interior", "clave 01 sin calificación pero con NIF: interior");
    assert.equal(regimeOfVatRow(vat({ libro: "emitidas", nif: null, clave_operacion: "01" })), null, "clave 01 sin calificación y sin NIF: forma de las autofacturas de Sage, la decide reclassify");
    assert.equal(regimeOfVatRow(vat({ libro: "emitidas", nif: "A23456783" })), null);
  });

  it("buildVatBookRows asigna regime desde las columnas del libro; el libro AEAT del fixture (clave 01 / S1 en las dos hojas) da interior; sin clave queda null; isForeignNif", () => {
    const fixture = parseSageVatBook(aeatVatBookXlsx()).rows;
    assert.deepEqual(fixture.map((row) => [row.clave_operacion, row.calificacion]), Array.from({ length: 5 }, () => ["01", "S1"]), "«Clave de Operación» y «Calificación de la Operación» del formato AEAT se leen");
    assert.deepEqual(buildVatBookRows(fixture, { periodicity: "quarterly", organizationId: "org_test" }).rows.map((row) => row.regime), ["interior", "interior", "interior", "interior", "interior"]);
    const unclassified = fixture.map((row) => ({ ...row, clave_operacion: null, calificacion: null }));
    assert.deepEqual(buildVatBookRows(unclassified, { periodicity: "quarterly", organizationId: "org_test" }).rows.map((row) => row.regime), [null, null, null, null, null]);
    const classified = buildVatBookRows(
      [
        { ...fixture[0]!, clave_operacion: "01", calificacion: "S1" },
        { ...fixture[1]!, nif: null, clave_operacion: null, calificacion: null },
        { ...fixture[2]!, nif: null, clave_operacion: "09", calificacion: null },
        { ...fixture[3]!, clave_operacion: "09" },
        { ...fixture[4]!, tipo_factura: "F5" },
        { ...fixture[4]!, numero: "779", clave_operacion: "01", inversion_sujeto_pasivo: "S" }
      ],
      { periodicity: "quarterly", organizationId: "org_test" }
    );
    // Corrector FIX-1: sin clave ni calificación la emitida sin NIF queda null (antes «isp»); la clave 09 sí es autofactura; la marca ISP S de recibidas → isp.
    assert.deepEqual(classified.rows.map((row) => [row.book, row.regime]), [["emitidas", "interior"], ["emitidas", null], ["emitidas", "isp"], ["recibidas", "aib"], ["recibidas", "importacion"], ["recibidas", "isp"]]);
    // El libro AEAT de recibidas con la columna «Inversión del Sujeto Pasivo» = S se lee y clasifica isp desde el fichero.
    const withIsp = parseSageVatBook(aeatVatBookXlsx({ recibidas: [{ ...VAT_RECIBIDAS_2026_Q3[0]!, isp: true }, VAT_RECIBIDAS_2026_Q3[1]!] })).rows.filter((row) => row.libro === "recibidas");
    assert.deepEqual(withIsp.map((row) => row.inversion_sujeto_pasivo), ["S", "N"]);
    assert.deepEqual(buildVatBookRows(withIsp, { periodicity: "quarterly", organizationId: "org_test" }).rows.map((row) => row.regime), ["isp", "interior"]);
    assert.deepEqual([isForeignNif("DE123456789"), isForeignNif("B12345674"), isForeignNif(null), isForeignNif("")], [true, false, false, false]);
  });
});

describe("buildVatBookRows · sourceId de recibidas con recepción / fecha (FIX-1 · F4 · B-8) y tipo con decimales (B-7)", () => {
  const vat = parseSageVatBook(aeatVatBookXlsx()).rows;
  const template = vat.find((row) => row.libro === "recibidas")!;
  const received = (over: Partial<CanonicalVatRow>): CanonicalVatRow => ({ ...template, serie: null, numero: "77", nif: "A12345674", nombre: "PROVEEDOR UNO SL", base: "100.00", tipo_iva: "21", cuota: "21.00", total: "121.00", numero_recepcion: null, ...over });

  it("el mismo proveedor repite su número en dos fechas → dos sourceId distintos, sin fusión ni aviso, y el número de Sage queda íntegro en number", () => {
    const built = buildVatBookRows([received({ fecha: "2026-09-03" }), received({ fecha: "2026-09-17" })], { periodicity: "quarterly", organizationId: "org_test", companyCode: "1" });
    assert.deepEqual(built.warnings, []);
    assert.deepEqual(built.rows.map((r) => [r.sourceId, r.number, r.date, r.base.toFixed(2)]), [["1:2026::77:A12345674:2026-09-03", "77", "2026-09-03", "100.00"], ["1:2026::77:A12345674:2026-09-17", "77", "2026-09-17", "100.00"]]);
  });

  it("misma fecha, mismo número y mismo tipo → se fusionan como hasta ahora (una fila, aviso de repetida)", () => {
    const built = buildVatBookRows([received({ fecha: "2026-09-03" }), received({ fecha: "2026-09-03" })], { periodicity: "quarterly", organizationId: "org_test", companyCode: "1" });
    assert.equal(built.rows.length, 1);
    assert.deepEqual([built.rows[0]!.sourceId, built.rows[0]!.base.toFixed(2)], ["1:2026::77:A12345674:2026-09-03", "200.00"]);
    assert.equal(built.warnings.length, 1);
    assert.match(built.warnings[0]!, /repetida con el mismo tipo 21 %/);
  });

  it("con numero_recepcion el sourceId lo usa en vez de la fecha; la R de rectificativa sigue al final; emitidas no llevan recepción ni fecha", () => {
    const built = buildVatBookRows([received({ fecha: "2026-09-03", numero_recepcion: "45" }), received({ fecha: "2026-09-03", numero_recepcion: "46", rectificativa: true })], { periodicity: "quarterly", organizationId: "org_test", companyCode: "1" });
    assert.deepEqual(built.warnings, []);
    assert.deepEqual(built.rows.map((r) => r.sourceId), ["1:2026::77:A12345674:45", "1:2026::77:A12345674:46:R"]);
    const issued = buildVatBookRows([{ ...vat[0]!, numero_recepcion: "45" }], { periodicity: "quarterly", organizationId: "org_test" });
    assert.equal(issued.rows[0]!.sourceId, "1:2026:FAC-2026:000010");
  });

  it("B-7 · tipo 7,5 % del libro → rate 7.50 (Decimal(5,2)); la clave de fusión distingue 7.5 de 21 en la misma factura", () => {
    const built = buildVatBookRows([received({ fecha: "2026-09-03", tipo_iva: "7.5", cuota: "7.50", total: "107.50" }), received({ fecha: "2026-09-03" })], { periodicity: "quarterly", organizationId: "org_test", companyCode: "1" });
    assert.deepEqual(built.warnings, []);
    assert.deepEqual(built.rows.map((r) => [r.sourceId, r.rate.toFixed(2), r.quota.toFixed(2)]), [["1:2026::77:A12345674:2026-09-03", "7.50", "7.50"], ["1:2026::77:A12345674:2026-09-03", "21.00", "21.00"]]);
  });

  it("B-7 · diario: un apunte de 472 con tipo 7,5 conserva taxRateCode «7.5» (antes se redondeaba a «8»)", () => {
    const rows = fixtureRows.map((r) => (r.asiento === "1501" && r.cuenta === "4720021" ? { ...r, tipo_iva: "7.5" } : r));
    const built = buildJournalEntries(groupJournalRows(rows), context({ rows: fixtureRows, nativeIndex }));
    const entry = built.entries.find((candidate) => candidate.sourceId === "1:2026:9:1501")!;
    assert.ok(entry);
    assert.deepEqual(entry.lines.map((line) => line.taxRateCode), [null, "7.5", null]);
  });
});
