// Unit tests for lib/rbac-catalog.ts (Tanda 4 · AUTH-07 second half).
// No database: template/manifest invariants are pure, and the store-backed
// functions run against an in-memory fake of the Prisma subset they use.
// Run from apps/api with
//   node --import tsx --test src/lib/__tests__/rbac-catalog.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ORGANIZATION_TEMPLATE_ROLE_KEYS,
  ORG_PERMISSION_KEYS,
  PERMISSIONS,
  PLATFORM_PERMISSION_KEYS,
  ROLE_PERMISSION_MAP,
  ROLE_TEMPLATE_DESCRIPTIONS_ES,
  ROLE_TEMPLATE_KEYS,
  ROLE_TEMPLATE_LABELS_ES,
  ROLE_TEMPLATE_LEVEL,
  ROLE_TEMPLATE_REVOCATIONS,
  ROLE_TEMPLATE_VERSION,
  SOD_STATIC_PAIRS,
  isPlatformPermission,
  type PermissionKey,
  type RoleKey
} from "@hotelos/shared";
import { routePermissionManifest } from "../../security/route-permissions.js";
import {
  DEFAULT_TENANT_ROLE_TEMPLATES,
  ROLE_WITHOUT_PERMISSIONS_CODE,
  ROLE_WITHOUT_PERMISSIONS_MESSAGE,
  applyRoleTemplate,
  assertTemplatesExcludePlatformKeys,
  backfillTemplateRoles,
  createRoleFromTemplate,
  ensureBreakGlassRole,
  ensureRoleHasPermissions,
  isPlatformRoleName,
  isRoleTemplateKey,
  provisionDefaultTemplateRoles,
  resolveTemplateKeyForRoleName,
  syncPermissionCatalog,
  templatePermissionKeys,
  templateRevocationKeys,
  upgradeRoleTemplate,
  type RbacDb
} from "../rbac-catalog.js";
import { formatHuman, parseFlags } from "../../scripts/rbac-sync.js";
import { BadRequestError, ConflictError, NotFoundError } from "../http-error.js";

// ---------------------------------------------------------------------------
// In-memory fake of the Prisma subset rbac-catalog.ts uses
// ---------------------------------------------------------------------------

type RoleRow = {
  id: string;
  organizationId: string;
  name: string;
  templateKey: string | null;
  // Tanda 8a columns (optional in fixtures: a missing value behaves like the DB default).
  level?: string | null;
  department?: string | null;
  templateVersion?: number;
  managed?: boolean;
};
type PermissionRow = { id: string; key: string; description: string };
type GrantRow = { id: string; roleId: string; permissionId: string };

type Filter = unknown;

function matchScalar(value: string | null, filter: Filter): boolean {
  if (filter === undefined) return true;
  if (filter === null) return value === null;
  if (typeof filter === "string") return value === filter;
  const f = filter as { in?: string[]; equals?: string; mode?: string };
  if (Array.isArray(f.in)) return value !== null && f.in.includes(value);
  if (typeof f.equals === "string") {
    if (value === null) return false;
    return f.mode === "insensitive" ? value.toLowerCase() === f.equals.toLowerCase() : value === f.equals;
  }
  throw new Error(`fake db: unsupported filter ${JSON.stringify(filter)}`);
}

function pick<T extends object>(row: T, select: Record<string, boolean> | undefined): Partial<T> {
  if (!select) return { ...row };
  const out: Partial<T> = {};
  for (const key of Object.keys(select) as Array<keyof T>) {
    if (select[key as string]) out[key] = row[key];
  }
  return out;
}

type FakeSeed = {
  roles?: RoleRow[];
  /** Catalog keys present in `permissions` (defaults to the full PERMISSIONS catalog). */
  permissionKeys?: string[];
  /** [roleId, permission key] pairs. */
  grants?: Array<[string, string]>;
};

function createFakeDb(seed: FakeSeed = {}) {
  let seq = 0;
  const nextId = (prefix: string) => `${prefix}_${++seq}`;
  const roles: RoleRow[] = (seed.roles ?? []).map((row) => ({ ...row }));
  const permissionKeys = seed.permissionKeys ?? Object.keys(PERMISSIONS);
  const permissions: PermissionRow[] = permissionKeys.map((key) => ({
    id: `perm:${key}`,
    key,
    description: (PERMISSIONS as Record<string, string>)[key] ?? `legacy ${key}`
  }));
  const grants: GrantRow[] = [];
  for (const [roleId, key] of seed.grants ?? []) {
    const permission = permissions.find((row) => row.key === key);
    if (!permission) throw new Error(`fake db seed: unknown permission ${key}`);
    grants.push({ id: nextId("rp"), roleId, permissionId: permission.id });
  }

  const roleWhere = (row: RoleRow, where: Record<string, unknown> = {}): boolean => {
    const compound = where.organizationId_name as { organizationId: string; name: string } | undefined;
    if (compound) return row.organizationId === compound.organizationId && row.name === compound.name;
    return (
      matchScalar(row.id, where.id) &&
      matchScalar(row.organizationId, where.organizationId) &&
      matchScalar(row.name, where.name) &&
      (where.templateKey === undefined || row.templateKey === where.templateKey) &&
      (where.level === undefined || (row.level ?? null) === where.level) &&
      (where.department === undefined || (row.department ?? null) === where.department) &&
      (where.managed === undefined || (row.managed ?? true) === where.managed)
    );
  };
  const grantWhere = (row: GrantRow, where: Record<string, unknown> = {}): boolean =>
    matchScalar(row.roleId, where.roleId) && matchScalar(row.permissionId, where.permissionId);
  const permissionWhere = (row: PermissionRow, where: Record<string, unknown> = {}): boolean => {
    const not = where.NOT as { description?: string } | undefined;
    return (
      matchScalar(row.id, where.id) &&
      matchScalar(row.key, where.key) &&
      (not?.description === undefined || row.description !== not.description)
    );
  };

  const db = {
    role: {
      findMany: async (args: { select?: Record<string, boolean>; where?: Record<string, unknown>; orderBy?: unknown } = {}) =>
        roles
          .filter((row) => roleWhere(row, args.where))
          .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
          .map((row) => pick(row, args.select)),
      findUnique: async (args: { where: Record<string, unknown>; select?: Record<string, boolean> }) => {
        const row = roles.find((candidate) => roleWhere(candidate, args.where));
        return row ? pick(row, args.select) : null;
      },
      findFirst: async (args: { where: Record<string, unknown>; select?: Record<string, boolean> }) => {
        const row = roles.find((candidate) => roleWhere(candidate, args.where));
        return row ? pick(row, args.select) : null;
      },
      create: async (args: {
        data: { organizationId: string; name: string; templateKey?: string | null; level?: string | null; department?: string | null; templateVersion?: number; managed?: boolean };
        select?: Record<string, boolean>;
      }) => {
        if (roles.some((row) => row.organizationId === args.data.organizationId && row.name === args.data.name)) {
          throw Object.assign(new Error("Unique constraint failed on the fields: (`organization_id`,`name`)"), { code: "P2002" });
        }
        const row: RoleRow = {
          id: nextId("role"),
          organizationId: args.data.organizationId,
          name: args.data.name,
          templateKey: args.data.templateKey ?? null,
          level: args.data.level ?? null,
          department: args.data.department ?? null,
          templateVersion: args.data.templateVersion ?? 0,
          managed: args.data.managed ?? true
        };
        roles.push(row);
        return pick(row, args.select);
      },
      updateMany: async (args: { where: Record<string, unknown>; data: Partial<RoleRow> }) => {
        let count = 0;
        for (const row of roles) {
          if (roleWhere(row, args.where)) {
            Object.assign(row, args.data);
            count += 1;
          }
        }
        return { count };
      }
    },
    permission: {
      findMany: async (args: { where?: Record<string, unknown>; select?: Record<string, boolean> } = {}) =>
        permissions.filter((row) => permissionWhere(row, args.where)).map((row) => pick(row, args.select)),
      createMany: async (args: { data: Array<{ key: string; description: string }>; skipDuplicates?: boolean }) => {
        let count = 0;
        for (const data of args.data) {
          if (permissions.some((row) => row.key === data.key)) {
            if (args.skipDuplicates) continue;
            throw Object.assign(new Error("Unique constraint failed on the fields: (`key`)"), { code: "P2002" });
          }
          permissions.push({ id: `perm:${data.key}`, key: data.key, description: data.description });
          count += 1;
        }
        return { count };
      },
      updateMany: async (args: { where: Record<string, unknown>; data: Partial<PermissionRow> }) => {
        let count = 0;
        for (const row of permissions) {
          if (permissionWhere(row, args.where)) {
            Object.assign(row, args.data);
            count += 1;
          }
        }
        return { count };
      },
      deleteMany: async (args: { where: Record<string, unknown> }) => {
        const before = permissions.length;
        for (let index = permissions.length - 1; index >= 0; index -= 1) {
          if (permissionWhere(permissions[index], args.where)) permissions.splice(index, 1);
        }
        return { count: before - permissions.length };
      }
    },
    rolePermission: {
      findMany: async (args: { where?: Record<string, unknown>; select?: Record<string, boolean> } = {}) =>
        grants.filter((row) => grantWhere(row, args.where)).map((row) => pick(row, args.select)),
      count: async (args: { where?: Record<string, unknown> } = {}) => grants.filter((row) => grantWhere(row, args.where)).length,
      createMany: async (args: { data: Array<{ roleId: string; permissionId: string }>; skipDuplicates?: boolean }) => {
        let count = 0;
        for (const data of args.data) {
          if (grants.some((row) => row.roleId === data.roleId && row.permissionId === data.permissionId)) {
            if (args.skipDuplicates) continue;
            throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
          }
          grants.push({ id: nextId("rp"), roleId: data.roleId, permissionId: data.permissionId });
          count += 1;
        }
        return { count };
      },
      groupBy: async (args: { by: string[]; where?: Record<string, unknown> }) => {
        const counts = new Map<string, number>();
        for (const row of grants) {
          if (grantWhere(row, args.where)) counts.set(row.roleId, (counts.get(row.roleId) ?? 0) + 1);
        }
        return Array.from(counts.entries()).map(([roleId, n]) => ({ roleId, _count: { _all: n } }));
      },
      deleteMany: async (args: { where: Record<string, unknown> }) => {
        const before = grants.length;
        for (let index = grants.length - 1; index >= 0; index -= 1) {
          if (grantWhere(grants[index], args.where)) grants.splice(index, 1);
        }
        return { count: before - grants.length };
      }
    },
    $transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => fn(db)
  };

  const keysOf = (roleId: string): string[] =>
    grants
      .filter((row) => row.roleId === roleId)
      .map((row) => permissions.find((permission) => permission.id === row.permissionId)?.key ?? "<deleted>")
      .sort();
  const roleByName = (organizationId: string, name: string): RoleRow | undefined =>
    roles.find((row) => row.organizationId === organizationId && row.name === name);

  return { db: db as unknown as RbacDb, state: { roles, permissions, grants }, keysOf, roleByName };
}

