// Contrato del árbol de navegación de la Tanda 5 (L1a).
//
// Fuente única: pilots/tanda5-nav-tree.csv (fuera del repo) → generado por
// scripts/build-nav-tree.mjs en apps/admin-web/src/navigation/nav-tree.generated.json
// (sí está en el repo). Este test ata el JSON a los criterios de cierre del
// plan (docs/audits/TANDA-5-PLAN-2026-09-15.md §4): ≤ 9 categorías, ≤ 12
// ítems por categoría, 100 % con URL, 0 duplicados, URLs kebab-case sin
// /backoffice, dev-only solo bajo /desarrollo/*, módulos y roles conocidos,
// y las redirecciones antiguas apuntando a URLs del árbol. Cuando el CSV está
// disponible en local, además comprueba que el JSON no está desactualizado.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = (relative) => readFileSync(new URL(relative, import.meta.url), "utf8");
const tree = JSON.parse(read("../apps/admin-web/src/navigation/nav-tree.generated.json"));
const moduleCodesSource = read("../packages/product/src/modules/module-codes.ts");
const permissionsSource = read("../packages/shared/src/permissions.ts");
const roleTokensSource = read("../apps/admin-web/src/navigation/role-tokens.ts");
const navTreeSource = read("../apps/admin-web/src/navigation/nav-tree.ts");
const routeTabsSource = read("../apps/admin-web/src/components/cocoa/CocoaRouteTabs.tsx");
const tabsIndexSource = read("../apps/admin-web/src/screens/tabs/index.ts");
const appSource = read("../apps/admin-web/src/App.tsx");
const routesSource = read("../apps/admin-web/src/routes/backoffice.routes.tsx");
const runbook = read("../docs/runbooks/navegacion-tanda-5.md");

const PLAN_CATEGORIES = ["Hoy", "Recepción", "Operaciones", "Comercial", "Revenue", "Finanzas", "Cumplimiento", "Informes", "Configuración"];
const ROLE_TOKENS = ["direccion", "recepcion", "pisos", "mantenimiento", "revenue", "finanzas", "comercial", "fnb", "admin", "publico"];
const KEBAB_URL = /^(\/[a-z0-9]+(?:-[a-z0-9]+)*|\/:[a-z]+)+$/;
const MAX_ITEMS_PER_CATEGORY = 12;
const MAX_LABEL_LENGTH = 28;

const moduleCodes = new Set(
  [...moduleCodesSource.matchAll(/^\s*"([a-z_]+)",?$/gm)].map((m) => m[1])
);
const templateBlock = permissionsSource.match(/ROLE_TEMPLATE_KEYS[^=]*=\s*\[([^\]]+)\]/);
const templateKeys = templateBlock ? [...templateBlock[1].matchAll(/"([a-z_]+)"/g)].map((k) => k[1]) : [];

const items = tree.categories.flatMap((category) => category.items);
const tabs = items.flatMap((item) => item.tabs);
const menuUrls = [...items.map((item) => item.url), ...tabs.map((tab) => tab.url)];
const allUrls = [...menuUrls, ...tree.devOnly.map((s) => s.url), ...tree.publicScreens.map((s) => s.url)];
const allKeys = [
  ...items.map((item) => item.screenKey),
  ...tabs.map((tab) => tab.screenKey),
  ...tree.devOnly.map((s) => s.screenKey),
  ...tree.publicScreens.map((s) => s.screenKey)
];

