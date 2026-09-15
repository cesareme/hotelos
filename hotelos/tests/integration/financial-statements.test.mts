/**
 * Finanzas · estados financieros (lote usali-cuentas) · integration
 * (REAL HTTP via app.inject + in-process services, Postgres required).
 *
 * Part A — HTTP on the demo organisation (org_123 / prop_123, the only
 * property the demo login is assigned to): USALI mapping editor (list,
 * PATCH, 400 USALI_LINE_NOT_ADMITTED, 400 VALIDATION_ERROR on a balance
 * code, DELETE), the USALI statement over a fixture window nobody else
 * uses (2031-02, five known entries + one checked-out reservation), the
 * pdf/xlsx/csv downloads, the property and period comparisons, the annual
 * accounts (balance cuadra, PyG = resultado del balance, coherence), a
 * persisted snapshot with its download, the gestoría exports (csv universal
 * with the literal rows, contaplus flagged validateWithAdvisor, a3 → 409
 * EXPORT_FORMAT_NOT_IMPLEMENTED, download) and the 401 of a high-risk write
 * without a session.
 *
 * Part B — services with an ISOLATED test organisation created and deleted
 * by the suite (chart provisioned with provisionOrganizationChart, its own
 * property, rooms and stays): the reference ledger of the unit tests goes
 * through Prisma + the SQL reader and must give the same figures (activo
 * 60.184,80 = PN 58.098,00 + pasivo 2.086,80; resultado −1.902,00; USALI
 * neto −1.895,00 con 7,00 sin asignar), also after the year is closed with
 * regularization + closing + opening entries (balance_at excludes the
 * closing dated at the cut-off).
 *
 * Everything the suite writes is removed in `after` (journal lines/entries,
 * reservation, mapping rows, snapshots, exports of org_123; the whole test
 * organisation of part B). Faranda is never touched.
 *
 * Run from the repo root:
 *   cd apps/api && node --import tsx --test "../../tests/integration/financial-statements.test.mts"
 *
 * Mounting: until the integrator wires `registerFinancialStatementsRoutes(app)`
 * in server.ts the suite mounts the routes under a test prefix (manifest
 * entries pushed for the RBAC hook), exactly like rate-grid-v2.test.mts.
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
const { routePermissionManifest } = await import("../../apps/api/src/security/route-permissions.js");
const { registerFinancialStatementsRoutes } = await import("../../apps/api/src/modules/financial-statements/financial-statements.routes.js");
const { FINANCIAL_STATEMENTS_ROUTE_PERMISSIONS } = await import("../../apps/api/src/modules/financial-statements/route-permissions.partial.js");
const { buildAnnualAccounts } = await import("../../apps/api/src/modules/financial-statements/annual-accounts.service.js");
const { buildUsaliPnl } = await import("../../apps/api/src/modules/financial-statements/usali.service.js");
const { provisionOrganizationChart } = await import("../../apps/api/src/modules/accounting/chart-of-accounts.service.js");
const { prisma } = await import("@hotelos/database");

type ApiApp = Awaited<ReturnType<typeof buildApiServer>>;
type Headers = Record<string, string>;
type Line = { code: string; debit?: string; credit?: string; taxRateCode?: string; taxBase?: string };
type EntrySpec = { date: string; kind?: string; sourceType?: string; sourceId?: string; description: string; number: number | null; lines: Line[] };

const ORG = "org_123";
const PROPERTY = "prop_123";
const FROM = "2031-02-01";
const TO = "2031-02-28";
const MARK = "[financial-statements test]";
const RUN = Date.now().toString(36);

const dayUtc = (iso: string): Date => new Date(`${iso}T00:00:00Z`);

async function loginDemo(app: ApiApp): Promise<{ token: string } | null> {
  const res = await app.inject({
    method: "POST",
    url: "/auth/login",
    payload: { email: process.env.INTEGRATION_LOGIN_EMAIL ?? "reception@example.com", password: process.env.INTEGRATION_LOGIN_PASSWORD ?? "hotelos-demo", deviceId: "integration-tests-financial-statements" }
  });
  return res.statusCode === 200 ? { token: (JSON.parse(res.body) as { token: string }).token } : null;
}

/** Posts a balanced entry straight into the ledger (fixture; the ledger service of the asientos lote is not this suite's subject). */
async function postEntry(organizationId: string, propertyId: string, spec: EntrySpec): Promise<string> {
  const codes = Array.from(new Set(spec.lines.map((l) => l.code)));
  const accounts = await prisma.account.findMany({ where: { organizationId, code: { in: codes } }, select: { id: true, code: true } });
  const idByCode = new Map(accounts.map((a) => [a.code, a.id]));
  for (const code of codes) assert.ok(idByCode.has(code), `account ${code} missing in ${organizationId}`);
  const entry = await prisma.journalEntry.create({
    data: {
      organizationId,
      propertyId,
      sourceType: spec.sourceType ?? "manual",
      sourceId: spec.sourceId ?? `fs-test:${RUN}:${spec.date}:${spec.description}`,
      status: "posted",
      postedAt: dayUtc(spec.date),
      entryDate: dayUtc(spec.date),
      entryKind: spec.kind ?? "normal",
      fiscalYearCode: spec.date.slice(0, 4),
      entryNumber: spec.number,
      description: `${spec.description} ${MARK}`
    }
  });
  await prisma.journalLine.createMany({
    data: spec.lines.map((line) => ({
      journalEntryId: entry.id,
      accountId: idByCode.get(line.code)!,
      accountCode: line.code,
      debit: line.debit ?? "0",
      credit: line.credit ?? "0",
      currency: "EUR",
      taxRateCode: line.taxRateCode ?? null,
      taxBase: line.taxBase ?? null
    }))
  });
  return entry.id;
}

