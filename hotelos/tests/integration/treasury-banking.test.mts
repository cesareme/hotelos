/**
 * Tesorería · banca · comisiones · nóminas (lote tesoreria-banca) ·
 * integration (REAL HTTP via app.inject, Postgres required).
 *
 * Exercises the money path end to end on the demo property (prop_123 /
 * org_123), everything created here is removed in `after`:
 *   · payroll: contract 2.000,00 € (IRPF 15 %) → period 2026-08 calculated
 *     through the API → ONE entry per slip (D 640 2.000,00 / D 642 610,00 /
 *     H 4751 300,00 / H 476 737,00 / H 465 1.573,00) + Modelo 111 record;
 *     recalculation REVERSES the previous entry (marked reversalOfId) before
 *     posting the new one, so the net 640 expense stays 2.000,00 (never 4.000,00);
 *     GET export is read-only, POST export marks the period;
 *   · commissions: rule booking 15 % «total» → GuestCheckedOut event accrues
 *     15,00 on a 100,00 reservation with D 629.1 / H 410;
 *   · supplier bill posted (D 628 / D 472.21 / H 400, simulating the
 *     suppliers lot) and a bank account with the fixture's IBAN;
 *   · CSB43 import (fixture of the parser unit tests) PERSISTS the statement
 *     and 6 lines, auto-reconciles 5 of them with their accounting effect:
 *       cobro por transferencia 2.500,00 (match only),
 *       liquidación datáfono 97,50 → D 572 97,50 / D 626 2,50 / H 5721 100,00,
 *       pago factura 1.815,00 → D 400 / H 572 (bill paid),
 *       pago nóminas 1.573,00 → D 465 / H 572 (period paid),
 *       liquidación comisión 15,00 → D 410 / H 572 (accrual settled);
 *     the bank fee 12,40 stays for a human → manual bank_fee → D 626 / H 572;
 *   · re-importing the same file creates NOTHING (6 duplicates, 1 statement);
 *   · treasury position reads the bank's closing balance (11.682,10) and the
 *     ledger 572 moved by exactly −3.317,90; forecast/receivables/payables 200;
 *   · unmatching the payroll line reverses the payment entry and reopens the period;
 *   · SEPA Norma 19 and 34 remittances persist with status transitions
 *     (generated → sent → accepted; a second «sent» → 409).
 *
 * Run from the repo root:
 *   cd apps/api && node --import tsx --test "../../tests/integration/treasury-banking.test.mts"
 *
 * Mounting: until the integrator wires `registerTreasuryRoutes(app)` in
 * server.ts the routes are mounted under a test prefix (manifest entries
 * pushed for the RBAC hook), exactly like rate-grid-v2.test.mts.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

try {
  process.loadEnvFile(fileURLToPath(new URL("../../.env", import.meta.url)));
} catch {
  // Honest: no .env → CI defaults below.
}
process.env.DATABASE_URL ??= "postgresql://hotelos:hotelos@localhost:5432/hotelos";
process.env.JWT_SECRET ??= "integration-test-secret-32chars-minimum-aaaa";
process.env.ENCRYPTION_KEY ??= "integration-test-enckey-32chars-min-aaaa";

const { buildApiServer } = await import("../../apps/api/src/server.js");
const { routePermissionManifest } = await import("../../apps/api/src/security/route-permissions.js");
const { registerTreasuryRoutes } = await import("../../apps/api/src/modules/treasury/treasury.routes.js");
const { treasuryRoutePermissions } = await import("../../apps/api/src/modules/treasury/route-permissions.partial.js");
const { ledger, ledgerBalances } = await import("../../apps/api/src/modules/treasury/ledger-bridge.js");
const { accrueCommissionFromEvent } = await import("../../apps/api/src/modules/commissions/commission-accrual.service.js");
const { parseCsb43File } = await import("../../apps/api/src/modules/banking-spain/csb43.parser.js");
const { SEPA_JOB_NAME } = await import("../../apps/api/src/modules/treasury/sepa-remittance.service.js");
const { prisma } = await import("@hotelos/database");

type ApiApp = Awaited<ReturnType<typeof buildApiServer>>;
type Headers = Record<string, string>;
type ErrorBody = { statusCode: number; message: string; details?: { code?: string; [k: string]: unknown } };
type LineView = { accountCode: string; debit: string; credit: string };

const PROPERTY_ID = "prop_123";
const ORG_ID = "org_123";
const MARK = "[treasury-banking test]";
const FIXTURE = new URL("../../apps/api/src/modules/banking-spain/__tests__/fixtures/norma43-hotel-ejemplo.n43", import.meta.url);
const csb43 = readFileSync(FIXTURE, "utf8");
const FIXTURE_IBAN = parseCsb43File(csb43).accounts[0]!.iban;
const suffix = Math.random().toString(36).slice(2, 8);
const dayUtc = (d: string): Date => new Date(`${d}T00:00:00Z`);

let cachedSession: { token: string } | null | undefined;
async function loginDemo(app: ApiApp): Promise<{ token: string } | null> {
  if (cachedSession !== undefined) return cachedSession;
  const res = await app.inject({
    method: "POST",
    url: "/auth/login",
    payload: { email: process.env.INTEGRATION_LOGIN_EMAIL ?? "reception@example.com", password: process.env.INTEGRATION_LOGIN_PASSWORD ?? "hotelos-demo", deviceId: "integration-tests-treasury" }
  });
  cachedSession = res.statusCode === 200 ? { token: (JSON.parse(res.body) as { token: string }).token } : null;
  return cachedSession;
}

/** Lines of a journal entry keyed by account code, money as strings. */
async function entryLines(journalEntryId: string): Promise<LineView[]> {
  const lines = await prisma.journalLine.findMany({ where: { journalEntryId }, orderBy: { id: "asc" } });
  return lines.map((l) => ({ accountCode: l.accountCode ?? "?", debit: l.debit.toFixed(2), credit: l.credit.toFixed(2) })).sort((a, b) => a.accountCode.localeCompare(b.accountCode) || a.debit.localeCompare(b.debit));
}

