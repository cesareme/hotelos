import { prisma } from "@hotelos/database";
import { TOOL_DEFINITIONS, type ToolDefinition } from "@hotelos/ai-tools";
import { getHotelModuleManifest, type HotelModuleCode } from "@hotelos/product";
import type { PermissionKey, RiskLevel } from "@hotelos/shared";
import type { UserContext } from "../../lib/demo-store.js";
import { requirePermissions } from "../auth/auth.service.js";
import { recordAuditEvent } from "../audit/audit.service.js";
import { createId } from "../../lib/ids.js";

// ---------------------------------------------------------------------------
// Permission keys
//   reads  -> ai_governance.read   (spec: ai_governance.read)
//   writes -> ai_tool_registry.manage (spec asked for ai_governance.manage which
//             does not exist; ai_tool_registry.manage is the closest existing key)
// ---------------------------------------------------------------------------
export const TOOL_REGISTRY_READ_PERMISSION: PermissionKey = "ai_governance.read";
export const TOOL_REGISTRY_WRITE_PERMISSION: PermissionKey = "ai_tool_registry.manage";

export const AUTOMATION_LEVELS = ["off", "suggest", "suggest_and_confirm", "autonomous"] as const;
export type AutomationLevel = (typeof AUTOMATION_LEVELS)[number];

// ---------------------------------------------------------------------------
// Code-definition lookups (description + requiredPermissions live in code only)
// ---------------------------------------------------------------------------
const DEFINITION_BY_NAME: Map<string, ToolDefinition> = new Map(
  TOOL_DEFINITIONS.map((definition) => [definition.name as string, definition])
);

function moduleDisplayName(moduleCode: string): string {
  try {
    return getHotelModuleManifest(moduleCode as HotelModuleCode).name;
  } catch {
    return moduleCode;
  }
}

// ---------------------------------------------------------------------------
// Result shapes
// ---------------------------------------------------------------------------
export type ToolRegistrySyncResult = { synced: number; deactivated: number };

export type ToolListItem = {
  toolName: string;
  moduleCode: string;
  moduleName: string;
  riskLevel: string;
  requiresConfirmation: boolean;
  active: boolean;
  inputSchemaVersion: string | null;
  outputSchemaVersion: string | null;
  createdAt: string;
  // joined from code definition
  description: string | null;
  requiredPermissions: PermissionKey[];
  inCode: boolean;
  // per-property setting summary
  propertySettingCount: number;
  enabledPropertyCount: number;
};

export type ToolDetail = ToolListItem & {
  propertySettings: PropertyToolSetting[];
};

export type PropertyToolSetting = {
  toolName: string;
  moduleCode: string;
  moduleName: string;
  riskLevel: string;
  description: string | null;
  requiredPermissions: PermissionKey[];
  registryRequiresConfirmation: boolean;
  registryActive: boolean;
  // setting (defaults when unconfigured)
  configured: boolean;
  enabled: boolean;
  automationLevel: AutomationLevel;
  requiresConfirmation: boolean;
  requiresApprovalRole: string | null;
  configurationJson: Record<string, unknown>;
};

export type ToolRegistryStats = {
  totalTools: number;
  activeTools: number;
  inactiveTools: number;
  requiringConfirmation: number;
  pctRequiringConfirmation: number;
  byRisk: Record<RiskLevel, number>;
  byModule: Array<{ moduleCode: string; moduleName: string; count: number; active: number }>;
};

