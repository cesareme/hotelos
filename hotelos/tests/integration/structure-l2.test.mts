/**
 * Estructura societaria · L2 · integration (Postgres required; in-process services
 * plus REAL HTTP via app.inject on the demo tenant for the route layer).
 *
 * An ISOLATED organisation (`L2 Test Hotels <run>`) is created through the real
 * createTenant (admin console) and removed in `after`; everything the suite
 * writes hangs from it. Faranda and org_123 are only READ (org_123 additionally
 * receives HTTP dry-runs that write nothing). Criteria of design §6 that belong
 * to this lot (C2 series per establishment under one NIF, C6 office as a
 * non-operational centre, the createTenant / structure / CRUD contract of §5.4):
 *   · createTenant → implicit legal entity (isDefault, coded, NIF pending) and a
 *     coded `hotel` centre linked to it; Organization.legalName/taxId untouched;
 *   · GET structure → single_hotel, then multi_center after an office is added;
 *     POST /legal-entities → 409 MULTI_ENTITY_NOT_ENABLED;
 *   · PATCH sociedad → 400 TAX_ID_INVALID, 409 TAX_ID_IN_USE (Faranda's NIF, read
 *     only), 409 HIGH_RISK_CONFIRMATION_REQUIRED, 403 without ai.high_risk.confirm,
 *     200 + LEGAL_ENTITY_UPDATED audit with confirmation;
 *   · alta de centro: dryRun writes nothing; an office has no rooms, is excluded
 *     by listOperationalProperties, refused by the night audit (409
 *     WORK_CENTER_NOT_OPERATIONAL) and shows kind/code in the switcher;
 *   · series: FAC-<año>- for the single billing centre, FAC-<código>-<año>- once a
 *     second one exists, 409 SERIES_PREFIX_CLASH { conflictingPropertyId } from
 *     patchBillingSettings and from the provisioning apply (dryRun lists it);
 *     never a NULL prefix; 409 CODE_IN_USE; 409 PROPERTY_NAME_IN_USE;
 *   · ficha del centro: 409 PROPERTY_KIND_CHANGE_BLOCKED for a hotel with rooms;
 *     the property profile answers 409 LEGAL_IDENTITY_MANAGED_BY_LEGAL_ENTITY when
 *     it tries to change the NIF and never writes Organization.taxId; the
 *     readiness issuer checks read the sociedad;
 *   · chain policy from the console: 403 for a hotel owner, change allowed with
 *     sandbox-only records, 409 CHAIN_ALREADY_STARTED once a production record exists.
 *
 * Run from the repo root:
 *   cd apps/api && node --import tsx --test "../../tests/integration/structure-l2.test.mts"
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
const { buildApiServer } = await import("../../apps/api/src/server.js");
const { routePermissionManifest } = await import("../../apps/api/src/security/route-permissions.js");
const { registerStructureRoutes } = await import("../../apps/api/src/modules/structure/structure.routes.js");
const { structureRoutePermissions } = await import("../../apps/api/src/modules/structure/route-permissions.partial.js");
const legal = await import("../../apps/api/src/modules/structure/legal-entity.service.js");
const provisioning = await import("../../apps/api/src/modules/structure/property-provisioning.service.js");
const { createTenant } = await import("../../apps/api/src/modules/admin-console/tenant-admin.service.js");
const backoffice = await import("../../apps/api/src/modules/backoffice/backoffice.service.js");
const { listOperationalProperties } = await import("../../apps/api/src/lib/tenancy.js");
const { resolveLegalIdentity } = await import("../../apps/api/src/lib/finance-scope.js");
const { getComplianceHealth } = await import("../../apps/api/src/modules/compliance/compliance-health.service.js");
const { runNightAudit } = await import("../../apps/api/src/modules/night-audit/night-audit.service.js");
const { flushAuditQueues } = await import("../../apps/api/src/modules/audit/audit.service.js");
const { BadRequestError, ConflictError, ForbiddenError, NotFoundError } = await import("../../apps/api/src/lib/http-error.js");
type UserContext = import("../../apps/api/src/lib/demo-store.js").UserContext;
type ApiApp = Awaited<ReturnType<typeof buildApiServer>>;

const RUN = Date.now().toString(36);
const FARANDA_ORG = "cmrhw9jy30002fyvb6tsdiugt";
const FARANDA_TAX_ID = "B99999997";
/** Checksum-valid CIF no demo tenant uses (A58818501: sum 29 → control 1). */
const NEW_TAX_ID = "A58818501";
const YEAR = backoffice.madridYear();
const ORG_NAME = `L2 Test Hotels ${RUN}`;
const LEGAL_NAME = `L2 Test Hotels SA ${RUN}`;
const HOTEL1_NAME = `Hotel L2 Norte ${RUN}`;
const HOTEL2_NAME = `Hotel L2 Sur ${RUN}`;
const OFFICE_NAME = `Oficina central L2 ${RUN}`;

let app: ApiApp;
let prefix = "";
let headers: Record<string, string> = {};
let ORG = "";
let entityId = "";
let hotel1Id = "";
let hotel2Id: string | null = null;
let officeId: string | null = null;
let ownerUserId = "";
let ownerRoleId = "";
const createdInvoiceIds: string[] = [];

const details = (error: unknown): Record<string, unknown> => ((error as { details?: Record<string, unknown> }).details ?? {}) as Record<string, unknown>;
const code = (error: unknown): unknown => details(error).code;

function ownerContext(extra: Partial<UserContext> = {}): UserContext {
  return {
    organizationId: ORG,
    propertyId: hotel1Id,
    userId: ownerUserId,
    fullName: "Owner L2",
    deviceId: "dev_l2_owner",
    permissions: [
      "organization.structure.manage",
      "accounting.read",
      "accounting.configure",
      "billing.configure",
      "property.configure",
      "property_profile.edit",
      "accounting.journal.post"
    ] as UserContext["permissions"],
    isPlatformAdmin: false,
    ...extra
  };
}

function platformContext(): UserContext {
  return {
    organizationId: ORG,
    propertyId: hotel1Id,
    userId: "usr_l2_platform_admin",
    fullName: "Platform L2",
    deviceId: "dev_l2_platform",
    permissions: ["admin.tenants.manage"] as UserContext["permissions"],
    isPlatformAdmin: true
  };
}

