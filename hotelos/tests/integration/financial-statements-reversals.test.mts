/**
 * Finanzas · estados financieros · hallazgo t6#2 (asientos revertidos) ·
 * integration (in-process services against Postgres).
 *
 * An ISOLATED organisation (created and deleted by this suite; Faranda and
 * org_123 are never touched) gets the template chart and a handful of entries
 * written through the REAL ledger writers (postJournalEntry /
 * reverseJournalEntry of accounting.service), so every reversal pair has the
 * exact shape production writes: the original flagged `status = reversed` +
 * `reversedById`, the inverse with `reversalOfId` + `entryKind = reversal`.
 * The SQL reader of the financial-statements module must then:
 *   · give, account by account, the same debit / credit as
 *     accounting.service.aggregateAccountBalances (the criterion of the trial
 *     balance and of the year-end regularization) — «PyG = mayor»;
 *   · report PyG / balance / USALI after an annulled invoice (reversal dated
 *     the day of the annulment) and a recalculated payroll (slip reversed +
 *     new slip) equal to the figures without the pairs — before the fix the
 *     reversal alone was counted (`status = 'posted'`): revenue −100 and
 *     labour −2.610 subtracted twice;
 *   · restore the pre-close statements when a closed year is reopened
 *     (regularization + closing + opening reversed, never deleted);
 *   · keep BOTH halves of every pair in the gestoría CSV (libro diario) with
 *     Σ debe = Σ haber.
 *
 * Run from the repo root:
 *   cd apps/api && node --import tsx --test "../../tests/integration/financial-statements-reversals.test.mts"
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
const accounting = await import("../../apps/api/src/modules/accounting/accounting.service.js");
const { provisionOrganizationChart } = await import("../../apps/api/src/modules/accounting/chart-of-accounts.service.js");
const { prismaFinancialStatementsSource } = await import("../../apps/api/src/modules/financial-statements/source.js");
const { buildAnnualAccounts } = await import("../../apps/api/src/modules/financial-statements/annual-accounts.service.js");
const { buildUsaliPnl } = await import("../../apps/api/src/modules/financial-statements/usali.service.js");
const { buildCsvUniversal } = await import("../../apps/api/src/modules/financial-statements/gestoria-export.service.js");
const { prisma } = await import("@hotelos/database");

type ApiApp = Awaited<ReturnType<typeof buildApiServer>>;
type LineSpec = { accountCode: string; debit?: string; credit?: string; taxRateCode?: string; taxBase?: string };

const RUN = Date.now().toString(36);
const ORG = `fs_rev_org_${RUN}`;
const PROPERTY = `fs_rev_prop_${RUN}`;
const YEAR = { from: "2029-01-01", to: "2029-12-31" };
const Q1 = { from: "2029-01-01", to: "2029-03-31" };
const NEXT_Q1 = { from: "2030-01-01", to: "2030-03-31" };

const context = () => ({
  organizationId: ORG,
  propertyId: PROPERTY,
  userId: "fs-rev-test-user",
  fullName: "FS Reversals Test",
  deviceId: "fs-rev-test",
  permissions: ["accounting.read", "accounting.configure", "analytics.export"] as never
});

async function post(spec: { date: string; sourceType: string; sourceId: string; description: string; reference?: string; entryKind?: "normal" | "regularization" | "closing" | "opening"; lines: LineSpec[] }) {
  return accounting.postJournalEntry({
    organizationId: ORG,
    propertyId: PROPERTY,
    entryDate: spec.date,
    sourceType: spec.sourceType,
    sourceId: spec.sourceId,
    description: spec.description,
    reference: spec.reference ?? null,
    entryKind: spec.entryKind ?? "normal",
    ignoreClosedPeriod: spec.entryKind !== undefined && spec.entryKind !== "normal",
    lines: spec.lines
  });
}

/** code → "debit/credit" of a row set, to compare two readers literally. */
function figures(rows: Array<{ code?: string; accountCode?: string; debit: { toFixed(n: number): string }; credit: { toFixed(n: number): string } }>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const row of rows) out[row.code ?? row.accountCode ?? "?"] = `${row.debit.toFixed(2)}/${row.credit.toFixed(2)}`;
  return out;
}

