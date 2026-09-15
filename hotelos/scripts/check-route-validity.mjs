#!/usr/bin/env node
/**
 * check-route-validity.mjs
 *
 * Pre-commit guard (Tanda 5 · L1b): every screen the menu can open is a screen
 * the runtime can render, and every screen the runtime renders has a URL.
 *
 *   1. Sidebar.tsx literal `screen: "X"` targets (and adminRouteScreenMap
 *      values, if any remain) must be keys of SCREEN_COMPONENTS in App.tsx.
 *   2. Every screen key of apps/admin-web/src/navigation/nav-tree.generated.json
 *      (items, tabs, dev-only, public) and every alias must be a key of
 *      SCREEN_COMPONENTS — the tree is what Sidebar/⌘K/router serve.
 *   3. No retired key of the tree may survive in SCREEN_COMPONENTS.
 *   4. Every SCREEN_COMPONENTS key must be a tree key or an alias («una
 *      pantalla = una entrada = una URL»): a key without URL is dead weight.
 *   5. routes/backoffice.routes.tsx must derive its table from the tree
 *      (`allUrls(`, `NAV_TREE.legacyRoutes`, `NAV_TREE.aliases`).
 *
 * Exit 1 with a remediation hint on any broken link, 0 if clean.
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, '..');

const SIDEBAR_PATH = resolve(repoRoot, 'apps/admin-web/src/navigation/Sidebar.tsx');
const APP_PATH = resolve(repoRoot, 'apps/admin-web/src/App.tsx');
const ROUTES_PATH = resolve(repoRoot, 'apps/admin-web/src/routes/backoffice.routes.tsx');
const TREE_PATH = resolve(repoRoot, 'apps/admin-web/src/navigation/nav-tree.generated.json');

function readFileSafe(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch (err) {
    console.error(`check-route-validity: could not read ${path}`);
    console.error(err.message);
    process.exit(1);
  }
}

/**
 * Pull every screen string referenced from Sidebar.tsx. Two sources:
 *   - Literal `screen: 'Foo'` / `screen: "Foo"` fields in nav items.
 *   - Values of the adminRouteScreenMap (legacy module-driven items).
 *
 * Hash-suffixed targets like `GroupsEventsDashboard#nuevo-grupo` are validated
 * by their base screen only (App.tsx `resolveScreenTarget` splits `screen#hash`).
 */
