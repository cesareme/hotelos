/**
 * Tanda T9 · lote T9-13 · integración (Postgres): archivo y búsqueda, retención
 * → bloqueo → purga con legalHold, KPIs, ajustes por organización y gancho GDPR
 * sobre un tenant AISLADO (helpers/l2-tenant.mts, organización `org_l2_t9rt…`)
 * con auth real y RBAC_STRICT; Faranda y org_123 solo se leen (invariantes
 * antes y después).
 *
 *   · archivar un contrato con retentionUntil en el pasado → vuelta del job
 *     (runDocumentsRetentionTick: advisory lock + runRetentionSweep) → blockedAt
 *     y auditoría DOCUMENT_BLOCKED (actorType system); el archivo no lo lista
 *     salvo documents.admin con includeBlocked + reason (DOCUMENT_BLOCKED_READ);
 *     unblock; block manual con legalHold → purge 409 DOCUMENT_LEGAL_HOLD;
 *     quitar legalHold y blockedAt −13 meses (UPDATE solo sobre el tenant de
 *     prueba) → purge → fichero ausente en el almacén, searchText null, campos
 *     pseudonimizados y deletedAt; un segundo contrato bloqueado hace 13 meses
 *     lo purga la vuelta del job;
 *   · archivo: la búsqueda por texto extraído encuentra la factura rechazada y
 *     no encuentra la purgada; filtros (kind, registryNumber, importe, centro),
 *     ámbito R11 (404 ENTITY_SCOPE_REQUIRED sin cubrir todos los centros),
 *     403 sin documents.archive.read, 404 opaco desde otra organización;
 *   · KPIs 200 con degraded [] y pendientes por centro;
 *   · settings PATCH officeSlaBusinessDays 30 / 3 → la cola muestra slaBreached
 *     distinto; auditoría DOCUMENT_SETTINGS_UPDATED;
 *   · executeErasure sobre un huésped del tenant → factura pseudonimizada
 *     (fichero conservado) y carta purgada.
 *
 * Almacén en disco temporal (DOCUMENT_STORAGE_KIND=disk sin cifrado); las
 * variables se fijan ANTES de importar el servidor. Fixtures inventadas
 * (modules/documents/__tests__/fixtures.ts); ningún nombre real.
 *
 * Run: cd apps/api && node --env-file-if-exists=../../.env --import tsx --test ../../tests/integration/documents-retention.test.mts
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

const STORAGE_DIR = mkdtempSync(join(tmpdir(), "ehotelos-t9rt-"));
process.env.DOCUMENT_STORAGE_KIND = "disk";
process.env.DOCUMENT_STORAGE_DIR = STORAGE_DIR;
process.env.DOCUMENT_ENCRYPT_AT_REST = "false";
process.env.DOCUMENT_MAX_BYTES = String(4 * 1024 * 1024);
process.env.DOCUMENT_UPLOAD_BODY_LIMIT = String(8 * 1024 * 1024);

const tenantHelpers = await import("./helpers/l2-tenant.mts");
const { createIsolatedTenant, cleanupTenant, loginOrThrow, newRunId, STRICT_ENV, withEnv, farandaInvariants } = tenantHelpers;
type IsolatedTenant = Awaited<ReturnType<typeof createIsolatedTenant>>;
type Session = Awaited<ReturnType<typeof loginOrThrow>>;

const { prisma, hashPassword } = await import("@hotelos/database");
const { buildApiServer } = await import("../../apps/api/src/server.js");
const { flushAuditQueues } = await import("../../apps/api/src/modules/audit/audit.service.js");
const { resetRbacScopeCacheForTests } = await import("../../apps/api/src/lib/rbac-scope.js");
const { resetDocumentsConfigForTests, getDocumentStorage } = await import("../../apps/api/src/modules/documents/documents.config.js");
const { runDocumentsRetentionTick } = await import("../../apps/api/src/modules/documents/documents-retention.job.js");
const { ERASED_PLACEHOLDER, PURGED_PLACEHOLDER, addMonthsUtc } = await import("../../apps/api/src/modules/documents/retention.service.js");
const { executeErasure } = await import("../../apps/api/src/modules/gdpr/gdpr.service.js");
const fixtures = await import("../../apps/api/src/modules/documents/__tests__/fixtures.js");

type ApiApp = Awaited<ReturnType<typeof buildApiServer>>;
type Json = Record<string, any>;
type Reply = { status: number; body: Json; headers: Record<string, string | string[] | undefined> };

const strict = <T>(run: () => Promise<T>): Promise<T> => withEnv(STRICT_ENV, run);

async function call(app: ApiApp, method: "GET" | "POST" | "PATCH", url: string, session: Session, payload?: unknown, propertyId?: string): Promise<Reply> {
  const res = await strict(() => app.inject({ method, url, headers: { ...session.headers, ...(propertyId ? { "x-property-id": propertyId } : {}) }, ...(payload === undefined ? {} : { payload }) }));
  let body: Json = {};
  try {
    body = res.body ? (JSON.parse(res.body) as Json) : {};
  } catch {
    body = { raw: res.body };
  }
  return { status: res.statusCode, body, headers: res.headers as Record<string, string | string[] | undefined> };
}

const codeOf = (reply: Reply): string | undefined => (reply.body.details as { code?: string } | undefined)?.code;
const b64 = (bytes: Buffer): string => bytes.toString("base64");
const pdfUpload = (fileName: string, bytes: Buffer, extra: Json = {}): Json => ({ files: [{ fileName, mimeType: "application/pdf", base64: b64(bytes) }], ...extra });
const isoDay = (date: Date): string => date.toISOString().slice(0, 10);
const items = (reply: Reply): Json[] => (Array.isArray(reply.body) ? (reply.body as unknown as Json[]) : ((reply.body.items ?? []) as Json[]));

/** Usuario extra con una o varias plantillas en el centro (barrido por cleanupTenant). */
async function addUser(tenant: IsolatedTenant, key: string, templateKeys: string[], propertyIds: string[]): Promise<{ id: string; email: string }> {
  const id = `usr_t9rt_${key}_${tenant.run}`;
  const email = `${key}.t9rt.${tenant.run}@faranda.test`;
  await prisma.user.create({
    data: { id, organizationId: tenant.organizationId, email, fullName: `T9 ${key} ${tenant.run}`, status: "active", passwordHash: hashPassword(tenant.password), mustChangePassword: false, passwordChangedAt: new Date() }
  });
  for (const templateKey of templateKeys) {
    const roleId = tenant.roles[templateKey];
    if (!roleId) throw new Error(`Sin rol de plantilla «${templateKey}» en ${tenant.organizationId}.`);
    for (const propertyId of propertyIds) {
      await prisma.userRoleAssignment.create({ data: { userId: id, roleId, scopeType: "property", propertyId, organizationId: tenant.organizationId, reason: `t9rt ${key} ${templateKey}` } });
    }
  }
  resetRbacScopeCacheForTests();
  return { id, email };
}

