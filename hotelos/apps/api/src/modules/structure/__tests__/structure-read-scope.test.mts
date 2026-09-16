// Estructura societaria · L9 · unit tests of the read contract the front (L6/L7)
// depends on, over an in-memory fake of the Prisma delegates `getStructure` and
// `listSwitchableProperties` read (no database): the mode × scope matrix of
// design §5.3 (single_hotel / multi_center / group; entity / assigned_properties),
// the redaction of t6b#9, the configuration warnings, the switcher fields, the
// opaque scope errors of lib/finance-scope.ts and the manifest of the 9 routes.
// Run from apps/api with
//   node --import tsx --test src/modules/structure/__tests__/structure-read-scope.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ENTITY_WIDE_READ,
  STRUCTURE_READ_ANY,
  getStructure,
  hasEntityWideRead,
  listSwitchableProperties,
  redactLegalEntityDto,
  requireEntityWideRead,
  toEstablishmentDto,
  toInstallationDto,
  toLegalEntityDto
} from "../legal-entity.service.js";
import { structureRoutePermissions } from "../route-permissions.partial.js";
import {
  ENTITY_READ_PERMISSION,
  assertFinanceReadScope,
  assertFinanceReadScopeMany,
  assertFinanceWriteScope,
  deriveStructureMode,
  filterOperationalProperties,
  hasEntityReadScope,
  isOperationalKind,
  propertyWithinScope
} from "../../../lib/finance-scope.js";
import { ForbiddenError, NotFoundError } from "../../../lib/http-error.js";
import type { UserContext } from "../../../lib/demo-store.js";

type Row = Record<string, unknown>;
type Db = Parameters<typeof getStructure>[1];
type Where = { where?: Record<string, unknown>; select?: Record<string, boolean> };

const NOW = new Date("2026-09-16T10:00:00.000Z");
const ORG = "org_unit";
const LE = "le_unit";

const entityRow = (over: Row = {}): Row => ({
  id: LE,
  organizationId: ORG,
  code: "TST",
  legalName: "Test Hoteles SA",
  taxId: "B12345674",
  legalForm: "sa",
  fiscalAddress: "Calle Real 1",
  fiscalPostalCode: "15001",
  fiscalMunicipality: "A Coruña",
  fiscalIneCode: "15030",
  fiscalProvince: "A Coruña",
  registeredOfficeAddress: "Calle Social 2",
  registeredOfficePostalCode: "15002",
  registeredOfficeMunicipality: "A Coruña",
  registeredOfficeProvince: "A Coruña",
  mercantileRegistry: "RM A Coruña T 1 F 2",
  cnae: "5510",
  pgcVariant: "pymes",
  fiscalYearStartMonth: 1,
  largeCompany: false,
  siiEnabled: false,
  verifactuChainScope: "per_center",
  cccPrincipal: "15012345678",
  isDefault: true,
  status: "active",
  createdAt: NOW,
  updatedAt: NOW,
  ...over
});

const propertyRow = (id: string, over: Row = {}): Row => ({
  id,
  organizationId: ORG,
  legalEntityId: LE,
  kind: "hotel",
  code: id.toUpperCase(),
  name: `Hotel ${id}`,
  tradeName: null,
  address: "Paseo 1",
  postalCode: "15172",
  municipality: "Oleiros",
  ineMunicipalityCode: "15058",
  province: "A Coruña",
  country: "ES",
  taxRegion: "ES_PENINSULA_BALEARES",
  fiscalTerritory: "common",
  status: "open",
  verifactuEnabled: false,
  sesHospedajesEnabled: true,
  surfaceM2: null,
  createdAt: NOW,
  ...over
});

