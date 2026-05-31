import { prisma } from "@hotelos/database";
import { createId } from "../../lib/ids.js";
import type { UserContext } from "../../lib/demo-store.js";
import { recordAuditEvent, recordDomainEvent } from "../audit/audit.service.js";

export type GdprRequestType = "dsar" | "erasure" | "rectification" | "portability";

const VALID_REQUEST_TYPES: GdprRequestType[] = ["dsar", "erasure", "rectification", "portability"];

const RESPONSE_WINDOW_DAYS = 30; // GDPR Art. 12(3) — controller must respond within one month.
const SPAIN_GUEST_REGISTER_RETENTION_YEARS = 3; // RD 933/2021 — three-year retention obligation.

type DossierSection = {
  table: string;
  rowsFound: number;
  rows: unknown[];
};

type Dossier = {
  generatedAt: string;
  subjectEmail?: string;
  subjectId?: string;
  guestIds: string[];
  guestProfileIds: string[];
  reservationIds: string[];
  sections: DossierSection[];
};

type ErasureAction = "pseudonymized" | "deleted" | "retained_by_law" | "skipped_no_column";

type ErasureSummary = {
  executedAt: string;
  confirmRetentionOverride: boolean;
  tables: Array<{ name: string; rowsAffected: number; action: ErasureAction; note?: string }>;
};

function assertRequestType(value: string): asserts value is GdprRequestType {
  if (!VALID_REQUEST_TYPES.includes(value as GdprRequestType)) {
    throw new Error(`Unsupported GDPR requestType '${value}'. Must be one of: ${VALID_REQUEST_TYPES.join(", ")}.`);
  }
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date.getTime());
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function isOlderThanYears(when: Date | null | undefined, years: number): boolean {
  if (!when) return false;
  const threshold = new Date();
  threshold.setUTCFullYear(threshold.getUTCFullYear() - years);
  return when.getTime() < threshold.getTime();
}

// ---------- subject resolution ----------

async function resolveSubjectIdentifiers(input: {
  organizationId: string;
  subjectEmail?: string | null;
  subjectId?: string | null;
}): Promise<{ guestIds: string[]; guestProfileIds: string[] }> {
  const guestIds = new Set<string>();
  const guestProfileIds = new Set<string>();

  if (input.subjectId) {
    guestIds.add(input.subjectId);
  }

  if (input.subjectEmail) {
    const guests = await prisma.guest.findMany({
      where: { organizationId: input.organizationId, email: input.subjectEmail }
    });
    guests.forEach((g) => guestIds.add(g.id));

    const profiles = await prisma.guestProfile.findMany({
      where: { organizationId: input.organizationId, email: input.subjectEmail }
    });
    profiles.forEach((p) => guestProfileIds.add(p.id));
  }

  // Follow primary guest links from profiles -> guests and vice versa.
  if (guestProfileIds.size) {
    const links = await prisma.guestProfileLink.findMany({
      where: { guestProfileId: { in: Array.from(guestProfileIds) } }
    });
    links.forEach((l) => guestIds.add(l.guestId));
  }
  if (guestIds.size) {
    const links = await prisma.guestProfileLink.findMany({
      where: { guestId: { in: Array.from(guestIds) } }
    });
    links.forEach((l) => guestProfileIds.add(l.guestProfileId));
  }

  return { guestIds: Array.from(guestIds), guestProfileIds: Array.from(guestProfileIds) };
}

