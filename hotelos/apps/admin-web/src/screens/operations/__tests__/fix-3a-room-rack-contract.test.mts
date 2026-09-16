import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Source contract of lote fix:3-A qa#11 (Cocoa 22 · ola 3 · tablero de habitaciones).
const stripComments = (source: string) =>
  source
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");
const source = stripComments(readFileSync(fileURLToPath(new URL("../RoomRackScreen.tsx", import.meta.url)), "utf8"));

describe("Tablero · la planta se pinta con floorTitle (qa#11)", () => {
  it("never interpolates the raw floor after «Planta »", () => {
    assert.doesNotMatch(source, /Planta \$\{/);
    assert.doesNotMatch(source, /floor \?\? "—"/);
  });
  it("titles the sections, the filter and the drawer through the shared helper", () => {
    assert.match(source, /from "\.\/room-rack-labels"/);
    assert.match(source, /title=\{floor\.title\}/);
    assert.match(source, /value: f\.key, label: `\$\{f\.title\} \(\$\{f\.rooms\.length\}\)`/);
    assert.match(source, /\$\{floorTitle\(selectedTile\.floor\)\}/);
  });
});
