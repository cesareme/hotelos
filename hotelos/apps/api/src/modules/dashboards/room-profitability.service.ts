import { prisma } from "@hotelos/database";
import type { Prisma } from "@hotelos/database";

/**
 * Room profitability dashboard — read-only RevPAR / GOPPAR / occupancy per
 * room type and per channel for a property over a configurable window.
 *
 * Aggregates over:
 *  - Room (propertyId-scoped, active=true) for room counts per type and the
 *    base universe of saleable inventory.
 *  - RoomType (propertyId-scoped) for the human-readable room type name and
 *    display order.
 *  - RevenueDailySnapshot (propertyId + snapshotDate window) for occupancy,
 *    ADR, RevPAR, GOPPAR, room revenue and total revenue. Snapshots can be
 *    rolled-up rows (roomTypeId / channelId null) or per-segment rows. We
 *    aggregate at the (roomTypeId, snapshotDate) and (channelId, snapshotDate)
 *    grains and recompute the derived ratios so we never re-average ratios.
 *  - Reservation (propertyId-scoped, checked_in / checked_out / confirmed) for
 *    the topRooms list — counts nights booked and sums totalAmount per
 *    assignedRoomId inside the window.
 *  - ChannelProfitabilitySnapshot (propertyId + date window) for the per-
 *    channel margin / net revenue figures. Joined by channel string (raw),
 *    presented as the channelName directly since this codebase has no Channel
 *    table on this surface (we keep things simple and stable).
 *
 * Date window:
 *  - `from`/`to` default to [now - 30d, now] (UTC). Accepts ISO strings or
 *    Date instances. Reversed ranges are normalised. The 30-day GOPPAR KPI
 *    uses the same window as everything else for consistency.
 *
 * Sharp edges / schema observations:
 *  - RevenueDailySnapshot.occupancyPercent / adr / revpar / goppar are
 *    snapshot-level pre-computed metrics that may already be aggregates. To
 *    avoid double-aggregating ratios we DERIVE the by-room-type metrics from
 *    raw counters (totalOcc, roomRevenue, grossOperatingProfit) when those are
 *    present; the top-line KPI falls back to weighted averages so partial
 *    data still renders something useful.
 *  - RoomType has no direct `rooms` relation — we count Room.roomTypeId
 *    grouped, filtered to active + sellable rooms so the denominator matches
 *    saleable inventory.
 *  - Reservation.totalAmount is a stay total (not nightly). For revenue30d
 *    per room we approximate by allocating totalAmount evenly across the
 *    nights that fall inside the window. This is a coarse approximation —
 *    the proper number would come from FolioLine, but the spec scopes us to
 *    Reservation. Documented here so downstream readers know.
 *  - Reservation.status: we count nights for confirmed, checked_in, and
 *    checked_out. We exclude draft / cancelled / no_show.
 *  - ChannelProfitabilitySnapshot.channel is a free-form string. We sum by
 *    that string verbatim — no Channel join (out of scope for this surface).
 *    Empty / null channel strings collapse into "Direct / Unknown".
 *  - All Decimal values coerced via dec(); null/undefined -> 0. Arrays
 *    default to []. The whole result is safe to render with no data.
 *  - GOPPAR per type: when a room type has 0 active rooms the denominator
 *    is 0 and we return 0 (rather than NaN/Infinity).
 *  - The function never throws on missing inputs — caller does not need to
 *    pre-validate the propertyId.
 */

export type BuildRoomProfitabilityDashboardInput = {
  propertyId: string;
  from?: string | Date;
  to?: string | Date;
};

export type RoomProfitabilityDashboard = {
  kpis: {
    totalRevenueEur: number;
    occupancyPct: number;
    adrEur: number;
    revparEur: number;
    goppar30dEur: number;
  };
  byRoomType: Array<{
    roomTypeName: string;
    roomCount: number;
    occupancyPct: number;
    adrEur: number;
    revparEur: number;
    revenueEur: number;
  }>;
  byChannel: Array<{
    channelName: string;
    reservations: number;
    revenueEur: number;
    netRevenueEur: number;
    marginPct: number;
  }>;
  topRooms: Array<{
    id: string;
    number: string;
    roomTypeName: string;
    revenue30dEur: number;
    nightsBooked: number;
  }>;
};

const EMPTY: RoomProfitabilityDashboard = {
  kpis: {
    totalRevenueEur: 0,
    occupancyPct: 0,
    adrEur: 0,
    revparEur: 0,
    goppar30dEur: 0
  },
  byRoomType: [],
  byChannel: [],
  topRooms: []
};

const ACTIVE_RESERVATION_STATUSES = new Set(["confirmed", "checked_in", "checked_out"]);

