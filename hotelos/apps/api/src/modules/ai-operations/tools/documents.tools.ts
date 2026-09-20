// Documentos (Tanda L6a, lote 3): clasificación de ficheros de onboarding
// (pura, sin modelo) y clasificación/extracción de documentos entrantes con
// ai-core. El texto viaja redactado (ai-core redacta prompt/messages por
// defecto); los bytes de PDF/imagen no se redactan y nunca llegan a la
// telemetría (record sin bytes).
// Tanda T9 (lote T9-06a): el módulo documents (modules/documents/pipeline.service.ts)
// llama a classifyIncomingDocument / extractIncomingDocumentFields a través de
// runAiTool (documents-ai.core-adapter.ts) y añade aquí la escritura
// proposeIncomingDocumentAction (propuesta de acción de dominio sobre la última
// extracción; siempre awaiting_confirmation). Este fichero sigue sin importar
// módulos de dinero/fiscal (tools-coverage lo vigila): la propuesta la calcula
// el servicio de documentos.

import { z } from "zod";
import type { JsonSchema } from "@hotelos/ai-core";
import { classifyDocument } from "@hotelos/ai-tools";
import type { JsonValue } from "@hotelos/ai-core/runner";
import { getAiCore } from "../../../lib/ai-client.js";
import { proposeDocumentAction, type ProposeDocumentActionResult } from "../../documents/pipeline.service.js";
import { aiContextFor, defineAiTool, fromAiResult, usageOf } from "./context.js";

export const INCOMING_DOCUMENT_KINDS = ["invoice", "delivery_note", "receipt", "letter", "administrative_notice", "contract", "other"] as const;
export type IncomingDocumentKind = (typeof INCOMING_DOCUMENT_KINDS)[number];

const CLASSIFY_SYSTEM =
  "Eres un clasificador de documentos que recibe un hotel en España. Elige exactamente una de estas clases: " +
  "invoice (factura), delivery_note (albarán), receipt (recibo o ticket), letter (carta), administrative_notice (notificación administrativa), " +
  "contract (contrato) u other. Indica en `confidence` tu confianza entre 0 y 1. No inventes datos.";

const CLASSIFY_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["kind", "confidence"],
  properties: { kind: { type: "string", enum: [...INCOMING_DOCUMENT_KINDS] }, confidence: { type: "number" } }
};

const EXTRACT_INSTRUCTION =
  "Extrae los datos principales de este documento y devuelve EXCLUSIVAMENTE un objeto JSON con las claves documentType (tipo de documento en minúsculas), " +
  "issuer (emisor), issueDate y expiryDate (YYYY-MM-DD o null), total (importe total numérico o null) y fields (lista de pares { name, value } con el resto de datos relevantes). " +
  "Deja en null lo que no puedas leer con seguridad. No inventes datos.";

const nullable = (schema: JsonSchema): JsonSchema => ({ anyOf: [schema, { type: "null" }] });

export const INCOMING_DOCUMENT_FIELDS_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["documentType", "issuer", "issueDate", "expiryDate", "total", "fields"],
  properties: {
    documentType: nullable({ type: "string" }),
    issuer: nullable({ type: "string" }),
    issueDate: nullable({ type: "string" }),
    expiryDate: nullable({ type: "string" }),
    total: nullable({ type: "number" }),
    fields: { type: "array", items: { type: "object", additionalProperties: false, required: ["name", "value"], properties: { name: { type: "string" }, value: nullable({ type: "string" }) } } }
  }
};

export type IncomingDocumentFields = {
  documentType: string | null;
  issuer: string | null;
  issueDate: string | null;
  expiryDate: string | null;
  total: number | null;
  fields: Array<{ name: string; value: string | null }>;
};

export const classifyOnboardingFileTool = defineAiTool({
  name: "classifyOnboardingFile",
  effect: "read",
  description: "Clasifica un fichero de onboarding (listado de habitaciones, tarifas, reservas, huéspedes, canales…) por cabeceras y palabras clave, sin modelo.",
  inputSchema: z.object({ fileName: z.string().trim().min(1).max(255), fileType: z.string().trim().min(1).max(100), content: z.string().max(2_000_000) }).strict(),
  outputSchema: z.custom<ReturnType<typeof classifyDocument>>(),
  modelInputSchema: { type: "object", additionalProperties: false, required: ["fileName", "fileType", "content"], properties: { fileName: { type: "string" }, fileType: { type: "string" }, content: { type: "string" } } },
  async execute(input) {
    const result = classifyDocument(input);
    return { output: result, record: { fileName: input.fileName, fileType: input.fileType, detectedDocumentType: result.detectedDocumentType, confidence: result.confidence } };
  }
});

