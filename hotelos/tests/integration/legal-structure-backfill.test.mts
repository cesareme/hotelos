/**
 * Estructura societaria · L1 · integration (Postgres required; in-process, no HTTP).
 *
 * An ISOLATED organisation (`org_lsb_<run>`, two hotels) created here and removed
 * in `after` exercises the schema and the backfill against real rows:
 *   · backfill dry-run plans and writes nothing; `--apply --confirm <org>` creates
 *     the implicit legal entity, codes the centres, opens the VeriFactu installation
 *     with the number the sandbox records declared and links sequences, invoices,
 *     submissions and the bank account; a second apply plans 0 writes (idempotent);
 *   · the report names the demo-like collisions (same prefix and the same invoice
 *     number in two centres, sii_enabled left on a property);
 *   · the immutability triggers of migration 20260916100000 reject a change of the
 *     issuer snapshot of an ISSUED invoice and of the installation number, while a
 *     draft, a NULL → value fill and a retirement stay allowed;
 *   · the unique index on legal_entities.tax_id of migration 20260916101000;
 *   · resolveLegalIdentity / resolveLedgerScope / listOperationalProperties and
 *     assertSeriesPrefixFree over the real rows.
 *
 * The run is limited with `--org`, so Faranda and org_123 are never planned nor
 * written. Run from the repo root:
 *   cd apps/api && node --import tsx --test "../../tests/integration/legal-structure-backfill.test.mts"
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

const { prisma } = await import("@hotelos/database");
const backfill = await import("../../apps/api/src/scripts/backfill-legal-structure.js");
const scope = await import("../../apps/api/src/lib/finance-scope.js");
const series = await import("../../apps/api/src/modules/invoicing/series-prefix.service.js");
const { ConflictError, NotFoundError } = await import("../../apps/api/src/lib/http-error.js");
const { flushAuditQueues } = await import("../../apps/api/src/modules/audit/audit.service.js");

const RUN = Date.now().toString(36);
const ORG = `org_lsb_${RUN}`;
const PROP_A = `prop_lsb_a_${RUN}`;
const PROP_B = `prop_lsb_b_${RUN}`;
/** Checksum-valid CIF that no demo tenant uses (A58818501: sum 29 → control 1). */
const TAX_ID = "A58818501";
const INSTALL_NUMBER = `INST-LSB-${RUN}`;

const ids = { invoiceA1: `inv_lsb_a1_${RUN}`, invoiceADraft: `inv_lsb_ad_${RUN}`, invoiceB1: `inv_lsb_b1_${RUN}`, bank: `bank_lsb_${RUN}` };

async function cleanup(): Promise<void> {
  const propertyIds = [PROP_A, PROP_B];
  await prisma.verifactuSubmission.deleteMany({ where: { propertyId: { in: propertyIds } } });
  await prisma.invoice.deleteMany({ where: { propertyId: { in: propertyIds } } });
  await prisma.invoiceSequence.deleteMany({ where: { propertyId: { in: propertyIds } } });
  await prisma.bankAccount.deleteMany({ where: { organizationId: ORG } });
  await prisma.propertyComplianceSetting.deleteMany({ where: { propertyId: { in: propertyIds } } });
  const entities = await prisma.legalEntity.findMany({ where: { organizationId: ORG }, select: { id: true } });
  if (entities.length > 0) await prisma.verifactuInstallation.deleteMany({ where: { legalEntityId: { in: entities.map((e) => e.id) } } });
  await prisma.property.deleteMany({ where: { organizationId: ORG } });
  await prisma.legalEntity.deleteMany({ where: { organizationId: ORG } });
  await prisma.organization.deleteMany({ where: { id: ORG } });
}

