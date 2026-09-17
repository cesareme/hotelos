// Unit tests · Tanda 7c · L2 — reconciliación (`ledger-reconciliation.service.ts`) sin base de
// datos: criterio declarado, periodo del rango, filtro de filas, tolerancias (consolidado 0,00;
// por centro 0,01 × asientos repartidos que tocan la cuenta), clasificación amount_diff /
// native_only / missing_in_ledger sobre `buildReconciliationRows` (L1) y CSV (BOM, «;», coma
// decimal, totales). Desde apps/api:
//   node --import tsx --test src/modules/accounting/import/__tests__/ledger-reconciliation.test.mts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { LEDGER_RECONCILIATION_TOLERANCES, type LedgerAccountMapDto, type LedgerReconciliationRow } from "@hotelos/shared";
import type { CanonicalBalanceRow } from "../ledger-import.canonical.js";
import { buildReconciliationRows } from "../ledger-import.posting.js";
import { money } from "../../accounting.service.js";
import {
  MISSING_ENTRY_STATUSES,
  RECONCILIATION_CRITERION_ES,
  RECONCILIATION_CSV_HEADER,
  RECONCILIATION_EXCLUDED_KINDS,
  balanceRowsInRange,
  baseToleranceFor,
  buildReconciliationCsv,
  periodCodeForRange,
  reconciliationCsvFileName,
  splitEntriesByAccountOf,
  mergeLedgerRows
} from "../ledger-reconciliation.service.js";

function balanceRow(cuenta: string, debe: string, haber: string, periodo = "2026-09", delegacion: string | null = null): CanonicalBalanceRow {
  const net = Number(debe) - Number(haber);
  return { line: 1, empresa: "1", ejercicio: periodo.slice(0, 4), periodo, cuenta, titulo: null, delegacion, apertura_debe: "0.00", apertura_haber: "0.00", debe, haber, saldo_deudor: net > 0 ? net.toFixed(2) : "0.00", saldo_acreedor: net < 0 ? (-net).toFixed(2) : "0.00" };
}

const accountMap = new Map<string, LedgerAccountMapDto>([
  ["4000000042", { sourceAccount: "4000000042", action: "collapse", accountCode: "400", carryCounterparty: true }],
  ["5720000", { sourceAccount: "5720000", action: "map", accountCode: "572", carryCounterparty: false }],
  ["6280001", { sourceAccount: "6280001", action: "map", accountCode: "628.1", carryCounterparty: false }],
  ["9990000001", { sourceAccount: "9990000001", action: "block", accountCode: null, carryCounterparty: false }]
]);

describe("ledger-reconciliation · criterio y periodo", () => {
  it("el criterio declara la exclusión de regularization / closing / opening, el saldo sin el cierre ni la regularización del día, el saldo acumulado de Sage, el IVA por prefijo y la diferencia con Sumas y saldos", () => {
    assert.match(RECONCILIATION_CRITERION_ES, /regularization \/ closing \/ opening/);
    assert.match(RECONCILIATION_CRITERION_ES, /sin el cierre ni la regularización del día/);
    assert.match(RECONCILIATION_CRITERION_ES, /acumulado de la última fila/);
    assert.match(RECONCILIATION_CRITERION_ES, /472 \/ 477\) se comparan por prefijo/);
    // C8: el saldo a `to` de los grupos 1-5 deja fuera la regularización fechada ese día (balance «hasta el periodo 12» de Sage).
    const source = readFileSync(new URL("../ledger-reconciliation.service.ts", import.meta.url), "utf8");
    assert.match(source, /aggregateAccountBalances\(\{ organizationId, propertyId, to, closingCutoff: to, regularizationCutoff: to \}\)/);
    const engine = readFileSync(new URL("../../accounting.service.ts", import.meta.url), "utf8");
    assert.match(engine, /NOT \(je\.entry_kind = 'regularization' AND je\.entry_date >= \$\{dateOnlyUtc\(input\.regularizationCutoff\)\}::date\)/);
    assert.match(RECONCILIATION_CRITERION_ES, /Sumas y saldos/);
    assert.deepEqual([...RECONCILIATION_EXCLUDED_KINDS], ["regularization", "closing", "opening"]);
    assert.deepEqual([...MISSING_ENTRY_STATUSES], ["unmapped", "error", "skipped_native"]);
  });

  it("periodCodeForRange: mes, trimestre, año natural y rango libre", () => {
    assert.equal(periodCodeForRange("2026-09-01", "2026-09-30"), "2026-09");
    assert.equal(periodCodeForRange("2026-07-01", "2026-09-30"), "2026-Q3");
    assert.equal(periodCodeForRange("2025-01-01", "2025-12-31"), "2025");
    assert.equal(periodCodeForRange("2026-09-05", "2026-09-20"), "2026");
  });

  it("balanceRowsInRange conserva las filas del rango (fin de periodo dentro) y el ejercicio entero; sin coincidencias devuelve todas", () => {
    const rows = [balanceRow("5720000", "1.00", "0.00", "2026-08"), balanceRow("5720000", "2.00", "0.00", "2026-09"), balanceRow("5720000", "3.00", "0.00", "2026-Q3"), balanceRow("5720000", "4.00", "0.00", "2026")];
    const september = balanceRowsInRange(rows, "2026-09-01", "2026-09-30");
    assert.deepEqual(september.rows.map((row) => row.periodo), ["2026-09", "2026-Q3", "2026"]);
    assert.equal(september.filtered, true);
    const none = balanceRowsInRange([balanceRow("5720000", "1.00", "0.00", "2026-08")], "2026-09-01", "2026-09-30");
    assert.deepEqual([none.rows.length, none.filtered], [1, false]);
  });
});

