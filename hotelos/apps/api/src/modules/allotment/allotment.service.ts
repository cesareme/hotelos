// Allotment + TourOperator — contracted room blocks for B2B partners
// (Hotelbeds, TUI, FTI, Iberostar B2B…). Critical for the Spanish/European
// market where 30-60% of inventory is routinely sold via TT.OO.
//
// Engine pieces:
//  - TourOperator CRUD (organization-level)
//  - Allotment CRUD (property × roomType × period) with auto-generated
//    AllotmentDay rows for each day in the validity window
//  - getRemainingForDay/Range — how many rooms still in the cuota
//  - consumeAllotment — increment pickedUp when a B2B reservation books
//  - releaseExpired — return unused cuota to general pool when releaseDays
//    window expires (job; safe to call repeatedly)
import { prisma } from "@hotelos/database";
import { NotFoundError, BadRequestError } from "../../lib/http-error.js";
import type { UserContext } from "../../lib/demo-store.js";

const MS_DAY = 86_400_000;
function asDate(v: string | Date): Date { const d = new Date(v); d.setUTCHours(0, 0, 0, 0); return d; }
function daysBetween(a: Date, b: Date): number { return Math.round((b.getTime() - a.getTime()) / MS_DAY); }

// --- Tour operators ---------------------------------------------------------

export async function listTourOperators(organizationId: string) {
  return prisma.tourOperator.findMany({ where: { organizationId }, orderBy: [{ active: "desc" }, { code: "asc" }] });
}

export async function getTourOperator(id: string) {
  const t = await prisma.tourOperator.findUnique({ where: { id } });
  if (!t) throw new NotFoundError("Tour operator no encontrado.");
  return t;
}

export async function createTourOperator(input: {
  context: UserContext;
  organizationId: string;
  payload: { code: string; name: string; taxId?: string; contactEmail?: string; contactPhone?: string; defaultCommissionPct?: number; paymentTermsDays?: number; currency?: string; notes?: string; active?: boolean };
}) {
  const p = input.payload;
  if (!p.code?.trim() || !p.name?.trim()) throw new BadRequestError("code y name son obligatorios.");
  return prisma.tourOperator.create({
    data: {
      organizationId: input.organizationId,
      code: p.code.trim(),
      name: p.name.trim(),
      taxId: p.taxId ?? null,
      contactEmail: p.contactEmail ?? null,
      contactPhone: p.contactPhone ?? null,
      defaultCommissionPct: p.defaultCommissionPct ?? null,
      paymentTermsDays: p.paymentTermsDays ?? 30,
      currency: p.currency ?? "EUR",
      notes: p.notes ?? null,
      active: p.active ?? true
    }
  });
}

export async function updateTourOperator(input: { context: UserContext; id: string; payload: Record<string, unknown> }) {
  const p = input.payload;
  const data: Record<string, unknown> = {};
  for (const k of ["name", "taxId", "contactEmail", "contactPhone", "defaultCommissionPct", "paymentTermsDays", "currency", "notes", "active"]) {
    if (p[k] !== undefined) data[k] = p[k];
  }
  const existing = await prisma.tourOperator.findUnique({ where: { id: input.id } });
  if (!existing) throw new NotFoundError("Tour operator no encontrado.");
  return prisma.tourOperator.update({ where: { id: input.id }, data });
}

// --- Allotments -------------------------------------------------------------

export async function listAllotments(propertyId: string) {
  return prisma.allotment.findMany({ where: { propertyId }, orderBy: [{ status: "asc" }, { validFrom: "asc" }] });
}

export async function getAllotment(id: string) {
  const a = await prisma.allotment.findUnique({ where: { id } });
  if (!a) throw new NotFoundError("Cupo no encontrado.");
  const days = await prisma.allotmentDay.findMany({ where: { allotmentId: id }, orderBy: { date: "asc" } });
  return { ...a, days };
}

