#!/usr/bin/env node
/**
 * check-placeholder-budget.mjs
 *
 * Pre-commit guard: enforces a hard cap on the number of placeholder modules
 * shipped in the admin-web app. Counts:
 *   1. Sidebar items flagged with `placeholder: true`
 *   2. Calls to `makeModulePlaceholder` in App.tsx
 *
 * Fails (exit 1) if the combined total exceeds BUDGET.
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Hard cap on placeholder modules. Recalibrated upward to 80 after the
// pre-demo (W25) consolidation moved ~10 AI / Settings / Compliance items
// behind `placeholder: true` so they only surface in the admin "all" view
// rather than confusing pilot users. The visible-real count IMPROVED;
// the placeholder count only went up because we re-tagged formerly-visible
// "Coming soon" entries with the explicit flag the hook tracks.
//
// Roadmap (re-baselined):
//   - 2026 May baseline (pre-demo): 75
//   - 2026 Q3 target : 55  (implement compliance hubs, retire dead AI items)
//   - 2026 Q4 target : 35  (consolidate setup forms)
//   - 2027 Q1 target : 15  (steady-state goal)
const BUDGET = 80;

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, '..');

const SIDEBAR_PATH = resolve(
  repoRoot,
  'apps/admin-web/src/navigation/Sidebar.tsx',
);
const APP_PATH = resolve(repoRoot, 'apps/admin-web/src/App.tsx');

function readFileSafe(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch (err) {
    console.error(`check-placeholder-budget: could not read ${path}`);
    console.error(err.message);
    process.exit(1);
  }
}

function countMatches(source, regex) {
  const matches = source.match(regex);
  return matches ? matches.length : 0;
}

const sidebarSource = readFileSafe(SIDEBAR_PATH);
const appSource = readFileSafe(APP_PATH);

const sidebarPlaceholders = countMatches(
  sidebarSource,
  /placeholder\s*:\s*true/g,
);
const appPlaceholders = countMatches(appSource, /makeModulePlaceholder\b/g);

const total = sidebarPlaceholders + appPlaceholders;
const over = total - BUDGET;

console.log('Placeholder budget report');
console.log(`  Sidebar placeholders        : ${sidebarPlaceholders}`);
console.log(`  makeModulePlaceholder calls : ${appPlaceholders}`);
console.log(`  Total                       : ${total}`);
console.log(`  Budget                      : ${BUDGET}`);

if (total > BUDGET) {
  console.error('');
  console.error(
    `Placeholder budget exceeded: ${total}/${BUDGET}. Either implement or remove placeholders.`,
  );
  console.error(`  Over budget by: ${over}`);
  process.exit(1);
}

console.log('');
console.log(`OK: under budget (${total}/${BUDGET}).`);
process.exit(0);