async function cleanup(): Promise<void> {
  if (!ORG) return;
  const properties = await prisma.property.findMany({ where: { organizationId: ORG }, select: { id: true } });
  const propertyIds = properties.map((row) => row.id);
  const users = await prisma.user.findMany({ where: { organizationId: ORG }, select: { id: true } });
  const userIds = users.map((row) => row.id);
  const roles = await prisma.role.findMany({ where: { organizationId: ORG }, select: { id: true } });
  const taxes = await prisma.tax.findMany({ where: { organizationId: ORG }, select: { id: true } });
  const entities = await prisma.legalEntity.findMany({ where: { organizationId: ORG }, select: { id: true } });
  if (propertyIds.length > 0) {
    await prisma.verifactuSubmission.deleteMany({ where: { propertyId: { in: propertyIds } } });
    await prisma.invoice.deleteMany({ where: { propertyId: { in: propertyIds } } });
    await prisma.invoiceSequence.deleteMany({ where: { propertyId: { in: propertyIds } } });
    await prisma.room.deleteMany({ where: { propertyId: { in: propertyIds } } });
    await prisma.roomType.deleteMany({ where: { propertyId: { in: propertyIds } } });
    await prisma.floor.deleteMany({ where: { propertyId: { in: propertyIds } } });
    await prisma.building.deleteMany({ where: { propertyId: { in: propertyIds } } });
    await prisma.ratePlan.deleteMany({ where: { propertyId: { in: propertyIds } } });
    await prisma.userPropertyRole.deleteMany({ where: { propertyId: { in: propertyIds } } });
    await prisma.department.deleteMany({ where: { propertyId: { in: propertyIds } } });
    await prisma.propertyModule.deleteMany({ where: { propertyId: { in: propertyIds } } });
    await prisma.propertyAiSetting.deleteMany({ where: { propertyId: { in: propertyIds } } });
    await prisma.propertyComplianceSetting.deleteMany({ where: { propertyId: { in: propertyIds } } });
    await prisma.compliancePropertyProfile.deleteMany({ where: { propertyId: { in: propertyIds } } });
    await prisma.propertyReadinessCheck.deleteMany({ where: { propertyId: { in: propertyIds } } });
    await prisma.nightAuditRun.deleteMany({ where: { propertyId: { in: propertyIds } } });
  }
  if (userIds.length > 0) {
    await prisma.userDepartment.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.session.deleteMany({ where: { userId: { in: userIds } } });
  }
  if (taxes.length > 0) {
    await prisma.taxRate.deleteMany({ where: { taxId: { in: taxes.map((row) => row.id) } } });
    await prisma.tax.deleteMany({ where: { organizationId: ORG } });
  }
  if (roles.length > 0) await prisma.rolePermission.deleteMany({ where: { roleId: { in: roles.map((row) => row.id) } } });
  await prisma.role.deleteMany({ where: { organizationId: ORG } });
  await prisma.userInvitation.deleteMany({ where: { organizationId: ORG } });
  await prisma.user.deleteMany({ where: { organizationId: ORG } });
  if (entities.length > 0) await prisma.verifactuInstallation.deleteMany({ where: { legalEntityId: { in: entities.map((row) => row.id) } } });
  await prisma.property.deleteMany({ where: { organizationId: ORG } });
  await prisma.legalEntity.deleteMany({ where: { organizationId: ORG } });
  await prisma.organization.deleteMany({ where: { id: ORG } });
}

before(async () => {
  // The app boot hydrates the hash-chained audit trail: every in-process write
  // below seals its events on the real Postgres tip.
  app = await buildApiServer();
  const wired = app.hasRoute({ method: "GET", url: "/organizations/me/structure" });
  if (!wired) {
    prefix = "/__structure-l2";
    routePermissionManifest.push(...structureRoutePermissions.map((entry) => ({ ...entry, path: `${prefix}${entry.path}` })));
    await app.register(async (sub) => registerStructureRoutes(sub), { prefix });
  }
  await app.ready();
  const login = await app.inject({
    method: "POST",
    url: "/auth/login",
    payload: { email: process.env.INTEGRATION_LOGIN_EMAIL ?? "reception@example.com", password: process.env.INTEGRATION_LOGIN_PASSWORD ?? "hotelos-demo", deviceId: "integration-tests-structure-l2" }
  });
  headers = login.statusCode === 200 ? { authorization: `Bearer ${(JSON.parse(login.body) as { token: string }).token}` } : {};

  const created = await createTenant({
    context: platformContext(),
    organizationName: ORG_NAME,
    organizationCountry: "ES",
    property: { name: HOTEL1_NAME, type: "hotel", municipality: "Oleiros", province: "A Coruña", postalCode: "15172", ineMunicipalityCode: "15058" },
    ownerUser: { email: `l2-owner-${RUN}@example.test`, fullName: "Owner L2" },
    modulesEnabled: [],
    plan: "starter",
    legalEntity: { legalName: LEGAL_NAME, legalForm: "sa" }
  });
  ORG = created.organizationId;
  entityId = created.legalEntityId;
  hotel1Id = created.propertyId;
  ownerUserId = created.ownerUserId;
  const role = await prisma.userPropertyRole.findFirstOrThrow({ where: { userId: ownerUserId, propertyId: hotel1Id } });
  ownerRoleId = role.roleId;
});

after(async () => {
  try {
    await flushAuditQueues();
    await cleanup();
  } finally {
    await app?.close();
    await prisma.$disconnect();
  }
});

describe("createTenant · sociedad implícita y primer centro", () => {
  it("creates exactly one default legal entity (NIF pending) and a coded hotel linked to it; Organization columns stay untouched", async () => {
    const entities = await prisma.legalEntity.findMany({ where: { organizationId: ORG } });
    assert.equal(entities.length, 1);
    const entity = entities[0]!;
    assert.equal(entity.id, entityId);
    assert.equal(entity.isDefault, true);
    assert.equal(entity.legalName, LEGAL_NAME);
    assert.equal(entity.taxId, null, "no NIF was sent: pending");
    assert.equal(entity.legalForm, "sa");
    assert.match(entity.code, /^[A-Z0-9]{2,6}$/);
    assert.equal(entity.verifactuChainScope, "per_center");
    const property = await prisma.property.findUniqueOrThrow({ where: { id: hotel1Id } });
    assert.equal(property.legalEntityId, entity.id);
    assert.equal(property.kind, "hotel");
    assert.match(property.code ?? "", /^[A-Z0-9]{2,6}$/);
    const organization = await prisma.organization.findUniqueOrThrow({ where: { id: ORG } });
    assert.equal(organization.legalName, null, "no espejo: the deprecated column is not written");
    assert.equal(organization.taxId, null);
  });

  it("GET structure → single_hotel with TAX_ID_PENDING; a second legal entity is 409 MULTI_ENTITY_NOT_ENABLED", async () => {
    const structure = await legal.getStructure(ownerContext());
    assert.equal(structure.mode, "single_hotel");
    assert.deepEqual(structure.counts, { properties: 1, hotels: 1, offices: 0, others: 0, legalEntities: 1 });
    assert.equal(structure.legalEntity?.id, entityId);
    assert.equal(structure.legalEntity?.properties.length, 1);
    assert.equal(structure.legalEntity?.properties[0]?.kind, "hotel");
    assert.deepEqual(structure.legalEntity?.properties[0]?.series, []);
    assert.deepEqual(structure.warnings, ["TAX_ID_PENDING"]);
    await assert.rejects(legal.createLegalEntity({ context: ownerContext(), body: { legalName: "Segunda SL" }, correlationId: "corr_l2" }), (error: unknown) => {
      assert.ok(error instanceof ConflictError);
      assert.equal(code(error), "MULTI_ENTITY_NOT_ENABLED");
      assert.equal(details(error).legalEntityId, entityId);
      return true;
    });
    assert.equal(await prisma.legalEntity.count({ where: { organizationId: ORG } }), 1);
  });

  it("Faranda (read only) resolves to multi_center with RA / LT under FAR", async () => {
    const structure = await legal.getStructure({ ...ownerContext(), organizationId: FARANDA_ORG });
    assert.equal(structure.mode, "multi_center");
    assert.equal(structure.legalEntity?.code, "FAR");
    assert.equal(structure.legalEntity?.taxId, FARANDA_TAX_ID);
    assert.deepEqual(structure.legalEntity?.properties.map((p) => p.code).sort(), ["LT", "RA"]);
    assert.equal(structure.counts.hotels, 2);
  });
});

