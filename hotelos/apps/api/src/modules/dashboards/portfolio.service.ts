import { prisma } from "@hotelos/database";
import type { Prisma } from "@hotelos/database";
import { computeBalancesForReservations } from "../folio/folio-balance.service.js";

/**
 * Portfolio dashboard — cross-property aggregation for a single organization.
 *
 * Aggregates KPIs across ALL properties of the org (typical hotel groups own
 * 3–50+ properties) and surfaces per-property drill-down rows plus a
 * cross-property critical alerts feed.
 *
 * Aggregation strategy:
 *  - Fan-out: one `prisma.property.findMany({ where: { organizationId } })`
 *    gives the base list. Per-property aggregation is wrapped in
 *    `Promise.all(...)` so the round-trip cost is dominated by the slowest
 *    property, not the sum, even with 50+ properties.
 *  - Per property we compute counts and sums via groupBy / count / findMany +
 *    Decimal coercion (no raw SQL — keeps schema.prisma the source of truth).
 *  - Cross-property KPIs:
 *      * `Σ` for arrivals, departures, in-house, rooms, revenue MTD, pending
 *        balance, pending fiscal submissions
 *      * Weighted averages for occupancy / ADR / RevPAR weighted by
 *        `roomsCount` so a 200-room property dominates a 12-room boutique.
 *        Formula: `Σ(roomCount_i × metric_i) / Σ(roomCount_i)`.
 *      * Empty / zero denominators return 0 (never NaN/Infinity).
 *
 * Sharp edges:
 *  - Single-property orgs render exactly the same — the totals match the one
 *    perProperty row, alerts will be 0 if healthy. Empty orgs return zeros and
 *    empty arrays.
 *  - VerifactuSubmission / TbaiSubmission / IgicSubmission use a `String`
 *    status column (default "pending"). SesHospedajesSubmission uses the
 *    `SubmissionStatus` enum. For "pending fiscal" we count submissions where
 *    status is NOT in {accepted, annulled} — that catches pending / queued /
 *    sent / failed / rejected / retrying across all four authorities.
 *  - "Revenue MTD" pulls FolioLine.total summed across folios linked to
 *    reservations of the property, posted >= start-of-current-UTC-month. Folio
 *    has no `propertyId` column — we go Reservation → Folio → FolioLine.
 *  - "Pending balance" is the AR proxy from the front-desk service: sum of
 *    positive (charges − captured payments) balances per reservation, scoped
 *    to today's arrivals/departures + currently in-house. Cheaper than a full
 *    AR roll-up and matches the FrontDesk KPI on each property card.
 *  - Property `status` (String, default "open") is read directly from the
 *    schema. Known values: "open" | "closed" | "maintenance". A property in
 *    "closed" or "maintenance" is surfaced as a `warn` health pill regardless of
 *    occupancy (it is expected to have no in-house guests / no snapshots).
 *  - "Unattended" rolls up org-wide: draft reservations + open conversations +
 *    pending housekeeping tasks. Per-property tasks are not surfaced in the
 *    per-property row to keep the table narrow.
 */

export type BuildPortfolioDashboardInput = {
  organizationId: string;
  asOf?: Date | string;
};

export type PortfolioHealth = "ok" | "warn" | "error";
export type PortfolioPropertyStatus = "open" | "closed" | "maintenance";

export type PortfolioDashboard = {
  organizationId: string;
  asOf: string;
  totals: {
    propertiesCount: number;
    activePropertiesCount: number;
    roomsCount: number;
    arrivalsToday: number;
    departuresToday: number;
    inHouseNow: number;
    occupancyPct: number;
    adrEur: number;
    revparEur: number;
    revenueMtdEur: number;
    pendingFiscalSubmissions: number;
    pendingBalanceEur: number;
    unattended: { reservations: number; messages: number; tasks: number };
  };
  perProperty: Array<{
    propertyId: string;
    name: string;
    city?: string;
    region?: string;
    status: PortfolioPropertyStatus;
    roomsCount: number;
    arrivalsToday: number;
    departuresToday: number;
    inHouseNow: number;
    occupancyPct: number;
    adrEur: number;
    revparEur: number;
    revenueMtdEur: number;
    pendingFiscalSubmissions: number;
    pendingBalanceEur: number;
    health: PortfolioHealth;
  }>;
  alerts: Array<{
    propertyId: string;
    severity: "critical" | "warning";
    title: string;
    description: string;
  }>;
};

