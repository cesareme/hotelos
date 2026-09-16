import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  countBillingCentres,
  describeCentreCounts,
  describeChangeValue,
  findPrefixClashes,
  fiscalDataFieldOf,
  highRiskChangesOf,
  isOperationalKind,
  isValidTaxId,
  manualWeightsError,
  normalizeStructureCode,
  normalizeTaxId,
  pgcVariantWarning,
  propertyCreatedTitle,
  proposeSeries,
  seriesSummary,
  structureCodeError,
  structureErrorMessage,
  structureEyebrow,
  suggestCentreCode,
  taxIdValidationMessage,
  weightsTotal
} from "../structure-ui.ts";

// Pure helpers only: no React, no api-client (import.meta.env is not available under node --test).

describe("structure-ui · NIF checksum (mirror of packages/compliance/src/spain/tax-id.ts)", () => {
  it("normalises separators and the ES prefix", () => {
    assert.equal(normalizeTaxId(" es-b12345674 "), "B12345674");
    assert.equal(normalizeTaxId("12.345.678-Z"), "12345678Z");
    assert.equal(normalizeTaxId(""), null);
    assert.equal(normalizeTaxId(null), null);
  });

  it("accepts the demo CIFs and the Faranda sandbox NIF, a DNI and a NIE with a correct control character", () => {
    for (const value of ["B12345674", "B99999997", "A33615980", "12345678Z", "X1234567L", "K1234567L"]) {
      assert.equal(taxIdValidationMessage(value), null, value);
      assert.equal(isValidTaxId(value), true, value);
    }
  });

  it("rejects wrong control characters, wrong shapes, the all-zero placeholder and empty values with a Spanish reason", () => {
    assert.match(taxIdValidationMessage("B12345678") ?? "", /control del CIF/);
    assert.match(taxIdValidationMessage("12345678A") ?? "", /letra de control del DNI/);
    assert.match(taxIdValidationMessage("X1234567A") ?? "", /NIE/);
    assert.match(taxIdValidationMessage("B00000000") ?? "", /relleno/);
    assert.match(taxIdValidationMessage("B1234") ?? "", /9 caracteres/);
    assert.match(taxIdValidationMessage("ZZ1234567") ?? "", /formato/);
    assert.match(taxIdValidationMessage("") ?? "", /vacío/);
    // CIFs of associations (N, P, Q, R, S, W) take a letter, not a digit; A, B, E, H take a digit.
    assert.match(taxIdValidationMessage("P12345674") ?? "", /letra de control, no dígito/);
    assert.equal(taxIdValidationMessage("P1234567D"), null);
    assert.match(taxIdValidationMessage("A1234567J") ?? "", /dígito de control/);
  });
});

describe("structure-ui · codes", () => {
  it("normalises to 2-6 upper-case letters or digits and reports the pattern", () => {
    assert.equal(normalizeStructureCode("ra-1 x"), "RA1X");
    assert.equal(normalizeStructureCode("oficina central"), "OFICIN");
    assert.equal(structureCodeError(""), null);
    assert.equal(structureCodeError("RA"), null);
    assert.match(structureCodeError("R") ?? "", /2 a 6/);
    assert.match(structureCodeError("ra") ?? "", /mayúsculas/);
  });

  it("suggests initials of the meaningful words, skipping stop words and the brand, unique against the taken codes", () => {
    assert.equal(suggestCentreCode("Faranda Rías Altas", [], ["Faranda"]), "RA");
    assert.equal(suggestCentreCode("Hotel Faranda Los Tilos", [], ["Faranda"]), "TIL");
    assert.equal(suggestCentreCode("City House Florida Norte", [], []), "CHFN");
    assert.equal(suggestCentreCode("Oficina central"), "OC");
    assert.equal(suggestCentreCode("Pathos", []), "PAT");
    assert.equal(suggestCentreCode("Oficina central", ["OC"]), "OC2");
    assert.match(suggestCentreCode("", []), /^[A-Z0-9]{2,6}$/);
  });
});

describe("structure-ui · wizard success title agrees in gender (qa#4)", () => {
  it("«Oficina … creada», «Hotel … creado», and «Otro» reads as «Centro … creado»", () => {
    assert.equal(propertyCreatedTitle("office", "Oficina de prueba"), "Oficina «Oficina de prueba» creada");
    assert.equal(propertyCreatedTitle("hotel", "Faranda Pathos"), "Hotel «Faranda Pathos» creado");
    assert.equal(propertyCreatedTitle("other", "Almacén"), "Centro «Almacén» creado");
    assert.equal(propertyCreatedTitle(null, "X"), "Centro «X» creado");
  });
});

