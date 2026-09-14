// Shared money-path resolvers for the revenue module (REV-03 / REV-04).
//
// ONE definition of "realized" (actual) per stay date and ONE definition of
// "published BAR" per stay date, consumed by the board, budget variance,
// forecast accuracy, period metrics, pricing, rate shop and displacement — so
// the same month can no longer produce three different "Real" figures and no
// consumer ever falls back to an invented rate.
//
//   getRealizedByDay  → audited RevenueDailySnapshot (top-level roll-up) first,
//                       reservations fallback per day, PAST DAYS ONLY. Every
//                       day carries its `source` and the window reports how
//                       many days came from each source.
//   getPublishedBar   → RateDay of the property's BAR plan (code "BAR" or
//                       ratePlanType "bar", active), minimum across sellable
//                       room types that actually have rooms. Missing → null,
//                       never a default price.
//
// `realizeDays` is the pure core (no I/O) so the board can feed it the rows it
// already loaded (ONE query per source contract) and unit tests can run
// without a database.

import { prisma } from "@hotelos/database";
import type { Prisma } from "@hotelos/database";
import { BadRequestError } from "../../lib/http-error.js";
import { isIsoDate } from "../../lib/query-dates.js";

export const MS_DAY = 86_400_000;

/**
 * Statuses that contribute to a PAST stay date: confirmed / checked_in /
 * checked_out count room nights and revenue; no_show only feeds the no-show
 * counter on its arrival date. Single source of truth for every consumer.
 */
export const REALIZED_STATUSES = ["confirmed", "checked_in", "checked_out", "no_show"] as const;
export const REALIZED_STATUS_FILTER = REALIZED_STATUSES as unknown as Prisma.EnumReservationStatusFilter["in"];

// ---- date + number helpers (exported for the CLI/backfill and tests) --------
export function dayUtc(value?: string | Date): Date {
  if (value instanceof Date) {
    return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
  }
  const base = value && /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : new Date().toISOString().slice(0, 10);
  return new Date(`${base}T00:00:00.000Z`);
}
export function addDays(d: Date, n: number): Date {
  return new Date(d.getTime() + n * MS_DAY);
}
export function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}
export function dec(v: Prisma.Decimal | number | null | undefined): number {
  return v === null || v === undefined ? 0 : typeof v === "number" ? v : Number(v);
}
export function decOrNull(v: Prisma.Decimal | number | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}
export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Strict calendar month key: YYYY-MM with MM in 01..12. */
export const MONTH_KEY_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

export type ParsedMonth = { year: number; month: number; from: Date; to: Date };

/**
 * Parse a YYYY-MM key into its UTC calendar bounds (first and last day).
 * Pure; throws BadRequestError (400) on '2024-13', '2024-00', '2024-1' or any
 * other shape so a bad query can never reach Prisma as an Invalid Date (which
 * surfaced as a PrismaClientValidationError → 500). Every month-addressable
 * consumer (budget variance, meeting pack, export center) goes through here.
 */
export function parseMonth(month: string): ParsedMonth {
  if (typeof month !== "string" || !MONTH_KEY_RE.test(month)) {
    throw new BadRequestError("month debe tener formato YYYY-MM válido");
  }
  const year = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7));
  return {
    year,
    month: m,
    from: new Date(Date.UTC(year, m - 1, 1)),
    to: new Date(Date.UTC(year, m, 0)) // day 0 of the next month = last day of this one
  };
}

// ---- query window (from/to) validation ---------------------------------------
export type RevenueWindow = { from: string; to: string; days: number };

/**
 * Validate a `from`/`to` query pair for the revenue read endpoints (board and
 * its aliases, live report, period metrics). `dayUtc` only checks the
 * `YYYY-MM-DD` shape, so `2026-13-99` used to become an Invalid Date and
 * surface as a Prisma 500; here every failure is a typed 400 with a Spanish
 * message BEFORE any DB call. Pure (no I/O) so it is unit-testable.
 *
 *   - missing → the caller's default (`defaultFrom` / `defaultTo`, the latter
 *     may derive from the resolved `from`); no default → 400.
 *   - malformed or non-existent calendar day → 400.
 *   - to < from → 400.
 *   - more than `maxDays` calendar days (inclusive) → 400 naming the limit,
 *     never a silent truncation.
 */