const seriesRow = (id: string, propertyId: string, prefix: string, over: Row = {}): Row => ({ id, propertyId, sequenceCode: "FAC", prefix, year: 2026, nextNumber: 3, padding: 6, invoiceType: "F1", active: true, ...over });
const installationRow = (id: string, propertyId: string | null, numero: string, over: Row = {}): Row => ({ id, legalEntityId: LE, propertyId, numeroInstalacion: numero, route: "verifactu", territory: null, active: true, createdAt: NOW, retiredAt: null, ...over });

type State = { organizations: Row[]; entities: Row[]; properties: Row[]; sequences: Row[]; installations: Row[]; vatSettings: Row | null };

/** In-memory stand-in for the Prisma delegates the read paths use; records which delegates were hit. */
function fakeDb(state: State): { db: Db; calls: string[] } {
  const calls: string[] = [];
  const inList = (value: unknown, filter: unknown): boolean => {
    if (filter === undefined) return true;
    if (filter !== null && typeof filter === "object" && "in" in (filter as Row)) return ((filter as { in: unknown[] }).in ?? []).includes(value);
    return value === filter;
  };
  const db = {
    organization: {
      findUnique: async (args: Where) => {
        calls.push("organization.findUnique");
        const row = state.organizations.find((o) => o.id === args.where?.id);
        return row ? { id: row.id, name: row.name, country: row.country } : null;
      },
      findMany: async (args: Where) => {
        calls.push("organization.findMany");
        return state.organizations.filter((o) => inList(o.id, args.where?.id)).map((o) => ({ id: o.id, name: o.name }));
      }
    },
    legalEntity: {
      findFirst: async (args: Where) => {
        calls.push("legalEntity.findFirst");
        return state.entities.find((e) => e.organizationId === args.where?.organizationId && e.isDefault === true && e.status === "active") ?? null;
      },
      count: async (args: Where) => {
        calls.push("legalEntity.count");
        return state.entities.filter((e) => e.organizationId === args.where?.organizationId && e.status === (args.where?.status ?? e.status)).length;
      },
      findMany: async (args: Where) => {
        calls.push("legalEntity.findMany");
        return state.entities.filter((e) => inList(e.id, args.where?.id)).map((e) => ({ id: e.id, legalName: e.legalName }));
      }
    },
    property: {
      findMany: async (args: Where) => {
        calls.push("property.findMany");
        return state.properties.filter((p) => inList(p.organizationId, args.where?.organizationId));
      }
    },
    invoiceSequence: {
      findMany: async (args: Where) => {
        calls.push("invoiceSequence.findMany");
        return state.sequences.filter((s) => inList(s.propertyId, args.where?.propertyId) && s.active === true);
      }
    },
    verifactuInstallation: {
      findMany: async (args: Where) => {
        calls.push("verifactuInstallation.findMany");
        return state.installations.filter((i) => i.legalEntityId === args.where?.legalEntityId && i.active === true);
      }
    },
    vatSettings: {
      findUnique: async () => {
        calls.push("vatSettings.findUnique");
        return state.vatSettings;
      }
    }
  };
  return { db: db as unknown as Db, calls };
}

function context(permissions: string[], over: Partial<UserContext> = {}): UserContext {
  return { organizationId: ORG, propertyId: "h1", userId: "usr_unit", fullName: "Unit", deviceId: "dev_unit", permissions: permissions as UserContext["permissions"], ...over } as UserContext;
}

const baseState = (over: Partial<State> = {}): State => ({
  organizations: [{ id: ORG, name: "Unit Hoteles", country: "ES" }],
  entities: [entityRow()],
  properties: [propertyRow("h1")],
  sequences: [seriesRow("s1", "h1", "FAC-2026-")],
  installations: [installationRow("i1", "h1", "INST-0001")],
  vatSettings: { periodicity: "quarterly", regime: "general", prorrataPct: null, taxFigure: "IVA" },
  ...over
});

