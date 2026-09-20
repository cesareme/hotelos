import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  KPI_KEYS,
  KPI_LABEL_MAX_CHARS,
  QUARTER_OPTIONS,
  SIMULATED_ENDPOINT_LABEL,
  isSimulatedSubmission,
  simulatorAwareStatusLabel,
  SUBMISSION_PENDING_STATUSES,
  SUBMISSION_RETRYABLE_STATUSES,
  SUBMISSION_STATUS_LABELS,
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
  initialPeriodPicker,
  isFiscalYearClosed,
  isZeroBox,
  kpiLabel,
  matchesVatBookSearch,
  modelPeriodKind,
  formatOpeningPeriod,
  openingCompensationDraft,
  parseOpeningPeriod,
  parseOpeningAmount,
  periodCodeOf,
  periodHasEnded,
  quarterMonthOptions,
  regimeRowLabel,
  resultadoCaption,
  settlementEntryLabel,
  submissionStatusLabel,
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

describe("fiscal-shared · acuses del simulador (corrector L8 · REV-02)", () => {
  const LABELS = { sent: "Enviado", accepted: "Aceptado", accepted_with_warnings: "Aceptado con avisos", rejected: "Rechazado", queued: "En cola" };

  it("isSimulatedSubmission: solo el endpoint stub:// es del simulador", () => {
    assert.equal(isSimulatedSubmission({ endpoint: "stub://ses-hospedajes-mock" }), true);
    assert.equal(isSimulatedSubmission({ endpoint: "https://hospedajes-pre.mir.es/hospedajes/api/v1/comunicaciones" }), false);
    assert.equal(isSimulatedSubmission({ endpoint: null }), false);
    assert.equal(isSimulatedSubmission({}), false);
  });

  it("simulatorAwareStatusLabel: «Enviado» / «Aceptado» llevan «(simulador)» bajo el stub; los fallos y los reales no cambian", () => {
    assert.equal(simulatorAwareStatusLabel({ status: "accepted", endpoint: "stub://ses-hospedajes-mock" }, LABELS), "Aceptado (simulador)");
    assert.equal(simulatorAwareStatusLabel({ status: "sent", endpoint: "stub://ses-hospedajes-mock" }, LABELS), "Enviado (simulador)");
    assert.equal(simulatorAwareStatusLabel({ status: "accepted_with_warnings", endpoint: "stub://x" }, LABELS), "Aceptado con avisos (simulador)");
    assert.equal(simulatorAwareStatusLabel({ status: "rejected", endpoint: "stub://ses-hospedajes-mock" }, LABELS), "Rechazado");
    assert.equal(simulatorAwareStatusLabel({ status: "accepted", endpoint: "https://sede.mir.es/hospedajes/api/v1/comunicaciones" }, LABELS), "Aceptado");
    assert.equal(simulatorAwareStatusLabel({ status: "unknown_state", endpoint: "stub://x" }, LABELS), "unknown_state", "sin etiqueta: el estado tal cual");
  });

  it("el simulador no tiene punto de acceso real", () => {
    assert.match(SIMULATED_ENDPOINT_LABEL, /^Simulador local/);
    assert.doesNotMatch(SIMULATED_ENDPOINT_LABEL, /stub|:\/\//);
  });
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

describe("fiscal-shared · estados de envío", () => {
  // Union of the statuses the four submitters of the API write (verifactu, tbai, igic, ses).
  const WIRE_STATUSES = [
    "pending",
    "queued",
    "submitting",
    "sent",
    "retrying",
    "network_error",
    "accepted",
    "accepted_with_errors",
    "accepted_with_warnings",
    "delivered",
    "acknowledged",
    "rejected",
    "failed",
    "abandoned",
    "annulled"
  ];

  it("paints every wire status in Spanish (qa#2: «accepted» reached the badge untranslated)", () => {
    for (const status of WIRE_STATUSES) {
      const label = submissionStatusLabel(status);
      assert.notEqual(label, status, `«${status}» llega crudo a la tabla`);
      assert.match(label, /^[A-ZÁÉÍÓÚ][^_]*$/, `«${label}» (${status}) no es una etiqueta en español`);
    }
    assert.equal(submissionStatusLabel("accepted"), "Aceptado");
    assert.equal(submissionStatusLabel("accepted_with_errors"), "Aceptado con errores");
    assert.equal(submissionStatusLabel("failed"), "Fallido (máx. intentos)");
    assert.deepEqual(Object.keys(SUBMISSION_STATUS_LABELS).sort(), [...WIRE_STATUSES].sort());
  });

  it("falls back to the raw value for a status the API adds later", () => {
    assert.equal(submissionStatusLabel("estado_nuevo"), "estado_nuevo");
  });

  it("sent es pendiente, accepted/rejected no (Cocoa 22 · ola 11: el API trata sent como abierto)", () => {
    for (const open of ["queued", "sent", "submitting", "retrying", "network_error", "pending"]) {
      assert.ok(SUBMISSION_PENDING_STATUSES.has(open), `«${open}» debería seguir sondeándose`);
    }
    for (const closed of ["accepted", "accepted_with_errors", "accepted_with_warnings", "rejected", "failed", "abandoned", "annulled", "delivered", "acknowledged"]) {
      assert.ok(!SUBMISSION_PENDING_STATUSES.has(closed), `«${closed}» no es pendiente`);
    }
    for (const status of SUBMISSION_PENDING_STATUSES) assert.ok(status in SUBMISSION_STATUS_LABELS, `«${status}» sin etiqueta`);
  });

  it("retryable: rejected / failed / abandoned / retrying / network_error, never an accepted or open row", () => {
    assert.deepEqual([...SUBMISSION_RETRYABLE_STATUSES].sort(), ["abandoned", "failed", "network_error", "rejected", "retrying"]);
    for (const status of ["accepted", "accepted_with_errors", "queued", "sent", "submitting", "annulled"]) {
      assert.ok(!SUBMISSION_RETRYABLE_STATUSES.has(status), `«${status}» no admite reintento manual`);
    }
    for (const status of SUBMISSION_RETRYABLE_STATUSES) assert.ok(status in SUBMISSION_STATUS_LABELS, `«${status}» sin etiqueta`);
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


describe("initialPeriodPicker (FIX-1 · F3, E-04)", () => {
  const now = "2026-09-19";

  it("opens on the last period with materialised books: a quarter sets its last month, a month its quarter", () => {
    assert.deepEqual(initialPeriodPicker("2026-Q2", now), { year: "2026", quarter: "2", month: "06" });
    assert.deepEqual(initialPeriodPicker("2025-q4", now), { year: "2025", quarter: "4", month: "12" });
    assert.deepEqual(initialPeriodPicker("2026-05", now), { year: "2026", quarter: "2", month: "05" });
    assert.deepEqual(initialPeriodPicker("2026-01", now), { year: "2026", quarter: "1", month: "01" });
  });

  it("falls back to the current quarter and month without books or with an unreadable code", () => {
    assert.deepEqual(initialPeriodPicker(null, now), { year: "2026", quarter: "3", month: "09" });
    assert.deepEqual(initialPeriodPicker("2026", now), { year: "2026", quarter: "3", month: "09" }, "a year is not a settlement period");
    assert.deepEqual(initialPeriodPicker("garbage", "2027-02-10"), { year: "2027", quarter: "1", month: "02" });
  });

  it("quarterMonthOptions offers the whole quarter first and its three months", () => {
    assert.deepEqual(quarterMonthOptions("1").map((option) => option.value), ["", "01", "02", "03"]);
    assert.deepEqual(quarterMonthOptions("4").map((option) => [option.value, option.label]), [["", "— trimestre completo —"], ["10", "Octubre"], ["11", "Noviembre"], ["12", "Diciembre"]]);
    assert.deepEqual(quarterMonthOptions("x").map((option) => option.value), ["", "01", "02", "03"], "an unreadable quarter → the first one");
  });

  it("regimeRowLabel translates the F2 regime of a book row and paints «—» for an unclassified row", () => {
    assert.equal(regimeRowLabel("interior"), "Interior");
    assert.equal(regimeRowLabel("isp"), "ISP");
    assert.equal(regimeRowLabel("aib"), "AIB");
    assert.equal(regimeRowLabel("importacion"), "Importación");
    assert.equal(regimeRowLabel("exento_no_sujeto"), "Exenta / no sujeta");
    assert.equal(regimeRowLabel(null), "—");
    assert.equal(regimeRowLabel(undefined), "—");
  });
});


describe("openingCompensationDraft (FIX-1 · F3, B-2)", () => {
  it("reads Spanish and plain amounts, empty = 0, anything else NaN", () => {
    assert.equal(parseOpeningAmount("42.024,03"), 42024.03);
    assert.equal(parseOpeningAmount("42024,03"), 42024.03);
    assert.equal(parseOpeningAmount("1184.07"), 1184.07);
    assert.equal(parseOpeningAmount(" 100 "), 100);
    assert.equal(parseOpeningAmount(""), 0);
    assert.ok(Number.isNaN(parseOpeningAmount("-5")));
    assert.ok(Number.isNaN(parseOpeningAmount("abc")));
    assert.ok(Number.isNaN(parseOpeningAmount("1.2.3")));
  });

  it("validates the pair: an amount needs a settlement period, the period is typed as «1T 2025» / «2025-01» (its code is accepted too), both empty is fine", () => {
    assert.deepEqual(openingCompensationDraft("42.024,03", " 1t 2025 "), { amount: 42024.03, period: "2025-Q1", amountError: undefined, periodError: undefined });
    assert.deepEqual(openingCompensationDraft("42.024,03", " 2025-q1 "), { amount: 42024.03, period: "2025-Q1", amountError: undefined, periodError: undefined });
    assert.deepEqual(openingCompensationDraft("", ""), { amount: 0, period: null, amountError: undefined, periodError: undefined });
    assert.equal(openingCompensationDraft("10", "").periodError, "Indica el periodo desde el que aplica el saldo (p. ej. 1T 2025).");
    assert.equal(openingCompensationDraft("10", "2025").periodError, "Formato 1T 2025 (trimestre) o 2025-01 (mes).");
    assert.equal(openingCompensationDraft("10", "2025-13").periodError, "Formato 1T 2025 (trimestre) o 2025-01 (mes).");
    assert.deepEqual([openingCompensationDraft("10", "5T 2025").period, openingCompensationDraft("10", "5T 2025").periodError], ["5T 2025", "Formato 1T 2025 (trimestre) o 2025-01 (mes)."], "an unreadable period is kept as typed so the form stays dirty and invalid");
    assert.equal(openingCompensationDraft("0", "2025-02").periodError, undefined, "a period without amount is allowed (clears nothing)");
    assert.equal(openingCompensationDraft("abc", "2025-Q1").amountError, "Indica un importe mayor o igual que 0 (p. ej. 42024,03).");
  });

  it("parseOpeningPeriod / formatOpeningPeriod: the field speaks the notation of the fiscal screens («1T 2025»), the API its settlement code", () => {
    assert.equal(parseOpeningPeriod("1T 2025"), "2025-Q1");
    assert.equal(parseOpeningPeriod(" 1t2025 "), "2025-Q1");
    assert.equal(parseOpeningPeriod("4T-2025"), "2025-Q4");
    assert.equal(parseOpeningPeriod("2025-3T"), "2025-Q3");
    assert.equal(parseOpeningPeriod("2025 2T"), "2025-Q2");
    assert.equal(parseOpeningPeriod("2025-Q2"), "2025-Q2");
    assert.equal(parseOpeningPeriod("2025-01"), "2025-01");
    assert.equal(parseOpeningPeriod("01/2025"), "2025-01");
    for (const bad of ["", "5T 2025", "2025", "2025-13", "13/2025", "T1 2025", "1T 25"]) assert.equal(parseOpeningPeriod(bad), null, `«${bad}»`);
    assert.equal(formatOpeningPeriod("2025-Q1"), "1T 2025");
    assert.equal(formatOpeningPeriod("2025-01"), "2025-01");
    assert.equal(formatOpeningPeriod(null), "");
    assert.equal(formatOpeningPeriod(undefined), "");
    for (const code of ["2025-Q1", "2025-Q4", "2025-12"]) assert.equal(parseOpeningPeriod(formatOpeningPeriod(code)), code, "format ∘ parse is the identity on codes");
  });
});
