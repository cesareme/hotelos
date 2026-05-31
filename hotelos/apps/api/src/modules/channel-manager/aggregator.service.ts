// Aggregator: the single chokepoint where every "fan-out to all OTAs"
// operation lives. The HTTP routes in server.ts call into this module; nothing
// else in the codebase talks to the adapters directly.
//
// Two design notes worth knowing:
//
//   * The schema uses `Channel.configurationJson` (Json) + an optional
//     `credentialsSecretRef`. There is no `credentialsJson` column. We map the
//     adapter-facing `credentialsJson` to `Channel.configurationJson.credentials`
//     so stub credentials can be written without a secret store. In production
//     the secret would be loaded by `credentialsSecretRef`.
//
//   * Sharp edge: rate plan / room type mappings must be configured before
//     pushing. We surface this as a partial-success path: if a Channel has zero
//     mappings (room or rate) the push is logged as `status="failed"` with a
//     descriptive error, NOT silently skipped.

import { prisma } from "@hotelos/database";
import type { Prisma } from "@hotelos/database";
import { resolveAdapter } from "./adapters/index.js";
import type {
  AvailabilityPushItem,
  ChannelContext,
  ChannelProviderCode,
  RatePushItem,
  RestrictionPushItem
} from "./adapter.types.js";

type DateRange = { from: string; to: string };

function parseDate(value: string): Date {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw new Error(`Invalid date: ${value}`);
  return d;
}

function toChannelContext(ch: {
  id: string;
  propertyId: string;
  providerCode: string;
  configurationJson: Prisma.JsonValue;
}): ChannelContext {
  const config = (ch.configurationJson ?? {}) as Record<string, unknown>;
  const credentials = (config.credentials as Record<string, unknown> | undefined) ?? null;
  return {
    id: ch.id,
    propertyId: ch.propertyId,
    providerCode: ch.providerCode as ChannelProviderCode,
    credentialsJson: credentials
  };
}

