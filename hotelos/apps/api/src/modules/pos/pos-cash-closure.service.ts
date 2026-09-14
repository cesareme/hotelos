// POS cash summary ("arqueo") — Tanda 2 · FISC-05.
//
// Read model over `pos_orders`: every ticket CLOSED inside the window,
// grouped by outlet and by settlement (cash / card / room). It reads the
// columns closePosTicket persists in the same transaction as the folio charge
// (settlement, closed_at, closed_by_user_id), so the count is reproducible
// after a restart and identical on every API instance sharing the database.
//
// Honesty rules:
//   * Only Prisma rows count. Synthetic demo tickets (pos.service.ts) never
//     enter a cash summary, even for the demo properties.
//   * Rows closed before the settlement column existed (or with an unknown
//     value) cannot be attributed to a payment method: they are reported under
//     `unsettled` with their count and amount instead of being guessed. They
//     still count in `tickets` / `total`, which is real closed revenue.
//   * Rows with status `closed` but no `closed_at` cannot be placed in ANY
//     window. They are closed revenue nonetheless, so they are surfaced under
//     `unplaceable` (count, amount, ids — window-independent) instead of being
//     silently dropped; they never enter `totals` because no day owns them.
//   * Tickets still open are not revenue: `openTickets` reports how many
//     tickets opened inside the window are still pending so the cashier can
//     see what is missing from the count before signing it.
//   * The two side counters (`openTickets`, `unplaceable`) go through `safe()`
//     (QC-06): a failed sub-query keeps the payload shape, lists its label in
//     `degraded[]` and logs once. The closed-revenue query itself is never
//     degraded — a cash count with invented zeros is worse than a 500.
//
// Wiring (server group): GET /properties/:propertyId/pos/cash-summary
//   ?date=YYYY-MM-DD            → one property-local business day, or
//   ?from&to                    → explicit window (day or instant bounds)
//   &outletId                   → optional outlet filter
// → getCashSummary(params.propertyId, request.query). Tenancy: the global
// propertyId hook. RBAC manifest: the read key already used by the POS board
// routes ("folio.charge.post" — the manifest has no POS-specific read key).
import { prisma } from "@hotelos/database";
import type { Prisma } from "@hotelos/database";
import { createDegradedCollector } from "../../lib/degraded.js";
import { BadRequestError, NotFoundError } from "../../lib/http-error.js";
import {
  POS_SETTLEMENTS,
  boardOutletId,
  isBoardOutletId,
  isPosSettlement,
  loadOutletRows,
  outletCode,
  resolvePropertyTimeZone,
  startOfDayInTimeZone,
  zonedMidnight,
  type OutletRow,
  type PosSettlement
} from "./pos.service.js";

export type PosCashWindowQuery = {
  /**
   * Calendar day `YYYY-MM-DD` (property-local). Shorthand for
   * `from=<date>&to=<date + 1 day>`; cannot be combined with a `from` / `to`
   * query string. Null is "not given" (the resolved window echoes it back).
   */
  date?: string | null;
  /**
   * ISO-8601 instant, or a calendar day `YYYY-MM-DD` (property-local midnight).
   * Default: start of today (property-local). A `Date` is an already-resolved
   * bound (route → service handoff) and is used as-is.
   */
  from?: string | Date;
  /** ISO-8601 instant, or a calendar day `YYYY-MM-DD` (property-local midnight, exclusive). Default: now. A `Date` is used as-is. */
  to?: string | Date;
};

export type PosCashSummaryQuery = PosCashWindowQuery & {
  /** Board outlet id (`out_<outletType>`) or an Outlet row id of the property. Default: every outlet. */
  outletId?: string;
};

export type PosCashWindow = {
  from: Date;
  /** Exclusive. */
  to: Date;
  /** Normalised `YYYY-MM-DD` when the window came from `date`; null for from/to or the defaults. */
  date: string | null;
};

