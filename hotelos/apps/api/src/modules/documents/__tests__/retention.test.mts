// Unit tests · Tanda T9 · lote T9-13 — retención → bloqueo → purga
// (retention.service.ts) con Prisma y almacén simulados: bloquea al vencer
// retentionUntil (auditoría DOCUMENT_BLOCKED, actorType system), no bloquea con
// legalHold, purga a los 12 meses de bloqueo (storage.delete por clave,
// searchText null, campos extraídos pseudonimizados, deletedAt), relanza la
// extracción pendiente de más de 10 minutos, aplica la decisión autónoma y
// devuelve failed[] con el error sin tragarlo (QC-06); bloqueo / desbloqueo /
// purga de administración (403, 409 DOCUMENT_LEGAL_HOLD) y gancho GDPR. Sin
// Postgres, sin red. Desde apps/api:
//   node --import tsx --test src/modules/documents/__tests__/retention.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PermissionDeniedError, type PermissionKey } from "@hotelos/shared";
import type { UserContext } from "../../../lib/demo-store.js";
import { HttpError } from "../../../lib/http-error.js";
import {
  addMonthsUtc,
  createDocumentRetentionService,
  DocumentAdminActionSchema,
  DOCUMENT_RETENTION_AUDIT_ACTIONS,
  ERASED_PLACEHOLDER,
  isFiscalKind,
  isPersonalKey,
  pendingReextractCutoff,
  purgeCutoff,
  PURGED_PLACEHOLDER,
  RETENTION_BLOCK_TO_PURGE_MONTHS,
  scrubPersonalFields,
  scrubText,
  subjectValuesOf
} from "../retention.service.js";
import { documentsRetentionIntervalMs, shouldStartDocumentsRetentionJob } from "../documents-retention.job.js";

const NOW = new Date("2026-09-20T10:00:00.000Z");

function context(permissions: PermissionKey[]): UserContext {
  return { organizationId: "org_t9", propertyId: "prop_t9a", userId: "usr_admin", fullName: "Prueba T9", deviceId: "dev_t9", permissions };
}

function codeOf(error: unknown): string | undefined {
  return error instanceof HttpError ? (error.details as { code?: string } | undefined)?.code : undefined;
}

async function expectHttp(run: () => Promise<unknown>, statusCode: number, code?: string): Promise<HttpError> {
  try {
    await run();
  } catch (error) {
    assert.ok(error instanceof HttpError, `HttpError esperado, llegó ${String(error)}`);
    assert.equal(error.statusCode, statusCode);
    if (code) assert.equal(codeOf(error), code);
    return error;
  }
  assert.fail(`se esperaba ${statusCode} ${code ?? ""}`);
}

// ---------------------------------------------------------------------------
// BD simulada (subconjunto de filtros que usa el servicio)
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

function jsonPath(value: unknown, path: string[]): unknown {
  let node: unknown = value;
  for (const key of path) {
    if (!node || typeof node !== "object") return undefined;
    node = (node as Record<string, unknown>)[key];
  }
  return node;
}

function same(a: unknown, b: unknown): boolean {
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  return a === b;
}

function matches(row: Row, where: Record<string, unknown> | undefined): boolean {
  if (!where) return true;
  for (const [key, cond] of Object.entries(where)) {
    if (key === "AND") {
      if (!(cond as Row[]).every((sub) => matches(row, sub))) return false;
      continue;
    }
    if (key === "OR") {
      if (!(cond as Row[]).some((sub) => matches(row, sub))) return false;
      continue;
    }
    const value = row[key];
    if (cond === null) {
      if (value !== null && value !== undefined) return false;
      continue;
    }
    if (cond instanceof Date || typeof cond !== "object") {
      if (!same(value, cond)) return false;
      continue;
    }
    const filter = cond as Record<string, unknown>;
    if ("in" in filter && !(filter.in as unknown[]).some((item) => same(item, value))) return false;
    if ("lte" in filter) {
      if (value == null || (value as Date).getTime() > (filter.lte as Date).getTime()) return false;
    }
    if ("gte" in filter) {
      if (value == null || (value as Date).getTime() < (filter.gte as Date).getTime()) return false;
    }
    if ("not" in filter) {
      if (filter.not === null ? value == null : same(value, filter.not)) return false;
    }
    if ("path" in filter) {
      if (jsonPath(value, filter.path as string[]) !== filter.equals) return false;
    }
    if ("gt" in filter) {
      if (value == null || (value as Date).getTime() <= (filter.gt as Date).getTime()) return false;
    }
    if ("startsWith" in filter && !String(value ?? "").startsWith(String(filter.startsWith))) return false;
  }
  return true;
}

