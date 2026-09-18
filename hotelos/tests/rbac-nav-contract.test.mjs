// Contrato RBAC × árbol de navegación (Tanda 5 · L1a · rbac; L1c: todas las GET).
//
// El árbol (apps/admin-web/src/navigation/nav-tree.generated.json, generado
// desde pilots/tanda5-nav-tree.csv) gatea cada ítem/pestaña con tokens de rol;
// cada token se sirve con una o dos plantillas de ROLE_PERMISSION_MAP
// (pilots/tanda5-nav-tree.md §3). Este test cruza, para cada ítem/pestaña,
// TODAS las rutas GET de la pantalla (columna `api_paths_principales` del
// inventario pilots/screens-inventory.csv; si ninguna es GET, la primera
// mapeada) con el manifiesto apps/api/src/security/route-permissions.ts
// (+ partials) y exige que cada plantilla del token tenga los permisos de
// cada ruta: 0 pares que faltan, o un par de la lista JUSTIFIED_GAPS (con
// tipo, evidencia y motivo). La lista no puede envejecer: cada entrada tiene
// que seguir cubriendo un par real. Cuando el inventario no está en local
// (CI) la parte dependiente del CSV se omite; el resto (plantillas,
// /users/me, reseed, premisa del front) no.
//
// PREMISA (verificada abajo, «el front NO filtra por permiso»): el menú se
// compone SOLO con tokens de rol y módulos activos (nav-tree.ts
// menuCategories, Sidebar.tsx, CommandPalette.tsx; runbook
// docs/runbooks/navegacion-tanda-5.md «El árbol NO lleva permiso por ítem»).
// Por tanto cada par que falta es un 403 REAL para un usuario que solo tenga
// esa plantilla; JUSTIFIED_GAPS no lo oculta: lo clasifica.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = (relative) => readFileSync(new URL(relative, import.meta.url), "utf8");
const tree = JSON.parse(read("../apps/admin-web/src/navigation/nav-tree.generated.json"));
const permissionsSource = read("../packages/shared/src/permissions.ts");
const typesSource = read("../packages/shared/src/types.ts");
const roleTokensSource = read("../apps/admin-web/src/navigation/role-tokens.ts");
const navTreeSource = read("../apps/admin-web/src/navigation/nav-tree.ts");
const sidebarSource = read("../apps/admin-web/src/navigation/Sidebar.tsx");
const commandPaletteSource = read("../apps/admin-web/src/components/CommandPalette.tsx");
const navRunbookSource = read("../docs/runbooks/navegacion-tanda-5.md");
const rbacCatalogSource = read("../apps/api/src/lib/rbac-catalog.ts");
const authServiceSource = read("../apps/api/src/modules/auth/auth.service.ts");
const authContextSource = read("../apps/api/src/lib/auth-context.ts");
const serverSource = read("../apps/api/src/server.ts");
const reseedSource = read("../apps/api/src/scripts/reseed-property-roles.ts");
const inventoryPath = fileURLToPath(new URL("../../pilots/screens-inventory.csv", import.meta.url));

// Token del CSV → plantillas reales (pilots/tanda5-nav-tree.md §3; Tanda 8a
// design §4.2 / §5.1: 24 plantillas, 15 tokens autenticados). Con varias
// plantillas bajo un token, un hueco de una plantilla N1 que cubre su hermana
// N2 es de tipo `sister` (§4.10). `break_glass` no sirve ningún token: es la
// sesión de emergencia (§4.8), fuera de ORGANIZATION_TEMPLATE_ROLE_KEYS.
const TOKEN_TEMPLATES = {
  recepcion: ["receptionist", "night_auditor", "front_office_manager"],
  pisos: ["housekeeper", "housekeeping_manager"],
  mantenimiento: ["maintenance", "maintenance_manager"],
  fnb: ["fnb", "fnb_manager"],
  comercial: ["sales"],
  administracion: ["admin_clerk"],
  direccion: ["manager", "operations_director", "general_manager"],
  revenue: ["revenue"],
  finanzas: ["accountant", "controller", "compliance"],
  rrhh: ["payroll_hr"],
  activos: ["asset_manager"],
  propiedad: ["owner"],
  auditoria: ["auditor"],
  sistemas: ["admin"],
  // §3: `admin` es el administrador de PLATAFORMA (Local Super Admin: catálogo
  // completo, clave admin.tenants.manage incluida, backfillTemplateRoles), no
  // la plantilla de organización `admin` (token `sistemas` desde la Tanda 8a,
  // H11). Se modela como pseudo-plantilla "platform" = todo el catálogo.
  admin: ["platform"],
  publico: []
};
const AUTHENTICATED_TOKENS = Object.keys(TOKEN_TEMPLATES).filter((token) => token !== "publico");