export type PosCashBySettlement = Record<PosSettlement, number>;
export type PosCashUnsettled = { tickets: number; total: number; reason: "settlement_missing" };

/** Tickets with status `open` created inside the window (see header). */
export type PosCashOpenTickets = { count: number; total: number };

/**
 * Rows with status `closed` and `closed_at IS NULL`: closed revenue that no
 * window can own. Window-independent (only the outlet filter applies).
 * `ids` lists at most UNPLACEABLE_IDS_LIMIT ids (oldest first) so a backfill
 * can target them; `tickets` / `total` always cover every such row.
 */
export type PosCashUnplaceable = { tickets: number; total: number; ids: string[]; reason: "closed_at_missing" };

export type PosCashOutletSummary = {
  /** Board outlet id (`out_<outletType>`); null only for an orphan Outlet FK. */
  outletId: string | null;
  /** Outlet row id (Outlet.id) the tickets are attached to. */
  outletRowId: string;
  /** Outlet.name; null only for an orphan Outlet FK. */
  outletName: string | null;
  tickets: number;
  total: number;
  bySettlement: PosCashBySettlement;
  unsettled: PosCashUnsettled;
};

export type PosCashSummary = {
  propertyId: string;
  from: string;
  to: string;
  /** Echo of `date` (normalised) when the window was requested as a business day; null otherwise. */
  date: string | null;
  /** Echo of the filter as received (board id or row id); null when not filtered. */
  outletId: string | null;
  timeZone: string;
  timeZoneSource: "property" | "utc_fallback";
  byOutlet: PosCashOutletSummary[];
  totals: {
    tickets: number;
    total: number;
    bySettlement: PosCashBySettlement;
    unsettled: PosCashUnsettled;
  };
  openTickets: PosCashOpenTickets;
  unplaceable: PosCashUnplaceable;
  /** Labels of the side counters that fell back to zero because their query failed (QC-06). */
  degraded: string[];
  source: "pos_orders";
};

const DAY_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const UNPLACEABLE_IDS_LIMIT = 500;

type CalendarDay = { year: number; month: number; day: number };

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
function dec(value: Prisma.Decimal | number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  return typeof value === "number" ? value : Number(value);
}
function emptyBySettlement(): PosCashBySettlement {
  const out = {} as PosCashBySettlement;
  for (const settlement of POS_SETTLEMENTS) out[settlement] = 0;
  return out;
}
function emptyUnsettled(): PosCashUnsettled {
  return { tickets: 0, total: 0, reason: "settlement_missing" };
}
function emptyOpenTickets(): PosCashOpenTickets {
  return { count: 0, total: 0 };
}
function emptyUnplaceable(): PosCashUnplaceable {
  return { tickets: 0, total: 0, ids: [], reason: "closed_at_missing" };
}

function invalidDate(param: string, value: string): BadRequestError {
  const error = new BadRequestError(`Fecha no válida: ${value}`);
  error.details = { code: "INVALID_DATE", param, value };
  return error;
}

/**
 * A `YYYY-MM-DD` that passes the regex is not necessarily a day: `Date.UTC`
 * silently rolls 2026-02-30 into March and 2026-13-01 into the next year.
 * Rebuild the day from the UTC timestamp and demand the same Y-M-D back.
 */
function isRealCalendarDay({ year, month, day }: CalendarDay): boolean {
  const probe = new Date(Date.UTC(year, month - 1, day));
  return probe.getUTCFullYear() === year && probe.getUTCMonth() === month - 1 && probe.getUTCDate() === day;
}

