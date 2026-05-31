// Shift Manager service — pantalla del Jefe de Recepción.
//
// Directriz HotelOS (Nov 2026):
//   "Jefe de recepción: turno, productividad, incidencias críticas, caja,
//    no-shows, upgrades, conflictos."
//
// Agrega métricas que el supervisor necesita para gestionar el turno:
//   - Productividad: check-ins / check-outs hechos hoy, tiempo medio
//   - Incidencias críticas activas
//   - Caja del día (cobros + pagos)
//   - No-shows + cancelaciones del día
//   - Conflictos: overbooking, habitaciones sin asignar, late checkouts
//   - Eventos del turno (timeline de las últimas 4h)

import { prisma } from "@hotelos/database";

export type ShiftManagerKpis = {
  checkInsToday: number;
  checkOutsToday: number;
  pendingArrivals: number;
  pendingDepartures: number;
  noShowsToday: number;
  cancellationsToday: number;
  cashCapturedEur: number;
  cashRefundedEur: number;
  unpaidBalanceEur: number;
  unassignedArrivals: number;
  overbookingCount: number;
  emergencyIncidents: number;
  blockedRooms: number;
};

export type ShiftEvent = {
  id: string;
  timestamp: string;
  type: "check_in" | "check_out" | "no_show" | "cancellation" | "incident" | "payment" | "guest_request";
  title: string;
  detail?: string;
  amount?: number;
  importance: "info" | "highlight" | "alert";
};

export type ShiftManagerResult = {
  generatedAt: string;
  propertyId: string;
  kpis: ShiftManagerKpis;
  events: ShiftEvent[];     // últimos 50, descendente
  flags: Array<{ id: string; status: "critical" | "warning" | "ok"; title: string; detail: string }>;
};

