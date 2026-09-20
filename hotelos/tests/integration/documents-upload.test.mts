/**
 * Tanda T9 · lote T9-05a · integración (Postgres): captura multi-fichero,
 * registro, dedupe, bandeja, detalle, descarga binaria, enviar a la oficina,
 * recaptura y cola de la oficina sobre un tenant AISLADO (helpers/l2-tenant.mts,
 * organización `org_l2_t9up…`), auth real y RBAC_STRICT; Faranda y org_123
 * solo se leen (invariantes antes y después).
 *
 * Almacén en disco en un directorio temporal (DOCUMENT_STORAGE_KIND=disk sin
 * cifrado en reposo) y tope por fichero DOCUMENT_MAX_BYTES=65536 (mínimo del
 * contrato) para provocar el 413 con un PDF de ~72 KB en vez de 26 MB. Las
 * variables se fijan ANTES de importar el servidor (documents.config.ts las
 * memoriza en la primera lectura).
 *
 * Fixtures inventadas (modules/documents/__tests__/fixtures.ts); ningún nombre real.
 *
 * Run: cd apps/api && node --env-file-if-exists=../../.env --import tsx --test ../../tests/integration/documents-upload.test.mts
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

const STORAGE_DIR = mkdtempSync(join(tmpdir(), "ehotelos-t9up-"));
const MAX_BYTES = 65_536;
process.env.DOCUMENT_STORAGE_KIND = "disk";
process.env.DOCUMENT_STORAGE_DIR = STORAGE_DIR;
process.env.DOCUMENT_ENCRYPT_AT_REST = "false";
process.env.DOCUMENT_MAX_BYTES = String(MAX_BYTES);
process.env.DOCUMENT_UPLOAD_BODY_LIMIT = String(4 * 1024 * 1024);

const tenantHelpers = await import("./helpers/l2-tenant.mts");
const { createIsolatedTenant, enableModules, cleanupTenant, loginOrThrow, newRunId, STRICT_ENV, withEnv, farandaInvariants } = tenantHelpers;
type IsolatedTenant = Awaited<ReturnType<typeof createIsolatedTenant>>;
type Session = Awaited<ReturnType<typeof loginOrThrow>>;

const { prisma, hashPassword } = await import("@hotelos/database");
const { buildApiServer } = await import("../../apps/api/src/server.js");
const { routePermissionManifest } = await import("../../apps/api/src/security/route-permissions.js");
const { flushAuditQueues } = await import("../../apps/api/src/modules/audit/audit.service.js");
const { resetRbacScopeCacheForTests } = await import("../../apps/api/src/lib/rbac-scope.js");
const { resetDocumentsConfigForTests } = await import("../../apps/api/src/modules/documents/documents.config.js");
const { registerDocumentsRoutes } = await import("../../apps/api/src/modules/documents/documents.routes.js");
const { documentsRoutePermissions } = await import("../../apps/api/src/modules/documents/route-permissions.partial.js");
const fixtures = await import("../../apps/api/src/modules/documents/__tests__/fixtures.js");

type ApiApp = Awaited<ReturnType<typeof buildApiServer>>;
type Json = Record<string, any>;
type Reply = { status: number; body: Json; raw: Buffer; headers: Record<string, string | string[] | undefined> };

const strict = <T>(run: () => Promise<T>): Promise<T> => withEnv(STRICT_ENV, run);

async function call(app: ApiApp, method: "GET" | "POST" | "PATCH" | "DELETE", url: string, session: Session, payload?: unknown, propertyId?: string): Promise<Reply> {
  const res = await strict(() => app.inject({ method, url, headers: { ...session.headers, ...(propertyId ? { "x-property-id": propertyId } : {}) }, ...(payload === undefined ? {} : { payload }) }));
  let body: Json = {};
  try {
    body = res.body ? (JSON.parse(res.body) as Json) : {};
  } catch {
    body = { raw: res.body };
  }
  return { status: res.statusCode, body, raw: res.rawPayload, headers: res.headers as Record<string, string | string[] | undefined> };
}

const codeOf = (reply: Reply): string | undefined => (reply.body.details as { code?: string } | undefined)?.code;
const b64 = (bytes: Buffer | string): string => (typeof bytes === "string" ? Buffer.from(bytes, "utf8") : bytes).toString("base64");
const pdfUpload = (fileName: string, bytes: Buffer, extra: Json = {}): Json => ({ files: [{ fileName, mimeType: "application/pdf", base64: b64(bytes) }], ...extra });

/** Usuario extra con una plantilla en los centros dados (barrido por cleanupTenant; patrón l8-reputation-routes.test.mts). */
async function addUser(tenant: IsolatedTenant, key: string, templateKey: string, propertyIds: string[]): Promise<{ id: string; email: string }> {
  const id = `usr_t9up_${key}_${tenant.run}`;
  const email = `${key}.t9up.${tenant.run}@faranda.test`;
  await prisma.user.create({
    data: { id, organizationId: tenant.organizationId, email, fullName: `T9 ${key} ${tenant.run}`, status: "active", passwordHash: hashPassword(tenant.password), mustChangePassword: false, passwordChangedAt: new Date() }
  });
  const roleId = tenant.roles[templateKey];
  if (!roleId) throw new Error(`Sin rol de plantilla «${templateKey}» en ${tenant.organizationId}.`);
  for (const propertyId of propertyIds) {
    await prisma.userRoleAssignment.create({ data: { userId: id, roleId, scopeType: "property", propertyId, organizationId: tenant.organizationId, reason: `t9up ${key}` } });
  }
  resetRbacScopeCacheForTests();
  return { id, email };
}