describe("deriveStructureMode (design §5.3 · tres modos)", () => {
  it("1 sociedad + 1 centro → single_hotel; ≥ 2 centros → multi_center; ≥ 2 sociedades → group (whatever the centres)", () => {
    assert.equal(deriveStructureMode({ legalEntities: 1, properties: 1 }), "single_hotel");
    assert.equal(deriveStructureMode({ legalEntities: 1, properties: 0 }), "single_hotel");
    assert.equal(deriveStructureMode({ legalEntities: 0, properties: 1 }), "single_hotel");
    assert.equal(deriveStructureMode({ legalEntities: 1, properties: 2 }), "multi_center");
    assert.equal(deriveStructureMode({ legalEntities: 1, properties: 8 }), "multi_center");
    assert.equal(deriveStructureMode({ legalEntities: 2, properties: 1 }), "group");
  });
});

describe("redactLegalEntityDto (t6b#9 · R11)", () => {
  it("blanks exactly the fiscal data (NIF, domicilios, RM, CNAE, CCC) and keeps name, code, regime and flags", () => {
    const dto = toLegalEntityDto(entityRow() as never);
    const redacted = redactLegalEntityDto(dto);
    const blanked = Object.keys(dto).filter((key) => JSON.stringify(dto[key as keyof typeof dto]) !== JSON.stringify(redacted[key as keyof typeof redacted])).sort();
    assert.deepEqual(blanked, ["cccPrincipal", "cnae", "fiscalAddress", "fiscalIneCode", "fiscalMunicipality", "fiscalPostalCode", "fiscalProvince", "mercantileRegistry", "registeredOfficeAddress", "registeredOfficeMunicipality", "registeredOfficePostalCode", "registeredOfficeProvince", "taxId", "taxIdValid"]);
    assert.deepEqual([redacted.taxId, redacted.taxIdValid], [null, false]);
    assert.deepEqual([redacted.code, redacted.legalName, redacted.pgcVariant, redacted.siiEnabled, redacted.largeCompany, redacted.verifactuChainScope, redacted.isDefault], ["TST", "Test Hoteles SA", "pymes", false, false, "per_center", true]);
  });
});

describe("hasEntityWideRead / requireEntityWideRead", () => {
  it("accounting.entity.read ∨ organization.structure.manage ∨ platform admin; the calendar key alone is 403", () => {
    assert.deepEqual([...ENTITY_WIDE_READ], ["accounting.entity.read", "organization.structure.manage"]);
    assert.deepEqual([...STRUCTURE_READ_ANY], ["accounting.read", "organization.structure.manage"]);
    assert.equal(hasEntityWideRead(context(["accounting.read"])), false);
    assert.equal(hasEntityWideRead(context(["accounting.read", "accounting.entity.read"])), true);
    assert.equal(hasEntityWideRead(context(["organization.structure.manage"])), true);
    assert.equal(hasEntityWideRead(context([], { isPlatformAdmin: true })), true);
    assert.throws(() => requireEntityWideRead(context(["accounting.read", "accounting.reports.read"])), ForbiddenError);
    assert.doesNotThrow(() => requireEntityWideRead(context(["accounting.entity.read"])));
  });
});