describe("ledger-reconciliation · tolerancias", () => {
  it("consolidado 0,00 (LEDGER_RECONCILIATION_TOLERANCES.consolidated); por centro la base es 0,00 y L1 suma 0,01 por asiento repartido", () => {
    assert.equal(baseToleranceFor(null), LEDGER_RECONCILIATION_TOLERANCES.consolidated);
    assert.equal(baseToleranceFor(undefined), "0.00");
    assert.equal(baseToleranceFor("prop_ha"), "0.00");
    assert.equal(LEDGER_RECONCILIATION_TOLERANCES.perCentrePerSplitEntry, "0.01");
  });

  it("splitEntriesByAccountOf: solo asientos con sufijo de centro (con o sin #n), nunca los de sociedad; cuenta cada asiento una vez por cuenta", () => {
    const entries = [
      { journalEntryId: "je_1", sourceId: "1:2026:9:1503:HA", propertyCode: "HA" },
      { journalEntryId: "je_2", sourceId: "1:2026:9:1507:HA#1", propertyCode: "HA" },
      { journalEntryId: "je_3", sourceId: "1:2026:9:1501", propertyCode: "HA" },
      { journalEntryId: "je_4", sourceId: "1:2026:9:1509:SOC", propertyCode: "SOC" },
      { journalEntryId: "je_5", sourceId: null, propertyCode: "HA" }
    ];
    const lines = [
      { journalEntryId: "je_1", accountCode: "400" },
      { journalEntryId: "je_1", accountCode: "472.21" },
      { journalEntryId: "je_1", accountCode: "400" },
      { journalEntryId: "je_2", accountCode: "400" },
      { journalEntryId: "je_3", accountCode: "400" },
      { journalEntryId: "je_4", accountCode: "400" },
      { journalEntryId: "je_5", accountCode: "400" }
    ];
    const split = splitEntriesByAccountOf(entries, lines);
    assert.deepEqual([...split], [["400", 2], ["472.21", 1]]);
  });

  it("por centro: diferencia de 0,02 en 400 con 2 asientos repartidos cuadra; 0,03 no (amount_diff); consolidado 0,01 no cuadra", () => {
    const sage = [balanceRow("4000000042", "0.00", "484.00")];
    const ledgerOk = [{ accountCode: "400", debit: "0.00", credit: "484.02", balance: "-484.02", sourceTypes: ["sage200_journal"] }];
    const perCentre = buildReconciliationRows(sage, ledgerOk, { accountMap, tolerance: baseToleranceFor("prop_ha"), splitEntriesByAccount: new Map([["400", 2]]) });
    assert.deepEqual([perCentre.status, perCentre.rows[0]?.tolerance, perCentre.rows[0]?.ok, perCentre.rows[0]?.classification], ["ok", "0.02", true, null]);
    const tooFar = buildReconciliationRows(sage, [{ ...ledgerOk[0]!, credit: "484.03", balance: "-484.03" }], { accountMap, tolerance: baseToleranceFor("prop_ha"), splitEntriesByAccount: new Map([["400", 2]]) });
    assert.deepEqual([tooFar.status, tooFar.rows[0]?.classification, tooFar.summary.amountDiff], ["differences", "amount_diff", 1]);
    const consolidated = buildReconciliationRows(sage, [{ ...ledgerOk[0]!, credit: "484.01", balance: "-484.01" }], { accountMap, tolerance: baseToleranceFor(null) });
    assert.deepEqual([consolidated.rows[0]?.tolerance, consolidated.rows[0]?.classification], ["0.00", "amount_diff"]);
  });
});

