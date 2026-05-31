import { prisma } from "@hotelos/database";
import type { UserContext } from "../../lib/demo-store.js";
import { createId } from "../../lib/ids.js";
import { recordAuditEvent, recordDomainEvent } from "../audit/audit.service.js";
import { requirePermissions } from "../auth/auth.service.js";
import { BadRequestError, NotFoundError } from "../../lib/http-error.js";

async function resolveAccountIdByCode(organizationId: string, code: string): Promise<string | null> {
  const row = await prisma.account.findUnique({
    where: { organizationId_code: { organizationId, code } },
    select: { id: true }
  });
  return row?.id ?? null;
}

export type JournalLineDraft = {
  accountCode: string;
  debit: number;
  credit: number;
  description?: string;
};

export type JournalEntryDraft = {
  id: string;
  organizationId: string;
  propertyId?: string;
  sourceType: "folio" | "invoice" | "payment" | "supplier_bill" | "manual" | "depreciation";
  sourceId?: string;
  status: "draft" | "posted" | "reversed";
  lines: JournalLineDraft[];
};

export type AccountTemplate = {
  code: string;
  name: string;
  accountType: "asset" | "liability" | "equity" | "revenue" | "expense";
};

export type SupplierBillDraft = {
  id: string;
  propertyId: string;
  supplierName: string;
  supplierTaxId?: string;
  invoiceNumber?: string;
  issueDate?: string;
  dueDate?: string;
  total: number;
  taxTotal: number;
  status: "draft" | "approved" | "posted";
  documentObjectKey?: string;
  suggestedAccountCode?: string;
  roomId?: string;
  // IRPF retention (e.g. professional services from an autónomo).
  // `retentionRate` is the % withheld (15 means 15%).
  // `retentionAmount` is the EUR figure withheld and posted to cuenta 4751.
  // `rowCode` is the Modelo 111 row (default "02" profesionales).
  retentionRate?: number;
  retentionAmount?: number;
  rowCode?: string;
  paymentDate?: string;
};

const spanishPgcTemplate: AccountTemplate[] = [
  { code: "430", name: "Clientes", accountType: "asset" },
  { code: "400", name: "Proveedores", accountType: "liability" },
  { code: "572", name: "Bancos", accountType: "asset" },
  { code: "705", name: "Prestaciones de servicios", accountType: "revenue" },
  { code: "622", name: "Reparaciones y conservacion", accountType: "expense" },
  { code: "477", name: "Hacienda Publica IVA repercutido", accountType: "liability" },
  { code: "472", name: "Hacienda Publica IVA soportado", accountType: "asset" }
];

// All SupplierBill fields — including the Spain-specific extras
// (supplierName, supplierTaxId, retentionRate, retentionAmount, rowCode,
// suggestedAccountCode, roomId, paymentDate) — are now persisted natively on
// the Prisma `SupplierBill` model (see packages/database/prisma/schema.prisma).
// Sprint 29 promoted them out of an in-memory session sidecar. Rows created
// before that migration may have these columns as NULL; readers must tolerate
// that (treat them as "unknown" / absent).

function isoDateString(value: Date | null | undefined): string | undefined {
  if (!value) return undefined;
  // The Prisma column is @db.Date, so the day portion is all we need.
  return value.toISOString().slice(0, 10);
}

function parseDateInput(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  // Accept either YYYY-MM-DD or a full ISO timestamp. Coerce date-only to a
  // midnight-UTC Date so the Prisma `@db.Date` column receives a stable value.
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return new Date(`${value}T00:00:00.000Z`);
  }
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

type PrismaSupplierBillRow = Awaited<ReturnType<typeof prisma.supplierBill.findFirst>> extends infer R
  ? R extends null
    ? never
    : R
  : never;