// ---- helpers --------------------------------------------------------------

function dec(value: Prisma.Decimal | number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  const n = Number(value as unknown as string);
  return Number.isFinite(n) ? n : 0;
}

function round2(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * 100) / 100;
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

// Submission statuses that should be counted as "pending" (i.e. need
// follow-up): everything except already-accepted or annulled. Covers both the
// String-typed Verifactu/Tbai/Igic models AND the enum-typed SES Hospedajes
// model since the values are strings on the wire either way.
const FISCAL_PENDING_STATUSES = new Set<string>([
  "pending",
  "queued",
  "sent",
  "submitting",
  "retrying",
  "failed",
  "rejected"
]);

// ---- per-property aggregation --------------------------------------------

type PerPropertyAggregate = PortfolioDashboard["perProperty"][number] & {
  // Carry weighted-avg numerators back to the caller. These are scratch
  // values used by the org-wide weighted average computation.
  _weighted: {
    rooms: number;
    occXrooms: number;
    adrXrooms: number;
    revparXrooms: number;
  };
  _unattendedReservations: number;
  _openConversations: number;
  _pendingTasks: number;
  _alerts: PortfolioDashboard["alerts"];
};

async function aggregateProperty(
  property: { id: string; name: string; status: string; municipality: string | null; province: string | null; taxRegion: string | null },
  dayStart: Date,
  dayEnd: Date,
  monthStart: Date
): Promise<PerPropertyAggregate> {
  const propertyId = property.id;

  // Fire as many independent queries as we can in parallel.
  const [
    roomsActive,
    arrivalsToday,
    departuresToday,
    inHouseNow,
    inHouseReservations,
    arrivalsReservations,
    departuresReservations,
    revenueSnapshots,
    verifactuPending,
    tbaiPending,
    igicPending,
    sesPending,
    draftReservations,
    openConversations,
    pendingTasks
  ] = await Promise.all([
    prisma.room.count({ where: { propertyId, active: true } }),
    prisma.reservation.count({ where: { propertyId, arrivalDate: { gte: dayStart, lt: dayEnd } } }),
    prisma.reservation.count({ where: { propertyId, departureDate: { gte: dayStart, lt: dayEnd } } }),
    prisma.reservation.count({ where: { propertyId, status: "checked_in", departureDate: { gt: dayEnd } } }),
    prisma.reservation.findMany({
      where: { propertyId, status: "checked_in", departureDate: { gt: dayEnd } },
      select: { id: true }
    }),
    prisma.reservation.findMany({
      where: { propertyId, arrivalDate: { gte: dayStart, lt: dayEnd } },
      select: { id: true }
    }),
    prisma.reservation.findMany({
      where: { propertyId, departureDate: { gte: dayStart, lt: dayEnd } },
      select: { id: true }
    }),
    prisma.revenueDailySnapshot.findMany({
      where: {
        propertyId,
        snapshotDate: { gte: monthStart, lte: dayEnd },
        // Only top-level roll-ups so we don't sum per-segment duplicates.
        roomTypeId: null,
        ratePlanId: null,
        channelId: null,
        segment: null,
        market: null
      },
      select: {
        snapshotDate: true,
        totalOcc: true,
        roomRevenue: true,
        totalRevenue: true,
        adr: true,
        revpar: true,
        occupancyPercent: true
      }
    }),
    prisma.verifactuSubmission.count({ where: { propertyId, status: { in: Array.from(FISCAL_PENDING_STATUSES) } } }),
    prisma.tbaiSubmission.count({ where: { propertyId, status: { in: Array.from(FISCAL_PENDING_STATUSES) } } }),
    prisma.igicSubmission.count({ where: { propertyId, status: { in: Array.from(FISCAL_PENDING_STATUSES) } } }),
    prisma.sesHospedajesSubmission.count({
      where: {
        propertyId,
        // SubmissionStatus enum: queued | sent | accepted | rejected | failed | annulled
        status: { in: ["queued", "sent", "rejected", "failed"] }
      }
    }),
    prisma.reservation.count({ where: { propertyId, status: "draft" } }),
    prisma.conversation.count({ where: { propertyId, status: "open" } }),
    prisma.housekeepingTask.count({ where: { propertyId, status: "pending" } })
  ]);

  // Today's pending balance — replicate the front-desk service approach:
  // sum positive (charges − captured payments) balances across arrivals,
  // departures and in-house reservations.
  const balanceReservationIds = Array.from(
    new Set([
      ...arrivalsReservations.map((r) => r.id),
      ...departuresReservations.map((r) => r.id),
      ...inHouseReservations.map((r) => r.id)
    ])
  );

  let pendingBalanceEur = 0;
  let revenueMtdEur = 0;

  // Today's pending balance via the shared folio-balance helper (Sprint 46).
  // Batched: a fixed query budget regardless of reservation count.
  if (balanceReservationIds.length > 0) {
    const balanceByReservation = await computeBalancesForReservations(balanceReservationIds);
    for (const reservationId of balanceReservationIds) {
      const balance = balanceByReservation.get(reservationId) ?? 0;
      if (balance > 0) pendingBalanceEur += balance;
    }
    pendingBalanceEur = round2(pendingBalanceEur);
  }

  // Revenue MTD: walk all reservations of the property that overlap the
  // current month and sum their folio-line totals posted in-month. Cheaper
  // approach: just sum all FolioLine.total posted this month for any folio
  // attached to a reservation of this property.
  const monthReservations = await prisma.reservation.findMany({
    where: { propertyId },
    select: { id: true }
  });
  const monthReservationIds = monthReservations.map((r) => r.id);
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

  // Aggregate occupancy / ADR / RevPAR from RevenueDailySnapshot (MTD).
  // We average per-day across the month-to-date window and weight at the
  // org level by rooms count.
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
  let occupancyPct = occDays > 0 ? round2(occSum / occDays) : 0;
  let adrEur = adrDays > 0 ? round2(adrSum / adrDays) : 0;
  let revparEur = revparDays > 0 ? round2(revparSum / revparDays) : 0;

  // Fallback when there are no RevenueDailySnapshot roll-ups (e.g. demo data, or
  // a property whose nightly snapshot job hasn't run): derive occupancy / ADR /
  // RevPAR for the month-to-date window straight from reservations — the source
  // of truth. Only runs when the snapshot path produced nothing.
  if (occupancyPct === 0 && adrEur === 0 && revparEur === 0 && roomsActive > 0) {
    const msPerDay = 24 * 60 * 60 * 1000;
    const windowStartMs = monthStart.getTime();
    const windowEndMs = dayEnd.getTime();
    const daysElapsed = Math.max(1, Math.round((windowEndMs - windowStartMs) / msPerDay));
    const mtdReservations = await prisma.reservation.findMany({
      where: {
        propertyId,
        status: { in: ["confirmed", "checked_in", "checked_out"] },
        arrivalDate: { lt: dayEnd },
        departureDate: { gt: monthStart }
      },
      select: { arrivalDate: true, departureDate: true, totalAmount: true }
    });
    let roomNights = 0;
    let roomRevenue = 0;
    for (const r of mtdReservations) {
      const arr = r.arrivalDate.getTime();
      const dep = r.departureDate.getTime();
      const totalNights = Math.max(1, Math.round((dep - arr) / msPerDay));
      const overlapStart = Math.max(arr, windowStartMs);
      const overlapEnd = Math.min(dep, windowEndMs);
      const overlapNights = Math.max(0, Math.round((overlapEnd - overlapStart) / msPerDay));
      if (overlapNights <= 0) continue;
      roomNights += overlapNights;
      // Allocate the booking value proportionally to the nights inside the window.
      roomRevenue += dec(r.totalAmount) * (overlapNights / totalNights);
    }
    const availableRoomNights = roomsActive * daysElapsed;
    if (availableRoomNights > 0) {
      occupancyPct = round2((roomNights / availableRoomNights) * 100);
      revparEur = round2(roomRevenue / availableRoomNights);
    }
    if (roomNights > 0) {
      adrEur = round2(roomRevenue / roomNights);
    }
  }

  const pendingFiscalSubmissions = verifactuPending + tbaiPending + igicPending + sesPending;

  // Read the real property status. Normalise to the known set; anything
  // unexpected falls back to "open" so the UI always renders a valid column.
  const status: PortfolioPropertyStatus =
    property.status === "closed" || property.status === "maintenance" ? property.status : "open";

  // A non-operational property (closed/maintenance) is expected to have no
  // in-house guests and no snapshots — surface it as `warn`, never `error`,
  // and skip the occupancy-based data-quality heuristic for it.
  const nonOperational = status === "closed" || status === "maintenance";

  // Health rating.
  let health: PortfolioHealth = "ok";
  if (pendingFiscalSubmissions > 5) health = "error";
  else if (pendingFiscalSubmissions > 0) health = "warn";
  if (nonOperational) {
    // Closed/maintenance never escalates past warn regardless of occupancy.
    if (health !== "error") health = "warn";
  } else if (inHouseNow === 0 && occupancyPct === 0 && roomsActive > 0 && health === "ok") {
    // No in-house and no occupancy at all (data-quality smell) → warn.
    health = "warn";
  }

  // Per-property alerts feed back into the org-wide critical alerts feed.
  const alerts: PortfolioDashboard["alerts"] = [];
  if (pendingFiscalSubmissions > 5) {
    alerts.push({
      propertyId,
      severity: "critical",
      title: `${property.name} · ${pendingFiscalSubmissions} fiscal submissions pending`,
      description: "VeriFactu / TicketBAI / IGIC / SES Hospedajes acumulan envíos sin aceptar. Revisa la cola de cumplimiento."
    });
  } else if (pendingFiscalSubmissions > 0) {
    alerts.push({
      propertyId,
      severity: "warning",
      title: `${property.name} · ${pendingFiscalSubmissions} envíos fiscales en cola`,
      description: "Hay submissions queued/sent/retrying. Si persisten más de 10 minutos, revisa el certificado y el endpoint."
    });
  }
  if (pendingBalanceEur > 5000) {
    alerts.push({
      propertyId,
      severity: pendingBalanceEur > 25000 ? "critical" : "warning",
      title: `${property.name} · ${pendingBalanceEur.toFixed(2)} € por cobrar hoy`,
      description: "Cobros pendientes en folios de llegadas, salidas y huéspedes in-house."
    });
  }
  if (!nonOperational && roomsActive > 0 && occupancyPct === 0 && inHouseNow === 0) {
    alerts.push({
      propertyId,
      severity: "warning",
      title: `${property.name} · sin ocupación registrada`,
      description: "0% ocupación y 0 huéspedes in-house. ¿La propiedad está cerrada o falta el snapshot diario?"
    });
  }

  const roomsCount = roomsActive;

  return {
    propertyId,
    name: property.name,
    city: property.municipality ?? undefined,
    region: property.taxRegion ?? property.province ?? undefined,
    status,
    roomsCount,
    arrivalsToday,
    departuresToday,
    inHouseNow,
    occupancyPct,
    adrEur,
    revparEur,
    revenueMtdEur,
    pendingFiscalSubmissions,
    pendingBalanceEur,
    health,
    _weighted: {
      rooms: roomsCount,
      occXrooms: occupancyPct * roomsCount,
      adrXrooms: adrEur * roomsCount,
      revparXrooms: revparEur * roomsCount
    },
    _unattendedReservations: draftReservations,
    _openConversations: openConversations,
    _pendingTasks: pendingTasks,
    _alerts: alerts
  };
}

