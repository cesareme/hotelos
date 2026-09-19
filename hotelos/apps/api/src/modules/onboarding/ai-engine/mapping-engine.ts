// Sprint 52 → Tanda L6a: the pure mapping engine lives in @hotelos/ai-tools
// (packages/ai-tools/src/onboarding/mapping-engine.ts) and runs in process
// (synchronous, deterministic). This file re-exports it at the path the sprint
// plan references; the dual-mode wrapper and the gateway were retired.

export {
  generateMappings,
  summariseMappings,
  MAPPING_CATALOGS,
  type MappingSuggestion,
  type MappingType,
  type GenerateMappingsInput
} from "@hotelos/ai-tools";
