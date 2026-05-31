import {
  buildSesHospedajesXml,
  submitSesHospedajesComunicacion,
  type SesGuest,
  type SesSubmissionRecord
} from "@hotelos/compliance";
import { prisma } from "@hotelos/database";
import { signSubmissionXml } from "../../lib/compliance-signing.js";
import type { UserContext } from "../../lib/demo-store.js";
import { recordAuditEvent, recordDomainEvent } from "../audit/audit.service.js";

let sesChain: Promise<void> = Promise.resolve();

export function queueSesSubmission(input: {
  guestRegisterRecordId: string;
  reservationId?: string;
  submissionType?: "alta" | "modificacion" | "baja";
  context: UserContext;
  correlationId: string;
}): void {
  sesChain = sesChain.then(async () => {
    try {
      await processSubmission(input);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[ses] failed to process submission for ${input.guestRegisterRecordId}: ${message}`);
    }
  });
}

export async function retrySesSubmission(submissionId: string, context: UserContext): Promise<void> {
  const row = await prisma.sesHospedajesSubmission.findUnique({ where: { id: submissionId } });
  if (!row) throw new Error("SES submission was not found.");
  sesChain = sesChain.then(() =>
    processSubmission({
      guestRegisterRecordId: row.guestRegisterRecordId,
      reservationId: row.reservationId ?? undefined,
      submissionType: (row.submissionType ?? "alta") as "alta" | "modificacion" | "baja",
      context,
      correlationId: `retry_${Date.now()}`
    }).catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[ses.retry] failed: ${message}`);
    })
  );
}

/**
 * SES Hospedajes scheduler tick (P2/compliance go-live). Two jobs:
 *   1. Retry every submission stuck in "retrying" whose nextRetryAt has elapsed
 *      (previously nothing polled nextRetryAt).
 *   2. Report submissions still not accepted 24h after creation — the RD 933/2021
 *      legal deadline — so they can be surfaced/alerted.
 * Idempotent and safe to run on an interval.
 */
export async function runDueSesSubmissions(context: UserContext): Promise<{ retried: number; overdue: number }> {
  const now = new Date();
  const due = await prisma.sesHospedajesSubmission.findMany({
    where: { status: "retrying", nextRetryAt: { lte: now } },
    select: { id: true },
    take: 50
  });
  for (const s of due) {
    try {
      await retrySesSubmission(s.id, context);
    } catch (error) {
      console.error(`[ses.scheduler] retry ${s.id} failed:`, error instanceof Error ? error.message : error);
    }
  }
  const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const overdue = await prisma.sesHospedajesSubmission.count({
    where: { status: { notIn: ["accepted"] }, createdAt: { lt: dayAgo } }
  });
  return { retried: due.length, overdue };
}

export async function getSesSubmission(submissionId: string): Promise<unknown | null> {
  const row = await prisma.sesHospedajesSubmission.findUnique({ where: { id: submissionId } });
  if (!row) return null;
  return {
    id: row.id,
    guestRegisterRecordId: row.guestRegisterRecordId,
    reservationId: row.reservationId,
    externalReference: row.externalReference,
    submissionType: row.submissionType,
    status: row.status,
    endpoint: row.endpoint,
    acknowledgementCode: row.acknowledgementCode,
    trackingNumber: row.trackingNumber,
    errorCode: row.errorCode,
    errorMessage: row.errorMessage,
    attempts: row.attempts,
    xmlPayload: row.xmlPayload,
    responseAck: row.responseAck,
    submittedAt: row.submittedAt?.toISOString(),
    acknowledgedAt: row.acknowledgedAt?.toISOString(),
    nextRetryAt: row.nextRetryAt?.toISOString(),
    createdAt: row.createdAt.toISOString()
  };
}

