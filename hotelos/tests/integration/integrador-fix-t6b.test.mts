/**
 * Estructura societaria · lote fix:integrador (Tanda 6b, 2026-09-16) — in-process
 * services against the shared Postgres on ISOLATED organizations
 * (`org_t6bfix_*_<run>`, created here and removed in `after`; Faranda and
 * org_123 are never written):
 *   · t6b#7  materialiseOnboardingStructure (go-live of onboarding) creates the
 *            organization with its name only, the implicit sociedad with the
 *            NIF and a coded `hotel` centre linked to it; re-running converges;
 *            a pre-backfill tenant gets its sociedad from the deprecated
 *            columns; 400 TAX_ID_INVALID / 409 TAX_ID_IN_USE roll the whole
 *            transaction back; a property id of another organization is an
 *            opaque 404;
 *   · t6b#9  getStructure with accounting.read alone is redacted to the assigned
 *            centres (no series, installation, VAT settings, NIF, domicilios);
 *            accounting.entity.read / organization.structure.manage / platform
 *            admin see the whole sociedad; getLegalEntity refuses the calendar
 *            key (403) and the manifest carries accounting.entity.read;
 *   · t6b#12 the inspection folder prints the sociedad as titular (razón social
 *            + NIF) and the trade name of the centre, never Property.legalName;
 *   · t6b#13 the basis of the schedulers (listOperationalProperties) skips the
 *            office created through onboarding.
 * Run from the repo root:
 *   cd apps/api && node --import tsx --test "../../tests/integration/integrador-fix-t6b.test.mts"
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

try {
  process.loadEnvFile(fileURLToPath(new URL("../../.env", import.meta.url)));
} catch {
  // No .env → CI defaults below.
}
process.env.DATABASE_URL ??= "postgresql://hotelos:hotelos@localhost:5432/hotelos";
process.env.JWT_SECRET ??= "integration-test-secret-32chars-minimum-aaaa";
process.env.ENCRYPTION_KEY ??= "integration-test-enckey-32chars-min-aaaa";

const { prisma } = await import("@hotelos/database");
const { isValidSpanishTaxId } = await import("@hotelos/compliance");
const onboarding = await import("../../apps/api/src/modules/onboarding/onboarding.service.js");
const legal = await import("../../apps/api/src/modules/structure/legal-entity.service.js");
const scope = await import("../../apps/api/src/lib/finance-scope.js");
const inspection = await import("../../apps/api/src/modules/compliance/compliance-inspection.service.js");
const { findRoutePermission } = await import("../../apps/api/src/security/route-permissions.js");
const { BadRequestError, ConflictError, ForbiddenError, NotFoundError } = await import("../../apps/api/src/lib/http-error.js");
const { flushAuditQueues } = await import("../../apps/api/src/modules/audit/audit.service.js");
type UserContext = import("../../apps/api/src/lib/demo-store.js").UserContext;

const RUN = Date.now().toString(36);
const ORG_PREFIX = "org_t6bfix_";
const ORG_NEW = `${ORG_PREFIX}new_${RUN}`;
const ORG_LEGACY = `${ORG_PREFIX}legacy_${RUN}`;
const ORG_STRUCT = `${ORG_PREFIX}struct_${RUN}`;
const ORG_BAD = `${ORG_PREFIX}bad_${RUN}`;
const ORGS = [ORG_NEW, ORG_LEGACY, ORG_STRUCT, ORG_BAD];
const PROP_NEW = `prop_t6bfix_new_${RUN}`;
const PROP_NEW_OFFICE = `prop_t6bfix_office_${RUN}`;
const PROP_LEGACY = `prop_t6bfix_legacy_${RUN}`;
const PROP_HN = `prop_t6bfix_hn_${RUN}`;
const PROP_HS = `prop_t6bfix_hs_${RUN}`;
/** Checksum-valid CIFs that no demo tenant uses (org_123 holds B12345674, Faranda A33615980 since the CELUISMA migration, L2 / backfill tests A58818501). */
const NIF_NEW = "B76543214";
const NIF_LEGACY = "B45678901";
const NIF_STRUCT = "A12345674";
const ORG_NEW_NAME = `T6b Fix Hotels ${RUN}`;
const ORG_NEW_LEGAL_NAME = `T6b Fix Hotels SL ${RUN}`;
const STRUCT_LEGAL_NAME = `T6b Struct Hoteles SA ${RUN}`;
const STRUCT_FISCAL_ADDRESS = "Calle Fiscal 9";
const STRUCT_CCC = "28/1234567/89";
const HN_PREFIX = "FAC-HN-2026-";
const HS_PREFIX = "FAC-HS-2026-";
const INSTALL_NUMBER = `T6B-${RUN}`;
const DEPRECATED_TRADE_NAME = "Nombre comercial deprecado";
const HN_TRADE_NAME = "Hotel Norte by T6b";