describe("PATCH sociedad · NIF con checksum, unicidad y confirmación de alto riesgo", () => {
  it("400 TAX_ID_INVALID for a bad checksum; 409 TAX_ID_IN_USE for Faranda's NIF (never names the tenant)", async () => {
    await assert.rejects(legal.patchLegalEntity({ context: ownerContext({ permissions: [...ownerContext().permissions, "ai.high_risk.confirm"] }), legalEntityId: entityId, body: { taxId: "B12345678", confirmHighRisk: true }, correlationId: "corr_l2" }), (error: unknown) => {
      assert.ok(error instanceof BadRequestError);
      assert.equal(code(error), "TAX_ID_INVALID");
      return true;
    });
    await assert.rejects(legal.patchLegalEntity({ context: ownerContext({ permissions: [...ownerContext().permissions, "ai.high_risk.confirm"] }), legalEntityId: entityId, body: { taxId: FARANDA_TAX_ID, confirmHighRisk: true }, correlationId: "corr_l2" }), (error: unknown) => {
      assert.ok(error instanceof ConflictError);
      assert.equal(code(error), "TAX_ID_IN_USE");
      assert.doesNotMatch(error.message, /Faranda|cmrhw9jy/);
      return true;
    });
    assert.equal((await prisma.legalEntity.findUniqueOrThrow({ where: { id: entityId } })).taxId, null, "nothing written");
    assert.equal((await prisma.legalEntity.findFirstOrThrow({ where: { organizationId: FARANDA_ORG } })).taxId, FARANDA_TAX_ID, "Faranda untouched");
  });

  it("changing the NIF needs ai.high_risk.confirm (403) and confirmHighRisk (409 HIGH_RISK_CONFIRMATION_REQUIRED); confirmed → 200 + audit", async () => {
    await assert.rejects(legal.patchLegalEntity({ context: ownerContext(), legalEntityId: entityId, body: { taxId: NEW_TAX_ID, confirmHighRisk: true }, correlationId: "corr_l2" }), (error: unknown) => {
      assert.equal((error as { statusCode?: number }).statusCode, 403);
      return true;
    });
    const confirming = ownerContext({ permissions: [...ownerContext().permissions, "ai.high_risk.confirm"] });
    await assert.rejects(legal.patchLegalEntity({ context: confirming, legalEntityId: entityId, body: { taxId: NEW_TAX_ID }, correlationId: "corr_l2" }), (error: unknown) => {
      assert.ok(error instanceof ConflictError);
      assert.equal(code(error), "HIGH_RISK_CONFIRMATION_REQUIRED");
      assert.equal(details(error).nextTaxId, NEW_TAX_ID);
      return true;
    });
    const updated = await legal.patchLegalEntity({ context: confirming, legalEntityId: entityId, body: { taxId: ` ${NEW_TAX_ID.toLowerCase()} `, confirmHighRisk: true, cnae: "5510", pgcVariant: "general" }, correlationId: "corr_l2_nif" });
    assert.equal(updated.taxId, NEW_TAX_ID);
    assert.equal(updated.taxIdValid, true);
    assert.equal(updated.cnae, "5510");
    assert.equal(updated.pgcVariant, "general");
    await flushAuditQueues();
    const audit = await prisma.auditEvent.findFirst({ where: { organizationId: ORG, action: "LEGAL_ENTITY_UPDATED", entityId: entityId }, orderBy: { createdAt: "desc" } });
    assert.ok(audit, "LEGAL_ENTITY_UPDATED audited");
    assert.equal((audit.afterJson as { highRisk?: boolean }).highRisk, true);
    // A same-value write is not a change: no confirmation needed.
    const same = await legal.patchLegalEntity({ context: ownerContext(), legalEntityId: entityId, body: { taxId: NEW_TAX_ID, legalForm: "sl" }, correlationId: "corr_l2" });
    assert.equal(same.legalForm, "sl");
    assert.deepEqual((await legal.getStructure(ownerContext())).warnings, []);
  });
});

