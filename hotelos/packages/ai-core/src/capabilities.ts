// Capacidades por familia de modelo (referencia claude-api, tabla del
// 2026-06-24, recon §2.11). Se resuelve por prefijo del identificador para que
// los alias fechados (claude-haiku-4-5-20251001) compartan fila.
//
//   sampling        admite temperature/top_p/top_k (Sonnet 5 y Opus 5 → 400)
//   effort          admite output_config.effort (error en Haiku 4.5)
//   thinking        "adaptive": razonamiento adaptativo POR DEFECTO si se omite
//                   `thinking` (Sonnet 5 / Opus 5; `budget_tokens` → 400);
//                   "budget": solo con `{ type:"enabled", budget_tokens }` (Haiku 4.5;
//                   sin él no piensa); "none": desconocido, no se envía nada.
//   thinkingOffSafe true si `{ type:"disabled" }` es la opción segura y barata para
//                   llamadas triviales (Sonnet 5); en Opus 5 desactivarlo tiene dos
//                   modos de fallo documentados (llamadas a herramienta en texto,
//                   fuga de etiquetas): mejor adaptativo con effort bajo.
//   inferenceGeo    admite `inference_geo` (4.6+; Haiku 4.5 → 400 invalid_request_error)
//   cacheMinTokens  mínimo de tokens para que un breakpoint cache_control cachee
//   contextTokens   ventana de contexto
//   maxPdfPages     páginas máximas por bloque document (100 en modelos de 200K)

export type ThinkingSupport = "adaptive" | "budget" | "none";

export type ModelCapabilities = {
  sampling: boolean;
  effort: boolean;
  thinking: ThinkingSupport;
  thinkingOffSafe: boolean;
  inferenceGeo: boolean;
  cacheMinTokens: number;
  contextTokens: number;
  maxPdfPages: number;
};

export const MODEL_CAPABILITY_TABLE: ReadonlyArray<{ prefix: string; capabilities: ModelCapabilities }> = Object.freeze([
  { prefix: "claude-sonnet-5", capabilities: { sampling: false, effort: true, thinking: "adaptive", thinkingOffSafe: true, inferenceGeo: true, cacheMinTokens: 1024, contextTokens: 1_000_000, maxPdfPages: 600 } },
  { prefix: "claude-haiku-4-5", capabilities: { sampling: true, effort: false, thinking: "budget", thinkingOffSafe: false, inferenceGeo: false, cacheMinTokens: 4096, contextTokens: 200_000, maxPdfPages: 100 } },
  { prefix: "claude-opus-5", capabilities: { sampling: false, effort: true, thinking: "adaptive", thinkingOffSafe: false, inferenceGeo: true, cacheMinTokens: 512, contextTokens: 1_000_000, maxPdfPages: 600 } }
]);

/** Modelo desconocido: la opción más conservadora (sin sampling, effort, thinking ni inference_geo; ventana de 200K). */
export const UNKNOWN_MODEL_CAPABILITIES: ModelCapabilities = Object.freeze({
  sampling: false,
  effort: false,
  thinking: "none",
  thinkingOffSafe: false,
  inferenceGeo: false,
  cacheMinTokens: 4096,
  contextTokens: 200_000,
  maxPdfPages: 100
});

export function modelCapabilities(model: string): ModelCapabilities {
  const id = (model ?? "").trim().toLowerCase();
  for (const row of MODEL_CAPABILITY_TABLE) {
    if (id.startsWith(row.prefix)) return { ...row.capabilities };
  }
  return { ...UNKNOWN_MODEL_CAPABILITIES };
}

/** Estimación grosera (chars/4) para decidir si un system merece cache_control. */
export function estimateTokens(text: string): number {
  return Math.ceil((text ?? "").length / 4);
}
