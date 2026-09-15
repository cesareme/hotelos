import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_CURRENCY,
  EMPTY,
  LOCALE,
  TIME_ZONE,
  date,
  dateRange,
  dateTime,
  isoDate,
  money,
  number,
  percent,
  plural,
  relativeTime,
  time,
  toDate,
  toNumber
} from "../format.ts";

// ICU emits U+00A0 / U+202F before € and %; compare on plain spaces so an ICU
// upgrade that swaps one for the other does not break the suite.
const plain = (text: string) => text.replace(/[  ]/g, " ");

describe("format · module contract", () => {
  it("is es-ES in Europe/Madrid with an em dash for missing values", () => {
    assert.equal(LOCALE, "es-ES");
    assert.equal(TIME_ZONE, "Europe/Madrid");
    assert.equal(EMPTY, "—");
  });

  it("parses numbers and numeric strings, never NaN", () => {
    assert.equal(toNumber(12), 12);
    assert.equal(toNumber("12.50"), 12.5);
    assert.equal(toNumber("12,50"), 12.5);
    assert.equal(toNumber(" 7 "), 7);
    assert.equal(toNumber("abc"), null);
    assert.equal(toNumber(Number.NaN), null);
    assert.equal(toNumber(Number.POSITIVE_INFINITY), null);
    assert.equal(toNumber(null), null);
    assert.equal(toNumber(undefined), null);
  });
});

describe("format · money", () => {
  it("formats euros with two decimals, es-ES grouping (from five digits) and the symbol after", () => {
    assert.equal(plain(money(1234.56)), "1234,56 €");
    assert.equal(plain(money(12345.6)), "12.345,60 €");
    assert.equal(plain(money(0)), "0,00 €");
    assert.equal(plain(money("12.5")), "12,50 €");
    assert.equal(plain(money(1234567.891)), "1.234.567,89 €");
  });

  it("drops decimals for integer amounts only with decimals: 'auto'", () => {
    assert.equal(plain(money(132, "EUR", { decimals: "auto" })), "132 €");
    assert.equal(plain(money(132.5, "EUR", { decimals: "auto" })), "132,50 €");
    assert.equal(plain(money(99.999, "EUR", { decimals: "auto" })), "100 €");
    // es-ES groups from five digits on (ICU minimumGroupingDigits = 2): 1500 stays bare, 12500 gets the dot.
    assert.equal(plain(money(1500, "EUR", { decimals: 0 })), "1500 €");
    assert.equal(plain(money(12500, "EUR", { decimals: 0 })), "12.500 €");
  });

  it("supports other currencies, signs and compact notation", () => {
    assert.match(plain(money(12.5, "USD")), /^12,50 (US\$|\$)$/);
    assert.match(plain(money(12.5, "gbp")), /^12,50 (GBP|£)$/);
    assert.match(plain(money(-5)), /^[-−]5,00 €$/);
    assert.match(plain(money(5, "EUR", { signDisplay: "always" })), /^\+5,00 €$/);
    assert.match(plain(money(1500, "EUR", { compact: true })), /mil €$/);
  });

  it("renders the placeholder for missing or invalid amounts", () => {
    assert.equal(money(null), EMPTY);
    assert.equal(money(undefined), EMPTY);
    assert.equal(money(Number.NaN), EMPTY);
    assert.equal(money("n/a"), EMPTY);
    assert.equal(money(null, "EUR", { empty: "sin tarifa" }), "sin tarifa");
  });
});

