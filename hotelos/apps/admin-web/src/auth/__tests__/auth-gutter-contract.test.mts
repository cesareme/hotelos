import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Regression contract of lote fix:1-A (qa#16): the public auth frames (AuthShell
// and the login) share the app's content gutter, `--cocoa-content-padding`
// (COCOA-22.md §5.1: 24 px at ≥ 600, 16 px on phones), instead of a fixed
// space-5. Source-level: no browser is needed to pin the 24 → 16 cascade.
const SRC = fileURLToPath(new URL("../../", import.meta.url));
/** Source without comments (only code is checked). */
const stripComments = (source: string) =>
  source
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");
const read = (rel: string) => stripComments(readFileSync(join(SRC, rel), "utf8"));

const AUTH_FRAMES = ["auth/AuthShell.tsx", "screens/auth/LoginScreen.tsx"];

describe("auth · gutter de teléfono en las pantallas de acceso (qa#16)", () => {
  it("los marcos de acceso usan --cocoa-content-padding, no un space-5 fijo", () => {
    for (const rel of AUTH_FRAMES) {
      const source = read(rel);
      assert.match(source, /padding: "var\(--cocoa-content-padding\)"/, rel);
      assert.match(source, /paddingBottom: "max\(var\(--cocoa-content-padding\), env\(safe-area-inset-bottom\)\)"/, rel);
      assert.doesNotMatch(source, /padding(?:Bottom)?: "(?:max\()?var\(--cocoa-space-5\)/, `${rel}: fixed 24 px gutter`);
    }
  });

  it("el token resuelve 24 px en escritorio y 16 px por debajo de 600 (spec §5.1)", () => {
    const tokens = readFileSync(join(SRC, "styles/cocoa-tokens.css"), "utf8");
    assert.match(tokens, /--cocoa-space-4:\s*16px;/);
    assert.match(tokens, /--cocoa-space-5:\s*24px;/);
    assert.match(tokens, /--cocoa-content-padding:\s*var\(--cocoa-space-5\);/);
    const phone = tokens.match(/@media \(max-width: 599px\) \{\s*:root \{([^}]*)\}/);
    assert.ok(phone, "phone override of :root is missing");
    assert.match(phone[1], /--cocoa-content-padding:\s*var\(--cocoa-space-4\);/);
  });

  it("el marco de acceso comparte el gutter de main.cocoa-content (criterio V2)", () => {
    const layout = readFileSync(join(SRC, "styles/cocoa-22-layout.css"), "utf8");
    const block = layout.match(/\.cocoa-content \{([^}]*)\}/);
    assert.ok(block, ".cocoa-content rule is missing");
    assert.match(block[1], /padding: var\(--cocoa-content-padding\);/);
    assert.match(block[1], /padding-bottom: max\(var\(--cocoa-content-padding\), env\(safe-area-inset-bottom\)\);/);
  });
});
