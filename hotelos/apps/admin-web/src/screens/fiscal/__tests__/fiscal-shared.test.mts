import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  KPI_KEYS,
  KPI_LABEL_MAX_CHARS,
  QUARTER_OPTIONS,
  TOTALES_LABELS,
  bookPeriodOptions,
  currentMonth,
  currentQuarter,
  describePeriod,
  fiscalErrorText,
  formatBoxValue,
  formatDetalleCell,
  formatTotal,
  groupBoxesBySection,
  isFiscalYearClosed,
  isZeroBox,
  kpiLabel,
  matchesVatBookSearch,
  modelPeriodKind,
  periodCodeOf,
  periodHasEnded,
  resultadoCaption,
  settlementEntryLabel,
  sumVatBookRows,
  vatBookCsv,
  yearOptions
} from "../fiscal-shared.ts";

// api-client.ts cannot load under node --test (import.meta.env); the helpers duck-type `{ message, status, details }` like ApiError.
class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly correlationId?: string, readonly details?: unknown) {
    super(message);
  }
}

/** Intl separates figures from «%» and «€» with a no-break space; the assertions compare on a plain one. */
const plain = (text: string) => text.replace(/[\u00a0\u202f]/g, " ");

const row = (over: Record<string, unknown> = {}) => ({
  id: null,
  book: "emitidas",
  date: "2026-07-12",
  series: "FAC-2026",
  number: "FAC-2026-000001",
  counterpartyNif: null,
  counterpartyName: "Ana García",
  base: 10.33,
  rate: 21,
  quota: 2.17,
  total: 12.5,
  retention: 0,
  taxFigure: "IVA",
  surchargeRate: null,
  surchargeQuota: null,
  sourceType: "invoice",
  sourceId: "inv_1",
  period: "2026-Q3",
  deductible: true,
  propertyId: "prop_1",
  ...over
});

describe("fiscal-shared · periodos", () => {
  it("classifies the models: 303 follows the VAT settings, 111/115 quarterly, 390/347/180 annual", () => {
    assert.equal(modelPeriodKind("303"), "settlement");
    assert.equal(modelPeriodKind("111"), "quarterly");
    assert.equal(modelPeriodKind("115"), "quarterly");
    for (const annual of ["390", "347", "180"] as const) assert.equal(modelPeriodKind(annual), "annual");
  });

  it("builds settlement codes and reads the current quarter and month", () => {
    assert.equal(periodCodeOf({ kind: "quarterly", year: "2026", quarter: "3" }), "2026-Q3");
    assert.equal(periodCodeOf({ kind: "monthly", year: "2026", month: "9" }), "2026-09");
    assert.equal(periodCodeOf({ kind: "annual", year: "2026" }), "2026");
    assert.equal(currentQuarter("2026-09-16"), "3");
    assert.equal(currentMonth("2026-09-16"), "09");
    assert.deepEqual(yearOptions("2026-09-16").map((o) => o.value), ["2026", "2025", "2024", "2023"]);
  });

  it("offers the whole year and the quarters (plus the months only for monthly organisations)", () => {
    const quarterly = bookPeriodOptions("2026", "quarterly");
    assert.equal(quarterly[0].value, "2026");
    assert.deepEqual(quarterly.slice(1).map((o) => o.value), ["2026-Q1", "2026-Q2", "2026-Q3", "2026-Q4"]);
    assert.equal(bookPeriodOptions("2026", "monthly").length, 1 + QUARTER_OPTIONS.length + 12);
  });

  it("describes a period in Spanish and knows when it has ended", () => {
    const q3 = { type: "quarterly" as const, year: 2026, quarter: 3 as const, month: null, from: "2026-07-01", to: "2026-09-30", aeatPeriod: "3T" };
    assert.match(describePeriod(q3), /^3T 2026 · /);
    assert.match(describePeriod({ ...q3, type: "annual", aeatPeriod: "0A", quarter: null, from: "2026-01-01", to: "2026-12-31" }), /^Ejercicio 2026/);
    assert.match(describePeriod({ ...q3, type: "monthly", month: 9, aeatPeriod: "09", from: "2026-09-01", to: "2026-09-30" }), /^Septiembre de 2026/);
    assert.equal(periodHasEnded(q3, "2026-09-16"), false);
    assert.equal(periodHasEnded(q3, "2026-10-01"), true);
  });
});

