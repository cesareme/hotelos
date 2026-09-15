import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

// qa#9 (Cocoa 22 · ola 9 · lote 9-A): `CocoaKpi.deltaLabel` is nowrap and the
// strip auto-fits tiles down to 180 px (delta row ≈ 156 px at footnote 11 px,
// ≈ 5,4 px per character → 28 characters). Budget 22 leaves room for the
// value's own delta and for the 1440 layout measured in the finding, where
// the 51-character GOPPAR foot overran its 197 px delta (scrollWidth 258).
const MAX_FOOT_CHARS = 22;
const source = readFileSync(new URL("../RoomProfitabilityDashboard.tsx", import.meta.url), "utf8");

describe("Rentabilidad por habitación · pie de los KPI", () => {
  it("paints five KPI tiles with a literal deltaLabel each", () => {
    const feet = [...source.matchAll(/deltaLabel="([^"]*)"/g)].map((m) => m[1]);
    assert.equal(feet.length, 5, `deltaLabel literales: ${feet.length}`);
  });

  it("keeps every deltaLabel within the 180 px tile budget", () => {
    for (const [, foot] of source.matchAll(/deltaLabel="([^"]*)"/g)) {
      assert.ok(foot.length <= MAX_FOOT_CHARS, `deltaLabel «${foot}» tiene ${foot.length} caracteres (máximo ${MAX_FOOT_CHARS})`);
    }
  });
});
