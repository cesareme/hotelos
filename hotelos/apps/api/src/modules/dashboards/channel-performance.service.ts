import { prisma } from "@hotelos/database";
import type { Prisma } from "@hotelos/database";

// Read-only channel performance dashboard. Aggregates channel mix, profitability,
// parity alerts and sync job status for a property over a configurable window.
//
// Sharp edges (see report):
//   * `ExternalReservation` has no monetary field on the model — gross/net
//     revenue per channel must come from `ChannelProfitabilitySnapshot`.
//     Reservation counts come from ExternalReservation.
//   * `ChannelProfitabilitySnapshot.channel` is a free-form string (the
//     provider code or display name as written by the snapshot producer).
//     We join to `Channel` by `providerCode` first, then by `name` as a
//     fallback, so naming drift between subsystems is tolerated.
//   * `RateParityAlert.sourceChannel` is also a free-form string and may be
//     null. We resolve it the same way (providerCode → name → raw string).
//   * `RateParityAlert` has no `detectedAt`/`resolvedAt` columns — we expose
//     `createdAt` as `detectedAt` and derive `resolvedAt` from `status` (only
//     populated when status === "resolved", from `createdAt` as a placeholder
//     since the schema has no resolution timestamp).
//   * `Channel.commissionPercent` may be null — we exclude nulls from the
//     average commission KPI rather than coercing to zero.

export type ChannelPerformanceDashboard = {
  kpis: {
    activeChannels: number;
    openParityAlerts: number;
    avgCommissionPct: number;
    reservations30d: number;
    revenue30dEur: number;
  };
  channelMix: Array<{
    channelName: string;
    reservations: number;
    revenueEur: number;
    sharePct: number;
  }>;
  topProfitableChannels: Array<{
    channelName: string;
    netRevenueEur: number;
    commissionEur: number;
    marginPct: number;
  }>;
  recentParityAlerts: Array<{
    id: string;
    channelName?: string;
    severity?: string;
    detectedAt: string;
    resolvedAt?: string;
    description?: string;
  }>;
  syncJobsStatus: Array<{ status: string; count: number }>;
};