const RUN_A = `t9up${newRunId()}`;
const RUN_B = `${RUN_A}b`;
const YEAR = new Date().getUTCFullYear();

let app: ApiApp;
let tenantA: IsolatedTenant;
let tenantB: IsolatedTenant;
let receptionistA: Session;
let accountantA: Session;
let clerkA: Session;
let ownerB: Session;
let baseline: Awaited<ReturnType<typeof farandaInvariants>>;
let wiredByServer = true;

const INVOICE_1 = fixtures.demoInvoicePdf({ number: "T9-UP-0001" });
const INVOICE_2 = fixtures.demoInvoicePdf({ number: "T9-UP-0002" });
const INVOICE_3 = fixtures.multiPagePdf(3);
const RECAPTURE_PDF = fixtures.demoInvoicePdf({ number: "T9-UP-0001-bis", issueDate: "2026-09-02" });
/** PDF válido de ~72 KB: supera DOCUMENT_MAX_BYTES=65536 sin necesitar 26 MB. */
const OVERSIZED_PDF = Buffer.concat([fixtures.demoInvoicePdf({ number: "T9-UP-BIG" }), Buffer.from(`\n%${"x".repeat(70_000)}\n`, "latin1")]);

let doc1: Json;
let doc2: Json;
let docDup: Json;

before(async () => {
  resetDocumentsConfigForTests();
  app = await buildApiServer();
  // Hasta que el integrador (T9-05b) registre las rutas en server.ts, la suite las cablea ella misma.
  if (!routePermissionManifest.some((entry) => entry.path === "/properties/:propertyId/documents")) {
    wiredByServer = false;
    routePermissionManifest.push(...documentsRoutePermissions);
    registerDocumentsRoutes(app, { uploadBodyLimit: 4 * 1024 * 1024 });
  }
  await app.ready();
  baseline = await farandaInvariants();
  tenantA = await createIsolatedTenant(RUN_A);
  tenantB = await createIsolatedTenant(RUN_B);
  await enableModules(tenantA.propertyA, ["erp_accounting", "procurement_inventory"]);
  const clerk = await addUser(tenantA, "clerk", "admin_clerk", [tenantA.propertyA]);
  receptionistA = await strict(() => loginOrThrow(app, tenantA.users.receptionist.email, tenantA.password));
  accountantA = await strict(() => loginOrThrow(app, tenantA.users.accountant.email, tenantA.password));
  clerkA = await strict(() => loginOrThrow(app, clerk.email, tenantA.password));
  ownerB = await strict(() => loginOrThrow(app, tenantB.users.owner.email, tenantB.password));
});

after(async () => {
  try {
    if (tenantA) await cleanupTenant(tenantA.organizationId);
    if (tenantB) await cleanupTenant(tenantB.organizationId);
    assert.equal(await prisma.organization.count({ where: { id: { in: [tenantA?.organizationId ?? "", tenantB?.organizationId ?? ""] } } }), 0, "sin organizaciones residuales");
    if (baseline) assert.deepEqual(await farandaInvariants(), baseline, "Faranda intacta");
  } finally {
    await app?.close();
    resetDocumentsConfigForTests();
    rmSync(STORAGE_DIR, { recursive: true, force: true });
  }
});