function delegate(rows: Row[]) {
  return {
    rows,
    findMany: async (args: { where?: Row; take?: number } = {}) => {
      const out = rows.filter((row) => matches(row, args.where));
      return typeof args.take === "number" ? out.slice(0, args.take) : out;
    },
    findFirst: async (args: { where?: Row } = {}) => rows.find((row) => matches(row, args.where)) ?? null,
    findUnique: async (args: { where: Row }) => rows.find((row) => matches(row, args.where)) ?? null,
    updateMany: async (args: { where?: Row; data: Row }) => {
      const hit = rows.filter((row) => matches(row, args.where));
      for (const row of hit) Object.assign(row, args.data);
      return { count: hit.length };
    },
    update: async (args: { where: Row; data: Row }) => {
      const row = rows.find((candidate) => matches(candidate, args.where));
      if (!row) throw new Error(`fila no encontrada: ${JSON.stringify(args.where)}`);
      Object.assign(row, args.data);
      // Como Prisma: la fila devuelta es una copia, no la referencia del almacén.
      return { ...row };
    },
    create: async (args: { data: Row }) => {
      const row = { id: `row_${rows.length + 1}`, createdAt: NOW, ...args.data };
      rows.push(row);
      return { ...row };
    }
  };
}

/** Tablas del RBAC y de avisos que usa office-notifications.ts (paso 5 del barrido): un revisor / admin de la organización. */
function rbacDelegates(organizationId: string) {
  return {
    permission: delegate([{ id: "perm_review", key: "documents.review" }, { id: "perm_admin", key: "documents.admin" }]),
    rolePermission: delegate([{ roleId: "role_owner", permissionId: "perm_review" }, { roleId: "role_owner", permissionId: "perm_admin" }]),
    role: delegate([{ id: "role_owner", organizationId }]),
    property: delegate([{ id: "prop_t9a", legalEntityId: null, name: "Hotel demo", code: "T9A" }]),
    propertyGroupMember: delegate([]),
    userRoleAssignment: delegate([{ userId: "usr_owner", roleId: "role_owner", organizationId, scopeType: "organization", propertyId: null, propertyGroupId: null, legalEntityId: null, revokedAt: null, validFrom: new Date("2026-01-01T00:00:00.000Z"), validTo: null }]),
    userPropertyRole: delegate([]),
    user: delegate([{ id: "usr_owner", organizationId, status: "active" }]),
    notification: delegate([])
  };
}

function fakeDb(seed: { documents?: Row[]; files?: Row[]; pages?: Row[]; extractions?: Row[]; settings?: Row[] } = {}) {
  const documents = seed.documents ?? [];
  const files = seed.files ?? [];
  const pages = seed.pages ?? [];
  const extractions = seed.extractions ?? [];
  const delegates = {
    incomingDocument: delegate(documents),
    documentFile: delegate(files),
    documentPage: delegate(pages),
    documentExtraction: delegate(extractions),
    documentAction: { findMany: async () => [] },
    supplier: { findUnique: async () => null },
    documentSettings: delegate(seed.settings ?? []),
    ...rbacDelegates("org_t9")
  };
  const db = {
    ...delegates,
    transactions: 0,
    $transaction: async <T>(fn: (tx: typeof delegates) => Promise<T>): Promise<T> => {
      db.transactions += 1;
      return fn(delegates);
    },
    documents,
    files,
    pages,
    extractions,
    notifications: delegates.notification
  };
  return db;
}

type FakeDb = ReturnType<typeof fakeDb>;

function fakeStorage(options: { failDelete?: boolean } = {}) {
  const deleted: string[] = [];
  return {
    kind: "disk" as const,
    deleted,
    put: async () => {
      throw new Error("no usado");
    },
    get: async () => null,
    head: async () => null,
    delete: async (key: string) => {
      if (options.failDelete) throw new Error("almacén caído");
      deleted.push(key);
    }
  };
}

function doc(overrides: Row = {}): Row {
  return {
    id: "doc_1",
    organizationId: "org_t9",
    legalEntityId: null,
    propertyId: "prop_t9a",
    registryNumber: "DOC-T9A-2026-000001",
    registryYear: 2026,
    registrySeq: 1,
    kind: "invoice",
    kindConfidence: null,
    classificationSource: null,
    status: "archived",
    physicalStatus: "at_centre",
    source: "upload",
    originalFormat: "application/pdf",
    title: "Factura demo",
    sha256: "a".repeat(64),
    sizeBytes: 1234,
    pageCount: 1,
    supplierId: null,
    supplierTaxId: null,
    documentNumber: null,
    documentDate: null,
    totalAmount: null,
    currency: "EUR",
    extractionStatus: "done",
    proposedAction: null,
    proposedActionJson: {},
    checksJson: [],
    reviewedFieldsJson: null,
    searchText: "DOC-T9A-2026-000001 factura demo",
    emailMetaJson: null,
    capturedBy: null,
    capturedAt: new Date("2026-01-10T08:00:00.000Z"),
    sentAt: null,
    assignedTo: null,
    reviewStartedAt: null,
    decidedBy: null,
    decidedAt: null,
    rejectReason: null,
    rejectNote: null,
    supplierBillId: null,
    expenseId: null,
    goodsReceiptId: null,
    reviewItemId: null,
    dispatchBatchId: null,
    mergedIntoId: null,
    postedAt: null,
    archivedAt: new Date("2026-01-11T08:00:00.000Z"),
    retentionUntil: null,
    extendedRetention: false,
    legalHold: false,
    blockedAt: null,
    deletedAt: null,
    guestId: null,
    createdAt: new Date("2026-01-10T08:00:00.000Z"),
    updatedAt: new Date("2026-01-10T08:00:00.000Z"),
    ...overrides
  };
}

