import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { badgeTokens } from "../CocoaBadge.tsx";
import { COCOA_TONES } from "../cocoa-tones.ts";

describe("CocoaBadge · tokens (§3.11)", () => {
  it("outline: transparent, tone hue border, tone INK text (AA at 10 px)", () => {
    assert.deepEqual(badgeTokens("success", "outline"), {
      color: "var(--cocoa-tone-success-text)",
      background: "transparent",
      border: "var(--cocoa-tone-success)"
    });
  });
  it("tinted: tone wash + tone border + tone ink", () => {
    assert.deepEqual(badgeTokens("warning", "tinted"), {
      color: "var(--cocoa-tone-warning-text)",
      background: "var(--cocoa-tone-warning-bg)",
      border: "var(--cocoa-tone-warning-border)"
    });
  });
  it("dot: no box, label text, dot in the tone hue", () => {
    assert.deepEqual(badgeTokens("danger", "dot"), {
      color: "var(--cocoa-label)",
      background: "transparent",
      border: "transparent",
      dot: "var(--cocoa-tone-danger)"
    });
  });
  it("never yields a literal colour for any tone/variant", () => {
    for (const tone of COCOA_TONES) {
      for (const variant of ["outline", "tinted", "dot"] as const) {
        const tokens = badgeTokens(tone, variant);
        for (const value of Object.values(tokens)) {
          assert.doesNotMatch(String(value), /#[0-9a-f]{3,8}|rgba?\(|hsla?\(/i);
        }
      }
    }
  });
});
