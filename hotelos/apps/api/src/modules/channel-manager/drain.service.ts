// Outbox drain (rate grid v2 · lote api-channel-outbox).
//
// Takes ChannelDelivery rows that are `queued`, `timeout` with nextRetryAt due,
// or stuck in `sending` for more than STALE_SENDING_MS (a worker died), groups
// them by channel and kind, chunks by the adapter's maxItemsPerRequest,
// respects rateLimitPerMinute with an in-memory token bucket per channel,
// marks the chunk `sending`, calls the adapter with the items translated from
// the stored payload, and writes the per-delivery outcome (confirmed /
// rejected / timeout+backoff). Every chunk leaves a ChannelSyncJob (the hub
// screen lists them) and the channel's lastSyncAt moves on success. Each run
// seals one CHANNEL_DELIVERIES_DRAINED audit event per property with counts.
//
// It runs on the scheduler leader only (`startChannelDeliveryDrain` is called
// by server.ts inside the RUN_SCHEDULERS block) and on demand through
// POST /channel-manager/deliveries/drain. A guard prevents two overlapping
// runs in the same process. Across processes (two leaders, a manual drain
// racing the scheduler, :3000 and :3400 on the same database) the candidates
// are CLAIMED atomically (`claimChannelDeliveries`): one UPDATE … WHERE the
// row is still queued / due / stale … FOR UPDATE SKIP LOCKED … RETURNING
// flips them to `sending` before anything is sent, so two drains can never
// take the same row (api-polish A4). Rows deferred by the rate limiter go
// back to `queued` at the end of the run; a crashed worker's rows are taken
// over after STALE_SENDING_MS as before.
//
// Obsolete candidates are RETIRED, not re-sent: a `timeout` retry or a stale
// `sending` takeover for which a LATER delivery of the same cell exists
// (`created_at` is the plan order: the planner stamps it again on re-queue)
// would put a payload the grid no longer holds on the channel after the
// current one — it is marked `superseded` instead (`retireObsoleteDeliveries`).
//
// Time zone: `channel_deliveries` timestamps are `timestamp(3)` WITHOUT time
// zone and Prisma ORM always writes UTC wall-clock into them. A JS Date bound
// in raw SQL is a `timestamptz`, so comparing or assigning it directly goes
// through the session TimeZone of Postgres (Europe/Madrid on the Mac): every
// backoff looked due 2 h early and `updated_at` of claimed rows landed 2 h in
// the future. Every bound instant is therefore converted with
// `AT TIME ZONE 'UTC'` so raw SQL and the ORM speak the same wall clock.
//
// Outcomes are written only onto rows still `sending` (`writeOutcomes`): a
// row the planner superseded while it was in flight keeps `superseded`, the
// newer delivery of the cell is what the grid shows.
//
// Retention: `superseded` rows older than CHANNEL_DELIVERY_RETENTION_DAYS
// (default 30) are deleted by the unscoped (scheduler / platform-admin) drain
// pass, at most once per hour per process (`purgeSupersededDeliveries`). They
// are history the planner no longer needs (a re-queue only looks at recent
// rows of a cell) and the only rows that grow without bound. A tenant-scoped
// manual drain never purges: retention is an instance-wide maintenance job.
//
// Honest catch: an adapter that THROWS (a bug, not a provider answer) is
// logged with channel + kind + delivery ids and treated as a transient failure
// (backoff), never swallowed.

import { prisma } from "@hotelos/database";
import { Prisma } from "@prisma/client";
import { recordAuditEvent } from "../audit/audit.service.js";
import type { AdapterResult, ChannelAdapter, ChannelContext, DeliveryKind } from "./adapter.types.js";
import { failedResult } from "./adapter.types.js";
import { resolveAdapter } from "./adapters/index.js";
import { logSyncJob, toChannelContext } from "./channels.service.js";
import { DELIVERY_KINDS, type DeliveryStatus } from "./delivery.core.js";
import { refreshJournalPushStatuses } from "./delivery.service.js";
import {
  STALE_SENDING_MS,
  TokenBucket,
  chunk,
  computeOutcomes,
  isPurgeDue,
  purgeCutoff,
  summarizeOutcomes,
  toAvailabilityItem,
  toRateItem,
  toRestrictionItem,
  type DeliveryOutcome,
  type DrainDelivery
} from "./drain.core.js";
import { readChannelEnv } from "./env.partial.js";

