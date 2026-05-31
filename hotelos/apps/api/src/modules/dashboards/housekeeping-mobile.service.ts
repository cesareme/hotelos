// Housekeeping Mobile service — cola priorizada de habitaciones a limpiar
// para el personal de pisos en su móvil o tablet.
//
// Directriz HotelOS (Nov 2026):
//   "Housekeeping debe ser tiempo real, no módulo secundario. HotelOS debe
//    eliminar WhatsApp, llamadas y Excel como herramientas de coordinación.
//    Mobile-first para operación."
//
// Algoritmo de prioridad:
//   urgent  — habitación sucia o stayover con llegada en < 2h
//   high    — departure de hoy (cliente ya salió, "salida sucia")
//   normal  — stayover (cliente sigue, requires daily clean) o dirty sin
//             llegada próxima
//   low     — ya está clean/inspected pero hay tareas pendientes
//
// El item incluye notas activas (HK events + work orders) para que el camarero
// sepa qué buscar antes de entrar (cama extra, minibar, incidencia, etc.).

import { prisma } from "@hotelos/database";

export type HkMobilePriority = "urgent" | "high" | "normal" | "low";

export type HkMobileRoom = {
  roomId: string;
  roomNumber: string;
  floor?: string;
  roomTypeName?: string;
  status: string;
  housekeepingStatus?: string;
  priority: HkMobilePriority;
  // Contexto operacional
  reason: string;          // "Llegada en 1h" / "Salida sucia" / "Stayover" / etc.
  nextArrivalEta?: string; // "16:00"
  nextArrivalGuest?: string;
  isVipNext?: boolean;
  currentGuest?: string;   // si stayover
  specialRequest?: string;
  // Tarea HK actual
  taskId?: string;
  taskStatus?: string;
  taskType?: string;
  assignedTo?: string;
  // Indicadores
  openIncidents: number;
  lastEventAt?: string;
  lastEventNote?: string;
};

export type HkMobileResult = {
  generatedAt: string;
  summary: {
    urgent: number;
    high: number;
    normal: number;
    low: number;
    total: number;
  };
  rooms: HkMobileRoom[];
};

