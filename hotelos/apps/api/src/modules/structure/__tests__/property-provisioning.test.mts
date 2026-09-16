// Unit tests of the pure planning helpers of the centre provisioning service (Tanda 6b · L2).
// Run from apps/api with
//   node --import tsx --test src/modules/structure/__tests__/property-provisioning.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  censusData,
  countBillingCentres,
  desiredPropertyFields,
  resolveSeriesPrefixes,
  summarizePlan,
  validateCentreSpec,
  validateSpec,
  type ProvisionPlan,
  type SiblingCentre
} from "../property-provisioning.service.js";
import { centreSpecSchema } from "../structure.schemas.js";

const office = () => centreSpecSchema.parse({ property: { name: "Oficina central", kind: "office", code: "OC", municipality: "Madrid", province: "Madrid" } });

const hotel = (overrides: Record<string, unknown> = {}) =>
  centreSpecSchema.parse({
    property: { name: "Hotel Norte", kind: "hotel", postalCode: "15894", ineMunicipalityCode: "15082", taxRegion: "ES_PENINSULA_BALEARES" },
    owners: [{ userId: "usr_1", roleId: "role_1" }],
    building: { name: "Edificio", code: "MAIN", floors: 2 },
    totalRooms: 4,
    roomTypes: { items: [{ code: "DBL", name: "Doble", baseCapacity: 2, maxOccupancy: 3, count: 4 }] },
    invoiceSequences: [{ sequenceCode: "FAC", invoiceType: "F1", year: 2026 }],
    ...overrides
  });

describe("validateCentreSpec", () => {
  it("an office needs no inventory nor owners; inventory sections on an office are rejected (R6)", () => {
    assert.doesNotThrow(() => validateCentreSpec(office()));
    assert.throws(() => validateCentreSpec({ ...office(), totalRooms: 10 }), /oficina no tiene edificio, habitaciones/);
    assert.throws(() => validateCentreSpec({ ...office(), ratePlans: [{ code: "BAR", name: "BAR", ratePlanType: "bar", mealPlan: null }] }), /oficina no tiene/);
    assert.throws(() => validateCentreSpec({ ...office(), property: { ...office().property, sesHospedajesEnabled: true } }), /no envía partes SES/);
  });
  it("a hotel needs owners and its inventory; the per-type counts must reconcile", () => {
    assert.doesNotThrow(() => validateCentreSpec(hotel()));
    assert.throws(() => validateCentreSpec(hotel({ owners: [] })), /owners/);
    assert.throws(() => validateCentreSpec(hotel({ building: undefined })), /necesita building, totalRooms y roomTypes/);
    assert.throws(() => validateCentreSpec(hotel({ totalRooms: 5 })), /Σ roomTypes.count = 4 ≠ totalRooms = 5/);
  });
  it("series without prefix are accepted (R3 default); series with a wrong year in the prefix are not", () => {
    assert.doesNotThrow(() => validateCentreSpec(hotel()));
    assert.throws(() => validateCentreSpec(hotel({ invoiceSequences: [{ sequenceCode: "FAC", invoiceType: "F1", year: 2026, prefix: "FAC-2025-" }] })), /lleva el año 2025/);
  });
  it("validateSpec (CLI) requires the organizationId and reports the path", () => {
    assert.throws(() => validateSpec({ property: { name: "X" } }), /Spec inválido: organizationId/);
  });
});

describe("desiredPropertyFields / censusData", () => {
  it("maps the deprecated legalName to tradeName and never asserts Property.legalName", () => {
    const spec = centreSpecSchema.parse({ property: { name: "Hotel Y", legalName: "Hotel Y Comercial" } });
    const desired = desiredPropertyFields(spec);
    assert.equal(desired.tradeName, "Hotel Y Comercial");
    assert.equal("legalName" in desired, false);
    assert.equal(desired.kind, "hotel");
  });
  it("census keeps only the values given", () => {
    assert.deepEqual(censusData({ surfaceM2: "300.00", starRating: null, bedCapacity: 176 }), { surfaceM2: "300.00", bedCapacity: 176 });
    assert.deepEqual(censusData(undefined), {});
  });
});

describe("resolveSeriesPrefixes (R3) and countBillingCentres", () => {
  const siblings: SiblingCentre[] = [
    { id: "RA", code: "RA", kind: "hotel", hasActiveSeries: true },
    { id: "OC", code: "OC", kind: "office", hasActiveSeries: false }
  ];
  const siblingSeries = [{ id: "seq_ra", propertyId: "RA", prefix: "FAC-2026-", year: 2026, active: true }];
  it("an office without series is not a billing centre; with siblings the default prefix carries the centre code", () => {
    assert.equal(countBillingCentres(siblings), 1);
    assert.equal(countBillingCentres([{ id: "OC", code: "OC", kind: "office", hasActiveSeries: true }]), 1);
    const resolved = resolveSeriesPrefixes({ sequences: hotel().invoiceSequences, propertyCode: "LT", propertyId: null, siblings, siblingSeries });
    assert.equal(resolved[0]?.prefix, "FAC-LT-2026-");
    assert.equal(resolved[0]?.prefixSource, "default");
    assert.equal(resolved[0]?.clash, null);
  });
  it("a single hotel keeps FAC-<año>- and an explicit prefix that a sister uses is flagged", () => {
    const alone = resolveSeriesPrefixes({ sequences: hotel().invoiceSequences, propertyCode: "AMC", propertyId: null, siblings: [], siblingSeries: [] });
    assert.equal(alone[0]?.prefix, "FAC-2026-");
    const clashing = resolveSeriesPrefixes({
      sequences: [{ sequenceCode: "FAC", invoiceType: "F1", year: 2026, prefix: "fac-2026-", padding: 6 }],
      propertyCode: "LT",
      propertyId: null,
      siblings,
      siblingSeries
    });
    assert.equal(clashing[0]?.clash?.propertyId, "RA");
    assert.equal(clashing[0]?.prefixSource, "spec");
  });
});

describe("summarizePlan with the structure fields", () => {
  const basePlan = (): ProvisionPlan => ({
    organization: { id: "org", name: "Org" },
    property: { existingId: null, create: { organizationId: "org", name: "Oficina central" }, fill: {}, conflicts: [] },
    owners: { create: [], skip: 0 },
    departments: [],
    modules: [],
    building: { existingId: null, create: false, floors: [] },
    roomTypes: [],
    rooms: { create: [], skip: [], typeMismatch: [], capacityFill: [] },
    ratePlans: [],
    invoiceSequences: [],
    profile: { existingId: null, create: true, fill: {}, conflicts: [] },
    settings: { aiExists: false, complianceExists: false, pilotProfile: "create" },
    countsBefore: { properties: 0 }
  });
  it("an office plan has no building/rooms lines; an implicit legal entity adds one write; a taken code is a conflict", () => {
    const plain = summarizePlan({ ...basePlan(), kind: "office" });
    assert.deepEqual(plain.writes.map((w) => `${w.op}:${w.table}`), [
      "create:properties",
      "create:compliance_property_profiles",
      "upsert:property_ai_settings",
      "upsert:property_compliance_settings",
      "update:property_compliance_settings"
    ]);
    assert.deepEqual(plain.skips, []);
    const withEntity = summarizePlan({ ...basePlan(), kind: "office", legalEntity: { id: null, code: "", legalName: "Org SL", action: "create" }, code: { value: "OC", source: "spec", inUse: true } });
    assert.equal(withEntity.writes[0]?.table, "legal_entities");
    assert.ok(withEntity.conflicts.some((c) => c.includes("code «OC»")));
  });
});
