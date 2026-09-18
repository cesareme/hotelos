// Unit tests for the Tanda 3 invoicing helpers: yearly series (FISC-09),
// chain-link choice, tax readiness policy, rectificativa lines and tax
// identity. Pure-core only: no database (allocateInvoiceNumber gets an
// in-memory transaction mock). Run from apps/api with
//   node --import tsx --test src/modules/invoicing/__tests__/fiscal-series.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  TAX_NOT_CONFIGURED_CODE,
  allocateInvoiceNumber,
  buildDifferenceLines,
  evaluateTaxReadiness,
  fiscalYearInMadrid,
  invoiceTaxWarnings,
  lineTaxIdentity,
  parseInvoiceWarnings,
  pickPreviousChainLink,
  seriesForInvoiceType,
  taxNotConfiguredError,
  totalsForInvoiceLines,
  type ChainLink,
  type InvoiceSequenceTx,
  type PropertyTaxContext,
  type ResolvedInvoiceLine
} from "../invoice.service.js";
import { taxCategoryForOutlet } from "../../pos/pos.service.js";
import { validateFolioLineTaxCategory } from "../../folio/folio.service.js";
import { BadRequestError, ConflictError } from "../../../lib/http-error.js";

// ── Fiscal calendar ──────────────────────────────────────────────────────────

describe("fiscalYearInMadrid — the series year follows Europe/Madrid, not UTC", () => {
  it("23:30 UTC on 31 December is already the next year in Madrid (UTC+1)", () => {
    assert.equal(fiscalYearInMadrid(new Date("2026-12-31T23:30:00.000Z")), 2027);
  });

  it("keeps the year for a plain date in the middle of the year", () => {
    assert.equal(fiscalYearInMadrid(new Date("2026-06-15T12:00:00.000Z")), 2026);
  });

  it("22:30 UTC on 30 June is still June in Madrid (UTC+2) — same year either way", () => {
    assert.equal(fiscalYearInMadrid(new Date("2026-06-30T22:30:00.000Z")), 2026);
  });
});

describe("seriesForInvoiceType", () => {
  it("maps F1 → FAC, F2 → SIM, R1..R5 → REC, F3 → FAC", () => {
    assert.equal(seriesForInvoiceType("F1"), "FAC");
    assert.equal(seriesForInvoiceType("F2"), "SIM");
    assert.equal(seriesForInvoiceType("R1"), "REC");
    assert.equal(seriesForInvoiceType("R5"), "REC");
    assert.equal(seriesForInvoiceType("F3"), "FAC");
  });
});

// ── allocateInvoiceNumber with an in-memory transaction ──────────────────────

type SequenceRow = {
  id: string;
  propertyId: string;
  sequenceCode: string;
  prefix: string | null;
  nextNumber: number;
  padding: number;
  invoiceType: string;
  active: boolean;
  year: number | null;
  legalEntityId?: string | null;
};

/**
 * In-memory transaction: the sequence rows plus a single-centre property
 * (no siblings → R3 keeps the plain `FAC-<año>-` prefix, no clash lookups).
 * The multi-centre cases live in structure-l3-invoicing.test.mts.
 */
