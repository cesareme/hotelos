// POS cash summary ("arqueo" read model) and CASH CLOSURES (persisted counts).
//
// Tanda 2 · FISC-05 — cash summary: read model over `pos_orders`, every ticket
// CLOSED inside the window, grouped by outlet and by settlement (cash / card /
// room). It reads the columns closePosTicket persists in the same transaction
// as the folio charge (settlement, closed_at, closed_by_user_id), so the count
// is reproducible after a restart and identical on every API instance sharing
// the database.
//
// Honesty rules of the summary:
//   * Only Prisma rows count. Nothing is invented for an empty day.
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
// Finanzas (2026-09-15, lote «pos-noche») — cash closures (CashClosure,
// contract §1.5), unique per (property, outlet, business day):
//   open   → fondo de caja + a preview of the expected amounts so far;
//   close  → recount per method, expected recomputed at that instant
//            (fondo + cobros − devoluciones + ventas TPV − gastos de caja),
//            differences per method, notes, signed by the closing user; the
//            CASH difference is posted through the ledger port (rule
//            buildCashClosureDifferenceEntry: faltante D 659 / H 570 · sobrante
//            D 570 / H 759) and the closed POS tickets of the outlet/day are
//            linked (PosOrder.cashClosureId); from then on cash/card sales of
//            that outlet and day are refused (409 CASH_CLOSURE_CLOSED);
//   approve → management sign-off (status approved).
// The property-wide closure (outletId "*") covers folio payments + every
// outlet's POS sales + petty-cash expenses; an outlet closure covers only that
// outlet's POS sales. A property either closes per outlet or globally for a
// day — never both (the "*" row also blocks every outlet's sales).
import { prisma } from "@hotelos/database";
import type { Prisma } from "@hotelos/database";
import { Prisma as PrismaRuntime } from "@prisma/client";
import { createDegradedCollector } from "../../lib/degraded.js";
import type { UserContext } from "../../lib/demo-store.js";
import { BadRequestError, ConflictError, NotFoundError } from "../../lib/http-error.js";
import { recordAuditEvent, recordDomainEvent } from "../audit/audit.service.js";
import { requirePermissions } from "../auth/auth.service.js";
import { buildCashClosureDifferenceEntry } from "../accounting/posting-rules.js";
import { getLedgerPort } from "./accounting-ledger.port.js";
import {
  CASH_METHODS,
  computeCashExpectation,
  legacyMethodToCode,
  reconcileCashCount,
  settlementToMethod,
  sumDenominations,
  type CashExpectation,
  type CashMethod,
  type MethodAmounts,
  type MethodFigures
} from "./pos-cash-core.js";
import {
  POS_SETTLEMENTS,
  boardOutletId,
  formatCalendarDay,
  isBoardOutletId,
  isPosSettlement,
  loadOutletRows,
  outletCode,
  resolveOutletRowId,
  resolvePropertyTimeZone,
  startOfDayInTimeZone,
  zonedMidnight,
  zonedParts,
  type OutletRow,
  type PosSettlement
} from "./pos.service.js";

const Decimal = PrismaRuntime.Decimal;

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

// ═══════════════════════════════════════════════════════════════════════════
// Cash closures (CashClosure) — Finanzas 2026-09-15
// ═══════════════════════════════════════════════════════════════════════════

export const RECEPTION_OUTLET_ID = "*";

export type CashClosureStatus = "open" | "closed" | "approved";

export type CashExpectationDetail = CashExpectation["detail"];

export type CashDenominationCount = { denomination: string; quantity: number; amount: string };

