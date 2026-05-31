// Tourist tax engine — España multi-CCAA con calendar fiscal.
//
// Punto único de aplicación para todas las jurisdicciones españolas que
// recaudan tasa turística (Cataluña, Baleares, Canarias en estudio, etc.).
//
// API pública:
//   - `findApplicableRate(input)` — dado un hotel + clase + rango de fechas,
//     devuelve qué tarifa aplicar (resolución por calendar fiscal).
//   - `computeTouristTax(input)` — pre-cálculo: cuánto hay que cobrar.
//   - `applyTouristTaxToFolio(input)` — escribe el cargo en el folio primario,
//     registra `TouristTaxApplication` y devuelve el resultado.
//   - `listApplicationsForPeriod(input)` — informe trimestral autoliquidable.
//
// Diseño honesto: nada se calcula a ojo. La tarifa se snapshotea en
// `TouristTaxApplication.amountPerPersonNight` para que un cambio retroactivo
// de la tabla no altere lo ya facturado.

import { prisma } from "@hotelos/database";
import type { Prisma } from "@hotelos/database";
import type { UserContext } from "../../lib/demo-store.js";
import { requirePermissions } from "../auth/auth.service.js";
import { BadRequestError, NotFoundError } from "../../lib/http-error.js";

const MS_PER_DAY = 86_400_000;

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function startOfDayUtc(iso: string): Date {
  return new Date(`${iso.slice(0, 10)}T00:00:00.000Z`);
}

function daysBetween(from: Date, until: Date): number {
  return Math.max(0, Math.round((until.getTime() - from.getTime()) / MS_PER_DAY));
}

