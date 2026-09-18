#!/usr/bin/env node
/**
 * check-route-access.mjs — Tanda 8a · RBAC · L4 (design §5.2 «Router = menú»)
 *
 * Pre-commit guard over the COMMITTED tree
 * (apps/admin-web/src/navigation/nav-tree.generated.json; no dependency on the
 * git-ignored CSV): the same table as
 * apps/admin-web/src/routes/__tests__/route-access.test.mts, ported to plain
 * JavaScript so it runs without tsx. For every URL of the tree × every
 * authenticated token it resolves the URL the way the router does (static URL
 * before `:param`, a tab only opens when its item does, dev-only always
 * dev-locked without dev mode, public always open) and requires the
 * resolution to be «screen» exactly when the menu paints the entry
 * (`roles` contain the token and, with every module on, the module gate
 * passes). It also checks the invariants the decision relies on: every
 * live entry carries at least one token, tab roles ⊆ item roles, dev-only
 * roles = [admin], and only known tokens.
 *
 * Exit 1 with the list of discrepancies; 0 with the per-token counts.
 * Usage: node scripts/check-route-access.mjs
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const TREE_PATH = resolve(REPO_ROOT, "apps/admin-web/src/navigation/nav-tree.generated.json");
const ROLE_TOKENS_PATH = resolve(REPO_ROOT, "apps/admin-web/src/navigation/role-tokens.ts");

const tree = JSON.parse(readFileSync(TREE_PATH, "utf8"));
const roleTokensSource = readFileSync(ROLE_TOKENS_PATH, "utf8");

// Tokens from role-tokens.ts (the `ROLE_TOKENS` array), so the script and the front agree.
const tokensBlock = roleTokensSource.match(/export const ROLE_TOKENS: readonly RoleToken\[\] = \[([^\]]+)\]/);
if (!tokensBlock) {
  console.error("check-route-access: ROLE_TOKENS not found in role-tokens.ts");
  process.exit(1);
}
const ROLE_TOKENS = [...tokensBlock[1].matchAll(/"([a-z]+)"/g)].map((m) => m[1]);
const AUTHENTICATED = ROLE_TOKENS.filter((token) => token !== "publico");

// ---------------------------------------------------------------- tree helpers (ports of nav-tree.ts / role-tokens.ts / access-decision.ts)
const normalize = (pathname) => {
  const trimmed = pathname.replace(/[?#].*$/, "").replace(/\/+$/, "");
  return trimmed === "" ? "/" : trimmed;
};
function matchPath(pattern, pathname) {
  const a = normalize(pattern).split("/");
  const b = normalize(pathname).split("/");
  if (a.length !== b.length) return false;
  return a.every((segment, index) => (segment.startsWith(":") ? b[index] !== "" : segment === b[index]));
}
const paramsOf = (url) => (url.match(/:[A-Za-z0-9_]+/g) ?? []).length;

const entries = [];
for (const category of tree.categories) {
  for (const item of category.items) {
    entries.push({ kind: "item", item, entry: item, url: item.url });
    for (const tab of item.tabs) entries.push({ kind: "tab", item, entry: tab, url: tab.url });
  }
}
for (const screen of tree.devOnly) entries.push({ kind: "dev-only", entry: screen, url: screen.url });
for (const screen of tree.publicScreens) entries.push({ kind: "public", entry: screen, url: screen.url });

/** findByUrl: static URLs win over parametrised ones. */
function findByUrl(pathname) {
  const candidates = entries.filter((candidate) => matchPath(candidate.url, pathname));
  candidates.sort((a, b) => paramsOf(a.url) - paramsOf(b.url));
  return candidates[0] ?? null;
}

const allModules = [...new Set(entries.flatMap((candidate) => candidate.entry.modulesAny ?? []))];
const roleAllows = (gate, tokens) => {
  const roles = gate.roles ?? [];
  if (roles.length === 0 || roles.includes("publico")) return true;
  return tokens.some((token) => roles.includes(token));
};
const roleAllowsEveryone = (gate) => {
  const roles = gate.roles ?? [];
  if (roles.length === 0 || roles.includes("publico")) return true;
  return AUTHENTICATED.every((token) => roles.includes(token));
};
const moduleAllows = (gate, modules) => {
  const codes = gate.modulesAny ?? [];
  return codes.length === 0 || codes.some((code) => modules.includes(code));
};
const canSee = (gate, tokens, modules) => roleAllows(gate, tokens) && moduleAllows(gate, modules);

