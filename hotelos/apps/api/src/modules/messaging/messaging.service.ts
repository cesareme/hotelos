import { prisma } from "@hotelos/database";
import { recordAuditEvent, recordDomainEvent } from "../audit/audit.service.js";
import { createId, nowIso } from "../../lib/ids.js";
import { demoStore, type ConversationRecord, type MessageRecord, type ServiceRequestRecord, type UserContext } from "../../lib/demo-store.js";
import { requirePermissions } from "../auth/auth.service.js";
import { isLlmConfigured, llmComplete } from "../../lib/llm.js";
import { recordToolCall } from "../ai-operations/pipeline.service.js";
import type { ChatAttachment, ChatAttachmentDraft, ChatAttachmentType } from "@hotelos/shared";

export const GUEST_AI_DISCLOSURE =
  "Hola, soy el asistente de IA del hotel. Puedo ayudarle con disponibilidad, reservas, información del hotel y peticiones de servicio. Un miembro del equipo puede atenderle en cualquier momento.";

export const MAX_CHAT_ATTACHMENTS_PER_MESSAGE = 8;
export const GUEST_CHAT_ATTACHMENT_POLICY =
  "Chat attachments may include photos, camera photos, files, and voice notes. Identity-document scans must use the guest-register scan flow, not guest messaging.";

type PrismaConversationRow = NonNullable<Awaited<ReturnType<typeof prisma.conversation.findUnique>>>;
type PrismaMessageRow = NonNullable<Awaited<ReturnType<typeof prisma.message.findUnique>>>;
type PrismaAttachmentRow = NonNullable<Awaited<ReturnType<typeof prisma.messageAttachment.findUnique>>>;

function mapConversation(row: PrismaConversationRow): ConversationRecord {
  return {
    id: row.id,
    propertyId: row.propertyId,
    guestId: row.guestId ?? undefined,
    reservationId: row.reservationId ?? undefined,
    channel: row.channel as ConversationRecord["channel"],
    status: row.status as ConversationRecord["status"],
    aiEnabled: row.aiEnabled,
    createdAt: row.createdAt.toISOString()
  };
}

function mapAttachment(row: PrismaAttachmentRow): ChatAttachment {
  return {
    id: row.id,
    attachmentType: row.attachmentType as ChatAttachmentType,
    objectKey: row.objectKey,
    fileName: row.fileName ?? undefined,
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes ?? undefined,
    durationMs: row.durationMs ?? undefined,
    width: row.width ?? undefined,
    height: row.height ?? undefined,
    privacyReviewRequired: row.privacyReviewRequired,
    createdAt: row.createdAt.toISOString()
  };
}

function mapMessage(row: PrismaMessageRow, attachments: PrismaAttachmentRow[] = []): MessageRecord {
  return {
    id: row.id,
    conversationId: row.conversationId,
    senderType: row.senderType as MessageRecord["senderType"],
    body: row.body,
    language: row.language ?? undefined,
    sentAt: row.sentAt.toISOString(),
    metadataJson:
      row.metadataJson === null || row.metadataJson === undefined
        ? undefined
        : (row.metadataJson as Record<string, unknown>),
    attachments: attachments.map(mapAttachment)
  };
}

export async function listConversations(propertyId: string): Promise<ConversationRecord[]> {
  const rows = await prisma.conversation.findMany({
    where: { propertyId },
    orderBy: { createdAt: "asc" }
  });
  return rows.map(mapConversation);
}

export async function listMessages(conversationId: string): Promise<MessageRecord[]> {
  const rows = await prisma.message.findMany({
    where: { conversationId },
    orderBy: { sentAt: "asc" }
  });
  if (rows.length === 0) {
    return [];
  }
  const attachmentRows = await prisma.messageAttachment.findMany({
    where: { messageId: { in: rows.map((row) => row.id) } },
    orderBy: { createdAt: "asc" }
  });
  const byMessage = new Map<string, PrismaAttachmentRow[]>();
  for (const att of attachmentRows) {
    const bucket = byMessage.get(att.messageId) ?? [];
    bucket.push(att);
    byMessage.set(att.messageId, bucket);
  }
  return rows.map((row) => mapMessage(row, byMessage.get(row.id) ?? []));
}

function assertAttachmentType(value: unknown): asserts value is ChatAttachmentType {
  if (value !== "photo" && value !== "camera_photo" && value !== "file" && value !== "voice_note") {
    throw new Error("Unsupported chat attachment type.");
  }
}

