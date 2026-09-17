// Estructura societaria · L3 (facturación: identidad, series, instalaciones).
// Pure-core unit tests, no database: identity composition (sociedad +
// establishment, never Property.legalName), R3 conditional prefix and clash
// guard inside allocateInvoiceNumber (in-memory transaction), the duplicate
// number safety net, chain scope helpers (lock key, chain filter), the
// SistemaInformatico block from a declared installation (env only as sandbox
// fallback; readiness error in real modes), the TBAI device serial and the
// PDF header with «Establecimiento». Run from apps/api with
//   node --import tsx --test src/modules/invoicing/__tests__/structure-l3-invoicing.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildTbaiXml, resolveVerifactuSoftware, VERIFACTU_INSTALLATION_NOT_DECLARED_CODE, VERIFACTU_SOFTWARE_DEFAULTS } from "@hotelos/compliance";
import {
  chainInvoiceWhere,
  composeIssuerIdentity,
  establishmentFromProperty,
  formatAddressLine,
  formatFiscalAddress,
  issuerTaxIdMissingMessage,
  LEGAL_IDENTITY_SCREEN,
  verifactuChainLockKey,
  type VerifactuChainScope
} from "../issuer-identity.service.js";
import {
  allocateInvoiceNumber,
  assertInvoiceNumberFreeInEntity,
  countBillingCentres,
  INVOICE_NUMBER_DUPLICATE_CODE,
  invoiceNumberLockKey,
  legacySeriesClashWarning,
  SERIES_CLOSED_CODE,
  seriesOpeningLockKey,
  structureFromSnapshotJson,
  structureSnapshot,
  WORK_CENTER_CODE_REQUIRED_CODE,
  type InvoiceSequenceTx,
  type SeriesScope
} from "../invoice.service.js";
import { resolveSoftwareForSend } from "../verifactu-submission.service.js";
import { resolveTbaiSoftware } from "../tbai-submission.service.js";
import { buildInvoicePdf, establishmentLine, type InvoicePdfModel } from "../invoice-pdf.service.js";
import { ConflictError } from "../../../lib/http-error.js";
import type { LegalIdentity } from "../../../lib/finance-scope.js";

// ── Fixtures ─────────────────────────────────────────────────────────────────

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
  tradeName: "Hotel Faranda Rías Altas by Ascend Collection",
  kind: "hotel" as const,
  address: "Paseo Marítimo 1",
  postalCode: "15172",
  municipality: "Perillo (Oleiros)",
  province: "A Coruña",
  country: "ES",
  taxRegion: "ES_PENINSULA_BALEARES",
  invoiceLogoUrl: null,
  invoiceLegalFooter: "Inscrita en el RM de Gijón."
};

