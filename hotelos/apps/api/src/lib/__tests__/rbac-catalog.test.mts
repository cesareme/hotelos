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
  ROLE_TEMPLATE_KEYS,
  ROLE_TEMPLATE_LABELS_ES,
  isPlatformPermission,
  type PermissionKey
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
  ensureRoleHasPermissions,
  isPlatformRoleName,
  isRoleTemplateKey,
  provisionDefaultTemplateRoles,
  resolveTemplateKeyForRoleName,
  syncPermissionCatalog,
  templatePermissionKeys,
  type RbacDb
} from "../rbac-catalog.js";
import { formatHuman, parseFlags } from "../../scripts/rbac-sync.js";
import { BadRequestError, ConflictError, NotFoundError } from "../http-error.js";

// ---------------------------------------------------------------------------
// In-memory fake of the Prisma subset rbac-catalog.ts uses
// ---------------------------------------------------------------------------

type RoleRow = { id: string; organizationId: string; name: string; templateKey: string | null };
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
      (where.templateKey === undefined || row.templateKey === where.templateKey)
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
      create: async (args: { data: { organizationId: string; name: string; templateKey?: string | null }; select?: Record<string, boolean> }) => {
        if (roles.some((row) => row.organizationId === args.data.organizationId && row.name === args.data.name)) {
          throw Object.assign(new Error("Unique constraint failed on the fields: (`organization_id`,`name`)"), { code: "P2002" });
        }
        const row: RoleRow = {
          id: nextId("role"),
          organizationId: args.data.organizationId,
          name: args.data.name,
          templateKey: args.data.templateKey ?? null
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

  it("owner and admin cover the whole org scope, nothing more", () => {
    assert.deepEqual([...templatePermissionKeys("owner")].sort(), [...ORG_PERMISSION_KEYS].sort());
    assert.deepEqual([...templatePermissionKeys("admin")].sort(), [...ORG_PERMISSION_KEYS].sort());
    assert.equal(ORG_PERMISSION_KEYS.length, Object.keys(PERMISSIONS).length - PLATFORM_PERMISSION_KEYS.length);
  });

  it("rejects unknown template keys", () => {
    assert.equal(isRoleTemplateKey("owner"), true);
    assert.equal(isRoleTemplateKey("platform"), false);
    assert.equal(isRoleTemplateKey("__proto__"), false);
    assert.throws(() => templatePermissionKeys("nope"), /Unknown role template "nope"/);
  });

  it("DEFAULT_TENANT_ROLE_TEMPLATES are the 10 organisation templates (Tanda 5 · L1b) with their Spanish names, and resolve back by name", () => {
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
    for (const key of ["manager", "receptionist", "housekeeper", "maintenance", "accountant", "compliance", "revenue", "sales", "fnb"]) {
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

  it("every non-platform manifest key is held by the owner template", () => {
    const missing = [...manifestKeys].filter((key) => !isPlatformPermission(key) && !ownerKeys.has(key));
    assert.deepEqual(missing, [], `owner cannot call routes gated by: ${missing.join(", ")}`);
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
    ["Director General", "manager"],
    ["Dirección", "manager"],
    ["Gerente", "manager"],
    ["Recepción", "receptionist"],
    ["Jefe de Recepción", "receptionist"],
    ["Front Desk", "receptionist"],
    ["Housekeeping", "housekeeper"],
    ["Gobernanta", "housekeeper"],
    ["Camarera de pisos", "housekeeper"],
    ["Mantenimiento", "maintenance"],
    ["Contabilidad", "accountant"],
    ["Compliance", "compliance"],
    ["Revenue Manager", "revenue"],
    ["Administrador", "admin"],
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
    assert.equal(result.granted, ORG_PERMISSION_KEYS.length);
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
  it("creates the 9 non-owner templates with their Spanish names, tops up createTenant's Owner instead of adding «Propietario», idempotently", async () => {
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
    assert.equal(fake.roleByName("org_a", "Propietario"), undefined, "no second full-scope role next to Owner");
    for (const role of first) {
      assert.equal(fake.roleByName("org_a", role.name)?.templateKey, role.templateKey);
      assert.equal(fake.keysOf(role.id).some((key) => isPlatformPermission(key)), false);
      assert.equal(role.conflict, undefined);
    }
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

function demoLikeSeed(): FakeSeed {
  const managerKeys = templatePermissionKeys("manager");
  const outsideManager = ORG_PERMISSION_KEYS.find((key) => !managerKeys.includes(key));
  assert.ok(outsideManager, "need an org key outside the manager template for the fixture");
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
      ...(["owner_a", "owner_b", "owner_c", "owner_d"] as const).flatMap((roleId) =>
        ORG_PERMISSION_KEYS.map((key): [string, string] => [roleId, key])
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

    // Owners: adopted, no new grant.
    for (const id of ["owner_a", "owner_b", "owner_c", "owner_d"]) {
      const row = fake.state.roles.find((role) => role.id === id);
      assert.equal(row?.templateKey, "owner", id);
      assert.equal(fake.keysOf(id).length, ORG_PERMISSION_KEYS.length, id);
    }
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

    // Tenant "Super Admin": org admin template, never a platform key.
    assert.equal(fake.keysOf("sa_a").length, ORG_PERMISSION_KEYS.length);
    assert.equal(fake.keysOf("sa_a").some((key) => isPlatformPermission(key)), false);
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
