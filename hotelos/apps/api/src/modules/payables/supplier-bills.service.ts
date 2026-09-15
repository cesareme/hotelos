// Payables · supplier bills / facturas recibidas (Finanzas 2026-09-15).
//
// Lifecycle: draft → approved → posted → paid (cancelled from draft/approved
// without entries; from posted with a reversal entry; never from paid).
// Amounts: per-line rounding to the cent, header totals derived from the
// lines (baseTotal = Σ base, taxTotal = Σ quota, retentionAmount = Σ
// retention, total = base + tax − retention) and cross-checked against the
// supplier's printed total when the caller sends `expectedTotal`.
//
// Posting (canonical rule, runbook §2): D 6xx per line (21x/20x for
// investment goods) / D 472.rate per rate group (taxBase = Σ base of the
// group) / H 4751 retention / H 400|410 total. Payment: D 400|410 / H 572|570.
// Same transaction: VatBookEntry rows (recibidas / bienes_inversion, one per
// rate), WithholdingTaxRecord (Modelo 111/115) when there is retention, and a
// FixedAsset per investment-good line. Legacy domain events
// (`SupplierBillCreated` / `SupplierBillUpdated`) are NOT emitted: the legacy
// projection would post a second, unnumbered entry.

import { prisma } from "@hotelos/database";
import type { Prisma } from "@prisma/client";
import { z } from "zod";
import type { UserContext } from "../../lib/demo-store.js";
import { HttpError, NotFoundError } from "../../lib/http-error.js";
import { recordAuditEvent, recordDomainEvent } from "../audit/audit.service.js";
import { parseOr400 } from "../rate-manager/rate-grid.schemas.js";
import { registerFixedAssetFromBillLine } from "../fixed-assets/fixed-assets.service.js";
import { getLedgerPort, type LedgerEntryResult, type LedgerLineInput } from "./ledger-port.js";
import { dayInput, dayOf, daysBetween, dec, money, moneyInput, pct, percentInput, round2, sum, utcDay, ZERO, type Decimal } from "./money.js";
import { defaultRetentionRowCode, RETENTION_ROW_CODES, requireSupplier, resolveSupplierTaxId } from "./suppliers.service.js";
import { assertSupportedRate, deleteInputVatRows, groupInputVatRows, inputVatAccountFor, listVatRowsOf, writeInputVatRows, type VatBookRowDto } from "./vat-book.js";

type Tx = Prisma.TransactionClient;

export const PAYABLE_ACCOUNT_CODES = ["400", "410", "4100", "4109"] as const;
export const BILL_STATUSES = ["draft", "approved", "posted", "paid", "cancelled"] as const;
export type BillStatus = (typeof BILL_STATUSES)[number];

/** Inline attachments are stored as a data: URI in `documentObjectKey` (no object store in the API yet); decoded size cap. */
export const ATTACHMENT_MAX_BYTES = 512 * 1024;
export const ATTACHMENT_MIME_TYPES = ["application/pdf", "image/jpeg", "image/png"] as const;

const attachmentSchema = z
  .object({
    fileName: z.string().trim().min(1).max(200),
    mimeType: z.enum(ATTACHMENT_MIME_TYPES),
    base64: z.string().min(1)
  })
  .strict();

const lineSchema = z
  .object({
    description: z.string().trim().min(1, "obligatorio").max(300),
    expenseAccountCode: z.string().trim().min(3).max(12),
    base: moneyInput({ allowZero: false }),
    taxRate: percentInput(),
    /** Supplier-printed quota; when given it must be within ±0.01 of base × rate (rounding of the issuer prevails). */
    quota: moneyInput().optional(),
    /** Per-line retention override (default: base × bill retentionRate). */
    retention: moneyInput().optional(),
    costCenterId: z.string().trim().min(1).max(64).nullable().optional(),
    investmentGood: z.boolean().optional()
  })
  .strict();

const billSchema = z
  .object({
    supplierId: z.string().trim().min(1).max(64).nullable().optional(),
    supplierName: z.string().trim().min(1).max(200).optional(),
    supplierTaxId: z.string().trim().max(20).nullable().optional(),
    invoiceNumber: z.string().trim().min(1, "obligatorio").max(60),
    issueDate: dayInput(),
    dueDate: dayInput().nullable().optional(),
    retentionRate: percentInput().nullable().optional(),
    retentionRowCode: z.enum(RETENTION_ROW_CODES).nullable().optional(),
    payableAccountCode: z.enum(PAYABLE_ACCOUNT_CODES).optional(),
    expectedTotal: moneyInput().optional(),
    documentObjectKey: z.string().trim().min(1).max(500).nullable().optional(),
    attachment: attachmentSchema.optional(),
    roomId: z.string().trim().min(1).max(64).nullable().optional(),
    lines: z.array(lineSchema).min(1, "la factura necesita al menos una línea").max(200)
  })
  .strict();

const paySchema = z
  .object({
    paymentDate: dayInput(),
    paidWith: z.enum(["bank", "cash"]).optional(),
    /** 572 (default for bank) · 570 (cash); a sub-account of 572 is accepted if it exists in the chart. */
    counterAccountCode: z.string().trim().min(3).max(12).optional(),
    reference: z.string().trim().max(120).optional()
  })
  .strict();

const cancelSchema = z.object({ reason: z.string().trim().min(3).max(300) }).strict();

const approveSchema = z.object({}).strict().optional();

export type BillLineInput = z.input<typeof lineSchema>;
export type BillInput = z.input<typeof billSchema>;

export type ComputedBillLine = {
  lineNo: number;
  description: string;
  expenseAccountCode: string;
  base: Decimal;
  rateCode: string;
  taxRate: Decimal;
  quota: Decimal;
  retention: Decimal;
  costCenterId: string | null;
  investmentGood: boolean;
};

export type BillTotals = {
  lines: ComputedBillLine[];
  baseTotal: Decimal;
  taxTotal: Decimal;
  retentionAmount: Decimal;
  total: Decimal;
};

function typed(statusCode: number, code: string, message: string, extra: Record<string, unknown> = {}): HttpError {
  return new HttpError(statusCode, message, true, { code, ...extra });
}

