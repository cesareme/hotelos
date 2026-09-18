// Herramientas del parte de viajeros (Tanda L6a, lote 3). Lecturas puras y
// dos escrituras que el runner deja SIEMPRE en awaiting_confirmation. La
// extracción de identidad viaja a ai-core (política id-scan: la imagen nunca
// se persiste; la fila de telemetría solo guarda qué claves se leyeron).

import { z } from "zod";
import type { GuestIdentityFields } from "@hotelos/shared";
import { getAiCore } from "../../../lib/ai-client.js";
import { checkGuestRegisterCompleteness, prepareGuestRegisterRecord, queueSesHospedajesSubmission, validateSpainGuestRegisterRecordApi } from "../../compliance/compliance.service.js";
import { aiContextFor, defineAiTool, fromAiResult, usageOf } from "./context.js";

const optionalText = z.string().trim().min(1).max(200).optional();

/** GuestIdentityFields de packages/shared/src/types.ts:365 (claves abiertas: el perfil crece). */
export const GuestIdentityFieldsSchema: z.ZodType<GuestIdentityFields, z.ZodTypeDef, unknown> = z
  .object({
    title: optionalText,
    firstName: optionalText,
    middleName: optionalText,
    surname1: optionalText,
    surname2: optionalText,
    documentType: optionalText,
    documentNumber: optionalText,
    documentSupportNumber: optionalText,
    documentIssueCountry: optionalText,
    documentExpiryDate: optionalText,
    nationality: optionalText,
    dateOfBirth: optionalText,
    sex: optionalText,
    languagePreference: optionalText,
    residenceAddress: optionalText,
    residenceLocality: optionalText,
    residenceProvince: optionalText,
    residencePostalCode: optionalText,
    residenceCountry: optionalText,
    phone: optionalText,
    mobilePhone: optionalText,
    email: optionalText,
    company: optionalText
  })
  .passthrough() as unknown as z.ZodType<GuestIdentityFields, z.ZodTypeDef, unknown>;

export const checkGuestRegisterCompletenessTool = defineAiTool({
  name: "checkGuestRegisterCompleteness",
  effect: "read",
  description: "Comprueba qué campos obligatorios del parte de viajeros faltan en los datos extraídos.",
  inputSchema: z.object({ fields: GuestIdentityFieldsSchema }).strict(),
  outputSchema: z.object({ missingFields: z.array(z.string()), signatureRequired: z.boolean() }),
  modelInputSchema: { type: "object", additionalProperties: false, required: ["fields"], properties: { fields: { type: "object", description: "Campos de identidad extraídos del documento." } } },
  async execute(input) {
    return checkGuestRegisterCompleteness(input.fields);
  }
});

export const validateSpainGuestRegisterTool = defineAiTool({
  name: "validateSpainGuestRegister",
  effect: "read",
  description: "Revalida un parte de viajeros existente contra las reglas SES Hospedajes (RD 933/2021).",
  inputSchema: z.object({ recordId: z.string().trim().min(1) }).strict(),
  outputSchema: z.custom<Awaited<ReturnType<typeof validateSpainGuestRegisterRecordApi>>>(),
  modelInputSchema: { type: "object", additionalProperties: false, required: ["recordId"], properties: { recordId: { type: "string" } } },
  async execute(input, ctx) {
    return validateSpainGuestRegisterRecordApi({ context: ctx.user, recordId: input.recordId, correlationId: ctx.correlationId });
  }
});

export const extractGuestIdentityFieldsTemporaryTool = defineAiTool({
  name: "extractGuestIdentityFieldsTemporary",
  effect: "read",
  description: "Extrae los campos de un documento de identidad con visión (ai-core). La imagen no se guarda: solo los campos leídos.",
  inputSchema: z.object({ imageDataUrl: z.string().regex(/^data:[^;,]+;base64,/, "Se espera una URL de datos base64 (data:<tipo>;base64,…).") }).strict(),
  outputSchema: z.object({ fields: z.custom<GuestIdentityFields>(), confidence: z.record(z.number()), usage: z.custom<ReturnType<typeof usageOf>>() }),
  async execute(input, ctx) {
    const result = await getAiCore().extractIdentityDocument(input.imageDataUrl, aiContextFor(ctx, "extractGuestIdentityFieldsTemporary", "extract"));
    const wrapped = fromAiResult(result, (value) => ({ fields: value.fields as GuestIdentityFields, confidence: value.confidence as Record<string, number>, usage: usageOf(value) }));
    if (!("output" in wrapped)) return wrapped;
    // La fila de telemetría nunca lleva los datos del documento: solo las claves leídas y su confianza.
    return { ...wrapped, record: { fieldsRead: Object.keys(wrapped.output.fields), confidence: wrapped.output.confidence } };
  }
});

export const prepareGuestRegisterRecordTool = defineAiTool({
  name: "prepareGuestRegisterRecord",
  effect: "write",
  description: "Crea o refresca el parte de viajeros de un huésped de una reserva a partir de los campos extraídos.",
  inputSchema: z.object({ reservationId: z.string().trim().min(1), guestId: z.string().trim().min(1), fields: GuestIdentityFieldsSchema }).strict(),
  outputSchema: z.custom<Awaited<ReturnType<typeof prepareGuestRegisterRecord>>>(),
  preview(input) {
    return { action: "prepareGuestRegisterRecord", reservationId: input.reservationId, guestId: input.guestId, fieldsProvided: Object.keys(input.fields), ...checkGuestRegisterCompleteness(input.fields) };
  },
  async execute(input, ctx) {
    const record = await prepareGuestRegisterRecord({ context: ctx.user, propertyId: ctx.propertyId, reservationId: input.reservationId, guestId: input.guestId, fields: input.fields, correlationId: ctx.correlationId });
    return { output: record, record: { guestRegisterRecordId: record.id, status: (record as { status?: string }).status ?? null } };
  }
});

export const queueSesHospedajesSubmissionTool = defineAiTool({
  name: "queueSesHospedajesSubmission",
  effect: "write",
  description: "Encola el envío del parte de viajeros a SES Hospedajes (reserva, entrada o cancelación).",
  inputSchema: z.object({ guestRegisterRecordId: z.string().trim().min(1), submissionType: z.enum(["reservation", "checkin", "cancellation"]) }).strict(),
  outputSchema: z.custom<Awaited<ReturnType<typeof queueSesHospedajesSubmission>>>(),
  preview(input) {
    return { action: "queueSesHospedajesSubmission", guestRegisterRecordId: input.guestRegisterRecordId, submissionType: input.submissionType };
  },
  async execute(input, ctx) {
    const submission = await queueSesHospedajesSubmission({ context: ctx.user, guestRegisterRecordId: input.guestRegisterRecordId, submissionType: input.submissionType, correlationId: ctx.correlationId });
    return { output: submission, record: { submissionId: submission.id, status: (submission as { status?: string }).status ?? null } };
  }
});
