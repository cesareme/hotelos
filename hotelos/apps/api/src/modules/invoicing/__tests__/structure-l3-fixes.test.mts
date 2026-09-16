// Estructura societaria · L3 · fix lot (t6b#1, t6b#2, t6b#11). Pure-core unit
// tests, no database:
//   · t6b#2  SII exclusion: verifactuExclusionFor / verifactuExclusionWarning,
//            the exclusion frozen in the structure snapshot (no installation),
//            structureFromSnapshotJson reading it back, the PDF printing the
//            reason instead of the QR / VERI*FACTU legend;
//   · t6b#11 one issuer per series keyed by the printed PREFIX
//            (findSeriesIssuerTaxId over an in-memory client), the 409 message
//            pointing to Estructura societaria and the two remedies, and the
//            helper the PATCH of the NIF uses to warn about blocked series;
//   · t6b#1  lock keys of the series opening / invoice number (pure).
// Run from apps/api with
//   node --import tsx --test src/modules/invoicing/__tests__/structure-l3-fixes.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { VERIFACTU_EXCLUDED_BY_SII_CODE, VERIFACTU_EXCLUDED_BY_SII_MOTIVO } from "@hotelos/compliance";
import {
  composeIssuerIdentity,
  LEGAL_IDENTITY_SCREEN,
  SERIES_SCREEN,
  verifactuExclusionFor,
  verifactuExclusionWarning,
  WORK_CENTERS_SCREEN
} from "../issuer-identity.service.js";
import {
  findSeriesBlockedByTaxIdChange,
  findSeriesIssuerTaxId,
  invoiceNumberBelongsToPrefix,
  invoiceNumberLockKey,
  issuerSeriesMismatchError,
  seriesBlockedByTaxIdChangeWarning,
  seriesClosedError,
  seriesOpeningLockKey,
  structureFromSnapshotJson,
  structureSnapshot,
  workCenterCodeRequiredError
} from "../invoice.service.js";
import { buildInvoicePdf, type InvoicePdfModel } from "../invoice-pdf.service.js";
import { ConflictError } from "../../../lib/http-error.js";
import type { LegalIdentity } from "../../../lib/finance-scope.js";
import type { VerifactuChainScope } from "../issuer-identity.service.js";

const ENTITY: LegalIdentity = {
  legalEntityId: "le_far",
  organizationId: "org_far",
  code: "FAR",
  legalName: "CELUISMA S.A.",
  taxId: "A58818501",
  taxIdValid: true,
  source: "legal_entity",
  legalForm: "sa",
  fiscalAddress: "Calle Portugal 7",
  fiscalPostalCode: "33207",
  fiscalMunicipality: "Gijón",
  fiscalIneCode: "33024",
  fiscalProvince: "Asturias",
  pgcVariant: "general",
  largeCompany: false,
  siiEnabled: false,
  verifactuChainScope: "per_center",
  cccPrincipal: null
};

const RIAS_ALTAS = {
  id: "prop_ra",
  organizationId: "org_far",
  legalEntityId: "le_far",
  name: "Faranda Rías Altas",
  code: "RA",
  tradeName: "Hotel Faranda Rías Altas",
  kind: "hotel" as const,
  address: "Paseo Marítimo 1",
  postalCode: "15172",
  municipality: "Perillo (Oleiros)",
  province: "A Coruña",
  country: "ES",
  taxRegion: "ES_PENINSULA_BALEARES",
  invoiceLogoUrl: null,
  invoiceLegalFooter: null
};

const INSTALLATION: NonNullable<VerifactuChainScope["installation"]> = {
  id: "vfi_ra",
  legalEntityId: "le_far",
  propertyId: "prop_ra",
  numeroInstalacion: "FAR-RA-0001",
  route: "verifactu",
  territory: null
};

function codeOf(error: unknown): string | undefined {
  return (error as { details?: { code?: string } }).details?.code;
}

// ── t6b#2 · SII exclusion ────────────────────────────────────────────────────

