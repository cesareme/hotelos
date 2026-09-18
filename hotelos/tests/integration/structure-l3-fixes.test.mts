/**
 * Estructura societaria · L3 · fix lot (t6b#1, t6b#2, t6b#11) · integration
 * (Postgres required; in-process, no HTTP). Sibling of structure-l3.test.mts so
 * the original suite is not edited concurrently; same isolation rules: every
 * write lands in organizations created here and removed in `after`; Faranda is
 * only counted before / after (org_123 is a legitimate write target of sibling suites).
 *
 *   t6b#1  · two UNCODED hotels of one NIF issue at the same instant: neither gets
 *            FAC-<año>-000001 — both answer 409 WORK_CENTER_CODE_REQUIRED, nothing is
 *            numbered, and once the centres are coded they issue FAC-N1-/FAC-N2-;
 *          · two centres that already share a legacy prefix (org_123 case) issue the
 *            SAME next number at once: exactly one succeeds, the other answers 409
 *            INVOICE_NUMBER_DUPLICATE (the number lock serialises the safety net);
 *          · a closed series never numbers again → 409 SERIES_CLOSED.
 *   t6b#2  · sociedad with siiEnabled: the document is expedited without huella, QR,
 *            RegistroAnterior or installation, carries the typed warning and the frozen
 *            exclusion, queues no submission, prints the reason on the PDF, can be
 *            cancelled (no anulación) and rectified (no record); a record hashed BEFORE
 *            the flag flipped is retired with errorCode VERIFACTU_EXCLUDED_BY_SII and its
 *            manual retry answers 409 with that code.
 *   t6b#11 · after a change of NIF the series answers 409 ISSUER_TAX_ID_SERIES_MISMATCH
 *            pointing to Estructura societaria (never to «Perfil del establecimiento»);
 *            findSeriesBlockedByTaxIdChange lists exactly that series; a series opened
 *            with ANOTHER prefix is not blocked by the old series' invoices.
 *
 * VERIFACTU_MODE is forced to sandbox (stub, no network). Run from the repo root:
 *   cd apps/api && node --import tsx --test "../../tests/integration/structure-l3-fixes.test.mts"
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
process.env.VERIFACTU_MODE = "sandbox";
process.env.VERIFACTU_MULTI_OT = "S";

const { prisma } = await import("@hotelos/database");
const { isValidSpanishTaxId } = await import("@hotelos/compliance");
const invoicing = await import("../../apps/api/src/modules/invoicing/invoice.service.js");
const drafts = await import("../../apps/api/src/modules/invoicing/invoicing.service.js");
const issuerIdentity = await import("../../apps/api/src/modules/invoicing/issuer-identity.service.js");
const verifactu = await import("../../apps/api/src/modules/invoicing/verifactu-submission.service.js");
const pdf = await import("../../apps/api/src/modules/invoicing/invoice-pdf.service.js");
const { ConflictError, HttpError } = await import("../../apps/api/src/lib/http-error.js");
const { flushAuditQueues } = await import("../../apps/api/src/modules/audit/audit.service.js");
type UserContext = import("../../apps/api/src/lib/demo-store.js").UserContext;

const RUN = Date.now().toString(36);
const FARANDA_ORG = "cmrhw9jy30002fyvb6tsdiugt";
const DEMO_ORG = "org_123";

/** Checksum-valid CIF (letter B → numeric control) derived from the run so parallel runs never share a NIF. */
function cifFor(letter: string, seed: number): string {
  const digits = String(Math.abs(seed) % 10_000_000).padStart(7, "0");
  let even = 0;
  let odd = 0;
  for (let i = 0; i < 7; i += 1) {
    const d = Number(digits[i]);
    if (i % 2 === 1) even += d;
    else {
      const doubled = d * 2;
      odd += doubled >= 10 ? doubled - 9 : doubled;
    }
  }
  const control = (10 - ((even + odd) % 10)) % 10;
  return `${letter}${digits}${control}`;
}