// Pares (plantilla, permiso) que faltan y se toleran, CLASIFICADOS. El front
// no filtra por permiso (ver la premisa arriba), así que ninguna entrada
// «oculta» nada: dice qué pasa de verdad y por qué se acepta hoy. `kind`:
//   - "write":     la única ruta mapeada de la entrada es de escritura (no
//                  hay GET); la pantalla abre y solo la acción devuelve 403.
//                  Mínimo privilegio por diseño (§10). El test comprueba que
//                  ningún par vivo es GET.
//   - "sister":    403 real para un usuario con SOLO esa plantilla; la otra
//                  plantilla del mismo token (finanzas = accountant ∪
//                  compliance) tiene la clave. Rodeo documentado (informe
//                  L1a): asignar los dos roles Contabilidad y Cumplimiento.
//                  El test comprueba que la hermana (owner no cuenta: tiene
//                  todo el catálogo) sí la tiene.
//   - "pending":   403 real y NINGUNA plantilla hermana la tiene (token de
//                  una sola plantilla, o manager dentro de direccion). Hueco
//                  de producto: `handoff` dice qué clave añadir en
//                  packages/shared/src/permissions.ts (lote api / L2) o qué
//                  fila del CSV recortar. El test comprueba que sigue sin
//                  hermana; al añadir la clave, la entrada muere y se retira.
//   - "inventory": la columna api_paths_principales atribuye a la pantalla
//                  una ruta que su código no llama (RBAC-11: regenerar la
//                  columna desde los servicios; lote csv). `evidence` nombra
//                  el fichero y las funciones de servicio que sí llama.
// `screens` acota qué pantallas cubre cada entrada; `templates` lista las
// plantillas (una entrada sin par vivo para alguna de ellas falla).
// L1b (api-side) retiró las dos justificaciones «L2» de L1a: los GET de
// folios, TPV, tasa turística, VeriFactu y registro de viajeros llevan ya
// claves de lectura (ver READ_GATED_GETS más abajo).
const JUSTIFIED_GAPS = [
  // Tanda 8a · L4 (cruce del 2026-09-18 sobre el árbol regenerado × pilots/screens-inventory.csv × manifiesto final de L1+L2):
  // 0 pares `pending` (los 7 de la Tanda 5/6 quedaron cubiertos por las plantillas v2 de L0 y las claves de lectura de L2),
  // 6 pares `write` (Extractos y remesas solo tiene el POST de importación) y 82 pares `sister` (N1 sin la clave que su
  // hermana N2 tiene, o plantilla de un token multi-plantilla sin la clave que otra del mismo token sí tiene). Cada
  // entrada cubre pares reales: el test «ninguna justificación muerta» la retira cuando dejen de existir.
  // --- write: Conciliación bancaria › Extractos y remesas (solo POST) ------------------------------------------
  {
    templates: ["compliance", "controller", "manager", "operations_director", "general_manager", "auditor"],
    permission: "banking.reconcile",
    screens: /^BankingSpain$/,
    kind: "write",
    evidence: "bankingApi.importCsb43 → POST /properties/:p/banking/csb43/import [banking.reconcile]; la pestaña no tiene GET mapeado en el inventario; solo admin_clerk y accountant (M11 E, §4.4/§4.5) importan extractos",
    reason: "importar extractos CSB43 y conciliar es de administración de hotel y contabilidad (banking.reconcile); dirección, dirección financiera, cumplimiento y auditoría consultan la conciliación"
  },
  // --- sister (token finanzas: accountant · controller · compliance) ------------------------------------------
  {
    templates: ["accountant", "compliance"],
    permission: "commissions.read",
    screens: /^CommissionsScreen$/,
    kind: "sister",
    evidence: "CommissionsScreen.tsx commissionsApi → GET /commissions/rules · /commissions/accruals · /commissions/summary [commissions.read]; la versión 2 retira commissions.read de accountant y compliance (ROLE_TEMPLATE_REVOCATIONS, §6.5); controller (M17 V) la conserva",
    reason: "las comisiones de canales son comercial y dirección financiera (M17); contabilidad y cumplimiento no las revisan"
  },
  {
    templates: ["accountant", "controller"],
    permission: "compliance.configure",
    screens: /^PropertyTaxesScreen$/,
    kind: "sister",
    evidence: "taxesApi.fetchPropertyTaxes → GET /backoffice/properties/:p/taxes [compliance.configure] (L2 no lo pasó a compliance.read: §4.6 lo preveía); compliance la tiene (M15b E)",
    reason: "los impuestos por categoría se configuran desde cumplimiento; contabilidad y dirección financiera consultan (pendiente de L2: GET …/taxes → compliance.read)"
  },
  {
    templates: ["compliance"],
    permission: "analytics.export",
    screens: /^GestoriaExportScreen$/,
    kind: "sister",
    evidence: "financialStatementsApi.listGestoriaFormats / listGestoriaExports → GET /accounting/gestoria-exports/formats · GET /accounting/gestoria-exports · GET /accounting/gestoria-exports/:exportId [analytics.export]; accountant y controller la tienen (M10 P)",
    reason: "exportar asientos y libros a la gestoría es de Contabilidad (analytics.export); Cumplimiento no exporta"
  },
  {
    templates: ["compliance"],
    permission: "assets.read",
    screens: /^FixedAssetsScreen$/,
    kind: "sister",
    evidence: "assetsApi.listFixedAssets → GET /properties/:p/asset-register · /asset-register/:assetId [assets.read]; accountant y controller la tienen (M13 V)",
    reason: "el registro de inmovilizado y su amortización son de Contabilidad; Cumplimiento consulta los estados contables, no los elementos"
  },
  {
    templates: ["compliance"],
    permission: "banking.read",
    screens: /^BankReconciliationScreen$/,
    kind: "sister",
    evidence: "BankReconciliationScreen.tsx useApiData(\"/banking/accounts\") → GET /banking/accounts [banking.read]; accountant y controller la tienen (M11 V)",
    reason: "cuentas y extractos bancarios son de Contabilidad y Tesorería; Cumplimiento consulta la conciliación con el segundo rol"
  },
  {
    templates: ["compliance"],
    permission: "inventory.read",
    screens: /^FnbInventory$/,
    kind: "sister",
    evidence: "fnbInventoryApi → GET /properties/:p/stock-balances · /menu-items · /stock-balances/low-stock · /inventory-items · /stock-locations · GET /menu-items/:id [inventory.read]; la versión 2 retira inventory.read de compliance (§6.5); accountant y controller la tienen (M8 V)",
    reason: "las existencias de F&B son de compras y contabilidad (M8); Cumplimiento no las consulta"
  },
  {
    templates: ["compliance"],
    permission: "payables.read",
    screens: /^SupplierBillsScreen$/,
    kind: "sister",
    evidence: "payablesApi → GET /properties/:p/payables/supplier-bills · /supplier-bills/:billId · /payables/aging [payables.read] (clave nueva de L0, §4.6); accountant y controller la tienen (M9 V)",
    reason: "las facturas de proveedor son de contabilidad, administración de hotel y dirección financiera (M9); Cumplimiento no las registra ni aprueba"
  },
  {
    templates: ["compliance"],
    permission: "payroll.read",
    screens: /^PayrollScreen$/,
    kind: "sister",
    evidence: "PayrollScreen.tsx useApiData(\"/payroll/contracts\"), (\"/payroll/periods\") y GET /payroll/periods/:id/export [payroll.read]; accountant y controller la tienen (M12 V)",
    reason: "nóminas son de RRHH, contabilidad y dirección; un responsable de cumplimiento no las consulta"
  },
  {
    templates: ["compliance"],
    permission: "pos.read",
    screens: /^(PosDashboard|CashClosureScreen)$/,
    kind: "sister",
    evidence: "posApi → GET /properties/:p/pos/tickets · /pos/outlets · /pos/cash-summary · /pos/cash-closures · /pos/cash-closures/:closureId [pos.read]; la versión 2 retira pos.read de compliance (§6.5); accountant y controller la tienen (M7 V)",
    reason: "el TPV y el cierre de caja son operación y contabilidad (M7); Cumplimiento no consulta comandas"
  },
  {
    templates: ["compliance"],
    permission: "procurement.read",
    screens: /^SuppliersScreen$/,
    kind: "sister",
    evidence: "payablesApi.listSuppliers → GET /organizations/:p/payables/suppliers · /suppliers/:supplierId [procurement.read]; accountant y controller la tienen (M8 V)",
    reason: "el directorio de proveedores es de Contabilidad (procurement.read/manage); Cumplimiento consulta facturas recibidas y libros, no da de alta proveedores"
  },
  // --- sister (token direccion: manager · operations_director · general_manager) ------------------------------
  {
    templates: ["manager"],
    permission: "backoffice.access",
    screens:
      /^(SetupCenterScreen|GoLiveChecklist|PropertyProfileSetupForm|BuildingSetupForm|FloorSetupForm|ZoneSetupForm|DepartmentSetupForm|CategoryManagerScreen|CategoryDetailScreen|CategoryOptionForm|CustomFieldSetupForm|RoomSetupForm|RoomTypeSetupForm|SpaceResourceSetupForm|HousekeepingSetupForm|MaintenanceSetupForm|BillingSettings|PaymentSettings|AccountingSettings|FinanceComplianceSetupForm|RevenueCategorySetupForm|AiPropertySetupForm)$/,
    kind: "sister",
    evidence: "el inventario atribuye a los formularios de alta GET /backoffice/properties/:p/dashboard · /setup · /readiness [backoffice.access]; la versión 2 retira backoffice.access de manager (M20, §6.5: el ámbito sociedad pasa a la asignación); operations_director y general_manager (M20 V) la conservan",
    reason: "la estructura societaria y fiscal (M20) es de dirección de operaciones, dirección general y central; la dirección de hotel abre los formularios de su propiedad con configuration.read"
  },
  {
    templates: ["operations_director", "general_manager"],
    permission: "compliance.configure",
    screens: /^PropertyTaxesScreen$/,
    kind: "sister",
    evidence: "taxesApi.fetchPropertyTaxes → GET /backoffice/properties/:p/taxes [compliance.configure] (pendiente de L2: → compliance.read); manager la tiene (M15b E)",
    reason: "configurar impuestos es de la dirección de hotel y de cumplimiento; las direcciones de operaciones y general consultan"
  },
  {
    templates: ["operations_director", "general_manager"],
    permission: "integrations.connect",
    screens: /^EmailConnectors$/,
    kind: "sister",
    evidence: "emailApi → GET /email/connections/:id/authorize-url [integrations.connect] (inicia un OAuth); manager (M22b E) y admin la tienen",
    reason: "conectar el correo entrante es una acción de configuración de la dirección de hotel o de sistemas; las direcciones de operaciones y general leen las conexiones"
  },
  // --- sister (token recepcion: receptionist · night_auditor · front_office_manager) -----------------------------
  {
    templates: ["night_auditor"],
    permission: "groups.read",
    screens: /^(GroupsEventsDashboard|GroupsCalendarScreen)$/,
    kind: "sister",
    evidence: "groupsApi → GET /groups/properties/:p · /groups/:id · /properties/:p/groups/pickup-summary [groups.read]; receptionist y front_office_manager la tienen (M17 V)",
    reason: "la auditoría nocturna cierra el día y no gestiona grupos (§4.4: AudN sin M17); comparte el token recepcion con la recepción de día"
  },
  {
    templates: ["night_auditor"],
    permission: "events.read",
    screens: /^GroupsEventsDashboard$/,
    kind: "sister",
    evidence: "GroupsEventsDashboard → GET /properties/:p/event-spaces [events.read]; receptionist y front_office_manager la tienen (M17 V)",
    reason: "los espacios de eventos son de recepción de día y comercial; la auditoría nocturna no los consulta"
  }
];