export type CashClosureRecord = {
  id: string;
  propertyId: string;
  /** "*" (recepción) or the board outlet id (`out_<type>`). */
  outletId: string;
  /** "*" or the Outlet row id. */
  outletRowId: string;
  outletName: string | null;
  businessDate: string;
  status: CashClosureStatus;
  openedAt: string;
  closedAt: string | null;
  approvedAt: string | null;
  openedBy: string | null;
  closedBy: string | null;
  approvedBy: string | null;
  openingFloat: string;
  expectedCash: string;
  countedCash: string | null;
  difference: string | null;
  byMethod: Record<CashMethod, MethodFigures>;
  expectation: CashExpectationDetail;
  counts: CashDenominationCount[];
  notes: string | null;
  journalEntryId: string | null;
  linkedTickets: number;
};

type CashClosureRow = Prisma.CashClosureGetPayload<Record<string, never>>;
type ExpectedJson = Partial<Record<CashMethod, Partial<MethodFigures>>> & { _detail?: CashExpectationDetail };

function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function emptyMethodAmounts(): MethodAmounts {
  const out = {} as MethodAmounts;
  for (const method of CASH_METHODS) out[method] = "0.00";
  return out;
}

function emptyDetail(openingFloat: string): CashExpectationDetail {
  return { openingFloat, payments: emptyMethodAmounts(), refunds: emptyMethodAmounts(), posSales: emptyMethodAmounts(), cashExpenses: "0.00" };
}

function closureError(code: string, message: string, extra: Record<string, unknown> = {}): ConflictError {
  return new ConflictError(message, { code, ...extra });
}

/**
 * The closure that blocks cash/card sales of `outletRowId` on `businessDate`:
 * the outlet's own closed/approved row or the property-wide ("*") one.
 */
export async function findBlockingCashClosureTx(
  tx: Pick<Prisma.TransactionClient, "cashClosure">,
  propertyId: string,
  outletRowId: string,
  businessDate: Date
): Promise<{ id: string; outletId: string; status: CashClosureStatus } | null> {
  const row = await tx.cashClosure.findFirst({
    where: { propertyId, businessDate, outletId: { in: [outletRowId, RECEPTION_OUTLET_ID] }, status: { in: ["closed", "approved"] } },
    select: { id: true, outletId: true, status: true },
    orderBy: [{ outletId: "asc" }]
  });
  return row ? { id: row.id, outletId: row.outletId, status: row.status } : null;
}

type MovementClient = Pick<Prisma.TransactionClient, "payment" | "paymentRefund" | "posOrder" | "expense">;

export type DayMovements = CashExpectation & { linkedTicketIds: string[] };

/**
 * Movements of one business day for a cash count. Property-wide ("*"): folio
 * payments (Payment, status captured/refunded, originals only), refunds
 * (PaymentRefund ledger — the reversal Payment rows of the payments lote mirror
 * the same refunds and are NOT counted twice), POS cash/card sales of every
 * outlet, petty-cash expenses paid in cash. Outlet closure: only that outlet's
 * POS sales. Window = [local midnight, next local midnight) of `day`.
 */