const details = (error: unknown): Record<string, unknown> => ((error as { details?: Record<string, unknown> }).details ?? {}) as Record<string, unknown>;
const code = (error: unknown): unknown => details(error).code;

let structEntityId = "";

function context(extra: Partial<UserContext>): UserContext {
  return {
    organizationId: ORG_STRUCT,
    propertyId: PROP_HN,
    userId: "usr_t6bfix",
    fullName: "T6b fix",
    deviceId: "dev_t6bfix",
    permissions: [] as UserContext["permissions"],
    isPlatformAdmin: false,
    ...extra
  };
}

function newTenantInput(overrides: Partial<Parameters<typeof onboarding.materialiseOnboardingStructure>[0]> = {}) {
  return {
    organizationId: ORG_NEW,
    organizationName: ORG_NEW_NAME,
    organizationLegalName: ORG_NEW_LEGAL_NAME,
    organizationTaxId: NIF_NEW,
    propertyId: PROP_NEW,
    kind: "hotel" as const,
    requestedCode: null,
    tradeName: "Hotel T6b Playa Norte by Fix",
    property: { name: "Hotel T6b Playa Norte", address: "Calle Mar 1", municipality: "Oleiros", province: "A Coruña", country: "ES", timezone: "Europe/Madrid" },
    ...overrides
  };
}

async function removeOrganizations(where: { id: { in: string[] } } | { id: { startsWith: string } }): Promise<void> {
  const organizations = await prisma.organization.findMany({ where, select: { id: true } });
  const orgIds = organizations.map((row) => row.id);
  if (orgIds.length === 0) return;
  const properties = await prisma.property.findMany({ where: { organizationId: { in: orgIds } }, select: { id: true } });
  const propertyIds = properties.map((row) => row.id);
  const entities = await prisma.legalEntity.findMany({ where: { organizationId: { in: orgIds } }, select: { id: true } });
  if (propertyIds.length > 0) {
    await prisma.invoiceSequence.deleteMany({ where: { propertyId: { in: propertyIds } } });
    await prisma.propertyComplianceSetting.deleteMany({ where: { propertyId: { in: propertyIds } } });
  }
  if (entities.length > 0) await prisma.verifactuInstallation.deleteMany({ where: { legalEntityId: { in: entities.map((row) => row.id) } } });
  await prisma.property.deleteMany({ where: { organizationId: { in: orgIds } } });
  await prisma.legalEntity.deleteMany({ where: { organizationId: { in: orgIds } } });
  await prisma.organization.deleteMany({ where: { id: { in: orgIds } } });
}