describe("getStructure · matriz modo × ámbito sobre una BD falsa", () => {
  it("hotel individual, lectora de toda la sociedad: single_hotel · scope entity · DTO completo · series, instalación e IVA · sin avisos", async () => {
    const { db, calls } = fakeDb(baseState());
    const structure = await getStructure(context(["accounting.read", "accounting.entity.read"]), db);
    assert.equal(structure.mode, "single_hotel");
    assert.equal(structure.scope, "entity");
    assert.deepEqual(structure.counts, { properties: 1, hotels: 1, offices: 0, others: 0, legalEntities: 1 });
    assert.deepEqual(structure.warnings, []);
    assert.deepEqual(structure.organization, { id: ORG, name: "Unit Hoteles", country: "ES" });
    assert.equal(structure.legalEntity?.taxId, "B12345674");
    assert.equal(structure.legalEntity?.taxIdValid, true);
    assert.deepEqual(structure.legalEntity?.vatSettings, { periodicity: "quarterly", regime: "general", prorrataPct: null, taxFigure: "IVA" });
    const [hotel] = structure.legalEntity!.properties;
    assert.deepEqual([hotel!.id, hotel!.code, hotel!.kind, hotel!.municipality, hotel!.legalEntityId], ["h1", "H1", "hotel", "Oleiros", LE]);
    assert.deepEqual(hotel!.series.map((s) => [s.prefix, s.year, s.nextNumber, s.active]), [["FAC-2026-", 2026, 3, true]]);
    assert.equal(hotel!.installation?.numeroInstalacion, "INST-0001");
    assert.equal(hotel!.installation?.createdAt, NOW.toISOString());
    assert.ok(calls.includes("invoiceSequence.findMany") && calls.includes("verifactuInstallation.findMany") && calls.includes("vatSettings.findUnique"));
  });

  it("prorrata comes back as a two-decimal string; a closed series never appears", async () => {
    const { db } = fakeDb(baseState({ vatSettings: { periodicity: "monthly", regime: "general", prorrataPct: { toFixed: (n: number) => (85).toFixed(n) }, taxFigure: "IVA" }, sequences: [seriesRow("s1", "h1", "FAC-2026-"), seriesRow("s2", "h1", "FAC-2025-", { year: 2025, active: false })] }));
    const structure = await getStructure(context(["organization.structure.manage"]), db);
    assert.equal(structure.legalEntity?.vatSettings?.prorrataPct, "85.00");
    assert.deepEqual(structure.legalEntity?.properties[0]?.series.map((s) => s.prefix), ["FAC-2026-"]);
  });

  it("NIF pendiente → TAX_ID_PENDING solo para quien gestiona la sociedad; un centro sin sociedad → PROPERTIES_UNLINKED; sin sociedad → LEGAL_ENTITY_PENDING y legalEntity null", async () => {
    const pending = fakeDb(baseState({ entities: [entityRow({ taxId: null })], properties: [propertyRow("h1"), propertyRow("h2", { legalEntityId: null })] }));
    const manager = await getStructure(context(["organization.structure.manage"]), pending.db);
    assert.deepEqual(manager.warnings, ["TAX_ID_PENDING", "PROPERTIES_UNLINKED"]);
    assert.deepEqual([manager.legalEntity?.taxId, manager.legalEntity?.taxIdValid], [null, false]);
    const reader = await getStructure(context(["accounting.read"], { assignedPropertyIds: ["h1"] }), pending.db);
    assert.deepEqual(reader.warnings, [], "configuration warnings are never shown to a centre-scoped reader");
    const none = fakeDb(baseState({ entities: [] }));
    const structure = await getStructure(context(["accounting.read", "accounting.entity.read"]), none.db);
    assert.equal(structure.legalEntity, null);
    assert.deepEqual(structure.warnings, ["LEGAL_ENTITY_PENDING"]);
    assert.equal(structure.mode, "single_hotel");
    assert.equal(structure.counts.legalEntities, 0);
  });

  it("sociedad con varios centros, director de UN hotel (accounting.read): scope assigned_properties · solo su centro · sin series / instalación / IVA · DTO redactado · mode y counts de toda la organización · sin leer series, instalaciones ni IVA", async () => {
    const { db, calls } = fakeDb(
      baseState({
        properties: [propertyRow("h1"), propertyRow("h2", { municipality: "Teo" }), propertyRow("oc", { kind: "office", code: "OC", name: "Oficina central", sesHospedajesEnabled: false })],
        sequences: [seriesRow("s1", "h1", "FAC-H1-2026-"), seriesRow("s2", "h2", "FAC-H2-2026-")],
        installations: [installationRow("i1", "h1", "INST-0001"), installationRow("i2", "h2", "INST-0002")]
      })
    );
    const structure = await getStructure(context(["accounting.read", "accounting.reports.read"], { propertyId: "h2", assignedPropertyIds: ["h2"] }), db);
    assert.equal(structure.scope, "assigned_properties");
    assert.equal(structure.mode, "multi_center");
    assert.deepEqual(structure.counts, { properties: 3, hotels: 2, offices: 1, others: 0, legalEntities: 1 });
    assert.deepEqual(structure.legalEntity?.properties.map((p) => p.id), ["h2"]);
    assert.deepEqual(structure.legalEntity?.properties[0]?.series, []);
    assert.equal(structure.legalEntity?.properties[0]?.installation, null);
    assert.equal(structure.legalEntity?.vatSettings, null);
    assert.deepEqual([structure.legalEntity?.taxId, structure.legalEntity?.fiscalAddress, structure.legalEntity?.cnae, structure.legalEntity?.cccPrincipal], [null, null, null, null]);
    assert.deepEqual([structure.legalEntity?.code, structure.legalEntity?.legalName], ["TST", "Test Hoteles SA"], "name and code stay for the eyebrow «Configuración · <sociedad>»");
    assert.ok(!calls.includes("invoiceSequence.findMany") && !calls.includes("verifactuInstallation.findMany") && !calls.includes("vatSettings.findUnique"), `redaction never reads the hidden rows: ${calls.join(",")}`);
  });

  it("accounting.read sin asignaciones (contexto de toda la organización): lista todos los centros pero sigue redactado; el propietario y el admin de plataforma ven todo", async () => {
    const state = baseState({ properties: [propertyRow("h1"), propertyRow("h2")], sequences: [seriesRow("s1", "h1", "FAC-H1-2026-"), seriesRow("s2", "h2", "FAC-H2-2026-")] });
    const orgWide = await getStructure(context(["accounting.read"]), fakeDb(state).db);
    assert.equal(orgWide.scope, "assigned_properties");
    assert.deepEqual(orgWide.legalEntity?.properties.map((p) => p.id), ["h1", "h2"]);
    assert.equal(orgWide.legalEntity?.taxId, null);
    assert.ok(orgWide.legalEntity?.properties.every((p) => p.series.length === 0));
    const owner = await getStructure(context(["accounting.read", "organization.structure.manage"], { assignedPropertyIds: ["h1"] }), fakeDb(state).db);
    assert.equal(owner.scope, "entity");
    assert.deepEqual(owner.legalEntity?.properties.map((p) => [p.id, p.series.length]), [["h1", 1], ["h2", 1]]);
    assert.equal(owner.legalEntity?.taxId, "B12345674");
    // The route key (accounting.read) is still required: the platform flag only widens the scope.
    await assert.rejects(getStructure(context([], { isPlatformAdmin: true }), fakeDb(state).db), ForbiddenError);
    const platform = await getStructure(context(["accounting.read"], { isPlatformAdmin: true, assignedPropertyIds: ["h1"] }), fakeDb(state).db);
    assert.equal(platform.scope, "entity");
    assert.deepEqual(platform.legalEntity?.properties.map((p) => p.id), ["h1", "h2"]);
  });

  it("fase grupo: dos sociedades activas → mode group (la fila devuelta sigue siendo la sociedad por defecto); una sociedad dormida no cuenta", async () => {
    const group = fakeDb(baseState({ entities: [entityRow(), entityRow({ id: "le_2", code: "OTR", legalName: "Otra SA", taxId: "A58818501", isDefault: false })] }));
    const structure = await getStructure(context(["accounting.read", "accounting.entity.read"]), group.db);
    assert.equal(structure.mode, "group");
    assert.equal(structure.counts.legalEntities, 2);
    assert.equal(structure.legalEntity?.id, LE);
    const dormant = fakeDb(baseState({ entities: [entityRow(), entityRow({ id: "le_2", code: "OTR", legalName: "Otra SA", taxId: null, isDefault: false, status: "dormant" })] }));
    assert.equal((await getStructure(context(["accounting.read", "accounting.entity.read"]), dormant.db)).mode, "single_hotel");
  });

  it("sin accounting.read ni organization.structure.manage → 403; organización inexistente → 404", async () => {
    const { db } = fakeDb(baseState());
    await assert.rejects(getStructure(context(["accounting.reports.read", "accounting.entity.read"]), db), ForbiddenError);
    await assert.rejects(getStructure(context(["accounting.read"], { organizationId: "org_missing" }), db), NotFoundError);
  });
});

