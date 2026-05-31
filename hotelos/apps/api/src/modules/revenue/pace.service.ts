// Revenue PACE & PICKUP — REAL, computed from the Reservation table.
//
// - OTB (on-the-books): room nights + revenue currently booked per stay date.
// - PICKUP: net new bookings created within a window (uses Reservation.createdAt).
// - PACE: current OTB vs OTB "as of" a prior capture date. The prior baseline is
//   reconstructed from createdAt (booking-creation date), so it works even before
//   any nightly snapshot has run; nightly snapshots are also persisted for exact
//   historical pace over time.
//
// Honest about being rules-based and about cancellations: the schema has no
// cancelled_at, so reconstructed historical OTB approximates by booking-creation
// date and current status. Source is always labelled "reservations".

import { prisma } from "@hotelos/database";
import type { Prisma } from "@hotelos/database";

const MS_DAY = 86_400_000;
const OTB_STATUSES = ["confirmed", "checked_in", "checked_out"] as const;

function dayUtc(value?: string | Date): Date {
  if (value instanceof Date) {
    return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
  }
  const base = value && /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : new Date().toISOString().slice(0, 10);
  return new Date(`${base}T00:00:00.000Z`);
}
function addDays(d: Date, n: number): Date {
  return new Date(d.getTime() + n * MS_DAY);
}
function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}
function nights(arrival: Date, departure: Date): number {
  return Math.max(1, Math.round((departure.getTime() - arrival.getTime()) / MS_DAY));
}
function dec(v: Prisma.Decimal | number | null | undefined): number {
  return v === null || v === undefined ? 0 : typeof v === "number" ? v : Number(v);
}
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

type ResRow = { arrivalDate: Date; departureDate: Date; roomsCount: number; totalAmount: Prisma.Decimal; createdAt: Date };

type Bucket = { rooms: number; revenue: number; reservations: number };

/** Expand reservations into per-stay-date OTB (rooms + revenue) clipped to [from, to). */
function expand(rows: ResRow[], from: Date, to: Date): Map<string, Bucket> {
  const byDate = new Map<string, Bucket>();
  for (const r of rows) {
    const arr = dayUtc(r.arrivalDate);
    const dep = dayUtc(r.departureDate);
    const n = nights(arr, dep);
    const revPerNight = dec(r.totalAmount) / n;
    for (let i = 0; i < n; i++) {
      const d = addDays(arr, i);
      if (d.getTime() < from.getTime() || d.getTime() >= to.getTime()) continue;
      const key = isoDate(d);
      const b = byDate.get(key) ?? { rooms: 0, revenue: 0, reservations: 0 };
      b.rooms += r.roomsCount;
      b.revenue += revPerNight;
      b.reservations += 1;
      byDate.set(key, b);
    }
  }
  return byDate;
}

function sumWindow(byDate: Map<string, Bucket>, from: Date, to: Date): Bucket {
  let rooms = 0;
  let revenue = 0;
  let reservations = 0;
  for (const [key, b] of byDate) {
    const t = dayUtc(key).getTime();
    if (t >= from.getTime() && t < to.getTime()) {
      rooms += b.rooms;
      revenue += b.revenue;
      reservations += b.reservations;
    }
  }
  return { rooms, revenue: round2(revenue), reservations };
}

async function loadFutureOtbReservations(propertyId: string, today: Date, horizonEnd: Date): Promise<ResRow[]> {
  return prisma.reservation.findMany({
    where: {
      propertyId,
      status: { in: OTB_STATUSES as unknown as Prisma.EnumReservationStatusFilter["in"] },
      departureDate: { gt: today },
      arrivalDate: { lt: horizonEnd }
    },
    select: { arrivalDate: true, departureDate: true, roomsCount: true, totalAmount: true, createdAt: true }
  });
}

