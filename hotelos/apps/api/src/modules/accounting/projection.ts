// Accounting projection (Finanzas · lote ledger · 2026-09-15).
//
// Domain events → asientos, through the typed rules of posting-rules.ts and
// the single engine of accounting.service.ts. What changed versus the silent
// version this replaces:
//   · every event is MATERIALISED from the database (invoice + lines +
//     breakdown, payment, refund, POS ticket) — the rules never read money
//     from an event payload, so a replay yields the same asiento as the live
//     projection;
//   · processing is serialised per process, retried with backoff on
//     transient errors (DB / network), and a final failure is RECORDED: an
//     ACCOUNTING_PROJECTION_FAILED audit event (persisted, chained) plus the
//     in-memory status exposed by GET /accounting/projection/status; typed
//     business errors (409/400 from the engine) are recorded once, not retried;
//   · idempotent by (organizationId, sourceType, sourceId) inside the engine,
//     so a re-delivered event, a restart or the replay never duplicate an entry;
//   · `replayAccountingProjection` walks the SOURCE tables (invoices,
//     payments, refunds, POS tickets) of an organisation in a date window and
//     posts what is missing — the historical re-projection of Faranda, exposed
//     as POST /accounting/replay and the `accounting:replay` CLI, dry-run by
//     default.
//
// Rules of the runbook (§2) applied here:
//   · ChargePosted (cargo a habitación) posts NOTHING: revenue is recognised
//     by the invoice; the folio keeps the charge until then.
//   · SupplierBillCreated (a draft) posts nothing: the proveedores lot posts
//     the bill at «posted» with posting-rules.buildSupplierBillEntry.
//   · Payroll and commissions keep their own event handlers in
//     posting-rules/{payroll,commission}.ts (dispatcher posting-rules/index.ts).

import { prisma } from "@hotelos/database";
import type { EventEnvelope } from "@hotelos/shared";
import { Prisma } from "@prisma/client";
import { createId } from "../../lib/ids.js";
import { HttpError } from "../../lib/http-error.js";
import { recordAuditEvent } from "../audit/audit.service.js";
import {
  ZERO,
  aggregateAccountBalances,
  findJournalEntryBySource,
  isoDay,
  ledgerConflict,
  loadJournalEntry,
  localDateInTz,
  money,
  postJournalEntry,
  reverseJournalEntry,
  type PostedJournalEntry
} from "./accounting.service.js";
import {
  buildInvoiceEntry,
  buildInvoiceReversalEntry,
  buildPaymentEntry,
  buildPosSaleEntry,
  buildRefundEntry,
  cashSaleSourceId,
  issuanceSourceKeys,
  posRevenueAccount,
  type CashSettlement,
  type InvoiceDocumentInput,
  type RuleEntry,
  type TaxDocumentLine
} from "./posting-rules.js";
import { resolveTaxRate } from "./tax-rate.service.js";
import type { ProjectionFailureView, ProjectionStatusView, ReplayItemView, ReplayKind, ReplayReportView } from "../../../../../packages/shared/src/accounting-types.js";

const D = Prisma.Decimal;

// ---------------------------------------------------------------------------
// Document ↔ asiento link (Tanda L2 · L2-06)
// ---------------------------------------------------------------------------
//
// After the engine posts an asiento, the source document (Payment, PosOrder)
// is stamped with `journalEntryId`. That stamp used to be `.catch(() =>
// undefined)`: a failed UPDATE left a posted asiento with no back-link and
// nobody knew. Money path, so now: the failure is logged with the correlation
// id, the source key and the asiento id, and re-thrown as a typed HttpError
// 500 (`details.code = "ACCOUNTING_LINK_FAILED"`) — the projection queue
// retries it and records ACCOUNTING_PROJECTION_FAILED, the replay reports the
// document as `failed`, a caller's transaction rolls back. Two Prisma errors
// are idempotent by nature and only WARN: P2025 (the document row disappeared
// between the post and the link — the asiento stands, there is nothing left to
// stamp) and P2002 (a concurrent writer already linked the same row).

const PROJECTION_SCOPE = "accounting.projection";

type LinkRef = {
  sourceType: string;
  sourceId: string;
  journalEntryId: string;
  organizationId: string;
  propertyId: string | null;
  correlationId?: string;
};

function prismaErrorCode(error: unknown): string | null {
  const code = error && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
  return typeof code === "string" ? code : null;
}

function describeError(error: unknown): { name: string; message: string; code: string | null } {
  return error instanceof Error
    ? { name: error.name, message: error.message, code: prismaErrorCode(error) }
    : { name: "Error", message: String(error), code: prismaErrorCode(error) };
}

async function linkDocumentToEntry(link: Promise<unknown>, ref: LinkRef): Promise<void> {
  try {
    await link;
  } catch (error) {
    const code = prismaErrorCode(error);
    const fields = { scope: PROJECTION_SCOPE, correlationId: ref.correlationId ?? null, organizationId: ref.organizationId, propertyId: ref.propertyId, sourceType: ref.sourceType, sourceId: ref.sourceId, journalEntryId: ref.journalEntryId, err: describeError(error) };
    if (code === "P2025" || code === "P2002") {
      // Idempotent: the row is gone (P2025) or already linked by someone else (P2002); the asiento is posted and consistent.
      console.warn(`[${PROJECTION_SCOPE}] document→entry link skipped (${code}, idempotent)`, fields);
      return;
    }
    console.error(`[${PROJECTION_SCOPE}] document→entry link failed`, fields);
    throw new HttpError(500, "No se pudo enlazar el documento con su asiento contable.", false, {
      code: "ACCOUNTING_LINK_FAILED",
      sourceType: ref.sourceType,
      sourceId: ref.sourceId,
      journalEntryId: ref.journalEntryId,
      ...(ref.correlationId ? { correlationId: ref.correlationId } : {})
    });
  }
}

// ---------------------------------------------------------------------------
// Queue with retries and recorded failures
// ---------------------------------------------------------------------------

export type ProjectionOutcome = { outcome: "posted" | "existing" | "ignored"; journalEntryIds: string[]; warnings: string[] };

const MAX_ATTEMPTS = 3;
const BACKOFF_MS = [250, 1000, 3000];
const RECENT_FAILURES = 50;

const stats = { queued: 0, processed: 0, posted: 0, ignored: 0, failed: 0 };
const recentFailures: ProjectionFailureView[] = [];

let projectionChain: Promise<void> = Promise.resolve();

export function queueAccountingProjection(event: EventEnvelope): void {
  stats.queued += 1;
  projectionChain = projectionChain.then(() => projectEventWithRetry(event));
}

export async function flushAccountingProjection(): Promise<void> {
  await projectionChain;
}