async function compileDossier(input: {
  organizationId: string;
  subjectEmail?: string | null;
  subjectId?: string | null;
}): Promise<Dossier> {
  const { guestIds, guestProfileIds } = await resolveSubjectIdentifiers(input);
  const sections: DossierSection[] = [];

  // Guest
  const guests = guestIds.length ? await prisma.guest.findMany({ where: { id: { in: guestIds } } }) : [];
  sections.push({ table: "Guest", rowsFound: guests.length, rows: guests });

  // GuestProfile
  const profiles = guestProfileIds.length
    ? await prisma.guestProfile.findMany({ where: { id: { in: guestProfileIds } } })
    : [];
  sections.push({ table: "GuestProfile", rowsFound: profiles.length, rows: profiles });

  // Reservations via ReservationGuest
  const resvLinks = guestIds.length
    ? await prisma.reservationGuest.findMany({ where: { guestId: { in: guestIds } } })
    : [];
  const reservationIds = Array.from(new Set(resvLinks.map((l) => l.reservationId)));
  const reservations = reservationIds.length
    ? await prisma.reservation.findMany({ where: { id: { in: reservationIds } } })
    : [];
  sections.push({ table: "Reservation", rowsFound: reservations.length, rows: reservations });

  // Folio
  const folios = reservationIds.length
    ? await prisma.folio.findMany({ where: { reservationId: { in: reservationIds } } })
    : [];
  sections.push({ table: "Folio", rowsFound: folios.length, rows: folios });

  // FolioLine
  const folioIds = folios.map((f) => f.id);
  const folioLines = folioIds.length
    ? await prisma.folioLine.findMany({ where: { folioId: { in: folioIds } } })
    : [];
  sections.push({ table: "FolioLine", rowsFound: folioLines.length, rows: folioLines });

  // Payment (linked through folio)
  const payments = folioIds.length
    ? await prisma.payment.findMany({ where: { folioId: { in: folioIds } } })
    : [];
  sections.push({ table: "Payment", rowsFound: payments.length, rows: payments });

  // GuestRegisterRecord (Spanish guest register — RD 933/2021)
  const registerRecords =
    guestIds.length || reservationIds.length
      ? await prisma.guestRegisterRecord.findMany({
          where: {
            OR: [
              guestIds.length ? { guestId: { in: guestIds } } : undefined,
              reservationIds.length ? { reservationId: { in: reservationIds } } : undefined
            ].filter(Boolean) as never
          }
        })
      : [];
  sections.push({ table: "GuestRegisterRecord", rowsFound: registerRecords.length, rows: registerRecords });

  // Conversations
  const conversations =
    guestIds.length || reservationIds.length
      ? await prisma.conversation.findMany({
          where: {
            OR: [
              guestIds.length ? { guestId: { in: guestIds } } : undefined,
              reservationIds.length ? { reservationId: { in: reservationIds } } : undefined
            ].filter(Boolean) as never
          }
        })
      : [];
  sections.push({ table: "Conversation", rowsFound: conversations.length, rows: conversations });

  const conversationIds = conversations.map((c) => c.id);
  const messages = conversationIds.length
    ? await prisma.message.findMany({ where: { conversationId: { in: conversationIds } } })
    : [];
  sections.push({ table: "Message", rowsFound: messages.length, rows: messages });

  // GuestUpsellPurchase (linked by reservation)
  const upsells = reservationIds.length
    ? await prisma.guestUpsellPurchase.findMany({ where: { reservationId: { in: reservationIds } } })
    : [];
  sections.push({ table: "GuestUpsellPurchase", rowsFound: upsells.length, rows: upsells });

  // GuestReview
  const reviews =
    guestIds.length || reservationIds.length
      ? await prisma.guestReview.findMany({
          where: {
            OR: [
              guestIds.length ? { guestId: { in: guestIds } } : undefined,
              reservationIds.length ? { reservationId: { in: reservationIds } } : undefined
            ].filter(Boolean) as never
          }
        })
      : [];
  sections.push({ table: "GuestReview", rowsFound: reviews.length, rows: reviews });

  // SurveyResponse
  const surveys =
    guestIds.length || reservationIds.length
      ? await prisma.surveyResponse.findMany({
          where: {
            OR: [
              guestIds.length ? { guestId: { in: guestIds } } : undefined,
              reservationIds.length ? { reservationId: { in: reservationIds } } : undefined
            ].filter(Boolean) as never
          }
        })
      : [];
  sections.push({ table: "SurveyResponse", rowsFound: surveys.length, rows: surveys });

  // LoyaltyMembership (linked via guestProfileId)
  const loyalty = guestProfileIds.length
    ? await prisma.loyaltyMembership.findMany({ where: { guestProfileId: { in: guestProfileIds } } })
    : [];
  sections.push({ table: "LoyaltyMembership", rowsFound: loyalty.length, rows: loyalty });

  return {
    generatedAt: new Date().toISOString(),
    subjectEmail: input.subjectEmail ?? undefined,
    subjectId: input.subjectId ?? undefined,
    guestIds,
    guestProfileIds,
    reservationIds,
    sections
  };
}

// ---------- public service API ----------

