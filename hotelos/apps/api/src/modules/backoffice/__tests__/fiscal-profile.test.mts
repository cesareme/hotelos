// Unit tests for the pure fiscal-profile helpers of Tanda 3 (readiness-backoffice):
// postal code / INE validation, reporting territory, tourism-tax region and the
// non-destructive resolveFiscalLocation merge shared by the profile form,
// compliance settings, createTenant, bootstrap and the onboarding import.
// No database. Run from apps/api with
//   node --import tsx --test src/modules/backoffice/__tests__/fiscal-profile.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  FISCAL_TERRITORY_OPTIONS,
  TAX_REGION_OPTIONS,
  TOURISM_TAX_REGION_OPTIONS,
  assertPostalAndIneCoherent,
  normalizeFiscalTerritory,
  normalizeTourismTaxRegion,
  normalizeTouristTaxTreatment,
  resolveFiscalLocation,
  validateIneMunicipalityCode,
  validatePostalCode,
  type FiscalLocationDeps
} from "../backoffice.service.js";
import { BadRequestError } from "../../../lib/http-error.js";

// Minimal stand-in for the statutory catalogue normaliser (contract A): canonical
// codes pass through, a few legacy spellings map, provinces derive, anything else is null.
const normalizer: FiscalLocationDeps = {
  normalizeTaxRegion(raw, province) {
    const value = (raw ?? "").trim().toLowerCase();
    if (value === "es_peninsula_baleares" || value === "mainland" || value === "madrid") return "ES_PENINSULA_BALEARES";
    if (value === "es_canarias" || value === "canary") return "ES_CANARIAS";
    if (value === "es_ceuta") return "ES_CEUTA";
    if (value === "es_melilla") return "ES_MELILLA";
    if (value) return null;
    const prov = (province ?? "").toLowerCase();
    if (prov === "a coruña" || prov === "madrid") return "ES_PENINSULA_BALEARES";
    if (prov === "las palmas") return "ES_CANARIAS";
    return null;
  }
};

const isBadRequest = (error: unknown, fragment: string) =>
  error instanceof BadRequestError && error.statusCode === 400 && error.message.includes(fragment);

describe("select options — canonical value/label pairs", () => {
  it("tax region options are the four canonical codes with Spanish labels", () => {
    assert.deepEqual(
      TAX_REGION_OPTIONS.map((option) => option.value),
      ["ES_PENINSULA_BALEARES", "ES_CANARIAS", "ES_CEUTA", "ES_MELILLA"]
    );
    assert.equal(TAX_REGION_OPTIONS[0]!.label, "Península y Baleares (IVA)");
    assert.equal(TAX_REGION_OPTIONS[3]!.label, "Melilla (IPSI)");
  });

  it("fiscal territory and tourism-tax options expose engine codes, not labels", () => {
    assert.deepEqual(
      FISCAL_TERRITORY_OPTIONS.map((option) => option.value),
      ["common", "bizkaia", "gipuzkoa", "araba", "navarra"]
    );
    assert.deepEqual(
      TOURISM_TAX_REGION_OPTIONS.map((option) => option.value),
      ["none", "CAT", "BAL", "EUSK"]
    );
  });
});

describe("validatePostalCode / validateIneMunicipalityCode", () => {
  it("accepts 5 digits with a real province prefix and trims", () => {
    assert.equal(validatePostalCode(" 15172 "), "15172");
    assert.equal(validateIneMunicipalityCode("15058"), "15058");
    assert.equal(validatePostalCode("01001"), "01001");
    assert.equal(validatePostalCode("52001"), "52001");
  });

  it("rejects wrong length, letters and impossible province prefixes with a 400", () => {
    for (const bad of ["1517", "151722", "1517A", "00123", "53001", "99999", ""]) {
      assert.throws(() => validatePostalCode(bad), (error: unknown) => isBadRequest(error, "Código postal no válido"), bad);
      assert.throws(() => validateIneMunicipalityCode(bad), (error: unknown) => isBadRequest(error, "Código INE"), bad);
    }
  });

  it("CP and INE must share the province prefix; either side missing is fine", () => {
    assert.doesNotThrow(() => assertPostalAndIneCoherent("15172", "15058"));
    assert.doesNotThrow(() => assertPostalAndIneCoherent(null, "15058"));
    assert.doesNotThrow(() => assertPostalAndIneCoherent("15172", null));
    assert.throws(() => assertPostalAndIneCoherent("28001", "15058"), (error: unknown) => isBadRequest(error, "provincias distintas"));
  });
});