export async function loadDayMovements(
  client: MovementClient,
  input: { propertyId: string; outletRowId: string; day: CalendarDay; timeZone: string; openingFloat: string | number }
): Promise<DayMovements> {
  const from = zonedMidnight(input.day.year, input.day.month, input.day.day, input.timeZone);
  const next = nextCalendarDay(input.day);
  const to = zonedMidnight(next.year, next.month, next.day, input.timeZone);
  const businessDate = new Date(Date.UTC(input.day.year, input.day.month - 1, input.day.day));
  const propertyWide = input.outletRowId === RECEPTION_OUTLET_ID;

  const payments: Array<{ method: CashMethod; amount: string }> = [];
  const refunds: Array<{ method: CashMethod; amount: string }> = [];
  const cashExpenses: string[] = [];
  if (propertyWide) {
    const rows = await client.payment.findMany({
      where: { propertyId: input.propertyId, deletedAt: null, status: { in: ["captured", "refunded"] }, reversalOfId: null, createdAt: { gte: from, lt: to } },
      select: { id: true, amount: true, method: true, methodCode: true },
      take: 10_000
    });
    for (const row of rows) {
      payments.push({ method: (row.methodCode as CashMethod | null) ?? legacyMethodToCode(row.method), amount: new Decimal(row.amount).toFixed(2) });
    }
    const refundRows = await client.paymentRefund.findMany({
      where: { createdAt: { gte: from, lt: to }, status: { notIn: ["failed", "rejected", "cancelled"] } },
      select: { paymentId: true, amount: true },
      take: 10_000
    });
    if (refundRows.length > 0) {
      const refundedPayments = await client.payment.findMany({
        where: { id: { in: Array.from(new Set(refundRows.map((r) => r.paymentId))) }, propertyId: input.propertyId },
        select: { id: true, method: true, methodCode: true }
      });
      const byId = new Map(refundedPayments.map((p) => [p.id, p]));
      for (const refund of refundRows) {
        const payment = byId.get(refund.paymentId);
        if (!payment) continue; // refund of another property's payment
        refunds.push({ method: (payment.methodCode as CashMethod | null) ?? legacyMethodToCode(payment.method), amount: new Decimal(refund.amount).toFixed(2) });
      }
    }
    const expenses = await client.expense.findMany({
      where: { propertyId: input.propertyId, paidWith: "cash", cancelledAt: null, date: businessDate },
      select: { total: true },
      take: 10_000
    });
    for (const expense of expenses) cashExpenses.push(new Decimal(expense.total).toFixed(2));
  }

  const tickets = await client.posOrder.findMany({
    where: {
      propertyId: input.propertyId,
      status: "closed",
      settlement: { in: ["cash", "card"] },
      businessDate,
      ...(propertyWide ? {} : { outletId: input.outletRowId })
    },
    select: { id: true, total: true, settlement: true },
    take: 10_000
  });
  const posSales = tickets.map((t) => ({ method: settlementToMethod(t.settlement as "cash" | "card"), amount: new Decimal(t.total).toFixed(2) }));

  const expectation = computeCashExpectation({ openingFloat: input.openingFloat, payments, refunds, posSales, cashExpenses });
  return { ...expectation, linkedTicketIds: tickets.map((t) => t.id) };
}

async function resolveClosureOutlet(propertyId: string, requested: string | undefined): Promise<{ outletRowId: string; outletId: string; outletName: string | null }> {
  const value = (requested ?? RECEPTION_OUTLET_ID).trim();
  if (!value || value === RECEPTION_OUTLET_ID) return { outletRowId: RECEPTION_OUTLET_ID, outletId: RECEPTION_OUTLET_ID, outletName: null };
  if (isBoardOutletId(value)) {
    const outletRowId = await resolveOutletRowId(propertyId, value);
    const row = (await loadOutletRows(propertyId)).find((r) => r.id === outletRowId);
    return { outletRowId, outletId: value, outletName: row?.name ?? null };
  }
  const row = (await loadOutletRows(propertyId)).find((r) => r.id === value);
  if (!row) {
    const error = new NotFoundError("Punto de venta no encontrado.");
    error.details = { code: "POS_OUTLET_NOT_FOUND", outletId: value };
    throw error;
  }
  return { outletRowId: row.id, outletId: boardOutletId(row.outletType), outletName: row.name };
}