export async function createAllotment(input: {
  context: UserContext;
  propertyId: string;
  payload: {
    code: string; name: string;
    tourOperatorId?: string; channelId?: string;
    roomTypeId: string; ratePlanId?: string;
    validFrom: string; validTo: string;
    totalRooms: number; releaseDays?: number;
    contractedRate?: number; currency?: string;
    status?: string; notes?: string;
    // Industria · campos B2B estándar (research-backed)
    allotmentType?: "soft" | "hard" | "free_sale";
    counterpartyType?: "tour_operator" | "bedbank" | "corporate" | "ota";
    rateType?: "net" | "commissionable";
    commissionPct?: number;
    stopSell?: boolean;
  };
}) {
  const p = input.payload;
  if (!p.code?.trim() || !p.name?.trim()) throw new BadRequestError("code y name son obligatorios.");
  if (!p.roomTypeId) throw new BadRequestError("roomTypeId es obligatorio.");
  if (!p.validFrom || !p.validTo) throw new BadRequestError("validFrom y validTo son obligatorios.");
  if (!p.totalRooms || p.totalRooms <= 0) throw new BadRequestError("totalRooms debe ser > 0.");

  const from = asDate(p.validFrom);
  const to = asDate(p.validTo);
  if (to <= from) throw new BadRequestError("validTo debe ser posterior a validFrom.");
  const span = daysBetween(from, to);
  if (span > 730) throw new BadRequestError("El periodo del cupo no puede superar 2 años.");

  // Validación de coherencia tarifa ↔ tipo
  if (p.rateType === "commissionable") {
    if (p.commissionPct == null || p.commissionPct < 0 || p.commissionPct > 100) {
      throw new BadRequestError("Para tarifa comisionable, commissionPct debe estar entre 0 y 100.");
    }
  }
  // free_sale no necesita totalRooms estricto pero lo mantenemos por consistencia.

  const allotment = await prisma.allotment.create({
    data: {
      propertyId: input.propertyId,
      tourOperatorId: p.tourOperatorId ?? null,
      channelId: p.channelId ?? null,
      code: p.code.trim(),
      name: p.name.trim(),
      roomTypeId: p.roomTypeId,
      ratePlanId: p.ratePlanId ?? null,
      validFrom: from,
      validTo: to,
      totalRooms: p.totalRooms,
      releaseDays: p.releaseDays ?? 14,
      contractedRate: p.contractedRate ?? null,
      currency: p.currency ?? "EUR",
      status: p.status ?? "active",
      allotmentType: p.allotmentType ?? "soft",
      counterpartyType: p.counterpartyType ?? "tour_operator",
      rateType: p.rateType ?? "net",
      commissionPct: p.rateType === "commissionable" ? p.commissionPct ?? null : null,
      stopSell: p.stopSell ?? false,
      notes: p.notes ?? null
    }
  });

  // Materialise an AllotmentDay row per day in the window with the full
  // blocked-rooms cuota. Operators can later edit individual days for special
  // patterns (peak nights, low-demand days).
  const dayRows: { allotmentId: string; date: Date; blockedRooms: number }[] = [];
  for (let i = 0; i < span; i += 1) {
    const date = new Date(from.getTime() + i * MS_DAY);
    dayRows.push({ allotmentId: allotment.id, date, blockedRooms: p.totalRooms });
  }
  if (dayRows.length > 0) await prisma.allotmentDay.createMany({ data: dayRows });

  return { ...allotment, daysCreated: dayRows.length };
}

export async function updateAllotment(input: { context: UserContext; id: string; payload: Record<string, unknown> }) {
  const p = input.payload;
  const data: Record<string, unknown> = {};
  for (const k of ["name", "tourOperatorId", "channelId", "ratePlanId", "totalRooms", "releaseDays", "contractedRate", "currency", "status", "notes"]) {
    if (p[k] !== undefined) data[k] = p[k];
  }
  const existing = await prisma.allotment.findUnique({ where: { id: input.id } });
  if (!existing) throw new NotFoundError("Cupo no encontrado.");
  return prisma.allotment.update({ where: { id: input.id }, data });
}

export async function deleteAllotment(id: string) {
  const existing = await prisma.allotment.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError("Cupo no encontrado.");
  // Cascade clean days first (no FK relation defined, do it explicitly).
  await prisma.allotmentDay.deleteMany({ where: { allotmentId: id } });
  await prisma.allotment.delete({ where: { id } });
  return { ok: true, id };
}

// --- Engine: availability + consumption + release ---------------------------