describe("listSwitchableProperties · campos del switcher agrupado (L7)", () => {
  it("kind, code, legalEntityId y legalEntityName por fila; un usuario de hotel solo ve su organización; el admin de plataforma todas", async () => {
    const state = baseState({
      organizations: [{ id: ORG, name: "Unit Hoteles", country: "ES" }, { id: "org_other", name: "Otra Org", country: "ES" }],
      entities: [entityRow(), entityRow({ id: "le_other", organizationId: "org_other", code: "OTR", legalName: "Otra SA", taxId: null })],
      properties: [propertyRow("h1"), propertyRow("oc", { kind: "office", code: "OC", name: "Oficina central" }), propertyRow("x1", { organizationId: "org_other", legalEntityId: "le_other", code: "X1", name: "Hotel X" }), propertyRow("free", { legalEntityId: null, code: null, name: "Sin sociedad" })]
    });
    const rows = await listSwitchableProperties(context(["accounting.read"], { isPlatformAdmin: false }), fakeDb(state).db);
    assert.deepEqual(rows.map((r) => [r.id, r.kind, r.code, r.legalEntityId, r.legalEntityName, r.organizationName]), [
      ["h1", "hotel", "H1", LE, "Test Hoteles SA", "Unit Hoteles"],
      ["oc", "office", "OC", LE, "Test Hoteles SA", "Unit Hoteles"],
      ["free", "hotel", null, null, null, "Unit Hoteles"]
    ]);
    const platform = await listSwitchableProperties(context([], { isPlatformAdmin: true }), fakeDb(state).db);
    assert.deepEqual(platform.map((r) => [r.id, r.legalEntityName]), [["h1", "Test Hoteles SA"], ["oc", "Test Hoteles SA"], ["x1", "Otra SA"], ["free", null]]);
  });
});

