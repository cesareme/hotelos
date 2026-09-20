// General Manager dashboard — vista estratégica del director del hotel.
//
// Directriz ehotelOS (Nov 2026):
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
//   - Productividad operativa: check-ins/outs hechos en la fecha de negocio y los
//     PENDIENTES de llegar/salir en ella (regla del preflight; ya no una ratio)
//   - Reputación (reviews recientes si existen)
//
// Tanda UX-2 (lote D3 · F-D1 «una verdad»): la ventana «hoy» es la FECHA DE
// NEGOCIO de la propiedad (business_dates.current_date, leída una vez al
// principio, como night-audit-preflight.service.ts); sin fila, el día natural
// UTC. Llegadas y salidas siguen la regla del preflight (llegadas `confirmed`
// con arrivalDate = fecha de negocio; salidas `checked_in` con departureDate =
// fecha de negocio) y la respuesta expone `businessDate` + `businessDateSource`
// (campos aditivos) para que la pantalla diga su ventana.

import { prisma } from "@hotelos/database";
import { createDegradedCollector } from "../../lib/degraded.js";
// Tanda T8 (lote T8-E): índice de reputación ADITIVO junto al bloque
// `reputation` (media simple, intacto). El módulo se comprueba en el espejo
// síncrono antes de consultar el índice; el NPS reutiliza la regla del
// dashboard de encuestas.
import { getEnabledModuleCodes } from "../product-modules/product-modules.service.js";
import { REPUTATION_MODULE_CODE } from "../reputation/reputation-context.js";
import { getReputationSnapshot, type ReputationSnapshot } from "../reputation/reputation-score.service.js";
import type { GmReputationIndex } from "../reputation/reputation-types.js";
import { npsFromSurveys } from "./surveys.service.js";

// Explicit bounds of the reservation / snapshot reads (Tanda L2 · L2-05): the
// windows are a month, 7-14 days ahead or ≤ 180 days of pace, so the caps
// never cut a real hotel; they only make every scan bounded.
const GM_MAX_RESERVATION_ROWS = 50_000;
const GM_MAX_SNAPSHOT_ROWS = 10_000;

export type GmKpiCompare = {
  value: number;
  vsYesterday?: { value: number; pct: number };
  vsLastWeek?: { value: number; pct: number };
};

export type GmDashboard = {
  generatedAt: string;
  propertyId: string;
  propertyName?: string;
  asOf: string;             // ISO date (= businessDate)
  // Tanda UX-2 (D3, aditivo): fecha de negocio de la ventana «hoy» y su origen
  // (`business_date` = fila de business_dates · `utc_day` = sin fila, día UTC).
  businessDate: string;
  businessDateSource: GmBusinessDateSource;

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

  // Tanda UX-2 (D3, corrector UX2-REV-08): `checkInsDone` / `checkOutsDone` son las
  // estancias con check-in / check-out en la fecha de negocio; `checkInsPlanned` /
  // `checkOutsPlanned` son las reservas PENDIENTES de llegar (`confirmed` con
  // llegada) / de salir (`checked_in` con salida) en esa fecha, con la regla del
  // preflight del cierre — no «todo lo planificado», así que hecho/planificado ya
  // no forman una ratio. Nombres conservados (contrato aditivo; docs/api-contracts.md).
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

  // Tanda T8 (T8-E): índice de reputación a 30 días con estado honesto
  // (ok · insufficient · no_reviews · no_sources · module_off); siempre presente.
  reputationIndex?: GmReputationIndex;

  // QC-06: labels of the counters that fell back to 0/null/[] because their
  // query failed. Empty means every KPI above is real.
  degraded: string[];
};

/** Subconjunto del snapshot que necesita el director (tests con fixtures, sin Prisma). */
export type GmReputationSnapshotLike = Pick<ReputationSnapshot, "status" | "index30" | "trendDelta" | "sourcesConnected" | "staleDays">;

export type ComposeGmReputationIndexInput = {
  /** null cuando el módulo está apagado o la lectura cayó al fallback. */
  snapshot: GmReputationSnapshotLike | null;
  /** Fuentes `connected` contadas aparte (null si esa lectura falló). */
  sourcesConnected: number | null;
  /** NPS de los últimos 30 días (null sin encuestas puntuadas o lectura fallida). */
  nps30: number | null;
  moduleEnabled: boolean;
};

