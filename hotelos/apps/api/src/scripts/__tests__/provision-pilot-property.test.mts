// Pure unit tests for the pilot property provisioning CLI. No database: flag
// parsing, spec validation, deterministic room numbering, convergence diff
// and the plan summary. Run from apps/api:
//   node --import tsx --test src/scripts/__tests__/provision-pilot-property.test.mts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import {
  assertConfirmMatches,
  assertFiscalLocationCoherent,
  assertInvoiceSequenceCoherent,
  diffConverge,
  parseFlags,
  planRoomCapacityFill,
  planRooms,
  sameValue,
  splitProfile,
  stableStringify,
  summarizePlan,
  USAGE,
  validateSpec,
  type PilotSpec,
  type ProvisionPlan
} from "../provision-pilot-property.js";

const here = dirname(fileURLToPath(import.meta.url));
const SPEC_PATH = resolve(here, "../specs/faranda-los-tilos.json");
const ORG = "cmrhw9jy30002fyvb6tsdiugt";

function rawSpec(): Record<string, unknown> {
  return JSON.parse(readFileSync(SPEC_PATH, "utf8")) as Record<string, unknown>;
}

function mutate(fn: (raw: Record<string, any>) => void): Record<string, unknown> {
  const raw = rawSpec() as Record<string, any>;
  fn(raw);
  return raw;
}

describe("parseFlags", () => {
  it("defaults to dry-run with the spec path", () => {
    const flags = parseFlags(["--spec", "x.json"]);
    assert.deepEqual(flags, { spec: "x.json", apply: false, confirm: null, json: false, help: false });
  });
  it("--help / -h short-circuit every other validation and USAGE names every flag", () => {
    assert.equal(parseFlags(["--help"]).help, true);
    assert.equal(parseFlags(["-h"]).help, true);
    assert.equal(parseFlags(["--apply", "--help"]).help, true, "no --confirm/--spec error when help is requested");
    assert.equal(parseFlags(["--spec", "x.json"]).help, false);
    for (const flag of ["--spec", "--dry-run", "--apply", "--confirm", "--json", "--help"]) assert.ok(USAGE.includes(flag), `USAGE mentions ${flag}`);
  });
  it("accepts --dry-run and --json explicitly", () => {
    const flags = parseFlags(["--spec", "x.json", "--dry-run", "--json"]);
    assert.equal(flags.apply, false);
    assert.equal(flags.json, true);
  });
  it("--apply requires --confirm", () => {
    assert.throws(() => parseFlags(["--spec", "x.json", "--apply"]), /--confirm/);
  });
  it("--apply --confirm <orgId> is accepted and checked against the spec organisation", () => {
    const flags = parseFlags(["--spec", "x.json", "--apply", "--confirm", ORG]);
    assert.equal(flags.apply, true);
    assert.equal(flags.confirm, ORG);
    assert.doesNotThrow(() => assertConfirmMatches(flags, ORG));
    assert.throws(() => assertConfirmMatches(flags, "org_123"), /does not match/);
  });
  it("assertConfirmMatches is a no-op in dry-run", () => {
    assert.doesNotThrow(() => assertConfirmMatches(parseFlags(["--spec", "x.json"]), "anything"));
  });
  it("--dry-run and --apply are mutually exclusive", () => {
    assert.throws(() => parseFlags(["--spec", "x.json", "--dry-run", "--apply", "--confirm", ORG]), /mutually exclusive/);
  });
  it("rejects unknown flags, a missing --spec, a dangling value and --confirm without --apply", () => {
    assert.throws(() => parseFlags(["--spec", "x.json", "--force"]), /Unknown flag/);
    assert.throws(() => parseFlags([]), /--spec/);
    assert.throws(() => parseFlags(["--spec"]), /requires a value/);
    assert.throws(() => parseFlags(["--spec", "x.json", "--confirm", ORG]), /only makes sense with --apply/);
  });
});

