// Point-of-sale (TPV) — outlets + tickets settled to the room, in cash or by card.
//
// Tanda 2 · FISC-05 / FISC-10: tickets are Prisma-first. A ticket IS a PosOrder
// row (+ PosOrderLine rows, same id): the board, the tenancy resolver and the
// cash summary (pos-cash-closure.service.ts) all read `pos_orders`, so POS
// sales survive restarts and are shared by every API instance on the same
// database.
//
// Finanzas (2026-09-15, lote «pos-noche»):
//   · The synthetic in-memory demo board (five invented tickets for prop_123 /
//     prop_456) is GONE: a board shows persisted tickets or nothing — an
//     invented ticket is invented revenue in a cash count, whatever the
//     property (the «33 comandas cerradas» of the diagnosis never existed in
//     pos_orders: they could only have come from the in-memory mirror).
//   · Closing a ticket settles it in ONE transaction:
//       room → one FolioLine per tax group (10 % hostelería / 21 % alcoholic
//              beverages and general services), typed by the outlet
//              (restaurant / bar / room_service / minibar / spa…), NO journal
//              entry until the folio is invoiced;
//       cash | card → simplified invoice through the invoicing lote
//              (invoicing/simplified-invoice.service createSimplifiedInvoice:
//              F2, series SIM, VeriFactu chain, one VAT-book row per rate and
//              the journal entry D 570|5721 / H 705.x / H 477.tipo, idempotent
//              by posOrderId), then the PosOrder is closed carrying
//              invoiceId / journalEntryId / taxTotal / businessDate. No
//              Payment row is created (there is no folio).
//   · Sales in cash/card are refused (409 CASH_CLOSURE_CLOSED) once the cash
//     closure of that outlet — or the property-wide one — is closed for the
//     business day.
//   · `?status` on the board listing is honoured (open | closed | all).
// Money: Prisma.Decimal inside; the wire keeps plain 2-decimal numbers.
import { prisma } from "@hotelos/database";
import type { Prisma } from "@hotelos/database";
import { Prisma as PrismaRuntime } from "@prisma/client";
import { recordAuditEvent, recordDomainEvent } from "../audit/audit.service.js";
import { requirePermissions } from "../auth/auth.service.js";
import { resolveTaxRate } from "../accounting/tax-rate.service.js";
import { createId, nowIso } from "../../lib/ids.js";
import { BadRequestError, ConflictError, NotFoundError } from "../../lib/http-error.js";
import type { UserContext } from "../../lib/demo-store.js";
import type { SimplifiedInvoiceResult } from "../invoicing/simplified-invoice.service.js";
import { defaultRbacDeps, type RbacDeps } from "../rbac/assignments.service.js";
import { consumeSupervisorAuthorization } from "../rbac/supervisor.service.js";
import { computePosTicketTax, folioLineTypeForOutlet, type PosRateTable, type PosTaxCategory, type PosTaxableLine, type PosTicketTax } from "./pos-tax.js";
import { findBlockingCashClosureTx } from "./pos-cash-closure.service.js";
import { POS_VOID_REASON_CODES, type PosVoidReasonCode } from "./pos.schemas.js";

const Decimal = PrismaRuntime.Decimal;

export type PosSettlement = "room" | "cash" | "card";
export const POS_SETTLEMENTS: readonly PosSettlement[] = ["room", "cash", "card"];

export function isPosSettlement(value: unknown): value is PosSettlement {
  return typeof value === "string" && (POS_SETTLEMENTS as readonly string[]).includes(value);
}

/** Message shared by every "ticket already closed" 409 (pre-check and optimistic-lock miss). */
export const POS_TICKET_CLOSED_MESSAGE = "La comanda ya está cerrada.";

/**
 * One 409 for every "already closed" path (FISC-05). The pre-check on the
 * loaded ticket and the optimistic-lock miss inside the transaction state the
 * same business fact — the ticket is closed and immutable — so the client sees
 * one status code and one message whether it lost the race by a second or by
 * a day. `details.code` lets the board drop its stale copy of the ticket.
 */
function ticketAlreadyClosed(ticketId: string): ConflictError {
  const error = new ConflictError(POS_TICKET_CLOSED_MESSAGE);
  error.details = { code: "POS_TICKET_CLOSED", ticketId };
  return error;
}

export type PosOutlet = { id: string; name: string; category: string };
export type PosLine = {
  name: string;
  quantity: number;
  unitPrice: number;
  total: number;
  productId?: string | null;
  /** Resolved at close (cash/card/room); absent on open tickets. */
  taxCategory?: PosTaxCategory;
  alcohol?: boolean;
};
export type PosTicketStatus = "open" | "closed";
export type PosTicket = {
  id: string;
  propertyId: string;
  /** Board outlet id (`out_<outletType>`), shared across properties — see resolveOutletRowId. */
  outletId: string;
  outletName: string;
  status: PosTicketStatus;
  roomNumber?: string;
  lines: PosLine[];
  /** Gross total (tax included). */
  total: number;
  /** Tax included in `total`; 0 on open tickets and on legacy rows closed before this contract. */
  taxTotal: number;
  settlement?: PosSettlement;
  createdAt: string;
  closedAt?: string;
  /** User who closed the ticket; null on rows closed before this column existed. */
  closedByUserId?: string | null;
  businessDate?: string | null;
  invoiceId?: string | null;
  invoiceNumber?: string | null;
  journalEntryId?: string | null;
  cashClosureId?: string | null;
};

const OUTLET_DEFS: { code: string; name: string }[] = [
  { code: "restaurant", name: "Restaurante" },
  { code: "bar", name: "Bar" },
  { code: "cafe", name: "Cafetería" },
  { code: "roomservice", name: "Room service" },
  { code: "spa", name: "Spa" }
];

const BOARD_OUTLET_PREFIX = "out_";

/** Board outlet id for an Outlet row's `outletType`. */
export function boardOutletId(outletType: string): string {
  return `${BOARD_OUTLET_PREFIX}${outletType}`;
}
export function isBoardOutletId(value: string): boolean {
  return value.startsWith(BOARD_OUTLET_PREFIX) && value.length > BOARD_OUTLET_PREFIX.length;
}
export function outletCode(posOutletId: string): string {
  return isBoardOutletId(posOutletId) ? posOutletId.slice(BOARD_OUTLET_PREFIX.length) : posOutletId;
}
function outletName(outletId: string): string {
  return OUTLET_DEFS.find((o) => boardOutletId(o.code) === outletId)?.name ?? outletId;
}

