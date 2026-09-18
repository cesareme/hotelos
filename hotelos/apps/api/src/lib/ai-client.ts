// Instancia única de @hotelos/ai-core para el API (Tanda L6a, lote 2). Construye el
// núcleo con la configuración de lib/ai-config.ts, el limitador por organización
// (token bucket en memoria por proceso) y una fuente de prompts publicados que se
// registra más tarde con `setAiPromptSource` (lo hace governance.service.ts en el
// lote 4; así se evita el ciclo governance → llm → governance).

import { createAiCore, createRateLimiter } from "@hotelos/ai-core";
import type { AiConfigInput, AiCore, PromptSource } from "@hotelos/ai-core";
import { getAiConfig, resetAiConfigForTests } from "./ai-config.js";

export type AiPromptLookup = PromptSource["getPublishedPrompt"];

let promptLookup: AiPromptLookup | null = null;
let fetchOverride: typeof fetch | undefined;
let core: AiCore | null = null;

/** Delegación tardía: el núcleo se crea antes de que gobernanza registre su lector de prompts. */
const delegatingPromptSource: PromptSource = {
  getPublishedPrompt: (code) => (promptLookup ? promptLookup(code) : Promise.resolve(null))
};

/** Registra (o retira con null) el lector de prompts publicados (ai_prompt_versions). */
export function setAiPromptSource(lookup: AiPromptLookup | null): void {
  promptLookup = lookup;
}

function buildCore(): AiCore {
  const config = getAiConfig();
  return createAiCore({
    config,
    limiter: createRateLimiter({ perMinute: config.rateLimitPerMinute }),
    promptSource: delegatingPromptSource,
    ...(fetchOverride ? { fetchImpl: fetchOverride } : {})
  });
}

/** Núcleo de IA compartido por todo el proceso del API. */
export function getAiCore(): AiCore {
  core ??= buildCore();
  return core;
}

export type ResetAiCoreOptions = {
  /** fetch simulado (tests sin red). */
  fetchImpl?: typeof fetch;
  /** Entorno del que leer AI_* (defecto process.env; pasa {} para un entorno vacío). */
  env?: NodeJS.ProcessEnv;
  /** Valores crudos que sustituyen a los del entorno. */
  overrides?: Partial<AiConfigInput>;
};

/** Reconstruye configuración y núcleo. Solo tests. */
export function resetAiCoreForTests(options: ResetAiCoreOptions = {}): AiCore {
  fetchOverride = options.fetchImpl;
  resetAiConfigForTests(options.overrides ?? {}, options.env ?? process.env);
  core = buildCore();
  return core;
}