async function deleteEntries(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await prisma.journalLine.deleteMany({ where: { journalEntryId: { in: ids } } });
  await prisma.journalEntry.deleteMany({ where: { id: { in: ids } } });
}

/** Five known entries in prop_123 for February 2031 (org_123 chart already provisioned). */
function demoFixtureEntries(base: number): EntrySpec[] {
  return [
    { date: "2031-02-03", sourceType: "invoice", description: "Factura alojamiento", number: base + 1, lines: [{ code: "4300", debit: "121.00" }, { code: "705.1", credit: "100.00", taxRateCode: "21" }, { code: "477.21", credit: "21.00", taxRateCode: "21", taxBase: "100.00" }] },
    { date: "2031-02-04", sourceType: "invoice", description: "Factura restauración", number: base + 2, lines: [{ code: "4300", debit: "55.00" }, { code: "705.2", credit: "50.00", taxRateCode: "10" }, { code: "477.10", credit: "5.00", taxRateCode: "10", taxBase: "50.00" }] },
    { date: "2031-02-05", sourceType: "payment", description: "Cobro en efectivo", number: base + 3, lines: [{ code: "570", debit: "176.00" }, { code: "4300", credit: "176.00" }] },
    { date: "2031-02-10", description: "Alquiler", number: base + 4, lines: [{ code: "621", debit: "500.00" }, { code: "410", credit: "500.00" }] },
    // Unnumbered on purpose: a legacy writer left it «pendiente de numerar» → the CSV exports it as P-<id>.
    { date: "2031-02-15", sourceType: "payroll_slip", description: "Nómina febrero", number: null, lines: [{ code: "640.1", debit: "1000.00" }, { code: "642.1", debit: "300.00" }, { code: "476", credit: "400.00" }, { code: "4751", credit: "150.00" }, { code: "465", credit: "750.00" }] }
  ];
}

/** The reference ledger of the unit tests, for the isolated organisation of part B. */
function referenceEntries(): EntrySpec[] {
  return [
    { date: "2027-01-02", description: "Aportación de capital", number: 1, lines: [{ code: "572", debit: "60000.00" }, { code: "100", credit: "60000.00" }] },
    { date: "2027-01-05", description: "Compra de mobiliario", number: 2, lines: [{ code: "216", debit: "12000.00" }, { code: "572", credit: "12000.00" }] },
    { date: "2027-03-10", sourceType: "invoice", description: "Factura alojamiento", number: 3, lines: [{ code: "4300", debit: "121.00" }, { code: "705.1", credit: "100.00" }, { code: "477.21", credit: "21.00", taxRateCode: "21", taxBase: "100.00" }] },
    { date: "2027-03-11", sourceType: "invoice", description: "Factura restauración", number: 4, lines: [{ code: "4300", debit: "55.00" }, { code: "705.2", credit: "50.00" }, { code: "477.10", credit: "5.00", taxRateCode: "10", taxBase: "50.00" }] },
    { date: "2027-03-12", sourceType: "payment", description: "Cobro en efectivo", number: 5, lines: [{ code: "570", debit: "176.00" }, { code: "4300", credit: "176.00" }] },
    { date: "2027-03-15", sourceType: "supplier_bill", description: "Factura proveedor alimentos", number: 6, lines: [{ code: "601.1", debit: "40.00" }, { code: "472.10", debit: "4.00", taxRateCode: "10", taxBase: "40.00" }, { code: "400", credit: "44.00" }] },
    { date: "2027-03-31", sourceType: "payroll_slip", description: "Nómina marzo", number: 7, lines: [{ code: "640.1", debit: "1000.00" }, { code: "642.1", debit: "300.00" }, { code: "476", credit: "400.00" }, { code: "4751", credit: "150.00" }, { code: "465", credit: "750.00" }] },
    { date: "2027-03-31", description: "Alquiler", number: 8, lines: [{ code: "621", debit: "500.00" }, { code: "472.21", debit: "105.00", taxRateCode: "21", taxBase: "500.00" }, { code: "410", credit: "605.00" }] },
    { date: "2027-03-31", description: "Electricidad", number: 9, lines: [{ code: "628.1", debit: "80.00" }, { code: "472.21", debit: "16.80", taxRateCode: "21", taxBase: "80.00" }, { code: "410", credit: "96.80" }] },
    { date: "2027-03-31", sourceType: "commission", description: "Comisión canal", number: 10, lines: [{ code: "629.1", debit: "15.00" }, { code: "410", credit: "15.00" }] },
    { date: "2027-03-31", sourceType: "depreciation", description: "Amortización marzo", number: 11, lines: [{ code: "681", debit: "100.00" }, { code: "2816", credit: "100.00" }] },
    { date: "2027-03-31", description: "Intereses", number: 12, lines: [{ code: "662", debit: "10.00" }, { code: "572", credit: "10.00" }] },
    { date: "2027-03-31", description: "Retribución en especie", number: 13, lines: [{ code: "645", debit: "7.00" }, { code: "572", credit: "7.00" }] }
  ];
}

