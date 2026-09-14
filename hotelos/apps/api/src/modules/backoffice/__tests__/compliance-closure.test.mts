// Unit tests for the Tanda 3 closure rules of the backoffice service:
//   · SES / VeriFactu applicability derived from real usage, not only the flag;
//   · three-state PATCH fields of compliance-settings (undefined / null / text);
//   · SES.HOSPEDAJES registry-number validation;
//   · CP ↔ INE province coherence message and details.
// No database. Run from apps/api with
//   node --import tsx --test src/modules/backoffice/__tests__/compliance-closure.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  SES_USAGE_WINDOW_DAYS,
  assertPostalAndIneCoherent,
  normalizeClearablePatchField,
  resolveComplianceApplicability,
  resolveFiscalLocation,
  validateSesRegistryNumber,
  withUsageNote,
  type FiscalLocationDeps
} from "../backoffice.service.js";
import { BadRequestError } from "../../../lib/http-error.js";

const isBadRequest = (error: unknown, fragment: string, code?: string) =>
  error instanceof BadRequestError &&
  error.statusCode === 400 &&
  error.message.includes(fragment) &&
  (code === undefined || (error.details as { code?: string } | undefined)?.code === code);

const normalizer: FiscalLocationDeps = {
  normalizeTaxRegion(raw, province) {
    const value = (raw ?? "").trim().toLowerCase();
    if (value === "es_peninsula_baleares") return "ES_PENINSULA_BALEARES";
    if (value === "es_canarias") return "ES_CANARIAS";
    if (value) return null;
    return (province ?? "").toLowerCase() === "a coruña" ? "ES_PENINSULA_BALEARES" : null;
  }
};

describe("resolveComplianceApplicability — flag OR real usage", () => {
  it("does not apply when the flag is off and there is no usage", () => {
    const result = resolveComplianceApplicability({ flagEnabled: false, usageCount: 0, flagName: "sesHospedajesEnabled", usageLabel: "envíos" });
    assert.deepEqual(result, { applies: false, byFlag: false, byUsage: false, usageCount: 0, usageNote: null });
  });

  it("applies by flag without a note", () => {
    const result = resolveComplianceApplicability({ flagEnabled: true, usageCount: 0, flagName: "verifactuEnabled", usageLabel: "facturas emitidas" });
    assert.equal(result.applies, true);
    assert.equal(result.byFlag, true);
    assert.equal(result.byUsage, false);
    assert.equal(result.usageNote, null);
  });

  it("applies by usage with the flag off and says so in the canonical note", () => {
    const result = resolveComplianceApplicability({
      flagEnabled: false,
      usageCount: 3,
      flagName: "sesHospedajesEnabled",
      usageLabel: "envíos",
      windowLabel: `últimos ${SES_USAGE_WINDOW_DAYS} días`
    });
    assert.equal(result.applies, true);
    assert.equal(result.byUsage, true);
    assert.equal(result.usageCount, 3);
    assert.ok(result.usageNote?.includes("activo por uso: 3 envíos; el flag sesHospedajesEnabled está desactivado"));
    assert.ok(result.usageNote?.endsWith("(últimos 180 días)"));
  });

  it("flag on AND usage carries no note (nothing to reconcile)", () => {
    const result = resolveComplianceApplicability({ flagEnabled: true, usageCount: 12, flagName: "verifactuEnabled", usageLabel: "facturas emitidas" });
    assert.equal(result.applies, true);
    assert.equal(result.byFlag, true);
    assert.equal(result.byUsage, true);
    assert.equal(result.usageNote, null);
  });

  it("negative or non-finite counts are treated as zero usage", () => {
    assert.equal(resolveComplianceApplicability({ flagEnabled: false, usageCount: -2, flagName: "x", usageLabel: "y" }).applies, false);
    assert.equal(resolveComplianceApplicability({ flagEnabled: false, usageCount: Number.NaN, flagName: "x", usageLabel: "y" }).applies, false);
  });

  it("withUsageNote appends the note only when present", () => {
    const silent = resolveComplianceApplicability({ flagEnabled: true, usageCount: 0, flagName: "verifactuEnabled", usageLabel: "facturas emitidas" });
    assert.equal(withUsageNote("Bloque completo.", silent), "Bloque completo.");
    const byUsage = resolveComplianceApplicability({ flagEnabled: false, usageCount: 5, flagName: "verifactuEnabled", usageLabel: "facturas emitidas" });
    assert.equal(
      withUsageNote("Bloque SistemaInformatico incompleto.", byUsage),
      "Bloque SistemaInformatico incompleto. Nota: activo por uso: 5 facturas emitidas; el flag verifactuEnabled está desactivado."
    );
  });
});

