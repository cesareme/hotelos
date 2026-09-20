// Unit tests · Tanda T9 · lote T9-03 — retención (§3.2) y plazos (§3.5).
// Sin base de datos, sin red. Desde apps/api:
//   node --import tsx --test src/modules/documents/__tests__/retention-rules.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_RETENTION_SETTINGS,
  SPAIN_NATIONAL_FIXED_HOLIDAYS,
  addBusinessDays,
  businessDaysBetween,
  dueAtFor,
  easterSunday,
  goodFriday,
  isBusinessDay,
  isNationalHoliday,
  retentionUntilFor,
  retentionYearsFor,
  type DocumentKind
} from "../retention-rules.js";

const iso = (d: Date | null): string | null => (d ? d.toISOString().slice(0, 10) : null);
const doc = new Date("2026-09-10T10:00:00Z");

describe("retentionUntilFor · 31/12 del ejercicio + años", () => {
  it("6 años por defecto para facturas, albaranes, tickets, contratos y notificaciones", () => {
    for (const kind of ["invoice", "delivery_note", "receipt", "contract", "administrative_notice"] as DocumentKind[]) {
      assert.equal(retentionYearsFor({ kind }), 6, kind);
      assert.equal(iso(retentionUntilFor({ kind, documentDate: doc })), "2032-12-31", kind);
    }
  });

  it("10 años con extendedRetention (bienes de inversión / cuotas a compensar)", () => {
    assert.equal(iso(retentionUntilFor({ kind: "invoice", documentDate: doc, extendedRetention: true })), "2036-12-31");
    assert.equal(retentionYearsFor({ kind: "letter", extendedRetention: true }), 10, "la marca manual prevalece sobre el tipo");
  });

  it("6 años (letterRetentionYears, diseño §8 / art. 30 CCom) para cartas y otros, configurable; 4 solo con datos personales sin efecto fiscal (RV-05)", () => {
    assert.equal(iso(retentionUntilFor({ kind: "letter", documentDate: doc })), "2032-12-31");
    assert.equal(iso(retentionUntilFor({ kind: "other", documentDate: doc })), "2032-12-31");
    assert.equal(iso(retentionUntilFor({ kind: "letter", documentDate: doc, settings: { letterRetentionYears: 2 } })), "2028-12-31");
    assert.equal(iso(retentionUntilFor({ kind: "invoice", documentDate: doc, settings: { retentionYears: 7 } })), "2033-12-31");
    // Marca explícita «datos personales sin efecto fiscal» (guestId informado): AEPD 148/2019 → 4 años, solo letter / other.
    assert.equal(iso(retentionUntilFor({ kind: "letter", documentDate: doc, personalData: true })), "2030-12-31");
    assert.equal(iso(retentionUntilFor({ kind: "other", documentDate: doc, personalData: true })), "2030-12-31");
    assert.equal(iso(retentionUntilFor({ kind: "invoice", documentDate: doc, personalData: true })), "2032-12-31", "una factura con huésped sigue siendo fiscal: 6 años");
    assert.equal(iso(retentionUntilFor({ kind: "letter", documentDate: doc, personalData: true, extendedRetention: true })), "2036-12-31", "la marca manual prevalece");
    assert.equal(retentionYearsFor({ kind: "letter", personalData: true, settings: { personalDataRetentionYears: 3 } }), 3);
  });

  it("+1 año (solo) para documentos rechazados, sea cual sea el tipo", () => {
    assert.equal(iso(retentionUntilFor({ kind: "invoice", documentDate: doc, status: "rejected" })), "2027-12-31");
    assert.equal(iso(retentionUntilFor({ kind: "letter", documentDate: doc, status: "rejected", extendedRetention: true })), "2027-12-31");
    assert.equal(iso(retentionUntilFor({ kind: "invoice", documentDate: doc, status: "approved" })), "2032-12-31");
  });

  it("siempre el 31 de diciembre del ejercicio del documento (un 1 de enero cuenta para su año)", () => {
    assert.equal(iso(retentionUntilFor({ kind: "invoice", documentDate: new Date("2026-01-01T00:00:00Z") })), "2032-12-31");
    assert.equal(iso(retentionUntilFor({ kind: "invoice", documentDate: new Date("2026-12-31T23:59:59Z") })), "2032-12-31");
    assert.deepEqual(DEFAULT_RETENTION_SETTINGS, { retentionYears: 6, extendedRetentionYears: 10, letterRetentionYears: 6, personalDataRetentionYears: 4, rejectedRetentionYears: 1 });
  });
});