// ── Helpers ──────────────────────────────────────────────────────────────────
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
function dec(value: Prisma.Decimal | number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  return typeof value === "number" ? value : Number(value);
}
function lineTotal(lines: PosLine[]): number {
  return round2(lines.reduce((s, l) => s + l.total, 0));
}
function isoDay(date: Date | null | undefined): string | null {
  return date ? date.toISOString().slice(0, 10) : null;
}

/**
 * Local midnight of `instant` in `timeZone`, as a UTC instant. Two passes so a
 * DST switch at midnight still lands on the right wall-clock day.
 */
export function startOfDayInTimeZone(instant: Date, timeZone: string): Date {
  const local = zonedParts(instant, timeZone);
  const guess = Date.UTC(local.year, local.month - 1, local.day, 0, 0, 0);
  const firstPass = guess - tzOffsetMs(new Date(guess), timeZone);
  return new Date(guess - tzOffsetMs(new Date(firstPass), timeZone));
}

/** Local midnight of the calendar day `YYYY-MM-DD` in `timeZone`, as a UTC instant. */
export function zonedMidnight(year: number, month: number, day: number, timeZone: string): Date {
  const guess = Date.UTC(year, month - 1, day, 0, 0, 0);
  const firstPass = guess - tzOffsetMs(new Date(guess), timeZone);
  return new Date(guess - tzOffsetMs(new Date(firstPass), timeZone));
}

export type ZonedParts = { year: number; month: number; day: number; hour: number; minute: number; second: number };

/** Wall-clock parts of `instant` in `timeZone`. */
export function zonedParts(instant: Date, timeZone: string): ZonedParts {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
  const values: Record<string, number> = {};
  for (const part of formatter.formatToParts(instant)) {
    if (part.type !== "literal") values[part.type] = Number(part.value);
  }
  return {
    year: values.year ?? 1970,
    month: values.month ?? 1,
    day: values.day ?? 1,
    hour: values.hour ?? 0,
    minute: values.minute ?? 0,
    second: values.second ?? 0
  };
}

/** `YYYY-MM-DD` of a calendar day. */
export function formatCalendarDay(day: { year: number; month: number; day: number }): string {
  return `${String(day.year).padStart(4, "0")}-${String(day.month).padStart(2, "0")}-${String(day.day).padStart(2, "0")}`;
}

/** Offset of `timeZone` at `instant`, in ms (local wall clock minus UTC). */
function tzOffsetMs(instant: Date, timeZone: string): number {
  const p = zonedParts(instant, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

/**
 * The property's IANA time zone (Property.timezone). An unparseable value
 * falls back to UTC so a bad setting degrades the day boundary, never the
 * request; the fallback is reported through `timeZoneSource`.
 */
export async function resolvePropertyTimeZone(propertyId: string): Promise<{ timeZone: string; timeZoneSource: "property" | "utc_fallback" }> {
  const property = await prisma.property.findUnique({ where: { id: propertyId }, select: { timezone: true } });
  const candidate = property?.timezone?.trim();
  if (candidate) {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: candidate }).format(new Date());
      return { timeZone: candidate, timeZoneSource: "property" };
    } catch {
      // invalid IANA name → fall through
    }
  }
  return { timeZone: "UTC", timeZoneSource: "utc_fallback" };
}

/** Start of the current business day (local midnight in the property's time zone). */
export async function startOfBusinessDay(propertyId: string, now = new Date()): Promise<Date> {
  const { timeZone } = await resolvePropertyTimeZone(propertyId);
  return startOfDayInTimeZone(now, timeZone);
}

/** Business day of a sale: the property-local calendar day of the instant (UTC midnight Date for the @db.Date column + ISO string). */
export function businessDayOf(instant: Date, timeZone: string): { iso: string; date: Date; parts: { year: number; month: number; day: number } } {
  const p = zonedParts(instant, timeZone);
  const parts = { year: p.year, month: p.month, day: p.day };
  return { iso: formatCalendarDay(parts), date: new Date(Date.UTC(p.year, p.month - 1, p.day)), parts };
}

// ── Outlet rows ──────────────────────────────────────────────────────────────
// PosOrder.outletId must reference a real Outlet row so the POS dashboard and
// the cash summary can label revenue per outlet. The board uses synthetic ids
// (out_restaurant, …) shared across properties, while Outlet.id is a global PK
// — so we resolve (or lazily create) one Outlet row per property+outletType
// and cache the mapping per process (a miss always re-checks the database, so
// a row created by another instance is picked up).
export type OutletRow = { id: string; outletType: string; name: string };

export async function loadOutletRows(propertyId: string): Promise<OutletRow[]> {
  const rows = await prisma.outlet.findMany({
    where: { propertyId },
    select: { id: true, outletType: true, name: true },
    orderBy: [{ name: "asc" }, { id: "asc" }],
    take: 500
  });
  return rows;
}

const outletRowIdCache = new Map<string, string>();
export async function resolveOutletRowId(propertyId: string, posOutletId: string): Promise<string> {
  const code = outletCode(posOutletId);
  const cacheKey = `${propertyId}:${code}`;
  const cached = outletRowIdCache.get(cacheKey);
  if (cached) return cached;
  const existing = await prisma.outlet.findFirst({ where: { propertyId, outletType: code }, orderBy: { id: "asc" } });
  // Only the board catalogue (OUTLET_DEFS) or an outlet the property already
  // has can back a ticket: an arbitrary slug used to create a persistent
  // Outlet row named after the typo.
  if (!existing && !OUTLET_DEFS.some((o) => o.code === code)) {
    const error = new NotFoundError("Punto de venta no encontrado.");
    error.details = { code: "POS_OUTLET_NOT_FOUND", outletId: posOutletId };
    throw error;
  }
  const outlet =
    existing ??
    (await prisma.outlet.create({
      data: { propertyId, name: outletName(boardOutletId(code)), outletType: code, status: "active" }
    }));
  outletRowIdCache.set(cacheKey, outlet.id);
  return outlet.id;
}

/** Best-effort room lookup — a ticket may carry a free-text room number. */
async function findRoomId(propertyId: string, roomNumber: string | undefined): Promise<string | null> {
  if (!roomNumber) return null;
  const room = await prisma.room.findFirst({ where: { propertyId, number: roomNumber }, select: { id: true } });
  return room?.id ?? null;
}

// ── Prisma → ticket mapping ──────────────────────────────────────────────────
type PosOrderRow = Prisma.PosOrderGetPayload<Record<string, never>>;
type PosOrderLineRow = Prisma.PosOrderLineGetPayload<Record<string, never>>;

