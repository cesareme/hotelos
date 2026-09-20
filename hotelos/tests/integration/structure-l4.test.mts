/**
 * Estructura societaria · L4 «Libro, retenciones, nóminas, tesorería» ·
 * integration (Postgres required; in-process, no HTTP).
 *
 * An ISOLATED organisation (`org_l4_<run>`: one sociedad, one hotel, one head
 * office of kind `office`) created here and removed in `after` exercises the
 * closing criteria of design §6 that fall on L4 (C6 payroll/withholding part,
 * R1 «Tesorería», R2 SEPA identity, R4 work centre and entity-scoped years):
 *   · an asiento with group 6/7 lines and no centre → 400 WORK_CENTER_REQUIRED;
 *     the office is a centre like any hotel; `societyLevel` and balance-only
 *     entries pass; an existing key is still returned idempotently;
 *   · an asiento (engine, manual entry or legacy draft) on a centre of ANOTHER
 *     organisation → opaque 404 PROPERTY_NOT_FOUND at service level, and a
 *     draft of another organisation cannot be posted (fix:L4 t6b#6);
 *   · fiscal years / periods with a propertyId → 400 FISCAL_YEAR_IS_ENTITY_SCOPED;
 *   · payroll: a contract without any centre → 409 WORK_CENTER_REQUIRED and the
 *     whole calculation rolls back (audit event recorded); the office's payroll
 *     posts on the office and its WithholdingTaxRecord enters the Modelo 111
 *     of the sociedad (2.000,00 / 300,00) and of the office view, not the hotel's;
 *   · the gestoría export names the sociedad (NIF, razón social) and the CCC
 *     (principal for an organisation-wide period, the centre's for a per-centre one);
 *   · treasury position / payables per centre and for the whole sociedad
 *     (`scope: "entity"`: every bank account, payroll counted once; a
 *     centre-bound user without accounting.entity.read gets the opaque 404
 *     ENTITY_SCOPE_REQUIRED of every other sociedad read — never a 403 — while
 *     owners without assignments and platform admins pass; fix:L4 t6b#15);
 *   · the SEPA Norma 34 ordenante is the sociedad (409 ISSUER_TAX_ID_MISSING
 *     when its NIF is pending), the payer account must serve the centre, and
 *     the persisted remittance carries the legalEntityId;
 *   · a withholding record on a foreign centre → 409; the office's is upserted
 *     idempotently and the 111 adds row 02.
 *
 * Faranda and org_123 are never written. Run from the repo root:
 *   cd apps/api && node --import tsx --test "../../tests/integration/structure-l4.test.mts"
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import type { UserContext } from "../../apps/api/src/lib/demo-store.js";

try {
  process.loadEnvFile(fileURLToPath(new URL("../../.env", import.meta.url)));
} catch {
  // No .env → CI defaults below.
}
process.env.DATABASE_URL ??= "postgresql://hotelos:hotelos@localhost:5432/hotelos";
process.env.JWT_SECRET ??= "integration-test-secret-32chars-minimum-aaaa";
process.env.ENCRYPTION_KEY ??= "integration-test-enckey-32chars-min-aaaa";
delete process.env.STRUCTURE_ENABLED; // default = enabled

const { prisma } = await import("@hotelos/database");
const accounting = await import("../../apps/api/src/modules/accounting/accounting.service.js");
const fiscalYears = await import("../../apps/api/src/modules/accounting/fiscal-year.service.js");
const fiscalPeriods = await import("../../apps/api/src/modules/accounting/fiscal-period.service.js");
const withholding = await import("../../apps/api/src/modules/accounting/posting-rules/withholding-tax.js");
const modelo111 = await import("../../apps/api/src/modules/accounting/modelo-111.service.js");
const payroll = await import("../../apps/api/src/modules/payroll/periods.service.js");
const payrollExport = await import("../../apps/api/src/modules/payroll/export.service.js");
const treasury = await import("../../apps/api/src/modules/treasury/treasury.service.js");
const sepa = await import("../../apps/api/src/modules/treasury/sepa-remittance.service.js");
const { HttpError } = await import("../../apps/api/src/lib/http-error.js");
const { demoStore } = await import("../../apps/api/src/lib/demo-store.js");
const { flushAuditQueues } = await import("../../apps/api/src/modules/audit/audit.service.js");
const { flushAccountingProjection } = await import("../../apps/api/src/modules/accounting/projection.js");
const { flushExtraProjections } = await import("../../apps/api/src/modules/accounting/posting-rules/index.js");

const RUN = Date.now().toString(36);
const ORG = `org_l4_${RUN}`;
const ENTITY = `le_l4_${RUN}`;
const HOTEL = `prop_l4_ht_${RUN}`;
const OFFICE = `prop_l4_oc_${RUN}`;
const USER = `usr_l4_${RUN}`;
const PROFILE = `sp_l4_${RUN}`;
const CONTRACT = `ct_l4_${RUN}`;
const GHOST = `ct_l4_ghost_${RUN}`;
const BANK_HT = `bank_l4_ht_${RUN}`;
const BANK_OC = `bank_l4_oc_${RUN}`;
const SUPPLIER = `sup_l4_${RUN}`;
const BILL = `sb_l4_${RUN}`;
/** Checksum-valid CIF no demo tenant uses (A76543214: odd 14 + even 12 = 26 → control 4). */
const TAX_ID = "A76543214";
const LEGAL_NAME = "L4 Hoteles Test SA";
const CCC_PRINCIPAL = "33/0001234-56";
const CCC_OFFICE = "28/7654321-00";
const IBAN_HT = "ES9121000418450200051332";
const IBAN_OC = "ES6621000418401234567891";
const IBAN_SUPPLIER = "ES7921000813610123456789";
const CORR = `corr_l4_${RUN}`;