export type AllotmentRemaining = {
  date: string;
  blocked: number;
  pickedUp: number;
  released: number;
  remaining: number;
};

export async function getRemainingForRange(allotmentId: string, from: string, to: string): Promise<AllotmentRemaining[]> {
  const days = await prisma.allotmentDay.findMany({
    where: { allotmentId, date: { gte: asDate(from), lte: asDate(to) } },
    orderBy: { date: "asc" }
  });
  return days.map((d) => ({
    date: d.date.toISOString().slice(0, 10),
    blocked: d.blockedRooms,
    pickedUp: d.pickedUpRooms,
    released: d.releasedRooms,
    remaining: Math.max(0, d.blockedRooms - d.pickedUpRooms - d.releasedRooms)
  }));
}

export async function getRemainingForDay(propertyId: string, roomTypeId: string, date: string): Promise<{ totalRemaining: number; byAllotment: Array<{ allotmentId: string; allotmentCode: string; remaining: number }> }> {
  const d = asDate(date);
  const allotments = await prisma.allotment.findMany({
    where: {
      propertyId, roomTypeId, status: "active",
      validFrom: { lte: d }, validTo: { gt: d }
    },
    select: { id: true, code: true }
  });
  let total = 0;
  const breakdown: Array<{ allotmentId: string; allotmentCode: string; remaining: number }> = [];
  for (const a of allotments) {
    const day = await prisma.allotmentDay.findUnique({ where: { allotmentId_date: { allotmentId: a.id, date: d } } });
    const remaining = day ? Math.max(0, day.blockedRooms - day.pickedUpRooms - day.releasedRooms) : 0;
    total += remaining;
    breakdown.push({ allotmentId: a.id, allotmentCode: a.code, remaining });
  }
  return { totalRemaining: total, byAllotment: breakdown };
}

export async function consumeAllotment(input: { allotmentId: string; date: string; quantity: number }) {
  const d = asDate(input.date);
  const day = await prisma.allotmentDay.findUnique({ where: { allotmentId_date: { allotmentId: input.allotmentId, date: d } } });
  if (!day) throw new NotFoundError("AllotmentDay no encontrado.");
  const remaining = day.blockedRooms - day.pickedUpRooms - day.releasedRooms;
  if (input.quantity > remaining) throw new BadRequestError(`Cupo insuficiente: quedan ${remaining}.`);
  return prisma.allotmentDay.update({
    where: { allotmentId_date: { allotmentId: input.allotmentId, date: d } },
    data: { pickedUpRooms: { increment: input.quantity } }
  });
}

// getPickupSummary: dashboard data for the AllotmentsScreen — aggregates the
// pickup vs. release vs. remaining for the next N days, grouped by allotment.
// Also identifies which allotment-days will trigger release in the next 7 days
// so the UI can show "Próximas liberaciones" before they happen.
export type PickupSummaryDay = {
  date: string;
  blocked: number;
  pickedUp: number;
  released: number;
  remaining: number;
  pickupPct: number; // 0-100
};
export type PickupSummaryAllotment = {
  allotmentId: string;
  code: string;
  name: string;
  releaseDays: number;
  totalRooms: number;
  validFrom: string;
  validTo: string;
  // Aggregates for the requested window
  totalBlocked: number;
  totalPickedUp: number;
  totalReleased: number;
  totalRemaining: number;
  pickupPct: number;
  daysToNextRelease: number | null; // null si ya está fuera de la ventana
  nextReleaseDate: string | null;
  upcomingReleaseRooms: number; // habs que se liberarán en los próximos releaseDays días si no se venden
  days: PickupSummaryDay[];
};

