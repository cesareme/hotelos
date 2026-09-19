// Mensajería (Tanda L6a, lote 3): answerGuestQuestion redacta la respuesta a
// un huésped (lectura: devuelve el texto, NO llama a createAiReplyDraft; el
// lote 4 hace que createAiReplyDraft invoque este execute a través del runner)
// y sendGuestMessage envía un mensaje en una conversación (escritura: siempre
// con confirmación). La pregunta del huésped viaja redactada (ai-core).
//
// Corrección 1: (SEC-07) la PII conocida del huésped de la conversación (nombre, correo,
// teléfonos) se siembra en el redactor (knownPii) para que se sustituya aunque aparezca sin
// tratamiento; (SEC-10) sendGuestMessage solo envía como `ai`: un texto generado por IA nunca
// sale firmado como personal (el aviso de IA es obligatorio).

import { z } from "zod";
import type { KnownPii } from "@hotelos/ai-core";
import { prisma } from "@hotelos/database";
import { getAiCore } from "../../../lib/ai-client.js";
import { sendConversationMessage } from "../../messaging/messaging.service.js";
import { aiContextFor, defineAiTool, fromAiResult, usageOf } from "./context.js";

/** Idiomas admitidos en la pista de respuesta (messaging.service.ts REPLY_LANGUAGES). */
export const REPLY_LANGUAGE_NAMES: Record<string, string> = { es: "español", en: "inglés", fr: "francés", de: "alemán", it: "italiano", pt: "portugués" };

/** Texto de messaging.service.ts:315-324 (prompt en código; ai_prompt_versions lo puede sustituir por `guest_message_reply`). */
export const GUEST_MESSAGE_REPLY_SYSTEM =
  "Eres el asistente de recepción de un hotel en España. Responde al mensaje del huésped de forma breve, " +
  "cordial y profesional." +
  " No inventes datos concretos (precios, disponibilidad, políticas): si no los sabes, indica que recepción lo confirmará. Máximo 4 frases.";

/** Único remitente admitido para un texto generado por IA (SEC-10): nunca `staff`. */
const AI_SENDER_TYPES = ["ai"] as const;

/** PII conocida del huésped de la conversación (descifrada por la extensión de Prisma); [] si no hay huésped. */
export async function knownGuestPii(conversationId: string | undefined): Promise<KnownPii[]> {
  if (!conversationId) return [];
  const conversation = await prisma.conversation.findUnique({ where: { id: conversationId }, select: { guestId: true } });
  if (!conversation?.guestId) return [];
  const guest = await prisma.guest.findUnique({ where: { id: conversation.guestId }, select: { firstName: true, surname1: true, surname2: true, email: true, phone: true, mobilePhone: true } });
  if (!guest) return [];
  const fullName = [guest.firstName, guest.surname1, guest.surname2].filter((part) => typeof part === "string" && part.trim()).join(" ").trim();
  const shortName = [guest.firstName, guest.surname1].filter((part) => typeof part === "string" && part.trim()).join(" ").trim();
  const candidates: KnownPii[] = [
    { kind: "name", value: fullName },
    { kind: "name", value: shortName },
    { kind: "name", value: guest.firstName ?? "" },
    { kind: "email", value: guest.email ?? "" },
    { kind: "phone", value: guest.phone ?? "" },
    { kind: "phone", value: guest.mobilePhone ?? "" }
  ];
  return candidates.filter((item) => item.value.trim().length >= 3);
}

export const answerGuestQuestionTool = defineAiTool({
  name: "answerGuestQuestion",
  effect: "read",
  description: "Redacta la respuesta a la pregunta de un huésped (borrador breve y honesto; la persona lo revisa antes de enviarlo).",
  inputSchema: z
    .object({
      guestQuestion: z.string().trim().min(1).max(4_000),
      tone: z.string().trim().min(1).max(40).optional(),
      language: z.string().trim().min(2).max(10).optional(),
      conversationId: z.string().trim().min(1).optional()
    })
    .strict(),
  outputSchema: z.object({ text: z.string(), model: z.string(), usage: z.custom<ReturnType<typeof usageOf>>() }),
  modelInputSchema: { type: "object", additionalProperties: false, required: ["guestQuestion"], properties: { guestQuestion: { type: "string" }, tone: { type: "string" }, language: { type: "string" }, conversationId: { type: "string" } } },
  async execute(input, ctx) {
    const base = await getAiCore().promptFrom("guest_message_reply", GUEST_MESSAGE_REPLY_SYSTEM);
    const languageName = input.language && input.language !== "auto" ? REPLY_LANGUAGE_NAMES[input.language.toLowerCase()] : undefined;
    const languageHint = languageName ? ` Responde SIEMPRE en ${languageName}.` : " Responde en el mismo idioma del huésped.";
    const toneHint = input.tone ? ` Usa un tono ${input.tone}.` : "";
    const knownPii = await knownGuestPii(input.conversationId);
    const result = await getAiCore().complete(
      { system: base + languageHint + toneHint, prompt: input.guestQuestion, maxTokens: 250 },
      aiContextFor(ctx, "answerGuestQuestion", "complete", input.conversationId),
      { ...(knownPii.length > 0 ? { knownPii } : {}) }
    );
    return fromAiResult(result, (value) => ({ text: value.text.trim(), model: value.model, usage: usageOf(value) }));
  }
});

export const sendGuestMessageTool = defineAiTool({
  name: "sendGuestMessage",
  effect: "write",
  description: "Envía un mensaje al huésped en una conversación existente (escritura: siempre con confirmación de una persona).",
  inputSchema: z
    .object({ conversationId: z.string().trim().min(1), body: z.string().trim().min(1).max(4_000), language: z.string().trim().min(2).max(10).optional(), senderType: z.enum(AI_SENDER_TYPES).default("ai") })
    .strict(),
  outputSchema: z.custom<Awaited<ReturnType<typeof sendConversationMessage>>>(),
  modelInputSchema: { type: "object", additionalProperties: false, required: ["conversationId", "body"], properties: { conversationId: { type: "string" }, body: { type: "string" }, language: { type: "string" }, senderType: { type: "string", enum: [...AI_SENDER_TYPES] } } },
  preview(input) {
    return { action: "sendGuestMessage", conversationId: input.conversationId, senderType: input.senderType, language: input.language ?? null, body: input.body };
  },
  async execute(input, ctx) {
    const message = await sendConversationMessage({
      context: ctx.user,
      conversationId: input.conversationId,
      senderType: input.senderType,
      body: input.body,
      language: input.language,
      metadataJson: { aiToolCall: true, correlationId: ctx.correlationId },
      correlationId: ctx.correlationId
    });
    return { output: message, record: { messageId: message.id, conversationId: message.conversationId, senderType: message.senderType, sentAt: message.sentAt } };
  }
});
