/**
 * Finanzas · lote «iva-modelos» — integration (Postgres required; REAL HTTP via
 * app.inject for the routes, in-process services for the money path).
 *
 * The suite creates its OWN organisation (`orgfisc_<rand>`, one property,
 * chart «PGC Pymes hotelero» provisioned) and removes everything it wrote in
 * `after` (journal lines/entries, VAT book rows, settings, withholding
 * records, supplier bills, invoices, accounts, the property and the
 * organisation). It never writes to Faranda: the Faranda case is a read-only
 * probe (row counts before == after).
 *
 * Fixtures (2026-Q2 = 2026-04-01..06-30, ended before today 2026-09-15):
 *   · inv1 FAC 110,00 @10 % (base 100 · cuota 10) to B00000001, 2026-05-10
 *   · inv2 FAC 3.300,00 @10 % (base 3.000 · cuota 300) to B00000002, 2026-05-15
 *   · rec1 REC −55,00 @10 % rectificativa R1 of inv1 (base −50 · cuota −5), 2026-06-01
 *   · inv3 FAC 121,00 @21 % issued 2026-05-20 and CANCELLED 2026-05-22 (legacy: no breakdown, lines only)
 *   · inv4 FS 24,20 @21 % simplified, no customer NIF (base 20 · cuota 4,20), 2026-05-05
 *   · bill1 received 1.000,00 @21 % (cuota 210) with 15 % retention (150) from B00000003, 2026-05-20, posted
 *   · bill0 received 200,00 @21 % (cuota 42) in 2026-Q1 (2026-02-10), posted → Q1 result −42 to offset
 *   · withholding records: bill1 (row 02, 1.000 / 150) and a rent L01 (500 / 95, 19 %)
 *   · ledger entries of every document through the interim engine so the 303 ↔ ledger cross-check has data;
 *     inv3's cancellation goes through the engine's reversal (as invoicing/ledger.port.ts does): the original
 *     entry is marked `status = reversed` and the reversal carries `reversalOfId` (t6#8 pin: both halves count)
 *   · second suite (own organisation): an invoice posted in 2026-Q2 and reversed in 2026-Q3 — Q2 keeps the
 *     original quota, Q3 only the reversal, both cross-checks balance (t6#8, cross-period half of the fix)
 * Expected 303 of 2026-Q2 (books): 04 = 3.050,00 · 06 = 305,00 · 07 = 20,00 · 09 = 4,20 · 27 = 309,20 ·
 *   28 = 1.000,00 · 29 = 210,00 · 45 = 210,00 · 46 = 99,20 · before settling Q1: 110 = 0 → 71 = 99,20;
 *   after settling Q1 (−42): 110 = 42 · 78 = 42 · 71 = 57,20.
 * Settlement of Q2: D 477.10 305,00 / D 477.21 4,20 / H 472.21 210,00 / H 4700 42,00 / H 4750 57,20
 *   (debit 309,20 = credit 309,20).
 *
 * Run from the repo root:
 *   cd apps/api && node --import tsx --test "../../tests/integration/fiscal-models.test.mts"
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
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

// server.ts is imported lazily in `before`: while another lot's work in
// progress leaves it unloadable (2026-09-15: invoicing/invoice.service.ts
// imports a payments-types.js that does not exist yet) the HTTP cases skip
// with the reason and the money-path cases (services + Prisma) still run.
const { routePermissionManifest } = await import("../../apps/api/src/security/route-permissions.js");
const { registerFiscalRoutes } = await import("../../apps/api/src/modules/accounting/fiscal.routes.js");
const { fiscalRoutePermissions } = await import("../../apps/api/src/modules/accounting/fiscal-route-permissions.partial.js");
const { provisionOrganizationChart } = await import("../../apps/api/src/modules/accounting/chart-of-accounts.service.js");
const { buildModelo303 } = await import("../../apps/api/src/modules/accounting/modelo-303.service.js");
const { buildModelo390 } = await import("../../apps/api/src/modules/accounting/modelo-390.service.js");
const { buildModelo347 } = await import("../../apps/api/src/modules/accounting/modelo-347.service.js");
const { buildModelo111 } = await import("../../apps/api/src/modules/accounting/modelo-111.service.js");
const { buildModelo115 } = await import("../../apps/api/src/modules/accounting/modelo-115.service.js");
const { buildModelo180 } = await import("../../apps/api/src/modules/accounting/modelo-180.service.js");
const { ZERO, getVatSettings, listVatBook, money, rebuildVatBooks, updateVatSettings } = await import("../../apps/api/src/modules/accounting/vat-books.service.js");
const { interimLedgerEngine, previewVatSettlement, reverseVatSettlement, settleVatPeriod } = await import("../../apps/api/src/modules/accounting/vat-settlement.service.js");
const { prisma } = await import("@hotelos/database");

type ApiApp = Awaited<ReturnType<(typeof import("../../apps/api/src/server.js"))["buildApiServer"]>>;
type Headers = Record<string, string>;
type UserContext = Parameters<typeof buildModelo303>[0]["context"];
type Report = Awaited<ReturnType<typeof buildModelo303>>;
type HttpErrorLike = { statusCode?: number; details?: { code?: string }; message: string };

const RAND = randomUUID().slice(0, 8);
const ORG_ID = `orgfisc_${RAND}`;
const PROP_ID = `propfisc_${RAND}`;
const FARANDA_ORG_ID = "cmrhw9jy30002fyvb6tsdiugt";
// Decimal through the module under test (@prisma/client is not resolvable from tests/integration).
const D = money;
const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
const ctx: UserContext = {
  organizationId: ORG_ID,
  propertyId: PROP_ID,
  userId: "usr_fiscal_test",
  fullName: "Fiscal Test",
  deviceId: "fiscal-integration",
  permissions: ["accounting.read", "accounting.configure", "accounting.journal.post"] as UserContext["permissions"]
};
const farandaCtx: UserContext = { ...ctx, organizationId: FARANDA_ORG_ID, propertyId: "cmrhw9jy40003fyvbuu2ec2w7", permissions: ["accounting.read"] as UserContext["permissions"] };

const casilla = (report: Report, code: string): number => {
  const box = report.casillas.find((entry) => entry.casilla === code);
  assert.ok(box, `casilla ${code} missing in ${report.modelo}`);
  return box.importe;
};
const clave = (report: Report, key: string): number => {
  const box = report.casillas.find((entry) => entry.clave === key);
  assert.ok(box, `clave ${key} missing in ${report.modelo}`);
  return box.importe;
};
const expectError = async (promise: Promise<unknown>, statusCode: number, code: string): Promise<HttpErrorLike> => {
  try {
    await promise;
  } catch (error) {
    const e = error as HttpErrorLike;
    assert.equal(e.statusCode, statusCode, `${e.message}`);
    assert.equal(e.details?.code, code, `${e.message}`);
    return e;
  }
  assert.fail(`expected ${statusCode} ${code}`);
};

let cachedSession: { token: string } | null | undefined;
async function loginDemo(app: ApiApp): Promise<{ token: string } | null> {
  if (cachedSession !== undefined) return cachedSession;
  const res = await app.inject({
    method: "POST",
    url: "/auth/login",
    payload: { email: process.env.INTEGRATION_LOGIN_EMAIL ?? "reception@example.com", password: process.env.INTEGRATION_LOGIN_PASSWORD ?? "hotelos-demo", deviceId: "integration-tests-fiscal" }
  });
  cachedSession = res.statusCode === 200 ? { token: (JSON.parse(res.body) as { token: string }).token } : null;
  return cachedSession;
}

type InvoiceFixture = { id: string; number: string; type: string; status: "issued" | "cancelled" | "rectified"; issuedAt: string; cancelledAt?: string; gross: string; tax: string; rate: string; nif: string | null; name: string; breakdown: boolean; rectifyingForId?: string; simplified?: boolean; seriesCode: string; propertyId?: string };

async function createInvoice(fixture: InvoiceFixture): Promise<string> {
  const base = D(fixture.gross).minus(D(fixture.tax));
  const created = await prisma.invoice.create({
    data: {
      id: fixture.id,
      propertyId: fixture.propertyId ?? PROP_ID,
      invoiceNumber: fixture.number,
      invoiceType: fixture.type,
      customerType: fixture.nif ? "company" : "individual",
      customerTaxId: fixture.nif,
      customerName: fixture.name,
      status: fixture.status,
      issuedAt: new Date(fixture.issuedAt),
      cancelledAt: fixture.cancelledAt ? new Date(fixture.cancelledAt) : null,
      total: D(fixture.gross),
      taxTotal: D(fixture.tax),
      baseTotal: base,
      rectifyingForId: fixture.rectifyingForId ?? null,
      rectifyingReasonCode: fixture.rectifyingForId ? "R1" : null,
      seriesCode: fixture.seriesCode,
      simplified: fixture.simplified ?? false,
      customerRequired: !(fixture.simplified ?? false),
      issuerTaxId: "B12345674",
      issuerLegalName: "Fiscal Test SL",
      taxBreakdownJson: fixture.breakdown ? [{ figure: "IVA", impuesto: "01", calificacion: "S1", ratePercent: Number(fixture.rate), base: Number(base.toFixed(2)), quota: Number(fixture.tax) }] : undefined
    },
    select: { id: true }
  });
  await prisma.invoiceLine.create({
    data: { invoiceId: created.id, description: `Línea ${fixture.number}`, quantity: D(1), unitPrice: D(fixture.gross), taxCode: `ES_IVA_${fixture.rate}`, taxRate: D(fixture.rate), total: D(fixture.gross), taxCategory: "accommodation", taxCalificacion: "S1", taxFigure: "IVA" }
  });
  return created.id;
}

type LedgerScope = { organizationId: string; propertyId: string };

async function post(entryDate: string, sourceType: string, sourceId: string, description: string, lines: Array<[string, string, string, string?, string?]>, scope: LedgerScope = { organizationId: ORG_ID, propertyId: PROP_ID }): Promise<{ id: string }> {
  return interimLedgerEngine.postJournalEntry({
    organizationId: scope.organizationId,
    propertyId: scope.propertyId,
    entryDate,
    sourceType,
    sourceId,
    description,
    createdBy: ctx.userId,
    lines: lines.map(([accountCode, debit, credit, taxRateCode, taxBase]) => ({ accountCode, debit, credit, taxRateCode: taxRateCode ?? null, taxBase: taxBase ?? null }))
  });
}

async function farandaCounts(): Promise<Record<string, number>> {
  return {
    vatSettings: await prisma.vatSettings.count({ where: { organizationId: FARANDA_ORG_ID } }),
    vatBookEntries: await prisma.vatBookEntry.count({ where: { organizationId: FARANDA_ORG_ID } }),
    journalEntries: await prisma.journalEntry.count({ where: { organizationId: FARANDA_ORG_ID } }),
    invoices: await prisma.invoice.count({ where: { propertyId: { in: ["cmrhw9jy40003fyvbuu2ec2w7", "cmu1mifcp0000fyo1wzvq7txo"] } } })
  };
}

describe("fiscal · libros de IVA, modelos AEAT y liquidación (org de test)", () => {
  let app: ApiApp | null = null;
  let serverLoadError: string | null = null;
  let prefix = "";
  let headers: Headers = {};
  let inv1 = "";
  let bill1 = "";
  let inv3Entry = "";
  let inv3Reversal = "";

  before(async () => {
    try {
      const { buildApiServer } = await import("../../apps/api/src/server.js");
      app = await buildApiServer();
      if (!app.hasRoute({ method: "GET", url: "/fiscal/vat-books" })) {
        prefix = "/__fiscal";
        routePermissionManifest.push(...fiscalRoutePermissions.map((entry) => ({ ...entry, path: `${prefix}${entry.path}` })));
        await app.register(async (sub) => registerFiscalRoutes(sub), { prefix });
      }
      await app.ready();
      const session = await loginDemo(app);
      headers = session ? { authorization: `Bearer ${session.token}` } : {};
    } catch (error) {
      serverLoadError = (error as Error).message;
      console.warn(`[fiscal-models] server.ts unavailable, HTTP cases skipped: ${serverLoadError}`);
    }

    await prisma.organization.create({ data: { id: ORG_ID, name: "Fiscal Test SL", legalName: "Fiscal Test SL", taxId: "B12345674" } });
    await prisma.property.create({ data: { id: PROP_ID, organizationId: ORG_ID, name: "Hotel Fiscal Test", timezone: "Europe/Madrid" } });
    const provisioned = await provisionOrganizationChart(ORG_ID);
    assert.ok(provisioned.created >= 200, `chart provisioned: ${JSON.stringify(provisioned)}`);

    inv1 = await createInvoice({ id: `invfisc_${RAND}_1`, number: `FAC-T${RAND}-1`, type: "F1", status: "issued", issuedAt: "2026-05-10T10:00:00.000Z", gross: "110.00", tax: "10.00", rate: "10", nif: "B00000001", name: "Cliente Uno SL", breakdown: true, seriesCode: "FAC" });
    await createInvoice({ id: `invfisc_${RAND}_2`, number: `FAC-T${RAND}-2`, type: "F1", status: "issued", issuedAt: "2026-05-15T10:00:00.000Z", gross: "3300.00", tax: "300.00", rate: "10", nif: "B00000002", name: "Cliente Grande SL", breakdown: true, seriesCode: "FAC" });
    await createInvoice({ id: `invfisc_${RAND}_r1`, number: `REC-T${RAND}-1`, type: "R1", status: "issued", issuedAt: "2026-06-01T10:00:00.000Z", gross: "-55.00", tax: "-5.00", rate: "10", nif: "B00000001", name: "Cliente Uno SL", breakdown: true, rectifyingForId: inv1, seriesCode: "REC" });
    await createInvoice({ id: `invfisc_${RAND}_3`, number: `FAC-T${RAND}-3`, type: "F1", status: "cancelled", issuedAt: "2026-05-20T10:00:00.000Z", cancelledAt: "2026-05-22T09:00:00.000Z", gross: "121.00", tax: "21.00", rate: "21", nif: "B00000001", name: "Cliente Uno SL", breakdown: false, seriesCode: "FAC" });
    await createInvoice({ id: `invfisc_${RAND}_4`, number: `FS-T${RAND}-1`, type: "F2", status: "issued", issuedAt: "2026-05-05T12:00:00.000Z", gross: "24.20", tax: "4.20", rate: "21", nif: null, name: "Cliente de paso", breakdown: true, simplified: true, seriesCode: "FS" });

    const supplier = await prisma.supplier.create({ data: { organizationId: ORG_ID, name: "Asesores Fiscales SL", taxId: "B00000003", retentionRate: D(15), retentionRowCode: "02" }, select: { id: true } });
    const bill = await prisma.supplierBill.create({
      data: {
        propertyId: PROP_ID,
        organizationId: ORG_ID,
        supplierId: supplier.id,
        supplierName: "Asesores Fiscales SL",
        supplierTaxId: "B00000003",
        invoiceNumber: `AF-${RAND}-15`,
        issueDate: day("2026-05-20"),
        baseTotal: D("1000.00"),
        taxTotal: D("210.00"),
        total: D("1060.00"),
        retentionRate: D(15),
        retentionAmount: D("150.00"),
        rowCode: "02",
        status: "posted",
        postedAt: new Date("2026-05-20T10:00:00.000Z"),
        lines: { create: [{ lineNo: 1, description: "Asesoría fiscal mayo", expenseAccountCode: "623", base: D("1000.00"), taxRate: D(21), quota: D("210.00"), retention: D("150.00") }] }
      },
      select: { id: true }
    });
    bill1 = bill.id;
    await prisma.supplierBill.create({
      data: {
        propertyId: PROP_ID,
        organizationId: ORG_ID,
        supplierId: supplier.id,
        supplierName: "Asesores Fiscales SL",
        supplierTaxId: "B00000003",
        invoiceNumber: `AF-${RAND}-02`,
        issueDate: day("2026-02-10"),
        baseTotal: D("200.00"),
        taxTotal: D("42.00"),
        total: D("242.00"),
        status: "posted",
        postedAt: new Date("2026-02-10T10:00:00.000Z"),
        lines: { create: [{ lineNo: 1, description: "Asesoría fiscal febrero", expenseAccountCode: "623", base: D("200.00"), taxRate: D(21), quota: D("42.00"), retention: D(0) }] }
      }
    });
    await prisma.withholdingTaxRecord.createMany({
      data: [
        { organizationId: ORG_ID, propertyId: PROP_ID, sourceType: "vendor_invoice", sourceId: bill1, recipientNif: "B00000003", recipientName: "Asesores Fiscales SL", grossAmount: D("1000.00"), retentionRate: D(15), retentionAmount: D("150.00"), rowCode: "02", paymentDate: day("2026-05-20") },
        { organizationId: ORG_ID, propertyId: PROP_ID, sourceType: "other", sourceId: `rent_${RAND}`, recipientNif: "12345678Z", recipientName: "Arrendadora Local", recipientAddress: "Calle Mayor 1, A Coruña", cadastralReference: "1234567AB0001XX", grossAmount: D("500.00"), retentionRate: D(19), retentionAmount: D("95.00"), rowCode: "L01", paymentDate: day("2026-04-30") }
      ]
    });

    // Ledger entries of every document (canonical rules) so the 303 cross-checks against the journal.
    await post("2026-02-10", "supplier_bill", `bill0_${RAND}`, "Factura recibida AF-02", [["623", "200.00", "0"], ["472.21", "42.00", "0", "21", "200.00"], ["410", "0", "242.00"]]);
    await post("2026-05-05", "pos_ticket", `invfisc_${RAND}_4`, "Ticket FS-1", [["570", "24.20", "0"], ["705.2", "0", "20.00"], ["477.21", "0", "4.20", "21", "20.00"]]);
    await post("2026-05-10", "invoice", inv1, "Factura FAC-1", [["430", "110.00", "0"], ["705.1", "0", "100.00"], ["477.10", "0", "10.00", "10", "100.00"]]);
    await post("2026-05-15", "invoice", `invfisc_${RAND}_2`, "Factura FAC-2", [["430", "3300.00", "0"], ["705.1", "0", "3000.00"], ["477.10", "0", "300.00", "10", "3000.00"]]);
    inv3Entry = (await post("2026-05-20", "invoice", `invfisc_${RAND}_3`, "Factura FAC-3", [["430", "121.00", "0"], ["705.1", "0", "100.00"], ["477.21", "0", "21.00", "21", "100.00"]])).id;
    await post("2026-05-20", "supplier_bill", bill1, "Factura recibida AF-15", [["623", "1000.00", "0"], ["472.21", "210.00", "0", "21", "1000.00"], ["4751", "0", "150.00"], ["410", "0", "1060.00"]]);
    // Cancellation as production does it (invoicing/ledger.port.ts): the reversal carries the opposite
    // 477.21 line and the original entry is marked `status = reversed` — both must count in the cross-check.
    inv3Reversal = (await interimLedgerEngine.reverseJournalEntry({ organizationId: ORG_ID, journalEntryId: inv3Entry, entryDate: "2026-05-22", description: "Anulación FAC-3", createdBy: ctx.userId })).id;
    await post("2026-06-01", "invoice_rectification", `invfisc_${RAND}_r1`, "Rectificativa REC-1", [["705.1", "50.00", "0"], ["477.10", "5.00", "0", "10", "50.00"], ["430", "0", "55.00"]]);
  });

  after(async () => {
    const entries = await prisma.journalEntry.findMany({ where: { organizationId: ORG_ID }, select: { id: true } });
    await prisma.journalLine.deleteMany({ where: { journalEntryId: { in: entries.map((entry) => entry.id) } } });
    await prisma.journalEntry.deleteMany({ where: { organizationId: ORG_ID } });
    await prisma.vatBookEntry.deleteMany({ where: { organizationId: ORG_ID } });
    await prisma.vatSettings.deleteMany({ where: { organizationId: ORG_ID } });
    await prisma.withholdingTaxRecord.deleteMany({ where: { organizationId: ORG_ID } });
    await prisma.supplierBill.deleteMany({ where: { propertyId: PROP_ID } });
    await prisma.supplier.deleteMany({ where: { organizationId: ORG_ID } });
    const invoices = await prisma.invoice.findMany({ where: { propertyId: PROP_ID }, select: { id: true } });
    await prisma.invoiceLine.deleteMany({ where: { invoiceId: { in: invoices.map((invoice) => invoice.id) } } });
    await prisma.invoice.deleteMany({ where: { propertyId: PROP_ID } });
    await prisma.account.deleteMany({ where: { organizationId: ORG_ID } });
    await prisma.accountingSetting.deleteMany({ where: { organizationId: ORG_ID } });
    await prisma.property.deleteMany({ where: { id: PROP_ID } });
    await prisma.organization.deleteMany({ where: { id: ORG_ID } });
    await app?.close();
  });

  it("Modelo 303 de 2026-Q2 desde los documentos (libros sin materializar) cuadra con los libros y con el diario", async () => {
    const report = await buildModelo303({ context: ctx, period: "2026-Q2" });
    assert.equal(report.modelo, "303");
    assert.deepEqual([report.periodo.code, report.periodo.from, report.periodo.to, report.periodo.aeatPeriod], ["2026-Q2", "2026-04-01", "2026-06-30", "2T"]);
    assert.deepEqual(report.declarante, { nif: "B12345674", nombre: "Fiscal Test SL" });
    assert.equal(casilla(report, "04"), 3050);
    assert.equal(casilla(report, "06"), 305);
    assert.equal(casilla(report, "07"), 20);
    assert.equal(casilla(report, "09"), 4.2);
    assert.equal(casilla(report, "01"), 0);
    assert.equal(casilla(report, "27"), 309.2);
    assert.equal(casilla(report, "28"), 1000);
    assert.equal(casilla(report, "29"), 210);
    assert.equal(casilla(report, "45"), 210);
    assert.equal(casilla(report, "46"), 99.2);
    assert.equal(casilla(report, "110"), 0);
    assert.equal(casilla(report, "71"), 99.2);
    assert.equal(report.totales.aIngresar, 99.2);
    assert.equal(report.fuentes.origen, "documentos");
    assert.ok(report.avisos.some((aviso) => /sin filas materializadas/.test(aviso)), report.avisos.join("\n"));
    assert.equal(report.fuentes.libros?.emitidas?.filas, 6);
    assert.equal(report.fuentes.libros?.emitidas?.cuota, 309.2);
    assert.equal(report.fuentes.libros?.recibidas?.cuota, 210);
    assert.equal(report.fuentes.libros?.recibidas?.retencion, 150);
    // t6#8: the cancelled invoice's original entry is `reversed` and its reversal is `posted`, both inside the
    // period; the ledger must net them to zero (as the books do) instead of counting the reversal alone,
    // which used to leave 477.21 at 4,20 − 21,00 = −16,80 versus 25,20 in the books (diferencia 42,00).
    const original = await prisma.journalEntry.findUnique({ where: { id: inv3Entry }, select: { status: true, reversedById: true } });
    assert.deepEqual([original?.status, original?.reversedById], ["reversed", inv3Reversal]);
    const reversal = await prisma.journalEntry.findUnique({ where: { id: inv3Reversal }, select: { status: true, reversalOfId: true, entryKind: true } });
    assert.deepEqual([reversal?.status, reversal?.reversalOfId, reversal?.entryKind], ["posted", inv3Entry, "reversal"]);
    assert.ok(report.fuentes.diario, "ledger cross-check missing");
    assert.equal(report.fuentes.diario.apuntes, 7, "both halves of the reversed pair are counted");
    assert.equal(report.fuentes.diario.cuotaRepercutida, 309.2);
    assert.equal(report.fuentes.diario.cuotaSoportada, 210);
    assert.deepEqual(report.fuentes.diario.diferencias, []);
    assert.equal(report.fuentes.diario.cuadra, true, "a cancelled invoice must not subtract its quota twice (t6#8)");
    assert.equal(report.fuentes.liquidacion, null);
    assert.equal(report.presentacion.modo, "manual");
  });

  it("periodo del tipo equivocado → 400 PERIOD_MISMATCH; rango parcial → 400 INVALID_PERIOD; REDEME exige mensual", async () => {
    await expectError(buildModelo303({ context: ctx, period: "2026-05" }), 400, "PERIOD_MISMATCH");
    await expectError(buildModelo303({ context: ctx, fromDate: "2026-04-02", toDate: "2026-06-30" }), 400, "INVALID_PERIOD");
    assert.equal((await buildModelo303({ context: ctx, fromDate: "2026-04-01", toDate: "2026-06-30" })).periodo.code, "2026-Q2");
    await expectError(updateVatSettings({ context: ctx, patch: { regime: "redeme" } }), 409, "REDEME_REQUIRES_MONTHLY");
    const settings = await getVatSettings(ORG_ID);
    assert.deepEqual([settings.periodicity, settings.regime, settings.taxFigure, settings.persisted], ["quarterly", "general", "IVA", true]);
  });

  it("los libros se materializan con rebuild (idempotente) y el 303 no cambia", async () => {
    const derived = await listVatBook({ context: ctx, book: "emitidas", period: "2026-Q2" });
    assert.equal(derived.origen, "documentos");
    assert.equal(derived.rows.length, 6);
    assert.deepEqual(derived.rows.map((row) => row.sourceType).sort(), ["invoice", "invoice", "invoice", "invoice", "rectification", "simplified"]);
    const cancellation = derived.rows.find((row) => row.sourceId.endsWith(":anulacion"))!;
    assert.deepEqual([cancellation.date, cancellation.base, cancellation.quota, cancellation.rate], ["2026-05-22", -100, -21, 21]);
    assert.equal(derived.resumen.cuota, 309.2);

    const first = await rebuildVatBooks({ context: ctx, from: "2026-01-01", to: "2026-06-30" });
    assert.deepEqual([first.deleted, first.created, first.documentos], [0, { emitidas: 6, recibidas: 2, bienes_inversion: 0 }, { facturas: 5, anulaciones: 1, facturasRecibidas: 2, gastos: 0 }]);
    const second = await rebuildVatBooks({ context: ctx, from: "2026-01-01", to: "2026-06-30" });
    assert.deepEqual([second.deleted, second.created.emitidas + second.created.recibidas], [8, 8]);
    assert.equal(await prisma.vatBookEntry.count({ where: { organizationId: ORG_ID } }), 8);

    const persisted = await listVatBook({ context: ctx, book: "recibidas", period: "2026-Q2" });
    assert.equal(persisted.origen, "libros");
    assert.equal(persisted.rows.length, 1);
    assert.deepEqual([persisted.rows[0]!.base, persisted.rows[0]!.quota, persisted.rows[0]!.retention, persisted.rows[0]!.total, persisted.rows[0]!.counterpartyNif, persisted.rows[0]!.period], [1000, 210, 150, 1210, "B00000003", "2026-Q2"]);

    const report = await buildModelo303({ context: ctx, period: "2026-Q2" });
    assert.equal(report.fuentes.origen, "libros");
    assert.deepEqual([casilla(report, "27"), casilla(report, "45"), casilla(report, "71")], [309.2, 210, 99.2]);
    assert.equal(report.fuentes.diario?.cuadra, true);
  });

  it("Modelo 347: un tercero > 3.005,06 € declarado (clave B, 2T); el proveedor con retención y la simplificada sin NIF quedan fuera", async () => {
    const report = await buildModelo347({ context: ctx, year: 2026 });
    assert.equal(report.periodo.code, "2026");
    assert.equal(report.totales.declarados, 1);
    assert.deepEqual(report.detalle, [{ nif: "B00000002", nombre: "Cliente Grande SL", clave: "B", importeAnual: 3300, t1: 0, t2: 3300, t3: 0, t4: 0, filas: 1 }]);
    // Under the threshold: B00000001 (110 − 55 + 121 − 121 = 55 €) and B00000003 clave A (bill0, 242 € without retention).
    assert.equal(report.totales.tercerosBajoUmbral, 2);
    assert.equal(report.totales.filasConRetencion, 1);
    assert.equal(report.totales.filasSinNif, 1);
    assert.equal(clave(report, "IMPORTE_TOTAL"), 3300);
    assert.ok(report.avisos.some((aviso) => /con retención IRPF \(1210.00 €\)/.test(aviso)), report.avisos.join("\n"));
  });

  it("Modelos 111 / 115 / 180 desde WithholdingTaxRecord con las filas L separadas", async () => {
    const m111 = await buildModelo111({ context: ctx, period: "2026-Q2" });
    assert.deepEqual([casilla(m111, "07"), casilla(m111, "08"), casilla(m111, "09"), casilla(m111, "28"), casilla(m111, "30")], [1, 1000, 150, 150, 150]);
    assert.equal(casilla(m111, "01"), 0);
    assert.equal(m111.fuentes.registros, 1);
    const m115 = await buildModelo115({ context: ctx, fromDate: "2026-04-01", toDate: "2026-06-30" });
    assert.deepEqual([casilla(m115, "01"), casilla(m115, "02"), casilla(m115, "03"), casilla(m115, "05")], [1, 500, 95, 95]);
    const m180 = await buildModelo180({ context: ctx, year: 2026 });
    assert.deepEqual([casilla(m180, "01"), casilla(m180, "02"), casilla(m180, "03")], [1, 500, 95]);
    assert.equal(m180.detalle[0]?.nif, "12345678Z");
    assert.equal(m180.detalle[0]?.referenciaCatastral, "1234567AB0001XX");
    assert.deepEqual(m180.fuentes.periodos?.map((quarter) => quarter.resultado), [0, 95, 0, 0]);
  });

  it("liquidación: Q1 a compensar (D 4700 42) y Q2 con compensación aplicada; asiento numerado y cuadrado; reverso marcado", async () => {
    await expectError(settleVatPeriod({ context: ctx, period: "2026-Q3" }), 409, "PERIOD_NOT_ENDED");
    const q1 = await settleVatPeriod({ context: ctx, period: "2026-Q1" });
    assert.equal(q1.resultado, "to_offset");
    assert.equal(q1.importe, 42);
    assert.deepEqual(q1.lines.map((line) => [line.accountCode, line.debit, line.credit]), [["472.21", 0, 42], ["4700", 42, 0]]);
    assert.equal(q1.fiscalYearCode, "2026");
    assert.equal(q1.entryNumber, 9); // 8 document entries were posted first
    assert.equal(q1.entryDate, "2026-03-31");

    const preview = await previewVatSettlement({ context: ctx, period: "2026-Q2" });
    assert.equal(preview.balanced, true);
    assert.deepEqual([preview.compensacionPendienteInicial, preview.compensacionAplicada, preview.compensacionPendienteFinal, preview.resultado, preview.importe], [42, 42, 0, "to_pay", 57.2]);
    assert.deepEqual(
      preview.lines.map((line) => [line.accountCode, line.debit, line.credit, line.taxRateCode, line.taxBase]),
      [
        ["477.21", 4.2, 0, "21", 20],
        ["477.10", 305, 0, "10", 3050],
        ["472.21", 0, 210, "21", 1000],
        ["4700", 0, 42, null, null],
        ["4750", 0, 57.2, null, null]
      ]
    );
    assert.deepEqual([preview.totalDebit, preview.totalCredit], [309.2, 309.2]);
    assert.equal(casilla(preview.modelo303, "110"), 42);
    assert.equal(casilla(preview.modelo303, "78"), 42);
    assert.equal(casilla(preview.modelo303, "71"), 57.2);
    assert.equal(preview.existing, null);

    const q2 = await settleVatPeriod({ context: ctx, period: "2026-Q2" });
    assert.equal(q2.entryNumber, 10);
    const entry = await prisma.journalEntry.findUnique({ where: { id: q2.journalEntryId } });
    assert.ok(entry);
    assert.deepEqual([entry.sourceType, entry.sourceId, entry.status, entry.entryDate.toISOString().slice(0, 10), entry.fiscalYearCode, entry.entryNumber], ["vat_settlement", "vat-settlement:2026-Q2", "posted", "2026-06-30", "2026", 10]);
    const lines = await prisma.journalLine.findMany({ where: { journalEntryId: entry.id } });
    const debit = lines.reduce((sum, line) => sum.plus(line.debit), ZERO);
    const credit = lines.reduce((sum, line) => sum.plus(line.credit), ZERO);
    assert.equal(debit.toFixed(2), "309.20");
    assert.equal(credit.toFixed(2), "309.20");
    assert.ok(lines.every((line) => line.accountCode !== null));
    assert.equal(lines.find((line) => line.accountCode === "4750")?.credit.toFixed(2), "57.20");

    await expectError(settleVatPeriod({ context: ctx, period: "2026-Q2" }), 409, "ALREADY_SETTLED");
    const settled = await buildModelo303({ context: ctx, period: "2026-Q2" });
    assert.equal(settled.fuentes.liquidacion?.journalEntryId, q2.journalEntryId);
    assert.equal(settled.fuentes.liquidacion?.reversed, false);
    assert.equal(settled.fuentes.diario?.cuadra, true, "the settlement entry must not disturb the cross-check");
    assert.equal(casilla(await buildModelo303({ context: ctx, period: "2026-Q3" }), "110"), 0);

    const reversal = await reverseVatSettlement({ context: ctx, period: "2026-Q2", reason: "prueba de integración" });
    assert.equal(reversal.reversedJournalEntryId, q2.journalEntryId);
    assert.equal(reversal.entryNumber, 11);
    const reversed = await prisma.journalEntry.findUnique({ where: { id: q2.journalEntryId } });
    assert.deepEqual([reversed?.status, reversed?.reversedById], ["reversed", reversal.reversalJournalEntryId]);
    const reversalEntry = await prisma.journalEntry.findUnique({ where: { id: reversal.reversalJournalEntryId } });
    assert.deepEqual([reversalEntry?.sourceType, reversalEntry?.reversalOfId, reversalEntry?.entryKind], ["reversal", q2.journalEntryId, "reversal"]);
    assert.equal(await prisma.journalEntry.count({ where: { organizationId: ORG_ID } }), 11, "nothing is ever deleted");
    const afterReversal = await buildModelo303({ context: ctx, period: "2026-Q2" });
    assert.equal(afterReversal.fuentes.liquidacion?.reversed, true);
    assert.equal(casilla(await buildModelo303({ context: ctx, period: "2026-Q3" }), "110"), 42, "Q1 compensation is pending again once Q2 is reversed");
  });

  it("Modelo 390: agrega los cuatro trimestres y marca los no liquidados", async () => {
    const report = await buildModelo390({ context: ctx, year: 2026 });
    assert.deepEqual([clave(report, "DEV_CUOTA_10"), clave(report, "DEV_CUOTA_21"), clave(report, "DED_CUOTA_CORRIENTE"), clave(report, "RESULTADO_REGIMEN_GENERAL")], [305, 4.2, 252, 57.2]);
    assert.equal(clave(report, "VOLUMEN_OPERACIONES"), 3070);
    assert.equal(report.detalle.length, 4);
    assert.deepEqual(report.detalle.map((row) => row.liquidado), ["sí", "no", "no", "no"]);
    assert.ok(report.casillas.every((box) => box.casilla === null));
    assert.ok(report.avisos.some((aviso) => /numeración de casillas pendiente/.test(aviso)));
  });

  it("rutas HTTP sobre una app Fastify mínima (registerFiscalRoutes, org de test): JSON, PDF, validación estricta y 409 de negocio", async () => {
    // fastify only lives under apps/api/node_modules: resolve it from there. The
    // minimal app has no RBAC hook (the services enforce permissions) and uses
    // Fastify's default error handler (statusCode honoured, no `details`).
    const requireFromApi = createRequire(new URL("../../apps/api/src/server.ts", import.meta.url));
    const fastifyFactory = requireFromApi("fastify") as () => ApiApp;
    const mini = fastifyFactory();
    mini.decorateRequest("userContext", null);
    mini.addHook("onRequest", async (request) => {
      (request as unknown as { userContext: UserContext }).userContext = ctx;
    });
    registerFiscalRoutes(mini);
    await mini.ready();
    try {
      const json = await mini.inject({ method: "GET", url: "/fiscal/models/303?period=2026-Q2" });
      assert.equal(json.statusCode, 200, json.body);
      const body = JSON.parse(json.body) as Report;
      assert.deepEqual([body.modelo, body.periodo.code, casilla(body, "27"), casilla(body, "110"), casilla(body, "71")], ["303", "2026-Q2", 309.2, 42, 57.2]);

      const pdf = await mini.inject({ method: "GET", url: "/fiscal/models/303/pdf?period=2026-Q2" });
      assert.equal(pdf.statusCode, 200, pdf.body.slice(0, 200));
      assert.equal(pdf.headers["content-type"], "application/pdf");
      assert.equal(pdf.rawPayload.subarray(0, 5).toString("latin1"), "%PDF-");
      assert.equal(Number(pdf.headers["content-length"]), pdf.rawPayload.length);
      assert.match(String(pdf.headers["content-disposition"]), /modelo-303-2026-Q2\.pdf/);
      for (const url of ["/fiscal/models/347?year=2026", "/fiscal/models/390?year=2026", "/fiscal/models/180?year=2026", "/fiscal/models/111?period=2026-Q2", "/fiscal/models/115?period=2026-Q2", "/fiscal/models/347/pdf?year=2026"]) {
        const res = await mini.inject({ method: "GET", url });
        assert.equal(res.statusCode, 200, `${url}: ${res.body.slice(0, 200)}`);
      }

      assert.equal((await mini.inject({ method: "GET", url: "/fiscal/models/999?period=2026-Q2" })).statusCode, 400);
      assert.equal((await mini.inject({ method: "GET", url: "/fiscal/models/303?period=2026-13" })).statusCode, 400);
      assert.equal((await mini.inject({ method: "GET", url: "/fiscal/models/303?period=2026-05" })).statusCode, 400);
      assert.equal((await mini.inject({ method: "GET", url: "/fiscal/models/390" })).statusCode, 400);
      assert.equal((await mini.inject({ method: "GET", url: "/fiscal/vat-books?book=emitidas&period=2026-Q2&foo=1" })).statusCode, 400);

      const books = await mini.inject({ method: "GET", url: "/fiscal/vat-books?book=emitidas&period=2026-Q2" });
      assert.equal(books.statusCode, 200, books.body);
      const bookBody = JSON.parse(books.body) as { origen: string; rows: unknown[]; resumen: { cuota: number } };
      assert.deepEqual([bookBody.origen, bookBody.rows.length, bookBody.resumen.cuota], ["libros", 6, 309.2]);

      const settings = await mini.inject({ method: "GET", url: "/fiscal/vat-settings" });
      assert.equal(settings.statusCode, 200);
      // Tanda 6b (L5, R8): the response gains the additive `sociedad` badge
      // (declarante + régimen). This org has no LegalEntity (no backfill), so the
      // badge falls back to the deprecated Organization columns.
      const { sociedad, ...legacySettings } = JSON.parse(settings.body) as { sociedad: { source: string; taxId: string | null; regimen: { periodicity: string } } } & Record<string, unknown>;
      assert.deepEqual(legacySettings, { organizationId: ORG_ID, periodicity: "quarterly", regime: "general", prorrataPct: null, taxFigure: "IVA", persisted: true });
      assert.deepEqual([sociedad.source, sociedad.taxId, sociedad.regimen.periodicity], ["organization_fallback", "B12345674", "quarterly"]);
      assert.equal((await mini.inject({ method: "PUT", url: "/fiscal/vat-settings", payload: { periodicity: "weekly" } })).statusCode, 400);

      const preview = await mini.inject({ method: "GET", url: "/fiscal/vat-settlement?period=2026-Q2" });
      assert.equal(preview.statusCode, 200, preview.body);
      assert.equal((JSON.parse(preview.body) as { balanced: boolean; existing: unknown }).existing, null);
      const notEnded = await mini.inject({ method: "POST", url: "/fiscal/vat-settlement", payload: { period: "2026-Q3" } });
      assert.equal(notEnded.statusCode, 409, notEnded.body);
      assert.match(notEnded.body, /no ha terminado/);
      const strictBody = await mini.inject({ method: "POST", url: "/fiscal/vat-settlement", payload: { period: "2026-Q2", force: true } });
      assert.equal(strictBody.statusCode, 400);
      assert.equal(await prisma.journalEntry.count({ where: { organizationId: ORG_ID } }), 11, "the HTTP probes must not post anything");
    } finally {
      await mini.close();
    }
  });

  it("rutas HTTP (org_123): JSON, PDF, validación estricta y modelo desconocido", async (t) => {
    if (!app) return t.skip(`server.ts no cargable: ${serverLoadError}`);
    if (!headers.authorization) return t.skip("demo login unavailable");
    const json = await app.inject({ method: "GET", url: `${prefix}/fiscal/models/303?period=2026-Q3`, headers });
    assert.equal(json.statusCode, 200, json.body);
    const body = JSON.parse(json.body) as Report;
    assert.equal(body.modelo, "303");
    assert.equal(body.periodo.code, "2026-Q3");
    assert.ok(Array.isArray(body.casillas) && body.casillas.some((box) => box.casilla === "71"));

    const pdf = await app.inject({ method: "GET", url: `${prefix}/fiscal/models/303/pdf?period=2026-Q3`, headers });
    assert.equal(pdf.statusCode, 200, pdf.body.slice(0, 200));
    assert.equal(pdf.headers["content-type"], "application/pdf");
    assert.ok(pdf.rawPayload.subarray(0, 5).toString("latin1") === "%PDF-");
    assert.match(String(pdf.headers["content-disposition"]), /modelo-303-2026-Q3\.pdf/);

    const annual = await app.inject({ method: "GET", url: `${prefix}/fiscal/models/347?year=2026`, headers });
    assert.equal(annual.statusCode, 200, annual.body);
    const unknown = await app.inject({ method: "GET", url: `${prefix}/fiscal/models/999?period=2026-Q3`, headers });
    assert.equal(unknown.statusCode, 400);
    assert.equal((JSON.parse(unknown.body) as HttpErrorLike).details?.code, "UNKNOWN_MODEL");
    const badPeriod = await app.inject({ method: "GET", url: `${prefix}/fiscal/models/303?period=2026-13`, headers });
    assert.equal(badPeriod.statusCode, 400);
    const strict = await app.inject({ method: "GET", url: `${prefix}/fiscal/vat-books?book=emitidas&period=2026-Q3&foo=1`, headers });
    assert.equal(strict.statusCode, 400);
    assert.equal((JSON.parse(strict.body) as HttpErrorLike).details?.code, "VALIDATION_ERROR");
    const books = await app.inject({ method: "GET", url: `${prefix}/fiscal/vat-books?book=emitidas&period=2026-Q3`, headers });
    assert.equal(books.statusCode, 200, books.body);
    const settings = await app.inject({ method: "GET", url: `${prefix}/fiscal/vat-settings`, headers });
    assert.equal(settings.statusCode, 200);
    assert.equal((JSON.parse(settings.body) as { periodicity: string }).periodicity, "quarterly");
    const settlement = await app.inject({ method: "GET", url: `${prefix}/fiscal/vat-settlement?period=2026-Q3`, headers });
    assert.equal(settlement.statusCode, 200, settlement.body);
    assert.equal((JSON.parse(settlement.body) as { balanced: boolean }).balanced, true);
  });

  it("Faranda obtiene su 303 del trimestre en curso sin una sola escritura", async () => {
    const before = await farandaCounts();
    const report = await buildModelo303({ context: farandaCtx, period: "2026-Q3" });
    assert.equal(report.modelo, "303");
    assert.equal(report.periodo.code, "2026-Q3");
    // Tras la migración Faranda → CELUISMA (runbook §17.13) la sociedad declarante es CEL · A33615980 (NIF real solo en la demo local).
    assert.equal(report.declarante.nif, "A33615980");
    assert.ok(report.casillas.some((box) => box.casilla === "71"));
    assert.equal(report.fuentes.origen, "documentos");
    const annual = await buildModelo390({ context: farandaCtx, year: 2026 });
    assert.equal(annual.modelo, "390");
    assert.deepEqual(await farandaCounts(), before);
    // Printed for the lot report (real Faranda figures, read-only).
    console.log(`[fiscal-models] Faranda 303 2026-Q3: 27=${casilla(report, "27")} 45=${casilla(report, "45")} 71=${casilla(report, "71")} emitidas=${report.fuentes.libros?.emitidas?.filas} avisos=${report.avisos.length}`);
  });
});

describe("fiscal · cotejo diario↔libros con la anulación en otro trimestre (t6#8, org de test propia)", () => {
  const ORG_X = `orgfiscx_${RAND}`;
  const PROP_X = `propfiscx_${RAND}`;
  const scope: LedgerScope = { organizationId: ORG_X, propertyId: PROP_X };
  const ctxX: UserContext = { ...ctx, organizationId: ORG_X, propertyId: PROP_X };
  const invX = `invfiscx_${RAND}_1`;
  let originalId = "";
  let reversalId = "";

  before(async () => {
    await prisma.organization.create({ data: { id: ORG_X, name: "Fiscal Cruce SL", legalName: "Fiscal Cruce SL", taxId: "B12345674" } });
    await prisma.property.create({ data: { id: PROP_X, organizationId: ORG_X, name: "Hotel Fiscal Cruce", timezone: "Europe/Madrid" } });
    await provisionOrganizationChart(ORG_X);
    // Issued in Q2 (2026-06-20), cancelled in Q3 (2026-07-03): the books carry +21 in Q2 and −21 in Q3.
    await createInvoice({ id: invX, number: `FAC-X${RAND}-1`, type: "F1", status: "cancelled", issuedAt: "2026-06-20T10:00:00.000Z", cancelledAt: "2026-07-03T09:00:00.000Z", gross: "121.00", tax: "21.00", rate: "21", nif: "B00000001", name: "Cliente Uno SL", breakdown: true, seriesCode: "FAC", propertyId: PROP_X });
    originalId = (await post("2026-06-20", "invoice", invX, "Factura FAC-X1", [["430", "121.00", "0"], ["705.1", "0", "100.00"], ["477.21", "0", "21.00", "21", "100.00"]], scope)).id;
    reversalId = (await interimLedgerEngine.reverseJournalEntry({ organizationId: ORG_X, journalEntryId: originalId, entryDate: "2026-07-03", description: "Anulación FAC-X1", createdBy: ctx.userId })).id;
  });

  after(async () => {
    const entries = await prisma.journalEntry.findMany({ where: { organizationId: ORG_X }, select: { id: true } });
    await prisma.journalLine.deleteMany({ where: { journalEntryId: { in: entries.map((entry) => entry.id) } } });
    await prisma.journalEntry.deleteMany({ where: { organizationId: ORG_X } });
    await prisma.vatBookEntry.deleteMany({ where: { organizationId: ORG_X } });
    await prisma.vatSettings.deleteMany({ where: { organizationId: ORG_X } });
    await prisma.invoiceLine.deleteMany({ where: { invoiceId: invX } });
    await prisma.invoice.deleteMany({ where: { propertyId: PROP_X } });
    await prisma.account.deleteMany({ where: { organizationId: ORG_X } });
    await prisma.accountingSetting.deleteMany({ where: { organizationId: ORG_X } });
    await prisma.property.deleteMany({ where: { id: PROP_X } });
    await prisma.organization.deleteMany({ where: { id: ORG_X } });
  });

  it("Q2 conserva la cuota de la factura original (status reversed) y Q3 solo la de la anulación; ambos cotejos cuadran", async () => {
    const original = await prisma.journalEntry.findUnique({ where: { id: originalId }, select: { status: true, reversedById: true, entryDate: true } });
    assert.deepEqual([original?.status, original?.reversedById, original?.entryDate.toISOString().slice(0, 10)], ["reversed", reversalId, "2026-06-20"]);

    const q2 = await buildModelo303({ context: ctxX, period: "2026-Q2" });
    assert.deepEqual([casilla(q2, "07"), casilla(q2, "09"), casilla(q2, "27")], [100, 21, 21]);
    assert.equal(q2.fuentes.libros?.emitidas?.filas, 1);
    assert.deepEqual(q2.fuentes.diario, { apuntes: 1, cuotaRepercutida: 21, cuotaSoportada: 0, diferencias: [], cuadra: true }, "the reversed original still counts in its own period");

    const q3 = await buildModelo303({ context: ctxX, period: "2026-Q3" });
    assert.deepEqual([casilla(q3, "07"), casilla(q3, "09"), casilla(q3, "27")], [-100, -21, -21]);
    assert.equal(q3.fuentes.libros?.emitidas?.filas, 1);
    assert.deepEqual(q3.fuentes.diario, { apuntes: 1, cuotaRepercutida: -21, cuotaSoportada: 0, diferencias: [], cuadra: true }, "only the reversal belongs to the cancellation period");
    assert.equal(await prisma.journalEntry.count({ where: { organizationId: ORG_X } }), 2, "nothing is ever deleted");
  });
});
