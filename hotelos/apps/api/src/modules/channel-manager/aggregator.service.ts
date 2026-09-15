// Aggregator (rate grid v2): the LEGACY synchronous fan-out kept for the
// routes server.ts still exposes (/channel-manager/channels, push-rates,
// push-availability, push-restrictions, ingest…) and for
// rate-manager/rate-grid.service (`pushRates`). New code publishes through the
// outbox (delivery.service.enqueueRateGridPush + drain.service): these
// helpers now ENQUEUE and DRAIN the affected channels immediately, so the
// hub screen keeps its synchronous "push now" button while every push goes
// through the same ChannelDelivery rows, translations and audit trail.
//
// Channel creation/test/pull are thin wrappers over channels.service (one
// implementation of credentials + mode). Nothing here talks to an adapter.

import { prisma } from "@hotelos/database";
import { BadRequestError } from "../../lib/http-error.js";
import { resolveAdapter } from "./adapters/index.js";
import {
  channelTypeFor,
  createChannel as createChannelV2,
  effectiveChannelMode,
  logSyncJob as logSyncJobV2,
  pullChannelReservations,
  readChannelCredentials,
  testChannel as testChannelV2,
  unsupportedProviderError
} from "./channels.service.js";
import { enqueueRateGridPush } from "./delivery.service.js";
import { drainChannelDeliveries, type DrainSummary } from "./drain.service.js";

export { channelTypeFor, unsupportedProviderError };
/** Kept under the v1 name: drain.service and the routes log jobs through it. */
export const logSyncJob = logSyncJobV2;

type DateRange = { from: string; to: string };

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
function requireRange(range: DateRange): DateRange {
  if (!ISO_DATE.test(range.from) || !ISO_DATE.test(range.to)) throw new BadRequestError("Fechas inválidas: use YYYY-MM-DD.");
  if (range.from > range.to) throw new BadRequestError("from debe ser anterior o igual a to.");
  return range;
}

export async function listChannels(input: { propertyId: string; active?: boolean }) {
  const channels = await prisma.channel.findMany({
    where: {
      propertyId: input.propertyId,
      ...(input.active === true ? { status: "active" } : input.active === false ? { NOT: { status: "active" } } : {})
    },
    orderBy: { createdAt: "desc" }
  });
  const channelIds = channels.map((c) => c.id);
  const [latestSyncRows, roomMappings, rateMappings, productCounts, deliveryCounts] = channelIds.length
    ? await Promise.all([
        prisma.channelSyncJob.findMany({ where: { channelId: { in: channelIds } }, orderBy: { createdAt: "desc" }, take: 200 }),
        prisma.channelRoomMapping.findMany({ where: { channelId: { in: channelIds } } }),
        prisma.channelRateMapping.findMany({ where: { channelId: { in: channelIds } } }),
        prisma.channelProductMapping.groupBy({ by: ["channelId"], where: { channelId: { in: channelIds }, status: "active" }, _count: { _all: true } }),
        prisma.channelDelivery.groupBy({ by: ["channelId", "status"], where: { channelId: { in: channelIds } }, _count: { _all: true } })
      ])
    : [[], [], [], [], []];

  const latestByChannel = new Map<string, (typeof latestSyncRows)[number]>();
  for (const job of latestSyncRows) {
    if (!job.channelId) continue;
    const existing = latestByChannel.get(job.channelId);
    if (!existing || job.createdAt > existing.createdAt) latestByChannel.set(job.channelId, job);
  }
  const count = (rows: Array<{ channelId: string }>) => {
    const m = new Map<string, number>();
    for (const r of rows) m.set(r.channelId, (m.get(r.channelId) ?? 0) + 1);
    return m;
  };
  const roomCount = count(roomMappings);
  const rateCount = count(rateMappings);
  const productCount = new Map(productCounts.map((p) => [p.channelId, p._count._all] as const));
  const deliveries = new Map<string, Record<string, number>>();
  for (const d of deliveryCounts) {
    const bucket = deliveries.get(d.channelId) ?? {};
    bucket[d.status] = d._count._all;
    deliveries.set(d.channelId, bucket);
  }

  return channels.map((c) => {
    const latest = latestByChannel.get(c.id);
    const { credentials, legacy } = readChannelCredentials(c);
    return {
      id: c.id,
      propertyId: c.propertyId,
      providerCode: c.providerCode,
      name: c.name,
      channelType: c.channelType,
      status: c.status,
      mode: effectiveChannelMode(c.mode),
      commissionPercent: c.commissionPercent !== null ? Number(c.commissionPercent) : null,
      markupPercent: c.defaultMarkupPercent !== null ? Number(c.defaultMarkupPercent) : null,
      autoPushOnSave: c.autoPushOnSave,
      hasCredentials: credentials !== null,
      legacyPlaintextCredentials: legacy,
      lastSyncAt: c.lastSyncAt ? c.lastSyncAt.toISOString() : null,
      roomMappingsCount: roomCount.get(c.id) ?? 0,
      rateMappingsCount: rateCount.get(c.id) ?? 0,
      productMappingsCount: productCount.get(c.id) ?? 0,
      deliveries: deliveries.get(c.id) ?? {},
      latestSync: latest
        ? {
            id: latest.id,
            syncType: latest.syncType,
            status: latest.status,
            errorMessage: latest.errorMessage,
            startedAt: latest.startedAt ? latest.startedAt.toISOString() : null,
            finishedAt: latest.finishedAt ? latest.finishedAt.toISOString() : null,
            createdAt: latest.createdAt.toISOString()
          }
        : null
    };
  });
}

