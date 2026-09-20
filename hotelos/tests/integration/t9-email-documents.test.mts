/**
 * Tanda T9 · lote T9-07 · integración (Postgres real, tenant AISLADO de
 * helpers/l2-tenant.mts): buzón con propósito `documents`.
 *
 *   · POST /properties/:id/email/connections { provider: manual, purpose: documents }
 *     (usuario `systems`: integrations.connect) → conexión con configJson.purpose
 *     documents, sin exigir fromDomain;
 *   · POST /properties/:id/email/ingest por HTTP (usuario `systems`) con un adjunto
 *     PDF base64 (`attachments`, RV-09) → InboundEmail `documents_ingested` e IncomingDocument con
 *     registryNumber DOC-L2A-<año>-000001, source email, physicalStatus
 *     not_applicable, emailMetaJson (messageId, attachmentId manual-1, remitente,
 *     asunto) y capturado por el contexto de sistema de la organización;
 *   · GET /properties/:id/documents (HTTP, usuario systems) lo lista;
 *   · segundo ingest con los mismos bytes → `documents_ignored` reason duplicate
 *     (sha256) y ningún documento nuevo; el mismo (messageId, attachmentId) →
 *     already_ingested por la consulta JSON real de Prisma;
 *   · dos adjuntos (PDF + PNG) + un .docx → 2 documentos y 1 ignorado sin nombre;
 *   · POST /properties/:id/email/ingest por HTTP con solo cuerpo → `documents_ignored`
 *     reason no_attachment; el cuerpo solo queda como snippet (≤ 280) y no entra en
 *     searchText ni en emailMetaJson de ningún documento;
 *   · Faranda intacta (invariantes idénticas antes y después) y 0 organizaciones residuales.
 *
 * Almacén por defecto del .env del carril (inline si no hay DOCUMENT_STORAGE_KIND).
 *
 *   node --env-file=.env --test tests/integration/t9-email-documents.test.mts
 *   (o desde apps/api: node --env-file-if-exists=../../.env --import tsx --test ../../tests/integration/t9-email-documents.test.mts)
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

const tenantHelpers = await import("./helpers/l2-tenant.mts");
const { createIsolatedTenant, cleanupTenant, loginOrThrow, newRunId, STRICT_ENV, withEnv, farandaInvariants } = tenantHelpers;
type IsolatedTenant = Awaited<ReturnType<typeof createIsolatedTenant>>;
type Session = Awaited<ReturnType<typeof loginOrThrow>>;

const { prisma } = await import("@hotelos/database");
const { buildApiServer } = await import("../../apps/api/src/server.js");
const { flushAuditQueues } = await import("../../apps/api/src/modules/audit/audit.service.js");
const { resetDocumentsConfigForTests } = await import("../../apps/api/src/modules/documents/documents.config.js");
const { ingestManualEmail, purposeOf } = await import("../../apps/api/src/modules/integrations/email/email-reservation.service.js");
const { emailDocumentsDeps, ingestDocumentAttachments } = await import("../../apps/api/src/modules/integrations/email/email-documents.service.js");
const { systemContext } = await import("../../apps/api/src/modules/pms-shadow/pms-shadow.rules.js");
const fixtures = await import("../../apps/api/src/modules/documents/__tests__/fixtures.js");

type ApiApp = Awaited<ReturnType<typeof buildApiServer>>;
type Json = Record<string, any>;
type Reply = { status: number; body: Json };

const strict = <T>(run: () => Promise<T>): Promise<T> => withEnv(STRICT_ENV, run);

async function call(app: ApiApp, method: "GET" | "POST", url: string, session: Session, propertyId: string, payload?: unknown): Promise<Reply> {
  const res = await strict(() => app.inject({ method, url, headers: { ...session.headers, "x-property-id": propertyId }, ...(payload === undefined ? {} : { payload }) }));
  let body: Json = {};
  try {
    body = res.body ? (JSON.parse(res.body) as Json) : {};
  } catch {
    body = { raw: res.body };
  }
  return { status: res.statusCode, body };
}

/** Espera a que el pipeline en segundo plano (trigger email) termine antes de limpiar el tenant. */
async function waitForBackground(documentIds: string[], timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const pending = await prisma.incomingDocument.count({ where: { id: { in: documentIds }, extractionStatus: "pending" } });
    if (pending === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

const RUN = `ed${newRunId()}`;
const YEAR = new Date().getUTCFullYear();
const PDF_1 = fixtures.demoInvoicePdf({ number: "T9-EM-0001" });
const PDF_2 = fixtures.demoInvoicePdf({ number: "T9-EM-0002" });
const PNG = fixtures.tinyPng();
const BODY_TEXT = "Buenos días, adjuntamos la factura del servicio de lavandería de septiembre. Un saludo del proveedor ficticio.";
const b64 = (bytes: Buffer): string => bytes.toString("base64");

let app: ApiApp;
let tenant: IsolatedTenant;
let systems: Session;
let baseline: Awaited<ReturnType<typeof farandaInvariants>>;
let connectionId: string;
let firstDocumentId: string;
const captured: string[] = [];

const contextFor = () => ({
  organizationId: tenant.organizationId,
  propertyId: tenant.propertyA,
  userId: tenant.users.systems.id,
  fullName: "Sistemas Ficticio",
  deviceId: "t9-email-documents",
  permissions: ["integrations.connect"] as never,
  isPlatformAdmin: false
});

before(async () => {
  resetDocumentsConfigForTests();
  app = await buildApiServer();
  await app.ready();
  baseline = await farandaInvariants();
  tenant = await createIsolatedTenant(RUN);
  systems = await strict(() => loginOrThrow(app, tenant.users.systems.email, tenant.password));
});

after(async () => {
  try {
    await waitForBackground(captured);
    await flushAuditQueues();
    if (tenant) await cleanupTenant(tenant.organizationId);
    assert.equal(await prisma.organization.count({ where: { id: tenant?.organizationId ?? "" } }), 0, "sin organizaciones residuales");
    if (baseline) assert.deepEqual(await farandaInvariants(), baseline, "Faranda intacta");
  } finally {
    await app?.close();
    resetDocumentsConfigForTests();
  }
});

describe("T9-07 · conexión manual con propósito documents", () => {
  it("POST /properties/:id/email/connections { provider manual, purpose documents } → conectada, sin exigir fromDomain", async () => {
    const reply = await call(app, "POST", `/properties/${tenant.propertyA}/email/connections`, systems, tenant.propertyA, { provider: "manual", purpose: "documents" });
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    assert.equal(reply.body.provider, "manual");
    assert.equal(reply.body.status, "connected");
    assert.equal(reply.body.config?.purpose, "documents");
    assert.equal(reply.body.needsOAuth, false);
    connectionId = String(reply.body.id);
    const row = await prisma.emailConnection.findUnique({ where: { id: connectionId } });
    assert.ok(row);
    assert.equal(purposeOf(row), "documents");

    // Control: pms_shadow sigue exigiendo fromDomain (SEC-03) y un propósito desconocido es 400.
    const shadow = await call(app, "POST", `/properties/${tenant.propertyA}/email/connections`, systems, tenant.propertyA, { provider: "manual", purpose: "pms_shadow" });
    assert.equal(shadow.status, 400, JSON.stringify(shadow.body));
    const unknown = await call(app, "POST", `/properties/${tenant.propertyA}/email/connections`, systems, tenant.propertyA, { provider: "manual", purpose: "archivo" });
    assert.equal(unknown.status, 400, JSON.stringify(unknown.body));
  });
});

describe("T9-07 · adjunto PDF → IncomingDocument", () => {
  it("un correo con un PDF por HTTP (POST …/email/ingest con attachments, RV-09) → InboundEmail documents_ingested y documento DOC-L2A-<año>-000001 source email / not_applicable con emailMeta", async () => {
    const reply = await call(app, "POST", `/properties/${tenant.propertyA}/email/ingest`, systems, tenant.propertyA, {
      connectionId,
      from: "facturacion@lavanderia-ficticia.example",
      subject: "Factura T9-EM-0001",
      body: BODY_TEXT,
      attachments: [{ fileName: "factura-T9-EM-0001.pdf", mimeType: "application/pdf", base64: b64(PDF_1) }]
    });
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    const row = reply.body as { status: string; connectionId: string; detectedSource: string; parseSource: string; reviewItemId: string | null; snippet: string; draftJson: unknown; messageId: string; receivedAt: string | null };
    assert.equal(row.status, "documents_ingested");
    assert.equal(row.connectionId, connectionId);
    assert.equal(row.detectedSource, "documents");
    assert.equal(row.parseSource, "none");
    assert.equal(row.reviewItemId, null, "sin HITL de reservas");
    assert.equal(row.snippet, BODY_TEXT.slice(0, 280));
    const draft = row.draftJson as { purpose: string; ingested: number; ignored: number; failed: number; attachments: Array<Record<string, unknown>> };
    assert.equal(draft.purpose, "documents");
    assert.deepEqual({ ingested: draft.ingested, ignored: draft.ignored, failed: draft.failed }, { ingested: 1, ignored: 0, failed: 0 });
    assert.equal(draft.attachments[0]!.status, "ingested");
    assert.equal(draft.attachments[0]!.registryNumber, `DOC-L2A-${YEAR}-000001`);
    firstDocumentId = String(draft.attachments[0]!.documentId);
    captured.push(firstDocumentId);

    const doc = await prisma.incomingDocument.findUnique({ where: { id: firstDocumentId }, include: { files: true } });
    assert.ok(doc, "fila incoming_documents");
    assert.equal(doc.organizationId, tenant.organizationId);
    assert.equal(doc.propertyId, tenant.propertyA);
    assert.equal(doc.registryNumber, `DOC-L2A-${YEAR}-000001`);
    assert.equal(doc.registryYear, YEAR);
    assert.equal(doc.registrySeq, 1);
    assert.equal(doc.source, "email");
    assert.equal(doc.physicalStatus, "not_applicable");
    assert.equal(doc.status, "captured");
    assert.equal(doc.title, "factura-T9-EM-0001.pdf");
    assert.equal(doc.sizeBytes, PDF_1.length);
    assert.equal(doc.capturedBy, systemContext(tenant.organizationId, tenant.propertyA).userId, "contexto de sistema de la organización de la conexión, no el del llamante");
    assert.notEqual(doc.capturedBy, tenant.users.systems.id);
    assert.deepEqual(doc.emailMetaJson, {
      messageId: row.messageId,
      attachmentId: "manual-1",
      from: "facturacion@lavanderia-ficticia.example",
      subject: "Factura T9-EM-0001",
      receivedAt: row.receivedAt ?? null,
      connectionId
    });
    assert.ok(doc.searchText?.includes("Factura T9-EM-0001"), "asunto en searchText");
    assert.ok(!doc.searchText?.includes("lavandería de septiembre"), "el cuerpo del correo no entra en searchText");
    assert.ok(!JSON.stringify(doc.emailMetaJson).includes("lavandería de septiembre"), "ni en emailMetaJson");
    assert.equal(doc.files.length, 1);
    assert.equal(doc.files[0]!.role, "original");

    // No hay nada más que el InboundEmail de este mensaje: el cuerpo no se guarda en ningún otro sitio.
    assert.equal(await prisma.inboundEmail.count({ where: { connectionId } }), 1);
    // SEC-02: la auditoría inmutable no lleva remitente, asunto ni nombre del adjunto; solo los ids del mensaje.
    await flushAuditQueues();
    const audit = await prisma.auditEvent.findFirst({ where: { organizationId: tenant.organizationId, action: "DOCUMENT_CAPTURED", entityId: firstDocumentId } });
    assert.ok(audit, "DOCUMENT_CAPTURED auditado");
    const afterJson = JSON.stringify(audit.afterJson ?? {});
    assert.doesNotMatch(afterJson, /lavanderia-ficticia|Factura T9-EM-0001|factura-T9-EM-0001\.pdf|Correo de/);
    assert.equal((audit.afterJson as { email?: { messageId?: string; attachmentId?: string; connectionId?: string } }).email?.messageId, row.messageId);
    assert.equal((audit.afterJson as { email?: { attachmentId?: string } }).email?.attachmentId, "manual-1");
    assert.equal((audit.afterJson as { email?: { connectionId?: string } }).email?.connectionId, connectionId);
    assert.equal((audit.afterJson as { source?: string }).source, "email");
  });

  it("GET /properties/:id/documents (HTTP) lista el documento con source email", async () => {
    const reply = await call(app, "GET", `/properties/${tenant.propertyA}/documents`, systems, tenant.propertyA);
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    const rows = reply.body as unknown as Array<Record<string, unknown>>;
    assert.ok(Array.isArray(rows));
    const mine = rows.find((r) => r.id === firstDocumentId);
    assert.ok(mine, "el documento del correo aparece en la bandeja del centro");
    assert.equal(mine.source, "email");
    assert.equal(mine.physicalStatus, "not_applicable");
    assert.equal(mine.registryNumber, `DOC-L2A-${YEAR}-000001`);
  });

  it("segundo ingest con los mismos bytes → documents_ignored reason duplicate (sha256) y ningún documento nuevo", async () => {
    const row = await ingestManualEmail({
      context: contextFor(),
      propertyId: tenant.propertyA,
      connectionId,
      from: "facturacion@lavanderia-ficticia.example",
      subject: "RV: Factura T9-EM-0001",
      body: "Reenvío por si no llegó.",
      attachments: [{ fileName: "factura-T9-EM-0001 (copia).pdf", mimeType: "application/pdf", base64: b64(PDF_1) }],
      correlationId: "corr_t9em_int_2"
    });
    assert.equal(row.status, "documents_ignored");
    const draft = row.draftJson as { ingested: number; ignored: number; failed: number; attachments: Array<Record<string, unknown>> };
    assert.deepEqual({ ingested: draft.ingested, ignored: draft.ignored, failed: draft.failed }, { ingested: 0, ignored: 1, failed: 0 });
    assert.equal(draft.attachments[0]!.status, "ignored");
    assert.equal(draft.attachments[0]!.reason, "duplicate");
    assert.equal(draft.attachments[0]!.documentId, firstDocumentId);
    assert.equal(draft.attachments[0]!.registryNumber, `DOC-L2A-${YEAR}-000001`);
    assert.equal(await prisma.incomingDocument.count({ where: { organizationId: tenant.organizationId } }), 1);
  });

  it("el mismo (messageId, attachmentId) reenviado → already_ingested por la consulta JSON de Prisma (sin captura)", async () => {
    const first = await prisma.incomingDocument.findUniqueOrThrow({ where: { id: firstDocumentId }, select: { emailMetaJson: true } });
    const meta = first.emailMetaJson as { messageId: string; attachmentId: string };
    const outcome = await ingestDocumentAttachments(
      {
        context: systemContext(tenant.organizationId, tenant.propertyA),
        connection: { id: connectionId, propertyId: tenant.propertyA },
        email: { messageId: meta.messageId, from: "x@example", subject: "reenvío", attachments: [{ fileName: "otro-nombre.pdf", mimeType: "application/pdf", size: PDF_2.length, attachmentId: meta.attachmentId, download: async () => PDF_2 }] },
        correlationId: "corr_t9em_int_3"
      },
      emailDocumentsDeps({ onCaptured: null })
    );
    assert.deepEqual({ ingested: outcome.ingested, ignored: outcome.ignored, failed: outcome.failed }, { ingested: 0, ignored: 1, failed: 0 });
    assert.equal(outcome.attachments[0]!.status, "ignored");
    assert.equal((outcome.attachments[0] as { reason: string }).reason, "already_ingested");
    assert.equal((outcome.attachments[0] as { documentId: string }).documentId, firstDocumentId);
    assert.equal(await prisma.incomingDocument.count({ where: { organizationId: tenant.organizationId } }), 1);
  });

  it("dos adjuntos (PDF + PNG) y un .docx → 2 documentos (000002, 000003) y 1 ignorado sin nombre", async () => {
    const row = await ingestManualEmail({
      context: contextFor(),
      propertyId: tenant.propertyA,
      connectionId,
      from: "compras@proveedor-ficticio.example",
      subject: "Factura T9-EM-0002 y foto del albarán",
      body: "",
      attachments: [
        { fileName: "factura-T9-EM-0002.pdf", mimeType: "application/pdf", base64: b64(PDF_2) },
        { fileName: "albaran.png", mimeType: "application/octet-stream", base64: b64(PNG) },
        { fileName: "condiciones-generales.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", base64: b64(Buffer.from("PK", "latin1")) }
      ],
      correlationId: "corr_t9em_int_4"
    });
    assert.equal(row.status, "documents_ingested");
    const draft = row.draftJson as { ingested: number; ignored: number; failed: number; attachments: Array<Record<string, unknown>> };
    assert.deepEqual({ ingested: draft.ingested, ignored: draft.ignored, failed: draft.failed }, { ingested: 2, ignored: 1, failed: 0 });
    assert.equal(draft.attachments[0]!.registryNumber, `DOC-L2A-${YEAR}-000002`);
    assert.equal(draft.attachments[1]!.registryNumber, `DOC-L2A-${YEAR}-000003`);
    assert.deepEqual(draft.attachments[2], { attachmentId: "manual-3", status: "ignored", reason: "unsupported", extension: "docx", size: 4 });
    captured.push(String(draft.attachments[0]!.documentId), String(draft.attachments[1]!.documentId));

    const png = await prisma.incomingDocument.findUniqueOrThrow({ where: { id: String(draft.attachments[1]!.documentId) } });
    assert.equal(png.originalFormat, "image/png", "octet-stream → MIME por extensión, confirmado por los magic bytes");
    assert.equal(png.source, "email");
    assert.equal((png.emailMetaJson as { attachmentId: string }).attachmentId, "manual-2");
    assert.equal(await prisma.incomingDocument.count({ where: { organizationId: tenant.organizationId } }), 3);
  });
});

describe("T9-07 · ruta HTTP de ingesta manual sobre el buzón documents", () => {
  it("POST /properties/:id/email/ingest con solo cuerpo → documents_ignored reason no_attachment; ni HITL ni documento", async () => {
    const reply = await call(app, "POST", `/properties/${tenant.propertyA}/email/ingest`, systems, tenant.propertyA, {
      connectionId,
      from: "reservas@cliente-ficticio.example",
      subject: "Reserva para el fin de semana",
      body: "Quisiera reservar una habitación doble del 10 al 12 de octubre. Gracias."
    });
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    assert.equal(reply.body.status, "documents_ignored", "un buzón documents nunca extrae reservas aunque el texto lo parezca");
    assert.equal(reply.body.detectedSource, "documents");
    assert.equal((reply.body.draftJson as { reason: string }).reason, "no_attachment");
    assert.equal(await prisma.aiHumanReviewItem.count({ where: { propertyId: tenant.propertyA, reviewType: "email_reservation" } }), 0);
    assert.equal(await prisma.incomingDocument.count({ where: { organizationId: tenant.organizationId } }), 3);
    const persisted = await prisma.inboundEmail.findUnique({ where: { id: String(reply.body.id) } });
    assert.equal(persisted?.snippet, "Quisiera reservar una habitación doble del 10 al 12 de octubre. Gracias.");
  });

  it("la lista de correos del centro muestra los 4 mensajes con sus estados documents_*", async () => {
    const reply = await call(app, "GET", `/properties/${tenant.propertyA}/email/inbound`, systems, tenant.propertyA);
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    const rows = reply.body as unknown as Array<{ status: string; detectedSource: string }>;
    assert.equal(rows.length, 4);
    assert.deepEqual(rows.map((r) => r.status).sort(), ["documents_ignored", "documents_ignored", "documents_ingested", "documents_ingested"]);
    assert.ok(rows.every((r) => r.detectedSource === "documents"));
  });
});
