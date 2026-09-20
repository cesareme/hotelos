// Catalog of "tools" the assistant can invoke to answer questions about the
// property. Each tool is a typed async function that runs a single Prisma
// query and returns a small structured result. Tools are designed to be
// composable: the assistant can call multiple in one turn.
//
// The same catalog is consumable both by:
//   (a) The deterministic rule-based router in `assistant.service.ts` (for
//       quick, well-known questions like "how many arrivals today?").
//   (b) An LLM with tool-calling support (Anthropic / OpenAI) when configured,
//       picking tools by name + schema.
//
// Honesty principle: every tool returns its raw numbers + a `source` string
// so the assistant can cite where each fact came from.
//
// Tanda CHK (W4-D · diseño §5 «Copiloto de recepción», presets): tres lecturas
// nuevas — get_arrivals_without_room (llegadas de hoy sin habitación con el
// top-3 sugerido y sus motivos por room-assignment.service, sin persistir),
// get_incomplete_precheckins (sesiones invited/in_progress de hoy y mañana con
// lo que falta por viajero) y get_rooms_ready_for_delivery (misma consulta que
// copilot.service.ts listRoomsReadyForDelivery). Ninguna escribe ni asigna:
// assignRoom sigue exigiendo confirmación en el tool runner. El motor recibe un
// contexto de servicio de la propiedad (service-context.ts, solo lectura),
// porque el router del asistente no transporta el UserContext. «Hoy» y
// «mañana» son los del huso horario de la propiedad (Property.timezone, como
// las llegadas de recepción), no el día UTC de las tools históricas: a las
// 00:30 en Madrid las llegadas del día ya son las de hoy.

import { prisma } from "@hotelos/database";
import { missingForSession } from "../checkin/checkin-session.service.js";
import { checkInServiceContext } from "../checkin/service-context.js";
import { todayInTimezone } from "../pms/pms.service.js";
import { suggestForReservation } from "../pms/room-assignment.service.js";

export type ToolResult = {
  ok: boolean;
  data: Record<string, unknown>;
  source: string; // e.g. "prisma:Reservation"
  generatedAt: string; // ISO timestamp
};

type ToolContext = {
  organizationId: string;
  propertyId: string;
};

function isoToday(): string {
  return new Date().toISOString().slice(0, 10);
}

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function startOfDayUtc(iso: string): Date {
  return new Date(`${iso.slice(0, 10)}T00:00:00.000Z`);
}

// ---------------------------------------------------------------------------
// Reservation / arrivals / departures
// ---------------------------------------------------------------------------

export async function getArrivalsToday(ctx: ToolContext): Promise<ToolResult> {
  const today = startOfDayUtc(isoToday());
  const rows = await prisma.reservation.findMany({
    where: {
      propertyId: ctx.propertyId,
      arrivalDate: today,
      status: { in: ["confirmed", "checked_in"] }
    },
    select: { id: true, code: true, status: true, bookerName: true, channel: true, totalAmount: true, currency: true }
  });
  return {
    ok: true,
    data: { count: rows.length, items: rows },
    source: "prisma:Reservation.arrivalDate=today",
    generatedAt: new Date().toISOString()
  };
}

export async function getDeparturesToday(ctx: ToolContext): Promise<ToolResult> {
  const today = startOfDayUtc(isoToday());
  const rows = await prisma.reservation.findMany({
    where: { propertyId: ctx.propertyId, departureDate: today, status: { in: ["checked_in", "checked_out"] } },
    select: { id: true, code: true, status: true, bookerName: true, channel: true }
  });
  return {
    ok: true,
    data: { count: rows.length, items: rows },
    source: "prisma:Reservation.departureDate=today",
    generatedAt: new Date().toISOString()
  };
}

export async function getInHouseGuests(ctx: ToolContext): Promise<ToolResult> {
  const today = startOfDayUtc(isoToday());
  const count = await prisma.reservation.count({
    where: {
      propertyId: ctx.propertyId,
      status: "checked_in",
      arrivalDate: { lte: today },
      departureDate: { gt: today }
    }
  });
  return {
    ok: true,
    data: { count },
    source: "prisma:Reservation.status=checked_in",
    generatedAt: new Date().toISOString()
  };
}

