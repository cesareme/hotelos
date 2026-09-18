// Unit tests for the finance scope / legal identity helpers (Tanda 6b · L1).
// No database: an in-memory fake of the three Prisma delegates the helpers
// touch. Run from apps/api with
//   node --import tsx --test src/lib/__tests__/finance-scope.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  deriveStructureMode,
  filterOperationalProperties,
  isOperationalKind,
  isStructureEnabled,
  listOperationalProperties,
  propertyWithinScope,
  requireLegalIdentity,
  resolveLedgerScope,
  resolveLegalIdentity,
  type FinanceDb
} from "../finance-scope.js";
import { isPropertyAssigned } from "../tenancy.js";
import { NotFoundError } from "../http-error.js";

const ORG = "cmrhw9jy30002fyvb6tsdiugt";
const RIAS_ALTAS = "cmrhw9jy40003fyvbuu2ec2w7";
const LOS_TILOS = "cmu1mifcp0000fyo1wzvq7txo";

type FakeEntity = Record<string, unknown> & { id: string; organizationId: string; isDefault: boolean; status: string; createdAt: Date };
type FakeProperty = { id: string; organizationId: string; legalEntityId: string | null; kind: string; code: string | null; name: string; status: string; timezone: string; createdAt: Date };

function entity(overrides: Partial<FakeEntity> = {}): FakeEntity {
  return {
    id: "le_faranda",
    organizationId: ORG,
    code: "FAR",
    legalName: "Faranda Hotels & Resorts",
    taxId: "es-b99999997",
    legalForm: "sa",
    fiscalAddress: "Portugal 7",
    fiscalPostalCode: "33207",
    fiscalMunicipality: "Gijón",
    fiscalIneCode: "33024",
    fiscalProvince: "Asturias",
    pgcVariant: "pymes",
    largeCompany: false,
    siiEnabled: false,
    verifactuChainScope: "per_center",
    cccPrincipal: null,
    isDefault: true,
    status: "active",
    createdAt: new Date("2026-09-16T00:00:00Z"),
    ...overrides
  };
}

function property(overrides: Partial<FakeProperty> & { id: string }): FakeProperty {
  return { organizationId: ORG, legalEntityId: "le_faranda", kind: "hotel", code: null, name: overrides.id, status: "open", timezone: "Europe/Madrid", createdAt: new Date("2026-01-01T00:00:00Z"), ...overrides };
}

function fakeDb(state: { entities?: FakeEntity[]; organization?: { id: string; name: string; legalName: string | null; taxId: string | null } | null; properties?: FakeProperty[] }) {
  const calls: { findMany: unknown[] } = { findMany: [] };
  const db = {
    legalEntity: {
      findFirst: async (args: { where: { organizationId: string; isDefault?: boolean; status?: string } }) =>
        (state.entities ?? [])
          .filter((e) => e.organizationId === args.where.organizationId && (args.where.isDefault === undefined || e.isDefault === args.where.isDefault) && (args.where.status === undefined || e.status === args.where.status))
          .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())[0] ?? null
    },
    organization: {
      findUnique: async (args: { where: { id: string } }) => (state.organization && state.organization.id === args.where.id ? state.organization : null)
    },
    property: {
      findUnique: async (args: { where: { id: string } }) => (state.properties ?? []).find((p) => p.id === args.where.id) ?? null,
      findMany: async (args: { where: { organizationId: string; kind?: string; status?: { not: string } } }) => {
        calls.findMany.push(args);
        return (state.properties ?? [])
          .filter((p) => p.organizationId === args.where.organizationId)
          .filter((p) => (args.where.kind ? p.kind === args.where.kind : true))
          .filter((p) => (args.where.status ? p.status !== args.where.status.not : true))
          .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
      }
    }
  };
  return { db: db as unknown as FinanceDb, calls };
}

// ── resolveLegalIdentity ──────────────────────────────────────────────────────