// ---------------------------------------------------------------------------
// syncToolRegistry
// ---------------------------------------------------------------------------
export async function syncToolRegistry(context?: UserContext): Promise<ToolRegistrySyncResult> {
  if (context) requirePermissions(context, [TOOL_REGISTRY_WRITE_PERMISSION]);

  const codeToolNames = new Set<string>();
  let synced = 0;

  for (const definition of TOOL_DEFINITIONS) {
    codeToolNames.add(definition.name as string);
    await prisma.aiToolRegistry.upsert({
      where: { toolName: definition.name as string },
      create: {
        toolName: definition.name as string,
        moduleCode: definition.moduleCode,
        riskLevel: definition.riskLevel,
        requiresConfirmation: definition.requiresConfirmation,
        active: true
      },
      update: {
        moduleCode: definition.moduleCode,
        riskLevel: definition.riskLevel,
        requiresConfirmation: definition.requiresConfirmation,
        active: true
      }
    });
    synced += 1;
  }

  // Deactivate (never delete) registry rows for tools no longer present in code.
  const existing = await prisma.aiToolRegistry.findMany({ select: { toolName: true, active: true } });
  const orphanNames = existing
    .filter((row) => !codeToolNames.has(row.toolName) && row.active)
    .map((row) => row.toolName);

  let deactivated = 0;
  if (orphanNames.length > 0) {
    const result = await prisma.aiToolRegistry.updateMany({
      where: { toolName: { in: orphanNames } },
      data: { active: false }
    });
    deactivated = result.count;
  }

  if (context) {
    recordAuditEvent({
      organizationId: context.organizationId,
      actorUserId: context.userId,
      actorType: "user",
      action: "AI_TOOL_REGISTRY_SYNCED",
      entityType: "ai_tool_registry",
      entityId: "registry",
      afterJson: { synced, deactivated },
      correlationId: createId("corr")
    });
  }

  return { synced, deactivated };
}

// ---------------------------------------------------------------------------
// listTools
// ---------------------------------------------------------------------------
export async function listTools(input: {
  context?: UserContext;
  moduleCode?: string;
  riskLevel?: string;
  search?: string;
}): Promise<ToolListItem[]> {
  if (input.context) requirePermissions(input.context, [TOOL_REGISTRY_READ_PERMISSION]);

  const rows = await prisma.aiToolRegistry.findMany({
    where: {
      ...(input.moduleCode ? { moduleCode: input.moduleCode } : {}),
      ...(input.riskLevel ? { riskLevel: input.riskLevel } : {})
    },
    orderBy: [{ moduleCode: "asc" }, { toolName: "asc" }]
  });

  // Per-property setting summary in one grouped query (avoids N+1).
  const settingGroups = await prisma.propertyAiToolSetting.groupBy({
    by: ["toolName"],
    _count: { _all: true }
  });
  const enabledGroups = await prisma.propertyAiToolSetting.groupBy({
    by: ["toolName"],
    where: { enabled: true },
    _count: { _all: true }
  });
  const settingCountByTool = new Map(settingGroups.map((g) => [g.toolName, g._count._all]));
  const enabledCountByTool = new Map(enabledGroups.map((g) => [g.toolName, g._count._all]));

  const search = input.search?.trim().toLowerCase();

  return rows
    .map((row) => {
      const definition = DEFINITION_BY_NAME.get(row.toolName);
      const item: ToolListItem = {
        toolName: row.toolName,
        moduleCode: row.moduleCode,
        moduleName: moduleDisplayName(row.moduleCode),
        riskLevel: row.riskLevel,
        requiresConfirmation: row.requiresConfirmation,
        active: row.active,
        inputSchemaVersion: row.inputSchemaVersion ?? null,
        outputSchemaVersion: row.outputSchemaVersion ?? null,
        createdAt: row.createdAt.toISOString(),
        description: definition?.description ?? null,
        requiredPermissions: definition?.requiredPermissions ?? [],
        inCode: Boolean(definition),
        propertySettingCount: settingCountByTool.get(row.toolName) ?? 0,
        enabledPropertyCount: enabledCountByTool.get(row.toolName) ?? 0
      };
      return item;
    })
    .filter((item) => {
      if (!search) return true;
      return (
        item.toolName.toLowerCase().includes(search) ||
        item.moduleCode.toLowerCase().includes(search) ||
        item.moduleName.toLowerCase().includes(search) ||
        (item.description ?? "").toLowerCase().includes(search)
      );
    });
}

