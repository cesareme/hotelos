// Drivers de la previsión de plantilla · Tanda RRHH · RRHH-3 (diseño §5 «Entrada»).
//
// Un driver por centro y día con `source` y motivos de degradación, leído SOLO por los tres
// lectores existentes de ocupación (D §3 «Ocupación real y prevista»):
//   · pasado (< hoy): `getRealizedByDay` (revenue/actuals.ts:399): rooms, arrivals, departures, pax
//     (cierre auditado primero, reservas como fallback) → source `actual`; un día sin cierre cuyo
//     fallback por reservas es 0 habitaciones NO es un realizado (el hotel aún no opera en el PMS o
//     no hay carga): queda `degraded` (`no_realized_data`) sin FTE inventado (patrón de honestidad
//     D §1 / §13; corrector RRHH · RF-04);
//   · futuro (≥ hoy): OTB por día con `expand` (revenue/pace.service.ts:53) fusionado con la
//     previsión por día (revenue_forecasts: top-level si existe, si no agregado por tipo, como
//     hf-board.service.ts:466-481): rooms = max(OTB, previsión) y source `pms_forecast`
//     (model_version `pms_import:*`) o `deterministic`; regla dura (D §1.1): la previsión
//     `deterministic-v1` NUNCA es driver sin OTB corroborante ese día; sin OTB ni previsión el
//     día queda `degraded` (`no_otb_no_forecast`) y el motor no inventa FTE;
//   · llegadas / salidas futuras = rooms / LOS medio de los últimos 28 días reales (Σ ocupadas /
//     Σ llegadas); sin llegadas reales, LOS de las reservas OTB de la ventana; sin ninguna, null
//     (`los_unknown`) — nunca 0;
//   · pax futuros = rooms × pax por habitación de los 28 días reales (fallback: reservas OTB);
//   · cubiertos (proxy boardType × pax, D §5): desayuno RO 0 · BB/HB/FB/AI 1; restaurante HB 1 ·
//     FB/AI 2; mezcla de régimen del día (reservas con boardType conocido) o de la ventana; sin
//     ningún régimen conocido, null (`covers_unknown`).
// `buildLaborDrivers` es pura (tests con filas sintéticas); `loadLaborDrivers` hace las consultas.

import { prisma } from "@hotelos/database";
import type { HrDegradedEntry, LaborForecastSource } from "@hotelos/shared";
import { addDays, dayUtc, getRealizedByDay, isoDate, type RealizedDay } from "../revenue/actuals.js";
import { expand, type ResRow } from "../revenue/pace.service.js";
import type { EngineDrivers } from "./labor-forecast.engine.js";

export const LOS_WINDOW_DAYS = 28;
/** Ventana máxima de una previsión (días): dos temporadas de 14/28 días con margen. */
export const LABOR_FORECAST_MAX_DAYS = 92;

export type DriverReservationRow = ResRow & { adults: number; children: number; boardType: string | null; status: string };
export type DriverForecastRow = {
  forecastDate: Date;
  roomTypeId: string | null;
  ratePlanId: string | null;
  channelId: string | null;
  segment: string | null;
  expectedRoomsSold: unknown;
  modelVersion: string | null;
};

export type BoardMeals = { breakfast: number; restaurant: number };
/** Comidas por pax y día según régimen (D §5: RO 0 · BB 1 · HB 2 · FB 3 · AI 3). */
export const BOARD_MEALS: Record<string, BoardMeals> = {
  RO: { breakfast: 0, restaurant: 0 },
  BB: { breakfast: 1, restaurant: 0 },
  HB: { breakfast: 1, restaurant: 1 },
  FB: { breakfast: 1, restaurant: 2 },
  AI: { breakfast: 1, restaurant: 2 }
};

export function boardMealsOf(boardType: string | null | undefined): BoardMeals | null {
  if (!boardType) return null;
  return BOARD_MEALS[boardType.trim().toUpperCase()] ?? null;
}

export type LaborDriversWindow = {
  propertyId: string;
  from: string;
  to: string;
  today: string;
  roomsInventory: number;
  /** LOS medio de los 28 días reales (o de las reservas OTB); null si no se puede calcular. */
  averageLos: number | null;
  losSource: "realized" | "otb" | null;
  paxPerRoom: number | null;
  days: EngineDrivers[];
  degraded: HrDegradedEntry[];
};