describe("resolveLegalIdentity · single reader of the sociedad identity", () => {
  it("reads the default active legal entity and normalises / validates its NIF", async () => {
    const { db } = fakeDb({ entities: [entity()] });
    const identity = await resolveLegalIdentity(ORG, db);
    assert.ok(identity);
    assert.equal(identity.source, "legal_entity");
    assert.equal(identity.legalEntityId, "le_faranda");
    assert.equal(identity.code, "FAR");
    assert.equal(identity.legalName, "Faranda Hotels & Resorts");
    assert.equal(identity.taxId, "B99999997", "normalised: upper-case, ES prefix and separators removed");
    assert.equal(identity.taxIdValid, true);
    assert.equal(identity.fiscalMunicipality, "Gijón");
    assert.equal(identity.pgcVariant, "pymes");
    assert.equal(identity.verifactuChainScope, "per_center");
  });

  it("ignores dormant or non-default entities and falls back to the deprecated Organization columns (source organization_fallback)", async () => {
    const { db } = fakeDb({
      entities: [entity({ status: "dormant" }), entity({ id: "le_secondary", isDefault: false })],
      organization: { id: ORG, name: "Faranda Hotels & Resorts", legalName: null, taxId: "B12345678" }
    });
    const identity = await resolveLegalIdentity(ORG, db);
    assert.ok(identity);
    assert.equal(identity.source, "organization_fallback");
    assert.equal(identity.legalEntityId, null);
    assert.equal(identity.legalName, "Faranda Hotels & Resorts", "legalName falls back to the organisation name");
    assert.equal(identity.taxId, "B12345678");
    assert.equal(identity.taxIdValid, false, "checksum-invalid NIF is reported, never silently accepted");
    assert.equal(identity.pgcVariant, "pymes");
  });

  it("returns null for an unknown organisation; requireLegalIdentity turns it into an opaque 404", async () => {
    const { db } = fakeDb({});
    assert.equal(await resolveLegalIdentity("org_missing", db), null);
    await assert.rejects(requireLegalIdentity("org_missing", db), (error: unknown) => error instanceof NotFoundError && error.statusCode === 404 && error.message === "Organización no encontrada.");
  });
});

// ── resolveLedgerScope ────────────────────────────────────────────────────────