const GAP_KINDS = ["write", "sister", "pending", "inventory"];

/** A justification covers a pair when template, permission and screen match. */
function gapCovers(gap, pair) {
  return gap.templates.includes(pair.template) && gap.permission === pair.permission && gap.screens.test(pair.screenKey);
}

/** Sister templates of a token: the other templates that serve it; owner (propiedad) and platform are single-template tokens and break_glass (todo el catálogo) never counts. */
function sisterTemplates(token, template) {
  return (TOKEN_TEMPLATES[token] ?? []).filter((candidate) => candidate !== template && candidate !== "owner" && candidate !== "platform" && candidate !== "break_glass");
}

// ---------------------------------------------------------------------------
// Parsers (sin BD, sin TS): mismas heurísticas que el resto de contratos.
// ---------------------------------------------------------------------------

function stripLineComments(source) {
  return source
    .split("\n")
    .map((line) => line.replace(/\s*\/\/.*$/, ""))
    .join("\n");
}

function parsePermissionCatalog(source) {
  const block = source.match(/export const PERMISSIONS[^{]*\{(.*?)\n\};/s);
  assert.ok(block, "PERMISSIONS block not found");
  return [...block[1].matchAll(/^\s*"([a-z_]+(?:\.[a-z_]+)+)":\s*"/gm)].map((m) => m[1]);
}

function parseTemplates(source) {
  const catalog = parsePermissionCatalog(source);
  const orgKeys = catalog.filter((key) => !key.startsWith("admin.") && !key.startsWith("platform."));
  const block = source.match(/export const ROLE_PERMISSION_MAP[^{]*\{(.*?)\n\};/s);
  assert.ok(block, "ROLE_PERMISSION_MAP block not found");
  const body = stripLineComments(block[1]);
  const templates = {};
  for (const m of body.matchAll(/^\s*(\w+):\s*\[(.*?)\]/gms)) {
    templates[m[1]] = m[2].includes("ORG_PERMISSION_KEYS") ? new Set(orgKeys) : new Set([...m[2].matchAll(/"([^"]+)"/g)].map((k) => k[1]));
  }
  return { catalog: new Set(catalog), orgKeys, templates };
}

function parseTemplateKeys(source) {
  const block = source.match(/export const ROLE_TEMPLATE_KEYS[^=]*=\s*\[([^\]]+)\]/);
  assert.ok(block, "ROLE_TEMPLATE_KEYS not found");
  return [...block[1].matchAll(/"([a-z_]+)"/g)].map((k) => k[1]);
}

function parseRecordKeys(source, name) {
  const block = source.match(new RegExp(`export const ${name}[^=]*=\\s*\\{(.*?)\\n\\};`, "s"));
  assert.ok(block, `${name} not found`);
  return [...stripLineComments(block[1]).matchAll(/^\s*([a-z_]+):/gm)].map((m) => m[1]);
}

function parseManifestEntries(source) {
  return [...source.matchAll(/method:\s*"(GET|POST|PATCH|PUT|DELETE)",\s*path:\s*"([^"]+)",\s*permissions:\s*\[([^\]]*)\]/g)].map((m) => ({
    method: m[1],
    path: m[2],
    permissions: [...m[3].matchAll(/"([^"]+)"/g)].map((k) => k[1]),
    re: new RegExp(`^${m[2].replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/:[A-Za-z_]+/g, "[^/]+")}$`)
  }));
}

/** Manifiesto en orden real: los partials se hacen spread al principio de routePermissionManifest. */
function loadManifest() {
  const apiSrc = new URL("../apps/api/src/", import.meta.url);
  const main = readFileSync(new URL("security/route-permissions.ts", apiSrc), "utf8");
  const partials = readdirSync(new URL("modules/", apiSrc))
    .flatMap((mod) => {
      try {
        return readdirSync(new URL(`modules/${mod}/`, apiSrc))
          .filter((name) => name === "route-permissions.partial.ts")
          .map(() => ({ mod, source: readFileSync(new URL(`modules/${mod}/route-permissions.partial.ts`, apiSrc), "utf8") }));
      } catch {
        return [];
      }
    });
  const spreadOrder = [...main.matchAll(/^\s*\.\.\.(\w+),/gm)].map((m) => m[1]);
  const ordered = spreadOrder
    .map((name) => partials.find((partial) => partial.source.includes(`export const ${name}`)))
    .filter(Boolean);
  return [...ordered.flatMap((partial) => parseManifestEntries(partial.source)), ...parseManifestEntries(main)];
}

/** Parser CSV RFC 4180 mínimo (comillas dobles, saltos de línea dentro de comillas). */
function parseCsv(text) {
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

const { catalog, templates } = parseTemplates(permissionsSource);
const templateKeys = parseTemplateKeys(permissionsSource);
// Platform administrator (see TOKEN_TEMPLATES.admin): every catalog key.
templates.platform = new Set(catalog);
const manifest = loadManifest();
const treeEntries = tree.categories.flatMap((category) => category.items.flatMap((item) => [item, ...item.tabs]));

function requiredPermissionsFor(inventoryPath) {
  const probe = inventoryPath.replace(/:p\b/g, "X");
  const get = manifest.find((entry) => entry.method === "GET" && entry.re.test(probe));
  if (get) return { permissions: get.permissions, method: "GET", path: get.path };
  const other = manifest.find((entry) => entry.re.test(probe));
  if (other) return { permissions: other.permissions, method: other.method, path: other.path };
  return null;
}

/**
 * Rutas de lectura de una pantalla (L1c): TODAS las rutas del inventario con
 * GET mapeado (una por entrada del manifiesto); si ninguna es GET, la primera
 * mapeada (p. ej. BankingSpain solo lista el POST de importación). L1a/L1b
 * evaluaban solo la primera GET, y así pasaban entradas cuyo segundo GET
 * devuelve 403 (hallazgo api-rbac#5).
 */
/**
 * Pantallas nacidas después del inventario (pilots/screens-inventory.csv, fuera
 * del repo): sus rutas de lectura hasta que el integrador añada la fila.
 * Tanda 8a · L4: la bandeja de aprobaciones lee GET /approvals (authenticated).
 */
// Integrador 8a: ApprovalsInbox ya tiene fila en pilots/screens-inventory.csv
// (GET /approvals, POST /approvals/:id/approve|reject); ninguna pantalla del
// árbol queda fuera del inventario, así que no hay fallback.
const TREE_ROUTES_FALLBACK = {};

function readRoutesFor(row, screenKey) {
  const raw = row ? row.api_paths_principales : (TREE_ROUTES_FALLBACK[screenKey] ?? "");
  const paths = raw.split(/\s+/).filter((p) => p.startsWith("/"));
  const gets = new Map();
  for (const path of paths) {
    const required = requiredPermissionsFor(path);
    if (required && required.method === "GET" && !gets.has(required.path)) gets.set(required.path, { path, ...required });
  }
  if (gets.size > 0) return [...gets.values()];
  for (const path of paths) {
    const required = requiredPermissionsFor(path);
    if (required) return [{ path, ...required }];
  }
  return [];
}

// ---------------------------------------------------------------------------
// Plantillas (packages/shared)
// ---------------------------------------------------------------------------

describe("RBAC × nav · plantillas de rol (Tanda 5 §3/§10)", () => {
  it("ROLE_TEMPLATE_KEYS son las 24 plantillas de la Tanda 8a (§4.2 + break_glass), el tipo RoleKey también, y cada plantilla tiene claves del catálogo", () => {
    const expected = ["receptionist", "night_auditor", "front_office_manager", "housekeeper", "housekeeping_manager", "maintenance", "maintenance_manager", "fnb", "fnb_manager", "sales", "admin_clerk", "manager", "operations_director", "general_manager", "break_glass", "revenue", "accountant", "controller", "compliance", "payroll_hr", "asset_manager", "owner", "auditor", "admin"];
    assert.deepEqual([...templateKeys].sort(), [...expected].sort());
    for (const key of expected) assert.match(typesSource, new RegExp(`\\|\\s*"${key}"`), `RoleKey lacks ${key}`);
    for (const key of templateKeys) {
      assert.ok(templates[key] instanceof Set && templates[key].size > 0, `template ${key} empty or unparsed`);
      for (const permission of templates[key]) assert.ok(catalog.has(permission), `${key}: ${permission} not in PERMISSIONS`);
    }
  });

  it("las plantillas del catálogo y las del front (role-tokens.ts) son el mismo conjunto, y cada token lleva sus plantillas", () => {
    const front = [...roleTokensSource.matchAll(/^\s*([a-z_]+):\s*"(?:direccion|recepcion|pisos|mantenimiento|revenue|finanzas|comercial|fnb|administracion|rrhh|propiedad|activos|auditoria|sistemas)"/gm)].map((m) => m[1]);
    assert.deepEqual([...front].sort(), [...templateKeys].sort());
    for (const token of Object.keys(TOKEN_TEMPLATES)) {
      for (const template of TOKEN_TEMPLATES[token]) assert.ok(template === "platform" || templateKeys.includes(template), `${token} → ${template} unknown`);
    }
    // Every template but break_glass serves exactly one token, and role-tokens.ts agrees (ROLE_TEMPLATE_TO_TOKEN).
    const served = Object.entries(TOKEN_TEMPLATES).flatMap(([token, list]) => list.filter((template) => template !== "platform").map((template) => [template, token]));
    assert.deepEqual(served.map(([template]) => template).sort(), templateKeys.filter((key) => key !== "break_glass").sort());
    for (const [template, token] of served) assert.match(roleTokensSource, new RegExp(`^\\s*${template}:\\s*"${token}",?$`, "m"), `${template} → ${token} in role-tokens.ts`);
    assert.match(roleTokensSource, /^\s*break_glass:\s*"direccion",?$/m);
    assert.doesNotMatch(roleTokensSource, /^\s*[a-z_]+:\s*"admin",?$/m, "no template yields the platform token (H11)");
  });

  it("analytics.read (Mi día) está en todas las plantillas: primer delta de §10", () => {
    for (const key of templateKeys) assert.ok(templates[key].has("analytics.read"), `${key} cannot open /dashboards/*`);
  });

  it("mínimo privilegio: las claves de escritura rechazadas en §10 siguen fuera", () => {
    assert.equal(templates.receptionist.has("backoffice.access"), false, "receptionist must not get backoffice.access (§10)");
    assert.equal(templates.receptionist.has("inventory.read"), false, "inventory.read moved to fnb");
    assert.equal(templates.manager.has("accounting.journal.post"), false);
    assert.equal(templates.compliance.has("accounting.journal.post"), false);
    assert.equal(templates.compliance.has("folio.charge.post"), false);
    assert.equal(templates.compliance.has("billing.configure"), false);
    assert.equal(templates.accountant.has("compliance.configure"), false);
    assert.equal(templates.accountant.has("compliance.gdpr.manage"), false);
    assert.equal(templates.accountant.has("compliance.ses.submit"), false);
    for (const key of ["sales", "fnb"]) {
      for (const forbidden of ["property.configure", "roles.manage", "users.invite", "modules.enable", "billing.configure", "payment.refund", "invoice.issue", "accounting.journal.post"]) {
        assert.equal(templates[key].has(forbidden), false, `${key} must not hold ${forbidden}`);
      }
    }
    assert.equal(templates.sales.has("folio.charge.post"), false, "sales handles no money");
    assert.equal(templates.sales.has("payment.capture"), false);
    assert.equal(templates.fnb.has("pms.reservation.create"), false, "fnb creates no reservations");
    assert.ok(templates.fnb.has("pos.order.charge_to_room"));
    assert.ok(templates.sales.has("crm.read") && templates.sales.has("groups.read") && templates.sales.has("channel_manager.read"));
    assert.ok(templates.manager.has("crm.read") && templates.manager.has("channel_manager.read"), "direccion still sees Clientes and Canales (64 items)");
  });

  it("etiquetas ES y lista de plantillas por organización (reseed) cubren el catálogo; admin y break_glass quedan fuera; cada plantilla tiene alias", () => {
    const labels = parseRecordKeys(permissionsSource, "ROLE_TEMPLATE_LABELS_ES");
    const descriptions = parseRecordKeys(permissionsSource, "ROLE_TEMPLATE_DESCRIPTIONS_ES");
    assert.deepEqual([...labels].sort(), [...templateKeys].sort());
    assert.deepEqual([...descriptions].sort(), [...templateKeys].sort());
    const orgBlock = permissionsSource.match(/export const ORGANIZATION_TEMPLATE_ROLE_KEYS[^=]*=\s*\[([^\]]+)\]/);
    assert.ok(orgBlock);
    const orgTemplates = [...orgBlock[1].matchAll(/"([a-z_]+)"/g)].map((k) => k[1]);
    assert.equal(orgTemplates.includes("admin"), false);
    assert.equal(orgTemplates.includes("break_glass"), false, "the emergency template is created only by ensureBreakGlassRole (§4.8)");
    assert.deepEqual([...orgTemplates].sort(), templateKeys.filter((k) => k !== "admin" && k !== "break_glass").sort());
    for (const key of templateKeys) assert.match(rbacCatalogSource, new RegExp(`^\\s*${key}: \\[`, "m"), `ROLE_TEMPLATE_ALIASES lacks ${key}`);
  });
});

// ---------------------------------------------------------------------------
// Claves de lectura de los GET (Tanda 5 · L1b · api-side)
// ---------------------------------------------------------------------------

// GET que estaban gateados por claves de escritura → clave de lectura (L1b api-side
// de la Tanda 5; L1/L2 de la Tanda 8a, §4.6). `templates` = plantillas que la
// tienen por diseño (§4.4/§4.5: las de los tokens que ven las pantallas que
// llaman al GET); además, con el inventario en local, cada plantilla de cada
// token que ve una pantalla a la que el inventario atribuye el GET debe tenerla
// o el hueco ha de ser un `sister` justificado (403 real documentado con
// hermana que sí la tiene).
const READ_GATED_GETS = [
  { path: "/folios/:id/balance", permission: "folio.read", templates: ["receptionist", "night_auditor", "front_office_manager", "accountant", "controller", "compliance", "manager", "operations_director", "general_manager", "admin_clerk", "auditor"] },
  { path: "/reservations/:id/folios", permission: "folio.read", templates: ["receptionist", "night_auditor", "front_office_manager", "accountant", "controller", "compliance", "manager", "operations_director", "general_manager", "admin_clerk", "auditor"] },
  { path: "/reservations/:id/routing-rules", permission: "folio.read", templates: ["receptionist", "night_auditor", "front_office_manager", "accountant", "controller", "compliance", "manager", "operations_director", "general_manager", "admin_clerk", "auditor"] },
  { path: "/tourist-tax/rates", permission: "tourist_tax.read", templates: ["receptionist", "night_auditor", "front_office_manager", "accountant", "controller", "compliance", "manager", "operations_director", "general_manager", "admin_clerk", "auditor"] },
  { path: "/properties/:propertyId/tourist-tax/applications", permission: "tourist_tax.read", templates: ["accountant", "controller", "compliance", "manager", "operations_director", "general_manager", "auditor"] },
  { path: "/properties/:propertyId/pos/outlets", permission: "pos.read", templates: ["fnb", "fnb_manager", "receptionist", "night_auditor", "front_office_manager", "manager", "operations_director", "general_manager", "accountant", "controller", "auditor"] },
  { path: "/properties/:propertyId/pos/tickets", permission: "pos.read", templates: ["fnb", "fnb_manager", "receptionist", "night_auditor", "front_office_manager", "manager", "operations_director", "general_manager", "accountant", "controller", "auditor"] },
  { path: "/properties/:propertyId/pos/cash-summary", permission: "pos.read", templates: ["fnb", "fnb_manager", "receptionist", "night_auditor", "front_office_manager", "manager", "operations_director", "general_manager", "accountant", "controller", "auditor"] },
  { path: "/properties/:propertyId/verifactu/submissions", permission: "billing.compliance.view", templates: ["receptionist", "night_auditor", "front_office_manager", "accountant", "controller", "compliance", "manager", "operations_director", "general_manager", "admin_clerk", "auditor"] },
  { path: "/verifactu/submissions/:id", permission: "billing.compliance.view", templates: ["accountant", "controller", "compliance", "manager", "operations_director", "general_manager", "auditor"] },
  { path: "/invoices/:id/verifactu", permission: "billing.compliance.view", templates: ["accountant", "controller", "compliance", "manager", "operations_director", "general_manager", "auditor"] },
  { path: "/properties/:propertyId/tbai/submissions", permission: "billing.compliance.view", templates: ["receptionist", "night_auditor", "front_office_manager", "accountant", "controller", "compliance", "manager", "operations_director", "general_manager", "admin_clerk", "auditor"] },
  { path: "/tbai/submissions/:id", permission: "billing.compliance.view", templates: ["accountant", "controller", "compliance", "manager", "operations_director", "general_manager", "auditor"] },
  { path: "/properties/:propertyId/igic/submissions", permission: "billing.compliance.view", templates: ["receptionist", "night_auditor", "front_office_manager", "accountant", "controller", "compliance", "manager", "operations_director", "general_manager", "admin_clerk", "auditor"] },
  { path: "/igic/submissions/:id", permission: "billing.compliance.view", templates: ["accountant", "controller", "compliance", "manager", "operations_director", "general_manager", "auditor"] },
  { path: "/properties/:propertyId/guest-register-records", permission: "guest_register.read", templates: ["receptionist", "night_auditor", "front_office_manager", "accountant", "controller", "compliance", "manager", "operations_director", "general_manager", "admin_clerk", "auditor"] },
  { path: "/properties/:propertyId/compliance/inbox", permission: "guest_register.read", templates: ["receptionist", "night_auditor", "front_office_manager", "accountant", "controller", "compliance", "manager", "operations_director", "general_manager", "admin_clerk", "auditor"] },
  { path: "/ses/submissions/:id", permission: "guest_register.read", templates: ["receptionist", "night_auditor", "front_office_manager", "accountant", "controller", "compliance", "manager", "operations_director", "general_manager", "admin_clerk", "auditor"] },
  // Tanda L2 (L2-01): the canonical SES list is /properties/:propertyId/ses/submissions; the
  // /ses-hospedajes/submissions duplicate is retired by L2-02.
  { path: "/properties/:propertyId/ses/submissions", permission: "guest_register.read", templates: ["receptionist", "night_auditor", "front_office_manager", "accountant", "controller", "compliance", "manager", "operations_director", "general_manager", "admin_clerk", "auditor"] },
  // Tanda 8a · L1/L2 (§4.6): claves de lectura nuevas y GET de auditoría / cumplimiento / proveedores recableados.
  { path: "/properties/:propertyId/housekeeping/board", permission: "housekeeping.read", templates: ["housekeeper", "housekeeping_manager", "manager", "operations_director", "general_manager", "auditor"] },
  { path: "/properties/:propertyId/work-orders", permission: "maintenance.read", templates: ["maintenance", "maintenance_manager", "manager", "operations_director", "general_manager", "auditor"] },
  { path: "/properties/:propertyId/assets", permission: "assets.read", templates: ["maintenance_manager", "manager", "operations_director", "general_manager", "accountant", "controller", "asset_manager", "auditor"] },
  { path: "/properties/:propertyId/capex", permission: "capex.read", templates: ["maintenance_manager", "manager", "operations_director", "general_manager", "accountant", "controller", "asset_manager", "owner", "auditor"] },
  { path: "/gdpr/requests", permission: "compliance.read", templates: ["accountant", "controller", "compliance", "manager", "operations_director", "general_manager", "auditor"] },
  { path: "/gdpr/requests/:id", permission: "compliance.read", templates: ["accountant", "controller", "compliance", "manager", "operations_director", "general_manager", "auditor"] },
  { path: "/compliance/properties/:propertyId/center", permission: "compliance.read", templates: ["accountant", "controller", "compliance", "manager", "operations_director", "general_manager", "asset_manager", "auditor"] },
  { path: "/audit-events", permission: "audit.read", templates: ["manager", "operations_director", "general_manager", "auditor", "admin"] },
  { path: "/audit-events/facets", permission: "audit.read", templates: ["manager", "operations_director", "general_manager", "auditor", "admin"] },
  { path: "/audit-events/integrity", permission: "audit.read", templates: ["manager", "operations_director", "general_manager", "auditor", "admin"] },
  { path: "/events", permission: "audit.read", templates: ["manager", "operations_director", "general_manager", "auditor", "admin"] },
  { path: "/events/integrity", permission: "audit.read", templates: ["manager", "operations_director", "general_manager", "auditor", "admin"] },
  { path: "/ai/tool-calls", permission: "audit.read", templates: ["manager", "operations_director", "general_manager", "auditor", "admin"] },
  { path: "/properties/:propertyId/payables/supplier-bills", permission: "payables.read", templates: ["accountant", "controller", "manager", "operations_director", "general_manager", "admin_clerk", "auditor"] },
  { path: "/properties/:propertyId/payables/supplier-bills/:billId", permission: "payables.read", templates: ["accountant", "controller", "manager", "operations_director", "general_manager", "admin_clerk", "auditor"] },
  { path: "/properties/:propertyId/payables/supplier-bills/:billId/attachment", permission: "payables.read", templates: ["accountant", "controller", "manager", "operations_director", "general_manager", "admin_clerk", "auditor"] },
  { path: "/properties/:propertyId/payables/aging", permission: "payables.read", templates: ["accountant", "controller", "manager", "operations_director", "general_manager", "admin_clerk", "auditor"] }
];

describe("RBAC × nav · los GET de folios, TPV, tasa turística, VeriFactu, registro de viajeros, pisos, mantenimiento, activos, RGPD, cumplimiento, auditoría y proveedores llevan claves de lectura (L1b · Tanda 8a L1/L2)", () => {
  it("cada GET exige exactamente su clave de lectura y ninguna de escritura", () => {
    for (const expected of READ_GATED_GETS) {
      const entry = manifest.find((candidate) => candidate.method === "GET" && candidate.path === expected.path);
      assert.ok(entry, `manifest entry for GET ${expected.path}`);
      assert.deepEqual(entry.permissions, [expected.permission], `GET ${expected.path}`);
    }
    const writeGated = manifest.filter(
      (entry) => entry.method === "GET" && entry.permissions.some((key) => key === "folio.charge.post" || key === "compliance.ses.submit" || key === "housekeeping.task.manage" || key === "maintenance.workorder.manage" || key === "compliance.gdpr.manage" || key === "ai.high_risk.confirm")
    );
    assert.deepEqual(writeGated.map((entry) => entry.path), [], "no GET is gated by a write key of §4.6 any more");
  });

  it("las claves de lectura existen en el catálogo, las plantillas de diseño las tienen y la plataforma también", () => {
    for (const key of ["folio.read", "pos.read", "tourist_tax.read", "housekeeping.read", "maintenance.read", "compliance.read", "payables.read", "capex.read", "audit.read"]) assert.ok(catalog.has(key), `${key} not in PERMISSIONS`);
    for (const expected of READ_GATED_GETS) {
      for (const template of expected.templates) {
        assert.ok(templates[template], `template ${template} unparsed`);
        assert.ok(templates[template].has(expected.permission), `${template} lacks ${expected.permission} (GET ${expected.path})`);
      }
      assert.ok(templates.platform.has(expected.permission), `platform lacks ${expected.permission}`);
    }
    // Least privilege: read keys do not leak to templates whose token never sees the screen.
    for (const key of ["folio.read", "pos.read", "tourist_tax.read"]) {
      for (const template of ["housekeeper", "maintenance", "revenue", "sales"]) {
        assert.equal(templates[template].has(key), false, `${template} must not hold ${key}`);
      }
    }
    assert.equal(templates.fnb.has("folio.read"), false);
    assert.equal(templates.fnb.has("tourist_tax.read"), false);
    assert.equal(templates.payroll_hr.has("audit.read"), false);
    assert.equal(templates.housekeeper.has("payables.read"), false);
    // The tourist-tax service checks the same key as the manifest (listRates / listApplicationsForPeriod).
    const touristTaxSource = read("../apps/api/src/modules/tourist-tax/tourist-tax.service.ts");
    assert.equal((touristTaxSource.match(/requirePermissions\(input\.context, \["tourist_tax\.read"\]\)/g) ?? []).length, 2);
  });

  it("cada plantilla de cada token que ve una pantalla que llama al GET (inventario) la tiene, o el hueco es un `sister` justificado", { skip: !existsSync(inventoryPath) && "pilots/screens-inventory.csv not present (CI)" }, () => {
    const inventory = parseCsv(readFileSync(inventoryPath, "utf8"));
    const byKey = new Map(inventory.map((row) => [row.clave, row]));
    let checked = 0;
    for (const expected of READ_GATED_GETS) {
      for (const entry of treeEntries) {
        const routes = readRoutesFor(byKey.get(entry.screenKey), entry.screenKey);
        if (!routes.some((route) => route.method === "GET" && route.path === expected.path)) continue;
        for (const token of entry.roles) {
          for (const template of TOKEN_TEMPLATES[token] ?? []) {
            if (template === "platform") continue;
            checked += 1;
            if (templates[template].has(expected.permission)) continue;
            const pair = { template, permission: expected.permission, screenKey: entry.screenKey };
            assert.ok(JUSTIFIED_GAPS.some((gap) => gap.kind === "sister" && gapCovers(gap, pair)), `${template} (${token}) lacks ${expected.permission} for ${entry.screenKey} (GET ${expected.path}) and no sister justification covers it`);
            assert.ok(sisterTemplates(token, template).some((sister) => templates[sister].has(expected.permission)), `${template}: no sister of ${token} holds ${expected.permission}`);
          }
        }
      }
    }
    assert.ok(checked >= 100, `only ${checked} (screen, token, template) triples checked`);
  });

  it("GET /developer/keyboard-shortcuts está retirado (sin consumidor desde el chrome de L1a)", () => {
    assert.doesNotMatch(serverSource, /app\.get\("\/developer\/keyboard-shortcuts"/);
    assert.equal(manifest.some((entry) => entry.path === "/developer/keyboard-shortcuts"), false);
  });
});

// ---------------------------------------------------------------------------
// GET /users/me
// ---------------------------------------------------------------------------

describe("RBAC × nav · GET /users/me devuelve templateKey por propiedad", () => {
  it("está registrado en server.ts, mapeado en el manifiesto (público para el usuario, low) y permitido durante la rotación de contraseña", () => {
    assert.match(serverSource, /app\.get\("\/users\/me", async \(request\) => getCurrentUserProfile\(request\.userContext\)\)/);
    assert.ok(manifest.some((entry) => entry.method === "GET" && entry.path === "/users/me" && entry.permissions.length === 0), "manifest entry for GET /users/me");
    const allowlist = authContextSource.match(/PASSWORD_CHANGE_ALLOWLIST[^=]*=\s*\[([^\]]+)\]/);
    assert.ok(allowlist && allowlist[1].includes('"/users/me"'));
  });

  it("el perfil expone templateKeys de la propiedad activa y properties[].roles[].templateKey (auth.service)", () => {
    assert.match(authServiceSource, /export async function getCurrentUserProfile\(context: UserContext\): Promise<CurrentUserProfile>/);
    for (const field of ["templateKeys: RoleKey[]", "properties: CurrentUserProperty[]", "roles: CurrentUserPropertyRole[]", "activePropertyId: string", "isPlatformAdmin: boolean", "grantedPermissions: PermissionKey[]"]) {
      assert.ok(authServiceSource.includes(field), `CurrentUserProfile lacks ${field}`);
    }
    assert.match(authServiceSource, /ROLE_TEMPLATE_KEYS as readonly string\[\]\)\.includes\(value\)/, "unknown template_key values must not reach the client");
  });
});