// ---------------------------------------------------------------------------
// Occupancy / inventory
// ---------------------------------------------------------------------------

export async function getOccupancyToday(ctx: ToolContext): Promise<ToolResult> {
  const today = startOfDayUtc(isoToday());
  const [totalRooms, occupiedRooms] = await Promise.all([
    prisma.room.count({ where: { propertyId: ctx.propertyId, active: true, sellable: true } }),
    prisma.reservation.count({
      where: {
        propertyId: ctx.propertyId,
        status: "checked_in",
        arrivalDate: { lte: today },
        departureDate: { gt: today }
      }
    })
  ]);
  const occupancyPct = totalRooms > 0 ? Math.round((occupiedRooms / totalRooms) * 1000) / 10 : 0;
  return {
    ok: true,
    data: { totalRooms, occupiedRooms, occupancyPct },
    source: "prisma:Room + Reservation.status=checked_in",
    generatedAt: new Date().toISOString()
  };
}

// ---------------------------------------------------------------------------
// Revenue / pace / pickup (uses RevenueDailySnapshot if seeded)
// ---------------------------------------------------------------------------

export async function getRecentRevenueSnapshot(ctx: ToolContext): Promise<ToolResult> {
  const row = await prisma.revenueDailySnapshot.findFirst({
    where: { propertyId: ctx.propertyId },
    orderBy: { snapshotDate: "desc" }
  });
  if (!row) {
    return {
      ok: false,
      data: { reason: "no_snapshot_available" },
      source: "prisma:RevenueDailySnapshot",
      generatedAt: new Date().toISOString()
    };
  }
  return {
    ok: true,
    data: {
      snapshotDate: ymd(row.snapshotDate),
      occupancyPct: Number(row.occupancyPercent ?? 0),
      adr: Number(row.adr ?? 0),
      revpar: Number(row.revpar ?? 0),
      totalRevenue: Number(row.totalRevenue ?? 0),
      currency: "EUR"
    },
    source: "prisma:RevenueDailySnapshot",
    generatedAt: new Date().toISOString()
  };
}

export async function getPickup7d(ctx: ToolContext): Promise<ToolResult> {
  const today = startOfDayUtc(isoToday());
  const sevenDaysAgo = new Date(today.getTime() - 7 * 86_400_000);
  const recent = await prisma.reservation.count({
    where: {
      propertyId: ctx.propertyId,
      createdAt: { gte: sevenDaysAgo },
      status: { in: ["confirmed", "checked_in", "checked_out"] }
    }
  });
  return {
    ok: true,
    data: { window: "last_7_days", reservationsCreated: recent },
    source: "prisma:Reservation.createdAt >= today-7d",
    generatedAt: new Date().toISOString()
  };
}

// ---------------------------------------------------------------------------
// Finance / pending balances
// ---------------------------------------------------------------------------

export async function getOpenBalance(ctx: ToolContext): Promise<ToolResult> {
  // Approximation: open folios on reservations of this property.
  const inHouseReservations = await prisma.reservation.findMany({
    where: { propertyId: ctx.propertyId, status: "checked_in" },
    select: { id: true }
  });
  const reservationIds = inHouseReservations.map((r) => r.id);
  if (reservationIds.length === 0) {
    return {
      ok: true,
      data: { openFolios: 0, totalCharges: 0, totalPayments: 0, balanceDue: 0, currency: "EUR" },
      source: "prisma:Folio (no in-house)",
      generatedAt: new Date().toISOString()
    };
  }
  const folios = await prisma.folio.findMany({
    where: { reservationId: { in: reservationIds }, status: "open" },
    select: { id: true, currency: true }
  });
  const folioIds = folios.map((f) => f.id);
  const [charges, payments] = await Promise.all([
    folioIds.length > 0
      ? prisma.folioLine.aggregate({ where: { folioId: { in: folioIds } }, _sum: { total: true } })
      : Promise.resolve({ _sum: { total: 0 } }),
    folioIds.length > 0
      ? prisma.payment.aggregate({
          where: { folioId: { in: folioIds }, status: "captured" },
          _sum: { amount: true }
        })
      : Promise.resolve({ _sum: { amount: 0 } })
  ]);
  const totalCharges = Number(charges._sum.total ?? 0);
  const totalPayments = Number(payments._sum.amount ?? 0);
  return {
    ok: true,
    data: {
      openFolios: folios.length,
      totalCharges,
      totalPayments,
      balanceDue: Math.round((totalCharges - totalPayments) * 100) / 100,
      currency: folios[0]?.currency ?? "EUR"
    },
    source: "prisma:Folio + FolioLine + Payment",
    generatedAt: new Date().toISOString()
  };
}

