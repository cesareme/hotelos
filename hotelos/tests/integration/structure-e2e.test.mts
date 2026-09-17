/**
 * Estructura societaria · L9 · end-to-end (Postgres required; REAL HTTP via
 * app.inject with REAL sessions, in-process services only where no route exists).
 *
 * The whole product journey of design §6 in ONE isolated organisation created
 * through the real createTenant (`E2E Hoteles <run>`) and removed in `after`:
 *   A · hotel individual: single_hotel, «NIF pendiente» → NIF fixed with the
 *       high-risk confirmation, series FAC-<año>- (flat, R3), switcher fields,
 *       second sociedad 409 MULTI_ENTITY_NOT_ENABLED;
 *   B · asistente «Añadir centro»: dryRun (series «Libre» / «Ya usado por …»),
 *       second hotel with FAC-H2-<año>-, office without rooms, multi_center,
 *       sociedad-wide series without clashes, 409 PROPERTY_KIND_CHANGE_BLOCKED;
 *   C · two hotels of the same NIF issue without collision through
 *       POST /invoices/drafts + /issue; issuer = sociedad + establishment block;
 *       issuer snapshot and installation number immutable (triggers);
 *   D · office: expense with centre 201 / without centre 400 WORK_CENTER_REQUIRED /
 *       foreign centre 404; payroll of the office → Modelo 111 of the sociedad;
 *       FiscalYear with propertyId 400; excluded from night audit, portfolio,
 *       SES health and the operational filter;
 *   E · USALI por centro: «Oficina central» column, roll-up exact, informative
 *       allocation that adds up to 100 % of the office cost and writes ZERO asientos;
 *   F · permissions (REAL grants, demo union off): a director of H2 only reads
 *       H2 (redacted structure, 404 ENTITY_SCOPE_REQUIRED, 403 on management);
 *       the directora reads the whole sociedad; Faranda is opaque (404) for both;
 *   G · SII regime: monthly forced, 347/390 «no se presenta», VeriFactu excluded
 *       with reason on the next invoice;
 *   H · backfill idempotent over the product-created organisation (0 writes);
 *   I · equivalence of Faranda (read only): 61 asientos, 4300 = 379,00, 303 Q3
 *       bases 578,66 · cuota 74,94, multi_center RA / LT under FAR.
 *
 * Faranda and org_123 are never written; Faranda's counts are compared before /
 * after. VERIFACTU_MODE is pinned to sandbox (stub). Run from the repo root:
 *   cd apps/api && node --import tsx --test "../../tests/integration/structure-e2e.test.mts"
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
process.env.VERIFACTU_MODE = "sandbox";
delete process.env.STRUCTURE_ENABLED;

const { prisma, hashPassword } = await import("@hotelos/database");
const { isValidSpanishTaxId } = await import("@hotelos/compliance");
const { buildApiServer } = await import("../../apps/api/src/server.js");
const { createTenant } = await import("../../apps/api/src/modules/admin-console/tenant-admin.service.js");
const { provisionOrganizationChart } = await import("../../apps/api/src/modules/accounting/chart-of-accounts.service.js");
const { getStructure } = await import("../../apps/api/src/modules/structure/legal-entity.service.js");
const { listOperationalProperties } = await import("../../apps/api/src/lib/finance-scope.js");
const { buildModelo303 } = await import("../../apps/api/src/modules/accounting/modelo-303.service.js");
const backfill = await import("../../apps/api/src/scripts/backfill-legal-structure.js");
const { flushAuditQueues } = await import("../../apps/api/src/modules/audit/audit.service.js");
const { flushAccountingProjection } = await import("../../apps/api/src/modules/accounting/projection.js");
const { flushExtraProjections } = await import("../../apps/api/src/modules/accounting/posting-rules/index.js");
const { flushVerifactuQueue } = await import("../../apps/api/src/modules/invoicing/verifactu-submission.service.js");
const { madridYear } = await import("../../apps/api/src/modules/backoffice/backoffice.service.js");
type UserContext = import("../../apps/api/src/lib/demo-store.js").UserContext;
type ApiApp = Awaited<ReturnType<typeof buildApiServer>>;
type Headers = Record<string, string>;
type ErrorBody = { statusCode?: number; message?: string; details?: Record<string, unknown> & { code?: string } };

const RUN = Date.now().toString(36);
const YEAR = madridYear();
const FARANDA_ORG = "cmrhw9jy30002fyvb6tsdiugt";
const FARANDA_RA = "cmrhw9jy40003fyvbuu2ec2w7";
const ORG_NAME = `E2E Hoteles ${RUN}`;
const LEGAL_NAME = `E2E Hoteles Test SA ${RUN}`;
const H1_NAME = `Hotel E2E Norte ${RUN}`;
const H2_NAME = `Hotel E2E Sur ${RUN}`;
const H3_NAME = `Hotel E2E Este ${RUN}`;
const OFFICE_NAME = `Oficina central E2E ${RUN}`;
const DIRECTORA_EMAIL = `directora.e2e.${RUN}@e2e.test`;
const DIRECTORA_PASSWORD = `E2E-directora-${RUN}-Aa1!`;
const DIRECTOR_EMAIL = `director.sur.e2e.${RUN}@e2e.test`;
const DIRECTOR_PASSWORD = `E2E-director-${RUN}-Aa1!`;
/** July 2026 is the only month with ledger activity of this suite: the USALI figures are deterministic. */
const JULY = { from: "2026-07-01", to: "2026-07-31" };

/** Checksum-valid CIF derived from the run (letter B → numeric control) so parallel suites never share a NIF. */
function cifFor(letter: string, seed: number): string {
  const digits = String(Math.abs(seed) % 10_000_000).padStart(7, "0");
  let even = 0;
  let odd = 0;
  for (let i = 0; i < 7; i += 1) {
    const d = Number(digits[i]);
    if (i % 2 === 1) even += d;
    else {
      const doubled = d * 2;
      odd += doubled >= 10 ? doubled - 9 : doubled;
    }
  }
  const control = (10 - ((even + odd) % 10)) % 10;
  return `${letter}${digits}${control}`;
}
const TAX_ID = cifFor("B", Date.now() + 4_242);

/** REAL grants of the directora: the whole sociedad (Owner + «Finanzas de toda la sociedad» + «Estructura»). */
const DIRECTORA_KEYS = [
  "organization.structure.manage",
  "accounting.read",
  "accounting.reports.read",
  "accounting.entity.read",
  "accounting.configure",
  "accounting.journal.post",
  "billing.configure",
  "billing.compliance.view",
  "ai.high_risk.confirm",
  "invoice.issue",
  "invoice.read",
  "payroll.manage",
  "payroll.read",
  "analytics.read",
  "banking.read",
  "property.configure",
  "property_profile.edit"
] as const;
/** REAL grants of the director of H2: reads with amounts, posting and issuing — never the entity key nor the structure key. */
const DIRECTOR_KEYS = ["accounting.read", "accounting.reports.read", "accounting.journal.post", "invoice.issue", "invoice.read", "banking.read"] as const;

/**
 * The repo .env (HOTELOS_ALLOW_DEMO_AUTH=true, NODE_ENV=development) enables the
 * dev/demo permission UNION: every real session also holds the demoStore
 * baseline (with both new keys). The union is read per request, so every HTTP
 * case that proves the REAL role model pins the strict setting for its duration.
 */
const REAL_GRANTS_ENV: Record<string, string | undefined> = { HOTELOS_ALLOW_DEMO_AUTH: "false", NODE_ENV: "test" };
function withEnv<T>(overrides: Record<string, string | undefined>, run: () => Promise<T>): Promise<T> {
  const previous = Object.fromEntries(Object.keys(overrides).map((key) => [key, process.env[key]]));
  const apply = (entries: Record<string, string | undefined>): void => {
    for (const [key, value] of Object.entries(entries)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
  apply(overrides);
  return run().finally(() => apply(previous));
}

let app: ApiApp;
let ORG = "";
let entityId = "";
let H1 = "";
let H2 = "";
let OC = "";
let H1_CODE = "";
let ownerUserId = "";
let directoraUserId = "";
let directoraRoleId = "";
let directorUserId: string | null = null;
let directorRoleId: string | null = null;
let directora: Headers = {};
let director: Headers = {};
let catalogueComplete = false;
let installationId: string | null = null;
let farandaBefore: Record<string, number | string> = {};
const invoices: { h1?: string; h2?: string; sii?: string } = {};

type Json<T> = { status: number; body: T; text: string };
async function call<T>(method: "GET" | "POST" | "PATCH" | "PUT", url: string, headers: Headers, payload?: unknown): Promise<Json<T>> {
  const res = await app.inject({ method, url, headers, ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }) });
  let body: T;
  try {
    body = JSON.parse(res.body) as T;
  } catch {
    body = null as T;
  }
  return { status: res.statusCode, body, text: res.body };
}
function get<T>(url: string, headers: Headers): Promise<Json<T>> {
  return call<T>("GET", url, headers);
}
function post<T>(url: string, headers: Headers, payload: unknown): Promise<Json<T>> {
  return call<T>("POST", url, headers, payload);
}
function patch<T>(url: string, headers: Headers, payload: unknown): Promise<Json<T>> {
  return call<T>("PATCH", url, headers, payload);
}
function put<T>(url: string, headers: Headers, payload: unknown): Promise<Json<T>> {
  return call<T>("PUT", url, headers, payload);
}

function expectCode(res: Json<ErrorBody>, status: number, code: string, label = ""): ErrorBody {
  assert.equal(res.status, status, `${label} → ${res.text.slice(0, 300)}`);
  assert.equal(res.body?.details?.code, code, `${label} → ${res.text.slice(0, 300)}`);
  return res.body;
}

async function login(email: string, password: string, deviceId: string): Promise<Headers> {
  const res = await app.inject({ method: "POST", url: "/auth/login", payload: { email, password, deviceId } });
  if (res.statusCode !== 200) return {};
  return { authorization: `Bearer ${(JSON.parse(res.body) as { token: string }).token}` };
}

