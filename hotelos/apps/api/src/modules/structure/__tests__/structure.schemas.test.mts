// Unit tests of the structure zod contracts (Tanda 6b · L2). Run from apps/api with
//   node --import tsx --test src/modules/structure/__tests__/structure.schemas.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  censusSchema,
  centreSpecSchema,
  establishmentPatchSchema,
  legalEntityCreateSchema,
  legalEntityPatchSchema,
  propertyCreateBodySchema,
  structureCodeSchema,
  verifactuScopeBodySchema
} from "../structure.schemas.js";

describe("structureCodeSchema", () => {
  it("normalises to upper case and enforces 2-6 letters or digits", () => {
    assert.equal(structureCodeSchema.parse(" ra "), "RA");
    assert.equal(structureCodeSchema.parse("oc"), "OC");
    assert.equal(structureCodeSchema.parse("AMC123"), "AMC123");
    assert.equal(structureCodeSchema.safeParse("R").success, false, "one character");
    assert.equal(structureCodeSchema.safeParse("ABCDEFG").success, false, "seven characters");
    assert.equal(structureCodeSchema.safeParse("R-A").success, false, "punctuation");
  });
});

describe("legalEntityPatchSchema (strict)", () => {
  it("accepts a partial body, rejects unknown keys and an empty body", () => {
    const ok = legalEntityPatchSchema.safeParse({ legalName: "CELUISMA S.A.", cnae: "5510", pgcVariant: "general", confirmHighRisk: true });
    assert.equal(ok.success, true);
    assert.equal(legalEntityPatchSchema.safeParse({ legalName: "X", verifactuChainScope: "per_entity" }).success, false, "the chain policy is console-only");
    assert.equal(legalEntityPatchSchema.safeParse({}).success, false, "nothing to change");
    assert.equal(legalEntityPatchSchema.safeParse({ confirmHighRisk: true }).success, false, "confirm alone changes nothing");
  });
  it("validates the shape of postal codes, INE, CNAE and CCC; accepts null to clear", () => {
    assert.equal(legalEntityPatchSchema.safeParse({ fiscalPostalCode: "1520" }).success, false);
    assert.equal(legalEntityPatchSchema.safeParse({ fiscalIneCode: "15082", fiscalPostalCode: "15172" }).success, true);
    assert.equal(legalEntityPatchSchema.safeParse({ cnae: "55" }).success, false);
    assert.equal(legalEntityPatchSchema.safeParse({ cccPrincipal: "15012345678" }).success, true);
    assert.equal(legalEntityPatchSchema.safeParse({ cccPrincipal: "1501234567" }).success, false);
    assert.equal(legalEntityPatchSchema.safeParse({ taxId: null }).success, true, "null clears the NIF (high risk in the service)");
    assert.equal(legalEntityPatchSchema.safeParse({ fiscalYearStartMonth: 13 }).success, false);
  });
  it("collapses empty optional texts to null", () => {
    const parsed = legalEntityPatchSchema.parse({ mercantileRegistry: "   " });
    assert.equal(parsed.mercantileRegistry, null);
  });
});

describe("legalEntityCreateSchema", () => {
  it("requires the razón social and nothing else", () => {
    assert.equal(legalEntityCreateSchema.safeParse({}).success, false);
    const parsed = legalEntityCreateSchema.parse({ legalName: "Nueva Sociedad SL", taxId: "B12345674", legalForm: "sl" });
    assert.equal(parsed.legalForm, "sl");
    assert.equal(legalEntityCreateSchema.safeParse({ legalName: "X", confirmHighRisk: true }).success, false, "no confirm key on create");
  });
});

