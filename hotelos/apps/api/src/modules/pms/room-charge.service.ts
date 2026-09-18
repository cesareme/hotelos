// Room charge from the rate grid — Finanzas (2026-09-15, lote «pos-noche»).
//
// One place decides what a night costs and how it lands on the folio:
//   · quoteNightlyRate: the price of ONE night for a reservation, read from the
//     rate grid (RateDay) — the reservation's rate plan when it has one, the
//     property's BAR plan otherwise, the lowest published price as a last
//     grid resort — and, only when the grid has nothing, the reservation's own
//     totalAmount split evenly across its nights (last night takes the cent
//     remainder). NEVER an invented 0 €: a night without any price is
//     reported as `price: null` with a warning so the night audit can say
//     «reserva sin tarifa» instead of silently posting nothing (FIN-09/10).
//   · postNightlyRoomChargeTx: the FolioLine of that night on the caller's
//     transaction (type "room", taxCategory "accommodation", Spanish
//     description, idempotent per folio + business day + reservation code).
//   · quoteReservationTotal: the CANONICAL stay quote (Tanda L3 · lote A,
//     decisión §6.1): plan of the reservation → active BAR plan → lowest
//     published price, NEVER a filler. pms.service.createReservation prices a
//     reservation with it when the caller sends no `totalAmount`, and the T8a
//     discount gate measures a negotiated price against the SAME quote; the
//     mass import (T7 `annotateTotals`) and the night audit read it too.
//   · decideReservationPrice: pure decision of what `Reservation.totalAmount`
//     and `price_source` become from (requested total, quote, rooms, flow).
// Money is Prisma.Decimal; the wire shapes carry decimal strings.
import { prisma } from "@hotelos/database";
import type { Prisma } from "@hotelos/database";
import { Prisma as PrismaRuntime } from "@prisma/client";

const Decimal = PrismaRuntime.Decimal;
type Decimal = PrismaRuntime.Decimal;

export const ROOM_CHARGE_LINE_TYPE = "room";
export const ROOM_CHARGE_TAX_CATEGORY = "accommodation";

export type NightlyPriceSource = "rate_plan" | "lowest_published" | "reservation_total" | "none";

export type NightlyRateQuote = {
  /** Calendar night `YYYY-MM-DD`. */
  date: string;
  /** Decimal string (2 decimals) or null when nothing prices the night. */
  price: string | null;
  currency: string;
  source: NightlyPriceSource;
  ratePlanId: string | null;
  roomTypeId: string | null;
  warning: string | null;
};

type RateClient = Pick<Prisma.TransactionClient, "rateDay" | "ratePlan" | "room">;

function dayUtc(iso: string): Date {
  return new Date(`${iso}T00:00:00.000Z`);
}

export function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Nights between two calendar days (arrival inclusive, departure exclusive), at least 1. Pure. */
export function nightsBetween(arrival: Date, departure: Date): number {
  return Math.max(1, Math.round((dayUtc(isoDay(departure)).getTime() - dayUtc(isoDay(arrival)).getTime()) / 86_400_000));
}

/** `dd/mm/yyyy` of a calendar day. Pure. */
export function formatDayEs(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
}

/**
 * Splits a stay total across its nights to the cent: every night gets
 * round-down(total / nights) and the LAST night takes the remainder, so
 * 100 € / 3 = 33,33 · 33,33 · 33,34. Pure.
 */
export function splitTotalAcrossNights(total: number | string | Decimal, nights: number): string[] {
  if (!Number.isInteger(nights) || nights < 1) throw new Error(`Número de noches no válido: ${String(nights)}`);
  const amount = new Decimal(total).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  const base = amount.div(nights).toDecimalPlaces(2, Decimal.ROUND_DOWN);
  const parts = Array.from({ length: nights }, () => base);
  const remainder = amount.minus(base.mul(nights));
  parts[nights - 1] = base.plus(remainder);
  return parts.map((p) => p.toFixed(2));
}