export function parseRevenueWindow(input: {
  from?: unknown;
  to?: unknown;
  maxDays: number;
  defaultFrom?: string;
  defaultTo?: string | ((from: string) => string);
  /** Spanish qualifier for the limit message, e.g. "del informe" → "la ventana máxima del informe es 120 días". */
  scope?: string;
}): RevenueWindow {
  const resolve = (name: "from" | "to", value: unknown, fallback: string | undefined): string => {
    if (value === undefined || value === null || value === "") {
      if (fallback === undefined) throw new BadRequestError(`${name} es obligatorio (formato YYYY-MM-DD)`);
      return fallback;
    }
    if (!isIsoDate(value)) throw new BadRequestError(`${name} debe ser una fecha YYYY-MM-DD válida`);
    return value;
  };
  const from = resolve("from", input.from, input.defaultFrom);
  const toDefault = typeof input.defaultTo === "function" ? input.defaultTo(from) : input.defaultTo;
  const to = resolve("to", input.to, toDefault);
  if (to < from) throw new BadRequestError("to debe ser igual o posterior a from");
  const days = Math.round((dayUtc(to).getTime() - dayUtc(from).getTime()) / MS_DAY) + 1;
  if (days > input.maxDays) {
    const scope = input.scope ? ` ${input.scope}` : "";
    throw new BadRequestError(`la ventana máxima${scope} es ${input.maxDays} días (pedidos ${days})`);
  }
  return { from, to, days };
}

// ---- realized (actual) per day ----------------------------------------------
export type RealizedDaySource = "snapshot" | "reservations";

export type RealizedDay = {
  date: string;
  source: RealizedDaySource;
  /** Occupied rooms as the close reports them (`totalOcc`): INCLUDES house use. */
  rooms: number;
  /** Paying rooms = rooms − houseUseRooms; the PMS's ADR base. Fallback days: = rooms. */
  paidRooms: number;
  /** House-use rooms of the close; 0 on fallback days and on rows without the column. */
  houseUseRooms: number;
  roomRevenue: number;
  /** Snapshot total revenue; on fallback days equals roomRevenue (same rule as writeDailySnapshot). */
  totalRevenue: number;
  arrivals: number;
  departures: number;
  noShows: number;
  ooo: number;
  pax: number;
  occPct: number;
  adr: number | null;
  revpar: number | null;
  /** Only audited snapshots carry GOP; null on fallback days. */
  goppar: number | null;
};

/** Aggregate label used in `sources` maps (Spanish, user-facing). */
export type RealizedSourceLabel = "snapshots" | "snapshots+reservas" | "reservas";

export type RealizedWindow = {
  /** Effective realized window (clipped to yesterday); null when the window has no past day. */
  from: string | null;
  to: string | null;
  days: Map<string, RealizedDay>;
  snapshotDays: number;
  fallbackDays: number;
  source: RealizedSourceLabel | null;
};

/** Minimal top-level snapshot row (structural: the board's select satisfies it). */
export type SnapshotRow = {
  snapshotDate: Date;
  totalOcc: number;
  arrivalRooms: number;
  departureRooms: number;
  noShowRooms: number;
  oooRooms: number;
  roomRevenue: Prisma.Decimal | number;
  adr: Prisma.Decimal | number | null;
  revpar: Prisma.Decimal | number | null;
  occupancyPercent: Prisma.Decimal | number | null;
  totalRevenue?: Prisma.Decimal | number | null;
  goppar?: Prisma.Decimal | number | null;
  /**
   * Guests in house (adults + children) as written by the close or imported
   * from the PMS report ("Adl/Chl" column). Optional so older/narrower selects
   * still satisfy the row; missing → pax 0, never a fabricated headcount.
   */
  adultsChildren?: number | null;
  /**
   * House-use rooms included in `totalOcc`. Optional for the same reason as
   * `adultsChildren`; missing → 0, so `paidRooms` falls back to `totalOcc`.
   */
  houseUseRooms?: number | null;
};