const COMPLETE_ENV: NodeJS.ProcessEnv = {
  VERIFACTU_SOFTWARE_NAME: "Anfitorio Software SL",
  VERIFACTU_SOFTWARE_NIF: "B12345674",
  VERIFACTU_SYSTEM_NAME: "ehotelOS",
  VERIFACTU_SYSTEM_ID: "01",
  VERIFACTU_SYSTEM_VERSION: "1.4.0",
  VERIFACTU_INSTALL_NUMBER: "VPS-HOSTINGER-001",
  VERIFACTU_MULTI_OT: "S"
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

// ── R2 · issuer identity = sociedad + establishment ──────────────────────────

describe("composeIssuerIdentity — the issuer is the sociedad, the property is the establishment (R2)", () => {
  it("takes NIF, razón social and domicilio fiscal from the legal entity and never a property name as razón social", () => {
    const identity = composeIssuerIdentity(ENTITY, RIAS_ALTAS);
    assert.equal(identity.legalName, "CELUISMA S.A.");
    assert.equal(identity.taxId, "A58818501");
    assert.equal(identity.taxIdValid, true);
    assert.equal(identity.taxIdSource, "legal_entity");
    assert.equal(identity.identitySource, "legal_entity");
    assert.equal(identity.legalEntityId, "le_far");
    assert.equal(identity.fiscalAddress, "Calle Portugal 7, 33207 Gijón, Asturias");
    assert.equal(identity.verifactuChainScope, "per_center");
    assert.notEqual(identity.legalName, RIAS_ALTAS.tradeName, "the trade name is never the razón social");
  });

  it("builds the establishment block: code, nombre comercial (tradeName ?? name), address line", () => {
    const { establishment } = composeIssuerIdentity(ENTITY, RIAS_ALTAS);
    assert.deepEqual(establishment, {
      propertyId: "prop_ra",
      code: "RA",
      name: "Faranda Rías Altas",
      tradeName: "Hotel Faranda Rías Altas by Ascend Collection",
      kind: "hotel",
      address: "Paseo Marítimo 1",
      postalCode: "15172",
      municipality: "Perillo (Oleiros)",
      province: "A Coruña",
      country: "ES",
      addressLine: "Paseo Marítimo 1, 15172 Perillo (Oleiros), A Coruña"
    });
    const plain = establishmentFromProperty({ ...RIAS_ALTAS, tradeName: null, code: null, address: null, postalCode: null, municipality: null, province: null });
    assert.equal(plain.tradeName, "Faranda Rías Altas", "without a trade name the property name is printed");
    assert.equal(plain.code, null);
    assert.equal(plain.addressLine, null);
  });

  it("keeps `address` as the establishment line for callers that predate the block", () => {
    const identity = composeIssuerIdentity(ENTITY, RIAS_ALTAS);
    assert.equal(identity.address, identity.establishment.addressLine);
  });

  it("falls back to the deprecated organization columns only through resolveLegalIdentity (source organization_fallback)", () => {
    const fallback: LegalIdentity = { ...ENTITY, legalEntityId: null, code: null, source: "organization_fallback", fiscalAddress: null, fiscalPostalCode: null, fiscalMunicipality: null, fiscalProvince: null };
    const identity = composeIssuerIdentity(fallback, { ...RIAS_ALTAS, legalEntityId: null });
    assert.equal(identity.taxIdSource, "organization");
    assert.equal(identity.identitySource, "organization_fallback");
    assert.equal(identity.legalEntityId, null);
    assert.equal(identity.fiscalAddress, null);
    const missing = composeIssuerIdentity({ ...fallback, taxId: null, taxIdValid: false }, { ...RIAS_ALTAS, legalEntityId: null });
    assert.equal(missing.taxIdSource, "missing");
    assert.equal(missing.taxIdValid, false);
  });

  it("formatAddressLine prints each segment once (municipality = province) and null when nothing is known", () => {
    assert.equal(formatAddressLine({ address: "Rúa Real 1", postalCode: "15003", municipality: "A Coruña", province: "A Coruña" }), "Rúa Real 1, 15003 A Coruña");
    assert.equal(formatAddressLine({ address: "  ", postalCode: null, municipality: null, province: null }), null);
    assert.equal(formatFiscalAddress({ fiscalAddress: null, fiscalPostalCode: null, fiscalMunicipality: "Madrid", fiscalProvince: "Madrid" }), "Madrid");
  });

  it("the ISSUER_TAX_ID_MISSING message points to Estructura societaria › Datos fiscales", () => {
    assert.match(issuerTaxIdMissingMessage({ taxId: null }), new RegExp(LEGAL_IDENTITY_SCREEN.replace(/[›]/g, "›")));
    assert.match(issuerTaxIdMissingMessage({ taxId: "B99999999" }), /no es válido/);
  });
});

// ── R7 · chain scope helpers ─────────────────────────────────────────────────

describe("VeriFactu chain scope — lock key and chain filter follow the installation (R7)", () => {
  it("lock key: installation when declared; sociedad for per_entity without one; the centre (pre-6b key) otherwise", () => {
    assert.equal(verifactuChainLockKey({ propertyId: "prop_ra", legalEntityId: "le_far", policy: "per_center", installation: INSTALLATION }), "installation:vfi_ra");
    assert.equal(verifactuChainLockKey({ propertyId: "prop_ra", legalEntityId: "le_far", policy: "per_entity", installation: null }), "entity:le_far");
    assert.equal(verifactuChainLockKey({ propertyId: "prop_ra", legalEntityId: "le_far", policy: "per_center", installation: null }), "prop_ra");
    assert.equal(verifactuChainLockKey({ propertyId: "prop_ra", legalEntityId: null, policy: "per_entity", installation: null }), "prop_ra");
  });

  it("chain filter: records of the installation plus the unlinked records of its centres; records of a retired installation are excluded", () => {
    assert.deepEqual(chainInvoiceWhere({ installation: INSTALLATION, propertyIds: ["prop_ra"] }), {
      OR: [{ installationId: "vfi_ra" }, { installationId: null, propertyId: { in: ["prop_ra"] } }]
    });
    assert.deepEqual(chainInvoiceWhere({ installation: null, propertyIds: ["prop_ra", "prop_lt"] }), { propertyId: { in: ["prop_ra", "prop_lt"] } });
  });

  it("structureSnapshot freezes establishment, fiscal address and installation; structureFromSnapshotJson reads them back (legacy snapshot → {})", () => {
    const identity = composeIssuerIdentity(ENTITY, RIAS_ALTAS);
    const frozen = structureSnapshot(identity, { legalEntityId: "le_far", installation: INSTALLATION });
    assert.equal(frozen.numeroInstalacion, "FAR-RA-0001");
    assert.equal(frozen.installationId, "vfi_ra");
    assert.equal(frozen.issuerFiscalAddress, "Calle Portugal 7, 33207 Gijón, Asturias");
    const back = structureFromSnapshotJson({ version: 1, status: "issued", lines: [], totals: {}, taxBreakdown: [], ...frozen });
    assert.deepEqual(back, frozen);
    assert.deepEqual(structureFromSnapshotJson({ version: 1, status: "issued" }), {});
    assert.deepEqual(structureFromSnapshotJson(null), {});
  });
});

// ── R3 · conditional prefix, clash guard, duplicate number ───────────────────

type SequenceRow = { id: string; propertyId: string; sequenceCode: string; prefix: string | null; nextNumber: number; padding: number; invoiceType: string; active: boolean; year: number | null; legalEntityId?: string | null };
type PropertyRow = { id: string; organizationId: string; legalEntityId: string | null; code: string | null; kind: string };

function structureTx(properties: PropertyRow[], rows: SequenceRow[]): { tx: InvoiceSequenceTx; rows: SequenceRow[]; calls: string[] } {
  const calls: string[] = [];
  let counter = 0;
  const invoiceSequence = {
    async findFirst(args: { where: { propertyId: string; sequenceCode: string; year: number | null } }) {
      calls.push("seq.findFirst");
      return rows.filter((r) => r.propertyId === args.where.propertyId && r.sequenceCode === args.where.sequenceCode && r.year === args.where.year).sort((a, b) => b.nextNumber - a.nextNumber)[0] ?? null;
    },
    async findUnique(args: { where: { propertyId_sequenceCode_year: { propertyId: string; sequenceCode: string; year: number } } }) {
      calls.push("seq.findUnique");
      const key = args.where.propertyId_sequenceCode_year;
      return rows.find((r) => r.propertyId === key.propertyId && r.sequenceCode === key.sequenceCode && r.year === key.year) ?? null;
    },
    async findMany(args: { where: { propertyId: { in: string[] }; active: boolean } }) {
      calls.push("seq.findMany");
      return rows.filter((r) => args.where.propertyId.in.includes(r.propertyId) && r.active === args.where.active);
    },
    async update(args: { where: { id: string }; data: { year?: number; nextNumber?: { increment: number }; legalEntityId?: string } }) {
      calls.push("seq.update");
      const row = rows.find((r) => r.id === args.where.id)!;
      if (args.data.year !== undefined) row.year = args.data.year;
      if (args.data.nextNumber?.increment) row.nextNumber += args.data.nextNumber.increment;
      if (args.data.legalEntityId !== undefined) row.legalEntityId = args.data.legalEntityId;
      return { ...row };
    },
    async create(args: { data: Omit<SequenceRow, "id" | "active"> }) {
      calls.push("seq.create");
      const created: SequenceRow = { id: `seq_${++counter}`, active: true, ...args.data };
      rows.push(created);
      return { ...created };
    }
  };
  const property = {
    async findUnique(args: { where: { id: string } }) {
      calls.push("prop.findUnique");
      return properties.find((p) => p.id === args.where.id) ?? null;
    },
    async findMany(args: { where: { legalEntityId?: string; organizationId?: string; id: { not: string } } }) {
      calls.push("prop.findMany");
      return properties
        .filter((p) => p.id !== args.where.id.not)
        .filter((p) => (args.where.legalEntityId ? p.legalEntityId === args.where.legalEntityId : p.organizationId === args.where.organizationId))
        .map((p) => ({ id: p.id, kind: p.kind }));
    }
  };
  // Series-opening advisory lock (fix t6b#1): recorded with its key, no database.
  const $executeRaw = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push(`lock:${String(values[0] ?? "")}`);
    return 0;
  };
  return { tx: { invoiceSequence, property, $executeRaw } as unknown as InvoiceSequenceTx, rows, calls };
}

