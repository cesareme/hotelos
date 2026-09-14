// Unit tests for the invoice-series policy of Tanda 3 (FISC-09): year resolution,
// wizard → AEAT invoice-type mapping, series-code coherence and the edit policy
// for series that already have issued invoices. No database. Run from apps/api with
//   node --import tsx --test src/modules/backoffice/__tests__/invoice-series-policy.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  assertSeriesCodeMatchesType,
  invoiceSequencePatchViolations,
  madridYear,
  maxIssuedNumber,
  resolveSequenceYear,
  sequenceYearFromPrefix,
  seriesInvoiceType
} from "../backoffice.service.js";
import { BadRequestError } from "../../../lib/http-error.js";

const isBadRequest = (error: unknown, fragment: string) =>
  error instanceof BadRequestError && error.statusCode === 400 && error.message.includes(fragment);

describe("sequenceYearFromPrefix / madridYear / resolveSequenceYear", () => {
  it("reads the fiscal year embedded in a legacy prefix", () => {
    assert.equal(sequenceYearFromPrefix("FAC-2026-"), 2026);
    assert.equal(sequenceYearFromPrefix("REC-2027-"), 2027);
    assert.equal(sequenceYearFromPrefix("AUDIT-2026-"), 2026);
    assert.equal(sequenceYearFromPrefix("FAC-"), null);
    assert.equal(sequenceYearFromPrefix(null), null);
    assert.equal(sequenceYearFromPrefix("F2026"), 2026);
  });

  it("madridYear uses Europe/Madrid, so 1 January 00:30 CET is the new year even though UTC is still 31 December", () => {
    assert.equal(madridYear(new Date("2026-12-31T23:30:00Z")), 2027);
    assert.equal(madridYear(new Date("2026-06-15T12:00:00Z")), 2026);
  });

  it("explicit year → prefix year → current Madrid year; out-of-range year is a 400", () => {
    assert.equal(resolveSequenceYear({ year: 2027, prefix: "FAC-2026-" }), 2027);
    assert.equal(resolveSequenceYear({ prefix: "FAC-2026-", now: new Date("2027-03-01T00:00:00Z") }), 2026);
    assert.equal(resolveSequenceYear({ prefix: null, now: new Date("2027-03-01T00:00:00Z") }), 2027);
    assert.equal(resolveSequenceYear({ year: null, now: new Date("2026-09-14T12:00:00Z") }), 2026);
    assert.throws(() => resolveSequenceYear({ year: 1999 }), (error: unknown) => isBadRequest(error, "ejercicio"));
    assert.throws(() => resolveSequenceYear({ year: 2026.5 }), (error: unknown) => isBadRequest(error, "ejercicio"));
  });
});

describe("seriesInvoiceType / assertSeriesCodeMatchesType", () => {
  it("maps the wizard values to the AEAT family and passes AEAT codes through", () => {
    assert.equal(seriesInvoiceType("full"), "F1");
    assert.equal(seriesInvoiceType("simplified"), "F2");
    assert.equal(seriesInvoiceType("rectifying"), "R");
    assert.equal(seriesInvoiceType("credit_note"), "R");
    assert.equal(seriesInvoiceType("F1"), "F1");
    assert.equal(seriesInvoiceType("r1"), "R1");
    assert.equal(seriesInvoiceType("F3"), "F3");
    assert.throws(() => seriesInvoiceType("proforma"), (error: unknown) => isBadRequest(error, "Tipo de factura no reconocido"));
  });

  it("canonical series codes must carry the matching family; custom codes are free", () => {
    assert.doesNotThrow(() => assertSeriesCodeMatchesType("FAC", "F1"));
    assert.doesNotThrow(() => assertSeriesCodeMatchesType("SIM", "F2"));
    assert.doesNotThrow(() => assertSeriesCodeMatchesType("REC", "R"));
    assert.doesNotThrow(() => assertSeriesCodeMatchesType("REC", "R1"));
    assert.doesNotThrow(() => assertSeriesCodeMatchesType("AUDIT", "F2"));
    assert.throws(() => assertSeriesCodeMatchesType("FAC", "F2"), (error: unknown) => isBadRequest(error, "serie FAC"));
    assert.throws(() => assertSeriesCodeMatchesType("SIM", "F1"), (error: unknown) => isBadRequest(error, "serie SIM"));
    assert.throws(() => assertSeriesCodeMatchesType("REC", "F1"), (error: unknown) => isBadRequest(error, "serie REC"));
  });
});

describe("maxIssuedNumber", () => {
  it("takes the numeric suffix under the prefix only, ignoring other series and drafts", () => {
    const numbers = ["FAC-2026-000013", "FAC-2026-000002", "REC-2026-000001", null, "FAC-2026-X", "FAC-2027-000001"];
    assert.equal(maxIssuedNumber(numbers, "FAC-2026-"), 13);
    assert.equal(maxIssuedNumber(numbers, "REC-2026-"), 1);
    assert.equal(maxIssuedNumber(numbers, "SIM-2026-"), null);
  });
});

describe("invoiceSequencePatchViolations — a live series is frozen where the chain depends on it", () => {
  const existing = { prefix: "FAC-2026-", padding: 6, nextNumber: 14 };
  const live = { count: 13, maxNumber: 13 };

  it("a series without issued invoices is freely editable", () => {
    const violations = invoiceSequencePatchViolations({
      existing,
      patch: { prefix: "FACT-2026-", padding: 5, nextNumber: 1 },
      issued: { count: 0, maxNumber: null }
    });
    assert.deepEqual(violations, []);
  });

  it("prefix and padding cannot change once invoices exist", () => {
    const violations = invoiceSequencePatchViolations({ existing, patch: { prefix: "FACT-2026-", padding: 5 }, issued: live });
    assert.deepEqual(
      violations.map((violation) => violation.code),
      ["SERIES_PREFIX_LOCKED", "SERIES_PADDING_LOCKED"]
    );
    assert.equal(violations[0]!.field, "prefix");
  });

  it("same prefix/padding is not a violation (idempotent re-save)", () => {
    assert.deepEqual(invoiceSequencePatchViolations({ existing, patch: { prefix: "FAC-2026-", padding: 6, nextNumber: 14 }, issued: live }), []);
  });

  it("nextNumber cannot fall to or below the highest issued number", () => {
    const below = invoiceSequencePatchViolations({ existing, patch: { nextNumber: 13 }, issued: live });
    assert.equal(below.length, 1);
    assert.equal(below[0]!.code, "SERIES_NEXT_NUMBER_BELOW_ISSUED");
    assert.match(below[0]!.message, /inferior a 14/);
    assert.deepEqual(invoiceSequencePatchViolations({ existing, patch: { nextNumber: 14 } , issued: live }), []);
    assert.deepEqual(invoiceSequencePatchViolations({ existing, patch: { nextNumber: 20 }, issued: live }), []);
  });

  it("a null prefix on a locked series counts as a change", () => {
    const violations = invoiceSequencePatchViolations({ existing, patch: { prefix: null }, issued: live });
    assert.equal(violations[0]?.code, "SERIES_PREFIX_LOCKED");
  });
});
