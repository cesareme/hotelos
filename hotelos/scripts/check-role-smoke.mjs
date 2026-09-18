#!/usr/bin/env node
/**
 * check-role-smoke.mjs — Tanda 8a · RBAC por departamento · L5
 * (docs/design/RBAC-DEPARTAMENTOS.md §7 L5, §8.1, §9 «smoke por plantilla»).
 *
 * Smoke por plantilla sobre la BD sembrada por
 * packages/database/prisma/seed-rbac-demo.ts: arranca el API EN PROCESO
 * (buildApiServer + app.inject, como tests/integration/rbac-scope.test.mts, sin
 * puerto) con RBAC_STRICT=true y la unión demo apagada, y con CADA usuario de
 * demo (las cuentas de emergencia no se prueban por login, §4.8):
 *
 *   1. inicia sesión con la contraseña del seed y hace la rotación obligatoria
 *      (POST /auth/change-password) a una segunda contraseña temporal derivada
 *      de la del seed; vuelve a iniciar sesión (el cambio revoca las sesiones);
 *   2. GET /users/me → plantillas (templateKeys), propiedades y propiedad
 *      activa; los tokens de menú salen de ROLE_TEMPLATE_NAV_TOKEN;
 *   3. cruza nav-tree.generated.json × ../pilots/screens-inventory.csv con la
 *      MISMA regla readRoutesFor de tests/rbac-nav-contract.test.mjs (todas las
 *      GET mapeadas de cada pantalla que su token ve; si ninguna es GET, la
 *      primera mutación) y lanza cada GET con la cabecera x-property-id de su
 *      propiedad activa (`:propertyId` → propiedad activa; otros parámetros →
 *      un id inexistente, que responde 404 tras pasar la puerta de permisos);
 *      exige 0 × 403 salvo los «previstos»: la plantilla no tiene alguna clave
 *      exigida por la ruta según ROLE_PERMISSION_MAP (huecos `sister`/`write`
 *      del contrato) o el módulo no está activado en la propiedad;
 *   4. exige 403 en 3 rutas de escritura ajenas a su plantilla, elegidas con
 *      SOD_STATIC_PAIRS (la clave contraria a una que la plantilla sí tiene) y,
 *      si no llegan a 3, con cualquier mutación cuya clave no tenga;
 *   5. exige 404 opaco en una propiedad fuera de su ámbito
 *      (GET /properties/:id/reservations);
 *   6. restaura la contraseña del seed (salvo --keep-rotated); el API deja
 *      mustChangePassword=false: volver a sembrar lo repone.
 *
 * Informe: matriz usuario × ruta (200/403/404…) legible o --json. Salida 1 si
 * algún 403 no previsto en el menú, un 5xx, un fallo de sesión, un 404 opaco en
 * la propiedad activa, una escritura ajena que no devuelve 403 o una propiedad
 * ajena que no devuelve 404.
 *
 * Uso (desde la raíz del repo; tsx se carga por API desde apps/api, así que no
 * hace falta --import tsx; también vale `cd apps/api && node --import tsx
 * ../../scripts/check-role-smoke.mjs`):
 *   node scripts/check-role-smoke.mjs --dry-run            # lista usuarios y rutas, sin BD ni API
 *   node scripts/check-role-smoke.mjs                      # requiere BD sembrada (.env de la raíz)
 *   node scripts/check-role-smoke.mjs --users recepcion.rias,contabilidad --json
 *   node scripts/check-role-smoke.mjs --keep-rotated       # no restaura la contraseña del seed
 *
 * Duración: el limitador de /auth/login (10 por minuto y por IP, server.ts) obliga
 * a esperar la ventana cada 10 inicios de sesión (withRateLimitRetry): los 30
 * usuarios (2 inicios cada uno) tardan unos 6 minutos; un 429 nunca cuenta como
 * fallo de sesión (integrador 8a).
 *
 * Nunca imprime contraseñas: la del seed la conoce el seed
 * (resolveDemoPassword / RBAC_DEMO_PASSWORD) y la temporal se deriva de ella.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PATHS = {
  tree: resolve(REPO_ROOT, "apps/admin-web/src/navigation/nav-tree.generated.json"),
  inventory: resolve(REPO_ROOT, "../pilots/screens-inventory.csv"),
  permissions: resolve(REPO_ROOT, "packages/shared/src/permissions.ts"),
  rbacTypes: resolve(REPO_ROOT, "packages/shared/src/rbac-types.ts"),
  apiSrc: resolve(REPO_ROOT, "apps/api/src"),
  apiTsconfig: resolve(REPO_ROOT, "apps/api/tsconfig.json"),
  tsxApi: resolve(REPO_ROOT, "apps/api/node_modules/tsx/dist/esm/api/index.mjs"),
  seed: resolve(REPO_ROOT, "packages/database/prisma/seed-rbac-demo.ts"),
  server: resolve(REPO_ROOT, "apps/api/src/server.ts"),
  env: resolve(REPO_ROOT, ".env")
};

/** Id that no entity carries: by-id routes answer 404 AFTER the permission gate (403 wins when the key is missing). */
const MISSING_ID = "smoke-no-existe";
/** Second, temporary password of the mandatory rotation: derived from the seed password (same policy: keeps its upper case, digit and special character). */
const ROTATION_SUFFIX = "-rotada-1";
/** Opaque message the tenancy guard answers for a property outside the scope (lib/tenancy.ts). */
const OPAQUE_PROPERTY_404 = "Propiedad no encontrada.";
/** Property of another organisation (org_123): outside every Faranda scope. */
const FOREIGN_ORG_PROPERTY = "prop_123";
/** Pantallas nacidas después del inventario (misma tabla que tests/rbac-nav-contract.test.mjs). */
const TREE_ROUTES_FALLBACK = { ApprovalsInbox: "/approvals /approvals/:id/approve /approvals/:id/reject" };
/** Mutations never probed as «escritura ajena» (session plumbing / emergency entrance). */
const SOD_PROBE_EXCLUDED_PREFIXES = ["/auth/", "/rbac/break-glass", "/users/me"];
const SOD_PROBES = 3;