async function logSyncJob(input: {
  propertyId: string;
  channelId: string | null;
  syncType: string;
  status: "success" | "partial" | "failed" | "queued";
  startedAt: Date;
  finishedAt: Date;
  errorMessage?: string;
  requestPayload?: Record<string, unknown>;
  responsePayload?: Record<string, unknown>;
}): Promise<{ id: string }> {
  const job = await prisma.channelSyncJob.create({
    data: {
      propertyId: input.propertyId,
      channelId: input.channelId,
      syncType: input.syncType,
      status: input.status,
      startedAt: input.startedAt,
      finishedAt: input.finishedAt,
      errorMessage: input.errorMessage ?? null,
      requestPayloadJson: (input.requestPayload ?? {}) as Prisma.InputJsonValue,
      responsePayloadJson: (input.responsePayload ?? {}) as Prisma.InputJsonValue
    }
  });
  return { id: job.id };
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

  const [latestSyncRows, roomMappings, rateMappings] = channelIds.length
    ? await Promise.all([
        prisma.channelSyncJob.findMany({
          where: { channelId: { in: channelIds } },
          orderBy: { createdAt: "desc" },
          take: 200
        }),
        prisma.channelRoomMapping.findMany({ where: { channelId: { in: channelIds } } }),
        prisma.channelRateMapping.findMany({ where: { channelId: { in: channelIds } } })
      ])
    : [[], [], []];

  const latestByChannel = new Map<string, (typeof latestSyncRows)[number]>();
  for (const job of latestSyncRows) {
    if (!job.channelId) continue;
    const existing = latestByChannel.get(job.channelId);
    if (!existing || job.createdAt > existing.createdAt) latestByChannel.set(job.channelId, job);
  }

  const roomCount = new Map<string, number>();
  for (const m of roomMappings) roomCount.set(m.channelId, (roomCount.get(m.channelId) ?? 0) + 1);
  const rateCount = new Map<string, number>();
  for (const m of rateMappings) rateCount.set(m.channelId, (rateCount.get(m.channelId) ?? 0) + 1);

  return channels.map((c) => {
    const latest = latestByChannel.get(c.id);
    return {
      id: c.id,
      propertyId: c.propertyId,
      providerCode: c.providerCode,
      name: c.name,
      channelType: c.channelType,
      status: c.status,
      commissionPercent: c.commissionPercent !== null ? Number(c.commissionPercent) : null,
      lastSyncAt: c.lastSyncAt ? c.lastSyncAt.toISOString() : null,
      roomMappingsCount: roomCount.get(c.id) ?? 0,
      rateMappingsCount: rateCount.get(c.id) ?? 0,
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

export async function createChannel(input: {
  propertyId: string;
  providerCode: string;
  displayName: string;
  credentialsJson?: Record<string, unknown> | null;
}) {
  const adapter = resolveAdapter(input.providerCode);
  if (!adapter) throw new Error(`Unsupported providerCode: ${input.providerCode}`);
  const channelType =
    input.providerCode === "hotelbeds" ? "wholesaler" : input.providerCode === "airbnb" || input.providerCode === "vrbo" ? "vacation_rental" : "ota";
  const configurationJson: Record<string, unknown> = input.credentialsJson
    ? { credentials: input.credentialsJson }
    : {};
  const created = await prisma.channel.create({
    data: {
      propertyId: input.propertyId,
      providerCode: input.providerCode,
      name: input.displayName,
      channelType,
      status: "inactive",
      configurationJson: configurationJson as Prisma.InputJsonValue
    }
  });
  return {
    id: created.id,
    providerCode: created.providerCode,
    name: created.name,
    status: created.status
  };
}

export async function testChannel(channelId: string) {
  const channel = await prisma.channel.findUnique({ where: { id: channelId } });
  if (!channel) throw new Error(`Channel not found: ${channelId}`);
  const adapter = resolveAdapter(channel.providerCode);
  if (!adapter) throw new Error(`Unsupported providerCode: ${channel.providerCode}`);
  const startedAt = new Date();
  const result = await adapter.testCredentials({ channel: toChannelContext(channel) });
  const finishedAt = new Date();
  await logSyncJob({
    propertyId: channel.propertyId,
    channelId: channel.id,
    syncType: "test_credentials",
    status: result.ok ? "success" : "failed",
    startedAt,
    finishedAt,
    errorMessage: result.ok ? undefined : result.error,
    responsePayload: { ok: result.ok, metadata: result.metadata, error: result.error }
  });
  if (result.ok) {
    await prisma.channel.update({ where: { id: channel.id }, data: { lastSyncAt: finishedAt } });
  }
  return result;
}

// ---- Push helpers ----
// They share the pattern: resolve channels → load source rows → call adapter →
// log a ChannelSyncJob → return per-channel summary.

async function activeChannelsFor(input: {
  propertyId: string;
  channelIds?: string[];
}): Promise<Awaited<ReturnType<typeof prisma.channel.findMany>>> {
  return prisma.channel.findMany({
    where: {
      propertyId: input.propertyId,
      ...(input.channelIds?.length ? { id: { in: input.channelIds } } : { status: "active" })
    }
  });
}

export async function pushRates(input: {
  propertyId: string;
  dateRange: DateRange;
  ratePlanIds?: string[];
  channelIds?: string[];
}) {
  const from = parseDate(input.dateRange.from);
  const to = parseDate(input.dateRange.to);
  const rateDays = await prisma.rateDay.findMany({
    where: {
      propertyId: input.propertyId,
      date: { gte: from, lte: to },
      ...(input.ratePlanIds?.length ? { ratePlanId: { in: input.ratePlanIds } } : {})
    }
  });

  const channels = await activeChannelsFor({ propertyId: input.propertyId, channelIds: input.channelIds });
  const channelIdList = channels.map((c) => c.id);
  const rateMappings = channelIdList.length
    ? await prisma.channelRateMapping.findMany({ where: { channelId: { in: channelIdList } } })
    : [];

  const results = [];
  for (const channel of channels) {
    const adapter = resolveAdapter(channel.providerCode);
    if (!adapter) {
      results.push({ channelId: channel.id, providerCode: channel.providerCode, ok: false, errors: ["No adapter registered"] });
      continue;
    }
    const mapped = rateMappings.filter((m) => m.channelId === channel.id);
    if (mapped.length === 0) {
      const startedAt = new Date();
      await logSyncJob({
        propertyId: channel.propertyId,
        channelId: channel.id,
        syncType: "push_rates",
        status: "failed",
        startedAt,
        finishedAt: new Date(),
        errorMessage: "No rate mappings configured for this channel",
        requestPayload: { dateRange: input.dateRange }
      });
      results.push({
        channelId: channel.id,
        providerCode: channel.providerCode,
        ok: false,
        pushed: 0,
        errors: ["No rate mappings configured for this channel"]
      });
      continue;
    }
    const mappedRatePlanIds = new Set(mapped.map((m) => m.ratePlanId));
    const items: RatePushItem[] = rateDays
      .filter((r) => mappedRatePlanIds.has(r.ratePlanId))
      .map((r) => ({
        date: r.date.toISOString().slice(0, 10),
        ratePlanId: r.ratePlanId,
        amount: Number(r.price),
        currency: r.currency
      }));
    const startedAt = new Date();
    const result = await adapter.pushRates({ channel: toChannelContext(channel), items });
    const finishedAt = new Date();
    const status = !result.ok ? "failed" : result.errors?.length ? "partial" : "success";
    await logSyncJob({
      propertyId: channel.propertyId,
      channelId: channel.id,
      syncType: "push_rates",
      status,
      startedAt,
      finishedAt,
      errorMessage: result.errors?.join("; "),
      requestPayload: { dateRange: input.dateRange, itemCount: items.length },
      responsePayload: { ok: result.ok, pushed: result.pushed, latencyMs: result.latencyMs }
    });
    if (result.ok) {
      await prisma.channel.update({ where: { id: channel.id }, data: { lastSyncAt: finishedAt } });
    }
    results.push({
      channelId: channel.id,
      providerCode: channel.providerCode,
      ok: result.ok,
      pushed: result.pushed ?? items.length,
      latencyMs: result.latencyMs,
      errors: result.errors
    });
  }
  return { propertyId: input.propertyId, dateRange: input.dateRange, results };
}

export async function pushAvailability(input: {
  propertyId: string;
  dateRange: DateRange;
  roomTypeIds?: string[];
  channelIds?: string[];
}) {
  const from = parseDate(input.dateRange.from);
  const to = parseDate(input.dateRange.to);
  const invDays = await prisma.inventoryDay.findMany({
    where: {
      propertyId: input.propertyId,
      date: { gte: from, lte: to },
      ...(input.roomTypeIds?.length ? { roomTypeId: { in: input.roomTypeIds } } : {})
    }
  });

  const channels = await activeChannelsFor({ propertyId: input.propertyId, channelIds: input.channelIds });
  const channelIdList = channels.map((c) => c.id);
  const roomMappings = channelIdList.length
    ? await prisma.channelRoomMapping.findMany({ where: { channelId: { in: channelIdList } } })
    : [];

  const results = [];
  for (const channel of channels) {
    const adapter = resolveAdapter(channel.providerCode);
    if (!adapter) {
      results.push({ channelId: channel.id, providerCode: channel.providerCode, ok: false, errors: ["No adapter registered"] });
      continue;
    }
    const mapped = roomMappings.filter((m) => m.channelId === channel.id);
    if (mapped.length === 0) {
      const startedAt = new Date();
      await logSyncJob({
        propertyId: channel.propertyId,
        channelId: channel.id,
        syncType: "push_availability",
        status: "failed",
        startedAt,
        finishedAt: new Date(),
        errorMessage: "No room mappings configured for this channel",
        requestPayload: { dateRange: input.dateRange }
      });
      results.push({
        channelId: channel.id,
        providerCode: channel.providerCode,
        ok: false,
        pushed: 0,
        errors: ["No room mappings configured for this channel"]
      });
      continue;
    }
    const mappedRoomTypeIds = new Set(mapped.map((m) => m.roomTypeId));
    const items: AvailabilityPushItem[] = invDays
      .filter((r) => mappedRoomTypeIds.has(r.roomTypeId))
      .map((r) => ({
        date: r.date.toISOString().slice(0, 10),
        roomTypeId: r.roomTypeId,
        count: Math.max(0, r.availableCount)
      }));
    const startedAt = new Date();
    const result = await adapter.pushAvailability({ channel: toChannelContext(channel), items });
    const finishedAt = new Date();
    const status = !result.ok ? "failed" : result.errors?.length ? "partial" : "success";
    await logSyncJob({
      propertyId: channel.propertyId,
      channelId: channel.id,
      syncType: "push_availability",
      status,
      startedAt,
      finishedAt,
      errorMessage: result.errors?.join("; "),
      requestPayload: { dateRange: input.dateRange, itemCount: items.length },
      responsePayload: { ok: result.ok, pushed: result.pushed, latencyMs: result.latencyMs }
    });
    if (result.ok) {
      await prisma.channel.update({ where: { id: channel.id }, data: { lastSyncAt: finishedAt } });
    }
    results.push({
      channelId: channel.id,
      providerCode: channel.providerCode,
      ok: result.ok,
      pushed: result.pushed ?? items.length,
      latencyMs: result.latencyMs,
      errors: result.errors
    });
  }
  return { propertyId: input.propertyId, dateRange: input.dateRange, results };
}

export async function pushRestrictions(input: {
  propertyId: string;
  dateRange: DateRange;
  channelIds?: string[];
}) {
  const from = parseDate(input.dateRange.from);
  const to = parseDate(input.dateRange.to);
  const restrictions = await prisma.restrictionDay.findMany({
    where: { propertyId: input.propertyId, date: { gte: from, lte: to } }
  });

  const channels = await activeChannelsFor({ propertyId: input.propertyId, channelIds: input.channelIds });
  const channelIdList = channels.map((c) => c.id);
  const roomMappings = channelIdList.length
    ? await prisma.channelRoomMapping.findMany({ where: { channelId: { in: channelIdList } } })
    : [];

  const results = [];
  for (const channel of channels) {
    const adapter = resolveAdapter(channel.providerCode);
    if (!adapter) {
      results.push({ channelId: channel.id, providerCode: channel.providerCode, ok: false, errors: ["No adapter registered"] });
      continue;
    }
    const mapped = roomMappings.filter((m) => m.channelId === channel.id);
    if (mapped.length === 0) {
      const startedAt = new Date();
      await logSyncJob({
        propertyId: channel.propertyId,
        channelId: channel.id,
        syncType: "push_restrictions",
        status: "failed",
        startedAt,
        finishedAt: new Date(),
        errorMessage: "No room mappings configured for this channel",
        requestPayload: { dateRange: input.dateRange }
      });
      results.push({
        channelId: channel.id,
        providerCode: channel.providerCode,
        ok: false,
        pushed: 0,
        errors: ["No room mappings configured for this channel"]
      });
      continue;
    }
    const mappedRoomTypeIds = new Set(mapped.map((m) => m.roomTypeId));
    const items: RestrictionPushItem[] = restrictions
      .filter((r) => mappedRoomTypeIds.has(r.roomTypeId))
      .filter((r) => r.channelId === null || r.channelId === channel.id)
      .map((r) => ({
        date: r.date.toISOString().slice(0, 10),
        roomTypeId: r.roomTypeId,
        ratePlanId: r.ratePlanId ?? undefined,
        minStay: r.minStay ?? undefined,
        maxStay: r.maxStay ?? undefined,
        cta: r.closedToArrival || undefined,
        ctd: r.closedToDeparture || undefined,
        closed: r.stopSell || undefined
      }));
    const startedAt = new Date();
    const result = await adapter.pushRestrictions({ channel: toChannelContext(channel), items });
    const finishedAt = new Date();
    const status = !result.ok ? "failed" : result.errors?.length ? "partial" : "success";
    await logSyncJob({
      propertyId: channel.propertyId,
      channelId: channel.id,
      syncType: "push_restrictions",
      status,
      startedAt,
      finishedAt,
      errorMessage: result.errors?.join("; "),
      requestPayload: { dateRange: input.dateRange, itemCount: items.length },
      responsePayload: { ok: result.ok, pushed: result.pushed, latencyMs: result.latencyMs }
    });
    if (result.ok) {
      await prisma.channel.update({ where: { id: channel.id }, data: { lastSyncAt: finishedAt } });
    }
    results.push({
      channelId: channel.id,
      providerCode: channel.providerCode,
      ok: result.ok,
      pushed: result.pushed ?? items.length,
      latencyMs: result.latencyMs,
      errors: result.errors
    });
  }
  return { propertyId: input.propertyId, dateRange: input.dateRange, results };
}

// ---- Reservation ingest ----
// Dedup: ExternalReservation has @@unique([propertyId, externalReservationId]).
// We use Prisma upsert keyed on that compound unique so the same external
// reference from the same property never produces two rows. The provider code
// is folded into the externalReference at the adapter layer (see stub-utils
// `buildStubReservations`), preventing collisions across providers.

export async function ingestReservations(input: { channelId: string; since?: Date }) {
  const channel = await prisma.channel.findUnique({ where: { id: input.channelId } });
  if (!channel) throw new Error(`Channel not found: ${input.channelId}`);
  const adapter = resolveAdapter(channel.providerCode);
  if (!adapter) throw new Error(`Unsupported providerCode: ${channel.providerCode}`);
  const since = input.since ?? new Date(Date.now() - 24 * 60 * 60 * 1000);
  const startedAt = new Date();
  const fetchResult = await adapter.fetchReservations({ channel: toChannelContext(channel), since });
  const finishedAt = new Date();

  let imported = 0;
  if (fetchResult.ok) {
    for (const r of fetchResult.reservations) {
      const payload = r.payloadJson as Record<string, unknown>;
      const arrivalRaw = payload.arrivalDate;
      const departureRaw = payload.departureDate;
      const arrival = typeof arrivalRaw === "string" ? new Date(arrivalRaw) : null;
      const departure = typeof departureRaw === "string" ? new Date(departureRaw) : null;
      await prisma.externalReservation.upsert({
        where: {
          propertyId_externalReservationId: {
            propertyId: channel.propertyId,
            externalReservationId: r.externalReference
          }
        },
        update: {
          status: r.status,
          channelId: channel.id,
          payloadJson: payload as Prisma.InputJsonValue
        },
        create: {
          propertyId: channel.propertyId,
          channelId: channel.id,
          externalReservationId: r.externalReference,
          status: r.status,
          guestName: typeof payload.guestName === "string" ? payload.guestName : null,
          arrivalDate: arrival && !Number.isNaN(arrival.getTime()) ? arrival : null,
          departureDate: departure && !Number.isNaN(departure.getTime()) ? departure : null,
          payloadJson: payload as Prisma.InputJsonValue
        }
      });
      imported++;
    }
  }

  await logSyncJob({
    propertyId: channel.propertyId,
    channelId: channel.id,
    syncType: "ingest_reservations",
    status: fetchResult.ok ? "success" : "failed",
    startedAt,
    finishedAt,
    errorMessage: fetchResult.errors?.join("; "),
    requestPayload: { since: since.toISOString() },
    responsePayload: { ok: fetchResult.ok, imported }
  });
  if (fetchResult.ok) {
    await prisma.channel.update({ where: { id: channel.id }, data: { lastSyncAt: finishedAt } });
  }
  return {
    channelId: channel.id,
    providerCode: channel.providerCode,
    ok: fetchResult.ok,
    imported,
    errors: fetchResult.errors
  };
}

export async function ingestAllReservations(input: { propertyId: string; since?: Date }) {
  const channels = await prisma.channel.findMany({
    where: { propertyId: input.propertyId, status: "active" }
  });
  // Concurrent fan-out, but capped to the number of channels (usually 5 or so).
  const results = await Promise.all(
    channels.map((c) => ingestReservations({ channelId: c.id, since: input.since }))
  );
  return { propertyId: input.propertyId, results };
}

export async function listSyncJobs(input: {
  propertyId: string;
  channelId?: string;
  jobType?: string;
  since?: Date;
}) {
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