async function processSubmission(input: {
  guestRegisterRecordId: string;
  reservationId?: string;
  submissionType?: "alta" | "modificacion" | "baja";
  context: UserContext;
  correlationId: string;
}): Promise<void> {
  const record = await prisma.guestRegisterRecord.findUnique({
    where: { id: input.guestRegisterRecordId }
  });
  if (!record) {
    console.error(`[ses] guest register record ${input.guestRegisterRecordId} not found.`);
    return;
  }

  const reservationId = input.reservationId ?? record.reservationId;
  if (!reservationId) {
    console.error(`[ses] no reservation linked to guest register record ${record.id}; skipping submission.`);
    return;
  }

  const [property, reservation, primaryGuestLink] = await Promise.all([
    prisma.property.findUnique({ where: { id: record.propertyId } }),
    prisma.reservation.findUnique({ where: { id: reservationId } }),
    prisma.reservationGuest.findFirst({ where: { reservationId, isPrimary: true } })
  ]);
  if (!property || !reservation) return;

  const allLinks = await prisma.reservationGuest.findMany({ where: { reservationId } });
  const guestIds = allLinks.map((l) => l.guestId);
  const guests = guestIds.length ? await prisma.guest.findMany({ where: { id: { in: guestIds } } }) : [];
  const primaryGuestId = primaryGuestLink?.guestId ?? record.guestId ?? undefined;

  const sesGuests: SesGuest[] = [];
  // Primary guest first.
  const primary = guests.find((g) => g.id === primaryGuestId);
  if (primary) {
    sesGuests.push(toSesGuest({
      documentType: primary.documentType ?? record.documentType ?? "DNI",
      documentNumber: primary.documentNumber ?? record.documentNumber ?? "",
      documentSupportNumber: record.documentSupportNumber ?? undefined,
      firstName: primary.firstName,
      surname1: primary.surname1 ?? "",
      surname2: primary.surname2 ?? undefined,
      dateOfBirth: primary.dateOfBirth?.toISOString().slice(0, 10) ?? record.dateOfBirth?.toISOString().slice(0, 10) ?? "1900-01-01",
      nationality: primary.nationality ?? record.nationality ?? "ESP",
      phone: primary.phone ?? record.phoneMobile ?? undefined,
      email: primary.email ?? record.email ?? undefined,
      residenceAddress: primary.residenceAddress ?? record.residenceFullAddress ?? undefined
    }));
  }
  for (const guest of guests) {
    if (guest.id === primaryGuestId) continue;
    sesGuests.push(toSesGuest({
      documentType: guest.documentType ?? "DNI",
      documentNumber: guest.documentNumber ?? "",
      firstName: guest.firstName,
      surname1: guest.surname1 ?? "",
      surname2: guest.surname2 ?? undefined,
      dateOfBirth: guest.dateOfBirth?.toISOString().slice(0, 10) ?? "1900-01-01",
      nationality: guest.nationality ?? "ESP",
      phone: guest.phone ?? undefined,
      email: guest.email ?? undefined,
      residenceAddress: guest.residenceAddress ?? undefined
    }));
  }

  if (sesGuests.length === 0) {
    console.error(`[ses] no guests resolved for record ${record.id}; skipping submission.`);
    return;
  }

  const submissionType = (input.submissionType ?? "alta") as "alta" | "modificacion" | "baja";
  const externalReference = `${reservation.code}-${submissionType}-${Date.now()}`;
  const submissionRecord: SesSubmissionRecord = {
    submissionType,
    externalReference,
    establishment: {
      taxId: property.legalName?.match(/[A-Z]?\d{8}[A-Z]?/i)?.[0] ?? "B00000000",
      legalName: property.legalName ?? property.name ?? "HotelOS Demo",
      registryNumber: process.env.SES_REGISTRY_NUMBER ?? `REG-${property.id}`,
      registryType: "establecimiento_turistico",
      address: property.address ?? "Demo address",
      municipalityCode: process.env.SES_MUNICIPALITY_CODE ?? "28079",
      province: property.province ?? "Madrid",
      postalCode: process.env.SES_POSTAL_CODE ?? "28001",
      country: property.country ?? "ES"
    },
    contract: {
      contractRef: reservation.code,
      contractDate: reservation.createdAt.toISOString(),
      checkinDate: reservation.arrivalDate.toISOString().slice(0, 10),
      checkoutDate: reservation.departureDate.toISOString().slice(0, 10),
      contractType: "alojamiento",
      numberOfPersons: reservation.adults + reservation.children,
      paymentMethod: "card",
      paymentReference: reservation.code,
      totalAmount: Number(reservation.totalAmount),
      internetAccess: true
    },
    guests: sesGuests
  };

  const xml = buildSesHospedajesXml(submissionRecord);
  const signed = await signSubmissionXml({
    xml,
    certPath: process.env.SES_HOSPEDAJES_CERT_PATH,
    certPassphrase: process.env.SES_HOSPEDAJES_CERT_PASSPHRASE
  });

  const submission = await prisma.sesHospedajesSubmission.upsert({
    where: { externalReference },
    update: {
      status: "queued",
      xmlPayload: signed.signedXml,
      attempts: { increment: 1 },
      submittedAt: new Date(),
      signatureMode: signed.signatureMode,
      signedAt: new Date(signed.signedAt),
      correlationId: input.correlationId
    },
    create: {
      propertyId: property.id,
      guestRegisterRecordId: record.id,
      reservationId,
      externalReference,
      submissionType,
      status: "queued",
      requestPayloadJson: submissionRecord as unknown as object,
      xmlPayload: signed.signedXml,
      attempts: 1,
      submittedAt: new Date(),
      signatureMode: signed.signatureMode,
      signedAt: new Date(signed.signedAt),
      correlationId: input.correlationId
    }
  });

  const response = await submitSesHospedajesComunicacion({
    externalReference,
    establishmentTaxId: submissionRecord.establishment.taxId,
    xmlPayload: signed.signedXml
  });

  const finalStatus =
    response.status === "accepted"
      ? "accepted"
      : response.status === "accepted_with_warnings"
        ? "accepted"
        : response.status === "rejected"
          ? "rejected"
          : "retrying";

  await prisma.sesHospedajesSubmission.update({
    where: { id: submission.id },
    data: {
      status: finalStatus,
      endpoint: response.endpoint,
      acknowledgementCode: response.acknowledgementCode ?? null,
      trackingNumber: response.trackingNumber ?? null,
      errorCode: response.errorCode ?? null,
      errorMessage: response.errorMessage ?? null,
      responseAck: response.rawResponse ?? null,
      responsePayloadJson: response.rawResponse ? ({ ack: response.rawResponse } as object) : undefined,
      acknowledgedAt: finalStatus === "accepted" ? new Date() : null,
      nextRetryAt: finalStatus === "retrying" ? new Date(Date.now() + 10 * 60_000) : null
    }
  });

  recordAuditEvent({
    organizationId: input.context.organizationId,
    propertyId: property.id,
    actorUserId: input.context.userId,
    actorType: "system",
    action: "SES_HOSPEDAJES_SUBMISSION",
    entityType: "guest_register_record",
    entityId: record.id,
    afterJson: {
      submissionId: submission.id,
      externalReference,
      submissionType,
      status: finalStatus,
      acknowledgementCode: response.acknowledgementCode,
      trackingNumber: response.trackingNumber,
      errorCode: response.errorCode,
      errorMessage: response.errorMessage
    },
    correlationId: input.correlationId
  });

  recordDomainEvent({
    organizationId: input.context.organizationId,
    propertyId: property.id,
    entityType: "guest_register_record",
    entityId: record.id,
    eventType: finalStatus === "accepted" ? "AuthoritySubmissionAccepted" : finalStatus === "rejected" ? "AuthoritySubmissionRejected" : "AuthoritySubmissionPending",
    payload: { submissionId: submission.id, submissionType, acknowledgementCode: response.acknowledgementCode, trackingNumber: response.trackingNumber, status: finalStatus },
    actorType: "system",
    actorUserId: input.context.userId,
    correlationId: input.correlationId
  });
}

