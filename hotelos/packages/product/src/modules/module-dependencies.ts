import type { HotelModuleCode } from "./module-codes.js";
import { HOTEL_MODULES } from "./module-manifest.js";

export const MODULE_DEPENDENCIES: Record<HotelModuleCode, HotelModuleCode[]> = HOTEL_MODULES.reduce(
  (accumulator, module) => ({
    ...accumulator,
    [module.code]: module.dependencies
  }),
  {} as Record<HotelModuleCode, HotelModuleCode[]>
);

export function getModuleDependencies(moduleCode: HotelModuleCode): HotelModuleCode[] {
  return MODULE_DEPENDENCIES[moduleCode] ?? [];
}

export function getMissingModuleDependencies(moduleCode: HotelModuleCode, enabledModules: HotelModuleCode[]): HotelModuleCode[] {
  return getModuleDependencies(moduleCode).filter((dependency) => !enabledModules.includes(dependency));
}
