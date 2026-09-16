// Estructura societaria · L9 (Tanda 6b, 2026-09-16) — contrato documental sin BD
// (`corepack pnpm test`) de lo que el front (L6 «Estructura societaria», L7
// selector «Ámbito») y el API deben respetar juntos:
//   1. manifiesto de permisos: las 9 rutas de `modules/structure` con su clave y
//      riesgo exactos, registradas una a una en structure.routes.ts y fundidas en
//      routePermissionManifest; el switcher (`GET /users/me/properties`) sigue sin clave;
//   2. las dos claves nuevas: catálogo, unión de tipos, plantillas (Owner/Admin por
//      catálogo completo, Dirección y Contabilidad con `accounting.entity.read`;
//      recepción y el resto sin ninguna; `organization.structure.manage` solo por
//      catálogo completo) y la unión demo de desarrollo;
//   3. lectores deprecados: `PropertyComplianceSetting.siiEnabled` no lo lee ningún
//      módulo de Finanzas (lista cerrada que solo encoge fuera de Finanzas);
//      el front no lee `organization.taxId/legalName` y `property.legalName` solo
//      en la lista heredada que solo encoge;
//   4. un solo punto de ámbito: en el API `lib/finance-scope.ts` es el único que
//      emite `ENTITY_SCOPE_REQUIRED` y declara las guardias; en el front solo
//      `services/financeScope.ts` toca `localStorage["hotelos-finance-scope"]` y
//      nadie redefine el tipo `FinanceScope` del contrato compartido;
//   5. la documentación nombra los tests que fijan el contrato (runbook §17.12,
//      api-contracts «Estructura societaria»).
// El comportamiento real sobre Postgres vive en tests/integration/structure-e2e.test.mts
// y tests/integration/structure-l6-l7-contract.test.mts.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = (path) => readFileSync(join(ROOT, path), "utf8");
const exists = (path) => existsSync(join(ROOT, path));
const toPosix = (path) => path.split("\\").join("/");

function walk(dir, out = [], extensions = [".ts"]) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "__tests__" || entry === "node_modules" || entry === "dist") continue;
      walk(full, out, extensions);
    } else if (extensions.some((ext) => full.endsWith(ext)) && !full.endsWith(".d.ts")) {
      out.push(full);
    }
  }
  return out;
}

/** Whole-line and block comments removed (URLs `//` inside strings survive). */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

/** Body of a template in ROLE_PERMISSION_MAP (`  <key>: [ … ],`). */
function templateBlock(permissionsSource, key) {
  const start = permissionsSource.indexOf(`\n  ${key}: [`);
  assert.ok(start >= 0, `template ${key} not found`);
  const end = permissionsSource.indexOf("\n  ],", start);
  return permissionsSource.slice(start, end < 0 ? undefined : end);
}

const apiFiles = () => walk(join(ROOT, "apps/api/src")).map((file) => toPosix(relative(ROOT, file)));
const webFiles = () => walk(join(ROOT, "apps/admin-web/src"), [], [".ts", ".tsx"]).map((file) => toPosix(relative(ROOT, file)));

const partial = read("apps/api/src/modules/structure/route-permissions.partial.ts");
const routes = read("apps/api/src/modules/structure/structure.routes.ts");
const manifest = read("apps/api/src/security/route-permissions.ts");
const server = read("apps/api/src/server.ts");
const permissions = read("packages/shared/src/permissions.ts");
const permissionTypes = read("packages/shared/src/types.ts");
const demoStore = read("apps/api/src/lib/demo-store.ts");
const financeScope = read("apps/api/src/lib/finance-scope.ts");

// ── 1 · manifiesto ───────────────────────────────────────────────────────────

/** Design §5.4 / runbook §17.8: method, path, key, risk of every structure route. */
const STRUCTURE_ROUTES = [
  ["GET", "/organizations/me/structure", "accounting.read", "medium"],
  ["POST", "/legal-entities", "organization.structure.manage", "high"],
  ["GET", "/legal-entities/:legalEntityId", "accounting.entity.read", "medium"],
  ["PATCH", "/legal-entities/:legalEntityId", "organization.structure.manage", "high"],
  ["POST", "/legal-entities/:legalEntityId/properties", "organization.structure.manage", "high"],
  ["GET", "/legal-entities/:legalEntityId/series", "billing.configure", "medium"],
  ["GET", "/legal-entities/:legalEntityId/verifactu/installations", "accounting.configure", "medium"],
  ["PATCH", "/properties/:propertyId/establishment", "organization.structure.manage", "high"],
  ["POST", "/admin/legal-entities/:legalEntityId/verifactu-scope", "admin.tenants.manage", "critical"]
];

