// Maintenance Mobile service — cola priorizada de work orders para el técnico.
//
// Directriz HotelOS (Nov 2026):
//   "Mantenimiento mobile-first. Vista para el técnico que carga tablet/móvil.
//    Averías, habitaciones bloqueadas, SLA, prioridad, fotos, estado."
//
// Prioridad calculada:
//   urgent  — emergency O blocksRoom + habitación in-house
//   high    — blocksRoom (cuarto bloqueado por avería) O dueDate vencido
//   normal  — work orders activos normales
//   low     — preventive / tareas planificadas

import { prisma } from "@hotelos/database";

export type MaintMobilePriority = "urgent" | "high" | "normal" | "low";

export type MaintMobileItem = {
  workOrderId: string;
  title: string;
  description?: string;
  priority: MaintMobilePriority;
  rawPriority: string;          // "emergency" / "urgent" / "normal" / "preventive"
  status: string;
  blocksRoom: boolean;
  roomId?: string;
  roomNumber?: string;
  floor?: string;
  guestInHouse?: string;        // si hay huésped alojado en la habitación
  ageMinutes: number;
  dueDate?: string;
  dueOverdue: boolean;
  assignedTo?: string;
  reason: string;                // texto natural del por qué de la prioridad
  mediaCount: number;
};

export type MaintMobileResult = {
  generatedAt: string;
  summary: { urgent: number; high: number; normal: number; low: number; total: number; blockedRooms: number };
  items: MaintMobileItem[];
};

function priorityWeight(p: MaintMobilePriority): number {
  if (p === "urgent") return 0;
  if (p === "high") return 1;
  if (p === "normal") return 2;
  return 3;
}

export async function buildMaintenanceMobile(input: { propertyId: string }): Promise<MaintMobileResult> {
  const propertyId = input.propertyId;
  const now = new Date();

  const [wos, inHouse] = await Promise.all([
    prisma.workOrder.findMany({
      where: { propertyId, status: { in: ["open", "in_progress"] } },
      orderBy: { createdAt: "asc" }
    }),
    prisma.reservation.findMany({
      where: { propertyId, status: "checked_in" },
      select: { id: true, assignedRoomId: true }
    })
  ]);
  // Media counts via separate query — agrupado por workOrderId entre los wos activos.
  const woIds = wos.map((w) => w.id);
  const mediaCounts = woIds.length
    ? await prisma.workOrderMedia.groupBy({
        by: ["workOrderId"],
        where: { workOrderId: { in: woIds } },
        _count: { workOrderId: true }
      }).catch(() => [] as Array<{ workOrderId: string; _count: { workOrderId: number } }>)
    : [];

  const inHouseRoomIds = new Set(
    inHouse.map((r) => r.assignedRoomId).filter((id): id is string => Boolean(id))
  );
  // Guest name por habitación (best-effort, opcional)
  const inHouseResIds = inHouse.map((r) => r.id);
  const guestLinks = inHouseResIds.length
    ? await prisma.reservationGuest.findMany({
        where: { reservationId: { in: inHouseResIds }, isPrimary: true },
        select: { reservationId: true, guestId: true }
      })
    : [];
  const guestIds = Array.from(new Set(guestLinks.map((l) => l.guestId)));
  const guests = guestIds.length
    ? await prisma.guest.findMany({
        where: { id: { in: guestIds } },
        select: { id: true, firstName: true, surname1: true }
      })
    : [];
  const guestByReservation = new Map(guestLinks.map((l) => [l.reservationId, l.guestId]));
  const guestById = new Map(guests.map((g) => [g.id, g]));
  const guestNameByRoom = new Map<string, string>();
  for (const r of inHouse) {
    if (!r.assignedRoomId) continue;
    const gid = guestByReservation.get(r.id);
    if (!gid) continue;
    const g = guestById.get(gid);
    if (!g) continue;
    guestNameByRoom.set(r.assignedRoomId, [g.firstName, g.surname1].filter(Boolean).join(" ") || "Huésped");
  }

  const roomIds = Array.from(new Set(wos.map((w) => w.roomId).filter((id): id is string => Boolean(id))));
  const rooms = roomIds.length
    ? await prisma.room.findMany({ where: { id: { in: roomIds } }, select: { id: true, number: true, floor: true } })
    : [];
  const roomById = new Map(rooms.map((r) => [r.id, r]));

  const mediaByWo = new Map(
    mediaCounts.map((m) => [m.workOrderId, (m._count as { workOrderId: number }).workOrderId])
  );

  const items: MaintMobileItem[] = wos.map((w) => {
    const room = w.roomId ? roomById.get(w.roomId) : undefined;
    const guestInHouse = w.roomId ? guestNameByRoom.get(w.roomId) : undefined;
    const isGuestImpact = Boolean(guestInHouse);
    const ageMs = now.getTime() - w.createdAt.getTime();
    const ageMinutes = Math.floor(ageMs / 60000);
    const dueOverdue = w.dueDate ? w.dueDate.getTime() < now.getTime() : false;
    const raw = (w.priority ?? "normal").toLowerCase();

    let priority: MaintMobilePriority;
    let reason: string;
    if (raw === "emergency" || (w.blocksRoom && isGuestImpact)) {
      priority = "urgent";
      reason = raw === "emergency"
        ? "Emergencia"
        : "Bloquea habitación con huésped dentro";
    } else if (w.blocksRoom || dueOverdue || raw === "urgent") {
      priority = "high";
      reason = w.blocksRoom
        ? "Habitación bloqueada por avería"
        : dueOverdue
          ? "Plazo (SLA) vencido"
          : "Marcada urgente";
    } else if (raw === "preventive") {
      priority = "low";
      reason = "Mantenimiento preventivo planificado";
    } else {
      priority = "normal";
      reason = "En cola";
    }

    return {
      workOrderId: w.id,
      title: w.title,
      description: w.description ?? undefined,
      priority,
      rawPriority: raw,
      status: w.status,
      blocksRoom: w.blocksRoom,
      roomId: w.roomId ?? undefined,
      roomNumber: room?.number,
      floor: room?.floor ?? undefined,
      guestInHouse,
      ageMinutes,
      dueDate: w.dueDate?.toISOString(),
      dueOverdue,
      assignedTo: w.assignedTo ?? undefined,
      reason,
      mediaCount: mediaByWo.get(w.id) ?? 0
    };
  });

  items.sort((a, b) => {
    const w = priorityWeight(a.priority) - priorityWeight(b.priority);
    if (w !== 0) return w;
    return a.ageMinutes - b.ageMinutes;
  });

  const summary = {
    urgent: items.filter((i) => i.priority === "urgent").length,
    high: items.filter((i) => i.priority === "high").length,
    normal: items.filter((i) => i.priority === "normal").length,
    low: items.filter((i) => i.priority === "low").length,
    total: items.length,
    blockedRooms: items.filter((i) => i.blocksRoom).length
  };

  return { generatedAt: now.toISOString(), summary, items };
}
