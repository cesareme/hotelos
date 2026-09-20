// Buzón con propósito `documents` (Tanda T9 · lote T9-07, diseño §4.1 «Buzón de
// correo por centro» y §13 «correo»): cada adjunto PDF / imagen / XML de un correo
// se convierte en un IncomingDocument del centro de la conexión (source `email`,
// remitente / asunto / message-id / attachment-id en `emailMetaJson`). El cuerpo
// del mensaje NO se persiste aquí (el InboundEmail conserva su `snippet`, como
// siempre); el adjunto se descarga, se entrega a captureIncomingDocuments (T9-05a:
// lista blanca MIME + magic bytes, sha256, número de registro, almacén) y se
// descarta de memoria.
//
// Dedupe en dos capas, sin escribir nada de más:
//   · (messageId, attachmentId) en `emailMetaJson` → el mismo adjunto del mismo
//     mensaje (reenvío, segundo buzón, sondeo repetido tras un fallo parcial)
//     queda `ignored: already_ingested` con el registro original;
//   · sha256 por organización (captureIncomingDocuments con allowDuplicate:false →
//     409 DOCUMENT_DUPLICATE_FILE) → `ignored: duplicate` con el registro original.
//
// Contexto: el de sistema de la organización de la conexión (systemContext de
// pms-shadow.rules.ts), nunca demoStore.userContext; captureIncomingDocuments se
// llama con skipPermissionCheck (la tenencia se comprueba igual: la propiedad
// debe pertenecer a la organización del contexto).
//
// Todo es inyectable (capture, búsqueda del dedupe, pipeline, tope de bytes) para
// probarlo sin Postgres ni almacén (__tests__/email-documents.test.mts).

import { prisma } from "@hotelos/database";
import type { IncomingDocumentRecord } from "@hotelos/shared";
import type { UserContext } from "../../../lib/demo-store.js";
import { HttpError } from "../../../lib/http-error.js";
import { attachmentExtension } from "../../pms-shadow/pms-shadow.rules.js";
import { DOCUMENTS_ENV_CONTRACT } from "../../documents/env.partial.js";
import { getDocumentsConfig } from "../../documents/documents.config.js";
import { canonicalDocumentMime } from "../../documents/magic-bytes.js";
import { captureIncomingDocuments, markExtractionFailed, type CaptureIncomingDocumentsInput } from "../../documents/documents.service.js";
import { runDocumentPipeline } from "../../documents/pipeline.service.js";

// ---------------------------------------------------------------------------
// Reglas puras
// ---------------------------------------------------------------------------

/** Extensiones que el buzón `documents` entrega al módulo de documentos (lista blanca de magic-bytes.ts). */
export const DOCUMENT_ATTACHMENT_EXTENSIONS = ["pdf", "jpg", "jpeg", "png", "tif", "tiff", "xml"] as const;

/** MIME canónico por extensión cuando el cliente de correo declara `application/octet-stream` o nada. */
const MIME_BY_EXTENSION: Record<(typeof DOCUMENT_ATTACHMENT_EXTENSIONS)[number], string> = {
  pdf: "application/pdf",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  tif: "image/tiff",
  tiff: "image/tiff",
  xml: "application/xml"
};

/** Tope por fichero del contrato (DOCUMENT_MAX_BYTES, 25 MiB) cuando la configuración del módulo no se puede leer. */
export const DOCUMENT_ATTACHMENT_DEFAULT_MAX_BYTES = Number(DOCUMENTS_ENV_CONTRACT.DOCUMENT_MAX_BYTES?.default ?? 26_214_400);

/** DOCUMENT_MAX_BYTES en vigor; con configuración inválida (disk sin directorio…) el default del contrato, sin tumbar el sondeo. */
export function documentsMaxBytes(): number {
  try {
    return getDocumentsConfig().maxBytes;
  } catch {
    return DOCUMENT_ATTACHMENT_DEFAULT_MAX_BYTES;
  }
}

