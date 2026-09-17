// Unit tests of the pure / injectable parts of the legal-entity service (Tanda 6b · L2).
// Run from apps/api with
//   node --import tsx --test src/modules/structure/__tests__/legal-entity.service.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  HIGH_RISK_FIELD_REASONS,
  HIGH_RISK_LEGAL_ENTITY_FIELDS,
  REAL_VERIFACTU_MODES,
  REGIME_LEGAL_ENTITY_FIELDS,
  VERIFACTU_RESOLVED_STATUSES,
  assertStructureEnabled,
  assertTaxIdUsable,
  assessLegalEntityPatchRisk,
  codeInUse,
  highRiskConfirmationRequired,
  markSeriesClashes,
  multiEntityNotEnabled,
  planLegalEntityCode,
  planPropertyCode,
  requireAnyPermission,
  resolveTaxIdChange,
  type LegalEntityCurrentRiskFields,
  type TaxIdReader
} from "../legal-entity.service.js";
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from "../../../lib/http-error.js";
import type { UserContext } from "../../../lib/demo-store.js";

const reader = (owners: Record<string, string>): TaxIdReader => ({
  findOwner: async (taxId) => (owners[taxId] ? { id: owners[taxId]! } : null)
});

describe("assertTaxIdUsable", () => {
  it("normalises and returns a valid, unclaimed NIF", async () => {
    assert.equal(await assertTaxIdUsable(" es-b12345674 ", { reader: reader({}) }), "B12345674");
  });
  it("400 TAX_ID_INVALID with the checksum reason; the placeholder B00000000 is invalid too", async () => {
    await assert.rejects(assertTaxIdUsable("B12345678", { reader: reader({}) }), (error: unknown) => {
      assert.ok(error instanceof BadRequestError);
      assert.equal(error.statusCode, 400);
      assert.equal((error.details as { code: string }).code, "TAX_ID_INVALID");
      return true;
    });
    await assert.rejects(assertTaxIdUsable("B00000000", { reader: reader({}) }), /relleno/);
  });
  it("409 TAX_ID_IN_USE when another legal entity holds it; the owner itself is excluded", async () => {
    const owners = reader({ B99999997: "le_far" });
    await assert.rejects(assertTaxIdUsable("B99999997", { reader: owners }), (error: unknown) => {
      assert.ok(error instanceof ConflictError);
      assert.equal((error.details as { code: string }).code, "TAX_ID_IN_USE");
      assert.doesNotMatch(error.message, /le_far/, "never names the other tenant");
      return true;
    });
    assert.equal(await assertTaxIdUsable("B99999997", { reader: owners, excludeLegalEntityId: "le_far" }), "B99999997");
  });
});

describe("resolveTaxIdChange (pure)", () => {
  it("undefined keeps, null clears, a same value is not a change, a different value is", () => {
    assert.deepEqual(resolveTaxIdChange("B12345674", undefined), { changed: false, next: "B12345674" });
    assert.deepEqual(resolveTaxIdChange("B12345674", null), { changed: true, next: null });
    assert.deepEqual(resolveTaxIdChange("B12345674", "es b-12345674"), { changed: false, next: "B12345674" });
    assert.deepEqual(resolveTaxIdChange(null, "B12345674"), { changed: true, next: "B12345674" });
    assert.deepEqual(resolveTaxIdChange(null, null), { changed: false, next: null });
  });
});

