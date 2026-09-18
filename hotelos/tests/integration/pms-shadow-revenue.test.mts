/**
 * Ingresos diarios de OPERA (modo sombra) · Tanda 7b · L2 — integración
 * (Postgres, en proceso, sin HTTP). Una organización AISLADA `org_pr_<run>` (una
 * sociedad, un hotel RA con perfil de modo sombra `RIAS` y un segundo hotel sin
 * perfil) creada aquí y borrada en `after` recorre el servicio con el XML
 * SINTÉTICO de GEN_XMLBO_REVENUE (6 códigos + paid out):
 *   · preview → líneas mapeadas, canPost, nada escrito;
 *   · import + post → JournalEntry sourceType pms_shadow_revenue, sourceId
 *     `<propertyId>:<date>`, 6 líneas cuadradas (H 705.1 / 705.2 / 705.3 con centro,
 *     H 477.10 / 477.21, D 4300), CostCenter ROOMS / FNB / OTHER_OPERATED creados una vez;
 *   · mismo fichero → 409 PMS_SHADOW_REVENUE_DUPLICATE; mismo día otro fichero → 409
 *     PMS_SHADOW_REVENUE_ALREADY_POSTED; `replace` → anterior reversed con
 *     reversalJournalEntryIds + replacedById y nuevo posted en una sola transacción;
 *   · reverse → status reversed, asiento original con reversedById; segundo reverso → 409;
 *   · hotel_code ajeno → 409 HOTEL_MISMATCH; businessDate distinta → 400 DAY_MISMATCH;
 *   · borrador (`post: false`) + postPmsShadowRevenue; `replace` sin `post` → 400;
 *   · periodo cerrado (closeFiscalPeriod del mes) → 409 FISCAL_PERIOD_CLOSED y NINGÚN lote nuevo;
 *   · código sin mapear → 400 OPERA_TRX_CODE_UNMAPPED y nada escrito;
 *   · listado, detalle (404 opaco desde otra propiedad) y reconciliationForDay.
 * Faranda y org_123 nunca se escriben. Desde el repo:
 *   cd apps/api && node --env-file-if-exists=../../.env --import tsx --test "../../tests/integration/pms-shadow-revenue.test.mts"
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
delete process.env.STRUCTURE_ENABLED;

const { prisma } = await import("@hotelos/database");
const accounting = await import("../../apps/api/src/modules/accounting/accounting.service.js");
const fiscalPeriods = await import("../../apps/api/src/modules/accounting/fiscal-period.service.js");
const revenue = await import("../../apps/api/src/modules/pms-shadow/revenue-import.service.js");
const { HttpError } = await import("../../apps/api/src/lib/http-error.js");
const { flushAuditQueues } = await import("../../apps/api/src/modules/audit/audit.service.js");
const { flushAccountingProjection } = await import("../../apps/api/src/modules/accounting/projection.js");
const { flushExtraProjections } = await import("../../apps/api/src/modules/accounting/posting-rules/index.js");

const RUN = Date.now().toString(36);
const ORG = `org_pr_${RUN}`;
const ENTITY = `le_pr_${RUN}`;
const RA = `prop_pr_ra_${RUN}`;
const LT = `prop_pr_lt_${RUN}`;
const USER = `usr_pr_${RUN}`;
const CORR = `corr_pr_${RUN}`;
/** CIF sintético «A» + 7 dígitos del run + control válido (algoritmo del CIF): distinto en cada ejecución y de la suite hermana payroll-cost-import (A87654323), que corre en paralelo. */
function syntheticCif(seed: number): string {
  const digits = String(seed % 10_000_000).padStart(7, "0");
  let sum = 0;
  for (let i = 0; i < 7; i++) {
    const digit = Number(digits[i]);
    if (i % 2 === 0) {
      const doubled = digit * 2;
      sum += Math.floor(doubled / 10) + (doubled % 10);
    } else {
      sum += digit;
    }
  }
  return `A${digits}${(10 - (sum % 10)) % 10}`;
}
const TAX_ID = syntheticCif(Date.now());
const HOTEL_CODE = "RIAS";