describe("Alta de oficina central (C6) · centro sin operación hotelera", () => {
  const officeBody = () => ({
    property: { name: OFFICE_NAME, kind: "office" as const, code: "OC", municipality: "Madrid", province: "Madrid", census: { surfaceM2: "320.50", socialSecurityCcc: "28012345678" } },
    profile: {},
    owners: [],
    modules: [],
    ratePlans: [],
    invoiceSequences: [],
    departments: []
  });

  it("dryRun plans the office (no rooms, no building) and writes nothing", async () => {
    const result = await provisioning.provisionCentre({ context: ownerContext(), legalEntityId: entityId, body: { ...provisioning.pilotSpecSchema.omit({ organizationId: true }).parse(officeBody()), dryRun: true }, correlationId: "corr_l2" });
    assert.equal(result.dryRun, true);
    assert.equal(result.property.code, "OC");
    assert.equal(result.property.kind, "office");
    const tables = result.plan.writes.map((w) => `${w.op}:${w.table}`);
    assert.ok(tables.includes("create:properties"));
    assert.ok(!tables.some((t) => t.endsWith(":rooms") || t.endsWith(":buildings") || t.endsWith(":room_types")), tables.join(", "));
    assert.ok(tables.includes("create:user_property_roles"), "owners default to the caller's roles");
    assert.deepEqual(result.prefixClash, []);
    assert.equal(await prisma.property.count({ where: { organizationId: ORG } }), 1, "dry-run wrote nothing");
  });

  it("apply creates the office linked to the legal entity; structure → multi_center; operational loops ignore it", async () => {
    const result = await provisioning.provisionCentre({ context: ownerContext(), legalEntityId: entityId, body: provisioning.pilotSpecSchema.omit({ organizationId: true }).parse(officeBody()), correlationId: "corr_l2_office" });
    assert.ok(result.applied);
    officeId = result.applied.propertyId;
    const office = await prisma.property.findUniqueOrThrow({ where: { id: officeId } });
    assert.equal(office.kind, "office");
    assert.equal(office.code, "OC");
    assert.equal(office.legalEntityId, entityId);
    assert.equal(office.surfaceM2?.toFixed(2), "320.50");
    assert.equal(office.socialSecurityCcc, "28012345678");
    assert.equal(office.sesHospedajesEnabled, false);
    assert.equal(await prisma.room.count({ where: { propertyId: officeId } }), 0);
    assert.equal(await prisma.userPropertyRole.count({ where: { propertyId: officeId, userId: ownerUserId, roleId: ownerRoleId } }), 1);
    assert.ok(result.applied.postConditions.every((c) => c.ok), JSON.stringify(result.applied.postConditions));
    assert.equal(result.applied.establishment.kind, "office");

    const structure = await legal.getStructure(ownerContext());
    assert.equal(structure.mode, "multi_center");
    assert.deepEqual(structure.counts, { properties: 2, hotels: 1, offices: 1, others: 0, legalEntities: 1 });
    assert.deepEqual((await listOperationalProperties(ORG)).map((p) => p.id), [hotel1Id], "the office never enters an operational loop");

    const switchable = await legal.listSwitchableProperties(ownerContext());
    const rows = switchable.filter((row) => row.organizationId === ORG);
    assert.equal(rows.length, 2);
    const officeRow = rows.find((row) => row.id === officeId)!;
    assert.equal(officeRow.kind, "office");
    assert.equal(officeRow.code, "OC");
    assert.equal(officeRow.legalEntityId, entityId);
    assert.equal(officeRow.legalEntityName, LEGAL_NAME);
    assert.equal(rows.find((row) => row.id === hotel1Id)?.kind, "hotel");

    await assert.rejects(runNightAudit({ context: ownerContext(), propertyId: officeId, correlationId: "corr_l2" }), (error: unknown) => {
      assert.ok(error instanceof ConflictError);
      assert.equal(code(error), "WORK_CENTER_NOT_OPERATIONAL");
      return true;
    });
    assert.equal(await prisma.nightAuditRun.count({ where: { propertyId: officeId } }), 0);

    // t6b#17 (R6): the head office without a series is neither an SES establishment nor an issuer.
    const health = await getComplianceHealth(ORG);
    assert.deepEqual(health.organization.issuers.map((row) => row.propertyId), [hotel1Id], "issuers = hotels only while the office does not bill");
    assert.ok(!health.organization.sesEstablishmentIncomplete.propertyIds.includes(officeId), "SES block never lists the office");
    assert.equal(JSON.stringify(health.organization).includes(officeId), false, "the office id appears nowhere in the organization block");
  });
});

