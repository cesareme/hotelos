// Dual-mode onboarding AI engine wrapper.
//
//   AI_GATEWAY_MODE = "stub" (default) -> run the shared pure engine locally.
//   AI_GATEWAY_MODE = "real"           -> delegate to the ai-gateway over HTTP,
//                                          falling back to the local stub on error.
//
// The shared pure functions live in @hotelos/ai-tools (packages/ai-tools/src/
// onboarding) so the gateway and the API run the EXACT same logic.

import {
  classifyDocument,
  extractEntities,
  generateMappings,
  summarise,
  summariseMappings,
  type ClassificationResult,
  type ClassifyInput,
  type ExtractInput,
  type ExtractionResult,
  type GenerateMappingsInput,
  type MappingSuggestion
} from "@hotelos/ai-tools";

function isRealMode(): boolean {
  return (process.env.AI_GATEWAY_MODE ?? "stub").toLowerCase() === "real";
}

function gatewayUrl(): string {
  return process.env.AI_GATEWAY_URL ?? "http://localhost:4000";
}

async function postToGateway<TResponse>(path: string, body: unknown): Promise<TResponse> {
  const response = await fetch(`${gatewayUrl()}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    throw new Error(`ai-gateway call failed: ${response.status} ${response.statusText}`);
  }
  return (await response.json()) as TResponse;
}

export async function classifyDocumentDualMode(input: ClassifyInput): Promise<ClassificationResult> {
  if (isRealMode()) {
    try {
      return await postToGateway<ClassificationResult>("/ai/onboarding/classify", input);
    } catch (error) {
      console.error("[onboarding] gateway classify failed, falling back to local stub:", error);
    }
  }
  return classifyDocument(input);
}

export async function extractEntitiesDualMode(input: ExtractInput): Promise<ExtractionResult> {
  if (isRealMode()) {
    try {
      return await postToGateway<ExtractionResult>("/ai/onboarding/extract", input);
    } catch (error) {
      console.error("[onboarding] gateway extract failed, falling back to local stub:", error);
    }
  }
  return extractEntities(input);
}

export async function generateMappingsDualMode(
  input: GenerateMappingsInput
): Promise<{ suggestions: MappingSuggestion[]; summary: ReturnType<typeof summariseMappings> }> {
  if (isRealMode()) {
    try {
      return await postToGateway<{ suggestions: MappingSuggestion[]; summary: ReturnType<typeof summariseMappings> }>(
        "/ai/onboarding/generate-mappings",
        input
      );
    } catch (error) {
      console.error("[onboarding] gateway generate-mappings failed, falling back to local stub:", error);
    }
  }
  const suggestions = generateMappings(input);
  return { suggestions, summary: summariseMappings(suggestions) };
}

export { summarise };
