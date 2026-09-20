/**
 * Tanda ACT · lote L3 · integración (Postgres): documentación del activo
 * inmobiliario con fichero en el ALMACÉN DE T9, versiones, vigencia derivada,
 * retirada con legalHold, sincronización con ComplianceItem y descarga
 * auditada sobre un tenant AISLADO (helpers/l2-tenant.mts, organización
 * `org_l2_act…`) más un usuario `asset_manager` asignado a la SOCIEDAD
 * (scopeType legal_entity) y un `admin_clerk` (documents.manage sin
 * real_estate.manage), auth real y RBAC_STRICT; Faranda y org_123 solo se leen
 * (invariantes antes y después).
 *
 * Almacén en disco en un directorio temporal (DOCUMENT_STORAGE_KIND=disk sin
 * cifrado en reposo) y tope DOCUMENT_MAX_BYTES=65536 (mínimo del contrato)
 * para provocar el 413 con un PDF de ~72 KB; las variables se fijan ANTES de
 * importar el servidor (documents.config.ts las memoriza en la primera lectura)
 * y resetDocumentsConfigForTests limpia la memo. Patrón documents-upload.test.mts.
 *
 * Las 6 rutas se cablean en real-estate.register.ts (registerRealEstateRoutes);
 * la suite lo exige con una aserción dura (ACT-REV-02: sin cableado de reserva,
 * para que un register sin documentos rompa la puerta). El catálogo de
 * cumplimiento no está sembrado en la BD del carril: la suite crea UNA
 * ComplianceRequirement propia (código con el id de la ejecución) y la borra.
 *
 * Fixtures inventadas (modules/documents/__tests__/fixtures.ts); ningún nombre de persona.
 *
 * Run: cd apps/api && node --env-file-if-exists=../../.env --import tsx --test ../../tests/integration/real-estate-documents.test.mts
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

const STORAGE_DIR = mkdtempSync(join(tmpdir(), "ehotelos-actdoc-"));
const MAX_BYTES = 65_536;
const UPLOAD_BODY_LIMIT = 4 * 1024 * 1024;
process.env.DOCUMENT_STORAGE_KIND = "disk";
process.env.DOCUMENT_STORAGE_DIR = STORAGE_DIR;
process.env.DOCUMENT_ENCRYPT_AT_REST = "false";
process.env.DOCUMENT_MAX_BYTES = String(MAX_BYTES);
process.env.DOCUMENT_UPLOAD_BODY_LIMIT = String(UPLOAD_BODY_LIMIT);

const tenantHelpers = await import("./helpers/l2-tenant.mts");
const { createIsolatedTenant, cleanupTenant, loginOrThrow, newRunId, STRICT_ENV, withEnv, farandaInvariants } = tenantHelpers;
type IsolatedTenant = Awaited<ReturnType<typeof createIsolatedTenant>>;
type Session = Awaited<ReturnType<typeof loginOrThrow>>;

const { prisma, hashPassword } = await import("@hotelos/database");
const { buildApiServer } = await import("../../apps/api/src/server.js");
const { routePermissionManifest } = await import("../../apps/api/src/security/route-permissions.js");
const { flushAuditQueues } = await import("../../apps/api/src/modules/audit/audit.service.js");
const { resetRbacScopeCacheForTests } = await import("../../apps/api/src/lib/rbac-scope.js");
const { resetDocumentsConfigForTests } = await import("../../apps/api/src/modules/documents/documents.config.js");
const fixtures = await import("../../apps/api/src/modules/documents/__tests__/fixtures.js");

type ApiApp = Awaited<ReturnType<typeof buildApiServer>>;
type Json = Record<string, any>;
type Reply = { status: number; body: Json; raw: Buffer; headers: Record<string, string | string[] | undefined> };

const strict = <T>(run: () => Promise<T>): Promise<T> => withEnv(STRICT_ENV, run);

async function call(app: ApiApp, method: "GET" | "POST" | "PATCH" | "DELETE", url: string, session: Session, payload?: unknown): Promise<Reply> {
  const res = await strict(() => app.inject({ method, url, headers: { ...session.headers }, ...(payload === undefined ? {} : { payload }) }));
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
const sha256 = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");
const pdfFile = (fileName: string, bytes: Buffer): Json => ({ fileName, mimeType: "application/pdf", base64: b64(bytes) });
const isoDay = (date: Date): string => date.toISOString().slice(0, 10);
const daysFromToday = (days: number): string => isoDay(new Date(Date.now() + days * 86_400_000));

/** Usuario extra con una plantilla asignada a la SOCIEDAD del tenant (barrido por cleanupTenant; patrón real-estate-core.test.mts). */
async function addEntityUser(tenant: IsolatedTenant, key: string, templateKey: string): Promise<{ id: string; email: string }> {
  const id = `usr_actdoc_${key}_${tenant.run}`;
  const email = `${key}.actdoc.${tenant.run}@faranda.test`;
  await prisma.user.create({
    data: { id, organizationId: tenant.organizationId, email, fullName: `ACT ${key} ${tenant.run}`, status: "active", passwordHash: hashPassword(tenant.password), mustChangePassword: false, passwordChangedAt: new Date() }
  });
  const roleId = tenant.roles[templateKey];
  if (!roleId) throw new Error(`Sin rol de plantilla «${templateKey}» en ${tenant.organizationId}.`);
  await prisma.userRoleAssignment.create({
    data: { userId: id, roleId, scopeType: "legal_entity", legalEntityId: tenant.legalEntityId, organizationId: tenant.organizationId, reason: `actdoc ${key}` }
  });
  resetRbacScopeCacheForTests();
  return { id, email };
}

