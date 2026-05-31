// Parity monitor: compares our RateDay prices to competitor / channel-fetched
// prices for the same dates and inserts RateParityAlert rows when the gap
// exceeds a threshold (default ±3%). The threshold is intentionally low
// because the OTA agreements we model require strict parity; production teams
// usually adjust this per market.
//
// Severity mapping (gapPercent is the signed difference from our price):
//   |gap| > 10%  → severity="critical"
//   |gap| > 5%   → severity="high"
//   |gap| > 3%   → severity="medium"   (also the insertion threshold)
//   else         → not recorded
//
// Sharp edges:
//   * RateParityAlert has no per-channel "comparedChannels" field; we encode
//     it inside `metadataJson`.
//   * `sourceChannel` stores the provider code so this aggregates cleanly in
//     the existing channel-performance dashboard.

import { prisma } from "@hotelos/database";
import type { Prisma } from "@hotelos/database";
import { resolveAdapter } from "./adapters/index.js";
import type { ChannelContext, ChannelProviderCode } from "./adapter.types.js";

const DEFAULT_THRESHOLD_PCT = 3;

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

function severityFor(absGapPct: number): "medium" | "high" | "critical" {
  if (absGapPct > 10) return "critical";
  if (absGapPct > 5) return "high";
  return "medium";
}

export async function monitorParity(input: {
  propertyId: string;
  dateRange: { from: string; to: string };
  thresholdPercent?: number;
}) {
  const threshold = input.thresholdPercent ?? DEFAULT_THRESHOLD_PCT;
  const from = new Date(input.dateRange.from);
  const to = new Date(input.dateRange.to);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    throw new Error("Invalid date range");
  }

  const [channels, rateDays] = await Promise.all([
    prisma.channel.findMany({ where: { propertyId: input.propertyId, status: "active" } }),
    prisma.rateDay.findMany({
      where: { propertyId: input.propertyId, date: { gte: from, lte: to } }
    })
  ]);

  // Our reference price per date: lowest RateDay across rate plans (the rate
  // we would expose as "from" on the direct booking engine).
  const ourPriceByDate = new Map<string, { price: number; currency: string }>();
  for (const r of rateDays) {
    const key = r.date.toISOString().slice(0, 10);
    const price = Number(r.price);
    const existing = ourPriceByDate.get(key);
    if (!existing || price < existing.price) ourPriceByDate.set(key, { price, currency: r.currency });
  }

  const createdAlerts: Array<{
    id: string;
    sourceChannel: string;
    stayDate: string;
    ourPrice: number;
    theirPrice: number;
    gapPercent: number;
    severity: string;
  }> = [];

  for (const channel of channels) {
    const adapter = resolveAdapter(channel.providerCode);
    if (!adapter || typeof adapter.fetchCompetitorRates !== "function") continue;
    const result = await adapter.fetchCompetitorRates({
      channel: toChannelContext(channel),
      dateRange: input.dateRange
    });
    if (!result.ok) continue;

    for (const competitor of result.rates) {
      const ours = ourPriceByDate.get(competitor.date);
      if (!ours || ours.price === 0) continue;
      const gapPercent = Math.round(((competitor.price - ours.price) / ours.price) * 10000) / 100;
      const absGap = Math.abs(gapPercent);
      if (absGap < threshold) continue;
      const severity = severityFor(absGap);

      const alert = await prisma.rateParityAlert.create({
        data: {
          propertyId: input.propertyId,
          alertType: "channel_gap",
          severity,
          stayDate: new Date(competitor.date),
          sourceChannel: channel.providerCode,
          directRate: ours.price as unknown as Prisma.Decimal,
          channelRate: competitor.price as unknown as Prisma.Decimal,
          currency: ours.currency,
          message: `${channel.name} priced ${gapPercent > 0 ? "above" : "below"} direct by ${absGap.toFixed(2)}% on ${competitor.date}`,
          status: "open",
          metadataJson: {
            comparedChannels: [channel.providerCode],
            competitorHotel: competitor.competitorHotel,
            gapPercent
          } as Prisma.InputJsonValue
        }
      });
      createdAlerts.push({
        id: alert.id,
        sourceChannel: channel.providerCode,
        stayDate: competitor.date,
        ourPrice: ours.price,
        theirPrice: competitor.price,
        gapPercent,
        severity
      });
    }
  }

  return {
    propertyId: input.propertyId,
    dateRange: input.dateRange,
    thresholdPercent: threshold,
    alertsCreated: createdAlerts.length,
    alerts: createdAlerts
  };
}

export async function listAlerts(input: {
  propertyId: string;
  status?: string;
  severity?: string;
}) {
  const alerts = await prisma.rateParityAlert.findMany({
    where: {
      propertyId: input.propertyId,
      ...(input.status ? { status: input.status } : {}),
      ...(input.severity ? { severity: input.severity } : {})
    },
    orderBy: { createdAt: "desc" },
    take: 200
  });
  return alerts.map((a) => ({
    id: a.id,
    propertyId: a.propertyId,
    alertType: a.alertType,
    severity: a.severity,
    stayDate: a.stayDate.toISOString().slice(0, 10),
    sourceChannel: a.sourceChannel,
    directRate: a.directRate !== null ? Number(a.directRate) : null,
    channelRate: a.channelRate !== null ? Number(a.channelRate) : null,
    currency: a.currency,
    message: a.message,
    status: a.status,
    createdAt: a.createdAt.toISOString(),
    metadataJson: a.metadataJson
  }));
}

export async function resolveAlert(id: string, userId: string) {
  const updated = await prisma.rateParityAlert.update({
    where: { id },
    data: {
      status: "resolved",
      metadataJson: {
        resolvedBy: userId,
        resolvedAt: new Date().toISOString()
      } as Prisma.InputJsonValue
    }
  });
  return {
    id: updated.id,
    status: updated.status
  };
}