/**
 * Pure totals of a bill: quota per line = base × rate rounded to the cent
 * (the supplier's printed quota wins when it differs by ≤ 0.01), retention per
 * line = base × retentionRate rounded (or the explicit override), header
 * totals as sums of the rounded lines, total = base + tax − retention.
 * Throws 400 LINE_QUOTA_MISMATCH / TOTAL_MISMATCH.
 */
export function computeBillTotals(lines: ReadonlyArray<z.output<typeof lineSchema>>, retentionRate: Decimal | null, expectedTotal?: Decimal | null): BillTotals {
  const computed: ComputedBillLine[] = lines.map((line, index) => {
    const rateCode = assertSupportedRate(line.taxRate, `Línea ${index + 1}: tipo de IVA`);
    const base = round2(line.base);
    const expectedQuota = pct(base, line.taxRate);
    let quota = expectedQuota;
    if (line.quota !== undefined) {
      const given = round2(line.quota);
      if (given.minus(expectedQuota).abs().gt(dec("0.01"))) {
        throw typed(400, "LINE_QUOTA_MISMATCH", `Línea ${index + 1}: la cuota ${money(given)} no corresponde a ${money(base)} × ${line.taxRate.toFixed(2)} % = ${money(expectedQuota)}.`, {
          lineNo: index + 1,
          given: money(given),
          expected: money(expectedQuota)
        });
      }
      quota = given;
    }
    const retention = line.retention !== undefined ? round2(line.retention) : retentionRate && !retentionRate.isZero() ? pct(base, retentionRate) : ZERO;
    if (retention.gt(base)) {
      throw typed(400, "LINE_RETENTION_MISMATCH", `Línea ${index + 1}: la retención ${money(retention)} supera la base ${money(base)}.`, { lineNo: index + 1 });
    }
    return {
      lineNo: index + 1,
      description: line.description,
      expenseAccountCode: line.expenseAccountCode,
      base,
      rateCode,
      taxRate: dec(rateCode),
      quota,
      retention,
      costCenterId: line.costCenterId ?? null,
      investmentGood: line.investmentGood === true
    };
  });
  const baseTotal = sum(computed.map((l) => l.base));
  const taxTotal = sum(computed.map((l) => l.quota));
  const retentionAmount = sum(computed.map((l) => l.retention));
  const total = baseTotal.plus(taxTotal).minus(retentionAmount);
  if (expectedTotal !== undefined && expectedTotal !== null && !round2(expectedTotal).equals(total)) {
    throw typed(400, "TOTAL_MISMATCH", `El total indicado ${money(expectedTotal)} no cuadra con las líneas: base ${money(baseTotal)} + IVA ${money(taxTotal)} − retención ${money(retentionAmount)} = ${money(total)}.`, {
      expectedTotal: money(expectedTotal),
      computedTotal: money(total),
      baseTotal: money(baseTotal),
      taxTotal: money(taxTotal),
      retentionAmount: money(retentionAmount)
    });
  }
  return { lines: computed, baseTotal, taxTotal, retentionAmount, total };
}

/** 400 Proveedores when any line is a purchase (60x), otherwise 410 Acreedores por prestaciones de servicios. */
export function defaultPayableAccount(lines: ReadonlyArray<{ expenseAccountCode: string }>): "400" | "410" {
  return lines.some((l) => l.expenseAccountCode.startsWith("60")) ? "400" : "410";
}

/**
 * Journal lines of the accrual entry (pure): D expense per line / D 472.rate
 * per rate group with taxBase / H 4751 retention / H payable total.
 */
export function buildAccrualLines(totals: BillTotals, payableAccountCode: string, supplierLabel: string): LedgerLineInput[] {
  const lines: LedgerLineInput[] = totals.lines.map((line) => ({
    accountCode: line.expenseAccountCode,
    debit: line.base,
    description: line.description,
    costCenterId: line.costCenterId,
    taxRateCode: line.rateCode
  }));
  for (const group of groupInputVatRows(totals.lines)) {
    const account = inputVatAccountFor(group.rateCode);
    if (!account || group.quota.isZero()) continue;
    lines.push({
      accountCode: account,
      debit: group.quota,
      description: `IVA soportado ${group.rateCode} %${group.investmentGood ? " (bienes de inversión)" : ""}`,
      taxRateCode: group.rateCode,
      taxBase: group.base
    });
  }
  if (!totals.retentionAmount.isZero()) {
    lines.push({ accountCode: "4751", credit: totals.retentionAmount, description: `Retención IRPF ${supplierLabel}` });
  }
  lines.push({ accountCode: payableAccountCode, credit: totals.total, description: `Factura recibida ${supplierLabel}` });
  return lines;
}

// ---------------------------------------------------------------------------
// DTOs
// ---------------------------------------------------------------------------

export type SupplierBillLineDto = {
  id: string;
  lineNo: number;
  description: string;
  expenseAccountCode: string;
  base: string;
  taxRate: string;
  quota: string;
  retention: string;
  costCenterId: string | null;
  investmentGood: boolean;
  fixedAssetId: string | null;
};

export type SupplierBillDto = {
  id: string;
  organizationId: string;
  propertyId: string;
  supplierId: string | null;
  supplierName: string | null;
  supplierTaxId: string | null;
  invoiceNumber: string | null;
  issueDate: string | null;
  dueDate: string | null;
  paymentDate: string | null;
  baseTotal: string;
  taxTotal: string;
  retentionRate: string | null;
  retentionAmount: string;
  retentionRowCode: string | null;
  total: string;
  payableAccountCode: string | null;
  status: BillStatus;
  hasAttachment: boolean;
  journalEntryId: string | null;
  paidJournalEntryId: string | null;
  postedAt: string | null;
  approvedAt: string | null;
  approvedBy: string | null;
  cancelledAt: string | null;
  createdAt: string;
  updatedAt: string;
  lines: SupplierBillLineDto[];
};

export type SupplierBillDetailDto = SupplierBillDto & {
  vatRows: VatBookRowDto[];
  accrualEntry: LedgerEntryResult | null;
  paymentEntry: LedgerEntryResult | null;
};

type BillRow = Prisma.SupplierBillGetPayload<{ include: { lines: true } }>;

