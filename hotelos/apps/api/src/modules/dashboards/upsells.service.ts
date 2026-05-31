import { prisma } from "@hotelos/database";

/**
 * Upsells dashboard — read-only ancillary revenue overview.
 *
 * Aggregates over UpsellOffer (the catalogue, scoped by propertyId) and
 * GuestUpsellPurchase (the conversions, scoped by propertyId, optionally
 * linked to a Reservation and an UpsellOffer). Reservation/Guest are only
 * used to enrich the recent-purchases list with a display name.
 *
 * Date window:
 *  - `from` / `to` default to the last 30 calendar days (today − 30 → now).
 *  - Window applies to GuestUpsellPurchase.createdAt for KPI counts, top
 *    offer rollups and the recent-purchases list. UpsellOffer.active is
 *    always evaluated against the current catalogue (not date-scoped).
 *
 * Sharp edges / schema observations:
 *  - Sprint 19 introduced UpsellImpression. We use it as the source of truth
 *    for `offersShown30d` (count of impressions in the window) and per-offer
 *    `views30d`. When no impressions exist (e.g. property never logged any),
 *    those numbers are 0 — note the conversion rate will then be 0 even if
 *    purchases exist, which is intentional.
 *  - "Conversion" = GuestUpsellPurchase.status in CONVERTED_STATUSES
 *    ("purchased", "confirmed", "paid", "completed"). Anything else (pending,
 *    declined, expired, cancelled, refunded) is treated as not converted.
 *    Conversion rate = conversions / views × 100, rounded to 1 decimal.
 *  - Revenue lift uses GuestUpsellPurchase.amount (Decimal?) only for
 *    converted rows. Pending/declined rows are excluded from revenue even
 *    if they carry a price tag. Null amounts coerce to 0.
 *  - GuestUpsellPurchase has no FK to Guest. We resolve a display name via
 *    Reservation → ReservationGuest (isPrimary preferred) → Guest. If no
 *    primary guest is linked we fall back to Reservation.bookerName, then
 *    Reservation.code, then leave guestName undefined.
 *  - Currency is assumed EUR (matching Reservation.currency default and the
 *    UI EUR formatter). No multi-currency conversion is applied here.
 *  - All Decimal values are coerced via toNumber(); null/undefined → 0.
 */

export type UpsellsDashboardInput = {
  propertyId: string;
  from?: string;
  to?: string;
};

export type UpsellsDashboard = {
  kpis: {
    activeOffers: number;
    offersShown30d: number;
    conversions30d: number;
    conversionRatePct: number;
    revenueLift30dEur: number;
  };
  topOffers: Array<{
    id: string;
    name: string;
    views30d: number;
    conversions30d: number;
    revenue30dEur: number;
    conversionRatePct: number;
  }>;
  recentPurchases: Array<{
    id: string;
    offerName: string;
    guestName?: string;
    reservationId?: string;
    amountEur: number;
    purchasedAt: string;
  }>;
};

const CONVERTED_STATUSES = new Set(["purchased", "confirmed", "paid", "completed"]);

const EMPTY: UpsellsDashboard = {
  kpis: {
    activeOffers: 0,
    offersShown30d: 0,
    conversions30d: 0,
    conversionRatePct: 0,
    revenueLift30dEur: 0
  },
  topOffers: [],
  recentPurchases: []
};

function toNumber(value: unknown): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "string") {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
  }
  if (typeof (value as { toNumber?: () => number }).toNumber === "function") {
    try {
      const n = (value as { toNumber: () => number }).toNumber();
      return Number.isFinite(n) ? n : 0;
    } catch {
      return 0;
    }
  }
  return 0;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function parseDate(input: string | undefined, fallback: Date): Date {
  if (!input) return fallback;
  const parsed = new Date(input);
  return Number.isNaN(parsed.getTime()) ? fallback : parsed;
}

function isConverted(status: string | null | undefined): boolean {
  return CONVERTED_STATUSES.has((status ?? "").toLowerCase().trim());
}

function formatGuestName(
  firstName: string | null | undefined,
  surname1: string | null | undefined,
  surname2: string | null | undefined
): string {
  return [firstName, surname1, surname2].filter((p) => p && p.trim().length > 0).join(" ").trim();
}

