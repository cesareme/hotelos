// Cocoa 22 · the primitives paint with tokens only (COCOA-22.md §1.8, §6
// prohibitions, §9 rule 12): no literal colours in components/cocoa/** and
// every `var(--cocoa-*)` they reference exists in the stylesheets (a token
// used with an inline fallback is tolerated, because the fallback keeps the
// component correct while the css lot lands the token).

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const cocoaDir = resolve(here, "..");
const srcDir = resolve(cocoaDir, "../..");
const stylesDir = join(srcDir, "styles");

const sourceFiles = readdirSync(cocoaDir)
  .filter((name) => /\.(tsx?|mts)$/.test(name) && !name.endsWith(".d.ts"))
  .map((name) => join(cocoaDir, name))
  .concat([join(srcDir, "components/cocoa-director/DirectorForwardPaceChart.tsx"), join(srcDir, "components/ConfirmDialog.tsx"), join(srcDir, "components/Toast.tsx")]);

const styleFiles = readdirSync(stylesDir)
  .filter((name) => name.endsWith(".css"))
  .map((name) => join(stylesDir, name))
  .concat([join(srcDir, "styles.css")]);

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");
}

describe("Cocoa 22 · primitives use tokens only", () => {
  it("no literal colours (#hex, rgb(), hsl()) in components/cocoa/**", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles) {
      const code = stripComments(readFileSync(file, "utf8"));
      const matches = code.match(/#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/g);
      if (matches) offenders.push(`${file.replace(srcDir, "src")}: ${matches.join(", ")}`);
    }
    assert.deepEqual(offenders, []);
  });

  it("every --cocoa-* token used without a fallback is defined in the stylesheets", () => {
    const defined = new Set<string>();
    for (const file of styleFiles) {
      for (const match of readFileSync(file, "utf8").matchAll(/(--cocoa-[a-z0-9-]+)\s*:/g)) defined.add(match[1]);
    }
    assert.ok(defined.size > 100, "cocoa-tokens.css should define the token set");
    const missing = new Set<string>();
    for (const file of sourceFiles) {
      const code = stripComments(readFileSync(file, "utf8"));
      for (const match of code.matchAll(/var\((--cocoa-[a-z0-9-]+)(\)|,)/g)) {
        const [, token, terminator] = match;
        if (terminator === ",") continue; // inline fallback present
        if (token === "--cocoa-space-") continue; // template `--cocoa-space-${n}`
        if (!defined.has(token)) missing.add(`${token} (${file.replace(srcDir, "src")})`);
      }
    }
    assert.deepEqual([...missing].sort(), []);
  });
});
