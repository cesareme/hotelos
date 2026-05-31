import { prisma } from "@hotelos/database";

/**
 * Loyalty dashboard — read-only members + tiers + points stats.
 *
 * Aggregates LoyaltyMembership (scoped by LoyaltyProgram of the property's
 * organization) and joins GuestProfile for display names / lifetime spend.
 *
 * Sharp edges / schema observations:
 *  - LoyaltyProgram is scoped by organizationId, NOT propertyId. We resolve
 *    organizationId from Property (one round-trip) before fetching programs.
 *    If the property isn't found we return an empty dashboard.
 *  - LoyaltyMembership references GuestProfile via guestProfileId. Guest is
 *    a separate entity; the link Reservation→GuestProfile is indirect:
 *      Reservation → ReservationGuest.guestId → GuestProfile.primaryGuestId
 *      (fallback)                          → GuestProfileLink.guestId →
 *                                            GuestProfileLink.guestProfileId
 *    We consider a reservation "with member" if any attached Guest maps to a
 *    GuestProfile that owns an active LoyaltyMembership in this org.
 *  - `redemptions30d*` — Sprint 19 added LoyaltyTransaction. We count
 *    transactions of type="redeem" within the last 30 days and sum the
 *    absolute value of points burned. Transactions are filtered to the
 *    memberships under the property's organization (programIds).
 *  - LoyaltyMembership has no propertyId. Memberships count is org-wide;
 *    staysWithMemberPct is the only property-scoped KPI.
 *  - GuestProfile.displayName may be null — we fall back to "(sin nombre)".
 *  - GuestProfile.totalSpend is Decimal — coerced via toNumber().
 *  - Memberships with status != "active" are EXCLUDED from activeMembers,
 *    membersByTier and topMembers; recentEnrollments includes ALL statuses
 *    (latest 10 by joinedAt) so newly created records are visible.
 *  - Tier is nullable on LoyaltyMembership — null tiers are bucketed under
 *    the literal string "Sin tier" so they're never invisible.
 */

export type LoyaltyDashboardInput = {
  propertyId: string;
};

export type LoyaltyDashboard = {
  kpis: {
    activeMembers: number;
    totalPointsInCirculation: number;
    redemptions30dCount: number;
    redemptions30dPointsBurned: number;
    staysWithMemberPct: number;
  };
  membersByTier: Array<{ tier: string; count: number; pointsBalance: number }>;
  topMembers: Array<{
    id: string;
    fullName: string;
    tier: string;
    points: number;
    lifetimeSpendEur?: number;
  }>;
  recentEnrollments: Array<{
    id: string;
    fullName: string;
    programName: string;
    enrolledAt: string;
  }>;
};

const UNKNOWN_TIER = "Sin tier";

function emptyDashboard(): LoyaltyDashboard {
  return {
    kpis: {
      activeMembers: 0,
      totalPointsInCirculation: 0,
      redemptions30dCount: 0,
      redemptions30dPointsBurned: 0,
      staysWithMemberPct: 0
    },
    membersByTier: [],
    topMembers: [],
    recentEnrollments: []
  };
}

