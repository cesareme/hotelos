// Header actions of the financial statements (Finanzas › Estados contables,
// Contabilidad): a status CocoaBadge must never share a `nowrap` cocoa-row
// with a CocoaSelect. The select's wrapper is `width: 100%` (CocoaSelect.tsx),
// so inside a nowrap row it claims the whole line and the badge — the only
// shrinkable sibling (min-width 0 + ellipsis) — collapses to «CUA…» (qa#3 on
// BalanceSheetScreen). The badge goes as a direct child of the wrapping
// actions row; select + button may stay together as a nowrap cluster.

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const SCREENS_DIR = fileURLToPath(new URL("../..", import.meta.url));
const FOLDERS = ["finance", "accounting"];

function screenSources(): Array<{ rel: string; src: string }> {
  const out: Array<{ rel: string; src: string }> = [];
  for (const folder of FOLDERS) {
    const dir = join(SCREENS_DIR, folder);
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".tsx")) continue;
      out.push({ rel: `${folder}/${name}`, src: readFileSync(join(dir, name), "utf8") });
    }
  }
  return out;
}

/** Bodies of every `<div className="cocoa-row" … data-wrap="nowrap">` up to its closing `</div>` (rows nest at most one level in these screens). */
function nowrapRows(src: string): string[] {
  const rows: string[] = [];
  const open = /<div\s+className="cocoa-row"[^>]*data-wrap="nowrap"[^>]*>/g;
  for (const m of src.matchAll(open)) {
    const start = m.index! + m[0].length;
    let depth = 1;
    let i = start;
    const tag = /<\/?div\b/g;
    tag.lastIndex = start;
    let t: RegExpExecArray | null;
    while ((t = tag.exec(src)) !== null) {
      depth += t[0].startsWith("</") ? -1 : 1;
      if (depth === 0) {
        i = t.index;
        break;
      }
    }
    rows.push(src.slice(start, i));
  }
  return rows;
}

describe("estados contables · fila de acciones de la cabecera", () => {
  const sources = screenSources();

  it("recorre las pantallas de finanzas y contabilidad", () => {
    assert.ok(sources.some((s) => s.rel === "finance/BalanceSheetScreen.tsx"));
    assert.ok(sources.length >= 10);
  });

  it("ningún CocoaBadge comparte una fila nowrap con un CocoaSelect (el select ocupa el 100 % y aplasta el badge)", () => {
    const offenders: string[] = [];
    for (const { rel, src } of sources) {
      for (const row of nowrapRows(src)) {
        if (row.includes("<CocoaBadge") && row.includes("<CocoaSelect")) offenders.push(rel);
      }
    }
    assert.deepEqual(offenders, [], `badge y select en la misma fila nowrap: ${offenders.join(", ")}`);
  });

  it("Balance: el badge de cuadre es hijo directo de la fila de acciones y el selector de formato sigue junto a «Descargar»", () => {
    const src = sources.find((s) => s.rel === "finance/BalanceSheetScreen.tsx")!.src;
    const actions = src.slice(src.indexOf("actions={"), src.indexOf("state={state}"));
    assert.match(actions, /<>\s*\{k \? <CocoaBadge tone=\{k\.balanced \? "success" : "danger"\}>/, "el badge abre la fila de acciones");
    const [cluster] = nowrapRows(actions);
    assert.ok(cluster, "el selector de formato y «Descargar» forman una fila nowrap");
    assert.ok(cluster.includes("<CocoaSelect") && cluster.includes("<CocoaButton"), "la fila nowrap contiene el selector y el botón");
    assert.ok(!cluster.includes("<CocoaBadge"), "la fila nowrap no contiene el badge");
  });
});
