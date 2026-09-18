// Limitador de peticiones por clave (organizationId): token bucket en memoria
// con recarga continua. Vive en el proceso del API (sin Redis; se reinicia con
// él, decisión §6.6 del recon). `perMinute <= 0` desactiva el límite.

export type RateLimitDecision = { ok: true } | { ok: false; retryAfterMs: number };

export type RateLimiter = {
  acquire(key: string): RateLimitDecision;
  /** Tokens disponibles ahora para la clave (diagnóstico / cabeceras). */
  remaining(key: string): number;
  reset(key?: string): void;
};

export type RateLimiterOptions = {
  perMinute: number;
  now?: () => number;
};

type Bucket = { tokens: number; updatedAt: number };

export function createRateLimiter(options: RateLimiterOptions): RateLimiter {
  const now = options.now ?? Date.now;
  const capacity = Number.isFinite(options.perMinute) ? options.perMinute : 0;
  const ratePerMs = capacity / 60_000;
  const buckets = new Map<string, Bucket>();

  function refill(key: string): Bucket {
    const at = now();
    const bucket = buckets.get(key);
    if (!bucket) {
      const fresh = { tokens: capacity, updatedAt: at };
      buckets.set(key, fresh);
      return fresh;
    }
    const elapsed = Math.max(0, at - bucket.updatedAt);
    bucket.tokens = Math.min(capacity, bucket.tokens + elapsed * ratePerMs);
    bucket.updatedAt = at;
    return bucket;
  }

  return {
    acquire(key) {
      if (capacity <= 0) return { ok: true };
      const bucket = refill(key);
      if (bucket.tokens >= 1) {
        bucket.tokens -= 1;
        return { ok: true };
      }
      const retryAfterMs = Math.max(1, Math.ceil((1 - bucket.tokens) / ratePerMs));
      return { ok: false, retryAfterMs };
    },
    remaining(key) {
      if (capacity <= 0) return Number.POSITIVE_INFINITY;
      return Math.floor(refill(key).tokens);
    },
    reset(key) {
      if (key === undefined) buckets.clear();
      else buckets.delete(key);
    }
  };
}

/** Limitador que nunca deniega (tests y modos sin límite). */
export const UNLIMITED_RATE_LIMITER: RateLimiter = Object.freeze({
  acquire: () => ({ ok: true }) as RateLimitDecision,
  remaining: () => Number.POSITIVE_INFINITY,
  reset: () => undefined
});