/** Description of the nightly room charge (what the guest reads on the invoice). Pure. */
export function roomChargeDescription(businessDate: string, reservationCode: string, roomTypeName?: string | null): string {
  const type = roomTypeName ? ` · ${roomTypeName}` : "";
  return `Alojamiento ${formatDayEs(businessDate)} · ${reservationCode}${type}`;
}

/** Prefix shared by every nightly charge of a business day (idempotency key with the reservation code). Pure. */
export function roomChargeKeyPrefix(businessDate: string, reservationCode: string): string {
  return `Alojamiento ${formatDayEs(businessDate)} · ${reservationCode}`;
}

/**
 * Price of ONE night for a reservation. Grid first (plan → BAR → lowest),
 * then the reservation's own total split across nights, else null.
 */
export async function quoteNightlyRate(
  client: RateClient,
  input: {
    propertyId: string;
    date: string;
    reservation: { roomTypeId: string | null; ratePlanId: string | null; assignedRoomId: string | null; totalAmount: Prisma.Decimal | number | string; arrivalDate: Date; departureDate: Date; currency: string };
  }
): Promise<NightlyRateQuote> {
  const { reservation } = input;
  const day = dayUtc(input.date);
  let roomTypeId = reservation.roomTypeId;
  if (!roomTypeId && reservation.assignedRoomId) {
    const room = await client.room.findUnique({ where: { id: reservation.assignedRoomId }, select: { roomTypeId: true } });
    roomTypeId = room?.roomTypeId ?? null;
  }
  const empty = (source: NightlyPriceSource, warning: string | null, price: string | null, ratePlanId: string | null, currency = reservation.currency || "EUR"): NightlyRateQuote => ({
    date: input.date,
    price,
    currency,
    source,
    ratePlanId,
    roomTypeId,
    warning
  });

  if (roomTypeId) {
    if (reservation.ratePlanId) {
      const cell = await client.rateDay.findUnique({
        where: { propertyId_ratePlanId_roomTypeId_date: { propertyId: input.propertyId, ratePlanId: reservation.ratePlanId, roomTypeId, date: day } },
        select: { price: true, currency: true }
      });
      if (cell && new Decimal(cell.price).gt(0)) return empty("rate_plan", null, new Decimal(cell.price).toFixed(2), reservation.ratePlanId, cell.currency);
    }
    const bar = await client.ratePlan.findFirst({
      where: { propertyId: input.propertyId, active: true, ratePlanType: "bar" },
      orderBy: [{ code: "asc" }],
      select: { id: true }
    });
    if (bar && bar.id !== reservation.ratePlanId) {
      const cell = await client.rateDay.findUnique({
        where: { propertyId_ratePlanId_roomTypeId_date: { propertyId: input.propertyId, ratePlanId: bar.id, roomTypeId, date: day } },
        select: { price: true, currency: true }
      });
      if (cell && new Decimal(cell.price).gt(0)) return empty("rate_plan", null, new Decimal(cell.price).toFixed(2), bar.id, cell.currency);
    }
    const lowest = await client.rateDay.findFirst({
      where: { propertyId: input.propertyId, roomTypeId, date: day, price: { gt: 0 } },
      orderBy: [{ price: "asc" }, { ratePlanId: "asc" }],
      select: { price: true, currency: true, ratePlanId: true }
    });
    if (lowest) return empty("lowest_published", null, new Decimal(lowest.price).toFixed(2), lowest.ratePlanId, lowest.currency);
  }

  const total = new Decimal(reservation.totalAmount);
  if (total.gt(0)) {
    const nights = nightsBetween(reservation.arrivalDate, reservation.departureDate);
    const index = Math.round((day.getTime() - dayUtc(isoDay(reservation.arrivalDate)).getTime()) / 86_400_000);
    const parts = splitTotalAcrossNights(total, nights);
    const price = parts[Math.min(Math.max(index, 0), nights - 1)] ?? parts[nights - 1]!;
    return empty("reservation_total", "Sin tarifa publicada para la noche: importe tomado del total de la reserva.", price, null);
  }
  return empty("none", "Reserva sin tarifa ni importe: no se ha cargado el alojamiento.", null, null);
}