export function getProjectionStatus(): ProjectionStatusView {
  return { ...stats, recentFailures: [...recentFailures] };
}

/** Test hook: clears the in-memory counters (never touches the database). */
export function resetProjectionStatusForTests(): void {
  stats.queued = 0;
  stats.processed = 0;
  stats.posted = 0;
  stats.ignored = 0;
  stats.failed = 0;
  recentFailures.length = 0;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Typed 4xx from the engine (unbalanced, closed period, missing account…): a re-run cannot fix it. */
function isBusinessError(error: unknown): boolean {
  return error instanceof HttpError && error.statusCode < 500;
}

export function reportProjectionFailure(event: EventEnvelope, error: unknown, attempts: number, sourceType: string | null = null, sourceId: string | null = null): void {
  const message = error instanceof Error ? error.message : String(error);
  const details = error instanceof HttpError ? error.details : undefined;
  stats.failed += 1;
  recentFailures.unshift({ eventId: event.eventId, eventType: event.eventType, organizationId: event.organizationId, sourceType, sourceId, error: message, attempts, failedAt: new Date().toISOString() });
  if (recentFailures.length > RECENT_FAILURES) recentFailures.length = RECENT_FAILURES;
  console.error(`[accounting] projection failed for ${event.eventId} (${event.eventType}, org ${event.organizationId}) after ${attempts} attempt(s): ${message}`);
  recordAuditEvent({
    organizationId: event.organizationId,
    propertyId: event.propertyId || undefined,
    actorType: "system",
    action: "ACCOUNTING_PROJECTION_FAILED",
    entityType: "domain_event",
    entityId: event.eventId,
    afterJson: { eventType: event.eventType, entityType: event.entityType, entityId: event.entityId, sourceType, sourceId, error: message, details: details ?? null, attempts },
    correlationId: event.correlationId
  });
}

async function projectEventWithRetry(event: EventEnvelope): Promise<void> {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      const result = await projectEvent(event);
      stats.processed += 1;
      if (result.outcome === "posted") stats.posted += 1;
      else if (result.outcome === "ignored") stats.ignored += 1;
      for (const warning of result.warnings) console.warn(`[accounting] ${event.eventType} ${event.entityId}: ${warning}`);
      return;
    } catch (error) {
      if (isBusinessError(error) || attempt === MAX_ATTEMPTS) {
        stats.processed += 1;
        reportProjectionFailure(event, error, attempt, event.entityType, event.entityId);
        return;
      }
      await sleep(BACKOFF_MS[attempt - 1] ?? 1000);
    }
  }
}

/** Route one domain event to its materialiser. Exported for tests and for the replay of the event log. */
export async function projectEvent(event: EventEnvelope): Promise<ProjectionOutcome> {
  const payload = (event.payload ?? {}) as Record<string, unknown>;
  const actor = event.actorUserId ?? null;
  switch (event.eventType) {
    case "InvoiceIssued":
      return postInvoiceIssuance({ invoiceId: event.entityId, actorUserId: actor, correlationId: event.correlationId });
    case "InvoiceCancelled":
      return postInvoiceCancellation({
        invoiceId: event.entityId,
        reason: typeof payload.reason === "string" ? payload.reason : "anulación",
        actorUserId: actor,
        correlationId: event.correlationId
      });
    case "PaymentCaptured":
      return postPaymentCapture({ paymentId: event.entityId, actorUserId: actor, correlationId: event.correlationId });
    case "InvoiceMarkedPaid":
      return typeof payload.paymentId === "string"
        ? postPaymentCapture({ paymentId: payload.paymentId, actorUserId: actor, correlationId: event.correlationId })
        : ignored();
    case "PaymentRefunded":
      return postPaymentRefund({
        paymentId: typeof payload.paymentId === "string" ? payload.paymentId : event.entityId,
        refundId: typeof payload.refundId === "string" ? payload.refundId : null,
        actorUserId: actor,
        correlationId: event.correlationId
      });
    case "ChargePosted": // cargo a habitación: sin asiento hasta la factura
    case "SupplierBillCreated": // borrador: el lote proveedores contabiliza al pasar a «posted»
    default:
      return ignored();
  }
}

function ignored(): ProjectionOutcome {
  return { outcome: "ignored", journalEntryIds: [], warnings: [] };
}

/** The already-posted entry of a document as a PostedJournalEntry (created: false). */
async function existingPosted(client: Prisma.TransactionClient | typeof prisma, journalEntryId: string): Promise<PostedJournalEntry> {
  const view = await loadJournalEntry(client, journalEntryId);
  if (!view) throw ledgerConflict("JOURNAL_ENTRY_NOT_FOUND", `El asiento ${journalEntryId} no existe.`, { journalEntryId });
  return { ...view, created: false };
}

function outcomeOf(entries: PostedJournalEntry[], warnings: string[]): ProjectionOutcome {
  return { outcome: entries.some((e) => e.created) ? "posted" : "existing", journalEntryIds: entries.map((e) => e.id), warnings };
}

// ---------------------------------------------------------------------------
// Property time zone
// ---------------------------------------------------------------------------

const timezoneCache = new Map<string, { organizationId: string; timezone: string }>();

async function propertyInfo(propertyId: string): Promise<{ organizationId: string; timezone: string }> {
  const cached = timezoneCache.get(propertyId);
  if (cached) return cached;
  const row = await prisma.property.findUnique({ where: { id: propertyId }, select: { organizationId: true, timezone: true } });
  if (!row) throw ledgerConflict("PROPERTY_NOT_FOUND", `La propiedad ${propertyId} no existe.`, { propertyId });
  const info = { organizationId: row.organizationId, timezone: row.timezone || "Europe/Madrid" };
  timezoneCache.set(propertyId, info);
  return info;
}

export function invalidatePropertyCacheForTests(): void {
  timezoneCache.clear();
}

// ---------------------------------------------------------------------------
// Invoices
// ---------------------------------------------------------------------------

type InvoiceRow = NonNullable<Awaited<ReturnType<typeof prisma.invoice.findUnique>>>;

function parseFigure(taxCode: string, taxFigure: string | null): "IVA" | "IGIC" | "IPSI" {
  if (taxFigure === "IVA" || taxFigure === "IGIC" || taxFigure === "IPSI") return taxFigure;
  const match = /^ES_(IVA|IGIC|IPSI)_/.exec(taxCode);
  return match ? (match[1] as "IVA" | "IGIC" | "IPSI") : "IVA";
}

function parseCalificacion(taxCode: string, taxCalificacion: string | null): "S1" | "N1" {
  if (taxCalificacion === "N1") return "N1";
  if (taxCalificacion === "S1") return "S1";
  return /_N1$/.test(taxCode) ? "N1" : "S1";
}