describe("resolveLedgerScope · one legal entity per organisation in this tanda", () => {
  const properties = [property({ id: RIAS_ALTAS, code: "RA" }), property({ id: LOS_TILOS, code: "LT" }), property({ id: "prop_office", code: "OC", kind: "office" }), property({ id: "prop_other_org", organizationId: "org_123", legalEntityId: "le_demo" })];

  it("defaults to the whole sociedad and accepts its own legalEntityId", async () => {
    const { db } = fakeDb({ entities: [entity()], properties });
    const scope = await resolveLedgerScope({ organizationId: ORG }, {}, db);
    assert.equal(scope.kind, "entity");
    assert.equal(scope.legalEntityId, "le_faranda");
    assert.equal(scope.propertyId, null);
    assert.equal(scope.identity.taxId, "B99999997");
    const explicit = await resolveLedgerScope({ organizationId: ORG }, { legalEntityId: "le_faranda" }, db);
    assert.equal(explicit.kind, "entity");
  });

  it("any other legalEntityId is an opaque 404 (no existence oracle)", async () => {
    const { db } = fakeDb({ entities: [entity()], properties });
    await assert.rejects(resolveLedgerScope({ organizationId: ORG }, { legalEntityId: "le_other" }, db), (error: unknown) => error instanceof NotFoundError && error.message === "Sociedad no encontrada.");
  });

  it("filters by a centre of the organisation (office included) and reports its kind", async () => {
    const { db } = fakeDb({ entities: [entity()], properties });
    const scope = await resolveLedgerScope({ organizationId: ORG, orgScope: true }, { propertyId: "prop_office" }, db);
    assert.equal(scope.kind, "property");
    assert.equal(scope.propertyId, "prop_office");
    assert.equal(scope.propertyKind, "office");
    assert.equal(scope.legalEntityId, "le_faranda");
  });

  it("a property of another organisation, a property outside the user's assignments or one bound to another entity → opaque 404", async () => {
    const { db } = fakeDb({ entities: [entity()], properties: [...properties, property({ id: "prop_foreign_entity", legalEntityId: "le_other" })] });
    const opaque = (error: unknown) => error instanceof NotFoundError && error.message === "Propiedad no encontrada.";
    await assert.rejects(resolveLedgerScope({ organizationId: ORG, orgScope: true }, { propertyId: "prop_other_org" }, db), opaque);
    await assert.rejects(resolveLedgerScope({ organizationId: ORG, orgScope: true }, { propertyId: "prop_missing" }, db), opaque);
    await assert.rejects(resolveLedgerScope({ organizationId: ORG, assignedPropertyIds: [LOS_TILOS] }, { propertyId: RIAS_ALTAS }, db), opaque);
    await assert.rejects(resolveLedgerScope({ organizationId: ORG, orgScope: true }, { propertyId: "prop_foreign_entity" }, db), opaque);
    // Tanda 8a: a real session with an EMPTY assignment list and no explicit organisation scope reaches no centre at all.
    await assert.rejects(resolveLedgerScope({ organizationId: ORG, assignedPropertyIds: [] }, { propertyId: LOS_TILOS }, db), opaque);
    const own = await resolveLedgerScope({ organizationId: ORG, assignedPropertyIds: [LOS_TILOS] }, { propertyId: LOS_TILOS }, db);
    assert.equal(own.propertyId, LOS_TILOS);
    const admin = await resolveLedgerScope({ organizationId: ORG, assignedPropertyIds: [LOS_TILOS], isPlatformAdmin: true }, { propertyId: RIAS_ALTAS }, db);
    assert.equal(admin.propertyId, RIAS_ALTAS, "a platform admin is exempt from the assignment check");
  });

  it("works for a tenant without a backfilled entity (legalEntityId null, identity from the fallback)", async () => {
    const { db } = fakeDb({ organization: { id: ORG, name: "Faranda", legalName: "Faranda Hotels & Resorts", taxId: "B99999997" }, properties: [property({ id: RIAS_ALTAS, legalEntityId: null })] });
    const scope = await resolveLedgerScope({ organizationId: ORG, orgScope: true }, { propertyId: RIAS_ALTAS }, db);
    assert.equal(scope.legalEntityId, null);
    assert.equal(scope.identity.source, "organization_fallback");
    assert.equal(scope.propertyId, RIAS_ALTAS);
  });

  it("propertyWithinScope mirrors tenancy.isPropertyAssigned (Tanda 8a: orgScope explicit, «sin asignaciones» reaches nothing)", () => {
    const cases: Array<[{ assignedPropertyIds?: string[]; orgScope?: boolean }, string]> = [
      [{ assignedPropertyIds: [LOS_TILOS] }, LOS_TILOS],
      [{ assignedPropertyIds: [LOS_TILOS] }, RIAS_ALTAS],
      [{}, RIAS_ALTAS],
      [{ assignedPropertyIds: [] }, RIAS_ALTAS],
      [{ assignedPropertyIds: [], orgScope: true }, RIAS_ALTAS],
      [{ orgScope: true }, LOS_TILOS],
      [{ assignedPropertyIds: [LOS_TILOS], orgScope: true }, RIAS_ALTAS],
      [{ assignedPropertyIds: [RIAS_ALTAS, LOS_TILOS] }, LOS_TILOS]
    ];
    for (const [context, id] of cases) assert.equal(propertyWithinScope(context, id), isPropertyAssigned(context, id), `${JSON.stringify(context)} / ${id}`);
    assert.equal(propertyWithinScope({}, RIAS_ALTAS), true, "no list at all (context assembled outside loadUserContext) → organization");
    assert.equal(propertyWithinScope({ assignedPropertyIds: [] }, RIAS_ALTAS), false, "empty assignments (real session) → nothing");
    assert.equal(propertyWithinScope({ orgScope: true }, RIAS_ALTAS), true, "explicit organization scope → every property");
    assert.equal(propertyWithinScope({ assignedPropertyIds: [LOS_TILOS], isPlatformAdmin: true }, RIAS_ALTAS), true);
  });
});