export type BuildLaborDriversInput = {
  propertyId: string;
  from: string;
  to: string;
  today: string;
  roomsInventory: number;
  /** Días realizados de [from, min(to, ayer)] (getRealizedByDay). */
  realized: ReadonlyMap<string, RealizedDay>;
  /** Últimos 28 días reales antes de hoy (LOS y pax por habitación). */
  losWindow: ReadonlyMap<string, RealizedDay>;
  /** Reservas que solapan [from, to] (OTB futuro, régimen y LOS de reserva). */
  reservations: readonly DriverReservationRow[];
  /** revenue_forecasts de [hoy, to]. */
  forecasts: readonly DriverForecastRow[];
};

const MS_DAY = 86_400_000;
const OTB_STATUSES = new Set(["confirmed", "checked_in"]);
const PAST_STATUSES = new Set(["confirmed", "checked_in", "checked_out"]);

function num(v: unknown): number {
  if (v === null || v === undefined) return 0;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}
const round2 = (n: number): number => Math.round(n * 100) / 100;

type DayMix = { paxKnown: number; breakfast: number; restaurant: number; bookedPax: number; bookedArrivals: number; bookedDepartures: number };

function ensureMix(map: Map<string, DayMix>, key: string): DayMix {
  let m = map.get(key);
  if (!m) {
    m = { paxKnown: 0, breakfast: 0, restaurant: 0, bookedPax: 0, bookedArrivals: 0, bookedDepartures: 0 };
    map.set(key, m);
  }
  return m;
}

/** Kind of the day's forecast rows by model_version (top-level rows first, per hf-board). */
export function forecastKindOf(modelVersion: string | null | undefined): Extract<LaborForecastSource, "pms_forecast" | "deterministic"> {
  return modelVersion && modelVersion.startsWith("pms_import") ? "pms_forecast" : "deterministic";
}

/** LOS medio = Σ habitaciones ocupadas / Σ llegadas de la ventana realizada (null sin llegadas). */
export function averageLosOf(days: Iterable<RealizedDay>): number | null {
  let rooms = 0;
  let arrivals = 0;
  for (const d of days) {
    rooms += d.rooms;
    arrivals += d.arrivals;
  }
  return arrivals > 0 ? rooms / arrivals : null;
}

export function paxPerRoomOf(days: Iterable<RealizedDay>): number | null {
  let rooms = 0;
  let pax = 0;
  for (const d of days) {
    rooms += d.rooms;
    pax += d.pax;
  }
  return rooms > 0 ? pax / rooms : null;
}

/** LOS y pax por habitación de las reservas OTB (fallback sin histórico). */
export function reservationRatios(rows: readonly DriverReservationRow[]): { los: number | null; paxPerRoom: number | null } {
  let nights = 0;
  let reservations = 0;
  let pax = 0;
  for (const r of rows) {
    if (!OTB_STATUSES.has(r.status)) continue;
    const n = Math.max(1, Math.round((dayUtc(r.departureDate).getTime() - dayUtc(r.arrivalDate).getTime()) / MS_DAY));
    nights += n * r.roomsCount;
    reservations += r.roomsCount;
    pax += (r.adults + r.children) * n;
  }
  return { los: reservations > 0 ? nights / reservations : null, paxPerRoom: nights > 0 ? pax / nights : null };
}