const RUN_A = `actdoc${newRunId()}`;
const RUN_B = `${RUN_A}b`;
/** Obligación de cumplimiento propia de la ejecución (el catálogo del carril está vacío). */
const REQUIREMENT_CODE = `ACT-L3-${RUN_A.toUpperCase()}`;

let app: ApiApp;
let tenantA: IsolatedTenant;
let tenantB: IsolatedTenant;
let assetManagerA: Session;
let clerkA: Session;
let receptionistA: Session;
let accountantA: Session;
let ownerB: Session;
let baseline: Awaited<ReturnType<typeof farandaInvariants>>;
let wiredByServer = true;

const DEED_PDF = fixtures.multiPagePdf(2);
const DEED_PDF_V2 = fixtures.multiPagePdf(3);
const POLICY_PDF = fixtures.blankPagePdf();
const LICENCE_PDF = fixtures.compressedTextPdf(["Licencia de actividad demo"]);
/** PDF válido de ~72 KB: supera DOCUMENT_MAX_BYTES=65536 sin necesitar 26 MB. */
const OVERSIZED_PDF = Buffer.concat([fixtures.blankPagePdf(), Buffer.from(`\n%${"x".repeat(70_000)}\n`, "latin1")]);

const docs = (propertyId: string) => `/properties/${propertyId}/real-estate/documents`;

let assetId: string;
let deedV1: Json;
let deedV2: Json;
let bareDoc: Json;
let policyDoc: Json;
let licenceDoc: Json;

before(async () => {
  resetDocumentsConfigForTests();
  app = await buildApiServer();
  // ACT-REV-01/02: aserción dura, sin cableado de reserva. La suite prueba la composición real
  // de server.ts: si el agregador deja de llamar a registerRealEstateDocumentRoutes, falla aquí.
  wiredByServer = app.hasRoute({ method: "GET", url: "/properties/:propertyId/real-estate/documents" });
  assert.ok(wiredByServer, "falta registerRealEstateDocumentRoutes(app) en real-estate.register.ts");
  await app.ready();
  assert.ok(routePermissionManifest.some((entry) => entry.path === "/properties/:propertyId/real-estate/documents/:documentId/file" && entry.method === "GET"), "el partial de documentos está en el manifiesto");
  baseline = await farandaInvariants();
  tenantA = await createIsolatedTenant(RUN_A);
  tenantB = await createIsolatedTenant(RUN_B);
  await prisma.complianceRequirement.create({ data: { areaCode: "LIC", code: REQUIREMENT_CODE, title: `Licencia de prueba ${RUN_A}`, defaultApplies: true, riskLevel: "MEDIUM", requiredDocuments: ["licencia"], renewalRequired: true } });
  const manager = await addEntityUser(tenantA, "activos", "asset_manager");
  const clerk = await addEntityUser(tenantA, "clerk", "admin_clerk");
  assetManagerA = await strict(() => loginOrThrow(app, manager.email, tenantA.password));
  clerkA = await strict(() => loginOrThrow(app, clerk.email, tenantA.password));
  receptionistA = await strict(() => loginOrThrow(app, tenantA.users.receptionist.email, tenantA.password));
  accountantA = await strict(() => loginOrThrow(app, tenantA.users.accountant.email, tenantA.password));
  ownerB = await strict(() => loginOrThrow(app, tenantB.users.owner.email, tenantB.password));
  const asset = await call(app, "POST", `/properties/${tenantA.propertyA}/real-estate`, assetManagerA, { name: "Hotel de prueba ACT-L3", roomsCount: 80 });
  assert.equal(asset.status, 201, JSON.stringify(asset.body));
  assetId = asset.body.asset.id;
});

after(async () => {
  try {
    await flushAuditQueues();
    if (tenantA) await cleanupTenant(tenantA.organizationId);
    if (tenantB) await cleanupTenant(tenantB.organizationId);
    await prisma.complianceRequirement.deleteMany({ where: { code: REQUIREMENT_CODE } });
    assert.equal(await prisma.organization.count({ where: { id: { in: [tenantA?.organizationId ?? "", tenantB?.organizationId ?? ""] } } }), 0, "sin organizaciones residuales");
    if (baseline) assert.deepEqual(await farandaInvariants(), baseline, "Faranda intacta");
  } finally {
    await app?.close();
    resetDocumentsConfigForTests();
    rmSync(STORAGE_DIR, { recursive: true, force: true });
  }
});