async function mapClosure(row: CashClosureRow, outletRows?: OutletRow[]): Promise<CashClosureRecord> {
  const rows = outletRows ?? (row.outletId === RECEPTION_OUTLET_ID ? [] : await loadOutletRows(row.propertyId));
  const outlet = row.outletId === RECEPTION_OUTLET_ID ? null : rows.find((r) => r.id === row.outletId) ?? null;
  const expected = (row.expectedByMethodJson ?? {}) as ExpectedJson;
  const counted = (row.countedByMethodJson ?? {}) as Partial<Record<CashMethod, string>>;
  const byMethod = {} as Record<CashMethod, MethodFigures>;
  for (const method of CASH_METHODS) {
    const e = expected[method];
    byMethod[method] = {
      expected: e?.expected ?? "0.00",
      counted: row.status === "open" ? null : (e?.counted ?? counted[method] ?? "0.00"),
      difference: row.status === "open" ? null : (e?.difference ?? null)
    };
  }
  const linkedTickets = await prisma.posOrder.count({ where: { cashClosureId: row.id } });
  return {
    id: row.id,
    propertyId: row.propertyId,
    outletId: outlet ? boardOutletId(outlet.outletType) : RECEPTION_OUTLET_ID,
    outletRowId: row.outletId,
    outletName: outlet?.name ?? null,
    businessDate: isoDay(row.businessDate),
    status: row.status,
    openedAt: row.openedAt.toISOString(),
    closedAt: row.closedAt?.toISOString() ?? null,
    approvedAt: row.approvedAt?.toISOString() ?? null,
    openedBy: row.openedBy,
    closedBy: row.closedBy,
    approvedBy: row.approvedBy,
    openingFloat: new Decimal(row.openingFloat).toFixed(2),
    expectedCash: new Decimal(row.expectedCash).toFixed(2),
    countedCash: row.countedCash === null ? null : new Decimal(row.countedCash).toFixed(2),
    difference: row.difference === null ? null : new Decimal(row.difference).toFixed(2),
    byMethod,
    expectation: expected._detail ?? emptyDetail(new Decimal(row.openingFloat).toFixed(2)),
    counts: Array.isArray(row.countsJson) ? (row.countsJson as CashDenominationCount[]) : [],
    notes: row.notes,
    journalEntryId: row.journalEntryId,
    linkedTickets
  };
}

function expectedJson(expectation: CashExpectation, reconciliation: Record<CashMethod, MethodFigures> | null): Prisma.InputJsonValue {
  const out: ExpectedJson = { _detail: expectation.detail };
  for (const method of CASH_METHODS) {
    out[method] = reconciliation ? reconciliation[method] : { expected: expectation.expectedByMethod[method], counted: null, difference: null };
  }
  return out as unknown as Prisma.InputJsonValue;
}

async function loadClosure(propertyId: string, closureId: string): Promise<CashClosureRow> {
  const row = await prisma.cashClosure.findUnique({ where: { id: closureId } });
  if (!row || row.propertyId !== propertyId) throw new NotFoundError("Cierre de caja no encontrado.");
  return row;
}

export async function getCashClosure(propertyId: string, closureId: string): Promise<CashClosureRecord> {
  return mapClosure(await loadClosure(propertyId, closureId));
}

export type ListCashClosuresQuery = { status?: CashClosureStatus; outletId?: string; from?: string; to?: string; limit?: number };

/** Closures of a property, newest business day first; `status` is honoured. */
export async function listCashClosures(propertyId: string, query: ListCashClosuresQuery = {}): Promise<CashClosureRecord[]> {
  const where: Prisma.CashClosureWhereInput = { propertyId };
  if (query.status) where.status = query.status;
  if (query.outletId) where.outletId = (await resolveClosureOutlet(propertyId, query.outletId)).outletRowId;
  if (query.from || query.to) {
    const range: Prisma.DateTimeFilter = {};
    if (query.from) {
      const day = parseCalendarDay(query.from, "from");
      if (!day) throw new BadRequestError("El parámetro from debe ser un día YYYY-MM-DD.");
      range.gte = new Date(Date.UTC(day.year, day.month - 1, day.day));
    }
    if (query.to) {
      const day = parseCalendarDay(query.to, "to");
      if (!day) throw new BadRequestError("El parámetro to debe ser un día YYYY-MM-DD.");
      range.lte = new Date(Date.UTC(day.year, day.month - 1, day.day));
    }
    where.businessDate = range;
  }
  const rows = await prisma.cashClosure.findMany({
    where,
    orderBy: [{ businessDate: "desc" }, { openedAt: "desc" }],
    take: Math.min(500, Math.max(1, query.limit ?? 100))
  });
  const outletRows = await loadOutletRows(propertyId);
  return Promise.all(rows.map((row) => mapClosure(row, outletRows)));
}

