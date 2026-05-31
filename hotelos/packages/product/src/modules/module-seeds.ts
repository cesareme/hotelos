import { HOTEL_MODULES } from "./module-manifest.js";

export const CORE_ENABLED_MODULES = HOTEL_MODULES.filter((module) => module.isCore).map((module) => module.code);

export function buildModuleSeedRows() {
  return HOTEL_MODULES.map((module) => ({
    code: module.code,
    name: module.name,
    description: module.description,
    category: module.category,
    isCore: module.isCore
  }));
}

export function buildModuleDependencySeedRows() {
  return HOTEL_MODULES.flatMap((module) =>
    module.dependencies.map((dependency) => ({
      moduleCode: module.code,
      requiredModuleCode: dependency
    }))
  );
}