const context = {
  organizationId: ORG,
  propertyId: HOTEL,
  userId: USER,
  fullName: "Dirección L4",
  deviceId: "l4-test",
  // CIERRE-1 · C1: `buildSupplierPaymentRemittance` pasa por `assertSupplierBillPaymentAuthorized` (T9 deuda 17d), que exige `payables.pay`.
  permissions: ["accounting.journal.post", "accounting.read", "accounting.entity.read", "payroll.manage", "banking.reconcile", "banking.read", "payables.pay", "ai.high_risk.confirm"]
} as unknown as UserContext;

type Details = Record<string, unknown>;

async function expectCode<T>(promise: Promise<T>, statusCode: number, code: string): Promise<Details> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof HttpError, `expected an HttpError, got ${String(error)}`);
    assert.equal(error.statusCode, statusCode, `status of ${code}: ${error.message}`);
    const details = (error.details ?? {}) as Details;
    assert.equal(details.code, code, `details.code (${error.message})`);
    return details;
  }
  assert.fail(`expected ${statusCode} ${code}`);
}

async function expectStatus<T>(promise: Promise<T>, statusCode: number): Promise<void> {
  try {
    await promise;
  } catch (error) {
    const status = (error as { statusCode?: number }).statusCode;
    assert.equal(status, statusCode, `expected ${statusCode}, got ${String(error)}`);
    return;
  }
  assert.fail(`expected ${statusCode}`);
}

async function cleanup(): Promise<void> {
  await prisma.workerJobRun.deleteMany({ where: { jobName: sepa.SEPA_JOB_NAME, payloadJson: { path: ["organizationId"], equals: ORG } } });
  await prisma.withholdingTaxRecord.deleteMany({ where: { organizationId: ORG } });
  const periods = await prisma.payrollPeriod.findMany({ where: { organizationId: ORG }, select: { id: true } });
  const slips = periods.length ? await prisma.payrollSlip.findMany({ where: { periodId: { in: periods.map((p) => p.id) } }, select: { id: true } }) : [];
  if (slips.length) await prisma.payrollLine.deleteMany({ where: { slipId: { in: slips.map((s) => s.id) } } });
  if (slips.length) await prisma.payrollSlip.deleteMany({ where: { id: { in: slips.map((s) => s.id) } } });
  await prisma.payrollPeriod.deleteMany({ where: { organizationId: ORG } });
  await prisma.employmentContract.deleteMany({ where: { organizationId: ORG } });
  await prisma.staffProfile.deleteMany({ where: { id: PROFILE } });
  await prisma.user.deleteMany({ where: { organizationId: ORG } });
  await prisma.supplierBill.deleteMany({ where: { organizationId: ORG } });
  await prisma.supplier.deleteMany({ where: { organizationId: ORG } });
  const entries = await prisma.journalEntry.findMany({ where: { organizationId: ORG }, select: { id: true } });
  if (entries.length) await prisma.journalLine.deleteMany({ where: { journalEntryId: { in: entries.map((e) => e.id) } } });
  await prisma.journalEntry.deleteMany({ where: { organizationId: ORG } });
  await prisma.fiscalPeriod.deleteMany({ where: { organizationId: ORG } });
  await prisma.fiscalYear.deleteMany({ where: { organizationId: ORG } });
  await prisma.account.deleteMany({ where: { organizationId: ORG } });
  await prisma.accountingSetting.deleteMany({ where: { organizationId: ORG } });
  await prisma.bankAccount.deleteMany({ where: { organizationId: ORG } });
  await prisma.property.deleteMany({ where: { organizationId: ORG } });
  await prisma.legalEntity.deleteMany({ where: { organizationId: ORG } });
  await prisma.organization.deleteMany({ where: { id: ORG } });
}

