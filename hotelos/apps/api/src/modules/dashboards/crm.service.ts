import { prisma } from "@hotelos/database";

/**
 * CRM stats dashboard — read-only guest profile / segment / campaign overview.
 *
 * Scoping:
 *  - `propertyId` is the API contract input (consistent with the other operations
 *    dashboards). Internally we resolve the property's `organizationId` once and
 *    use it to scope Guest / GuestProfile / CrmSegment / CrmCampaign, because
 *    those models are organization-scoped, not property-scoped, in the schema.
 *  - Reservation is the only property-scoped model in this dashboard, used for
 *    LTV / lastStay / totalStays metrics and 90d churn.
 *
 * Sharp edges / schema observations:
 *  - Guest has NO direct propertyId. It is linked to a Reservation via the
 *    ReservationGuest join table. To attribute a Guest to a property we join
 *    ReservationGuest -> Reservation (filtered by propertyId).
 *  - Guest has NO `vipLevel` flag. VIP is tracked on GuestProfile.vipLevel
 *    (nullable string). VIP count is therefore the count of GuestProfiles
 *    for the organization with a non-empty vipLevel.
 *  - GuestProfile already carries `lifetimeValue`, `totalStays`, `totalSpend`
 *    as denormalized aggregates. We prefer these for the LTV KPI because they
 *    are the canonical CRM value (folio/invoice rollups are upstream of them).
 *    When no profiles exist we fall back to summing Reservation.totalAmount
 *    grouped by the primary guest of each reservation — this is the
 *    "ltv may need reservations join" fallback path mentioned in the brief.
 *  - GuestProfile is org-wide. It is not filtered by property; a single guest
 *    profile may span multiple properties of the same organization. That's
 *    consistent with how CRM segments/campaigns work and how the
 *    SalesPipeline service treats SalesAccount.
 *  - Churn 90d = guests with last stay > 90 days ago / total guests with at
 *    least one stay. "Last stay" = max(Reservation.departureDate) over
 *    reservations the guest participated in (via ReservationGuest), scoped
 *    to the requested property. Guests with no stays are excluded from both
 *    numerator and denominator (otherwise churn explodes towards 100% on
 *    fresh data sets).
 *  - "Recent guests" = guests with the most recent stay at the property
 *    (top 10 by last stay desc), with totalStays = number of reservations
 *    they participated in at this property and totalRevenue = sum of
 *    Reservation.totalAmount for those reservations attributed proportionally
 *    is over-engineered; we use the simpler "sum of totals where this guest
 *    is primary" rule to avoid double-counting in shared reservations.
 *  - "Upcoming birthdays" — Guest.dateOfBirth is a DateTime in the schema but
 *    only the month/day matter. We compute the next anniversary inside the
 *    next 30 days in UTC. Leap-day birthdays (Feb 29) fall back to Feb 28
 *    in non-leap years.
 *  - CrmCampaign has no recipients / CTR columns; both come out of
 *    `contentJson` / `scheduleJson` as JSON blobs in this codebase. We do a
 *    best-effort read: recipients <- contentJson.recipients (number) ??
 *    scheduleJson.recipients (number), ctr <- contentJson.ctr (number, 0-1
 *    or 0-100) — we normalise to a percentage with one decimal. Missing
 *    values render as 0 / undefined.
 *  - "Active campaigns" = CrmCampaign.status is anything other than
 *    "draft", "archived", "cancelled". Defaults are safe (empty array).
 *  - "Top segments" — CrmSegment has no membership table. We derive
 *    memberCount and revenue90d from a static fallback (0/0) when the
 *    rulesJson does not contain a precomputed count. A future segment
 *    evaluator would replace this; we surface the segments anyway so the UI
 *    has the list to render and counts of 0 simply mean "not yet evaluated".
 *  - All Decimal values coerced via toNumber(); null/undefined -> 0. Arrays
 *    default to []. The whole result is safe to render when no data exists.
 */

