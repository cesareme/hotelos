// Point-of-sale (TPV) — outlets + tickets with charge-to-room.
//
// Tanda 2 · FISC-05 / FISC-10: tickets are Prisma-first. A ticket IS a PosOrder
// row (+ PosOrderLine rows, same id): the board, the tenancy resolver and the
// cash summary (pos-cash-closure.service.ts) all read `pos_orders`, so POS
// sales survive restarts and are shared by every API instance on the same
// database. Closing a ticket persists settlement / closedAt / closedByUserId on
// the row in the SAME transaction as the folio charge when it is settled to the
// room, so a cash count can never see a closed ticket without its charge (or
// the reverse).
//
// The only in-memory state left is the synthetic demo board: five invented
// tickets seeded for the two demo properties (prop_123 / prop_456) so a fresh
// demo is never empty. They are flagged `synthetic: true`, are NEVER served for
// a real property (FISC-10) and are materialised into Prisma the first time
// they are written to (line added / closed) — from then on Prisma is the
// source and the mirror copy is ignored.
import { prisma } from "@hotelos/database";
import type { Prisma } from "@hotelos/database";
import { getReservationFolio } from "../folio/folio.service.js";
import { recordAuditEvent, recordDomainEvent } from "../audit/audit.service.js";
import { requirePermissions } from "../auth/auth.service.js";
import { createId, nowIso } from "../../lib/ids.js";
import { BadRequestError, ConflictError, NotFoundError } from "../../lib/http-error.js";
import type { UserContext } from "../../lib/demo-store.js";

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
export type PosLine = { name: string; quantity: number; unitPrice: number; total: number };
export type PosTicket = {
  id: string;
  propertyId: string;
  /** Board outlet id (`out_<outletType>`), shared across properties — see resolveOutletRowId. */
  outletId: string;
  outletName: string;
  status: "open" | "closed";
  roomNumber?: string;
  lines: PosLine[];
  total: number;
  settlement?: PosSettlement;
  createdAt: string;
  closedAt?: string;
  /** User who closed the ticket; null on rows closed before this column existed. */
  closedByUserId?: string | null;
  /** Invented demo ticket (seeded board of prop_123 / prop_456). Never real revenue. */
  synthetic?: boolean;
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

// ── Synthetic demo board (FISC-10) ───────────────────────────────────────────
// Demo tickets exist ONLY for the two synthetic demo properties. A real
// property whose board is empty stays empty: an invented ticket on a real
// hotel's board would be invented revenue in its cash count.
const SYNTHETIC_DEMO_PROPERTY_IDS: ReadonlySet<string> = new Set(["prop_123", "prop_456"]);

export function isSyntheticDemoProperty(propertyId: string): boolean {
  return SYNTHETIC_DEMO_PROPERTY_IDS.has(propertyId);
}

const syntheticTickets: PosTicket[] = [];
const syntheticTicketIds = new Set<string>();
const seededProperties = new Set<string>();

function seedSyntheticTickets(propertyId: string): void {
  if (!isSyntheticDemoProperty(propertyId) || seededProperties.has(propertyId)) return;
  seededProperties.add(propertyId);
  const mk = (
    code: string,
    roomNumber: string | undefined,
    lines: PosLine[],
    status: "open" | "closed",
    settlement?: PosSettlement,
    minsAgo = 30
  ): PosTicket => {
    const created = new Date(Date.now() - minsAgo * 60_000).toISOString();
    const outletId = boardOutletId(code);
    return {
      id: createId("pos"),
      propertyId,
      outletId,
      outletName: outletName(outletId),
      status,
      roomNumber,
      lines,
      total: round2(lines.reduce((s, l) => s + l.total, 0)),
      settlement,
      createdAt: created,
      closedAt: status === "closed" ? new Date(Date.now() - (minsAgo - 5) * 60_000).toISOString() : undefined,
      closedByUserId: null,
      synthetic: true
    };
  };
  const line = (name: string, quantity: number, unitPrice: number): PosLine => ({ name, quantity, unitPrice, total: round2(quantity * unitPrice) });
  const seeded = [
    mk("restaurant", "204", [line("Menú del día", 2, 18.5), line("Copa de vino", 2, 4.5)], "open", undefined, 25),
    mk("bar", undefined, [line("Caña", 3, 3), line("Ración de jamón", 1, 14)], "open", undefined, 12),
    mk("roomservice", "312", [line("Club sándwich", 1, 16), line("Agua mineral", 2, 3)], "open", undefined, 8),
    mk("cafe", undefined, [line("Café con leche", 2, 2.4), line("Tarta de queso", 1, 5.5)], "closed", "card", 95),
    mk("restaurant", "118", [line("Cena carta", 2, 41)], "closed", "room", 140)
  ];
  for (const ticket of seeded) {
    syntheticTickets.push(ticket);
    syntheticTicketIds.add(ticket.id);
  }
}

/** Synthetic (in-memory) ticket by id — used by the tenancy resolver as a fallback after Prisma. */
export function findSyntheticPosTicket(ticketId: string): PosTicket | undefined {
  return syntheticTickets.find((ticket) => ticket.id === ticketId);
}

function syntheticTicketsFor(propertyId: string): PosTicket[] {
  seedSyntheticTickets(propertyId);
  return syntheticTickets.filter((ticket) => ticket.propertyId === propertyId);
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

function zonedParts(instant: Date, timeZone: string): { year: number; month: number; day: number; hour: number; minute: number; second: number } {
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
async function resolveOutletRowId(propertyId: string, posOutletId: string): Promise<string> {
  const code = outletCode(posOutletId);
  const cacheKey = `${propertyId}:${code}`;
  const cached = outletRowIdCache.get(cacheKey);
  if (cached) return cached;
  const existing = await prisma.outlet.findFirst({ where: { propertyId, outletType: code }, orderBy: { id: "asc" } });
  // Only the board catalogue (OUTLET_DEFS) or an outlet the property already
  // has can back a ticket: an arbitrary slug used to create a persistent
  // Outlet row named after the typo.
  if (!existing && !OUTLET_DEFS.some((o) => o.code === code)) {
    throw new NotFoundError("Punto de venta no encontrado.");
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
function boardStatus(status: string): "open" | "closed" | null {
  return status === "open" ? "open" : status === "closed" ? "closed" : null;
}

function mapLine(row: PosOrderLineRow): PosLine {
  return { name: row.description, quantity: dec(row.quantity), unitPrice: dec(row.unitPrice), total: dec(row.total) };
}

/**
 * Hydrates PosOrder rows of ONE property into board tickets with three batched
 * queries (lines, outlets, rooms) — never per row. Rows written before the
 * `room_number` column existed fall back to the linked Room's number.
 */
async function hydrateTickets(propertyId: string, orders: PosOrderRow[]): Promise<PosTicket[]> {
  const visible = orders.filter((order) => order.propertyId === propertyId && boardStatus(order.status) !== null);
  if (visible.length === 0) return [];
  const ids = visible.map((order) => order.id);
  const missingRoomIds = Array.from(
    new Set(visible.filter((order) => !order.roomNumber && order.roomId).map((order) => order.roomId as string))
  );
  const [lineRows, outletRows, roomRows] = await Promise.all([
    prisma.posOrderLine.findMany({ where: { posOrderId: { in: ids } }, orderBy: { id: "asc" }, take: 5000 }),
    loadOutletRows(propertyId),
    missingRoomIds.length > 0
      ? prisma.room.findMany({ where: { id: { in: missingRoomIds } }, select: { id: true, number: true } })
      : Promise.resolve([] as Array<{ id: string; number: string }>)
  ]);
  const linesByOrder = new Map<string, PosLine[]>();
  for (const row of lineRows) {
    const bucket = linesByOrder.get(row.posOrderId);
    if (bucket) bucket.push(mapLine(row));
    else linesByOrder.set(row.posOrderId, [mapLine(row)]);
  }
  const outletById = new Map(outletRows.map((row) => [row.id, row]));
  const roomNumberById = new Map(roomRows.map((row) => [row.id, row.number]));

  return visible.map((order) => {
    const outlet = outletById.get(order.outletId);
    // An orphan outlet FK keeps the raw id so the ticket is still visible and attributable.
    const outletId = outlet ? boardOutletId(outlet.outletType) : order.outletId;
    const roomNumber = order.roomNumber ?? (order.roomId ? roomNumberById.get(order.roomId) : undefined) ?? undefined;
    const status = boardStatus(order.status) as "open" | "closed";
    return {
      id: order.id,
      propertyId: order.propertyId,
      outletId,
      outletName: outlet?.name ?? outletName(outletId),
      status,
      roomNumber,
      lines: linesByOrder.get(order.id) ?? [],
      total: dec(order.total),
      settlement: isPosSettlement(order.settlement) ? order.settlement : undefined,
      createdAt: order.createdAt.toISOString(),
      closedAt: order.closedAt?.toISOString(),
      closedByUserId: status === "closed" ? order.closedByUserId : undefined,
      ...(syntheticTicketIds.has(order.id) ? { synthetic: true } : {})
    };
  });
}

/** Prisma-first ticket lookup; synthetic demo tickets not yet materialised are the fallback. */
async function loadTicket(ticketId: string): Promise<PosTicket | null> {
  const row = await prisma.posOrder.findUnique({ where: { id: ticketId } });
  if (row) {
    const [ticket] = await hydrateTickets(row.propertyId, [row]);
    return ticket ?? null;
  }
  return findSyntheticPosTicket(ticketId) ?? null;
}

/**
 * Guarantees the PosOrder row behind a ticket exists (same id). New tickets
 * are persisted at open; synthetic demo tickets are materialised here (order +
 * their current lines + settlement snapshot) the first time they are written to.
 */
async function ensurePosOrderRow(ticket: PosTicket): Promise<void> {
  const existing = await prisma.posOrder.findUnique({ where: { id: ticket.id }, select: { id: true } });
  if (existing) return;
  const outletRowId = await resolveOutletRowId(ticket.propertyId, ticket.outletId);
  const roomId = await findRoomId(ticket.propertyId, ticket.roomNumber);
  await prisma.$transaction(async (tx) => {
    await tx.posOrder.create({
      data: {
        id: ticket.id,
        propertyId: ticket.propertyId,
        outletId: outletRowId,
        roomId,
        roomNumber: ticket.roomNumber ?? null,
        status: ticket.status,
        total: ticket.total,
        settlement: ticket.settlement ?? null,
        closedAt: ticket.closedAt ? new Date(ticket.closedAt) : null,
        closedByUserId: ticket.closedByUserId ?? null,
        createdAt: new Date(ticket.createdAt)
      }
    });
    if (ticket.lines.length > 0) {
      await tx.posOrderLine.createMany({
        data: ticket.lines.map((line) => ({
          posOrderId: ticket.id,
          description: line.name,
          quantity: line.quantity,
          unitPrice: line.unitPrice,
          total: line.total
        }))
      });
    }
  });
}

// ── Public API ───────────────────────────────────────────────────────────────
export function listPosOutlets(_propertyId: string): PosOutlet[] {
  return OUTLET_DEFS.map((o) => ({ id: boardOutletId(o.code), name: o.name, category: o.code }));
}

export type ListPosTicketsOptions = {
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
 * closed since `closedFrom` (default: today, property-local). Synthetic demo
 * tickets are appended ONLY for prop_123 / prop_456 and only while they are
 * not materialised (a persisted copy always wins).
 */
export async function listPosTickets(propertyId: string, options: ListPosTicketsOptions = {}): Promise<PosTicket[]> {
  const closedFrom = options.closedFrom ?? (await startOfBusinessDay(propertyId));
  const closedLimit = Math.min(MAX_BOARD_TICKETS, Math.max(1, Math.floor(options.closedLimit ?? DEFAULT_CLOSED_LIMIT)));
  const [openRows, closedRows] = await Promise.all([
    prisma.posOrder.findMany({
      where: { propertyId, status: "open" },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: MAX_BOARD_TICKETS
    }),
    prisma.posOrder.findMany({
      where: { propertyId, status: "closed", closedAt: { gte: closedFrom } },
      orderBy: [{ closedAt: "desc" }, { id: "desc" }],
      take: closedLimit
    })
  ]);
  const persisted = await hydrateTickets(propertyId, [...openRows, ...closedRows]);
  const persistedIds = new Set(persisted.map((ticket) => ticket.id));
  const synthetic = syntheticTicketsFor(propertyId).filter((ticket) => !persistedIds.has(ticket.id));
  return [...persisted, ...synthetic].sort(sortBoard);
}

export async function openPosTicket(input: { propertyId: string; outletId: string; roomNumber?: string }): Promise<PosTicket> {
  const outletId = typeof input.outletId === "string" ? input.outletId.trim() : "";
  if (!outletId) throw new BadRequestError("Indica el punto de venta de la comanda.");
  const ticket: PosTicket = {
    id: createId("pos"),
    propertyId: input.propertyId,
    outletId,
    outletName: outletName(outletId),
    status: "open",
    roomNumber: input.roomNumber?.trim() || undefined,
    lines: [],
    total: 0,
    createdAt: nowIso()
  };
  await ensurePosOrderRow(ticket);
  return (await loadTicket(ticket.id)) ?? ticket;
}

export async function addPosLine(input: { ticketId: string; name: string; quantity: number; unitPrice: number }): Promise<PosTicket> {
  const ticket = await loadTicket(input.ticketId);
  if (!ticket) throw new NotFoundError("Comanda no encontrada.");
  if (ticket.status !== "open") throw ticketAlreadyClosed(ticket.id);
  const qty = Math.max(1, Math.round(input.quantity || 1));
  const unit = round2(input.unitPrice || 0);
  if (!Number.isFinite(unit) || unit < 0) throw new BadRequestError("El precio unitario no es válido.");
  const line: PosLine = { name: (input.name ?? "").trim() || "Consumo", quantity: qty, unitPrice: unit, total: round2(qty * unit) };
  const newTotal = lineTotal([...ticket.lines, line]);

  await ensurePosOrderRow(ticket);
  // Best-effort product link so the dashboard's "top products" can attribute
  // the sale when a configured PosProduct matches the free-text line name.
  const product = await prisma.posProduct.findFirst({
    where: { propertyId: ticket.propertyId, name: { equals: line.name, mode: "insensitive" } },
    select: { id: true }
  });
  await prisma.$transaction(async (tx) => {
    // Re-check under the transaction: a concurrent close must not gain a line.
    const stillOpen = await tx.posOrder.updateMany({ where: { id: ticket.id, status: "open" }, data: { total: newTotal } });
    if (stillOpen.count === 0) throw ticketAlreadyClosed(ticket.id);
    await tx.posOrderLine.create({
      data: {
        posOrderId: ticket.id,
        productId: product?.id ?? null,
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
type PostedFolioLine = { id: string; folioId: string; total: number; postedAt: Date };

/**
 * Transactional core of folio.service `postFolioLine` (open-folio guard + line
 * insert) run on the caller's transaction, so the ticket close and the folio
 * charge commit or roll back together. `postFolioLine` does not accept a
 * transaction client today; once it does, this helper should be replaced by
 * `postFolioLine({ ..., tx })`. The post-commit side effects it performs
 * (routing, audit event, domain event) are replayed by closePosTicket.
 */
async function postRoomChargeTx(
  tx: Prisma.TransactionClient,
  input: { folioId: string; description: string; amount: number; postedBy: string }
): Promise<PostedFolioLine> {
  const folio = await tx.folio.findUnique({ where: { id: input.folioId }, select: { id: true, status: true } });
  if (!folio) throw new NotFoundError("El folio no existe.");
  if (folio.status !== "open") throw new ConflictError("El folio está cerrado; no admite más cargos ni movimientos.");
  const total = round2(input.amount);
  const created = await tx.folioLine.create({
    data: {
      folioId: folio.id,
      type: "minibar",
      description: input.description,
      quantity: 1,
      unitPrice: total,
      taxCode: null,
      total,
      postedBy: input.postedBy
    },
    select: { id: true, folioId: true, total: true, postedAt: true }
  });
  return { id: created.id, folioId: created.folioId, total: dec(created.total), postedAt: created.postedAt };
}

export async function closePosTicket(input: {
  context: UserContext;
  ticketId: string;
  settlement: PosSettlement;
  correlationId: string;
}): Promise<PosTicket> {
  if (!isPosSettlement(input.settlement)) {
    throw new BadRequestError("Forma de cobro no válida: usa room, cash o card.");
  }
  const ticket = await loadTicket(input.ticketId);
  if (!ticket) throw new NotFoundError("Comanda no encontrada.");
  if (ticket.status !== "open") throw ticketAlreadyClosed(ticket.id);
  if (ticket.lines.length === 0) throw new BadRequestError("Añade al menos un consumo antes de cerrar.");

  let target: RoomChargeTarget | null = null;
  if (input.settlement === "room") {
    requirePermissions(input.context, ["folio.charge.post"]);
    if (!ticket.roomNumber) throw new BadRequestError("Indica la habitación para cargar el consumo.");
    const room = await prisma.room.findFirst({ where: { propertyId: ticket.propertyId, number: ticket.roomNumber }, select: { id: true } });
    if (!room) throw new NotFoundError(`No existe la habitación ${ticket.roomNumber}.`);
    const reservation = await prisma.reservation.findFirst({
      where: { propertyId: ticket.propertyId, assignedRoomId: room.id, status: "checked_in" },
      select: { id: true }
    });
    if (!reservation) throw new BadRequestError(`No hay ningún huésped alojado en la habitación ${ticket.roomNumber}.`);
    const folio = await getReservationFolio(reservation.id);
    target = { roomId: room.id, reservationId: reservation.id, folioId: folio.folio.id };
  }

  await ensurePosOrderRow(ticket);
  const closedAt = new Date();
  const description = `${ticket.outletName}: ${ticket.lines.map((l) => `${l.quantity}× ${l.name}`).join(", ")}`;

  // One transaction: the conditional update is the optimistic lock (a
  // concurrent close from another tab or API instance finds no open row and
  // gets a 409 instead of a second charge), and the folio charge rides on the
  // same transaction so neither side can be committed without the other.
  const posted = await prisma.$transaction(async (tx) => {
    const closed = await tx.posOrder.updateMany({
      where: { id: ticket.id, status: "open" },
      data: {
        status: "closed",
        total: ticket.total,
        settlement: input.settlement,
        closedAt,
        closedByUserId: input.context.userId,
        roomNumber: ticket.roomNumber ?? null,
        ...(target ? { roomId: target.roomId, reservationId: target.reservationId } : {})
      }
    });
    if (closed.count === 0) throw ticketAlreadyClosed(ticket.id);
    if (!target) return null;
    return postRoomChargeTx(tx, { folioId: target.folioId, description, amount: ticket.total, postedBy: input.context.userId });
  });

  if (posted && target) {
    // Same post-commit side effects as folio.service postFolioLine.
    try {
      const { routeLine } = await import("../folio/folio-routing.service.js");
      await routeLine({ lineId: posted.id, context: input.context, correlationId: input.correlationId });
    } catch (error) {
      console.warn(`[pos] Folio routing failed for line ${posted.id} (ticket ${ticket.id}); charge stays on the primary folio.`, error);
    }
    const finalLine = await prisma.folioLine.findUnique({ where: { id: posted.id } });
    const lineJson = {
      id: posted.id,
      folioId: finalLine?.folioId ?? posted.folioId,
      type: "minibar",
      description,
      quantity: 1,
      unitPrice: posted.total,
      total: posted.total,
      postedAt: (finalLine?.postedAt ?? posted.postedAt).toISOString(),
      postedBy: input.context.userId
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
      payload: { lineId: posted.id, total: posted.total, type: "minibar" },
      actorType: "user",
      actorUserId: input.context.userId,
      correlationId: input.correlationId
    });
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
      total: ticket.total,
      roomNumber: ticket.roomNumber ?? null,
      closedAt: closedAt.toISOString(),
      closedByUserId: input.context.userId,
      folioLineId: posted?.id ?? null,
      reservationId: target?.reservationId ?? null
    },
    correlationId: input.correlationId
  });

  // F&B inventory consumption: try to decrement stock for any ticket lines
  // that match a configured MenuItem (case-insensitive). Best-effort — a
  // failure here must not block the ticket close (POS revenue is the
  // priority, not inventory bookkeeping), but it must leave a trace.
  try {
    const { consumeStockForPosTicket } = await import("../fnb-inventory/fnb-inventory.service.js");
    await consumeStockForPosTicket({
      propertyId: ticket.propertyId,
      ticketId: ticket.id,
      outletId: ticket.outletId,
      lines: ticket.lines.map((l) => ({ name: l.name, quantity: l.quantity }))
    });
  } catch (error) {
    console.warn(
      `[pos] Stock consumption failed for ticket ${ticket.id} (property ${ticket.propertyId}, outlet ${ticket.outletId}); ticket closed but inventory was not decremented.`,
      error
    );
  }

  return (await loadTicket(ticket.id)) as PosTicket;
}

// Cash summary lives in pos-cash-closure.service.ts (it depends on the outlet
// and time-zone helpers above). Re-exported here because server.ts imports the
// whole POS surface from this module; the cycle is safe — neither module reads
// the other's bindings while evaluating.
export { getPosCashSummary, getCashSummary } from "./pos-cash-closure.service.js";
export type { PosCashSummary, PosCashSummaryInput, PosCashSummaryQuery } from "./pos-cash-closure.service.js";
