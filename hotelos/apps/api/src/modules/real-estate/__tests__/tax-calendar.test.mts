// Unit tests · calendario de tributos locales (Tanda ACT · L0a). Sin BD. Desde apps/api:
//   node --import tsx --test src/modules/real-estate/__tests__/tax-calendar.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_VOLUNTARY_PERIOD,
  centsToMoney,
  expectedReceiptsFor,
  isMonthDay,
  moneyToCents,
  monthDayToIsoDay,
  percentToHundredths,
  splitCentsEvenly,
  voluntaryPeriodFor
} from "../tax-calendar.js";

const sumOf = (amounts: Array<string | null>): string => centsToMoney(amounts.reduce((acc, amount) => acc + (moneyToCents(amount) ?? 0), 0));

describe("voluntaryPeriodFor (tabla por INE y supletorio LGT 62.3)", () => {
  it("Madrid 28079: IBI e IAE 1 oct → 30 nov; vados 1 abr → 1 jun", () => {
    assert.deepEqual(voluntaryPeriodFor("28079", "ibi", 2026), { from: "2026-10-01", to: "2026-11-30", source: "municipal" });
    assert.deepEqual(voluntaryPeriodFor("28079", "iae", 2026), { from: "2026-10-01", to: "2026-11-30", source: "municipal" });
    assert.deepEqual(voluntaryPeriodFor("28079", "vados", 2027), { from: "2027-04-01", to: "2027-06-01", source: "municipal" });
  });

  it("supletorio 1 sep → 20 nov cuando el municipio o el tributo no están en la tabla (Teo, Oleiros, Gijón…; residuos en Madrid; sin INE)", () => {
    assert.deepEqual(DEFAULT_VOLUNTARY_PERIOD, { from: "09-01", to: "11-20" });
    assert.deepEqual(voluntaryPeriodFor("15082", "ibi", 2026), { from: "2026-09-01", to: "2026-11-20", source: "supletorio" });
    assert.deepEqual(voluntaryPeriodFor("28079", "residuos", 2026), { from: "2026-09-01", to: "2026-11-20", source: "supletorio" });
    assert.equal(voluntaryPeriodFor(null, "iae", 2026).source, "supletorio");
    assert.equal(voluntaryPeriodFor(undefined, "ibi", 2026).source, "supletorio");
  });
});

describe("helpers de dinero y MM-DD (enteros, nunca float)", () => {
  it("moneyToCents / centsToMoney", () => {
    assert.equal(moneyToCents("1234.56"), 123456);
    assert.equal(moneyToCents("1234.5"), 123450);
    assert.equal(moneyToCents("0"), 0);
    assert.equal(moneyToCents("-3.07"), -307);
    assert.equal(moneyToCents("1.234"), null, "más de 2 decimales no es MoneyString");
    assert.equal(moneyToCents("abc"), null);
    assert.equal(moneyToCents(12), null);
    assert.equal(centsToMoney(123456), "1234.56");
    assert.equal(centsToMoney(5), "0.05");
    assert.equal(centsToMoney(-307), "-3.07");
  });

  it("percentToHundredths y splitCentsEvenly", () => {
    assert.equal(percentToHundredths("11.11"), 1111);
    assert.equal(percentToHundredths("100"), 10_000);
    assert.equal(percentToHundredths(12.5), 1250);
    assert.equal(percentToHundredths("100.01"), null);
    assert.equal(percentToHundredths("1.234"), null);
    assert.deepEqual(splitCentsEvenly(10_000, 3), [3333, 3333, 3334]);
    assert.deepEqual(splitCentsEvenly(100_001, 2), [50_000, 50_001]);
    assert.deepEqual(splitCentsEvenly(500, 1), [500]);
    assert.deepEqual(splitCentsEvenly(500, 0), []);
  });

  it("MM-DD: 02-29 vale (bisiesto), 04-31 y 13-01 no; conversión a día ISO por año", () => {
    assert.equal(isMonthDay("02-29"), true);
    assert.equal(isMonthDay("04-31"), false);
    assert.equal(isMonthDay("13-01"), false);
    assert.equal(isMonthDay("9-1"), false);
    assert.equal(monthDayToIsoDay("02-29", 2024), "2024-02-29");
    assert.equal(monthDayToIsoDay("02-29", 2026), null, "2026 no es bisiesto");
    assert.equal(monthDayToIsoDay("10-01", 2026), "2026-10-01");
  });
});

