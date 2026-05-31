import type { HotelModuleCode } from "../modules/module-codes.js";
import { HOTEL_MODULES } from "../modules/module-manifest.js";

export const MODULE_PERMISSIONS: Record<HotelModuleCode, string[]> = HOTEL_MODULES.reduce(
  (accumulator, module) => ({
    ...accumulator,
    [module.code]: module.permissions
  }),
  {} as Record<HotelModuleCode, string[]>
);
