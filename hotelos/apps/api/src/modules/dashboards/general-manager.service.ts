// General Manager dashboard — vista estratégica del director del hotel.
//
// Directriz HotelOS (Nov 2026):
//   "Gerencia: ocupación, ADR, RevPAR, caja, reputación, incidencias, productividad."
//
// Es distinto del FrontDeskCockpit (operación inmediata) y del ShiftManager
// (supervisión del turno): aquí mostramos KPIs estratégicos del período.
//
// Devuelve:
//   - KPIs día actual + comparativa vs ayer + MTD
//   - Producción del mes (revenue, room nights, ADR, RevPAR)
//   - Mix por canal y segmento (top 5)
//   - Estado de incidencias y compliance
//   - Productividad operativa (% check-ins/outs ejecutados)
//   - Reputación (reviews recientes si existen)

import { prisma } from "@hotelos/database";

export type GmKpiCompare = {
  value: number;
  vsYesterday?: { value: number; pct: number };
  vsLastWeek?: { value: number; pct: number };
};

export type GmDashboard = {
  generatedAt: string;
  propertyId: string;
  propertyName?: string;
  asOf: string;             // ISO date

  occupancy: { today: GmKpiCompare; mtd: number; ytdRoomNightsSold: number };
  adr: { today: GmKpiCompare; mtd: number };
  revpar: { today: GmKpiCompare; mtd: number };
  revenue: { today: GmKpiCompare; mtd: number; mtdByType: Array<{ type: string; total: number }> };

  // GOPPAR-style operating KPIs for today (rules-based, computed from
  // FolioLine revenue, CommissionAccrual + ChannelProfitabilitySnapshot for
  // channel cost, and TimeClockEntry × StaffProfile.hourlyCost for labor).
  goppar: number;                   // (revenue - channelCost - laborCost) / availableRooms
  totalLaborCostToday: number;
  channelCostPct: number;           // commissions / revenue (today), 0..100
  netContributionToday: number;     // revenue - channelCost - laborCost

  productivity: {
    checkInsDone: number;
    checkInsPlanned: number;
    checkOutsDone: number;
    checkOutsPlanned: number;
    noShowsToday: number;
    cancellationsToday: number;
  };

  channelMix: Array<{ channel: string; reservations: number; revenue: number; pct: number }>;
  // segmentMix now exposes ADR per segment alongside reservations and revenue.
  segmentMix: Array<{ segment: string; reservations: number; revenue: number; pct: number; adr: number }>;

  // Top 3 BAR recommendations (best-effort: pulls active BAR levels for the
  // property; we surface the ones that are most relevant to apply next).
  barRecommendations: Array<{ name: string; price: number; sortOrder: number }>;

  // VIPs currently in-house (status checked_in).
  vipsInHouse: number;

  // Compliance summary across the three Spanish authority lanes.
  complianceSummary: {
    verifactu: { pending: number; last?: string };
    ses: { pending: number };
    tbai: { pending: number; errors: number };
  };

  // Simple rules-based anomaly detectors. No ML — just thresholded deltas.
  aiAnomalies: Array<{ kind: string; severity: "low" | "medium" | "high"; message: string }>;

  // % de reservas próximas marcadas at-risk: no_show histórico del booker,
  // ETA pasada, balance pendiente alto. Sin AI todavía, sólo heurística.
  cancellationRiskScore: number;

  alerts: {
    overbookings: number;
    emergencyIncidents: number;
    openIncidents: number;
    blockedRooms: number;
    foliosWithOpenBalance: number;
    foliosOpenBalanceEur: number;
    complianceFailing: number;
  };

  cash: {
    capturedTodayEur: number;
    refundedTodayEur: number;
    netTodayEur: number;
    openBalanceEur: number;
  };

  reputation?: {
    avgScore?: number;
    reviewsLast30: number;
    npsLast30?: number;
  };
};

// Pace endpoint: one row per stay date with on-the-books, expected
// (forecast) and last-year comparison. Uses RevenueDailySnapshot for
// LY (real historic) and RevenueForecastSnapshot for the forecast.
export type GmPaceRow = {
  date: string;          // YYYY-MM-DD
  otb: number;           // current on-the-books revenue (eur)
  forecast: number;      // expected revenue per current forecast
  lastYear: number;      // same date one year ago — real revenue
};

export type GmPaceResponse = {
  generatedAt: string;
  propertyId: string;
  from: string;
  to: string;
  days: number;
  rows: GmPaceRow[];
};

// Status values considered "still open" for fiscal queues (matches
// portfolio + property-overview services for consistency).
const FISCAL_PENDING_STATUSES = ["pending", "queued", "sent", "submitting", "retrying", "failed", "rejected"];
const SES_PENDING_STATUSES = ["queued", "sent", "rejected", "failed"];