describe("validateSpec", () => {
  it("accepts the Faranda Los Tilos spec", () => {
    const spec = validateSpec(rawSpec());
    assert.equal(spec.organizationId, ORG);
    assert.equal(spec.property.name, "Faranda Los Tilos, Ascend Hotel Collection");
    assert.equal(spec.property.legalName, null);
    assert.equal(spec.totalRooms, 92);
    assert.equal(spec.roomTypes.items.length, 4);
    assert.equal(spec.roomTypes._estimated, true);
    assert.equal(spec.invoiceSequences[0]!.padding, 6);
  });
  it("rejects a postal code and INE code from different provinces", () => {
    assert.throws(() => validateSpec(mutate((r) => (r.property.ineMunicipalityCode = "27001"))), /provincias distintas/);
    assert.throws(() => assertFiscalLocationCoherent("15894", "27001"), /provincias distintas/);
    assert.throws(() => assertFiscalLocationCoherent("1589", "15082"), /Código postal no válido/);
    assert.throws(() => assertFiscalLocationCoherent("99001", "99001"), /Código postal no válido/);
    assert.throws(() => assertFiscalLocationCoherent("15894", "15A82"), /Código INE/);
    assert.doesNotThrow(() => assertFiscalLocationCoherent("15894", "15082"));
    assert.doesNotThrow(() => assertFiscalLocationCoherent(null, null));
  });
  it("rejects when Σ roomTypes.count ≠ totalRooms", () => {
    assert.throws(() => validateSpec(mutate((r) => (r.totalRooms = 93))), /Σ roomTypes.count = 92 ≠ totalRooms = 93/);
    assert.throws(() => validateSpec(mutate((r) => (r.roomTypes.items[1].count = 40))), /Σ roomTypes.count = 91/);
  });
  it("rejects a total not divisible by the floors when no explicit rooming list is given", () => {
    assert.throws(() => validateSpec(mutate((r) => (r.building.floors = 5))), /no es divisible/);
  });
  it("rejects a non-canonical tax region, unknown modules and bad invoice series", () => {
    assert.throws(() => validateSpec(mutate((r) => (r.property.taxRegion = "peninsula"))), /Región fiscal no canónica/);
    assert.throws(() => validateSpec(mutate((r) => r.modules.push("teleport"))), /Módulos desconocidos/);
    assert.throws(() => validateSpec(mutate((r) => (r.invoiceSequences[0].invoiceType = "R1"))), /serie FAC no admite/);
    assert.throws(() => validateSpec(mutate((r) => (r.invoiceSequences[0].prefix = "FAC-LT-2025-"))), /lleva el año 2025/);
    assert.throws(() => assertInvoiceSequenceCoherent({ sequenceCode: "REC", invoiceType: "F1", prefix: "REC-LT-2026-", year: 2026 }), /serie REC no admite/);
    assert.throws(() => assertInvoiceSequenceCoherent({ sequenceCode: "FAC", invoiceType: "X9", prefix: "FAC-", year: 2026 }), /Tipo de factura no válido/);
  });
  it("rejects a room list whose per-type totals disagree with the counts", () => {
    const raw = mutate((r) => {
      r.rooms = Array.from({ length: 92 }, (_, i) => ({ number: String(101 + i), roomTypeCode: "DBL" }));
    });
    // Reported in spec order: IND is the first type whose count is not honoured.
    assert.throws(() => validateSpec(raw), /el tipo IND recibe 0 habitaciones pero el spec declara count 8/);
  });
  it("rejects malformed shapes with a path in the message", () => {
    assert.throws(() => validateSpec(mutate((r) => delete r.property.name)), /Spec inválido: property.name/);
    assert.throws(() => validateSpec(mutate((r) => (r.owners = []))), /owners/);
  });
});

