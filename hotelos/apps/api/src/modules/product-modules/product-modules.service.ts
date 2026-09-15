// Product modules — per-property module state persisted in Prisma
// (Module + PropertyModule) so enable/disable survives restarts.
//
// Persistence notes (persistencia tanda 2, patrón assets.service.ts):
//  - The module CATALOG (ModuleRecord/manifests) stays static in memory: it is
//    code, not state. What persists is the per-property state (PropertyModule).
//  - Writes are DUAL-WRITE: Prisma first (source of truth), then the in-memory
//    demo store is mirrored with the SAME row id, because legacy sync readers
//    (getEnabledModuleCodes, backoffice module snapshots) still consume
//    demoStore.propertyModules directly.
//  - Demo fixture rows (mod_* / pm_prop_123_*) are copied once per process into
//    Prisma (createMany + skipDuplicates, same ids) before the first read/write
//    so fixture module states stay updatable and dependency checks see them.
//  - Module rows are resolved by CODE (like tenant-admin.toggleTenantModule):
//    if the DB already has a row for the code we reuse its id; otherwise we
//    materialise it from the static catalog with the demo id. The demoStore
//    mirror always keeps the demo catalog id in `moduleId` so legacy joins
//    against demoStore.modules keep working even if DB module ids diverge.
import {
  getHotelModuleManifest,
  getMissingModuleDependencies,
  HOTEL_MODULES,
  type HotelModuleCode
} from "@hotelos/product";
import { prisma } from "@hotelos/database";
import type { Prisma } from "@hotelos/database";
import { recordAuditEvent, recordDomainEvent } from "../audit/audit.service.js";
import { requirePermissions } from "../auth/auth.service.js";
import { createId, nowIso } from "../../lib/ids.js";
import { ConflictError } from "../../lib/http-error.js";
import { demoStore, type ModuleRecord, type PropertyModuleRecord, type UserContext } from "../../lib/demo-store.js";

type PropertyModuleRow = NonNullable<Awaited<ReturnType<typeof prisma.propertyModule.findUnique>>>;

const asJson = (value: Record<string, unknown> | undefined): Prisma.InputJsonValue => (value ?? {}) as Prisma.InputJsonValue;

