// Spanish labels of the module categories of the product manifest (Tanda 5 · L1c).
// The ModuleManager card eyebrow painted «GUEST · REPUTATION_QUALITY» (category
// code in English plus the module code, browser-roles#13); it now paints only
// the category in Spanish.

/** Spanish label of a module category code of the manifest (`guest`, `finance`…). */
export const MODULE_CATEGORY_LABELS: Record<string, string> = {
  core: "Núcleo",
  ai: "Inteligencia artificial",
  distribution: "Distribución",
  guest: "Huésped",
  operations: "Operaciones",
  finance: "Finanzas",
  compliance: "Cumplimiento",
  asset: "Activos",
  integrations: "Integraciones",
  commercial: "Comercial",
  analytics: "Analítica",
  platform: "Plataforma"
};

export function moduleCategoryLabel(category: string): string {
  return MODULE_CATEGORY_LABELS[category] ?? category;
}