const RA: PropertyRow = { id: "prop_ra", organizationId: "org_far", legalEntityId: "le_far", code: "RA", kind: "hotel" };
const LT: PropertyRow = { id: "prop_lt", organizationId: "org_far", legalEntityId: "le_far", code: "LT", kind: "hotel" };
const OC: PropertyRow = { id: "prop_oc", organizationId: "org_far", legalEntityId: "le_far", code: "OC", kind: "office" };
const SOLO: PropertyRow = { id: "prop_solo", organizationId: "org_solo", legalEntityId: "le_solo", code: "AMC", kind: "hotel" };
const ISSUED_AT = new Date("2026-09-16T10:00:00.000Z");

describe("allocateInvoiceNumber — R3 conditional prefix and SERIES_PREFIX_CLASH", () => {
  it("a single hotel keeps FAC-<año>- (zero change for hotel individual and new tenants)", async () => {
    const { tx, rows } = structureTx([SOLO], []);
    const result = await allocateInvoiceNumber(tx, { propertyId: SOLO.id, series: "FAC", issuedAt: ISSUED_AT });
    assert.equal(result.invoiceNumber, "FAC-2026-000001");
    assert.equal(result.prefix, "FAC-2026-");
    assert.equal(result.created, true);
    assert.equal(result.legalEntityId, "le_solo");
    assert.equal(rows[0]!.legalEntityId, "le_solo", "the new series row is linked to the sociedad");
    assert.deepEqual(result.scope, { propertyId: "prop_solo", organizationId: "org_solo", legalEntityId: "le_solo", propertyCode: "AMC", siblingPropertyIds: [], billingCentres: 1 });
  });

  it("two hotels under one NIF open FAC-RA-2026- and FAC-LT-2026- without touching each other", async () => {
    const { tx } = structureTx([RA, LT], []);
    const ra = await allocateInvoiceNumber(tx, { propertyId: RA.id, series: "FAC", issuedAt: ISSUED_AT });
    const lt = await allocateInvoiceNumber(tx, { propertyId: LT.id, series: "FAC", issuedAt: ISSUED_AT });
    assert.equal(ra.invoiceNumber, "FAC-RA-2026-000001");
    assert.equal(lt.invoiceNumber, "FAC-LT-2026-000001");
    assert.deepEqual(ra.warnings, []);
    assert.deepEqual(lt.warnings, []);
    const ra2 = await allocateInvoiceNumber(tx, { propertyId: RA.id, series: "FAC", issuedAt: ISSUED_AT });
    assert.equal(ra2.invoiceNumber, "FAC-RA-2026-000002");
    assert.equal(ra2.created, false);
  });

  it("an office without series is not a billing centre; with an active series it is", async () => {
    const { tx } = structureTx([RA, OC], []);
    const ra = await allocateInvoiceNumber(tx, { propertyId: RA.id, series: "FAC", issuedAt: ISSUED_AT });
    assert.equal(ra.prefix, "FAC-2026-", "hotel + office without series = one billing centre");
    const { tx: tx2 } = structureTx([RA, OC], [{ id: "seq_oc", propertyId: OC.id, sequenceCode: "FAC", prefix: "FAC-OC-2026-", nextNumber: 3, padding: 6, invoiceType: "F1", active: true, year: 2026 }]);
    const ra2 = await allocateInvoiceNumber(tx2, { propertyId: RA.id, series: "FAC", issuedAt: ISSUED_AT });
    assert.equal(ra2.prefix, "FAC-RA-2026-", "an office that invoices counts as a billing centre");
    assert.equal(countBillingCentres([{ id: "a", kind: "hotel" }, { id: "b", kind: "office" }, { id: "c", kind: "other" }], new Set()), 3);
    assert.equal(countBillingCentres([{ id: "b", kind: "office" }], new Set(["b"])), 2);
  });

  it("an uncoded centre of a multi-centre sociedad cannot open a series → 409 WORK_CENTER_CODE_REQUIRED (never the plain FAC-<año>-)", async () => {
    // LT has no code yet (t6b#1): before the fix the default fell back to FAC-2026-, the prefix RA uses.
    const { tx, rows, calls } = structureTx([RA, { ...LT, code: null }], [{ id: "seq_ra", propertyId: RA.id, sequenceCode: "FAC", prefix: "FAC-2026-", nextNumber: 5, padding: 6, invoiceType: "F1", active: true, year: 2026 }]);
    await assert.rejects(
      allocateInvoiceNumber(tx, { propertyId: LT.id, series: "FAC", issuedAt: ISSUED_AT }),
      (error: unknown) => {
        assert.ok(error instanceof ConflictError);
        assert.equal(codeOf(error), WORK_CENTER_CODE_REQUIRED_CODE);
        const details = (error as ConflictError).details as { propertyId: string; series: string; year: number; billingCentres: number };
        assert.deepEqual({ propertyId: details.propertyId, series: details.series, year: details.year, billingCentres: details.billingCentres }, { propertyId: LT.id, series: "FAC", year: 2026, billingCentres: 2 });
        assert.match((error as Error).message, /Estructura societaria › Centros/);
        return true;
      }
    );
    assert.equal(rows.length, 1, "nothing was created");
    assert.ok(calls.some((call) => call === `lock:${seriesOpeningLockKey({ legalEntityId: "le_far", organizationId: "org_far" }, 2026)}`), "the series-opening lock was taken before deciding");
    // A sociedad with ONE billing centre never needs the code (single hotels of onboarding go-live).
    const { tx: solo } = structureTx([{ ...SOLO, code: null }], []);
    assert.equal((await allocateInvoiceNumber(solo, { propertyId: SOLO.id, series: "FAC", issuedAt: ISSUED_AT })).prefix, "FAC-2026-");
  });

  it("opening a series whose prefix an active sister series already uses → 409 SERIES_PREFIX_CLASH with conflictingPropertyId", async () => {
    // RA opened LT's would-be prefix by hand (explicit prefix through patchBillingSettings).
    const { tx, rows } = structureTx([RA, LT], [{ id: "seq_ra", propertyId: RA.id, sequenceCode: "FAC", prefix: "FAC-LT-2026-", nextNumber: 5, padding: 6, invoiceType: "F1", active: true, year: 2026 }]);
    await assert.rejects(
      allocateInvoiceNumber(tx, { propertyId: LT.id, series: "FAC", issuedAt: ISSUED_AT }),
      (error: unknown) => {
        assert.ok(error instanceof ConflictError);
        assert.equal(codeOf(error), "SERIES_PREFIX_CLASH");
        const details = (error as ConflictError).details as { conflictingPropertyId: string; conflictingSequenceId: string; prefix: string; year: number };
        assert.equal(details.conflictingPropertyId, RA.id);
        assert.equal(details.conflictingSequenceId, "seq_ra");
        assert.equal(details.prefix, "FAC-LT-2026-");
        assert.equal(details.year, 2026);
        assert.match((error as Error).message, /otro centro de la misma sociedad/);
        return true;
      }
    );
    assert.equal(rows.length, 1, "nothing was created");
  });

  it("a closed sister series never clashes; case-insensitive comparison", async () => {
    const closed: SequenceRow = { id: "seq_ra_closed", propertyId: RA.id, sequenceCode: "FAC", prefix: "fac-lt-2026-", nextNumber: 5, padding: 6, invoiceType: "F1", active: false, year: 2026 };
    const { tx } = structureTx([RA, LT], [closed]);
    const lt = await allocateInvoiceNumber(tx, { propertyId: LT.id, series: "FAC", issuedAt: ISSUED_AT });
    assert.equal(lt.invoiceNumber, "FAC-LT-2026-000001");
    const { tx: tx2 } = structureTx([RA, LT], [{ ...closed, id: "seq_ra_open", active: true }]);
    await assert.rejects(allocateInvoiceNumber(tx2, { propertyId: LT.id, series: "FAC", issuedAt: ISSUED_AT }), (error: unknown) => codeOf(error) === "SERIES_PREFIX_CLASH");
  });

  it("a CLOSED series of the centre itself never numbers again → 409 SERIES_CLOSED (reopen it or open another prefix)", async () => {
    const { tx, rows } = structureTx([RA, LT], [{ id: "seq_ra_closed", propertyId: RA.id, sequenceCode: "FAC", prefix: "FAC-RA-2026-", nextNumber: 9, padding: 6, invoiceType: "F1", active: false, year: 2026 }]);
    await assert.rejects(allocateInvoiceNumber(tx, { propertyId: RA.id, series: "FAC", issuedAt: ISSUED_AT }), (error: unknown) => {
      assert.equal(codeOf(error), SERIES_CLOSED_CODE);
      const details = (error as ConflictError).details as { prefix: string; sequenceId: string; year: number };
      assert.deepEqual({ prefix: details.prefix, sequenceId: details.sequenceId, year: details.year }, { prefix: "FAC-RA-2026-", sequenceId: "seq_ra_closed", year: 2026 });
      assert.match((error as Error).message, /Series y VeriFactu/);
      return true;
    });
    assert.equal(rows[0]!.nextNumber, 9, "a closed series is never advanced");
    // Same for a closed legacy row (year NULL) whose prefix carries the year.
    const { tx: legacyTx } = structureTx([RA, LT], [{ id: "legacy_closed", propertyId: RA.id, sequenceCode: "REC", prefix: "REC-2026-", nextNumber: 4, padding: 6, invoiceType: "R1", active: false, year: null }]);
    await assert.rejects(allocateInvoiceNumber(legacyTx, { propertyId: RA.id, series: "REC", issuedAt: ISSUED_AT }), (error: unknown) => codeOf(error) === SERIES_CLOSED_CODE);
  });

  it("a PRE-EXISTING collision (both series already open, org_123 case) is a warning, never a 409: an issued series is closed, not renumbered", async () => {
    const { tx, rows } = structureTx(
      [RA, LT],
      [
        { id: "seq_ra", propertyId: RA.id, sequenceCode: "FAC", prefix: "FAC-2026-", nextNumber: 7, padding: 6, invoiceType: "F1", active: true, year: 2026 },
        { id: "seq_lt", propertyId: LT.id, sequenceCode: "FAC", prefix: "FAC-2026-", nextNumber: 2, padding: 6, invoiceType: "F1", active: true, year: 2026 }
      ]
    );
    const ra = await allocateInvoiceNumber(tx, { propertyId: RA.id, series: "FAC", issuedAt: ISSUED_AT });
    assert.equal(ra.invoiceNumber, "FAC-2026-000007", "the existing series keeps numbering");
    assert.equal(ra.created, false);
    assert.equal(ra.warnings.length, 1);
    assert.equal(ra.warnings[0], legacySeriesClashWarning("FAC-2026-", 2026, { propertyId: LT.id }));
    assert.match(ra.warnings[0]!, /nunca se renumera/);
    assert.equal(rows.find((r) => r.id === "seq_ra")!.nextNumber, 8);
  });

  it("adopting a legacy row (year NULL) also links it to the sociedad", async () => {
    const { tx, rows } = structureTx([RA, LT], [{ id: "legacy", propertyId: RA.id, sequenceCode: "REC", prefix: "REC-2026-", nextNumber: 4, padding: 6, invoiceType: "R1", active: true, year: null, legalEntityId: null }]);
    const rec = await allocateInvoiceNumber(tx, { propertyId: RA.id, series: "REC", issuedAt: ISSUED_AT });
    assert.equal(rec.invoiceNumber, "REC-2026-000004");
    assert.equal(rows[0]!.year, 2026);
    assert.equal(rows[0]!.legalEntityId, "le_far");
  });

  it("a pre-resolved scope skips the property queries", async () => {
    const scope: SeriesScope = { propertyId: RA.id, organizationId: "org_far", legalEntityId: "le_far", propertyCode: "RA", siblingPropertyIds: [LT.id], billingCentres: 2 };
    const { tx, calls } = structureTx([], []);
    const ra = await allocateInvoiceNumber(tx, { propertyId: RA.id, series: "FAC", issuedAt: ISSUED_AT, scope });
    assert.equal(ra.prefix, "FAC-RA-2026-");
    assert.ok(!calls.includes("prop.findUnique") && !calls.includes("prop.findMany"), calls.join(","));
  });

  it("the new year opens a new row with the centre prefix and leaves the old series untouched (never renumbered)", async () => {
    const { tx, rows } = structureTx([RA, LT], [{ id: "seq_ra_2026", propertyId: RA.id, sequenceCode: "FAC", prefix: "FAC-RA-2026-", nextNumber: 23, padding: 6, invoiceType: "F1", active: true, year: 2026 }]);
    const next = await allocateInvoiceNumber(tx, { propertyId: RA.id, series: "FAC", issuedAt: new Date("2027-01-02T09:00:00.000Z") });
    assert.equal(next.invoiceNumber, "FAC-RA-2027-000001");
    assert.equal(rows.find((r) => r.id === "seq_ra_2026")!.nextNumber, 23);
    assert.equal(rows.find((r) => r.id === "seq_ra_2026")!.active, true, "closing the old year's series is an operator decision, not an automatic write");
  });
});