export async function openCashClosure(input: {
  context: UserContext;
  propertyId: string;
  outletId?: string;
  businessDate?: string;
  openingFloat?: number;
  notes?: string;
  correlationId: string;
}): Promise<CashClosureRecord> {
  requirePermissions(input.context, ["pos.order.pay"]);
  const { timeZone } = await resolvePropertyTimeZone(input.propertyId);
  const outlet = await resolveClosureOutlet(input.propertyId, input.outletId);
  let day: CalendarDay;
  if (input.businessDate) {
    const parsed = parseCalendarDay(input.businessDate.trim(), "businessDate");
    if (!parsed) throw new BadRequestError("businessDate debe ser un día YYYY-MM-DD.");
    day = parsed;
  } else {
    const p = zonedParts(new Date(), timeZone);
    day = { year: p.year, month: p.month, day: p.day };
  }
  const businessDate = new Date(Date.UTC(day.year, day.month - 1, day.day));
  const openingFloat = new Decimal(input.openingFloat ?? 0).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  if (openingFloat.lt(0)) throw new BadRequestError("El fondo de caja no puede ser negativo.");

  const existing = await prisma.cashClosure.findUnique({
    where: { propertyId_outletId_businessDate: { propertyId: input.propertyId, outletId: outlet.outletRowId, businessDate } },
    select: { id: true, status: true }
  });
  if (existing) {
    throw closureError("CASH_CLOSURE_EXISTS", `Ya existe un cierre de caja (${existing.status}) para ${outlet.outletName ?? "recepción"} el ${formatCalendarDay(day)}.`, {
      cashClosureId: existing.id,
      status: existing.status,
      businessDate: formatCalendarDay(day)
    });
  }
  const preview = await loadDayMovements(prisma, { propertyId: input.propertyId, outletRowId: outlet.outletRowId, day, timeZone, openingFloat: openingFloat.toFixed(2) });
  const created = await prisma.cashClosure.create({
    data: {
      propertyId: input.propertyId,
      outletId: outlet.outletRowId,
      businessDate,
      status: "open",
      openedAt: new Date(),
      openingFloat: openingFloat.toFixed(2),
      expectedCash: preview.expectedCash,
      expectedByMethodJson: expectedJson(preview, null),
      countedByMethodJson: {},
      countsJson: [],
      notes: input.notes?.trim() || null,
      openedBy: input.context.userId
    }
  });
  recordAuditEvent({
    organizationId: input.context.organizationId,
    propertyId: input.propertyId,
    actorUserId: input.context.userId,
    actorType: "user",
    action: "CASH_CLOSURE_OPENED",
    entityType: "cash_closure",
    entityId: created.id,
    afterJson: { outletId: outlet.outletId, outletRowId: outlet.outletRowId, businessDate: formatCalendarDay(day), openingFloat: openingFloat.toFixed(2), expectedCashPreview: preview.expectedCash },
    correlationId: input.correlationId
  });
  return mapClosure(created);
}

