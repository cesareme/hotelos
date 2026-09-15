/**
 * Payables & fixed assets · integration (REAL HTTP via app.inject, Postgres required).
 *
 * Exercises the payables and fixed-assets modules end to end on the demo
 * property (prop_123 / org_123, never Faranda):
 *   · supplier: invalid NIF → 400, valid professional (DNI, 15 % IRPF, IBAN)
 *     → 201, duplicate NIF → 409, invalid IBAN → 400;
 *   · supplier bill 1.000 € at 21 % with 15 % retention: draft totals
 *     (1000.00 / 210.00 / 150.00 / 1060.00), duplicate → 409, printed total
 *     mismatch → 400, post from draft → 409, approve → post: accrual entry
 *     D 623 1000.00 / D 472.21 210.00 (taxBase 1000.00) / H 4751 150.00 /
 *     H 410 1060.00 (1210.00 = 1210.00), numbered in "2026", libro de
 *     recibidas row (base 1000, quota 210, retention 150, period 2026-Q3),
 *     WithholdingTaxRecord 150.00 row 02, idempotent re-post; aging shows
 *     1060.00 outstanding; pay → D 410 1060.00 / H 572 1060.00, aging 0.00,
 *     cancel of a paid bill → 409, second pay idempotent;
 *   · cancel of a posted bill: reversal entry (lines swapped), original
 *     `reversed`, book rows and withholding removed;
 *   · expense: ticket 10 € + 21 % without NIF → D 629 12.10 / H 570 12.10,
 *     book row non-deductible, reverse → inverse entry; deductible without
 *     NIF → 400;
 *   · fixed asset 12.000 € mobiliario (2019-01-01): coefficient 10 %, accounts
 *     216/2816/681, monthly 100.00; coefficient 15 → 400; 12 depreciation runs
 *     2019-01..12 → 100.00 each, accumulated 1.200,00; re-post of a posted
 *     period → alreadyPosted; a run with unposted months in between (2020-03
 *     after 2019-12) → 409 PREVIOUS_PERIOD_MISSING [2020-01, 2020-02] and the
 *     preview lists them (t6#12); out-of-order reversal → 409; reverse
 *     2019-12 → accumulated 1.100,00 and 2020-01 → 409 pending [2019-12];
 *     disposal with a 5.000 € sale → D 2816 1100 / D 671 5900 / D 572 5000 /
 *     H 216 12000.
 *
 * Everything the suite writes is removed in `after` (journal lines/entries of
 * every document, VAT book rows, withholding records, bills + lines, expenses,
 * depreciation runs + lines, fixed assets, suppliers). Leftover 2019 runs of
 * org_123 from a crashed run are removed in `before`.
 *
 * Run from the repo root:
 *   cd apps/api && node --import tsx --test "../../tests/integration/payables-assets.test.mts"
 *
 * Mounting: until the integrator wires `registerPayablesRoutes(app)` and
 * `registerFixedAssetsRoutes(app)` in server.ts, the routes are mounted under
 * test prefixes (with their manifest entries pushed for the RBAC hook).
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
const { registerPayablesRoutes } = await import("../../apps/api/src/modules/payables/payables.routes.js");
const { payablesRoutePermissions } = await import("../../apps/api/src/modules/payables/route-permissions.partial.js");
const { registerFixedAssetsRoutes } = await import("../../apps/api/src/modules/fixed-assets/fixed-assets.routes.js");
const { fixedAssetsRoutePermissions } = await import("../../apps/api/src/modules/fixed-assets/route-permissions.partial.js");
const { prisma } = await import("@hotelos/database");

type ApiApp = Awaited<ReturnType<typeof buildApiServer>>;
type Headers = Record<string, string>;
type ErrorBody = { statusCode: number; message: string; details?: { code?: string; [k: string]: unknown } };
type Entry = { id: string; entryNumber: number | null; fiscalYearCode: string | null; entryDate: string; sourceType: string; status: string; reversedById: string | null; reversalOfId: string | null; totalDebit: string; totalCredit: string; lines: Array<{ accountCode: string; debit: string; credit: string; taxRateCode: string | null; taxBase: string | null }> };
type Bill = { id: string; status: string; baseTotal: string; taxTotal: string; retentionAmount: string; retentionRate: string | null; retentionRowCode: string | null; total: string; payableAccountCode: string | null; journalEntryId: string | null; paidJournalEntryId: string | null; lines: Array<{ fixedAssetId: string | null }>; vatRows?: Array<{ book: string; base: string; rate: string; quota: string; total: string; retention: string; period: string; deductible: boolean; counterpartyNif: string | null }>; accrualEntry?: Entry | null; paymentEntry?: Entry | null };
type Expense = { id: string; total: string; vatDeductible: boolean; journalEntryId: string | null; reversalJournalEntryId: string | null; cancelledAt: string | null; entry?: Entry | null; vatRows?: Array<{ deductible: boolean; base: string; quota: string }> };
type Asset = { id: string; category: string | null; accountCode: string | null; depreciationAccountCode: string | null; expenseAccountCode: string | null; coefficientPct: string | null; monthlyAmount: string | null; accumulatedDepreciation: string; netBookValue: string; status: string; disposalEntry?: Entry | null };
type Run = { id: string | null; period: string; status: string; totalAmount: string; journalEntryId: string | null; reversalJournalEntryId: string | null; alreadyPosted: boolean; pendingPeriods: string[]; lines: Array<{ fixedAssetId: string; amount: string; accumulatedAfter: string }>; skipped: Array<{ fixedAssetId: string; reason: string }>; entry: Entry | null };

const PROPERTY_ID = "prop_123";
const ORGANIZATION_ID = "org_123";
const MARK = "[payables-assets test]";
const SUPPLIER_NIF = "12345678Z";
const RUN_YEAR = "2019";
/** Year of the gap probes (never posted: 409 before anything is written). */
const GAP_YEAR = "2020";

