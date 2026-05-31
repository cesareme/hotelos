import { prisma } from "@hotelos/database";
import type { Prisma } from "@hotelos/database";

/**
 * Period metrics for the revenue Comparison tool. Aggregates the top-level
 * RevenueDailySnapshot roll-ups over a [from, to] window into the headline KPIs
 * (occupancy, ADR, RevPAR, room/total revenue, GOPPAR, rooms sold). The screen
 * calls this twice — current vs. comparison window — and computes the deltas.
 */

export type PeriodMetrics = {
  from: string;
  to: string;
  days: number; // number of snapshot days actually found
  roomsSold: number;
  occupancyPct: number;
  adr: number;
  revpar: number;
  goppar: number;
  roomRevenue: number;
  totalRevenue: number;
  hasData: boolean;
};

function dec(value: Prisma.Decimal | number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  const n = Number(value as unknown as string);
  return Number.isFinite(n) ? n : 0;
}
function round2(n: number): number {
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}
function utcDay(input: string): Date {
  const d = new Date(input);
  if (Number.isNaN(d.getTime())) return new Date(Date.UTC(1970, 0, 1));
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

export async function getPeriodMetrics(input: { propertyId: string; from: string; to: string }): Promise<PeriodMetrics> {
  const start = utcDay(input.from);
  const end = utcDay(input.to);

  const snaps = await prisma.revenueDailySnapshot.findMany({
    where: {
      propertyId: input.propertyId,
      snapshotDate: { gte: start, lte: end },
      // Top-level roll-ups only (no per-segment/channel duplicates).
      roomTypeId: null,
      ratePlanId: null,
      channelId: null,
      segment: null,
      market: null
    },
    select: { totalOcc: true, roomRevenue: true, totalRevenue: true, revpar: true, occupancyPercent: true, goppar: true }
  });

  let roomsSold = 0;
  let roomRevenue = 0;
  let totalRevenue = 0;
  let occSum = 0;
  let occDays = 0;
  let revparSum = 0;
  let revparDays = 0;
  let gopparSum = 0;
  let gopparDays = 0;

  for (const s of snaps) {
    roomsSold += s.totalOcc;
    roomRevenue += dec(s.roomRevenue);
    totalRevenue += dec(s.totalRevenue);
    const occ = dec(s.occupancyPercent);
    if (occ > 0 || s.totalOcc > 0) {
      occSum += occ;
      occDays += 1;
    }
    const rp = dec(s.revpar);
    if (rp > 0) {
      revparSum += rp;
      revparDays += 1;
    }
    const gp = dec(s.goppar);
    if (gp !== 0) {
      gopparSum += gp;
      gopparDays += 1;
    }
  }

  return {
    from: input.from,
    to: input.to,
    days: snaps.length,
    roomsSold,
    occupancyPct: occDays > 0 ? round2(occSum / occDays) : 0,
    adr: roomsSold > 0 ? round2(roomRevenue / roomsSold) : 0,
    revpar: revparDays > 0 ? round2(revparSum / revparDays) : 0,
    goppar: gopparDays > 0 ? round2(gopparSum / gopparDays) : 0,
    roomRevenue: round2(roomRevenue),
    totalRevenue: round2(totalRevenue),
    hasData: snaps.length > 0
  };
}