/** Minimal reservation row for the fallback (structural). */
export type RealizedReservationRow = {
  arrivalDate: Date;
  departureDate: Date;
  roomsCount: number;
  totalAmount: Prisma.Decimal | number | null;
  adults: number;
  children: number;
  status: string;
};

export const SNAPSHOT_SELECT = {
  snapshotDate: true,
  totalOcc: true,
  arrivalRooms: true,
  departureRooms: true,
  noShowRooms: true,
  oooRooms: true,
  roomRevenue: true,
  totalRevenue: true,
  adr: true,
  revpar: true,
  occupancyPercent: true,
  goppar: true,
  adultsChildren: true,
  houseUseRooms: true
} as const satisfies Prisma.RevenueDailySnapshotSelect;

export const REALIZED_RESERVATION_SELECT = {
  arrivalDate: true,
  departureDate: true,
  roomsCount: true,
  totalAmount: true,
  adults: true,
  children: true,
  status: true
} as const satisfies Prisma.ReservationSelect;

/** Top-level roll-up filter (all dimensions null) — the audited daily close. */
export const TOP_LEVEL_SNAPSHOT_WHERE = {
  roomTypeId: null,
  ratePlanId: null,
  channelId: null,
  segment: null,
  market: null
} as const;

export function realizedSourceLabel(snapshotDays: number, fallbackDays: number): RealizedSourceLabel | null {
  if (snapshotDays > 0 && fallbackDays > 0) return "snapshots+reservas";
  if (snapshotDays > 0) return "snapshots";
  if (fallbackDays > 0) return "reservas";
  return null;
}

type Acc = { rooms: number; revenue: number; arrivals: number; departures: number; noShows: number; pax: number };
function ensureAcc(map: Map<string, Acc>, key: string): Acc {
  let a = map.get(key);
  if (!a) {
    a = { rooms: 0, revenue: 0, arrivals: 0, departures: 0, noShows: 0, pax: 0 };
    map.set(key, a);
  }
  return a;
}

/**
 * Pure core: snapshot-first, reservations fallback, PAST DAYS ONLY (t < today).
 * Returns one entry per calendar day in [from, min(to, yesterday)] — a fallback
 * day with no reservations is still a (zero) reservations day, never omitted,
 * so callers can tell "closed at 0" from "outside the window".
 */
