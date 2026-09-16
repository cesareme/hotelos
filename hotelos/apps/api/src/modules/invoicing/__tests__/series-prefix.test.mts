// Unit tests for the series-prefix guard (Tanda 6b · L1 · R3). Pure core plus
// an in-memory fake of the two Prisma delegates the guard reads. Run from
// apps/api with
//   node --import tsx --test src/modules/invoicing/__tests__/series-prefix.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  SERIES_PREFIX_CLASH_CODE,
  assertSeriesPrefixFree,
  defaultSeriesPrefix,
  findPrefixClash,
  listSiblingPropertyIds,
  normalizeSeriesPrefix,
  seriesPrefixClashError,
  type SeriesDb,
  type SeriesPrefixRow
} from "../series-prefix.service.js";
import { ConflictError } from "../../../lib/http-error.js";

const RIAS_ALTAS = "cmrhw9jy40003fyvbuu2ec2w7";
const LOS_TILOS = "cmu1mifcp0000fyo1wzvq7txo";
const OFFICE = "prop_office";

const rows: SeriesPrefixRow[] = [
  { id: "seq_ra_fac", propertyId: RIAS_ALTAS, prefix: "FAC-RA-2026-", year: 2026, active: true },
  { id: "seq_ra_old", propertyId: RIAS_ALTAS, prefix: "FAC-2026-", year: 2026, active: false },
  { id: "seq_lt_fac", propertyId: LOS_TILOS, prefix: "FAC-LT-2026-", year: 2026, active: true },
  { id: "seq_lt_legacy", propertyId: LOS_TILOS, prefix: "REC-2026-", year: null, active: true }
];

describe("findPrefixClash (pure)", () => {
  it("is case-insensitive and ignores surrounding spaces", () => {
    assert.equal(normalizeSeriesPrefix("  fac-ra-2026- "), "FAC-RA-2026-");
    const clash = findPrefixClash(rows, { propertyId: LOS_TILOS, prefix: "fac-ra-2026-", year: 2026 });
    assert.equal(clash?.id, "seq_ra_fac");
  });
  it("never clashes with the property's own rows, with closed series or with another year", () => {
    assert.equal(findPrefixClash(rows, { propertyId: RIAS_ALTAS, prefix: "FAC-RA-2026-", year: 2026 }), null, "own row");
    assert.equal(findPrefixClash(rows, { propertyId: LOS_TILOS, prefix: "FAC-2026-", year: 2026 }), null, "closed series of Rías Altas");
    assert.equal(findPrefixClash(rows, { propertyId: LOS_TILOS, prefix: "FAC-RA-2027-", year: 2027 }), null, "other prefix");
    assert.equal(findPrefixClash([{ id: "x", propertyId: RIAS_ALTAS, prefix: "FS-2026-", year: 2026, active: true }], { propertyId: LOS_TILOS, prefix: "FS-2026-", year: 2027 }), null, "same prefix text, different year");
  });
  it("a legacy row without year clashes on the prefix alone; excludeSequenceId skips the row being edited; empty prefix never clashes", () => {
    assert.equal(findPrefixClash(rows, { propertyId: RIAS_ALTAS, prefix: "REC-2026-", year: 2026 })?.id, "seq_lt_legacy");
    assert.equal(findPrefixClash(rows, { propertyId: RIAS_ALTAS, prefix: "REC-2026-", year: 2026, excludeSequenceId: "seq_lt_legacy" }), null);
    assert.equal(findPrefixClash(rows, { propertyId: RIAS_ALTAS, prefix: "   ", year: 2026 }), null);
  });
});

describe("seriesPrefixClashError", () => {
  it("is a 409 with typed details naming the conflicting centre", () => {
    const error = seriesPrefixClashError(rows[0]!, { propertyId: LOS_TILOS, prefix: "FAC-RA-2026-", year: 2026 });
    assert.ok(error instanceof ConflictError);
    assert.equal(error.statusCode, 409);
    assert.deepEqual(error.details, { code: SERIES_PREFIX_CLASH_CODE, prefix: "FAC-RA-2026-", year: 2026, conflictingPropertyId: RIAS_ALTAS, conflictingSequenceId: "seq_ra_fac" });
    assert.match(error.message, /FAC-RA-2026-/);
    assert.match(error.message, /misma sociedad/);
  });
});

type FakeProperty = { id: string; organizationId: string; legalEntityId: string | null };

