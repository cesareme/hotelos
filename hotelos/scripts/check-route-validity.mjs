#!/usr/bin/env node
/**
 * check-route-validity.mjs
 *
 * Pre-commit guard: every sidebar item points at a screen the runtime can
 * actually render. The Sidebar declares `screen: 'X'` strings and App.tsx
 * exposes a `SCREEN_COMPONENTS` map whose keys are the renderable screens.
 * If a sidebar item targets a screen missing from that map, clicking the item
 * crashes the app or silently dumps the user on the fallback screen.
 *
 * What it does:
 *   1. Reads Sidebar.tsx and extracts every `screen: '...'` referenced from
 *      the nav tree (literal items + the adminRouteScreenMap values that feed
 *      module-driven items).
 *   2. Reads App.tsx and extracts:
 *        - lazyNamed const declarations (the symbols available as components)
 *        - keys of the SCREEN_COMPONENTS object literal (the strings the
 *          runtime actually maps to components — this is the source of truth)
 *   3. Reports sidebar `screen` targets that aren't registered in App.tsx.
 *   4. Exit 1 with a remediation hint on broken links, 0 if clean.
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

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
    console.error(`check-route-validity: could not read ${path}`);
    console.error(err.message);
    process.exit(1);
  }
}

/**
 * Pull every screen string referenced from Sidebar.tsx. Two sources:
 *   - Literal `screen: 'Foo'` / `screen: "Foo"` fields in nav items.
 *   - Values of the adminRouteScreenMap (which feed module-driven items via
 *     getModuleRouteItems().map(...)). These also need to exist in App.tsx.
 *
 * Hash-suffixed targets like `GroupsEventsDashboard#nuevo-grupo` are stripped
 * to their base screen — the hash is a deep-link into the same screen, not a
 * separate route.
 */
function extractSidebarScreens(source) {
  const screens = new Map(); // screen -> Set of context strings for reporting

  function add(rawScreen, context) {
    const screen = rawScreen.split('#')[0]; // drop hash deep-links
    if (!screen) return;
    if (!screens.has(screen)) screens.set(screen, new Set());
    screens.get(screen).add(context);
  }

  // Literal `screen: 'Foo'` references (handles single + double quotes).
  const literalRe = /screen\s*:\s*(['"])([^'"]+)\1/g;
  let m;
  while ((m = literalRe.exec(source)) !== null) {
    add(m[2], 'sidebar nav item');
  }

  // adminRouteScreenMap values — extract the object literal block and pull
  // every `"...": "ScreenName"` pair. These feed module-driven nav items so a
  // broken value here also produces a broken sidebar link.
  const mapMatch = source.match(
    /adminRouteScreenMap[^=]*=\s*\{([\s\S]*?)\n\};/,
  );
  if (mapMatch) {
    const mapBody = mapMatch[1];
    const entryRe = /['"][^'"]+['"]\s*:\s*(['"])([^'"]+)\1/g;
    while ((m = entryRe.exec(mapBody)) !== null) {
      add(m[2], 'adminRouteScreenMap value');
    }
  }

  return screens;
}

/**
 * Pull every screen the App.tsx runtime can resolve.
 *
 * Authoritative source: keys of the SCREEN_COMPONENTS object literal. These
 * are the strings Sidebar passes into onSelect/setActiveScreen and what the
 * `screen in SCREEN_COMPONENTS` guard validates against at runtime.
 *
 * We also collect `lazyNamed` const declarations as a secondary set, since a
 * screen registered as `Foo: FooScreen` (key Foo, lazyNamed FooScreen) is
 * fine, but the request asked us to capture both shapes for the report.
 */
function extractRegisteredScreens(source) {
  const screens = new Set();

  // Keys of SCREEN_COMPONENTS: `Foo,` or `Foo: Bar,` inside the object.
  const componentsMatch = source.match(
    /const\s+SCREEN_COMPONENTS\s*=\s*\{([\s\S]*?)\n\};/,
  );
  if (componentsMatch) {
    const body = componentsMatch[1];
    // Match property keys (identifier at line start, optionally followed by
    // `:` for renamed bindings or `,` for shorthand). We strip comments first
    // so `// ...` lines don't trip the matcher.
    const stripped = body
      .replace(/\/\/[^\n]*/g, '')
      .replace(/\/\*[\s\S]*?\*\//g, '');
    const keyRe = /^\s*([A-Za-z_$][\w$]*)\s*[:,]/gm;
    let m;
    while ((m = keyRe.exec(stripped)) !== null) {
      screens.add(m[1]);
    }
  }

  // lazyNamed const declarations — the symbol names available to bind into
  // SCREEN_COMPONENTS. Also covers eager imports of the same shape.
  const lazyRe = /const\s+([A-Za-z_$][\w$]*)\s*=\s*lazyNamed\s*\(/g;
  const lazySymbols = new Set();
  let m;
  while ((m = lazyRe.exec(source)) !== null) {
    lazySymbols.add(m[1]);
  }

  return { screens, lazySymbols };
}

const sidebarSource = readFileSafe(SIDEBAR_PATH);
const appSource = readFileSafe(APP_PATH);

const sidebarScreens = extractSidebarScreens(sidebarSource);
const { screens: registeredScreens, lazySymbols } =
  extractRegisteredScreens(appSource);

const broken = [];
for (const [screen, contexts] of sidebarScreens) {
  if (!registeredScreens.has(screen)) {
    broken.push({ screen, contexts: [...contexts] });
  }
}

console.log('Route validity report');
console.log(`  Sidebar screen targets       : ${sidebarScreens.size}`);
console.log(`  SCREEN_COMPONENTS keys       : ${registeredScreens.size}`);
console.log(`  lazyNamed declarations       : ${lazySymbols.size}`);
console.log(`  Broken sidebar links         : ${broken.length}`);

if (broken.length > 0) {
  console.error('');
  console.error('Broken sidebar links detected:');
  for (const { screen, contexts } of broken) {
    console.error(`  - Sidebar item X target '${screen}' not registered in App.tsx.`);
    console.error(`      Source: ${contexts.join(', ')}`);
    console.error(
      `      Register the lazy import or remove the item.`,
    );
  }
  console.error('');
  console.error(
    `Failing: ${broken.length} broken link${broken.length === 1 ? '' : 's'}.`,
  );
  process.exit(1);
}

console.log('');
console.log('OK: every sidebar screen target is registered in App.tsx.');
process.exit(0);