export type DrainBatchSummary = {
  channelId: string;
  providerCode: string;
  kind: DeliveryKind;
  size: number;
  status: "success" | "partial" | "failed";
  latencyMs: number;
  syncJobId: string | null;
  errors: string[];
};

export type DrainSummary = {
  startedAt: string;
  finishedAt: string;
  candidates: number;
  processed: number;
  byStatus: Record<DeliveryStatus, number>;
  /** Deliveries left queued because the channel's token bucket was empty. */
  deferredRateLimit: number;
  /** Due retries / stale sending rows retired as `superseded` because a newer delivery of the cell exists. */
  retiredObsolete: number;
  /** `superseded` rows older than the retention window deleted by this pass (unscoped drains, at most hourly); null when the purge did not run. */
  purgedSuperseded: number | null;
  batches: DrainBatchSummary[];
  /** Adapter exceptions (channel + kind + message), never swallowed. */
  failed: Array<{ channelId: string; kind: DeliveryKind; deliveryIds: string[]; message: string }>;
};

const buckets = new Map<string, TokenBucket>();
let lastPurgeAt: Date | null = null;

/** Test hook. */
export function resetDrainBuckets(): void {
  buckets.clear();
  lastPurgeAt = null;
}

/**
 * Deletes `superseded` deliveries whose last change is older than
 * `retentionDays` (CHANNEL_DELIVERY_RETENTION_DAYS by default). Returns the
 * number of rows removed. Only `superseded` rows are ever purged: every other
 * status is either live or the last word on what a channel holds.
 */
export async function purgeSupersededDeliveries(input: { retentionDays?: number; now?: Date } = {}): Promise<number> {
  const now = input.now ?? new Date();
  const cutoff = purgeCutoff(now, input.retentionDays ?? readChannelEnv().deliveryRetentionDays);
  const res = await prisma.channelDelivery.deleteMany({ where: { status: "superseded", updatedAt: { lt: cutoff } } });
  return res.count;
}

function bucketFor(channelId: string, perMinute: number, now: number): TokenBucket {
  let bucket = buckets.get(channelId);
  if (!bucket) {
    bucket = new TokenBucket(perMinute, now);
    buckets.set(channelId, bucket);
  }
  return bucket;
}

type DrainDeps = {
  resolveAdapter?: (providerCode: string) => ChannelAdapter | null;
  now?: () => Date;
  log?: { info: (obj: unknown, msg?: string) => void; error: (obj: unknown, msg?: string) => void };
};

const defaultLog = {
  info: (obj: unknown, msg?: string) => console.log(JSON.stringify({ msg, ...(typeof obj === "object" && obj ? obj : { obj }) })),
  error: (obj: unknown, msg?: string) => console.error(JSON.stringify({ msg, ...(typeof obj === "object" && obj ? obj : { obj }) }))
};

async function callAdapter(adapter: ChannelAdapter, context: ChannelContext, kind: DeliveryKind, batch: DrainDelivery[], currency: string): Promise<AdapterResult> {
  if (kind === "rates") return adapter.pushRates({ channel: context, items: batch.map((d) => toRateItem(d, currency)) });
  if (kind === "restrictions") return adapter.pushRestrictions({ channel: context, items: batch.map(toRestrictionItem) });
  return adapter.pushAvailability({ channel: context, items: batch.map(toAvailabilityItem) });
}

/**
 * Persists the per-delivery outcomes — only onto rows that are still
 * `sending` (ours since the claim). A row another writer moved meanwhile
 * (the planner superseded it while in flight) keeps that state; the ids are
 * logged so the drop is visible, never silent.
 */
async function writeOutcomes(outcomes: DeliveryOutcome[], syncJobId: string | null, now: Date, log: NonNullable<DrainDeps["log"]>): Promise<void> {
  if (outcomes.length === 0) return;
  const results = await prisma.$transaction(
    outcomes.map((o) =>
      prisma.channelDelivery.updateMany({
        where: { id: o.id, status: "sending" },
        data: {
          status: o.status,
          attempts: o.attempts,
          nextRetryAt: o.nextRetryAt,
          lastError: o.lastError,
          syncJobId,
          sentAt: now,
          ...(o.confirmed ? { confirmedAt: now } : {})
        }
      })
    )
  );
  const dropped = outcomes.filter((_, i) => (results[i]?.count ?? 0) === 0).map((o) => o.id);
  if (dropped.length > 0) {
    log.info({ deliveryIds: dropped, syncJobId }, "[channel-drain] outcome not written: rows were no longer `sending` (superseded while in flight)");
  }
}