export function buildLaborDrivers(input: BuildLaborDriversInput): LaborDriversWindow {
  const from = dayUtc(input.from);
  const to = dayUtc(input.to);
  const today = dayUtc(input.today);
  const degraded: HrDegradedEntry[] = [];

  // Mezcla de régimen y valores reservados por día (pasado: estados realizados; futuro: OTB).
  const mixByDay = new Map<string, DayMix>();
  const windowMix: DayMix = { paxKnown: 0, breakfast: 0, restaurant: 0, bookedPax: 0, bookedArrivals: 0, bookedDepartures: 0 };
  for (const r of input.reservations) {
    const arr = dayUtc(r.arrivalDate);
    const dep = dayUtc(r.departureDate);
    const n = Math.max(1, Math.round((dep.getTime() - arr.getTime()) / MS_DAY));
    // Pax de la reserva (adultos + niños), no por habitación: misma semántica que hf-board.service.ts.
    const pax = r.adults + r.children;
    const meals = boardMealsOf(r.boardType);
    const arrKey = isoDate(arr);
    const depKey = isoDate(dep);
    const isFutureOk = OTB_STATUSES.has(r.status);
    if (isFutureOk && arr.getTime() >= today.getTime() && arr.getTime() <= to.getTime()) ensureMix(mixByDay, arrKey).bookedArrivals += r.roomsCount;
    if (isFutureOk && dep.getTime() >= today.getTime() && dep.getTime() <= to.getTime()) ensureMix(mixByDay, depKey).bookedDepartures += r.roomsCount;
    for (let i = 0; i < n; i++) {
      const d = addDays(arr, i);
      if (d.getTime() < from.getTime() || d.getTime() > to.getTime()) continue;
      const past = d.getTime() < today.getTime();
      if (past ? !PAST_STATUSES.has(r.status) : !OTB_STATUSES.has(r.status)) continue;
      const m = ensureMix(mixByDay, isoDate(d));
      m.bookedPax += pax;
      if (meals) {
        m.paxKnown += pax;
        m.breakfast += pax * meals.breakfast;
        m.restaurant += pax * meals.restaurant;
        windowMix.paxKnown += pax;
        windowMix.breakfast += pax * meals.breakfast;
        windowMix.restaurant += pax * meals.restaurant;
      }
    }
  }

  // OTB por día (misma semántica que el pace): solo reservas vivas.
  const otbRows = input.reservations.filter((r) => OTB_STATUSES.has(r.status));
  const otb = expand(otbRows, today, addDays(to, 1));

  // Previsión por día: top-level si existe alguna, si no agregado por tipo (hf-board :466-470).
  const topLevel = input.forecasts.filter((f) => !f.roomTypeId && !f.ratePlanId && !f.channelId && !f.segment);
  const forecastSource = topLevel.length > 0 ? topLevel : input.forecasts;
  const fcByDay = new Map<string, { rooms: number; kind: "pms_forecast" | "deterministic" }>();
  for (const f of forecastSource) {
    const key = isoDate(dayUtc(f.forecastDate));
    const kind = forecastKindOf(f.modelVersion);
    const cur = fcByDay.get(key) ?? { rooms: 0, kind };
    cur.rooms += num(f.expectedRoomsSold);
    if (kind === "pms_forecast") cur.kind = "pms_forecast";
    fcByDay.set(key, cur);
  }

  const losRealized = averageLosOf(input.losWindow.values());
  const paxRealized = paxPerRoomOf(input.losWindow.values());
  const ratios = reservationRatios(otbRows);
  const averageLos = losRealized ?? ratios.los;
  const losSource: LaborDriversWindow["losSource"] = losRealized !== null ? "realized" : ratios.los !== null ? "otb" : null;
  const paxPerRoom = paxRealized ?? ratios.paxPerRoom;
  if (to.getTime() >= today.getTime() && averageLos === null) {
    degraded.push({ code: "HR_DRIVERS_LOS_UNKNOWN", message: "Sin llegadas reales en los últimos 28 días ni reservas OTB: no se estiman llegadas ni salidas futuras.", propertyId: input.propertyId });
  }

  const days: EngineDrivers[] = [];
  const totalDays = Math.round((to.getTime() - from.getTime()) / MS_DAY) + 1;
  for (let i = 0; i < totalDays; i++) {
    const d = addDays(from, i);
    const key = isoDate(d);
    const mix = mixByDay.get(key);
    const reasons: string[] = [];
    let rooms: number | null = null;
    let arrivals: number | null = null;
    let departures: number | null = null;
    let pax: number | null = null;
    let source: LaborForecastSource | null = null;

    if (d.getTime() < today.getTime()) {
      const real = input.realized.get(key);
      if (real && !(real.source === "reservations" && real.rooms === 0)) {
        rooms = real.rooms;
        arrivals = real.arrivals;
        departures = real.departures;
        pax = real.pax;
        source = "actual";
      } else {
        // Sin cierre auditado y sin ninguna estancia real ese día: no hay dato realizado, no un 0 (RF-04).
        reasons.push(real ? "no_realized_data" : "actual_missing");
      }
    } else {
      const otbRooms = otb.get(key)?.rooms ?? 0;
      const fc = fcByDay.get(key);
      if (fc && fc.kind === "pms_forecast") {
        rooms = Math.max(otbRooms, fc.rooms);
        source = fc.rooms >= otbRooms ? "pms_forecast" : "otb";
      } else if (fc && fc.kind === "deterministic") {
        if (otbRooms > 0) {
          rooms = Math.max(otbRooms, fc.rooms);
          source = fc.rooms > otbRooms ? "deterministic" : "otb";
        } else {
          reasons.push("deterministic_without_otb");
        }
      } else if (otbRooms > 0) {
        rooms = otbRooms;
        source = "otb";
      } else {
        reasons.push("no_otb_no_forecast");
      }
      if (rooms !== null) {
        if (averageLos !== null && averageLos > 0) {
          arrivals = round2(rooms / averageLos);
          departures = arrivals;
        } else if (source === "otb" && mix) {
          arrivals = mix.bookedArrivals;
          departures = mix.bookedDepartures;
        } else {
          reasons.push("los_unknown");
        }
        if (paxPerRoom !== null) pax = round2(rooms * paxPerRoom);
        else if (source === "otb" && mix) pax = mix.bookedPax;
        else reasons.push("pax_unknown");
      }
    }

    let coversBreakfast: number | null = null;
    let coversRestaurant: number | null = null;
    if (pax !== null) {
      if (pax === 0) {
        coversBreakfast = 0;
        coversRestaurant = 0;
      } else {
        const m = mix && mix.paxKnown > 0 ? mix : windowMix.paxKnown > 0 ? windowMix : null;
        if (m) {
          coversBreakfast = round2((pax * m.breakfast) / m.paxKnown);
          coversRestaurant = round2((pax * m.restaurant) / m.paxKnown);
        } else {
          reasons.push("covers_unknown");
        }
      }
    }

    if (reasons.length > 0) {
      degraded.push({ code: "HR_DRIVERS_DEGRADED", message: `Drivers incompletos el ${key}: ${reasons.join(", ")}.`, propertyId: input.propertyId, date: key });
    }
    days.push({ date: key, rooms, arrivals, departures, pax, coversBreakfast, coversRestaurant, roomsInventory: input.roomsInventory, source, degraded: reasons });
  }

  return { propertyId: input.propertyId, from: isoDate(from), to: isoDate(to), today: isoDate(today), roomsInventory: input.roomsInventory, averageLos: averageLos === null ? null : round2(averageLos), losSource, paxPerRoom: paxPerRoom === null ? null : round2(paxPerRoom), days, degraded };
}