function toDbDate(value: string | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Prisma row -> legacy record shape. `catalogModuleId` is the demo catalog id
 * (demoStore.modules) so sync readers can keep joining by moduleId.
 */
function toPropertyModuleRecord(row: PropertyModuleRow, catalogModuleId: string): PropertyModuleRecord {
  return {
    id: row.id,
    propertyId: row.propertyId,
    moduleId: catalogModuleId,
    status: row.status as PropertyModuleRecord["status"],
    configurationJson: (row.configurationJson as Record<string, unknown> | null) ?? {},
    enabledAt: row.enabledAt ? row.enabledAt.toISOString() : undefined,
    disabledAt: row.disabledAt ? row.disabledAt.toISOString() : undefined,
    createdAt: row.createdAt.toISOString()
  };
}

/** Insert-or-update the mirror record in demoStore (keeps object identity). */
function mirrorPropertyModule(record: PropertyModuleRecord): PropertyModuleRecord {
  const existing = demoStore.propertyModules.find((candidate) => candidate.id === record.id);
  if (existing) {
    Object.assign(existing, record);
    return existing;
  }
  demoStore.propertyModules.push(record);
  return record;
}

/** Spanish display name of a module (manifest first; the demo catalog as fallback). */
function moduleDisplayName(moduleCode: HotelModuleCode): string {
  try {
    return getHotelModuleManifest(moduleCode).name;
  } catch {
    return demoStore.modules.find((candidate) => candidate.code === moduleCode)?.name ?? moduleCode;
  }
}

/**
 * Tanda 5 (L1c · api): enabling a module whose dependencies are not active
 * is a CONFLICT (409), never a 200 with `status: "rejected"` — the front
 * announced «activado» on any 2xx. The Spanish message names the missing
 * modules; `details` carries the codes and names so the module card can
 * link to them. Pure (no DB) so the unit test covers it.
 */
export function moduleDependenciesConflict(moduleCode: HotelModuleCode, missingDependencies: HotelModuleCode[]): ConflictError {
  const missingDependencyNames = missingDependencies.map(moduleDisplayName);
  return new ConflictError(
    `No se puede activar ${moduleDisplayName(moduleCode)}: falta activar ${missingDependencyNames.join(", ")}.`,
    { code: "MODULE_DEPENDENCIES_MISSING", moduleCode, missingDependencies, missingDependencyNames }
  );
}

/** Same rule for disabling an essential module (`isCore`): 409 with a Spanish message. */
export function coreModuleConflict(moduleCode: HotelModuleCode): ConflictError {
  return new ConflictError(`No se puede desactivar ${moduleDisplayName(moduleCode)}: es un módulo esencial.`, {
    code: "CORE_MODULE",
    moduleCode
  });
}

function getModuleRecord(moduleCode: HotelModuleCode): ModuleRecord {
  const module = demoStore.modules.find((candidate) => candidate.code === moduleCode);
  if (!module) {
    throw new Error(`Module ${moduleCode} is not seeded.`);
  }

  return module;
}

// ---------------------------------------------------------------------------
// One-shot sync of legacy demo fixtures into Prisma (same ids, idempotent)
// ---------------------------------------------------------------------------

let fixtureSyncPromise: Promise<void> | null = null;

function ensureModuleStatePersisted(): Promise<void> {
  if (!fixtureSyncPromise) {
    fixtureSyncPromise = persistLegacyModuleState().catch((error) => {
      fixtureSyncPromise = null; // allow a retry on the next call
      throw error;
    });
  }
  return fixtureSyncPromise;
}

async function persistLegacyModuleState(): Promise<void> {
  if (demoStore.modules.length > 0) {
    await prisma.module.createMany({
      data: demoStore.modules.map((module) => ({
        id: module.id,
        code: module.code,
        name: module.name,
        description: module.description ?? null,
        category: module.category,
        isCore: module.isCore,
        createdAt: new Date(module.createdAt)
      })),
      skipDuplicates: true
    });
  }
  if (demoStore.propertyModules.length === 0) {
    return;
  }
  // Resolve fixture module ids to the persisted Module row ids (they are the
  // same in a pristine demo; a pre-existing DB catalog keeps its own ids).
  const moduleRows = await prisma.module.findMany({ select: { id: true, code: true } });
  const dbIdByCode = new Map(moduleRows.map((row) => [row.code, row.id]));
  const data = demoStore.propertyModules.flatMap((propertyModule) => {
    const catalog = demoStore.modules.find((candidate) => candidate.id === propertyModule.moduleId);
    const dbModuleId = catalog ? dbIdByCode.get(catalog.code) : undefined;
    if (!dbModuleId) return [];
    return [
      {
        id: propertyModule.id,
        propertyId: propertyModule.propertyId,
        moduleId: dbModuleId,
        status: propertyModule.status,
        configurationJson: asJson(propertyModule.configurationJson),
        enabledAt: toDbDate(propertyModule.enabledAt),
        disabledAt: toDbDate(propertyModule.disabledAt),
        createdAt: new Date(propertyModule.createdAt)
      }
    ];
  });
  if (data.length > 0) {
    await prisma.propertyModule.createMany({ data, skipDuplicates: true });
  }
}

/** Module row id in Prisma for a catalog record (resolved by code, materialised if missing). */
async function resolveDbModuleId(module: ModuleRecord): Promise<string> {
  const row = await prisma.module.findUnique({ where: { code: module.code }, select: { id: true } });
  if (row) return row.id;
  const created = await prisma.module.upsert({
    where: { code: module.code },
    update: {},
    create: {
      id: module.id,
      code: module.code,
      name: module.name,
      description: module.description ?? null,
      category: module.category,
      isCore: module.isCore
    },
    select: { id: true }
  });
  return created.id;
}

// ---------------------------------------------------------------------------
// Catalog (static, in-memory by design)
// ---------------------------------------------------------------------------

/**
 * Static catalog. Each entry carries the manifest as-is, including (Tanda 5):
 *  - `enabledByDefault`: starts enabled in a new property (§14.1, reversible;
 *    `isCore` still means «cannot be disabled» and is only `pms_core`);
 *  - `menuEntries`: the menu items and tabs of the Tanda 5 navigation tree the
 *    module unlocks, so ModuleManager can show «qué entradas desbloquea».
 * `status` keeps its historical values ("core" | "optional") for existing
 * readers; `defaultEnabled` is the additive flag for the new default.
 */
export function listModuleCatalog() {
  return HOTEL_MODULES.map((module) => ({
    ...module,
    dependencies: module.dependencies,
    status: module.isCore ? "core" : "optional",
    defaultEnabled: module.enabledByDefault,
    unlocks: module.menuEntries
  }));
}

export function getModuleDependencies(moduleCode: HotelModuleCode) {
  return {
    module: getHotelModuleManifest(moduleCode),
    dependencies: getHotelModuleManifest(moduleCode).dependencies.map(getHotelModuleManifest)
  };
}

// ---------------------------------------------------------------------------
// Per-property module state (persisted)
// ---------------------------------------------------------------------------

export async function listPropertyModules(propertyId: string) {
  await ensureModuleStatePersisted();
  const [rows, moduleRows] = await Promise.all([
    prisma.propertyModule.findMany({ where: { propertyId } }),
    prisma.module.findMany({ select: { id: true, code: true } })
  ]);
  const codeByDbId = new Map(moduleRows.map((row) => [row.id, row.code]));
  for (const row of rows) {
    const code = codeByDbId.get(row.moduleId);
    const catalog = demoStore.modules.find((candidate) => candidate.code === code);
    mirrorPropertyModule(toPropertyModuleRecord(row, catalog?.id ?? row.moduleId));
  }
  return demoStore.propertyModules
    .filter((propertyModule) => propertyModule.propertyId === propertyId)
    .map((propertyModule) => {
      const module = demoStore.modules.find((candidate) => candidate.id === propertyModule.moduleId);
      return {
        ...propertyModule,
        module
      };
    });
}

/**
 * Boot-time hydration (Tanda 1, tenant-hydration.ts): mirror EVERY persisted
 * PropertyModule row into demoStore so the synchronous module gate
 * (getEnabledModuleCodes → requireAdvancedModuleEnabled) sees real tenants
 * (Faranda & co.) before any per-property read has run. Same mapping as
 * listPropertyModules (DB module id → catalog code → demo catalog id), merge
 * by row id (never replaces the prop_123 fixtures). Returns rows mirrored.
 */
export async function hydrateAllPropertyModules(): Promise<number> {
  await ensureModuleStatePersisted();
  const [rows, moduleRows] = await Promise.all([
    prisma.propertyModule.findMany(),
    prisma.module.findMany({ select: { id: true, code: true } })
  ]);
  const codeByDbId = new Map(moduleRows.map((row) => [row.id, row.code]));
  for (const row of rows) {
    const code = codeByDbId.get(row.moduleId);
    const catalog = demoStore.modules.find((candidate) => candidate.code === code);
    mirrorPropertyModule(toPropertyModuleRecord(row, catalog?.id ?? row.moduleId));
  }
  return rows.length;
}

/**
 * Sync on purpose: consumed inside synchronous flows (advanced-modules module
 * gating). Reads the demoStore mirror, which dual-writes keep up to date and
 * async reads re-hydrate from Prisma.
 */
export function getEnabledModuleCodes(propertyId: string): HotelModuleCode[] {
  const rows = demoStore.propertyModules.filter((propertyModule) => propertyModule.propertyId === propertyId);
  const codeOf = (propertyModule: PropertyModuleRecord): HotelModuleCode | undefined =>
    demoStore.modules.find((candidate) => candidate.id === propertyModule.moduleId)?.code as HotelModuleCode | undefined;
  const withRow = new Set(rows.map(codeOf).filter((code): code is HotelModuleCode => Boolean(code)));
  const enabled = rows
    .filter((propertyModule) => propertyModule.status === "enabled")
    .map(codeOf)
    .filter((code): code is HotelModuleCode => Boolean(code));
  // Tanda 5 (L1b · api-side): a module the property has never touched is in
  // the state the manifest gives it (`enabledByDefault`: pms_core plus the
  // reversible §14.1 set) — the same default listBackOfficeModules shows and
  // ensurePropertyModulePersisted writes, so the menu, ModuleManager and this
  // gate agree. An explicit row (enabled or disabled) always wins.
  for (const module of HOTEL_MODULES) {
    if (module.enabledByDefault && !withRow.has(module.code)) enabled.push(module.code);
  }
  return enabled;
}

/**
 * Ensure the PropertyModule row exists in Prisma (default status per manifest)
 * and return the demoStore mirror record (same id). Exported so backoffice
 * configureModule persists configuration against the same row.
 */
export async function ensurePropertyModulePersisted(propertyId: string, moduleCode: HotelModuleCode): Promise<PropertyModuleRecord> {
  await ensureModuleStatePersisted();
  const module = getModuleRecord(moduleCode);
  const dbModuleId = await resolveDbModuleId(module);
  let row = await prisma.propertyModule.findUnique({
    where: { propertyId_moduleId: { propertyId, moduleId: dbModuleId } }
  });
  if (!row) {
    // Default status of a row that did not exist yet: the manifest decides
    // (`enabledByDefault` = isCore or the §14.1 list of Tanda 5, reversible in
    // packages/product/src/modules/module-manifest.ts). Existing rows are
    // never touched here, so a property that disabled one of those modules
    // keeps it disabled.
    const enabledByDefault = getHotelModuleManifest(moduleCode).enabledByDefault;
    const now = nowIso();
    row = await prisma.propertyModule.create({
      data: {
        id: createId("pm"),
        propertyId,
        moduleId: dbModuleId,
        status: enabledByDefault ? "enabled" : "disabled",
        configurationJson: asJson({}),
        enabledAt: enabledByDefault ? new Date(now) : null,
        disabledAt: enabledByDefault ? null : new Date(now),
        createdAt: new Date(now)
      }
    });
  }
  return mirrorPropertyModule(toPropertyModuleRecord(row, module.id));
}

export async function enablePropertyModule(input: {
  context: UserContext;
  propertyId: string;
  moduleCode: HotelModuleCode;
  configurationJson?: Record<string, unknown>;
  correlationId: string;
}) {
  requirePermissions(input.context, ["modules.enable"]);
  // Hydrate the mirror from Prisma so the dependency check sees persisted state.
  await listPropertyModules(input.propertyId);
  const enabledModules = getEnabledModuleCodes(input.propertyId);
  const missingDependencies = getMissingModuleDependencies(input.moduleCode, enabledModules);
  if (missingDependencies.length > 0) throw moduleDependenciesConflict(input.moduleCode, missingDependencies);

  const module = getModuleRecord(input.moduleCode);
  const propertyModule = await ensurePropertyModulePersisted(input.propertyId, input.moduleCode);
  const before = { ...propertyModule };
  // Prisma first, then the demoStore mirror (same id).
  const row = await prisma.propertyModule.update({
    where: { id: propertyModule.id },
    data: {
      status: "enabled",
      enabledAt: new Date(),
      disabledAt: null,
      ...(input.configurationJson !== undefined ? { configurationJson: asJson(input.configurationJson) } : {})
    }
  });
  Object.assign(propertyModule, toPropertyModuleRecord(row, module.id));

  recordAuditEvent({
    organizationId: input.context.organizationId,
    propertyId: input.propertyId,
    actorUserId: input.context.userId,
    actorType: "user",
    action: "ModuleEnabled",
    entityType: "property_module",
    entityId: propertyModule.id,
    beforeJson: before,
    afterJson: propertyModule,
    correlationId: input.correlationId
  });

  recordDomainEvent({
    organizationId: input.context.organizationId,
    propertyId: input.propertyId,
    entityType: "property_module",
    entityId: propertyModule.id,
    eventType: "ModuleEnabled",
    payload: { moduleCode: input.moduleCode },
    actorType: "user",
    actorUserId: input.context.userId,
    correlationId: input.correlationId
  });

  return {
    status: "enabled" as const,
    module: getHotelModuleManifest(input.moduleCode),
    propertyModule
  };
}

export async function disablePropertyModule(input: {
  context: UserContext;
  propertyId: string;
  moduleCode: HotelModuleCode;
  correlationId: string;
}) {
  requirePermissions(input.context, ["modules.disable"]);
  const module = getModuleRecord(input.moduleCode);
  // Core modules cannot be disabled: 409 in Spanish (L1c), no silent "rejected" 200.
  if (module.isCore) throw coreModuleConflict(input.moduleCode);

  const propertyModule = await ensurePropertyModulePersisted(input.propertyId, input.moduleCode);
  const before = { ...propertyModule };
  // Prisma first, then the demoStore mirror (same id).
  const row = await prisma.propertyModule.update({
    where: { id: propertyModule.id },
    data: { status: "disabled", disabledAt: new Date() }
  });
  Object.assign(propertyModule, toPropertyModuleRecord(row, module.id));

  recordAuditEvent({
    organizationId: input.context.organizationId,
    propertyId: input.propertyId,
    actorUserId: input.context.userId,
    actorType: "user",
    action: "ModuleDisabled",
    entityType: "property_module",
    entityId: propertyModule.id,
    beforeJson: before,
    afterJson: propertyModule,
    correlationId: input.correlationId
  });

  recordDomainEvent({
    organizationId: input.context.organizationId,
    propertyId: input.propertyId,
    entityType: "property_module",
    entityId: propertyModule.id,
    eventType: "ModuleDisabled",
    payload: { moduleCode: input.moduleCode },
    actorType: "user",
    actorUserId: input.context.userId,
    correlationId: input.correlationId
  });

  return {
    status: "disabled" as const,
    module: getHotelModuleManifest(input.moduleCode),
    propertyModule
  };
}
