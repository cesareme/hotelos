// ai-gateway onboarding endpoints. These run the SAME pure extraction,
// classification and mapping engines that the API uses in stub mode — both
// import them from @hotelos/ai-tools, so there is a single source of truth and
// no duplicated parsing code.
//
// In real mode the API delegates here. This is the seam where, in production,
// an LLM would be invoked for classification/semantic mapping; for now the
// gateway runs the deterministic engine so the contract is testable offline.

import type { FastifyInstance } from "fastify";
import {
  classifyDocument,
  extractEntities,
  generateMappings,
  summariseMappings,
  type ClassifyInput,
  type ExtractInput,
  type GenerateMappingsInput
} from "@hotelos/ai-tools";

export function registerOnboardingEngineRoutes(app: FastifyInstance): void {
  app.post("/ai/onboarding/classify", async (request) => {
    const body = request.body as ClassifyInput;
    return classifyDocument(body);
  });

  app.post("/ai/onboarding/extract", async (request) => {
    const body = request.body as ExtractInput;
    return extractEntities(body);
  });

  app.post("/ai/onboarding/generate-mappings", async (request) => {
    const body = request.body as GenerateMappingsInput;
    const suggestions = generateMappings(body);
    return { suggestions, summary: summariseMappings(suggestions) };
  });
}