export type PostNightlyRoomChargeResult = {
  created: boolean;
  lineId: string;
  folioId: string;
  total: string;
  description: string;
};

type FolioClient = Pick<Prisma.TransactionClient, "folio" | "folioLine">;

/**
 * Posts the room charge of `businessDate` on an OPEN folio, once: a line of
 * type "room" whose description starts with the (date, reservation code) key
 * is the same night already charged. Throws when the folio is not open.
 */
export async function postNightlyRoomChargeTx(
  tx: FolioClient,
  input: { folioId: string; reservationCode: string; businessDate: string; unitPrice: string; postedBy: string | null; roomTypeName?: string | null }
): Promise<PostNightlyRoomChargeResult> {
  const folio = await tx.folio.findUnique({ where: { id: input.folioId }, select: { id: true, status: true } });
  if (!folio) throw new Error(`El folio ${input.folioId} no existe.`);
  if (folio.status !== "open") throw new Error(`El folio ${input.folioId} está cerrado; no admite el cargo de alojamiento.`);
  const prefix = roomChargeKeyPrefix(input.businessDate, input.reservationCode);
  const existing = await tx.folioLine.findFirst({
    where: { folioId: folio.id, type: ROOM_CHARGE_LINE_TYPE, deletedAt: null, description: { startsWith: prefix } },
    select: { id: true, total: true, description: true },
    orderBy: { postedAt: "asc" }
  });
  if (existing) {
    return { created: false, lineId: existing.id, folioId: folio.id, total: new Decimal(existing.total).toFixed(2), description: existing.description };
  }
  const total = new Decimal(input.unitPrice).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  if (total.lte(0)) throw new Error("El cargo de alojamiento debe ser positivo.");
  const description = roomChargeDescription(input.businessDate, input.reservationCode, input.roomTypeName);
  const created = await tx.folioLine.create({
    data: {
      folioId: folio.id,
      type: ROOM_CHARGE_LINE_TYPE,
      description,
      quantity: 1,
      unitPrice: total.toFixed(2),
      taxCode: null,
      taxCategory: ROOM_CHARGE_TAX_CATEGORY,
      total: total.toFixed(2),
      postedBy: input.postedBy
    },
    select: { id: true }
  });
  return { created: true, lineId: created.id, folioId: folio.id, total: total.toFixed(2), description };
}

export type ReservationTotalQuote = {
  total: string;
  currency: string;
  nights: number;
  nightsWithoutRate: number;
  priceSource: "rate_plan" | "partial" | "none";
  nightly: NightlyRateQuote[];
};

/**
 * Stay total from the grid for reservation creation (one room; multiply by
 * roomsCount at the caller). Nights the grid does not price are reported and
 * NOT filled with a fallback: `priceSource: "partial" | "none"` tells the
 * caller to warn instead of persisting an invented price.
 */
export async function quoteReservationTotal(input: {
  propertyId: string;
  roomTypeId: string;
  ratePlanId?: string | null;
  arrivalDate: string;
  departureDate: string;
  client?: RateClient;
}): Promise<ReservationTotalQuote> {
  const client = input.client ?? prisma;
  const arrival = dayUtc(input.arrivalDate);
  const departure = dayUtc(input.departureDate);
  const nights = nightsBetween(arrival, departure);
  const nightly: NightlyRateQuote[] = [];
  let total = new Decimal(0);
  let currency = "EUR";
  let nightsWithoutRate = 0;
  for (let i = 0; i < nights; i++) {
    const date = isoDay(new Date(arrival.getTime() + i * 86_400_000));
    const quote = await quoteNightlyRate(client, {
      propertyId: input.propertyId,
      date,
      reservation: { roomTypeId: input.roomTypeId, ratePlanId: input.ratePlanId ?? null, assignedRoomId: null, totalAmount: 0, arrivalDate: arrival, departureDate: departure, currency }
    });
    nightly.push(quote);
    if (quote.price === null) nightsWithoutRate += 1;
    else {
      total = total.plus(new Decimal(quote.price));
      currency = quote.currency || currency;
    }
  }
  return {
    total: total.toFixed(2),
    currency,
    nights,
    nightsWithoutRate,
    priceSource: nightsWithoutRate === 0 ? "rate_plan" : nightsWithoutRate === nights ? "none" : "partial",
    nightly
  };
}