function sequenceTx(rows: SequenceRow[]): { tx: InvoiceSequenceTx; rows: SequenceRow[]; calls: string[] } {
  const calls: string[] = [];
  let counter = 0;
  const invoiceSequence = {
    async findFirst(args: { where: { propertyId: string; sequenceCode: string; year: number | null } }) {
      calls.push("findFirst");
      const matches = rows.filter(
        (r) => r.propertyId === args.where.propertyId && r.sequenceCode === args.where.sequenceCode && r.year === args.where.year
      );
      return matches.sort((a, b) => b.nextNumber - a.nextNumber)[0] ?? null;
    },
    async findUnique(args: { where: { propertyId_sequenceCode_year: { propertyId: string; sequenceCode: string; year: number } } }) {
      calls.push("findUnique");
      const key = args.where.propertyId_sequenceCode_year;
      return rows.find((r) => r.propertyId === key.propertyId && r.sequenceCode === key.sequenceCode && r.year === key.year) ?? null;
    },
    async findMany() {
      calls.push("findMany");
      return [];
    },
    async update(args: { where: { id: string }; data: { year?: number; nextNumber?: { increment: number }; legalEntityId?: string } }) {
      calls.push("update");
      const row = rows.find((r) => r.id === args.where.id)!;
      if (args.data.year !== undefined) row.year = args.data.year;
      if (args.data.nextNumber?.increment) row.nextNumber += args.data.nextNumber.increment;
      if (args.data.legalEntityId !== undefined) row.legalEntityId = args.data.legalEntityId;
      return { ...row };
    },
    async create(args: { data: Omit<SequenceRow, "id" | "active"> }) {
      calls.push("create");
      const created: SequenceRow = { id: `seq_${++counter}`, active: true, ...args.data };
      rows.push(created);
      return { ...created };
    }
  };
  const property = {
    async findUnique(args: { where: { id: string } }) {
      return { id: args.where.id, organizationId: "org_test", legalEntityId: null, code: null, kind: "hotel" };
    },
    async findMany() {
      return [];
    }
  };
  // Series-opening advisory lock (fix t6b#1): recorded, no database.
  const $executeRaw = async () => {
    calls.push("lock");
    return 0;
  };
  return { tx: { invoiceSequence, property, $executeRaw } as unknown as InvoiceSequenceTx, rows, calls };
}

const FARANDA = "prop_faranda";

function legacyRow(sequenceCode: string, prefix: string, nextNumber: number, padding = 6): SequenceRow {
  return { id: `legacy_${sequenceCode}`, propertyId: FARANDA, sequenceCode, prefix, nextNumber, padding, invoiceType: "F1", active: true, year: null };
}

