import type { GuestIdentityFields } from "@hotelos/shared";
import type { ReservationStatus } from "@hotelos/shared";
import { prisma } from "@hotelos/database";
// Value import (not the type-only re-export of @hotelos/database): `Prisma.DbNull`
// is required to clear nullable Json columns. Same generated client as the
// database package — a single @prisma/client copy in the pnpm store.
import { Prisma } from "@prisma/client";
import { BadRequestError, ConflictError, NotFoundError } from "../../lib/http-error.js";
import { buildPage, decodeCursor, DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT, type Page } from "../../lib/pagination.js";
import {
  demoStore,
  type GuestRecord,
  type ReservationRecord,
  type RoomRecord,
  type RoomTypeRecord,
  type UserContext
} from "../../lib/demo-store.js";
import type { UpdateReservationInput } from "../../schemas/reservations.schemas.js";
import { recordAuditEvent, recordDomainEvent } from "../audit/audit.service.js";
import { requirePermissions } from "../auth/auth.service.js";
// No import cycle: compliance.service (and its closure) never imports pms.service.
import { queueSesBajaForReservation } from "../compliance/compliance.service.js";
import { getReservationBalance, getFolioBalance } from "../folio/folio.service.js";
import { createSystemHousekeepingTask } from "../housekeeping/housekeeping.service.js";
import { getCurrentBusinessDate } from "../night-audit/night-audit.service.js";
import { canAssignRoom, type RoomAssignmentInput, type RoomAssignmentValidation } from "./inventory.engine.js";

type ReservationRow = NonNullable<Awaited<ReturnType<typeof prisma.reservation.findUnique>>>;
type RoomRow = NonNullable<Awaited<ReturnType<typeof prisma.room.findUnique>>>;

/**
 * Serialise every assignment that targets one room (REC-03 / REC-01b races):
 * `SELECT … FOR UPDATE` on the room row blocks a concurrent transaction on the
 * same room until this one commits, so a `canAssignRoom({ db: tx })` run right
 * after the lock sees the other side's committed assignment and reports the
 * overlap instead of both callers getting a 200. Parameterised by Prisma
 * (tagged template); `rooms` is the mapped table of `model Room`.
 */
async function lockRoomRow(tx: Prisma.TransactionClient, roomId: string): Promise<void> {
  await tx.$queryRaw`SELECT id FROM rooms WHERE id = ${roomId} FOR UPDATE`;
}

/** Lock the room row, then re-run canAssignRoom inside the transaction (see lockRoomRow). */
async function validateRoomUnderLock(
  tx: Prisma.TransactionClient,
  input: Omit<RoomAssignmentInput, "db"> & { roomId: string }
): Promise<RoomAssignmentValidation> {
  await lockRoomRow(tx, input.roomId);
  return canAssignRoom({ ...input, db: tx });
}

const RESERVATION_STATUSES: readonly ReservationStatus[] = ["draft", "confirmed", "checked_in", "checked_out", "cancelled", "no_show"];
// Lifecycle states in which a reservation no longer accepts edits or a room.
const CLOSED_RESERVATION_STATUSES: readonly ReservationStatus[] = ["checked_out", "cancelled", "no_show"];
// REC-03: conditional writes (updateMany with the state we read in the WHERE)
// return count 0 when a concurrent request changed the row first.
const RESERVATION_CHANGED_MEANWHILE = "La reserva ha cambiado de habitación mientras se procesaba; recarga y vuelve a intentarlo.";
const ROOM_JUST_OCCUPIED = "La habitación acaba de ser ocupada.";

// Transitional dual-write helpers. Prisma is source of truth; demoStore is
// mirrored so legacy services (reporting, maintenance, housekeeping, compliance,
// backoffice) keep working until they migrate to Prisma in subsequent weeks.
function mirrorReservation(reservation: ReservationRecord): void {
  const idx = demoStore.reservations.findIndex((r) => r.id === reservation.id);
  if (idx >= 0) demoStore.reservations[idx] = reservation;
  else demoStore.reservations.push(reservation);
}

function mirrorRoom(room: RoomRecord): void {
  const idx = demoStore.rooms.findIndex((r) => r.id === room.id);
  if (idx >= 0) demoStore.rooms[idx] = room;
  else demoStore.rooms.push(room);
}

function mirrorGuest(guest: GuestRecord): void {
  const idx = demoStore.guests.findIndex((g) => g.id === guest.id);
  if (idx >= 0) demoStore.guests[idx] = guest;
  else demoStore.guests.push(guest);
}

function mirrorFolioStub(folio: { id: string; reservationId: string; guestId?: string; status: "open" | "closed"; currency: string }): void {
  const idx = demoStore.folios.findIndex((f) => f.id === folio.id);
  if (idx >= 0) demoStore.folios[idx] = folio;
  else demoStore.folios.push(folio);
}

function dec(value: Prisma.Decimal | number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  return typeof value === "number" ? value : Number(value);
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function dateOnly(iso: string): Date {
  return new Date(`${iso}T00:00:00.000Z`);
}

function isIsoDateString(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(dateOnly(value).getTime());
}

/** Whole days from `fromIso` to `toIso` (YYYY-MM-DD); positive when `toIso` is later. */
function daysBetween(fromIso: string, toIso: string): number {
  return Math.round((dateOnly(toIso).getTime() - dateOnly(fromIso).getTime()) / 86_400_000);
}

/** `YYYY-MM-DD` of "today" in an IANA timezone (UTC when invalid). Mirrors night-audit.service. */
function todayInTimezone(timezone: string): string {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  } catch {
    return isoDate(new Date());
  }
}

/**
 * Attach machine-readable `details` to a typed HTTP error so clients can branch
 * on `details.code` (BALANCE_DUE, CHECK_IN_DATE_OUT_OF_RANGE, …) instead of
 * parsing the Spanish message. The global error handler serializes it when
 * present.
 */
function withDetails<E extends Error>(error: E, details: Record<string, unknown>): E & { details: Record<string, unknown> } {
  return Object.assign(error, { details });
}

