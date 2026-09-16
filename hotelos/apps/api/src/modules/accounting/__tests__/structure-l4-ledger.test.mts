// Unit tests · Tanda 6b · L4 «Libro, retenciones, nóminas, tesorería» — the
// pure parts of the work-centre rule (design §5.2 R4), the centre-of-the-
// organisation guard (R10.1, fix:L4 t6b#6) and the entity-scoped fiscal
// calendar. No database. Run from apps/api with
//   node --import tsx --test src/modules/accounting/__tests__/structure-l4-ledger.test.mts
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { HttpError } from "../../../lib/http-error.js";
import {
  WORK_CENTER_EXEMPT_ENTRY_KINDS,
  WORK_CENTER_EXEMPT_SOURCE_TYPES,
  assertWorkCenter,
  linesRequireWorkCenter,
  requireJournalWorkCenter,
  workCenterRequired,
  type JournalWorkCenterDb
} from "../accounting.service.js";
import { assertEntityScopedFiscalInput } from "../fiscal-period.service.js";

/** In-memory `property.findUnique` standing in for Prisma (root client or interactive transaction). */
function fakePropertyDb(rows: Array<{ id: string; organizationId: string; kind: string }>): JournalWorkCenterDb & { lookups: string[] } {
  const lookups: string[] = [];
  const property = {
    findUnique: async ({ where }: { where: { id: string } }) => {
      lookups.push(where.id);
      return rows.find((row) => row.id === where.id) ?? null;
    }
  };
  return { property, lookups } as unknown as JournalWorkCenterDb & { lookups: string[] };
}

describe("R10.1 · requireJournalWorkCenter (fix:L4 t6b#6) — the centre of an asiento belongs to the posting organisation", () => {
  const db = () => fakePropertyDb([
    { id: "prop_hotel_a", organizationId: "org_a", kind: "hotel" },
    { id: "prop_office_a", organizationId: "org_a", kind: "office" },
    { id: "prop_123", organizationId: "org_123", kind: "hotel" }
  ]);

  it("returns the centre (id, kind) of the same organisation — the office included", async () => {
    assert.deepEqual(await requireJournalWorkCenter(db(), "org_a", "prop_hotel_a"), { id: "prop_hotel_a", kind: "hotel" });
    assert.deepEqual(await requireJournalWorkCenter(db(), "org_a", "prop_office_a"), { id: "prop_office_a", kind: "office" });
  });

  it("a centre of ANOTHER organisation → opaque 404 PROPERTY_NOT_FOUND (same status as the tenant hook; never 403, never 409)", async () => {
    await assert.rejects(
      requireJournalWorkCenter(db(), "org_a", "prop_123"),
      (error: unknown) => {
        assert.ok(error instanceof HttpError, String(error));
        assert.equal(error.statusCode, 404);
        assert.deepEqual(error.details, { propertyId: "prop_123", code: "PROPERTY_NOT_FOUND" });
        assert.equal(error.message, "Propiedad no encontrada.", "the message does not say the centre exists elsewhere");
        return true;
      }
    );
  });

  it("an unknown centre gets the very same answer as a foreign one (no oracle)", async () => {
    const foreign = await requireJournalWorkCenter(db(), "org_a", "prop_123").catch((e: HttpError) => e);
    const missing = await requireJournalWorkCenter(db(), "org_a", "prop_nope").catch((e: HttpError) => e);
    assert.ok(foreign instanceof HttpError && missing instanceof HttpError);
    assert.equal(foreign.statusCode, missing.statusCode);
    assert.equal(foreign.message, missing.message);
    assert.equal((foreign.details as { code: string }).code, (missing.details as { code: string }).code);
  });

  it("no centre (null / undefined / empty) → null without touching the database: an asiento of the sociedad is R4's business", async () => {
    const fake = db();
    assert.equal(await requireJournalWorkCenter(fake, "org_a", null), null);
    assert.equal(await requireJournalWorkCenter(fake, "org_a", undefined), null);
    assert.equal(await requireJournalWorkCenter(fake, "org_a", ""), null);
    assert.deepEqual(fake.lookups, []);
  });

  it("looks the centre up exactly once per call (one query inside the posting transaction)", async () => {
    const fake = db();
    await requireJournalWorkCenter(fake, "org_a", "prop_hotel_a");
    assert.deepEqual(fake.lookups, ["prop_hotel_a"]);
  });
});