export function prepareChatAttachments(attachments: ChatAttachmentDraft[] = []): ChatAttachment[] {
  if (attachments.length > MAX_CHAT_ATTACHMENTS_PER_MESSAGE) {
    throw new Error(`A message can include at most ${MAX_CHAT_ATTACHMENTS_PER_MESSAGE} attachments.`);
  }

  return attachments.map((attachment) => {
    assertAttachmentType(attachment.attachmentType);

    if (typeof attachment.objectKey !== "string" || !attachment.objectKey.trim()) {
      throw new Error("Chat attachment objectKey is required.");
    }

    if (typeof attachment.mimeType !== "string" || !attachment.mimeType.trim()) {
      throw new Error("Chat attachment mimeType is required.");
    }

    if (attachment.attachmentType === "voice_note" && (!attachment.durationMs || attachment.durationMs <= 0)) {
      throw new Error("Voice notes require a positive durationMs value.");
    }

    if (attachment.attachmentType === "file" && (typeof attachment.fileName !== "string" || !attachment.fileName.trim())) {
      throw new Error("File attachments require a fileName.");
    }

    const privacyReviewRequired =
      attachment.privacyReviewRequired ||
      attachment.attachmentType === "photo" ||
      attachment.attachmentType === "camera_photo";

    return {
      id: createId("att"),
      attachmentType: attachment.attachmentType,
      objectKey: attachment.objectKey,
      fileName: attachment.fileName,
      mimeType: attachment.mimeType,
      sizeBytes: attachment.sizeBytes,
      durationMs: attachment.durationMs,
      width: attachment.width,
      height: attachment.height,
      privacyReviewRequired,
      createdAt: nowIso()
    };
  });
}

export async function sendConversationMessage(input: {
  context: UserContext;
  conversationId: string;
  senderType: MessageRecord["senderType"];
  body: string;
  language?: string;
  metadataJson?: Record<string, unknown>;
  attachments?: ChatAttachmentDraft[];
  correlationId: string;
}): Promise<MessageRecord> {
  const conversationRow = await prisma.conversation.findUnique({ where: { id: input.conversationId } });
  if (!conversationRow) {
    throw new Error("Conversation was not found.");
  }

  const attachments = prepareChatAttachments(input.attachments);
  if (!input.body.trim() && attachments.length === 0) {
    throw new Error("Message body or attachment is required.");
  }

  let metadataJson = input.metadataJson;
  if (input.senderType === "ai" && !input.body.includes("AI")) {
    metadataJson = { ...metadataJson, aiDisclosureShown: true };
  }

  const messageId = createId("msg");
  const sentAt = new Date();

  await prisma.$transaction(async (tx) => {
    await tx.message.create({
      data: {
        id: messageId,
        conversationId: conversationRow.id,
        senderType: input.senderType,
        body: input.body,
        language: input.language ?? null,
        sentAt,
        metadataJson: metadataJson === undefined ? undefined : (metadataJson as object)
      }
    });

    if (attachments.length > 0) {
      await tx.messageAttachment.createMany({
        data: attachments.map((attachment) => ({
          id: attachment.id,
          messageId,
          attachmentType: attachment.attachmentType,
          objectKey: attachment.objectKey,
          fileName: attachment.fileName ?? null,
          mimeType: attachment.mimeType,
          sizeBytes: attachment.sizeBytes ?? null,
          durationMs: attachment.durationMs ?? null,
          width: attachment.width ?? null,
          height: attachment.height ?? null,
          privacyReviewRequired: attachment.privacyReviewRequired,
          createdAt: new Date(attachment.createdAt)
        }))
      });
    }
  });

  const message: MessageRecord = {
    id: messageId,
    conversationId: conversationRow.id,
    senderType: input.senderType,
    body: input.body,
    language: input.language,
    sentAt: sentAt.toISOString(),
    metadataJson,
    attachments
  };

  recordAuditEvent({
    organizationId: input.context.organizationId,
    propertyId: conversationRow.propertyId,
    actorUserId: input.context.userId,
    actorType: input.senderType === "ai" ? "ai" : "user",
    action: "GUEST_MESSAGE_SENT",
    entityType: "message",
    entityId: message.id,
    afterJson: {
      ...message,
      attachmentCount: attachments.length,
      attachmentTypes: attachments.map((attachment) => attachment.attachmentType)
    },
    correlationId: input.correlationId
  });

  recordDomainEvent({
    organizationId: input.context.organizationId,
    propertyId: conversationRow.propertyId,
    entityType: "conversation",
    entityId: conversationRow.id,
    eventType: "GuestMessageSent",
    payload: {
      messageId: message.id,
      senderType: message.senderType,
      attachmentCount: attachments.length,
      attachmentTypes: attachments.map((attachment) => attachment.attachmentType)
    },
    actorType: input.senderType === "ai" ? "ai" : "user",
    actorUserId: input.context.userId,
    correlationId: input.correlationId
  });

  recordDomainEvent({
    organizationId: input.context.organizationId,
    propertyId: conversationRow.propertyId,
    entityType: "message",
    entityId: message.id,
    eventType: "MessageCreated",
    payload: {
      conversationId: conversationRow.id,
      senderType: message.senderType,
      language: message.language,
      attachmentCount: attachments.length
    },
    actorType: input.senderType === "ai" ? "ai" : "user",
    actorUserId: input.context.userId,
    correlationId: input.correlationId
  });

  return message;
}

