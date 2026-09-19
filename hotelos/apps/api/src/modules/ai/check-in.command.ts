import type { CheckInFromScanRequest, CheckInFromScanResponse, PermissionKey } from "@hotelos/shared";
import { AI_ERROR_CODES, labelFor } from "@hotelos/ai-core";
import type { AiErrorCode } from "@hotelos/ai-core";
import { evaluateToolGates } from "@hotelos/ai-core/runner";
import type { RunnerContext, ToolGateDecision } from "@hotelos/ai-core/runner";
import { buildCheckInConfirmationCard, TOOL_DEFINITIONS } from "@hotelos/ai-tools";
import { enforceSpanishIdScanPolicy } from "@hotelos/compliance";
import { prisma, type Prisma } from "@hotelos/database";
import type { UserContext } from "../../lib/demo-store.js";
import { BadRequestError, ConflictError, NotFoundError } from "../../lib/http-error.js";
import { recordAuditEvent } from "../audit/audit.service.js";
import { recordToolCall } from "../ai-operations/pipeline.service.js";
import { buildRunnerPorts } from "../ai-operations/tool-runner.service.js";
import { requirePermissions } from "../auth/auth.service.js";
import { checkGuestRegisterCompleteness, markGuestRegisterSigned, prepareGuestRegisterRecord, queueSesHospedajesSubmission } from "../compliance/compliance.service.js";
import { canAssignRoom } from "../pms/inventory.engine.js";
import { checkInReservation, matchGuestToReservation } from "../pms/pms.service.js";
import { sendWelcomeMessage } from "../messaging/messaging.service.js";
import { getEnabledModuleCodes } from "../product-modules/product-modules.service.js";

// Tanda L2 (L2-04): la confirmación HITL del check-in por escaneo vive en
// `ai_pending_confirmations` (AiPendingConfirmation, L2-01) con caducidad de
// 24 h, y la llamada de herramienta en `ai_tool_calls` a través de
// recordToolCall (pipeline.service, vocabulario real: pending|completed|
// rejected). La ejecución busca la confirmación por id + organización +
// estado `pending` (404 opaco en cualquier otro caso) y cierra las dos filas.
//
// Tanda L6a (lote 4): antes de crear la confirmación se evalúan las puertas del
// tool runner (evaluateToolGates de @hotelos/ai-core/runner: aiEnabled de la
// propiedad, ajuste por herramienta, matriz de riesgo con los hechos del escaneo,
// gate de gobernanza y presupuesto). Una denegación responde `rejected` con la
// etiqueta en español, deja una fila `rejected` en ai_tool_calls y un evento de
// auditoría AI_TOOL_DENIED (actorType "ai"). El vocabulario pending → completed y
// el enlace outputJson.confirmationId se conservan tal cual (tests L2).

const CONFIRMATION_TTL_MS = 24 * 60 * 60 * 1000;
const CHECK_IN_TOOL_NAME = "checkInReservation";
const CHECK_IN_CONFIDENCE = 0.92;
/** Campos del parte de viajeros que ningún documento de identidad aporta (se piden en recepción). */
const CONTACT_FIELDS: ReadonlySet<string> = new Set(["phone", "email"]);

/**
 * El comando llega por POST /ai/commands/check-in-from-scan, que el manifiesto
 * (route-permissions.ts:935-940) no condiciona al módulo `ai_front_desk` de la definición
 * (registry.ts:65) y que tests/integration/l2-persistencia-plataforma.test.mts:217-244
 * ejercita sobre un hotel recién creado, sin ese módulo (no está en
 * DEFAULT_ENABLED_MODULE_CODES). Mientras César no decida condicionar la ruta al módulo,
 * la puerta de módulo del runner se sustituye aquí por la comprobación de los permisos de la
 * definición; el resto de puertas se aplican íntegras. Poner a `true` exige activar
 * `ai_front_desk` en la propiedad (enableModules) antes de llamar al comando.
 */
export const CHECK_IN_REQUIRES_FRONT_DESK_MODULE = false;

function asJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value ?? {})) as Prisma.InputJsonValue;
}

function checkInRunnerContext(user: UserContext, propertyId: string, correlationId: string): RunnerContext {
  return {
    organizationId: user.organizationId,
    propertyId,
    userId: user.userId,
    permissions: [...user.permissions],
    enabledModules: getEnabledModuleCodes(propertyId),
    correlationId,
    source: "image",
    locale: "es-ES",
    ...(user.deviceId ? { deviceId: user.deviceId } : {})
  };
}