/** Espera a que el pipeline en segundo plano (onCaptured) termine (extractionStatus ≠ pending). */
async function waitForBackground(documentId: string): Promise<void> {
  for (let i = 0; i < 100; i += 1) {
    const row = await prisma.incomingDocument.findUnique({ where: { id: documentId }, select: { extractionStatus: true } });
    if (row && row.extractionStatus !== "pending") return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`El pipeline en segundo plano no terminó para ${documentId}.`);
}

async function capture(app: ApiApp, session: Session, propertyId: string, fileName: string, bytes: Buffer, extra: Json = {}): Promise<Json> {
  const reply = await call(app, "POST", `/properties/${propertyId}/documents`, session, pdfUpload(fileName, bytes, extra));
  assert.equal(reply.status, 201, JSON.stringify(reply.body));
  const record = (reply.body as unknown as Json[])[0]!;
  await waitForBackground(record.id);
  return record;
}

/** Hojas de tipo cadena de un JSON (valores, no claves). */
function stringLeaves(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(stringLeaves);
  if (value && typeof value === "object") return Object.values(value as Record<string, unknown>).flatMap(stringLeaves);
  return [];
}

async function originalKeyOf(documentId: string): Promise<string> {
  const file = await prisma.documentFile.findFirstOrThrow({ where: { documentId, role: "original" }, select: { storageKey: true } });
  assert.ok(file.storageKey, "el original debe tener clave en el almacén (disk)");
  return file.storageKey;
}

async function auditOf(documentId: string, action: string): Promise<{ actorType: string; actorUserId: string | null; afterJson: unknown } | null> {
  await flushAuditQueues();
  const row = await prisma.auditEvent.findFirst({ where: { entityType: "incoming_document", entityId: documentId, action }, orderBy: { createdAt: "desc" }, select: { actorType: true, actorUserId: true, afterJson: true } });
  return row;
}

/** Documentos de OTRAS organizaciones que una vuelta del job tocaría (debe ser 0: nunca borrados masivos fuera del tenant de prueba). */
async function foreignSweepCandidates(now: Date): Promise<number> {
  const foreign = { organizationId: { not: { startsWith: "org_l2_" } }, deletedAt: null };
  const [due, purgeable, stuck] = await Promise.all([
    prisma.incomingDocument.count({ where: { ...foreign, blockedAt: null, legalHold: false, retentionUntil: { lte: now } } }),
    prisma.incomingDocument.count({ where: { ...foreign, legalHold: false, blockedAt: { lte: addMonthsUtc(now, -12) } } }),
    prisma.incomingDocument.count({ where: { ...foreign, extractionStatus: "pending", capturedAt: { lte: new Date(now.getTime() - 10 * 60_000) } } })
  ]);
  return due + purgeable + stuck;
}

const RUN_A = `t9rt${newRunId()}`;
const RUN_B = `${RUN_A}b`;
const org = (id: string): string => `/organizations/${id}/documents`;

let app: ApiApp;
let tenantA: IsolatedTenant;
let tenantB: IsolatedTenant;
let receptionist: Session;
let clerk: Session;
let director: Session;
let accountant: Session;
let owner: Session;
let ownerB: Session;
let baseline: Awaited<ReturnType<typeof farandaInvariants>>;

const CONTRACT_1 = fixtures.demoInvoicePdf({ number: "T9-RT-CONTRATO-1" });
const CONTRACT_2 = fixtures.demoInvoicePdf({ number: "T9-RT-CONTRATO-2" });
const INVOICE = fixtures.demoInvoicePdf({ number: "T9-RT-0001" });
const SLA_INVOICE = fixtures.demoInvoicePdf({ number: "T9-RT-SLA" });
const GDPR_INVOICE = fixtures.demoInvoicePdf({ number: "T9-RT-GDPR" });
const LETTER = fixtures.demoInvoicePdf({ number: "T9-RT-CARTA" });

