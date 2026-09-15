// Pure parts of the outbox drain (rate grid v2): backoff schedule, per
// channel token bucket, chunking, delivery → adapter item translation and the
// per-delivery outcome of an AdapterResult. `drain.service.ts` adds Prisma.
//
// Backoff: 1 m, 5 m, 30 m, 2 h after attempts 1..4; the 5th failed attempt is
// final → rejected "reintentos agotados". Only transient failures (timeout,
// 429, 5xx, network) retry; a provider rejection of an item is final at once.
// A `Retry-After` sent by the provider (429 / 503) never shortens the schedule
// but can lengthen it: the next try waits max(backoff, Retry-After).

import type { AdapterResult, AvailabilityPushItem, DeliveryKind, RatePushItem, RestrictionPushItem } from "./adapter.types.js";
import type { DeliveryStatus } from "./delivery.core.js";

export const RETRY_BACKOFF_MS: readonly number[] = [60_000, 5 * 60_000, 30 * 60_000, 2 * 60 * 60_000];
export const MAX_ATTEMPTS = 5;
export const EXHAUSTED_MESSAGE = "Reintentos agotados";
/** A row stuck in `sending` longer than this is taken over by the next drain (crashed worker). */
export const STALE_SENDING_MS = 10 * 60_000;

// ---------------------------------------------------------------- retention purge

/** The superseded-delivery purge runs at most once per hour per process (inside the drain pass). */
export const PURGE_INTERVAL_MS = 60 * 60_000;
export const DEFAULT_DELIVERY_RETENTION_DAYS = 30;

/** True when a purge is due: never run in this process, or the last one is older than PURGE_INTERVAL_MS. */
export function isPurgeDue(lastPurgeAt: Date | null, now: Date): boolean {
  return lastPurgeAt === null || now.getTime() - lastPurgeAt.getTime() >= PURGE_INTERVAL_MS;
}

/**
 * `superseded` rows whose last change is older than this instant are purged.
 * Recent superseded rows must stay: the planner re-queues a superseded row
 * that carries the payload the grid is back to (same idempotency key).
 */
export function purgeCutoff(now: Date, retentionDays: number): Date {
  const days = Number.isFinite(retentionDays) && retentionDays >= 1 ? Math.floor(retentionDays) : DEFAULT_DELIVERY_RETENTION_DAYS;
  return new Date(now.getTime() - days * 86_400_000);
}

/** Delay before the next try after `attempt` failed attempts (1-based); null = give up. */
export function nextRetryDelayMs(attempt: number): number | null {
  if (attempt >= MAX_ATTEMPTS) return null;
  return RETRY_BACKOFF_MS[Math.min(attempt, RETRY_BACKOFF_MS.length) - 1] ?? null;
}

export function chunk<T>(items: T[], size: number): T[][] {
  const n = Math.max(1, Math.floor(size));
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += n) out.push(items.slice(i, i + n));
  return out;
}

/** Classic token bucket: `perMinute` tokens refilled continuously, capacity = perMinute. */
export class TokenBucket {
  private tokens: number;
  private last: number;
  constructor(
    private readonly perMinute: number,
    now: number = Date.now()
  ) {
    this.tokens = Math.max(1, perMinute);
    this.last = now;
  }
  private refill(now: number): void {
    const elapsedMin = Math.max(0, now - this.last) / 60_000;
    this.tokens = Math.min(Math.max(1, this.perMinute), this.tokens + elapsedMin * this.perMinute);
    this.last = now;
  }
  take(now: number = Date.now()): boolean {
    this.refill(now);
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }
  msUntilNextToken(now: number = Date.now()): number {
    this.refill(now);
    if (this.tokens >= 1) return 0;
    return Math.ceil(((1 - this.tokens) / this.perMinute) * 60_000);
  }
  available(now: number = Date.now()): number {
    this.refill(now);
    return Math.floor(this.tokens);
  }
}

// ---------------------------------------------------------------- translation

export type DrainDelivery = {
  id: string;
  channelId: string;
  kind: DeliveryKind;
  roomTypeId: string;
  ratePlanId: string;
  /** YYYY-MM-DD */
  date: string;
  payload: Record<string, unknown>;
  attempts: number;
};

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function bool(v: unknown): boolean {
  return v === true;
}

