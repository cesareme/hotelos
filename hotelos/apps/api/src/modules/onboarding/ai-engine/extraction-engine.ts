// Sprint 52 → Tanda L6a: the pure extraction engine lives in @hotelos/ai-tools
// (packages/ai-tools/src/onboarding/extraction-engine.ts) and runs in process
// (synchronous, deterministic). This file re-exports it at the path the sprint
// plan references; the dual-mode wrapper and the gateway were retired.

export {
  classifyDocument,
  extractEntities,
  summarise,
  KNOWN_DOCUMENT_PROFILES,
  type ClassificationResult,
  type ClassifyInput,
  type ExtractInput,
  type ExtractedEntity,
  type ExtractionResult,
  type ExtractionSummary,
  type DetectedDocumentType
} from "@hotelos/ai-tools";
