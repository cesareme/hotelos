// Guest portal data + actions (Sprint 40).
//
// All three operations are guarded by `verifyGuestToken`. The token IS the
// authentication: a valid token scopes the caller to exactly one reservation,
// so handlers never accept a reservationId from the client — it always comes
// from the verified session.
//
// `getGuestReservationView` deliberately returns a narrow, safe projection of
// the reservation: no internal foreign keys beyond the reservation id the guest
// already holds via their session, and no PII for OTHER guests on the booking.

import { prisma } from "@hotelos/database";
import { recordDomainEvent } from "../audit/audit.service.js";
import { createId } from "../../lib/ids.js";
import { verifyGuestToken } from "./guest-portal-auth.service.js";
import { computeReservationBalance } from "../folio/folio-balance.service.js";

// Retain pre-check-in register records for 3 years, matching the compliance
// module's default for guest register records.
const REGISTER_RETENTION_MS = 1000 * 60 * 60 * 24 * 365 * 3;

export class GuestPortalAuthError extends Error {
  statusCode = 401;
  constructor(message = "Invalid or expired guest token.") {
    super(message);
    this.name = "GuestPortalAuthError";
  }
}

export type GuestReservationView = {
  reservationId: string;
  reservationCode: string;
  propertyName: string;
  status: string;
  arrivalDate: string;
  departureDate: string;
  roomType: string | null;
  guestCount: number;
  balanceDue: number;
  currency: string;
};

export type PreCheckInInput = {
  token: string;
  documentType?: string;
  documentNumber?: string;
  residenceAddress?: string;
  country?: string;
  arrivalEta?: string;
  specialRequests?: string;
};

export type ServiceRequestInput = {
  token: string;
  category: string;
  description?: string;
  preferredTime?: string;
};

async function organizationIdForProperty(propertyId: string): Promise<string> {
  const property = await prisma.property.findUnique({
    where: { id: propertyId },
    select: { organizationId: true }
  });
  return property?.organizationId ?? propertyId;
}

export async function getGuestReservationView(token: string): Promise<GuestReservationView> {
  const session = await verifyGuestToken(token);
  if (!session || !session.reservationId) throw new GuestPortalAuthError();

  const reservation = await prisma.reservation.findUnique({
    where: { id: session.reservationId }
  });
  if (!reservation) throw new GuestPortalAuthError("Reservation no longer available.");

  const [property, roomType, guestLinks] = await Promise.all([
    prisma.property.findUnique({ where: { id: reservation.propertyId }, select: { name: true } }),
    reservation.roomTypeId
      ? prisma.roomType.findUnique({ where: { id: reservation.roomTypeId }, select: { name: true } })
      : Promise.resolve(null),
    prisma.reservationGuest.count({ where: { reservationId: reservation.id } })
  ]);

  // Balance due: the Folio model carries no balance column in this schema —
  // outstanding amounts are derived from charges/captured payments/refunds by
  // the shared folio-balance helper (Sprint 46). Reservations without a folio
  // resolve to 0.
  const balanceDue = (await computeReservationBalance(reservation.id)).balanceDue;

  // adults + children is the headcount the guest expects to see; fall back to
  // the number of linked guest rows if the counts are zero.
  const guestCount = reservation.adults + reservation.children || guestLinks || 1;

  return {
    reservationId: reservation.id,
    reservationCode: reservation.code,
    propertyName: property?.name ?? "Your hotel",
    status: reservation.status,
    arrivalDate: reservation.arrivalDate.toISOString().slice(0, 10),
    departureDate: reservation.departureDate.toISOString().slice(0, 10),
    roomType: roomType?.name ?? null,
    guestCount,
    balanceDue,
    currency: reservation.currency
  };
}