describe("allocateInvoiceNumber — one series per fiscal year (FISC-09)", () => {
  it("adopts the legacy row (year NULL, prefix FAC-2026-) for 2026 and keeps its numbering", async () => {
    const { tx, rows, calls } = sequenceTx([legacyRow("FAC", "FAC-2026-", 14)]);
    const result = await allocateInvoiceNumber(tx, { propertyId: FARANDA, series: "FAC", issuedAt: new Date("2026-09-14T10:00:00.000Z") });
    assert.equal(result.invoiceNumber, "FAC-2026-000014");
    assert.equal(result.year, 2026);
    assert.equal(result.sequenceId, "legacy_FAC");
    assert.equal(rows.length, 1, "no parallel series created");
    assert.equal(rows[0]!.year, 2026, "the legacy row is stamped with its year");
    assert.equal(rows[0]!.nextNumber, 15);
    assert.deepEqual(calls, ["findFirst", "update"]);
  });

  it("starts FAC-2027-000001 on the first issuance of 2027 and leaves 2026 untouched", async () => {
    const { tx, rows } = sequenceTx([legacyRow("FAC", "FAC-2026-", 14)]);
    const result = await allocateInvoiceNumber(tx, { propertyId: FARANDA, series: "FAC", issuedAt: new Date("2026-12-31T23:30:00.000Z") });
    assert.equal(result.invoiceNumber, "FAC-2027-000001");
    assert.equal(result.year, 2027);
    assert.equal(rows.length, 2);
    const created = rows.find((r) => r.year === 2027)!;
    assert.equal(created.prefix, "FAC-2027-");
    assert.equal(created.nextNumber, 2);
    assert.equal(created.padding, 6);
    assert.equal(created.invoiceType, "F1");
    assert.equal(rows[0]!.nextNumber, 14, "2026 row not consumed");
    assert.equal(result.prefix, "FAC-2027-");
    assert.equal(result.created, true, "the allocation opened the 2027 row");
  });

  it("increments an existing yearly row and pads to 6 digits", async () => {
    const { tx, calls } = sequenceTx([{ ...legacyRow("FAC", "FAC-2027-", 3), id: "y2027", year: 2027 }]);
    const a = await allocateInvoiceNumber(tx, { propertyId: FARANDA, series: "FAC", issuedAt: new Date("2027-02-01T10:00:00.000Z") });
    const b = await allocateInvoiceNumber(tx, { propertyId: FARANDA, series: "FAC", issuedAt: new Date("2027-02-01T10:00:01.000Z") });
    assert.equal(a.invoiceNumber, "FAC-2027-000003");
    assert.equal(b.invoiceNumber, "FAC-2027-000004");
    assert.equal(a.sequenceId, "y2027");
    assert.deepEqual(calls, ["findFirst", "findUnique", "update", "findFirst", "findUnique", "update"]);
  });

  it("respects the padding stored on the row", async () => {
    const { tx } = sequenceTx([legacyRow("FAC", "FAC-2026-", 7, 5)]);
    const result = await allocateInvoiceNumber(tx, { propertyId: FARANDA, series: "FAC", issuedAt: new Date("2026-05-01T10:00:00.000Z") });
    assert.equal(result.invoiceNumber, "FAC-2026-00007");
  });

  it("does not adopt a legacy row of another year or another series", async () => {
    const { tx, rows } = sequenceTx([legacyRow("FAC", "FAC-2025-", 40), legacyRow("REC", "REC-2026-", 2)]);
    const result = await allocateInvoiceNumber(tx, { propertyId: FARANDA, series: "FAC", issuedAt: new Date("2026-05-01T10:00:00.000Z") });
    assert.equal(result.invoiceNumber, "FAC-2026-000001");
    assert.equal(rows.find((r) => r.sequenceCode === "FAC" && r.year === null)!.nextNumber, 40);
    assert.equal(rows.find((r) => r.sequenceCode === "REC")!.year, null);
  });

  it("REC and SIM series get their own rows with the AEAT invoice type", async () => {
    const { tx, rows } = sequenceTx([]);
    const rec = await allocateInvoiceNumber(tx, { propertyId: FARANDA, series: "REC", issuedAt: new Date("2026-05-01T10:00:00.000Z") });
    const sim = await allocateInvoiceNumber(tx, { propertyId: FARANDA, series: "SIM", issuedAt: new Date("2026-05-01T10:00:00.000Z") });
    assert.equal(rec.invoiceNumber, "REC-2026-000001");
    assert.equal(sim.invoiceNumber, "SIM-2026-000001");
    assert.equal(rows.find((r) => r.sequenceCode === "REC")!.invoiceType, "R1");
    assert.equal(rows.find((r) => r.sequenceCode === "SIM")!.invoiceType, "F2");
  });
});

// ── Chain link ───────────────────────────────────────────────────────────────

function link(kind: ChainLink["kind"], generatedAt: string, hash: string): ChainLink {
  return { invoiceId: `inv_${hash}`, invoiceNumber: null, kind, hash, generatedAt: new Date(generatedAt), emitterTaxId: "B12345674" };
}

describe("pickPreviousChainLink — the most recent record, alta or anulación", () => {
  it("returns whichever exists", () => {
    const alta = link("alta", "2026-09-14T10:00:00Z", "A");
    assert.equal(pickPreviousChainLink(alta, null), alta);
    const anul = link("anulacion", "2026-09-14T10:00:00Z", "B");
    assert.equal(pickPreviousChainLink(null, anul), anul);
    assert.equal(pickPreviousChainLink(null, null), null);
  });

  it("prefers the later record; the alta wins a tie (same rule as chainTailBefore in verifactu-submission)", () => {
    const alta = link("alta", "2026-09-14T10:00:00Z", "A");
    const laterAnul = link("anulacion", "2026-09-14T10:05:00Z", "B");
    assert.equal(pickPreviousChainLink(alta, laterAnul), laterAnul);
    const laterAlta = link("alta", "2026-09-14T10:10:00Z", "C");
    assert.equal(pickPreviousChainLink(laterAlta, laterAnul), laterAlta);
    const tie = link("anulacion", "2026-09-14T10:10:00Z", "D");
    assert.equal(pickPreviousChainLink(laterAlta, tie), laterAlta);
  });
});