describe("T9-05a · captura y registro", () => {
  it("POST 201 con registro DOC-<code>-<año>-000001 y 000002; fila, fichero y clave en disco", async () => {
    const first = await call(app, "POST", `/properties/${tenantA.propertyA}/documents`, receptionistA, pdfUpload("factura-lavanderia.pdf", INVOICE_1, { kindHint: "invoice", note: "Recibida en recepción" }));
    assert.equal(first.status, 201, JSON.stringify(first.body));
    assert.ok(Array.isArray(first.body), "201 devuelve IncomingDocumentRecord[]");
    doc1 = (first.body as unknown as Json[])[0]!;
    assert.equal(doc1.registryNumber, `DOC-L2A-${YEAR}-000001`);
    assert.equal(doc1.status, "captured");
    assert.equal(doc1.physicalStatus, "at_centre");
    assert.equal(doc1.extractionStatus, "pending");
    assert.equal(doc1.kind, "invoice");
    assert.equal(doc1.propertyId, tenantA.propertyA);
    assert.equal(doc1.organizationId, tenantA.organizationId);
    assert.equal(doc1.capturedBy, receptionistA.userId);
    assert.equal(doc1.pageCount, 1);
    assert.equal(doc1.sizeBytes, INVOICE_1.length);

    const second = await call(app, "POST", `/properties/${tenantA.propertyA}/documents`, receptionistA, pdfUpload("albaran.pdf", INVOICE_3, { kindHint: "delivery_note" }));
    assert.equal(second.status, 201, JSON.stringify(second.body));
    doc2 = (second.body as unknown as Json[])[0]!;
    assert.equal(doc2.registryNumber, `DOC-L2A-${YEAR}-000002`);
    assert.equal(doc2.pageCount, 3);

    const row = await prisma.incomingDocument.findUnique({ where: { id: doc1.id }, include: { files: true, pages: true } });
    assert.ok(row, "fila incoming_documents");
    assert.equal(row.registryYear, YEAR);
    assert.equal(row.registrySeq, 1);
    assert.equal(row.legalEntityId, tenantA.legalEntityId);
    assert.equal(row.files.length, 1);
    const file = row.files[0]!;
    assert.equal(file.role, "original");
    assert.equal(file.storageKind, "disk");
    assert.equal(file.inline, null);
    assert.equal(file.encrypted, false);
    assert.equal(file.storageKey, `org/${tenantA.organizationId}/prop/${tenantA.propertyA}/doc/${doc1.id}/${doc1.sha256}.pdf`);
    assert.ok(existsSync(join(STORAGE_DIR, file.storageKey!)), `fichero en disco ${file.storageKey}`);
    assert.equal(row.pages.length, 1);
    assert.equal((await prisma.documentPage.count({ where: { documentId: doc2.id } })), 3);
  });

  it("413 DOCUMENT_TOO_LARGE por tamaño (antes de decodificar)", async () => {
    const reply = await call(app, "POST", `/properties/${tenantA.propertyA}/documents`, receptionistA, pdfUpload("grande.pdf", OVERSIZED_PDF));
    assert.equal(reply.status, 413, JSON.stringify(reply.body));
    assert.equal(codeOf(reply), "DOCUMENT_TOO_LARGE");
    assert.equal(reply.body.error, "Payload Too Large");
    assert.equal(reply.body.details.maxBytes, MAX_BYTES);
  });

  it("400 DOCUMENT_MIME_NOT_ALLOWED (text/html) y 400 DOCUMENT_CONTENT_MISMATCH (HTML disfrazado de PDF)", async () => {
    const html = await call(app, "POST", `/properties/${tenantA.propertyA}/documents`, receptionistA, { files: [{ fileName: "x.html", mimeType: "text/html", base64: b64("<html><body>x</body></html>") }] });
    assert.equal(html.status, 400, JSON.stringify(html.body));
    assert.equal(codeOf(html), "DOCUMENT_MIME_NOT_ALLOWED");
    const disguised = await call(app, "POST", `/properties/${tenantA.propertyA}/documents`, receptionistA, pdfUpload("x.pdf", fixtures.htmlDisguisedAsPdf()));
    assert.equal(disguised.status, 400, JSON.stringify(disguised.body));
    assert.equal(codeOf(disguised), "DOCUMENT_CONTENT_MISMATCH");
    const invalid = await call(app, "POST", `/properties/${tenantA.propertyA}/documents`, receptionistA, { files: [{ fileName: "x.pdf", mimeType: "application/pdf", base64: "no-base64!" }] });
    assert.equal(invalid.status, 400);
    assert.equal(codeOf(invalid), "VALIDATION_ERROR");
    assert.equal(await prisma.incomingDocument.count({ where: { organizationId: tenantA.organizationId } }), 2, "ningún rechazo deja fila");
  });

  it("409 DOCUMENT_DUPLICATE_FILE con existingId; 201 con allowDuplicate (registro 000003)", async () => {
    const dup = await call(app, "POST", `/properties/${tenantA.propertyA}/documents`, receptionistA, pdfUpload("factura-lavanderia-copia.pdf", INVOICE_1));
    assert.equal(dup.status, 409, JSON.stringify(dup.body));
    assert.equal(codeOf(dup), "DOCUMENT_DUPLICATE_FILE");
    assert.equal(dup.body.details.existingId, doc1.id);
    const allowed = await call(app, "POST", `/properties/${tenantA.propertyA}/documents`, receptionistA, pdfUpload("factura-lavanderia-copia.pdf", INVOICE_1, { allowDuplicate: true }));
    assert.equal(allowed.status, 201, JSON.stringify(allowed.body));
    docDup = (allowed.body as unknown as Json[])[0]!;
    assert.equal(docDup.registryNumber, `DOC-L2A-${YEAR}-000003`);
    assert.equal(docDup.sha256, doc1.sha256);
    assert.notEqual(docDup.id, doc1.id);
  });

  it("POST …/:id/files añade un derivado (reverso PNG) → 201 DocumentFileDto sin bytes ni clave", async () => {
    const reply = await call(app, "POST", `/properties/${tenantA.propertyA}/documents/${doc1.id}/files`, receptionistA, { fileName: "reverso.png", mimeType: "image/png", base64: b64(fixtures.tinyPng()), role: "derived", note: "reverso" });
    assert.equal(reply.status, 201, JSON.stringify(reply.body));
    assert.equal(reply.body.role, "derived");
    assert.equal(reply.body.documentId, doc1.id);
    assert.equal(reply.body.mimeType, "image/png");
    assert.equal("storageKey" in reply.body, false);
    assert.equal("inline" in reply.body, false);
    const again = await call(app, "POST", `/properties/${tenantA.propertyA}/documents/${doc1.id}/files`, receptionistA, { fileName: "reverso.png", mimeType: "image/png", base64: b64(fixtures.tinyPng()) });
    assert.equal(again.status, 409);
    assert.equal(codeOf(again), "DOCUMENT_DUPLICATE_FILE");
  });

  it("sin documents.capture (accountant) → 403; centro fuera del ámbito (receptionist en B) → 404 opaco", async () => {
    const forbidden = await call(app, "POST", `/properties/${tenantA.propertyA}/documents`, accountantA, pdfUpload("x.pdf", INVOICE_2));
    assert.equal(forbidden.status, 403, JSON.stringify(forbidden.body));
    const outOfScope = await call(app, "POST", `/properties/${tenantA.propertyB}/documents`, receptionistA, pdfUpload("x.pdf", INVOICE_2));
    assert.equal(outOfScope.status, 404, JSON.stringify(outOfScope.body));
  });
});