export function realizeDays(input: {
  from: Date;
  to: Date;
  today: Date;
  totalRooms: number;
  snapshots: SnapshotRow[];
  reservations: RealizedReservationRow[];
}): RealizedWindow {
  const from = dayUtc(input.from);
  const today = dayUtc(input.today);
  const yesterday = addDays(today, -1);
  const to = dayUtc(input.to).getTime() < yesterday.getTime() ? dayUtc(input.to) : yesterday;
  const days = new Map<string, RealizedDay>();
  if (from.getTime() > to.getTime()) {
    return { from: null, to: null, days, snapshotDays: 0, fallbackDays: 0, source: null };
  }
  const totalRooms = Math.max(0, input.totalRooms);

  const snapByDate = new Map<string, SnapshotRow>();
  for (const s of input.snapshots) {
    const d = dayUtc(s.snapshotDate);
    if (d.getTime() < from.getTime() || d.getTime() > to.getTime()) continue;
    snapByDate.set(isoDate(d), s);
  }

  const acc = new Map<string, Acc>();
  for (const r of input.reservations) {
    const arr = dayUtc(r.arrivalDate);
    const dep = dayUtc(r.departureDate);
    const inWindow = (d: Date) => d.getTime() >= from.getTime() && d.getTime() <= to.getTime();
    if (r.status === "no_show") {
      if (inWindow(arr)) ensureAcc(acc, isoDate(arr)).noShows += r.roomsCount;
      continue;
    }
    if (r.status !== "confirmed" && r.status !== "checked_in" && r.status !== "checked_out") continue;
    const n = Math.max(1, Math.round((dep.getTime() - arr.getTime()) / MS_DAY));
    const revPerNight = dec(r.totalAmount) / n;
    if (inWindow(arr)) ensureAcc(acc, isoDate(arr)).arrivals += r.roomsCount;
    if (inWindow(dep)) ensureAcc(acc, isoDate(dep)).departures += r.roomsCount;
    for (let i = 0; i < n; i++) {
      const d = addDays(arr, i);
      if (!inWindow(d)) continue;
      const a = ensureAcc(acc, isoDate(d));
      a.rooms += r.roomsCount;
      a.revenue += revPerNight;
      a.pax += r.adults + r.children;
    }
  }

  let snapshotDays = 0;
  let fallbackDays = 0;
  for (let t = from.getTime(); t <= to.getTime(); t += MS_DAY) {
    const key = isoDate(new Date(t));
    const snap = snapByDate.get(key);
    if (snap) {
      snapshotDays++;
      const rooms = snap.totalOcc;
      // House use is part of totalOcc (PMS and night-audit convention); the
      // paying base never goes negative even on an inconsistent close.
      const houseUseRooms = Math.max(0, snap.houseUseRooms ?? 0);
      const paidRooms = Math.max(0, rooms - houseUseRooms);
      const roomRevenue = round2(dec(snap.roomRevenue));
      const occFromSnap = decOrNull(snap.occupancyPercent);
      const adrFromSnap = decOrNull(snap.adr);
      const revparFromSnap = decOrNull(snap.revpar);
      const totalRevenue = snap.totalRevenue === undefined ? roomRevenue : round2(dec(snap.totalRevenue));
      days.set(key, {
        date: key,
        source: "snapshot",
        rooms,
        paidRooms,
        houseUseRooms,
        roomRevenue,
        totalRevenue,
        arrivals: snap.arrivalRooms,
        departures: snap.departureRooms,
        noShows: snap.noShowRooms,
        ooo: snap.oooRooms,
        // Pax comes from the close itself (night audit or PMS import); a row
        // without the column (narrow select) reports 0, same as before.
        pax: snap.adultsChildren ?? 0,
        occPct: occFromSnap !== null ? round2(occFromSnap) : totalRooms > 0 ? round2((rooms / totalRooms) * 100) : 0,
        adr: adrFromSnap !== null ? round2(adrFromSnap) : rooms > 0 ? round2(roomRevenue / rooms) : null,
        revpar: revparFromSnap !== null ? round2(revparFromSnap) : totalRooms > 0 ? round2(roomRevenue / totalRooms) : null,
        goppar: snap.goppar === undefined ? null : decOrNull(snap.goppar)
      });
    } else {
      fallbackDays++;
      const a = acc.get(key);
      const rooms = a?.rooms ?? 0;
      const roomRevenue = round2(a?.revenue ?? 0);
      days.set(key, {
        date: key,
        source: "reservations",
        rooms,
        paidRooms: rooms, // reservations carry no house-use flag: every room counts as paid
        houseUseRooms: 0,
        roomRevenue,
        totalRevenue: roomRevenue,
        arrivals: a?.arrivals ?? 0,
        departures: a?.departures ?? 0,
        noShows: a?.noShows ?? 0,
        ooo: 0,
        pax: a?.pax ?? 0,
        occPct: totalRooms > 0 ? round2((rooms / totalRooms) * 100) : 0,
        adr: rooms > 0 ? round2(roomRevenue / rooms) : null,
        revpar: totalRooms > 0 ? round2(roomRevenue / totalRooms) : null,
        goppar: null
      });
    }
  }

  return {
    from: isoDate(from),
    to: isoDate(to),
    days,
    snapshotDays,
    fallbackDays,
    source: realizedSourceLabel(snapshotDays, fallbackDays)
  };
}

/**
 * Load + realize [from, to] for a property. Exactly one query per source
 * (snapshots, reservations) plus the sellable-room count unless provided.
 * Days on/after today are never returned (the future is OTB, not realized).
 */
