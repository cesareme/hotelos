// Rate grid v2 · journal arithmetic (pure): coalescing, inverse patches,
// stale detection and cursor parsing. No Prisma.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { RateChangeJournalItem } from "@hotelos/shared";
import {
  buildRevertPatches,
  coalesceJournalItems,
  isUniqueViolation,
  legacyRevertsJournalId,
  normalizePushStatus,
  parseJournalCursorDate,
  readRevertsJournalId,
  revertReason,
  staleFields,
  staleReason,
  withIdempotentReplay
} from "../journal.core.js";

const BAR = "plan_bar";
const NR = "plan_nr";
const DBL = "rt_dbl";
const D1 = "2027-02-01";
const D2 = "2027-02-02";

const item = (over: Partial<RateChangeJournalItem> & { field: string; before: unknown; after: unknown }): RateChangeJournalItem => ({
  ratePlanId: BAR,
  roomTypeId: DBL,
  date: D1,
  channelId: null,
  ...over
});

describe("coalesceJournalItems", () => {
  it("op + cell on the same cell → ONE price item with the first before and the last after", () => {
    const out = coalesceJournalItems([
      item({ field: "price", before: 105, after: 100 }),
      item({ field: "price", before: 100, after: 111 }),
      item({ field: "price", before: 105, after: 100, date: D2 })
    ]);
    assert.equal(out.length, 2);
    assert.deepEqual(out[0], { ratePlanId: BAR, roomTypeId: DBL, date: D1, channelId: null, field: "price", before: 105, after: 111 });
    assert.deepEqual(out[1], { ratePlanId: BAR, roomTypeId: DBL, date: D2, channelId: null, field: "price", before: 105, after: 100 });
  });
  it("a net no-op (100 → 111 → 100) disappears so changesCount counts real changes", () => {
    const out = coalesceJournalItems([item({ field: "price", before: 100, after: 111 }), item({ field: "price", before: 111, after: 100 })]);
    assert.deepEqual(out, []);
  });
  it("keys include the channel and the field: different channels/fields are never merged", () => {
    const out = coalesceJournalItems([
      item({ field: "minLos", before: null, after: 2, channelId: "ch_a" }),
      item({ field: "minLos", before: null, after: 3, channelId: "ch_b" }),
      item({ field: "closed", before: null, after: true, channelId: "ch_a" })
    ]);
    assert.equal(out.length, 3);
  });
  it("does not mutate the input items", () => {
    const first = item({ field: "price", before: 1, after: 2 });
    coalesceJournalItems([first, item({ field: "price", before: 2, after: 3 })]);
    assert.equal(first.after, 2);
  });
});

describe("buildRevertPatches", () => {
  it("legacy entries with two items for the same (cell, field) revert to the FIRST before, not the intermediate value", () => {
    const patches = buildRevertPatches(
      [item({ field: "price", before: 54.31, after: 100 }), item({ field: "price", before: 100, after: 111 }), item({ field: "price", before: 50.69, after: 100, date: D2 })],
      new Set()
    );
    assert.equal(patches.length, 2);
    const d1 = patches.find((p) => p.date === D1)!;
    assert.equal(d1.price, 54.31);
    assert.deepEqual(d1.expected, { price: 111 });
    const d2 = patches.find((p) => p.date === D2)!;
    assert.equal(d2.price, 50.69);
    assert.deepEqual(d2.expected, { price: 100 });
  });
  it("carries `expected` = the after of every restored field, and omits it with withExpected:false (force)", () => {
    const items = [item({ field: "price", before: 105, after: 111 }), item({ field: "minLos", before: null, after: 2 }), item({ field: "available", before: 5, after: 3, ratePlanId: "*" })];
    const [a, b] = buildRevertPatches(items, new Set());
    assert.deepEqual(a!.expected, { price: 111, restrictions: { minLos: 2 } });
    assert.deepEqual(a!.restrictions, { minLos: null });
    assert.deepEqual(b, { ratePlanId: "*", roomTypeId: DBL, date: D1, available: 5, expected: { available: 3 } });
    for (const p of buildRevertPatches(items, new Set(), { withExpected: false })) assert.equal(p.expected, undefined);
  });
  it("import → manual restores the provenance through restoreSource (no convertToManual on a base plan)", () => {
    const [p] = buildRevertPatches([item({ field: "price", before: 97, after: 120 }), item({ field: "source", before: "import", after: "manual" })], new Set());
    assert.equal(p!.price, 97);
    assert.equal(p!.restoreSource, "import");
    assert.equal(p!.convertToManual, undefined);
    assert.deepEqual(p!.expected, { price: 120, source: "manual" });
  });
  it("a deleted import cell (price → null, source → null) is recreated with its origin", () => {
    const [p] = buildRevertPatches([item({ field: "price", before: 97, after: null }), item({ field: "source", before: "import", after: null })], new Set());
    assert.equal(p!.price, 97);
    assert.equal(p!.restoreSource, "import");
    assert.deepEqual(p!.expected, { price: null, source: null });
  });
  it("manual → derived on a derived plan (override overwritten by respectManualOverrides:false) reverts to the manual price", () => {
    const [p] = buildRevertPatches(
      [item({ ratePlanId: NR, field: "price", before: 150, after: 89.99 }), item({ ratePlanId: NR, field: "source", before: "manual", after: "derived" })],
      new Set([NR])
    );
    assert.equal(p!.price, 150);
    assert.equal(p!.convertToManual, true);
    assert.equal(p!.revertToDerived, undefined);
  });
  it("derived → manual (convertToManual in the original) goes back to derived and drops the price", () => {
    const [p] = buildRevertPatches(
      [item({ ratePlanId: NR, field: "price", before: 89.99, after: 150 }), item({ ratePlanId: NR, field: "source", before: "derived", after: "manual" })],
      new Set([NR])
    );
    assert.equal(p!.revertToDerived, true);
    assert.equal(p!.price, undefined);
    assert.equal(p!.convertToManual, undefined);
  });
  it("derivedPrice items (automatic materialisation) are never replayed", () => {
    assert.deepEqual(buildRevertPatches([item({ ratePlanId: NR, field: "derivedPrice", before: 80, after: 90 })], new Set([NR])), []);
  });
  it("a price restored on a derived plan is written as manual (convertToManual)", () => {
    const [p] = buildRevertPatches([item({ ratePlanId: NR, field: "price", before: 150, after: 160 })], new Set([NR]));
    assert.equal(p!.convertToManual, true);
  });
});