/** `YYYY-MM-DD` → validated calendar day, or null when the value is not day-shaped at all. */
function parseCalendarDay(value: string, param: string): CalendarDay | null {
  const match = DAY_ONLY.exec(value);
  if (!match) return null;
  const candidate = { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
  if (!isRealCalendarDay(candidate)) throw invalidDate(param, value);
  return candidate;
}

function nextCalendarDay({ year, month, day }: CalendarDay): CalendarDay {
  const next = new Date(Date.UTC(year, month - 1, day + 1));
  return { year: next.getUTCFullYear(), month: next.getUTCMonth() + 1, day: next.getUTCDate() };
}

function formatCalendarDay({ year, month, day }: CalendarDay): string {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** Query parameters arrive as `unknown`: absent / null / blank all mean "not given". */
function isAbsent(raw: unknown): boolean {
  return raw === undefined || raw === null || (typeof raw === "string" && raw.trim() === "");
}

/**
 * Parses a window bound. A bare calendar day is the property-local midnight of
 * that day (so `from=2026-09-14&to=2026-09-15` is one local business day) and
 * must exist on the calendar; anything else must be a valid ISO-8601 instant.
 * A `Date` instance is an already-resolved bound and passes through (after an
 * Invalid Date check) — query strings never produce one, only code does.
 */
export function parseBound(raw: unknown, name: "from" | "to", timeZone: string): Date | null {
  if (isAbsent(raw)) return null;
  if (raw instanceof Date) {
    if (Number.isNaN(raw.getTime())) throw new BadRequestError(`El parámetro ${name} no es válido.`);
    return raw;
  }
  if (typeof raw !== "string") throw new BadRequestError(`El parámetro ${name} no es válido.`);
  const value = raw.trim();
  const day = parseCalendarDay(value, name);
  if (day) {
    const parsed = zonedMidnight(day.year, day.month, day.day, timeZone);
    if (Number.isNaN(parsed.getTime())) throw invalidDate(name, value);
    return parsed;
  }
  const instant = new Date(value);
  if (Number.isNaN(instant.getTime())) {
    throw new BadRequestError(`El parámetro ${name} debe ser una fecha ISO-8601 (YYYY-MM-DD o fecha y hora).`);
  }
  return instant;
}

/**
 * Pure window resolver shared by the service and the HTTP route.
 *
 *   * `date=YYYY-MM-DD` → [local midnight of that day, local midnight of the
 *     next day) in `timeZone` — computed as two midnights, not "+24h", so a
 *     DST switch yields the real 23h / 25h business day. `date` is a calendar
 *     day only (no instants) and cannot be combined with `from` / `to`.
 *   * otherwise `from` / `to` as in parseBound, defaulting to
 *     [start of today (local), now).
 *
 * Idempotent on its own output: the route resolves the window once and hands
 * `{ from: Date, to: Date, date }` to the service, which resolves again. `Date`
 * bounds are therefore accepted as-is and `date` is then only an echo — the
 * date-vs-from/to conflict applies to query strings, the only place where the
 * two can genuinely contradict each other.
 *
 * Throws BadRequestError (400) on any malformed or contradictory input.
 */
export function resolveCashSummaryWindow(query: PosCashWindowQuery, timeZone: string, now: Date = new Date()): PosCashWindow {
  const hasDate = !isAbsent(query.date);
  const hasStringRange = (typeof query.from === "string" && !isAbsent(query.from)) || (typeof query.to === "string" && !isAbsent(query.to));
  if (hasDate && hasStringRange) {
    const error = new BadRequestError("Indica date o from/to, no ambos.");
    error.details = { code: "WINDOW_PARAMS_CONFLICT" };
    throw error;
  }
  if (hasDate && typeof query.date !== "string") throw new BadRequestError("El parámetro date no es válido.");
  if (hasDate && (query.from instanceof Date || query.to instanceof Date)) {
    // Already-resolved window with its `date` echo: validate the echo, keep the bounds.
    const day = parseCalendarDay((query.date as string).trim(), "date");
    if (!day) throw new BadRequestError("El parámetro date debe ser un día YYYY-MM-DD.");
    const from = parseBound(query.from, "from", timeZone) ?? startOfDayInTimeZone(now, timeZone);
    const to = parseBound(query.to, "to", timeZone) ?? now;
    if (from.getTime() >= to.getTime()) throw new BadRequestError("El parámetro from debe ser anterior a to.");
    return { from, to, date: formatCalendarDay(day) };
  }
  if (hasDate) {
    const value = (query.date as string).trim();
    const day = parseCalendarDay(value, "date");
    if (!day) throw new BadRequestError("El parámetro date debe ser un día YYYY-MM-DD.");
    const from = zonedMidnight(day.year, day.month, day.day, timeZone);
    const next = nextCalendarDay(day);
    const to = zonedMidnight(next.year, next.month, next.day, timeZone);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) throw invalidDate("date", value);
    return { from, to, date: formatCalendarDay(day) };
  }
  const from = parseBound(query.from, "from", timeZone) ?? startOfDayInTimeZone(now, timeZone);
  const to = parseBound(query.to, "to", timeZone) ?? now;
  if (from.getTime() >= to.getTime()) {
    throw new BadRequestError("El parámetro from debe ser anterior a to.");
  }
  return { from, to, date: null };
}

/**
 * Resolves the optional outlet filter to Outlet row ids of the property.
 * A board id (`out_bar`) matches every row with that outletType — an outlet
 * that has no row yet simply has no tickets (empty summary, not a 404).
 * A raw id must be an Outlet row of this property, otherwise an opaque 404.
 */
function resolveOutletFilter(outletRows: OutletRow[], requested: string | undefined): string[] | null {
  if (!requested) return null;
  const value = requested.trim();
  if (!value) return null;
  if (isBoardOutletId(value)) {
    const code = outletCode(value);
    return outletRows.filter((row) => row.outletType === code).map((row) => row.id);
  }
  const row = outletRows.find((candidate) => candidate.id === value);
  if (!row) throw new NotFoundError("Punto de venta no encontrado.");
  return [row.id];
}

type PosOrderScope = { propertyId: string; outletId?: { in: string[] } };

/**
 * Open tickets created inside the window. Criterion: `status = 'open'` and
 * `created_at ∈ [from, to)` — an open ticket belongs to the business day it
 * was opened on, so each day's count shows the tickets that day still owes.
 * (An open ticket from an earlier day shows up in that day's summary, not
 * here; `closed_at` is null on every open row, so it cannot be used.)
 */
async function loadOpenTickets(scope: PosOrderScope, from: Date, to: Date): Promise<PosCashOpenTickets> {
  const agg = await prisma.posOrder.aggregate({
    where: { ...scope, status: "open", createdAt: { gte: from, lt: to } },
    _count: { _all: true },
    _sum: { total: true }
  });
  return { count: agg._count._all, total: round2(dec(agg._sum.total)) };
}

/** Closed rows without `closed_at` (see PosCashUnplaceable). */
async function loadUnplaceable(scope: PosOrderScope): Promise<PosCashUnplaceable> {
  const where = { ...scope, status: "closed", closedAt: null };
  const [agg, rows] = await Promise.all([
    prisma.posOrder.aggregate({ where, _count: { _all: true }, _sum: { total: true } }),
    prisma.posOrder.findMany({
      where,
      select: { id: true },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: UNPLACEABLE_IDS_LIMIT
    })
  ]);
  return {
    tickets: agg._count._all,
    total: round2(dec(agg._sum.total)),
    ids: rows.map((row) => row.id),
    reason: "closed_at_missing"
  };
}

export async function getCashSummary(propertyId: string, query: PosCashSummaryQuery = {}): Promise<PosCashSummary> {
  const { timeZone, timeZoneSource } = await resolvePropertyTimeZone(propertyId);
  const { from, to, date } = resolveCashSummaryWindow(query, timeZone);

  const outletRows = await loadOutletRows(propertyId);
  const outletFilter = resolveOutletFilter(outletRows, query.outletId);
  const requestedOutletId = query.outletId?.trim() || null;

  const empty = (): PosCashSummary => ({
    propertyId,
    from: from.toISOString(),
    to: to.toISOString(),
    date,
    outletId: requestedOutletId,
    timeZone,
    timeZoneSource,
    byOutlet: [],
    totals: { tickets: 0, total: 0, bySettlement: emptyBySettlement(), unsettled: emptyUnsettled() },
    openTickets: emptyOpenTickets(),
    unplaceable: emptyUnplaceable(),
    degraded: [],
    source: "pos_orders"
  });

  // A board outlet with no row yet cannot have tickets: answer without querying.
  if (outletFilter && outletFilter.length === 0) return empty();

  const scope: PosOrderScope = { propertyId, ...(outletFilter ? { outletId: { in: outletFilter } } : {}) };
  const kpi = createDegradedCollector("pos.cash-summary", {
    propertyId,
    from: from.toISOString(),
    to: to.toISOString(),
    outletId: requestedOutletId
  });

  // The closed-revenue groupBy is the count itself and fails loudly; only the
  // two side counters degrade (fallback + label), see the header.
  const [groups, openTickets, unplaceable] = await Promise.all([
    prisma.posOrder.groupBy({
      by: ["outletId", "settlement"],
      where: { ...scope, status: "closed", closedAt: { gte: from, lt: to } },
      _count: { _all: true },
      _sum: { total: true }
    }),
    kpi.safe("openTickets", loadOpenTickets(scope, from, to), emptyOpenTickets()),
    kpi.safe("unplaceable", loadUnplaceable(scope), emptyUnplaceable())
  ]);

  const outletById = new Map(outletRows.map((row) => [row.id, row]));
  const byOutletId = new Map<string, PosCashOutletSummary>();
  const summary = empty();
  summary.openTickets = openTickets;
  summary.unplaceable = unplaceable;
  summary.degraded = kpi.degraded;

  for (const group of groups) {
    const tickets = group._count._all;
    const amount = round2(dec(group._sum.total));
    let bucket = byOutletId.get(group.outletId);
    if (!bucket) {
      const outlet = outletById.get(group.outletId);
      bucket = {
        outletId: outlet ? boardOutletId(outlet.outletType) : null,
        outletRowId: group.outletId,
        outletName: outlet?.name ?? null,
        tickets: 0,
        total: 0,
        bySettlement: emptyBySettlement(),
        unsettled: emptyUnsettled()
      };
      byOutletId.set(group.outletId, bucket);
    }
    bucket.tickets += tickets;
    bucket.total = round2(bucket.total + amount);
    summary.totals.tickets += tickets;
    summary.totals.total = round2(summary.totals.total + amount);
    if (isPosSettlement(group.settlement)) {
      bucket.bySettlement[group.settlement] = round2(bucket.bySettlement[group.settlement] + amount);
      summary.totals.bySettlement[group.settlement] = round2(summary.totals.bySettlement[group.settlement] + amount);
    } else {
      bucket.unsettled.tickets += tickets;
      bucket.unsettled.total = round2(bucket.unsettled.total + amount);
      summary.totals.unsettled.tickets += tickets;
      summary.totals.unsettled.total = round2(summary.totals.unsettled.total + amount);
    }
  }

  summary.byOutlet = Array.from(byOutletId.values()).sort((a, b) => {
    const nameA = a.outletName ?? "";
    const nameB = b.outletName ?? "";
    if (nameA !== nameB) {
      if (!nameA) return 1;
      if (!nameB) return -1;
      return nameA.localeCompare(nameB, "es");
    }
    return a.outletRowId.localeCompare(b.outletRowId);
  });
  return summary;
}

export type PosCashSummaryInput = { propertyId: string } & PosCashSummaryQuery;

/** Single-object form used by the server.ts handler (`GET /properties/:propertyId/pos/cash-summary`). */
export async function getPosCashSummary(input: PosCashSummaryInput): Promise<PosCashSummary> {
  const { propertyId, ...query } = input;
  return getCashSummary(propertyId, query);
}