before(async () => {
  // Organization without legalName / taxId: every identity below must come from the sociedad.
  await prisma.organization.create({ data: { id: ORG, name: "L4 Sociedad Test", country: "ES" } });
  await prisma.legalEntity.create({
    data: { id: ENTITY, organizationId: ORG, code: "L4T", legalName: LEGAL_NAME, taxId: TAX_ID, legalForm: "sa", cccPrincipal: CCC_PRINCIPAL, fiscalAddress: "Calle Prueba 1", fiscalMunicipality: "Gijón", fiscalProvince: "Asturias", isDefault: true, status: "active" }
  });
  await prisma.property.create({ data: { id: HOTEL, organizationId: ORG, legalEntityId: ENTITY, kind: "hotel", code: "HN", name: "Hotel L4 Norte", createdAt: new Date("2026-01-01T00:00:00Z") } });
  await prisma.property.create({ data: { id: OFFICE, organizationId: ORG, legalEntityId: ENTITY, kind: "office", code: "OC", name: "Oficina central L4", socialSecurityCcc: CCC_OFFICE, createdAt: new Date("2026-01-02T00:00:00Z") } });
  await prisma.user.create({ data: { id: USER, organizationId: ORG, email: `l4-${RUN}@test.local`, fullName: "Empleada Oficina L4" } });
  await prisma.staffProfile.create({ data: { id: PROFILE, userId: USER, propertyId: OFFICE, employeeCode: "OC-001" } });
  await prisma.employmentContract.create({
    data: { id: CONTRACT, staffProfileId: PROFILE, propertyId: OFFICE, organizationId: ORG, contractType: "indefinido", startDate: new Date("2026-01-01T00:00:00Z"), grossSalary: "2000.00", irpfRatePct: "15.00", active: true, createdAt: new Date("2026-01-01T00:00:00Z") }
  });
  // A contract whose employee profile does not exist and that names no centre: the only way to lack one.
  await prisma.employmentContract.create({
    data: { id: GHOST, staffProfileId: `sp_l4_ghost_${RUN}`, propertyId: null, organizationId: ORG, contractType: "temporal", startDate: new Date("2026-01-01T00:00:00Z"), grossSalary: "1000.00", irpfRatePct: "10.00", active: true, createdAt: new Date("2026-01-02T00:00:00Z") }
  });
  await prisma.bankAccount.create({ data: { id: BANK_HT, propertyId: HOTEL, organizationId: ORG, legalEntityId: ENTITY, name: "Banco Hotel Norte", iban: IBAN_HT } });
  await prisma.bankAccount.create({ data: { id: BANK_OC, propertyId: OFFICE, organizationId: ORG, legalEntityId: ENTITY, name: "Banco Sociedad (oficina)", iban: IBAN_OC } });
  await prisma.supplier.create({ data: { id: SUPPLIER, organizationId: ORG, name: "Asesoría Fiscal L4 SL", taxId: "B76543218", iban: IBAN_SUPPLIER } });
  await prisma.supplierBill.create({
    data: { id: BILL, propertyId: OFFICE, organizationId: ORG, supplierId: SUPPLIER, supplierName: "Asesoría Fiscal L4 SL", invoiceNumber: `AS-${RUN}`, issueDate: new Date("2026-08-05T00:00:00Z"), baseTotal: "100.00", taxTotal: "21.00", total: "121.00", status: "posted", postedAt: new Date() }
  });
});

after(async () => {
  try {
    await flushAuditQueues();
    await flushAccountingProjection();
    await flushExtraProjections();
    await cleanup();
  } finally {
    await prisma.$disconnect();
  }
});