function dec(value: Prisma.Decimal | number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  return typeof value === "number" ? value : Number(value);
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

export async function buildChannelPerformanceDashboard(input: {
  propertyId: string;
  days?: number;
}): Promise<ChannelPerformanceDashboard> {
  const propertyId = input.propertyId;
  const days = Number.isFinite(input.days) && (input.days as number) > 0 ? Math.floor(input.days as number) : 30;
  const now = new Date();
  const windowStart = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);

  // 1) Parallel fetch of every input we need.
  const [
    channels,
    profitabilitySnapshots,
    rateMappings,
    roomMappings,
    syncJobs,
    parityAlerts,
    externalReservations
  ] = await Promise.all([
    prisma.channel.findMany({ where: { propertyId } }),
    prisma.channelProfitabilitySnapshot.findMany({
      where: { propertyId, date: { gte: windowStart, lte: now } }
    }),
    prisma.channelRateMapping.findMany({
      where: { channelId: { in: [] } } // refined below
    }).catch(() => [] as Array<{ id: string; channelId: string; ratePlanId: string; externalRateCode: string; externalRateName: string | null; status: string }>),
    prisma.channelRoomMapping.findMany({
      where: { channelId: { in: [] } }
    }).catch(() => [] as Array<{ id: string; channelId: string; roomTypeId: string; externalRoomCode: string; externalRoomName: string | null; status: string }>),
    prisma.channelSyncJob.findMany({
      where: { propertyId, createdAt: { gte: windowStart } }
    }),
    prisma.rateParityAlert.findMany({
      where: { propertyId },
      orderBy: { createdAt: "desc" },
      take: 50
    }),
    prisma.externalReservation.findMany({
      where: { propertyId, importedAt: { gte: windowStart, lte: now } }
    })
  ]);

  const channelIds = channels.map((c) => c.id);

  // Re-fetch mappings now that we know the channel IDs (Prisma "in: []"
  // short-circuits with no rows, so the placeholder above is intentional
  // and we ignore its result).
  const [realRateMappings, realRoomMappings] = channelIds.length
    ? await Promise.all([
        prisma.channelRateMapping.findMany({ where: { channelId: { in: channelIds } } }),
        prisma.channelRoomMapping.findMany({ where: { channelId: { in: channelIds } } })
      ])
    : [[] as typeof rateMappings, [] as typeof roomMappings];

  void rateMappings;
  void roomMappings;
  void realRateMappings;
  void realRoomMappings;

  // 2) Build channel lookup maps for resolving free-form channel strings to
  //    display names. Try providerCode first, then name (case-insensitive).
  const channelByProvider = new Map<string, typeof channels[number]>();
  const channelByNameLower = new Map<string, typeof channels[number]>();
  for (const ch of channels) {
    if (ch.providerCode) channelByProvider.set(ch.providerCode, ch);
    if (ch.name) channelByNameLower.set(ch.name.toLowerCase(), ch);
  }

  function resolveChannelName(raw: string | null | undefined): string {
    if (!raw) return "Direct / Unknown";
    const byProvider = channelByProvider.get(raw);
    if (byProvider) return byProvider.name;
    const byName = channelByNameLower.get(raw.toLowerCase());
    if (byName) return byName.name;
    return raw;
  }

  // 3) KPIs.
  const activeChannels = channels.filter((c) => c.status === "active").length;
  const openParityAlerts = parityAlerts.filter((a) => a.status === "open").length;
  const commissionValues = channels
    .map((c) => (c.commissionPercent === null || c.commissionPercent === undefined ? null : dec(c.commissionPercent)))
    .filter((v): v is number => v !== null);
  const avgCommissionPct = commissionValues.length
    ? round1(commissionValues.reduce((sum, v) => sum + v, 0) / commissionValues.length)
    : 0;
  const reservations30d = externalReservations.length;
  const revenue30dEur = round(
    profitabilitySnapshots.reduce((sum, s) => sum + dec(s.grossRevenue), 0)
  );

  // 4) Channel mix — reservations by channel from ExternalReservation, revenue
  //    by channel from ChannelProfitabilitySnapshot. Joined by channelId for
  //    reservations, by free-form string for snapshots.
  type MixAgg = { channelName: string; reservations: number; revenueEur: number };
  const mixMap = new Map<string, MixAgg>();

  function bumpMix(key: string, channelName: string, reservations: number, revenue: number) {
    const existing = mixMap.get(key);
    if (existing) {
      existing.reservations += reservations;
      existing.revenueEur = round(existing.revenueEur + revenue);
    } else {
      mixMap.set(key, { channelName, reservations, revenueEur: round(revenue) });
    }
  }

  const channelById = new Map(channels.map((c) => [c.id, c] as const));
  for (const res of externalReservations) {
    const ch = res.channelId ? channelById.get(res.channelId) : null;
    const name = ch ? ch.name : "Direct / Unknown";
    const key = ch ? ch.id : "__direct__";
    bumpMix(key, name, 1, 0);
  }
  for (const snap of profitabilitySnapshots) {
    const name = resolveChannelName(snap.channel);
    // Prefer matching by resolved channel id when possible so reservations and
    // revenue collapse into the same row.
    const matched = channelByProvider.get(snap.channel) ?? channelByNameLower.get((snap.channel ?? "").toLowerCase());
    const key = matched ? matched.id : `__name__:${name}`;
    bumpMix(key, name, 0, dec(snap.grossRevenue));
  }

  const mixTotalRev = Array.from(mixMap.values()).reduce((sum, m) => sum + m.revenueEur, 0);
  const channelMix = Array.from(mixMap.values())
    .map((m) => ({
      channelName: m.channelName,
      reservations: m.reservations,
      revenueEur: m.revenueEur,
      sharePct: mixTotalRev > 0 ? round1((m.revenueEur / mixTotalRev) * 100) : 0
    }))
    .sort((a, b) => b.revenueEur - a.revenueEur || b.reservations - a.reservations);

  // 5) Top profitable channels — aggregate snapshots by channel string.
  type ProfitAgg = { channelName: string; netRevenueEur: number; commissionEur: number; grossRevenueEur: number };
  const profitMap = new Map<string, ProfitAgg>();
  for (const snap of profitabilitySnapshots) {
    const name = resolveChannelName(snap.channel);
    const matched = channelByProvider.get(snap.channel) ?? channelByNameLower.get((snap.channel ?? "").toLowerCase());
    const key = matched ? matched.id : `__name__:${name}`;
    const existing = profitMap.get(key);
    const gross = dec(snap.grossRevenue);
    const net = dec(snap.netRevenue);
    const commission = dec(snap.commissionCost);
    if (existing) {
      existing.netRevenueEur = round(existing.netRevenueEur + net);
      existing.commissionEur = round(existing.commissionEur + commission);
      existing.grossRevenueEur = round(existing.grossRevenueEur + gross);
    } else {
      profitMap.set(key, {
        channelName: name,
        netRevenueEur: round(net),
        commissionEur: round(commission),
        grossRevenueEur: round(gross)
      });
    }
  }
  const topProfitableChannels = Array.from(profitMap.values())
    .map((p) => ({
      channelName: p.channelName,
      netRevenueEur: p.netRevenueEur,
      commissionEur: p.commissionEur,
      marginPct: p.grossRevenueEur > 0 ? round1((p.netRevenueEur / p.grossRevenueEur) * 100) : 0
    }))
    .sort((a, b) => b.netRevenueEur - a.netRevenueEur)
    .slice(0, 10);

  // 6) Recent parity alerts — most recent 10. resolvedAt only present when
  //    status === "resolved"; the schema has no dedicated column.
  const recentParityAlerts = parityAlerts.slice(0, 10).map((alert) => ({
    id: alert.id,
    channelName: alert.sourceChannel ? resolveChannelName(alert.sourceChannel) : undefined,
    severity: alert.severity ?? undefined,
    detectedAt: alert.createdAt.toISOString(),
    resolvedAt: alert.status === "resolved" ? alert.createdAt.toISOString() : undefined,
    description: alert.message ?? undefined
  }));

  // 7) Sync job status counts.
  const syncCounts = new Map<string, number>();
  for (const job of syncJobs) {
    syncCounts.set(job.status, (syncCounts.get(job.status) ?? 0) + 1);
  }
  const syncJobsStatus = Array.from(syncCounts.entries())
    .map(([status, count]) => ({ status, count }))
    .sort((a, b) => b.count - a.count);

  return {
    kpis: {
      activeChannels,
      openParityAlerts,
      avgCommissionPct,
      reservations30d,
      revenue30dEur
    },
    channelMix,
    topProfitableChannels,
    recentParityAlerts,
    syncJobsStatus
  };
}