describe("DTO mappers (superficie decimal como cadena, fechas ISO)", () => {
  it("toEstablishmentDto formats surfaceM2 with two decimals and null-safes the census; toInstallationDto stringifies dates", () => {
    const dto = toEstablishmentDto(propertyRow("oc", { kind: "office", code: "OC", surfaceM2: { toFixed: (n: number) => (250.5).toFixed(n) }, bedCapacity: 0 }) as never);
    assert.deepEqual([dto.kind, dto.code, dto.surfaceM2, dto.bedCapacity, dto.iaeEpigraph, dto.country], ["office", "OC", "250.50", 0, null, "ES"]);
    assert.equal(toEstablishmentDto(propertyRow("h1") as never).surfaceM2, null);
    const installation = toInstallationDto(installationRow("i1", null, "INST-0009", { retiredAt: NOW, active: false }) as never);
    assert.deepEqual([installation.propertyId, installation.numeroInstalacion, installation.active, installation.retiredAt], [null, "INST-0009", false, NOW.toISOString()]);
  });
});

describe("ámbito único (lib/finance-scope.ts) · lo que el selector «Ámbito» debe reflejar", () => {
  it("propertyWithinScope / hasEntityReadScope: platform admin and unassigned contexts are organization-wide; the key opens the sociedad", () => {
    assert.equal(propertyWithinScope({ isPlatformAdmin: true, assignedPropertyIds: ["h1"] }, "h2"), true);
    assert.equal(propertyWithinScope({ assignedPropertyIds: [] }, "h2"), true);
    assert.equal(propertyWithinScope({ assignedPropertyIds: ["h1"] }, "h2"), false);
    assert.equal(hasEntityReadScope({ permissions: ["accounting.read"] as never, assignedPropertyIds: ["h1"] }), false);
    assert.equal(hasEntityReadScope({ permissions: ["accounting.read", ENTITY_READ_PERMISSION] as never, assignedPropertyIds: ["h1"] }), true);
    assert.equal(hasEntityReadScope({ permissions: [] as never }), true, "no assignments = organization-wide by construction");
  });

  it("assertFinanceReadScope: 404 ENTITY_SCOPE_REQUIRED (with requiredPermission, never a property id) without a centre; opaque 404 on a sister centre; writes follow the same rule", () => {
    const director = { permissions: ["accounting.read"] as never, assignedPropertyIds: ["h2"] };
    try {
      assertFinanceReadScope(director, null);
      assert.fail("expected 404");
    } catch (error) {
      assert.ok(error instanceof NotFoundError);
      assert.deepEqual(error.details, { code: "ENTITY_SCOPE_REQUIRED", requiredPermission: "accounting.entity.read" });
      assert.doesNotMatch(error.message, /h1|h2/);
    }
    assert.throws(() => assertFinanceReadScope(director, "h1"), (error: unknown) => error instanceof NotFoundError && error.message === "Propiedad no encontrada.");
    assert.doesNotThrow(() => assertFinanceReadScope(director, "h2"));
    assert.throws(() => assertFinanceWriteScope(director, null), NotFoundError);
    assert.throws(() => assertFinanceReadScopeMany(director, ["h2", "h1"]), NotFoundError);
    assert.doesNotThrow(() => assertFinanceReadScopeMany({ permissions: [ENTITY_READ_PERMISSION] as never, assignedPropertyIds: ["h2"] }, []));
  });

  it("filtro operativo (R6): only kind = hotel (or a legacy row without kind) enters night audit, portfolio, tasa, SES and per-room KPIs", () => {
    assert.equal(isOperationalKind(undefined), true);
    assert.equal(isOperationalKind("hotel"), true);
    assert.equal(isOperationalKind("office"), false);
    assert.equal(isOperationalKind("other"), false);
    assert.deepEqual(filterOperationalProperties([{ id: 1, kind: "hotel" }, { id: 2, kind: "office" }, { id: 3 }, { id: 4, kind: "other" }]).map((r) => r.id), [1, 3]);
  });
});