describe("verifactuExclusionFor — LegalEntity.siiEnabled is the one switch that takes the sociedad out of the RRSIF (R7/R8)", () => {
  it("null when VeriFactu applies; the typed SII exclusion with the shared motivo otherwise", () => {
    assert.equal(verifactuExclusionFor({ siiEnabled: false }), null);
    assert.deepEqual(verifactuExclusionFor({ siiEnabled: true }), { code: VERIFACTU_EXCLUDED_BY_SII_CODE, motivo: VERIFACTU_EXCLUDED_BY_SII_MOTIVO });
    assert.equal(VERIFACTU_EXCLUDED_BY_SII_CODE, "VERIFACTU_EXCLUDED_BY_SII");
    assert.match(VERIFACTU_EXCLUDED_BY_SII_MOTIVO, /RD 1007\/2023 art\. 3\.3/);
  });

  it("the issuer identity of a SII sociedad carries siiEnabled and the exclusion; a regular sociedad carries null", () => {
    const regular = composeIssuerIdentity(ENTITY, RIAS_ALTAS);
    assert.equal(regular.siiEnabled, false);
    assert.equal(regular.verifactuExclusion, null);
    const sii = composeIssuerIdentity({ ...ENTITY, siiEnabled: true }, RIAS_ALTAS);
    assert.equal(sii.siiEnabled, true);
    assert.equal(sii.verifactuExclusion?.code, "VERIFACTU_EXCLUDED_BY_SII");
    assert.equal(sii.taxId, "A58818501", "the exclusion never touches the issuer identity itself");
  });

  it("the persisted warning starts with the typed code and says what the document lacks", () => {
    const warning = verifactuExclusionWarning(verifactuExclusionFor({ siiEnabled: true })!);
    assert.ok(warning.startsWith("VERIFACTU_EXCLUDED_BY_SII: "));
    assert.match(warning, /sin huella, sin registro de facturación ni código QR tributario/);
  });

  it("structureSnapshot freezes the exclusion and drops the installation (no record, no chain); structureFromSnapshotJson reads it back", () => {
    const sii = composeIssuerIdentity({ ...ENTITY, siiEnabled: true }, RIAS_ALTAS);
    const frozen = structureSnapshot(sii, { legalEntityId: "le_far", installation: INSTALLATION });
    assert.equal(frozen.installationId, null);
    assert.equal(frozen.numeroInstalacion, null);
    assert.equal(frozen.legalEntityId, "le_far");
    assert.deepEqual(frozen.verifactuExclusion, { code: "VERIFACTU_EXCLUDED_BY_SII", motivo: VERIFACTU_EXCLUDED_BY_SII_MOTIVO });
    assert.deepEqual(structureFromSnapshotJson({ version: 1, ...frozen }), frozen);

    const regular = structureSnapshot(composeIssuerIdentity(ENTITY, RIAS_ALTAS), { legalEntityId: "le_far", installation: INSTALLATION });
    assert.equal(regular.installationId, "vfi_ra");
    assert.equal(regular.verifactuExclusion, null);
    assert.equal(structureFromSnapshotJson({ version: 1, ...regular }).verifactuExclusion, null);
    // A snapshot written before the key: undefined (the cancel path then asks the live sociedad).
    assert.equal("verifactuExclusion" in structureFromSnapshotJson({ version: 1, establishment: regular.establishment }), false);
    // Garbage in the key is ignored, never trusted as an exclusion.
    assert.equal("verifactuExclusion" in structureFromSnapshotJson({ version: 1, verifactuExclusion: { code: "OTHER", motivo: "x" } }), false);
  });
});