const ENTITY_SCOPE = { legalEntityId: "le_far", organizationId: "org_far" };

describe("assertInvoiceNumberFreeInEntity — stand-in for the deferred (legal_entity_id, invoice_number) index", () => {
  it("409 INVOICE_NUMBER_DUPLICATE when a sister centre already issued the number; the number is locked under the sociedad first", async () => {
    const locks: string[] = [];
    const tx = {
      invoice: {
        async findFirst(args: { where: { propertyId: { in: string[] }; invoiceNumber: string } }) {
          assert.equal(locks.length, 1, "the advisory lock precedes the sister lookup");
          return args.where.propertyId.in.includes("prop_lt") && args.where.invoiceNumber === "FAC-2026-000001" ? { id: "inv_lt_1", propertyId: "prop_lt" } : null;
        }
      },
      async $executeRaw(_strings: TemplateStringsArray, ...values: unknown[]) {
        locks.push(String(values[0]));
        return 0;
      }
    } as unknown as Parameters<typeof assertInvoiceNumberFreeInEntity>[0];
    await assert.rejects(assertInvoiceNumberFreeInEntity(tx, { ...ENTITY_SCOPE, propertyId: "prop_ra", siblingPropertyIds: ["prop_lt"] }, "FAC-2026-000001"), (error: unknown) => {
      assert.ok(error instanceof ConflictError);
      assert.equal(codeOf(error), INVOICE_NUMBER_DUPLICATE_CODE);
      const details = (error as ConflictError).details as { conflictingPropertyId: string; conflictingInvoiceId: string; invoiceNumber: string };
      assert.equal(details.conflictingPropertyId, "prop_lt");
      assert.equal(details.conflictingInvoiceId, "inv_lt_1");
      assert.equal(details.invoiceNumber, "FAC-2026-000001");
      return true;
    });
    assert.equal(locks[0], invoiceNumberLockKey(ENTITY_SCOPE, "FAC-2026-000001"));
    locks.length = 0;
    await assertInvoiceNumberFreeInEntity(tx, { ...ENTITY_SCOPE, propertyId: "prop_ra", siblingPropertyIds: ["prop_lt"] }, "FAC-2026-000002");
    assert.equal(invoiceNumberLockKey(ENTITY_SCOPE, "fac-2026-000002"), invoiceNumberLockKey(ENTITY_SCOPE, "FAC-2026-000002"), "case-insensitive key");
    assert.equal(invoiceNumberLockKey({ legalEntityId: null, organizationId: "org_x" }, "FAC-2026-000002"), "invoice-number:org:org_x:FAC-2026-000002", "organization key before the backfill");
  });

  it("a centre without siblings never queries nor locks", async () => {
    let queried = false;
    let locked = false;
    const tx = { invoice: { async findFirst() { queried = true; return null; } }, async $executeRaw() { locked = true; return 0; } } as unknown as Parameters<typeof assertInvoiceNumberFreeInEntity>[0];
    await assertInvoiceNumberFreeInEntity(tx, { legalEntityId: "le_solo", organizationId: "org_solo", propertyId: "prop_solo", siblingPropertyIds: [] }, "FAC-2026-000001");
    assert.equal(queried, false);
    assert.equal(locked, false);
  });
});

