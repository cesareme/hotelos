#!/usr/bin/env node
/**
 * check-sidebar-coverage.mjs
 *
 * Pre-commit script (Tanda 5 · L1b: coverage by URL of the navigation tree)
 * that validates every screen component in apps/admin-web/src/screens/ is
 * reachable from the menu:
 *   - it is a screen key of apps/admin-web/src/navigation/nav-tree.generated.json
 *     (item, tab, dev-only, public or alias), directly or through the component
 *     App.tsx binds to that key (`Key: Symbol` + `lazyNamed(..., "Export")`), OR
 *   - a tab container under screens/tabs/** loads it (`m.Export` in a loader), OR
 *   - Sidebar.tsx still references it literally (legacy `screen: "X"`), OR
 *   - it is explicitly listed in apps/admin-web/.discoverability-whitelist.json.
 *
 * It also reports the coverage by URL: every URL of the tree must resolve to a
 * component (App.tsx registry for items/dev-only/public, a container loader
 * for tabs). Exits 1 on orphan screens or uncovered URLs, 0 otherwise.
 *
 * Usage: node scripts/check-sidebar-coverage.mjs
 */

import { readdirSync, readFileSync, writeFileSync, statSync, existsSync } from "node:fs";
import { join, relative, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";

// ---------- ANSI color helpers ----------
const COLORS = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m",
};

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (color, text) => (useColor ? `${COLORS[color]}${text}${COLORS.reset}` : text);

// ---------- Resolve repo-relative paths ----------
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = join(__dirname, "..");
const SCREENS_DIR = join(REPO_ROOT, "apps", "admin-web", "src", "screens");
const TABS_DIR = join(SCREENS_DIR, "tabs");
const SIDEBAR_PATH = join(REPO_ROOT, "apps", "admin-web", "src", "navigation", "Sidebar.tsx");
const APP_PATH = join(REPO_ROOT, "apps", "admin-web", "src", "App.tsx");
const TREE_PATH = join(REPO_ROOT, "apps", "admin-web", "src", "navigation", "nav-tree.generated.json");
const WHITELIST_PATH = join(REPO_ROOT, "apps", "admin-web", ".discoverability-whitelist.json");

// ---------- 1. Walk screens recursively ----------
function walkTsx(dir) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(dir);
  } catch (err) {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      if (entry === "__tests__") continue;
      out.push(...walkTsx(full));
    } else if (st.isFile() && entry.endsWith(".tsx")) {
      out.push(full);
    }
  }
  return out;
}

// ---------- 2. Extract exported component name from a tsx file ----------
// Matches `export function Name`, `export const Name`, `export default function Name`
// and the identifier form `export default Name;` (tab containers of Tanda 5).
const EXPORT_FN_RE = /export\s+function\s+([A-Z][a-zA-Z0-9]+)/;
const EXPORT_CONST_RE = /export\s+const\s+([A-Z][a-zA-Z0-9]+)/;
const EXPORT_DEFAULT_FN_RE = /export\s+default\s+function\s+([A-Z][a-zA-Z0-9]+)/;
const EXPORT_DEFAULT_ID_RE = /export\s+default\s+([A-Z][a-zA-Z0-9]+)\s*;/;

export function extractComponentName(source) {
  const fnMatch = source.match(EXPORT_FN_RE);
  if (fnMatch) return fnMatch[1];
  const constMatch = source.match(EXPORT_CONST_RE);
  if (constMatch) return constMatch[1];
  const defaultFnMatch = source.match(EXPORT_DEFAULT_FN_RE);
  if (defaultFnMatch) return defaultFnMatch[1];
  const defaultIdMatch = source.match(EXPORT_DEFAULT_ID_RE);
  if (defaultIdMatch) return defaultIdMatch[1];
  return null;
}

/** Every uppercase export of a file (multi-export modules like PropertySetupForms.tsx). */
function extractAllExportNames(source) {
  const names = new Set();
  for (const re of [/export\s+function\s+([A-Z][a-zA-Z0-9]+)/g, /export\s+const\s+([A-Z][a-zA-Z0-9]+)/g, /export\s+default\s+function\s+([A-Z][a-zA-Z0-9]+)/g]) {
    let m;
    while ((m = re.exec(source)) !== null) names.add(m[1]);
  }
  const defaultId = source.match(EXPORT_DEFAULT_ID_RE);
  if (defaultId) names.add(defaultId[1]);
  const reexport = /export\s*\{([^}]*)\}\s*from/g;
  let m;
  while ((m = reexport.exec(source)) !== null) {
    for (const part of m[1].split(",")) {
      const name = part.trim().split(/\s+as\s+/).pop();
      if (name && /^[A-Z]/.test(name)) names.add(name);
    }
  }
  return names;
}

// ---------- 3. Screen ids from Sidebar.tsx (legacy literals) ----------
function extractSidebarScreens(sidebarSource) {
  const ids = new Set();
  const screenFieldRe = /screen:\s*"([A-Za-z][A-Za-z0-9]*)"/g;
  const routeMapValueRe = /"[^"]+":\s*"([A-Z][a-zA-Z0-9]+)"/g;
  let m;
  while ((m = screenFieldRe.exec(sidebarSource)) !== null) ids.add(m[1]);
  while ((m = routeMapValueRe.exec(sidebarSource)) !== null) ids.add(m[1]);
  return ids;
}