describe("ledger-reconciliation · clasificación", () => {
  it("native_only (solo sourceType nativo), missing_in_ledger (sin mapear o sin contrapartida) y amount_diff, con el resumen por clase", () => {
    const sage = [balanceRow("5720000", "0.00", "582.50"), balanceRow("6280001", "330.00", "0.00"), balanceRow("9990000001", "5.00", "0.00")];
    const ledger = [
      { accountCode: "572", debit: "0.00", credit: "682.50", balance: "-682.50", sourceTypes: ["sage200_journal", "manual"] },
      { accountCode: "629.9", accountName: "Otros servicios diversos", debit: "100.00", credit: "0.00", balance: "100.00", sourceTypes: ["manual"] },
      { accountCode: "4300", debit: "1100.00", credit: "0.00", balance: "1100.00", sourceTypes: ["invoice"] }
    ];
    const result = buildReconciliationRows(sage, ledger, { accountMap, tolerance: "0.00", accountNames: new Map([["572", "Bancos"]]) });
    const byAccount = new Map(result.rows.map((row) => [row.accountCode, row]));
    assert.equal(byAccount.get("572")?.classification, "amount_diff");
    assert.equal(byAccount.get("572")?.accountName, "Bancos");
    assert.equal(byAccount.get("629.9")?.classification, "native_only");
    assert.equal(byAccount.get("4300")?.classification, "native_only");
    assert.equal(byAccount.get("9990000001")?.classification, "missing_in_ledger");
    assert.equal(byAccount.get("628.1")?.classification, "missing_in_ledger", "Sage tiene movimiento y el diario no");
    assert.deepEqual([result.status, result.accountsCompared, result.differenceCount], ["differences", 5, 5]);
    assert.deepEqual({ nativeOnly: result.summary.nativeOnly, missingInLedger: result.summary.missingInLedger, amountDiff: result.summary.amountDiff }, { nativeOnly: 2, missingInLedger: 2, amountDiff: 1 });
  });
});

describe("ledger-reconciliation · CSV", () => {
  const rows: LedgerReconciliationRow[] = [
    { accountCode: "400", sourceAccounts: ["4000000042", "4000000043"], accountName: "Proveedores", sourceDebit: "302.50", sourceCredit: "302.50", ledgerDebit: "302.50", ledgerCredit: "302.50", diffDebit: "0.00", diffCredit: "0.00", sourceBalance: "0.00", ledgerBalance: "0.00", diffBalance: "0.00", classification: null, tolerance: "0.00", ok: true },
    { accountCode: "572", sourceAccounts: ["5720000"], accountName: "Bancos; c/c", sourceDebit: "0.00", sourceCredit: "582.50", ledgerDebit: "0.00", ledgerCredit: "682.50", diffDebit: "0.00", diffCredit: "100.00", sourceBalance: "-582.50", ledgerBalance: "-682.50", diffBalance: "-100.00", classification: "amount_diff", tolerance: "0.00", ok: false, note: "movimiento manual" }
  ];

  it("BOM, cabecera fija, «;», decimales con coma, comillas cuando hace falta y fila TOTAL", () => {
    const csv = buildReconciliationCsv(rows);
    assert.ok(csv.startsWith("\uFEFF"));
    const lines = csv.replace(/^\uFEFF/, "").split("\r\n").filter((line) => line !== "");
    assert.equal(lines[0], RECONCILIATION_CSV_HEADER.join(";"));
    assert.equal(lines[1], "400;Proveedores;4000000042 4000000043;302,50;302,50;302,50;302,50;0,00;0,00;0,00;0,00;0,00;0,00;cuadra;;");
    assert.equal(lines[2], '572;"Bancos; c/c";5720000;0,00;582,50;0,00;682,50;0,00;100,00;-582,50;-682,50;-100,00;0,00;diferencia;amount_diff;movimiento manual');
    assert.equal(lines[3], "TOTAL;;;302,50;885,00;302,50;985,00;0,00;100,00;;;;;;;");
    assert.equal(lines.length, 4);
  });

  it("nombre de fichero con rango y centro", () => {
    assert.equal(reconciliationCsvFileName({ periodFrom: "2026-09-01", periodTo: "2026-09-30", propertyCode: "SOC" }), "reconciliacion-sage200-2026-09-01-2026-09-30.csv");
    assert.equal(reconciliationCsvFileName({ periodFrom: "2026-09-01", periodTo: "2026-09-30", propertyCode: "HA" }), "reconciliacion-sage200-2026-09-01-2026-09-30-ha.csv");
  });
});