type AuditCall = { action: string; actorType: string; actorUserId?: string; entityId?: string; afterJson?: unknown; beforeJson?: unknown };

function serviceWith(db: FakeDb, options: { storage?: ReturnType<typeof fakeStorage>; runPipeline?: (id: string, opts: unknown) => Promise<unknown>; applyAutonomous?: (id: string, opts: unknown) => Promise<{ applied: boolean; reason: string }> } = {}) {
  const storage = options.storage ?? fakeStorage();
  const audits: AuditCall[] = [];
  const pipelineCalls: Array<{ id: string; opts: unknown }> = [];
  const autonomousCalls: string[] = [];
  const service = createDocumentRetentionService({
    db: db as unknown as Parameters<typeof createDocumentRetentionService>[0]["db"],
    storage: () => storage,
    now: () => NOW,
    runPipeline: (async (id: string, opts: unknown) => {
      pipelineCalls.push({ id, opts });
      return options.runPipeline ? options.runPipeline(id, opts) : { ok: true };
    }) as unknown as Parameters<typeof createDocumentRetentionService>[0]["runPipeline"],
    applyAutonomous: (async (id: string, opts: unknown) => {
      autonomousCalls.push(id);
      return options.applyAutonomous ? options.applyAutonomous(id, opts) : { applied: true, reason: "ok" };
    }) as unknown as Parameters<typeof createDocumentRetentionService>[0]["applyAutonomous"],
    audit: ((input: AuditCall) => {
      audits.push(input);
      return { id: `aud_${audits.length}` };
    }) as unknown as Parameters<typeof createDocumentRetentionService>[0]["audit"]
  });
  return { service, storage, audits, pipelineCalls, autonomousCalls };
}

// ---------------------------------------------------------------------------
// Funciones puras
// ---------------------------------------------------------------------------

describe("fechas de la retención (§3.2 / §7.5)", () => {
  it("addMonthsUtc, purgeCutoff (12 meses) y pendingReextractCutoff (10 min)", () => {
    assert.equal(addMonthsUtc(new Date("2026-01-31T00:00:00.000Z"), 1).toISOString(), "2026-03-03T00:00:00.000Z");
    assert.equal(addMonthsUtc(NOW, -RETENTION_BLOCK_TO_PURGE_MONTHS).toISOString(), "2025-09-20T10:00:00.000Z");
    assert.equal(purgeCutoff(NOW).toISOString(), "2025-09-20T10:00:00.000Z");
    assert.equal(pendingReextractCutoff(NOW).toISOString(), "2026-09-20T09:50:00.000Z");
  });

  it("isFiscalKind: factura, albarán y ticket nunca se purgan por GDPR", () => {
    assert.equal(isFiscalKind("invoice"), true);
    assert.equal(isFiscalKind("delivery_note"), true);
    assert.equal(isFiscalKind("receipt"), true);
    assert.equal(isFiscalKind("letter"), false);
    assert.equal(isFiscalKind("contract"), false);
  });

  it("shouldStartDocumentsRetentionJob / documentsRetentionIntervalMs (job del líder)", () => {
    assert.equal(shouldStartDocumentsRetentionJob({ runSchedulers: true, disabled: false }), true);
    assert.equal(shouldStartDocumentsRetentionJob({ runSchedulers: false, disabled: false }), false);
    assert.equal(shouldStartDocumentsRetentionJob({ runSchedulers: true, disabled: true }), false);
    assert.equal(documentsRetentionIntervalMs(undefined), 86_400_000);
    assert.equal(documentsRetentionIntervalMs(1_000), 86_400_000);
    assert.equal(documentsRetentionIntervalMs(120_000), 120_000);
  });
});