let cachedSession: { token: string } | null | undefined;
async function loginDemo(app: ApiApp): Promise<{ token: string } | null> {
  if (cachedSession !== undefined) return cachedSession;
  const res = await app.inject({
    method: "POST",
    url: "/auth/login",
    payload: { email: process.env.INTEGRATION_LOGIN_EMAIL ?? "reception@example.com", password: process.env.INTEGRATION_LOGIN_PASSWORD ?? "hotelos-demo", deviceId: "integration-tests-payables" }
  });
  cachedSession = res.statusCode === 200 ? { token: (JSON.parse(res.body) as { token: string }).token } : null;
  return cachedSession;
}

const byCode = (entry: Entry, code: string) => entry.lines.find((l) => l.accountCode === code);

describe("payables & fixed assets (app.inject, prop_123 / org_123)", () => {
  let app: ApiApp;
  let payablesPrefix = "";
  let assetsPrefix = "";
  let headers: Headers = {};
  const supplierIds: string[] = [];
  const billIds: string[] = [];
  const expenseIds: string[] = [];
  const assetIds: string[] = [];
  const runIds: string[] = [];
  const entryIds = new Set<string>();
  let supplierId = "";
  let billId = "";
  let assetId = "";
  let lastRunId = "";

  const p = (path: string): string => `${payablesPrefix}${path}`;
  const a = (path: string): string => `${assetsPrefix}${path}`;

  async function call<T>(method: "GET" | "POST" | "PATCH", url: string, payload?: unknown): Promise<{ status: number; body: T & ErrorBody; raw: string }> {
    const res = await app.inject({ method, url, headers, ...(payload !== undefined ? { payload } : {}) });
    let body: T & ErrorBody;
    try {
      body = JSON.parse(res.body) as T & ErrorBody;
    } catch {
      body = { statusCode: res.statusCode, message: res.body } as T & ErrorBody;
    }
    return { status: res.statusCode, body, raw: res.body };
  }

  const track = (entry: Entry | null | undefined) => {
    if (entry?.id) entryIds.add(entry.id);
    if (entry?.reversedById) entryIds.add(entry.reversedById);
  };

  async function removeLeftoverRuns(): Promise<void> {
    const runs = await prisma.depreciationRun.findMany({ where: { organizationId: ORGANIZATION_ID, OR: [{ period: { startsWith: `${RUN_YEAR}-` } }, { period: { startsWith: `${GAP_YEAR}-` } }] }, select: { id: true } });
    if (runs.length === 0) return;
    const entries = await prisma.journalEntry.findMany({ where: { organizationId: ORGANIZATION_ID, OR: runs.flatMap((r) => [{ sourceId: { startsWith: r.id } }, { sourceId: `depreciation_reversal:${r.id}` }]) }, select: { id: true } });
    await prisma.journalLine.deleteMany({ where: { journalEntryId: { in: entries.map((e) => e.id) } } });
    await prisma.journalEntry.deleteMany({ where: { id: { in: entries.map((e) => e.id) } } });
    await prisma.depreciationRun.deleteMany({ where: { id: { in: runs.map((r) => r.id) } } });
  }

  before(async () => {
    app = await buildApiServer();
    if (!app.hasRoute({ method: "GET", url: "/properties/:propertyId/payables/aging" })) {
      payablesPrefix = "/__payables";
      routePermissionManifest.push(...payablesRoutePermissions.map((entry) => ({ ...entry, path: `${payablesPrefix}${entry.path}` })));
      await app.register(async (sub) => registerPayablesRoutes(sub), { prefix: payablesPrefix });
    }
    if (!app.hasRoute({ method: "GET", url: "/properties/:propertyId/asset-register" })) {
      assetsPrefix = "/__fixed-assets";
      routePermissionManifest.push(...fixedAssetsRoutePermissions.map((entry) => ({ ...entry, path: `${assetsPrefix}${entry.path}` })));
      await app.register(async (sub) => registerFixedAssetsRoutes(sub), { prefix: assetsPrefix });
    }
    await app.ready();
    const session = await loginDemo(app);
    headers = session ? { authorization: `Bearer ${session.token}` } : {};
    // A crashed previous run may have left the 2019 runs and a supplier with the test NIF behind.
    await removeLeftoverRuns();
    const stale = await prisma.supplier.findMany({ where: { organizationId: ORGANIZATION_ID, taxId: SUPPLIER_NIF, name: { contains: MARK } }, select: { id: true } });
    for (const s of stale) {
      const bills = await prisma.supplierBill.findMany({ where: { supplierId: s.id }, select: { id: true } });
      await prisma.vatBookEntry.deleteMany({ where: { sourceType: "supplier_bill", sourceId: { in: bills.map((b) => b.id) } } });
      await prisma.withholdingTaxRecord.deleteMany({ where: { sourceType: "vendor_invoice", sourceId: { in: bills.map((b) => b.id) } } });
      await prisma.supplierBill.deleteMany({ where: { supplierId: s.id } });
      await prisma.supplier.delete({ where: { id: s.id } });
    }
  });

  after(async () => {
    // Journal entries of every document the suite created (accrual, payment, reversal, expense, disposal, runs).
    const sourceIds = [...billIds, ...expenseIds, ...assetIds, ...runIds];
    const related = await prisma.journalEntry.findMany({
      where: {
        organizationId: ORGANIZATION_ID,
        OR: [
          { sourceId: { in: sourceIds } },
          ...billIds.map((id) => ({ sourceId: `supplier_bill_cancel:${id}` })),
          ...expenseIds.map((id) => ({ sourceId: `expense_reversal:${id}` })),
          ...runIds.flatMap((id) => [{ sourceId: { startsWith: id } }, { sourceId: `depreciation_reversal:${id}` }])
        ]
      },
      select: { id: true }
    });
    for (const e of related) entryIds.add(e.id);
    const ids = Array.from(entryIds);
    await prisma.journalLine.deleteMany({ where: { journalEntryId: { in: ids } } });
    await prisma.journalEntry.deleteMany({ where: { id: { in: ids } } });
    await prisma.vatBookEntry.deleteMany({ where: { organizationId: ORGANIZATION_ID, sourceId: { in: [...billIds, ...expenseIds] } } });
    await prisma.withholdingTaxRecord.deleteMany({ where: { sourceType: "vendor_invoice", sourceId: { in: billIds } } });
    await prisma.depreciationRun.deleteMany({ where: { id: { in: runIds } } });
    await prisma.supplierBill.deleteMany({ where: { id: { in: billIds } } });
    await prisma.expense.deleteMany({ where: { id: { in: expenseIds } } });
    await prisma.fixedAsset.deleteMany({ where: { id: { in: assetIds } } });
    await prisma.supplier.deleteMany({ where: { id: { in: supplierIds } } });
    await app.close();
    await prisma.$disconnect();
  });

  // ── Suppliers ─────────────────────────────────────────────────────────────
  it("rejects a supplier with a wrong NIF control letter (400 SUPPLIER_NIF_INVALID) and an invalid IBAN", async () => {
    const bad = await call(`POST`, p(`/organizations/${ORGANIZATION_ID}/payables/suppliers`), { name: `${MARK} NIF malo`, taxId: "12345678A" });
    assert.equal(bad.status, 400, bad.raw);
    assert.equal(bad.body.details?.code, "SUPPLIER_NIF_INVALID");
    assert.match(bad.body.message, /control/);
    const iban = await call(`POST`, p(`/organizations/${ORGANIZATION_ID}/payables/suppliers`), { name: `${MARK} IBAN malo`, taxId: "B12345674", iban: "ES9121000418450200051333" });
    assert.equal(iban.status, 400, iban.raw);
    assert.equal(iban.body.details?.code, "SUPPLIER_IBAN_INVALID");
  });

  it("creates a professional supplier (DNI, 15 % IRPF, IBAN, 623 by default) and refuses a duplicate NIF (409)", async () => {
    const res = await call<{ id: string; taxId: string; nifValidatedAt: string | null; isCompany: boolean | null; retentionRate: string | null; retentionRowCode: string | null; ibanFormatted: string | null }>(
      "POST",
      p(`/organizations/${ORGANIZATION_ID}/payables/suppliers`),
      { name: `${MARK} Asesoría Fiscal`, taxId: " 12345678-z ", iban: "ES91 2100 0418 4502 0005 1332", defaultExpenseAccountCode: "623", retentionRate: 15, paymentTermDays: 30, contact: { email: "asesoria@example.com" } }
    );
    assert.equal(res.status, 201, res.raw);
    supplierId = res.body.id;
    supplierIds.push(supplierId);
    assert.equal(res.body.taxId, SUPPLIER_NIF);
    assert.ok(res.body.nifValidatedAt);
    assert.equal(res.body.isCompany, false);
    assert.equal(res.body.retentionRate, "15.00");
    assert.equal(res.body.retentionRowCode, "02");
    assert.equal(res.body.ibanFormatted, "ES91 2100 0418 4502 0005 1332");
    const dup = await call("POST", p(`/organizations/${ORGANIZATION_ID}/payables/suppliers`), { name: `${MARK} duplicado`, taxId: "12345678Z" });
    assert.equal(dup.status, 409, dup.raw);
    assert.equal(dup.body.details?.code, "SUPPLIER_NIF_DUPLICATE");
    const list = await call<Array<{ id: string }>>("GET", p(`/organizations/${ORGANIZATION_ID}/payables/suppliers?q=Asesor`));
    assert.equal(list.status, 200, list.raw);
    assert.ok(list.body.some((s) => s.id === supplierId));
    const patch = await call("PATCH", p(`/organizations/${ORGANIZATION_ID}/payables/suppliers/${supplierId}`), { iban: "ES00 0000 0000 0000 0000 0000" });
    assert.equal(patch.status, 400, patch.raw);
    assert.equal(patch.body.details?.code, "SUPPLIER_IBAN_INVALID");
  });

  // ── Supplier bill: 1.000 € at 21 % with 15 % retention ───────────────────
  it("registers the bill as draft with per-line rounding: 1000.00 / 210.00 / 150.00 → 1060.00, due date from the supplier's terms", async () => {
    const res = await call<Bill & { dueDate: string | null; issueDate: string }>("POST", p(`/properties/${PROPERTY_ID}/payables/supplier-bills`), {
      supplierId,
      invoiceNumber: `${MARK} F-2026-001`,
      issueDate: "2026-09-15",
      expectedTotal: "1060.00",
      lines: [{ description: "Honorarios asesoría septiembre", expenseAccountCode: "623", base: 1000, taxRate: 21 }]
    });
    assert.equal(res.status, 201, res.raw);
    billId = res.body.id;
    billIds.push(billId);
    assert.equal(res.body.status, "draft");
    assert.equal(res.body.baseTotal, "1000.00");
    assert.equal(res.body.taxTotal, "210.00");
    assert.equal(res.body.retentionRate, "15.00");
    assert.equal(res.body.retentionAmount, "150.00");
    assert.equal(res.body.total, "1060.00");
    assert.equal(res.body.payableAccountCode, "410");
    assert.equal(res.body.retentionRowCode, "02");
    assert.equal(res.body.dueDate, "2026-10-15");
  });

  it("refuses a duplicate invoice number (409), a printed total that does not match (400) and posting from draft (409)", async () => {
    const dup = await call("POST", p(`/properties/${PROPERTY_ID}/payables/supplier-bills`), { supplierId, invoiceNumber: `${MARK} F-2026-001`, issueDate: "2026-09-16", lines: [{ description: "x", expenseAccountCode: "623", base: 1, taxRate: 21 }] });
    assert.equal(dup.status, 409, dup.raw);
    assert.equal(dup.body.details?.code, "SUPPLIER_BILL_DUPLICATE");
    const mismatch = await call("POST", p(`/properties/${PROPERTY_ID}/payables/supplier-bills`), { supplierId, invoiceNumber: `${MARK} F-2026-XX`, issueDate: "2026-09-16", expectedTotal: 1000, lines: [{ description: "x", expenseAccountCode: "623", base: 1000, taxRate: 21 }] });
    assert.equal(mismatch.status, 400, mismatch.raw);
    assert.equal(mismatch.body.details?.code, "TOTAL_MISMATCH");
    const early = await call("POST", p(`/properties/${PROPERTY_ID}/payables/supplier-bills/${billId}/post`), {});
    assert.equal(early.status, 409, early.raw);
    assert.equal(early.body.details?.code, "INVALID_STATUS_TRANSITION");
  });

  it("approve → post: D 623 1000.00 / D 472.21 210.00 (taxBase 1000.00) / H 4751 150.00 / H 410 1060.00, numbered, book row 2026-Q3, withholding 150.00; re-post is idempotent", async () => {
    const approved = await call<Bill>("POST", p(`/properties/${PROPERTY_ID}/payables/supplier-bills/${billId}/approve`), {});
    assert.equal(approved.status, 200, approved.raw);
    assert.equal(approved.body.status, "approved");
    const posted = await call<Bill>("POST", p(`/properties/${PROPERTY_ID}/payables/supplier-bills/${billId}/post`), {});
    assert.equal(posted.status, 200, posted.raw);
    assert.equal(posted.body.status, "posted");
    const entry = posted.body.accrualEntry!;
    track(entry);
    assert.ok(entry.entryNumber && entry.entryNumber > 0, "entry numbered");
    assert.equal(entry.fiscalYearCode, "2026");
    assert.equal(entry.entryDate, "2026-09-15");
    assert.equal(entry.sourceType, "supplier_bill");
    assert.equal(entry.status, "posted");
    assert.equal(entry.totalDebit, "1210.00");
    assert.equal(entry.totalCredit, "1210.00");
    assert.equal(byCode(entry, "623")?.debit, "1000.00");
    assert.equal(byCode(entry, "472.21")?.debit, "210.00");
    assert.equal(byCode(entry, "472.21")?.taxBase, "1000.00");
    assert.equal(byCode(entry, "472.21")?.taxRateCode, "21");
    assert.equal(byCode(entry, "4751")?.credit, "150.00");
    assert.equal(byCode(entry, "410")?.credit, "1060.00");
    assert.equal(posted.body.vatRows!.length, 1);
    const row = posted.body.vatRows![0]!;
    assert.equal(row.book, "recibidas");
    assert.equal(row.base, "1000.00");
    assert.equal(row.rate, "21");
    assert.equal(row.quota, "210.00");
    assert.equal(row.total, "1210.00");
    assert.equal(row.retention, "150.00");
    assert.equal(row.period, "2026-Q3");
    assert.equal(row.deductible, true);
    assert.equal(row.counterpartyNif, SUPPLIER_NIF);
    const withholding = await prisma.withholdingTaxRecord.findFirst({ where: { sourceType: "vendor_invoice", sourceId: billId } });
    assert.ok(withholding, "withholding record");
    assert.equal(withholding!.retentionAmount.toFixed(2), "150.00");
    assert.equal(withholding!.rowCode, "02");
    assert.equal(withholding!.recipientNif, SUPPLIER_NIF);
    const again = await call<Bill>("POST", p(`/properties/${PROPERTY_ID}/payables/supplier-bills/${billId}/post`), {});
    assert.equal(again.status, 200, again.raw);
    assert.equal(again.body.journalEntryId, posted.body.journalEntryId);
    const count = await prisma.journalEntry.count({ where: { organizationId: ORGANIZATION_ID, sourceType: "supplier_bill", sourceId: billId } });
    assert.equal(count, 1, "exactly one accrual entry (no legacy projection duplicate)");
  });

  it("aging shows the open item (1060.00, not due until 2026-10-15); paying it posts D 410 / H 572 and clears the aging", async () => {
    const aging = await call<{ totals: { outstanding: string; notDue: string; count: number }; suppliers: Array<{ supplierId: string | null; outstanding: string; bills: Array<{ id: string; bucket: string; daysPastDue: number }> }> }>("GET", p(`/properties/${PROPERTY_ID}/payables/aging?asOf=2026-09-30`));
    assert.equal(aging.status, 200, aging.raw);
    const mine = aging.body.suppliers.find((s) => s.supplierId === supplierId);
    assert.ok(mine, "supplier in aging");
    assert.equal(mine!.outstanding, "1060.00");
    const item = mine!.bills.find((b) => b.id === billId)!;
    assert.equal(item.bucket, "notDue");
    assert.equal(item.daysPastDue, -15);
    const overdue = await call<{ suppliers: Array<{ supplierId: string | null; bills: Array<{ id: string; bucket: string; daysPastDue: number }> }> }>("GET", p(`/properties/${PROPERTY_ID}/payables/aging?asOf=2026-11-20`));
    const late = overdue.body.suppliers.find((s) => s.supplierId === supplierId)!.bills.find((b) => b.id === billId)!;
    assert.equal(late.bucket, "d31_60");
    assert.equal(late.daysPastDue, 36);
    const paid = await call<Bill>("POST", p(`/properties/${PROPERTY_ID}/payables/supplier-bills/${billId}/pay`), { paymentDate: "2026-09-20", paidWith: "bank", reference: "TRF-001" });
    assert.equal(paid.status, 200, paid.raw);
    assert.equal(paid.body.status, "paid");
    const entry = paid.body.paymentEntry!;
    track(entry);
    assert.equal(entry.sourceType, "supplier_bill_payment");
    assert.equal(entry.entryDate, "2026-09-20");
    assert.equal(byCode(entry, "410")?.debit, "1060.00");
    assert.equal(byCode(entry, "572")?.credit, "1060.00");
    assert.equal(entry.totalDebit, "1060.00");
    const after = await call<{ suppliers: Array<{ supplierId: string | null }> }>("GET", p(`/properties/${PROPERTY_ID}/payables/aging?asOf=2026-09-30`));
    assert.equal(after.body.suppliers.some((s) => s.supplierId === supplierId), false, "paid bill leaves the aging");
    const cancel = await call("POST", p(`/properties/${PROPERTY_ID}/payables/supplier-bills/${billId}/cancel`), { reason: "prueba" });
    assert.equal(cancel.status, 409, cancel.raw);
    assert.equal(cancel.body.details?.code, "INVALID_STATUS_TRANSITION");
    const payAgain = await call<Bill>("POST", p(`/properties/${PROPERTY_ID}/payables/supplier-bills/${billId}/pay`), { paymentDate: "2026-09-21" });
    assert.equal(payAgain.status, 200, payAgain.raw);
    assert.equal(payAgain.body.paidJournalEntryId, paid.body.paidJournalEntryId, "second pay is idempotent");
  });

  it("cancelling a posted bill reverses the accrual (lines swapped, original reversed) and removes book rows and withholding", async () => {
    const created = await call<Bill>("POST", p(`/properties/${PROPERTY_ID}/payables/supplier-bills`), {
      supplierName: `${MARK} Lavandería Rías`,
      supplierTaxId: "B12345674",
      invoiceNumber: `${MARK} L-77`,
      issueDate: "2026-09-10",
      dueDate: "2026-10-10",
      lines: [
        { description: "Lavado ropa", expenseAccountCode: "629", base: "200.00", taxRate: 21 },
        { description: "Productos limpieza", expenseAccountCode: "628", base: "50.00", taxRate: 10 }
      ]
    });
    assert.equal(created.status, 201, created.raw);
    const id = created.body.id;
    billIds.push(id);
    assert.equal(created.body.total, "297.00");
    assert.equal(created.body.retentionAmount, "0.00");
    assert.equal((await call("POST", p(`/properties/${PROPERTY_ID}/payables/supplier-bills/${id}/approve`), {})).status, 200);
    const posted = await call<Bill>("POST", p(`/properties/${PROPERTY_ID}/payables/supplier-bills/${id}/post`), {});
    assert.equal(posted.status, 200, posted.raw);
    track(posted.body.accrualEntry);
    assert.equal(posted.body.vatRows!.length, 2, "one book row per rate");
    assert.equal(byCode(posted.body.accrualEntry!, "472.10")?.debit, "5.00");
    assert.equal(byCode(posted.body.accrualEntry!, "472.21")?.debit, "42.00");
    const cancelled = await call<Bill>("POST", p(`/properties/${PROPERTY_ID}/payables/supplier-bills/${id}/cancel`), { reason: "Factura duplicada del proveedor" });
    assert.equal(cancelled.status, 200, cancelled.raw);
    assert.equal(cancelled.body.status, "cancelled");
    assert.equal(cancelled.body.vatRows!.length, 0);
    const original = cancelled.body.accrualEntry!;
    track(original);
    assert.equal(original.status, "reversed");
    assert.ok(original.reversedById);
    const reversal = await prisma.journalEntry.findUnique({ where: { id: original.reversedById! } });
    assert.ok(reversal);
    entryIds.add(reversal!.id);
    assert.equal(reversal!.reversalOfId, original.id);
    assert.equal(reversal!.entryKind, "reversal");
    const reversalLines = await prisma.journalLine.findMany({ where: { journalEntryId: reversal!.id } });
    const swapped = reversalLines.find((l) => l.accountCode === "410");
    assert.equal(swapped?.debit.toFixed(2), "297.00");
    assert.equal(await prisma.withholdingTaxRecord.count({ where: { sourceType: "vendor_invoice", sourceId: id } }), 0);
  });

  // ── Expenses ──────────────────────────────────────────────────────────────
  it("a 10 € + 21 % ticket without NIF posts D 629 12.10 / H 570 12.10 (non-deductible) and can be reversed; deductible without NIF → 400", async () => {
    const bad = await call("POST", p(`/properties/${PROPERTY_ID}/payables/expenses`), { date: "2026-09-15", supplierName: "Taxi", concept: "Taxi aeropuerto", accountCode: "629", base: 10, taxRate: 21, paidWith: "cash", vatDeductible: true });
    assert.equal(bad.status, 400, bad.raw);
    assert.equal(bad.body.details?.code, "EXPENSE_VAT_NOT_DEDUCTIBLE_WITHOUT_NIF");
    const res = await call<Expense>("POST", p(`/properties/${PROPERTY_ID}/payables/expenses`), { date: "2026-09-15", supplierName: `${MARK} Taxi`, concept: "Taxi aeropuerto", accountCode: "629", base: 10, taxRate: 21, paidWith: "cash" });
    assert.equal(res.status, 201, res.raw);
    expenseIds.push(res.body.id);
    assert.equal(res.body.total, "12.10");
    assert.equal(res.body.vatDeductible, false);
    const entry = res.body.entry!;
    track(entry);
    assert.equal(entry.sourceType, "expense");
    assert.equal(byCode(entry, "629")?.debit, "12.10");
    assert.equal(byCode(entry, "570")?.credit, "12.10");
    assert.equal(entry.lines.length, 2);
    assert.equal(res.body.vatRows![0]!.deductible, false);
    const reversed = await call<Expense>("POST", p(`/properties/${PROPERTY_ID}/payables/expenses/${res.body.id}/reverse`), { reason: "Ticket registrado dos veces" });
    assert.equal(reversed.status, 200, reversed.raw);
    assert.ok(reversed.body.cancelledAt);
    assert.ok(reversed.body.reversalJournalEntryId);
    entryIds.add(reversed.body.reversalJournalEntryId!);
    assert.equal(reversed.body.entry!.status, "reversed");
    assert.equal(reversed.body.vatRows!.length, 0);
    const list = await call<Expense[]>("GET", p(`/properties/${PROPERTY_ID}/payables/expenses?from=2026-09-15&to=2026-09-15`));
    assert.equal(list.body.some((e) => e.id === res.body.id), false, "reversed expenses are hidden by default");
  });

  // ── Fixed assets ──────────────────────────────────────────────────────────
  it("registers 12.000 € of mobiliario at the table coefficient (10 % → 100.00/month, 216/2816/681) and caps the coefficient (400)", async () => {
    const over = await call("POST", a(`/properties/${PROPERTY_ID}/asset-register`), { name: `${MARK} Camas`, category: "mobiliario", acquisitionDate: `${RUN_YEAR}-01-01`, acquisitionCost: 12000, coefficientPct: 15 });
    assert.equal(over.status, 400, over.raw);
    assert.equal(over.body.details?.code, "COEFFICIENT_ABOVE_MAX");
    const res = await call<Asset>("POST", a(`/properties/${PROPERTY_ID}/asset-register`), { name: `${MARK} Camas`, category: "mobiliario", acquisitionDate: `${RUN_YEAR}-01-01`, acquisitionCost: "12000.00" });
    assert.equal(res.status, 201, res.raw);
    assetId = res.body.id;
    assetIds.push(assetId);
    assert.equal(res.body.category, "mobiliario");
    assert.equal(res.body.accountCode, "216");
    assert.equal(res.body.depreciationAccountCode, "2816");
    assert.equal(res.body.expenseAccountCode, "681");
    assert.equal(res.body.coefficientPct, "10.00");
    assert.equal(res.body.monthlyAmount, "100.00");
    assert.equal(res.body.netBookValue, "12000.00");
    const preview = await call<Run>("GET", a(`/organizations/${ORGANIZATION_ID}/depreciation-runs/preview?period=${RUN_YEAR}-01`));
    assert.equal(preview.status, 200, preview.raw);
    assert.equal(preview.body.status, "preview");
    assert.equal(preview.body.lines.find((l) => l.fixedAssetId === assetId)?.amount, "100.00");
  });

  it("12 monthly runs post D 681 100.00 / H 2816 100.00 each → accumulated 1200.00; a posted period is idempotent; 2019-13 → 400", async () => {
    for (let month = 1; month <= 12; month += 1) {
      const period = `${RUN_YEAR}-${String(month).padStart(2, "0")}`;
      const res = await call<Run>("POST", a(`/organizations/${ORGANIZATION_ID}/depreciation-runs`), { period });
      assert.equal(res.status, 201, res.raw);
      assert.equal(res.body.status, "posted");
      assert.equal(res.body.alreadyPosted, false);
      runIds.push(res.body.id!);
      lastRunId = res.body.id!;
      const line = res.body.lines.find((l) => l.fixedAssetId === assetId);
      assert.ok(line, `${period}: asset line`);
      assert.equal(line!.amount, "100.00");
      assert.equal(line!.accumulatedAfter, `${month * 100}.00`);
      assert.ok(res.body.entry, `${period}: entry`);
      track(res.body.entry);
      assert.equal(res.body.entry!.sourceType, "depreciation");
      assert.equal(res.body.entry!.entryDate, new Date(Date.UTC(Number(RUN_YEAR), month, 0)).toISOString().slice(0, 10));
      assert.equal(res.body.entry!.fiscalYearCode, RUN_YEAR);
      assert.equal(res.body.entry!.totalDebit, res.body.entry!.totalCredit);
      const d681 = res.body.entry!.lines.filter((l) => l.accountCode === "681").reduce((s, l) => s + Number(l.debit), 0);
      const h2816 = res.body.entry!.lines.filter((l) => l.accountCode === "2816").reduce((s, l) => s + Number(l.credit), 0);
      assert.ok(d681 >= 100 && h2816 >= 100, `${period}: 681/2816 lines`);
    }
    const asset = await call<Asset>("GET", a(`/properties/${PROPERTY_ID}/asset-register/${assetId}`));
    assert.equal(asset.body.accumulatedDepreciation, "1200.00");
    assert.equal(asset.body.netBookValue, "10800.00");
    assert.equal(asset.body.status, "active");
    const again = await call<Run>("POST", a(`/organizations/${ORGANIZATION_ID}/depreciation-runs`), { period: `${RUN_YEAR}-06` });
    assert.equal(again.status, 200, again.raw);
    assert.equal(again.body.alreadyPosted, true);
    assert.equal(again.body.id, runIds[5]);
    const bad = await call("POST", a(`/organizations/${ORGANIZATION_ID}/depreciation-runs`), { period: `${RUN_YEAR}-13` });
    assert.equal(bad.status, 400, bad.raw);
    const future = await call("POST", a(`/organizations/${ORGANIZATION_ID}/depreciation-runs`), { period: "2099-01" });
    assert.equal(future.status, 400, future.raw);
    assert.equal(future.body.details?.code, "PERIOD_IN_FUTURE");
  });

  it("a run with unposted months in between is refused (409 PREVIOUS_PERIOD_MISSING [2020-01, 2020-02]) and the preview lists them; nothing is written (t6#12)", async () => {
    const gap = await call("POST", a(`/organizations/${ORGANIZATION_ID}/depreciation-runs`), { period: `${GAP_YEAR}-03` });
    assert.equal(gap.status, 409, gap.raw);
    assert.equal(gap.body.details?.code, "PREVIOUS_PERIOD_MISSING");
    assert.deepEqual(gap.body.details?.pendingPeriods, [`${GAP_YEAR}-01`, `${GAP_YEAR}-02`]);
    assert.equal(gap.body.details?.latestPostedPeriod, `${RUN_YEAR}-12`);
    assert.match(gap.body.message, /sin huecos/);
    const preview = await call<Run>("GET", a(`/organizations/${ORGANIZATION_ID}/depreciation-runs/preview?period=${GAP_YEAR}-03`));
    assert.equal(preview.status, 200, preview.raw);
    assert.equal(preview.body.status, "preview");
    assert.deepEqual(preview.body.pendingPeriods, [`${GAP_YEAR}-01`, `${GAP_YEAR}-02`]);
    assert.equal(preview.body.lines.find((l) => l.fixedAssetId === assetId)?.amount, "100.00");
    const next = await call<Run>("GET", a(`/organizations/${ORGANIZATION_ID}/depreciation-runs/preview?period=${GAP_YEAR}-01`));
    assert.equal(next.status, 200, next.raw);
    assert.deepEqual(next.body.pendingPeriods, [], "the month after the latest posted run has nothing pending");
    const posted = await call<Run>("GET", a(`/organizations/${ORGANIZATION_ID}/depreciation-runs/${runIds[11]}`));
    assert.deepEqual(posted.body.pendingPeriods, [], "posted runs carry no pending list");
    assert.equal(await prisma.depreciationRun.count({ where: { organizationId: ORGANIZATION_ID, period: { startsWith: `${GAP_YEAR}-` } } }), 0, "the refused run left no row");
    const asset = await call<Asset>("GET", a(`/properties/${PROPERTY_ID}/asset-register/${assetId}`));
    assert.equal(asset.body.accumulatedDepreciation, "1200.00");
  });

  it("only the latest run can be reversed (409 LATER_RUN_EXISTS); reversing 2019-12 restores accumulated 1100.00 and reopens the gap (2020-01 → 409 pending [2019-12])", async () => {
    const early = await call("POST", a(`/organizations/${ORGANIZATION_ID}/depreciation-runs/${runIds[5]}/reverse`), { reason: "prueba" });
    assert.equal(early.status, 409, early.raw);
    assert.equal(early.body.details?.code, "LATER_RUN_EXISTS");
    const reversed = await call<Run>("POST", a(`/organizations/${ORGANIZATION_ID}/depreciation-runs/${lastRunId}/reverse`), { reason: "Elemento vendido en diciembre" });
    assert.equal(reversed.status, 200, reversed.raw);
    assert.equal(reversed.body.status, "reversed");
    assert.ok(reversed.body.reversalJournalEntryId);
    entryIds.add(reversed.body.reversalJournalEntryId!);
    assert.equal(reversed.body.entry!.status, "reversed");
    const asset = await call<Asset>("GET", a(`/properties/${PROPERTY_ID}/asset-register/${assetId}`));
    assert.equal(asset.body.accumulatedDepreciation, "1100.00");
    const runs = await call<Run[]>("GET", a(`/organizations/${ORGANIZATION_ID}/depreciation-runs?limit=24`));
    assert.equal(runs.status, 200, runs.raw);
    assert.equal(runs.body.find((r) => r.id === lastRunId)?.status, "reversed");
    const gap = await call("POST", a(`/organizations/${ORGANIZATION_ID}/depreciation-runs`), { period: `${GAP_YEAR}-01` });
    assert.equal(gap.status, 409, gap.raw);
    assert.equal(gap.body.details?.code, "PREVIOUS_PERIOD_MISSING");
    assert.deepEqual(gap.body.details?.pendingPeriods, [`${RUN_YEAR}-12`]);
    assert.equal(gap.body.details?.latestPostedPeriod, `${RUN_YEAR}-11`);
  });

  it("disposal with a 5.000 € sale: D 2816 1100.00 / D 671 5900.00 / D 572 5000.00 / H 216 12000.00", async () => {
    const res = await call<Asset>("POST", a(`/properties/${PROPERTY_ID}/asset-register/${assetId}/dispose`), { date: "2020-01-15", saleAmount: 5000, counterAccountCode: "572", reason: "Renovación de habitaciones" });
    assert.equal(res.status, 200, res.raw);
    assert.equal(res.body.status, "disposed");
    const entry = res.body.disposalEntry!;
    track(entry);
    assert.equal(entry.sourceType, "fixed_asset_disposal");
    assert.equal(entry.totalDebit, "12000.00");
    assert.equal(entry.totalCredit, "12000.00");
    assert.equal(byCode(entry, "2816")?.debit, "1100.00");
    assert.equal(byCode(entry, "671")?.debit, "5900.00");
    assert.equal(byCode(entry, "572")?.debit, "5000.00");
    assert.equal(byCode(entry, "216")?.credit, "12000.00");
    const again = await call<Asset>("POST", a(`/properties/${PROPERTY_ID}/asset-register/${assetId}/dispose`), { date: "2020-01-15" });
    assert.equal(again.status, 200, again.raw);
    assert.equal(again.body.disposalEntry?.id, entry.id, "second disposal is idempotent");
    const patch = await call("PATCH", a(`/properties/${PROPERTY_ID}/asset-register/${assetId}`), { name: "x" });
    assert.equal(patch.status, 409, patch.raw);
    assert.equal(patch.body.details?.code, "ASSET_DISPOSED");
  });
});