function hydrateBill(row: PrismaSupplierBillRow): SupplierBillDraft {
  // `total` and `taxTotal` come back as Prisma.Decimal; coerce to number for the
  // existing public type. Precision is bounded (Decimal(12,2)) so Number is safe.
  const total = typeof row.total === "number" ? row.total : Number(row.total);
  const taxTotal = typeof row.taxTotal === "number" ? row.taxTotal : Number(row.taxTotal);
  const status: SupplierBillDraft["status"] =
    row.status === "approved" || row.status === "posted" ? row.status : "draft";

  // retentionRate / retentionAmount are nullable Decimal columns — coerce to
  // number (or leave undefined) so the public `SupplierBillDraft` shape stays
  // numeric and downstream consumers don't have to know about Prisma.Decimal.
  const retentionRate =
    row.retentionRate === null || row.retentionRate === undefined
      ? undefined
      : Number(row.retentionRate);
  const retentionAmount =
    row.retentionAmount === null || row.retentionAmount === undefined
      ? undefined
      : Number(row.retentionAmount);

  return {
    id: row.id,
    propertyId: row.propertyId,
    // `supplierName` is now a real column. Pre-Sprint-29 rows may have it as
    // NULL, in which case we fall back to supplierId / a safe placeholder so
    // downstream UI doesn't render an empty string.
    supplierName: row.supplierName ?? row.supplierId ?? "Unknown supplier",
    supplierTaxId: row.supplierTaxId ?? undefined,
    invoiceNumber: row.invoiceNumber ?? undefined,
    issueDate: isoDateString(row.issueDate),
    dueDate: isoDateString(row.dueDate),
    total,
    taxTotal,
    status,
    documentObjectKey: row.documentObjectKey ?? undefined,
    suggestedAccountCode: row.suggestedAccountCode ?? undefined,
    roomId: row.roomId ?? undefined,
    retentionRate,
    retentionAmount,
    rowCode: row.rowCode ?? undefined,
    paymentDate: isoDateString(row.paymentDate)
  };
}

export function listAccounts(): AccountTemplate[] {
  return spanishPgcTemplate;
}

// Manual journal entries are now PERSISTED TO PRISMA (previously an in-memory
// array that the financial statements — which read Prisma — never saw, so a
// posted manual asiento silently never appeared in trial balance / P&L /
// balance sheet). They now flow through the same journal_entries / journal_lines
// tables as the event-sourced postings.

export async function listJournalEntries(organizationId: string): Promise<JournalEntryDraft[]> {
  const entries = await prisma.journalEntry.findMany({
    where: { organizationId },
    orderBy: { id: "desc" },
    take: 500
  });
  if (entries.length === 0) return [];
  const lines = await prisma.journalLine.findMany({
    where: { journalEntryId: { in: entries.map((e) => e.id) } }
  });
  const accountIds = Array.from(new Set(lines.map((l) => l.accountId)));
  const accounts = accountIds.length
    ? await prisma.account.findMany({ where: { id: { in: accountIds } }, select: { id: true, code: true } })
    : [];
  const codeById = new Map(accounts.map((a) => [a.id, a.code]));
  const linesByEntry = new Map<string, JournalLineDraft[]>();
  for (const l of lines) {
    const arr = linesByEntry.get(l.journalEntryId) ?? [];
    arr.push({
      accountCode: codeById.get(l.accountId) ?? l.accountId,
      debit: Number(l.debit),
      credit: Number(l.credit),
      description: l.description ?? undefined
    });
    linesByEntry.set(l.journalEntryId, arr);
  }
  return entries.map((e) => ({
    id: e.id,
    organizationId: e.organizationId,
    propertyId: e.propertyId ?? undefined,
    sourceType: e.sourceType as JournalEntryDraft["sourceType"],
    sourceId: e.sourceId ?? undefined,
    status: e.status as JournalEntryDraft["status"],
    lines: linesByEntry.get(e.id) ?? []
  }));
}

export function assertBalancedJournal(lines: JournalLineDraft[]): void {
  const debit = lines.reduce((sum, line) => sum + line.debit, 0);
  const credit = lines.reduce((sum, line) => sum + line.credit, 0);
  if (Math.round((debit - credit) * 100) !== 0) {
    throw new BadRequestError("Journal entry is not balanced.");
  }
}