// ---------------------------------------------------------------------------
// Operations: housekeeping / maintenance
// ---------------------------------------------------------------------------

export async function getHousekeepingStatus(ctx: ToolContext): Promise<ToolResult> {
  const rooms = await prisma.room.findMany({
    where: { propertyId: ctx.propertyId, active: true },
    select: { status: true, housekeepingStatus: true }
  });
  const counts: Record<string, number> = {};
  for (const r of rooms) {
    const k = r.housekeepingStatus ?? r.status ?? "unknown";
    counts[k] = (counts[k] ?? 0) + 1;
  }
  return {
    ok: true,
    data: { totalRooms: rooms.length, statusBreakdown: counts },
    source: "prisma:Room.housekeepingStatus",
    generatedAt: new Date().toISOString()
  };
}

// ---------------------------------------------------------------------------
// Compliance: critical controls
// ---------------------------------------------------------------------------

export async function getComplianceSummary(ctx: ToolContext): Promise<ToolResult> {
  // The Compliance Center tables may not be seeded in every demo. Catch and
  // return a graceful fallback rather than throwing.
  try {
    // Best-effort: count overdue control requirements on this property.
    const result = await prisma.$queryRawUnsafe<Array<{ severity: string; cnt: bigint }>>(
      `SELECT severity, COUNT(*)::bigint as cnt
       FROM compliance_requirements
       WHERE property_id = $1
       GROUP BY severity`,
      ctx.propertyId
    );
    const bySeverity: Record<string, number> = {};
    for (const row of result) bySeverity[row.severity] = Number(row.cnt);
    return {
      ok: true,
      data: { bySeverity },
      source: "prisma:ComplianceRequirement (raw)",
      generatedAt: new Date().toISOString()
    };
  } catch {
    return {
      ok: false,
      data: { reason: "compliance_data_unavailable" },
      source: "compliance unavailable",
      generatedAt: new Date().toISOString()
    };
  }
}

// ---------------------------------------------------------------------------
// Check-in automatizado (Tanda CHK · W4-D): presets del copiloto
// ---------------------------------------------------------------------------

/** Límite de reservas a las que se pide sugerencia en un turno (el motor carga la instantánea de la propiedad por reserva). */
export const ARRIVALS_WITHOUT_ROOM_LIMIT = 20;

function isCleanHk(value?: string | null, fallbackStatus?: string): boolean {
  const v = (value ?? "").toLowerCase();
  if (v === "clean" || v === "inspected" || v === "ready") return true;
  if (!v && fallbackStatus === "clean") return true;
  return false;
}

/** Día de negocio de la propiedad (Property.timezone; Europe/Madrid si no existe la fila). */
async function propertyToday(propertyId: string): Promise<string> {
  const property = await prisma.property.findUnique({ where: { id: propertyId }, select: { timezone: true } });
  return todayInTimezone(property?.timezone ?? "Europe/Madrid");
}