/** Solo permisos de la definición (ver CHECK_IN_REQUIRES_FRONT_DESK_MODULE). */
function permissionsOnlyGate(input: { toolName: string; userPermissions: PermissionKey[] }): { allowed: true } | { allowed: false; reason: string } {
  const definition = TOOL_DEFINITIONS.find((candidate) => candidate.name === input.toolName);
  const missing = (definition?.requiredPermissions ?? []).filter((permission) => !input.userPermissions.includes(permission));
  return missing.length === 0 ? { allowed: true } : { allowed: false, reason: `Missing permissions: ${missing.join(", ")}.` };
}

/** Etiqueta en español de una denegación de las puertas del runner. */
export function checkInDenialMessage(decision: Extract<ToolGateDecision, { mode: "deny" }>): string {
  if ((AI_ERROR_CODES as readonly string[]).includes(decision.reason)) return `${labelFor(decision.reason as AiErrorCode)}.`;
  if (decision.reason === "safety") return `La política de seguridad de IA bloquea el check-in: ${decision.message}`;
  return decision.message;
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

  // Puertas del tool runner ANTES de escribir nada (parte de viajeros incluido):
  // una denegación no deja efectos en el dominio, solo la fila rejected y su auditoría.
  // Hecho de seguridad: los campos del parte que faltan y que un documento de identidad
  // SÍ aporta (nombre, documento, nacionalidad, nacimiento); los de contacto (phone en
  // REQUIRED_GUEST_REGISTER_FIELDS) se recogen en recepción antes del envío a SES y no
  // bloquean el check-in (tests/integration/l2-persistencia-plataforma.test.mts:226-235).
  const decision = await evaluateToolGates({
    toolName: CHECK_IN_TOOL_NAME,
    ctx: checkInRunnerContext(input.context, input.request.propertyId, input.correlationId),
    facts: { storesIdImage: input.request.documentImageStored !== false, guestRegisterMissingFields: completeness.missingFields.filter((field) => !CONTACT_FIELDS.has(field)) },
    confidence: CHECK_IN_CONFIDENCE,
    ports: buildRunnerPorts(CHECK_IN_REQUIRES_FRONT_DESK_MODULE ? {} : { canExecuteToolForModules: permissionsOnlyGate }, { user: input.context, correlationId: input.correlationId })
  });
  if (decision.mode === "deny") {
    const message = checkInDenialMessage(decision);
    const denied = await recordToolCall({
      organizationId: input.context.organizationId,
      propertyId: input.request.propertyId,
      userId: input.context.userId,
      toolName: CHECK_IN_TOOL_NAME,
      inputJson: asJson({ propertyId: input.request.propertyId, roomNumber: input.request.roomNumber, reservationId: reservation.id, extractedFields: Object.keys(input.request.documentExtractedFields) }),
      outputJson: asJson({ denied: { reason: decision.reason, message, riskLevel: decision.riskLevel, ...(decision.details ? { details: decision.details } : {}) } }),
      confidence: CHECK_IN_CONFIDENCE,
      requiredConfirmation: true,
      status: "rejected",
      errorMessage: decision.reason,
      ...(decision.automationLevel ? { automationLevel: decision.automationLevel } : {})
    });
    recordAuditEvent({
      organizationId: input.context.organizationId,
      propertyId: input.request.propertyId,
      actorUserId: input.context.userId,
      actorType: "ai",
      action: "AI_TOOL_DENIED",
      entityType: "ai_tool_call",
      entityId: denied.id,
      afterJson: { toolName: CHECK_IN_TOOL_NAME, reason: decision.reason, message, riskLevel: decision.riskLevel, reservationId: reservation.id },
      deviceId: input.context.deviceId,
      correlationId: input.correlationId
    });
    return { status: "rejected", errors: [message] };
  }

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
    // Tanda L6a (lote 4): la ejecución de la herramienta queda auditada como acto de la IA
    // confirmado por la persona (mismo vocabulario que el tool runner).
    recordAuditEvent({
      organizationId: input.context.organizationId,
      propertyId: confirmation.propertyId,
      actorUserId: input.context.userId,
      actorType: "ai",
      action: "AI_TOOL_EXECUTED",
      entityType: "ai_tool_call",
      entityId: toolCall.id,
      afterJson: {
        toolName: CHECK_IN_TOOL_NAME,
        status: "completed",
        confirmedBy: input.context.userId,
        confirmationId: confirmation.id,
        reservationId: reservation.id,
        roomId,
        queuedSubmissionId: submission?.id ?? null,
        executedAt: executedAt.toISOString()
      },
      deviceId: input.context.deviceId,
      correlationId: input.correlationId
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
