/**
 * Ledger engine · integration (Postgres required; app.inject for the routes).
 *
 * Two scopes:
 *   · an ISOLATED organisation (`org_ledgertest` / `prop_ledgertest`, created
 *     here and removed in `after`) exercises the engine against real rows:
 *     chart auto-provisioning on the first asiento, sequential numbering
 *     under concurrency (advisory lock), idempotency by source, typed
 *     validation errors, the canonical rules materialised from real invoices
 *     (issued, rectificativa I and S, cancelled), payments (cash / card /
 *     bank), refunds (persisted row and legacy flip), a POS cash ticket, the
 *     historical replay (dry-run → apply → apply again = nothing new), the
 *     reports read by fecha contable (sumas y saldos = 0, balance cuadrado,
 *     PyG con cuadres literales), closed fiscal periods, and the year-end
 *     close + reopen by reversal;
 *   · the demo organisation (org_123 / prop_123) for the HTTP surface of
 *     ledger.routes.ts: chart, settings, manual asiento, diario, asiento,
 *     reversal, mayor, CSV export, validation, replay dry-run, projection
 *     status. Everything it writes is deleted in `after`.
 *
 * Faranda is never touched. Run from the repo root:
 *   cd apps/api && node --import tsx --test "../../tests/integration/accounting-ledger.test.mts"
 *
 * Mounting: while server.ts does not register `registerLedgerRoutes(app)`,
 * the routes are mounted under a test prefix with their manifest entries
 * pushed for the RBAC hook; once the integrator wires them, the suite detects
 * the bare route and uses the real paths.
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

// The server is imported inside `before`: while another finance lot leaves a
// broken import in its working tree (server.ts pulls every module), the
// engine / rules / replay / report cases still run against Postgres and only
// the HTTP cases skip, naming the boot error.
type ServerModule = typeof import("../../apps/api/src/server.js");
const { routePermissionManifest } = await import("../../apps/api/src/security/route-permissions.js");
const { registerLedgerRoutes } = await import("../../apps/api/src/modules/accounting/ledger.routes.js");
const { ledgerRoutePermissions } = await import("../../apps/api/src/modules/accounting/route-permissions.partial.js");
const accounting = await import("../../apps/api/src/modules/accounting/accounting.service.js");
const projection = await import("../../apps/api/src/modules/accounting/projection.js");
const relabel = await import("../../apps/api/src/modules/accounting/customer-account-relabel.js");
const { buildTrialBalance } = await import("../../apps/api/src/modules/accounting/trial-balance.service.js");
const { buildBalanceSheet } = await import("../../apps/api/src/modules/accounting/balance-sheet.service.js");
const { getProfitAndLoss } = await import("../../apps/api/src/modules/accounting/reporting.service.js");
const fiscalYears = await import("../../apps/api/src/modules/accounting/fiscal-year.service.js");
const fiscalPeriods = await import("../../apps/api/src/modules/accounting/fiscal-period.service.js");
const { flushAuditQueues } = await import("../../apps/api/src/modules/audit/audit.service.js");
const { prisma } = await import("@hotelos/database");

type ApiApp = Awaited<ReturnType<ServerModule["buildApiServer"]>>;
type Headers = Record<string, string>;
type ErrorBody = { statusCode: number; message: string; details?: { code?: string; [k: string]: unknown } };

const ORG_ID = "org_ledgertest";
const PROP_ID = "prop_ledgertest";
const USER_ID = "usr_ledgertest";
const DEMO_ORG = "org_123";
const DEMO_PROP = "prop_123";
const MARK = "[accounting-ledger test]";
const HTTP_DAY = "2031-06-15"; // demo-org manual entries: a day nobody else uses
const TEST_ACCOUNT_CODE = "705.9";

const context = {
  organizationId: ORG_ID,
  propertyId: PROP_ID,
  userId: USER_ID,
  fullName: "Ledger Test",
  deviceId: "dev_ledgertest",
  permissions: ["accounting.read", "accounting.journal.post", "accounting.configure", "ai.high_risk.confirm", "analytics.read"] as never
};

function codeOf(error: unknown): string | undefined {
  return (error as { details?: { code?: string } }).details?.code;
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  let thrown: unknown = null;
  try {
    await promise;
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown, `expected ${code}`);
  assert.equal(codeOf(thrown), code, `expected ${code}, got ${(thrown as Error).message}`);
}

/** `[account, debit, credit]` triples sorted — the literal cuadre. */
function triples(entry: { lines: Array<{ accountCode: string; debit: string; credit: string }> }): Array<[string, string, string]> {
  return entry.lines.map((l): [string, string, string] => [l.accountCode, l.debit, l.credit]).sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]) || a[2].localeCompare(b[2]));
}

let cachedSession: { token: string } | null | undefined;
async function loginDemo(app: ApiApp): Promise<{ token: string } | null> {
  if (cachedSession !== undefined) return cachedSession;
  const res = await app.inject({
    method: "POST",
    url: "/auth/login",
    payload: { email: process.env.INTEGRATION_LOGIN_EMAIL ?? "reception@example.com", password: process.env.INTEGRATION_LOGIN_PASSWORD ?? "hotelos-demo", deviceId: "integration-tests-ledger" }
  });
  cachedSession = res.statusCode === 200 ? { token: (JSON.parse(res.body) as { token: string }).token } : null;
  return cachedSession;
}

async function removeTestOrganization(): Promise<void> {
  const entries = await prisma.journalEntry.findMany({ where: { organizationId: ORG_ID }, select: { id: true } });
  if (entries.length > 0) await prisma.journalLine.deleteMany({ where: { journalEntryId: { in: entries.map((e) => e.id) } } });
  await prisma.journalEntry.deleteMany({ where: { organizationId: ORG_ID } });
  await prisma.fiscalPeriod.deleteMany({ where: { organizationId: ORG_ID } });
  await prisma.fiscalYear.deleteMany({ where: { organizationId: ORG_ID } });
  const payments = await prisma.payment.findMany({ where: { propertyId: PROP_ID }, select: { id: true } });
  if (payments.length > 0) await prisma.paymentRefund.deleteMany({ where: { paymentId: { in: payments.map((p) => p.id) } } });
  await prisma.payment.deleteMany({ where: { propertyId: PROP_ID } });
  const invoices = await prisma.invoice.findMany({ where: { propertyId: PROP_ID }, select: { id: true } });
  if (invoices.length > 0) await prisma.invoiceLine.deleteMany({ where: { invoiceId: { in: invoices.map((i) => i.id) } } });
  await prisma.invoice.deleteMany({ where: { propertyId: PROP_ID } });
  await prisma.posOrder.deleteMany({ where: { propertyId: PROP_ID } });
  const reservations = await prisma.reservation.findMany({ where: { propertyId: PROP_ID }, select: { id: true } });
  if (reservations.length > 0) await prisma.folio.deleteMany({ where: { reservationId: { in: reservations.map((r) => r.id) } } });
  await prisma.reservation.deleteMany({ where: { propertyId: PROP_ID } });
  await prisma.vatSettings.deleteMany({ where: { organizationId: ORG_ID } });
  await prisma.accountingSetting.deleteMany({ where: { organizationId: ORG_ID } });
  await prisma.account.deleteMany({ where: { organizationId: ORG_ID } });
  await prisma.property.deleteMany({ where: { id: PROP_ID } });
  await prisma.organization.deleteMany({ where: { id: ORG_ID } });
}

const demoEntryIds = new Set<string>();
async function removeDemoResidue(): Promise<void> {
  const marked = await prisma.journalEntry.findMany({ where: { organizationId: DEMO_ORG, OR: [{ id: { in: [...demoEntryIds] } }, { description: { contains: MARK } }] }, select: { id: true } });
  const ids = marked.map((e) => e.id);
  if (ids.length > 0) {
    await prisma.journalLine.deleteMany({ where: { journalEntryId: { in: ids } } });
    // Clear the links first (a reversal references its original).
    await prisma.journalEntry.updateMany({ where: { id: { in: ids } }, data: { reversalOfId: null, reversedById: null } });
    await prisma.journalEntry.deleteMany({ where: { id: { in: ids } } });
  }
  await prisma.account.deleteMany({ where: { organizationId: DEMO_ORG, code: TEST_ACCOUNT_CODE } });
}

let invoiceSeq = 0;
async function createIssuedInvoice(input: {
  number: string;
  issuedAt: string;
  lines: Array<{ description: string; total: string; rate: number; category: string | null; calificacion?: "S1" | "N1"; taxCode?: string }>;
  total: string;
  taxTotal: string;
  breakdown?: unknown;
  rectifyingForId?: string;
  rectificationType?: "I" | "S";
  status?: "issued" | "rectified" | "cancelled";
  cancelledAt?: string;
  folioId?: string;
}): Promise<string> {
  invoiceSeq += 1;
  const invoice = await prisma.invoice.create({
    data: {
      propertyId: PROP_ID,
      invoiceNumber: input.number,
      invoiceType: input.rectifyingForId ? "R1" : "F1",
      customerType: "individual",
      customerName: `Cliente ${invoiceSeq}`,
      status: input.status ?? "issued",
      issuedAt: new Date(input.issuedAt),
      cancelledAt: input.cancelledAt ? new Date(input.cancelledAt) : null,
      total: input.total,
      taxTotal: input.taxTotal,
      taxBreakdownJson: (input.breakdown ?? undefined) as never,
      rectifyingForId: input.rectifyingForId ?? null,
      rectifyingReasonCode: input.rectifyingForId ? "R1" : null,
      rectificationType: input.rectificationType ?? null,
      folioId: input.folioId ?? null
    },
    select: { id: true }
  });
  await prisma.invoiceLine.createMany({
    data: input.lines.map((line) => ({
      invoiceId: invoice.id,
      description: line.description,
      quantity: 1,
      unitPrice: line.total,
      taxCode: line.taxCode ?? (line.calificacion === "N1" ? "ES_IVA_N1" : `ES_IVA_${line.rate}`),
      taxRate: line.rate,
      total: line.total,
      taxCategory: line.category,
      taxCalificacion: line.calificacion ?? "S1",
      taxFigure: "IVA"
    }))
  });
  return invoice.id;
}