before(async () => {
  for (const nif of [NIF_NEW, NIF_LEGACY, NIF_STRUCT]) assert.equal(isValidSpanishTaxId(nif), true, `${nif} must be checksum-valid`);
  // Leftovers of an interrupted run would hold the NIFs above (409 TAX_ID_IN_USE).
  await removeOrganizations({ id: { startsWith: ORG_PREFIX } });
  for (const nif of [NIF_NEW, NIF_LEGACY, NIF_STRUCT]) {
    assert.equal(await prisma.legalEntity.count({ where: { taxId: nif } }), 0, `${nif} is free before the run`);
  }

  // Pre-backfill tenant: deprecated columns hold the identity, no LegalEntity yet.
  await prisma.organization.create({ data: { id: ORG_LEGACY, name: `T6b Legacy ${RUN}`, legalName: `T6b Legacy SL ${RUN}`, taxId: NIF_LEGACY, country: "ES" } });
  await prisma.property.create({ data: { id: PROP_LEGACY, organizationId: ORG_LEGACY, name: `Hotel Legacy ${RUN}`, timezone: "Europe/Madrid", country: "ES" } });

  // Sociedad with two coded hotels, series, one installation and fiscal data (t6b#9 / t6b#12).
  await prisma.organization.create({ data: { id: ORG_STRUCT, name: `T6b Struct ${RUN}`, country: "ES" } });
  const entity = await prisma.legalEntity.create({
    data: {
      organizationId: ORG_STRUCT,
      code: "TS",
      legalName: STRUCT_LEGAL_NAME,
      taxId: NIF_STRUCT,
      fiscalAddress: STRUCT_FISCAL_ADDRESS,
      fiscalPostalCode: "28001",
      fiscalMunicipality: "Madrid",
      fiscalProvince: "Madrid",
      cccPrincipal: STRUCT_CCC,
      isDefault: true,
      status: "active"
    }
  });
  structEntityId = entity.id;
  await prisma.property.create({
    data: { id: PROP_HN, organizationId: ORG_STRUCT, legalEntityId: entity.id, kind: "hotel", code: "HN", name: `Hotel Norte ${RUN}`, tradeName: HN_TRADE_NAME, legalName: DEPRECATED_TRADE_NAME, address: "Rúa Norte 1", province: "A Coruña", country: "ES", timezone: "Europe/Madrid" }
  });
  await prisma.property.create({
    data: { id: PROP_HS, organizationId: ORG_STRUCT, legalEntityId: entity.id, kind: "hotel", code: "HS", name: `Hotel Sur ${RUN}`, country: "ES", timezone: "Europe/Madrid" }
  });
  await prisma.invoiceSequence.createMany({
    data: [
      { propertyId: PROP_HN, legalEntityId: entity.id, sequenceCode: "FAC", invoiceType: "F1", year: 2026, prefix: HN_PREFIX, nextNumber: 5, padding: 6, active: true },
      { propertyId: PROP_HS, legalEntityId: entity.id, sequenceCode: "FAC", invoiceType: "F1", year: 2026, prefix: HS_PREFIX, nextNumber: 9, padding: 6, active: true }
    ]
  });
  await prisma.verifactuInstallation.create({ data: { legalEntityId: entity.id, propertyId: PROP_HN, numeroInstalacion: INSTALL_NUMBER, route: "verifactu", active: true } });
});

after(async () => {
  try {
    await flushAuditQueues();
    await removeOrganizations({ id: { in: ORGS } });
  } finally {
    await prisma.$disconnect();
  }
});

// ── t6b#7 ───────────────────────────────────────────────────────────────────

