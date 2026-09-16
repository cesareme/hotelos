/**
 * Estructura societaria · L3 · integration (Postgres required; in-process, no HTTP).
 *
 * Closing criteria of design §6 row L3 (and the C2 / C3 / C8 pieces that belong
 * to invoicing), over an ISOLATED sociedad created here and removed in `after`:
 *   · two hotels of the same NIF (RA, LT) issue without collision: prefixes
 *     `FAC-RA-<año>-` / `FAC-LT-<año>-` (R3 conditional prefix), one issuer
 *     snapshot = the sociedad, establishment block frozen in the document;
 *   · 409 SERIES_PREFIX_CLASH { conflictingPropertyId } when a centre would open
 *     a series whose prefix a sister centre already uses; 409
 *     INVOICE_NUMBER_DUPLICATE when the allocated number exists under the NIF;
 *   · a hotel individual keeps `FAC-<año>-`; the new year opens a new row and
 *     never renumbers the old one;
 *   · two VeriFactu chains (RegistroAnterior per installation), each registro
 *     with the installation's NumeroInstalacion, ObligadoEmision/NombreRazon =
 *     razón social, IDEmisorFactura = NIF de la sociedad, IndicadorMultiplesOT = S;
 *     verifactu_submissions.installation_id linked;
 *   · the PDF shows sociedad + «Establecimiento»; the issuer snapshot of an
 *     issued invoice is immutable (trigger).
 *
 * VERIFACTU_MODE is forced to sandbox (stub, no network). Faranda and org_123 are
 * never read for writing: a read-only count of Faranda's invoices and installations
 * is taken before and compared after. Run from the repo root:
 *   cd apps/api && node --import tsx --test "../../tests/integration/structure-l3.test.mts"
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
// Never a real mode from a test: the stub acknowledges, nothing reaches AEAT.
process.env.VERIFACTU_MODE = "sandbox";
process.env.VERIFACTU_MULTI_OT = "S";

const { prisma } = await import("@hotelos/database");
const { isValidSpanishTaxId } = await import("@hotelos/compliance");
const invoicing = await import("../../apps/api/src/modules/invoicing/invoice.service.js");
const drafts = await import("../../apps/api/src/modules/invoicing/invoicing.service.js");
const issuer = await import("../../apps/api/src/modules/invoicing/issuer-identity.service.js");
const verifactu = await import("../../apps/api/src/modules/invoicing/verifactu-submission.service.js");
const pdf = await import("../../apps/api/src/modules/invoicing/invoice-pdf.service.js");
const { ConflictError } = await import("../../apps/api/src/lib/http-error.js");
const { flushAuditQueues } = await import("../../apps/api/src/modules/audit/audit.service.js");
type UserContext = import("../../apps/api/src/lib/demo-store.js").UserContext;

const RUN = Date.now().toString(36);
const ORG = `org_l3_${RUN}`;
const LE = `le_l3_${RUN}`;
const RA = `prop_l3_ra_${RUN}`;
const LT = `prop_l3_lt_${RUN}`;
const INST_RA = `vfi_l3_ra_${RUN}`;
const INST_LT = `vfi_l3_lt_${RUN}`;
const NUM_RA = `INST-L3-RA-${RUN.toUpperCase()}`;
const NUM_LT = `INST-L3-LT-${RUN.toUpperCase()}`;
const SOLO_ORG = `org_l3s_${RUN}`;
const SOLO_LE = `le_l3s_${RUN}`;
const SOLO = `prop_l3_solo_${RUN}`;
const LEGAL_NAME = "L3 Test Hoteles SA";
const FARANDA_ORG = "cmrhw9jy30002fyvb6tsdiugt";

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
const TAX_ID = cifFor("B", Date.now());
const SOLO_TAX_ID = cifFor("B", Date.now() + 7_331);

const context = (propertyId: string, organizationId = ORG): UserContext =>
  ({
    organizationId,
    propertyId,
    userId: `usr_l3_${RUN}`,
    fullName: "L3 Test",
    deviceId: `dev_l3_${RUN}`,
    permissions: ["invoice.issue"] as never
  }) as UserContext;

const year = invoicing.fiscalYearInMadrid(new Date());
const faranda = { invoices: 0, installations: 0, sequences: 0 };
const created = { invoiceIds: [] as string[] };

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
  assert.equal(isValidSpanishTaxId(TAX_ID), true, `generated CIF ${TAX_ID} must be checksum-valid`);
  assert.equal(isValidSpanishTaxId(SOLO_TAX_ID), true);
  // Read-only baseline of the pilot: compared again in the last test.
  const farandaPropertyIds = (await prisma.property.findMany({ where: { organizationId: FARANDA_ORG }, select: { id: true } })).map((p) => p.id);
  faranda.invoices = await prisma.invoice.count({ where: { propertyId: { in: farandaPropertyIds } } });
  faranda.installations = await prisma.verifactuInstallation.count({ where: { legalEntity: { organizationId: FARANDA_ORG } } });
  faranda.sequences = await prisma.invoiceSequence.count({ where: { propertyId: { in: farandaPropertyIds } } });

  // Sociedad with two hotels (per_center → one installation per hotel).
  await prisma.organization.create({ data: { id: ORG, name: "L3 Test Hoteles", country: "ES" } });
  await prisma.legalEntity.create({
    data: {
      id: LE,
      organizationId: ORG,
      code: "L3T",
      legalName: LEGAL_NAME,
      taxId: TAX_ID,
      legalForm: "sa",
      fiscalAddress: "Calle Sociedad 1",
      fiscalPostalCode: "15001",
      fiscalMunicipality: "A Coruna",
      fiscalProvince: "A Coruna",
      verifactuChainScope: "per_center",
      isDefault: true
    }
  });
  await prisma.property.create({
    data: { id: RA, organizationId: ORG, legalEntityId: LE, code: "RA", kind: "hotel", name: "Hotel L3 Rias Altas", tradeName: "Hotel L3 Rias Altas by Test", address: "Paseo Maritimo 1", postalCode: "15172", municipality: "Perillo (Oleiros)", province: "A Coruna", country: "ES", taxRegion: "ES_PENINSULA_BALEARES", fiscalTerritory: "common", createdAt: new Date("2026-01-01T00:00:00Z") }
  });
  await prisma.property.create({
    data: { id: LT, organizationId: ORG, legalEntityId: LE, code: "LT", kind: "hotel", name: "Hotel L3 Los Tilos", address: "Urbanizacion Los Tilos km 2", municipality: "Teo", province: "A Coruna", country: "ES", taxRegion: "ES_PENINSULA_BALEARES", fiscalTerritory: "common", createdAt: new Date("2026-02-01T00:00:00Z") }
  });
  await prisma.verifactuInstallation.create({ data: { id: INST_RA, legalEntityId: LE, propertyId: RA, numeroInstalacion: NUM_RA, route: "verifactu", active: true } });
  await prisma.verifactuInstallation.create({ data: { id: INST_LT, legalEntityId: LE, propertyId: LT, numeroInstalacion: NUM_LT, route: "verifactu", active: true } });

  // Hotel individual: one sociedad, one centre.
  await prisma.organization.create({ data: { id: SOLO_ORG, name: "L3 Solo Hotel", country: "ES" } });
  await prisma.legalEntity.create({ data: { id: SOLO_LE, organizationId: SOLO_ORG, code: "SOL", legalName: "L3 Solo Hotel SL", taxId: SOLO_TAX_ID, legalForm: "sl", isDefault: true } });
  await prisma.property.create({ data: { id: SOLO, organizationId: SOLO_ORG, legalEntityId: SOLO_LE, code: "SO", kind: "hotel", name: "Hotel L3 Solo", country: "ES", taxRegion: "ES_PENINSULA_BALEARES" } });
});

after(async () => {
  try {
    await verifactu.flushVerifactuQueue();
    await flushAuditQueues();
    await cleanupOrganization(ORG, [RA, LT]);
    await cleanupOrganization(SOLO_ORG, [SOLO]);
  } finally {
    await prisma.$disconnect();
  }
});

async function issueDraft(propertyId: string, total: number, taxTotal: number, customerName: string): Promise<Awaited<ReturnType<typeof invoicing.issueInvoice>>> {
  const draft = await drafts.createInvoiceDraft({
    propertyId,
    invoiceType: "F1",
    customerType: "company",
    customerName,
    total,
    taxTotal,
    context: context(propertyId),
    correlationId: `l3-draft-${RUN}`
  });
  created.invoiceIds.push(draft.id);
  return invoicing.issueInvoice({ context: context(propertyId), invoiceId: draft.id, correlationId: `l3-issue-${RUN}` });
}

const issued: { ra1?: Awaited<ReturnType<typeof invoicing.issueInvoice>>; ra2?: Awaited<ReturnType<typeof invoicing.issueInvoice>>; lt1?: Awaited<ReturnType<typeof invoicing.issueInvoice>> } = {};

describe("Estructura societaria · L3 · facturación sobre una sociedad aislada", () => {
  it("resolveIssuerIdentity: the issuer is the sociedad (NIF, razón social, domicilio fiscal) and the property is the establishment", async () => {
    const identity = await issuer.resolveIssuerIdentity(RA);
    assert.ok(identity);
    assert.equal(identity.legalName, LEGAL_NAME);
    assert.equal(identity.taxId, TAX_ID);
    assert.equal(identity.taxIdValid, true);
    assert.equal(identity.taxIdSource, "legal_entity");
    assert.equal(identity.legalEntityId, LE);
    assert.equal(identity.fiscalAddress, "Calle Sociedad 1, 15001 A Coruna");
    assert.equal(identity.verifactuChainScope, "per_center");
    assert.equal(identity.establishment.code, "RA");
    assert.equal(identity.establishment.tradeName, "Hotel L3 Rias Altas by Test");
    assert.equal(identity.establishment.addressLine, "Paseo Maritimo 1, 15172 Perillo (Oleiros), A Coruna");
    const lt = await issuer.resolveIssuerIdentity(LT);
    assert.equal(lt?.legalName, LEGAL_NAME, "both centres issue as the same sociedad");
    assert.equal(lt?.establishment.tradeName, "Hotel L3 Los Tilos", "trade name falls back to the property name");
  });

  it("resolveVerifactuChainScope: one installation per centre, lock key on the installation", async () => {
    const ra = await issuer.resolveVerifactuChainScope(prisma, RA);
    const lt = await issuer.resolveVerifactuChainScope(prisma, LT);
    assert.equal(ra.installation?.numeroInstalacion, NUM_RA);
    assert.equal(lt.installation?.numeroInstalacion, NUM_LT);
    assert.equal(ra.lockKey, `installation:${INST_RA}`);
    assert.notEqual(ra.lockKey, lt.lockKey);
    assert.deepEqual(ra.propertyIds, [RA]);
    assert.equal(ra.policy, "per_center");
  });

  it("C2 · two hotels of the same NIF issue FAC-RA-<año>-000001 and FAC-LT-<año>-000001; the sociedad and the installation are linked to each record", async () => {
    issued.ra1 = await issueDraft(RA, 110, 10, "Cliente RA SL");
    issued.lt1 = await issueDraft(LT, 220, 20, "Cliente LT SL");
    assert.equal(issued.ra1.invoiceNumber, `FAC-RA-${year}-000001`);
    assert.equal(issued.lt1.invoiceNumber, `FAC-LT-${year}-000001`);
    assert.equal(issued.ra1.issuerLegalName, LEGAL_NAME);
    assert.equal(issued.ra1.issuerTaxId, TAX_ID);
    assert.equal(issued.lt1.issuerLegalName, LEGAL_NAME);
    assert.equal(issued.ra1.issuer?.establishment?.code, "RA");
    assert.equal(issued.lt1.issuer?.establishment?.code, "LT");

    const rows = await prisma.invoice.findMany({ where: { id: { in: [issued.ra1.id, issued.lt1.id] } }, select: { id: true, legalEntityId: true, installationId: true, previousInvoiceHash: true, snapshotJson: true } });
    const ra = rows.find((r) => r.id === issued.ra1!.id)!;
    const lt = rows.find((r) => r.id === issued.lt1!.id)!;
    assert.equal(ra.legalEntityId, LE);
    assert.equal(lt.legalEntityId, LE);
    assert.equal(ra.installationId, INST_RA);
    assert.equal(lt.installationId, INST_LT);
    assert.equal(ra.previousInvoiceHash, null, "first record of the RA installation");
    assert.equal(lt.previousInvoiceHash, null, "first record of the LT installation: never chained onto RA");
    const frozen = invoicing.structureFromSnapshotJson(ra.snapshotJson);
    assert.equal(frozen.establishment?.code, "RA");
    assert.equal(frozen.establishment?.tradeName, "Hotel L3 Rias Altas by Test");
    assert.equal(frozen.issuerFiscalAddress, "Calle Sociedad 1, 15001 A Coruna");
    assert.equal(frozen.numeroInstalacion, NUM_RA);

    const sequences = await prisma.invoiceSequence.findMany({ where: { propertyId: { in: [RA, LT] }, sequenceCode: "FAC", year }, select: { propertyId: true, prefix: true, legalEntityId: true, nextNumber: true } });
    assert.deepEqual(
      sequences.map((s) => [s.propertyId, s.prefix, s.legalEntityId, s.nextNumber]).sort(),
      [[LT, `FAC-LT-${year}-`, LE, 2], [RA, `FAC-RA-${year}-`, LE, 2]].sort()
    );
  });

  it("C3 · the second RA invoice chains onto the first RA record; the LT chain stays independent", async () => {
    issued.ra2 = await issueDraft(RA, 330, 30, "Cliente RA 2 SL");
    assert.equal(issued.ra2.invoiceNumber, `FAC-RA-${year}-000002`);
    assert.equal(issued.ra2.previousInvoiceHash, issued.ra1!.verifactuHash, "RegistroAnterior = previous record of the RA installation");
    assert.notEqual(issued.ra2.previousInvoiceHash, issued.lt1!.verifactuHash);
    const previous = await prisma.$transaction((tx) => invoicing.findPreviousChainLink(tx, LT));
    assert.equal(previous?.invoiceId, issued.lt1!.id, "the LT chain tail is the LT record, not the newer RA one");
  });

  it("C3 · VeriFactu registros: NumeroInstalacion per installation, NombreRazon = razón social, IDEmisorFactura = NIF, IndicadorMultiplesOT = S, RegistroAnterior per chain", async () => {
    await verifactu.flushVerifactuQueue();
    const submissions = await prisma.verifactuSubmission.findMany({ where: { invoiceId: { in: [issued.ra1!.id, issued.ra2!.id, issued.lt1!.id] }, registroType: "alta" } });
    assert.equal(submissions.length, 3, "one RegistroAlta per invoice (sandbox stub)");
    const byInvoice = new Map(submissions.map((s) => [s.invoiceId, s]));
    const ra1 = byInvoice.get(issued.ra1!.id)!;
    const ra2 = byInvoice.get(issued.ra2!.id)!;
    const lt1 = byInvoice.get(issued.lt1!.id)!;
    for (const row of [ra1, ra2, lt1]) {
      assert.equal(row.status, "accepted", row.errorMessage ?? "");
      assert.equal(row.mode, "sandbox");
      assert.match(row.xmlPayload ?? "", new RegExp(`<sum1:ObligadoEmision>\\s*<sum1:NombreRazon>${LEGAL_NAME}</sum1:NombreRazon>\\s*<sum1:NIF>${TAX_ID}</sum1:NIF>`));
      assert.match(row.xmlPayload ?? "", new RegExp(`<sum1:IDEmisorFactura>${TAX_ID}</sum1:IDEmisorFactura>`));
      assert.match(row.xmlPayload ?? "", /<sum1:IndicadorMultiplesOT>S<\/sum1:IndicadorMultiplesOT>/);
    }
    assert.match(ra1.xmlPayload ?? "", new RegExp(`<sum1:NumeroInstalacion>${NUM_RA}</sum1:NumeroInstalacion>`));
    assert.match(ra2.xmlPayload ?? "", new RegExp(`<sum1:NumeroInstalacion>${NUM_RA}</sum1:NumeroInstalacion>`));
    assert.match(lt1.xmlPayload ?? "", new RegExp(`<sum1:NumeroInstalacion>${NUM_LT}</sum1:NumeroInstalacion>`));
    assert.match(ra1.xmlPayload ?? "", /<sum1:PrimerRegistro>S<\/sum1:PrimerRegistro>/);
    assert.match(lt1.xmlPayload ?? "", /<sum1:PrimerRegistro>S<\/sum1:PrimerRegistro>/);
    assert.match(ra2.xmlPayload ?? "", new RegExp(`<sum1:RegistroAnterior>[\\s\\S]*<sum1:NumSerieFactura>FAC-RA-${year}-000001</sum1:NumSerieFactura>[\\s\\S]*<sum1:Huella>${issued.ra1!.verifactuHash}</sum1:Huella>`));
    assert.equal(ra1.installationId, INST_RA);
    assert.equal(lt1.installationId, INST_LT);
    assert.equal((ra1.softwareJson as { numeroInstalacion: string }).numeroInstalacion, NUM_RA);
    assert.equal((lt1.softwareJson as { numeroInstalacion: string }).numeroInstalacion, NUM_LT);
  });

  it("C2 · opening a series whose prefix a sister centre uses → 409 SERIES_PREFIX_CLASH { conflictingPropertyId }; nothing is written", async () => {
    const seeded = await prisma.invoiceSequence.create({ data: { propertyId: LT, sequenceCode: "REC", prefix: `REC-RA-${year}-`, year, nextNumber: 1, invoiceType: "R1", active: true, legalEntityId: LE } });
    try {
      await assert.rejects(
        prisma.$transaction(async (tx) => {
          await invoicing.allocateInvoiceNumber(tx, { propertyId: RA, series: "REC", issuedAt: new Date() });
          throw new Error("unreachable");
        }),
        (error: unknown) => {
          assert.ok(error instanceof ConflictError, String(error));
          const details = error.details as { code: string; conflictingPropertyId: string; conflictingSequenceId: string; prefix: string; year: number };
          assert.equal(details.code, "SERIES_PREFIX_CLASH");
          assert.equal(details.conflictingPropertyId, LT);
          assert.equal(details.conflictingSequenceId, seeded.id);
          assert.equal(details.prefix, `REC-RA-${year}-`);
          assert.equal(details.year, year);
          return true;
        }
      );
      assert.equal(await prisma.invoiceSequence.count({ where: { propertyId: RA, sequenceCode: "REC" } }), 0, "the RA REC series was not opened");
    } finally {
      await prisma.invoiceSequence.delete({ where: { id: seeded.id } });
    }
  });

  it("C2 · a number already issued by a sister centre under the same NIF → 409 INVOICE_NUMBER_DUPLICATE, transaction rolled back; the same draft issues once the duplicate is gone", async () => {
    const duplicate = await prisma.invoice.create({
      data: { id: `inv_l3_dup_${RUN}`, propertyId: LT, legalEntityId: LE, invoiceNumber: `FAC-RA-${year}-000003`, invoiceType: "F1", customerType: "company", status: "issued", issuedAt: new Date(), issuerTaxId: TAX_ID, issuerLegalName: LEGAL_NAME, seriesCode: "FAC", total: 1, taxTotal: 0 }
    });
    created.invoiceIds.push(duplicate.id);
    const draft = await drafts.createInvoiceDraft({ propertyId: RA, invoiceType: "F1", customerType: "company", customerName: "Cliente RA 3 SL", total: 55, taxTotal: 5, context: context(RA), correlationId: `l3-dup-${RUN}` });
    created.invoiceIds.push(draft.id);
    const sequenceBefore = await prisma.invoiceSequence.findFirstOrThrow({ where: { propertyId: RA, sequenceCode: "FAC", year } });
    await assert.rejects(invoicing.issueInvoice({ context: context(RA), invoiceId: draft.id, correlationId: `l3-dup-${RUN}` }), (error: unknown) => {
      assert.ok(error instanceof ConflictError, String(error));
      const details = error.details as { code: string; conflictingPropertyId: string; conflictingInvoiceId: string; invoiceNumber: string };
      assert.equal(details.code, "INVOICE_NUMBER_DUPLICATE");
      assert.equal(details.conflictingPropertyId, LT);
      assert.equal(details.conflictingInvoiceId, duplicate.id);
      assert.equal(details.invoiceNumber, `FAC-RA-${year}-000003`);
      return true;
    });
    const sequenceAfter = await prisma.invoiceSequence.findUniqueOrThrow({ where: { id: sequenceBefore.id } });
    assert.equal(sequenceAfter.nextNumber, sequenceBefore.nextNumber, "the failed issuance did not consume a number");
    assert.equal((await prisma.invoice.findUniqueOrThrow({ where: { id: draft.id } })).status, "draft");

    await prisma.invoice.delete({ where: { id: duplicate.id } });
    const third = await invoicing.issueInvoice({ context: context(RA), invoiceId: draft.id, correlationId: `l3-dup2-${RUN}` });
    assert.equal(third.invoiceNumber, `FAC-RA-${year}-000003`);
    assert.equal(third.previousInvoiceHash, issued.ra2!.verifactuHash, "chained onto the RA tail");
  });

  it("a hotel individual keeps FAC-<año>- (prefijo condicional, cero cambio)", async () => {
    await assert.rejects(
      prisma.$transaction(async (tx) => {
        const allocated = await invoicing.allocateInvoiceNumber(tx, { propertyId: SOLO, series: "FAC", issuedAt: new Date() });
        assert.equal(allocated.invoiceNumber, `FAC-${year}-000001`);
        assert.equal(allocated.prefix, `FAC-${year}-`);
        assert.equal(allocated.scope.billingCentres, 1);
        assert.deepEqual(allocated.scope.siblingPropertyIds, []);
        assert.equal(allocated.legalEntityId, SOLO_LE);
        throw new Error("ROLLBACK");
      }),
      /ROLLBACK/
    );
    assert.equal(await prisma.invoiceSequence.count({ where: { propertyId: SOLO } }), 0);
  });

  it("the new year opens FAC-RA-<año+1>-000001 and leaves the current series untouched (never renumbered)", async () => {
    const before = await prisma.invoiceSequence.findFirstOrThrow({ where: { propertyId: RA, sequenceCode: "FAC", year } });
    await assert.rejects(
      prisma.$transaction(async (tx) => {
        const next = await invoicing.allocateInvoiceNumber(tx, { propertyId: RA, series: "FAC", issuedAt: new Date(`${year + 1}-02-01T10:00:00.000Z`) });
        assert.equal(next.invoiceNumber, `FAC-RA-${year + 1}-000001`);
        assert.equal(next.created, true);
        throw new Error("ROLLBACK");
      }),
      /ROLLBACK/
    );
    const after = await prisma.invoiceSequence.findUniqueOrThrow({ where: { id: before.id } });
    assert.equal(after.nextNumber, before.nextNumber);
    assert.equal(after.active, true);
    assert.equal(after.prefix, `FAC-RA-${year}-`);
  });

  it("the PDF shows the sociedad (razón social, NIF, domicilio fiscal) and the «Establecimiento» block", async () => {
    const { buffer, model, filename } = await pdf.renderInvoicePdf(issued.ra1!.id);
    assert.equal(filename, `FAC-RA-${year}-000001.pdf`);
    assert.equal(model.issuer.legalName, LEGAL_NAME);
    assert.equal(model.issuer.taxId, TAX_ID);
    assert.equal(model.issuer.fiscalAddress, "Calle Sociedad 1, 15001 A Coruna");
    assert.deepEqual(model.issuer.establishment, { code: "RA", tradeName: "Hotel L3 Rias Altas by Test", addressLine: "Paseo Maritimo 1, 15172 Perillo (Oleiros), A Coruna" });
    const out = buffer.toString("latin1");
    assert.ok(out.startsWith("%PDF-1.4\n"));
    assert.ok(out.includes(LEGAL_NAME));
    assert.ok(out.includes(`NIF: ${TAX_ID}`));
    assert.ok(out.includes("Domicilio fiscal: Calle Sociedad 1, 15001 A Coruna"));
    assert.ok(out.includes("Establecimiento: Hotel L3 Rias Altas by Test \\(RA\\)"));
    assert.ok(out.includes("QR tributario"));
  });

  it("the issuer snapshot of an issued invoice is immutable (trigger invoices_issuer_inmutable)", async () => {
    await assert.rejects(prisma.invoice.update({ where: { id: issued.ra1!.id }, data: { issuerLegalName: "Otra Sociedad SL" } }), /issuer|inmutable|immutable/i);
    await assert.rejects(prisma.invoice.update({ where: { id: issued.ra1!.id }, data: { issuerTaxId: "B12345674" } }), /issuer|inmutable|immutable/i);
    const row = await prisma.invoice.findUniqueOrThrow({ where: { id: issued.ra1!.id }, select: { issuerLegalName: true, issuerTaxId: true } });
    assert.equal(row.issuerLegalName, LEGAL_NAME);
    assert.equal(row.issuerTaxId, TAX_ID);
  });

  it("the installation number is immutable (trigger verifactu_installations_numero_inmutable)", async () => {
    await assert.rejects(prisma.verifactuInstallation.update({ where: { id: INST_RA }, data: { numeroInstalacion: `${NUM_RA}-X` } }), /numero|inmutable|immutable/i);
    assert.equal((await prisma.verifactuInstallation.findUniqueOrThrow({ where: { id: INST_RA } })).numeroInstalacion, NUM_RA);
  });

  it("Faranda was only read: same invoices, installations and series as before the suite", async () => {
    const propertyIds = (await prisma.property.findMany({ where: { organizationId: FARANDA_ORG }, select: { id: true } })).map((p) => p.id);
    assert.equal(await prisma.invoice.count({ where: { propertyId: { in: propertyIds } } }), faranda.invoices);
    assert.equal(await prisma.verifactuInstallation.count({ where: { legalEntity: { organizationId: FARANDA_ORG } } }), faranda.installations);
    assert.equal(await prisma.invoiceSequence.count({ where: { propertyId: { in: propertyIds } } }), faranda.sequences);
  });
});