describe("assessLegalEntityPatchRisk (pure) · high-risk fields of the sociedad (R2 / R8 / R9 / R11, t6b#8)", () => {
  const current: LegalEntityCurrentRiskFields = { taxId: "B12345674", legalName: "Hoteles Norte SL", siiEnabled: false, largeCompany: false, pgcVariant: "pymes", fiscalYearStartMonth: 1 };

  it("the catalogue: NIF, razón social, SII, gran empresa, PGC and ejercicio; the regime subset needs accounting.configure", () => {
    assert.deepEqual([...HIGH_RISK_LEGAL_ENTITY_FIELDS], ["taxId", "legalName", "siiEnabled", "largeCompany", "pgcVariant", "fiscalYearStartMonth"]);
    assert.deepEqual([...REGIME_LEGAL_ENTITY_FIELDS], ["siiEnabled", "largeCompany", "pgcVariant", "fiscalYearStartMonth"]);
    for (const field of HIGH_RISK_LEGAL_ENTITY_FIELDS) assert.ok(HIGH_RISK_FIELD_REASONS[field].length > 40, `reason for ${field}`);
    assert.match(HIGH_RISK_FIELD_REASONS.siiEnabled, /RIVA art\. 71\.3/);
    assert.match(HIGH_RISK_FIELD_REASONS.siiEnabled, /RD 1007\/2023 art\. 3\.3/);
    assert.match(HIGH_RISK_FIELD_REASONS.pgcVariant, /LSC arts\. 257-258/);
    assert.match(HIGH_RISK_FIELD_REASONS.legalName, /RD 1619\/2012 art\. 6\.1\.c/);
  });

  it("siiEnabled / largeCompany / pgcVariant flips are high risk AND regime changes; enablesSii only on false → true", () => {
    const risk = assessLegalEntityPatchRisk(current, { siiEnabled: true, largeCompany: true, pgcVariant: "general" });
    assert.deepEqual(risk.highRiskFields, ["siiEnabled", "largeCompany", "pgcVariant"]);
    assert.deepEqual(risk.regimeFields, ["siiEnabled", "largeCompany", "pgcVariant"]);
    assert.equal(risk.enablesSii, true);
    assert.deepEqual(risk.changes.pgcVariant, { from: "pymes", to: "general" });
    const off = assessLegalEntityPatchRisk({ ...current, siiEnabled: true }, { siiEnabled: false });
    assert.deepEqual(off.highRiskFields, ["siiEnabled"]);
    assert.equal(off.enablesSii, false, "leaving the SII is high risk but never blocked by pending records");
  });

  it("legalName and taxId are high risk but NOT regime (no accounting.configure); fiscalYearStartMonth is both", () => {
    const rename = assessLegalEntityPatchRisk(current, { legalName: "  Hoteles Sur SL " });
    assert.deepEqual(rename.highRiskFields, ["legalName"]);
    assert.deepEqual(rename.regimeFields, []);
    assert.deepEqual(rename.changes.legalName, { from: "Hoteles Norte SL", to: "Hoteles Sur SL" });
    const nif = assessLegalEntityPatchRisk(current, { taxId: null });
    assert.deepEqual(nif.highRiskFields, ["taxId"]);
    assert.deepEqual(nif.changes.taxId, { from: "B12345674", to: null });
    const year = assessLegalEntityPatchRisk(current, { fiscalYearStartMonth: 7 });
    assert.deepEqual(year.highRiskFields, ["fiscalYearStartMonth"]);
    assert.deepEqual(year.regimeFields, ["fiscalYearStartMonth"]);
  });

  it("same-value writes and non-high-risk fields are not changes: legalForm, cnae, addresses, a normalised NIF, a trimmed razón social", () => {
    const same = assessLegalEntityPatchRisk(current, { taxId: " es-b12345674 ", legalName: "Hoteles Norte SL  ", siiEnabled: false, largeCompany: false, pgcVariant: "pymes", fiscalYearStartMonth: 1 });
    assert.deepEqual(same.highRiskFields, []);
    assert.deepEqual(same.regimeFields, []);
    assert.deepEqual(same.changes, {});
    assert.equal(same.enablesSii, false);
    assert.deepEqual(assessLegalEntityPatchRisk(current, {}).highRiskFields, []);
  });

  it("highRiskConfirmationRequired → 409 with field (first), fields (all), changes and the NIF pair for compat", () => {
    const risk = assessLegalEntityPatchRisk(current, { siiEnabled: true, legalName: "Otra SL" });
    const error = highRiskConfirmationRequired(risk, current);
    assert.ok(error instanceof ConflictError);
    assert.equal(error.statusCode, 409);
    const details = error.details as { code: string; field: string; fields: string[]; changes: Record<string, unknown>; currentTaxId: string | null; nextTaxId: string | null };
    assert.equal(details.code, "HIGH_RISK_CONFIRMATION_REQUIRED");
    assert.equal(details.field, "legalName", "catalogue order, not body order");
    assert.deepEqual(details.fields, ["legalName", "siiEnabled"]);
    assert.deepEqual(Object.keys(details.changes).sort(), ["legalName", "siiEnabled"]);
    assert.equal(details.currentTaxId, "B12345674");
    assert.equal(details.nextTaxId, "B12345674", "unchanged NIF: next = current");
    assert.match(error.message, /razón social/);
    assert.match(error.message, /SII/);
    assert.match(error.message, /Confirma la operación de alto riesgo\.$/);
    const nif = highRiskConfirmationRequired(assessLegalEntityPatchRisk(current, { taxId: "A58818501" }), current);
    assert.equal((nif.details as { nextTaxId: string }).nextTaxId, "A58818501");
    assert.equal((nif.details as { field: string }).field, "taxId");
  });
});

