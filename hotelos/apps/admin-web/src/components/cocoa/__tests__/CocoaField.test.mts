import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FORM_ROW_GAP_PX, describedBy, formRowColumns, resolveControlId } from "../CocoaField.tsx";

describe("CocoaField · aria-describedby", () => {
  it("joins the external id, then the error, then the help", () => {
    assert.equal(describedBy({ help: "f-help", error: "f-error", external: "note" }), "note f-error f-help");
    assert.equal(describedBy({ help: "f-help" }), "f-help");
    assert.equal(describedBy({ error: "f-error", help: null }), "f-error");
  });
  it("is undefined when there is nothing to describe", () => {
    assert.equal(describedBy({}), undefined);
    assert.equal(describedBy({ help: null, error: undefined, external: "" }), undefined);
  });
});

describe("CocoaField · label ↔ control id (review#18)", () => {
  it("an explicit htmlFor wins, then the child's own id, then the generated one", () => {
    assert.equal(resolveControlId("given", "child-id", "gen"), "given");
    assert.equal(resolveControlId(undefined, "guest-search", "gen"), "guest-search");
    assert.equal(resolveControlId(undefined, undefined, "gen"), "gen");
  });
  it("ignores a non-string or empty child id (never points the label at a missing node)", () => {
    assert.equal(resolveControlId(undefined, "", "gen"), "gen");
    assert.equal(resolveControlId(undefined, 42, "gen"), "gen");
    assert.equal(resolveControlId(undefined, null, "gen"), "gen");
  });
});

describe("CocoaFormRow · columns by CONTAINER width (§3.8, review#2)", () => {
  it("keeps the request until the container is measured (desktop-first paint; CSS covers phones)", () => {
    assert.equal(formRowColumns(2, { width: null }), 2);
    assert.equal(formRowColumns(4, { width: null }), 4);
  });
  it("drops columns as the container narrows: 2 × 240 + 12 fits in 492 px, not in 491", () => {
    assert.equal(FORM_ROW_GAP_PX, 12);
    assert.equal(formRowColumns(2, { width: 492, min: 240 }), 2);
    assert.equal(formRowColumns(2, { width: 491, min: 240 }), 1);
    assert.equal(formRowColumns(2, { width: 300, min: 240 }), 1); // the 300 px probe of the review
    assert.equal(formRowColumns(2, { width: 312, min: 240 }), 1); // drawer sm: 360 − 48 padding
  });
  it("never exceeds the request nor goes below one column", () => {
    assert.equal(formRowColumns(2, { width: 1120, min: 240 }), 2);
    assert.equal(formRowColumns(4, { width: 1120, min: 240 }), 4);
    assert.equal(formRowColumns(3, { width: 700, min: 240 }), 2);
    assert.equal(formRowColumns(1, { width: 1120, min: 240 }), 1);
    assert.equal(formRowColumns(4, { width: 0, min: 240 }), 1);
  });
  it("honours a custom minimum and gap", () => {
    assert.equal(formRowColumns(3, { width: 700, min: 220, gap: 12 }), 3);
    assert.equal(formRowColumns(3, { width: 700, min: 220, gap: 40 }), 2);
  });
});