describe("manifiesto de las 9 rutas de estructura (route-permissions.partial.ts)", () => {
  it("cada ruta lleva exactamente la clave y el riesgo del diseño §5.4 / runbook §17.8", () => {
    const table = structureRoutePermissions.map((entry) => `${entry.method} ${entry.path} → ${entry.permissions.join("|")} · ${entry.riskLevel}`).sort();
    assert.deepEqual(table, [
      "GET /legal-entities/:legalEntityId → accounting.entity.read · medium",
      "GET /legal-entities/:legalEntityId/series → billing.configure · medium",
      "GET /legal-entities/:legalEntityId/verifactu/installations → accounting.configure · medium",
      "GET /organizations/me/structure → accounting.read · medium",
      "PATCH /legal-entities/:legalEntityId → organization.structure.manage · high",
      "PATCH /properties/:propertyId/establishment → organization.structure.manage · high",
      "POST /admin/legal-entities/:legalEntityId/verifactu-scope → admin.tenants.manage · critical",
      "POST /legal-entities → organization.structure.manage · high",
      "POST /legal-entities/:legalEntityId/properties → organization.structure.manage · high"
    ]);
    for (const entry of structureRoutePermissions) {
      if (entry.method !== "GET") assert.ok(["high", "critical"].includes(entry.riskLevel), `${entry.method} ${entry.path} is a write: high or critical`);
      assert.equal(entry.permissions.length, 1, "one key per route; the finer rules live in the service");
    }
  });
});
