// Documentos · acciones de la oficina (Tanda T9 · lote T9-08; diseño §6.1,
// §6.2 adaptado, §6.3, §7.1-§7.3, §9): assign, review, approve (factura /
// gasto / recepción / tarea / archivo), reject (devolver al centro o cerrar),
// archive desde el centro, tareas con plazo y la decisión autónoma.
//
// Reglas que este fichero hace cumplir:
//   · permisos: documents.review en todas las rutas de la oficina (manifiesto)
//     + la clave de la acción de dominio al aprobar (§6.2 adaptado):
//       create_supplier_bill → payables.create · create_goods_receipt →
//       purchase_orders.receive · create_expense → accounting.journal.post ·
//       create_task / archive → documents.review. La clave que falta se
//       responde con el mismo 403 del gate (PermissionDeniedError, `missing`);
//   · máquina de estados: workflow.service.ts (409 DOCUMENT_STATUS_TRANSITION,
//     DOCUMENT_BLOCKED); tenencia: el documento cuelga del centro de la ruta
//     (404 opaco DOCUMENT_NOT_FOUND);
//   · approve: ningún `check` en fail salvo override.reason (409
//     DOCUMENT_CHECKS_FAILED { failed }); cuerpo de otra acción → 400
//     DOCUMENT_ACTION_INVALID_FOR_KIND; factura y recepción en UNA transacción
//     con la transición del documento (createSupplierBillInTx / writer de
//     T9-09); el gasto lo contabiliza createExpense en su propia transacción
//     (expenses.service.ts no acepta tx) y el documento pasa a posted después;
//   · SoD: quien aprueba el documento es el REGISTRADOR de la factura
//     (SupplierBill.createdByUserId = context.userId): no podrá aprobarla ni
//     pagarla (`sodNote` en el 200);
//   · cierra el AiHumanReviewItem del documento tolerando «ya decidida»
//     (isReviewAlreadyDecided, patrón email-reservation.service.ts);
//   · notificación in-app (tabla notifications, type system) al capturador al
//     devolver al centro y a la persona asignada al crear una tarea con plazo;
//   · auditoría por acción (entityType incoming_document) sin bytes ni claves.
//
// Decisión autónoma (§5.1 «autonomy»): applyAutonomousDecision(documentId) la
// expone para el job de T9-13; aquí NO se llama desde el pipeline. Solo
// archive o create_supplier_bill en borrador (nunca approve / post) y con
// todos los checks ok; deja un AiHumanReviewItem informativo.

import { prisma } from "@hotelos/database";
import type { DocumentAction, IncomingDocument, Prisma } from "@prisma/client";
import {
  DOCUMENT_ACTION_KINDS,
  DOCUMENT_ACTION_STATUSES,
  DOCUMENT_PROPOSED_ACTIONS,
  DOCUMENT_REJECT_REASONS,
  INCOMING_DOCUMENT_KINDS,
  PermissionDeniedError,
  type DocumentActionDto,
  type DocumentApproveResponse,
  type DocumentChecks,
  type DocumentProposal,
  type DocumentProposedAction,
  type IncomingDocumentKind,
  type IncomingDocumentRecord,
  type PermissionKey
} from "@hotelos/shared";
import { z } from "zod";
import type { UserContext } from "../../lib/demo-store.js";
import { HttpError } from "../../lib/http-error.js";
import { createId } from "../../lib/ids.js";
import { loadUserScope, permissionsFor } from "../../lib/rbac-scope.js";
import { approveReview, enqueueReview, rejectReview } from "../ai-operations/human-review.service.js";
import { isReviewAlreadyDecided } from "../ai-operations/tool-runner.service.js";
import { recordAuditEvent } from "../audit/audit.service.js";
import { requirePermissions } from "../auth/auth.service.js";
import { createExpense, type ExpenseDetailDto } from "../payables/expenses.service.js";
import { auditSupplierBillRegistered, createSupplierBillInTx, type SupplierBillDto } from "../payables/supplier-bills.service.js";
import { createSupplier, resolveSupplierTaxId } from "../payables/suppliers.service.js";
import { parseOr400 } from "../rate-manager/rate-grid.schemas.js";
import { isoDaySchema } from "../../schemas/documents.schemas.js";
import { DOCUMENT_AUDIT_ENTITY, documentAuditSummary } from "./documents-audit.js";
import { checksOf, proposalOf, toDocumentActionDto, toIncomingDocumentRecord, type RecordExtras } from "./documents-dto.js";
import { DEFAULT_OFFICE_SLA_BUSINESS_DAYS, dueAtOf, isSlaBreached, requireAnyPermission } from "./documents.service.js";
import { createGoodsReceiptInTx, GOODS_RECEIPT_AUDIT_ACTIONS, GOODS_RECEIPT_AUDIT_ENTITY, type CreateGoodsReceiptInTxInput } from "./goods-receipts.service.js";
import { proposeDocumentAction } from "./pipeline.service.js";
import { dueAtFor, retentionKindOf, retentionUntilFor, type DeadlineKind, type RetentionSettings } from "./retention-rules.js";
import { approveActionOf, assertTransition, assertWorkflowAllowed, rejectActionOf, transitionDocument, type DocumentWorkflowAction } from "./workflow.service.js";

type Db = typeof prisma;
type Tx = Prisma.TransactionClient;

// ---------------------------------------------------------------------------
// Constantes y esquemas (zod .strict(), catálogos de documents-types.ts)
// ---------------------------------------------------------------------------

export const DOCUMENT_ACTIONS_AUDIT = Object.freeze({
  assigned: "DOCUMENT_ASSIGNED",
  reviewed: "DOCUMENT_REVIEWED",
  approved: "DOCUMENT_APPROVED",
  rejected: "DOCUMENT_REJECTED",
  archived: "DOCUMENT_ARCHIVED",
  actionCreated: "DOCUMENT_ACTION_CREATED",
  actionUpdated: "DOCUMENT_ACTION_UPDATED",
  autonomous: "DOCUMENT_AUTONOMOUS_DECISION"
} as const);

/** Clave extra por acción de dominio (§6.2 adaptado); null = solo documents.review. */
export const ACTION_EXTRA_PERMISSION: Readonly<Record<DocumentProposedAction, PermissionKey | null>> = Object.freeze({
  create_supplier_bill: "payables.create",
  create_expense: "accounting.journal.post",
  create_goods_receipt: "purchase_orders.receive",
  create_task: null,
  archive: null
});

export const REVIEW_PERMISSION: PermissionKey = "documents.review";
export const CAPTURE_PERMISSION: PermissionKey = "documents.capture";

/** Motivos que devuelven al centro / cierran (§6.1). */
export const RETURN_TO_CENTRE_REASONS: ReadonlySet<string> = new Set(["illegible", "missing_pages", "other"]);
export const FINAL_REJECT_REASONS: ReadonlySet<string> = new Set(["duplicate", "not_ours", "other"]);