export async function getRealizedByDay(
  propertyId: string,
  from: Date | string,
  to: Date | string,
  opts: { today?: Date; totalRooms?: number } = {}
): Promise<RealizedWindow> {
  const today = dayUtc(opts.today);
  const yesterday = addDays(today, -1);
  const start = dayUtc(from);
  const requestedEnd = dayUtc(to);
  const end = requestedEnd.getTime() < yesterday.getTime() ? requestedEnd : yesterday;
  if (start.getTime() > end.getTime()) {
    return { from: null, to: null, days: new Map(), snapshotDays: 0, fallbackDays: 0, source: null };
  }
  const [totalRooms, snapshots, reservations] = await Promise.all([
    opts.totalRooms !== undefined
      ? Promise.resolve(opts.totalRooms)
      : prisma.room.count({ where: { propertyId, sellable: true } }),
    prisma.revenueDailySnapshot.findMany({
      where: { propertyId, ...TOP_LEVEL_SNAPSHOT_WHERE, snapshotDate: { gte: start, lte: end } },
      select: SNAPSHOT_SELECT
    }),
    prisma.reservation.findMany({
      where: {
        propertyId,
        status: { in: REALIZED_STATUS_FILTER },
        arrivalDate: { lte: end },
        departureDate: { gte: start }
      },
      select: REALIZED_RESERVATION_SELECT
    })
  ]);
  return realizeDays({ from: start, to: end, today, totalRooms, snapshots, reservations });
}

/** Sum a realized window (rooms, room revenue, days). */
export function sumRealized(win: RealizedWindow): { rooms: number; roomRevenue: number; days: number } {
  let rooms = 0;
  let roomRevenue = 0;
  for (const d of win.days.values()) {
    rooms += d.rooms;
    roomRevenue += d.roomRevenue;
  }
  return { rooms, roomRevenue: round2(roomRevenue), days: win.days.size };
}

// ---- published BAR per day ------------------------------------------------------
export type BarRatePlan = { id: string; code: string; ratePlanType: string };

/**
 * The property's BAR plan: active and (code = "BAR" case-insensitive OR
 * ratePlanType = "bar"). Code match wins over type match so a hotel that
 * names its public plan "BAR" but types it "public" (the commercial seed) and a
 * hotel that types it "bar" under another code both resolve. null → no BAR.
 */
export async function resolveBarRatePlan(propertyId: string): Promise<BarRatePlan | null> {
  const plans = await prisma.ratePlan.findMany({
    where: { propertyId, active: true, OR: [{ code: { equals: "BAR", mode: "insensitive" } }, { ratePlanType: "bar" }] },
    select: { id: true, code: true, ratePlanType: true },
    orderBy: { createdAt: "asc" },
    take: 20
  });
  if (plans.length === 0) return null;
  return plans.find((p) => p.code.toUpperCase() === "BAR") ?? plans.find((p) => p.ratePlanType === "bar") ?? plans[0];
}

export type PublishedBarSource = "rate_grid" | "no_bar_plan" | "no_sellable_room_types" | "no_rate_days";

export type PublishedBarWindow = {
  ratePlan: BarRatePlan | null;
  /** Sellable, active room types with at least one sellable room. */
  sellableRoomTypeIds: string[];
  /** date → min BAR across sellable room types (only dates with a rate). */
  byDate: Map<string, number>;
  /** `${roomTypeId}|${date}` → BAR of that type (only rows that exist). */
  byTypeDate: Map<string, number>;
  source: PublishedBarSource;
};

export function typeDateKey(roomTypeId: string, date: string): string {
  return `${roomTypeId}|${date}`;
}

/** Sellable, active room types that actually have ≥1 sellable room. */
export async function listSellableRoomTypeIds(propertyId: string): Promise<string[]> {
  const [types, groups] = await Promise.all([
    prisma.roomType.findMany({ where: { propertyId, active: true, sellable: true }, select: { id: true } }),
    prisma.room.groupBy({ by: ["roomTypeId"], where: { propertyId, sellable: true }, _count: { _all: true } })
  ]);
  const withRooms = new Set(groups.filter((g) => g._count._all > 0).map((g) => g.roomTypeId));
  return types.map((t) => t.id).filter((id) => withRooms.has(id));
}