export function toRateItem(d: DrainDelivery, currencyFallback: string): RatePushItem {
  const p = d.payload;
  const occ = p.occupancyPrices && typeof p.occupancyPrices === "object" && !Array.isArray(p.occupancyPrices) ? (p.occupancyPrices as Record<string, number>) : undefined;
  const pricingModel = p.pricingModel === "obp" || p.pricingModel === "los" ? p.pricingModel : "per_day";
  return {
    date: d.date,
    externalRoomCode: String(p.externalRoomCode ?? ""),
    externalRateCode: String(p.externalRateCode ?? ""),
    roomTypeId: d.roomTypeId,
    ratePlanId: d.ratePlanId,
    currency: typeof p.currency === "string" && p.currency ? p.currency : currencyFallback,
    pricingModel,
    ...(num(p.amount) !== undefined ? { amount: num(p.amount) } : {}),
    ...(occ ? { occupancyPrices: occ } : {})
  };
}

export function toRestrictionItem(d: DrainDelivery): RestrictionPushItem {
  const p = d.payload;
  return {
    date: d.date,
    externalRoomCode: String(p.externalRoomCode ?? ""),
    ...(typeof p.externalRateCode === "string" && p.externalRateCode ? { externalRateCode: p.externalRateCode } : {}),
    roomTypeId: d.roomTypeId,
    ...(d.ratePlanId !== "*" ? { ratePlanId: d.ratePlanId } : {}),
    ...(num(p.minStay) !== undefined ? { minStay: num(p.minStay) } : {}),
    ...(num(p.minStayThrough) !== undefined ? { minStayThrough: num(p.minStayThrough) } : {}),
    ...(num(p.maxStay) !== undefined ? { maxStay: num(p.maxStay) } : {}),
    cta: bool(p.cta),
    ctd: bool(p.ctd),
    closed: bool(p.closed),
    stopSell: bool(p.stopSell),
    ...(num(p.minAdvanceDays) !== undefined ? { minAdvanceDays: num(p.minAdvanceDays) } : {}),
    ...(num(p.maxAdvanceDays) !== undefined ? { maxAdvanceDays: num(p.maxAdvanceDays) } : {})
  };
}

export function toAvailabilityItem(d: DrainDelivery): AvailabilityPushItem {
  const p = d.payload;
  return { date: d.date, externalRoomCode: String(p.externalRoomCode ?? ""), roomTypeId: d.roomTypeId, count: Math.max(0, Math.floor(num(p.count) ?? 0)) };
}

// ---------------------------------------------------------------- outcomes

export type DeliveryOutcome = {
  id: string;
  status: DeliveryStatus;
  attempts: number;
  nextRetryAt: Date | null;
  lastError: string | null;
  confirmed: boolean;
};

export function isRetryable(result: AdapterResult): boolean {
  if (result.retryable !== undefined) return result.retryable;
  return Boolean(result.timedOut || result.rateLimited);
}

/**
 * Per-delivery status after one adapter call for a batch. `attempts` on the
 * input is the count BEFORE this call.
 *   ok → items in `rejected` are final (rejected), the rest confirmed;
 *   transient failure → timeout + backoff, or rejected "reintentos agotados";
 *   definitive failure → rejected with the request-level error.
 */
export function computeOutcomes(batch: DrainDelivery[], result: AdapterResult, now: Date): DeliveryOutcome[] {
  const rejectedByIndex = new Map(result.rejected.map((r) => [r.itemIndex, r] as const));
  return batch.map((d, index) => {
    const attempts = d.attempts + 1;
    if (result.ok) {
      const rej = rejectedByIndex.get(index);
      if (rej) return { id: d.id, status: "rejected", attempts, nextRetryAt: null, lastError: `${rej.code}: ${rej.message}`.slice(0, 500), confirmed: false };
      return { id: d.id, status: "confirmed", attempts, nextRetryAt: null, lastError: null, confirmed: true };
    }
    const message = (result.errors[0] ?? "Error del proveedor").slice(0, 500);
    if (isRetryable(result)) {
      const delay = nextRetryDelayMs(attempts);
      if (delay === null) return { id: d.id, status: "rejected", attempts, nextRetryAt: null, lastError: `${EXHAUSTED_MESSAGE}: ${message}`.slice(0, 500), confirmed: false };
      const wait = Math.max(delay, Number.isFinite(result.retryAfterMs) ? Math.max(0, result.retryAfterMs as number) : 0);
      return { id: d.id, status: "timeout", attempts, nextRetryAt: new Date(now.getTime() + wait), lastError: message, confirmed: false };
    }
    return { id: d.id, status: "rejected", attempts, nextRetryAt: null, lastError: message, confirmed: false };
  });
}

export function summarizeOutcomes(outcomes: DeliveryOutcome[]): Record<DeliveryStatus, number> {
  const out: Record<DeliveryStatus, number> = { queued: 0, sending: 0, sent: 0, confirmed: 0, rejected: 0, timeout: 0, superseded: 0 };
  for (const o of outcomes) out[o.status]++;
  return out;
}
