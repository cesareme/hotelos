import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEV_MODE_SESSION_KEY, devModeStorageValue, devModeTransition } from "../dev-mode.ts";
import { DEV_MODE_STORAGE_KEY, devQueryFrom, isDevModeEnabled } from "../nav-tree.ts";

// Tanda 5 · L1c (code-review#3): ONE dev-mode source. `?dev=1` enters the mode
// for the tab, `?dev=0` leaves it, the URL written by key keeps `?dev=1`, and
// the guard reads the permanent flag first, then the tab flag.

describe("dev-mode · transitions from the query", () => {
  it("?dev=1 enters, ?dev=0 leaves, anything else keeps the current state", () => {
    assert.equal(devModeTransition("?dev=1"), "enter");
    assert.equal(devModeTransition("dev=1&x=2"), "enter");
    assert.equal(devModeTransition("?x=2&dev=0"), "leave");
    assert.equal(devModeTransition("?dev=true"), "keep");
    assert.equal(devModeTransition(""), "keep");
    assert.equal(devModeTransition(null), "keep");
  });

  it("the permanent flag (localStorage) wins over the tab flag (sessionStorage)", () => {
    assert.equal(devModeStorageValue("1", null), "1");
    assert.equal(devModeStorageValue(null, "1"), "1");
    assert.equal(devModeStorageValue("0", "1"), "1");
    assert.equal(devModeStorageValue(null, null), null);
    assert.ok(isDevModeEnabled({ search: "", storageValue: devModeStorageValue(null, "1") }));
    assert.ok(!isDevModeEnabled({ search: "", storageValue: devModeStorageValue(null, null) }));
    assert.notEqual(DEV_MODE_SESSION_KEY, DEV_MODE_STORAGE_KEY, "the tab flag never overwrites the permanent one");
  });
});

describe("dev-mode · the switch travels with the URLs written by key", () => {
  it("devQueryFrom keeps only ?dev=1 (filters of one screen mean nothing on another)", () => {
    assert.equal(devQueryFrom("?dev=1"), "?dev=1");
    assert.equal(devQueryFrom("?from=2026-09-15&dev=1&status=open"), "?dev=1");
    assert.equal(devQueryFrom("?from=2026-09-15"), "");
    assert.equal(devQueryFrom("?dev=0"), "");
    assert.equal(devQueryFrom(""), "");
    assert.equal(devQueryFrom(null), "");
  });
});