before(async () => {
  await prisma.organization.create({ data: { id: ORG, name: "LSB Test Hotels", legalName: "LSB Test Hotels SA", taxId: TAX_ID, country: "ES" } });
  await prisma.property.create({ data: { id: PROP_A, organizationId: ORG, name: "Hotel LSB Playa Norte", legalName: "Hotel LSB Playa Norte", createdAt: new Date("2026-01-01T00:00:00Z") } });
  await prisma.property.create({ data: { id: PROP_B, organizationId: ORG, name: "Hotel LSB Sierra Sur", legalName: null, createdAt: new Date("2026-02-01T00:00:00Z") } });
  // Same prefix in both centres: the demo-like clash the report must name.
  await prisma.invoiceSequence.create({ data: { id: `seq_lsb_a_${RUN}`, propertyId: PROP_A, sequenceCode: "FAC", prefix: "FAC-2026-", year: 2026, nextNumber: 2, invoiceType: "F1", active: true } });
  await prisma.invoiceSequence.create({ data: { id: `seq_lsb_b_${RUN}`, propertyId: PROP_B, sequenceCode: "FAC", prefix: "FAC-2026-", year: 2026, nextNumber: 2, invoiceType: "F1", active: true } });
  await prisma.invoice.create({
    data: { id: ids.invoiceA1, propertyId: PROP_A, invoiceNumber: "FAC-2026-000001", invoiceType: "F1", customerType: "company", status: "issued", issuedAt: new Date("2026-03-01T10:00:00Z"), issuerTaxId: TAX_ID, issuerLegalName: "LSB Test Hotels SA", verifactuHash: `hash_lsb_${RUN}`, seriesCode: "FAC" }
  });
  await prisma.invoice.create({ data: { id: ids.invoiceADraft, propertyId: PROP_A, invoiceType: "F1", customerType: "company", status: "draft" } });
  // Same number under the same NIF in the sister centre (issuer snapshot still NULL: fill allowed later).
  await prisma.invoice.create({ data: { id: ids.invoiceB1, propertyId: PROP_B, invoiceNumber: "FAC-2026-000001", invoiceType: "F1", customerType: "company", status: "issued", issuedAt: new Date("2026-03-02T10:00:00Z"), seriesCode: "FAC" } });
  await prisma.verifactuSubmission.create({
    data: { invoiceId: ids.invoiceA1, propertyId: PROP_A, status: "accepted", registroType: "alta", mode: "sandbox", softwareJson: { numeroInstalacion: INSTALL_NUMBER, idSistema: "01" } }
  });
  await prisma.bankAccount.create({ data: { id: ids.bank, propertyId: PROP_A, organizationId: ORG, name: "Cuenta LSB", iban: "ES9121000418450200051332" } });
  await prisma.propertyComplianceSetting.create({ data: { propertyId: PROP_A, country: "ES", siiEnabled: true } });
});

after(async () => {
  try {
    await flushAuditQueues();
    await cleanup();
  } finally {
    await prisma.$disconnect();
  }
});