/**
 * Bloque `reputationIndex` del director (puro). Módulo apagado → `module_off`;
 * sin snapshot con módulo activo → `no_sources`/`no_reviews` según haya fuentes
 * conectadas (la etiqueta `reputation.index30` en `degraded[]` dice que fue un
 * fallback); si no, el estado del índice a 30 días tal cual.
 */
export function composeGmReputationIndex(input: ComposeGmReputationIndexInput): GmReputationIndex {
  const { snapshot, sourcesConnected, nps30, moduleEnabled } = input;
  const connected = sourcesConnected ?? snapshot?.sourcesConnected ?? 0;
  const npsBlock = nps30 !== null && Number.isFinite(nps30) ? { npsLast30: nps30 } : {};
  if (!moduleEnabled) {
    return { status: "module_off", reviewCount30: 0, ...npsBlock, sourcesConnected: connected, staleDays: 0 };
  }
  if (!snapshot) {
    return { status: connected > 0 ? "no_reviews" : "no_sources", reviewCount30: 0, ...npsBlock, sourcesConnected: connected, staleDays: 0 };
  }
  return {
    status: snapshot.status,
    ...(typeof snapshot.index30.index === "number" ? { index30: snapshot.index30.index } : {}),
    ...(snapshot.trendDelta !== null ? { trendDelta: snapshot.trendDelta } : {}),
    reviewCount30: snapshot.index30.reviewCount,
    ...(typeof snapshot.index30.responseRatePct === "number" ? { responseRatePct: snapshot.index30.responseRatePct } : {}),
    ...npsBlock,
    sourcesConnected: connected,
    staleDays: snapshot.staleDays
  };
}

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
  // QC-06: datasets that fell back to [] because their query failed.
  degraded: string[];
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

function dateOnlyUtc(iso: string): Date {
  return new Date(`${iso}T00:00:00.000Z`);
}

export type GmBusinessDateSource = "business_date" | "utc_day";

export type GmWindow = {
  /** YYYY-MM-DD del día que se pinta. */
  businessDate: string;
  source: GmBusinessDateSource;
  /** [today, tomorrow): medianoche UTC de la fecha de negocio, como toda fecha de reserva. */
  today: Date;
  tomorrow: Date;
};

/**
 * Ventana «hoy» del director (pura): la fecha de negocio de la propiedad cuando
 * hay fila (misma regla que night-audit-preflight.service.ts) y el día natural
 * UTC de `now` cuando no la hay. Una fecha inválida cuenta como «sin fila».
 */
export function resolveGmWindow(input: { businessDate?: string | null; now: Date }): GmWindow {
  const iso = input.businessDate && /^\d{4}-\d{2}-\d{2}$/.test(input.businessDate) ? input.businessDate : null;
  const parsed = iso ? dateOnlyUtc(iso) : null;
  const today = parsed && !Number.isNaN(parsed.getTime()) ? parsed : startOfDayUtc(input.now);
  return {
    businessDate: today.toISOString().slice(0, 10),
    source: parsed && !Number.isNaN(parsed.getTime()) ? "business_date" : "utc_day",
    today,
    tomorrow: new Date(today.getTime() + 86400000)
  };
}

/** Lo que el lector necesita de Prisma (inyectable en tests). */
export type GmBusinessDateClient = {
  businessDate: { findUnique(args: { where: { propertyId: string } }): Promise<{ currentDate: Date } | null> };
};

/**
 * Fecha de negocio (`YYYY-MM-DD`) de la propiedad, leída UNA vez al principio.
 * Mejor esfuerzo como en el preflight: sin fila o con la lectura fallida devuelve
 * undefined (avisado en consola, nunca en silencio) y el panel cae al día UTC.
 */
