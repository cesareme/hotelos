// In-memory fake of the Prisma subset the rbac module and lib/rbac-scope.ts
// use (Tanda 8a · L1). Not a test file (no `.test.mts` suffix): imported by
// the rbac unit tests. Supports findUnique / findFirst / findMany / count /
// create / createMany / update / updateMany / deleteMany with the filters the
// services write: scalar equality, null, in / notIn / not, lt / lte / gt / gte
// (numbers and dates), equals (+ mode insensitive), startsWith / contains,
// AND / OR, plus orderBy (single or array), skip / take, `select` (ignored:
// the whole row is returned, a superset of what Prisma would give) and
// `data: { field: { increment } }`. Unsupported filter shapes throw so a test
// never passes by accident.

export type Row = Record<string, unknown>;
export type Tables = Record<string, Row[]>;

let sequence = 0;
export function nextId(prefix: string): string {
  sequence += 1;
  return `${prefix}_${String(sequence).padStart(4, "0")}`;
}

function valueOf(value: unknown): unknown {
  if (value instanceof Date) return value.getTime();
  if (value !== null && typeof value === "object" && typeof (value as { toString?: unknown }).toString === "function" && !(value instanceof Array)) {
    // Decimal-like values compare as numbers when they look numeric.
    const text = String(value);
    const parsed = Number(text);
    return Number.isFinite(parsed) && text.trim() !== "" ? parsed : text;
  }
  if (typeof value === "string") {
    return value;
  }
  return value;
}

function compare(a: unknown, b: unknown): number {
  const x = valueOf(a);
  const y = valueOf(b);
  if (x === y) return 0;
  if (x === null || x === undefined) return -1;
  if (y === null || y === undefined) return 1;
  return (x as number | string) < (y as number | string) ? -1 : 1;
}

function matchScalar(value: unknown, filter: unknown): boolean {
  const actual = value === undefined ? null : value;
  if (filter === undefined) return true;
  if (filter === null) return actual === null;
  if (filter instanceof Date) return actual instanceof Date && actual.getTime() === filter.getTime();
  if (typeof filter !== "object" || Array.isArray(filter)) {
    if (typeof filter === "string" && (actual instanceof Date)) return actual.toISOString() === filter;
    return valueOf(actual) === valueOf(filter);
  }
  const f = filter as Record<string, unknown>;
  for (const [op, expected] of Object.entries(f)) {
    switch (op) {
      case "in":
        if (!Array.isArray(expected) || !expected.some((candidate) => valueOf(candidate) === valueOf(actual))) return false;
        break;
      case "notIn":
        if (!Array.isArray(expected) || expected.some((candidate) => valueOf(candidate) === valueOf(actual))) return false;
        break;
      case "not":
        if (expected === null ? actual === null : matchScalar(actual, expected)) return false;
        break;
      case "equals":
        if (f.mode === "insensitive" && typeof actual === "string" && typeof expected === "string") {
          if (actual.toLowerCase() !== expected.toLowerCase()) return false;
        } else if (valueOf(actual) !== valueOf(expected)) return false;
        break;
      case "mode":
        break;
      case "lt":
        if (actual === null || compare(actual, expected) >= 0) return false;
        break;
      case "lte":
        if (actual === null || compare(actual, expected) > 0) return false;
        break;
      case "gt":
        if (actual === null || compare(actual, expected) <= 0) return false;
        break;
      case "gte":
        if (actual === null || compare(actual, expected) < 0) return false;
        break;
      case "startsWith":
        if (typeof actual !== "string" || !actual.startsWith(String(expected))) return false;
        break;
      case "contains":
        if (typeof actual !== "string" || !actual.includes(String(expected))) return false;
        break;
      default:
        throw new Error(`fake prisma: unsupported filter operator ${op}`);
    }
  }
  return true;
}