// ---------------------------------------------------------------------------
// getTool
// ---------------------------------------------------------------------------
export async function getTool(input: { context?: UserContext; toolName: string }): Promise<ToolDetail> {
  if (input.context) requirePermissions(input.context, [TOOL_REGISTRY_READ_PERMISSION]);

  const row = await prisma.aiToolRegistry.findUnique({ where: { toolName: input.toolName } });
  if (!row) {
    throw new Error(`Tool ${input.toolName} is not in the registry. Run sync if it exists in code.`);
  }

  const definition = DEFINITION_BY_NAME.get(row.toolName);
  const settingRows = await prisma.propertyAiToolSetting.findMany({
    where: { toolName: input.toolName },
    orderBy: { propertyId: "asc" }
  });

  const propertySettings: PropertyToolSetting[] = settingRows.map((setting) =>
    mapSetting({ registry: row, definition, setting, propertyId: setting.propertyId })
  );

  return {
    toolName: row.toolName,
    moduleCode: row.moduleCode,
    moduleName: moduleDisplayName(row.moduleCode),
    riskLevel: row.riskLevel,
    requiresConfirmation: row.requiresConfirmation,
    active: row.active,
    inputSchemaVersion: row.inputSchemaVersion ?? null,
    outputSchemaVersion: row.outputSchemaVersion ?? null,
    createdAt: row.createdAt.toISOString(),
    description: definition?.description ?? null,
    requiredPermissions: definition?.requiredPermissions ?? [],
    inCode: Boolean(definition),
    propertySettingCount: settingRows.length,
    enabledPropertyCount: settingRows.filter((s) => s.enabled).length,
    propertySettings
  };
}

// ---------------------------------------------------------------------------
// listPropertyToolSettings — LEFT join registry so unconfigured tools show defaults
// ---------------------------------------------------------------------------
export async function listPropertyToolSettings(input: {
  context?: UserContext;
  propertyId: string;
}): Promise<PropertyToolSetting[]> {
  if (input.context) requirePermissions(input.context, [TOOL_REGISTRY_READ_PERMISSION]);

  const [registryRows, settingRows] = await Promise.all([
    prisma.aiToolRegistry.findMany({ orderBy: [{ moduleCode: "asc" }, { toolName: "asc" }] }),
    prisma.propertyAiToolSetting.findMany({ where: { propertyId: input.propertyId } })
  ]);

  const settingByTool = new Map(settingRows.map((s) => [s.toolName, s]));

  return registryRows.map((registry) =>
    mapSetting({
      registry,
      definition: DEFINITION_BY_NAME.get(registry.toolName),
      setting: settingByTool.get(registry.toolName) ?? null,
      propertyId: input.propertyId
    })
  );
}

// ---------------------------------------------------------------------------
// setPropertyToolSetting — upsert by (propertyId, toolName) + autonomous guardrail
// ---------------------------------------------------------------------------
export async function setPropertyToolSetting(input: {
  context?: UserContext;
  propertyId: string;
  toolName: string;
  enabled?: boolean;
  automationLevel?: AutomationLevel;
  requiresConfirmation?: boolean;
  requiresApprovalRole?: string | null;
  configurationJson?: Record<string, unknown>;
}): Promise<PropertyToolSetting> {
  if (input.context) requirePermissions(input.context, [TOOL_REGISTRY_WRITE_PERMISSION]);

  if (input.automationLevel && !AUTOMATION_LEVELS.includes(input.automationLevel)) {
    throw new Error(
      `Invalid automationLevel "${input.automationLevel}". Expected one of: ${AUTOMATION_LEVELS.join(", ")}.`
    );
  }

  const registry = await prisma.aiToolRegistry.findUnique({ where: { toolName: input.toolName } });
  if (!registry) {
    throw new Error(`Tool ${input.toolName} is not in the registry. Run sync first.`);
  }

  const existing = await prisma.propertyAiToolSetting.findUnique({
    where: { propertyId_toolName: { propertyId: input.propertyId, toolName: input.toolName } }
  });

  // Resolve the effective values being persisted (input overrides existing/default).
  const automationLevel: AutomationLevel =
    input.automationLevel ?? ((existing?.automationLevel as AutomationLevel) ?? "suggest_and_confirm");
  const requiresApprovalRole =
    input.requiresApprovalRole !== undefined ? input.requiresApprovalRole : existing?.requiresApprovalRole ?? null;

  // GUARDRAIL: critical/high risk tools cannot run fully autonomous without an approval role.
  if (
    automationLevel === "autonomous" &&
    (registry.riskLevel === "critical" || registry.riskLevel === "high") &&
    !(requiresApprovalRole && requiresApprovalRole.trim())
  ) {
    throw new Error(
      `Tool "${input.toolName}" has riskLevel "${registry.riskLevel}". Autonomous automation requires an approval role (requiresApprovalRole).`
    );
  }

  const data = {
    enabled: input.enabled ?? existing?.enabled ?? true,
    automationLevel,
    requiresConfirmation:
      input.requiresConfirmation ?? existing?.requiresConfirmation ?? registry.requiresConfirmation,
    requiresApprovalRole,
    configurationJson:
      (input.configurationJson ?? (existing?.configurationJson as Record<string, unknown> | undefined) ?? {}) as object
  };

  const saved = await prisma.propertyAiToolSetting.upsert({
    where: { propertyId_toolName: { propertyId: input.propertyId, toolName: input.toolName } },
    create: { propertyId: input.propertyId, toolName: input.toolName, ...data },
    update: data
  });

  if (input.context) {
    recordAuditEvent({
      organizationId: input.context.organizationId,
      propertyId: input.propertyId,
      actorUserId: input.context.userId,
      actorType: "user",
      action: "AI_TOOL_PROPERTY_SETTING_UPDATED",
      entityType: "property_ai_tool_setting",
      entityId: saved.id,
      afterJson: {
        toolName: input.toolName,
        enabled: data.enabled,
        automationLevel: data.automationLevel,
        requiresApprovalRole: data.requiresApprovalRole
      },
      correlationId: createId("corr")
    });
  }

  return mapSetting({
    registry,
    definition: DEFINITION_BY_NAME.get(registry.toolName),
    setting: saved,
    propertyId: input.propertyId
  });
}