export async function getPickupSummary(input: {
  propertyId: string;
  fromDate?: string;
  windowDays?: number;
}): Promise<{ generatedAt: string; window: { from: string; to: string }; allotments: PickupSummaryAllotment[] }> {
  const from = input.fromDate ? asDate(input.fromDate) : asDate(new Date().toISOString());
  const windowDays = Math.min(Math.max(input.windowDays ?? 60, 1), 365);
  const to = new Date(from.getTime() + windowDays * MS_DAY);

  const allotments = await prisma.allotment.findMany({
    where: {
      propertyId: input.propertyId,
      status: "active",
      // El allotment intersecta con la ventana solicitada
      validFrom: { lt: to },
      validTo: { gt: from }
    },
    orderBy: { validFrom: "asc" }
  });

  const result: PickupSummaryAllotment[] = [];
  for (const a of allotments) {
    const days = await prisma.allotmentDay.findMany({
      where: {
        allotmentId: a.id,
        date: { gte: from, lt: to }
      },
      orderBy: { date: "asc" }
    });

    const daySummaries: PickupSummaryDay[] = days.map((d) => {
      const remaining = Math.max(0, d.blockedRooms - d.pickedUpRooms - d.releasedRooms);
      const pickupPct = d.blockedRooms > 0 ? Math.round((d.pickedUpRooms * 100) / d.blockedRooms) : 0;
      return {
        date: d.date.toISOString().slice(0, 10),
        blocked: d.blockedRooms,
        pickedUp: d.pickedUpRooms,
        released: d.releasedRooms,
        remaining,
        pickupPct
      };
    });

    const totalBlocked = daySummaries.reduce((s, x) => s + x.blocked, 0);
    const totalPickedUp = daySummaries.reduce((s, x) => s + x.pickedUp, 0);
    const totalReleased = daySummaries.reduce((s, x) => s + x.released, 0);
    const totalRemaining = daySummaries.reduce((s, x) => s + x.remaining, 0);
    const pickupPct = totalBlocked > 0 ? Math.round((totalPickedUp * 100) / totalBlocked) : 0;

    // Próximo release: dada la regla `release_date = check_in - releaseDays`,
    // las habs reservables HOY son las que tienen `date >= from + releaseDays`.
    // El "next release" será para el día `from + releaseDays` si aún no liberó.
    const nextReleaseDate = new Date(from.getTime() + a.releaseDays * MS_DAY);
    const daysToNextRelease = a.releaseDays;
    // Habs que se liberarán si no se venden: suma de remaining en los próximos releaseDays días.
    const upcomingReleaseRooms = daySummaries
      .filter((d) => new Date(d.date) <= nextReleaseDate)
      .reduce((s, d) => s + d.remaining, 0);

    result.push({
      allotmentId: a.id,
      code: a.code,
      name: a.name,
      releaseDays: a.releaseDays,
      totalRooms: a.totalRooms,
      validFrom: a.validFrom.toISOString().slice(0, 10),
      validTo: a.validTo.toISOString().slice(0, 10),
      totalBlocked,
      totalPickedUp,
      totalReleased,
      totalRemaining,
      pickupPct,
      daysToNextRelease,
      nextReleaseDate: nextReleaseDate.toISOString().slice(0, 10),
      upcomingReleaseRooms,
      days: daySummaries
    });
  }

  return {
    generatedAt: new Date().toISOString(),
    window: { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) },
    allotments: result
  };
}

// releaseExpired: for every active allotment whose release window has been
// crossed (date - now <= releaseDays) and that still has un-picked rooms,
// move the un-picked rooms to releasedRooms so general availability can sell
// them. Safe to run daily (it's idempotent: only days where releasedRooms = 0
// and the threshold has been crossed are updated).
export async function releaseExpired(input: { propertyId: string; asOfDate?: string }) {
  const now = input.asOfDate ? asDate(input.asOfDate) : asDate(new Date().toISOString());
  const allotments = await prisma.allotment.findMany({ where: { propertyId: input.propertyId, status: "active" } });
  let releasedDays = 0;
  let releasedRooms = 0;
  for (const a of allotments) {
    const threshold = new Date(now.getTime() + a.releaseDays * MS_DAY);
    const days = await prisma.allotmentDay.findMany({
      where: {
        allotmentId: a.id,
        date: { gte: now, lte: threshold },
        releasedRooms: 0
      }
    });
    for (const d of days) {
      const remaining = d.blockedRooms - d.pickedUpRooms;
      if (remaining > 0) {
        await prisma.allotmentDay.update({
          where: { allotmentId_date: { allotmentId: a.id, date: d.date } },
          data: { releasedRooms: remaining }
        });
        releasedDays += 1;
        releasedRooms += remaining;
      }
    }
  }
  return { releasedDays, releasedRooms };
}
