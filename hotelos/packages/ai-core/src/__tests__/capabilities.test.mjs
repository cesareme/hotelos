// Tabla de capacidades por modelo y valor conservador para desconocidos.
//
// Run from the package directory: corepack pnpm --filter @hotelos/ai-core test

import { test } from "node:test";
import assert from "node:assert/strict";

import { UNKNOWN_MODEL_CAPABILITIES, estimateTokens, modelCapabilities } from "../capabilities.ts";

globalThis.fetch = () => {
  throw new Error("red prohibida");
};

test("tabla: sonnet-5, haiku-4-5 (con alias fechado) y opus-5; thinking e inference_geo por modelo (CFC-01/CFC-03)", () => {
  assert.deepEqual(modelCapabilities("claude-sonnet-5"), { sampling: false, effort: true, thinking: "adaptive", thinkingOffSafe: true, inferenceGeo: true, cacheMinTokens: 1024, contextTokens: 1_000_000, maxPdfPages: 600 });
  assert.deepEqual(modelCapabilities("claude-sonnet-5-20260601"), modelCapabilities("claude-sonnet-5"));
  assert.deepEqual(modelCapabilities("claude-haiku-4-5"), { sampling: true, effort: false, thinking: "budget", thinkingOffSafe: false, inferenceGeo: false, cacheMinTokens: 4096, contextTokens: 200_000, maxPdfPages: 100 });
  assert.deepEqual(modelCapabilities("claude-haiku-4-5-20251001"), modelCapabilities("claude-haiku-4-5"));
  assert.deepEqual(modelCapabilities("claude-opus-5"), { sampling: false, effort: true, thinking: "adaptive", thinkingOffSafe: false, inferenceGeo: true, cacheMinTokens: 512, contextTokens: 1_000_000, maxPdfPages: 600 });
  assert.deepEqual(modelCapabilities("CLAUDE-OPUS-5"), modelCapabilities("claude-opus-5"));
  assert.equal(modelCapabilities("claude-haiku-4-5-20251001").inferenceGeo, false, "Haiku 4.5 no admite inference_geo (400)");
});

test("modelo desconocido → sin sampling, effort, thinking ni inference_geo; 4096 tokens de caché, 200K, 100 páginas", () => {
  const expected = { sampling: false, effort: false, thinking: "none", thinkingOffSafe: false, inferenceGeo: false, cacheMinTokens: 4096, contextTokens: 200_000, maxPdfPages: 100 };
  assert.deepEqual(modelCapabilities("claude-3-5-sonnet-latest"), expected);
  assert.deepEqual(modelCapabilities(""), expected);
  assert.deepEqual(modelCapabilities("gpt-4o-mini"), expected);
  assert.deepEqual(UNKNOWN_MODEL_CAPABILITIES, expected);
  // Copia defensiva: mutar el resultado no altera la tabla.
  const copy = modelCapabilities("claude-sonnet-5");
  copy.sampling = true;
  assert.equal(modelCapabilities("claude-sonnet-5").sampling, false);
});

test("estimateTokens ≈ chars/4 redondeando hacia arriba", () => {
  assert.equal(estimateTokens(""), 0);
  assert.equal(estimateTokens("abcd"), 1);
  assert.equal(estimateTokens("abcde"), 2);
  assert.equal(estimateTokens("x".repeat(4096)), 1024);
});