/** Tipos que el centro puede archivar directamente desde captured (§6.1). */
export const CENTRE_ARCHIVABLE_KINDS: ReadonlySet<IncomingDocumentKind> = new Set<IncomingDocumentKind>(["letter", "contract", "other"]);

const NOTE_MAX = 2000;
const idSchema = z.string().trim().min(1).max(64);
const noteSchema = z.string().trim().max(NOTE_MAX).optional();
const kindSchema = z.enum(INCOMING_DOCUMENT_KINDS, { errorMap: () => ({ message: `kind debe ser uno de: ${INCOMING_DOCUMENT_KINDS.join(", ")}.` }) });
const bodyRecordSchema = z.record(z.unknown());

export const DocumentAssignRequestSchema = z.object({ assignedTo: idSchema.nullable().optional() }).strict();
export const DocumentReviewRequestSchema = z.object({ reviewedFields: bodyRecordSchema, kind: kindSchema.optional(), note: noteSchema }).strict();
export const DocumentActionRequestSchema = z
  .object({
    kind: z.enum(DOCUMENT_ACTION_KINDS, { errorMap: () => ({ message: `kind debe ser uno de: ${DOCUMENT_ACTION_KINDS.join(", ")}.` }) }),
    title: z.string().trim().min(1, { message: "title no puede estar vacío." }).max(200),
    description: z.string().trim().max(NOTE_MAX).optional(),
    assignedTo: idSchema.nullable().optional(),
    dueAt: z.string().datetime({ offset: true, message: "dueAt debe ser una fecha ISO-8601." }).nullable().optional()
  })
  .strict();
export const DocumentActionPatchRequestSchema = z
  .object({ status: z.enum(DOCUMENT_ACTION_STATUSES, { errorMap: () => ({ message: `status debe ser uno de: ${DOCUMENT_ACTION_STATUSES.join(", ")}.` }) }), outcomeNote: noteSchema })
  .strict();
export const DocumentApproveRequestSchema = z
  .object({
    action: z.enum(DOCUMENT_PROPOSED_ACTIONS, { errorMap: () => ({ message: `action debe ser uno de: ${DOCUMENT_PROPOSED_ACTIONS.join(", ")}.` }) }),
    supplierBill: bodyRecordSchema.optional(),
    expense: bodyRecordSchema.optional(),
    goodsReceipt: bodyRecordSchema.optional(),
    task: DocumentActionRequestSchema.optional(),
    override: z.object({ reason: z.string().trim().min(3, { message: "override.reason debe explicar por qué se aprueba con comprobaciones en fallo." }).max(500) }).strict().optional()
  })
  .strict();
export const DocumentRejectRequestSchema = z
  .object({
    reason: z.enum(DOCUMENT_REJECT_REASONS, { errorMap: () => ({ message: `reason debe ser uno de: ${DOCUMENT_REJECT_REASONS.join(", ")}.` }) }),
    note: noteSchema,
    returnToCentre: z.boolean().optional(),
    duplicateOfId: idSchema.optional()
  })
  .strict()
  .superRefine((value, ctx) => {
    const allowed = value.returnToCentre ? RETURN_TO_CENTRE_REASONS : FINAL_REJECT_REASONS;
    if (!allowed.has(value.reason)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["reason"], message: value.returnToCentre ? "devolver al centro admite illegible, missing_pages u other." : "rechazar admite duplicate, not_ours u other." });
    }
  });
export const DocumentArchiveRequestSchema = z.object({ retentionUntil: isoDaySchema.optional(), extendedRetention: z.boolean().optional(), legalHold: z.boolean().optional() }).strict();

export type DocumentApproveInput = z.output<typeof DocumentApproveRequestSchema>;
export type DocumentRejectInput = z.output<typeof DocumentRejectRequestSchema>;
export type DocumentActionInput = z.output<typeof DocumentActionRequestSchema>;

// ---------------------------------------------------------------------------
// Funciones puras (exportadas para los unit tests)
// ---------------------------------------------------------------------------

function typed(statusCode: number, code: string, message: string, extra: Record<string, unknown> = {}): HttpError {
  return new HttpError(statusCode, message, true, { code, ...extra });
}

function notFoundDocument(): HttpError {
  return typed(404, "DOCUMENT_NOT_FOUND", "Documento no encontrado.");
}

type PermissionContext = Pick<UserContext, "permissions" | "isPlatformAdmin">;

/** Clave extra de la acción (§6.2 adaptado) o null. */
export function extraPermissionFor(action: DocumentProposedAction): PermissionKey | null {
  return ACTION_EXTRA_PERMISSION[action];
}

/** documents.review + la clave de la acción; la que falta sale en `missing` (403 del gate). */
export function assertApprovePermissions(context: PermissionContext, action: DocumentProposedAction): void {
  if (context.isPlatformAdmin === true) return;
  const missing: PermissionKey[] = [];
  if (!context.permissions.includes(REVIEW_PERMISSION)) missing.push(REVIEW_PERMISSION);
  const extra = extraPermissionFor(action);
  if (extra && !context.permissions.includes(extra)) missing.push(extra);
  if (missing.length > 0) throw new PermissionDeniedError(missing);
}

/** Claves de checksJson en fail. */
export function failedChecks(checks: DocumentChecks | null): string[] {
  if (!checks) return [];
  return Object.entries(checks)
    .filter(([, check]) => check && typeof check === "object" && (check as { status?: string }).status === "fail")
    .map(([key]) => key);
}

/** Ningún check en fail salvo override.reason explícito (auditado) → 409 DOCUMENT_CHECKS_FAILED { failed }. */
export function assertChecksPass(checks: DocumentChecks | null, override: { reason: string } | undefined): string[] {
  const failed = failedChecks(checks);
  if (failed.length === 0) return failed;
  if (override?.reason) return failed;
  throw typed(409, "DOCUMENT_CHECKS_FAILED", `Hay comprobaciones en fallo (${failed.join(", ")}): corrígelas o aprueba con override.reason.`, { failed });
}

/** Cuerpo de otra acción → 400 DOCUMENT_ACTION_INVALID_FOR_KIND (§9). */
export function assertBodyMatchesAction(body: DocumentApproveInput): void {
  const bodies: Array<[keyof DocumentApproveInput, DocumentProposedAction]> = [
    ["supplierBill", "create_supplier_bill"],
    ["expense", "create_expense"],
    ["goodsReceipt", "create_goods_receipt"],
    ["task", "create_task"]
  ];
  for (const [key, action] of bodies) {
    if (body[key] !== undefined && body.action !== action) {
      throw typed(400, "DOCUMENT_ACTION_INVALID_FOR_KIND", `El cuerpo «${key}» no corresponde a la acción «${body.action}».`, { action: body.action, body: key });
    }
  }
}

