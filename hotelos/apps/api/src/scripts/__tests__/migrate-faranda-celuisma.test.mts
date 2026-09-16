// Pure unit tests for the Faranda → CELUISMA migration CLI (Tanda 6b · L8). No
// database: flag parsing (the domiciles have NO default and --apply refuses
// without --fiscal-address), the six specs (valid, unique codes, coded series
// without clashes, deterministic room counts, three parametrised office
// addresses), the pure planners of every step (sociedad patch with optional
// domiciles, census fill of RA / LT, RA series, installations deferred until
// each hotel activates VeriFactu, cross-batch prefix clashes), the identity of
// an existing centre by (legalEntityId, code), the audit flush on every exit
// (finalizeSummary + source contract) and — the contract of the lot —
// idempotency: planning again over the post-state of a plan yields zero writes.
// Run from apps/api:
//   node --import tsx --test src/scripts/__tests__/migrate-faranda-celuisma.test.mts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  ADDRESS_OPTIONS,
  ADDRESS_OPTION_KEYS,
  CELUISMA,
  CORRELATION_ID,
  EXISTING_CENTRE_CENSUS,
  EXPECTED_CENTRE_CODES,
  FARANDA_ORGANIZATION_ID,
  HOTEL_CODES,
  LEGAL_ENTITY_ADDRESS_FIELDS,
  LOS_TILOS_PROPERTY_ID,
  OFFICE_CODE,
  RIAS_ALTAS_PROPERTY_ID,
  RIAS_ALTAS_REAT_ROOMS,
  RIAS_ALTAS_TARGET_SERIES,
  SANDBOX_SERIES_SUFFIX,
  SERIES_YEAR,
  USAGE,
  applyLegalEntityPatchToRow,
  applyOfficeAddress,
  applySeriesPlanToRows,
  assertConfirmMatches,
  assertHotelSpec,
  assertOfficeSpec,
  describeAddress,
  desiredLegalEntity,
  detectBatchPrefixClashes,
  detectCodeClashes,
  effectiveRegisteredOffice,
  finalizeSummary,
  findExistingCentre,
  formatCentreTable,
  loadMigrationSpecs,
  openDecisions,
  parseFlags,
  planCensusFill,
  planLegalEntityPatch,
  planRiasAltasSeries,
  planSandboxInstallations,
  plannedActiveSeries,
  readRawSpec,
  specForExistingCentre,
  specsDir,
  systemContext,
  type CentreForInstallation,
  type CentreIdentity,
  type LegalEntityCurrent,
  type MigrationSnapshot,
  type MigrationSummary,
  type SeriesRow
} from "../migrate-faranda-celuisma.js";
import { SANDBOX_INSTALL_NUMBER } from "../backfill-legal-structure.js";
import { hotelInventoryOf, isHotelKind, planRooms, validateSpec } from "../../modules/structure/property-provisioning.service.js";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ORG = FARANDA_ORGANIZATION_ID;
const SCRIPT_PATH = resolve(fileURLToPath(import.meta.url), "../../migrate-faranda-celuisma.ts");

// ── Fixtures: Faranda as the local DB held it on 2026-09-16 (after the backfill) ──

function farandaEntity(): LegalEntityCurrent {
  return {
    id: "le_5a1bd74b",
    code: "FAR",
    legalName: "Faranda Hotels & Resorts",
    taxId: "B99999997",
    legalForm: null,
    cnae: null,
    fiscalAddress: null,
    fiscalPostalCode: null,
    fiscalMunicipality: null,
    fiscalIneCode: null,
    fiscalProvince: null,
    registeredOfficeAddress: null,
    registeredOfficePostalCode: null,
    registeredOfficeMunicipality: null,
    registeredOfficeProvince: null,
    mercantileRegistry: null,
    pgcVariant: "pymes",
    fiscalYearStartMonth: 1,
    largeCompany: false,
    siiEnabled: false,
    verifactuChainScope: "per_center"
  };
}

function farandaSeries(): SeriesRow[] {
  return [
    { id: "cmrhylncn000mfy69dd2ogb01", propertyId: RIAS_ALTAS_PROPERTY_ID, sequenceCode: "FAC", invoiceType: "F1", prefix: "FAC-2026-", year: 2026, nextNumber: 23, padding: 6, active: true },
    { id: "cmtzofsem00lyfy1j40o5w6yg", propertyId: RIAS_ALTAS_PROPERTY_ID, sequenceCode: "REC", invoiceType: "R1", prefix: "REC-2026-", year: 2026, nextNumber: 4, padding: 6, active: true },
    { id: "seq_d553c5aa", propertyId: LOS_TILOS_PROPERTY_ID, sequenceCode: "FAC", invoiceType: "F1", prefix: "FAC-LT-2026-", year: 2026, nextNumber: 1, padding: 6, active: true },
    { id: "seq_1e1137a4", propertyId: LOS_TILOS_PROPERTY_ID, sequenceCode: "REC", invoiceType: "R1", prefix: "REC-LT-2026-", year: 2026, nextNumber: 1, padding: 6, active: true }
  ];
}

function emptySummary(dryRun: boolean): MigrationSummary {
  return {
    dryRun,
    organizationId: ORG,
    options: { officeCity: "madrid", fiscalAddress: dryRun ? null : "florida", registeredOffice: dryRun ? null : "florida", sandboxInstallations: false, skipHotels: [] },
    verifactuMode: "sandbox",
    steps: [{ step: 1, title: "t", status: "ok", writes: 0, lines: [], warnings: [], errors: [] }],
    centres: [],
    collisions: { prefixes: 0, codes: 0, specConflicts: 0 },
    openDecisions: [],
    invariants: { before: null, after: null, unchanged: null },
    expectedMode: null,
    totals: { writes: 0, errors: 0 },
    audit: { flushed: null, error: null },
    durationMs: 0
  };
}

const specs = loadMigrationSpecs({ officeCity: "madrid", skipHotels: [] });
const batch = [specs.office.spec, ...specs.hotels.map((h) => h.spec)];

// ── Flags ─────────────────────────────────────────────────────────────────────