let contract1: Json;
let contract1Key = "";
let contract2: Json;
let contract2Key = "";
let invoice: Json;
let slaDoc: Json;

before(async () => {
  resetDocumentsConfigForTests();
  app = await buildApiServer();
  await app.ready();
  baseline = await farandaInvariants();
  tenantA = await createIsolatedTenant(RUN_A);
  tenantB = await createIsolatedTenant(RUN_B);
  // admin_clerk: documents.capture + review + archive.read, solo en el hotel A (ámbito de centro, no de sociedad).
  const clerkUser = await addUser(tenantA, "clerk", ["admin_clerk"], [tenantA.propertyA]);
  receptionist = await strict(() => loginOrThrow(app, tenantA.users.receptionist.email, tenantA.password));
  clerk = await strict(() => loginOrThrow(app, clerkUser.email, tenantA.password));
  // general_manager (A y B): documents.admin. accountant (organización): documents.review + archive.read. owner: todo.
  director = await strict(() => loginOrThrow(app, tenantA.users.generalManager.email, tenantA.password));
  accountant = await strict(() => loginOrThrow(app, tenantA.users.accountant.email, tenantA.password));
  owner = await strict(() => loginOrThrow(app, tenantA.users.owner.email, tenantA.password));
  ownerB = await strict(() => loginOrThrow(app, tenantB.users.owner.email, tenantB.password));
});