describe("calendario nacional", () => {
  it("festivos fijos y Viernes Santo calculado", () => {
    assert.equal(SPAIN_NATIONAL_FIXED_HOLIDAYS.length, 9);
    assert.equal(iso(easterSunday(2026)), "2026-04-05");
    assert.equal(iso(goodFriday(2026)), "2026-04-03");
    assert.equal(iso(goodFriday(2027)), "2027-03-26");
    assert.equal(isNationalHoliday(new Date("2026-04-03T00:00:00Z")), true);
    assert.equal(isNationalHoliday(new Date("2026-10-12T00:00:00Z")), true);
    assert.equal(isNationalHoliday(new Date("2026-12-25T00:00:00Z")), true);
    assert.equal(isNationalHoliday(new Date("2026-09-10T00:00:00Z")), false);
    assert.equal(isBusinessDay(new Date("2026-09-12T00:00:00Z")), false, "sábado");
    assert.equal(isBusinessDay(new Date("2026-09-14T00:00:00Z")), true, "lunes");
  });

  it("addBusinessDays salta fines de semana y festivos; businessDaysBetween es su inversa", () => {
    // Jueves 8/10/2026 + 3 hábiles: vie 9, (sáb 10, dom 11, lun 12 festivo) mar 13, mié 14.
    const from = new Date("2026-10-08T00:00:00Z");
    assert.equal(iso(addBusinessDays(from, 3)), "2026-10-14");
    assert.equal(businessDaysBetween(from, new Date("2026-10-14T00:00:00Z")), 3);
    assert.equal(businessDaysBetween(from, from), 0);
    assert.equal(businessDaysBetween(from, new Date("2026-10-07T00:00:00Z")), 0, "nunca negativo");
    for (const n of [1, 4, 10, 25]) {
      assert.equal(businessDaysBetween(from, addBusinessDays(from, n)), n, `n=${n}`);
    }
  });
});

describe("dueAtFor · tabla §3.5", () => {
  const noted = new Date("2026-09-10T15:30:00Z"); // jueves

  it("notificación administrativa: +10 días naturales", () => {
    assert.equal(iso(dueAtFor("administrative_notice", noted)), "2026-09-20");
  });

  it("requerimiento AEAT: +10 días hábiles", () => {
    // 11, 14-18, 21-24 → 24/09
    assert.equal(iso(dueAtFor("aeat_requirement", noted)), "2026-09-24");
  });

  it("sanción de tráfico: +20 días naturales", () => {
    assert.equal(iso(dueAtFor("traffic_fine", noted)), "2026-09-30");
  });

  it("factura electrónica: +4 días sin sábados, domingos ni festivos nacionales (art. 10 RD 238/2026)", () => {
    // Jueves 10/09 → vie 11, lun 14, mar 15, mié 16.
    assert.equal(iso(dueAtFor("e_invoice", noted)), "2026-09-16");
    // Jueves 8/10 → vie 9, (lun 12 festivo) mar 13, mié 14, jue 15.
    assert.equal(iso(dueAtFor("e_invoice", new Date("2026-10-08T09:00:00Z"))), "2026-10-15");
    // Miércoles 23/12 → jue 24, (vie 25 festivo, sáb, dom) lun 28, mar 29, mié 30.
    assert.equal(iso(dueAtFor("e_invoice", new Date("2026-12-23T09:00:00Z"))), "2026-12-30");
  });

  it("carta, contrato, factura en papel, albarán, ticket y otros: sin plazo legal (null)", () => {
    for (const kind of ["letter", "contract", "invoice", "delivery_note", "receipt", "other"] as const) {
      assert.equal(dueAtFor(kind, noted), null, kind);
    }
  });
});
