import { prisma } from "@hotelos/database";
import { recordAuditEvent, recordDomainEvent } from "../audit/audit.service.js";
import { createId, nowIso } from "../../lib/ids.js";
import { demoStore, type ConversationRecord, type MessageRecord, type ServiceRequestRecord, type UserContext } from "../../lib/demo-store.js";
import { requirePermissions } from "../auth/auth.service.js";
import { ForbiddenError, TooManyRequestsError } from "../../lib/http-error.js";
import { getPropertyAiSettings } from "../ai-operations/property-ai.service.js";
import { dispatch, type DispatchInput, type NotificationDeliveryRecord } from "../notifications/dispatcher.service.js";
import { runAiTool } from "../ai-operations/tool-runner.service.js";
import { apiToolContextFromRunner } from "../ai-operations/tools/context.js";
import type { NotConfiguredOutput } from "../ai-operations/tools/context.js";
import { answerGuestQuestionTool } from "../ai-operations/tools/messaging.tools.js";
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
  /** Por qué se respondió por reglas (auditoría); undefined cuando el modelo respondió. */
  let note: string | undefined;

  // Tanda L6a (lote 4): interruptores de IA de la propiedad (PropertyAiSetting.aiEnabled) y de la
  // conversación (Conversation.aiEnabled). Con cualquiera en false se responde por reglas sin
  // llamar al modelo ni al runner; en el resto de casos la llamada pasa por runAiTool, que evalúa
  // las puertas (módulo, permisos, matriz de riesgo, gate, presupuesto) y es el ÚNICO que registra
  // la fila guest_message_reply (model, tokens, costEur, latencia) y la auditoría de la herramienta.
  const [propertyAi, conversation] = await Promise.all([
    getPropertyAiSettings(input.context.propertyId),
    prisma.conversation.findUnique({ where: { id: input.conversationId }, select: { aiEnabled: true } })
  ]);
  if (!propertyAi.aiEnabled) {
    note = "IA desactivada en esta propiedad: respuesta por reglas.";
  } else if (conversation && !conversation.aiEnabled) {
    note = "IA desactivada en esta conversación: respuesta por reglas.";
  } else {
    // Solo idiomas del catálogo (REPLY_LANGUAGES); "auto" u otro valor = idioma del huésped.
    const language = input.language && input.language !== "auto" && REPLY_LANGUAGES[input.language] ? input.language : undefined;
    type ReplyInput = { guestQuestion: string; tone?: string; language?: string; conversationId: string };
    type ReplyOutput = { text: string; model: string };
    try {
      const result = await runAiTool<ReplyInput, ReplyOutput | NotConfiguredOutput>({
        context: input.context,
        toolName: "answerGuestQuestion",
        recordAs: "guest_message_reply",
        legacyStatus: { succeeded: "completed", notConfigured: "completed" },
        input: { guestQuestion: input.guestQuestion, ...(input.tone ? { tone: input.tone } : {}), ...(language ? { language } : {}), conversationId: input.conversationId },
        correlationId: input.correlationId,
        source: "chat",
        conversationId: input.conversationId,
        execute: async (value, ctx) => {
          // El execute del lote 3 usa promptFrom("guest_message_reply", <texto en código>): la
          // versión publicada de ai_prompt_versions (hoy v2) sustituye al prompt en código.
          const wrapped = await answerGuestQuestionTool.execute(value, apiToolContextFromRunner(ctx, input.context));
          if (!("output" in wrapped)) return wrapped;
          const text = wrapped.output.text.trim();
          // SEC-06: la fila de telemetría no guarda el borrador (la PII vuelve restaurada del modelo): solo su tamaño y el modelo.
          return { output: { text, model: wrapped.output.model }, telemetry: wrapped.telemetry ?? null, record: { draftChars: text.length, model: wrapped.output.model, source: "ai" } };
        }
      });
      if (result.status === "executed" && result.configured && (result.output as ReplyOutput).text) {
        answer = (result.output as ReplyOutput).text;
        source = "ai";
      } else if (result.status === "executed") {
        const output = result.output as NotConfiguredOutput | undefined;
        note = output?.reason === "refusal" ? "El modelo rechazó la petición: respuesta por reglas." : "Sin modelo configurado: respuesta por reglas.";
      } else if (result.status === "denied") {
        note = `${result.message.replace(/\.$/, "")}: respuesta por reglas.`;
      } else {
        note = "El borrador ha quedado pendiente de confirmación: respuesta por reglas.";
      }
    } catch (error) {
      // Presupuesto agotado (403) o límite de peticiones (429): el runner ya registró la fila;
      // el borrador se responde por reglas con la misma forma.
      const budget = error instanceof ForbiddenError && typeof error.details === "object" && error.details !== null && (error.details as { code?: unknown }).code === "AI_BUDGET_EXCEEDED";
      if (!budget && !(error instanceof TooManyRequestsError)) throw error;
      note = `${(error as Error).message.replace(/\.$/, "")}: respuesta por reglas.`;
    }
  }

  const draft = `${GUEST_AI_DISCLOSURE}\n\n${answer}`;
  const requiresHumanReview = /complaint|angry|refund|unsafe|emergency|queja|reembolso|urgente|emergencia/i.test(
    input.guestQuestion
  );

  recordAuditEvent({
    organizationId: input.context.organizationId,
    propertyId: input.context.propertyId,
    actorUserId: input.context.userId,
    actorType: "ai",
    action: "AI_GUEST_REPLY_DRAFTED",
    entityType: "conversation",
    entityId: input.conversationId,
    afterJson: { guestQuestion: input.guestQuestion, draft, source, ...(note ? { note } : {}) },
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

// ---------------------------------------------------------------------------
// Bienvenida real (Tanda CHK · W2-D, diseño §4c «Bienvenida»).
//
// Recorre los canales en orden (por defecto WhatsApp → email → SMS: WhatsApp
// solo llega de verdad dentro de la ventana de 24 h que abre el huésped) y se
// detiene en el primero que el dispatcher da por enviado. Cada intento pasa por
// `dispatch` (plantilla `checkin_welcome` de sistema o de la organización,
// fila NotificationDelivery, proveedor real o simulado) con un notificationId
// determinista `welcome:<reservationId>:<canal>`, así que repetir la llamada
// no reenvía nada. Honestidad: un envío simulado (sin proveedor) vuelve como
// `simulated`, nunca como `sent`, y así se audita; cualquier excepción se
// devuelve como `failed` con motivo en lugar de propagarse (QC-06), porque la
// bienvenida nunca debe deshacer un check-in ya hecho.
//
// `propertyId` es opcional (cae en `context.propertyId`) para que el llamador
// actual (ai/check-in.command.ts, sin await) siga compilando; W4-D lo adapta.
// ---------------------------------------------------------------------------

export const WELCOME_TEMPLATE_CODE = "checkin_welcome";
export const DEFAULT_WELCOME_CHANNEL_ORDER: readonly string[] = ["whatsapp", "email", "sms"];
const WELCOME_CHANNELS: ReadonlySet<string> = new Set(["whatsapp", "email", "sms"]);
const DEFAULT_GUEST_WEB_BASE_URL = "http://localhost:5174";

export type WelcomeMessageStatus = "sent" | "simulated" | "failed" | "skipped";

export type WelcomeMessageResult = {
  status: WelcomeMessageStatus;
  /** Canal del envío (o el último intentado cuando todos fallan; el primero del orden cuando no hubo intento). */
  channel: string;
  deliveryId?: string;
  error?: string;
};

export type WelcomeMessageInput = {
  context: UserContext;
  propertyId?: string;
  reservationId: string;
  guestId: string;
  roomNumber?: string;
  /** Orden de canales a intentar; valores fuera de whatsapp/email/sms se ignoran. */
  channelOrder?: string[];
  correlationId: string;
};

type WelcomeGuest = {
  firstName: string;
  email: string | null;
  mobilePhone: string | null;
  phone: string | null;
  languagePreference: string | null;
};

type WelcomeReservation = {
  id: string;
  arrivalDate: Date;
  assignedRoomId: string | null;
};

/** Dependencias inyectables (tests sin base de datos ni proveedor). */
export type WelcomeMessageDeps = {
  dispatch: (input: DispatchInput) => Promise<NotificationDeliveryRecord>;
  loadGuest: (organizationId: string, guestId: string) => Promise<WelcomeGuest | null>;
  loadReservation: (propertyId: string, reservationId: string) => Promise<WelcomeReservation | null>;
  loadPropertyName: (propertyId: string) => Promise<string | null>;
  loadRoomNumber: (roomId: string) => Promise<string | null>;
  loadFaq: (propertyId: string) => Promise<unknown>;
};

const defaultWelcomeDeps: WelcomeMessageDeps = {
  dispatch,
  loadGuest: async (organizationId, guestId) =>
    prisma.guest.findFirst({
      where: { id: guestId, organizationId, deletedAt: null },
      select: { firstName: true, email: true, mobilePhone: true, phone: true, languagePreference: true }
    }),
  loadReservation: async (propertyId, reservationId) =>
    prisma.reservation.findFirst({
      where: { id: reservationId, propertyId },
      select: { id: true, arrivalDate: true, assignedRoomId: true }
    }),
  loadPropertyName: async (propertyId) =>
    (await prisma.property.findUnique({ where: { id: propertyId }, select: { name: true } }))?.name ?? null,
  loadRoomNumber: async (roomId) => (await prisma.room.findUnique({ where: { id: roomId }, select: { number: true } }))?.number ?? null,
  loadFaq: async (propertyId) => (await getPropertyAiSettings(propertyId)).configurationJson.faq
};

export type WelcomeFaqDetails = { wifiName: string; wifiPassword: string; breakfastHours: string };

function faqString(value: unknown): string {
  return typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : "";
}

function firstFaqValue(record: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const found = faqString(record[key]);
    if (found) return found;
  }
  return "";
}

/**
 * Lee wifi y horario de desayuno de `PropertyAiSetting.configurationJson.faq`
 * cuando existe. Sin forma canónica todavía (ninguna pantalla la escribe):
 * acepta un objeto plano (`wifiName` / `wifi_name` / `wifiSsid`,
 * `wifiPassword` / `wifi_password`, `breakfastHours` / `breakfast_hours` /
 * `breakfast`), un objeto anidado (`wifi: { name, password }`,
 * `breakfast: { hours }`) o una lista de pares `{ question|key, answer|value }`
 * cuyo texto mencione wifi/contraseña/desayuno. Todo lo que no encaja queda
 * vacío y la plantilla cae en «consulta en recepción».
 */
export function extractWelcomeFaqDetails(faq: unknown): WelcomeFaqDetails {
  const empty: WelcomeFaqDetails = { wifiName: "", wifiPassword: "", breakfastHours: "" };
  if (!faq || typeof faq !== "object") return empty;

  if (Array.isArray(faq)) {
    const out = { ...empty };
    for (const entry of faq) {
      if (!entry || typeof entry !== "object") continue;
      const row = entry as Record<string, unknown>;
      const label = `${faqString(row.question)} ${faqString(row.key)} ${faqString(row.title)}`.toLowerCase();
      const answer = faqString(row.answer) || faqString(row.value);
      if (!answer) continue;
      if (/wifi|wi-fi/.test(label) && /contraseñ|clave|password/.test(label)) out.wifiPassword ||= answer;
      else if (/wifi|wi-fi/.test(label)) out.wifiName ||= answer;
      else if (/desayuno|breakfast/.test(label)) out.breakfastHours ||= answer;
    }
    return out;
  }

  const record = faq as Record<string, unknown>;
  const wifi = record.wifi && typeof record.wifi === "object" && !Array.isArray(record.wifi) ? (record.wifi as Record<string, unknown>) : {};
  const breakfast =
    record.breakfast && typeof record.breakfast === "object" && !Array.isArray(record.breakfast) ? (record.breakfast as Record<string, unknown>) : {};
  return {
    wifiName: firstFaqValue(record, ["wifiName", "wifi_name", "wifiSsid", "wifi_ssid"]) || firstFaqValue(wifi, ["name", "ssid", "network"]),
    wifiPassword: firstFaqValue(record, ["wifiPassword", "wifi_password", "wifiKey"]) || firstFaqValue(wifi, ["password", "key"]),
    breakfastHours:
      firstFaqValue(record, ["breakfastHours", "breakfast_hours"]) ||
      (typeof record.breakfast === "string" ? faqString(record.breakfast) : "") ||
      firstFaqValue(breakfast, ["hours", "schedule", "time"])
  };
}

/** Fecha de llegada en español («20 de septiembre de 2026»); `@db.Date` se lee en UTC. */
export function formatArrivalDateEs(date: Date): string {
  return new Intl.DateTimeFormat("es-ES", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(date);
}

/** Enlace al portal del huésped (donde vive el asistente), con el hotel en la URL como en la invitación. */
export function guestBotUrl(propertyId: string): string {
  const base = (process.env.GUEST_WEB_BASE_URL ?? DEFAULT_GUEST_WEB_BASE_URL).replace(/\/$/, "");
  return `${base}/?property=${encodeURIComponent(propertyId)}`;
}

/** Teléfono para whatsapp/sms: sin espacios ni separadores, «00» inicial → «+». El proveedor exige E.164. */
function normalizePhone(value: string | null | undefined): string {
  const compact = (value ?? "").replace(/[\s().-]/g, "");
  if (!compact) return "";
  return compact.startsWith("00") ? `+${compact.slice(2)}` : compact;
}

function recipientForChannel(channel: string, guest: WelcomeGuest): string {
  if (channel === "email") return (guest.email ?? "").trim();
  return normalizePhone(guest.mobilePhone) || normalizePhone(guest.phone);
}

function deliveryOutcome(delivery: NotificationDeliveryRecord): { status: WelcomeMessageStatus; error?: string } {
  if (delivery.status === "sent") {
    return /^SIMULADO/i.test(delivery.errorMessage ?? "") ? { status: "simulated" } : { status: "sent" };
  }
  if (delivery.status === "failed" || delivery.status === "bounced") {
    return { status: "failed", error: delivery.errorMessage ?? "Fallo del proveedor sin detalle." };
  }
  // queued/pending: el dispatcher no lo intentó (programado a futuro); no es un envío.
  return { status: "failed", error: `Entrega en estado ${delivery.status}: no se ha enviado.` };
}

export async function sendWelcomeMessage(
  input: WelcomeMessageInput,
  deps: Partial<WelcomeMessageDeps> = {}
): Promise<WelcomeMessageResult> {
  const d: WelcomeMessageDeps = { ...defaultWelcomeDeps, ...deps };
  const propertyId = input.propertyId ?? input.context.propertyId;
  const channelOrder = (input.channelOrder ?? [...DEFAULT_WELCOME_CHANNEL_ORDER]).filter((c) => WELCOME_CHANNELS.has(c));
  const attempts: Array<{ channel: string; status: WelcomeMessageStatus; deliveryId?: string; error?: string }> = [];
  let result: WelcomeMessageResult = { status: "skipped", channel: channelOrder[0] ?? DEFAULT_WELCOME_CHANNEL_ORDER[0]! };

  try {
    if (channelOrder.length === 0) {
      result = { status: "skipped", channel: DEFAULT_WELCOME_CHANNEL_ORDER[0]!, error: "Sin canales válidos en channelOrder." };
    } else {
      const [guest, reservation] = await Promise.all([
        d.loadGuest(input.context.organizationId, input.guestId),
        d.loadReservation(propertyId, input.reservationId)
      ]);
      if (!guest) {
        result = { status: "failed", channel: channelOrder[0]!, error: "Huésped no encontrado en la organización." };
      } else if (!reservation) {
        result = { status: "failed", channel: channelOrder[0]!, error: "Reserva no encontrada en la propiedad." };
      } else {
        const candidates = channelOrder
          .map((channel) => ({ channel, recipient: recipientForChannel(channel, guest) }))
          .filter((c) => c.recipient !== "");
        if (candidates.length === 0) {
          result = { status: "skipped", channel: channelOrder[0]!, error: "El huésped no tiene email ni teléfono." };
        } else {
          const [propertyName, faq, roomFromReservation] = await Promise.all([
            d.loadPropertyName(propertyId),
            d.loadFaq(propertyId).catch(() => null),
            !input.roomNumber && reservation.assignedRoomId ? d.loadRoomNumber(reservation.assignedRoomId).catch(() => null) : Promise.resolve(null)
          ]);
          const details = extractWelcomeFaqDetails(faq);
          const variables: Record<string, unknown> = {
            guestFirstName: guest.firstName.trim(),
            propertyName: propertyName ?? "",
            arrivalDate: formatArrivalDateEs(reservation.arrivalDate),
            roomNumber: input.roomNumber?.trim() || roomFromReservation || "",
            wifiName: details.wifiName,
            wifiPassword: details.wifiPassword,
            breakfastHours: details.breakfastHours,
            botUrl: guestBotUrl(propertyId)
          };

          for (const candidate of candidates) {
            const delivery = await d.dispatch({
              organizationId: input.context.organizationId,
              propertyId,
              templateCode: WELCOME_TEMPLATE_CODE,
              channel: candidate.channel,
              recipient: candidate.recipient,
              notificationId: `welcome:${input.reservationId}:${candidate.channel}`,
              language: guest.languagePreference?.trim() || "es",
              variables
            });
            const outcome = deliveryOutcome(delivery);
            attempts.push({ channel: candidate.channel, status: outcome.status, deliveryId: delivery.id, ...(outcome.error ? { error: outcome.error } : {}) });
            result = { status: outcome.status, channel: candidate.channel, deliveryId: delivery.id, ...(outcome.error ? { error: outcome.error } : {}) };
            if (outcome.status === "sent" || outcome.status === "simulated") break;
          }
        }
      }
    }
  } catch (error) {
    // QC-06: la bienvenida nunca rompe el check-in; el motivo queda en el resultado y en la auditoría.
    const message = error instanceof Error ? error.message : String(error);
    const lastChannel = attempts.at(-1)?.channel ?? result.channel;
    result = { status: "failed", channel: lastChannel, error: message };
  }

  recordAuditEvent({
    organizationId: input.context.organizationId,
    propertyId,
    actorUserId: input.context.userId,
    actorType: "system",
    action: "GUEST_WELCOME_MESSAGE_SENT",
    entityType: "reservation",
    entityId: input.reservationId,
    afterJson: {
      guestId: input.guestId,
      template: WELCOME_TEMPLATE_CODE,
      status: result.status,
      simulated: result.status === "simulated",
      channel: result.channel,
      ...(result.deliveryId ? { deliveryId: result.deliveryId } : {}),
      ...(result.error ? { error: result.error } : {}),
      channelOrder,
      attempts
    },
    correlationId: input.correlationId
  });

  if (result.status === "sent" || result.status === "simulated") {
    recordDomainEvent({
      organizationId: input.context.organizationId,
      propertyId,
      entityType: "reservation",
      entityId: input.reservationId,
      eventType: "GuestMessageSent",
      payload: { guestId: input.guestId, template: WELCOME_TEMPLATE_CODE, channel: result.channel, simulated: result.status === "simulated", deliveryId: result.deliveryId },
      actorType: "system",
      actorUserId: input.context.userId,
      correlationId: input.correlationId
    });
  }

  return result;
}