describe("Series por establecimiento con el mismo NIF (C2)", () => {
  const hotel2Body = (overrides: Record<string, unknown> = {}) =>
    provisioning.pilotSpecSchema.omit({ organizationId: true }).parse({
      property: { name: HOTEL2_NAME, kind: "hotel", code: "H2", municipality: "Teo", province: "A Coruña", postalCode: "15894", ineMunicipalityCode: "15082" },
      owners: [{ userId: ownerUserId, roleId: ownerRoleId }],
      building: { name: "Edificio principal", code: "MAIN", floors: 1 },
      totalRooms: 2,
      roomTypes: { items: [{ code: "DBL", name: "Doble", baseCapacity: 2, maxOccupancy: 3, count: 2 }] },
      invoiceSequences: [{ sequenceCode: "FAC", invoiceType: "F1", year: YEAR }],
      ...overrides
    });

  it("a single billing centre keeps FAC-<año>- (prefix: null → R3 default, never NULL)", async () => {
    const settings = await backoffice.patchBillingSettings({ context: ownerContext(), propertyId: hotel1Id, correlationId: "corr_l2", invoiceSequence: { sequenceCode: "FAC", invoiceType: "F1", prefix: null as unknown as string, year: YEAR } });
    const fac = settings.invoiceSequences.find((row) => row.sequenceCode === "FAC")!;
    assert.equal(fac.prefix, `FAC-${YEAR}-`, "the office without series is not a billing centre");
    const row = await prisma.invoiceSequence.findFirstOrThrow({ where: { propertyId: hotel1Id, sequenceCode: "FAC", year: YEAR } });
    assert.equal(row.prefix, `FAC-${YEAR}-`);
    assert.equal(row.legalEntityId, entityId);
  });

  it("a second hotel gets FAC-<código>-<año>- by default (dryRun shows it) and is created with it", async () => {
    const dry = await provisioning.provisionCentre({ context: ownerContext(), legalEntityId: entityId, body: { ...hotel2Body(), dryRun: true }, correlationId: "corr_l2" });
    assert.deepEqual(dry.series.map((s) => [s.sequenceCode, s.prefix, s.prefixSource, s.clash]), [["FAC", `FAC-H2-${YEAR}-`, "default", null]]);
    assert.equal(await prisma.property.count({ where: { organizationId: ORG } }), 2);
    const result = await provisioning.provisionCentre({ context: ownerContext(), legalEntityId: entityId, body: hotel2Body(), correlationId: "corr_l2_hotel2" });
    assert.ok(result.applied);
    hotel2Id = result.applied.propertyId;
    const seq = await prisma.invoiceSequence.findFirstOrThrow({ where: { propertyId: hotel2Id, sequenceCode: "FAC" } });
    assert.equal(seq.prefix, `FAC-H2-${YEAR}-`);
    assert.equal(seq.legalEntityId, entityId);
    assert.equal(await prisma.room.count({ where: { propertyId: hotel2Id } }), 2);
    assert.equal((await prisma.invoiceSequence.findFirstOrThrow({ where: { propertyId: hotel1Id, sequenceCode: "FAC" } })).prefix, `FAC-${YEAR}-`, "the first hotel is never renumbered");
  });

  it("409 SERIES_PREFIX_CLASH from patchBillingSettings and from the provisioning apply; the dryRun lists the clash", async () => {
    await assert.rejects(
      backoffice.patchBillingSettings({ context: ownerContext({ propertyId: hotel2Id! }), propertyId: hotel2Id!, correlationId: "corr_l2", invoiceSequence: { sequenceCode: "REC", invoiceType: "R1", prefix: `FAC-${YEAR}-`, year: YEAR } }),
      (error: unknown) => {
        assert.ok(error instanceof ConflictError);
        assert.equal(code(error), "SERIES_PREFIX_CLASH");
        assert.equal(details(error).conflictingPropertyId, hotel1Id);
        return true;
      }
    );
    assert.equal(await prisma.invoiceSequence.count({ where: { propertyId: hotel2Id!, sequenceCode: "REC" } }), 0);
    const clashing = hotel2Body({ property: { name: `Hotel L2 Este ${RUN}`, kind: "hotel", code: "H3" }, invoiceSequences: [{ sequenceCode: "FAC", invoiceType: "F1", year: YEAR, prefix: `fac-h2-${YEAR}-` }] });
    const dry = await provisioning.provisionCentre({ context: ownerContext(), legalEntityId: entityId, body: { ...clashing, dryRun: true }, correlationId: "corr_l2" });
    assert.equal(dry.prefixClash.length, 1);
    assert.equal(dry.prefixClash[0]?.conflictingPropertyId, hotel2Id);
    assert.ok(dry.plan.conflicts.some((c) => c.includes("prefijo «fac-h2-")));
    await assert.rejects(provisioning.provisionCentre({ context: ownerContext(), legalEntityId: entityId, body: clashing, correlationId: "corr_l2" }), (error: unknown) => {
      assert.equal(code(error), "SERIES_PREFIX_CLASH");
      assert.equal(details(error).conflictingPropertyId, hotel2Id);
      return true;
    });
    assert.equal(await prisma.property.count({ where: { organizationId: ORG } }), 3, "nothing created on a clash");
  });

  it("the office becomes a billing centre with a coded prefix; sociedad-wide series list has 0 clashes", async () => {
    const settings = await backoffice.patchBillingSettings({ context: ownerContext({ propertyId: officeId! }), propertyId: officeId!, correlationId: "corr_l2", invoiceSequence: { sequenceCode: "FAC", invoiceType: "F1", year: YEAR } });
    assert.equal(settings.invoiceSequences.find((row) => row.sequenceCode === "FAC")?.prefix, `FAC-OC-${YEAR}-`);
    const list = await legal.listLegalEntitySeries(ownerContext(), entityId);
    assert.equal(list.clashCount, 0);
    assert.deepEqual(list.series.map((row) => [row.propertyCode, row.prefix]).sort(), [["H2", `FAC-H2-${YEAR}-`], ["OC", `FAC-OC-${YEAR}-`], [(await prisma.property.findUniqueOrThrow({ where: { id: hotel1Id } })).code, `FAC-${YEAR}-`]].sort());
    assert.equal(await prisma.invoiceSequence.count({ where: { propertyId: { in: [hotel1Id, hotel2Id!, officeId!] }, prefix: null } }), 0, "never a NULL prefix");
    // t6b#17 (R6): once the office bills it is one more issuer of the sociedad in the compliance health.
    const health = await getComplianceHealth(ORG);
    assert.deepEqual(health.organization.issuers.map((row) => row.propertyId).sort(), [hotel1Id, hotel2Id!, officeId!].sort());
    assert.ok(!health.organization.sesEstablishmentIncomplete.propertyIds.includes(officeId!), "billing does not make the office a lodging establishment");
  });

  it("R3 · re-activating a closed series whose prefix a sister centre took meanwhile is a 409 SERIES_PREFIX_CLASH (t6b#3)", async () => {
    const recOf = (settings: Awaited<ReturnType<typeof backoffice.patchBillingSettings>>) => settings.invoiceSequences.find((row) => row.sequenceCode === "REC")!;
    // Hotel 1 opens REC-<año>- and closes it: a closed prefix never clashes (it is closed, never renumbered).
    await backoffice.patchBillingSettings({ context: ownerContext(), propertyId: hotel1Id, correlationId: "corr_l2", invoiceSequence: { sequenceCode: "REC", invoiceType: "R1", prefix: `REC-${YEAR}-`, year: YEAR } });
    const closed = recOf(await backoffice.patchBillingSettings({ context: ownerContext(), propertyId: hotel1Id, correlationId: "corr_l2", invoiceSequence: { sequenceCode: "REC", invoiceType: "R1", year: YEAR, active: false } }));
    assert.equal(closed.active, false);
    // Hotel 2 takes the very same prefix: allowed, the sister row is closed.
    const taken = recOf(await backoffice.patchBillingSettings({ context: ownerContext({ propertyId: hotel2Id! }), propertyId: hotel2Id!, correlationId: "corr_l2", invoiceSequence: { sequenceCode: "REC", invoiceType: "R1", prefix: `REC-${YEAR}-`, year: YEAR } }));
    assert.equal(taken.prefix, `REC-${YEAR}-`);
    assert.equal(taken.active, true);
    // Hotel 1 re-opens its closed series without touching the prefix (the probe of the review): checked as if new.
    await assert.rejects(
      backoffice.patchBillingSettings({ context: ownerContext(), propertyId: hotel1Id, correlationId: "corr_l2", invoiceSequence: { sequenceCode: "REC", invoiceType: "R1", year: YEAR, active: true } }),
      (error: unknown) => {
        assert.ok(error instanceof ConflictError);
        assert.equal(code(error), "SERIES_PREFIX_CLASH");
        assert.equal(details(error).conflictingPropertyId, hotel2Id);
        assert.equal(details(error).prefix, `REC-${YEAR}-`);
        return true;
      }
    );
    const active = await prisma.invoiceSequence.findMany({ where: { propertyId: { in: [hotel1Id, hotel2Id!] }, sequenceCode: "REC", year: YEAR, active: true }, select: { propertyId: true } });
    assert.deepEqual(active.map((row) => row.propertyId), [hotel2Id], "exactly one active REC-<año>- under the NIF");
    // Patching the closed row while leaving it closed (numbering only) is not a clash.
    const stillClosed = recOf(await backoffice.patchBillingSettings({ context: ownerContext(), propertyId: hotel1Id, correlationId: "corr_l2", invoiceSequence: { sequenceCode: "REC", invoiceType: "R1", year: YEAR, padding: 5 } }));
    assert.equal(stillClosed.active, false);
    assert.equal(stillClosed.padding, 5);
    // Re-opening under a free prefix succeeds (no invoice issued, so the prefix may change).
    const reopened = recOf(await backoffice.patchBillingSettings({ context: ownerContext(), propertyId: hotel1Id, correlationId: "corr_l2", invoiceSequence: { sequenceCode: "REC", invoiceType: "R1", prefix: `REC-H1-${YEAR}-`, year: YEAR, active: true } }));
    assert.equal(reopened.active, true);
    assert.equal(reopened.prefix, `REC-H1-${YEAR}-`);
    assert.equal((await legal.listLegalEntitySeries(ownerContext(), entityId)).clashCount, 0);
  });

  it("409 CODE_IN_USE for a taken centre code and 409 PROPERTY_NAME_IN_USE for a repeated name", async () => {
    const takenCode = hotel2Body({ property: { name: `Hotel L2 Oeste ${RUN}`, kind: "hotel", code: "OC" }, invoiceSequences: [] });
    const dry = await provisioning.provisionCentre({ context: ownerContext(), legalEntityId: entityId, body: { ...takenCode, dryRun: true }, correlationId: "corr_l2" });
    assert.ok(dry.plan.conflicts.some((c) => c.includes("code «OC»")));
    await assert.rejects(provisioning.provisionCentre({ context: ownerContext(), legalEntityId: entityId, body: takenCode, correlationId: "corr_l2" }), (error: unknown) => code(error) === "CODE_IN_USE");
    await assert.rejects(provisioning.provisionCentre({ context: ownerContext(), legalEntityId: entityId, body: hotel2Body({ property: { name: HOTEL1_NAME, kind: "hotel", code: "H9" }, invoiceSequences: [] }), correlationId: "corr_l2" }), (error: unknown) => code(error) === "PROPERTY_NAME_IN_USE");
    assert.equal(await prisma.property.count({ where: { organizationId: ORG } }), 3);
  });
});

