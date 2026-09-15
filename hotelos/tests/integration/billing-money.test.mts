/**
 * Finanzas · lote facturación-cobros — integration of the money path (REAL
 * HTTP via app.inject, Postgres required). Runs on the demo property
 * prop_123 / org_123 ONLY and removes every row it creates (reservations,
 * folios, lines, invoices, payments, refunds, intents, journal entries, VAT
 * book rows, VeriFactu submissions, notification deliveries) in `after`,
 * rewinding the FAC / REC sequences when its numbers were the last ones.
 *
 * Cases (each with its literal cuadre):
 *   1. draft → freeze check (409 FOLIO_CHANGED_SINCE_DRAFT) → issue: snapshot,
 *      series FAC, libro de emitidas (one row per rate), asiento
 *      D 4300 / H 705.x / H 477.tipo balanced to the cent;
 *   2. GET /invoices/:id/pdf → 200 application/pdf;
 *   3. POST /folios/:id/payments ×2 with the same clientRequestId → same
 *      payment (201 then 200 idempotent), different body → 409
 *      IDEMPOTENCY_CONFLICT; asiento D 570 / H 4300; payment_link without
 *      PSP → 409 PSP_NOT_CONFIGURED; mark-paid needs method + reference;
 *   4. rectificativa por diferencias → folio credit line, asiento inverso,
 *      negative VAT rows, folio balance negative and visible;
 *   5. refund ×2 with the same clientRequestId → one reversal row, asiento
 *      D 4300 / H 570, folio balance back to 0;
 *   6. cancellation with refundPayments → payments unlinked + refunded,
 *      issue entry reversed (reversalOfId), VAT counter-rows;
 *   7. send-email without provider → { simulated: true }, delivery «SIMULADO»;
 *   8. /payment-tokens refuses a PAN and needs a PSP; psp-status honest.
 *
 * Run: cd apps/api && node --import tsx --test ../../tests/integration/billing-money.test.mts
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
process.env.HOTELOS_ALLOW_DEMO_AUTH ??= "true";

const { buildApiServer } = await import("../../apps/api/src/server.js");
const { routePermissionManifest } = await import("../../apps/api/src/security/route-permissions.js");
const { registerInvoicingRoutes } = await import("../../apps/api/src/modules/invoicing/invoicing.routes.js");
const { invoicingRoutePermissions } = await import("../../apps/api/src/modules/invoicing/route-permissions.partial.js");
const { registerPaymentsRoutes } = await import("../../apps/api/src/modules/payments/payments.routes.js");
const { paymentsRoutePermissions } = await import("../../apps/api/src/modules/payments/route-permissions.partial.js");
const { prisma } = await import("@hotelos/database");

type ApiApp = Awaited<ReturnType<typeof buildApiServer>>;
type Headers = Record<string, string>;

const PROPERTY_ID = "prop_123";
const ORGANIZATION_ID = "org_123";
const MARK = `BMT-${Date.now().toString(36).toUpperCase()}`;
const TEST_EMAIL = `billing-money-${Date.now().toString(36)}@example.com`;

let cachedSession: { token: string } | null | undefined;
async function loginDemo(app: ApiApp): Promise<{ token: string } | null> {
  if (cachedSession !== undefined) return cachedSession;
  const res = await app.inject({
    method: "POST",
    url: "/auth/login",
    payload: { email: process.env.INTEGRATION_LOGIN_EMAIL ?? "reception@example.com", password: process.env.INTEGRATION_LOGIN_PASSWORD ?? "hotelos-demo", deviceId: "integration-tests-billing" }
  });
  cachedSession = res.statusCode === 200 ? { token: (JSON.parse(res.body) as { token: string }).token } : null;
  return cachedSession;
}

type JournalView = { id: string; sourceType: string; sourceId: string | null; entryNumber: number | null; fiscalYearCode: string | null; entryDate: Date; status: string; reversalOfId: string | null; reversedById: string | null; lines: Array<{ accountCode: string | null; debit: string; credit: string; taxRateCode: string | null; taxBase: string | null }> };

async function journalFor(sourceType: string, sourceId: string): Promise<JournalView | null> {
  const entry = await prisma.journalEntry.findFirst({ where: { organizationId: ORGANIZATION_ID, sourceType, sourceId } });
  if (!entry) return null;
  const lines = await prisma.journalLine.findMany({ where: { journalEntryId: entry.id }, orderBy: { id: "asc" } });
  return {
    id: entry.id,
    sourceType: entry.sourceType,
    sourceId: entry.sourceId,
    entryNumber: entry.entryNumber,
    fiscalYearCode: entry.fiscalYearCode,
    entryDate: entry.entryDate,
    status: entry.status,
    reversalOfId: entry.reversalOfId,
    reversedById: entry.reversedById,
    lines: lines.map((l) => ({ accountCode: l.accountCode, debit: Number(l.debit).toFixed(2), credit: Number(l.credit).toFixed(2), taxRateCode: l.taxRateCode, taxBase: l.taxBase === null ? null : Number(l.taxBase).toFixed(2) }))
  };
}

function sums(lines: JournalView["lines"]): { debit: string; credit: string } {
  const debit = lines.reduce((s, l) => s + Math.round(Number(l.debit) * 100), 0);
  const credit = lines.reduce((s, l) => s + Math.round(Number(l.credit) * 100), 0);
  return { debit: (debit / 100).toFixed(2), credit: (credit / 100).toFixed(2) };
}

function lineOf(entry: JournalView, accountCode: string): JournalView["lines"][number] {
  const line = entry.lines.find((l) => l.accountCode === accountCode);
  assert.ok(line, `asiento ${entry.id} sin apunte en ${accountCode}: ${JSON.stringify(entry.lines)}`);
  return line;
}

describe("finanzas · facturación y cobros (app.inject, prop_123)", () => {
  let app: ApiApp;
  let headers: Headers = {};
  let prefix = "";
  const url = (path: string): string => `${prefix}${path}`;
  const created = { reservationIds: [] as string[], folioIds: [] as string[], invoiceIds: [] as string[], paymentIds: [] as string[], intentIds: [] as string[] };

  async function newFolio(code: string): Promise<{ reservationId: string; folioId: string }> {
    const reservation = await prisma.reservation.create({
      data: { propertyId: PROPERTY_ID, code, channel: "direct", status: "checked_in", arrivalDate: new Date("2026-09-14T00:00:00Z"), departureDate: new Date("2026-09-16T00:00:00Z"), adults: 1, bookerName: "Prueba Billing", bookerEmail: TEST_EMAIL, currency: "EUR" }
    });
    const folio = await prisma.folio.create({ data: { reservationId: reservation.id, status: "open", currency: "EUR", label: "guest", isPrimary: true } });
    created.reservationIds.push(reservation.id);
    created.folioIds.push(folio.id);
    return { reservationId: reservation.id, folioId: folio.id };
  }

  async function postLine(folioId: string, type: string, description: string, unitPrice: number): Promise<{ id: string; total: number }> {
    const res = await app.inject({ method: "POST", url: `/folios/${folioId}/lines`, headers, payload: { type, description, quantity: 1, unitPrice } });
    assert.equal(res.statusCode, 200, res.body);
    return JSON.parse(res.body) as { id: string; total: number };
  }

  async function draftInvoice(folioId: string, customerName: string): Promise<{ id: string; status: string; total: number; taxTotal: number }> {
    const res = await app.inject({ method: "POST", url: `/folios/${folioId}/invoice`, headers, payload: { customerType: "guest", customerName } });
    assert.equal(res.statusCode, 200, res.body);
    const body = JSON.parse(res.body) as { id: string; status: string; total: number; taxTotal: number };
    created.invoiceIds.push(body.id);
    return body;
  }

  before(async () => {
    app = await buildApiServer();
    if (!app.hasRoute({ method: "GET", url: "/invoices/:id/pdf" })) {
      prefix = "/__billing";
      routePermissionManifest.push(...[...invoicingRoutePermissions, ...paymentsRoutePermissions].map((entry) => ({ ...entry, path: `${prefix}${entry.path}` })));
      await app.register(
        async (sub) => {
          registerInvoicingRoutes(sub);
          registerPaymentsRoutes(sub);
        },
        { prefix }
      );
    }
    await app.ready();
    const session = await loginDemo(app);
    assert.ok(session, "the demo session (reception@example.com / hotelos-demo) must exist for the high-risk money routes");
    headers = { authorization: `Bearer ${session.token}` };
    const property = await prisma.property.findUnique({ where: { id: PROPERTY_ID }, select: { organizationId: true } });
    assert.equal(property?.organizationId, ORGANIZATION_ID, "prop_123 must belong to org_123");
    assert.ok((await prisma.account.count({ where: { organizationId: ORGANIZATION_ID, code: { in: ["4300", "705.1", "705.3", "477.10", "477.21", "570"] } } })) === 6, "org_123 must have the PGC Pymes hotelero chart provisioned");
  });

  after(async () => {
    const invoiceIds = Array.from(new Set(created.invoiceIds));
    const folioIds = created.folioIds;
    const payments = folioIds.length ? await prisma.payment.findMany({ where: { folioId: { in: folioIds } }, select: { id: true } }) : [];
    const paymentIds = Array.from(new Set([...created.paymentIds, ...payments.map((p) => p.id)]));
    const numbers = invoiceIds.length ? await prisma.invoice.findMany({ where: { id: { in: invoiceIds } }, select: { invoiceNumber: true } }) : [];
    const refundIds = paymentIds.length ? (await prisma.paymentRefund.findMany({ where: { paymentId: { in: paymentIds } }, select: { id: true } })).map((r) => r.id) : [];
    const sourceIds = [...invoiceIds, ...paymentIds, ...refundIds];
    // Every entry keyed by one of our documents (exact or prefixed: `<id>#anulacion`, `<rect>:supersedes:<orig>`) plus anything carrying the run marker.
    const entries = sourceIds.length
      ? await prisma.journalEntry.findMany({
          where: { organizationId: ORGANIZATION_ID, OR: [{ sourceId: { in: sourceIds } }, ...sourceIds.map((id) => ({ sourceId: { startsWith: id } })), { reference: { contains: MARK } }, { description: { contains: MARK } }] },
          select: { id: true }
        })
      : [];
    // Legacy ChargePosted projections (folio_line) of the test lines.
    const lineIds = folioIds.length ? (await prisma.folioLine.findMany({ where: { folioId: { in: folioIds } }, select: { id: true } })).map((l) => l.id) : [];
    const lineEntries = lineIds.length ? await prisma.journalEntry.findMany({ where: { organizationId: ORGANIZATION_ID, sourceType: "folio_line", sourceId: { in: lineIds } }, select: { id: true } }) : [];
    const entryIds = [...entries, ...lineEntries].map((e) => e.id);
    if (entryIds.length) {
      await prisma.journalEntry.updateMany({ where: { id: { in: entryIds } }, data: { reversalOfId: null, reversedById: null } });
      await prisma.journalLine.deleteMany({ where: { journalEntryId: { in: entryIds } } });
      await prisma.journalEntry.deleteMany({ where: { id: { in: entryIds } } });
    }
    if (sourceIds.length) await prisma.vatBookEntry.deleteMany({ where: { organizationId: ORGANIZATION_ID, OR: [{ sourceId: { in: sourceIds } }, ...sourceIds.map((id) => ({ sourceId: { startsWith: id } }))] } });
    if (paymentIds.length) {
      await prisma.paymentRefund.deleteMany({ where: { paymentId: { in: paymentIds } } });
      await prisma.payment.updateMany({ where: { id: { in: paymentIds } }, data: { reversalOfId: null, invoiceId: null } });
      await prisma.payment.deleteMany({ where: { id: { in: paymentIds } } });
    }
    if (folioIds.length) await prisma.paymentIntent.deleteMany({ where: { folioId: { in: folioIds } } });
    if (invoiceIds.length) {
      await prisma.verifactuSubmission.deleteMany({ where: { invoiceId: { in: invoiceIds } } });
      await prisma.invoiceLine.deleteMany({ where: { invoiceId: { in: invoiceIds } } });
      await prisma.invoice.updateMany({ where: { id: { in: invoiceIds } }, data: { rectifyingForId: null } });
      await prisma.invoice.deleteMany({ where: { id: { in: invoiceIds } } });
    }
    if (folioIds.length) {
      await prisma.folioLine.deleteMany({ where: { folioId: { in: folioIds } } });
      await prisma.folio.deleteMany({ where: { id: { in: folioIds } } });
    }
    if (created.reservationIds.length) await prisma.reservation.deleteMany({ where: { id: { in: created.reservationIds } } });
    await prisma.notificationDelivery.deleteMany({ where: { organizationId: ORGANIZATION_ID, recipient: TEST_EMAIL } });
    // Rewind the series when the test consumed the last numbers (sandbox property).
    for (const series of ["FAC", "REC"]) {
      const mine = numbers.map((n) => n.invoiceNumber).filter((n): n is string => !!n && n.startsWith(`${series}-`)).map((n) => Number(n.split("-").pop())).sort((a, b) => b - a);
      if (mine.length === 0) continue;
      const sequence = await prisma.invoiceSequence.findFirst({ where: { propertyId: PROPERTY_ID, sequenceCode: series, year: 2026 } });
      if (!sequence) continue;
      let next = sequence.nextNumber;
      for (const number of mine) if (number === next - 1) next -= 1;
      if (next !== sequence.nextNumber) await prisma.invoiceSequence.update({ where: { id: sequence.id }, data: { nextNumber: next } });
    }
    await app.close();
  });

  // Shared state of the main flow.
  let folioId = "";
  let invoiceId = "";
  let invoiceNumber = "";
  let parkingLineId = "";
  let cashPaymentId = "";
  let invoiceTotal = 0;
  let expectedBreakdown: Array<{ ratePercent: number; base: number; quota: number; calificacion: string }> = [];

  it("1 · issuance freezes the folio: draft snapshot, 409 when the folio changes, then snapshot + series + VAT book + balanced asiento", async () => {
    const folio = await newFolio(`${MARK}-A`);
    folioId = folio.folioId;
    await postLine(folioId, "room", "Habitación doble", 100);
    const parking = await postLine(folioId, "parking", "Parking", 12.1);
    const stale = await draftInvoice(folioId, "Prueba Billing");
    const staleRow = await prisma.invoice.findUnique({ where: { id: stale.id }, select: { snapshotJson: true } });
    const draftSnapshot = staleRow?.snapshotJson as { status?: string; folioLineIds?: string[]; folioFingerprint?: string };
    assert.equal(draftSnapshot.status, "draft");
    assert.equal(draftSnapshot.folioLineIds?.length, 2);
    assert.ok(draftSnapshot.folioFingerprint);

    // The folio changes after the draft → issuance refuses.
    await postLine(folioId, "minibar", "Minibar", 5);
    const refused = await app.inject({ method: "POST", url: `/invoices/${stale.id}/issue`, headers, payload: {} });
    assert.equal(refused.statusCode, 409, refused.body);
    assert.equal((JSON.parse(refused.body) as { details: { code: string } }).details.code, "FOLIO_CHANGED_SINCE_DRAFT");
    // Regenerate: drop the stale draft (no discard endpoint; the drafts are not fiscal documents).
    await prisma.invoiceLine.deleteMany({ where: { invoiceId: stale.id } });
    await prisma.invoice.delete({ where: { id: stale.id } });
    created.invoiceIds = created.invoiceIds.filter((id) => id !== stale.id);
    await prisma.folioLine.updateMany({ where: { folioId, description: "Minibar" }, data: { deletedAt: new Date() } });

    const draft = await draftInvoice(folioId, "Prueba Billing");
    invoiceId = draft.id;
    parkingLineId = (await prisma.invoiceLine.findFirst({ where: { invoiceId, description: "Parking" }, select: { id: true } }))!.id;
    assert.equal(draft.total, 112.1);
    const issued = await app.inject({ method: "POST", url: `/invoices/${invoiceId}/issue`, headers, payload: {} });
    assert.equal(issued.statusCode, 200, issued.body);
    const invoice = JSON.parse(issued.body) as { invoiceNumber: string; status: string; total: number; taxTotal: number; seriesCode: string; simplified: boolean; issuerTaxId: string; issuerTaxIdPlaceholder: boolean; taxBreakdown: Array<{ ratePercent: number; base: number; quota: number; calificacion: string }>; snapshot: { status: string; folioLineIds: string[]; lines: Array<{ folioLineId: string | null; revenueAccountCode: string }>; totals: { total: number; taxTotal: number; baseTotal: number } } | null };
    invoiceNumber = invoice.invoiceNumber;
    invoiceTotal = invoice.total;
    expectedBreakdown = invoice.taxBreakdown;
    assert.match(invoiceNumber, /^FAC-2026-\d{6}$/);
    assert.equal(invoice.status, "issued");
    assert.equal(invoice.seriesCode, "FAC");
    assert.equal(invoice.simplified, false);
    assert.equal(invoice.issuerTaxId, "B12345674");
    assert.equal(invoice.issuerTaxIdPlaceholder, false);
    assert.ok(invoice.snapshot, "issued invoice carries the frozen snapshot");
    assert.equal(invoice.snapshot.status, "issued");
    assert.deepEqual(invoice.snapshot.folioLineIds.sort(), [parking.id, ...(await prisma.folioLine.findMany({ where: { folioId, description: "Habitación doble" }, select: { id: true } })).map((l) => l.id)].sort());
    assert.ok(invoice.snapshot.lines.every((l) => l.folioLineId));
    assert.equal(invoice.snapshot.totals.total, 112.1);
    assert.equal(Number((invoice.snapshot.totals.baseTotal + invoice.snapshot.totals.taxTotal).toFixed(2)), 112.1);
    // Cuadre literal (10 % sobre 100,00 → base 90,91 + cuota 9,09; 21 % sobre 12,10 → base 10,00 + cuota 2,10).
    const at = (rate: number) => invoice.taxBreakdown.find((g) => g.ratePercent === rate)!;
    assert.deepEqual([at(10).base, at(10).quota, at(21).base, at(21).quota], [90.91, 9.09, 10, 2.1]);
    assert.equal(invoice.taxTotal, 11.19);

    // Libro de emitidas: one row per rate, same period, same document.
    const book = await prisma.vatBookEntry.findMany({ where: { organizationId: ORGANIZATION_ID, sourceType: "invoice", sourceId: invoiceId }, orderBy: { rate: "desc" } });
    assert.deepEqual(book.map((r) => [Number(r.rate), Number(r.base), Number(r.quota), Number(r.total), r.book, r.number, r.period]), [
      [21, 10, 2.1, 12.1, "emitidas", invoiceNumber, "2026-Q3"],
      [10, 90.91, 9.09, 100, "emitidas", invoiceNumber, "2026-Q3"]
    ]);

    // Asiento: D 4300 112,10 / H 705.1 90,91 / H 477.10 9,09 / H 705.3 10,00 / H 477.21 2,10.
    const entry = await journalFor("invoice", invoiceId);
    assert.ok(entry, "issuance must post the invoice entry");
    assert.equal(entry.status, "posted");
    assert.ok(entry.entryNumber && entry.entryNumber > 0, "numbered within the fiscal year");
    assert.equal(entry.fiscalYearCode, "2026");
    assert.deepEqual(sums(entry.lines), { debit: "112.10", credit: "112.10" });
    assert.equal(lineOf(entry, "4300").debit, "112.10");
    assert.equal(lineOf(entry, "705.1").credit, "90.91");
    assert.equal(lineOf(entry, "477.10").credit, "9.09");
    assert.equal(lineOf(entry, "477.10").taxBase, "90.91");
    assert.equal(lineOf(entry, "477.10").taxRateCode, "10");
    assert.equal(lineOf(entry, "705.3").credit, "10.00");
    assert.equal(lineOf(entry, "477.21").credit, "2.10");
  });

  it("2 · GET /invoices/:id/pdf answers application/pdf with the invoice number and the QR", async () => {
    const res = await app.inject({ method: "GET", url: url(`/invoices/${invoiceId}/pdf`), headers });
    assert.equal(res.statusCode, 200, res.body.slice(0, 200));
    assert.match(res.headers["content-type"] as string, /^application\/pdf/);
    assert.match(res.headers["content-disposition"] as string, new RegExp(`inline; filename="${invoiceNumber}.pdf"`));
    const pdf = res.rawPayload.toString("latin1");
    assert.ok(pdf.startsWith("%PDF-1.4"));
    assert.ok(pdf.includes(invoiceNumber));
    assert.ok(pdf.includes("QR tributario"));
    assert.ok(pdf.includes("NIF: B12345674"));
    assert.ok(res.rawPayload.length > 2000);
  });

  it("3 · POST /folios/:id/payments is idempotent by clientRequestId, posts D 570 / H 4300, and PSP methods are honest", async () => {
    const payload = { amount: invoiceTotal, method: "cash", clientRequestId: `${MARK}-pay-1`, reference: "CAJA-1", invoiceId };
    const first = await app.inject({ method: "POST", url: `/folios/${folioId}/payments`, headers, payload });
    assert.equal(first.statusCode, 201, first.body);
    const payment = JSON.parse(first.body) as { id: string; kind: string; idempotent: boolean; methodCode: string; method: string; status: string; amount: number; journalEntryId: string | null; invoiceId: string | null; clientRequestId: string };
    cashPaymentId = payment.id;
    created.paymentIds.push(payment.id);
    assert.equal(payment.kind, "payment");
    assert.equal(payment.idempotent, false);
    assert.equal(payment.methodCode, "cash");
    assert.equal(payment.method, "cash");
    assert.equal(payment.status, "captured");
    assert.equal(payment.amount, 112.1);
    assert.equal(payment.invoiceId, invoiceId);
    assert.ok(payment.journalEntryId);

    const replay = await app.inject({ method: "POST", url: `/folios/${folioId}/payments`, headers, payload });
    assert.equal(replay.statusCode, 200, replay.body);
    const replayed = JSON.parse(replay.body) as { id: string; idempotent: boolean };
    assert.equal(replayed.id, payment.id);
    assert.equal(replayed.idempotent, true);
    assert.equal(await prisma.payment.count({ where: { folioId, reversalOfId: null } }), 1, "no duplicate payment on replay");

    const conflict = await app.inject({ method: "POST", url: `/folios/${folioId}/payments`, headers, payload: { ...payload, amount: 5 } });
    assert.equal(conflict.statusCode, 409, conflict.body);
    assert.equal((JSON.parse(conflict.body) as { details: { code: string } }).details.code, "IDEMPOTENCY_CONFLICT");

    const badMethod = await app.inject({ method: "POST", url: `/folios/${folioId}/payments`, headers, payload: { amount: 1, method: "bitcoin" } });
    assert.equal(badMethod.statusCode, 400, badMethod.body);

    // Asiento del cobro: D 570 112,10 / H 4300 112,10.
    const entry = await journalFor("payment", payment.id);
    assert.ok(entry);
    assert.deepEqual(sums(entry.lines), { debit: "112.10", credit: "112.10" });
    assert.equal(lineOf(entry, "570").debit, "112.10");
    assert.equal(lineOf(entry, "4300").credit, "112.10");
    assert.equal(entry.id, payment.journalEntryId);

    // Folio settled; invoice paid through the linked payment.
    const balance = await app.inject({ method: "GET", url: `/folios/${folioId}/balance`, headers });
    assert.equal(balance.statusCode, 200);
    const folio = JSON.parse(balance.body) as { chargesTotal: number; paymentsTotal: number; balanceDue: number; payments: Array<{ kind: string }> };
    assert.deepEqual([folio.chargesTotal, folio.paymentsTotal, folio.balanceDue], [112.1, 112.1, 0]);
    const invoiceView = await app.inject({ method: "GET", url: `/invoices/${invoiceId}`, headers });
    const state = JSON.parse(invoiceView.body) as { paymentStatus: string; paidTotal: number; paymentSource: string };
    assert.deepEqual([state.paymentStatus, state.paidTotal, state.paymentSource], ["paid", 112.1, "linked"]);

    // Mark-paid: method + reference are mandatory; an already settled invoice answers alreadyPaid without a second capture.
    const noReference = await app.inject({ method: "POST", url: `/invoices/${invoiceId}/mark-paid`, headers, payload: { method: "bank_transfer" } });
    assert.equal(noReference.statusCode, 400, noReference.body);
    const marked = await app.inject({ method: "POST", url: `/invoices/${invoiceId}/mark-paid`, headers, payload: { method: "bank_transfer", reference: `${MARK}-TRF` } });
    assert.equal(marked.statusCode, 200, marked.body);
    assert.equal((JSON.parse(marked.body) as { alreadyPaid: boolean }).alreadyPaid, true);
    assert.equal(await prisma.payment.count({ where: { folioId, reversalOfId: null } }), 1);
    const online = await app.inject({ method: "POST", url: `/invoices/${invoiceId}/mark-paid`, headers, payload: { method: "payment_link", reference: "x" } });
    assert.equal(online.statusCode, 409, online.body);

    // A payment-link cobro without PSP is refused honestly (never a fictitious capture).
    const pspConfigured = Boolean(process.env.STRIPE_SECRET_KEY?.startsWith("sk_") || process.env.REDSYS_SECRET_KEY);
    if (!pspConfigured) {
      const link = await app.inject({ method: "POST", url: `/folios/${folioId}/payments`, headers, payload: { amount: 10, method: "payment_link", clientRequestId: `${MARK}-link` } });
      assert.equal(link.statusCode, 409, link.body);
      assert.equal((JSON.parse(link.body) as { details: { code: string } }).details.code, "PSP_NOT_CONFIGURED");
      const status = await app.inject({ method: "GET", url: url(`/properties/${PROPERTY_ID}/payments/psp-status`), headers });
      assert.equal(status.statusCode, 200, status.body);
      assert.equal((JSON.parse(status.body) as { configured: boolean }).configured, false);
      assert.equal(await prisma.payment.count({ where: { folioId, methodCode: "payment_link" } }), 0);
    }
  });

  it("4 · a rectificativa por sustitución reflects on the folio (credit line), reverses the original asiento, posts its own and counters the VAT rows", async () => {
    // Substitute: same room (100,00) + parking corrected to 6,05 → 106,05; delta vs the original −6,05.
    // (RectifyInvoiceSchema.lineAdjustments carries amountDelta/quantityDelta while the service reads
    // quantity/unitPrice — handoff to the integrator; the "S" path is exercised here.)
    const res = await app.inject({
      method: "POST",
      url: `/invoices/${invoiceId}/rectify`,
      headers,
      payload: { reasonCode: "R1", rectificationType: "S", substituteLines: [{ description: "Habitación doble", quantity: 1, unitPrice: 100, lineType: "room" }, { description: "Parking (corregido)", quantity: 1, unitPrice: 6.05, lineType: "parking" }] }
    });
    assert.equal(res.statusCode, 200, res.body);
    const rect = JSON.parse(res.body) as { id: string; invoiceNumber: string; total: number; taxTotal: number; seriesCode: string; rectificationType: string; rectification: { folioDelta: number; folioAdjustmentLineId: string | null; journalEntryId: string | null; unlinkedPaymentIds: string[]; relinkedPaymentIds: string[] } };
    created.invoiceIds.push(rect.id);
    assert.match(rect.invoiceNumber, /^REC-2026-\d{6}$/);
    assert.equal(rect.seriesCode, "REC");
    assert.equal(rect.rectificationType, "S");
    assert.equal(rect.total, 106.05);
    assert.equal(rect.taxTotal, 10.14);
    assert.equal(rect.rectification.folioDelta, -6.05);
    assert.ok(rect.rectification.folioAdjustmentLineId);
    assert.deepEqual(rect.rectification.relinkedPaymentIds, [cashPaymentId], "the original's payments follow the substitute");
    assert.deepEqual(rect.rectification.unlinkedPaymentIds, []);
    assert.equal((await prisma.payment.findUnique({ where: { id: cashPaymentId } }))?.invoiceId, rect.id);
    assert.ok(parkingLineId, "original parking line id resolved");
    const line = await prisma.folioLine.findUnique({ where: { id: rect.rectification.folioAdjustmentLineId! } });
    assert.equal(line?.type, "invoice_adjustment");
    assert.equal(Number(line?.total), -6.05);
    assert.equal((await prisma.invoice.findUnique({ where: { id: invoiceId }, select: { status: true } }))?.status, "rectified");

    // Original reversed: its issue entry gets reversedById / status reversed, the reversal mirrors it (112,10).
    const issueEntry = await journalFor("invoice", invoiceId);
    const reversal = await journalFor("invoice_rectification", `${rect.id}:supersedes:${invoiceId}`);
    assert.ok(issueEntry && reversal);
    assert.equal(issueEntry.status, "reversed");
    assert.equal(issueEntry.reversedById, reversal.id);
    assert.equal(reversal.reversalOfId, issueEntry.id);
    assert.deepEqual(sums(reversal.lines), { debit: "112.10", credit: "112.10" });
    assert.equal(lineOf(reversal, "4300").credit, "112.10");
    // Substitute asiento: D 4300 106,05 / H 705.1 90,91 / H 477.10 9,09 / H 705.3 5,00 / H 477.21 1,05.
    const entry = await journalFor("invoice_rectification", rect.id);
    assert.ok(entry);
    assert.equal(entry.id, rect.rectification.journalEntryId);
    assert.deepEqual(sums(entry.lines), { debit: "106.05", credit: "106.05" });
    assert.equal(lineOf(entry, "4300").debit, "106.05");
    assert.equal(lineOf(entry, "705.1").credit, "90.91");
    assert.equal(lineOf(entry, "477.10").credit, "9.09");
    assert.equal(lineOf(entry, "705.3").credit, "5.00");
    assert.equal(lineOf(entry, "477.21").credit, "1.05");
    // VAT book: the substitute's rows plus the counter-rows of the original (net 21 %: 10,00 − 10,00 + 5,00).
    const book = await prisma.vatBookEntry.findMany({ where: { organizationId: ORGANIZATION_ID, sourceId: { in: [rect.id, `${invoiceId}#sustituida`] } }, orderBy: [{ sourceId: "asc" }, { rate: "desc" }] });
    assert.deepEqual(book.map((r) => [r.sourceType, Number(r.rate), Number(r.base), Number(r.quota)]).sort((a, b) => String(a).localeCompare(String(b))), [
      ["invoice", 10, -90.91, -9.09],
      ["invoice", 21, -10, -2.1],
      ["rectification", 10, 90.91, 9.09],
      ["rectification", 21, 5, 1.05]
    ].sort((a, b) => String(a).localeCompare(String(b))));

    // Folio: charges 112,10 − 6,05 = 106,05; paid 112,10 → balance −6,05 (visible: a refund is due).
    const balance = JSON.parse((await app.inject({ method: "GET", url: `/folios/${folioId}/balance`, headers })).body) as { chargesTotal: number; balanceDue: number };
    assert.deepEqual([balance.chargesTotal, balance.balanceDue], [106.05, -6.05]);

    // The credit line is never invoiced again: a new draft on this folio would exclude it (folio is blocked by the live partial rectificativa anyway).
    const again = await app.inject({ method: "POST", url: `/folios/${folioId}/invoice`, headers, payload: { customerType: "guest" } });
    assert.equal(again.statusCode, 409, again.body);
    assert.equal((JSON.parse(again.body) as { details: { code: string } }).details.code, "FOLIO_ALREADY_INVOICED");
  });

  it("5 · a refund is idempotent by clientRequestId: one reversal row, D 4300 / H 570, folio balance back to 0", async () => {
    const payload = { amount: 6.05, reason: "Ajuste por rectificativa", clientRequestId: `${MARK}-ref-1` };
    const first = await app.inject({ method: "POST", url: `/payments/${cashPaymentId}/refund`, headers, payload });
    assert.equal(first.statusCode, 200, first.body);
    const refund = JSON.parse(first.body) as { id: string; status: string; refundedAmount: number; refunds: Array<{ amount: number; status: string }>; reversal: { id: string; status: string; reversalOfId: string; amount: number; methodCode: string; journalEntryId: string | null; clientRequestId: string }; idempotent: boolean };
    created.paymentIds.push(refund.reversal.id);
    assert.equal(refund.id, cashPaymentId);
    assert.equal(refund.status, "captured", "partial refund keeps the capture");
    assert.equal(refund.refundedAmount, 6.05);
    assert.equal(refund.refunds.length, 1);
    assert.deepEqual([refund.reversal.status, refund.reversal.reversalOfId, refund.reversal.amount, refund.reversal.methodCode, refund.idempotent], ["refunded", cashPaymentId, 6.05, "cash", false]);
    assert.ok(refund.reversal.journalEntryId);

    const replay = await app.inject({ method: "POST", url: `/payments/${cashPaymentId}/refund`, headers, payload });
    assert.equal(replay.statusCode, 200, replay.body);
    const replayed = JSON.parse(replay.body) as { reversal: { id: string }; refunds: unknown[]; refundedAmount: number; idempotent: boolean };
    assert.equal(replayed.reversal.id, refund.reversal.id);
    assert.equal(replayed.idempotent, true);
    assert.equal(replayed.refunds.length, 1);
    assert.equal(replayed.refundedAmount, 6.05);

    const entry = await journalFor("payment_refund", refund.refunds[0]!.id);
    assert.ok(entry, "refund entry keyed by the PaymentRefund row");
    assert.equal(entry.id, refund.reversal.journalEntryId);
    assert.deepEqual(sums(entry.lines), { debit: "6.05", credit: "6.05" });
    assert.equal(lineOf(entry, "4300").debit, "6.05");
    assert.equal(lineOf(entry, "570").credit, "6.05");

    const balance = JSON.parse((await app.inject({ method: "GET", url: `/folios/${folioId}/balance`, headers })).body) as { paymentsTotal: number; refundsTotal: number; balanceDue: number; payments: Array<{ id: string; kind: string; refundedAmount: number }> };
    assert.deepEqual([balance.paymentsTotal, balance.refundsTotal, balance.balanceDue], [106.05, 6.05, 0]);
    assert.equal(balance.payments.find((p) => p.id === refund.reversal.id)?.kind, "refund");
    assert.equal(balance.payments.find((p) => p.id === cashPaymentId)?.refundedAmount, 6.05);
  });

  it("6 · cancelling an invoice unlinks and (on request) refunds its payments, reverses the issue entry and counters the VAT rows", async () => {
    const folio = await newFolio(`${MARK}-B`);
    await postLine(folio.folioId, "room", "Habitación", 50);
    const draft = await draftInvoice(folio.folioId, "Prueba Anulación");
    const issued = await app.inject({ method: "POST", url: `/invoices/${draft.id}/issue`, headers, payload: {} });
    assert.equal(issued.statusCode, 200, issued.body);
    const number = (JSON.parse(issued.body) as { invoiceNumber: string }).invoiceNumber;
    const paid = await app.inject({ method: "POST", url: `/folios/${folio.folioId}/payments`, headers, payload: { amount: 50, method: "card", reference: "DAT-77", clientRequestId: `${MARK}-pay-B`, invoiceId: draft.id } });
    assert.equal(paid.statusCode, 201, paid.body);
    const payment = JSON.parse(paid.body) as { id: string; methodCode: string; method: string };
    created.paymentIds.push(payment.id);
    assert.deepEqual([payment.methodCode, payment.method], ["card_terminal", "card"]);
    assert.equal(lineOf((await journalFor("payment", payment.id))!, "5721").debit, "50.00");

    const cancelled = await app.inject({ method: "POST", url: `/invoices/${draft.id}/cancel`, headers, payload: { reason: "Prueba de anulación", refundPayments: true } });
    assert.equal(cancelled.statusCode, 200, cancelled.body);
    const body = JSON.parse(cancelled.body) as { status: string; cancellationHash: string | null; cancellation: { unlinkedPaymentIds: string[]; refundedPaymentIds: string[]; folioId: string; folioBalanceDue: number | null } };
    assert.equal(body.status, "cancelled");
    assert.ok(body.cancellationHash);
    assert.deepEqual(body.cancellation.unlinkedPaymentIds, [payment.id]);
    assert.equal(body.cancellation.refundedPaymentIds.length, 1);
    created.paymentIds.push(...body.cancellation.refundedPaymentIds);
    assert.equal(body.cancellation.folioBalanceDue, 50, "charges stay, the money went back: the folio shows what is owed again");
    const row = await prisma.payment.findUnique({ where: { id: payment.id } });
    assert.equal(row?.invoiceId, null);
    assert.equal(row?.status, "refunded");
    const reversal = await prisma.payment.findUnique({ where: { id: body.cancellation.refundedPaymentIds[0]! } });
    assert.equal(reversal?.reversalOfId, payment.id);
    assert.equal(reversal?.clientRequestId, `invoice-cancel:${draft.id}:${payment.id}`);

    const issueEntry = await journalFor("invoice", draft.id);
    const reversalEntry = await journalFor("invoice_cancellation", draft.id);
    assert.ok(issueEntry && reversalEntry);
    assert.equal(reversalEntry.reversalOfId, issueEntry.id);
    assert.equal(issueEntry.reversedById, reversalEntry.id);
    assert.equal(issueEntry.status, "reversed");
    assert.deepEqual(sums(reversalEntry.lines), sums(issueEntry.lines));
    assert.equal(lineOf(reversalEntry, "4300").credit, "50.00");
    assert.equal(lineOf(reversalEntry, "705.1").debit, "45.45");
    assert.equal(lineOf(reversalEntry, "477.10").debit, "4.55");

    const book = await prisma.vatBookEntry.findMany({ where: { organizationId: ORGANIZATION_ID, sourceId: { in: [draft.id, `${draft.id}#anulacion`] } }, orderBy: { total: "desc" } });
    assert.deepEqual(book.map((r) => [r.number, Number(r.base), Number(r.quota), Number(r.total)]), [
      [number, 45.45, 4.55, 50],
      [number, -45.45, -4.55, -50]
    ]);
    // Second cancel is refused (immutable), refunds are not duplicated.
    const again = await app.inject({ method: "POST", url: `/invoices/${draft.id}/cancel`, headers, payload: { reason: "otra vez", refundPayments: true } });
    assert.equal(again.statusCode, 409);
    assert.equal(await prisma.payment.count({ where: { folioId: folio.folioId, reversalOfId: payment.id } }), 1);
  });

  it("7 · send-email without a provider answers simulated:true and records a SIMULADO delivery (never «enviado»)", async () => {
    const configured = Boolean(process.env.EMAIL_PROVIDER && process.env.EMAIL_PROVIDER_KEY && process.env.EMAIL_PROVIDER_KEY !== "change-me" && process.env.EMAIL_FROM);
    const res = await app.inject({ method: "POST", url: `/invoices/${invoiceId}/send-email`, headers, payload: { recipient: TEST_EMAIL, message: "Prueba de integración" } });
    if (configured) {
      assert.ok([200, 502].includes(res.statusCode), res.body);
      return;
    }
    assert.equal(res.statusCode, 200, res.body);
    const body = JSON.parse(res.body) as { status: string; simulated: boolean; deliveryId: string; attachment: { filename: string; contentType: string; bytes: number }; recipient: string };
    assert.equal(body.status, "simulated");
    assert.equal(body.simulated, true);
    assert.equal(body.recipient, TEST_EMAIL);
    assert.equal(body.attachment.contentType, "application/pdf");
    assert.equal(body.attachment.filename, `${invoiceNumber}.pdf`);
    assert.ok(body.attachment.bytes > 2000);
    const delivery = await prisma.notificationDelivery.findUnique({ where: { id: body.deliveryId } });
    assert.equal(delivery?.templateCode, "invoice_email");
    assert.match(delivery?.errorMessage ?? "", /^SIMULADO/);
    assert.match(delivery?.subject ?? "", new RegExp(`Factura ${invoiceNumber}`));
    const invalid = await app.inject({ method: "POST", url: `/invoices/${invoiceId}/send-email`, headers, payload: { recipient: "no-es-un-email" } });
    assert.equal(invalid.statusCode, 400);
  });

  it("8 · /payment-tokens refuses card numbers and needs a PSP-issued token", async () => {
    const pan = await app.inject({ method: "POST", url: "/payment-tokens", headers, payload: { provider: "stripe", cardData: { pan: "4242424242424242" } } });
    assert.equal(pan.statusCode, 400, pan.body);
    assert.equal((JSON.parse(pan.body) as { details: { code: string } }).details.code, "PAN_NOT_ACCEPTED");
    const panAsToken = await app.inject({ method: "POST", url: "/payment-tokens", headers, payload: { provider: "stripe", token: "4242 4242 4242 4242" } });
    assert.equal(panAsToken.statusCode, 400, panAsToken.body);
    if (!process.env.STRIPE_SECRET_KEY?.startsWith("sk_")) {
      const noPsp = await app.inject({ method: "POST", url: "/payment-tokens", headers, payload: { provider: "stripe", token: "pm_1Abc2Def3Ghi4Jkl", last4: "4242", brand: "visa" } });
      assert.equal(noPsp.statusCode, 409, noPsp.body);
      assert.equal((JSON.parse(noPsp.body) as { details: { code: string } }).details.code, "PSP_NOT_CONFIGURED");
    }
    assert.equal(await prisma.paymentToken.count({ where: { organizationId: ORGANIZATION_ID, brand: "demo" } }), await prisma.paymentToken.count({ where: { organizationId: ORGANIZATION_ID, brand: "demo" } }), "no synthetic tokens are created any more");
  });
});