describe("backfill-legal-structure · isolated organisation", () => {
  it("dry-run plans the implicit legal entity, the codes, the installation and the report — and writes nothing", async () => {
    const summary = await backfill.runBackfill(backfill.parseFlags(["--dry-run", "--org", ORG]));
    assert.equal(summary.dryRun, true);
    assert.equal(summary.organizations.length, 1, "only the isolated organisation is planned");
    const entry = summary.organizations[0]!;
    assert.equal(entry.organizationId, ORG);
    assert.equal(entry.error, undefined);
    const plan = entry.plan!;
    assert.equal(plan.legalEntity.action, "create");
    assert.equal(plan.legalEntity.legalName, "LSB Test Hotels SA");
    assert.equal(plan.legalEntity.taxId, TAX_ID);
    assert.deepEqual(plan.properties.map((p) => [p.id, p.code]), [[PROP_A, "PN"], [PROP_B, "SS"]]);
    assert.deepEqual(plan.properties.find((p) => p.id === PROP_A)?.set.tradeName, "Hotel LSB Playa Norte", "the old legalName becomes the trade name when it differs from the razón social");
    assert.equal(plan.properties.find((p) => p.id === PROP_B)?.set.tradeName, undefined);
    assert.deepEqual(plan.installations.map((i) => [i.propertyId, i.numeroInstalacion, i.action, i.invoicesToLink, i.submissionsToLink]), [[PROP_A, INSTALL_NUMBER, "create", 1, 1]]);
    assert.deepEqual(plan.sequences, { total: 2, toLink: 2 });
    assert.deepEqual(plan.invoices, { total: 3, toLink: 3 });
    assert.deepEqual(plan.bankAccounts, { total: 1, toLink: 1 });
    assert.deepEqual(plan.warnings.map((w) => w.code).sort(), ["INVOICE_NUMBER_DUPLICATE", "SERIES_PREFIX_CLASH", "SII_FLAG_ON_PROPERTY"]);
    assert.equal(plan.writes, 1 + 2 + 1 + 1 + 1 + 2 + 3 + 1);
    assert.equal(await prisma.legalEntity.count({ where: { organizationId: ORG } }), 0, "dry-run wrote nothing");
    assert.equal((await prisma.property.findUnique({ where: { id: PROP_A }, select: { legalEntityId: true } }))?.legalEntityId, null);
  });

  it("--apply --confirm <org> writes the plan inside one transaction and the post-conditions hold", async () => {
    const summary = await backfill.runBackfill(backfill.parseFlags(["--apply", "--confirm", ORG, "--org", ORG]));
    const entry = summary.organizations[0]!;
    assert.equal(entry.error, undefined, entry.error);
    assert.equal(entry.applied, true);
    assert.deepEqual(entry.counts, {
      legalEntityCreated: 1,
      propertiesUpdated: 2,
      installationsCreated: 1,
      invoiceInstallationsLinked: 1,
      submissionsLinked: 1,
      sequencesLinked: 2,
      invoicesLinked: 3,
      bankAccountsLinked: 1
    });
    assert.equal(entry.verification?.ok, true, JSON.stringify(entry.verification));

    const entity = await prisma.legalEntity.findFirstOrThrow({ where: { organizationId: ORG } });
    assert.equal(entity.taxId, TAX_ID);
    assert.equal(entity.isDefault, true);
    assert.equal(entity.pgcVariant, "pymes");
    assert.equal(entity.verifactuChainScope, "per_center");
    const a = await prisma.property.findUniqueOrThrow({ where: { id: PROP_A } });
    const b = await prisma.property.findUniqueOrThrow({ where: { id: PROP_B } });
    assert.deepEqual([a.legalEntityId, a.code, a.kind, a.tradeName], [entity.id, "PN", "hotel", "Hotel LSB Playa Norte"]);
    assert.deepEqual([b.legalEntityId, b.code, b.kind, b.tradeName], [entity.id, "SS", "hotel", null]);
    const installation = await prisma.verifactuInstallation.findFirstOrThrow({ where: { legalEntityId: entity.id } });
    assert.equal(installation.propertyId, PROP_A);
    assert.equal(installation.numeroInstalacion, INSTALL_NUMBER);
    const invoiceA1 = await prisma.invoice.findUniqueOrThrow({ where: { id: ids.invoiceA1 } });
    assert.equal(invoiceA1.legalEntityId, entity.id);
    assert.equal(invoiceA1.installationId, installation.id);
    assert.equal(invoiceA1.issuerTaxId, TAX_ID, "the issuer snapshot is untouched");
    const draft = await prisma.invoice.findUniqueOrThrow({ where: { id: ids.invoiceADraft } });
    assert.equal(draft.legalEntityId, entity.id);
    assert.equal(draft.installationId, null, "a draft is not in the chain");
    const submission = await prisma.verifactuSubmission.findFirstOrThrow({ where: { invoiceId: ids.invoiceA1 } });
    assert.equal(submission.installationId, installation.id);
    assert.equal((await prisma.invoiceSequence.count({ where: { propertyId: { in: [PROP_A, PROP_B] }, legalEntityId: entity.id } })), 2);
    assert.equal((await prisma.bankAccount.findUniqueOrThrow({ where: { id: ids.bank } })).legalEntityId, entity.id);
  });

  it("a second apply is a no-op (0 writes, converged) and the report warnings stay informative", async () => {
    const summary = await backfill.runBackfill(backfill.parseFlags(["--apply", "--confirm", ORG, "--org", ORG]));
    const entry = summary.organizations[0]!;
    assert.equal(entry.error, undefined, entry.error);
    assert.equal(entry.plan?.writes, 0);
    assert.equal(entry.applied, false);
    assert.equal(entry.plan?.legalEntity.action, "exists");
    assert.ok(entry.plan?.installations.every((i) => i.action === "exists"));
    assert.equal(entry.verification?.ok, true);
    assert.deepEqual(entry.plan?.warnings.map((w) => w.code).sort(), ["INVOICE_NUMBER_DUPLICATE", "SERIES_PREFIX_CLASH", "SII_FLAG_ON_PROPERTY"]);
    assert.equal(await prisma.legalEntity.count({ where: { organizationId: ORG } }), 1);
    assert.equal(await prisma.verifactuInstallation.count({ where: { propertyId: PROP_A } }), 1);
  });

  it("--confirm of an unknown organisation is reported as an error (exit 1 path)", async () => {
    const summary = await backfill.runBackfill(backfill.parseFlags(["--apply", "--confirm", "org_lsb_missing", "--org", "org_lsb_missing"]));
    assert.equal(summary.organizations.length, 1);
    assert.equal(summary.organizations[0]?.error, "organización no encontrada");
  });
});