const expense = [{ accountCode: "628" }, { accountCode: "572" }];
const income = [{ accountCode: "4300" }, { accountCode: "705.1" }];
const balanceOnly = [{ accountCode: "572" }, { accountCode: "570" }];
const mixedVat = [{ accountCode: "472.21" }, { accountCode: "477.21" }, { accountCode: "4750" }];

function details(fn: () => void): { statusCode: number; details: Record<string, unknown> } {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof HttpError, `expected an HttpError, got ${String(error)}`);
    return { statusCode: error.statusCode, details: (error.details ?? {}) as Record<string, unknown> };
  }
  assert.fail("expected the guard to throw");
}

describe("R4 · linesRequireWorkCenter (grupos 6 y 7)", () => {
  it("detects group 6 and 7 lines by the first digit of the PGC code and nothing else", () => {
    assert.equal(linesRequireWorkCenter(expense), true);
    assert.equal(linesRequireWorkCenter(income), true);
    assert.equal(linesRequireWorkCenter([{ accountCode: " 705.3 " }]), true, "whitespace is trimmed");
    assert.equal(linesRequireWorkCenter(balanceOnly), false);
    assert.equal(linesRequireWorkCenter(mixedVat), false, "472/477/4750 are group 4");
    assert.equal(linesRequireWorkCenter([{ accountCode: "129" }, { accountCode: "113" }]), false, "groups 1-5 never need a centre (rule not extended to 2/3)");
    assert.equal(linesRequireWorkCenter([]), false);
  });
});

describe("R4 · workCenterRequired (pure decision)", () => {
  it("requires a centre for a normal entry with 6/7 lines and no propertyId", () => {
    assert.equal(workCenterRequired({ propertyId: null, entryKind: "normal", sourceType: "manual", lines: expense }), true);
    assert.equal(workCenterRequired({ propertyId: undefined, entryKind: undefined, sourceType: "supplier_bill", lines: income }), true);
    assert.equal(workCenterRequired({ propertyId: "", entryKind: "normal", sourceType: "payroll_slip", lines: [{ accountCode: "640" }, { accountCode: "465" }] }), true, "an empty string is no centre");
  });

  it("is satisfied by any centre — the office included — and by balance-sheet-only entries", () => {
    assert.equal(workCenterRequired({ propertyId: "prop_office", entryKind: "normal", sourceType: "manual", lines: expense }), false);
    assert.equal(workCenterRequired({ propertyId: null, entryKind: "normal", sourceType: "manual", lines: balanceOnly }), false);
    assert.equal(workCenterRequired({ propertyId: null, entryKind: "normal", sourceType: "payroll_payment", lines: [{ accountCode: "465" }, { accountCode: "572" }] }), false);
  });

  it("exempts regularización, cierre, apertura, anulación and the VAT settlement", () => {
    assert.deepEqual([...WORK_CENTER_EXEMPT_ENTRY_KINDS], ["regularization", "closing", "opening", "reversal"]);
    assert.deepEqual([...WORK_CENTER_EXEMPT_SOURCE_TYPES], ["vat_settlement"]);
    for (const entryKind of WORK_CENTER_EXEMPT_ENTRY_KINDS) {
      assert.equal(workCenterRequired({ propertyId: null, entryKind, sourceType: entryKind, lines: [...expense, ...income] }), false, entryKind);
    }
    assert.equal(workCenterRequired({ propertyId: null, entryKind: "normal", sourceType: "vat_settlement", lines: expense }), false);
  });

  it("exempts a manual entry flagged societyLevel, and only a manual one", () => {
    assert.equal(workCenterRequired({ propertyId: null, entryKind: "normal", sourceType: "manual", societyLevel: true, lines: expense }), false);
    assert.equal(workCenterRequired({ propertyId: null, entryKind: "normal", sourceType: "manual", societyLevel: false, lines: expense }), true);
    assert.equal(workCenterRequired({ propertyId: null, entryKind: "normal", sourceType: "supplier_bill", societyLevel: true, lines: expense }), true, "a document-driven writer cannot opt out");
  });
});

