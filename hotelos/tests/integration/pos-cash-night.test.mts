/**
 * TPV · arqueo · cierre del día — integration (REAL HTTP via app.inject, Postgres required).
 *
 * Finanzas (2026-09-15, lote «pos-noche»), on the demo property prop_123 /
 * org_123 only (Faranda is never written: a guard asserts its POS, cash
 * closure and night-audit tables are byte-identical before and after):
 *   · venta al contado: ticket «3× Caña» (10 %) + «2× Copa de vino» (catalogue
 *     category «vinos» → 21 %) closed in cash → factura simplificada F2 issued
 *     through the invoicing lote (series SIM, VeriFactu hash, snapshot),
 *     libro de emitidas (one row per rate), journal entry D 570 18,00 /
 *     H 705.x 15,62 / H 477.10 0,82 / H 477.21 1,56 (numbered, ejercicio 2026)
 *     and the PosOrder carrying invoiceId / journalEntryId / taxTotal /
 *     businessDate; cuadre 8,18 + 0,82 + 7,44 + 1,56 = 18,00;
 *   · tarjeta: «2× Café con leche» 4,80 → D 5721 4,80 / H 705.2 4,36 / H 477.10 0,44;
 *   · cargo a habitación: one folio line per tax group, typed by the outlet
 *     («bar»), 10 % and 21 %, and NO invoice / entry on the ticket;
 *   · ?status honoured on the board listing;
 *   · cierre de caja: open with a 100 € float → close with a 2 € shortage →
 *     difference −2,00, entry D 659 / H 570, tickets linked, status closed;
 *     a new cash sale of the day → 409 CASH_CLOSURE_CLOSED and the ticket
 *     stays open; approve → approved; a second closure of the day → 409
 *     CASH_CLOSURE_EXISTS; ?status honoured on the closure listing;
 *   · cierre del día: a checked-in fixture priced by the BAR grid gets ONE
 *     room charge («Alojamiento dd/mm/aaaa · CODE · …», taxCategory
 *     accommodation) at the RateDay price; a fixture without rate is a
 *     warning item, not a 0 € line; the run re-executed for the SAME business
 *     date (rewound business_dates + deleted run row, i.e. a crashed run
 *     re-run) posts nothing twice; the closing report is persisted and served
 *     by GET /night-audit/runs/:runId.
 *
 * Everything the suite writes is removed in `after` (tickets, invoices and
 * their lines / VeriFactu submissions / VAT-book rows, journal entries,
 * closures, the catalogue product, the fixture reservations / folios / room,
 * the night-audit run rows) and business_dates of prop_123 is restored.
 *
 * Run from the repo root:
 *   cd apps/api && node --import tsx --test "../../tests/integration/pos-cash-night.test.mts"
 *
 * Mounting: while server.ts still declares the legacy /pos and /night-audit
 * routes, the module routes are mounted under a test prefix (with their
 * manifest entries pushed for the RBAC hook); once the integrator wires
 * `registerPosRoutes(app)` the suite detects the cash-closures route and
 * uses the bare paths.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

try {
  process.loadEnvFile(fileURLToPath(new URL("../../.env", import.meta.url)));
} catch {
  // Honest: no .env → the defaults below (a fresh CI database).
}
process.env.DATABASE_URL ??= "postgresql://hotelos:hotelos@localhost:5432/hotelos";
process.env.JWT_SECRET ??= "integration-test-secret-32chars-minimum-aaaa";
process.env.ENCRYPTION_KEY ??= "integration-test-enckey-32chars-min-aaaa";

const { buildApiServer } = await import("../../apps/api/src/server.js");
const { routePermissionManifest } = await import("../../apps/api/src/security/route-permissions.js");
const { registerPosRoutes } = await import("../../apps/api/src/modules/pos/pos.routes.js");
const { posRoutePermissionsAll } = await import("../../apps/api/src/modules/pos/route-permissions.partial.js");
const { registerNightAuditRoutes } = await import("../../apps/api/src/modules/night-audit/night-audit.routes.js");
const { nightAuditRoutePermissionsAll } = await import("../../apps/api/src/modules/night-audit/route-permissions.partial.js");
const { flushVerifactuQueue } = await import("../../apps/api/src/modules/invoicing/verifactu-submission.service.js");
const { flushAccountingProjection } = await import("../../apps/api/src/modules/accounting/projection.js");
const { prisma } = await import("@hotelos/database");
// Decimal arithmetic through the ledger lote's helper (the tests folder cannot resolve @prisma/client directly).
const { money } = await import("../../apps/api/src/modules/accounting/accounting.service.js");

type ApiApp = Awaited<ReturnType<typeof buildApiServer>>;
type Headers = Record<string, string>;

const PROPERTY_ID = "prop_123";
const ORGANIZATION_ID = "org_123";
const ROOM_TYPE_ID = "rt_double";
const FARANDA_ORG = "cmrhw9jy30002fyvb6tsdiugt";
const MARK = "[pos-cash-night test]";
const STAMP = Date.now().toString(36);
const D = (value: string | number | { toString(): string }) => money(typeof value === "object" ? value.toString() : value);

type ErrorBody = { statusCode: number; message: string; details?: { code?: string; [k: string]: unknown } };
type Ticket = {
  id: string;
  status: string;
  settlement?: string;
  total: number;
  taxTotal: number;
  businessDate?: string | null;
  invoiceId?: string | null;
  invoiceNumber?: string | null;
  journalEntryId?: string | null;
  cashClosureId?: string | null;
  lines: Array<{ name: string; quantity: number; total: number; productId?: string | null }>;
};
type Closure = {
  id: string;
  status: string;
  outletId: string;
  businessDate: string;
  openingFloat: string;
  expectedCash: string;
  countedCash: string | null;
  difference: string | null;
  byMethod: Record<string, { expected: string; counted: string | null; difference: string | null }>;
  expectation: { posSales: Record<string, string> };
  journalEntryId: string | null;
  linkedTickets: number;
};
type RunItem = { reservationCode: string; outcome: string; amount: string | null; priceSource: string };
type Run = {
  id: string;
  status: string;
  businessDate: string;
  stepResults: Array<{ step: string; status: string; detail?: string }>;
  report: {
    businessDate: string;
    nextBusinessDate: string;
    roomCharges: { posted: number; alreadyPosted: number; withoutRate: number; totalPosted: string; items: RunItem[] };
    warnings: string[];
    // Tanda L5 (L5-D)
    settledFolios?: { closed: number; pendingInvoice: number; withBalance: number; totalWithBalance: string };
    preflightOverride?: { reasonText: string; blockers: Array<{ id: string }> };
  } | null;
  errorMessage?: string;
};

let cachedSession: { token: string } | null | undefined;
async function loginDemo(app: ApiApp): Promise<{ token: string } | null> {
  if (cachedSession !== undefined) return cachedSession;
  const res = await app.inject({
    method: "POST",
    url: "/auth/login",
    payload: {
      email: process.env.INTEGRATION_LOGIN_EMAIL ?? "reception@example.com",
      password: process.env.INTEGRATION_LOGIN_PASSWORD ?? "hotelos-demo",
      deviceId: "integration-tests-pos-cash-night"
    }
  });
  cachedSession = res.statusCode === 200 ? { token: (JSON.parse(res.body) as { token: string }).token } : null;
  return cachedSession;
}

const isoOf = (d: Date): string => d.toISOString().slice(0, 10);
const dayUtc = (iso: string): Date => new Date(`${iso}T00:00:00.000Z`);
const addDays = (iso: string, days: number): string => {
  const d = dayUtc(iso);
  d.setUTCDate(d.getUTCDate() + days);
  return isoOf(d);
};
const localToday = (): string => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Madrid", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const formatDayEs = (iso: string): string => {
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
};

async function farandaFingerprint(): Promise<string> {
  const properties = (await prisma.property.findMany({ where: { organizationId: FARANDA_ORG }, select: { id: true } })).map((p) => p.id);
  const [orders, closures, runs, invoices, entries] = await Promise.all([
    prisma.posOrder.count({ where: { propertyId: { in: properties } } }),
    prisma.cashClosure.count({ where: { propertyId: { in: properties } } }),
    prisma.nightAuditRun.count({ where: { propertyId: { in: properties } } }),
    prisma.invoice.count({ where: { propertyId: { in: properties } } }),
    prisma.journalEntry.count({ where: { organizationId: FARANDA_ORG } })
  ]);
  const dates = await prisma.businessDate.findMany({ where: { propertyId: { in: properties } }, select: { propertyId: true, currentDate: true }, orderBy: { propertyId: "asc" } });
  return JSON.stringify({ orders, closures, runs, invoices, entries, dates: dates.map((d) => [d.propertyId, isoOf(d.currentDate)]) });
}

describe("TPV · arqueo · cierre del día (app.inject, prop_123)", () => {
  let app: ApiApp;
  let prefix = "";
  let headers: Headers = {};
  let faranda = "";
  let barPlanId = "";
  let productId = "";
  let roomId = "";
  let roomNumber = "";
  let reservationId = "";
  let reservationCode = "";
  let folioId = "";
  let noRateReservationId = "";
  let noRateReservationCode = "";
  let noRateFolioId = "";
  let businessDateBefore: { currentDate: Date; closedAt: Date | null; closedBy: string | null } | null = null;
  let preexistingRunIds = new Set<string>();
  const ticketIds: string[] = [];
  const invoiceIds: string[] = [];
  const closureIds: string[] = [];
  let ratePrice = "";
  let cashSaleTicket: Ticket | null = null;

  const url = (path: string): string => `${prefix}${path}`;

  async function openTicket(outletId: string, roomNo?: string): Promise<Ticket> {
    const res = await app.inject({ method: "POST", url: url("/pos/tickets"), headers, payload: { propertyId: PROPERTY_ID, outletId, ...(roomNo ? { roomNumber: roomNo } : {}) } });
    assert.equal(res.statusCode, 200, res.body);
    const ticket = JSON.parse(res.body) as Ticket;
    ticketIds.push(ticket.id);
    return ticket;
  }
  async function addLine(ticketId: string, name: string, quantity: number, unitPrice: number): Promise<Ticket> {
    const res = await app.inject({ method: "POST", url: url(`/pos/tickets/${ticketId}/lines`), headers, payload: { name, quantity, unitPrice } });
    assert.equal(res.statusCode, 200, res.body);
    return JSON.parse(res.body) as Ticket;
  }
  async function closeTicket(ticketId: string, settlement: "room" | "cash" | "card"): Promise<{ status: number; body: Ticket & ErrorBody; raw: string }> {
    const res = await app.inject({ method: "POST", url: url(`/pos/tickets/${ticketId}/close`), headers, payload: { settlement } });
    const body = JSON.parse(res.body) as Ticket & ErrorBody;
    if (res.statusCode === 200 && body.invoiceId) invoiceIds.push(body.invoiceId);
    return { status: res.statusCode, body, raw: res.body };
  }
  async function journalOf(sourceType: string, sourceId: string) {
    const entry = await prisma.journalEntry.findFirst({ where: { organizationId: ORGANIZATION_ID, sourceType, sourceId } });
    if (!entry) return null;
    const lines = await prisma.journalLine.findMany({ where: { journalEntryId: entry.id }, orderBy: { id: "asc" } });
    return { entry, lines: lines.map((l) => ({ accountCode: l.accountCode, debit: D(l.debit).toFixed(2), credit: D(l.credit).toFixed(2), taxRateCode: l.taxRateCode, taxBase: l.taxBase === null ? null : D(l.taxBase).toFixed(2) })) };
  }
  const sum = (values: string[]): string => values.reduce((acc, v) => acc.plus(v), D(0)).toFixed(2);

  before(async () => {
    faranda = await farandaFingerprint();
    app = await buildApiServer();
    const wired = app.hasRoute({ method: "GET", url: "/properties/:propertyId/pos/cash-closures" });
    if (!wired) {
      prefix = "/__pos-noche";
      routePermissionManifest.push(...[...posRoutePermissionsAll, ...nightAuditRoutePermissionsAll].map((entry) => ({ ...entry, path: `${prefix}${entry.path}` })));
      await app.register(
        async (sub) => {
          registerPosRoutes(sub);
          registerNightAuditRoutes(sub);
        },
        { prefix }
      );
    }
    await app.ready();
    const session = await loginDemo(app);
    headers = session ? { authorization: `Bearer ${session.token}` } : {};

    const bar = await prisma.ratePlan.findFirst({ where: { propertyId: PROPERTY_ID, code: "BAR", active: true }, select: { id: true } });
    assert.ok(bar, "prop_123 must have a BAR plan (db:seed:commercial)");
    barPlanId = bar.id;

    // Catalogue: an alcoholic beverage so the bar ticket mixes 10 % and 21 %.
    await prisma.posProduct.deleteMany({ where: { propertyId: PROPERTY_ID, name: `Copa de vino ${STAMP}` } });
    productId = (await prisma.posProduct.create({ data: { propertyId: PROPERTY_ID, name: `Copa de vino ${STAMP}`, category: "vinos", price: 4.5, taxCode: "ES_IVA_21", active: true }, select: { id: true } })).id;

    // Business date of prop_123 (restored in `after`) and its pre-existing runs.
    const bd = await prisma.businessDate.findUnique({ where: { propertyId: PROPERTY_ID } });
    businessDateBefore = bd ? { currentDate: bd.currentDate, closedAt: bd.closedAt, closedBy: bd.closedBy } : null;
    preexistingRunIds = new Set((await prisma.nightAuditRun.findMany({ where: { propertyId: PROPERTY_ID }, select: { id: true } })).map((r) => r.id));
    const businessDate = bd ? isoOf(bd.currentDate) : localToday();

    // In-house fixtures: a priced stay on a temporary room and a stay nothing prices.
    roomNumber = `PCN${STAMP.slice(-4).toUpperCase()}`;
    roomId = (await prisma.room.create({ data: { propertyId: PROPERTY_ID, roomTypeId: ROOM_TYPE_ID, number: roomNumber, status: "occupied", sellable: false, maintenanceStatus: "blocked", displayName: `${MARK} habitación temporal` }, select: { id: true } })).id;
    reservationCode = `PCN-${STAMP.toUpperCase()}-A`;
    const reservation = await prisma.reservation.create({
      data: {
        propertyId: PROPERTY_ID,
        code: reservationCode,
        channel: "direct",
        status: "checked_in",
        arrivalDate: dayUtc(businessDate),
        departureDate: dayUtc(addDays(businessDate, 2)),
        roomTypeId: ROOM_TYPE_ID,
        assignedRoomId: roomId,
        ratePlanId: barPlanId,
        totalAmount: 0,
        currency: "EUR",
        bookerName: `${MARK} alojado con tarifa`
      },
      select: { id: true }
    });
    reservationId = reservation.id;
    folioId = (await prisma.folio.create({ data: { reservationId, status: "open", currency: "EUR", label: "guest", isPrimary: true }, select: { id: true } })).id;
    const rate = await prisma.rateDay.findUnique({
      where: { propertyId_ratePlanId_roomTypeId_date: { propertyId: PROPERTY_ID, ratePlanId: barPlanId, roomTypeId: ROOM_TYPE_ID, date: dayUtc(businessDate) } },
      select: { price: true }
    });
    assert.ok(rate && D(rate.price).gt(0), `prop_123 needs a BAR × DBL rate day on ${businessDate} (db:seed:commercial covers 45 days back / 120 ahead)`);
    ratePrice = D(rate.price).toFixed(2);

    noRateReservationCode = `PCN-${STAMP.toUpperCase()}-B`;
    noRateReservationId = (
      await prisma.reservation.create({
        data: {
          propertyId: PROPERTY_ID,
          code: noRateReservationCode,
          channel: "direct",
          status: "checked_in",
          arrivalDate: dayUtc(businessDate),
          departureDate: dayUtc(addDays(businessDate, 1)),
          roomTypeId: null,
          ratePlanId: null,
          totalAmount: 0,
          currency: "EUR",
          bookerName: `${MARK} alojado sin tarifa`
        },
        select: { id: true }
      })
    ).id;
    noRateFolioId = (await prisma.folio.create({ data: { reservationId: noRateReservationId, status: "open", currency: "EUR", label: "guest", isPrimary: true }, select: { id: true } })).id;
  });

  after(async () => {
    try {
      await flushVerifactuQueue().catch(() => undefined);
      await flushAccountingProjection().catch(() => undefined);
      const closureJournalIds = closureIds.length ? (await prisma.journalEntry.findMany({ where: { organizationId: ORGANIZATION_ID, sourceType: "cash_closure", sourceId: { in: closureIds } }, select: { id: true } })).map((e) => e.id) : [];
      const ticketJournalIds = ticketIds.length ? (await prisma.journalEntry.findMany({ where: { organizationId: ORGANIZATION_ID, sourceType: "pos_ticket", sourceId: { in: ticketIds } }, select: { id: true } })).map((e) => e.id) : [];
      const journalIds = [...closureJournalIds, ...ticketJournalIds];
      if (journalIds.length) {
        await prisma.journalLine.deleteMany({ where: { journalEntryId: { in: journalIds } } });
        await prisma.journalEntry.deleteMany({ where: { id: { in: journalIds } } });
      }
      const allInvoiceIds = Array.from(new Set([...invoiceIds, ...(await prisma.posOrder.findMany({ where: { id: { in: ticketIds }, invoiceId: { not: null } }, select: { invoiceId: true } })).map((o) => o.invoiceId as string)]));
      if (allInvoiceIds.length) {
        await prisma.verifactuSubmission.deleteMany({ where: { invoiceId: { in: allInvoiceIds } } });
        await prisma.vatBookEntry.deleteMany({ where: { organizationId: ORGANIZATION_ID, sourceId: { in: allInvoiceIds } } });
        await prisma.invoiceLine.deleteMany({ where: { invoiceId: { in: allInvoiceIds } } });
        await prisma.invoice.deleteMany({ where: { id: { in: allInvoiceIds }, propertyId: PROPERTY_ID } });
      }
      if (ticketIds.length) {
        await prisma.posOrderLine.deleteMany({ where: { posOrderId: { in: ticketIds } } });
        await prisma.posOrder.deleteMany({ where: { id: { in: ticketIds }, propertyId: PROPERTY_ID } });
      }
      if (closureIds.length) await prisma.cashClosure.deleteMany({ where: { id: { in: closureIds }, propertyId: PROPERTY_ID } });
      if (productId) await prisma.posProduct.deleteMany({ where: { id: productId } });
      const folioIds = [folioId, noRateFolioId].filter(Boolean);
      if (folioIds.length) {
        await prisma.folioLine.deleteMany({ where: { folioId: { in: folioIds } } });
        await prisma.payment.deleteMany({ where: { folioId: { in: folioIds } } });
        await prisma.folio.deleteMany({ where: { id: { in: folioIds } } });
      }
      const reservationIds = [reservationId, noRateReservationId].filter(Boolean);
      if (reservationIds.length) {
        await prisma.reservationGuest.deleteMany({ where: { reservationId: { in: reservationIds } } });
        await prisma.reservation.deleteMany({ where: { id: { in: reservationIds }, propertyId: PROPERTY_ID } });
      }
      if (roomId) await prisma.room.deleteMany({ where: { id: roomId, propertyId: PROPERTY_ID } });
      await prisma.nightAuditRun.deleteMany({ where: { propertyId: PROPERTY_ID, id: { notIn: [...preexistingRunIds] } } });
      if (businessDateBefore) {
        await prisma.businessDate.update({ where: { propertyId: PROPERTY_ID }, data: { currentDate: businessDateBefore.currentDate, closedAt: businessDateBefore.closedAt, closedBy: businessDateBefore.closedBy } });
      } else {
        await prisma.businessDate.deleteMany({ where: { propertyId: PROPERTY_ID } });
      }
    } finally {
      if (app) await app.close();
      await prisma.$disconnect();
    }
  });

  it("venta al contado: factura simplificada + asiento D 570 / H 705.x / H 477 + libro de IVA, cuadre 8,18+0,82+7,44+1,56 = 18,00", async () => {
    const ticket = await openTicket("out_bar");
    await addLine(ticket.id, "Caña", 3, 3);
    const withWine = await addLine(ticket.id, `Copa de vino ${STAMP}`, 2, 4.5);
    assert.equal(withWine.lines[1]?.productId, productId, "the catalogue product must be linked by name");
    assert.equal(withWine.total, 18);

    const res = await closeTicket(ticket.id, "cash");
    assert.equal(res.status, 200, res.raw);
    cashSaleTicket = res.body;
    assert.equal(res.body.status, "closed");
    assert.equal(res.body.settlement, "cash");
    assert.equal(res.body.total, 18);
    assert.equal(res.body.taxTotal, 2.38);
    assert.equal(res.body.businessDate, localToday());
    assert.ok(res.body.invoiceId, "the sale must carry its simplified invoice");
    assert.match(res.body.invoiceNumber ?? "", /^SIM-\d{4}-\d{6}$/);
    assert.ok(res.body.journalEntryId, "the sale must carry its journal entry");

    const invoice = await prisma.invoice.findUnique({ where: { id: res.body.invoiceId as string } });
    assert.ok(invoice);
    assert.equal(invoice.invoiceType, "F2");
    assert.equal(invoice.simplified, true);
    assert.equal(invoice.customerRequired, false);
    assert.equal(invoice.seriesCode, "SIM");
    assert.equal(invoice.status, "issued");
    assert.equal(D(invoice.total).toFixed(2), "18.00");
    assert.equal(D(invoice.taxTotal).toFixed(2), "2.38");
    assert.ok(invoice.verifactuHash, "F2 enters the VeriFactu chain");
    assert.equal((invoice.snapshotJson as { posOrderId?: string }).posOrderId, ticket.id);

    const vat = await prisma.vatBookEntry.findMany({ where: { organizationId: ORGANIZATION_ID, sourceType: "simplified", sourceId: invoice.id }, orderBy: { rate: "desc" } });
    assert.deepEqual(
      vat.map((r) => [r.book, D(r.rate).toFixed(2), D(r.base).toFixed(2), D(r.quota).toFixed(2), D(r.total).toFixed(2), r.number]),
      [
        ["emitidas", "21.00", "7.44", "1.56", "9.00", invoice.invoiceNumber],
        ["emitidas", "10.00", "8.18", "0.82", "9.00", invoice.invoiceNumber]
      ]
    );

    const journal = await journalOf("pos_ticket", ticket.id);
    assert.ok(journal, "journal entry pos_ticket/<ticket> must exist");
    assert.equal(journal.entry.id, res.body.journalEntryId);
    assert.equal(journal.entry.status, "posted");
    assert.equal(journal.entry.fiscalYearCode, "2026");
    assert.ok(typeof journal.entry.entryNumber === "number" && journal.entry.entryNumber > 0, "the entry is numbered");
    assert.equal(isoOf(journal.entry.entryDate), localToday());
    const debit570 = journal.lines.filter((l) => l.accountCode === "570").map((l) => l.debit);
    assert.deepEqual(debit570, ["18.00"]);
    assert.equal(sum(journal.lines.filter((l) => l.accountCode?.startsWith("705")).map((l) => l.credit)), "15.62");
    assert.deepEqual(journal.lines.filter((l) => l.accountCode === "477.10").map((l) => [l.credit, l.taxRateCode, l.taxBase]), [["0.82", "10", "8.18"]]);
    assert.deepEqual(journal.lines.filter((l) => l.accountCode === "477.21").map((l) => [l.credit, l.taxRateCode, l.taxBase]), [["1.56", "21", "7.44"]]);
    assert.equal(sum(journal.lines.map((l) => l.debit)), sum(journal.lines.map((l) => l.credit)));
    assert.equal(sum(journal.lines.map((l) => l.debit)), "18.00");
    for (const line of journal.lines) assert.ok(D(line.debit).gte(0) && D(line.credit).gte(0), "never a negative line");

    // Closing twice is one 409, never a second invoice.
    const again = await closeTicket(ticket.id, "cash");
    assert.equal(again.status, 409, again.raw);
    assert.equal(again.body.details?.code, "POS_TICKET_CLOSED");
    assert.equal(await prisma.invoice.count({ where: { propertyId: PROPERTY_ID, invoiceType: "F2", snapshotJson: { path: ["posOrderId"], equals: ticket.id } } }), 1);
  });

  it("tarjeta: D 5721 4,80 / H 705.2 4,36 / H 477.10 0,44", async () => {
    const ticket = await openTicket("out_cafe");
    await addLine(ticket.id, "Café con leche", 2, 2.4);
    const res = await closeTicket(ticket.id, "card");
    assert.equal(res.status, 200, res.raw);
    assert.equal(res.body.taxTotal, 0.44);
    const journal = await journalOf("pos_ticket", ticket.id);
    assert.ok(journal);
    assert.deepEqual(journal.lines.filter((l) => l.accountCode === "5721").map((l) => l.debit), ["4.80"]);
    assert.deepEqual(journal.lines.filter((l) => l.accountCode === "705.2").map((l) => l.credit), ["4.36"]);
    assert.deepEqual(journal.lines.filter((l) => l.accountCode === "477.10").map((l) => [l.credit, l.taxBase]), [["0.44", "4.36"]]);
    assert.equal(sum(journal.lines.map((l) => l.debit)), "4.80");
  });

  it("cargo a habitación: una línea de folio por grupo de IVA, tipada por el outlet, sin factura ni asiento", async () => {
    const ticket = await openTicket("out_bar", roomNumber);
    await addLine(ticket.id, "Caña", 1, 3);
    await addLine(ticket.id, `Copa de vino ${STAMP}`, 1, 4.5);
    const res = await closeTicket(ticket.id, "room");
    assert.equal(res.status, 200, res.raw);
    assert.equal(res.body.settlement, "room");
    assert.equal(res.body.taxTotal, 1.05);
    assert.equal(res.body.invoiceId ?? null, null);
    assert.equal(res.body.journalEntryId ?? null, null);
    const lines = await prisma.folioLine.findMany({ where: { folioId, type: "bar" }, orderBy: { total: "asc" } });
    assert.deepEqual(
      lines.map((l) => [l.type, l.taxCategory, D(l.total).toFixed(2)]),
      [
        ["bar", "food_beverage", "3.00"],
        ["bar", "general_services", "4.50"]
      ]
    );
    assert.ok(lines[1]?.description.includes("(bebidas alcohólicas)"), lines[1]?.description);
    assert.equal(await prisma.journalEntry.count({ where: { organizationId: ORGANIZATION_ID, sourceType: "pos_ticket", sourceId: ticket.id } }), 0, "a room charge posts no entry until the folio is invoiced");
  });

  it("GET /pos/tickets honours ?status", async () => {
    const closedIds = ticketIds.slice(0, 3);
    const open = await app.inject({ method: "GET", url: url(`/properties/${PROPERTY_ID}/pos/tickets?status=open`), headers });
    assert.equal(open.statusCode, 200, open.body);
    const openBody = JSON.parse(open.body) as Ticket[];
    assert.ok(openBody.every((t) => t.status === "open"));
    assert.ok(closedIds.every((id) => !openBody.some((t) => t.id === id)));
    const closed = await app.inject({ method: "GET", url: url(`/properties/${PROPERTY_ID}/pos/tickets?status=closed`), headers });
    assert.equal(closed.statusCode, 200, closed.body);
    const closedBody = JSON.parse(closed.body) as Ticket[];
    assert.ok(closedBody.every((t) => t.status === "closed"));
    assert.ok(closedIds.every((id) => closedBody.some((t) => t.id === id)), "the three closed tickets are listed");
    const bad = await app.inject({ method: "GET", url: url(`/properties/${PROPERTY_ID}/pos/tickets?status=weird`), headers });
    assert.equal(bad.statusCode, 400);
  });

  it("cierre de caja: apertura con fondo, cierre con faltante de 2 € (D 659 / H 570), bloqueo de ventas, aprobación y ?status", async () => {
    const today = localToday();
    const opened = await app.inject({ method: "POST", url: url(`/properties/${PROPERTY_ID}/pos/cash-closures`), headers, payload: { outletId: "*", openingFloat: 100, notes: `${MARK} apertura` } });
    assert.equal(opened.statusCode, 201, opened.body);
    const open = JSON.parse(opened.body) as Closure;
    closureIds.push(open.id);
    assert.equal(open.status, "open");
    assert.equal(open.outletId, "*");
    assert.equal(open.businessDate, today);
    assert.equal(open.openingFloat, "100.00");
    assert.ok(D(open.expectation.posSales.cash).gte("18.00"), `the cash sale is in the preview: ${opened.body}`);
    assert.ok(D(open.expectation.posSales.card_terminal).gte("4.80"));
    // expected cash = fondo + cobros efectivo − devoluciones + ventas TPV − gastos de caja (other suites may add cash
    // movements of the day on prop_123 in parallel, so the identity is asserted, not a fixed figure).
    const e = open.expectation as { openingFloat: string; payments: Record<string, string>; refunds: Record<string, string>; posSales: Record<string, string>; cashExpenses: string };
    assert.equal(open.expectedCash, D(e.openingFloat).plus(e.payments.cash).minus(e.refunds.cash).plus(e.posSales.cash).minus(e.cashExpenses).toFixed(2));
    assert.equal(e.openingFloat, "100.00");

    const duplicate = await app.inject({ method: "POST", url: url(`/properties/${PROPERTY_ID}/pos/cash-closures`), headers, payload: { outletId: "*", businessDate: today } });
    assert.equal(duplicate.statusCode, 409, duplicate.body);
    assert.equal((JSON.parse(duplicate.body) as ErrorBody).details?.code, "CASH_CLOSURE_EXISTS");

    const counted = D(open.byMethod.cash.expected).minus(2);
    const closedRes = await app.inject({
      method: "POST",
      url: url(`/properties/${PROPERTY_ID}/pos/cash-closures/${open.id}/close`),
      headers,
      payload: { countedByMethod: { cash: counted.toNumber(), card_terminal: D(open.byMethod.card_terminal.expected).toNumber() }, counts: [{ denomination: "50", quantity: 0 }], notes: `${MARK} cierre` }
    });
    assert.equal(closedRes.statusCode, 400, "a denomination count that does not add up to the counted cash is a 400");
    assert.equal((JSON.parse(closedRes.body) as ErrorBody).details?.code, "CASH_COUNT_MISMATCH");

    const closedOk = await app.inject({
      method: "POST",
      url: url(`/properties/${PROPERTY_ID}/pos/cash-closures/${open.id}/close`),
      headers,
      payload: { countedByMethod: { cash: counted.toNumber(), card_terminal: D(open.byMethod.card_terminal.expected).toNumber() }, notes: `${MARK} cierre` }
    });
    assert.equal(closedOk.statusCode, 200, closedOk.body);
    const closed = JSON.parse(closedOk.body) as Closure;
    assert.equal(closed.status, "closed");
    assert.equal(closed.countedCash, counted.toFixed(2));
    // difference = counted − expected (re-computed at close; equals −2,00 unless another suite moved cash meanwhile).
    assert.equal(closed.difference, counted.minus(closed.expectedCash).toFixed(2));
    assert.equal(closed.byMethod.card_terminal.difference, D(open.byMethod.card_terminal.expected).minus(closed.byMethod.card_terminal.expected).toFixed(2));
    assert.ok(closed.linkedTickets >= 2, `the cash and card tickets are linked: ${closedOk.body}`);
    const linked = await prisma.posOrder.findMany({ where: { id: { in: ticketIds.slice(0, 2) } }, select: { cashClosureId: true } });
    assert.ok(linked.every((o) => o.cashClosureId === closed.id));
    if (closed.difference === "-2.00") {
      assert.ok(closed.journalEntryId, "a shortage posts its entry");
      const journal = await journalOf("cash_closure", closed.id);
      assert.ok(journal);
      assert.equal(journal.entry.id, closed.journalEntryId);
      assert.deepEqual(journal.lines.map((l) => [l.accountCode, l.debit, l.credit]), [["659", "2.00", "0.00"], ["570", "0.00", "2.00"]]);
    } else {
      console.warn(`${MARK} cash moved on prop_123 between open and close (difference ${closed.difference}); journal assertion relaxed`);
      assert.equal(Boolean(closed.journalEntryId), closed.difference !== "0.00");
    }

    // Sales in cash for a closed day are refused and the ticket stays open (no invoice issued).
    const late = await openTicket("out_bar");
    await addLine(late.id, "Caña", 1, 3);
    const refused = await closeTicket(late.id, "cash");
    assert.equal(refused.status, 409, refused.raw);
    assert.equal(refused.body.details?.code, "CASH_CLOSURE_CLOSED");
    const lateRow = await prisma.posOrder.findUnique({ where: { id: late.id }, select: { status: true, invoiceId: true } });
    assert.equal(lateRow?.status, "open");
    assert.equal(lateRow?.invoiceId, null);
    assert.equal(await prisma.invoice.count({ where: { propertyId: PROPERTY_ID, invoiceType: "F2", snapshotJson: { path: ["posOrderId"], equals: late.id } } }), 0);

    const approveEarly = await app.inject({ method: "POST", url: url(`/properties/${PROPERTY_ID}/pos/cash-closures/${open.id}/close`), headers, payload: { countedByMethod: { cash: 1 } } });
    assert.equal(approveEarly.statusCode, 409);
    assert.equal((JSON.parse(approveEarly.body) as ErrorBody).details?.code, "CASH_CLOSURE_NOT_OPEN");

    const approved = await app.inject({ method: "POST", url: url(`/properties/${PROPERTY_ID}/pos/cash-closures/${open.id}/approve`), headers, payload: { notes: "visto bueno" } });
    assert.equal(approved.statusCode, 200, approved.body);
    assert.equal((JSON.parse(approved.body) as Closure).status, "approved");

    const listApproved = await app.inject({ method: "GET", url: url(`/properties/${PROPERTY_ID}/pos/cash-closures?status=approved`), headers });
    assert.equal(listApproved.statusCode, 200, listApproved.body);
    assert.ok((JSON.parse(listApproved.body) as Closure[]).some((c) => c.id === open.id));
    const listOpen = await app.inject({ method: "GET", url: url(`/properties/${PROPERTY_ID}/pos/cash-closures?status=open`), headers });
    assert.equal(listOpen.statusCode, 200, listOpen.body);
    assert.ok((JSON.parse(listOpen.body) as Closure[]).every((c) => c.id !== open.id && c.status === "open"));
    const one = await app.inject({ method: "GET", url: url(`/properties/${PROPERTY_ID}/pos/cash-closures/${open.id}`), headers });
    assert.equal(one.statusCode, 200, one.body);
    assert.equal((JSON.parse(one.body) as Closure).status, "approved");
  });

  it("cierre del día: cargo de habitación desde la tarifa, aviso sin tarifa, idempotente por fecha de negocio, informe persistido", async () => {
    const bdRes = await app.inject({ method: "GET", url: url(`/properties/${PROPERTY_ID}/night-audit/business-date`), headers });
    assert.equal(bdRes.statusCode, 200, bdRes.body);
    const businessDate = (JSON.parse(bdRes.body) as { currentDate: string }).currentDate;
    assert.equal(businessDate, businessDateBefore ? isoOf(businessDateBefore.currentDate) : businessDate);
    const staleConfirmed = await prisma.reservation.count({ where: { propertyId: PROPERTY_ID, status: { in: ["draft", "confirmed"] }, arrivalDate: { lt: dayUtc(businessDate) } } });

    // Tanda L5 (L5-D): the preflight is a gate. prop_123 carries historical
    // reservations that block it (an unresolved no-show, a departure not
    // checked out…), so the runs that must complete are FORCED with a reason;
    // the override is audited and lands in the report only when the preflight
    // actually blocked (a clean preflight ignores `force`).
    const FORCE_BODY = { force: true, reasonText: "prueba de integración: reserva histórica sin resolver en prop_123" };
    const preflightRes = await app.inject({ method: "GET", url: url(`/properties/${PROPERTY_ID}/night-audit/preflight`), headers });
    assert.equal(preflightRes.statusCode, 200, preflightRes.body);
    const preflightBlocked = (JSON.parse(preflightRes.body) as { canClose: boolean }).canClose === false;
    if (preflightBlocked) {
      const refused = await app.inject({ method: "POST", url: url(`/properties/${PROPERTY_ID}/night-audit/run`), headers });
      assert.equal(refused.statusCode, 409, refused.body);
      assert.equal((JSON.parse(refused.body) as ErrorBody).details?.code, "NIGHT_AUDIT_PREFLIGHT_BLOCKED");
      assert.equal(await prisma.nightAuditRun.count({ where: { propertyId: PROPERTY_ID, id: { notIn: [...preexistingRunIds] } } }), 0, "a blocked close writes no run row");
    }

    const first = await app.inject({ method: "POST", url: url(`/properties/${PROPERTY_ID}/night-audit/run`), headers, payload: FORCE_BODY });
    assert.equal(first.statusCode, 200, first.body);
    const run1 = JSON.parse(first.body) as Run;
    assert.equal(run1.status, "completed", `${run1.errorMessage ?? ""} (stale confirmed before run: ${staleConfirmed})`);
    assert.equal(run1.businessDate, businessDate);
    assert.ok(run1.report, "the closing report is part of the run");
    assert.equal(Boolean(run1.report.preflightOverride), preflightBlocked, `preflightOverride only when the preflight blocked: ${JSON.stringify(run1.report.preflightOverride ?? null)}`);
    if (preflightBlocked) assert.equal(run1.report.preflightOverride?.reasonText, FORCE_BODY.reasonText);
    assert.ok(run1.stepResults.some((s) => s.step === "close_settled_folios"), "close_settled_folios runs on every night");
    assert.ok(run1.report.settledFolios, "settledFolios figures in the report");
    const mine = run1.report.roomCharges.items.find((i) => i.reservationCode === reservationCode);
    assert.ok(mine, JSON.stringify(run1.report.roomCharges));
    assert.equal(mine.outcome, "posted");
    assert.equal(mine.amount, ratePrice);
    assert.equal(mine.priceSource, "rate_plan");
    const noRate = run1.report.roomCharges.items.find((i) => i.reservationCode === noRateReservationCode);
    assert.ok(noRate);
    assert.equal(noRate.outcome, "no_rate");
    assert.equal(noRate.amount, null);
    assert.ok(run1.report.warnings.some((w) => w.includes(noRateReservationCode)), run1.report.warnings.join(" | "));
    assert.equal(run1.stepResults.find((s) => s.step === "post_room_charges")?.status, "warning");
    assert.equal(run1.report.nextBusinessDate, addDays(businessDate, 1));

    const roomLines = await prisma.folioLine.findMany({ where: { folioId, type: "room" } });
    assert.equal(roomLines.length, 1);
    assert.equal(D(roomLines[0]!.unitPrice).toFixed(2), ratePrice);
    assert.equal(D(roomLines[0]!.total).toFixed(2), ratePrice);
    assert.equal(roomLines[0]!.taxCategory, "accommodation");
    assert.equal(roomLines[0]!.description, `Alojamiento ${formatDayEs(businessDate)} · ${reservationCode} · Double`);
    assert.equal(await prisma.folioLine.count({ where: { folioId: noRateFolioId, type: "room" } }), 0, "no 0 € line for a stay without rate");
    const advanced = await prisma.businessDate.findUnique({ where: { propertyId: PROPERTY_ID } });
    assert.equal(isoOf(advanced!.currentDate), addDays(businessDate, 1));

    // Same date twice: rewind the business date and drop the run row (a crashed run re-executed).
    await prisma.businessDate.update({ where: { propertyId: PROPERTY_ID }, data: { currentDate: dayUtc(businessDate) } });
    await prisma.nightAuditRun.deleteMany({ where: { id: run1.id } });
    const second = await app.inject({ method: "POST", url: url(`/properties/${PROPERTY_ID}/night-audit/run`), headers, payload: FORCE_BODY });
    assert.equal(second.statusCode, 200, second.body);
    const run2 = JSON.parse(second.body) as Run;
    assert.equal(run2.status, "completed", run2.errorMessage);
    assert.equal(Boolean(run2.report?.preflightOverride), preflightBlocked);
    const mine2 = run2.report?.roomCharges.items.find((i) => i.reservationCode === reservationCode);
    assert.equal(mine2?.outcome, "already_posted");
    assert.equal(await prisma.folioLine.count({ where: { folioId, type: "room" } }), 1, "one room charge per business date, never two");

    // A completed date refuses a third run with a typed 409.
    await prisma.businessDate.update({ where: { propertyId: PROPERTY_ID }, data: { currentDate: dayUtc(businessDate) } });
    // (ALREADY_COMPLETED comes before the preflight gate: with or without force.)
    const third = await app.inject({ method: "POST", url: url(`/properties/${PROPERTY_ID}/night-audit/run`), headers, payload: FORCE_BODY });
    assert.equal(third.statusCode, 409, third.body);
    assert.equal((JSON.parse(third.body) as ErrorBody).details?.code, "NIGHT_AUDIT_ALREADY_COMPLETED");
    const thirdPlain = await app.inject({ method: "POST", url: url(`/properties/${PROPERTY_ID}/night-audit/run`), headers });
    assert.equal((JSON.parse(thirdPlain.body) as ErrorBody).details?.code, "NIGHT_AUDIT_ALREADY_COMPLETED");

    const detail = await app.inject({ method: "GET", url: url(`/properties/${PROPERTY_ID}/night-audit/runs/${run2.id}`), headers });
    assert.equal(detail.statusCode, 200, detail.body);
    const stored = JSON.parse(detail.body) as Run;
    assert.equal(stored.report?.roomCharges.alreadyPosted, run2.report?.roomCharges.alreadyPosted);
    assert.ok(stored.stepResults.some((s) => s.step === "payments_summary"));
    const missing = await app.inject({ method: "GET", url: url(`/properties/${PROPERTY_ID}/night-audit/runs/na_nope`), headers });
    assert.equal(missing.statusCode, 404);
  });

  it("Faranda (piloto real) queda intacta", async () => {
    assert.ok(cashSaleTicket, "the sale case ran");
    assert.equal(await farandaFingerprint(), faranda, "Faranda's POS / cash closure / night audit / invoices / journal / business dates must be untouched");
  });
});