export type ClaimedDelivery = DrainDelivery & { propertyId: string; journalId: string | null };

type ClaimRow = {
  id: string;
  propertyId: string;
  channelId: string;
  kind: string;
  roomTypeId: string;
  ratePlanId: string;
  date: string;
  payload: unknown;
  attempts: number;
  journalId: string | null;
  createdAt: Date;
};

/**
 * Minimal raw-SQL client so the claim can run inside an interactive
 * transaction (tests: insert → claim → roll back, nothing persisted, nothing
 * visible to the scheduler leader draining the same database).
 */
export type RawSqlClient = {
  $queryRaw<T = unknown>(query: Prisma.Sql): Promise<T>;
  $executeRaw(query: Prisma.Sql): Promise<number>;
};

/** A bound JS Date is a timestamptz: express it as the UTC wall clock the ORM stores in `timestamp` columns. */
function utcWallClock(instant: Date): Prisma.Sql {
  return Prisma.sql`(${instant}::timestamptz AT TIME ZONE 'UTC')`;
}

/** Candidates of a drain: queued, timeout with the retry due, or sending for longer than STALE_SENDING_MS. */
function dueCandidates(now: Date): Prisma.Sql {
  const staleBefore = new Date(now.getTime() - STALE_SENDING_MS);
  return Prisma.sql`(
        c.status = 'queued'
        OR (c.status = 'timeout' AND c.next_retry_at IS NOT NULL AND c.next_retry_at <= ${utcWallClock(now)})
        OR (c.status = 'sending' AND c.updated_at < ${utcWallClock(staleBefore)})
      )`;
}

/** True when a later delivery (plan order = created_at) exists for the same cell of the candidate `c`. */
const OVERTAKEN_BY_LATER_ROW = Prisma.sql`EXISTS (
        SELECT 1 FROM channel_deliveries AS n
        WHERE n.channel_id = c.channel_id AND n.kind = c.kind AND n.room_type_id = c.room_type_id
          AND n.rate_plan_id = c.rate_plan_id AND n.date = c.date AND n.id <> c.id
          AND n.created_at > c.created_at
      )`;

/**
 * Retires the due candidates a later delivery of the same cell has overtaken:
 * re-sending them (a `timeout` retry, a stale `sending` takeover) would put an
 * obsolete payload on the channel AFTER the current one. Returns the ids
 * marked `superseded` (with the journal each belonged to, so the entry's
 * pushStatus can be recomputed). Runs before every claim; `FOR UPDATE SKIP
 * LOCKED` so it never waits on rows another drain holds.
 */
export async function retireObsoleteDeliveries(input: { channelId?: string; now?: Date; db?: RawSqlClient } = {}): Promise<Array<{ id: string; journalId: string | null }>> {
  const now = input.now ?? new Date();
  const db: RawSqlClient = input.db ?? prisma;
  const channelFilter = input.channelId ? Prisma.sql`AND c.channel_id = ${input.channelId}` : Prisma.empty;
  const rows = await db.$queryRaw<Array<{ id: string; journalId: string | null }>>(Prisma.sql`
    UPDATE channel_deliveries AS d
    SET status = 'superseded', next_retry_at = NULL, updated_at = ${utcWallClock(now)}
    WHERE d.id IN (
      SELECT c.id
      FROM channel_deliveries AS c
      WHERE ${dueCandidates(now)}
      ${channelFilter}
      AND ${OVERTAKEN_BY_LATER_ROW}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING d.id, d.journal_id AS "journalId"
  `);
  return rows.map((r) => ({ id: r.id, journalId: r.journalId }));
}

/**
 * Atomic claim of the drain candidates (queued, timeout due, or stale
 * sending): ONE statement flips them to `sending` and returns them, with
 * `FOR UPDATE SKIP LOCKED` so a concurrent claim (another instance, a manual
 * drain) takes disjoint rows instead of the same ones. Oldest first (plan
 * order), `limit` rows, optionally one channel; a candidate overtaken by a
 * later row of its cell is never taken (see `retireObsoleteDeliveries`).
 * `updated_at` is set explicitly (Prisma's @updatedAt does not apply to raw
 * SQL) so the stale takeover clock starts now — as UTC wall clock, like the ORM.
 */
