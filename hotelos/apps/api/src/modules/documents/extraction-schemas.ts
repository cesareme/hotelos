// Documentos · Tanda T9 · lote T9-06a — esquemas JSON de extracción por tipo
// (apps/api/src/modules/documents/extraction-schemas.ts; diseño §5.1).
//
// Reglas del fichero (salida estructurada de ai-core, `output_config.format =
// json_schema`):
//   · un esquema por tipo (invoice, delivery_note, receipt, letter,
//     administrative_notice; contract / other / unknown reutilizan el de carta);
//   · cada campo es `{ value, confidence, page }` con `value` nulo cuando no se
//     lee con seguridad, `confidence` 0–1 y `page` 1-based (o null);
//   · `additionalProperties: false` y `required` en todos los objetos; SIN
//     `minimum`, `maximum`, `maxLength`, `minLength`, `pattern` ni `format`
//     (no admitidos por la salida estructurada, §5.1);
//   · importes como cadena decimal ("1060.00"), fechas ISO ("2026-09-10"),
//     porcentajes como número (21);
//   · EXTRACTION_SCHEMA_VERSION acompaña a DocumentExtraction.schemaVersion.
// Puro: sin Prisma, sin entorno, sin red.

import type { JsonSchema } from "@hotelos/ai-core";
import type { IncomingDocumentKind } from "@hotelos/shared";

export const EXTRACTION_SCHEMA_VERSION = 1;

/** Tipos con esquema propio; el resto (contract, other, unknown, e_invoice_status) usa el de carta. */
export const EXTRACTION_SCHEMA_KINDS = ["invoice", "delivery_note", "receipt", "letter", "administrative_notice"] as const;
export type ExtractionSchemaKind = (typeof EXTRACTION_SCHEMA_KINDS)[number];

type ValueType = "string" | "number" | "integer" | "boolean";

const nullable = (schema: JsonSchema): JsonSchema => ({ anyOf: [schema, { type: "null" }] });

/** `{ value: <tipo> | null, confidence: number, page: integer | null }`. */
export function fieldSchema(value: JsonSchema, description?: string): JsonSchema {
  return {
    type: "object",
    additionalProperties: false,
    required: ["value", "confidence", "page"],
    ...(description ? { description } : {}),
    properties: {
      value: nullable(value),
      confidence: { type: "number", description: "Confianza 0-1 de la lectura." },
      page: nullable({ type: "integer" })
    }
  };
}

const scalar = (type: ValueType, description?: string): JsonSchema => fieldSchema({ type }, description);
const money = (description: string): JsonSchema => fieldSchema({ type: "string" }, `${description} Cadena decimal con punto y dos decimales, p. ej. "1060.00".`);
const isoDay = (description: string): JsonSchema => fieldSchema({ type: "string" }, `${description} Fecha ISO YYYY-MM-DD.`);
const stringList = (description: string): JsonSchema => fieldSchema({ type: "array", items: { type: "string" } }, description);

function objectOf(properties: Record<string, JsonSchema>): JsonSchema {
  return { type: "object", additionalProperties: false, required: Object.keys(properties), properties };
}

/** Líneas de factura / albarán: valores planos por línea; la confianza va en el campo contenedor. */
const INVOICE_LINE: JsonSchema = objectOf({
  description: { type: "string" },
  quantity: nullable({ type: "number" }),
  unitPrice: nullable({ type: "string" }),
  base: nullable({ type: "string" }),
  taxRate: nullable({ type: "number" }),
  quota: nullable({ type: "string" }),
  deliveryNoteRef: nullable({ type: "string" })
});

const DELIVERY_LINE: JsonSchema = objectOf({
  description: { type: "string" },
  quantity: nullable({ type: "number" }),
  unit: nullable({ type: "string" }),
  unitPrice: nullable({ type: "string" }),
  base: nullable({ type: "string" }),
  taxRate: nullable({ type: "number" })
});

const TAX_BREAKDOWN_ITEM: JsonSchema = objectOf({
  rate: { type: "number" },
  base: nullable({ type: "string" }),
  quota: nullable({ type: "string" })
});

export const INVOICE_SCHEMA: JsonSchema = objectOf({
  supplierName: scalar("string", "Razón social del emisor."),
  supplierTaxId: scalar("string", "NIF/CIF del emisor (sin espacios)."),
  customerName: scalar("string", "Razón social del destinatario."),
  customerTaxId: scalar("string", "NIF/CIF del destinatario."),
  invoiceNumber: scalar("string", "Número de factura tal como aparece."),
  issueDate: isoDay("Fecha de emisión."),
  dueDate: isoDay("Fecha de vencimiento."),
  base: money("Base imponible total."),
  taxBreakdown: fieldSchema({ type: "array", items: TAX_BREAKDOWN_ITEM }, "Desglose por tipo de IVA (tipo en %, base y cuota)."),
  tax: money("Cuota de IVA total."),
  retentionRate: scalar("number", "Retención IRPF en % (null si no hay)."),
  retention: money("Importe retenido."),
  total: money("Total a pagar."),
  currency: scalar("string", "Moneda ISO (EUR)."),
  deliveryNoteRefs: stringList("Números de albarán citados en la factura."),
  lines: fieldSchema({ type: "array", items: INVOICE_LINE }, "Líneas de la factura.")
});