// ── R7 · SistemaInformatico from the installation ────────────────────────────

describe("resolveVerifactuSoftware — NumeroInstalacion from the declared installation, env only as sandbox fallback", () => {
  it("a declared installation supplies the number and the env variable is not consulted", () => {
    const result = resolveVerifactuSoftware({ ...COMPLETE_ENV, VERIFACTU_INSTALL_NUMBER: "" }, { installation: { id: "vfi_ra", numeroInstalacion: "FAR-RA-0001" }, requireInstallation: true });
    assert.equal(result.ok, true, result.errors.join(" "));
    assert.equal(result.software.numeroInstalacion, "FAR-RA-0001");
    assert.equal(result.installationSource, "installation");
    assert.equal(result.software.indicadorMultiplesOT, "S");
  });

  it("real modes without installation → INSTALLATION_NOT_DECLARED error (never the env value as ok)", () => {
    const result = resolveVerifactuSoftware(COMPLETE_ENV, { installation: null, requireInstallation: true });
    assert.equal(result.ok, false);
    // Cocoa 22 · ola 11 (qa#14): the reason is a Spanish sentence (no code prefix); the code stays the errorCode of the parked send.
    assert.ok(result.errors.some((e) => e.startsWith("El centro no tiene una instalación VeriFactu declarada.")), result.errors.join(" "));
    assert.ok(!result.errors.some((e) => e.includes(VERIFACTU_INSTALLATION_NOT_DECLARED_CODE)), "the code never reaches the hotelier");
    assert.equal(result.installationSource, "env", "the env fills the field only so the block stays well-formed");
  });

  it("sandbox without installation keeps the legacy env fallback (and its error when unset)", () => {
    const withEnv = resolveVerifactuSoftware(COMPLETE_ENV, { installation: null });
    assert.equal(withEnv.ok, true);
    assert.equal(withEnv.software.numeroInstalacion, "VPS-HOSTINGER-001");
    assert.equal(withEnv.installationSource, "env");
    const withoutEnv = resolveVerifactuSoftware({ ...COMPLETE_ENV, VERIFACTU_INSTALL_NUMBER: "" }, { installation: null });
    assert.equal(withoutEnv.ok, false);
    assert.equal(withoutEnv.software.numeroInstalacion, VERIFACTU_SOFTWARE_DEFAULTS.numeroInstalacion);
    assert.equal(withoutEnv.installationSource, "default");
    // Legacy callers (no options) behave exactly as before.
    assert.deepEqual(resolveVerifactuSoftware(COMPLETE_ENV).software, withEnv.software);
  });

  it("an installation number over 100 characters is reported against the table, not the env", () => {
    const result = resolveVerifactuSoftware(COMPLETE_ENV, { installation: { numeroInstalacion: "X".repeat(101) } });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.startsWith("El número de instalación supera los 100 caracteres") && e.includes("(101)")), result.errors.join(" "));
    assert.ok(!result.errors.some((e) => e.includes("VERIFACTU_INSTALL_NUMBER") || e.includes("verifactu_installations")), "neither the env variable nor the table is named");
  });
});