describe("normalizeClearablePatchField — undefined keeps, null / blank clears, text trims", () => {
  it("distinguishes the three states", () => {
    assert.equal(normalizeClearablePatchField(undefined, "postalCode"), undefined);
    assert.equal(normalizeClearablePatchField(null, "postalCode"), null);
    assert.equal(normalizeClearablePatchField("", "postalCode"), null);
    assert.equal(normalizeClearablePatchField("   ", "postalCode"), null);
    assert.equal(normalizeClearablePatchField("  15172 ", "postalCode"), "15172");
  });

  it("accepts JSON numbers as text and rejects other types with a 400", () => {
    assert.equal(normalizeClearablePatchField(15172, "postalCode"), "15172");
    assert.throws(
      () => normalizeClearablePatchField({ value: "15172" }, "postalCode"),
      (error: unknown) => isBadRequest(error, "postalCode debe ser texto o null", "PATCH_FIELD_TYPE_INVALID")
    );
    assert.throws(() => normalizeClearablePatchField(true, "sesRegistryNumber"), (error: unknown) => isBadRequest(error, "sesRegistryNumber"));
  });
});

describe("resolveFiscalLocation with clearOnNull (compliance-settings PATCH)", () => {
  const current = { taxRegion: "ES_PENINSULA_BALEARES", postalCode: "15172", ineMunicipalityCode: "15058", fiscalTerritory: "common" };

  it("undefined keeps every current value (same as the non-destructive mode)", () => {
    const result = resolveFiscalLocation({ current, patch: {}, province: "A Coruña", clearOnNull: true }, normalizer);
    assert.equal(result.postalCode, "15172");
    assert.equal(result.ineMunicipalityCode, "15058");
    assert.equal(result.fiscalTerritory, "common");
    assert.equal(result.taxRegionToPersist, "ES_PENINSULA_BALEARES");
  });

  it("null clears postalCode / ineMunicipalityCode / fiscalTerritory; taxRegion is kept", () => {
    const result = resolveFiscalLocation(
      { current, patch: { postalCode: null, ineMunicipalityCode: null, fiscalTerritory: null, taxRegion: null }, province: "A Coruña", clearOnNull: true },
      normalizer
    );
    assert.equal(result.postalCode, null);
    assert.equal(result.ineMunicipalityCode, null);
    assert.equal(result.fiscalTerritory, null);
    assert.equal(result.taxRegionToPersist, "ES_PENINSULA_BALEARES");
  });

  it("\"\" behaves like null in clearOnNull mode but keeps the value without the flag", () => {
    const cleared = resolveFiscalLocation({ current, patch: { postalCode: "", fiscalTerritory: " " }, clearOnNull: true }, normalizer);
    assert.equal(cleared.postalCode, null);
    assert.equal(cleared.fiscalTerritory, null);
    assert.equal(cleared.ineMunicipalityCode, "15058");
    const kept = resolveFiscalLocation({ current, patch: { postalCode: "", ineMunicipalityCode: null, fiscalTerritory: "" } }, normalizer);
    assert.equal(kept.postalCode, "15172");
    assert.equal(kept.ineMunicipalityCode, "15058");
    assert.equal(kept.fiscalTerritory, "common");
  });

  it("clearing one side of the CP/INE pair never trips the coherence rule", () => {
    const result = resolveFiscalLocation({ current, patch: { postalCode: null }, clearOnNull: true }, normalizer);
    assert.equal(result.postalCode, null);
    assert.equal(result.ineMunicipalityCode, "15058");
  });

  it("a new INE code of another province than the stored CP is rejected with the rule in the message", () => {
    assert.throws(
      () => resolveFiscalLocation({ current, patch: { ineMunicipalityCode: "28079" }, clearOnNull: true }, normalizer),
      (error: unknown) =>
        isBadRequest(error, "provincias distintas", "POSTAL_INE_PROVINCE_MISMATCH") &&
        (error as BadRequestError).message.includes("debe coincidir con la provincia del código postal")
    );
  });
});

describe("assertPostalAndIneCoherent — message and details", () => {
  it("exposes both province codes in details", () => {
    assert.throws(
      () => assertPostalAndIneCoherent("28001", "15058"),
      (error: unknown) => {
        if (!isBadRequest(error, "provincias distintas (28 ≠ 15)", "POSTAL_INE_PROVINCE_MISMATCH")) return false;
        const details = (error as BadRequestError).details as Record<string, unknown>;
        return details.postalProvinceCode === "28" && details.ineProvinceCode === "15" && details.postalCode === "28001";
      }
    );
  });
});

describe("validateSesRegistryNumber — 3..64 alphanumeric or hyphens", () => {
  it("trims and accepts real-looking registry numbers", () => {
    assert.equal(validateSesRegistryNumber("  H-CO-000123 "), "H-CO-000123");
    assert.equal(validateSesRegistryNumber("ABC"), "ABC");
    assert.equal(validateSesRegistryNumber("0".repeat(64)), "0".repeat(64));
  });

  it("rejects too short, too long, spaces and other symbols with a 400", () => {
    for (const bad of ["AB", "", "   ", "A".repeat(65), "H CO 1", "H/CO/1", "H_CO_1", "ñ-1234"]) {
      assert.throws(
        () => validateSesRegistryNumber(bad),
        (error: unknown) => isBadRequest(error, "Número de registro SES.HOSPEDAJES no válido", "SES_REGISTRY_NUMBER_INVALID"),
        `expected 400 for «${bad}»`
      );
    }
  });
});