describe("Estructura societaria · L9 · manifiesto de permisos de las rutas nuevas", () => {
  const entryPattern = /\{\s*method:\s*"(GET|POST|PATCH|DELETE|PUT)"\s*,\s*path:\s*"([^"]+)"\s*,\s*permissions:\s*\[([^\]]*)\]\s*,\s*riskLevel:\s*"(\w+)"\s*\}/g;
  const entries = [...stripComments(partial).matchAll(entryPattern)].map((m) => [m[1], m[2], [...m[3].matchAll(/"([^"]+)"/g)].map((k) => k[1]).join("|"), m[4]]);

  it("las 9 entradas del partial son exactamente las del diseño (método, ruta, clave, riesgo)", () => {
    assert.deepEqual(entries.map((e) => e.join(" ")).sort(), STRUCTURE_ROUTES.map((e) => e.join(" ")).sort());
    assert.equal(entries.length, 9);
  });

  it("cada ruta del manifiesto está registrada en structure.routes.ts con el mismo método, y no hay registros sin entrada", () => {
    const registered = [...stripComments(routes).matchAll(/\bapp\.(get|post|patch|put|delete)\(\s*"([^"]+)"/g)].map((m) => `${m[1].toUpperCase()} ${m[2]}`).sort();
    assert.deepEqual(registered, STRUCTURE_ROUTES.map(([method, path]) => `${method} ${path}`).sort());
    assert.equal((stripComments(routes).match(/assertStructureEnabled\(\)/g) ?? []).length, 9, "every handler honours STRUCTURE_ENABLED (404 STRUCTURE_DISABLED)");
  });

  it("server.ts registra las rutas y security/route-permissions.ts funde el partial; el switcher sigue sin clave (fila del manifiesto principal)", () => {
    assert.match(server, /registerStructureRoutes\(app\)/);
    assert.match(manifest, /\.\.\.structureRoutePermissions,/);
    assert.match(manifest, /\{ method: "GET", path: "\/users\/me\/properties", permissions: \[\], riskLevel: "low" \}/, "GET /users/me/properties (kind, code, legalEntityId, legalEntityName) is open to every session");
    const calendar = manifest.slice(manifest.indexOf("export const ACCOUNTING_CALENDAR_GET_PATHS"), manifest.indexOf("];", manifest.indexOf("export const ACCOUNTING_CALENDAR_GET_PATHS")));
    assert.ok(calendar.includes('"/organizations/me/structure"'), "the structure read is configuration (calendar key), redacted in the service");
    assert.ok(!calendar.includes('"/legal-entities/:legalEntityId"'));
  });

  it("las escrituras son high o critical y llevan organization.structure.manage (o la clave de plataforma en la consola); ninguna ruta lleva dos claves", () => {
    for (const [method, path, key, risk] of entries) {
      assert.ok(!key.includes("|"), `${method} ${path}: one key per route`);
      if (method !== "GET") {
        assert.ok(["high", "critical"].includes(risk), `${method} ${path} → ${risk}`);
        assert.ok(["organization.structure.manage", "admin.tenants.manage"].includes(key), `${method} ${path} → ${key}`);
      }
    }
    assert.equal(entries.filter(([, , key]) => key === "admin.tenants.manage").length, 1, "only the chain policy is console-only");
  });
});

// ── 2 · claves ────────────────────────────────────────────────────────────────

describe("Estructura societaria · L9 · las dos claves nuevas: catálogo, tipos, plantillas y unión demo", () => {
  it("accounting.entity.read y organization.structure.manage existen en PERMISSIONS y en la unión PermissionKey", () => {
    assert.match(permissions, /^\s*"accounting\.entity\.read":\s*"/m);
    assert.match(permissions, /^\s*"organization\.structure\.manage":\s*"/m);
    assert.match(permissionTypes, /\|\s*"accounting\.entity\.read"/);
    assert.match(permissionTypes, /\|\s*"organization\.structure\.manage"/);
  });

  it("plantillas: Owner y Admin por catálogo completo; Dirección (manager) y Contabilidad (accountant) leen toda la sociedad; recepción y los roles operativos no llevan ninguna; nadie más gestiona la estructura", () => {
    assert.match(permissions, /\n  owner: \[\.\.\.ORG_PERMISSION_KEYS\],/);
    assert.match(permissions, /\n  admin: \[\.\.\.ORG_PERMISSION_KEYS\]/);
    for (const key of ["manager", "accountant"]) assert.match(templateBlock(permissions, key), /"accounting\.entity\.read"/, `${key} holds accounting.entity.read`);
    for (const key of ["receptionist", "housekeeper", "maintenance", "compliance", "revenue", "sales", "fnb"]) {
      const block = templateBlock(permissions, key);
      assert.doesNotMatch(block, /"accounting\.entity\.read"/, `${key} never reads the whole sociedad`);
      assert.doesNotMatch(block, /"organization\.structure\.manage"/, `${key} never manages the structure`);
    }
    const templates = permissions.slice(permissions.indexOf("export const ROLE_PERMISSION_MAP"));
    assert.doesNotMatch(templates, /"organization\.structure\.manage"/, "organization.structure.manage reaches a role only through the full catalogue (owner / admin)");
  });

  it("la unión demo de desarrollo (demo-store baseline) concede ambas claves a toda sesión real: por eso los casos de permisos de integración apagan HOTELOS_ALLOW_DEMO_AUTH", () => {
    assert.match(demoStore, /"accounting\.entity\.read",\s*\n\s*"organization\.structure\.manage"/);
  });
});

// ── 3 · lectores deprecados ─────────────────────────────────────────────────

const FINANCE_ROOTS = [
  "apps/api/src/modules/accounting",
  "apps/api/src/modules/invoicing",
  "apps/api/src/modules/financial-statements",
  "apps/api/src/modules/payables",
  "apps/api/src/modules/treasury",
  "apps/api/src/modules/payments",
  "apps/api/src/modules/payroll",
  "apps/api/src/modules/pos",
  "apps/api/src/modules/night-audit",
  "apps/api/src/modules/compliance",
  "apps/api/src/modules/search",
  "apps/api/src/modules/dashboards",
  "apps/api/src/modules/structure"
];

/**
 * Files outside Finanzas that still touch the deprecated per-property SII flag
 * (`PropertyComplianceSetting.siiEnabled`): the tenant hydration (in-memory
 * mirror), the compliance settings form of the backoffice and the backfill that
 * REPORTS the residue (`SII_FLAG_ON_PROPERTY`). Only ever remove entries: the flag
 * retires with its migration (runbook §17.10).
 */
const LEGACY_PROPERTY_SII_TOUCHERS = [
  "apps/api/src/lib/tenant-hydration.ts",
  "apps/api/src/modules/backoffice/backoffice.service.ts",
  "apps/api/src/scripts/backfill-legal-structure.ts"
];

/** admin-web files that still read `property.legalName` (nombre comercial deprecado). Only ever remove entries. */
const LEGACY_WEB_PROPERTY_LEGAL_NAME_READERS = ["apps/admin-web/src/screens/operations/PropertyDetailScreen.tsx"];
const WEB_DEPRECATED_ORGANIZATION_READ = /\b(organization|organisation|org)\??\.(taxId|legalName)\b/;
const WEB_DEPRECATED_PROPERTY_READ = /\bproperty\??\.legalName\b/;

describe("Estructura societaria · L9 · lectores deprecados (API y front)", () => {
  it("PropertyComplianceSetting.siiEnabled: ningún módulo de Finanzas lo lee; fuera de Finanzas solo la lista heredada (que solo encoge)", () => {
    const touches = apiFiles().filter((file) => {
      const source = stripComments(read(file));
      return /\bpropertyComplianceSetting\b/.test(source) && /\bsiiEnabled\b/.test(source);
    });
    const inFinance = touches.filter((file) => FINANCE_ROOTS.some((root) => file.startsWith(`${root}/`)));
    assert.deepEqual(inFinance, [], `Finanzas lee el flag SII de la propiedad: ${inFinance.join(", ")} → LegalEntity.siiEnabled vía resolveLegalIdentity`);
    const unexpected = touches.filter((file) => !LEGACY_PROPERTY_SII_TOUCHERS.includes(file)).sort();
    assert.deepEqual(unexpected, [], `nuevos lectores del flag SII de la propiedad: ${unexpected.join(", ")}`);
    const stale = LEGACY_PROPERTY_SII_TOUCHERS.filter((file) => !touches.includes(file));
    assert.deepEqual(stale, [], `entradas obsoletas en LEGACY_PROPERTY_SII_TOUCHERS: ${stale.join(", ")}`);
    assert.match(read("apps/api/src/modules/accounting/vat-books.service.ts"), /PropertyComplianceSetting\.siiEnabled` is deprecated and never read here/);
  });

  it("admin-web: nadie lee organization.taxId / legalName (la sociedad llega por los contratos de Finanzas); property.legalName solo en la lista heredada", () => {
    const files = webFiles();
    const organizationReaders = files.filter((file) => WEB_DEPRECATED_ORGANIZATION_READ.test(stripComments(read(file)))).sort();
    assert.deepEqual(organizationReaders, [], `lectores de la identidad deprecada en el front: ${organizationReaders.join(", ")} → sociedad (GET /organizations/me/structure, badges de declarante)`);
    const propertyReaders = files.filter((file) => WEB_DEPRECATED_PROPERTY_READ.test(stripComments(read(file)))).sort();
    const unexpected = propertyReaders.filter((file) => !LEGACY_WEB_PROPERTY_LEGAL_NAME_READERS.includes(file));
    assert.deepEqual(unexpected, [], `nuevos lectores de property.legalName en el front: ${unexpected.join(", ")} → tradeName`);
    const stale = LEGACY_WEB_PROPERTY_LEGAL_NAME_READERS.filter((file) => !propertyReaders.includes(file));
    assert.deepEqual(stale, [], `entradas obsoletas en LEGACY_WEB_PROPERTY_LEGAL_NAME_READERS: ${stale.join(", ")}`);
  });
});

// ── 4 · un solo punto de ámbito ─────────────────────────────────────────────

/**
 * Files that may spell the entity-read key as a literal (declarative places);
 * anything else under lib/ and modules/ must go through lib/finance-scope.ts.
 * CLIs under apps/api/src/scripts (rbac sync, migrations that GRANT the key to a
 * role) and the route partials name keys declaratively and are exempt.
 */
const ENTITY_KEY_LITERAL_ALLOWED = [
  "apps/api/src/lib/demo-store.ts",
  "apps/api/src/lib/finance-scope.ts",
  "apps/api/src/modules/structure/legal-entity.service.ts"
];

describe("Estructura societaria · L9 · un solo punto de ámbito", () => {
  it("API: lib/finance-scope.ts es el único que emite ENTITY_SCOPE_REQUIRED y declara las guardias; ledger.routes.ts solo las reexporta", () => {
    const emitters = apiFiles().filter((file) => /"ENTITY_SCOPE_REQUIRED"/.test(stripComments(read(file))));
    assert.deepEqual(emitters, ["apps/api/src/lib/finance-scope.ts"], `ENTITY_SCOPE_REQUIRED se emite fuera de finance-scope.ts: ${emitters.join(", ")}`);
    for (const guard of ["assertFinanceReadScope", "assertFinanceWriteScope", "assertFinanceReadScopeMany", "hasEntityReadScope", "propertyWithinScope", "resolveLedgerScope"]) {
      const declarers = apiFiles().filter((file) => new RegExp(`export (async )?function ${guard}\\(`).test(read(file)));
      assert.deepEqual(declarers, ["apps/api/src/lib/finance-scope.ts"], `${guard} declared elsewhere: ${declarers.join(", ")}`);
    }
    assert.match(financeScope, /export const ENTITY_READ_PERMISSION: PermissionKey = "accounting\.entity\.read";/);
    assert.match(read("apps/api/src/modules/accounting/ledger.routes.ts"), /export \{[^}]*\bassertFinanceReadScope\b[^}]*\} from "\.\.\/\.\.\/lib\/finance-scope\.js"/s, "ledger.routes.ts re-exports the guards (no local copy)");
  });

  it("API: la clave accounting.entity.read solo se escribe literal en los sitios declarativos (catálogo demo, guardia única, servicio de estructura), en los partials de rutas y en los CLI que la conceden", () => {
    const literal = apiFiles().filter((file) => /"accounting\.entity\.read"/.test(stripComments(read(file))));
    const unexpected = literal.filter((file) => !ENTITY_KEY_LITERAL_ALLOWED.includes(file) && !file.endsWith("route-permissions.partial.ts") && !file.startsWith("apps/api/src/scripts/")).sort();
    assert.deepEqual(unexpected, [], `comprobaciones de ámbito fuera de lib/finance-scope.ts: ${unexpected.join(", ")} → assertFinanceReadScope / hasEntityReadScope`);
  });

  it("front: solo services/financeScope.ts toca localStorage[\"hotelos-finance-scope\"] y nadie redefine el tipo FinanceScope del contrato compartido", () => {
    const files = webFiles();
    const storageTouchers = files.filter((file) => /hotelos-finance-scope/.test(stripComments(read(file))) && file !== "apps/admin-web/src/services/financeScope.ts").sort();
    assert.deepEqual(storageTouchers, [], `el ámbito se persiste desde varios sitios: ${storageTouchers.join(", ")} → services/financeScope.ts`);
    const redefiners = files.filter((file) => /\b(type|interface)\s+FinanceScope\b/.test(stripComments(read(file))) && file !== "apps/admin-web/src/services/financeScope.ts").sort();
    assert.deepEqual(redefiners, [], `FinanceScope redefinido: ${redefiners.join(", ")} → import type { FinanceScope } from "@hotelos/shared"`);
    const activeProperty = read("apps/admin-web/src/services/activeProperty.ts");
    assert.match(activeProperty, /hotelos-active-property/, "the operational switcher keeps its own key");
    assert.doesNotMatch(activeProperty, /hotelos-finance-scope/, "the finance scope never lives in the active-property store (design §5.3: separate state)");
    if (exists("apps/admin-web/src/services/financeScope.ts")) {
      const scope = read("apps/admin-web/src/services/financeScope.ts");
      assert.match(scope, /hotelos-finance-scope/, "the single store persists under the agreed key");
      assert.match(scope, /FinanceScope\b/, "typed with the shared FinanceScope");
    }
  });

  it("contrato compartido: FinanceScope { kind: entity | property | group, id, label } y StructureMode viven en legal-structure-types.ts", () => {
    const types = read("packages/shared/src/legal-structure-types.ts");
    assert.match(types, /export type FinanceScopeKind = "entity" \| "property" \| "group";/);
    assert.match(types, /export type FinanceScope = \{\s*kind: FinanceScopeKind;\s*id: string;\s*label: string;\s*\};/s);
    assert.match(types, /export type StructureMode = "single_hotel" \| "multi_center" \| "group";/);
    assert.match(types, /localStorage\["hotelos-finance-scope"\]/, "the storage key is part of the documented contract");
  });
});

// ── 5 · documentación ────────────────────────────────────────────────────────

describe("Estructura societaria · L9 · la documentación nombra los tests que fijan el contrato", () => {
  it("runbook §17.12 «Front y ámbito» y api-contracts «Estructura societaria» citan las suites de L9", () => {
    const runbook = read("docs/runbooks/finanzas-contabilidad.md");
    assert.match(runbook, /^### 17\.12 Front y ámbito/m);
    const section = runbook.slice(runbook.indexOf("### 17.12 Front y ámbito"));
    for (const token of ["tests/integration/structure-e2e.test.mts", "tests/integration/structure-l6-l7-contract.test.mts", "tests/legal-structure-contract.test.mjs", "structure-read-scope.test.mts", "services/financeScope.ts", "lib/finance-scope.ts", "hotelos-finance-scope", "ENTITY_SCOPE_REQUIRED", "assigned_properties", "single_hotel"]) {
      assert.ok(section.includes(token), `runbook §17.12 mentions ${token}`);
    }
    const contracts = read("docs/api-contracts.md");
    for (const token of ["tests/integration/structure-e2e.test.mts", "tests/integration/structure-l6-l7-contract.test.mts", "tests/legal-structure-contract.test.mjs"]) {
      assert.ok(contracts.includes(token), `api-contracts.md mentions ${token}`);
    }
    for (const file of ["tests/integration/structure-e2e.test.mts", "tests/integration/structure-l6-l7-contract.test.mts", "apps/api/src/modules/structure/__tests__/structure-read-scope.test.mts"]) {
      assert.ok(exists(file), `${file} exists`);
    }
  });
});
