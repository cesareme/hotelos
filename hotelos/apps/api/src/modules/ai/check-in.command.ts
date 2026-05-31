import type { CheckInFromScanRequest, CheckInFromScanResponse } from "@hotelos/shared";
import { buildCheckInConfirmationCard } from "@hotelos/ai-tools";
import { enforceSpanishIdScanPolicy } from "@hotelos/compliance";
import { createId, nowIso } from "../../lib/ids.js";
import { demoStore, type UserContext } from "../../lib/demo-store.js";
import { recordAuditEvent } from "../audit/audit.service.js";
import { requirePermissions } from "../auth/auth.service.js";
import { checkGuestRegisterCompleteness, markGuestRegisterSigned, prepareGuestRegisterRecord, queueSesHospedajesSubmission } from "../compliance/compliance.service.js";
import { canAssignRoom } from "../pms/inventory.engine.js";
import { checkInReservation, matchGuestToReservation } from "../pms/pms.service.js";
import { sendWelcomeMessage } from "../messaging/messaging.service.js";

export async function createCheckInFromScanConfirmation(input: {
  context: UserContext;
  request: CheckInFromScanRequest;
  correlationId: string;
}): Promise<CheckInFromScanResponse> {
  requirePermissions(input.context, ["ai.tool.execute", "pms.checkin.execute"]);

  const policy = enforceSpanishIdScanPolicy(input.request);
  if (!policy.allowed) {
    return { status: "rejected", errors: policy.errors };
  }

  recordAuditEvent({
    organizationId: input.context.organizationId,
    propertyId: input.request.propertyId,
    actorUserId: input.context.userId,
    actorType: "system",
    action: "ID_IMAGE_DISCARDED",
    entityType: "guest_identity_scan",
    afterJson: {
      imageStored: false,
      imageDiscarded: true,
      extractedFields: Object.keys(input.request.documentExtractedFields)
    },
    deviceId: input.context.deviceId,
    correlationId: input.correlationId
  });

  const { guest, reservation } = await matchGuestToReservation({
    propertyId: input.request.propertyId,
    documentFields: input.request.documentExtractedFields
  });

  const roomValidation = await canAssignRoom({
    propertyId: input.request.propertyId,
    reservationId: reservation.id,
    roomNumber: input.request.roomNumber,
    arrivalDate: reservation.arrivalDate,
    departureDate: reservation.departureDate
  });

  if (!roomValidation.allowed || !roomValidation.roomId) {
    return { status: "rejected", errors: roomValidation.warnings };
  }

  const completeness = checkGuestRegisterCompleteness(input.request.documentExtractedFields);
  const guestRegisterRecord = prepareGuestRegisterRecord({
    context: input.context,
    propertyId: input.request.propertyId,
    reservationId: reservation.id,
    guestId: guest.id,
    fields: input.request.documentExtractedFields,
    correlationId: input.correlationId
  });

  const card = buildCheckInConfirmationCard({
    request: input.request,
    reservation: {
      id: reservation.id,
      code: reservation.code,
      arrival: reservation.arrivalDate,
      departure: reservation.departureDate,
      balanceDue: 0
    },
    room: roomValidation
  });

  const confirmationId = createId("conf");
  demoStore.pendingConfirmations.push({
    id: confirmationId,
    type: "check_in_from_scan",
    propertyId: input.request.propertyId,
    organizationId: input.context.organizationId,
    userId: input.context.userId,
    reservationId: reservation.id,
    roomId: roomValidation.roomId ?? reservation.assignedRoomId ?? "",
    guestId: guest.id,
    guestRegisterRecordId: guestRegisterRecord.id,
    card,
    createdAt: nowIso(),
    requiredSignature: completeness.signatureRequired
  });

  demoStore.aiToolCalls.push({
    id: createId("ait"),
    organizationId: input.context.organizationId,
    propertyId: input.request.propertyId,
    userId: input.context.userId,
    toolName: "checkInReservation",
    inputJson: input.request,
    outputJson: card,
    confidence: 0.92,
    requiredConfirmation: true,
    status: "pending_confirmation",
    createdAt: nowIso()
  });

  return {
    status: "confirmation_required",
    confirmationId,
    card
  };
}

export async function executeConfirmation(input: {
  context: UserContext;
  confirmationId: string;
  signatureObjectKey: string;
  correlationId: string;
}): Promise<{ status: "executed"; reservationId: string; roomId: string; queuedSubmissionId: string }> {
  const confirmation = demoStore.pendingConfirmations.find((candidate) => candidate.id === input.confirmationId);
  if (!confirmation) {
    throw new Error("Confirmation was not found.");
  }

  if (confirmation.requiredSignature && !input.signatureObjectKey) {
    throw new Error("Guest signature is required before executing check-in.");
  }

  markGuestRegisterSigned({
    context: input.context,
    guestRegisterRecordId: confirmation.guestRegisterRecordId,
    signatureObjectKey: input.signatureObjectKey,
    correlationId: input.correlationId
  });

  const reservation = await checkInReservation({
    context: input.context,
    reservationId: confirmation.reservationId,
    roomId: confirmation.roomId,
    signatureObjectKey: input.signatureObjectKey,
    correlationId: input.correlationId
  });

  const submission = queueSesHospedajesSubmission({
    context: input.context,
    guestRegisterRecordId: confirmation.guestRegisterRecordId,
    submissionType: "checkin",
    correlationId: input.correlationId
  });

  sendWelcomeMessage({
    context: input.context,
    reservationId: reservation.id,
    guestId: confirmation.guestId,
    correlationId: input.correlationId
  });

  demoStore.pendingConfirmations = demoStore.pendingConfirmations.filter((candidate) => candidate.id !== confirmation.id);

  return {
    status: "executed",
    reservationId: reservation.id,
    roomId: confirmation.roomId,
    queuedSubmissionId: submission.id
  };
}