/**
 * Whether a simplified invoice was settled in the act (TPV al contado), and
 * how. Pure: reads `snapshotJson.paidWith` / `snapshotJson.posOrderId` written
 * by simplified-invoice.service and, failing that, the PosOrder linked to the
 * invoice (settlement cash | card). An F1/F2 invoiced on a folio (receivable,
 * paid later through Payment rows) returns null. Exported for the unit tests.
 */
export function cashSettlementOf(
  row: { simplified: boolean; snapshotJson: unknown },
  linkedPosOrder: { id: string; settlement: string | null } | null
): CashSettlement | null {
  if (!row.simplified) return null;
  const snapshot = row.snapshotJson && typeof row.snapshotJson === "object" ? (row.snapshotJson as Record<string, unknown>) : {};
  const snapshotPaidWith = snapshot.paidWith === "cash" || snapshot.paidWith === "card_terminal" ? snapshot.paidWith : null;
  const linkedPaidWith = linkedPosOrder?.settlement === "cash" ? "cash" : linkedPosOrder?.settlement === "card" ? "card_terminal" : null;
  const paidWith = snapshotPaidWith ?? linkedPaidWith;
  if (!paidWith) return null;
  const snapshotOrderId = typeof snapshot.posOrderId === "string" && snapshot.posOrderId.length > 0 ? snapshot.posOrderId : null;
  return { paidWith, posOrderId: snapshotOrderId ?? linkedPosOrder?.id ?? null };
}

function parseBreakdown(value: unknown): InvoiceDocumentInput["breakdown"] {
  if (!Array.isArray(value)) return null;
  const groups: NonNullable<InvoiceDocumentInput["breakdown"]> = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const group = item as Record<string, unknown>;
    if (typeof group.ratePercent !== "number" || group.base === undefined || group.quota === undefined) continue;
    groups.push({
      figure: typeof group.figure === "string" ? group.figure : null,
      calificacion: typeof group.calificacion === "string" ? group.calificacion : null,
      ratePercent: group.ratePercent,
      base: String(group.base),
      quota: String(group.quota)
    });
  }
  return groups.length > 0 ? groups : null;
}

/** Invoice + lines + property time zone → typed document for the rules. */
export async function loadInvoiceDocument(invoiceId: string, client: Prisma.TransactionClient | typeof prisma = prisma): Promise<{ doc: InvoiceDocumentInput; row: InvoiceRow; timezone: string }> {
  const row = await client.invoice.findUnique({ where: { id: invoiceId } });
  if (!row) throw ledgerConflict("INVOICE_NOT_FOUND", `La factura ${invoiceId} no existe.`, { invoiceId });
  const [lines, property, original, linkedPosOrder] = await Promise.all([
    client.invoiceLine.findMany({ where: { invoiceId: row.id }, orderBy: { id: "asc" } }),
    propertyInfo(row.propertyId),
    row.rectifyingForId ? client.invoice.findUnique({ where: { id: row.rectifyingForId }, select: { invoiceNumber: true } }) : Promise.resolve(null),
    // Only a simplified invoice can be a sale settled in the act; F1 never pays the extra lookup.
    row.simplified ? client.posOrder.findFirst({ where: { invoiceId: row.id }, select: { id: true, settlement: true }, orderBy: { id: "asc" } }) : Promise.resolve(null)
  ]);
  if (!row.issuedAt) throw ledgerConflict("INVOICE_NOT_ISSUED", `La factura ${row.invoiceNumber ?? row.id} no está emitida: no genera asiento.`, { invoiceId: row.id });
  const docLines: TaxDocumentLine[] = lines.map((line) => ({
    description: line.description,
    total: line.total,
    ratePercent: Number(line.taxRate),
    calificacion: parseCalificacion(line.taxCode, line.taxCalificacion),
    figure: parseFigure(line.taxCode, line.taxFigure),
    category: line.taxCategory ?? null
  }));
  const isRectification = row.invoiceType.startsWith("R") || row.rectifyingForId !== null;
  const doc: InvoiceDocumentInput = {
    organizationId: property.organizationId,
    propertyId: row.propertyId,
    invoiceId: row.id,
    invoiceNumber: row.invoiceNumber,
    entryDate: localDateInTz(row.issuedAt, property.timezone),
    customerName: row.customerName,
    customerTaxId: row.customerTaxId,
    lines: docLines,
    breakdown: parseBreakdown(row.taxBreakdownJson),
    total: row.total,
    taxTotal: row.taxTotal,
    kind: row.simplified ? "simplified" : isRectification ? "rectification" : "issued",
    rectifyingForId: row.rectifyingForId,
    rectifyingForNumber: original?.invoiceNumber ?? null,
    settledInAct: cashSettlementOf(row, linkedPosOrder)
  };
  return { doc, row, timezone: property.timezone };
}

/** The issuance asiento of a document under any of its possible keys (sync port, projection or replay), or null. */
async function findIssuanceEntry(client: Prisma.TransactionClient | typeof prisma, organizationId: string, doc: Pick<InvoiceDocumentInput, "invoiceId" | "kind" | "settledInAct">): Promise<Awaited<ReturnType<typeof findJournalEntryBySource>>> {
  for (const key of issuanceSourceKeys(doc)) {
    const found = await findJournalEntryBySource(client, organizationId, key.sourceType, key.sourceId);
    if (found) return found;
  }
  return null;
}

async function postRuleEntry(entry: RuleEntry, doc: { organizationId: string; propertyId?: string | null }, actorUserId: string | null, correlationId: string | undefined, tx?: Prisma.TransactionClient): Promise<PostedJournalEntry> {
  return postJournalEntry({
    organizationId: doc.organizationId,
    propertyId: doc.propertyId ?? null,
    entryDate: entry.entryDate,
    sourceType: entry.sourceType,
    sourceId: entry.sourceId,
    description: entry.description,
    reference: entry.reference,
    entryKind: entry.entryKind,
    lines: entry.lines,
    createdBy: actorUserId,
    correlationId,
    tx
  });
}

/**
 * Issuance entry of an invoice (F1/F2/simplified) or of a rectificativa. A
 * rectificativa «S» (sustitución) also reverses the entry of the invoice it
 * replaces; «I» (diferencias, or legacy without type) posts its signed
 * amounts. A simplified invoice settled in the act (TPV al contado) is keyed
 * `pos_ticket/<ticket>` like the synchronous TPV entry: the InvoiceIssued
 * projection then finds that entry and posts nothing (t6#1). Idempotent.
 * Other lots may pass their transaction (`tx`) so the invoice and its asiento
 * commit together.
 */