// ── Tax identity / totals ────────────────────────────────────────────────────

describe("lineTaxIdentity — Tanda 3 columns first, legacy codes as fallback", () => {
  it("uses the persisted figure / calificación when present", () => {
    const id = lineTaxIdentity({ taxCode: "ES_IGIC_7", taxRate: 7, taxCategory: "accommodation", taxCalificacion: "S1", taxFigure: "IGIC" });
    assert.deepEqual(id, { figure: "IGIC", impuesto: "03", calificacion: "S1", category: "accommodation", unknown: false });
  });

  it("parses legacy codes (ES_IVA_21, IVA_10, ES_IVA_N1)", () => {
    assert.equal(lineTaxIdentity({ taxCode: "ES_IVA_21", taxRate: 21 }).impuesto, "01");
    assert.equal(lineTaxIdentity({ taxCode: "IVA_10", taxRate: 10 }).figure, "IVA");
    const n1 = lineTaxIdentity({ taxCode: "ES_IVA_N1", taxRate: 0 });
    assert.equal(n1.calificacion, "N1");
    assert.equal(n1.unknown, false);
    assert.equal(lineTaxIdentity({ taxCode: "ES_IPSI_2", taxRate: 2 }).impuesto, "02");
  });

  it("flags ES_UNKNOWN_0 and junk codes as unknown (IVA fallback keeps the totals computable)", () => {
    const unknown = lineTaxIdentity({ taxCode: "ES_UNKNOWN_0", taxRate: 0 });
    assert.equal(unknown.unknown, true);
    assert.equal(unknown.figure, "IVA");
    assert.equal(lineTaxIdentity({ taxCode: "X", taxRate: 0 }).unknown, true);
  });
});

describe("totalsForInvoiceLines — header + desglose from one grouping", () => {
  it("groups by impuesto / calificación / rate with per-group rounding", () => {
    const totals = totalsForInvoiceLines([
      { taxCode: "ES_IVA_10", taxRate: 10, total: 110, taxFigure: "IVA", taxCalificacion: "S1", taxCategory: "accommodation" },
      { taxCode: "ES_IVA_10", taxRate: 10, total: 22, taxFigure: "IVA", taxCalificacion: "S1", taxCategory: "food_beverage" },
      { taxCode: "ES_IVA_21", taxRate: 21, total: 12.1 },
      { taxCode: "ES_IVA_N1", taxRate: 0, total: 30, taxCategory: "not_subject", taxCalificacion: "N1", taxFigure: "IVA" }
    ]);
    assert.equal(totals.total, 174.1);
    assert.equal(totals.taxTotal, 14.1);
    assert.deepEqual(
      totals.breakdown.map((g) => [g.calificacion, g.ratePercent, g.base, g.quota]),
      [
        ["S1", 21, 10, 2.1],
        ["S1", 10, 120, 12],
        ["N1", 0, 30, 0]
      ]
    );
  });
});

// ── Readiness policy ─────────────────────────────────────────────────────────

function context(partial: Partial<PropertyTaxContext> = {}): PropertyTaxContext {
  return { taxRegion: "ES_PENINSULA_BALEARES", regionSource: "property", figure: "IVA", touristTaxTreatment: "included_10", ipsiOrdinanceConfirmedAt: null, warnings: [], ...partial };
}

const ROOM = { description: "Habitación doble", taxCode: "ES_IVA_10", taxRate: 10, taxCategory: "accommodation", taxCalificacion: "S1", taxFigure: "IVA" };

