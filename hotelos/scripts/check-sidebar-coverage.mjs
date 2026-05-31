#!/usr/bin/env node
/**
 * check-sidebar-coverage.mjs
 *
 * Pre-commit script that validates every screen component in
 * apps/admin-web/src/screens/ is either:
 *   - referenced from apps/admin-web/src/navigation/Sidebar.tsx, OR
 *   - explicitly listed in apps/admin-web/.discoverability-whitelist.json
 *
 * Exits 1 if orphan screens are found, 0 if everything is covered.
 *
 * Usage: node scripts/check-sidebar-coverage.mjs
 */

import { readdirSync, readFileSync, writeFileSync, statSync, existsSync } from "node:fs";
import { join, relative, dirname } from "node:path";
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
const SIDEBAR_PATH = join(REPO_ROOT, "apps", "admin-web", "src", "navigation", "Sidebar.tsx");
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
      out.push(...walkTsx(full));
    } else if (st.isFile() && entry.endsWith(".tsx")) {
      out.push(full);
    }
  }
  return out;
}

// ---------- 2. Extract exported component name from a tsx file ----------
// Matches either `export function ComponentName` or `export const ComponentName`
// (must begin with an uppercase letter so we skip lower-case helpers).
const EXPORT_FN_RE = /export\s+function\s+([A-Z][a-zA-Z0-9]+)/;
const EXPORT_CONST_RE = /export\s+const\s+([A-Z][a-zA-Z0-9]+)/;
const EXPORT_DEFAULT_FN_RE = /export\s+default\s+function\s+([A-Z][a-zA-Z0-9]+)/;

function extractComponentName(source) {
  const fnMatch = source.match(EXPORT_FN_RE);
  if (fnMatch) return fnMatch[1];
  const constMatch = source.match(EXPORT_CONST_RE);
  if (constMatch) return constMatch[1];
  const defaultFnMatch = source.match(EXPORT_DEFAULT_FN_RE);
  if (defaultFnMatch) return defaultFnMatch[1];
  return null;
}

// ---------- 3. Extract screen ids from Sidebar.tsx ----------
// The sidebar source declares screens in two shapes:
//   1. Inside the nav-tree literal: `{ label, screen: "X" }`
//   2. Inside the route-to-screen map: `"/backoffice/path": "X"`
// We run both regexes so route-map screens (driven by `getModuleRouteItems`
// at runtime) don't get flagged as orphans when they are statically reachable
// from the same file.
function extractSidebarScreens(sidebarSource) {
  const ids = new Set();
  const screenFieldRe = /screen:\s*"([A-Za-z][A-Za-z0-9]*)"/g;
  const routeMapValueRe = /"[^"]+":\s*"([A-Z][a-zA-Z0-9]+)"/g;
  let m;
  while ((m = screenFieldRe.exec(sidebarSource)) !== null) {
    ids.add(m[1]);
  }
  while ((m = routeMapValueRe.exec(sidebarSource)) !== null) {
    ids.add(m[1]);
  }
  return ids;
}

// ---------- 4. Load (or bootstrap) the whitelist ----------
function loadWhitelist() {
  if (!existsSync(WHITELIST_PATH)) {
    writeFileSync(WHITELIST_PATH, "[]\n", "utf8");
    console.log(
      paint(
        "yellow",
        `⚠  Created empty whitelist at ${relative(REPO_ROOT, WHITELIST_PATH)}`,
      ),
    );
    return new Set();
  }
  try {
    const raw = readFileSync(WHITELIST_PATH, "utf8");
    const parsed = JSON.parse(raw);
    // Accept either a plain array (spec) or `{ "screens": [...] }` (legacy schema
    // already used in this repo) so existing whitelists keep working.
    let list;
    if (Array.isArray(parsed)) {
      list = parsed;
    } else if (parsed && Array.isArray(parsed.screens)) {
      list = parsed.screens;
    } else {
      console.error(
        paint(
          "red",
          `❌ Whitelist at ${relative(REPO_ROOT, WHITELIST_PATH)} must be a JSON array (or an object with a "screens" array).`,
        ),
      );
      process.exit(1);
    }
    return new Set(list);
  } catch (err) {
    console.error(
      paint(
        "red",
        `❌ Failed to parse ${relative(REPO_ROOT, WHITELIST_PATH)}: ${err.message}`,
      ),
    );
    process.exit(1);
  }
}

