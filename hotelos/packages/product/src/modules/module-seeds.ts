import { DEFAULT_ENABLED_MODULE_CODES, HOTEL_MODULES } from "./module-manifest.js";

// ---------------------------------------------------------------------------
// DECISIÓN REVERSIBLE (Tanda 5, §14.1 de pilots/tanda5-nav-tree.md) — PENDIENTE
// DE CÉSAR. Until Tanda 5 only `pms_core` (isCore) was enabled for a new
// property; the proposal adds housekeeping, maintenance, compliance_hub,
// compliance_billing, spain_guest_register_compliance, erp_accounting,
// guest_experience and outlet_pos so ModuleManager stops showing «desactivado»
// for what already works and provisioning creates hotels with Pisos and
// Facturación. The set lives in DEFAULT_ENABLED_MODULE_CODES
// (module-manifest.ts): to revert, shorten that list. `isCore` is untouched,
// so the modules stay disable-able and existing property_modules rows keep
// their status.
// ---------------------------------------------------------------------------

/** Modules a new property starts with (`isCore` or default-enabled by §14.1). */
export const DEFAULT_ENABLED_MODULES = HOTEL_MODULES.filter((module) => module.enabledByDefault).map((module) => module.code);

/**
 * Kept under its historical name for consumers of the seed contract; since
 * Tanda 5 it means «enabled by default», not «cannot be disabled» (that is
 * `isCore`, still only `pms_core`).
 */
export const CORE_ENABLED_MODULES = DEFAULT_ENABLED_MODULES;

/** Sanity: every code of the §14.1 list must exist in the manifest. */
const unknownDefaultCodes = DEFAULT_ENABLED_MODULE_CODES.filter((code) => !HOTEL_MODULES.some((module) => module.code === code));
if (unknownDefaultCodes.length > 0) {
  throw new Error(`DEFAULT_ENABLED_MODULE_CODES references unknown modules: ${unknownDefaultCodes.join(", ")}`);
}

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