/**
 * Published BAR per stay date in [from, to]: RateDay rows of the BAR plan for
 * sellable room types. `byDate` is the minimum across types (the lead rate the
 * recommendation engine, rate shop and displacement compare against). Dates
 * without a row are simply absent → consumers must treat them as null.
 */
export async function getPublishedBar(propertyId: string, from: Date | string, to: Date | string): Promise<PublishedBarWindow> {
  const start = dayUtc(from);
  const end = dayUtc(to);
  const ratePlan = await resolveBarRatePlan(propertyId);
  const empty = (source: PublishedBarSource, ids: string[] = []): PublishedBarWindow => ({
    ratePlan,
    sellableRoomTypeIds: ids,
    byDate: new Map(),
    byTypeDate: new Map(),
    source
  });
  if (!ratePlan) return empty("no_bar_plan");
  const sellableRoomTypeIds = await listSellableRoomTypeIds(propertyId);
  if (sellableRoomTypeIds.length === 0) return empty("no_sellable_room_types");
  if (start.getTime() > end.getTime()) return empty("no_rate_days", sellableRoomTypeIds);
  const rows = await prisma.rateDay.findMany({
    where: { propertyId, ratePlanId: ratePlan.id, roomTypeId: { in: sellableRoomTypeIds }, date: { gte: start, lte: end } },
    select: { roomTypeId: true, date: true, price: true }
  });
  const byDate = new Map<string, number>();
  const byTypeDate = new Map<string, number>();
  for (const r of rows) {
    const price = decOrNull(r.price);
    if (price === null || price <= 0) continue;
    const key = isoDate(dayUtc(r.date));
    byTypeDate.set(typeDateKey(r.roomTypeId, key), price);
    const cur = byDate.get(key);
    if (cur === undefined || price < cur) byDate.set(key, price);
  }
  return { ratePlan, sellableRoomTypeIds, byDate, byTypeDate, source: byDate.size > 0 ? "rate_grid" : "no_rate_days" };
}

/** Lead BAR for a date, or null when nothing is published (never a default). */
export function publishedBarFor(win: PublishedBarWindow, dateKey: string): number | null {
  return win.byDate.get(dateKey) ?? null;
}

/** Room types whose BAR equals the lead (minimum) BAR on a date. */
export function leadRoomTypeIdsFor(win: PublishedBarWindow, dateKey: string): string[] {
  const lead = publishedBarFor(win, dateKey);
  if (lead === null) return [];
  return win.sellableRoomTypeIds.filter((id) => win.byTypeDate.get(typeDateKey(id, dateKey)) === lead);
}

// ---- STLY snapshot ADR (honest ADR fallback for the forecast model) ------------
/**
 * Audited ADR of the same day of week last year (date−364) for each date in
 * [from, to]. Used as the ADR input when no BAR is published — the value is a
 * real close, not a constant. Dates without a snapshot are absent.
 */
export async function getStlySnapshotAdr(propertyId: string, from: Date | string, to: Date | string): Promise<Map<string, number>> {
  const start = addDays(dayUtc(from), -364);
  const end = addDays(dayUtc(to), -364);
  const out = new Map<string, number>();
  if (start.getTime() > end.getTime()) return out;
  const rows = await prisma.revenueDailySnapshot.findMany({
    where: { propertyId, ...TOP_LEVEL_SNAPSHOT_WHERE, snapshotDate: { gte: start, lte: end }, adr: { not: null } },
    select: { snapshotDate: true, adr: true }
  });
  for (const r of rows) {
    const adr = decOrNull(r.adr);
    if (adr === null || adr <= 0) continue;
    out.set(isoDate(addDays(dayUtc(r.snapshotDate), 364)), round2(adr));
  }
  return out;
}
