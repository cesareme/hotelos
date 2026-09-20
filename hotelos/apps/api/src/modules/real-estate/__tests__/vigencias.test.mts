// Unit tests · vigencias derivadas (Tanda ACT · L0a). Sin BD ni reloj. Desde apps/api:
//   node --import tsx --test src/modules/real-estate/__tests__/vigencias.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { addDays, addMonths, daysBetween, deriveDocumentStatus, formatDay, formatMoneyEs, inspectionDueState, isIsoDay, isReceiptOverdue, isReceiptPaid, lastDayOfMonth } from "../vigencias.js";

const TODAY = "2026-09-20";

describe("aritmética de días ISO (UTC)", () => {
  it("isIsoDay, daysBetween, addDays, addMonths, lastDayOfMonth", () => {
    assert.equal(isIsoDay("2026-09-20"), true);
    assert.equal(isIsoDay("2026-02-30"), false);
    assert.equal(isIsoDay("20/09/2026"), false);
    assert.equal(isIsoDay(null), false);
    assert.equal(daysBetween(TODAY, "2026-09-27"), 7);
    assert.equal(daysBetween(TODAY, "2026-09-19"), -1);
    assert.equal(daysBetween("2026-03-28", "2026-03-30"), 2, "cambio de hora sin efecto: todo en UTC");
    assert.equal(addDays(TODAY, 90), "2026-12-19");
    assert.equal(addDays("2026-01-01", -1), "2025-12-31");
    assert.equal(addMonths("2026-01-31", 1), "2026-02-28");
    assert.equal(addMonths("2024-01-31", 1), "2024-02-29");
    assert.equal(addMonths("2026-03-31", -3), "2025-12-31");
    assert.equal(addMonths("2027-03-31", -6), "2026-09-30");
    assert.equal(addMonths("2026-11-15", 14), "2028-01-15");
    assert.equal(lastDayOfMonth(2026, 2), 28);
    assert.equal(lastDayOfMonth(2024, 2), 29);
    assert.throws(() => daysBetween("2026-02-30", TODAY), RangeError);
  });
});

describe("deriveDocumentStatus (vigente · caduca_pronto · caducado · sin_fecha · sustituido)", () => {
  it("vigente: vence más allá de la ventana de aviso (30 días por defecto)", () => {
    assert.equal(deriveDocumentStatus({ validUntil: "2026-11-19" }, TODAY), "vigente"); // +60
    assert.equal(deriveDocumentStatus({ validUntil: "2026-10-21", supersededById: null }, TODAY), "vigente"); // +31
  });

  it("caduca_pronto: vence hoy o dentro de la ventana; la ventana es configurable (perfil de cumplimiento)", () => {
    assert.equal(deriveDocumentStatus({ validUntil: "2026-10-20" }, TODAY), "caduca_pronto"); // +30
    assert.equal(deriveDocumentStatus({ validUntil: TODAY }, TODAY), "caduca_pronto"); // hoy
    assert.equal(deriveDocumentStatus({ validUntil: "2026-11-19" }, TODAY, 90), "caduca_pronto"); // +60 con 90 días (inspecciones y seguros)
    assert.equal(deriveDocumentStatus({ validUntil: "2026-09-21" }, TODAY, 0), "vigente", "ventana 0: solo hoy avisa");
    assert.equal(deriveDocumentStatus({ validUntil: TODAY }, TODAY, 0), "caduca_pronto");
  });

  it("caducado: validUntil anterior a hoy", () => {
    assert.equal(deriveDocumentStatus({ validUntil: "2026-09-19" }, TODAY), "caducado");
    assert.equal(deriveDocumentStatus({ validUntil: "2020-01-01" }, TODAY, 90), "caducado");
  });

  it("sin_fecha: sin validUntil (escrituras, planos, notas simples)", () => {
    assert.equal(deriveDocumentStatus({ validUntil: null }, TODAY), "sin_fecha");
    assert.equal(deriveDocumentStatus({ validUntil: undefined }, TODAY), "sin_fecha");
  });

  it("sustituido: manda sobre cualquier fecha (versión posterior registrada)", () => {
    assert.equal(deriveDocumentStatus({ validUntil: "2030-01-01", supersededById: "doc_2" }, TODAY), "sustituido");
    assert.equal(deriveDocumentStatus({ validUntil: "2020-01-01", supersededById: "doc_2" }, TODAY), "sustituido");
    assert.equal(deriveDocumentStatus({ validUntil: null, supersededById: "doc_2" }, TODAY), "sustituido");
  });
});