// ---------------------------------------------------------------------------
// reseed-property-roles
// ---------------------------------------------------------------------------

describe("RBAC × nav · reseed-property-roles (deuda L5)", () => {
  it("es idempotente y aditivo: --apply exige --confirm, usa las primitivas de rbac-catalog y nunca borra grants", () => {
    assert.match(reseedSource, /export function parseFlags\(/);
    assert.match(reseedSource, /export async function runReseed\(/);
    assert.match(reseedSource, /--apply requires --confirm/);
    assert.match(reseedSource, /assertConfirmMatches\(flags\)/);
    assert.match(reseedSource, /createRoleFromTemplate\(/);
    assert.match(reseedSource, /applyRoleTemplate\(/);
    assert.match(reseedSource, /ORGANIZATION_TEMPLATE_ROLE_KEYS/);
    assert.doesNotMatch(reseedSource, /rolePermission\.delete/);
    assert.doesNotMatch(reseedSource, /role\.delete/);
    assert.doesNotMatch(reseedSource, /userPropertyRole\.(create|delete|update)/);
    assert.match(reseedSource, /Post-condición/);
  });
});

// ---------------------------------------------------------------------------
// Premisa: el front NO filtra por permiso (hallazgo api-rbac#5)
// ---------------------------------------------------------------------------

describe("RBAC × nav · el front NO filtra por permiso: cada par que falta es un 403 real", () => {
  it("menuCategories recibe tokens y módulos (nunca permisos), Sidebar y ⌘K la llaman así, y el runbook lo documenta", () => {
    assert.match(
      navTreeSource,
      /export function menuCategories\(\s*roleTokens: readonly RoleToken\[\],\s*enabledModules: readonly string\[\],\s*options: MenuModelOptions = \{\},\s*tree: NavTree = NAV_TREE\s*\): MenuCategory\[\]/,
      "menuCategories(roleTokens, enabledModules, options, tree) — no permission parameter"
    );
    const options = navTreeSource.match(/export type MenuModelOptions = \{(.*?)\n\};/s);
    assert.ok(options, "MenuModelOptions not found");
    assert.doesNotMatch(options[1], /permission/i, "MenuModelOptions carries no permission list");
    assert.doesNotMatch(navTreeSource, /grantedPermissions|permissionsAny/, "the tree model never reads permissions");
    // Every call site feeds (tokens, enabled modules, options): no permission list anywhere.
    for (const [name, source] of [["Sidebar.tsx", sidebarSource], ["CommandPalette.tsx", commandPaletteSource]]) {
      const calls = [...source.matchAll(/menuCategories\(([^)]*)\)/g)].map((m) => m[1]);
      assert.ok(calls.length >= 1, `${name}: menuCategories( not called`);
      for (const args of calls) {
        assert.match(args, /^\s*(gate\.)?tokens,\s*gate\.modules\b/, `${name}: menuCategories(${args.trim()}) must take the gate tokens and modules`);
        assert.doesNotMatch(args, /permission/i, `${name}: menuCategories(${args.trim()}) must not receive permissions`);
      }
    }
    assert.match(navRunbookSource, /El árbol NO lleva permiso por ítem/);
  });

  it("role-tokens.ts usa grantedPermissions solo como fallback de roles sin plantilla, no para recortar el menú", () => {
    assert.match(roleTokensSource, /if \(templates\.length === 0 && source\.templatePermissions\) \{\s*const covered = templatesCoveredByPermissions\(source\.grantedPermissions, source\.templatePermissions\);/);
    assert.equal((roleTokensSource.match(/grantedPermissions/g) ?? []).length, 2, "grantedPermissions appears only in the source type and the fallback");
  });
});

// ---------------------------------------------------------------------------
// Cruce CSV × manifiesto × plantillas (solo con el inventario en local)
// ---------------------------------------------------------------------------

describe("RBAC × nav · cada plantilla abre TODAS las rutas GET de lo que ve (§10, ampliado en L1c)", { skip: !existsSync(inventoryPath) && "pilots/screens-inventory.csv not present (CI)" }, () => {
  const inventory = existsSync(inventoryPath) ? parseCsv(readFileSync(inventoryPath, "utf8")) : [];
  const byKey = new Map(inventory.map((row) => [row.clave, row]));

  /** Every (entry, token, template, route, permission) the template lacks. */
  function collectMissingPairs() {
    const missingPairs = [];
    for (const entry of treeEntries) {
      for (const route of readRoutesFor(byKey.get(entry.screenKey), entry.screenKey)) {
        for (const token of entry.roles) {
          for (const template of TOKEN_TEMPLATES[token] ?? []) {
            const held = templates[template];
            assert.ok(held, `template ${template} unparsed`);
            for (const permission of route.permissions) {
              if (!held.has(permission)) missingPairs.push({ screenKey: entry.screenKey, token, template, path: route.path, method: route.method, permission });
            }
          }
        }
      }
    }
    return missingPairs;
  }

  it("el inventario cubre las claves del árbol y la mayoría tiene alguna ruta de lectura mapeada", () => {
    assert.ok(inventory.length >= 200, `only ${inventory.length} inventory rows parsed`);
    const unknown = treeEntries.filter((entry) => !byKey.has(entry.screenKey) && !(entry.screenKey in TREE_ROUTES_FALLBACK)).map((entry) => entry.screenKey);
    assert.deepEqual(unknown, [], `tree screens missing from the inventory: ${unknown.join(", ")}`);
    const withRoute = treeEntries.filter((entry) => readRoutesFor(byKey.get(entry.screenKey), entry.screenKey).length > 0);
    assert.ok(withRoute.length >= treeEntries.length * 0.7, `only ${withRoute.length}/${treeEntries.length} entries with a mapped read route`);
  });

  it("0 pares (plantilla, permiso, pantalla) que faltan fuera de JUSTIFIED_GAPS, sobre todas las rutas GET", () => {
    const unjustified = collectMissingPairs().filter((pair) => !JUSTIFIED_GAPS.some((gap) => gapCovers(gap, pair)));
    assert.deepEqual(
      [...new Set(unjustified.map((pair) => `${pair.template} (${pair.token}) · ${pair.screenKey} · ${pair.method} ${pair.path} → ${pair.permission}`))],
      [],
      "templates cannot open a read route of entries their token sees — add the key to ROLE_PERMISSION_MAP or classify it in JUSTIFIED_GAPS"
    );
  });

  it("ninguna justificación muerta: cada plantilla de cada entrada sigue cubriendo un par real", () => {
    const missingPairs = collectMissingPairs();
    const dead = [];
    for (const gap of JUSTIFIED_GAPS) {
      for (const template of gap.templates) {
        if (!missingPairs.some((pair) => pair.template === template && gapCovers(gap, pair))) dead.push(`${template} → ${gap.permission} (${gap.screens})`);
      }
    }
    assert.deepEqual(dead, [], "JUSTIFIED_GAPS entries no longer cover a real gap — remove the template (or the entry)");
  });

  it("cada justificación está bien formada y su tipo es cierto (write: sin GET; sister: la hermana tiene la clave; pending: nadie la tiene)", () => {
    const missingPairs = collectMissingPairs();
    for (const gap of JUSTIFIED_GAPS) {
      const label = `${gap.templates.join("|")} → ${gap.permission} (${gap.screens})`;
      assert.ok(Array.isArray(gap.templates) && gap.templates.length > 0, `${label}: templates`);
      assert.ok(GAP_KINDS.includes(gap.kind), `${label}: kind ${gap.kind}`);
      assert.ok(typeof gap.evidence === "string" && gap.evidence.length > 20, `${label}: evidence`);
      assert.ok(catalog.has(gap.permission), `${label}: ${gap.permission} not in PERMISSIONS`);
      if (gap.kind === "pending") assert.ok(typeof gap.handoff === "string" && gap.handoff.length > 20, `${label}: pending entries carry a handoff`);
      else if (gap.kind !== "inventory") assert.ok(typeof gap.reason === "string" && gap.reason.length > 20, `${label}: reason`);
      for (const pair of missingPairs.filter((candidate) => gapCovers(gap, candidate))) {
        const sisters = sisterTemplates(pair.token, pair.template);
        const sisterHolds = sisters.some((sister) => templates[sister].has(pair.permission));
        if (gap.kind === "write") assert.notEqual(pair.method, "GET", `${label}: ${pair.screenKey} ${pair.method} ${pair.path} is a read route, not a write action`);
        if (gap.kind === "sister") assert.ok(sisterHolds, `${label}: no sister template of ${pair.token} holds ${pair.permission} — reclassify as pending`);
        if (gap.kind === "pending") assert.equal(sisterHolds, false, `${label}: a sister template of ${pair.token} now holds ${pair.permission} — reclassify as sister`);
      }
    }
  });

  it("ninguna clave de plataforma en entradas de hotel: solo las pantallas admin-only exigen admin.* / platform.*", () => {
    for (const entry of treeEntries) {
      const adminOnly = entry.roles.length === 1 && entry.roles[0] === "admin";
      for (const route of readRoutesFor(byKey.get(entry.screenKey), entry.screenKey)) {
        for (const permission of route.permissions) {
          if (adminOnly) continue;
          assert.ok(!permission.startsWith("admin.") && !permission.startsWith("platform."), `${entry.screenKey}: platform key ${permission} on a hotel entry (${route.path})`);
        }
      }
    }
  });

  it("cada plantilla de cada token abre cada GET de sus entradas: 0 pares `pending` (todo hueco es `sister` o `write` con hermana / sin GET)", () => {
    assert.ok(JUSTIFIED_GAPS.every((gap) => gap.kind !== "pending"), "Tanda 8a closes every pending pair: a new one is a product gap of L0/L2, not a test allowance");
    const uncovered = [];
    for (const pair of collectMissingPairs()) {
      const gap = JUSTIFIED_GAPS.find((candidate) => gapCovers(candidate, pair));
      if (!gap) uncovered.push(`${pair.template} (${pair.token}) · ${pair.screenKey} · ${pair.method} ${pair.path} → ${pair.permission}`);
      else if (gap.kind === "sister") assert.ok(sisterTemplates(pair.token, pair.template).some((sister) => templates[sister].has(pair.permission)), `${pair.template}: sister of ${pair.token} must hold ${pair.permission}`);
      else if (gap.kind === "write") assert.notEqual(pair.method, "GET", `${pair.screenKey} ${pair.method} ${pair.path} is a read route`);
    }
    assert.deepEqual([...new Set(uncovered)], []);
    for (const token of AUTHENTICATED_TOKENS) assert.ok((TOKEN_TEMPLATES[token] ?? []).length > 0, `${token} without template`);
  });

  it("diagnóstico: cuántas entradas, rutas y pares se evalúan (no baja del umbral) y cuántos huecos quedan por tipo", () => {
    let entries = 0;
    let routes = 0;
    let pairs = 0;
    for (const entry of treeEntries) {
      const entryRoutes = readRoutesFor(byKey.get(entry.screenKey), entry.screenKey);
      if (entryRoutes.length === 0) continue;
      entries += 1;
      routes += entryRoutes.length;
      for (const route of entryRoutes) for (const token of entry.roles) pairs += (TOKEN_TEMPLATES[token] ?? []).length * route.permissions.length;
    }
    assert.ok(entries >= 100, `only ${entries} entries with a read route`);
    assert.ok(routes >= 300, `only ${routes} read routes evaluated (L1a/L1b evaluated one per entry)`);
    assert.ok(pairs >= 1000, `only ${pairs} (template, permission) pairs evaluated`);
    const byKind = Object.fromEntries(GAP_KINDS.map((kind) => [kind, 0]));
    for (const pair of collectMissingPairs()) {
      const gap = JUSTIFIED_GAPS.find((candidate) => gapCovers(candidate, pair));
      if (gap) byKind[gap.kind] += 1;
    }
    // Real 403s without a sister template (kind pending) are a product gap, not a test allowance.
    assert.ok(byKind.pending > 0 || JUSTIFIED_GAPS.every((gap) => gap.kind !== "pending"), "pending entries must cover live pairs");
  });
});