function assertBalanced(lines: LineView[], expectedTotal: string): void {
  const debit = lines.reduce((s, l) => s + Math.round(Number(l.debit) * 100), 0);
  const credit = lines.reduce((s, l) => s + Math.round(Number(l.credit) * 100), 0);
  assert.equal(debit, credit, `debe ${debit} ≠ haber ${credit}: ${JSON.stringify(lines)}`);
  assert.equal((debit / 100).toFixed(2), expectedTotal, JSON.stringify(lines));
}

function expectLines(lines: LineView[], expected: Array<[string, string, string]>): void {
  const got = lines.map((l) => [l.accountCode, l.debit, l.credit]);
  assert.deepEqual(got, expected.sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1])), JSON.stringify(got));
}

describe("tesorería · banca · comisiones · nóminas (app.inject, prop_123)", () => {
  let app: ApiApp;
  let prefix = "";
  let headers: Headers = {};
  // Only the routes of this lot are mounted under the test prefix; the legacy
  // /payroll, /commissions, /banking and /dashboards routes live in server.ts.
  const treasuryPatterns = treasuryRoutePermissions.map((entry) => ({ method: entry.method, re: new RegExp(`^${entry.path.replace(/:[a-zA-Z]+/g, "[^/]+")}$`) }));
  const isTreasuryRoute = (method: string, path: string): boolean => {
    const bare = path.split("?")[0]!;
    return treasuryPatterns.some((p) => p.method === method && p.re.test(bare));
  };
  const url = (method: string, path: string): string => (isTreasuryRoute(method, path) ? `${prefix}${path}` : path);

  // Fixtures created by the suite (removed in `after`).
  let reservationId = "";
  let folioId = "";
  const paymentIds: string[] = [];
  let supplierId = "";
  let supplierBillId = "";
  let supplierEntryId = "";
  let staffProfileId = "";
  let contractId = "";
  let periodId = "";
  let ruleId = "";
  let accrualId = "";
  let bankAccountId = "";
  let statementId = "";
  const remittanceIds: string[] = [];
  let ledger572Before = "0.00";

  async function api<T = Record<string, unknown>>(method: "GET" | "POST" | "DELETE", path: string, payload?: unknown): Promise<{ status: number; body: T & ErrorBody; raw: string }> {
    const res = await app.inject({ method, url: url(method, path), headers, ...(payload !== undefined ? { payload } : {}) });
    let body: T & ErrorBody;
    try {
      body = JSON.parse(res.body) as T & ErrorBody;
    } catch {
      body = { raw: res.body } as unknown as T & ErrorBody;
    }
    return { status: res.statusCode, body, raw: res.body };
  }

  /** Every journal entry the suite produced: by source ids, plus their reversals (transitively). */
  async function collectTestEntryIds(): Promise<string[]> {
    const slips = periodId ? await prisma.payrollSlip.findMany({ where: { periodId }, select: { id: true } }) : [];
    const lines = bankAccountId ? await prisma.bankStatementLine.findMany({ where: { bankAccountId }, select: { id: true } }) : [];
    const sourceIds = [
      ...slips.map((s) => s.id),
      periodId,
      accrualId,
      accrualId ? `${accrualId}:settlement` : "",
      supplierBillId,
      ...lines.map((l) => l.id),
      ...lines.map((l) => `bankline:${l.id}:fee`),
      ...lines.map((l) => `bankline:${l.id}:interest`)
    ].filter(Boolean);
    const known = new Set<string>();
    // Reversed entries reference the original as sourceId, plus reversalOfId: iterate to closure.
    let frontier = (await prisma.journalEntry.findMany({ where: { organizationId: ORG_ID, sourceId: { in: sourceIds } }, select: { id: true } })).map((e) => e.id);
    const period = periodId ? await prisma.payrollPeriod.findUnique({ where: { id: periodId } }) : null;
    frontier.push(...(period?.journalEntryIds ?? []), ...(period?.reversalJournalEntryIds ?? []));
    if (period?.paymentJournalEntryId) frontier.push(period.paymentJournalEntryId);
    while (frontier.length > 0) {
      const next: string[] = [];
      for (const id of frontier) {
        if (known.has(id)) continue;
        known.add(id);
      }
      // Children (reversals of the frontier) AND parents (what the frontier reversed): the first-run
      // payroll entries only survive as `reversalOfId` of their reversal.
      const related = await prisma.journalEntry.findMany({ where: { organizationId: ORG_ID, OR: [{ reversalOfId: { in: frontier } }, { sourceType: "reversal", sourceId: { in: frontier } }, { reversedById: { in: frontier } }] }, select: { id: true, reversalOfId: true } });
      for (const r of related) {
        if (!known.has(r.id)) next.push(r.id);
        if (r.reversalOfId && !known.has(r.reversalOfId)) next.push(r.reversalOfId);
      }
      const parents = await prisma.journalEntry.findMany({ where: { id: { in: frontier } }, select: { reversalOfId: true } });
      for (const p of parents) if (p.reversalOfId && !known.has(p.reversalOfId)) next.push(p.reversalOfId);
      frontier = next;
    }
    return Array.from(known);
  }

  async function cleanup(): Promise<void> {
    // Entry ids are keyed by bank line / slip ids: collect them BEFORE those rows go.
    const entryIds = await collectTestEntryIds();
    if (bankAccountId) {
      const lines = await prisma.bankStatementLine.findMany({ where: { bankAccountId }, select: { id: true } });
      await prisma.reconciliationMatch.deleteMany({ where: { bankAccountId } });
      await prisma.bankStatementLine.deleteMany({ where: { id: { in: lines.map((l) => l.id) } } });
      await prisma.bankStatement.deleteMany({ where: { bankAccountId } });
    }
    if (entryIds.length > 0) {
      await prisma.journalLine.deleteMany({ where: { journalEntryId: { in: entryIds } } });
      await prisma.journalEntry.deleteMany({ where: { id: { in: entryIds } } });
    }
    if (periodId) {
      const slips = await prisma.payrollSlip.findMany({ where: { periodId }, select: { id: true } });
      await prisma.withholdingTaxRecord.deleteMany({ where: { sourceType: "payroll_slip", sourceId: { in: slips.map((s) => s.id) } } });
      await prisma.payrollLine.deleteMany({ where: { slipId: { in: slips.map((s) => s.id) } } });
      await prisma.payrollSlip.deleteMany({ where: { periodId } });
      await prisma.payrollPeriod.deleteMany({ where: { id: periodId } });
    }
    if (contractId) await prisma.employmentContract.deleteMany({ where: { id: contractId } });
    if (staffProfileId) await prisma.staffProfile.deleteMany({ where: { id: staffProfileId } });
    if (accrualId) await prisma.commissionAccrual.deleteMany({ where: { id: accrualId } });
    if (reservationId) await prisma.commissionAccrual.deleteMany({ where: { reservationId } });
    if (ruleId) await prisma.commissionRule.deleteMany({ where: { id: ruleId } });
    await prisma.commissionRule.deleteMany({ where: { propertyId: PROPERTY_ID, channelCode: `booking-${suffix}` } });
    if (supplierBillId) await prisma.supplierBill.deleteMany({ where: { id: supplierBillId } });
    if (supplierId) await prisma.supplier.deleteMany({ where: { id: supplierId } });
    if (paymentIds.length > 0) {
      await prisma.paymentRefund.deleteMany({ where: { paymentId: { in: paymentIds } } });
      await prisma.payment.deleteMany({ where: { id: { in: paymentIds } } });
    }
    if (folioId) {
      await prisma.folioLine.deleteMany({ where: { folioId } });
      await prisma.folio.deleteMany({ where: { id: folioId } });
    }
    if (reservationId) await prisma.reservation.deleteMany({ where: { id: reservationId } });
    if (bankAccountId) await prisma.bankAccount.deleteMany({ where: { id: bankAccountId } });
    if (remittanceIds.length > 0) await prisma.workerJobRun.deleteMany({ where: { id: { in: remittanceIds }, jobName: SEPA_JOB_NAME } });
    // Leftovers of a crashed run (same fixture IBAN / employee code / supplier).
    const stale = await prisma.bankAccount.findMany({ where: { propertyId: PROPERTY_ID, iban: FIXTURE_IBAN }, select: { id: true } });
    for (const account of stale) {
      const lines = await prisma.bankStatementLine.findMany({ where: { bankAccountId: account.id }, select: { id: true } });
      await prisma.reconciliationMatch.deleteMany({ where: { bankAccountId: account.id } });
      await prisma.bankStatementLine.deleteMany({ where: { id: { in: lines.map((l) => l.id) } } });
      await prisma.bankStatement.deleteMany({ where: { bankAccountId: account.id } });
      await prisma.bankAccount.delete({ where: { id: account.id } });
    }
  }

  before(async () => {
    app = await buildApiServer();
    if (!app.hasRoute({ method: "GET", url: "/treasury/position" })) {
      prefix = "/__treasury";
      routePermissionManifest.push(...treasuryRoutePermissions.map((entry) => ({ ...entry, path: `${prefix}${entry.path}` })));
      await app.register(async (sub) => registerTreasuryRoutes(sub), { prefix });
    }
    await app.ready();
    const session = await loginDemo(app);
    headers = session ? { authorization: `Bearer ${session.token}` } : {};
    await cleanup(); // leftovers of a crashed run

    // Reservation (OTA) with folio, one room charge and two collections.
    const reservation = await prisma.reservation.create({
      data: { propertyId: PROPERTY_ID, code: `TBK-${suffix}`, channel: `booking-${suffix}`, status: "checked_out", arrivalDate: dayUtc("2026-09-01"), departureDate: dayUtc("2026-09-03"), totalAmount: "100.00", currency: "EUR", bookerName: `${MARK} Viajes Norte SL` },
      select: { id: true }
    });
    reservationId = reservation.id;
    const folio = await prisma.folio.create({ data: { reservationId, label: "guest", isPrimary: true, currency: "EUR" }, select: { id: true } });
    folioId = folio.id;
    await prisma.folioLine.create({ data: { folioId, type: "room", description: `${MARK} Habitación`, quantity: 1, unitPrice: "100.00", total: "100.00", taxCode: "IVA10", postedAt: dayUtc("2026-09-01") } });
    const transfer = await prisma.payment.create({ data: { propertyId: PROPERTY_ID, folioId, amount: "2500.00", currency: "EUR", method: "bank_transfer", methodCode: "bank_transfer", status: "captured", createdAt: new Date("2026-09-01T10:00:00Z") }, select: { id: true } });
    const card = await prisma.payment.create({ data: { propertyId: PROPERTY_ID, folioId, amount: "100.00", currency: "EUR", method: "card", methodCode: "card_terminal", status: "captured", createdAt: new Date("2026-09-02T12:00:00Z") }, select: { id: true } });
    paymentIds.push(transfer.id, card.id);

    // Supplier + posted bill (the suppliers lot posts the accrual; simulated through the ledger bridge).
    const supplier = await prisma.supplier.create({ data: { organizationId: ORG_ID, name: `${MARK} Suministros del Noroeste SL`, taxId: "B11111111", iban: "ES9121000418450200051332" }, select: { id: true } });
    supplierId = supplier.id;
    const bill = await prisma.supplierBill.create({
      data: { propertyId: PROPERTY_ID, organizationId: ORG_ID, supplierId, supplierName: "Suministros del Noroeste SL", supplierTaxId: "B11111111", invoiceNumber: `F-2026-118-${suffix}`, issueDate: dayUtc("2026-08-30"), dueDate: dayUtc("2026-09-04"), baseTotal: "1500.00", taxTotal: "315.00", total: "1815.00", status: "posted", suggestedAccountCode: "628" },
      select: { id: true }
    });
    supplierBillId = bill.id;
    const accrualEntry = await ledger().postJournalEntry({
      organizationId: ORG_ID,
      propertyId: PROPERTY_ID,
      entryDate: "2026-08-30",
      sourceType: "supplier_bill",
      sourceId: bill.id,
      description: `${MARK} Factura recibida F-2026-118`,
      reference: `F-2026-118-${suffix}`,
      lines: [
        { accountCode: "628", debit: "1500.00", taxRateCode: "21" },
        { accountCode: "472.21", debit: "315.00", taxRateCode: "21", taxBase: "1500.00" },
        { accountCode: "400", credit: "1815.00" }
      ]
    });
    supplierEntryId = accrualEntry.id;
    await prisma.supplierBill.update({ where: { id: bill.id }, data: { journalEntryId: accrualEntry.id, postedAt: new Date() } });

    // Employee + contract.
    const profile = await prisma.staffProfile.create({ data: { userId: "usr_123", propertyId: PROPERTY_ID, employeeCode: `TB-EMP-${suffix}` }, select: { id: true } });
    staffProfileId = profile.id;
    const contract = await prisma.employmentContract.create({
      data: { staffProfileId, propertyId: PROPERTY_ID, organizationId: ORG_ID, contractType: "indefinido", startDate: dayUtc("2026-01-01"), grossSalary: "2000.00", payFrequency: "monthly", payCount: 12, irpfRatePct: "15.00" },
      select: { id: true }
    });
    contractId = contract.id;

    const before572 = await ledgerBalances(ORG_ID, ["572"], { propertyId: PROPERTY_ID });
    ledger572Before = before572.get("572")!.toFixed(2);
  });

  after(async () => {
    await cleanup();
    await app.close();
  });

  // ---- Nóminas ----------------------------------------------------------------
  it("calculates the payroll period through the API: one balanced entry per slip and a Modelo 111 record", async () => {
    const created = await api<{ id: string; status: string }>("POST", "/payroll/periods", { propertyId: PROPERTY_ID, periodCode: "2026-08" });
    assert.equal(created.status, 200, created.raw);
    periodId = created.body.id;
    const calc = await api<{ period: { totalGross: number; totalNet: number; totalIrpf: number; totalSs: number; journalEntryIds: string[]; reversalJournalEntryIds: string[]; status: string }; slipIds: string[]; journalEntryIds: string[] }>("POST", `/payroll/periods/${periodId}/calculate`, {});
    assert.equal(calc.status, 200, calc.raw);
    assert.equal(calc.body.slipIds.length, 1);
    assert.deepEqual([calc.body.period.totalGross, calc.body.period.totalNet, calc.body.period.totalIrpf, calc.body.period.totalSs], [2000, 1573, 300, 737]);
    assert.equal(calc.body.period.journalEntryIds.length, 1);
    assert.deepEqual(calc.body.period.reversalJournalEntryIds, []);
    const lines = await entryLines(calc.body.period.journalEntryIds[0]!);
    assertBalanced(lines, "2610.00");
    expectLines(lines, [
      ["4751", "0.00", "300.00"],
      ["465", "0.00", "1573.00"],
      ["476", "0.00", "737.00"],
      ["640", "2000.00", "0.00"],
      ["642", "610.00", "0.00"]
    ]);
    const entry = await prisma.journalEntry.findUnique({ where: { id: calc.body.period.journalEntryIds[0]! } });
    assert.equal(entry?.status, "posted");
    assert.equal(entry?.entryDate.toISOString().slice(0, 10), "2026-08-31");
    assert.ok(entry?.entryNumber && entry.entryNumber > 0, "numbered");
    assert.equal(entry?.fiscalYearCode, "2026");
    const withholding = await prisma.withholdingTaxRecord.findMany({ where: { sourceType: "payroll_slip", sourceId: { in: calc.body.slipIds } } });
    assert.equal(withholding.length, 1);
    assert.equal(withholding[0]!.retentionAmount.toFixed(2), "300.00");
    assert.equal(withholding[0]!.rowCode, "01");
  });

  it("recalculating reverses the previous entry (never a duplicate expense) and keeps the history on the period", async () => {
    const first = await prisma.payrollPeriod.findUnique({ where: { id: periodId } });
    const firstEntryId = first!.journalEntryIds[0]!;
    const recalc = await api<{ period: { journalEntryIds: string[]; reversalJournalEntryIds: string[] }; reversedJournalEntryIds: string[] }>("POST", `/payroll/periods/${periodId}/calculate`, {});
    assert.equal(recalc.status, 200, recalc.raw);
    assert.equal(recalc.body.reversedJournalEntryIds.length, 1);
    assert.notEqual(recalc.body.period.journalEntryIds[0], firstEntryId);
    assert.deepEqual(recalc.body.period.reversalJournalEntryIds, recalc.body.reversedJournalEntryIds);
    const reversed = await prisma.journalEntry.findUnique({ where: { id: firstEntryId } });
    assert.equal(reversed?.status, "reversed");
    assert.equal(reversed?.reversedById, recalc.body.reversedJournalEntryIds[0]);
    const reversal = await prisma.journalEntry.findUnique({ where: { id: recalc.body.reversedJournalEntryIds[0]! } });
    assert.equal(reversal?.reversalOfId, firstEntryId);
    assert.equal(reversal?.sourceType, "reversal");
    expectLines(await entryLines(reversal!.id), [
      ["4751", "300.00", "0.00"],
      ["465", "1573.00", "0.00"],
      ["476", "737.00", "0.00"],
      ["640", "0.00", "2000.00"],
      ["642", "0.00", "610.00"]
    ]);
    // Net 640 across original + reversal + new = 2.000,00.
    const ids = [firstEntryId, reversal!.id, recalc.body.period.journalEntryIds[0]!];
    const all = await prisma.journalLine.findMany({ where: { journalEntryId: { in: ids }, accountCode: "640" } });
    const net = all.reduce((s, l) => s + Math.round(Number(l.debit) * 100) - Math.round(Number(l.credit) * 100), 0);
    assert.equal(net, 200_000);
    const withholding = await prisma.withholdingTaxRecord.count({ where: { sourceType: "payroll_slip", organizationId: ORG_ID, propertyId: PROPERTY_ID, paymentDate: dayUtc("2026-08-31") } });
    assert.equal(withholding, 1, "the old slip's 111 record was removed with it");
  });

  it("GET export is read-only; POST export marks the period exported (and the manager/accountant keys are accepted)", async () => {
    // Legacy GET (server.ts, formats a3|sage) is now read-only.
    const read = await api<{ text: string; exportedAt: string | null; validateWithAdvisor: boolean }>("GET", `/payroll/periods/${periodId}/export?format=sage`);
    assert.equal(read.status, 200, read.raw);
    assert.equal(read.body.exportedAt, null);
    assert.equal(read.body.validateWithAdvisor, true);
    assert.match(read.body.text, /^Employee,Period,Gross,IRPF,SSEmployee,SSEmployer,Net\n.*,2026-08,2000\.00,300\.00,127\.00,610\.00,1573\.00\n$/);
    const still = await prisma.payrollPeriod.findUnique({ where: { id: periodId } });
    assert.equal(still?.status, "calculated");
    assert.equal(still?.exportedAt, null);
    // POST (this lot): CSV universal with decimal comma, marks the period exported.
    const posted = await api<{ exportedAt: string | null; slipCount: number; text: string }>("POST", `/payroll/periods/${periodId}/export`, { format: "csv" });
    assert.equal(posted.status, 200, posted.raw);
    assert.ok(posted.body.exportedAt);
    assert.match(posted.body.text, /periodo;empleado;codigo_empleado/);
    assert.match(posted.body.text, /2026-08;.*;31;2000,00;15;300,00;127,00;610,00;1573,00/);
    const after = await prisma.payrollPeriod.findUnique({ where: { id: periodId } });
    assert.equal(after?.status, "exported");
  });

  // ---- Comisiones ---------------------------------------------------------------
  it("accrues the channel commission at check-out from the GuestCheckedOut event: D 629.1 / H 410", async () => {
    const rule = await api<{ id: string }>("POST", "/commissions/rules", { propertyId: PROPERTY_ID, channelCode: `booking-${suffix}`, ratePct: 15, appliesTo: "total" });
    assert.equal(rule.status, 200, rule.raw);
    ruleId = rule.body.id;
    const result = await accrueCommissionFromEvent({
      eventId: `evt_${suffix}`,
      organizationId: ORG_ID,
      propertyId: PROPERTY_ID,
      entityType: "reservation",
      entityId: reservationId,
      eventType: "GuestCheckedOut",
      payload: {},
      actorType: "user",
      actorUserId: "usr_123",
      correlationId: `corr_${suffix}`,
      hashAlgorithm: "sha256",
      currentHash: "test",
      createdAt: new Date().toISOString()
    });
    assert.ok(result?.accrual, JSON.stringify(result));
    accrualId = result!.accrual!.id;
    assert.equal(result!.created, true);
    assert.equal(result!.accrual!.commissionAmount, "15.00");
    assert.equal(result!.accrual!.baseAmount, "100.00");
    assert.equal(result!.accrual!.status, "accrued");
    expectLines(await entryLines(result!.journalEntryId!), [
      ["410", "0.00", "15.00"],
      ["629.1", "15.00", "0.00"]
    ]);
    // Idempotent: a second delivery of the event does not accrue again.
    const again = await accrueCommissionFromEvent({ eventId: `evt2_${suffix}`, organizationId: ORG_ID, propertyId: PROPERTY_ID, entityType: "reservation", entityId: reservationId, eventType: "GuestCheckedOut", payload: {}, actorType: "user", correlationId: `corr2_${suffix}`, hashAlgorithm: "sha256", currentHash: "test", createdAt: new Date().toISOString() });
    assert.equal(again?.created, false);
    assert.equal(again?.accrual?.id, accrualId);
    assert.equal(await prisma.journalEntry.count({ where: { sourceType: "commission", sourceId: accrualId } }), 1);
  });

  // ---- Banca ----------------------------------------------------------------------
  it("imports the CSB43 file: statement + 6 lines persisted, 5 lines auto-reconciled with their accounting effect", async () => {
    const account = await api<{ id: string; effectiveLedgerAccountCode: string }>("POST", "/banking/accounts", { propertyId: PROPERTY_ID, name: `${MARK} Cuenta principal`, iban: FIXTURE_IBAN, ledgerAccountCode: "572" });
    assert.equal(account.status, 200, account.raw);
    bankAccountId = account.body.id;

    const imported = await api<{ accounts: Array<{ bankAccountId: string; statementId: string; persisted: boolean; newLines: number; duplicateLines: number; matches: Array<{ movementIndex: number; paymentId: string; matchType: string; confidence: string }>; unmatchedMovementIdxs: number[]; warnings: string[] }>; unmatchedPayments: string[]; warnings: string[] }>(
      "POST",
      `/treasury/bank-accounts/${bankAccountId}/statements/import`,
      { format: "csb43", content: csb43 }
    );
    assert.equal(imported.status, 200, imported.raw);
    const acc = imported.body.accounts[0]!;
    assert.equal(acc.bankAccountId, bankAccountId);
    assert.equal(acc.persisted, true);
    assert.equal(acc.newLines, 6);
    assert.equal(acc.duplicateLines, 0);
    statementId = acc.statementId;
    const byIndex = new Map(acc.matches.map((m) => [m.movementIndex, m]));
    assert.deepEqual(
      [0, 1, 3, 4, 5].map((i) => [i, byIndex.get(i)?.matchType]),
      [
        [0, "payment"],
        [1, "card_settlement"],
        [3, "supplier_bill"],
        [4, "payroll_period"],
        [5, "commission_accrual"]
      ],
      JSON.stringify(acc.matches)
    );
    assert.equal(byIndex.get(0)!.paymentId, paymentIds[0]);
    assert.equal(byIndex.get(3)!.paymentId, supplierBillId);
    assert.equal(byIndex.get(4)!.paymentId, periodId);
    assert.equal(byIndex.get(5)!.paymentId, accrualId);
    assert.deepEqual(acc.unmatchedMovementIdxs, [2], "the bank fee waits for a human");
    assert.deepEqual(imported.body.unmatchedPayments, []);

    const statement = await prisma.bankStatement.findUnique({ where: { id: statementId } });
    assert.equal(statement?.openingBalance.toFixed(2), "12500.00");
    assert.equal(statement?.closingBalance.toFixed(2), "11682.10");
    assert.equal(statement?.source, "csb43");
    assert.equal(await prisma.bankStatementLine.count({ where: { statementId } }), 6);
    const matches = await prisma.reconciliationMatch.findMany({ where: { bankAccountId } });
    assert.equal(matches.length, 5);
  });

  it("card settlement entry: D 572 97,50 / D 626 2,50 / H 5721 100,00; supplier, payroll and commission paid from the bank", async () => {
    const matches = await prisma.reconciliationMatch.findMany({ where: { bankAccountId } });
    const byType = new Map(matches.map((m) => [m.matchType, m]));
    const notes = (m: { notes: string | null }) => JSON.parse(m.notes ?? "{}") as { journalEntryId?: string; paymentIds?: string[]; fee?: string };

    const card = notes(byType.get("card_settlement")!);
    assert.deepEqual(card.paymentIds, [paymentIds[1]]);
    assert.equal(card.fee, "2.50");
    const cardLines = await entryLines(card.journalEntryId!);
    assertBalanced(cardLines, "100.00");
    expectLines(cardLines, [
      ["572", "97.50", "0.00"],
      ["5721", "0.00", "100.00"],
      ["626", "2.50", "0.00"]
    ]);

    const bill = await prisma.supplierBill.findUnique({ where: { id: supplierBillId } });
    assert.equal(bill?.status, "paid");
    assert.equal(bill?.paymentDate?.toISOString().slice(0, 10), "2026-09-04");
    expectLines(await entryLines(bill!.paidJournalEntryId!), [
      ["400", "1815.00", "0.00"],
      ["572", "0.00", "1815.00"]
    ]);

    const period = await prisma.payrollPeriod.findUnique({ where: { id: periodId } });
    assert.ok(period?.paidAt, "period paid from the bank line");
    expectLines(await entryLines(period!.paymentJournalEntryId!), [
      ["465", "1573.00", "0.00"],
      ["572", "0.00", "1573.00"]
    ]);
    const slips = await prisma.payrollSlip.findMany({ where: { periodId } });
    assert.ok(slips.every((s) => s.status === "paid"));

    const accrual = await prisma.commissionAccrual.findUnique({ where: { id: accrualId } });
    assert.equal(accrual?.status, "settled");
    expectLines(await entryLines(accrual!.settlementJournalEntryId!), [
      ["410", "15.00", "0.00"],
      ["572", "0.00", "15.00"]
    ]);
  });

  it("manual reconciliation of the bank fee posts D 626 / H 572; a bad body → 400 VALIDATION_ERROR; a matched line → 409", async () => {
    const lines = await prisma.bankStatementLine.findMany({ where: { statementId }, orderBy: [{ txDate: "asc" }, { id: "asc" }] });
    const fee = lines.find((l) => l.amount.toFixed(2) === "-12.40")!;
    const suggestions = await api<{ suggestions: unknown[] }>("GET", `/treasury/bank-lines/${fee.id}/suggestions`);
    assert.equal(suggestions.status, 200, suggestions.raw);
    assert.deepEqual(suggestions.body.suggestions, []);
    const bad = await api("POST", `/treasury/bank-lines/${fee.id}/reconcile`, { matchType: "nope" });
    assert.equal(bad.status, 400, bad.raw);
    assert.equal(bad.body.details?.code, "VALIDATION_ERROR");
    const reconciled = await api<{ journalEntryId: string; matchType: string }>("POST", `/treasury/bank-lines/${fee.id}/reconcile`, { matchType: "bank_fee", notes: "Comisión de mantenimiento trimestral" });
    assert.equal(reconciled.status, 200, reconciled.raw);
    expectLines(await entryLines(reconciled.body.journalEntryId), [
      ["572", "0.00", "12.40"],
      ["626", "12.40", "0.00"]
    ]);
    const again = await api("POST", `/treasury/bank-lines/${fee.id}/reconcile`, { matchType: "bank_fee" });
    assert.equal(again.status, 409, again.raw);
    assert.equal(again.body.details?.code, "LINE_ALREADY_MATCHED");
    const statement = await prisma.bankStatement.findUnique({ where: { id: statementId } });
    assert.equal(statement?.status, "reconciled");
    const status = await api<{ totalLines: number; matched: number; unmatched: number }>("GET", `/banking/accounts/${bankAccountId}/reconciliation-status`);
    assert.equal(status.status, 200, status.raw);
    assert.deepEqual([status.body.totalLines, status.body.matched, status.body.unmatched], [6, 6, 0]);
  });

  it("re-importing the same file persists nothing (6 duplicates, still one statement)", async () => {
    const again = await api<{ accounts: Array<{ persisted: boolean; newLines: number; duplicateLines: number; statementId: string | null; warnings: string[] }> }>("POST", `/treasury/bank-accounts/${bankAccountId}/statements/import`, { format: "csb43", content: csb43 });
    assert.equal(again.status, 200, again.raw);
    const acc = again.body.accounts[0]!;
    assert.equal(acc.persisted, false);
    assert.equal(acc.duplicateLines, 6);
    assert.equal(acc.newLines, 0);
    assert.equal(acc.statementId, statementId);
    assert.ok(acc.warnings.some((w) => w.includes("ya estaban importados")), JSON.stringify(acc.warnings));
    assert.equal(await prisma.bankStatement.count({ where: { bankAccountId } }), 1);
    assert.equal(await prisma.bankStatementLine.count({ where: { bankAccountId } }), 6);
  });

  // ---- Tesorería ------------------------------------------------------------------
  it("treasury position reads the bank closing balance and the ledger 572 moved by exactly −3.317,90", async () => {
    const position = await api<{ banks: Array<{ bankAccountId: string; statementClosing: string | null; reconciledBalance: string; ledgerBalance: string; drift: string; unmatchedLines: number }>; totals: { cashAndBanks: string }; source: string }>("GET", `/treasury/position?propertyId=${PROPERTY_ID}&asOf=2026-09-30`);
    assert.equal(position.status, 200, position.raw);
    const bank = position.body.banks.find((b) => b.bankAccountId === bankAccountId)!;
    assert.equal(bank.statementClosing, "11682.10");
    assert.equal(bank.reconciledBalance, "11682.10");
    assert.equal(bank.unmatchedLines, 0);
    assert.equal(position.body.source, "ledger+statements");
    const after572 = await ledgerBalances(ORG_ID, ["572"], { propertyId: PROPERTY_ID, asOf: dayUtc("2026-09-30") });
    assert.ok(after572.has("572"), "ledgerBalances answers for 572");
    // The 572 movement of THIS suite's documents. Integration 2026-09-16: the
    // suites run in parallel on prop_123 (payables-assets pays a 1.060,00 bill
    // through 572 at the same time), so a before/after balance delta is not
    // isolated; the sum over the entries keyed by our own source ids is.
    const bankLineIds = (await prisma.bankStatementLine.findMany({ where: { bankAccountId }, select: { id: true } })).map((l) => l.id);
    const ownSourceIds = [supplierBillId, periodId, `${accrualId}:settlement`, ...bankLineIds, ...bankLineIds.map((id) => `bankline:${id}:fee`), ...bankLineIds.map((id) => `bankline:${id}:interest`)];
    const ownEntries = await prisma.journalEntry.findMany({ where: { organizationId: ORG_ID, sourceId: { in: ownSourceIds }, status: { in: ["posted", "reversed"] } }, select: { id: true } });
    const own572 = await prisma.journalLine.findMany({ where: { journalEntryId: { in: ownEntries.map((e) => e.id) }, accountCode: "572" }, select: { debit: true, credit: true } });
    const delta = own572.reduce((acc, line) => acc + Math.round(Number(line.debit) * 100) - Math.round(Number(line.credit) * 100), 0);
    // +97,50 (datáfono) − 12,40 (comisión) − 1.815,00 (proveedor) − 1.573,00 (nóminas) − 15,00 (comisión canal)
    assert.equal(delta, -331_790);
    assert.equal((Math.round(Number(bank.statementClosing) * 100) - Math.round(Number(bank.ledgerBalance) * 100)) / 100, Number(bank.drift));

    const payables = await api<{ items: Array<{ kind: string; id: string }>; supplierBills: string }>("GET", `/treasury/payables?propertyId=${PROPERTY_ID}&asOf=2026-09-30`);
    assert.equal(payables.status, 200, payables.raw);
    assert.ok(!payables.body.items.some((i) => i.id === supplierBillId || i.id === periodId || i.id === accrualId), "paid documents leave the payables");
    const receivables = await api<{ items: Array<{ kind: string; id: string }>; method: string[] }>("GET", `/treasury/receivables?propertyId=${PROPERTY_ID}`);
    assert.equal(receivables.status, 200, receivables.raw);
    assert.ok(!receivables.body.items.some((i) => i.id === folioId), "an over-collected folio is not a receivable");
    const forecast = await api<{ buckets: unknown[]; horizons: Array<{ days: number }>; opening: string }>("GET", `/treasury/forecast?propertyId=${PROPERTY_ID}`);
    assert.equal(forecast.status, 200, forecast.raw);
    assert.equal(forecast.body.buckets.length, 5);
    assert.deepEqual(forecast.body.horizons.map((h) => h.days), [30, 60, 90]);
    const dashboard = await api<{ kpis: { cashOnHand: number; accountsPayableTotal: number }; banks: Array<{ bankAccountId: string }>; labels: Record<string, string> }>("GET", `/dashboards/finance-position?propertyId=${PROPERTY_ID}`);
    assert.equal(dashboard.status, 200, dashboard.raw);
    assert.ok(dashboard.body.banks.some((b) => b.bankAccountId === bankAccountId));
    assert.equal(dashboard.body.labels.cashOnHand, "Caja y bancos");
  });

  it("unmatching the payroll line reverses the payment entry and reopens the period", async () => {
    const match = await prisma.reconciliationMatch.findFirst({ where: { bankAccountId, matchType: "payroll_period" } });
    assert.ok(match);
    const undone = await api<{ unmatched: boolean; reversalJournalEntryId: string | null }>("DELETE", `/treasury/bank-lines/${match!.bankLineId}/reconcile`);
    assert.equal(undone.status, 200, undone.raw);
    assert.equal(undone.body.unmatched, true);
    assert.ok(undone.body.reversalJournalEntryId);
    expectLines(await entryLines(undone.body.reversalJournalEntryId!), [
      ["465", "0.00", "1573.00"],
      ["572", "1573.00", "0.00"]
    ]);
    const period = await prisma.payrollPeriod.findUnique({ where: { id: periodId } });
    assert.equal(period?.paidAt, null);
    assert.equal(period?.paymentJournalEntryId, null);
    const statement = await prisma.bankStatement.findUnique({ where: { id: statementId } });
    assert.equal(statement?.status, "pending");
    // Paying again through the payroll route posts a NEW entry (the reversed one no longer represents the payment).
    const pay = await api<{ paymentJournalEntryId: string; paidAt: string }>("POST", `/payroll/periods/${periodId}/pay`, { paidAt: "2026-09-06" });
    assert.equal(pay.status, 200, pay.raw);
    assert.notEqual(pay.body.paymentJournalEntryId, match!.matchedEntityId);
    expectLines(await entryLines(pay.body.paymentJournalEntryId), [
      ["465", "1573.00", "0.00"],
      ["572", "0.00", "1573.00"]
    ]);
    const paidAgain = await prisma.journalEntry.findUnique({ where: { id: pay.body.paymentJournalEntryId } });
    assert.equal(paidAgain?.status, "posted");
    assert.equal(paidAgain?.entryDate.toISOString().slice(0, 10), "2026-09-06");
  });

  // ---- SEPA ---------------------------------------------------------------------------
  it("SEPA remittances persist with status transitions (Norma 19; a hand-made Norma 34 is refused on the generic route)", async () => {
    const norma19 = await api<{ id: string; status: string; messageId: string; xml: string; totalAmount: string; transactions: number }>("POST", "/treasury/sepa/remittances", {
      kind: "norma19",
      propertyId: PROPERTY_ID,
      body: {
        schema: "CORE",
        collectionDate: "2026-09-25",
        sequenceType: "OOFF",
        creditor: { name: `${MARK} Hotel Ejemplo SL`, creditorId: "ES11000B12345674", iban: FIXTURE_IBAN },
        debtors: [{ mandateId: `MND-${suffix}`, mandateSignedAt: "2026-01-10", name: "Viajes Norte SL", iban: "ES9121000418450200051332", amount: "250.00", description: "Depósito grupo", endToEndId: `E2E-${suffix}` }]
      }
    });
    assert.equal(norma19.status, 200, norma19.raw);
    remittanceIds.push(norma19.body.id);
    assert.equal(norma19.body.status, "generated");
    assert.equal(norma19.body.totalAmount, "250.00");
    assert.match(norma19.body.xml, /pain\.008\.001\.02/);
    const list = await api<{ items: Array<{ id: string; status: string }> }>("GET", `/treasury/sepa/remittances?propertyId=${PROPERTY_ID}`);
    assert.equal(list.status, 200, list.raw);
    assert.ok(list.body.items.some((r) => r.id === norma19.body.id));
    const sent = await api<{ status: string; history: unknown[] }>("POST", `/treasury/sepa/remittances/${norma19.body.id}/status`, { status: "sent", note: "Subida a la banca electrónica" });
    assert.equal(sent.status, 200, sent.raw);
    assert.equal(sent.body.status, "sent");
    assert.equal(sent.body.history.length, 2);
    const accepted = await api<{ status: string }>("POST", `/treasury/sepa/remittances/${norma19.body.id}/status`, { status: "accepted" });
    assert.equal(accepted.body.status, "accepted");
    const illegal = await api("POST", `/treasury/sepa/remittances/${norma19.body.id}/status`, { status: "sent" });
    assert.equal(illegal.status, 409, illegal.raw);
    assert.equal(illegal.body.details?.code, "REMITTANCE_STATUS_TRANSITION");
    const detail = await api<{ xml: string; kind: string }>("GET", `/treasury/sepa/remittances/${norma19.body.id}`);
    assert.equal(detail.status, 200, detail.raw);
    assert.equal(detail.body.kind, "norma19");
    assert.match(detail.body.xml, /<CtrlSum>250\.00<\/CtrlSum>/);

    // Corrector CIERRE-1 (REV-02 / FUN-02): a hand-made Norma 34 (a payment order) is refused by the service BEFORE parsing
    // and persisting — the transfer file only leaves through POST /treasury/sepa/supplier-payments (payables.pay + per-bill
    // SoD gate); the platform-admin session of this suite does not bypass it (the gate is not a permission).
    const remittancesBefore = await prisma.workerJobRun.count({ where: { jobName: SEPA_JOB_NAME } });
    const norma34 = await api("POST", "/treasury/sepa/remittances", {
      kind: "norma34",
      propertyId: PROPERTY_ID,
      body: {
        executionDate: "2026-09-26",
        debtor: { name: `${MARK} Hotel Ejemplo SL`, taxId: "B12345674", iban: FIXTURE_IBAN },
        creditors: [{ name: "Suministros del Noroeste SL", iban: "ES9121000418450200051332", amount: "0.10", description: "Factura F-2026-119", endToEndId: `SB-${suffix}`, category: "SUPP" }]
      }
    });
    assert.equal(norma34.status, 403, norma34.raw);
    assert.equal(norma34.body.details?.code, "SUPPLIER_PAYMENT_ROUTE_REQUIRED");
    assert.equal((norma34.body.details as { route?: string } | undefined)?.route, "POST /treasury/sepa/supplier-payments");
    assert.equal(await prisma.workerJobRun.count({ where: { jobName: SEPA_JOB_NAME } }), remittancesBefore, "the refused Norma 34 leaves no row");
    const strict = await api("POST", "/treasury/sepa/remittances", {
      kind: "norma19",
      propertyId: PROPERTY_ID,
      body: { schema: "CORE", collectionDate: "2026-09-25", sequenceType: "OOFF", creditor: { name: "x", creditorId: "ES11000B12345674", iban: FIXTURE_IBAN }, debtors: [], extra: true }
    });
    assert.equal(strict.status, 400, strict.raw);
    assert.equal(strict.body.details?.code, "VALIDATION_ERROR");
  });

  it("legacy routes keep working on the new services: POST /properties/:id/banking/csb43/import persists too", async () => {
    // A second account in the same file would be needed for a fresh import; the legacy route must at least
    // answer with the persisted shape (duplicates → no new statement) and keep the screen's fields.
    const legacy = await api<{ accounts: Array<{ movements: unknown[]; matches: unknown[]; unmatchedMovementIdxs: number[]; persisted: boolean; duplicateLines: number }>; unmatchedPayments: string[] }>("POST", `/properties/${PROPERTY_ID}/banking/csb43/import`, { content: csb43 });
    assert.equal(legacy.status, 200, legacy.raw);
    assert.equal(legacy.body.accounts[0]!.movements.length, 6);
    assert.equal(legacy.body.accounts[0]!.persisted, false);
    assert.equal(legacy.body.accounts[0]!.duplicateLines, 6);
    assert.equal(await prisma.bankStatement.count({ where: { bankAccountId } }), 1);
    void supplierEntryId;
  });
});