describe("t6b#7 · materialiseOnboardingStructure (go-live de onboarding)", () => {
  it("a new tenant: organization with its name only, implicit sociedad holding the NIF, coded hotel with tradeName and no Property.legalName", async () => {
    const result = await onboarding.materialiseOnboardingStructure(newTenantInput());
    assert.equal(result.organizationCreated, true);
    assert.equal(result.legalEntity.created, true);
    assert.equal(result.legalEntity.legalName, ORG_NEW_LEGAL_NAME);
    assert.equal(result.legalEntity.taxId, NIF_NEW);
    assert.equal(result.property.created, true);
    assert.equal(result.property.kind, "hotel");
    assert.match(result.property.code, /^[A-Z0-9]{2,6}$/);
    assert.equal(result.property.legalEntityId, result.legalEntity.id);

    const organization = await prisma.organization.findUniqueOrThrow({ where: { id: ORG_NEW } });
    assert.equal(organization.name, ORG_NEW_NAME);
    assert.equal(organization.legalName, null, "no espejo: the deprecated razón social column is not written");
    assert.equal(organization.taxId, null, "no espejo: the deprecated NIF column is not written");
    const entities = await prisma.legalEntity.findMany({ where: { organizationId: ORG_NEW } });
    assert.equal(entities.length, 1);
    assert.equal(entities[0]!.isDefault, true);
    assert.equal(entities[0]!.taxId, NIF_NEW);
    const property = await prisma.property.findUniqueOrThrow({ where: { id: PROP_NEW } });
    assert.equal(property.legalEntityId, entities[0]!.id);
    assert.equal(property.kind, "hotel");
    assert.equal(property.code, result.property.code);
    assert.equal(property.tradeName, "Hotel T6b Playa Norte by Fix", "the legacy payload legalName is the trade name");
    assert.equal(property.legalName, null, "Property.legalName is never written");
    assert.equal(property.status, "open");
    const identity = await scope.resolveLegalIdentity(ORG_NEW);
    assert.equal(identity?.source, "legal_entity", "the tenant no longer falls back to the deprecated columns");
    assert.equal(identity?.taxId, NIF_NEW);
    assert.equal(identity?.taxIdValid, true);
  });

  it("re-running converges (one sociedad, code kept); a second centre with a clashing explicit code is 409 CODE_IN_USE and an office gets its own code", async () => {
    const first = await prisma.property.findUniqueOrThrow({ where: { id: PROP_NEW }, select: { code: true } });
    const again = await onboarding.materialiseOnboardingStructure(newTenantInput({ tradeName: null, requestedCode: "ZZ" }));
    assert.equal(again.organizationCreated, false);
    assert.equal(again.legalEntity.created, false);
    assert.equal(again.property.created, false);
    assert.equal(again.property.code, first.code, "an existing code is never renumbered, even with an explicit request");
    assert.equal(await prisma.legalEntity.count({ where: { organizationId: ORG_NEW } }), 1);
    assert.equal((await prisma.property.findUniqueOrThrow({ where: { id: PROP_NEW } })).tradeName, null, "the trade name follows the payload on re-import");

    await assert.rejects(
      onboarding.materialiseOnboardingStructure(newTenantInput({ propertyId: PROP_NEW_OFFICE, kind: "office", requestedCode: first.code, tradeName: null, property: { name: `Oficina central ${RUN}`, country: "ES", timezone: "Europe/Madrid" } })),
      (error: unknown) => {
        assert.ok(error instanceof ConflictError, String(error));
        assert.equal(code(error), "CODE_IN_USE");
        return true;
      }
    );
    assert.equal(await prisma.property.count({ where: { id: PROP_NEW_OFFICE } }), 0, "the conflict wrote nothing");

    const office = await onboarding.materialiseOnboardingStructure(newTenantInput({ propertyId: PROP_NEW_OFFICE, kind: "office", requestedCode: null, tradeName: null, property: { name: `Oficina central ${RUN}`, country: "ES", timezone: "Europe/Madrid" } }));
    assert.equal(office.property.created, true);
    assert.equal(office.property.kind, "office");
    assert.notEqual(office.property.code, first.code);
    assert.equal(office.legalEntity.id, again.legalEntity.id, "the office hangs from the same sociedad");
  });

  it("a tenant created before the backfill gets its sociedad from the deprecated columns and keeps that NIF; the payload NIF is ignored", async () => {
    const result = await onboarding.materialiseOnboardingStructure({
      organizationId: ORG_LEGACY,
      organizationName: "Nombre ignorado",
      organizationLegalName: "Razón social ignorada",
      organizationTaxId: NIF_NEW,
      propertyId: PROP_LEGACY,
      kind: "hotel",
      requestedCode: null,
      tradeName: null,
      property: { name: `Hotel Legacy ${RUN}`, country: "ES", timezone: "Europe/Madrid" }
    });
    assert.equal(result.organizationCreated, false);
    assert.equal(result.legalEntity.created, true);
    assert.equal(result.legalEntity.taxId, NIF_LEGACY, "the NIF comes from the deprecated column, as the backfill does");
    assert.equal(result.legalEntity.legalName, `T6b Legacy SL ${RUN}`);
    assert.equal(result.property.created, false);
    const property = await prisma.property.findUniqueOrThrow({ where: { id: PROP_LEGACY } });
    assert.equal(property.legalEntityId, result.legalEntity.id, "legalEntityId is filled on an existing property");
    assert.match(property.code ?? "", /^[A-Z0-9]{2,6}$/);
    assert.equal(property.kind, "hotel");
    const organization = await prisma.organization.findUniqueOrThrow({ where: { id: ORG_LEGACY } });
    assert.equal(organization.name, `T6b Legacy ${RUN}`, "an existing organization is never renamed");
    assert.equal(organization.taxId, NIF_LEGACY, "the deprecated column is left as it was (read-only fallback)");
  });

  it("400 TAX_ID_INVALID / 409 TAX_ID_IN_USE roll the whole transaction back (no organization left behind); a property of another organization is an opaque 404", async () => {
    await assert.rejects(onboarding.materialiseOnboardingStructure(newTenantInput({ organizationId: ORG_BAD, propertyId: `prop_t6bfix_bad_${RUN}`, organizationTaxId: "B12345678" })), (error: unknown) => {
      assert.ok(error instanceof BadRequestError, String(error));
      assert.equal(code(error), "TAX_ID_INVALID");
      return true;
    });
    assert.equal(await prisma.organization.count({ where: { id: ORG_BAD } }), 0, "the invalid NIF left no half-materialised organization");

    await assert.rejects(onboarding.materialiseOnboardingStructure(newTenantInput({ organizationId: ORG_BAD, propertyId: `prop_t6bfix_bad_${RUN}`, organizationTaxId: NIF_NEW })), (error: unknown) => {
      assert.ok(error instanceof ConflictError, String(error));
      assert.equal(code(error), "TAX_ID_IN_USE");
      assert.doesNotMatch(error.message, new RegExp(ORG_NEW), "never names the other tenant");
      return true;
    });
    assert.equal(await prisma.organization.count({ where: { id: ORG_BAD } }), 0);

    await assert.rejects(onboarding.materialiseOnboardingStructure(newTenantInput({ propertyId: PROP_LEGACY })), (error: unknown) => {
      assert.ok(error instanceof NotFoundError, String(error));
      assert.equal(error.message, "Propiedad no encontrada.");
      return true;
    });
    const untouched = await prisma.property.findUniqueOrThrow({ where: { id: PROP_LEGACY } });
    assert.equal(untouched.organizationId, ORG_LEGACY, "a foreign property is never adopted");
    assert.equal(untouched.name, `Hotel Legacy ${RUN}`);
  });
});