/** Extensión pdf | jpg | jpeg | png | tif | tiff | xml y tamaño ≤ maxBytes; tamaño desconocido (0) pasa y lo acota captureIncomingDocuments (413). */
export function isDocumentAttachment(attachment: { fileName: string; size: number }, maxBytes: number = DOCUMENT_ATTACHMENT_DEFAULT_MAX_BYTES): boolean {
  const extension = attachmentExtension(attachment.fileName);
  if (!(DOCUMENT_ATTACHMENT_EXTENSIONS as readonly string[]).includes(extension)) return false;
  return attachment.size <= maxBytes;
}

/** MIME que se declara al capturar: el del correo si está en la lista blanca; si no (octet-stream, vacío), el de la extensión. */
export function mimeTypeForAttachment(attachment: { fileName: string; mimeType?: string | null }): string {
  const declared = canonicalDocumentMime(attachment.mimeType ?? "");
  if (declared) return declared;
  const extension = attachmentExtension(attachment.fileName) as (typeof DOCUMENT_ATTACHMENT_EXTENSIONS)[number];
  return MIME_BY_EXTENSION[extension] ?? "application/octet-stream";
}

const FILE_NAME_MAX = 200;

/** Nombre admisible para DocumentUploadFileSchema (sin barras ni caracteres de control, ≤ 200); vacío → adjunto-<n>.<ext>. */
export function safeAttachmentFileName(fileName: string | null | undefined, index: number): string {
  // eslint-disable-next-line no-control-regex -- los caracteres de control son justo lo que se sustituye
  const cleaned = (fileName ?? "").replace(/[/\\\u0000-\u001f]+/g, "_").trim();
  const extension = attachmentExtension(fileName);
  if (!cleaned || cleaned === "_") return extension ? `adjunto-${index}.${extension}` : `adjunto-${index}`;
  if (cleaned.length <= FILE_NAME_MAX) return cleaned;
  const suffix = extension ? `.${extension}` : "";
  return `${cleaned.slice(0, FILE_NAME_MAX - suffix.length)}${suffix}`;
}

const NOTE_MAX = 2000;

/** Nota de captura (searchText + auditoría): remitente y asunto, sin el cuerpo. */
export function captureNoteFor(email: { from?: string | null; subject?: string | null }): string | undefined {
  const parts = [email.from?.trim() ? `Correo de ${email.from.trim()}` : null, email.subject?.trim() ? `Asunto: ${email.subject.trim()}` : null].filter((part): part is string => part !== null);
  if (parts.length === 0) return undefined;
  return parts.join(" · ").slice(0, NOTE_MAX);
}

// ---------------------------------------------------------------------------
// Tipos
// ---------------------------------------------------------------------------

/** Adjunto normalizado (forma de NormalizedAttachment de email-reservation.service.ts): descarga PEREZOSA. */
export type EmailDocumentAttachment = {
  fileName: string;
  mimeType: string;
  size: number;
  /** Gmail `body.attachmentId` · Graph `attachment.id` · manual `manual-<n>`; sin él, `att-<n>` por posición. */
  attachmentId?: string;
  download: () => Promise<Buffer>;
};

export type EmailDocumentMessage = {
  messageId: string;
  from: string;
  subject: string;
  receivedAt?: string;
  attachments?: EmailDocumentAttachment[];
};

export type EmailAttachmentOutcome =
  | { attachmentId: string; fileName: string; status: "ingested"; documentId: string; registryNumber: string; sizeBytes: number }
  | { attachmentId: string; fileName: string; status: "ignored"; reason: "already_ingested" | "duplicate"; documentId: string | null; registryNumber: string | null }
  /** SEC-07: de un adjunto no reconocido solo se guardan extensión y tamaño (el nombre puede llevar datos de terceros). */
  | { attachmentId: string; status: "ignored"; reason: "unsupported"; extension: string | null; size: number }
  | { attachmentId: string; fileName: string; status: "failed"; error: string; message: string };