describe("triggers and constraints of the sociedad layer", () => {
  it("invoices_issuer_inmutable: an issued invoice keeps its issuer snapshot; a draft or a NULL snapshot may still be written", async () => {
    await assert.rejects(prisma.invoice.update({ where: { id: ids.invoiceA1 }, data: { issuerTaxId: "B12345674" } }), /inmutable/);
    await assert.rejects(prisma.invoice.update({ where: { id: ids.invoiceA1 }, data: { issuerLegalName: "Otra razón social" } }), /inmutable/);
    assert.equal((await prisma.invoice.findUniqueOrThrow({ where: { id: ids.invoiceA1 } })).issuerTaxId, TAX_ID);
    // Draft: the issue flow stamps the snapshot while the row is still a draft.
    await prisma.invoice.update({ where: { id: ids.invoiceADraft }, data: { issuerTaxId: TAX_ID, issuerLegalName: "LSB Test Hotels SA" } });
    // Legacy issued row without snapshot: filling it is allowed (backfillInvoiceIssuerSnapshots), changing it afterwards is not.
    await prisma.invoice.update({ where: { id: ids.invoiceB1 }, data: { issuerTaxId: TAX_ID, issuerLegalName: "LSB Test Hotels SA" } });
    await assert.rejects(prisma.invoice.update({ where: { id: ids.invoiceB1 }, data: { issuerTaxId: "B12345674" } }), /inmutable/);
    // Other columns of an issued invoice are not affected by the trigger.
    await prisma.invoice.update({ where: { id: ids.invoiceB1 }, data: { paidAt: new Date("2026-03-05T10:00:00Z") } });
  });

  it("verifactu_installations_numero_inmutable: the number and the entity never change; retiring is allowed", async () => {
    const installation = await prisma.verifactuInstallation.findFirstOrThrow({ where: { propertyId: PROP_A } });
    await assert.rejects(prisma.verifactuInstallation.update({ where: { id: installation.id }, data: { numeroInstalacion: `${INSTALL_NUMBER}-X` } }), /inmutable/);
    assert.equal((await prisma.verifactuInstallation.findUniqueOrThrow({ where: { id: installation.id } })).numeroInstalacion, INSTALL_NUMBER);
    await prisma.verifactuInstallation.update({ where: { id: installation.id }, data: { active: false, retiredAt: new Date() } });
    await prisma.verifactuInstallation.update({ where: { id: installation.id }, data: { active: true, retiredAt: null } });
  });

  it("legal_entities.tax_id is unique and (legal_entity_id, numero_instalacion) is unique", async () => {
    const entity = await prisma.legalEntity.findFirstOrThrow({ where: { organizationId: ORG } });
    await assert.rejects(
      prisma.legalEntity.create({ data: { organizationId: ORG, code: "DUP", legalName: "Duplicada SA", taxId: TAX_ID, isDefault: false } }),
      (error: unknown) => (error as { code?: string }).code === "P2002"
    );
    await assert.rejects(
      prisma.verifactuInstallation.create({ data: { legalEntityId: entity.id, propertyId: PROP_B, numeroInstalacion: INSTALL_NUMBER } }),
      (error: unknown) => (error as { code?: string }).code === "P2002"
    );
    await assert.rejects(prisma.legalEntity.delete({ where: { id: entity.id } }), /Foreign key constraint|violates foreign key/i);
  });
});