describe("resolveSoftwareForSend — readiness in real modes demands the declared installation", () => {
  it("preproduction without installation parks the send with INSTALLATION_NOT_DECLARED (transient config error)", () => {
    const { blocking, software } = resolveSoftwareForSend("preproduction", null, COMPLETE_ENV);
    assert.ok(blocking);
    assert.equal(blocking.errorCode, "INSTALLATION_NOT_DECLARED");
    assert.equal(blocking.status, "rejected");
    assert.match(blocking.errorMessage ?? "", /Sin instalación VeriFactu declarada/);
    assert.equal(software.numeroInstalacion, "VPS-HOSTINGER-001", "block still well-formed; never sent");
  });

  it("preproduction with the installation sends with its NumeroInstalacion", () => {
    const { blocking, software } = resolveSoftwareForSend("preproduction", INSTALLATION, { ...COMPLETE_ENV, VERIFACTU_INSTALL_NUMBER: "" });
    assert.equal(blocking, null);
    assert.equal(software.numeroInstalacion, "FAR-RA-0001");
  });

  it("preproduction with installation but an incomplete producer block still says SOFTWARE_NOT_CONFIGURED", () => {
    const { blocking } = resolveSoftwareForSend("production", INSTALLATION, { ...COMPLETE_ENV, VERIFACTU_SOFTWARE_NIF: "" });
    assert.equal(blocking?.errorCode, "SOFTWARE_NOT_CONFIGURED");
  });

  it("sandbox never blocks: installation when present, env fallback otherwise", () => {
    assert.equal(resolveSoftwareForSend("sandbox", null, { ...COMPLETE_ENV, VERIFACTU_INSTALL_NUMBER: "" }).blocking, null);
    assert.equal(resolveSoftwareForSend("sandbox", INSTALLATION, COMPLETE_ENV).software.numeroInstalacion, "FAR-RA-0001");
  });
});