describe("estructura societaria · L4 · organización aislada (sociedad + hotel + oficina central)", () => {
  let periodId = "";
  let officePeriodId = "";

  it("R4 · asiento 6/7 sin centro → 400 WORK_CENTER_REQUIRED; oficina, societyLevel o solo balance → contabiliza", async () => {
    const base = { organizationId: ORG, entryDate: "2026-08-10", sourceType: "manual", description: "Suministros sin centro", createdBy: USER };
    const lines = [{ accountCode: "628", debit: "100.00" }, { accountCode: "572", credit: "100.00" }];
    const details = await expectCode(accounting.postJournalEntry({ ...base, propertyId: null, sourceId: `l4-nocentre-${RUN}`, lines }), 400, "WORK_CENTER_REQUIRED");
    assert.deepEqual(details.lines, [1]);
    assert.equal(details.sourceType, "manual");
    assert.equal(await prisma.journalEntry.count({ where: { organizationId: ORG } }), 0, "nothing was posted");

    const office = await accounting.postJournalEntry({ ...base, propertyId: OFFICE, sourceId: `l4-office-${RUN}`, lines });
    assert.equal(office.created, true);
    assert.equal(office.propertyId, OFFICE, "the head office is a centre like any hotel");
    assert.equal(office.entryNumber, 1);
    assert.equal(office.fiscalYearCode, "2026");

    const society = await accounting.postJournalEntry({ ...base, propertyId: null, sourceId: `l4-society-${RUN}`, description: "Ajuste de sociedad (sin centro)", societyLevel: true, lines });
    assert.equal(society.created, true);
    assert.equal(society.propertyId, null);

    const balance = await accounting.postJournalEntry({ ...base, propertyId: null, sourceId: `l4-balance-${RUN}`, description: "Traspaso de caja a banco", lines: [{ accountCode: "572", debit: "50.00" }, { accountCode: "570", credit: "50.00" }] });
    assert.equal(balance.created, true, "balance-sheet-only entries never need a centre");

    // The user-facing manual entry: the flag travels from the body.
    const manualLines = [{ accountCode: "628", debit: "10.00" }, { accountCode: "572", credit: "10.00" }];
    await expectCode(accounting.createManualJournalEntry({ context, body: { entryDate: "2026-08-11", description: "Manual sin centro", lines: manualLines }, correlationId: CORR }), 400, "WORK_CENTER_REQUIRED");
    const manual = await accounting.createManualJournalEntry({ context, body: { entryDate: "2026-08-11", description: "Manual de sociedad", societyLevel: true, lines: manualLines }, correlationId: CORR });
    assert.equal(manual.propertyId, null);

    // An existing (legacy-like) key is returned as-is: the guard sits after the idempotent lookup.
    const again = await accounting.postJournalEntry({ ...base, propertyId: null, sourceId: `l4-society-${RUN}`, lines });
    assert.equal(again.created, false);
    assert.equal(again.id, society.id);
    assert.equal(await prisma.journalEntry.count({ where: { organizationId: ORG } }), 4);
  });

  it("R10.1 · un centro de OTRA organización → 404 PROPERTY_NOT_FOUND a nivel de servicio (manual, motor y borrador); un borrador ajeno no se contabiliza", async () => {
    const before = await prisma.journalEntry.count({ where: { organizationId: ORG } });
    const lines = [{ accountCode: "628", debit: "10.00" }, { accountCode: "572", credit: "10.00" }];
    // The exact repro of t6b#6: the user-facing manual entry with org_123's centre (prop_123) from the test organisation's context.
    const foreign = await expectCode(accounting.createManualJournalEntry({ context, body: { entryDate: "2026-08-12", description: "Centro ajeno", propertyId: "prop_123", lines }, correlationId: CORR }), 404, "PROPERTY_NOT_FOUND");
    assert.equal(foreign.propertyId, "prop_123");
    // The engine itself (what posting rules, the assistant and scripts call): foreign and unknown centres get the same answer.
    const unknown = await expectCode(accounting.postJournalEntry({ organizationId: ORG, propertyId: `prop_l4_missing_${RUN}`, entryDate: "2026-08-12", sourceType: "manual", sourceId: `l4-missing-${RUN}`, description: "Centro inexistente", lines }), 404, "PROPERTY_NOT_FOUND");
    assert.equal(unknown.propertyId, `prop_l4_missing_${RUN}`);
    await expectCode(accounting.postJournalEntry({ organizationId: ORG, propertyId: "prop_123", entryDate: "2026-08-12", sourceType: "manual", sourceId: `l4-foreign-${RUN}`, description: "Centro ajeno (motor)", lines }), 404, "PROPERTY_NOT_FOUND");
    // Balance-only lines do not bypass the guard (R4 is about groups 6/7; R10.1 is about tenancy).
    await expectCode(accounting.postJournalEntry({ organizationId: ORG, propertyId: "prop_123", entryDate: "2026-08-12", sourceType: "manual", sourceId: `l4-foreign-bal-${RUN}`, description: "Traspaso ajeno", lines: [{ accountCode: "572", debit: "1.00" }, { accountCode: "570", credit: "1.00" }] }), 404, "PROPERTY_NOT_FOUND");
    // The legacy draft flow.
    const draftLines = [{ accountCode: "628", debit: 10, credit: 0 }, { accountCode: "572", debit: 0, credit: 10 }];
    await expectCode(accounting.createJournalEntryDraft({ organizationId: ORG, propertyId: "prop_123", sourceType: "manual", entryDate: "2026-08-12", description: "Borrador ajeno", lines: draftLines }), 404, "PROPERTY_NOT_FOUND");
    assert.equal(await prisma.journalEntry.count({ where: { organizationId: ORG } }), before, "nothing was written");
    assert.equal(await prisma.journalEntry.count({ where: { organizationId: ORG, propertyId: "prop_123" } }), 0, "no asiento of the test organisation points at org_123's centre");

    // A draft of this organisation cannot be posted from another organisation's context (opaque 404), and posts normally from its own.
    const draft = await accounting.createJournalEntryDraft({ organizationId: ORG, propertyId: HOTEL, sourceType: "manual", entryDate: "2026-08-12", description: "Borrador del hotel", lines: draftLines });
    assert.equal(draft.status, "draft");
    await expectStatus(accounting.postJournalEntry({ context: { ...context, organizationId: "org_123", propertyId: "prop_123" } as UserContext, journalEntryId: draft.id, correlationId: CORR }), 404);
    assert.equal((await prisma.journalEntry.findUnique({ where: { id: draft.id }, select: { status: true } }))?.status, "draft", "the foreign context did not post it");
    const posted = await accounting.postJournalEntry({ context, journalEntryId: draft.id, correlationId: CORR });
    assert.equal(posted.status, "posted");
    assert.equal(posted.propertyId, HOTEL);
    assert.equal(await prisma.journalEntry.count({ where: { organizationId: ORG } }), before + 1);
  });

  it("R4 · ejercicios y periodos fiscales solo de la sociedad → 400 FISCAL_YEAR_IS_ENTITY_SCOPED con propertyId", async () => {
    const yearInput = { context, code: "2026", startDate: "2026-01-01", endDate: "2026-12-31", correlationId: CORR };
    const year = await expectCode(fiscalYears.createFiscalYear({ ...yearInput, propertyId: HOTEL }), 400, "FISCAL_YEAR_IS_ENTITY_SCOPED");
    assert.equal(year.subject, "ejercicio");
    assert.equal(year.propertyId, HOTEL);
    await expectCode(fiscalYears.listFiscalYears({ context, propertyId: OFFICE }), 400, "FISCAL_YEAR_IS_ENTITY_SCOPED");
    const period = await expectCode(fiscalPeriods.openFiscalPeriod({ context, propertyId: HOTEL, periodCode: "2026-08", periodType: "month", startDate: "2026-08-01", endDate: "2026-08-31", correlationId: CORR }), 400, "FISCAL_YEAR_IS_ENTITY_SCOPED");
    assert.equal(period.subject, "periodo");
    assert.equal(await prisma.fiscalYear.count({ where: { organizationId: ORG } }), 0);
    assert.equal(await prisma.fiscalPeriod.count({ where: { organizationId: ORG } }), 0);

    const created = await fiscalYears.createFiscalYear(yearInput);
    assert.equal(created.propertyId, undefined);
    assert.equal(created.status, "open");
    const listed = await fiscalYears.listFiscalYears({ context });
    assert.deepEqual(listed.map((y) => y.code), ["2026"]);
    assert.equal(await prisma.fiscalYear.count({ where: { organizationId: ORG, propertyId: { not: null } } }), 0, "no property-scoped year exists");
  });

  it("nóminas · un contrato sin ningún centro → 409 WORK_CENTER_REQUIRED, todo el cálculo revierte y queda auditado", async () => {
    await expectStatus(payroll.createPeriod({ context, organizationId: ORG, propertyId: "prop_123", periodCode: "2026-07", correlationId: CORR }), 404);
    const period = await payroll.createPeriod({ context, organizationId: ORG, periodCode: "2026-08", correlationId: CORR });
    periodId = period.id;
    assert.equal(period.propertyId, undefined, "organisation-wide period");

    const details = await expectCode(payroll.calculatePeriod({ context, periodId, correlationId: CORR }), 409, "WORK_CENTER_REQUIRED");
    assert.equal(details.contractId, GHOST);
    assert.equal(details.source, "payroll_slip");
    assert.equal(details.periodCode, "2026-08");
    assert.equal(await prisma.payrollSlip.count({ where: { periodId } }), 0, "the slip of the valid contract rolled back with the failure");
    assert.equal(await prisma.withholdingTaxRecord.count({ where: { organizationId: ORG } }), 0);
    assert.equal(await prisma.journalEntry.count({ where: { organizationId: ORG, sourceType: "payroll_slip" } }), 0);
    assert.equal((await prisma.payrollPeriod.findUnique({ where: { id: periodId } }))?.status, "open");
    assert.ok(demoStore.auditEvents.some((e) => e.action === "PAYROLL_WORK_CENTER_REQUIRED" && e.entityId === GHOST && e.organizationId === ORG), "audit event recorded before the rollback");
  });

  it("C6 · la nómina de la oficina central contabiliza en la oficina y su retención entra en el Modelo 111 de la sociedad (2.000,00 / 300,00 · tipos 2026: 130,00 / 643,00 → 1.570,00)", async () => {
    await prisma.employmentContract.update({ where: { id: GHOST }, data: { active: false } });
    const result = await payroll.calculatePeriod({ context, periodId, correlationId: CORR });
    assert.equal(result.slipIds.length, 1);
    assert.equal(result.journalEntryIds.length, 1);
    assert.equal(result.period.totalGross, 2000);
    assert.equal(result.period.totalIrpf, 300);
    assert.equal(result.period.totalNet, 1570);

    const entry = await accounting.loadJournalEntry(prisma, result.journalEntryIds[0]!);
    assert.equal(entry?.propertyId, OFFICE, "the 640/642 lines carry the office as work centre");
    assert.deepEqual(
      entry?.lines.map((l) => [l.accountCode, l.debit, l.credit]),
      [
        ["640", "2000.00", "0.00"],
        ["642", "643.00", "0.00"],
        ["465", "0.00", "1570.00"],
        ["4751", "0.00", "300.00"],
        ["476", "0.00", "773.00"]
      ]
    );

    const records = await prisma.withholdingTaxRecord.findMany({ where: { organizationId: ORG } });
    assert.equal(records.length, 1);
    assert.equal(records[0]!.propertyId, OFFICE);
    assert.equal(records[0]!.sourceType, "payroll_slip");
    assert.equal(records[0]!.rowCode, "01");
    assert.equal(records[0]!.grossAmount.toFixed(2), "2000.00");
    assert.equal(records[0]!.retentionAmount.toFixed(2), "300.00");
    assert.equal((await prisma.property.findUnique({ where: { id: OFFICE }, select: { kind: true } }))?.kind, "office");

    // Modelo 111 · 2026-Q3: the sociedad and the office view include it; the hotel view does not.
    const entity = await modelo111.buildModelo111({ context, period: "2026-Q3" });
    const row01 = entity.detalle.find((row) => row.clave === "01");
    assert.ok(row01, "row 01 (rendimientos del trabajo) present in the sociedad's 111");
    assert.equal(Number(row01.base), 2000);
    assert.equal(Number(row01.retenciones), 300);
    assert.equal(row01.registros, 1);
    const officeView = await modelo111.buildModelo111({ context, period: "2026-Q3", propertyId: OFFICE });
    assert.equal(Number(officeView.detalle.find((row) => row.clave === "01")?.retenciones), 300);
    const hotelView = await modelo111.buildModelo111({ context, period: "2026-Q3", propertyId: HOTEL });
    assert.equal(hotelView.detalle.find((row) => row.clave === "01"), undefined, "the hotel view carries no office payroll");
  });

  it("nóminas · el empleador de la exportación es la sociedad: NIF, razón social y CCC (principal u oficina)", async () => {
    const csv = await payrollExport.buildPayrollExport(periodId, "csv");
    assert.equal(csv.employer.legalEntityId, ENTITY);
    assert.equal(csv.employer.legalName, LEGAL_NAME);
    assert.equal(csv.employer.taxId, TAX_ID);
    assert.equal(csv.employer.taxIdValid, true);
    assert.equal(csv.employer.identitySource, "legal_entity");
    assert.equal(csv.employer.workCenterId, null);
    assert.equal(csv.employer.ccc, CCC_PRINCIPAL, "organisation-wide period → CCC principal of the sociedad");
    assert.equal(csv.employer.cccSource, "legal_entity");
    const lines = csv.text.replace(/^﻿/, "").trimEnd().split("\n");
    assert.ok(lines[0]!.endsWith(";nif_empresa;ccc"), lines[0]);
    assert.equal(lines.length, 2);
    assert.ok(lines[1]!.endsWith(`;2000,00;15;300,00;130,00;643,00;1570,00;${TAX_ID};${CCC_PRINCIPAL}`), lines[1]);
    assert.ok(!csv.warnings.some((w) => /no tiene NIF|backfill pendiente|CCC/.test(w)), csv.warnings.join(" | "));
    const a3 = await payrollExport.buildPayrollExport(periodId, "a3");
    assert.ok(a3.text.startsWith(`${TAX_ID}|OC-001|Empleada Oficina L4|2026-08|2000.00|300.00|`), a3.text);

    // A per-centre period on the office uses the office's provincial CCC.
    const officePeriod = await payroll.createPeriod({ context, organizationId: ORG, propertyId: OFFICE, periodCode: "2026-09", correlationId: CORR });
    officePeriodId = officePeriod.id;
    const calculated = await payroll.calculatePeriod({ context, periodId: officePeriodId, correlationId: CORR });
    assert.equal(calculated.slipIds.length, 1);
    const officeCsv = await payrollExport.buildPayrollExport(officePeriodId, "csv");
    assert.equal(officeCsv.employer.workCenterId, OFFICE);
    assert.equal(officeCsv.employer.ccc, CCC_OFFICE);
    assert.equal(officeCsv.employer.cccSource, "work_center");
    assert.equal(await prisma.withholdingTaxRecord.count({ where: { organizationId: ORG, propertyId: OFFICE } }), 2);
  });

  it("R1 · posición de tesorería por centro y para toda la sociedad (bancos de todos los centros, nóminas una sola vez, 404 ENTITY_SCOPE_REQUIRED para un usuario de centro sin accounting.entity.read)", async () => {
    const hotel = await treasury.treasuryPosition({ propertyId: HOTEL });
    assert.equal(hotel.scope, "property");
    assert.equal(hotel.propertyId, HOTEL);
    assert.equal(hotel.legalEntityId, ENTITY);
    assert.equal(hotel.entityLabel, LEGAL_NAME);
    assert.deepEqual(hotel.banks.map((b) => [b.bankAccountId, b.propertyId]), [[BANK_HT, HOTEL]]);

    const entity = await treasury.treasuryPosition({ scope: "entity", organizationId: ORG, context });
    assert.equal(entity.scope, "entity");
    assert.equal(entity.propertyId, null);
    assert.equal(entity.legalEntityId, ENTITY);
    assert.equal(entity.entityLabel, LEGAL_NAME);
    assert.deepEqual(entity.banks.map((b) => b.bankAccountId).sort(), [BANK_HT, BANK_OC].sort(), "every bank account of the sociedad");
    assert.ok(entity.warnings.some((w) => /comparten la subcuenta 572/.test(w)), "both accounts sit on 572 → honest warning");

    // Ledger liabilities are «as of» the accounting date: 16/09 sits between the two payroll entries (31/08 · 30/09).
    const AS_OF = new Date("2026-09-16T00:00:00Z");
    const payablesEntity = await treasury.treasuryPayables({ scope: "entity", organizationId: ORG, context, asOf: AS_OF });
    assert.equal(payablesEntity.scope, "entity");
    assert.equal(payablesEntity.payroll, "3140.00", "2026-08 (organisation-wide) + 2026-09 (office), each once");
    assert.equal(payablesEntity.supplierBills, "121.00", "the office's posted bill");
    assert.equal(payablesEntity.taxLiabilities, "1073.00", "as of 16/09: 4751 300,00 + 476 773,00 of the August payroll (the September slip is dated 30/09)");
    const later = await treasury.treasuryPayables({ scope: "entity", organizationId: ORG, context, asOf: new Date("2026-10-01T00:00:00Z") });
    assert.equal(later.taxLiabilities, "2146.00", "as of 1/10 both payrolls are booked: 4751 600,00 + 476 1.546,00");
    const payablesHotel = await treasury.treasuryPayables({ propertyId: HOTEL, asOf: AS_OF });
    assert.equal(payablesHotel.payroll, "1570.00", "a centre sees its own periods and the organisation-wide one");
    assert.equal(payablesHotel.supplierBills, "0.00");
    assert.equal(payablesHotel.taxLiabilities, "0.00", "the payroll liabilities were posted on the office");
    const payablesOffice = await treasury.treasuryPayables({ propertyId: OFFICE, asOf: AS_OF });
    assert.equal(payablesOffice.payroll, "3140.00");
    assert.equal(payablesOffice.supplierBills, "121.00");
    assert.equal(payablesOffice.taxLiabilities, "1073.00");

    const forecast = await treasury.treasuryForecast({ scope: "entity", organizationId: ORG, context });
    assert.equal(forecast.scope, "entity");
    assert.equal(forecast.items.filter((i) => i.kind === "payroll_period").length, 2);
    const receivables = await treasury.treasuryReceivables({ scope: "entity", organizationId: ORG, context });
    assert.equal(receivables.total, "0.00");

    // fix:L4 t6b#15 · a centre-bound director without accounting.entity.read gets the opaque 404 of every other sociedad read — never a 403 naming the key.
    const director = { ...context, permissions: ["banking.read", "accounting.read"], assignedPropertyIds: [HOTEL] } as UserContext;
    const denied = await expectCode(treasury.treasuryPosition({ scope: "entity", organizationId: ORG, context: director }), 404, "ENTITY_SCOPE_REQUIRED");
    assert.equal(denied.requiredPermission, "accounting.entity.read");
    await expectCode(treasury.treasuryPayables({ scope: "entity", organizationId: ORG, context: director }), 404, "ENTITY_SCOPE_REQUIRED");
    await expectCode(treasury.treasuryReceivables({ scope: "entity", organizationId: ORG, context: director }), 404, "ENTITY_SCOPE_REQUIRED");
    await expectCode(treasury.treasuryForecast({ scope: "entity", organizationId: ORG, context: director }), 404, "ENTITY_SCOPE_REQUIRED");
    // The same status a missing centre gets: neither answer is an oracle of the sociedad's structure.
    await expectStatus(treasury.treasuryPosition({ propertyId: `prop_l4_missing_${RUN}` }), 404);
    // An owner without property assignments keeps the organisation-wide scope even without the key (mirror of isPropertyAssigned)…
    const owner = await treasury.treasuryPosition({ scope: "entity", organizationId: ORG, context: { ...context, permissions: ["banking.read", "accounting.read"] } as UserContext });
    assert.equal(owner.scope, "entity");
    assert.equal(owner.banks.length, 2);
    // …and so does a platform admin with assignments and without the key.
    const admin = await treasury.treasuryPosition({ scope: "entity", organizationId: ORG, context: { ...director, isPlatformAdmin: true } as UserContext });
    assert.equal(admin.scope, "entity");
    assert.equal(admin.legalEntityId, ENTITY);
  });

  it("R2 · la remesa SEPA lleva la identidad de la sociedad; la cuenta ordenante debe servir al centro; 409 ISSUER_TAX_ID_MISSING sin NIF", async () => {
    const built = await sepa.buildSupplierPaymentRemittance({ context, propertyId: OFFICE, bankAccountId: BANK_OC, billIds: [BILL], executionDate: "2026-09-20" });
    assert.equal(built.body.debtor.name, LEGAL_NAME);
    assert.equal(built.body.debtor.taxId, TAX_ID);
    assert.equal(built.body.debtor.iban, IBAN_OC);
    assert.equal(built.totalAmount, "121.00");
    assert.deepEqual(built.skipped, []);
    assert.equal(built.body.creditors[0]?.iban, IBAN_SUPPLIER);

    await expectStatus(sepa.buildSupplierPaymentRemittance({ context, propertyId: OFFICE, bankAccountId: BANK_HT, billIds: [BILL], executionDate: "2026-09-20" }), 404);

    const record = await sepa.createRemittance({ context, propertyId: OFFICE, kind: "norma34", body: built.body, bankAccountId: BANK_OC, correlationId: CORR });
    assert.equal(record.legalEntityId, ENTITY);
    assert.equal(record.bankAccountId, BANK_OC);
    assert.equal(record.totalAmount, "121.00");
    assert.match(record.xml, new RegExp(TAX_ID));
    const fetched = await sepa.getRemittance({ context, id: record.id });
    assert.equal(fetched.legalEntityId, ENTITY);

    await prisma.legalEntity.update({ where: { id: ENTITY }, data: { taxId: null } });
    try {
      const details = await expectCode(sepa.buildSupplierPaymentRemittance({ context, propertyId: OFFICE, bankAccountId: BANK_OC, billIds: [BILL], executionDate: "2026-09-20" }), 409, "ISSUER_TAX_ID_MISSING");
      assert.equal(details.legalEntityId, ENTITY);
    } finally {
      await prisma.legalEntity.update({ where: { id: ENTITY }, data: { taxId: TAX_ID } });
    }
  });

  it("retenciones · un centro ajeno → 409 WORK_CENTER_REQUIRED; la factura de la oficina se registra (idempotente) y el 111 suma la fila 02", async () => {
    const draft = { organizationId: ORG, sourceType: "vendor_invoice" as const, recipientNif: "12345678Z", recipientName: "Asesoría Fiscal L4 SL", grossAmount: "100.00", retentionRate: "15.00", retentionAmount: "15.00", paymentDate: "2026-08-05" };
    const foreign = await expectCode(withholding.upsertWithholdingRecord({ ...draft, propertyId: "prop_123", sourceId: `l4-foreign-${RUN}` }), 409, "WORK_CENTER_REQUIRED");
    assert.equal(foreign.reason, "PROPERTY_NOT_IN_ORGANIZATION");
    assert.equal(await prisma.withholdingTaxRecord.count({ where: { sourceId: `l4-foreign-${RUN}` } }), 0);

    const created = await withholding.upsertWithholdingRecord({ ...draft, propertyId: OFFICE, sourceId: BILL });
    assert.equal(created.propertyId, OFFICE);
    assert.equal(created.rowCode, "02");
    const again = await withholding.upsertWithholdingRecord({ ...draft, propertyId: OFFICE, sourceId: BILL, retentionAmount: "15.00" });
    assert.equal(again.id, created.id, "idempotent by (sourceType, sourceId)");
    assert.equal(await prisma.withholdingTaxRecord.count({ where: { organizationId: ORG } }), 3);

    const report = await modelo111.buildModelo111({ context, period: "2026-Q3" });
    const row01 = report.detalle.find((row) => row.clave === "01");
    const row02 = report.detalle.find((row) => row.clave === "02");
    assert.equal(Number(row01?.base), 4000, "two office payrolls (2026-08, 2026-09)");
    assert.equal(Number(row01?.retenciones), 600);
    assert.equal(Number(row02?.base), 100);
    assert.equal(Number(row02?.retenciones), 15);
  });
});
