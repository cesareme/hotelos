// Reputación · Tanda T8 · lote T8-B — puerto de IA del módulo de reseñas
// (apps/api/src/modules/reputation/reputation-ai.port.ts).
//
// Reglas del fichero:
//   · solo la interfaz, sus tipos y el registro singleton: sin Prisma, sin
//     variables de entorno, sin red, sin proveedor de IA;
//   · la fusión T8 engancha ai-core aquí: reputation-ai.core-adapter.ts
//     (createAiCoreReputationPort, registrado con setReputationAiPort en el
//     arranque del API solo si isLlmConfigured()) llama a `structured`/
//     `complete` con `redactPii`/`restorePii` y recibe la organización en
//     `context` (ai-core la exige; sin ella cae a las reglas); por
//     defecto se usa RulesReputationAi (diccionario + plantillas, etiqueta
//     honesta `dictionary`/`rules`, `configured: false`, `provider: "none"`);
//   · cualquier implementación debe enmascarar el texto antes de enviarlo a
//     un modelo (maskReviewForLlm o redactPii) y nunca inventar hechos.

import type { CategoryMention, Sentiment } from "./reputation-types.js";
import { RulesReputationAi } from "./reputation-ai.rules.js";

export const RESPONSE_TONES = Object.freeze(["formal", "cercano"] as const);
export type ResponseTone = (typeof RESPONSE_TONES)[number];

export type ReputationAiDescription = {
  /** `false` sin proveedor: todo lo que salga lleva etiqueta `dictionary`/`rules`. */
  configured: boolean;
  /** `none`, `anthropic`, … */
  provider: string;
  model?: string;
};

/**
 * Contexto que ai-core exige en cada llamada (presupuesto y límite por
 * organización, telemetría). Lo rellena el llamador (tick, importación,
 * borrador); RulesReputationAi lo ignora.
 */
export type ReputationAiContext = {
  organizationId: string;
  propertyId?: string;
  userId?: string;
  correlationId?: string;
};

export type AnalyzeReviewInput = {
  text: string;
  title?: string;
  /** Idioma declarado por el portal (si lo trae); si no, se detecta. */
  language?: string;
  /** Nota sobre 10; manda sobre la polaridad del texto. */
  score10?: number | null;
  /** Subpuntuaciones del portal (Booking) para menciones `portal_subscore`. */
  subscores?: {
    clean?: number | null;
    staff?: number | null;
    location?: number | null;
    value?: number | null;
    facilities?: number | null;
    comfort?: number | null;
    wifi?: number | null;
  };
  /** Contexto para ai-core (presupuesto, límite por organización, telemetría); sin él el adaptador cae a las reglas. */
  context?: ReputationAiContext;
};

export type AnalyzeReviewOutput = {
  /** `es`, `en`, …, `und`. */
  language: string;
  sentiment: Sentiment;
  /** ≤ 200 caracteres. */
  summary?: string;
  categories: CategoryMention[];
  source: "llm" | "dictionary";
  /** Nota honesta (`llm_not_configured`, `llm_invalid_json`…). */
  note?: string;
  model?: string;
};

export type DraftResponseInput = {
  score10: number | null;
  sentiment: Sentiment;
  /** Idioma de la reseña; `und` → español. */
  language: string;
  categories: ReadonlyArray<CategoryMention>;
  title?: string;
  body?: string;
  hotelName: string;
  tone?: ResponseTone;
  /** Firma alternativa; por defecto «Dirección de <hotelName>». */
  signature?: string;
  /** Contexto para ai-core (presupuesto, límite por organización, telemetría); sin él el adaptador cae a las reglas. */
  context?: ReputationAiContext;
};

export type DraftResponseOutput = {
  /** ≤ 120 palabras, sin datos de la estancia, con firma. */
  body: string;
  source: "ai" | "rules";
  model?: string;
  language: string;
};

export interface ReputationAiPort {
  describe(): ReputationAiDescription;
  analyzeReview(input: AnalyzeReviewInput): Promise<AnalyzeReviewOutput>;
  draftResponse(input: DraftResponseInput): Promise<DraftResponseOutput>;
}

let current: ReputationAiPort | null = null;

/** Puerto activo; sin registro previo, RulesReputationAi (respaldo por reglas). */
export function getReputationAiPort(): ReputationAiPort {
  if (!current) current = new RulesReputationAi();
  return current;
}

/** Registra el puerto (fusión T8: reputation-ai.core-adapter.ts en el arranque del API); `null` vuelve al respaldo por reglas. */
export function setReputationAiPort(port: ReputationAiPort | null): void {
  current = port;
}

/** Vuelve al respaldo por reglas (tests). */
export function resetReputationAiPort(): void {
  current = null;
}