function formatEur(amount: number): string {
  return amount.toLocaleString("es-ES", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function clampLimit(raw: number | undefined, fallback: number): number {
  if (raw === undefined || !Number.isFinite(raw)) return fallback;
  return Math.min(MAX_PAGE_LIMIT, Math.max(1, Math.floor(raw)));
}

function assertIsoDateParam(name: string, value: string | undefined): void {
  if (value !== undefined && !isIsoDateString(value)) {
    throw new BadRequestError(`El parámetro ${name} debe tener formato YYYY-MM-DD.`);
  }
}

function mapRoom(row: Awaited<ReturnType<typeof prisma.room.findUnique>>): RoomRecord {
  if (!row) throw new Error("Room row is null.");
  return {
    id: row.id,
    propertyId: row.propertyId,
    roomTypeId: row.roomTypeId,
    buildingId: row.buildingId ?? undefined,
    floorId: row.floorId ?? undefined,
    zoneId: row.zoneId ?? undefined,
    number: row.number,
    floor: row.floor ?? "",
    roomCode: row.roomCode ?? undefined,
    displayName: row.displayName ?? undefined,
    maxOccupancy: row.maxOccupancy ?? undefined,
    standardOccupancy: row.standardOccupancy ?? undefined,
    bedConfigurationJson: row.bedConfigurationJson as Record<string, unknown> | undefined,
    featuresJson: row.featuresJson as Record<string, unknown> | undefined,
    accessibilityJson: row.accessibilityJson as Record<string, unknown> | undefined,
    viewType: row.viewType ?? undefined,
    orientation: row.orientation ?? undefined,
    squareMeters: row.squareMeters ? dec(row.squareMeters) : undefined,
    status: row.status,
    housekeepingStatus: (row.housekeepingStatus ?? "clean") as RoomRecord["housekeepingStatus"],
    maintenanceStatus: (row.maintenanceStatus ?? "ok") as RoomRecord["maintenanceStatus"],
    sellable: row.sellable,
    active: row.active,
    sortOrder: row.sortOrder
  };
}

function mapRoomType(row: NonNullable<Awaited<ReturnType<typeof prisma.roomType.findUnique>>>): RoomTypeRecord {
  return {
    id: row.id,
    propertyId: row.propertyId,
    name: row.name,
    code: row.code,
    maxOccupancy: row.maxOccupancy,
    baseCapacity: row.baseCapacity,
    description: row.description ?? undefined,
    defaultBedConfigurationJson: row.defaultBedConfigurationJson as Record<string, unknown> | undefined,
    defaultAmenitiesJson: row.defaultAmenitiesJson as Record<string, unknown> | undefined,
    defaultPhotosJson: row.defaultPhotosJson as Record<string, unknown> | undefined,
    defaultRateCategory: row.defaultRateCategory ?? undefined,
    sellable: row.sellable,
    displayOrder: row.displayOrder,
    active: row.active
  };
}

function mapGuest(row: NonNullable<Awaited<ReturnType<typeof prisma.guest.findUnique>>>): GuestRecord {
  return {
    id: row.id,
    organizationId: row.organizationId,
    title: row.title ?? undefined,
    firstName: row.firstName,
    middleName: row.middleName ?? undefined,
    surname1: row.surname1 ?? undefined,
    surname2: row.surname2 ?? undefined,
    documentType: row.documentType ?? undefined,
    documentNumber: row.documentNumber ?? undefined,
    documentSupportNumber: row.documentSupportNumber ?? undefined,
    documentIssueCountry: row.documentIssueCountry ?? undefined,
    documentExpiryDate: row.documentExpiryDate ? isoDate(row.documentExpiryDate) : undefined,
    nationality: row.nationality ?? undefined,
    sex: row.sex ?? undefined,
    languagePreference: row.languagePreference ?? undefined,
    dateOfBirth: row.dateOfBirth ? isoDate(row.dateOfBirth) : undefined,
    residenceAddress: row.residenceAddress ?? undefined,
    residenceLocality: row.residenceLocality ?? undefined,
    residenceProvince: row.residenceProvince ?? undefined,
    residencePostalCode: row.residencePostalCode ?? undefined,
    residenceCountry: row.residenceCountry ?? undefined,
    phone: row.phone ?? undefined,
    mobilePhone: row.mobilePhone ?? undefined,
    email: row.email ?? undefined,
    company: row.company ?? undefined,
    vipCode: row.vipCode ?? undefined,
    loyaltyProgram: row.loyaltyProgram ?? undefined,
    loyaltyNumber: row.loyaltyNumber ?? undefined,
    loyaltyTier: row.loyaltyTier ?? undefined,
    preferences: Array.isArray(row.preferencesJson) ? (row.preferencesJson as string[]) : undefined,
    emergencyContactName: row.emergencyContactName ?? undefined,
    emergencyContactPhone: row.emergencyContactPhone ?? undefined,
    marketingConsent: row.marketingConsent ?? undefined,
    notes: row.notes ?? undefined
  };
}

function mapReservation(row: NonNullable<Awaited<ReturnType<typeof prisma.reservation.findUnique>>> & { primaryGuestId?: string | null }): ReservationRecord {
  return {
    id: row.id,
    propertyId: row.propertyId,
    code: row.code,
    channel: row.channel,
    status: row.status,
    arrivalDate: isoDate(row.arrivalDate),
    departureDate: isoDate(row.departureDate),
    adults: row.adults,
    children: row.children,
    infants: row.infants ?? undefined,
    childrenAges: Array.isArray(row.childrenAgesJson) ? (row.childrenAgesJson as number[]) : undefined,
    roomsCount: row.roomsCount ?? undefined,
    eta: row.eta ?? undefined,
    etd: row.etd ?? undefined,
    roomTypeId: row.roomTypeId ?? "",
    assignedRoomId: row.assignedRoomId ?? undefined,
    ratePlanId: row.ratePlanId ?? undefined,
    boardType: row.boardType ?? undefined,
    marketSegment: row.marketSegment ?? undefined,
    sourceCode: row.sourceCode ?? undefined,
    purposeOfStay: row.purposeOfStay ?? undefined,
    guaranteeType: row.guaranteeType ?? undefined,
    depositAmount: row.depositAmount != null ? dec(row.depositAmount) : undefined,
    cancellationPolicyCode: row.cancellationPolicyCode ?? undefined,
    billingInstruction: row.billingInstruction ?? undefined,
    companyName: row.companyName ?? undefined,
    travelAgentName: row.travelAgentName ?? undefined,
    groupCode: row.groupCode ?? undefined,
    externalReference: row.externalReference ?? undefined,
    bookerName: row.bookerName ?? undefined,
    bookerEmail: row.bookerEmail ?? undefined,
    specialRequests: row.specialRequests ?? undefined,
    notes: row.notes ?? undefined,
    totalAmount: dec(row.totalAmount),
    currency: row.currency,
    primaryGuestId: row.primaryGuestId ?? undefined,
    // REC-01a: parity columns accepted by UpdateReservationSchema must round-trip.
    estimatedArrivalTime: row.estimatedArrivalTime ?? undefined,
    internalNotes: row.internalNotes ?? undefined,
    vipFlag: row.vipFlag,
    accessibilityNeeds: row.accessibilityNeeds ?? undefined,
    dietaryRequirements: row.dietaryRequirements ?? undefined,
    bookingSource: row.bookingSource ?? undefined,
    paymentMethod: row.paymentMethod ?? undefined,
    depositPaid: row.depositPaid != null ? dec(row.depositPaid) : undefined,
    depositDueDate: row.depositDueDate ? isoDate(row.depositDueDate) : undefined,
    groupBookingId: row.groupBookingId ?? undefined
  };
}

async function withPrimaryGuestId(row: ReservationRow): Promise<ReservationRecord> {
  const primary = await prisma.reservationGuest.findFirst({
    where: { reservationId: row.id, isPrimary: true },
    select: { guestId: true }
  });
  return mapReservation(Object.assign(row, { primaryGuestId: primary?.guestId }));
}

/** Batch variant of withPrimaryGuestId: ONE reservationGuest query for a whole page (no N+1). */
async function attachPrimaryGuestIds(rows: ReservationRow[]): Promise<ReservationRecord[]> {
  if (rows.length === 0) return [];
  const links = await prisma.reservationGuest.findMany({
    where: { reservationId: { in: rows.map((r) => r.id) }, isPrimary: true },
    select: { reservationId: true, guestId: true }
  });
  const primaryByReservation = new Map(links.map((l) => [l.reservationId, l.guestId] as const));
  return rows.map((row) => mapReservation(Object.assign(row, { primaryGuestId: primaryByReservation.get(row.id) ?? null })));
}

export type RoomListOptions = {
  limit?: number;
  cursor?: string | null;
  sort?: "number";
};

/**
 * Rooms of a property, stable order (number asc, id asc) with an opaque cursor
 * (lib/pagination.ts). Default page = MAX_PAGE_LIMIT (500): inventory is
 * bounded and every front consumer expects the whole rack (Faranda lost 21 of
 * its 121 rooms under the old default of 100).
 */
export async function listRooms(propertyId: string, options: RoomListOptions = {}): Promise<Page<RoomRecord>> {
  const limit = clampLimit(options.limit, MAX_PAGE_LIMIT);
  const cursor = decodeCursor(options.cursor ?? null);
  const filter: Prisma.RoomWhereInput = { propertyId };
  const where: Prisma.RoomWhereInput = cursor
    ? { AND: [filter, { OR: [{ number: { gt: cursor.k } }, { number: cursor.k, id: { gt: cursor.id } }] }] }
    : filter;
  const [rows, total] = await Promise.all([
    prisma.room.findMany({ where, orderBy: [{ number: "asc" }, { id: "asc" }], take: limit + 1 }),
    prisma.room.count({ where: filter })
  ]);
  return buildPage(rows.map(mapRoom), limit, total, (room) => room.number);
}

/**
 * SECURITY (audit 2026-06 R2 · NUEVO-1): centralized tenant-scope guard so the
 * IDOR check isn't re-implemented (or forgotten) per route. Asserts that a
 * property belongs to the caller's organization before any write that takes a
 * propertyId from the request. Returns 404 (not 403) so we don't leak the
 * existence of another tenant's property.
 */
export async function assertPropertyInOrg(propertyId: string, organizationId: string): Promise<void> {
  const property = await prisma.property.findUnique({
    where: { id: propertyId },
    select: { organizationId: true }
  });
  if (!property || property.organizationId !== organizationId) {
    // SEC-2: generic message — never echo the id or hint at its owner.
    throw new NotFoundError("Propiedad no encontrada.");
  }
}

export async function createRoom(input: {
  context: UserContext;
  propertyId: string;
  roomTypeId: string;
  number: string;
  floor?: string;
  correlationId: string;
}): Promise<RoomRecord> {
  requirePermissions(input.context, ["pms.reservation.modify"]);
  await assertPropertyInOrg(input.propertyId, input.context.organizationId);
  // roomType must belong to the same property (and therefore tenant).
  const rt = await prisma.roomType.findUnique({ where: { id: input.roomTypeId }, select: { propertyId: true } });
  if (!rt || rt.propertyId !== input.propertyId) {
    throw new BadRequestError("Room type does not belong to this property.");
  }

  const existing = await prisma.room.findUnique({
    where: { propertyId_number: { propertyId: input.propertyId, number: input.number } }
  });
  if (existing) {
    throw new ConflictError(`La habitación ${input.number} ya existe en esta propiedad.`);
  }

  const created = await prisma.room.create({
    data: {
      propertyId: input.propertyId,
      roomTypeId: input.roomTypeId,
      number: input.number,
      floor: input.floor ?? "",
      status: "clean",
      housekeepingStatus: "clean",
      maintenanceStatus: "ok",
      sellable: true
    }
  });
  const room = mapRoom(created);
  mirrorRoom(room);

  recordAuditEvent({
    organizationId: input.context.organizationId,
    propertyId: input.propertyId,
    actorUserId: input.context.userId,
    actorType: "user",
    action: "ROOM_CREATED",
    entityType: "room",
    entityId: room.id,
    afterJson: room,
    deviceId: input.context.deviceId,
    correlationId: input.correlationId
  });

  return room;
}

export async function listRoomTypes(propertyId: string): Promise<RoomTypeRecord[]> {
  // Demo-safe pagination ceiling: room types per property are bounded but keep
  // a guard rail so a misconfigured seed cannot blow up the response.
  const rows = await prisma.roomType.findMany({
    where: { propertyId },
    orderBy: { displayOrder: "asc" },
    take: 100
  });
  return rows.map(mapRoomType);
}

export type ReservationListOptions = {
  /** ReservationStatus values; anything else is a 400. */
  status?: string[];
  /** Stay-overlap window: arrivalDate < to && departureDate > from (YYYY-MM-DD). */
  from?: string;
  to?: string;
  /** Arrival-date window, inclusive on both ends (YYYY-MM-DD). */
  arrivalFrom?: string;
  arrivalTo?: string;
  /** Free text over code, bookerName and the primary guest's name. */
  q?: string;
  sort?: "arrival_desc" | "arrival_asc";
  limit?: number;
  cursor?: string | null;
};

/**
 * Reservations of a property with server-side filters and cursor pagination
 * (REC-05 / QC-04). Stable order (arrivalDate, id) — desc by default — and one
 * batched primary-guest lookup per page instead of one query per row.
 * Soft-deleted rows (deletedAt) are never listed.
 */
export async function listReservations(propertyId: string, options: ReservationListOptions = {}): Promise<Page<ReservationRecord>> {
  const limit = clampLimit(options.limit, DEFAULT_PAGE_LIMIT);
  const sort = options.sort ?? "arrival_desc";
  if (sort !== "arrival_desc" && sort !== "arrival_asc") {
    throw new BadRequestError("El parámetro sort debe ser arrival_desc o arrival_asc.");
  }
  const statuses = (options.status ?? []).map((s) => s.trim()).filter((s) => s.length > 0);
  for (const status of statuses) {
    if (!RESERVATION_STATUSES.includes(status as ReservationStatus)) {
      throw new BadRequestError(`Estado de reserva no válido: ${status}. Valores admitidos: ${RESERVATION_STATUSES.join(", ")}.`);
    }
  }
  assertIsoDateParam("from", options.from);
  assertIsoDateParam("to", options.to);
  assertIsoDateParam("arrivalFrom", options.arrivalFrom);
  assertIsoDateParam("arrivalTo", options.arrivalTo);
  if (options.from && options.to && options.from >= options.to) {
    throw new BadRequestError("El parámetro to debe ser posterior a from.");
  }
  if (options.arrivalFrom && options.arrivalTo && options.arrivalFrom > options.arrivalTo) {
    throw new BadRequestError("El parámetro arrivalTo no puede ser anterior a arrivalFrom.");
  }
  const q = (options.q ?? "").trim();

  const clauses: Prisma.ReservationWhereInput[] = [];
  if (statuses.length > 0) clauses.push({ status: { in: statuses as ReservationStatus[] } });
  if (options.from) clauses.push({ departureDate: { gt: dateOnly(options.from) } });
  if (options.to) clauses.push({ arrivalDate: { lt: dateOnly(options.to) } });
  if (options.arrivalFrom) clauses.push({ arrivalDate: { gte: dateOnly(options.arrivalFrom) } });
  if (options.arrivalTo) clauses.push({ arrivalDate: { lte: dateOnly(options.arrivalTo) } });
  if (q) {
    const nameMatch: Prisma.GuestWhereInput = {
      OR: [
        { firstName: { contains: q, mode: "insensitive" } },
        { surname1: { contains: q, mode: "insensitive" } },
        { surname2: { contains: q, mode: "insensitive" } }
      ]
    };
    clauses.push({
      OR: [
        { code: { contains: q, mode: "insensitive" } },
        { bookerName: { contains: q, mode: "insensitive" } },
        { reservationGuests: { some: { isPrimary: true, guest: nameMatch } } }
      ]
    });
  }
  const filter: Prisma.ReservationWhereInput = { propertyId, deletedAt: null, AND: clauses };

  const cursor = decodeCursor(options.cursor ?? null);
  let where: Prisma.ReservationWhereInput = filter;
  if (cursor) {
    if (!isIsoDateString(cursor.k)) {
      throw new BadRequestError("El cursor de paginación no es válido.");
    }
    const k = dateOnly(cursor.k);
    const after: Prisma.ReservationWhereInput =
      sort === "arrival_desc"
        ? { OR: [{ arrivalDate: { lt: k } }, { arrivalDate: k, id: { lt: cursor.id } }] }
        : { OR: [{ arrivalDate: { gt: k } }, { arrivalDate: k, id: { gt: cursor.id } }] };
    where = { AND: [filter, after] };
  }
  const direction: Prisma.SortOrder = sort === "arrival_desc" ? "desc" : "asc";

  const [rows, total] = await Promise.all([
    prisma.reservation.findMany({ where, orderBy: [{ arrivalDate: direction }, { id: direction }], take: limit + 1 }),
    prisma.reservation.count({ where: filter })
  ]);
  const items = await attachPrimaryGuestIds(rows);
  return buildPage(items, limit, total, (reservation) => reservation.arrivalDate);
}

export async function getReservation(id: string): Promise<ReservationRecord> {
  const row = await prisma.reservation.findUnique({ where: { id } });
  if (!row) {
    throw new NotFoundError("Reserva no encontrada.");
  }
  return withPrimaryGuestId(row);
}

export async function createReservation(input: {
  context: UserContext;
  propertyId: string;
  channel?: string;
  arrivalDate: string;
  departureDate: string;
  adults?: number;
  children?: number;
  infants?: number;
  childrenAges?: number[];
  roomsCount?: number;
  eta?: string;
  etd?: string;
  roomTypeId: string;
  assignedRoomId?: string;
  ratePlanId?: string;
  boardType?: string;
  marketSegment?: string;
  sourceCode?: string;
  purposeOfStay?: string;
  guaranteeType?: string;
  depositAmount?: number;
  cancellationPolicyCode?: string;
  billingInstruction?: string;
  companyName?: string;
  travelAgentName?: string;
  groupCode?: string;
  externalReference?: string;
  bookerName?: string;
  bookerEmail?: string;
  specialRequests?: string;
  notes?: string;
  totalAmount?: number;
  currency?: string;
  // 2026 audit: PMS field parity with Mews / Opera / Cloudbeds.
  bookingSource?: string;
  internalNotes?: string;
  estimatedArrivalTime?: string;
  paymentMethod?: string;
  depositPaid?: number;
  depositDueDate?: string;
  vipFlag?: boolean;
  accessibilityNeeds?: string;
  dietaryRequirements?: string;
  groupBookingId?: string;
  primaryGuest?: GuestIdentityFields;
  correlationId: string;
}): Promise<ReservationRecord> {
  requirePermissions(input.context, ["pms.reservation.create"]);

  if (input.arrivalDate >= input.departureDate) {
    throw new BadRequestError("Departure date must be after arrival date.");
  }

  const reservation = await prisma.$transaction(async (tx) => {
    // SECURITY (audit 2026-06 · NUEVO-1): block cross-tenant writes (IDOR).
    // propertyId arrives from the URL path; verify it belongs to the caller's
    // organization before creating reservations/folios under it. Returning 404
    // (not 403) avoids leaking the existence of other tenants' properties.
    const property = await tx.property.findUnique({
      where: { id: input.propertyId },
      select: { organizationId: true }
    });
    if (!property || property.organizationId !== input.context.organizationId) {
      // SEC-2: generic message — never echo the id or hint at its owner.
      throw new NotFoundError("Propiedad no encontrada.");
    }
    // roomType / ratePlan must belong to the same property (and therefore the
    // same tenant) — prevents grafting another property's inventory/pricing.
    if (input.roomTypeId) {
      const rt = await tx.roomType.findUnique({
        where: { id: input.roomTypeId },
        select: { propertyId: true }
      });
      if (!rt || rt.propertyId !== input.propertyId) {
        throw new BadRequestError("Room type does not belong to this property.");
      }
    }
    if (input.ratePlanId) {
      const rp = await tx.ratePlan.findUnique({
        where: { id: input.ratePlanId },
        select: { propertyId: true }
      });
      if (!rp || rp.propertyId !== input.propertyId) {
        throw new BadRequestError("Rate plan does not belong to this property.");
      }
    }

    // CORRECTNESS (audit 2026-06 · H2): enforce availability on WRITE, not just
    // on the read-side quote. Without this, two concurrent bookings over full
    // inventory both confirm. We take a transactional advisory lock keyed by
    // (property, roomType) so the sum below cannot race with a parallel
    // create; the lock releases automatically when the transaction ends and
    // only serializes bookings for the SAME room type.
    if (input.roomTypeId) {
      // Prisma ≥6.19 no puede deserializar el `void` que devuelve
      // pg_advisory_xact_lock vía $queryRaw → $executeRaw (no deserializa filas).
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${input.propertyId}), hashtext(${input.roomTypeId}))`;

      const arrival = dateOnly(input.arrivalDate);
      const departure = dateOnly(input.departureDate);
      const totalRooms = await tx.room.count({
        where: {
          propertyId: input.propertyId,
          roomTypeId: input.roomTypeId,
          sellable: true,
          maintenanceStatus: { not: "blocked" }
        }
      });
      // Sum rooms (not reservation rows): a multi-room booking consumes
      // roomsCount units of inventory. `_sum` is null when nothing overlaps.
      const overlapping = await tx.reservation.aggregate({
        _sum: { roomsCount: true },
        where: {
          propertyId: input.propertyId,
          roomTypeId: input.roomTypeId,
          status: { in: ["confirmed", "checked_in"] },
          arrivalDate: { lt: departure },
          departureDate: { gt: arrival }
        }
      });
      const bookedRooms = overlapping._sum.roomsCount ?? 0;
      const requested = input.roomsCount ?? 1;
      if (bookedRooms + requested > totalRooms) {
        throw new ConflictError(
          `No hay disponibilidad para el tipo de habitación seleccionado en esas fechas ` +
            `(${totalRooms} habitaciones, ${bookedRooms} ya reservadas, ${requested} solicitadas).`
        );
      }
    }

    let guestId: string | undefined;

    if (input.primaryGuest?.documentNumber) {
      const existingGuest = await tx.guest.findFirst({
        where: { documentNumber: input.primaryGuest.documentNumber, organizationId: input.context.organizationId }
      });
      guestId = existingGuest?.id;
    }

    if (!guestId && input.primaryGuest?.firstName) {
      const g = input.primaryGuest;
      const createdGuest = await tx.guest.create({
        data: {
          organizationId: input.context.organizationId,
          title: g.title ?? null,
          firstName: g.firstName ?? "",
          middleName: g.middleName ?? null,
          surname1: g.surname1 ?? null,
          surname2: g.surname2 ?? null,
          documentType: g.documentType ?? null,
          documentNumber: g.documentNumber ?? null,
          documentSupportNumber: g.documentSupportNumber ?? null,
          documentIssueCountry: g.documentIssueCountry ?? null,
          documentExpiryDate: g.documentExpiryDate ? dateOnly(g.documentExpiryDate) : null,
          nationality: g.nationality ?? null,
          sex: g.sex ?? null,
          languagePreference: g.languagePreference ?? null,
          dateOfBirth: g.dateOfBirth ? dateOnly(g.dateOfBirth) : null,
          residenceAddress: g.residenceAddress ?? null,
          residenceLocality: g.residenceLocality ?? null,
          residenceProvince: g.residenceProvince ?? null,
          residencePostalCode: g.residencePostalCode ?? null,
          residenceCountry: g.residenceCountry ?? null,
          phone: g.phone ?? null,
          mobilePhone: g.mobilePhone ?? null,
          email: g.email ?? null,
          company: g.company ?? null,
          vipCode: g.vipCode ?? null,
          loyaltyProgram: g.loyaltyProgram ?? null,
          loyaltyNumber: g.loyaltyNumber ?? null,
          loyaltyTier: g.loyaltyTier ?? null,
          preferencesJson: g.preferences && g.preferences.length ? g.preferences : undefined,
          emergencyContactName: g.emergencyContactName ?? null,
          emergencyContactPhone: g.emergencyContactPhone ?? null,
          marketingConsent: g.marketingConsent ?? null,
          notes: g.notes ?? null
        }
      });
      guestId = createdGuest.id;
    }

    const count = await tx.reservation.count({ where: { propertyId: input.propertyId } });
    const code = `RES-${String(count + 1).padStart(5, "0")}`;

    const created = await tx.reservation.create({
      data: {
        propertyId: input.propertyId,
        code,
        channel: input.channel ?? "direct",
        status: "confirmed",
        arrivalDate: dateOnly(input.arrivalDate),
        departureDate: dateOnly(input.departureDate),
        adults: input.adults ?? 1,
        children: input.children ?? 0,
        infants: input.infants ?? 0,
        childrenAgesJson: input.childrenAges && input.childrenAges.length ? input.childrenAges : undefined,
        roomsCount: input.roomsCount ?? 1,
        eta: input.eta ?? null,
        etd: input.etd ?? null,
        roomTypeId: input.roomTypeId,
        assignedRoomId: input.assignedRoomId ?? null,
        ratePlanId: input.ratePlanId ?? null,
        boardType: input.boardType ?? null,
        marketSegment: input.marketSegment ?? null,
        sourceCode: input.sourceCode ?? null,
        purposeOfStay: input.purposeOfStay ?? null,
        guaranteeType: input.guaranteeType ?? null,
        depositAmount: input.depositAmount ?? null,
        cancellationPolicyCode: input.cancellationPolicyCode ?? null,
        billingInstruction: input.billingInstruction ?? null,
        companyName: input.companyName ?? null,
        travelAgentName: input.travelAgentName ?? null,
        groupCode: input.groupCode ?? null,
        externalReference: input.externalReference ?? null,
        bookerName: input.bookerName ?? null,
        bookerEmail: input.bookerEmail ?? null,
        specialRequests: input.specialRequests ?? null,
        notes: input.notes ?? null,
        totalAmount: input.totalAmount ?? 0,
        currency: input.currency ?? "EUR",
        bookingSource: input.bookingSource ?? null,
        internalNotes: input.internalNotes ?? null,
        estimatedArrivalTime: input.estimatedArrivalTime ?? null,
        paymentMethod: input.paymentMethod ?? null,
        depositPaid: input.depositPaid ?? null,
        depositDueDate: input.depositDueDate ? dateOnly(input.depositDueDate) : null,
        vipFlag: input.vipFlag ?? false,
        accessibilityNeeds: input.accessibilityNeeds ?? null,
        dietaryRequirements: input.dietaryRequirements ?? null,
        groupBookingId: input.groupBookingId ?? null
      }
    });

    if (guestId) {
      await tx.reservationGuest.create({
        data: { reservationId: created.id, guestId, isPrimary: true }
      });
    }

    await tx.folio.create({
      data: {
        reservationId: created.id,
        guestId: guestId ?? null,
        status: "open",
        currency: created.currency
      }
    });

    return Object.assign(created, { primaryGuestId: guestId });
  });

  const mapped = mapReservation(reservation);
  mirrorReservation(mapped);
  if (reservation.primaryGuestId) {
    const guestRow = await prisma.guest.findUnique({ where: { id: reservation.primaryGuestId } });
    if (guestRow) mirrorGuest(mapGuest(guestRow));
  }
  const folioRow = await prisma.folio.findFirst({ where: { reservationId: mapped.id } });
  if (folioRow) {
    mirrorFolioStub({
      id: folioRow.id,
      reservationId: folioRow.reservationId,
      guestId: folioRow.guestId ?? undefined,
      status: folioRow.status,
      currency: folioRow.currency
    });
  }

  recordAuditEvent({
    organizationId: input.context.organizationId,
    propertyId: input.propertyId,
    actorUserId: input.context.userId,
    actorType: "user",
    action: "RESERVATION_CREATED",
    entityType: "reservation",
    entityId: mapped.id,
    afterJson: mapped,
    deviceId: input.context.deviceId,
    correlationId: input.correlationId
  });

  recordDomainEvent({
    organizationId: input.context.organizationId,
    propertyId: input.propertyId,
    entityType: "reservation",
    entityId: mapped.id,
    eventType: "ReservationCreated",
    payload: { code: mapped.code, arrivalDate: mapped.arrivalDate, departureDate: mapped.departureDate },
    actorType: "user",
    actorUserId: input.context.userId,
    correlationId: input.correlationId
  });

  return mapped;
}

type ReservationPatchFields = Omit<UpdateReservationInput, "assignedRoomId" | "roomId" | "masterFolioId" | "status">;
type ReservationPatchMappers = {
  [K in keyof Required<ReservationPatchFields>]: (value: Exclude<ReservationPatchFields[K], undefined>) => Prisma.ReservationUpdateInput;
};

// Table-driven PATCH → column mapping (REC-01). One row per allowlisted key of
// UpdateReservationSchema; room assignment, masterFolioId and status are
// handled explicitly in patchReservation. `null` clears nullable columns.
// Adding a column = one schema entry + one row here: the compiler rejects a
// schema key without a mapper (and vice versa), so nothing is dropped silently.
const RESERVATION_PATCH_MAPPERS: ReservationPatchMappers = {
  arrivalDate: (v) => ({ arrivalDate: dateOnly(v) }),
  departureDate: (v) => ({ departureDate: dateOnly(v) }),
  adults: (v) => ({ adults: v }),
  children: (v) => ({ children: v }),
  infants: (v) => ({ infants: v }),
  childrenAges: (v) => ({ childrenAgesJson: v === null ? Prisma.DbNull : v }),
  roomsCount: (v) => ({ roomsCount: v }),
  eta: (v) => ({ eta: v }),
  etd: (v) => ({ etd: v }),
  estimatedArrivalTime: (v) => ({ estimatedArrivalTime: v }),
  roomTypeId: (v) => ({ roomTypeId: v }),
  ratePlanId: (v) => ({ ratePlanId: v }),
  groupBookingId: (v) => ({ groupBookingId: v }),
  channel: (v) => ({ channel: v }),
  bookingSource: (v) => ({ bookingSource: v }),
  boardType: (v) => ({ boardType: v }),
  marketSegment: (v) => ({ marketSegment: v }),
  sourceCode: (v) => ({ sourceCode: v }),
  purposeOfStay: (v) => ({ purposeOfStay: v }),
  guaranteeType: (v) => ({ guaranteeType: v }),
  depositAmount: (v) => ({ depositAmount: v }),
  depositPaid: (v) => ({ depositPaid: v }),
  depositDueDate: (v) => ({ depositDueDate: v === null ? null : dateOnly(v) }),
  paymentMethod: (v) => ({ paymentMethod: v }),
  cancellationPolicyCode: (v) => ({ cancellationPolicyCode: v }),
  billingInstruction: (v) => ({ billingInstruction: v }),
  companyName: (v) => ({ companyName: v }),
  travelAgentName: (v) => ({ travelAgentName: v }),
  groupCode: (v) => ({ groupCode: v }),
  externalReference: (v) => ({ externalReference: v }),
  bookerName: (v) => ({ bookerName: v }),
  bookerEmail: (v) => ({ bookerEmail: v }),
  specialRequests: (v) => ({ specialRequests: v }),
  notes: (v) => ({ notes: v }),
  internalNotes: (v) => ({ internalNotes: v }),
  accessibilityNeeds: (v) => ({ accessibilityNeeds: v }),
  dietaryRequirements: (v) => ({ dietaryRequirements: v }),
  vipFlag: (v) => ({ vipFlag: v }),
  totalAmount: (v) => ({ totalAmount: v }),
  currency: (v) => ({ currency: v })
};

const PATCH_ROOM_KEYS: ReadonlySet<string> = new Set(["assignedRoomId", "roomId"]);

function buildReservationPatchData(patch: UpdateReservationInput): Prisma.ReservationUpdateInput {
  const data: Prisma.ReservationUpdateInput = {};
  for (const key of Object.keys(RESERVATION_PATCH_MAPPERS) as Array<keyof ReservationPatchMappers>) {
    const value = patch[key];
    if (value === undefined) continue;
    const mapper = RESERVATION_PATCH_MAPPERS[key] as (input: unknown) => Prisma.ReservationUpdateInput;
    Object.assign(data, mapper(value));
  }
  return data;
}

/**
 * Partial update of a reservation (PATCH /reservations/:id). `patch` MUST be
 * the output of UpdateReservationSchema (strict allowlist): every accepted key
 * is persisted through RESERVATION_PATCH_MAPPERS, `status` is never accepted
 * (lifecycle routes own it), and a room key goes through canAssignRoom — for
 * an in-house reservation it becomes the transactional room move (REC-03).
 */
export async function patchReservation(input: {
  context: UserContext;
  reservationId: string;
  patch: UpdateReservationInput;
  correlationId: string;
}): Promise<ReservationRecord> {
  requirePermissions(input.context, ["pms.reservation.modify"]);

  const existing = await prisma.reservation.findUnique({ where: { id: input.reservationId } });
  if (!existing) {
    throw new NotFoundError("Reserva no encontrada.");
  }
  // SECURITY (audit 2026-06 R2 · NUEVO-1): the reservation's property must belong
  // to the caller's org, or a user in org A could patch org B's reservation by id.
  await assertPropertyInOrg(existing.propertyId, input.context.organizationId);

  const patch = input.patch;
  // Belt and braces: the schema rejects `status`, but a caller bypassing it
  // (raw body) must not be able to fake a lifecycle transition either.
  if ((patch as Record<string, unknown>).status !== undefined) {
    throw new BadRequestError("status no se puede modificar por PATCH: usa /reservations/:id/check-in, /check-out, /cancel o /no-show.");
  }
  const sentKeys = (Object.keys(patch) as Array<keyof UpdateReservationInput>).filter((key) => patch[key] !== undefined);

  // Room assignment: `assignedRoomId` or its legacy alias `roomId`.
  const roomKeySent = patch.assignedRoomId !== undefined || patch.roomId !== undefined;
  if (patch.assignedRoomId !== undefined && patch.roomId !== undefined && patch.assignedRoomId !== patch.roomId) {
    throw new BadRequestError("assignedRoomId y roomId no coinciden: envía solo uno de los dos.");
  }
  const nextAssignedRoomId: string | null | undefined = patch.assignedRoomId !== undefined ? patch.assignedRoomId : patch.roomId;

  if (existing.status === "checked_in") {
    // REC-03: an in-house reservation only accepts a room change, which is the
    // transactional move (old room dirty + HK task, new room occupied, Stay
    // re-pointed). Anything else needs the check-out first.
    const otherKeys = sentKeys.filter((key) => !PATCH_ROOM_KEYS.has(key));
    if (!roomKeySent || otherKeys.length > 0) {
      throw new ConflictError(
        `La reserva ${existing.code} está en estado checked_in: por PATCH solo se admite el cambio de habitación (assignedRoomId).`
      );
    }
    if (!nextAssignedRoomId) {
      throw new ConflictError(`No se puede desasignar la habitación de la reserva ${existing.code} con el huésped alojado.`);
    }
    return assignRoom({
      context: input.context,
      reservationId: existing.id,
      roomId: nextAssignedRoomId,
      correlationId: input.correlationId
    });
  }
  if (CLOSED_RESERVATION_STATUSES.includes(existing.status)) {
    throw new ConflictError(`La reserva ${existing.code} no se puede modificar en estado ${existing.status}.`);
  }

  const before = await withPrimaryGuestId(existing);
  // Snapshot pre-update critical fields for fine-grained audit emission below.
  const beforeArrival = before.arrivalDate;
  const beforeDeparture = before.departureDate;
  const beforeRoomId = before.assignedRoomId ?? null;
  const beforeVipFlag = existing.vipFlag;
  // masterFolioId is not on the Reservation model directly — it lives on the
  // GroupBooking that backs corporate stays. For routing-change audit we read
  // the link via the reservation's groupBookingId so we can compare before/after.
  const beforeMasterFolioId = existing.groupBookingId
    ? (await prisma.groupBooking.findUnique({ where: { id: existing.groupBookingId }, select: { masterFolioId: true } }))?.masterFolioId ?? null
    : null;

  const nextArrival = patch.arrivalDate ?? before.arrivalDate;
  const nextDeparture = patch.departureDate ?? before.departureDate;
  if (nextArrival >= nextDeparture) {
    throw new BadRequestError("La fecha de salida debe ser posterior a la fecha de llegada.");
  }

  // Referential guards: linked inventory / pricing / group rows must belong to
  // the reservation's property (same tenant rule as createReservation).
  if (patch.roomTypeId !== undefined) {
    const rt = await prisma.roomType.findUnique({ where: { id: patch.roomTypeId }, select: { propertyId: true } });
    if (!rt || rt.propertyId !== existing.propertyId) {
      throw new BadRequestError("El tipo de habitación no pertenece a esta propiedad.");
    }
  }
  if (patch.ratePlanId) {
    const rp = await prisma.ratePlan.findUnique({ where: { id: patch.ratePlanId }, select: { propertyId: true } });
    if (!rp || rp.propertyId !== existing.propertyId) {
      throw new BadRequestError("El plan de tarifas no pertenece a esta propiedad.");
    }
  }
  if (patch.groupBookingId) {
    const gb = await prisma.groupBooking.findUnique({ where: { id: patch.groupBookingId }, select: { propertyId: true } });
    if (!gb || gb.propertyId !== existing.propertyId) {
      throw new BadRequestError("El grupo no pertenece a esta propiedad.");
    }
  }

  const data = buildReservationPatchData(patch);
  if (roomKeySent) {
    data.assignedRoomId = nextAssignedRoomId ?? null;
  }

  // REC-01b: validate the room the reservation will have AFTER this patch —
  // the one sent now, or the one already assigned when only the dates move
  // (a date change used to skip the check and silently double-book the
  // room). Same rule as /assign-room (room exists in the property, sellable,
  // not occupied by someone else, no overlapping assignment) over the new
  // stay window. Without an effective room nothing is validated: no inventory
  // is consumed yet. The check runs under the room row lock so a concurrent
  // assignment of the same room cannot slip between validation and write.
  const effectiveRoomId: string | null = roomKeySent ? nextAssignedRoomId ?? null : existing.assignedRoomId ?? null;
  const datesChanged = nextArrival !== before.arrivalDate || nextDeparture !== before.departureDate;
  const roomToValidate = effectiveRoomId && (roomKeySent || datesChanged) ? effectiveRoomId : null;

  const updated = await prisma.$transaction(async (tx) => {
    if (roomToValidate) {
      const validation = await validateRoomUnderLock(tx, {
        propertyId: existing.propertyId,
        reservationId: existing.id,
        roomId: roomToValidate,
        arrivalDate: nextArrival,
        departureDate: nextDeparture
      });
      if (!validation.allowed) {
        const reasons = validation.warnings.join(" ");
        throw withDetails(
          new ConflictError(
            roomKeySent
              ? `No se puede asignar la habitación: ${reasons}`
              : `Las nuevas fechas entran en conflicto con la habitación asignada: ${reasons}`
          ),
          { code: "ROOM_CONFLICT", roomId: roomToValidate, arrivalDate: nextArrival, departureDate: nextDeparture, warnings: validation.warnings }
        );
      }
    }
    return tx.reservation.update({ where: { id: existing.id }, data });
  });
  const after = await withPrimaryGuestId(updated);
  mirrorReservation(after);

  // Optional: propagate masterFolioId routing change on the linked GroupBooking
  // when caller is rerouting charges. Reservation does not own the column.
  let afterMasterFolioId: string | null = beforeMasterFolioId;
  const groupBookingIdForRouting = updated.groupBookingId ?? existing.groupBookingId;
  if (patch.masterFolioId !== undefined && groupBookingIdForRouting) {
    const refreshed = await prisma.groupBooking.update({
      where: { id: groupBookingIdForRouting },
      data: { masterFolioId: patch.masterFolioId },
      select: { masterFolioId: true }
    });
    afterMasterFolioId = refreshed.masterFolioId ?? null;
  }

  // Always record the umbrella update event for backward compatibility.
  recordAuditEvent({
    organizationId: input.context.organizationId,
    propertyId: after.propertyId,
    actorUserId: input.context.userId,
    actorType: "user",
    action: "RESERVATION_UPDATED",
    entityType: "reservation",
    entityId: after.id,
    beforeJson: before,
    afterJson: { ...after, changedKeys: sentKeys },
    deviceId: input.context.deviceId,
    correlationId: input.correlationId
  });

  // Fine-grained audit events per critical change. Each one carries a focused
  // before/after diff so the activity log / compliance review can surface what
  // actually changed without diffing the whole reservation blob.
  if (after.arrivalDate !== beforeArrival || after.departureDate !== beforeDeparture) {
    recordAuditEvent({
      organizationId: input.context.organizationId,
      propertyId: after.propertyId,
      actorUserId: input.context.userId,
      actorType: "user",
      action: "DATE_MODIFIED",
      entityType: "reservation",
      entityId: after.id,
      beforeJson: { arrivalDate: beforeArrival, departureDate: beforeDeparture },
      afterJson: { arrivalDate: after.arrivalDate, departureDate: after.departureDate },
      deviceId: input.context.deviceId,
      correlationId: input.correlationId
    });
  }

  if ((after.assignedRoomId ?? null) !== beforeRoomId) {
    recordAuditEvent({
      organizationId: input.context.organizationId,
      propertyId: after.propertyId,
      actorUserId: input.context.userId,
      actorType: "user",
      action: "ROOM_ASSIGNED",
      entityType: "reservation",
      entityId: after.id,
      beforeJson: { assignedRoomId: beforeRoomId },
      afterJson: { assignedRoomId: after.assignedRoomId ?? null },
      deviceId: input.context.deviceId,
      correlationId: input.correlationId
    });
  }

  if (afterMasterFolioId !== beforeMasterFolioId) {
    recordAuditEvent({
      organizationId: input.context.organizationId,
      propertyId: after.propertyId,
      actorUserId: input.context.userId,
      actorType: "user",
      action: "FOLIO_ROUTED",
      entityType: "reservation",
      entityId: after.id,
      beforeJson: { masterFolioId: beforeMasterFolioId },
      afterJson: { masterFolioId: afterMasterFolioId },
      deviceId: input.context.deviceId,
      correlationId: input.correlationId
    });
  }

  if (updated.vipFlag !== beforeVipFlag && updated.vipFlag === true) {
    recordAuditEvent({
      organizationId: input.context.organizationId,
      propertyId: after.propertyId,
      actorUserId: input.context.userId,
      actorType: "user",
      action: "VIP_FLAGGED",
      entityType: "reservation",
      entityId: after.id,
      beforeJson: { vipFlag: beforeVipFlag },
      afterJson: { vipFlag: true },
      deviceId: input.context.deviceId,
      correlationId: input.correlationId
    });
  }

  return after;
}

export async function matchGuestToReservation(input: {
  propertyId: string;
  documentFields: GuestIdentityFields;
}): Promise<{ guest: GuestRecord; reservation: ReservationRecord }> {
  const orClauses: Prisma.GuestWhereInput[] = [];
  if (input.documentFields.documentNumber) {
    orClauses.push({ documentNumber: input.documentFields.documentNumber });
  }
  if (input.documentFields.firstName && input.documentFields.surname1) {
    orClauses.push({
      AND: [
        { firstName: { equals: input.documentFields.firstName, mode: "insensitive" } },
        { surname1: { equals: input.documentFields.surname1, mode: "insensitive" } }
      ]
    });
  }
  if (orClauses.length === 0) {
    throw new BadRequestError("Se necesita el número de documento o nombre y primer apellido para localizar al huésped.");
  }

  // documentNumber inside the OR is plaintext; the Prisma encryption
  // extension (packages/database/src/client.ts) rewrites it to
  // `documentNumberLookupHash` via the deterministic HMAC so equality
  // lookups still hit an index after Sprint 32 encryption.
  const guestRow = await prisma.guest.findFirst({ where: { OR: orClauses } });
  if (!guestRow) {
    throw new NotFoundError("No se ha encontrado ningún huésped que coincida con el documento.");
  }

  const links = await prisma.reservationGuest.findMany({
    where: { guestId: guestRow.id, isPrimary: true }
  });
  if (links.length === 0) {
    throw new NotFoundError("El huésped no tiene ninguna reserva abierta en esta propiedad.");
  }

  const reservationRow = await prisma.reservation.findFirst({
    where: {
      id: { in: links.map((l) => l.reservationId) },
      propertyId: input.propertyId,
      status: { in: ["confirmed", "draft"] }
    }
  });
  if (!reservationRow) {
    throw new NotFoundError("El huésped no tiene ninguna reserva abierta en esta propiedad.");
  }

  const reservation = mapReservation(Object.assign(reservationRow, { primaryGuestId: guestRow.id }));
  return { guest: mapGuest(guestRow), reservation };
}

export async function assignRoom(input: {
  context: UserContext;
  reservationId: string;
  roomId: string;
  correlationId: string;
}): Promise<ReservationRecord> {
  requirePermissions(input.context, ["pms.reservation.modify"]);

  const reservation = await prisma.reservation.findUnique({ where: { id: input.reservationId } });
  const room = await prisma.room.findUnique({ where: { id: input.roomId } });
  if (!reservation || !room) {
    throw new NotFoundError("Reserva o habitación no encontrada.");
  }
  // SECURITY (audit 2026-06 R2 · NUEVO-1): the reservation must be in the caller's
  // org, and the room must belong to that same property — otherwise you could
  // assign another tenant's room (or operate on another tenant's reservation) by id.
  await assertPropertyInOrg(reservation.propertyId, input.context.organizationId);
  if (room.propertyId !== reservation.propertyId) {
    // NUEVO-ROOM-ORACLE: same opaque 404 as an unknown id. A distinct 400 here
    // confirmed to a caller that a room id from another tenant exists.
    throw new NotFoundError("Reserva o habitación no encontrada.");
  }
  if (CLOSED_RESERVATION_STATUSES.includes(reservation.status)) {
    throw new ConflictError(`La reserva ${reservation.code} no admite asignación de habitación en estado ${reservation.status}.`);
  }
  if (reservation.assignedRoomId === room.id) {
    // Idempotent: already in that room — nothing to move, nothing to audit.
    return withPrimaryGuestId(reservation);
  }

  if (reservation.status === "checked_in") {
    return moveInHouseReservation({ context: input.context, reservation, toRoom: room, correlationId: input.correlationId });
  }

  // Not in house yet (draft/confirmed): a plain pre-assignment. Room status,
  // Stay and housekeeping are untouched until the check-in.
  const before = await withPrimaryGuestId(reservation);
  const updated = await prisma.$transaction(async (tx) => {
    // REC-03: validate under the room row lock (a concurrent assignment of the
    // same room to another reservation is visible here), then a CONDITIONAL
    // write: it only lands if the reservation is still pre-arrival and still
    // on the room we read. A concurrent assign-room on the same reservation
    // (or a check-in that took it in house meanwhile) makes count 0 → 409
    // instead of a silent last-write-wins with two ROOM_ASSIGNED audits.
    const validation = await validateRoomUnderLock(tx, {
      propertyId: reservation.propertyId,
      reservationId: reservation.id,
      roomId: room.id,
      arrivalDate: isoDate(reservation.arrivalDate),
      departureDate: isoDate(reservation.departureDate)
    });
    if (!validation.allowed) {
      throw new ConflictError(`No se puede asignar la habitación ${room.number}: ${validation.warnings.join(" ")}`);
    }
    const claimed = await tx.reservation.updateMany({
      where: { id: reservation.id, status: reservation.status, assignedRoomId: reservation.assignedRoomId },
      data: { assignedRoomId: room.id }
    });
    if (claimed.count !== 1) {
      throw new ConflictError(RESERVATION_CHANGED_MEANWHILE);
    }
    return { row: await tx.reservation.findUniqueOrThrow({ where: { id: reservation.id } }), notes: validation.notes ?? [] };
  });
  const after = await withPrimaryGuestId(updated.row);
  mirrorReservation(after);
  // Informative remarks (e.g. the room was flagged `occupied` with nobody in
  // house) travel with the response, the audit and the event so the front
  // desk sees them — stdout is not a UI.
  const assignmentNotes = updated.notes;

  recordAuditEvent({
    organizationId: input.context.organizationId,
    propertyId: reservation.propertyId,
    actorUserId: input.context.userId,
    actorType: "user",
    action: "ROOM_ASSIGNED",
    entityType: "reservation",
    entityId: after.id,
    beforeJson: before,
    afterJson: assignmentNotes.length > 0 ? { ...after, assignmentNotes } : after,
    deviceId: input.context.deviceId,
    correlationId: input.correlationId
  });

  recordDomainEvent({
    organizationId: input.context.organizationId,
    propertyId: reservation.propertyId,
    entityType: "reservation",
    entityId: after.id,
    eventType: "RoomAssigned",
    payload: { roomId: room.id, roomNumber: room.number, ...(assignmentNotes.length > 0 ? { assignmentNotes } : {}) },
    actorType: "user",
    actorUserId: input.context.userId,
    correlationId: input.correlationId
  });

  return assignmentNotes.length > 0 ? { ...after, assignmentNotes } : after;
}

/**
 * Room move for an in-house (checked_in) reservation — REC-03. One transaction:
 *   - reservation.assignedRoomId → new room
 *   - new room → occupied (housekeepingStatus untouched, same rule as check-in)
 *   - old room → dirty/dirty + departure_clean HK task (deduped per room),
 *     exactly what a check-out does
 *   - the open Stay is re-pointed IN PLACE (a new Stay row would double-count
 *     ShiftManager.checkInsToday, which counts Stays with checkinAt today)
 * The trail is the ROOM_ASSIGNED audit + RoomAssigned (compat) + RoomMoved events.
 * Caller has already validated permissions and tenancy; canAssignRoom runs
 * here, inside the transaction and under the target room's row lock.
 *
 * Race safety (REC-03): both writes are CONDITIONAL. The reservation only
 * moves if it is still checked_in on the room we read, and the target room
 * only flips to occupied if it was not already (unless the fresh validation
 * saw it `occupied` with nobody in house — the orphan-status case — or held
 * by this same reservation). Two simultaneous moves therefore end as one 200
 * and one 409, never as two 200s with an orphan `occupied` room.
 */
async function moveInHouseReservation(input: {
  context: UserContext;
  reservation: ReservationRow;
  toRoom: RoomRow;
  correlationId: string;
}): Promise<ReservationRecord> {
  const { reservation, toRoom } = input;
  const fromRoom = reservation.assignedRoomId
    ? await prisma.room.findUnique({ where: { id: reservation.assignedRoomId } })
    : null;
  const before = {
    reservation: await withPrimaryGuestId(reservation),
    fromRoom: fromRoom ? mapRoom(fromRoom) : undefined,
    toRoom: mapRoom(toRoom)
  };

  const moved = await prisma.$transaction(async (tx) => {
    const validation = await validateRoomUnderLock(tx, {
      propertyId: reservation.propertyId,
      reservationId: reservation.id,
      roomId: toRoom.id,
      arrivalDate: isoDate(reservation.arrivalDate),
      departureDate: isoDate(reservation.departureDate)
    });
    if (!validation.allowed) {
      throw new ConflictError(`No se puede asignar la habitación ${toRoom.number}: ${validation.warnings.join(" ")}`);
    }
    const claimed = await tx.reservation.updateMany({
      where: { id: reservation.id, status: "checked_in", assignedRoomId: reservation.assignedRoomId },
      data: { assignedRoomId: toRoom.id }
    });
    if (claimed.count !== 1) {
      throw new ConflictError(RESERVATION_CHANGED_MEANWHILE);
    }
    const occupied = await tx.room.updateMany({
      where: { id: toRoom.id, ...(validation.roomStatus === "occupied" ? {} : { status: { not: "occupied" } }) },
      data: { status: "occupied" }
    });
    if (occupied.count !== 1) {
      throw new ConflictError(ROOM_JUST_OCCUPIED);
    }
    const updatedReservation = await tx.reservation.findUniqueOrThrow({ where: { id: reservation.id } });
    const updatedToRoom = await tx.room.findUniqueOrThrow({ where: { id: toRoom.id } });
    const updatedFromRoom = fromRoom
      ? await tx.room.update({ where: { id: fromRoom.id }, data: { status: "dirty", housekeepingStatus: "dirty" } })
      : null;
    const housekeeping = fromRoom
      ? await createSystemHousekeepingTask({
          db: tx,
          organizationId: input.context.organizationId,
          propertyId: reservation.propertyId,
          roomId: fromRoom.id,
          taskType: "departure_clean",
          priority: "high",
          actorUserId: input.context.userId,
          reason: `Room move ${reservation.code}: ${fromRoom.number} → ${toRoom.number}.`,
          correlationId: input.correlationId
        })
      : null;
    const stays = await tx.stay.updateMany({
      where: { reservationId: reservation.id, checkoutAt: null },
      data: { roomId: toRoom.id }
    });
    return { updatedReservation, updatedToRoom, updatedFromRoom, housekeeping, staysUpdated: stays.count, notes: validation.notes ?? [] };
  });

  const after = await withPrimaryGuestId(moved.updatedReservation);
  const afterToRoom = mapRoom(moved.updatedToRoom);
  const afterFromRoom = moved.updatedFromRoom ? mapRoom(moved.updatedFromRoom) : undefined;
  mirrorReservation(after);
  mirrorRoom(afterToRoom);
  if (afterFromRoom) mirrorRoom(afterFromRoom);

  recordAuditEvent({
    organizationId: input.context.organizationId,
    propertyId: reservation.propertyId,
    actorUserId: input.context.userId,
    actorType: "user",
    action: "ROOM_ASSIGNED",
    entityType: "reservation",
    entityId: after.id,
    beforeJson: before,
    afterJson: {
      reservation: after,
      fromRoom: afterFromRoom,
      toRoom: afterToRoom,
      housekeepingTaskId: moved.housekeeping?.task.id ?? null,
      housekeepingTaskCreated: moved.housekeeping?.created ?? false,
      staysUpdated: moved.staysUpdated,
      ...(moved.notes.length > 0 ? { assignmentNotes: moved.notes } : {})
    },
    deviceId: input.context.deviceId,
    correlationId: input.correlationId
  });

  const eventBase = {
    organizationId: input.context.organizationId,
    propertyId: reservation.propertyId,
    entityType: "reservation",
    entityId: after.id,
    actorType: "user" as const,
    actorUserId: input.context.userId,
    correlationId: input.correlationId
  };
  recordDomainEvent({
    ...eventBase,
    eventType: "RoomAssigned",
    payload: { roomId: toRoom.id, roomNumber: toRoom.number }
  });
  recordDomainEvent({
    ...eventBase,
    eventType: "RoomMoved",
    payload: {
      fromRoomId: fromRoom?.id ?? null,
      fromRoomNumber: fromRoom?.number ?? null,
      toRoomId: toRoom.id,
      toRoomNumber: toRoom.number,
      housekeepingTaskId: moved.housekeeping?.task.id ?? null,
      housekeepingTaskCreated: moved.housekeeping?.created ?? false,
      staysUpdated: moved.staysUpdated
    }
  });

  return moved.notes.length > 0 ? { ...after, assignmentNotes: moved.notes } : after;
}

export async function assignRoomByNumber(input: {
  context: UserContext;
  reservationId: string;
  roomNumber: string;
  correlationId: string;
}): Promise<ReservationRecord> {
  const reservation = await prisma.reservation.findUnique({ where: { id: input.reservationId } });
  if (!reservation) {
    throw new NotFoundError("Reserva no encontrada.");
  }
  const room = await prisma.room.findUnique({
    where: { propertyId_number: { propertyId: reservation.propertyId, number: input.roomNumber } }
  });
  if (!room) {
    throw new NotFoundError(`Habitación ${input.roomNumber} no encontrada.`);
  }

  return assignRoom({
    context: input.context,
    reservationId: input.reservationId,
    roomId: room.id,
    correlationId: input.correlationId
  });
}

// Check-in date window (REC-10): arrivalDate may differ from the business
// date by at most this many days (late arrival after midnight / early check-in
// the day before) without an explicit override.
const CHECK_IN_WINDOW_DAYS = 1;

export type CheckInWindow = {
  /** Reference "today": max(business date, property-local today) so an unclosed night audit never anchors it. */
  businessDate: string;
  arrivalDate: string;
  /** arrivalDate − businessDate in days: > 0 early check-in, < 0 late arrival. */
  offsetDays: number;
  withinWindow: boolean;
  dateOverride: boolean;
};

export async function checkInReservation(input: {
  context: UserContext;
  reservationId: string;
  roomId: string;
  signatureObjectKey: string;
  /** Override the ±1 day window; requires pms.reservation.modify on top of pms.checkin.execute. */
  allowEarlyCheckIn?: boolean;
  overrideReason?: string;
  correlationId: string;
}): Promise<ReservationRecord> {
  requirePermissions(input.context, ["pms.checkin.execute"]);

  const reservation = await prisma.reservation.findUnique({ where: { id: input.reservationId } });
  const room = await prisma.room.findUnique({ where: { id: input.roomId } });
  if (!reservation || !room) {
    throw new NotFoundError("Reserva o habitación no encontrada.");
  }
  if (room.propertyId !== reservation.propertyId) {
    // NUEVO-ROOM-ORACLE: same opaque 404 as assign-room for a room of another property.
    throw new NotFoundError("Reserva o habitación no encontrada.");
  }
  if (reservation.status !== "confirmed") {
    throw new ConflictError(`La reserva ${reservation.code} no está lista para el check-in (estado: ${reservation.status}).`);
  }

  // REC-10: validate the arrival date against the property's business date
  // (lazily initialised by night-audit.service). The business date only moves
  // when the night audit closes, so we take the later of it and the property's
  // local today; otherwise a property that never runs the audit would reject
  // every check-in from the second day on.
  const businessDate = await getCurrentBusinessDate(reservation.propertyId);
  const property = await prisma.property.findUnique({ where: { id: reservation.propertyId }, select: { timezone: true } });
  const localToday = todayInTimezone(property?.timezone ?? "UTC");
  const referenceDate = businessDate > localToday ? businessDate : localToday;
  const arrivalIso = isoDate(reservation.arrivalDate);
  const offsetDays = daysBetween(referenceDate, arrivalIso);
  const withinWindow = Math.abs(offsetDays) <= CHECK_IN_WINDOW_DAYS;
  if (!withinWindow && !input.allowEarlyCheckIn) {
    throw withDetails(
      new ConflictError(
        `La reserva ${reservation.code} tiene llegada el ${arrivalIso} y la fecha de negocio es ${referenceDate}: ` +
          `el check-in solo se admite con ±${CHECK_IN_WINDOW_DAYS} día de margen. ` +
          `Repite con allowEarlyCheckIn:true (requiere el permiso pms.reservation.modify) para forzarlo.`
      ),
      { code: "CHECK_IN_DATE_OUT_OF_RANGE", arrivalDate: arrivalIso, businessDate: referenceDate, offsetDays }
    );
  }
  if (!withinWindow) {
    requirePermissions(input.context, ["pms.reservation.modify"]);
    // REC-09 (defence in depth — CheckInSchema already enforces it): an
    // out-of-window override is an audited exception and must carry a reason.
    if (!input.overrideReason?.trim()) {
      throw new BadRequestError("Indica el motivo del check-in fuera de ventana.");
    }
  }
  const checkInWindow: CheckInWindow = {
    businessDate: referenceDate,
    arrivalDate: arrivalIso,
    offsetDays,
    withinWindow,
    dateOverride: !withinWindow
  };

  const before = {
    reservation: await withPrimaryGuestId(reservation),
    room: mapRoom(room)
  };

  // REC-03 (same pattern as the room move): validate under the room row lock
  // and write conditionally, so two simultaneous check-ins into one room (or
  // two check-ins of the same reservation) end as one 200 and one 409.
  const { updatedReservation, updatedRoom } = await prisma.$transaction(async (tx) => {
    const validation = await validateRoomUnderLock(tx, {
      propertyId: reservation.propertyId,
      reservationId: reservation.id,
      roomId: room.id,
      arrivalDate: isoDate(reservation.arrivalDate),
      departureDate: isoDate(reservation.departureDate)
    });
    if (!validation.allowed) {
      throw new ConflictError(`No se puede hacer el check-in en la habitación ${room.number}: ${validation.warnings.join(" ")}`);
    }
    const claimed = await tx.reservation.updateMany({
      where: { id: reservation.id, status: "confirmed" },
      data: { status: "checked_in", assignedRoomId: room.id }
    });
    if (claimed.count !== 1) {
      throw new ConflictError(`La reserva ${reservation.code} ha cambiado de estado mientras se procesaba el check-in; recarga y vuelve a intentarlo.`);
    }
    const occupied = await tx.room.updateMany({
      where: { id: room.id, ...(validation.roomStatus === "occupied" ? {} : { status: { not: "occupied" } }) },
      // Fase 0: do NOT force housekeepingStatus:"clean" — preserve the room's
      // prior state. The room is now occupied; housekeeping state is owned by HK.
      data: { status: "occupied" }
    });
    if (occupied.count !== 1) {
      throw new ConflictError(ROOM_JUST_OCCUPIED);
    }
    // Fase 0: persist the Stay so ShiftManager.checkInsToday (which counts Stays
    // with checkinAt today, shift-manager.service.ts:83) stops always showing 0.
    await tx.stay.create({
      data: { reservationId: reservation.id, roomId: room.id, checkinAt: new Date(), status: "in_house" }
    });
    return {
      updatedReservation: await tx.reservation.findUniqueOrThrow({ where: { id: reservation.id } }),
      updatedRoom: await tx.room.findUniqueOrThrow({ where: { id: room.id } })
    };
  });

  const afterReservation = await withPrimaryGuestId(updatedReservation);
  const afterRoom = mapRoom(updatedRoom);
  mirrorReservation(afterReservation);
  mirrorRoom(afterRoom);

  recordAuditEvent({
    organizationId: input.context.organizationId,
    propertyId: input.context.propertyId,
    actorUserId: input.context.userId,
    actorType: "user",
    action: "GUEST_CHECKED_IN",
    entityType: "reservation",
    entityId: afterReservation.id,
    beforeJson: before,
    afterJson: {
      reservation: afterReservation,
      room: afterRoom,
      checkInWindow: { ...checkInWindow, overrideReason: input.overrideReason ?? null }
    },
    deviceId: input.context.deviceId,
    correlationId: input.correlationId
  });

  recordDomainEvent({
    organizationId: input.context.organizationId,
    propertyId: input.context.propertyId,
    entityType: "reservation",
    entityId: afterReservation.id,
    eventType: "GuestCheckedIn",
    payload: {
      roomId: afterRoom.id,
      roomNumber: afterRoom.number,
      signatureObjectKey: input.signatureObjectKey,
      businessDate: checkInWindow.businessDate,
      arrivalOffsetDays: checkInWindow.offsetDays,
      dateOverride: checkInWindow.dateOverride
    },
    actorType: "user",
    actorUserId: input.context.userId,
    correlationId: input.correlationId
  });

  return afterReservation;
}

// Balances below this are rounding noise, not a debt (folio.service rounds to cents).
const BALANCE_DUE_EPSILON = 0.005;

export type CheckOutFolioOutcome = {
  id: string;
  label: string | null;
  isPrimary: boolean;
  currency: string;
  balanceDue: number;
  /**
   * Status after the check-out. Secondary folios with a zero balance are
   * closed here; the primary one is closed by the route (closeFolio, audited
   * FOLIO_CLOSED) exactly as before; a folio with a balance stays open.
   */
  status: "open" | "closed";
  /** True when THIS check-out closed the folio. */
  closedNow: boolean;
};

export type CheckOutResult = {
  reservation: ReservationRecord;
  /** REC-08: balance due aggregated over ALL folios of the reservation. */
  balanceDue: number;
  balanceAcknowledged: boolean;
  folios: CheckOutFolioOutcome[];
  /** Non-blocking remarks for the client (e.g. secondary folios left open with a balance). */
  warnings: string[];
};

export type CheckOutReservationInput = {
  context: UserContext;
  reservationId: string;
  /** REC-08: proceed although a folio still has a balance due (the client confirmed it). */
  acknowledgeBalance?: boolean;
  correlationId: string;
};

/**
 * Check-out (REC-08). The balance gate looks at EVERY folio of the reservation
 * (guest + company + any split), not just the first row: a paid guest folio
 * with an unpaid company folio is still a debt walking out of the door.
 *   - balance due > 0 and not acknowledged → 409 BALANCE_DUE (nothing mutated)
 *   - secondary folios open with zero balance → closed in the same transaction
 *   - secondary folios open with a balance (acknowledged) → left open, listed
 *     in `warnings`
 *   - the primary folio is left to the route, which closes it with closeFolio
 *     when its own balance is zero (unchanged behaviour)
 */
export async function checkOutReservationDetailed(input: CheckOutReservationInput): Promise<CheckOutResult> {
  requirePermissions(input.context, ["pms.checkout.execute"]);

  const reservation = await prisma.reservation.findUnique({ where: { id: input.reservationId } });
  if (!reservation) {
    throw new NotFoundError("Reserva no encontrada.");
  }
  if (reservation.status !== "checked_in") {
    throw new ConflictError(`La reserva ${reservation.code} no tiene el check-in hecho (estado: ${reservation.status}).`);
  }

  // REC-08: BEFORE mutating anything, refuse a check-out that would leave an
  // unpaid folio unless the caller acknowledged it. `getReservationBalance`
  // aggregates captured payments vs posted lines across all the folios of the
  // reservation; a reservation without folios has nothing to collect.
  const [balance, folioRows] = await Promise.all([
    getReservationBalance(reservation.id),
    prisma.folio.findMany({
      where: { reservationId: reservation.id, deletedAt: null },
      select: { id: true, label: true, isPrimary: true, status: true, currency: true, guestId: true },
      orderBy: [{ isPrimary: "desc" }, { id: "asc" }]
    })
  ]);
  const balanceById = new Map(balance.folios.map((f) => [f.id, f.balanceDue] as const));
  const primaryFolio = folioRows.find((f) => f.isPrimary) ?? folioRows[0] ?? null;
  const balanceDue = balance.balanceDue;
  const folioSummaries = folioRows.map((f) => ({
    id: f.id,
    label: f.label,
    isPrimary: f.isPrimary,
    currency: f.currency,
    status: f.status,
    balanceDue: balanceById.get(f.id) ?? 0
  }));
  if (balanceDue > BALANCE_DUE_EPSILON && !input.acknowledgeBalance) {
    const pending = folioSummaries.filter((f) => f.balanceDue > BALANCE_DUE_EPSILON);
    const detail = pending.map((f) => `${f.label ?? "folio"} ${formatEur(f.balanceDue)} €`).join(", ");
    throw withDetails(
      new ConflictError(
        `Saldo pendiente de ${formatEur(balanceDue)} € en la reserva ${reservation.code}` +
          (pending.length > 1 ? ` (${detail})` : "") +
          `: cobra el saldo o confirma el check-out con saldo pendiente (acknowledgeBalance).`
      ),
      {
        code: "BALANCE_DUE",
        balanceDue,
        currency: primaryFolio?.currency ?? null,
        folioId: primaryFolio?.id ?? null,
        folios: folioSummaries.map(({ id, label, isPrimary, status, balanceDue: due }) => ({ id, label, isPrimary, status, balanceDue: due }))
      }
    );
  }
  const balanceAcknowledged = balanceDue > BALANCE_DUE_EPSILON && input.acknowledgeBalance === true;

  // Secondary folios: settled ones close with the stay; unsettled ones stay
  // open (the acknowledged debt must remain collectable) and are reported.
  const secondaryOpen = folioSummaries.filter((f) => !f.isPrimary && f.status === "open");
  const secondariesToClose = secondaryOpen.filter((f) => Math.abs(f.balanceDue) < BALANCE_DUE_EPSILON);
  const secondariesLeftOpen = secondaryOpen.filter((f) => f.balanceDue > BALANCE_DUE_EPSILON);
  const warnings = secondariesLeftOpen.map(
    (f) => `El folio "${f.label ?? f.id}" queda abierto con saldo pendiente de ${formatEur(f.balanceDue)} €.`
  );

  const room = reservation.assignedRoomId
    ? await prisma.room.findUnique({ where: { id: reservation.assignedRoomId } })
    : null;

  const before = {
    reservation: await withPrimaryGuestId(reservation),
    room: room ? mapRoom(room) : undefined
  };

  const closeIds = secondariesToClose.map((f) => f.id);
  const outcome = await prisma.$transaction(async (tx) => {
    // Conditional: the check-out only lands if the guest is still in house
    // (two simultaneous check-outs → one 200, one 409, one GUEST_CHECKED_OUT).
    const claimed = await tx.reservation.updateMany({
      where: { id: reservation.id, status: "checked_in" },
      data: { status: "checked_out" }
    });
    if (claimed.count !== 1) {
      throw new ConflictError(`La reserva ${reservation.code} ya no está alojada; recarga y vuelve a intentarlo.`);
    }
    const updatedReservation = await tx.reservation.findUniqueOrThrow({ where: { id: reservation.id } });
    const updatedRoom = room
      ? await tx.room.update({ where: { id: room.id }, data: { status: "dirty", housekeepingStatus: "dirty" } })
      : null;
    // Fase 0: close the open Stay so ShiftManager.checkOutsToday (Stays with
    // checkoutAt today, shift-manager.service.ts:91) reflects real check-outs.
    await tx.stay.updateMany({
      where: { reservationId: reservation.id, checkoutAt: null },
      data: { checkoutAt: new Date(), status: "checked_out" }
    });
    const closedSecondaries = closeIds.length > 0
      ? await tx.folio.updateMany({ where: { id: { in: closeIds }, status: "open" }, data: { status: "closed" } })
      : { count: 0 };
    return { updatedReservation, updatedRoom, closedSecondaries: closedSecondaries.count };
  });

  const afterReservation = await withPrimaryGuestId(outcome.updatedReservation);
  const afterRoom = outcome.updatedRoom ? mapRoom(outcome.updatedRoom) : undefined;
  mirrorReservation(afterReservation);
  if (afterRoom) mirrorRoom(afterRoom);

  const folios: CheckOutFolioOutcome[] = folioSummaries.map((f) => {
    const closedNow = closeIds.includes(f.id);
    return {
      id: f.id,
      label: f.label,
      isPrimary: f.isPrimary,
      currency: f.currency,
      balanceDue: f.balanceDue,
      status: closedNow ? "closed" : f.status,
      closedNow
    };
  });
  for (const closed of folios.filter((f) => f.closedNow)) {
    const row = folioRows.find((f) => f.id === closed.id);
    mirrorFolioStub({
      id: closed.id,
      reservationId: reservation.id,
      guestId: row?.guestId ?? undefined,
      status: "closed",
      currency: closed.currency
    });
    // Same trail closeFolio leaves, so a secondary folio closed by the
    // check-out is not an unexplained status flip in the activity log.
    recordAuditEvent({
      organizationId: input.context.organizationId,
      propertyId: reservation.propertyId,
      actorUserId: input.context.userId,
      actorType: "user",
      action: "FOLIO_CLOSED",
      entityType: "folio",
      entityId: closed.id,
      beforeJson: { id: closed.id, label: closed.label, status: "open", balanceDue: closed.balanceDue },
      afterJson: { id: closed.id, label: closed.label, status: "closed", balanceDue: closed.balanceDue, closedBy: "check-out" },
      deviceId: input.context.deviceId,
      correlationId: input.correlationId
    });
  }

  recordAuditEvent({
    organizationId: input.context.organizationId,
    propertyId: reservation.propertyId,
    actorUserId: input.context.userId,
    actorType: "user",
    action: "GUEST_CHECKED_OUT",
    entityType: "reservation",
    entityId: afterReservation.id,
    beforeJson: before,
    afterJson: {
      reservation: afterReservation,
      room: afterRoom,
      folio: { id: primaryFolio?.id ?? null, balanceDue, balanceAcknowledged },
      folios,
      warnings
    },
    deviceId: input.context.deviceId,
    correlationId: input.correlationId
  });

  recordDomainEvent({
    organizationId: input.context.organizationId,
    propertyId: reservation.propertyId,
    entityType: "reservation",
    entityId: afterReservation.id,
    eventType: "GuestCheckedOut",
    payload: {
      roomId: afterRoom?.id,
      roomNumber: afterRoom?.number,
      balanceDue,
      balanceAcknowledged,
      foliosClosed: closeIds,
      foliosLeftOpen: secondariesLeftOpen.map((f) => f.id)
    },
    actorType: "user",
    actorUserId: input.context.userId,
    correlationId: input.correlationId
  });

  return { reservation: afterReservation, balanceDue, balanceAcknowledged, folios, warnings };
}

/** Compat wrapper: same contract as before (the reservation record). See checkOutReservationDetailed. */
export async function checkOutReservation(input: CheckOutReservationInput): Promise<ReservationRecord> {
  return (await checkOutReservationDetailed(input)).reservation;
}

export async function transitionReservation(input: {
  context: UserContext;
  reservationId: string;
  status: Extract<ReservationStatus, "cancelled" | "no_show">;
  reason?: string;
  correlationId: string;
}): Promise<ReservationRecord> {
  requirePermissions(input.context, ["pms.reservation.modify"]);

  const reservation = await prisma.reservation.findUnique({ where: { id: input.reservationId } });
  if (!reservation) {
    throw new NotFoundError("Reserva no encontrada.");
  }
  if (["checked_in", "checked_out"].includes(reservation.status)) {
    throw new ConflictError(`La reserva ${reservation.code} no se puede pasar a ${input.status} estando ${reservation.status}.`);
  }

  const before = await withPrimaryGuestId(reservation);
  const updated = await prisma.reservation.update({
    where: { id: reservation.id },
    data: { status: input.status }
  });
  const after = await withPrimaryGuestId(updated);
  mirrorReservation(after);

  // SES.HOSPEDAJES baja (RD 933/2021): a stay the MIR already holds must be
  // revoked when the reservation is cancelled or no-shows. Best effort AFTER
  // the status is persisted: the cancellation never fails because of SES — a
  // failure is logged with correlation and audited (SES_BAJA_QUEUE_FAILED) so
  // the compliance inbox / scheduler pick it up.
  let sesBaja: Awaited<ReturnType<typeof queueSesBajaForReservation>> | null = null;
  try {
    sesBaja = await queueSesBajaForReservation({ context: input.context, reservationId: reservation.id, correlationId: input.correlationId });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[pms] SES baja could not be queued for reservation ${reservation.id} (${input.status}, correlation ${input.correlationId}): ${message}`);
    recordAuditEvent({
      organizationId: input.context.organizationId,
      propertyId: reservation.propertyId,
      actorUserId: input.context.userId,
      actorType: "system",
      action: "SES_BAJA_QUEUE_FAILED",
      entityType: "reservation",
      entityId: reservation.id,
      afterJson: { status: input.status, error: message },
      correlationId: input.correlationId
    });
  }

  recordAuditEvent({
    organizationId: input.context.organizationId,
    propertyId: reservation.propertyId,
    actorUserId: input.context.userId,
    actorType: "user",
    action: input.status === "cancelled" ? "RESERVATION_CANCELLED" : "RESERVATION_NO_SHOW",
    entityType: "reservation",
    entityId: after.id,
    beforeJson: before,
    afterJson: { ...after, reason: input.reason, sesBaja },
    deviceId: input.context.deviceId,
    correlationId: input.correlationId
  });

  recordDomainEvent({
    organizationId: input.context.organizationId,
    propertyId: reservation.propertyId,
    entityType: "reservation",
    entityId: after.id,
    eventType: input.status === "cancelled" ? "ReservationCancelled" : "ReservationNoShow",
    payload: { code: after.code, reason: input.reason, sesBaja },
    actorType: "user",
    actorUserId: input.context.userId,
    correlationId: input.correlationId
  });

  return after;
}

// REC-09: a quote must say where its price comes from. When the rate grid
// (RateDay) has no price for one or more nights the total is completed with
// FALLBACK_NIGHTLY_RATE and the item is flagged `priceSource: "fallback"` with
// `nightsWithoutRate` / `fallbackNightly` so clients can warn instead of
// presenting an invented price as a published rate.
const FALLBACK_NIGHTLY_RATE = 136;

export type AvailabilityQuoteItem = {
  roomTypeId: string;
  roomTypeName: string;
  availableRooms: number;
  currency: string;
  totalAmount: number;
  /** "rate_plan": every night priced from RateDay; "fallback": at least one night used FALLBACK_NIGHTLY_RATE. */
  priceSource: "rate_plan" | "fallback";
  nights: number;
  nightsWithoutRate: number;
  /** The per-night fallback actually applied, null when every night had a published rate. */
  fallbackNightly: number | null;
  cancellationPolicy: string;
};

/**
 * Body: QuoteAvailabilitySchema (schemas/reservations.schemas.ts). `roomTypeId`
 * narrows the quote to one room type; `ratePlanId` prices only from that rate
 * plan's grid (nights it does not publish fall back as usual). Both optional.
 */
export async function quoteAvailability(input: {
  propertyId: string;
  arrivalDate: string;
  departureDate: string;
  adults: number;
  children?: number;
  roomTypeId?: string;
  ratePlanId?: string;
}): Promise<AvailabilityQuoteItem[]> {
  if (!isIsoDateString(input.arrivalDate) || !isIsoDateString(input.departureDate)) {
    throw new BadRequestError("Las fechas de llegada y salida deben tener formato YYYY-MM-DD.");
  }
  if (input.arrivalDate >= input.departureDate) {
    throw new BadRequestError("La fecha de salida debe ser posterior a la fecha de llegada.");
  }
  const requiredOccupancy = input.adults + (input.children ?? 0);
  const arrival = dateOnly(input.arrivalDate);
  const departure = dateOnly(input.departureDate);

  const roomTypes = await prisma.roomType.findMany({
    where: {
      propertyId: input.propertyId,
      maxOccupancy: { gte: requiredOccupancy },
      active: true,
      ...(input.roomTypeId ? { id: input.roomTypeId } : {})
    }
  });
  // A typo in roomTypeId/ratePlanId must not quote the fallback price: an id
  // that does not exist in this property is a 404, an existing type that just
  // cannot host the party is an empty quote.
  if (input.roomTypeId && roomTypes.length === 0) {
    const exists = await prisma.roomType.findFirst({ where: { id: input.roomTypeId, propertyId: input.propertyId }, select: { id: true } });
    if (!exists) throw new NotFoundError("Tipo de habitación no encontrado.");
  }
  if (input.ratePlanId) {
    const plan = await prisma.ratePlan.findFirst({ where: { id: input.ratePlanId, propertyId: input.propertyId }, select: { id: true } });
    if (!plan) throw new NotFoundError("Plan de tarifas no encontrado.");
  }

  return Promise.all(
    roomTypes.map(async (roomType) => {
      const totalRooms = await prisma.room.count({
        where: {
          propertyId: input.propertyId,
          roomTypeId: roomType.id,
          sellable: true,
          maintenanceStatus: { not: "blocked" }
        }
      });
      // OVERSELL FIX: availability must subtract the rooms of ALL overlapping
      // active reservations for the room type — including confirmed reservations
      // that have not been assigned a physical room yet. Previously only
      // reservations with a non-null assignedRoomId were counted, so unassigned
      // bookings consumed zero inventory and the property could be oversold.
      // Sum roomsCount (not rows): a multi-room booking consumes several units.
      const overlapping = await prisma.reservation.aggregate({
        _sum: { roomsCount: true },
        where: {
          propertyId: input.propertyId,
          roomTypeId: roomType.id,
          status: { in: ["confirmed", "checked_in"] },
          arrivalDate: { lt: departure },
          departureDate: { gt: arrival }
        }
      });
      const bookedRooms = overlapping._sum.roomsCount ?? 0;
      const available = Math.max(0, totalRooms - bookedRooms);

      // PRICING: read the real rate grid (RateDay) for this room type over the
      // stay. Per night we take the lowest published price across rate plans.
      // Nights without a published rate use FALLBACK_NIGHTLY_RATE and are
      // reported explicitly (priceSource / nightsWithoutRate).
      const nights = nightsBetween(input.arrivalDate, input.departureDate);
      const rateDays = await prisma.rateDay.findMany({
        where: {
          propertyId: input.propertyId,
          roomTypeId: roomType.id,
          date: { gte: arrival, lt: departure },
          ...(input.ratePlanId ? { ratePlanId: input.ratePlanId } : {})
        },
        select: { date: true, price: true, currency: true }
      });
      const minPriceByDate = new Map<string, number>();
      let currency = "EUR";
      for (const rd of rateDays) {
        const key = rd.date.toISOString().slice(0, 10);
        const price = dec(rd.price);
        if (!minPriceByDate.has(key) || price < (minPriceByDate.get(key) as number)) minPriceByDate.set(key, price);
        currency = rd.currency || currency;
      }
      let totalAmount = 0;
      let nightsWithoutRate = 0;
      for (let i = 0; i < nights; i++) {
        const d = new Date(arrival.getTime() + i * 86_400_000).toISOString().slice(0, 10);
        const published = minPriceByDate.get(d);
        if (published === undefined) nightsWithoutRate += 1;
        totalAmount += published ?? FALLBACK_NIGHTLY_RATE;
      }

      return {
        roomTypeId: roomType.id,
        roomTypeName: roomType.name,
        availableRooms: available,
        currency,
        totalAmount: Math.round(totalAmount * 100) / 100,
        priceSource: nightsWithoutRate > 0 ? "fallback" : "rate_plan",
        nights,
        nightsWithoutRate,
        fallbackNightly: nightsWithoutRate > 0 ? FALLBACK_NIGHTLY_RATE : null,
        cancellationPolicy: "Flexible until 18:00 the day before arrival"
      };
    })
  );
}

function nightsBetween(arrivalDate: string, departureDate: string): number {
  const arrival = new Date(`${arrivalDate}T00:00:00.000Z`);
  const departure = new Date(`${departureDate}T00:00:00.000Z`);
  return Math.max(1, Math.round((departure.getTime() - arrival.getTime()) / 86_400_000));
}