export async function readGmBusinessDate(propertyId: string, client: GmBusinessDateClient = prisma): Promise<string | undefined> {
  try {
    const row = await client.businessDate.findUnique({ where: { propertyId } });
    return row ? row.currentDate.toISOString().slice(0, 10) : undefined;
  } catch (err) {
    console.warn("[dashboards.general-manager] businessDate lookup failed", {
      propertyId,
      error: err instanceof Error ? err.message : String(err)
    });
    return undefined;
  }
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
    select: { arrivalDate: true, departureDate: true, roomsCount: true },
    take: GM_MAX_RESERVATION_ROWS
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

export async function buildGmDashboard(input: { propertyId: string; asOf?: Date; businessDateClient?: GmBusinessDateClient }): Promise<GmDashboard> {
  const propertyId = input.propertyId;
  const now = input.asOf ?? new Date();
  // Tanda UX-2 (D3): «hoy» = fecha de negocio de la propiedad (la del preflight
  // del cierre); sin fila, el día natural UTC. Mes y año en curso cuelgan de ella.
  const window = resolveGmWindow({ businessDate: await readGmBusinessDate(propertyId, input.businessDateClient), now });
  const today = window.today;
  const tomorrow = window.tomorrow;
  const yesterday = new Date(today.getTime() - 86400000);
  const lastWeek = new Date(today.getTime() - 7 * 86400000);
  const monthStart = startOfMonthUtc(today);
  const yearStart = new Date(Date.UTC(today.getUTCFullYear(), 0, 1));
  const { safe, degraded } = createDegradedCollector("dashboards.general-manager", { propertyId });

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
    // Llegadas y salidas de la fecha de negocio con la regla del preflight del
    // cierre (night-audit-preflight.service.ts): llegadas `confirmed` que aún
    // no han llegado y salidas `checked_in` que aún no han salido.
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
    select: { channel: true, marketSegment: true, totalAmount: true, arrivalDate: true, departureDate: true, roomsCount: true },
    take: GM_MAX_RESERVATION_ROWS
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
    safe("alerts.emergencyIncidents", prisma.workOrder.count({ where: { propertyId, status: { in: ["open", "in_progress"] }, priority: "emergency" } }), 0),
    safe("alerts.openIncidents", prisma.workOrder.count({ where: { propertyId, status: { in: ["open", "in_progress"] } } }), 0),
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
    select: { assignedRoomId: true, arrivalDate: true, departureDate: true },
    take: GM_MAX_RESERVATION_ROWS
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

  // Reputation: one aggregate (count of the last 30 days, average of the rated
  // ones). A storage failure no longer hides behind a silent catch: `safe`
  // logs it, records "reputation.reviews30" in `degraded[]` and leaves the
  // block absent (L2-05, QC-06).
  let reputation: GmDashboard["reputation"] | undefined;
  const reviews30 = await safe(
    "reputation.reviews30",
    prisma.guestReview.aggregate({
      where: { propertyId, createdAt: { gte: new Date(today.getTime() - 30 * 86400000) } },
      _count: { _all: true },
      _avg: { rating: true }
    }),
    null
  );
  if (reviews30 && reviews30._count._all > 0) {
    const avg = reviews30._avg.rating === null ? undefined : Number(reviews30._avg.rating);
    reputation = {
      avgScore: avg ? Math.round(avg * 100) / 100 : undefined,
      reviewsLast30: reviews30._count._all
    };
  }

  // Tanda T8 (T8-E): índice de reputación ADITIVO. El bloque `reputation` de
  // arriba (media simple por createdAt, pinado por l2-paginacion.test.mts:653-666)
  // no cambia; `reputationIndex` añade el IRE a 30 días con estado honesto.
  // Con el módulo apagado no se consulta el índice (un tenant sin módulo no
  // añade etiquetas a `degraded[]`: l2-robustez.test.mts:403-411); las fuentes
  // conectadas y el NPS se leen siempre y resuelven sin error en un tenant vacío.
  const moduleEnabled = (getEnabledModuleCodes(propertyId) as readonly string[]).includes(REPUTATION_MODULE_CODE);
  const snapshot = moduleEnabled ? await safe("reputation.index30", getReputationSnapshot({ propertyId, now }), null) : null;
  // El snapshot nunca lanza: si él mismo cayó al fallback (reputation.module /
  // reputation.reviews) lo decimos con la misma etiqueta.
  if (snapshot && snapshot.degraded.length > 0 && !degraded.includes("reputation.index30")) degraded.push("reputation.index30");
  const sourcesConnected = await safe("reputation.sources", prisma.reviewSource.count({ where: { propertyId, status: "connected" } }), null);
  const nps30 = await safe("reputation.nps30", npsFromSurveys(propertyId, 30), null);
  const reputationIndex = composeGmReputationIndex({ snapshot, sourcesConnected, nps30, moduleEnabled });
  if (reputation && nps30 !== null) reputation = { ...reputation, npsLast30: nps30 };
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
    safe("channelCost.commissionAccrualToday", prisma.commissionAccrual.aggregate({
      where: { propertyId, accruedAt: { gte: today, lt: tomorrow } },
      _sum: { commissionAmount: true }
    }), { _sum: { commissionAmount: null } }),
    safe("channelCost.profitabilitySnapshotToday", prisma.channelProfitabilitySnapshot.findMany({
      where: { propertyId, date: { gte: today, lt: tomorrow } },
      select: { commissionCost: true, paymentCost: true }
    }), [] as Array<{ commissionCost: unknown; paymentCost: unknown }>)
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
    },
    take: GM_MAX_RESERVATION_ROWS
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
    safe("compliance.verifactuPending", prisma.verifactuSubmission.count({
      where: { propertyId, status: { in: FISCAL_PENDING_STATUSES } }
    }), 0),
    safe("compliance.verifactuLastAck", prisma.verifactuSubmission.findFirst({
      where: { propertyId, acknowledgedAt: { not: null } },
      orderBy: { acknowledgedAt: "desc" },
      select: { acknowledgedAt: true }
    }), null),
    safe("compliance.sesPending", prisma.sesHospedajesSubmission.count({
      // Corrector L5 (CS-04, aditivo): las descartadas por el operador (SES_DISCARDED) no están pendientes.
      where: { propertyId, status: { in: SES_PENDING_STATUSES as unknown as Array<"queued"> }, OR: [{ errorCode: null }, { errorCode: { not: "SES_DISCARDED" } }] }
    }), 0),
    safe("compliance.tbaiPending", prisma.tbaiSubmission.count({
      where: { propertyId, status: { in: FISCAL_PENDING_STATUSES } }
    }), 0),
    safe("compliance.tbaiErrors", prisma.tbaiSubmission.count({
      where: { propertyId, status: { in: ["failed", "rejected"] } }
    }), 0)
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
  const lySnapshot = await safe("anomalies.lastYearSnapshot", prisma.revenueDailySnapshot.findFirst({
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
  }), null);
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
    },
    take: GM_MAX_RESERVATION_ROWS
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
            select: { bookerEmail: true },
            take: GM_MAX_RESERVATION_ROWS
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
    asOf: window.businessDate,
    businessDate: window.businessDate,
    businessDateSource: window.source,

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

    reputation,
    reputationIndex,
    degraded
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
  const { safe, degraded } = createDegradedCollector("dashboards.general-manager.pace", { propertyId });
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
    select: { arrivalDate: true, departureDate: true, totalAmount: true, roomsCount: true },
    take: GM_MAX_RESERVATION_ROWS
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
    safe("pace.forecastSnapshots", prisma.revenueForecastSnapshot.findMany({
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
      orderBy: { createdAt: "desc" },
      take: GM_MAX_SNAPSHOT_ROWS
    }), [] as Array<{ forecastDate: Date; expectedTotalRevenue: unknown; expectedRoomRevenue: unknown; modelVersion: string | null; createdAt: Date }>),
    safe("pace.lastYearSnapshots", prisma.revenueDailySnapshot.findMany({
      where: {
        propertyId,
        snapshotDate: { gte: lyStart, lt: lyEnd },
        roomTypeId: null,
        ratePlanId: null,
        channelId: null,
        segment: null,
        market: null
      },
      select: { snapshotDate: true, totalRevenue: true, roomRevenue: true },
      take: GM_MAX_SNAPSHOT_ROWS
    }), [] as Array<{ snapshotDate: Date; totalRevenue: unknown; roomRevenue: unknown }>)
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
    rows,
    degraded
  };
}
