import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { COCOA_TONES, isCocoaTone, sentimentTone, toneBg, toneBorder, toneColor, toneFromStatus, toneInk } from "../cocoa-tones.ts";

describe("cocoa-tones · tokens", () => {
  it("every tone resolves to the --cocoa-tone-* quadruple, never a literal", () => {
    for (const tone of COCOA_TONES) {
      assert.equal(toneColor(tone), `var(--cocoa-tone-${tone})`);
      assert.equal(toneInk(tone), `var(--cocoa-tone-${tone}-text)`);
      assert.equal(toneBg(tone), `var(--cocoa-tone-${tone}-bg)`);
      assert.equal(toneBorder(tone), `var(--cocoa-tone-${tone}-border)`);
      for (const value of [toneColor(tone), toneInk(tone), toneBg(tone), toneBorder(tone)]) {
        assert.doesNotMatch(value, /#[0-9a-f]{3,8}|rgba?\(|hsla?\(/i);
      }
    }
  });
  it("lists the seven tones of §3.11", () => {
    assert.deepEqual([...COCOA_TONES], ["success", "warning", "danger", "info", "neutral", "accent", "ai"]);
  });
});

describe("cocoa-tones · guards and mappings", () => {
  it("isCocoaTone accepts only the seven tones", () => {
    assert.equal(isCocoaTone("success"), true);
    assert.equal(isCocoaTone("ai"), true);
    assert.equal(isCocoaTone("primary"), false);
    assert.equal(isCocoaTone(undefined), false);
    assert.equal(isCocoaTone(3), false);
  });
  it("toneFromStatus maps legacy statuses, case-insensitively, and defaults to neutral", () => {
    assert.equal(toneFromStatus("OK"), "success");
    assert.equal(toneFromStatus("healthy"), "success");
    assert.equal(toneFromStatus("warn"), "warning");
    assert.equal(toneFromStatus("degraded"), "warning");
    assert.equal(toneFromStatus("error"), "danger");
    assert.equal(toneFromStatus("critical"), "danger");
    assert.equal(toneFromStatus("info"), "info");
    assert.equal(toneFromStatus("primary"), "accent");
    assert.equal(toneFromStatus("ai"), "ai");
    assert.equal(toneFromStatus("whatever"), "neutral");
    assert.equal(toneFromStatus(null), "neutral");
    assert.equal(toneFromStatus(undefined), "neutral");
  });
  it("sentimentTone: good → success, bad → danger, neutral → neutral", () => {
    assert.equal(sentimentTone("good"), "success");
    assert.equal(sentimentTone("bad"), "danger");
    assert.equal(sentimentTone("neutral"), "neutral");
  });
});
