// Contrato RBAC · separación de funciones, plantillas v2 y esquema (Tanda 8a · L0).
//
// Sin TypeScript ni base de datos (mismos parsers por expresión regular que
// tests/rbac-nav-contract.test.mjs): lee packages/shared/src/{permissions,
// types, rbac-types}.ts, packages/database/prisma/schema.prisma y la migración
// 20260918100000_rbac_departamentos y fija lo que docs/design/RBAC-DEPARTAMENTOS.md
// §4.2-§4.7 y §6.1 exigen de los DATOS del control de acceso:
//   - 24 plantillas = ROLE_TEMPLATE_KEYS = etiquetas ES = descripciones = RoleKey;
//   - ORGANIZATION_TEMPLATE_ROLE_KEYS = 22 (todas menos admin y break_glass);
//   - ningún par de SOD_STATIC_PAIRS dentro de una misma plantilla (salvo `except`);
//   - analytics.read y modules.read en todas; break_glass = todo el ámbito org;
//   - ROLE_TEMPLATE_REVOCATIONS[k] ∩ ROLE_PERMISSION_MAP[k] = ∅ y ⊆ PERMISSIONS;
//   - las 27 claves nuevas existen en PERMISSIONS y cada una vive en ≥ 1 plantilla;
//   - nivel, ámbito por defecto y tramo máximo cubren las 24; 7 niveles con rango;
//   - las 10 clases de aprobación tienen clave de aprobación y de solicitud del catálogo;
//   - los enums de rbac-types.ts y de schema.prisma coinciden valor a valor;
//   - las columnas de autor (SoD dinámica) existen en el schema y en la migración,
//     y los dos CHECK de approval_requests están en la migración.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";

const read = (relative) => readFileSync(new URL(relative, import.meta.url), "utf8");
const permissionsSource = read("../packages/shared/src/permissions.ts");
const typesSource = read("../packages/shared/src/types.ts");
const rbacTypesSource = read("../packages/shared/src/rbac-types.ts");
const indexSource = read("../packages/shared/src/index.ts");
const schemaSource = read("../packages/database/prisma/schema.prisma");
const migrationSource = read("../packages/database/prisma/migrations/20260918100000_rbac_departamentos/migration.sql");
const rbacCatalogSource = read("../apps/api/src/lib/rbac-catalog.ts");

// ---------------------------------------------------------------------------
// Parsers (sin TS)
// ---------------------------------------------------------------------------