export type EmailDocumentsOutcome = {
  ingested: number;
  ignored: number;
  failed: number;
  attachments: EmailAttachmentOutcome[];
};

export type IngestDocumentAttachmentsInput = {
  /** Contexto de sistema de la organización de la conexión (systemContext). */
  context: UserContext;
  connection: { id: string; propertyId: string };
  email: EmailDocumentMessage;
  correlationId: string;
};

export type EmailDocumentsDeps = {
  capture: (input: CaptureIncomingDocumentsInput) => Promise<IncomingDocumentRecord[]>;
  /** Documento vivo de la organización con el mismo (messageId, attachmentId) en emailMetaJson. */
  findByAttachment: (organizationId: string, messageId: string, attachmentId: string) => Promise<{ id: string; registryNumber: string } | null>;
  /** Pipeline en segundo plano tras capturar (T9-06a, trigger `email`); null = no lanzar (tests). */
  onCaptured: ((documentId: string, correlationId: string) => Promise<unknown>) | null;
  /** Marca extractionStatus=failed cuando el pipeline en segundo plano falla (documents.service.ts). */
  markExtractionFailed: (documentId: string) => Promise<void>;
  maxBytes: () => number;
  log: Pick<Console, "error">;
};

// ---------------------------------------------------------------------------
// Dependencias reales
// ---------------------------------------------------------------------------

async function findByAttachmentInDb(organizationId: string, messageId: string, attachmentId: string): Promise<{ id: string; registryNumber: string } | null> {
  return prisma.incomingDocument.findFirst({
    where: {
      organizationId,
      deletedAt: null,
      AND: [{ emailMetaJson: { path: ["messageId"], equals: messageId } }, { emailMetaJson: { path: ["attachmentId"], equals: attachmentId } }]
    },
    select: { id: true, registryNumber: true },
    orderBy: { capturedAt: "asc" }
  });
}

/** Dependencias reales con las sustituciones que se pidan (tests de integración: `onCaptured: null`). */
export function emailDocumentsDeps(overrides: Partial<EmailDocumentsDeps> = {}): EmailDocumentsDeps {
  return {
    capture: captureIncomingDocuments,
    findByAttachment: findByAttachmentInDb,
    onCaptured: (documentId, correlationId) => runDocumentPipeline(documentId, { trigger: "email", correlationId }),
    markExtractionFailed,
    maxBytes: documentsMaxBytes,
    log: console,
    ...overrides
  };
}

/** Lanza el pipeline tras la captura sin bloquear el sondeo; si falla, extractionStatus=failed (patrón documents.routes.ts). */
function scheduleCaptured(deps: EmailDocumentsDeps, documentId: string, correlationId: string): void {
  const onCaptured = deps.onCaptured;
  if (!onCaptured) return;
  setImmediate(() => {
    onCaptured(documentId, correlationId).catch(async (error: unknown) => {
      deps.log.error("[mailbox.documents] el pipeline tras la captura falló", { documentId, correlationId, error: error instanceof Error ? error.message : String(error) });
      await deps.markExtractionFailed(documentId).catch((markError: unknown) => {
        deps.log.error("[mailbox.documents] no se pudo marcar extractionStatus=failed", { documentId, correlationId, error: markError instanceof Error ? markError.message : String(markError) });
      });
    });
  });
}

function isDuplicateError(error: unknown): error is HttpError & { details: { code: "DOCUMENT_DUPLICATE_FILE"; existingId?: string | null; registryNumber?: string | null } } {
  return error instanceof HttpError && error.statusCode === 409 && (error.details as { code?: unknown } | undefined)?.code === "DOCUMENT_DUPLICATE_FILE";
}

// ---------------------------------------------------------------------------
// Ingesta
// ---------------------------------------------------------------------------