describe("ledger-reconciliation · mergeLedgerRows (integración L6: cuentas sin movimiento en el rango)", () => {
  it("una cuenta 6/7 con neto acumulado del ejercicio pero sin movimiento en el mes entra con Debe / Haber 0,00 y su saldo (no «falta en ehotelOS»)", () => {
    const rows = mergeLedgerRows({
      movements: [{ accountCode: "628.1", accountName: "Electricidad", debit: money("100.00"), credit: money("0.00") }],
      balanceAt: [
        { accountCode: "572", accountName: "Bancos", debit: money("5000.00"), credit: money("1200.00") },
        { accountCode: "625", accountName: "Primas de seguros", debit: money("9288.00"), credit: money("0.00") }
      ],
      yearToDate: [
        { accountCode: "628.1", accountName: "Electricidad", debit: money("250.00"), credit: money("0.00") },
        { accountCode: "625", accountName: "Primas de seguros", debit: money("9288.00"), credit: money("0.00") },
        { accountCode: "629.5", accountName: "Cuotas", debit: money("0.00"), credit: money("0.00") }
      ],
      sourceTypes: new Map([["628.1", ["sage200_journal"]]])
    });
    assert.deepEqual(rows.map((row) => row.accountCode), ["572", "625", "628.1"], "629.5 con neto 0 no entra; 625 sí aunque no se mueva en el mes");
    const insurance = rows.find((row) => row.accountCode === "625")!;
    assert.equal(money(insurance.debit).toFixed(2), "0.00");
    assert.equal(money(insurance.credit).toFixed(2), "0.00");
    assert.equal(money(insurance.balance!).toFixed(2), "9288.00", "saldo = neto acumulado del ejercicio, no el saldo a la fecha (625 es 6/7)");
    assert.deepEqual(insurance.sourceTypes, []);
    const electricity = rows.find((row) => row.accountCode === "628.1")!;
    assert.equal(money(electricity.balance!).toFixed(2), "250.00");
    assert.deepEqual(electricity.sourceTypes, ["sage200_journal"]);
    const bank = rows.find((row) => row.accountCode === "572")!;
    assert.equal(money(bank.balance!).toFixed(2), "3800.00", "grupos 1-5: saldo a la fecha");
  });
  it("con la fila reconstruida, un balance de Sage de un mes sin movimiento de la cuenta cuadra en vez de clasificarse missing_in_ledger", () => {
    const ledger = mergeLedgerRows({ movements: [], balanceAt: [], yearToDate: [{ accountCode: "625", accountName: "Primas de seguros", debit: money("9288.00"), credit: money("0.00") }], sourceTypes: new Map() });
    const sage: CanonicalBalanceRow[] = [{ line: 2, empresa: "1", ejercicio: "2026", periodo: "2026-02", cuenta: "6250000", titulo: "Primas de seguros", delegacion: null, apertura_debe: "0.00", apertura_haber: "0.00", debe: "0.00", haber: "0.00", saldo_deudor: "9288.00", saldo_acreedor: "0.00" }];
    const accountMap = new Map([["6250000", { sourceAccount: "6250000", sourceName: null, action: "map" as const, accountCode: "625", carryCounterparty: false, suggested: false }]]);
    const result = buildReconciliationRows(sage, ledger, { accountMap });
    assert.equal(result.status, "ok");
    assert.equal(result.rows[0]!.ok, true);
  });
});
