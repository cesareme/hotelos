// Token bucket por clave con reloj inyectado.
//
// Run from the package directory: corepack pnpm --filter @hotelos/ai-core test

import { test } from "node:test";
import assert from "node:assert/strict";

import { UNLIMITED_RATE_LIMITER, createRateLimiter } from "../rate-limit.ts";

globalThis.fetch = () => {
  throw new Error("red prohibida");
};

test("perMinute 2: la tercera acquire devuelve ok:false con retryAfterMs > 0", () => {
  let clock = 1_000_000;
  const limiter = createRateLimiter({ perMinute: 2, now: () => clock });
  assert.deepEqual(limiter.acquire("org_a"), { ok: true });
  assert.deepEqual(limiter.acquire("org_a"), { ok: true });
  const denied = limiter.acquire("org_a");
  assert.equal(denied.ok, false);
  assert.ok(denied.retryAfterMs > 0);
  assert.equal(denied.retryAfterMs, 30_000); // 1 token cada 30 s con perMinute 2
  assert.equal(limiter.remaining("org_a"), 0);
});

test("claves independientes: agotar una organización no afecta a otra", () => {
  const limiter = createRateLimiter({ perMinute: 1, now: () => 5 });
  assert.equal(limiter.acquire("org_a").ok, true);
  assert.equal(limiter.acquire("org_a").ok, false);
  assert.equal(limiter.acquire("org_b").ok, true);
  assert.equal(limiter.acquire("org_b").ok, false);
});

test("recarga continua con reloj inyectado y reset", () => {
  let clock = 0;
  const limiter = createRateLimiter({ perMinute: 2, now: () => clock });
  limiter.acquire("org_a");
  limiter.acquire("org_a");
  assert.equal(limiter.acquire("org_a").ok, false);
  clock += 15_000; // medio token
  assert.equal(limiter.acquire("org_a").ok, false);
  clock += 15_000; // un token completo
  assert.equal(limiter.acquire("org_a").ok, true);
  assert.equal(limiter.acquire("org_a").ok, false);
  clock += 120_000; // recarga saturada a la capacidad (2), nunca más
  assert.equal(limiter.remaining("org_a"), 2);
  assert.equal(limiter.acquire("org_a").ok, true);
  assert.equal(limiter.acquire("org_a").ok, true);
  assert.equal(limiter.acquire("org_a").ok, false);
  limiter.reset("org_a");
  assert.equal(limiter.acquire("org_a").ok, true);
  limiter.reset();
  assert.equal(limiter.remaining("org_a"), 2);
});

test("perMinute ≤ 0 desactiva el límite; UNLIMITED_RATE_LIMITER nunca deniega", () => {
  const limiter = createRateLimiter({ perMinute: 0, now: () => 0 });
  for (let i = 0; i < 100; i += 1) assert.equal(limiter.acquire("org_a").ok, true);
  assert.equal(limiter.remaining("org_a"), Number.POSITIVE_INFINITY);
  assert.deepEqual(UNLIMITED_RATE_LIMITER.acquire("x"), { ok: true });
});