// ── Operational properties ────────────────────────────────────────────────────

describe("listOperationalProperties · the only kind = hotel filter", () => {
  const properties = [
    property({ id: RIAS_ALTAS, code: "RA", createdAt: new Date("2026-01-10T00:00:00Z") }),
    property({ id: LOS_TILOS, code: "LT", createdAt: new Date("2026-09-14T00:00:00Z") }),
    property({ id: "prop_office", code: "OC", kind: "office" }),
    property({ id: "prop_closed", code: "CL", status: "closed", createdAt: new Date("2025-01-01T00:00:00Z") }),
    property({ id: "prop_other_org", organizationId: "org_123" })
  ];

  it("returns the open hotels of the organisation, oldest first, never the office", async () => {
    const { db, calls } = fakeDb({ properties });
    const rows = await listOperationalProperties(ORG, db);
    assert.deepEqual(rows.map((r) => r.id), [RIAS_ALTAS, LOS_TILOS]);
    assert.deepEqual((calls.findMany[0] as { where: { kind: string } }).where.kind, "hotel", "the filter is pushed to the database");
  });

  it("includeClosed keeps closed hotels but still excludes non-lodging centres", async () => {
    const { db } = fakeDb({ properties });
    const rows = await listOperationalProperties(ORG, db, { includeClosed: true });
    assert.deepEqual(rows.map((r) => r.id), ["prop_closed", RIAS_ALTAS, LOS_TILOS]);
  });

  it("isOperationalKind / filterOperationalProperties: missing kind is a hotel (column default); office and other are not", () => {
    assert.equal(isOperationalKind(undefined), true);
    assert.equal(isOperationalKind(null), true);
    assert.equal(isOperationalKind("hotel"), true);
    assert.equal(isOperationalKind("office"), false);
    assert.equal(isOperationalKind("other"), false);
    const filtered = filterOperationalProperties([{ id: "a" }, { id: "b", kind: "office" }, { id: "c", kind: "hotel" }, { id: "d", kind: "other" }]);
    assert.deepEqual(filtered.map((p) => p.id), ["a", "c"]);
  });
});

// ── Pure helpers ──────────────────────────────────────────────────────────────

describe("deriveStructureMode / isStructureEnabled", () => {
  it("maps the counts to single_hotel · multi_center · group", () => {
    assert.equal(deriveStructureMode({ legalEntities: 1, properties: 1 }), "single_hotel");
    assert.equal(deriveStructureMode({ legalEntities: 1, properties: 2 }), "multi_center");
    assert.equal(deriveStructureMode({ legalEntities: 1, properties: 8 }), "multi_center");
    assert.equal(deriveStructureMode({ legalEntities: 2, properties: 1 }), "group");
    assert.equal(deriveStructureMode({ legalEntities: 0, properties: 0 }), "single_hotel");
  });
  it("STRUCTURE_ENABLED defaults to on and only false / 0 switch it off", () => {
    assert.equal(isStructureEnabled({}), true);
    assert.equal(isStructureEnabled({ STRUCTURE_ENABLED: "" }), true);
    assert.equal(isStructureEnabled({ STRUCTURE_ENABLED: "true" }), true);
    assert.equal(isStructureEnabled({ STRUCTURE_ENABLED: " TRUE " }), true);
    assert.equal(isStructureEnabled({ STRUCTURE_ENABLED: "1" }), true);
    assert.equal(isStructureEnabled({ STRUCTURE_ENABLED: "false" }), false);
    assert.equal(isStructureEnabled({ STRUCTURE_ENABLED: "0" }), false);
    assert.equal(isStructureEnabled({ STRUCTURE_ENABLED: "no" }), false);
  });
});
