import { prisma } from "@hotelos/database";
import type { Prisma } from "@hotelos/database";
import { computeBalancesForReservations } from "../folio/folio-balance.service.js";

/**
 * Property overview — single-property drill-down for the Portfolio dashboard.
 *
 * Sprint 38 built the cross-property Portfolio dashboard; clicking a row used to
 * land on the FiscalDashboard. Sprint 41 introduces a dedicated single-property
 * overview screen and this service powers it.
 *
 * The shape is intentionally a "command center" summary: today's front-desk
 * snapshot, finance roll-up, operational backlog counts, guest-experience
 * counts, a compliance posture and a small recent-reservations list. It reuses
 * the exact computation patterns of `front-desk.service.ts` (pending balance =
 * Σ positive (charges − captured payments) over today's reservations) and
 * `portfolio.service.ts` (revenue MTD from FolioLine.total posted in-month;
 * occupancy/ADR/RevPAR averaged from RevenueDailySnapshot; pending fiscal as the
 * union of the four submission tables in non-terminal statuses).
 *
 * Sharp edges:
 *  - Folio has no `propertyId` column — we always go Reservation → Folio →
 *    FolioLine / Payment, scoping by reservation IDs of the property.
 *  - Occupancy/ADR/RevPAR come from RevenueDailySnapshot top-level roll-ups
 *    (roomTypeId/ratePlanId/channelId/segment/market all null) so per-segment
 *    rows are not double counted. If no snapshot exists for the month, all three
 *    are 0 (never NaN).
 *  - `unassignedRooms` mirrors front-desk: today's arrivals without an
 *    assignedRoomId (NOT physical rooms inventory).
 *  - "pending reviews" = rated reviews still missing a respondedAt, matching
 *    reputation.service.ts. avgReviewRating averages all rated reviews.
 *  - Every count/sum defaults to 0 and recentReservations to [] when empty.
 *  - If the property id doesn't exist we still return the envelope with a
 *    synthetic empty `property` block so the UI can render a graceful empty
 *    state rather than 404.
 */

export type BuildPropertyOverviewInput = {
  propertyId: string;
  asOf?: Date | string;
};

export type PropertyOverview = {
  property: {
    id: string;
    name: string;
    legalName?: string;
    address?: string;
    city?: string;
    region?: string;
    country: string;
    status: string;
    timezone: string;
    roomsCount: number;
    sesHospedajesEnabled: boolean;
    verifactuEnabled: boolean;
  };
  today: {
    arrivals: number;
    departures: number;
    inHouse: number;
    unassignedRooms: number;
    occupancyPct: number;
    adrEur: number;
    revparEur: number;
  };
  finance: {
    revenueMtdEur: number;
    pendingBalanceEur: number;
    pendingFiscalSubmissions: number;
  };
  operations: {
    housekeepingOpen: number;
    maintenanceOpen: number;
    safetyIncidentsOpen: number;
  };
  guestExperience: {
    openConversations: number;
    avgReviewRating: number;
    pendingReviews: number;
  };
  recentReservations: Array<{
    id: string;
    code: string;
    guestName: string;
    arrivalDate: string;
    departureDate: string;
    status: string;
    balanceEur: number;
  }>;
};

// ---- helpers --------------------------------------------------------------

function dec(value: Prisma.Decimal | number | string | null | undefined): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  const n = Number(value as unknown as string);
  return Number.isFinite(n) ? n : 0;
}

function round2(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * 100) / 100;
}

function round1(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * 10) / 10;
}