describe("helpers over the real rows", () => {
  it("resolveLegalIdentity reads the backfilled sociedad; resolveLedgerScope scopes by entity or centre", async () => {
    const identity = await scope.resolveLegalIdentity(ORG);
    assert.ok(identity);
    assert.equal(identity.source, "legal_entity");
    assert.equal(identity.taxId, TAX_ID);
    assert.equal(identity.taxIdValid, true);
    assert.equal(identity.legalName, "LSB Test Hotels SA");
    const entityScope = await scope.resolveLedgerScope({ organizationId: ORG });
    assert.equal(entityScope.kind, "entity");
    assert.equal(entityScope.legalEntityId, identity.legalEntityId);
    const centre = await scope.resolveLedgerScope({ organizationId: ORG, assignedPropertyIds: [PROP_B] }, { propertyId: PROP_B });
    assert.equal(centre.kind, "property");
    assert.equal(centre.propertyKind, "hotel");
    await assert.rejects(scope.resolveLedgerScope({ organizationId: ORG, assignedPropertyIds: [PROP_B] }, { propertyId: PROP_A }), (error: unknown) => error instanceof NotFoundError);
    await assert.rejects(scope.resolveLedgerScope({ organizationId: ORG }, { legalEntityId: "le_other" }), (error: unknown) => error instanceof NotFoundError);
    await assert.rejects(scope.resolveLedgerScope({ organizationId: ORG }, { propertyId: "prop_123" }), (error: unknown) => error instanceof NotFoundError, "a property of another organisation is opaque");
  });

  it("listOperationalProperties drops a centre once it becomes an office", async () => {
    assert.deepEqual((await scope.listOperationalProperties(ORG)).map((p) => p.id), [PROP_A, PROP_B]);
    await prisma.property.update({ where: { id: PROP_B }, data: { kind: "office" } });
    assert.deepEqual((await scope.listOperationalProperties(ORG)).map((p) => p.id), [PROP_A]);
    const office = await scope.resolveLedgerScope({ organizationId: ORG }, { propertyId: PROP_B });
    assert.equal(office.propertyKind, "office", "finance still reaches the office");
    await prisma.property.update({ where: { id: PROP_B }, data: { kind: "hotel" } });
  });

  it("assertSeriesPrefixFree: 409 SERIES_PREFIX_CLASH names the sister centre; a coded prefix is free", async () => {
    await assert.rejects(series.assertSeriesPrefixFree({ propertyId: PROP_B, prefix: "fac-2026-", year: 2026 }), (error: unknown) => {
      assert.ok(error instanceof ConflictError);
      assert.equal(error.statusCode, 409);
      const details = error.details as { code: string; conflictingPropertyId: string };
      assert.equal(details.code, "SERIES_PREFIX_CLASH");
      assert.equal(details.conflictingPropertyId, PROP_A);
      return true;
    });
    await series.assertSeriesPrefixFree({ propertyId: PROP_B, prefix: "FAC-SS-2026-", year: 2026 });
    await series.assertSeriesPrefixFree({ propertyId: PROP_B, prefix: "FAC-2026-", year: 2026, excludeSequenceId: `seq_lsb_a_${RUN}` });
    assert.equal(series.defaultSeriesPrefix({ series: "FAC", year: 2026, propertyCode: "SS", billingCentres: 2 }), "FAC-SS-2026-");
  });
});