describe("format · number and percent", () => {
  it("groups from five digits and keeps up to two decimals by default", () => {
    assert.equal(number(1234), "1234");
    assert.equal(number(12345), "12.345");
    assert.equal(number(1234.5), "1234,5");
    assert.equal(number(1234.567), "1234,57");
    assert.equal(number(1234567.891), "1.234.567,89");
    assert.equal(number(0), "0");
    assert.equal(number("42"), "42");
    assert.equal(number(12345.5, { maximumFractionDigits: 0 }), "12.346");
    assert.equal(number(2, { minimumFractionDigits: 1 }), "2,0");
    assert.equal(number(null), EMPTY);
    assert.match(number(12500, { compact: true }), /mil$/);
  });

  it("takes percent units by default and ratios on demand", () => {
    assert.equal(plain(percent(12.5)), "12,5 %");
    assert.equal(plain(percent(12.55)), "12,6 %");
    assert.equal(plain(percent(0.125, { ratio: true })), "12,5 %");
    assert.equal(plain(percent(3, { signDisplay: "always" })), "+3 %");
    assert.match(plain(percent(-2.25, { maximumFractionDigits: 2 })), /^[-−]2,25 %$/);
    assert.equal(plain(percent(0, { signDisplay: "exceptZero" })), "0 %");
    assert.equal(plain(percent(50, { minimumFractionDigits: 1 })), "50,0 %");
    assert.equal(percent(null), EMPTY);
  });
});

describe("format · dates in Europe/Madrid", () => {
  it("treats YYYY-MM-DD as a calendar day whatever the machine zone", () => {
    assert.equal(date("2026-09-15"), "15/09/2026");
    assert.equal(date("2026-01-01"), "01/01/2026");
    assert.equal(toDate("2026-09-15")?.toISOString(), "2026-09-15T12:00:00.000Z");
    assert.equal(toDate("nope"), null);
    assert.equal(toDate(""), null);
    assert.equal(toDate(null), null);
  });

  it("offers short, medium, long and weekday styles", () => {
    assert.equal(date("2026-09-15", "short"), "15/09/2026");
    assert.equal(plain(date("2026-09-15", "medium")), "15 sept 2026");
    assert.equal(date("2026-09-15", "long"), "15 de septiembre de 2026");
    assert.equal(date("2026-09-15", "weekday"), "martes, 15 de septiembre");
    assert.equal(date(null), EMPTY);
    assert.equal(date("2026-13-45"), EMPTY);
    assert.equal(date(null, "long", { empty: "sin fecha" }), "sin fecha");
  });

  it("shifts instants to hotel time (CEST in September, CET in January)", () => {
    assert.equal(date("2026-09-15T23:30:00Z"), "16/09/2026");
    assert.equal(time("2026-09-15T23:30:00Z"), "01:30");
    assert.equal(time("2026-01-15T23:30:00Z"), "00:30");
    assert.equal(time("2026-09-15T08:05:09Z", { seconds: true }), "10:05:09");
    assert.equal(time(null), EMPTY);
    assert.equal(isoDate("2026-09-15T23:30:00Z"), "2026-09-16");
    assert.equal(isoDate("2026-09-15"), "2026-09-15");
    assert.equal(isoDate(null), null);
    const stamp = plain(dateTime("2026-09-15T23:30:00Z"));
    assert.ok(stamp.startsWith("16/09/2026"), stamp);
    assert.ok(stamp.endsWith("1:30"), stamp);
    assert.equal(dateTime(null), EMPTY);
  });

  it("formats ranges without repeating shared parts", () => {
    const sameMonth = plain(dateRange("2026-03-12", "2026-03-18"));
    assert.ok(/^12\s?[–-]\s?18 mar 2026$/.test(sameMonth), sameMonth);
    const crossMonth = plain(dateRange("2026-02-28", "2026-03-03"));
    assert.ok(crossMonth.includes("28 feb") && crossMonth.includes("3 mar 2026"), crossMonth);
    assert.equal(plain(dateRange("2026-03-12", "2026-03-12")), "12 mar 2026");
    assert.equal(plain(dateRange("2026-03-12", null)), "12 mar 2026");
    assert.equal(dateRange(null, null), EMPTY);
    assert.equal(plain(dateRange("2026-03-18", "2026-03-12")), "18 mar 2026 – 12 mar 2026");
    assert.equal(dateRange("2026-03-12", "2026-03-18", { style: "short" }).includes("2026"), true);
  });

  it("describes relative time in Spanish, with a fixed reference for tests", () => {
    const now = "2026-09-15T12:00:00Z";
    assert.equal(relativeTime("2026-09-15T11:59:40Z", now), "ahora mismo");
    assert.equal(relativeTime("2026-09-15T11:57:00Z", now), "hace 3 minutos");
    assert.equal(relativeTime("2026-09-15T07:00:00Z", now), "hace 5 horas");
    assert.equal(relativeTime("2026-09-14T12:00:00Z", now), "ayer");
    assert.equal(relativeTime("2026-09-16T12:00:00Z", now), "mañana");
    assert.equal(relativeTime("2026-09-18T12:00:00Z", now), "dentro de 3 días");
    assert.equal(relativeTime("2026-08-06T12:00:00Z", now), "el mes pasado");
    assert.equal(relativeTime("2025-08-06T12:00:00Z", now), "el año pasado");
    assert.equal(date("2026-09-14T12:00:00Z", "relative", { now }), "ayer");
    assert.equal(relativeTime(null, now), EMPTY);
  });
});