describe("ACT-L3 · subida al almacén de T9", () => {
  it("subida 201 con sha256 y fichero en disco bajo doc/red_", async () => {
    const reply = await call(app, "POST", docs(tenantA.propertyA), assetManagerA, { category: "legal", kind: "escritura", title: "Escritura de compraventa", issuerName: "Notaría de prueba", issueDate: "2019-03-01", file: pdfFile("escritura.pdf", DEED_PDF) });
    assert.equal(reply.status, 201, JSON.stringify(reply.body));
    deedV1 = reply.body;
    assert.match(deedV1.id, /^red_[0-9a-f]{16}$/);
    assert.equal(deedV1.assetId, assetId);
    assert.equal(deedV1.propertyId, tenantA.propertyA);
    assert.equal(deedV1.organizationId, tenantA.organizationId);
    assert.equal(deedV1.version, 1);
    assert.equal(deedV1.supersedesId, null);
    assert.equal(deedV1.status, "sin_fecha", "sin validUntil");
    assert.equal(deedV1.hasFile, true);
    assert.equal(deedV1.sha256, sha256(DEED_PDF));
    assert.equal(deedV1.sizeBytes, DEED_PDF.length);
    assert.equal(deedV1.mimeType, "application/pdf");
    assert.equal(deedV1.fileName, "escritura.pdf");
    assert.equal(deedV1.uploadedBy, assetManagerA.userId);
    assert.equal(deedV1.legalHold, false);
    assert.equal("storageKey" in deedV1, false, "la clave del almacén nunca viaja");
    assert.equal("inline" in deedV1, false);

    const row = await prisma.realEstateDocument.findUnique({ where: { id: deedV1.id } });
    assert.ok(row, "fila real_estate_documents");
    assert.equal(row.storageKind, "disk");
    assert.equal(row.inline, null);
    assert.equal(row.encrypted, false);
    assert.equal(row.storageKey, `org/${tenantA.organizationId}/prop/${tenantA.propertyA}/doc/${deedV1.id}/${deedV1.sha256}.pdf`);
    assert.ok(existsSync(join(STORAGE_DIR, row.storageKey!)), `fichero en disco ${row.storageKey}`);
    assert.equal(await prisma.incomingDocument.count({ where: { organizationId: tenantA.organizationId } }), 0, "no se crea IncomingDocument ni DocumentFile");
  });

  it("sin fichero → 201 «Sin fichero» (hasFile false); el listado deriva la vigencia por categoría (30 días · 90 en seguros)", async () => {
    const bare = await call(app, "POST", docs(tenantA.propertyA), assetManagerA, { category: "planos", kind: "plano_planta", title: "Plano de planta baja (pendiente de escanear)" });
    assert.equal(bare.status, 201, JSON.stringify(bare.body));
    bareDoc = bare.body;
    assert.equal(bareDoc.hasFile, false);
    assert.equal(bareDoc.sha256, null);
    assert.equal(bareDoc.fileName, null);

    const policy = await call(app, "POST", docs(tenantA.propertyA), assetManagerA, { category: "seguros", kind: "poliza", title: "Póliza multirriesgo", validFrom: daysFromToday(-305), validUntil: daysFromToday(60), file: pdfFile("poliza.pdf", POLICY_PDF) });
    assert.equal(policy.status, 201, JSON.stringify(policy.body));
    policyDoc = policy.body;
    assert.equal(policyDoc.status, "caduca_pronto", "seguros avisa a 90 días");

    const licence = await call(app, "POST", docs(tenantA.propertyA), assetManagerA, { category: "licencias", kind: "licencia_actividad", title: "Licencia de actividad", validUntil: daysFromToday(60), file: pdfFile("licencia.pdf", LICENCE_PDF) });
    assert.equal(licence.status, 201, JSON.stringify(licence.body));
    licenceDoc = licence.body;
    assert.equal(licenceDoc.status, "vigente", "licencias avisa con los 30 días del perfil");

    const list = await call(app, "GET", docs(tenantA.propertyA), assetManagerA);
    assert.equal(list.status, 200, JSON.stringify(list.body));
    assert.equal(list.body.length, 4);
    const byId = new Map((list.body as Json[]).map((d) => [d.id, d]));
    assert.equal(byId.get(bareDoc.id)?.hasFile, false);
    assert.equal(byId.get(policyDoc.id)?.status, "caduca_pronto");
    assert.equal(byId.get(licenceDoc.id)?.status, "vigente");
    const filtered = await call(app, "GET", `${docs(tenantA.propertyA)}?category=seguros&status=caduca_pronto`, assetManagerA);
    assert.equal(filtered.status, 200);
    assert.deepEqual((filtered.body as Json[]).map((d) => d.id), [policyDoc.id]);
    const badFilter = await call(app, "GET", `${docs(tenantA.propertyA)}?status=nope`, assetManagerA);
    assert.equal(badFilter.status, 400);
    assert.equal(codeOf(badFilter), "VALIDATION_ERROR");
  });

  it("413 por tamaño", async () => {
    const reply = await call(app, "POST", docs(tenantA.propertyA), assetManagerA, { category: "legal", kind: "nota_simple", title: "Nota simple grande", file: pdfFile("grande.pdf", OVERSIZED_PDF) });
    assert.equal(reply.status, 413, JSON.stringify(reply.body));
    assert.equal(codeOf(reply), "DOCUMENT_TOO_LARGE");
    assert.equal(reply.body.details.maxBytes, MAX_BYTES);
    assert.equal(await prisma.realEstateDocument.count({ where: { organizationId: tenantA.organizationId } }), 4, "ningún rechazo deja fila");
  });

  it("400 por MIME/magic bytes", async () => {
    const html = await call(app, "POST", docs(tenantA.propertyA), assetManagerA, { category: "otros", kind: "otro", title: "x", file: { fileName: "x.html", mimeType: "text/html", base64: b64("<html><body>x</body></html>") } });
    assert.equal(html.status, 400, JSON.stringify(html.body));
    assert.equal(codeOf(html), "DOCUMENT_MIME_NOT_ALLOWED");
    const disguised = await call(app, "POST", docs(tenantA.propertyA), assetManagerA, { category: "otros", kind: "otro", title: "x", file: pdfFile("x.pdf", fixtures.htmlDisguisedAsPdf()) });
    assert.equal(disguised.status, 400, JSON.stringify(disguised.body));
    assert.equal(codeOf(disguised), "DOCUMENT_CONTENT_MISMATCH");
    const invalid = await call(app, "POST", docs(tenantA.propertyA), assetManagerA, { category: "otros", kind: "otro", title: "x", file: { fileName: "x.pdf", mimeType: "application/pdf", base64: "no-base64!" } });
    assert.equal(invalid.status, 400);
    assert.equal(codeOf(invalid), "VALIDATION_ERROR");
    const unknownKind = await call(app, "POST", docs(tenantA.propertyA), assetManagerA, { category: "otros", kind: "inventado", title: "x" });
    assert.equal(unknownKind.status, 400);
    assert.equal(codeOf(unknownKind), "VALIDATION_ERROR");
    assert.equal(await prisma.realEstateDocument.count({ where: { organizationId: tenantA.organizationId } }), 4, "ningún rechazo deja fila");
    assert.equal(existsSync(join(STORAGE_DIR, "org", tenantA.organizationId, "prop", tenantA.propertyA, "doc")), true);
  });
});