function fakeDb(properties: FakeProperty[], sequences: SeriesPrefixRow[]) {
  const seen: { where: unknown }[] = [];
  const db = {
    property: {
      findUnique: async (args: { where: { id: string } }) => properties.find((p) => p.id === args.where.id) ?? null,
      findMany: async (args: { where: { legalEntityId?: string; organizationId?: string; id: { not: string } } }) => {
        seen.push(args);
        return properties
          .filter((p) => p.id !== args.where.id.not)
          .filter((p) => (args.where.legalEntityId ? p.legalEntityId === args.where.legalEntityId : p.organizationId === args.where.organizationId))
          .map((p) => ({ id: p.id }));
      }
    },
    invoiceSequence: {
      findMany: async (args: { where: { propertyId: { in: string[] }; active: boolean } }) => sequences.filter((s) => args.where.propertyId.in.includes(s.propertyId) && s.active === args.where.active)
    }
  };
  return { db: db as unknown as SeriesDb, seen };
}

describe("assertSeriesPrefixFree (fake database)", () => {
  const backfilled: FakeProperty[] = [
    { id: RIAS_ALTAS, organizationId: "org_faranda", legalEntityId: "le_faranda" },
    { id: LOS_TILOS, organizationId: "org_faranda", legalEntityId: "le_faranda" },
    { id: OFFICE, organizationId: "org_faranda", legalEntityId: "le_faranda" },
    { id: "prop_other_entity", organizationId: "org_faranda", legalEntityId: "le_other" }
  ];

  it("siblings are the other centres of the SAME legal entity once backfilled, the organisation before", async () => {
    const { db, seen } = fakeDb(backfilled, rows);
    assert.deepEqual((await listSiblingPropertyIds(RIAS_ALTAS, db)).sort(), [OFFICE, LOS_TILOS].sort());
    assert.ok("legalEntityId" in (seen[0] as { where: Record<string, unknown> }).where);
    const pre = fakeDb([{ id: "a", organizationId: "org_x", legalEntityId: null }, { id: "b", organizationId: "org_x", legalEntityId: null }, { id: "c", organizationId: "org_y", legalEntityId: null }], []);
    assert.deepEqual(await listSiblingPropertyIds("a", pre.db), ["b"]);
    assert.deepEqual(await listSiblingPropertyIds("missing", pre.db), []);
  });

  it("rejects a prefix a sister centre already uses in that year and resolves when it is free", async () => {
    const { db } = fakeDb(backfilled, rows);
    await assert.rejects(assertSeriesPrefixFree({ propertyId: LOS_TILOS, prefix: "fac-ra-2026-", year: 2026 }, db), (error: unknown) => {
      assert.ok(error instanceof ConflictError);
      assert.equal((error.details as { code: string; conflictingPropertyId: string }).code, SERIES_PREFIX_CLASH_CODE);
      assert.equal((error.details as { conflictingPropertyId: string }).conflictingPropertyId, RIAS_ALTAS);
      return true;
    });
    await assertSeriesPrefixFree({ propertyId: LOS_TILOS, prefix: "FAC-LT-2026-", year: 2026 }, db);
    await assertSeriesPrefixFree({ propertyId: LOS_TILOS, prefix: "FAC-2026-", year: 2026 }, db);
    await assertSeriesPrefixFree({ propertyId: LOS_TILOS, prefix: "FAC-RA-2027-", year: 2027 }, db);
  });

  it("a single hotel (no siblings) is never checked: FAC-<año>- stays untouched", async () => {
    const { db } = fakeDb([{ id: "solo", organizationId: "org_solo", legalEntityId: "le_solo" }], [{ id: "s", propertyId: "elsewhere", prefix: "FAC-2026-", year: 2026, active: true }]);
    await assertSeriesPrefixFree({ propertyId: "solo", prefix: "FAC-2026-", year: 2026 }, db);
  });
});

describe("defaultSeriesPrefix (R3)", () => {
  it("one billing centre → FAC-2026-; several → FAC-RA-2026-; several without a code → plain form", () => {
    assert.equal(defaultSeriesPrefix({ series: "FAC", year: 2026, propertyCode: "RA", billingCentres: 1 }), "FAC-2026-");
    assert.equal(defaultSeriesPrefix({ series: "fac", year: 2026, propertyCode: "ra", billingCentres: 2 }), "FAC-RA-2026-");
    assert.equal(defaultSeriesPrefix({ series: "R", year: 2026, propertyCode: "LT", billingCentres: 8 }), "R-LT-2026-");
    assert.equal(defaultSeriesPrefix({ series: "FS", year: 2026, propertyCode: null, billingCentres: 3 }), "FS-2026-");
  });
});