after(async () => {
  try {
    await flushAuditQueues();
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

describe("T9-13 · retención: archivar con retentionUntil vencido → job → blockedAt → unblock → legalHold → purge", () => {
  it("archive de un contrato con retentionUntil en el pasado → archived con esa fecha", async () => {
    contract1 = await capture(app, receptionist, tenantA.propertyA, "contrato-1.pdf", CONTRACT_1, { kindHint: "contract" });
    contract1Key = await originalKeyOf(contract1.id);
    const archived = await call(app, "POST", `/properties/${tenantA.propertyA}/documents/${contract1.id}/archive`, clerk, { retentionUntil: "2020-12-31" });
    assert.equal(archived.status, 200, JSON.stringify(archived.body));
    assert.equal(archived.body.document.status, "archived");
    assert.equal(archived.body.document.retentionUntil, "2020-12-31");
    assert.equal(archived.body.document.blockedAt, null);
    contract2 = await capture(app, receptionist, tenantA.propertyA, "contrato-2.pdf", CONTRACT_2, { kindHint: "contract" });
    contract2Key = await originalKeyOf(contract2.id);
    const archived2 = await call(app, "POST", `/properties/${tenantA.propertyA}/documents/${contract2.id}/archive`, clerk, {});
    assert.equal(archived2.status, 200, JSON.stringify(archived2.body));
    assert.equal(archived2.body.document.retentionUntil, `${new Date(contract2.capturedAt).getUTCFullYear() + 6}-12-31`);
  });

  it("una vuelta del job (advisory lock + barrido) bloquea el vencido: blockedAt, auditoría DOCUMENT_BLOCKED actorType system, failed []", async () => {
    const now = new Date();
    assert.equal(await foreignSweepCandidates(now), 0, "la BD del carril no tiene candidatos fuera de los tenants de prueba");
    const tick = await runDocumentsRetentionTick({ now });
    assert.equal(tick.skipped, false, "el lock documents.retention estaba libre");
    assert.ok(tick.result);
    assert.deepEqual(tick.result!.failed, []);
    assert.ok(tick.result!.blocked >= 1, `blocked = ${tick.result!.blocked}`);
    const row = await prisma.incomingDocument.findUniqueOrThrow({ where: { id: contract1.id } });
    assert.ok(row.blockedAt, "blockedAt fijado");
    assert.equal(row.deletedAt, null);
    const other = await prisma.incomingDocument.findUniqueOrThrow({ where: { id: contract2.id } });
    assert.equal(other.blockedAt, null, "retención vigente: sin bloquear");
    const audit = await auditOf(contract1.id, "DOCUMENT_BLOCKED");
    assert.ok(audit, "auditoría DOCUMENT_BLOCKED");
    assert.equal(audit!.actorType, "system");
    assert.equal((audit!.afterJson as Json).reason, "retention_expired");
  });

  it("el archivo oculta el bloqueado; documents.admin lo ve con includeBlocked + reason (DOCUMENT_BLOCKED_READ); sin reason 400; sin documents.admin 403", async () => {
    const hidden = await call(app, "GET", `${org(tenantA.organizationId)}/archive`, accountant);
    assert.equal(hidden.status, 200, JSON.stringify(hidden.body));
    assert.ok(!items(hidden).some((item) => item.id === contract1.id), "bloqueado oculto");
    assert.ok(items(hidden).some((item) => item.id === contract2.id), "archivado vigente visible");
    const denied = await call(app, "GET", `${org(tenantA.organizationId)}/archive?includeBlocked=1&reason=Requerimiento`, accountant);
    assert.equal(denied.status, 403, JSON.stringify(denied.body));
    const noReason = await call(app, "GET", `${org(tenantA.organizationId)}/archive?includeBlocked=1`, owner);
    assert.equal(noReason.status, 400, JSON.stringify(noReason.body));
    const seen = await call(app, "GET", `${org(tenantA.organizationId)}/archive?includeBlocked=1&reason=Requerimiento%20AEAT`, owner);
    assert.equal(seen.status, 200, JSON.stringify(seen.body));
    const blocked = items(seen).find((item) => item.id === contract1.id);
    assert.ok(blocked, "documents.admin ve el bloqueado");
    assert.ok(blocked!.blockedAt);
    assert.equal(blocked!.sha256, contract1.sha256);
    assert.equal(blocked!.originalFormat, "application/pdf");
    assert.equal(blocked!.retentionUntil, "2020-12-31");
    const audit = await auditOf(contract1.id, "DOCUMENT_BLOCKED_READ");
    assert.ok(audit, "lectura de un bloqueado auditada");
    assert.equal(audit!.actorType, "user");
    assert.equal((audit!.afterJson as Json).reason, "Requerimiento AEAT");
    // RV-12 (§7.5 «invisible salvo documents.admin»): la descarga del bloqueado también es el 404 opaco, no un 409 que revele su estado.
    const download = await call(app, "GET", `/properties/${tenantA.propertyA}/documents/${contract1.id}/file`, accountant, undefined, tenantA.propertyA);
    assert.equal(download.status, 404, JSON.stringify(download.body));
    assert.equal(codeOf(download), "DOCUMENT_NOT_FOUND");
    const detailHidden = await call(app, "GET", `/properties/${tenantA.propertyA}/documents/${contract1.id}`, accountant, undefined, tenantA.propertyA);
    assert.equal(detailHidden.status, 404);
    const adminDownload = await call(app, "GET", `/properties/${tenantA.propertyA}/documents/${contract1.id}/file`, director, undefined, tenantA.propertyA);
    assert.equal(adminDownload.status, 200, JSON.stringify(adminDownload.body));
  });

  it("unblock (documents.admin) → blockedAt null y DOCUMENT_UNBLOCKED; 403 sin la clave; 404 opaco desde otra organización", async () => {
    const denied = await call(app, "POST", `${org(tenantA.organizationId)}/${contract1.id}/unblock`, accountant, { reason: "Revisión" });
    assert.equal(denied.status, 403, JSON.stringify(denied.body));
    const foreign = await call(app, "POST", `${org(tenantA.organizationId)}/${contract1.id}/unblock`, ownerB, { reason: "Revisión" });
    assert.equal(foreign.status, 404, JSON.stringify(foreign.body));
    const unblocked = await call(app, "POST", `${org(tenantA.organizationId)}/${contract1.id}/unblock`, director, { reason: "Revisión del expediente" }, tenantA.propertyA);
    assert.equal(unblocked.status, 200, JSON.stringify(unblocked.body));
    assert.equal(unblocked.body.blockedAt, null);
    assert.equal(unblocked.body.deletedAt, null);
    const audit = await auditOf(contract1.id, "DOCUMENT_UNBLOCKED");
    assert.ok(audit);
    assert.equal(audit!.actorType, "user");
    assert.equal(audit!.actorUserId, tenantA.users.generalManager.id);
    const again = await call(app, "POST", `${org(tenantA.organizationId)}/${contract1.id}/unblock`, director, { reason: "otra vez" }, tenantA.propertyA);
    assert.equal(again.status, 409);
    assert.equal(codeOf(again), "DOCUMENT_STATUS_TRANSITION");
  });

  it("block manual con legalHold → purge 409 DOCUMENT_LEGAL_HOLD (fichero intacto); sin bloquear → 409 DOCUMENT_STATUS_TRANSITION", async () => {
    const notBlocked = await call(app, "POST", `${org(tenantA.organizationId)}/${contract1.id}/purge`, director, { reason: "Cierre" }, tenantA.propertyA);
    assert.equal(notBlocked.status, 409, JSON.stringify(notBlocked.body));
    assert.equal(codeOf(notBlocked), "DOCUMENT_STATUS_TRANSITION");
    const blocked = await call(app, "POST", `${org(tenantA.organizationId)}/${contract1.id}/block`, director, { reason: "Requerimiento judicial", legalHold: true }, tenantA.propertyA);
    assert.equal(blocked.status, 200, JSON.stringify(blocked.body));
    assert.ok(blocked.body.blockedAt);
    assert.equal(blocked.body.legalHold, true);
    const badBody = await call(app, "POST", `${org(tenantA.organizationId)}/${contract1.id}/purge`, director, {}, tenantA.propertyA);
    assert.equal(badBody.status, 400, JSON.stringify(badBody.body));
    const held = await call(app, "POST", `${org(tenantA.organizationId)}/${contract1.id}/purge`, director, { reason: "Cierre" }, tenantA.propertyA);
    assert.equal(held.status, 409, JSON.stringify(held.body));
    assert.equal(codeOf(held), "DOCUMENT_LEGAL_HOLD");
    assert.ok(await getDocumentStorage().head(contract1Key), "el fichero sigue en el almacén");
    // Con legalHold, la vuelta del job tampoco lo toca aunque lleve más de 12 meses bloqueado.
    await prisma.incomingDocument.update({ where: { id: contract1.id }, data: { blockedAt: addMonthsUtc(new Date(), -13) } });
    const tick = await runDocumentsRetentionTick({ now: new Date() });
    assert.equal(tick.skipped, false);
    assert.equal((await prisma.incomingDocument.findUniqueOrThrow({ where: { id: contract1.id } })).deletedAt, null, "legalHold impide la purga del job");
  });

  it("sin legalHold y bloqueado hace 13 meses → purge: fichero ausente, searchText null, campos pseudonimizados, deletedAt, DOCUMENT_PURGED; detalle 404 y fuera del archivo", async () => {
    await prisma.incomingDocument.update({ where: { id: contract1.id }, data: { legalHold: false, blockedAt: addMonthsUtc(new Date(), -13) } });
    const extractionsBefore = await prisma.documentExtraction.count({ where: { documentId: contract1.id } });
    const purged = await call(app, "POST", `${org(tenantA.organizationId)}/${contract1.id}/purge`, director, { reason: "Retención cumplida" }, tenantA.propertyA);
    assert.equal(purged.status, 200, JSON.stringify(purged.body));
    assert.ok(purged.body.deletedAt);
    assert.equal(await getDocumentStorage().head(contract1Key), null, "el fichero ya no está en el almacén");
    const row = await prisma.incomingDocument.findUniqueOrThrow({ where: { id: contract1.id } });
    assert.ok(row.deletedAt);
    assert.equal(row.searchText, null);
    assert.equal(row.registryNumber, contract1.registryNumber, "el registro y el hash sobreviven");
    assert.equal(row.sha256, contract1.sha256);
    const files = await prisma.documentFile.findMany({ where: { documentId: contract1.id } });
    assert.ok(files.length >= 1 && files.every((file) => file.inline === null));
    const extractions = await prisma.documentExtraction.findMany({ where: { documentId: contract1.id } });
    assert.equal(extractions.length, extractionsBefore);
    for (const extraction of extractions) {
      const leaked = stringLeaves(extraction.fieldsJson).filter((value) => value.length > 0 && value !== PURGED_PLACEHOLDER);
      assert.deepEqual(leaked, [], `cadenas sin pseudonimizar: ${leaked.join(" | ")}`);
      assert.deepEqual(extraction.confidenceJson, {});
    }
    const audit = await auditOf(contract1.id, "DOCUMENT_PURGED");
    assert.ok(audit);
    assert.equal(audit!.actorType, "user");
    assert.equal((audit!.afterJson as Json).reason, "Retención cumplida");
    assert.ok(((audit!.afterJson as Json).filesDeleted as number) >= 1);
    const detail = await call(app, "GET", `/properties/${tenantA.propertyA}/documents/${contract1.id}`, clerk);
    assert.equal(detail.status, 404, JSON.stringify(detail.body));
    const archive = await call(app, "GET", `${org(tenantA.organizationId)}/archive?includeBlocked=1&reason=Comprobaci%C3%B3n`, owner);
    assert.equal(archive.status, 200);
    assert.ok(!items(archive).some((item) => item.id === contract1.id), "purgado fuera del archivo");
    const again = await call(app, "POST", `${org(tenantA.organizationId)}/${contract1.id}/purge`, director, { reason: "de nuevo" }, tenantA.propertyA);
    assert.equal(again.status, 404);
  });

  it("la vuelta del job purga un bloqueado hace 13 meses sin legalHold (contrato 2) y no vuelve a tocar el ya purgado", async () => {
    await prisma.incomingDocument.update({ where: { id: contract2.id }, data: { blockedAt: addMonthsUtc(new Date(), -13) } });
    const now = new Date();
    assert.equal(await foreignSweepCandidates(now), 0);
    const tick = await runDocumentsRetentionTick({ now });
    assert.equal(tick.skipped, false);
    assert.deepEqual(tick.result!.failed, []);
    assert.equal(tick.result!.purged, 1, "solo el contrato 2");
    assert.equal(await getDocumentStorage().head(contract2Key), null);
    const row = await prisma.incomingDocument.findUniqueOrThrow({ where: { id: contract2.id } });
    assert.ok(row.deletedAt);
    assert.equal(row.searchText, null);
    assert.equal((await auditOf(contract2.id, "DOCUMENT_PURGED"))!.actorType, "system");
  });
});

describe("T9-13 · archivo y búsqueda (§7.4)", () => {
  it("una factura rechazada por la oficina entra en el archivo; la búsqueda por texto extraído la encuentra y no encuentra la purgada", async () => {
    invoice = await capture(app, receptionist, tenantA.propertyA, "factura-lavanderia.pdf", INVOICE, { kindHint: "invoice" });
    await call(app, "POST", `/properties/${tenantA.propertyA}/documents/${invoice.id}/send-to-office`, receptionist);
    const assigned = await call(app, "POST", `/properties/${tenantA.propertyA}/documents/${invoice.id}/assign`, clerk, {});
    assert.equal(assigned.status, 200, JSON.stringify(assigned.body));
    const rejected = await call(app, "POST", `/properties/${tenantA.propertyA}/documents/${invoice.id}/reject`, clerk, { reason: "not_ours", note: "Prueba de archivo" });
    assert.equal(rejected.status, 200, JSON.stringify(rejected.body));
    assert.equal(rejected.body.document.status, "rejected");
    const row = await prisma.incomingDocument.findUniqueOrThrow({ where: { id: invoice.id } });
    assert.ok(row.searchText && row.searchText.includes("T9-RT-0001"), `searchText con el texto extraído: ${row.searchText?.slice(0, 120)}`);
    const byText = await call(app, "GET", `${org(tenantA.organizationId)}/archive?q=T9-RT-0001`, accountant);
    assert.equal(byText.status, 200, JSON.stringify(byText.body));
    assert.deepEqual(
      items(byText).map((item) => item.id),
      [invoice.id]
    );
    const found = items(byText)[0]!;
    assert.equal(found.status, "rejected");
    assert.equal(found.sha256, invoice.sha256);
    assert.equal(found.originalFormat, "application/pdf");
    assert.equal(found.retentionUntil, `${new Date(row.documentDate ?? row.capturedAt).getUTCFullYear() + 1}-12-31`);
    const byRegistry = await call(app, "GET", `${org(tenantA.organizationId)}/archive?q=${encodeURIComponent(invoice.registryNumber)}`, accountant);
    assert.deepEqual(
      items(byRegistry).map((item) => item.id),
      [invoice.id]
    );
    const purgedSearch = await call(app, "GET", `${org(tenantA.organizationId)}/archive?q=${encodeURIComponent(contract1.registryNumber)}&includeBlocked=1&reason=Comprobaci%C3%B3n`, owner);
    assert.equal(purgedSearch.status, 200);
    assert.deepEqual(items(purgedSearch), [], "la purgada no aparece");
    const contractText = await call(app, "GET", `${org(tenantA.organizationId)}/archive?q=T9-RT-CONTRATO-1&includeBlocked=1&reason=Comprobaci%C3%B3n`, owner);
    assert.deepEqual(items(contractText), [], "el texto purgado ya no se busca");
  });

  it("filtros: kind, registryNumber exacto, importe, centro, fechas; cursor y cabeceras de paginación", async () => {
    const byKind = await call(app, "GET", `${org(tenantA.organizationId)}/archive?kind=invoice`, accountant);
    assert.deepEqual(
      items(byKind).map((item) => item.id),
      [invoice.id]
    );
    const noContracts = await call(app, "GET", `${org(tenantA.organizationId)}/archive?kind=contract`, accountant);
    assert.deepEqual(items(noContracts), []);
    const exact = await call(app, "GET", `${org(tenantA.organizationId)}/archive?registryNumber=${encodeURIComponent(invoice.registryNumber.toLowerCase())}`, accountant);
    assert.deepEqual(
      items(exact).map((item) => item.id),
      [invoice.id]
    );
    const tooExpensive = await call(app, "GET", `${org(tenantA.organizationId)}/archive?amountMin=999999`, accountant);
    assert.deepEqual(items(tooExpensive), []);
    const otherCentre = await call(app, "GET", `${org(tenantA.organizationId)}/archive?propertyId=${tenantA.propertyB}`, accountant);
    assert.deepEqual(items(otherCentre), []);
    const today = isoDay(new Date());
    const dated = await call(app, "GET", `${org(tenantA.organizationId)}/archive?from=2026-01-01&to=${today}`, accountant);
    assert.ok(items(dated).some((item) => item.id === invoice.id));
    const badRange = await call(app, "GET", `${org(tenantA.organizationId)}/archive?from=${today}&to=2026-01-01`, accountant);
    assert.equal(badRange.status, 400);
    assert.equal(codeOf(badRange), "VALIDATION_ERROR");
    const paged = await call(app, "GET", `${org(tenantA.organizationId)}/archive?limit=1&envelope=1`, accountant);
    assert.equal(paged.status, 200, JSON.stringify(paged.body));
    assert.equal(paged.body.items.length, 1);
    assert.ok(paged.headers["x-total-count"] !== undefined, "cabecera de paginación");
  });

  it("ámbito R11 y permisos: admin_clerk de un solo centro → 404 ENTITY_SCOPE_REQUIRED sin propertyId y 200 con él; recepción 403; otra organización 404", async () => {
    const scoped = await call(app, "GET", `${org(tenantA.organizationId)}/archive`, clerk, undefined, tenantA.propertyA);
    assert.equal(scoped.status, 404, JSON.stringify(scoped.body));
    assert.equal(codeOf(scoped), "ENTITY_SCOPE_REQUIRED");
    const own = await call(app, "GET", `${org(tenantA.organizationId)}/archive?propertyId=${tenantA.propertyA}`, clerk, undefined, tenantA.propertyA);
    assert.equal(own.status, 200, JSON.stringify(own.body));
    assert.ok(items(own).some((item) => item.id === invoice.id));
    const sister = await call(app, "GET", `${org(tenantA.organizationId)}/archive?propertyId=${tenantA.propertyB}`, clerk, undefined, tenantA.propertyA);
    assert.equal(sister.status, 404, JSON.stringify(sister.body));
    const denied = await call(app, "GET", `${org(tenantA.organizationId)}/archive`, receptionist, undefined, tenantA.propertyA);
    assert.equal(denied.status, 403, JSON.stringify(denied.body));
    const foreign = await call(app, "GET", `${org(tenantA.organizationId)}/archive`, ownerB);
    assert.equal(foreign.status, 404, JSON.stringify(foreign.body));
  });
});

describe("T9-13 · ajustes por organización y SLA de la cola (§6.3)", () => {
  it("PATCH officeSlaBusinessDays 30 / 3 → la cola muestra slaBreached distinto; GET refleja el cambio; auditoría DOCUMENT_SETTINGS_UPDATED", async () => {
    slaDoc = await capture(app, receptionist, tenantA.propertyA, "factura-sla.pdf", SLA_INVOICE, { kindHint: "invoice" });
    const sent = await call(app, "POST", `/properties/${tenantA.propertyA}/documents/${slaDoc.id}/send-to-office`, receptionist);
    assert.equal(sent.status, 200, JSON.stringify(sent.body));
    await prisma.incomingDocument.update({ where: { id: slaDoc.id }, data: { sentAt: new Date(Date.now() - 10 * 86_400_000) } });
    const queueRow = async (): Promise<Json> => {
      const queue = await call(app, "GET", `${org(tenantA.organizationId)}/queue`, accountant);
      assert.equal(queue.status, 200, JSON.stringify(queue.body));
      const row = items(queue).find((item) => item.id === slaDoc.id);
      assert.ok(row, "en la cola de la oficina");
      return row!;
    };
    assert.equal((await queueRow()).slaBreached, true, "SLA por defecto (2 días laborables) vencido tras 10 días");
    const initial = await call(app, "GET", `${org(tenantA.organizationId)}/settings`, director, undefined, tenantA.propertyA);
    assert.equal(initial.status, 200, JSON.stringify(initial.body));
    assert.equal(initial.body.officeSlaBusinessDays, 2);
    assert.equal(initial.body.updatedAt, null);
    assert.deepEqual(initial.body.aiAllowedKinds, ["invoice", "delivery_note", "receipt"]);
    const relaxed = await call(app, "PATCH", `${org(tenantA.organizationId)}/settings`, director, { officeSlaBusinessDays: 30 }, tenantA.propertyA);
    assert.equal(relaxed.status, 200, JSON.stringify(relaxed.body));
    assert.equal(relaxed.body.officeSlaBusinessDays, 30);
    assert.ok(relaxed.body.updatedAt);
    assert.equal((await queueRow()).slaBreached, false, "con 30 días laborables no ha vencido");
    const tightened = await call(app, "PATCH", `${org(tenantA.organizationId)}/settings`, director, { officeSlaBusinessDays: 3 }, tenantA.propertyA);
    assert.equal(tightened.status, 200, JSON.stringify(tightened.body));
    assert.equal((await queueRow()).slaBreached, true, "con 3 días laborables vuelve a estar vencido");
    const after = await call(app, "GET", `${org(tenantA.organizationId)}/settings`, director, undefined, tenantA.propertyA);
    assert.equal(after.body.officeSlaBusinessDays, 3);
    assert.equal(after.body.priceTolerancePct, "2.00");
    await flushAuditQueues();
    const audits = await prisma.auditEvent.findMany({ where: { organizationId: tenantA.organizationId, action: "DOCUMENT_SETTINGS_UPDATED" }, orderBy: { createdAt: "asc" }, select: { beforeJson: true, afterJson: true, actorUserId: true } });
    assert.equal(audits.length, 2);
    assert.deepEqual(audits[0]!.beforeJson, { officeSlaBusinessDays: 2 });
    assert.deepEqual(audits[0]!.afterJson, { officeSlaBusinessDays: 30 });
    assert.deepEqual(audits[1]!.afterJson, { officeSlaBusinessDays: 3 });
    assert.equal(audits[1]!.actorUserId, tenantA.users.generalManager.id);
  });

  it("PATCH inválido 400; sin documents.admin 403; otra organización 404", async () => {
    const invalid = await call(app, "PATCH", `${org(tenantA.organizationId)}/settings`, director, { officeSlaBusinessDays: 3, foo: 1 }, tenantA.propertyA);
    assert.equal(invalid.status, 400, JSON.stringify(invalid.body));
    assert.equal(codeOf(invalid), "VALIDATION_ERROR");
    const denied = await call(app, "PATCH", `${org(tenantA.organizationId)}/settings`, accountant, { officeSlaBusinessDays: 5 });
    assert.equal(denied.status, 403, JSON.stringify(denied.body));
    const deniedGet = await call(app, "GET", `${org(tenantA.organizationId)}/settings`, accountant);
    assert.equal(deniedGet.status, 403, JSON.stringify(deniedGet.body));
    const foreign = await call(app, "GET", `${org(tenantA.organizationId)}/settings`, ownerB);
    assert.equal(foreign.status, 404, JSON.stringify(foreign.body));
  });
});

describe("T9-13 · KPIs de la oficina (§9)", () => {
  it("200 con degraded [], pendientes por centro (los dos hoteles), SLA vencido y periodo por defecto; propertyId acota; 400 con from > to; 403 sin documents.review", async () => {
    const kpis = await call(app, "GET", `${org(tenantA.organizationId)}/kpis`, accountant);
    assert.equal(kpis.status, 200, JSON.stringify(kpis.body));
    assert.deepEqual(kpis.body.degraded, []);
    assert.equal(kpis.body.propertyId, null);
    assert.equal(kpis.body.to, isoDay(new Date()));
    assert.ok(kpis.body.from < kpis.body.to);
    assert.deepEqual(
      (kpis.body.pendingByProperty as Json[]).map((row) => row.propertyId).sort(),
      [tenantA.propertyA, tenantA.propertyB].sort()
    );
    const hotelA = (kpis.body.pendingByProperty as Json[]).find((row) => row.propertyId === tenantA.propertyA)!;
    assert.equal(hotelA.propertyCode, "L2A");
    assert.equal(hotelA.pending, 1, "la factura del SLA sigue pendiente");
    assert.equal(hotelA.slaBreached, 1);
    assert.equal(kpis.body.slaBreached, 1);
    assert.equal(typeof kpis.body.aiCostEur, "string");
    assert.equal(kpis.body.billsWithoutReceipt, 0);
    assert.equal(kpis.body.receiptsWithoutBill, 0);
    assert.equal(kpis.body.actionsDueThisWeek, 0);
    assert.ok(kpis.body.touchlessPct === null || typeof kpis.body.touchlessPct === "number");
    assert.ok(kpis.body.avgHoursCentreToOffice === null || typeof kpis.body.avgHoursCentreToOffice === "number");
    const scoped = await call(app, "GET", `${org(tenantA.organizationId)}/kpis?propertyId=${tenantA.propertyB}&from=2026-01-01&to=${isoDay(new Date())}`, accountant);
    assert.equal(scoped.status, 200, JSON.stringify(scoped.body));
    assert.equal(scoped.body.propertyId, tenantA.propertyB);
    assert.deepEqual(
      (scoped.body.pendingByProperty as Json[]).map((row) => row.propertyId),
      [tenantA.propertyB]
    );
    assert.equal(scoped.body.from, "2026-01-01");
    const badRange = await call(app, "GET", `${org(tenantA.organizationId)}/kpis?from=2026-09-30&to=2026-09-01`, accountant);
    assert.equal(badRange.status, 400);
    const denied = await call(app, "GET", `${org(tenantA.organizationId)}/kpis`, receptionist, undefined, tenantA.propertyA);
    assert.equal(denied.status, 403, JSON.stringify(denied.body));
    const centreOnly = await call(app, "GET", `${org(tenantA.organizationId)}/kpis`, clerk, undefined, tenantA.propertyA);
    assert.equal(centreOnly.status, 404, JSON.stringify(centreOnly.body));
    assert.equal(codeOf(centreOnly), "ENTITY_SCOPE_REQUIRED");
  });
});

describe("T9-13 · gancho GDPR (executeErasure, §3.4)", () => {
  it("un huésped del tenant con una factura y una carta → factura pseudonimizada (fichero conservado), carta purgada; Guest pseudonimizado", async () => {
    const guestEmail = `huesped.${RUN_A}@faranda.test`;
    const guest = await prisma.guest.create({
      data: { organizationId: tenantA.organizationId, firstName: "Prueba", surname1: "Ficticia", email: guestEmail, documentNumber: "00000000T", phone: "600000000" },
      select: { id: true }
    });
    const gdprInvoice = await capture(app, receptionist, tenantA.propertyA, "factura-huesped.pdf", GDPR_INVOICE, { kindHint: "invoice" });
    const letter = await capture(app, receptionist, tenantA.propertyA, "carta-huesped.pdf", LETTER, { kindHint: "letter" });
    const letterKey = await originalKeyOf(letter.id);
    const invoiceKey = await originalKeyOf(gdprInvoice.id);
    // Vínculo con el huésped y texto con sus datos (solo sobre el tenant de prueba; ninguna ruta lo fija todavía).
    for (const id of [gdprInvoice.id, letter.id]) {
      const row = await prisma.incomingDocument.findUniqueOrThrow({ where: { id }, select: { searchText: true } });
      await prisma.incomingDocument.update({ where: { id }, data: { guestId: guest.id, searchText: `${row.searchText ?? ""} Prueba Ficticia 00000000T ${guestEmail}` } });
    }
    const request = await prisma.gdprRequest.create({
      data: { organizationId: tenantA.organizationId, propertyId: tenantA.propertyA, subjectType: "guest", subjectEmail: guestEmail, requestType: "erasure", status: "pending", requestorEmail: guestEmail },
      select: { id: true }
    });
    const { summary } = await executeErasure(request.id, tenantA.users.owner.id, { confirmRetentionOverride: false });
    const documentTables = summary.tables.filter((table) => table.name === "IncomingDocument");
    assert.deepEqual(
      documentTables.map((table) => [table.action, table.rowsAffected]),
      [
        ["pseudonymized", 1],
        ["deleted", 1]
      ]
    );
    const invoiceRow = await prisma.incomingDocument.findUniqueOrThrow({ where: { id: gdprInvoice.id } });
    assert.equal(invoiceRow.deletedAt, null, "la factura (efecto fiscal) se conserva");
    assert.ok(invoiceRow.searchText!.includes(ERASED_PLACEHOLDER));
    assert.ok(!invoiceRow.searchText!.includes("Ficticia") && !invoiceRow.searchText!.includes("00000000T") && !invoiceRow.searchText!.includes(guestEmail), invoiceRow.searchText!);
    assert.ok(await getDocumentStorage().head(invoiceKey), "el fichero de la factura sigue en el almacén");
    assert.equal((await auditOf(gdprInvoice.id, "DOCUMENT_GDPR_ERASED"))!.actorUserId, tenantA.users.owner.id);
    const letterRow = await prisma.incomingDocument.findUniqueOrThrow({ where: { id: letter.id } });
    assert.ok(letterRow.deletedAt, "la carta (sin efecto fiscal) se purga");
    assert.equal(letterRow.searchText, null);
    assert.equal(await getDocumentStorage().head(letterKey), null, "el fichero de la carta ya no está");
    assert.equal((await auditOf(letter.id, "DOCUMENT_PURGED"))!.actorType, "user");
    const guestRow = await prisma.guest.findUniqueOrThrow({ where: { id: guest.id }, select: { firstName: true, email: true } });
    assert.equal(guestRow.firstName, "Erased");
    assert.notEqual(guestRow.email, guestEmail);
  });
});