const lineAmount = (lines: Array<{ id: string; amount: string }>, id: string): string => lines.find((l) => l.id === id)?.amount ?? "∅";

describe("financial statements · reversed entries through the real ledger writers (isolated organisation)", () => {
  let app: ApiApp;
  let invoiceAId = "";
  let slipAId = "";
  const closeIds: Array<{ id: string; kind: string; date: string }> = [];

  before(async () => {
    app = await buildApiServer(); // hydrates the audit chain once, like every integration suite
    await app.ready();
    await prisma.organization.create({ data: { id: ORG, name: `FS Reversals ${RUN}`, legalName: `FS Reversals ${RUN} SL`, taxId: "B12345674" } });
    await prisma.property.create({ data: { id: PROPERTY, organizationId: ORG, name: "Hotel Reversals", address: "Calle Real 1", municipality: "A Coruña", province: "A Coruña" } });
    await provisionOrganizationChart(ORG);

    await post({ date: "2029-01-02", sourceType: "manual", sourceId: "capital", description: "Aportación de capital", lines: [{ accountCode: "572", debit: "60000.00" }, { accountCode: "100", credit: "60000.00" }] });
    const invoiceA = await post({
      date: "2029-03-10",
      sourceType: "invoice",
      sourceId: "inv_a",
      reference: "FAC-2029-000001",
      description: "Factura alojamiento (se anulará)",
      lines: [{ accountCode: "4300", debit: "121.00" }, { accountCode: "705.1", credit: "100.00", taxRateCode: "21" }, { accountCode: "477.21", credit: "21.00", taxRateCode: "21", taxBase: "100.00" }]
    });
    invoiceAId = invoiceA.id;
    await post({
      date: "2029-03-11",
      sourceType: "invoice",
      sourceId: "inv_b",
      reference: "FAC-2029-000002",
      description: "Factura restauración",
      lines: [{ accountCode: "4300", debit: "55.00" }, { accountCode: "705.2", credit: "50.00", taxRateCode: "10" }, { accountCode: "477.10", credit: "5.00", taxRateCode: "10", taxBase: "50.00" }]
    });
    await post({ date: "2029-03-12", sourceType: "payment", sourceId: "pay_b", description: "Cobro en efectivo FAC-2029-000002", lines: [{ accountCode: "570", debit: "55.00" }, { accountCode: "4300", credit: "55.00" }] });
    const slipA = await post({
      date: "2029-03-31",
      sourceType: "payroll_slip",
      sourceId: "slip_a",
      description: "Nómina marzo (primer cálculo)",
      lines: [{ accountCode: "640.1", debit: "2000.00" }, { accountCode: "642.1", debit: "610.00" }, { accountCode: "476", credit: "800.00" }, { accountCode: "4751", credit: "300.00" }, { accountCode: "465", credit: "1510.00" }]
    });
    slipAId = slipA.id;
    await post({ date: "2029-03-31", sourceType: "manual", sourceId: "rent_03", description: "Alquiler marzo", lines: [{ accountCode: "621", debit: "500.00" }, { accountCode: "410", credit: "500.00" }] });
  });

  after(async () => {
    const entries = await prisma.journalEntry.findMany({ where: { organizationId: ORG }, select: { id: true } });
    if (entries.length) await prisma.journalLine.deleteMany({ where: { journalEntryId: { in: entries.map((e) => e.id) } } });
    await prisma.journalEntry.deleteMany({ where: { organizationId: ORG } });
    await prisma.fiscalPeriod.deleteMany({ where: { organizationId: ORG } });
    await prisma.fiscalYear.deleteMany({ where: { organizationId: ORG } });
    await prisma.financialStatementSnapshot.deleteMany({ where: { organizationId: ORG } });
    await prisma.gestoriaExport.deleteMany({ where: { organizationId: ORG } });
    await prisma.usaliMapping.deleteMany({ where: { organizationId: ORG } });
    await prisma.vatSettings.deleteMany({ where: { organizationId: ORG } });
    await prisma.accountingSetting.deleteMany({ where: { organizationId: ORG } });
    await prisma.account.deleteMany({ where: { organizationId: ORG } });
    await prisma.property.deleteMany({ where: { id: PROPERTY } });
    await prisma.organization.deleteMany({ where: { id: ORG } });
    await app.close();
  });

  it("baseline before any reversal: PyG −2.960,00, USALI rooms 100 / labour 2.610, reader = aggregateAccountBalances", async () => {
    const accounts = await buildAnnualAccounts({ context: context() as never, ...YEAR });
    assert.equal(accounts.pyg.netResult, "-2960.00");
    assert.equal(lineAmount(accounts.pyg.lines, "P1"), "150.00");
    assert.equal(accounts.balance.balanced, true, accounts.balance.warnings.join("; "));
    assert.equal(accounts.balance.totalAssets, "60176.00"); // 572 60.000 + 570 55 + 4300 121 (invoice A still pending)
    const pnl = await buildUsaliPnl({ context: context() as never, propertyId: PROPERTY, ...Q1 });
    const rooms = pnl.operatingDepartments.find((d) => d.department === "rooms")!;
    assert.equal(rooms.revenue, "100.00");
    assert.equal(rooms.labor, "2610.00");
    const reader = await prismaFinancialStatementsSource.accountBalances({ organizationId: ORG, propertyId: PROPERTY, mode: "movements", ...YEAR });
    const reference = await accounting.aggregateAccountBalances({ organizationId: ORG, propertyId: PROPERTY, from: YEAR.from, to: YEAR.to, excludeKinds: ["regularization", "closing", "opening"] });
    assert.deepEqual(figures(reader), figures(reference));
  });

  it("an annulled invoice and a recalculated payroll: the writer marks the pairs and the statements show the surviving entries only", async () => {
    const cancellation = await accounting.reverseJournalEntry({
      organizationId: ORG,
      journalEntryId: invoiceAId,
      reason: "cliente no presentado",
      entryDate: "2029-04-02", // dated the day of the annulment, a later period than the issue
      sourceType: "invoice_cancellation",
      sourceId: "inv_a",
      description: "Anulación de la factura FAC-2029-000001: cliente no presentado"
    });
    const slipReversal = await accounting.reverseJournalEntry({ organizationId: ORG, journalEntryId: slipAId, reason: "recálculo de la nómina", sourceType: "payroll_slip_reversal", sourceId: "slip_a" });
    await post({
      date: "2029-03-31",
      sourceType: "payroll_slip",
      sourceId: "slip_b",
      description: "Nómina marzo (recalculada)",
      lines: [{ accountCode: "640.1", debit: "1800.00" }, { accountCode: "642.1", debit: "550.00" }, { accountCode: "476", credit: "720.00" }, { accountCode: "4751", credit: "270.00" }, { accountCode: "465", credit: "1360.00" }]
    });

    // The contract the reader relies on (docs/runbooks/finanzas-contabilidad.md §1.3), as written by the real writer.
    const pairs = await prisma.journalEntry.findMany({ where: { id: { in: [invoiceAId, cancellation.id, slipAId, slipReversal.id] } }, select: { id: true, status: true, entryKind: true, reversalOfId: true, reversedById: true, entryDate: true } });
    const byId = new Map(pairs.map((p) => [p.id, p]));
    assert.equal(byId.get(invoiceAId)?.status, "reversed");
    assert.equal(byId.get(invoiceAId)?.reversedById, cancellation.id);
    assert.equal(byId.get(cancellation.id)?.status, "posted");
    assert.equal(byId.get(cancellation.id)?.entryKind, "reversal");
    assert.equal(byId.get(cancellation.id)?.reversalOfId, invoiceAId);
    assert.equal(byId.get(cancellation.id)?.entryDate.toISOString().slice(0, 10), "2029-04-02");
    assert.equal(byId.get(slipAId)?.status, "reversed");
    assert.equal(byId.get(slipReversal.id)?.reversalOfId, slipAId);

    const accounts = await buildAnnualAccounts({ context: context() as never, ...YEAR });
    // Before the fix: 50 − 100 (reversal alone) − 1.800 − 550 − 500 + 2.610 (slip reversal alone) = −290,00.
    assert.equal(accounts.pyg.netResult, "-2800.00");
    assert.equal(lineAmount(accounts.pyg.lines, "P1"), "50.00");
    assert.equal(lineAmount(accounts.pyg.lines, "P6"), "-2350.00");
    assert.equal(accounts.balance.balanced, true, accounts.balance.warnings.join("; "));
    assert.equal(accounts.balance.totalAssets, "60055.00"); // 572 60.000 + 570 55; the annulled 121 is no receivable
    assert.equal(accounts.balance.periodResult, "-2800.00");
    assert.equal(accounts.balance.equity.total, "57200.00");
    assert.equal(accounts.balance.liabilities.total, "2855.00"); // 477.10 5 + 410 500 + 476 720 + 4751 270 + 465 1.360
    assert.deepEqual(accounts.balance.warnings, []);
    assert.equal(accounts.coherence.ok, true);

    const pnl = await buildUsaliPnl({ context: context() as never, propertyId: PROPERTY, ...Q1 });
    const rooms = pnl.operatingDepartments.find((d) => d.department === "rooms")!;
    assert.equal(rooms.revenue, "0.00");
    assert.equal(rooms.labor, "2350.00");
    assert.equal(pnl.reconciliation.pgcRevenue, "50.00");
    assert.equal(pnl.reconciliation.pgcResult, "-2800.00");
    assert.equal(pnl.reconciliation.ok, true);

    // Same figures as the ledger's own aggregation (trial balance / regularization criterion), in both read modes.
    const movements = await prismaFinancialStatementsSource.accountBalances({ organizationId: ORG, propertyId: PROPERTY, mode: "movements", ...YEAR });
    const movementsRef = await accounting.aggregateAccountBalances({ organizationId: ORG, propertyId: PROPERTY, from: YEAR.from, to: YEAR.to, excludeKinds: ["regularization", "closing", "opening"] });
    assert.deepEqual(figures(movements), figures(movementsRef));
    assert.equal(figures(movements)["705.1"], undefined); // both halves out: the account has no surviving movement
    assert.equal(figures(movements)["640.1"], "1800.00/0.00");
    const at = await prismaFinancialStatementsSource.accountBalances({ organizationId: ORG, propertyId: PROPERTY, mode: "balance_at", to: YEAR.to });
    const atRef = await accounting.aggregateAccountBalances({ organizationId: ORG, propertyId: PROPERTY, to: YEAR.to, closingCutoff: YEAR.to });
    assert.deepEqual(figures(at), figures(atRef));
  });

  it("closing the year then reopening it (three marked reversals) restores the pre-close statements; 2030 reports the result pending regularization", async () => {
    const regularization = await post({
      date: "2029-12-31",
      sourceType: "regularization",
      sourceId: "year-close:test:regularization",
      description: "Regularización 2029",
      entryKind: "regularization",
      lines: [{ accountCode: "705.2", debit: "50.00" }, { accountCode: "129", debit: "2800.00" }, { accountCode: "640.1", credit: "1800.00" }, { accountCode: "642.1", credit: "550.00" }, { accountCode: "621", credit: "500.00" }]
    });
    const closingLines: LineSpec[] = [
      { accountCode: "100", debit: "60000.00" },
      { accountCode: "477.10", debit: "5.00" },
      { accountCode: "410", debit: "500.00" },
      { accountCode: "476", debit: "720.00" },
      { accountCode: "4751", debit: "270.00" },
      { accountCode: "465", debit: "1360.00" },
      { accountCode: "570", credit: "55.00" },
      { accountCode: "572", credit: "60000.00" },
      { accountCode: "129", credit: "2800.00" }
    ];
    const closing = await post({ date: "2029-12-31", sourceType: "closing", sourceId: "year-close:test:closing", description: "Cierre 2029", entryKind: "closing", lines: closingLines });
    const opening = await post({ date: "2030-01-01", sourceType: "opening", sourceId: "year-close:test:opening", description: "Apertura 2030", entryKind: "opening", lines: closingLines.map((l) => ({ accountCode: l.accountCode, debit: l.credit, credit: l.debit })) });
    closeIds.push({ id: regularization.id, kind: "regularization", date: "2029-12-31" }, { id: closing.id, kind: "closing", date: "2029-12-31" }, { id: opening.id, kind: "opening", date: "2030-01-01" });

    const closed = await buildAnnualAccounts({ context: context() as never, ...YEAR });
    assert.equal(closed.pyg.netResult, "-2800.00");
    assert.equal(closed.balance.totalAssets, "60055.00");
    assert.equal(closed.balance.balanced, true, closed.balance.warnings.join("; "));
    const nextClosed = await buildAnnualAccounts({ context: context() as never, ...NEXT_Q1 });
    assert.equal(nextClosed.balance.priorUnregularisedResult, "0.00");
    assert.equal(lineAmount(nextClosed.balance.equity.lines, "E_V"), "-2800.00");

    for (const entry of closeIds) {
      await accounting.reverseJournalEntry({
        organizationId: ORG,
        journalEntryId: entry.id,
        reason: "reapertura del ejercicio 2029: prueba",
        entryDate: entry.date,
        sourceType: "reversal",
        sourceId: `year-reopen:test:${entry.kind}:${entry.id}`,
        ignoreClosedPeriod: true
      });
    }
    const stillThere = await prisma.journalEntry.count({ where: { organizationId: ORG, id: { in: closeIds.map((e) => e.id) } } });
    assert.equal(stillThere, 3, "reopening marks, never deletes");
    const reversals = await prisma.journalEntry.count({ where: { organizationId: ORG, entryKind: "reversal", reversalOfId: { in: closeIds.map((e) => e.id) } } });
    assert.equal(reversals, 3);

    const reopened = await buildAnnualAccounts({ context: context() as never, ...YEAR });
    assert.equal(reopened.pyg.netResult, "-2800.00");
    assert.equal(reopened.balance.balanced, true, reopened.balance.warnings.join("; "));
    assert.equal(reopened.balance.totalAssets, "60055.00"); // before the fix the closing reversal was added on top of the excluded closing: −4.591,20-style figures
    assert.equal(reopened.balance.periodResult, "-2800.00");
    assert.equal(lineAmount(reopened.balance.equity.lines, "E_VII"), "-2800.00");
    assert.equal(lineAmount(reopened.balance.equity.lines, "E_V"), "0.00");
    assert.deepEqual(reopened.balance.warnings, []);
    assert.equal(reopened.coherence.ok, true);
    const nextReopened = await buildAnnualAccounts({ context: context() as never, ...NEXT_Q1 });
    assert.equal(nextReopened.balance.balanced, true, nextReopened.balance.warnings.join("; "));
    assert.equal(nextReopened.balance.totalAssets, "60055.00");
    assert.equal(nextReopened.balance.priorUnregularisedResult, "-2800.00");
    assert.match(nextReopened.balance.warnings.join(" "), /sin regularizar/);

    const at = await prismaFinancialStatementsSource.accountBalances({ organizationId: ORG, propertyId: PROPERTY, mode: "balance_at", to: YEAR.to });
    const atRef = await accounting.aggregateAccountBalances({ organizationId: ORG, propertyId: PROPERTY, to: YEAR.to, closingCutoff: YEAR.to });
    assert.deepEqual(figures(at), figures(atRef));
  });

  it("the gestoría CSV (libro diario) keeps both halves of every pair, numbered, and Σ debe = Σ haber", async () => {
    const build = await buildCsvUniversal(prismaFinancialStatementsSource, { organizationId: ORG, propertyId: PROPERTY, from: YEAR.from, to: YEAR.to });
    const lines = build.content.slice(1).split("\r\n").filter(Boolean).slice(1);
    const cells = lines.map((line) => line.split(";"));
    const rows705_1 = cells.filter((c) => c[2] === "705.1").map((c) => `${c[0]} ${c[4]}/${c[5]}`).sort();
    assert.deepEqual(rows705_1, ["02/04/2029 100,00/0,00", "10/03/2029 0,00/100,00"]); // issue + its annulment
    const rows640_1 = cells.filter((c) => c[2] === "640.1").length;
    assert.equal(rows640_1, 5); // slip A, its reversal, slip B, regularization, reversal of the regularization
    const debe = cells.reduce((sum, c) => sum + Number(c[4]!.replace(",", ".")), 0);
    const haber = cells.reduce((sum, c) => sum + Number(c[5]!.replace(",", ".")), 0);
    assert.equal(debe.toFixed(2), haber.toFixed(2));
    assert.equal(build.unnumbered, 0, "the real writer numbers every entry, reversals included");
    assert.ok(cells.every((c) => !c[1]!.startsWith("P-")));
  });
});