/** Board statuses. Anything else (voided/cancelled…) is not a ticket to settle or count. */
function boardStatus(status: string): PosTicketStatus | null {
  return status === "open" ? "open" : status === "closed" ? "closed" : null;
}

function mapLine(row: PosOrderLineRow): PosLine {
  return { name: row.description, quantity: dec(row.quantity), unitPrice: dec(row.unitPrice), total: dec(row.total), productId: row.productId ?? null };
}

/**
 * Hydrates PosOrder rows of ONE property into board tickets with batched
 * queries (lines, outlets, rooms, invoices) — never per row. Rows written
 * before the `room_number` column existed fall back to the linked Room's number.
 */
async function hydrateTickets(propertyId: string, orders: PosOrderRow[]): Promise<PosTicket[]> {
  const visible = orders.filter((order) => order.propertyId === propertyId && boardStatus(order.status) !== null);
  if (visible.length === 0) return [];
  const ids = visible.map((order) => order.id);
  const missingRoomIds = Array.from(
    new Set(visible.filter((order) => !order.roomNumber && order.roomId).map((order) => order.roomId as string))
  );
  const invoiceIds = Array.from(new Set(visible.map((order) => order.invoiceId).filter((id): id is string => Boolean(id))));
  const [lineRows, outletRows, roomRows, invoiceRows] = await Promise.all([
    prisma.posOrderLine.findMany({ where: { posOrderId: { in: ids } }, orderBy: { id: "asc" }, take: 5000 }),
    loadOutletRows(propertyId),
    missingRoomIds.length > 0
      ? prisma.room.findMany({ where: { id: { in: missingRoomIds } }, select: { id: true, number: true } })
      : Promise.resolve([] as Array<{ id: string; number: string }>),
    invoiceIds.length > 0
      ? prisma.invoice.findMany({ where: { id: { in: invoiceIds } }, select: { id: true, invoiceNumber: true } })
      : Promise.resolve([] as Array<{ id: string; invoiceNumber: string | null }>)
  ]);
  const linesByOrder = new Map<string, PosLine[]>();
  for (const row of lineRows) {
    const bucket = linesByOrder.get(row.posOrderId);
    if (bucket) bucket.push(mapLine(row));
    else linesByOrder.set(row.posOrderId, [mapLine(row)]);
  }
  const outletById = new Map(outletRows.map((row) => [row.id, row]));
  const roomNumberById = new Map(roomRows.map((row) => [row.id, row.number]));
  const invoiceNumberById = new Map(invoiceRows.map((row) => [row.id, row.invoiceNumber]));

  return visible.map((order) => {
    const outlet = outletById.get(order.outletId);
    // An orphan outlet FK keeps the raw id so the ticket is still visible and attributable.
    const outletId = outlet ? boardOutletId(outlet.outletType) : order.outletId;
    const roomNumber = order.roomNumber ?? (order.roomId ? roomNumberById.get(order.roomId) : undefined) ?? undefined;
    const status = boardStatus(order.status) as PosTicketStatus;
    return {
      id: order.id,
      propertyId: order.propertyId,
      outletId,
      outletName: outlet?.name ?? outletName(outletId),
      status,
      roomNumber,
      lines: linesByOrder.get(order.id) ?? [],
      total: dec(order.total),
      taxTotal: dec(order.taxTotal),
      settlement: isPosSettlement(order.settlement) ? order.settlement : undefined,
      createdAt: order.createdAt.toISOString(),
      closedAt: order.closedAt?.toISOString(),
      closedByUserId: status === "closed" ? order.closedByUserId : undefined,
      businessDate: isoDay(order.businessDate),
      invoiceId: order.invoiceId ?? null,
      invoiceNumber: order.invoiceId ? (invoiceNumberById.get(order.invoiceId) ?? null) : null,
      journalEntryId: order.journalEntryId ?? null,
      cashClosureId: order.cashClosureId ?? null
    };
  });
}

type LoadedTicket = { order: PosOrderRow; ticket: PosTicket; outlet: OutletRow | null };

/** Prisma-first ticket lookup (row + board view + outlet row). */
async function loadTicketRow(ticketId: string): Promise<LoadedTicket | null> {
  const row = await prisma.posOrder.findUnique({ where: { id: ticketId } });
  if (!row) return null;
  const [ticket] = await hydrateTickets(row.propertyId, [row]);
  if (!ticket) return null;
  const outlet = await prisma.outlet.findUnique({ where: { id: row.outletId }, select: { id: true, outletType: true, name: true } });
  return { order: row, ticket, outlet };
}

async function loadTicket(ticketId: string): Promise<PosTicket | null> {
  return (await loadTicketRow(ticketId))?.ticket ?? null;
}

// ── Public API ───────────────────────────────────────────────────────────────
export function listPosOutlets(_propertyId: string): PosOutlet[] {
  return OUTLET_DEFS.map((o) => ({ id: boardOutletId(o.code), name: o.name, category: o.code }));
}

export type PosTicketListStatus = "open" | "closed" | "all";

export type ListPosTicketsOptions = {
  /** open (only pending tickets) · closed (only closed since `closedFrom`) · all (default: both). */
  status?: PosTicketListStatus;
  /** Closed tickets are listed from this instant on; default = start of the property's current business day. */
  closedFrom?: Date;
  /** Cap on closed tickets returned (1..500, default 200). Open tickets are always all returned (cap 500). */
  closedLimit?: number;
};

const MAX_BOARD_TICKETS = 500;
const DEFAULT_CLOSED_LIMIT = 200;

function sortBoard(a: PosTicket, b: PosTicket): number {
  if (a.status !== b.status) return a.status === "open" ? -1 : 1;
  const byCreated = b.createdAt.localeCompare(a.createdAt);
  return byCreated !== 0 ? byCreated : b.id.localeCompare(a.id);
}

/**
 * Board tickets of a property from Prisma: every open ticket plus the tickets
 * closed since `closedFrom` (default: today, property-local), filtered by
 * `status`. Nothing is invented for an empty board.
 */