const orgKeys = new Set<string>(ORG_PERMISSION_KEYS);
const manifestKeys = new Set<string>(routePermissionManifest.flatMap((entry) => entry.permissions as string[]));
const ownerKeys = new Set<string>(ROLE_PERMISSION_MAP.owner);

function templateSize(key: string): number {
  return templatePermissionKeys(key).length;
}

// ---------------------------------------------------------------------------
// Template invariants (pure)
// ---------------------------------------------------------------------------

describe("role templates", () => {
  it("never carry a platform key (assertTemplatesExcludePlatformKeys)", () => {
    assert.doesNotThrow(() => assertTemplatesExcludePlatformKeys());
    for (const key of ROLE_TEMPLATE_KEYS) {
      for (const permission of ROLE_PERMISSION_MAP[key]) {
        assert.equal(isPlatformPermission(permission), false, `${key} carries platform key ${permission}`);
        assert.equal(PLATFORM_PERMISSION_KEYS.includes(permission), false);
      }
    }
  });

  it("are non-empty subsets of ORG_PERMISSION_KEYS", () => {
    for (const key of ROLE_TEMPLATE_KEYS) {
      const keys = templatePermissionKeys(key);
      assert.ok(keys.length >= 1, `template ${key} is empty`);
      for (const permission of keys) {
        assert.ok(orgKeys.has(permission), `${key}: ${permission} is not an org permission`);
        assert.ok(permission in PERMISSIONS, `${key}: ${permission} missing from PERMISSIONS`);
      }
      assert.equal(new Set(keys).size, keys.length, `${key} has duplicate keys`);
    }
  });

  it("owner is a strict subset of the org scope, break_glass is the whole org scope, admin holds no money key of the SoD pairs (Tanda 8a)", () => {
    const owner = new Set(templatePermissionKeys("owner"));
    for (const key of owner) assert.ok(orgKeys.has(key), `owner: ${key} outside the org scope`);
    assert.ok(owner.size < ORG_PERMISSION_KEYS.length, "owner is read + approvals, no longer the whole org scope");
    assert.ok(owner.has("payables.approve") && owner.has("asset.capex.approve") && owner.has("owner.dashboard.read"));
    assert.deepEqual([...templatePermissionKeys("break_glass")].sort(), [...ORG_PERMISSION_KEYS].sort());
    assert.equal(ORG_PERMISSION_KEYS.length, Object.keys(PERMISSIONS).length - PLATFORM_PERMISSION_KEYS.length);
    const admin = new Set(templatePermissionKeys("admin"));
    const moneyKeys = new Set(SOD_STATIC_PAIRS.filter((pair) => pair.a === "roles.manage" || pair.a === "permissions.manage").map((pair) => pair.b));
    assert.ok(moneyKeys.size >= 12, "the sistema ≠ finanzas pairs are expanded to explicit keys");
    for (const key of moneyKeys) assert.equal(admin.has(key), false, `admin (Administración de sistema) must not hold ${key}`);
    assert.ok(admin.has("roles.manage") && admin.has("users.assign") && admin.has("security.break_glass"));
    // The revocation list of every template is disjoint from the template and never a platform key.
    for (const key of ROLE_TEMPLATE_KEYS) {
      const held = new Set(ROLE_PERMISSION_MAP[key]);
      for (const revoked of ROLE_TEMPLATE_REVOCATIONS[key]) {
        assert.equal(held.has(revoked), false, `${key}: ${revoked} is both held and revoked`);
        assert.ok(revoked in PERMISSIONS && !isPlatformPermission(revoked), `${key}: ${revoked}`);
      }
      assert.deepEqual([...templateRevocationKeys(key)].sort(), [...new Set(ROLE_TEMPLATE_REVOCATIONS[key])].sort());
    }
    assert.equal(ROLE_TEMPLATE_VERSION, 2);
  });

  it("rejects unknown template keys", () => {
    assert.equal(isRoleTemplateKey("owner"), true);
    assert.equal(isRoleTemplateKey("platform"), false);
    assert.equal(isRoleTemplateKey("__proto__"), false);
    assert.throws(() => templatePermissionKeys("nope"), /Unknown role template "nope"/);
  });

  it("DEFAULT_TENANT_ROLE_TEMPLATES are the 22 organisation templates (Tanda 8a: every template but admin and break_glass) with their Spanish names, and every label resolves back to its template", () => {
    assert.equal(ROLE_TEMPLATE_KEYS.length, 24);
    assert.equal(ORGANIZATION_TEMPLATE_ROLE_KEYS.length, 22);
    assert.equal(DEFAULT_TENANT_ROLE_TEMPLATES.length, 22);
    for (const key of ROLE_TEMPLATE_KEYS) {
      assert.equal(resolveTemplateKeyForRoleName(ROLE_TEMPLATE_LABELS_ES[key]), key, `label «${ROLE_TEMPLATE_LABELS_ES[key]}» must resolve to ${key}`);
      assert.ok(ROLE_TEMPLATE_DESCRIPTIONS_ES[key].length > 20, `${key} has a Spanish description`);
      assert.ok(ROLE_TEMPLATE_LEVEL[key], `${key} has a level`);
    }
    assert.deepEqual(
      DEFAULT_TENANT_ROLE_TEMPLATES.map((template) => template.templateKey),
      [...ORGANIZATION_TEMPLATE_ROLE_KEYS],
      "one entry per ORGANIZATION_TEMPLATE_ROLE_KEYS template, same order"
    );
    for (const template of DEFAULT_TENANT_ROLE_TEMPLATES) {
      assert.ok(isRoleTemplateKey(template.templateKey));
      assert.equal(template.name, ROLE_TEMPLATE_LABELS_ES[template.templateKey]);
      assert.equal(resolveTemplateKeyForRoleName(template.name), template.templateKey, template.name);
    }
    const names = DEFAULT_TENANT_ROLE_TEMPLATES.map((template) => template.name.toLowerCase());
    assert.equal(new Set(names).size, names.length, "names are unique (case-insensitive)");
    assert.ok(DEFAULT_TENANT_ROLE_TEMPLATES.some((template) => template.templateKey === "owner"), "owner is provisioned (matched by templateKey against createTenant's Owner)");
    assert.equal(DEFAULT_TENANT_ROLE_TEMPLATES.some((template) => template.templateKey === "admin"), false, "the org admin template is not materialised by default (§3 reserves admin for the platform)");
    assert.equal(DEFAULT_TENANT_ROLE_TEMPLATES.some((template) => template.templateKey === "break_glass"), false, "the emergency template is only created by ensureBreakGlassRole (§4.8)");
    for (const key of ROLE_TEMPLATE_KEYS.filter((candidate) => candidate !== "admin" && candidate !== "break_glass")) {
      assert.ok(DEFAULT_TENANT_ROLE_TEMPLATES.some((template) => template.templateKey === key), `${key} missing`);
    }
  });
});

