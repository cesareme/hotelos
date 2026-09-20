// Tanda T9 · lote T9-07 — buzón con propósito `documents`: cada adjunto PDF /
// imagen / XML de un correo (mensajes Gmail y Graph SIMULADOS con la forma que
// producen fetchGmail / fetchGraph: descarga perezosa por attachmentId) se
// entrega a captureIncomingDocuments (INYECTADO: sin Postgres ni almacén) con
// source `email`, emailMeta (messageId, attachmentId, remitente, asunto) y sin el
// cuerpo del mensaje. Dedupe por (messageId, attachmentId) y por sha256 (409
// DOCUMENT_DUPLICATE_FILE → ignored duplicate); adjuntos no reconocidos y
// errores de captura por adjunto sin detener el resto. Desde apps/api:
//   node --import tsx --test src/modules/integrations/email/__tests__/email-documents.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { IncomingDocumentRecord } from "@hotelos/shared";
import type { UserContext } from "../../../../lib/demo-store.js";
import { HttpError } from "../../../../lib/http-error.js";
import type { CaptureIncomingDocumentsInput } from "../../../documents/documents.service.js";
import { demoInvoicePdf, tinyPng } from "../../../documents/__tests__/fixtures.js";
import {
  DOCUMENT_ATTACHMENT_DEFAULT_MAX_BYTES,
  DOCUMENT_ATTACHMENT_EXTENSIONS,
  captureNoteFor,
  ingestDocumentAttachments,
  isDocumentAttachment,
  mimeTypeForAttachment,
  safeAttachmentFileName,
  type EmailDocumentAttachment,
  type EmailDocumentMessage,
  type EmailDocumentsDeps
} from "../email-documents.service.js";

// ---------------------------------------------------------------------------
// Fixtures FICTICIAS (sin nombres reales)
// ---------------------------------------------------------------------------

const PDF = demoInvoicePdf({ number: "T9-EM-0001" });
const PNG = tinyPng();
const BODY_TEXT = "Adjuntamos la factura del mes. Saludos cordiales del proveedor ficticio.";

const CONTEXT: UserContext = { organizationId: "org_t9em", propertyId: "prop_t9em", userId: "usr_system_pms_shadow", fullName: "Modo sombra OPERA", deviceId: "system:pms-shadow", permissions: [], isPlatformAdmin: false };
const CONNECTION = { id: "conn_t9em", propertyId: "prop_t9em" };