describe("Nav tree · shape (plan §4)", () => {
  it("has exactly the nine domain categories, in plan order, with kebab keys", () => {
    assert.deepEqual(tree.categories.map((c) => c.label), PLAN_CATEGORIES);
    for (const category of tree.categories) {
      assert.match(category.key, /^[a-z]+$/);
      assert.ok(category.items.length >= 1, `${category.label} is empty`);
      assert.ok(category.items.length <= MAX_ITEMS_PER_CATEGORY, `${category.label} has ${category.items.length} items (> ${MAX_ITEMS_PER_CATEGORY})`);
    }
  });

  it("gives every item, tab, dev-only and public screen a URL, kebab-case, outside /backoffice", () => {
    for (const url of allUrls) {
      assert.equal(typeof url, "string");
      assert.ok(url.length > 0, "empty url");
      assert.match(url, KEBAB_URL, `${url} is not kebab-case`);
      assert.ok(!url.startsWith("/backoffice"), `${url} still under /backoffice`);
    }
    assert.equal(allUrls.length, tree.meta.counts.items + tree.meta.counts.tabs + tree.meta.counts.devOnly + tree.meta.counts.publicScreens);
  });

  it("has no duplicated URL nor screen key", () => {
    assert.equal(new Set(allUrls).size, allUrls.length, "duplicate URL");
    assert.equal(new Set(allKeys).size, allKeys.length, "duplicate screen key");
    for (const alias of tree.aliases) assert.ok(!allKeys.includes(alias.screenKey), `${alias.screenKey} is both alias and screen`);
    for (const retired of tree.retired) assert.ok(!allKeys.includes(retired.screenKey), `${retired.screenKey} is both retired and screen`);
  });

  it("keeps dev-only screens under /desarrollo/* and nothing else there", () => {
    for (const screen of tree.devOnly) {
      assert.ok(screen.url.startsWith("/desarrollo/"), `${screen.url} not under /desarrollo/`);
      assert.deepEqual(screen.roles, ["admin"], `${screen.screenKey} dev-only must be admin only`);
      assert.ok(typeof screen.parent === "string" && screen.parent.length > 0);
    }
    for (const url of [...menuUrls, ...tree.publicScreens.map((s) => s.url)]) {
      assert.ok(!url.startsWith("/desarrollo"), `${url} is a menu URL under /desarrollo`);
    }
  });

  it("uses labels ≤ 28 characters without roadmap words", () => {
    for (const entry of [...items, ...tabs, ...tree.devOnly]) {
      assert.ok(entry.label.length <= MAX_LABEL_LENGTH, `${entry.label} too long`);
      assert.doesNotMatch(entry.label, /próximamente|sandbox|stub|mock|Q[1-4]\b/i, `${entry.label} carries roadmap jargon`);
    }
  });
});

describe("Nav tree · gates", () => {
  it("uses only known role tokens and keeps tab roles inside item roles", () => {
    for (const entry of [...items, ...tabs, ...tree.devOnly]) {
      assert.ok(entry.roles.length > 0, `${entry.screenKey} without roles`);
      for (const role of entry.roles) assert.ok(ROLE_TOKENS.includes(role), `${entry.screenKey}: unknown role ${role}`);
    }
    for (const item of items) {
      for (const tab of item.tabs) {
        for (const role of tab.roles) assert.ok(item.roles.includes(role), `${tab.screenKey}: role ${role} not in ${item.screenKey}`);
      }
    }
  });

  it("gates only with module codes that exist in the product manifest", () => {
    assert.ok(moduleCodes.size >= 30, "module-codes.ts not parsed");
    for (const entry of [...items, ...tabs, ...tree.devOnly]) {
      assert.ok(Array.isArray(entry.modulesAny));
      for (const code of entry.modulesAny) assert.ok(moduleCodes.has(code), `${entry.screenKey}: unknown module ${code}`);
    }
  });

  it("marks parametrised sub-URLs as detail so tab strips skip them", () => {
    for (const tab of tabs) {
      const hasParams = /\/:/.test(tab.url);
      assert.equal(Boolean(tab.detail), hasParams, `${tab.screenKey} detail flag`);
    }
    for (const item of items) assert.ok(!/\/:/.test(item.url), `${item.screenKey}: menu item with params`);
  });
});