// ── t6b#9 ───────────────────────────────────────────────────────────────────

describe("t6b#9 · GET /organizations/me/structure y GET /legal-entities/:id por ámbito de lectura", () => {
  it("accounting.read alone (Recepción assigned to HN): only HN, no series / installation / VAT settings, fiscal data of the sociedad redacted, scope assigned_properties", async () => {
    const structure = await legal.getStructure(context({ permissions: ["accounting.read"] as UserContext["permissions"], assignedPropertyIds: [PROP_HN] }));
    assert.equal(structure.scope, "assigned_properties");
    assert.equal(structure.mode, "multi_center", "mode describes the whole organization");
    assert.deepEqual(structure.counts, { properties: 2, hotels: 2, offices: 0, others: 0, legalEntities: 1 });
    assert.deepEqual(structure.warnings, []);
    assert.ok(structure.legalEntity);
    assert.deepEqual(structure.legalEntity.properties.map((row) => row.id), [PROP_HN]);
    assert.deepEqual(structure.legalEntity.properties[0]!.series, []);
    assert.equal(structure.legalEntity.properties[0]!.installation, null);
    assert.equal(structure.legalEntity.properties[0]!.code, "HN");
    assert.equal(structure.legalEntity.legalName, STRUCT_LEGAL_NAME, "the razón social stays (eyebrow of Finanzas)");
    assert.equal(structure.legalEntity.code, "TS");
    assert.equal(structure.legalEntity.taxId, null);
    assert.equal(structure.legalEntity.taxIdValid, false);
    assert.equal(structure.legalEntity.fiscalAddress, null);
    assert.equal(structure.legalEntity.fiscalMunicipality, null);
    assert.equal(structure.legalEntity.cccPrincipal, null);
    assert.equal(structure.legalEntity.vatSettings, null);
    const serialised = JSON.stringify(structure);
    for (const secret of [NIF_STRUCT, STRUCT_FISCAL_ADDRESS, STRUCT_CCC, HN_PREFIX, HS_PREFIX, INSTALL_NUMBER, PROP_HS]) {
      assert.ok(!serialised.includes(secret), `the redacted structure leaks ${secret}`);
    }
  });

  it("the demo fallback (explicit organisation scope, Tanda 8a) with accounting.read lists every centre but stays redacted; an empty assignment list alone lists none", async () => {
    // Tanda 8a (RBAC · §6.2): «sin asignaciones = toda la sociedad» was the hole H1/H2. The token-less demo
    // fallback carries `orgScope: true` (lib/auth-context.ts); a real session with an empty list reaches nothing.
    const structure = await legal.getStructure(context({ permissions: ["accounting.read"] as UserContext["permissions"], assignedPropertyIds: [], orgScope: true }));
    assert.equal(structure.scope, "assigned_properties");
    assert.equal(structure.legalEntity?.properties.length, 2);
    const nothing = await legal.getStructure(context({ permissions: ["accounting.read"] as UserContext["permissions"], assignedPropertyIds: [] }));
    assert.equal(nothing.legalEntity?.properties.length ?? 0, 0, "no assignments = no centre (fail-secure)");
    assert.equal(structure.legalEntity?.taxId, null);
    assert.ok(structure.legalEntity?.properties.every((row) => row.series.length === 0 && row.installation === null));
  });

  it("accounting.entity.read (Contabilidad), organization.structure.manage (Owner) and a platform admin see the whole sociedad with series, installation and NIF", async () => {
    const readers: Array<Partial<UserContext>> = [
      { permissions: ["accounting.read", "accounting.entity.read"] as UserContext["permissions"], assignedPropertyIds: [PROP_HN] },
      { permissions: ["organization.structure.manage"] as UserContext["permissions"], assignedPropertyIds: [PROP_HN] },
      { permissions: ["accounting.read"] as UserContext["permissions"], assignedPropertyIds: [PROP_HN], isPlatformAdmin: true }
    ];
    for (const reader of readers) {
      const structure = await legal.getStructure(context(reader));
      assert.equal(structure.scope, "entity", JSON.stringify(reader.permissions));
      assert.ok(structure.legalEntity);
      assert.deepEqual(structure.legalEntity.properties.map((row) => row.id).sort(), [PROP_HN, PROP_HS].sort());
      const hn = structure.legalEntity.properties.find((row) => row.id === PROP_HN)!;
      assert.deepEqual(hn.series.map((row) => [row.prefix, row.nextNumber]), [[HN_PREFIX, 5]]);
      assert.equal(hn.installation?.numeroInstalacion, INSTALL_NUMBER);
      assert.equal(structure.legalEntity.taxId, NIF_STRUCT);
      assert.equal(structure.legalEntity.fiscalAddress, STRUCT_FISCAL_ADDRESS);
      assert.equal(structure.legalEntity.cccPrincipal, STRUCT_CCC);
    }
  });

  it("getLegalEntity: 403 with the calendar key, the full DTO with accounting.entity.read; the manifest carries accounting.entity.read and the structure keeps accounting.read", async () => {
    await assert.rejects(legal.getLegalEntity(context({ permissions: ["accounting.read"] as UserContext["permissions"] }), structEntityId), ForbiddenError);
    const dto = await legal.getLegalEntity(context({ permissions: ["accounting.entity.read"] as UserContext["permissions"] }), structEntityId);
    assert.equal(dto.taxId, NIF_STRUCT);
    assert.equal(dto.fiscalAddress, STRUCT_FISCAL_ADDRESS);
    assert.deepEqual(findRoutePermission("GET", "/legal-entities/:legalEntityId")?.permissions, ["accounting.entity.read"]);
    assert.deepEqual(findRoutePermission("GET", "/organizations/me/structure")?.permissions, ["accounting.read"]);
    assert.equal(legal.hasEntityWideRead({ permissions: ["accounting.read"] as UserContext["permissions"] }), false);
    assert.equal(legal.hasEntityWideRead({ permissions: ["accounting.entity.read"] as UserContext["permissions"] }), true);
    assert.equal(legal.hasEntityWideRead({ permissions: [] as UserContext["permissions"], isPlatformAdmin: true }), true);
  });
});