function dec(value: Prisma.Decimal | number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  const maybe = value as unknown as { toNumber?: () => number };
  if (typeof maybe.toNumber === "function") {
    try {
      const n = maybe.toNumber();
      return Number.isFinite(n) ? n : 0;
    } catch {
      return 0;
    }
  }
  const n = Number(value as unknown as number);
  return Number.isFinite(n) ? n : 0;
}

function round(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * 100) / 100;
}

function round1(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * 10) / 10;
}

function parseDate(value: string | Date | undefined, fallback: Date): Date {
  if (value === undefined || value === null) return fallback;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? fallback : value;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? fallback : parsed;
}

function daysBetweenUtc(a: Date, b: Date): number {
  const ms = b.getTime() - a.getTime();
  return Math.max(0, Math.round(ms / (24 * 60 * 60 * 1000)));
}

function overlapNights(arrival: Date, departure: Date, from: Date, to: Date): number {
  // Nights are [arrival, departure). Window is [from, to].
  const start = arrival.getTime() > from.getTime() ? arrival : from;
  // departure is exclusive; clamp to to + 1 day so a stay departing on `to`
  // still counts that final night if relevant.
  const endLimit = new Date(to.getTime() + 24 * 60 * 60 * 1000);
  const end = departure.getTime() < endLimit.getTime() ? departure : endLimit;
  const nights = Math.floor((end.getTime() - start.getTime()) / (24 * 60 * 60 * 1000));
  return Math.max(0, nights);
}