// ---------------------------------------------------------------------------
// toolRegistryStats
// ---------------------------------------------------------------------------
export async function toolRegistryStats(context?: UserContext): Promise<ToolRegistryStats> {
  if (context) requirePermissions(context, [TOOL_REGISTRY_READ_PERMISSION]);

  const rows = await prisma.aiToolRegistry.findMany({
    select: { moduleCode: true, riskLevel: true, requiresConfirmation: true, active: true }
  });

  const byRisk: Record<RiskLevel, number> = { low: 0, medium: 0, high: 0, critical: 0 };
  const byModuleMap = new Map<string, { count: number; active: number }>();
  let activeTools = 0;
  let requiringConfirmation = 0;

  for (const row of rows) {
    if (row.riskLevel in byRisk) byRisk[row.riskLevel as RiskLevel] += 1;
    if (row.active) activeTools += 1;
    if (row.requiresConfirmation) requiringConfirmation += 1;
    const bucket = byModuleMap.get(row.moduleCode) ?? { count: 0, active: 0 };
    bucket.count += 1;
    if (row.active) bucket.active += 1;
    byModuleMap.set(row.moduleCode, bucket);
  }

  const totalTools = rows.length;
  const byModule = Array.from(byModuleMap.entries())
    .map(([moduleCode, bucket]) => ({
      moduleCode,
      moduleName: moduleDisplayName(moduleCode),
      count: bucket.count,
      active: bucket.active
    }))
    .sort((a, b) => b.count - a.count);

  return {
    totalTools,
    activeTools,
    inactiveTools: totalTools - activeTools,
    requiringConfirmation,
    pctRequiringConfirmation: totalTools > 0 ? Math.round((requiringConfirmation / totalTools) * 100) : 0,
    byRisk,
    byModule
  };
}

// ---------------------------------------------------------------------------
// internal mapper
// ---------------------------------------------------------------------------
function mapSetting(input: {
  registry: { toolName: string; moduleCode: string; riskLevel: string; requiresConfirmation: boolean; active: boolean };
  definition: ToolDefinition | undefined;
  setting:
    | {
        enabled: boolean;
        automationLevel: string;
        requiresConfirmation: boolean;
        requiresApprovalRole: string | null;
        configurationJson: unknown;
      }
    | null;
  propertyId: string;
}): PropertyToolSetting {
  const { registry, definition, setting } = input;
  return {
    toolName: registry.toolName,
    moduleCode: registry.moduleCode,
    moduleName: moduleDisplayName(registry.moduleCode),
    riskLevel: registry.riskLevel,
    description: definition?.description ?? null,
    requiredPermissions: definition?.requiredPermissions ?? [],
    registryRequiresConfirmation: registry.requiresConfirmation,
    registryActive: registry.active,
    configured: Boolean(setting),
    enabled: setting?.enabled ?? true,
    automationLevel: (setting?.automationLevel as AutomationLevel) ?? "suggest_and_confirm",
    requiresConfirmation: setting?.requiresConfirmation ?? registry.requiresConfirmation,
    requiresApprovalRole: setting?.requiresApprovalRole ?? null,
    configurationJson: (setting?.configurationJson as Record<string, unknown>) ?? {}
  };
}