describe("R4 · assertWorkCenter → 400 WORK_CENTER_REQUIRED (gated by STRUCTURE_ENABLED)", () => {
  const previous = process.env.STRUCTURE_ENABLED;
  afterEach(() => {
    if (previous === undefined) delete process.env.STRUCTURE_ENABLED;
    else process.env.STRUCTURE_ENABLED = previous;
  });

  it("throws a typed 400 naming the offending lines (1-based)", () => {
    delete process.env.STRUCTURE_ENABLED;
    const error = details(() => assertWorkCenter({ propertyId: null, entryKind: "normal", sourceType: "manual", lines: [{ accountCode: "572" }, { accountCode: "628" }, { accountCode: "705.1" }] }));
    assert.equal(error.statusCode, 400);
    assert.equal(error.details.code, "WORK_CENTER_REQUIRED");
    assert.deepEqual(error.details.lines, [2, 3]);
    assert.equal(error.details.entryKind, "normal");
    assert.equal(error.details.sourceType, "manual");
  });

  it("does nothing when a centre is given or the rule does not apply", () => {
    delete process.env.STRUCTURE_ENABLED;
    assert.doesNotThrow(() => assertWorkCenter({ propertyId: "prop_1", entryKind: "normal", sourceType: "manual", lines: expense }));
    assert.doesNotThrow(() => assertWorkCenter({ propertyId: null, entryKind: "closing", sourceType: "closing", lines: expense }));
    assert.doesNotThrow(() => assertWorkCenter({ propertyId: null, entryKind: "normal", sourceType: "manual", societyLevel: true, lines: expense }));
  });

  it("STRUCTURE_ENABLED=false restores the pre-Tanda-6b behaviour (rollback switch)", () => {
    process.env.STRUCTURE_ENABLED = "false";
    assert.doesNotThrow(() => assertWorkCenter({ propertyId: null, entryKind: "normal", sourceType: "manual", lines: expense }));
    process.env.STRUCTURE_ENABLED = "true";
    assert.throws(() => assertWorkCenter({ propertyId: null, entryKind: "normal", sourceType: "manual", lines: expense }), HttpError);
  });
});

describe("R4 · assertEntityScopedFiscalInput → 400 FISCAL_YEAR_IS_ENTITY_SCOPED", () => {
  const previous = process.env.STRUCTURE_ENABLED;
  afterEach(() => {
    if (previous === undefined) delete process.env.STRUCTURE_ENABLED;
    else process.env.STRUCTURE_ENABLED = previous;
  });

  it("accepts the sociedad scope (no propertyId) and refuses a centre for years and periods", () => {
    delete process.env.STRUCTURE_ENABLED;
    assert.doesNotThrow(() => assertEntityScopedFiscalInput(undefined, "ejercicio"));
    assert.doesNotThrow(() => assertEntityScopedFiscalInput(null, "periodo"));
    assert.doesNotThrow(() => assertEntityScopedFiscalInput("", "ejercicio"));
    const year = details(() => assertEntityScopedFiscalInput("prop_123", "ejercicio"));
    assert.equal(year.statusCode, 400);
    assert.deepEqual(year.details, { code: "FISCAL_YEAR_IS_ENTITY_SCOPED", subject: "ejercicio", propertyId: "prop_123" });
    const period = details(() => assertEntityScopedFiscalInput("prop_123", "periodo"));
    assert.equal(period.details.code, "FISCAL_YEAR_IS_ENTITY_SCOPED");
    assert.equal(period.details.subject, "periodo");
  });

  it("the messages are Spanish and name the «Sociedad» scope", () => {
    delete process.env.STRUCTURE_ENABLED;
    assert.throws(() => assertEntityScopedFiscalInput("prop_123", "ejercicio"), /ejercicios fiscales son de la sociedad.*«Sociedad»/);
    assert.throws(() => assertEntityScopedFiscalInput("prop_123", "periodo"), /periodos fiscales son de la sociedad/);
  });

  it("is switched off with STRUCTURE_ENABLED=false", () => {
    process.env.STRUCTURE_ENABLED = "0";
    assert.doesNotThrow(() => assertEntityScopedFiscalInput("prop_123", "ejercicio"));
  });
});
