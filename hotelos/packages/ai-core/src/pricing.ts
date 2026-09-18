// Tabla de precios (USD por millón de tokens) y coste real desde `usage`.
//
// PRICING_TABLE_DATE es la fecha de la tabla del skill claude-api usada en el
// reconocimiento de la Tanda L6a. ACTUALIZARLA en el humo manual con clave
// (docs/runbooks/ai-core.md) cada vez que cambien los precios publicados.
// Nunca se fabrica un coste: modelo desconocido → null; sin tipo de cambio →
// costEur null. Solo `usd: 0 / eur: 0` cuando todos los tokens son 0.

export const PRICING_TABLE_DATE = "2026-06-24";

export type ModelPricing = {
  /** USD por millón de tokens de entrada (sin caché). */
  input: number;
  /** USD por millón de tokens de salida. */
  output: number;
};

export const PRICING_TABLE: Readonly<Record<string, ModelPricing>> = Object.freeze({
  "claude-sonnet-5": { input: 2, output: 10 },
  "claude-haiku-4-5": { input: 1, output: 5 },
  "claude-haiku-4-5-20251001": { input: 1, output: 5 },
  "claude-opus-5": { input: 5, output: 25 }
});

/** Multiplicadores sobre el precio de entrada (caché) y sobre el total (lote). */
export const PRICING_MULTIPLIERS = Object.freeze({
  cacheWrite5m: 1.25,
  cacheWrite1h: 2,
  cacheRead: 0.1,
  batch: 0.5
});

export type PricingUsage = {
  tokensInput: number;
  tokensOutput: number;
  /** cache_read_input_tokens del proveedor. */
  cacheReadTokens?: number;
  /** cache_creation_input_tokens del proveedor. */
  cacheWriteTokens?: number;
  /** TTL del breakpoint escrito (defecto 5m). */
  cacheWriteTtl?: "5m" | "1h";
  /** Petición enviada por la Message Batches API (×0,5). */
  batch?: boolean;
};

export type AiCost = { usd: number | null; eur: number | null };

/** Fila de precios para un modelo: coincidencia exacta o por prefijo más largo. */
export function pricingForModel(model: string): ModelPricing | null {
  const id = (model ?? "").trim().toLowerCase();
  if (!id) return null;
  const exact = PRICING_TABLE[id];
  if (exact) return exact;
  let best: { key: string; pricing: ModelPricing } | null = null;
  for (const [key, pricing] of Object.entries(PRICING_TABLE)) {
    if (id.startsWith(key) && (!best || key.length > best.key.length)) best = { key, pricing };
  }
  return best ? best.pricing : null;
}

function round6(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function nonNegative(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

export function costFromUsage(usage: PricingUsage, model: string, usdEurRate: number | null): AiCost {
  const tokensInput = nonNegative(usage.tokensInput);
  const tokensOutput = nonNegative(usage.tokensOutput);
  const cacheRead = nonNegative(usage.cacheReadTokens);
  const cacheWrite = nonNegative(usage.cacheWriteTokens);
  if (tokensInput + tokensOutput + cacheRead + cacheWrite === 0) return { usd: 0, eur: 0 };

  const pricing = pricingForModel(model);
  if (!pricing) return { usd: null, eur: null };

  const writeMultiplier = usage.cacheWriteTtl === "1h" ? PRICING_MULTIPLIERS.cacheWrite1h : PRICING_MULTIPLIERS.cacheWrite5m;
  let usd =
    (tokensInput * pricing.input +
      cacheRead * pricing.input * PRICING_MULTIPLIERS.cacheRead +
      cacheWrite * pricing.input * writeMultiplier +
      tokensOutput * pricing.output) /
    1_000_000;
  if (usage.batch) usd *= PRICING_MULTIPLIERS.batch;
  usd = round6(usd);

  const rate = typeof usdEurRate === "number" && Number.isFinite(usdEurRate) && usdEurRate > 0 ? usdEurRate : null;
  return { usd, eur: rate === null ? null : round6(usd * rate) };
}