export async function getArrivalsWithoutRoom(ctx: ToolContext): Promise<ToolResult> {
  const today = startOfDayUtc(await propertyToday(ctx.propertyId));
  const arrivals = await prisma.reservation.findMany({
    where: { propertyId: ctx.propertyId, arrivalDate: today, status: "confirmed", assignedRoomId: null, deletedAt: null },
    orderBy: [{ eta: "asc" }, { code: "asc" }],
    select: { id: true, code: true, eta: true, adults: true, children: true, roomTypeId: true, vipFlag: true },
    take: ARRIVALS_WITHOUT_ROOM_LIMIT + 1
  });
  const truncated = arrivals.length > ARRIVALS_WITHOUT_ROOM_LIMIT;
  const rows = truncated ? arrivals.slice(0, ARRIVALS_WITHOUT_ROOM_LIMIT) : arrivals;
  const context = rows.length > 0 ? await checkInServiceContext(ctx.propertyId, { kind: "system", job: "copilot" }) : null;
  const items = [];
  for (const reservation of rows) {
    try {
      const suggestion = await suggestForReservation({ context: context!, reservationId: reservation.id, persist: false });
      items.push({
        reservationId: reservation.id,
        code: reservation.code,
        eta: reservation.eta ?? null,
        adults: reservation.adults,
        children: reservation.children,
        vip: reservation.vipFlag,
        confidence: suggestion.confidence,
        suggested: suggestion.candidates.slice(0, 3).map((candidate) => ({ roomId: candidate.roomId, number: candidate.number, score: candidate.score, reasons: candidate.reasons.map((reason) => reason.detail), warnings: candidate.warnings })),
        rejected: suggestion.rejectedCount,
        dataNotes: suggestion.dataNotes
      });
    } catch (error) {
      items.push({ reservationId: reservation.id, code: reservation.code, eta: reservation.eta ?? null, adults: reservation.adults, children: reservation.children, vip: reservation.vipFlag, confidence: 0, suggested: [], rejected: 0, dataNotes: [`sin sugerencia: ${error instanceof Error ? error.message : String(error)}`] });
    }
  }
  const withSuggestion = items.filter((item) => item.suggested.length > 0).length;
  return {
    ok: true,
    data: {
      count: items.length,
      withSuggestion,
      truncated,
      items,
      summary: items.length === 0 ? "Todas las llegadas de hoy tienen habitación." : `${items.length} llegada${items.length === 1 ? "" : "s"} de hoy sin habitación, ${withSuggestion} con sugerencia: ${items.map((item) => `${item.code} → ${item.suggested[0]?.number ?? "sin candidata"}`).join(", ")}.`
    },
    source: "prisma:Reservation.arrivalDate=today(Property.timezone),assignedRoomId=null + room-assignment.engine (sin persistir)",
    generatedAt: new Date().toISOString()
  };
}

export async function getIncompletePreCheckIns(ctx: ToolContext): Promise<ToolResult> {
  const today = startOfDayUtc(await propertyToday(ctx.propertyId));
  const tomorrow = new Date(today.getTime() + 24 * 60 * 60 * 1000);
  const reservations = await prisma.reservation.findMany({
    where: { propertyId: ctx.propertyId, status: "confirmed", deletedAt: null, arrivalDate: { in: [today, tomorrow] } },
    select: { id: true, code: true, arrivalDate: true, eta: true }
  });
  if (reservations.length === 0) {
    return { ok: true, data: { count: 0, items: [], summary: "Sin llegadas de hoy ni mañana con pre-check-in pendiente." }, source: "prisma:CheckInSession.status in (invited,in_progress)", generatedAt: new Date().toISOString() };
  }
  const byReservation = new Map(reservations.map((row) => [row.id, row] as const));
  const sessions = await prisma.checkInSession.findMany({
    where: { propertyId: ctx.propertyId, reservationId: { in: reservations.map((row) => row.id) }, status: { in: ["invited", "in_progress"] } },
    select: { id: true, reservationId: true, status: true, etaDeclared: true, paymentStatus: true, invitedAt: true, reminderAt: true }
  });
  // Viajeros por consulta de primer nivel (descifrados): la presencia de campos es real.
  const guests = sessions.length > 0 ? await prisma.checkInGuest.findMany({ where: { sessionId: { in: sessions.map((session) => session.id) } }, orderBy: { ordinal: "asc" } }) : [];
  const items = sessions
    .map((session) => {
      const reservation = byReservation.get(session.reservationId)!;
      const rows = guests.filter((guest) => guest.sessionId === session.id);
      const missing = missingForSession(rows).map((row) => ({ ordinal: row.ordinal, isPrimary: row.isPrimary, fields: row.fields }));
      return {
        sessionId: session.id,
        reservationId: reservation.id,
        code: reservation.code,
        arrivalDate: ymd(reservation.arrivalDate),
        eta: session.etaDeclared ?? reservation.eta ?? null,
        status: session.status,
        paymentStatus: session.paymentStatus,
        invitedAt: session.invitedAt?.toISOString() ?? null,
        reminderAt: session.reminderAt?.toISOString() ?? null,
        travellers: rows.length,
        missingFields: missing.reduce((sum, row) => sum + row.fields.length, 0),
        missing
      };
    })
    .sort((a, b) => a.arrivalDate.localeCompare(b.arrivalDate) || a.code.localeCompare(b.code));
  return {
    ok: true,
    data: {
      count: items.length,
      invited: items.filter((item) => item.status === "invited").length,
      inProgress: items.filter((item) => item.status === "in_progress").length,
      items,
      summary: items.length === 0 ? "Sin pre-check-ins incompletos para hoy ni mañana." : `${items.length} pre-check-in${items.length === 1 ? "" : "s"} incompleto${items.length === 1 ? "" : "s"} (hoy y mañana): ${items.map((item) => `${item.code} ${item.status === "invited" ? "sin empezar" : `en curso, faltan ${item.missingFields} datos`}`).join(", ")}.`
    },
    source: "prisma:CheckInSession.status in (invited,in_progress) · Reservation.arrivalDate in (today,tomorrow · Property.timezone)",
    generatedAt: new Date().toISOString()
  };
}