describe("censusSchema", () => {
  it("keeps the surface as a decimal string and bounds the integers", () => {
    assert.equal(censusSchema.parse({ surfaceM2: "1250.50" }).surfaceM2, "1250.50");
    assert.equal(censusSchema.safeParse({ surfaceM2: "1250,50" }).success, false, "comma decimals are not accepted");
    assert.equal(censusSchema.safeParse({ starRating: 6 }).success, false);
    assert.equal(censusSchema.safeParse({ openingMonths: 12, bedCapacity: 176 }).success, true);
    assert.equal(censusSchema.safeParse({ socialSecurityCcc: "150123456" }).success, false);
    assert.equal(censusSchema.safeParse({ unknown: 1 }).success, false);
  });
});

describe("centreSpecSchema / propertyCreateBodySchema", () => {
  const office = { property: { name: "Oficina central", kind: "office", code: "oc", municipality: "Madrid" } };
  it("an office needs only its property block; defaults fill the rest", () => {
    const parsed = centreSpecSchema.parse(office);
    assert.equal(parsed.property.kind, "office");
    assert.equal(parsed.property.code, "OC");
    assert.deepEqual(parsed.owners, []);
    assert.deepEqual(parsed.invoiceSequences, []);
    assert.equal(parsed.property.sesHospedajesEnabled, false);
    assert.deepEqual(parsed.property.census, {});
  });
  it("is strict at the root and in the property block; profile stays passthrough", () => {
    assert.equal(centreSpecSchema.safeParse({ ...office, extra: 1 }).success, false);
    assert.equal(centreSpecSchema.safeParse({ property: { ...office.property, nif: "X" } }).success, false);
    const withProfile = centreSpecSchema.parse({ ...office, profile: { hasRestaurant: true, plazas: 176 } });
    assert.equal((withProfile.profile as { plazas?: number }).plazas, 176);
  });
  it("series accept an omitted prefix (R3 default) and the body carries dryRun", () => {
    const body = propertyCreateBodySchema.parse({
      dryRun: true,
      property: { name: "Hotel X", kind: "hotel" },
      invoiceSequences: [{ sequenceCode: "FAC", invoiceType: "F1", year: 2026 }]
    });
    assert.equal(body.dryRun, true);
    assert.equal(body.invoiceSequences[0]?.prefix, undefined);
    assert.equal(body.invoiceSequences[0]?.padding, 6);
    assert.equal(propertyCreateBodySchema.safeParse({ property: { name: "X" }, organizationId: "org" }).success, false, "organizationId comes from the route");
  });
  it("defaults kind to hotel and accepts the legacy legalName field", () => {
    const parsed = centreSpecSchema.parse({ property: { name: "Hotel Y", legalName: "Hotel Y Comercial" } });
    assert.equal(parsed.property.kind, "hotel");
    assert.equal(parsed.property.legalName, "Hotel Y Comercial");
  });
});

describe("establishmentPatchSchema", () => {
  it("accepts kind / code / tradeName / census, never the NIF or razón social, never empty", () => {
    const parsed = establishmentPatchSchema.parse({ kind: "office", code: "oc", tradeName: "  ", surfaceM2: "300" });
    assert.equal(parsed.code, "OC");
    assert.equal(parsed.tradeName, null);
    assert.equal(establishmentPatchSchema.safeParse({ taxId: "B12345674" }).success, false);
    assert.equal(establishmentPatchSchema.safeParse({ legalName: "X" }).success, false);
    assert.equal(establishmentPatchSchema.safeParse({}).success, false);
  });
});

describe("verifactuScopeBodySchema", () => {
  it("requires the scope and an explicit confirm: true", () => {
    assert.equal(verifactuScopeBodySchema.parse({ scope: "per_entity", confirm: true }).scope, "per_entity");
    assert.equal(verifactuScopeBodySchema.safeParse({ scope: "per_entity" }).success, false);
    assert.equal(verifactuScopeBodySchema.safeParse({ scope: "per_entity", confirm: false }).success, false);
    assert.equal(verifactuScopeBodySchema.safeParse({ scope: "per_hotel", confirm: true }).success, false);
  });
});