describe("ACT-L3 · versiones", () => {
  it("nueva versión marca la anterior sustituido", async () => {
    const reply = await call(app, "POST", `${docs(tenantA.propertyA)}/${deedV1.id}/versions`, assetManagerA, { issueDate: "2019-03-15", file: pdfFile("escritura-subsanada.pdf", DEED_PDF_V2) });
    assert.equal(reply.status, 201, JSON.stringify(reply.body));
    deedV2 = reply.body;
    assert.notEqual(deedV2.id, deedV1.id);
    assert.equal(deedV2.version, 2);
    assert.equal(deedV2.supersedesId, deedV1.id);
    assert.equal(deedV2.supersededById, null);
    assert.equal(deedV2.category, "legal", "hereda la categoría");
    assert.equal(deedV2.kind, "escritura");
    assert.equal(deedV2.title, "Escritura de compraventa", "hereda el título");
    assert.equal(deedV2.issuerName, "Notaría de prueba", "hereda el emisor");
    assert.equal(deedV2.issueDate, "2019-03-15", "el cuerpo manda");
    assert.equal(deedV2.sha256, sha256(DEED_PDF_V2));
    assert.equal(deedV2.fileName, "escritura-subsanada.pdf");

    const list = await call(app, "GET", docs(tenantA.propertyA), assetManagerA);
    const previous = (list.body as Json[]).find((d) => d.id === deedV1.id)!;
    assert.equal(previous.status, "sustituido");
    assert.equal(previous.supersededById, deedV2.id);
    assert.equal(previous.hasFile, true, "la versión anterior conserva su fichero");
    const onlySuperseded = await call(app, "GET", `${docs(tenantA.propertyA)}?status=sustituido`, assetManagerA);
    assert.deepEqual((onlySuperseded.body as Json[]).map((d) => d.id), [deedV1.id]);

    const again = await call(app, "POST", `${docs(tenantA.propertyA)}/${deedV1.id}/versions`, assetManagerA, { file: pdfFile("otra.pdf", DEED_PDF) });
    assert.equal(again.status, 409, JSON.stringify(again.body));
    assert.equal(codeOf(again), "DOCUMENT_SUPERSEDED");
    const withoutFile = await call(app, "POST", `${docs(tenantA.propertyA)}/${deedV2.id}/versions`, assetManagerA, { title: "sin fichero" });
    assert.equal(withoutFile.status, 400, JSON.stringify(withoutFile.body));
    assert.equal(codeOf(withoutFile), "VALIDATION_ERROR");
    assert.equal(await prisma.realEstateDocument.count({ where: { organizationId: tenantA.organizationId } }), 5);
    const rows = await prisma.realEstateDocument.findMany({ where: { id: { in: [deedV1.id, deedV2.id] } }, select: { id: true, storageKey: true } });
    for (const row of rows) assert.ok(existsSync(join(STORAGE_DIR, row.storageKey!)), `fichero de ${row.id} en disco`);
  });

  it("POST …/documents con supersedesId es el mismo camino (cuerpo completo): versión 3 y v2 sustituido", async () => {
    const reply = await call(app, "POST", docs(tenantA.propertyA), assetManagerA, { category: "legal", kind: "escritura", title: "Escritura de compraventa (copia autorizada)", supersedesId: deedV2.id, file: pdfFile("escritura-copia.pdf", fixtures.multiPagePdf(4)) });
    assert.equal(reply.status, 201, JSON.stringify(reply.body));
    assert.equal(reply.body.version, 3);
    assert.equal(reply.body.supersedesId, deedV2.id);
    const v2 = await prisma.realEstateDocument.findUnique({ where: { id: deedV2.id }, select: { supersededById: true } });
    assert.equal(v2?.supersededById, reply.body.id);
    deedV2 = { ...deedV2, supersededById: reply.body.id };
    const chainHead = reply.body;
    const foreignPrevious = await call(app, "POST", docs(tenantA.propertyB), assetManagerA, { category: "legal", kind: "escritura", title: "x", supersedesId: chainHead.id, file: pdfFile("x.pdf", DEED_PDF) });
    assert.equal(foreignPrevious.status, 404, "supersedesId de otro centro → 404 opaco (antes incluso del ASSET_NOT_FOUND del centro B)");
  });
});