// Sociedad A: two coded hotels with installations (SII cases, NIF change).
const ORG = `org_l3f_${RUN}`;
const LE = `le_l3f_${RUN}`;
const RA = `prop_l3f_ra_${RUN}`;
const LT = `prop_l3f_lt_${RUN}`;
const INST_RA = `vfi_l3f_ra_${RUN}`;
const INST_LT = `vfi_l3f_lt_${RUN}`;
const TAX_ID = cifFor("B", Date.now());
const TAX_ID_2 = cifFor("B", Date.now() + 977);
const LEGAL_NAME = "L3 Fixes Hoteles SA";
// Sociedad N: two UNCODED hotels (onboarding go-live shape).
const NULL_ORG = `org_l3fn_${RUN}`;
const NULL_LE = `le_l3fn_${RUN}`;
const N1 = `prop_l3f_n1_${RUN}`;
const N2 = `prop_l3f_n2_${RUN}`;
const NULL_TAX_ID = cifFor("B", Date.now() + 4_242);
// Sociedad S: two coded hotels that already SHARE the legacy prefix FAC-<año>- (org_123 shape).
const SHARED_ORG = `org_l3fs_${RUN}`;
const SHARED_LE = `le_l3fs_${RUN}`;
const S1 = `prop_l3f_s1_${RUN}`;
const S2 = `prop_l3f_s2_${RUN}`;
const SHARED_TAX_ID = cifFor("B", Date.now() + 8_080);

const context = (propertyId: string, organizationId: string, permissions: string[] = ["invoice.issue", "invoice.cancel"]): UserContext =>
  ({ organizationId, propertyId, userId: `usr_l3f_${RUN}`, fullName: "L3 Fixes", deviceId: `dev_l3f_${RUN}`, permissions: permissions as never }) as UserContext;
/** Tanda 8a (§4.7): the anulación is a record ANOTHER person makes (issuer ≠ canceller) with the invoice_cancel authorisation; these VeriFactu tests use a privileged canceller (platform admin, audited), never the issuer. */
const canceller = (propertyId: string, organizationId: string): UserContext =>
  ({ ...context(propertyId, organizationId, ["invoice.cancel"]), userId: `usr_l3f_cancel_${RUN}`, fullName: "L3 Canceller", isPlatformAdmin: true }) as UserContext;

const year = invoicing.fiscalYearInMadrid(new Date());
const baseline = { invoices: 0, installations: 0, sequences: 0, submissions: 0 };

/**
 * Read-only guard over the PILOT only. org_123 is a legitimate write target of the
 * sister suites (billing-money, pos-cash-night, structure-l3…), which create and
 * remove invoices there while this file runs in parallel under `node --test`; a
 * union snapshot would therefore be order-dependent (observed: +2 invoices / +2
 * submissions mid-run, back to the baseline at the end). Faranda must never be
 * written by any suite, so its counts are the invariant.
 */
async function protectedCounts() {
  const propertyIds = (await prisma.property.findMany({ where: { organizationId: FARANDA_ORG }, select: { id: true } })).map((p) => p.id);
  return {
    invoices: await prisma.invoice.count({ where: { propertyId: { in: propertyIds } } }),
    installations: await prisma.verifactuInstallation.count({ where: { legalEntity: { organizationId: FARANDA_ORG } } }),
    sequences: await prisma.invoiceSequence.count({ where: { propertyId: { in: propertyIds } } }),
    submissions: await prisma.verifactuSubmission.count({ where: { propertyId: { in: propertyIds } } })
  };
}