describe("format · plural", () => {
  it("chooses the Spanish form and formats the count", () => {
    assert.equal(plural(1, "reserva", "reservas"), "1 reserva");
    assert.equal(plural(0, "reserva", "reservas"), "0 reservas");
    assert.equal(plural(3, "reserva", "reservas"), "3 reservas");
    assert.equal(plural(1250, "reserva", "reservas"), "1250 reservas");
    assert.equal(plural(12500, "reserva", "reservas"), "12.500 reservas");
    assert.equal(plural("2", "habitación", "habitaciones"), "2 habitaciones");
    assert.equal(plural(2, "reserva", "reservas", { withCount: false }), "reservas");
    assert.equal(plural(1, "reserva", "reservas", { withCount: false }), "reserva");
    assert.equal(plural(null, "reserva", "reservas"), EMPTY);
  });
});

describe("format · L1c extensions (currency from the record, extra date styles)", () => {
  it("takes the options object in place of the currency and defaults to euros", () => {
    assert.equal(DEFAULT_CURRENCY, "EUR");
    assert.equal(plain(money(1500, { decimals: 0 })), "1500 €");
    assert.equal(plain(money(1234.5, { decimals: "auto" })), "1234,50 €");
    assert.equal(plain(money(1200000, { compact: true })), plain(money(1200000, "EUR", { compact: true })));
    assert.equal(money(null, { empty: "sin tarifa" }), "sin tarifa");
  });

  it("accepts a null or blank currency from the record and falls back to euros", () => {
    assert.equal(plain(money(12.5, null)), "12,50 €");
    assert.equal(plain(money(12.5, undefined)), "12,50 €");
    assert.equal(plain(money(12.5, "")), "12,50 €");
    assert.equal(plain(money(12.5, " usd ")), "12,50 US$");
    assert.equal(plain(money(12.5, null, { decimals: 0 })), "13 €");
  });

  it("never throws on a malformed currency code typed by a user", () => {
    assert.equal(plain(money(12.5, "euros")), "12,50 euros");
    assert.equal(plain(money(1234.5, "€")), "1234,50 €");
  });

  it("offers the day-month, month-year and weekday styles used by timelines and calendars", () => {
    assert.equal(date("2026-09-15", "dayMonth"), "15 sept");
    assert.equal(date("2026-09-15", "monthYear"), "sept 2026");
    assert.equal(date("2026-09-15", "weekdayOnly"), "mar");
    assert.equal(date("2026-09-15", "weekdayShort"), "mar, 15 sept");
    assert.equal(date(null, "dayMonth"), EMPTY);
  });

  it("lets dateTime pick the date part", () => {
    assert.equal(dateTime("2026-09-15T12:05:09Z"), "15/09/2026, 14:05");
    assert.equal(dateTime("2026-09-15T12:05:09Z", { style: "medium" }), "15 sept 2026, 14:05");
    assert.equal(dateTime("2026-09-15T12:05:09Z", { style: "dayMonth" }), "15 sept, 14:05");
    assert.equal(dateTime("nope", { style: "medium", empty: "—" }), "—");
  });
});