/** Como fetchGmail: `body.attachmentId` por parte y descarga desde base64url de users.messages.attachments.get. */
function gmailAttachment(fileName: string, mimeType: string, bytes: Buffer, attachmentId: string): EmailDocumentAttachment {
  const base64url = bytes.toString("base64").replace(/\+/g, "-").replace(/\//g, "_");
  return { fileName, mimeType, size: bytes.length, attachmentId, download: async () => Buffer.from(base64url.replace(/-/g, "+").replace(/_/g, "/"), "base64") };
}

/** Como fetchGraph: `attachment.id` y descarga desde `contentBytes` (base64) del fileAttachment. */
function graphAttachment(name: string, contentType: string, bytes: Buffer, id: string): EmailDocumentAttachment {
  const contentBytes = bytes.toString("base64");
  return { fileName: name, mimeType: contentType, size: bytes.length, attachmentId: id, download: async () => Buffer.from(contentBytes, "base64") };
}

function message(overrides: Partial<EmailDocumentMessage> = {}): EmailDocumentMessage {
  return { messageId: "18f0a1b2c3d4e5f6", from: "facturacion@proveedor-ficticio.example", subject: "Factura F-2026-0917", receivedAt: "2026-09-19T08:15:00.000Z", attachments: [], ...overrides };
}

function record(id: string, registryNumber: string, sizeBytes: number): IncomingDocumentRecord {
  return { id, registryNumber, sizeBytes, status: "captured", source: "email", physicalStatus: "not_applicable" } as unknown as IncomingDocumentRecord;
}

type Harness = {
  deps: EmailDocumentsDeps;
  captures: CaptureIncomingDocumentsInput[];
  pipeline: Array<{ documentId: string; correlationId: string }>;
  failedMarks: string[];
  logged: unknown[][];
  prior: Map<string, { id: string; registryNumber: string }>;
};

function harness(options: { capture?: (input: CaptureIncomingDocumentsInput, seq: number) => Promise<IncomingDocumentRecord[]>; onCaptured?: EmailDocumentsDeps["onCaptured"]; maxBytes?: number } = {}): Harness {
  const captures: CaptureIncomingDocumentsInput[] = [];
  const pipeline: Array<{ documentId: string; correlationId: string }> = [];
  const failedMarks: string[] = [];
  const logged: unknown[][] = [];
  const prior = new Map<string, { id: string; registryNumber: string }>();
  let seq = 0;
  const deps: EmailDocumentsDeps = {
    capture: async (input) => {
      captures.push(input);
      seq += 1;
      if (options.capture) return options.capture(input, seq);
      const file = (input.body as { files: Array<{ base64: string }> }).files[0]!;
      return [record(`doc_${seq}`, `DOC-T9E-2026-${String(seq).padStart(6, "0")}`, Buffer.from(file.base64, "base64").length)];
    },
    findByAttachment: async (organizationId, messageId, attachmentId) => prior.get(`${organizationId}|${messageId}|${attachmentId}`) ?? null,
    onCaptured:
      options.onCaptured === undefined
        ? async (documentId, correlationId) => {
            pipeline.push({ documentId, correlationId });
          }
        : options.onCaptured,
    markExtractionFailed: async (documentId) => {
      failedMarks.push(documentId);
    },
    maxBytes: () => options.maxBytes ?? DOCUMENT_ATTACHMENT_DEFAULT_MAX_BYTES,
    log: { error: (...args: unknown[]) => void logged.push(args) }
  };
  return { deps, captures, pipeline, failedMarks, logged, prior };
}

/** setImmediate del pipeline en segundo plano: dos vueltas de la cola de macrotareas. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

function fileOf(input: CaptureIncomingDocumentsInput): { fileName: string; mimeType: string; base64: string } {
  return (input.body as { files: Array<{ fileName: string; mimeType: string; base64: string }> }).files[0]!;
}

// ---------------------------------------------------------------------------
// Reglas puras
// ---------------------------------------------------------------------------

describe("isDocumentAttachment — extensión pdf | jpg | jpeg | png | tif | tiff | xml y tamaño ≤ DOCUMENT_MAX_BYTES", () => {
  it("acepta los formatos del módulo de documentos sin distinguir mayúsculas y hasta el límite exacto", () => {
    assert.deepEqual([...DOCUMENT_ATTACHMENT_EXTENSIONS], ["pdf", "jpg", "jpeg", "png", "tif", "tiff", "xml"]);
    assert.equal(isDocumentAttachment({ fileName: "factura.pdf", size: 1024 }), true);
    assert.equal(isDocumentAttachment({ fileName: "IMG_0042.JPG", size: 10 }), true);
    assert.equal(isDocumentAttachment({ fileName: "albaran.jpeg", size: 10 }), true);
    assert.equal(isDocumentAttachment({ fileName: "ticket.png", size: 10 }), true);
    assert.equal(isDocumentAttachment({ fileName: "scan.tif", size: 10 }), true);
    assert.equal(isDocumentAttachment({ fileName: "scan.TIFF", size: 10 }), true);
    assert.equal(isDocumentAttachment({ fileName: "facturae.xml", size: DOCUMENT_ATTACHMENT_DEFAULT_MAX_BYTES }), true, "límite exacto incluido");
    assert.equal(isDocumentAttachment({ fileName: "grande.pdf", size: 0 }), true, "tamaño desconocido (0) pasa y lo acota la captura (413)");
    assert.equal(isDocumentAttachment({ fileName: "x.pdf", size: 65_537 }, 65_536), false, "tope explícito (DOCUMENT_MAX_BYTES en vigor)");
  });

  it("rechaza csv/xlsx/docx/zip (los de OPERA y los ofimáticos), sin extensión, dobles extensiones y ficheros por encima del límite", () => {
    assert.equal(isDocumentAttachment({ fileName: "RESPONSYS_RESV_AUTO.csv", size: 10 }), false);
    assert.equal(isDocumentAttachment({ fileName: "manager_report.xlsx", size: 10 }), false);
    assert.equal(isDocumentAttachment({ fileName: "contrato.docx", size: 10 }), false);
    assert.equal(isDocumentAttachment({ fileName: "factura.pdf.zip", size: 10 }), false);
    assert.equal(isDocumentAttachment({ fileName: "informe", size: 10 }), false);
    assert.equal(isDocumentAttachment({ fileName: "", size: 10 }), false);
    assert.equal(isDocumentAttachment({ fileName: "grande.pdf", size: DOCUMENT_ATTACHMENT_DEFAULT_MAX_BYTES + 1 }), false);
  });
});

describe("mimeTypeForAttachment / safeAttachmentFileName / captureNoteFor", () => {
  it("MIME: el declarado si está en la lista blanca (text/xml → application/xml); octet-stream o vacío → por extensión", () => {
    assert.equal(mimeTypeForAttachment({ fileName: "f.pdf", mimeType: "application/pdf" }), "application/pdf");
    assert.equal(mimeTypeForAttachment({ fileName: "f.xml", mimeType: "Text/XML; charset=utf-8" }), "application/xml");
    assert.equal(mimeTypeForAttachment({ fileName: "f.pdf", mimeType: "application/octet-stream" }), "application/pdf");
    assert.equal(mimeTypeForAttachment({ fileName: "IMG.JPG", mimeType: "" }), "image/jpeg");
    assert.equal(mimeTypeForAttachment({ fileName: "scan.tiff", mimeType: null }), "image/tiff");
    assert.equal(mimeTypeForAttachment({ fileName: "raro.bin", mimeType: "application/octet-stream" }), "application/octet-stream", "sin extensión reconocida se deja el declarado: la captura responderá 400");
  });

  it("nombre: sin barras ni caracteres de control, ≤ 200 caracteres conservando la extensión, vacío → adjunto-<n>.<ext>", () => {
    assert.equal(safeAttachmentFileName("factura.pdf", 1), "factura.pdf");
    assert.equal(safeAttachmentFileName("2026/09/factura\\final.pdf", 1), "2026_09_factura_final.pdf");
    assert.equal(safeAttachmentFileName("linea\nrota\tfactura.pdf", 1), "linea_rota_factura.pdf");
    assert.equal(safeAttachmentFileName("", 3), "adjunto-3");
    assert.equal(safeAttachmentFileName("   ", 2), "adjunto-2");
    assert.equal(safeAttachmentFileName(".pdf", 4), ".pdf");
    const long = `${"a".repeat(250)}.pdf`;
    const safe = safeAttachmentFileName(long, 1);
    assert.equal(safe.length, 200);
    assert.ok(safe.endsWith(".pdf"));
  });

  it("nota de captura: remitente y asunto (nunca el cuerpo); sin ninguno de los dos, ninguna nota", () => {
    assert.equal(captureNoteFor({ from: "a@b.example", subject: "Factura 12" }), "Correo de a@b.example · Asunto: Factura 12");
    assert.equal(captureNoteFor({ from: "", subject: "Factura 12" }), "Asunto: Factura 12");
    assert.equal(captureNoteFor({ from: "a@b.example", subject: null }), "Correo de a@b.example");
    assert.equal(captureNoteFor({ from: " ", subject: "" }), undefined);
    assert.equal(captureNoteFor({ from: "a@b.example", subject: "x".repeat(3000) })!.length, 2000);
  });
});

// ---------------------------------------------------------------------------
// Ingesta con captura inyectada
// ---------------------------------------------------------------------------

describe("ingestDocumentAttachments — mensaje Gmail simulado con un PDF", () => {
  it("1 captura con source email, skipPermissionCheck, emailMeta (messageId, attachmentId, remitente, asunto) y el PDF en base64; el cuerpo no viaja", async () => {
    const h = harness();
    const email = message({ attachments: [gmailAttachment("factura-septiembre.pdf", "application/pdf", PDF, "ANGjAJ9…gmail-part-1")] });
    const outcome = await ingestDocumentAttachments({ context: CONTEXT, connection: CONNECTION, email, correlationId: "corr_t9em_1" }, h.deps);

    assert.deepEqual({ ingested: outcome.ingested, ignored: outcome.ignored, failed: outcome.failed }, { ingested: 1, ignored: 0, failed: 0 });
    assert.deepEqual(outcome.attachments, [{ attachmentId: "ANGjAJ9…gmail-part-1", fileName: "factura-septiembre.pdf", status: "ingested", documentId: "doc_1", registryNumber: "DOC-T9E-2026-000001", sizeBytes: PDF.length }]);

    assert.equal(h.captures.length, 1);
    const capture = h.captures[0]!;
    assert.equal(capture.context, CONTEXT, "contexto de sistema de la organización de la conexión");
    assert.equal(capture.propertyId, "prop_t9em");
    assert.equal(capture.source, "email");
    assert.equal(capture.skipPermissionCheck, true);
    assert.equal(capture.correlationId, "corr_t9em_1");
    assert.deepEqual(capture.emailMeta, { messageId: "18f0a1b2c3d4e5f6", attachmentId: "ANGjAJ9…gmail-part-1", from: "facturacion@proveedor-ficticio.example", subject: "Factura F-2026-0917", receivedAt: "2026-09-19T08:15:00.000Z", connectionId: "conn_t9em" });
    const file = fileOf(capture);
    assert.equal(file.fileName, "factura-septiembre.pdf");
    assert.equal(file.mimeType, "application/pdf");
    assert.ok(Buffer.from(file.base64, "base64").equals(PDF), "los bytes descargados llegan íntegros (base64url de Gmail → base64 estándar)");
    assert.equal((capture.body as { note?: string }).note, "Correo de facturacion@proveedor-ficticio.example · Asunto: Factura F-2026-0917");
    assert.equal((capture.body as { allowDuplicate?: boolean }).allowDuplicate, undefined, "sin allowDuplicate: el sha256 repetido responde 409 y se traduce en ignored");
    assert.ok(!JSON.stringify(capture).includes(BODY_TEXT), "el cuerpo del mensaje no se entrega a la captura");
    assert.ok(!("bodyText" in (capture.emailMeta as object)) && !("body" in (capture.emailMeta as object)));

    await settle();
    assert.deepEqual(h.pipeline, [{ documentId: "doc_1", correlationId: "corr_t9em_1" }], "pipeline en segundo plano tras la captura");
    assert.deepEqual(h.logged, []);
  });
});

describe("ingestDocumentAttachments — mensaje Graph simulado con dos adjuntos", () => {
  it("dos adjuntos → dos documentos (PDF y JPG declarado como octet-stream → image/jpeg); un .docx queda ignored unsupported sin nombre", async () => {
    const h = harness();
    const email = message({
      messageId: "AAMkAGI2…graph-msg",
      attachments: [
        graphAttachment("factura.pdf", "application/pdf", PDF, "AAMkAGI2…att-1"),
        graphAttachment("foto-ticket.jpg", "application/octet-stream", PNG, "AAMkAGI2…att-2"),
        graphAttachment("condiciones.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", Buffer.from("PK"), "AAMkAGI2…att-3")
      ]
    });
    const outcome = await ingestDocumentAttachments({ context: CONTEXT, connection: CONNECTION, email, correlationId: "corr_t9em_2" }, h.deps);

    assert.deepEqual({ ingested: outcome.ingested, ignored: outcome.ignored, failed: outcome.failed }, { ingested: 2, ignored: 1, failed: 0 });
    assert.equal(h.captures.length, 2);
    assert.equal(fileOf(h.captures[0]!).fileName, "factura.pdf");
    assert.equal(fileOf(h.captures[1]!).fileName, "foto-ticket.jpg");
    assert.equal(fileOf(h.captures[1]!).mimeType, "image/jpeg", "octet-stream → MIME por extensión (los magic bytes los comprueba la captura)");
    assert.equal(h.captures[0]!.emailMeta!.attachmentId, "AAMkAGI2…att-1");
    assert.equal(h.captures[1]!.emailMeta!.attachmentId, "AAMkAGI2…att-2");
    assert.deepEqual(outcome.attachments[2], { attachmentId: "AAMkAGI2…att-3", status: "ignored", reason: "unsupported", extension: "docx", size: 2 });
    assert.ok(!JSON.stringify(outcome.attachments[2]).includes("condiciones"), "SEC-07: de un adjunto no reconocido no se guarda el nombre");

    await settle();
    assert.deepEqual(h.pipeline.map((p) => p.documentId), ["doc_1", "doc_2"]);
  });

  it("un adjunto por encima de DOCUMENT_MAX_BYTES no se descarga (ignored unsupported con extensión y tamaño)", async () => {
    let downloaded = false;
    const h = harness({ maxBytes: 1024 });
    const email = message({ attachments: [{ fileName: "escaneo-grande.pdf", mimeType: "application/pdf", size: 5_000_000, attachmentId: "big", download: async () => { downloaded = true; return PDF; } }] });
    const outcome = await ingestDocumentAttachments({ context: CONTEXT, connection: CONNECTION, email, correlationId: "corr_t9em_3" }, h.deps);
    assert.equal(downloaded, false);
    assert.equal(h.captures.length, 0);
    assert.deepEqual(outcome.attachments, [{ attachmentId: "big", status: "ignored", reason: "unsupported", extension: "pdf", size: 5_000_000 }]);
  });
});

describe("ingestDocumentAttachments — dedupe", () => {
  it("adjunto duplicado por sha256 (409 DOCUMENT_DUPLICATE_FILE de la captura) → ignored duplicate con el registro original", async () => {
    const h = harness({
      capture: async (input, seq) => {
        if (seq === 1) return [record("doc_1", "DOC-T9E-2026-000001", PDF.length)];
        throw new HttpError(409, `El fichero «${fileOf(input).fileName}» ya existe en la organización (registro DOC-T9E-2026-000001).`, true, { code: "DOCUMENT_DUPLICATE_FILE", existingId: "doc_1", registryNumber: "DOC-T9E-2026-000001", fileName: fileOf(input).fileName });
      }
    });
    const first = await ingestDocumentAttachments({ context: CONTEXT, connection: CONNECTION, email: message({ messageId: "m1", attachments: [gmailAttachment("factura.pdf", "application/pdf", PDF, "p1")] }), correlationId: "corr_a" }, h.deps);
    assert.equal(first.ingested, 1);
    const second = await ingestDocumentAttachments({ context: CONTEXT, connection: CONNECTION, email: message({ messageId: "m2", attachments: [gmailAttachment("factura (copia).pdf", "application/pdf", PDF, "p9")] }), correlationId: "corr_b" }, h.deps);
    assert.deepEqual({ ingested: second.ingested, ignored: second.ignored, failed: second.failed }, { ingested: 0, ignored: 1, failed: 0 });
    assert.deepEqual(second.attachments, [{ attachmentId: "p9", fileName: "factura (copia).pdf", status: "ignored", reason: "duplicate", documentId: "doc_1", registryNumber: "DOC-T9E-2026-000001" }]);
    await settle();
    assert.deepEqual(h.pipeline.map((p) => p.documentId), ["doc_1"], "el duplicado no lanza el pipeline");
    assert.deepEqual(h.logged, [], "un duplicado no es un error");
  });

  it("reenvío del mismo (messageId, attachmentId) → ignored already_ingested sin descargar ni capturar", async () => {
    let downloads = 0;
    const h = harness();
    const attachment: EmailDocumentAttachment = { fileName: "factura.pdf", mimeType: "application/pdf", size: PDF.length, attachmentId: "part-7", download: async () => { downloads += 1; return PDF; } };
    const email = message({ messageId: "msg-reenviado", attachments: [attachment] });
    const first = await ingestDocumentAttachments({ context: CONTEXT, connection: CONNECTION, email, correlationId: "corr_1" }, h.deps);
    assert.equal(first.ingested, 1);
    h.prior.set("org_t9em|msg-reenviado|part-7", { id: "doc_1", registryNumber: "DOC-T9E-2026-000001" });
    const again = await ingestDocumentAttachments({ context: CONTEXT, connection: CONNECTION, email, correlationId: "corr_2" }, h.deps);
    assert.deepEqual({ ingested: again.ingested, ignored: again.ignored, failed: again.failed }, { ingested: 0, ignored: 1, failed: 0 });
    assert.deepEqual(again.attachments, [{ attachmentId: "part-7", fileName: "factura.pdf", status: "ignored", reason: "already_ingested", documentId: "doc_1", registryNumber: "DOC-T9E-2026-000001" }]);
    assert.equal(downloads, 1, "la segunda vez no se descarga");
    assert.equal(h.captures.length, 1);
  });

  it("sin attachmentId del proveedor se usa la posición (att-<n>): el dedupe sigue funcionando por mensaje", async () => {
    const h = harness();
    const email = message({ messageId: "m-sin-id", attachments: [{ fileName: "a.pdf", mimeType: "application/pdf", size: PDF.length, download: async () => PDF }, { fileName: "b.png", mimeType: "image/png", size: PNG.length, download: async () => PNG }] });
    const outcome = await ingestDocumentAttachments({ context: CONTEXT, connection: CONNECTION, email, correlationId: "corr_x" }, h.deps);
    assert.deepEqual(outcome.attachments.map((a) => a.attachmentId), ["att-1", "att-2"]);
    assert.equal(h.captures[1]!.emailMeta!.attachmentId, "att-2");
  });
});

describe("ingestDocumentAttachments — errores por adjunto (QC-06: nunca detienen el resto)", () => {
  it("413 / 400 de la captura → failed con su código y mensaje; un fallo interno → failed con texto genérico; ambos al log con correlación", async () => {
    const h = harness({
      capture: async (input, seq) => {
        const name = fileOf(input).fileName;
        if (name === "enorme.pdf") throw new HttpError(413, `El fichero «${name}» supera el tamaño máximo admitido (65536 bytes).`, true, { code: "DOCUMENT_TOO_LARGE", fileName: name, sizeBytes: 70_000, maxBytes: 65_536 });
        if (name === "disfrazado.pdf") throw new HttpError(400, "El contenido del fichero no corresponde al tipo declarado (application/pdf).", true, { code: "DOCUMENT_CONTENT_MISMATCH" });
        if (name === "caido.pdf") throw new Error("connect ECONNREFUSED 127.0.0.1:5432");
        return [record(`doc_${seq}`, `DOC-T9E-2026-${String(seq).padStart(6, "0")}`, PDF.length)];
      }
    });
    const email = message({
      attachments: [
        gmailAttachment("enorme.pdf", "application/pdf", PDF, "a1"),
        gmailAttachment("disfrazado.pdf", "application/pdf", PDF, "a2"),
        gmailAttachment("caido.pdf", "application/pdf", PDF, "a3"),
        gmailAttachment("bueno.pdf", "application/pdf", PDF, "a4")
      ]
    });
    const outcome = await ingestDocumentAttachments({ context: CONTEXT, connection: CONNECTION, email, correlationId: "corr_err" }, h.deps);
    assert.deepEqual({ ingested: outcome.ingested, ignored: outcome.ignored, failed: outcome.failed }, { ingested: 1, ignored: 0, failed: 3 });
    assert.deepEqual(outcome.attachments[0], { attachmentId: "a1", fileName: "enorme.pdf", status: "failed", error: "DOCUMENT_TOO_LARGE", message: "El fichero «enorme.pdf» supera el tamaño máximo admitido (65536 bytes)." });
    assert.deepEqual(outcome.attachments[1], { attachmentId: "a2", fileName: "disfrazado.pdf", status: "failed", error: "DOCUMENT_CONTENT_MISMATCH", message: "El contenido del fichero no corresponde al tipo declarado (application/pdf)." });
    assert.deepEqual(outcome.attachments[2], { attachmentId: "a3", fileName: "caido.pdf", status: "failed", error: "ERROR", message: "Error interno al capturar el adjunto; revisa el registro del API con el identificador de correlación." });
    assert.equal(outcome.attachments[3]!.status, "ingested");
    assert.ok(!JSON.stringify(outcome.attachments[2]).includes("ECONNREFUSED"), "SEC-08: el detalle interno no se persiste");
    assert.equal(h.logged.length, 3);
    assert.ok(h.logged.every((entry) => (entry[1] as { correlationId: string }).correlationId === "corr_err"));
    assert.equal((h.logged[2]![1] as { error: string }).error, "connect ECONNREFUSED 127.0.0.1:5432", "el detalle sí va al log");
  });

  it("un fallo al descargar el adjunto cuenta como failed y no toca la captura", async () => {
    const h = harness();
    const email = message({ attachments: [{ fileName: "x.pdf", mimeType: "application/pdf", size: 10, attachmentId: "dl", download: async () => { throw new Error("Gmail attachment falló: 500"); } }] });
    const outcome = await ingestDocumentAttachments({ context: CONTEXT, connection: CONNECTION, email, correlationId: "corr_dl" }, h.deps);
    assert.equal(outcome.failed, 1);
    assert.equal(h.captures.length, 0);
    assert.equal(outcome.attachments[0]!.status, "failed");
  });

  it("si el pipeline en segundo plano falla, el documento queda extractionStatus=failed y el sondeo no se entera", async () => {
    const h = harness({ onCaptured: async () => { throw new Error("proveedor de IA caído"); } });
    const outcome = await ingestDocumentAttachments({ context: CONTEXT, connection: CONNECTION, email: message({ attachments: [gmailAttachment("f.pdf", "application/pdf", PDF, "p")] }), correlationId: "corr_pipe" }, h.deps);
    assert.equal(outcome.ingested, 1);
    await settle();
    await settle();
    assert.deepEqual(h.failedMarks, ["doc_1"]);
    assert.equal(h.logged.length, 1);
  });

  it("onCaptured null (tests de integración): captura sin pipeline", async () => {
    const h = harness({ onCaptured: null });
    await ingestDocumentAttachments({ context: CONTEXT, connection: CONNECTION, email: message({ attachments: [gmailAttachment("f.pdf", "application/pdf", PDF, "p")] }), correlationId: "corr_np" }, h.deps);
    await settle();
    assert.deepEqual(h.pipeline, []);
    assert.deepEqual(h.failedMarks, []);
  });

  it("mensaje sin adjuntos → resultado vacío sin captura", async () => {
    const h = harness();
    const outcome = await ingestDocumentAttachments({ context: CONTEXT, connection: CONNECTION, email: message(), correlationId: "corr_0" }, h.deps);
    assert.deepEqual(outcome, { ingested: 0, ignored: 0, failed: 0, attachments: [] });
    assert.equal(h.captures.length, 0);
  });
});