describe("pseudonimización (§3.4)", () => {
  it("subjectValuesOf: ≥ 3 caracteres, sin repetidos, los más largos primero; scrubText sin distinguir mayúsculas", () => {
    assert.deepEqual(subjectValuesOf(["Ana", " Ana ", "AB", null, undefined, "Apellido Largo", "12345678Z"]), ["Apellido Largo", "12345678Z", "Ana"]);
    assert.equal(scrubText("Carta de ANA Apellido Largo (12345678Z)", subjectValuesOf(["Ana", "Apellido Largo", "12345678Z"])), `Carta de ${ERASED_PLACEHOLDER} ${ERASED_PLACEHOLDER} (${ERASED_PLACEHOLDER})`);
    assert.equal(scrubText(null, ["Ana"]), null);
    assert.equal(scrubText("sin cambios", []), "sin cambios");
  });

  it("isPersonalKey: claves de persona sí, de proveedor / emisor no", () => {
    assert.equal(isPersonalKey("customerName"), true);
    assert.equal(isPersonalKey("guestEmail"), true);
    assert.equal(isPersonalKey("dni"), true);
    assert.equal(isPersonalKey("supplierName"), false);
    assert.equal(isPersonalKey("issuerTaxId"), false);
    assert.equal(isPersonalKey("total"), false);
  });

  it("scrubPersonalFields purge: toda cadena → [purgado], números y fechas se conservan, estructura intacta", () => {
    const out = scrubPersonalFields({ supplierName: "Demo SL", total: "10.00", taxRate: 21, lines: [{ description: "Café", qty: 2 }], empty: "" }, { mode: "purge" }) as Record<string, unknown>;
    assert.equal(out.supplierName, PURGED_PLACEHOLDER);
    assert.equal(out.total, PURGED_PLACEHOLDER);
    assert.equal(out.taxRate, 21);
    assert.deepEqual(out.lines, [{ description: PURGED_PLACEHOLDER, qty: 2 }]);
    assert.equal(out.empty, "");
  });

  it("scrubPersonalFields erasure: hojas bajo clave personal → [suprimido]; en el resto solo los valores del sujeto", () => {
    const out = scrubPersonalFields(
      { customerName: "Ana Ficticia", customer: { dni: "12345678Z", age: 40 }, supplierName: "Lavandería Ana Ficticia SL", note: "Entregar a Ana Ficticia", total: "10.00" },
      { mode: "erasure", values: subjectValuesOf(["Ana Ficticia", "12345678Z"]) }
    ) as Record<string, unknown>;
    assert.equal(out.customerName, ERASED_PLACEHOLDER);
    assert.deepEqual(out.customer, { dni: ERASED_PLACEHOLDER, age: ERASED_PLACEHOLDER });
    assert.equal(out.supplierName, `Lavandería ${ERASED_PLACEHOLDER} SL`);
    assert.equal(out.note, `Entregar a ${ERASED_PLACEHOLDER}`);
    assert.equal(out.total, "10.00");
  });
});

describe("DocumentAdminActionSchema (§9 block / unblock / purge)", () => {
  it("reason obligatorio (≥ 3), legalHold booleano opcional, sin claves extra", () => {
    assert.equal(DocumentAdminActionSchema.safeParse({ reason: "Requerimiento AEAT", legalHold: true }).success, true);
    assert.equal(DocumentAdminActionSchema.safeParse({ reason: "ok" }).success, false);
    assert.equal(DocumentAdminActionSchema.safeParse({}).success, false);
    assert.equal(DocumentAdminActionSchema.safeParse({ reason: "motivo", legalHold: "sí" }).success, false);
    assert.equal(DocumentAdminActionSchema.safeParse({ reason: "motivo", extra: 1 }).success, false);
  });
});

// ---------------------------------------------------------------------------
// Barrido diario
// ---------------------------------------------------------------------------

describe("runRetentionSweep · bloqueo al vencer", () => {
  it("bloquea los vencidos sin legalHold (blockedAt = now, auditoría DOCUMENT_BLOCKED actorType system) y deja los demás", async () => {
    const db = fakeDb({
      documents: [
        doc({ id: "doc_due", retentionUntil: new Date("2026-09-19T00:00:00.000Z") }),
        doc({ id: "doc_future", retentionUntil: new Date("2032-12-31T00:00:00.000Z") }),
        doc({ id: "doc_hold", retentionUntil: new Date("2020-12-31T00:00:00.000Z"), legalHold: true }),
        doc({ id: "doc_already", retentionUntil: new Date("2020-12-31T00:00:00.000Z"), blockedAt: new Date("2026-09-01T00:00:00.000Z") }),
        doc({ id: "doc_purged", retentionUntil: new Date("2020-12-31T00:00:00.000Z"), deletedAt: new Date("2026-09-01T00:00:00.000Z") })
      ]
    });
    const { service, audits } = serviceWith(db);
    const result = await service.runRetentionSweep({ now: NOW, correlationId: "corr_t9" });
    assert.equal(result.blocked, 1);
    assert.equal(result.purged, 0);
    assert.deepEqual(result.failed, []);
    assert.equal((db.documents[0]!.blockedAt as Date).toISOString(), NOW.toISOString());
    assert.equal(db.documents[1]!.blockedAt, null);
    assert.equal(db.documents[2]!.blockedAt, null, "legalHold impide el bloqueo");
    const blocked = audits.filter((audit) => audit.action === DOCUMENT_RETENTION_AUDIT_ACTIONS.blocked);
    assert.equal(blocked.length, 1);
    assert.equal(blocked[0]!.actorType, "system");
    assert.equal(blocked[0]!.entityId, "doc_due");
    assert.equal((blocked[0]!.afterJson as { reason: string }).reason, "retention_expired");
  });
});

