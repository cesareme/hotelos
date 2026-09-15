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

// Token del CSV → plantillas reales (pilots/tanda5-nav-tree.md §3).
const TOKEN_TEMPLATES = {
  direccion: ["owner", "manager"],
  recepcion: ["receptionist"],
  pisos: ["housekeeper"],
  mantenimiento: ["maintenance"],
  revenue: ["revenue"],
  finanzas: ["accountant", "compliance"],
  comercial: ["sales"],
  fnb: ["fnb"],
  // §3: `admin` es el administrador de PLATAFORMA (Local Super Admin: catálogo
  // completo, clave admin.tenants.manage incluida, backfillTemplateRoles), no
  // la plantilla de organización `admin`. Se modela como pseudo-plantilla
  // "platform" = todo el catálogo; la plantilla org `admin` se comprueba aparte.
  admin: ["platform"],
  publico: []
};

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
  // --- write -------------------------------------------------------------
  {
    // Finanzas (2026-09-16, FIN-17): the import is gated by banking.reconcile
    // (manager and accountant hold it); compliance only consults.
    templates: ["compliance"],
    permission: "banking.reconcile",
    screens: /^BankingSpain$/,
    kind: "write",
    evidence: "bankingApi.importCsb43 → POST /properties/:p/banking/csb43/import [banking.reconcile]; la pestaña no tiene GET mapeado en el inventario",
    reason: "importar extractos CSB43 y conciliar es de Contabilidad y Dirección (banking.reconcile); Cumplimiento consulta"
  },
  // --- sister (token finanzas) --------------------------------------------
  {
    templates: ["accountant"],
    permission: "compliance.configure",
    screens: /^(ComplianceCenter|EsrsReport|PropertyTaxesScreen|TaxComplianceSettings|TbaiForal)$/,
    kind: "sister",
    evidence:
      "ComplianceCenterScreen.tsx useApiData(/compliance/properties/:p/center) · esrsApi.fetchIndicators (GET /organizations/:orgId/esrs/:year/indicators) · taxesApi.fetchPropertyTaxes (GET /backoffice/properties/:p/taxes, desde PropertyTaxesScreen y TaxComplianceSettings; el inventario lista center/tasks/documents para esta última, que no llama) · tbaiApi.verifyChain (GET …/tbai/chain/:territory/verify al pulsar «Verificar cadena»)",
    reason: "configurar cumplimiento (SES, impuestos, ESRS, TicketBAI) es de la plantilla compliance del mismo token finanzas; un contable que trabaje solo necesita también el rol Cumplimiento (L2: claves de lectura para estos GET, informe L1b)"
  },
  {
    templates: ["accountant"],
    permission: "compliance.gdpr.manage",
    screens: /^GdprRequestsScreen$/,
    kind: "sister",
    evidence: "GdprRequestsScreen.tsx useApiData(\"/gdpr/requests\") → GET /gdpr/requests [compliance.gdpr.manage]",
    reason: "las solicitudes RGPD (borrado, DSAR) las gestiona compliance; un contable no borra huéspedes"
  },
  {
    templates: ["compliance"],
    permission: "banking.read",
    screens: /^BankReconciliationScreen$/,
    kind: "sister",
    evidence: "BankReconciliationScreen.tsx useApiData(\"/banking/accounts\") → GET /banking/accounts [banking.read]; accountant y manager la tienen",
    reason: "cuentas y extractos bancarios son de Contabilidad; Cumplimiento consulta la conciliación con el segundo rol"
  },
  {
    templates: ["compliance"],
    permission: "payroll.read",
    screens: /^PayrollScreen$/,
    kind: "sister",
    evidence: "PayrollScreen.tsx useApiData(\"/payroll/contracts\") y (\"/payroll/periods\") → GET [payroll.read]; accountant y manager la tienen",
    reason: "nóminas son de Contabilidad (y de Dirección); un responsable de cumplimiento no las consulta"
  },
  {
    templates: ["compliance"],
    permission: "accounting.configure",
    screens: /^AccountingSettings$/,
    kind: "sister",
    evidence: "AccountingSettings.tsx fetchAccountingSettings → GET /backoffice/properties/:p/accounting-settings [accounting.configure]",
    reason: "plan contable, centros de coste y periodos son de Contabilidad (accountant la tiene)"
  },
  {
    templates: ["compliance"],
    permission: "billing.configure",
    screens: /^BillingSettings$/,
    kind: "sister",
    evidence: "BillingSettings.tsx fetchBillingSettings → GET /backoffice/properties/:p/billing-settings [billing.configure]",
    reason: "series de factura y numeración son de Contabilidad (accountant la tiene)"
  },
  // --- pending (403 real sin plantilla hermana) ---------------------------
  {
    templates: ["manager"],
    permission: "configuration.read",
    screens:
      /^(SetupCenterScreen|AiPropertySetupForm|BuildingSetupForm|CustomFieldSetupForm|DepartmentSetupForm|FinanceComplianceSetupForm|FloorSetupForm|HousekeepingSetupForm|MaintenanceSetupForm|PropertyProfileSetupForm|RevenueCategorySetupForm|RoomSetupForm|RoomTypeSetupForm|SpaceResourceSetupForm|ZoneSetupForm)$/,
    kind: "pending",
    evidence:
      "SetupCenterScreen.tsx fetchManualSetupOptions → GET /backoffice/properties/:p/manual-setup/options; PropertySetupForms.tsx fetchPropertySetupForm → GET …/property-setup/forms/:formCode; ambos [configuration.read], que solo tienen owner y admin (403 verificado en :3400 con un token sin la clave)",
    handoff: "añadir configuration.read (y categories.read: fetchConfigurationCategories en Categorías y Nueva reserva) a manager en ROLE_PERMISSION_MAP; hoy un director sin rol Propietario no abre Configuración → Puesta en marcha ni ningún formulario de alta"
  },
  {
    templates: ["accountant", "compliance"],
    permission: "configuration.read",
    screens: /^(FinanceComplianceSetupForm|RevenueCategorySetupForm)$/,
    kind: "pending",
    evidence: "PropertySetupForms.tsx fetchPropertySetupForm → GET /backoffice/properties/:p/property-setup/forms/:formCode [configuration.read]; ni accountant ni compliance la tienen",
    handoff: "configuration.read en accountant y compliance (las dos pestañas Perfil inicial y Categorías de ingresos de Contabilidad y fiscal) o quitar finanzas de esas filas del CSV"
  },
  {
    templates: ["accountant", "compliance"],
    permission: "integrations.read",
    screens: /^PaymentSettings$/,
    kind: "pending",
    evidence: "PaymentSettings.tsx fetchPropertyIntegrations → GET /backoffice/properties/:p/integrations [integrations.read]; ni accountant ni compliance la tienen",
    handoff: "integrations.read en accountant y compliance: la pestaña Pagos solo lista pasarelas de cobro (o quitar finanzas de la fila del CSV)"
  },
  {
    templates: ["manager", "receptionist", "sales"],
    permission: "categories.read",
    screens: /^ReservationCreate$/,
    kind: "pending",
    evidence: "ReservationCreateScreen.tsx fetchConfigurationCategories → GET /backoffice/properties/:p/configuration/categories [categories.read], que solo tienen owner y admin (403 verificado con recepcion.tilos en :3400); el catch es opcional y los selectores caen a sus valores locales sin avisar",
    handoff: "categories.read en manager, receptionist y sales (Nueva reserva solo lee los códigos de origen/segmento) o que el formulario no dependa de la configuración de categorías"
  },
  {
    templates: ["fnb"],
    permission: "pms.reservation.read",
    screens: /^FrontDeskDashboard$/,
    kind: "pending",
    evidence: "FrontDeskDashboard.tsx probeHasRows(fetchRooms / fetchRoomTypes) → GET /properties/:p/rooms y /room-types [pms.reservation.read]; el catch traga el 403 y la comprobación de datos queda en «desconocido» (maintenance ya la recibió en L1c api)",
    handoff: "pms.reservation.read en fnb, o que Mi día no sondee inventario de habitaciones para tokens sin recepción"
  },
  // --- inventory (la pantalla no llama a la ruta atribuida) ---------------
  {
    templates: ["accountant", "compliance"],
    permission: "integrations.read",
    screens: /^(AccountingSettings|BillingSettings)$/,
    kind: "inventory",
    evidence: "solo PaymentSettings.tsx llama a fetchPropertyIntegrations (GET …/integrations); AccountingSettings y BillingSettings no"
  },
  {
    templates: ["compliance"],
    permission: "accounting.configure",
    screens: /^(BillingSettings|PaymentSettings)$/,
    kind: "inventory",
    evidence: "fetchAccountingSettings solo se llama desde AccountingSettings.tsx"
  },
  {
    templates: ["compliance"],
    permission: "billing.configure",
    screens: /^(AccountingSettings|PaymentSettings)$/,
    kind: "inventory",
    evidence: "fetchBillingSettings solo se llama desde BillingSettings.tsx"
  },
  {
    templates: ["manager"],
    permission: "configuration.read",
    screens: /^(CategoryManagerScreen|CategoryDetailScreen|CategoryOptionForm)$/,
    kind: "inventory",
    evidence: "llaman a fetchConfigurationCategories / fetchConfigurationCategory (GET …/configuration/categories [categories.read], que manager tampoco tiene: ver handoff de configuration.read) o a un POST; ninguna llama a manual-setup ni property-setup (el inventario copia la fila de Puesta en marcha)"
  }
];