function extractSidebarScreens(source) {
  const screens = new Map(); // screen -> Set of context strings for reporting

  function add(rawScreen, context) {
    const [screen, hash] = rawScreen.split('#');
    if (!screen) return;
    if (!screens.has(screen)) screens.set(screen, new Set());
    screens.get(screen).add(hash ? `${context} (#${hash} deep-link)` : context);
  }

  const literalRe = /screen\s*:\s*(['"])([^'"]+)\1/g;
  let m;
  while ((m = literalRe.exec(source)) !== null) {
    add(m[2], 'sidebar nav item');
  }

  const mapMatch = source.match(/adminRouteScreenMap[^=]*=\s*\{([\s\S]*?)\n\};/);
  if (mapMatch) {
    const entryRe = /['"][^'"]+['"]\s*:\s*(['"])([^'"]+)\1/g;
    while ((m = entryRe.exec(mapMatch[1])) !== null) {
      add(m[2], 'adminRouteScreenMap value');
    }
  }

  return screens;
}

/**
 * Keys of the SCREEN_COMPONENTS object literal in App.tsx — the strings the
 * runtime maps to components (`screen in SCREEN_COMPONENTS` at runtime).
 */
export function extractRegisteredScreens(source) {
  const screens = new Set();
  const componentsMatch = source.match(/const\s+SCREEN_COMPONENTS\s*=\s*\{([\s\S]*?)\n\};/);
  if (componentsMatch) {
    const stripped = componentsMatch[1].replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
    const keyRe = /^\s*([A-Za-z_$][\w$]*)\s*[:,]/gm;
    let m;
    while ((m = keyRe.exec(stripped)) !== null) {
      screens.add(m[1]);
    }
  }
  const lazyRe = /const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:lazyNamed|lazyTab)\s*\(/g;
  const lazySymbols = new Set();
  let m;
  while ((m = lazyRe.exec(source)) !== null) {
    lazySymbols.add(m[1]);
  }
  return { screens, lazySymbols };
}

/** Screen keys of the navigation tree, by kind. */
export function treeScreenKeys(tree) {
  const items = tree.categories.flatMap((category) => category.items);
  const tabs = items.flatMap((item) => item.tabs);
  return {
    items: items.map((item) => item.screenKey),
    tabs: tabs.map((tab) => tab.screenKey),
    devOnly: tree.devOnly.map((screen) => screen.screenKey),
    publicScreens: tree.publicScreens.map((screen) => screen.screenKey),
    aliases: tree.aliases.map((alias) => alias.screenKey),
    retired: tree.retired.map((entry) => entry.screenKey),
    urls: [
      ...items.map((item) => item.url),
      ...tabs.map((tab) => tab.url),
      ...tree.devOnly.map((screen) => screen.url),
      ...tree.publicScreens.map((screen) => screen.url)
    ]
  };
}

const sidebarSource = readFileSafe(SIDEBAR_PATH);
const appSource = readFileSafe(APP_PATH);
const routesSource = readFileSafe(ROUTES_PATH);
const tree = JSON.parse(readFileSafe(TREE_PATH));

const sidebarScreens = extractSidebarScreens(sidebarSource);
const { screens: registeredScreens, lazySymbols } = extractRegisteredScreens(appSource);
const keys = treeScreenKeys(tree);
const treeKeys = new Set([...keys.items, ...keys.tabs, ...keys.devOnly, ...keys.publicScreens]);
const aliasKeys = new Set(keys.aliases);
const retiredKeys = new Set(keys.retired);

const problems = [];

// 1. Sidebar literal targets → SCREEN_COMPONENTS.
for (const [screen, contexts] of sidebarScreens) {
  if (!registeredScreens.has(screen)) {
    problems.push(`Sidebar target '${screen}' is not registered in App.tsx (${[...contexts].join(', ')})`);
  }
}

// 2. Every tree key and alias → SCREEN_COMPONENTS.
const missingTree = [...treeKeys].filter((key) => !registeredScreens.has(key));
const missingAliases = [...aliasKeys].filter((key) => !registeredScreens.has(key));
for (const key of missingTree) problems.push(`Tree screen '${key}' has a URL but no SCREEN_COMPONENTS entry in App.tsx`);
for (const key of missingAliases) problems.push(`Alias '${key}' (NAV_TREE.aliases) is not a SCREEN_COMPONENTS key in App.tsx`);

// 3. No retired key survives.
const survivingRetired = [...registeredScreens].filter((key) => retiredKeys.has(key));
for (const key of survivingRetired) problems.push(`Retired screen '${key}' (NAV_TREE.retired) is still a SCREEN_COMPONENTS key`);

// 4. Every registered key has a URL (tree key or alias).
const withoutUrl = [...registeredScreens].filter((key) => !treeKeys.has(key) && !aliasKeys.has(key));
for (const key of withoutUrl) problems.push(`SCREEN_COMPONENTS key '${key}' is neither a tree screen nor an alias (no URL)`);

// 5. Routes table derived from the tree.
for (const marker of ['allUrls(', 'NAV_TREE.legacyRoutes', 'NAV_TREE.aliases', 'resolveLegacyPath(']) {
  if (!routesSource.includes(marker)) problems.push(`routes/backoffice.routes.tsx does not use '${marker}' (the route table must derive from the tree)`);
}

console.log('Route validity report');
console.log(`  Sidebar screen targets       : ${sidebarScreens.size}`);
console.log(`  SCREEN_COMPONENTS keys       : ${registeredScreens.size}`);
console.log(`  lazy declarations            : ${lazySymbols.size}`);
console.log(`  Tree screens (items/tabs/dev/public): ${keys.items.length}/${keys.tabs.length}/${keys.devOnly.length}/${keys.publicScreens.length} = ${treeKeys.size}`);
console.log(`  Tree URLs registered         : ${keys.urls.length}`);
console.log(`  Aliases                      : ${aliasKeys.size} (missing ${missingAliases.length})`);
console.log(`  Retired keys still present   : ${survivingRetired.length}`);
console.log(`  Registered keys without URL  : ${withoutUrl.length}`);
console.log(`  Broken links                 : ${problems.length}`);

if (problems.length > 0) {
  console.error('');
  console.error('Broken links detected:');
  for (const problem of problems) console.error(`  - ${problem}`);
  console.error('');
  console.error('  Fix: register the screen in App.tsx SCREEN_COMPONENTS (tab keys map to their container),');
  console.error('       or edit pilots/tanda5-nav-tree.csv and run node scripts/build-nav-tree.mjs.');
  console.error(`Failing: ${problems.length} broken link${problems.length === 1 ? '' : 's'}.`);
  process.exit(1);
}

console.log('');
console.log('OK: every tree screen, alias and sidebar target is registered in App.tsx, and every registered key has a URL.');
process.exit(0);
