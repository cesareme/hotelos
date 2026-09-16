/**
 * Estructura societaria · L5 «Declarante, régimen SII, USALI, cuentas anuales,
 * permisos» · integration (Postgres required; in-process services + REAL HTTP
 * via app.inject). Design: docs/design/FINANZAS-ESTRUCTURA-SOCIETARIA.md §6
 * (criterios de cierre C1, C4, C5, C7, C9) and §5.2 R8 / R9 / R11.
 *
 * An ISOLATED sociedad (`org_l5_<run>`: legal entity TST · B77341204 · S.A.,
 * two hotels NO / SU with rooms, one `office` centre OC, chart «PGC Pymes
 * hotelero» provisioned) is created here and removed in `after`:
 *   · invoices FAC 110,00 @10 % (NO) and FAC 220,00 @10 % (SU) dated May 2026;
 *     a supplier bill 100,00 @21 % posted on the office (OC) with a 15 %
 *     withholding record; journal entries of every document plus a
 *     society-level entry without centre (interest 5,00 on 662) and the
 *     capital contribution (572 / 100);
 *   · a REAL user «Director Sur» whose only role lives in SU (accounting.read +
 *     accounting.reports.read + accounting.journal.post + ai.high_risk.confirm +
 *     analytics.export, never accounting.entity.read) and a REAL «Directora»
 *     (same keys + accounting.entity.read, roles in NO/SU/OC) log in through
 *     /auth/login for the C7 HTTP cases (fix:L5 t6b#4 gestoría exports and
 *     t6b#5 society-level asientos);
 *   · 2027 entries of the office only (fix:L5 t6b#16, outside every 2026
 *     figure): June asesoría 100 (623) + financial income 250 (762) → GOP −100
 *     and net +150; July asesoría 100 + central services billed 300 (759) →
 *     GOP +200. USALI and the PyG por centro must split the SAME −GOP.
 * Expected 2026-Q2 303 of the sociedad: 04 = 300 · 06 = 30 · 27 = 30 · 28 = 100 ·
 * 29 = 21 · 45 = 21 · 46 = 9 · 71 = 9 = Σ of the three centre views (NO 10 · SU
 * 20 · OC −21). USALI May 2026: GOP NO 70 · SU 160 · Oficina −90 · sin asignar
 * 0 → total sociedad 140; reparto por habitaciones (10 y 5 habitaciones × 31
 * noches): 60,00 / 30,00 = 90,00; resultado neto total 135 (−5 intereses).
 *
 * Faranda and org_123 are READ-ONLY probes (C9): the 303 of 2026-Q3 keeps the
 * figures of the runbook (§14/§16: 27 = 71 = 74,94) and the declarante is the
 * sociedad; row counts before == after. The org_123 figures are compared only when
 * the database is at rest (sister suites write and clean org_123 in parallel).
 *
 * Run from the repo root:
 *   cd apps/api && node --import tsx --test "../../tests/integration/structure-l5.test.mts"
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

const { prisma, hashPassword } = await import("@hotelos/database");
const { provisionOrganizationChart } = await import("../../apps/api/src/modules/accounting/chart-of-accounts.service.js");
const { buildModelo303 } = await import("../../apps/api/src/modules/accounting/modelo-303.service.js");
const { buildModelo347 } = await import("../../apps/api/src/modules/accounting/modelo-347.service.js");
const { buildFiscalRegimeReport, buildModelo390 } = await import("../../apps/api/src/modules/accounting/modelo-390.service.js");
const { buildModelo111 } = await import("../../apps/api/src/modules/accounting/modelo-111.service.js");
const { getVatSettings, money, updateVatSettings } = await import("../../apps/api/src/modules/accounting/vat-books.service.js");
const { buildFiscalModel } = await import("../../apps/api/src/modules/accounting/fiscal.routes.js");
const { assertFinanceReadScope } = await import("../../apps/api/src/modules/accounting/ledger.routes.js");
const { compareUsaliProperties } = await import("../../apps/api/src/modules/financial-statements/usali.service.js");
const { buildPnlByProperty } = await import("../../apps/api/src/modules/financial-statements/pnl-by-property.service.js");
const { buildAnnualAccounts, buildBalanceSheet } = await import("../../apps/api/src/modules/financial-statements/annual-accounts.service.js");
const { getCorporateAllocationView, putCorporateAllocation } = await import("../../apps/api/src/modules/financial-statements/allocation.service.js");
const { flushAuditQueues } = await import("../../apps/api/src/modules/audit/audit.service.js");

type ApiApp = Awaited<ReturnType<(typeof import("../../apps/api/src/server.js"))["buildApiServer"]>>;
type Headers = Record<string, string>;
type UserContext = Parameters<typeof buildModelo303>[0]["context"];
type Report = Awaited<ReturnType<typeof buildModelo303>>;
type HttpErrorLike = { statusCode?: number; details?: { code?: string; forcedBy?: string }; message: string };
type ErrorBody = { statusCode?: number; message?: string; details?: { code?: string } };

const RUN = Date.now().toString(36);
const ORG = `org_l5_${RUN}`;
const LE = `le_l5_${RUN}`;
const NO = `prop_l5_no_${RUN}`;
const SU = `prop_l5_su_${RUN}`;
const OC = `prop_l5_oc_${RUN}`;
/** Checksum-valid CIF no demo tenant uses (B77341204). */
const TAX_ID = "B77341204";
const LEGAL_NAME = "Sociedad L5 Test SA";
const DIRECTOR_EMAIL = `director.sur.${RUN}@l5.test`;
const DIRECTOR_PASSWORD = `L5-director-${RUN}-Aa1!`;
const FARANDA_ORG = "cmrhw9jy30002fyvb6tsdiugt";
const MAY = { from: "2026-05-01", to: "2026-05-31" };
const YEAR = { from: "2026-01-01", to: "2026-12-31" };
const JUNE27 = { from: "2027-06-01", to: "2027-06-30" };
const JULY27 = { from: "2027-07-01", to: "2027-07-31" };
const DIRECTORA_EMAIL = `directora.${RUN}@l5.test`;
const DIRECTORA_PASSWORD = `L5-directora-${RUN}-Aa1!`;
/** REAL grants of the director (roles in SU only): reads with amounts, posting, reversal confirmation and the export key — never the entity key. */
const DIRECTOR_KEYS = ["accounting.read", "accounting.reports.read", "accounting.journal.post", "ai.high_risk.confirm", "analytics.export"] as const;

const D = money;
const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

/** The directora: whole-sociedad reads (accounting.entity.read). */
const directora: UserContext = {
  organizationId: ORG,
  propertyId: NO,
  userId: "usr_l5_directora",
  fullName: "Directora L5",
  deviceId: "l5-integration",
  permissions: ["accounting.read", "accounting.reports.read", "accounting.entity.read", "accounting.configure"] as UserContext["permissions"],
  assignedPropertyIds: [NO, SU, OC]
};
/** A director with a role only in SU and no entity key. */
const directorSur: UserContext = { ...directora, userId: "usr_l5_director", propertyId: SU, permissions: ["accounting.read", "accounting.reports.read"] as UserContext["permissions"], assignedPropertyIds: [SU] };
const farandaCtx: UserContext = { ...directora, organizationId: FARANDA_ORG, propertyId: "cmrhw9jy40003fyvbuu2ec2w7", assignedPropertyIds: undefined };
const org123Ctx: UserContext = { ...directora, organizationId: "org_123", propertyId: "prop_123", assignedPropertyIds: undefined };

const casilla = (report: Report, code: string): number => {
  const box = report.casillas.find((entry) => entry.casilla === code);
  assert.ok(box, `casilla ${code} missing in ${report.modelo}`);
  return box.importe;
};
const expectError = async (promise: Promise<unknown>, statusCode: number, code: string): Promise<HttpErrorLike> => {
  try {
    await promise;
  } catch (error) {
    const e = error as HttpErrorLike;
    assert.equal(e.statusCode, statusCode, e.message);
    assert.equal(e.details?.code, code, e.message);
    return e;
  }
  assert.fail(`expected ${statusCode} ${code}`);
};

type Line = [code: string, debit: string, credit: string, taxRateCode?: string, taxBase?: string];

