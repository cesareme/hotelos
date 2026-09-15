#!/usr/bin/env node
/**
 * check-placeholder-budget.mjs
 *
 * Pre-commit guard: enforces a hard cap on the number of placeholder modules
 * shipped in the admin-web app. Counts:
 *   1. Sidebar items flagged with `placeholder: true`
 *   2. CALLS to `makeModulePlaceholder(` in App.tsx — the regex requires the
 *      opening parenthesis so the `import { makeModulePlaceholder }` line is
 *      NOT counted (it inflated the total by 1 until 2026-09; see below).
 *
 * Fails (exit 1) if the combined total exceeds BUDGET.
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Hard cap on placeholder modules.
//
// History:
//   - 2026 May baseline (pre-demo): 75 (cap recalibrated to 80 after the W25
//     consolidation moved ~10 AI / Settings / Compliance items behind
//     `placeholder: true`).
//   - 2026 Sep (Tanda 3 «cumplimiento sin atrezzo»): 71 (27 sidebar flags +
//     44 calls) — 13 ScreenScaffold stubs retired, 4 wired, 7 duplicates removed,
//     3 honest placeholders added. Cap stayed at 80.
//
// 2026-09-15 re-baseline «Tanda 5» (navegación y honestidad, L1b):
//   - The menu is generated from navigation/nav-tree.generated.json: no
//     `placeholder: true` flag survives in Sidebar.tsx (0 placeholders visible
//     to a hotelier, plan §4 «0 placeholders fuera de ?dev»).
//   - App.tsx keeps exactly the 16 makeModulePlaceholder calls of the dev-only
//     screens under /desarrollo/* (RevenueAutomationRules, ForecastSettings,
//     RevenueDataQuality, CRMSettings, LoyaltySettings, GroupSettings,
//     SalesSettings, WorkforceSettings, InventorySettings, ProcurementSettings,
//     ReputationSettings, SurveySettings, QualityWorkflowSettings,
//     EnergySettings, SafetySettings, ScheduledReports), reachable only with
//     `?dev=1` (or localStorage anfitorio.dev=1) AND the platform admin. The
//     other 28 calls were retired (NAV_TREE.retired) with their keys.
//   Net: 71 → 16. The cap drops from 80 to 20 (plan L1: «presupuesto → 20»).
//
// Roadmap (re-baselined):
//   - 2026 Sep (Tanda 5)          : 16  (0 sidebar flags + 16 dev-only calls)
//   - 2026 Q4 target : 10  (wire CRM/fidelización/grupos/ventas settings to Prisma or retire them)
//   - 2027 Q1 target :  5  (revenue automation, forecast settings and data quality behind real endpoints)
//   - 2027 Q2 target :  0  (steady-state goal: no placeholder, dev-only or not)
const BUDGET = 20;

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
// Call sites only: `makeModulePlaceholder(` — excludes the import statement.
const appPlaceholders = countMatches(appSource, /makeModulePlaceholder\(/g);

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
