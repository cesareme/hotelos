#!/usr/bin/env node
// Cocoa 22 · screen inventory (docs/design/COCOA-22.md §10).
//
// Walks apps/admin-web/src/screens/**/*.tsx (tests excluded), measures the
// legacy debt of every screen file against the Cocoa 22 contract and guesses
// its page archetype, then writes docs/design/cocoa-22-inventory.json.
//
//   node scripts/cocoa-22-inventory.mjs            # writes the JSON
//   node scripts/cocoa-22-inventory.mjs --stdout   # prints it instead
//   node scripts/cocoa-22-inventory.mjs --summary  # human-readable totals only
//
// Per file it counts: `.bo-*` classes (and `bo-card` on its own), raw <button>,
// <CocoaButton>, raw <table>, <CocoaTable>, raw <input>/<select>/<textarea>,
// inline `style={` props, colour literals (#hex / rgb() / hsl()), whether the
// screen paints a CocoaPageHeader (or its hosted equivalent) and whether it
// reads the tab host. Screen keys come from App.tsx (SCREEN_COMPONENTS +
// lazyNamed imports) and from the tab-container loaders in screens/tabs/**;
// the category comes from navigation/nav-tree.generated.json.
//
// Output is deterministic (no timestamps, sorted by path) so it can be
// committed and diffed; the contract test may read it to list migrated screens.

import { readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const adminSrc = join(repoRoot, "apps", "admin-web", "src");
const screensDir = join(adminSrc, "screens");
const outFile = join(repoRoot, "docs", "design", "cocoa-22-inventory.json");

const args = new Set(process.argv.slice(2));
const toPosix = (p) => p.split(sep).join("/");

// ----------------------------------------------------------------- walk

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (entry === "__tests__") continue;
      walk(full, out);
    } else if (entry.endsWith(".tsx")) {
      out.push(full);
    }
  }
  return out;
}

// ----------------------------------------------------------------- metrics

const count = (src, re) => (src.match(re) ?? []).length;