describe("parseFlags", () => {
  it("defaults to dry-run, office in Madrid, NO domicile chosen (fiscal and registered null), no filler for disabled hotels, no skipped hotels", () => {
    assert.deepEqual(parseFlags([]), { apply: false, confirm: null, officeCity: "madrid", fiscalAddress: null, registeredOffice: null, sandboxInstallations: false, skipHotels: [], json: false, printRollback: false, help: false });
    assert.equal(parseFlags(["--dry-run", "--json"]).json, true);
    assert.equal(effectiveRegisteredOffice(parseFlags([])), null);
  });
  it("--help / -h short-circuit and USAGE names every flag and the three address candidates with their evidence", () => {
    assert.equal(parseFlags(["--help"]).help, true);
    assert.equal(parseFlags(["--apply", "-h"]).help, true);
    for (const flag of ["--dry-run", "--apply", "--confirm", "--fiscal-address", "--registered-office", "--office-city", "--sandbox-installations", "--skip-hotels", "--json", "--print-rollback", "--help"]) assert.ok(USAGE.includes(flag), `USAGE mentions ${flag}`);
    assert.ok(USAGE.includes(ORG), "USAGE shows the exact --confirm value");
    for (const key of ADDRESS_OPTION_KEYS) assert.ok(USAGE.includes(describeAddress(key)), `USAGE lists candidate ${key}`);
    assert.match(USAGE, /SIN valor por defecto/);
  });
  it("--apply requires --confirm AND --fiscal-address (no default domicile, exit 2 path); --confirm without --apply, dry-run + apply and rollback + apply are refused", () => {
    assert.throws(() => parseFlags(["--apply"]), /--confirm/);
    assert.throws(() => parseFlags(["--apply", "--confirm", ORG]), /--apply requires --fiscal-address gijon\|madrid\|florida/);
    assert.throws(() => parseFlags(["--apply", "--confirm", ORG, "--registered-office", "gijon"]), /--apply requires --fiscal-address/, "registered office alone does not unlock the apply");
    const ok = parseFlags(["--apply", "--confirm", ORG, "--fiscal-address", "florida"]);
    assert.equal(ok.apply, true);
    assert.equal(ok.fiscalAddress, "florida");
    assert.equal(effectiveRegisteredOffice(ok), "florida", "registered office defaults to the fiscal one");
    assert.throws(() => parseFlags(["--confirm", ORG]), /only makes sense with --apply/);
    assert.throws(() => parseFlags(["--dry-run", "--apply", "--confirm", ORG, "--fiscal-address", "gijon"]), /mutually exclusive/);
    assert.throws(() => parseFlags(["--print-rollback", "--apply", "--confirm", ORG, "--fiscal-address", "gijon"]), /read-only/);
    assert.throws(() => parseFlags(["--apply", "--confirm", ORG, "--confirm", ORG, "--fiscal-address", "gijon"]), /only once/);
  });
  it("--fiscal-address / --registered-office / --office-city accept only gijon | madrid | florida; --sandbox-installations is a boolean opt-in; --skip-hotels only known codes", () => {
    assert.equal(parseFlags(["--office-city", "gijon"]).officeCity, "gijon");
    assert.equal(parseFlags(["--office-city", "florida"]).officeCity, "florida");
    assert.equal(parseFlags(["--fiscal-address", "madrid"]).fiscalAddress, "madrid");
    const mixed = parseFlags(["--fiscal-address", "florida", "--registered-office", "gijon"]);
    assert.equal(mixed.fiscalAddress, "florida");
    assert.equal(mixed.registeredOffice, "gijon");
    assert.equal(effectiveRegisteredOffice(mixed), "gijon");
    assert.equal(effectiveRegisteredOffice(parseFlags(["--registered-office", "madrid"])), "madrid", "dry-run may choose only the registered office");
    assert.equal(parseFlags(["--sandbox-installations"]).sandboxInstallations, true);
    assert.throws(() => parseFlags(["--office-city", "oviedo"]), /--office-city must be one of/);
    assert.throws(() => parseFlags(["--fiscal-address", "santander"]), /--fiscal-address must be one of/);
    assert.throws(() => parseFlags(["--registered-office", "asturias"]), /--registered-office must be one of/);
    assert.throws(() => parseFlags(["--fiscal-address"]), /requires a value/);
    assert.deepEqual(parseFlags(["--skip-hotels", "pg, mc,PG"]).skipHotels, ["PG", "MC"]);
    assert.throws(() => parseFlags(["--skip-hotels", "RA"]), /unknown centre codes: RA/);
    assert.throws(() => parseFlags(["--skip-hotels"]), /requires a value/);
    assert.throws(() => parseFlags(["--bogus"]), /Unknown flag/);
  });
  it("assertConfirmMatches guards the organisation id only with --apply", () => {
    assert.doesNotThrow(() => assertConfirmMatches({ apply: false, confirm: null }));
    assert.doesNotThrow(() => assertConfirmMatches({ apply: true, confirm: ORG }));
    assert.throws(() => assertConfirmMatches({ apply: true, confirm: "org_123" }), /does not match/);
  });
  it("the system actor carries exactly the keys the reused services check", () => {
    const context = systemContext(ORG, RIAS_ALTAS_PROPERTY_ID);
    assert.equal(context.organizationId, ORG);
    assert.deepEqual([...context.permissions].sort(), ["ai.high_risk.confirm", "billing.configure", "organization.structure.manage"]);
    assert.equal(context.isPlatformAdmin, false);
  });
});

// ── Address candidates ────────────────────────────────────────────────────────