const farandaCtx: UserContext = {
  organizationId: FARANDA_ORG,
  propertyId: FARANDA_RA,
  userId: "usr_e2e_probe",
  fullName: "Probe E2E",
  deviceId: "e2e-probe",
  permissions: ["accounting.read", "accounting.reports.read", "accounting.entity.read", "organization.structure.manage"] as UserContext["permissions"]
};

async function farandaCounts(): Promise<Record<string, number | string>> {
  const entries = await prisma.journalEntry.findMany({ where: { organizationId: FARANDA_ORG }, select: { id: true } });
  const properties = await prisma.property.findMany({ where: { organizationId: FARANDA_ORG }, select: { id: true, code: true, kind: true, legalEntityId: true } });
  const entity = await prisma.legalEntity.findFirst({ where: { organizationId: FARANDA_ORG, isDefault: true }, select: { id: true, code: true, taxId: true, siiEnabled: true, largeCompany: true } });
  return {
    properties: JSON.stringify(properties),
    entity: JSON.stringify(entity),
    journalEntries: entries.length,
    journalLines: await prisma.journalLine.count({ where: { journalEntryId: { in: entries.map((e) => e.id) } } }),
    invoices: await prisma.invoice.count({ where: { propertyId: { in: properties.map((p) => p.id) } } }),
    sequences: await prisma.invoiceSequence.count({ where: { propertyId: { in: properties.map((p) => p.id) } } }),
    installations: await prisma.verifactuInstallation.count({ where: { legalEntity: { organizationId: FARANDA_ORG } } }),
    submissions: await prisma.verifactuSubmission.count({ where: { propertyId: { in: properties.map((p) => p.id) } } }),
    vatSettings: await prisma.vatSettings.count({ where: { organizationId: FARANDA_ORG } }),
    payrollPeriods: await prisma.payrollPeriod.count({ where: { organizationId: FARANDA_ORG } })
  };
}