export async function createGdprRequest(input: {
  organizationId: string;
  propertyId?: string;
  subjectEmail: string;
  subjectId?: string;
  requestType: string;
  requestorEmail: string;
  payloadJson?: Record<string, unknown>;
  context?: UserContext;
  correlationId?: string;
}) {
  assertRequestType(input.requestType);
  if (!input.requestorEmail) throw new Error("requestorEmail is required.");
  if (!input.subjectEmail && !input.subjectId) {
    throw new Error("Either subjectEmail or subjectId is required to identify the data subject.");
  }

  const now = new Date();
  const dueAt = addDays(now, RESPONSE_WINDOW_DAYS);
  const correlationId = input.correlationId ?? createId("corr");

  const created = await prisma.gdprRequest.create({
    data: {
      organizationId: input.organizationId,
      propertyId: input.propertyId ?? null,
      subjectType: "guest",
      subjectId: input.subjectId ?? null,
      subjectEmail: input.subjectEmail,
      requestType: input.requestType,
      status: "pending",
      requestedAt: now,
      requestorEmail: input.requestorEmail,
      payloadJson: (input.payloadJson ?? null) as never,
      dueAt
    }
  });

  recordDomainEvent({
    organizationId: input.organizationId,
    propertyId: input.propertyId ?? input.context?.propertyId ?? "",
    entityType: "gdpr_request",
    entityId: created.id,
    eventType: "GdprRequestCreated",
    payload: {
      requestType: input.requestType,
      subjectEmail: input.subjectEmail,
      subjectId: input.subjectId,
      dueAt: dueAt.toISOString()
    },
    actorType: input.context ? "user" : "system",
    actorUserId: input.context?.userId,
    correlationId
  });

  if (input.context) {
    recordAuditEvent({
      organizationId: input.organizationId,
      propertyId: input.propertyId ?? input.context.propertyId,
      actorUserId: input.context.userId,
      actorType: "user",
      action: "GDPR_REQUEST_CREATED",
      entityType: "gdpr_request",
      entityId: created.id,
      afterJson: { requestType: input.requestType, subjectEmail: input.subjectEmail, dueAt: dueAt.toISOString() },
      correlationId
    });
  }

  return created;
}

export async function acknowledgeRequest(requestId: string, userId: string) {
  const updated = await prisma.gdprRequest.update({
    where: { id: requestId },
    data: { status: "in_progress", acknowledgedAt: new Date(), assigneeUserId: userId }
  });
  recordDomainEvent({
    organizationId: updated.organizationId,
    propertyId: updated.propertyId ?? "",
    entityType: "gdpr_request",
    entityId: updated.id,
    eventType: "GdprRequestAcknowledged",
    payload: { acknowledgedBy: userId },
    actorType: "user",
    actorUserId: userId,
    correlationId: createId("corr")
  });
  return updated;
}

export async function fulfillDsar(requestId: string, userId: string) {
  const request = await prisma.gdprRequest.findUnique({ where: { id: requestId } });
  if (!request) throw new Error(`GDPR request ${requestId} not found.`);
  if (request.requestType !== "dsar" && request.requestType !== "portability") {
    throw new Error(`Request ${requestId} is not a DSAR or portability request (got '${request.requestType}').`);
  }

  const dossier = await compileDossier({
    organizationId: request.organizationId,
    subjectEmail: request.subjectEmail,
    subjectId: request.subjectId
  });

  const now = new Date();
  const updated = await prisma.gdprRequest.update({
    where: { id: requestId },
    data: {
      status: "completed",
      completedAt: now,
      fulfillmentMetadataJson: dossier as never,
      assigneeUserId: userId
    }
  });

  recordDomainEvent({
    organizationId: request.organizationId,
    propertyId: request.propertyId ?? "",
    entityType: "gdpr_request",
    entityId: request.id,
    eventType: "GdprDsarFulfilled",
    payload: {
      subjectEmail: request.subjectEmail,
      guestIds: dossier.guestIds,
      sectionsCount: dossier.sections.length,
      totalRows: dossier.sections.reduce((acc, s) => acc + s.rowsFound, 0)
    },
    actorType: "user",
    actorUserId: userId,
    correlationId: createId("corr")
  });

  recordAuditEvent({
    organizationId: request.organizationId,
    propertyId: request.propertyId ?? "",
    actorUserId: userId,
    actorType: "user",
    action: "GDPR_DSAR_FULFILLED",
    entityType: "gdpr_request",
    entityId: request.id,
    afterJson: { sections: dossier.sections.map((s) => ({ table: s.table, rowsFound: s.rowsFound })) },
    correlationId: createId("corr")
  });

  return { request: updated, dossier };
}

