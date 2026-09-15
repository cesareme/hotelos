// Rate grid v2 · wire schemas: every 400 speaks Spanish (no zod English
// leaking), `expected` on cells, scope span cap, patch budget, revert body.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MAX_CELLS, MAX_GRID_DAYS, assertPatchBudget, bulkUpdateSchema, gridQuerySchema, parseOr400, revertBodySchema, zodErrorMapEs } from "../rate-grid.schemas.js";

type Http = { statusCode: number; message: string; details?: { code?: string; issues?: Array<{ path: string; message: string }> } };

function fail(fn: () => unknown): Http {
  try {
    fn();
  } catch (e) {
    return e as Http;
  }
  throw new Error("expected a 400");
}

const ENGLISH = /Required|Invalid input|Unrecognized key|must contain|must be (less|greater)|Invalid enum|Expected \w+, received|Invalid literal|Invalid discriminator/;

const cell = { ratePlanId: "plan_bar", roomTypeId: "rt_dbl", date: "2027-02-01" };

describe("parseOr400 · Spanish messages", () => {
  const bad: Array<[string, unknown]> = [
    ["missing reason", { cells: [{ ...cell, price: 100 }] }],
    ["short reason", { cells: [{ ...cell, price: 100 }], reason: "ab" }],
    ["price above MAX_PRICE", { cells: [{ ...cell, price: 60_000 }], reason: "prueba" }],
    ["unknown key", { cells: [{ ...cell, price: 100, expectedX: 1 }], reason: "prueba" }],
    ["copyFrom with value", { ops: [{ scope: { from: "2027-02-01", to: "2027-02-02" }, price: { mode: "copyFrom", fromDate: "2027-01-01", value: 3 } }], reason: "prueba" }],
    ["bad enum (kinds)", { cells: [{ ...cell, price: 100 }], reason: "prueba", publish: { channelIds: ["c1"], kinds: ["maybe"] } }],
    ["wrong type", { cells: "nope", reason: "prueba" }],
    ["bad discriminator", { ops: [{ scope: { from: "2027-02-01", to: "2027-02-02" }, price: { mode: "double", value: 1 } }], reason: "prueba" }],
    ["array too long", { ops: [], cells: [], reason: "prueba" }]
  ];
  for (const [label, body] of bad) {
    it(`${label} → 400 in Spanish`, () => {
      const err = fail(() => parseOr400(bulkUpdateSchema, body, "bulk-update"));
      assert.equal(err.statusCode, 400, label);
      assert.doesNotMatch(err.message, ENGLISH, `${label}: ${err.message}`);
      for (const issue of err.details?.issues ?? []) assert.doesNotMatch(issue.message, ENGLISH, `${label}: ${issue.path} ${issue.message}`);
      assert.equal(err.details?.code, "VALIDATION_ERROR");
    });
  }
  it("the message carries the field path: «bulk-update no válido: reason: obligatorio»", () => {
    const err = fail(() => parseOr400(bulkUpdateSchema, { cells: [{ ...cell, price: 100 }] }, "bulk-update"));
    assert.equal(err.message, "bulk-update no válido: reason: obligatorio");
  });
  it("query with demand=maybe → «valor no admitido», never «Invalid input»", () => {
    const err = fail(() => parseOr400(gridQuerySchema, { from: "2027-02-01", to: "2027-02-02", demand: "maybe" }, "query"));
    assert.match(err.message, /^query no válido: demand: /);
    assert.doesNotMatch(err.message, ENGLISH);
  });
  it("the error map is exported for the other modules (channel-manager, revenue)", () => {
    assert.equal(typeof zodErrorMapEs, "function");
  });
});

describe("cellPatchSchema.expected (optimistic concurrency)", () => {
  it("accepts price (nullable) and lastModifiedAt (ISO with offset) and rejects anything else", () => {
    const ok = parseOr400(
      bulkUpdateSchema,
      { cells: [{ ...cell, price: 100, expected: { price: 97, lastModifiedAt: "2026-09-14T17:29:11.338Z" } }, { ...cell, date: "2027-02-02", price: 100, expected: { price: null } }], reason: "prueba" },
      "bulk-update"
    );
    assert.deepEqual(ok.cells![0]!.expected, { price: 97, lastModifiedAt: "2026-09-14T17:29:11.338Z" });
    const err = fail(() => parseOr400(bulkUpdateSchema, { cells: [{ ...cell, price: 100, expected: { minLos: 2 } }], reason: "prueba" }, "bulk-update"));
    assert.equal(err.statusCode, 400);
    assert.match(err.message, /expected: clave no admitida: 'minLos'/);
  });
});

describe("bulkScopeSchema span cap", () => {
  it(`an op scope wider than ${MAX_GRID_DAYS} days is a 400 (not tens of thousands of upserts in one transaction)`, () => {
    const err = fail(() =>
      parseOr400(bulkUpdateSchema, { ops: [{ scope: { from: "2027-01-01", to: "2028-06-30" }, price: { mode: "percent", value: 1 } }], reason: "prueba" }, "bulk-update")
    );
    assert.match(err.message, new RegExp(`el ámbito no puede superar ${MAX_GRID_DAYS} días`));
    // Exactly MAX_GRID_DAYS days is fine.
    parseOr400(bulkUpdateSchema, { ops: [{ scope: { from: "2027-01-01", to: "2028-01-01" }, price: { mode: "percent", value: 1 } }], reason: "prueba" }, "bulk-update");
  });
});

describe("assertPatchBudget", () => {
  it(`allows up to ${MAX_CELLS} patches and answers 400 TOO_MANY_CELLS above`, () => {
    assertPatchBudget(MAX_CELLS);
    const err = fail(() => assertPatchBudget(MAX_CELLS + 1));
    assert.equal(err.statusCode, 400);
    assert.equal(err.details?.code, "TOO_MANY_CELLS");
    assert.match(err.message, /5001 celdas/);
  });
});

describe("revertBodySchema", () => {
  it("accepts {}, { force }, { reason } and rejects unknown keys in Spanish", () => {
    assert.deepEqual(parseOr400(revertBodySchema, {}, "revert"), {});
    assert.deepEqual(parseOr400(revertBodySchema, { force: true, reason: " motivo " }, "revert"), { force: true, reason: "motivo" });
    const err = fail(() => parseOr400(revertBodySchema, { forced: true }, "revert"));
    assert.equal(err.message, "revert no válido: clave no admitida: 'forced'");
  });
});
