// Front Desk Action Queue — cola priorizada de "lo que debe hacer recepción
// ahora". Reemplaza la mentalidad de "dashboard de listas" por una secuencia
// ordenada de problemas + acción recomendada.
//
// Directriz (Nov 2026):
//   "HotelOS no es un PMS para guardar datos. Es un sistema para que el hotel
//    actúe mejor, más rápido y con menos errores."
//
// Detectores incluidos (orden por prioridad descendente):
//   1.  overbooking            · dos reservas activas en la misma habitación
//   2.  no_show_risk           · llegada de hoy + pasaron las 19:00 + sigue confirmed
//   3.  late_checkout_overdue  · salida hoy + pasaron las 14:00 + sigue checked_in
//   4.  incident_open          · incidencia/work order activo en habitación ocupada
//   5.  unassigned_arrival     · llegada de hoy sin habitación asignada → recomienda
//                                primera habitación limpia del mismo room type
//   6.  checkin_blocked        · llegada de hoy + room asignado pero NO limpio
//   7.  housekeeping_late      · habitación sucia + llegada en <2h (mismo room type)
//   8.  open_balance           · folio con saldo > 0 + salida hoy
//   9.  checkout_pending       · salida hoy + sigue checked_in
//  10.  checkin_ready          · llegada hoy + room limpio + sigue confirmed → 1-clic
//  11.  vip_arriving           · guest VIP llega hoy
//  12.  repeat_arriving        · guest con ≥1 estancia anterior (checked_out)
//
// Cada item incluye:
//   - priority: "urgent" | "today" | "soon"
//   - title: cabecera corta
//   - context: línea de detalle (huésped, hora, habitación, motivo)
//   - recommendation: texto natural con el siguiente paso ("La 405 está limpia
//                     y es Doble Vista Mar. ¿Asignar?")
//   - action: { label, kind, payload } — el frontend traduce kind a navegación
//             o a una mutación API (asignar habitación, marcar como no-show…)
//
// El servicio devuelve la cola completa, ordenada y deduplicada. La UI decide
// cuántos items mostrar.

import { prisma } from "@hotelos/database";
import { computeBalancesForReservations } from "../folio/folio-balance.service.js";

// ===========================================================================
// Tipos públicos
// ===========================================================================

export type FrontDeskQueuePriority = "urgent" | "today" | "soon";

export type FrontDeskQueueKind =
  | "overbooking"
  | "no_show_risk"
  | "late_checkout_overdue"
  | "incident_open"
  | "unassigned_arrival"
  | "checkin_blocked"
  | "housekeeping_late"
  | "open_balance"
  | "checkout_pending"
  | "checkin_ready"
  | "vip_arriving"
  | "repeat_arriving";

export type FrontDeskQueueActionKind =
  | "open_reservation"           // navega al detalle de la reserva
  | "open_room_rack"             // abre el room rack en una habitación
  | "open_housekeeping"          // navega a HK
  | "open_work_order"            // navega a mantenimiento / incidencia
  | "assign_room"                // mutación: asigna roomId a la reserva
  | "mark_no_show"               // mutación: marca como no-show
  | "open_folio"                 // navega al folio
  | "open_guest"                 // navega a la ficha de huésped
  | "start_checkin"              // arranca el flujo de check-in en 90s
  | "start_checkout";            // arranca el flujo de check-out

export type FrontDeskQueueAction = {
  label: string;
  kind: FrontDeskQueueActionKind;
  payload?: Record<string, string | number | boolean | undefined>;
};

export type FrontDeskQueueItem = {
  id: string;
  priority: FrontDeskQueuePriority;
  kind: FrontDeskQueueKind;
  title: string;
  context: string;
  recommendation?: string;
  primaryAction?: FrontDeskQueueAction;
  secondaryActions?: FrontDeskQueueAction[];
  reservationId?: string;
  guestId?: string;
  roomId?: string;
  workOrderId?: string;
  dueAt?: string; // ISO datetime — opcional, ordena dentro de la misma priority
};

export type FrontDeskQueueResult = {
  generatedAt: string;
  items: FrontDeskQueueItem[];
  counts: Record<FrontDeskQueueKind, number>;
  summary: {
    urgent: number;
    today: number;
    soon: number;
    total: number;
  };
};

