import type { CheckInFromScanRequest, CheckInFromScanResponse } from "@hotelos/shared";
import { buildCheckInConfirmationCard } from "@hotelos/ai-tools";
import { enforceSpanishIdScanPolicy } from "@hotelos/compliance";
import { prisma, type Prisma } from "@hotelos/database";
import type { UserContext } from "../../lib/demo-store.js";
import { BadRequestError, ConflictError, NotFoundError } from "../../lib/http-error.js";
import { recordAuditEvent } from "../audit/audit.service.js";
import { recordToolCall } from "../ai-operations/pipeline.service.js";
import { requirePermissions } from "../auth/auth.service.js";
import { checkGuestRegisterCompleteness, markGuestRegisterSigned, prepareGuestRegisterRecord, queueSesHospedajesSubmission } from "../compliance/compliance.service.js";
import { canAssignRoom } from "../pms/inventory.engine.js";
import { checkInReservation, matchGuestToReservation } from "../pms/pms.service.js";
import { sendWelcomeMessage } from "../messaging/messaging.service.js";

// Tanda L2 (L2-04): la confirmación HITL del check-in por escaneo vive en
// `ai_pending_confirmations` (AiPendingConfirmation, L2-01) con caducidad de
// 24 h, y la llamada de herramienta en `ai_tool_calls` a través de
// recordToolCall (pipeline.service, vocabulario real: pending|completed|
// rejected). La ejecución busca la confirmación por id + organización +
// estado `pending` (404 opaco en cualquier otro caso) y cierra las dos filas.

const CONFIRMATION_TTL_MS = 24 * 60 * 60 * 1000;
const CHECK_IN_TOOL_NAME = "checkInReservation";

function asJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value ?? {})) as Prisma.InputJsonValue;
}

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
  const guestRegisterRecord = await prepareGuestRegisterRecord({
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

  const roomId = roomValidation.roomId ?? reservation.assignedRoomId ?? null;
  if (!roomId) {
    return { status: "rejected", errors: ["No se pudo determinar la habitación de la reserva."] };
  }

  const confirmation = await prisma.aiPendingConfirmation.create({
    data: {
      organizationId: input.context.organizationId,
      propertyId: input.request.propertyId,
      userId: input.context.userId,
      type: "check_in_from_scan",
      reservationId: reservation.id,
      roomId,
      guestId: guest.id,
      guestRegisterRecordId: guestRegisterRecord.id,
      cardJson: asJson(card),
      requiredSignature: completeness.signatureRequired,
      status: "pending",
      expiresAt: new Date(Date.now() + CONFIRMATION_TTL_MS)
    },
    select: { id: true }
  });

  // La llamada de herramienta queda `pending` hasta que el usuario confirme;
  // outputJson.confirmationId enlaza las dos filas (AiToolCall no tiene columna
  // para la confirmación).
  await recordToolCall({
    organizationId: input.context.organizationId,
    propertyId: input.request.propertyId,
    userId: input.context.userId,
    toolName: CHECK_IN_TOOL_NAME,
    inputJson: asJson(input.request),
    outputJson: asJson({ card, confirmationId: confirmation.id }),
    confidence: 0.92,
    requiredConfirmation: true,
    status: "pending"
  });

  const confirmationId = confirmation.id;

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
}): Promise<{ status: "executed"; reservationId: string; roomId: string; queuedSubmissionId: string | null; warnings?: string[] }> {
  const confirmation = await prisma.aiPendingConfirmation.findFirst({
    where: { id: input.confirmationId, organizationId: input.context.organizationId, status: "pending" }
  });
  if (!confirmation) {
    throw new NotFoundError("Confirmación no encontrada.");
  }
  if (confirmation.expiresAt.getTime() <= Date.now()) {
    await prisma.aiPendingConfirmation.update({ where: { id: confirmation.id }, data: { status: "expired" } });
    throw new ConflictError("La confirmación ha caducado: vuelve a escanear el documento.", { code: "CONFIRMATION_EXPIRED", confirmationId: confirmation.id });
  }

  if (confirmation.requiredSignature && !input.signatureObjectKey) {
    throw new BadRequestError("Se necesita la firma del huésped antes de ejecutar el check-in.");
  }

  await markGuestRegisterSigned({
    context: input.context,
    guestRegisterRecordId: confirmation.guestRegisterRecordId,
    signatureObjectKey: input.signatureObjectKey,
    correlationId: input.correlationId
  });

  const roomId = confirmation.roomId ?? "";
  const reservation = await checkInReservation({
    context: input.context,
    reservationId: confirmation.reservationId,
    roomId,
    signatureObjectKey: input.signatureObjectKey,
    correlationId: input.correlationId
  });

  // Tanda 3: the SES row is created synchronously in Prisma; its id is the one
  // /ses/submissions/:id serves. A 409 SES_ESTABLISHMENT_INCOMPLETE propagates.
  // The check-in itself is done and the guest register is signed: an
  // incomplete SES establishment profile (409 SES_ESTABLISHMENT_INCOMPLETE)
  // must not undo that nor silence the welcome message. The failed row exists
  // in Prisma and is re-queued by the scheduler once the profile is fixed.
  let submission: Awaited<ReturnType<typeof queueSesHospedajesSubmission>> | null = null;
  let sesWarning: string | null = null;
  try {
    submission = await queueSesHospedajesSubmission({
      context: input.context,
      guestRegisterRecordId: confirmation.guestRegisterRecordId,
      submissionType: "checkin",
      correlationId: input.correlationId
    });
  } catch (error) {
    const details = (error as { details?: { code?: string; missing?: string[]; submissionId?: string } }).details;
    if (details?.code !== "SES_ESTABLISHMENT_INCOMPLETE") throw error;
    sesWarning = `Parte SES no enviado: faltan datos del establecimiento (${(details.missing ?? []).join(", ")}).`;
    console.warn("[ai.check-in] SES submission blocked by incomplete establishment profile", {
      reservationId: reservation.id,
      correlationId: input.correlationId,
      missing: details.missing ?? []
    });
    if (details.submissionId) submission = { id: details.submissionId } as Awaited<ReturnType<typeof queueSesHospedajesSubmission>>;
  }

  sendWelcomeMessage({
    context: input.context,
    reservationId: reservation.id,
    guestId: confirmation.guestId,
    correlationId: input.correlationId
  });

  const executedAt = new Date();
  await prisma.aiPendingConfirmation.update({
    where: { id: confirmation.id },
    data: { status: "executed", executedAt }
  });
  const toolCall = await prisma.aiToolCall.findFirst({
    where: {
      organizationId: input.context.organizationId,
      toolName: CHECK_IN_TOOL_NAME,
      status: "pending",
      outputJson: { path: ["confirmationId"], equals: confirmation.id }
    },
    select: { id: true, outputJson: true }
  });
  if (toolCall) {
    const previousOutput = toolCall.outputJson && typeof toolCall.outputJson === "object" && !Array.isArray(toolCall.outputJson) ? (toolCall.outputJson as Record<string, unknown>) : {};
    await prisma.aiToolCall.update({
      where: { id: toolCall.id },
      data: {
        status: "completed",
        confirmedBy: input.context.userId,
        outputJson: asJson({
          ...previousOutput,
          execution: {
            reservationId: reservation.id,
            roomId,
            queuedSubmissionId: submission?.id ?? null,
            executedAt: executedAt.toISOString(),
            ...(sesWarning ? { warnings: [sesWarning] } : {})
          }
        })
      }
    });
  }

  return {
    status: "executed",
    reservationId: reservation.id,
    roomId,
    queuedSubmissionId: submission?.id ?? null,
    ...(sesWarning ? { warnings: [sesWarning] } : {})
  };
}