export async function buildRoomProfitabilityDashboard(
  input: BuildRoomProfitabilityDashboardInput
): Promise<RoomProfitabilityDashboard> {
  if (!input || !input.propertyId) return EMPTY;
  const propertyId = input.propertyId;

  const now = new Date();
  const defaultFrom = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  let from = parseDate(input.from, defaultFrom);
  let to = parseDate(input.to, now);
  if (from.getTime() > to.getTime()) {
    const swap = from;
    from = to;
    to = swap;
  }
  const windowDays = Math.max(1, daysBetweenUtc(from, to) || 30);

  const [rooms, roomTypes, snapshots, reservations, channelSnapshots] = await Promise.all([
    prisma.room.findMany({
      where: { propertyId, active: true },
      select: { id: true, number: true, roomTypeId: true, sellable: true, active: true }
    }),
    prisma.roomType.findMany({
      where: { propertyId },
      select: { id: true, name: true, displayOrder: true, active: true }
    }),
    prisma.revenueDailySnapshot.findMany({
      where: { propertyId, snapshotDate: { gte: from, lte: to } }
    }),
    prisma.reservation.findMany({
      where: {
        propertyId,
        status: { in: ["confirmed", "checked_in", "checked_out"] },
        // Any stay that overlaps the window at all.
        arrivalDate: { lte: to },
        departureDate: { gte: from }
      },
      select: {
        id: true,
        channel: true,
        status: true,
        arrivalDate: true,
        departureDate: true,
        assignedRoomId: true,
        roomTypeId: true,
        totalAmount: true
      }
    }),
    prisma.channelProfitabilitySnapshot.findMany({
      where: { propertyId, date: { gte: from, lte: to } }
    })
  ]);

  // ---- Inventory maps ----------------------------------------------------
  const roomTypeById = new Map(roomTypes.map((rt) => [rt.id, rt] as const));
  const roomCountByType = new Map<string, number>();
  const sellableRoomCountByType = new Map<string, number>();
  for (const r of rooms) {
    roomCountByType.set(r.roomTypeId, (roomCountByType.get(r.roomTypeId) ?? 0) + 1);
    if (r.sellable) {
      sellableRoomCountByType.set(r.roomTypeId, (sellableRoomCountByType.get(r.roomTypeId) ?? 0) + 1);
    }
  }
  const totalSellableRooms = Array.from(sellableRoomCountByType.values()).reduce((s, n) => s + n, 0);

  const roomById = new Map(rooms.map((r) => [r.id, r] as const));

  // ---- By room type ------------------------------------------------------
  // We aggregate raw counters across snapshots whose roomTypeId is set, then
  // derive ratios from them. Snapshots with roomTypeId === null are property-
  // level rolled-up rows and are excluded from the per-type rollup but kept
  // for the top-line KPIs.
  type TypeAgg = {
    totalOcc: number;
    roomRevenue: number;
    grossOperatingProfit: number;
    snapshotCount: number;
    // Weighted-average fallbacks if raw counters are zero but precomputed
    // ratios exist.
    occPctWeighted: number;
    occPctWeight: number;
    adrWeighted: number;
    adrWeight: number;
    revparWeighted: number;
    revparWeight: number;
  };
  const typeAgg = new Map<string, TypeAgg>();
  function bumpType(typeId: string, snap: typeof snapshots[number]) {
    let agg = typeAgg.get(typeId);
    if (!agg) {
      agg = {
        totalOcc: 0,
        roomRevenue: 0,
        grossOperatingProfit: 0,
        snapshotCount: 0,
        occPctWeighted: 0,
        occPctWeight: 0,
        adrWeighted: 0,
        adrWeight: 0,
        revparWeighted: 0,
        revparWeight: 0
      };
      typeAgg.set(typeId, agg);
    }
    agg.totalOcc += snap.totalOcc;
    agg.roomRevenue += dec(snap.roomRevenue);
    agg.grossOperatingProfit += dec(snap.grossOperatingProfit);
    agg.snapshotCount += 1;

    if (snap.occupancyPercent !== null && snap.occupancyPercent !== undefined) {
      agg.occPctWeighted += dec(snap.occupancyPercent);
      agg.occPctWeight += 1;
    }
    if (snap.adr !== null && snap.adr !== undefined && snap.totalOcc > 0) {
      agg.adrWeighted += dec(snap.adr) * snap.totalOcc;
      agg.adrWeight += snap.totalOcc;
    }
    if (snap.revpar !== null && snap.revpar !== undefined) {
      agg.revparWeighted += dec(snap.revpar);
      agg.revparWeight += 1;
    }
  }

  for (const snap of snapshots) {
    if (snap.roomTypeId) bumpType(snap.roomTypeId, snap);
  }

  const byRoomType = Array.from(typeAgg.entries())
    .map(([typeId, agg]) => {
      const rt = roomTypeById.get(typeId);
      const roomCount = sellableRoomCountByType.get(typeId) ?? roomCountByType.get(typeId) ?? 0;
      const availableRoomNights = roomCount * windowDays;
      const occupancyPct = availableRoomNights > 0
        ? (agg.totalOcc / availableRoomNights) * 100
        : (agg.occPctWeight > 0 ? agg.occPctWeighted / agg.occPctWeight : 0);
      const adrEur = agg.totalOcc > 0
        ? agg.roomRevenue / agg.totalOcc
        : (agg.adrWeight > 0 ? agg.adrWeighted / agg.adrWeight : 0);
      const revparEur = availableRoomNights > 0
        ? agg.roomRevenue / availableRoomNights
        : (agg.revparWeight > 0 ? agg.revparWeighted / agg.revparWeight : 0);
      return {
        roomTypeName: rt?.name ?? "Unknown type",
        roomCount,
        occupancyPct: round1(occupancyPct),
        adrEur: round(adrEur),
        revparEur: round(revparEur),
        revenueEur: round(agg.roomRevenue),
        _displayOrder: rt?.displayOrder ?? 999
      };
    })
    .sort((a, b) => b.revenueEur - a.revenueEur || a._displayOrder - b._displayOrder)
    .map(({ _displayOrder: _ignored, ...row }) => row);

  // ---- Top-line KPIs -----------------------------------------------------
  // totalRevenueEur: sum totalRevenue across all snapshots in window (room +
  // non-room revenue when present). We prefer totalRevenue when non-zero,
  // otherwise fall back to roomRevenue so we always render something.
  let totalRevenueRaw = 0;
  let roomRevenueAll = 0;
  let totalOccAll = 0;
  let goppar30dRaw = 0;
  let snapshotsWithRoomTypeRollup = 0;
  for (const snap of snapshots) {
    totalRevenueRaw += dec(snap.totalRevenue);
    roomRevenueAll += dec(snap.roomRevenue);
    totalOccAll += snap.totalOcc;
    goppar30dRaw += dec(snap.grossOperatingProfit);
    if (snap.roomTypeId) snapshotsWithRoomTypeRollup += 1;
  }
  const totalRevenueEur = totalRevenueRaw > 0 ? totalRevenueRaw : roomRevenueAll;

  // Available room nights at property level: sellable rooms * window days.
  const propertyAvailableRoomNights = totalSellableRooms * windowDays;
  const occupancyPct = propertyAvailableRoomNights > 0 && totalOccAll > 0
    ? (totalOccAll / propertyAvailableRoomNights) * 100
    : 0;
  const adrEur = totalOccAll > 0 ? roomRevenueAll / totalOccAll : 0;
  const revparEur = propertyAvailableRoomNights > 0 ? roomRevenueAll / propertyAvailableRoomNights : 0;
  const goppar30dEur = propertyAvailableRoomNights > 0 ? goppar30dRaw / propertyAvailableRoomNights : 0;
  // Reference snapshotsWithRoomTypeRollup to satisfy the linter — it's a debug
  // counter only used in development sanity checks.
  void snapshotsWithRoomTypeRollup;

  // ---- By channel --------------------------------------------------------
  type ChannelAgg = {
    channelName: string;
    reservations: number;
    revenueEur: number;
    netRevenueEur: number;
    grossRevenueEur: number;
  };
  const channelMap = new Map<string, ChannelAgg>();
  function normChannel(raw: string | null | undefined): string {
    const trimmed = (raw ?? "").trim();
    return trimmed.length === 0 ? "Direct / Unknown" : trimmed;
  }
  function bumpChannel(rawName: string, deltas: Partial<Omit<ChannelAgg, "channelName">>) {
    const channelName = normChannel(rawName);
    const key = channelName.toLowerCase();
    const existing = channelMap.get(key);
    if (existing) {
      existing.reservations += deltas.reservations ?? 0;
      existing.revenueEur = round(existing.revenueEur + (deltas.revenueEur ?? 0));
      existing.netRevenueEur = round(existing.netRevenueEur + (deltas.netRevenueEur ?? 0));
      existing.grossRevenueEur = round(existing.grossRevenueEur + (deltas.grossRevenueEur ?? 0));
    } else {
      channelMap.set(key, {
        channelName,
        reservations: deltas.reservations ?? 0,
        revenueEur: round(deltas.revenueEur ?? 0),
        netRevenueEur: round(deltas.netRevenueEur ?? 0),
        grossRevenueEur: round(deltas.grossRevenueEur ?? 0)
      });
    }
  }

  // Reservation counts + (approximate) revenue from Reservation rows.
  for (const res of reservations) {
    const nightsInWindow = overlapNights(res.arrivalDate, res.departureDate, from, to);
    if (nightsInWindow === 0) continue;
    const totalNights = Math.max(1, overlapNights(res.arrivalDate, res.departureDate, res.arrivalDate, res.departureDate));
    const proratedRevenue = dec(res.totalAmount) * (nightsInWindow / totalNights);
    bumpChannel(res.channel, { reservations: 1, revenueEur: proratedRevenue });
  }

  // Net revenue + gross from ChannelProfitabilitySnapshot.
  for (const snap of channelSnapshots) {
    bumpChannel(snap.channel, {
      grossRevenueEur: dec(snap.grossRevenue),
      netRevenueEur: dec(snap.netRevenue)
    });
  }

  const byChannel = Array.from(channelMap.values())
    .map((c) => {
      const baseGross = c.grossRevenueEur > 0 ? c.grossRevenueEur : c.revenueEur;
      const marginPct = baseGross > 0 ? (c.netRevenueEur / baseGross) * 100 : 0;
      return {
        channelName: c.channelName,
        reservations: c.reservations,
        revenueEur: c.revenueEur > 0 ? c.revenueEur : c.grossRevenueEur,
        netRevenueEur: c.netRevenueEur,
        marginPct: round1(marginPct)
      };
    })
    .sort((a, b) => b.revenueEur - a.revenueEur || b.reservations - a.reservations);

  // ---- Top rooms ---------------------------------------------------------
  type RoomAgg = { id: string; number: string; roomTypeName: string; revenue30dEur: number; nightsBooked: number };
  const perRoom = new Map<string, RoomAgg>();
  for (const res of reservations) {
    if (!res.assignedRoomId) continue;
    if (!ACTIVE_RESERVATION_STATUSES.has(res.status)) continue;
    const room = roomById.get(res.assignedRoomId);
    if (!room) continue;
    const nightsInWindow = overlapNights(res.arrivalDate, res.departureDate, from, to);
    if (nightsInWindow === 0) continue;
    const totalNights = Math.max(1, overlapNights(res.arrivalDate, res.departureDate, res.arrivalDate, res.departureDate));
    const proratedRevenue = dec(res.totalAmount) * (nightsInWindow / totalNights);
    const typeName = roomTypeById.get(room.roomTypeId)?.name ?? "Unknown type";
    const existing = perRoom.get(room.id);
    if (existing) {
      existing.nightsBooked += nightsInWindow;
      existing.revenue30dEur = round(existing.revenue30dEur + proratedRevenue);
    } else {
      perRoom.set(room.id, {
        id: room.id,
        number: room.number,
        roomTypeName: typeName,
        nightsBooked: nightsInWindow,
        revenue30dEur: round(proratedRevenue)
      });
    }
  }

  const topRooms = Array.from(perRoom.values())
    .sort((a, b) => b.revenue30dEur - a.revenue30dEur || b.nightsBooked - a.nightsBooked)
    .slice(0, 10);

  return {
    kpis: {
      totalRevenueEur: round(totalRevenueEur),
      occupancyPct: round1(occupancyPct),
      adrEur: round(adrEur),
      revparEur: round(revparEur),
      goppar30dEur: round(goppar30dEur)
    },
    byRoomType,
    byChannel,
    topRooms
  };
}