describe("ACT-L3 · descarga auditada", () => {
  it("descarga binaria con cabeceras y evento de auditoría", async () => {
    const reply = await call(app, "GET", `${docs(tenantA.propertyA)}/${deedV1.id}/file`, assetManagerA);
    assert.equal(reply.status, 200, reply.raw.toString("utf8").slice(0, 200));
    assert.equal(reply.headers["content-type"], "application/pdf");
    assert.match(String(reply.headers["content-disposition"]), /^attachment; filename="escritura\.pdf"/);
    assert.equal(reply.headers["x-content-type-options"], "nosniff");
    assert.equal(reply.headers["cache-control"], "private, no-store");
    assert.equal(reply.headers["content-length"], String(DEED_PDF.length));
    assert.ok(reply.raw.equals(DEED_PDF), "bytes idénticos (la versión sustituida sigue descargable)");
    assert.equal(reply.raw.subarray(0, 5).toString("latin1"), "%PDF-");

    const inline = await call(app, "GET", `${docs(tenantA.propertyA)}/${policyDoc.id}/file?inline=1`, accountantA);
    assert.equal(inline.status, 200);
    assert.match(String(inline.headers["content-disposition"]), /^inline; filename="poliza\.pdf"/);
    assert.ok(inline.raw.equals(POLICY_PDF));

    const noFile = await call(app, "GET", `${docs(tenantA.propertyA)}/${bareDoc.id}/file`, assetManagerA);
    assert.equal(noFile.status, 404, JSON.stringify(noFile.body));
    assert.equal(codeOf(noFile), "DOCUMENT_NO_FILE");

    await flushAuditQueues();
    const events = await prisma.auditEvent.findMany({ where: { organizationId: tenantA.organizationId, action: "REAL_ESTATE_DOCUMENT_DOWNLOADED" }, select: { entityType: true, entityId: true, actorUserId: true, propertyId: true, afterJson: true, ipAddress: true } });
    const deed = events.find((e) => e.entityId === deedV1.id);
    assert.ok(deed, "evento de descarga de la escritura");
    assert.equal(deed.entityType, "real_estate_document");
    assert.equal(deed.actorUserId, assetManagerA.userId);
    assert.equal(deed.propertyId, tenantA.propertyA);
    const after = deed.afterJson as Json;
    assert.equal(after.sha256, deedV1.sha256);
    assert.equal(after.sizeBytes, DEED_PDF.length);
    assert.equal(after.storageKind, "disk");
    assert.equal("storageKey" in after, false, "nunca la clave del almacén en la auditoría");
    assert.equal("inline" in after, false);
    assert.ok(events.some((e) => e.entityId === policyDoc.id && e.actorUserId === accountantA.userId), "la descarga del accountant también se audita");
  });
});

