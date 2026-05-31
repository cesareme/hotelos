import { prisma } from "@hotelos/database";

/**
 * Groups & Events dashboard — read-only group bookings + events overview.
 *
 * Aggregates over:
 *  - GroupBooking (propertyId-scoped) for active groups, arrival/departure.
 *  - GroupRoomBlock (joined via groupBookingId) for blocked / picked-up rooms
 *    and the pickup % KPI.
 *  - Event (propertyId-scoped) for upcoming events list + count KPI, and for
 *    revenue MTD via attached EventOrders.
 *  - EventOrder (joined via eventId) for revenue figures encoded in
 *    contentJson (best-effort: total/totalEur/amount/revenueEur).
 *  - EventSpace (joined via eventSpaceId) for the readable space name.
 *  - SalesAccount (joined via GroupBooking.accountId, org-scoped) for the
 *    top-accounts table.
 *
 * Date window:
 *  - `from`/`to` default to [first day of current month, last day of next
 *    month] in UTC. Used to bound upcomingGroups (by arrivalDate) and
 *    upcomingEvents (by startAt). The activeGroupBookings / roomsBlockedTotal
 *    / pickupPct KPIs ignore the window — they cover all currently active
 *    groups (status != cancelled/closed and departure >= now). upcomingEvents
 *    KPI is the count of events whose startAt falls inside [from, to). The
 *    fAndBRevenueMtdEur KPI is the calendar month-to-date sum.
 *
 * Sharp edges / schema observations:
 *  - GroupBooking has no "active" column. We treat any booking whose status
 *    lower-cases to anything other than "cancelled"/"canceled"/"closed"/
 *    "released" AND whose departureDate >= now as active. "Upcoming" groups
 *    are active groups with arrivalDate inside [from, to).
 *  - Pickup % is computed across **active** blocks only (rooms blocked sum /
 *    picked-up sum). A block whose group is cancelled is excluded — that way
 *    cancelled groups don't drag the KPI to 0.
 *  - GroupRoomBlock has a `date` field. Per-group pickup totals are summed
 *    across all dates of the block; the per-group pickupPct on the
 *    upcomingGroups row uses that group's own blocked/pickedUp totals.
 *  - Event has no explicit "spaceName" — we resolve via EventSpace.name.
 *  - Event.setupJson is free-form JSON. We pull `expectedAttendees` from
 *    setupJson (also accept `attendees`, `pax`, `expectedPax`). Missing
 *    values are simply omitted from the row.
 *  - EventOrder has no explicit "revenue" column. We do a best-effort read
 *    of contentJson: revenueEur ?? total ?? totalEur ?? amount, treated as
 *    EUR. Multiple orders on the same event sum.
 *  - SalesAccount has no propertyId; it's org-scoped. We resolve names by
 *    joining GroupBooking.accountId -> SalesAccount.id and never query
 *    SalesAccount by property directly.
 *  - "Value" for top accounts = sum of (blockedCount * rate) across the
 *    account's active group blocks where a rate is present. When rate is
 *    null we contribute 0 for those rows; we never invent a rate. The
 *    secondary sort falls back to activeGroups count.
 *  - All Decimal values coerced via toNumber(); null/undefined -> 0. Arrays
 *    default to []. The whole result is safe to render with no data.
 */

const INACTIVE_GROUP_STATUSES = new Set([
  "cancelled",
  "canceled",
  "closed",
  "released",
  "lost",
  "void"
]);

export type BuildGroupsEventsDashboardInput = {
  propertyId: string;
  from?: string;
  to?: string;
};

export type GroupsEventsDashboard = {
  kpis: {
    activeGroupBookings: number;
    roomsBlockedTotal: number;
    pickupPct: number;
    upcomingEvents: number;
    fAndBRevenueMtdEur: number;
  };
  upcomingGroups: Array<{
    id: string;
    name: string;
    arrivalDate?: string;
    departureDate?: string;
    roomsBlocked: number;
    pickedUp: number;
    pickupPct: number;
  }>;
  upcomingEvents: Array<{
    id: string;
    name: string;
    eventDate: string;
    spaceName?: string;
    expectedAttendees?: number;
    revenueEur?: number;
  }>;
  topAccounts: Array<{ accountName: string; activeGroups: number; valueEur: number }>;
};