function toLineDto(row: BillRow["lines"][number]): SupplierBillLineDto {
  return {
    id: row.id,
    lineNo: row.lineNo,
    description: row.description,
    expenseAccountCode: row.expenseAccountCode,
    base: money(row.base),
    taxRate: dec(row.taxRate).toFixed(2),
    quota: money(row.quota),
    retention: money(row.retention),
    costCenterId: row.costCenterId ?? null,
    investmentGood: row.investmentGood,
    fixedAssetId: row.fixedAssetId ?? null
  };
}

function toDto(row: BillRow): SupplierBillDto {
  return {
    id: row.id,
    organizationId: row.organizationId ?? "",
    propertyId: row.propertyId,
    supplierId: row.supplierId ?? null,
    supplierName: row.supplierName ?? null,
    supplierTaxId: row.supplierTaxId ?? null,
    invoiceNumber: row.invoiceNumber ?? null,
    issueDate: dayOf(row.issueDate),
    dueDate: dayOf(row.dueDate),
    paymentDate: dayOf(row.paymentDate),
    baseTotal: money(row.baseTotal),
    taxTotal: money(row.taxTotal),
    retentionRate: row.retentionRate === null || row.retentionRate === undefined ? null : dec(row.retentionRate).toFixed(2),
    retentionAmount: money(row.retentionAmount ?? ZERO),
    retentionRowCode: row.rowCode ?? null,
    total: money(row.total),
    payableAccountCode: row.suggestedAccountCode ?? null,
    status: row.status as BillStatus,
    hasAttachment: Boolean(row.documentObjectKey),
    journalEntryId: row.journalEntryId ?? null,
    paidJournalEntryId: row.paidJournalEntryId ?? null,
    postedAt: row.postedAt ? row.postedAt.toISOString() : null,
    approvedAt: row.approvedAt ? row.approvedAt.toISOString() : null,
    approvedBy: row.approvedBy ?? null,
    cancelledAt: row.cancelledAt ? row.cancelledAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    lines: [...row.lines].sort((a, b) => a.lineNo - b.lineNo).map(toLineDto)
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function organizationOfProperty(tx: Tx | typeof prisma, propertyId: string): Promise<string> {
  const property = await tx.property.findUnique({ where: { id: propertyId }, select: { organizationId: true } });
  if (!property) throw new NotFoundError("Propiedad no encontrada.");
  return property.organizationId;
}

async function requireBill(tx: Tx | typeof prisma, propertyId: string, billId: string): Promise<BillRow> {
  const row = await tx.supplierBill.findFirst({ where: { id: billId, propertyId }, include: { lines: true } });
  if (!row) throw new NotFoundError("Factura recibida no encontrada.");
  return row;
}

function assertStatus(row: BillRow, allowed: readonly BillStatus[], action: string): void {
  if (!allowed.includes(row.status as BillStatus)) {
    throw typed(409, "INVALID_STATUS_TRANSITION", `No se puede ${action} una factura en estado «${row.status}» (admitidos: ${allowed.join(", ")}).`, {
      status: row.status,
      allowed
    });
  }
}

/** Validates every line account against the organisation's chart: postable, 6xx (or 20x/21x for an investment good). */
async function assertLineAccounts(tx: Tx, organizationId: string, lines: ReadonlyArray<ComputedBillLine>): Promise<void> {
  const codes = Array.from(new Set(lines.map((l) => l.expenseAccountCode)));
  const accounts = await tx.account.findMany({ where: { organizationId, code: { in: codes } }, select: { code: true, group: true, isPostable: true } });
  const byCode = new Map(accounts.map((a) => [a.code, a]));
  for (const line of lines) {
    const account = byCode.get(line.expenseAccountCode);
    if (!account) throw typed(400, "EXPENSE_ACCOUNT_INVALID", `Línea ${line.lineNo}: la cuenta ${line.expenseAccountCode} no existe en el plan de la organización.`, { lineNo: line.lineNo, accountCode: line.expenseAccountCode });
    if (!account.isPostable) throw typed(400, "EXPENSE_ACCOUNT_INVALID", `Línea ${line.lineNo}: la cuenta ${line.expenseAccountCode} es una cabecera y no admite apuntes.`, { lineNo: line.lineNo, accountCode: line.expenseAccountCode });
    if (line.investmentGood && account.group !== 2) {
      throw typed(400, "EXPENSE_ACCOUNT_INVALID", `Línea ${line.lineNo}: un bien de inversión se contabiliza en una cuenta 20x/21x, no en ${line.expenseAccountCode}.`, { lineNo: line.lineNo, accountCode: line.expenseAccountCode });
    }
    if (!line.investmentGood && account.group !== 6) {
      throw typed(400, "EXPENSE_ACCOUNT_INVALID", `Línea ${line.lineNo}: la cuenta ${line.expenseAccountCode} no es de gasto (6xx); marca la línea como bien de inversión si es inmovilizado.`, { lineNo: line.lineNo, accountCode: line.expenseAccountCode });
    }
  }
}

function inlineAttachmentUri(attachment: z.output<typeof attachmentSchema>): string {
  const base64 = attachment.base64.replace(/\s/g, "");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64) || base64.length % 4 !== 0) {
    throw typed(400, "ATTACHMENT_INVALID", "El adjunto no es base64 válido.");
  }
  const bytes = Buffer.from(base64, "base64").length;
  if (bytes > ATTACHMENT_MAX_BYTES) {
    throw typed(413, "ATTACHMENT_TOO_LARGE", `El adjunto ocupa ${bytes} bytes; el máximo en línea es ${ATTACHMENT_MAX_BYTES} bytes (usa el almacén de objetos y envía documentObjectKey).`, { bytes, max: ATTACHMENT_MAX_BYTES });
  }
  return `data:${attachment.mimeType};name=${encodeURIComponent(attachment.fileName)};base64,${base64}`;
}

async function assertNotDuplicate(tx: Tx, input: { organizationId: string; supplierId: string | null; supplierTaxId: string | null; invoiceNumber: string; issueDate: Date; exceptId?: string }): Promise<void> {
  const where: Prisma.SupplierBillWhereInput = {
    organizationId: input.organizationId,
    invoiceNumber: input.invoiceNumber,
    status: { not: "cancelled" },
    ...(input.exceptId ? { id: { not: input.exceptId } } : {}),
    ...(input.supplierId
      ? { supplierId: input.supplierId }
      : { supplierId: null, supplierTaxId: input.supplierTaxId, issueDate: input.issueDate })
  };
  const existing = await tx.supplierBill.findFirst({ where, select: { id: true, status: true } });
  if (existing) {
    throw typed(409, "SUPPLIER_BILL_DUPLICATE", `La factura ${input.invoiceNumber} de este proveedor ya está registrada (${existing.status}).`, { supplierBillId: existing.id, status: existing.status });
  }
}

