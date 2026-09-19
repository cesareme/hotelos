// createId (fusión T8 · E1): `<prefijo>_` + 16 hex (64 bits aleatorios). Con
// 8 hex (32 bits) la carga OPERA del 2026-09-19 produjo 4 colisiones P2002 en
// audit_events/event_stream. Run from apps/api:
//   node --import tsx --test src/lib/__tests__/ids.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createId, nowIso } from "../ids.js";

describe("createId", () => {
  it("genera `<prefijo>_` + 16 hex en minúsculas", () => {
    assert.match(createId("aud"), /^aud_[0-9a-f]{16}$/);
    assert.match(createId("evt"), /^evt_[0-9a-f]{16}$/);
    assert.match(createId("corr"), /^corr_[0-9a-f]{16}$/);
  });

  it("conserva el prefijo tal cual (también con guion bajo)", () => {
    for (const prefix of ["aud", "evt", "res", "grev_demo", "x"]) {
      const id = createId(prefix);
      assert.ok(id.startsWith(`${prefix}_`), id);
      assert.equal(id.length, prefix.length + 1 + 16);
    }
  });

  it("5.000 ids seguidos son todos distintos", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 5000; i += 1) ids.add(createId("aud"));
    assert.equal(ids.size, 5000);
  });
});

describe("nowIso", () => {
  it("devuelve un instante ISO 8601 en UTC", () => {
    assert.match(nowIso(), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });
});