export async function postInvoiceIssuance(input: { invoiceId: string; actorUserId?: string | null; correlationId?: string; tx?: Prisma.TransactionClient }): Promise<ProjectionOutcome> {
  const client = input.tx ?? prisma;
  const { doc, row, timezone } = await loadInvoiceDocument(input.invoiceId, client);
  if (doc.settledInAct) {
    // The TPV port posts D 570|5721 / H 705.x / H 477 synchronously under the ticket key; a second key
    // (the invoice id, when the ticket was linked after issuance) is checked too. Never a 4300 entry.
    const existing = await findIssuanceEntry(client, doc.organizationId, doc);
    if (existing) return outcomeOf([await existingPosted(client, existing.id)], []);
    const cashSale = buildInvoiceEntry(doc);
    const posted = await postRuleEntry(cashSale, doc, input.actorUserId ?? null, input.correlationId, input.tx);
    if (posted.created && doc.settledInAct.posOrderId) {
      await linkDocumentToEntry(
        client.posOrder.updateMany({ where: { id: doc.settledInAct.posOrderId, journalEntryId: null }, data: { journalEntryId: posted.id } }),
        { sourceType: cashSale.sourceType, sourceId: cashSale.sourceId, journalEntryId: posted.id, organizationId: doc.organizationId, propertyId: doc.propertyId, correlationId: input.correlationId }
      );
    }
    return outcomeOf([posted], cashSale.warnings);
  }
  const entry = buildInvoiceEntry(doc);
  const entries: PostedJournalEntry[] = [];
  const warnings = [...entry.warnings];
  if (doc.kind === "rectification" && row.rectificationType === "S" && row.rectifyingForId) {
    const reversal = await reverseSupersededInvoice({ originalId: row.rectifyingForId, rectification: row, entryDate: doc.entryDate, timezone, actorUserId: input.actorUserId ?? null, correlationId: input.correlationId, tx: input.tx });
    if (reversal) entries.push(reversal.entry);
    warnings.push(...(reversal?.warnings ?? []));
  }
  entries.push(await postRuleEntry(entry, doc, input.actorUserId ?? null, input.correlationId, input.tx));
  return outcomeOf(entries, warnings);
}

async function reverseSupersededInvoice(input: { originalId: string; rectification: InvoiceRow; entryDate: string; timezone: string; actorUserId: string | null; correlationId?: string; tx?: Prisma.TransactionClient }): Promise<{ entry: PostedJournalEntry; warnings: string[] } | null> {
  const client = input.tx ?? prisma;
  const organizationId = (await propertyInfo(input.rectification.propertyId)).organizationId;
  const sourceId = `${input.rectification.id}:supersedes:${input.originalId}`;
  const already = await findJournalEntryBySource(client, organizationId, "invoice_rectification", sourceId);
  const number = input.rectification.invoiceNumber ?? input.rectification.id;
  if (already) return { entry: await existingPosted(client, already.id), warnings: [] };
  // The replaced document may be a folio invoice (invoice / invoice_rectification key) or a cash sale (pos_ticket key).
  const original = await loadInvoiceDocument(input.originalId, client);
  const originalEntry = await findIssuanceEntry(client, organizationId, original.doc);
  if (originalEntry && originalEntry.status !== "draft") {
    if (originalEntry.reversedById) {
      // Already reversed (by a cancellation or an earlier substitution): nothing more to undo.
      return { entry: await existingPosted(client, originalEntry.reversedById), warnings: [`La factura sustituida ya estaba revertida (asiento ${originalEntry.reversedById}).`] };
    }
    const entry = await reverseJournalEntry({
      organizationId,
      journalEntryId: originalEntry.id,
      reason: `sustituida por la rectificativa ${number}`,
      entryDate: input.entryDate,
      sourceType: "invoice_rectification",
      sourceId,
      description: `Reversión de la factura sustituida por la rectificativa ${number}`,
      createdBy: input.actorUserId,
      correlationId: input.correlationId,
      tx: input.tx
    });
    return { entry, warnings: [] };
  }
  // The original was issued before the ledger existed: build its inverse from the document itself.
  const reversal = buildInvoiceReversalEntry(original.doc, { sourceType: "invoice_rectification", sourceId, entryDate: input.entryDate, reason: `sustituida por la rectificativa ${number}` });
  const entry = await postRuleEntry(reversal, original.doc, input.actorUserId, input.correlationId, input.tx);
  return { entry, warnings: [`La factura ${original.doc.invoiceNumber ?? input.originalId} no tenía asiento de emisión: la reversión se calculó desde el documento.`, ...reversal.warnings] };
}

/** Cancellation: the marked inverse of the issuance entry (or of the document, when no entry existed). */
export async function postInvoiceCancellation(input: { invoiceId: string; reason: string; cancelledAt?: Date | null; actorUserId?: string | null; correlationId?: string; tx?: Prisma.TransactionClient }): Promise<ProjectionOutcome> {
  const client = input.tx ?? prisma;
  const row = await client.invoice.findUnique({ where: { id: input.invoiceId } });
  if (!row) throw ledgerConflict("INVOICE_NOT_FOUND", `La factura ${input.invoiceId} no existe.`, { invoiceId: input.invoiceId });
  if (row.status !== "cancelled") throw ledgerConflict("INVOICE_NOT_CANCELLED", `La factura ${row.invoiceNumber ?? row.id} no está anulada.`, { invoiceId: row.id, status: row.status });
  const property = await propertyInfo(row.propertyId);
  const cancelledAt = input.cancelledAt ?? row.cancelledAt ?? new Date();
  const entryDate = localDateInTz(cancelledAt, property.timezone);
  const existing = await findJournalEntryBySource(client, property.organizationId, "invoice_cancellation", row.id);
  if (existing) return outcomeOf([await existingPosted(client, existing.id)], []);
  // The document first: a cash sale (settled in the act) lives under the pos_ticket key and its inverse returns the treasury, never 4300.
  const { doc } = await loadInvoiceDocument(row.id, client);
  const issued = await findIssuanceEntry(client, property.organizationId, doc);
  if (issued && issued.status !== "draft" && !issued.reversedById) {
    const entry = await reverseJournalEntry({
      organizationId: property.organizationId,
      journalEntryId: issued.id,
      reason: input.reason,
      entryDate,
      sourceType: "invoice_cancellation",
      sourceId: row.id,
      description: `Anulación de la factura ${row.invoiceNumber ?? row.id}: ${input.reason}`,
      createdBy: input.actorUserId ?? null,
      correlationId: input.correlationId,
      tx: input.tx
    });
    return outcomeOf([entry], []);
  }
  const reversal = buildInvoiceReversalEntry(doc, { sourceType: "invoice_cancellation", sourceId: row.id, entryDate, reason: input.reason });
  const entry = await postRuleEntry(reversal, doc, input.actorUserId ?? null, input.correlationId, input.tx);
  const warnings = issued ? [] : [`La factura ${doc.invoiceNumber ?? row.id} no tenía asiento de emisión: la anulación se calculó desde el documento.`];
  return outcomeOf([entry], [...warnings, ...reversal.warnings]);
}