export async function listPosTickets(propertyId: string, options: ListPosTicketsOptions = {}): Promise<PosTicket[]> {
  const status = options.status ?? "all";
  const closedFrom = options.closedFrom ?? (await startOfBusinessDay(propertyId));
  const closedLimit = Math.min(MAX_BOARD_TICKETS, Math.max(1, Math.floor(options.closedLimit ?? DEFAULT_CLOSED_LIMIT)));
  const [openRows, closedRows] = await Promise.all([
    status === "closed"
      ? Promise.resolve([] as PosOrderRow[])
      : prisma.posOrder.findMany({
          where: { propertyId, status: "open" },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: MAX_BOARD_TICKETS
        }),
    status === "open"
      ? Promise.resolve([] as PosOrderRow[])
      : prisma.posOrder.findMany({
          where: { propertyId, status: "closed", closedAt: { gte: closedFrom } },
          orderBy: [{ closedAt: "desc" }, { id: "desc" }],
          take: closedLimit
        })
  ]);
  const persisted = await hydrateTickets(propertyId, [...openRows, ...closedRows]);
  return persisted.sort(sortBoard);
}

export async function openPosTicket(input: { propertyId: string; outletId: string; roomNumber?: string }): Promise<PosTicket> {
  const outletId = typeof input.outletId === "string" ? input.outletId.trim() : "";
  if (!outletId) throw new BadRequestError("Indica el punto de venta de la comanda.");
  const outletRowId = await resolveOutletRowId(input.propertyId, outletId);
  const roomNumber = input.roomNumber?.trim() || undefined;
  const roomId = await findRoomId(input.propertyId, roomNumber);
  const created = await prisma.posOrder.create({
    data: {
      id: createId("pos"),
      propertyId: input.propertyId,
      outletId: outletRowId,
      roomId,
      roomNumber: roomNumber ?? null,
      status: "open",
      total: 0,
      taxTotal: 0,
      createdAt: new Date(nowIso())
    }
  });
  return (await loadTicket(created.id)) as PosTicket;
}

export async function addPosLine(input: { ticketId: string; name: string; quantity: number; unitPrice: number; productId?: string | null }): Promise<PosTicket> {
  const ticket = await loadTicket(input.ticketId);
  if (!ticket) throw new NotFoundError("Comanda no encontrada.");
  if (ticket.status !== "open") throw ticketAlreadyClosed(ticket.id);
  const qty = Math.max(1, Math.round(input.quantity || 1));
  const unit = round2(input.unitPrice || 0);
  if (!Number.isFinite(unit) || unit < 0) throw new BadRequestError("El precio unitario no es válido.");
  const line: PosLine = { name: (input.name ?? "").trim() || "Consumo", quantity: qty, unitPrice: unit, total: round2(qty * unit) };
  const newTotal = lineTotal([...ticket.lines, line]);

  // Catalogue link: an explicit productId must belong to the property; without
  // one, a configured PosProduct with the same name (case-insensitive) is
  // linked so the sale takes its fiscal class (alcohol → 21 %) and the
  // dashboard's "top products" can attribute it.
  let productId: string | null = null;
  if (input.productId) {
    const product = await prisma.posProduct.findFirst({ where: { id: input.productId, propertyId: ticket.propertyId }, select: { id: true } });
    if (!product) throw new NotFoundError("Artículo del catálogo no encontrado.");
    productId = product.id;
  } else {
    const product = await prisma.posProduct.findFirst({
      where: { propertyId: ticket.propertyId, name: { equals: line.name, mode: "insensitive" } },
      select: { id: true }
    });
    productId = product?.id ?? null;
  }
  await prisma.$transaction(async (tx) => {
    // Re-check under the transaction: a concurrent close must not gain a line.
    const stillOpen = await tx.posOrder.updateMany({ where: { id: ticket.id, status: "open" }, data: { total: newTotal } });
    if (stillOpen.count === 0) throw ticketAlreadyClosed(ticket.id);
    await tx.posOrderLine.create({
      data: {
        posOrderId: ticket.id,
        productId,
        description: line.name,
        quantity: line.quantity,
        unitPrice: line.unitPrice,
        total: line.total
      }
    });
  });
  return (await loadTicket(ticket.id)) as PosTicket;
}

type RoomChargeTarget = { roomId: string; reservationId: string; folioId: string };
type PostedFolioLine = { id: string; folioId: string; type: string; total: number; postedAt: Date; taxCategory: PosTaxCategory; description: string };

/** Fiscal category of a room charge (Tanda 3): food & beverage outlets vs general services (spa, shop…). */
export type PosTaxCategoryLegacy = PosTaxCategory;

// Outlet types whose tickets are restaurant / bar / room-service consumption
// (hostelería: IVA 10 %, IGIC 7 %, IPSI 2 %). Anything else (spa, shop,
// laundry…) is a general service (IVA 21 %, IGIC 7 %, IPSI 4 %).
const FOOD_BEVERAGE_OUTLET_TYPES: ReadonlySet<string> = new Set(["restaurant", "bar", "cafe", "cafeteria", "roomservice", "room_service", "minibar", "breakfast"]);

/** Tax category a ticket takes by default from its outlet type (alcoholic beverages override it per line). Pure. */
export function taxCategoryForOutlet(outletType: string | null | undefined): PosTaxCategory {
  const code = (outletType ?? "").trim().toLowerCase();
  return FOOD_BEVERAGE_OUTLET_TYPES.has(code) ? "food_beverage" : "general_services";
}

/**
 * Transactional core of folio.service `postFolioLine` (open-folio guard + line
 * insert) run on the caller's transaction, so the ticket close and the folio
 * charge commit or roll back together. `postFolioLine` does not accept a
 * transaction client today; once it does, this helper should be replaced by
 * `postFolioLine({ ..., tx })`. The post-commit side effects it performs
 * (routing, audit event, domain event) are replayed by closePosTicket.
 *
 * The line type follows the outlet (restaurant / bar / room_service / minibar
 * / spa…, LINE_TYPE_CATEGORY of the catalogue) and FolioLine.taxCategory the
 * tax group of the lines it carries (food_beverage 10 % / general_services
 * 21 % for alcoholic beverages), which is what invoicing resolves the rate from.
 */
async function postRoomChargeTx(
  tx: Prisma.TransactionClient,
  input: { folioId: string; type: string; description: string; amount: string; postedBy: string; taxCategory: PosTaxCategory }
): Promise<PostedFolioLine> {
  const folio = await tx.folio.findUnique({ where: { id: input.folioId }, select: { id: true, status: true } });
  if (!folio) throw new NotFoundError("El folio no existe.");
  if (folio.status !== "open") throw new ConflictError("El folio está cerrado; no admite más cargos ni movimientos.");
  const total = new Decimal(input.amount).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  const created = await tx.folioLine.create({
    data: {
      folioId: folio.id,
      type: input.type,
      description: input.description,
      quantity: 1,
      unitPrice: total.toFixed(2),
      taxCode: null,
      taxCategory: input.taxCategory,
      total: total.toFixed(2),
      postedBy: input.postedBy
    },
    select: { id: true, folioId: true, total: true, postedAt: true }
  });
  return { id: created.id, folioId: created.folioId, type: input.type, total: dec(created.total), postedAt: created.postedAt, taxCategory: input.taxCategory, description: input.description };
}