export async function buildUpsellsDashboard(
  input: UpsellsDashboardInput
): Promise<UpsellsDashboard> {
  if (!input.propertyId) return EMPTY;

  const now = new Date();
  const defaultFrom = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const from = parseDate(input.from, defaultFrom);
  const to = parseDate(input.to, now);

  // Catalogue: every offer for the property. `active` count is not date-scoped.
  const offers = await prisma.upsellOffer.findMany({
    where: { propertyId: input.propertyId }
  });
  const offerById = new Map(offers.map((o) => [o.id, o] as const));
  const activeOffers = offers.filter((o) => o.active).length;

  // Purchases inside the window — used for conversions and revenue lift.
  // Impressions (Sprint 19) are the source of truth for "views".
  const [purchases, impressions] = await Promise.all([
    prisma.guestUpsellPurchase.findMany({
      where: {
        propertyId: input.propertyId,
        createdAt: { gte: from, lt: to }
      },
      orderBy: { createdAt: "desc" }
    }),
    prisma.upsellImpression.findMany({
      where: {
        propertyId: input.propertyId,
        shownAt: { gte: from, lt: to }
      },
      select: { offerId: true }
    })
  ]);

  if (purchases.length === 0 && offers.length === 0 && impressions.length === 0) return EMPTY;

  // --- KPI roll-up ---
  let conversions30d = 0;
  let revenueLift30dEur = 0;

  // offerId -> { views, conversions, revenue }
  const offerBucket = new Map<string, { views: number; conversions: number; revenue: number }>();

  // Seed views from UpsellImpression (the impression-truth source).
  for (const imp of impressions) {
    if (!imp.offerId) continue;
    const b = offerBucket.get(imp.offerId) ?? { views: 0, conversions: 0, revenue: 0 };
    b.views += 1;
    offerBucket.set(imp.offerId, b);
  }
  const offersShown30d = impressions.length;

  for (const p of purchases) {
    const converted = isConverted(p.status);
    const amount = converted ? toNumber(p.amount) : 0;
    if (converted) {
      conversions30d += 1;
      revenueLift30dEur += amount;
    }
    const key = p.upsellOfferId;
    if (key && converted) {
      const b = offerBucket.get(key) ?? { views: 0, conversions: 0, revenue: 0 };
      b.conversions += 1;
      b.revenue += amount;
      offerBucket.set(key, b);
    }
  }

  const conversionRatePct =
    offersShown30d === 0 ? 0 : round1((conversions30d / offersShown30d) * 100);

  const topOffers = Array.from(offerBucket.entries())
    .map(([id, b]) => {
      const offer = offerById.get(id);
      return {
        id,
        name: offer?.name ?? "Unknown offer",
        views30d: b.views,
        conversions30d: b.conversions,
        revenue30dEur: round2(b.revenue),
        conversionRatePct: b.views === 0 ? 0 : round1((b.conversions / b.views) * 100)
      };
    })
    .sort(
      (a, b) =>
        b.revenue30dEur - a.revenue30dEur ||
        b.conversions30d - a.conversions30d ||
        b.views30d - a.views30d
    )
    .slice(0, 10);

  // --- Recent purchases (last 10 converted in window, name-enriched) ---
  const recentConverted = purchases.filter((p) => isConverted(p.status)).slice(0, 10);

  const reservationIds = Array.from(
    new Set(recentConverted.map((p) => p.reservationId).filter((v): v is string => Boolean(v)))
  );

  const reservations = reservationIds.length
    ? await prisma.reservation.findMany({ where: { id: { in: reservationIds } } })
    : [];
  const reservationById = new Map(reservations.map((r) => [r.id, r] as const));

  const reservationGuests = reservationIds.length
    ? await prisma.reservationGuest.findMany({ where: { reservationId: { in: reservationIds } } })
    : [];
  // Prefer primary guest per reservation; fall back to any guest.
  const primaryGuestIdByReservation = new Map<string, string>();
  for (const rg of reservationGuests) {
    if (rg.isPrimary) {
      primaryGuestIdByReservation.set(rg.reservationId, rg.guestId);
    } else if (!primaryGuestIdByReservation.has(rg.reservationId)) {
      primaryGuestIdByReservation.set(rg.reservationId, rg.guestId);
    }
  }

  const guestIds = Array.from(new Set(primaryGuestIdByReservation.values()));
  const guests = guestIds.length
    ? await prisma.guest.findMany({ where: { id: { in: guestIds } } })
    : [];
  const guestById = new Map(guests.map((g) => [g.id, g] as const));

  const recentPurchases = recentConverted.map((p) => {
    const offerName = p.upsellOfferId
      ? offerById.get(p.upsellOfferId)?.name ?? "Unknown offer"
      : "Unknown offer";
    const reservation = p.reservationId ? reservationById.get(p.reservationId) : undefined;

    let guestName: string | undefined;
    if (p.reservationId) {
      const gid = primaryGuestIdByReservation.get(p.reservationId);
      const g = gid ? guestById.get(gid) : undefined;
      const formatted = g ? formatGuestName(g.firstName, g.surname1, g.surname2) : "";
      if (formatted.length > 0) {
        guestName = formatted;
      } else if (reservation?.bookerName && reservation.bookerName.trim().length > 0) {
        guestName = reservation.bookerName;
      } else if (reservation?.code) {
        guestName = reservation.code;
      }
    }

    const out: UpsellsDashboard["recentPurchases"][number] = {
      id: p.id,
      offerName,
      amountEur: round2(toNumber(p.amount)),
      purchasedAt: p.createdAt.toISOString()
    };
    if (guestName) out.guestName = guestName;
    if (p.reservationId) out.reservationId = p.reservationId;
    return out;
  });

  return {
    kpis: {
      activeOffers,
      offersShown30d,
      conversions30d,
      conversionRatePct,
      revenueLift30dEur: round2(revenueLift30dEur)
    },
    topOffers,
    recentPurchases
  };
}