// ===========================================================================
// Helpers
// ===========================================================================

function startOfDayUtc(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

function fmtName(g: { firstName?: string | null; surname1?: string | null; surname2?: string | null } | null): string {
  if (!g) return "Huésped";
  const parts = [g.firstName, g.surname1, g.surname2].filter((p): p is string => Boolean(p && p.trim()));
  return parts.length > 0 ? parts.join(" ") : "Huésped";
}

function priorityWeight(p: FrontDeskQueuePriority): number {
  if (p === "urgent") return 0;
  if (p === "today") return 1;
  return 2;
}

const KIND_ORDER: FrontDeskQueueKind[] = [
  "overbooking",
  "no_show_risk",
  "late_checkout_overdue",
  "incident_open",
  "unassigned_arrival",
  "checkin_blocked",
  "housekeeping_late",
  "open_balance",
  "checkout_pending",
  "checkin_ready",
  "vip_arriving",
  "repeat_arriving"
];

function kindWeight(k: FrontDeskQueueKind): number {
  const idx = KIND_ORDER.indexOf(k);
  return idx === -1 ? 99 : idx;
}

// ===========================================================================
// Builder principal
// ===========================================================================

export async function buildFrontDeskQueue(input: { propertyId: string; now?: Date; limit?: number }): Promise<FrontDeskQueueResult> {
  const propertyId = input.propertyId;
  const now = input.now ?? new Date();
  const dayStart = startOfDayUtc();
  const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);
  const items: FrontDeskQueueItem[] = [];

  // Pagination guard rails. Default 100, caller may override within [1, 500].
  const rawLimit = input.limit;
  const take = Number.isFinite(rawLimit as number)
    ? Math.min(500, Math.max(1, Math.floor(rawLimit as number)))
    : 100;

  // ----------------------------------------------------------------------
  // Carga base: llegadas, salidas, in-house, habitaciones, guests, work orders.
  // ----------------------------------------------------------------------
  const [arrivalsToday, departuresToday, inHouseAll, allRooms, openWorkOrders] = await Promise.all([
    prisma.reservation.findMany({
      where: { propertyId, arrivalDate: { gte: dayStart, lt: dayEnd }, status: { in: ["confirmed", "checked_in", "no_show"] } },
      orderBy: { eta: "asc" },
      take
    }),
    prisma.reservation.findMany({
      where: { propertyId, departureDate: { gte: dayStart, lt: dayEnd }, status: { in: ["checked_in", "checked_out"] } },
      orderBy: { etd: "asc" },
      take
    }),
    prisma.reservation.findMany({
      where: { propertyId, status: "checked_in" },
      take
    }),
    prisma.room.findMany({ where: { propertyId, active: true }, take: Math.max(take, 500) }),
    // Work orders — usamos la tabla genérica si existe. Fallback: lista vacía.
    prisma.workOrder.findMany({
      where: { propertyId, status: { in: ["open", "in_progress"] } },
      orderBy: { createdAt: "asc" },
      take
    }).catch(() => [])
  ]);

  // Map de habitaciones por id (para resolver número, housekeeping status).
  const roomById = new Map(allRooms.map((r) => [r.id, r]));
  // Habitaciones limpias e inspeccionadas y libres (sin reserva activa) por room type.
  const occupiedRoomIds = new Set(
    [...inHouseAll.map((r) => r.assignedRoomId), ...arrivalsToday.map((r) => r.assignedRoomId)]
      .filter((id): id is string => Boolean(id))
  );
  const cleanByRoomType = new Map<string, typeof allRooms>();
  for (const room of allRooms) {
    if (!room.roomTypeId) continue;
    if (room.status === "out_of_order" || !room.sellable) continue;
    const hk = (room.housekeepingStatus ?? "").toLowerCase();
    const isClean = hk === "clean" || hk === "inspected" || hk === "ready" || room.status === "clean";
    if (!isClean) continue;
    if (occupiedRoomIds.has(room.id)) continue;
    const list = cleanByRoomType.get(room.roomTypeId) ?? [];
    list.push(room);
    cleanByRoomType.set(room.roomTypeId, list);
  }

  // Guest names para llegadas/salidas/in-house.
  const allReservationIds = [
    ...arrivalsToday.map((r) => r.id),
    ...departuresToday.map((r) => r.id),
    ...inHouseAll.map((r) => r.id)
  ];
  const reservationGuests = allReservationIds.length
    ? await prisma.reservationGuest.findMany({
        where: { reservationId: { in: allReservationIds } },
        select: { reservationId: true, guestId: true, isPrimary: true },
        take: Math.max(take, 500)
      })
    : [];
  const primaryGuestId = new Map<string, string>();
  for (const link of reservationGuests) {
    if (link.isPrimary) primaryGuestId.set(link.reservationId, link.guestId);
  }
  for (const link of reservationGuests) {
    if (!primaryGuestId.has(link.reservationId)) primaryGuestId.set(link.reservationId, link.guestId);
  }
  const guestIds = Array.from(new Set(Array.from(primaryGuestId.values())));
  const guests = guestIds.length
    ? await prisma.guest.findMany({
        where: { id: { in: guestIds } },
        select: { id: true, firstName: true, surname1: true, surname2: true, vipCode: true, loyaltyTier: true, documentNumber: true },
        take: Math.max(take, 500)
      })
    : [];
  const guestById = new Map(guests.map((g) => [g.id, g]));

  // Para "repeat_arriving": cuenta de estancias anteriores por guestId.
  let priorStaysByGuest = new Map<string, number>();
  if (guestIds.length > 0) {
    const priorLinks = await prisma.reservationGuest.findMany({
      where: {
        guestId: { in: guestIds },
        reservation: { propertyId, status: "checked_out", departureDate: { lt: dayStart } }
      },
      select: { guestId: true, reservationId: true },
      take: Math.max(take, 500)
    });
    for (const link of priorLinks) {
      priorStaysByGuest.set(link.guestId, (priorStaysByGuest.get(link.guestId) ?? 0) + 1);
    }
  }

  // Folio balances de llegadas + salidas + in-house.
  const balances = await computeBalancesForReservations(allReservationIds);
  const balanceFor = (id: string) => balances.get(id) ?? 0;
  const nameFor = (resId: string) => {
    const gid = primaryGuestId.get(resId);
    if (!gid) return "Huésped";
    return fmtName(guestById.get(gid) ?? null);
  };

  // Hora actual del día (h) para detectar no-show y late checkout.
  const hour = now.getUTCHours();

  // ----------------------------------------------------------------------
  // Detector 1: OVERBOOKING — dos reservas activas en la misma habitación
  // dentro de las próximas 14 noches.
  // ----------------------------------------------------------------------
  const overbookingHorizon = new Date(dayStart.getTime() + 14 * 24 * 60 * 60 * 1000);
  const overbookingCandidates = await prisma.reservation.findMany({
    where: {
      propertyId,
      status: { in: ["confirmed", "checked_in"] },
      assignedRoomId: { not: null },
      departureDate: { gt: dayStart },
      arrivalDate: { lt: overbookingHorizon }
    },
    select: { id: true, assignedRoomId: true, arrivalDate: true, departureDate: true },
    take: Math.max(take, 500)
  });
  const byRoom = new Map<string, Array<{ id: string; arrival: Date; departure: Date }>>();
  for (const r of overbookingCandidates) {
    if (!r.assignedRoomId) continue;
    const list = byRoom.get(r.assignedRoomId) ?? [];
    list.push({ id: r.id, arrival: r.arrivalDate, departure: r.departureDate });
    byRoom.set(r.assignedRoomId, list);
  }
  for (const [roomId, list] of byRoom.entries()) {
    if (list.length < 2) continue;
    list.sort((a, b) => a.arrival.getTime() - b.arrival.getTime());
    for (let i = 1; i < list.length; i++) {
      const prev = list[i - 1];
      const curr = list[i];
      if (curr.arrival < prev.departure) {
        const room = roomById.get(roomId);
        items.push({
          id: `overbooking_${prev.id}_${curr.id}`,
          priority: "urgent",
          kind: "overbooking",
          title: `Solape en habitación ${room?.number ?? roomId.slice(-4)}`,
          context: `Dos reservas activas en las mismas fechas. Hay que reasignar una antes de la llegada.`,
          recommendation: "Reubica la reserva más reciente a una habitación equivalente disponible.",
          reservationId: curr.id,
          roomId,
          primaryAction: { label: "Resolver conflicto", kind: "open_room_rack", payload: { roomId } }
        });
      }
    }
  }

  // ----------------------------------------------------------------------
  // Iteramos las LLEGADAS de hoy: cubre los detectores 2, 5, 6, 7, 10, 11, 12.
  // ----------------------------------------------------------------------
  for (const res of arrivalsToday) {
    if (res.status === "no_show") continue; // ya marcada
    const guestId = primaryGuestId.get(res.id);
    const guest = guestId ? guestById.get(guestId) : undefined;
    const guestName = fmtName(guest ?? null);
    const room = res.assignedRoomId ? roomById.get(res.assignedRoomId) : undefined;
    const etaHour = res.eta ? parseInt(res.eta.slice(0, 2), 10) : NaN;
    const etaLabel = res.eta ? ` · ETA ${res.eta}` : "";

    // Detector 2: no_show_risk — pasaron 19:00 y sigue confirmed.
    // No usamos `continue`: una llegada en riesgo de no-show puede ser VIP o
    // recurrente, y a recepción le importa saberlo igual.
    let noShowFlagged = false;
    if (res.status === "confirmed" && hour >= 19) {
      items.push({
        id: `no_show_${res.id}`,
        priority: "urgent",
        kind: "no_show_risk",
        title: `Posible no-show · ${guestName}`,
        context: `Llegada prevista hoy${etaLabel}. Ya pasan de las 19:00 y no ha hecho check-in.`,
        recommendation: "Llama o envía un WhatsApp para confirmar. Si no aparece antes del cierre, márcala como no-show. Si llega ahora, puedes hacer el check-in directamente.",
        reservationId: res.id,
        guestId: guest?.id,
        primaryAction: { label: "Contactar huésped", kind: "open_guest", payload: { guestId: guest?.id ?? "" } },
        secondaryActions: [
          { label: "Hacer check-in", kind: "start_checkin", payload: { reservationId: res.id } },
          { label: "Marcar no-show", kind: "mark_no_show", payload: { reservationId: res.id } }
        ]
      });
      noShowFlagged = true;
    }

    // Detector 5: unassigned_arrival — sin habitación asignada.
    // Si ya marcamos no_show_risk, evitamos duplicar el flag de "haz algo".
    if (!res.assignedRoomId && res.status === "confirmed" && !noShowFlagged) {
      const candidates = res.roomTypeId ? cleanByRoomType.get(res.roomTypeId) ?? [] : [];
      const suggestion = candidates[0];
      const roomTypeLabel = res.roomTypeId ? "" : "";
      items.push({
        id: `unassigned_${res.id}`,
        priority: "urgent",
        kind: "unassigned_arrival",
        title: `Sin habitación · ${guestName}`,
        context: `Llega hoy${etaLabel}${roomTypeLabel}. No tiene habitación asignada.`,
        recommendation: suggestion
          ? `La ${suggestion.number} está limpia y es del mismo tipo. ¿Asignar?`
          : "No hay habitaciones limpias del mismo tipo. Revisa upgrades o llama a housekeeping.",
        reservationId: res.id,
        guestId: guest?.id,
        primaryAction: suggestion
          ? { label: `Asignar ${suggestion.number}`, kind: "assign_room", payload: { reservationId: res.id, roomId: suggestion.id } }
          : { label: "Abrir reserva", kind: "open_reservation", payload: { reservationId: res.id } },
        secondaryActions: [{ label: "Ver room rack", kind: "open_room_rack", payload: { propertyId } }]
      });
      continue;
    }

    // Detector 6 + 10: checkin_blocked vs checkin_ready. Sólo si no flageamos
    // ya no_show_risk (no tiene sentido sugerir "haz check-in" cuando hay riesgo
    // de que el huésped ni siquiera aparezca).
    if (res.status === "confirmed" && room && !noShowFlagged) {
      const hk = (room.housekeepingStatus ?? "").toLowerCase();
      const isClean = hk === "clean" || hk === "inspected" || hk === "ready" || room.status === "clean";
      if (!isClean) {
        // Detector 7: housekeeping_late — si la llegada está en <2h.
        const isImminent = Number.isFinite(etaHour) && etaHour - hour <= 2 && etaHour >= hour;
        items.push({
          id: `checkin_blocked_${res.id}`,
          priority: isImminent ? "urgent" : "today",
          kind: isImminent ? "housekeeping_late" : "checkin_blocked",
          title: `Habitación no lista · ${room.number}`,
          context: `${guestName} llega${etaLabel}. La ${room.number} está en estado "${hk || "desconocido"}".`,
          recommendation: isImminent
            ? "Prioriza la limpieza con housekeeping o reasigna a una habitación limpia."
            : "Pide a housekeeping que adelante la limpieza de esta habitación.",
          reservationId: res.id,
          roomId: room.id,
          primaryAction: { label: "Avisar housekeeping", kind: "open_housekeeping", payload: { roomNumber: room.number } },
          secondaryActions: [{ label: "Buscar alternativa", kind: "open_room_rack", payload: { roomId: room.id } }]
        });
        continue;
      }
      // Detector 10: checkin_ready
      items.push({
        id: `checkin_ready_${res.id}`,
        priority: "today",
        kind: "checkin_ready",
        title: `Listo para check-in · ${guestName}`,
        context: `Hab. ${room.number}${etaLabel}. La habitación está lista.`,
        recommendation: "Pulsa para arrancar el flujo de check-in (≤ 90 s).",
        reservationId: res.id,
        guestId: guest?.id,
        roomId: room.id,
        primaryAction: { label: "Hacer check-in", kind: "start_checkin", payload: { reservationId: res.id } },
        secondaryActions: [{ label: "Ver reserva", kind: "open_reservation", payload: { reservationId: res.id } }]
      });
    }

    // Detector 11: VIP
    if (guest?.vipCode || (guest?.loyaltyTier && /platinum|gold|diamond/i.test(guest.loyaltyTier))) {
      items.push({
        id: `vip_${res.id}`,
        priority: "today",
        kind: "vip_arriving",
        title: `VIP llega hoy · ${guestName}`,
        context: `${guest.vipCode ?? guest.loyaltyTier}${etaLabel}${room ? ` · Hab. ${room.number}` : ""}.`,
        recommendation: "Confirma con dirección los detalles de bienvenida (amenity, upgrade, atención).",
        reservationId: res.id,
        guestId: guest.id,
        primaryAction: { label: "Ver perfil", kind: "open_guest", payload: { guestId: guest.id } }
      });
    }

    // Detector 12: repeat_arriving
    const priorStays = guest ? (priorStaysByGuest.get(guest.id) ?? 0) : 0;
    if (priorStays > 0) {
      items.push({
        id: `repeat_${res.id}`,
        priority: "soon",
        kind: "repeat_arriving",
        title: `Cliente recurrente · ${guestName}`,
        context: `${priorStays} estancia${priorStays === 1 ? "" : "s"} previa${priorStays === 1 ? "" : "s"}${etaLabel}.`,
        recommendation: "Reconócelo en el check-in y revisa preferencias del histórico.",
        reservationId: res.id,
        guestId: guest?.id,
        primaryAction: { label: "Ver histórico", kind: "open_guest", payload: { guestId: guest?.id ?? "" } }
      });
    }
  }

  // ----------------------------------------------------------------------
  // Iteramos SALIDAS de hoy: detectores 3, 8, 9.
  // ----------------------------------------------------------------------
  for (const res of departuresToday) {
    const guestName = nameFor(res.id);
    const room = res.assignedRoomId ? roomById.get(res.assignedRoomId) : undefined;
    const balance = balanceFor(res.id);
    const etdHour = res.etd ? parseInt(res.etd.slice(0, 2), 10) : NaN;

    if (res.status === "checked_in") {
      // Detector 3: late_checkout_overdue — pasaron las 14:00.
      if (hour >= 14) {
        items.push({
          id: `late_checkout_${res.id}`,
          priority: "urgent",
          kind: "late_checkout_overdue",
          title: `Late checkout sin resolver · Hab. ${room?.number ?? "—"}`,
          context: `${guestName} debería haber salido. Es tarde y sigue alojado.`,
          recommendation: "Confirma si autoriza late checkout (puede llevar cargo) o cierra la estancia.",
          reservationId: res.id,
          roomId: room?.id,
          primaryAction: { label: "Hacer check-out", kind: "start_checkout", payload: { reservationId: res.id } }
        });
      } else {
        // Detector 9: checkout_pending — salida hoy, sigue in-house.
        items.push({
          id: `checkout_${res.id}`,
          priority: "today",
          kind: "checkout_pending",
          title: `Check-out pendiente · Hab. ${room?.number ?? "—"}`,
          context: `${guestName} sale hoy${Number.isFinite(etdHour) ? ` · ETD ${res.etd}` : ""}.`,
          recommendation: balance > 0
            ? `Saldo pendiente €${balance.toFixed(2)}. Cobra antes de cerrar el folio.`
            : "Folio saldado. Pulsa para hacer check-out.",
          reservationId: res.id,
          roomId: room?.id,
          primaryAction: { label: "Hacer check-out", kind: "start_checkout", payload: { reservationId: res.id } }
        });
      }
    }

    // Detector 8: open_balance — salida hoy con saldo > 0 (puede solapar con checkout_pending pero
    // sólo añadimos si no se cubrió ya con late_checkout o si la reserva ya está checked_out con deuda).
    if (balance > 0 && res.status === "checked_out") {
      items.push({
        id: `open_balance_${res.id}`,
        priority: "urgent",
        kind: "open_balance",
        title: `Folio sin cobrar · Hab. ${room?.number ?? "—"}`,
        context: `${guestName} ya hizo check-out con €${balance.toFixed(2)} de saldo.`,
        recommendation: "Contacta al huésped y reclama el saldo o aplica una baja contable.",
        reservationId: res.id,
        primaryAction: { label: "Abrir folio", kind: "open_folio", payload: { reservationId: res.id } }
      });
    }
  }

  // ----------------------------------------------------------------------
  // Detector 4: INCIDENT_OPEN — work orders en habitaciones in-house.
  // ----------------------------------------------------------------------
  const inHouseRoomIds = new Set(inHouseAll.map((r) => r.assignedRoomId).filter((id): id is string => Boolean(id)));
  for (const wo of openWorkOrders as Array<{ id: string; propertyId: string; roomId?: string | null; title: string; priority?: string | null; status: string; createdAt: Date }>) {
    if (!wo.roomId) continue;
    const room = roomById.get(wo.roomId);
    if (!room) continue;
    const inHouse = inHouseRoomIds.has(wo.roomId);
    items.push({
      id: `incident_${wo.id}`,
      priority: inHouse ? "urgent" : "today",
      kind: "incident_open",
      title: `Incidencia en ${room.number} · ${wo.title}`,
      context: inHouse
        ? `Cliente actualmente alojado. Avería sigue ${wo.status}.`
        : `Habitación bloqueada por avería desde ${wo.createdAt.toISOString().slice(0, 10)}.`,
      recommendation: inHouse
        ? "Comunícate con el huésped y prioriza la reparación o reubica."
        : "Confirma con mantenimiento la fecha de devolución para liberar inventario.",
      roomId: wo.roomId,
      workOrderId: wo.id,
      primaryAction: { label: "Abrir incidencia", kind: "open_work_order", payload: { workOrderId: wo.id } }
    });
  }

  // ----------------------------------------------------------------------
  // Ordenación final: priority → kind → dueAt.
  // ----------------------------------------------------------------------
  items.sort((a, b) => {
    const w = priorityWeight(a.priority) - priorityWeight(b.priority);
    if (w !== 0) return w;
    const k = kindWeight(a.kind) - kindWeight(b.kind);
    if (k !== 0) return k;
    return (a.dueAt ?? "").localeCompare(b.dueAt ?? "");
  });

  // Counts y summary.
  const counts = KIND_ORDER.reduce((acc, k) => { acc[k] = 0; return acc; }, {} as Record<FrontDeskQueueKind, number>);
  for (const it of items) counts[it.kind]++;
  const summary = {
    urgent: items.filter((i) => i.priority === "urgent").length,
    today: items.filter((i) => i.priority === "today").length,
    soon: items.filter((i) => i.priority === "soon").length,
    total: items.length
  };

  return { generatedAt: now.toISOString(), items, counts, summary };
}
