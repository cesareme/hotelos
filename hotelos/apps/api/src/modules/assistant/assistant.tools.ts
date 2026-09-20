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

import { prisma } from "@hotelos/database";

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
// Tool catalog (for both deterministic router and LLM tool-calling)
// ---------------------------------------------------------------------------

export type ToolDefinition = {
  name: string;
  description: string;
  /**
   * Spanish keywords that, if seen in the user's question, trigger this tool.
   * Used by the deterministic router (see `keywordMatchesQuestion`: one-token
   * keywords match as substring, multi-token keywords when all their tokens
   * appear as whole words in any order). Never add a keyword made of a single
   * generic word («hoy», «ahora», «hotel»): it would route every question.
   * The LLM picks by `description` + `name`.
   */
  keywords: string[];
  run: (ctx: ToolContext) => Promise<ToolResult>;
};

export const ASSISTANT_TOOLS: ToolDefinition[] = [
  {
    name: "get_arrivals_today",
    description: "Lista las reservas que llegan hoy (estado confirmada o ya en check-in).",
    // Corrector FIX-1 (F8-TODAY-ROUTING-OVERREACH): sin la keyword de un solo token «llegadas» — enrutaba «¿Qué
    // llegadas hay mañana?» a los datos de hoy; las variantes llevan «hoy» o preguntan por la cantidad, y el router
    // descarta las herramientas «de hoy» cuando la pregunta nombra otra fecha (`mentionsAnotherDate`).
    keywords: ["llegadas hoy", "llegan hoy", "cuantas llegadas", "arrivals today", "check-in hoy", "entradas hoy"],
    run: getArrivalsToday
  },
  {
    name: "get_departures_today",
    description: "Lista las reservas que salen hoy (estado en estancia o salida).",
    keywords: ["salidas hoy", "salen hoy", "cuantas salidas", "departures today", "check-out hoy"],
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
  }
];

/**
 * Normaliza texto para el router determinista: minúsculas, sin acentos, sin
 * signos `¿?¡!.,;:` y con los espacios colapsados. Los guiones se conservan
 * («check-in», «in-house» son un solo token).
 */
function normalizeForRouting(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[¿?¡!.,;:]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenize(text: string): string[] {
  return normalizeForRouting(text).split(" ").filter((t) => t.length > 0);
}

/**
 * Una keyword coincide con la pregunta cuando:
 *   - tiene un solo token (p. ej. «ocupación», «in-house»): aparece como
 *     subcadena del texto normalizado (cubre plurales y derivados);
 *   - tiene varios tokens (p. ej. «llegadas hoy»): TODOS sus tokens aparecen
 *     como palabras completas en la pregunta, en cualquier orden
 *     («¿Cuántas llegadas tengo hoy?» → {llegadas, hoy} ⊂ pregunta).
 */
export function keywordMatchesQuestion(keyword: string, question: string): boolean {
  const kwTokens = tokenize(keyword);
  if (kwTokens.length === 0) return false;
  if (kwTokens.length === 1) return normalizeForRouting(question).includes(kwTokens[0]);
  const qTokens = new Set(tokenize(question));
  return kwTokens.every((t) => qTokens.has(t));
}

/** Tokens (normalizados) que sitúan la pregunta en otra fecha que hoy: mañana, ayer, semana, mes, fin de semana, próximo, pasado, días de la semana o una fecha dd/mm. */
const OTHER_DATE_TOKENS: ReadonlySet<string> = new Set(["manana", "ayer", "anteayer", "semana", "mes", "proximo", "proxima", "proximos", "proximas", "lunes", "martes", "miercoles", "jueves", "viernes", "sabado", "domingo", "tomorrow", "yesterday", "week", "month"]);

/**
 * Corrector FIX-1 (F8): true cuando la pregunta nombra otra fecha que hoy («mañana», «la semana que viene», «el
 * 24/12»…); las herramientas «de hoy» (`*_today`) no se enrutan entonces. «hoy» presente no anula la exclusión
 * («llegadas de hoy y de mañana» tampoco es una pregunta de hoy). Pura.
 */
export function mentionsAnotherDate(question: string): boolean {
  const tokens = tokenize(question);
  if (tokens.some((token) => OTHER_DATE_TOKENS.has(token))) return true;
  return /\b\d{1,2}\/\d{1,2}(\/\d{2,4})?\b/.test(question);
}

export function findToolsByKeyword(question: string): ToolDefinition[] {
  const matches = new Set<ToolDefinition>();
  const anotherDate = mentionsAnotherDate(question);
  for (const tool of ASSISTANT_TOOLS) {
    if (anotherDate && tool.name.endsWith("_today")) continue;
    if (tool.keywords.some((kw) => keywordMatchesQuestion(kw, question))) matches.add(tool);
  }
  return Array.from(matches);
}