describe("Ficha del centro y perfil sin NIF", () => {
  it("a hotel with rooms cannot become an office (409); code uniqueness; census fields update", async () => {
    await assert.rejects(provisioning.patchEstablishment({ context: ownerContext(), propertyId: hotel2Id!, patch: { kind: "office" }, correlationId: "corr_l2" }), (error: unknown) => {
      assert.equal(code(error), "PROPERTY_KIND_CHANGE_BLOCKED");
      assert.equal(details(error).rooms, 2);
      return true;
    });
    await assert.rejects(provisioning.patchEstablishment({ context: ownerContext(), propertyId: officeId!, patch: { code: "H2" }, correlationId: "corr_l2" }), (error: unknown) => code(error) === "CODE_IN_USE");
    const dto = await provisioning.patchEstablishment({ context: ownerContext(), propertyId: officeId!, patch: { tradeName: "Oficina central L2", bedCapacity: 0, iaeEpigraph: "999" }, correlationId: "corr_l2" });
    assert.equal(dto.tradeName, "Oficina central L2");
    assert.equal(dto.bedCapacity, 0);
    assert.equal(dto.iaeEpigraph, "999");
    assert.equal(dto.surfaceM2, "320.50");
    await assert.rejects(provisioning.patchEstablishment({ context: { ...ownerContext(), organizationId: FARANDA_ORG }, propertyId: officeId!, patch: { code: "XX" }, correlationId: "corr_l2" }), NotFoundError, "another organization's property is opaque");
  });

  it("the property profile refuses to change the NIF (409 LEGAL_IDENTITY_MANAGED_BY_LEGAL_ENTITY) and never writes Organization.taxId; trade name and code are saved", async () => {
    const base = { name: HOTEL1_NAME, address: "Rúa Real 1", country: "ES", city: "Oleiros", province: "A Coruña", timezone: "Europe/Madrid", currency: "EUR" };
    await assert.rejects(
      backoffice.savePropertySetupForm({ context: ownerContext(), propertyId: hotel1Id, correlationId: "corr_l2", formCode: "property_profile", payload: { ...base, taxId: "B12345674", legalName: LEGAL_NAME } }),
      (error: unknown) => {
        assert.ok(error instanceof ConflictError, `${(error as Error).name}: ${(error as Error).message}`);
        assert.equal(code(error), "LEGAL_IDENTITY_MANAGED_BY_LEGAL_ENTITY");
        assert.deepEqual(details(error).fields, ["taxId"]);
        return true;
      }
    );
    assert.equal((await prisma.organization.findUniqueOrThrow({ where: { id: ORG } })).taxId, null);
    await backoffice.savePropertySetupForm({
      context: ownerContext(),
      propertyId: hotel1Id,
      correlationId: "corr_l2_profile",
      formCode: "property_profile",
      payload: { ...base, legalName: LEGAL_NAME, taxId: NEW_TAX_ID, tradeName: `${HOTEL1_NAME} by Test`, code: "h1" }
    });
    const property = await prisma.property.findUniqueOrThrow({ where: { id: hotel1Id } });
    assert.equal(property.tradeName, `${HOTEL1_NAME} by Test`);
    assert.equal(property.code, "H1");
    assert.equal(property.address, "Rúa Real 1");
    const organization = await prisma.organization.findUniqueOrThrow({ where: { id: ORG } });
    assert.equal(organization.legalName, null);
    assert.equal(organization.taxId, null);
    assert.equal((await prisma.legalEntity.findUniqueOrThrow({ where: { id: entityId } })).taxId, NEW_TAX_ID);
  });

  it("readiness issuer checks read the sociedad (razón social and NIF pass; Property.legalName is never read)", async () => {
    const readiness = await backoffice.recalculateReadiness({ context: ownerContext(), propertyId: hotel1Id, correlationId: "corr_l2" });
    const checks = (readiness as { checks: Array<{ checkCode: string; status: string; message: string; relatedEntityType?: string }> }).checks;
    const name = checks.find((c) => c.checkCode === "issuer_legal_name_set")!;
    const nif = checks.find((c) => c.checkCode === "issuer_tax_id_valid")!;
    assert.equal(name.status, "pass");
    assert.match(name.message, new RegExp(LEGAL_NAME.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.equal(nif.status, "pass");
    assert.match(nif.message, /A58818501/);
    assert.equal(name.relatedEntityType, "legal_entity");
  });
});

describe("Política de cadena VeriFactu · consola de plataforma (R7)", () => {
  it("a hotel owner cannot set it (403); the console can while no REAL record exists; sandbox records never block", async () => {
    await assert.rejects(legal.setVerifactuChainScope({ context: ownerContext(), legalEntityId: entityId, scope: "per_entity", correlationId: "corr_l2" }), (error: unknown) => (error as { statusCode?: number }).statusCode === 403);
    const changed = await legal.setVerifactuChainScope({ context: platformContext(), legalEntityId: entityId, scope: "per_entity", correlationId: "corr_l2_scope" });
    assert.equal(changed.changed, true);
    assert.equal(changed.legalEntity.verifactuChainScope, "per_entity");
    assert.equal((await legal.setVerifactuChainScope({ context: platformContext(), legalEntityId: entityId, scope: "per_entity", correlationId: "corr_l2" })).changed, false);
    // Sandbox emission: the policy may still change.
    const sandboxInvoice = await prisma.invoice.create({ data: { id: `inv_l2_sbx_${RUN}`, propertyId: hotel1Id, legalEntityId: entityId, invoiceNumber: `FAC-${YEAR}-000001`, invoiceType: "F1", customerType: "company", status: "issued", issuedAt: new Date(), seriesCode: "FAC" } });
    createdInvoiceIds.push(sandboxInvoice.id);
    await prisma.verifactuSubmission.create({ data: { invoiceId: sandboxInvoice.id, propertyId: hotel1Id, status: "accepted", registroType: "alta", mode: "sandbox", softwareJson: {} } });
    const back = await legal.setVerifactuChainScope({ context: platformContext(), legalEntityId: entityId, scope: "per_center", correlationId: "corr_l2" });
    assert.equal(back.changed, true);
    assert.equal(back.realSubmissions, 0);
    await flushAuditQueues();
    assert.equal(await prisma.auditEvent.count({ where: { organizationId: ORG, action: "VERIFACTU_CHAIN_SCOPE_CHANGED" } }), 2);
  });

  it("409 CHAIN_ALREADY_STARTED once a production record was sent; installations list reflects the current policy", async () => {
    const realInvoice = await prisma.invoice.create({ data: { id: `inv_l2_prod_${RUN}`, propertyId: hotel1Id, legalEntityId: entityId, invoiceNumber: `FAC-${YEAR}-000002`, invoiceType: "F1", customerType: "company", status: "issued", issuedAt: new Date(), seriesCode: "FAC" } });
    createdInvoiceIds.push(realInvoice.id);
    await prisma.verifactuSubmission.create({ data: { invoiceId: realInvoice.id, propertyId: hotel1Id, status: "accepted", registroType: "alta", mode: "production", softwareJson: {} } });
    await assert.rejects(legal.setVerifactuChainScope({ context: platformContext(), legalEntityId: entityId, scope: "per_entity", correlationId: "corr_l2" }), (error: unknown) => {
      assert.ok(error instanceof ConflictError);
      assert.equal(code(error), "CHAIN_ALREADY_STARTED");
      assert.equal(details(error).realSubmissions, 1);
      return true;
    });
    assert.equal((await prisma.legalEntity.findUniqueOrThrow({ where: { id: entityId } })).verifactuChainScope, "per_center");
    const installations = await legal.listInstallations(ownerContext(), entityId);
    assert.equal(installations.chainScope, "per_center");
    assert.deepEqual(installations.installations, [], "L2 opens no installation: the issuing side (L3) does");
  });
});

describe("PATCH sociedad · SII, gran empresa, PGC y ejercicio son cambios de alto riesgo (R8 / R9, t6b#8)", () => {
  const confirming = (): UserContext => ownerContext({ permissions: [...ownerContext().permissions, "ai.high_risk.confirm"] });
  const withoutAccounting = (base: UserContext): UserContext => ({ ...base, permissions: base.permissions.filter((key) => key !== "accounting.configure") });
  const regimeOf = async () => {
    const row = await prisma.legalEntity.findUniqueOrThrow({ where: { id: entityId } });
    return { sii: row.siiEnabled, large: row.largeCompany, pgc: row.pgcVariant, month: row.fiscalYearStartMonth, name: row.legalName };
  };

  it("403 without ai.high_risk.confirm · 403 without accounting.configure · 409 HIGH_RISK_CONFIRMATION_REQUIRED without confirmHighRisk — nothing written", async () => {
    const before = await regimeOf();
    await assert.rejects(legal.patchLegalEntity({ context: ownerContext(), legalEntityId: entityId, body: { siiEnabled: true, largeCompany: true, pgcVariant: "pymes", confirmHighRisk: true }, correlationId: "corr_l2" }), (error: unknown) => {
      assert.equal((error as { statusCode?: number }).statusCode, 403, "the probe of the review: an owner without ai.high_risk.confirm");
      return true;
    });
    await assert.rejects(legal.patchLegalEntity({ context: withoutAccounting(confirming()), legalEntityId: entityId, body: { largeCompany: true, confirmHighRisk: true }, correlationId: "corr_l2" }), (error: unknown) => {
      assert.equal((error as { statusCode?: number }).statusCode, 403, "regime fields live in «IVA y ejercicio»: accounting.configure");
      return true;
    });
    await assert.rejects(legal.patchLegalEntity({ context: confirming(), legalEntityId: entityId, body: { siiEnabled: true, largeCompany: true, fiscalYearStartMonth: 7 }, correlationId: "corr_l2" }), (error: unknown) => {
      assert.ok(error instanceof ConflictError);
      assert.equal(code(error), "HIGH_RISK_CONFIRMATION_REQUIRED");
      assert.equal(details(error).field, "siiEnabled");
      assert.deepEqual(details(error).fields, ["siiEnabled", "largeCompany", "fiscalYearStartMonth"]);
      assert.deepEqual((details(error).changes as Record<string, unknown>).siiEnabled, { from: false, to: true });
      assert.match(error.message, /RIVA art\. 71\.3/);
      return true;
    });
    // The razón social (Datos fiscales) is high risk too, without the accounting.configure requirement.
    await assert.rejects(legal.patchLegalEntity({ context: withoutAccounting(confirming()), legalEntityId: entityId, body: { legalName: `${LEGAL_NAME} Renombrada` }, correlationId: "corr_l2" }), (error: unknown) => {
      assert.ok(error instanceof ConflictError);
      assert.equal(code(error), "HIGH_RISK_CONFIRMATION_REQUIRED");
      assert.equal(details(error).field, "legalName");
      return true;
    });
    assert.deepEqual(await regimeOf(), before, "nothing written by the refused patches");
  });

  it("409 VERIFACTU_SUBMISSIONS_PENDING while a REAL record awaits the AEAT; resolved → confirmed flip → regime read by resolveLegalIdentity → audited", async () => {
    const pendingInvoice = await prisma.invoice.create({ data: { id: `inv_l2_pend_${RUN}`, propertyId: hotel1Id, legalEntityId: entityId, invoiceNumber: `FAC-${YEAR}-000003`, invoiceType: "F1", customerType: "company", status: "issued", issuedAt: new Date(), seriesCode: "FAC" } });
    createdInvoiceIds.push(pendingInvoice.id);
    const submission = await prisma.verifactuSubmission.create({ data: { invoiceId: pendingInvoice.id, propertyId: hotel1Id, status: "retrying", registroType: "alta", mode: "production", softwareJson: {} } });
    await assert.rejects(legal.patchLegalEntity({ context: confirming(), legalEntityId: entityId, body: { siiEnabled: true, confirmHighRisk: true }, correlationId: "corr_l2" }), (error: unknown) => {
      assert.ok(error instanceof ConflictError);
      assert.equal(code(error), "VERIFACTU_SUBMISSIONS_PENDING");
      assert.equal(details(error).unresolvedSubmissions, 1);
      assert.equal(details(error).field, "siiEnabled");
      return true;
    });
    assert.equal((await regimeOf()).sii, false);
    // The sandbox record of the R7 test and the accepted production one never count; a resolved queue unblocks.
    await prisma.verifactuSubmission.update({ where: { id: submission.id }, data: { status: "accepted" } });
    const flipped = await legal.patchLegalEntity({ context: confirming(), legalEntityId: entityId, body: { siiEnabled: true, largeCompany: true, confirmHighRisk: true }, correlationId: "corr_l2_sii" });
    assert.equal(flipped.siiEnabled, true);
    assert.equal(flipped.largeCompany, true);
    const identity = await resolveLegalIdentity(ORG);
    assert.equal(identity?.siiEnabled, true, "R8 readers (303 periodicity, 347/390, VeriFactu) see the sociedad's regime");
    assert.equal(identity?.largeCompany, true);
    await flushAuditQueues();
    const audit = await prisma.auditEvent.findFirst({ where: { organizationId: ORG, action: "LEGAL_ENTITY_UPDATED", entityId: entityId, correlationId: "corr_l2_sii" } });
    assert.ok(audit, "LEGAL_ENTITY_UPDATED audited with the correlation of the confirmed flip");
    const afterJson = audit.afterJson as { highRisk: boolean; highRiskFields: string[]; regimeFields: string[]; confirmHighRisk: boolean; changedFields: string[] };
    assert.equal(afterJson.highRisk, true);
    assert.deepEqual(afterJson.highRiskFields, ["siiEnabled", "largeCompany"]);
    assert.deepEqual(afterJson.regimeFields, ["siiEnabled", "largeCompany"]);
    assert.equal(afterJson.confirmHighRisk, true);
    assert.deepEqual((audit.beforeJson as { siiEnabled: boolean }).siiEnabled, false);
    // Leaving the SII is high risk as well (409 without confirm) but never blocked by pending records.
    await assert.rejects(legal.patchLegalEntity({ context: confirming(), legalEntityId: entityId, body: { siiEnabled: false, largeCompany: false }, correlationId: "corr_l2" }), (error: unknown) => code(error) === "HIGH_RISK_CONFIRMATION_REQUIRED");
    const back = await legal.patchLegalEntity({ context: confirming(), legalEntityId: entityId, body: { siiEnabled: false, largeCompany: false, confirmHighRisk: true }, correlationId: "corr_l2" });
    assert.equal(back.siiEnabled, false);
    assert.equal(back.largeCompany, false);
    // A same-value regime write is not a change: a plain owner may re-save the form.
    const same = await legal.patchLegalEntity({ context: ownerContext(), legalEntityId: entityId, body: { siiEnabled: false, largeCompany: false, pgcVariant: "general", fiscalYearStartMonth: 1, cnae: "5520" }, correlationId: "corr_l2" });
    assert.equal(same.cnae, "5520");
    assert.equal(same.pgcVariant, "general");
  });
});

describe("HTTP · rutas de estructura sobre el tenant demo (app.inject, solo lecturas y dry-runs)", () => {
  const url = (path: string): string => `${prefix}${path}`;

  it("GET /organizations/me/structure answers the demo tenant's structure; POST /legal-entities is 409; strict bodies are 400", async () => {
    assert.ok(headers.authorization, "the demo login (reception@example.com) is required for the high-risk routes");
    const structure = await app.inject({ method: "GET", url: url("/organizations/me/structure"), headers });
    assert.equal(structure.statusCode, 200, structure.body);
    const body = JSON.parse(structure.body) as { mode: string; organization: { id: string }; legalEntity: { code: string; properties: Array<{ code: string | null }> } | null };
    assert.equal(body.organization.id, "org_123");
    assert.equal(body.mode, "multi_center");
    assert.equal(body.legalEntity?.code, "HD");
    assert.deepEqual(body.legalEntity?.properties.map((p) => p.code).sort(), ["AMC", "ATS"]);

    const second = await app.inject({ method: "POST", url: url("/legal-entities"), headers, payload: { legalName: "Otra SL" } });
    assert.equal(second.statusCode, 409, second.body);
    assert.equal((JSON.parse(second.body) as { details: { code: string } }).details.code, "MULTI_ENTITY_NOT_ENABLED");

    const demoEntity = await prisma.legalEntity.findFirstOrThrow({ where: { organizationId: "org_123", isDefault: true } });
    const bad = await app.inject({ method: "PATCH", url: url(`/legal-entities/${demoEntity.id}`), headers, payload: { legalName: "X", foo: 1 } });
    assert.equal(bad.statusCode, 400, bad.body);
    assert.equal((JSON.parse(bad.body) as { details: { code: string } }).details.code, "VALIDATION_ERROR");
    // t6b#8 through the wire: the regime of the NIF never flips on a bare PATCH (403 without the grants, 409 without confirmHighRisk).
    const sii = await app.inject({ method: "PATCH", url: url(`/legal-entities/${demoEntity.id}`), headers, payload: { siiEnabled: !demoEntity.siiEnabled, largeCompany: !demoEntity.largeCompany } });
    assert.ok([403, 409].includes(sii.statusCode), `expected 403/409, got ${sii.statusCode}: ${sii.body}`);
    if (sii.statusCode === 409) assert.equal((JSON.parse(sii.body) as { details: { code: string } }).details.code, "HIGH_RISK_CONFIRMATION_REQUIRED");
    const demoAfter = await prisma.legalEntity.findUniqueOrThrow({ where: { id: demoEntity.id } });
    assert.equal(demoAfter.siiEnabled, demoEntity.siiEnabled, "org_123 regime untouched");
    assert.equal(demoAfter.largeCompany, demoEntity.largeCompany);
    const missing = await app.inject({ method: "GET", url: url("/legal-entities/le_missing_l2"), headers });
    assert.equal(missing.statusCode, 404);
    const unconfirmed = await app.inject({ method: "POST", url: url(`/admin/legal-entities/${demoEntity.id}/verifactu-scope`), headers, payload: { scope: "per_entity" } });
    assert.ok([400, 403].includes(unconfirmed.statusCode), `confirm is mandatory (400) — or the demo user is not a platform admin (403): got ${unconfirmed.statusCode}`);
  });

  it("POST /legal-entities/:id/properties with dryRun validates the wizard step without writing; STRUCTURE_ENABLED=false hides the routes (404)", async () => {
    const demoEntity = await prisma.legalEntity.findFirstOrThrow({ where: { organizationId: "org_123", isDefault: true } });
    const before = await prisma.property.count({ where: { organizationId: "org_123" } });
    const dry = await app.inject({
      method: "POST",
      url: url(`/legal-entities/${demoEntity.id}/properties`),
      headers,
      payload: { dryRun: true, property: { name: `Oficina L2 HTTP ${RUN}`, kind: "office", code: "OH" } }
    });
    assert.equal(dry.statusCode, 200, dry.body);
    const result = JSON.parse(dry.body) as { dryRun: boolean; property: { code: string; kind: string }; applied: unknown };
    assert.equal(result.dryRun, true);
    assert.equal(result.property.code, "OH");
    assert.equal(result.applied, null);
    assert.equal(await prisma.property.count({ where: { organizationId: "org_123" } }), before, "dry-run wrote nothing in org_123");

    const previous = process.env.STRUCTURE_ENABLED;
    process.env.STRUCTURE_ENABLED = "false";
    try {
      const hidden = await app.inject({ method: "GET", url: url("/organizations/me/structure"), headers });
      assert.equal(hidden.statusCode, 404);
      assert.equal((JSON.parse(hidden.body) as { details: { code: string } }).details.code, "STRUCTURE_DISABLED");
    } finally {
      if (previous === undefined) delete process.env.STRUCTURE_ENABLED;
      else process.env.STRUCTURE_ENABLED = previous;
    }
  });
});