describe("planRooms", () => {
  const spec = validateSpec(rawSpec());
  const rooms = planRooms(spec);
  const byType = (code: string) => rooms.filter((r) => r.roomTypeCode === code).map((r) => r.number);

  it("produces 92 unique numbers over 4 floors × 23", () => {
    assert.equal(rooms.length, 92);
    assert.equal(new Set(rooms.map((r) => r.number)).size, 92);
    for (let f = 1; f <= 4; f++) {
      const floor = rooms.filter((r) => r.floorNumber === f).map((r) => r.number);
      assert.equal(floor.length, 23);
      assert.equal(floor[0], `${f}01`);
      assert.equal(floor.at(-1), `${f}23`);
    }
  });
  it("assigns 8 / 41 / 40 / 3 per type", () => {
    assert.equal(byType("IND").length, 8);
    assert.equal(byType("DBL").length, 41);
    assert.equal(byType("DBM").length, 40);
    assert.equal(byType("SUI").length, 3);
  });
  it("puts suites in 223 / 323 / 423 and singles in x01 / x02", () => {
    assert.deepEqual(byType("SUI").sort(), ["223", "323", "423"]);
    assert.deepEqual(byType("IND").sort(), ["101", "102", "201", "202", "301", "302", "401", "402"]);
  });
  it("alternates DBL (odd) / DBM (even) deterministically on the remaining rooms", () => {
    for (const n of byType("DBL")) assert.equal(Number(n) % 2, 1, `DBL ${n} should be odd`);
    for (const n of byType("DBM")) assert.equal(Number(n) % 2, 0, `DBM ${n} should be even`);
    assert.ok(byType("DBL").includes("123"), "123 stays a double on the ground floor (no suite there)");
    assert.deepEqual(planRooms(spec), rooms, "stable across calls");
  });
  it("honours an explicit rooming list verbatim", () => {
    const explicit = validateSpec(
      mutate((r) => {
        r.rooms = planRooms(validateSpec(rawSpec())).map((x) => ({ number: x.number, roomTypeCode: x.roomTypeCode }));
        r.rooms[0].number = "A1";
        r.rooms[0].floorNumber = 1;
      })
    );
    const planned = planRooms(explicit);
    assert.equal(planned[0]!.number, "A1");
    assert.equal(planned[0]!.floorNumber, 1);
    assert.equal(planned.length, 92);
  });
  it("fails loudly when the counts cannot be honoured by the rule", () => {
    const bad = { ...spec, roomTypes: { items: spec.roomTypes.items.map((t) => (t.code === "IND" ? { ...t, count: 7 } : t.code === "DBL" ? { ...t, count: 42 } : t)) } };
    assert.throws(() => planRooms(bad), /IND: count 7 no es divisible entre 4 plantas/);
  });
});

describe("diffConverge", () => {
  it("fills empty fields, skips equal ones and reports different ones as conflicts", () => {
    const diff = diffConverge(
      { address: null, municipality: "", province: "A Coruña", postalCode: "15172", verifactuEnabled: false, timezone: "Europe/Madrid" },
      { address: "Urbanización Los Tilos", municipality: "Teo", province: "A Coruña", postalCode: "15894", verifactuEnabled: false, timezone: "Europe/Madrid", legalName: null }
    );
    assert.deepEqual(diff.fill, { address: "Urbanización Los Tilos", municipality: "Teo" });
    assert.deepEqual(diff.same.sort(), ["province", "timezone", "verifactuEnabled"]);
    assert.deepEqual(diff.conflicts, [{ field: "postalCode", current: "15172", desired: "15894" }]);
  });
  it("treats a differing boolean as a conflict and a desired null as nothing to assert", () => {
    const diff = diffConverge({ sesHospedajesEnabled: true, legalName: "X" }, { sesHospedajesEnabled: false, legalName: null });
    assert.deepEqual(diff.conflicts, [{ field: "sesHospedajesEnabled", current: true, desired: false }]);
    assert.deepEqual(diff.fill, {});
  });
});