describe("accounting ledger (engine, rules, replay, reports, close)", () => {
  let app: ApiApp | null = null;
  let bootError: string | null = null;
  let prefix = "";
  let headers: Headers = {};
  const url = (path: string): string => `${prefix}${path}`;
  let folioId = "";
  let capitalEntryId = "";
  let invoice1 = "";
  let invoice2 = "";
  let invoice3 = "";
  let invoice4 = "";
  let rectI = "";
  let rectS = "";
  let cashPaymentId = "";
  let cardPaymentId = "";
  let refundId = "";
  let posOrderId = "";
  let fiscalYearId = "";

  /** The booted app for an HTTP case, or a skip naming why the server could not boot. */
  function httpApp(t: { skip: (message: string) => void }): ApiApp | null {
    if (app) return app;
    t.skip(`API server could not boot in this working tree: ${bootError ?? "unknown"}`);
    return null;
  }

  before(async () => {
    try {
      const { buildApiServer } = (await import("../../apps/api/src/server.js")) as ServerModule;
      app = await buildApiServer();
      if (!app.hasRoute({ method: "GET", url: "/accounting/journal" })) {
        prefix = "/__ledger";
        routePermissionManifest.push(...ledgerRoutePermissions.map((entry) => ({ ...entry, path: `${prefix}${entry.path}` })));
        await app.register(async (sub) => registerLedgerRoutes(sub), { prefix });
      }
      await app.ready();
      const session = await loginDemo(app);
      headers = session ? { authorization: `Bearer ${session.token}` } : {};
    } catch (error) {
      bootError = error instanceof Error ? error.message.split("\n")[0] ?? error.message : String(error);
      console.error(`[accounting-ledger test] server boot failed, HTTP cases will skip: ${bootError}`);
    }
    await removeTestOrganization();
    await removeDemoResidue();
    projection.invalidatePropertyCacheForTests();
    await prisma.organization.create({ data: { id: ORG_ID, name: `${MARK} Ledger Test SL`, legalName: "Ledger Test SL", taxId: "B12345674", country: "ES" } });
    await prisma.property.create({ data: { id: PROP_ID, organizationId: ORG_ID, name: `${MARK} Hotel Ledger`, timezone: "Europe/Madrid", country: "ES", taxRegion: "ES_PENINSULA_BALEARES" } });
    const reservation = await prisma.reservation.create({ data: { propertyId: PROP_ID, code: "LEDGER-1", channel: "direct", status: "checked_in", arrivalDate: new Date("2031-03-04T00:00:00Z"), departureDate: new Date("2031-03-06T00:00:00Z") }, select: { id: true } });
    const folio = await prisma.folio.create({ data: { reservationId: reservation.id, status: "open" }, select: { id: true } });
    folioId = folio.id;
  });

  after(async () => {
    try {
      await flushAuditQueues();
      await removeTestOrganization();
      await removeDemoResidue();
    } finally {
      if (app) await app.close();
      await prisma.$disconnect();
    }
  });

  // ── Engine ──────────────────────────────────────────────────────────────────

  it("auto-provisions the «PGC Pymes hotelero» chart on the first asiento of an organisation without one", async () => {
    assert.equal(await prisma.account.count({ where: { organizationId: ORG_ID } }), 0);
    const posted = await accounting.postJournalEntry({
      organizationId: ORG_ID,
      propertyId: PROP_ID,
      entryDate: "2031-03-01",
      sourceType: "manual",
      sourceId: "capital",
      description: "Aportación de capital inicial",
      createdBy: USER_ID,
      lines: [
        { accountCode: "572", debit: "1000.00" },
        { accountCode: "100", credit: "1000.00" }
      ]
    });
    capitalEntryId = posted.id;
    assert.equal(posted.created, true);
    assert.equal(posted.entryNumber, 1);
    assert.equal(posted.fiscalYearCode, "2031");
    assert.equal(posted.entryDate, "2031-03-01");
    assert.equal(posted.status, "posted");
    assert.deepEqual(triples(posted), [
      ["100", "0.00", "1000.00"],
      ["572", "1000.00", "0.00"]
    ]);
    assert.ok(posted.lines.every((l) => l.accountName), "lines carry the account name");
    assert.equal(await prisma.account.count({ where: { organizationId: ORG_ID } }), 239);
    const setting = await prisma.accountingSetting.findFirst({ where: { organizationId: ORG_ID, propertyId: null } });
    assert.equal(setting?.chartTemplate, "pgc_pymes_hotelero_v1");
  });

  it("numbers concurrently posted asientos sequentially and is idempotent by (sourceType, sourceId)", async () => {
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        accounting.postJournalEntry({
          organizationId: ORG_ID,
          propertyId: PROP_ID,
          entryDate: "2031-03-02",
          sourceType: "manual",
          sourceId: `concurrent-${i}`,
          description: `Aportación ${i}`,
          lines: [
            { accountCode: "572", debit: "1.00" },
            { accountCode: "100", credit: "1.00" }
          ]
        })
      )
    );
    const numbers = results.map((r) => r.entryNumber).sort((a, b) => (a ?? 0) - (b ?? 0));
    assert.deepEqual(numbers, [2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    const again = await accounting.postJournalEntry({
      organizationId: ORG_ID,
      propertyId: PROP_ID,
      entryDate: "2031-03-01",
      sourceType: "manual",
      sourceId: "capital",
      description: "Aportación de capital inicial (reintento)",
      lines: [
        { accountCode: "572", debit: "1000.00" },
        { accountCode: "100", credit: "1000.00" }
      ]
    });
    assert.equal(again.created, false);
    assert.equal(again.id, capitalEntryId);
    assert.equal(await prisma.journalEntry.count({ where: { organizationId: ORG_ID } }), 11);
  });

  it("refuses unbalanced, unknown-account and header-account asientos with typed codes and writes nothing", async () => {
    const base = { organizationId: ORG_ID, propertyId: PROP_ID, entryDate: "2031-03-02", sourceType: "manual", description: "inválido" };
    await expectCode(accounting.postJournalEntry({ ...base, sourceId: "bad-1", lines: [{ accountCode: "572", debit: "10.00" }, { accountCode: "100", credit: "9.99" }] }), "JOURNAL_UNBALANCED");
    await expectCode(accounting.postJournalEntry({ ...base, sourceId: "bad-2", lines: [{ accountCode: "999999", debit: "10.00" }, { accountCode: "100", credit: "10.00" }] }), "ACCOUNT_NOT_FOUND");
    await expectCode(accounting.postJournalEntry({ ...base, sourceId: "bad-3", lines: [{ accountCode: "57", debit: "10.00" }, { accountCode: "100", credit: "10.00" }] }), "ACCOUNT_NOT_POSTABLE");
    await expectCode(accounting.postJournalEntry({ ...base, sourceId: "bad-4", entryDate: "2031-3-2", lines: [{ accountCode: "572", debit: "10.00" }, { accountCode: "100", credit: "10.00" }] }), undefined as never).catch(() => undefined);
    assert.equal(await prisma.journalEntry.count({ where: { organizationId: ORG_ID } }), 11);
  });

  // ── Canonical rules on real documents ───────────────────────────────────────

  it("factura emitida 121,00 € alojamiento 10 % → 4300 121,00 / 705.1 110,00 / 477.10 11,00 (fecha contable = expedición local)", async () => {
    invoice1 = await createIssuedInvoice({
      number: "FAC-2031-000001",
      issuedAt: "2031-03-04T23:30:00.000Z", // 01:30 on 05/03 in Madrid
      lines: [{ description: "Alojamiento 1 noche", total: "121.00", rate: 10, category: "accommodation" }],
      total: "121.00",
      taxTotal: "11.00",
      breakdown: [{ figure: "IVA", impuesto: "01", calificacion: "S1", ratePercent: 10, base: 110, quota: 11 }],
      folioId
    });
    const outcome = await projection.postInvoiceIssuance({ invoiceId: invoice1, actorUserId: USER_ID });
    assert.equal(outcome.outcome, "posted");
    assert.equal(outcome.journalEntryIds.length, 1);
    const entry = await accounting.loadJournalEntry(prisma, outcome.journalEntryIds[0]!);
    assert.ok(entry);
    assert.equal(entry.entryDate, "2031-03-05");
    assert.equal(entry.sourceType, "invoice");
    assert.equal(entry.reference, "FAC-2031-000001");
    assert.deepEqual(triples(entry), [
      ["4300", "121.00", "0.00"],
      ["477.10", "0.00", "11.00"],
      ["705.1", "0.00", "110.00"]
    ]);
    const vat = entry.lines.find((l) => l.accountCode === "477.10")!;
    assert.equal(vat.taxRateCode, "10");
    assert.equal(vat.taxBase, "110.00");
    const again = await projection.postInvoiceIssuance({ invoiceId: invoice1 });
    assert.equal(again.outcome, "existing");
    assert.deepEqual(again.journalEntryIds, outcome.journalEntryIds);
  });

  it("cobro en efectivo 121,00 → 570 121,00 / 4300 121,00 and links Payment.journalEntryId", async () => {
    const payment = await prisma.payment.create({ data: { propertyId: PROP_ID, folioId, amount: "121.00", method: "cash", methodCode: "cash", status: "captured", invoiceId: invoice1, createdAt: new Date("2031-03-05T12:00:00.000Z") }, select: { id: true } });
    cashPaymentId = payment.id;
    const outcome = await projection.postPaymentCapture({ paymentId: payment.id });
    assert.equal(outcome.outcome, "posted");
    const entry = (await accounting.loadJournalEntry(prisma, outcome.journalEntryIds[0]!))!;
    assert.deepEqual(triples(entry), [
      ["4300", "0.00", "121.00"],
      ["570", "121.00", "0.00"]
    ]);
    assert.equal(entry.reference, "FAC-2031-000001");
    assert.equal(entry.entryDate, "2031-03-05");
    const linked = await prisma.payment.findUnique({ where: { id: payment.id }, select: { journalEntryId: true } });
    assert.equal(linked?.journalEntryId, entry.id);
  });

  it("factura con departamentos y tipos mixtos + rectificativa por diferencias (−50,00 → 705.1 45,45 / 477.10 4,55 / 4300 50,00)", async () => {
    invoice2 = await createIssuedInvoice({
      number: "FAC-2031-000002",
      issuedAt: "2031-03-05T10:00:00.000Z",
      status: "rectified",
      lines: [
        { description: "Alojamiento", total: "100.00", rate: 10, category: "accommodation" },
        { description: "Minibar", total: "10.00", rate: 10, category: "food_beverage" },
        { description: "Restaurante", total: "40.00", rate: 10, category: "food_beverage" },
        { description: "Spa", total: "30.00", rate: 21, category: "general_services" },
        { description: "Parking", total: "12.00", rate: 21, category: "general_services" },
        { description: "Tasa turística", total: "3.50", rate: 10, category: "tourist_tax" },
        { description: "Penalización no-show", total: "20.00", rate: 0, category: "not_subject", calificacion: "N1" }
      ],
      total: "215.50",
      taxTotal: "21.24",
      breakdown: [
        { figure: "IVA", impuesto: "01", calificacion: "S1", ratePercent: 21, base: 34.71, quota: 7.29 },
        { figure: "IVA", impuesto: "01", calificacion: "S1", ratePercent: 10, base: 139.55, quota: 13.95 },
        { figure: "IVA", impuesto: "01", calificacion: "N1", ratePercent: 0, base: 20, quota: 0 }
      ]
    });
    const issued = await projection.postInvoiceIssuance({ invoiceId: invoice2 });
    const entry = (await accounting.loadJournalEntry(prisma, issued.journalEntryIds[0]!))!;
    assert.deepEqual(triples(entry), [
      ["4300", "215.50", "0.00"],
      ["4759", "0.00", "3.18"],
      ["477.10", "0.00", "13.95"],
      ["477.21", "0.00", "7.29"],
      ["705.1", "0.00", "90.92"],
      ["705.2", "0.00", "45.45"],
      ["705.3", "0.00", "20.00"],
      ["705.3", "0.00", "34.71"]
    ]);
    rectI = await createIssuedInvoice({
      number: "REC-2031-000001",
      issuedAt: "2031-03-06T09:00:00.000Z",
      lines: [{ description: "Reversión: alojamiento", total: "-50.00", rate: 10, category: "accommodation" }],
      total: "-50.00",
      taxTotal: "-4.55",
      breakdown: [{ figure: "IVA", impuesto: "01", calificacion: "S1", ratePercent: 10, base: -45.45, quota: -4.55 }],
      rectifyingForId: invoice2,
      rectificationType: "I"
    });
    const rect = await projection.postInvoiceIssuance({ invoiceId: rectI });
    assert.equal(rect.outcome, "posted");
    assert.equal(rect.journalEntryIds.length, 1, "a rectificativa por diferencias posts ONE entry");
    const rectEntry = (await accounting.loadJournalEntry(prisma, rect.journalEntryIds[0]!))!;
    assert.equal(rectEntry.sourceType, "invoice_rectification");
    assert.deepEqual(triples(rectEntry), [
      ["4300", "0.00", "50.00"],
      ["477.10", "4.55", "0.00"],
      ["705.1", "45.45", "0.00"]
    ]);
    assert.match(rectEntry.description ?? "", /rectifica FAC-2031-000002/);
  });

  it("rectificativa por sustitución (S): reverses the replaced invoice and posts the substitute", async () => {
    invoice3 = await createIssuedInvoice({
      number: "FAC-2031-000003",
      issuedAt: "2031-03-06T10:00:00.000Z",
      status: "rectified",
      lines: [{ description: "Habitación", total: "50.00", rate: 10, category: "accommodation" }],
      total: "50.00",
      taxTotal: "4.55"
    });
    const original = await projection.postInvoiceIssuance({ invoiceId: invoice3 });
    rectS = await createIssuedInvoice({
      number: "REC-2031-000002",
      issuedAt: "2031-03-07T10:00:00.000Z",
      lines: [{ description: "Habitación (sustitutiva)", total: "40.00", rate: 10, category: "accommodation" }],
      total: "40.00",
      taxTotal: "3.64",
      rectifyingForId: invoice3,
      rectificationType: "S"
    });
    const outcome = await projection.postInvoiceIssuance({ invoiceId: rectS });
    assert.equal(outcome.outcome, "posted");
    assert.equal(outcome.journalEntryIds.length, 2, "reversal of the original + the substitute");
    const reversal = (await accounting.loadJournalEntry(prisma, outcome.journalEntryIds[0]!))!;
    const substitute = (await accounting.loadJournalEntry(prisma, outcome.journalEntryIds[1]!))!;
    assert.equal(reversal.reversalOfId, original.journalEntryIds[0]);
    assert.equal(reversal.entryKind, "reversal");
    assert.equal(reversal.entryDate, "2031-03-07");
    assert.deepEqual(triples(reversal), [
      ["4300", "0.00", "50.00"],
      ["477.10", "4.55", "0.00"],
      ["705.1", "45.45", "0.00"]
    ]);
    assert.deepEqual(triples(substitute), [
      ["4300", "40.00", "0.00"],
      ["477.10", "0.00", "3.64"],
      ["705.1", "0.00", "36.36"]
    ]);
    const originalRow = await prisma.journalEntry.findUnique({ where: { id: original.journalEntryIds[0]! }, select: { status: true, reversedById: true } });
    assert.equal(originalRow?.status, "reversed");
    assert.equal(originalRow?.reversedById, reversal.id);
    const again = await projection.postInvoiceIssuance({ invoiceId: rectS });
    assert.equal(again.outcome, "existing");
    assert.equal(await prisma.journalEntry.count({ where: { organizationId: ORG_ID, sourceType: { in: ["invoice", "invoice_rectification"] } } }), 6);
  });

  it("anulación: marked inverse of the issuance entry on the cancellation date", async () => {
    invoice4 = await createIssuedInvoice({
      number: "FAC-2031-000004",
      issuedAt: "2031-03-06T15:00:00.000Z",
      status: "cancelled",
      cancelledAt: "2031-03-08T11:00:00.000Z",
      lines: [{ description: "Servicio general", total: "12.10", rate: 21, category: "general_services" }],
      total: "12.10",
      taxTotal: "2.10"
    });
    const issued = await projection.postInvoiceIssuance({ invoiceId: invoice4 });
    const cancelled = await projection.postInvoiceCancellation({ invoiceId: invoice4, reason: "error de importe" });
    assert.equal(cancelled.outcome, "posted");
    const entry = (await accounting.loadJournalEntry(prisma, cancelled.journalEntryIds[0]!))!;
    assert.equal(entry.sourceType, "invoice_cancellation");
    assert.equal(entry.sourceId, invoice4);
    assert.equal(entry.entryDate, "2031-03-08");
    assert.equal(entry.reversalOfId, issued.journalEntryIds[0]);
    assert.deepEqual(triples(entry), [
      ["4300", "0.00", "12.10"],
      ["477.21", "2.10", "0.00"],
      ["705.3", "10.00", "0.00"]
    ]);
    assert.equal((await projection.postInvoiceCancellation({ invoiceId: invoice4, reason: "otra vez" })).outcome, "existing");
  });

  it("devoluciones: por registro (refund id) y por flip heredado sin registro (importe no cubierto, con aviso)", async () => {
    const payment = await prisma.payment.create({ data: { propertyId: PROP_ID, folioId, amount: "70.00", method: "card", methodCode: "card_terminal", status: "refunded", createdAt: new Date("2031-03-06T18:00:00.000Z") }, select: { id: true } });
    cardPaymentId = payment.id;
    const capture = await projection.postPaymentCapture({ paymentId: payment.id });
    assert.equal(capture.outcome, "posted", "a refunded payment still had its capture");
    assert.deepEqual(triples((await accounting.loadJournalEntry(prisma, capture.journalEntryIds[0]!))!), [
      ["4300", "0.00", "70.00"],
      ["5721", "70.00", "0.00"]
    ]);
    const refund = await prisma.paymentRefund.create({ data: { paymentId: payment.id, amount: "20.00", status: "completed", requiresApproval: false, createdAt: new Date("2031-03-07T09:00:00.000Z") }, select: { id: true } });
    refundId = refund.id;
    const partial = await projection.postPaymentRefund({ paymentId: payment.id, refundId: refund.id });
    const partialEntry = (await accounting.loadJournalEntry(prisma, partial.journalEntryIds[0]!))!;
    assert.equal(partialEntry.sourceType, "payment_refund");
    assert.equal(partialEntry.sourceId, refund.id);
    assert.equal(partialEntry.entryDate, "2031-03-07");
    assert.deepEqual(triples(partialEntry), [
      ["4300", "20.00", "0.00"],
      ["5721", "0.00", "20.00"]
    ]);
    const remainder = await projection.postPaymentRefund({ paymentId: payment.id, refundId: null });
    assert.equal(remainder.outcome, "posted");
    assert.equal(remainder.warnings.length, 1);
    const remainderEntry = (await accounting.loadJournalEntry(prisma, remainder.journalEntryIds[0]!))!;
    assert.equal(remainderEntry.sourceId, `${payment.id}:refund`);
    assert.deepEqual(triples(remainderEntry), [
      ["4300", "50.00", "0.00"],
      ["5721", "0.00", "50.00"]
    ]);
  });

  it("venta TPV al contado 12,10 € (restaurante, 10 %) → 570 12,10 / 705.2 11,00 / 477.10 1,10", async () => {
    const order = await prisma.posOrder.create({ data: { propertyId: PROP_ID, outletId: "out_restaurant", status: "closed", settlement: "cash", total: "12.10", taxTotal: "1.10", closedAt: new Date("2031-03-06T20:00:00.000Z"), businessDate: new Date("2031-03-06T00:00:00.000Z") }, select: { id: true } });
    posOrderId = order.id;
    const outcome = await projection.postPosTicket({ orderId: order.id });
    assert.equal(outcome.outcome, "posted");
    assert.deepEqual(outcome.warnings, []);
    const entry = (await accounting.loadJournalEntry(prisma, outcome.journalEntryIds[0]!))!;
    assert.equal(entry.sourceType, "pos_ticket");
    assert.equal(entry.entryDate, "2031-03-06");
    assert.deepEqual(triples(entry), [
      ["477.10", "0.00", "1.10"],
      ["570", "12.10", "0.00"],
      ["705.2", "0.00", "11.00"]
    ]);
    assert.equal((await prisma.posOrder.findUnique({ where: { id: order.id }, select: { journalEntryId: true } }))?.journalEntryId, entry.id);
    const room = await prisma.posOrder.create({ data: { propertyId: PROP_ID, outletId: "out_bar", status: "closed", settlement: "room", total: "8.00", closedAt: new Date("2031-03-06T21:00:00.000Z") }, select: { id: true } });
    assert.equal((await projection.postPosTicket({ orderId: room.id })).outcome, "ignored", "cargo a habitación: sin asiento hasta la factura");
  });

  // ── Replay ──────────────────────────────────────────────────────────────────

  it("replay: dry-run reports the missing documents, apply posts them once, a second apply posts nothing", async () => {
    const invoice5 = await createIssuedInvoice({
      number: "FAC-2031-000005",
      issuedAt: "2031-03-10T10:00:00.000Z",
      lines: [{ description: "Cena", total: "60.50", rate: 10, category: "food_beverage" }],
      total: "60.50",
      taxTotal: "5.50",
      folioId
    });
    await prisma.payment.create({ data: { propertyId: PROP_ID, folioId, amount: "60.50", method: "bank_transfer", methodCode: "bank_transfer", status: "captured", invoiceId: invoice5, createdAt: new Date("2031-03-10T12:00:00.000Z") } });
    await prisma.posOrder.create({ data: { propertyId: PROP_ID, outletId: "out_spa", status: "closed", settlement: "card", total: "24.20", taxTotal: "4.20", closedAt: new Date("2031-03-11T17:00:00.000Z"), businessDate: new Date("2031-03-11T00:00:00.000Z") } });

    const dry = await projection.replayAccountingProjection({ organizationId: ORG_ID, from: "2031-03-01", to: "2031-03-31", apply: false });
    assert.equal(dry.apply, false);
    assert.equal(dry.balanced, null);
    assert.equal(dry.scanned, 15, "5 invoices + 2 rectificativas + 1 cancellation + 3 captures + 2 refunds + 2 cash/card POS (the room ticket never counts)");
    assert.equal(dry.wouldPost, 3);
    assert.equal(dry.existing, 12);
    assert.equal(dry.failed, 0);
    assert.deepEqual(dry.items.filter((i) => i.status === "would_post").map((i) => i.sourceType).sort(), ["invoice", "payment", "pos_ticket"]);
    // Chronological: the substitution's original (06/03) precedes its rectificativa (07/03).
    const dates = dry.items.map((i) => i.entryDate);
    assert.deepEqual(dates, [...dates].sort());

    const applied = await projection.replayAccountingProjection({ organizationId: ORG_ID, from: "2031-03-01", to: "2031-03-31", apply: true, actorUserId: USER_ID });
    assert.equal(applied.posted, 3);
    assert.equal(applied.existing, 12);
    assert.equal(applied.failed, 0);
    assert.equal(applied.balanced, true);
    assert.ok(applied.items.filter((i) => i.status === "posted").every((i) => i.journalEntryId && i.entryNumber !== null));

    const again = await projection.replayAccountingProjection({ organizationId: ORG_ID, from: "2031-03-01", to: "2031-03-31", apply: true, actorUserId: USER_ID });
    assert.equal(again.posted, 0);
    assert.equal(again.existing, 15);
    assert.equal(again.balanced, true);
    const outside = await projection.replayAccountingProjection({ organizationId: ORG_ID, from: "2031-04-01", to: "2031-04-30", apply: false, kinds: ["invoice"] });
    assert.equal(outside.scanned, 0);
  });

  // ── Reports by fecha contable ───────────────────────────────────────────────

  it("sumas y saldos = 0, balance cuadrado, PyG y mayor con cuadres literales (marzo 2031, ambos extremos incluidos)", async () => {
    const trial = await buildTrialBalance({ context: context as never, asOf: "2031-03-31" });
    assert.equal(trial.balanced, true);
    assert.equal(trial.totals.debit, trial.totals.credit);
    const byCode = new Map(trial.rows.map((r) => [r.accountCode, r]));
    assert.equal(byCode.get("4300")?.balance, 205.5);
    assert.equal(byCode.get("570")?.balance, 133.1);
    assert.equal(byCode.get("5721")?.balance, 24.2);
    assert.equal(byCode.get("572")?.balance, 1070.5);
    assert.equal(byCode.get("100")?.balance, 1010);
    assert.equal(byCode.get("705.1")?.balance, 191.83);
    assert.equal(byCode.get("705.2")?.balance, 111.45);
    assert.equal(byCode.get("705.3")?.balance, 74.71);
    assert.equal(byCode.get("4759")?.balance, 3.18);
    assert.equal(byCode.get("477.10")?.balance, 30.64);
    assert.equal(byCode.get("477.21")?.balance, 11.49);
    assert.equal(byCode.get("4300")?.debitBalance, 205.5);
    assert.equal(byCode.get("4300")?.creditBalance, 0);

    // The last day counts: a window ending on the 10th includes the 10th (FAC-2031-000005 and its bank payment).
    const window = await buildTrialBalance({ context: context as never, asOf: "2031-03-31", fromDate: "2031-03-10", toDate: "2031-03-10" });
    assert.equal(window.rows.find((r) => r.accountCode === "705.2")?.creditTotal, 55);
    assert.equal(window.rows.find((r) => r.accountCode === "572")?.debitTotal, 60.5);

    const sheet = await buildBalanceSheet({ context: context as never, asOf: "2031-03-31" });
    assert.equal(sheet.balanced, true);
    assert.equal(sheet.assets.total, 1433.3);
    assert.equal(sheet.equity.retainedEarnings, 377.99);
    assert.equal(sheet.equity.total, 1387.99);
    assert.equal(sheet.liabilities.total, 45.31);
    assert.equal(sheet.totalLiabPlusEquity, 1433.3);

    const pnl = await getProfitAndLoss({ context: context as never, fromDate: "2031-03-01", toDate: "2031-03-31" });
    assert.equal(pnl.revenueTotal, 377.99);
    assert.equal(pnl.expenseTotal, 0);
    assert.equal(pnl.netResult, 377.99);
    assert.equal(pnl.sections[0]?.code, "1");
    assert.equal(pnl.sections[0]?.total, 377.99);
    const oneDay = await getProfitAndLoss({ context: context as never, fromDate: "2031-03-10", toDate: "2031-03-10" });
    assert.equal(oneDay.revenueTotal, 55, "same-day PyG includes the day itself");
  });

  it("mayor de 4300: saldo inicial antes de la ventana, movimientos con saldo acumulado y saldo final", async () => {
    const ledger = await accounting.getAccountLedger({ context: context as never, accountCode: "4300", from: "2031-03-06", to: "2031-03-31" });
    // Through 05/03: FAC-1 121 D, cobro 121 H, FAC-2 215.50 D → 215.50.
    assert.equal(ledger.openingBalance, "215.50");
    assert.equal(ledger.closingBalance, "205.50");
    assert.equal(ledger.movements.length, 11);
    assert.equal(ledger.movements[ledger.movements.length - 1]?.balance, "205.50");
    let running = "215.50";
    for (const movement of ledger.movements) {
      const expected = accounting.money(running).plus(movement.debit).minus(movement.credit).toFixed(2);
      assert.equal(movement.balance, expected);
      running = expected;
    }
    assert.equal(ledger.totals.debit, "232.60");
    assert.equal(ledger.totals.credit, "242.60");
    const full = await accounting.getAccountLedger({ context: context as never, accountCode: "4300", to: "2031-03-31" });
    assert.equal(full.openingBalance, "0.00");
    assert.equal(full.closingBalance, "205.50");
    assert.equal(full.movements.length, 14);
  });

  // ── Fiscal periods, reversal, year-end close ────────────────────────────────

  it("refuses an asiento inside a closed fiscal period; reverseJournalEntry marks and never deletes", async () => {
    const period = await fiscalPeriods.openFiscalPeriod({ context: context as never, periodCode: "2031-04", periodType: "month", startDate: "2031-04-01", endDate: "2031-04-30", correlationId: "corr_ledger_test" });
    await fiscalPeriods.closeFiscalPeriod({ context: context as never, periodId: period.id, correlationId: "corr_ledger_test" });
    await expectCode(
      accounting.postJournalEntry({ organizationId: ORG_ID, propertyId: PROP_ID, entryDate: "2031-04-10", sourceType: "manual", sourceId: "closed-period", description: "cerrado", lines: [{ accountCode: "570", debit: "5.00" }, { accountCode: "705.3", credit: "5.00" }] }),
      "FISCAL_PERIOD_CLOSED"
    );
    const may = await accounting.postJournalEntry({ organizationId: ORG_ID, propertyId: PROP_ID, entryDate: "2031-05-01", sourceType: "manual", sourceId: "may", description: "Venta de mayo", lines: [{ accountCode: "570", debit: "5.00" }, { accountCode: "705.3", credit: "5.00" }] });
    const reversal = await accounting.reverseJournalEntry({ organizationId: ORG_ID, journalEntryId: may.id, reason: "error de prueba", createdBy: USER_ID });
    assert.equal(reversal.created, true);
    assert.equal(reversal.reversalOfId, may.id);
    assert.equal(reversal.entryKind, "reversal");
    assert.deepEqual(triples(reversal), [
      ["570", "0.00", "5.00"],
      ["705.3", "5.00", "0.00"]
    ]);
    const original = await prisma.journalEntry.findUnique({ where: { id: may.id }, select: { status: true, reversedById: true } });
    assert.equal(original?.status, "reversed");
    assert.equal(original?.reversedById, reversal.id);
    const again = await accounting.reverseJournalEntry({ organizationId: ORG_ID, journalEntryId: may.id, reason: "otra vez" });
    assert.equal(again.created, false);
    assert.equal(again.id, reversal.id);
    await expectCode(accounting.reverseJournalEntry({ organizationId: ORG_ID, journalEntryId: reversal.id, reason: "no" }), "JOURNAL_REVERSAL_OF_REVERSAL");
    assert.equal(await prisma.journalEntry.count({ where: { organizationId: ORG_ID, id: may.id } }), 1, "never deleted");
    const pnl = await getProfitAndLoss({ context: context as never, fromDate: "2031-05-01", toDate: "2031-05-31" });
    assert.equal(pnl.netResult, 0, "the reversal nets the original out (both are read)");
  });

  it("cierre del ejercicio: regularización (129 = 377,99), cierre y apertura numerados; reabrir = anulaciones marcadas", async () => {
    const year = await fiscalYears.createFiscalYear({ context: context as never, code: "2031", startDate: "2031-01-01", endDate: "2031-12-31", correlationId: "corr_ledger_test" });
    fiscalYearId = year.id;
    const status = await fiscalYears.getFiscalYearStatus({ context: context as never, id: year.id });
    assert.deepEqual(status.blockingChecks, []);
    assert.equal(status.netResultPreview, 377.99);
    const closed = await fiscalYears.closeFiscalYear({ context: context as never, id: year.id, correlationId: "corr_ledger_test" });
    assert.equal(closed.netResult, 377.99);
    assert.ok(closed.regularizationEntryId);
    const reg = (await accounting.loadJournalEntry(prisma, closed.regularizationEntryId!))!;
    assert.equal(reg.entryKind, "regularization");
    assert.equal(reg.entryDate, "2031-12-31");
    assert.ok(reg.entryNumber);
    assert.deepEqual(triples(reg), [
      ["129", "0.00", "377.99"],
      ["705.1", "191.83", "0.00"],
      ["705.2", "111.45", "0.00"],
      ["705.3", "74.71", "0.00"]
    ]);
    const closing = (await accounting.loadJournalEntry(prisma, closed.closingEntryId))!;
    assert.equal(closing.entryKind, "closing");
    assert.equal(closing.totalDebit, closing.totalCredit);
    assert.equal(closing.lines.find((l) => l.accountCode === "129")?.debit, "377.99");
    const opening = (await accounting.loadJournalEntry(prisma, closed.openingEntryId))!;
    assert.equal(opening.entryKind, "opening");
    assert.equal(opening.entryDate, "2032-01-01");
    assert.equal(opening.fiscalYearId, closed.nextFiscalYearId);
    assert.equal(opening.lines.find((l) => l.accountCode === "129")?.credit, "377.99");
    assert.equal(opening.lines.find((l) => l.accountCode === "572")?.debit, "1070.50");

    // After the close, the 31/12 balance shows 129 with the result and no pending P&L; sumas y saldos still balance.
    const sheet = await buildBalanceSheet({ context: context as never, asOf: "2031-12-31" });
    assert.equal(sheet.balanced, true);
    assert.equal(sheet.equity.retainedEarnings, 0);
    assert.equal(sheet.equity.items.find((i) => i.accountCode === "129")?.amount, 377.99);
    assert.equal((await buildTrialBalance({ context: context as never, asOf: "2031-12-31" })).balanced, true);
    const nextYearSheet = await buildBalanceSheet({ context: context as never, asOf: "2032-01-01" });
    assert.equal(nextYearSheet.assets.total, 1433.3, "opening reinstates the balances in the next year");

    // t6#3: a CLOSED year refuses any asiento dated inside it (no FiscalPeriod needed), drafts included; the next year stays open.
    const closedYearEntry = { organizationId: ORG_ID, propertyId: PROP_ID, entryDate: "2031-11-15", sourceType: "manual", sourceId: "closed-year", description: "asiento en ejercicio cerrado", lines: [{ accountCode: "629", debit: "1.00" }, { accountCode: "570", credit: "1.00" }] };
    await expectCode(accounting.postJournalEntry(closedYearEntry), "FISCAL_YEAR_CLOSED");
    await expectCode(accounting.createJournalEntryDraft({ organizationId: ORG_ID, propertyId: PROP_ID, sourceType: "manual", entryDate: "2031-11-15", description: "borrador en ejercicio cerrado", lines: [{ accountCode: "629", debit: 1, credit: 0 }, { accountCode: "570", debit: 0, credit: 1 }] }), "FISCAL_YEAR_CLOSED");
    await expectCode(accounting.reverseJournalEntry({ organizationId: ORG_ID, journalEntryId: capitalEntryId, reason: "no: el ejercicio está cerrado" }), "FISCAL_YEAR_CLOSED");
    assert.equal(await prisma.journalEntry.count({ where: { organizationId: ORG_ID, entryDate: accounting.dateOnlyUtc("2031-11-15") } }), 0, "nothing written into the closed year");
    const nextYearEntry = await accounting.postJournalEntry({ ...closedYearEntry, entryDate: "2032-02-01", sourceId: "next-year-open", lines: [{ accountCode: "572", debit: "1.00" }, { accountCode: "570", credit: "1.00" }] });
    assert.equal(nextYearEntry.created, true);
    assert.equal(nextYearEntry.fiscalYearCode, "2032");

    const reopened = await fiscalYears.reopenFiscalYear({ context: context as never, id: year.id, reason: "ajuste de auditoría", correlationId: "corr_ledger_test" });
    assert.equal(reopened.status, "open");
    for (const id of [closed.regularizationEntryId!, closed.closingEntryId, closed.openingEntryId]) {
      const row = await prisma.journalEntry.findUnique({ where: { id }, select: { status: true, reversedById: true } });
      assert.equal(row?.status, "reversed", "close entries are reversed, never deleted");
      assert.ok(row?.reversedById);
    }
    const reversals = await prisma.journalEntry.count({ where: { organizationId: ORG_ID, sourceId: { startsWith: `year-reopen:${year.id}:` } } });
    assert.equal(reversals, 3);
    const afterReopen = await buildBalanceSheet({ context: context as never, asOf: "2031-12-31" });
    assert.equal(afterReopen.equity.retainedEarnings, 377.99, "the reopened year shows its P&L again");
    assert.equal(afterReopen.balanced, true);
    // Reopened → the year accepts asientos again (a treasury transfer keeps every literal cuadre above).
    const reopenedEntry = await accounting.postJournalEntry({ ...closedYearEntry, sourceId: "reopened-year", lines: [{ accountCode: "572", debit: "1.00" }, { accountCode: "570", credit: "1.00" }] });
    assert.equal(reopenedEntry.created, true);
    assert.equal(reopenedEntry.fiscalYearCode, "2031");
  });

  // ── fix:ledger (2026-09-16): TPV al contado, reversal rows, bounded mayor ───

  it("venta TPV con factura simplificada: la proyección de InvoiceIssued y el replay encuentran el asiento pos_ticket y no lo duplican (t6#1)", async () => {
    const snapshotLines = [{ folioLineId: null, description: "Menú", quantity: 1, unitPrice: 12, total: 12, taxCode: "ES_IVA_10", taxRate: 10, taxCategory: "food_beverage", taxCalificacion: "S1", taxFigure: "IVA", base: 10.91, quota: 1.09, revenueAccountCode: "705.2" }];
    const breakdown = [{ figure: "IVA", impuesto: "01", calificacion: "S1", ratePercent: 10, base: 10.91, quota: 1.09 }];
    const snapshot = (paidWith: string, posOrderId: string | null) => ({ version: 1, status: "issued", issuedAt: "2032-02-10T13:00:00.000Z", currencyCode: "EUR", lines: snapshotLines, totals: { total: 12, taxTotal: 1.09, baseTotal: 10.91 }, taxBreakdown: breakdown, folioLineIds: [], issuer: { taxId: "B12345674", legalName: "Ledger Test SL" }, customer: { type: "guest", taxId: null, name: null }, paidWith, posOrderId });
    const ticket = await prisma.posOrder.create({ data: { propertyId: PROP_ID, outletId: "out_restaurant", status: "closed", settlement: "cash", total: "12.00", taxTotal: "1.09", closedAt: new Date("2032-02-10T13:00:00.000Z"), businessDate: new Date("2032-02-10T00:00:00.000Z") }, select: { id: true } });
    const simInvoice = await prisma.invoice.create({
      data: { propertyId: PROP_ID, invoiceNumber: "SIM-2032-000001", invoiceType: "F2", customerType: "guest", status: "issued", issuedAt: new Date("2032-02-10T13:00:00.000Z"), total: "12.00", taxTotal: "1.09", taxBreakdownJson: breakdown as never, snapshotJson: snapshot("cash", ticket.id) as never, seriesCode: "SIM", simplified: true, customerRequired: false },
      select: { id: true }
    });
    await prisma.invoiceLine.create({ data: { invoiceId: simInvoice.id, description: "Menú", quantity: 1, unitPrice: "12.00", taxCode: "ES_IVA_10", taxRate: 10, total: "12.00", taxCategory: "food_beverage", taxCalificacion: "S1", taxFigure: "IVA" } });
    await prisma.posOrder.update({ where: { id: ticket.id }, data: { invoiceId: simInvoice.id } });

    // The TPV port posts D 570 / H 705.2 / H 477.10 synchronously under pos_ticket/<ticket>.
    const sync = await projection.postPosTicket({ orderId: ticket.id, actorUserId: USER_ID });
    assert.equal(sync.outcome, "posted");
    const before = await prisma.journalEntry.count({ where: { organizationId: ORG_ID } });

    // Four seconds later the projection materialises InvoiceIssued: same document, same key, nothing new.
    const envelope = { eventId: "evt_ledgertest_sim", organizationId: ORG_ID, propertyId: PROP_ID, entityType: "invoice", entityId: simInvoice.id, eventType: "InvoiceIssued", payload: { invoiceNumber: "SIM-2032-000001", simplified: true, posOrderId: ticket.id }, actorType: "user" as const, actorUserId: USER_ID, correlationId: "corr_ledger_test", hashAlgorithm: "sha256" as const, currentHash: "x", createdAt: new Date().toISOString() };
    const projected = await projection.projectEvent(envelope);
    assert.equal(projected.outcome, "existing");
    assert.deepEqual(projected.journalEntryIds, sync.journalEntryIds, "the projection returns the synchronous pos_ticket entry");
    assert.equal(await prisma.journalEntry.count({ where: { organizationId: ORG_ID } }), before, "no second asiento");
    assert.equal(await prisma.journalEntry.count({ where: { organizationId: ORG_ID, sourceType: "invoice", sourceId: simInvoice.id } }), 0, "never an invoice/4300 entry for a cash sale");
    const feb = await buildTrialBalance({ context: context as never, asOf: "2032-02-28", fromDate: "2032-02-01", toDate: "2032-02-28" });
    assert.equal(feb.rows.find((r) => r.accountCode === "705.2")?.creditTotal, 10.91, "revenue once");
    assert.equal(feb.rows.find((r) => r.accountCode === "477.10")?.creditTotal, 1.09, "VAT once");
    assert.equal(feb.rows.find((r) => r.accountCode === "4300"), undefined, "no receivable movement for a sale settled in the act");

    // Walk-in simplified invoice (no ticket): the projection posts ONE pos_ticket/<invoiceId> entry against the datáfono, idempotently.
    const walkIn = await prisma.invoice.create({
      data: { propertyId: PROP_ID, invoiceNumber: "SIM-2032-000002", invoiceType: "F2", customerType: "guest", status: "issued", issuedAt: new Date("2032-02-11T10:00:00.000Z"), total: "12.00", taxTotal: "1.09", taxBreakdownJson: breakdown as never, snapshotJson: snapshot("card_terminal", null) as never, seriesCode: "SIM", simplified: true, customerRequired: false },
      select: { id: true }
    });
    await prisma.invoiceLine.create({ data: { invoiceId: walkIn.id, description: "Menú", quantity: 1, unitPrice: "12.00", taxCode: "ES_IVA_10", taxRate: 10, total: "12.00", taxCategory: "food_beverage", taxCalificacion: "S1", taxFigure: "IVA" } });
    const first = await projection.projectEvent({ ...envelope, eventId: "evt_ledgertest_walkin", entityId: walkIn.id, payload: { invoiceNumber: "SIM-2032-000002", simplified: true, posOrderId: null } });
    assert.equal(first.outcome, "posted");
    const walkInEntry = (await accounting.loadJournalEntry(prisma, first.journalEntryIds[0]!))!;
    assert.equal(walkInEntry.sourceType, "pos_ticket");
    assert.equal(walkInEntry.sourceId, walkIn.id);
    assert.equal(walkInEntry.entryDate, "2032-02-11");
    assert.deepEqual(triples(walkInEntry), [
      ["477.10", "0.00", "1.09"],
      ["5721", "12.00", "0.00"],
      ["705.2", "0.00", "10.91"]
    ]);
    const second = await projection.projectEvent({ ...envelope, eventId: "evt_ledgertest_walkin_2", entityId: walkIn.id, payload: { invoiceNumber: "SIM-2032-000002", simplified: true, posOrderId: null } });
    assert.equal(second.outcome, "existing");
    assert.deepEqual(second.journalEntryIds, first.journalEntryIds);

    // Replay of February: the ticket sale is ONE pos candidate (never an invoice candidate too); the walk-in is keyed by its invoice id; nothing would be posted.
    const dry = await projection.replayAccountingProjection({ organizationId: ORG_ID, from: "2032-02-01", to: "2032-02-28", apply: false, kinds: ["invoice", "pos"] });
    assert.equal(dry.wouldPost, 0);
    assert.equal(dry.failed, 0);
    assert.deepEqual(dry.items.filter((i) => i.sourceId === ticket.id).map((i) => `${i.kind}:${i.sourceType}:${i.status}`), ["pos:pos_ticket:exists"]);
    assert.deepEqual(dry.items.filter((i) => i.sourceId === walkIn.id).map((i) => `${i.kind}:${i.sourceType}:${i.status}`), ["invoice:pos_ticket:exists"]);
    assert.ok(!dry.items.some((i) => i.sourceId === simInvoice.id), "the ticket invoice is not listed twice");

    // Cancelling the walk-in reverses the cash-sale entry (treasury back, never 4300).
    await prisma.invoice.update({ where: { id: walkIn.id }, data: { status: "cancelled", cancelledAt: new Date("2032-02-12T09:00:00.000Z") } });
    const cancelled = await projection.postInvoiceCancellation({ invoiceId: walkIn.id, reason: "ticket anulado" });
    assert.equal(cancelled.outcome, "posted");
    const cancelEntry = (await accounting.loadJournalEntry(prisma, cancelled.journalEntryIds[0]!))!;
    assert.equal(cancelEntry.reversalOfId, walkInEntry.id);
    assert.deepEqual(triples(cancelEntry), [
      ["477.10", "1.09", "0.00"],
      ["5721", "0.00", "12.00"],
      ["705.2", "10.91", "0.00"]
    ]);
  });

  it("filas de reverso de Payment (reversalOfId): ni cobro ni «devolución sin registro»; el replay no las lista (t6#7)", async () => {
    const original = await prisma.payment.create({ data: { propertyId: PROP_ID, folioId, amount: "100.00", method: "cash", methodCode: "cash", status: "captured", createdAt: new Date("2032-02-15T12:00:00.000Z") }, select: { id: true } });
    const capture = await projection.postPaymentCapture({ paymentId: original.id });
    assert.equal(capture.outcome, "posted");
    // The payments lot: PaymentRefund row + reversal Payment row (positive amount, status refunded), original flipped to refunded, entry keyed by the refund row.
    const refund = await prisma.paymentRefund.create({ data: { paymentId: original.id, amount: "100.00", status: "completed", requiresApproval: false, createdAt: new Date("2032-02-16T12:00:00.000Z") }, select: { id: true } });
    const reversalRow = await prisma.payment.create({ data: { propertyId: PROP_ID, folioId, amount: "100.00", method: "cash", methodCode: "cash", status: "refunded", reversalOfId: original.id, createdAt: new Date("2032-02-16T12:00:00.000Z") }, select: { id: true } });
    await prisma.payment.update({ where: { id: original.id }, data: { status: "refunded" } });
    const refundEntry = await projection.postPaymentRefund({ paymentId: original.id, refundId: refund.id });
    assert.equal(refundEntry.outcome, "posted");
    const before = await prisma.journalEntry.count({ where: { organizationId: ORG_ID } });

    assert.equal((await projection.postPaymentCapture({ paymentId: reversalRow.id })).outcome, "ignored", "a reversal row is not money received");
    assert.equal((await projection.postPaymentRefund({ paymentId: reversalRow.id, refundId: null })).outcome, "ignored", "a reversal row is not a flipped legacy refund");
    assert.equal((await projection.postPaymentRefund({ paymentId: original.id, refundId: null })).outcome, "ignored", "fully covered by its refund row: no remainder");
    assert.equal(await prisma.journalEntry.count({ where: { organizationId: ORG_ID } }), before);

    const dry = await projection.replayAccountingProjection({ organizationId: ORG_ID, from: "2032-02-01", to: "2032-02-28", apply: false, kinds: ["payment"] });
    assert.equal(dry.scanned, 2, "capture + refund: the reversal row is not a candidate");
    assert.equal(dry.wouldPost, 0);
    assert.equal(dry.existing, 2);
    assert.ok(!dry.items.some((i) => i.sourceId === reversalRow.id || i.sourceId === `${reversalRow.id}:refund`), "no spurious pair for the reversal row");
    const applied = await projection.replayAccountingProjection({ organizationId: ORG_ID, from: "2032-02-01", to: "2032-02-28", apply: true, kinds: ["payment"], actorUserId: USER_ID });
    assert.equal(applied.posted, 0, "first apply posts nothing: the pair already exists");
    assert.equal(await prisma.journalEntry.count({ where: { organizationId: ORG_ID } }), before);
  });

  it("mayor acotado en SQL: el detalle se corta en el tope pero totales y saldo final cubren toda la ventana (t6#13)", async () => {
    const full = await accounting.getAccountLedger({ context: context as never, accountCode: "4300", from: "2031-03-01", to: "2032-12-31" });
    assert.equal(full.truncated, false);
    assert.ok(full.movements.length >= 16, `expected the whole history of 4300, got ${full.movements.length}`);
    assert.equal(full.movements[full.movements.length - 1]?.balance, full.closingBalance, "untruncated: last running balance = closing balance");
    assert.equal(accounting.money(full.openingBalance).plus(full.totals.debit).minus(full.totals.credit).toFixed(2), full.closingBalance);
    const dates = full.movements.map((m) => m.entryDate);
    assert.deepEqual(dates, [...dates].sort(), "ordered by fecha contable");

    const capped = await accounting.getAccountLedger({ context: context as never, accountCode: "4300", from: "2031-03-01", to: "2032-12-31", maxMovements: 3 });
    assert.equal(capped.truncated, true);
    assert.equal(capped.movements.length, 3);
    assert.deepEqual(capped.movements, full.movements.slice(0, 3), "the cap keeps the oldest movements in order");
    assert.deepEqual(capped.totals, full.totals, "totals are SQL sums over the whole window, not over the shown detail");
    assert.equal(capped.closingBalance, full.closingBalance);
    assert.equal(capped.openingBalance, full.openingBalance);
    assert.notEqual(capped.movements[2]?.balance, capped.closingBalance, "the last shown running balance is not the closing one when truncated");

    // Property filter and a window with no movement.
    const scoped = await accounting.getAccountLedger({ context: context as never, accountCode: "4300", from: "2032-02-01", to: "2032-02-28", propertyId: PROP_ID });
    assert.equal(scoped.movements.length, 2, "capture and refund of February on the property");
    assert.equal(scoped.totals.debit, "100.00");
    assert.equal(scoped.totals.credit, "100.00");
    const empty = await accounting.getAccountLedger({ context: context as never, accountCode: "4300", from: "2032-06-01", to: "2032-06-30" });
    assert.deepEqual(empty.movements, []);
    assert.equal(empty.openingBalance, empty.closingBalance);
  });

  it("saneamiento 430 → 4300: plan en solo lectura, bloqueo con ejercicio cerrado, traslado auditado e idempotente (t6#4)", async () => {
    // A legacy-style asiento on the 3-digit header, in a year of its own so the block can be exercised.
    const year2033 = await fiscalYears.createFiscalYear({ context: context as never, code: "2033", startDate: "2033-01-01", endDate: "2033-12-31", correlationId: "corr_ledger_test" });
    const legacy = await accounting.postJournalEntry({ organizationId: ORG_ID, propertyId: PROP_ID, entryDate: "2033-03-01", sourceType: "manual", sourceId: "legacy-430", description: "Factura heredada en 430", lines: [{ accountCode: "430", debit: "121.00" }, { accountCode: "705.1", credit: "121.00" }] });
    const legacyPayment = await accounting.postJournalEntry({ organizationId: ORG_ID, propertyId: PROP_ID, entryDate: "2033-03-02", sourceType: "manual", sourceId: "legacy-430-cobro", description: "Cobro heredado en 430", lines: [{ accountCode: "570", debit: "21.00" }, { accountCode: "430", credit: "21.00" }] });
    const before4300 = await accounting.getAccountLedger({ context: context as never, accountCode: "4300", to: "2033-12-31" });

    const plan = await relabel.planCustomerAccountRelabel(ORG_ID);
    assert.equal(plan.fromCode, "430");
    assert.equal(plan.toCode, "4300");
    assert.equal(plan.lines, 2);
    assert.equal(plan.entries, 2);
    assert.equal(plan.debit, "121.00");
    assert.equal(plan.credit, "21.00");
    assert.deepEqual(plan.bySourceType, [{ sourceType: "manual", entries: 2, lines: 2, debit: "121.00", credit: "21.00" }]);
    assert.deepEqual(plan.blocking, []);
    assert.equal(await prisma.journalLine.count({ where: { accountCode: "430", journalEntryId: { in: [legacy.id, legacyPayment.id] } } }), 2, "a plan writes nothing");

    // Closed year → blocked (nothing moves), reopened → applied.
    await prisma.fiscalYear.update({ where: { id: year2033.id }, data: { status: "closed" } });
    const blocked = await relabel.planCustomerAccountRelabel(ORG_ID);
    assert.equal(blocked.closedYearEntries, 2);
    assert.deepEqual(blocked.blocking, ["CLOSED_FISCAL_YEAR_ENTRIES"]);
    await expectCode(relabel.applyCustomerAccountRelabel(ORG_ID, { actorUserId: USER_ID, correlationId: "corr_ledger_test" }), "CUSTOMER_RELABEL_BLOCKED");
    assert.equal(await prisma.journalLine.count({ where: { accountCode: "430", journalEntryId: { in: [legacy.id, legacyPayment.id] } } }), 2, "blocked: nothing moved");
    await prisma.fiscalYear.update({ where: { id: year2033.id }, data: { status: "open" } });

    const applied = await relabel.applyCustomerAccountRelabel(ORG_ID, { actorUserId: USER_ID, correlationId: "corr_ledger_test" });
    assert.equal(applied.applied, true);
    assert.equal(applied.updated, 2);
    assert.equal(await prisma.journalLine.count({ where: { accountCode: "430", journalEntryId: { in: [legacy.id, legacyPayment.id] } } }), 0);
    const moved = (await accounting.loadJournalEntry(prisma, legacy.id))!;
    assert.deepEqual(triples(moved), [
      ["4300", "121.00", "0.00"],
      ["705.1", "0.00", "121.00"]
    ]);
    assert.equal(moved.entryNumber, legacy.entryNumber, "same asiento, same number, same date: a relabel, not a new entry");
    assert.equal(moved.entryDate, "2033-03-01");
    const after4300 = await accounting.getAccountLedger({ context: context as never, accountCode: "4300", to: "2033-12-31" });
    assert.equal(accounting.money(after4300.closingBalance).minus(before4300.closingBalance).toFixed(2), "100.00", "4300 gained exactly the 430 balance (121 − 21)");
    assert.equal(applied.targetBalanceAfter, after4300.closingBalance);
    const trial = await buildTrialBalance({ context: context as never, asOf: "2033-12-31" });
    assert.equal(trial.balanced, true);
    assert.equal(trial.rows.find((r) => r.accountCode === "430"), undefined, "430 has no direct movement left");

    const again = await relabel.applyCustomerAccountRelabel(ORG_ID, { actorUserId: USER_ID, correlationId: "corr_ledger_test" });
    assert.equal(again.applied, false);
    assert.equal(again.updated, 0);
    assert.equal((await relabel.planCustomerAccountRelabel(ORG_ID)).lines, 0, "idempotent");
  });

  // ── HTTP surface on the demo organisation ───────────────────────────────────

  it("GET /accounting/chart and /accounting/settings answer for org_123", async (t) => {
    const app = httpApp(t);
    if (!app) return;
    const chart = await app.inject({ method: "GET", url: url("/accounting/chart"), headers });
    assert.equal(chart.statusCode, 200, chart.body);
    const body = JSON.parse(chart.body) as { organizationId: string; chartTemplate: string; accounts: Array<{ code: string; isPostable: boolean; parentCode: string | null; level: number }> };
    assert.equal(body.organizationId, DEMO_ORG);
    assert.equal(body.chartTemplate, "pgc_pymes_hotelero_v1");
    assert.ok(body.accounts.length >= 239);
    assert.equal(body.accounts.find((a) => a.code === "4")?.isPostable, false);
    assert.equal(body.accounts.find((a) => a.code === "477.10")?.parentCode, "477");
    const postable = await app.inject({ method: "GET", url: url("/accounting/chart?postableOnly=1"), headers });
    assert.ok((JSON.parse(postable.body) as { accounts: unknown[] }).accounts.length < body.accounts.length);
    const settings = await app.inject({ method: "GET", url: url("/accounting/settings"), headers });
    assert.equal(settings.statusCode, 200, settings.body);
    const view = JSON.parse(settings.body) as { chartProvisioned: boolean; vat: { periodicity: string; persisted: boolean } };
    assert.equal(view.chartProvisioned, true);
    assert.equal(view.vat.periodicity, "quarterly");
    const bad = await app.inject({ method: "GET", url: url("/accounting/chart?bogus=1"), headers });
    assert.equal(bad.statusCode, 400);
  });

  it("POST /accounting/journal (manual) → diario, asiento, reversal, mayor, CSV; validation answers 400 in Spanish", async (t) => {
    const app = httpApp(t);
    if (!app) return;
    if (!headers.authorization) return t.skip("no demo session: high-risk routes need a real login");
    const payload = { entryDate: HTTP_DAY, description: `${MARK} traspaso de caja a banco`, reference: "TEST-1", propertyId: DEMO_PROP, lines: [{ accountCode: "572", debit: "10.00" }, { accountCode: "570", credit: 10 }] };
    const created = await app.inject({ method: "POST", url: url("/accounting/journal"), headers, payload });
    assert.equal(created.statusCode, 201, created.body);
    const entry = JSON.parse(created.body) as { id: string; entryNumber: number; fiscalYearCode: string; status: string; lines: Array<{ accountCode: string; debit: string; credit: string }> };
    demoEntryIds.add(entry.id);
    assert.equal(entry.fiscalYearCode, "2031");
    assert.ok(entry.entryNumber >= 1);
    assert.equal(entry.status, "posted");

    const list = await app.inject({ method: "GET", url: url(`/accounting/journal?from=${HTTP_DAY}&to=${HTTP_DAY}&envelope=1`), headers });
    assert.equal(list.statusCode, 200, list.body);
    const page = JSON.parse(list.body) as { items: Array<{ id: string }>; total: number; nextCursor: string | null };
    assert.ok(page.items.some((i) => i.id === entry.id));
    assert.equal(list.headers["x-total-count"], String(page.total));
    const bare = await app.inject({ method: "GET", url: url(`/accounting/journal?from=${HTTP_DAY}&to=${HTTP_DAY}&accountCode=572`), headers });
    assert.ok(Array.isArray(JSON.parse(bare.body)));

    const one = await app.inject({ method: "GET", url: url(`/accounting/journal/${entry.id}`), headers });
    assert.equal(one.statusCode, 200);
    assert.equal((JSON.parse(one.body) as { reference: string }).reference, "TEST-1");
    const missing = await app.inject({ method: "GET", url: url("/accounting/journal/je_nope"), headers });
    assert.equal(missing.statusCode, 404);

    const reversed = await app.inject({ method: "POST", url: url(`/accounting/journal/${entry.id}/reverse`), headers, payload: { reason: `${MARK} error` } });
    assert.equal(reversed.statusCode, 201, reversed.body);
    const reversal = JSON.parse(reversed.body) as { id: string; reversalOfId: string; entryKind: string; lines: Array<{ accountCode: string; debit: string; credit: string }> };
    demoEntryIds.add(reversal.id);
    assert.equal(reversal.reversalOfId, entry.id);
    assert.equal(reversal.entryKind, "reversal");
    assert.deepEqual(triples(reversal), [
      ["570", "10.00", "0.00"],
      ["572", "0.00", "10.00"]
    ]);
    const twice = await app.inject({ method: "POST", url: url(`/accounting/journal/${reversal.id}/reverse`), headers, payload: { reason: "no" } });
    assert.equal(twice.statusCode, 409);
    assert.equal((JSON.parse(twice.body) as ErrorBody).details?.code, "JOURNAL_REVERSAL_OF_REVERSAL");

    const ledger = await app.inject({ method: "GET", url: url(`/accounting/ledger/572?from=${HTTP_DAY}&to=${HTTP_DAY}`), headers });
    assert.equal(ledger.statusCode, 200, ledger.body);
    const mayor = JSON.parse(ledger.body) as { accountCode: string; movements: Array<{ balance: string }>; closingBalance: string; totals: { debit: string; credit: string } };
    assert.equal(mayor.accountCode, "572");
    assert.equal(mayor.movements.length, 2);
    assert.equal(mayor.totals.debit, "10.00");
    assert.equal(mayor.totals.credit, "10.00");
    const dotted = await app.inject({ method: "GET", url: url(`/accounting/ledger/705.1?from=${HTTP_DAY}&to=${HTTP_DAY}`), headers });
    assert.equal(dotted.statusCode, 200, "dotted sub-account codes are valid path params");
    assert.equal((JSON.parse(dotted.body) as { accountCode: string }).accountCode, "705.1");

    const csv = await app.inject({ method: "GET", url: url(`/accounting/journal/export?from=${HTTP_DAY}&to=${HTTP_DAY}`), headers });
    assert.equal(csv.statusCode, 200);
    assert.match(String(csv.headers["content-type"]), /text\/csv/);
    assert.ok(csv.body.startsWith("﻿fecha;asiento;cuenta;concepto;debe;haber;documento;nif;base;iva"));
    assert.match(csv.body, /;572;.*;10,00;0,00;TEST-1/);
    const ledgerCsv = await app.inject({ method: "GET", url: url(`/accounting/ledger/572?from=${HTTP_DAY}&to=${HTTP_DAY}&format=csv`), headers });
    assert.match(String(ledgerCsv.headers["content-type"]), /text\/csv/);
    assert.match(ledgerCsv.body, /Saldo final/);

    const unbalanced = await app.inject({ method: "POST", url: url("/accounting/journal"), headers, payload: { ...payload, lines: [{ accountCode: "572", debit: "10.00" }, { accountCode: "570", credit: "9.00" }] } });
    assert.equal(unbalanced.statusCode, 400);
    assert.equal((JSON.parse(unbalanced.body) as ErrorBody).details?.code, "JOURNAL_UNBALANCED");
    const unknownField = await app.inject({ method: "POST", url: url("/accounting/journal"), headers, payload: { ...payload, foo: 1 } });
    assert.equal(unknownField.statusCode, 400);
    assert.match((JSON.parse(unknownField.body) as ErrorBody).message, /no admitido/);
    const badDate = await app.inject({ method: "POST", url: url("/accounting/journal"), headers, payload: { ...payload, entryDate: "15/06/2031" } });
    assert.equal(badDate.statusCode, 400);
    const noAccount = await app.inject({ method: "POST", url: url("/accounting/journal"), headers, payload: { ...payload, lines: [{ accountCode: "999999", debit: "10.00" }, { accountCode: "570", credit: "10.00" }] } });
    assert.equal(noAccount.statusCode, 409);
    assert.equal((JSON.parse(noAccount.body) as ErrorBody).details?.code, "ACCOUNT_NOT_FOUND");
  });

  it("POST/PATCH /accounting/chart manage sub-accounts (dotted codes) and refuse duplicates", async (t) => {
    const app = httpApp(t);
    if (!app) return;
    if (!headers.authorization) return t.skip("no demo session: high-risk routes need a real login");
    const created = await app.inject({ method: "POST", url: url("/accounting/chart"), headers, payload: { code: TEST_ACCOUNT_CODE, name: `${MARK} Prestaciones de servicios: test` } });
    assert.equal(created.statusCode, 201, created.body);
    const account = JSON.parse(created.body) as { code: string; kind: string; parentCode: string | null; isPostable: boolean; level: number };
    assert.equal(account.kind, "income", "inherited from the parent 705");
    assert.equal(account.parentCode, "705");
    assert.equal(account.isPostable, true);
    assert.equal(account.level, 4);
    const duplicate = await app.inject({ method: "POST", url: url("/accounting/chart"), headers, payload: { code: TEST_ACCOUNT_CODE, name: "otra" } });
    assert.equal(duplicate.statusCode, 409);
    assert.equal((JSON.parse(duplicate.body) as ErrorBody).details?.code, "ACCOUNT_CODE_EXISTS");
    const orphan = await app.inject({ method: "POST", url: url("/accounting/chart"), headers, payload: { code: "9999", name: "sin padre" } });
    assert.equal(orphan.statusCode, 400);
    assert.equal((JSON.parse(orphan.body) as ErrorBody).details?.code, "ACCOUNT_KIND_REQUIRED");
    const patched = await app.inject({ method: "PATCH", url: url(`/accounting/chart/${TEST_ACCOUNT_CODE}`), headers, payload: { name: `${MARK} renombrada`, usaliDepartment: "other_operated", usaliLine: "revenue" } });
    assert.equal(patched.statusCode, 200, patched.body);
    assert.equal((JSON.parse(patched.body) as { usaliDepartment: string }).usaliDepartment, "other_operated");
    const badUsali = await app.inject({ method: "PATCH", url: url(`/accounting/chart/${TEST_ACCOUNT_CODE}`), headers, payload: { usaliDepartment: "rooms", usaliLine: "cost_of_sales" } });
    assert.equal(badUsali.statusCode, 400);
    assert.equal((JSON.parse(badUsali.body) as ErrorBody).details?.code, "USALI_LINE_INVALID");
    const settings = await app.inject({ method: "PATCH", url: url("/accounting/settings"), headers, payload: { vatPeriodicity: "quarterly" } });
    assert.equal(settings.statusCode, 200, settings.body);
    assert.equal((JSON.parse(settings.body) as { vat: { persisted: boolean } }).vat.persisted, true);
  });

  it("POST /accounting/replay dry-run on org_123 and GET /accounting/projection/status", async (t) => {
    const app = httpApp(t);
    if (!app) return;
    if (!headers.authorization) return t.skip("no demo session: high-risk routes need a real login");
    const replay = await app.inject({ method: "POST", url: url("/accounting/replay"), headers, payload: { from: HTTP_DAY, to: HTTP_DAY } });
    assert.equal(replay.statusCode, 200, replay.body);
    const report = JSON.parse(replay.body) as { organizationId: string; apply: boolean; scanned: number; balanced: null };
    assert.equal(report.organizationId, DEMO_ORG);
    assert.equal(report.apply, false);
    assert.equal(report.scanned, 0);
    assert.equal(report.balanced, null);
    const foreign = await app.inject({ method: "POST", url: url("/accounting/replay"), headers, payload: { organizationId: ORG_ID, from: HTTP_DAY, to: HTTP_DAY } });
    assert.ok([200, 404].includes(foreign.statusCode), "another organisation: 404 unless the session is a platform admin");
    const badWindow = await app.inject({ method: "POST", url: url("/accounting/replay"), headers, payload: { from: HTTP_DAY, to: "2031-06-01" } });
    assert.equal(badWindow.statusCode, 409);
    assert.equal((JSON.parse(badWindow.body) as ErrorBody).details?.code, "REPLAY_WINDOW_INVALID");
    const status = await app.inject({ method: "GET", url: url("/accounting/projection/status"), headers });
    assert.equal(status.statusCode, 200);
    const view = JSON.parse(status.body) as { queued: number; failed: number; recentFailures: unknown[] };
    assert.equal(typeof view.queued, "number");
    assert.ok(Array.isArray(view.recentFailures));
  });
});