async function cleanupOrganization(organizationId: string, propertyIds: string[]): Promise<void> {
  const invoices = await prisma.invoice.findMany({ where: { propertyId: { in: propertyIds } }, select: { id: true } });
  const invoiceIds = invoices.map((row) => row.id);
  if (invoiceIds.length > 0) {
    await prisma.verifactuSubmission.deleteMany({ where: { invoiceId: { in: invoiceIds } } });
    await prisma.invoiceLine.deleteMany({ where: { invoiceId: { in: invoiceIds } } });
    await prisma.invoice.updateMany({ where: { id: { in: invoiceIds } }, data: { rectifyingForId: null } });
    await prisma.invoice.deleteMany({ where: { id: { in: invoiceIds } } });
  }
  await prisma.invoiceSequence.deleteMany({ where: { propertyId: { in: propertyIds } } });
  await prisma.vatBookEntry.deleteMany({ where: { organizationId } });
  const entries = await prisma.journalEntry.findMany({ where: { organizationId }, select: { id: true } });
  if (entries.length > 0) await prisma.journalLine.deleteMany({ where: { journalEntryId: { in: entries.map((e) => e.id) } } });
  await prisma.journalEntry.deleteMany({ where: { organizationId } });
  await prisma.fiscalPeriod.deleteMany({ where: { organizationId } });
  await prisma.fiscalYear.deleteMany({ where: { organizationId } });
  await prisma.vatSettings.deleteMany({ where: { organizationId } });
  await prisma.accountingSetting.deleteMany({ where: { organizationId } });
  await prisma.account.deleteMany({ where: { organizationId } });
  const entities = await prisma.legalEntity.findMany({ where: { organizationId }, select: { id: true } });
  if (entities.length > 0) await prisma.verifactuInstallation.deleteMany({ where: { legalEntityId: { in: entities.map((e) => e.id) } } });
  await prisma.property.deleteMany({ where: { organizationId } });
  await prisma.legalEntity.deleteMany({ where: { organizationId } });
  await prisma.organization.deleteMany({ where: { id: organizationId } });
}

before(async () => {
  for (const id of [TAX_ID, TAX_ID_2, NULL_TAX_ID, SHARED_TAX_ID]) assert.equal(isValidSpanishTaxId(id), true, `generated CIF ${id} must be checksum-valid`);
  Object.assign(baseline, await protectedCounts());

  await prisma.organization.create({ data: { id: ORG, name: "L3 Fixes Hoteles", country: "ES" } });
  await prisma.legalEntity.create({ data: { id: LE, organizationId: ORG, code: "L3F", legalName: LEGAL_NAME, taxId: TAX_ID, legalForm: "sa", fiscalAddress: "Calle Sociedad 1", fiscalPostalCode: "15001", fiscalMunicipality: "A Coruna", fiscalProvince: "A Coruna", verifactuChainScope: "per_center", isDefault: true } });
  await prisma.property.create({ data: { id: RA, organizationId: ORG, legalEntityId: LE, code: "RA", kind: "hotel", name: "Hotel L3F Rias Altas", address: "Paseo 1", municipality: "Perillo", province: "A Coruna", country: "ES", taxRegion: "ES_PENINSULA_BALEARES", fiscalTerritory: "common", createdAt: new Date("2026-01-01T00:00:00Z") } });
  await prisma.property.create({ data: { id: LT, organizationId: ORG, legalEntityId: LE, code: "LT", kind: "hotel", name: "Hotel L3F Los Tilos", municipality: "Teo", province: "A Coruna", country: "ES", taxRegion: "ES_PENINSULA_BALEARES", fiscalTerritory: "common", createdAt: new Date("2026-02-01T00:00:00Z") } });
  await prisma.verifactuInstallation.create({ data: { id: INST_RA, legalEntityId: LE, propertyId: RA, numeroInstalacion: `L3F-RA-${RUN.toUpperCase()}`, route: "verifactu", active: true } });
  await prisma.verifactuInstallation.create({ data: { id: INST_LT, legalEntityId: LE, propertyId: LT, numeroInstalacion: `L3F-LT-${RUN.toUpperCase()}`, route: "verifactu", active: true } });

  await prisma.organization.create({ data: { id: NULL_ORG, name: "L3F Null Codes", country: "ES" } });
  await prisma.legalEntity.create({ data: { id: NULL_LE, organizationId: NULL_ORG, code: "NUL", legalName: "L3F Null Codes SL", taxId: NULL_TAX_ID, legalForm: "sl", isDefault: true } });
  await prisma.property.create({ data: { id: N1, organizationId: NULL_ORG, legalEntityId: NULL_LE, code: null, kind: "hotel", name: "Hotel Null Uno", country: "ES", taxRegion: "ES_PENINSULA_BALEARES" } });
  await prisma.property.create({ data: { id: N2, organizationId: NULL_ORG, legalEntityId: NULL_LE, code: null, kind: "hotel", name: "Hotel Null Dos", country: "ES", taxRegion: "ES_PENINSULA_BALEARES" } });

  await prisma.organization.create({ data: { id: SHARED_ORG, name: "L3F Shared Prefix", country: "ES" } });
  await prisma.legalEntity.create({ data: { id: SHARED_LE, organizationId: SHARED_ORG, code: "SHP", legalName: "L3F Shared Prefix SL", taxId: SHARED_TAX_ID, legalForm: "sl", isDefault: true } });
  await prisma.property.create({ data: { id: S1, organizationId: SHARED_ORG, legalEntityId: SHARED_LE, code: "S1", kind: "hotel", name: "Hotel Shared Uno", country: "ES", taxRegion: "ES_PENINSULA_BALEARES" } });
  await prisma.property.create({ data: { id: S2, organizationId: SHARED_ORG, legalEntityId: SHARED_LE, code: "S2", kind: "hotel", name: "Hotel Shared Dos", country: "ES", taxRegion: "ES_PENINSULA_BALEARES" } });
  // The org_123 shape: both centres already opened FAC-<año>- (legacy, before R3) and sit on the same next number.
  for (const propertyId of [S1, S2]) {
    await prisma.invoiceSequence.create({ data: { propertyId, legalEntityId: SHARED_LE, sequenceCode: "FAC", prefix: `FAC-${year}-`, year, nextNumber: 7, padding: 6, invoiceType: "F1", active: true } });
  }
});