/** v1 signature kept for POST /channel-manager/channels (server.ts). */
export async function createChannel(input: { propertyId: string; providerCode: string; displayName: string; credentialsJson?: Record<string, unknown> | null }) {
  if (!resolveAdapter(input.providerCode)) throw unsupportedProviderError(input.providerCode);
  const created = await createChannelV2({
    propertyId: input.propertyId,
    providerCode: input.providerCode,
    name: input.displayName,
    credentials: input.credentialsJson ?? null
  });
  return { id: created.id, providerCode: created.providerCode, name: created.name, status: created.status, mode: created.mode };
}

export async function testChannel(channelId: string) {
  return testChannelV2(channelId);
}

// ---- Push helpers: enqueue + immediate drain of the affected channels ----

async function channelIdsFor(input: { propertyId: string; channelIds?: string[] }): Promise<string[]> {
  const rows = await prisma.channel.findMany({
    where: { propertyId: input.propertyId, ...(input.channelIds?.length ? { id: { in: input.channelIds } } : { status: "active" }) },
    select: { id: true }
  });
  return rows.map((r) => r.id);
}

async function enqueueAndDrain(input: {
  propertyId: string;
  dateRange: DateRange;
  channelIds?: string[];
  ratePlanIds?: string[];
  roomTypeIds?: string[];
  kind: "rates" | "availability" | "restrictions";
}) {
  const range = requireRange(input.dateRange);
  const channelIds = await channelIdsFor(input);
  if (channelIds.length === 0) return { propertyId: input.propertyId, dateRange: range, queued: 0, byChannel: {}, warnings: ["Sin canales activos."], results: [] as Array<{ channelId: string; providerCode: string; ok: boolean; pushed: number; latencyMs?: number; errors?: string[] }> };
  const enqueued = await enqueueRateGridPush({
    propertyId: input.propertyId,
    from: range.from,
    to: range.to,
    channelIds,
    ratePlanIds: input.ratePlanIds,
    roomTypeIds: input.roomTypeIds,
    kinds: [input.kind],
    actorUserId: "system"
  });
  const drains: DrainSummary[] = [];
  for (const channelId of channelIds) drains.push(await drainChannelDeliveries({ channelId }));
  const results = channelIds.map((channelId) => {
    const batches = drains.flatMap((d) => d.batches.filter((b) => b.channelId === channelId && b.kind === input.kind));
    const confirmed = drains.reduce((acc, d) => acc + d.byStatus.confirmed, 0);
    const errors = batches.flatMap((b) => b.errors);
    return {
      channelId,
      providerCode: batches[0]?.providerCode ?? "",
      ok: batches.length > 0 && batches.every((b) => b.status !== "failed"),
      pushed: confirmed,
      latencyMs: batches.reduce((acc, b) => acc + b.latencyMs, 0),
      errors: errors.length ? errors : undefined
    };
  });
  return { propertyId: input.propertyId, dateRange: range, queued: enqueued.queued, byChannel: enqueued.byChannel, warnings: enqueued.warnings, results };
}

export async function pushRates(input: { propertyId: string; dateRange: DateRange; ratePlanIds?: string[]; channelIds?: string[] }) {
  return enqueueAndDrain({ ...input, kind: "rates" });
}

export async function pushAvailability(input: { propertyId: string; dateRange: DateRange; roomTypeIds?: string[]; channelIds?: string[] }) {
  return enqueueAndDrain({ ...input, kind: "availability" });
}

export async function pushRestrictions(input: { propertyId: string; dateRange: DateRange; channelIds?: string[] }) {
  return enqueueAndDrain({ ...input, kind: "restrictions" });
}

// ---- Reservation ingest (v1 names) ----

export async function ingestReservations(input: { channelId: string; since?: Date }) {
  return pullChannelReservations(input);
}

export async function ingestAllReservations(input: { propertyId: string; since?: Date }) {
  const channels = await prisma.channel.findMany({ where: { propertyId: input.propertyId, status: "active" }, select: { id: true } });
  const results = [];
  for (const c of channels) results.push(await pullChannelReservations({ channelId: c.id, since: input.since }));
  return { propertyId: input.propertyId, results };
}

export async function listSyncJobs(input: { propertyId: string; channelId?: string; jobType?: string; since?: Date }) {
  const jobs = await prisma.channelSyncJob.findMany({
    where: {
      propertyId: input.propertyId,
      ...(input.channelId ? { channelId: input.channelId } : {}),
      ...(input.jobType ? { syncType: input.jobType } : {}),
      ...(input.since ? { createdAt: { gte: input.since } } : {})
    },
    orderBy: { createdAt: "desc" },
    take: 200
  });
  return jobs.map((j) => ({
    id: j.id,
    propertyId: j.propertyId,
    channelId: j.channelId,
    syncType: j.syncType,
    status: j.status,
    errorMessage: j.errorMessage,
    startedAt: j.startedAt ? j.startedAt.toISOString() : null,
    finishedAt: j.finishedAt ? j.finishedAt.toISOString() : null,
    createdAt: j.createdAt.toISOString(),
    requestPayloadJson: j.requestPayloadJson,
    responsePayloadJson: j.responsePayloadJson
  }));
}