export function matchWhere(row: Row, where: Record<string, unknown> | undefined): boolean {
  if (!where) return true;
  for (const [key, filter] of Object.entries(where)) {
    if (key === "AND") {
      const list = Array.isArray(filter) ? filter : [filter];
      if (!list.every((clause) => matchWhere(row, clause as Record<string, unknown>))) return false;
      continue;
    }
    if (key === "OR") {
      const list = Array.isArray(filter) ? filter : [filter];
      if (!list.some((clause) => matchWhere(row, clause as Record<string, unknown>))) return false;
      continue;
    }
    if (key === "NOT") {
      const list = Array.isArray(filter) ? filter : [filter];
      if (list.some((clause) => matchWhere(row, clause as Record<string, unknown>))) return false;
      continue;
    }
    // Compound unique input (e.g. organizationId_name) → object of fields.
    if (key.includes("_") && filter && typeof filter === "object" && !Array.isArray(filter) && !(filter instanceof Date) && !(key in row)) {
      if (!matchWhere(row, filter as Record<string, unknown>)) return false;
      continue;
    }
    if (!matchScalar(row[key], filter)) return false;
  }
  return true;
}

function orderRows(rows: Row[], orderBy: unknown): Row[] {
  if (!orderBy) return rows;
  const clauses = (Array.isArray(orderBy) ? orderBy : [orderBy]) as Array<Record<string, "asc" | "desc">>;
  return rows.slice().sort((a, b) => {
    for (const clause of clauses) {
      for (const [field, direction] of Object.entries(clause)) {
        const result = compare(a[field], b[field]);
        if (result !== 0) return direction === "desc" ? -result : result;
      }
    }
    return 0;
  });
}

function applyData(row: Row, data: Record<string, unknown>): Row {
  const next = { ...row };
  for (const [key, value] of Object.entries(data)) {
    if (value && typeof value === "object" && !Array.isArray(value) && !(value instanceof Date) && "increment" in (value as Record<string, unknown>)) {
      next[key] = ((next[key] as number) ?? 0) + Number((value as { increment: number }).increment);
    } else if (value !== undefined) {
      next[key] = value;
    }
  }
  return next;
}

type Args = { where?: Record<string, unknown>; orderBy?: unknown; skip?: number; take?: number; data?: Record<string, unknown> | Record<string, unknown>[]; select?: unknown; distinct?: unknown; skipDuplicates?: boolean };

function delegate(tables: Tables, model: string) {
  const rows = (): Row[] => (tables[model] ??= []);
  const query = (args: Args = {}): Row[] => {
    let out = rows().filter((row) => matchWhere(row, args.where));
    out = orderRows(out, args.orderBy);
    if (args.skip) out = out.slice(args.skip);
    if (args.take !== undefined) out = out.slice(0, args.take);
    return out.map((row) => ({ ...row }));
  };
  return {
    findMany: async (args: Args = {}) => query(args),
    findFirst: async (args: Args = {}) => query({ ...args, take: 1 })[0] ?? null,
    findUnique: async (args: Args = {}) => query({ ...args, take: 1 })[0] ?? null,
    count: async (args: Args = {}) => query({ ...args, skip: undefined, take: undefined }).length,
    create: async (args: Args) => {
      const data = args.data as Record<string, unknown>;
      const row: Row = { id: nextId(model), createdAt: new Date(), ...data };
      if (row.updatedAt === undefined) row.updatedAt = row.createdAt;
      rows().push(row);
      return { ...row };
    },
    createMany: async (args: Args) => {
      const list = args.data as Record<string, unknown>[];
      let count = 0;
      for (const data of list) {
        const row: Row = { id: nextId(model), createdAt: new Date(), ...data };
        rows().push(row);
        count += 1;
      }
      return { count };
    },
    update: async (args: Args) => {
      const index = rows().findIndex((row) => matchWhere(row, args.where));
      if (index < 0) throw Object.assign(new Error(`fake prisma: ${model} row not found`), { code: "P2025" });
      const next = applyData(rows()[index], args.data as Record<string, unknown>);
      rows()[index] = next;
      return { ...next };
    },
    updateMany: async (args: Args) => {
      let count = 0;
      const all = rows();
      for (let index = 0; index < all.length; index += 1) {
        if (!matchWhere(all[index], args.where)) continue;
        all[index] = applyData(all[index], args.data as Record<string, unknown>);
        count += 1;
      }
      return { count };
    },
    deleteMany: async (args: Args = {}) => {
      const before = rows().length;
      tables[model] = rows().filter((row) => !matchWhere(row, args.where));
      return { count: before - tables[model].length };
    },
    upsert: async (args: Args & { create: Record<string, unknown>; update: Record<string, unknown> }) => {
      const index = rows().findIndex((row) => matchWhere(row, args.where));
      if (index >= 0) {
        rows()[index] = applyData(rows()[index], args.update);
        return { ...rows()[index] };
      }
      const row: Row = { id: nextId(model), createdAt: new Date(), ...args.create };
      rows().push(row);
      return { ...row };
    }
  };
}