describe("fiscal-shared · casillas y totales", () => {
  it("formats boxes by kind: rates as percent, counters as integers, the rest as money", () => {
    assert.equal(plain(formatBoxValue({ tipo: "tipo", importe: 21 })), "21 %");
    assert.equal(formatBoxValue({ tipo: "contador", importe: 3 }), "3");
    assert.equal(plain(formatBoxValue({ tipo: "cuota", importe: 74.94 })), "74,94 €");
    assert.equal(formatTotal("perceptores", 2), "2");
    assert.equal(plain(formatTotal("resultado", 74.94)), "74,94 €");
  });

  it("hides only zero amounts that are neither a rate nor a result", () => {
    assert.equal(isZeroBox({ tipo: "base", importe: 0 }), true);
    assert.equal(isZeroBox({ tipo: "tipo", importe: 4 }), false);
    assert.equal(isZeroBox({ tipo: "resultado", importe: 0 }), false);
    assert.equal(isZeroBox({ tipo: "cuota", importe: 1 }), false);
  });

  it("groups boxes by section in API order", () => {
    const groups = groupBoxesBySection([{ seccion: "A" }, { seccion: "A" }, { seccion: "B" }, { seccion: "A" }]);
    assert.deepEqual(groups.map((g) => [g.seccion, g.boxes.length]), [["A", 2], ["B", 1], ["A", 1]]);
  });

  it("formats detalle cells and the 303 result caption", () => {
    assert.equal(formatDetalleCell("filas", 3), "3");
    assert.equal(plain(formatDetalleCell("importeAnual", 3005.06)), "3005,06 €");
    assert.equal(formatDetalleCell("liquidado", "no"), "No");
    assert.equal(formatDetalleCell("nif", null), "—");
    assert.equal(resultadoCaption({ resultado: 74.94, aIngresar: 74.94, aCompensar: 0 }), "a ingresar");
    assert.equal(resultadoCaption({ resultado: -10, aIngresar: 0, aCompensar: 10 }), "a compensar");
    assert.equal(resultadoCaption({ resultado: 0, aIngresar: 0, aCompensar: 0 }), "sin resultado");
  });

  it("labels a settlement entry", () => {
    assert.equal(settlementEntryLabel({ entryNumber: 12, journalEntryId: "je_1", entryDate: "2026-09-30", fiscalYearCode: "2026" }), "Asiento n.º 12 · 30/09/2026 · ejercicio 2026");
    assert.equal(settlementEntryLabel({ entryNumber: null, journalEntryId: "je_1", entryDate: "2026-09-30" }), "Asiento je_1 · 30/09/2026");
  });

  it("keeps every KPI headline within the six-tile strip and the table wording intact (qa#7)", () => {
    assert.equal(kpiLabel("resultadoLiquidaciones"), "Resultado liquidaciones");
    assert.equal(TOTALES_LABELS.resultadoLiquidaciones, "Resultado de las liquidaciones");
    assert.equal(kpiLabel("cuotaDevengada"), TOTALES_LABELS.cuotaDevengada);
    assert.equal(kpiLabel("desconocida"), "desconocida");
    for (const [modelo, keys] of Object.entries(KPI_KEYS)) {
      for (const key of keys) {
        const label = kpiLabel(key);
        assert.ok(label.length <= KPI_LABEL_MAX_CHARS, `Modelo ${modelo} · «${label}» (${label.length}) supera ${KPI_LABEL_MAX_CHARS} caracteres`);
      }
    }
  });
});

describe("fiscal-shared · errores", () => {
  it("maps the settlement codes to Spanish, explains a 403 and falls back to the API message", () => {
    assert.match(fiscalErrorText(new ApiError("x", 409, undefined, { code: "PERIOD_NOT_ENDED" })), /no ha terminado/);
    assert.match(fiscalErrorText(new ApiError("x", 409, undefined, { code: "ALREADY_SETTLED" })), /ya está liquidado/);
    assert.match(fiscalErrorText(new ApiError("x", 409, undefined, { code: "NOTHING_TO_SETTLE" })), /nada que liquidar/);
    assert.match(fiscalErrorText(new ApiError("x", 400, undefined, { code: "PERIOD_MISMATCH" })), /periodicidad/);
    assert.match(fiscalErrorText(new ApiError("x", 409, undefined, { code: "FISCAL_YEAR_CLOSED" })), /ejercicio/);
    assert.match(fiscalErrorText(new ApiError("Forbidden", 403)), /permiso/);
    assert.equal(fiscalErrorText(new ApiError("El periodo 2026-Q2 no tiene asiento de liquidación vigente.", 404)), "El periodo 2026-Q2 no tiene asiento de liquidación vigente.");
    assert.equal(fiscalErrorText(new Error(""), "Nada"), "Nada");
    assert.equal(isFiscalYearClosed(new ApiError("x", 409, undefined, { code: "FISCAL_YEAR_CLOSED" })), true);
    assert.equal(isFiscalYearClosed(new ApiError("x", 409, undefined, { code: "PERIOD_CLOSED" })), false);
  });
});

describe("fiscal-shared · libros", () => {
  it("sums the rows on screen to cents and matches the search without accents", () => {
    const rows = [row(), row({ base: 8.26, quota: 1.74, total: 10, sourceId: "inv_2" }), row({ base: -10.33, quota: -2.17, total: -12.5, sourceId: "inv_1:anulacion" })];
    assert.deepEqual(sumVatBookRows(rows), { filas: 3, base: 8.26, cuota: 1.74, total: 10, retencion: 0 });
    assert.equal(matchesVatBookSearch(row(), "ana garcia"), true);
    assert.equal(matchesVatBookSearch(row(), "000001"), true);
    assert.equal(matchesVatBookSearch(row(), "B99"), false);
    assert.equal(matchesVatBookSearch(row(), "   "), true);
  });

  it("writes a ;-separated CSV with BOM, decimal comma and quoted names", () => {
    const csv = vatBookCsv([row({ counterpartyName: 'Bar "El Puerto"; SL' })]);
    assert.ok(csv.startsWith("﻿Libro;Fecha;Serie;Número;NIF;Nombre;Base;Tipo (%)"));
    const line = csv.split("\r\n")[1];
    assert.match(line, /^Facturas emitidas;2026-07-12;FAC-2026;FAC-2026-000001;;"Bar ""El Puerto""; SL";10,33;21,00;2,17;12,50;0,00;;;IVA;Sí;Factura;inv_1;2026-Q3;prop_1$/);
  });
});