describe("T9-05a · descarga binaria", () => {
  it("GET …/file: content-type, content-disposition attachment, nosniff, no-store y bytes idénticos; ?inline=1 → inline", async () => {
    const reply = await call(app, "GET", `/properties/${tenantA.propertyA}/documents/${doc1.id}/file`, receptionistA);
    assert.equal(reply.status, 200, reply.raw.toString("utf8").slice(0, 200));
    assert.equal(reply.headers["content-type"], "application/pdf");
    assert.match(String(reply.headers["content-disposition"]), /^attachment; filename="factura-lavanderia\.pdf"/);
    assert.equal(reply.headers["x-content-type-options"], "nosniff");
    assert.equal(reply.headers["cache-control"], "private, no-store");
    assert.equal(reply.headers["content-length"], String(INVOICE_1.length));
    assert.ok(reply.raw.equals(INVOICE_1), "bytes idénticos");
    assert.equal(reply.raw.subarray(0, 5).toString("latin1"), "%PDF-");

    const inline = await call(app, "GET", `/properties/${tenantA.propertyA}/documents/${doc1.id}/file?inline=1`, accountantA);
    assert.equal(inline.status, 200);
    assert.match(String(inline.headers["content-disposition"]), /^inline; filename=/);
    assert.ok(inline.raw.equals(INVOICE_1));
  });

  it("GET …/pages/1/image: PDF sin rasterizar → 404 DOCUMENT_PAGE_IMAGE_UNAVAILABLE (no el opaco); captura PNG → el original como página 1; página no entera → 400 (RV-17)", async () => {
    const missing = await call(app, "GET", `/properties/${tenantA.propertyA}/documents/${doc1.id}/pages/1/image`, receptionistA);
    assert.equal(missing.status, 404, JSON.stringify(missing.body));
    assert.equal(codeOf(missing), "DOCUMENT_PAGE_IMAGE_UNAVAILABLE");
    assert.equal(missing.body.details.pageNo, 1);
    const bad = await call(app, "GET", `/properties/${tenantA.propertyA}/documents/${doc1.id}/pages/x/image`, receptionistA);
    assert.equal(bad.status, 400);
    const png = fixtures.tinyPng();
    const photo = await call(app, "POST", `/properties/${tenantA.propertyA}/documents`, receptionistA, { files: [{ fileName: "foto-ticket.png", mimeType: "image/png", base64: b64(png) }], kindHint: "receipt", allowDuplicate: true });
    assert.equal(photo.status, 201, JSON.stringify(photo.body));
    const photoId = (photo.body as unknown as Json[])[0]!.id as string;
    const page = await call(app, "GET", `/properties/${tenantA.propertyA}/documents/${photoId}/pages/1/image`, receptionistA);
    assert.equal(page.status, 200, page.raw.toString("utf8").slice(0, 200));
    assert.equal(page.headers["content-type"], "image/png");
    assert.ok(page.raw.equals(png), "la página 1 de una captura de imagen es el propio original");
    const beyond = await call(app, "GET", `/properties/${tenantA.propertyA}/documents/${photoId}/pages/2/image`, receptionistA);
    assert.equal(beyond.status, 404);
    assert.equal(codeOf(beyond), "DOCUMENT_PAGE_IMAGE_UNAVAILABLE");
    const unknown = await call(app, "GET", `/properties/${tenantA.propertyA}/documents/doc_inexistente/pages/1/image`, receptionistA);
    assert.equal(codeOf(unknown), "DOCUMENT_NOT_FOUND", "un documento inexistente sigue siendo el 404 opaco");
    // La captura de esta prueba no cuenta en la bandeja de las siguientes (recuentos pinados a 3 documentos).
    for (let i = 0; i < 100; i += 1) {
      const row = await prisma.incomingDocument.findUnique({ where: { id: photoId }, select: { extractionStatus: true } });
      if (!row || row.extractionStatus !== "pending") break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    await prisma.incomingDocument.delete({ where: { id: photoId } });
  });

  it("descargas auditadas (DOCUMENT_DOWNLOADED) y captura auditada (DOCUMENT_CAPTURED), sin bytes ni claves", async () => {
    await flushAuditQueues();
    const captured = await prisma.auditEvent.findMany({ where: { organizationId: tenantA.organizationId, action: "DOCUMENT_CAPTURED" } });
    assert.ok(captured.length >= 3, `DOCUMENT_CAPTURED ≥ 3 (hay ${captured.length})`);
    const downloaded = await prisma.auditEvent.findMany({ where: { organizationId: tenantA.organizationId, action: "DOCUMENT_DOWNLOADED", entityId: doc1.id } });
    assert.ok(downloaded.length >= 2, `DOCUMENT_DOWNLOADED ≥ 2 (hay ${downloaded.length})`);
    for (const event of [...captured, ...downloaded]) {
      const after = JSON.stringify(event.afterJson ?? {});
      assert.equal(after.includes("org/"), false, "sin clave del almacén en la auditoría");
      assert.equal(after.includes("base64"), false);
      assert.equal(event.entityType, "incoming_document");
    }
  });
});

describe("T9-05a · tenencia y visibilidad", () => {
  it("otra organización → 404 opaco (hook); otro centro de la misma organización → 404 DOCUMENT_NOT_FOUND", async () => {
    const foreign = await call(app, "GET", `/properties/${tenantA.propertyA}/documents/${doc1.id}`, ownerB);
    assert.equal(foreign.status, 404, JSON.stringify(foreign.body));
    const foreignFile = await call(app, "GET", `/properties/${tenantA.propertyA}/documents/${doc1.id}/file`, ownerB);
    assert.equal(foreignFile.status, 404);
    const crossProperty = await call(app, "GET", `/properties/${tenantA.propertyB}/documents/${doc1.id}`, accountantA);
    assert.equal(crossProperty.status, 404, JSON.stringify(crossProperty.body));
    assert.equal(codeOf(crossProperty), "DOCUMENT_NOT_FOUND");
    const unknown = await call(app, "GET", `/properties/${tenantA.propertyA}/documents/doc_inexistente`, receptionistA);
    assert.equal(unknown.status, 404);
    assert.equal(codeOf(unknown), "DOCUMENT_NOT_FOUND");
  });

  it("GET detalle: files, pages, última extracción (null hasta que corra el pipeline T9-06a), checks, proposal; capture y review lo ven", async () => {
    const detail = await call(app, "GET", `/properties/${tenantA.propertyA}/documents/${doc1.id}`, receptionistA);
    assert.equal(detail.status, 200, JSON.stringify(detail.body));
    assert.equal(detail.body.id, doc1.id);
    assert.equal(detail.body.files.length, 2);
    assert.deepEqual(detail.body.files.map((f: Json) => f.role).sort(), ["derived", "original"]);
    assert.equal(detail.body.pages.length, 1);
    assert.equal(detail.body.pages[0].pageNo, 1);
    // Con server.ts cableado, onCaptured lanza el pipeline (T9-06a) tras el 201: la extracción por
    // reglas puede haber corrido ya (extraction / checks / proposal informados) o no (null).
    if (detail.body.extraction === null) {
      assert.equal(detail.body.checks, null);
      assert.equal(detail.body.proposal, null);
      assert.equal(detail.body.extractionStatus, "pending");
    } else {
      assert.equal(detail.body.extraction.documentId, doc1.id);
      assert.ok(["ai", "text_rules", "e_invoice", "manual"].includes(detail.body.extraction.source), `source ${detail.body.extraction.source}`);
      assert.equal(typeof detail.body.extraction.fields, "object");
      assert.ok(["done", "failed", "skipped"].includes(detail.body.extractionStatus), `extractionStatus ${detail.body.extractionStatus}`);
    }
    assert.deepEqual(detail.body.actions, []);
    assert.deepEqual(detail.body.matches, []);
    assert.equal(detail.body.slaBreached, false);
    for (const file of detail.body.files) {
      assert.equal("storageKey" in file, false);
      assert.equal("inline" in file, false);
    }
    const asReviewer = await call(app, "GET", `/properties/${tenantA.propertyA}/documents/${doc1.id}`, accountantA);
    assert.equal(asReviewer.status, 200, JSON.stringify(asReviewer.body));
  });
});

describe("T9-05a · bandeja del centro (filtros y cursor)", () => {
  it("array plano por defecto con cabeceras; ?limit=1 → X-Next-Cursor; ?cursor= → envelope con la página siguiente", async () => {
    const all = await call(app, "GET", `/properties/${tenantA.propertyA}/documents`, receptionistA);
    assert.equal(all.status, 200, JSON.stringify(all.body));
    assert.ok(Array.isArray(all.body));
    const list = all.body as unknown as Json[];
    assert.equal(list.length, 3);
    assert.equal(all.headers["x-total-count"], "3");
    assert.deepEqual(list.map((d) => d.registryNumber), [`DOC-L2A-${YEAR}-000003`, `DOC-L2A-${YEAR}-000002`, `DOC-L2A-${YEAR}-000001`], "más reciente primero");

    const first = await call(app, "GET", `/properties/${tenantA.propertyA}/documents?limit=1`, receptionistA);
    assert.equal(first.status, 200);
    assert.equal((first.body as unknown as Json[]).length, 1);
    const cursor = String(first.headers["x-next-cursor"]);
    assert.ok(cursor.length > 0, "X-Next-Cursor");
    const second = await call(app, "GET", `/properties/${tenantA.propertyA}/documents?limit=1&cursor=${encodeURIComponent(cursor)}`, receptionistA);
    assert.equal(second.status, 200, JSON.stringify(second.body));
    assert.equal(second.body.items.length, 1);
    assert.equal(second.body.total, 3);
    assert.equal(second.body.items[0].registryNumber, `DOC-L2A-${YEAR}-000002`);
    assert.ok(second.body.nextCursor, "quedan más");
    const third = await call(app, "GET", `/properties/${tenantA.propertyA}/documents?limit=1&cursor=${encodeURIComponent(second.body.nextCursor)}`, receptionistA);
    assert.equal(third.body.items[0].registryNumber, `DOC-L2A-${YEAR}-000001`);
    assert.equal(third.body.nextCursor, null);
    const badCursor = await call(app, "GET", `/properties/${tenantA.propertyA}/documents?cursor=zzz`, receptionistA);
    assert.equal(badCursor.status, 400);
  });

  it("filtros: kind, q (registro / searchText), status, from/to, physicalStatus; clave desconocida → 400", async () => {
    const byKind = await call(app, "GET", `/properties/${tenantA.propertyA}/documents?kind=delivery_note`, receptionistA);
    assert.deepEqual((byKind.body as unknown as Json[]).map((d) => d.id), [doc2.id]);
    const byQ = await call(app, "GET", `/properties/${tenantA.propertyA}/documents?q=000002`, receptionistA);
    assert.deepEqual((byQ.body as unknown as Json[]).map((d) => d.id), [doc2.id]);
    // ILIKE: el número de registro en minúsculas; el pipeline (T9-06a) reescribe searchText con los campos
    // extraídos y el texto de páginas, así que la nota de captura no es un ancla estable para q.
    const byLower = await call(app, "GET", `/properties/${tenantA.propertyA}/documents?q=${encodeURIComponent(`doc-l2a-${YEAR}-000001`)}`, receptionistA);
    assert.deepEqual((byLower.body as unknown as Json[]).map((d) => d.id), [doc1.id], "q insensible a mayúsculas");
    const byStatus = await call(app, "GET", `/properties/${tenantA.propertyA}/documents?status=captured,sent_to_office`, receptionistA);
    assert.equal((byStatus.body as unknown as Json[]).length, 3);
    const none = await call(app, "GET", `/properties/${tenantA.propertyA}/documents?status=archived`, receptionistA);
    assert.equal((none.body as unknown as Json[]).length, 0);
    const today = new Date().toISOString().slice(0, 10);
    const byDate = await call(app, "GET", `/properties/${tenantA.propertyA}/documents?from=${today}&to=${today}`, receptionistA);
    assert.equal((byDate.body as unknown as Json[]).length, 3);
    const past = await call(app, "GET", `/properties/${tenantA.propertyA}/documents?to=2020-01-01`, receptionistA);
    assert.equal((past.body as unknown as Json[]).length, 0);
    const physical = await call(app, "GET", `/properties/${tenantA.propertyA}/documents?physicalStatus=not_applicable`, receptionistA);
    assert.equal((physical.body as unknown as Json[]).length, 0);
    const unknown = await call(app, "GET", `/properties/${tenantA.propertyA}/documents?foo=1`, receptionistA);
    assert.equal(unknown.status, 400);
    assert.equal(codeOf(unknown), "VALIDATION_ERROR");
    const otherProperty = await call(app, "GET", `/properties/${tenantA.propertyB}/documents`, accountantA);
    assert.equal(otherProperty.status, 200);
    assert.equal((otherProperty.body as unknown as Json[]).length, 0, "la bandeja de B está vacía");
  });
});

describe("T9-05a · enviar a la oficina y cola", () => {
  it("send-to-office 200 (sentAt, sent_to_office); repetir → 409 DOCUMENT_STATUS_TRANSITION { from, action }", async () => {
    const sent = await call(app, "POST", `/properties/${tenantA.propertyA}/documents/${doc1.id}/send-to-office`, receptionistA);
    assert.equal(sent.status, 200, JSON.stringify(sent.body));
    assert.equal(sent.body.status, "sent_to_office");
    assert.ok(sent.body.sentAt, "sentAt informado");
    assert.equal(sent.body.slaBreached, false);
    const again = await call(app, "POST", `/properties/${tenantA.propertyA}/documents/${doc1.id}/send-to-office`, receptionistA);
    assert.equal(again.status, 409, JSON.stringify(again.body));
    assert.equal(codeOf(again), "DOCUMENT_STATUS_TRANSITION");
    assert.equal(again.body.details.from, "sent_to_office");
    assert.equal(again.body.details.action, "send-to-office");
    const row = await prisma.incomingDocument.findUnique({ where: { id: doc1.id }, select: { status: true, sentAt: true } });
    assert.equal(row?.status, "sent_to_office");
    assert.ok(row?.sentAt);
    await flushAuditQueues();
    assert.equal(await prisma.auditEvent.count({ where: { organizationId: tenantA.organizationId, action: "DOCUMENT_SENT", entityId: doc1.id } }), 1);
  });

  it("cola de la oficina: accountant (ámbito de sociedad) 200 con el enviado; receptionist 403; clerk de un solo centro 404 ENTITY_SCOPE_REQUIRED y 200 con propertyId", async () => {
    const queue = await call(app, "GET", `/organizations/${tenantA.organizationId}/documents/queue`, accountantA);
    assert.equal(queue.status, 200, JSON.stringify(queue.body));
    const items = queue.body as unknown as Json[];
    assert.deepEqual(items.map((d) => d.id), [doc1.id], "solo los pendientes de decisión");
    assert.equal(items[0]!.status, "sent_to_office");
    assert.equal(items[0]!.slaBreached, false);
    assert.equal(queue.headers["x-total-count"], "1");

    const all = await call(app, "GET", `/organizations/${tenantA.organizationId}/documents/queue?status=captured,sent_to_office`, accountantA);
    assert.equal((all.body as unknown as Json[]).length, 3);
    const breached = await call(app, "GET", `/organizations/${tenantA.organizationId}/documents/queue?slaBreachedOnly=1`, accountantA);
    assert.equal((breached.body as unknown as Json[]).length, 0, "nada vencido hoy");

    const denied = await call(app, "GET", `/organizations/${tenantA.organizationId}/documents/queue`, receptionistA, undefined, tenantA.propertyA);
    assert.equal(denied.status, 403, JSON.stringify(denied.body));

    const scoped = await call(app, "GET", `/organizations/${tenantA.organizationId}/documents/queue`, clerkA, undefined, tenantA.propertyA);
    assert.equal(scoped.status, 404, JSON.stringify(scoped.body));
    assert.equal(codeOf(scoped), "ENTITY_SCOPE_REQUIRED");
    const scopedOk = await call(app, "GET", `/organizations/${tenantA.organizationId}/documents/queue?propertyId=${tenantA.propertyA}`, clerkA, undefined, tenantA.propertyA);
    assert.equal(scopedOk.status, 200, JSON.stringify(scopedOk.body));
    assert.equal((scopedOk.body as unknown as Json[]).length, 1);
    const scopedOther = await call(app, "GET", `/organizations/${tenantA.organizationId}/documents/queue?propertyId=${tenantA.propertyB}`, clerkA, undefined, tenantA.propertyA);
    assert.equal(scopedOther.status, 404, JSON.stringify(scopedOther.body));

    const foreign = await call(app, "GET", `/organizations/${tenantA.organizationId}/documents/queue`, ownerB);
    assert.equal(foreign.status, 404, JSON.stringify(foreign.body));
  });
});

describe("T9-05a · recaptura", () => {
  it("409 si no está devuelto; tras devolverlo (returned_to_centre) → 200 captured con original nuevo y el anterior como derivado", async () => {
    const notReturned = await call(app, "POST", `/properties/${tenantA.propertyA}/documents/${doc2.id}/recapture`, receptionistA, { fileName: "albaran-2.pdf", mimeType: "application/pdf", base64: b64(RECAPTURE_PDF) });
    assert.equal(notReturned.status, 409, JSON.stringify(notReturned.body));
    assert.equal(codeOf(notReturned), "DOCUMENT_STATUS_TRANSITION");
    assert.equal(notReturned.body.details.action, "recapture");

    // Devolución al centro (lote T9-08): se simula sobre el tenant propio.
    await prisma.incomingDocument.update({ where: { id: doc2.id }, data: { status: "returned_to_centre", rejectReason: "illegible", rejectNote: "borroso" } });
    const recaptured = await call(app, "POST", `/properties/${tenantA.propertyA}/documents/${doc2.id}/recapture`, receptionistA, { fileName: "albaran-2.pdf", mimeType: "application/pdf", base64: b64(RECAPTURE_PDF), note: "reescaneado" });
    assert.equal(recaptured.status, 200, JSON.stringify(recaptured.body));
    assert.equal(recaptured.body.status, "captured");
    assert.equal(recaptured.body.registryNumber, doc2.registryNumber, "mismo número de registro");
    assert.equal(recaptured.body.sha256, createHash("sha256").update(RECAPTURE_PDF).digest("hex"));
    assert.notEqual(recaptured.body.sha256, doc2.sha256);
    assert.equal(recaptured.body.pageCount, 1);
    assert.equal(recaptured.body.extractionStatus, "pending");
    assert.equal(recaptured.body.rejectReason, null);

    const files = await prisma.documentFile.findMany({ where: { documentId: doc2.id }, orderBy: { createdAt: "asc" } });
    assert.equal(files.length, 2);
    assert.equal(files[0]!.role, "derived");
    assert.equal(files[1]!.role, "original");
    assert.ok(existsSync(join(STORAGE_DIR, files[1]!.storageKey!)));
    assert.equal(await prisma.documentPage.count({ where: { documentId: doc2.id } }), 1);

    const download = await call(app, "GET", `/properties/${tenantA.propertyA}/documents/${doc2.id}/file`, receptionistA);
    assert.equal(download.status, 200);
    assert.ok(download.raw.equals(RECAPTURE_PDF), "la descarga sirve el original nuevo");
    await flushAuditQueues();
    assert.equal(await prisma.auditEvent.count({ where: { organizationId: tenantA.organizationId, action: "DOCUMENT_RECAPTURED", entityId: doc2.id } }), 1);
  });

  it("recaptura con el mismo fichero que otro documento de la organización → 409 DOCUMENT_DUPLICATE_FILE", async () => {
    await prisma.incomingDocument.update({ where: { id: doc2.id }, data: { status: "returned_to_centre" } });
    const dup = await call(app, "POST", `/properties/${tenantA.propertyA}/documents/${doc2.id}/recapture`, receptionistA, { fileName: "x.pdf", mimeType: "application/pdf", base64: b64(INVOICE_1) });
    assert.equal(dup.status, 409, JSON.stringify(dup.body));
    assert.equal(codeOf(dup), "DOCUMENT_DUPLICATE_FILE");
    await prisma.incomingDocument.update({ where: { id: doc2.id }, data: { status: "captured" } });
  });

  it("cableado", () => {
    // Informativo: true cuando server.ts registra las rutas (T9-05b); false si la suite las cableó.
    assert.equal(typeof wiredByServer, "boolean");
  });
});
