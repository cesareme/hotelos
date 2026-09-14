import { prisma } from "@hotelos/database";
import { dayUtc, getRealizedByDay, round2, type RealizedSourceLabel } from "./actuals.js";

/**
 * Period metrics for the revenue Comparison tool (and the "cierre mensual"
 * export). Aggregates the shared realized-per-day rule — audited top-level
 * RevenueDailySnapshot first, reservations fallback for days without a close,
 * PAST DAYS ONLY — over a [from, to] window into the headline KPIs (occupancy,
 * ADR, RevPAR, room/total revenue, GOPPAR, rooms sold). The screen calls this
 * twice — current vs. comparison window — and computes the deltas.
 *
 * GOPPAR only exists on audited snapshots; fallback days do not contribute.
 */

export type PeriodMetrics = {
  from: string;
  to: string;
  /** Past days with data in the window (snapshot or reservations fallback). */
  days: number;
  snapshotDays: number;
  fallbackDays: number;
  source: RealizedSourceLabel | null;
  roomsSold: number;
  occupancyPct: number;
  adr: number;
  revpar: number;
  goppar: number;
  roomRevenue: number;
  totalRevenue: number;
  hasData: boolean;
};

export async function getPeriodMetrics(input: { propertyId: string; from: string; to: string }): Promise<PeriodMetrics> {
  const start = dayUtc(input.from);
  const end = dayUtc(input.to);

  const totalRooms = await prisma.room.count({ where: { propertyId: input.propertyId, sellable: true } });
  const realized = await getRealizedByDay(input.propertyId, start, end, { totalRooms });

  let roomsSold = 0;
  let roomRevenue = 0;
  let totalRevenue = 0;
  let occSum = 0;
  let occDays = 0;
  let revparSum = 0;
  let revparDays = 0;
  let gopparSum = 0;
  let gopparDays = 0;

  for (const d of realized.days.values()) {
    roomsSold += d.rooms;
    roomRevenue += d.roomRevenue;
    totalRevenue += d.totalRevenue;
    if (d.occPct > 0 || d.rooms > 0) {
      occSum += d.occPct;
      occDays += 1;
    }
    if (d.revpar !== null && d.revpar > 0) {
      revparSum += d.revpar;
      revparDays += 1;
    }
    if (d.goppar !== null && d.goppar !== 0) {
      gopparSum += d.goppar;
      gopparDays += 1;
    }
  }

  return {
    from: input.from,
    to: input.to,
    days: realized.days.size,
    snapshotDays: realized.snapshotDays,
    fallbackDays: realized.fallbackDays,
    source: realized.source,
    roomsSold,
    occupancyPct: occDays > 0 ? round2(occSum / occDays) : 0,
    adr: roomsSold > 0 ? round2(roomRevenue / roomsSold) : 0,
    revpar: revparDays > 0 ? round2(revparSum / revparDays) : 0,
    goppar: gopparDays > 0 ? round2(gopparSum / gopparDays) : 0,
    roomRevenue: round2(roomRevenue),
    totalRevenue: round2(totalRevenue),
    // Audited closes count as data even at 0; a pure fallback window only when it has rooms.
    hasData: realized.snapshotDays > 0 || roomsSold > 0
  };
}