function startOfDayUtc(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function startOfMonthUtc(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

function pctDelta(curr: number, prev: number): number {
  if (prev === 0) return curr > 0 ? 100 : 0;
  return Math.round(((curr - prev) / prev) * 1000) / 10;
}

async function revenueInWindow(propertyId: string, from: Date, to: Date): Promise<{ total: number; byType: Map<string, number> }> {
  const lines = await prisma.folioLine.findMany({
    where: {
      folio: { reservation: { propertyId } },
      postedAt: { gte: from, lt: to }
    },
    select: { type: true, total: true }
  });
  const byType = new Map<string, number>();
  let total = 0;
  for (const l of lines) {
    const t = Number(l.total);
    total += t;
    byType.set(l.type, (byType.get(l.type) ?? 0) + t);
  }
  return { total: Math.round(total * 100) / 100, byType };
}

async function roomNightsInWindow(propertyId: string, from: Date, to: Date): Promise<number> {
  // Para una ventana [from, to), suma noches de reserva confirmed/checked_in/checked_out
  // cuyo período se solapa.
  const res = await prisma.reservation.findMany({
    where: {
      propertyId,
      status: { in: ["confirmed", "checked_in", "checked_out"] },
      arrivalDate: { lt: to },
      departureDate: { gt: from }
    },
    select: { arrivalDate: true, departureDate: true, roomsCount: true }
  });
  let nights = 0;
  for (const r of res) {
    const a = r.arrivalDate.getTime();
    const d = r.departureDate.getTime();
    const overlapStart = Math.max(a, from.getTime());
    const overlapEnd = Math.min(d, to.getTime());
    const days = Math.max(0, Math.round((overlapEnd - overlapStart) / 86400000));
    nights += days * Math.max(1, r.roomsCount ?? 1);
  }
  return nights;
}

export async function buildGmDashboard(input: { propertyId: string; asOf?: Date }): Promise<GmDashboard> {
  const propertyId = input.propertyId;
  const now = input.asOf ?? new Date();
  const today = startOfDayUtc(now);
  const tomorrow = new Date(today.getTime() + 86400000);
  const yesterday = new Date(today.getTime() - 86400000);
  const lastWeek = new Date(today.getTime() - 7 * 86400000);
  const monthStart = startOfMonthUtc(now);
  const yearStart = new Date(Date.UTC(now.getUTCFullYear(), 0, 1));

  const [property, totalRoomsCount] = await Promise.all([
    prisma.property.findUnique({ where: { id: propertyId }, select: { name: true } }),
    prisma.room.count({ where: { propertyId, active: true, sellable: true } })
  ]);

  // --- Productivity & dailies
  const [
    checkInsRows,
    checkOutsRows,
    plannedArrivals,
    plannedDepartures,
    noShowsToday,
    cancellationsToday
  ] = await Promise.all([
    prisma.stay.count({
      where: { reservation: { propertyId }, checkinAt: { gte: today, lt: tomorrow } }
    }),
    prisma.stay.count({
      where: { reservation: { propertyId }, checkoutAt: { gte: today, lt: tomorrow } }
    }),
    prisma.reservation.count({
      where: { propertyId, arrivalDate: { gte: today, lt: tomorrow }, status: { in: ["confirmed", "checked_in", "checked_out"] } }
    }),
    prisma.reservation.count({
      where: { propertyId, departureDate: { gte: today, lt: tomorrow }, status: { in: ["checked_in", "checked_out"] } }
    }),
    prisma.reservation.count({
      where: { propertyId, status: "no_show", arrivalDate: { gte: today, lt: tomorrow } }
    }),
    prisma.reservation.count({
      where: { propertyId, status: "cancelled", arrivalDate: { gte: today, lt: tomorrow } }
    })
  ]);

  // --- Occupancy / ADR / RevPAR — today vs yesterday vs last week
  const [revToday, revYesterday, revLastWeek, revMtd] = await Promise.all([
    revenueInWindow(propertyId, today, tomorrow),
    revenueInWindow(propertyId, yesterday, today),
    revenueInWindow(propertyId, lastWeek, new Date(lastWeek.getTime() + 86400000)),
    revenueInWindow(propertyId, monthStart, tomorrow)
  ]);
  const [nightsToday, nightsYesterday, nightsLastWeek, nightsMtd, nightsYtd] = await Promise.all([
    roomNightsInWindow(propertyId, today, tomorrow),
    roomNightsInWindow(propertyId, yesterday, today),
    roomNightsInWindow(propertyId, lastWeek, new Date(lastWeek.getTime() + 86400000)),
    roomNightsInWindow(propertyId, monthStart, tomorrow),
    roomNightsInWindow(propertyId, yearStart, tomorrow)
  ]);

  const occToday = totalRoomsCount > 0 ? Math.round((nightsToday / totalRoomsCount) * 1000) / 10 : 0;
  const occYest = totalRoomsCount > 0 ? Math.round((nightsYesterday / totalRoomsCount) * 1000) / 10 : 0;
  const occLastWeek = totalRoomsCount > 0 ? Math.round((nightsLastWeek / totalRoomsCount) * 1000) / 10 : 0;
  const daysInMonthSoFar = Math.max(1, Math.round((tomorrow.getTime() - monthStart.getTime()) / 86400000));
  const occMtd = totalRoomsCount > 0
    ? Math.round((nightsMtd / (totalRoomsCount * daysInMonthSoFar)) * 1000) / 10
    : 0;

  const adrToday = nightsToday > 0 ? Math.round((revToday.total / nightsToday) * 100) / 100 : 0;
  const adrYest = nightsYesterday > 0 ? Math.round((revYesterday.total / nightsYesterday) * 100) / 100 : 0;
  const adrLastWeek = nightsLastWeek > 0 ? Math.round((revLastWeek.total / nightsLastWeek) * 100) / 100 : 0;
  const adrMtd = nightsMtd > 0 ? Math.round((revMtd.total / nightsMtd) * 100) / 100 : 0;

  const revparToday = totalRoomsCount > 0 ? Math.round((revToday.total / totalRoomsCount) * 100) / 100 : 0;
  const revparYest = totalRoomsCount > 0 ? Math.round((revYesterday.total / totalRoomsCount) * 100) / 100 : 0;
  const revparLastWeek = totalRoomsCount > 0 ? Math.round((revLastWeek.total / totalRoomsCount) * 100) / 100 : 0;
  const revparMtd = totalRoomsCount > 0 && daysInMonthSoFar > 0
    ? Math.round((revMtd.total / (totalRoomsCount * daysInMonthSoFar)) * 100) / 100
    : 0;

  // --- Channel / segment mix (MTD)
  const reservationsMtd = await prisma.reservation.findMany({
    where: {
      propertyId,
      arrivalDate: { gte: monthStart, lt: tomorrow },
      status: { in: ["confirmed", "checked_in", "checked_out"] }
    },
    select: { channel: true, marketSegment: true, totalAmount: true, arrivalDate: true, departureDate: true, roomsCount: true }
  });
  const chanMap = new Map<string, { count: number; revenue: number; nights: number }>();
  const segMap = new Map<string, { count: number; revenue: number; nights: number }>();
  let totalRevenueMtd = 0;
  for (const r of reservationsMtd) {
    const t = Number(r.totalAmount);
    totalRevenueMtd += t;
    const a = r.arrivalDate.getTime();
    const d = r.departureDate.getTime();
    const stayNights = Math.max(1, Math.round((d - a) / 86400000)) * Math.max(1, r.roomsCount ?? 1);
    const c = r.channel ?? "direct";
    const prevC = chanMap.get(c);
    chanMap.set(c, {
      count: (prevC?.count ?? 0) + 1,
      revenue: (prevC?.revenue ?? 0) + t,
      nights: (prevC?.nights ?? 0) + stayNights
    });
    const s = r.marketSegment ?? "transient";
    const prevS = segMap.get(s);
    segMap.set(s, {
      count: (prevS?.count ?? 0) + 1,
      revenue: (prevS?.revenue ?? 0) + t,
      nights: (prevS?.nights ?? 0) + stayNights
    });
  }
  function toMix(m: Map<string, { count: number; revenue: number; nights: number }>) {
    const arr = Array.from(m.entries()).map(([k, v]) => ({
      key: k,
      reservations: v.count,
      revenue: Math.round(v.revenue * 100) / 100,
      pct: totalRevenueMtd > 0 ? Math.round((v.revenue / totalRevenueMtd) * 1000) / 10 : 0,
      adr: v.nights > 0 ? Math.round((v.revenue / v.nights) * 100) / 100 : 0
    }));
    arr.sort((a, b) => b.revenue - a.revenue);
    return arr.slice(0, 6);
  }
  const channelMix = toMix(chanMap).map((x) => ({ channel: x.key, reservations: x.reservations, revenue: x.revenue, pct: x.pct }));
  const segmentMix = toMix(segMap).map((x) => ({ segment: x.key, reservations: x.reservations, revenue: x.revenue, pct: x.pct, adr: x.adr }));

  // --- Alerts
  const [emergencyIncidents, openIncidents, blockedRooms, openFolios, capturedTodayAgg, refundedTodayAgg] = await Promise.all([
    prisma.workOrder.count({ where: { propertyId, status: { in: ["open", "in_progress"] }, priority: "emergency" } }).catch(() => 0),
    prisma.workOrder.count({ where: { propertyId, status: { in: ["open", "in_progress"] } } }).catch(() => 0),
    prisma.room.count({ where: { propertyId, sellable: false, active: true } }),
    prisma.folio.findMany({
      where: { reservation: { propertyId }, status: "open" },
      include: { lines: true, payments: { where: { status: "captured" } } }
    }),
    prisma.payment.aggregate({
      where: { propertyId, createdAt: { gte: today, lt: tomorrow }, status: "captured" },
      _sum: { amount: true }
    }),
    prisma.payment.aggregate({
      where: { propertyId, createdAt: { gte: today, lt: tomorrow }, status: "refunded" },
      _sum: { amount: true }
    })
  ]);
  const foliosOpenBalanceEur = openFolios.reduce((s, f) => {
    const charges = f.lines.reduce((x, l) => x + Number(l.total), 0);
    const paid = f.payments.reduce((x, p) => x + Number(p.amount), 0);
    return s + Math.max(0, charges - paid);
  }, 0);
  const foliosWithOpenBalance = openFolios.filter((f) => {
    const charges = f.lines.reduce((x, l) => x + Number(l.total), 0);
    const paid = f.payments.reduce((x, p) => x + Number(p.amount), 0);
    return charges - paid > 0.01;
  }).length;

  // Overbooking (7d ahead)
  const horizonEnd = new Date(today.getTime() + 7 * 86400000);
  const candidates = await prisma.reservation.findMany({
    where: {
      propertyId,
      status: { in: ["confirmed", "checked_in"] },
      assignedRoomId: { not: null },
      departureDate: { gt: today },
      arrivalDate: { lt: horizonEnd }
    },
    select: { assignedRoomId: true, arrivalDate: true, departureDate: true }
  });
  const byRoom = new Map<string, Array<{ a: Date; d: Date }>>();
  for (const r of candidates) {
    if (!r.assignedRoomId) continue;
    const list = byRoom.get(r.assignedRoomId) ?? [];
    list.push({ a: r.arrivalDate, d: r.departureDate });
    byRoom.set(r.assignedRoomId, list);
  }
  let overbookings = 0;
  for (const list of byRoom.values()) {
    list.sort((x, y) => x.a.getTime() - y.a.getTime());
    for (let i = 1; i < list.length; i++) {
      if (list[i].a < list[i - 1].d) overbookings++;
    }
  }

  // Compliance failing (best effort — el módulo de compliance tiene varios
  // entities; nos quedamos con un placeholder hasta integrar el Center).
  const complianceFailing = 0;

  const capturedToday = Number(capturedTodayAgg._sum.amount ?? 0);
  const refundedToday = Number(refundedTodayAgg._sum.amount ?? 0);

  // Reputation (best effort)
  let reputation: GmDashboard["reputation"] | undefined;
  try {
    const reviews30 = await prisma.guestReview.findMany({
      where: {
        propertyId,
        createdAt: { gte: new Date(today.getTime() - 30 * 86400000) }
      },
      select: { rating: true }
    });
    if (reviews30.length > 0) {
      const scores = reviews30.map((r) => Number(r.rating ?? NaN)).filter((n) => Number.isFinite(n));
      const avg = scores.length > 0 ? scores.reduce((s, x) => s + x, 0) / scores.length : undefined;
      reputation = {
        avgScore: avg ? Math.round(avg * 100) / 100 : undefined,
        reviewsLast30: reviews30.length
      };
    }
  } catch {
    reputation = undefined;
  }
  void nightsYtd;

  const mtdByType = Array.from(revMtd.byType.entries())
    .map(([type, total]) => ({ type, total: Math.round(total * 100) / 100 }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 8);

  // --- Channel cost today (commissions + payment fees)
  // Two complementary sources:
  //   - CommissionAccrual.accruedAt: real accrued commissions for today.
  //   - ChannelProfitabilitySnapshot.date: fallback aggregate.
  // We pick the larger of the two to avoid double-counting while still
  // surfacing a signal when one of them is empty.
  const [commissionAggToday, profitabilityToday] = await Promise.all([
    prisma.commissionAccrual.aggregate({
      where: { propertyId, accruedAt: { gte: today, lt: tomorrow } },
      _sum: { commissionAmount: true }
    }).catch(() => ({ _sum: { commissionAmount: null as number | null } })),
    prisma.channelProfitabilitySnapshot.findMany({
      where: { propertyId, date: { gte: today, lt: tomorrow } },
      select: { commissionCost: true, paymentCost: true }
    }).catch(() => [] as Array<{ commissionCost: unknown; paymentCost: unknown }>)
  ]);
  const accruedCommissionToday = Number(commissionAggToday._sum.commissionAmount ?? 0);
  const profitabilityChannelCostToday = profitabilityToday.reduce(
    (s, r) => s + Number(r.commissionCost ?? 0) + Number(r.paymentCost ?? 0),
    0
  );
  const channelCostToday = Math.max(accruedCommissionToday, profitabilityChannelCostToday);
  const channelCostPct = revToday.total > 0
    ? Math.round((channelCostToday / revToday.total) * 1000) / 10
    : 0;

  // --- Labor cost today (from TimeClockEntry pairs, in/out, multiplied by
  // StaffProfile.hourlyCost). We treat clockType "in" and "out" as paired
  // sequentially per staff member.
  const timeEntriesToday = await prisma.timeClockEntry.findMany({
    where: { propertyId, clockAt: { gte: today, lt: tomorrow } },
    select: { staffProfileId: true, clockType: true, clockAt: true },
    orderBy: { clockAt: "asc" }
  });
  const staffIds = Array.from(new Set(timeEntriesToday.map((e) => e.staffProfileId)));
  const staffProfiles = staffIds.length > 0
    ? await prisma.staffProfile.findMany({
        where: { id: { in: staffIds } },
        select: { id: true, hourlyCost: true }
      })
    : [];
  const hourlyCostByStaff = new Map<string, number>();
  for (const s of staffProfiles) {
    hourlyCostByStaff.set(s.id, Number(s.hourlyCost ?? 0));
  }
  const hoursByStaff = new Map<string, number>();
  const openClockIn = new Map<string, number>(); // staffId -> ms timestamp
  for (const entry of timeEntriesToday) {
    const ts = entry.clockAt.getTime();
    if (entry.clockType === "in") {
      openClockIn.set(entry.staffProfileId, ts);
    } else if (entry.clockType === "out") {
      const startedAt = openClockIn.get(entry.staffProfileId);
      if (startedAt !== undefined) {
        const hours = Math.max(0, (ts - startedAt) / 3_600_000);
        hoursByStaff.set(entry.staffProfileId, (hoursByStaff.get(entry.staffProfileId) ?? 0) + hours);
        openClockIn.delete(entry.staffProfileId);
      }
    }
  }
  let totalLaborCostToday = 0;
  for (const [staffId, hours] of hoursByStaff) {
    totalLaborCostToday += hours * (hourlyCostByStaff.get(staffId) ?? 0);
  }
  totalLaborCostToday = Math.round(totalLaborCostToday * 100) / 100;

  // --- GOPPAR / net contribution
  const netContributionTodayRaw = revToday.total - channelCostToday - totalLaborCostToday;
  const netContributionToday = Math.round(netContributionTodayRaw * 100) / 100;
  const goppar = totalRoomsCount > 0
    ? Math.round((netContributionTodayRaw / totalRoomsCount) * 100) / 100
    : 0;

  // --- VIPs in-house: reservations checked_in + a guest profile with
  // vipLevel set, OR the reservation itself flagged VIP, OR a non-empty
  // Guest.vipCode. Three independent signals, OR'd, deduped by reservation.
  const inHouseReservations = await prisma.reservation.findMany({
    where: { propertyId, status: "checked_in" },
    select: {
      id: true,
      vipFlag: true,
      reservationGuests: {
        where: { isPrimary: true },
        select: { guest: { select: { vipCode: true, loyaltyTier: true, email: true } } }
      }
    }
  });
  // Pull the VIP guest profiles in this org for matching by email — the
  // reservation guest is the operational record, the GuestProfile carries
  // CRM-wide loyalty/VIP status.
  const propertyForOrg = await prisma.property.findUnique({ where: { id: propertyId }, select: { organizationId: true } });
  const orgId = propertyForOrg?.organizationId;
  const guestEmails = inHouseReservations
    .flatMap((r) => r.reservationGuests.map((g) => g.guest?.email ?? null))
    .filter((e): e is string => Boolean(e));
  let vipProfilesByEmail = new Map<string, true>();
  if (orgId && guestEmails.length > 0) {
    const vipProfiles = await prisma.guestProfile.findMany({
      where: {
        organizationId: orgId,
        vipLevel: { not: null },
        email: { in: guestEmails }
      },
      select: { email: true }
    });
    vipProfilesByEmail = new Map(vipProfiles.map((p) => [p.email ?? "", true]));
  }
  let vipsInHouse = 0;
  for (const r of inHouseReservations) {
    if (r.vipFlag) {
      vipsInHouse++;
      continue;
    }
    const primary = r.reservationGuests[0]?.guest;
    if (primary?.vipCode) {
      vipsInHouse++;
      continue;
    }
    if (primary?.loyaltyTier && /platinum|gold|diamond/i.test(primary.loyaltyTier)) {
      vipsInHouse++;
      continue;
    }
    if (primary?.email && vipProfilesByEmail.has(primary.email)) {
      vipsInHouse++;
    }
  }

  // --- Top 3 BAR recommendations: by `active=true` and lowest sortOrder,
  // which is the canonical "recommended-first" ordering used elsewhere.
  const barLevels = await prisma.barLevel.findMany({
    where: { propertyId, active: true },
    select: { name: true, price: true, sortOrder: true },
    orderBy: [{ sortOrder: "asc" }, { price: "asc" }],
    take: 3
  });
  const barRecommendations = barLevels.map((b) => ({
    name: b.name,
    price: Math.round(Number(b.price) * 100) / 100,
    sortOrder: b.sortOrder
  }));

  // --- Compliance summary (Verifactu / SES / TBAI)
  const [
    verifactuPending,
    verifactuLastRow,
    sesPending,
    tbaiPending,
    tbaiErrors
  ] = await Promise.all([
    prisma.verifactuSubmission.count({
      where: { propertyId, status: { in: FISCAL_PENDING_STATUSES } }
    }).catch(() => 0),
    prisma.verifactuSubmission.findFirst({
      where: { propertyId, acknowledgedAt: { not: null } },
      orderBy: { acknowledgedAt: "desc" },
      select: { acknowledgedAt: true }
    }).catch(() => null),
    prisma.sesHospedajesSubmission.count({
      where: { propertyId, status: { in: SES_PENDING_STATUSES as unknown as Array<"queued"> } }
    }).catch(() => 0),
    prisma.tbaiSubmission.count({
      where: { propertyId, status: { in: FISCAL_PENDING_STATUSES } }
    }).catch(() => 0),
    prisma.tbaiSubmission.count({
      where: { propertyId, status: { in: ["failed", "rejected"] } }
    }).catch(() => 0)
  ]);
  const complianceSummary: GmDashboard["complianceSummary"] = {
    verifactu: {
      pending: verifactuPending,
      last: verifactuLastRow?.acknowledgedAt
        ? verifactuLastRow.acknowledgedAt.toISOString()
        : undefined
    },
    ses: { pending: sesPending },
    tbai: { pending: tbaiPending, errors: tbaiErrors }
  };

  // --- AI anomalies: three rules-based detectors.
  //   (a) ADR drop > 10% vs same day last year.
  //   (b) Occupancy drop > 5 pp vs same day last year.
  //   (c) Channel cost as % of revenue spike above 22%.
  const aiAnomalies: GmDashboard["aiAnomalies"] = [];
  const lastYearSameDay = new Date(Date.UTC(
    today.getUTCFullYear() - 1,
    today.getUTCMonth(),
    today.getUTCDate()
  ));
  const lyEnd = new Date(lastYearSameDay.getTime() + 86400000);
  const lySnapshot = await prisma.revenueDailySnapshot.findFirst({
    where: {
      propertyId,
      snapshotDate: { gte: lastYearSameDay, lt: lyEnd },
      roomTypeId: null,
      ratePlanId: null,
      channelId: null,
      segment: null,
      market: null
    },
    select: { adr: true, occupancyPercent: true }
  }).catch(() => null);
  if (lySnapshot) {
    const lyAdr = Number(lySnapshot.adr ?? 0);
    if (lyAdr > 0) {
      const dropPct = ((lyAdr - adrToday) / lyAdr) * 100;
      if (dropPct > 10) {
        aiAnomalies.push({
          kind: "adr_drop_vs_ly",
          severity: dropPct > 20 ? "high" : "medium",
          message: `ADR hoy ${adrToday.toFixed(2)} € — ${dropPct.toFixed(1)}% por debajo del mismo día del año pasado (${lyAdr.toFixed(2)} €).`
        });
      }
    }
    const lyOcc = Number(lySnapshot.occupancyPercent ?? 0);
    if (lyOcc > 0) {
      const dropPp = lyOcc - occToday;
      if (dropPp > 5) {
        aiAnomalies.push({
          kind: "occupancy_drop_vs_ly",
          severity: dropPp > 10 ? "high" : "medium",
          message: `Ocupación hoy ${occToday.toFixed(1)}% — ${dropPp.toFixed(1)} pp por debajo del año pasado (${lyOcc.toFixed(1)}%).`
        });
      }
    }
  }
  if (channelCostPct > 22) {
    aiAnomalies.push({
      kind: "channel_cost_spike",
      severity: channelCostPct > 30 ? "high" : "medium",
      message: `Coste de canal ${channelCostPct.toFixed(1)}% — por encima del umbral 22% de hoy.`
    });
  }

  // --- Cancellation risk score (heurística simple, no IA):
  // % de reservas próximas (próximos 14 días, confirmed) con bookerEmail
  // asociado a >=1 no_show histórico previo, o con depositPaid < depositAmount.
  const futureEnd = new Date(today.getTime() + 14 * 86400000);
  const upcoming = await prisma.reservation.findMany({
    where: {
      propertyId,
      status: "confirmed",
      arrivalDate: { gte: today, lt: futureEnd }
    },
    select: {
      id: true,
      bookerEmail: true,
      depositAmount: true,
      depositPaid: true
    }
  });
  let atRisk = 0;
  if (upcoming.length > 0) {
    const emails = Array.from(
      new Set(upcoming.map((r) => r.bookerEmail).filter((e): e is string => Boolean(e)))
    );
    const noShowEmails = emails.length > 0
      ? new Set(
          (await prisma.reservation.findMany({
            where: {
              propertyId,
              status: "no_show",
              bookerEmail: { in: emails }
            },
            select: { bookerEmail: true }
          })).map((r) => r.bookerEmail).filter((e): e is string => Boolean(e))
        )
      : new Set<string>();
    for (const r of upcoming) {
      let risky = false;
      if (r.bookerEmail && noShowEmails.has(r.bookerEmail)) risky = true;
      const dep = Number(r.depositAmount ?? 0);
      const paid = Number(r.depositPaid ?? 0);
      if (dep > 0 && paid < dep) risky = true;
      if (risky) atRisk++;
    }
  }
  const cancellationRiskScore = upcoming.length > 0
    ? Math.round((atRisk / upcoming.length) * 1000) / 10
    : 0;

  return {
    generatedAt: now.toISOString(),
    propertyId,
    propertyName: property?.name ?? undefined,
    asOf: today.toISOString().slice(0, 10),

    occupancy: {
      today: {
        value: occToday,
        vsYesterday: { value: occYest, pct: pctDelta(occToday, occYest) },
        vsLastWeek: { value: occLastWeek, pct: pctDelta(occToday, occLastWeek) }
      },
      mtd: occMtd,
      ytdRoomNightsSold: nightsYtd
    },
    adr: {
      today: {
        value: adrToday,
        vsYesterday: { value: adrYest, pct: pctDelta(adrToday, adrYest) },
        vsLastWeek: { value: adrLastWeek, pct: pctDelta(adrToday, adrLastWeek) }
      },
      mtd: adrMtd
    },
    revpar: {
      today: {
        value: revparToday,
        vsYesterday: { value: revparYest, pct: pctDelta(revparToday, revparYest) },
        vsLastWeek: { value: revparLastWeek, pct: pctDelta(revparToday, revparLastWeek) }
      },
      mtd: revparMtd
    },
    revenue: {
      today: {
        value: revToday.total,
        vsYesterday: { value: revYesterday.total, pct: pctDelta(revToday.total, revYesterday.total) },
        vsLastWeek: { value: revLastWeek.total, pct: pctDelta(revToday.total, revLastWeek.total) }
      },
      mtd: revMtd.total,
      mtdByType
    },

    goppar,
    totalLaborCostToday,
    channelCostPct,
    netContributionToday,

    productivity: {
      checkInsDone: checkInsRows,
      checkInsPlanned: plannedArrivals,
      checkOutsDone: checkOutsRows,
      checkOutsPlanned: plannedDepartures,
      noShowsToday,
      cancellationsToday
    },

    channelMix,
    segmentMix,

    barRecommendations,
    vipsInHouse,
    complianceSummary,
    aiAnomalies,
    cancellationRiskScore,

    alerts: {
      overbookings,
      emergencyIncidents,
      openIncidents,
      blockedRooms,
      foliosWithOpenBalance,
      foliosOpenBalanceEur: Math.round(foliosOpenBalanceEur * 100) / 100,
      complianceFailing
    },

    cash: {
      capturedTodayEur: Math.round(capturedToday * 100) / 100,
      refundedTodayEur: Math.round(refundedToday * 100) / 100,
      netTodayEur: Math.round((capturedToday - refundedToday) * 100) / 100,
      openBalanceEur: Math.round(foliosOpenBalanceEur * 100) / 100
    },

    reputation
  };
}

// --- Pace endpoint -----------------------------------------------------------
//
// Returns the next `days` stay dates, each with OTB (current snapshot of room
// revenue on the books), forecast (expected revenue from
// RevenueForecastSnapshot) and lastYear (real revenue from the same date one
// year ago in RevenueDailySnapshot).
//
// All three sources are honest:
//   - OTB: most recent RevenueDailySnapshot for the stay date if present,
//     otherwise reservations-based (sum of room revenue prorated per night).
//   - Forecast: latest RevenueForecastSnapshot for the date (expectedTotalRevenue).
//   - LastYear: the actual RevenueDailySnapshot of (stayDate - 1 year).
//
// If a source is missing we return 0 — no fabrication.
export async function buildGmPace(input: { propertyId: string; days?: number; asOf?: Date }): Promise<GmPaceResponse> {
  const propertyId = input.propertyId;
  const now = input.asOf ?? new Date();
  const start = startOfDayUtc(now);
  const days = Math.max(1, Math.min(180, Math.floor(input.days ?? 30)));
  const end = new Date(start.getTime() + days * 86400000);

  const lyStart = new Date(Date.UTC(
    start.getUTCFullYear() - 1,
    start.getUTCMonth(),
    start.getUTCDate()
  ));
  const lyEnd = new Date(Date.UTC(
    end.getUTCFullYear() - 1,
    end.getUTCMonth(),
    end.getUTCDate()
  ));

  // Build OTB straight from confirmed/checked_in reservations: the daily
  // snapshot may not exist yet for *future* dates, and we want a precise
  // "on the books" number.
  const otbReservations = await prisma.reservation.findMany({
    where: {
      propertyId,
      status: { in: ["confirmed", "checked_in", "checked_out"] },
      arrivalDate: { lt: end },
      departureDate: { gt: start }
    },
    select: { arrivalDate: true, departureDate: true, totalAmount: true, roomsCount: true }
  });
  const otbByDate = new Map<string, number>();
  for (const r of otbReservations) {
    const a = r.arrivalDate.getTime();
    const d = r.departureDate.getTime();
    const nights = Math.max(1, Math.round((d - a) / 86400000));
    const revPerNight = Number(r.totalAmount ?? 0) / nights;
    for (let i = 0; i < nights; i++) {
      const day = new Date(a + i * 86400000);
      const dayKey = day.toISOString().slice(0, 10);
      if (day.getTime() < start.getTime() || day.getTime() >= end.getTime()) continue;
      otbByDate.set(dayKey, (otbByDate.get(dayKey) ?? 0) + revPerNight);
    }
  }

  const [forecastRows, lyRows] = await Promise.all([
    prisma.revenueForecastSnapshot.findMany({
      where: {
        propertyId,
        forecastDate: { gte: start, lt: end },
        roomTypeId: null,
        ratePlanId: null,
        channelId: null,
        segment: null,
        market: null
      },
      select: { forecastDate: true, expectedTotalRevenue: true, expectedRoomRevenue: true, modelVersion: true, createdAt: true },
      orderBy: { createdAt: "desc" }
    }).catch(() => [] as Array<{ forecastDate: Date; expectedTotalRevenue: unknown; expectedRoomRevenue: unknown; modelVersion: string | null; createdAt: Date }>),
    prisma.revenueDailySnapshot.findMany({
      where: {
        propertyId,
        snapshotDate: { gte: lyStart, lt: lyEnd },
        roomTypeId: null,
        ratePlanId: null,
        channelId: null,
        segment: null,
        market: null
      },
      select: { snapshotDate: true, totalRevenue: true, roomRevenue: true }
    }).catch(() => [] as Array<{ snapshotDate: Date; totalRevenue: unknown; roomRevenue: unknown }>)
  ]);

  // Forecast: pick latest per forecastDate.
  const forecastByDate = new Map<string, number>();
  for (const f of forecastRows) {
    const key = f.forecastDate.toISOString().slice(0, 10);
    if (forecastByDate.has(key)) continue; // already have the latest (orderBy desc)
    const value = Number(f.expectedTotalRevenue ?? f.expectedRoomRevenue ?? 0);
    forecastByDate.set(key, value);
  }
  // Last year: indexed by stay date (LY).
  const lyByDate = new Map<string, number>();
  for (const r of lyRows) {
    const key = r.snapshotDate.toISOString().slice(0, 10);
    const value = Number(r.totalRevenue ?? r.roomRevenue ?? 0);
    lyByDate.set(key, value);
  }

  const rows: GmPaceRow[] = [];
  for (let i = 0; i < days; i++) {
    const day = new Date(start.getTime() + i * 86400000);
    const dayKey = day.toISOString().slice(0, 10);
    const lyDay = new Date(Date.UTC(
      day.getUTCFullYear() - 1,
      day.getUTCMonth(),
      day.getUTCDate()
    ));
    const lyKey = lyDay.toISOString().slice(0, 10);
    rows.push({
      date: dayKey,
      otb: Math.round((otbByDate.get(dayKey) ?? 0) * 100) / 100,
      forecast: Math.round((forecastByDate.get(dayKey) ?? 0) * 100) / 100,
      lastYear: Math.round((lyByDate.get(lyKey) ?? 0) * 100) / 100
    });
  }

  return {
    generatedAt: now.toISOString(),
    propertyId,
    from: start.toISOString().slice(0, 10),
    to: new Date(end.getTime() - 86400000).toISOString().slice(0, 10),
    days,
    rows
  };
}