/**
 * Un correo del buzón `documents` → un IncomingDocument por adjunto reconocido.
 * Nunca lanza por un adjunto: cada uno termina `ingested`, `ignored` (no
 * reconocido, ya ingerido o duplicado por sha256) o `failed` (413 / 400 de la
 * captura, fallo interno), y el sondeo sigue con el siguiente.
 */
export async function ingestDocumentAttachments(input: IngestDocumentAttachmentsInput, deps: EmailDocumentsDeps = emailDocumentsDeps()): Promise<EmailDocumentsOutcome> {
  const { connection, email } = input;
  const organizationId = input.context.organizationId;
  const maxBytes = deps.maxBytes();
  const note = captureNoteFor(email);
  const outcome: EmailDocumentsOutcome = { ingested: 0, ignored: 0, failed: 0, attachments: [] };

  const attachments = email.attachments ?? [];
  for (const [index, attachment] of attachments.entries()) {
    const position = index + 1;
    const attachmentId = attachment.attachmentId?.trim() || `att-${position}`;
    if (!isDocumentAttachment(attachment, maxBytes)) {
      outcome.attachments.push({ attachmentId, status: "ignored", reason: "unsupported", extension: attachmentExtension(attachment.fileName) || null, size: attachment.size });
      outcome.ignored += 1;
      continue;
    }
    const fileName = safeAttachmentFileName(attachment.fileName, position);
    try {
      const prior = await deps.findByAttachment(organizationId, email.messageId, attachmentId);
      if (prior) {
        outcome.attachments.push({ attachmentId, fileName, status: "ignored", reason: "already_ingested", documentId: prior.id, registryNumber: prior.registryNumber });
        outcome.ignored += 1;
        continue;
      }
      const bytes = await attachment.download();
      const records = await deps.capture({
        context: input.context,
        propertyId: connection.propertyId,
        correlationId: input.correlationId,
        source: "email",
        skipPermissionCheck: true,
        emailMeta: {
          messageId: email.messageId,
          attachmentId,
          from: email.from,
          subject: email.subject,
          receivedAt: email.receivedAt ?? null,
          connectionId: connection.id
        },
        body: {
          files: [{ fileName, mimeType: mimeTypeForAttachment(attachment), base64: bytes.toString("base64") }],
          ...(note ? { note } : {})
        }
      });
      const record = records[0];
      if (!record) throw new Error("captureIncomingDocuments no devolvió ningún documento.");
      outcome.attachments.push({ attachmentId, fileName, status: "ingested", documentId: record.id, registryNumber: record.registryNumber, sizeBytes: record.sizeBytes });
      outcome.ingested += 1;
      scheduleCaptured(deps, record.id, input.correlationId);
    } catch (error) {
      if (isDuplicateError(error)) {
        outcome.attachments.push({ attachmentId, fileName, status: "ignored", reason: "duplicate", documentId: error.details.existingId ?? null, registryNumber: error.details.registryNumber ?? null });
        outcome.ignored += 1;
        continue;
      }
      // QC-06 / SEC-08 (patrón processShadowEmail): solo los errores de dominio (4xx con código)
      // persisten su mensaje; un fallo interno se guarda como texto genérico y va al log con la correlación.
      const typed = error as { statusCode?: unknown; details?: { code?: unknown }; message?: unknown };
      const code = typeof typed.details?.code === "string" ? typed.details.code : null;
      const domainError = typeof typed.statusCode === "number" && typed.statusCode < 500 && code !== null;
      outcome.attachments.push({
        attachmentId,
        fileName,
        status: "failed",
        error: code ?? "ERROR",
        message: domainError && typeof typed.message === "string" ? typed.message.slice(0, 300) : "Error interno al capturar el adjunto; revisa el registro del API con el identificador de correlación."
      });
      outcome.failed += 1;
      deps.log.error("[mailbox.documents] attachment failed", {
        connectionId: connection.id,
        propertyId: connection.propertyId,
        correlationId: input.correlationId,
        attachmentId,
        code,
        error: typeof typed.message === "string" ? typed.message : String(error)
      });
    }
  }
  return outcome;
}