export async function getRoomsReadyForDelivery(ctx: ToolContext): Promise<ToolResult> {
  const rooms = await prisma.room.findMany({ where: { propertyId: ctx.propertyId, active: true, sellable: true }, select: { id: true, number: true, roomTypeId: true, status: true, housekeepingStatus: true } });
  const inHouse = await prisma.reservation.findMany({ where: { propertyId: ctx.propertyId, status: "checked_in" }, select: { assignedRoomId: true } });
  const occupied = new Set(inHouse.map((r) => r.assignedRoomId).filter((x): x is string => Boolean(x)));
  const ready = rooms.filter((r) => !occupied.has(r.id) && isCleanHk(r.housekeepingStatus, r.status) && r.status !== "out_of_order");
  const roomTypes = await prisma.roomType.findMany({ where: { propertyId: ctx.propertyId }, select: { id: true, name: true } });
  const byType = new Map<string, typeof ready>();
  for (const room of ready) {
    const key = room.roomTypeId ?? "sin_tipo";
    const list = byType.get(key) ?? [];
    list.push(room);
    byType.set(key, list);
  }
  const items = Array.from(byType.entries()).map(([roomTypeId, list]) => ({
    roomTypeId,
    roomType: roomTypes.find((type) => type.id === roomTypeId)?.name ?? roomTypeId,
    count: list.length,
    rooms: list.map((room) => room.number).sort()
  }));
  return {
    ok: true,
    data: {
      readyRooms: ready.length,
      totalSellable: rooms.length,
      items,
      summary: `${ready.length} habitaciones listas para entregar (limpias o inspeccionadas, sin ocupar) en ${byType.size} tipo${byType.size === 1 ? "" : "s"}${items.length > 0 ? `: ${items.map((item) => `${item.roomType} ${item.count}`).join(", ")}` : ""}.`
    },
    source: "prisma:Room.housekeepingStatus in (clean,inspected,ready) − Reservation.checked_in",
    generatedAt: new Date().toISOString()
  };
}

// ---------------------------------------------------------------------------
// Tool catalog (for both deterministic router and LLM tool-calling)
// ---------------------------------------------------------------------------

export type ToolDefinition = {
  name: string;
  description: string;
  /**
   * Spanish keywords that, if seen in the user's question, trigger this tool.
   * Used by the deterministic router. The LLM picks by `description` + `name`.
   */
  keywords: string[];
  run: (ctx: ToolContext) => Promise<ToolResult>;
};