/** PACE: current OTB by horizon vs OTB reconstructed "as of" 7 days ago. */
export async function getPace(propertyId: string) {
  const today = dayUtc();
  const horizonEnd = addDays(today, 365);
  const priorAsOf = addDays(today, -7);
  const priorCutoff = addDays(priorAsOf, 1); // bookings created strictly before end of that day

  const reservations = await loadFutureOtbReservations(propertyId, today, horizonEnd);
  const current = expand(reservations, today, horizonEnd);
  const prior = expand(
    reservations.filter((r) => r.createdAt.getTime() < priorCutoff.getTime()),
    today,
    horizonEnd
  );

  const horizons = [7, 30, 90].map((h) => {
    const end = addDays(today, h);
    const cur = sumWindow(current, today, end);
    const pri = sumWindow(prior, today, end);
    return {
      horizonDays: h,
      otbRooms: cur.rooms,
      otbRevenue: cur.revenue,
      priorOtbRooms: pri.rooms,
      priorOtbRevenue: pri.revenue,
      paceRooms: cur.rooms - pri.rooms,
      paceRevenue: round2(cur.revenue - pri.revenue)
    };
  });

  return {
    propertyId,
    asOf: isoDate(today),
    comparison: { label: "vs. hace 7 días", priorAsOf: isoDate(priorAsOf) },
    horizons,
    source: "reservations" as const
  };
}

/** PICKUP: net new bookings created within rolling windows, affecting future stays. */
export async function getPickup(propertyId: string) {
  const today = dayUtc();
  const horizonEnd = addDays(today, 365);
  const maxWindow = 30;
  const since = addDays(today, -maxWindow);

  const rows = await prisma.reservation.findMany({
    where: {
      propertyId,
      status: { in: OTB_STATUSES as unknown as Prisma.EnumReservationStatusFilter["in"] },
      departureDate: { gt: today },
      arrivalDate: { lt: horizonEnd },
      createdAt: { gte: since }
    },
    select: { arrivalDate: true, departureDate: true, roomsCount: true, totalAmount: true, createdAt: true }
  });

  const windows = [1, 7, 14, 30].map((w) => {
    const cutoff = addDays(today, -w);
    const inWindow = rows.filter((r) => r.createdAt.getTime() >= cutoff.getTime());
    let roomNights = 0;
    let revenue = 0;
    for (const r of inWindow) {
      roomNights += r.roomsCount * nights(dayUtc(r.arrivalDate), dayUtc(r.departureDate));
      revenue += dec(r.totalAmount);
    }
    return { windowDays: w, reservations: inWindow.length, roomNights, revenue: round2(revenue) };
  });

  return { propertyId, asOf: isoDate(today), windows, source: "reservations" as const };
}

/**
 * Persist a nightly OTB snapshot per stay date for the next 365 days.
 * Idempotent for a given (property, captureDate). Called by the scheduler and
 * exposed as a manual action for demos.
 */
export async function capturePaceSnapshot(propertyId: string, captureDateIso?: string) {
  const captureDate = dayUtc(captureDateIso);
  const horizonEnd = addDays(captureDate, 365);
  const reservations = await loadFutureOtbReservations(propertyId, captureDate, horizonEnd);
  const byDate = expand(reservations, captureDate, horizonEnd);

  const data: Prisma.RevenuePaceSnapshotCreateManyInput[] = [];
  for (const [key, b] of byDate) {
    data.push({
      propertyId,
      captureDate,
      stayDate: dayUtc(key),
      roomsOtb: b.rooms,
      revenueOtb: round2(b.revenue),
      reservations: b.reservations
    });
  }

  const captured = await prisma.$transaction(async (tx) => {
    await tx.revenuePaceSnapshot.deleteMany({ where: { propertyId, captureDate } });
    if (data.length === 0) return 0;
    const created = await tx.revenuePaceSnapshot.createMany({ data });
    return created.count;
  });

  return { propertyId, captureDate: isoDate(captureDate), captured };
}

/** Capture nightly snapshots for every active property (scheduler entry point). */
export async function capturePaceSnapshotsForAllProperties(): Promise<{ properties: number; captured: number }> {
  const properties = await prisma.property.findMany({ select: { id: true } });
  let captured = 0;
  for (const p of properties) {
    try {
      const r = await capturePaceSnapshot(p.id);
      captured += r.captured;
    } catch {
      // continue with the next property
    }
  }
  return { properties: properties.length, captured };
}