/** Tipo del documento → tipo de retención: vive en retention-rules.ts (puro; lo usan también payables y split-merge). */
export { retentionKindOf };

/** Plazo legal derivado del tipo (§3.5) para las tareas sin dueAt explícito. */
export function taskDeadlineKindOf(kind: IncomingDocumentKind): DeadlineKind | null {
  if (kind === "administrative_notice") return "administrative_notice";
  if (kind === "e_invoice_status") return "e_invoice";
  return null;
}

function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

type DocumentForBody = Pick<IncomingDocument, "id" | "source" | "capturedAt" | "documentDate">;

/**
 * Cuerpo efectivo de la factura: el revisado (body) o el propuesto (proposal)
 * con los campos que fija el servidor: incomingDocumentId, source (digitized |
 * e_invoice), documentObjectKey = clave del original y receptionDate = captura.
 */
export function buildSupplierBillBody(input: { document: DocumentForBody; proposal: DocumentProposal | null; body: Record<string, unknown> | undefined; storageKey: string | null }): Record<string, unknown> {
  const base = { ...((input.body ?? input.proposal?.supplierBill ?? {}) as Record<string, unknown>) };
  delete base.attachment;
  return {
    ...base,
    incomingDocumentId: input.document.id,
    source: input.document.source === "e_invoice" ? "e_invoice" : "digitized",
    documentObjectKey: input.storageKey ?? (typeof base.documentObjectKey === "string" ? base.documentObjectKey : null),
    receptionDate: typeof base.receptionDate === "string" && base.receptionDate ? base.receptionDate : isoDay(input.document.capturedAt)
  };
}

/** Cuerpo efectivo del gasto: fecha por defecto, recibo = clave del original y vatDeductible:false sin NIF (§7.1). */
export function buildExpenseBody(input: { document: DocumentForBody; proposal: DocumentProposal | null; body: Record<string, unknown> | undefined; storageKey: string | null }): Record<string, unknown> {
  const base = { ...((input.body ?? input.proposal?.expense ?? {}) as Record<string, unknown>) };
  delete base.attachment;
  const supplierNif = typeof base.supplierNif === "string" && base.supplierNif.trim().length > 0 ? base.supplierNif : null;
  const out: Record<string, unknown> = {
    ...base,
    date: typeof base.date === "string" && base.date ? base.date : isoDay(input.document.documentDate ?? input.document.capturedAt),
    receiptObjectKey: input.storageKey ?? (typeof base.receiptObjectKey === "string" ? base.receiptObjectKey : null)
  };
  if (!supplierNif) out.vatDeductible = false;
  if (out.paidWith === null) delete out.paidWith;
  return out;
}

// ---------------------------------------------------------------------------
// Recepciones (T9-09): createGoodsReceiptInTx(tx, input) de goods-receipts.service.ts
// ---------------------------------------------------------------------------

/** Escritor de recepciones dentro de la transacción del approve (contrato de T9-09; sustituible en tests). */
export type GoodsReceiptWriter = (tx: Tx, input: CreateGoodsReceiptInTxInput) => Promise<{ id: string } & Record<string, unknown>>;

let goodsReceiptWriter: GoodsReceiptWriter = createGoodsReceiptInTx;

/** Tests: fija el escritor de recepciones (null restaura createGoodsReceiptInTx). */
export function setGoodsReceiptWriter(writer: GoodsReceiptWriter | null): void {
  goodsReceiptWriter = writer ?? createGoodsReceiptInTx;
}

// ---------------------------------------------------------------------------
// Servicio
// ---------------------------------------------------------------------------

export type DocumentActionsDeps = {
  db?: Db;
  now?: () => Date;
  /** Recalcula checks y propuesta tras `review` (por defecto proposeDocumentAction de T9-06a). */
  propose?: typeof proposeDocumentAction;
};

type ActorInput = { context: UserContext; correlationId: string; ipAddress?: string };
export type DocumentActionByIdInput = ActorInput & { propertyId: string; id: string; body?: unknown };

export type DocumentApproveResult = DocumentApproveResponse & {
  supplierBill?: SupplierBillDto;
  expense?: ExpenseDetailDto;
  goodsReceipt?: Record<string, unknown>;
  action?: DocumentActionDto;
  /** SoD: quien aprueba el documento queda como registrador de la factura (no podrá aprobarla ni pagarla). */
  sodNote?: string;
  /** Comprobaciones en fallo aprobadas con override.reason. */
  overriddenChecks?: string[];
  /** Proveedor dado de alta en la misma petición (supplierProposal). */
  createdSupplierId?: string;
};

export type RejectDocumentResult = { document: IncomingDocumentRecord; notifiedUserId: string | null };
export type ArchiveDocumentResult = { document: IncomingDocumentRecord };
export type AutonomousDecisionResult = { applied: boolean; reason: string; action?: DocumentProposedAction; document?: IncomingDocumentRecord; supplierBillId?: string };

type PropertyRow = { id: string; code: string | null; organizationId: string; legalEntityId: string | null; kind: string };