function accessDecision(entry, scope) {
  if (entry.devOnly && !(scope.devMode && scope.tokens.includes("admin"))) return "dev-locked";
  const roleOk = scope.tokens.length === 0 ? roleAllowsEveryone(entry) : roleAllows(entry, scope.tokens);
  if (!roleOk) return "hidden-role";
  if (moduleAllows(entry, scope.modules)) return "visible";
  return scope.canEnableModules ? "locked" : "hidden-module";
}
const SEVERITY = { visible: 0, locked: 1, "hidden-module": 2, "hidden-role": 3, "dev-locked": 4 };

/** resolveLocation port for tree URLs (legacy paths are the router's business, not the tree's). */
function resolve_(pathname, scope) {
  const match = findByUrl(pathname);
  if (!match) return { kind: "not-found" };
  if (match.kind === "dev-only") return scope.devMode && scope.isPlatformAdmin ? { kind: "screen" } : { kind: "dev-locked" };
  if (match.kind === "public") return { kind: "screen" };
  const forItem = accessDecision(match.item, scope);
  const decision = match.kind === "tab" ? (SEVERITY[forItem] >= SEVERITY[accessDecision(match.entry, scope)] ? forItem : accessDecision(match.entry, scope)) : forItem;
  if (decision === "hidden-role") return { kind: "forbidden", reason: "role" };
  if (decision === "hidden-module" && scope.modulesKnown) return { kind: "forbidden", reason: "module" };
  return { kind: "screen" };
}

// ---------------------------------------------------------------- invariants of the data
const problems = [];
for (const candidate of entries) {
  if (candidate.kind === "public") continue;
  const roles = candidate.entry.roles ?? [];
  if (roles.length === 0) problems.push(`${candidate.entry.screenKey}: sin tokens`);
  for (const role of roles) if (!ROLE_TOKENS.includes(role)) problems.push(`${candidate.entry.screenKey}: token desconocido ${role}`);
  if (candidate.kind === "tab") {
    for (const role of roles) if (!candidate.item.roles.includes(role)) problems.push(`${candidate.entry.screenKey}: token ${role} no está en su ítem ${candidate.item.screenKey}`);
  }
  if (candidate.kind === "dev-only" && (roles.length !== 1 || roles[0] !== "admin")) problems.push(`${candidate.entry.screenKey}: dev-only debe ser solo admin`);
}

// ---------------------------------------------------------------- the table: URL × token
const counts = {};
for (const token of AUTHENTICATED) {
  const scope = { tokens: [token], modules: allModules, modulesKnown: true, isPlatformAdmin: token === "admin", devMode: false, canEnableModules: false };
  let items = 0;
  let tabs = 0;
  for (const candidate of entries) {
    const sample = candidate.url.replace(/:[A-Za-z0-9_]+/g, "abc");
    const resolution = resolve_(sample, scope);
    let expected;
    if (candidate.kind === "dev-only") expected = "dev-locked";
    else if (candidate.kind === "public") expected = "screen";
    else {
      const visible = canSee(candidate.entry, [token], allModules) && canSee(candidate.item, [token], allModules);
      expected = visible ? "screen" : "forbidden";
      if (visible) {
        if (candidate.kind === "item") items += 1;
        else tabs += 1;
      }
    }
    if (resolution.kind !== expected) problems.push(`${token} × ${candidate.url}: router ${resolution.kind}, menú ${expected}`);
  }
  counts[token] = { items, tabs };
}

// Without token: only entries open to everyone (none since Tanda 8a) — never a crash, never a screen the menu hides.
for (const candidate of entries) {
  if (candidate.kind !== "item" && candidate.kind !== "tab") continue;
  const resolution = resolve_(candidate.url.replace(/:[A-Za-z0-9_]+/g, "abc"), { tokens: [], modules: allModules, modulesKnown: true, isPlatformAdmin: false, devMode: false, canEnableModules: false });
  const expected = roleAllowsEveryone(candidate.entry) && roleAllowsEveryone(candidate.item) ? "screen" : "forbidden";
  if (resolution.kind !== expected) problems.push(`sin token × ${candidate.url}: router ${resolution.kind}, menú ${expected}`);
}

console.log("Route access check (router = menú, árbol committed)");
console.log(`  URLs: ${entries.length}   tokens: ${AUTHENTICATED.length}   módulos gateados: ${allModules.length}`);
for (const [token, count] of Object.entries(counts)) console.log(`  ${token.padEnd(15)} ítems ${String(count.items).padStart(3)}   pestañas ${String(count.tabs).padStart(3)}`);

if (problems.length > 0) {
  console.error("");
  console.error(`check-route-access: ${problems.length} discrepancia(s):`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}
console.log("");
console.log(`OK: el router abre exactamente lo que el menú pinta para ${AUTHENTICATED.length} tokens × ${entries.length} URLs.`);
process.exit(0);