describe("staleFields", () => {
  const current = {
    rate: { price: 111, minPrice: null, maxPrice: null, occupancyPrices: null, source: "manual", updatedAt: new Date("2026-09-15T10:00:00.000Z") },
    available: 3,
    restrictions: { minLos: 2 }
  };
  it("no expected → nothing stale", () => {
    assert.deepEqual(staleFields(undefined, current), []);
  });
  it("matching expected → nothing stale (prices, source, availability, restrictions, stamp)", () => {
    assert.deepEqual(staleFields({ price: 111, source: "manual", available: 3, restrictions: { minLos: 2, maxLos: null }, lastModifiedAt: "2026-09-15T10:00:00.000Z" }, current), []);
  });
  it("a later edit is reported field by field with expected/actual", () => {
    const out = staleFields({ price: 100, restrictions: { minLos: null } }, current);
    assert.deepEqual(out, [
      { field: "price", expected: 100, actual: 111 },
      { field: "minLos", expected: null, actual: 2 }
    ]);
    assert.equal(staleReason(out), "la celda cambió desde que se cargó: precio actual 111,00 € (esperado 100,00 €); estancia mínima actual 2 (esperado sin valor)");
  });
  it("a cell that no longer has a rate is stale for an expected price, and a missing rate matches expected null", () => {
    const empty = { rate: null, available: null, restrictions: {} };
    assert.equal(staleFields({ price: 111 }, empty).length, 1);
    assert.deepEqual(staleFields({ price: null, source: null }, empty), []);
  });
  it("lastModifiedAt compares at millisecond precision", () => {
    assert.equal(staleFields({ lastModifiedAt: "2026-09-15T10:00:00.001Z" }, current).length, 1);
    assert.equal(staleFields({ lastModifiedAt: null }, current).length, 1);
  });
});

// ---- browser-ux-final#8: the conflict reason reads for the hotelier ------------------