describe("ACT-L3 · metadatos, cumplimiento y retirada", () => {
  it("documento con complianceRequirementCode sincroniza ComplianceItem.expiryDate", async () => {
    const validUntil = daysFromToday(200);
    const reply = await call(app, "PATCH", `${docs(tenantA.propertyA)}/${licenceDoc.id}`, assetManagerA, { complianceRequirementCode: REQUIREMENT_CODE, issueDate: "2026-01-15", validUntil });
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    assert.equal(reply.body.complianceRequirementCode, REQUIREMENT_CODE);
    assert.equal(reply.body.validUntil, validUntil);
    assert.equal(reply.body.status, "vigente");
    const item = await prisma.complianceItem.findUnique({ where: { propertyId_requirementCode: { propertyId: tenantA.propertyA, requirementCode: REQUIREMENT_CODE } } });
    assert.ok(item, "ComplianceItem creado por la sincronización");
    assert.equal(item.status, "COMPLIANT");
    assert.equal(item.applies, true);
    assert.equal(isoDay(item.issueDate!), "2026-01-15");
    assert.equal(isoDay(item.expiryDate!), validUntil);

    // Un control marcado NON_COMPLIANT conserva su estado pero recibe la fecha nueva.
    await prisma.complianceItem.update({ where: { id: item.id }, data: { status: "NON_COMPLIANT" } });
    const renewed = daysFromToday(400);
    const patch = await call(app, "PATCH", `${docs(tenantA.propertyA)}/${licenceDoc.id}`, assetManagerA, { validUntil: renewed });
    assert.equal(patch.status, 200, JSON.stringify(patch.body));
    const kept = await prisma.complianceItem.findUnique({ where: { id: item.id } });
    assert.equal(kept?.status, "NON_COMPLIANT");
    assert.equal(isoDay(kept!.expiryDate!), renewed);

    // Una versión nueva del documento vigente lleva la fecha del control consigo.
    const later = daysFromToday(500);
    const version = await call(app, "POST", `${docs(tenantA.propertyA)}/${licenceDoc.id}/versions`, assetManagerA, { validUntil: later, file: pdfFile("licencia-renovada.pdf", fixtures.compressedTextPdf(["Licencia renovada demo"])) });
    assert.equal(version.status, 201, JSON.stringify(version.body));
    assert.equal(version.body.complianceRequirementCode, REQUIREMENT_CODE, "hereda el enlace con la obligación");
    licenceDoc = version.body;
    const synced = await prisma.complianceItem.findUnique({ where: { id: item.id } });
    assert.equal(isoDay(synced!.expiryDate!), later);

    // Código fuera del catálogo: el documento lo guarda, no hay control que sincronizar.
    const unknown = await call(app, "PATCH", `${docs(tenantA.propertyA)}/${policyDoc.id}`, assetManagerA, { complianceRequirementCode: `NO-EXISTE-${RUN_A}` });
    assert.equal(unknown.status, 200, JSON.stringify(unknown.body));
    assert.equal(await prisma.complianceItem.count({ where: { propertyId: tenantA.propertyA, requirementCode: `NO-EXISTE-${RUN_A}` } }), 0);

    const disordered = await call(app, "PATCH", `${docs(tenantA.propertyA)}/${policyDoc.id}`, assetManagerA, { validUntil: daysFromToday(-400) });
    assert.equal(disordered.status, 400, "validUntil anterior al validFrom persistido");
    assert.equal(codeOf(disordered), "VALIDATION_ERROR");
  });

  it("legalHold bloquea el borrado 409", async () => {
    const clerkHold = await call(app, "PATCH", `${docs(tenantA.propertyA)}/${policyDoc.id}`, clerkA, { legalHold: true });
    assert.equal(clerkHold.status, 403, `admin_clerk (documents.manage sin real_estate.manage) no pone retención legal: ${JSON.stringify(clerkHold.body)}`);
    const clerkTitle = await call(app, "PATCH", `${docs(tenantA.propertyA)}/${policyDoc.id}`, clerkA, { title: "Póliza multirriesgo 2026" });
    assert.equal(clerkTitle.status, 200, JSON.stringify(clerkTitle.body));
    assert.equal(clerkTitle.body.title, "Póliza multirriesgo 2026");

    const hold = await call(app, "PATCH", `${docs(tenantA.propertyA)}/${policyDoc.id}`, assetManagerA, { legalHold: true });
    assert.equal(hold.status, 200, JSON.stringify(hold.body));
    assert.equal(hold.body.legalHold, true);
    const blocked = await call(app, "DELETE", `${docs(tenantA.propertyA)}/${policyDoc.id}`, assetManagerA);
    assert.equal(blocked.status, 409, JSON.stringify(blocked.body));
    assert.equal(codeOf(blocked), "LEGAL_HOLD");
    assert.equal(blocked.body.details.documentId, policyDoc.id);

    const release = await call(app, "PATCH", `${docs(tenantA.propertyA)}/${policyDoc.id}`, assetManagerA, { legalHold: false });
    assert.equal(release.status, 200);
    const retired = await call(app, "DELETE", `${docs(tenantA.propertyA)}/${policyDoc.id}`, assetManagerA);
    assert.equal(retired.status, 200, JSON.stringify(retired.body));
    assert.ok(retired.body.deletedAt, "borrado lógico con deletedAt");
    const row = await prisma.realEstateDocument.findUnique({ where: { id: policyDoc.id } });
    assert.ok(row?.deletedAt, "la fila sigue en la tabla");
    assert.ok(existsSync(join(STORAGE_DIR, row!.storageKey!)), "el fichero nunca se borra del almacén");
    const list = await call(app, "GET", docs(tenantA.propertyA), assetManagerA);
    assert.equal((list.body as Json[]).some((d) => d.id === policyDoc.id), false, "un documento retirado no se lista");
    const gone = await call(app, "GET", `${docs(tenantA.propertyA)}/${policyDoc.id}/file`, assetManagerA);
    assert.equal(gone.status, 404, "ni se descarga");
    const twice = await call(app, "DELETE", `${docs(tenantA.propertyA)}/${policyDoc.id}`, assetManagerA);
    assert.equal(twice.status, 404, "retirar dos veces → 404 opaco");
  });
});