const context = {
  organizationId: ORG,
  propertyId: RA,
  userId: USER,
  fullName: "Contable PR",
  deviceId: "pr-test",
  // Tanda 8a (design §4.6): the period close is accounting.period.close, apart from the manual asiento.
  permissions: ["accounting.journal.post", "accounting.period.close", "accounting.read", "accounting.entity.read"]
} as unknown as UserContext;
const reader = { ...context, permissions: ["accounting.read"] } as unknown as UserContext;
const noPermission = { ...context, permissions: ["pms.reservation.read"] } as unknown as UserContext;

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

type Code = { code: string; description: string; type: string; amount: string };

const CODES_A: Code[] = [
  { code: "1000", description: "Lodging", type: "REVENUE", amount: "1234.50" },
  { code: "2000", description: "F&B Restaurant", type: "REVENUE", amount: "310.00" },
  { code: "3000", description: "Minibar", type: "REVENUE", amount: "25.00" },
  { code: "8100", description: "IVA 10%", type: "REVENUE", amount: "154.45" },
  { code: "8200", description: "IVA 21%", type: "REVENUE", amount: "5.25" },
  { code: "9000", description: "Cash", type: "PAYMENT", amount: "-900.00" },
  { code: "9500", description: "Paid Out", type: "PAID OUT", amount: "40.00" }
];