// ---------- Main ----------
function main() {
  // Verify Sidebar.tsx exists; this script is meaningless otherwise.
  if (!existsSync(SIDEBAR_PATH)) {
    console.error(
      paint(
        "red",
        `❌ Sidebar not found at ${relative(REPO_ROOT, SIDEBAR_PATH)}`,
      ),
    );
    process.exit(1);
  }
  if (!existsSync(SCREENS_DIR)) {
    console.error(
      paint(
        "red",
        `❌ Screens directory not found at ${relative(REPO_ROOT, SCREENS_DIR)}`,
      ),
    );
    process.exit(1);
  }

  const screenFiles = walkTsx(SCREENS_DIR);
  const sidebarSource = readFileSync(SIDEBAR_PATH, "utf8");
  const sidebarScreens = extractSidebarScreens(sidebarSource);
  const whitelist = loadWhitelist();

  console.log(paint("cyan", paint("bold", "Sidebar coverage check")));
  console.log(
    paint("gray", `  screens scanned: ${screenFiles.length}`) +
      paint("gray", `   sidebar entries: ${sidebarScreens.size}`) +
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

    if (sidebarScreens.has(componentName)) continue;
    // Convention #1: a file `FooScreen.tsx` exports `FooScreen` but the sidebar
    // references it as `Foo` (the `Screen` suffix is dropped at the routing
    // layer). Recognise that short alias.
    if (componentName.endsWith("Screen")) {
      const alias = componentName.slice(0, -"Screen".length);
      if (alias && sidebarScreens.has(alias)) continue;
      if (alias && whitelist.has(alias)) continue;
    }
    // Convention #2: a file `FooScreen.tsx` exports `Foo` (no suffix) but the
    // sidebar references the screen-id-with-suffix `FooScreen`. Mirror the
    // alias check the other direction so both naming styles match.
    const aliasWithSuffix = componentName + "Screen";
    if (sidebarScreens.has(aliasWithSuffix)) continue;
    if (whitelist.has(aliasWithSuffix)) continue;
    if (whitelist.has(componentName)) continue;

    // Find the line of the export so the report points at the right spot.
    const lines = source.split("\n");
    let line = 1;
    for (let i = 0; i < lines.length; i++) {
      if (
        EXPORT_FN_RE.test(lines[i]) ||
        EXPORT_CONST_RE.test(lines[i]) ||
        EXPORT_DEFAULT_FN_RE.test(lines[i])
      ) {
        line = i + 1;
        break;
      }
    }

    orphans.push({ component: componentName, path: relPath, line });
  }

  if (skipped.length > 0) {
    console.log(
      paint(
        "gray",
        `  (skipped ${skipped.length} file(s) without an uppercase export)`,
      ),
    );
  }

  if (orphans.length === 0) {
    console.log(
      paint(
        "green",
        `✅ All ${screenFiles.length} screen(s) are reachable from the sidebar or whitelisted.`,
      ),
    );
    process.exit(0);
  }

  console.error(
    paint(
      "red",
      paint(
        "bold",
        `❌ ${orphans.length} orphan screens found. Add them to Sidebar.tsx or whitelist in .discoverability-whitelist.json`,
      ),
    ),
  );
  console.error("");
  for (const o of orphans) {
    console.error(
      `  ${paint("yellow", o.component)} ${paint("gray", "->")} ${o.path}:${o.line}`,
    );
  }
  console.error("");
  console.error(
    paint(
      "gray",
      `  Whitelist file: ${relative(REPO_ROOT, WHITELIST_PATH)}`,
    ),
  );
  console.error(
    paint(
      "gray",
      `  Sidebar file:   ${relative(REPO_ROOT, SIDEBAR_PATH)}`,
    ),
  );
  process.exit(1);
}

main();