describe("buildInvoicePdf — a document of a SII sociedad prints the reason, never a QR nor VERI*FACTU", () => {
  const base: InvoicePdfModel = {
    invoiceId: "inv_1",
    invoiceNumber: "FAC-RA-2026-000001",
    invoiceType: "F1",
    status: "issued",
    issuedAt: "2026-09-16T10:00:00.000Z",
    cancelledAt: null,
    simplified: false,
    currencyCode: "EUR",
    issuer: { legalName: "CELUISMA S.A.", taxId: "A58818501", address: "Calle Portugal 7, 33207 Gijón, Asturias", propertyName: "Faranda Rías Altas", placeholder: false, legalFooter: null, fiscalAddress: "Calle Portugal 7, 33207 Gijón, Asturias", establishment: { code: "RA", tradeName: "Hotel Faranda Rías Altas", addressLine: "Paseo Marítimo 1, 15172 Perillo (Oleiros), A Coruña" } },
    customer: { type: "company", name: "Cliente SL", taxId: "B12345674" },
    lines: [{ description: "Alojamiento", quantity: 1, unitPrice: 110, taxRate: 10, calificacion: "S1", total: 110 }],
    breakdown: [{ figure: "IVA", calificacion: "S1", ratePercent: 10, base: 100, quota: 10 }],
    totals: { base: 100, tax: 10, total: 110 },
    rectification: null,
    payment: null,
    qrUrl: null,
    verifactuHash: null,
    stay: null,
    warnings: []
  };

  it("issued without record: «Sin QR tributario: <motivo>» and no VERI*FACTU legend", () => {
    const out = buildInvoicePdf({ ...base, verifactuExclusion: { code: "VERIFACTU_EXCLUDED_BY_SII", motivo: VERIFACTU_EXCLUDED_BY_SII_MOTIVO } }).toString("latin1");
    assert.ok(out.includes("Sin QR tributario: Sociedad acogida al SII"), "reason printed");
    assert.ok(!out.includes("VERI*FACTU"), "no VERI*FACTU legend");
    assert.ok(!out.includes("sin registro VeriFactu"), "not the generic legacy line");
  });

  it("cancelled without record: the ANULADO line does not claim a VeriFactu anulación", () => {
    const out = buildInvoicePdf({ ...base, status: "cancelled", cancelledAt: "2026-09-17T10:00:00.000Z", verifactuExclusion: { code: "VERIFACTU_EXCLUDED_BY_SII", motivo: VERIFACTU_EXCLUDED_BY_SII_MOTIVO } }).toString("latin1");
    assert.ok(out.includes("ANULADO"));
    assert.ok(!out.includes("Registro de anulaci"), "no anulación communicated");
  });

  it("a regular document without QR keeps the legacy line", () => {
    const out = buildInvoicePdf(base).toString("latin1");
    assert.ok(out.includes("sin registro VeriFactu"));
  });
});

// ── t6b#11 · one issuer per series keyed by the printed prefix ───────────────

type InvoiceRow = { id: string; propertyId: string; invoiceNumber: string | null; issuerTaxId: string | null; issuerTaxIdPlaceholder: boolean; issuedAt: Date | null; deletedAt: Date | null };

function invoiceDb(rows: InvoiceRow[]) {
  return {
    invoice: {
      async findMany(args: { where: { propertyId: string; invoiceNumber: { startsWith: string }; issuerTaxIdPlaceholder: boolean }; take: number }) {
        return rows
          .filter((r) => r.propertyId === args.where.propertyId && r.deletedAt === null && r.issuedAt !== null && r.issuerTaxId !== null && r.issuerTaxIdPlaceholder === false)
          .filter((r) => (r.invoiceNumber ?? "").startsWith(args.where.invoiceNumber.startsWith))
          .sort((a, b) => b.issuedAt!.getTime() - a.issuedAt!.getTime() || (b.id < a.id ? -1 : 1))
          .slice(0, args.take)
          .map((r) => ({ issuerTaxId: r.issuerTaxId, invoiceNumber: r.invoiceNumber }));
      }
    }
  };
}

const issued = (id: string, propertyId: string, invoiceNumber: string, issuerTaxId: string, at: string, placeholder = false): InvoiceRow => ({ id, propertyId, invoiceNumber, issuerTaxId, issuerTaxIdPlaceholder: placeholder, issuedAt: new Date(at), deletedAt: null });

describe("findSeriesIssuerTaxId — the series is its printed prefix, not `${series}-…-${year}-`", () => {
  it("invoiceNumberBelongsToPrefix: prefix + digits only", () => {
    assert.equal(invoiceNumberBelongsToPrefix("FAC-2026-000001", "FAC-2026-"), true);
    assert.equal(invoiceNumberBelongsToPrefix("FAC-2026-B-000001", "FAC-2026-"), false, "another series that merely starts alike");
    assert.equal(invoiceNumberBelongsToPrefix("FAC-RA-2026-000001", "FAC-2026-"), false);
    assert.equal(invoiceNumberBelongsToPrefix(null, "FAC-2026-"), false);
  });

  it("the old sandbox series FAC-2026- (other NIF) does not block the new FAC-RA-2026- of the same centre and year", async () => {
    const db = invoiceDb([
      issued("i1", "prop_ra", "FAC-2026-000021", "B99999997", "2026-03-01T10:00:00Z"),
      issued("i2", "prop_ra", "FAC-2026-000022", "B99999997", "2026-04-01T10:00:00Z")
    ]) as unknown as Parameters<typeof findSeriesIssuerTaxId>[0];
    assert.deepEqual(await findSeriesIssuerTaxId(db, "prop_ra", "FAC-2026-"), { taxId: "B99999997", invoiceNumber: "FAC-2026-000022" });
    assert.equal(await findSeriesIssuerTaxId(db, "prop_ra", "FAC-RA-2026-"), null, "a series with another prefix has its own issuer");
    assert.equal(await findSeriesIssuerTaxId(db, "prop_ra", ""), null);
  });

  it("placeholder-era invoices are ignored; the newest real NIF of the prefix wins", async () => {
    const db = invoiceDb([
      issued("i1", "prop_ra", "FAC-2026-000001", "B00000000", "2026-01-01T10:00:00Z", true),
      issued("i2", "prop_ra", "FAC-2026-000002", "B12345674", "2026-02-01T10:00:00Z"),
      issued("i3", "prop_ra", "FAC-2026-000003", "A58818501", "2026-03-01T10:00:00Z"),
      issued("i4", "prop_lt", "FAC-2026-000004", "B99999997", "2026-04-01T10:00:00Z")
    ]) as unknown as Parameters<typeof findSeriesIssuerTaxId>[0];
    assert.deepEqual(await findSeriesIssuerTaxId(db, "prop_ra", "FAC-2026-"), { taxId: "A58818501", invoiceNumber: "FAC-2026-000003" });
  });
});