/** Posts a balanced entry straight into the ledger (the posting engine is L4's subject, not this suite's). */
async function post(propertyId: string | null, date: string, sourceType: string, description: string, lines: Line[]): Promise<string> {
  const codes = Array.from(new Set(lines.map(([code]) => code)));
  const accounts = await prisma.account.findMany({ where: { organizationId: ORG, code: { in: codes } }, select: { id: true, code: true } });
  const idByCode = new Map(accounts.map((a) => [a.code, a.id]));
  for (const code of codes) assert.ok(idByCode.has(code), `account ${code} missing in the provisioned chart`);
  const entry = await prisma.journalEntry.create({
    data: { organizationId: ORG, propertyId, sourceType, sourceId: `l5:${RUN}:${sourceType}:${date}:${description}`, status: "posted", postedAt: day(date), entryDate: day(date), entryKind: "normal", fiscalYearCode: date.slice(0, 4), entryNumber: null, description: `${description} [structure-l5]` }
  });
  await prisma.journalLine.createMany({
    data: lines.map(([code, debit, credit, taxRateCode, taxBase]) => ({ journalEntryId: entry.id, accountId: idByCode.get(code)!, accountCode: code, debit, credit, currency: "EUR", taxRateCode: taxRateCode ?? null, taxBase: taxBase ?? null }))
  });
  return entry.id;
}

async function createInvoice(input: { id: string; propertyId: string; number: string; gross: string; tax: string; rate: string; nif: string; name: string; issuedAt: string }): Promise<void> {
  const base = D(input.gross).minus(D(input.tax));
  await prisma.invoice.create({
    data: {
      id: input.id,
      propertyId: input.propertyId,
      legalEntityId: LE,
      invoiceNumber: input.number,
      invoiceType: "F1",
      customerType: "company",
      customerTaxId: input.nif,
      customerName: input.name,
      status: "issued",
      issuedAt: new Date(input.issuedAt),
      total: D(input.gross),
      taxTotal: D(input.tax),
      baseTotal: base,
      seriesCode: "FAC",
      simplified: false,
      customerRequired: true,
      issuerTaxId: TAX_ID,
      issuerLegalName: LEGAL_NAME,
      taxBreakdownJson: [{ figure: "IVA", impuesto: "01", calificacion: "S1", ratePercent: Number(input.rate), base: Number(base.toFixed(2)), quota: Number(input.tax) }]
    }
  });
  await prisma.invoiceLine.create({
    data: { invoiceId: input.id, description: `Alojamiento ${input.number}`, quantity: D(1), unitPrice: D(input.gross), taxCode: `ES_IVA_${input.rate}`, taxRate: D(input.rate), total: D(input.gross), taxCategory: "accommodation", taxCalificacion: "S1", taxFigure: "IVA" }
  });
}

async function farandaCounts(): Promise<Record<string, number | string>> {
  const entity = await prisma.legalEntity.findFirst({ where: { organizationId: FARANDA_ORG, isDefault: true }, select: { taxId: true, siiEnabled: true, largeCompany: true, pgcVariant: true } });
  const entries = await prisma.journalEntry.findMany({ where: { organizationId: FARANDA_ORG }, select: { id: true } });
  const properties = await prisma.property.findMany({ where: { organizationId: FARANDA_ORG }, select: { id: true } });
  return {
    vatSettings: await prisma.vatSettings.count({ where: { organizationId: FARANDA_ORG } }),
    vatBookEntries: await prisma.vatBookEntry.count({ where: { organizationId: FARANDA_ORG } }),
    journalEntries: entries.length,
    journalLines: await prisma.journalLine.count({ where: { journalEntryId: { in: entries.map((e) => e.id) } } }),
    invoices: await prisma.invoice.count({ where: { propertyId: { in: properties.map((p) => p.id) } } }),
    accountingSettings: await prisma.accountingSetting.count({ where: { organizationId: FARANDA_ORG } }),
    entity: JSON.stringify(entity)
  };
}

let app: ApiApp | null = null;
let serverLoadError: string | null = null;
let demoHeaders: Headers = {};
let directorHeaders: Headers = {};
let directorUserId: string | null = null;
let roleId: string | null = null;
let directoraHeaders: Headers = {};
let directoraUserId: string | null = null;
let directoraRoleId: string | null = null;
let farandaBefore: Record<string, number | string> = {};

async function login(email: string, password: string, deviceId: string): Promise<Headers> {
  if (!app) return {};
  const res = await app.inject({ method: "POST", url: "/auth/login", payload: { email, password, deviceId } });
  if (res.statusCode !== 200) return {};
  return { authorization: `Bearer ${(JSON.parse(res.body) as { token: string }).token}` };
}