describe("ACT-L3 · RBAC y tenencia entre centros", () => {
  it("receptionist 403; accountant lee y descarga pero no sube (403)", async () => {
    const read = await call(app, "GET", docs(tenantA.propertyA), receptionistA);
    assert.equal(read.status, 403, JSON.stringify(read.body));
    const upload = await call(app, "POST", docs(tenantA.propertyA), receptionistA, { category: "otros", kind: "otro", title: "x" });
    assert.equal(upload.status, 403, JSON.stringify(upload.body));
    const download = await call(app, "GET", `${docs(tenantA.propertyA)}/${deedV1.id}/file`, receptionistA);
    assert.equal(download.status, 403);

    const list = await call(app, "GET", docs(tenantA.propertyA), accountantA);
    assert.equal(list.status, 200, JSON.stringify(list.body));
    assert.ok((list.body as Json[]).some((d) => d.id === deedV1.id));
    const file = await call(app, "GET", `${docs(tenantA.propertyA)}/${deedV1.id}/file`, accountantA);
    assert.equal(file.status, 200);
    assert.ok(file.raw.equals(DEED_PDF));
    for (const attempt of [
      call(app, "POST", docs(tenantA.propertyA), accountantA, { category: "otros", kind: "otro", title: "x" }),
      call(app, "POST", `${docs(tenantA.propertyA)}/${deedV1.id}/versions`, accountantA, { file: pdfFile("x.pdf", DEED_PDF) }),
      call(app, "PATCH", `${docs(tenantA.propertyA)}/${deedV1.id}`, accountantA, { title: "x" }),
      call(app, "DELETE", `${docs(tenantA.propertyA)}/${deedV1.id}`, accountantA)
    ]) {
      const reply = await attempt;
      assert.equal(reply.status, 403, JSON.stringify(reply.body));
    }
    // admin_clerk: documents.manage sí, real_estate.manage no → sube pero no retira.
    const clerkDelete = await call(app, "DELETE", `${docs(tenantA.propertyA)}/${deedV1.id}`, clerkA);
    assert.equal(clerkDelete.status, 403, JSON.stringify(clerkDelete.body));
    assert.equal(await prisma.realEstateDocument.count({ where: { organizationId: tenantA.organizationId, deletedAt: null } }), 6, "nada escrito ni retirado");
  });

  it("centro ajeno 404 opaco; ids del centro A bajo el centro B → 404", async () => {
    const foreign = await call(app, "GET", docs(tenantA.propertyA), ownerB);
    assert.equal(foreign.status, 404, JSON.stringify(foreign.body));
    const foreignUpload = await call(app, "POST", docs(tenantA.propertyA), ownerB, { category: "otros", kind: "otro", title: "x" });
    assert.equal(foreignUpload.status, 404);
    const noAsset = await call(app, "GET", docs(tenantA.propertyB), assetManagerA);
    assert.equal(noAsset.status, 404, "el centro B no tiene ficha");
    assert.equal(codeOf(noAsset), "ASSET_NOT_FOUND");
    const crossFile = await call(app, "GET", `${docs(tenantA.propertyB)}/${deedV1.id}/file`, assetManagerA);
    assert.equal(crossFile.status, 404, JSON.stringify(crossFile.body));
    const crossPatch = await call(app, "PATCH", `${docs(tenantA.propertyB)}/${deedV1.id}`, assetManagerA, { title: "x" });
    assert.equal(crossPatch.status, 404);
    const crossVersion = await call(app, "POST", `${docs(tenantA.propertyB)}/${deedV1.id}/versions`, assetManagerA, { file: pdfFile("x.pdf", DEED_PDF) });
    assert.equal(crossVersion.status, 404);
    const unknown = await call(app, "GET", `${docs(tenantA.propertyA)}/red_0000000000000000/file`, assetManagerA);
    assert.equal(unknown.status, 404);
  });

  it("auditoría: cada escritura deja su evento real_estate_document con el actor", async () => {
    await flushAuditQueues();
    const events = await prisma.auditEvent.findMany({ where: { organizationId: tenantA.organizationId, entityType: "real_estate_document" }, select: { action: true, entityId: true, actorUserId: true } });
    const actions = new Set(events.map((e) => e.action));
    for (const expected of ["REAL_ESTATE_DOCUMENT_CREATED", "REAL_ESTATE_DOCUMENT_VERSION_CREATED", "REAL_ESTATE_DOCUMENT_SUPERSEDED", "REAL_ESTATE_DOCUMENT_UPDATED", "REAL_ESTATE_DOCUMENT_RETIRED", "REAL_ESTATE_DOCUMENT_DOWNLOADED"]) {
      assert.ok(actions.has(expected), `falta ${expected} en ${[...actions].join(", ")}`);
    }
    assert.ok(events.some((e) => e.action === "REAL_ESTATE_DOCUMENT_SUPERSEDED" && e.entityId === deedV1.id));
    assert.ok(events.some((e) => e.action === "REAL_ESTATE_DOCUMENT_UPDATED" && e.actorUserId === clerkA.userId), "el cambio de título del admin_clerk queda auditado");
    assert.ok(events.filter((e) => e.action !== "REAL_ESTATE_DOCUMENT_DOWNLOADED").every((e) => e.actorUserId === assetManagerA.userId || e.actorUserId === clerkA.userId));
  });
});