after(async () => {
  try {
    await verifactu.flushVerifactuQueue();
    await flushAuditQueues();
    await cleanupOrganization(ORG, [RA, LT]);
    await cleanupOrganization(NULL_ORG, [N1, N2]);
    await cleanupOrganization(SHARED_ORG, [S1, S2]);
  } finally {
    await prisma.$disconnect();
  }
});

type Issued = Awaited<ReturnType<typeof invoicing.issueInvoice>>;

async function issueDraft(propertyId: string, organizationId: string, total: number, taxTotal: number, customerName: string): Promise<Issued> {
  const draft = await drafts.createInvoiceDraft({ propertyId, invoiceType: "F1", customerType: "company", customerName, total, taxTotal, context: context(propertyId, organizationId), correlationId: `l3f-draft-${RUN}` });
  return invoicing.issueInvoice({ context: context(propertyId, organizationId), invoiceId: draft.id, correlationId: `l3f-issue-${RUN}` });
}

function codeOf(error: unknown): string | undefined {
  return (error as { details?: { code?: string } }).details?.code;
}

async function duplicatesUnder(legalEntityId: string): Promise<Array<[string, number]>> {
  const rows = await prisma.$queryRaw<Array<{ invoice_number: string; n: bigint }>>`SELECT invoice_number, count(*)::bigint AS n FROM invoices WHERE legal_entity_id = ${legalEntityId} AND deleted_at IS NULL AND status <> 'draft' GROUP BY 1 HAVING count(*) > 1`;
  return rows.map((row) => [row.invoice_number, Number(row.n)]);
}