// Drafts a reply to a guest message. Uses a REAL LLM when one is configured
// (AI_PROVIDER + AI_PROVIDER_API_KEY); otherwise falls back to deterministic
// rules so the product works with zero external dependencies. The returned
// `source` ("ai" | "rules") lets the UI be honest about how the draft was made.
// Every run is recorded as a real AiToolCall (pipeline telemetry).
const REPLY_LANGUAGES: Record<string, string> = {
  es: "español",
  en: "inglés",
  fr: "francés",
  de: "alemán",
  it: "italiano",
  pt: "portugués"
};

export async function createAiReplyDraft(input: {
  context: UserContext;
  conversationId: string;
  guestQuestion: string;
  /** Optional reply tone hint, e.g. "cordial" | "formal" | "cercano" | "breve". */
  tone?: string;
  /** Optional reply language code ("es"|"en"|...). Omit/"auto" = match the guest. */
  language?: string;
  correlationId: string;
}): Promise<{ disclosure: string; draft: string; requiresHumanReview: boolean; source: "ai" | "rules" }> {
  requirePermissions(input.context, ["ai.tool.execute"]);

  const lower = input.guestQuestion.toLowerCase();
  const ruleAnswer = lower.includes("parking")
    ? "El parking está disponible bajo petición. Recepción puede confirmar la disponibilidad y añadirlo a su reserva."
    : "Con mucho gusto le ayudo con eso. Un miembro del equipo puede intervenir en cualquier momento.";

  let answer = ruleAnswer;
  let source: "ai" | "rules" = "rules";
  let model: string | undefined;
  let tokensInput: number | undefined;
  let tokensOutput: number | undefined;
  let errorMessage: string | undefined;
  const startedAt = Date.now();

  if (isLlmConfigured()) {
    try {
      const langName = input.language && input.language !== "auto" ? REPLY_LANGUAGES[input.language] : undefined;
      const languageHint = langName ? ` Responde SIEMPRE en ${langName}.` : " Responde en el mismo idioma del huésped.";
      const toneHint = input.tone ? ` Usa un tono ${input.tone}.` : "";
      const result = await llmComplete({
        system:
          "Eres el asistente de recepción de un hotel en España. Responde al mensaje del huésped de forma breve, " +
          "cordial y profesional." +
          languageHint +
          toneHint +
          " No inventes datos concretos (precios, disponibilidad, políticas): si no los sabes, indica que recepción lo confirmará. Máximo 4 frases.",
        prompt: input.guestQuestion,
        maxTokens: 250
      });
      if (result.configured && result.text) {
        answer = result.text;
        source = "ai";
        model = result.model;
        tokensInput = result.tokensInput;
        tokensOutput = result.tokensOutput;
      }
    } catch (error) {
      // Provider/network failure — keep the deterministic fallback, but record it.
      errorMessage = error instanceof Error ? error.message : String(error);
    }
  }

  const draft = `${GUEST_AI_DISCLOSURE}\n\n${answer}`;
  const requiresHumanReview = /complaint|angry|refund|unsafe|emergency|queja|reembolso|urgente|emergencia/i.test(
    input.guestQuestion
  );

  // Real pipeline telemetry — this is what makes the AI Pipeline dashboard reflect reality.
  await recordToolCall({
    organizationId: input.context.organizationId,
    propertyId: input.context.propertyId,
    userId: input.context.userId,
    conversationId: input.conversationId,
    toolName: "guest_message_reply",
    status: errorMessage ? "failed" : "completed",
    inputJson: { guestQuestion: input.guestQuestion },
    outputJson: { draft, source },
    confidence: source === "ai" ? 0.9 : undefined,
    requiredConfirmation: true,
    automationLevel: "suggest_and_confirm",
    model,
    latencyMs: Date.now() - startedAt,
    tokensInput,
    tokensOutput,
    errorMessage
  }).catch(() => undefined);

  recordAuditEvent({
    organizationId: input.context.organizationId,
    propertyId: input.context.propertyId,
    actorUserId: input.context.userId,
    actorType: "ai",
    action: "AI_GUEST_REPLY_DRAFTED",
    entityType: "conversation",
    entityId: input.conversationId,
    afterJson: { guestQuestion: input.guestQuestion, draft, source },
    correlationId: input.correlationId
  });

  return { disclosure: GUEST_AI_DISCLOSURE, draft, requiresHumanReview, source };
}