describe("ADDRESS_OPTIONS · the three candidates of the sociedad", () => {
  it("names the street type of Portugal 7 as Avenida (never «Calle»), adds Paseo de la Florida 5 and keeps CP ↔ INE coherent", () => {
    assert.deepEqual(ADDRESS_OPTION_KEYS, ["gijon", "madrid", "florida"]);
    assert.equal(ADDRESS_OPTIONS.gijon.address, "Avenida de Portugal, 7");
    assert.doesNotMatch(ADDRESS_OPTIONS.gijon.address, /Calle/);
    assert.equal(ADDRESS_OPTIONS.florida.address, "Paseo de la Florida, 5");
    assert.equal(ADDRESS_OPTIONS.florida.postalCode, "28008");
    assert.equal(ADDRESS_OPTIONS.florida.ineCode, "28079");
    assert.equal(ADDRESS_OPTIONS.madrid.postalCode, "28003");
    for (const key of ADDRESS_OPTION_KEYS) {
      const a = ADDRESS_OPTIONS[key];
      assert.equal(a.postalCode.slice(0, 2), a.ineCode.slice(0, 2), `${key}: CP and INE share the province prefix`);
      assert.ok(a.source.length > 20, `${key} cites its public source`);
      assert.match(describeAddress(key), new RegExp(`^${key} = ${a.address.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    }
    assert.match(ADDRESS_OPTIONS.florida.source, /eInforma/);
    assert.match(ADDRESS_OPTIONS.gijon.source, /Empresia/);
    assert.match(CELUISMA.mercantileRegistryOffice, /Madrid/);
    assert.equal(CELUISMA.mercantileRegistry, null, "tomo / folio / hoja unknown: never asserted");
    assert.equal(CELUISMA.publicFigures.employees2024, 62);
  });
});

// ── Specs ─────────────────────────────────────────────────────────────────────

describe("specs · the six L8 files validate and describe the eight centres", () => {
  it("loads the office and the five hotels in the expected order with their codes", () => {
    assert.equal(specs.office.spec.property.code, OFFICE_CODE);
    assert.deepEqual(specs.hotels.map((h) => h.code), [...HOTEL_CODES]);
    assert.deepEqual(specs.skipped, []);
    assert.deepEqual(EXPECTED_CENTRE_CODES, ["RA", "LT", "PG", "MC", "AS", "FN", "LL", "OC"]);
    for (const spec of batch) assert.equal(spec.organizationId, ORG);
  });
  it("every hotel carries the confirmed totals, a 5-digit INE coherent with its CP and the three coded series", () => {
    const expected: Record<string, { rooms: number; ine: string; cp: string; stars: number; municipality: string }> = {
      PG: { rooms: 56, ine: "33024", cp: "33201", stars: 3, municipality: "Gijón" },
      MC: { rooms: 85, ine: "33014", cp: "33430", stars: 4, municipality: "Candás (Carreño)" },
      AS: { rooms: 78, ine: "39075", cp: "39009", stars: 2, municipality: "Santander" },
      FN: { rooms: 399, ine: "28079", cp: "28008", stars: 4, municipality: "Madrid" },
      LL: { rooms: 102, ine: "33044", cp: "33010", stars: 3, municipality: "Oviedo" }
    };
    for (const { code, spec, file } of specs.hotels) {
      const want = expected[code]!;
      assert.equal(spec.totalRooms, want.rooms, `${file} totalRooms`);
      assert.equal(spec.property.ineMunicipalityCode, want.ine, `${file} INE`);
      assert.equal(spec.property.postalCode, want.cp, `${file} CP`);
      assert.equal(spec.property.municipality, want.municipality);
      assert.equal(spec.property.census.starRating, want.stars, `${file} stars`);
      assert.equal(spec.property.taxRegion, "ES_PENINSULA_BALEARES");
      assert.equal(spec.property.fiscalTerritory, "common");
      assert.equal(spec.property.sesHospedajesEnabled, false);
      assert.equal(spec.property.verifactuEnabled, false, "new hotels are born with VeriFactu off: their installation is opened at activation");
      assert.equal(spec.property.legalName, null, "Property.legalName is deprecated and never set");
      assert.equal(spec.property.tradeName, spec.property.name);
      assert.deepEqual(
        spec.invoiceSequences.map((s) => [s.sequenceCode, s.invoiceType, s.prefix]),
        [["FAC", "F1", `FAC-${code}-2026-`], ["REC", "R1", `REC-${code}-2026-`], ["SIM", "F2", `FS-${code}-2026-`]]
      );
      assert.doesNotThrow(() => assertHotelSpec(spec, code, file));
      assert.deepEqual(spec.owners, [{ userId: "cmrhw9jyb0005fyvb4ykaumyc", roleId: "cmrhw9jy60004fyvbjvur0uqt" }], "Carmen Owner");
      assert.deepEqual(spec.modules, ["pms_core", "compliance_hub", "distribution_hub", "guest_experience", "outlet_pos", "revenue_profit_engine"]);
      assert.deepEqual(spec.ratePlans.map((p) => p.code), ["BAR"], "one BAR without prices, as Los Tilos");
    }
  });
  it("room counts of the deterministic numbering match the spec per type; bedCapacity = Σ count × baseCapacity", () => {
    const expected: Record<string, Record<string, number>> = {
      PG: { IND: 4, DBL: 24, DBM: 28 },
      MC: { IND: 5, DBL: 37, DBM: 40, SUI: 3 },
      AS: { IND: 6, DBL: 36, DBM: 36 },
      FN: { CLA: 250, SUP: 100, SUT: 42, JRS: 7 },
      LL: { IND: 16, DBL: 83, SUI: 3 }
    };
    for (const { code, spec } of specs.hotels) {
      const rooms = planRooms(hotelInventoryOf(spec));
      const byType: Record<string, number> = {};
      for (const r of rooms) byType[r.roomTypeCode] = (byType[r.roomTypeCode] ?? 0) + 1;
      assert.deepEqual(byType, expected[code], `${code} rooms per type`);
      assert.equal(new Set(rooms.map((r) => r.number)).size, spec.totalRooms, `${code} unique numbers`);
      const plazas = spec.roomTypes!.items.reduce((sum, t) => sum + t.count * t.baseCapacity, 0);
      assert.equal(spec.property.census.bedCapacity, plazas, `${code} bedCapacity`);
    }
  });
  it("only Las Lomas has a public split (explicit rooms, _estimated false); the other four are marked _estimated with the Los Tilos rule and a source", () => {
    for (const { code, spec } of specs.hotels) {
      const notes = (spec._notes as { sources: Record<string, string> }).sources;
      assert.ok(notes.web.includes("farandahotels.com"), `${code} cites the official web`);
      assert.ok(notes.ine.includes("ine.es"), `${code} cites the INE nomenclátor`);
      if (code === "LL") {
        assert.equal(spec.roomTypes!._estimated, false);
        assert.equal(spec.rooms?.length, 102);
        assert.equal(spec.rooms!.filter((r) => r.roomTypeCode === "IND").length, 16);
        assert.deepEqual(spec.rooms!.filter((r) => r.roomTypeCode === "SUI").map((r) => r.number), ["134", "234", "334"]);
      } else {
        assert.equal(spec.roomTypes!._estimated, true, `${code} estimated`);
        assert.match(spec.roomTypes!._estimatedReason ?? "", /ESTIMADO/);
        assert.match(spec.roomTypes!._estimatedReason ?? "", /Los Tilos/);
        assert.equal(spec.rooms, undefined);
      }
    }
  });
  it("the office is a non-billing office of Faranda: kind office, code OC, no rooms / rate plans / series / SES, Carmen as owner, no operational modules", () => {
    const office = specs.office.spec;
    assert.equal(office.property.kind, "office");
    assert.equal(office.building, undefined);
    assert.equal(office.totalRooms, undefined);
    assert.equal(office.roomTypes, undefined);
    assert.deepEqual(office.ratePlans, []);
    assert.deepEqual(office.invoiceSequences, []);
    assert.deepEqual(office.modules, []);
    assert.equal(office.property.sesHospedajesEnabled, false);
    assert.equal(office.owners.length, 1);
    assert.doesNotThrow(() => assertOfficeSpec(office));
    assert.throws(() => assertOfficeSpec({ ...office, property: { ...office.property, kind: "hotel" } }), /kind office/);
    assert.throws(() => assertOfficeSpec({ ...office, invoiceSequences: [{ sequenceCode: "FAC", invoiceType: "F1", prefix: "FAC-OC-2026-", year: 2026, padding: 6 }] }), /no factura/);
  });
  it("applyOfficeAddress swaps the whole address block per city; the three options validate (CP ↔ INE coherent) and mirror ADDRESS_OPTIONS", () => {
    const raw = readRawSpec(resolve(specsDir(), "faranda-oficina-central.json"));
    for (const key of ADDRESS_OPTION_KEYS) {
      const spec = validateSpec(applyOfficeAddress(raw, key));
      const want = ADDRESS_OPTIONS[key];
      assert.equal(spec.property.address, want.address, `${key} address`);
      assert.equal(spec.property.municipality, want.municipality);
      assert.equal(spec.property.province, want.province);
      assert.equal(spec.property.postalCode, want.postalCode);
      assert.equal(spec.property.ineMunicipalityCode, want.ineCode);
    }
    assert.equal((validateSpec(applyOfficeAddress(raw, "gijon")).profile as { autonomousCommunity: string | null }).autonomousCommunity, "Asturias");
    assert.equal((validateSpec(applyOfficeAddress(raw, "florida")).profile as { autonomousCommunity: string | null }).autonomousCommunity, "Comunidad de Madrid");
    const notes = raw._notes as { addressOptions: { _confirm: string }; sources: { registry: string } };
    assert.match(notes.addressOptions._confirm, /confirmar/i);
    assert.match(notes.sources.registry, /Registro Mercantil de MADRID/);
    assert.match(notes.sources.registry, /eInforma/);
    assert.throws(() => applyOfficeAddress({ ...raw, _notes: {} }, "madrid"), /addressOptions\.madrid/);
    const gijonSpecs = loadMigrationSpecs({ officeCity: "gijon", skipHotels: ["PG", "FN"] });
    assert.equal(gijonSpecs.office.spec.property.municipality, "Gijón");
    assert.deepEqual(gijonSpecs.hotels.map((h) => h.code), ["MC", "AS", "LL"]);
    assert.deepEqual(gijonSpecs.skipped, ["PG", "FN"]);
    assert.equal(loadMigrationSpecs({ officeCity: "florida", skipHotels: [] }).office.spec.property.postalCode, "28008");
  });
  it("centre codes are unique across the batch and the existing centres", () => {
    assert.deepEqual(detectCodeClashes(["RA", "LT"], batch), []);
    assert.deepEqual(detectCodeClashes(["RA", "LT", "PG"], batch), ["PG"]);
    assert.deepEqual(detectCodeClashes(["RA", "LT"], [...batch, batch[1]!]), ["PG"]);
  });
  it("assertHotelSpec refuses a hotel of another organisation, a wrong code, a missing coded series or no owners", () => {
    const spec = specs.hotels[0]!.spec;
    assert.throws(() => assertHotelSpec({ ...spec, organizationId: "org_123" }, "PG", "x.json"), /organizationId/);
    assert.throws(() => assertHotelSpec(spec, "MC", "x.json"), /≠ código esperado «MC»/);
    assert.throws(() => assertHotelSpec({ ...spec, invoiceSequences: spec.invoiceSequences.slice(0, 2) }, "PG", "x.json"), /FS-PG-2026-/);
    assert.throws(() => assertHotelSpec({ ...spec, owners: [] }, "PG", "x.json"), /owners vacío/);
  });
});

// ── Identity of an existing centre (l8#7) ─────────────────────────────────────

describe("findExistingCentre / specForExistingCentre · identity = (legalEntityId, code), name only as fallback", () => {
  const entityId = "le_5a1bd74b";
  const lasLomas = specs.hotels.find((h) => h.code === "LL")!.spec;
  const rows: CentreIdentity[] = [
    { id: "p_ra", name: "Hotel Faranda Rías Altas by Ascend Collection", code: "RA", tradeName: "Hotel Faranda Rías Altas by Ascend Collection", legalEntityId: entityId },
    { id: "p_ll", name: "City House Las Lomas by Faranda", code: "ll", tradeName: "City House Las Lomas", legalEntityId: entityId },
    { id: "p_other", name: "Hotel Faranda Express Las Lomas", code: "LL", tradeName: null, legalEntityId: "le_other" },
    { id: "p_nocode", name: "Faranda Pathos Gijón, Ascend Hotel Collection", code: null, tradeName: null, legalEntityId: entityId }
  ];
  it("finds a renamed centre by its code inside the sociedad (case-insensitive) before any name match, and never a same-code centre of another sociedad", () => {
    assert.equal(findExistingCentre(rows, lasLomas, entityId)?.id, "p_ll", "renamed Las Lomas is still LL");
    // Same code under another sociedad (and a different name): not ours.
    const withoutOurs = rows.filter((r) => r.id !== "p_ll").map((r) => (r.id === "p_other" ? { ...r, name: "Otro hotel" } : r));
    assert.equal(findExistingCentre(withoutOurs, lasLomas, entityId), null);
    // Rows still unlinked to a sociedad (legalEntityId null) match by code too.
    assert.equal(findExistingCentre([{ ...rows[1]!, legalEntityId: null }], lasLomas, entityId)?.id, "p_ll");
  });
  it("falls back to the name for rows without code (pre-backfill) and returns null for a really new centre", () => {
    const pathos = specs.hotels.find((h) => h.code === "PG")!.spec;
    assert.equal(findExistingCentre(rows, pathos, entityId)?.id, "p_nocode");
    const office = specs.office.spec;
    assert.equal(findExistingCentre(rows, office, entityId), null);
    assert.equal(findExistingCentre([], lasLomas, entityId), null);
  });
  it("the name fallback still applies when the code belongs to another sociedad (the unique index is per sociedad)", () => {
    const foreign = rows.filter((r) => r.id === "p_other");
    // Same code under another legalEntityId is not a match by code; the name matches the spec, so buildPlan would converge on it — reported, never hidden.
    assert.equal(findExistingCentre(foreign, lasLomas, entityId)?.id, "p_other");
    assert.equal(findExistingCentre(foreign, { property: { ...lasLomas.property, name: "otro" } }, entityId), null);
  });
  it("specForExistingCentre hands buildPlan the DB name / tradeName of a renamed centre and leaves everything else (and a non-renamed spec) untouched", () => {
    const renamed = specForExistingCentre(lasLomas, rows[1]!);
    assert.equal(renamed.renamed, true);
    assert.equal(renamed.spec.property.name, "City House Las Lomas by Faranda");
    assert.equal(renamed.spec.property.tradeName, "City House Las Lomas");
    assert.equal(renamed.spec.property.code, "LL");
    assert.deepEqual(renamed.spec.invoiceSequences, lasLomas.invoiceSequences);
    assert.equal(renamed.spec.totalRooms, 102);
    assert.equal(lasLomas.property.name, "Hotel Faranda Express Las Lomas", "the loaded spec is not mutated");
    const same = specForExistingCentre(lasLomas, { id: "p_ll", name: lasLomas.property.name, code: "LL", tradeName: lasLomas.property.tradeName ?? null, legalEntityId: entityId });
    assert.equal(same.renamed, false);
    assert.equal(same.spec, lasLomas);
    assert.equal(specForExistingCentre(lasLomas, null).spec, lasLomas);
    const tradeOnly = specForExistingCentre(lasLomas, { id: "p_ll", name: lasLomas.property.name, code: "LL", tradeName: null, legalEntityId: entityId });
    assert.equal(tradeOnly.renamed, false, "a null tradeName in the DB is filled, not a rename");
  });
});

// ── Step 2 · Sociedad ─────────────────────────────────────────────────────────

describe("planLegalEntityPatch (FAR → CEL «CELUISMA S.A.» A33615980)", () => {
  it("without a chosen domicile plans ONLY the 5 confirmed identity fields (the 9 address columns are not asserted) and still asks for confirmHighRisk", () => {
    const plan = planLegalEntityPatch(farandaEntity(), null);
    assert.ok(plan.body, "there is something to patch");
    assert.deepEqual(plan.highRiskFields, ["taxId", "legalName"]);
    assert.equal(plan.body!.confirmHighRisk, true);
    assert.deepEqual(Object.keys(plan.body!).filter((k) => k !== "confirmHighRisk").sort(), ["cnae", "code", "legalForm", "legalName", "taxId"]);
    for (const field of LEGAL_ENTITY_ADDRESS_FIELDS) assert.equal(field in plan.body!, false, `${field} is not asserted without a flag`);
    assert.equal(LEGAL_ENTITY_ADDRESS_FIELDS.length, 9);
    const desired = desiredLegalEntity(null);
    for (const field of LEGAL_ENTITY_ADDRESS_FIELDS) assert.equal(desired[field], null);
  });
  it("with --fiscal-address gijon plans every confirmed field (14), marks NIF and razón social as high risk and puts the registered office in Gijón by default", () => {
    const plan = planLegalEntityPatch(farandaEntity(), "gijon");
    assert.deepEqual(plan.highRiskFields, ["taxId", "legalName"]);
    assert.equal(plan.body!.confirmHighRisk, true);
    assert.equal(plan.body!.legalName, CELUISMA.legalName);
    assert.equal(plan.body!.taxId, CELUISMA.taxId);
    assert.equal(plan.body!.code, "CEL");
    assert.equal(plan.body!.legalForm, "sa");
    assert.equal(plan.body!.cnae, "5510");
    assert.equal(plan.body!.fiscalAddress, "Avenida de Portugal, 7");
    assert.equal(plan.body!.fiscalIneCode, "33024");
    assert.equal(plan.body!.registeredOfficeAddress, "Avenida de Portugal, 7");
    assert.equal(plan.body!.registeredOfficePostalCode, "33207");
    assert.equal(plan.changes.length, 14);
    assert.equal("mercantileRegistry" in plan.body!, false, "unknown registry asserts nothing");
    assert.equal("pgcVariant" in plan.body!, false, "regime fields are César's decision");
    assert.equal("siiEnabled" in plan.body!, false);
    assert.equal("largeCompany" in plan.body!, false);
    assert.equal("fiscalYearStartMonth" in plan.body!, false);
    const changed = plan.changes.filter((c) => c.highRisk).map((c) => c.field).sort();
    assert.deepEqual(changed, ["legalName", "taxId"]);
    assert.deepEqual(plan.changes.find((c) => c.field === "taxId"), { field: "taxId", from: "B99999997", to: "A33615980", highRisk: true });
  });
  it("--fiscal-address florida moves both blocks to Paseo de la Florida 5 unless --registered-office chooses another candidate", () => {
    const florida = planLegalEntityPatch(farandaEntity(), "florida");
    assert.equal(florida.body!.fiscalAddress, "Paseo de la Florida, 5");
    assert.equal(florida.body!.fiscalPostalCode, "28008");
    assert.equal(florida.body!.fiscalIneCode, "28079");
    assert.equal(florida.body!.registeredOfficeAddress, "Paseo de la Florida, 5");
    assert.equal(florida.body!.registeredOfficeMunicipality, "Madrid");
    const mixed = planLegalEntityPatch(farandaEntity(), "florida", "gijon");
    assert.equal(mixed.body!.fiscalMunicipality, "Madrid");
    assert.equal(mixed.body!.registeredOfficeMunicipality, "Gijón");
    assert.equal(mixed.body!.registeredOfficeProvince, "Asturias");
    assert.deepEqual(desiredLegalEntity("madrid").registeredOfficePostalCode, "28003");
    assert.deepEqual(desiredLegalEntity("madrid", "florida").registeredOfficePostalCode, "28008");
    const registeredOnly = planLegalEntityPatch(farandaEntity(), null, "gijon");
    assert.equal(registeredOnly.body!.registeredOfficeAddress, "Avenida de Portugal, 7");
    assert.equal("fiscalAddress" in registeredOnly.body!, false);
  });
  it("is idempotent: planning over the post-state yields no body, a same-value NIF (normalised) is not a change, and choosing the domicile later is a low-risk patch of the 9 address columns only", () => {
    const first = planLegalEntityPatch(farandaEntity(), null);
    const after = applyLegalEntityPatchToRow(farandaEntity(), first.body);
    assert.equal(after.taxId, "A33615980");
    assert.equal(after.code, "CEL");
    assert.equal(after.fiscalAddress, null, "no domicile written without the flag");
    const second = planLegalEntityPatch(after, null);
    assert.equal(second.body, null);
    assert.deepEqual(second.changes, []);
    const spaced = planLegalEntityPatch({ ...after, taxId: " es-a33615980 " }, null);
    assert.equal(spaced.body, null);
    const later = planLegalEntityPatch(after, "florida");
    assert.deepEqual(later.highRiskFields, []);
    assert.equal(later.body!.confirmHighRisk, undefined);
    assert.deepEqual(Object.keys(later.body!).sort(), [...LEGAL_ENTITY_ADDRESS_FIELDS].sort());
    const settled = applyLegalEntityPatchToRow(after, later.body);
    assert.equal(planLegalEntityPatch(settled, "florida").body, null);
    // Switching the fiscal address afterwards touches only the fiscal block (Gijón changes all five columns; General Ampudia only street and CP).
    const moved = planLegalEntityPatch(settled, "gijon", "florida");
    assert.deepEqual(Object.keys(moved.body!).sort(), ["fiscalAddress", "fiscalIneCode", "fiscalMunicipality", "fiscalPostalCode", "fiscalProvince"]);
    assert.deepEqual(Object.keys(planLegalEntityPatch(settled, "madrid", "florida").body!).sort(), ["fiscalAddress", "fiscalPostalCode"]);
  });
});

// ── Step 3 · Census fill ──────────────────────────────────────────────────────

describe("planCensusFill (RA / LT, fill-only)", () => {
  it("fills the empty census columns of both centres from the REAT: RA 3★ · 196 plazas · H-CO-000713, LT 4★ · 176 plazas · H-CO-001327", () => {
    const lt = planCensusFill(LOS_TILOS_PROPERTY_ID, { starRating: null, bedCapacity: null, tourismRegistryNumber: null });
    assert.deepEqual(lt.patch, { starRating: 4, bedCapacity: 176, tourismRegistryNumber: "H-CO-001327" });
    assert.equal(lt.code, "LT");
    const ra = planCensusFill(RIAS_ALTAS_PROPERTY_ID, { starRating: null, bedCapacity: null, tourismRegistryNumber: null });
    assert.deepEqual(ra.patch, { starRating: 3, bedCapacity: 196, tourismRegistryNumber: "H-CO-000713" });
    assert.deepEqual(Object.keys(EXISTING_CENTRE_CENSUS[RIAS_ALTAS_PROPERTY_ID]!.census).sort(), ["bedCapacity", "starRating", "tourismRegistryNumber"]);
    assert.equal(RIAS_ALTAS_REAT_ROOMS, 103, "rooms are NOT part of the census fill: the 120 demo rooms are an open item");
  });
  it("never overwrites: equal values are skips, different values are conflicts, and the post-state plans nothing", () => {
    const same = planCensusFill(LOS_TILOS_PROPERTY_ID, { starRating: 4, bedCapacity: 176, tourismRegistryNumber: "H-CO-001327" });
    assert.equal(same.patch, null);
    assert.deepEqual(same.same.sort(), ["bedCapacity", "starRating", "tourismRegistryNumber"]);
    const conflict = planCensusFill(LOS_TILOS_PROPERTY_ID, { starRating: 3, bedCapacity: null, tourismRegistryNumber: null });
    assert.deepEqual(conflict.patch, { bedCapacity: 176, tourismRegistryNumber: "H-CO-001327" });
    assert.deepEqual(conflict.conflicts, [{ field: "starRating", current: 3, desired: 4 }]);
    const raSame = planCensusFill(RIAS_ALTAS_PROPERTY_ID, { starRating: 3, bedCapacity: 196, tourismRegistryNumber: "H-CO-000713" });
    assert.equal(raSame.patch, null);
    assert.throws(() => planCensusFill("prop_123", {}), /sin censo previsto/);
  });
});

// ── Step 6 · Series of Rías Altas ─────────────────────────────────────────────

describe("planRiasAltasSeries", () => {
  it("closes FAC-2026- / REC-2026- (renamed *-SANDBOX, counters intact) and opens FAC-RA-2026- / REC-RA-2026- / FS-RA-2026-", () => {
    const plan = planRiasAltasSeries(farandaSeries());
    assert.deepEqual(
      plan.close.map((c) => [c.sequenceCode, c.prefix, c.nextNumber, c.toSequenceCode]),
      [["FAC", "FAC-2026-", 23, `FAC${SANDBOX_SERIES_SUFFIX}`], ["REC", "REC-2026-", 4, `REC${SANDBOX_SERIES_SUFFIX}`]]
    );
    assert.deepEqual(plan.open.map((o) => [o.sequenceCode, o.invoiceType, o.prefix, o.action]), [
      ["FAC", "F1", "FAC-RA-2026-", "create"],
      ["REC", "R1", "REC-RA-2026-", "create"],
      ["SIM", "F2", "FS-RA-2026-", "create"]
    ]);
    assert.deepEqual(plan.skip, []);
    assert.deepEqual(plan.blocked, []);
    assert.equal(RIAS_ALTAS_TARGET_SERIES.length, 3);
    assert.equal(SERIES_YEAR, 2026);
    // The rectificativa series follows the LT / validator convention REC-<COD>-2026- (the design's «R-<COD>-2026-» is a naming slip).
    assert.equal(RIAS_ALTAS_TARGET_SERIES.find((s) => s.invoiceType === "R1")!.prefix, "REC-RA-2026-");
  });
  it("leaves Los Tilos alone and is idempotent over the post-state (0 close, 0 open, 3 skips)", () => {
    const first = planRiasAltasSeries(farandaSeries());
    const after = applySeriesPlanToRows(farandaSeries(), first);
    assert.equal(after.filter((r) => r.propertyId === LOS_TILOS_PROPERTY_ID && r.active).length, 2);
    assert.equal(after.find((r) => r.id === "cmrhylncn000mfy69dd2ogb01")!.sequenceCode, "FAC-SANDBOX");
    assert.equal(after.find((r) => r.id === "cmrhylncn000mfy69dd2ogb01")!.nextNumber, 23, "never renumbered");
    assert.equal(after.find((r) => r.id === "cmrhylncn000mfy69dd2ogb01")!.prefix, "FAC-2026-", "prefix kept");
    const second = planRiasAltasSeries(after);
    assert.deepEqual(second.close, []);
    assert.deepEqual(second.open, []);
    assert.equal(second.skip.length, 3);
    assert.deepEqual(second.blocked, []);
  });
  it("re-opens a closed coded series and blocks a foreign prefix or an existing *-SANDBOX row instead of overwriting", () => {
    const rows = farandaSeries();
    const closedCoded: SeriesRow = { id: "seq_x", propertyId: RIAS_ALTAS_PROPERTY_ID, sequenceCode: "SIM", invoiceType: "F2", prefix: "FS-RA-2026-", year: 2026, nextNumber: 5, padding: 6, active: false };
    const reopen = planRiasAltasSeries([...rows, closedCoded]);
    assert.deepEqual(reopen.open.find((o) => o.sequenceCode === "SIM"), { sequenceCode: "SIM", invoiceType: "F2", prefix: "FS-RA-2026-", action: "reopen", existingId: "seq_x" });
    const foreign = planRiasAltasSeries([...rows, { ...closedCoded, prefix: "FS-XX-2026-", active: true }]);
    assert.equal(foreign.open.some((o) => o.sequenceCode === "SIM"), false);
    assert.match(foreign.blocked[0]!, /FS-XX-2026-/);
    const taken = planRiasAltasSeries([...rows, { ...closedCoded, id: "seq_y", sequenceCode: "FAC-SANDBOX", prefix: "FAC-2025-" }]);
    assert.equal(taken.close.some((c) => c.sequenceCode === "FAC"), false);
    assert.match(taken.blocked[0]!, /FAC-SANDBOX/);
  });
});

// ── Step 8 · Installations (deferred until activation; sandbox filler opt-in) ──

describe("planSandboxInstallations", () => {
  const centres: CentreForInstallation[] = [
    { id: RIAS_ALTAS_PROPERTY_ID, code: "RA", kind: "hotel", hasActiveInstallation: true, verifactuEnabled: false },
    { id: LOS_TILOS_PROPERTY_ID, code: "LT", kind: "hotel", hasActiveInstallation: false, verifactuEnabled: false },
    { id: "new:PG", code: "PG", kind: "hotel", hasActiveInstallation: false, verifactuEnabled: false },
    { id: "new:OC", code: "OC", kind: "office", hasActiveInstallation: false, verifactuEnabled: false }
  ];
  it("by default DEFERS every hotel with verifactuEnabled = false (design §5.5 step 8: opened at activation): 0 creates, RA keeps DEV-001, the office has none, no filler warning", () => {
    const plan = planSandboxInstallations({ centres, mode: "sandbox", chainScope: "per_center", takenNumbers: [SANDBOX_INSTALL_NUMBER] });
    assert.deepEqual(plan.create, []);
    assert.deepEqual(plan.deferred.map((d) => d.split(":")[0]), ["LT", "PG"]);
    assert.match(plan.deferred[0]!, /verifactuEnabled=false/);
    assert.match(plan.deferred[0]!, /--sandbox-installations/);
    assert.equal(plan.skip.length, 2);
    assert.deepEqual(plan.pending, []);
    assert.deepEqual(plan.warnings, []);
  });
  it("opens the sandbox filler for a hotel ALREADY enabled and without installation (DEV-001-<CODE>, suffixed when taken), and for the disabled ones only with the opt-in", () => {
    const enabled = centres.map((c) => (c.code === "LT" ? { ...c, verifactuEnabled: true } : c));
    const plan = planSandboxInstallations({ centres: enabled, mode: "sandbox", chainScope: "per_center", takenNumbers: [SANDBOX_INSTALL_NUMBER] });
    assert.deepEqual(plan.create.map((c) => [c.code, c.numeroInstalacion]), [["LT", "DEV-001-LT"]]);
    assert.deepEqual(plan.deferred.map((d) => d.split(":")[0]), ["PG"]);
    assert.equal(plan.warnings[0]!.code, "INSTALLATION_NUMBER_SANDBOX_DEFAULT");
    assert.match(plan.warnings[0]!.message, /numero_instalacion LIKE 'DEV-%'/, "the warning carries the pre-preproduction check");
    const optIn = planSandboxInstallations({ centres, mode: "sandbox", chainScope: "per_center", takenNumbers: [SANDBOX_INSTALL_NUMBER], fillerForDisabled: true });
    assert.deepEqual(optIn.create.map((c) => [c.code, c.numeroInstalacion]), [["LT", "DEV-001-LT"], ["PG", "DEV-001-PG"]]);
    assert.deepEqual(optIn.deferred, []);
    const suffixed = planSandboxInstallations({ centres, mode: "sandbox", chainScope: "per_center", takenNumbers: [SANDBOX_INSTALL_NUMBER, "DEV-001-LT"], fillerForDisabled: true });
    assert.equal(suffixed.create.find((c) => c.code === "LT")!.numeroInstalacion, "DEV-001-LT2");
  });
  it("outside sandbox opens nothing (real numbers are César's): enabled hotels are pending, disabled ones deferred; with per_entity it steps aside", () => {
    const enabled = centres.map((c) => ({ ...c, verifactuEnabled: c.kind === "hotel" }));
    for (const mode of ["preproduction", "production"] as const) {
      const plan = planSandboxInstallations({ centres: enabled, mode, chainScope: "per_center", takenNumbers: [] });
      assert.deepEqual(plan.create, []);
      assert.equal(plan.pending.length, 2);
      assert.match(plan.pending[0]!, new RegExp(mode));
      const optIn = planSandboxInstallations({ centres, mode, chainScope: "per_center", takenNumbers: [], fillerForDisabled: true });
      assert.deepEqual(optIn.create, [], "the opt-in never opens a filler outside sandbox");
      assert.equal(optIn.pending.length, 2);
    }
    const entity = planSandboxInstallations({ centres, mode: "sandbox", chainScope: "per_entity", takenNumbers: [] });
    assert.deepEqual(entity.create, []);
    assert.match(entity.warnings[0]!.message, /per_entity/);
  });
  it("is idempotent: once every hotel has an active installation nothing is planned, deferred or pending", () => {
    const converged = centres.map((c) => ({ ...c, hasActiveInstallation: c.kind === "hotel", verifactuEnabled: true }));
    const plan = planSandboxInstallations({ centres: converged, mode: "sandbox", chainScope: "per_center", takenNumbers: ["DEV-001", "DEV-001-LT", "DEV-001-PG"], fillerForDisabled: true });
    assert.deepEqual(plan.create, []);
    assert.deepEqual(plan.deferred, []);
    assert.deepEqual(plan.pending, []);
    assert.deepEqual(plan.warnings, []);
  });
});

// ── Cross-batch prefix clashes ────────────────────────────────────────────────

describe("plannedActiveSeries + detectBatchPrefixClashes (0 colisiones)", () => {
  it("the whole batch (RA coded, LT, five hotels) leaves 0 active prefix clashes under the sociedad", () => {
    const seriesPlan = planRiasAltasSeries(farandaSeries());
    const rows = plannedActiveSeries({ existing: farandaSeries(), seriesPlan, specs: batch });
    // 2 LT + 3 RA + 5 hotels × 3 = 20 (the office bills nothing; the closed sandbox rows are out).
    assert.equal(rows.length, 20);
    assert.equal(rows.some((r) => r.prefix === "FAC-2026-"), false, "sandbox series closed");
    assert.deepEqual(detectBatchPrefixClashes(rows), []);
    const prefixes = rows.map((r) => `${r.prefix}|${r.year}`);
    assert.equal(new Set(prefixes).size, prefixes.length);
  });
  it("detects a clash when a hotel spec reuses another centre's prefix or when the RA sandbox series were not closed", () => {
    const seriesPlan = planRiasAltasSeries(farandaSeries());
    const dup = structuredClone(specs.hotels[0]!.spec);
    dup.invoiceSequences[0]!.prefix = "FAC-LT-2026-";
    const clashes = detectBatchPrefixClashes(plannedActiveSeries({ existing: farandaSeries(), seriesPlan, specs: [dup] }));
    assert.equal(clashes.length, 1);
    assert.equal(clashes[0]!.code, "SERIES_PREFIX_CLASH");
    assert.match(clashes[0]!.message, /FAC-LT-2026-/);
    // Without the close step a second hotel opening FAC-2026- would collide with RA.
    const noClose = { close: [], open: [], skip: [], blocked: [] };
    const legacy = structuredClone(specs.hotels[1]!.spec);
    legacy.invoiceSequences[0]!.prefix = "FAC-2026-";
    assert.equal(detectBatchPrefixClashes(plannedActiveSeries({ existing: farandaSeries(), seriesPlan: noClose, specs: [legacy] })).length, 1);
  });
});

// ── Audit flush on every exit (l8#2) ──────────────────────────────────────────

describe("finalizeSummary · the audit queue reaches Postgres on the happy path AND on a failed step", () => {
  it("awaits flushAuditQueues for --apply, records it in summary.audit and stamps durationMs", async () => {
    let flushed = 0;
    const flusher = { flushAuditQueues: async () => { flushed += 1; } };
    const ok = await finalizeSummary(emptySummary(false), Date.now() - 5, flusher);
    assert.equal(flushed, 1);
    assert.deepEqual(ok.audit, { flushed: true, error: null });
    assert.ok(ok.durationMs >= 5);
    const failed = emptySummary(false);
    failed.steps[0]!.status = "failed";
    failed.steps[0]!.errors.push("PG: conflicto");
    failed.totals.errors = 1;
    await finalizeSummary(failed, Date.now(), flusher);
    assert.equal(flushed, 2, "a failed step exits through the same flush");
    assert.equal(failed.audit.flushed, true);
  });
  it("in dry-run there is nothing to flush (audit null) and the summary stays null; a flush failure never hides the summary", async () => {
    const dry = await finalizeSummary(emptySummary(true), Date.now(), null);
    assert.deepEqual(dry.audit, { flushed: null, error: null });
    const broken = { flushAuditQueues: async () => { throw new Error("pg down"); } };
    const originalError = console.error;
    const logged: string[] = [];
    console.error = (...args: unknown[]) => { logged.push(args.map(String).join(" ")); };
    try {
      const summary = await finalizeSummary(emptySummary(false), Date.now(), broken);
      assert.deepEqual(summary.audit, { flushed: false, error: "pg down" });
      assert.match(summary.steps.at(-1)!.warnings[0]!, /cola de auditoría/);
      assert.match(summary.steps.at(-1)!.warnings[0]!, new RegExp(CORRELATION_ID));
      assert.ok(logged.some((l) => /audit flush failed: pg down/.test(l)));
    } finally {
      console.error = originalError;
    }
  });
  it("source contract: runMigration has no bare `return summary`, every early exit returns finalize(), and the entry .catch flushes before disconnecting", () => {
    const source = readFileSync(SCRIPT_PATH, "utf8");
    const runner = source.slice(source.indexOf("export async function runMigration("), source.indexOf("export type AuditFlusher"));
    assert.equal(/return summary;/.test(runner), false, "no exit bypasses finalize()");
    const earlyExits = runner.match(/if \(!done\([^)]*\)[^\n]*\) return [a-zA-Z]+\(\);/g) ?? [];
    assert.ok(earlyExits.length >= 8, `found ${earlyExits.length} early exits`);
    for (const exit of earlyExits) assert.match(exit, /return finalize\(\);/);
    assert.equal(/return finish\(\)/.test(source), false, "the old finish() helper is gone");
    const entryCatch = source.slice(source.lastIndexOf(".catch(async (error) => {"));
    assert.match(entryCatch, /flushAuditForExit\(flags\.apply\)/);
    assert.ok(entryCatch.indexOf("flushAuditForExit") < entryCatch.indexOf("prisma.$disconnect"), "flush happens before the disconnect");
    assert.match(source, /runbook §17\.13/);
    assert.equal(/§17\.12/.test(source), false, "no stale runbook reference");
  });
});

// ── Output helpers ────────────────────────────────────────────────────────────

describe("formatCentreTable / openDecisions", () => {
  it("prints a markdown table with one row per centre", () => {
    const lines = formatCentreTable([
      { code: "RA", kind: "hotel", name: "Rías Altas", municipality: "Perillo (Oleiros)", province: "A Coruña", stars: 3, rooms: 103, series: ["FAC-RA-2026-"], installation: "DEV-001", action: "existe", propertyId: RIAS_ALTAS_PROPERTY_ID },
      { code: "OC", kind: "office", name: "Oficina central", municipality: "Madrid", province: "Madrid", stars: null, rooms: 0, series: [], installation: null, action: "crear", propertyId: null }
    ]);
    assert.equal(lines.length, 4);
    assert.match(lines[0]!, /^\| Código/);
    assert.match(lines[2]!, /RA .*hotel.*FAC-RA-2026-.*DEV-001.*existe/);
    assert.match(lines[3]!, /OC .*office.*—.*crear/);
  });
  it("lists the decisions only César can take with the public evidence (RM de Madrid, 62 empleados → PGC general probable, 120 vs 103 rooms of RA), parametrised by the chosen addresses", () => {
    const snapshot = {
      legalEntity: farandaEntity(),
      properties: [{ id: RIAS_ALTAS_PROPERTY_ID, code: "RA", address: "Paseo Marítimo, 1" }],
      vatSettings: false,
      fiscalYears: 0,
      siiFlaggedProperties: [RIAS_ALTAS_PROPERTY_ID]
    } as unknown as MigrationSnapshot;
    const undecided = openDecisions(snapshot, { officeCity: "gijon", fiscalAddress: null, registeredOffice: null }, { roomsByProperty: new Map([[RIAS_ALTAS_PROPERTY_ID, 120]]) });
    assert.ok(undecided.length >= 14);
    assert.match(undecided[0]!, /SIN DECIDIR/);
    assert.match(undecided[0]!, /--apply exige --fiscal-address/);
    for (const key of ADDRESS_OPTION_KEYS) assert.ok(undecided[0]!.includes(describeAddress(key)), `decision 1 lists ${key}`);
    assert.match(undecided[0]!, /Registro Mercantil de MADRID/);
    assert.match(undecided[1]!, /«gijon»/);
    assert.match(undecided[1]!, /madrid\|gijon\|florida/);
    assert.match(undecided[2]!, /de MADRID según Empresia y eInforma/);
    assert.match(undecided[2]!, /tomo \/ folio \/ hoja/);
    assert.match(undecided[3]!, /62 empleados/);
    assert.match(undecided[3]!, /4\.735\.729,75/);
    assert.match(undecided[3]!, /PGC GENERAL probable/);
    assert.ok(undecided.some((i) => /sii_enabled residual .*1 centro\/s: RA/.test(i)));
    assert.ok(undecided.some((i) => /Paseo Marítimo, 1/.test(i) && /Américas 57/.test(i)));
    assert.ok(undecided.some((i) => /120 habitaciones vendibles/.test(i) && /103 según el REAT H-CO-000713/.test(i)));
    assert.ok(undecided.some((i) => /al activar VeriFactu en cada centro/.test(i)));
    assert.ok(undecided.some((i) => /6\.010\.121,04/.test(i)));
    assert.ok(undecided.some((i) => /org_123/.test(i)));
    const decided = openDecisions(snapshot, { officeCity: "madrid", fiscalAddress: "florida", registeredOffice: null });
    assert.match(decided[0]!, /se aplica «florida» \(Paseo de la Florida, 5, Madrid\)/);
    assert.match(decided[0]!, /domicilio SOCIAL «florida»/);
    const mixed = openDecisions(snapshot, { officeCity: "madrid", fiscalAddress: "madrid", registeredOffice: "gijon" });
    assert.match(mixed[0]!, /domicilio SOCIAL «gijon» \(Avenida de Portugal, 7, Gijón\)/);
    assert.equal(/Calle Portugal/.test(mixed.join("\n")), false, "the invented street type is gone");
  });
  it("the eight expected centre codes are all 2-letter upper-case codes and include the seven hotels plus the office", () => {
    for (const code of EXPECTED_CENTRE_CODES) assert.match(code, /^[A-Z]{2}$/);
    assert.ok(batch.every((spec) => isHotelKind(spec.property.kind) || spec.property.code === OFFICE_CODE));
  });
});
