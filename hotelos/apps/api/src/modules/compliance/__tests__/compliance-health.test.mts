// Unit tests of the pure parts of the compliance health report (Tanda 6b · R6, t6b#17).
// Pure-core only: no database, no env. Run from apps/api with
//   node --import tsx --test src/modules/compliance/__tests__/compliance-health.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { selectIssuerProperties } from "../compliance-health.service.js";

describe("selectIssuerProperties — who is an issuer in the health report", () => {
  const RA = { id: "RA", kind: "hotel" };
  const LT = { id: "LT", kind: "hotel" };
  const OC = { id: "OC", kind: "office" };
  const WH = { id: "WH", kind: "other" };
  const legacy = { id: "LEGACY", kind: null };

  it("hotels are always issuers; an office or other centre only once it has an active series", () => {
    assert.deepEqual(selectIssuerProperties([RA, LT, OC, WH], new Set()).map((p) => p.id), ["RA", "LT"]);
    assert.deepEqual(selectIssuerProperties([RA, LT, OC, WH], new Set(["OC"])).map((p) => p.id), ["RA", "LT", "OC"]);
    assert.deepEqual(selectIssuerProperties([OC, WH], new Set(["WH", "OC"])).map((p) => p.id), ["OC", "WH"], "input order is kept");
  });

  it("a row without kind (legacy mirror) is a hotel: the column default", () => {
    assert.deepEqual(selectIssuerProperties([legacy, OC], new Set()).map((p) => p.id), ["LEGACY"]);
  });

  it("billing ids that are not in the list never add rows; an empty organization has no issuers", () => {
    assert.deepEqual(selectIssuerProperties([OC], new Set(["RA"])), []);
    assert.deepEqual(selectIssuerProperties([], new Set(["OC"])), []);
  });
});