function startOfDayUtc(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

function priorityWeight(p: HkMobilePriority): number {
  if (p === "urgent") return 0;
  if (p === "high") return 1;
  if (p === "normal") return 2;
  return 3;
}

export async function buildHousekeepingMobile(input: { propertyId: string }): Promise<HkMobileResult> {
  const propertyId = input.propertyId;
  const now = new Date();
  const today = startOfDayUtc();
  const tomorrow = new Date(today.getTime() + 86400000);

  const [rooms, roomTypes, arrivals, departures, inHouse, openTasks, workOrders] = await Promise.all([
    prisma.room.findMany({ where: { propertyId, active: true } }),
    prisma.roomType.findMany({ where: { propertyId } }),
    prisma.reservation.findMany({
      where: {
        propertyId,
        arrivalDate: { gte: today, lt: tomorrow },
        status: { in: ["confirmed", "checked_in"] }
      },
      orderBy: { eta: "asc" }
    }),
    prisma.reservation.findMany({
      where: {
        propertyId,
        departureDate: { gte: today, lt: tomorrow },
        status: { in: ["checked_in", "checked_out"] }
      }
    }),
    prisma.reservation.findMany({
      where: { propertyId, status: "checked_in" }
    }),
    prisma.housekeepingTask.findMany({
      where: { propertyId, status: { in: ["pending", "assigned", "in_progress"] } },
      orderBy: { createdAt: "desc" }
    }),
    prisma.workOrder.findMany({
      where: { propertyId, status: { in: ["open", "in_progress"] } },
      select: { id: true, roomId: true, title: true }
    }).catch(() => [])
  ]);

  const roomTypeById = new Map(roomTypes.map((t) => [t.id, t]));
  const roomById = new Map(rooms.map((r) => [r.id, r]));

  // Index reservas por roomId.
  const arrivalByRoom = new Map<string, (typeof arrivals)[number]>();
  for (const r of arrivals) if (r.assignedRoomId && !arrivalByRoom.has(r.assignedRoomId)) arrivalByRoom.set(r.assignedRoomId, r);
  const departureByRoom = new Map<string, (typeof departures)[number]>();
  for (const r of departures) if (r.assignedRoomId && !departureByRoom.has(r.assignedRoomId)) departureByRoom.set(r.assignedRoomId, r);
  const inHouseByRoom = new Map<string, (typeof inHouse)[number]>();
  for (const r of inHouse) if (r.assignedRoomId) inHouseByRoom.set(r.assignedRoomId, r);

  // Guests primarios para mostrar nombre del huésped.
  const allResIds = [
    ...arrivals.map((r) => r.id),
    ...inHouse.map((r) => r.id)
  ];
  const links = allResIds.length
    ? await prisma.reservationGuest.findMany({
        where: { reservationId: { in: allResIds } },
        select: { reservationId: true, guestId: true, isPrimary: true }
      })
    : [];
  const primaryGuestByReservation = new Map<string, string>();
  for (const link of links) {
    if (link.isPrimary && !primaryGuestByReservation.has(link.reservationId)) primaryGuestByReservation.set(link.reservationId, link.guestId);
  }
  for (const link of links) {
    if (!primaryGuestByReservation.has(link.reservationId)) primaryGuestByReservation.set(link.reservationId, link.guestId);
  }
  const guestIds = Array.from(new Set(Array.from(primaryGuestByReservation.values())));
  const guests = guestIds.length
    ? await prisma.guest.findMany({
        where: { id: { in: guestIds } },
        select: { id: true, firstName: true, surname1: true, vipCode: true, loyaltyTier: true }
      })
    : [];
  const guestById = new Map(guests.map((g) => [g.id, g]));
  const nameOf = (resId: string): string | undefined => {
    const gid = primaryGuestByReservation.get(resId);
    if (!gid) return undefined;
    const g = guestById.get(gid);
    if (!g) return undefined;
    return [g.firstName, g.surname1].filter(Boolean).join(" ");
  };
  const vipOf = (resId: string): boolean => {
    const gid = primaryGuestByReservation.get(resId);
    if (!gid) return false;
    const g = guestById.get(gid);
    if (!g) return false;
    return Boolean(g.vipCode || (g.loyaltyTier && /platinum|gold|diamond/i.test(g.loyaltyTier)));
  };

  // Index tasks + events por roomId.
  const taskByRoom = new Map<string, (typeof openTasks)[number]>();
  for (const t of openTasks) if (!taskByRoom.has(t.roomId)) taskByRoom.set(t.roomId, t);

  const woByRoom = new Map<string, number>();
  for (const wo of workOrders) {
    if (!wo.roomId) continue;
    woByRoom.set(wo.roomId, (woByRoom.get(wo.roomId) ?? 0) + 1);
  }

  // Último evento por task.
  const taskIds = openTasks.map((t) => t.id);
  const events = taskIds.length
    ? await prisma.housekeepingEvent.findMany({
        where: { taskId: { in: taskIds } },
        orderBy: { createdAt: "desc" }
      })
    : [];
  const lastEventByTask = new Map<string, (typeof events)[number]>();
  for (const e of events) if (!lastEventByTask.has(e.taskId)) lastEventByTask.set(e.taskId, e);

  const hourNow = now.getUTCHours();
  const minuteNow = now.getUTCMinutes();
  const nowMinutes = hourNow * 60 + minuteNow;

  // Construir rooms con prioridad.
  const items: HkMobileRoom[] = [];
  for (const room of rooms) {
    const hk = (room.housekeepingStatus ?? "").toLowerCase();
    const isStayover = hk === "stayover";
    // "stayover" no es propiamente clean (requiere limpieza diaria) ni dirty
    // (la cama no se rehace, no se cambia todo). Lo tratamos como necesita HK.
    const isClean = !isStayover && (hk === "clean" || hk === "inspected" || hk === "ready" || (room.status === "clean" && !hk));
    const isOoo = room.status === "out_of_order" || hk === "out_of_order";
    if (isOoo) continue; // las FOS no son tarea de pisos

    const arrival = arrivalByRoom.get(room.id);
    const departure = departureByRoom.get(room.id);
    const inHouseRes = inHouseByRoom.get(room.id);
    const stayover = inHouseRes && !departure ? inHouseRes : undefined;
    const task = taskByRoom.get(room.id);
    const lastEvent = task ? lastEventByTask.get(task.id) : undefined;
    const openIncidents = woByRoom.get(room.id) ?? 0;

    // ETA del próximo huésped en minutos del día.
    let etaMinutes = NaN;
    if (arrival?.eta) {
      const m = arrival.eta.match(/^(\d{2}):(\d{2})/);
      if (m) etaMinutes = parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
    }
    const minutesUntilArrival = Number.isFinite(etaMinutes) ? etaMinutes - nowMinutes : Infinity;

    let priority: HkMobilePriority = "low";
    let reason = "Sin prioridad";
    if (!isClean) {
      if (arrival && minutesUntilArrival <= 120) {
        priority = "urgent";
        reason = arrival.eta ? `Llega en ${minutesUntilArrival <= 0 ? "menos de 0min" : `${minutesUntilArrival}min`} (ETA ${arrival.eta})` : "Llegada inminente";
      } else if (departure) {
        priority = "high";
        reason = "Salida sucia · cliente ya marchó";
      } else if (stayover) {
        priority = "normal";
        reason = "Stayover · limpieza diaria";
      } else if (arrival) {
        priority = "normal";
        reason = `Llegada hoy${arrival.eta ? ` · ETA ${arrival.eta}` : ""}`;
      } else {
        priority = "normal";
        reason = "Habitación sucia sin asignar";
      }
    } else if (task) {
      priority = "low";
      reason = `Tarea pendiente · ${task.taskType ?? "limpieza"}`;
    } else if (openIncidents > 0) {
      priority = "low";
      reason = `Incidencia abierta`;
    } else {
      // Habitación limpia sin tarea ni incidencia → no entra en la cola.
      continue;
    }

    const focusReservation = arrival ?? stayover;
    const specialRequest = focusReservation?.specialRequests ?? focusReservation?.notes ?? undefined;

    items.push({
      roomId: room.id,
      roomNumber: room.number,
      floor: room.floor ?? undefined,
      roomTypeName: room.roomTypeId ? roomTypeById.get(room.roomTypeId)?.name : undefined,
      status: String(room.status),
      housekeepingStatus: room.housekeepingStatus ?? undefined,
      priority,
      reason,
      nextArrivalEta: arrival?.eta ?? undefined,
      nextArrivalGuest: arrival ? nameOf(arrival.id) : undefined,
      isVipNext: arrival ? vipOf(arrival.id) : false,
      currentGuest: stayover ? nameOf(stayover.id) : undefined,
      specialRequest,
      taskId: task?.id,
      taskStatus: task?.status,
      taskType: task?.taskType,
      assignedTo: task?.assignedTo ?? undefined,
      openIncidents,
      lastEventAt: lastEvent?.createdAt.toISOString(),
      lastEventNote: lastEvent?.note ?? undefined
    });
  }

  // Ordena por priority + ETA si urgente.
  items.sort((a, b) => {
    const w = priorityWeight(a.priority) - priorityWeight(b.priority);
    if (w !== 0) return w;
    // Dentro de urgent, menor ETA antes.
    if (a.priority === "urgent" && b.priority === "urgent") {
      return (a.nextArrivalEta ?? "99:99").localeCompare(b.nextArrivalEta ?? "99:99");
    }
    return a.roomNumber.localeCompare(b.roomNumber, undefined, { numeric: true });
  });

  const summary = {
    urgent: items.filter((i) => i.priority === "urgent").length,
    high: items.filter((i) => i.priority === "high").length,
    normal: items.filter((i) => i.priority === "normal").length,
    low: items.filter((i) => i.priority === "low").length,
    total: items.length
  };

  return { generatedAt: now.toISOString(), summary, rooms: items };
}