// ---------- 4. App.tsx registry: key → bound symbol → lazy export name ----------
function extractAppBindings(appSource) {
  const keyToSymbol = new Map();
  const componentsMatch = appSource.match(/const\s+SCREEN_COMPONENTS\s*=\s*\{([\s\S]*?)\n\};/);
  if (componentsMatch) {
    const stripped = componentsMatch[1].replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
    const entryRe = /^\s*([A-Za-z_$][\w$]*)\s*(?::\s*([A-Za-z_$][\w$]*))?\s*,?\s*$/gm;
    let m;
    while ((m = entryRe.exec(stripped)) !== null) keyToSymbol.set(m[1], m[2] ?? m[1]);
  }
  const symbolToExport = new Map();
  const lazyRe = /const\s+([A-Za-z_$][\w$]*)\s*=\s*lazyNamed\s*\([^,]*,\s*["']([A-Za-z0-9_]+)["']\s*\)/g;
  let m;
  while ((m = lazyRe.exec(appSource)) !== null) symbolToExport.set(m[1], m[2]);
  const lazyTabRe = /const\s+([A-Za-z_$][\w$]*)\s*=\s*lazyTab\s*\(\s*["']([A-Za-z0-9_]+)["']\s*\)/g;
  while ((m = lazyTabRe.exec(appSource)) !== null) symbolToExport.set(m[1], m[2]);
  return { keyToSymbol, symbolToExport };
}

// ---------- 5. Tab containers: screen key → loader export name ----------
function extractContainerLoaders() {
  const loaders = new Map(); // screenKey -> Set(exportName)
  const containers = new Set(); // default export names of containers
  for (const file of walkTsx(TABS_DIR)) {
    const source = readFileSync(file, "utf8");
    const container = source.match(EXPORT_DEFAULT_FN_RE)?.[1] ?? source.match(EXPORT_DEFAULT_ID_RE)?.[1];
    if (container) containers.add(container);
    // `Key: () => import("…").then((m) => embed(m.Export))` / `lazyNamed(…, "Export")` / `m.Export`
    const loaderRe = /^\s*([A-Za-z_$][\w$]*)\s*:\s*\(\)\s*=>\s*import\([^)]*\)[^\n]*?\bm\.([A-Z][A-Za-z0-9_]*)/gm;
    let m;
    while ((m = loaderRe.exec(source)) !== null) {
      if (!loaders.has(m[1])) loaders.set(m[1], new Set());
      loaders.get(m[1]).add(m[2]);
    }
  }
  return { loaders, containers };
}

// ---------- 6. Load (or bootstrap) the whitelist ----------
function loadWhitelist() {
  if (!existsSync(WHITELIST_PATH)) {
    writeFileSync(WHITELIST_PATH, "[]\n", "utf8");
    console.log(paint("yellow", `⚠  Created empty whitelist at ${relative(REPO_ROOT, WHITELIST_PATH)}`));
    return new Set();
  }
  try {
    const parsed = JSON.parse(readFileSync(WHITELIST_PATH, "utf8"));
    let list;
    if (Array.isArray(parsed)) list = parsed;
    else if (parsed && Array.isArray(parsed.screens)) list = parsed.screens;
    else {
      console.error(paint("red", `❌ Whitelist at ${relative(REPO_ROOT, WHITELIST_PATH)} must be a JSON array (or an object with a "screens" array).`));
      process.exit(1);
    }
    return new Set(list);
  } catch (err) {
    console.error(paint("red", `❌ Failed to parse ${relative(REPO_ROOT, WHITELIST_PATH)}: ${err.message}`));
    process.exit(1);
  }
}

// ---------- Main ----------
function main() {
  for (const [label, path] of [["Sidebar", SIDEBAR_PATH], ["App.tsx", APP_PATH], ["nav tree", TREE_PATH]]) {
    if (!existsSync(path)) {
      console.error(paint("red", `❌ ${label} not found at ${relative(REPO_ROOT, path)}`));
      process.exit(1);
    }
  }
  if (!existsSync(SCREENS_DIR)) {
    console.error(paint("red", `❌ Screens directory not found at ${relative(REPO_ROOT, SCREENS_DIR)}`));
    process.exit(1);
  }

  const screenFiles = walkTsx(SCREENS_DIR);
  const sidebarScreens = extractSidebarScreens(readFileSync(SIDEBAR_PATH, "utf8"));
  const { keyToSymbol, symbolToExport } = extractAppBindings(readFileSync(APP_PATH, "utf8"));
  const { loaders, containers } = extractContainerLoaders();
  const tree = JSON.parse(readFileSync(TREE_PATH, "utf8"));
  const whitelist = loadWhitelist();

  // Tree entries: key + url + kind.
  const entries = [];
  for (const category of tree.categories) {
    for (const item of category.items) {
      entries.push({ key: item.screenKey, url: item.url, kind: "item" });
      for (const tab of item.tabs) entries.push({ key: tab.screenKey, url: tab.url, kind: "tab" });
    }
  }
  for (const screen of tree.devOnly) entries.push({ key: screen.screenKey, url: screen.url, kind: "dev-only" });
  for (const screen of tree.publicScreens) entries.push({ key: screen.screenKey, url: screen.url, kind: "public" });

  // Component names reachable through the tree: the key itself, the App.tsx
  // symbol bound to it, the export that symbol lazy-loads, the container
  // loaders of a tab key and the container default exports.
  const reachable = new Set([...sidebarScreens, ...containers]);
  const uncoveredUrls = [];
  for (const entry of entries) {
    reachable.add(entry.key);
    let covered = false;
    const symbol = keyToSymbol.get(entry.key);
    if (symbol) {
      covered = true;
      reachable.add(symbol);
      const exportName = symbolToExport.get(symbol);
      if (exportName) reachable.add(exportName);
    }
    const loaded = loaders.get(entry.key);
    if (loaded) {
      covered = true;
      for (const name of loaded) reachable.add(name);
    }
    if (!covered) uncoveredUrls.push(entry);
  }
  for (const alias of tree.aliases) {
    reachable.add(alias.screenKey);
    const symbol = keyToSymbol.get(alias.screenKey);
    if (symbol) {
      reachable.add(symbol);
      const exportName = symbolToExport.get(symbol);
      if (exportName) reachable.add(exportName);
    }
  }

  console.log(paint("cyan", paint("bold", "Sidebar coverage check (por URL del árbol)")));
  console.log(
    paint("gray", `  screens scanned: ${screenFiles.length}`) +
      paint("gray", `   tree URLs: ${entries.length}`) +
      paint("gray", `   covered URLs: ${entries.length - uncoveredUrls.length}`) +
      paint("gray", `   sidebar literals: ${sidebarScreens.size}`) +
      paint("gray", `   whitelisted: ${whitelist.size}`),
  );

  const orphans = [];
  const skipped = [];

  for (const file of screenFiles) {
    const source = readFileSync(file, "utf8");
    const componentName = extractComponentName(source);
    const relPath = relative(REPO_ROOT, file);

    if (!componentName) {
      skipped.push(relPath);
      continue;
    }

    const names = new Set([componentName, ...extractAllExportNames(source), basename(file, ".tsx")]);
    let found = false;
    for (const name of names) {
      if (reachable.has(name) || whitelist.has(name)) {
        found = true;
        break;
      }
      // Convention #1: `FooScreen.tsx` exports `FooScreen` but the tree key is `Foo`.
      if (name.endsWith("Screen")) {
        const alias = name.slice(0, -"Screen".length);
        if (alias && (reachable.has(alias) || whitelist.has(alias))) {
          found = true;
          break;
        }
      }
      // Convention #2: `Foo` exported, `FooScreen` referenced.
      if (reachable.has(`${name}Screen`) || whitelist.has(`${name}Screen`)) {
        found = true;
        break;
      }
    }
    if (found) continue;

    const lines = source.split("\n");
    let line = 1;
    for (let i = 0; i < lines.length; i++) {
      if (EXPORT_FN_RE.test(lines[i]) || EXPORT_CONST_RE.test(lines[i]) || EXPORT_DEFAULT_FN_RE.test(lines[i]) || EXPORT_DEFAULT_ID_RE.test(lines[i])) {
        line = i + 1;
        break;
      }
    }
    orphans.push({ component: componentName, path: relPath, line });
  }

  if (skipped.length > 0) {
    console.log(paint("gray", `  (skipped ${skipped.length} file(s) without an uppercase export)`));
  }

  let failed = false;
  if (uncoveredUrls.length > 0) {
    failed = true;
    console.error(paint("red", paint("bold", `❌ ${uncoveredUrls.length} URL(s) of the tree have no component (App.tsx registry or container loader):`)));
    for (const entry of uncoveredUrls) console.error(`  ${paint("yellow", entry.key)} ${paint("gray", "->")} ${entry.url} (${entry.kind})`);
    console.error("");
  }

  if (orphans.length === 0 && !failed) {
    console.log(paint("green", `✅ All ${screenFiles.length} screen(s) are reachable from the tree, the sidebar or the whitelist; ${entries.length}/${entries.length} URLs covered.`));
    process.exit(0);
  }

  if (orphans.length > 0) {
    console.error(paint("red", paint("bold", `❌ ${orphans.length} orphan screens found. Register them in the tree (pilots/tanda5-nav-tree.csv → App.tsx / a container) or whitelist in .discoverability-whitelist.json`)));
    console.error("");
    for (const o of orphans) console.error(`  ${paint("yellow", o.component)} ${paint("gray", "->")} ${o.path}:${o.line}`);
    console.error("");
  }
  console.error(paint("gray", `  Whitelist file: ${relative(REPO_ROOT, WHITELIST_PATH)}`));
  console.error(paint("gray", `  Tree file:      ${relative(REPO_ROOT, TREE_PATH)}`));
  process.exit(1);
}

main();
