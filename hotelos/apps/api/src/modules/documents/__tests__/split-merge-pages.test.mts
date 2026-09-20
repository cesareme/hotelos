// Unit tests · Tanda T9 · corrector RV-01 / RV-03 — índice lógico de páginas de un
// split (split-merge.service.ts: splitSourcePages + normalizeSplitRanges). Puro,
// sin Postgres. Desde apps/api:
//   node --import tsx --test src/modules/documents/__tests__/split-merge-pages.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { HttpError } from "../../../lib/http-error.js";
import { normalizeSplitRanges, splitSourcePages } from "../split-merge.service.js";

describe("splitSourcePages · páginas físicas de cada trozo y las que quedan en el origen", () => {
  it("documento entero (sin índice): [[1,1],[3,3]] de 4 páginas → trozos [1] y [3], origen [2, 4]", () => {
    const out = splitSourcePages(null, 4, normalizeSplitRanges([[3, 3], [1, 1]], 4));
    assert.deepEqual(out.pieces, [[1], [3]]);
    assert.deepEqual(out.remaining, [2, 4]);
  });

  it("trozo de un trozo: el rango lógico se traduce al índice físico heredado", () => {
    // El origen ya era el trozo físico [3, 4, 5] de un lote; sus páginas lógicas son 1..3.
    const out = splitSourcePages([3, 4, 5], 3, normalizeSplitRanges([[2, 3]], 3));
    assert.deepEqual(out.pieces, [[4, 5]]);
    assert.deepEqual(out.remaining, [3]);
  });

  it("todas las páginas repartidas → remaining vacío (el origen se archiva absorbido, RV-03)", () => {
    const out = splitSourcePages(null, 3, normalizeSplitRanges([[1, 1], [2, 3]], 3));
    assert.deepEqual(out.pieces, [[1], [2, 3]]);
    assert.deepEqual(out.remaining, []);
  });

  it("normalizeSplitRanges: fuera de rango, solapes, from > to y el rango único que lo cubre todo → 400 VALIDATION_ERROR", () => {
    for (const ranges of [[[1, 4]], [[2, 1]], [[1, 2], [2, 3]], [[1, 3]]] as Array<Array<[number, number]>>) {
      assert.throws(() => normalizeSplitRanges(ranges, 3), (error: HttpError) => error.statusCode === 400 && (error.details as { code: string }).code === "VALIDATION_ERROR");
    }
    assert.deepEqual(normalizeSplitRanges([[3, 3], [1, 2]], 4), [{ from: 1, to: 2 }, { from: 3, to: 3 }]);
  });
});