describe("expectedReceiptsFor (recibos previstos del ejercicio)", () => {
  it("anual: un recibo «anual» con todo el importe y la ventana municipal (Madrid)", () => {
    const receipts = expectedReceiptsFor({ kind: "ibi", periodicity: "anual", expectedAnnualAmount: "17955.00", ineMunicipalityCode: "28079" }, 2026);
    assert.deepEqual(receipts, [{ period: "anual", dueFrom: "2026-10-01", dueTo: "2026-11-30", amount: "17955.00" }]);
  });

  it("anual con ventana propia del tributo (voluntaryFrom/To) por encima de la tabla; unico se etiqueta «unico»", () => {
    const own = expectedReceiptsFor({ kind: "ibi", periodicity: "anual", expectedAnnualAmount: "3510.00", ineMunicipalityCode: "28079", voluntaryFrom: "02-01", voluntaryTo: "03-31" }, 2026);
    assert.deepEqual(own, [{ period: "anual", dueFrom: "2026-02-01", dueTo: "2026-03-31", amount: "3510.00" }]);
    const single = expectedReceiptsFor({ kind: "plusvalia", periodicity: "unico", expectedAnnualAmount: "900.00", ineMunicipalityCode: "15058" }, 2026);
    assert.deepEqual(single, [{ period: "unico", dueFrom: "2026-09-01", dueTo: "2026-11-20", amount: "900.00" }]);
  });

  it("semestral: dos recibos por tramos naturales que suman el importe (el último absorbe el céntimo)", () => {
    const receipts = expectedReceiptsFor({ kind: "residuos", periodicity: "semestral", expectedAnnualAmount: "1000.01", ineMunicipalityCode: "33024" }, 2026);
    assert.deepEqual(
      receipts.map((r) => [r.period, r.dueFrom, r.dueTo, r.amount]),
      [
        ["1/2", "2026-01-01", "2026-06-30", "500.00"],
        ["2/2", "2026-07-01", "2026-12-31", "500.01"]
      ]
    );
    assert.equal(sumOf(receipts.map((r) => r.amount)), "1000.01");
  });

  it("trimestral y mensual: partes iguales, suma exacta, ventanas por meses", () => {
    const quarters = expectedReceiptsFor({ kind: "terrazas", periodicity: "trimestral", expectedAnnualAmount: "100.00" }, 2026);
    assert.deepEqual(quarters.map((r) => r.amount), ["25.00", "25.00", "25.00", "25.00"]);
    assert.deepEqual(quarters.map((r) => [r.dueFrom, r.dueTo]), [["2026-01-01", "2026-03-31"], ["2026-04-01", "2026-06-30"], ["2026-07-01", "2026-09-30"], ["2026-10-01", "2026-12-31"]]);
    const months = expectedReceiptsFor({ kind: "ocupacion_via_publica", periodicity: "mensual", expectedAnnualAmount: "100.00" }, 2026);
    assert.equal(months.length, 12);
    assert.deepEqual(months.slice(0, 11).map((r) => r.amount), new Array(11).fill("8.33"));
    assert.equal(months[11]!.amount, "8.37");
    assert.equal(sumOf(months.map((r) => r.amount)), "100.00");
    assert.deepEqual([months[0]!.period, months[1]!.dueFrom, months[1]!.dueTo, months[11]!.period], ["1/12", "2026-02-01", "2026-02-28", "12/12"]);
  });

  it("PAC de 9 plazos (installmentsJson): el pct de cada plazo, ventanas propias, la suma es exactamente el importe anual", () => {
    const installments = Array.from({ length: 9 }, (_, index) => ({
      label: `PAC-${String(index + 1).padStart(2, "0")}`,
      dueFrom: `${String(index + 2).padStart(2, "0")}-01`,
      dueTo: `${String(index + 2).padStart(2, "0")}-05`,
      pct: index === 8 ? "11.12" : "11.11"
    }));
    const receipts = expectedReceiptsFor({ kind: "ibi", periodicity: "anual", expectedAnnualAmount: "3510.00", installmentsJson: installments, ineMunicipalityCode: "28079" }, 2026);
    assert.equal(receipts.length, 9);
    assert.deepEqual(receipts.slice(0, 8).map((r) => r.amount), new Array(8).fill("389.96"), "3510 × 11,11 % = 389,961 → 389,96");
    assert.equal(receipts[8]!.amount, "390.32", "el último ajusta: 3510 − 8 × 389,96");
    assert.equal(sumOf(receipts.map((r) => r.amount)), "3510.00");
    assert.deepEqual([receipts[0]!.period, receipts[0]!.dueFrom, receipts[0]!.dueTo], ["PAC-01", "2026-02-01", "2026-02-05"]);
    assert.deepEqual([receipts[8]!.period, receipts[8]!.dueFrom, receipts[8]!.dueTo], ["PAC-09", "2026-10-01", "2026-10-05"]);
  });

  it("plazos sin etiqueta o con MM-DD inválido: etiqueta PAC-nn y ventana anual de respaldo", () => {
    const receipts = expectedReceiptsFor(
      { kind: "iae", periodicity: "anual", expectedAnnualAmount: "200.00", installmentsJson: [{ label: "", dueFrom: "04-31", dueTo: "05-05", pct: "50" }, { label: "  ", dueFrom: "10-01", dueTo: "10-20", pct: "50" }], ineMunicipalityCode: "28079" },
      2026
    );
    assert.deepEqual(receipts, [
      { period: "PAC-01", dueFrom: "2026-10-01", dueTo: "2026-11-30", amount: "100.00" },
      { period: "PAC-02", dueFrom: "2026-10-01", dueTo: "2026-10-20", amount: "100.00" }
    ]);
  });

  it("sin importe anual previsto: recibos con amount null; año inválido → RangeError", () => {
    const receipts = expectedReceiptsFor({ kind: "ibi", periodicity: "semestral", expectedAnnualAmount: null }, 2026);
    assert.deepEqual(receipts.map((r) => r.amount), [null, null]);
    assert.equal(expectedReceiptsFor({ kind: "ibi", periodicity: "anual" }, 2026)[0]!.amount, null);
    assert.throws(() => expectedReceiptsFor({ kind: "ibi", periodicity: "anual" }, 26), RangeError);
    assert.throws(() => voluntaryPeriodFor("28079", "ibi", Number.NaN), RangeError);
  });
});