function stripLineComments(source) {
  return source.replace(/^\s*\/\/.*$/gm, "").replace(/\/\/[^"\n]*$/gm, "");
}

function parsePermissionCatalog(source) {
  const block = source.match(/export const PERMISSIONS[^{]*\{(.*?)\n\};/s);
  assert.ok(block, "PERMISSIONS block not found");
  return [...block[1].matchAll(/^\s*"([a-z_]+(?:\.[a-z_]+)+)":\s*"/gm)].map((m) => m[1]);
}

/** `export const NAME: Record<RoleKey, PermissionKey[]> = { key: [ "a", "b" ], … };` → { key: Set } */
function parseArrayRecord(source, name) {
  const orgKeys = catalog.filter((key) => !key.startsWith("admin.") && !key.startsWith("platform."));
  const block = source.match(new RegExp(`export const ${name}[^{]*\\{(.*?)\\n\\};`, "s"));
  assert.ok(block, `${name} block not found`);
  const body = stripLineComments(block[1]);
  const record = {};
  for (const m of body.matchAll(/^\s*(\w+):\s*\[(.*?)\]/gms)) {
    record[m[1]] = m[2].includes("ORG_PERMISSION_KEYS") ? new Set(orgKeys) : new Set([...m[2].matchAll(/"([^"]+)"/g)].map((k) => k[1]));
  }
  return record;
}

/** `export const NAME: Record<A, B> = { key: "value", … };` → { key: value } (string values). */
function parseStringRecord(source, name) {
  const block = source.match(new RegExp(`export const ${name}[^{]*\\{(.*?)\\n\\};`, "s"));
  assert.ok(block, `${name} block not found`);
  const record = {};
  for (const m of stripLineComments(block[1]).matchAll(/^\s*([A-Za-z_]+):\s*"([^"]+)"/gm)) record[m[1]] = m[2];
  return record;
}

/** `export const NAME: Record<A, number> = { key: 1, … };` → { key: number }. */
function parseNumberRecord(source, name) {
  const block = source.match(new RegExp(`export const ${name}[^{]*\\{(.*?)\\n\\};`, "s"));
  assert.ok(block, `${name} block not found`);
  const record = {};
  for (const m of stripLineComments(block[1]).matchAll(/^\s*([a-z_]+):\s*(\d+)/gm)) record[m[1]] = Number(m[2]);
  return record;
}

/** `export const NAME = [ "a", "b" ] as const;` → ["a", "b"] */
function parseConstArray(source, name) {
  const block = source.match(new RegExp(`export const ${name}[^=]*=\\s*\\[([^\\]]*)\\]`, "s"));
  assert.ok(block, `${name} not found`);
  return [...stripLineComments(block[1]).matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

/** `| "a"\n | "b"` members of a string-literal union type (ends at the first `"…";` line; comments may carry semicolons). */
function parseUnion(source, name) {
  const start = source.indexOf(`export type ${name} =`);
  assert.ok(start >= 0, `type ${name} not found`);
  const lines = source.slice(start).split("\n");
  const members = [];
  for (const line of lines.slice(1)) {
    const code = line.replace(/\/\/.*$/, "");
    const m = code.match(/^\s*\|\s*"([^"]+)"\s*;?\s*$/);
    if (m) members.push(m[1]);
    if (/";\s*$/.test(code)) break;
  }
  return members;
}

/** Prisma `enum Name { a b c }` → ["a", "b", "c"]. */
function parsePrismaEnum(source, name) {
  const block = source.match(new RegExp(`^enum ${name} \\{([^}]*)\\}`, "m"));
  assert.ok(block, `prisma enum ${name} not found`);
  return block[1]
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, "").trim())
    .filter((line) => line.length > 0 && !line.startsWith("///"));
}

/** Prisma `model Name { … }` body. */
function prismaModel(source, name) {
  const block = source.match(new RegExp(`^model ${name} \\{([\\s\\S]*?)^\\}`, "m"));
  assert.ok(block, `prisma model ${name} not found`);
  return block[1];
}

/** SOD_STATIC_PAIRS entries `{ a: "x", b: "y", except: ["controller"] }`. */
function parseSodPairs(source) {
  const block = source.match(/export const SOD_STATIC_PAIRS[^=]*=\s*\[(.*?)\n\];/s);
  assert.ok(block, "SOD_STATIC_PAIRS not found");
  return [...stripLineComments(block[1]).matchAll(/\{\s*a:\s*"([^"]+)",\s*b:\s*"([^"]+)"(?:,\s*except:\s*\[([^\]]*)\])?\s*\}/g)].map((m) => ({
    a: m[1],
    b: m[2],
    except: m[3] ? [...m[3].matchAll(/"([^"]+)"/g)].map((k) => k[1]) : []
  }));
}

const catalog = parsePermissionCatalog(permissionsSource);
const catalogSet = new Set(catalog);
const templates = parseArrayRecord(permissionsSource, "ROLE_PERMISSION_MAP");
const revocations = parseArrayRecord(permissionsSource, "ROLE_TEMPLATE_REVOCATIONS");
const templateKeys = parseConstArray(permissionsSource, "ROLE_TEMPLATE_KEYS");
const orgTemplateKeys = parseConstArray(permissionsSource, "ORGANIZATION_TEMPLATE_ROLE_KEYS");
const labels = parseStringRecord(permissionsSource, "ROLE_TEMPLATE_LABELS_ES");
const descriptions = parseStringRecord(permissionsSource, "ROLE_TEMPLATE_DESCRIPTIONS_ES");
const roleKeyUnion = parseUnion(typesSource, "RoleKey");
const permissionKeyUnion = parseUnion(typesSource, "PermissionKey");
const sodPairs = parseSodPairs(rbacTypesSource);

const NEW_KEYS = [
  "pms.reservation.discount",
  "pms.reservation.override",
  "folio.adjust",
  "folio.adjust_approve",
  "invoice.cancel_request",
  "invoice.cancel_approve",
  "night_audit.run",
  "night_audit.review",
  "night_audit.reopen",
  "housekeeping.read",
  "maintenance.read",
  "maintenance.workorder.create",
  "pos.order.void",
  "payables.read",
  "payables.create",
  "payables.approve",
  "payables.pay",
  "accounting.period.close",
  "payroll.approve",
  "revenue.rates.approve",
  "real_estate.read",
  "real_estate.manage",
  "real_estate.documents.manage",
  "property_tax.manage",
  "users.assign",
  "compliance.read",
  "security.break_glass"
];

const TEMPLATES_24 = [
  "receptionist",
  "night_auditor",
  "front_office_manager",
  "housekeeper",
  "housekeeping_manager",
  "maintenance",
  "maintenance_manager",
  "fnb",
  "fnb_manager",
  "sales",
  "admin_clerk",
  "manager",
  "operations_director",
  "revenue",
  "accountant",
  "controller",
  "payroll_hr",
  "compliance",
  "asset_manager",
  "general_manager",
  "owner",
  "auditor",
  "admin",
  "break_glass"
];

// ---------------------------------------------------------------------------
// Catálogo y plantillas
// ---------------------------------------------------------------------------

describe("RBAC · SoD · catálogo de 254 claves (223 + 27 de §4.6 + 4 documents.* de la Tanda T9)", () => {
  it("PERMISSIONS tiene 254 claves, las mismas que el tipo PermissionKey, y admin.tenants.manage sigue siendo la única de plataforma", () => {
    assert.equal(catalog.length, 254);
    assert.deepEqual([...catalog].sort(), [...permissionKeyUnion].sort());
    assert.deepEqual(catalog.filter((key) => key.startsWith("admin.") || key.startsWith("platform.")), ["admin.tenants.manage"]);
    assert.match(permissionsSource, /export const PLATFORM_PERMISSION_KEYS: readonly PermissionKey\[\] = \["admin\.tenants\.manage"\];/);
  });

  it("las 27 claves nuevas existen en PERMISSIONS y cada una está en al menos una plantilla", () => {
    assert.equal(NEW_KEYS.length, 27);
    for (const key of NEW_KEYS) {
      assert.ok(catalogSet.has(key), `${key} not in PERMISSIONS`);
      assert.ok(permissionKeyUnion.includes(key), `${key} not in PermissionKey`);
      const holders = TEMPLATES_24.filter((template) => templates[template]?.has(key));
      assert.ok(holders.length >= 1, `${key} is held by no template`);
    }
    // The dead capex.approve stays in the catalog until the L6 prune (design §6.5).
    assert.ok(catalogSet.has("capex.approve"));
  });
});

describe("RBAC · SoD · 24 plantillas (§4.2)", () => {
  it("ROLE_PERMISSION_MAP = ROLE_TEMPLATE_KEYS = etiquetas = descripciones = RoleKey = las 24 del diseño", () => {
    assert.deepEqual([...templateKeys].sort(), [...TEMPLATES_24].sort());
    assert.deepEqual(Object.keys(templates).sort(), [...TEMPLATES_24].sort());
    assert.deepEqual(Object.keys(labels).sort(), [...TEMPLATES_24].sort());
    assert.deepEqual(Object.keys(descriptions).sort(), [...TEMPLATES_24].sort());
    assert.deepEqual([...roleKeyUnion].sort(), [...TEMPLATES_24].sort());
    assert.deepEqual(Object.keys(revocations).sort(), [...TEMPLATES_24].sort());
    assert.equal(new Set(templateKeys).size, 24, "no duplicates in ROLE_TEMPLATE_KEYS");
    // «más específico primero»: the 13 new templates before manager / accountant (alias resolution order).
    for (const specific of ["general_manager", "operations_director", "front_office_manager", "housekeeping_manager", "controller", "admin_clerk", "asset_manager"]) {
      assert.ok(templateKeys.indexOf(specific) < templateKeys.indexOf("manager"), `${specific} must precede manager`);
      assert.ok(templateKeys.indexOf(specific) < templateKeys.indexOf("accountant"), `${specific} must precede accountant`);
    }
  });

  it("las etiquetas son las de §4.2, en español y únicas", () => {
    const expected = {
      receptionist: "Recepción",
      night_auditor: "Auditoría nocturna",
      front_office_manager: "Jefatura de recepción",
      housekeeper: "Pisos",
      housekeeping_manager: "Gobernanta",
      maintenance: "Mantenimiento",
      maintenance_manager: "Encargado de mantenimiento",
      fnb: "Punto de venta",
      fnb_manager: "Jefatura de A&B",
      sales: "Comercial",
      admin_clerk: "Administración de hotel",
      manager: "Dirección de hotel",
      operations_director: "Dirección de operaciones",
      revenue: "Revenue corporativo",
      accountant: "Contabilidad",
      controller: "Dirección financiera",
      payroll_hr: "RRHH y nóminas",
      compliance: "Cumplimiento",
      asset_manager: "Gestión del activo",
      general_manager: "Dirección general",
      owner: "Propiedad",
      auditor: "Auditoría interna",
      admin: "Administración de sistema",
      break_glass: "Emergencia"
    };
    assert.deepEqual(labels, expected);
    const lower = Object.values(labels).map((label) => label.toLowerCase());
    assert.equal(new Set(lower).size, lower.length);
    for (const [key, description] of Object.entries(descriptions)) {
      assert.ok(description.length > 30, `${key}: description too short`);
      assert.doesNotMatch(description, /\b(Anfitorio|HotelOS)\b/, `${key}: brand leak`);
    }
    // Every label is an alias of its template in rbac-catalog.ts (resolveTemplateKeyForRoleName checks the labels first).
    assert.match(rbacCatalogSource, /normalizeRoleName\(ROLE_TEMPLATE_LABELS_ES\[key\]\) === normalized/);
    for (const key of TEMPLATES_24) assert.match(rbacCatalogSource, new RegExp(`^\\s*${key}: \\[`, "m"), `ROLE_TEMPLATE_ALIASES lacks ${key}`);
  });

  it("ORGANIZATION_TEMPLATE_ROLE_KEYS = 22, sin admin ni break_glass, en el orden de ROLE_TEMPLATE_KEYS", () => {
    assert.equal(orgTemplateKeys.length, 22);
    assert.equal(orgTemplateKeys.includes("admin"), false);
    assert.equal(orgTemplateKeys.includes("break_glass"), false);
    assert.deepEqual(orgTemplateKeys, templateKeys.filter((key) => key !== "admin" && key !== "break_glass"));
  });

  it("cada plantilla tiene solo claves del catálogo, sin plataforma, sin duplicados, con analytics.read y modules.read", () => {
    for (const key of TEMPLATES_24) {
      const held = templates[key];
      assert.ok(held instanceof Set && held.size > 0, `${key} empty or unparsed`);
      for (const permission of held) {
        assert.ok(catalogSet.has(permission), `${key}: ${permission} not in PERMISSIONS`);
        assert.ok(!permission.startsWith("admin.") && !permission.startsWith("platform."), `${key}: platform key ${permission}`);
      }
      assert.ok(held.has("analytics.read"), `${key} lacks analytics.read (Mi día)`);
      assert.ok(held.has("modules.read"), `${key} lacks modules.read (menu)`);
    }
    // break_glass is the whole org scope (§4.8); owner is strictly smaller; admin holds no money.
    const orgKeys = catalog.filter((key) => key !== "admin.tenants.manage");
    assert.deepEqual([...templates.break_glass].sort(), [...orgKeys].sort());
    assert.match(permissionsSource, /^\s*break_glass: \[\.\.\.ORG_PERMISSION_KEYS\]/m);
    assert.ok(templates.owner.size < orgKeys.length);
    assert.ok(templates.owner.has("payables.approve") && templates.owner.has("asset.capex.approve"));
    for (const key of ["folio.read", "pos.read", "tourist_tax.read", "billing.compliance.view", "guest_register.read"]) assert.ok(templates.owner.has(key), `owner keeps ${key}`);
    for (const key of ["folio.charge.post", "payment.capture", "invoice.issue", "roles.manage", "property.configure", "billing.configure", "payroll.manage"]) {
      assert.equal(templates.owner.has(key), false, `owner (Propiedad) must not hold ${key}`);
    }
    for (const key of ["roles.manage", "permissions.manage", "users.assign", "security.break_glass", "organization.structure.manage"]) assert.ok(templates.admin.has(key), `admin holds ${key}`);
    // Versión 3 (fusión TL): admin conserva solo lectura de reservas y huéspedes (Hoy › Live Timeline); sigue sin dinero ni folio.
    for (const key of catalog.filter((permission) => /^(payables|payment|payments)\./.test(permission) || permission === "accounting.journal.post" || permission === "folio.read")) {
      assert.equal(templates.admin.has(key), false, `admin (Administración de sistema) must not hold ${key}`);
    }
    for (const key of ["pms.reservation.read", "guests.read"]) assert.ok(templates.admin.has(key), `admin holds ${key} (v3, Live Timeline)`);
    assert.ok(templates.general_manager.has("security.break_glass") && templates.general_manager.has("payments.refund_approve"));
  });

  it("revocaciones v2 (v3 y v4 son aditivas): ROLE_TEMPLATE_REVOCATIONS[k] ∩ ROLE_PERMISSION_MAP[k] = ∅ y ⊆ PERMISSIONS; cifras de §6.5", () => {
    assert.match(permissionsSource, /export const ROLE_TEMPLATE_VERSION = 4;/);
    for (const key of TEMPLATES_24) {
      const revoked = revocations[key];
      assert.ok(revoked instanceof Set, `${key} missing from ROLE_TEMPLATE_REVOCATIONS`);
      for (const permission of revoked) {
        assert.ok(catalogSet.has(permission), `${key}: revoked ${permission} not in PERMISSIONS`);
        assert.equal(templates[key].has(permission), false, `${key}: ${permission} is both held and revoked`);
      }
    }
    assert.equal(revocations.manager.size, 16);
    assert.equal(revocations.accountant.size, 6);
    assert.equal(revocations.compliance.size, 4);
    assert.deepEqual([...revocations.sales], ["analytics.export"]);
    assert.deepEqual([...revocations.fnb], ["pos.product.manage"]);
    assert.ok(revocations.owner.size >= 150 && revocations.admin.size >= 150, "owner and admin stop being the whole org scope");
    for (const key of ["receptionist", "housekeeper", "maintenance", "revenue", ...TEMPLATES_24.filter((t) => !["owner", "admin", "manager", "receptionist", "housekeeper", "maintenance", "accountant", "compliance", "revenue", "sales", "fnb"].includes(t))]) {
      assert.equal(revocations[key].size, 0, `${key} loses nothing (or has no previous version)`);
    }
    for (const key of ["payment.capture", "payments.capture", "payment.refund", "invoice.issue", "billing.invoice.issue", "billing.invoice.rectify", "guest_register.export", "assets.manage", "backoffice.access", "roles.manage", "billing.configure", "accounting.configure", "payments.configure", "payroll.manage", "banking.reconcile", "accounting.entity.read"]) {
      assert.ok(revocations.manager.has(key), `manager revokes ${key}`);
    }
    for (const key of ["invoice.cancel", "billing.configure", "folio.charge.post", "audit.read", "commissions.read", "payroll.manage"]) assert.ok(revocations.accountant.has(key), `accountant revokes ${key}`);
    for (const key of ["audit.read", "inventory.read", "pos.read", "commissions.read"]) assert.ok(revocations.compliance.has(key), `compliance revokes ${key}`);
    // The v2 rule replaced «Keep any change additive».
    assert.doesNotMatch(permissionsSource, /Keep any change additive/);
    assert.match(permissionsSource, /rbac:sync --upgrade-templates/);
  });
});

// ---------------------------------------------------------------------------
// Separación de funciones estática (§4.7)
// ---------------------------------------------------------------------------

describe("RBAC · SoD · pares estáticos (§4.7)", () => {
  it("SOD_STATIC_PAIRS contiene los 10 pares del diseño y el par «sistema ≠ finanzas» expandido a claves explícitas", () => {
    assert.ok(sodPairs.length >= 30, `only ${sodPairs.length} pairs parsed`);
    const has = (a, b) => sodPairs.some((pair) => pair.a === a && pair.b === b);
    for (const [a, b] of [
      ["invoice.issue", "invoice.cancel_approve"],
      ["payment.capture", "payments.refund_approve"],
      ["payables.create", "payables.approve"],
      ["payables.approve", "payables.pay"],
      ["accounting.journal.post", "payables.pay"],
      ["banking.reconcile", "payables.pay"],
      ["payroll.manage", "payroll.approve"],
      ["purchase_orders.create", "purchase_orders.approve"],
      ["purchase_orders.receive", "purchase_orders.approve"],
      ["night_audit.run", "night_audit.review"]
    ]) {
      assert.ok(has(a, b), `pair {${a}, ${b}} missing`);
    }
    const money = catalog.filter((key) => /^(payables|payment|payments)\./.test(key) || key === "accounting.journal.post");
    assert.ok(money.length >= 12);
    for (const admin of ["roles.manage", "permissions.manage"]) for (const key of money) assert.ok(has(admin, key), `pair {${admin}, ${key}} missing`);
    for (const pair of sodPairs) {
      assert.ok(catalogSet.has(pair.a) && catalogSet.has(pair.b), `${pair.a} / ${pair.b} not in PERMISSIONS`);
      assert.notEqual(pair.a, pair.b);
      for (const template of pair.except) assert.ok(TEMPLATES_24.includes(template), `except ${template}`);
    }
    const controllerException = sodPairs.find((pair) => pair.a === "payables.approve" && pair.b === "payables.pay");
    assert.deepEqual(controllerException?.except, ["controller"]);
    assert.equal(sodPairs.some((pair) => pair.a === "users.assign" || pair.b === "users.assign"), false, "users.assign stays out of the pairs (§4.7)");
  });

  it("ninguna plantilla contiene los dos lados de un par (salvo except)", () => {
    const violations = [];
    for (const key of TEMPLATES_24) {
      if (key === "break_glass") continue; // whole org scope by construction (§4.8)
      const held = templates[key];
      for (const pair of sodPairs) {
        if (held.has(pair.a) && held.has(pair.b) && !pair.except.includes(key)) violations.push(`${key}: ${pair.a} + ${pair.b}`);
      }
    }
    assert.deepEqual(violations, []);
    // The declared exception is real: controller pays what someone else approved (dynamic SoD).
    assert.ok(templates.controller.has("payables.approve") && templates.controller.has("payables.pay"));
    // Maker ≠ checker on each side of the pairs: issuers never approve cancellations, cashiers never approve refunds.
    const hotelTemplates = TEMPLATES_24.filter((t) => t !== "break_glass");
    for (const key of hotelTemplates.filter((t) => templates[t].has("invoice.issue"))) assert.equal(templates[key].has("invoice.cancel_approve"), false, `${key}: issuer approves cancellations`);
    for (const key of hotelTemplates.filter((t) => templates[t].has("payment.capture"))) assert.equal(templates[key].has("payments.refund_approve"), false, `${key}: cashier approves refunds`);
  });

  it("invariantes negativos de mínimo privilegio que las matrices §4.4/§4.5 respetan", () => {
    const not = (template, keys) => {
      for (const key of keys) assert.equal(templates[template].has(key), false, `${template} must not hold ${key}`);
    };
    const must = (template, keys) => {
      for (const key of keys) assert.ok(templates[template].has(key), `${template} must hold ${key}`);
    };
    not("receptionist", ["backoffice.access", "inventory.read", "accounting.reports.read"]);
    must("receptionist", ["accounting.read", "compliance.read", "categories.read", "pms.reservation.discount", "folio.adjust", "payments.refund_request"]);
    not("manager", ["accounting.journal.post", "payment.capture", "payments.capture", "payment.refund", "invoice.issue", "roles.manage", "payroll.manage", "banking.reconcile"]);
    must("manager", ["invoice.cancel", "payments.refund_approve", "crm.read", "channel_manager.read", "procurement.read", "analytics.export", "configuration.read", "categories.read", "night_audit.reopen", "payables.approve", "users.assign"]);
    not("compliance", ["accounting.journal.post", "folio.charge.post", "billing.configure", "audit.read", "inventory.read", "pos.read", "commissions.read"]);
    must("compliance", ["configuration.read", "integrations.read", "compliance.read"]);
    not("accountant", ["compliance.configure", "compliance.gdpr.manage", "compliance.ses.submit", "invoice.cancel", "payables.approve", "payables.pay", "payroll.manage"]);
    must("accountant", ["configuration.read", "integrations.read", "accounting.journal.post", "payables.create", "night_audit.review", "maintenance.read"]);
    for (const key of ["sales", "fnb"]) not(key, ["property.configure", "roles.manage", "users.invite", "modules.enable", "billing.configure", "payment.refund", "invoice.issue", "accounting.journal.post"]);
    not("sales", ["folio.charge.post", "payment.capture", "folio.read", "pos.read", "tourist_tax.read", "analytics.export"]);
    must("sales", ["categories.read", "crm.read", "groups.read", "channel_manager.read"]);
    not("fnb", ["pms.reservation.create", "folio.read", "tourist_tax.read", "pos.product.manage"]);
    must("fnb", ["pos.order.charge_to_room", "pms.reservation.read", "pos.read"]);
    must("fnb_manager", ["pos.product.manage", "pos.order.void"]);
    for (const key of ["housekeeper", "maintenance", "revenue", "sales"]) not(key, ["folio.read", "pos.read", "tourist_tax.read"]);
    must("housekeeper", ["housekeeping.read"]);
    must("housekeeping_manager", ["housekeeping.read", "rooms.manage", "purchase_orders.create", "purchase_orders.receive"]);
    must("maintenance", ["maintenance.read", "maintenance.workorder.create"]);
    must("maintenance_manager", ["maintenance.read", "capex.create", "real_estate.documents.manage"]);
    must("night_auditor", ["night_audit.run"]);
    not("night_auditor", ["night_audit.review", "night_audit.reopen"]);
    must("front_office_manager", ["pms.reservation.override", "folio.adjust_approve", "payments.refund_approve", "night_audit.run"]);
    not("front_office_manager", ["payment.capture", "payments.capture", "night_audit.review"]);
    must("admin_clerk", ["payables.read", "payables.create", "payment.refund", "night_audit.review", "banking.reconcile", "real_estate.documents.manage"]);
    not("admin_clerk", ["real_estate.manage", "property_tax.manage"]);
    not("admin_clerk", ["payables.approve", "payables.pay", "accounting.journal.post", "night_audit.run"]);
    must("controller", ["payables.approve", "payables.pay", "accounting.period.close", "night_audit.reopen", "invoice.cancel_approve", "payments.refund_approve"]);
    not("controller", ["payables.create", "accounting.journal.post", "banking.reconcile"]);
    must("payroll_hr", ["payroll.manage", "workforce.payroll_export", "pms.reservation.read", "guests.read", "users.read"]); // v3: lectura del Live Timeline · CIERRE-1: users.read (selector «Persona» de la ficha de personal → GET /rbac/users, aditiva sin bump)
    not("payroll_hr", ["payroll.approve", "pms.reservation.create", "guests.manage"]);
    must("operations_director", ["payables.approve", "purchase_orders.approve", "revenue.rates.approve", "payroll.approve", "users.assign", "compliance.read", "housekeeping.read", "maintenance.read"]);
    must("general_manager", ["security.break_glass", "payables.approve", "payroll.approve", "asset.capex.approve", "users.assign"]);
    must("asset_manager", ["real_estate.read", "real_estate.manage", "real_estate.documents.manage", "property_tax.manage", "capex.create", "pms.reservation.read", "guests.read"]); // v3: lectura del Live Timeline
    must("auditor", ["audit.read", "compliance.read", "maintenance.read", "accounting.reports.read", "real_estate.read"]);
    for (const key of ["auditor"]) {
      for (const permission of templates[key]) {
        assert.doesNotMatch(permission, /\.(manage|create|approve|post|issue|cancel|refund|capture|configure|submit|sign|annul|correct|import|apply|rollback|execute)$|_approve$|\.void$|\.pay$|\.run$|\.reopen$|\.review$/, `auditor (solo lectura) holds write key ${permission}`);
      }
    }
    // The 4 templates that lose nothing keep every v1 key (regression guard on the pinned reads of Tanda 5).
    must("receptionist", ["folio.read", "pos.read", "tourist_tax.read", "billing.compliance.view", "guest_register.read", "invoice.read", "incidents.read", "safety_checks.read", "events.read"]);
    must("revenue", ["revenue.manage_rates", "distribution.sync", "channel_manager.manage", "analytics.export", "analytics.ai_ask", "revenue.rates.approve"]);
  });
});

// ---------------------------------------------------------------------------
// rbac-types.ts: niveles, ámbitos, umbrales, aprobaciones, códigos
// ---------------------------------------------------------------------------

describe("RBAC · SoD · rbac-types.ts (niveles, ámbitos, umbrales, aprobaciones)", () => {
  const levels = parseConstArray(rbacTypesSource, "ROLE_LEVELS");
  const scopes = parseConstArray(rbacTypesSource, "SCOPE_TYPES");
  const tiers = parseConstArray(rbacTypesSource, "THRESHOLD_TIERS");
  const rank = parseNumberRecord(rbacTypesSource, "ROLE_LEVEL_RANK");
  const templateLevel = parseStringRecord(rbacTypesSource, "ROLE_TEMPLATE_LEVEL");
  const templateScope = parseStringRecord(rbacTypesSource, "ROLE_TEMPLATE_DEFAULT_SCOPE");
  const templateTier = parseStringRecord(rbacTypesSource, "TEMPLATE_MAX_TIER");
  const levelTier = parseStringRecord(rbacTypesSource, "LEVEL_MAX_TIER");
  const navToken = parseStringRecord(rbacTypesSource, "ROLE_TEMPLATE_NAV_TOKEN");
  const departmentEs = parseStringRecord(rbacTypesSource, "ROLE_TEMPLATE_DEPARTMENT_ES");
  const approvePermission = parseStringRecord(rbacTypesSource, "APPROVAL_KIND_PERMISSION");
  const requestPermission = parseStringRecord(rbacTypesSource, "APPROVAL_KIND_REQUEST_PERMISSION");
  const kinds = parseConstArray(rbacTypesSource, "APPROVAL_KINDS");

  it("está exportado desde index.ts sin colisión de nombres", () => {
    assert.match(indexSource, /export \* from "\.\/rbac-types\.js";/);
    for (const name of ["RoleLevel", "ScopeType", "ThresholdAction", "ApprovalKind", "ApprovalStatus", "ThresholdTier", "AccessDecision", "UserRoleAssignmentDto", "ApprovalRequestDto", "RbacReportDto"]) {
      const declarations = [...permissionsSource.matchAll(new RegExp(`export type ${name}\\b`, "g"))].length + [...typesSource.matchAll(new RegExp(`export type ${name}\\b`, "g"))].length;
      assert.equal(declarations, 0, `${name} declared twice`);
      assert.match(rbacTypesSource, new RegExp(`export type ${name}\\b`), `${name} missing`);
    }
  });

  it("ROLE_LEVEL_RANK cubre los 7 niveles con el orden explícito de «nivel ≤ propio»", () => {
    assert.deepEqual(levels, ["operative", "supervisor", "hotel_director", "operations_director", "general_management", "ownership", "central_admin"]);
    assert.deepEqual(rank, { operative: 1, supervisor: 2, hotel_director: 3, central_admin: 4, operations_director: 4, general_management: 5, ownership: 6 });
    assert.deepEqual(scopes, ["property", "property_group", "legal_entity", "organization"]);
    assert.deepEqual(tiers, ["T1", "T2", "T3", "T4", "ABOVE_T4"]);
    assert.deepEqual(Object.keys(levelTier).sort(), [...levels].sort());
    assert.match(rbacTypesSource, /export function canAssignRoleLevel\(actorLevel: RoleLevel, targetLevel: RoleLevel\): boolean/);
  });

  it("ROLE_TEMPLATE_LEVEL / DEFAULT_SCOPE / TEMPLATE_MAX_TIER / NAV_TOKEN / DEPARTMENT_ES cubren las 24 con valores válidos (§4.2, §4.7)", () => {
    for (const record of [templateLevel, templateScope, templateTier, navToken, departmentEs]) assert.deepEqual(Object.keys(record).sort(), [...TEMPLATES_24].sort());
    for (const key of TEMPLATES_24) {
      assert.ok(levels.includes(templateLevel[key]), `${key}: level ${templateLevel[key]}`);
      assert.ok(scopes.includes(templateScope[key]), `${key}: scope ${templateScope[key]}`);
      assert.ok(tiers.includes(templateTier[key]), `${key}: tier ${templateTier[key]}`);
    }
    assert.deepEqual(
      [templateLevel.receptionist, templateLevel.front_office_manager, templateLevel.manager, templateLevel.operations_director, templateLevel.controller, templateLevel.general_manager, templateLevel.owner, templateLevel.accountant, templateLevel.sales, templateLevel.break_glass],
      ["operative", "supervisor", "hotel_director", "operations_director", "general_management", "general_management", "ownership", "central_admin", "operative", "general_management"]
    );
    assert.deepEqual(
      [templateTier.receptionist, templateTier.front_office_manager, templateTier.manager, templateTier.operations_director, templateTier.controller, templateTier.general_manager, templateTier.owner, templateTier.admin, templateTier.auditor, templateTier.break_glass, templateTier.accountant],
      ["T1", "T2", "T3", "T4", "T4", "ABOVE_T4", "ABOVE_T4", "T1", "T1", "ABOVE_T4", "T1"]
    );
    assert.deepEqual([templateScope.manager, templateScope.operations_director, templateScope.accountant, templateScope.owner, templateScope.revenue], ["property", "property_group", "legal_entity", "organization", "organization"]);
    assert.equal(navToken.admin, "sistemas");
    assert.equal(navToken.owner, "propiedad");
    assert.equal(navToken.manager, "direccion");
    assert.match(rbacTypesSource, /T1: 50,[\s\S]*T2: 300,[\s\S]*T3: 3000,[\s\S]*T4: 15000,[\s\S]*secondApprovalAmount: 60000,[\s\S]*rateBandPct: 15,[\s\S]*discountPctT1: 10,[\s\S]*discountPctT2: 25/);
    assert.match(rbacTypesSource, /currency: "EUR"/);
  });

  it("APPROVAL_KIND_PERMISSION y APPROVAL_KIND_REQUEST_PERMISSION cubren los 10 kinds con claves de PERMISSIONS, y solicitante ≠ aprobador", () => {
    assert.deepEqual(kinds, ["refund", "folio_adjust", "discount", "rate_change", "supplier_bill", "purchase_order", "payroll", "capex", "invoice_cancel", "day_reopen"]);
    assert.deepEqual(Object.keys(approvePermission).sort(), [...kinds].sort());
    assert.deepEqual(Object.keys(requestPermission).sort(), [...kinds].sort());
    for (const kind of kinds) {
      assert.ok(catalogSet.has(approvePermission[kind]), `${kind}: approve key ${approvePermission[kind]} not in PERMISSIONS`);
      assert.ok(catalogSet.has(requestPermission[kind]), `${kind}: request key ${requestPermission[kind]} not in PERMISSIONS`);
      assert.notEqual(approvePermission[kind], requestPermission[kind], `${kind}: maker and checker share a key`);
    }
    assert.deepEqual(approvePermission, {
      refund: "payments.refund_approve",
      folio_adjust: "folio.adjust_approve",
      discount: "pms.reservation.override",
      rate_change: "revenue.rates.approve",
      supplier_bill: "payables.approve",
      purchase_order: "purchase_orders.approve",
      payroll: "payroll.approve",
      capex: "asset.capex.approve",
      invoice_cancel: "invoice.cancel_approve",
      day_reopen: "night_audit.reopen"
    });
    assert.deepEqual(requestPermission, {
      refund: "payments.refund_request",
      folio_adjust: "folio.adjust",
      discount: "pms.reservation.discount",
      rate_change: "revenue.manage_rates",
      supplier_bill: "payables.create",
      purchase_order: "purchase_orders.create",
      payroll: "payroll.manage",
      capex: "capex.create",
      invoice_cancel: "invoice.cancel_request",
      day_reopen: "night_audit.review"
    });
  });

  it("códigos de error y acciones de auditoría de §6.3 / §6.6", () => {
    const errors = parseConstArray(rbacTypesSource, "RBAC_ERROR_CODES");
    const actions = parseConstArray(rbacTypesSource, "RBAC_AUDIT_ACTIONS");
    for (const code of ["RBAC_LEVEL_EXCEEDED", "RBAC_SCOPE_EXCEEDED", "RBAC_SOD_CONFLICT", "RBAC_SELF_ASSIGNMENT", "RBAC_BREAK_GLASS_FORBIDDEN", "APPROVAL_REQUIRED", "APPROVAL_SELF_DECISION", "APPROVAL_EXPIRED", "APPROVAL_MISMATCH", "SUPERVISOR_PIN_INVALID", "SUPERVISOR_PIN_LOCKED", "BREAK_GLASS_ACCOUNT_MISSING", "BREAK_GLASS_REAUTH_REQUIRED", "PAYROLL_NOT_APPROVED"]) {
      assert.ok(errors.includes(code), `error code ${code}`);
    }
    for (const action of ["ACCESS_DENIED", "ROLE_ASSIGNED", "ROLE_REVOKED", "ROLE_TEMPLATE_UPGRADED", "ROLE_PERMISSIONS_EDITED", "USER_DISABLED", "USER_DEPARTMENT_ASSIGNED", "PROPERTY_SWITCHED", "APPROVAL_REQUESTED", "APPROVAL_DECIDED", "APPROVAL_EXPIRED", "SUPERVISOR_AUTHORIZED", "BREAK_GLASS_OPENED", "BREAK_GLASS_CLOSED", "BREAK_GLASS_DRILL", "LOGIN_FAILED", "ACCOUNTING_EXPORTED", "NIGHT_AUDIT_REVIEWED", "NIGHT_AUDIT_REOPENED", "POS_TICKET_VOIDED"]) {
      assert.ok(actions.includes(action), `audit action ${action}`);
    }
    const messages = parseStringRecord(rbacTypesSource, "RBAC_ERROR_MESSAGES_ES");
    assert.deepEqual(Object.keys(messages).sort(), [...errors].sort());
    // rbac-catalog audits the template upgrade with the shared action name.
    assert.match(rbacCatalogSource, /action: "ROLE_TEMPLATE_UPGRADED"/);
    assert.match(rbacCatalogSource, /export async function upgradeRoleTemplate\(/);
    assert.match(rbacCatalogSource, /export async function ensureBreakGlassRole\(/);
    assert.match(rbacCatalogSource, /upgrade\?: boolean;/);
  });
});

// ---------------------------------------------------------------------------
// Esquema y migración (§6.1)
// ---------------------------------------------------------------------------

describe("RBAC · SoD · schema.prisma y migración 20260918100000_rbac_departamentos", () => {
  it("los enums de rbac-types.ts y de schema.prisma coinciden valor a valor, y la migración los crea", () => {
    const pairs = [
      ["RoleLevel", "ROLE_LEVELS"],
      ["ScopeType", "SCOPE_TYPES"],
      ["ThresholdAction", "THRESHOLD_ACTIONS"],
      ["ApprovalKind", "APPROVAL_KINDS"],
      ["ApprovalStatus", "APPROVAL_STATUSES"]
    ];
    for (const [prismaEnum, constName] of pairs) {
      const values = parseConstArray(rbacTypesSource, constName);
      assert.deepEqual(parsePrismaEnum(schemaSource, prismaEnum), values, `enum ${prismaEnum}`);
      assert.match(migrationSource, new RegExp(`^CREATE TYPE "${prismaEnum}" AS ENUM \\(${values.map((v) => `'${v}'`).join(", ")}\\);$`, "m"), `migration creates ${prismaEnum}`);
    }
    assert.equal((migrationSource.match(/^CREATE TYPE "/gm) ?? []).length, 5);
    assert.equal((migrationSource.match(/^CREATE TABLE "/gm) ?? []).length, 7);
  });

  it("Role, Organization, User y UserInvitation ganan las columnas de §6.1 (aditivas)", () => {
    const role = prismaModel(schemaSource, "Role");
    assert.match(role, /level\s+RoleLevel\?/);
    assert.match(role, /department\s+String\?/);
    assert.match(role, /templateVersion Int\s+@default\(0\) @map\("template_version"\)/);
    assert.match(role, /managed\s+Boolean\s+@default\(true\)/);
    assert.match(prismaModel(schemaSource, "Organization"), /rbacVersion Int\s+@default\(0\) @map\("rbac_version"\)/);
    const user = prismaModel(schemaSource, "User");
    for (const column of ['pinHash              String?   @map("pin_hash")', 'pinUpdatedAt         DateTime? @map("pin_updated_at")', 'pinFailedAttempts    Int       @default(0) @map("pin_failed_attempts")', 'pinLockedUntil       DateTime? @map("pin_locked_until")']) {
      assert.ok(user.includes(column), `User lacks ${column}`);
    }
    assert.match(user, /status\s+String\s+@default\("active"\)/, "User.status stays a String (emergency is a new value)");
    const invitation = prismaModel(schemaSource, "UserInvitation");
    assert.match(invitation, /scopeType\s+ScopeType\? @map\("scope_type"\)/);
    assert.match(invitation, /scopeRef\s+String\?\s+@map\("scope_ref"\)/);
    assert.match(invitation, /invitedByUserId String\?\s+@map\("invited_by_user_id"\)/);
    for (const column of ["template_version", "managed", "rbac_version", "pin_hash", "pin_locked_until", "scope_type", "scope_ref", "invited_by_user_id"]) {
      assert.match(migrationSource, new RegExp(`ADD COLUMN\\s+"${column}"`), `migration adds ${column}`);
    }
    assert.match(migrationSource, /^ALTER TABLE "roles" ADD COLUMN\s+"department" TEXT,\nADD COLUMN\s+"level" "RoleLevel",\nADD COLUMN\s+"managed" BOOLEAN NOT NULL DEFAULT true,\nADD COLUMN\s+"template_version" INTEGER NOT NULL DEFAULT 0;$/m);
  });

  it("las columnas de autor (SoD dinámica de L2) existen en el schema y en la migración, todas nullable", () => {
    const expected = {
      Payment: ["captured_by_user_id"],
      Invoice: ["issued_by_user_id", "cancelled_by_user_id"],
      SupplierBill: ["created_by_user_id"],
      NightAuditRun: ["reviewed_by_user_id", "reviewed_at", "reopened_by_user_id", "reopened_at", "reopen_reason_code"],
      PayrollPeriod: ["calculated_by_user_id", "approved_by_user_id", "approved_at"],
      PosOrder: ["voided_at", "voided_by_user_id", "void_reason_code"],
      CapexProject: ["created_by_user_id"]
    };
    const tables = { Payment: "payments", Invoice: "invoices", SupplierBill: "supplier_bills", NightAuditRun: "night_audit_runs", PayrollPeriod: "payroll_periods", PosOrder: "pos_orders", CapexProject: "capex_projects" };
    for (const [model, columns] of Object.entries(expected)) {
      const body = prismaModel(schemaSource, model);
      const alter = migrationSource.match(new RegExp(`^ALTER TABLE "${tables[model]}" ADD COLUMN[\\s\\S]*?;$`, "m"));
      assert.ok(alter, `migration alters ${tables[model]}`);
      for (const column of columns) {
        const field = body.match(new RegExp(`^\\s*(\\w+)\\s+(String|DateTime)\\?\\s+@map\\("${column}"\\)`, "m"));
        assert.ok(field, `${model} lacks nullable column ${column}`);
        assert.match(alter[0], new RegExp(`ADD COLUMN\\s+"${column}" (TEXT|TIMESTAMP\\(3\\))[,;]$`, "m"), `${tables[model]}.${column} added nullable`);
      }
    }
  });

  it("las 7 tablas nuevas existen con sus @@map, uniques e índices, sin claves ajenas", () => {
    const models = {
      PropertyGroup: "property_groups",
      PropertyGroupMember: "property_group_members",
      UserRoleAssignment: "user_role_assignments",
      RoleThreshold: "role_thresholds",
      ApprovalRequest: "approval_requests",
      SupervisorAuthorization: "supervisor_authorizations",
      BreakGlassSession: "break_glass_sessions"
    };
    for (const [model, table] of Object.entries(models)) {
      const body = prismaModel(schemaSource, model);
      assert.ok(body.includes(`@@map("${table}")`), `${model} → ${table}`);
      assert.doesNotMatch(body, /@relation\(/, `${model}: no FK (same convention as the other RBAC tables)`);
      assert.match(migrationSource, new RegExp(`^CREATE TABLE "${table}" \\($`, "m"));
    }
    const assignment = prismaModel(schemaSource, "UserRoleAssignment");
    assert.match(assignment, /@@unique\(\[userId, roleId, scopeType, propertyId, propertyGroupId, legalEntityId\]\)/);
    assert.match(assignment, /@@index\(\[userId, revokedAt\]\)/);
    assert.match(assignment, /@@index\(\[organizationId, scopeType\]\)/);
    assert.match(assignment, /validFrom\s+DateTime\s+@default\(now\(\)\) @map\("valid_from"\)/);
    assert.match(prismaModel(schemaSource, "PropertyGroup"), /@@unique\(\[organizationId, code\]\)/);
    assert.match(prismaModel(schemaSource, "PropertyGroupMember"), /@@unique\(\[propertyGroupId, propertyId\]\)/);
    const threshold = prismaModel(schemaSource, "RoleThreshold");
    assert.match(threshold, /action\s+ThresholdAction/);
    assert.match(threshold, /maxAmount\s+Decimal\?\s+@map\("max_amount"\) @db\.Decimal\(14, 2\)/);
    assert.match(threshold, /maxPct\s+Decimal\?\s+@map\("max_pct"\) @db\.Decimal\(5, 2\)/);
    assert.match(threshold, /@@index\(\[organizationId, action\]\)/);
    const approval = prismaModel(schemaSource, "ApprovalRequest");
    assert.match(approval, /kind\s+ApprovalKind/);
    assert.match(approval, /status\s+ApprovalStatus @default\(pending\)/);
    assert.match(approval, /amount\s+Decimal\?\s+@db\.Decimal\(14, 2\)/);
    assert.match(approval, /@@index\(\[organizationId, status, kind\]\)/);
    assert.match(approval, /@@index\(\[entityType, entityId\]\)/);
    assert.match(prismaModel(schemaSource, "BreakGlassSession"), /sessionId\s+String\?\s+@unique @map\("session_id"\)/);
    assert.match(migrationSource, /CREATE UNIQUE INDEX "user_role_assignments_user_id_role_id_scope_type_property_i_key" ON "user_role_assignments"\("user_id", "role_id", "scope_type", "property_id", "property_group_id", "legal_entity_id"\);/);
    assert.match(migrationSource, /CREATE UNIQUE INDEX "property_groups_organization_id_code_key"/);
    assert.match(migrationSource, /CREATE UNIQUE INDEX "break_glass_sessions_session_id_key"/);
    const ddl = migrationSource.replace(/^--.*$/gm, "");
    assert.doesNotMatch(ddl, /FOREIGN KEY|DROP |CREATE (OR REPLACE )?FUNCTION|CREATE TRIGGER|UPDATE |DELETE |INSERT /, "additive DDL only");
  });

  it("los dos CHECK de approval_requests (nadie decide lo que solicitó; el segundo aprobador es una tercera persona) están en la migración", () => {
    assert.match(
      migrationSource,
      /^ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_no_self_decision" CHECK \("decided_by_user_id" IS NULL OR "decided_by_user_id" <> "requested_by_user_id"\);$/m
    );
    assert.match(
      migrationSource,
      /^ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_no_self_second" CHECK \("second_approver_user_id" IS NULL OR \("second_approver_user_id" <> "requested_by_user_id" AND "second_approver_user_id" <> "decided_by_user_id"\)\);$/m
    );
    assert.match(migrationSource, /^-- 20260918100000_rbac_departamentos · RBAC por departamento, nivel y ámbito \(Tanda 8a · L0\)$/m);
    assert.match(migrationSource, /prisma migrate diff/);
    assert.match(migrationSource, /ADITIVA/);
  });
});