const USAGE = [
  "Uso: node scripts/check-role-smoke.mjs [--dry-run] [--users a,b] [--json] [--keep-rotated] [--help]",
  "",
  "  --dry-run        lista, por usuario de demo, las rutas GET de su menú, las 3 escrituras ajenas y la propiedad ajena; sin BD ni API",
  "  --users a,b      solo esos usuarios (parte local o correo completo)",
  "  --json           informe máquina (matriz usuario × ruta)",
  "  --keep-rotated   no restaura la contraseña del seed tras la rotación",
  "  --help, -h       esta ayuda",
  "",
  "Códigos de salida: 0 todo verde · 1 algún fallo (403 no previsto, 5xx, sesión, ámbito, escritura ajena sin 403) · 2 uso / fuentes ausentes"
].join("\n");

// ---------------------------------------------------------------------------
// Flags
// ---------------------------------------------------------------------------

export function parseFlags(argv) {
  const flags = { dryRun: false, json: false, keepRotated: false, help: false, users: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--") continue;
    if (arg === "--dry-run") flags.dryRun = true;
    else if (arg === "--json") flags.json = true;
    else if (arg === "--keep-rotated") flags.keepRotated = true;
    else if (arg === "--help" || arg === "-h") flags.help = true;
    else if (arg === "--users" || arg.startsWith("--users=")) {
      let value = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : argv[i + 1];
      if (!arg.includes("=")) i += 1;
      if (!value || value.startsWith("--")) throw new Error("--users exige una lista separada por comas.");
      flags.users = value.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
    } else throw new Error(`Flag desconocida "${arg}".`);
  }
  return flags;
}

// ---------------------------------------------------------------------------
// Parsers (sin TS ni BD): los mismos que tests/rbac-nav-contract.test.mjs
// ---------------------------------------------------------------------------

function stripLineComments(source) {
  return source
    .split("\n")
    .map((line) => line.replace(/\s*\/\/.*$/, ""))
    .join("\n");
}

