import { prisma } from "@hotelos/database";
import type { Prisma } from "@hotelos/database";
import { computeBalancesForReservations } from "../folio/folio-balance.service.js";

// Explicit bounds of the day / month reads (Tanda L2 · L2-05): arrivals and
// departures of ONE day, top-level snapshots of ONE month.
const OVERVIEW_MAX_DAY_RESERVATIONS = 5_000;
const OVERVIEW_MAX_MONTH_SNAPSHOTS = 62;
// Tanda 6b (R2, fix t6b#12): the razón social shown for a centre is the sociedad's
// (single reader); Property.legalName is the deprecated trade name.
import { resolveLegalIdentity } from "../../lib/finance-scope.js";
// Tanda T8 (lote T8-E, aditivo): índice de reputación a 30 días solo con el
// módulo reputation_quality activo (espejo síncrono); cualquier fallo → null.
import { getEnabledModuleCodes } from "../product-modules/product-modules.service.js";
import { REPUTATION_MODULE_CODE } from "../reputation/reputation-context.js";
import { getReputationSnapshot } from "../reputation/reputation-score.service.js";
// Tanda UX-2 (corrector UX2-REV-01 · F-D1): «hoy» = fecha de negocio de la propiedad,
// con el MISMO lector y la MISMA función pura que Mi día › Dirección y la Cartera.
import { readGmBusinessDate, resolveGmWindow, type GmBusinessDateSource } from "./general-manager.service.js";

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
 * Tanda UX-2 (corrector UX2-REV-01 · F-D1 «una verdad por dato»): the «today»
 * window ([dayStart, dayEnd)) is the BUSINESS DATE of the property
 * (business_dates.current_date via `readGmBusinessDate` + `resolveGmWindow` of
 * general-manager.service.ts, the rule of Mi día › Dirección and the night-audit
 * preflight); without a row, the natural UTC day of `asOf`. The month-to-date
 * window hangs from that date. The envelope says its window (`businessDate` +
 * `businessDateSource`, additive) so the detail screen labels «Llegadas hoy» /
 * «Salidas hoy» / «En el hotel» honestly. `today.arrivals` / `today.departures`
 * keep counting EVERY reservation of that date (Mi día › Dirección counts the
 * pending ones only).
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
 *  - `guestExperience.reputationIndex30` (Tanda T8 · T8-E) is the 30-day
 *    reputation index (0-100) when the reputation_quality module is enabled and
 *    the index has status `ok`; otherwise null (module off, no sources, fewer
 *    than 10 reviews, or a read failure). avgReviewRating/pendingReviews stay
 *    untouched (pinned by tests/integration/l2-paginacion.test.mts:634-638).
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
    /** Razón social of the sociedad that operates the centre (LegalEntity.legalName), never Property.legalName. */
    legalName?: string;
    /** Nombre comercial of the centre (Property.tradeName) when it differs from the name. */
    tradeName?: string;
    /** Property.code (RA, LT, OC…) once the centre is coded. */
    code?: string;
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
  /** YYYY-MM-DD of the «today» window (business date of the property; UTC day of `asOf` without a row). */
  businessDate: string;
  businessDateSource: GmBusinessDateSource;
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
    /** Índice de reputación a 30 días (0-100) con módulo activo y estado `ok`; si no, null. */
    reputationIndex30: number | null;
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

/** Índice 30 d de la propiedad; null con módulo apagado, sin índice `ok` o ante cualquier error. */
async function loadReputationIndex30(propertyId: string): Promise<number | null> {
  try {
    if (!(getEnabledModuleCodes(propertyId) as readonly string[]).includes(REPUTATION_MODULE_CODE)) return null;
    const snapshot = await getReputationSnapshot({ propertyId });
    return snapshot.status === "ok" && typeof snapshot.index30.index === "number" ? snapshot.index30.index : null;
  } catch {
    return null;
  }
}

// ---- public entrypoint ----------------------------------------------------