describe("TicketBAI — NumSerieDispositivo from the declared installation", () => {
  it("resolveTbaiSoftware takes the device serial from the installation, else TBAI_DEVICE_SERIAL, else the VeriFactu number", () => {
    const env = { ...COMPLETE_ENV, TBAI_LICENSE_KEY: "TBAIBIZKAIA0001", TBAI_DEVICE_SERIAL: "DEV-SERIAL-ENV" };
    assert.equal(resolveTbaiSoftware(env, { installation: { id: "vfi_tbai", numeroInstalacion: "FAR-BI-0001" } }).software.deviceSerial, "FAR-BI-0001");
    assert.equal(resolveTbaiSoftware(env, { installation: null }).software.deviceSerial, "DEV-SERIAL-ENV");
    assert.equal(resolveTbaiSoftware({ ...env, TBAI_DEVICE_SERIAL: "" }).software.deviceSerial, "VPS-HOSTINGER-001");
    const production = resolveTbaiSoftware(env, { installation: null, requireInstallation: true });
    assert.equal(production.ok, false);
    assert.ok(production.errors.some((e) => e.startsWith("El centro no tiene una instalación VeriFactu declarada.")), production.errors.join(" "));
  });

  it("buildTbaiXml renders the device serial (legacy literal when none is passed)", () => {
    const base = {
      emitterTaxId: "A58818501",
      emitterName: "CELUISMA S.A.",
      invoiceNumber: "FAC-BI-2026-000001",
      issuedAt: "2026-09-16T10:00:00.000Z",
      invoiceType: "F1" as const,
      totalAmount: 110,
      vatTotal: 10,
      description: "Servicios hoteleros",
      breakdowns: [{ ratePercent: 10, taxableBase: 100, taxAmount: 10 }],
      currentHash: "A".repeat(64),
      territory: "bizkaia" as const,
      software: { nif: "B12345674", name: "ehotelOS", licenseKey: "TBAIBIZKAIA0001", developerName: "Anfitorio Software SL", softwareName: "ehotelOS", version: "1.4.0" }
    };
    assert.match(buildTbaiXml({ ...base, software: { ...base.software, deviceSerial: "FAR-BI-0001" } }), /<NumSerieDispositivo>FAR-BI-0001<\/NumSerieDispositivo>/);
    assert.match(buildTbaiXml(base), /<NumSerieDispositivo>HOTELOS-DEV<\/NumSerieDispositivo>/);
    assert.match(buildTbaiXml(base), /<ApellidosNombreRazonSocial>CELUISMA S.A.<\/ApellidosNombreRazonSocial>/);
  });
});