function isHighSeason(date: Date, fromMmdd: string | null, untilMmdd: string | null): boolean {
  if (!fromMmdd || !untilMmdd) return false;
  const mmdd = `${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
  // Handle wrap-around (rare for ES taxes, but defensive).
  if (fromMmdd <= untilMmdd) return mmdd >= fromMmdd && mmdd <= untilMmdd;
  return mmdd >= fromMmdd || mmdd <= untilMmdd;
}

// ---------------------------------------------------------------------------
// Rate catalogue
// ---------------------------------------------------------------------------

export type RateLookupInput = {
  ccaaCode: string;
  municipality?: string | null;
  establishmentClass: string;
  /** ISO date — typically the arrival or any night of the stay. */
  onDate: string;
};

export async function findApplicableRate(input: RateLookupInput) {
  const onDate = startOfDayUtc(input.onDate);
  // Most-specific match first: municipality + ccaa, then ccaa-wide.
  const candidates = await prisma.touristTaxRate.findMany({
    where: {
      ccaaCode: input.ccaaCode,
      establishmentClass: input.establishmentClass,
      validFrom: { lte: onDate },
      OR: [{ validUntil: null }, { validUntil: { gte: onDate } }]
    },
    orderBy: [{ municipality: "desc" }, { validFrom: "desc" }]
  });

  if (input.municipality) {
    const muni = candidates.find((r) => r.municipality === input.municipality);
    if (muni) return muni;
  }
  // Fall back to CCAA-level (municipality=null).
  return candidates.find((r) => r.municipality === null) ?? null;
}

// ---------------------------------------------------------------------------
// Compute (pre-charge)
// ---------------------------------------------------------------------------

export type ComputeInput = {
  ccaaCode: string;
  municipality?: string | null;
  establishmentClass: string;
  adults: number;
  children?: number;
  // Edad del menor de cada child, si la hay (para validar exenciones).
  childAges?: number[];
  arrivalDate: string;
  departureDate: string;
};

export type ComputeResult = {
  ok: boolean;
  reason?: string;
  rate?: {
    id: string;
    amountPerPersonNight: number;
    currency: string;
    maxNightsPerStay: number;
    taxableAgeFrom: number;
    legalSource: string | null;
  };
  adultsTaxable: number;
  childrenTaxable: number;
  nightsTaxable: number;
  totalAmount: number;
  currency: string;
  // Per-night breakdown including high-season surcharge if any.
  perNight: Array<{ date: string; amountPerPersonNight: number; highSeason: boolean }>;
};

export async function computeTouristTax(input: ComputeInput): Promise<ComputeResult> {
  const rate = await findApplicableRate({
    ccaaCode: input.ccaaCode,
    municipality: input.municipality,
    establishmentClass: input.establishmentClass,
    onDate: input.arrivalDate
  });
  if (!rate) {
    return {
      ok: false,
      reason: "no_rate_found",
      adultsTaxable: 0,
      childrenTaxable: 0,
      nightsTaxable: 0,
      totalAmount: 0,
      currency: "EUR",
      perNight: []
    };
  }

  const arrival = startOfDayUtc(input.arrivalDate);
  const departure = startOfDayUtc(input.departureDate);
  const totalNights = daysBetween(arrival, departure);
  if (totalNights <= 0) {
    return {
      ok: false,
      reason: "non_positive_nights",
      adultsTaxable: 0,
      childrenTaxable: 0,
      nightsTaxable: 0,
      totalAmount: 0,
      currency: rate.currency,
      perNight: []
    };
  }
  const nightsTaxable = rate.maxNightsPerStay > 0 ? Math.min(totalNights, rate.maxNightsPerStay) : totalNights;

  // Children are taxable if their age >= rate.taxableAgeFrom.
  const childAges = input.childAges ?? [];
  const childrenTaxable = childAges.filter((age) => age >= rate.taxableAgeFrom).length;
  const adultsTaxable = Math.max(0, input.adults);
  const peopleTaxable = adultsTaxable + childrenTaxable;

  const base = Number(rate.amountPerPersonNight);
  const surcharge = Number(rate.highSeasonSurcharge ?? 0);
  const perNight: ComputeResult["perNight"] = [];
  let total = 0;
  for (let i = 0; i < nightsTaxable; i++) {
    const nightDate = new Date(arrival.getTime() + i * MS_PER_DAY);
    const high = isHighSeason(nightDate, rate.highSeasonFromMmdd, rate.highSeasonUntilMmdd);
    const amt = high && surcharge ? Math.round(base * (1 + surcharge) * 10000) / 10000 : base;
    perNight.push({ date: ymd(nightDate), amountPerPersonNight: amt, highSeason: high });
    total += amt * peopleTaxable;
  }
  total = Math.round(total * 100) / 100;

  return {
    ok: true,
    rate: {
      id: rate.id,
      amountPerPersonNight: base,
      currency: rate.currency,
      maxNightsPerStay: rate.maxNightsPerStay,
      taxableAgeFrom: rate.taxableAgeFrom,
      legalSource: rate.legalSource ?? null
    },
    adultsTaxable,
    childrenTaxable,
    nightsTaxable,
    totalAmount: total,
    currency: rate.currency,
    perNight
  };
}

// ---------------------------------------------------------------------------
// Apply to a reservation's folio
// ---------------------------------------------------------------------------

export async function applyTouristTaxToFolio(input: {
  context: UserContext;
  reservationId: string;
  // Optional override: if not provided, we derive from Property + Reservation.
  ccaaCode?: string;
  municipality?: string | null;
  establishmentClass?: string;
}) {
  requirePermissions(input.context, ["folio.charge.post"]);

  const reservation = await prisma.reservation.findUnique({ where: { id: input.reservationId } });
  if (!reservation) throw new NotFoundError("Reserva no encontrada.");
  const property = await prisma.property.findUnique({ where: { id: reservation.propertyId } });
  if (!property) throw new NotFoundError("Propiedad no encontrada.");

  // Resolve jurisdiction: prefer explicit input, then fall back to property
  // hints. The property has `province`/`municipality`; CCAA must come from
  // PropertyAttribute or be passed in. For demo purposes default to CAT.
  const ccaaCode = input.ccaaCode ?? "CAT";
  const municipality = input.municipality ?? property.municipality ?? null;
  const establishmentClass = input.establishmentClass ?? "4_estrellas";

  const computed = await computeTouristTax({
    ccaaCode,
    municipality,
    establishmentClass,
    adults: reservation.adults,
    children: reservation.children,
    arrivalDate: reservation.arrivalDate.toISOString(),
    departureDate: reservation.departureDate.toISOString()
  });

  if (!computed.ok || !computed.rate) {
    throw new BadRequestError(`No se pudo calcular la tasa: ${computed.reason ?? "unknown"}`);
  }
  if (computed.totalAmount === 0) {
    return { ok: true, totalAmount: 0, applied: false, reason: "zero_amount" };
  }

  // Find or create the primary folio on the reservation.
  let folio = await prisma.folio.findFirst({ where: { reservationId: input.reservationId, isPrimary: true } });
  if (!folio) {
    folio = await prisma.folio.create({
      data: {
        reservationId: input.reservationId,
        status: "open",
        currency: reservation.currency ?? "EUR",
        label: "guest",
        isPrimary: true
      }
    });
  }

  // Post the line into the folio. Type "city_tax" is recognised by the routing
  // engine (sourceType match) and by the journal posting rules.
  const description = `Tasa turística ${ccaaCode}${municipality ? ` · ${municipality}` : ""} · ${computed.adultsTaxable + computed.childrenTaxable} pax × ${computed.nightsTaxable} noches`;
  const peopleTimesNights = Math.max(1, (computed.adultsTaxable + computed.childrenTaxable) * computed.nightsTaxable);
  const line = await prisma.folioLine.create({
    data: {
      folioId: folio.id,
      type: "city_tax",
      description,
      quantity: computed.adultsTaxable + computed.childrenTaxable,
      unitPrice: computed.totalAmount / peopleTimesNights,
      total: computed.totalAmount,
      taxCode: null,
      postedBy: input.context.userId
    }
  });

  // Record the application snapshot for the quarterly self-assessment report.
  const application = await prisma.touristTaxApplication.create({
    data: {
      propertyId: reservation.propertyId,
      reservationId: reservation.id,
      folioId: folio.id,
      folioLineId: line.id,
      rateId: computed.rate.id,
      ccaaCode,
      municipality,
      establishmentClass,
      amountPerPersonNight: computed.rate.amountPerPersonNight,
      currency: computed.currency,
      adultsTaxable: computed.adultsTaxable,
      nightsTaxable: computed.nightsTaxable,
      totalAmount: computed.totalAmount,
      stayFrom: reservation.arrivalDate,
      stayUntil: reservation.departureDate
    }
  });

  return { ok: true, totalAmount: computed.totalAmount, applied: true, applicationId: application.id, folioLineId: line.id };
}

// ---------------------------------------------------------------------------
// Quarterly report
// ---------------------------------------------------------------------------

export async function listApplicationsForPeriod(input: {
  context: UserContext;
  propertyId: string;
  fromDate: string;
  toDate: string;
}) {
  requirePermissions(input.context, ["folio.charge.post"]);
  const from = startOfDayUtc(input.fromDate);
  const to = startOfDayUtc(input.toDate);
  const rows = await prisma.touristTaxApplication.findMany({
    where: {
      propertyId: input.propertyId,
      stayFrom: { gte: from, lte: to }
    },
    orderBy: { stayFrom: "asc" }
  });
  const totals: Record<string, { count: number; amount: number }> = {};
  for (const r of rows) {
    const key = `${r.ccaaCode}${r.municipality ? `:${r.municipality}` : ""}`;
    if (!totals[key]) totals[key] = { count: 0, amount: 0 };
    totals[key].count += 1;
    totals[key].amount += Number(r.totalAmount);
  }
  return {
    items: rows,
    summary: Object.entries(totals).map(([jurisdiction, t]) => ({
      jurisdiction,
      count: t.count,
      totalAmount: Math.round(t.amount * 100) / 100
    }))
  };
}

// ---------------------------------------------------------------------------
// Catalog management (used by the admin UI)
// ---------------------------------------------------------------------------

export async function listRates(input: { context: UserContext; ccaaCode?: string }) {
  requirePermissions(input.context, ["folio.charge.post"]);
  return prisma.touristTaxRate.findMany({
    where: { ...(input.ccaaCode ? { ccaaCode: input.ccaaCode } : {}) },
    orderBy: [{ ccaaCode: "asc" }, { municipality: "asc" }, { establishmentClass: "asc" }, { validFrom: "desc" }]
  });
}

export async function createRate(input: {
  context: UserContext;
  payload: Prisma.TouristTaxRateUncheckedCreateInput;
}) {
  requirePermissions(input.context, ["compliance.configure"]);
  if (!input.payload.ccaaCode) throw new BadRequestError("ccaaCode es obligatorio.");
  return prisma.touristTaxRate.create({ data: input.payload });
}
