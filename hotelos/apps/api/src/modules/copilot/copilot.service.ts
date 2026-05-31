// Front Desk Copilot — IA operativa para recepción.
//
// Directriz HotelOS (Nov 2026):
//   "La IA de HotelOS debe ser operativa. No queremos una IA decorativa.
//    Queremos un copiloto de recepción. Consulta + recomendación + acción."
//
// 10 intents reconocidos (determinista por keywords, sin necesidad de LLM):
//   1.  arrivals_no_clean_room       · llegadas con habitación sucia
//   2.  arrivals_pending_balance     · llegadas con saldo pendiente
//   3.  rooms_ready_for_delivery     · habitaciones que se pueden entregar ya
//   4.  reservations_at_risk         · reservas en riesgo (no_show + late + impagos)
//   5.  shift_summary                · resumen del turno anterior
//   6.  late_checkouts               · quién pidió late checkout
//   7.  rooms_blocked                · habitaciones bloqueadas y por qué
//   8.  vips_arriving                · VIPs que llegan hoy
//   9.  open_incidents               · incidencias abiertas
//   10. overdue_hk_tasks             · tareas HK retrasadas
//
// Cada respuesta devuelve:
//   - answer (texto natural)
//   - items (lista accionable de habitaciones/reservas/huéspedes)
//   - suggestions (acciones recomendadas con kind+payload tipo action queue)

import { prisma } from "@hotelos/database";
import { computeBalancesForReservations } from "../folio/folio-balance.service.js";

export type CopilotIntent =
  | "arrivals_no_clean_room"
  | "arrivals_pending_balance"
  | "rooms_ready_for_delivery"
  | "reservations_at_risk"
  | "shift_summary"
  | "late_checkouts"
  | "rooms_blocked"
  | "vips_arriving"
  | "open_incidents"
  | "overdue_hk_tasks"
  | "unknown";

export type CopilotActionKind =
  | "open_reservation"
  | "open_guest"
  | "open_room_rack"
  | "start_checkin"
  | "start_checkout"
  | "assign_room"
  | "mark_no_show"
  | "open_work_order"
  | "open_housekeeping";

export type CopilotAction = {
  label: string;
  kind: CopilotActionKind;
  payload?: Record<string, string | number | boolean>;
};

export type CopilotItem = {
  primary: string;       // p.ej. "Hab. 305 · Pierre Smith"
  secondary?: string;    // p.ej. "Sale hoy · saldo €245"
  badge?: string;        // p.ej. "VIP", "Late"
  actions?: CopilotAction[];
};

export type CopilotAnswer = {
  intent: CopilotIntent;
  question: string;
  answer: string;                     // resumen en lenguaje natural
  items: CopilotItem[];               // 0..N filas accionables
  suggestions: CopilotAction[];       // acciones agregadas a nivel respuesta
  generatedAt: string;
  source: string;                     // qué consulta lo respaldó
};

// ============================================================== intent detection

const INTENT_KEYWORDS: Record<CopilotIntent, string[]> = {
  arrivals_no_clean_room: ["sin limpiar", "no está lista", "sin habitación lista", "habitación sucia", "habitacion sucia", "no limpia"],
  arrivals_pending_balance: ["saldo pendiente", "deuda", "deben", "impago", "no han pagado"],
  rooms_ready_for_delivery: ["entregar", "puedo dar", "listas", "qué habitaciones puedo", "que habitaciones puedo", "ready", "puedo asignar"],
  reservations_at_risk: ["riesgo", "problema", "alerta", "en peligro"],
  shift_summary: ["turno anterior", "resume el turno", "qué pasó", "que paso", "resumen del día", "resumen anterior"],
  late_checkouts: ["late checkout", "salida tardía", "salida tarde", "salida posterior"],
  rooms_blocked: ["bloqueadas", "bloqueada", "fuera de servicio", "fuera servicio", "ooo", "no se pueden vender"],
  vips_arriving: ["vip", "huésped vip", "v.i.p", "premium", "diamond", "platinum"],
  open_incidents: ["incidencias", "averías", "averias", "abiertas", "abiertos"],
  overdue_hk_tasks: ["housekeeping retrasadas", "limpieza retrasada", "pisos retrasados", "tareas retrasadas", "hk retrasadas"],
  unknown: []
};