describe("runRetentionSweep · contabilizados sin retención (RV-04) y SLA de la oficina vencido (RV-10)", () => {
  it("posted sin retentionUntil → 31/12 del ejercicio + 6 años (ajustes de la organización si los hay); los demás estados no se tocan", async () => {
    const db = fakeDb({
      documents: [
        doc({ id: "doc_posted", status: "posted", retentionUntil: null, documentDate: new Date("2026-03-05T00:00:00.000Z"), postedAt: new Date("2026-09-01T00:00:00.000Z") }),
        doc({ id: "doc_posted_letter", status: "posted", kind: "letter", retentionUntil: null, documentDate: null, capturedAt: new Date("2025-11-20T00:00:00.000Z"), guestId: "gst_1" }),
        doc({ id: "doc_posted_ok", status: "posted", retentionUntil: new Date("2031-12-31T00:00:00.000Z") }),
        doc({ id: "doc_review", status: "in_review", retentionUntil: null })
      ],
      settings: [{ organizationId: "org_t9", retentionYearsDefault: 7, letterRetentionYears: 6, extendedRetentionYears: 10, officeSlaBusinessDays: 2 }]
    });
    const { service } = serviceWith(db);
    const result = await service.runRetentionSweep({ now: NOW, correlationId: "corr_rv04" });
    assert.equal(result.retentionAssigned, 2);
    assert.deepEqual(result.failed, []);
    assert.equal((db.documents[0]!.retentionUntil as Date).toISOString().slice(0, 10), "2033-12-31", "factura: ejercicio 2026 + 7 (retentionYearsDefault de la organización)");
    assert.equal((db.documents[1]!.retentionUntil as Date).toISOString().slice(0, 10), "2029-12-31", "carta con huésped (datos personales): 2025 + 4");
    assert.equal((db.documents[2]!.retentionUntil as Date).toISOString().slice(0, 10), "2031-12-31", "la fecha existente no se pisa");
    assert.equal(db.documents[3]!.retentionUntil, null, "in_review no lleva retención");
    assert.equal((await service.runRetentionSweep({ now: NOW })).retentionAssigned, 0, "idempotente");
  });

  it("documentos enviados con el SLA vencido → un aviso diario a documents.admin con los registros; sin vencidos no avisa", async () => {
    const db = fakeDb({
      documents: [
        doc({ id: "doc_late", status: "sent_to_office", sentAt: new Date("2026-09-10T09:00:00.000Z"), retentionUntil: null }),
        doc({ id: "doc_late_2", status: "in_review", registryNumber: "DOC-T9A-2026-000002", sentAt: new Date("2026-09-11T09:00:00.000Z"), retentionUntil: null }),
        doc({ id: "doc_fresh", status: "sent_to_office", sentAt: new Date(NOW.getTime() - 3_600_000), retentionUntil: null }),
        doc({ id: "doc_decided", status: "approved", sentAt: new Date("2026-09-01T09:00:00.000Z"), retentionUntil: null })
      ]
    });
    const { service } = serviceWith(db);
    const result = await service.runRetentionSweep({ now: NOW, correlationId: "corr_rv10" });
    assert.equal(result.slaNotified, 1);
    assert.deepEqual(result.failed, []);
    assert.equal(db.notifications.rows.length, 1);
    const note = db.notifications.rows[0]!;
    assert.equal(note.userId, "usr_owner");
    assert.equal(note.type, "system");
    assert.match(String(note.title), /^SLA de la oficina incumplido · 2 documentos/);
    assert.match(String(note.body), /DOC-T9A-2026-000001, DOC-T9A-2026-000002/);
    assert.doesNotMatch(String(note.body), /doc_fresh|doc_decided/);
    const again = await service.runRetentionSweep({ now: new Date(NOW.getTime() + 3_600_000) });
    assert.equal(again.slaNotified, 0, "una vez al día por persona");
    assert.equal(db.notifications.rows.length, 1);
  });
});