function xmlFor(date: string, codes: readonly Code[], hotelCode = HOTEL_CODE): string {
  const totals = codes
    .map(
      (c) => `  <transaction_total transaction_type="${c.type}">
    <transaction_code>${c.code}</transaction_code>
    <description>${c.description.replace(/&/g, "&amp;")}</description>
    <total_amount>${c.amount}</total_amount>
    <total_guest_ledger>${c.amount}</total_guest_ledger>
    <total_package_ledger>0.00</total_package_ledger>
    <total_ar_ledger>0.00</total_ar_ledger>
    <total_deposit_ledger>0.00</total_deposit_ledger>
  </transaction_total>`
    )
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<revenue hotel_code="${hotelCode}" date="${date}">\n${totals}\n</revenue>\n`;
}

const DAY = "2026-09-15";
const XML_A = xmlFor(DAY, CODES_A);
/** Mismo día, otros importes (Lodging 1300,00). */
const XML_B = xmlFor(DAY, CODES_A.map((c) => (c.code === "1000" ? { ...c, amount: "1300.00" } : c)));
const DAY_C = "2026-09-16";
const XML_C = xmlFor(DAY_C, CODES_A);
const DAY_D = "2026-09-17";
const XML_D = xmlFor(DAY_D, CODES_A);
/** Código 4000 «Spa» sin mapeo. */
const DAY_E = "2026-09-18";
const XML_E = xmlFor(DAY_E, [...CODES_A, { code: "4000", description: "Spa", type: "REVENUE", amount: "80.00" }]);
/** Mes que se cierra: agosto. */
const DAY_F = "2026-08-20";
const XML_F = xmlFor(DAY_F, CODES_A);

const MAPPING = [
  { code: "1000", description: "Lodging", kind: "revenue", accountCode: "705.1", usaliDepartment: "rooms" },
  { code: "2000", kind: "revenue", accountCode: "705.2", usaliDepartment: "fnb" },
  { code: "3000", kind: "revenue", accountCode: "705.3", usaliDepartment: "other_operated" },
  { code: "8100", kind: "tax", accountCode: "477.10", taxRateCode: "10" },
  { code: "8200", kind: "tax", accountCode: "477.21", taxRateCode: "21" },
  { code: "9000", kind: "payment", accountCode: "570" },
  { code: "9500", kind: "ignore" }
];

async function cleanup(): Promise<void> {
  await prisma.pmsShadowRun.deleteMany({ where: { organizationId: ORG } });
  await prisma.pmsShadowRevenueImport.deleteMany({ where: { organizationId: ORG } });
  await prisma.pmsShadowProfile.deleteMany({ where: { organizationId: ORG } });
  await prisma.costCenter.deleteMany({ where: { propertyId: { in: [RA, LT] } } });
  const entries = await prisma.journalEntry.findMany({ where: { organizationId: ORG }, select: { id: true } });
  if (entries.length) await prisma.journalLine.deleteMany({ where: { journalEntryId: { in: entries.map((e) => e.id) } } });
  await prisma.journalEntry.deleteMany({ where: { organizationId: ORG } });
  await prisma.fiscalPeriod.deleteMany({ where: { organizationId: ORG } });
  await prisma.fiscalYear.deleteMany({ where: { organizationId: ORG } });
  await prisma.account.deleteMany({ where: { organizationId: ORG } });
  await prisma.accountingSetting.deleteMany({ where: { organizationId: ORG } });
  await prisma.property.deleteMany({ where: { organizationId: ORG } });
  await prisma.legalEntity.deleteMany({ where: { organizationId: ORG } });
  await prisma.organization.deleteMany({ where: { id: ORG } });
}

before(async () => {
  await prisma.organization.create({ data: { id: ORG, name: "PR Sociedad Test", country: "ES" } });
  await prisma.legalEntity.create({ data: { id: ENTITY, organizationId: ORG, code: "PRT", legalName: "PR Hoteles Test SA", taxId: TAX_ID, legalForm: "sa", fiscalAddress: "Calle Prueba 7", fiscalMunicipality: "A Coruña", fiscalProvince: "A Coruña", isDefault: true, status: "active" } });
  await prisma.property.create({ data: { id: RA, organizationId: ORG, legalEntityId: ENTITY, kind: "hotel", code: "RA", name: "Rías Altas Test", createdAt: new Date("2026-01-01T00:00:00Z") } });
  await prisma.property.create({ data: { id: LT, organizationId: ORG, legalEntityId: ENTITY, kind: "hotel", code: "LT", name: "Los Tilos Test", createdAt: new Date("2026-01-02T00:00:00Z") } });
  await prisma.fiscalYear.create({ data: { organizationId: ORG, propertyId: null, code: "2026", startDate: new Date("2026-01-01T00:00:00Z"), endDate: new Date("2026-12-31T00:00:00Z"), status: "open" } });
  await prisma.pmsShadowProfile.create({ data: { organizationId: ORG, propertyId: RA, system: "opera_cloud", operaHotelCode: HOTEL_CODE, status: "active", trxMappingJson: MAPPING } });
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

async function countImports(): Promise<number> {
  return prisma.pmsShadowRevenueImport.count({ where: { organizationId: ORG } });
}

async function countEntries(): Promise<number> {
  return prisma.journalEntry.count({ where: { organizationId: ORG } });
}

describe("ingresos diarios OPERA · organización aislada (sociedad + RA con perfil RIAS + LT)", () => {
  let importA = "";
  let entryA = "";
  let hashA = "";
  let importB = "";

  it("preview: 7 líneas mapeadas, totales, canPost y nada escrito; permiso exigido", async () => {
    await assert.rejects(revenue.previewPmsShadowRevenue({ context: noPermission, propertyId: RA, body: { content: XML_A } }), /accounting\.journal\.post/, "sin accounting.journal.post → PermissionDeniedError (403 en el borde)");
    const preview = await revenue.previewPmsShadowRevenue({ context, propertyId: RA, body: { content: XML_A, fileName: "GEN_XMLBO_REVENUE_RIAS.xml", reconciliation: { transactionTotalToday: "869.20" } } });
    assert.equal(preview.source, "xml_revenue");
    assert.equal(preview.hotelCode, HOTEL_CODE);
    assert.equal(preview.businessDate, DAY);
    assert.equal(preview.lines.length, 7);
    assert.deepEqual(preview.unmapped, []);
    assert.deepEqual(preview.totals, { revenue: "1569.50", tax: "159.70", payments: "900.00", other: "40.00" });
    assert.deepEqual(preview.reconciliation, { transactionTotalToday: "869.20", sumTotalAmount: "869.20", delta: "0.00", ok: true });
    assert.deepEqual(preview.blockers, []);
    assert.equal(preview.canPost, true);
    assert.equal(await countImports(), 0, "la preview nunca escribe");
    assert.equal(await countEntries(), 0);
    assert.equal(await prisma.costCenter.count({ where: { propertyId: RA } }), 0);

    const unmapped = await revenue.previewPmsShadowRevenue({ context, propertyId: RA, body: { content: XML_E } });
    assert.equal(unmapped.canPost, false);
    assert.deepEqual(unmapped.unmapped.map((line) => line.code), ["4000"]);
    assert.ok(unmapped.blockers.some((b) => b.code === "OPERA_TRX_CODE_UNMAPPED"));
  });

  it("import + post → asiento pms_shadow_revenue con sourceId <propertyId>:<date>, 6 líneas cuadradas y centros USALI creados una vez", async () => {
    const result = await revenue.importPmsShadowRevenue({ context, propertyId: RA, body: { content: XML_A, fileName: "GEN_XMLBO_REVENUE_RIAS_20260915.xml", post: true, replace: false, reconciliation: { transactionTotalToday: "869.20", roomRevenue: "1234.50" } }, correlationId: CORR });
    importA = result.id;
    hashA = result.contentHash;
    assert.match(hashA, /^[0-9a-f]{64}$/);
    assert.equal(result.status, "posted");
    assert.equal(result.organizationId, ORG);
    assert.equal(result.propertyId, RA);
    assert.equal(result.businessDate, DAY);
    assert.equal(result.source, "xml_revenue");
    assert.equal(result.fileName, "GEN_XMLBO_REVENUE_RIAS_20260915.xml");
    assert.equal(result.journalEntryIds.length, 1);
    assert.deepEqual(result.reversalJournalEntryIds, []);
    assert.ok(result.postedAt);
    assert.equal(result.createdBy, USER);
    assert.equal(result.lines.length, 7);
    assert.ok(result.lines.every((line) => line.mapped));
    assert.deepEqual(result.totals, { revenue: "1569.50", tax: "159.70", payments: "900.00", other: "40.00" });
    assert.equal(result.reconciliation?.ok, true);
    assert.equal(result.replacedById, null);
    entryA = result.journalEntryIds[0]!;

    const view = (await accounting.loadJournalEntry(prisma, entryA))!;
    assert.equal(view.sourceType, "pms_shadow_revenue");
    assert.equal(view.sourceId, `${RA}:${DAY}`);
    assert.equal(view.propertyId, RA);
    assert.equal(view.entryDate, DAY);
    assert.equal(view.reference, DAY);
    assert.equal(view.status, "posted");
    assert.equal(view.fiscalYearCode, "2026");
    assert.ok(view.entryNumber && view.entryNumber >= 1);
    assert.equal(view.description, `Ingresos OPERA · RA · ${DAY}`);
    assert.equal(view.lines.length, 6);
    assert.equal(view.totalDebit, "1729.20");
    assert.equal(view.totalCredit, "1729.20");
    const byAccount = new Map(view.lines.map((line) => [line.accountCode, line]));
    assert.equal(byAccount.get("705.1")?.credit, "1234.50");
    assert.equal(byAccount.get("705.2")?.credit, "310.00");
    assert.equal(byAccount.get("705.3")?.credit, "25.00");
    assert.equal(byAccount.get("477.10")?.credit, "154.45");
    assert.equal(byAccount.get("477.10")?.taxRateCode, "10");
    assert.equal(byAccount.get("477.21")?.credit, "5.25");
    assert.equal(byAccount.get("4300")?.debit, "1729.20");
    assert.equal(byAccount.get("705.1")?.description, "1000 · Lodging");
    for (const code of ["705.1", "705.2", "705.3"]) {
      const line = byAccount.get(code)!;
      assert.ok(line.costCenterId, `${code} lleva centro de coste`);
      const centre = await prisma.costCenter.findUnique({ where: { id: line.costCenterId! } });
      assert.equal(centre?.propertyId, RA);
      assert.equal(centre?.type, "usali");
      assert.equal(centre?.active, true);
    }
    assert.equal(byAccount.get("477.10")?.costCenterId, null);
    assert.equal(byAccount.get("4300")?.costCenterId, null);
    const centres = await prisma.costCenter.findMany({ where: { propertyId: RA }, orderBy: { code: "asc" } });
    assert.deepEqual(centres.map((c) => c.code), ["FNB", "OTHER_OPERATED", "ROOMS"]);
    assert.equal(await countImports(), 1);
    assert.equal(await countEntries(), 1);
  });

  it("mismo fichero → 409 PMS_SHADOW_REVENUE_DUPLICATE; mismo día otro fichero → 409 PMS_SHADOW_REVENUE_ALREADY_POSTED; nada escrito", async () => {
    const duplicate = await expectCode(revenue.importPmsShadowRevenue({ context, propertyId: RA, body: { content: XML_A, post: true, replace: false }, correlationId: CORR }), 409, "PMS_SHADOW_REVENUE_DUPLICATE");
    assert.equal(duplicate.importId, importA);
    const posted = await expectCode(revenue.importPmsShadowRevenue({ context, propertyId: RA, body: { content: XML_B, post: true, replace: false }, correlationId: CORR }), 409, "PMS_SHADOW_REVENUE_ALREADY_POSTED");
    assert.equal(posted.importId, importA);
    assert.equal(posted.businessDate, DAY);
    // La preview lo anticipa como blocker.
    const preview = await revenue.previewPmsShadowRevenue({ context, propertyId: RA, body: { content: XML_B } });
    assert.equal(preview.canPost, false);
    assert.ok(preview.blockers.some((b) => b.code === "PMS_SHADOW_REVENUE_ALREADY_POSTED"));
    assert.equal(await countImports(), 1);
    assert.equal(await countEntries(), 1);
    assert.equal(await prisma.costCenter.count({ where: { propertyId: RA } }), 3, "los centros no se duplican");
  });

  it("replace → el lote anterior queda reversed (reversalJournalEntryIds, replacedById) y el nuevo posted en una sola transacción", async () => {
    const result = await revenue.importPmsShadowRevenue({ context, propertyId: RA, body: { content: XML_B, fileName: "b.xml", post: true, replace: true }, correlationId: CORR });
    importB = result.id;
    assert.equal(result.status, "posted");
    assert.equal(result.businessDate, DAY);
    assert.equal(result.journalEntryIds.length, 1);
    assert.equal(result.totals.revenue, "1635.00");

    const previous = await revenue.getPmsShadowRevenueImport({ context, propertyId: RA, importId: importA });
    assert.equal(previous.status, "reversed");
    assert.equal(previous.replacedById, importB);
    assert.equal(previous.reversalJournalEntryIds.length, 1);
    assert.equal(previous.reversedBy, USER);
    assert.match(previous.reversalReason ?? "", new RegExp(`sustituido por ${importB}`));
    const original = (await accounting.loadJournalEntry(prisma, entryA))!;
    assert.equal(original.status, "reversed");
    assert.equal(original.reversedById, previous.reversalJournalEntryIds[0]);
    const reversal = (await accounting.loadJournalEntry(prisma, previous.reversalJournalEntryIds[0]!))!;
    assert.equal(reversal.reversalOfId, entryA);
    assert.equal(reversal.entryDate, DAY);
    assert.equal(reversal.lines.find((l) => l.accountCode === "705.1")?.debit, "1234.50", "el reverso invierte los lados");

    const fresh = (await accounting.loadJournalEntry(prisma, result.journalEntryIds[0]!))!;
    assert.equal(fresh.sourceType, "pms_shadow_revenue");
    assert.equal(fresh.status, "posted");
    assert.match(fresh.sourceId ?? "", new RegExp(`^${RA}:${DAY}(#\\d+)?$`), "misma clave de día (sufijo del puente tras el reverso)");
    assert.equal(fresh.lines.find((l) => l.accountCode === "705.1")?.credit, "1300.00");
    assert.equal(fresh.lines.find((l) => l.accountCode === "705.1")?.costCenterId, original.lines.find((l) => l.accountCode === "705.1")?.costCenterId, "reutiliza el CostCenter ROOMS");
    assert.equal(await countImports(), 2);
    assert.equal(await countEntries(), 3, "original + reverso + nuevo");
    assert.equal(await prisma.costCenter.count({ where: { propertyId: RA } }), 3);
  });

  it("reverse → status reversed, asiento con reversedById; segundo reverso → 409 NOT_POSTED; motivo obligatorio", async () => {
    const result = await revenue.importPmsShadowRevenue({ context, propertyId: RA, body: { content: XML_C, fileName: "c.xml", post: true, replace: false }, correlationId: CORR });
    assert.equal(result.status, "posted");
    await expectCode(revenue.reversePmsShadowRevenue({ context, propertyId: RA, importId: result.id, reason: "   ", correlationId: CORR }), 400, "JOURNAL_REVERSAL_REASON_REQUIRED");
    await expectCode(revenue.reversePmsShadowRevenue({ context, propertyId: RA, importId: result.id, reason: "x".repeat(501), correlationId: CORR }), 400, "VALIDATION_ERROR");
    const reversed = await revenue.reversePmsShadowRevenue({ context, propertyId: RA, importId: result.id, reason: "fichero regenerado en OPERA", correlationId: CORR });
    assert.equal(reversed.status, "reversed");
    assert.equal(reversed.reversalJournalEntryIds.length, 1);
    assert.equal(reversed.reversalReason, "fichero regenerado en OPERA");
    assert.equal(reversed.reversedBy, USER);
    assert.ok(reversed.reversedAt);
    assert.equal(reversed.replacedById, null);
    const original = (await accounting.loadJournalEntry(prisma, result.journalEntryIds[0]!))!;
    assert.equal(original.status, "reversed");
    assert.equal(original.reversedById, reversed.reversalJournalEntryIds[0]);
    await expectCode(revenue.reversePmsShadowRevenue({ context, propertyId: RA, importId: result.id, reason: "otra vez", correlationId: CORR }), 409, "PMS_SHADOW_REVENUE_NOT_POSTED");
    // El día vuelve a estar libre: el mismo fichero se puede importar de nuevo (hash solo bloquea lotes vivos).
    const again = await revenue.importPmsShadowRevenue({ context, propertyId: RA, body: { content: XML_C, post: true, replace: false }, correlationId: CORR });
    assert.equal(again.status, "posted");
    assert.equal(again.contentHash, result.contentHash);
  });

  it("hotel_code ajeno → 409 HOTEL_MISMATCH; businessDate distinta → 400 DAY_MISMATCH; replace sin post → 400; nada escrito", async () => {
    const before = await countImports();
    const hotel = await expectCode(revenue.importPmsShadowRevenue({ context, propertyId: RA, body: { content: xmlFor(DAY_D, CODES_A, "OTRO"), post: true, replace: false }, correlationId: CORR }), 409, "PMS_SHADOW_REVENUE_HOTEL_MISMATCH");
    assert.equal(hotel.fileHotelCode, "OTRO");
    assert.equal(hotel.profileHotelCode, HOTEL_CODE);
    const day = await expectCode(revenue.importPmsShadowRevenue({ context, propertyId: RA, body: { content: XML_D, businessDate: "2026-09-18", post: true, replace: false }, correlationId: CORR }), 400, "PMS_SHADOW_REVENUE_DAY_MISMATCH");
    assert.equal(day.fileDate, DAY_D);
    assert.equal(day.businessDate, "2026-09-18");
    await expectCode(revenue.importPmsShadowRevenue({ context, propertyId: RA, body: { content: XML_D, post: false, replace: true }, correlationId: CORR }), 400, "VALIDATION_ERROR");
    await expectCode(revenue.importPmsShadowRevenue({ context, propertyId: RA, body: { content: "<ingresos/>", post: true, replace: false }, correlationId: CORR }), 400, "PMS_SHADOW_FEED_UNKNOWN");
    await expectCode(revenue.importPmsShadowRevenue({ context, propertyId: RA, body: { content: "<ingresos/>", source: "xml_revenue", post: true, replace: false }, correlationId: CORR }), 400, "PMS_SHADOW_FILE_UNREADABLE");
    assert.equal(await countImports(), before);
  });

  it("borrador (post: false) sin asiento; postPmsShadowRevenue lo contabiliza; segundo post → 409", async () => {
    const draft = await revenue.importPmsShadowRevenue({ context, propertyId: RA, body: { content: XML_D, fileName: "d.xml", post: false, replace: false }, correlationId: CORR });
    assert.equal(draft.status, "draft");
    assert.deepEqual(draft.journalEntryIds, []);
    assert.equal(draft.postedAt, null);
    const entriesBefore = await countEntries();
    const posted = await revenue.postPmsShadowRevenue({ context, propertyId: RA, importId: draft.id, correlationId: CORR });
    assert.equal(posted.status, "posted");
    assert.equal(posted.journalEntryIds.length, 1);
    assert.equal(await countEntries(), entriesBefore + 1);
    const view = (await accounting.loadJournalEntry(prisma, posted.journalEntryIds[0]!))!;
    assert.equal(view.sourceId, `${RA}:${DAY_D}`);
    assert.equal(view.lines.length, 6);
    await expectCode(revenue.postPmsShadowRevenue({ context, propertyId: RA, importId: draft.id, correlationId: CORR }), 409, "PMS_SHADOW_REVENUE_ALREADY_POSTED");
  });

  it("código sin mapear → 400 OPERA_TRX_CODE_UNMAPPED con codes y nada escrito; un borrador se contabiliza tras completar el mapeo", async () => {
    const imports = await countImports();
    const entries = await countEntries();
    const details = await expectCode(revenue.importPmsShadowRevenue({ context, propertyId: RA, body: { content: XML_E, post: true, replace: false }, correlationId: CORR }), 400, "OPERA_TRX_CODE_UNMAPPED");
    assert.deepEqual(details.codes, [{ code: "4000", description: "Spa", amount: "80.00" }]);
    assert.equal(await countImports(), imports);
    assert.equal(await countEntries(), entries);
    // Borrador con el código sin mapear → post bloqueado; con mapeo completo en el cuerpo → contabilizado (705.3 · other_operated).
    const draft = await revenue.importPmsShadowRevenue({ context, propertyId: RA, body: { content: XML_E, post: false, replace: false }, correlationId: CORR });
    assert.equal(draft.status, "draft");
    assert.equal(draft.lines.find((line) => line.code === "4000")?.mapped, false);
    await expectCode(revenue.postPmsShadowRevenue({ context, propertyId: RA, importId: draft.id, correlationId: CORR }), 400, "OPERA_TRX_CODE_UNMAPPED");
    const posted = await revenue.postPmsShadowRevenue({ context, propertyId: RA, importId: draft.id, correlationId: CORR, body: { mapping: [...MAPPING, { code: "4000", kind: "revenue", usaliDepartment: "other_operated" }] as never } });
    assert.equal(posted.status, "posted");
    assert.equal(posted.lines.find((line) => line.code === "4000")?.accountCode, "705.3");
    const view = (await accounting.loadJournalEntry(prisma, posted.journalEntryIds[0]!))!;
    assert.equal(view.lines.filter((l) => l.accountCode === "705.3").length, 2, "Minibar + Spa");
    assert.equal(view.totalDebit, "1809.20");
  });

  it("periodo cerrado → 409 FISCAL_PERIOD_CLOSED y NINGÚN lote nuevo (rollback); reverso en mes cerrado → 409", async () => {
    const period = await fiscalPeriods.openFiscalPeriod({ context, periodCode: "2026-08", periodType: "month", startDate: "2026-08-01", endDate: "2026-08-31", correlationId: CORR });
    await fiscalPeriods.closeFiscalPeriod({ context, periodId: period.id, correlationId: CORR });
    const imports = await countImports();
    const entries = await countEntries();
    const preview = await revenue.previewPmsShadowRevenue({ context, propertyId: RA, body: { content: XML_F } });
    assert.equal(preview.canPost, false);
    assert.ok(preview.blockers.some((b) => b.code === "FISCAL_PERIOD_CLOSED"));
    const details = await expectCode(revenue.importPmsShadowRevenue({ context, propertyId: RA, body: { content: XML_F, fileName: "f.xml", post: true, replace: false }, correlationId: CORR }), 409, "FISCAL_PERIOD_CLOSED");
    assert.equal(details.periodCode, "2026-08");
    assert.equal(await countImports(), imports, "la transacción hizo rollback: el lote no queda");
    assert.equal(await countEntries(), entries);
    assert.equal(await prisma.pmsShadowRevenueImport.count({ where: { organizationId: ORG, businessDate: new Date(`${DAY_F}T00:00:00.000Z`) } }), 0);
    // Un lote de septiembre contabilizado y el mes cerrado a posteriori no se puede revertir (contable-6C-02).
    const september = await fiscalPeriods.openFiscalPeriod({ context, periodCode: "2026-09", periodType: "month", startDate: "2026-09-01", endDate: "2026-09-30", correlationId: CORR });
    await fiscalPeriods.closeFiscalPeriod({ context, periodId: september.id, correlationId: CORR });
    await expectCode(revenue.reversePmsShadowRevenue({ context, propertyId: RA, importId: importB, reason: "mes cerrado", entryDate: "2026-10-01", correlationId: CORR }), 409, "FISCAL_PERIOD_CLOSED");
    await fiscalPeriods.reopenFiscalPeriod({ context: { ...context, permissions: [...(context.permissions as string[]), "ai.high_risk.confirm"] } as UserContext, periodId: september.id, reason: "prueba", correlationId: CORR });
    assert.equal((await revenue.getPmsShadowRevenueImport({ context, propertyId: RA, importId: importB })).status, "posted");
  });

  it("listado, detalle, 404 opaco desde otra propiedad, reconciliationForDay", async () => {
    const all = await revenue.listPmsShadowRevenueImports({ context: reader, propertyId: RA });
    assert.ok(all.length >= 6);
    assert.ok(all.every((row) => row.propertyId === RA && row.organizationId === ORG));
    assert.ok(all.every((row) => !JSON.stringify(row.lines).includes("RESERVATION_ID")));
    const posted = await revenue.listPmsShadowRevenueImports({ context: reader, propertyId: RA, status: "posted", from: DAY, to: DAY });
    assert.deepEqual(posted.map((row) => row.id), [importB]);
    const reversed = await revenue.listPmsShadowRevenueImports({ context: reader, propertyId: RA, status: "reversed", limit: 1 });
    assert.equal(reversed.length, 1);
    await expectCode(revenue.listPmsShadowRevenueImports({ context: reader, propertyId: RA, status: "otro" as never }), 400, "VALIDATION_ERROR");
    await expectCode(revenue.getPmsShadowRevenueImport({ context: reader, propertyId: LT, importId: importB }), 404, "PMS_SHADOW_REVENUE_NOT_FOUND");
    await expectCode(revenue.getPmsShadowRevenueImport({ context: reader, propertyId: RA, importId: "no_existe" }), 404, "PMS_SHADOW_REVENUE_NOT_FOUND");
    await expectCode(revenue.reversePmsShadowRevenue({ context, propertyId: LT, importId: importB, reason: "ajeno", correlationId: CORR }), 404, "PMS_SHADOW_REVENUE_NOT_FOUND");
    // Sin perfil en LT: importar exige mapeo en el cuerpo y no comprueba el hotel.
    const lt = await revenue.previewPmsShadowRevenue({ context: { ...context, propertyId: LT } as UserContext, propertyId: LT, body: { content: XML_A, mapping: MAPPING as never } });
    assert.equal(lt.canPost, true);
    assert.ok(lt.warnings.some((w) => w.includes("perfil de modo sombra")));

    const day = await revenue.reconciliationForDay(RA, DAY, { organizationId: ORG });
    assert.equal(day.importId, importB);
    assert.equal(day.status, "posted");
    assert.equal(day.revenue705, "1635.00");
    assert.equal(day.tax477, "159.70");
    assert.deepEqual(day.totals, { revenue: "1635.00", tax: "159.70", payments: "900.00", other: "40.00" });
    const none = await revenue.reconciliationForDay(RA, "2026-01-01", { organizationId: ORG });
    assert.equal(none.importId, null);
    assert.equal(none.revenue705, "0.00");
    const first = await revenue.loadPmsShadowRevenueImport(ORG, RA, importA);
    assert.equal(first?.status, "reversed");
    assert.equal(await revenue.loadPmsShadowRevenueImport(ORG, LT, importA), null);
    assert.equal(revenue.revenueContentHash(XML_A), hashA);
  });
});