describe("stableStringify / sameValue (jsonb key order)", () => {
  // What Postgres jsonb hands back for Los Tilos: shorter keys first, then
  // bytewise — nothing like the spec's order. Nested objects are reordered too.
  const fromDb = {
    built: 1982,
    email: "reservas.tilos@farandahotels.com",
    hasBar: true,
    plazas: 176,
    starRating: 4,
    coordinates: { lat: 42.84644, lon: -8.54075 },
    tourismRegistry: { number: "H-CO-001327", region: "Galicia", source: "https://x", registry: "REAT", verifiedAt: "2026-09-14" },
    brandAffiliation: "Ascend"
  };
  const fromSpec = {
    starRating: 4,
    brandAffiliation: "Ascend",
    tourismRegistry: { registry: "REAT", number: "H-CO-001327", region: "Galicia", verifiedAt: "2026-09-14", source: "https://x" },
    plazas: 176,
    email: "reservas.tilos@farandahotels.com",
    coordinates: { lon: -8.54075, lat: 42.84644 },
    hasBar: true,
    built: 1982
  };
  it("compares equal when only the key order (top-level and nested) differs", () => {
    assert.notEqual(JSON.stringify(fromDb), JSON.stringify(fromSpec), "the naive comparison is what produced the false conflict");
    assert.equal(stableStringify(fromDb), stableStringify(fromSpec));
    assert.equal(sameValue(fromDb, fromSpec), true);
    const diff = diffConverge({ pilotProfile: fromDb }, { pilotProfile: fromSpec });
    assert.deepEqual(diff.same, ["pilotProfile"]);
    assert.deepEqual(diff.conflicts, []);
  });
  it("still detects a real difference, keeps array order meaningful and drops undefined like JSON does", () => {
    assert.equal(sameValue(fromDb, { ...fromSpec, starRating: 3 }), false);
    assert.equal(sameValue(fromDb, { ...fromSpec, coordinates: { lat: 0, lon: -8.54075 } }), false);
    assert.equal(sameValue([1, 2], [2, 1]), false);
    assert.equal(sameValue({ a: 1, b: undefined }, { a: 1 }), true);
    assert.equal(sameValue({ a: new Date("2026-09-14T00:00:00.000Z") }, { a: "2026-09-14T00:00:00.000Z" }), true, "toJSON honoured");
    assert.equal(sameValue("x", "x"), true);
    assert.equal(sameValue(1, "1"), false);
    assert.equal(sameValue(null, null), true);
  });
});

describe("planRoomCapacityFill", () => {
  const type = { maxOccupancy: 3, baseCapacity: 2 };
  it("fills only the NULL columns from the room type", () => {
    assert.deepEqual(planRoomCapacityFill({ maxOccupancy: null, standardOccupancy: null }, type), { maxOccupancy: 3, standardOccupancy: 2 });
    assert.deepEqual(planRoomCapacityFill({ maxOccupancy: 2, standardOccupancy: null }, type), { standardOccupancy: 2 });
    assert.deepEqual(planRoomCapacityFill({ maxOccupancy: null, standardOccupancy: 1 }, type), { maxOccupancy: 3 });
  });
  it("never overwrites a non-null value, even one that differs from the type, and needs a type", () => {
    assert.equal(planRoomCapacityFill({ maxOccupancy: 1, standardOccupancy: 1 }, type), null);
    assert.equal(planRoomCapacityFill({ maxOccupancy: null, standardOccupancy: null }, null), null);
    assert.equal(planRoomCapacityFill({ maxOccupancy: null, standardOccupancy: null }, undefined), null);
  });
});

describe("splitProfile", () => {
  it("keeps only CompliancePropertyProfile columns and sends the rest to pilotProfile", () => {
    const spec = validateSpec(rawSpec());
    const { columns, pilotProfile } = splitProfile(spec.profile);
    assert.deepEqual(Object.keys(columns).sort(), ["autonomousCommunity", "buildingProtected", "hasEvents", "hasKitchen", "hasLaundry", "hasParking", "hasPool", "hasRestaurant", "hasSpa", "hasTerrace", "hotelType"]);
    assert.equal(columns.hasRestaurant, true);
    assert.equal(columns.hasSpa, false);
    assert.equal(pilotProfile.starRating, 4);
    assert.equal(pilotProfile.hasBar, true);
    assert.equal((pilotProfile.tourismRegistry as { number: string }).number, "H-CO-001327");
    assert.equal("hotelType" in pilotProfile, false);
  });
});