async function cleanup(): Promise<void> {
  if (!ORG) return;
  const propertyIds = (await prisma.property.findMany({ where: { organizationId: ORG }, select: { id: true } })).map((row) => row.id);
  const userIds = (await prisma.user.findMany({ where: { organizationId: ORG }, select: { id: true } })).map((row) => row.id);
  const roleIds = (await prisma.role.findMany({ where: { organizationId: ORG }, select: { id: true } })).map((row) => row.id);
  const taxIds = (await prisma.tax.findMany({ where: { organizationId: ORG }, select: { id: true } })).map((row) => row.id);
  const entityIds = (await prisma.legalEntity.findMany({ where: { organizationId: ORG }, select: { id: true } })).map((row) => row.id);
  const invoiceIds = propertyIds.length ? (await prisma.invoice.findMany({ where: { propertyId: { in: propertyIds } }, select: { id: true } })).map((row) => row.id) : [];
  if (invoiceIds.length) {
    await prisma.verifactuSubmission.deleteMany({ where: { invoiceId: { in: invoiceIds } } });
    await prisma.invoiceLine.deleteMany({ where: { invoiceId: { in: invoiceIds } } });
    await prisma.invoice.updateMany({ where: { id: { in: invoiceIds } }, data: { rectifyingForId: null } });
    await prisma.invoice.deleteMany({ where: { id: { in: invoiceIds } } });
  }
  await prisma.withholdingTaxRecord.deleteMany({ where: { organizationId: ORG } });
  const periods = await prisma.payrollPeriod.findMany({ where: { organizationId: ORG }, select: { id: true } });
  const slips = periods.length ? await prisma.payrollSlip.findMany({ where: { periodId: { in: periods.map((p) => p.id) } }, select: { id: true } }) : [];
  if (slips.length) await prisma.payrollLine.deleteMany({ where: { slipId: { in: slips.map((s) => s.id) } } });
  if (slips.length) await prisma.payrollSlip.deleteMany({ where: { id: { in: slips.map((s) => s.id) } } });
  await prisma.payrollPeriod.deleteMany({ where: { organizationId: ORG } });
  await prisma.employmentContract.deleteMany({ where: { organizationId: ORG } });
  if (propertyIds.length) await prisma.staffProfile.deleteMany({ where: { propertyId: { in: propertyIds } } });
  const entries = await prisma.journalEntry.findMany({ where: { organizationId: ORG }, select: { id: true } });
  if (entries.length) await prisma.journalLine.deleteMany({ where: { journalEntryId: { in: entries.map((e) => e.id) } } });
  await prisma.journalEntry.deleteMany({ where: { organizationId: ORG } });
  await prisma.vatBookEntry.deleteMany({ where: { organizationId: ORG } });
  await prisma.vatSettings.deleteMany({ where: { organizationId: ORG } });
  await prisma.fiscalPeriod.deleteMany({ where: { organizationId: ORG } });
  await prisma.fiscalYear.deleteMany({ where: { organizationId: ORG } });
  await prisma.financialStatementSnapshot.deleteMany({ where: { organizationId: ORG } });
  await prisma.gestoriaExport.deleteMany({ where: { organizationId: ORG } });
  await prisma.account.deleteMany({ where: { organizationId: ORG } });
  await prisma.accountingSetting.deleteMany({ where: { organizationId: ORG } });
  await prisma.bankAccount.deleteMany({ where: { organizationId: ORG } });
  if (propertyIds.length) {
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
  if (userIds.length) {
    await prisma.userDepartment.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.session.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.device.deleteMany({ where: { userId: { in: userIds } } });
  }
  if (taxIds.length) {
    await prisma.taxRate.deleteMany({ where: { taxId: { in: taxIds } } });
    await prisma.tax.deleteMany({ where: { organizationId: ORG } });
  }
  if (roleIds.length) await prisma.rolePermission.deleteMany({ where: { roleId: { in: roleIds } } });
  await prisma.role.deleteMany({ where: { organizationId: ORG } });
  await prisma.userInvitation.deleteMany({ where: { organizationId: ORG } });
  await prisma.user.deleteMany({ where: { organizationId: ORG } });
  if (entityIds.length) await prisma.verifactuInstallation.deleteMany({ where: { legalEntityId: { in: entityIds } } });
  await prisma.property.deleteMany({ where: { organizationId: ORG } });
  await prisma.legalEntity.deleteMany({ where: { organizationId: ORG } });
  await prisma.organization.deleteMany({ where: { id: ORG } });
}

/** Creates a REAL user with a role that holds exactly `keys` in `propertyIds`, and logs it in. */
async function createRealUser(input: { email: string; password: string; fullName: string; roleName: string; keys: readonly string[]; propertyIds: string[]; device: string }): Promise<{ userId: string; roleId: string; headers: Headers }> {
  const permissions = await prisma.permission.findMany({ where: { key: { in: [...input.keys] } }, select: { id: true } });
  const role = await prisma.role.create({ data: { organizationId: ORG, name: `${input.roleName} ${RUN}`, templateKey: null }, select: { id: true } });
  await prisma.rolePermission.createMany({ data: permissions.map((p) => ({ roleId: role.id, permissionId: p.id })) });
  const user = await prisma.user.create({
    data: { organizationId: ORG, email: input.email, fullName: input.fullName, status: "active", passwordHash: hashPassword(input.password), passwordChangedAt: new Date(), mustChangePassword: false },
    select: { id: true }
  });
  await prisma.userPropertyRole.createMany({ data: input.propertyIds.map((propertyId) => ({ userId: user.id, propertyId, roleId: role.id })) });
  return { userId: user.id, roleId: role.id, headers: await login(input.email, input.password, input.device) };
}

before(async () => {
  assert.equal(isValidSpanishTaxId(TAX_ID), true, `generated CIF ${TAX_ID} must be checksum-valid`);
  farandaBefore = await farandaCounts();
  app = await buildApiServer();
  await app.ready();

  const created = await createTenant({
    context: { organizationId: "org_123", propertyId: "prop_123", userId: "usr_e2e_platform", fullName: "Platform E2E", deviceId: "e2e-platform", permissions: ["admin.tenants.manage"] as UserContext["permissions"], isPlatformAdmin: true },
    organizationName: ORG_NAME,
    organizationCountry: "ES",
    property: { name: H1_NAME, type: "hotel", municipality: "Oleiros", province: "A Coruña", postalCode: "15172", ineMunicipalityCode: "15058" },
    ownerUser: { email: `owner.e2e.${RUN}@e2e.test`, fullName: "Owner E2E" },
    modulesEnabled: [],
    plan: "starter",
    legalEntity: { legalName: LEGAL_NAME, legalForm: "sa" }
  });
  ORG = created.organizationId;
  entityId = created.legalEntityId;
  H1 = created.propertyId;
  ownerUserId = created.ownerUserId;
  const provisioned = await provisionOrganizationChart(ORG);
  assert.ok(provisioned.created >= 200, `chart provisioned: ${JSON.stringify(provisioned)}`);

  const needed = new Set<string>([...DIRECTORA_KEYS, ...DIRECTOR_KEYS]);
  const rows = await prisma.permission.findMany({ where: { key: { in: [...needed] } }, select: { key: true } });
  catalogueComplete = rows.length === needed.size;
  if (catalogueComplete) {
    const real = await createRealUser({ email: DIRECTORA_EMAIL, password: DIRECTORA_PASSWORD, fullName: "Directora E2E", roleName: "Directora E2E", keys: DIRECTORA_KEYS, propertyIds: [H1], device: "e2e-directora" });
    directoraUserId = real.userId;
    directoraRoleId = real.roleId;
    directora = real.headers;
  }
});

after(async () => {
  try {
    await flushVerifactuQueue();
    await flushAuditQueues();
    await flushAccountingProjection();
    await flushExtraProjections();
    await cleanup();
    assert.deepEqual(await farandaCounts(), farandaBefore, "Faranda must be untouched (read-only probes)");
  } finally {
    await app?.close();
    await prisma.$disconnect();
  }
});

const ready = (t: { skip: (reason?: string) => void }): boolean => {
  if (!catalogueComplete) {
    t.skip("permission catalogue rows missing: run rbac:sync / seed before the HTTP cases");
    return false;
  }
  if (!directora.authorization) {
    t.skip("/auth/login refused the directora (HOTELOS_ALLOW_DEMO_AUTH / password policy)");
    return false;
  }
  return true;
};

type Structure = {
  organization: { id: string };
  legalEntity: {
    id: string;
    code: string;
    legalName: string;
    taxId: string | null;
    taxIdValid: boolean;
    siiEnabled: boolean;
    vatSettings: unknown;
    properties: Array<{ id: string; code: string | null; kind: string; series: Array<{ prefix: string | null; year: number | null; active: boolean }>; installation: unknown }>;
  } | null;
  mode: string;
  counts: { properties: number; hotels: number; offices: number; others: number; legalEntities: number };
  warnings: string[];
  scope: string;
};

describe("A · Hotel individual (single_hotel): la sociedad implícita y nada más cambia", () => {
  it("GET /organizations/me/structure → single_hotel, NIF pendiente, un solo hotel codificado y sin series todavía", async (t) => {
    if (!ready(t)) return;
    const res = await get<Structure>("/organizations/me/structure", directora);
    assert.equal(res.status, 200, res.text.slice(0, 300));
    assert.equal(res.body.organization.id, ORG);
    assert.equal(res.body.mode, "single_hotel");
    assert.equal(res.body.scope, "entity");
    assert.deepEqual(res.body.counts, { properties: 1, hotels: 1, offices: 0, others: 0, legalEntities: 1 });
    assert.ok(res.body.warnings.includes("TAX_ID_PENDING"), res.body.warnings.join(","));
    assert.equal(res.body.legalEntity?.id, entityId);
    assert.equal(res.body.legalEntity?.legalName, LEGAL_NAME);
    assert.equal(res.body.legalEntity?.taxId, null);
    const [hotel] = res.body.legalEntity!.properties;
    assert.equal(hotel?.id, H1);
    assert.equal(hotel?.kind, "hotel");
    assert.match(hotel?.code ?? "", /^[A-Z0-9]{2,6}$/, "the first centre is born coded");
    H1_CODE = hotel!.code!;
    assert.deepEqual(hotel?.series, []);
  });

  it("PATCH /legal-entities/:id con NIF: 409 HIGH_RISK_CONFIRMATION_REQUIRED sin confirmar; 200 confirmado, warnings vacío y aviso TAX_ID_PENDING fuera", async (t) => {
    if (!ready(t)) return;
    const unconfirmed = await patch<ErrorBody>(`/legal-entities/${entityId}`, directora, { taxId: TAX_ID });
    const body = expectCode(unconfirmed, 409, "HIGH_RISK_CONFIRMATION_REQUIRED", "PATCH NIF sin confirmHighRisk");
    assert.equal(body.details?.field, "taxId");
    assert.equal((await prisma.legalEntity.findUniqueOrThrow({ where: { id: entityId } })).taxId, null, "nothing written without confirmation");
    const confirmed = await patch<{ taxId: string; taxIdValid: boolean; warnings: string[] }>(`/legal-entities/${entityId}`, directora, { taxId: TAX_ID, fiscalAddress: "Calle Sociedad 1", fiscalPostalCode: "15001", fiscalMunicipality: "A Coruña", fiscalProvince: "A Coruña", confirmHighRisk: true });
    assert.equal(confirmed.status, 200, confirmed.text.slice(0, 300));
    assert.deepEqual([confirmed.body.taxId, confirmed.body.taxIdValid, confirmed.body.warnings], [TAX_ID, true, []]);
    const structure = await get<Structure>("/organizations/me/structure", directora);
    assert.ok(!structure.body.warnings.includes("TAX_ID_PENDING"));
    assert.equal((await prisma.organization.findUniqueOrThrow({ where: { id: ORG } })).taxId, null, "Organization.taxId is deprecated: never written");
  });

  it("la serie FAC del único centro facturador nace plana FAC-<año>- (R3) y el switcher lleva kind, code y sociedad", async (t) => {
    if (!ready(t)) return;
    const settings = await patch<{ invoiceSequences: Array<{ sequenceCode: string; prefix: string | null }> }>(`/backoffice/properties/${H1}/billing-settings`, directora, { invoiceSequence: { sequenceCode: "FAC", invoiceType: "F1", year: YEAR } });
    assert.equal(settings.status, 200, settings.text.slice(0, 300));
    assert.equal(settings.body.invoiceSequences.find((row) => row.sequenceCode === "FAC")?.prefix, `FAC-${YEAR}-`);
    const structure = await get<Structure>("/organizations/me/structure", directora);
    assert.deepEqual(structure.body.legalEntity?.properties[0]?.series.map((s) => [s.prefix, s.year, s.active]), [[`FAC-${YEAR}-`, YEAR, true]]);
    const switcher = await get<Array<{ id: string; kind: string; code: string | null; legalEntityId: string | null; legalEntityName: string | null }>>("/users/me/properties", directora);
    assert.equal(switcher.status, 200, switcher.text.slice(0, 300));
    const row = switcher.body.find((p) => p.id === H1);
    assert.deepEqual([row?.kind, row?.code, row?.legalEntityId, row?.legalEntityName], ["hotel", H1_CODE, entityId, LEGAL_NAME]);
  });

  it("POST /legal-entities (segunda sociedad) → 409 MULTI_ENTITY_NOT_ENABLED con la sociedad existente", async (t) => {
    if (!ready(t)) return;
    const res = await post<ErrorBody>("/legal-entities", directora, { legalName: "Otra Sociedad SL" });
    const body = expectCode(res, 409, "MULTI_ENTITY_NOT_ENABLED", "segunda sociedad");
    assert.equal(body.details?.legalEntityId, entityId);
    assert.equal(await prisma.legalEntity.count({ where: { organizationId: ORG } }), 1);
  });
});

type ProvisionResult = {
  dryRun: boolean;
  property: { id: string | null; code: string; kind: string };
  plan: { writes: Array<{ op: string; table: string }>; conflicts: string[] };
  series: Array<{ sequenceCode: string; prefix: string; prefixSource: string; clash: { propertyId: string } | null }>;
  prefixClash: Array<{ prefix: string; conflictingPropertyId: string }>;
  applied: { propertyId: string; establishment: { kind: string; code: string | null } } | null;
};

const hotelBody = (name: string, code: string, extra: Record<string, unknown> = {}) => ({
  property: { name, kind: "hotel", code, municipality: "Teo", province: "A Coruña", postalCode: "15894", ineMunicipalityCode: "15082", taxRegion: "ES_PENINSULA_BALEARES" },
  building: { name: "Edificio principal", code: "MAIN", floors: 1 },
  totalRooms: 2,
  roomTypes: { items: [{ code: "DBL", name: "Doble", baseCapacity: 2, maxOccupancy: 3, count: 2 }] },
  invoiceSequences: [{ sequenceCode: "FAC", invoiceType: "F1", year: YEAR }],
  ...extra
});
const officeBody = () => ({
  property: { name: OFFICE_NAME, kind: "office", code: "OC", municipality: "Madrid", province: "Madrid", census: { surfaceM2: "250.00", socialSecurityCcc: "28012345678" } },
  invoiceSequences: []
});

describe("B · Asistente «Añadir centro»: dryRun en vivo, segundo hotel, oficina central, multi_center", () => {
  it("dryRun del segundo hotel propone FAC-H2-<año>- («Libre») sin escribir nada; el apply lo crea y el primer hotel no se renumera", async (t) => {
    if (!ready(t)) return;
    const before = await prisma.property.count({ where: { organizationId: ORG } });
    const dry = await post<ProvisionResult>(`/legal-entities/${entityId}/properties`, directora, { ...hotelBody(H2_NAME, "H2"), dryRun: true });
    assert.equal(dry.status, 200, dry.text.slice(0, 300));
    assert.equal(dry.body.dryRun, true);
    assert.equal(dry.body.applied, null);
    assert.deepEqual(dry.body.series.map((s) => [s.sequenceCode, s.prefix, s.prefixSource, s.clash]), [["FAC", `FAC-H2-${YEAR}-`, "default", null]]);
    assert.deepEqual(dry.body.prefixClash, []);
    assert.equal(await prisma.property.count({ where: { organizationId: ORG } }), before, "dryRun wrote nothing");

    const applied = await post<ProvisionResult>(`/legal-entities/${entityId}/properties`, directora, hotelBody(H2_NAME, "H2"));
    assert.equal(applied.status, 200, applied.text.slice(0, 300));
    assert.ok(applied.body.applied, "applied");
    H2 = applied.body.applied!.propertyId;
    assert.equal(applied.body.applied!.establishment.kind, "hotel");
    assert.equal(applied.body.applied!.establishment.code, "H2");
    const h2Series = await prisma.invoiceSequence.findFirstOrThrow({ where: { propertyId: H2, sequenceCode: "FAC" } });
    assert.deepEqual([h2Series.prefix, h2Series.legalEntityId], [`FAC-H2-${YEAR}-`, entityId]);
    assert.equal((await prisma.invoiceSequence.findFirstOrThrow({ where: { propertyId: H1, sequenceCode: "FAC" } })).prefix, `FAC-${YEAR}-`, "never renumbered");
    assert.equal(await prisma.room.count({ where: { propertyId: H2 } }), 2);
    // The creator's roles follow the new centre (she can switch to it).
    assert.equal(await prisma.userPropertyRole.count({ where: { userId: directoraUserId, propertyId: H2, roleId: directoraRoleId } }), 1);
  });

  it("un prefijo que ya usa un centro hermano: el dryRun lo lista («Ya usado por …») y el apply responde 409 SERIES_PREFIX_CLASH sin crear el centro", async (t) => {
    if (!ready(t)) return;
    const clashing = hotelBody(H3_NAME, "H3", { invoiceSequences: [{ sequenceCode: "FAC", invoiceType: "F1", year: YEAR, prefix: `fac-${YEAR}-` }] });
    const dry = await post<ProvisionResult>(`/legal-entities/${entityId}/properties`, directora, { ...clashing, dryRun: true });
    assert.equal(dry.status, 200, dry.text.slice(0, 300));
    assert.equal(dry.body.prefixClash.length, 1);
    assert.equal(dry.body.prefixClash[0]?.conflictingPropertyId, H1);
    assert.equal(dry.body.series[0]?.clash?.propertyId, H1);
    const before = await prisma.property.count({ where: { organizationId: ORG } });
    const res = await post<ErrorBody>(`/legal-entities/${entityId}/properties`, directora, clashing);
    const body = expectCode(res, 409, "SERIES_PREFIX_CLASH", "apply con prefijo tomado");
    assert.equal(body.details?.conflictingPropertyId, H1);
    assert.equal(await prisma.property.count({ where: { organizationId: ORG } }), before, "nothing created on a clash");
  });

  it("la oficina central nace sin habitaciones ni SES; la estructura pasa a multi_center con 2 hoteles + 1 oficina y 0 colisiones", async (t) => {
    if (!ready(t)) return;
    const dry = await post<ProvisionResult>(`/legal-entities/${entityId}/properties`, directora, { ...officeBody(), dryRun: true });
    assert.equal(dry.status, 200, dry.text.slice(0, 300));
    const tables = dry.body.plan.writes.map((w) => `${w.op}:${w.table}`);
    assert.ok(tables.includes("create:properties"), tables.join(", "));
    assert.ok(!tables.some((tbl) => /rooms|buildings|room_types|rate_plans/.test(tbl)), tables.join(", "));
    const applied = await post<ProvisionResult>(`/legal-entities/${entityId}/properties`, directora, officeBody());
    assert.equal(applied.status, 200, applied.text.slice(0, 300));
    OC = applied.body.applied!.propertyId;
    const office = await prisma.property.findUniqueOrThrow({ where: { id: OC } });
    assert.deepEqual([office.kind, office.code, office.legalEntityId, office.sesHospedajesEnabled, office.surfaceM2?.toFixed(2)], ["office", "OC", entityId, false, "250.00"]);
    assert.equal(await prisma.room.count({ where: { propertyId: OC } }), 0);

    const structure = await get<Structure>("/organizations/me/structure", directora);
    assert.equal(structure.body.mode, "multi_center");
    assert.deepEqual(structure.body.counts, { properties: 3, hotels: 2, offices: 1, others: 0, legalEntities: 1 });
    assert.deepEqual(structure.body.legalEntity?.properties.map((p) => [p.code, p.kind]), [[H1_CODE, "hotel"], ["H2", "hotel"], ["OC", "office"]]);
    const series = await get<{ clashCount: number; series: Array<{ propertyCode: string | null; prefix: string | null; clash: unknown }> }>(`/legal-entities/${entityId}/series`, directora);
    assert.equal(series.status, 200, series.text.slice(0, 300));
    assert.equal(series.body.clashCount, 0);
    assert.deepEqual(series.body.series.map((row) => [row.propertyCode, row.prefix]).sort(), [[H1_CODE, `FAC-${YEAR}-`], ["H2", `FAC-H2-${YEAR}-`]].sort());
    const switcher = await get<Array<{ id: string; kind: string; code: string | null }>>("/users/me/properties", directora);
    assert.deepEqual(switcher.body.filter((p) => [H1, H2, OC].includes(p.id)).map((p) => [p.code, p.kind]).sort(), [[H1_CODE, "hotel"], ["H2", "hotel"], ["OC", "office"]].sort());
  });

  it("ficha del centro: un hotel con habitaciones no pasa a oficina (409 PROPERTY_KIND_CHANGE_BLOCKED); la oficina guarda nombre comercial y censo", async (t) => {
    if (!ready(t)) return;
    const blocked = await patch<ErrorBody>(`/properties/${H2}/establishment`, directora, { kind: "office" });
    const body = expectCode(blocked, 409, "PROPERTY_KIND_CHANGE_BLOCKED", "hotel → oficina");
    assert.equal(body.details?.rooms, 2);
    const dto = await patch<{ tradeName: string | null; iaeEpigraph: string | null; surfaceM2: string | null; kind: string }>(`/properties/${OC}/establishment`, directora, { tradeName: "Oficina central E2E", iaeEpigraph: "999" });
    assert.equal(dto.status, 200, dto.text.slice(0, 300));
    assert.deepEqual([dto.body.kind, dto.body.tradeName, dto.body.iaeEpigraph, dto.body.surfaceM2], ["office", "Oficina central E2E", "999", "250.00"]);
    const strict = await patch<ErrorBody>(`/properties/${OC}/establishment`, directora, { taxId: "B12345674" });
    assert.equal(strict.status, 400, "the establishment never accepts a NIF");
  });

  it("nace el director de H2 (rol REAL solo en H2, sin accounting.entity.read ni organization.structure.manage)", async (t) => {
    if (!ready(t)) return;
    const real = await createRealUser({ email: DIRECTOR_EMAIL, password: DIRECTOR_PASSWORD, fullName: "Director Sur E2E", roleName: "Director Sur E2E", keys: DIRECTOR_KEYS, propertyIds: [H2], device: "e2e-director" });
    directorUserId = real.userId;
    directorRoleId = real.roleId;
    director = real.headers;
    assert.ok(director.authorization, "director login");
    const me = await get<{ grantedPermissions: string[]; organizationId: string }>("/users/me", director);
    assert.equal(me.body.organizationId, ORG);
    assert.ok(!me.body.grantedPermissions.includes("accounting.entity.read"));
    assert.ok(!me.body.grantedPermissions.includes("organization.structure.manage"));
  });
});

type InvoiceView = {
  id: string;
  invoiceNumber: string;
  status: string;
  issuerTaxId?: string;
  issuerLegalName?: string;
  warnings?: string[];
  issuer?: { legalEntityId: string | null; taxId: string | null; legalName: string; fiscalAddress: unknown; establishment: { code: string | null; tradeName: string | null; addressLine: string | null } | null; verifactuExclusion: { code: string } | null };
};

async function issueInvoice(headers: Headers, propertyId: string, total: number, taxTotal: number, customerName: string): Promise<InvoiceView> {
  const draft = await post<InvoiceView>("/invoices/drafts", headers, { propertyId, invoiceType: "F1", customerType: "company", customerName, total, taxTotal });
  assert.ok([200, 201].includes(draft.status), draft.text.slice(0, 300));
  const issued = await post<InvoiceView>(`/invoices/${draft.body.id}/issue`, headers, {});
  assert.ok([200, 201].includes(issued.status), issued.text.slice(0, 300));
  return issued.body;
}

describe("C · Dos hoteles del mismo NIF emiten sin colisión; la identidad emitida y la instalación son inmutables", () => {
  it("FAC-<año>-000001 en H1 y FAC-H2-<año>-000001 en H2; emisor = sociedad + bloque establecimiento; Invoice.legalEntityId estampado", async (t) => {
    if (!ready(t)) return;
    const h1 = await issueInvoice(directora, H1, 110, 10, "Cliente Norte SL");
    const h2 = await issueInvoice(directora, H2, 220, 20, "Cliente Sur SL");
    invoices.h1 = h1.id;
    invoices.h2 = h2.id;
    assert.equal(h1.invoiceNumber, `FAC-${YEAR}-000001`);
    assert.equal(h2.invoiceNumber, `FAC-H2-${YEAR}-000001`);
    for (const inv of [h1, h2]) {
      assert.equal(inv.status, "issued");
      assert.equal(inv.issuerTaxId, TAX_ID, "the issuer is the sociedad, whichever hotel issues");
      assert.equal(inv.issuerLegalName, LEGAL_NAME);
    }
    const detail = await get<InvoiceView>(`/invoices/${h2.id}`, directora);
    assert.equal(detail.status, 200, detail.text.slice(0, 300));
    assert.equal(detail.body.issuer?.legalEntityId, entityId);
    assert.equal(detail.body.issuer?.taxId, TAX_ID);
    assert.equal(detail.body.issuer?.legalName, LEGAL_NAME);
    assert.equal(detail.body.issuer?.establishment?.code, "H2");
    assert.ok(detail.body.issuer && "fiscalAddress" in detail.body.issuer, "fiscalAddress is part of the issuer block");
    assert.equal(detail.body.issuer?.verifactuExclusion, null, "not in the SII yet");
    const rows = await prisma.invoice.findMany({ where: { id: { in: [h1.id, h2.id] } }, select: { legalEntityId: true, propertyId: true } });
    assert.deepEqual(rows.map((r) => r.legalEntityId), [entityId, entityId]);
    assert.equal(await prisma.invoice.count({ where: { propertyId: { in: [H1, H2] }, status: "issued" } }), 2);
  });

  it("el snapshot del emisor de una factura emitida no se reescribe (trigger); el número de instalación tampoco, retirarla sí", async (t) => {
    if (!ready(t)) return;
    await assert.rejects(prisma.invoice.update({ where: { id: invoices.h1! }, data: { issuerTaxId: "B12345674" } }), /issuer|inmutable|immutable/i);
    await assert.rejects(prisma.invoice.update({ where: { id: invoices.h1! }, data: { issuerLegalName: "Otra SA" } }), /issuer|inmutable|immutable/i);
    const row = await prisma.invoice.findUniqueOrThrow({ where: { id: invoices.h1! }, select: { issuerTaxId: true, issuerLegalName: true } });
    assert.deepEqual([row.issuerTaxId, row.issuerLegalName], [TAX_ID, LEGAL_NAME]);

    const installation = await prisma.verifactuInstallation.create({ data: { legalEntityId: entityId, propertyId: H1, numeroInstalacion: `E2E-${RUN.toUpperCase()}`, route: "verifactu", active: true } });
    installationId = installation.id;
    await assert.rejects(prisma.verifactuInstallation.update({ where: { id: installation.id }, data: { numeroInstalacion: `E2E-${RUN.toUpperCase()}-X` } }), /numero|inmutable|immutable/i);
    const listed = await get<{ chainScope: string; installations: Array<{ id: string; numeroInstalacion: string; propertyCode: string | null }> }>(`/legal-entities/${entityId}/verifactu/installations`, directora);
    assert.equal(listed.status, 200, listed.text.slice(0, 300));
    assert.equal(listed.body.chainScope, "per_center");
    assert.deepEqual(listed.body.installations.map((i) => [i.numeroInstalacion, i.propertyCode]), [[`E2E-${RUN.toUpperCase()}`, H1_CODE]]);
    const retired = await prisma.verifactuInstallation.update({ where: { id: installation.id }, data: { active: false, retiredAt: new Date() } });
    assert.equal(retired.active, false);
    assert.equal(retired.numeroInstalacion, `E2E-${RUN.toUpperCase()}`, "retiring never touches the number");
  });
});

type JournalEntry = { id: string; propertyId: string | null; status: string };

describe("D · Oficina central: gasto con centro / sin centro / centro ajeno, nómina en el 111, ejercicio de sociedad, fuera de la operación", () => {
  it("asiento 6/7 en la oficina → 201; sin centro → 400 WORK_CENTER_REQUIRED; centro de Faranda → 404 opaco (nada escrito allí)", async (t) => {
    if (!ready(t)) return;
    const office = await post<JournalEntry>("/accounting/journal", directora, { entryDate: "2026-07-15", description: "Asesoría oficina central (julio)", propertyId: OC, lines: [{ accountCode: "623", debit: "80.00" }, { accountCode: "410", credit: "80.00" }] });
    assert.equal(office.status, 201, office.text.slice(0, 300));
    assert.deepEqual([office.body.propertyId, office.body.status], [OC, "posted"]);
    // Revenue of the two hotels in the same month (USALI fixture of block E).
    const h1 = await post<JournalEntry>("/accounting/journal", directora, { entryDate: "2026-07-10", description: "Alojamiento julio Norte", propertyId: H1, lines: [{ accountCode: "4300", debit: "100.00" }, { accountCode: "705.1", credit: "100.00" }] });
    assert.equal(h1.status, 201, h1.text.slice(0, 300));
    const h2 = await post<JournalEntry>("/accounting/journal", directora, { entryDate: "2026-07-12", description: "Alojamiento julio Sur", propertyId: H2, lines: [{ accountCode: "4300", debit: "300.00" }, { accountCode: "705.1", credit: "300.00" }] });
    assert.equal(h2.status, 201, h2.text.slice(0, 300));

    const noCentre = await post<ErrorBody>("/accounting/journal", directora, { entryDate: "2026-07-16", description: "Suministros sin centro", lines: [{ accountCode: "628", debit: "10.00" }, { accountCode: "572", credit: "10.00" }] });
    const body = expectCode(noCentre, 400, "WORK_CENTER_REQUIRED", "asiento 6/7 sin centro");
    assert.deepEqual(body.details?.lines, [1]);

    const farandaBeforeWrite = await prisma.journalEntry.count({ where: { organizationId: FARANDA_ORG } });
    const foreign = await post<ErrorBody>("/accounting/journal", directora, { entryDate: "2026-07-16", description: "Centro ajeno", propertyId: FARANDA_RA, lines: [{ accountCode: "628", debit: "10.00" }, { accountCode: "572", credit: "10.00" }] });
    assert.equal(foreign.status, 404, foreign.text.slice(0, 300));
    assert.equal(foreign.body.message, "Propiedad no encontrada.");
    assert.equal(await prisma.journalEntry.count({ where: { organizationId: FARANDA_ORG } }), farandaBeforeWrite);
    assert.equal(await prisma.journalEntry.count({ where: { organizationId: ORG, propertyId: FARANDA_RA } }), 0);
  });

  it("ejercicios y periodos son de la sociedad: propertyId → 400 FISCAL_YEAR_IS_ENTITY_SCOPED (POST y GET)", async (t) => {
    if (!ready(t)) return;
    const created = await post<ErrorBody>("/accounting/fiscal-years", directora, { code: "2026", startDate: "2026-01-01", endDate: "2026-12-31", propertyId: OC });
    expectCode(created, 400, "FISCAL_YEAR_IS_ENTITY_SCOPED", "POST fiscal-years con propertyId");
    const listed = await get<ErrorBody>(`/accounting/fiscal-years?propertyId=${H1}`, directora);
    expectCode(listed, 400, "FISCAL_YEAR_IS_ENTITY_SCOPED", "GET fiscal-years con propertyId");
    assert.equal(await prisma.fiscalYear.count({ where: { organizationId: ORG, propertyId: { not: null } } }), 0);
  });

  it("la nómina de la oficina contabiliza en la oficina y su retención entra en el Modelo 111 de la sociedad (2.000,00 / 300,00), no en la vista del hotel", async (t) => {
    if (!ready(t)) return;
    const profile = await prisma.staffProfile.create({ data: { userId: ownerUserId, propertyId: OC, employeeCode: `OC-${RUN}` }, select: { id: true } });
    const contract = await post<{ id: string; propertyId: string | null }>("/payroll/contracts", directora, { staffProfileId: profile.id, contractType: "indefinido", startDate: "2026-01-01", grossSalary: "2000.00", irpfRatePct: "15.00" });
    assert.ok([200, 201].includes(contract.status), contract.text.slice(0, 300));
    assert.equal(contract.body.propertyId, OC);
    const period = await post<{ id: string; propertyId?: string | null }>("/payroll/periods", directora, { periodCode: "2026-08" });
    assert.ok([200, 201].includes(period.status), period.text.slice(0, 300));
    const calculated = await post<{ slipIds: string[]; journalEntryIds: string[]; period: { totalGross: number; totalIrpf: number } }>(`/payroll/periods/${period.body.id}/calculate`, directora, {});
    assert.ok([200, 201].includes(calculated.status), calculated.text.slice(0, 300));
    assert.equal(calculated.body.slipIds.length, 1);
    assert.deepEqual([calculated.body.period.totalGross, calculated.body.period.totalIrpf], [2000, 300]);
    const entry = await prisma.journalEntry.findUniqueOrThrow({ where: { id: calculated.body.journalEntryIds[0]! }, select: { propertyId: true } });
    assert.equal(entry.propertyId, OC, "the payroll asiento carries the office as work centre");
    const record = await prisma.withholdingTaxRecord.findFirstOrThrow({ where: { organizationId: ORG, sourceType: "payroll_slip" } });
    assert.deepEqual([record.propertyId, record.rowCode, record.grossAmount.toFixed(2), record.retentionAmount.toFixed(2)], [OC, "01", "2000.00", "300.00"]);

    type M111 = { modelo: string; sociedad: { code: string; taxId: string | null }; detalle: Array<{ clave: string; base: string | number; retenciones: string | number; registros?: number }> };
    const entity = await get<M111>("/fiscal/models/111?period=2026-Q3", directora);
    assert.equal(entity.status, 200, entity.text.slice(0, 300));
    assert.equal(entity.body.sociedad.taxId, TAX_ID);
    const row01 = entity.body.detalle.find((row) => row.clave === "01");
    assert.ok(row01, "row 01 (rendimientos del trabajo) in the sociedad's 111");
    assert.deepEqual([Number(row01!.base), Number(row01!.retenciones)], [2000, 300]);
    const officeView = await get<M111>(`/fiscal/models/111?period=2026-Q3&propertyId=${OC}`, directora);
    assert.equal(Number(officeView.body.detalle.find((row) => row.clave === "01")?.retenciones), 300);
    const hotelView = await get<M111>(`/fiscal/models/111?period=2026-Q3&propertyId=${H1}`, directora);
    assert.equal(hotelView.status, 200, hotelView.text.slice(0, 300));
    assert.equal(hotelView.body.detalle.find((row) => row.clave === "01"), undefined, "the hotel view carries no office payroll");
  });

  it("la oficina queda fuera de la operación: cierre del día 409 WORK_CENTER_NOT_OPERATIONAL, portfolio y bloque SES sin la oficina, filtro operativo = hoteles", async (t) => {
    if (!ready(t)) return;
    const audit = await post<ErrorBody>(`/properties/${OC}/night-audit/run`, directora, {});
    expectCode(audit, 409, "WORK_CENTER_NOT_OPERATIONAL", "night audit en la oficina");
    assert.equal(await prisma.nightAuditRun.count({ where: { propertyId: OC } }), 0);
    const portfolio = await get<{ totals: { propertiesCount: number }; perProperty: Array<{ propertyId: string }> }>("/dashboards/portfolio", directora);
    assert.equal(portfolio.status, 200, portfolio.text.slice(0, 300));
    assert.deepEqual(portfolio.body.perProperty.map((p) => p.propertyId).sort(), [H1, H2].sort(), "the office never enters the portfolio");
    assert.equal(portfolio.body.totals.propertiesCount, 2);
    const health = await get<{ organization: { issuers: Array<{ propertyId: string }>; sesEstablishmentIncomplete: { propertyIds: string[] } } }>("/compliance/health", directora);
    assert.equal(health.status, 200, health.text.slice(0, 300));
    assert.ok(!health.body.organization.sesEstablishmentIncomplete.propertyIds.includes(OC), "SES never lists the office");
    assert.deepEqual(health.body.organization.issuers.map((row) => row.propertyId).sort(), [H1, H2].sort(), "issuers = the two hotels (the office has no series)");
    assert.equal(JSON.stringify(health.body.organization).includes(OC), false, "the office id appears nowhere in the organization block");
    assert.deepEqual((await listOperationalProperties(ORG)).map((p) => p.id).sort(), [H1, H2].sort(), "single operational filter (R6)");
  });
});

type Compare = {
  properties: Array<{ propertyId: string; propertyKind?: string; pnl: { gop: string; totalOperatingRevenue: string }; allocation?: { allocated: string; gopAfterAllocation: string } }>;
  corporate: { centres: Array<{ propertyId: string; kind: string }>; pnl: { gop: string } } | null;
  unassigned: { gop: string };
  rollup: Array<{ metric: string; hotels: string; corporate: string; unassigned: string; total: string; ok: boolean }>;
  allocation?: { method: string; corporateCost: string; allocated: string; applied: boolean; posted: false; label: string; basis: string; shares: Array<{ propertyId: string; share: string; amount: string }> } | null;
};

describe("E · USALI por centro: «Oficina central», roll-up exacto y reparto informativo que suma exacto y no contabiliza", () => {
  it("GOP por hotel (100 · 300), Oficina central −80, Total sociedad = Σ hoteles + Oficina + sin asignar = 320", async (t) => {
    if (!ready(t)) return;
    await flushAccountingProjection();
    await flushExtraProjections();
    const res = await get<Compare>(`/accounting/usali/compare?from=${JULY.from}&to=${JULY.to}&includeCorporate=1`, directora);
    assert.equal(res.status, 200, res.text.slice(0, 300));
    assert.deepEqual(res.body.properties.map((p) => [p.propertyId, Number(p.pnl.gop)]).sort(), [[H1, 100], [H2, 300]].sort(), "hotels only in the columns");
    assert.deepEqual(res.body.corporate?.centres.map((c) => [c.propertyId, c.kind]), [[OC, "office"]]);
    assert.equal(Number(res.body.corporate?.pnl.gop), -80);
    assert.equal(Number(res.body.unassigned.gop), 0);
    const gop = res.body.rollup.find((line) => line.metric === "gop");
    assert.ok(gop, "rollup gop line");
    assert.deepEqual([Number(gop!.hotels), Number(gop!.corporate), Number(gop!.unassigned), Number(gop!.total), gop!.ok], [400, -80, 0, 320, true]);
    assert.ok(res.body.rollup.every((line) => line.ok), JSON.stringify(res.body.rollup));
  });

  it("clave «ingresos»: la fila «Reparto corporativo (informativo · no contabilizado)» reparte 80,00 = 20,00 + 60,00 y el Diario no crece", async (t) => {
    if (!ready(t)) return;
    const saved = await put<{ method: string; persisted: boolean; hotels: unknown[]; corporateCentres: Array<{ propertyId: string }> }>("/accounting/allocation", directora, { method: "revenue" });
    assert.equal(saved.status, 200, saved.text.slice(0, 300));
    assert.deepEqual([saved.body.method, saved.body.persisted, saved.body.hotels.length, saved.body.corporateCentres.map((c) => c.propertyId)], ["revenue", true, 2, [OC]]);
    const entriesBefore = await prisma.journalEntry.count({ where: { organizationId: ORG } });
    const res = await get<Compare>(`/accounting/usali/compare?from=${JULY.from}&to=${JULY.to}&includeCorporate=1&allocation=revenue`, directora);
    assert.equal(res.status, 200, res.text.slice(0, 300));
    const allocation = res.body.allocation;
    assert.ok(allocation, "allocation row present");
    assert.deepEqual([allocation!.method, allocation!.applied, allocation!.posted, allocation!.label, allocation!.basis], ["revenue", true, false, "Reparto corporativo (informativo · no contabilizado)", "usali_corporate_gop"]);
    assert.deepEqual([Number(allocation!.corporateCost), Number(allocation!.allocated)], [80, 80]);
    const shares = allocation!.shares.map((s) => [s.propertyId, Number(s.share), Number(s.amount)]).sort();
    assert.deepEqual(shares, [[H1, 0.25, 20], [H2, 0.75, 60]].sort());
    assert.equal(shares.reduce((sum, [, , amount]) => sum + Number(amount), 0), 80, "the shares add up to 100 % of the office cost");
    assert.deepEqual(res.body.properties.map((p) => [p.propertyId, Number(p.allocation?.allocated), Number(p.allocation?.gopAfterAllocation)]).sort(), [[H1, 20, 80], [H2, 60, 240]].sort());
    assert.equal(await prisma.journalEntry.count({ where: { organizationId: ORG } }), entriesBefore, "zero asientos: the allocation is informative");
  });

  it("PyG por centro: la oficina es una columna más (kind office), 623 = −80 en OC, total = Σ centros + sin asignar", async (t) => {
    if (!ready(t)) return;
    type Pnl = { kind: string; entity: { code: string }; properties: Array<{ propertyId: string; kind: string }>; rows: Array<{ accountCode: string; byProperty: Record<string, string>; unassigned: string; total: string }>; reconciliation: { ok: boolean } };
    const res = await get<Pnl>(`/accounting/pnl/by-property?from=${JULY.from}&to=${JULY.to}`, directora);
    assert.equal(res.status, 200, res.text.slice(0, 300));
    assert.equal(res.body.kind, "pnl_by_property");
    assert.deepEqual(res.body.properties.map((p) => [p.propertyId, p.kind]).sort(), [[H1, "hotel"], [H2, "hotel"], [OC, "office"]].sort());
    const row623 = res.body.rows.find((row) => row.accountCode === "623");
    assert.ok(row623, "623 row");
    assert.deepEqual([Number(row623!.byProperty[OC]), Number(row623!.byProperty[H1] ?? 0), Number(row623!.unassigned), Number(row623!.total)], [-80, 0, 0, -80]);
    const row705 = res.body.rows.find((row) => row.accountCode.startsWith("705"));
    assert.ok(row705, "705 row");
    assert.deepEqual([Number(row705!.byProperty[H1]), Number(row705!.byProperty[H2]), Number(row705!.total)], [100, 300, 400]);
    assert.equal(res.body.reconciliation.ok, true);
  });
});

describe("F · Permisos por centro y aislamiento entre organizaciones (sesiones REALES, unión demo apagada)", () => {
  const directorReady = (t: { skip: (reason?: string) => void }): boolean => {
    if (!ready(t)) return false;
    if (!director.authorization) {
      t.skip("director login unavailable");
      return false;
    }
    return true;
  };

  it("el director de H2 ve la estructura redactada a su centro (sin NIF, series, instalaciones ni IVA) y no abre la sociedad completa (403)", async (t) => {
    if (!directorReady(t)) return;
    await withEnv(REAL_GRANTS_ENV, async () => {
      const structure = await get<Structure>("/organizations/me/structure", director);
      assert.equal(structure.status, 200, structure.text.slice(0, 300));
      assert.equal(structure.body.scope, "assigned_properties");
      assert.equal(structure.body.mode, "multi_center", "mode describes the whole organization");
      assert.equal(structure.body.counts.properties, 3);
      assert.deepEqual(structure.body.legalEntity?.properties.map((p) => p.id), [H2]);
      assert.deepEqual([structure.body.legalEntity?.taxId, structure.body.legalEntity?.taxIdValid, structure.body.legalEntity?.vatSettings], [null, false, null]);
      assert.equal(structure.body.legalEntity?.legalName, LEGAL_NAME, "name and code stay");
      assert.deepEqual(structure.body.legalEntity?.properties[0]?.series, []);
      assert.equal(structure.body.legalEntity?.properties[0]?.installation, null);
      assert.ok(!structure.body.warnings.includes("TAX_ID_PENDING"), "configuration warnings are for whoever manages the sociedad");
      const full = await get<ErrorBody>(`/legal-entities/${entityId}`, director);
      assert.equal(full.status, 403, full.text.slice(0, 300));
      const series = await get<ErrorBody>(`/legal-entities/${entityId}/series`, director);
      assert.equal(series.status, 403, series.text.slice(0, 300));
    });
  });

  it("lecturas con importes: 404 ENTITY_SCOPE_REQUIRED sin propertyId o con ámbito Sociedad; 404 opaco con el hotel hermano; 200 solo con H2", async (t) => {
    if (!directorReady(t)) return;
    await withEnv(REAL_GRANTS_ENV, async () => {
      const whole = await get<ErrorBody>("/fiscal/models/303?period=2026-Q3", director);
      const body = expectCode(whole, 404, "ENTITY_SCOPE_REQUIRED", "303 sin propertyId");
      assert.equal(body.details?.requiredPermission, "accounting.entity.read");
      assert.doesNotMatch(body.message ?? "", new RegExp(H1), "never echoes a property id");
      const sister = await get<ErrorBody>(`/fiscal/models/303?period=2026-Q3&propertyId=${H1}`, director);
      assert.equal(sister.status, 404, sister.text.slice(0, 300));
      assert.equal(sister.body.message, "Propiedad no encontrada.");
      const own = await get<{ propertyId: string; sociedad: { code: string; taxId: string | null } }>(`/fiscal/models/303?period=2026-Q3&propertyId=${H2}`, director);
      assert.equal(own.status, 200, own.text.slice(0, 300));
      assert.equal(own.body.propertyId, H2);
      for (const url of [
        `/accounting/usali/compare?from=${JULY.from}&to=${JULY.to}&includeCorporate=1`,
        `/accounting/pnl/by-property?from=${JULY.from}&to=${JULY.to}`,
        `/accounting/journal?from=${JULY.from}&to=${JULY.to}`,
        "/treasury/position?scope=entity",
        "/accounting/annual-accounts/balance?from=2026-01-01&to=2026-12-31"
      ]) {
        const denied = await get<ErrorBody>(url, director);
        expectCode(denied, 404, "ENTITY_SCOPE_REQUIRED", url);
      }
      const ownJournal = await get<unknown>(`/accounting/journal?from=${JULY.from}&to=${JULY.to}&propertyId=${H2}`, director);
      assert.equal(ownJournal.status, 200, ownJournal.text.slice(0, 300));
      // Society-level writes are refused as opaquely; his own centre posts.
      const society = await post<ErrorBody>("/accounting/journal", director, { entryDate: "2026-07-20", description: "Suministros de la sociedad", societyLevel: true, lines: [{ accountCode: "628", debit: "10.00" }, { accountCode: "572", credit: "10.00" }] });
      expectCode(society, 404, "ENTITY_SCOPE_REQUIRED", "asiento de sociedad por el director");
      const own2 = await post<JournalEntry>("/accounting/journal", director, { entryDate: "2026-07-20", description: "Suministros Sur", propertyId: H2, lines: [{ accountCode: "628", debit: "10.00" }, { accountCode: "572", credit: "10.00" }] });
      assert.equal(own2.status, 201, own2.text.slice(0, 300));
      assert.equal(own2.body.propertyId, H2);
    });
  });

  it("gestión de la estructura: 403 para el director en PATCH sociedad, alta de centro (incluso dryRun) y ficha del centro; nada cambia", async (t) => {
    if (!directorReady(t)) return;
    await withEnv(REAL_GRANTS_ENV, async () => {
      const entityBefore = await prisma.legalEntity.findUniqueOrThrow({ where: { id: entityId } });
      const rename = await patch<ErrorBody>(`/legal-entities/${entityId}`, director, { legalName: "Intento SL", confirmHighRisk: true });
      assert.equal(rename.status, 403, rename.text.slice(0, 300));
      const dry = await post<ErrorBody>(`/legal-entities/${entityId}/properties`, director, { ...officeBody(), dryRun: true });
      assert.equal(dry.status, 403, dry.text.slice(0, 300));
      const establishment = await patch<ErrorBody>(`/properties/${H2}/establishment`, director, { tradeName: "Intento" });
      assert.equal(establishment.status, 403, establishment.text.slice(0, 300));
      const second = await post<ErrorBody>("/legal-entities", director, { legalName: "Otra SL" });
      assert.equal(second.status, 403, second.text.slice(0, 300));
      assert.equal((await prisma.legalEntity.findUniqueOrThrow({ where: { id: entityId } })).legalName, entityBefore.legalName);
      assert.equal((await prisma.property.findUniqueOrThrow({ where: { id: H2 } })).tradeName, null);
    });
  });

  it("la directora (accounting.entity.read REAL) lee toda la sociedad: 303, USALI comparado, tesorería ?scope=entity con la etiqueta de la sociedad", async (t) => {
    if (!ready(t)) return;
    await withEnv(REAL_GRANTS_ENV, async () => {
      const whole = await get<{ sociedad: { code: string; taxId: string | null; source: string }; declarante: { nif: string | null; nombre: string | null } }>("/fiscal/models/303?period=2026-Q3", directora);
      assert.equal(whole.status, 200, whole.text.slice(0, 300));
      assert.deepEqual([whole.body.sociedad.taxId, whole.body.sociedad.source, whole.body.declarante.nif, whole.body.declarante.nombre], [TAX_ID, "legal_entity", TAX_ID, LEGAL_NAME]);
      const compare = await get<Compare>(`/accounting/usali/compare?from=${JULY.from}&to=${JULY.to}&includeCorporate=1`, directora);
      assert.equal(compare.status, 200, compare.text.slice(0, 300));
      assert.equal(compare.body.properties.length, 2);
      const treasury = await get<{ scope: string; propertyId: string | null; legalEntityId: string | null; entityLabel: string }>("/treasury/position?scope=entity", directora);
      assert.equal(treasury.status, 200, treasury.text.slice(0, 300));
      assert.deepEqual([treasury.body.scope, treasury.body.propertyId, treasury.body.legalEntityId], ["entity", null, entityId]);
      assert.match(treasury.body.entityLabel, new RegExp(LEGAL_NAME.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    });
  });

  it("aislamiento: la sociedad y los centros de Faranda son opacos (404) para la directora, en lectura y en escritura; Faranda no cambia", async (t) => {
    if (!ready(t)) return;
    const farandaEntity = await prisma.legalEntity.findFirstOrThrow({ where: { organizationId: FARANDA_ORG, isDefault: true }, select: { id: true } });
    const snapshot = await farandaCounts();
    await withEnv(REAL_GRANTS_ENV, async () => {
      const read = await get<ErrorBody>(`/legal-entities/${farandaEntity.id}`, directora);
      assert.equal(read.status, 404, read.text.slice(0, 300));
      const series = await get<ErrorBody>(`/legal-entities/${farandaEntity.id}/series`, directora);
      assert.equal(series.status, 404, series.text.slice(0, 300));
      const rename = await patch<ErrorBody>(`/legal-entities/${farandaEntity.id}`, directora, { legalName: "Intento", confirmHighRisk: true });
      assert.equal(rename.status, 404, rename.text.slice(0, 300));
      const dry = await post<ErrorBody>(`/legal-entities/${farandaEntity.id}/properties`, directora, { ...officeBody(), dryRun: true });
      assert.equal(dry.status, 404, dry.text.slice(0, 300));
      const establishment = await patch<ErrorBody>(`/properties/${FARANDA_RA}/establishment`, directora, { tradeName: "Intento" });
      assert.equal(establishment.status, 404, establishment.text.slice(0, 300));
      const model = await get<ErrorBody>(`/fiscal/models/303?period=2026-Q3&propertyId=${FARANDA_RA}`, directora);
      assert.equal(model.status, 404, model.text.slice(0, 300));
      for (const res of [read, series, rename, dry, establishment, model]) assert.doesNotMatch(res.text, /Faranda|B99999997|CELUISMA|A33615980/, "no oracle of the other tenant");
    });
    assert.deepEqual(await farandaCounts(), snapshot, "Faranda untouched by the isolation probes");
  });
});

describe("G · Régimen SII / gran empresa en la sociedad: mensual forzado, 347 y 390 «no se presenta», VeriFactu no aplica", () => {
  it("PATCH siiEnabled + largeCompany: 409 sin confirmar; 200 confirmado → periodicidad mensual efectiva, PUT trimestral 409 PERIODICITY_FORCED_BY_REGIME", async (t) => {
    if (!ready(t)) return;
    const unconfirmed = await patch<ErrorBody>(`/legal-entities/${entityId}`, directora, { siiEnabled: true, largeCompany: true });
    const body = expectCode(unconfirmed, 409, "HIGH_RISK_CONFIRMATION_REQUIRED", "régimen sin confirmar");
    assert.deepEqual(body.details?.fields, ["siiEnabled", "largeCompany"]);
    const confirmed = await patch<{ siiEnabled: boolean; largeCompany: boolean; warnings: string[] }>(`/legal-entities/${entityId}`, directora, { siiEnabled: true, largeCompany: true, confirmHighRisk: true });
    assert.equal(confirmed.status, 200, confirmed.text.slice(0, 300));
    assert.deepEqual([confirmed.body.siiEnabled, confirmed.body.largeCompany], [true, true]);
    type Vat = { periodicity: string; persisted: boolean; sociedad: { regimen: { periodicity: string; periodicityForcedBy: string | null; modelosNoPresentados: string[]; verifactu: { aplica: boolean; motivo: string | null } } } };
    const settings = await get<Vat>("/fiscal/vat-settings", directora);
    assert.equal(settings.status, 200, settings.text.slice(0, 300));
    assert.equal(settings.body.periodicity, "monthly");
    assert.equal(settings.body.sociedad.regimen.periodicityForcedBy, "sii");
    assert.ok(settings.body.sociedad.regimen.modelosNoPresentados.includes("347") && settings.body.sociedad.regimen.modelosNoPresentados.includes("390"));
    assert.equal(settings.body.sociedad.regimen.verifactu.aplica, false);
    assert.match(settings.body.sociedad.regimen.verifactu.motivo ?? "", /SII/);
    const quarterly = await put<ErrorBody>("/fiscal/vat-settings", directora, { periodicity: "quarterly" });
    expectCode(quarterly, 409, "PERIODICITY_FORCED_BY_REGIME", "PUT trimestral bajo SII");
  });

  it("347 y 390 llevan presentacion.noSePresenta.motivo; el 303 trimestral es 400 PERIOD_MISMATCH y el mensual abre", async (t) => {
    if (!ready(t)) return;
    type Model = { presentacion: { noSePresenta?: { motivo: string } }; sociedad: { regimen: { siiEnabled: boolean } } };
    for (const modelo of ["347", "390"]) {
      const res = await get<Model>(`/fiscal/models/${modelo}?year=2026`, directora);
      assert.equal(res.status, 200, `${modelo}: ${res.text.slice(0, 300)}`);
      assert.match(res.body.presentacion.noSePresenta?.motivo ?? "", /SII/, `${modelo} no se presenta`);
    }
    const quarter = await get<ErrorBody>("/fiscal/models/303?period=2026-Q3", directora);
    const body = expectCode(quarter, 400, "PERIOD_MISMATCH", "303 trimestral bajo SII");
    assert.equal(body.details?.forcedBy, "sii");
    const month = await get<Model>("/fiscal/models/303?period=2026-07", directora);
    assert.equal(month.status, 200, month.text.slice(0, 300));
    assert.equal(month.body.sociedad.regimen.siiEnabled, true);
  });

  it("la siguiente factura se expide sin registro VeriFactu, con el aviso tipado y la exclusión congelada en el emisor", async (t) => {
    if (!ready(t)) return;
    const issued = await issueInvoice(directora, H1, 55, 5, "Cliente SII SL");
    invoices.sii = issued.id;
    assert.equal(issued.invoiceNumber, `FAC-${YEAR}-000002`, "numbering continues in the series");
    assert.ok(issued.warnings?.some((w) => w.startsWith("VERIFACTU_EXCLUDED_BY_SII:")), (issued.warnings ?? []).join(" | "));
    const detail = await get<InvoiceView>(`/invoices/${issued.id}`, directora);
    assert.equal(detail.body.issuer?.verifactuExclusion?.code, "VERIFACTU_EXCLUDED_BY_SII");
    const row = await prisma.invoice.findUniqueOrThrow({ where: { id: issued.id }, select: { verifactuHash: true, qrPayload: true, installationId: true, legalEntityId: true } });
    assert.deepEqual([row.verifactuHash, row.qrPayload, row.installationId, row.legalEntityId], [null, null, null, entityId]);
    await flushVerifactuQueue();
    assert.equal(await prisma.verifactuSubmission.count({ where: { invoiceId: issued.id } }), 0, "nothing queued or sent");
  });
});

describe("H · Backfill idempotente sobre la organización creada por el producto", () => {
  it("primera pasada: sociedad «exists», centros «skip», series y facturas ya enlazadas; solo abre la instalación de los centros con envíos sandbox (deuda §17.10); segunda pasada 0 escrituras", async () => {
    const first = await backfill.runBackfill(backfill.parseFlags(["--apply", "--confirm", ORG, "--org", ORG]));
    const entry = first.organizations.find((o) => o.organizationId === ORG);
    assert.ok(entry, "the organisation is in the report");
    assert.equal(entry!.error, undefined, entry!.error);
    assert.equal(entry!.plan?.legalEntity.action, "exists", "the product already created the sociedad");
    assert.equal(entry!.plan?.legalEntity.id, entityId);
    assert.ok(entry!.plan?.properties.every((p) => p.action === "skip" && Object.keys(p.set).length === 0), JSON.stringify(entry!.plan?.properties));
    assert.deepEqual([entry!.plan?.sequences.toLink, entry!.plan?.invoices.toLink, entry!.plan?.bankAccounts.toLink], [0, 0, 0], "series, invoices and banks already carry the sociedad");
    // The only layer the product does not open yet: verifactu_installations for the centres that already
    // sent (sandbox) records with the env fallback number — every planned write is one of those rows.
    const submissionsByProperty = await prisma.verifactuSubmission.groupBy({ by: ["propertyId"], where: { propertyId: { in: [H1, H2, OC] } }, _count: { _all: true } });
    const withSubmissions = submissionsByProperty.map((row) => row.propertyId).sort();
    assert.deepEqual((entry!.plan?.installations ?? []).filter((i) => i.action === "create").map((i) => i.propertyId).sort(), withSubmissions, "installations only for centres with records");
    assert.equal(entry!.plan?.writes, (entry!.plan?.installations ?? []).filter((i) => i.action === "create").reduce((sum, i) => sum + 1 + i.invoicesToLink + i.submissionsToLink, 0), "no other write is planned");
    assert.equal(entry!.verification?.ok, true, JSON.stringify(entry!.verification));

    const second = await backfill.runBackfill(backfill.parseFlags(["--apply", "--confirm", ORG, "--org", ORG]));
    const again = second.organizations.find((o) => o.organizationId === ORG);
    assert.equal(again?.error, undefined, again?.error);
    assert.equal(again?.plan?.writes, 0, JSON.stringify(again?.plan));
    assert.equal(again?.applied, false);
    assert.ok(again?.plan?.installations.every((i) => i.action === "exists"));
    assert.equal(again?.verification?.ok, true);
    const dry = await backfill.runBackfill(backfill.parseFlags(["--org", ORG]));
    assert.equal(dry.dryRun, true);
    assert.equal(dry.organizations.find((o) => o.organizationId === ORG)?.plan?.writes, 0);
    const properties = await prisma.property.findMany({ where: { organizationId: ORG }, select: { legalEntityId: true, code: true } });
    assert.ok(properties.every((p) => p.legalEntityId === entityId && p.code), "every centre linked and coded");
    assert.equal(await prisma.legalEntity.count({ where: { organizationId: ORG } }), 1);
  });
});

// Oráculo posterior a la migración Faranda → CELUISMA (L8, runbook §17.13, aplicada en la BD local el
// 2026-09-16): sociedad CEL · A33615980 · CELUISMA S.A. con 7 hoteles (RA, LT, PG, MC, AS, FN, LL) y la
// oficina central OC. La Tanda 6c añade a Faranda los asientos `payroll_cost_import` (48 en la carga
// real): el invariante fiscal son los 61 asientos previos, que se cuentan EXCLUYENDO ese sourceType.
describe("I · Equivalencia de Faranda (solo lectura)", () => {
  it("estructura: multi_center, sociedad CEL · A33615980, 7 hoteles + oficina central OC, RA con instalación DEV-001", async () => {
    const structure = await getStructure(farandaCtx);
    assert.equal(structure.mode, "multi_center");
    assert.equal(structure.scope, "entity");
    assert.deepEqual([structure.legalEntity?.code, structure.legalEntity?.taxId, structure.legalEntity?.siiEnabled, structure.legalEntity?.largeCompany], ["CEL", "A33615980", false, false]);
    assert.deepEqual(
      (structure.legalEntity?.properties ?? []).map((p) => [p.code, p.kind]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
      [["AS", "hotel"], ["FN", "hotel"], ["LL", "hotel"], ["LT", "hotel"], ["MC", "hotel"], ["OC", "office"], ["PG", "hotel"], ["RA", "hotel"]]
    );
    assert.equal(structure.legalEntity?.properties.find((p) => p.code === "RA")?.installation?.numeroInstalacion, "DEV-001");
    assert.deepEqual(structure.counts, { properties: 8, hotels: 7, offices: 1, others: 0, legalEntities: 1 });
  });

  it("61 asientos previos (sin payroll_cost_import ni pms_shadow_revenue); 4300 = 379,00; 303 2026-Q3: bases 423,62 + 155,04 = 578,66 · 27 = 71 = 74,94 · 37 registros · declarante CEL", async () => {
    // Tanda 7b (modo sombra OPERA, demo del integrador en Rías Altas): Faranda tiene además el asiento diario
    // `pms_shadow_revenue` del 16/09 (posted), el del 15/09 (reversed) y su reverso (`reversal` con reversalOfId):
    // se excluyen como las nóminas; el invariante fiscal siguen siendo los 61 previos y el saldo 379,00 de 4300.
    const shadowEntryIds = (await prisma.journalEntry.findMany({ where: { organizationId: FARANDA_ORG, sourceType: "pms_shadow_revenue" }, select: { id: true } })).map((e) => e.id);
    // `reversalOfId` es nullable: un `NOT { in }` a secas dejaría fuera los asientos sin reverso (lógica trivaluada).
    // Tanda 7c (importación desde Sage 200, demo del integrador): Faranda lleva además los asientos importados
    // (`sage200_journal` / `sage200_balance`, 2024-2026) y los reversos de los lotes de la demo (`reversal` con
    // sourceId `ledger-import-reverse:<lote>:<asiento>`): se excluyen igual; los 61 previos y el 379,00 no cambian.
    const sageEntryIds = (await prisma.journalEntry.findMany({ where: { organizationId: FARANDA_ORG, sourceType: { in: ["sage200_journal", "sage200_balance"] } }, select: { id: true } })).map((e) => e.id);
    const excludedReversalTargets = [...shadowEntryIds, ...sageEntryIds];
    const baseline = { organizationId: FARANDA_ORG, sourceType: { notIn: ["payroll_cost_import", "pms_shadow_revenue", "sage200_journal", "sage200_balance"] }, ...(excludedReversalTargets.length > 0 ? { OR: [{ reversalOfId: null }, { reversalOfId: { notIn: excludedReversalTargets } }] } : {}) };
    assert.equal(await prisma.journalEntry.count({ where: baseline }), 61);
    const entryIds = (await prisma.journalEntry.findMany({ where: baseline, select: { id: true } })).map((e) => e.id);
    const lines = await prisma.journalLine.findMany({ where: { accountCode: "4300", journalEntryId: { in: entryIds } }, select: { debit: true, credit: true } });
    const balance = lines.reduce((sum, line) => sum + Number(line.debit) - Number(line.credit), 0);
    assert.equal(balance.toFixed(2), "379.00");
    const report = await buildModelo303({ context: farandaCtx, period: "2026-Q3" });
    const casilla = (code: string): number => report.casillas.find((box) => box.casilla === code)?.importe ?? Number.NaN;
    // Tanda 7c: con libros importados de Sage 200 (`vat_book_entries.sourceType sage200`) en 2026 el 303 sale de los
    // LIBROS (los documentos nativos materializados + las filas de Sage); las cifras fijas de la demo sin Sage
    // (bases 423,62 + 155,04, 27 = 71 = 74,94, 37 registros) solo valen cuando no hay filas importadas.
    const sageBookRows = await prisma.vatBookEntry.count({ where: { organizationId: FARANDA_ORG, sourceType: "sage200" } });
    if (sageBookRows === 0) {
      assert.deepEqual([casilla("04"), casilla("07")], [423.62, 155.04]);
      assert.equal(Number((casilla("04") + casilla("07")).toFixed(2)), 578.66);
      assert.deepEqual([casilla("27"), casilla("71"), report.fuentes.registros], [74.94, 74.94, 37]);
    } else {
      assert.equal(report.fuentes.origen, "libros");
      const emitidas = await prisma.vatBookEntry.aggregate({ where: { organizationId: FARANDA_ORG, book: "emitidas", period: "2026-Q3" }, _sum: { quota: true }, _count: { _all: true } });
      assert.equal(casilla("27"), Number(Number(emitidas._sum.quota ?? 0).toFixed(2)), "casilla 27 = Σ cuotas del libro de emitidas del trimestre (nativas + Sage)");
      assert.ok(report.fuentes.registros >= emitidas._count._all);
    }
    assert.deepEqual(report.declarante, { nif: "A33615980", nombre: "CELUISMA S.A." });
    assert.deepEqual([report.sociedad.code, report.sociedad.source, report.sociedad.regimen.periodicity], ["CEL", "legal_entity", "quarterly"]);
  });
});