describe("runRetentionSweep · purga a los 12 meses", () => {
  it("borra los ficheros del almacén, vacía searchText, pseudonimiza fieldsJson y fija deletedAt (DOCUMENT_PURGED); legalHold y < 12 meses no se purgan", async () => {
    const db = fakeDb({
      documents: [
        doc({ id: "doc_old", blockedAt: new Date("2025-08-01T00:00:00.000Z") }),
        doc({ id: "doc_recent", blockedAt: new Date("2026-03-01T00:00:00.000Z") }),
        doc({ id: "doc_hold", blockedAt: new Date("2025-01-01T00:00:00.000Z"), legalHold: true })
      ],
      files: [
        { id: "file_1", documentId: "doc_old", storageKind: "disk", storageKey: "org_t9/2026/doc_old/original.pdf", inline: null },
        { id: "file_2", documentId: "doc_old", storageKind: "inline", storageKey: null, inline: "JVBERi0=" },
        { id: "file_3", documentId: "doc_hold", storageKind: "disk", storageKey: "org_t9/2026/doc_hold/original.pdf", inline: null }
      ],
      pages: [{ id: "page_1", documentId: "doc_old", pageNo: 1, textExtracted: "Factura demo" }],
      extractions: [{ id: "ext_1", documentId: "doc_old", fieldsJson: { supplierName: "Demo SL", total: "10.00", taxRate: 21 }, confidenceJson: { total: 0.9 } }]
    });
    const { service, storage, audits } = serviceWith(db);
    const result = await service.runRetentionSweep({ now: NOW });
    assert.equal(result.purged, 1);
    assert.equal(result.blocked, 0);
    assert.deepEqual(result.failed, []);
    assert.deepEqual(storage.deleted, ["org_t9/2026/doc_old/original.pdf"]);
    const purged = db.documents[0]!;
    assert.equal(purged.searchText, null);
    assert.equal((purged.deletedAt as Date).toISOString(), NOW.toISOString());
    assert.deepEqual(purged.proposedActionJson, {});
    assert.equal(db.files[1]!.inline, null, "el inline también se vacía");
    assert.equal(db.pages[0]!.textExtracted, null);
    assert.deepEqual(db.extractions[0]!.fieldsJson, { supplierName: PURGED_PLACEHOLDER, total: PURGED_PLACEHOLDER, taxRate: 21 });
    assert.deepEqual(db.extractions[0]!.confidenceJson, {});
    assert.equal(db.documents[1]!.deletedAt, null, "bloqueado hace menos de 12 meses");
    assert.equal(db.documents[2]!.deletedAt, null, "legalHold impide la purga");
    const purgedAudits = audits.filter((audit) => audit.action === DOCUMENT_RETENTION_AUDIT_ACTIONS.purged);
    assert.equal(purgedAudits.length, 1);
    assert.equal(purgedAudits[0]!.actorType, "system");
    assert.equal((purgedAudits[0]!.afterJson as { filesDeleted: number }).filesDeleted, 1);
  });

  it("si el almacén falla, la BD no se toca y el fallo va a failed[] (QC-06)", async () => {
    const db = fakeDb({
      documents: [doc({ id: "doc_old", blockedAt: new Date("2025-08-01T00:00:00.000Z") })],
      files: [{ id: "file_1", documentId: "doc_old", storageKind: "disk", storageKey: "org_t9/2026/doc_old/original.pdf", inline: null }]
    });
    const { service } = serviceWith(db, { storage: fakeStorage({ failDelete: true }) });
    const result = await service.runRetentionSweep({ now: NOW });
    assert.equal(result.purged, 0);
    assert.deepEqual(result.failed, [{ documentId: "doc_old", step: "purge", error: "almacén caído" }]);
    assert.equal(db.documents[0]!.deletedAt, null);
    assert.equal(db.documents[0]!.searchText, "DOC-T9A-2026-000001 factura demo");
    assert.equal(db.transactions, 0);
  });
});