/**
 * The repo .env (HOTELOS_ALLOW_DEMO_AUTH=true, NODE_ENV=development) enables the
 * dev/demo permission UNION (auth.service.ts unionPermissions): every real
 * session also holds the demoStore baseline, which since L2 carries
 * `accounting.entity.read`. The union is read per request, so the cases that
 * prove the REAL grants of the director pin the strict setting for their
 * duration (same pattern as rbac-scope.test.mts).
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

async function getJson<T>(url: string, headers: Headers): Promise<{ status: number; body: T; text: string }> {
  const res = await app!.inject({ method: "GET", url, headers });
  let body: T;
  try {
    body = JSON.parse(res.body) as T;
  } catch {
    body = null as T;
  }
  return { status: res.statusCode, body, text: res.body };
}

async function postJson<T>(url: string, headers: Headers, payload: unknown): Promise<{ status: number; body: T; text: string }> {
  const res = await app!.inject({ method: "POST", url, headers, payload: payload as Record<string, unknown> });
  let body: T;
  try {
    body = JSON.parse(res.body) as T;
  } catch {
    body = null as T;
  }
  return { status: res.statusCode, body, text: res.body };
}

async function cleanup(): Promise<void> {
  const entries = await prisma.journalEntry.findMany({ where: { organizationId: ORG }, select: { id: true } });
  await prisma.journalLine.deleteMany({ where: { journalEntryId: { in: entries.map((e) => e.id) } } });
  await prisma.journalEntry.deleteMany({ where: { organizationId: ORG } });
  await prisma.vatBookEntry.deleteMany({ where: { organizationId: ORG } });
  await prisma.vatSettings.deleteMany({ where: { organizationId: ORG } });
  await prisma.withholdingTaxRecord.deleteMany({ where: { organizationId: ORG } });
  await prisma.supplierBill.deleteMany({ where: { organizationId: ORG } });
  await prisma.supplier.deleteMany({ where: { organizationId: ORG } });
  const invoices = await prisma.invoice.findMany({ where: { propertyId: { in: [NO, SU, OC] } }, select: { id: true } });
  await prisma.invoiceLine.deleteMany({ where: { invoiceId: { in: invoices.map((i) => i.id) } } });
  await prisma.invoice.deleteMany({ where: { propertyId: { in: [NO, SU, OC] } } });
  await prisma.room.deleteMany({ where: { propertyId: { in: [NO, SU, OC] } } });
  await prisma.roomType.deleteMany({ where: { propertyId: { in: [NO, SU, OC] } } });
  await prisma.financialStatementSnapshot.deleteMany({ where: { organizationId: ORG } });
  await prisma.gestoriaExport.deleteMany({ where: { organizationId: ORG } });
  await prisma.account.deleteMany({ where: { organizationId: ORG } });
  await prisma.accountingSetting.deleteMany({ where: { organizationId: ORG } });
  for (const userId of [directorUserId, directoraUserId]) {
    if (!userId) continue;
    await prisma.session.deleteMany({ where: { userId } });
    await prisma.device.deleteMany({ where: { userId } });
    await prisma.userPropertyRole.deleteMany({ where: { userId } });
    await prisma.user.deleteMany({ where: { id: userId } });
  }
  for (const id of [roleId, directoraRoleId]) {
    if (!id) continue;
    await prisma.rolePermission.deleteMany({ where: { roleId: id } });
    await prisma.role.deleteMany({ where: { id } });
  }
  await prisma.property.deleteMany({ where: { organizationId: ORG } });
  await prisma.legalEntity.deleteMany({ where: { organizationId: ORG } });
  await prisma.organization.deleteMany({ where: { id: ORG } });
}

before(async () => {
  farandaBefore = await farandaCounts();
  try {
    const { buildApiServer } = await import("../../apps/api/src/server.js");
    app = await buildApiServer();
    await app.ready();
    demoHeaders = await login(process.env.INTEGRATION_LOGIN_EMAIL ?? "reception@example.com", process.env.INTEGRATION_LOGIN_PASSWORD ?? "hotelos-demo", "l5-integration-demo");
  } catch (error) {
    serverLoadError = (error as Error).message;
    console.warn(`[structure-l5] server.ts unavailable, HTTP cases skipped: ${serverLoadError}`);
  }

  await prisma.organization.create({ data: { id: ORG, name: "L5 Test Hotels", legalName: "Nombre heredado que nadie debe leer SL", taxId: "B00000000", country: "ES" } });
  await prisma.legalEntity.create({ data: { id: LE, organizationId: ORG, code: "TST", legalName: LEGAL_NAME, taxId: TAX_ID, legalForm: "sa", fiscalAddress: "Calle Real 1", fiscalMunicipality: "A Coruña", fiscalProvince: "A Coruña", isDefault: true } });
  await prisma.property.create({ data: { id: NO, organizationId: ORG, legalEntityId: LE, kind: "hotel", code: "NO", name: "Hotel Norte L5", municipality: "Oleiros", timezone: "Europe/Madrid" } });
  await prisma.property.create({ data: { id: SU, organizationId: ORG, legalEntityId: LE, kind: "hotel", code: "SU", name: "Hotel Sur L5", municipality: "Teo", timezone: "Europe/Madrid" } });
  await prisma.property.create({ data: { id: OC, organizationId: ORG, legalEntityId: LE, kind: "office", code: "OC", name: "Oficina central L5", municipality: "Madrid", timezone: "Europe/Madrid" } });
  const provisioned = await provisionOrganizationChart(ORG);
  assert.ok(provisioned.created >= 200, `chart provisioned: ${JSON.stringify(provisioned)}`);

  // Rooms: 10 in NO, 5 in SU (allocation key rooms_available = rooms × 31 nights of May).
  for (const [propertyId, count] of [[NO, 10], [SU, 5]] as const) {
    const type = await prisma.roomType.create({ data: { propertyId, name: "Doble", code: "DBL", maxOccupancy: 2, baseCapacity: 2 } });
    await prisma.room.createMany({ data: Array.from({ length: count }, (_, i) => ({ propertyId, roomTypeId: type.id, number: String(101 + i), active: true })) });
  }

  await createInvoice({ id: `inv_l5_no_${RUN}`, propertyId: NO, number: `FAC-NO-2026-${RUN}`, gross: "110.00", tax: "10.00", rate: "10", nif: "B00000001", name: "Cliente Norte SL", issuedAt: "2026-05-10T10:00:00.000Z" });
  await createInvoice({ id: `inv_l5_su_${RUN}`, propertyId: SU, number: `FAC-SU-2026-${RUN}`, gross: "220.00", tax: "20.00", rate: "10", nif: "B00000002", name: "Cliente Sur SL", issuedAt: "2026-05-12T10:00:00.000Z" });
  const supplier = await prisma.supplier.create({ data: { organizationId: ORG, name: "Asesoría Central SL", taxId: "B00000003", retentionRate: D(15), retentionRowCode: "02" }, select: { id: true } });
  const bill = await prisma.supplierBill.create({
    data: {
      propertyId: OC,
      organizationId: ORG,
      supplierId: supplier.id,
      supplierName: "Asesoría Central SL",
      supplierTaxId: "B00000003",
      invoiceNumber: `AC-${RUN}-05`,
      issueDate: day("2026-05-20"),
      baseTotal: D("100.00"),
      taxTotal: D("21.00"),
      total: D("106.00"),
      retentionRate: D(15),
      retentionAmount: D("15.00"),
      rowCode: "02",
      status: "posted",
      postedAt: new Date("2026-05-20T10:00:00.000Z"),
      lines: { create: [{ lineNo: 1, description: "Asesoría fiscal mayo (oficina)", expenseAccountCode: "623", base: D("100.00"), taxRate: D(21), quota: D("21.00"), retention: D("15.00") }] }
    },
    select: { id: true }
  });
  await prisma.withholdingTaxRecord.create({
    data: { organizationId: ORG, propertyId: OC, sourceType: "vendor_invoice", sourceId: bill.id, recipientNif: "B00000003", recipientName: "Asesoría Central SL", grossAmount: D("100.00"), retentionRate: D(15), retentionAmount: D("15.00"), rowCode: "02", paymentDate: day("2026-05-20") }
  });

  // Ledger (May 2026): hotels, office and one society-level entry without centre.
  await post(null, "2026-01-02", "manual", "Aportación de capital", [["572", "1000.00", "0"], ["100", "0", "1000.00"]]);
  await post(NO, "2026-05-10", "invoice", "Factura FAC-NO", [["4300", "110.00", "0"], ["705.1", "0", "100.00", "10"], ["477.10", "0", "10.00", "10", "100.00"]]);
  await post(NO, "2026-05-31", "payroll_slip", "Nómina Norte", [["640.1", "30.00", "0"], ["465", "0", "30.00"]]);
  await post(SU, "2026-05-12", "invoice", "Factura FAC-SU", [["4300", "220.00", "0"], ["705.1", "0", "200.00", "10"], ["477.10", "0", "20.00", "10", "200.00"]]);
  await post(SU, "2026-05-31", "payroll_slip", "Nómina Sur", [["640.1", "40.00", "0"], ["465", "0", "40.00"]]);
  await post(OC, "2026-05-20", "supplier_bill", "Asesoría oficina central", [["623", "90.00", "0"], ["410", "0", "90.00"]]);
  await post(null, "2026-05-31", "manual", "Intereses bancarios de la sociedad", [["662", "5.00", "0"], ["572", "0", "5.00"]]);

  // 2027, office only (t6b#16; outside every 2026 figure): June GOP −100 / net +150; July GOP +200.
  await post(OC, "2027-06-10", "supplier_bill", "Asesoría oficina junio", [["623", "100.00", "0"], ["410", "0", "100.00"]]);
  await post(OC, "2027-06-30", "manual", "Intereses a favor de la sociedad", [["572", "250.00", "0"], ["762", "0", "250.00"]]);
  await post(OC, "2027-07-10", "supplier_bill", "Asesoría oficina julio", [["623", "100.00", "0"], ["410", "0", "100.00"]]);
  await post(OC, "2027-07-20", "invoice", "Servicios centrales a terceros", [["4300", "300.00", "0"], ["759", "0", "300.00"]]);

  // REAL users for C7. Director: a role in SU only with DIRECTOR_KEYS and WITHOUT accounting.entity.read.
  // Directora: the same keys + accounting.entity.read as a REAL grant, roles in the three centres.
  const keys = await prisma.permission.findMany({ where: { key: { in: [...DIRECTOR_KEYS, "accounting.entity.read"] } }, select: { id: true, key: true } });
  if (keys.length === DIRECTOR_KEYS.length + 1) {
    const directorKeys = keys.filter((k) => (DIRECTOR_KEYS as readonly string[]).includes(k.key));
    const role = await prisma.role.create({ data: { organizationId: ORG, name: `Director Sur L5 ${RUN}`, templateKey: null }, select: { id: true } });
    roleId = role.id;
    await prisma.rolePermission.createMany({ data: directorKeys.map((k) => ({ roleId: role.id, permissionId: k.id })) });
    const user = await prisma.user.create({ data: { organizationId: ORG, email: DIRECTOR_EMAIL, fullName: "Director Sur L5", status: "active", passwordHash: hashPassword(DIRECTOR_PASSWORD), passwordChangedAt: new Date(), mustChangePassword: false }, select: { id: true } });
    directorUserId = user.id;
    await prisma.userPropertyRole.create({ data: { userId: user.id, propertyId: SU, roleId: role.id } });
    directorHeaders = await login(DIRECTOR_EMAIL, DIRECTOR_PASSWORD, "l5-integration-director");

    const entityRole = await prisma.role.create({ data: { organizationId: ORG, name: `Directora L5 ${RUN}`, templateKey: null }, select: { id: true } });
    directoraRoleId = entityRole.id;
    await prisma.rolePermission.createMany({ data: keys.map((k) => ({ roleId: entityRole.id, permissionId: k.id })) });
    const entityUser = await prisma.user.create({ data: { organizationId: ORG, email: DIRECTORA_EMAIL, fullName: "Directora L5", status: "active", passwordHash: hashPassword(DIRECTORA_PASSWORD), passwordChangedAt: new Date(), mustChangePassword: false }, select: { id: true } });
    directoraUserId = entityUser.id;
    await prisma.userPropertyRole.createMany({ data: [NO, SU, OC].map((propertyId) => ({ userId: entityUser.id, propertyId, roleId: entityRole.id })) });
    directoraHeaders = await login(DIRECTORA_EMAIL, DIRECTORA_PASSWORD, "l5-integration-directora");
  }
});

after(async () => {
  try {
    await flushAuditQueues();
    await cleanup();
    assert.deepEqual(await farandaCounts(), farandaBefore, "Faranda must be untouched (read-only probes)");
  } finally {
    await app?.close();
    await prisma.$disconnect();
  }
});

describe("C1 · un 303 por sociedad que agrega centros (declarante = LegalEntity)", () => {
  it("las casillas del 303 de la sociedad son la suma exacta de las tres vistas parciales y el declarante es la sociedad", async () => {
    const total = await buildModelo303({ context: directora, period: "2026-Q2" });
    assert.deepEqual(total.declarante, { nif: TAX_ID, nombre: LEGAL_NAME }, "declarante = razón social y NIF de la LegalEntity, nunca Organization.legalName");
    assert.deepEqual([total.sociedad.legalEntityId, total.sociedad.code, total.sociedad.legalName, total.sociedad.taxId, total.sociedad.taxIdValid, total.sociedad.source], [LE, "TST", LEGAL_NAME, TAX_ID, true, "legal_entity"]);
    assert.deepEqual(total.sociedad.regimen, { siiEnabled: false, largeCompany: false, periodicity: "quarterly", persistedPeriodicity: "quarterly", periodicityForcedBy: null, modelosNoPresentados: [], verifactu: { aplica: true, motivo: null } });
    assert.deepEqual(["04", "06", "27", "28", "29", "45", "46", "71"].map((c) => casilla(total, c)), [300, 30, 30, 100, 21, 21, 9, 9]);
    assert.equal(total.propertyId, null);
    assert.ok(!total.avisos.some((a) => /no liquidable/.test(a)), "the whole-sociedad model is the one that is filed");

    const views = await Promise.all([NO, SU, OC].map((propertyId) => buildModelo303({ context: directora, period: "2026-Q2", propertyId })));
    assert.deepEqual(views.map((v) => casilla(v, "27")), [10, 20, 0]);
    assert.deepEqual(views.map((v) => casilla(v, "45")), [0, 0, 21]);
    assert.deepEqual(views.map((v) => casilla(v, "71")), [10, 20, -21]);
    for (const code of ["04", "06", "27", "28", "29", "45", "46", "71"]) {
      const sum = views.reduce((acc, v) => acc + casilla(v, code), 0);
      assert.equal(Number(sum.toFixed(2)), casilla(total, code), `casilla ${code}: Σ vistas parciales = sociedad`);
    }
    for (const view of views) {
      assert.deepEqual(view.declarante, total.declarante, "every partial view declares the sociedad");
      assert.ok(view.avisos.some((a) => /no liquidable/.test(a)), `partial view ${view.propertyId} carries the «no liquidable» notice`);
    }
    // The office view carries the received invoice only: the centre kind changes nothing in the VAT arithmetic.
    assert.equal(views[2]!.fuentes.libros?.recibidas?.cuota, 21);
    // 111 of the sociedad includes the office withholding; the whole-sociedad view is the retenedor's.
    const m111 = await buildModelo111({ context: directora, period: "2026-Q2" });
    assert.deepEqual([casilla(m111, "07"), casilla(m111, "08"), casilla(m111, "09"), casilla(m111, "28")], [1, 100, 15, 15]);
    assert.deepEqual(m111.declarante, total.declarante);
  });
});

describe("R8 · régimen SII / gran empresa de la sociedad (una sola fuente)", () => {
  it("con SII: mensual forzado (400 PERIOD_MISMATCH en trimestres), 347/390 «no se presenta», VeriFactu no aplica, PUT trimestral → 409; propuesta al cierre", async () => {
    await prisma.legalEntity.update({ where: { id: LE }, data: { siiEnabled: true, largeCompany: true } });
    try {
      const settings = await getVatSettings(ORG);
      assert.equal(settings.periodicity, "monthly");
      assert.equal(settings.persisted, false);
      assert.deepEqual([settings.sociedad.regimen.periodicityForcedBy, settings.sociedad.regimen.persistedPeriodicity, settings.sociedad.regimen.modelosNoPresentados], ["sii", "quarterly", ["347", "390"]]);
      assert.equal(settings.sociedad.regimen.verifactu.aplica, false);
      assert.match(settings.sociedad.regimen.verifactu.motivo ?? "", /RD 1007\/2023 art\. 3\.3/);

      const mismatch = await expectError(buildModelo303({ context: directora, period: "2026-Q2" }), 400, "PERIOD_MISMATCH");
      assert.equal(mismatch.details?.forcedBy, "sii");
      const monthly = await buildModelo303({ context: directora, period: "2026-05" });
      assert.deepEqual([casilla(monthly, "27"), casilla(monthly, "45"), casilla(monthly, "71")], [30, 21, 9]);
      assert.ok(monthly.avisos.some((a) => /acogida al SII.*mensualmente/.test(a)), monthly.avisos.join("\n"));
      assert.ok(monthly.avisos.some((a) => /347 y 390 no se presentan y VeriFactu no aplica/.test(a)), monthly.avisos.join("\n"));
      await expectError(buildModelo111({ context: directora, period: "2026-Q2" }), 400, "PERIOD_MISMATCH");
      assert.equal(casilla(await buildModelo111({ context: directora, period: "2026-05" }), "28"), 15);

      const m347 = await buildModelo347({ context: directora, year: 2026 });
      assert.match(m347.presentacion.noSePresenta?.motivo ?? "", /Modelo 347 no se presenta/);
      assert.equal(m347.avisos[0], m347.presentacion.noSePresenta?.motivo, "the notice is the first aviso");
      assert.equal(m347.totales.declarados, 0, "figures stay informative");
      const m390 = await buildModelo390({ context: directora, year: 2026 });
      assert.match(m390.presentacion.noSePresenta?.motivo ?? "", /Modelo 390 no se presenta/);
      assert.equal(m390.totales.periodos, 12, "twelve monthly periods under the forced regime");
      assert.equal(m390.totales.volumenOperaciones, 300);

      await expectError(updateVatSettings({ context: directora, patch: { periodicity: "quarterly" } }), 409, "PERIODICITY_FORCED_BY_REGIME");
      const regime = await buildFiscalRegimeReport({ context: directora, year: 2026 });
      assert.deepEqual([regime.volumenOperaciones, regime.umbralGranEmpresa, regime.propuesta.regimen, regime.propuesta.cambia], [300, 6010121.04, "general", true]);
      assert.match(regime.propuesta.motivo, /300,00 € ≤ 6\.010\.121,04 €/);
    } finally {
      await prisma.legalEntity.update({ where: { id: LE }, data: { siiEnabled: false, largeCompany: false } });
    }
    const back = await buildFiscalRegimeReport({ context: directora, year: 2026 });
    assert.deepEqual([back.sociedad.regimen.periodicity, back.propuesta.regimen, back.propuesta.cambia], ["quarterly", "general", false]);
    assert.equal((await buildModelo347({ context: directora, year: 2026 })).presentacion.noSePresenta, undefined);
  });
});

describe("C4 · cuentas anuales por sociedad", () => {
  it("un solo juego con entityLabel = razón social; la memoria lista los 3 centros con código y tipo; largeCompany → formato Pymes no depositable (aviso, no error)", async () => {
    const accounts = await buildAnnualAccounts({ context: directora, ...YEAR });
    assert.equal(accounts.entityLabel, `${LEGAL_NAME} · NIF ${TAX_ID}`);
    assert.deepEqual([accounts.entity.legalEntityId, accounts.entity.code, accounts.entity.legalName, accounts.entity.taxId, accounts.entity.source, accounts.entity.pgcVariant], [LE, "TST", LEGAL_NAME, TAX_ID, "legal_entity", "pymes"]);
    assert.deepEqual(accounts.format, { template: "pgc_pymes_hotelero_v1", pgcVariant: "pymes", depositable: true, reason: null });
    assert.equal(accounts.balance.balanced, true);
    assert.equal(accounts.pyg.netResult, "135.00");
    assert.deepEqual(accounts.memoria.entity.properties.map((p) => [p.code, p.kind, p.name]), [["NO", "hotel", "Hotel Norte L5"], ["SU", "hotel", "Hotel Sur L5"], ["OC", "office", "Oficina central L5"]]);
    assert.deepEqual([accounts.memoria.entity.legalName, accounts.memoria.entity.taxId, accounts.memoria.entity.legalEntityId], [LEGAL_NAME, TAX_ID, LE]);
    const nota1 = accounts.memoria.notes.find((n) => n.number === 1)!;
    assert.match(nota1.text, /Sociedad L5 Test SA \(NIF B77341204, SA\)/);
    assert.match(nota1.text, /3: 2 hotel\(es\), 1 oficina\(s\), 0 otro\(s\)/);
    assert.match(nota1.text, /OC · Oficina central L5 \(Oficina, Madrid\)/);
    assert.doesNotMatch(nota1.text, /Nombre heredado/, "Organization.legalName is never read");
    assert.ok(!accounts.memoria.warnings.some((w) => /no depositable/.test(w)));

    await prisma.legalEntity.update({ where: { id: LE }, data: { largeCompany: true } });
    try {
      const large = await buildAnnualAccounts({ context: directora, ...YEAR });
      assert.equal(large.format.depositable, false);
      assert.match(large.format.reason ?? "", /Formato Pymes no depositable para esta sociedad \(LSC arts\. 257-258\)/);
      for (const statement of [large.balance, large.pyg, large.ecpn, large.memoria]) {
        assert.ok(statement.warnings.includes(large.format.reason!), `${statement.kind} carries the not-depositable warning`);
        assert.equal(statement.format?.depositable, false);
      }
      assert.equal(large.balance.balanced, true, "generated anyway: aviso, no error");
      assert.match(large.memoria.notes.find((n) => n.number === 2)!.text, /ATENCIÓN: Formato Pymes no depositable/);
      const balance = await buildBalanceSheet({ context: directora, ...YEAR });
      assert.equal(balance.format?.depositable, false);
      assert.equal(balance.entity?.largeCompany, true);
    } finally {
      await prisma.legalEntity.update({ where: { id: LE }, data: { largeCompany: false } });
    }
  });
});

describe("C5 · USALI por hotel y roll-up con Oficina central, sin asignar y reparto informativo", () => {
  it("GOP por hotel; columna «Oficina central»; Total sociedad = Σ hoteles + Oficina + sin asignar; reparto por habitaciones = 100 % del coste, cero asientos nuevos", async () => {
    const entriesBefore = await prisma.journalEntry.count({ where: { organizationId: ORG } });
    const comparison = await compareUsaliProperties({ context: directora, ...MAY, includeCorporate: true, allocation: "rooms_available" });
    assert.deepEqual(comparison.properties.map((p) => [p.propertyCode, p.propertyKind, p.pnl.gop]), [["NO", "hotel", "70.00"], ["SU", "hotel", "160.00"]]);
    assert.equal(comparison.entity?.legalName, LEGAL_NAME);
    assert.ok(comparison.corporate);
    assert.deepEqual(comparison.corporate!.centres.map((c) => [c.code, c.kind, c.name]), [["OC", "office", "Oficina central L5"]]);
    assert.equal(comparison.corporate!.pnl.gop, "-90.00");
    assert.equal(comparison.corporate!.pnl.ratios.goppar, null, "per-room KPIs of the office are DegradedValue, never 0");
    assert.equal(comparison.unassigned?.propertyName, "Sociedad (sin centro)");
    assert.equal(comparison.unassigned?.netIncome, "-5.00");
    const gop = comparison.rollup!.find((r) => r.metric === "gop")!;
    assert.deepEqual([gop.hotels, gop.corporate, gop.unassigned, gop.total, gop.ok], ["230.00", "-90.00", "0.00", "140.00", true]);
    const net = comparison.rollup!.find((r) => r.metric === "netIncome")!;
    assert.deepEqual([net.hotels, net.corporate, net.unassigned, net.total, net.ok], ["230.00", "-90.00", "-5.00", "135.00", true]);
    assert.ok(comparison.rollup!.every((r) => r.ok));
    assert.equal(comparison.consolidated.gop, "140.00");

    const allocation = comparison.allocation!;
    assert.deepEqual([allocation.method, allocation.corporateCost, allocation.allocated, allocation.applied, allocation.posted, allocation.label], ["rooms_available", "90.00", "90.00", true, false, "Reparto corporativo (informativo · no contabilizado)"]);
    // 31 nights: NO 10 × 31 = 310 · SU 5 × 31 = 155 → 60,00 / 30,00.
    assert.deepEqual(allocation.shares.map((s) => [s.propertyId, s.basis, s.amount]), [[NO, "310.00", "60.00"], [SU, "155.00", "30.00"]]);
    assert.deepEqual(comparison.properties.map((p) => p.allocation), [{ allocated: "60.00", gopAfterAllocation: "10.00", ebitdaAfterAllocation: "10.00" }, { allocated: "30.00", gopAfterAllocation: "130.00", ebitdaAfterAllocation: "130.00" }]);
    assert.equal(await prisma.journalEntry.count({ where: { organizationId: ORG } }), entriesBefore, "cero asientos nuevos en el diario");

    // Without the flag the response is the pre-6b shape: every centre (office included) + consolidated.
    const legacy = await compareUsaliProperties({ context: directora, ...MAY });
    assert.deepEqual(legacy.properties.map((p) => p.propertyCode), ["NO", "SU", "OC"]);
    assert.equal(legacy.corporate, undefined);
    assert.equal(legacy.consolidated.gop, "140.00");
  });

  it("la clave de reparto se guarda en AccountingSetting.configurationJson (PUT/GET) y valida los porcentajes manuales", async () => {
    const before = await getCorporateAllocationView({ context: directora });
    assert.deepEqual([before.method, before.persisted, before.legalEntityId], ["none", false, LE]);
    assert.deepEqual(before.hotels.map((h) => h.code), ["NO", "SU"]);
    assert.deepEqual(before.corporateCentres.map((c) => c.code), ["OC"]);

    await expectError(putCorporateAllocation({ context: directora, body: { method: "manual", weights: [{ propertyId: NO, weight: 60 }, { propertyId: OC, weight: 40 }] }, correlationId: "l5-test" }), 400, "ALLOCATION_TARGET_NOT_HOTEL");
    await expectError(putCorporateAllocation({ context: directora, body: { method: "manual", weights: [{ propertyId: NO, weight: 60 }, { propertyId: SU, weight: 30 }] }, correlationId: "l5-test" }), 400, "ALLOCATION_WEIGHTS_SUM");
    await expectError(putCorporateAllocation({ context: directora, body: { method: "revenue", weights: [{ propertyId: NO, weight: 100 }] }, correlationId: "l5-test" }), 400, "ALLOCATION_WEIGHTS_NOT_ALLOWED");
    const saved = await putCorporateAllocation({ context: directora, body: { method: "manual", weights: [{ propertyId: NO, weight: 60 }, { propertyId: SU, weight: 40 }] }, correlationId: "l5-test" });
    assert.deepEqual([saved.method, saved.persisted, saved.weights], ["manual", true, [{ propertyId: NO, weight: 60 }, { propertyId: SU, weight: 40 }]]);
    const setting = await prisma.accountingSetting.findFirst({ where: { organizationId: ORG, propertyId: null }, select: { chartTemplate: true, configurationJson: true } });
    assert.equal(setting?.chartTemplate, "pgc_pymes_hotelero_v1", "the rest of the setting row is kept");
    assert.deepEqual((setting?.configurationJson as { corporateAllocation?: unknown }).corporateAllocation, { method: "manual", weights: [{ propertyId: NO, weight: 60 }, { propertyId: SU, weight: 40 }] });

    // The stored key applies when the request names none: 60/40 of 90 = 54/36.
    const stored = await compareUsaliProperties({ context: directora, ...MAY, includeCorporate: true });
    assert.equal(stored.allocation?.method, "manual");
    assert.deepEqual(stored.allocation?.shares.map((s) => [s.propertyId, s.amount]), [[NO, "54.00"], [SU, "36.00"]]);
    // `allocation=none` in the request disables it for that response.
    assert.equal((await compareUsaliProperties({ context: directora, ...MAY, includeCorporate: true, allocation: "none" })).allocation, null);
    await putCorporateAllocation({ context: directora, body: { method: "none" }, correlationId: "l5-test" });
  });

  it("PyG por centro (pnl/by-property): total sociedad = Σ centros + sin asignar en cada cuenta", async () => {
    const pnl = await buildPnlByProperty({ context: directora, ...MAY, allocation: "revenue" });
    assert.equal(pnl.entity.legalName, LEGAL_NAME);
    assert.deepEqual(pnl.properties.map((p) => [p.code, p.kind]), [["NO", "hotel"], ["SU", "hotel"], ["OC", "office"]]);
    const revenue = pnl.rows.find((r) => r.accountCode === "705.1")!;
    assert.deepEqual([revenue.byProperty[NO], revenue.byProperty[SU], revenue.byProperty[OC], revenue.unassigned, revenue.total], ["100.00", "200.00", "0.00", "0.00", "300.00"]);
    const interest = pnl.rows.find((r) => r.accountCode === "662")!;
    assert.deepEqual([interest.byProperty[NO], interest.unassigned, interest.total], ["0.00", "-5.00", "-5.00"]);
    assert.deepEqual(pnl.netResult, { byProperty: { [NO]: "70.00", [SU]: "160.00", [OC]: "-90.00" }, unassigned: "-5.00", total: "135.00" });
    assert.deepEqual(pnl.reconciliation, { ok: true, rowsOff: [] });
    // Revenue key 100:200 → the office's 90 splits 30/60; the office column is left at 0 after the allocation.
    assert.deepEqual(pnl.allocation?.shares.map((s) => [s.propertyId, s.amount]), [[NO, "30.00"], [SU, "60.00"]]);
    assert.deepEqual(pnl.allocation?.netResultAfterAllocation, { [NO]: "40.00", [SU]: "100.00", [OC]: "0.00" });
    assert.equal(pnl.allocation?.posted, false);
    assert.equal(pnl.allocation?.basis, "usali_corporate_gop");
  });

  it("t6b#16: USALI y PyG por centro reparten la MISMA base (−GOP de la oficina, 100,00), nunca su resultado neto (+150); con GOP positivo no hay reparto", async () => {
    // June 2027: asesoría 100 (623 → admin_general) + ingresos financieros 250 (762 → below EBITDA).
    const usali = await compareUsaliProperties({ context: directora, ...JUNE27, includeCorporate: true, allocation: "rooms_available" });
    assert.equal(usali.corporate!.pnl.gop, "-100.00");
    assert.equal(usali.corporate!.pnl.netIncome, "150.00");
    assert.deepEqual([usali.allocation!.corporateCost, usali.allocation!.allocated, usali.allocation!.applied, usali.allocation!.basis], ["100.00", "100.00", true, "usali_corporate_gop"]);
    // 30 nights: NO 10 × 30 = 300 · SU 5 × 30 = 150 → 66,67 / 33,33 (= 100,00).
    assert.deepEqual(usali.allocation!.shares.map((s) => [s.propertyId, s.basis, s.amount]), [[NO, "300.00", "66.67"], [SU, "150.00", "33.33"]]);
    assert.deepEqual(usali.allocation!.warnings, []);

    const pnl = await buildPnlByProperty({ context: directora, ...JUNE27, allocation: "rooms_available" });
    const financial = pnl.rows.find((r) => r.accountCode === "762")!;
    assert.deepEqual([financial.byProperty[OC], financial.byProperty[NO], financial.total], ["250.00", "0.00", "250.00"]);
    assert.deepEqual(pnl.netResult.byProperty, { [NO]: "0.00", [SU]: "0.00", [OC]: "150.00" });
    // Same base, same shares, same label as USALI — before the fix the PyG split −150 (the net result) as income.
    assert.deepEqual([pnl.allocation!.corporateCost, pnl.allocation!.allocated, pnl.allocation!.applied, pnl.allocation!.basis, pnl.allocation!.basisLabel], ["100.00", "100.00", true, usali.allocation!.basis, usali.allocation!.basisLabel]);
    assert.deepEqual(pnl.allocation!.shares, usali.allocation!.shares);
    // The hotels absorb the operating cost; the office keeps its financial income (150 + 100 = 250); Σ after = Σ before = 150.
    assert.deepEqual(pnl.allocation!.netResultAfterAllocation, { [NO]: "-66.67", [SU]: "-33.33", [OC]: "250.00" });
    assert.equal(Object.values(pnl.allocation!.netResultAfterAllocation).reduce((sum, v) => sum + Number(v), 0).toFixed(2), "150.00");
    assert.deepEqual(pnl.allocation!.warnings, []);
    assert.equal(pnl.allocation!.posted, false);

    // July 2027: the office bills 300 of central services (759, misc income) against 100 of asesoría → GOP +200: nothing to allocate, in both statements.
    const entriesBefore = await prisma.journalEntry.count({ where: { organizationId: ORG } });
    const julyUsali = await compareUsaliProperties({ context: directora, ...JULY27, includeCorporate: true, allocation: "rooms_available" });
    assert.equal(julyUsali.corporate!.pnl.gop, "200.00");
    assert.deepEqual([julyUsali.allocation!.applied, julyUsali.allocation!.corporateCost, julyUsali.allocation!.allocated, julyUsali.allocation!.shares], [false, "-200.00", "0.00", []]);
    assert.match(julyUsali.allocation!.warnings[0]!, /resultado operativo positivo en el periodo \(GOP 200\.00\): no hay coste que repartir/);
    for (const property of julyUsali.properties) assert.deepEqual(property.allocation, { allocated: "0.00", gopAfterAllocation: property.pnl.gop, ebitdaAfterAllocation: property.pnl.ebitda });
    const julyPnl = await buildPnlByProperty({ context: directora, ...JULY27, allocation: "rooms_available" });
    assert.deepEqual([julyPnl.allocation!.applied, julyPnl.allocation!.corporateCost, julyPnl.allocation!.shares], [false, "-200.00", []]);
    assert.match(julyPnl.allocation!.warnings[0]!, /resultado operativo positivo/);
    assert.deepEqual(julyPnl.allocation!.netResultAfterAllocation, julyPnl.netResult.byProperty);
    assert.equal(julyPnl.netResult.byProperty[OC], "200.00");
    assert.equal(await prisma.journalEntry.count({ where: { organizationId: ORG } }), entriesBefore, "cero asientos nuevos");
  });
});

describe("C7 · permisos por centro (accounting.entity.read)", () => {
  it("in-process: el director de SU solo lee con propertyId = SU (404 opaco sin propertyId o con NO); la directora ve la sociedad completa", async () => {
    const noScope = await expectError(buildFiscalModel("303", { period: "2026-Q2" }, directorSur), 404, "ENTITY_SCOPE_REQUIRED");
    assert.doesNotMatch(noScope.message, /prop_l5/, "the 404 never echoes a property id");
    await assert.rejects(buildFiscalModel("303", { period: "2026-Q2", propertyId: NO }, directorSur), (error: unknown) => (error as HttpErrorLike).statusCode === 404 && (error as Error).message === "Propiedad no encontrada.");
    const own = await buildFiscalModel("303", { period: "2026-Q2", propertyId: SU }, directorSur);
    assert.deepEqual([own.propertyId, casilla(own, "27")], [SU, 20]);
    assert.throws(() => assertFinanceReadScope(directorSur, null), /Ámbito no disponible/);
    assert.doesNotThrow(() => assertFinanceReadScope(directora, null));
    const whole = await buildFiscalModel("303", { period: "2026-Q2" }, directora);
    assert.equal(casilla(whole, "27"), 30);
  });

  it("HTTP (sesión REAL del director de SU): 404 sin propertyId y con NO; 200 solo con SU en modelos, diario, balance, USALI y PyG por centro", async (t) => {
    if (!app) return t.skip(`server unavailable: ${serverLoadError}`);
    if (!directorHeaders.authorization) return t.skip("director login unavailable (permission catalogue rows missing or /auth/login refused)");
    const me = await getJson<{ organizationId: string; activePropertyId: string; grantedPermissions: string[]; isPlatformAdmin: boolean }>("/users/me", directorHeaders);
    assert.equal(me.status, 200, me.text.slice(0, 200));
    assert.equal(me.body.organizationId, ORG);
    assert.equal(me.body.isPlatformAdmin, false);
    assert.ok(!me.body.grantedPermissions.includes("accounting.entity.read"), "the director never holds the entity key as a REAL grant");
    await withEnv(REAL_GRANTS_ENV, async () => {

    const whole = await getJson<ErrorBody>("/fiscal/models/303?period=2026-Q2", directorHeaders);
    assert.equal(whole.status, 404, whole.text.slice(0, 200));
    assert.equal(whole.body.details?.code, "ENTITY_SCOPE_REQUIRED");
    const sister = await getJson<ErrorBody>(`/fiscal/models/303?period=2026-Q2&propertyId=${NO}`, directorHeaders);
    assert.equal(sister.status, 404, sister.text.slice(0, 200));
    assert.equal(sister.body.message, "Propiedad no encontrada.");
    const own = await getJson<Report>(`/fiscal/models/303?period=2026-Q2&propertyId=${SU}`, directorHeaders);
    assert.equal(own.status, 200, own.text.slice(0, 200));
    assert.deepEqual([own.body.propertyId, casilla(own.body, "27"), own.body.sociedad.code], [SU, 20, "TST"]);

    for (const [url, ownUrl] of [
      ["/accounting/journal?from=2026-05-01&to=2026-05-31", `/accounting/journal?from=2026-05-01&to=2026-05-31&propertyId=${SU}`],
      ["/accounting/annual-accounts/balance?from=2026-01-01&to=2026-12-31", `/accounting/annual-accounts/balance?from=2026-01-01&to=2026-12-31&propertyId=${SU}`],
      ["/accounting/usali/compare?from=2026-05-01&to=2026-05-31", `/accounting/usali/compare?from=2026-05-01&to=2026-05-31&propertyIds=${SU}`],
      ["/fiscal/vat-books?book=emitidas&period=2026-Q2", `/fiscal/vat-books?book=emitidas&period=2026-Q2&propertyId=${SU}`]
    ]) {
      const denied = await getJson<ErrorBody>(url!, directorHeaders);
      assert.equal(denied.status, 404, `${url}: ${denied.text.slice(0, 200)}`);
      assert.equal(denied.body.details?.code, "ENTITY_SCOPE_REQUIRED", url);
      const allowed = await getJson<unknown>(ownUrl!, directorHeaders);
      assert.equal(allowed.status, 200, `${ownUrl}: ${allowed.text.slice(0, 200)}`);
    }
    const matrix = await getJson<ErrorBody>("/accounting/pnl/by-property?from=2026-05-01&to=2026-05-31", directorHeaders);
    assert.equal(matrix.status, 404, matrix.text.slice(0, 200));
    const settlement = await getJson<ErrorBody>("/fiscal/vat-settlement?period=2026-Q2", directorHeaders);
    assert.equal(settlement.status, 404, settlement.text.slice(0, 200));
    // Configuration without amounts stays readable for the director: the regime badge and the VAT settings.
    const settings = await getJson<{ sociedad: { code: string } }>("/fiscal/vat-settings", directorHeaders);
    assert.equal(settings.status, 200, settings.text.slice(0, 200));
    assert.equal(settings.body.sociedad.code, "TST");
    });
    // Back in dev/demo mode the union grants the entity key to the same session: the whole-sociedad model opens.
    const unioned = await getJson<Report>("/fiscal/models/303?period=2026-Q2", directorHeaders);
    assert.equal(unioned.status, 200, `demo union expected in dev mode: ${unioned.text.slice(0, 200)}`);
    assert.equal(casilla(unioned.body, "27"), 30);
  });

  it("HTTP (sesión demo, org_123, solo lectura): badge de la sociedad en modelos, régimen, PyG por centro, reparto y USALI comparado", async (t) => {
    if (!app) return t.skip(`server unavailable: ${serverLoadError}`);
    if (!demoHeaders.authorization) return t.skip("demo login unavailable");
    const m303 = await getJson<Report>("/fiscal/models/303?period=2026-Q3", demoHeaders);
    assert.equal(m303.status, 200, m303.text.slice(0, 200));
    assert.deepEqual([m303.body.sociedad.code, m303.body.sociedad.source, m303.body.declarante.nif, m303.body.declarante.nombre], ["HD", "legal_entity", "B12345674", "HotelOS Demo SL"]);
    const regime = await getJson<{ sociedad: { code: string }; propuesta: { regimen: string; cambia: boolean }; umbralGranEmpresa: number }>("/fiscal/regime?year=2026", demoHeaders);
    assert.equal(regime.status, 200, regime.text.slice(0, 200));
    assert.deepEqual([regime.body.sociedad.code, regime.body.propuesta.regimen, regime.body.propuesta.cambia, regime.body.umbralGranEmpresa], ["HD", "general", false, 6010121.04]);
    const badYear = await getJson<ErrorBody>("/fiscal/regime?year=26", demoHeaders);
    assert.equal(badYear.status, 400);
    const matrix = await getJson<{ kind: string; entity: { code: string }; properties: Array<{ code: string | null; kind: string }>; reconciliation: { ok: boolean } }>("/accounting/pnl/by-property?from=2026-07-01&to=2026-09-30", demoHeaders);
    assert.equal(matrix.status, 200, matrix.text.slice(0, 200));
    assert.deepEqual([matrix.body.kind, matrix.body.entity.code, matrix.body.reconciliation.ok], ["pnl_by_property", "HD", true]);
    assert.deepEqual(matrix.body.properties.map((p) => p.kind), ["hotel", "hotel"]);
    const allocation = await getJson<{ method: string; hotels: unknown[] }>("/accounting/allocation", demoHeaders);
    assert.equal(allocation.status, 200, allocation.text.slice(0, 200));
    assert.equal(allocation.body.hotels.length, 2);
    const compare = await getJson<{ properties: unknown[]; corporate: unknown; rollup: Array<{ ok: boolean }>; allocation: unknown }>("/accounting/usali/compare?from=2026-07-01&to=2026-09-30&includeCorporate=1", demoHeaders);
    assert.equal(compare.status, 200, compare.text.slice(0, 200));
    assert.equal(compare.body.corporate, null, "org_123 has no office: corporate column null");
    assert.ok(compare.body.rollup.every((r) => r.ok));
    const strict = await getJson<ErrorBody>("/accounting/usali/compare?from=2026-07-01&to=2026-09-30&allocation=banana", demoHeaders);
    assert.equal(strict.status, 400);
  });
});

describe("C7 · escrituras y artefactos de sociedad (fix:L5 t6b#4 · t6b#5)", () => {
  type Entry = { id: string; propertyId: string | null; status: string; entryNumber: number | null };

  it("HTTP t6b#5 (R4 + R11): el director de SU no contabiliza ni anula asientos de sociedad (sin centro) → 404 opaco; sí en SU (201); la directora sí (201, property_id NULL)", async (t) => {
    if (!app) return t.skip(`server unavailable: ${serverLoadError}`);
    if (!directorHeaders.authorization || !directoraHeaders.authorization) return t.skip("real logins unavailable (permission catalogue rows missing or /auth/login refused)");
    await withEnv(REAL_GRANTS_ENV, async () => {
      const societyBefore = await prisma.journalEntry.count({ where: { organizationId: ORG, propertyId: null } });
      const society = { entryDate: "2027-08-01", description: "Suministros de la sociedad", societyLevel: true, lines: [{ accountCode: "628", debit: "10.00" }, { accountCode: "572", credit: "10.00" }] };
      const denied = await postJson<ErrorBody>("/accounting/journal", directorHeaders, society);
      assert.equal(denied.status, 404, denied.text.slice(0, 200));
      assert.equal(denied.body.details?.code, "ENTITY_SCOPE_REQUIRED");
      assert.doesNotMatch(denied.body.message ?? "", /prop_l5/, "the 404 never echoes a property id");
      // Balance-sheet-only entry without propertyId is a society-level asiento too (R4 admits it without WORK_CENTER_REQUIRED, R11 scopes it).
      const balanceOnly = await postJson<ErrorBody>("/accounting/journal", directorHeaders, { entryDate: "2027-08-01", description: "Traspaso caja-banco de la sociedad", lines: [{ accountCode: "572", debit: "10.00" }, { accountCode: "570", credit: "10.00" }] });
      assert.equal(balanceOnly.status, 404, balanceOnly.text.slice(0, 200));
      assert.equal(balanceOnly.body.details?.code, "ENTITY_SCOPE_REQUIRED");
      // The sister centre stays «Propiedad no encontrada» (global tenant hook + write scope).
      const sister = await postJson<ErrorBody>("/accounting/journal", directorHeaders, { entryDate: "2027-08-01", description: "Suministros Norte", propertyId: NO, lines: society.lines });
      assert.equal(sister.status, 404, sister.text.slice(0, 200));
      assert.equal(sister.body.message, "Propiedad no encontrada.");
      assert.equal(await prisma.journalEntry.count({ where: { organizationId: ORG, propertyId: null } }), societyBefore, "no society-level asiento was written");

      // Own centre: the director posts in SU.
      const own = await postJson<Entry>("/accounting/journal", directorHeaders, { entryDate: "2027-08-01", description: "Suministros Sur", propertyId: SU, lines: society.lines });
      assert.equal(own.status, 201, own.text.slice(0, 300));
      assert.deepEqual([own.body.propertyId, own.body.status], [SU, "posted"]);

      // Reversing the society-level asiento (interest of the sociedad, no centre) is a write on the sociedad: opaque 404, the asiento stays posted.
      const interest = await prisma.journalEntry.findFirst({ where: { organizationId: ORG, propertyId: null, description: { contains: "Intereses bancarios" } }, select: { id: true, status: true } });
      assert.ok(interest, "fixture society-level asiento present");
      const reverseDenied = await postJson<ErrorBody>(`/accounting/journal/${interest!.id}/reverse`, directorHeaders, { reason: "Prueba de ámbito (no debe anular)" });
      assert.equal(reverseDenied.status, 404, reverseDenied.text.slice(0, 200));
      assert.equal(reverseDenied.body.details?.code, "ENTITY_SCOPE_REQUIRED");
      assert.equal((await prisma.journalEntry.findUnique({ where: { id: interest!.id }, select: { status: true } }))?.status, "posted");

      // The directora (REAL accounting.entity.read) posts the same society-level asiento: 201 with property_id NULL.
      const posted = await postJson<Entry>("/accounting/journal", directoraHeaders, society);
      assert.equal(posted.status, 201, posted.text.slice(0, 300));
      assert.deepEqual([posted.body.propertyId, posted.body.status], [null, "posted"]);
      assert.equal((await prisma.journalEntry.findUnique({ where: { id: posted.body.id }, select: { propertyId: true } }))?.propertyId, null);
      assert.equal(await prisma.journalEntry.count({ where: { organizationId: ORG, propertyId: null } }), societyBefore + 1);
    });
  });

  it("HTTP t6b#4 (R11): las exportaciones a gestoría son artefactos de la sociedad: el director de SU no las lista, consulta, descarga ni genera (404 opaco); la directora sí y el CSV lleva el diario completo", async (t) => {
    if (!app) return t.skip(`server unavailable: ${serverLoadError}`);
    if (!directorHeaders.authorization || !directoraHeaders.authorization) return t.skip("real logins unavailable (permission catalogue rows missing or /auth/login refused)");
    await withEnv(REAL_GRANTS_ENV, async () => {
      const created = await postJson<{ id: string; rowCount: number }>("/accounting/gestoria-exports", directoraHeaders, { format: "csv_universal", from: MAY.from, to: MAY.to });
      assert.equal(created.status, 201, created.text.slice(0, 300));
      assert.ok(created.body.rowCount >= 14, `whole-sociedad diario of May (${created.body.rowCount} rows)`);
      const id = created.body.id;

      const list = await getJson<ErrorBody>("/accounting/gestoria-exports", directorHeaders);
      assert.equal(list.status, 404, list.text.slice(0, 200));
      assert.equal(list.body.details?.code, "ENTITY_SCOPE_REQUIRED");
      const one = await getJson<ErrorBody>(`/accounting/gestoria-exports/${id}`, directorHeaders);
      assert.equal(one.status, 404, one.text.slice(0, 200));
      assert.equal(one.body.details?.code, "ENTITY_SCOPE_REQUIRED");
      const download = await getJson<ErrorBody>(`/accounting/gestoria-exports/${id}/download`, directorHeaders);
      assert.equal(download.status, 404, download.text.slice(0, 200));
      assert.equal(download.body.details?.code, "ENTITY_SCOPE_REQUIRED");
      assert.doesNotMatch(download.text, /Factura FAC-NO|Asesoría/, "no CSV content leaks in the 404");
      // A per-centre export of his own hotel is refused too: the stored row would carry no centre.
      const ownCentre = await postJson<ErrorBody>("/accounting/gestoria-exports", directorHeaders, { format: "csv_universal", from: MAY.from, to: MAY.to, propertyId: SU });
      assert.equal(ownCentre.status, 404, ownCentre.text.slice(0, 200));
      assert.equal(ownCentre.body.details?.code, "ENTITY_SCOPE_REQUIRED");
      // Validation still comes before the scope (integrador-fixes t6#10 keeps its 400 for an empty body).
      const invalid = await postJson<ErrorBody>("/accounting/gestoria-exports", directorHeaders, {});
      assert.equal(invalid.status, 400, invalid.text.slice(0, 200));
      assert.equal(await prisma.gestoriaExport.count({ where: { organizationId: ORG } }), 1, "only the directora's export exists");
      // The formats catalogue has no amounts: still readable by the director.
      assert.equal((await getJson<unknown>("/accounting/gestoria-exports/formats", directorHeaders)).status, 200);

      const okList = await getJson<Array<{ id: string }>>("/accounting/gestoria-exports", directoraHeaders);
      assert.equal(okList.status, 200, okList.text.slice(0, 200));
      assert.ok(okList.body.some((row) => row.id === id));
      const okDownload = await app!.inject({ method: "GET", url: `/accounting/gestoria-exports/${id}/download`, headers: directoraHeaders });
      assert.equal(okDownload.statusCode, 200, okDownload.body.slice(0, 200));
      assert.match(okDownload.body, /Factura FAC-NO \[structure-l5\]/, "the CSV carries the rows of NO (whole sociedad)");
      assert.match(okDownload.body, /Asesoría oficina central \[structure-l5\]/);
    });
  });
});

describe("C9 · equivalencia (solo lectura): Faranda y org_123 tras L1-L5", () => {
  it("el 303 de Faranda 2026-Q3 conserva 27 = 71 = 74,94 (runbook §14/§16), 37 registros, y el declarante es la sociedad CEL · A33615980 (tras la migración a CELUISMA, §17.13)", async () => {
    const report = await buildModelo303({ context: farandaCtx, period: "2026-Q3" });
    assert.deepEqual(report.declarante, { nif: "A33615980", nombre: "CELUISMA S.A." });
    assert.deepEqual([report.sociedad.code, report.sociedad.source, report.sociedad.regimen.periodicity], ["CEL", "legal_entity", "quarterly"]);
    assert.deepEqual([casilla(report, "27"), casilla(report, "45"), casilla(report, "71"), report.fuentes.registros, report.fuentes.origen], [74.94, 0, 74.94, 37, "documentos"]);
    const m390 = await buildModelo390({ context: farandaCtx, year: 2026 });
    assert.deepEqual([m390.totales.volumenOperaciones, m390.totales.resultadoLiquidaciones, m390.presentacion.noSePresenta], [805.76, 74.94, undefined]);
    assert.deepEqual(await farandaCounts(), farandaBefore, "nothing written to Faranda");
  });

  /**
   * org_123 is a legitimate write target of the sister suites (payables-assets posts
   * supplier bills and expenses dated 2026-09-15, billing-money and pos-cash-night
   * issue invoices) that run in parallel under `node --test` and clean up after
   * themselves; the 303 figures of 2026-Q3 are therefore only comparable when the
   * database is at rest (observed mid-run: casilla 71 = −228,27 with a sibling's
   * deductible VAT open). The structural facts (declarante, sociedad) hold always;
   * the numeric equivalence is asserted when the document counts before AND after
   * the computation match the quiet demo dataset, and skipped with a diagnostic
   * otherwise (run the file alone for the strict check).
   */
  it("el 303 de org_123 2026-Q3 conserva 27 = 71 = 86,73 (12 registros) y el declarante es la sociedad HD · B12345674 — cifras solo con la BD en reposo", async (t) => {
    const ORG123_PROPERTIES = ["prop_123", "prop_canary"];
    const QUIET = { invoices: 8, supplierBills: 1, expenses: 1, vatBookEntries: 0 };
    const counts = async () => ({
      invoices: await prisma.invoice.count({ where: { propertyId: { in: ORG123_PROPERTIES } } }),
      supplierBills: await prisma.supplierBill.count({ where: { propertyId: { in: ORG123_PROPERTIES } } }),
      expenses: await prisma.expense.count({ where: { propertyId: { in: ORG123_PROPERTIES } } }),
      vatBookEntries: await prisma.vatBookEntry.count({ where: { organizationId: "org_123" } })
    });
    const before = await counts();
    const m303org123 = await buildModelo303({ context: org123Ctx, period: "2026-Q3" });
    const after = await counts();
    assert.deepEqual(m303org123.declarante, { nif: "B12345674", nombre: "HotelOS Demo SL" });
    assert.deepEqual([m303org123.sociedad.code, m303org123.sociedad.source], ["HD", "legal_entity"]);
    if (JSON.stringify(before) !== JSON.stringify(QUIET) || JSON.stringify(after) !== JSON.stringify(QUIET)) {
      t.skip(`org_123 no está en reposo (antes ${JSON.stringify(before)} · después ${JSON.stringify(after)} · reposo ${JSON.stringify(QUIET)}): la equivalencia numérica se comprueba ejecutando el fichero solo`);
      return;
    }
    assert.deepEqual([casilla(m303org123, "27"), casilla(m303org123, "71"), m303org123.fuentes.registros, m303org123.fuentes.origen], [86.73, 86.73, 12, "documentos"]);
  });
});