const MODELS = [
  "organization",
  "legalEntity",
  "property",
  "user",
  "session",
  "role",
  "permission",
  "rolePermission",
  "userPropertyRole",
  "userRoleAssignment",
  "propertyGroup",
  "propertyGroupMember",
  "roleThreshold",
  "approvalRequest",
  "supervisorAuthorization",
  "breakGlassSession",
  "auditEvent",
  "mfaChallenge"
] as const;

export type FakePrisma = Record<(typeof MODELS)[number], ReturnType<typeof delegate>> & { $tables: Tables };

export function fakePrisma(seed: Partial<Tables> = {}): FakePrisma {
  const tables: Tables = {};
  for (const model of MODELS) tables[model] = (seed[model] ?? []).map((row) => ({ ...row }));
  const client = { $tables: tables } as Record<string, unknown>;
  for (const model of MODELS) client[model] = delegate(tables, model);
  return client as FakePrisma;
}

// ---------------------------------------------------------------------------
// Fixture builders shared by the rbac tests
// ---------------------------------------------------------------------------

export type SeededRole = { id: string; organizationId: string; name: string; templateKey: string | null; level: string | null; department: string | null; managed: boolean; templateVersion: number };

/** Roles from templates with their role_permissions, permissions catalogue rows included. */
export function seedRoles(tables: Partial<Tables>, organizationId: string, templates: Record<string, readonly string[]>, options: { levelOf?: (template: string) => string | null } = {}): Record<string, SeededRole> {
  const permissions = (tables.permission ??= []);
  const keyToId = new Map<string, string>();
  for (const row of permissions) keyToId.set(row.key as string, row.id as string);
  const ensurePermission = (key: string): string => {
    const existing = keyToId.get(key);
    if (existing) return existing;
    const id = `perm_${key}`;
    permissions.push({ id, key, description: key });
    keyToId.set(key, id);
    return id;
  };
  const roles = (tables.role ??= []);
  const grants = (tables.rolePermission ??= []);
  const out: Record<string, SeededRole> = {};
  for (const [templateKey, keys] of Object.entries(templates)) {
    const role: SeededRole = { id: `role_${organizationId}_${templateKey}`, organizationId, name: templateKey, templateKey, level: options.levelOf ? options.levelOf(templateKey) : null, department: null, managed: true, templateVersion: 2 };
    roles.push({ ...role });
    for (const key of keys) grants.push({ id: nextId("rp"), roleId: role.id, permissionId: ensurePermission(key) });
    out[templateKey] = role;
  }
  return out;
}

export function audits(): { events: Array<Record<string, unknown>>; audit: (input: Record<string, unknown>) => Record<string, unknown> } {
  const events: Array<Record<string, unknown>> = [];
  return {
    events,
    audit: (input) => {
      const event = { id: nextId("aud"), createdAt: new Date().toISOString(), ...input };
      events.push(event);
      return event;
    }
  };
}