export async function submitPreCheckIn(
  input: PreCheckInInput
): Promise<{ confirmationNumber: string }> {
  const session = await verifyGuestToken(input.token);
  if (!session || !session.reservationId) throw new GuestPortalAuthError();

  const reservation = await prisma.reservation.findUnique({
    where: { id: session.reservationId }
  });
  if (!reservation) throw new GuestPortalAuthError("Reservation no longer available.");

  // Resolve the reservation's primary guest (preferred), else any linked guest,
  // else the guest tied to the session.
  const primaryLink =
    (await prisma.reservationGuest.findFirst({
      where: { reservationId: reservation.id, isPrimary: true }
    })) ?? (await prisma.reservationGuest.findFirst({ where: { reservationId: reservation.id } }));
  const guestId = primaryLink?.guestId ?? session.guestId ?? null;

  const now = new Date();
  // documentNumber / residenceFullAddress are auto-encrypted by the Sprint 32
  // Prisma extension (and mirrored to *LookupHash). We just write plaintext.
  const writeData = {
    propertyId: reservation.propertyId,
    reservationId: reservation.id,
    guestId,
    recordType: "checkin",
    status: "draft" as const,
    isPrimaryGuest: true,
    documentType: input.documentType ?? null,
    documentNumber: input.documentNumber ?? null,
    residenceFullAddress: input.residenceAddress ?? null,
    residenceCountry: input.country ?? null,
    requiredPayloadJson: {
      source: "guest_portal_pre_check_in",
      arrivalEta: input.arrivalEta ?? null,
      specialRequests: input.specialRequests ?? null
    },
    retentionUntil: new Date(now.getTime() + REGISTER_RETENTION_MS)
  };

  // Upsert: reuse an existing draft pre-check-in record for this reservation
  // rather than creating duplicates if the guest submits twice.
  const existing = await prisma.guestRegisterRecord.findFirst({
    where: { reservationId: reservation.id, recordType: "checkin", status: "draft" },
    select: { id: true }
  });
  let recordId: string;
  if (existing) {
    const updated = await prisma.guestRegisterRecord.update({
      where: { id: existing.id },
      data: {
        guestId,
        documentType: writeData.documentType,
        documentNumber: writeData.documentNumber,
        residenceFullAddress: writeData.residenceFullAddress,
        residenceCountry: writeData.residenceCountry,
        requiredPayloadJson: writeData.requiredPayloadJson
      },
      select: { id: true }
    });
    recordId = updated.id;
  } else {
    const created = await prisma.guestRegisterRecord.create({ data: writeData, select: { id: true } });
    recordId = created.id;
  }

  // Append the arrival ETA to the reservation notes so front desk sees it.
  if (input.arrivalEta) {
    const etaNote = `[Pre-check-in] Estimated arrival: ${input.arrivalEta}`;
    const newNotes = reservation.notes ? `${reservation.notes}\n${etaNote}` : etaNote;
    await prisma.reservation.update({
      where: { id: reservation.id },
      data: { notes: newNotes }
    });
  }

  const organizationId = await organizationIdForProperty(reservation.propertyId);
  const confirmationNumber = `PCI-${recordId.slice(-8).toUpperCase()}`;

  recordDomainEvent({
    organizationId,
    propertyId: reservation.propertyId,
    entityType: "guest_register_record",
    entityId: recordId,
    eventType: "GuestPreCheckInSubmitted",
    payload: {
      reservationId: reservation.id,
      reservationCode: reservation.code,
      confirmationNumber,
      arrivalEta: input.arrivalEta ?? null
    },
    actorType: "system",
    correlationId: createId("corr")
  });

  return { confirmationNumber };
}

export async function submitServiceRequest(
  input: ServiceRequestInput
): Promise<{ ticketNumber: string }> {
  const session = await verifyGuestToken(input.token);
  if (!session || !session.reservationId) throw new GuestPortalAuthError();

  const reservation = await prisma.reservation.findUnique({
    where: { id: session.reservationId },
    select: { id: true, code: true, propertyId: true }
  });
  if (!reservation) throw new GuestPortalAuthError("Reservation no longer available.");

  // Map portal categories onto a best-fit assigned department.
  const departmentByCategory: Record<string, string> = {
    housekeeping: "housekeeping",
    food_beverage: "food_beverage",
    concierge: "front_office",
    maintenance: "maintenance"
  };

  const created = await prisma.serviceRequest.create({
    data: {
      propertyId: reservation.propertyId,
      reservationId: reservation.id,
      guestId: session.guestId,
      requestType: input.category,
      status: "open",
      assignedDepartment: departmentByCategory[input.category] ?? null
    },
    select: { id: true }
  });

  const organizationId = await organizationIdForProperty(reservation.propertyId);
  const ticketNumber = `SRQ-${created.id.slice(-8).toUpperCase()}`;

  recordDomainEvent({
    organizationId,
    propertyId: reservation.propertyId,
    entityType: "service_request",
    entityId: created.id,
    eventType: "GuestServiceRequested",
    payload: {
      reservationId: reservation.id,
      reservationCode: reservation.code,
      ticketNumber,
      category: input.category,
      description: input.description ?? null,
      preferredTime: input.preferredTime ?? null
    },
    actorType: "system",
    correlationId: createId("corr")
  });

  return { ticketNumber };
}