// ── R2 · PDF header ──────────────────────────────────────────────────────────

function pdfModel(overrides: Partial<InvoicePdfModel["issuer"]> = {}): InvoicePdfModel {
  return {
    invoiceId: "inv_l3",
    invoiceNumber: "FAC-RA-2026-000001",
    invoiceType: "F1",
    status: "issued",
    issuedAt: "2026-09-16T10:00:00.000Z",
    cancelledAt: null,
    simplified: false,
    currencyCode: "EUR",
    issuer: {
      legalName: "CELUISMA S.A.",
      taxId: "A58818501",
      address: "Calle Portugal 7, 33207 Gijon, Asturias",
      propertyName: "Faranda Rias Altas",
      placeholder: false,
      legalFooter: null,
      fiscalAddress: "Calle Portugal 7, 33207 Gijon, Asturias",
      establishment: { code: "RA", tradeName: "Hotel Faranda Rias Altas", addressLine: "Paseo Maritimo 1, 15172 Perillo (Oleiros), A Coruna" },
      ...overrides
    },
    customer: { type: "company", name: "Cliente SL", taxId: "B12345674" },
    lines: [{ description: "Habitacion", quantity: 1, unitPrice: 110, taxRate: 10, calificacion: "S1", total: 110 }],
    breakdown: [{ figure: "IVA", calificacion: "S1", ratePercent: 10, base: 100, quota: 10 }],
    totals: { base: 100, tax: 10, total: 110 },
    rectification: null,
    payment: null,
    qrUrl: null,
    verifactuHash: null,
    stay: null,
    warnings: []
  };
}

describe("buildInvoicePdf — sociedad in the header, establishment in its own line (R2)", () => {
  it("prints razón social, NIF, domicilio fiscal and «Establecimiento: <nombre comercial> (<código>) · <dirección>»", () => {
    const out = buildInvoicePdf(pdfModel()).toString("latin1");
    assert.ok(out.includes("CELUISMA S.A."));
    assert.ok(out.includes("NIF: A58818501"));
    assert.ok(out.includes("Domicilio fiscal: Calle Portugal 7, 33207 Gijon, Asturias"));
    assert.ok(out.includes("Establecimiento: Hotel Faranda Rias Altas \\(RA\\)"), "establishment block with code");
    assert.ok(!out.includes("\nFaranda Rias Altas\n"), "the operational property name is not printed as a second razón social");
  });

  it("without a fiscal address the establishment address is not duplicated under the NIF", () => {
    const out = buildInvoicePdf(pdfModel({ fiscalAddress: null, address: "Paseo Maritimo 1, 15172 Perillo (Oleiros), A Coruna" })).toString("latin1");
    assert.equal(out.split("Paseo Maritimo 1").length - 1, 1, "address printed once, in the establishment line");
    assert.ok(!out.includes("Domicilio fiscal:"));
  });

  it("legacy model without establishment keeps the property-name line", () => {
    const out = buildInvoicePdf(pdfModel({ establishment: null, fiscalAddress: undefined })).toString("latin1");
    assert.ok(out.includes("Faranda Rias Altas"));
    assert.ok(!out.includes("Establecimiento:"));
  });

  it("establishmentLine is pure and tolerant to a missing code / address", () => {
    assert.equal(establishmentLine({ code: "RA", tradeName: "Hotel X", addressLine: "Calle 1" }), "Establecimiento: Hotel X (RA) · Calle 1");
    assert.equal(establishmentLine({ code: null, tradeName: "Hotel X", addressLine: null }), "Establecimiento: Hotel X");
  });
});