describe("staleReason", () => {
  it("prices in es-ES with the property's currency and stamps as Europe/Madrid dates — never «price actual 92» or an ISO stamp", () => {
    const reason = staleReason(
      [
        { field: "price", expected: 91.46, actual: 92 },
        { field: "lastModifiedAt", expected: "2026-09-14T19:59:29.084Z", actual: "2026-09-15T05:43:40.614Z" }
      ],
      "EUR"
    );
    assert.equal(reason, "la celda cambió desde que se cargó: precio actual 92,00 € (esperado 91,46 €); última modificación actual 15/09/2026 07:43:40 (esperado 14/09/2026 21:59:29)");
    assert.doesNotMatch(reason, /price|lastModifiedAt|T\d{2}:\d{2}:\d{2}\.\d{3}Z/);
  });
  it("uses the currency the engine passes (catalog.currency) and defaults to EUR", () => {
    assert.match(staleReason([{ field: "price", expected: 100, actual: 111 }], "USD"), /precio actual 111,00 US\$ \(esperado 100,00 US\$\)/);
    assert.match(staleReason([{ field: "minPrice", expected: null, actual: 80 }]), /precio mínimo actual 80,00 € \(esperado sin valor\)/);
  });
  it("two stamps within the same second show their milliseconds so both sides never read identical", () => {
    const reason = staleReason([{ field: "lastModifiedAt", expected: "2026-09-15T05:43:40.100Z", actual: "2026-09-15T05:43:40.614Z" }]);
    assert.equal(reason, "la celda cambió desde que se cargó: última modificación actual 15/09/2026 07:43:40,614 (esperado 15/09/2026 07:43:40,100)");
  });
  it("labels every field the engine can flag: source, availability, booleans (sí/no), restrictions, occupancy prices", () => {
    assert.match(staleReason([{ field: "source", expected: "manual", actual: "derived" }]), /origen actual derivado \(esperado manual\)/);
    assert.match(staleReason([{ field: "source", expected: "import", actual: "rms" }]), /origen actual RMS \(esperado importado\)/);
    assert.match(staleReason([{ field: "available", expected: 3, actual: null }]), /disponibles actual sin valor \(esperado 3\)/);
    assert.match(staleReason([{ field: "cta", expected: false, actual: true }]), /cerrado a llegada actual sí \(esperado no\)/);
    assert.match(staleReason([{ field: "stopSell", expected: null, actual: true }]), /cierre de venta actual sí \(esperado sin valor\)/);
    assert.match(staleReason([{ field: "maxAdvanceDays", expected: 30, actual: 45 }]), /antelación máxima actual 45 \(esperado 30\)/);
    assert.match(staleReason([{ field: "occupancyPrices", expected: null, actual: { 1: 80, 2: 92.5 } }]), /precios por ocupación actual 1: 80,00 €, 2: 92,50 € \(esperado sin valor\)/);
    assert.match(staleReason([{ field: "price", expected: 50, actual: null }]), /precio actual sin tarifa \(esperado 50,00 €\)/);
  });
  it("caps the list at three fields with an ellipsis and leaves an unknown field key as is", () => {
    const four = ["price", "minLos", "cta", "closed"].map((field) => ({ field, expected: 1, actual: 2 }));
    const reason = staleReason(four);
    assert.match(reason, /…$/);
    assert.doesNotMatch(reason, /cerrado actual/);
    assert.match(staleReason([{ field: "somethingNew", expected: "a", actual: "b" }]), /somethingNew actual b \(esperado a\)/);
  });
  it("never throws on odd input: unparseable stamps and unknown currency codes degrade to text", () => {
    assert.match(staleReason([{ field: "lastModifiedAt", expected: "garbage", actual: null }]), /última modificación actual sin valor \(esperado fecha desconocida\)/);
    assert.match(staleReason([{ field: "price", expected: 1, actual: 2 }], "not-a-code"), /precio actual 2,00 not-a-code \(esperado 1,00 not-a-code\)/);
  });
});

describe("parseJournalCursorDate", () => {
  it("null cursor → null; a valid ISO stamp → Date", () => {
    assert.equal(parseJournalCursorDate(null), null);
    assert.equal(parseJournalCursorDate({ k: "2026-09-15T10:00:00.000Z", id: "x" })!.toISOString(), "2026-09-15T10:00:00.000Z");
  });
  it("a cursor whose key is not a date is a 400, never a Prisma 500", () => {
    assert.throws(() => parseJournalCursorDate({ k: "garbage", id: "x" }), (e: unknown) => (e as { statusCode: number; message: string }).statusCode === 400 && /cursor de paginación/.test((e as Error).message));
  });
});

// ---- cierre 2026-09-15: revert wording, links, push status, idempotent replay ----

describe("revertReason", () => {
  it("reads «Reversión: <motivo original>» — the journal id is no longer part of the text (browser-ux#17/#18)", () => {
    assert.equal(revertReason("Corrección"), "Reversión: Corrección");
    assert.doesNotMatch(revertReason("Corrección"), /cmu|Reversión de/);
  });
  it("appends the body reason after an em dash and copes with a missing or blank original motive", () => {
    assert.equal(revertReason("Evento", "Reversión desde el historial"), "Reversión: Evento — Reversión desde el historial");
    assert.equal(revertReason(null), "Reversión");
    assert.equal(revertReason("   ", "manual"), "Reversión — manual");
    assert.equal(revertReason("  Pickup lento  ", "  "), "Reversión: Pickup lento");
  });
});