type ResolvedHeader = {
  supplierId: string | null;
  supplierName: string;
  supplierTaxId: string | null;
  retentionRate: Decimal | null;
  retentionRowCode: string | null;
  dueDate: Date | null;
};

async function resolveHeader(tx: Tx, organizationId: string, data: z.output<typeof billSchema>): Promise<ResolvedHeader> {
  let supplierName = data.supplierName ?? null;
  let supplierTaxId: string | null = null;
  let retentionRate: Decimal | null = data.retentionRate === undefined ? null : data.retentionRate;
  let paymentTermDays: number | null = null;
  if (data.supplierId) {
    const supplier = await requireSupplier(tx, organizationId, data.supplierId);
    supplierName = supplierName ?? supplier.name;
    supplierTaxId = data.supplierTaxId !== undefined && data.supplierTaxId !== null ? resolveSupplierTaxId(data.supplierTaxId, supplier.countryCode).taxId : supplier.taxId;
    if (data.retentionRate === undefined && supplier.retentionRate !== null) retentionRate = dec(supplier.retentionRate);
    const terms = (supplier.paymentTermsJson && typeof supplier.paymentTermsJson === "object" ? supplier.paymentTermsJson : {}) as { days?: number };
    paymentTermDays = typeof terms.days === "number" ? terms.days : null;
  } else {
    if (!supplierName) throw typed(400, "SUPPLIER_REQUIRED", "Indica supplierId o supplierName.");
    supplierTaxId = resolveSupplierTaxId(data.supplierTaxId, "ES").taxId;
  }
  const effectiveRate = retentionRate && !retentionRate.isZero() ? retentionRate : null;
  const retentionRowCode = effectiveRate ? (data.retentionRowCode ?? defaultRetentionRowCode(effectiveRate)) : null;
  const dueDate = data.dueDate !== undefined && data.dueDate !== null
    ? data.dueDate
    : paymentTermDays !== null
      ? new Date(data.issueDate.getTime() + paymentTermDays * 86_400_000)
      : null;
  if (dueDate && dueDate < data.issueDate) throw typed(400, "DUE_DATE_BEFORE_ISSUE", "El vencimiento no puede ser anterior a la fecha de factura.");
  return { supplierId: data.supplierId ?? null, supplierName: supplierName!, supplierTaxId, retentionRate: effectiveRate, retentionRowCode, dueDate };
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export type ListBillsFilter = {
  propertyId: string;
  status?: BillStatus;
  supplierId?: string;
  from?: string;
  to?: string;
  dueBefore?: string;
  q?: string;
  limit?: number;
};

export async function listSupplierBills(filter: ListBillsFilter): Promise<SupplierBillDto[]> {
  const q = filter.q?.trim();
  const rows = await prisma.supplierBill.findMany({
    where: {
      propertyId: filter.propertyId,
      ...(filter.status ? { status: filter.status } : {}),
      ...(filter.supplierId ? { supplierId: filter.supplierId } : {}),
      ...(filter.from || filter.to ? { issueDate: { ...(filter.from ? { gte: utcDay(filter.from) } : {}), ...(filter.to ? { lte: utcDay(filter.to) } : {}) } } : {}),
      ...(filter.dueBefore ? { dueDate: { lte: utcDay(filter.dueBefore) } } : {}),
      ...(q ? { OR: [{ invoiceNumber: { contains: q, mode: "insensitive" } }, { supplierName: { contains: q, mode: "insensitive" } }, { supplierTaxId: { contains: q.toUpperCase() } }] } : {})
    },
    include: { lines: true },
    orderBy: [{ issueDate: "desc" }, { createdAt: "desc" }],
    take: Math.min(Math.max(filter.limit ?? 200, 1), 500)
  });
  return rows.map(toDto);
}

export async function getSupplierBill(propertyId: string, billId: string): Promise<SupplierBillDetailDto> {
  const row = await requireBill(prisma, propertyId, billId);
  const organizationId = row.organizationId ?? (await organizationOfProperty(prisma, propertyId));
  const [vatRows, accrualEntry, paymentEntry] = await prisma.$transaction(async (tx) => [
    await listVatRowsOf(tx, organizationId, "supplier_bill", row.id),
    row.journalEntryId ? await loadEntryDto(tx, organizationId, row.journalEntryId) : null,
    row.paidJournalEntryId ? await loadEntryDto(tx, organizationId, row.paidJournalEntryId) : null
  ]);
  return { ...toDto(row), vatRows, accrualEntry, paymentEntry };
}

async function loadEntryDto(tx: Tx, organizationId: string, journalEntryId: string): Promise<LedgerEntryResult | null> {
  const entry = await tx.journalEntry.findFirst({ where: { id: journalEntryId, organizationId } });
  if (!entry) return null;
  const rows = await tx.journalLine.findMany({ where: { journalEntryId }, orderBy: { id: "asc" } });
  return {
    id: entry.id,
    entryNumber: entry.entryNumber ?? null,
    fiscalYearCode: entry.fiscalYearCode ?? null,
    entryDate: entry.entryDate.toISOString().slice(0, 10),
    sourceType: entry.sourceType,
    sourceId: entry.sourceId ?? null,
    description: entry.description ?? null,
    reference: entry.reference ?? null,
    status: entry.status,
    reversalOfId: entry.reversalOfId ?? null,
    reversedById: entry.reversedById ?? null,
    totalDebit: money(sum(rows.map((r) => r.debit))),
    totalCredit: money(sum(rows.map((r) => r.credit))),
    lines: rows.map((r) => ({
      id: r.id,
      accountId: r.accountId,
      accountCode: r.accountCode ?? r.accountId,
      debit: money(r.debit),
      credit: money(r.credit),
      description: r.description ?? null,
      taxRateCode: r.taxRateCode ?? null,
      taxBase: r.taxBase === null || r.taxBase === undefined ? null : money(r.taxBase),
      costCenterId: r.costCenterId ?? null
    })),
    alreadyExisted: true
  };
}

export async function getSupplierBillAttachment(propertyId: string, billId: string): Promise<{ inline: boolean; documentObjectKey: string | null; mimeType: string | null; fileName: string | null; base64: string | null }> {
  const row = await requireBill(prisma, propertyId, billId);
  const key = row.documentObjectKey ?? null;
  if (!key) return { inline: false, documentObjectKey: null, mimeType: null, fileName: null, base64: null };
  const match = /^data:([^;]+);name=([^;]*);base64,(.*)$/s.exec(key);
  if (!match) return { inline: false, documentObjectKey: key, mimeType: null, fileName: null, base64: null };
  return { inline: true, documentObjectKey: null, mimeType: match[1]!, fileName: decodeURIComponent(match[2]!), base64: match[3]! };
}

// ---------------------------------------------------------------------------
// Aging / due dates
// ---------------------------------------------------------------------------

export const AGING_BUCKETS = ["notDue", "d1_30", "d31_60", "d61_90", "d90plus"] as const;
export type AgingBucket = (typeof AGING_BUCKETS)[number];

export function agingBucketOf(daysPastDue: number): AgingBucket {
  if (daysPastDue <= 0) return "notDue";
  if (daysPastDue <= 30) return "d1_30";
  if (daysPastDue <= 60) return "d31_60";
  if (daysPastDue <= 90) return "d61_90";
  return "d90plus";
}

export type AgingReport = {
  asOf: string;
  currency: "EUR";
  totals: Record<AgingBucket, string> & { outstanding: string; count: number };
  suppliers: Array<{
    supplierId: string | null;
    supplierName: string | null;
    supplierTaxId: string | null;
    outstanding: string;
    buckets: Record<AgingBucket, string>;
    bills: Array<{ id: string; invoiceNumber: string | null; issueDate: string | null; dueDate: string | null; daysPastDue: number; bucket: AgingBucket; total: string }>;
  }>;
};

/** Open items = posted bills (accrued, unpaid); due date falls back to the issue date. */
export async function getPayablesAging(input: { propertyId: string; asOf?: string }): Promise<AgingReport> {
  const asOfDay = input.asOf && /^\d{4}-\d{2}-\d{2}$/.test(input.asOf) ? input.asOf : new Date().toISOString().slice(0, 10);
  const asOf = utcDay(asOfDay);
  const rows = await prisma.supplierBill.findMany({
    where: { propertyId: input.propertyId, status: "posted" },
    select: { id: true, supplierId: true, supplierName: true, supplierTaxId: true, invoiceNumber: true, issueDate: true, dueDate: true, total: true },
    orderBy: [{ dueDate: "asc" }, { issueDate: "asc" }]
  });
  const empty = (): Record<AgingBucket, Decimal> => ({ notDue: ZERO, d1_30: ZERO, d31_60: ZERO, d61_90: ZERO, d90plus: ZERO });
  const totals = empty();
  const bySupplier = new Map<string, { supplierId: string | null; supplierName: string | null; supplierTaxId: string | null; buckets: Record<AgingBucket, Decimal>; bills: AgingReport["suppliers"][number]["bills"] }>();
  let outstanding = ZERO;
  for (const row of rows) {
    const due = row.dueDate ?? row.issueDate ?? asOf;
    const daysPastDue = daysBetween(due, asOf);
    const bucket = agingBucketOf(daysPastDue);
    const total = dec(row.total);
    outstanding = outstanding.plus(total);
    totals[bucket] = totals[bucket].plus(total);
    const key = row.supplierId ?? `nif:${row.supplierTaxId ?? row.supplierName ?? row.id}`;
    const group = bySupplier.get(key) ?? { supplierId: row.supplierId ?? null, supplierName: row.supplierName ?? null, supplierTaxId: row.supplierTaxId ?? null, buckets: empty(), bills: [] };
    group.buckets[bucket] = group.buckets[bucket].plus(total);
    group.bills.push({ id: row.id, invoiceNumber: row.invoiceNumber ?? null, issueDate: dayOf(row.issueDate), dueDate: dayOf(row.dueDate), daysPastDue, bucket, total: money(total) });
    bySupplier.set(key, group);
  }
  const fmt = (b: Record<AgingBucket, Decimal>): Record<AgingBucket, string> => ({ notDue: money(b.notDue), d1_30: money(b.d1_30), d31_60: money(b.d31_60), d61_90: money(b.d61_90), d90plus: money(b.d90plus) });
  return {
    asOf: asOfDay,
    currency: "EUR",
    totals: { ...fmt(totals), outstanding: money(outstanding), count: rows.length },
    suppliers: Array.from(bySupplier.values())
      .map((g) => ({ supplierId: g.supplierId, supplierName: g.supplierName, supplierTaxId: g.supplierTaxId, outstanding: money(sum(Object.values(g.buckets))), buckets: fmt(g.buckets), bills: g.bills }))
      .sort((a, b) => dec(b.outstanding).comparedTo(dec(a.outstanding)))
  };
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

type CommandInput = { context: UserContext; propertyId: string; correlationId: string };

export async function createSupplierBill(input: CommandInput & { body: unknown }): Promise<SupplierBillDto> {
  const data = parseOr400(billSchema, input.body ?? {}, "Factura recibida");
  const organizationId = await organizationOfProperty(prisma, input.propertyId);
  const row = await prisma.$transaction(async (tx) => {
    const header = await resolveHeader(tx, organizationId, data);
    const totals = computeBillTotals(data.lines, header.retentionRate, data.expectedTotal ?? null);
    await assertLineAccounts(tx, organizationId, totals.lines);
    await assertNotDuplicate(tx, { organizationId, supplierId: header.supplierId, supplierTaxId: header.supplierTaxId, invoiceNumber: data.invoiceNumber, issueDate: data.issueDate });
    const documentObjectKey = data.attachment ? inlineAttachmentUri(data.attachment) : (data.documentObjectKey ?? null);
    return tx.supplierBill.create({
      data: {
        propertyId: input.propertyId,
        organizationId,
        supplierId: header.supplierId,
        supplierName: header.supplierName,
        supplierTaxId: header.supplierTaxId,
        invoiceNumber: data.invoiceNumber,
        issueDate: data.issueDate,
        dueDate: header.dueDate,
        baseTotal: totals.baseTotal,
        taxTotal: totals.taxTotal,
        retentionRate: header.retentionRate,
        retentionAmount: totals.retentionAmount,
        rowCode: header.retentionRowCode,
        total: totals.total,
        suggestedAccountCode: data.payableAccountCode ?? defaultPayableAccount(totals.lines),
        roomId: data.roomId ?? null,
        status: "draft",
        documentObjectKey,
        lines: {
          create: totals.lines.map((l) => ({
            lineNo: l.lineNo,
            description: l.description,
            expenseAccountCode: l.expenseAccountCode,
            base: l.base,
            taxRate: l.taxRate,
            quota: l.quota,
            retention: l.retention,
            costCenterId: l.costCenterId,
            investmentGood: l.investmentGood
          }))
        }
      },
      include: { lines: true }
    });
  });
  const dto = toDto(row);
  recordAuditEvent({
    organizationId,
    propertyId: input.propertyId,
    actorUserId: input.context.userId,
    actorType: "user",
    action: "SUPPLIER_BILL_REGISTERED",
    entityType: "supplier_bill",
    entityId: dto.id,
    afterJson: { supplierName: dto.supplierName, supplierTaxId: dto.supplierTaxId, invoiceNumber: dto.invoiceNumber, total: dto.total, status: dto.status },
    correlationId: input.correlationId
  });
  return dto;
}

export async function updateSupplierBill(input: CommandInput & { billId: string; body: unknown }): Promise<SupplierBillDto> {
  const data = parseOr400(billSchema, input.body ?? {}, "Factura recibida");
  const row = await prisma.$transaction(async (tx) => {
    const before = await requireBill(tx, input.propertyId, input.billId);
    assertStatus(before, ["draft"], "modificar");
    const organizationId = before.organizationId ?? (await organizationOfProperty(tx, input.propertyId));
    const header = await resolveHeader(tx, organizationId, data);
    const totals = computeBillTotals(data.lines, header.retentionRate, data.expectedTotal ?? null);
    await assertLineAccounts(tx, organizationId, totals.lines);
    await assertNotDuplicate(tx, { organizationId, supplierId: header.supplierId, supplierTaxId: header.supplierTaxId, invoiceNumber: data.invoiceNumber, issueDate: data.issueDate, exceptId: before.id });
    const documentObjectKey = data.attachment ? inlineAttachmentUri(data.attachment) : data.documentObjectKey !== undefined ? data.documentObjectKey : before.documentObjectKey;
    await tx.supplierBillLine.deleteMany({ where: { supplierBillId: before.id } });
    return tx.supplierBill.update({
      where: { id: before.id },
      data: {
        organizationId,
        supplierId: header.supplierId,
        supplierName: header.supplierName,
        supplierTaxId: header.supplierTaxId,
        invoiceNumber: data.invoiceNumber,
        issueDate: data.issueDate,
        dueDate: header.dueDate,
        baseTotal: totals.baseTotal,
        taxTotal: totals.taxTotal,
        retentionRate: header.retentionRate,
        retentionAmount: totals.retentionAmount,
        rowCode: header.retentionRowCode,
        total: totals.total,
        suggestedAccountCode: data.payableAccountCode ?? defaultPayableAccount(totals.lines),
        roomId: data.roomId ?? null,
        documentObjectKey,
        lines: {
          create: totals.lines.map((l) => ({
            lineNo: l.lineNo,
            description: l.description,
            expenseAccountCode: l.expenseAccountCode,
            base: l.base,
            taxRate: l.taxRate,
            quota: l.quota,
            retention: l.retention,
            costCenterId: l.costCenterId,
            investmentGood: l.investmentGood
          }))
        }
      },
      include: { lines: true }
    });
  });
  const dto = toDto(row);
  recordAuditEvent({
    organizationId: dto.organizationId,
    propertyId: input.propertyId,
    actorUserId: input.context.userId,
    actorType: "user",
    action: "SUPPLIER_BILL_UPDATED",
    entityType: "supplier_bill",
    entityId: dto.id,
    afterJson: { invoiceNumber: dto.invoiceNumber, total: dto.total, lines: dto.lines.length },
    correlationId: input.correlationId
  });
  return dto;
}

export async function approveSupplierBill(input: CommandInput & { billId: string; body?: unknown }): Promise<SupplierBillDto> {
  parseOr400(approveSchema, input.body ?? {}, "Aprobación");
  const row = await prisma.$transaction(async (tx) => {
    const before = await requireBill(tx, input.propertyId, input.billId);
    assertStatus(before, ["draft"], "aprobar");
    return tx.supplierBill.update({ where: { id: before.id }, data: { status: "approved", approvedAt: new Date(), approvedBy: input.context.userId }, include: { lines: true } });
  });
  const dto = toDto(row);
  recordAuditEvent({
    organizationId: dto.organizationId,
    propertyId: input.propertyId,
    actorUserId: input.context.userId,
    actorType: "user",
    action: "SUPPLIER_BILL_APPROVED",
    entityType: "supplier_bill",
    entityId: dto.id,
    afterJson: { status: dto.status, total: dto.total },
    correlationId: input.correlationId
  });
  return dto;
}

/** Accrual: journal entry + VAT book rows + withholding record + fixed assets, one transaction. Idempotent (an already posted bill returns as-is). */
export async function postSupplierBill(input: CommandInput & { billId: string; body?: unknown }): Promise<SupplierBillDetailDto> {
  parseOr400(approveSchema, input.body ?? {}, "Contabilización");
  const posted = await prisma.$transaction(async (tx) => {
    const before = await requireBill(tx, input.propertyId, input.billId);
    if (before.status === "posted" || before.status === "paid") return { row: before, entry: null as LedgerEntryResult | null };
    assertStatus(before, ["approved"], "contabilizar");
    const organizationId = before.organizationId ?? (await organizationOfProperty(tx, input.propertyId));
    if (!before.supplierTaxId) {
      throw typed(400, "SUPPLIER_NIF_REQUIRED", "Una factura completa necesita el NIF del proveedor para el libro de recibidas (usa un gasto menor para tickets sin NIF).");
    }
    if (!before.issueDate) throw typed(400, "ISSUE_DATE_REQUIRED", "La factura necesita fecha de expedición.");
    const lines: ComputedBillLine[] = [...before.lines].sort((a, b) => a.lineNo - b.lineNo).map((l) => ({
      lineNo: l.lineNo,
      description: l.description,
      expenseAccountCode: l.expenseAccountCode,
      base: dec(l.base),
      rateCode: assertSupportedRate(l.taxRate, `Línea ${l.lineNo}: tipo de IVA`),
      taxRate: dec(l.taxRate),
      quota: dec(l.quota),
      retention: dec(l.retention),
      costCenterId: l.costCenterId ?? null,
      investmentGood: l.investmentGood
    }));
    const totals: BillTotals = {
      lines,
      baseTotal: sum(lines.map((l) => l.base)),
      taxTotal: sum(lines.map((l) => l.quota)),
      retentionAmount: sum(lines.map((l) => l.retention)),
      total: dec(before.total)
    };
    if (!totals.baseTotal.plus(totals.taxTotal).minus(totals.retentionAmount).equals(totals.total)) {
      throw typed(409, "TOTAL_MISMATCH", "Los totales de la factura no cuadran con sus líneas; edítala antes de contabilizar.", {
        baseTotal: money(totals.baseTotal),
        taxTotal: money(totals.taxTotal),
        retentionAmount: money(totals.retentionAmount),
        total: money(totals.total)
      });
    }
    await assertLineAccounts(tx, organizationId, lines);
    const payableAccountCode = before.suggestedAccountCode && (PAYABLE_ACCOUNT_CODES as readonly string[]).includes(before.suggestedAccountCode) ? before.suggestedAccountCode : defaultPayableAccount(lines);
    const label = `${before.supplierName ?? ""} ${before.invoiceNumber ?? ""}`.trim();
    const entry = await getLedgerPort().post(tx, {
      organizationId,
      propertyId: input.propertyId,
      entryDate: before.issueDate,
      sourceType: "supplier_bill",
      sourceId: before.id,
      description: `Factura recibida ${label}`,
      reference: before.invoiceNumber,
      createdBy: input.context.userId,
      lines: buildAccrualLines(totals, payableAccountCode, label)
    });
    await writeInputVatRows(tx, {
      organizationId,
      propertyId: input.propertyId,
      date: before.issueDate,
      number: before.invoiceNumber,
      counterpartyNif: before.supplierTaxId,
      counterpartyName: before.supplierName ?? null,
      sourceType: "supplier_bill",
      sourceId: before.id,
      deductible: true,
      rows: groupInputVatRows(lines)
    });
    if (!totals.retentionAmount.isZero()) {
      const rowCode = before.rowCode ?? "02";
      const draft = {
        organizationId,
        propertyId: input.propertyId,
        sourceType: "vendor_invoice",
        sourceId: before.id,
        recipientNif: before.supplierTaxId,
        recipientName: before.supplierName ?? null,
        grossAmount: totals.baseTotal,
        retentionRate: before.retentionRate ?? totals.retentionAmount.div(totals.baseTotal).times(100).toDecimalPlaces(2),
        retentionAmount: totals.retentionAmount,
        rowCode,
        paymentDate: before.issueDate
      };
      const existing = await tx.withholdingTaxRecord.findFirst({ where: { sourceType: "vendor_invoice", sourceId: before.id }, select: { id: true } });
      if (existing) await tx.withholdingTaxRecord.update({ where: { id: existing.id }, data: draft });
      else await tx.withholdingTaxRecord.create({ data: draft });
    }
    for (const line of lines.filter((l) => l.investmentGood)) {
      const dbLine = before.lines.find((l) => l.lineNo === line.lineNo)!;
      if (dbLine.fixedAssetId) continue;
      const asset = await registerFixedAssetFromBillLine(tx, {
        organizationId,
        propertyId: input.propertyId,
        supplierBillId: before.id,
        name: line.description,
        accountCode: line.expenseAccountCode,
        acquisitionDate: before.issueDate,
        acquisitionCost: line.base
      });
      await tx.supplierBillLine.update({ where: { id: dbLine.id }, data: { fixedAssetId: asset.id } });
    }
    const row = await tx.supplierBill.update({
      where: { id: before.id },
      data: { status: "posted", journalEntryId: entry.id, postedAt: new Date(), suggestedAccountCode: payableAccountCode },
      include: { lines: true }
    });
    return { row, entry };
  });
  const dto = await getSupplierBill(input.propertyId, posted.row.id);
  if (posted.entry) {
    recordAuditEvent({
      organizationId: dto.organizationId,
      propertyId: input.propertyId,
      actorUserId: input.context.userId,
      actorType: "user",
      action: "SUPPLIER_BILL_POSTED",
      entityType: "supplier_bill",
      entityId: dto.id,
      afterJson: { status: dto.status, journalEntryId: dto.journalEntryId, entryNumber: posted.entry.entryNumber, total: dto.total },
      correlationId: input.correlationId
    });
    recordDomainEvent({
      organizationId: dto.organizationId,
      propertyId: input.propertyId,
      entityType: "supplier_bill",
      entityId: dto.id,
      eventType: "SupplierBillPosted",
      payload: { journalEntryId: dto.journalEntryId, baseTotal: dto.baseTotal, taxTotal: dto.taxTotal, retentionAmount: dto.retentionAmount, total: dto.total, supplierTaxId: dto.supplierTaxId },
      actorType: "user",
      actorUserId: input.context.userId,
      correlationId: input.correlationId
    });
  }
  return dto;
}

/** Payment of a posted bill (full amount): D 400|410 / H 572|570, dated on the payment day. */
export async function paySupplierBill(input: CommandInput & { billId: string; body: unknown }): Promise<SupplierBillDetailDto> {
  const data = parseOr400(paySchema, input.body ?? {}, "Pago");
  const paidWith = data.paidWith ?? (data.counterAccountCode?.startsWith("570") ? "cash" : "bank");
  const counterAccountCode = data.counterAccountCode ?? (paidWith === "cash" ? "570" : "572");
  if (!/^57[02](\.\d+|\d)?$/.test(counterAccountCode)) {
    throw typed(400, "COUNTER_ACCOUNT_INVALID", `La cuenta de pago debe ser 570 (caja) o 572 (bancos) o una subcuenta: ${counterAccountCode}.`, { accountCode: counterAccountCode });
  }
  const result = await prisma.$transaction(async (tx) => {
    const before = await requireBill(tx, input.propertyId, input.billId);
    if (before.status === "paid") return { row: before, entry: null as LedgerEntryResult | null };
    assertStatus(before, ["posted"], "pagar");
    const organizationId = before.organizationId ?? (await organizationOfProperty(tx, input.propertyId));
    if (before.issueDate && data.paymentDate < before.issueDate) {
      throw typed(400, "PAYMENT_BEFORE_ISSUE", "La fecha de pago no puede ser anterior a la fecha de factura.");
    }
    const payableAccountCode = before.suggestedAccountCode && (PAYABLE_ACCOUNT_CODES as readonly string[]).includes(before.suggestedAccountCode) ? before.suggestedAccountCode : "410";
    const label = `${before.supplierName ?? ""} ${before.invoiceNumber ?? ""}`.trim();
    const entry = await getLedgerPort().post(tx, {
      organizationId,
      propertyId: input.propertyId,
      entryDate: data.paymentDate,
      sourceType: "supplier_bill_payment",
      sourceId: before.id,
      description: `Pago factura ${label}`,
      reference: data.reference ?? before.invoiceNumber,
      createdBy: input.context.userId,
      lines: [
        { accountCode: payableAccountCode, debit: dec(before.total), description: `Pago ${label}` },
        { accountCode: counterAccountCode, credit: dec(before.total), description: paidWith === "cash" ? "Pago en efectivo" : "Transferencia bancaria" }
      ]
    });
    await tx.withholdingTaxRecord.updateMany({ where: { sourceType: "vendor_invoice", sourceId: before.id }, data: { paymentDate: data.paymentDate } });
    const row = await tx.supplierBill.update({
      where: { id: before.id },
      data: { status: "paid", paymentDate: data.paymentDate, paidJournalEntryId: entry.id },
      include: { lines: true }
    });
    return { row, entry };
  });
  const dto = await getSupplierBill(input.propertyId, result.row.id);
  if (result.entry) {
    recordAuditEvent({
      organizationId: dto.organizationId,
      propertyId: input.propertyId,
      actorUserId: input.context.userId,
      actorType: "user",
      action: "SUPPLIER_BILL_PAID",
      entityType: "supplier_bill",
      entityId: dto.id,
      afterJson: { status: dto.status, paymentDate: dto.paymentDate, paidJournalEntryId: dto.paidJournalEntryId, total: dto.total, counterAccountCode },
      correlationId: input.correlationId
    });
    recordDomainEvent({
      organizationId: dto.organizationId,
      propertyId: input.propertyId,
      entityType: "supplier_bill",
      entityId: dto.id,
      eventType: "SupplierBillPaid",
      payload: { paidJournalEntryId: dto.paidJournalEntryId, total: dto.total, paymentDate: dto.paymentDate, counterAccountCode },
      actorType: "user",
      actorUserId: input.context.userId,
      correlationId: input.correlationId
    });
  }
  return dto;
}

/** Cancel: draft/approved without entries; posted → reversal entry + book rows and withholding removed; paid → 409. */
export async function cancelSupplierBill(input: CommandInput & { billId: string; body: unknown }): Promise<SupplierBillDetailDto> {
  const data = parseOr400(cancelSchema, input.body ?? {}, "Anulación");
  const result = await prisma.$transaction(async (tx) => {
    const before = await requireBill(tx, input.propertyId, input.billId);
    if (before.status === "cancelled") return { row: before, reversal: null as LedgerEntryResult | null };
    assertStatus(before, ["draft", "approved", "posted"], "anular");
    const organizationId = before.organizationId ?? (await organizationOfProperty(tx, input.propertyId));
    let reversal: LedgerEntryResult | null = null;
    if (before.status === "posted" && before.journalEntryId) {
      const withAssets = before.lines.filter((l) => l.fixedAssetId);
      if (withAssets.length > 0) {
        throw typed(409, "BILL_HAS_FIXED_ASSETS", "La factura dio de alta inmovilizado: da de baja esos elementos antes de anularla.", { fixedAssetIds: withAssets.map((l) => l.fixedAssetId) });
      }
      reversal = await getLedgerPort().reverse(tx, {
        organizationId,
        journalEntryId: before.journalEntryId,
        entryDate: new Date(new Date().toISOString().slice(0, 10) + "T00:00:00.000Z"),
        sourceType: "reversal",
        sourceId: `supplier_bill_cancel:${before.id}`,
        description: `Anulación factura recibida ${before.invoiceNumber ?? before.id}: ${data.reason}`,
        createdBy: input.context.userId
      });
      await deleteInputVatRows(tx, organizationId, "supplier_bill", before.id);
      await tx.withholdingTaxRecord.deleteMany({ where: { sourceType: "vendor_invoice", sourceId: before.id } });
    }
    const row = await tx.supplierBill.update({ where: { id: before.id }, data: { status: "cancelled", cancelledAt: new Date() }, include: { lines: true } });
    return { row, reversal };
  });
  const dto = await getSupplierBill(input.propertyId, result.row.id);
  recordAuditEvent({
    organizationId: dto.organizationId,
    propertyId: input.propertyId,
    actorUserId: input.context.userId,
    actorType: "user",
    action: "SUPPLIER_BILL_CANCELLED",
    entityType: "supplier_bill",
    entityId: dto.id,
    afterJson: { status: dto.status, reason: data.reason, reversalJournalEntryId: result.reversal?.id ?? null },
    correlationId: input.correlationId
  });
  if (result.reversal) {
    recordDomainEvent({
      organizationId: dto.organizationId,
      propertyId: input.propertyId,
      entityType: "supplier_bill",
      entityId: dto.id,
      eventType: "SupplierBillCancelled",
      payload: { reversalJournalEntryId: result.reversal.id, reason: data.reason, total: dto.total },
      actorType: "user",
      actorUserId: input.context.userId,
      correlationId: input.correlationId
    });
  }
  return dto;
}

export { billSchema as supplierBillSchema, lineSchema as supplierBillLineSchema, paySchema as paySupplierBillSchema, cancelSchema as cancelSupplierBillSchema };