describe("issuerSeriesMismatchError — 409 that names the prefix, the law and the two real remedies (t6b#11)", () => {
  it("points to Datos fiscales (wrong NIF → rectificativas) and to Series y VeriFactu (new issuer → close the series, open another prefix); never to the old profile screen", () => {
    const error = issuerSeriesMismatchError({ series: "FAC", year: 2026, prefix: "FAC-RA-2026-", seriesTaxId: "B99999997", currentTaxId: "A58818501", lastInvoiceNumber: "FAC-RA-2026-000002" });
    assert.ok(error instanceof ConflictError);
    assert.equal(codeOf(error), "ISSUER_TAX_ID_SERIES_MISMATCH");
    assert.match(error.message, /La serie FAC-RA-2026- ya tiene facturas emitidas con el NIF B99999997 \(última: FAC-RA-2026-000002\)/);
    assert.match(error.message, /RD 1619\/2012 art\. 6\.1\.a/);
    assert.match(error.message, /rectificativas \(art\. 15\)/);
    assert.ok(error.message.includes(LEGAL_IDENTITY_SCREEN));
    assert.ok(error.message.includes(SERIES_SCREEN));
    assert.match(error.message, /nunca se renumera/);
    assert.ok(!error.message.includes("Perfil del establecimiento"), "the profile no longer edits the NIF (L2)");
    const details = error.details as Record<string, unknown>;
    assert.equal(details.prefix, "FAC-RA-2026-");
    assert.equal(details.legalIdentityScreen, LEGAL_IDENTITY_SCREEN);
    assert.equal(details.seriesScreen, SERIES_SCREEN);
    assert.equal(details.currentTaxId, "A58818501");
  });
});

