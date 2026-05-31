// Sprint 52: the pure extraction engine lives in @hotelos/ai-tools
// (packages/ai-tools/src/onboarding/extraction-engine.ts) so the SAME logic
// runs in both the API (stub mode) and the ai-gateway (real mode). This file
// re-exports it at the path the sprint plan references, and re-exports the
// dual-mode wrapper that decides stub vs gateway.

export {
  extractEntities,
  summarise,
  KNOWN_DOCUMENT_PROFILES,
  type ExtractInput,
  type ExtractedEntity,
  type ExtractionResult,
  type ExtractionSummary,
  type DetectedDocumentType
} from "@hotelos/ai-tools";

export { extractEntitiesDualMode, classifyDocumentDualMode } from "./dual-mode-engine.js";