// ---------------------------------------------------------------------------
// Reservation price decision (Tanda L3 · lote A)
// ---------------------------------------------------------------------------

/**
 * Origin of `Reservation.totalAmount` (column `reservations.price_source`,
 * migration 20260918150000_dinero_fiscal):
 *   manual    — total sent by the caller (typed / negotiated; the T8a discount
 *               gate has already measured it against the quote);
 *   rate_plan — quoted from the grid, every night priced;
 *   partial   — the grid priced only some nights → total left at 0 (§6.2: no
 *               invented price; the caller warns);
 *   none      — no night priced → 0;
 *   file      — total read from an import file / PMS feed (import flow).
 * The importer may pass its own `quoted` (T7 `totalSource quoted`) through
 * `createReservation({ priceSource })`; this helper never produces it.
 */
export type ReservationPriceSource = "manual" | "rate_plan" | "partial" | "none" | "file";

export type ReservationPriceDecision = {
  /** Two-decimal number, ≥ 0. */
  totalAmount: number;
  priceSource: ReservationPriceSource;
  /** Plan that priced the first quoted night (null when nothing priced) — differs from the requested plan when BAR / lowest stepped in. */
  quotedRatePlanId: string | null;
};

/** Plan that priced the first night with a price (rate_plan / lowest_published), null when no night has one. Pure. */
export function quotedRatePlanIdOf(quote: ReservationTotalQuote | null): string | null {
  if (!quote) return null;
  const priced = quote.nightly.find((night) => night.price !== null);
  return priced?.ratePlanId ?? null;
}

/**
 * What a new reservation costs and where the figure comes from. Pure:
 *   · a requested total wins (rounded to the cent): `manual`, or `file` in the
 *     import flow (the PMS/file figure is not a decision of the actor);
 *   · otherwise a fully priced quote → `Number(quote.total) × roomsCount`
 *     (quote.total is the stay of ONE room), rounded half-up to 2 decimals,
 *     `rate_plan`;
 *   · a partial / empty quote (or no quote at all) → 0 with that source, so the
 *     caller can warn instead of persisting an invented price (§6.2, coherent
 *     with T7 `TOTAL_NOT_QUOTED`).
 */
export function decideReservationPrice(input: {
  requestedTotal?: number;
  quote: ReservationTotalQuote | null;
  roomsCount: number;
  importFlow: boolean;
}): ReservationPriceDecision {
  const quotedRatePlanId = quotedRatePlanIdOf(input.quote);
  const rooms = Number.isInteger(input.roomsCount) && input.roomsCount >= 1 ? input.roomsCount : 1;
  if (input.requestedTotal !== undefined) {
    if (!Number.isFinite(input.requestedTotal) || input.requestedTotal < 0) throw new Error(`Importe de reserva no válido: ${String(input.requestedTotal)}`);
    const total = new Decimal(input.requestedTotal).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toNumber();
    return { totalAmount: total, priceSource: input.importFlow ? "file" : "manual", quotedRatePlanId };
  }
  if (input.quote && input.quote.priceSource === "rate_plan") {
    const total = new Decimal(input.quote.total).mul(rooms).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toNumber();
    return { totalAmount: total, priceSource: "rate_plan", quotedRatePlanId };
  }
  return { totalAmount: 0, priceSource: input.quote ? input.quote.priceSource : "none", quotedRatePlanId };
}
