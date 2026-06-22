import type { GuestIdentityFields } from "@hotelos/shared";
import type { ReservationStatus } from "@hotelos/shared";
import { prisma } from "@hotelos/database";
import type { Prisma } from "@hotelos/database";
import { BadRequestError, ConflictError, NotFoundError } from "../../lib/http-error.js";
import {
  demoStore,
  type GuestRecord,
  type ReservationRecord,
  type RoomRecord,
  type RoomTypeRecord,
  type UserContext
} from "../../lib/demo-store.js";
import { recordAuditEvent, recordDomainEvent } from "../audit/audit.service.js";
import { requirePermissions } from "../auth/auth.service.js";
import { canAssignRoom } from "./inventory.engine.js";

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
    primaryGuestId: row.primaryGuestId ?? undefined
  };
}

async function withPrimaryGuestId(row: NonNullable<Awaited<ReturnType<typeof prisma.reservation.findUnique>>>): Promise<ReservationRecord> {
  const primary = await prisma.reservationGuest.findFirst({
    where: { reservationId: row.id, isPrimary: true },
    select: { guestId: true }
  });
  return mapReservation(Object.assign(row, { primaryGuestId: primary?.guestId }));
}

export async function listRooms(propertyId: string, options?: { limit?: number }): Promise<RoomRecord[]> {
  // Pagination guard rail: default 100, caller may override within [1, 500].
  const rawLimit = options?.limit;
  const take = Number.isFinite(rawLimit as number)
    ? Math.min(500, Math.max(1, Math.floor(rawLimit as number)))
    : 100;
  const rows = await prisma.room.findMany({
    where: { propertyId },
    orderBy: { number: "asc" },
    take
  });
  return rows.map(mapRoom);
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
    throw new NotFoundError(`Property ${propertyId} not found.`);
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
    throw new Error(`Room ${input.number} already exists.`);
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

export async function listReservations(propertyId: string, options?: { limit?: number }): Promise<ReservationRecord[]> {
  // Pagination: default 100, accept caller-provided limit clamped to [1, 500].
  const rawLimit = options?.limit;
  const take = Number.isFinite(rawLimit as number)
    ? Math.min(500, Math.max(1, Math.floor(rawLimit as number)))
    : 100;
  const rows = await prisma.reservation.findMany({
    where: { propertyId },
    orderBy: { arrivalDate: "asc" },
    take
  });
  return Promise.all(rows.map(withPrimaryGuestId));
}

export async function getReservation(id: string): Promise<ReservationRecord> {
  const row = await prisma.reservation.findUnique({ where: { id } });
  if (!row) {
    throw new Error("Reservation was not found.");
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
      throw new NotFoundError(`Property ${input.propertyId} not found.`);
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
    // (property, roomType) so the count below cannot race with a parallel
    // create; the lock releases automatically when the transaction ends and
    // only serializes bookings for the SAME room type.
    if (input.roomTypeId) {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${input.propertyId}), hashtext(${input.roomTypeId}))`;

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
      const overlapping = await tx.reservation.count({
        where: {
          propertyId: input.propertyId,
          roomTypeId: input.roomTypeId,
          status: { in: ["confirmed", "checked_in"] },
          arrivalDate: { lt: departure },
          departureDate: { gt: arrival }
        }
      });
      const requested = input.roomsCount ?? 1;
      if (overlapping + requested > totalRooms) {
        throw new ConflictError(
          `No hay disponibilidad para el tipo de habitación seleccionado en esas fechas ` +
            `(${totalRooms} habitaciones, ${overlapping} ya reservadas).`
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

export async function patchReservation(input: {
  context: UserContext;
  reservationId: string;
  patch: Partial<Pick<ReservationRecord, "arrivalDate" | "departureDate" | "adults" | "children" | "roomTypeId" | "totalAmount" | "status">> & {
    assignedRoomId?: string | null;
    roomId?: string | null;
    vipFlag?: boolean;
    masterFolioId?: string | null;
  };
  correlationId: string;
}): Promise<ReservationRecord> {
  requirePermissions(input.context, ["pms.reservation.modify"]);

  const existing = await prisma.reservation.findUnique({ where: { id: input.reservationId } });
  if (!existing) {
    throw new Error("Reservation was not found.");
  }
  // SECURITY (audit 2026-06 R2 · NUEVO-1): the reservation's property must belong
  // to the caller's org, or a user in org A could patch org B's reservation by id.
  await assertPropertyInOrg(existing.propertyId, input.context.organizationId);
  if (["checked_in", "checked_out", "cancelled", "no_show"].includes(existing.status)) {
    throw new Error(`Reservation ${existing.code} cannot be modified while ${existing.status}.`);
  }

  const before = await withPrimaryGuestId(existing);
  // Snapshot pre-update critical fields for fine-grained audit emission below.
  const beforeArrival = before.arrivalDate;
  const beforeDeparture = before.departureDate;
  const beforeStatus = before.status;
  const beforeRoomId = before.assignedRoomId ?? null;
  const beforeVipFlag = existing.vipFlag;
  // masterFolioId is not on the Reservation model directly — it lives on the
  // GroupBooking that backs corporate stays. For routing-change audit we read
  // the link via the reservation's groupBookingId so we can compare before/after.
  const beforeMasterFolioId = existing.groupBookingId
    ? (await prisma.groupBooking.findUnique({ where: { id: existing.groupBookingId }, select: { masterFolioId: true } }))?.masterFolioId ?? null
    : null;

  const nextArrival = input.patch.arrivalDate ?? before.arrivalDate;
  const nextDeparture = input.patch.departureDate ?? before.departureDate;
  if (nextArrival >= nextDeparture) {
    throw new BadRequestError("Departure date must be after arrival date.");
  }

  // Allow either `assignedRoomId` or legacy `roomId` alias.
  const nextAssignedRoomId = input.patch.assignedRoomId !== undefined
    ? input.patch.assignedRoomId
    : input.patch.roomId !== undefined
      ? input.patch.roomId
      : undefined;

  const data: Prisma.ReservationUpdateInput = {};
  if (input.patch.arrivalDate) data.arrivalDate = dateOnly(input.patch.arrivalDate);
  if (input.patch.departureDate) data.departureDate = dateOnly(input.patch.departureDate);
  if (typeof input.patch.adults === "number") data.adults = input.patch.adults;
  if (typeof input.patch.children === "number") data.children = input.patch.children;
  if (input.patch.roomTypeId) data.roomTypeId = input.patch.roomTypeId;
  if (typeof input.patch.totalAmount === "number") data.totalAmount = input.patch.totalAmount;
  if (input.patch.status) data.status = input.patch.status;
  if (nextAssignedRoomId !== undefined) data.assignedRoomId = nextAssignedRoomId;
  if (typeof input.patch.vipFlag === "boolean") data.vipFlag = input.patch.vipFlag;

  const updated = await prisma.reservation.update({ where: { id: existing.id }, data });
  const after = await withPrimaryGuestId(updated);
  mirrorReservation(after);

  // Optional: propagate masterFolioId routing change on the linked GroupBooking
  // when caller is rerouting charges. Reservation does not own the column.
  let afterMasterFolioId: string | null = beforeMasterFolioId;
  if (input.patch.masterFolioId !== undefined && existing.groupBookingId) {
    const refreshed = await prisma.groupBooking.update({
      where: { id: existing.groupBookingId },
      data: { masterFolioId: input.patch.masterFolioId },
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
    afterJson: after,
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

  if (after.status !== beforeStatus) {
    recordAuditEvent({
      organizationId: input.context.organizationId,
      propertyId: after.propertyId,
      actorUserId: input.context.userId,
      actorType: "user",
      action: "STATUS_CHANGED",
      entityType: "reservation",
      entityId: after.id,
      beforeJson: { status: beforeStatus },
      afterJson: { status: after.status },
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
    throw new Error("No matching guest was found.");
  }

  // documentNumber inside the OR is plaintext; the Prisma encryption
  // extension (packages/database/src/client.ts) rewrites it to
  // `documentNumberLookupHash` via the deterministic HMAC so equality
  // lookups still hit an index after Sprint 32 encryption.
  const guestRow = await prisma.guest.findFirst({ where: { OR: orClauses } });
  if (!guestRow) {
    throw new Error("No matching guest was found.");
  }

  const links = await prisma.reservationGuest.findMany({
    where: { guestId: guestRow.id, isPrimary: true }
  });
  if (links.length === 0) {
    throw new Error("No open reservation was found for the matched guest.");
  }

  const reservationRow = await prisma.reservation.findFirst({
    where: {
      id: { in: links.map((l) => l.reservationId) },
      propertyId: input.propertyId,
      status: { in: ["confirmed", "draft"] }
    }
  });
  if (!reservationRow) {
    throw new Error("No open reservation was found for the matched guest.");
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
    throw new Error("Reservation or room was not found.");
  }
  // SECURITY (audit 2026-06 R2 · NUEVO-1): the reservation must be in the caller's
  // org, and the room must belong to that same property — otherwise you could
  // assign another tenant's room (or operate on another tenant's reservation) by id.
  await assertPropertyInOrg(reservation.propertyId, input.context.organizationId);
  if (room.propertyId !== reservation.propertyId) {
    throw new BadRequestError("Room does not belong to the reservation's property.");
  }

  const validation = await canAssignRoom({
    propertyId: reservation.propertyId,
    reservationId: reservation.id,
    roomId: room.id,
    arrivalDate: isoDate(reservation.arrivalDate),
    departureDate: isoDate(reservation.departureDate)
  });

  if (!validation.allowed) {
    throw new Error(validation.warnings.join(" "));
  }

  const before = await withPrimaryGuestId(reservation);
  const updated = await prisma.reservation.update({
    where: { id: reservation.id },
    data: { assignedRoomId: room.id }
  });
  const after = await withPrimaryGuestId(updated);
  mirrorReservation(after);

  recordAuditEvent({
    organizationId: input.context.organizationId,
    propertyId: input.context.propertyId,
    actorUserId: input.context.userId,
    actorType: "user",
    action: "ROOM_ASSIGNED",
    entityType: "reservation",
    entityId: after.id,
    beforeJson: before,
    afterJson: after,
    deviceId: input.context.deviceId,
    correlationId: input.correlationId
  });

  recordDomainEvent({
    organizationId: input.context.organizationId,
    propertyId: input.context.propertyId,
    entityType: "reservation",
    entityId: after.id,
    eventType: "RoomAssigned",
    payload: { roomId: room.id, roomNumber: room.number },
    actorType: "user",
    actorUserId: input.context.userId,
    correlationId: input.correlationId
  });

  return after;
}

export async function assignRoomByNumber(input: {
  context: UserContext;
  reservationId: string;
  roomNumber: string;
  correlationId: string;
}): Promise<ReservationRecord> {
  const reservation = await prisma.reservation.findUnique({ where: { id: input.reservationId } });
  if (!reservation) {
    throw new Error("Reservation was not found.");
  }
  const room = await prisma.room.findUnique({
    where: { propertyId_number: { propertyId: reservation.propertyId, number: input.roomNumber } }
  });
  if (!room) {
    throw new Error("Room was not found.");
  }

  return assignRoom({
    context: input.context,
    reservationId: input.reservationId,
    roomId: room.id,
    correlationId: input.correlationId
  });
}

export async function checkInReservation(input: {
  context: UserContext;
  reservationId: string;
  roomId: string;
  signatureObjectKey: string;
  correlationId: string;
}): Promise<ReservationRecord> {
  requirePermissions(input.context, ["pms.checkin.execute"]);

  const reservation = await prisma.reservation.findUnique({ where: { id: input.reservationId } });
  const room = await prisma.room.findUnique({ where: { id: input.roomId } });
  if (!reservation || !room) {
    throw new Error("Reservation or room was not found.");
  }
  if (reservation.status !== "confirmed") {
    throw new Error(`Reservation ${reservation.code} is not ready for check-in.`);
  }

  const validation = await canAssignRoom({
    propertyId: reservation.propertyId,
    reservationId: reservation.id,
    roomId: room.id,
    arrivalDate: isoDate(reservation.arrivalDate),
    departureDate: isoDate(reservation.departureDate)
  });
  if (!validation.allowed) {
    throw new Error(validation.warnings.join(" "));
  }

  const before = {
    reservation: await withPrimaryGuestId(reservation),
    room: mapRoom(room)
  };

  const [updatedReservation, updatedRoom] = await prisma.$transaction([
    prisma.reservation.update({
      where: { id: reservation.id },
      data: { status: "checked_in", assignedRoomId: room.id }
    }),
    prisma.room.update({
      where: { id: room.id },
      data: { status: "occupied", housekeepingStatus: "clean" }
    })
  ]);

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
    afterJson: { reservation: afterReservation, room: afterRoom },
    deviceId: input.context.deviceId,
    correlationId: input.correlationId
  });

  recordDomainEvent({
    organizationId: input.context.organizationId,
    propertyId: input.context.propertyId,
    entityType: "reservation",
    entityId: afterReservation.id,
    eventType: "GuestCheckedIn",
    payload: { roomId: afterRoom.id, roomNumber: afterRoom.number, signatureObjectKey: input.signatureObjectKey },
    actorType: "user",
    actorUserId: input.context.userId,
    correlationId: input.correlationId
  });

  return afterReservation;
}

export async function checkOutReservation(input: {
  context: UserContext;
  reservationId: string;
  correlationId: string;
}): Promise<ReservationRecord> {
  requirePermissions(input.context, ["pms.checkout.execute"]);

  const reservation = await prisma.reservation.findUnique({ where: { id: input.reservationId } });
  if (!reservation) {
    throw new Error("Reservation was not found.");
  }
  if (reservation.status !== "checked_in") {
    throw new Error(`Reservation ${reservation.code} is not checked in.`);
  }

  const room = reservation.assignedRoomId
    ? await prisma.room.findUnique({ where: { id: reservation.assignedRoomId } })
    : null;

  const before = {
    reservation: await withPrimaryGuestId(reservation),
    room: room ? mapRoom(room) : undefined
  };

  const operations: Prisma.PrismaPromise<unknown>[] = [
    prisma.reservation.update({ where: { id: reservation.id }, data: { status: "checked_out" } })
  ];
  if (room) {
    operations.push(
      prisma.room.update({ where: { id: room.id }, data: { status: "dirty", housekeepingStatus: "dirty" } })
    );
  }
  const results = await prisma.$transaction(operations);
  const updatedReservation = results[0] as NonNullable<Awaited<ReturnType<typeof prisma.reservation.findUnique>>>;
  const updatedRoom = (room && results.length > 1
    ? (results[1] as NonNullable<Awaited<ReturnType<typeof prisma.room.findUnique>>>)
    : null);

  const afterReservation = await withPrimaryGuestId(updatedReservation);
  const afterRoom = updatedRoom ? mapRoom(updatedRoom) : undefined;
  mirrorReservation(afterReservation);
  if (afterRoom) mirrorRoom(afterRoom);

  recordAuditEvent({
    organizationId: input.context.organizationId,
    propertyId: reservation.propertyId,
    actorUserId: input.context.userId,
    actorType: "user",
    action: "GUEST_CHECKED_OUT",
    entityType: "reservation",
    entityId: afterReservation.id,
    beforeJson: before,
    afterJson: { reservation: afterReservation, room: afterRoom },
    deviceId: input.context.deviceId,
    correlationId: input.correlationId
  });

  recordDomainEvent({
    organizationId: input.context.organizationId,
    propertyId: reservation.propertyId,
    entityType: "reservation",
    entityId: afterReservation.id,
    eventType: "GuestCheckedOut",
    payload: { roomId: afterRoom?.id, roomNumber: afterRoom?.number },
    actorType: "user",
    actorUserId: input.context.userId,
    correlationId: input.correlationId
  });

  return afterReservation;
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
    throw new Error("Reservation was not found.");
  }
  if (["checked_in", "checked_out"].includes(reservation.status)) {
    throw new Error(`Reservation ${reservation.code} cannot be moved to ${input.status}.`);
  }

  const before = await withPrimaryGuestId(reservation);
  const updated = await prisma.reservation.update({
    where: { id: reservation.id },
    data: { status: input.status }
  });
  const after = await withPrimaryGuestId(updated);
  mirrorReservation(after);

  recordAuditEvent({
    organizationId: input.context.organizationId,
    propertyId: reservation.propertyId,
    actorUserId: input.context.userId,
    actorType: "user",
    action: input.status === "cancelled" ? "RESERVATION_CANCELLED" : "RESERVATION_NO_SHOW",
    entityType: "reservation",
    entityId: after.id,
    beforeJson: before,
    afterJson: { ...after, reason: input.reason },
    deviceId: input.context.deviceId,
    correlationId: input.correlationId
  });

  recordDomainEvent({
    organizationId: input.context.organizationId,
    propertyId: reservation.propertyId,
    entityType: "reservation",
    entityId: after.id,
    eventType: input.status === "cancelled" ? "ReservationCancelled" : "ReservationNoShow",
    payload: { code: after.code, reason: input.reason },
    actorType: "user",
    actorUserId: input.context.userId,
    correlationId: input.correlationId
  });

  return after;
}

export async function quoteAvailability(input: {
  propertyId: string;
  arrivalDate: string;
  departureDate: string;
  adults: number;
  children?: number;
}): Promise<
  Array<{
    roomTypeId: string;
    roomTypeName: string;
    availableRooms: number;
    currency: string;
    totalAmount: number;
    cancellationPolicy: string;
  }>
> {
  if (input.arrivalDate >= input.departureDate) {
    throw new BadRequestError("Departure date must be after arrival date.");
  }
  const requiredOccupancy = input.adults + (input.children ?? 0);
  const arrival = dateOnly(input.arrivalDate);
  const departure = dateOnly(input.departureDate);

  const roomTypes = await prisma.roomType.findMany({
    where: { propertyId: input.propertyId, maxOccupancy: { gte: requiredOccupancy }, active: true }
  });

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
      // OVERSELL FIX: availability must subtract ALL overlapping active
      // reservations for the room type — including confirmed reservations that
      // have not been assigned a physical room yet. Previously only reservations
      // with a non-null assignedRoomId were counted, so unassigned bookings
      // consumed zero inventory and the property could be systematically oversold.
      const reservationCount = await prisma.reservation.count({
        where: {
          propertyId: input.propertyId,
          roomTypeId: roomType.id,
          status: { in: ["confirmed", "checked_in"] },
          arrivalDate: { lt: departure },
          departureDate: { gt: arrival }
        }
      });
      const available = Math.max(0, totalRooms - reservationCount);

      // PRICING: read the real rate grid (RateDay) for this room type over the
      // stay. Per night we take the lowest published price across rate plans.
      // Falls back to a base nightly rate only when no rates are loaded yet.
      const nights = nightsBetween(input.arrivalDate, input.departureDate);
      const BASE_NIGHTLY = 136;
      const rateDays = await prisma.rateDay.findMany({
        where: { propertyId: input.propertyId, roomTypeId: roomType.id, date: { gte: arrival, lt: departure } },
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
      for (let i = 0; i < nights; i++) {
        const d = new Date(arrival.getTime() + i * 86_400_000).toISOString().slice(0, 10);
        totalAmount += minPriceByDate.get(d) ?? BASE_NIGHTLY;
      }

      return {
        roomTypeId: roomType.id,
        roomTypeName: roomType.name,
        availableRooms: available,
        currency,
        totalAmount: Math.round(totalAmount * 100) / 100,
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