describe("Nav tree · legacy redirects (§5)", () => {
  it("covers every old /backoffice/* path once and lands on a tree URL", () => {
    const targets = new Set(allUrls);
    const froms = tree.legacyRoutes.map((route) => route.from);
    assert.equal(new Set(froms).size, froms.length, "duplicate legacy from");
    assert.ok(tree.legacyRoutes.length >= 199, `only ${tree.legacyRoutes.length} legacy routes`);
    for (const route of tree.legacyRoutes) {
      assert.ok(route.from.startsWith("/backoffice"), `${route.from} is not a legacy path`);
      assert.ok(targets.has(route.to), `${route.from} → ${route.to} is not a tree URL`);
    }
  });

  it("resolves aliases and retired screens to a covering URL or an explicit note", () => {
    for (const alias of tree.aliases) assert.ok(alias.url === null || targets(alias.url), `${alias.screenKey}: ${alias.url}`);
    for (const retired of tree.retired) {
      assert.ok(typeof retired.coveredBy === "string" && retired.coveredBy.length > 0);
      assert.ok(retired.url === null || targets(retired.url), `${retired.screenKey}: ${retired.url}`);
    }
    function targets(url) {
      return allUrls.includes(url);
    }
  });
});

describe("Nav tree · source modules (L1a)", () => {
  it("role-tokens maps every RBAC template of packages/shared plus sales and fnb", () => {
    assert.ok(templateKeys.length >= 9, "ROLE_TEMPLATE_KEYS not parsed");
    for (const key of [...templateKeys, "sales", "fnb"]) {
      assert.match(roleTokensSource, new RegExp(`\\b${key}:\\s*"(${ROLE_TOKENS.join("|")})"`), `template ${key} unmapped`);
    }
    for (const token of ROLE_TOKENS) assert.ok(roleTokensSource.includes(`"${token}"`), `token ${token} missing`);
    assert.match(roleTokensSource, /export function canSee\(/);
    assert.match(roleTokensSource, /export function roleHome\(/);
    assert.match(roleTokensSource, /MOBILE_BREAKPOINT_PX = 700/);
  });

  it("nav-tree.ts loads the generated JSON and exposes the L1b helpers", () => {
    assert.match(navTreeSource, /from "\.\/nav-tree\.generated\.json"/);
    for (const name of ["findByUrl", "findByScreen", "urlForScreen", "resolveLegacyPath", "visibleCategories", "landingTabFor", "menuEntriesUnlockedBy", "isDevModeEnabled"]) {
      assert.match(navTreeSource, new RegExp(`export function ${name}\\(`), `${name} missing`);
    }
    assert.match(navTreeSource, /DEV_ONLY_PREFIX = "\/desarrollo"/);
  });

  it("CocoaRouteTabs keeps the active tab in the URL and never dispatches hotelos-nav", () => {
    assert.match(routeTabsSource, /role="tablist"/);
    assert.match(routeTabsSource, /role="tab"/);
    assert.match(routeTabsSource, /role="tabpanel"/);
    assert.match(routeTabsSource, /TAB_NAV_EVENT = "hotelos-tab-nav"/);
    assert.match(routeTabsSource, /window\.history\.pushState/);
    assert.match(routeTabsSource, /addEventListener\("popstate"/);
    assert.match(routeTabsSource, /Suspense/);
    assert.doesNotMatch(routeTabsSource, /new CustomEvent[^\n]*"hotelos-nav"/);
  });

  it("the runbook documents the L1a → L1b → L1c hand-off", () => {
    for (const heading of ["## Cómo se compone el menú", "## Cómo añadir una pantalla o una pestaña", "## Cómo migrar formateadores", "## Cómo gatear por módulo y por rol", "## Orden de los lotes: L1a → L1b → L1c"]) {
      assert.ok(runbook.includes(heading), `runbook missing "${heading}"`);
    }
    assert.ok(runbook.includes("scripts/build-nav-tree.mjs"));
    assert.ok(runbook.includes("nav-tree.generated.json"));
    assert.ok(runbook.includes("hotelos-tab-nav"));
  });
});

describe("Router · registro de L1b (App.tsx + routes/backoffice.routes.tsx)", () => {
  const aliasKeys = tree.aliases.map((alias) => alias.screenKey);
  const retiredKeys = tree.retired.map((entry) => entry.screenKey);
  const registryMatch = appSource.match(/const\s+SCREEN_COMPONENTS\s*=\s*\{([\s\S]*?)\n\};/);
  const registryBody = (registryMatch?.[1] ?? "").replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
  const registeredKeys = [...registryBody.matchAll(/^\s*([A-Za-z_$][\w$]*)\s*[:,]/gm)].map((m) => m[1]);

  it("screens/tabs/index.ts exports one container per file and every export resolves to a file", () => {
    const codeOnly = tabsIndexSource.split("\n").filter((line) => !line.trim().startsWith("//")).join("\n");
    const exports = [...codeOnly.matchAll(/export \{ default as (\w+) \} from "\.\/([^"]+)";/g)];
    assert.ok(exports.length >= 35, `only ${exports.length} containers exported`);
    for (const [, name, relative] of exports) {
      const file = fileURLToPath(new URL(`../apps/admin-web/src/screens/tabs/${relative}.tsx`, import.meta.url));
      assert.ok(existsSync(file), `${name} → ${relative}.tsx does not exist`);
      assert.match(read(`../apps/admin-web/src/screens/tabs/${relative}.tsx`), new RegExp(`export default (function )?${name}\\b`), `${name} is not the default export of ${relative}.tsx`);
    }
    assert.doesNotMatch(tabsIndexSource, /export \{\};/, "the empty marker of L1a must be gone");
  });

  it("SCREEN_COMPONENTS = every screen key of the tree + the aliases, and nothing else (una pantalla = una URL)", () => {
    assert.ok(registeredKeys.length > 0, "SCREEN_COMPONENTS not parsed");
    const registered = new Set(registeredKeys);
    assert.equal(registeredKeys.length, registered.size, "duplicate SCREEN_COMPONENTS key");
    for (const key of allKeys) assert.ok(registered.has(key), `${key} (tree) missing from SCREEN_COMPONENTS`);
    for (const key of aliasKeys) assert.ok(registered.has(key), `${key} (alias) missing from SCREEN_COMPONENTS`);
    for (const key of retiredKeys) assert.ok(!registered.has(key), `${key} is retired but still registered`);
    const expected = new Set([...allKeys, ...aliasKeys]);
    for (const key of registeredKeys) assert.ok(expected.has(key), `${key} is registered but has no URL in the tree`);
    assert.equal(registered.size, allKeys.length + aliasKeys.length);
  });

  it("every tab key maps to the container of its item and every alias to the component of its canonical key", () => {
    const binding = new Map([...registryBody.matchAll(/^\s*([A-Za-z_$][\w$]*)\s*(?::\s*([A-Za-z_$][\w$]*))?\s*,?\s*$/gm)].map((m) => [m[1], m[2] ?? m[1]]));
    for (const item of items) {
      if (item.tabs.length === 0) continue;
      const container = binding.get(item.screenKey);
      assert.ok(container && /Tabs$/.test(container), `${item.screenKey} must be served by a tab container (got ${container})`);
      for (const tab of item.tabs) assert.equal(binding.get(tab.screenKey), container, `${tab.screenKey} must map to ${container}`);
    }
    // The canonical key of an alias may itself be retired (KioskSettings →
    // KioskSettingsReal → /comercial/ventas-adicionales/portal): then the alias
    // must map to the component that serves the covering URL.
    const keyForUrl = new Map([...items.flatMap((item) => [[item.url, item.screenKey], ...item.tabs.map((tab) => [tab.url, tab.screenKey])]), ...tree.devOnly.map((s) => [s.url, s.screenKey])]);
    const componentFor = (key) => {
      if (binding.has(key)) return binding.get(key);
      const retired = tree.retired.find((entry) => entry.screenKey === key);
      return retired?.url ? binding.get(keyForUrl.get(retired.url)) : undefined;
    };
    for (const alias of tree.aliases) {
      assert.equal(binding.get(alias.screenKey), componentFor(alias.canonical), `${alias.screenKey} must map to the component of ${alias.canonical}`);
    }
  });

  it("only the dev-only screens keep a makeModulePlaceholder (presupuesto 20)", () => {
    const calls = (appSource.match(/makeModulePlaceholder\(/g) ?? []).length;
    const devPlaceholders = tree.devOnly.filter((screen) => !/^(OnboardingProjects|FileUploadAndClassification|AIExtractionReview|MigrationBatches)$/.test(screen.screenKey)).length;
    assert.equal(calls, devPlaceholders, `${calls} placeholder calls for ${devPlaceholders} dev-only placeholders`);
    assert.ok(calls <= 20);
  });

  it("the route table derives from the tree and the shell resolves legacy paths with replaceState", () => {
    for (const marker of ["allUrls(", "NAV_TREE.legacyRoutes", "NAV_TREE.aliases", "NAV_TREE.retired", "resolveLegacyPath(", "isDevModeEnabled(", "export function resolveLocation("]) {
      assert.ok(routesSource.includes(marker), `routes file missing ${marker}`);
    }
    for (const marker of ["resolveLocation(", "resolveLegacyLocation(", "window.history.replaceState", "isDevRouteAllowed(", "retiredScreenUrl(", "queueMicrotask(() => {"]) {
      assert.ok(appSource.includes(marker), `App.tsx missing ${marker}`);
    }
    assert.doesNotMatch(appSource, /navigation\/roles"/, "App.tsx must not read the persona roles of localStorage");
  });

  it("las 205 redirecciones antiguas resuelven a una URL registrada (parámetros por posición, corte antes de parámetros nuevos)", () => {
    const registered = allUrls;
    const matches = (pattern, pathname) => {
      const a = pattern.split("/");
      const b = pathname.split("/");
      return a.length === b.length && a.every((segment, index) => segment.startsWith(":") ? b[index] !== "" : segment === b[index]);
    };
    let resolved = 0;
    for (const route of tree.legacyRoutes) {
      const sample = route.from.replace(/:[A-Za-z0-9_]+/g, "abc");
      const values = (route.from.match(/:[A-Za-z0-9_]+/g) ?? []).map(() => "abc");
      let index = 0;
      const segments = route.to.split("/").map((segment) => {
        if (!segment.startsWith(":")) return segment;
        const value = values[index];
        index += 1;
        return value === undefined ? segment : value;
      });
      const cut = segments.findIndex((segment) => segment.startsWith(":"));
      const target = (cut === -1 ? segments : segments.slice(0, cut)).join("/") || "/";
      assert.ok(registered.some((url) => matches(url, target)), `${route.from} (${sample}) → ${target} is not a registered URL`);
      resolved += 1;
    }
    assert.equal(resolved, tree.legacyRoutes.length);
    assert.equal(resolved, 205);
  });
});

describe("Nav tree · freshness (only when the CSV is available locally)", () => {
  const csvPath = fileURLToPath(new URL("../../pilots/tanda5-nav-tree.csv", import.meta.url));
  const script = fileURLToPath(new URL("../scripts/build-nav-tree.mjs", import.meta.url));

  it("the committed JSON matches the CSV", { skip: !existsSync(csvPath) && "pilots/tanda5-nav-tree.csv not present (CI)" }, () => {
    const output = execFileSync(process.execPath, [script, "--check"], { encoding: "utf8" });
    assert.match(output, /up to date/);
  });
});