export async function claimChannelDeliveries(input: { channelId?: string; limit: number; now?: Date; db?: RawSqlClient }): Promise<ClaimedDelivery[]> {
  const now = input.now ?? new Date();
  const db: RawSqlClient = input.db ?? prisma;
  const limit = Math.min(Math.max(Math.floor(input.limit), 1), 20_000);
  const channelFilter = input.channelId ? Prisma.sql`AND c.channel_id = ${input.channelId}` : Prisma.empty;
  const rows = await db.$queryRaw<ClaimRow[]>(Prisma.sql`
    UPDATE channel_deliveries AS d
    SET status = 'sending', next_retry_at = NULL, updated_at = ${utcWallClock(now)}
    WHERE d.id IN (
      SELECT c.id
      FROM channel_deliveries AS c
      WHERE ${dueCandidates(now)}
      ${channelFilter}
      AND NOT ${OVERTAKEN_BY_LATER_ROW}
      ORDER BY c.created_at ASC
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING
      d.id,
      d.property_id AS "propertyId",
      d.channel_id AS "channelId",
      d.kind,
      d.room_type_id AS "roomTypeId",
      d.rate_plan_id AS "ratePlanId",
      to_char(d.date, 'YYYY-MM-DD') AS "date",
      d.payload_json AS "payload",
      d.attempts,
      d.journal_id AS "journalId",
      d.created_at AS "createdAt"
  `);
  // RETURNING carries no order: sort by plan order (created_at) so the batches
  // of a run go out oldest-plan first, like the claim selected them.
  rows.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return rows.map((row) => ({
    id: row.id,
    propertyId: row.propertyId,
    channelId: row.channelId,
    kind: row.kind as DeliveryKind,
    roomTypeId: row.roomTypeId,
    ratePlanId: row.ratePlanId,
    date: row.date,
    payload: (row.payload && typeof row.payload === "object" && !Array.isArray(row.payload) ? row.payload : {}) as Record<string, unknown>,
    attempts: Number(row.attempts),
    journalId: row.journalId
  }));
}

/** Rows the run could not send (rate limiter) go back to the queue; only rows still `sending` are touched. */
async function releaseDeferred(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await prisma.channelDelivery.updateMany({ where: { id: { in: ids }, status: "sending" }, data: { status: "queued" } });
}