export async function closeCashClosure(input: {
  context: UserContext;
  propertyId: string;
  closureId: string;
  countedByMethod: Partial<Record<CashMethod, number | string>>;
  counts?: Array<{ denomination: string | number; quantity: number }>;
  notes?: string;
  correlationId: string;
}): Promise<CashClosureRecord> {
  requirePermissions(input.context, ["pos.order.pay"]);
  const row = await loadClosure(input.propertyId, input.closureId);
  if (row.status !== "open") {
    throw closureError("CASH_CLOSURE_NOT_OPEN", `El cierre de caja ya está ${row.status === "closed" ? "cerrado" : "aprobado"}.`, { cashClosureId: row.id, status: row.status });
  }
  const property = await prisma.property.findUnique({ where: { id: input.propertyId }, select: { organizationId: true } });
  if (!property) throw new NotFoundError("Propiedad no encontrada.");
  const { timeZone } = await resolvePropertyTimeZone(input.propertyId);
  const day: CalendarDay = { year: row.businessDate.getUTCFullYear(), month: row.businessDate.getUTCMonth() + 1, day: row.businessDate.getUTCDate() };
  const businessDateIso = formatCalendarDay(day);

  let counts: CashDenominationCount[] = [];
  if (input.counts && input.counts.length > 0) {
    let summed: { total: string; rows: CashDenominationCount[] };
    try {
      summed = sumDenominations(input.counts);
    } catch (error) {
      throw new BadRequestError(error instanceof Error ? error.message : String(error));
    }
    counts = summed.rows;
    const countedCash = new Decimal(input.countedByMethod.cash ?? 0).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
    if (!countedCash.equals(new Decimal(summed.total))) {
      const error = new BadRequestError(`El recuento por denominaciones (${summed.total} €) no coincide con el efectivo contado (${countedCash.toFixed(2)} €).`);
      error.details = { code: "CASH_COUNT_MISMATCH", denominationsTotal: summed.total, countedCash: countedCash.toFixed(2) };
      throw error;
    }
  }

  const outletRows = await loadOutletRows(input.propertyId);
  const outlet = row.outletId === RECEPTION_OUTLET_ID ? null : outletRows.find((r) => r.id === row.outletId) ?? null;
  const outletLabel = outlet?.name ?? "Recepción";
  const ledger = getLedgerPort();
  const closedAt = new Date();

  const result = await prisma.$transaction(
    async (tx) => {
      // Re-check under the row lock: two cashiers closing the same count get one 409.
      const fresh = await tx.cashClosure.findUnique({ where: { id: row.id }, select: { status: true } });
      if (!fresh || fresh.status !== "open") {
        throw closureError("CASH_CLOSURE_NOT_OPEN", "El cierre de caja ya no está abierto.", { cashClosureId: row.id, status: fresh?.status ?? null });
      }
      const movements = await loadDayMovements(tx, { propertyId: input.propertyId, outletRowId: row.outletId, day, timeZone, openingFloat: new Decimal(row.openingFloat).toFixed(2) });
      let reconciliation: ReturnType<typeof reconcileCashCount>;
      try {
        reconciliation = reconcileCashCount(movements.expectedByMethod, input.countedByMethod);
      } catch (error) {
        throw new BadRequestError(error instanceof Error ? error.message : String(error));
      }
      let journalEntryId: string | null = null;
      let entryNumber: number | null = null;
      if (!new Decimal(reconciliation.difference).isZero()) {
        const rule = buildCashClosureDifferenceEntry({
          organizationId: property.organizationId,
          propertyId: input.propertyId,
          closureId: row.id,
          entryDate: businessDateIso,
          difference: reconciliation.difference,
          outletLabel
        });
        const posted = await ledger.postJournalEntry(tx, {
          organizationId: property.organizationId,
          propertyId: input.propertyId,
          entryDate: businessDateIso,
          sourceType: "cash_closure",
          sourceId: row.id,
          description: rule.description,
          reference: row.id,
          createdBy: input.context.userId,
          correlationId: input.correlationId,
          lines: rule.lines
        });
        journalEntryId = posted.id;
        entryNumber = posted.entryNumber;
      }
      const countedByMethodJson: Partial<Record<CashMethod, string>> = {};
      for (const method of CASH_METHODS) countedByMethodJson[method] = reconciliation.byMethod[method].counted ?? "0.00";
      const updated = await tx.cashClosure.update({
        where: { id: row.id },
        data: {
          status: "closed",
          closedAt,
          closedBy: input.context.userId,
          expectedCash: movements.expectedCash,
          countedCash: reconciliation.countedCash,
          difference: reconciliation.difference,
          expectedByMethodJson: expectedJson(movements, reconciliation.byMethod),
          countedByMethodJson: countedByMethodJson as Prisma.InputJsonValue,
          countsJson: counts as unknown as Prisma.InputJsonValue,
          notes: input.notes?.trim() || row.notes,
          journalEntryId
        }
      });
      const linked =
        movements.linkedTicketIds.length > 0
          ? await tx.posOrder.updateMany({ where: { id: { in: movements.linkedTicketIds }, cashClosureId: null }, data: { cashClosureId: row.id } })
          : { count: 0 };
      return { updated, reconciliation, movements, journalEntryId, entryNumber, linked: linked.count };
    },
    { maxWait: 10_000, timeout: 30_000 }
  );

  recordAuditEvent({
    organizationId: input.context.organizationId,
    propertyId: input.propertyId,
    actorUserId: input.context.userId,
    actorType: "user",
    action: "CASH_CLOSURE_CLOSED",
    entityType: "cash_closure",
    entityId: row.id,
    beforeJson: { status: "open", openingFloat: new Decimal(row.openingFloat).toFixed(2) },
    afterJson: {
      status: "closed",
      businessDate: businessDateIso,
      outletId: outlet ? boardOutletId(outlet.outletType) : RECEPTION_OUTLET_ID,
      expectedCash: result.movements.expectedCash,
      countedCash: result.reconciliation.countedCash,
      difference: result.reconciliation.difference,
      byMethod: result.reconciliation.byMethod,
      expectation: result.movements.detail,
      journalEntryId: result.journalEntryId,
      entryNumber: result.entryNumber,
      linkedTickets: result.linked,
      closedAt: closedAt.toISOString()
    },
    correlationId: input.correlationId
  });
  recordDomainEvent({
    organizationId: input.context.organizationId,
    propertyId: input.propertyId,
    entityType: "cash_closure",
    entityId: row.id,
    eventType: "CashClosureClosed",
    payload: { businessDate: businessDateIso, outletId: row.outletId, expectedCash: result.movements.expectedCash, countedCash: result.reconciliation.countedCash, difference: result.reconciliation.difference, journalEntryId: result.journalEntryId },
    actorType: "user",
    actorUserId: input.context.userId,
    correlationId: input.correlationId
  });
  return mapClosure(result.updated, outletRows);
}