// Colour literals: hex / rgb() / hsl() outside `var(--x, …)` fallbacks are the
// real debt; fallbacks are counted apart so the contract can decide.
function colourLiterals(src) {
  const hex = /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![\w-])/g;
  const fn = /\b(?:rgba?|hsla?)\(/g;
  let all = 0;
  let fallback = 0;
  for (const re of [hex, fn]) {
    for (const m of src.matchAll(re)) {
      // A hex inside a URL hash (`#modulo=`), an id selector or a template
      // route is not a colour: require a colour-ish context on the same line.
      const lineStart = src.lastIndexOf("\n", m.index) + 1;
      const lineEnd = src.indexOf("\n", m.index);
      const line = src.slice(lineStart, lineEnd === -1 ? undefined : lineEnd);
      if (re === hex && !/color|background|border|fill|stroke|shadow|gradient|accent|tone|palette|hex|#[0-9a-fA-F]{6}["'`]/i.test(line)) continue;
      all += 1;
      const before = src.slice(Math.max(0, m.index - 60), m.index);
      if (/var\(--[\w-]+,\s*$/.test(before)) fallback += 1;
    }
  }
  return { all, fallback };
}

function measure(src) {
  const colours = colourLiterals(src);
  return {
    lines: src.split("\n").length,
    // `--bo-min-px` (a custom property of the GM grid) is not a legacy class.
    boClasses: count(src, /(?<!-)\bbo-[a-z0-9-]+/g),
    boCard: count(src, /\bbo-card\b/g),
    boPageTitle: count(src, /\bbo-page-title\b/g),
    rawButtons: count(src, /<button\b/g),
    cocoaButtons: count(src, /<CocoaButton\b/g),
    rawTables: count(src, /<table\b/g),
    cocoaTables: count(src, /<CocoaTable\b/g),
    rawInputs: count(src, /<(?:input|select|textarea)\b/g),
    cocoaInputs: count(src, /<Cocoa(?:Input|Select|Switch|DatePicker|SearchInput|SegmentedControl)\b/g),
    inlineStyles: count(src, /\bstyle=\{/g),
    cocoaCards: count(src, /<CocoaCard\b/g),
    colourLiterals: colours.all,
    colourFallbacks: colours.fallback,
    rawH1: count(src, /<h1\b/g),
    hasCocoaPageHeader: /<CocoaPage\b|<CocoaPageHeader\b|pageHead\(|<HostedHead\b|<Head\b|<NavItemTabs\b/.test(src),
    usesTabHost: /useTabHost\(/.test(src),
    usesSplitView: /<CocoaSplitView\b|<SidePanel\b/.test(src),
    usesStepper: /<CocoaStepper\b/.test(src),
    usesGmGrid: /gm-grid|spanStyle\(/.test(src),
    emoji: count(src, /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu)
  };
}

// ----------------------------------------------------------------- archetype

const ARCHETYPES = ["dashboard", "lista", "detalle", "formulario", "asistente", "workspace", "calendario", "chat", "dialogo", "contenedor", "otro"];

// Folder → category fallback for files no menu entry points at (dialogs,
// drawers, sub-cards and the tab containers themselves).
const FOLDER_CATEGORY = {
  "tabs/hoy": "hoy",
  "tabs/recepcion": "recepcion",
  "tabs/operaciones": "operaciones",
  "tabs/comercial": "comercial",
  "tabs/revenue": "revenue",
  "tabs/finanzas": "finanzas",
  "tabs/cumplimiento": "cumplimiento",
  "tabs/informes": "informes",
  "tabs/configuracion": "configuracion",
  admin: "configuracion",
  onboarding: "configuracion",
  auth: "publico",
  errors: "publico",
  billing: "finanzas",
  invoicing: "finanzas",
  fiscal: "cumplimiento",
  reservations: "recepcion",
  operations: "operaciones",
  developer: "desarrollo",
  preview: "desarrollo"
};

function folderCategory(relPath) {
  const parts = relPath.split("/");
  const two = parts.slice(0, 2).join("/");
  if (FOLDER_CATEGORY[two]) return FOLDER_CATEGORY[two];
  return FOLDER_CATEGORY[parts[0]] ?? "compartido";
}

function classify(relPath, src, m) {
  const name = relPath.split("/").pop().replace(/\.tsx$/, "");
  if (relPath.startsWith("tabs/")) return "contenedor";
  if (/Dialog|Drawer|Sheet|Modal/i.test(name)) return "dialogo";
  if (/Chat|Copilot|Assistant(?!Tool)|ConciergeInbox/i.test(name) && /<textarea|<input|CocoaInput/.test(src)) return "chat";
  if (m.usesStepper || /Wizard|Onboarding|GoLive|Checklist|Import(?!ant)/i.test(name)) return "asistente";
  if (/Calendar|Planning|Timeline|RateGrid|Tape|Cronograma|Availability|Demand|Gantt|Schedule|Shift/i.test(name) || /overflow-x:\s*"?auto|overflowX:\s*"auto"/.test(src) && m.rawTables + m.cocoaTables > 0 && /sticky/.test(src)) return "calendario";
  if (m.usesSplitView || /Inbox|Workspace|Editor|Composer|Builder|Mapper/i.test(name)) return "workspace";
  const kpiHits = count(src, /Kpi|kpi|bo-metric|StatTile|MetricCard|sparkline|Sparkline|Gauge|Donut/g);
  if (/Dashboard|Home|Overview|Center|Cockpit|Summary|Pulse|Health/i.test(name) || kpiHits >= 3) return "dashboard";
  if (/Detail|Profile|Folio\b|Ficha|View$/i.test(name) || /useRouteParam\(/.test(src)) return "detalle";
  if (/Settings|Setup|Config|Create|Edit|Form|Preferences|Rules|Manager$/i.test(name) || m.rawInputs + m.cocoaInputs >= 6) return "formulario";
  if (m.rawTables + m.cocoaTables > 0 || /List|Table|Log|Registry|Queue|Ledger|Report/i.test(name)) return "lista";
  return "otro";
}

// ----------------------------------------------------------------- debt

// Files that never paint a page head of their own: dialogs, drawers, the tab
// containers and the sub-views the contract exempts (mirror of HEADER_EXEMPT
// in tests/cocoa-22-contract.test.mjs, rule 7) — the «sin cabecera» penalty
// does not apply to them.
const HEADER_EXEMPT = /^(tabs\/|.*(Dialog|Drawer)\.tsx$|ScreenScaffold\.tsx$|ModuleSettingsPlaceholder\.tsx$|operations\/FrontDeskActionQueue\.tsx$)/;

function debtPoints(m, headerExempt = false) {
  return Math.round(
    m.boCard * 1 +
      (m.boClasses - m.boCard) * 0.5 +
      m.rawButtons * 1 +
      m.rawTables * 3 +
      m.rawInputs * 1 +
      (m.colourLiterals - m.colourFallbacks) * 1 +
      m.colourFallbacks * 0.25 +
      m.inlineStyles * 0.25 +
      (m.hasCocoaPageHeader || m.usesTabHost || headerExempt ? 0 : 5) +
      m.emoji * 0.5
  );
}

// Debt drives the size; lines only push a clean-but-huge file one step up.
function sizeFor(lines, points) {
  if (points < 20 && lines < 300) return "S";
  if (points < 60 && lines < 800) return "M";
  if (points < 150 && lines < 1500) return "L";
  return "XL";
}

// ----------------------------------------------------------------- screen keys → files → categories

function screenKeyIndex() {
  const app = readFileSync(join(adminSrc, "App.tsx"), "utf8");
  const varToFile = new Map();
  for (const m of app.matchAll(/const (\w+) = lazyNamed\(\(\) => import\("\.\/screens\/([^"]+)"\)/g)) varToFile.set(m[1], `${m[2]}.tsx`);
  for (const m of app.matchAll(/import \{([^}]+)\} from "\.\/screens\/([^"]+)"/g)) {
    for (const part of m[1].split(",")) {
      const [, , alias] = part.trim().match(/^(\w+)(?:\s+as\s+(\w+))?$/) ?? [];
      const local = alias ?? part.trim().split(/\s+as\s+/).pop();
      if (local) varToFile.set(local, `${m[2]}.tsx`);
    }
  }
  const keyToFile = new Map();
  const block = app.slice(app.indexOf("const SCREEN_COMPONENTS"), app.indexOf("export type ScreenKey"));
  for (const m of block.matchAll(/^\s*(\w+)(?::\s*(\w+))?,?\s*$/gm)) {
    const key = m[1];
    const variable = m[2] ?? m[1];
    const file = varToFile.get(variable);
    if (file) keyToFile.set(key, file);
  }
  // Tab-container loaders: `Key: () => import("../../x/Y")` in screens/tabs/**.
  for (const full of walk(join(screensDir, "tabs"))) {
    const src = readFileSync(full, "utf8");
    for (const m of src.matchAll(/(\w+):\s*\(\)\s*=>\s*import\("\.\.\/\.\.\/([^"]+)"\)/g)) keyToFile.set(m[1], `${m[2]}.tsx`);
  }
  return keyToFile;
}

function categoryIndex() {
  const tree = JSON.parse(readFileSync(join(adminSrc, "navigation", "nav-tree.generated.json"), "utf8"));
  const keyToCategory = new Map();
  const labels = {};
  const visit = (catKey, item) => {
    if (item?.screenKey && !keyToCategory.has(item.screenKey)) keyToCategory.set(item.screenKey, catKey);
    for (const tab of item?.tabs ?? []) visit(catKey, tab);
  };
  for (const cat of tree.categories ?? []) {
    labels[cat.key] = cat.label;
    for (const item of cat.items ?? []) visit(cat.key, item);
  }
  const dev = tree.devOnly;
  if (dev) {
    labels.desarrollo = dev.label ?? "Desarrollo";
    for (const item of dev.items ?? (Array.isArray(dev) ? dev : [])) visit("desarrollo", item);
  }
  for (const key of tree.publicScreens ?? []) if (typeof key === "string" && !keyToCategory.has(key)) keyToCategory.set(key, "publico");
  labels.publico = labels.publico ?? "Público";
  labels.compartido = "Compartido / sin entrada de menú";
  return { keyToCategory, labels };
}

// ----------------------------------------------------------------- main

const keyToFile = screenKeyIndex();
const { keyToCategory, labels } = categoryIndex();
const fileToKeys = new Map();
for (const [key, file] of keyToFile) {
  const list = fileToKeys.get(file) ?? [];
  list.push(key);
  fileToKeys.set(file, list);
}

const screens = walk(screensDir)
  .map((full) => {
    const rel = toPosix(relative(screensDir, full));
    const src = readFileSync(full, "utf8");
    const metrics = measure(src);
    const keys = (fileToKeys.get(rel) ?? []).sort();
    const categories = [...new Set(keys.map((k) => keyToCategory.get(k)).filter(Boolean))];
    const category = categories[0] ?? folderCategory(rel);
    const headerExempt = HEADER_EXEMPT.test(rel);
    const points = debtPoints(metrics, headerExempt);
    return {
      path: `apps/admin-web/src/screens/${rel}`,
      name: rel.split("/").pop().replace(/\.tsx$/, ""),
      screenKeys: keys,
      category,
      categories,
      archetype: classify(rel, src, metrics),
      lines: metrics.lines,
      metrics,
      headerExempt,
      debtPoints: points,
      size: sizeFor(metrics.lines, points)
    };
  })
  .sort((a, b) => a.path.localeCompare(b.path));

const totals = { files: screens.length, lines: 0 };
const metricKeys = ["boClasses", "boCard", "boPageTitle", "rawButtons", "cocoaButtons", "rawTables", "cocoaTables", "rawInputs", "cocoaInputs", "inlineStyles", "cocoaCards", "colourLiterals", "colourFallbacks", "rawH1", "emoji"];
for (const k of metricKeys) totals[k] = 0;
totals.withPageHeader = 0;
totals.withTabHost = 0;
totals.debtPoints = 0;
const byCategory = {};
const byArchetype = Object.fromEntries(ARCHETYPES.map((a) => [a, 0]));
const bySize = { S: 0, M: 0, L: 0, XL: 0 };
for (const s of screens) {
  totals.lines += s.lines;
  for (const k of metricKeys) totals[k] += s.metrics[k];
  if (s.metrics.hasCocoaPageHeader) totals.withPageHeader += 1;
  if (s.metrics.usesTabHost) totals.withTabHost += 1;
  totals.debtPoints += s.debtPoints;
  byArchetype[s.archetype] += 1;
  bySize[s.size] += 1;
  const c = (byCategory[s.category] ??= { label: labels[s.category] ?? s.category, files: 0, lines: 0, debtPoints: 0, sizes: { S: 0, M: 0, L: 0, XL: 0 }, archetypes: {} });
  c.files += 1;
  c.lines += s.lines;
  c.debtPoints += s.debtPoints;
  c.sizes[s.size] += 1;
  c.archetypes[s.archetype] = (c.archetypes[s.archetype] ?? 0) + 1;
}

const inventory = {
  schema: "cocoa-22-inventory/1",
  root: "apps/admin-web/src/screens",
  generatedBy: "scripts/cocoa-22-inventory.mjs",
  debtFormula:
    "boCard*1 + otrasBo*0.5 + rawButtons*1 + rawTables*3 + rawInputs*1 + colourLiterals*1 (fallbacks*0.25) + inlineStyles*0.25 + 5 sin cabecera Cocoa (salvo diálogos, drawers, contenedores y sub-vistas exentas: headerExempt) + emoji*0.5",
  sizes: { S: "< 20 puntos y < 300 líneas", M: "< 60 y < 800", L: "< 150 y < 1500", XL: "resto" },
  categoryFallback: "sin entrada de menú → carpeta (FOLDER_CATEGORY); el resto → compartido",
  totals,
  bySize,
  byArchetype,
  byCategory: Object.fromEntries(Object.entries(byCategory).sort(([a], [b]) => a.localeCompare(b))),
  screens
};

const json = `${JSON.stringify(inventory, null, 2)}\n`;
if (args.has("--summary")) {
  console.log(`Cocoa 22 inventory · ${totals.files} pantallas · ${totals.lines} líneas · ${totals.debtPoints} puntos de deuda`);
  console.log(`  bo-card ${totals.boCard} · bo-* ${totals.boClasses} · <button> ${totals.rawButtons} (CocoaButton ${totals.cocoaButtons}) · <table> ${totals.rawTables} (CocoaTable ${totals.cocoaTables})`);
  console.log(`  inputs crudos ${totals.rawInputs} · style={} ${totals.inlineStyles} · colores literales ${totals.colourLiterals} (${totals.colourFallbacks} fallbacks) · con cabecera Cocoa ${totals.withPageHeader} · useTabHost ${totals.withTabHost}`);
  console.log(`  tamaños ${JSON.stringify(bySize)} · arquetipos ${JSON.stringify(byArchetype)}`);
  for (const [key, c] of Object.entries(inventory.byCategory)) console.log(`  ${key.padEnd(14)} ${String(c.files).padStart(3)} pantallas ${String(c.lines).padStart(6)} líneas ${String(c.debtPoints).padStart(5)} pts  ${JSON.stringify(c.sizes)}`);
} else if (args.has("--stdout")) {
  process.stdout.write(json);
} else {
  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, json);
  console.log(`Escrito ${toPosix(relative(repoRoot, outFile))} · ${totals.files} pantallas · ${totals.debtPoints} puntos de deuda`);
}