describe("runRetentionSweep · extracción atascada y decisión autónoma", () => {
  it("pending > 10 min → runDocumentPipeline (trigger manual); pending reciente no; el error del pipeline va a failed[] y el barrido sigue", async () => {
    const db = fakeDb({
      documents: [
        doc({ id: "doc_stuck", status: "captured", extractionStatus: "pending", capturedAt: new Date("2026-09-20T09:40:00.000Z") }),
        doc({ id: "doc_fresh", status: "captured", extractionStatus: "pending", capturedAt: new Date("2026-09-20T09:55:00.000Z") }),
        doc({ id: "doc_boom", status: "captured", extractionStatus: "pending", capturedAt: new Date("2026-09-20T09:00:00.000Z") }),
        doc({ id: "doc_auto", status: "sent_to_office", sentAt: new Date("2026-09-19T08:00:00.000Z"), proposedActionJson: { autonomy: { level: "autonomous", enabled: true } } }),
        doc({ id: "doc_assisted", status: "sent_to_office", sentAt: new Date("2026-09-19T08:00:00.000Z"), proposedActionJson: { autonomy: { level: "assisted" } } })
      ]
    });
    const { service, pipelineCalls, autonomousCalls } = serviceWith(db, {
      runPipeline: async (id) => {
        if (id === "doc_boom") throw new Error("proveedor caído");
        return { ok: true };
      }
    });
    const result = await service.runRetentionSweep({ now: NOW, correlationId: "corr_sweep" });
    // Solo cuenta lo relanzado con éxito; doc_boom va a failed[] (la BD simulada no ordena: se compara el conjunto).
    assert.equal(result.reextracted, 1);
    assert.deepEqual(pipelineCalls.map((call) => call.id).sort(), ["doc_boom", "doc_stuck"]);
    assert.deepEqual(pipelineCalls.find((call) => call.id === "doc_stuck")!.opts, { trigger: "manual", correlationId: "corr_sweep" });
    assert.deepEqual(result.failed, [{ documentId: "doc_boom", step: "reextract", error: "proveedor caído" }]);
    assert.deepEqual(autonomousCalls, ["doc_auto"]);
    assert.equal(result.autonomous, 1);
    assert.equal(result.startedAt, NOW.toISOString());
  });

  it("applyAutonomousDecision que no aplica no cuenta; si lanza, failed[] con step autonomous", async () => {
    const db = fakeDb({
      documents: [
        doc({ id: "doc_a", status: "in_review", sentAt: new Date("2026-09-19T08:00:00.000Z"), proposedActionJson: { autonomy: { level: "autonomous" } } }),
        doc({ id: "doc_b", status: "in_review", sentAt: new Date("2026-09-19T09:00:00.000Z"), proposedActionJson: { autonomy: { level: "autonomous" } } })
      ]
    });
    const { service } = serviceWith(db, {
      applyAutonomous: async (id) => {
        if (id === "doc_b") throw new Error("checks en rojo");
        return { applied: false, reason: "checks_not_ok" };
      }
    });
    const result = await service.runRetentionSweep({ now: NOW });
    assert.equal(result.autonomous, 0);
    assert.deepEqual(result.failed, [{ documentId: "doc_b", step: "autonomous", error: "checks en rojo" }]);
  });
});

// ---------------------------------------------------------------------------
// Administración
// ---------------------------------------------------------------------------

describe("blockDocument / unblockDocument / purgeDocument (documents.admin)", () => {
  it("403 sin documents.admin; 400 sin reason; 404 fuera de la organización", async () => {
    const db = fakeDb({ documents: [doc({ id: "doc_1" })] });
    const { service } = serviceWith(db);
    await assert.rejects(service.blockDocument({ context: context(["documents.review"]), organizationId: "org_t9", id: "doc_1", body: { reason: "motivo" } }), PermissionDeniedError);
    await expectHttp(() => service.blockDocument({ context: context(["documents.admin"]), organizationId: "org_t9", id: "doc_1", body: {} }), 400);
    await expectHttp(() => service.blockDocument({ context: context(["documents.admin"]), organizationId: "org_otra", id: "doc_1", body: { reason: "motivo" } }), 404, "DOCUMENT_NOT_FOUND");
  });

  it("bloqueo manual con legalHold → purge 409 DOCUMENT_LEGAL_HOLD; sin bloqueo → 409 DOCUMENT_STATUS_TRANSITION; ya bloqueado → 409 DOCUMENT_BLOCKED", async () => {
    const db = fakeDb({ documents: [doc({ id: "doc_1" })], files: [{ id: "file_1", documentId: "doc_1", storageKind: "disk", storageKey: "org_t9/2026/doc_1/original.pdf", inline: null }] });
    const { service, storage, audits } = serviceWith(db);
    const admin = context(["documents.admin"]);
    await expectHttp(() => service.purgeDocument({ context: admin, organizationId: "org_t9", id: "doc_1", body: { reason: "sin bloquear" } }), 409, "DOCUMENT_STATUS_TRANSITION");
    const blocked = await service.blockDocument({ context: admin, organizationId: "org_t9", id: "doc_1", body: { reason: "Requerimiento", legalHold: true } });
    assert.equal(blocked.blockedAt, NOW.toISOString());
    assert.equal(blocked.legalHold, true);
    assert.equal(audits.at(-1)!.action, DOCUMENT_RETENTION_AUDIT_ACTIONS.blocked);
    assert.equal(audits.at(-1)!.actorType, "user");
    assert.equal(audits.at(-1)!.actorUserId, "usr_admin");
    await expectHttp(() => service.blockDocument({ context: admin, organizationId: "org_t9", id: "doc_1", body: { reason: "otra vez" } }), 409, "DOCUMENT_BLOCKED");
    await expectHttp(() => service.purgeDocument({ context: admin, organizationId: "org_t9", id: "doc_1", body: { reason: "purgar" } }), 409, "DOCUMENT_LEGAL_HOLD");
    assert.deepEqual(storage.deleted, []);
    const unblocked = await service.unblockDocument({ context: admin, organizationId: "org_t9", id: "doc_1", body: { reason: "Requerimiento resuelto", legalHold: false } });
    assert.equal(unblocked.blockedAt, null);
    assert.equal(unblocked.legalHold, false);
    assert.equal(audits.at(-1)!.action, DOCUMENT_RETENTION_AUDIT_ACTIONS.unblocked);
    await expectHttp(() => service.unblockDocument({ context: admin, organizationId: "org_t9", id: "doc_1", body: { reason: "ya está" } }), 409, "DOCUMENT_STATUS_TRANSITION");
    // Bloqueado sin legalHold → purga manual (no exige los 12 meses).
    await service.blockDocument({ context: admin, organizationId: "org_t9", id: "doc_1", body: { reason: "Cierre del expediente" } });
    const purged = await service.purgeDocument({ context: admin, organizationId: "org_t9", id: "doc_1", body: { reason: "Expediente cerrado" } });
    assert.equal(purged.deletedAt, NOW.toISOString());
    assert.deepEqual(storage.deleted, ["org_t9/2026/doc_1/original.pdf"]);
    assert.equal(audits.at(-1)!.action, DOCUMENT_RETENTION_AUDIT_ACTIONS.purged);
    assert.equal((audits.at(-1)!.afterJson as { reason: string }).reason, "Expediente cerrado");
    await expectHttp(() => service.purgeDocument({ context: admin, organizationId: "org_t9", id: "doc_1", body: { reason: "de nuevo" } }), 404, "DOCUMENT_NOT_FOUND");
  });
});