const DEFAULT_DAYS = 90;
const CHURN_DAYS = 90;
const BIRTHDAY_WINDOW_DAYS = 30;
const INACTIVE_CAMPAIGN_STATUSES = new Set(["draft", "archived", "cancelled", "canceled"]);

export type BuildCrmDashboardInput = {
  propertyId: string;
  days?: number;
};

export type CrmDashboard = {
  kpis: {
    totalGuests: number;
    activeProfiles: number;
    vipCount: number;
    avgLifetimeValueEur: number;
    churnRate90dPct: number;
  };
  topSegments: Array<{ segmentName: string; memberCount: number; revenue90dEur: number }>;
  activeCampaigns: Array<{ id: string; name: string; status: string; recipients: number; ctrPct?: number }>;
  upcomingBirthdays: Array<{ id: string; fullName: string; dateOfBirth: string; daysAway: number }>;
  recentGuests: Array<{ id: string; fullName: string; lastStayAt?: string; totalStays: number; totalRevenue?: number }>;
};

function emptyDashboard(): CrmDashboard {
  return {
    kpis: {
      totalGuests: 0,
      activeProfiles: 0,
      vipCount: 0,
      avgLifetimeValueEur: 0,
      churnRate90dPct: 0
    },
    topSegments: [],
    activeCampaigns: [],
    upcomingBirthdays: [],
    recentGuests: []
  };
}

function toNumber(value: unknown): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  const maybeDecimal = value as { toNumber?: () => number };
  if (typeof maybeDecimal.toNumber === "function") {
    try {
      const parsed = maybeDecimal.toNumber();
      return Number.isFinite(parsed) ? parsed : 0;
    } catch {
      return 0;
    }
  }
  return 0;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function fullNameFor(guest: {
  firstName: string;
  surname1?: string | null;
  surname2?: string | null;
}): string {
  return [guest.firstName, guest.surname1, guest.surname2].filter((s): s is string => Boolean(s && s.trim())).join(" ").trim();
}

function readJsonRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function readNumberFromJson(record: Record<string, unknown>, key: string): number | undefined {
  const raw = record[key];
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string") {
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

/**
 * Compute days until the next birthday from `today` (UTC, time stripped).
 * Returns null if dob is missing or more than `windowDays` away.
 */
function daysToNextBirthday(dob: Date | null | undefined, today: Date, windowDays: number): number | null {
  if (!dob) return null;
  const todayUtc = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  let month = dob.getUTCMonth();
  let day = dob.getUTCDate();
  // Leap-day birthdays in non-leap years collapse to Feb 28.
  if (month === 1 && day === 29) {
    const year = today.getUTCFullYear();
    const isLeap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
    if (!isLeap) {
      day = 28;
    }
  }
  let nextUtc = Date.UTC(today.getUTCFullYear(), month, day);
  if (nextUtc < todayUtc) {
    nextUtc = Date.UTC(today.getUTCFullYear() + 1, month, day);
  }
  const diffDays = Math.round((nextUtc - todayUtc) / (24 * 60 * 60 * 1000));
  if (diffDays < 0 || diffDays > windowDays) return null;
  return diffDays;
}

export async function buildCrmDashboard(input: BuildCrmDashboardInput): Promise<CrmDashboard> {
  const { propertyId } = input;
  if (!propertyId) return emptyDashboard();

  const days = input.days && input.days > 0 ? Math.floor(input.days) : DEFAULT_DAYS;
  const now = new Date();
  const churnCutoff = new Date(now.getTime() - CHURN_DAYS * 24 * 60 * 60 * 1000);
  const revenueWindowStart = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);

  // Resolve organizationId for the property — CRM models are org-scoped.
  const property = await prisma.property.findUnique({
    where: { id: propertyId },
    select: { organizationId: true }
  });
  if (!property) return emptyDashboard();
  const organizationId = property.organizationId;

  // Fetch all reservations at the property (we use them for LTV, lastStay,
  // totalStays, churn, recent guests, revenue 90d). Also fetch the
  // ReservationGuest links restricted to those reservations.
  const reservations = await prisma.reservation.findMany({
    where: { propertyId },
    orderBy: { departureDate: "desc" }
  });
  const reservationIds = reservations.map((r) => r.id);
  const reservationGuests = reservationIds.length
    ? await prisma.reservationGuest.findMany({ where: { reservationId: { in: reservationIds } } })
    : [];

  // Map: reservationId -> Reservation; guestId -> guest aggregate.
  const reservationById = new Map(reservations.map((r) => [r.id, r] as const));
  type GuestStayAggregate = {
    guestId: string;
    totalStays: number;
    totalRevenue: number;
    lastStayAt: Date | null;
    revenueLast90d: number;
  };
  const aggregateByGuest = new Map<string, GuestStayAggregate>();

  for (const link of reservationGuests) {
    const reservation = reservationById.get(link.reservationId);
    if (!reservation) continue;
    const aggregate = aggregateByGuest.get(link.guestId) ?? {
      guestId: link.guestId,
      totalStays: 0,
      totalRevenue: 0,
      lastStayAt: null,
      revenueLast90d: 0
    };
    aggregate.totalStays += 1;
    // Attribute revenue only when the guest is primary on the reservation to
    // avoid double-counting on shared bookings.
    if (link.isPrimary) {
      const total = toNumber(reservation.totalAmount);
      aggregate.totalRevenue += total;
      if (reservation.departureDate >= revenueWindowStart) {
        aggregate.revenueLast90d += total;
      }
    }
    const departure = reservation.departureDate;
    if (!aggregate.lastStayAt || departure > aggregate.lastStayAt) {
      aggregate.lastStayAt = departure;
    }
    aggregateByGuest.set(link.guestId, aggregate);
  }

  // Pull guests participating in property reservations, plus CRM-scoped data
  // for the organization. Run in parallel.
  const guestIds = Array.from(aggregateByGuest.keys());
  const [guests, profiles, segments, campaigns, allOrgGuests] = await Promise.all([
    guestIds.length
      ? prisma.guest.findMany({ where: { id: { in: guestIds } } })
      : Promise.resolve([] as Awaited<ReturnType<typeof prisma.guest.findMany>>),
    prisma.guestProfile.findMany({ where: { organizationId } }),
    prisma.crmSegment.findMany({ where: { organizationId, active: true }, orderBy: { createdAt: "desc" } }),
    prisma.crmCampaign.findMany({ where: { organizationId }, orderBy: { createdAt: "desc" } }),
    // Total guests KPI is org-wide for CRM purposes (matches the "totalGuests"
    // wording — it's the size of the addressable contact base, not the
    // property-stayed subset).
    prisma.guest.findMany({ where: { organizationId }, select: { id: true, dateOfBirth: true, firstName: true, surname1: true, surname2: true } })
  ]);

  const guestById = new Map(guests.map((g) => [g.id, g] as const));

  // --- KPIs --------------------------------------------------------------
  const totalGuests = allOrgGuests.length;
  const activeProfiles = profiles.length;
  const vipCount = profiles.filter((p) => p.vipLevel && p.vipLevel.trim().length > 0).length;

  // Average LTV — prefer GuestProfile.lifetimeValue; fall back to summing
  // Reservation.totalAmount per guest if no profiles exist.
  let avgLifetimeValueEur = 0;
  if (profiles.length > 0) {
    const total = profiles.reduce((acc, p) => acc + toNumber(p.lifetimeValue), 0);
    avgLifetimeValueEur = round2(total / profiles.length);
  } else if (aggregateByGuest.size > 0) {
    const total = Array.from(aggregateByGuest.values()).reduce((acc, a) => acc + a.totalRevenue, 0);
    avgLifetimeValueEur = round2(total / aggregateByGuest.size);
  }

  // Churn rate 90d — guests with last stay older than 90 days / guests with
  // at least one stay. Excludes guests with no stays from both sides.
  let churnRate90dPct = 0;
  if (aggregateByGuest.size > 0) {
    let churned = 0;
    for (const aggregate of aggregateByGuest.values()) {
      if (aggregate.lastStayAt && aggregate.lastStayAt < churnCutoff) {
        churned += 1;
      }
    }
    churnRate90dPct = round1((churned / aggregateByGuest.size) * 100);
  }

  // --- Top segments ------------------------------------------------------
  // Without a segment-membership table we report memberCount/revenue90d from
  // rulesJson hints when present, otherwise 0. Sorted by memberCount desc.
  const topSegments = segments
    .map((segment) => {
      const rules = readJsonRecord(segment.rulesJson);
      const memberCount = readNumberFromJson(rules, "memberCount") ?? 0;
      const revenue90dEur = readNumberFromJson(rules, "revenue90dEur") ?? 0;
      return {
        segmentName: segment.name,
        memberCount,
        revenue90dEur: round2(revenue90dEur)
      };
    })
    .sort((a, b) => b.memberCount - a.memberCount || b.revenue90dEur - a.revenue90dEur)
    .slice(0, 10);

  // --- Active campaigns --------------------------------------------------
  const activeCampaigns = campaigns
    .filter((c) => !INACTIVE_CAMPAIGN_STATUSES.has((c.status ?? "").toLowerCase()))
    .map((c) => {
      const content = readJsonRecord(c.contentJson);
      const schedule = readJsonRecord(c.scheduleJson);
      const recipients =
        readNumberFromJson(content, "recipients") ?? readNumberFromJson(schedule, "recipients") ?? 0;
      const ctrRaw = readNumberFromJson(content, "ctr") ?? readNumberFromJson(content, "ctrPct");
      let ctrPct: number | undefined;
      if (ctrRaw !== undefined) {
        // Accept 0..1 or 0..100; normalise to 0..100 with one decimal.
        ctrPct = round1(ctrRaw <= 1 ? ctrRaw * 100 : ctrRaw);
      }
      const out: CrmDashboard["activeCampaigns"][number] = {
        id: c.id,
        name: c.name,
        status: c.status,
        recipients
      };
      if (ctrPct !== undefined) out.ctrPct = ctrPct;
      return out;
    })
    .slice(0, 10);

  // --- Upcoming birthdays ------------------------------------------------
  const upcomingBirthdays = allOrgGuests
    .map((g) => {
      const daysAway = daysToNextBirthday(g.dateOfBirth ?? null, now, BIRTHDAY_WINDOW_DAYS);
      if (daysAway === null || !g.dateOfBirth) return null;
      return {
        id: g.id,
        fullName: fullNameFor(g),
        dateOfBirth: g.dateOfBirth.toISOString(),
        daysAway
      };
    })
    .filter((v): v is { id: string; fullName: string; dateOfBirth: string; daysAway: number } => v !== null)
    .sort((a, b) => a.daysAway - b.daysAway)
    .slice(0, 10);

  // --- Recent guests -----------------------------------------------------
  const recentGuests = Array.from(aggregateByGuest.values())
    .filter((aggregate) => aggregate.lastStayAt !== null)
    .sort((a, b) => (b.lastStayAt!.getTime() - a.lastStayAt!.getTime()))
    .slice(0, 10)
    .map((aggregate) => {
      const guest = guestById.get(aggregate.guestId);
      const fullName = guest ? fullNameFor(guest) : "Unknown guest";
      const out: CrmDashboard["recentGuests"][number] = {
        id: aggregate.guestId,
        fullName: fullName || "Unknown guest",
        totalStays: aggregate.totalStays
      };
      if (aggregate.lastStayAt) out.lastStayAt = aggregate.lastStayAt.toISOString();
      if (aggregate.totalRevenue > 0) out.totalRevenue = round2(aggregate.totalRevenue);
      return out;
    });

  return {
    kpis: {
      totalGuests,
      activeProfiles,
      vipCount,
      avgLifetimeValueEur,
      churnRate90dPct
    },
    topSegments,
    activeCampaigns,
    upcomingBirthdays,
    recentGuests
  };
}
