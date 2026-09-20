// Documentos · Tanda T9 · lote T9-06a — puerto de IA del módulo de documentos
// (apps/api/src/modules/documents/documents-ai.port.ts; patrón de
// modules/reputation/reputation-ai.port.ts).
//
// Reglas del fichero:
//   · solo la interfaz, sus tipos y el registro singleton: sin Prisma, sin
//     variables de entorno, sin red, sin proveedor de IA;
//   · por defecto RulesDocumentsAi (documents-ai.rules.ts): clasificación por
//     palabras, extracción por regex sobre la capa de texto del PDF y
//     e-factura por parseEInvoice; etiqueta honesta `configured: false`,
//     `provider: "none"`, `source: rules | text_rules | e_invoice`;
//   · el adaptador de ai-core (documents-ai.core-adapter.ts,
//     createAiCoreDocumentsPort) se registra con setDocumentsAiPort en el
//     arranque del API SOLO si isLlmConfigured(); llama a los ejecutores L6a
//     (classifyIncomingDocument / extractIncomingDocumentFields) a través de
//     runAiTool y cae a las reglas ante cualquier denegación o fallo;
//   · toda implementación devuelve campos con `{ value, confidence, page }`
//     (esquemas de extraction-schemas.ts) y NUNCA inventa datos: lo que no se
//     lee queda ausente o con `value: null`.

import type { DocumentExtractionSource, IncomingDocumentKind } from "@hotelos/shared";
import { RulesDocumentsAi } from "./documents-ai.rules.js";

export type DocumentsAiDescription = {
  /** `false` sin proveedor: todo lo que salga lleva etiqueta `rules` / `text_rules` / `e_invoice`. */
  configured: boolean;
  /** `none`, `anthropic`, … */
  provider: string;
  model?: string;
};

/** Contexto que ai-core exige en cada llamada (presupuesto por organización, telemetría, correlación). */
export type DocumentsAiContext = {
  organizationId: string;
  propertyId: string;
  userId?: string;
  correlationId: string;
};

export type ClassificationSource = "ai" | "rules";

export type ClassifyDocumentInput = {
  /** Texto del documento (capa de texto del PDF o XML); null / vacío para imágenes sin OCR. */
  text: string | null;
  fileName?: string;
  /** MIME del original (`application/pdf`, `application/xml`, `image/jpeg`…): el XML se clasifica por parseEInvoice. */
  mimeType?: string;
  /** Tipo sugerido por quien captura (kindHint de la subida); las reglas lo respetan si el texto no dice lo contrario. */
  kindHint?: IncomingDocumentKind;
};

export type ClassifyDocumentOutput = {
  kind: IncomingDocumentKind;
  /** 0–1; 0 cuando no hay texto ni pista. */
  confidence: number;
  source: ClassificationSource;
  /** Nota honesta del motivo del respaldo (`llm_not_configured`, `ai_denied:budget_exceeded`…). */
  note?: string;
  model?: string;
};

/** Un campo extraído: valor tipado, confianza 0–1 y página (1-based) donde se leyó. */
export type ExtractedField<T = unknown> = { value: T; confidence: number; page?: number };

/** Claves del esquema del tipo (extraction-schemas.ts) → campo extraído. Importes como cadena decimal ("1060.00"). */
export type DocumentExtractedFields = Record<string, ExtractedField>;

export type DocumentImagePage = { mediaType: string; base64: string };

export type ExtractDocumentInput = {
  kind: IncomingDocumentKind;
  /** Texto del documento (capa de texto), si lo hay. */
  text?: string | null;
  /** Páginas rasterizadas (imágenes) para el modelo de visión. */
  pages?: DocumentImagePage[];
  /** PDF completo en base64 para el modelo (bloque document). */
  pdfBase64?: string;
  pageCount: number;
  /** XML de e-factura (Facturae / UBL) → parseEInvoice con confianza 1. */
  xml?: string;
  fileName?: string;
  /** Huella del original: viaja a la telemetría en lugar de los bytes. */
  sha256: string;
  /** DocumentSettings.aiAllowedKinds: [] = todos; letter / administrative_notice / contract solo si están incluidos. */
  aiAllowedKinds?: readonly IncomingDocumentKind[];
};

export type ExtractionTelemetry = {
  model: string | null;
  tokensInput: number | null;
  tokensOutput: number | null;
  costEur: number | null;
  latencyMs: number | null;
};

export type ExtractDocumentOutput = {
  fields: DocumentExtractedFields;
  source: Exclude<DocumentExtractionSource, "manual">;
  /** Avisos del extractor (cobertura limitada de text_rules, tramo denegado, tipo no permitido para IA…). */
  warnings: string[];
  provider: string | null;
  model: string | null;
  schemaVersion: number;
  telemetry: ExtractionTelemetry | null;
  /** ai_tool_calls.id de la llamada (solo con proveedor). */
  toolCallIds?: string[];
};

export interface DocumentsAiPort {
  describe(): DocumentsAiDescription;
  classify(input: ClassifyDocumentInput, ctx: DocumentsAiContext): Promise<ClassifyDocumentOutput>;
  extract(input: ExtractDocumentInput, ctx: DocumentsAiContext): Promise<ExtractDocumentOutput>;
}

let current: DocumentsAiPort | null = null;

/** Puerto activo; sin registro previo, RulesDocumentsAi (respaldo por reglas). */
export function getDocumentsAiPort(): DocumentsAiPort {
  if (!current) current = new RulesDocumentsAi();
  return current;
}

/** Registra el puerto (server.ts: `if (isLlmConfigured()) setDocumentsAiPort(createAiCoreDocumentsPort())`); `null` vuelve a las reglas. */
export function setDocumentsAiPort(port: DocumentsAiPort | null): void {
  current = port;
}

/** Vuelve al respaldo por reglas (tests). */
export function resetDocumentsAiPort(): void {
  current = null;
}