export async function executeErasure(
  requestId: string,
  userId: string,
  options: { confirmRetentionOverride: boolean }
) {
  const request = await prisma.gdprRequest.findUnique({ where: { id: requestId } });
  if (!request) throw new Error(`GDPR request ${requestId} not found.`);
  if (request.requestType !== "erasure") {
    throw new Error(`Request ${requestId} is not an erasure request (got '${request.requestType}').`);
  }

  const { guestIds, guestProfileIds } = await resolveSubjectIdentifiers({
    organizationId: request.organizationId,
    subjectEmail: request.subjectEmail,
    subjectId: request.subjectId
  });

  const tables: ErasureSummary["tables"] = [];

  // --- GuestRegisterRecord — legal retention under RD 933/2021 ---
  // Only allow deletion if confirmRetentionOverride AND record is older than 3 years.
  const registerRecords =
    guestIds.length
      ? await prisma.guestRegisterRecord.findMany({ where: { guestId: { in: guestIds } } })
      : [];

  let registerDeleted = 0;
  let registerRetained = 0;
  for (const rec of registerRecords) {
    const isOld = isOlderThanYears(rec.createdAt, SPAIN_GUEST_REGISTER_RETENTION_YEARS);
    if (options.confirmRetentionOverride && isOld) {
      await prisma.guestRegisterRecord.delete({ where: { id: rec.id } });
      registerDeleted++;
    } else {
      // No `erasureRequestedAt` column on GuestRegisterRecord — log and skip the in-record marker.
      registerRetained++;
    }
  }
  if (registerDeleted) {
    tables.push({
      name: "GuestRegisterRecord",
      rowsAffected: registerDeleted,
      action: "deleted",
      note: "Override applied; records older than 3-year RD 933/2021 retention deleted."
    });
  }
  if (registerRetained) {
    tables.push({
      name: "GuestRegisterRecord",
      rowsAffected: registerRetained,
      action: "retained_by_law",
      note: `Spanish RD 933/2021 mandates ${SPAIN_GUEST_REGISTER_RETENTION_YEARS}-year retention. No erasureRequestedAt column on model; subject marker not persisted.`
    });
    console.warn(
      `[gdpr.erasure] retained ${registerRetained} GuestRegisterRecord row(s) under RD 933/2021; no erasureRequestedAt column to mark request.`
    );
  }

  // --- Folio / Payment / Invoice — retained by accounting law (no rows touched here) ---
  // Reservations have booker info and notes — keep the row (immutable financial record)
  // but pseudonymize bookerName / bookerEmail / notes.
  const resvLinks = guestIds.length
    ? await prisma.reservationGuest.findMany({ where: { guestId: { in: guestIds } } })
    : [];
  const reservationIds = Array.from(new Set(resvLinks.map((l) => l.reservationId)));
  let reservationsPseudonymized = 0;
  if (reservationIds.length) {
    const result = await prisma.reservation.updateMany({
      where: { id: { in: reservationIds } },
      data: {
        bookerName: "Erased",
        bookerEmail: null,
        notes: "[erased per GDPR Art. 17]"
      }
    });
    reservationsPseudonymized = result.count;
  }
  if (reservationsPseudonymized) {
    tables.push({
      name: "Reservation",
      rowsAffected: reservationsPseudonymized,
      action: "pseudonymized",
      note: "Free-text booker fields pseudonymized; financial totals retained for accounting law."
    });
  }

  // --- Messages and Conversations ---
  const conversations =
    guestIds.length || reservationIds.length
      ? await prisma.conversation.findMany({
          where: {
            OR: [
              guestIds.length ? { guestId: { in: guestIds } } : undefined,
              reservationIds.length ? { reservationId: { in: reservationIds } } : undefined
            ].filter(Boolean) as never
          }
        })
      : [];
  const conversationIds = conversations.map((c) => c.id);
  let messagesPseudonymized = 0;
  if (conversationIds.length) {
    const result = await prisma.message.updateMany({
      where: { conversationId: { in: conversationIds } },
      data: { body: "[erased per GDPR Art. 17]" }
    });
    messagesPseudonymized = result.count;
  }
  if (messagesPseudonymized) {
    tables.push({ name: "Message", rowsAffected: messagesPseudonymized, action: "pseudonymized" });
  }
  if (conversationIds.length) {
    tables.push({
      name: "Conversation",
      rowsAffected: conversationIds.length,
      action: "retained_by_law",
      note: "Conversation envelopes retained as audit trail; message bodies pseudonymized."
    });
  }

  // --- SurveyResponse: pseudonymize responsesJson ---
  let surveysPseudonymized = 0;
  if (guestIds.length || reservationIds.length) {
    const result = await prisma.surveyResponse.updateMany({
      where: {
        OR: [
          guestIds.length ? { guestId: { in: guestIds } } : undefined,
          reservationIds.length ? { reservationId: { in: reservationIds } } : undefined
        ].filter(Boolean) as never
      },
      data: { responsesJson: { erased: true, note: "[erased per GDPR Art. 17]" } as never }
    });
    surveysPseudonymized = result.count;
  }
  if (surveysPseudonymized) {
    tables.push({ name: "SurveyResponse", rowsAffected: surveysPseudonymized, action: "pseudonymized" });
  }

  // --- GuestReview: pseudonymize title and body ---
  let reviewsPseudonymized = 0;
  if (guestIds.length || reservationIds.length) {
    const result = await prisma.guestReview.updateMany({
      where: {
        OR: [
          guestIds.length ? { guestId: { in: guestIds } } : undefined,
          reservationIds.length ? { reservationId: { in: reservationIds } } : undefined
        ].filter(Boolean) as never
      },
      data: { title: "[erased]", body: "[erased per GDPR Art. 17]" }
    });
    reviewsPseudonymized = result.count;
  }
  if (reviewsPseudonymized) {
    tables.push({ name: "GuestReview", rowsAffected: reviewsPseudonymized, action: "pseudonymized" });
  }

  // --- Guest table: pseudonymize PII ---
  let guestsPseudonymized = 0;
  for (const guestId of guestIds) {
    await prisma.guest.update({
      where: { id: guestId },
      data: {
        firstName: "Erased",
        surname1: "Erased",
        surname2: null,
        email: `erased+${guestId}@hotelos.example`,
        phone: null,
        residenceAddress: null,
        documentNumber: null
      }
    });
    guestsPseudonymized++;
  }
  if (guestsPseudonymized) {
    tables.push({
      name: "Guest",
      rowsAffected: guestsPseudonymized,
      action: "pseudonymized",
      note: "PII fields nulled or replaced. Row retained because it is referenced by reservations/folios."
    });
  }

  // --- GuestProfile: pseudonymize PII ---
  let profilesPseudonymized = 0;
  for (const profileId of guestProfileIds) {
    await prisma.guestProfile.update({
      where: { id: profileId },
      data: {
        displayName: "Erased",
        email: `erased+${profileId}@hotelos.example`,
        phone: null,
        preferencesJson: {} as never,
        consentJson: { erasedAt: new Date().toISOString() } as never
      }
    });
    profilesPseudonymized++;
  }
  if (profilesPseudonymized) {
    tables.push({ name: "GuestProfile", rowsAffected: profilesPseudonymized, action: "pseudonymized" });
  }

  const summary: ErasureSummary = {
    executedAt: new Date().toISOString(),
    confirmRetentionOverride: options.confirmRetentionOverride,
    tables
  };

  const updated = await prisma.gdprRequest.update({
    where: { id: requestId },
    data: {
      status: "completed",
      completedAt: new Date(),
      fulfillmentMetadataJson: summary as never,
      assigneeUserId: userId
    }
  });

  recordDomainEvent({
    organizationId: request.organizationId,
    propertyId: request.propertyId ?? "",
    entityType: "gdpr_request",
    entityId: request.id,
    eventType: "GdprErasureExecuted",
    payload: {
      subjectEmail: request.subjectEmail,
      guestIds,
      tables: summary.tables.map((t) => ({ name: t.name, rowsAffected: t.rowsAffected, action: t.action }))
    },
    actorType: "user",
    actorUserId: userId,
    correlationId: createId("corr")
  });

  recordAuditEvent({
    organizationId: request.organizationId,
    propertyId: request.propertyId ?? "",
    actorUserId: userId,
    actorType: "user",
    action: "GDPR_ERASURE_EXECUTED",
    entityType: "gdpr_request",
    entityId: request.id,
    afterJson: { tables: summary.tables, confirmRetentionOverride: options.confirmRetentionOverride },
    correlationId: createId("corr")
  });

  return { request: updated, summary };
}

export async function listRequests(input: {
  organizationId: string;
  status?: string;
  requestType?: string;
}) {
  return prisma.gdprRequest.findMany({
    where: {
      organizationId: input.organizationId,
      ...(input.status ? { status: input.status } : {}),
      ...(input.requestType ? { requestType: input.requestType } : {})
    },
    orderBy: { requestedAt: "desc" },
    take: 200
  });
}

export async function getRequest(id: string) {
  return prisma.gdprRequest.findUnique({ where: { id } });
}

export async function rejectRequest(id: string, reason: string, userId?: string) {
  if (!reason || !reason.trim()) throw new Error("Rejection reason is required.");
  const updated = await prisma.gdprRequest.update({
    where: { id },
    data: { status: "rejected", rejectedAt: new Date(), rejectedReason: reason }
  });
  recordDomainEvent({
    organizationId: updated.organizationId,
    propertyId: updated.propertyId ?? "",
    entityType: "gdpr_request",
    entityId: updated.id,
    eventType: "GdprRequestRejected",
    payload: { reason },
    actorType: "user",
    actorUserId: userId,
    correlationId: createId("corr")
  });
  return updated;
}