describe("codes (pure, reuse of the L1 derivation)", () => {
  it("legal entity: initials of the razón social, unique in the organization, explicit code wins", () => {
    assert.equal(planLegalEntityCode("Grupo Hotelero Demo SL", new Set()), "HD");
    assert.equal(planLegalEntityCode("Faranda Hotels & Resorts", new Set()), "FAR");
    assert.equal(planLegalEntityCode("Grupo Hotelero Demo SL", new Set(["HD"])), "HD2");
    assert.equal(planLegalEntityCode("Grupo Hotelero Demo SL", new Set(), " cel "), "CEL");
  });
  it("property: brand tokens of the organization are dropped (Faranda Rías Altas → RA); collisions get a suffix", () => {
    const organization = { name: "Faranda Hotels & Resorts", legalName: "Faranda Hotels & Resorts" };
    assert.equal(planPropertyCode("Hotel Faranda Rías Altas by Ascend Collection", organization, new Set()), "RA");
    assert.equal(planPropertyCode("Faranda Los Tilos, Ascend Hotel Collection", organization, new Set(["RA"])), "LT");
    assert.equal(planPropertyCode("Oficina central", organization, new Set(["OC"])), "OC2");
    assert.equal(planPropertyCode("Oficina central", organization, new Set(), "oc"), "OC");
  });
});

describe("typed conflicts", () => {
  it("MULTI_ENTITY_NOT_ENABLED and CODE_IN_USE carry details.code", () => {
    const multi = multiEntityNotEnabled("le_1");
    assert.equal(multi.statusCode, 409);
    assert.deepEqual(multi.details, { code: "MULTI_ENTITY_NOT_ENABLED", legalEntityId: "le_1" });
    const code = codeInUse("property", "OC");
    assert.equal(code.statusCode, 409);
    assert.deepEqual(code.details, { code: "CODE_IN_USE", scope: "property", value: "OC" });
    assert.match(code.message, /«OC»/);
  });
});

describe("guards", () => {
  it("assertStructureEnabled → 404 STRUCTURE_DISABLED only with STRUCTURE_ENABLED=false/0", () => {
    assert.doesNotThrow(() => assertStructureEnabled({}));
    assert.doesNotThrow(() => assertStructureEnabled({ STRUCTURE_ENABLED: "true" }));
    assert.throws(() => assertStructureEnabled({ STRUCTURE_ENABLED: "false" }), (error: unknown) => {
      assert.ok(error instanceof NotFoundError);
      assert.equal((error.details as { code: string }).code, "STRUCTURE_DISABLED");
      return true;
    });
    assert.throws(() => assertStructureEnabled({ STRUCTURE_ENABLED: "0" }), NotFoundError);
  });
  it("requireAnyPermission accepts any listed key and refuses with 403 otherwise", () => {
    const context = { permissions: ["accounting.read"] } as unknown as UserContext;
    assert.doesNotThrow(() => requireAnyPermission(context, ["organization.structure.manage", "accounting.read"]));
    assert.throws(() => requireAnyPermission(context, ["organization.structure.manage"]), ForbiddenError);
  });
  it("REAL_VERIFACTU_MODES excludes sandbox and the legacy null mode; only accepted / rejected are definitive AEAT answers", () => {
    assert.deepEqual([...REAL_VERIFACTU_MODES], ["preproduction", "production"]);
    assert.deepEqual([...VERIFACTU_RESOLVED_STATUSES], ["accepted", "rejected"]);
  });
});

describe("markSeriesClashes (pure)", () => {
  it("flags both sides of a same-prefix pair between centres and leaves closed series alone", () => {
    const rows = [
      { id: "s1", propertyId: "RA", prefix: "FAC-2026-", year: 2026, active: true },
      { id: "s2", propertyId: "LT", prefix: "fac-2026-", year: 2026, active: true },
      { id: "s3", propertyId: "LT", prefix: "FAC-LT-2026-", year: 2026, active: true },
      { id: "s4", propertyId: "OC", prefix: "FAC-2026-", year: 2026, active: false }
    ];
    const marked = markSeriesClashes(rows);
    assert.deepEqual(marked.map((row) => [row.id, row.clash?.propertyId ?? null]), [["s1", "LT"], ["s2", "RA"], ["s3", null], ["s4", null]]);
  });
});