function emptyDashboard(): GroupsEventsDashboard {
  return {
    kpis: {
      activeGroupBookings: 0,
      roomsBlockedTotal: 0,
      pickupPct: 0,
      upcomingEvents: 0,
      fAndBRevenueMtdEur: 0
    },
    upcomingGroups: [],
    upcomingEvents: [],
    topAccounts: []
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

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function startOfCurrentMonthUtc(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

function endOfNextMonthUtc(now: Date): Date {
  // Exclusive upper bound = first day of the month after next.
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 2, 1));
}

function parseDate(input: string | undefined, fallback: Date): Date {
  if (!input) return fallback;
  const parsed = new Date(input);
  return Number.isNaN(parsed.getTime()) ? fallback : parsed;
}

function readJsonRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function readNumberFromJson(record: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const raw = record[key];
    if (typeof raw === "number" && Number.isFinite(raw)) return raw;
    if (typeof raw === "string") {
      const parsed = Number(raw);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return undefined;
}

function isActiveGroupStatus(status: string | null | undefined): boolean {
  const key = (status ?? "").toLowerCase().trim();
  if (!key) return true; // Default to active when unset.
  return !INACTIVE_GROUP_STATUSES.has(key);
}

export async function buildGroupsEventsDashboard(
  input: BuildGroupsEventsDashboardInput
): Promise<GroupsEventsDashboard> {
  if (!input.propertyId) return emptyDashboard();

  const now = new Date();
  const from = parseDate(input.from, startOfCurrentMonthUtc(now));
  const to = parseDate(input.to, endOfNextMonthUtc(now));
  const monthStart = startOfCurrentMonthUtc(now);

  // Pull groups for the property. We need them all to compute the not-
  // window-bound KPIs (activeGroupBookings / roomsBlocked / pickup %).
  const [groupBookings, events] = await Promise.all([
    prisma.groupBooking.findMany({
      where: { propertyId: input.propertyId },
      orderBy: { arrivalDate: "asc" }
    }),
    prisma.event.findMany({
      where: { propertyId: input.propertyId },
      orderBy: { startAt: "asc" }
    })
  ]);

  if (groupBookings.length === 0 && events.length === 0) {
    return emptyDashboard();
  }

  const activeGroups = groupBookings.filter(
    (g) => isActiveGroupStatus(g.status) && g.departureDate >= now
  );
  const activeGroupIds = activeGroups.map((g) => g.id);

  // Fetch room blocks for active groups (for pickup KPI + per-group totals)
  // and event orders + event spaces for events.
  const eventIds = events.map((e) => e.id);
  const eventSpaceIds = Array.from(
    new Set(events.map((e) => e.eventSpaceId).filter((v): v is string => Boolean(v)))
  );
  const accountIds = Array.from(
    new Set(groupBookings.map((g) => g.accountId).filter((v): v is string => Boolean(v)))
  );

  const [blocks, eventOrders, eventSpaces, accounts] = await Promise.all([
    activeGroupIds.length
      ? prisma.groupRoomBlock.findMany({ where: { groupBookingId: { in: activeGroupIds } } })
      : Promise.resolve([] as Awaited<ReturnType<typeof prisma.groupRoomBlock.findMany>>),
    eventIds.length
      ? prisma.eventOrder.findMany({ where: { eventId: { in: eventIds } } })
      : Promise.resolve([] as Awaited<ReturnType<typeof prisma.eventOrder.findMany>>),
    eventSpaceIds.length
      ? prisma.eventSpace.findMany({ where: { id: { in: eventSpaceIds } } })
      : Promise.resolve([] as Awaited<ReturnType<typeof prisma.eventSpace.findMany>>),
    accountIds.length
      ? prisma.salesAccount.findMany({ where: { id: { in: accountIds } } })
      : Promise.resolve([] as Awaited<ReturnType<typeof prisma.salesAccount.findMany>>)
  ]);

  const spaceNameById = new Map(eventSpaces.map((s) => [s.id, s.name] as const));
  const accountNameById = new Map(accounts.map((a) => [a.id, a.name] as const));

  // --- Per-group block aggregates ---------------------------------------
  type BlockAggregate = {
    blocked: number;
    pickedUp: number;
    value: number; // sum of blockedCount * rate where rate is present
  };
  const blocksByGroup = new Map<string, BlockAggregate>();
  let roomsBlockedTotal = 0;
  let pickedUpTotal = 0;

  for (const block of blocks) {
    const agg = blocksByGroup.get(block.groupBookingId) ?? { blocked: 0, pickedUp: 0, value: 0 };
    const blocked = block.blockedCount;
    const pickedUp = block.pickedUpCount;
    agg.blocked += blocked;
    agg.pickedUp += pickedUp;
    if (block.rate !== null && block.rate !== undefined) {
      agg.value += blocked * toNumber(block.rate);
    }
    blocksByGroup.set(block.groupBookingId, agg);
    roomsBlockedTotal += blocked;
    pickedUpTotal += pickedUp;
  }

  const pickupPct = roomsBlockedTotal > 0 ? round1((pickedUpTotal / roomsBlockedTotal) * 100) : 0;

  // --- Upcoming events --------------------------------------------------
  const ordersByEvent = new Map<string, typeof eventOrders>();
  for (const order of eventOrders) {
    const list = ordersByEvent.get(order.eventId) ?? [];
    list.push(order);
    ordersByEvent.set(order.eventId, list);
  }

  function eventRevenueEur(eventId: string): number {
    const orders = ordersByEvent.get(eventId) ?? [];
    let total = 0;
    for (const order of orders) {
      const content = readJsonRecord(order.contentJson);
      const value =
        readNumberFromJson(content, ["revenueEur", "totalEur", "total", "amount", "amountEur"]) ?? 0;
      total += value;
    }
    return total;
  }

  function eventAttendees(setupJson: unknown): number | undefined {
    const record = readJsonRecord(setupJson);
    return readNumberFromJson(record, ["expectedAttendees", "attendees", "pax", "expectedPax"]);
  }

  const eventsInWindow = events.filter((e) => e.startAt >= from && e.startAt < to);
  const upcomingEventsList = eventsInWindow.slice(0, 20).map((e) => {
    const revenue = eventRevenueEur(e.id);
    const attendees = eventAttendees(e.setupJson);
    const row: GroupsEventsDashboard["upcomingEvents"][number] = {
      id: e.id,
      name: e.name,
      eventDate: e.startAt.toISOString()
    };
    if (e.eventSpaceId) {
      const spaceName = spaceNameById.get(e.eventSpaceId);
      if (spaceName) row.spaceName = spaceName;
    }
    if (attendees !== undefined) row.expectedAttendees = attendees;
    if (revenue > 0) row.revenueEur = round2(revenue);
    return row;
  });

  // F&B revenue MTD — sum revenue across orders attached to events whose
  // startAt is inside the current calendar month. (No invoice link in
  // schema; this is the best-effort proxy.)
  let fAndBRevenueMtdEur = 0;
  for (const e of events) {
    if (e.startAt >= monthStart && e.startAt < now) {
      fAndBRevenueMtdEur += eventRevenueEur(e.id);
    }
  }
  fAndBRevenueMtdEur = round2(fAndBRevenueMtdEur);

  // --- Upcoming groups --------------------------------------------------
  const upcomingGroups = activeGroups
    .filter((g) => g.arrivalDate >= from && g.arrivalDate < to)
    .slice(0, 20)
    .map((g) => {
      const agg = blocksByGroup.get(g.id) ?? { blocked: 0, pickedUp: 0, value: 0 };
      const pPct = agg.blocked > 0 ? round1((agg.pickedUp / agg.blocked) * 100) : 0;
      const row: GroupsEventsDashboard["upcomingGroups"][number] = {
        id: g.id,
        name: g.name,
        roomsBlocked: agg.blocked,
        pickedUp: agg.pickedUp,
        pickupPct: pPct
      };
      if (g.arrivalDate) row.arrivalDate = g.arrivalDate.toISOString();
      if (g.departureDate) row.departureDate = g.departureDate.toISOString();
      return row;
    });

  // --- Top accounts -----------------------------------------------------
  const accountBucket = new Map<string, { accountName: string; activeGroups: number; valueEur: number }>();
  for (const g of activeGroups) {
    if (!g.accountId) continue;
    const name = accountNameById.get(g.accountId) ?? "Unknown account";
    const agg = blocksByGroup.get(g.id);
    const value = agg ? agg.value : 0;
    const bucket = accountBucket.get(g.accountId) ?? { accountName: name, activeGroups: 0, valueEur: 0 };
    bucket.activeGroups += 1;
    bucket.valueEur += value;
    accountBucket.set(g.accountId, bucket);
  }

  const topAccounts = Array.from(accountBucket.values())
    .map((row) => ({
      accountName: row.accountName,
      activeGroups: row.activeGroups,
      valueEur: round2(row.valueEur)
    }))
    .sort((a, b) => b.valueEur - a.valueEur || b.activeGroups - a.activeGroups)
    .slice(0, 10);

  return {
    kpis: {
      activeGroupBookings: activeGroups.length,
      roomsBlockedTotal,
      pickupPct,
      upcomingEvents: eventsInWindow.length,
      fAndBRevenueMtdEur
    },
    upcomingGroups,
    upcomingEvents: upcomingEventsList,
    topAccounts
  };
}