describe("evaluateTaxReadiness — what blocks issuance in fiscal production mode", () => {
  it("is ok for a configured property with rated lines", () => {
    const r = evaluateTaxReadiness([ROOM], context());
    assert.deepEqual(r, { ok: true, blocking: [], warnings: [] });
  });

  it("blocks an ES_UNKNOWN_* line", () => {
    const r = evaluateTaxReadiness([{ description: "Extra", taxCode: "ES_UNKNOWN_0", taxRate: 0 }], context());
    assert.equal(r.ok, false);
    assert.equal(r.blocking.length, 1);
    assert.match(r.blocking[0]!, /«Extra»/);
    assert.match(r.blocking[0]!, /ES_UNKNOWN_0/);
  });

  it("blocks a subject (S1) line at 0 % unless its category is not_subject", () => {
    const zero = evaluateTaxReadiness([{ description: "Cargo", taxCode: "ES_IVA_0", taxRate: 0, taxCategory: "general_services" }], context());
    assert.equal(zero.ok, false);
    assert.match(zero.blocking[0]!, /0 % en una operación sujeta/);
    const legacyZero = evaluateTaxReadiness([{ description: "Cargo", taxCode: "ES_IVA_0", taxRate: 0 }], context());
    assert.equal(legacyZero.ok, false);
    assert.match(legacyZero.blocking[0]!, /sin categoría fiscal/);
    const penalty = evaluateTaxReadiness(
      [{ description: "No-show", taxCode: "ES_IVA_N1", taxRate: 0, taxCategory: "not_subject", taxCalificacion: "N1", taxFigure: "IVA" }],
      context()
    );
    assert.equal(penalty.ok, true);
  });

  it("blocks when the property has no canonical region (catalogue default)", () => {
    const r = evaluateTaxReadiness([ROOM], context({ taxRegion: null, regionSource: "default", warnings: ["sin región"] }));
    assert.equal(r.ok, false);
    assert.match(r.blocking[0]!, /región fiscal canónica/);
    assert.deepEqual(r.warnings, ["sin región"]);
    assert.equal(evaluateTaxReadiness([ROOM], null).ok, false);
  });

  it("blocks IPSI until the ordinance confirmation is recorded", () => {
    const ipsiLine = { description: "Habitación", taxCode: "ES_IPSI_2", taxRate: 2, taxCategory: "accommodation", taxCalificacion: "S1", taxFigure: "IPSI" };
    const unconfirmed = evaluateTaxReadiness([ipsiLine], context({ taxRegion: "ES_MELILLA", figure: "IPSI" }));
    assert.equal(unconfirmed.ok, false);
    assert.match(unconfirmed.blocking[0]!, /IPSI/);
    const confirmed = evaluateTaxReadiness([ipsiLine], context({ taxRegion: "ES_MELILLA", figure: "IPSI", ipsiOrdinanceConfirmedAt: "2026-01-10T00:00:00.000Z" }));
    assert.equal(confirmed.ok, true);
    // A legacy IPSI line (figure from the code) on a property whose profile says IVA still needs the confirmation.
    const legacy = evaluateTaxReadiness([{ description: "Habitación", taxCode: "ES_IPSI_2", taxRate: 2 }], context());
    assert.equal(legacy.ok, false);
  });

  it("reports every problem once", () => {
    const r = evaluateTaxReadiness(
      [
        { description: "A", taxCode: "ES_UNKNOWN_0", taxRate: 0 },
        { description: "B", taxCode: "ES_UNKNOWN_0", taxRate: 0 }
      ],
      context({ taxRegion: null, regionSource: "default" })
    );
    assert.equal(r.blocking.length, 3);
  });
});

describe("taxNotConfiguredError — 409 payload", () => {
  it("carries code, blocking list and a hint", () => {
    const error = taxNotConfiguredError({ ok: false, blocking: ["p1", "p2"], warnings: ["w"] });
    assert.ok(error instanceof ConflictError);
    assert.equal(error.statusCode, 409);
    assert.match(error.message, /2 problemas/);
    const details = error.details as { code: string; blocking: string[]; warnings: string[]; hint: string };
    assert.equal(details.code, TAX_NOT_CONFIGURED_CODE);
    assert.deepEqual(details.blocking, ["p1", "p2"]);
    assert.deepEqual(details.warnings, ["w"]);
    assert.match(details.hint, /Cumplimiento › Fiscal/);
  });
});