// ---------------------------------------------------------------------------
// Route manifest ↔ catalog ↔ owner template
// ---------------------------------------------------------------------------

describe("route-permissions manifest vs permission catalog", () => {
  it("gates at least one route and every manifest key exists in PERMISSIONS", () => {
    assert.ok(manifestKeys.size > 0);
    const unknown = [...manifestKeys].filter((key) => !(key in PERMISSIONS));
    assert.deepEqual(unknown, [], `manifest keys missing from PERMISSIONS: ${unknown.join(", ")}`);
  });

  it("the union of the 23 templates (break_glass aside) holds every non-platform manifest key (Tanda 8a: no route is unreachable by every hotel template)", () => {
    const union = new Set<string>(ROLE_TEMPLATE_KEYS.filter((key) => key !== "break_glass").flatMap((key) => ROLE_PERMISSION_MAP[key]));
    const missing = [...manifestKeys].filter((key) => !isPlatformPermission(key) && !union.has(key));
    assert.deepEqual(missing, [], `no template can call routes gated by: ${missing.join(", ")}`);
    assert.ok(ownerKeys.size < union.size, "owner alone no longer covers the manifest");
  });

  it("platform keys in the manifest are exactly the platform scope and no template holds them", () => {
    const platformInManifest = [...manifestKeys].filter((key) => isPlatformPermission(key));
    for (const key of platformInManifest) {
      assert.ok(PLATFORM_PERMISSION_KEYS.includes(key as PermissionKey), `${key} is platform-shaped but not in PLATFORM_PERMISSION_KEYS`);
      for (const template of ROLE_TEMPLATE_KEYS) {
        assert.equal(ROLE_PERMISSION_MAP[template].includes(key as PermissionKey), false, `${template} leaks ${key}`);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Name resolution
// ---------------------------------------------------------------------------

describe("resolveTemplateKeyForRoleName", () => {
  const cases: Array<[string, string | undefined]> = [
    ["Owner", "owner"],
    ["Propietario", "owner"],
    ["Propietaria", "owner"],
    ["Dueño", "owner"],
    ["Manager", "manager"],
    ["Director General", "general_manager"],
    ["Dirección", "manager"],
    ["Dirección de hotel", "manager"],
    ["Director de hotel", "manager"],
    ["Gerente", "manager"],
    ["Recepción", "receptionist"],
    ["Jefe de Recepción", "front_office_manager"],
    ["Jefatura de recepción", "front_office_manager"],
    ["Front Desk", "receptionist"],
    ["Housekeeping", "housekeeper"],
    ["Gobernanta", "housekeeping_manager"],
    ["Camarera de pisos", "housekeeper"],
    ["Mantenimiento", "maintenance"],
    ["Encargado de mantenimiento", "maintenance_manager"],
    ["Jefe de mantenimiento", "maintenance_manager"],
    ["Contabilidad", "accountant"],
    ["Compliance", "compliance"],
    ["Revenue Manager", "revenue"],
    ["Revenue corporativo", "revenue"],
    ["Administrador", "admin"],
    ["Administración de sistema", "admin"],
    ["Sistemas", "admin"],
    ["Propiedad", "owner"],
    // Tanda 8a labels and aliases (docs/design/RBAC-DEPARTAMENTOS.md §4.2)
    ["Auditoría nocturna", "night_auditor"],
    ["Auditor nocturno", "night_auditor"],
    ["Night auditor", "night_auditor"],
    ["Jefatura de A&B", "fnb_manager"],
    ["Jefe de sala", "fnb_manager"],
    ["Maître", "fnb_manager"],
    ["Comercial", "sales"],
    ["Administración de hotel", "admin_clerk"],
    ["Administrativa", "admin_clerk"],
    ["Administración", "accountant"],
    ["Dirección de operaciones", "operations_director"],
    ["Director de operaciones Galicia", "operations_director"],
    ["COO", "operations_director"],
    ["Dirección financiera", "controller"],
    ["Controller", "controller"],
    ["CFO", "controller"],
    ["RRHH y nóminas", "payroll_hr"],
    ["RRHH", "payroll_hr"],
    ["Recursos humanos", "payroll_hr"],
    ["Cumplimiento", "compliance"],
    ["Gestión del activo", "asset_manager"],
    ["Asset manager", "asset_manager"],
    ["Patrimonio", "asset_manager"],
    ["Dirección general", "general_manager"],
    ["Directora general", "general_manager"],
    ["CEO", "general_manager"],
    ["GM", "general_manager"],
    ["Auditoría interna", "auditor"],
    ["Auditora", "auditor"],
    ["Emergencia", "break_glass"],
    ["Break glass", "break_glass"],
    ["Punto de venta", "fnb"],
    ["Pisos", "housekeeper"],
    ["Equipo noche", undefined],
    ["Foo", undefined],
    ["", undefined],
    ["   ", undefined]
  ];
  for (const [name, expected] of cases) {
    it(`"${name}" → ${expected ?? "undefined (custom)"}`, () => {
      assert.equal(resolveTemplateKeyForRoleName(name), expected);
    });
  }

  it("isPlatformRoleName recognises the ehotelOS staff role names only", () => {
    assert.equal(isPlatformRoleName("Local Super Admin"), true);
    assert.equal(isPlatformRoleName("SUPER-ADMIN"), true);
    assert.equal(isPlatformRoleName("Platform admin"), true);
    assert.equal(isPlatformRoleName("Owner"), false);
    assert.equal(isPlatformRoleName("Administrador"), false);
  });
});

// ---------------------------------------------------------------------------
// applyRoleTemplate + templateKey stamp
// ---------------------------------------------------------------------------

describe("applyRoleTemplate (fake store)", () => {
  it("grants the template, stamps templateKey once and converges to +0", async () => {
    const fake = createFakeDb({ roles: [{ id: "r1", organizationId: "org_a", name: "Recepción", templateKey: null }] });
    const first = await applyRoleTemplate("r1", "receptionist", { db: fake.db });
    assert.equal(first.granted, templateSize("receptionist"));
    assert.equal(first.templateKeySet, true);
    assert.equal(fake.state.roles[0].templateKey, "receptionist");
    assert.deepEqual(fake.keysOf("r1"), [...templatePermissionKeys("receptionist")].sort());

    const second = await applyRoleTemplate("r1", "receptionist", { db: fake.db });
    assert.deepEqual(second, { granted: 0, templateKeySet: false });

    // A different template on a stamped role adds keys but never rewrites the stamp.
    const escalated = await applyRoleTemplate("r1", "manager", { db: fake.db });
    assert.ok(escalated.granted > 0);
    assert.equal(escalated.templateKeySet, false);
    assert.equal(fake.state.roles[0].templateKey, "receptionist");
  });

  it("dry-run reports what would happen without writing", async () => {
    const fake = createFakeDb({ roles: [{ id: "r1", organizationId: "org_a", name: "Owner", templateKey: null }] });
    const result = await applyRoleTemplate("r1", "owner", { db: fake.db, dryRun: true });
    assert.equal(result.granted, templateSize("owner"));
    assert.equal(result.templateKeySet, true);
    assert.equal(fake.state.grants.length, 0);
    assert.equal(fake.state.roles[0].templateKey, null);
  });

  it("materialises missing catalog keys so no grant is dropped on a fresh DB", async () => {
    const fake = createFakeDb({ permissionKeys: [], roles: [{ id: "r1", organizationId: "org_a", name: "Pisos", templateKey: null }] });
    const result = await applyRoleTemplate("r1", "housekeeper", { db: fake.db });
    assert.equal(result.granted, templateSize("housekeeper"));
    assert.equal(fake.state.permissions.length, templateSize("housekeeper"));
  });

  it("404 for an unknown role", async () => {
    const fake = createFakeDb();
    await assert.rejects(applyRoleTemplate("missing", "owner", { db: fake.db }), NotFoundError);
  });
});

// ---------------------------------------------------------------------------
// createRoleFromTemplate (contract B)
// ---------------------------------------------------------------------------

describe("createRoleFromTemplate (fake store)", () => {
  it("creates the role with templateKey and the template's grants", async () => {
    const fake = createFakeDb();
    const result = await createRoleFromTemplate(
      { organizationId: "org_a", name: "  Recepción tarde ", templateKey: "receptionist", actorUserId: "usr_1" },
      { db: fake.db, audit: false }
    );
    assert.equal(result.name, "Recepción tarde");
    assert.equal(result.templateKey, "receptionist");
    assert.equal(result.permissionsCount, templateSize("receptionist"));
    const row = fake.roleByName("org_a", "Recepción tarde");
    assert.ok(row);
    assert.equal(row.id, result.id);
    assert.equal(row.templateKey, "receptionist");
    assert.deepEqual(fake.keysOf(result.id), [...templatePermissionKeys("receptionist")].sort());
    // Tanda 8a: level, department, version and managed flag stamped at creation.
    assert.equal(row.level, "operative");
    assert.equal(row.department, "Recepción");
    assert.equal(row.templateVersion, ROLE_TEMPLATE_VERSION);
    assert.equal(row.managed, true);
  });

  it("404 (opaque) for the break_glass template: only ensureBreakGlassRole creates the emergency role (§4.8)", async () => {
    const fake = createFakeDb();
    await assert.rejects(
      createRoleFromTemplate({ organizationId: "org_a", name: "Emergencia", templateKey: "break_glass", actorUserId: "usr_1" }, { db: fake.db, audit: false }),
      (error: unknown) => error instanceof NotFoundError && !/break_glass/.test(error.message)
    );
    assert.equal(fake.state.roles.length, 0);
    assert.equal(fake.state.grants.length, 0);
  });

  it("400 for an unknown template or an empty name", async () => {
    const fake = createFakeDb();
    await assert.rejects(
      createRoleFromTemplate({ organizationId: "org_a", name: "X", templateKey: "platform", actorUserId: null }, { db: fake.db, audit: false }),
      (error: unknown) => error instanceof BadRequestError && /Plantilla de rol desconocida/.test(error.message)
    );
    await assert.rejects(
      createRoleFromTemplate({ organizationId: "org_a", name: "   ", templateKey: "manager", actorUserId: null }, { db: fake.db, audit: false }),
      (error: unknown) => error instanceof BadRequestError && /nombre del rol es obligatorio/.test(error.message)
    );
    assert.equal(fake.state.roles.length, 0);
  });

  it("409 when the organization already has that name (case-insensitive), other orgs unaffected", async () => {
    const fake = createFakeDb({ roles: [{ id: "r1", organizationId: "org_a", name: "Manager", templateKey: "manager" }] });
    await assert.rejects(
      createRoleFromTemplate({ organizationId: "org_a", name: "manager", templateKey: "manager", actorUserId: null }, { db: fake.db, audit: false }),
      (error: unknown) => error instanceof ConflictError && /Ya existe un rol con ese nombre/.test(error.message)
    );
    const other = await createRoleFromTemplate(
      { organizationId: "org_b", name: "Manager", templateKey: "manager", actorUserId: null },
      { db: fake.db, audit: false }
    );
    assert.equal(other.permissionsCount, templateSize("manager"));
  });

  it("maps a lost unique race (P2002) to the same 409", async () => {
    const fake = createFakeDb();
    // findFirst says "no duplicate", create then collides: simulate by making
    // findFirst blind while the row already exists.
    fake.state.roles.push({ id: "r1", organizationId: "org_a", name: "Manager", templateKey: "manager" });
    const blind = { ...(fake.db as unknown as Record<string, unknown>) } as Record<string, unknown>;
    blind.role = { ...(fake.db as unknown as { role: Record<string, unknown> }).role, findFirst: async () => null };
    await assert.rejects(
      createRoleFromTemplate(
        { organizationId: "org_a", name: "Manager", templateKey: "manager", actorUserId: null },
        { db: blind as unknown as RbacDb, audit: false }
      ),
      ConflictError
    );
  });
});

// ---------------------------------------------------------------------------
// provisionDefaultTemplateRoles (createTenant)
// ---------------------------------------------------------------------------

describe("provisionDefaultTemplateRoles (fake store)", () => {
  it("creates the 21 non-owner templates with their Spanish names (level and department stamped), tops up createTenant's Owner instead of adding «Propiedad», idempotently", async () => {
    const fake = createFakeDb({ roles: [{ id: "owner", organizationId: "org_a", name: "Owner", templateKey: "owner" }] });
    const first = await provisionDefaultTemplateRoles("org_a", { db: fake.db });
    assert.deepEqual(
      first.map((role) => [role.name, role.templateKey, role.permissionsCount, role.created]),
      DEFAULT_TENANT_ROLE_TEMPLATES.map((template) =>
        template.templateKey === "owner"
          ? ["Owner", "owner", templateSize("owner"), false]
          : [template.name, template.templateKey, templateSize(template.templateKey), true]
      )
    );
    assert.equal(fake.roleByName("org_a", "Propiedad"), undefined, "no second owner role next to Owner");
    assert.equal(fake.roleByName("org_a", "Emergencia"), undefined, "break_glass is never provisioned by default");
    assert.equal(fake.roleByName("org_a", "Administración de sistema"), undefined, "the org admin template is never provisioned by default");
    for (const role of first) {
      const row = fake.roleByName("org_a", role.name);
      assert.equal(row?.templateKey, role.templateKey);
      assert.equal(row?.level, ROLE_TEMPLATE_LEVEL[role.templateKey as RoleKey], `${role.name} level`);
      assert.ok(row?.department, `${role.name} department`);
      assert.equal(fake.keysOf(role.id).some((key) => isPlatformPermission(key)), false);
      assert.equal(role.conflict, undefined);
    }
    assert.equal(fake.roleByName("org_a", "Owner")?.templateVersion ?? 0, 0, "an existing row keeps its version: only upgradeRoleTemplate bumps it");
    const second = await provisionDefaultTemplateRoles("org_a", { db: fake.db });
    assert.deepEqual(second.map((role) => role.created), DEFAULT_TENANT_ROLE_TEMPLATES.map(() => false));
    assert.deepEqual(second.map((role) => role.permissionsCount), first.map((role) => role.permissionsCount), "+0 once converged");
    assert.equal(fake.state.roles.length, 1 + DEFAULT_TENANT_ROLE_TEMPLATES.length - 1);
  });

  it("adopts a role that already carries the Spanish name (templateKey null) and reports a conflict instead of duplicating a name that follows another template", async () => {
    const fake = createFakeDb({
      roles: [
        { id: "owner", organizationId: "org_b", name: "Owner", templateKey: "owner" },
        { id: "recepcion", organizationId: "org_b", name: "Recepción", templateKey: null },
        // Org admin template: not in the default set, so nothing tops it up.
        { id: "pisos", organizationId: "org_b", name: "Pisos", templateKey: "admin" }
      ]
    });
    const result = await provisionDefaultTemplateRoles("org_b", { db: fake.db });
    const recepcion = result.find((role) => role.templateKey === "receptionist");
    assert.ok(recepcion);
    assert.equal(recepcion.id, "recepcion");
    assert.equal(recepcion.created, false);
    assert.equal(fake.roleByName("org_b", "Recepción")?.templateKey, "receptionist", "adoption stamps templateKey");
    assert.equal(recepcion.permissionsCount, templateSize("receptionist"));
    const pisos = result.find((role) => role.name === "Pisos");
    assert.ok(pisos);
    assert.equal(pisos.templateKey, "admin", "the «Pisos» row that follows another template is left as it is");
    assert.match(pisos.conflict ?? "", /sigue la plantilla "admin"/);
    assert.equal(fake.keysOf("pisos").length, 0, "no template applied to the conflicting row");
    assert.equal(result.some((role) => role.templateKey === "housekeeper"), false, "housekeeper is not created under a second name");
    assert.equal(fake.state.roles.length, 3 + DEFAULT_TENANT_ROLE_TEMPLATES.length - 3);
  });
});

// ---------------------------------------------------------------------------
// ensureRoleHasPermissions (contract B)
// ---------------------------------------------------------------------------

describe("ensureRoleHasPermissions (fake store)", () => {
  it("returns a role that already has grants untouched", async () => {
    const fake = createFakeDb({
      roles: [{ id: "r1", organizationId: "org_a", name: "Equipo noche", templateKey: null }],
      grants: [["r1", "pms.reservation.read"], ["r1", "guests.read"]]
    });
    const result = await ensureRoleHasPermissions("r1", { db: fake.db });
    assert.deepEqual(result, { applied: false, permissionsCount: 2, templateKey: null });
    assert.equal(fake.state.grants.length, 2);
  });

  it("applies the stored templateKey to an empty role", async () => {
    const fake = createFakeDb({ roles: [{ id: "r1", organizationId: "org_a", name: "Turno tarde", templateKey: "receptionist" }] });
    const result = await ensureRoleHasPermissions("r1", { db: fake.db });
    assert.deepEqual(result, { applied: true, permissionsCount: templateSize("receptionist"), templateKey: "receptionist" });
  });

  it("resolves the template by name and stamps templateKey when the row has none", async () => {
    const fake = createFakeDb({ roles: [{ id: "r1", organizationId: "org_a", name: "Recepción", templateKey: null }] });
    const result = await ensureRoleHasPermissions("r1", { db: fake.db });
    assert.equal(result.applied, true);
    assert.equal(result.templateKey, "receptionist");
    assert.equal(fake.state.roles[0].templateKey, "receptionist");
  });

  it("409 ROLE_WITHOUT_PERMISSIONS for an empty custom role", async () => {
    const fake = createFakeDb({ roles: [{ id: "r1", organizationId: "org_a", name: "Equipo noche", templateKey: null }] });
    await assert.rejects(ensureRoleHasPermissions("r1", { db: fake.db }), (error: unknown) => {
      assert.ok(error instanceof ConflictError);
      assert.equal(error.message, ROLE_WITHOUT_PERMISSIONS_MESSAGE);
      assert.equal(error.statusCode, 409);
      assert.equal((error.details as { code: string }).code, ROLE_WITHOUT_PERMISSIONS_CODE);
      return true;
    });
    assert.equal(fake.state.grants.length, 0);
  });

  it("404 for an unknown role", async () => {
    const fake = createFakeDb();
    await assert.rejects(ensureRoleHasPermissions("missing", { db: fake.db }), NotFoundError);
  });
});

// ---------------------------------------------------------------------------
// backfillTemplateRoles (boot)
// ---------------------------------------------------------------------------

/** The org scope of template version 1 (the HEAD before Tanda 8a): today's catalog minus the 27 keys L0 added. */
const V1_NEW_KEYS = new Set<string>([
  "pms.reservation.discount", "pms.reservation.override", "folio.adjust", "folio.adjust_approve", "invoice.cancel_request", "invoice.cancel_approve",
  "night_audit.run", "night_audit.review", "night_audit.reopen", "housekeeping.read", "maintenance.read", "maintenance.workorder.create", "pos.order.void",
  "payables.read", "payables.create", "payables.approve", "payables.pay", "accounting.period.close", "payroll.approve", "revenue.rates.approve",
  "real_estate.read", "real_estate.manage", "real_estate.documents.manage", "property_tax.manage", "users.assign", "compliance.read", "security.break_glass"
]);
const ORG_V1_KEYS: PermissionKey[] = ORG_PERMISSION_KEYS.filter((key) => !V1_NEW_KEYS.has(key));
/** What a converged v1 template role holds today: the v2 template plus the keys v2 revokes (top-up already delivered). */
const v1Envelope = (key: string): PermissionKey[] => [...templatePermissionKeys(key), ...templateRevocationKeys(key)];

function demoLikeSeed(): FakeSeed {
  const managerKeys = templatePermissionKeys("manager");
  const managerEnvelope = new Set<string>(v1Envelope("manager"));
  const outsideManager = ORG_PERMISSION_KEYS.find((key) => !managerEnvelope.has(key));
  assert.ok(outsideManager, "need an org key outside the manager template (and its revocations) for the fixture");
  return {
    roles: [
      // The 4 pre-Tanda-4 Owners: full org scope, no templateKey yet.
      { id: "owner_a", organizationId: "org_a", name: "Owner", templateKey: null },
      { id: "owner_b", organizationId: "org_b", name: "Owner", templateKey: null },
      { id: "owner_c", organizationId: "org_c", name: "Owner", templateKey: null },
      { id: "owner_d", organizationId: "org_d", name: "Owner", templateKey: null },
      // Template role created after Tanda 4 whose template grew by 5 keys since.
      { id: "mgr_a", organizationId: "org_a", name: "Manager", templateKey: "manager" },
      // Custom roles with grants: name unmatched / keys beyond the name's template.
      { id: "night_a", organizationId: "org_a", name: "Equipo noche", templateKey: null },
      { id: "dir_night_a", organizationId: "org_a", name: "Director de noche", templateKey: null },
      // Empty roles: template-named → filled; unmatched → reported.
      { id: "rec_b", organizationId: "org_b", name: "Recepción", templateKey: null },
      { id: "late_b", organizationId: "org_b", name: "Turno tarde", templateKey: null },
      // Tenant "Super Admin" with no platform grant in a tenant org → org admin template.
      { id: "sa_a", organizationId: "org_a", name: "Super Admin", templateKey: null },
      // Stored template_key nobody knows: skipped, never aborts the boot.
      { id: "typo_c", organizationId: "org_c", name: "Reservas", templateKey: "reservationist" },
      // Real platform role: holds admin.tenants.manage, partial catalog.
      { id: "role_local_super_admin", organizationId: "org_123", name: "Local Super Admin", templateKey: null }
    ],
    grants: [
      // The 4 pre-Tanda-4 Owners hold the v1 owner scope (template ∪ revocations): adopted with +0, revoked only by an upgrade.
      ...(["owner_a", "owner_b", "owner_c", "owner_d"] as const).flatMap((roleId) =>
        v1Envelope("owner").map((key): [string, string] => [roleId, key])
      ),
      ...managerKeys.slice(5).map((key): [string, string] => ["mgr_a", key]),
      ["night_a", "pms.reservation.read"],
      ["night_a", "guests.read"],
      ["dir_night_a", "pms.reservation.read"],
      ["dir_night_a", outsideManager],
      ["typo_c", "pms.reservation.read"],
      ["role_local_super_admin", "admin.tenants.manage"],
      ...ORG_PERMISSION_KEYS.slice(0, 10).map((key): [string, string] => ["role_local_super_admin", key])
    ]
  };
}

describe("backfillTemplateRoles (fake store)", () => {
  it("dry-run reports the plan without writing", async () => {
    const fake = createFakeDb(demoLikeSeed());
    const grantsBefore = fake.state.grants.length;
    const result = await backfillTemplateRoles({ db: fake.db, dryRun: true });
    assert.equal(fake.state.grants.length, grantsBefore);
    assert.ok(fake.state.roles.every((row) => row.id !== "owner_a" || row.templateKey === null));
    assert.equal(result.templateKeysAssigned, 6); // 4 Owners + Recepción + Super Admin
    assert.equal(result.templateRoles, 7); // + Manager (stored key)
    assert.equal(result.templateRolesToppedUp, 3); // Manager +5, Recepción, Super Admin
    assert.deepEqual(result.unmatched, ["Turno tarde (org_b)"]);
    assert.equal(result.customRoles?.length, 3); // Equipo noche, Director de noche, Reservas[typo]
    assert.equal(result.platformRoles?.length, 1);
    assert.equal(result.platformRolesToppedUp, 1);
  });

  it("stamps Owner ×4 by name with +0, tops up template roles, fills empty template-named roles, never touches custom or platform stamps", async () => {
    const fake = createFakeDb(demoLikeSeed());
    const result = await backfillTemplateRoles({ db: fake.db });

    // Owners: adopted (they hold nothing outside template ∪ revocations), no new grant, nothing revoked (no upgrade).
    for (const id of ["owner_a", "owner_b", "owner_c", "owner_d"]) {
      const row = fake.state.roles.find((role) => role.id === id);
      assert.equal(row?.templateKey, "owner", id);
      assert.equal(fake.keysOf(id).length, v1Envelope("owner").length, id);
      assert.deepEqual(result.revocationsByRole?.[id], [...templateRevocationKeys("owner")].sort(), `${id}: the boot reports what an upgrade would revoke`);
    }
    assert.deepEqual(result.upgraded, [], "no upgrade without the flag");
    assert.equal(result.templateRolesBehindVersion, 7);
    assert.ok(result.templateKeysAssignedRoles?.includes("Owner (org_a) → owner"));
    assert.equal(result.roles.some((line) => line.startsWith("Owner (")), false);

    // Manager with stored key: +5, stamp untouched.
    assert.equal(fake.keysOf("mgr_a").length, templateSize("manager"));
    assert.ok(result.roles.includes("Manager (org_a) ← manager: +5"));

    // Custom roles: untouched.
    assert.deepEqual(fake.keysOf("night_a"), ["guests.read", "pms.reservation.read"]);
    assert.equal(fake.state.roles.find((role) => role.id === "night_a")?.templateKey, null);
    assert.equal(fake.keysOf("dir_night_a").length, 2);
    assert.equal(fake.state.roles.find((role) => role.id === "dir_night_a")?.templateKey, null);
    assert.ok(result.customRoles?.some((line) => line.startsWith("Director de noche (org_a) [1 key(s) outside \"manager\"]")));

    // Empty template-named role: filled + stamped. Empty unmatched: reported, still empty.
    assert.equal(fake.keysOf("rec_b").length, templateSize("receptionist"));
    assert.equal(fake.state.roles.find((role) => role.id === "rec_b")?.templateKey, "receptionist");
    assert.equal(fake.keysOf("late_b").length, 0);
    assert.deepEqual(result.unmatched, ["Turno tarde (org_b)"]);

    // Tenant "Super Admin": org admin template (Administración de sistema: no money, no operations), never a platform key.
    assert.equal(fake.keysOf("sa_a").length, templateSize("admin"));
    assert.equal(fake.keysOf("sa_a").some((key) => isPlatformPermission(key)), false);
    assert.equal(fake.keysOf("sa_a").includes("folio.charge.post"), false);
    assert.equal(fake.state.roles.find((role) => role.id === "sa_a")?.templateKey, "admin");

    // Unknown stored key: skipped, untouched.
    assert.equal(fake.keysOf("typo_c").length, 1);
    assert.equal(fake.state.roles.find((role) => role.id === "typo_c")?.templateKey, "reservationist");

    // Platform role: full catalog, templateKey stays null.
    assert.equal(fake.keysOf("role_local_super_admin").length, Object.keys(PERMISSIONS).length);
    assert.equal(fake.state.roles.find((role) => role.id === "role_local_super_admin")?.templateKey, null);
    assert.equal(result.platformRolesToppedUp, 1);

    // Second run converges: nothing new, nothing stamped.
    const again = await backfillTemplateRoles({ db: fake.db });
    assert.equal(again.rolesFilled, 0);
    assert.equal(again.templateKeysAssigned, 0);
    assert.equal(again.templateRolesToppedUp, 0);
    assert.equal(again.platformRolesToppedUp, 0);
    assert.equal(again.templateRoles, 7);
  });

  it("delivers a catalog key added to PERMISSIONS to stamped roles (the drift AUTH-07 deferred)", async () => {
    const fake = createFakeDb({
      roles: [{ id: "owner_a", organizationId: "org_a", name: "Owner", templateKey: "owner" }],
      grants: ORG_PERMISSION_KEYS.slice(1).map((key): [string, string] => ["owner_a", key])
    });
    const result = await backfillTemplateRoles({ db: fake.db });
    assert.deepEqual(result.roles, ["Owner (org_a) ← owner: +1"]);
    assert.equal(fake.keysOf("owner_a").length, ORG_PERMISSION_KEYS.length);
  });

  it("returns zeroed counters on an empty roles table", async () => {
    const fake = createFakeDb();
    const result = await backfillTemplateRoles({ db: fake.db });
    assert.equal(result.rolesFilled, 0);
    assert.equal(result.templateRoles, 0);
    assert.deepEqual(result.unmatched, []);
  });
});

// ---------------------------------------------------------------------------
// Template version 2: upgradeRoleTemplate + backfill --upgrade (Tanda 8a · L0)
// ---------------------------------------------------------------------------

describe("upgradeRoleTemplate (fake store)", () => {
  /** A v1 Dirección role: the 111 keys of the previous manager template, version 0. */
  function v1ManagerSeed(extra: Partial<RoleRow> = {}): FakeSeed {
    return {
      roles: [{ id: "mgr", organizationId: "org_a", name: "Dirección", templateKey: "manager", templateVersion: 0, ...extra }],
      grants: v1Envelope("manager").filter((key) => !V1_NEW_KEYS.has(key)).map((key): [string, string] => ["mgr", key])
    };
  }
  const managerRevoked = [...templateRevocationKeys("manager")].sort();
  const managerNew = templatePermissionKeys("manager").filter((key) => V1_NEW_KEYS.has(key)).sort();

  it("applies the additions AND the revocations of the version, stamps level / department / version", async () => {
    const fake = createFakeDb(v1ManagerSeed());
    assert.equal(managerRevoked.length, 16, "manager loses 16 keys in v2 (design §6.5)");
    assert.ok(managerNew.length > 0);
    const result = await upgradeRoleTemplate("mgr", { db: fake.db, audit: false });
    assert.equal(result.upgraded, true);
    assert.deepEqual(result.revoked, managerRevoked);
    assert.deepEqual([...result.added].sort(), managerNew);
    assert.deepEqual([result.fromVersion, result.toVersion, result.dryRun], [0, ROLE_TEMPLATE_VERSION, false]);
    assert.deepEqual(fake.keysOf("mgr"), [...templatePermissionKeys("manager")].sort(), "the role converges exactly to the v2 template");
    const row = fake.state.roles[0];
    assert.deepEqual([row.templateVersion, row.level, row.department, row.managed ?? true], [ROLE_TEMPLATE_VERSION, "hotel_director", "Dirección", true]);

    const again = await upgradeRoleTemplate("mgr", { db: fake.db, audit: false });
    assert.deepEqual([again.upgraded, again.skippedReason, again.added, again.revoked], [false, "up_to_date", [], []]);
  });

  it("dry-run reports the plan without writing", async () => {
    const fake = createFakeDb(v1ManagerSeed());
    const before = fake.keysOf("mgr");
    const result = await upgradeRoleTemplate("mgr", { db: fake.db, dryRun: true, audit: false });
    assert.equal(result.upgraded, true);
    assert.equal(result.dryRun, true);
    assert.deepEqual(result.revoked, managerRevoked);
    assert.deepEqual([...result.added].sort(), managerNew);
    assert.deepEqual(fake.keysOf("mgr"), before);
    assert.equal(fake.state.roles[0].templateVersion, 0);
    assert.equal(fake.state.roles[0].level ?? null, null);
  });

  it("never touches a custom role (managed = false), a role without / with an unknown template, or a platform role", async () => {
    const fake = createFakeDb({
      roles: [
        { id: "custom", organizationId: "org_a", name: "Dirección", templateKey: "manager", managed: false, templateVersion: 0 },
        { id: "notpl", organizationId: "org_a", name: "Equipo noche", templateKey: null },
        { id: "typo", organizationId: "org_a", name: "Reservas", templateKey: "reservationist" },
        { id: "platform", organizationId: "org_123", name: "Local Super Admin", templateKey: "owner", templateVersion: 0 }
      ],
      grants: [
        ...v1Envelope("manager").map((key): [string, string] => ["custom", key]),
        ["notpl", "pms.reservation.read"],
        ["typo", "pms.reservation.read"],
        ["platform", "admin.tenants.manage"],
        ...v1Envelope("owner").map((key): [string, string] => ["platform", key])
      ]
    });
    const snapshot = ["custom", "notpl", "typo", "platform"].map((id) => fake.keysOf(id));
    const custom = await upgradeRoleTemplate("custom", { db: fake.db, audit: false });
    assert.deepEqual([custom.upgraded, custom.skippedReason], [false, "custom"]);
    assert.deepEqual([(await upgradeRoleTemplate("notpl", { db: fake.db, audit: false })).skippedReason, (await upgradeRoleTemplate("typo", { db: fake.db, audit: false })).skippedReason], ["no_template", "unknown_template"]);
    const platform = await upgradeRoleTemplate("platform", { db: fake.db, audit: false });
    assert.deepEqual([platform.upgraded, platform.skippedReason], [false, "platform"]);
    assert.deepEqual(["custom", "notpl", "typo", "platform"].map((id) => fake.keysOf(id)), snapshot, "no grant changed");
    assert.ok(fake.state.roles.every((row) => (row.templateVersion ?? 0) === 0));
    await assert.rejects(upgradeRoleTemplate("missing", { db: fake.db, audit: false }), NotFoundError);
  });

  it("backfillTemplateRoles() without upgrade stays additive: a converged v1 role gets +0 and keeps the revoked keys (the boot behaviour)", async () => {
    const fake = createFakeDb({
      roles: [{ id: "mgr", organizationId: "org_a", name: "Dirección", templateKey: "manager", templateVersion: 0 }],
      grants: v1Envelope("manager").map((key): [string, string] => ["mgr", key])
    });
    const before = fake.keysOf("mgr");
    const result = await backfillTemplateRoles({ db: fake.db });
    assert.equal(result.rolesFilled, 0);
    assert.equal(result.templateRolesToppedUp, 0);
    assert.deepEqual(fake.keysOf("mgr"), before, "+0: nothing granted, nothing revoked");
    assert.deepEqual(result.revocationsByRole, { mgr: managerRevoked }, "the report lists what --upgrade-templates would revoke");
    assert.deepEqual(result.upgraded, []);
    assert.equal(result.templateRolesBehindVersion, 1);
    assert.equal(fake.state.roles[0].templateVersion, 0);
  });

  it("backfillTemplateRoles({ upgrade: true }) upgrades managed template roles (dry-run reports, real run writes) and skips managed = false", async () => {
    const seed: FakeSeed = {
      roles: [
        { id: "mgr", organizationId: "org_a", name: "Dirección", templateKey: "manager", templateVersion: 0 },
        { id: "own", organizationId: "org_a", name: "Owner", templateKey: null },
        { id: "custom", organizationId: "org_a", name: "Contabilidad", templateKey: "accountant", managed: false, templateVersion: 0 },
        { id: "rec", organizationId: "org_a", name: "Recepción", templateKey: "receptionist", templateVersion: ROLE_TEMPLATE_VERSION }
      ],
      grants: [
        ...v1Envelope("manager").map((key): [string, string] => ["mgr", key]),
        ...ORG_V1_KEYS.map((key): [string, string] => ["own", key]),
        ...v1Envelope("accountant").map((key): [string, string] => ["custom", key]),
        ...templatePermissionKeys("receptionist").map((key): [string, string] => ["rec", key])
      ]
    };
    const dry = createFakeDb(seed);
    const plan = await backfillTemplateRoles({ db: dry.db, dryRun: true, upgrade: true, audit: false });
    assert.equal(plan.upgraded?.length, 2, "Dirección and the adopted Owner would be upgraded");
    assert.ok(plan.upgraded?.some((line) => line.startsWith("Dirección (org_a) ← manager v0→v2: +") && line.endsWith("−16 [dry-run]")));
    assert.ok(plan.upgraded?.some((line) => line.startsWith("Owner (org_a) ← owner v0→v2:")));
    assert.deepEqual(plan.revocationsByRole?.mgr, managerRevoked);
    assert.deepEqual(plan.revocationsByRole?.own, [...templateRevocationKeys("owner")].sort());
    assert.equal(plan.revocationsByRole?.custom, undefined, "managed=false: never listed");
    assert.ok(plan.customRoles?.includes("Contabilidad (org_a) [managed=false]"));
    assert.deepEqual(dry.keysOf("mgr"), [...v1Envelope("manager")].sort(), "dry-run writes nothing");
    assert.equal(dry.state.roles.find((row) => row.id === "own")?.templateKey, null);

    const fake = createFakeDb(seed);
    const result = await backfillTemplateRoles({ db: fake.db, upgrade: true, audit: false });
    assert.equal(result.upgraded?.length, 2);
    assert.deepEqual(fake.keysOf("mgr"), [...templatePermissionKeys("manager")].sort());
    assert.deepEqual(fake.keysOf("own"), [...templatePermissionKeys("owner")].sort(), "the v1 Owner (222 keys) becomes Propiedad: read + approvals");
    assert.equal(fake.state.roles.find((row) => row.id === "own")?.templateKey, "owner");
    assert.equal(fake.state.roles.find((row) => row.id === "own")?.templateVersion, ROLE_TEMPLATE_VERSION);
    assert.equal(fake.state.roles.find((row) => row.id === "own")?.level, "ownership");
    assert.deepEqual(fake.keysOf("custom"), [...v1Envelope("accountant")].sort(), "managed=false untouched");
    assert.equal(fake.state.roles.find((row) => row.id === "custom")?.templateVersion, 0);
    assert.deepEqual(fake.keysOf("rec"), [...templatePermissionKeys("receptionist")].sort());
    assert.equal(result.templateRolesBehindVersion, 0);
    assert.deepEqual(result.revocationsByRole, { mgr: managerRevoked, own: [...templateRevocationKeys("owner")].sort() });

    const again = await backfillTemplateRoles({ db: fake.db, upgrade: true, audit: false });
    assert.deepEqual([again.upgraded, again.rolesFilled, again.revocationsByRole], [[], 0, {}], "converged: +0, −0");
  });
});

describe("ensureBreakGlassRole (fake store)", () => {
  it("creates «Emergencia» with the whole org scope, managed, level general_management; idempotent; 409 when the name follows another template", async () => {
    const fake = createFakeDb();
    const first = await ensureBreakGlassRole("org_a", { db: fake.db });
    assert.equal(first.created, true);
    assert.equal(first.name, "Emergencia");
    assert.equal(first.permissionsCount, ORG_PERMISSION_KEYS.length);
    const row = fake.roleByName("org_a", "Emergencia");
    assert.deepEqual([row?.templateKey, row?.level, row?.managed, row?.templateVersion], ["break_glass", "general_management", true, ROLE_TEMPLATE_VERSION]);
    assert.equal(fake.keysOf(first.id).some((key) => isPlatformPermission(key)), false, "never a platform key");
    const second = await ensureBreakGlassRole("org_a", { db: fake.db });
    assert.deepEqual([second.id, second.created, second.permissionsCount], [first.id, false, ORG_PERMISSION_KEYS.length]);
    assert.equal(fake.state.roles.length, 1);
    // Another organisation gets its own row; a name clash with another template is refused.
    const other = await ensureBreakGlassRole("org_b", { db: fake.db });
    assert.notEqual(other.id, first.id);
    fake.state.roles.push({ id: "clash", organizationId: "org_c", name: "Emergencia", templateKey: "manager" });
    await assert.rejects(ensureBreakGlassRole("org_c", { db: fake.db }), ConflictError);
  });
});

// ---------------------------------------------------------------------------
// syncPermissionCatalog + CLI report
// ---------------------------------------------------------------------------

describe("syncPermissionCatalog (fake store)", () => {
  const STALE = ["pms.reservation.update", "pms.reservation.cancel", "pms.reservation.check_in", "pms.reservation.check_out"];

  it("dry-run counts missing keys and the grants a prune would destroy", async () => {
    const fake = createFakeDb({
      permissionKeys: [...Object.keys(PERMISSIONS).slice(3), ...STALE],
      roles: [{ id: "role_local_super_admin", organizationId: "org_123", name: "Local Super Admin", templateKey: null }],
      grants: STALE.map((key): [string, string] => ["role_local_super_admin", key])
    });
    const result = await syncPermissionCatalog({ db: fake.db, dryRun: true, prune: true });
    assert.equal(result.created, 3);
    assert.deepEqual(result.stale, [...STALE].sort());
    assert.equal(result.staleGrants, 4);
    assert.equal(result.staleGrantRoles, 1);
    assert.equal(result.pruned, 4);
    assert.equal(result.prunedGrants, 4);
    assert.equal(fake.state.permissions.length, Object.keys(PERMISSIONS).length - 3 + 4);
    assert.equal(fake.state.grants.length, 4);
  });

  it("prune removes the stale keys and their grants; a second run reports 0 stale", async () => {
    const fake = createFakeDb({
      permissionKeys: [...Object.keys(PERMISSIONS), ...STALE],
      roles: [{ id: "role_local_super_admin", organizationId: "org_123", name: "Local Super Admin", templateKey: null }],
      grants: [...STALE, "pms.reservation.read"].map((key): [string, string] => ["role_local_super_admin", key])
    });
    const result = await syncPermissionCatalog({ db: fake.db, prune: true });
    assert.equal(result.pruned, 4);
    assert.equal(result.prunedGrants, 4);
    assert.equal(fake.state.permissions.length, Object.keys(PERMISSIONS).length);
    assert.deepEqual(fake.keysOf("role_local_super_admin"), ["pms.reservation.read"]);
    const again = await syncPermissionCatalog({ db: fake.db, dryRun: true });
    assert.deepEqual(again.stale, []);
    assert.equal(again.staleGrants, 0);
  });
});

describe("rbac-sync CLI", () => {
  it("parses the documented flags and rejects unknown ones", () => {
    assert.deepEqual(parseFlags(["--", "--dry-run", "--prune", "--json"]), { prune: true, dryRun: true, json: true });
    assert.throws(() => parseFlags(["--apply"]), /Unknown flag "--apply"/);
  });

  it("human report shows stale grants/roles and the template-role counters", () => {
    const text = formatHuman({
      dryRun: true,
      prune: true,
      catalogKeys: 212,
      orgKeys: 211,
      platformKeys: 1,
      templates: { owner: 211 },
      sync: { created: 0, updated: 0, stale: ["pms.reservation.update"], staleGrants: 4, staleGrantRoles: 1, pruned: 1, prunedGrants: 4 },
      backfill: {
        rolesFilled: 1,
        roles: ["Manager (org_a) ← manager: +5"],
        unmatched: ["Turno tarde (org_b)"],
        templateRoles: 5,
        templateRolesToppedUp: 1,
        templateKeysAssigned: 4,
        templateKeysAssignedRoles: ["Owner (org_a) → owner"],
        customRoles: ["Equipo noche (org_a)"],
        platformRolesToppedUp: 0,
        platformRoles: ["Local Super Admin (org_123) ← full catalog: +0"]
      },
      durationMs: 12
    });
    assert.match(text, /DRY-RUN \(no writes\) \+ prune/);
    assert.match(text, /grants on stale keys: 4 role_permissions row\(s\) on 1 role\(s\)/);
    assert.match(text, /--prune WOULD delete 1 key\(s\) and 4 role_permissions row\(s\)/);
    assert.match(text, /5 following a template · 1 topped up · 4 template_key stamped by name · 1 custom \(untouched\) · 1 EMPTY without template/);
    assert.match(text, /stamped: Owner \(org_a\) → owner/);
    assert.match(text, /EMPTY without template .*Turno tarde \(org_b\)/);
    assert.match(text, /platform roles: 1 \(0 topped up\)/);
  });
});