export const classifyIncomingDocumentTool = defineAiTool({
  name: "classifyIncomingDocument",
  effect: "read",
  description: "Clasifica el texto de un documento entrante (factura, albarán, recibo, carta, notificación, contrato u otro) con el modelo de clasificación.",
  inputSchema: z.object({ text: z.string().trim().min(1).max(20_000), fileName: z.string().trim().max(255).optional() }).strict(),
  outputSchema: z.object({ kind: z.enum(INCOMING_DOCUMENT_KINDS), confidence: z.number(), usage: z.custom<ReturnType<typeof usageOf>>() }),
  modelInputSchema: { type: "object", additionalProperties: false, required: ["text"], properties: { text: { type: "string" }, fileName: { type: "string" } } },
  async execute(input, ctx) {
    const prompt = `${input.fileName ? `Nombre del fichero: ${input.fileName}\n` : ""}Texto del documento:\n"""\n${input.text}\n"""`;
    const result = await getAiCore().structured<{ kind: IncomingDocumentKind; confidence: number }>(
      { system: CLASSIFY_SYSTEM, prompt, schema: CLASSIFY_SCHEMA, maxTokens: 200 },
      aiContextFor(ctx, "classifyIncomingDocument", "classify"),
      { model: "classify" }
    );
    return fromAiResult(result, (value) => ({ kind: value.data.kind, confidence: Math.min(1, Math.max(0, value.data.confidence)), usage: usageOf(value) }));
  }
});

export const extractIncomingDocumentFieldsTool = defineAiTool({
  name: "extractIncomingDocumentFields",
  effect: "read",
  description: "Extrae emisor, fechas, total y campos de un documento entrante (imágenes o PDF) con visión; el resultado lo revisa una persona.",
  inputSchema: z
    .object({
      pages: z.array(z.object({ mediaType: z.string().trim().min(1), base64: z.string().min(1) }).strict()).max(20).optional(),
      pdfBase64: z.string().min(1).optional(),
      pageCount: z.number().int().min(1).max(600).optional()
    })
    .strict()
    .refine((value) => Boolean((value.pages && value.pages.length > 0) || value.pdfBase64), { message: "Indique pages o pdfBase64." }),
  outputSchema: z.object({ data: z.custom<IncomingDocumentFields>(), document: z.object({ pages: z.number(), bytes: z.number(), sha256: z.string() }), usage: z.custom<ReturnType<typeof usageOf>>() }),
  async execute(input, ctx) {
    const result = await getAiCore().extractFromDocument<IncomingDocumentFields>(
      { ...(input.pages ? { pages: input.pages } : {}), ...(input.pdfBase64 ? { pdfBase64: input.pdfBase64 } : {}), ...(input.pageCount !== undefined ? { pageCount: input.pageCount } : {}), schema: INCOMING_DOCUMENT_FIELDS_SCHEMA, instruction: EXTRACT_INSTRUCTION },
      aiContextFor(ctx, "extractIncomingDocumentFields", "extract")
    );
    const wrapped = fromAiResult(result, (value) => ({ data: value.data, document: value.document, usage: usageOf(value) }));
    if (!("output" in wrapped)) return wrapped;
    // Telemetría sin bytes: páginas, tamaño y huella del documento más lo extraído (no PII de huéspedes: documentos de proveedores/administración).
    return { ...wrapped, record: { document: wrapped.output.document, documentType: wrapped.output.data.documentType, issuer: wrapped.output.data.issuer, total: wrapped.output.data.total, fields: wrapped.output.data.fields.length } };
  }
});

/** Resumen determinista de la propuesta (tarjeta de confirmación y outputJson): sin texto del documento ni importes línea a línea. */
function proposalSummary(result: ProposeDocumentActionResult): JsonValue {
  const checks = Object.fromEntries(Object.entries(result.checks).map(([key, check]) => [key, check.status]));
  return {
    documentId: result.documentId,
    registryNumber: result.registryNumber,
    kind: result.kind,
    runNo: result.runNo,
    proposedAction: result.proposal.action,
    targetPropertyId: result.proposal.targetPropertyId,
    needsManual: result.proposal.needsManual,
    needsAccount: result.proposal.needsAccount,
    supplierProposal: result.proposal.supplierProposal ? { fromSage: result.proposal.supplierProposal.fromSage, taxId: result.proposal.supplierProposal.taxId ?? null } : null,
    checks,
    autonomy: { level: result.autonomy.level, wouldAutoArchive: result.autonomy.wouldAutoArchive, wouldCreateDraft: result.autonomy.wouldCreateDraft },
    notes: result.proposal.notes.length
  };
}

export const proposeIncomingDocumentActionTool = defineAiTool({
  name: "proposeIncomingDocumentAction",
  effect: "write",
  description: "Propone la acción de dominio de un documento digitalizado (factura de proveedor en borrador, gasto, recepción, tarea o archivo) sobre su última extracción y la guarda como propuesta; una persona la aprueba desde la revisión del documento.",
  inputSchema: z.object({ documentId: z.string().trim().min(1).max(64) }).strict(),
  outputSchema: z.custom<ProposeDocumentActionResult>(),
  modelInputSchema: { type: "object", additionalProperties: false, required: ["documentId"], properties: { documentId: { type: "string" } } },
  async preview(input, ctx) {
    const result = await proposeDocumentAction({ documentId: input.documentId, organizationId: ctx.organizationId, propertyId: ctx.propertyId, correlationId: ctx.correlationId, userId: ctx.userId, persist: false });
    return { action: "proposeIncomingDocumentAction", ...(proposalSummary(result) as Record<string, JsonValue>) };
  },
  async execute(input, ctx) {
    const result = await proposeDocumentAction({ documentId: input.documentId, organizationId: ctx.organizationId, propertyId: ctx.propertyId, correlationId: ctx.correlationId, userId: ctx.userId, persist: true });
    return { output: result, record: proposalSummary(result) };
  }
});