// ---------------------------------------------------------------------------
// Payments and refunds
// ---------------------------------------------------------------------------

type PaymentRow = NonNullable<Awaited<ReturnType<typeof prisma.payment.findUnique>>>;

async function paymentReference(row: PaymentRow): Promise<string | null> {
  if (row.invoiceId) {
    const invoice = await prisma.invoice.findUnique({ where: { id: row.invoiceId }, select: { invoiceNumber: true } });
    if (invoice?.invoiceNumber) return invoice.invoiceNumber;
  }
  const folio = await prisma.folio.findUnique({ where: { id: row.folioId }, select: { reservationId: true } });
  if (!folio) return null;
  const reservation = await prisma.reservation.findUnique({ where: { id: folio.reservationId }, select: { code: true } });
  return reservation ? `reserva ${reservation.code}` : null;
}

export async function postPaymentCapture(input: { paymentId: string; actorUserId?: string | null; correlationId?: string; tx?: Prisma.TransactionClient }): Promise<ProjectionOutcome> {
  const row = await (input.tx ?? prisma).payment.findUnique({ where: { id: input.paymentId } });
  if (!row) throw ledgerConflict("PAYMENT_NOT_FOUND", `El cobro ${input.paymentId} no existe.`, { paymentId: input.paymentId });
  if (row.deletedAt || (row.status !== "captured" && row.status !== "refunded")) return ignored();
  // A reversal row (reversalOfId) is a refund, not money received: its asiento is the payment_refund
  // keyed by the PaymentRefund row (payments lot) — never a capture (t6#7).
  if (row.reversalOfId) return ignored();
  const property = await propertyInfo(row.propertyId);
  const entry = buildPaymentEntry({
    organizationId: property.organizationId,
    propertyId: row.propertyId,
    paymentId: row.id,
    entryDate: localDateInTz(row.createdAt, property.timezone),
    amount: row.amount,
    methodCode: row.methodCode,
    method: row.method,
    reference: await paymentReference(row)
  });
  const posted = await postRuleEntry(entry, { organizationId: property.organizationId, propertyId: row.propertyId }, input.actorUserId ?? null, input.correlationId, input.tx);
  if (posted.created && !row.journalEntryId) {
    await linkDocumentToEntry(
      (input.tx ?? prisma).payment.update({ where: { id: row.id }, data: { journalEntryId: posted.id } }),
      { sourceType: entry.sourceType, sourceId: entry.sourceId, journalEntryId: posted.id, organizationId: property.organizationId, propertyId: row.propertyId, correlationId: input.correlationId }
    );
  }
  return outcomeOf([posted], entry.warnings);
}

/**
 * Refund entry. With a PaymentRefund row (partial or full) the entry is keyed
 * by the refund id; a legacy full refund without a row (status flipped to
 * refunded before refunds were persisted) is keyed by `<paymentId>:refund` for
 * the amount not covered by refund rows.
 */
export async function postPaymentRefund(input: { paymentId: string; refundId?: string | null; actorUserId?: string | null; correlationId?: string; tx?: Prisma.TransactionClient }): Promise<ProjectionOutcome> {
  const client = input.tx ?? prisma;
  const row = await client.payment.findUnique({ where: { id: input.paymentId } });
  if (!row) throw ledgerConflict("PAYMENT_NOT_FOUND", `El cobro ${input.paymentId} no existe.`, { paymentId: input.paymentId });
  const property = await propertyInfo(row.propertyId);
  const reference = await paymentReference(row);
  const base = { organizationId: property.organizationId, propertyId: row.propertyId, paymentId: row.id, methodCode: row.methodCode, method: row.method, reference };
  const warnings: string[] = [];
  let refundId: string;
  let amount: Prisma.Decimal;
  let entryDate: string;
  if (input.refundId) {
    const refund = await client.paymentRefund.findUnique({ where: { id: input.refundId } });
    if (!refund || refund.paymentId !== row.id) throw ledgerConflict("REFUND_NOT_FOUND", `La devolución ${input.refundId} no existe.`, { refundId: input.refundId });
    if (refund.status !== "completed") return ignored();
    refundId = refund.id;
    amount = new D(refund.amount);
    entryDate = localDateInTz(refund.createdAt, property.timezone);
  } else {
    if (row.status !== "refunded") return ignored();
    // A reversal row is refunded by nature (it IS the refund): the legacy «flipped without a refund
    // row» path must never turn it into a second devolución (t6#7).
    if (row.reversalOfId) return ignored();
    const refunds = await client.paymentRefund.findMany({ where: { paymentId: row.id, status: "completed" } });
    const covered = refunds.reduce((acc, r) => acc.plus(r.amount), ZERO);
    amount = new D(row.amount).minus(covered);
    if (amount.lessThanOrEqualTo(0)) return ignored();
    refundId = `${row.id}:refund`;
    entryDate = localDateInTz(row.createdAt, property.timezone);
    warnings.push(`El cobro ${row.id} figura devuelto sin registro de devolución: asiento por el importe no cubierto (${amount.toFixed(2)}).`);
  }
  const entry = buildRefundEntry({ ...base, refundId, amount, entryDate });
  const posted = await postRuleEntry(entry, base, input.actorUserId ?? null, input.correlationId, input.tx);
  return outcomeOf([posted], [...warnings, ...entry.warnings]);
}

// ---------------------------------------------------------------------------
// POS cash / card tickets
// ---------------------------------------------------------------------------

const FNB_LINE_TYPE = "minibar";

/**
 * Outlet type of a TPV ticket: it decides the revenue account (705.2 for F&B
 * outlets). Tanda L2 (L2-06): the lookup used to be `.catch(() => null)`, so a
 * storage failure quietly booked the sale to the generic account. Now the
 * failure is logged with the ticket and correlation id and re-thrown as a
 * typed 500 (`ACCOUNTING_LOOKUP_FAILED`): the queue retries, the replay
 * reports the ticket as `failed`. An outlet that simply does not exist keeps
 * resolving to null (generic account), as before.
 */