describe("t6b#1 · numbering under one NIF is race-proof", () => {
  it("two UNCODED hotels issuing at once: 409 WORK_CENTER_CODE_REQUIRED for both, no number consumed, no duplicate; coded → FAC-N1-/FAC-N2-", async () => {
    const results = await Promise.allSettled([issueDraft(N1, NULL_ORG, 110, 10, "N1 SL"), issueDraft(N2, NULL_ORG, 110, 10, "N2 SL")]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    assert.equal(fulfilled.length, 0, "an uncoded centre of a multi-centre sociedad never opens FAC-<año>-");
    assert.equal(rejected.length, 2);
    for (const r of rejected) {
      assert.ok(r.reason instanceof ConflictError, String(r.reason));
      assert.equal(codeOf(r.reason), "WORK_CENTER_CODE_REQUIRED");
      assert.equal((r.reason as ConflictError).details && (r.reason.details as { billingCentres: number }).billingCentres, 2);
      assert.match((r.reason as Error).message, /Estructura societaria › Centros/);
    }
    assert.equal(await prisma.invoiceSequence.count({ where: { propertyId: { in: [N1, N2] } } }), 0, "no series row was opened");
    assert.equal(await prisma.invoice.count({ where: { propertyId: { in: [N1, N2] }, status: "issued" } }), 0);
    assert.deepEqual(await duplicatesUnder(NULL_LE), []);

    // The operator codes the centres (L2 PATCH /properties/:id/establishment); both then issue with the centre prefix.
    await prisma.property.update({ where: { id: N1 }, data: { code: "N1" } });
    await prisma.property.update({ where: { id: N2 }, data: { code: "N2" } });
    const [n1, n2] = await Promise.all([issueDraft(N1, NULL_ORG, 110, 10, "N1 SL"), issueDraft(N2, NULL_ORG, 110, 10, "N2 SL")]);
    assert.equal(n1.invoiceNumber, `FAC-N1-${year}-000001`);
    assert.equal(n2.invoiceNumber, `FAC-N2-${year}-000001`);
    assert.deepEqual(await duplicatesUnder(NULL_LE), []);
  });

  it("two centres SHARING a legacy prefix issue the same next number at once: exactly one succeeds, the other 409 INVOICE_NUMBER_DUPLICATE; nothing duplicated under the NIF", async () => {
    const results = await Promise.allSettled([issueDraft(S1, SHARED_ORG, 110, 10, "S1 SL"), issueDraft(S2, SHARED_ORG, 110, 10, "S2 SL")]);
    const ok = results.filter((r): r is PromiseFulfilledResult<Issued> => r.status === "fulfilled").map((r) => r.value);
    const failed = results.filter((r): r is PromiseRejectedResult => r.status === "rejected").map((r) => r.reason as ConflictError);
    assert.equal(ok.length, 1, `exactly one FAC-${year}-000007 — got ${ok.map((i) => i.invoiceNumber).join(",")}`);
    assert.equal(failed.length, 1);
    assert.equal(ok[0]!.invoiceNumber, `FAC-${year}-000007`);
    assert.equal(codeOf(failed[0]), "INVOICE_NUMBER_DUPLICATE");
    assert.equal((failed[0]!.details as { invoiceNumber: string }).invoiceNumber, `FAC-${year}-000007`);
    // The winner carries the pre-existing collision as a warning (never a 409, never renumbered).
    assert.ok(ok[0]!.warnings.some((w) => w.includes("también está activa en otro centro de la misma sociedad")), ok[0]!.warnings.join(" | "));
    assert.deepEqual(await duplicatesUnder(SHARED_LE), []);
    // The loser did not consume its number: its row is still at 7.
    const loserProperty = ok[0]!.propertyId === S1 ? S2 : S1;
    assert.equal((await prisma.invoiceSequence.findFirstOrThrow({ where: { propertyId: loserProperty, sequenceCode: "FAC", year } })).nextNumber, 7);
    // Sequential retry of the loser gets the NEXT free number only after the operator closes one series — here it simply collides again (deterministic).
    await assert.rejects(issueDraft(loserProperty, SHARED_ORG, 55, 5, "again"), (error: unknown) => codeOf(error) === "INVOICE_NUMBER_DUPLICATE");
  });

  it("a closed series never numbers again → 409 SERIES_CLOSED; reopened, it continues where it stopped", async () => {
    const first = await issueDraft(LT, ORG, 110, 10, "LT SL");
    assert.equal(first.invoiceNumber, `FAC-LT-${year}-000001`);
    const row = await prisma.invoiceSequence.findFirstOrThrow({ where: { propertyId: LT, sequenceCode: "FAC", year } });
    await prisma.invoiceSequence.update({ where: { id: row.id }, data: { active: false } });
    await assert.rejects(issueDraft(LT, ORG, 55, 5, "closed"), (error: unknown) => {
      assert.equal(codeOf(error), "SERIES_CLOSED");
      assert.equal((error as ConflictError).details && ((error as ConflictError).details as { prefix: string }).prefix, `FAC-LT-${year}-`);
      return true;
    });
    assert.equal((await prisma.invoiceSequence.findUniqueOrThrow({ where: { id: row.id } })).nextNumber, row.nextNumber, "a closed series is never advanced");
    await prisma.invoiceSequence.update({ where: { id: row.id }, data: { active: true } });
    const second = await issueDraft(LT, ORG, 55, 5, "reopened");
    assert.equal(second.invoiceNumber, `FAC-LT-${year}-000002`);
  });
});

describe("t6b#2 · sociedad in the SII: no VeriFactu record, nothing queued, cancel and rectify still work", () => {
  let hashedBefore: Issued;
  let siiInvoice: Issued;

  it("a record hashed BEFORE the flag flipped exists and was accepted by the stub", async () => {
    hashedBefore = await issueDraft(RA, ORG, 121, 21, "Antes del SII SL");
    assert.ok(hashedBefore.verifactuHash);
    await verifactu.flushVerifactuQueue();
    const alta = await prisma.verifactuSubmission.findUniqueOrThrow({ where: { invoiceId_registroType: { invoiceId: hashedBefore.id, registroType: "alta" } } });
    assert.equal(alta.status, "accepted");
    await prisma.legalEntity.update({ where: { id: LE }, data: { siiEnabled: true } });
  });

  it("issue: no huella, no QR, no RegistroAnterior, no installation; typed warning; frozen exclusion; no submission row", async () => {
    siiInvoice = await issueDraft(RA, ORG, 220, 20, "Cliente SII SL");
    assert.equal(siiInvoice.invoiceNumber, `FAC-RA-${year}-000002`, "numbering continues in the series");
    assert.equal(siiInvoice.verifactuHash, undefined);
    assert.equal(siiInvoice.previousInvoiceHash, undefined);
    assert.equal(siiInvoice.qrPayload, undefined);
    assert.equal(siiInvoice.issuerTaxId, TAX_ID, "the issuer identity is untouched");
    assert.ok(siiInvoice.warnings.some((w) => w.startsWith("VERIFACTU_EXCLUDED_BY_SII: ")), siiInvoice.warnings.join(" | "));
    const row = await prisma.invoice.findUniqueOrThrow({ where: { id: siiInvoice.id }, select: { verifactuHash: true, previousInvoiceHash: true, qrPayload: true, installationId: true, legalEntityId: true, snapshotJson: true } });
    assert.deepEqual({ verifactuHash: row.verifactuHash, previousInvoiceHash: row.previousInvoiceHash, qrPayload: row.qrPayload, installationId: row.installationId, legalEntityId: row.legalEntityId }, { verifactuHash: null, previousInvoiceHash: null, qrPayload: null, installationId: null, legalEntityId: LE });
    const frozen = invoicing.structureFromSnapshotJson(row.snapshotJson);
    assert.equal(frozen.verifactuExclusion?.code, "VERIFACTU_EXCLUDED_BY_SII");
    assert.equal(frozen.installationId, null);
    await verifactu.flushVerifactuQueue();
    assert.equal(await prisma.verifactuSubmission.count({ where: { invoiceId: siiInvoice.id } }), 0, "nothing queued or sent");
    // Libro de emitidas and journal are unaffected by the exclusion.
    assert.ok((await prisma.vatBookEntry.count({ where: { organizationId: ORG, sourceId: siiInvoice.id } })) > 0);
  });

  it("PDF: prints the SII reason instead of the QR block; no VERI*FACTU legend", async () => {
    const { buffer, model } = await pdf.renderInvoicePdf(siiInvoice.id);
    assert.equal(model.verifactuExclusion?.code, "VERIFACTU_EXCLUDED_BY_SII");
    assert.equal(model.qrUrl, null);
    const out = buffer.toString("latin1");
    assert.ok(out.includes("Sin QR tributario: Sociedad acogida al SII"));
    assert.ok(!out.includes("VERI*FACTU"));
  });

  it("the chain of the sociedad did not advance: the next record after the flag is NOT chained onto the pre-SII huella", async () => {
    const record = await prisma.invoice.findFirst({ where: { propertyId: RA, previousInvoiceHash: hashedBefore.verifactuHash! } });
    assert.equal(record, null);
  });

  it("rectify: the rectificativa of a SII document carries no record either", async () => {
    const rect = await invoicing.createRectifyingInvoice({ context: context(RA, ORG), originalInvoiceId: siiInvoice.id, reasonCode: "R4", fullReversal: true, correlationId: `l3f-rect-${RUN}` });
    assert.equal(rect.invoiceNumber, `REC-RA-${year}-000001`);
    assert.equal(rect.verifactuHash, undefined);
    assert.equal(rect.qrPayload, undefined);
    assert.ok(rect.warnings.some((w) => w.startsWith("VERIFACTU_EXCLUDED_BY_SII: ")));
    await verifactu.flushVerifactuQueue();
    assert.equal(await prisma.verifactuSubmission.count({ where: { invoiceId: rect.id } }), 0);
  });

  it("cancel: a SII document is cancelled without RegistroAnulacion (no 409 for the missing huella)", async () => {
    const other = await issueDraft(LT, ORG, 33, 3, "SII cancel SL");
    assert.equal(other.verifactuHash, undefined);
    const cancelled = await invoicing.cancelInvoice({ context: canceller(LT, ORG), invoiceId: other.id, reason: "prueba SII", correlationId: `l3f-cancel-${RUN}` });
    assert.equal(cancelled.status, "cancelled");
    assert.equal(cancelled.cancellationHash, null);
    await verifactu.flushVerifactuQueue();
    assert.equal(await prisma.verifactuSubmission.count({ where: { invoiceId: other.id } }), 0);
  });

  it("a record hashed before the flag: its anulación is retired with errorCode VERIFACTU_EXCLUDED_BY_SII and the manual retry answers 409 with that code", async () => {
    const cancelled = await invoicing.cancelInvoice({ context: canceller(RA, ORG), invoiceId: hashedBefore.id, reason: "anulación tras SII", correlationId: `l3f-cancel2-${RUN}` });
    assert.ok(cancelled.cancellationHash, "the internal chain still computes the anulación huella");
    await verifactu.flushVerifactuQueue();
    const anulacion = await prisma.verifactuSubmission.findUniqueOrThrow({ where: { invoiceId_registroType: { invoiceId: hashedBefore.id, registroType: "anulacion" } } });
    assert.equal(anulacion.status, "abandoned");
    assert.equal(anulacion.errorCode, "VERIFACTU_EXCLUDED_BY_SII");
    assert.equal(anulacion.attempts, 0, "never counted as an attempt");
    assert.match(anulacion.errorMessage ?? "", /RD 1007\/2023 art\. 3\.3/);
    await assert.rejects(verifactu.retryVerifactuSubmission(anulacion.id), (error: unknown) => {
      assert.ok(error instanceof HttpError && error.statusCode === 409, String(error));
      assert.equal(codeOf(error), "VERIFACTU_EXCLUDED_BY_SII");
      return true;
    });
    // The accepted alta of that record is left as it was sent.
    assert.equal((await prisma.verifactuSubmission.findUniqueOrThrow({ where: { invoiceId_registroType: { invoiceId: hashedBefore.id, registroType: "alta" } } })).status, "accepted");
    await prisma.legalEntity.update({ where: { id: LE }, data: { siiEnabled: false } });
  });
});

describe("t6b#11 · change of NIF: the series is blocked with the real remedies and the PATCH can warn beforehand", () => {
  it("findSeriesBlockedByTaxIdChange lists the RA series with invoices under the old NIF, not the LT series", async () => {
    const blocked = await invoicing.findSeriesBlockedByTaxIdChange({ organizationId: ORG, legalEntityId: LE, nextTaxId: TAX_ID_2 });
    const prefixes = blocked.map((row) => `${row.propertyId}:${row.prefix}`).sort();
    assert.ok(prefixes.includes(`${RA}:FAC-RA-${year}-`), prefixes.join(","));
    assert.ok(prefixes.includes(`${RA}:REC-RA-${year}-`), prefixes.join(","));
    assert.ok(prefixes.includes(`${LT}:FAC-LT-${year}-`), "LT also issued under the old NIF");
    for (const row of blocked) assert.equal(row.seriesTaxId, TAX_ID);
    assert.deepEqual(await invoicing.findSeriesBlockedByTaxIdChange({ organizationId: ORG, legalEntityId: LE, nextTaxId: TAX_ID }), [], "same NIF → nothing blocked");
  });

  it("after the change the series answers 409 ISSUER_TAX_ID_SERIES_MISMATCH naming the prefix and both screens; issued invoices keep their snapshot", async () => {
    await prisma.legalEntity.update({ where: { id: LE }, data: { taxId: TAX_ID_2 } });
    try {
      await assert.rejects(issueDraft(RA, ORG, 11, 1, "Post NIF SL"), (error: unknown) => {
        assert.ok(error instanceof ConflictError, String(error));
        assert.equal(codeOf(error), "ISSUER_TAX_ID_SERIES_MISMATCH");
        const details = error.details as { prefix: string; seriesTaxId: string; currentTaxId: string; legalIdentityScreen: string; seriesScreen: string };
        assert.equal(details.prefix, `FAC-RA-${year}-`);
        assert.equal(details.seriesTaxId, TAX_ID);
        assert.equal(details.currentTaxId, TAX_ID_2);
        assert.equal(details.legalIdentityScreen, issuerIdentity.LEGAL_IDENTITY_SCREEN);
        assert.equal(details.seriesScreen, issuerIdentity.SERIES_SCREEN);
        assert.match(error.message, /Estructura societaria › Datos fiscales/);
        assert.match(error.message, /Estructura societaria › Series y VeriFactu/);
        assert.ok(!error.message.includes("Perfil del establecimiento"));
        return true;
      });
      const frozen = await prisma.invoice.findFirst({ where: { propertyId: RA, status: { not: "draft" } }, orderBy: { issuedAt: "asc" }, select: { issuerTaxId: true } });
      assert.equal(frozen?.issuerTaxId, TAX_ID);
    } finally {
      await prisma.legalEntity.update({ where: { id: LE }, data: { taxId: TAX_ID } });
    }
  });

  it("a series with ANOTHER prefix is not blocked by the old series' invoices (issuer check keyed by the printed prefix)", async () => {
    // Legacy shape (Faranda RA): FAC-<año>-… issued under a different NIF in the same centre and year, series since closed.
    const legacy = await prisma.invoice.create({
      data: { id: `inv_l3f_legacy_${RUN}`, propertyId: RA, legalEntityId: LE, invoiceNumber: `FAC-${year}-000009`, invoiceType: "F1", customerType: "company", status: "issued", issuedAt: new Date(), issuerTaxId: TAX_ID_2, issuerLegalName: "Antigua SL", seriesCode: "FAC", total: 1, taxTotal: 0 }
    });
    try {
      assert.deepEqual(await invoicing.findSeriesIssuerTaxId(prisma, RA, `FAC-${year}-`), { taxId: TAX_ID_2, invoiceNumber: `FAC-${year}-000009` });
      const fresh = await issueDraft(RA, ORG, 44, 4, "Nueva serie SL");
      assert.ok(fresh.invoiceNumber!.startsWith(`FAC-RA-${year}-`), fresh.invoiceNumber);
      assert.equal(fresh.issuerTaxId, TAX_ID);
    } finally {
      await prisma.invoice.delete({ where: { id: legacy.id } });
    }
  });
});

describe("guard", () => {
  it("Faranda was only read: same invoices, installations, series and submissions as before the suite (org_123 is a sibling-suite write target and is not part of the guard)", async () => {
    await verifactu.flushVerifactuQueue();
    assert.deepEqual(await protectedCounts(), baseline);
  });
});