describe("findSeriesBlockedByTaxIdChange — what the PATCH of the sociedad's NIF must warn about", () => {
  const properties = [
    { id: "prop_ra", legalEntityId: "le_far", organizationId: "org_far" },
    { id: "prop_lt", legalEntityId: "le_far", organizationId: "org_far" },
    { id: "prop_other", legalEntityId: "le_other", organizationId: "org_other" }
  ];
  const sequences = [
    { id: "seq_ra_fac", propertyId: "prop_ra", sequenceCode: "FAC", prefix: "FAC-RA-2026-", year: 2026, active: true },
    { id: "seq_ra_rec", propertyId: "prop_ra", sequenceCode: "REC", prefix: "REC-RA-2026-", year: 2026, active: true },
    { id: "seq_ra_old", propertyId: "prop_ra", sequenceCode: "FAC", prefix: "FAC-2026-", year: null, active: false },
    { id: "seq_lt_fac", propertyId: "prop_lt", sequenceCode: "FAC", prefix: "FAC-LT-2026-", year: 2026, active: true },
    { id: "seq_other", propertyId: "prop_other", sequenceCode: "FAC", prefix: "FAC-2026-", year: 2026, active: true }
  ];
  function db(rows: InvoiceRow[]) {
    return {
      ...invoiceDb(rows),
      property: {
        async findMany(args: { where: { legalEntityId?: string; organizationId?: string } }) {
          return properties.filter((p) => (args.where.legalEntityId ? p.legalEntityId === args.where.legalEntityId : p.organizationId === args.where.organizationId)).map((p) => ({ id: p.id }));
        }
      },
      invoiceSequence: {
        async findMany(args: { where: { propertyId: { in: string[] }; active: boolean } }) {
          return sequences.filter((s) => args.where.propertyId.in.includes(s.propertyId) && s.active === args.where.active && s.prefix !== null);
        }
      }
    } as unknown as Parameters<typeof findSeriesBlockedByTaxIdChange>[1];
  }

  it("lists the active series whose invoices carry another NIF; closed series, sister-centre series without invoices and other sociedades are left out", async () => {
    const rows = [
      issued("i1", "prop_ra", "FAC-RA-2026-000001", "B99999997", "2026-03-01T10:00:00Z"),
      issued("i2", "prop_ra", "FAC-RA-2026-000002", "B99999997", "2026-04-01T10:00:00Z"),
      issued("i3", "prop_ra", "FAC-2026-000021", "B12345674", "2026-01-01T10:00:00Z"),
      issued("i4", "prop_other", "FAC-2026-000001", "B12345674", "2026-01-01T10:00:00Z")
    ];
    const blocked = await findSeriesBlockedByTaxIdChange({ organizationId: "org_far", legalEntityId: "le_far", nextTaxId: "a58818501" }, db(rows));
    assert.deepEqual(blocked, [
      { propertyId: "prop_ra", sequenceId: "seq_ra_fac", series: "FAC", prefix: "FAC-RA-2026-", year: 2026, seriesTaxId: "B99999997", lastInvoiceNumber: "FAC-RA-2026-000002" }
    ]);
    // Same NIF → nothing is blocked.
    assert.deepEqual(await findSeriesBlockedByTaxIdChange({ organizationId: "org_far", legalEntityId: "le_far", nextTaxId: "B99999997" }, db(rows)), []);
    // Clearing the NIF blocks every series with invoices.
    assert.equal((await findSeriesBlockedByTaxIdChange({ organizationId: "org_far", legalEntityId: "le_far", nextTaxId: null }, db(rows))).length, 1);
    // Tenant without a backfilled legal entity: scoped by organization.
    assert.equal((await findSeriesBlockedByTaxIdChange({ organizationId: "org_other", nextTaxId: "A58818501" }, db(rows)))[0]?.sequenceId, "seq_other");
  });

  it("the warning names the series, the old NIF, the last number and the remedy", () => {
    const warning = seriesBlockedByTaxIdChangeWarning({ propertyId: "prop_ra", sequenceId: "seq_ra_fac", series: "FAC", prefix: "FAC-RA-2026-", year: 2026, seriesTaxId: "B99999997", lastInvoiceNumber: "FAC-RA-2026-000002" }, "A58818501");
    assert.match(warning, /FAC-RA-2026- \(2026\)/);
    assert.match(warning, /B99999997/);
    assert.match(warning, /ISSUER_TAX_ID_SERIES_MISMATCH/);
    assert.ok(warning.includes(SERIES_SCREEN));
  });
});

// ── t6b#1 · lock keys and typed refusals ─────────────────────────────────────

describe("series-opening and invoice-number lock keys (pure)", () => {
  it("are keyed by the sociedad (organization before the backfill) and, for numbers, case-insensitive", () => {
    assert.equal(seriesOpeningLockKey({ legalEntityId: "le_far", organizationId: "org_far" }, 2026), "series-open:entity:le_far:2026");
    assert.equal(seriesOpeningLockKey({ legalEntityId: null, organizationId: "org_123" }, 2026), "series-open:org:org_123:2026");
    assert.equal(invoiceNumberLockKey({ legalEntityId: "le_far", organizationId: "org_far" }, " fac-ra-2026-000001 "), "invoice-number:entity:le_far:FAC-RA-2026-000001");
  });

  it("workCenterCodeRequiredError and seriesClosedError carry the typed code and the screen", () => {
    const code = workCenterCodeRequiredError({ propertyId: "prop_n2", series: "FAC", year: 2026, billingCentres: 2 });
    assert.equal(codeOf(code), "WORK_CENTER_CODE_REQUIRED");
    assert.ok(code.message.includes(WORK_CENTERS_SCREEN));
    assert.match(code.message, /FAC-<código>-2026-/);
    const closed = seriesClosedError({ propertyId: "prop_ra", series: "FAC", year: 2026, prefix: "FAC-RA-2026-", sequenceId: "seq" });
    assert.equal(codeOf(closed), "SERIES_CLOSED");
    assert.ok(closed.message.includes(SERIES_SCREEN));
    assert.match(closed.message, /nunca se renumera/);
  });
});