async function outletTypeOf(propertyId: string, outletId: string, ref: { orderId: string; correlationId?: string }): Promise<string | null> {
  if (outletId.startsWith("out_")) return outletId.slice(4);
  try {
    const outlet = await prisma.outlet.findUnique({ where: { id: outletId, propertyId }, select: { outletType: true } });
    return outlet?.outletType ?? null;
  } catch (error) {
    console.error(`[${PROJECTION_SCOPE}] outlet lookup failed`, { scope: PROJECTION_SCOPE, correlationId: ref.correlationId ?? null, propertyId, outletId, sourceType: "pos_ticket", sourceId: ref.orderId, err: describeError(error) });
    throw new HttpError(500, "No se pudo resolver el punto de venta del ticket.", false, { code: "ACCOUNTING_LOOKUP_FAILED", sourceType: "pos_ticket", sourceId: ref.orderId, outletId, ...(ref.correlationId ? { correlationId: ref.correlationId } : {}) });
  }
}

export async function postPosTicket(input: { orderId: string; actorUserId?: string | null; correlationId?: string; tx?: Prisma.TransactionClient }): Promise<ProjectionOutcome> {
  const client = input.tx ?? prisma;
  const row = await client.posOrder.findUnique({ where: { id: input.orderId } });
  if (!row) throw ledgerConflict("POS_ORDER_NOT_FOUND", `El ticket ${input.orderId} no existe.`, { orderId: input.orderId });
  if (row.status !== "closed" || (row.settlement !== "cash" && row.settlement !== "card")) return ignored();
  const property = await propertyInfo(row.propertyId);
  const closedAt = row.closedAt ?? row.updatedAt;
  const entryDate = row.businessDate ? isoDay(row.businessDate) : localDateInTz(closedAt, property.timezone);
  const outletType = await outletTypeOf(row.propertyId, row.outletId, { orderId: row.id, correlationId: input.correlationId });
  const category = posRevenueAccount(outletType) === "705.2" ? "food_beverage" : "general_services";
  const resolved = await resolveTaxRate({ propertyId: row.propertyId, lineType: FNB_LINE_TYPE, taxCategory: category, postingDate: closedAt });
  const invoice = row.invoiceId ? await client.invoice.findUnique({ where: { id: row.invoiceId }, select: { invoiceNumber: true } }) : null;
  const taxTotal = new D(row.taxTotal);
  const entry = buildPosSaleEntry({
    organizationId: property.organizationId,
    propertyId: row.propertyId,
    orderId: row.id,
    entryDate,
    total: row.total,
    taxTotal: taxTotal.isZero() ? null : taxTotal,
    ratePercent: resolved.ratePercent,
    figure: resolved.figure,
    settlement: row.settlement,
    outletType,
    invoiceNumber: invoice?.invoiceNumber ?? null
  });
  const posted = await postRuleEntry(entry, { organizationId: property.organizationId, propertyId: row.propertyId }, input.actorUserId ?? null, input.correlationId, input.tx);
  if (posted.created && !row.journalEntryId) {
    await linkDocumentToEntry(
      client.posOrder.update({ where: { id: row.id }, data: { journalEntryId: posted.id } }),
      { sourceType: entry.sourceType, sourceId: entry.sourceId, journalEntryId: posted.id, organizationId: property.organizationId, propertyId: row.propertyId, correlationId: input.correlationId }
    );
  }
  return outcomeOf([posted], entry.warnings);
}

// ---------------------------------------------------------------------------
// Historical replay (POST /accounting/replay · accounting:replay CLI)
// ---------------------------------------------------------------------------

export type ReplayInput = {
  organizationId: string;
  propertyId?: string | null;
  from: string;
  to: string;
  apply: boolean;
  kinds?: ReplayKind[];
  actorUserId?: string | null;
  correlationId?: string;
};

type ReplayCandidate = {
  kind: ReplayKind;
  sourceType: string;
  sourceId: string;
  reference: string | null;
  entryDate: string;
  amount: Prisma.Decimal;
  order: number;
  /** Dry run: build the lines (validates the document); apply: post. */
  run: (apply: boolean) => Promise<{ entries: ReplayEntryRef[]; warnings: string[] } | { dryRun: RuleEntry[] }>;
};

const ALL_KINDS: ReplayKind[] = ["invoice", "payment", "pos"];

function inWindow(day: string, from: string, to: string): boolean {
  return day >= from && day <= to;
}

async function invoiceCandidates(organizationId: string, propertyIds: string[], timezones: Map<string, string>, from: string, to: string, actor: string | null, correlationId: string | undefined): Promise<ReplayCandidate[]> {
  const rows = await prisma.invoice.findMany({
    where: { propertyId: { in: propertyIds }, deletedAt: null, status: { in: ["issued", "rectified", "cancelled"] }, issuedAt: { not: null } },
    orderBy: [{ issuedAt: "asc" }, { id: "asc" }]
  });
  // Simplified invoices settled in the act: the ticket they came from (if any) is the pos candidate.
  const simplifiedIds = rows.filter((row) => row.simplified).map((row) => row.id);
  const linkedOrders = simplifiedIds.length > 0 ? await prisma.posOrder.findMany({ where: { invoiceId: { in: simplifiedIds } }, select: { id: true, invoiceId: true, settlement: true }, orderBy: { id: "asc" } }) : [];
  const orderByInvoice = new Map<string, { id: string; settlement: string | null }>();
  for (const order of linkedOrders) if (order.invoiceId && !orderByInvoice.has(order.invoiceId)) orderByInvoice.set(order.invoiceId, { id: order.id, settlement: order.settlement });
  const candidates: ReplayCandidate[] = [];
  let order = 0;
  for (const row of rows) {
    const tz = timezones.get(row.propertyId) ?? "Europe/Madrid";
    const issuedDay = localDateInTz(row.issuedAt!, tz);
    const isRectification = row.invoiceType.startsWith("R") || row.rectifyingForId !== null;
    const settled = cashSettlementOf(row, orderByInvoice.get(row.id) ?? null);
    // A cash sale that came from a TPV ticket is replayed by posCandidates under the same pos_ticket key; one
    // issued without a ticket (walk-in simplified invoice) is keyed pos_ticket/<invoiceId> here (t6#1).
    const fromTicket = settled !== null && settled.posOrderId !== null;
    const sourceType = settled ? "pos_ticket" : isRectification ? "invoice_rectification" : "invoice";
    const sourceId = settled ? cashSaleSourceId({ invoiceId: row.id, settledInAct: settled }) : row.id;
    if (inWindow(issuedDay, from, to) && !fromTicket) {
      candidates.push({
        kind: "invoice",
        sourceType,
        sourceId,
        reference: row.invoiceNumber,
        entryDate: issuedDay,
        amount: new D(row.total),
        order: order++,
        run: async (apply) => {
          if (apply) {
            const outcome = await postInvoiceIssuance({ invoiceId: row.id, actorUserId: actor, correlationId });
            const entries = await Promise.all(outcome.journalEntryIds.map((id) => postedView(organizationId, id)));
            return { entries, warnings: outcome.warnings };
          }
          const { doc } = await loadInvoiceDocument(row.id);
          return { dryRun: [buildInvoiceEntry(doc)] };
        }
      });
    }
    if (row.status === "cancelled" && row.cancelledAt) {
      const cancelledDay = localDateInTz(row.cancelledAt, tz);
      if (inWindow(cancelledDay, from, to)) {
        candidates.push({
          kind: "invoice",
          sourceType: "invoice_cancellation",
          sourceId: row.id,
          reference: row.invoiceNumber,
          entryDate: cancelledDay,
          amount: new D(row.total).negated(),
          order: order++,
          run: async (apply) => {
            if (apply) {
              const outcome = await postInvoiceCancellation({ invoiceId: row.id, reason: "anulación (re-proyección)", actorUserId: actor, correlationId });
              const entries = await Promise.all(outcome.journalEntryIds.map((id) => postedView(organizationId, id)));
              return { entries, warnings: outcome.warnings };
            }
            const { doc } = await loadInvoiceDocument(row.id);
            return { dryRun: [buildInvoiceReversalEntry(doc, { sourceType: "invoice_cancellation", sourceId: row.id, entryDate: cancelledDay, reason: "anulación" })] };
          }
        });
      }
    }
  }
  return candidates;
}