/** Rate table of the property for the two POS categories (catalogue / manual override, never UNKNOWN). Same lineType as the invoice lines so both resolve identically. */
export async function resolvePosRates(propertyId: string, outletType: string | null | undefined, postingDate: Date): Promise<PosRateTable> {
  const lineType = folioLineTypeForOutlet(outletType);
  const [fb, gs] = await Promise.all([
    resolveTaxRate({ propertyId, lineType, postingDate, taxCategory: "food_beverage" }),
    resolveTaxRate({ propertyId, lineType, postingDate, taxCategory: "general_services" })
  ]);
  const spec = (r: typeof fb) => ({
    ratePercent: r.ratePercent,
    canonicalTaxCode: r.canonicalTaxCode,
    rateCode: String(Math.round(r.ratePercent * 100) / 100),
    figure: r.figure,
    impuesto: r.impuesto,
    calificacion: r.calificacion
  });
  return { food_beverage: spec(fb), general_services: spec(gs) };
}

/** Lines of a ticket with the catalogue data the taxation needs. */
async function taxableLinesOf(ticket: PosTicket): Promise<PosTaxableLine[]> {
  const productIds = Array.from(new Set(ticket.lines.map((line) => line.productId).filter((id): id is string => Boolean(id))));
  const products = productIds.length
    ? await prisma.posProduct.findMany({ where: { id: { in: productIds } }, select: { id: true, category: true, taxCode: true } })
    : [];
  const byId = new Map(products.map((p) => [p.id, p]));
  return ticket.lines.map((line) => {
    const product = line.productId ? byId.get(line.productId) : undefined;
    return { name: line.name, quantity: line.quantity, unitPrice: line.unitPrice, total: line.total, productId: line.productId ?? null, productCategory: product?.category ?? null, productTaxCode: product?.taxCode ?? null };
  });
}

function groupDescription(outletLabel: string, group: PosTicketTax["groups"][number]): string {
  const items = group.lines.map((l) => `${l.quantity}× ${l.name}`).join(", ");
  const suffix = group.lines.some((l) => l.alcohol) ? " (bebidas alcohólicas)" : "";
  return `${outletLabel}${suffix}: ${items}`;
}

function cashClosureClosedError(businessDateIso: string, outletLabel: string, blocking: { id: string; outletId: string; status: string }): ConflictError {
  const error = new ConflictError(
    `La caja de ${blocking.outletId === "*" ? "recepción" : outletLabel} del ${businessDateIso} ya está cerrada (${blocking.status}): no admite más ventas al contado.`
  );
  error.details = { code: "CASH_CLOSURE_CLOSED", cashClosureId: blocking.id, businessDate: businessDateIso, status: blocking.status };
  return error;
}

// One ticket closes at a time per process: createSimplifiedInvoice is
// idempotent by posOrderId but its existence check runs before its
// transaction, so two closers racing inside one API instance are serialised
// here (across instances the optimistic close below still yields one 409;
// the second invoice that race could leave is the residual risk, documented).
const closingTickets = new Map<string, Promise<unknown>>();
async function withTicketLock<T>(ticketId: string, run: () => Promise<T>): Promise<T> {
  const previous = closingTickets.get(ticketId) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(run);
  closingTickets.set(ticketId, current);
  try {
    return await current;
  } finally {
    if (closingTickets.get(ticketId) === current) closingTickets.delete(ticketId);
  }
}

type CloseOutcome =
  | { kind: "room"; lines: PostedFolioLine[]; target: RoomChargeTarget }
  | { kind: "sale"; invoice: SimplifiedInvoiceResult["invoice"]; journalEntryId: string; idempotent: boolean };

export async function closePosTicket(input: {
  context: UserContext;
  ticketId: string;
  settlement: PosSettlement;
  correlationId: string;
}): Promise<PosTicket> {
  if (!isPosSettlement(input.settlement)) {
    throw new BadRequestError("Forma de cobro no válida: usa room, cash o card.");
  }
  return withTicketLock(input.ticketId, () => closePosTicketLocked(input));
}