export async function buildPropertyOverview(
  input: BuildPropertyOverviewInput
): Promise<PropertyOverview> {
  const propertyId = input.propertyId;
  const asOfDate = input.asOf ? (input.asOf instanceof Date ? input.asOf : new Date(input.asOf)) : new Date();
  // UX2-REV-01: «hoy» = fecha de negocio de la propiedad (sin fila, día UTC de asOf); el mes cuelga de ella.
  const window = resolveGmWindow({ businessDate: await readGmBusinessDate(propertyId), now: asOfDate });
  const dayStart = window.today;
  const dayEnd = window.tomorrow;
  const monthStart = startOfUtcMonth(dayStart);

  const property = await prisma.property.findUnique({
    where: { id: propertyId },
    select: {
      id: true,
      organizationId: true,
      name: true,
      tradeName: true,
      code: true,
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
  const legalIdentity = property ? await resolveLegalIdentity(property.organizationId) : null;

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
    ratedReviews,
    pendingReviews,
    recentRaw,
    todayReservations,
    monthRevenue
  ] = await Promise.all([
    prisma.room.count({ where: { propertyId, active: true } }),
    prisma.reservation.count({ where: { propertyId, arrivalDate: { gte: dayStart, lt: dayEnd } } }),
    prisma.reservation.count({ where: { propertyId, departureDate: { gte: dayStart, lt: dayEnd } } }),
    prisma.reservation.count({ where: { propertyId, status: "checked_in", departureDate: { gt: dayEnd } } }),
    prisma.reservation.findMany({
      where: { propertyId, arrivalDate: { gte: dayStart, lt: dayEnd } },
      select: { id: true, assignedRoomId: true },
      take: OVERVIEW_MAX_DAY_RESERVATIONS
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
      select: { totalOcc: true, adr: true, revpar: true, occupancyPercent: true },
      take: OVERVIEW_MAX_MONTH_SNAPSHOTS
    }),
    prisma.verifactuSubmission.count({ where: { propertyId, status: { in: FISCAL_PENDING_STATUSES } } }),
    prisma.tbaiSubmission.count({ where: { propertyId, status: { in: FISCAL_PENDING_STATUSES } } }),
    prisma.igicSubmission.count({ where: { propertyId, status: { in: FISCAL_PENDING_STATUSES } } }),
    prisma.sesHospedajesSubmission.count({ where: { propertyId, status: { in: [...SES_PENDING_STATUSES] } } }),
    prisma.housekeepingTask.count({ where: { propertyId, status: "pending" } }),
    prisma.workOrder.count({ where: { propertyId, status: { in: ["open", "assigned", "in_progress", "waiting_vendor"] } } }),
    prisma.safetyIncident.count({ where: { propertyId, status: "open" } }),
    prisma.conversation.count({ where: { propertyId, status: "open" } }),
    // Reviews: average of the rated ones and the rated-but-unanswered count, aggregated in SQL (L2-05; was every review row).
    prisma.guestReview.aggregate({ where: { propertyId, rating: { gt: 0 } }, _avg: { rating: true }, _count: { _all: true } }),
    prisma.guestReview.count({ where: { propertyId, rating: { gt: 0 }, respondedAt: null } }),
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
      select: { id: true },
      take: OVERVIEW_MAX_DAY_RESERVATIONS
    }),
    // Revenue MTD: Σ FolioLine.total posted >= monthStart on the folios of any reservation of the property — one
    // aggregate through the relation (L2-05; was every reservation id + every folio id + a groupBy).
    prisma.folioLine.aggregate({ where: { postedAt: { gte: monthStart }, folio: { reservation: { propertyId } } }, _sum: { total: true } })
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

  // Guest reviews: avg rating (rated ones) + pending (rated, missing respondedAt).
  const avgReviewRating = ratedReviews._count._all > 0 ? round1(dec(ratedReviews._avg.rating)) : 0;
  const reputationIndex30 = await loadReputationIndex30(propertyId);

  // --- Folio-derived figures (pending balance today + revenue MTD) ---------
  const todayReservationIds = todayReservations.map((r) => r.id);
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

  // Revenue MTD (aggregated above through folio → reservation).
  const revenueMtdEur = round2(dec(monthRevenue._sum.total));

  // Guest names for the recent reservations list (primary guest, fallback any).
  const reservationGuests = recentReservationIds.length === 0
    ? []
    : await prisma.reservationGuest.findMany({
        where: { reservationId: { in: recentReservationIds } },
        select: { reservationId: true, guestId: true, isPrimary: true },
        take: recentReservationIds.length * 20
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
        select: { id: true, firstName: true, surname1: true, surname2: true },
        take: guestIds.length
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
      legalName: legalIdentity?.legalName ?? undefined,
      tradeName: property?.tradeName && property.tradeName !== property.name ? property.tradeName : undefined,
      code: property?.code ?? undefined,
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
    businessDate: window.businessDate,
    businessDateSource: window.source,
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
      pendingReviews,
      reputationIndex30
    },
    recentReservations
  };
}
