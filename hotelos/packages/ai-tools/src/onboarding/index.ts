// Motores de onboarding compartidos y sin framework (puros y síncronos): los
// consume apps/api (modules/onboarding) directamente. Desde la Tanda L6a no hay
// gateway intermedio: la misma lógica de extracción + mapeo corre en proceso, sin
// código de parseo duplicado.

export * from "./types.js";
export * from "./csv-parser.js";
export * from "./extraction-engine.js";
export * from "./classifier-engine.js";
export * from "./mapping-engine.js";
export * from "./agents.js";