async function paymentCandidates(organizationId: string, propertyIds: string[], timezones: Map<string, string>, from: string, to: string, actor: string | null, correlationId: string | undefined): Promise<ReplayCandidate[]> {
  // Reversal rows (reversalOfId) are refunds already covered by their PaymentRefund row: scanning them as
  // captures produced a spurious capture + «devolución sin registro» pair per refund (t6#7).
  const rows = await prisma.payment.findMany({
    where: { propertyId: { in: propertyIds }, deletedAt: null, reversalOfId: null, status: { in: ["captured", "refunded"] } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }]
  });
  const refunds = rows.length > 0 ? await prisma.paymentRefund.findMany({ where: { paymentId: { in: rows.map((r) => r.id) }, status: "completed" }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] }) : [];
  const refundsByPayment = new Map<string, typeof refunds>();
  for (const refund of refunds) {
    const bucket = refundsByPayment.get(refund.paymentId) ?? [];
    bucket.push(refund);
    refundsByPayment.set(refund.paymentId, bucket);
  }
  const candidates: ReplayCandidate[] = [];
  let order = 0;
  for (const row of rows) {
    const tz = timezones.get(row.propertyId) ?? "Europe/Madrid";
    const day = localDateInTz(row.createdAt, tz);
    const base = { organizationId, propertyId: row.propertyId, paymentId: row.id, methodCode: row.methodCode, method: row.method };
    if (inWindow(day, from, to)) {
      candidates.push({
        kind: "payment",
        sourceType: "payment",
        sourceId: row.id,
        reference: row.invoiceId ?? row.folioId,
        entryDate: day,
        amount: new D(row.amount),
        order: order++,
        run: async (apply) => {
          if (apply) {
            const outcome = await postPaymentCapture({ paymentId: row.id, actorUserId: actor, correlationId });
            return { entries: await Promise.all(outcome.journalEntryIds.map((id) => postedView(organizationId, id))), warnings: outcome.warnings };
          }
          return { dryRun: [buildPaymentEntry({ ...base, entryDate: day, amount: row.amount, reference: await paymentReference(row) })] };
        }
      });
    }
    const paymentRefunds = refundsByPayment.get(row.id) ?? [];
    for (const refund of paymentRefunds) {
      const refundDay = localDateInTz(refund.createdAt, tz);
      if (!inWindow(refundDay, from, to)) continue;
      candidates.push({
        kind: "payment",
        sourceType: "payment_refund",
        sourceId: refund.id,
        reference: row.invoiceId ?? row.folioId,
        entryDate: refundDay,
        amount: new D(refund.amount).negated(),
        order: order++,
        run: async (apply) => {
          if (apply) {
            const outcome = await postPaymentRefund({ paymentId: row.id, refundId: refund.id, actorUserId: actor, correlationId });
            return { entries: await Promise.all(outcome.journalEntryIds.map((id) => postedView(organizationId, id))), warnings: outcome.warnings };
          }
          return { dryRun: [buildRefundEntry({ ...base, refundId: refund.id, entryDate: refundDay, amount: refund.amount, reference: await paymentReference(row) })] };
        }
      });
    }
    if (row.status === "refunded") {
      const covered = paymentRefunds.reduce((acc, r) => acc.plus(r.amount), ZERO);
      const remainder = new D(row.amount).minus(covered);
      if (remainder.greaterThan(0) && inWindow(day, from, to)) {
        candidates.push({
          kind: "payment",
          sourceType: "payment_refund",
          sourceId: `${row.id}:refund`,
          reference: row.invoiceId ?? row.folioId,
          entryDate: day,
          amount: remainder.negated(),
          order: order++,
          run: async (apply) => {
            if (apply) {
              const outcome = await postPaymentRefund({ paymentId: row.id, refundId: null, actorUserId: actor, correlationId });
              return { entries: await Promise.all(outcome.journalEntryIds.map((id) => postedView(organizationId, id))), warnings: outcome.warnings };
            }
            return { dryRun: [buildRefundEntry({ ...base, refundId: `${row.id}:refund`, entryDate: day, amount: remainder, reference: await paymentReference(row) })] };
          }
        });
      }
    }
  }
  return candidates;
}

async function posCandidates(organizationId: string, propertyIds: string[], timezones: Map<string, string>, from: string, to: string, actor: string | null, correlationId: string | undefined): Promise<ReplayCandidate[]> {
  const rows = await prisma.posOrder.findMany({
    where: { propertyId: { in: propertyIds }, status: "closed", settlement: { in: ["cash", "card"] } },
    orderBy: [{ closedAt: "asc" }, { id: "asc" }]
  });
  const candidates: ReplayCandidate[] = [];
  let order = 0;
  for (const row of rows) {
    const tz = timezones.get(row.propertyId) ?? "Europe/Madrid";
    const day = row.businessDate ? isoDay(row.businessDate) : localDateInTz(row.closedAt ?? row.updatedAt, tz);
    if (!inWindow(day, from, to)) continue;
    candidates.push({
      kind: "pos",
      sourceType: "pos_ticket",
      sourceId: row.id,
      reference: row.invoiceId,
      entryDate: day,
      amount: new D(row.total),
      order: order++,
      run: async (apply) => {
        if (apply) {
          const outcome = await postPosTicket({ orderId: row.id, actorUserId: actor, correlationId });
          return { entries: await Promise.all(outcome.journalEntryIds.map((id) => postedView(organizationId, id))), warnings: outcome.warnings };
        }
        const outletType = await outletTypeOf(row.propertyId, row.outletId, { orderId: row.id, correlationId });
        const category = posRevenueAccount(outletType) === "705.2" ? "food_beverage" : "general_services";
        const resolved = await resolveTaxRate({ propertyId: row.propertyId, lineType: FNB_LINE_TYPE, taxCategory: category, postingDate: row.closedAt ?? row.updatedAt });
        const taxTotal = new D(row.taxTotal);
        return {
          dryRun: [
            buildPosSaleEntry({ organizationId, propertyId: row.propertyId, orderId: row.id, entryDate: day, total: row.total, taxTotal: taxTotal.isZero() ? null : taxTotal, ratePercent: resolved.ratePercent, figure: resolved.figure, settlement: row.settlement as "cash" | "card", outletType })
          ]
        };
      }
    });
  }
  return candidates;
}