function closingEntries(): EntrySpec[] {
  const closing: Line[] = [
    { code: "100", debit: "60000.00" },
    { code: "2816", debit: "100.00" },
    { code: "400", debit: "44.00" },
    { code: "410", debit: "716.80" },
    { code: "476", debit: "400.00" },
    { code: "4751", debit: "150.00" },
    { code: "465", debit: "750.00" },
    { code: "477.21", debit: "21.00" },
    { code: "477.10", debit: "5.00" },
    { code: "216", credit: "12000.00" },
    { code: "472.10", credit: "4.00" },
    { code: "472.21", credit: "121.80" },
    { code: "570", credit: "176.00" },
    { code: "572", credit: "47983.00" },
    { code: "129", credit: "1902.00" }
  ];
  return [
    {
      date: "2027-12-31",
      kind: "regularization",
      sourceType: "regularization",
      description: "Regularización 2027",
      number: 14,
      lines: [
        { code: "705.1", debit: "100.00" },
        { code: "705.2", debit: "50.00" },
        { code: "129", debit: "1902.00" },
        { code: "601.1", credit: "40.00" },
        { code: "640.1", credit: "1000.00" },
        { code: "642.1", credit: "300.00" },
        { code: "621", credit: "500.00" },
        { code: "628.1", credit: "80.00" },
        { code: "629.1", credit: "15.00" },
        { code: "681", credit: "100.00" },
        { code: "662", credit: "10.00" },
        { code: "645", credit: "7.00" }
      ]
    },
    { date: "2027-12-31", kind: "closing", sourceType: "closing", description: "Cierre 2027", number: 15, lines: closing },
    { date: "2028-01-01", kind: "opening", sourceType: "opening", description: "Apertura 2028", number: 16, lines: closing.map((l) => ({ code: l.code, debit: l.credit, credit: l.debit })) }
  ];
}

type ErrorBody = { statusCode: number; message: string; details?: { code?: string } };
type Pnl = {
  totalOperatingRevenue: string;
  totalDepartmentalProfit: string;
  totalUndistributed: string;
  gop: string;
  ebitda: string;
  netIncome: string;
  nonOperating: { rent: string; total: string };
  operatingDepartments: Array<{ department: string; revenue: string; labor: string; departmentalProfit: string }>;
  unassigned: { net: string };
  reconciliation: { pgcResult: string; ok: boolean };
  statistics: { nights: number; roomsInventory: number; roomsAvailable: number; roomsOccupied: number; occupancyPct: string | null };
  ratios: { revpar: string | null; adr: string | null; goppar: string | null };
};