function mapServiceRequest(row: NonNullable<Awaited<ReturnType<typeof prisma.serviceRequest.findUnique>>>): ServiceRequestRecord {
  return {
    id: row.id,
    propertyId: row.propertyId,
    reservationId: row.reservationId ?? undefined,
    guestId: row.guestId ?? undefined,
    requestType: row.requestType as ServiceRequestRecord["requestType"],
    status: row.status as ServiceRequestRecord["status"],
    assignedDepartment: (row.assignedDepartment as ServiceRequestRecord["assignedDepartment"]) ?? undefined,
    createdAt: row.createdAt.toISOString()
  };
}

function mirrorServiceRequest(request: ServiceRequestRecord): void {
  const idx = demoStore.serviceRequests.findIndex((r) => r.id === request.id);
  if (idx >= 0) demoStore.serviceRequests[idx] = request;
  else demoStore.serviceRequests.push(request);
}

export async function createServiceRequest(input: {
  context: UserContext;
  propertyId: string;
  reservationId?: string;
  guestId?: string;
  requestType: ServiceRequestRecord["requestType"];
  assignedDepartment?: ServiceRequestRecord["assignedDepartment"];
  correlationId: string;
}): Promise<ServiceRequestRecord> {
  const created = await prisma.serviceRequest.create({
    data: {
      propertyId: input.propertyId,
      reservationId: input.reservationId ?? null,
      guestId: input.guestId ?? null,
      requestType: input.requestType,
      status: "open",
      assignedDepartment: input.assignedDepartment ?? null
    }
  });
  const request = mapServiceRequest(created);
  mirrorServiceRequest(request); // keep legacy in-memory readers consistent

  recordAuditEvent({
    organizationId: input.context.organizationId,
    propertyId: input.propertyId,
    actorUserId: input.context.userId,
    actorType: "user",
    action: "SERVICE_REQUEST_CREATED",
    entityType: "service_request",
    entityId: request.id,
    afterJson: request,
    correlationId: input.correlationId
  });

  return request;
}

export async function updateServiceRequest(input: {
  context: UserContext;
  serviceRequestId: string;
  patch: Partial<Pick<ServiceRequestRecord, "status" | "assignedDepartment">>;
  correlationId: string;
}): Promise<ServiceRequestRecord> {
  const existing = await prisma.serviceRequest.findUnique({ where: { id: input.serviceRequestId } });
  if (!existing) {
    throw new Error("Service request was not found.");
  }
  const before = mapServiceRequest(existing);

  const updated = await prisma.serviceRequest.update({
    where: { id: input.serviceRequestId },
    data: {
      ...(input.patch.status !== undefined ? { status: input.patch.status } : {}),
      ...(input.patch.assignedDepartment !== undefined ? { assignedDepartment: input.patch.assignedDepartment ?? null } : {})
    }
  });
  const request = mapServiceRequest(updated);
  mirrorServiceRequest(request);

  recordAuditEvent({
    organizationId: input.context.organizationId,
    propertyId: request.propertyId,
    actorUserId: input.context.userId,
    actorType: "user",
    action: "SERVICE_REQUEST_UPDATED",
    entityType: "service_request",
    entityId: request.id,
    beforeJson: before,
    afterJson: request,
    correlationId: input.correlationId
  });

  return request;
}

export function sendWelcomeMessage(input: {
  context: UserContext;
  reservationId: string;
  guestId: string;
  correlationId: string;
}): { status: "queued"; channel: "whatsapp" | "email" | "app" } {
  recordAuditEvent({
    organizationId: input.context.organizationId,
    propertyId: input.context.propertyId,
    actorUserId: input.context.userId,
    actorType: "system",
    action: "WELCOME_MESSAGE_QUEUED",
    entityType: "reservation",
    entityId: input.reservationId,
    afterJson: { guestId: input.guestId, channel: "app" },
    correlationId: input.correlationId
  });

  recordDomainEvent({
    organizationId: input.context.organizationId,
    propertyId: input.context.propertyId,
    entityType: "reservation",
    entityId: input.reservationId,
    eventType: "GuestMessageSent",
    payload: { guestId: input.guestId, template: "welcome" },
    actorType: "system",
    actorUserId: input.context.userId,
    correlationId: input.correlationId
  });

  return { status: "queued", channel: "app" };
}