export const DELIVERY_NOTE_SCHEMA: JsonSchema = objectOf({
  supplierName: scalar("string", "Razón social del proveedor."),
  supplierTaxId: scalar("string", "NIF/CIF del proveedor."),
  deliveryNoteNumber: scalar("string", "Número del albarán."),
  deliveryDate: isoDay("Fecha de entrega."),
  purchaseOrderRef: scalar("string", "Referencia de pedido citada."),
  lines: fieldSchema({ type: "array", items: DELIVERY_LINE }, "Líneas del albarán.")
});

export const RECEIPT_SCHEMA: JsonSchema = objectOf({
  merchantName: scalar("string", "Nombre del establecimiento."),
  merchantTaxId: scalar("string", "NIF/CIF del establecimiento."),
  receiptNumber: scalar("string", "Número del ticket o recibo."),
  date: isoDay("Fecha del ticket."),
  base: money("Base imponible."),
  taxRate: scalar("number", "Tipo de IVA en %."),
  tax: money("Cuota de IVA."),
  total: money("Total pagado."),
  paidWith: scalar("string", "Medio de pago (cash, card, transfer) si consta.")
});

export const LETTER_SCHEMA: JsonSchema = objectOf({
  sender: scalar("string", "Remitente."),
  senderTaxId: scalar("string", "NIF/CIF del remitente si consta."),
  subject: scalar("string", "Asunto o título."),
  date: isoDay("Fecha del escrito."),
  reference: scalar("string", "Referencia o expediente."),
  deadlineDate: isoDay("Plazo o fecha límite mencionada."),
  amount: money("Importe reclamado o citado, si lo hay."),
  summary: scalar("string", "Resumen en una frase, en español.")
});

export const ADMINISTRATIVE_NOTICE_SCHEMA: JsonSchema = objectOf({
  issuer: scalar("string", "Organismo emisor (AEAT, DGT, ayuntamiento, Seguridad Social…)."),
  issuerTaxId: scalar("string", "NIF del organismo si consta."),
  reference: scalar("string", "Nº de expediente o referencia."),
  noticeDate: isoDay("Fecha del acto o resolución."),
  notificationDate: isoDay("Fecha de notificación o recepción."),
  subject: scalar("string", "Asunto."),
  amount: money("Importe a pagar o sanción, si lo hay."),
  deadlineDate: isoDay("Plazo para responder o pagar."),
  summary: scalar("string", "Resumen en una frase, en español.")
});

const SCHEMAS: Readonly<Record<ExtractionSchemaKind, JsonSchema>> = Object.freeze({
  invoice: INVOICE_SCHEMA,
  delivery_note: DELIVERY_NOTE_SCHEMA,
  receipt: RECEIPT_SCHEMA,
  letter: LETTER_SCHEMA,
  administrative_notice: ADMINISTRATIVE_NOTICE_SCHEMA
});

/** Tipo de esquema aplicable a un tipo de documento (contract / other / unknown / e_invoice_status → carta). */
export function schemaKindFor(kind: IncomingDocumentKind): ExtractionSchemaKind {
  return (EXTRACTION_SCHEMA_KINDS as readonly string[]).includes(kind) ? (kind as ExtractionSchemaKind) : "letter";
}

export function schemaFor(kind: IncomingDocumentKind): JsonSchema {
  return SCHEMAS[schemaKindFor(kind)];
}

/** Claves de primer nivel del esquema del tipo (orden del esquema). */
export function schemaFieldKeys(kind: IncomingDocumentKind): string[] {
  const schema = schemaFor(kind);
  return Object.keys(schema.properties ?? {});
}

/** Instrucción en español para la extracción con visión (el esquema fija la forma; aquí van las reglas de lectura). */
export function extractionInstructionFor(kind: IncomingDocumentKind): string {
  const label: Record<ExtractionSchemaKind, string> = {
    invoice: "una factura de proveedor",
    delivery_note: "un albarán de entrega",
    receipt: "un ticket o recibo",
    letter: "una carta o escrito",
    administrative_notice: "una notificación administrativa"
  };
  return (
    `Lee ${label[schemaKindFor(kind)]} recibido por un hotel en España y devuelve EXCLUSIVAMENTE el objeto JSON del esquema. ` +
    "Cada campo lleva { value, confidence, page }: `value` con lo leído (null si no aparece o no se lee con seguridad), " +
    "`confidence` entre 0 y 1 y `page` con el número de página (desde 1) donde está el dato. " +
    "Importes como cadena decimal con punto y dos decimales (\"1060.00\"), fechas como YYYY-MM-DD, porcentajes como número (21). " +
    "No inventes datos ni completes con suposiciones."
  );
}