describe("ACT-REV · visibilidad por documento (diseño §5.1: wip y solo_propiedad; ACT-REV-11 / ACT-REV-03)", () => {
  let ownerA: Session;
  let wipDoc: Json;
  let restrictedDoc: Json;
  const listIds = async (session: Session): Promise<string[]> => {
    const reply = await call(app, "GET", docs(tenantA.propertyA), session);
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    return (reply.body as Json[]).map((doc) => doc.id as string);
  };

  it("wip: solo lo ve (lista y descarga) quien lo subió o real_estate.manage; «Publicar» = PATCH cdeState publicado", async () => {
    ownerA = await strict(() => loginOrThrow(app, tenantA.users.owner.email, tenantA.password));
    const upload = await call(app, "POST", docs(tenantA.propertyA), clerkA, { category: "otros", kind: "otro", title: "Borrador interno de la administración", cdeState: "wip", file: pdfFile("borrador.pdf", POLICY_PDF) });
    assert.equal(upload.status, 201, JSON.stringify(upload.body));
    wipDoc = upload.body;
    assert.equal(wipDoc.cdeState, "wip");
    assert.equal(wipDoc.uploadedBy, clerkA.userId, "el actor de la subida queda registrado");
    assert.ok((await listIds(clerkA)).includes(wipDoc.id), "quien lo subió lo ve");
    assert.ok((await listIds(assetManagerA)).includes(wipDoc.id), "real_estate.manage lo ve");
    assert.ok(!(await listIds(accountantA)).includes(wipDoc.id), "otro lector no lo lista");
    assert.ok(!(await listIds(ownerA)).includes(wipDoc.id), "el owner tampoco (trabajo en curso de otro)");
    const hidden = await call(app, "GET", `${docs(tenantA.propertyA)}/${wipDoc.id}/file`, accountantA);
    assert.equal(hidden.status, 404, JSON.stringify(hidden.body));
    assert.notEqual(codeOf(hidden), "DOCUMENT_NO_FILE", "404 opaco, no «sin fichero»");
    const own = await call(app, "GET", `${docs(tenantA.propertyA)}/${wipDoc.id}/file`, clerkA);
    assert.equal(own.status, 200);
    const published = await call(app, "PATCH", `${docs(tenantA.propertyA)}/${wipDoc.id}`, clerkA, { cdeState: "publicado" });
    assert.equal(published.status, 200, JSON.stringify(published.body));
    assert.equal(published.body.cdeState, "publicado");
    assert.ok((await listIds(accountantA)).includes(wipDoc.id), "publicado: lo ven todos los lectores");
    assert.equal((await call(app, "GET", `${docs(tenantA.propertyA)}/${wipDoc.id}/file`, accountantA)).status, 200);
  });

  it("solo_propiedad: real_estate.manage o plantilla owner; el resto ni lo lista ni lo descarga ni lo versiona (404 opaco)", async () => {
    const upload = await call(app, "POST", docs(tenantA.propertyA), clerkA, { category: "contratos", kind: "contrato_arrendamiento", title: "Contrato de arrendamiento (renta y fianza)", confidentiality: "solo_propiedad", file: pdfFile("contrato.pdf", POLICY_PDF) });
    assert.equal(upload.status, 201, JSON.stringify(upload.body));
    restrictedDoc = upload.body;
    assert.equal(restrictedDoc.confidentiality, "solo_propiedad");
    assert.ok((await listIds(assetManagerA)).includes(restrictedDoc.id), "asset_manager (real_estate.manage)");
    assert.ok((await listIds(ownerA)).includes(restrictedDoc.id), "plantilla owner");
    assert.ok(!(await listIds(accountantA)).includes(restrictedDoc.id), "accountant (solo real_estate.read) no lo lista");
    assert.ok(!(await listIds(clerkA)).includes(restrictedDoc.id), "ni quien lo subió sin ser de la propiedad");
    for (const attempt of [
      call(app, "GET", `${docs(tenantA.propertyA)}/${restrictedDoc.id}/file`, accountantA),
      call(app, "GET", `${docs(tenantA.propertyA)}/${restrictedDoc.id}/file`, clerkA),
      call(app, "PATCH", `${docs(tenantA.propertyA)}/${restrictedDoc.id}`, clerkA, { title: "x" }),
      call(app, "POST", `${docs(tenantA.propertyA)}/${restrictedDoc.id}/versions`, clerkA, { file: pdfFile("v2.pdf", DEED_PDF) })
    ]) {
      const reply = await attempt;
      assert.equal(reply.status, 404, JSON.stringify(reply.body));
    }
    assert.equal((await call(app, "GET", `${docs(tenantA.propertyA)}/${restrictedDoc.id}/file`, ownerA)).status, 200);
    assert.equal((await call(app, "GET", `${docs(tenantA.propertyA)}/${restrictedDoc.id}/file`, assetManagerA)).status, 200);
    assert.equal((await prisma.realEstateDocument.findUnique({ where: { id: restrictedDoc.id }, select: { title: true, supersededById: true } }))?.title, "Contrato de arrendamiento (renta y fianza)", "nada escrito por quien no lo ve");
  });
});
