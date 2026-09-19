// Coste real desde usage: tabla fechada, caché, lote, desconocido → null,
// sin tipo de cambio → eur null, cero tokens → 0.
//
// Run from the package directory: corepack pnpm --filter @hotelos/ai-core test

import { test } from "node:test";
import assert from "node:assert/strict";

import { PRICING_MULTIPLIERS, PRICING_TABLE, PRICING_TABLE_DATE, costFromUsage, pricingForModel } from "../pricing.ts";

globalThis.fetch = () => {
  throw new Error("red prohibida");
};

test("tabla fechada y filas esperadas (USD/MTok)", () => {
  assert.match(PRICING_TABLE_DATE, /^\d{4}-\d{2}-\d{2}$/);
  assert.deepEqual(PRICING_TABLE["claude-sonnet-5"], { input: 2, output: 10 });
  assert.deepEqual(PRICING_TABLE["claude-haiku-4-5"], { input: 1, output: 5 });
  assert.deepEqual(PRICING_TABLE["claude-haiku-4-5-20251001"], { input: 1, output: 5 });
  assert.deepEqual(PRICING_TABLE["claude-opus-5"], { input: 5, output: 25 });
  assert.deepEqual(PRICING_MULTIPLIERS, { cacheWrite5m: 1.25, cacheWrite1h: 2, cacheRead: 0.1, batch: 0.5 });
  assert.deepEqual(pricingForModel("claude-sonnet-5-20260601"), { input: 2, output: 10 });
  assert.equal(pricingForModel("claude-3-5-sonnet-latest"), null);
});

test("sonnet-5: 1M entrada + 1M salida = 12 USD; con caché y tipo de cambio 0,9", () => {
  assert.deepEqual(costFromUsage({ tokensInput: 1_000_000, tokensOutput: 1_000_000 }, "claude-sonnet-5", null), { usd: 12, eur: null });
  // 1000×2 + 2000×2×0,1 + 100×2×1,25 + 500×10 = 2000 + 400 + 250 + 5000 = 7650 µUSD
  assert.deepEqual(costFromUsage({ tokensInput: 1000, tokensOutput: 500, cacheReadTokens: 2000, cacheWriteTokens: 100 }, "claude-sonnet-5", 0.9), { usd: 0.00765, eur: 0.006885 });
  // Escritura de caché a 1 h: ×2 en vez de ×1,25 → 100×2×2 = 400 µUSD
  assert.deepEqual(costFromUsage({ tokensInput: 0, tokensOutput: 0, cacheWriteTokens: 100, cacheWriteTtl: "1h" }, "claude-sonnet-5", 1), { usd: 0.0004, eur: 0.0004 });
});

test("haiku-4-5 (alias fechado) y opus-5", () => {
  const usage = { tokensInput: 10_000, tokensOutput: 2_000, cacheReadTokens: 50_000 };
  // haiku: 10000×1 + 50000×1×0,1 + 2000×5 = 10000 + 5000 + 10000 = 25000 µUSD
  assert.deepEqual(costFromUsage(usage, "claude-haiku-4-5-20251001", 0.9), { usd: 0.025, eur: 0.0225 });
  assert.deepEqual(costFromUsage(usage, "claude-haiku-4-5", 0.9), costFromUsage(usage, "claude-haiku-4-5-20251001", 0.9));
  // opus: 10000×5 + 50000×5×0,1 + 2000×25 = 50000 + 25000 + 50000 = 125000 µUSD
  assert.deepEqual(costFromUsage(usage, "claude-opus-5", 0.9), { usd: 0.125, eur: 0.1125 });
  // lote ×0,5
  assert.deepEqual(costFromUsage({ ...usage, batch: true }, "claude-opus-5", null), { usd: 0.0625, eur: null });
});

test("modelo desconocido → usd y eur null (nunca 0 fabricado)", () => {
  assert.deepEqual(costFromUsage({ tokensInput: 100, tokensOutput: 10 }, "claude-3-5-sonnet-latest", 0.9), { usd: null, eur: null });
  assert.deepEqual(costFromUsage({ tokensInput: 100, tokensOutput: 10 }, "", 0.9), { usd: null, eur: null });
});

test("rate null o inválido → eur null; cero tokens → { 0, 0 } incluso con modelo desconocido", () => {
  assert.deepEqual(costFromUsage({ tokensInput: 100, tokensOutput: 10 }, "claude-sonnet-5", null), { usd: 0.0003, eur: null });
  assert.deepEqual(costFromUsage({ tokensInput: 100, tokensOutput: 10 }, "claude-sonnet-5", 0), { usd: 0.0003, eur: null });
  assert.deepEqual(costFromUsage({ tokensInput: 0, tokensOutput: 0 }, "claude-sonnet-5", null), { usd: 0, eur: 0 });
  assert.deepEqual(costFromUsage({ tokensInput: 0, tokensOutput: 0 }, "modelo-inexistente", null), { usd: 0, eur: 0 });
});
