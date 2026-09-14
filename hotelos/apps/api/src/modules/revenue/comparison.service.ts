import { prisma } from "@hotelos/database";
import { dayUtc, getRealizedByDay, round2, type RealizedDay, type RealizedSourceLabel } from "./actuals.js";

/**
 * Period metrics for the revenue Comparison tool (and the "cierre mensual"
 * export). Aggregates the shared realized-per-day rule — audited top-level
 * RevenueDailySnapshot first, reservations fallback for days without a close,
 * PAST DAYS ONLY — over a [from, to] window into the headline KPIs (occupancy,
 * ADR, RevPAR, room/total revenue, GOPPAR, rooms sold). The screen calls this
 * twice — current vs. comparison window — and computes the deltas.
 *
 * GOPPAR only exists on audited snapshots; fallback days do not contribute.
 *
 * Bases (pilot verification, 2026-09): `roomsSold` is the close's totalOcc
 * (house use INCLUDED, same as the PMS "Total Occ" column); ADR divides room
 * revenue by `paidRooms` (totalOcc − house use), which is the PMS's own ADR
 * base — dividing by totalOcc gave 99,73 for Aug-26 where the PMS reports
 * 104,57. `paidRooms` and `houseUseRooms` are exposed so the caller can see
 * both bases; the response shape is otherwise unchanged.
 */

export type PeriodMetrics = {
  from: string;
  to: string;
  /** Past days with data in the window (snapshot or reservations fallback). */
  days: number;
  snapshotDays: number;
  fallbackDays: number;
  source: RealizedSourceLabel | null;
  /** Occupied rooms per the close (totalOcc): includes house use. */
  roomsSold: number;
  /** Paying rooms (totalOcc − house use): the ADR denominator. */
  paidRooms: number;
  houseUseRooms: number;
  occupancyPct: number;
  /** roomRevenue / paidRooms (PMS convention), 0 when no paying room. */
  adr: number;
  revpar: number;
  goppar: number;
  roomRevenue: number;
  totalRevenue: number;
  hasData: boolean;
};

/** Pure aggregation of realized days into the period KPIs (no I/O; unit-tested). */
export function aggregatePeriodMetrics(days: Iterable<RealizedDay>): Pick<
  PeriodMetrics,
  "roomsSold" | "paidRooms" | "houseUseRooms" | "occupancyPct" | "adr" | "revpar" | "goppar" | "roomRevenue" | "totalRevenue"
> {
  let roomsSold = 0;
  let paidRooms = 0;
  let houseUseRooms = 0;
  let roomRevenue = 0;
  let totalRevenue = 0;
  let occSum = 0;
  let occDays = 0;
  let revparSum = 0;
  let revparDays = 0;
  let gopparSum = 0;
  let gopparDays = 0;

  for (const d of days) {
    roomsSold += d.rooms;
    paidRooms += d.paidRooms;
    houseUseRooms += d.houseUseRooms;
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
    roomsSold,
    paidRooms,
    houseUseRooms,
    occupancyPct: occDays > 0 ? round2(occSum / occDays) : 0,
    adr: paidRooms > 0 ? round2(roomRevenue / paidRooms) : 0,
    revpar: revparDays > 0 ? round2(revparSum / revparDays) : 0,
    goppar: gopparDays > 0 ? round2(gopparSum / gopparDays) : 0,
    roomRevenue: round2(roomRevenue),
    totalRevenue: round2(totalRevenue)
  };
}

export async function getPeriodMetrics(input: { propertyId: string; from: string; to: string }): Promise<PeriodMetrics> {
  const start = dayUtc(input.from);
  const end = dayUtc(input.to);

  const totalRooms = await prisma.room.count({ where: { propertyId: input.propertyId, sellable: true } });
  const realized = await getRealizedByDay(input.propertyId, start, end, { totalRooms });
  const metrics = aggregatePeriodMetrics(realized.days.values());

  return {
    from: input.from,
    to: input.to,
    days: realized.days.size,
    snapshotDays: realized.snapshotDays,
    fallbackDays: realized.fallbackDays,
    source: realized.source,
    ...metrics,
    // Audited closes count as data even at 0; a pure fallback window only when it has rooms.
    hasData: realized.snapshotDays > 0 || metrics.roomsSold > 0
  };
}