async function closePosTicketLocked(input: { context: UserContext; ticketId: string; settlement: PosSettlement; correlationId: string }): Promise<PosTicket> {
  const loaded = await loadTicketRow(input.ticketId);
  if (!loaded) throw new NotFoundError("Comanda no encontrada.");
  const { ticket, order } = loaded;
  if (ticket.status !== "open") throw ticketAlreadyClosed(ticket.id);
  if (ticket.lines.length === 0) throw new BadRequestError("Añade al menos un consumo antes de cerrar.");
  const outletType = loaded.outlet?.outletType ?? outletCode(ticket.outletId);
  const outletLabel = ticket.outletName;

  const property = await prisma.property.findUnique({ where: { id: ticket.propertyId }, select: { organizationId: true } });
  if (!property) throw new NotFoundError("Propiedad no encontrada.");
  const { timeZone } = await resolvePropertyTimeZone(ticket.propertyId);

  let target: RoomChargeTarget | null = null;
  if (input.settlement === "room") {
    requirePermissions(input.context, ["folio.charge.post"]);
    if (!ticket.roomNumber) throw new BadRequestError("Indica la habitación para cargar el consumo.");
    const room = await prisma.room.findFirst({ where: { propertyId: ticket.propertyId, number: ticket.roomNumber }, select: { id: true } });
    if (!room) throw new NotFoundError(`No existe la habitación ${ticket.roomNumber}.`);
    const reservation = await prisma.reservation.findFirst({
      where: { propertyId: ticket.propertyId, assignedRoomId: room.id, status: "checked_in", deletedAt: null },
      select: { id: true }
    });
    if (!reservation) {
      const error = new BadRequestError(`No hay ningún huésped alojado en la habitación ${ticket.roomNumber}.`);
      error.details = { code: "POS_ROOM_NOT_OCCUPIED", roomNumber: ticket.roomNumber };
      throw error;
    }
    // Lazy import (same reason as the invoicing service below): the folio
    // engine pulls the invoicing graph at load time.
    const { getReservationFolio } = await import("../folio/folio.service.js");
    const folio = await getReservationFolio(reservation.id);
    target = { roomId: room.id, reservationId: reservation.id, folioId: folio.folio.id };
  }

  const closedAt = new Date();
  const businessDay = businessDayOf(closedAt, timeZone);
  const rates = await resolvePosRates(ticket.propertyId, outletType, closedAt);
  const tax = computePosTicketTax(await taxableLinesOf(ticket), outletType, rates);

  // Cash / card: the fiscal document first (invoicing lote: F2 + libro de
  // emitidas + asiento D 570|5721 / H 705.x / H 477.tipo, idempotent by
  // posOrderId), then the ticket is closed and linked. Pre-check the cash
  // closure so no invoice is issued for a day whose count is signed.
  let sale: SimplifiedInvoiceResult | null = null;
  if (input.settlement !== "room") {
    const blocking = await findBlockingCashClosureTx(prisma, ticket.propertyId, order.outletId, businessDay.date);
    if (blocking) throw cashClosureClosedError(businessDay.iso, outletLabel, blocking);
    const lineType = folioLineTypeForOutlet(outletType);
    // Lazy import: keeps the POS module (imported by lib/tenancy.ts) free of
    // the invoicing graph at load time; the fiscal document is only needed here.
    const { createSimplifiedInvoice } = await import("../invoicing/simplified-invoice.service.js");
    sale = await createSimplifiedInvoice({
      context: input.context,
      propertyId: ticket.propertyId,
      paidWith: input.settlement === "cash" ? "cash" : "card_terminal",
      posOrderId: ticket.id,
      soldAt: closedAt,
      correlationId: input.correlationId,
      lines: tax.lines.map((line) => ({ description: line.name, quantity: line.quantity, unitPrice: line.unitPrice, lineType, taxCategory: line.taxCategory }))
    });
    // Cuadre: the ticket taxation and the invoice must agree to the cent.
    const invoiceTotal = new Decimal(sale.invoice.total).toFixed(2);
    const invoiceTax = new Decimal(sale.invoice.taxTotal).toFixed(2);
    if (invoiceTotal !== tax.total || invoiceTax !== tax.taxTotal) {
      throw new ConflictError(`La factura simplificada ${sale.invoice.invoiceNumber ?? sale.invoice.id} (${invoiceTotal} / IVA ${invoiceTax}) no cuadra con la comanda (${tax.total} / IVA ${tax.taxTotal}).`, {
        code: "POS_INVOICE_MISMATCH",
        invoiceId: sale.invoice.id,
        ticketId: ticket.id
      });
    }
  }

  // One transaction: the conditional update is the optimistic lock (a
  // concurrent close from another tab or API instance finds no open row and
  // gets a 409 instead of a second charge), and the folio charges ride on the
  // same transaction so neither side can be committed without the other.
  const outcome = await prisma.$transaction(
    async (tx): Promise<CloseOutcome> => {
      if (sale) {
        const blocking = await findBlockingCashClosureTx(tx, ticket.propertyId, order.outletId, businessDay.date);
        if (blocking) throw cashClosureClosedError(businessDay.iso, outletLabel, blocking);
      }
      const closed = await tx.posOrder.updateMany({
        where: { id: ticket.id, status: "open" },
        data: {
          status: "closed",
          total: tax.total,
          taxTotal: tax.taxTotal,
          settlement: input.settlement,
          closedAt,
          closedByUserId: input.context.userId,
          roomNumber: ticket.roomNumber ?? null,
          businessDate: businessDay.date,
          ...(target ? { roomId: target.roomId, reservationId: target.reservationId } : {}),
          ...(sale ? { invoiceId: sale.invoice.id, journalEntryId: sale.journalEntryId || null } : {})
        }
      });
      if (closed.count === 0) throw ticketAlreadyClosed(ticket.id);
      if (sale) return { kind: "sale", invoice: sale.invoice, journalEntryId: sale.journalEntryId, idempotent: sale.idempotent };

      const lines: PostedFolioLine[] = [];
      for (const group of tax.groups) {
        lines.push(
          await postRoomChargeTx(tx, {
            folioId: (target as RoomChargeTarget).folioId,
            type: folioLineTypeForOutlet(outletType),
            description: groupDescription(outletLabel, group),
            amount: group.total,
            postedBy: input.context.userId,
            taxCategory: group.taxCategory
          })
        );
      }
      return { kind: "room", lines, target: target as RoomChargeTarget };
    },
    { maxWait: 10_000, timeout: 30_000 }
  );

  if (outcome.kind === "room") {
    // Same post-commit side effects as folio.service postFolioLine, per line.
    for (const posted of outcome.lines) {
      try {
        const { routeLine } = await import("../folio/folio-routing.service.js");
        await routeLine({ lineId: posted.id, context: input.context, correlationId: input.correlationId });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[pos] corr=${input.correlationId} folio routing failed for line ${posted.id} (ticket ${ticket.id}); charge stays on the primary folio: ${message}`);
        recordAuditEvent({
          organizationId: input.context.organizationId,
          propertyId: ticket.propertyId,
          actorUserId: input.context.userId,
          actorType: "system",
          action: "FOLIO_ROUTING_FAILED",
          entityType: "folio_line",
          entityId: posted.id,
          afterJson: { lineId: posted.id, folioId: posted.folioId, lineType: posted.type, ticketId: ticket.id, error: message },
          correlationId: input.correlationId
        });
      }
      const finalLine = await prisma.folioLine.findUnique({ where: { id: posted.id } });
      const lineJson = {
        id: posted.id,
        folioId: finalLine?.folioId ?? posted.folioId,
        type: posted.type,
        taxCategory: posted.taxCategory,
        description: posted.description,
        quantity: 1,
        unitPrice: posted.total,
        total: posted.total,
        postedAt: (finalLine?.postedAt ?? posted.postedAt).toISOString(),
        postedBy: input.context.userId,
        posOrderId: ticket.id
      };
      recordAuditEvent({
        organizationId: input.context.organizationId,
        propertyId: ticket.propertyId,
        actorUserId: input.context.userId,
        actorType: "user",
        action: "FOLIO_CHARGE_POSTED",
        entityType: "folio_line",
        entityId: posted.id,
        afterJson: lineJson,
        correlationId: input.correlationId
      });
      recordDomainEvent({
        organizationId: input.context.organizationId,
        propertyId: ticket.propertyId,
        entityType: "folio",
        entityId: lineJson.folioId,
        eventType: "ChargePosted",
        payload: { lineId: posted.id, total: posted.total, type: posted.type },
        actorType: "user",
        actorUserId: input.context.userId,
        correlationId: input.correlationId
      });
    }
  }

  recordAuditEvent({
    organizationId: input.context.organizationId,
    propertyId: ticket.propertyId,
    actorUserId: input.context.userId,
    actorType: "user",
    action: "POS_TICKET_CLOSED",
    entityType: "pos_order",
    entityId: ticket.id,
    afterJson: {
      outletId: ticket.outletId,
      settlement: input.settlement,
      total: tax.total,
      taxTotal: tax.taxTotal,
      taxGroups: tax.groups.map((g) => ({ taxCategory: g.taxCategory, ratePercent: g.ratePercent, base: g.base, quota: g.quota, total: g.total })),
      businessDate: businessDay.iso,
      roomNumber: ticket.roomNumber ?? null,
      closedAt: closedAt.toISOString(),
      closedByUserId: input.context.userId,
      folioLineIds: outcome.kind === "room" ? outcome.lines.map((l) => l.id) : [],
      reservationId: outcome.kind === "room" ? outcome.target.reservationId : null,
      invoiceId: outcome.kind === "sale" ? outcome.invoice.id : null,
      invoiceNumber: outcome.kind === "sale" ? outcome.invoice.invoiceNumber ?? null : null,
      journalEntryId: outcome.kind === "sale" ? outcome.journalEntryId || null : null,
      invoiceReused: outcome.kind === "sale" ? outcome.idempotent : false
    },
    correlationId: input.correlationId
  });

  // F&B inventory consumption: try to decrement stock for any ticket lines
  // that match a configured MenuItem (case-insensitive). Best-effort — a
  // failure here must not block the ticket close (POS revenue is the
  // priority, not inventory bookkeeping), but it must leave a trace (QC-06).
  try {
    const { consumeStockForPosTicket } = await import("../fnb-inventory/fnb-inventory.service.js");
    await consumeStockForPosTicket({
      propertyId: ticket.propertyId,
      ticketId: ticket.id,
      outletId: ticket.outletId,
      lines: ticket.lines.map((l) => ({ name: l.name, quantity: l.quantity }))
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[pos] corr=${input.correlationId} stock consumption failed for ticket ${ticket.id} (property ${ticket.propertyId}, outlet ${ticket.outletId}); ticket closed but inventory was not decremented: ${message}`);
    recordAuditEvent({
      organizationId: input.context.organizationId,
      propertyId: ticket.propertyId,
      actorUserId: input.context.userId,
      actorType: "system",
      action: "POS_STOCK_CONSUMPTION_FAILED",
      entityType: "pos_order",
      entityId: ticket.id,
      afterJson: { outletId: ticket.outletId, error: message },
      correlationId: input.correlationId
    });
  }

  return (await loadTicket(ticket.id)) as PosTicket;
}

// ── Tanda 8a · void of a closed ticket (pos.order.void, design §4.6) ─────────

export type PosVoidResult = {
  ticketId: string;
  status: "voided";
  settlement: PosSettlement | null;
  total: number;
  taxTotal: number;
  businessDate: string | null;
  voidedAt: string;
  voidedByUserId: string;
  voidReasonCode: PosVoidReasonCode;
  reasonText: string | null;
  /** Inverse folio lines posted for a room-settled ticket (empty for cash / card). */
  inverseFolioLineIds: string[];
  /** Simplified invoice of a cash / card ticket: it stays intact (VeriFactu); the fiscal correction is the invoice anulación flow. */
  invoiceId: string | null;
  fiscalCorrectionRequired: boolean;
  authorization: { mode: "void_key" | "supervisor"; supervisorAuthorizationId: string | null; authorizerUserId: string | null };
};

/**
 * Void gate, separated for the unit tests: the actor holds `pos.order.void`,
 * or presents a valid single-use supervisor authorisation for that key bound
 * to (pos_order, ticketId); otherwise the standard 403 of the missing key.
 */
export async function assertPosVoidAuthorized(
  input: { context: UserContext; ticketId: string; supervisorAuthorizationId?: string | null },
  deps: RbacDeps = defaultRbacDeps
): Promise<PosVoidResult["authorization"]> {
  if (input.context.permissions.includes("pos.order.void")) return { mode: "void_key", supervisorAuthorizationId: null, authorizerUserId: null };
  if (input.supervisorAuthorizationId) {
    const authorization = await consumeSupervisorAuthorization(
      input.supervisorAuthorizationId,
      { actorUserId: input.context.userId, permissionKey: "pos.order.void", entityType: "pos_order", entityId: input.ticketId },
      deps
    );
    if (authorization) return { mode: "supervisor", supervisorAuthorizationId: authorization.id, authorizerUserId: authorization.authorizerUserId };
  }
  requirePermissions(input.context, ["pos.order.void"]);
  return { mode: "void_key", supervisorAuthorizationId: null, authorizerUserId: null };
}

/**
 * POST /pos/tickets/:id/void — voids a CLOSED ticket of the property's
 * CURRENT business date with a reason code (POS_VOID_REASON_CODES). Nothing
 * is deleted: the PosOrder keeps its lines and gets status `voided` +
 * voidedAt / voidedByUserId / voidReasonCode (optimistic lock on `closed`).
 *   · room settlement → one INVERSE folio line per tax group on the same
 *     (open) folio, so the guest's balance is restored; a closed folio → 409
 *     POS_VOID_FOLIO_CLOSED (the charge was invoiced: use the anulación);
 *   · cash / card → the simplified invoice, its VeriFactu record and its
 *     journal entry stay untouched; the void records the ticket and points
 *     to the invoice (`fiscalCorrectionRequired`), whose anulación is the
 *     invoice flow with its own separation of duties;
 *   · a signed cash closure of the outlet / day refuses the void (409
 *     CASH_CLOSURE_CLOSED) like a sale would be refused.
 * Audit POS_TICKET_VOIDED with settlement, totals, reason and authoriser.
 */
export async function voidPosTicket(input: {
  context: UserContext;
  ticketId: string;
  reasonCode: string;
  reasonText?: string;
  supervisorAuthorizationId?: string | null;
  correlationId: string;
  rbac?: RbacDeps;
}): Promise<PosVoidResult> {
  if (!(input.reasonCode in POS_VOID_REASON_CODES)) {
    throw new BadRequestError(`reasonCode no válido: usa uno de ${Object.keys(POS_VOID_REASON_CODES).join(", ")}.`);
  }
  const reasonCode = input.reasonCode as PosVoidReasonCode;
  return withTicketLock(input.ticketId, async () => {
    const row = await prisma.posOrder.findUnique({ where: { id: input.ticketId } });
    if (!row) throw new NotFoundError("Comanda no encontrada.");
    if (row.status === "voided") throw new ConflictError("La comanda ya está anulada.", { code: "POS_TICKET_ALREADY_VOIDED", ticketId: row.id, voidedAt: row.voidedAt?.toISOString() ?? null });
    if (row.status !== "closed") throw new ConflictError("Solo se anula una comanda cerrada.", { code: "POS_TICKET_NOT_CLOSED", ticketId: row.id, status: row.status });
    const property = await prisma.property.findUnique({ where: { id: row.propertyId }, select: { organizationId: true } });
    if (!property) throw new NotFoundError("Propiedad no encontrada.");
    const { timeZone } = await resolvePropertyTimeZone(row.propertyId);
    const today = businessDayOf(new Date(), timeZone);
    const ticketDay = row.businessDate ? row.businessDate.toISOString().slice(0, 10) : row.closedAt ? businessDayOf(row.closedAt, timeZone).iso : null;
    if (ticketDay !== today.iso) {
      throw new ConflictError(`Solo se anulan comandas de la fecha de negocio vigente (${today.iso}); esta es del ${ticketDay ?? "día desconocido"}.`, { code: "POS_VOID_OUT_OF_BUSINESS_DAY", ticketId: row.id, businessDate: ticketDay, currentBusinessDate: today.iso });
    }
    const authorization = await assertPosVoidAuthorized({ context: input.context, ticketId: row.id, supervisorAuthorizationId: input.supervisorAuthorizationId ?? null }, input.rbac ?? defaultRbacDeps);

    const [ticket] = await hydrateTickets(row.propertyId, [row]);
    const outlet = await prisma.outlet.findUnique({ where: { id: row.outletId }, select: { id: true, outletType: true, name: true } });
    const outletType = outlet?.outletType ?? (ticket ? outletCode(ticket.outletId) : null);
    const outletLabel = ticket?.outletName ?? outlet?.name ?? "TPV";
    const settlement = isPosSettlement(row.settlement) ? row.settlement : null;
    const blocking = await findBlockingCashClosureTx(prisma, row.propertyId, row.outletId, today.date);
    if (blocking) throw cashClosureClosedError(today.iso, outletLabel, blocking);

    const voidedAt = new Date();
    const inverseFolioLineIds: string[] = [];
    await prisma.$transaction(
      async (tx) => {
        const flipped = await tx.posOrder.updateMany({
          where: { id: row.id, status: "closed" },
          data: { status: "voided", voidedAt, voidedByUserId: input.context.userId, voidReasonCode: reasonCode }
        });
        if (flipped.count === 0) throw new ConflictError("La comanda ya está anulada.", { code: "POS_TICKET_ALREADY_VOIDED", ticketId: row.id });
        if (settlement === "room" && ticket) {
          if (!row.reservationId) throw new ConflictError("La comanda cargada a habitación no conserva su reserva; anúlala desde el folio.", { code: "POS_VOID_FOLIO_UNKNOWN", ticketId: row.id });
          const { getReservationFolio } = await import("../folio/folio.service.js");
          const folio = await getReservationFolio(row.reservationId);
          const target = await tx.folio.findUnique({ where: { id: folio.folio.id }, select: { id: true, status: true } });
          if (!target || target.status !== "open") {
            throw new ConflictError("El folio del cargo ya está cerrado o facturado: anula la factura en vez de la comanda.", { code: "POS_VOID_FOLIO_CLOSED", ticketId: row.id, folioId: folio.folio.id });
          }
          const rates = await resolvePosRates(row.propertyId, outletType, row.closedAt ?? voidedAt);
          const tax = computePosTicketTax(await taxableLinesOf(ticket), outletType, rates);
          for (const group of tax.groups) {
            const posted = await postRoomChargeTx(tx, {
              folioId: target.id,
              type: folioLineTypeForOutlet(outletType),
              description: `Anulación comanda ${row.id} · ${groupDescription(outletLabel, group)}`,
              amount: new Decimal(group.total).negated().toFixed(2),
              postedBy: input.context.userId,
              taxCategory: group.taxCategory
            });
            inverseFolioLineIds.push(posted.id);
          }
        }
      },
      { maxWait: 10_000, timeout: 30_000 }
    );

    const result: PosVoidResult = {
      ticketId: row.id,
      status: "voided",
      settlement,
      total: dec(row.total),
      taxTotal: dec(row.taxTotal),
      businessDate: ticketDay,
      voidedAt: voidedAt.toISOString(),
      voidedByUserId: input.context.userId,
      voidReasonCode: reasonCode,
      reasonText: input.reasonText ?? null,
      inverseFolioLineIds,
      invoiceId: row.invoiceId ?? null,
      fiscalCorrectionRequired: settlement !== "room" && Boolean(row.invoiceId),
      authorization
    };
    recordAuditEvent({
      organizationId: property.organizationId,
      propertyId: row.propertyId,
      actorUserId: input.context.userId,
      actorType: "user",
      action: "POS_TICKET_VOIDED",
      entityType: "pos_order",
      entityId: row.id,
      beforeJson: { status: row.status, settlement, total: dec(row.total), closedByUserId: row.closedByUserId ?? null, invoiceId: row.invoiceId ?? null },
      afterJson: { ...result, outletId: row.outletId, roomNumber: row.roomNumber ?? null, reservationId: row.reservationId ?? null },
      deviceId: input.context.deviceId,
      correlationId: input.correlationId
    });
    recordDomainEvent({
      organizationId: property.organizationId,
      propertyId: row.propertyId,
      entityType: "pos_order",
      entityId: row.id,
      eventType: "PosTicketVoided",
      payload: { settlement, total: result.total, reasonCode, inverseFolioLineIds, invoiceId: result.invoiceId },
      actorType: "user",
      actorUserId: input.context.userId,
      correlationId: input.correlationId
    });
    return result;
  });
}

// Cash summary and cash closures live in pos-cash-closure.service.ts (they
// depend on the outlet and time-zone helpers above). Re-exported here because
// server.ts imports the whole POS surface from this module; the cycle is safe
// — neither module reads the other's bindings while evaluating.
export { getPosCashSummary, getCashSummary } from "./pos-cash-closure.service.js";
export type { PosCashSummary, PosCashSummaryInput, PosCashSummaryQuery } from "./pos-cash-closure.service.js";