describe("legacyRevertsJournalId / readRevertsJournalId", () => {
  it("parses the id out of the pre-cierre wording «Reversión de <id> (<motivo>)»", () => {
    assert.equal(legacyRevertsJournalId("Reversión de cmu1xcl9o00qefy7qtl5wei9e (Corrección)"), "cmu1xcl9o00qefy7qtl5wei9e");
    assert.equal(legacyRevertsJournalId("Reversión de abc_123-x — nota"), "abc_123-x");
  });
  it("new wording, plain edits and empty reasons carry no legacy link", () => {
    assert.equal(legacyRevertsJournalId("Reversión: Corrección"), null);
    assert.equal(legacyRevertsJournalId("Evento"), null);
    assert.equal(legacyRevertsJournalId(null), null);
  });
  it("the stored changesJson.revertsJournalId wins over the wording; the wording is the fallback; otherwise null", () => {
    assert.equal(readRevertsJournalId({ summary: {}, response: {}, revertsJournalId: "j_orig" }, "Reversión: Corrección"), "j_orig");
    assert.equal(readRevertsJournalId({ summary: {}, response: {} }, "Reversión de j_legacy (Corrección)"), "j_legacy");
    assert.equal(readRevertsJournalId({ summary: {}, revertsJournalId: "" }, "Evento"), null);
    assert.equal(readRevertsJournalId(null, "Evento"), null);
    assert.equal(readRevertsJournalId(["not", "an", "object"], null), null);
  });
});

describe("normalizePushStatus", () => {
  it("passes every contract value through and maps anything else to draft", () => {
    for (const v of ["draft", "queued", "pushed", "partial", "failed", "superseded"]) assert.equal(normalizePushStatus(v), v);
    assert.equal(normalizePushStatus("published"), "draft");
    assert.equal(normalizePushStatus(""), "draft");
    assert.equal(normalizePushStatus(null), "draft");
    assert.equal(normalizePushStatus(undefined), "draft");
  });
});

describe("isUniqueViolation", () => {
  const p2002 = (target?: unknown) => ({ code: "P2002", meta: target === undefined ? undefined : { target }, message: "Unique constraint failed" });
  it("recognises P2002 and, given a column, only when the target mentions it", () => {
    assert.equal(isUniqueViolation(p2002(["propertyId", "client_request_id"])), true);
    assert.equal(isUniqueViolation(p2002(["propertyId", "client_request_id"]), "client_request_id"), true);
    assert.equal(isUniqueViolation(p2002("rate_change_journals_propertyId_client_request_id_key"), "client_request_id"), true);
    assert.equal(isUniqueViolation(p2002(["id"]), "client_request_id"), false);
  });
  it("without meta.target the code alone decides (the caller confirms by re-reading)", () => {
    assert.equal(isUniqueViolation(p2002(), "client_request_id"), true);
  });
  it("other Prisma codes, plain errors and non-objects are not unique violations", () => {
    assert.equal(isUniqueViolation({ code: "P2025" }), false);
    assert.equal(isUniqueViolation(new Error("P2002 in the message only")), false);
    assert.equal(isUniqueViolation(null), false);
    assert.equal(isUniqueViolation("P2002"), false);
  });
});

describe("withIdempotentReplay", () => {
  const p2002 = { code: "P2002", meta: { target: ["propertyId", "client_request_id"] } };
  it("returns the write result and never calls replay when the write succeeds", async () => {
    let replays = 0;
    const out = await withIdempotentReplay("rid", async () => "written", async () => {
      replays += 1;
      return "replayed";
    });
    assert.equal(out, "written");
    assert.equal(replays, 0);
  });
  it("a P2002 on client_request_id with a clientRequestId → the entry the other attempt wrote", async () => {
    const out = await withIdempotentReplay("rid", async () => {
      throw p2002;
    }, async () => "replayed");
    assert.equal(out, "replayed");
  });
  it("a P2002 whose entry cannot be found rethrows the ORIGINAL error (never a silent success)", async () => {
    await assert.rejects(
      withIdempotentReplay("rid", async () => {
        throw p2002;
      }, async () => null),
      (e) => e === p2002
    );
  });
  it("without clientRequestId, or with any other error, nothing is replayed", async () => {
    let replays = 0;
    const replay = async () => {
      replays += 1;
      return "replayed";
    };
    await assert.rejects(withIdempotentReplay(null, async () => { throw p2002; }, replay), (e) => e === p2002);
    const boom = new Error("boom");
    await assert.rejects(withIdempotentReplay("rid", async () => { throw boom; }, replay), (e) => e === boom);
    await assert.rejects(withIdempotentReplay("rid", async () => { throw { code: "P2002", meta: { target: ["id"] } }; }, replay));
    assert.equal(replays, 0);
  });
});