// ── t6b#12 ──────────────────────────────────────────────────────────────────

describe("t6b#12 · carpeta de inspección: titular = sociedad", () => {
  it("prints the razón social and the NIF of the sociedad and the trade name of the centre; Property.legalName never appears", async () => {
    const data = await inspection.getInspectionFolderData(PROP_HN, "Tester T6b");
    assert.ok(data.titular, "the sociedad is the titular of the establishment");
    assert.equal(data.titular.legalName, STRUCT_LEGAL_NAME);
    assert.equal(data.titular.taxId, NIF_STRUCT);
    assert.equal(data.titular.fiscalAddress?.includes(STRUCT_FISCAL_ADDRESS), true);
    assert.equal(data.property.tradeName, HN_TRADE_NAME);
    assert.equal(data.property.name, `Hotel Norte ${RUN}`);
    assert.equal("legalName" in data.property, false, "no razón social hangs from the property block");
    const html = inspection.buildInspectionFolderHtml(data);
    assert.ok(html.includes(`Titular: <strong>${STRUCT_LEGAL_NAME}</strong> · NIF ${NIF_STRUCT}`), html.slice(0, 2000));
    assert.ok(html.includes(HN_TRADE_NAME));
    assert.ok(!html.includes(DEPRECATED_TRADE_NAME), "the deprecated Property.legalName is never printed");
  });
});

// ── t6b#13 ──────────────────────────────────────────────────────────────────

describe("t6b#13 · base de los schedulers operativos", () => {
  it("listOperationalProperties (the scheduler basis) returns the hotel of the onboarded tenant and skips its office", async () => {
    const rows = await scope.listOperationalProperties(ORG_NEW, prisma, { includeClosed: true });
    assert.deepEqual(rows.map((row) => row.id), [PROP_NEW]);
    assert.equal(await prisma.property.count({ where: { organizationId: ORG_NEW, kind: "office" } }), 1, "the office exists but never enters an operational loop");
  });
});