describe("financial statements (app.inject, org_123 + isolated organisation)", () => {
  let app: ApiApp;
  let prefix = "";
  let headers: Headers = {};
  const url = (path: string): string => `${prefix}${path}`;
  const demoEntryIds: string[] = [];
  let reservationId: string | null = null;
  let roomsInventory = 0;
  let occupiedBaseline = 0;
  const snapshotIds: string[] = [];
  const exportIds: string[] = [];
  const mappingPrefixes = ["699.9", "698.8"];
  // Part B
  const testOrgId = `fs_test_org_${RUN}`;
  const testPropertyId = `fs_test_prop_${RUN}`;
  let testRoomTypeId = "";
  const testEntryIds: string[] = [];

  async function get(path: string, extraHeaders: Headers = {}) {
    return app.inject({ method: "GET", url: url(path), headers: { ...headers, ...extraHeaders } });
  }

  before(async () => {
    app = await buildApiServer();
    if (!app.hasRoute({ method: "GET", url: "/accounting/usali/pnl" })) {
      prefix = "/__financial-statements";
      routePermissionManifest.push(...FINANCIAL_STATEMENTS_ROUTE_PERMISSIONS.map((entry) => ({ ...entry, path: `${prefix}${entry.path}` })));
      await app.register(async (sub) => registerFinancialStatementsRoutes(sub), { prefix });
    }
    await app.ready();
    const session = await loginDemo(app);
    headers = session ? { authorization: `Bearer ${session.token}` } : {};

    // Part A fixtures (org_123 / prop_123, February 2031): numbers far above anything the ledger holds.
    const maxNumber = await prisma.journalEntry.aggregate({ where: { organizationId: ORG, fiscalYearCode: "2031" }, _max: { entryNumber: true } });
    const base = Math.max(900000, (maxNumber._max.entryNumber ?? 0) + 1000);
    for (const spec of demoFixtureEntries(base)) demoEntryIds.push(await postEntry(ORG, PROPERTY, spec));
    roomsInventory = await prisma.room.count({ where: { propertyId: PROPERTY, active: true } });
    const existing = await prisma.reservation.findMany({
      where: { propertyId: PROPERTY, status: { in: ["checked_in", "checked_out"] }, arrivalDate: { lt: dayUtc("2031-03-01") }, departureDate: { gt: dayUtc(FROM) } },
      select: { arrivalDate: true, departureDate: true, roomsCount: true }
    });
    occupiedBaseline = existing.reduce((sum, r) => {
      const start = Math.max(r.arrivalDate.getTime(), dayUtc(FROM).getTime());
      const end = Math.min(r.departureDate.getTime(), dayUtc("2031-03-01").getTime());
      return sum + Math.max(0, Math.round((end - start) / 86_400_000)) * Math.max(1, r.roomsCount ?? 1);
    }, 0);
    const reservation = await prisma.reservation.create({
      data: { propertyId: PROPERTY, code: `FS-TEST-${RUN}`, channel: "direct", status: "checked_out", arrivalDate: dayUtc("2031-02-10"), departureDate: dayUtc("2031-02-13"), roomsCount: 1, notes: MARK }
    });
    reservationId = reservation.id;

    // Part B: isolated organisation with the reference ledger.
    await prisma.organization.create({ data: { id: testOrgId, name: `Test Org ${RUN}`, legalName: `Test Org ${RUN} SL`, taxId: "B12345674" } });
    await prisma.property.create({ data: { id: testPropertyId, organizationId: testOrgId, name: "Hotel Test", address: "Calle Real 1", municipality: "A Coruña", province: "A Coruña" } });
    await provisionOrganizationChart(testOrgId);
    await prisma.account.create({ data: { organizationId: testOrgId, code: "645", name: "Retribuciones en especie", accountType: "expense", kind: "expense", group: 6, level: 3, isPostable: true } });
    const roomType = await prisma.roomType.create({ data: { propertyId: testPropertyId, name: "Doble", code: "DBL", maxOccupancy: 2, baseCapacity: 2 } });
    testRoomTypeId = roomType.id;
    for (let i = 1; i <= 10; i++) await prisma.room.create({ data: { propertyId: testPropertyId, roomTypeId: roomType.id, number: `T${i}` } });
    // 45 room-nights of real stays in Q1 2027: 15 reservations × 3 nights.
    for (let i = 0; i < 15; i++) {
      await prisma.reservation.create({
        data: { propertyId: testPropertyId, code: `FS-B-${RUN}-${i}`, channel: "direct", status: i % 2 ? "checked_out" : "checked_in", arrivalDate: dayUtc("2027-02-01"), departureDate: dayUtc("2027-02-04"), roomsCount: 1 }
      });
    }
    for (const spec of referenceEntries()) testEntryIds.push(await postEntry(testOrgId, testPropertyId, spec));
  });

  after(async () => {
    await deleteEntries(demoEntryIds);
    if (reservationId) await prisma.reservation.deleteMany({ where: { id: reservationId } });
    await prisma.usaliMapping.deleteMany({ where: { organizationId: ORG, accountPrefix: { in: mappingPrefixes } } });
    if (snapshotIds.length) await prisma.financialStatementSnapshot.deleteMany({ where: { id: { in: snapshotIds } } });
    await prisma.financialStatementSnapshot.deleteMany({ where: { organizationId: ORG, label: MARK } });
    if (exportIds.length) await prisma.gestoriaExport.deleteMany({ where: { id: { in: exportIds } } });
    // Part B teardown (reverse order; the organisation has no cascading relations).
    await deleteEntries(testEntryIds);
    await prisma.journalLine.deleteMany({ where: { journalEntryId: { in: (await prisma.journalEntry.findMany({ where: { organizationId: testOrgId }, select: { id: true } })).map((e) => e.id) } } });
    await prisma.journalEntry.deleteMany({ where: { organizationId: testOrgId } });
    await prisma.reservation.deleteMany({ where: { propertyId: testPropertyId } });
    await prisma.room.deleteMany({ where: { propertyId: testPropertyId } });
    if (testRoomTypeId) await prisma.roomType.deleteMany({ where: { id: testRoomTypeId } });
    await prisma.financialStatementSnapshot.deleteMany({ where: { organizationId: testOrgId } });
    await prisma.gestoriaExport.deleteMany({ where: { organizationId: testOrgId } });
    await prisma.usaliMapping.deleteMany({ where: { organizationId: testOrgId } });
    await prisma.accountingSetting.deleteMany({ where: { organizationId: testOrgId } });
    await prisma.account.deleteMany({ where: { organizationId: testOrgId } });
    await prisma.property.deleteMany({ where: { id: testPropertyId } });
    await prisma.organization.deleteMany({ where: { id: testOrgId } });
    await app.close();
  });

  // ---- Part A · HTTP -------------------------------------------------------

  it("GET /accounting/usali/mappings lists the vocabulary and the coverage of the org chart", async () => {
    const res = await get("/accounting/usali/mappings");
    assert.equal(res.statusCode, 200, res.body);
    const body = JSON.parse(res.body) as { departments: unknown[]; lines: unknown[]; coverage: { totalAccounts: number; mapped: number; bySource: Record<string, number> } };
    assert.equal(body.departments.length, 12);
    assert.equal(body.lines.length, 12);
    // org_123 = template P&L accounts (82 postable in groups 6-7) plus the seed's legacy codes.
    assert.ok(body.coverage.totalAccounts >= 80, `only ${body.coverage.totalAccounts} P&L accounts`);
    assert.ok(body.coverage.mapped >= body.coverage.totalAccounts - 12, JSON.stringify(body.coverage.bySource));
  });

  it("PATCH /accounting/usali/mappings upserts, validates the admitted combinations and rejects balance codes; DELETE removes", async () => {
    const ok = await app.inject({
      method: "PATCH",
      url: url("/accounting/usali/mappings"),
      headers,
      payload: { mappings: [{ accountPrefix: mappingPrefixes[0], usaliDepartment: "sales_marketing", usaliLine: "other_expense", priority: 5 }, { accountPrefix: mappingPrefixes[1], usaliDepartment: "it", usaliLine: "labor" }] }
    });
    assert.equal(ok.statusCode, 200, ok.body);
    const body = JSON.parse(ok.body) as { mappings: Array<{ id: string; accountPrefix: string; priority: number; active: boolean }> };
    const created = body.mappings.find((m) => m.accountPrefix === mappingPrefixes[0]);
    assert.ok(created);
    assert.equal(created.priority, 5);
    // Idempotent second PATCH updates in place (unique per org + prefix).
    const again = await app.inject({ method: "PATCH", url: url("/accounting/usali/mappings"), headers, payload: { mappings: [{ accountPrefix: mappingPrefixes[0], usaliDepartment: "pom", usaliLine: "other_expense", active: false }] } });
    assert.equal(again.statusCode, 200, again.body);
    const updated = (JSON.parse(again.body) as typeof body).mappings.filter((m) => m.accountPrefix === mappingPrefixes[0]);
    assert.equal(updated.length, 1);
    assert.equal(updated[0]!.active, false);

    const notAdmitted = await app.inject({ method: "PATCH", url: url("/accounting/usali/mappings"), headers, payload: { mappings: [{ accountPrefix: "705.1", usaliDepartment: "rooms", usaliLine: "cost_of_sales" }] } });
    assert.equal(notAdmitted.statusCode, 400, notAdmitted.body);
    assert.equal((JSON.parse(notAdmitted.body) as ErrorBody).details?.code, "USALI_LINE_NOT_ADMITTED");

    const balanceCode = await app.inject({ method: "PATCH", url: url("/accounting/usali/mappings"), headers, payload: { mappings: [{ accountPrefix: "430", usaliDepartment: "rooms", usaliLine: "revenue" }] } });
    assert.equal(balanceCode.statusCode, 400, balanceCode.body);
    assert.equal((JSON.parse(balanceCode.body) as ErrorBody).details?.code, "VALIDATION_ERROR");

    const unknownKey = await app.inject({ method: "PATCH", url: url("/accounting/usali/mappings"), headers, payload: { mappings: [{ accountPrefix: "62", usaliDepartment: "rooms", usaliLine: "revenue", foo: 1 }] } });
    assert.equal(unknownKey.statusCode, 400);

    const removed = await app.inject({ method: "DELETE", url: url(`/accounting/usali/mappings/${created.id}`), headers });
    assert.equal(removed.statusCode, 200, removed.body);
    assert.equal((JSON.parse(removed.body) as typeof body).mappings.some((m) => m.id === created.id), false);
    const missing = await app.inject({ method: "DELETE", url: url(`/accounting/usali/mappings/${created.id}`), headers });
    assert.equal(missing.statusCode, 404);
  });

  it("GET /accounting/usali/pnl over the fixture window: departments, GOP, reconciliation and PMS ratios", async () => {
    const res = await get(`/accounting/usali/pnl?propertyId=${PROPERTY}&from=${FROM}&to=${TO}`);
    assert.equal(res.statusCode, 200, res.body);
    const pnl = JSON.parse(res.body) as Pnl;
    const rooms = pnl.operatingDepartments.find((d) => d.department === "rooms")!;
    assert.equal(rooms.revenue, "100.00");
    assert.equal(rooms.labor, "1300.00");
    assert.equal(rooms.departmentalProfit, "-1200.00");
    assert.equal(pnl.operatingDepartments.find((d) => d.department === "fnb")!.revenue, "50.00");
    assert.equal(pnl.totalOperatingRevenue, "150.00");
    assert.equal(pnl.totalDepartmentalProfit, "-1150.00");
    assert.equal(pnl.totalUndistributed, "0.00");
    assert.equal(pnl.gop, "-1150.00");
    assert.equal(pnl.nonOperating.rent, "500.00");
    assert.equal(pnl.ebitda, "-1650.00");
    assert.equal(pnl.netIncome, "-1650.00");
    assert.equal(pnl.unassigned.net, "0.00");
    assert.equal(pnl.reconciliation.pgcResult, "-1650.00");
    assert.equal(pnl.reconciliation.ok, true);
    // Other suites run in parallel and may add rooms or stays to prop_123 between the `before` snapshot and this
    // request, so the PMS figures are checked for internal consistency against the response's own statistics
    // (the baseline counts are a lower bound, never an exact expectation).
    const stats = pnl.statistics;
    assert.equal(stats.nights, 28);
    assert.ok(stats.roomsInventory >= roomsInventory, `inventory ${stats.roomsInventory} < ${roomsInventory}`);
    assert.equal(stats.roomsAvailable, stats.roomsInventory * 28);
    assert.ok(stats.roomsOccupied >= occupiedBaseline + 3, `occupied ${stats.roomsOccupied} < ${occupiedBaseline + 3}`);
    // Half-up away from zero, like the service's Decimal rounding; never "-0.00".
    const round2 = (value: number): string => {
      const rounded = (Math.sign(value) * Math.round(Math.abs(value) * 100 + 1e-9)) / 100;
      return rounded === 0 ? "0.00" : rounded.toFixed(2);
    };
    if (stats.roomsAvailable > 0) {
      assert.equal(pnl.ratios.revpar, round2(100 / stats.roomsAvailable));
      assert.equal(pnl.ratios.goppar, round2(-1150 / stats.roomsAvailable));
      assert.equal(stats.occupancyPct, round2((100 * stats.roomsOccupied) / stats.roomsAvailable));
    } else {
      assert.equal(pnl.ratios.revpar, null);
      assert.equal(stats.occupancyPct, null);
    }
    assert.equal(pnl.ratios.adr, round2(100 / stats.roomsOccupied));
  });

  it("downloads the USALI statement as pdf, xlsx and csv", async () => {
    const pdf = await get(`/accounting/usali/pnl?propertyId=${PROPERTY}&from=${FROM}&to=${TO}&format=pdf`);
    assert.equal(pdf.statusCode, 200, pdf.body);
    assert.equal(pdf.headers["content-type"], "application/pdf");
    assert.match(String(pdf.headers["content-disposition"]), /attachment; filename="usali_prop_123_2031-02-01_2031-02-28\.pdf"/);
    assert.ok(pdf.rawPayload.subarray(0, 8).toString("latin1").startsWith("%PDF-1.4"));
    assert.ok(pdf.rawPayload.toString("latin1").trimEnd().endsWith("%%EOF"));
    const xlsx = await get(`/accounting/usali/pnl?propertyId=${PROPERTY}&from=${FROM}&to=${TO}&format=xlsx`);
    assert.equal(xlsx.statusCode, 200, xlsx.body);
    assert.equal(xlsx.headers["content-type"], "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    assert.equal(xlsx.rawPayload.readUInt32LE(0), 0x04034b50);
    const csv = await get(`/accounting/usali/pnl?propertyId=${PROPERTY}&from=${FROM}&to=${TO}&format=csv`);
    assert.equal(csv.statusCode, 200, csv.body);
    assert.match(String(csv.headers["content-type"]), /text\/csv/);
    assert.equal(csv.body.charCodeAt(0), 0xfeff);
    assert.match(csv.body, /GOP · BENEFICIO OPERATIVO BRUTO;-1150,00/);
    const bad = await get(`/accounting/usali/pnl?propertyId=${PROPERTY}&from=${TO}&to=${FROM}`);
    assert.equal(bad.statusCode, 400);
    assert.equal((JSON.parse(bad.body) as ErrorBody).details?.code, "VALIDATION_ERROR");
  });

  it("compares properties of the organisation and periods against a base", async () => {
    const compare = await get(`/accounting/usali/compare?from=${FROM}&to=${TO}`);
    assert.equal(compare.statusCode, 200, compare.body);
    const body = JSON.parse(compare.body) as { properties: Array<{ propertyId: string; pnl: Pnl }>; consolidated: Pnl };
    assert.ok(body.properties.some((p) => p.propertyId === PROPERTY));
    assert.equal(body.properties.find((p) => p.propertyId === PROPERTY)!.pnl.gop, "-1150.00");
    assert.equal(body.consolidated.reconciliation.ok, true);
    const foreign = await get(`/accounting/usali/compare?from=${FROM}&to=${TO}&propertyIds=cmrhw9jy40003fyvbuu2ec2w7`);
    assert.equal(foreign.statusCode, 404, "a property of another organisation must be an opaque 404");

    const periods = await get(`/accounting/usali/periods?propertyId=${PROPERTY}&periods=${FROM}..${TO},2031-03-01..2031-03-31`);
    assert.equal(periods.statusCode, 200, periods.body);
    const comparison = JSON.parse(periods.body) as { periods: Array<{ pnl: Pnl }>; deltas: Array<{ lines: Array<{ label: string; base: string | null; compared: string | null; delta: string | null }> }> };
    assert.equal(comparison.periods[0]!.pnl.gop, "-1150.00");
    assert.equal(comparison.deltas.length, 1);
    const gop = comparison.deltas[0]!.lines.find((l) => l.label === "GOP")!;
    assert.equal(gop.base, "-1150.00");
    const onePeriod = await get(`/accounting/usali/periods?periods=${FROM}..${TO}`);
    assert.equal(onePeriod.statusCode, 400);
  });

  it("GET /accounting/annual-accounts: balance cuadra, PyG = resultado del balance, ECPN reconciled", async () => {
    const res = await get(`/accounting/annual-accounts?propertyId=${PROPERTY}&from=${FROM}&to=${TO}`);
    assert.equal(res.statusCode, 200, res.body);
    const accounts = JSON.parse(res.body) as {
      balance: { balanced: boolean; totalAssets: string; totalEquityAndLiabilities: string; periodResult: string; priorUnregularisedResult: string; warnings: string[] };
      pyg: { netResult: string; lines: Array<{ id: string; amount: string }>; operatingResult: string };
      ecpn: { reconciled: boolean; warnings: string[] };
      memoria: { notes: unknown[] };
      coherence: { ok: boolean; resultMatches: boolean; balanceBalanced: boolean };
    };
    assert.equal(accounts.balance.balanced, true, accounts.balance.warnings.join("; "));
    assert.equal(accounts.balance.totalAssets, accounts.balance.totalEquityAndLiabilities);
    assert.equal(accounts.pyg.netResult, "-1650.00");
    assert.equal(accounts.balance.periodResult, accounts.pyg.netResult);
    assert.equal(accounts.pyg.lines.find((l) => l.id === "P1")?.amount, "150.00");
    assert.equal(accounts.pyg.lines.find((l) => l.id === "P6")?.amount, "-1300.00");
    assert.equal(accounts.pyg.lines.find((l) => l.id === "P7")?.amount, "-500.00");
    assert.equal(accounts.ecpn.reconciled, true, accounts.ecpn.warnings.join("; "));
    assert.equal(accounts.coherence.ok, true);
    assert.equal(accounts.memoria.notes.length, 14);
    // The legacy 2026 entries of prop_123 were never regularised: reported, never hidden.
    assert.notEqual(accounts.balance.priorUnregularisedResult, undefined);
    const balanceCsv = await get(`/accounting/annual-accounts/balance?propertyId=${PROPERTY}&from=${FROM}&to=${TO}&format=csv&comparative=1`);
    assert.equal(balanceCsv.statusCode, 200, balanceCsv.body);
    assert.match(balanceCsv.body, /Ejercicio anterior/);
    const missingPeriod = await get("/accounting/annual-accounts/pyg");
    assert.equal(missingPeriod.statusCode, 400);
    const unknownYear = await get("/accounting/annual-accounts/balance?fiscalYearId=nope");
    assert.equal(unknownYear.statusCode, 404);
  });

  it("persists a snapshot, lists it, and renders it from the stored json", async () => {
    const created = await app.inject({ method: "POST", url: url("/accounting/annual-accounts/snapshots"), headers, payload: { kind: "balance", from: FROM, to: TO, propertyId: PROPERTY, label: MARK } });
    assert.equal(created.statusCode, 201, created.body);
    const snapshot = JSON.parse(created.body) as { id: string; kind: string; periodFrom: string; periodTo: string; json: { kind: string; totalAssets: string } };
    snapshotIds.push(snapshot.id);
    assert.equal(snapshot.kind, "balance");
    assert.equal(snapshot.periodFrom, FROM);
    assert.equal(snapshot.json.kind, "balance");
    const list = await get("/accounting/annual-accounts/snapshots?kind=balance");
    assert.equal(list.statusCode, 200, list.body);
    assert.ok((JSON.parse(list.body) as Array<{ id: string }>).some((s) => s.id === snapshot.id));
    const detail = await get(`/accounting/annual-accounts/snapshots/${snapshot.id}`);
    assert.equal(detail.statusCode, 200);
    assert.equal((JSON.parse(detail.body) as { json: { totalAssets: string } }).json.totalAssets, snapshot.json.totalAssets);
    const xlsx = await get(`/accounting/annual-accounts/snapshots/${snapshot.id}/download?format=xlsx`);
    assert.equal(xlsx.statusCode, 200, xlsx.body);
    assert.equal(xlsx.rawPayload.readUInt32LE(0), 0x04034b50);
    const usali = await app.inject({ method: "POST", url: url("/accounting/annual-accounts/snapshots"), headers, payload: { kind: "usali", from: FROM, to: TO, propertyId: PROPERTY, label: MARK } });
    assert.equal(usali.statusCode, 201, usali.body);
    snapshotIds.push((JSON.parse(usali.body) as { id: string }).id);
    const nope = await get("/accounting/annual-accounts/snapshots/does-not-exist");
    assert.equal(nope.statusCode, 404);
  });

  it("gestoría exports: csv universal with the literal rows, contaplus flagged, a3 refused, download", async () => {
    const formats = await get("/accounting/gestoria-exports/formats");
    assert.equal(formats.statusCode, 200, formats.body);
    assert.deepEqual((JSON.parse(formats.body) as { formats: Array<{ format: string; implemented: boolean }> }).formats.map((f) => [f.format, f.implemented]), [["csv_universal", true], ["vat_books_csv", true], ["contaplus_diario", true], ["a3", false]]);

    const created = await app.inject({ method: "POST", url: url("/accounting/gestoria-exports"), headers, payload: { format: "csv_universal", from: FROM, to: TO, propertyId: PROPERTY } });
    assert.equal(created.statusCode, 201, created.body);
    const row = JSON.parse(created.body) as { id: string; rowCount: number; validateWithAdvisor: boolean; fileName: string; unnumbered: number };
    exportIds.push(row.id);
    assert.equal(row.rowCount, 15);
    assert.equal(row.unnumbered, 1);
    assert.equal(row.validateWithAdvisor, false);
    assert.equal(row.fileName, `asientos_${ORG}_${FROM}_${TO}.csv`);
    const download = await get(`/accounting/gestoria-exports/${row.id}/download`);
    assert.equal(download.statusCode, 200, download.body);
    assert.match(String(download.headers["content-disposition"]), new RegExp(`attachment; filename="asientos_${ORG}_${FROM}_${TO}\\.csv"`));
    const lines = download.body.slice(1).split("\r\n").filter(Boolean);
    assert.equal(lines[0], "fecha;asiento;cuenta;concepto;debe;haber;documento;nif;base;iva");
    assert.equal(lines.length, 16);
    assert.match(lines[1]!, /^03\/02\/2031;\d+;4300;Factura alojamiento \[financial-statements test\];121,00;0,00;;;;$/);
    assert.match(lines[3]!, /^03\/02\/2031;\d+;477\.21;Factura alojamiento \[financial-statements test\];0,00;21,00;;;100,00;21$/);
    assert.match(lines[11]!, /^15\/02\/2031;P-[a-z0-9]+;640\.1;Nómina febrero \[financial-statements test\];1000,00;0,00;;;;$/);
    const debe = lines.slice(1).reduce((sum, line) => sum + Number(line.split(";")[4]!.replace(",", ".")), 0);
    const haber = lines.slice(1).reduce((sum, line) => sum + Number(line.split(";")[5]!.replace(",", ".")), 0);
    assert.equal(debe.toFixed(2), haber.toFixed(2));
    assert.equal(debe.toFixed(2), "2152.00");

    const contaplus = await app.inject({ method: "POST", url: url("/accounting/gestoria-exports"), headers, payload: { format: "contaplus_diario", from: FROM, to: TO, propertyId: PROPERTY, subaccountLength: 10 } });
    assert.equal(contaplus.statusCode, 201, contaplus.body);
    const cp = JSON.parse(contaplus.body) as { id: string; validateWithAdvisor: boolean; rowCount: number };
    exportIds.push(cp.id);
    assert.equal(cp.validateWithAdvisor, true);
    assert.equal(cp.rowCount, 15);
    const cpDownload = await get(`/accounting/gestoria-exports/${cp.id}/download`);
    assert.match(cpDownload.body, /;4300000000;/);

    const vat = await app.inject({ method: "POST", url: url("/accounting/gestoria-exports"), headers, payload: { format: "vat_books_csv", from: FROM, to: TO } });
    assert.equal(vat.statusCode, 201, vat.body);
    exportIds.push((JSON.parse(vat.body) as { id: string }).id);

    const a3 = await app.inject({ method: "POST", url: url("/accounting/gestoria-exports"), headers, payload: { format: "a3", from: FROM, to: TO } });
    assert.equal(a3.statusCode, 409, a3.body);
    assert.equal((JSON.parse(a3.body) as ErrorBody).details?.code, "EXPORT_FORMAT_NOT_IMPLEMENTED");

    const list = await get("/accounting/gestoria-exports?format=csv_universal");
    assert.equal(list.statusCode, 200);
    assert.ok((JSON.parse(list.body) as Array<{ id: string }>).some((e) => e.id === row.id));
  });

  it("a high-risk write without a session is a 401", async () => {
    const res = await app.inject({ method: "PATCH", url: url("/accounting/usali/mappings"), payload: { mappings: [{ accountPrefix: "62", usaliDepartment: "admin_general", usaliLine: "other_expense" }] } });
    assert.equal(res.statusCode, 401, res.body);
  });

  // ---- Part B · isolated organisation through Prisma + SQL reader ------------

  const testContext = () => ({
    organizationId: testOrgId,
    propertyId: testPropertyId,
    userId: "fs-test-user",
    fullName: "FS Test",
    deviceId: "fs-test",
    permissions: ["accounting.read", "accounting.configure", "analytics.export"] as never
  });

  it("annual accounts of the reference ledger through the SQL reader: activo 60.184,80 = PN 58.098,00 + pasivo 2.086,80", async () => {
    const accounts = await buildAnnualAccounts({ context: testContext() as never, from: "2027-01-01", to: "2027-12-31" });
    assert.equal(accounts.balance.balanced, true, accounts.balance.warnings.join("; "));
    assert.equal(accounts.balance.totalAssets, "60184.80");
    assert.equal(accounts.balance.equity.total, "58098.00");
    assert.equal(accounts.balance.liabilities.total, "2086.80");
    assert.equal(accounts.pyg.netResult, "-1902.00");
    assert.equal(accounts.balance.periodResult, "-1902.00");
    assert.equal(accounts.balance.priorUnregularisedResult, "0.00");
    assert.equal(accounts.ecpn.reconciled, true, accounts.ecpn.warnings.join("; "));
    assert.equal(accounts.coherence.ok, true);
    assert.equal(accounts.memoria.entity.taxId, "B12345674");
    assert.deepEqual(accounts.balance.warnings, []);
  });

  it("USALI of the reference ledger through Prisma: neto −1.895,00, 7,00 sin asignar, 45 room-nights of real stays", async () => {
    const pnl = await buildUsaliPnl({ context: testContext() as never, propertyId: testPropertyId, from: "2027-01-01", to: "2027-03-31" });
    assert.equal(pnl.gop, "-1285.00");
    assert.equal(pnl.ebitda, "-1785.00");
    assert.equal(pnl.netIncome, "-1895.00");
    assert.equal(pnl.unassigned.expense, "7.00");
    assert.equal(pnl.reconciliation.pgcResult, "-1902.00");
    assert.equal(pnl.reconciliation.ok, true);
    assert.equal(pnl.statistics.roomsInventory, 10);
    assert.equal(pnl.statistics.roomsAvailable, 900);
    assert.equal(pnl.statistics.roomsOccupied, 45);
    assert.equal(pnl.statistics.occupancyPct, "5.00");
    assert.equal(pnl.ratios.revpar, "0.11");
    assert.equal(pnl.ratios.adr, "2.22");
    assert.equal(pnl.ratios.goppar, "-1.43");
  });

  it("closing the year (regularization + closing + opening) changes nothing at 2027-12-31 and carries 129 into 2028", async () => {
    for (const spec of closingEntries()) testEntryIds.push(await postEntry(testOrgId, testPropertyId, spec));
    const closed = await buildAnnualAccounts({ context: testContext() as never, from: "2027-01-01", to: "2027-12-31" });
    assert.equal(closed.balance.balanced, true, closed.balance.warnings.join("; "));
    assert.equal(closed.balance.totalAssets, "60184.80");
    assert.equal(closed.pyg.netResult, "-1902.00");
    assert.equal(closed.balance.periodResult, "-1902.00");
    assert.equal(closed.coherence.ok, true);
    const next = await buildAnnualAccounts({ context: testContext() as never, from: "2028-01-01", to: "2028-03-31" });
    assert.equal(next.balance.balanced, true, next.balance.warnings.join("; "));
    assert.equal(next.balance.totalAssets, "60184.80");
    assert.equal(next.balance.periodResult, "0.00");
    assert.equal(next.balance.priorUnregularisedResult, "0.00");
    assert.equal(next.balance.equity.lines.find((l) => l.id === "E_V")?.amount, "-1902.00");
    assert.equal(next.ecpn.rows.find((r) => r.id === "A")?.values.priorResults, "-1902.00");
    assert.equal(next.ecpn.reconciled, true, next.ecpn.warnings.join("; "));
  });
});
