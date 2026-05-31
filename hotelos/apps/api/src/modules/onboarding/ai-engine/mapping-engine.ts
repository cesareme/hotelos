// Sprint 52: the pure mapping engine lives in @hotelos/ai-tools
// (packages/ai-tools/src/onboarding/mapping-engine.ts) so the SAME logic runs
// in both the API (stub mode) and the ai-gateway (real mode). This file
// re-exports it at the path the sprint plan references, plus the dual-mode
// wrapper.

export {
  generateMappings,
  summariseMappings,
  MAPPING_CATALOGS,
  type MappingSuggestion,
  type MappingType,
  type GenerateMappingsInput
} from "@hotelos/ai-tools";

export { generateMappingsDualMode } from "./dual-mode-engine.js";