function parsePermissionCatalog(source) {
  const block = source.match(/export const PERMISSIONS[^{]*\{(.*?)\n\};/s);
  if (!block) throw new Error("PERMISSIONS no encontrado en permissions.ts");
  return [...block[1].matchAll(/^\s*"([a-z_]+(?:\.[a-z_]+)+)":\s*"/gm)].map((m) => m[1]);
}

/** ROLE_PERMISSION_MAP → { template: Set<key> } (break_glass = todas las claves de organización). */
export function parseTemplates(source) {
  const catalog = parsePermissionCatalog(source);
  const orgKeys = catalog.filter((key) => !key.startsWith("admin.") && !key.startsWith("platform."));
  const block = source.match(/export const ROLE_PERMISSION_MAP[^{]*\{(.*?)\n\};/s);
  if (!block) throw new Error("ROLE_PERMISSION_MAP no encontrado en permissions.ts");
  const body = stripLineComments(block[1]);
  const templates = {};
  for (const m of body.matchAll(/^\s*(\w+):\s*\[(.*?)\]/gms)) {
    templates[m[1]] = m[2].includes("ORG_PERMISSION_KEYS") ? new Set(orgKeys) : new Set([...m[2].matchAll(/"([^"]+)"/g)].map((k) => k[1]));
  }
  return { catalog: new Set(catalog), templates };
}

/** `export const NAME: Record<A, string> = { key: "value", … };` → { key: value } */
export function parseStringRecord(source, name) {
  const block = source.match(new RegExp(`export const ${name}[^{]*\\{(.*?)\\n\\};`, "s"));
  if (!block) throw new Error(`${name} no encontrado en rbac-types.ts`);
  return Object.fromEntries([...stripLineComments(block[1]).matchAll(/^\s*([a-z_]+):\s*"([^"]+)"/gm)].map((m) => [m[1], m[2]]));
}

/** SOD_STATIC_PAIRS → [{ a, b, except: [] }] */
export function parseSodPairs(source) {
  const block = source.match(/export const SOD_STATIC_PAIRS[^\[]*\[(.*?)\n\];/s);
  if (!block) throw new Error("SOD_STATIC_PAIRS no encontrado en rbac-types.ts");
  return [...stripLineComments(block[1]).matchAll(/\{\s*a:\s*"([^"]+)",\s*b:\s*"([^"]+)"(?:,\s*except:\s*\[([^\]]*)\])?\s*\}/g)].map((m) => ({
    a: m[1],
    b: m[2],
    except: m[3] ? [...m[3].matchAll(/"([^"]+)"/g)].map((k) => k[1]) : []
  }));
}

function parseManifestEntries(source) {
  return [...source.matchAll(/method:\s*"(GET|POST|PATCH|PUT|DELETE)",\s*path:\s*"([^"]+)",\s*permissions:\s*\[([^\]]*)\](?:,\s*riskLevel:\s*"([a-z]+)")?/g)].map((m) => ({
    method: m[1],
    path: m[2],
    permissions: [...m[3].matchAll(/"([^"]+)"/g)].map((k) => k[1]),
    riskLevel: m[4] ?? null,
    re: new RegExp(`^${m[2].replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/:[A-Za-z_]+/g, "[^/]+")}$`)
  }));
}

/** Manifiesto en orden real: los partials van en spread al principio de routePermissionManifest. */
export function loadManifest(apiSrc = PATHS.apiSrc) {
  const main = readFileSync(resolve(apiSrc, "security/route-permissions.ts"), "utf8");
  const modulesDir = resolve(apiSrc, "modules");
  const partials = readdirSync(modulesDir)
    .map((mod) => resolve(modulesDir, mod, "route-permissions.partial.ts"))
    .filter((file) => existsSync(file))
    .map((file) => ({ file, source: readFileSync(file, "utf8") }));
  const spreadOrder = [...main.matchAll(/^\s*\.\.\.(\w+),/gm)].map((m) => m[1]);
  const ordered = spreadOrder.map((name) => partials.find((partial) => partial.source.includes(`export const ${name}`))).filter(Boolean);
  return [...ordered.flatMap((partial) => parseManifestEntries(partial.source)), ...parseManifestEntries(main)];
}

/** Parser CSV RFC 4180 mínimo (comillas dobles, saltos de línea dentro de comillas). */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else quoted = false;
      } else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += ch;
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  const [header, ...body] = rows.filter((r) => r.length > 1 || (r.length === 1 && r[0] !== ""));
  return body.map((values) => Object.fromEntries(header.map((key, index) => [key, values[index] ?? ""])));
}

// ---------------------------------------------------------------------------
// Static model: tree × inventory × manifest × templates
// ---------------------------------------------------------------------------

export function loadStaticModel() {
  for (const [label, file] of [["árbol de navegación", PATHS.tree], ["inventario de pantallas", PATHS.inventory], ["permissions.ts", PATHS.permissions], ["rbac-types.ts", PATHS.rbacTypes], ["seed-rbac-demo.ts", PATHS.seed]]) {
    if (!existsSync(file)) throw new Error(`Falta ${label}: ${file}`);
  }
  const tree = JSON.parse(readFileSync(PATHS.tree, "utf8"));
  const entries = tree.categories.flatMap((category) => category.items.flatMap((item) => [item, ...(item.tabs ?? [])]));
  const inventory = parseCsv(readFileSync(PATHS.inventory, "utf8"));
  const byKey = new Map(inventory.map((row) => [row.clave, row]));
  const manifest = loadManifest();
  const { templates } = parseTemplates(readFileSync(PATHS.permissions, "utf8"));
  const rbacTypesSource = readFileSync(PATHS.rbacTypes, "utf8");
  const navToken = parseStringRecord(rbacTypesSource, "ROLE_TEMPLATE_NAV_TOKEN");
  const sodPairs = parseSodPairs(rbacTypesSource);

  function requiredPermissionsFor(inventoryPath) {
    const probe = inventoryPath.replace(/:p\b/g, "X");
    const get = manifest.find((entry) => entry.method === "GET" && entry.re.test(probe));
    if (get) return get;
    return manifest.find((entry) => entry.re.test(probe)) ?? null;
  }

  /** Rutas de lectura de una pantalla: misma regla que readRoutesFor del contrato (todas las GET; si ninguna, la primera mutación). */
  function readRoutesFor(screenKey) {
    const row = byKey.get(screenKey);
    const raw = row ? row.api_paths_principales : (TREE_ROUTES_FALLBACK[screenKey] ?? "");
    const paths = raw.split(/\s+/).filter((p) => p.startsWith("/"));
    const gets = new Map();
    for (const path of paths) {
      const entry = requiredPermissionsFor(path);
      if (entry && entry.method === "GET" && !gets.has(entry.path)) gets.set(entry.path, { inventoryPath: path, manifestPath: entry.path, method: entry.method, permissions: entry.permissions });
    }
    if (gets.size > 0) return [...gets.values()];
    for (const path of paths) {
      const entry = requiredPermissionsFor(path);
      if (entry) return [{ inventoryPath: path, manifestPath: entry.path, method: entry.method, permissions: entry.permissions }];
    }
    return [];
  }

  return { entries, byKey, manifest, templates, navToken, sodPairs, readRoutesFor };
}

/** Entradas del árbol que ve un conjunto de tokens (`admin` = plataforma: solo con isPlatformAdmin). */
export function menuFor(entries, tokens) {
  const held = new Set(tokens);
  return entries.filter((entry) => (entry.roles ?? []).some((token) => held.has(token)));
}

/** GET (o primera mutación) de cada pantalla del menú, deduplicadas por (inventario, manifiesto). */
export function routesForMenu(model, menu) {
  const seen = new Map();
  for (const entry of menu) {
    for (const route of model.readRoutesFor(entry.screenKey)) {
      const key = `${route.method} ${route.inventoryPath} → ${route.manifestPath}`;
      if (!seen.has(key)) seen.set(key, { screenKey: entry.screenKey, label: entry.label, url: entry.url, ...route });
    }
  }
  return [...seen.values()];
}

/** Claves exigidas por la ruta que la plantilla no tiene (según ROLE_PERMISSION_MAP): un 403 ahí es «previsto» (hueco sister/write del contrato). */
export function missingKeysFor(model, templateKeys, permissions) {
  const held = new Set();
  for (const template of templateKeys) for (const key of model.templates[template] ?? []) held.add(key);
  return permissions.filter((key) => !held.has(key));
}

/** URL real: `:propertyId` → propiedad activa; cualquier otro parámetro → id inexistente. */
export function buildUrl(inventoryPath, manifestPath, propertyId) {
  const inv = inventoryPath.split("/");
  const man = manifestPath.split("/");
  return inv
    .map((segment, index) => {
      if (!segment.startsWith(":")) return segment;
      return man[index] === ":propertyId" ? propertyId : MISSING_ID;
    })
    .join("/");
}

/**
 * Tres escrituras ajenas a la plantilla: mutaciones del manifiesto cuya clave
 * es la contraria (SOD_STATIC_PAIRS) de una que la plantilla SÍ tiene; si no
 * llegan a tres, mutaciones que exigen cualquier clave que no tiene.
 */
export function sodProbesFor(model, templateKeys) {
  const held = new Set();
  for (const template of templateKeys) for (const key of model.templates[template] ?? []) held.add(key);
  const forbidden = new Set();
  for (const pair of model.sodPairs) {
    if (templateKeys.some((template) => pair.except.includes(template))) continue;
    if (held.has(pair.a) && !held.has(pair.b)) forbidden.add(pair.b);
    if (held.has(pair.b) && !held.has(pair.a)) forbidden.add(pair.a);
  }
  const mutations = model.manifest
    .filter((entry) => entry.method !== "GET" && entry.permissions.length > 0)
    .filter((entry) => !SOD_PROBE_EXCLUDED_PREFIXES.some((prefix) => entry.path.startsWith(prefix)))
    .sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
  const picked = [];
  const usedKeys = new Set();
  const pick = (entry, key, why) => {
    if (picked.length >= SOD_PROBES || usedKeys.has(key) || picked.some((p) => p.path === entry.path && p.method === entry.method)) return;
    usedKeys.add(key);
    picked.push({ method: entry.method, path: entry.path, key, why, permissions: entry.permissions });
  };
  for (const entry of mutations) {
    const key = entry.permissions.find((candidate) => forbidden.has(candidate));
    if (key) pick(entry, key, "separación de funciones");
  }
  if (picked.length < SOD_PROBES) {
    for (const entry of mutations) {
      const key = entry.permissions.find((candidate) => !held.has(candidate));
      if (key) pick(entry, key, "clave ajena a la plantilla");
    }
  }
  return picked;
}

/** Propiedad fuera del ámbito del usuario: un centro de Faranda que no ve o, si los ve todos, una propiedad de otra organización. */
export function foreignPropertyFor(candidates, ownedPropertyIds) {
  const owned = new Set(ownedPropertyIds);
  return [...candidates, FOREIGN_ORG_PROPERTY].find((id) => !owned.has(id)) ?? FOREIGN_ORG_PROPERTY;
}

// ---------------------------------------------------------------------------
// Demo users (single source: the seed module, loaded through tsx)
// ---------------------------------------------------------------------------

async function tsImporter() {
  if (!existsSync(PATHS.tsxApi)) throw new Error(`tsx no encontrado en ${PATHS.tsxApi} (instala las dependencias de apps/api).`);
  const { tsImport } = await import(pathToFileURL(PATHS.tsxApi).href);
  return (file) => tsImport(file, { parentURL: import.meta.url, tsconfig: PATHS.apiTsconfig });
}

function selectUsers(seed, filter) {
  const all = seed.RBAC_DEMO_USERS.map((user) => ({ ...user, email: seed.emailOf(user), emergency: seed.isEmergencyAccount(user) }));
  if (!filter) return all;
  const wanted = new Set(filter);
  const selected = all.filter((user) => wanted.has(user.local.toLowerCase()) || wanted.has(user.email.toLowerCase()));
  const unknown = filter.filter((name) => !all.some((user) => user.local.toLowerCase() === name || user.email.toLowerCase() === name));
  if (unknown.length > 0) throw new Error(`Usuarios desconocidos en --users: ${unknown.join(", ")}`);
  return selected;
}

function expectedActiveProperty(seed, user) {
  const scope = user.scope;
  if (!scope) return null;
  if (scope.scopeType === "property") return { code: scope.property, id: seed.FARANDA_PROPERTIES[scope.property], note: null };
  if (scope.scopeType === "property_group") {
    const group = seed.PROPERTY_GROUPS.find((g) => g.code === scope.groupCode);
    return { code: null, id: null, note: `grupo ${scope.groupCode} (${(group?.members ?? []).join(" + ")}): la primera del grupo al iniciar sesión` };
  }
  return { code: null, id: null, note: `${scope.scopeType === "legal_entity" ? "sociedad" : "organización"}: la primera de su ámbito al iniciar sesión` };
}

// ---------------------------------------------------------------------------
// Dry-run
// ---------------------------------------------------------------------------

function dryRunUser(model, seed, user) {
  if (user.emergency) return { email: user.email, emergency: true, note: "cuenta de emergencia: no se prueba por login (§4.8)" };
  const token = model.navToken[user.templateKey];
  const menu = menuFor(model.entries, [token]);
  const routes = routesForMenu(model, menu).map((route) => ({ ...route, missing: missingKeysFor(model, [user.templateKey], route.permissions) }));
  const active = expectedActiveProperty(seed, user);
  return {
    email: user.email,
    emergency: false,
    templateKey: user.templateKey,
    token,
    scope: user.scope,
    activeProperty: active,
    menuEntries: menu.length,
    routes,
    sodProbes: sodProbesFor(model, [user.templateKey]),
    foreignProperty: foreignPropertyFor(Object.values(seed.FARANDA_PROPERTIES), expectedOwnedProperties(seed, user))
  };
}

/** Properties the seed scope expands to (static view of what /users/me will list; sociedad / organisation = every centre). */
function expectedOwnedProperties(seed, user) {
  const scope = user.scope;
  if (!scope) return [];
  if (scope.scopeType === "property") return [seed.FARANDA_PROPERTIES[scope.property]];
  if (scope.scopeType === "property_group") {
    const group = seed.PROPERTY_GROUPS.find((g) => g.code === scope.groupCode);
    return (group?.members ?? []).map((code) => seed.FARANDA_PROPERTIES[code]);
  }
  return Object.values(seed.FARANDA_PROPERTIES);
}

function formatDryRun(report) {
  const lines = [];
  lines.push(`[check-role-smoke] dry-run · ${report.users.length} usuario(s) · árbol ${report.treeEntries} entradas · manifiesto ${report.manifestEntries} rutas`);
  for (const user of report.users) {
    lines.push("");
    if (user.emergency) {
      lines.push(`— ${user.email}: ${user.note}`);
      continue;
    }
    const scope = user.scope.scopeType === "property" ? `property ${user.scope.property}` : user.scope.scopeType === "property_group" ? `property_group ${user.scope.groupCode}` : user.scope.scopeType;
    lines.push(`— ${user.email} · ${user.templateKey} · token ${user.token} · ámbito ${scope} · propiedad activa: ${user.activeProperty?.id ? `${user.activeProperty.code} ${user.activeProperty.id}` : user.activeProperty?.note}`);
    lines.push(`  menú: ${user.menuEntries} entradas → ${user.routes.length} GET (${user.routes.filter((r) => r.missing.length > 0).length} con 403 previsto por plantilla)`);
    for (const route of user.routes) {
      lines.push(`    ${route.method.padEnd(5)} ${route.inventoryPath}  [${route.screenKey}]${route.missing.length > 0 ? `  → 403 previsto (falta ${route.missing.join(", ")})` : ""}`);
    }
    lines.push(`  escrituras ajenas (esperado 403):`);
    for (const probe of user.sodProbes) lines.push(`    ${probe.method.padEnd(5)} ${probe.path}  → ${probe.key} (${probe.why})`);
    lines.push(`  propiedad ajena (esperado 404): GET /properties/${user.foreignProperty}/reservations`);
  }
  lines.push("");
  lines.push("Sin BD ni API: nada ejecutado. Quita --dry-run con la BD sembrada (db:seed:rbac-demo) para lanzar la matriz real.");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Real run (in-process API)
// ---------------------------------------------------------------------------

function applyEnv(entries) {
  for (const [key, value] of Object.entries(entries)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function parseBody(res) {
  try {
    return JSON.parse(res.body);
  } catch {
    return null;
  }
}

/** Ventana del limitador de /auth/login y /auth/change-password (server.ts: `rateLimit: { max: 10, timeWindow: "1 minute" }`, por IP). */
export const RATE_LIMIT_WINDOW_MS = 61_000;
export const RATE_LIMIT_MAX_RETRIES = 6;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Integrador 8a: el limitador anti-fuerza-bruta de /auth/login (10 por minuto
 * y por IP, no configurable) corta el smoke a partir del 5.º usuario (2 inicios
 * de sesión por usuario). Ante un 429 se espera la ventana entera y se
 * reintenta (hasta RATE_LIMIT_MAX_RETRIES veces); el resto de códigos se
 * devuelve tal cual. 30 usuarios × 2 inicios ≈ 6 ventanas ≈ 6 minutos.
 */
async function withRateLimitRetry(request, label) {
  let last = null;
  for (let attempt = 0; attempt <= RATE_LIMIT_MAX_RETRIES; attempt += 1) {
    last = await request();
    if (last.status !== 429) return last;
    if (attempt < RATE_LIMIT_MAX_RETRIES) {
      process.stderr.write(`[check-role-smoke] 429 en ${label}: espero ${Math.round(RATE_LIMIT_WINDOW_MS / 1000)} s la ventana del limitador (intento ${attempt + 1}/${RATE_LIMIT_MAX_RETRIES})\n`);
      await sleep(RATE_LIMIT_WINDOW_MS);
    }
  }
  return last;
}

async function login(app, email, password, deviceId) {
  return withRateLimitRetry(async () => {
    const res = await app.inject({ method: "POST", url: "/auth/login", payload: { email, password, deviceId } });
    const body = parseBody(res);
    return { status: res.statusCode, token: body?.token ?? null, message: body?.message ?? null };
  }, `POST /auth/login (${email})`);
}

async function getJson(app, url, headers) {
  const res = await app.inject({ method: "GET", url, headers });
  return { status: res.statusCode, body: parseBody(res) };
}

async function changePassword(app, token, currentPassword, newPassword) {
  return withRateLimitRetry(async () => {
    const res = await app.inject({ method: "POST", url: "/auth/change-password", headers: { authorization: `Bearer ${token}` }, payload: { currentPassword, newPassword } });
    return { status: res.statusCode, message: parseBody(res)?.message ?? null };
  }, "POST /auth/change-password");
}

/** Verdict of one menu GET (see the header): ok · previsto · modulo · sin-entidad · parametros · fallo · error. */
function classify(status, body, route, missing, url, activePropertyId) {
  if (status >= 200 && status < 300) return { verdict: "ok" };
  if (status === 403) {
    const code = body?.details?.code ?? null;
    const message = body?.message ?? "";
    if (code === "PASSWORD_CHANGE_REQUIRED") return { verdict: "fallo", reason: "rotación de contraseña no aplicada" };
    if (/no está activad/i.test(message)) return { verdict: "modulo", reason: message };
    if (missing.length > 0) return { verdict: "previsto", reason: `la plantilla no tiene ${missing.join(", ")}` };
    return { verdict: "fallo", reason: `403 con todas las claves de la plantilla (${route.permissions.join(", ") || "sin clave"}): ${message}` };
  }
  if (status === 401) return { verdict: "fallo", reason: "401 con sesión válida" };
  if (status === 404) {
    if (body?.message === OPAQUE_PROPERTY_404 && url.includes(activePropertyId)) return { verdict: "fallo", reason: "404 opaco en la propiedad ACTIVA: el ámbito no la cubre" };
    return { verdict: "sin-entidad", reason: body?.message ?? "404" };
  }
  if (status >= 500) return { verdict: "error", reason: body?.message ?? `HTTP ${status}` };
  return { verdict: "parametros", reason: body?.message ?? `HTTP ${status}` };
}

async function runUser(app, model, seed, user, demoPassword, flags) {
  const result = { email: user.email, templateKey: user.templateKey, emergency: false, login: null, rotation: null, profile: null, routes: [], sod: [], scopeProbe: null, restore: null, failures: [], counts: {} };
  const deviceId = `smoke-${user.local}`;
  const tempPassword = `${demoPassword}${ROTATION_SUFFIX}`;

  // 1. Login + mandatory rotation (the change revokes every session: log in again).
  let session = await login(app, user.email, demoPassword, deviceId);
  let password = demoPassword;
  if (session.status === 200) {
    const me = await getJson(app, "/users/me", { authorization: `Bearer ${session.token}` });
    if (me.body?.mustChangePassword === true) {
      const changed = await changePassword(app, session.token, demoPassword, tempPassword);
      result.rotation = changed.status === 200 ? "rotada" : `fallo (${changed.status}: ${changed.message})`;
      if (changed.status !== 200) result.failures.push(`rotación obligatoria: HTTP ${changed.status} ${changed.message ?? ""}`);
      session = await login(app, user.email, tempPassword, deviceId);
      password = tempPassword;
    } else {
      result.rotation = "no exigida (mustChangePassword=false: ya rotada; vuelve a sembrar para reponerla)";
    }
  } else {
    // A previous run without --keep-rotated restore may have left the temporary password.
    const retry = await login(app, user.email, tempPassword, deviceId);
    if (retry.status === 200) {
      session = retry;
      password = tempPassword;
      result.rotation = "ya rotada por una ejecución anterior sin restaurar";
    }
  }
  result.login = session.status === 200 ? "ok" : `fallo (${session.status}: ${session.message})`;
  if (session.status !== 200) {
    result.failures.push(`inicio de sesión: HTTP ${session.status} ${session.message ?? ""}`);
    return finish(result);
  }
  const headers = { authorization: `Bearer ${session.token}` };

  // 2. Profile → tokens, properties, active property.
  const me = await getJson(app, "/users/me", headers);
  if (me.status !== 200 || !me.body) {
    result.failures.push(`GET /users/me: HTTP ${me.status}`);
    return finish(result);
  }
  const profile = me.body;
  const templateKeys = Array.isArray(profile.templateKeys) ? profile.templateKeys : [];
  const tokens = [...new Set(templateKeys.map((key) => model.navToken[key]).filter(Boolean))];
  if (profile.isPlatformAdmin) tokens.push("admin");
  const ownedIds = (profile.properties ?? []).map((property) => property.id);
  const activePropertyId = profile.activePropertyId;
  result.profile = { templateKeys, tokens, activePropertyId, properties: ownedIds, scopes: profile.scopes ?? [], orgScope: profile.orgScope === true, mustChangePassword: profile.mustChangePassword === true };
  if (templateKeys.length === 0) result.failures.push("/users/me sin templateKeys en la propiedad activa: la sesión no tiene rol");
  if (!ownedIds.includes(activePropertyId)) result.failures.push(`la propiedad activa ${activePropertyId} no está entre las del ámbito (${ownedIds.join(", ") || "ninguna"})`);
  if (!templateKeys.includes(user.templateKey)) result.failures.push(`la plantilla sembrada ${user.templateKey} no aparece en templateKeys (${templateKeys.join(", ") || "ninguna"})`);

  // 3. Menu GETs.
  const menu = menuFor(model.entries, tokens);
  const routes = routesForMenu(model, menu);
  const propertyHeaders = { ...headers, "x-property-id": activePropertyId };
  for (const route of routes) {
    const url = buildUrl(route.inventoryPath, route.manifestPath, activePropertyId);
    const missing = missingKeysFor(model, templateKeys, route.permissions);
    const res = await app.inject({ method: route.method, url, headers: propertyHeaders, ...(route.method === "GET" ? {} : { payload: {} }) });
    const body = parseBody(res);
    const { verdict, reason } = classify(res.statusCode, body, route, missing, url, activePropertyId);
    result.routes.push({ screenKey: route.screenKey, method: route.method, path: route.inventoryPath, manifestPath: route.manifestPath, url, permissions: route.permissions, missing, status: res.statusCode, verdict, ...(reason ? { reason } : {}) });
    if (verdict === "fallo" || verdict === "error") result.failures.push(`${route.method} ${url} [${route.screenKey}] → ${res.statusCode}: ${reason}`);
  }

  // 4. Three foreign writes → 403.
  for (const probe of sodProbesFor(model, templateKeys)) {
    const url = buildUrl(probe.path, probe.path, activePropertyId);
    const res = await app.inject({ method: probe.method, url, headers: propertyHeaders, payload: {} });
    const ok = res.statusCode === 403;
    result.sod.push({ method: probe.method, path: probe.path, url, key: probe.key, why: probe.why, status: res.statusCode, verdict: ok ? "ok" : "fallo" });
    if (!ok) result.failures.push(`escritura ajena ${probe.method} ${url} (${probe.key}) → ${res.statusCode}, esperado 403`);
  }

  // 5. Property outside the scope → opaque 404.
  const foreign = foreignPropertyFor(Object.values(seed.FARANDA_PROPERTIES), ownedIds);
  const foreignRes = await getJson(app, `/properties/${foreign}/reservations`, headers);
  const foreignOk = foreignRes.status === 404;
  result.scopeProbe = { propertyId: foreign, url: `/properties/${foreign}/reservations`, status: foreignRes.status, verdict: foreignOk ? "ok" : "fallo", message: foreignRes.body?.message ?? null };
  if (!foreignOk) result.failures.push(`propiedad ajena ${foreign} → ${foreignRes.status}, esperado 404`);

  // 6. Restore the seed password (mustChangePassword stays false: re-seed to restore it).
  if (!flags.keepRotated && password !== demoPassword) {
    const restored = await changePassword(app, session.token, password, demoPassword);
    result.restore = restored.status === 200 ? "contraseña del seed restaurada (mustChangePassword queda en false)" : `fallo al restaurar (${restored.status}: ${restored.message})`;
    if (restored.status !== 200) result.failures.push(`restaurar contraseña: HTTP ${restored.status} ${restored.message ?? ""}`);
  } else if (flags.keepRotated) {
    result.restore = "no restaurada (--keep-rotated): la contraseña temporal sigue activa";
  }
  return finish(result);
}

function finish(result) {
  const counts = { ok: 0, previsto: 0, modulo: 0, "sin-entidad": 0, parametros: 0, fallo: 0, error: 0 };
  for (const route of result.routes) counts[route.verdict] = (counts[route.verdict] ?? 0) + 1;
  result.counts = counts;
  result.sodOk = result.sod.filter((probe) => probe.verdict === "ok").length;
  result.ok = result.failures.length === 0;
  return result;
}

function formatRun(report) {
  const lines = [];
  lines.push(`[check-role-smoke] ${report.users.length} usuario(s) · RBAC_STRICT=true · unión demo apagada · ${report.ok ? "TODO VERDE" : `${report.failing} usuario(s) con fallos`}`);
  lines.push("");
  lines.push(`${"Usuario".padEnd(42)} ${"Plantilla".padEnd(22)} ${"Prop. activa".padEnd(26)} ${"GET".padStart(4)} ${"200".padStart(4)} ${"403prev".padStart(7)} ${"mód".padStart(4)} ${"404".padStart(4)} ${"4xx".padStart(4)} ${"403!".padStart(5)} ${"5xx".padStart(4)}  SoD  Ajena  Estado`);
  for (const user of report.users) {
    if (user.emergency) {
      lines.push(`${user.email.padEnd(42)} ${"(emergencia)".padEnd(22)} no se prueba por login (§4.8)`);
      continue;
    }
    const c = user.counts;
    const active = user.profile?.activePropertyId ?? "—";
    lines.push(
      `${user.email.padEnd(42)} ${(user.templateKey ?? "").padEnd(22)} ${active.padEnd(26)} ${String(user.routes.length).padStart(4)} ${String(c.ok ?? 0).padStart(4)} ${String(c.previsto ?? 0).padStart(7)} ${String(c.modulo ?? 0).padStart(4)} ${String(c["sin-entidad"] ?? 0).padStart(4)} ${String(c.parametros ?? 0).padStart(4)} ${String(c.fallo ?? 0).padStart(5)} ${String(c.error ?? 0).padStart(4)}  ${user.sodOk}/${user.sod.length}  ${user.scopeProbe ? `${user.scopeProbe.status}${user.scopeProbe.verdict === "ok" ? "" : "!"}` : "—"}    ${user.ok ? "ok" : "FALLO"}`
    );
  }
  for (const user of report.users) {
    if (user.emergency || user.failures.length === 0) continue;
    lines.push("");
    lines.push(`✗ ${user.email} (${user.templateKey}) · sesión ${user.login} · rotación ${user.rotation ?? "—"}`);
    for (const failure of user.failures) lines.push(`    - ${failure}`);
  }
  const previstos = report.users.flatMap((user) => (user.routes ?? []).filter((route) => route.verdict === "previsto").map((route) => `${user.templateKey} · ${route.method} ${route.path} [${route.screenKey}] → falta ${route.missing.join(", ")}`));
  if (previstos.length > 0) {
    lines.push("");
    lines.push(`403 previstos por plantilla (${previstos.length}; huecos sister/write del contrato rbac-nav, no fallos):`);
    for (const line of previstos) lines.push(`    · ${line}`);
  }
  lines.push("");
  lines.push("Columnas: GET rutas probadas · 200 abiertas · 403prev previstos por plantilla · mód módulo no activado · 404 sin entidad (id inexistente) · 4xx parámetros · 403! NO previstos · 5xx errores · SoD escrituras ajenas con 403 · Ajena estado de la propiedad fuera de ámbito (esperado 404).");
  lines.push(report.ok ? "Resultado: 0 × 403 no previstos en los menús; escrituras ajenas y propiedad ajena correctas." : "Resultado: hay fallos (salida 1).");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  let flags;
  try {
    flags = parseFlags(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(USAGE);
    return 2;
  }
  if (flags.help) {
    console.log(USAGE);
    return 0;
  }
  let model;
  let seed;
  try {
    model = loadStaticModel();
    const importTs = await tsImporter();
    seed = await importTs(PATHS.seed);
  } catch (error) {
    console.error(`[check-role-smoke] ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
  let users;
  try {
    users = selectUsers(seed, flags.users);
  } catch (error) {
    console.error(`[check-role-smoke] ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }

  if (flags.dryRun) {
    const report = { mode: "dry-run", generatedAt: new Date().toISOString(), treeEntries: model.entries.length, manifestEntries: model.manifest.length, users: users.map((user) => dryRunUser(model, seed, user)) };
    console.log(flags.json ? JSON.stringify(report, null, 2) : formatDryRun(report));
    return 0;
  }

  // Real run: repo .env (never overriding what is already set), strict RBAC, no demo union, no schedulers.
  if (existsSync(PATHS.env) && typeof process.loadEnvFile === "function") {
    try {
      process.loadEnvFile(PATHS.env);
    } catch {
      // A malformed .env is the API's problem to report (assertEnv at boot).
    }
  }
  applyEnv({ RBAC_STRICT: "true", HOTELOS_DEMO_PERMISSION_UNION: "false", RUN_SCHEDULERS: "false" });
  const demoPassword = seed.resolveDemoPassword();

  let app;
  try {
    const importTs = await tsImporter();
    const { buildApiServer } = await importTs(PATHS.server);
    app = await buildApiServer();
    await app.ready();
  } catch (error) {
    console.error(`[check-role-smoke] no se pudo arrancar el API en proceso: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
  const report = { mode: "run", generatedAt: new Date().toISOString(), strict: true, users: [], ok: true, failing: 0 };
  try {
    for (const user of users) {
      if (user.emergency) {
        report.users.push({ email: user.email, emergency: true, note: "no se prueba por login (§4.8)", ok: true, failures: [], routes: [], sod: [], counts: {} });
        continue;
      }
      const result = await runUser(app, model, seed, user, demoPassword, flags);
      report.users.push(result);
      if (!result.ok) report.failing += 1;
    }
  } finally {
    await app.close().catch(() => undefined);
  }
  report.ok = report.failing === 0;
  console.log(flags.json ? JSON.stringify(report, null, 2) : formatRun(report));
  return report.ok ? 0 : 1;
}

function isMain() {
  const entry = process.argv[1];
  if (!entry) return false;
  return resolve(entry) === fileURLToPath(import.meta.url);
}

if (isMain()) {
  main().then((code) => {
    process.exitCode = code;
  });
}