describe("normalizeFiscalTerritory / normalizeTourismTaxRegion / normalizeTouristTaxTreatment", () => {
  it("maps canonical codes and common aliases case-insensitively, null otherwise", () => {
    assert.equal(normalizeFiscalTerritory("common"), "common");
    assert.equal(normalizeFiscalTerritory("Vizcaya"), "bizkaia");
    assert.equal(normalizeFiscalTerritory("ÁLAVA"), "araba");
    assert.equal(normalizeFiscalTerritory("Navarra"), "navarra");
    assert.equal(normalizeFiscalTerritory("madrid"), null);
    assert.equal(normalizeFiscalTerritory(""), null);
    assert.equal(normalizeFiscalTerritory(undefined), null);
  });

  it("tourism-tax region accepts the legacy wizard labels and yields the engine ccaaCode", () => {
    assert.equal(normalizeTourismTaxRegion("Catalonia"), "CAT");
    assert.equal(normalizeTourismTaxRegion("Balearic Islands"), "BAL");
    assert.equal(normalizeTourismTaxRegion("None"), "none");
    assert.equal(normalizeTourismTaxRegion("EUSK"), "EUSK");
    assert.equal(normalizeTourismTaxRegion("Valencia"), null);
    assert.equal(normalizeTourismTaxRegion(""), null);
  });

  it("tourist-tax treatment is one of the three documented policies", () => {
    assert.equal(normalizeTouristTaxTreatment("included_10"), "included_10");
    assert.equal(normalizeTouristTaxTreatment("NOT_SUBJECT"), "not_subject");
    assert.equal(normalizeTouristTaxTreatment("none"), "none");
    assert.equal(normalizeTouristTaxTreatment("exempt"), null);
  });
});

describe("resolveFiscalLocation — non-destructive merge, never persists ''", () => {
  it("explicit canonical input wins and is reported as source 'input'", () => {
    const result = resolveFiscalLocation(
      { current: { taxRegion: "Madrid" }, patch: { taxRegion: "ES_CANARIAS", postalCode: "35001", ineMunicipalityCode: "35016", fiscalTerritory: "common" } },
      normalizer
    );
    assert.equal(result.taxRegion, "ES_CANARIAS");
    assert.equal(result.taxRegionSource, "input");
    assert.equal(result.taxRegionToPersist, "ES_CANARIAS");
    assert.equal(result.postalCode, "35001");
    assert.equal(result.ineMunicipalityCode, "35016");
    assert.equal(result.fiscalTerritory, "common");
  });

  it("unrecognised explicit region is a 400 (no silent province fallback for garbage)", () => {
    assert.throws(
      () => resolveFiscalLocation({ current: {}, patch: { taxRegion: "Mainland Spain" }, province: "A Coruña" }, normalizer),
      (error: unknown) => isBadRequest(error, "Región fiscal no reconocida")
    );
  });

  it("empty input keeps and canonicalises the current legacy value (source 'existing')", () => {
    const result = resolveFiscalLocation(
      { current: { taxRegion: "Madrid", postalCode: "28001", ineMunicipalityCode: "28079", fiscalTerritory: "common" }, patch: { taxRegion: "", postalCode: " " } },
      normalizer
    );
    assert.equal(result.taxRegion, "ES_PENINSULA_BALEARES");
    assert.equal(result.taxRegionSource, "existing");
    assert.equal(result.taxRegionToPersist, "ES_PENINSULA_BALEARES");
    assert.equal(result.postalCode, "28001");
    assert.equal(result.ineMunicipalityCode, "28079");
    assert.equal(result.fiscalTerritory, "common");
  });

  it("empty input + empty current ('' from the old wizard) derives from the province, never ''", () => {
    const faranda = resolveFiscalLocation({ current: { taxRegion: "" }, patch: {}, province: "A Coruña" }, normalizer);
    assert.equal(faranda.taxRegion, "ES_PENINSULA_BALEARES");
    assert.equal(faranda.taxRegionSource, "province");
    assert.equal(faranda.taxRegionToPersist, "ES_PENINSULA_BALEARES");

    const unknown = resolveFiscalLocation({ current: { taxRegion: "" }, patch: {}, province: "Atlantis" }, normalizer);
    assert.equal(unknown.taxRegion, null);
    assert.equal(unknown.taxRegionSource, null);
    assert.equal(unknown.taxRegionToPersist, null, "'' must become NULL, not be preserved");
  });

  it("an unrecognised legacy value with no input is preserved verbatim (not blanked) but not canonical", () => {
    const result = resolveFiscalLocation({ current: { taxRegion: "Otro" }, patch: {} }, normalizer);
    assert.equal(result.taxRegion, null);
    assert.equal(result.taxRegionToPersist, "Otro");
  });

  it("validates CP / INE on input and their coherence against the merged values", () => {
    assert.throws(
      () => resolveFiscalLocation({ current: {}, patch: { postalCode: "1517" } }, normalizer),
      (error: unknown) => isBadRequest(error, "Código postal no válido")
    );
    assert.throws(
      () => resolveFiscalLocation({ current: { postalCode: "28001" }, patch: { ineMunicipalityCode: "15058" } }, normalizer),
      (error: unknown) => isBadRequest(error, "provincias distintas")
    );
  });

  it("a foral territory is only coherent with the peninsular (IVA) region", () => {
    assert.throws(
      () => resolveFiscalLocation({ current: {}, patch: { taxRegion: "ES_CANARIAS", fiscalTerritory: "bizkaia" } }, normalizer),
      (error: unknown) => isBadRequest(error, "territorio foral")
    );
    const ok = resolveFiscalLocation({ current: {}, patch: { taxRegion: "ES_PENINSULA_BALEARES", fiscalTerritory: "Gipuzkoa" } }, normalizer);
    assert.equal(ok.fiscalTerritory, "gipuzkoa");
    assert.throws(
      () => resolveFiscalLocation({ current: {}, patch: { fiscalTerritory: "andalucia" } }, normalizer),
      (error: unknown) => isBadRequest(error, "Territorio fiscal no reconocido")
    );
  });
});