/** Carga los drivers de [from, to] con las consultas mínimas (una por fuente) y construye la ventana. */
export async function loadLaborDrivers(input: { propertyId: string; from: string; to: string; today?: Date }): Promise<LaborDriversWindow> {
  const today = dayUtc(input.today);
  const from = dayUtc(input.from);
  const to = dayUtc(input.to);
  const losFrom = addDays(today, -LOS_WINDOW_DAYS);
  const [roomsInventory, realized, losWindow, reservations, forecasts] = await Promise.all([
    prisma.room.count({ where: { propertyId: input.propertyId, active: true } }),
    getRealizedByDay(input.propertyId, from, to, { today }),
    getRealizedByDay(input.propertyId, losFrom, addDays(today, -1), { today }),
    prisma.reservation.findMany({
      where: { propertyId: input.propertyId, status: { in: ["confirmed", "checked_in", "checked_out"] }, arrivalDate: { lte: to }, departureDate: { gt: from } },
      select: { arrivalDate: true, departureDate: true, roomsCount: true, totalAmount: true, createdAt: true, adults: true, children: true, boardType: true, status: true }
    }),
    to.getTime() >= today.getTime()
      ? prisma.revenueForecast.findMany({
          where: { propertyId: input.propertyId, forecastDate: { gte: today, lte: to } },
          select: { forecastDate: true, roomTypeId: true, ratePlanId: true, channelId: true, segment: true, expectedRoomsSold: true, modelVersion: true }
        })
      : Promise.resolve([])
  ]);
  return buildLaborDrivers({
    propertyId: input.propertyId,
    from: isoDate(from),
    to: isoDate(to),
    today: isoDate(today),
    roomsInventory,
    realized: realized.days,
    losWindow: losWindow.days,
    reservations: reservations.map((r) => ({ ...r, status: String(r.status) })),
    forecasts
  });
}
