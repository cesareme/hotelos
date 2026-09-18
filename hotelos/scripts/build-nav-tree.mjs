#!/usr/bin/env node
/**
 * build-nav-tree.mjs — Tanda 5 · L1a (hermetic since L1c)
 *
 * Generates apps/admin-web/src/navigation/nav-tree.generated.json from the
 * single source of truth of the navigation tree, the (git-ignored) CSV
 * `<git root>/pilots/tanda5-nav-tree.csv` (288 rows, `;` separated, columns
 * screenKey;estadoActual;decision;destino;etiquetaES;url;tab;roles;modulo;justificacion;orden).
 *
 * The JSON IS committed (the CSV is not), so the front never depends on the
 * pilots folder at build time. Re-run this script whenever the CSV changes:
 *
 *   node scripts/build-nav-tree.mjs            # writes the JSON
 *   node scripts/build-nav-tree.mjs --check    # exit 1 if the JSON is stale
 *   node scripts/build-nav-tree.mjs --csv <p> --md <p> --out <p>
 *
 * What comes from where (the output depends ONLY on the CSV and on a file of
 * this repo, so a regeneration gives the same JSON on any machine):
 *   - categories/items/tabs/devOnly/retired/aliases/publicScreens: the CSV
 *     (`decision` keep | merge-into | dev-only | retire | duplicate-of).
 *   - ORDER of items inside a category and of tabs inside an item: the CSV
 *     column `orden` (1..n per category for `keep` rows, 1..n per parent for
 *     `merge-into` rows, empty for every other decision). The §1 tables of
 *     `pilots/tanda5-nav-tree.md` are only a cross-check: when the .md is
 *     present and disagrees with the column the script fails loudly.
 *   - legacyRoutes: the 205 `/backoffice/*` paths of the routes file as it was
 *     BEFORE L1b rewrote it, frozen once in `scripts/legacy-backoffice-routes.json`
 *     (from git ref 78edb35, recorded in that file) so the list stays derivable
 *     without git history, each resolved to the CSV URL of the screen it served
 *     (aliases and retired screens follow their `destino`). Cross-checked
 *     against §5 of the .md when it is available.
 *
 * Fails loudly on any CSV inconsistency instead of emitting a half tree.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const GIT_ROOT = join(REPO_ROOT, "..");

const DEFAULT_CSV = join(GIT_ROOT, "pilots", "tanda5-nav-tree.csv");
const DEFAULT_MD = join(GIT_ROOT, "pilots", "tanda5-nav-tree.md");
const DEFAULT_OUT = join(REPO_ROOT, "apps", "admin-web", "src", "navigation", "nav-tree.generated.json");

// The 205 `/backoffice/*` routes of the router BEFORE L1b (frozen snapshot of
// git ref 78edb35, see the `ref` field of the file) that become LEGACY_ROUTES.
const LEGACY_ROUTES_FILE = join(__dirname, "legacy-backoffice-routes.json");

const CSV_COLUMNS = ["screenKey", "estadoActual", "decision", "destino", "etiquetaES", "url", "tab", "roles", "modulo", "justificacion", "orden"];
// Rows that carry a position in the menu (`orden`): keep items and their tabs.
const ORDERED_DECISIONS = new Set(["keep", "merge-into"]);
const LIVE_DECISIONS = new Set(["keep", "merge-into", "dev-only"]);
const DECISIONS = new Set(["keep", "merge-into", "retire", "dev-only", "duplicate-of"]);
// Tanda 8a (RBAC por departamento): the six department tokens join the nine of
// Tanda 5 (administracion, rrhh, propiedad, activos, auditoria, sistemas); `admin`
// stays the platform administrator's (apps/admin-web/src/navigation/role-tokens.ts).
const ROLE_TOKENS = new Set([
  "direccion",
  "recepcion",
  "pisos",
  "mantenimiento",
  "revenue",
  "finanzas",
  "comercial",
  "fnb",
  "administracion",
  "rrhh",
  "propiedad",
  "activos",
  "auditoria",
  "sistemas",
  "admin",
  "publico"
]);
const PUBLIC_CATEGORY = "Acceso (fuera del menú)";
const DEV_ONLY_PREFIX = "/desarrollo";
const MAX_LABEL = 28;
// Plan §2.2: the nine domain categories, in menu order.
const CATEGORY_ORDER = ["Hoy", "Recepción", "Operaciones", "Comercial", "Revenue", "Finanzas", "Cumplimiento", "Informes", "Configuración"];

// ---------------------------------------------------------------- CLI
const args = process.argv.slice(2);
function flag(name) {
  const at = args.indexOf(name);
  return at === -1 ? undefined : args[at + 1];
}
const csvPath = resolve(flag("--csv") ?? DEFAULT_CSV);
const mdPath = resolve(flag("--md") ?? DEFAULT_MD);
const outPath = resolve(flag("--out") ?? DEFAULT_OUT);
const checkOnly = args.includes("--check");

function fail(message) {
  console.error(`build-nav-tree: ${message}`);
  process.exit(1);
}

// ---------------------------------------------------------------- helpers
function slug(text) {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function splitRoles(value) {
  return value
    .split("|")
    .map((token) => token.trim())
    .filter(Boolean);
}

function modulesAnyOf(row) {
  const code = row.modulo.trim();
  return code && code !== "core" ? [code] : [];
}

function hasParams(url) {
  return url.includes("/:");
}

function paramsOf(pattern) {
  return [...pattern.matchAll(/:([A-Za-z0-9_]+)/g)].map((m) => m[1]);
}

// ---------------------------------------------------------------- CSV
function readCsv(path) {
  if (!existsSync(path)) fail(`CSV not found: ${path}`);
  const lines = readFileSync(path, "utf8").split(/\r?\n/).filter((line) => line.length > 0);
  const header = lines[0].split(";");
  if (header.join(";") !== CSV_COLUMNS.join(";")) {
    fail(`unexpected CSV header: ${header.join(";")}`);
  }
  const rows = [];
  lines.slice(1).forEach((line, index) => {
    const cells = line.split(";");
    if (cells.length !== CSV_COLUMNS.length) {
      fail(`row ${index + 2} has ${cells.length} fields (expected ${CSV_COLUMNS.length}): ${line}`);
    }
    const row = {};
    CSV_COLUMNS.forEach((column, at) => {
      row[column] = cells[at].trim();
    });
    rows.push(row);
  });
  return rows;
}

// ---------------------------------------------------------------- .md (order + §5 cross-check)
function readMdSections(path) {
  if (!existsSync(path)) return null;
  const lines = readFileSync(path, "utf8").split(/\r?\n/);
  const sectionStart = (prefix) => lines.findIndex((line) => line.startsWith(prefix));
  const s1 = sectionStart("## 1.");
  const s2 = sectionStart("## 2.");
  const s5 = sectionStart("## 5.");
  const s6 = sectionStart("## 6.");
  if (s1 === -1 || s2 === -1) return null;

  const cellsOf = (line) =>
    line
      .trim()
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((cell) => cell.trim());

  // §1: per category, the order of items (4th cell = screen key) and, per item,
  // the order of its tabs (every "← `ScreenKey`" of the 5th cell).
  const itemOrder = new Map(); // screenKey -> index
  const tabOrder = new Map(); // parentKey -> Map(childKey -> index)
  let counter = 0;
  for (const line of lines.slice(s1, s2)) {
    if (!/^\|\s*\d+\s*\|/.test(line)) continue;
    const cells = cellsOf(line);
    const screenKey = (cells[3] ?? "").replace(/`/g, "").trim();
    if (!screenKey) continue;
    itemOrder.set(screenKey, counter++);
    const children = [...(cells[4] ?? "").matchAll(/←\s*`([A-Za-z0-9]+)`/g)].map((m) => m[1]);
    tabOrder.set(screenKey, new Map(children.map((child, index) => [child, index])));
  }

  // §5: old route -> new route (used only as a cross-check of the derivation).
  const legacy = new Map();
  if (s5 !== -1 && s6 !== -1) {
    for (const line of lines.slice(s5, s6)) {
      if (!line.startsWith("| `")) continue;
      const cells = cellsOf(line).map((cell) => cell.replace(/`/g, ""));
      legacy.set(cells[0], cells[3]);
    }
  }
  return { itemOrder, tabOrder, legacy };
}

// ---------------------------------------------------------------- old routes
function readOldRoutes() {
  if (!existsSync(LEGACY_ROUTES_FILE)) fail(`legacy routes snapshot not found: ${LEGACY_ROUTES_FILE}`);
  let snapshot;
  try {
    snapshot = JSON.parse(readFileSync(LEGACY_ROUTES_FILE, "utf8"));
  } catch (error) {
    fail(`cannot parse ${LEGACY_ROUTES_FILE}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const routes = Array.isArray(snapshot?.routes) ? snapshot.routes : [];
  const ref = typeof snapshot?.ref === "string" ? snapshot.ref : "";
  if (routes.length === 0 || !ref) fail(`${LEGACY_ROUTES_FILE} must carry { ref, routes: [{ path, screen }] }`);
  const seen = new Set();
  routes.forEach((route, index) => {
    const ok = route && typeof route.path === "string" && typeof route.screen === "string" && /^\/backoffice(\/|$)/.test(route.path);
    if (!ok) fail(`${LEGACY_ROUTES_FILE}: route #${index + 1} is not a { path: "/backoffice/…", screen } entry`);
    if (seen.has(route.path)) fail(`${LEGACY_ROUTES_FILE}: duplicate legacy path ${route.path}`);
    seen.add(route.path);
  });
  return { ref, routes };
}

// ---------------------------------------------------------------- build
function build() {
  const rows = readCsv(csvPath);
  const md = readMdSections(mdPath);
  const byKey = new Map();
  const errors = [];

  for (const row of rows) {
    if (byKey.has(row.screenKey)) errors.push(`duplicate screenKey ${row.screenKey}`);
    byKey.set(row.screenKey, row);
    if (!DECISIONS.has(row.decision)) errors.push(`${row.screenKey}: unknown decision "${row.decision}"`);
    for (const token of splitRoles(row.roles)) {
      if (!ROLE_TOKENS.has(token)) errors.push(`${row.screenKey}: unknown role token "${token}"`);
    }
    if (["keep", "merge-into", "dev-only"].includes(row.decision)) {
      if (!row.url) errors.push(`${row.screenKey}: ${row.decision} without url`);
      else if (!row.url.startsWith("/") || row.url.startsWith("/backoffice")) errors.push(`${row.screenKey}: invalid url "${row.url}"`);
      if (!row.etiquetaES || row.etiquetaES === "—") errors.push(`${row.screenKey}: ${row.decision} without etiquetaES`);
      if (row.etiquetaES.length > MAX_LABEL) errors.push(`${row.screenKey}: label longer than ${MAX_LABEL} chars`);
      if (splitRoles(row.roles).length === 0) errors.push(`${row.screenKey}: ${row.decision} without roles`);
    } else if (row.url) {
      errors.push(`${row.screenKey}: ${row.decision} must not carry a url`);
    }
    if (row.decision === "dev-only" && !row.url.startsWith(`${DEV_ONLY_PREFIX}/`)) {
      errors.push(`${row.screenKey}: dev-only url must live under ${DEV_ONLY_PREFIX}/*`);
    }
    if (row.decision !== "dev-only" && row.url.startsWith(`${DEV_ONLY_PREFIX}/`)) {
      errors.push(`${row.screenKey}: only dev-only rows may live under ${DEV_ONLY_PREFIX}/*`);
    }
    const ordered = ORDERED_DECISIONS.has(row.decision) && row.destino !== PUBLIC_CATEGORY;
    if (ordered && !/^[1-9][0-9]*$/.test(row.orden)) errors.push(`${row.screenKey}: ${row.decision} needs a positive integer in "orden" (got "${row.orden}")`);
    if (!ordered && row.orden !== "") errors.push(`${row.screenKey}: only keep items and merge-into tabs may carry "orden" (got "${row.orden}")`);
  }

  const urlOwners = new Map();
  for (const row of rows) {
    if (!row.url) continue;
    if (urlOwners.has(row.url)) errors.push(`url ${row.url} used by ${urlOwners.get(row.url)} and ${row.screenKey}`);
    urlOwners.set(row.url, row.screenKey);
  }

  // Resolve the URL a screen key ends up at (aliases and retired screens follow
  // their destination; free-text destinations resolve to null).
  function resolveUrl(key, seen = new Set()) {
    const row = byKey.get(key);
    if (!row || seen.has(key)) return null;
    seen.add(key);
    if (row.url) return row.url;
    if (row.decision === "duplicate-of" || row.decision === "retire") return resolveUrl(row.destino, seen);
    return null;
  }

  // Parent/child structure.
  const keepRows = rows.filter((row) => row.decision === "keep" && row.destino !== PUBLIC_CATEGORY);
  const publicRows = rows.filter((row) => row.decision === "keep" && row.destino === PUBLIC_CATEGORY);
  const mergeRows = rows.filter((row) => row.decision === "merge-into");
  const devRows = rows.filter((row) => row.decision === "dev-only");
  const retireRows = rows.filter((row) => row.decision === "retire");
  const aliasRows = rows.filter((row) => row.decision === "duplicate-of");

  for (const row of keepRows) {
    if (!CATEGORY_ORDER.includes(row.destino)) errors.push(`${row.screenKey}: unknown category "${row.destino}"`);
  }
  for (const row of mergeRows) {
    const parent = byKey.get(row.destino);
    if (!parent || parent.decision !== "keep") errors.push(`${row.screenKey}: merge-into destination "${row.destino}" is not a keep item`);
    else {
      const parentRoles = new Set(splitRoles(parent.roles));
      const extra = splitRoles(row.roles).filter((token) => !parentRoles.has(token));
      if (extra.length) errors.push(`${row.screenKey}: tab roles ${extra.join(",")} not in item ${parent.screenKey} roles`);
    }
  }
  for (const row of devRows) {
    const parent = byKey.get(row.destino);
    if (!parent || !["keep", "dev-only"].includes(parent.decision)) errors.push(`${row.screenKey}: dev-only parent "${row.destino}" is not a keep or dev-only screen`);
  }
  for (const row of aliasRows) {
    const target = byKey.get(row.destino);
    if (!target) errors.push(`${row.screenKey}: duplicate-of unknown screen "${row.destino}"`);
    else if (!LIVE_DECISIONS.has(target.decision)) {
      errors.push(`${row.screenKey}: duplicate-of "${row.destino}" is ${target.decision}, not a live screen (point the alias at the screen that covers it)`);
    }
  }

  // `orden` must be exactly 1..n inside every category (items) and inside every
  // parent (tabs): no gaps, no duplicates.
  const checkPositions = (scope, list) => {
    const positions = list.map((row) => Number(row.orden)).sort((a, b) => a - b);
    const expected = positions.map((_, index) => index + 1);
    if (positions.join(",") !== expected.join(",")) {
      errors.push(`${scope}: "orden" must be exactly 1..${list.length} (got ${positions.join(",") || "nothing"})`);
    }
  };
  for (const label of CATEGORY_ORDER) checkPositions(`category ${label}`, keepRows.filter((row) => row.destino === label));
  for (const parent of new Set(mergeRows.map((row) => row.destino))) checkPositions(`tabs of ${parent}`, mergeRows.filter((row) => row.destino === parent));

  if (errors.length) fail(`CSV inconsistencies:\n  - ${errors.join("\n  - ")}`);

  const orderOf = (row) => Number(row.orden);

  const tabsByParent = new Map();
  mergeRows.forEach((row, index) => {
    const list = tabsByParent.get(row.destino) ?? [];
    list.push({ row, index });
    tabsByParent.set(row.destino, list);
  });

  const toTab = (row) => {
    const tab = {
      screenKey: row.screenKey,
      label: row.etiquetaES,
      url: row.url,
      roles: splitRoles(row.roles),
      modulesAny: modulesAnyOf(row)
    };
    if (hasParams(row.url)) tab.detail = true;
    return tab;
  };

  const categories = CATEGORY_ORDER.map((label) => {
    const items = keepRows
      .map((row, index) => ({ row, index }))
      .filter(({ row }) => row.destino === label)
      .sort((a, b) => orderOf(a.row) - orderOf(b.row))
      .map(({ row }) => {
        const tabs = (tabsByParent.get(row.screenKey) ?? [])
          .sort((a, b) => orderOf(a.row) - orderOf(b.row))
          .map(({ row: child }) => toTab(child));
        return {
          screenKey: row.screenKey,
          label: row.etiquetaES,
          url: row.url,
          baseTab: row.tab || null,
          roles: splitRoles(row.roles),
          modulesAny: modulesAnyOf(row),
          tabs
        };
      });
    return { key: slug(label), label, items };
  });

  // Cross-check: the `orden` column must tell the same story as the §1 tables
  // of the .md while that document exists (relative order of the keys both know).
  if (md) {
    const disagreements = [];
    const sameRelativeOrder = (keys, index) => {
      const known = keys.filter((key) => index.has(key));
      const sorted = [...known].sort((a, b) => index.get(a) - index.get(b));
      return known.join(",") === sorted.join(",") ? null : { csv: known, md: sorted };
    };
    for (const category of categories) {
      const items = category.items.map((item) => item.screenKey);
      const diff = sameRelativeOrder(items, md.itemOrder);
      if (diff) disagreements.push(`${category.label}: CSV "orden" gives [${diff.csv.join(", ")}] but .md §1 lists [${diff.md.join(", ")}]`);
      for (const item of category.items) {
        const tabIndex = md.tabOrder.get(item.screenKey);
        if (!tabIndex) continue;
        const tabDiff = sameRelativeOrder(item.tabs.map((tab) => tab.screenKey), tabIndex);
        if (tabDiff) disagreements.push(`tabs of ${item.screenKey}: CSV "orden" gives [${tabDiff.csv.join(", ")}] but .md §1 lists [${tabDiff.md.join(", ")}]`);
      }
    }
    if (disagreements.length) {
      fail(`the "orden" column disagrees with ${mdPath} §1 (the CSV is the source of truth: fix the column or the tables):\n  - ${disagreements.join("\n  - ")}`);
    }
  }

  const devOnly = devRows.map((row) => ({
    screenKey: row.screenKey,
    label: row.etiquetaES,
    url: row.url,
    roles: splitRoles(row.roles),
    modulesAny: modulesAnyOf(row),
    parent: row.destino
  }));

  const retired = retireRows.map((row) => ({
    screenKey: row.screenKey,
    coveredBy: row.destino,
    url: resolveUrl(row.destino)
  }));

  const aliases = aliasRows.map((row) => ({
    screenKey: row.screenKey,
    canonical: row.destino,
    url: resolveUrl(row.destino)
  }));

  const publicScreens = publicRows.map((row) => ({
    screenKey: row.screenKey,
    label: row.etiquetaES,
    url: row.url
  }));

  // Legacy routes: old path -> new URL of the screen it served.
  const legacyRoutes = [];
  const unresolved = [];
  const oldRoutes = readOldRoutes();
  for (const { path, screen } of oldRoutes.routes) {
    const to = resolveUrl(screen);
    if (!to) {
      unresolved.push(`${path} (${screen})`);
      continue;
    }
    legacyRoutes.push({ from: path, to });
  }
  if (unresolved.length) fail(`legacy routes without destination:\n  - ${unresolved.join("\n  - ")}`);
  legacyRoutes.sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0));

  if (md?.legacy.size) {
    const derived = new Map(legacyRoutes.map((route) => [route.from, route.to]));
    const mismatches = [];
    for (const [from, to] of md.legacy) {
      if (!derived.has(from)) mismatches.push(`${from}: in .md §5 but not derivable from the routes file`);
      else if (derived.get(from) !== to) mismatches.push(`${from}: .md §5 says ${to}, CSV derivation says ${derived.get(from)}`);
    }
    if (mismatches.length) fail(`legacy routes disagree with .md §5:\n  - ${mismatches.join("\n  - ")}`);
  }

  const itemCount = categories.reduce((sum, category) => sum + category.items.length, 0);
  const tabCount = categories.reduce((sum, category) => sum + category.items.reduce((s, item) => s + item.tabs.length, 0), 0);

  return {
    meta: {
      source: "pilots/tanda5-nav-tree.csv",
      generator: "scripts/build-nav-tree.mjs",
      orderSource: "pilots/tanda5-nav-tree.csv (columna orden)",
      legacyRoutesSource: `scripts/legacy-backoffice-routes.json (${oldRoutes.ref})`,
      counts: {
        csvRows: rows.length,
        categories: categories.length,
        items: itemCount,
        tabs: tabCount,
        devOnly: devOnly.length,
        retired: retired.length,
        aliases: aliases.length,
        publicScreens: publicScreens.length,
        legacyRoutes: legacyRoutes.length
      }
    },
    categories,
    legacyRoutes,
    devOnly,
    retired,
    aliases,
    publicScreens
  };
}

const tree = build();
const output = `${JSON.stringify(tree, null, 2)}\n`;

if (checkOnly) {
  const current = existsSync(outPath) ? readFileSync(outPath, "utf8") : "";
  if (current !== output) fail(`${outPath} is stale: run node scripts/build-nav-tree.mjs`);
  console.log(`build-nav-tree: ${outPath} is up to date (${tree.meta.counts.items} items, ${tree.meta.counts.tabs} tabs, ${tree.meta.counts.legacyRoutes} legacy routes)`);
} else {
  writeFileSync(outPath, output, "utf8");
  console.log(
    `build-nav-tree: wrote ${outPath} — ${tree.meta.counts.categories} categories, ${tree.meta.counts.items} items, ${tree.meta.counts.tabs} tabs, ` +
      `${tree.meta.counts.devOnly} dev-only, ${tree.meta.counts.retired} retired, ${tree.meta.counts.aliases} aliases, ${tree.meta.counts.legacyRoutes} legacy routes ` +
      `(order: ${tree.meta.orderSource})`
  );
}