// ── Draft warnings ───────────────────────────────────────────────────────────

function resolvedLine(partial: Partial<ResolvedInvoiceLine> = {}): ResolvedInvoiceLine {
  return {
    lineType: "room",
    description: "Habitación",
    taxCode: "ES_IVA_10",
    ratePercent: 10,
    figure: "IVA",
    calificacion: "S1",
    category: "accommodation",
    source: "db",
    verifyAgainstOrdinance: false,
    ...partial
  };
}

describe("invoiceTaxWarnings — persisted with the draft", () => {
  it("is empty for a configured property and rated lines", () => {
    assert.deepEqual(invoiceTaxWarnings([resolvedLine()], context()), []);
  });

  it("does not warn for an N1 penalty at 0 %, but does for an S1 line at 0 %", () => {
    const n1 = resolvedLine({ lineType: "no_show_fee", taxCode: "ES_IVA_N1", ratePercent: 0, calificacion: "N1", category: "not_subject" });
    assert.deepEqual(invoiceTaxWarnings([n1], context()), []);
    const s1 = resolvedLine({ lineType: "charge", taxCode: "ES_IVA_0", ratePercent: 0 });
    const warnings = invoiceTaxWarnings([s1], context());
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /«charge»/);
  });

  it("explains the catalogue default when the property has no region (unless the profile already did)", () => {
    const line = resolvedLine({ source: "catalog" });
    const own = invoiceTaxWarnings([line], context({ taxRegion: null, regionSource: "default" }));
    assert.equal(own.length, 1);
    assert.match(own[0]!, /no tiene región fiscal configurada/);
    const fromProfile = invoiceTaxWarnings([line], context({ taxRegion: null, regionSource: "default", warnings: ["La propiedad no tiene región fiscal configurada ni provincia…"] }));
    assert.deepEqual(fromProfile, ["La propiedad no tiene región fiscal configurada ni provincia…"]);
  });

  it("flags unconfirmed IPSI and describes the tourist-tax treatment", () => {
    const ipsi = resolvedLine({ taxCode: "ES_IPSI_2", ratePercent: 2, figure: "IPSI", verifyAgainstOrdinance: true });
    const warnings = invoiceTaxWarnings([ipsi], context({ taxRegion: "ES_CEUTA", figure: "IPSI" }));
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /IPSI sin confirmar/);
    const tourist = resolvedLine({ lineType: "city_tax", category: "tourist_tax" });
    assert.match(invoiceTaxWarnings([tourist], context({ touristTaxTreatment: "included_10" }))[0]!, /10 %/);
    assert.match(invoiceTaxWarnings([tourist], context({ touristTaxTreatment: "none" }))[0]!, /sin tasa turística/);
  });
});

describe("parseInvoiceWarnings", () => {
  it("keeps only non-empty strings", () => {
    assert.deepEqual(parseInvoiceWarnings(["a", "", 3, null, "b"]), ["a", "b"]);
    assert.deepEqual(parseInvoiceWarnings(null), []);
    assert.deepEqual(parseInvoiceWarnings("x"), []);
  });
});

// ── Rectificativa por diferencias ────────────────────────────────────────────

const ORIGINAL_ROOM = { id: "l1", description: "Habitación", quantity: 2, unitPrice: 55, total: 110, taxCode: "ES_IVA_10", taxRate: 10, taxCategory: "accommodation", taxCalificacion: "S1", taxFigure: "IVA" };
const ORIGINAL_PARKING = { id: "l2", description: "Parking", quantity: 1, unitPrice: 12.1, total: 12.1, taxCode: "ES_IVA_21", taxRate: 21, taxCategory: null, taxCalificacion: null, taxFigure: null };