export const ASSISTANT_TOOLS: ToolDefinition[] = [
  {
    name: "get_arrivals_today",
    description: "Lista las reservas que llegan hoy (estado confirmada o ya en check-in).",
    keywords: ["llegadas hoy", "llegan hoy", "arrivals today", "check-in hoy", "entradas hoy"],
    run: getArrivalsToday
  },
  {
    name: "get_departures_today",
    description: "Lista las reservas que salen hoy (estado en estancia o salida).",
    keywords: ["salidas hoy", "salen hoy", "departures today", "check-out hoy"],
    run: getDeparturesToday
  },
  {
    name: "get_in_house_guests",
    description: "Cuántos huéspedes están en el hotel ahora (check-in completado, salida futura).",
    keywords: ["en el hotel", "in-house", "huéspedes ahora", "guests in house", "alojados ahora"],
    run: getInHouseGuests
  },
  {
    name: "get_occupancy_today",
    description: "Porcentaje de ocupación hoy (habitaciones vendibles vs ocupadas).",
    keywords: ["ocupación", "ocupacion", "occupancy", "ocupacion hoy"],
    run: getOccupancyToday
  },
  {
    name: "get_recent_revenue_snapshot",
    description: "Snapshot diario reciente de revenue (ocupación, ADR, RevPAR, ingresos).",
    keywords: ["revenue", "adr", "revpar", "ingresos", "facturación", "snapshot"],
    run: getRecentRevenueSnapshot
  },
  {
    name: "get_pickup_7d",
    description: "Cuántas reservas se han creado en los últimos 7 días (pickup).",
    keywords: ["pickup", "creadas", "últimos 7 días", "ultima semana", "última semana"],
    run: getPickup7d
  },
  {
    name: "get_open_balance",
    description: "Saldo pendiente actual de los folios abiertos del hotel.",
    keywords: ["saldo", "pendiente", "balance", "cobrar", "deudores", "open balance"],
    run: getOpenBalance
  },
  {
    name: "get_housekeeping_status",
    description: "Estado de pisos: limpias, sucias, inspeccionadas, fuera de servicio.",
    keywords: ["pisos", "housekeeping", "limpieza", "limpias", "sucias"],
    run: getHousekeepingStatus
  },
  {
    name: "get_compliance_summary",
    description: "Resumen de cumplimiento normativo: controles críticos, vencidos, pendientes.",
    keywords: ["cumplimiento", "compliance", "controles", "auditoría", "rgpd", "fiscal"],
    run: getComplianceSummary
  },
  // Tanda CHK (W4-D): presets del copiloto de recepción (diseño §5). Lecturas; nada se asigna.
  {
    name: "get_arrivals_without_room",
    description: "Llegadas de hoy sin habitación asignada con las tres habitaciones sugeridas por el motor de asignación y sus motivos (sin asignar nada).",
    keywords: ["llegadas sin habitación", "llegadas sin habitacion", "sin habitación asignada", "sin habitacion asignada", "sin asignar", "habitación sugerida", "habitacion sugerida", "arrivals without room", "sugerencia de habitación", "sugerencia de habitacion"],
    run: getArrivalsWithoutRoom
  },
  {
    name: "get_incomplete_precheckins",
    description: "Pre-check-ins en línea de hoy y mañana sin terminar (invitados o en curso) con los datos que faltan por viajero.",
    keywords: ["pre-check-in incompleto", "pre-check-ins incompletos", "precheckin", "pre-check-in pendiente", "pre-check-ins pendientes", "check-in online pendiente", "check-in en línea pendiente", "check-in en linea pendiente", "incomplete pre-check-in", "sin terminar el check-in"],
    run: getIncompletePreCheckIns
  },
  {
    name: "get_rooms_ready_for_delivery",
    description: "Habitaciones listas para entregar ahora (limpias o inspeccionadas y sin ocupar), agrupadas por tipo.",
    keywords: ["habitaciones listas", "listas para entregar", "lista para entregar", "habitaciones para entregar", "rooms ready", "ready for delivery", "listas para entrega"],
    run: getRoomsReadyForDelivery
  }
];

export function findToolsByKeyword(question: string): ToolDefinition[] {
  const q = question.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  const matches = new Set<ToolDefinition>();
  for (const tool of ASSISTANT_TOOLS) {
    for (const kw of tool.keywords) {
      const norm = kw.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
      if (q.includes(norm)) {
        matches.add(tool);
        break;
      }
    }
  }
  return Array.from(matches);
}