function startOfDayUtc(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

function fmtName(g: { firstName?: string | null; surname1?: string | null } | null): string {
  if (!g) return "Huésped";
  return [g.firstName, g.surname1].filter(Boolean).join(" ") || "Huésped";
}

export async function buildShiftManager(input: { propertyId: string }): Promise<ShiftManagerResult> {
  const propertyId = input.propertyId;
  const now = new Date();
  const today = startOfDayUtc();
  const tomorrow = new Date(today.getTime() + 86400000);

  const [
    checkInsRows,
    checkOutsRows,
    pendingArrivals,
    pendingDepartures,
    noShowsCount,
    cancellationsCount,
    paymentsCaptured,
    paymentsRefunded,
    openFolios,
    unassignedArrivals,
    emergencyIncidents,
    blockedRooms,
    cancellations,
    workOrders
  ] = await Promise.all([
    prisma.stay.findMany({
      where: {
        reservation: { propertyId },
        checkinAt: { gte: today, lt: tomorrow }
      },
      orderBy: { checkinAt: "desc" },
      take: 50
    }),
    prisma.stay.findMany({
      where: {
        reservation: { propertyId },
        checkoutAt: { gte: today, lt: tomorrow }
      },
      orderBy: { checkoutAt: "desc" },
      take: 50
    }),
    prisma.reservation.count({
      where: { propertyId, arrivalDate: { gte: today, lt: tomorrow }, status: "confirmed" }
    }),
    prisma.reservation.count({
      where: { propertyId, departureDate: { gte: today, lt: tomorrow }, status: "checked_in" }
    }),
    prisma.reservation.count({
      where: { propertyId, status: "no_show", arrivalDate: { gte: today, lt: tomorrow } }
    }),
    prisma.reservation.count({
      where: { propertyId, status: "cancelled", arrivalDate: { gte: today, lt: tomorrow } }
    }),
    prisma.payment.aggregate({
      where: { propertyId, createdAt: { gte: today, lt: tomorrow }, status: "captured" },
      _sum: { amount: true }
    }),
    prisma.payment.aggregate({
      where: { propertyId, createdAt: { gte: today, lt: tomorrow }, status: "refunded" },
      _sum: { amount: true }
    }),
    prisma.folio.findMany({
      where: { reservation: { propertyId }, status: "open" },
      include: { lines: true, payments: { where: { status: "captured" } } }
    }),
    prisma.reservation.count({
      where: { propertyId, arrivalDate: { gte: today, lt: tomorrow }, status: "confirmed", assignedRoomId: null }
    }),
    prisma.workOrder.count({
      where: { propertyId, status: { in: ["open", "in_progress"] }, priority: "emergency" }
    }).catch(() => 0),
    prisma.room.count({ where: { propertyId, sellable: false, active: true } }),
    prisma.reservation.findMany({
      where: { propertyId, status: "cancelled", arrivalDate: { gte: today, lt: tomorrow } },
      take: 20,
      orderBy: { arrivalDate: "desc" }
    }),
    prisma.workOrder.findMany({
      where: { propertyId, status: { in: ["open", "in_progress"] } },
      orderBy: { createdAt: "desc" },
      take: 20
    }).catch(() => [])
  ]);

  const cashCaptured = Number(paymentsCaptured._sum.amount ?? 0);
  const cashRefunded = Number(paymentsRefunded._sum.amount ?? 0);
  const unpaid = openFolios.reduce((s, f) => {
    const charges = f.lines.reduce((x, l) => x + Number(l.total), 0);
    const paid = f.payments.reduce((x, p) => x + Number(p.amount), 0);
    return s + Math.max(0, charges - paid);
  }, 0);

  // Overbooking detection (próximos 7 días)
  const horizonStart = today;
  const horizonEnd = new Date(today.getTime() + 7 * 86400000);
  const candidates = await prisma.reservation.findMany({
    where: {
      propertyId,
      status: { in: ["confirmed", "checked_in"] },
      assignedRoomId: { not: null },
      departureDate: { gt: horizonStart },
      arrivalDate: { lt: horizonEnd }
    },
    select: { id: true, assignedRoomId: true, arrivalDate: true, departureDate: true }
  });
  const byRoom = new Map<string, Array<{ a: Date; d: Date }>>();
  for (const r of candidates) {
    if (!r.assignedRoomId) continue;
    const list = byRoom.get(r.assignedRoomId) ?? [];
    list.push({ a: r.arrivalDate, d: r.departureDate });
    byRoom.set(r.assignedRoomId, list);
  }
  let overbookingCount = 0;
  for (const list of byRoom.values()) {
    list.sort((x, y) => x.a.getTime() - y.a.getTime());
    for (let i = 1; i < list.length; i++) {
      if (list[i].a < list[i - 1].d) overbookingCount++;
    }
  }

  const kpis: ShiftManagerKpis = {
    checkInsToday: checkInsRows.length,
    checkOutsToday: checkOutsRows.length,
    pendingArrivals,
    pendingDepartures,
    noShowsToday: noShowsCount,
    cancellationsToday: cancellationsCount,
    cashCapturedEur: Math.round(cashCaptured * 100) / 100,
    cashRefundedEur: Math.round(cashRefunded * 100) / 100,
    unpaidBalanceEur: Math.round(unpaid * 100) / 100,
    unassignedArrivals,
    overbookingCount,
    emergencyIncidents,
    blockedRooms
  };

  // Eventos del turno — combina stays + cancellations + work orders + payments.
  const events: ShiftEvent[] = [];

  // Resolver guest names para stays
  const stayResIds = [...checkInsRows, ...checkOutsRows].map((s) => s.reservationId);
  const stayLinks = stayResIds.length
    ? await prisma.reservationGuest.findMany({
        where: { reservationId: { in: stayResIds }, isPrimary: true },
        select: { reservationId: true, guestId: true }
      })
    : [];
  const stayGuestIds = Array.from(new Set(stayLinks.map((l) => l.guestId)));
  const stayGuests = stayGuestIds.length
    ? await prisma.guest.findMany({
        where: { id: { in: stayGuestIds } },
        select: { id: true, firstName: true, surname1: true }
      })
    : [];
  const guestByRes = new Map(stayLinks.map((l) => [l.reservationId, l.guestId]));
  const guestById = new Map(stayGuests.map((g) => [g.id, g]));
  const nameFor = (resId: string): string => {
    const gid = guestByRes.get(resId);
    if (!gid) return "Huésped";
    return fmtName(guestById.get(gid) ?? null);
  };
  // Resolver número de habitación
  const stayRoomIds = Array.from(new Set([...checkInsRows, ...checkOutsRows].map((s) => s.roomId)));
  const stayRooms = stayRoomIds.length
    ? await prisma.room.findMany({ where: { id: { in: stayRoomIds } }, select: { id: true, number: true } })
    : [];
  const roomById = new Map(stayRooms.map((r) => [r.id, r]));

  for (const s of checkInsRows) {
    if (!s.checkinAt) continue;
    const room = roomById.get(s.roomId);
    events.push({
      id: `ci_${s.id}`,
      timestamp: s.checkinAt.toISOString(),
      type: "check_in",
      title: `Check-in · ${room ? `Hab. ${room.number}` : "Sin habitación"}`,
      detail: nameFor(s.reservationId),
      importance: "info"
    });
  }
  for (const s of checkOutsRows) {
    if (!s.checkoutAt) continue;
    const room = roomById.get(s.roomId);
    events.push({
      id: `co_${s.id}`,
      timestamp: s.checkoutAt.toISOString(),
      type: "check_out",
      title: `Check-out · ${room ? `Hab. ${room.number}` : "Sin habitación"}`,
      detail: nameFor(s.reservationId),
      importance: "info"
    });
  }
  for (const c of cancellations) {
    events.push({
      id: `cancel_${c.id}`,
      timestamp: c.createdAt.toISOString(),
      type: "cancellation",
      title: `Cancelación · ${c.code}`,
      detail: `Reserva cancelada · €${Number(c.totalAmount).toFixed(2)} de ingreso perdido`,
      amount: -Number(c.totalAmount),
      importance: "alert"
    });
  }
  for (const w of workOrders as Array<{ id: string; createdAt: Date; title: string; status: string; priority: string }>) {
    events.push({
      id: `wo_${w.id}`,
      timestamp: w.createdAt.toISOString(),
      type: "incident",
      title: `Incidencia · ${w.title}`,
      detail: `Prioridad ${w.priority} · ${w.status}`,
      importance: w.priority === "emergency" ? "alert" : "highlight"
    });
  }

  // Limit a últimos 50 + sort desc
  events.sort((a, b) => b.timestamp.localeCompare(a.timestamp));

  // Flags — bloques de información critical/warning/ok para resumen visual.
  const flags: ShiftManagerResult["flags"] = [
    {
      id: "overbooking",
      status: overbookingCount > 0 ? "critical" : "ok",
      title: "Conflictos de reserva",
      detail: overbookingCount > 0 ? `${overbookingCount} solapes en los próximos 7 días` : "Sin solapes"
    },
    {
      id: "unassigned",
      status: unassignedArrivals > 0 ? "warning" : "ok",
      title: "Llegadas sin habitación",
      detail: unassignedArrivals > 0 ? `${unassignedArrivals} llegadas hoy sin asignar` : "Todas asignadas"
    },
    {
      id: "emergency",
      status: emergencyIncidents > 0 ? "critical" : "ok",
      title: "Incidencias críticas",
      detail: emergencyIncidents > 0 ? `${emergencyIncidents} emergencias activas` : "Sin emergencias"
    },
    {
      id: "balance",
      status: unpaid > 1000 ? "warning" : "ok",
      title: "Saldo abierto",
      detail: unpaid > 0 ? `€${unpaid.toFixed(2)} sin cobrar` : "Todo cobrado"
    },
    {
      id: "pending_arrivals",
      status: pendingArrivals > 0 && now.getUTCHours() >= 18 ? "warning" : "ok",
      title: "Llegadas pendientes",
      detail: pendingArrivals > 0 ? `${pendingArrivals} reservas sin check-in` : "Todas procesadas"
    }
  ];

  return {
    generatedAt: now.toISOString(),
    propertyId,
    kpis,
    events: events.slice(0, 50),
    flags
  };
}
