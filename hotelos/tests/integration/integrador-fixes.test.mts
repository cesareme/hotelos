/**
 * Finanzas · lote fix:integrador (2026-09-16) — REAL HTTP via app.inject
 * against the shared Postgres, with REAL sessions of two isolated test
 * organizations created here and removed in `after` (Faranda and org_123
 * are never written):
 *   · t6#6  GET /payroll/contracts and GET /payroll/periods refuse
 *           `?organizationId=<other org>` with the opaque 404 of the tenant
 *           guard (no salary, IRPF or id of the other organization in the
 *           body) and `?propertyId=<other org>` with the property 404;
 *   · t6#9  under strict RBAC a real Recepción session is refused (403) on
 *           the diario, the mayor, the CSV export, the Modelo 303, the libros
 *           de IVA, the cuentas anuales, the USALI PyG and the legacy
 *           /accounting/reports/*, while it keeps the fiscal calendar and the
 *           exchange rates; the Contabilidad session is not refused;
 *   · t6#10 the Contabilidad template registers suppliers, received invoices
 *           and fixed assets and reaches the gestoría export (400 on an empty
 *           body, never 403); reception stays refused;
 *   · t6#11 POST /payroll/contracts and POST /commissions/rules answer 400 in
 *           Spanish to garbage / unknown keys, 404 (opaque) to a missing or
 *           foreign staff profile / channel / property, and persist a valid
 *           body ("1800,50" → 1800.5, channelCode lower-cased).
 *
 * The platform-admin case (a super-admin may list another organization's
 * payroll by re-pointing) uses the demo super-user (INTEGRATION_LOGIN_EMAIL /
 * _PASSWORD override) and skips loudly when that login is unavailable.
 * Run with: corepack pnpm test:integration
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

const { buildApiServer } = await import("../../apps/api/src/server.js");
const { resetRbacStrictModeForTests } = await import("../../apps/api/src/security/route-permissions.js");
const { createRoleFromTemplate } = await import("../../apps/api/src/lib/rbac-catalog.js");
const { flushAuditQueues } = await import("../../apps/api/src/modules/audit/audit.service.js");
const { prisma, hashPassword } = await import("@hotelos/database");

type ApiApp = Awaited<ReturnType<typeof buildApiServer>>;
type Headers = Record<string, string>;
type Session = { token: string; headers: Headers };
type ErrorBody = { statusCode?: number; message?: string; details?: { code?: string; [k: string]: unknown } };

const MARK = "[integrador-fixes test]";
const ORG_A = "org_t6fix_a";
const ORG_B = "org_t6fix_b";
const PROP_A = "prop_t6fix_a";
const PROP_A2 = "prop_t6fix_a2";
const PROP_B = "prop_t6fix_b";
const ORGS = [ORG_A, ORG_B];
const PROPS = [PROP_A, PROP_A2, PROP_B];
const PASSWORD = "T6fix-password-2026!";
const USERS = {
  ownerA: { id: "usr_t6fix_owner_a", email: "owner.a@t6fix.test", organizationId: ORG_A, fullName: `${MARK} Owner A` },
  receptionA: { id: "usr_t6fix_reception_a", email: "recepcion.a@t6fix.test", organizationId: ORG_A, fullName: `${MARK} Recepción A` },
  accountantA: { id: "usr_t6fix_accountant_a", email: "contable.a@t6fix.test", organizationId: ORG_A, fullName: `${MARK} Contabilidad A` },
  hrA: { id: "usr_t6fix_hr_a", email: "rrhh.a@t6fix.test", organizationId: ORG_A, fullName: `${MARK} RRHH A` },
  staffA: { id: "usr_t6fix_staff_a", email: "staff.a@t6fix.test", organizationId: ORG_A, fullName: `${MARK} Staff A` },
  staffB: { id: "usr_t6fix_staff_b", email: "staff.b@t6fix.test", organizationId: ORG_B, fullName: `${MARK} Staff B` }
} as const;
const USER_IDS = Object.values(USERS).map((user) => user.id);
const STAFF_PROFILE_A = "sp_t6fix_a";
const STAFF_PROFILE_B = "sp_t6fix_b";
const CONTRACT_B_ID = "ctr_t6fix_b";
const CONTRACT_B_GROSS = "3333";

// The repo .env (HOTELOS_ALLOW_DEMO_AUTH=true, NODE_ENV=development) enables
// the dev/demo permission UNION (auth.service unionPermissions), read per
// request; every case that proves a REAL grant pins strict mode for its
// duration and drops the memoised RBAC strict flag on entry and exit.
const STRICT_ENV = { HOTELOS_ALLOW_DEMO_AUTH: "false", NODE_ENV: "production" };

function applyEnv(entries: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(entries)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function withEnv<T>(overrides: Record<string, string | undefined>, run: () => Promise<T>): Promise<T> {
  const previous = Object.fromEntries(Object.keys(overrides).map((key) => [key, process.env[key]]));
  applyEnv(overrides);
  resetRbacStrictModeForTests();
  return run().finally(() => {
    applyEnv(previous);
    resetRbacStrictModeForTests();
  });
}

const strict = <T>(run: () => Promise<T>): Promise<T> => withEnv(STRICT_ENV, run);

let app: ApiApp;
let ownerA: Session;
let hrA: Session;
let receptionA: Session;
let accountantA: Session;
let platformAdmin: Session | null = null;

async function login(email: string, password: string, deviceId: string): Promise<Session | null> {
  const res = await app.inject({ method: "POST", url: "/auth/login", payload: { email, password, deviceId } });
  if (res.statusCode !== 200) return null;
  const token = (JSON.parse(res.body) as { token: string }).token;
  return { token, headers: { authorization: `Bearer ${token}` } };
}

async function call(method: "GET" | "POST", url: string, session: Session, payload?: unknown) {
  const res = await app.inject({ method, url, headers: session.headers, ...(payload === undefined ? {} : { payload }) });
  let body: unknown = null;
  try {
    body = JSON.parse(res.body);
  } catch {
    body = null;
  }
  return { status: res.statusCode, body, text: res.body };
}

const getJson = (url: string, session: Session) => call("GET", url, session);
const postJson = (url: string, session: Session, payload: unknown) => call("POST", url, session, payload);

async function removeFixtures(): Promise<void> {
  await prisma.employmentContract.deleteMany({ where: { organizationId: { in: ORGS } } });
  await prisma.payrollPeriod.deleteMany({ where: { organizationId: { in: ORGS } } });
  await prisma.commissionRule.deleteMany({ where: { propertyId: { in: PROPS } } });
  await prisma.staffProfile.deleteMany({ where: { propertyId: { in: PROPS } } });
  await prisma.session.deleteMany({ where: { userId: { in: USER_IDS } } });
  await prisma.userPropertyRole.deleteMany({ where: { userId: { in: USER_IDS } } });
  const roles = await prisma.role.findMany({ where: { organizationId: { in: ORGS } }, select: { id: true } });
  if (roles.length > 0) await prisma.rolePermission.deleteMany({ where: { roleId: { in: roles.map((role) => role.id) } } });
  await prisma.role.deleteMany({ where: { organizationId: { in: ORGS } } });
  await prisma.user.deleteMany({ where: { OR: [{ id: { in: USER_IDS } }, { organizationId: { in: ORGS } }] } });
  // Rows a finance GET may leave behind for a brand-new organization (chart auto-provisioning, VAT settings).
  await prisma.vatSettings.deleteMany({ where: { organizationId: { in: ORGS } } });
  await prisma.accountingSetting.deleteMany({ where: { organizationId: { in: ORGS } } });
  await prisma.account.deleteMany({ where: { organizationId: { in: ORGS } } });
  await prisma.fiscalPeriod.deleteMany({ where: { organizationId: { in: ORGS } } });
  await prisma.fiscalYear.deleteMany({ where: { organizationId: { in: ORGS } } });
  await prisma.property.deleteMany({ where: { id: { in: PROPS } } });
  await prisma.organization.deleteMany({ where: { id: { in: ORGS } } });
}

async function createUser(user: { id: string; email: string; organizationId: string; fullName: string }): Promise<void> {
  await prisma.user.create({ data: { id: user.id, email: user.email, organizationId: user.organizationId, fullName: user.fullName, passwordHash: hashPassword(PASSWORD) } });
}

describe("fix:integrador · t6#6 / t6#9 / t6#10 / t6#11 over real sessions", () => {
  before(async () => {
    app = await buildApiServer();
    await app.ready();
    await removeFixtures();

    await prisma.organization.create({ data: { id: ORG_A, name: `${MARK} Org A SL`, legalName: "T6fix A SL", taxId: "B12345674", country: "ES" } });
    await prisma.organization.create({ data: { id: ORG_B, name: `${MARK} Org B SL`, legalName: "T6fix B SL", taxId: "B87654321", country: "ES" } });
    await prisma.property.create({ data: { id: PROP_A, organizationId: ORG_A, name: `${MARK} Hotel A`, timezone: "Europe/Madrid", country: "ES", taxRegion: "ES_PENINSULA_BALEARES" } });
    await prisma.property.create({ data: { id: PROP_A2, organizationId: ORG_A, name: `${MARK} Hotel A2`, timezone: "Europe/Madrid", country: "ES", taxRegion: "ES_PENINSULA_BALEARES" } });
    await prisma.property.create({ data: { id: PROP_B, organizationId: ORG_B, name: `${MARK} Hotel B`, timezone: "Europe/Madrid", country: "ES", taxRegion: "ES_PENINSULA_BALEARES" } });
    for (const user of Object.values(USERS)) await createUser(user);

    // Real roles from the shared templates (the boot of buildApiServer synced the catalog).
    const owner = await createRoleFromTemplate({ organizationId: ORG_A, name: `${MARK} Propietario`, templateKey: "owner", actorUserId: null }, { audit: false });
    const reception = await createRoleFromTemplate({ organizationId: ORG_A, name: `${MARK} Recepción`, templateKey: "receptionist", actorUserId: null }, { audit: false });
    const accountant = await createRoleFromTemplate({ organizationId: ORG_A, name: `${MARK} Contabilidad`, templateKey: "accountant", actorUserId: null }, { audit: false });
    // Tanda 8a: «Propiedad» (owner) no longer prepares payrolls nor posts; RRHH (payroll_hr) prepares the contracts of A and A2.
    const hr = await createRoleFromTemplate({ organizationId: ORG_A, name: `${MARK} RRHH`, templateKey: "payroll_hr", actorUserId: null }, { audit: false });
    await prisma.userPropertyRole.createMany({
      data: [
        { userId: USERS.ownerA.id, propertyId: PROP_A, roleId: owner.id },
        { userId: USERS.ownerA.id, propertyId: PROP_A2, roleId: owner.id },
        { userId: USERS.receptionA.id, propertyId: PROP_A, roleId: reception.id },
        { userId: USERS.accountantA.id, propertyId: PROP_A, roleId: accountant.id },
        { userId: USERS.hrA.id, propertyId: PROP_A, roleId: hr.id },
        { userId: USERS.hrA.id, propertyId: PROP_A2, roleId: hr.id }
      ]
    });

    await prisma.staffProfile.create({ data: { id: STAFF_PROFILE_A, userId: USERS.staffA.id, propertyId: PROP_A, employeeCode: "T6A-001" } });
    await prisma.staffProfile.create({ data: { id: STAFF_PROFILE_B, userId: USERS.staffB.id, propertyId: PROP_B, employeeCode: "T6B-001" } });
    await prisma.employmentContract.create({
      data: {
        id: CONTRACT_B_ID,
        staffProfileId: STAFF_PROFILE_B,
        propertyId: PROP_B,
        organizationId: ORG_B,
        contractType: "indefinido",
        startDate: new Date("2026-01-01T00:00:00Z"),
        grossSalary: CONTRACT_B_GROSS,
        irpfRatePct: "15",
        active: true
      }
    });
    await prisma.payrollPeriod.create({
      data: { organizationId: ORG_B, propertyId: PROP_B, periodCode: "2026-08", startDate: new Date("2026-08-01T00:00:00Z"), endDate: new Date("2026-08-31T00:00:00Z") }
    });

    const sessions = await Promise.all([
      login(USERS.ownerA.email, PASSWORD, "t6fix-owner-a"),
      login(USERS.receptionA.email, PASSWORD, "t6fix-reception-a"),
      login(USERS.accountantA.email, PASSWORD, "t6fix-accountant-a"),
      login(USERS.hrA.email, PASSWORD, "t6fix-hr-a")
    ]);
    assert.ok(sessions[0] && sessions[1] && sessions[2] && sessions[3], "the four test sessions must log in");
    [ownerA, receptionA, accountantA, hrA] = sessions as [Session, Session, Session, Session];
    platformAdmin = await login(process.env.INTEGRATION_LOGIN_EMAIL ?? "reception@example.com", process.env.INTEGRATION_LOGIN_PASSWORD ?? "hotelos-demo", "t6fix-platform-admin");
  });

  after(async () => {
    try {
      await flushAuditQueues();
      await removeFixtures();
    } finally {
      if (app) await app.close();
      await prisma.$disconnect();
    }
  });

  // ── t6#6 ────────────────────────────────────────────────────────────────────

  describe("t6#6 · payroll lists are scoped to the caller's organization", () => {
    it("owner of A: ?organizationId=<B> is the opaque 404 of the tenant guard on contracts and periods (no salary, no id of B in the body)", async () => {
      await strict(async () => {
        for (const url of [`/payroll/contracts?organizationId=${ORG_B}`, `/payroll/periods?organizationId=${ORG_B}`]) {
          const res = await getJson(url, ownerA);
          assert.equal(res.status, 404, `${url}: ${res.text.slice(0, 200)}`);
          assert.equal((res.body as ErrorBody).message, "Organización no encontrada.");
          assert.ok(!res.text.includes(ORG_B) && !res.text.includes(CONTRACT_B_GROSS) && !res.text.includes("2026-08"), `${url} leaks B: ${res.text.slice(0, 200)}`);
        }
        const missing = await getJson("/payroll/contracts?organizationId=org_no_existe", ownerA);
        assert.equal(missing.status, 404);
        assert.equal((missing.body as ErrorBody).message, "Organización no encontrada.", "foreign and missing organizations share one neutral message");
      });
    });

    it("owner of A: the plain list and ?organizationId=<A> answer 200 with rows of A only; ?propertyId=<B> is the property 404", async () => {
      await strict(async () => {
        for (const url of ["/payroll/contracts", `/payroll/contracts?organizationId=${ORG_A}`, "/payroll/periods", `/payroll/periods?organizationId=${ORG_A}`]) {
          const res = await getJson(url, ownerA);
          assert.equal(res.status, 200, `${url}: ${res.text.slice(0, 200)}`);
          assert.ok(Array.isArray(res.body), `${url} returns an array`);
          for (const row of res.body as Array<{ organizationId: string }>) assert.equal(row.organizationId, ORG_A, `${url} row of ${row.organizationId}`);
        }
        const foreignProperty = await getJson(`/payroll/contracts?propertyId=${PROP_B}`, ownerA);
        assert.equal(foreignProperty.status, 404, foreignProperty.text.slice(0, 200));
        assert.equal((foreignProperty.body as ErrorBody).message, "Propiedad no encontrada.");
        const badQuery = await getJson("/payroll/contracts?organizationId=", ownerA);
        assert.equal(badQuery.status, 400, badQuery.text.slice(0, 200));
      });
    });

    it("a platform admin may still read another organization's payroll (assertEntityAccess re-points the scope)", async (t) => {
      if (!platformAdmin) return t.skip("platform-admin login unavailable (INTEGRATION_LOGIN_EMAIL / _PASSWORD)");
      await strict(async () => {
        const me = await getJson("/users/me", platformAdmin!);
        if (!(me.body as { isPlatformAdmin?: boolean } | null)?.isPlatformAdmin) return t.skip("the demo login is not a platform admin under strict RBAC");
        const res = await getJson(`/payroll/contracts?organizationId=${ORG_B}`, platformAdmin!);
        assert.equal(res.status, 200, res.text.slice(0, 200));
        const rows = res.body as Array<{ id: string; organizationId: string }>;
        assert.ok(rows.some((row) => row.id === CONTRACT_B_ID && row.organizationId === ORG_B), "the admin sees B's contract");
      });
    });
  });

  // ── t6#9 ────────────────────────────────────────────────────────────────────

  const AMOUNT_READS = [
    "/accounting/journal",
    "/accounting/journal/export",
    "/accounting/ledger/572",
    "/fiscal/models/303",
    "/fiscal/vat-books",
    "/accounting/annual-accounts/balance",
    "/accounting/usali/pnl",
    "/accounting/reports/modelo-303",
    "/accounting/reports/trial-balance",
    `/properties/${PROP_A}/payables/supplier-bills`
  ];
  const CALENDAR_READS = ["/accounting/fiscal-periods", "/finance/exchange-rates", "/accounting/fiscal-years"];

  describe("t6#9 · a real Recepción session under strict RBAC", () => {
    it("is refused (403, accounting.reports.read) on every accounting read with amounts", async () => {
      await strict(async () => {
        for (const url of AMOUNT_READS) {
          const res = await getJson(url, receptionA);
          assert.equal(res.status, 403, `${url}: ${res.status} ${res.text.slice(0, 200)}`);
          // Tanda 8a (design §4.3): the journal export is the gestoría export (analytics.export); the supplier bills are payables.read.
          const key = url === "/accounting/journal/export" ? /analytics\.export/ : url.endsWith("/payables/supplier-bills") ? /payables\.read/ : /accounting\.reports\.read/;
          assert.match(res.text, key, `${url} names the missing key`);
        }
      });
    });

    it("keeps the fiscal calendar and the exchange rates (accounting.read) and the Contabilidad session is not refused on the books", async () => {
      await strict(async () => {
        for (const url of CALENDAR_READS) {
          const res = await getJson(url, receptionA);
          assert.notEqual(res.status, 403, `${url}: ${res.text.slice(0, 200)}`);
          assert.notEqual(res.status, 401, `${url}: ${res.text.slice(0, 200)}`);
        }
        for (const url of AMOUNT_READS) {
          const res = await getJson(url, accountantA);
          assert.notEqual(res.status, 403, `accountant ${url}: ${res.text.slice(0, 200)}`);
          assert.notEqual(res.status, 401, `accountant ${url}: ${res.text.slice(0, 200)}`);
          assert.ok(res.status < 500, `accountant ${url}: ${res.status} ${res.text.slice(0, 200)}`);
        }
      });
    });
  });

  // ── t6#10 ───────────────────────────────────────────────────────────────────

  describe("t6#10 · the Contabilidad template reaches suppliers, received invoices, fixed assets and the gestoría export", () => {
    const WRITES = [
      `/organizations/${ORG_A}/payables/suppliers`,
      `/properties/${PROP_A}/payables/supplier-bills`,
      `/properties/${PROP_A}/asset-register`,
      "/accounting/gestoria-exports"
    ];

    it("an empty body is a 400 (validation), never a 403, for the accountant; the asset register and the export formats list answer 200", async () => {
      await strict(async () => {
        for (const url of WRITES) {
          const res = await postJson(url, accountantA, {});
          assert.equal(res.status, 400, `accountant POST ${url}: ${res.status} ${res.text.slice(0, 200)}`);
        }
        const register = await getJson(`/properties/${PROP_A}/asset-register`, accountantA);
        assert.equal(register.status, 200, register.text.slice(0, 200));
        const formats = await getJson("/accounting/gestoria-exports/formats", accountantA);
        assert.equal(formats.status, 200, formats.text.slice(0, 200));
      });
    });

    it("reception stays refused on the same writes (least privilege)", async () => {
      await strict(async () => {
        for (const url of WRITES) {
          const res = await postJson(url, receptionA, {});
          assert.equal(res.status, 403, `reception POST ${url}: ${res.status} ${res.text.slice(0, 200)}`);
        }
      });
    });
  });

  // ── t6#11 ───────────────────────────────────────────────────────────────────

  // Tanda 8a: contracts are prepared by RRHH (payroll.manage lives in payroll_hr only); commission rules are posted by contabilidad (accounting.journal.post).
  describe("t6#11 · POST /payroll/contracts", () => {
    const VALID = { staffProfileId: STAFF_PROFILE_A, propertyId: PROP_A, contractType: "indefinido", startDate: "2026-01-01", grossSalary: "1800,50", irpfRatePct: 15 };

    it("garbage money and unknown keys are a 400 in Spanish (never 500) and store nothing", async () => {
      await strict(async () => {
        const garbage = await postJson("/payroll/contracts", hrA, { grossSalary: "abc" });
        assert.equal(garbage.status, 400, garbage.text.slice(0, 200));
        assert.match((garbage.body as ErrorBody).message ?? "", /grossSalary debe ser un número con hasta dos decimales/);
        const probe = await postJson("/payroll/contracts", hrA, { staffProfileId: "nope", contractType: "x", startDate: "2026-01-01", grossSalary: 1, foo: 1 });
        assert.equal(probe.status, 400, probe.text.slice(0, 200));
        assert.match((probe.body as ErrorBody).message ?? "", /Campo no admitido en el cuerpo de la petición/);
        assert.match((probe.body as ErrorBody).message ?? "", /contractType debe ser uno de/);
        const notObject = await postJson("/payroll/contracts", hrA, []);
        assert.equal(notObject.status, 400, notObject.text.slice(0, 200));
        assert.equal(await prisma.employmentContract.count({ where: { staffProfileId: "nope" } }), 0, "no orphan contract");
        assert.equal(await prisma.employmentContract.count({ where: { organizationId: ORG_A } }), 0);
      });
    });

    it("a missing, foreign or unassigned staff profile is the same opaque 404; a propertyId that is not the profile's is a typed 400", async () => {
      await strict(async () => {
        const missing = await postJson("/payroll/contracts", hrA, { ...VALID, staffProfileId: "sp_no_existe", propertyId: undefined });
        assert.equal(missing.status, 404, missing.text.slice(0, 200));
        assert.equal((missing.body as ErrorBody).message, "Perfil de empleado no encontrado.");
        const foreign = await postJson("/payroll/contracts", hrA, { ...VALID, staffProfileId: STAFF_PROFILE_B, propertyId: undefined });
        assert.equal(foreign.status, 404, foreign.text.slice(0, 200));
        assert.equal((foreign.body as ErrorBody).message, "Perfil de empleado no encontrado.");
        assert.ok(!foreign.text.includes(PROP_B) && !foreign.text.includes(ORG_B), "no id of B in the body");
        const foreignProperty = await postJson("/payroll/contracts", hrA, { ...VALID, propertyId: PROP_B });
        assert.equal(foreignProperty.status, 404, foreignProperty.text.slice(0, 200));
        assert.equal((foreignProperty.body as ErrorBody).message, "Propiedad no encontrada.");
        const mismatch = await postJson("/payroll/contracts", hrA, { ...VALID, propertyId: PROP_A2 });
        assert.equal(mismatch.status, 400, mismatch.text.slice(0, 200));
        assert.equal((mismatch.body as ErrorBody).details?.code, "STAFF_PROFILE_PROPERTY_MISMATCH");
        assert.equal(await prisma.employmentContract.count({ where: { organizationId: ORG_A } }), 0, "nothing stored by the refused bodies");
      });
    });

    it("a valid body is stored in the caller's organization and listed afterwards (\"1800,50\" → 1800.5)", async () => {
      await strict(async () => {
        const created = await postJson("/payroll/contracts", hrA, VALID);
        assert.equal(created.status, 200, created.text.slice(0, 300));
        const row = created.body as { id: string; organizationId: string; propertyId: string; staffProfileId: string; grossSalary: number; irpfRatePct?: number; contractType: string };
        assert.equal(row.organizationId, ORG_A);
        assert.equal(row.propertyId, PROP_A);
        assert.equal(row.staffProfileId, STAFF_PROFILE_A);
        assert.equal(row.grossSalary, 1800.5);
        assert.equal(row.irpfRatePct, 15);
        assert.equal(row.contractType, "indefinido");
        const list = await getJson("/payroll/contracts", hrA);
        assert.equal(list.status, 200);
        assert.ok((list.body as Array<{ id: string }>).some((contract) => contract.id === row.id));
        const stored = await prisma.employmentContract.findUnique({ where: { id: row.id }, select: { grossSalary: true, organizationId: true } });
        assert.equal(stored?.grossSalary.toFixed(2), "1800.50");
        assert.equal(stored?.organizationId, ORG_A);
      });
    });
  });

  describe("t6#11 · POST /commissions/rules", () => {
    it("garbage ratePct is a 400 in Spanish (never decimal.js in a 500); a foreign channel or property is an opaque 404", async () => {
      await strict(async () => {
        const garbage = await postJson("/commissions/rules", accountantA, { propertyId: PROP_A, ratePct: "abc" });
        assert.equal(garbage.status, 400, garbage.text.slice(0, 200));
        assert.match((garbage.body as ErrorBody).message ?? "", /ratePct debe ser un número con hasta dos decimales/);
        const noChannel = await postJson("/commissions/rules", accountantA, { propertyId: PROP_A, ratePct: 10 });
        assert.equal(noChannel.status, 400, noChannel.text.slice(0, 200));
        assert.match((noChannel.body as ErrorBody).message ?? "", /Indica channelId o channelCode/);
        const unknownKey = await postJson("/commissions/rules", accountantA, { propertyId: PROP_A, channelCode: "booking", ratePct: 10, foo: 1 });
        assert.equal(unknownKey.status, 400, unknownKey.text.slice(0, 200));
        const foreignChannel = await postJson("/commissions/rules", accountantA, { propertyId: PROP_A, channelId: "ch_no_existe", ratePct: 12 });
        assert.equal(foreignChannel.status, 404, foreignChannel.text.slice(0, 200));
        assert.equal((foreignChannel.body as ErrorBody).message, "Canal no encontrado.");
        const foreignProperty = await postJson("/commissions/rules", accountantA, { propertyId: PROP_B, channelCode: "booking", ratePct: 12 });
        assert.equal(foreignProperty.status, 404, foreignProperty.text.slice(0, 200));
        assert.equal((foreignProperty.body as ErrorBody).message, "Propiedad no encontrada.");
        assert.equal(await prisma.commissionRule.count({ where: { propertyId: { in: PROPS } } }), 0, "nothing stored by the refused bodies");
      });
    });

    it("a valid body is stored: channelCode lower-cased, \"15,5\" → 15.50, appliesTo kept", async () => {
      await strict(async () => {
        const created = await postJson("/commissions/rules", accountantA, { propertyId: PROP_A, channelCode: "Booking", ratePct: "15,5", appliesTo: "net_revenue" });
        assert.equal(created.status, 200, created.text.slice(0, 300));
        const row = created.body as { id: string; propertyId: string; channelCode: string | null; ratePct: string; appliesTo: string; active: boolean };
        assert.equal(row.propertyId, PROP_A);
        assert.equal(row.channelCode, "booking");
        assert.equal(row.ratePct, "15.5");
        assert.equal(row.appliesTo, "net_revenue");
        assert.equal(row.active, true);
        // Tanda 8a: commissions.read left the accountant template (design §6.5); Propiedad (owner) reads the rules it never writes.
        const list = await getJson(`/commissions/rules?propertyId=${PROP_A}`, ownerA);
        assert.equal(list.status, 200, list.text.slice(0, 200));
        assert.ok((list.body as Array<{ id: string }>).some((rule) => rule.id === row.id));
      });
    });
  });
});