export async function drainChannelDeliveries(input: { channelId?: string; limit?: number } = {}, deps: DrainDeps = {}): Promise<DrainSummary> {
  const nowFn = deps.now ?? (() => new Date());
  const resolve = deps.resolveAdapter ?? resolveAdapter;
  const log = deps.log ?? defaultLog;
  const startedAt = nowFn();
  const limit = Math.min(Math.max(input.limit ?? readChannelEnv().drainBatchLimit, 1), 20_000);

  // Retention purge first (unscoped passes only, at most hourly per process):
  // it never touches live rows, so it is independent of the claim below.
  let purgedSuperseded: number | null = null;
  if (!input.channelId && isPurgeDue(lastPurgeAt, startedAt)) {
    lastPurgeAt = startedAt;
    purgedSuperseded = await purgeSupersededDeliveries({ now: startedAt });
    if (purgedSuperseded > 0) log.info({ purged: purgedSuperseded, retentionDays: readChannelEnv().deliveryRetentionDays }, "[channel-drain] superseded deliveries beyond retention purged");
  }

  // Retire what a later delivery of the same cell made obsolete, then claim
  // (atomic, multi-instance safe): from here on every candidate is ours and already `sending`.
  const retired = await retireObsoleteDeliveries({ channelId: input.channelId, now: startedAt });
  if (retired.length > 0) log.info({ deliveryIds: retired.map((r) => r.id) }, "[channel-drain] obsolete candidates retired as superseded (a newer delivery of the cell exists)");
  const candidates = await claimChannelDeliveries({ channelId: input.channelId, limit, now: startedAt });

  const summary: DrainSummary = {
    startedAt: startedAt.toISOString(),
    finishedAt: startedAt.toISOString(),
    candidates: candidates.length,
    processed: 0,
    byStatus: summarizeOutcomes([]),
    deferredRateLimit: 0,
    retiredObsolete: retired.length,
    purgedSuperseded,
    batches: [],
    failed: []
  };
  // Entries whose rows were just retired may now be fully superseded.
  const journalIds = new Set<string>();
  for (const row of retired) if (row.journalId) journalIds.add(row.journalId);
  if (candidates.length === 0) {
    if (journalIds.size > 0) await refreshJournalPushStatuses([...journalIds]);
    summary.finishedAt = nowFn().toISOString();
    return summary;
  }

  const byChannel = new Map<string, DrainDelivery[]>();
  for (const row of candidates) {
    const list = byChannel.get(row.channelId) ?? [];
    list.push({ id: row.id, channelId: row.channelId, kind: row.kind, roomTypeId: row.roomTypeId, ratePlanId: row.ratePlanId, date: row.date, payload: row.payload, attempts: row.attempts });
    byChannel.set(row.channelId, list);
  }
  const channels = await prisma.channel.findMany({ where: { id: { in: [...byChannel.keys()] } } });
  const properties = await prisma.property.findMany({ where: { id: { in: [...new Set(channels.map((c) => c.propertyId))] } }, select: { id: true, organizationId: true, currency: true } });
  const propertyById = new Map(properties.map((p) => [p.id, p] as const));
  const countsByProperty = new Map<string, Record<DeliveryStatus, number>>();
  for (const row of candidates) if (row.journalId) journalIds.add(row.journalId);
  const deferredIds: string[] = [];

  // Claimed rows whose channel no longer exists must not sit in `sending` until the stale takeover: final rejection.
  const knownChannelIds = new Set(channels.map((c) => c.id));
  for (const [channelId, deliveries] of byChannel) {
    if (knownChannelIds.has(channelId)) continue;
    const outcomes = computeOutcomes(deliveries, failedResult({ errors: ["Canal inexistente."], retryable: false }), nowFn());
    await writeOutcomes(outcomes, null, nowFn(), log);
    for (const o of outcomes) summary.byStatus[o.status]++;
    summary.processed += outcomes.length;
    log.error({ channelId, deliveryIds: deliveries.map((d) => d.id) }, "[channel-drain] channel row missing for claimed deliveries");
  }

  for (const channel of channels) {
    const deliveries = byChannel.get(channel.id) ?? [];
    const adapter = resolve(channel.providerCode);
    const context = toChannelContext(channel);
    const property = propertyById.get(channel.propertyId);
    const currency = property?.currency ?? "EUR";
    const propertyCounts = countsByProperty.get(channel.propertyId) ?? summarizeOutcomes([]);
    countsByProperty.set(channel.propertyId, propertyCounts);

    if (!adapter) {
      const outcomes = computeOutcomes(deliveries, failedResult({ errors: [`Proveedor sin adaptador: ${channel.providerCode}`], retryable: false }), nowFn());
      await writeOutcomes(outcomes, null, nowFn(), log);
      for (const o of outcomes) {
        summary.byStatus[o.status]++;
        propertyCounts[o.status]++;
      }
      summary.processed += outcomes.length;
      continue;
    }
    const caps = adapter.capabilities();
    const bucket = bucketFor(channel.id, caps.rateLimitPerMinute, startedAt.getTime());

    for (const kind of DELIVERY_KINDS) {
      const ofKind = deliveries.filter((d) => d.kind === kind);
      if (ofKind.length === 0) continue;
      if (!caps[kind]) {
        const outcomes = computeOutcomes(ofKind, failedResult({ errors: [`El proveedor ${channel.providerCode} no acepta ${kind}.`], retryable: false }), nowFn());
        await writeOutcomes(outcomes, null, nowFn(), log);
        for (const o of outcomes) {
          summary.byStatus[o.status]++;
          propertyCounts[o.status]++;
        }
        summary.processed += outcomes.length;
        continue;
      }
      for (const batch of chunk(ofKind, caps.maxItemsPerRequest)) {
        if (!bucket.take(nowFn().getTime())) {
          summary.deferredRateLimit += batch.length;
          deferredIds.push(...batch.map((d) => d.id));
          continue;
        }
        const ids = batch.map((d) => d.id);
        const batchStart = nowFn();
        // Already `sending` since the claim; nothing to flip here.
        let result: AdapterResult;
        try {
          result = await callAdapter(adapter, context, kind, batch, currency);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          log.error({ channelId: channel.id, providerCode: channel.providerCode, kind, deliveryIds: ids, error: message }, "[channel-drain] adapter threw");
          summary.failed.push({ channelId: channel.id, kind, deliveryIds: ids, message });
          result = failedResult({ errors: [`Excepción del adaptador: ${message}`], retryable: true });
        }
        const finishedAt = nowFn();
        const outcomes = computeOutcomes(batch, result, finishedAt);
        const counts = summarizeOutcomes(outcomes);
        const status: DrainBatchSummary["status"] = counts.confirmed === batch.length ? "success" : counts.confirmed > 0 ? "partial" : "failed";
        const job = await logSyncJob({
          propertyId: channel.propertyId,
          channelId: channel.id,
          syncType: `push_${kind}`,
          status,
          startedAt: batchStart,
          finishedAt,
          errorMessage: result.errors.length ? result.errors.join("; ").slice(0, 1000) : counts.rejected > 0 ? `${counts.rejected} entregas rechazadas por el proveedor` : undefined,
          requestPayload: { mode: context.mode, items: batch.length, deliveryIds: ids, requestHash: result.requestHash, dateFrom: batch[0]?.date, dateTo: batch[batch.length - 1]?.date },
          responsePayload: {
            ok: result.ok,
            accepted: result.accepted,
            rejected: result.rejected.slice(0, 50),
            latencyMs: result.latencyMs,
            responseHash: result.responseHash,
            timedOut: result.timedOut ?? false,
            rateLimited: result.rateLimited ?? false,
            ...(result.retryAfterMs !== undefined ? { retryAfterMs: result.retryAfterMs } : {}),
            warnings: (result.warnings ?? []).slice(0, 50),
            raw: (result.raw ?? null) as Prisma.InputJsonValue
          }
        });
        await writeOutcomes(outcomes, job.id, finishedAt, log);
        if (counts.confirmed > 0) await prisma.channel.update({ where: { id: channel.id }, data: { lastSyncAt: finishedAt } });
        for (const o of outcomes) {
          summary.byStatus[o.status]++;
          propertyCounts[o.status]++;
        }
        summary.processed += outcomes.length;
        summary.batches.push({ channelId: channel.id, providerCode: channel.providerCode, kind, size: batch.length, status, latencyMs: result.latencyMs, syncJobId: job.id, errors: result.errors });
      }
    }
  }

  await releaseDeferred(deferredIds);
  if (journalIds.size > 0) await refreshJournalPushStatuses([...journalIds]);

  for (const [propertyId, counts] of countsByProperty) {
    const property = propertyById.get(propertyId);
    if (!property) continue;
    recordAuditEvent({
      organizationId: property.organizationId,
      propertyId,
      actorType: "system",
      action: "CHANNEL_DELIVERIES_DRAINED",
      entityType: "channel_delivery",
      afterJson: { ...counts, deferredRateLimit: summary.deferredRateLimit, batches: summary.batches.filter((b) => channels.find((c) => c.id === b.channelId)?.propertyId === propertyId).length },
      correlationId: `drain_${startedAt.getTime()}`
    });
  }

  summary.finishedAt = nowFn().toISOString();
  log.info({ candidates: summary.candidates, processed: summary.processed, byStatus: summary.byStatus, deferredRateLimit: summary.deferredRateLimit, batches: summary.batches.length }, "[channel-drain] run finished");
  return summary;
}