export function createDocumentActionsService(deps: DocumentActionsDeps = {}) {
  const db: Db = deps.db ?? prisma;
  const now = deps.now ?? (() => new Date());
  const propose = deps.propose ?? proposeDocumentAction;

  // ── helpers ─────────────────────────────────────────────────────────────

  async function requireProperty(context: UserContext, propertyId: string): Promise<PropertyRow> {
    const property = await db.property.findUnique({ where: { id: propertyId }, select: { id: true, code: true, organizationId: true, legalEntityId: true, kind: true } });
    if (!property) throw typed(404, "PROPERTY_NOT_FOUND", "Propiedad no encontrada.");
    if (property.organizationId !== context.organizationId && context.isPlatformAdmin !== true) throw typed(404, "PROPERTY_NOT_FOUND", "Propiedad no encontrada.");
    return property;
  }

  async function requireDocument(propertyId: string, documentId: string): Promise<IncomingDocument> {
    const row = await db.incomingDocument.findFirst({ where: { id: documentId, propertyId, deletedAt: null } });
    if (!row) throw notFoundDocument();
    return row;
  }

  async function officeSla(organizationId: string): Promise<number> {
    const settings = await db.documentSettings.findUnique({ where: { organizationId }, select: { officeSlaBusinessDays: true } });
    return settings?.officeSlaBusinessDays ?? DEFAULT_OFFICE_SLA_BUSINESS_DAYS;
  }

  async function retentionSettings(organizationId: string): Promise<RetentionSettings | null> {
    const settings = await db.documentSettings.findUnique({ where: { organizationId }, select: { retentionYearsDefault: true, letterRetentionYears: true, extendedRetentionYears: true } });
    if (!settings) return null;
    return { retentionYears: settings.retentionYearsDefault, letterRetentionYears: settings.letterRetentionYears, extendedRetentionYears: settings.extendedRetentionYears };
  }

  async function toRecord(row: IncomingDocument): Promise<IncomingDocumentRecord> {
    const [sla, actions, supplier] = await Promise.all([
      officeSla(row.organizationId),
      db.documentAction.findMany({ where: { documentId: row.id, status: "open" }, select: { dueAt: true } }),
      row.supplierId ? db.supplier.findUnique({ where: { id: row.supplierId }, select: { name: true } }) : Promise.resolve(null)
    ]);
    const extras: RecordExtras = { supplierName: supplier?.name ?? null, dueAt: dueAtOf(row, actions.map((action) => action.dueAt)), slaBreached: isSlaBreached(row, sla, now()) };
    return toIncomingDocumentRecord(row, extras);
  }

  async function originalStorageKey(documentId: string): Promise<string | null> {
    const file = await db.documentFile.findFirst({ where: { documentId, role: "original" }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], select: { storageKey: true } });
    return file?.storageKey ?? null;
  }

  function audit(input: { action: string; context: Pick<UserContext, "userId" | "deviceId">; row: IncomingDocument; correlationId: string; ipAddress?: string; actorType?: "user" | "ai" | "system"; beforeJson?: Record<string, unknown>; afterJson?: Record<string, unknown> }): void {
    recordAuditEvent({
      organizationId: input.row.organizationId,
      propertyId: input.row.propertyId,
      ...(input.context.userId ? { actorUserId: input.context.userId } : {}),
      actorType: input.actorType ?? "user",
      action: input.action,
      entityType: DOCUMENT_AUDIT_ENTITY,
      entityId: input.row.id,
      ...(input.beforeJson ? { beforeJson: input.beforeJson } : {}),
      ...(input.afterJson ? { afterJson: input.afterJson } : {}),
      ...(input.ipAddress ? { ipAddress: input.ipAddress } : {}),
      ...(input.context.deviceId ? { deviceId: input.context.deviceId } : {}),
      correlationId: input.correlationId
    });
  }

  async function notify(tx: Tx | Db, input: { organizationId: string; propertyId: string; userId: string; title: string; body: string }): Promise<void> {
    await tx.notification.create({ data: { organizationId: input.organizationId, propertyId: input.propertyId, userId: input.userId, type: "system", title: input.title, body: input.body, status: "unread" } });
  }

  async function assertUserInOrganization(organizationId: string, userId: string): Promise<void> {
    const user = await db.user.findFirst({ where: { id: userId, organizationId }, select: { id: true } });
    if (!user) throw typed(400, "VALIDATION_ERROR", "assignedTo no es una persona de esta organización.", { assignedTo: userId });
  }

  /** RV-13: solo se asigna la revisión a quien puede revisar en el centro del documento (documents.review por sus asignaciones). */
  async function assertCanReviewInProperty(organizationId: string, propertyId: string, userId: string): Promise<void> {
    const scope = await loadUserScope(userId, organizationId, db);
    if (!permissionsFor(scope, propertyId).includes(REVIEW_PERMISSION)) {
      throw typed(400, "VALIDATION_ERROR", "assignedTo no tiene permiso de revisión de documentos (documents.review) en este centro.", { assignedTo: userId, propertyId, missing: [REVIEW_PERMISSION] });
    }
  }

  /** Cierra el AiHumanReviewItem del documento tolerando «ya decidida». */
  async function closeReview(row: IncomingDocument, decision: "approved" | "rejected", context: UserContext, notes: string, correlationId: string): Promise<void> {
    if (!row.reviewItemId) return;
    try {
      if (decision === "approved") await approveReview({ context, id: row.reviewItemId, userId: context.userId, notes, correlationId });
      else await rejectReview({ context, id: row.reviewItemId, userId: context.userId, reason: notes, correlationId });
    } catch (error) {
      if (!isReviewAlreadyDecided(error)) throw error;
      console.warn("[documents.actions] review already decided; document decided anyway", { reviewItemId: row.reviewItemId, documentId: row.id, decision, correlationId });
    }
  }

  function archiveData(row: IncomingDocument, at: Date, settings: RetentionSettings | null, options: { extendedRetention?: boolean; legalHold?: boolean; retentionUntil?: Date | null } = {}): Prisma.IncomingDocumentUpdateManyMutationInput {
    const extendedRetention = options.extendedRetention ?? row.extendedRetention;
    const retentionUntil = options.retentionUntil ?? retentionUntilFor({ kind: retentionKindOf(row.kind), documentDate: row.documentDate ?? row.capturedAt, extendedRetention, personalData: row.guestId !== null, settings });
    return { archivedAt: at, retentionUntil, extendedRetention, legalHold: options.legalHold ?? row.legalHold };
  }

  /** §3.2 / §7.5: un documento contabilizado (gasto, recepción) recibe su retentionUntil al pasar a posted, como la factura (postSupplierBill). */
  function postedData(row: IncomingDocument, settings: RetentionSettings | null): Prisma.IncomingDocumentUpdateManyMutationInput {
    return { retentionUntil: retentionUntilFor({ kind: retentionKindOf(row.kind), documentDate: row.documentDate ?? row.capturedAt, extendedRetention: row.extendedRetention, personalData: row.guestId !== null, settings }) };
  }

  function rejectedRetention(row: IncomingDocument, settings: RetentionSettings | null): Date {
    return retentionUntilFor({ kind: retentionKindOf(row.kind), documentDate: row.documentDate ?? row.capturedAt, status: "rejected", settings });
  }

  /**
   * Proveedor de la factura: existente por NIF en la organización que aprueba, o
   * alta en la misma petición cuando la propuesta lo sugiere (supplierProposal).
   */
  async function resolveSupplier(context: UserContext, organizationId: string, bill: Record<string, unknown>, proposal: DocumentProposal | null, correlationId: string): Promise<{ bill: Record<string, unknown>; createdSupplierId: string | null }> {
    if (typeof bill.supplierId === "string" && bill.supplierId) return { bill, createdSupplierId: null };
    const rawTaxId = typeof bill.supplierTaxId === "string" && bill.supplierTaxId.trim() ? bill.supplierTaxId : (proposal?.supplierProposal?.taxId ?? null);
    if (!rawTaxId) return { bill, createdSupplierId: null };
    const taxId = resolveSupplierTaxId(rawTaxId, "ES").taxId;
    if (!taxId) return { bill, createdSupplierId: null };
    const existing = await db.supplier.findFirst({ where: { organizationId, taxId }, orderBy: { createdAt: "asc" }, select: { id: true } });
    if (existing) return { bill: { ...bill, supplierId: existing.id }, createdSupplierId: null };
    if (!proposal?.supplierProposal) return { bill, createdSupplierId: null };
    const name = typeof bill.supplierName === "string" && bill.supplierName.trim() ? bill.supplierName.trim() : proposal.supplierProposal.name;
    const created = await createSupplier({ context, organizationId, body: { name, taxId, countryCode: "ES" }, correlationId });
    return { bill: { ...bill, supplierId: created.id }, createdSupplierId: created.id };
  }

  // ── assign / review ─────────────────────────────────────────────────────

  async function assignDocument(input: DocumentActionByIdInput): Promise<IncomingDocumentRecord> {
    requirePermissions(input.context, [REVIEW_PERMISSION]);
    const body = parseOr400(DocumentAssignRequestSchema, input.body ?? {}, "Asignación");
    await requireProperty(input.context, input.propertyId);
    const row = await requireDocument(input.propertyId, input.id);
    const assignedTo = body.assignedTo === undefined ? input.context.userId : body.assignedTo;
    if (assignedTo) {
      await assertUserInOrganization(row.organizationId, assignedTo);
      if (assignedTo !== input.context.userId) await assertCanReviewInProperty(row.organizationId, row.propertyId, assignedTo);
    }
    const at = now();
    const updated = await db.$transaction((tx) => transitionDocument(tx, row, "assign", { assignedTo, reviewStartedAt: row.reviewStartedAt ?? at }));
    audit({ action: DOCUMENT_ACTIONS_AUDIT.assigned, context: input.context, row: updated, correlationId: input.correlationId, ...(input.ipAddress ? { ipAddress: input.ipAddress } : {}), beforeJson: { status: row.status, assignedTo: row.assignedTo }, afterJson: { ...documentAuditSummary(updated), assignedTo } });
    return toRecord(updated);
  }

  async function reviewDocument(input: DocumentActionByIdInput): Promise<IncomingDocumentRecord> {
    requirePermissions(input.context, [REVIEW_PERMISSION]);
    const body = parseOr400(DocumentReviewRequestSchema, input.body ?? {}, "Revisión");
    await requireProperty(input.context, input.propertyId);
    const row = await requireDocument(input.propertyId, input.id);
    const at = now();
    const previous = (row.reviewedFieldsJson && typeof row.reviewedFieldsJson === "object" && !Array.isArray(row.reviewedFieldsJson) ? row.reviewedFieldsJson : {}) as Record<string, unknown>;
    const reviewedFields = { ...previous, ...body.reviewedFields };
    const updated = await db.$transaction((tx) =>
      transitionDocument(tx, row, "review", {
        reviewedFieldsJson: JSON.parse(JSON.stringify(reviewedFields)) as Prisma.InputJsonObject,
        ...(body.kind ? { kind: body.kind, kindConfidence: null, classificationSource: "manual" } : {}),
        assignedTo: row.assignedTo ?? input.context.userId,
        reviewStartedAt: row.reviewStartedAt ?? at
      })
    );
    // Los campos revisados prevalecen: se recalculan comprobaciones y propuesta (best-effort, la revisión ya está guardada).
    let reproposed = false;
    try {
      await propose({ documentId: updated.id, organizationId: updated.organizationId, propertyId: updated.propertyId, correlationId: input.correlationId, userId: input.context.userId, persist: true });
      reproposed = true;
    } catch (error) {
      console.warn("[documents.actions] no se pudo recalcular la propuesta tras la revisión", { documentId: updated.id, correlationId: input.correlationId, error: error instanceof Error ? error.message : String(error) });
    }
    const fresh = reproposed ? await db.incomingDocument.findUnique({ where: { id: updated.id } }) : null;
    const final = fresh ?? updated;
    audit({
      action: DOCUMENT_ACTIONS_AUDIT.reviewed,
      context: input.context,
      row: final,
      correlationId: input.correlationId,
      ...(input.ipAddress ? { ipAddress: input.ipAddress } : {}),
      beforeJson: { status: row.status, kind: row.kind },
      afterJson: { ...documentAuditSummary(final), reviewedKeys: Object.keys(body.reviewedFields), reproposed, ...(body.note ? { note: body.note } : {}) }
    });
    return toRecord(final);
  }

  // ── approve ─────────────────────────────────────────────────────────────

  async function approveDocument(input: DocumentActionByIdInput): Promise<DocumentApproveResult> {
    requirePermissions(input.context, [REVIEW_PERMISSION]);
    const body = parseOr400(DocumentApproveRequestSchema, input.body ?? {}, "Aprobación");
    assertApprovePermissions(input.context, body.action);
    assertBodyMatchesAction(body);
    const property = await requireProperty(input.context, input.propertyId);
    const row = await requireDocument(input.propertyId, input.id);
    const workflowAction = approveActionOf(body.action);
    assertWorkflowAllowed(row, workflowAction);
    assertTransition(row.status, workflowAction);
    const overridden = assertChecksPass(checksOf(row.checksJson), body.override);
    const proposal = proposalOf(row);
    const storageKey = await originalStorageKey(row.id);
    const settings = await retentionSettings(row.organizationId);
    const at = now();
    const decided = { decidedBy: input.context.userId, decidedAt: at };
    const result: Omit<DocumentApproveResult, "document"> = {};
    let updated: IncomingDocument;

    switch (body.action) {
      case "create_supplier_bill": {
        const built = buildSupplierBillBody({ document: row, proposal, body: body.supplierBill, storageKey });
        const resolved = await resolveSupplier(input.context, property.organizationId, built, proposal, input.correlationId);
        const outcome = await db.$transaction(async (tx) => {
          const bill = await createSupplierBillInTx(tx, { context: input.context, propertyId: row.propertyId, organizationId: property.organizationId, body: resolved.bill, origin: "documents" });
          const doc = await transitionDocument(tx, row, workflowAction, {
            ...decided,
            supplierBillId: bill.id,
            supplierId: bill.supplierId ?? row.supplierId,
            supplierTaxId: bill.supplierTaxId ?? row.supplierTaxId,
            documentNumber: bill.invoiceNumber ?? row.documentNumber,
            documentDate: bill.issueDate ? new Date(`${bill.issueDate}T00:00:00.000Z`) : row.documentDate,
            totalAmount: bill.total
          });
          return { bill, doc };
        });
        updated = outcome.doc;
        auditSupplierBillRegistered(outcome.bill, { context: input.context, propertyId: row.propertyId, correlationId: input.correlationId, extra: { registryNumber: row.registryNumber } });
        result.supplierBillId = outcome.bill.id;
        result.supplierBill = outcome.bill;
        result.sodNote = "Quien aprueba el documento queda como registrador de la factura (separación de funciones): otra persona con payables.approve debe aprobarla y una tercera pagarla.";
        if (resolved.createdSupplierId) result.createdSupplierId = resolved.createdSupplierId;
        break;
      }
      case "create_expense": {
        const expenseBody = buildExpenseBody({ document: row, proposal, body: body.expense, storageKey });
        // createExpense contabiliza en su propia transacción (expenses.service.ts:266, sin tx): la transición del documento va después.
        const expense = await createExpense({ context: input.context, propertyId: row.propertyId, body: expenseBody, correlationId: input.correlationId });
        const expenseDate = expense.date ? new Date(`${expense.date}T00:00:00.000Z`) : row.documentDate;
        updated = await db.$transaction((tx) => transitionDocument(tx, row, workflowAction, { ...decided, expenseId: expense.id, postedAt: at, totalAmount: expense.total, documentDate: expenseDate, ...postedData({ ...row, documentDate: expenseDate }, settings) }));
        result.expenseId = expense.id;
        result.expense = expense;
        break;
      }
      case "create_goods_receipt": {
        const receiptBody = body.goodsReceipt ?? (proposal?.goodsReceipt as Record<string, unknown> | undefined) ?? {};
        const outcome = await db.$transaction(async (tx) => {
          const receipt = await goodsReceiptWriter(tx, { organizationId: property.organizationId, propertyId: row.propertyId, receivedBy: input.context.userId, incomingDocumentId: row.id, body: receiptBody });
          const doc = await transitionDocument(tx, row, workflowAction, { ...decided, goodsReceiptId: receipt.id, postedAt: at, ...postedData(row, settings) });
          return { receipt, doc };
        });
        updated = outcome.doc;
        // T9-09 no audita dentro de la transacción: lo hace el llamante.
        recordAuditEvent({
          organizationId: row.organizationId,
          propertyId: row.propertyId,
          actorUserId: input.context.userId,
          actorType: "user",
          action: GOODS_RECEIPT_AUDIT_ACTIONS.created,
          entityType: GOODS_RECEIPT_AUDIT_ENTITY,
          entityId: outcome.receipt.id,
          afterJson: { incomingDocumentId: row.id, registryNumber: row.registryNumber, deliveryNoteNumber: outcome.receipt.deliveryNoteNumber ?? null, status: outcome.receipt.status ?? null },
          correlationId: input.correlationId
        });
        result.goodsReceiptId = outcome.receipt.id;
        result.goodsReceipt = outcome.receipt;
        break;
      }
      case "create_task": {
        const task = body.task ?? (proposal?.task as DocumentActionInput | undefined);
        if (!task) throw typed(400, "VALIDATION_ERROR", "create_task necesita el cuerpo «task» (o una propuesta de tarea).");
        const parsedTask = parseOr400(DocumentActionRequestSchema, task, "Tarea");
        const outcome = await db.$transaction(async (tx) => {
          const action = await createActionRow(tx, row, parsedTask, input.context.userId);
          const doc = await transitionDocument(tx, row, workflowAction, { ...decided, ...archiveData(row, at, settings) });
          return { action, doc };
        });
        updated = outcome.doc;
        result.actionId = outcome.action.id;
        result.action = toDocumentActionDto(outcome.action);
        break;
      }
      case "archive": {
        updated = await db.$transaction((tx) => transitionDocument(tx, row, workflowAction, { ...decided, ...archiveData(row, at, settings) }));
        break;
      }
      default:
        throw typed(400, "DOCUMENT_ACTION_INVALID_FOR_KIND", `Acción no admitida: ${String(body.action)}.`);
    }

    await closeReview(updated, "approved", input.context, `Aprobado: ${body.action}`, input.correlationId);
    audit({
      action: DOCUMENT_ACTIONS_AUDIT.approved,
      context: input.context,
      row: updated,
      correlationId: input.correlationId,
      ...(input.ipAddress ? { ipAddress: input.ipAddress } : {}),
      beforeJson: { status: row.status },
      afterJson: {
        ...documentAuditSummary(updated),
        action: body.action,
        entity: { supplierBillId: result.supplierBillId ?? null, expenseId: result.expenseId ?? null, goodsReceiptId: result.goodsReceiptId ?? null, actionId: result.actionId ?? null },
        ...(result.createdSupplierId ? { createdSupplierId: result.createdSupplierId } : {}),
        ...(overridden.length > 0 ? { overriddenChecks: overridden, overrideReason: body.override?.reason ?? null } : {})
      }
    });
    if (overridden.length > 0) result.overriddenChecks = overridden;
    return { ...result, document: await toRecord(updated) };
  }

  // ── reject ──────────────────────────────────────────────────────────────

  async function rejectDocument(input: DocumentActionByIdInput): Promise<RejectDocumentResult> {
    requirePermissions(input.context, [REVIEW_PERMISSION]);
    const body = parseOr400(DocumentRejectRequestSchema, input.body ?? {}, "Rechazo");
    await requireProperty(input.context, input.propertyId);
    const row = await requireDocument(input.propertyId, input.id);
    const returnToCentre = body.returnToCentre === true;
    const workflowAction = rejectActionOf(returnToCentre);
    assertWorkflowAllowed(row, workflowAction);
    assertTransition(row.status, workflowAction);
    let duplicateOf: { id: string; registryNumber: string } | null = null;
    if (body.reason === "duplicate" && body.duplicateOfId) {
      duplicateOf = await db.incomingDocument.findFirst({ where: { id: body.duplicateOfId, organizationId: row.organizationId, deletedAt: null }, select: { id: true, registryNumber: true } });
      if (!duplicateOf) throw typed(400, "VALIDATION_ERROR", "duplicateOfId no es un documento de esta organización.", { duplicateOfId: body.duplicateOfId });
    }
    const settings = returnToCentre ? null : await retentionSettings(row.organizationId);
    const at = now();
    const note = body.note ?? (duplicateOf ? `Duplicado de ${duplicateOf.registryNumber}` : null);
    const outcome = await db.$transaction(async (tx) => {
      const doc = await transitionDocument(tx, row, workflowAction, {
        rejectReason: body.reason,
        rejectNote: note,
        decidedBy: input.context.userId,
        decidedAt: at,
        ...(returnToCentre ? {} : { retentionUntil: rejectedRetention(row, settings) })
      });
      let notifiedUserId: string | null = null;
      if (returnToCentre && row.capturedBy) {
        await notify(tx, {
          organizationId: row.organizationId,
          propertyId: row.propertyId,
          userId: row.capturedBy,
          title: `Documento ${row.registryNumber} devuelto al centro`,
          body: `La oficina devuelve el documento ${row.registryNumber} (${body.reason})${body.note ? `: ${body.note}` : ""}. Vuelve a capturarlo con un fichero nuevo.`
        });
        notifiedUserId = row.capturedBy;
      }
      return { doc, notifiedUserId };
    });
    await closeReview(outcome.doc, "rejected", input.context, `Rechazado: ${body.reason}${returnToCentre ? " (devuelto al centro)" : ""}`, input.correlationId);
    audit({
      action: DOCUMENT_ACTIONS_AUDIT.rejected,
      context: input.context,
      row: outcome.doc,
      correlationId: input.correlationId,
      ...(input.ipAddress ? { ipAddress: input.ipAddress } : {}),
      beforeJson: { status: row.status },
      afterJson: { ...documentAuditSummary(outcome.doc), reason: body.reason, returnToCentre, note, duplicateOfId: duplicateOf?.id ?? null, notifiedUserId: outcome.notifiedUserId }
    });
    return { document: await toRecord(outcome.doc), notifiedUserId: outcome.notifiedUserId };
  }

  // ── archive (centro: captured → archived · returned_to_centre → rejected) ──

  async function archiveDocument(input: DocumentActionByIdInput): Promise<ArchiveDocumentResult> {
    requirePermissions(input.context, [REVIEW_PERMISSION]);
    const body = parseOr400(DocumentArchiveRequestSchema, input.body ?? {}, "Archivo");
    await requireProperty(input.context, input.propertyId);
    const row = await requireDocument(input.propertyId, input.id);
    assertWorkflowAllowed(row, "archive");
    const to = assertTransition(row.status, "archive");
    if (row.status === "captured" && !CENTRE_ARCHIVABLE_KINDS.has(row.kind)) {
      throw typed(400, "DOCUMENT_ACTION_INVALID_FOR_KIND", `Desde el centro solo se archivan cartas, contratos y otros documentos sin efecto fiscal (tipo actual: ${row.kind}); envíalo a la oficina.`, { kind: row.kind, allowed: [...CENTRE_ARCHIVABLE_KINDS] });
    }
    const settings = await retentionSettings(row.organizationId);
    const at = now();
    const data: Prisma.IncomingDocumentUpdateManyMutationInput =
      to === "archived"
        ? { decidedBy: input.context.userId, decidedAt: at, ...archiveData(row, at, settings, { ...(body.extendedRetention !== undefined ? { extendedRetention: body.extendedRetention } : {}), ...(body.legalHold !== undefined ? { legalHold: body.legalHold } : {}), retentionUntil: body.retentionUntil ? new Date(`${body.retentionUntil}T00:00:00.000Z`) : null }) }
        : { decidedBy: input.context.userId, decidedAt: at, rejectReason: "other", rejectNote: "No procede (archivado desde el centro).", retentionUntil: rejectedRetention(row, settings) };
    const updated = await db.$transaction((tx) => transitionDocument(tx, row, "archive", data));
    if (to === "rejected") await closeReview(updated, "rejected", input.context, "No procede (archivado desde el centro)", input.correlationId);
    audit({
      action: DOCUMENT_ACTIONS_AUDIT.archived,
      context: input.context,
      row: updated,
      correlationId: input.correlationId,
      ...(input.ipAddress ? { ipAddress: input.ipAddress } : {}),
      beforeJson: { status: row.status },
      afterJson: { ...documentAuditSummary(updated), retentionUntil: updated.retentionUntil ? isoDay(updated.retentionUntil) : null, extendedRetention: updated.extendedRetention, legalHold: updated.legalHold }
    });
    return { document: await toRecord(updated) };
  }

  // ── tareas con plazo (§7.3) ─────────────────────────────────────────────

  async function createActionRow(tx: Tx, row: IncomingDocument, task: DocumentActionInput, createdBy: string): Promise<DocumentAction> {
    if (task.assignedTo) await assertUserInOrganization(row.organizationId, task.assignedTo);
    const deadlineKind = taskDeadlineKindOf(row.kind);
    const dueAt = task.dueAt === undefined ? (deadlineKind ? dueAtFor(deadlineKind, row.documentDate ?? row.capturedAt) : null) : task.dueAt ? new Date(task.dueAt) : null;
    const action = await tx.documentAction.create({
      data: {
        id: createId("dact"),
        organizationId: row.organizationId,
        propertyId: row.propertyId,
        documentId: row.id,
        kind: task.kind,
        title: task.title,
        description: task.description ?? null,
        assignedTo: task.assignedTo ?? null,
        dueAt,
        status: "open",
        createdBy
      }
    });
    if (action.assignedTo && action.assignedTo !== createdBy) {
      await notify(tx, {
        organizationId: row.organizationId,
        propertyId: row.propertyId,
        userId: action.assignedTo,
        title: `Tarea asignada: ${action.title}`,
        body: `Documento ${row.registryNumber}${dueAt ? ` · vence el ${isoDay(dueAt)}` : ""}.`
      });
    }
    return action;
  }

  async function createDocumentAction(input: DocumentActionByIdInput): Promise<DocumentActionDto> {
    requirePermissions(input.context, [REVIEW_PERMISSION]);
    const task = parseOr400(DocumentActionRequestSchema, input.body ?? {}, "Tarea");
    await requireProperty(input.context, input.propertyId);
    const row = await requireDocument(input.propertyId, input.id);
    if (row.blockedAt) throw typed(409, "DOCUMENT_BLOCKED", "El documento está bloqueado por retención vencida.", { blockedAt: row.blockedAt.toISOString() });
    const action = await db.$transaction((tx) => createActionRow(tx, row, task, input.context.userId));
    audit({ action: DOCUMENT_ACTIONS_AUDIT.actionCreated, context: input.context, row, correlationId: input.correlationId, ...(input.ipAddress ? { ipAddress: input.ipAddress } : {}), afterJson: { registryNumber: row.registryNumber, actionId: action.id, kind: action.kind, title: action.title, assignedTo: action.assignedTo, dueAt: action.dueAt?.toISOString() ?? null } });
    return toDocumentActionDto(action);
  }

  async function patchDocumentAction(input: DocumentActionByIdInput & { actionId: string }): Promise<DocumentActionDto> {
    requirePermissions(input.context, [REVIEW_PERMISSION]);
    const body = parseOr400(DocumentActionPatchRequestSchema, input.body ?? {}, "Tarea");
    await requireProperty(input.context, input.propertyId);
    const row = await requireDocument(input.propertyId, input.id);
    const action = await db.documentAction.findFirst({ where: { id: input.actionId, documentId: row.id } });
    if (!action) throw typed(404, "DOCUMENT_NOT_FOUND", "Tarea no encontrada.");
    if (action.status === body.status) return toDocumentActionDto(action);
    if (action.status !== "open") {
      throw typed(409, "DOCUMENT_STATUS_TRANSITION", `La tarea ya está «${action.status}» y no admite cambios.`, { from: action.status, action: `action:${body.status}` });
    }
    const at = now();
    const updated = await db.documentAction.update({
      where: { id: action.id },
      data: { status: body.status, outcomeNote: body.outcomeNote ?? action.outcomeNote, completedBy: input.context.userId, completedAt: at }
    });
    audit({ action: DOCUMENT_ACTIONS_AUDIT.actionUpdated, context: input.context, row, correlationId: input.correlationId, ...(input.ipAddress ? { ipAddress: input.ipAddress } : {}), beforeJson: { actionId: action.id, status: action.status }, afterJson: { actionId: updated.id, status: updated.status, ...(body.outcomeNote ? { outcomeNote: body.outcomeNote } : {}) } });
    return toDocumentActionDto(updated);
  }

  // ── decisión autónoma (la llama el job de T9-13) ────────────────────────

  async function applyAutonomousDecision(documentId: string, options: { correlationId?: string } = {}): Promise<AutonomousDecisionResult> {
    const correlationId = options.correlationId ?? createId("corr");
    const row = await db.incomingDocument.findFirst({ where: { id: documentId, deletedAt: null } });
    if (!row) return { applied: false, reason: "not_found" };
    if (row.blockedAt) return { applied: false, reason: "blocked" };
    const proposalJson = (row.proposedActionJson && typeof row.proposedActionJson === "object" && !Array.isArray(row.proposedActionJson) ? row.proposedActionJson : {}) as Record<string, unknown>;
    const autonomy = (proposalJson.autonomy && typeof proposalJson.autonomy === "object" ? proposalJson.autonomy : null) as { level?: string; enabled?: boolean } | null;
    if (!autonomy || autonomy.level !== "autonomous" || autonomy.enabled === false) return { applied: false, reason: "not_autonomous" };
    if (failedChecks(checksOf(row.checksJson)).length > 0 || !checksOf(row.checksJson)) return { applied: false, reason: "checks_not_ok" };
    const checks = checksOf(row.checksJson)!;
    if (!Object.values(checks).every((check) => (check as { status?: string }).status === "ok")) return { applied: false, reason: "checks_not_ok" };
    const action = row.proposedAction as DocumentProposedAction | null;
    if (action !== "archive" && action !== "create_supplier_bill") return { applied: false, reason: "action_not_autonomous" };
    if (row.status !== "sent_to_office" && row.status !== "in_review") return { applied: false, reason: `status_${row.status}` };
    const proposal = proposalOf(row);
    const settings = await retentionSettings(row.organizationId);
    const at = now();
    const system: UserContext = { organizationId: row.organizationId, propertyId: row.propertyId, userId: "system", fullName: "ehotelOS", deviceId: "", permissions: ["payables.create"] };
    const property = await db.property.findUnique({ where: { id: row.propertyId }, select: { organizationId: true } });
    if (!property) return { applied: false, reason: "property_not_found" };

    const outcome = await db.$transaction(async (tx) => {
      // sent_to_office → in_review (autoasignación del sistema) → approve.
      const inReview = row.status === "sent_to_office" ? await transitionDocument(tx, row, "assign", { assignedTo: null, reviewStartedAt: row.reviewStartedAt ?? at }) : row;
      if (action === "archive") {
        const doc = await transitionDocument(tx, inReview, "approve:archive", { decidedBy: null, decidedAt: at, ...archiveData(row, at, settings) });
        return { doc, billId: null as string | null };
      }
      const storageKey = await originalStorageKey(row.id);
      const bill = await createSupplierBillInTx(tx, { context: system, propertyId: row.propertyId, organizationId: property.organizationId, body: buildSupplierBillBody({ document: row, proposal, body: undefined, storageKey }), createdByUserId: null, origin: "documents" });
      const doc = await transitionDocument(tx, inReview, "approve:create_supplier_bill", { decidedBy: null, decidedAt: at, supplierBillId: bill.id, supplierId: bill.supplierId ?? row.supplierId, totalAmount: bill.total });
      return { doc, billId: bill.id };
    });
    // Ítem informativo en la cola genérica (nunca aprueba ni contabiliza): la oficina ve qué hizo la IA.
    await enqueueReview({
      organizationId: row.organizationId,
      propertyId: row.propertyId,
      reviewType: "incoming_document_autonomous",
      relatedEntityType: "incoming_document",
      relatedEntityId: row.id,
      payloadJson: { informative: true, registryNumber: row.registryNumber, action, supplierBillId: outcome.billId, status: outcome.doc.status },
      correlationId
    });
    await closeReview(outcome.doc, "approved", system, `Decisión autónoma: ${action}`, correlationId);
    audit({ action: DOCUMENT_ACTIONS_AUDIT.autonomous, context: { userId: "", deviceId: "" }, row: outcome.doc, correlationId, actorType: "ai", beforeJson: { status: row.status }, afterJson: { ...documentAuditSummary(outcome.doc), action, supplierBillId: outcome.billId } });
    return { applied: true, reason: "applied", action, document: await toRecord(outcome.doc), ...(outcome.billId ? { supplierBillId: outcome.billId } : {}) };
  }

  return { assignDocument, reviewDocument, approveDocument, rejectDocument, archiveDocument, createDocumentAction, patchDocumentAction, applyAutonomousDecision };
}