export async function approveCashClosure(input: { context: UserContext; propertyId: string; closureId: string; notes?: string; correlationId: string }): Promise<CashClosureRecord> {
  requirePermissions(input.context, ["accounting.journal.post"]);
  const row = await loadClosure(input.propertyId, input.closureId);
  if (row.status !== "closed") {
    throw closureError("CASH_CLOSURE_NOT_CLOSED", row.status === "open" ? "El cierre de caja sigue abierto: cierra el recuento antes de aprobarlo." : "El cierre de caja ya está aprobado.", {
      cashClosureId: row.id,
      status: row.status
    });
  }
  const approvedAt = new Date();
  const updated = await prisma.cashClosure.update({
    where: { id: row.id },
    data: { status: "approved", approvedAt, approvedBy: input.context.userId, notes: input.notes?.trim() ? `${row.notes ? `${row.notes}\n` : ""}Aprobación: ${input.notes.trim()}` : row.notes }
  });
  recordAuditEvent({
    organizationId: input.context.organizationId,
    propertyId: input.propertyId,
    actorUserId: input.context.userId,
    actorType: "user",
    action: "CASH_CLOSURE_APPROVED",
    entityType: "cash_closure",
    entityId: row.id,
    beforeJson: { status: "closed" },
    afterJson: { status: "approved", approvedAt: approvedAt.toISOString(), difference: row.difference === null ? null : new Decimal(row.difference).toFixed(2) },
    correlationId: input.correlationId
  });
  return mapClosure(updated);
}