describe("summarizePlan", () => {
  function newPropertyPlan(spec: PilotSpec): ProvisionPlan {
    return {
      organization: { id: ORG, name: "Faranda Hotels & Resorts" },
      property: { existingId: null, create: { organizationId: ORG, name: spec.property.name }, fill: {}, conflicts: [] },
      owners: { create: spec.owners, skip: 0 },
      departments: [{ code: "MGMT", name: "Management", existingId: null, users: [{ userId: spec.owners[0]!.userId, roleLabel: "owner", action: "create" }] }],
      modules: spec.modules.map((code) => ({ code, moduleId: `mod_${code}`, materialize: false, action: "create" as const })),
      building: { existingId: null, create: true, floors: [1, 2, 3, 4].map((floorNumber) => ({ floorNumber, existingId: null })) },
      roomTypes: spec.roomTypes.items.map((t) => ({ key: t.code, existingId: null, create: t, fill: {}, conflicts: [] })),
      rooms: { create: planRooms(spec), skip: [], typeMismatch: [], capacityFill: [] },
      ratePlans: spec.ratePlans.map((p) => ({ key: p.code, existingId: null, create: p, fill: {}, conflicts: [] })),
      invoiceSequences: spec.invoiceSequences.map((s) => ({ key: `${s.sequenceCode}/${s.year}`, existingId: null, create: s, fill: {}, conflicts: [], prefixClash: null })),
      profile: { existingId: null, create: true, fill: {}, conflicts: [] },
      settings: { aiExists: false, complianceExists: false, pilotProfile: "create" },
      countsBefore: { properties: 0 }
    };
  }
  it("lists one write per table for a new property and no conflicts", () => {
    const spec = validateSpec(rawSpec());
    const summary = summarizePlan(newPropertyPlan(spec));
    const tables = summary.writes.map((w) => `${w.op}:${w.table}`);
    assert.deepEqual(tables, [
      "create:properties",
      "create:user_property_roles",
      "create:departments",
      "create:user_departments",
      "create:property_modules",
      "create:buildings",
      "create:floors",
      "create:room_types",
      "createMany:rooms",
      "create:rate_plans",
      "create:invoice_sequences",
      "create:compliance_property_profiles",
      "upsert:property_ai_settings",
      "upsert:property_compliance_settings",
      "update:property_compliance_settings"
    ]);
    assert.equal(summary.writes.find((w) => w.table === "rooms")!.count, 92);
    assert.equal(summary.writes.find((w) => w.table === "property_modules")!.count, 6);
    assert.deepEqual(summary.conflicts, []);
    assert.deepEqual(summary.skips, []);
  });
  it("turns convergence conflicts and prefix clashes into conflict lines and existing rows into skips", () => {
    const spec = validateSpec(rawSpec());
    const plan = newPropertyPlan(spec);
    plan.property = { existingId: "prop_x", create: null, fill: { address: "Urbanización Los Tilos" }, conflicts: [{ field: "postalCode", current: "15172", desired: "15894" }] };
    plan.invoiceSequences[0]!.prefixClash = "prefijo «FAC-LT-2026-» ya usado por la propiedad prop_y";
    plan.rooms = { create: [], skip: ["101"], typeMismatch: [{ number: "101", currentType: "DBL", desiredType: "IND" }], capacityFill: [] };
    plan.settings.pilotProfile = "conflict";
    const summary = summarizePlan(plan);
    assert.equal(summary.writes[0]!.op, "update");
    assert.match(summary.writes[0]!.where ?? "", /rellena address/);
    assert.equal(summary.conflicts.length, 4);
    assert.match(summary.conflicts[0]!, /properties prop_x · postalCode: actual "15172" ≠ spec "15894"/);
    assert.ok(summary.conflicts.some((c) => c.includes("prefijo «FAC-LT-2026-»")));
    assert.ok(summary.conflicts.some((c) => c.startsWith("rooms 101")));
    assert.ok(summary.conflicts.some((c) => c.includes("pilotProfile")));
    assert.ok(summary.skips.some((s) => s.startsWith("rooms ×1")));
    assert.ok(!summary.writes.some((w) => w.table === "rooms"), "no room write without capacity to fill");
  });
  it("reports the capacity convergence of existing rooms as one «update rooms ×N» write", () => {
    const spec = validateSpec(rawSpec());
    const plan = newPropertyPlan(spec);
    plan.rooms = {
      create: [],
      skip: ["101", "102", "103"],
      typeMismatch: [],
      capacityFill: [
        { number: "101", roomId: "room_101", fill: { maxOccupancy: 1, standardOccupancy: 1 } },
        { number: "103", roomId: "room_103", fill: { standardOccupancy: 2 } }
      ]
    };
    const summary = summarizePlan(plan);
    const roomWrites = summary.writes.filter((w) => w.table === "rooms");
    assert.equal(roomWrites.length, 1);
    assert.equal(roomWrites[0]!.op, "update");
    assert.equal(roomWrites[0]!.count, 2);
    assert.match(roomWrites[0]!.where ?? "", /capacidad desde el tipo \(maxOccupancy, standardOccupancy; solo columnas NULL\)/);
    assert.ok(summary.skips.some((s) => s.startsWith("rooms ×3")));
  });
});