export type DocumentActionsService = ReturnType<typeof createDocumentActionsService>;

let defaultService: DocumentActionsService | null = null;

export function getDocumentActionsService(): DocumentActionsService {
  if (!defaultService) defaultService = createDocumentActionsService();
  return defaultService;
}

export const assignDocument = (input: DocumentActionByIdInput): Promise<IncomingDocumentRecord> => getDocumentActionsService().assignDocument(input);
export const reviewDocument = (input: DocumentActionByIdInput): Promise<IncomingDocumentRecord> => getDocumentActionsService().reviewDocument(input);
export const approveDocument = (input: DocumentActionByIdInput): Promise<DocumentApproveResult> => getDocumentActionsService().approveDocument(input);
export const rejectDocument = (input: DocumentActionByIdInput): Promise<RejectDocumentResult> => getDocumentActionsService().rejectDocument(input);
export const archiveDocument = (input: DocumentActionByIdInput): Promise<ArchiveDocumentResult> => getDocumentActionsService().archiveDocument(input);
export const createDocumentAction = (input: DocumentActionByIdInput): Promise<DocumentActionDto> => getDocumentActionsService().createDocumentAction(input);
export const patchDocumentAction = (input: DocumentActionByIdInput & { actionId: string }): Promise<DocumentActionDto> => getDocumentActionsService().patchDocumentAction(input);
export const applyAutonomousDecision = (documentId: string, options?: { correlationId?: string }): Promise<AutonomousDecisionResult> => getDocumentActionsService().applyAutonomousDecision(documentId, options);

/** Disyunción capture | review (split, merge, hoja de remesa): reexportada para las rutas. */
export const CAPTURE_OR_REVIEW: readonly PermissionKey[] = Object.freeze([CAPTURE_PERMISSION, REVIEW_PERMISSION]);
export { requireAnyPermission, type DocumentWorkflowAction };
