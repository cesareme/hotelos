import {
  getHotelModuleManifest,
  getMissingModuleDependencies,
  HOTEL_MODULES,
  type HotelModuleCode
} from "@hotelos/product";
import { recordAuditEvent, recordDomainEvent } from "../audit/audit.service.js";
import { requirePermissions } from "../auth/auth.service.js";
import { createId, nowIso } from "../../lib/ids.js";
import { demoStore, type ModuleRecord, type PropertyModuleRecord, type UserContext } from "../../lib/demo-store.js";

function getModuleRecord(moduleCode: HotelModuleCode): ModuleRecord {
  const module = demoStore.modules.find((candidate) => candidate.code === moduleCode);
  if (!module) {
    throw new Error(`Module ${moduleCode} is not seeded.`);
  }

  return module;
}

export function listModuleCatalog() {
  return HOTEL_MODULES.map((module) => ({
    ...module,
    dependencies: module.dependencies,
    status: module.isCore ? "core" : "optional"
  }));
}

export function getModuleDependencies(moduleCode: HotelModuleCode) {
  return {
    module: getHotelModuleManifest(moduleCode),
    dependencies: getHotelModuleManifest(moduleCode).dependencies.map(getHotelModuleManifest)
  };
}

export function listPropertyModules(propertyId: string) {
  const propertyModules = demoStore.propertyModules.filter((propertyModule) => propertyModule.propertyId === propertyId);
  return propertyModules.map((propertyModule) => {
    const module = demoStore.modules.find((candidate) => candidate.id === propertyModule.moduleId);
    return {
      ...propertyModule,
      module
    };
  });
}

export function getEnabledModuleCodes(propertyId: string): HotelModuleCode[] {
  return listPropertyModules(propertyId)
    .filter((propertyModule) => propertyModule.status === "enabled" && propertyModule.module)
    .map((propertyModule) => propertyModule.module!.code);
}

function ensurePropertyModule(propertyId: string, moduleCode: HotelModuleCode): PropertyModuleRecord {
  const module = getModuleRecord(moduleCode);
  let propertyModule = demoStore.propertyModules.find(
    (candidate) => candidate.propertyId === propertyId && candidate.moduleId === module.id
  );

  if (!propertyModule) {
    propertyModule = {
      id: createId("pm"),
      propertyId,
      moduleId: module.id,
      status: module.isCore ? "enabled" : "disabled",
      configurationJson: {},
      enabledAt: module.isCore ? nowIso() : undefined,
      disabledAt: module.isCore ? undefined : nowIso(),
      createdAt: nowIso()
    };
    demoStore.propertyModules.push(propertyModule);
  }

  return propertyModule;
}

export function enablePropertyModule(input: {
  context: UserContext;
  propertyId: string;
  moduleCode: HotelModuleCode;
  configurationJson?: Record<string, unknown>;
  correlationId: string;
}) {
  requirePermissions(input.context, ["modules.enable"]);
  const enabledModules = getEnabledModuleCodes(input.propertyId);
  const missingDependencies = getMissingModuleDependencies(input.moduleCode, enabledModules);
  if (missingDependencies.length > 0) {
    return {
      status: "rejected" as const,
      moduleCode: input.moduleCode,
      missingDependencies
    };
  }

  const propertyModule = ensurePropertyModule(input.propertyId, input.moduleCode);
  const before = { ...propertyModule };
  propertyModule.status = "enabled";
  propertyModule.enabledAt = nowIso();
  propertyModule.disabledAt = undefined;
  propertyModule.configurationJson = input.configurationJson ?? propertyModule.configurationJson;

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

export function disablePropertyModule(input: {
  context: UserContext;
  propertyId: string;
  moduleCode: HotelModuleCode;
  correlationId: string;
}) {
  requirePermissions(input.context, ["modules.disable"]);
  const module = getModuleRecord(input.moduleCode);
  if (module.isCore) {
    return {
      status: "rejected" as const,
      moduleCode: input.moduleCode,
      reason: "Core modules cannot be disabled."
    };
  }

  const propertyModule = ensurePropertyModule(input.propertyId, input.moduleCode);
  const before = { ...propertyModule };
  propertyModule.status = "disabled";
  propertyModule.disabledAt = nowIso();

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