function toNumber(value: unknown): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "string") {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
  }
  const maybeDecimal = value as { toNumber?: () => number };
  if (typeof maybeDecimal.toNumber === "function") {
    try {
      const n = maybeDecimal.toNumber();
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

export async function buildLoyaltyDashboard(
  input: LoyaltyDashboardInput
): Promise<LoyaltyDashboard> {
  const { propertyId } = input;
  if (!propertyId) return emptyDashboard();

  // 1. Resolve organizationId from propertyId — LoyaltyProgram is org-scoped.
  const property = await prisma.property.findUnique({
    where: { id: propertyId },
    select: { id: true, organizationId: true }
  });
  if (!property) return emptyDashboard();
  const organizationId = property.organizationId;

  // 2. Programs for this organization (used to bucket memberships and label
  // recentEnrollments). Programs may be inactive — we still surface them so
  // existing memberships render with their program name.
  const programs = await prisma.loyaltyProgram.findMany({
    where: { organizationId },
    select: { id: true, name: true }
  });
  if (programs.length === 0) return emptyDashboard();

  const programIds = programs.map((p) => p.id);
  const programNameById = new Map(programs.map((p) => [p.id, p.name] as const));

  // 3. All memberships under these programs.
  const memberships = await prisma.loyaltyMembership.findMany({
    where: { loyaltyProgramId: { in: programIds } },
    orderBy: { joinedAt: "desc" }
  });

  if (memberships.length === 0) return emptyDashboard();

  // 4. Pull guest profiles in one batch (name + lifetimeSpend for top members).
  const profileIds = Array.from(new Set(memberships.map((m) => m.guestProfileId)));
  const profiles = profileIds.length
    ? await prisma.guestProfile.findMany({
        where: { id: { in: profileIds } },
        select: {
          id: true,
          displayName: true,
          primaryGuestId: true,
          totalSpend: true
        }
      })
    : [];
  const profileById = new Map(profiles.map((p) => [p.id, p] as const));

  // 5. KPIs — activeMembers / points circulation / membersByTier.
  let activeMembers = 0;
  let totalPointsInCirculation = 0;
  const tierBucket = new Map<string, { count: number; pointsBalance: number }>();

  for (const m of memberships) {
    if (m.status !== "active") continue;
    activeMembers += 1;
    totalPointsInCirculation += m.pointsBalance;

    const tierKey = m.tier && m.tier.trim().length > 0 ? m.tier : UNKNOWN_TIER;
    const bucket = tierBucket.get(tierKey) ?? { count: 0, pointsBalance: 0 };
    bucket.count += 1;
    bucket.pointsBalance += m.pointsBalance;
    tierBucket.set(tierKey, bucket);
  }

  const membersByTier = Array.from(tierBucket.entries())
    .map(([tier, v]) => ({ tier, count: v.count, pointsBalance: v.pointsBalance }))
    .sort((a, b) => b.count - a.count);

  // 6. Top members — by pointsBalance among active memberships.
  const topMembers = memberships
    .filter((m) => m.status === "active")
    .sort((a, b) => b.pointsBalance - a.pointsBalance)
    .slice(0, 10)
    .map((m) => {
      const profile = profileById.get(m.guestProfileId);
      const fullName = profile?.displayName?.trim() || "(sin nombre)";
      const lifetimeSpendRaw = profile ? toNumber(profile.totalSpend) : 0;
      const out: LoyaltyDashboard["topMembers"][number] = {
        id: m.id,
        fullName,
        tier: m.tier && m.tier.trim().length > 0 ? m.tier : UNKNOWN_TIER,
        points: m.pointsBalance
      };
      if (lifetimeSpendRaw > 0) {
        out.lifetimeSpendEur = round2(lifetimeSpendRaw);
      }
      return out;
    });

  // 7. Recent enrollments — latest 10 by joinedAt across all statuses.
  const recentEnrollments = memberships.slice(0, 10).map((m) => {
    const profile = profileById.get(m.guestProfileId);
    const fullName = profile?.displayName?.trim() || "(sin nombre)";
    return {
      id: m.id,
      fullName,
      programName: programNameById.get(m.loyaltyProgramId) ?? "(programa desconocido)",
      enrolledAt: m.joinedAt.toISOString()
    };
  });

  // 8. staysWithMemberPct — property-scoped reservation join.
  // Approach: pull reservations for the property, collect their attached
  // guestIds via ReservationGuest, map guestIds to GuestProfiles (primary or
  // linked), then check which profiles own an active membership we've
  // already fetched. This avoids N+1 by issuing one query per relation.
  let staysWithMemberPct = 0;
  const reservationIds = await prisma.reservation.findMany({
    where: { propertyId },
    select: { id: true }
  });

  if (reservationIds.length > 0) {
    const reservationGuestRows = await prisma.reservationGuest.findMany({
      where: { reservationId: { in: reservationIds.map((r) => r.id) } },
      select: { reservationId: true, guestId: true }
    });

    if (reservationGuestRows.length > 0) {
      const guestIds = Array.from(new Set(reservationGuestRows.map((rg) => rg.guestId)));

      // GuestProfiles linked via primaryGuestId OR via GuestProfileLink.
      const [byPrimary, byLink] = await Promise.all([
        prisma.guestProfile.findMany({
          where: { primaryGuestId: { in: guestIds }, organizationId },
          select: { id: true, primaryGuestId: true }
        }),
        prisma.guestProfileLink.findMany({
          where: { guestId: { in: guestIds } },
          select: { guestId: true, guestProfileId: true }
        })
      ]);

      // guestId → set of profileIds reachable from that guest.
      const profileIdsByGuestId = new Map<string, Set<string>>();
      for (const row of byPrimary) {
        if (!row.primaryGuestId) continue;
        const set = profileIdsByGuestId.get(row.primaryGuestId) ?? new Set<string>();
        set.add(row.id);
        profileIdsByGuestId.set(row.primaryGuestId, set);
      }
      for (const row of byLink) {
        const set = profileIdsByGuestId.get(row.guestId) ?? new Set<string>();
        set.add(row.guestProfileId);
        profileIdsByGuestId.set(row.guestId, set);
      }

      // Set of profileIds with an active membership in this organization.
      const activeMemberProfileIds = new Set(
        memberships.filter((m) => m.status === "active").map((m) => m.guestProfileId)
      );

      // For each reservation, does ANY attached guest map to an active member?
      const reservationsWithMember = new Set<string>();
      for (const rg of reservationGuestRows) {
        const profileIds = profileIdsByGuestId.get(rg.guestId);
        if (!profileIds) continue;
        for (const pid of profileIds) {
          if (activeMemberProfileIds.has(pid)) {
            reservationsWithMember.add(rg.reservationId);
            break;
          }
        }
      }

      staysWithMemberPct = round1((reservationsWithMember.size / reservationIds.length) * 100);
    }
  }

  // 9. Redemptions in last 30 days — LoyaltyTransaction ledger (Sprint 19).
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 3_600_000);
  const membershipIds = memberships.map((m) => m.id);
  let redemptions30dCount = 0;
  let redemptions30dPointsBurned = 0;
  if (membershipIds.length > 0) {
    const redemptions = await prisma.loyaltyTransaction.findMany({
      where: {
        membershipId: { in: membershipIds },
        type: "redeem",
        occurredAt: { gte: thirtyDaysAgo }
      },
      select: { points: true }
    });
    redemptions30dCount = redemptions.length;
    redemptions30dPointsBurned = redemptions.reduce(
      (sum, r) => sum + Math.abs(r.points ?? 0),
      0
    );
  }

  return {
    kpis: {
      activeMembers,
      totalPointsInCirculation,
      redemptions30dCount,
      redemptions30dPointsBurned,
      staysWithMemberPct
    },
    membersByTier,
    topMembers,
    recentEnrollments
  };
}