type ReplayEntryRef = { id: string; entryNumber: number | null; fiscalYearCode: string | null };

async function postedView(organizationId: string, journalEntryId: string): Promise<ReplayEntryRef> {
  const row = await prisma.journalEntry.findUnique({ where: { id: journalEntryId }, select: { id: true, entryNumber: true, fiscalYearCode: true } });
  if (!row) throw ledgerConflict("JOURNAL_ENTRY_NOT_FOUND", `El asiento ${journalEntryId} no existe.`, { organizationId, journalEntryId });
  return row;
}

/**
 * Re-project the documents of an organisation in [from, to] (inclusive,
 * property-local calendar days): invoices (issuance, substitution reversal,
 * cancellation), payments (capture, refunds — persisted rows and legacy
 * flips) and POS cash/card tickets. Dry run (default) builds every asiento
 * without writing; `apply` posts the missing ones through the engine, so
 * nothing is ever duplicated. Per-document failures are reported, never
 * swallowed, and never abort the run.
 */
export async function replayAccountingProjection(input: ReplayInput): Promise<ReplayReportView> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.from) || !/^\d{4}-\d{2}-\d{2}$/.test(input.to) || input.from > input.to) {
    throw ledgerConflict("REPLAY_WINDOW_INVALID", "El rango from/to debe ser YYYY-MM-DD con from ≤ to.", { from: input.from, to: input.to });
  }
  const kinds = input.kinds && input.kinds.length > 0 ? input.kinds : ALL_KINDS;
  const properties = await prisma.property.findMany({
    where: { organizationId: input.organizationId, ...(input.propertyId ? { id: input.propertyId } : {}) },
    select: { id: true, timezone: true }
  });
  if (properties.length === 0) {
    throw ledgerConflict("REPLAY_NO_PROPERTIES", input.propertyId ? `La propiedad ${input.propertyId} no pertenece a la organización.` : "La organización no tiene propiedades.", { organizationId: input.organizationId, propertyId: input.propertyId ?? null });
  }
  const propertyIds = properties.map((p) => p.id);
  const timezones = new Map(properties.map((p) => [p.id, p.timezone || "Europe/Madrid"]));
  const actor = input.actorUserId ?? null;
  const correlationId = input.correlationId ?? createId("corr");

  const candidates: ReplayCandidate[] = [];
  if (kinds.includes("invoice")) candidates.push(...(await invoiceCandidates(input.organizationId, propertyIds, timezones, input.from, input.to, actor, correlationId)));
  if (kinds.includes("payment")) candidates.push(...(await paymentCandidates(input.organizationId, propertyIds, timezones, input.from, input.to, actor, correlationId)));
  if (kinds.includes("pos")) candidates.push(...(await posCandidates(input.organizationId, propertyIds, timezones, input.from, input.to, actor, correlationId)));
  // Chronological: originals before the rectificativas that reverse them, captures before refunds.
  candidates.sort((a, b) => a.entryDate.localeCompare(b.entryDate) || a.order - b.order);

  const items: ReplayItemView[] = [];
  const counters = { posted: 0, existing: 0, wouldPost: 0, skipped: 0, failed: 0 };
  for (const candidate of candidates) {
    const item: ReplayItemView = {
      kind: candidate.kind,
      sourceType: candidate.sourceType,
      sourceId: candidate.sourceId,
      reference: candidate.reference,
      entryDate: candidate.entryDate,
      amount: money(candidate.amount).toFixed(2),
      status: "skipped",
      journalEntryId: null,
      entryNumber: null,
      message: null,
      warnings: []
    };
    try {
      const existing = await findJournalEntryBySource(prisma, input.organizationId, candidate.sourceType, candidate.sourceId);
      if (existing) {
        item.status = "exists";
        item.journalEntryId = existing.id;
        item.entryNumber = existing.entryNumber;
        counters.existing += 1;
      } else {
        const result = await candidate.run(input.apply);
        if ("dryRun" in result) {
          item.status = "would_post";
          item.warnings = result.dryRun.flatMap((entry) => entry.warnings);
          counters.wouldPost += 1;
        } else {
          const own = result.entries.find((e) => e.id) ?? null;
          item.status = result.entries.length > 0 ? "posted" : "skipped";
          item.journalEntryId = own?.id ?? null;
          item.entryNumber = own?.entryNumber ?? null;
          item.warnings = result.warnings;
          if (item.status === "posted") counters.posted += 1;
          else counters.skipped += 1;
        }
      }
    } catch (error) {
      item.status = "failed";
      item.message = error instanceof Error ? error.message : String(error);
      counters.failed += 1;
      console.error(`[accounting] replay ${candidate.sourceType}:${candidate.sourceId} (org ${input.organizationId}, corr ${correlationId}) failed: ${item.message}`);
    }
    items.push(item);
  }

  let balanced: boolean | null = null;
  if (input.apply) {
    const totals = await aggregateAccountBalances({ organizationId: input.organizationId, propertyId: input.propertyId ?? null, from: input.from, to: input.to });
    const debit = totals.reduce((acc, row) => acc.plus(row.debit), ZERO);
    const credit = totals.reduce((acc, row) => acc.plus(row.credit), ZERO);
    balanced = debit.equals(credit);
    recordAuditEvent({
      organizationId: input.organizationId,
      propertyId: input.propertyId ?? undefined,
      actorUserId: actor ?? undefined,
      actorType: actor ? "user" : "system",
      action: "ACCOUNTING_REPLAY_APPLIED",
      entityType: "organization",
      entityId: input.organizationId,
      afterJson: { from: input.from, to: input.to, kinds, scanned: candidates.length, ...counters, balanced },
      correlationId
    });
  }

  return {
    organizationId: input.organizationId,
    propertyId: input.propertyId ?? null,
    from: input.from,
    to: input.to,
    apply: input.apply,
    kinds,
    scanned: candidates.length,
    ...counters,
    items,
    balanced,
    generatedAt: new Date().toISOString()
  };
}