describe("isReceiptOverdue (el «vencido» derivado del recibo)", () => {
  it("sin pagar y con dueTo anterior a hoy → vencido; hoy mismo no; pagado nunca; sin dueTo nunca", () => {
    assert.equal(isReceiptOverdue({ status: "previsto", dueTo: "2026-09-19" }, TODAY), true);
    assert.equal(isReceiptOverdue({ status: "recibido", dueTo: "2026-08-01" }, TODAY), true);
    assert.equal(isReceiptOverdue({ status: "domiciliado", dueTo: "2026-09-19" }, TODAY), true);
    assert.equal(isReceiptOverdue({ status: "recurrido", dueTo: "2026-09-19" }, TODAY), true, "el recurso no suspende el plazo por sí solo");
    assert.equal(isReceiptOverdue({ status: "previsto", dueTo: TODAY }, TODAY), false);
    assert.equal(isReceiptOverdue({ status: "previsto", dueTo: "2026-11-30" }, TODAY), false);
    assert.equal(isReceiptOverdue({ status: "pagado", dueTo: "2026-01-01" }, TODAY), false);
    assert.equal(isReceiptOverdue({ status: "previsto", dueTo: null }, TODAY), false);
    assert.equal(isReceiptOverdue({ status: "previsto", dueTo: undefined }, TODAY), false);
    // ACT-REV-10: un recibo recurrido DESPUÉS de pagarlo conserva paidAt y no está vencido.
    assert.equal(isReceiptOverdue({ status: "recurrido", dueTo: "2026-01-01", paidAt: "2026-06-15" }, TODAY), false);
    assert.equal(isReceiptPaid({ status: "pagado" }), true);
    assert.equal(isReceiptPaid({ status: "recurrido", paidAt: "2026-06-15" }), true);
    assert.equal(isReceiptPaid({ status: "recurrido", paidAt: null }), false);
    assert.equal(isReceiptPaid({ status: "recibido" }), false);
  });
});

describe("inspectionDueState (sin_fecha · en_plazo · proxima · vencida)", () => {
  it("sin nextDueAt → sin_fecha; pasada → vencida con días negativos", () => {
    assert.deepEqual(inspectionDueState({ nextDueAt: null }, TODAY), { state: "sin_fecha", daysLeft: null });
    assert.deepEqual(inspectionDueState({ nextDueAt: "2026-09-19" }, TODAY), { state: "vencida", daysLeft: -1 });
  });

  it("dentro de la ventana (90 días por defecto) → proxima; más allá → en_plazo; warnDays configurable", () => {
    assert.deepEqual(inspectionDueState({ nextDueAt: "2026-10-20" }, TODAY), { state: "proxima", daysLeft: 30 });
    assert.deepEqual(inspectionDueState({ nextDueAt: "2026-12-19" }, TODAY), { state: "proxima", daysLeft: 90 });
    assert.deepEqual(inspectionDueState({ nextDueAt: "2026-12-20" }, TODAY), { state: "en_plazo", daysLeft: 91 });
    assert.deepEqual(inspectionDueState({ nextDueAt: TODAY }, TODAY), { state: "proxima", daysLeft: 0 });
    assert.deepEqual(inspectionDueState({ nextDueAt: "2026-10-20" }, TODAY, { warnDays: 7 }), { state: "en_plazo", daysLeft: 30 });
    assert.deepEqual(inspectionDueState({ nextDueAt: "2026-09-27" }, TODAY, { warnDays: 7 }), { state: "proxima", daysLeft: 7 });
  });
});

describe("formato de etiquetas (ACT-REV-15: DD/MM/AAAA e importes en español; los DTO siguen en ISO / MoneyString)", () => {
  it("formatDay y formatMoneyEs", () => {
    assert.equal(formatDay("2026-06-15"), "15/06/2026");
    assert.equal(formatMoneyEs("18000.00"), "18.000,00 €");
    assert.equal(formatMoneyEs("1500.5"), "1.500,50 €");
    assert.equal(formatMoneyEs("999"), "999,00 €");
    assert.equal(formatMoneyEs("1234567.89"), "1.234.567,89 €");
    assert.equal(formatMoneyEs("-2500.00"), "-2.500,00 €");
    assert.equal(formatMoneyEs(0), "0,00 €");
  });
});