function toSesGuest(input: {
  documentType: string;
  documentNumber: string;
  documentSupportNumber?: string;
  firstName: string;
  surname1: string;
  surname2?: string;
  dateOfBirth: string;
  nationality: string;
  phone?: string;
  email?: string;
  residenceAddress?: string;
}): SesGuest {
  const docType = input.documentType?.toUpperCase();
  const mapped: SesGuest["documentType"] = docType === "NIE" ? "NIE" : docType === "PASSPORT" || docType === "PASAPORTE" ? "PASSPORT" : docType === "TIE" ? "TIE" : "DNI";
  return {
    documentType: mapped,
    documentNumber: input.documentNumber,
    documentSupportNumber: input.documentSupportNumber,
    firstName: input.firstName,
    surname1: input.surname1,
    surname2: input.surname2,
    dateOfBirth: input.dateOfBirth,
    nationality: input.nationality,
    phone: input.phone,
    email: input.email,
    residenceAddress: input.residenceAddress
  };
}

export async function listSesSubmissions(propertyId: string): Promise<unknown[]> {
  const rows = await prisma.sesHospedajesSubmission.findMany({
    where: { propertyId },
    orderBy: { createdAt: "desc" },
    take: 100
  });
  return rows.map((r) => ({
    id: r.id,
    guestRegisterRecordId: r.guestRegisterRecordId,
    reservationId: r.reservationId,
    externalReference: r.externalReference,
    submissionType: r.submissionType,
    status: r.status,
    endpoint: r.endpoint,
    acknowledgementCode: r.acknowledgementCode,
    trackingNumber: r.trackingNumber,
    errorCode: r.errorCode,
    errorMessage: r.errorMessage,
    attempts: r.attempts,
    submittedAt: r.submittedAt?.toISOString(),
    acknowledgedAt: r.acknowledgedAt?.toISOString()
  }));
}