export async function createJournalEntryDraft(
  input: Omit<JournalEntryDraft, "id" | "status">
): Promise<JournalEntryDraft> {
  if (!input.lines || input.lines.length < 2) {
    throw new BadRequestError("A journal entry requires at least two lines.");
  }
  assertBalancedJournal(input.lines);

  const accountIds = await Promise.all(
    input.lines.map((l) => resolveAccountIdByCode(input.organizationId, l.accountCode))
  );
  const missing = input.lines.filter((_, i) => !accountIds[i]).map((l) => l.accountCode);
  if (missing.length > 0) {
    throw new BadRequestError(`Unknown account code(s) for the organization chart: ${missing.join(", ")}`);
  }

  const entry = await prisma.$transaction(async (tx) => {
    const created = await tx.journalEntry.create({
      data: {
        organizationId: input.organizationId,
        propertyId: input.propertyId ?? null,
        sourceType: input.sourceType,
        sourceId: input.sourceId ?? `manual:${createId("je")}`,
        status: "draft"
      }
    });
    await tx.journalLine.createMany({
      data: input.lines.map((l, i) => ({
        journalEntryId: created.id,
        accountId: accountIds[i]!,
        debit: l.debit,
        credit: l.credit,
        currency: "EUR",
        description: l.description ?? null
      }))
    });
    return created;
  });

  return {
    id: entry.id,
    organizationId: entry.organizationId,
    propertyId: entry.propertyId ?? undefined,
    sourceType: entry.sourceType as JournalEntryDraft["sourceType"],
    sourceId: entry.sourceId ?? undefined,
    status: entry.status as JournalEntryDraft["status"],
    lines: input.lines
  };
}

export async function postJournalEntry(input: {
  context: UserContext;
  journalEntryId: string;
  correlationId: string;
}): Promise<JournalEntryDraft> {
  requirePermissions(input.context, ["accounting.journal.post", "ai.high_risk.confirm"]);

  const entry = await prisma.journalEntry.findUnique({ where: { id: input.journalEntryId } });
  if (!entry) {
    throw new NotFoundError("Journal entry was not found.");
  }

  const lines = await prisma.journalLine.findMany({ where: { journalEntryId: entry.id } });
  assertBalancedJournal(
    lines.map((l) => ({ accountCode: l.accountId, debit: Number(l.debit), credit: Number(l.credit) }))
  );

  const updated = await prisma.journalEntry.update({
    where: { id: entry.id },
    data: { status: "posted", postedAt: new Date() }
  });

  recordAuditEvent({
    organizationId: input.context.organizationId,
    propertyId: input.context.propertyId,
    actorUserId: input.context.userId,
    actorType: "user",
    action: "JOURNAL_ENTRY_POSTED",
    entityType: "journal_entry",
    entityId: entry.id,
    beforeJson: { status: entry.status },
    afterJson: { status: updated.status },
    correlationId: input.correlationId
  });

  recordDomainEvent({
    organizationId: input.context.organizationId,
    propertyId: input.context.propertyId,
    entityType: "journal_entry",
    entityId: entry.id,
    eventType: "JournalEntryPosted",
    payload: { sourceType: updated.sourceType, sourceId: updated.sourceId },
    actorType: "user",
    actorUserId: input.context.userId,
    correlationId: input.correlationId
  });

  const result = await listJournalEntries(entry.organizationId);
  return result.find((e) => e.id === entry.id) ?? {
    id: updated.id,
    organizationId: updated.organizationId,
    propertyId: updated.propertyId ?? undefined,
    sourceType: updated.sourceType as JournalEntryDraft["sourceType"],
    sourceId: updated.sourceId ?? undefined,
    status: updated.status as JournalEntryDraft["status"],
    lines: []
  };
}