// ---- public entrypoint ----------------------------------------------------

export async function buildPortfolioDashboard(
  input: BuildPortfolioDashboardInput
): Promise<PortfolioDashboard> {
  const organizationId = input.organizationId;
  const asOfDate = input.asOf ? (input.asOf instanceof Date ? input.asOf : new Date(input.asOf)) : new Date();
  const dayStart = startOfUtcDay(asOfDate);
  const dayEnd = endOfUtcDay(dayStart);
  const monthStart = startOfUtcMonth(dayStart);

  const properties = await prisma.property.findMany({
    where: { organizationId },
    select: { id: true, name: true, status: true, municipality: true, province: true, taxRegion: true },
    orderBy: { name: "asc" }
  });

  if (properties.length === 0) {
    return {
      organizationId,
      asOf: dayStart.toISOString(),
      totals: {
        propertiesCount: 0,
        activePropertiesCount: 0,
        roomsCount: 0,
        arrivalsToday: 0,
        departuresToday: 0,
        inHouseNow: 0,
        occupancyPct: 0,
        adrEur: 0,
        revparEur: 0,
        revenueMtdEur: 0,
        pendingFiscalSubmissions: 0,
        pendingBalanceEur: 0,
        unattended: { reservations: 0, messages: 0, tasks: 0 }
      },
      perProperty: [],
      alerts: []
    };
  }

  // Fan out per-property aggregation.
  const aggregates = await Promise.all(
    properties.map((p) => aggregateProperty(p, dayStart, dayEnd, monthStart))
  );

  // Org-wide totals.
  const totals = {
    propertiesCount: properties.length,
    activePropertiesCount: aggregates.filter((a) => a.status === "open").length,
    roomsCount: 0,
    arrivalsToday: 0,
    departuresToday: 0,
    inHouseNow: 0,
    occupancyPct: 0,
    adrEur: 0,
    revparEur: 0,
    revenueMtdEur: 0,
    pendingFiscalSubmissions: 0,
    pendingBalanceEur: 0,
    unattended: { reservations: 0, messages: 0, tasks: 0 }
  };

  let weightedRoomsDenominator = 0;
  let weightedOccNumerator = 0;
  let weightedAdrNumerator = 0;
  let weightedRevparNumerator = 0;
  const alerts: PortfolioDashboard["alerts"] = [];

  for (const a of aggregates) {
    totals.roomsCount += a.roomsCount;
    totals.arrivalsToday += a.arrivalsToday;
    totals.departuresToday += a.departuresToday;
    totals.inHouseNow += a.inHouseNow;
    totals.revenueMtdEur += a.revenueMtdEur;
    totals.pendingFiscalSubmissions += a.pendingFiscalSubmissions;
    totals.pendingBalanceEur += a.pendingBalanceEur;
    totals.unattended.reservations += a._unattendedReservations;
    totals.unattended.messages += a._openConversations;
    totals.unattended.tasks += a._pendingTasks;
    weightedRoomsDenominator += a._weighted.rooms;
    weightedOccNumerator += a._weighted.occXrooms;
    weightedAdrNumerator += a._weighted.adrXrooms;
    weightedRevparNumerator += a._weighted.revparXrooms;
    alerts.push(...a._alerts);
  }

  totals.revenueMtdEur = round2(totals.revenueMtdEur);
  totals.pendingBalanceEur = round2(totals.pendingBalanceEur);
  totals.occupancyPct = weightedRoomsDenominator > 0 ? round2(weightedOccNumerator / weightedRoomsDenominator) : 0;
  totals.adrEur = weightedRoomsDenominator > 0 ? round2(weightedAdrNumerator / weightedRoomsDenominator) : 0;
  totals.revparEur = weightedRoomsDenominator > 0 ? round2(weightedRevparNumerator / weightedRoomsDenominator) : 0;

  // Sort alerts: critical first, then warning. Stable order within severity.
  alerts.sort((a, b) => {
    if (a.severity === b.severity) return 0;
    return a.severity === "critical" ? -1 : 1;
  });

  const perProperty = aggregates.map((a) => ({
    propertyId: a.propertyId,
    name: a.name,
    city: a.city,
    region: a.region,
    status: a.status,
    roomsCount: a.roomsCount,
    arrivalsToday: a.arrivalsToday,
    departuresToday: a.departuresToday,
    inHouseNow: a.inHouseNow,
    occupancyPct: a.occupancyPct,
    adrEur: a.adrEur,
    revparEur: a.revparEur,
    revenueMtdEur: a.revenueMtdEur,
    pendingFiscalSubmissions: a.pendingFiscalSubmissions,
    pendingBalanceEur: a.pendingBalanceEur,
    health: a.health
  }));

  return {
    organizationId,
    asOf: dayStart.toISOString(),
    totals,
    perProperty,
    alerts
  };
}