export function detectIntent(question: string): CopilotIntent {
  const q = question.toLowerCase();
  let best: CopilotIntent = "unknown";
  let bestScore = 0;
  for (const intent of Object.keys(INTENT_KEYWORDS) as CopilotIntent[]) {
    if (intent === "unknown") continue;
    const score = INTENT_KEYWORDS[intent].reduce((s, kw) => s + (q.includes(kw) ? kw.length : 0), 0);
    if (score > bestScore) {
      bestScore = score;
      best = intent;
    }
  }
  return best;
}

// ============================================================== helpers

function startOfDayUtc(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

function fmtName(g: { firstName?: string | null; surname1?: string | null; surname2?: string | null } | null): string {
  if (!g) return "Huésped";
  const parts = [g.firstName, g.surname1, g.surname2].filter((p): p is string => Boolean(p && p.trim()));
  return parts.length > 0 ? parts.join(" ") : "Huésped";
}

function isCleanHk(value?: string | null, fallbackStatus?: string): boolean {
  const v = (value ?? "").toLowerCase();
  if (v === "clean" || v === "inspected" || v === "ready") return true;
  if (!v && fallbackStatus === "clean") return true;
  return false;
}

// ============================================================== resolvers

type Ctx = { propertyId: string };

async function listArrivalsNoCleanRoom(ctx: Ctx): Promise<CopilotAnswer> {
  const today = startOfDayUtc();
  const tomorrow = new Date(today.getTime() + 86400000);
  const arrivals = await prisma.reservation.findMany({
    where: {
      propertyId: ctx.propertyId,
      arrivalDate: { gte: today, lt: tomorrow },
      status: "confirmed",
      assignedRoomId: { not: null }
    },
    orderBy: { eta: "asc" }
  });
  const roomIds = arrivals.map((r) => r.assignedRoomId).filter((id): id is string => Boolean(id));
  const rooms = roomIds.length
    ? await prisma.room.findMany({ where: { id: { in: roomIds } } })
    : [];
  const roomById = new Map(rooms.map((r) => [r.id, r]));
  const dirtyArrivals = arrivals.filter((r) => {
    const room = r.assignedRoomId ? roomById.get(r.assignedRoomId) : undefined;
    return room && !isCleanHk(room.housekeepingStatus, room.status);
  });

  // N+1 fix: batch fetch reservation→primary guest links and the guests themselves
  // instead of issuing one findFirst + one findUnique per arrival. Saves 2*N round-trips.
  const dirtyIds = dirtyArrivals.map((r) => r.id);
  const primaryLinks = dirtyIds.length
    ? await prisma.reservationGuest.findMany({
        where: { reservationId: { in: dirtyIds }, isPrimary: true },
        select: { reservationId: true, guestId: true }
      })
    : [];
  const guestIdByReservation = new Map(primaryLinks.map((l) => [l.reservationId, l.guestId]));
  const dirtyGuestIds = Array.from(new Set(primaryLinks.map((l) => l.guestId)));
  const dirtyGuests = dirtyGuestIds.length
    ? await prisma.guest.findMany({
        where: { id: { in: dirtyGuestIds } },
        select: { id: true, firstName: true, surname1: true, surname2: true }
      })
    : [];
  const dirtyGuestById = new Map(dirtyGuests.map((g) => [g.id, g]));

  const items: CopilotItem[] = dirtyArrivals.map((r) => {
    const room = r.assignedRoomId ? roomById.get(r.assignedRoomId) : undefined;
    const guestId = guestIdByReservation.get(r.id);
    const guest = guestId ? dirtyGuestById.get(guestId) ?? null : null;
    return {
      primary: `Hab. ${room?.number ?? "?"} · ${fmtName(guest)}`,
      secondary: `ETA ${r.eta ?? "?"} · estado HK: ${room?.housekeepingStatus ?? "?"}`,
      badge: r.eta ? `ETA ${r.eta}` : undefined,
      actions: [
        { label: "Avisar HK", kind: "open_housekeeping" },
        { label: "Ver reserva", kind: "open_reservation", payload: { reservationId: r.id } }
      ]
    } satisfies CopilotItem;
  });

  return {
    intent: "arrivals_no_clean_room",
    question: "",
    answer:
      dirtyArrivals.length === 0
        ? "Todas las llegadas con habitación asignada tienen la habitación lista."
        : `${dirtyArrivals.length} llegada${dirtyArrivals.length === 1 ? "" : "s"} con habitación sin limpiar.`,
    items,
    suggestions: dirtyArrivals.length > 0
      ? [{ label: "Abrir housekeeping móvil", kind: "open_housekeeping" }]
      : [],
    generatedAt: new Date().toISOString(),
    source: "reservation+room"
  };
}

async function listArrivalsPendingBalance(ctx: Ctx): Promise<CopilotAnswer> {
  const today = startOfDayUtc();
  const tomorrow = new Date(today.getTime() + 86400000);
  const arrivals = await prisma.reservation.findMany({
    where: {
      propertyId: ctx.propertyId,
      arrivalDate: { gte: today, lt: tomorrow },
      status: { in: ["confirmed", "checked_in"] }
    }
  });
  const balances = await computeBalancesForReservations(arrivals.map((r) => r.id));
  const withDebt = arrivals.filter((r) => (balances.get(r.id) ?? 0) > 0.01);

  // N+1 fix: batch fetch reservation→primary guest links + guests in two queries
  // instead of running findFirst + findUnique once per pending-balance arrival.
  const debtResIds = withDebt.map((r) => r.id);
  const debtLinks = debtResIds.length
    ? await prisma.reservationGuest.findMany({
        where: { reservationId: { in: debtResIds }, isPrimary: true },
        select: { reservationId: true, guestId: true }
      })
    : [];
  const debtGuestByReservation = new Map(debtLinks.map((l) => [l.reservationId, l.guestId]));
  const debtGuestIds = Array.from(new Set(debtLinks.map((l) => l.guestId)));
  const debtGuests = debtGuestIds.length
    ? await prisma.guest.findMany({
        where: { id: { in: debtGuestIds } },
        select: { id: true, firstName: true, surname1: true, surname2: true }
      })
    : [];
  const debtGuestById = new Map(debtGuests.map((g) => [g.id, g]));

  const items: CopilotItem[] = withDebt.map((r) => {
    const guestId = debtGuestByReservation.get(r.id);
    const guest = guestId ? debtGuestById.get(guestId) ?? null : null;
    const balance = balances.get(r.id) ?? 0;
    return {
      primary: `${fmtName(guest)} · ${r.code}`,
      secondary: `Saldo €${balance.toFixed(2)} · ETA ${r.eta ?? "?"}`,
      badge: `€${balance.toFixed(2)}`,
      actions: [{ label: "Ver folio", kind: "open_reservation", payload: { reservationId: r.id } }]
    } satisfies CopilotItem;
  });

  return {
    intent: "arrivals_pending_balance",
    question: "",
    answer:
      withDebt.length === 0
        ? "Todas las llegadas de hoy tienen el depósito al día."
        : `${withDebt.length} llegada${withDebt.length === 1 ? "" : "s"} con saldo pendiente. Cobra antes del check-in para evitar fricción.`,
    items,
    suggestions: [],
    generatedAt: new Date().toISOString(),
    source: "reservation+folio"
  };
}

async function listRoomsReadyForDelivery(ctx: Ctx): Promise<CopilotAnswer> {
  const rooms = await prisma.room.findMany({ where: { propertyId: ctx.propertyId, active: true, sellable: true } });
  const inHouse = await prisma.reservation.findMany({
    where: { propertyId: ctx.propertyId, status: "checked_in" },
    select: { assignedRoomId: true }
  });
  const occupied = new Set(inHouse.map((r) => r.assignedRoomId).filter((x): x is string => Boolean(x)));
  const ready = rooms.filter((r) => !occupied.has(r.id) && isCleanHk(r.housekeepingStatus, r.status) && r.status !== "out_of_order");

  // Agrupa por tipo
  const byType = new Map<string, typeof rooms>();
  for (const r of ready) {
    if (!r.roomTypeId) continue;
    const list = byType.get(r.roomTypeId) ?? [];
    list.push(r);
    byType.set(r.roomTypeId, list);
  }
  const roomTypes = await prisma.roomType.findMany({ where: { propertyId: ctx.propertyId } });
  const items: CopilotItem[] = Array.from(byType.entries()).map(([roomTypeId, list]) => {
    const rt = roomTypes.find((t) => t.id === roomTypeId);
    const sampleNumbers = list.slice(0, 6).map((r) => r.number).join(", ");
    return {
      primary: `${rt?.name ?? roomTypeId} · ${list.length} disponible${list.length === 1 ? "" : "s"}`,
      secondary: `Habitaciones: ${sampleNumbers}${list.length > 6 ? `… (+${list.length - 6})` : ""}`,
      badge: `${list.length}`
    };
  });
  return {
    intent: "rooms_ready_for_delivery",
    question: "",
    answer: `${ready.length} habitaciones listas para entregar ahora mismo, repartidas en ${byType.size} tipo${byType.size === 1 ? "" : "s"}.`,
    items,
    suggestions: ready.length > 0 ? [{ label: "Abrir Room Rack", kind: "open_room_rack" }] : [],
    generatedAt: new Date().toISOString(),
    source: "room"
  };
}

async function listReservationsAtRisk(ctx: Ctx): Promise<CopilotAnswer> {
  const today = startOfDayUtc();
  const tomorrow = new Date(today.getTime() + 86400000);
  const now = new Date();
  const hour = now.getUTCHours();
  // No-show risk: confirmed con llegada hoy + ya pasaron 19:00
  const noShowRisk = hour >= 19
    ? await prisma.reservation.findMany({
        where: { propertyId: ctx.propertyId, arrivalDate: { gte: today, lt: tomorrow }, status: "confirmed" }
      })
    : [];
  // Late checkout: checked_in con salida hoy + pasaron 14:00
  const lateCheckout = hour >= 14
    ? await prisma.reservation.findMany({
        where: { propertyId: ctx.propertyId, departureDate: { gte: today, lt: tomorrow }, status: "checked_in" }
      })
    : [];
  const items: CopilotItem[] = [];
  for (const r of noShowRisk) {
    items.push({
      primary: `${r.code} · posible no-show`,
      secondary: `Llegada hoy · ETA ${r.eta ?? "?"}`,
      badge: "no-show",
      actions: [
        { label: "Ver reserva", kind: "open_reservation", payload: { reservationId: r.id } },
        { label: "Marcar no-show", kind: "mark_no_show", payload: { reservationId: r.id } }
      ]
    });
  }
  for (const r of lateCheckout) {
    items.push({
      primary: `${r.code} · late check-out`,
      secondary: `Salida hoy · no se ha cerrado el folio`,
      badge: "late",
      actions: [
        { label: "Hacer check-out", kind: "start_checkout", payload: { reservationId: r.id } }
      ]
    });
  }
  return {
    intent: "reservations_at_risk",
    question: "",
    answer:
      items.length === 0
        ? "Sin reservas en riesgo ahora mismo."
        : `${items.length} reserva${items.length === 1 ? "" : "s"} en riesgo: ${noShowRisk.length} posibles no-show + ${lateCheckout.length} late check-out sin cerrar.`,
    items,
    suggestions: [],
    generatedAt: new Date().toISOString(),
    source: "reservation"
  };
}

async function shiftSummary(ctx: Ctx): Promise<CopilotAnswer> {
  const today = startOfDayUtc();
  const tomorrow = new Date(today.getTime() + 86400000);
  const [arrivals, departures, inHouseNow, cancelledToday, noShowToday] = await Promise.all([
    prisma.reservation.count({ where: { propertyId: ctx.propertyId, arrivalDate: { gte: today, lt: tomorrow }, status: { in: ["confirmed", "checked_in", "checked_out"] } } }),
    prisma.reservation.count({ where: { propertyId: ctx.propertyId, departureDate: { gte: today, lt: tomorrow }, status: { in: ["checked_in", "checked_out"] } } }),
    prisma.reservation.count({ where: { propertyId: ctx.propertyId, status: "checked_in" } }),
    prisma.reservation.count({ where: { propertyId: ctx.propertyId, status: "cancelled", arrivalDate: { gte: today, lt: tomorrow } } }),
    prisma.reservation.count({ where: { propertyId: ctx.propertyId, status: "no_show", arrivalDate: { gte: today, lt: tomorrow } } })
  ]);
  const revenueAgg = await prisma.folioLine.aggregate({
    where: { folio: { reservation: { propertyId: ctx.propertyId } }, postedAt: { gte: today, lt: tomorrow } },
    _sum: { total: true }
  });
  const revenue = Number(revenueAgg._sum.total ?? 0);
  return {
    intent: "shift_summary",
    question: "",
    answer: `Resumen del día: ${arrivals} llegadas · ${departures} salidas · ${inHouseNow} alojados ahora · ${cancelledToday} cancelaciones · ${noShowToday} no-shows · €${Math.round(revenue)} ingresos del día.`,
    items: [
      { primary: `Llegadas`, secondary: `${arrivals} reservas`, badge: String(arrivals) },
      { primary: `Salidas`, secondary: `${departures} reservas`, badge: String(departures) },
      { primary: `En casa ahora`, secondary: `${inHouseNow} estancias activas`, badge: String(inHouseNow) },
      { primary: `Cancelaciones del día`, badge: String(cancelledToday) },
      { primary: `No-shows del día`, badge: String(noShowToday) },
      { primary: `Ingresos`, secondary: `Líneas de folio posteadas hoy`, badge: `€${Math.round(revenue)}` }
    ],
    suggestions: [],
    generatedAt: new Date().toISOString(),
    source: "aggregated"
  };
}

async function listLateCheckouts(ctx: Ctx): Promise<CopilotAnswer> {
  const today = startOfDayUtc();
  const tomorrow = new Date(today.getTime() + 86400000);
  const candidates = await prisma.reservation.findMany({
    where: {
      propertyId: ctx.propertyId,
      departureDate: { gte: today, lt: tomorrow },
      status: "checked_in"
    }
  });
  // N+1 fix: batch fetch rooms, primary-guest links and guests for all late-checkout
  // candidates in three queries instead of 3*N calls.
  const candidateRoomIds = candidates.map((r) => r.assignedRoomId).filter((id): id is string => Boolean(id));
  const candidateRooms = candidateRoomIds.length
    ? await prisma.room.findMany({
        where: { id: { in: candidateRoomIds } },
        select: { id: true, number: true }
      })
    : [];
  const candidateRoomById = new Map(candidateRooms.map((r) => [r.id, r]));
  const candidateIds = candidates.map((r) => r.id);
  const candidateLinks = candidateIds.length
    ? await prisma.reservationGuest.findMany({
        where: { reservationId: { in: candidateIds }, isPrimary: true },
        select: { reservationId: true, guestId: true }
      })
    : [];
  const candidateGuestByReservation = new Map(candidateLinks.map((l) => [l.reservationId, l.guestId]));
  const candidateGuestIds = Array.from(new Set(candidateLinks.map((l) => l.guestId)));
  const candidateGuests = candidateGuestIds.length
    ? await prisma.guest.findMany({
        where: { id: { in: candidateGuestIds } },
        select: { id: true, firstName: true, surname1: true, surname2: true }
      })
    : [];
  const candidateGuestById = new Map(candidateGuests.map((g) => [g.id, g]));

  const items: CopilotItem[] = candidates.map((r) => {
    const room = r.assignedRoomId ? candidateRoomById.get(r.assignedRoomId) ?? null : null;
    const guestId = candidateGuestByReservation.get(r.id);
    const guest = guestId ? candidateGuestById.get(guestId) ?? null : null;
    return {
      primary: `Hab. ${room?.number ?? "?"} · ${fmtName(guest)}`,
      secondary: `ETD ${r.etd ?? "?"}`,
      actions: [{ label: "Hacer check-out", kind: "start_checkout", payload: { reservationId: r.id } }]
    } satisfies CopilotItem;
  });
  return {
    intent: "late_checkouts",
    question: "",
    answer: items.length === 0
      ? "Nadie ha pedido late check-out hoy (o ya hicieron check-out)."
      : `${items.length} huésped${items.length === 1 ? "" : "es"} con salida hoy sin cerrar todavía.`,
    items,
    suggestions: [],
    generatedAt: new Date().toISOString(),
    source: "reservation"
  };
}

async function listBlockedRooms(ctx: Ctx): Promise<CopilotAnswer> {
  const [unsellable, ooo, workOrders] = await Promise.all([
    prisma.room.findMany({ where: { propertyId: ctx.propertyId, sellable: false, active: true } }),
    prisma.room.findMany({ where: { propertyId: ctx.propertyId, status: "out_of_order", active: true } }),
    prisma.workOrder.findMany({
      where: { propertyId: ctx.propertyId, status: { in: ["open", "in_progress"] }, blocksRoom: true },
      select: { id: true, roomId: true, title: true }
    }).catch(() => [])
  ]);
  const ids = new Set<string>();
  for (const r of [...unsellable, ...ooo]) ids.add(r.id);
  const roomIds = Array.from(ids);
  if (roomIds.length === 0 && workOrders.length === 0) {
    return {
      intent: "rooms_blocked",
      question: "",
      answer: "No hay habitaciones bloqueadas ni fuera de servicio.",
      items: [],
      suggestions: [],
      generatedAt: new Date().toISOString(),
      source: "room+work-order"
    };
  }
  const rooms = roomIds.length
    ? await prisma.room.findMany({ where: { id: { in: roomIds } } })
    : [];
  const woByRoomId = new Map<string, string>();
  for (const wo of workOrders) {
    if (wo.roomId) woByRoomId.set(wo.roomId, wo.title);
  }
  const items: CopilotItem[] = rooms.map((r) => {
    const reason = r.status === "out_of_order" ? "Fuera de servicio" : !r.sellable ? "Bloqueada manualmente" : "Bloqueada";
    const woTitle = woByRoomId.get(r.id);
    return {
      primary: `Hab. ${r.number} · ${reason}`,
      secondary: woTitle ? `Avería: ${woTitle}` : `Planta ${r.floor ?? "?"} · HK: ${r.housekeepingStatus ?? "?"}`,
      badge: r.status === "out_of_order" ? "FOS" : "BLO",
      actions: [{ label: "Abrir Room Rack", kind: "open_room_rack" }]
    };
  });
  return {
    intent: "rooms_blocked",
    question: "",
    answer: `${rooms.length} habitaciones bloqueadas/fuera de servicio.`,
    items,
    suggestions: [],
    generatedAt: new Date().toISOString(),
    source: "room+work-order"
  };
}

async function listVipsArriving(ctx: Ctx): Promise<CopilotAnswer> {
  const today = startOfDayUtc();
  const tomorrow = new Date(today.getTime() + 86400000);
  const arrivals = await prisma.reservation.findMany({
    where: {
      propertyId: ctx.propertyId,
      arrivalDate: { gte: today, lt: tomorrow },
      status: { in: ["confirmed", "checked_in"] }
    },
    orderBy: { eta: "asc" }
  });
  const links = arrivals.length
    ? await prisma.reservationGuest.findMany({
        where: { reservationId: { in: arrivals.map((r) => r.id) }, isPrimary: true },
        select: { reservationId: true, guestId: true }
      })
    : [];
  const guestByReservation = new Map(links.map((l) => [l.reservationId, l.guestId]));
  const guestIds = Array.from(new Set(links.map((l) => l.guestId)));
  const guests = guestIds.length
    ? await prisma.guest.findMany({
        where: { id: { in: guestIds } },
        select: { id: true, firstName: true, surname1: true, surname2: true, vipCode: true, loyaltyTier: true }
      })
    : [];
  const guestById = new Map(guests.map((g) => [g.id, g]));
  const items: CopilotItem[] = [];
  for (const r of arrivals) {
    const gid = guestByReservation.get(r.id);
    if (!gid) continue;
    const g = guestById.get(gid);
    if (!g) continue;
    const isVip = Boolean(g.vipCode || (g.loyaltyTier && /platinum|gold|diamond/i.test(g.loyaltyTier)));
    if (!isVip) continue;
    items.push({
      primary: fmtName(g),
      secondary: `${g.vipCode ?? g.loyaltyTier ?? "VIP"} · ETA ${r.eta ?? "?"}${r.specialRequests ? ` · 💬 ${r.specialRequests}` : ""}`,
      badge: g.vipCode ?? "VIP",
      actions: [{ label: "Ver perfil", kind: "open_guest", payload: { guestId: g.id } }]
    });
  }
  return {
    intent: "vips_arriving",
    question: "",
    answer:
      items.length === 0
        ? "No hay huéspedes VIP previstos hoy."
        : `${items.length} VIP${items.length === 1 ? "" : "s"} con llegada prevista hoy. Avisa a dirección para preparar bienvenida.`,
    items,
    suggestions: [],
    generatedAt: new Date().toISOString(),
    source: "reservation+guest"
  };
}

async function listOpenIncidents(ctx: Ctx): Promise<CopilotAnswer> {
  const wos = await prisma.workOrder.findMany({
    where: { propertyId: ctx.propertyId, status: { in: ["open", "in_progress"] } },
    orderBy: { createdAt: "asc" }
  }).catch(() => []);
  const roomIds = wos.map((w) => w.roomId).filter((x): x is string => Boolean(x));
  const rooms = roomIds.length
    ? await prisma.room.findMany({ where: { id: { in: roomIds } }, select: { id: true, number: true } })
    : [];
  const roomById = new Map(rooms.map((r) => [r.id, r]));
  const items: CopilotItem[] = wos.map((wo) => {
    const room = wo.roomId ? roomById.get(wo.roomId) : undefined;
    return {
      primary: `${room ? `Hab. ${room.number}` : "Sin habitación"} · ${wo.title}`,
      secondary: `Prioridad: ${wo.priority ?? "normal"} · ${wo.status}`,
      badge: wo.priority === "emergency" ? "URG" : wo.priority?.slice(0, 4) ?? "—",
      actions: [{ label: "Ver incidencia", kind: "open_work_order", payload: { workOrderId: wo.id } }]
    };
  });
  return {
    intent: "open_incidents",
    question: "",
    answer: items.length === 0 ? "Sin incidencias abiertas. Todo bajo control." : `${items.length} incidencia${items.length === 1 ? "" : "s"} sin cerrar.`,
    items,
    suggestions: [],
    generatedAt: new Date().toISOString(),
    source: "work-order"
  };
}

async function listOverdueHkTasks(ctx: Ctx): Promise<CopilotAnswer> {
  // "Retrasada" = tarea en pending desde hace > 2h sin asignar, o asignada y sin completar tras > 90 min
  const now = new Date();
  const twoHoursAgo = new Date(now.getTime() - 2 * 60 * 60 * 1000);
  const tasks = await prisma.housekeepingTask.findMany({
    where: {
      propertyId: ctx.propertyId,
      status: { in: ["pending", "assigned", "in_progress"] },
      createdAt: { lt: twoHoursAgo }
    },
    orderBy: { createdAt: "asc" }
  });
  const roomIds = tasks.map((t) => t.roomId);
  const rooms = roomIds.length
    ? await prisma.room.findMany({ where: { id: { in: roomIds } }, select: { id: true, number: true, floor: true } })
    : [];
  const roomById = new Map(rooms.map((r) => [r.id, r]));
  const items: CopilotItem[] = tasks.map((t) => {
    const room = roomById.get(t.roomId);
    const minutes = Math.floor((now.getTime() - t.createdAt.getTime()) / 60000);
    return {
      primary: `Hab. ${room?.number ?? "?"} · ${t.taskType}`,
      secondary: `Pendiente desde hace ${minutes} min · status ${t.status}`,
      badge: minutes > 180 ? "URG" : `${minutes}m`,
      actions: [{ label: "Abrir HK móvil", kind: "open_housekeeping" }]
    };
  });
  return {
    intent: "overdue_hk_tasks",
    question: "",
    answer: items.length === 0 ? "Sin tareas de housekeeping retrasadas." : `${items.length} tarea${items.length === 1 ? "" : "s"} HK pendientes desde hace más de 2 horas.`,
    items,
    suggestions: items.length > 0 ? [{ label: "Abrir HK móvil", kind: "open_housekeeping" }] : [],
    generatedAt: new Date().toISOString(),
    source: "hk-task"
  };
}

// ============================================================== dispatcher

export async function answerCopilot(input: { propertyId: string; question: string }): Promise<CopilotAnswer> {
  const intent = detectIntent(input.question);
  const ctx: Ctx = { propertyId: input.propertyId };
  let result: CopilotAnswer;
  switch (intent) {
    case "arrivals_no_clean_room": result = await listArrivalsNoCleanRoom(ctx); break;
    case "arrivals_pending_balance": result = await listArrivalsPendingBalance(ctx); break;
    case "rooms_ready_for_delivery": result = await listRoomsReadyForDelivery(ctx); break;
    case "reservations_at_risk": result = await listReservationsAtRisk(ctx); break;
    case "shift_summary": result = await shiftSummary(ctx); break;
    case "late_checkouts": result = await listLateCheckouts(ctx); break;
    case "rooms_blocked": result = await listBlockedRooms(ctx); break;
    case "vips_arriving": result = await listVipsArriving(ctx); break;
    case "open_incidents": result = await listOpenIncidents(ctx); break;
    case "overdue_hk_tasks": result = await listOverdueHkTasks(ctx); break;
    default:
      result = {
        intent: "unknown",
        question: input.question,
        answer:
          "No reconozco esa pregunta. Prueba con: '¿qué llegadas no tienen habitación limpia?', '¿qué VIPs llegan hoy?', '¿qué habitaciones puedo entregar?', '¿qué reservas en riesgo?', 'resume el turno', '¿quién pidió late checkout?', '¿qué habitaciones bloqueadas?', '¿qué incidencias abiertas?', '¿qué tareas HK retrasadas?'.",
        items: [],
        suggestions: [],
        generatedAt: new Date().toISOString(),
        source: "router"
      };
  }
  result.question = input.question;
  return result;
}

export const COPILOT_PRESET_QUESTIONS: Array<{ id: string; label: string; question: string }> = [
  { id: "shift_summary", label: "Resumen del día", question: "Resume el turno actual" },
  { id: "arrivals_no_clean_room", label: "Llegadas sin habitación lista", question: "¿Qué llegadas tienen habitación sin limpiar?" },
  { id: "arrivals_pending_balance", label: "Llegadas con saldo", question: "¿Qué huéspedes llegan hoy con saldo pendiente?" },
  { id: "rooms_ready_for_delivery", label: "Habitaciones entregables", question: "¿Qué habitaciones puedo entregar ahora?" },
  { id: "reservations_at_risk", label: "Reservas en riesgo", question: "¿Qué reservas tienen riesgo de problema?" },
  { id: "vips_arriving", label: "VIPs hoy", question: "¿Qué huésped VIP llega hoy?" },
  { id: "late_checkouts", label: "Late check-outs", question: "¿Quién pidió late checkout?" },
  { id: "rooms_blocked", label: "Bloqueadas", question: "¿Qué habitaciones están bloqueadas y por qué?" },
  { id: "open_incidents", label: "Incidencias abiertas", question: "¿Qué incidencias siguen abiertas?" },
  { id: "overdue_hk_tasks", label: "HK retrasadas", question: "¿Qué tareas de housekeeping están retrasadas?" }
];