const GAP_KINDS = ["write", "sister", "pending", "inventory"];

/** A justification covers a pair when template, permission and screen match. */
function gapCovers(gap, pair) {
  return gap.templates.includes(pair.template) && gap.permission === pair.permission && gap.screens.test(pair.screenKey);
}

/** Sister templates of a token: the other templates that serve it; owner/platform hold the whole catalogue and do not count. */
function sisterTemplates(token, template) {
  return (TOKEN_TEMPLATES[token] ?? []).filter((candidate) => candidate !== template && candidate !== "owner" && candidate !== "platform");
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
function readRoutesFor(row) {
  const paths = row.api_paths_principales.split(/\s+/).filter((p) => p.startsWith("/"));
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
  it("ROLE_TEMPLATE_KEYS incluye sales y fnb, el tipo RoleKey también, y cada plantilla tiene claves del catálogo", () => {
    assert.ok(templateKeys.includes("sales"), "sales missing from ROLE_TEMPLATE_KEYS");
    assert.ok(templateKeys.includes("fnb"), "fnb missing from ROLE_TEMPLATE_KEYS");
    assert.match(typesSource, /\|\s*"sales"/);
    assert.match(typesSource, /\|\s*"fnb"/);
    for (const key of templateKeys) {
      assert.ok(templates[key] instanceof Set && templates[key].size > 0, `template ${key} empty or unparsed`);
      for (const permission of templates[key]) assert.ok(catalog.has(permission), `${key}: ${permission} not in PERMISSIONS`);
    }
  });

  it("las plantillas del catálogo y las del front (role-tokens.ts) son el mismo conjunto", () => {
    const front = [...roleTokensSource.matchAll(/^\s*([a-z_]+):\s*"(?:direccion|recepcion|pisos|mantenimiento|revenue|finanzas|comercial|fnb|admin)"/gm)].map((m) => m[1]);
    assert.deepEqual([...front].sort(), [...templateKeys].sort());
    for (const token of Object.keys(TOKEN_TEMPLATES)) {
      for (const template of TOKEN_TEMPLATES[token]) assert.ok(template === "platform" || templateKeys.includes(template), `${token} → ${template} unknown`);
    }
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

  it("etiquetas ES y lista de plantillas por organización (reseed) cubren el catálogo; admin queda fuera", () => {
    const labels = parseRecordKeys(permissionsSource, "ROLE_TEMPLATE_LABELS_ES");
    const descriptions = parseRecordKeys(permissionsSource, "ROLE_TEMPLATE_DESCRIPTIONS_ES");
    assert.deepEqual([...labels].sort(), [...templateKeys].sort());
    assert.deepEqual([...descriptions].sort(), [...templateKeys].sort());
    const orgBlock = permissionsSource.match(/export const ORGANIZATION_TEMPLATE_ROLE_KEYS[^=]*=\s*\[([^\]]+)\]/);
    assert.ok(orgBlock);
    const orgTemplates = [...orgBlock[1].matchAll(/"([a-z_]+)"/g)].map((k) => k[1]);
    assert.equal(orgTemplates.includes("admin"), false);
    assert.deepEqual([...orgTemplates].sort(), templateKeys.filter((k) => k !== "admin").sort());
    for (const key of ["sales", "fnb"]) assert.match(rbacCatalogSource, new RegExp(`^\\s*${key}: \\[`, "m"), `ROLE_TEMPLATE_ALIASES lacks ${key}`);
  });
});

// ---------------------------------------------------------------------------
// Claves de lectura de los GET (Tanda 5 · L1b · api-side)
// ---------------------------------------------------------------------------

// GET que en L1a estaban gateados por claves de escritura → clave de lectura y
// plantillas que la tienen (las de los tokens que ven la pantalla en el árbol).
const READ_GATED_GETS = [
  { path: "/folios/:id/balance", permission: "folio.read", templates: ["manager", "receptionist", "accountant", "compliance"] },
  { path: "/reservations/:id/folios", permission: "folio.read", templates: ["manager", "receptionist", "accountant", "compliance"] },
  { path: "/reservations/:id/routing-rules", permission: "folio.read", templates: ["manager", "receptionist", "accountant", "compliance"] },
  { path: "/tourist-tax/rates", permission: "tourist_tax.read", templates: ["manager", "receptionist", "accountant", "compliance"] },
  { path: "/properties/:propertyId/tourist-tax/applications", permission: "tourist_tax.read", templates: ["manager", "receptionist", "accountant", "compliance"] },
  { path: "/properties/:propertyId/pos/outlets", permission: "pos.read", templates: ["fnb", "manager", "receptionist", "accountant", "compliance"] },
  { path: "/properties/:propertyId/pos/tickets", permission: "pos.read", templates: ["fnb", "manager", "receptionist", "accountant", "compliance"] },
  { path: "/properties/:propertyId/pos/cash-summary", permission: "pos.read", templates: ["fnb", "manager", "receptionist", "accountant", "compliance"] },
  { path: "/properties/:propertyId/verifactu/submissions", permission: "billing.compliance.view", templates: ["manager", "receptionist", "accountant", "compliance"] },
  { path: "/verifactu/submissions/:id", permission: "billing.compliance.view", templates: ["manager", "receptionist", "accountant", "compliance"] },
  { path: "/invoices/:id/verifactu", permission: "billing.compliance.view", templates: ["manager", "receptionist", "accountant", "compliance"] },
  { path: "/properties/:propertyId/tbai/submissions", permission: "billing.compliance.view", templates: ["manager", "receptionist", "accountant", "compliance"] },
  { path: "/tbai/submissions/:id", permission: "billing.compliance.view", templates: ["manager", "receptionist", "accountant", "compliance"] },
  { path: "/properties/:propertyId/igic/submissions", permission: "billing.compliance.view", templates: ["manager", "receptionist", "accountant", "compliance"] },
  { path: "/igic/submissions/:id", permission: "billing.compliance.view", templates: ["manager", "receptionist", "accountant", "compliance"] },
  { path: "/properties/:propertyId/guest-register-records", permission: "guest_register.read", templates: ["manager", "receptionist", "accountant", "compliance"] },
  { path: "/properties/:propertyId/compliance/inbox", permission: "guest_register.read", templates: ["manager", "receptionist", "accountant", "compliance"] },
  { path: "/ses/submissions/:id", permission: "guest_register.read", templates: ["manager", "receptionist", "accountant", "compliance"] },
  { path: "/properties/:propertyId/ses-hospedajes/submissions", permission: "guest_register.read", templates: ["manager", "receptionist", "accountant", "compliance"] }
];

describe("RBAC × nav · los GET de folios, TPV, tasa turística, VeriFactu y registro de viajeros llevan claves de lectura (L1b)", () => {
  it("cada GET exige exactamente su clave de lectura y ninguna de escritura", () => {
    for (const expected of READ_GATED_GETS) {
      const entry = manifest.find((candidate) => candidate.method === "GET" && candidate.path === expected.path);
      assert.ok(entry, `manifest entry for GET ${expected.path}`);
      assert.deepEqual(entry.permissions, [expected.permission], `GET ${expected.path}`);
    }
    const writeGated = manifest.filter(
      (entry) => entry.method === "GET" && entry.permissions.some((key) => key === "folio.charge.post" || key === "compliance.ses.submit")
    );
    assert.deepEqual(writeGated.map((entry) => entry.path), [], "no GET is gated by folio.charge.post or compliance.ses.submit any more");
  });

  it("las claves nuevas existen en el catálogo y cada plantilla del token que ve la pantalla las tiene", () => {
    for (const key of ["folio.read", "pos.read", "tourist_tax.read"]) assert.ok(catalog.has(key), `${key} not in PERMISSIONS`);
    for (const expected of READ_GATED_GETS) {
      for (const template of expected.templates) {
        assert.ok(templates[template].has(expected.permission), `${template} lacks ${expected.permission} (GET ${expected.path})`);
      }
      assert.ok(templates.owner.has(expected.permission));
    }
    // Least privilege: read keys do not leak to templates whose token never sees the screen.
    for (const key of ["folio.read", "pos.read", "tourist_tax.read"]) {
      for (const template of ["housekeeper", "maintenance", "revenue", "sales"]) {
        assert.equal(templates[template].has(key), false, `${template} must not hold ${key}`);
      }
    }
    assert.equal(templates.fnb.has("folio.read"), false);
    assert.equal(templates.fnb.has("tourist_tax.read"), false);
    // The tourist-tax service checks the same key as the manifest (listRates / listApplicationsForPeriod).
    const touristTaxSource = read("../apps/api/src/modules/tourist-tax/tourist-tax.service.ts");
    assert.equal((touristTaxSource.match(/requirePermissions\(input\.context, \["tourist_tax\.read"\]\)/g) ?? []).length, 2);
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
      for (const route of readRoutesFor(byKey.get(entry.screenKey))) {
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
    const unknown = treeEntries.filter((entry) => !byKey.has(entry.screenKey)).map((entry) => entry.screenKey);
    assert.deepEqual(unknown, [], `tree screens missing from the inventory: ${unknown.join(", ")}`);
    const withRoute = treeEntries.filter((entry) => readRoutesFor(byKey.get(entry.screenKey)).length > 0);
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

  it("owner (y la plantilla org admin) abren todo lo que ve direccion; solo las pantallas admin-only exigen la clave de plataforma", () => {
    for (const entry of treeEntries) {
      const adminOnly = entry.roles.length === 1 && entry.roles[0] === "admin";
      for (const route of readRoutesFor(byKey.get(entry.screenKey))) {
        for (const permission of route.permissions) {
          if (adminOnly) continue;
          assert.ok(templates.owner.has(permission), `${entry.screenKey}: owner lacks ${permission} (${route.path})`);
          assert.ok(templates.admin.has(permission), `${entry.screenKey}: org admin lacks ${permission} (${route.path})`);
          assert.ok(!permission.startsWith("admin.") && !permission.startsWith("platform."), `${entry.screenKey}: platform key ${permission} on a hotel entry`);
        }
      }
    }
  });

  it("diagnóstico: cuántas entradas, rutas y pares se evalúan (no baja del umbral) y cuántos huecos quedan por tipo", () => {
    let entries = 0;
    let routes = 0;
    let pairs = 0;
    for (const entry of treeEntries) {
      const entryRoutes = readRoutesFor(byKey.get(entry.screenKey));
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
