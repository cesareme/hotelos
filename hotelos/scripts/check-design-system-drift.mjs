#!/usr/bin/env node
/**
 * Design-system drift report (audit 2026-06 · #12).
 *
 * The app ships TWO complete design systems: Aurora (warm, `.bo-*` classes,
 * 156/202 screens) and Cocoa (cold macOS, `components/cocoa/*`, 27/202). Until
 * a canonical system is chosen (see docs/design-system/DESIGN-SYSTEM-DECISION.md)
 * this script is REPORT-ONLY: it classifies each screen and flags the ones that
 * mix BOTH systems — the incoherent surfaces to migrate first.
 *
 * Usage:
 *   node scripts/check-design-system-drift.mjs            # report, exit 0
 *   node scripts/check-design-system-drift.mjs --enforce  # exit 1 if mixed screens exist
 *
 * After the direction is decided, flip on --enforce in the pre-commit hook to
 * freeze the losing system (no new mixed files).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SCREENS_DIR = join(ROOT, "apps/admin-web/src/screens");

const enforce = process.argv.includes("--enforce");

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (entry.endsWith(".tsx")) out.push(full);
  }
  return out;
}

// Aurora marker: usage of the `.bo-*` class family (className strings).
const AURORA = /\bbo-[a-z][a-z0-9-]+/;
// Cocoa marker: importing the Cocoa component library.
const COCOA = /from\s+["'][^"']*components\/cocoa/;

let aurora = 0;
let cocoa = 0;
let mixed = 0;
let neither = 0;
const mixedFiles = [];

let files = [];
try {
  files = walk(SCREENS_DIR);
} catch {
  console.error(`[ds-drift] cannot read ${SCREENS_DIR}`);
  process.exit(enforce ? 1 : 0);
}

for (const file of files) {
  const src = readFileSync(file, "utf8");
  const usesAurora = AURORA.test(src);
  const usesCocoa = COCOA.test(src);
  if (usesAurora && usesCocoa) {
    mixed++;
    mixedFiles.push(file.slice(ROOT.length));
  } else if (usesAurora) aurora++;
  else if (usesCocoa) cocoa++;
  else neither++;
}

const total = files.length;
console.log("\n=== Design-system drift report ===");
console.log(`Screens scanned:   ${total}`);
console.log(`Aurora only (.bo): ${aurora}`);
console.log(`Cocoa only:        ${cocoa}`);
console.log(`Mixed (both):      ${mixed}`);
console.log(`Neither:           ${neither}`);

if (mixedFiles.length) {
  console.log("\nMixed screens (migrate first — they use both systems):");
  for (const f of mixedFiles.sort()) console.log(`  · ${f}`);
}

console.log(
  "\nDecision pending — see docs/design-system/DESIGN-SYSTEM-DECISION.md." +
    (enforce ? "" : " (report-only)")
);

if (enforce && mixed > 0) {
  console.error(`\n✗ ${mixed} screens mix Aurora + Cocoa. Resolve before enforcing.`);
  process.exit(1);
}
process.exit(0);