describe("structure-ui · series (R3)", () => {
  it("proposes FAC · FS · R with a flat prefix for the first billing centre and a coded one afterwards", () => {
    const flat = proposeSeries({ code: "PG", year: 2026, codedPrefix: false });
    assert.deepEqual(flat.map((row) => row.prefix), ["FAC-2026-", "FS-2026-", "R-2026-"]);
    const coded = proposeSeries({ code: "pg", year: 2026, codedPrefix: true });
    assert.deepEqual(coded.map((row) => row.prefix), ["FAC-PG-2026-", "FS-PG-2026-", "R-PG-2026-"]);
    assert.deepEqual(coded.map((row) => row.invoiceType), ["F1", "F2", "R1"]);
  });

  it("counts billing centres (centres with an active series) and summarises the codes", () => {
    const properties = [
      { series: [{ sequenceCode: "FAC", active: true }, { sequenceCode: "REC", active: false }] },
      { series: [{ sequenceCode: "FAC", active: false }] },
      { series: [] }
    ];
    assert.equal(countBillingCentres(properties), 1);
    assert.equal(seriesSummary(properties[0]!.series), "FAC");
    assert.equal(seriesSummary(properties[1]!.series), "—");
  });

  it("finds the active prefixes two centres share in the same year (case-insensitive), like the API's markSeriesClashes", () => {
    const rows = [
      { id: "a", propertyId: "p1", prefix: "FAC-2026-", year: 2026, active: true },
      { id: "b", propertyId: "p2", prefix: "fac-2026-", year: 2026, active: true },
      { id: "c", propertyId: "p2", prefix: "FAC-2026-", year: 2025, active: true },
      { id: "d", propertyId: "p3", prefix: "FAC-2026-", year: 2026, active: false },
      { id: "e", propertyId: "p1", prefix: "FAC-LT-2026-", year: 2026, active: true }
    ];
    assert.deepEqual(findPrefixClashes(rows).map((row) => row.id).sort(), ["a", "b"]);
  });
});

describe("structure-ui · reparto (R5)", () => {
  it("totals the manual weights and validates the 100 rule", () => {
    assert.equal(weightsTotal([{ propertyId: "a", weight: "33,33" }, { propertyId: "b", weight: "66.67" }]), 100);
    assert.equal(manualWeightsError([{ propertyId: "a", weight: "60" }, { propertyId: "b", weight: "40" }]), null);
    assert.match(manualWeightsError([{ propertyId: "a", weight: "60" }, { propertyId: "b", weight: "30" }]) ?? "", /suman 90/);
    assert.match(manualWeightsError([{ propertyId: "a", weight: "101" }]) ?? "", /entre 0 y 100/);
    assert.match(manualWeightsError([{ propertyId: "a", weight: "" }]) ?? "", /entre 0 y 100/);
    assert.match(manualWeightsError([]) ?? "", /al menos un hotel/);
  });
});

describe("structure-ui · labels and copy", () => {
  it("names the modes and counts in Spanish", () => {
    assert.equal(describeCentreCounts({ hotels: 7, offices: 1, others: 0 }), "7 hoteles · 1 oficina · 0 otros");
    assert.equal(describeCentreCounts({ hotels: 1, offices: 0, others: 1 }), "1 hotel · 0 oficinas · 1 otro");
    assert.equal(structureEyebrow("CELUISMA S.A."), "Configuración · CELUISMA S.A.");
    assert.equal(structureEyebrow(null), "Configuración");
    assert.equal(isOperationalKind("hotel"), true);
    assert.equal(isOperationalKind("office"), false);
    assert.equal(describeChangeValue(true), "sí");
    assert.equal(describeChangeValue(null), "sin valor");
    assert.equal(describeChangeValue("general"), "PGC general");
  });

  it("warns about the LSC thresholds of the PGC variant", () => {
    assert.match(pgcVariantWarning("pymes", true) ?? "", /no es depositable/);
    assert.match(pgcVariantWarning("pymes", false) ?? "", /4 M€/);
    assert.match(pgcVariantWarning("general", false) ?? "", /memoria normal/);
  });
});

describe("structure-ui · errors (details.code → Spanish)", () => {
  const error = (code: string, details: Record<string, unknown> = {}, message = "api message") => ({ message, status: 409, details: { code, ...details } });

  it("enriches SERIES_PREFIX_CLASH with the prefix and the sister centre", () => {
    const text = structureErrorMessage(error("SERIES_PREFIX_CLASH", { prefix: "FAC-2026-", conflictingPropertyId: "p1" }), "x", { propertyNames: { p1: "Rías Altas" } });
    assert.match(text, /«FAC-2026-»/);
    assert.match(text, /Rías Altas/);
  });

  it("appends the reason of an invalid NIF and keeps the worded API message of the high-risk conflicts", () => {
    assert.match(structureErrorMessage(error("TAX_ID_INVALID", { reason: "La letra no coincide." })), /La letra no coincide\./);
    assert.equal(structureErrorMessage(error("HIGH_RISK_CONFIRMATION_REQUIRED", {}, "Confirma el cambio del NIF.")), "Confirma el cambio del NIF.");
    assert.equal(structureErrorMessage(error("CHAIN_ALREADY_STARTED", {}, "Ya hay registros reales.")), "Ya hay registros reales.");
    assert.equal(structureErrorMessage({ message: "" }, "fallback"), "fallback");
  });

  it("maps the field of a typed 4xx and lists the high-risk changes", () => {
    assert.equal(fiscalDataFieldOf("TAX_ID_INVALID"), "taxId");
    assert.equal(fiscalDataFieldOf("TAX_ID_IN_USE"), "taxId");
    assert.equal(fiscalDataFieldOf("CODE_IN_USE"), "code");
    assert.equal(fiscalDataFieldOf("SERIES_PREFIX_CLASH"), null);
    assert.deepEqual(highRiskChangesOf(error("HIGH_RISK_CONFIRMATION_REQUIRED", { changes: { taxId: { from: "B99999997", to: "A33615980" } } })), [{ field: "taxId", from: "B99999997", to: "A33615980" }]);
    assert.deepEqual(highRiskChangesOf(error("X")), []);
  });
});