describe("buildDifferenceLines — gross deltas, tax identity copied", () => {
  it("treats unitPrice as GROSS: one night less at 55 € gross is −55, not −60.50", () => {
    const lines = buildDifferenceLines([ORIGINAL_ROOM, ORIGINAL_PARKING], [{ lineId: "l1", quantity: 1 }], false);
    assert.equal(lines.length, 1);
    assert.equal(lines[0]!.total, -55);
    assert.equal(lines[0]!.quantity, -1);
    assert.equal(lines[0]!.unitPrice, 55);
    assert.equal(lines[0]!.taxCode, "ES_IVA_10");
    assert.equal(lines[0]!.taxCategory, "accommodation");
    assert.equal(lines[0]!.taxCalificacion, "S1");
    assert.equal(lines[0]!.taxFigure, "IVA");
    assert.match(lines[0]!.description, /^Rectificación: /);
  });

  it("a full reversal negates every line and derives figure / calificación for legacy lines", () => {
    const lines = buildDifferenceLines([ORIGINAL_ROOM, ORIGINAL_PARKING], undefined, true);
    assert.deepEqual(lines.map((l) => l.total), [-110, -12.1]);
    assert.deepEqual(lines.map((l) => l.quantity), [-2, -1]);
    assert.equal(lines[1]!.taxCalificacion, "S1");
    assert.equal(lines[1]!.taxFigure, "IVA");
    assert.equal(lines[1]!.taxCategory, null);
    const totals = totalsForInvoiceLines(lines);
    assert.equal(totals.total, -122.1);
    assert.equal(totals.taxTotal, -12.1);
  });

  it("keeps an unknown legacy code without inventing a figure", () => {
    const lines = buildDifferenceLines([{ ...ORIGINAL_PARKING, taxCode: "ES_UNKNOWN_0", taxRate: 0 }], undefined, true);
    assert.equal(lines[0]!.taxFigure, null);
    assert.equal(lines[0]!.taxCode, "ES_UNKNOWN_0");
  });

  it("rejects adjustments that change nothing", () => {
    assert.throws(() => buildDifferenceLines([ORIGINAL_ROOM], [{ lineId: "l1", quantity: 2, unitPrice: 55 }], false), BadRequestError);
    assert.throws(() => buildDifferenceLines([ORIGINAL_ROOM], [{ lineId: "missing", quantity: 1 }], false), BadRequestError);
  });
});

// ── Folio / POS categories ───────────────────────────────────────────────────

describe("taxCategoryForOutlet — POS room charges", () => {
  it("food & beverage outlets vs general services", () => {
    for (const outlet of ["restaurant", "bar", "cafe", "roomservice", "Room_Service", "minibar"]) {
      assert.equal(taxCategoryForOutlet(outlet), "food_beverage", outlet);
    }
    for (const outlet of ["spa", "shop", "laundry", "", null, undefined]) {
      assert.equal(taxCategoryForOutlet(outlet), "general_services", String(outlet));
    }
  });
});

describe("validateFolioLineTaxCategory — optional override validated against the catalogue", () => {
  it("accepts catalogue categories compatible with the line type and returns null when none is requested", () => {
    assert.equal(validateFolioLineTaxCategory("minibar", "food_beverage"), "food_beverage");
    assert.equal(validateFolioLineTaxCategory("adjustment", "accommodation"), "accommodation");
    assert.equal(validateFolioLineTaxCategory("room", undefined), null);
    assert.equal(validateFolioLineTaxCategory("room", ""), null);
  });

  it("rejects unknown categories with a 400", () => {
    assert.throws(() => validateFolioLineTaxCategory("room", "vat_10"), BadRequestError);
    assert.throws(() => validateFolioLineTaxCategory("room", "Accommodation"), BadRequestError);
  });

  it("corrector L3 (FC-4): rejects a catalogue category incompatible with the line type (room as not_subject / tourist_tax; adjustment as not_subject)", () => {
    assert.throws(() => validateFolioLineTaxCategory("room", "not_subject"), /incompatible con el tipo de cargo/);
    assert.throws(() => validateFolioLineTaxCategory("room", "tourist_tax"), /incompatible con el tipo de cargo/);
    assert.throws(() => validateFolioLineTaxCategory("adjustment", "not_subject"), /incompatible con el tipo de cargo/);
  });
});