// ---------------------------------------------------------------- scheduler

let running = false;

/**
 * setInterval with an anti-overlap guard. The integrator starts it in the
 * scheduler-leader block of server.ts; returns a handle to stop it (tests,
 * graceful shutdown). Honours CHANNEL_DRAIN_DISABLED.
 */
export function startChannelDeliveryDrain(options: { intervalMs?: number; log?: DrainDeps["log"] } = {}): { stop: () => void; runNow: () => Promise<DrainSummary | null> } {
  const env = readChannelEnv();
  const intervalMs = options.intervalMs ?? env.drainIntervalMs;
  const log = options.log ?? defaultLog;
  const runNow = async (): Promise<DrainSummary | null> => {
    if (running) return null;
    running = true;
    try {
      return await drainChannelDeliveries({}, { log });
    } catch (err) {
      log.error({ error: err instanceof Error ? err.message : String(err) }, "[channel-drain] run failed");
      return null;
    } finally {
      running = false;
    }
  };
  if (env.drainDisabled) {
    log.info({ intervalMs }, "[channel-drain] disabled (CHANNEL_DRAIN_DISABLED=true)");
    return { stop: () => undefined, runNow };
  }
  const timer = setInterval(() => void runNow(), intervalMs);
  timer.unref?.();
  log.info({ intervalMs }, "[channel-drain] started");
  return { stop: () => clearInterval(timer), runNow };
}