// ---------------------------------------------------------------------------
// Migration 20260916102000 · `properties_sociedad_inmutable` (R10.1 / R10.5) and
// `legal_entities_organizacion_inmutable` on real rows (fix:L1 · t6b#10; the L1
// probe ported here by the integrator). Own isolated organisations: `org_lsbp_<run>`
// with TWO sociedades (the DB allows it; the service answers 409
// MULTI_ENTITY_NOT_ENABLED — the second one isolates the R10.5 branch from R10.1)
// and `org_lsbp_solo_<run>` (the foreign sociedad). Created and removed here;
// Faranda and org_123 are never touched.
// ---------------------------------------------------------------------------
describe("properties_sociedad_inmutable · R10.5 / R10.1 (migration 20260916102000)", () => {
  const P_ORG = `org_lsbp_${RUN}`;
  const P_SOLO_ORG = `org_lsbp_solo_${RUN}`;
  const P_LE = `le_lsbp_${RUN}`;
  const P_LE2 = `le_lsbp_two_${RUN}`;
  const P_SOLO_LE = `le_lsbp_solo_${RUN}`;
  const WITH_INVOICES = `prop_lsbp_inv_${RUN}`; // issued invoice, no installation
  const WITH_INSTALLATION = `prop_lsbp_inst_${RUN}`; // retired installation, no invoice
  const FREE = `prop_lsbp_free_${RUN}`; // only a draft
  const LEGACY = `prop_lsbp_legacy_${RUN}`; // pre-backfill shape: issued invoice, legal_entity_id NULL
  const P_INST = `vfi_lsbp_${RUN}`;
  const P_PROPS = [WITH_INVOICES, WITH_INSTALLATION, FREE, LEGACY];
  const R105 = /no puede cambiar de sociedad ni de organización/;
  const R101 = /pertenece a otra organización/;

  async function cleanupPinned(): Promise<void> {
    await prisma.invoice.deleteMany({ where: { propertyId: { in: P_PROPS } } });
    await prisma.verifactuInstallation.deleteMany({ where: { legalEntityId: { in: [P_LE, P_LE2, P_SOLO_LE] } } });
    await prisma.property.deleteMany({ where: { organizationId: { in: [P_ORG, P_SOLO_ORG] } } });
    await prisma.legalEntity.deleteMany({ where: { id: { in: [P_LE, P_LE2, P_SOLO_LE] } } });
    await prisma.organization.deleteMany({ where: { id: { in: [P_ORG, P_SOLO_ORG] } } });
  }

  async function legalEntityOf(id: string): Promise<string | null> {
    return (await prisma.property.findUniqueOrThrow({ where: { id }, select: { legalEntityId: true } })).legalEntityId;
  }

  before(async () => {
    await cleanupPinned();
    await prisma.organization.create({ data: { id: P_ORG, name: "LSBP Hotels", country: "ES" } });
    await prisma.organization.create({ data: { id: P_SOLO_ORG, name: "LSBP Solo", country: "ES" } });
    await prisma.legalEntity.create({ data: { id: P_LE, organizationId: P_ORG, code: "LP", legalName: "LSBP Hotels SA", isDefault: true } });
    await prisma.legalEntity.create({ data: { id: P_LE2, organizationId: P_ORG, code: "L2", legalName: "LSBP Segunda SL", isDefault: false } });
    await prisma.legalEntity.create({ data: { id: P_SOLO_LE, organizationId: P_SOLO_ORG, code: "SO", legalName: "LSBP Solo SL", isDefault: true } });
    await prisma.property.create({ data: { id: WITH_INVOICES, organizationId: P_ORG, legalEntityId: P_LE, code: "IN", name: "Hotel LSBP Facturas" } });
    await prisma.property.create({ data: { id: WITH_INSTALLATION, organizationId: P_ORG, legalEntityId: P_LE, code: "IS", name: "Hotel LSBP Instalación" } });
    await prisma.property.create({ data: { id: FREE, organizationId: P_ORG, legalEntityId: null, code: "FR", name: "Hotel LSBP Libre" } });
    await prisma.property.create({ data: { id: LEGACY, organizationId: P_ORG, legalEntityId: null, code: "LG", name: "Hotel LSBP Heredado" } });
    await prisma.invoice.create({
      data: { id: `inv_lsbp_i_${RUN}`, propertyId: WITH_INVOICES, invoiceNumber: "FAC-2026-000001", invoiceType: "F1", customerType: "company", status: "issued", issuedAt: new Date("2026-03-01T10:00:00Z"), seriesCode: "FAC", legalEntityId: P_LE }
    });
    await prisma.invoice.create({
      data: { id: `inv_lsbp_l_${RUN}`, propertyId: LEGACY, invoiceNumber: "FAC-2026-000002", invoiceType: "F1", customerType: "company", status: "issued", issuedAt: new Date("2026-03-02T10:00:00Z"), seriesCode: "FAC" }
    });
    await prisma.invoice.create({ data: { id: `inv_lsbp_d_${RUN}`, propertyId: FREE, invoiceType: "F1", customerType: "company", status: "draft" } });
    await prisma.verifactuInstallation.create({
      data: { id: P_INST, legalEntityId: P_LE, propertyId: WITH_INSTALLATION, numeroInstalacion: `LSBP-${RUN}`, active: false, retiredAt: new Date("2026-03-01T00:00:00Z") }
    });
  });

  after(async () => {
    await cleanupPinned();
  });

  it("t6b#10: a centre with an issued invoice cannot move to the sociedad of another organisation (Prisma update or raw SQL; R10.1 fires first)", async () => {
    await assert.rejects(prisma.property.update({ where: { id: WITH_INVOICES }, data: { legalEntityId: P_SOLO_LE } }), R101);
    await assert.rejects(prisma.$executeRaw`UPDATE properties SET legal_entity_id = ${P_SOLO_LE} WHERE id = ${WITH_INVOICES}`, R101);
    assert.equal(await legalEntityOf(WITH_INVOICES), P_LE);
  });

  it("… nor to another sociedad of its own organisation, nor to NULL, nor to another organisation (R10.5)", async () => {
    await assert.rejects(prisma.property.update({ where: { id: WITH_INVOICES }, data: { legalEntityId: P_LE2 } }), R105);
    await assert.rejects(prisma.$executeRaw`UPDATE properties SET legal_entity_id = ${P_LE2} WHERE id = ${WITH_INVOICES}`, R105);
    await assert.rejects(prisma.$executeRaw`UPDATE properties SET legal_entity_id = NULL WHERE id = ${WITH_INVOICES}`, R105, "value → NULL is a change of sociedad too (no two-step bypass)");
    await assert.rejects(prisma.$executeRaw`UPDATE properties SET organization_id = ${P_SOLO_ORG} WHERE id = ${WITH_INVOICES}`, R101, "organisation-only change: the current sociedad no longer matches (R10.1 fires first)");
    await assert.rejects(prisma.$executeRaw`UPDATE properties SET organization_id = ${P_SOLO_ORG}, legal_entity_id = ${P_SOLO_LE} WHERE id = ${WITH_INVOICES}`, R105, "a consistent move to another organisation passes R10.1 and is still a move");
    await assert.rejects(prisma.$executeRaw`UPDATE properties SET organization_id = ${P_SOLO_ORG}, legal_entity_id = NULL WHERE id = ${WITH_INVOICES}`, R105, "moving with the sociedad cleared is still a move");
    assert.equal(await legalEntityOf(WITH_INVOICES), P_LE);
  });

  it("a centre with a RETIRED installation and no invoice is pinned as well (the number is never reused)", async () => {
    await assert.rejects(prisma.property.update({ where: { id: WITH_INSTALLATION }, data: { legalEntityId: P_LE2 } }), R105);
    await assert.rejects(prisma.property.update({ where: { id: WITH_INSTALLATION }, data: { legalEntityId: P_SOLO_LE } }), R101);
    await assert.rejects(prisma.$executeRaw`UPDATE properties SET organization_id = ${P_SOLO_ORG} WHERE id = ${WITH_INSTALLATION}`, R101);
    await assert.rejects(prisma.$executeRaw`UPDATE properties SET organization_id = ${P_SOLO_ORG}, legal_entity_id = ${P_SOLO_LE} WHERE id = ${WITH_INSTALLATION}`, R105);
    assert.equal(await legalEntityOf(WITH_INSTALLATION), P_LE);
  });

  it("other columns of a pinned centre stay writable, and writing the SAME sociedad is not a change", async () => {
    await prisma.property.update({ where: { id: WITH_INVOICES }, data: { tradeName: "Hotel LSBP Facturas by Test", kind: "hotel", code: "IN" } });
    // Same value in the SET list (Prisma writes the column): NEW IS NOT DISTINCT FROM OLD → allowed.
    await prisma.property.update({ where: { id: WITH_INVOICES }, data: { legalEntityId: P_LE } });
    assert.equal(await legalEntityOf(WITH_INVOICES), P_LE);
  });

  it("a centre with only a draft moves freely inside its organisation; a pre-backfill centre (NULL sociedad, issued invoice) is filled NULL → sociedad and pinned from then on", async () => {
    // FREE has a draft and no sociedad: the fill (NULL → P_LE) is the backfill / L2 path.
    await prisma.property.update({ where: { id: FREE }, data: { legalEntityId: P_LE } });
    assert.equal(await legalEntityOf(FREE), P_LE);
    // Drafts do not pin: value → NULL, another sociedad of the same organisation and back are allowed.
    await prisma.property.update({ where: { id: FREE }, data: { legalEntityId: null } });
    await prisma.property.update({ where: { id: FREE }, data: { legalEntityId: P_LE2 } });
    await prisma.property.update({ where: { id: FREE }, data: { legalEntityId: P_LE } });
    // LEGACY: issued invoice but NULL sociedad (a VPS row before the backfill) — the fill is allowed…
    assert.equal(await legalEntityOf(LEGACY), null);
    await prisma.property.update({ where: { id: LEGACY }, data: { legalEntityId: P_LE } });
    assert.equal(await legalEntityOf(LEGACY), P_LE);
    // …and from then on the centre is pinned (no two-step bypass through NULL).
    await assert.rejects(prisma.property.update({ where: { id: LEGACY }, data: { legalEntityId: null } }), R105);
    await assert.rejects(prisma.property.update({ where: { id: LEGACY }, data: { legalEntityId: P_LE2 } }), R105);
    assert.equal(await legalEntityOf(LEGACY), P_LE);
  });

  it("INSERT (R10.1): a property cannot be born in the sociedad of another organisation", async () => {
    await assert.rejects(prisma.property.create({ data: { id: `prop_lsbp_x_${RUN}`, organizationId: P_ORG, legalEntityId: P_SOLO_LE, name: "Hotel LSBP Foráneo" } }), R101);
    assert.equal(await prisma.property.count({ where: { id: `prop_lsbp_x_${RUN}` } }), 0);
  });

  it("UPDATE (R10.1): a free centre cannot be assigned to a foreign sociedad; a missing sociedad is the FK's error", async () => {
    await prisma.property.update({ where: { id: FREE }, data: { legalEntityId: null } });
    await assert.rejects(prisma.property.update({ where: { id: FREE }, data: { legalEntityId: P_SOLO_LE } }), R101);
    await assert.rejects(prisma.$executeRaw`UPDATE properties SET legal_entity_id = 'le_lsbp_missing' WHERE id = ${FREE}`, /foreign key/i);
    assert.equal(await legalEntityOf(FREE), null);
    await prisma.property.update({ where: { id: FREE }, data: { legalEntityId: P_LE } });
  });

  it("legal_entities_organizacion_inmutable: a sociedad never changes organisation; its other columns stay writable", async () => {
    await assert.rejects(prisma.$executeRaw`UPDATE legal_entities SET organization_id = ${P_SOLO_ORG} WHERE id = ${P_LE}`, /no puede cambiar de organización/);
    assert.equal((await prisma.legalEntity.findUniqueOrThrow({ where: { id: P_LE } })).organizationId, P_ORG);
    await prisma.legalEntity.update({ where: { id: P_LE }, data: { legalName: "LSBP Hotels SA (editada)" } });
  });
});
