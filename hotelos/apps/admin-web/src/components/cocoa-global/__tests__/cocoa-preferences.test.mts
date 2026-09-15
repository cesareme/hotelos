import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_COCOA_PREFERENCES,
  LEGACY_ACCENT_INLINE_PROPERTIES,
  RETIRED_PREFERENCE_KEYS,
  applyPreferencesToRoot,
  clearLegacyAccentOverride,
  hasLegacyAccentOverride,
  isThemePreference,
  normalizePreferences,
  sanitizePreferencePatch,
  type PreferenceRoot
} from "../cocoa-preferences.ts";

// Cocoa 22 (COCOA-22.md §2.1 «Hallazgo bloqueante», §9 rule 14): the accent is
// not a preference; the legacy `accentColor` never reaches <html> nor the API,
// and the inline `--cocoa-accent` of older bundles is removed on apply.

function fakeRoot(initialInline: Record<string, string> = {}): PreferenceRoot & { attrs: Map<string, string>; inline: Map<string, string> } {
  const attrs = new Map<string, string>();
  const inline = new Map<string, string>(Object.entries(initialInline));
  return {
    attrs,
    inline,
    setAttribute: (name, value) => {
      attrs.set(name, value);
    },
    removeAttribute: (name) => {
      attrs.delete(name);
    },
    style: {
      getPropertyValue: (name) => inline.get(name) ?? "",
      removeProperty: (name) => {
        const previous = inline.get(name) ?? "";
        inline.delete(name);
        return previous;
      }
    }
  };
}

describe("cocoa-preferences · shape", () => {
  it("has no accent: the defaults carry theme + a11y flags only and accentColor is retired", () => {
    assert.deepEqual(DEFAULT_COCOA_PREFERENCES, { themePreference: "auto", reducedMotion: false, highContrast: false });
    assert.ok(!("accentColor" in DEFAULT_COCOA_PREFERENCES));
    assert.deepEqual([...RETIRED_PREFERENCE_KEYS], ["accentColor"]);
    assert.deepEqual([...LEGACY_ACCENT_INLINE_PROPERTIES], ["--cocoa-accent", "--cocoa-background-selection"]);
  });

  it("isThemePreference accepts light / dark / auto only", () => {
    assert.ok(isThemePreference("light"));
    assert.ok(isThemePreference("dark"));
    assert.ok(isThemePreference("auto"));
    assert.ok(!isThemePreference("system"));
    assert.ok(!isThemePreference(""));
    assert.ok(!isThemePreference(undefined));
    assert.ok(!isThemePreference(42));
  });
});

describe("cocoa-preferences · normalizePreferences (GET /users/me/preferences)", () => {
  it("drops the legacy accentColor and unknown keys, keeps the known ones", () => {
    const normalized = normalizePreferences({ themePreference: "dark", accentColor: "#007aff", reducedMotion: true, highContrast: false, extra: 1 });
    assert.deepEqual(normalized, { themePreference: "dark", reducedMotion: true, highContrast: false });
    assert.ok(!("accentColor" in normalized));
  });

  it("falls back to the defaults for missing or invalid values and for non-object payloads", () => {
    assert.deepEqual(normalizePreferences({ themePreference: "sepia", reducedMotion: "yes" }), { ...DEFAULT_COCOA_PREFERENCES });
    assert.deepEqual(normalizePreferences(null), { ...DEFAULT_COCOA_PREFERENCES });
    assert.deepEqual(normalizePreferences("nope"), { ...DEFAULT_COCOA_PREFERENCES });
    const custom = { themePreference: "light" as const, reducedMotion: true, highContrast: true };
    assert.deepEqual(normalizePreferences({}, custom), custom);
  });
});

describe("cocoa-preferences · sanitizePreferencePatch (PATCH body)", () => {
  it("never sends accentColor and ignores invalid values", () => {
    assert.deepEqual(sanitizePreferencePatch({ accentColor: "#ff0000" }), {});
    assert.deepEqual(sanitizePreferencePatch({ themePreference: "dark", accentColor: "#ff0000" }), { themePreference: "dark" });
    assert.deepEqual(sanitizePreferencePatch({ themePreference: "sepia", reducedMotion: true }), { reducedMotion: true });
    assert.deepEqual(sanitizePreferencePatch({ highContrast: false }), { highContrast: false });
  });
});

describe("cocoa-preferences · document root", () => {
  it("applyPreferencesToRoot writes the data-* attributes and removes the legacy inline accent", () => {
    const root = fakeRoot({ "--cocoa-accent": "#007aff", "--cocoa-background-selection": "#007aff" });
    assert.ok(hasLegacyAccentOverride(root));
    applyPreferencesToRoot(root, { themePreference: "dark", reducedMotion: true, highContrast: true });
    assert.equal(root.attrs.get("data-theme"), "dark");
    assert.equal(root.attrs.get("data-reduced-motion"), "true");
    assert.equal(root.attrs.get("data-high-contrast"), "true");
    assert.equal(root.inline.size, 0, "inline --cocoa-accent / --cocoa-background-selection removed");
    assert.ok(!hasLegacyAccentOverride(root));
  });

  it("switching the a11y flags off removes their attributes; the theme value is written as is", () => {
    const root = fakeRoot();
    applyPreferencesToRoot(root, { themePreference: "auto", reducedMotion: false, highContrast: false });
    assert.equal(root.attrs.get("data-theme"), "auto");
    assert.ok(!root.attrs.has("data-reduced-motion"));
    assert.ok(!root.attrs.has("data-high-contrast"));
  });

  it("clearLegacyAccentOverride is idempotent and reports whether it removed something", () => {
    const root = fakeRoot({ "--cocoa-accent": "#007aff" });
    assert.equal(clearLegacyAccentOverride(root), true);
    assert.equal(clearLegacyAccentOverride(root), false);
    assert.equal(root.style.getPropertyValue("--cocoa-accent"), "");
  });
});