function startOfUtcDay(input?: Date | string): Date {
  if (input) {
    const d = input instanceof Date ? input : new Date(input);
    if (!Number.isNaN(d.getTime())) {
      return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
    }
  }
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

function endOfUtcDay(start: Date): Date {
  return new Date(start.getTime() + 24 * 60 * 60 * 1000);
}

function startOfUtcMonth(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

function isoDate(value: Date | string): string {
  if (typeof value === "string") return value.length >= 10 ? value.slice(0, 10) : value;
  return value.toISOString().slice(0, 10);
}

function formatGuestName(parts: {
  firstName?: string | null;
  surname1?: string | null;
  surname2?: string | null;
}): string {
  const pieces = [parts.firstName, parts.surname1, parts.surname2].filter(
    (p): p is string => Boolean(p && p.trim())
  );
  return pieces.length > 0 ? pieces.join(" ") : "(unknown guest)";
}

// Submission statuses to count as "pending" (need follow-up): everything
// except already-accepted or annulled. Covers both String-typed Verifactu /
// Tbai / Igic models and the enum-typed SES Hospedajes model.
const FISCAL_PENDING_STATUSES = ["pending", "queued", "sent", "submitting", "retrying", "failed", "rejected"];
// SES Hospedajes uses the SubmissionStatus enum (queued | sent | accepted |
// rejected | failed | annulled). Count anything not yet accepted/annulled.
const SES_PENDING_STATUSES = ["queued", "sent", "rejected", "failed"] as const;

// ---- public entrypoint ----------------------------------------------------

export async function buildPropertyOverview(
  input: BuildPropertyOverviewInput
): Promise<PropertyOverview> {
  const propertyId = input.propertyId;
  const asOfDate = input.asOf ? (input.asOf instanceof Date ? input.asOf : new Date(input.asOf)) : new Date();
  const dayStart = startOfUtcDay(asOfDate);
  const dayEnd = endOfUtcDay(dayStart);
  const monthStart = startOfUtcMonth(dayStart);

  const property = await prisma.property.findUnique({
    where: { id: propertyId },
    select: {
      id: true,
      name: true,
      legalName: true,
      address: true,
      municipality: true,
      province: true,
      taxRegion: true,
      country: true,
      status: true,
      timezone: true,
      sesHospedajesEnabled: true,
      verifactuEnabled: true
    }
  });

  // Fire all independent counts/queries in parallel.
  const [
    roomsCount,
    arrivalsCount,
    departuresCount,
    inHouseCount,
    arrivalsForUnassigned,
    revenueSnapshots,
    verifactuPending,
    tbaiPending,
    igicPending,
    sesPending,
    housekeepingOpen,
    maintenanceOpen,
    safetyIncidentsOpen,
    openConversations,
    reviews,
    recentRaw,
    todayReservations,
    monthReservations
  ] = await Promise.all([
    prisma.room.count({ where: { propertyId, active: true } }),
    prisma.reservation.count({ where: { propertyId, arrivalDate: { gte: dayStart, lt: dayEnd } } }),
    prisma.reservation.count({ where: { propertyId, departureDate: { gte: dayStart, lt: dayEnd } } }),
    prisma.reservation.count({ where: { propertyId, status: "checked_in", departureDate: { gt: dayEnd } } }),
    prisma.reservation.findMany({
      where: { propertyId, arrivalDate: { gte: dayStart, lt: dayEnd } },
      select: { id: true, assignedRoomId: true }
    }),
    prisma.revenueDailySnapshot.findMany({
      where: {
        propertyId,
        snapshotDate: { gte: monthStart, lte: dayEnd },
        roomTypeId: null,
        ratePlanId: null,
        channelId: null,
        segment: null,
        market: null
      },
      select: { totalOcc: true, adr: true, revpar: true, occupancyPercent: true }
    }),
    prisma.verifactuSubmission.count({ where: { propertyId, status: { in: FISCAL_PENDING_STATUSES } } }),
    prisma.tbaiSubmission.count({ where: { propertyId, status: { in: FISCAL_PENDING_STATUSES } } }),
    prisma.igicSubmission.count({ where: { propertyId, status: { in: FISCAL_PENDING_STATUSES } } }),
    prisma.sesHospedajesSubmission.count({ where: { propertyId, status: { in: [...SES_PENDING_STATUSES] } } }),
    prisma.housekeepingTask.count({ where: { propertyId, status: "pending" } }),
    prisma.workOrder.count({ where: { propertyId, status: { in: ["open", "assigned", "in_progress", "waiting_vendor"] } } }),
    prisma.safetyIncident.count({ where: { propertyId, status: "open" } }),
    prisma.conversation.count({ where: { propertyId, status: "open" } }),
    prisma.guestReview.findMany({
      where: { propertyId },
      select: { rating: true, respondedAt: true }
    }),
    prisma.reservation.findMany({
      where: { propertyId },
      orderBy: { createdAt: "desc" },
      take: 10,
      select: {
        id: true,
        code: true,
        arrivalDate: true,
        departureDate: true,
        status: true,
        roomTypeId: true,
        assignedRoomId: true
      }
    }),
    // Reservations driving today's pending balance (arrivals + departures + in-house).
    prisma.reservation.findMany({
      where: {
        propertyId,
        OR: [
          { arrivalDate: { gte: dayStart, lt: dayEnd } },
          { departureDate: { gte: dayStart, lt: dayEnd } },
          { status: "checked_in", departureDate: { gt: dayEnd } }
        ]
      },
      select: { id: true }
    }),
    // All reservations of the property (for revenue MTD via folios).
    prisma.reservation.findMany({ where: { propertyId }, select: { id: true } })
  ]);

  const unassignedRooms = arrivalsForUnassigned.filter((r) => !r.assignedRoomId).length;

  // Occupancy / ADR / RevPAR — average per-day across MTD window.
  let occSum = 0;
  let adrSum = 0;
  let revparSum = 0;
  let occDays = 0;
  let adrDays = 0;
  let revparDays = 0;
  for (const snap of revenueSnapshots) {
    const occ = dec(snap.occupancyPercent);
    if (occ > 0 || snap.totalOcc > 0) {
      occSum += occ;
      occDays += 1;
    }
    const adr = dec(snap.adr);
    if (adr > 0) {
      adrSum += adr;
      adrDays += 1;
    }
    const revpar = dec(snap.revpar);
    if (revpar > 0) {
      revparSum += revpar;
      revparDays += 1;
    }
  }
  const occupancyPct = occDays > 0 ? round2(occSum / occDays) : 0;
  const adrEur = adrDays > 0 ? round2(adrSum / adrDays) : 0;
  const revparEur = revparDays > 0 ? round2(revparSum / revparDays) : 0;

  const pendingFiscalSubmissions = verifactuPending + tbaiPending + igicPending + sesPending;

  // Guest reviews: avg rating + pending (rated, missing respondedAt).
  const ratings: number[] = [];
  let pendingReviews = 0;
  for (const review of reviews) {
    const rating = review.rating === null || review.rating === undefined ? null : dec(review.rating);
    if (rating !== null && rating > 0) {
      ratings.push(rating);
      if (review.respondedAt === null) pendingReviews += 1;
    }
  }
  const avgReviewRating = ratings.length > 0
    ? round1(ratings.reduce((acc, v) => acc + v, 0) / ratings.length)
    : 0;

  // --- Folio-derived figures (pending balance today + revenue MTD) ---------
  const todayReservationIds = todayReservations.map((r) => r.id);
  const monthReservationIds = monthReservations.map((r) => r.id);
  const recentReservationIds = recentRaw.map((r) => r.id);

  // Folio balances for today's + recent reservations via the shared helper
  // (Sprint 46). Batched: a fixed query budget regardless of reservation count.
  const balanceReservationIds = Array.from(new Set([...todayReservationIds, ...recentReservationIds]));
  const balanceByReservation = await computeBalancesForReservations(balanceReservationIds);

  function balanceForReservation(reservationId: string): number {
    return balanceByReservation.get(reservationId) ?? 0;
  }

  let pendingBalanceEur = 0;
  for (const reservationId of todayReservationIds) {
    const balance = balanceForReservation(reservationId);
    if (balance > 0) pendingBalanceEur += balance;
  }
  pendingBalanceEur = round2(pendingBalanceEur);

  // Revenue MTD: Σ FolioLine.total posted >= monthStart for folios of any
  // reservation of the property.
  let revenueMtdEur = 0;
  if (monthReservationIds.length > 0) {
    const monthFolios = await prisma.folio.findMany({
      where: { reservationId: { in: monthReservationIds } },
      select: { id: true }
    });
    const monthFolioIds = monthFolios.map((f) => f.id);
    if (monthFolioIds.length > 0) {
      const lines = await prisma.folioLine.groupBy({
        by: ["folioId"],
        where: { folioId: { in: monthFolioIds }, postedAt: { gte: monthStart } },
        _sum: { total: true }
      });
      for (const row of lines) revenueMtdEur += dec(row._sum?.total);
      revenueMtdEur = round2(revenueMtdEur);
    }
  }

  // Guest names for the recent reservations list (primary guest, fallback any).
  const reservationGuests = recentReservationIds.length === 0
    ? []
    : await prisma.reservationGuest.findMany({
        where: { reservationId: { in: recentReservationIds } },
        select: { reservationId: true, guestId: true, isPrimary: true }
      });
  const guestIdByReservation = new Map<string, string>();
  for (const link of reservationGuests) {
    if (link.isPrimary && !guestIdByReservation.has(link.reservationId)) {
      guestIdByReservation.set(link.reservationId, link.guestId);
    }
  }
  for (const link of reservationGuests) {
    if (!guestIdByReservation.has(link.reservationId)) {
      guestIdByReservation.set(link.reservationId, link.guestId);
    }
  }
  const guestIds = Array.from(new Set(Array.from(guestIdByReservation.values())));
  const guests = guestIds.length === 0
    ? []
    : await prisma.guest.findMany({
        where: { id: { in: guestIds } },
        select: { id: true, firstName: true, surname1: true, surname2: true }
      });
  const guestById = new Map<string, { firstName: string | null; surname1: string | null; surname2: string | null }>();
  for (const g of guests) {
    guestById.set(g.id, { firstName: g.firstName ?? null, surname1: g.surname1 ?? null, surname2: g.surname2 ?? null });
  }
  function guestNameForReservation(reservationId: string): string {
    const guestId = guestIdByReservation.get(reservationId);
    if (!guestId) return "(unknown guest)";
    const guest = guestById.get(guestId);
    return guest ? formatGuestName(guest) : "(unknown guest)";
  }

  const recentReservations = recentRaw.map((r) => ({
    id: r.id,
    code: r.code,
    guestName: guestNameForReservation(r.id),
    arrivalDate: isoDate(r.arrivalDate),
    departureDate: isoDate(r.departureDate),
    status: String(r.status),
    balanceEur: balanceForReservation(r.id)
  }));

  return {
    property: {
      id: property?.id ?? propertyId,
      name: property?.name ?? "(unknown property)",
      legalName: property?.legalName ?? undefined,
      address: property?.address ?? undefined,
      city: property?.municipality ?? undefined,
      region: property?.taxRegion ?? property?.province ?? undefined,
      country: property?.country ?? "ES",
      status: property?.status ?? "open",
      timezone: property?.timezone ?? "Europe/Madrid",
      roomsCount,
      sesHospedajesEnabled: property?.sesHospedajesEnabled ?? false,
      verifactuEnabled: property?.verifactuEnabled ?? false
    },
    today: {
      arrivals: arrivalsCount,
      departures: departuresCount,
      inHouse: inHouseCount,
      unassignedRooms,
      occupancyPct,
      adrEur,
      revparEur
    },
    finance: {
      revenueMtdEur,
      pendingBalanceEur,
      pendingFiscalSubmissions
    },
    operations: {
      housekeepingOpen,
      maintenanceOpen,
      safetyIncidentsOpen
    },
    guestExperience: {
      openConversations,
      avgReviewRating,
      pendingReviews
    },
    recentReservations
  };
}