export async function createSupplierBillDraft(input: {
  context: UserContext;
  supplierName: string;
  supplierTaxId?: string;
  invoiceNumber?: string;
  issueDate?: string;
  dueDate?: string;
  total: number;
  taxTotal: number;
  documentObjectKey?: string;
  suggestedAccountCode?: string;
  roomId?: string;
  retentionRate?: number;
  retentionAmount?: number;
  rowCode?: string;
  paymentDate?: string;
  correlationId: string;
}): Promise<SupplierBillDraft> {
  // Compute retentionAmount from rate when only the rate is supplied.
  // total here is the gross amount the supplier billed; the withholding base
  // is the net excluding IVA (total - taxTotal). For professionals this is
  // the AEAT-correct base.
  const grossBase = Math.max(0, input.total - input.taxTotal);
  const retentionRate = input.retentionRate ?? 0;
  let retentionAmount = input.retentionAmount ?? 0;
  if (retentionRate > 0 && retentionAmount === 0 && grossBase > 0) {
    const ratePct = retentionRate >= 1 ? retentionRate / 100 : retentionRate;
    retentionAmount = Math.round(grossBase * ratePct * 100) / 100;
  }

  const suggestedAccountCode = input.suggestedAccountCode ?? "622";
  const id = createId("sb");

  // All Spain-specific extras (supplierName, supplierTaxId, retention*,
  // rowCode, suggestedAccountCode, roomId, paymentDate) are now native Prisma
  // columns — persist them in the single `create` call below.
  const issueDate = parseDateInput(input.issueDate);
  const dueDate = parseDateInput(input.dueDate);
  const paymentDate = parseDateInput(input.paymentDate);

  // Decimal columns: Prisma accepts strings for Decimal inputs and coerces
  // them safely. Pass strings to avoid float-precision drift on the wire.
  const retentionRateInput =
    retentionRate > 0 ? retentionRate.toString() : null;
  const retentionAmountInput =
    retentionAmount > 0 ? retentionAmount.toFixed(2) : null;

  const row = await prisma.supplierBill.create({
    data: {
      id,
      propertyId: input.context.propertyId,
      // We don't yet have a Supplier↔SupplierBill bridge by name; leave the
      // FK null and rely on the dedicated `supplierName` / `supplierTaxId`
      // columns for display + AEAT reporting.
      supplierId: null,
      supplierName: input.supplierName,
      supplierTaxId: input.supplierTaxId ?? null,
      invoiceNumber: input.invoiceNumber ?? null,
      issueDate: issueDate ?? null,
      dueDate: dueDate ?? null,
      paymentDate: paymentDate ?? null,
      total: input.total,
      taxTotal: input.taxTotal,
      retentionRate: retentionRateInput,
      retentionAmount: retentionAmountInput,
      rowCode: input.rowCode ?? null,
      suggestedAccountCode,
      roomId: input.roomId ?? null,
      status: "draft",
      documentObjectKey: input.documentObjectKey ?? null
    }
  });

  const bill = hydrateBill(row);

  recordAuditEvent({
    organizationId: input.context.organizationId,
    propertyId: input.context.propertyId,
    actorUserId: input.context.userId,
    actorType: "user",
    action: "SUPPLIER_BILL_DRAFT_CREATED",
    entityType: "supplier_bill",
    entityId: bill.id,
    afterJson: bill,
    correlationId: input.correlationId
  });

  recordDomainEvent({
    organizationId: input.context.organizationId,
    propertyId: input.context.propertyId,
    entityType: "supplier_bill",
    entityId: bill.id,
    eventType: "SupplierBillCreated",
    payload: {
      supplierName: bill.supplierName,
      supplierTaxId: bill.supplierTaxId,
      total: bill.total,
      taxTotal: bill.taxTotal,
      grossAmount: grossBase,
      // Expense account for the AP journal posted by the accounting projection.
      suggestedAccountCode: bill.suggestedAccountCode ?? suggestedAccountCode,
      status: bill.status,
      // Carry retention through so the withholding-tax posting rule can pick
      // it up off the event stream and project a `WithholdingTaxRecord` row.
      retentionRate: bill.retentionRate ?? 0,
      retentionAmount: bill.retentionAmount ?? 0,
      rowCode: bill.rowCode ?? "02",
      paymentDate: bill.paymentDate ?? input.issueDate
    },
    actorType: "user",
    actorUserId: input.context.userId,
    correlationId: input.correlationId
  });

  return bill;
}

export async function listSupplierBills(propertyId: string): Promise<SupplierBillDraft[]> {
  const rows = await prisma.supplierBill.findMany({
    where: { propertyId },
    // Newest-first preserves the historical "most recently created last"
    // behaviour callers may rely on visually; flip if a different ordering is
    // ever needed.
    orderBy: { issueDate: "desc" }
  });
  return rows.map((row) => hydrateBill(row));
}