// ---------------------------------------------------------------------------
// Gancho GDPR
// ---------------------------------------------------------------------------

describe("eraseGuestDocuments (executeErasure, §3.4)", () => {
  it("factura del sujeto → pseudonimiza (fichero conservado); carta → purga real; sin huéspedes no hace nada", async () => {
    const db = fakeDb({
      documents: [
        doc({ id: "doc_inv", kind: "invoice", guestId: "guest_1", title: "Factura a Ana Ficticia", searchText: "DOC-T9A-2026-000001 Ana Ficticia 12345678Z ana@example.test" }),
        doc({ id: "doc_letter", kind: "letter", guestId: "guest_1", searchText: "Carta de Ana Ficticia" }),
        doc({ id: "doc_other", kind: "letter", guestId: "guest_2", searchText: "Otra persona" })
      ],
      files: [
        { id: "file_inv", documentId: "doc_inv", storageKind: "disk", storageKey: "org_t9/2026/doc_inv/original.pdf", inline: null },
        { id: "file_letter", documentId: "doc_letter", storageKind: "disk", storageKey: "org_t9/2026/doc_letter/original.pdf", inline: null }
      ],
      pages: [{ id: "page_inv", documentId: "doc_inv", pageNo: 1, textExtracted: "Cliente: Ana Ficticia" }],
      extractions: [{ id: "ext_inv", documentId: "doc_inv", fieldsJson: { customerName: "Ana Ficticia", supplierName: "Demo SL", total: "10.00" }, confidenceJson: {} }]
    });
    const { service, storage, audits } = serviceWith(db);
    assert.deepEqual(await service.eraseGuestDocuments({ organizationId: "org_t9", guestIds: [], subjectValues: ["Ana"] }), { pseudonymized: 0, purged: 0, documentIds: [] });
    const result = await service.eraseGuestDocuments({ organizationId: "org_t9", guestIds: ["guest_1"], subjectValues: ["Ana", "Ficticia", null, "12345678Z", "ana@example.test"], actorUserId: "usr_dpo" });
    assert.equal(result.pseudonymized, 1);
    assert.equal(result.purged, 1);
    assert.deepEqual(result.documentIds, ["doc_inv", "doc_letter"]);
    const invoice = db.documents[0]!;
    assert.equal(invoice.searchText, `DOC-T9A-2026-000001 ${ERASED_PLACEHOLDER} ${ERASED_PLACEHOLDER} ${ERASED_PLACEHOLDER} ${ERASED_PLACEHOLDER}`);
    assert.equal(invoice.title, `Factura a ${ERASED_PLACEHOLDER} ${ERASED_PLACEHOLDER}`);
    assert.equal(invoice.deletedAt, null, "con efecto fiscal se conserva");
    assert.deepEqual(db.extractions[0]!.fieldsJson, { customerName: ERASED_PLACEHOLDER, supplierName: "Demo SL", total: "10.00" });
    assert.equal(db.pages[0]!.textExtracted, `Cliente: ${ERASED_PLACEHOLDER} ${ERASED_PLACEHOLDER}`);
    const letter = db.documents[1]!;
    assert.equal((letter.deletedAt as Date).toISOString(), NOW.toISOString());
    assert.equal(letter.searchText, null);
    assert.deepEqual(storage.deleted, ["org_t9/2026/doc_letter/original.pdf"]);
    assert.equal(db.documents[2]!.searchText, "Otra persona", "otro huésped intacto");
    assert.deepEqual(
      audits.map((audit) => [audit.action, audit.actorUserId]),
      [
        [DOCUMENT_RETENTION_AUDIT_ACTIONS.gdprErased, "usr_dpo"],
        [DOCUMENT_RETENTION_AUDIT_ACTIONS.purged, "usr_dpo"]
      ]
    );
  });
});
