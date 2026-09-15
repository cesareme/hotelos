// Payables · gastos menores / tickets (Finanzas 2026-09-15).
//
// A quick expense is paid on the spot, so it is registered AND posted in one
// transaction: D 6xx (base, plus the quota when the VAT is not deductible) /
// D 472.rate (deductible quota) / H 570|5721|572 (total). The libro de
// recibidas row carries `deductible`: true only with a full or simplified
// invoice that names the hotel (the caller states it; without a supplier NIF
// the API refuses deductibility). A posted expense is never deleted: `reverse`
// creates the inverse entry and marks it cancelled.

import { prisma } from "@hotelos/database";
import type { Prisma } from "@prisma/client";
import { z } from "zod";
import type { UserContext } from "../../lib/demo-store.js";
import { HttpError, NotFoundError } from "../../lib/http-error.js";
import { recordAuditEvent, recordDomainEvent } from "../audit/audit.service.js";
import { parseOr400 } from "../rate-manager/rate-grid.schemas.js";
import { getLedgerPort, type LedgerEntryResult, type LedgerLineInput } from "./ledger-port.js";
import { dayInput, dayOf, dec, money, moneyInput, pct, percentInput, round2, utcDay, type Decimal } from "./money.js";
import { checkSpanishNif, normalizeNif } from "./validators.js";
import { assertSupportedRate, deleteInputVatRows, inputVatAccountFor, listVatRowsOf, writeInputVatRows, type VatBookRowDto } from "./vat-book.js";
import { ATTACHMENT_MAX_BYTES, ATTACHMENT_MIME_TYPES } from "./supplier-bills.service.js";

type Tx = Prisma.TransactionClient;

export const EXPENSE_PAID_WITH = ["cash", "card", "bank"] as const;
export type ExpensePaidWith = (typeof EXPENSE_PAID_WITH)[number];

/** Contract default (runbook §1.1 ExpensePaidWith): cash→570, card→5721 (company card; 572 when it is a direct-debit card), bank→572. */
export const EXPENSE_COUNTER_ACCOUNTS: Record<ExpensePaidWith, string> = { cash: "570", card: "5721", bank: "572" };
const COUNTER_ACCOUNT_OVERRIDES = ["570", "572", "5721", "5722"] as const;

const attachmentSchema = z
  .object({ fileName: z.string().trim().min(1).max(200), mimeType: z.enum(ATTACHMENT_MIME_TYPES), base64: z.string().min(1) })
  .strict();

const expenseSchema = z
  .object({
    date: dayInput(),
    supplierName: z.string().trim().min(1, "obligatorio").max(200),
    supplierNif: z.string().trim().max(20).nullable().optional(),
    concept: z.string().trim().min(1, "obligatorio").max(300),
    accountCode: z.string().trim().min(3).max(12),
    base: moneyInput({ allowZero: false }),
    taxRate: percentInput(),
    quota: moneyInput().optional(),
    total: moneyInput().optional(),
    paidWith: z.enum(EXPENSE_PAID_WITH),
    counterAccountCode: z.enum(COUNTER_ACCOUNT_OVERRIDES).optional(),
    vatDeductible: z.boolean().optional(),
    costCenterId: z.string().trim().min(1).max(64).nullable().optional(),
    receiptObjectKey: z.string().trim().min(1).max(500).nullable().optional(),
    attachment: attachmentSchema.optional()
  })
  .strict();

const reverseSchema = z.object({ reason: z.string().trim().min(3).max(300) }).strict();

export type ExpenseInput = z.input<typeof expenseSchema>;

function typed(statusCode: number, code: string, message: string, extra: Record<string, unknown> = {}): HttpError {
  return new HttpError(statusCode, message, true, { code, ...extra });
}

export type ComputedExpense = {
  rateCode: string;
  base: Decimal;
  quota: Decimal;
  total: Decimal;
  vatDeductible: boolean;
  supplierNif: string | null;
};

/**
 * Pure amounts of an expense: quota = base × rate (the printed quota wins
 * within ±0.01), total = base + quota (cross-checked when given), VAT
 * deductible only with a supplier NIF (a ticket without NIF is never
 * deductible: the quota goes to the expense account).
 */
export function computeExpense(data: { base: Decimal; taxRate: Decimal; quota?: Decimal; total?: Decimal; supplierNif?: string | null; vatDeductible?: boolean }): ComputedExpense {
  const rateCode = assertSupportedRate(data.taxRate);
  const base = round2(data.base);
  const expectedQuota = pct(base, data.taxRate);
  let quota = expectedQuota;
  if (data.quota !== undefined) {
    const given = round2(data.quota);
    if (given.minus(expectedQuota).abs().gt(dec("0.01"))) {
      throw typed(400, "LINE_QUOTA_MISMATCH", `La cuota ${money(given)} no corresponde a ${money(base)} × ${data.taxRate.toFixed(2)} % = ${money(expectedQuota)}.`, { given: money(given), expected: money(expectedQuota) });
    }
    quota = given;
  }
  const total = base.plus(quota);
  if (data.total !== undefined && !round2(data.total).equals(total)) {
    throw typed(400, "TOTAL_MISMATCH", `El total ${money(data.total)} no cuadra: base ${money(base)} + IVA ${money(quota)} = ${money(total)}.`, { expectedTotal: money(data.total), computedTotal: money(total) });
  }
  const supplierNif = normalizeNif(data.supplierNif);
  if (supplierNif) {
    const check = checkSpanishNif(supplierNif);
    if (!check.ok) throw typed(400, "SUPPLIER_NIF_INVALID", `NIF del proveedor no válido: ${check.message}`, { taxId: supplierNif });
  }
  const vatDeductible = data.vatDeductible ?? Boolean(supplierNif);
  if (vatDeductible && !supplierNif) {
    throw typed(400, "EXPENSE_VAT_NOT_DEDUCTIBLE_WITHOUT_NIF", "Un ticket sin NIF del proveedor no da derecho a deducir el IVA: marca vatDeductible=false (la cuota irá a gasto) o registra una factura completa.");
  }
  return { rateCode, base, quota, total, vatDeductible, supplierNif };
}

/** Journal lines (pure): D expense (base [+ quota if not deductible]) / D 472.rate (deductible quota) / H counter account (total). */
export function buildExpenseLines(input: ComputedExpense & { accountCode: string; counterAccountCode: string; concept: string; costCenterId: string | null }): LedgerLineInput[] {
  const vatAccount = inputVatAccountFor(input.rateCode);
  const deductibleQuota = input.vatDeductible && vatAccount && !input.quota.isZero() ? input.quota : null;
  const expenseAmount = deductibleQuota ? input.base : input.base.plus(input.quota);
  const lines: LedgerLineInput[] = [
    { accountCode: input.accountCode, debit: expenseAmount, description: input.concept, costCenterId: input.costCenterId, taxRateCode: input.rateCode }
  ];
  if (deductibleQuota && vatAccount) {
    lines.push({ accountCode: vatAccount, debit: deductibleQuota, description: `IVA soportado ${input.rateCode} %`, taxRateCode: input.rateCode, taxBase: input.base });
  }
  lines.push({ accountCode: input.counterAccountCode, credit: input.total, description: `Pago ${input.concept}` });
  return lines;
}

export type ExpenseDto = {
  id: string;
  organizationId: string;
  propertyId: string | null;
  date: string;
  supplierName: string;
  supplierNif: string | null;
  concept: string;
  accountCode: string;
  base: string;
  taxRate: string;
  quota: string;
  total: string;
  paidWith: ExpensePaidWith;
  vatDeductible: boolean;
  hasReceipt: boolean;
  journalEntryId: string | null;
  reversalJournalEntryId: string | null;
  cancelledAt: string | null;
  createdBy: string | null;
  createdAt: string;
};

export type ExpenseDetailDto = ExpenseDto & { vatRows: VatBookRowDto[]; entry: LedgerEntryResult | null };

type ExpenseRow = NonNullable<Awaited<ReturnType<typeof prisma.expense.findUnique>>>;

function toDto(row: ExpenseRow): ExpenseDto {
  return {
    id: row.id,
    organizationId: row.organizationId,
    propertyId: row.propertyId ?? null,
    date: dayOf(row.date)!,
    supplierName: row.supplierName,
    supplierNif: row.supplierNif ?? null,
    concept: row.concept,
    accountCode: row.accountCode,
    base: money(row.base),
    taxRate: dec(row.taxRate).toFixed(2),
    quota: money(row.quota),
    total: money(row.total),
    paidWith: row.paidWith as ExpensePaidWith,
    vatDeductible: row.vatDeductible,
    hasReceipt: Boolean(row.receiptObjectKey),
    journalEntryId: row.journalEntryId ?? null,
    reversalJournalEntryId: row.reversalJournalEntryId ?? null,
    cancelledAt: row.cancelledAt ? row.cancelledAt.toISOString() : null,
    createdBy: row.createdBy ?? null,
    createdAt: row.createdAt.toISOString()
  };
}

async function organizationOfProperty(tx: Tx | typeof prisma, propertyId: string): Promise<string> {
  const property = await tx.property.findUnique({ where: { id: propertyId }, select: { organizationId: true } });
  if (!property) throw new NotFoundError("Propiedad no encontrada.");
  return property.organizationId;
}

async function requireExpense(tx: Tx | typeof prisma, propertyId: string, expenseId: string): Promise<ExpenseRow> {
  const row = await tx.expense.findFirst({ where: { id: expenseId, propertyId } });
  if (!row) throw new NotFoundError("Gasto no encontrado.");
  return row;
}

async function assertExpenseAccount(tx: Tx, organizationId: string, code: string): Promise<void> {
  const account = await tx.account.findUnique({ where: { organizationId_code: { organizationId, code } }, select: { group: true, isPostable: true } });
  if (!account) throw typed(400, "EXPENSE_ACCOUNT_INVALID", `La cuenta ${code} no existe en el plan de la organización.`, { accountCode: code });
  if (!account.isPostable) throw typed(400, "EXPENSE_ACCOUNT_INVALID", `La cuenta ${code} es una cabecera y no admite apuntes.`, { accountCode: code });
  if (account.group !== 6) throw typed(400, "EXPENSE_ACCOUNT_INVALID", `Un gasto menor se contabiliza en una cuenta de gasto (6xx): ${code}.`, { accountCode: code });
}

function inlineReceiptUri(attachment: z.output<typeof attachmentSchema>): string {
  const base64 = attachment.base64.replace(/\s/g, "");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64) || base64.length % 4 !== 0) throw typed(400, "ATTACHMENT_INVALID", "El justificante no es base64 válido.");
  const bytes = Buffer.from(base64, "base64").length;
  if (bytes > ATTACHMENT_MAX_BYTES) throw typed(413, "ATTACHMENT_TOO_LARGE", `El justificante ocupa ${bytes} bytes; el máximo en línea es ${ATTACHMENT_MAX_BYTES} bytes.`, { bytes, max: ATTACHMENT_MAX_BYTES });
  return `data:${attachment.mimeType};name=${encodeURIComponent(attachment.fileName)};base64,${base64}`;
}

async function loadEntryDto(tx: Tx, organizationId: string, journalEntryId: string): Promise<LedgerEntryResult | null> {
  const entry = await tx.journalEntry.findFirst({ where: { id: journalEntryId, organizationId } });
  if (!entry) return null;
  const rows = await tx.journalLine.findMany({ where: { journalEntryId }, orderBy: { id: "asc" } });
  let totalDebit = dec(0);
  let totalCredit = dec(0);
  for (const r of rows) {
    totalDebit = totalDebit.plus(r.debit);
    totalCredit = totalCredit.plus(r.credit);
  }
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
    totalDebit: money(totalDebit),
    totalCredit: money(totalCredit),
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

export async function listExpenses(filter: { propertyId: string; from?: string; to?: string; paidWith?: ExpensePaidWith; includeCancelled?: boolean; q?: string; limit?: number }): Promise<ExpenseDto[]> {
  const q = filter.q?.trim();
  const rows = await prisma.expense.findMany({
    where: {
      propertyId: filter.propertyId,
      ...(filter.includeCancelled ? {} : { cancelledAt: null }),
      ...(filter.paidWith ? { paidWith: filter.paidWith } : {}),
      ...(filter.from || filter.to ? { date: { ...(filter.from ? { gte: utcDay(filter.from) } : {}), ...(filter.to ? { lte: utcDay(filter.to) } : {}) } } : {}),
      ...(q ? { OR: [{ concept: { contains: q, mode: "insensitive" } }, { supplierName: { contains: q, mode: "insensitive" } }] } : {})
    },
    orderBy: [{ date: "desc" }, { createdAt: "desc" }],
    take: Math.min(Math.max(filter.limit ?? 200, 1), 500)
  });
  return rows.map(toDto);
}

export async function getExpense(propertyId: string, expenseId: string): Promise<ExpenseDetailDto> {
  const row = await requireExpense(prisma, propertyId, expenseId);
  const [vatRows, entry] = await prisma.$transaction(async (tx) => [
    await listVatRowsOf(tx, row.organizationId, "expense", row.id),
    row.journalEntryId ? await loadEntryDto(tx, row.organizationId, row.journalEntryId) : null
  ]);
  return { ...toDto(row), vatRows, entry };
}

export async function createExpense(input: { context: UserContext; propertyId: string; body: unknown; correlationId: string }): Promise<ExpenseDetailDto> {
  const data = parseOr400(expenseSchema, input.body ?? {}, "Gasto");
  const organizationId = await organizationOfProperty(prisma, input.propertyId);
  const computed = computeExpense({ base: data.base, taxRate: data.taxRate, quota: data.quota, total: data.total, supplierNif: data.supplierNif, vatDeductible: data.vatDeductible });
  const counterAccountCode = data.counterAccountCode ?? EXPENSE_COUNTER_ACCOUNTS[data.paidWith];
  const created = await prisma.$transaction(async (tx) => {
    await assertExpenseAccount(tx, organizationId, data.accountCode);
    const row = await tx.expense.create({
      data: {
        organizationId,
        propertyId: input.propertyId,
        date: data.date,
        supplierName: data.supplierName,
        supplierNif: computed.supplierNif,
        concept: data.concept,
        accountCode: data.accountCode,
        base: computed.base,
        taxRate: dec(computed.rateCode),
        quota: computed.quota,
        total: computed.total,
        paidWith: data.paidWith,
        vatDeductible: computed.vatDeductible,
        receiptObjectKey: data.attachment ? inlineReceiptUri(data.attachment) : (data.receiptObjectKey ?? null),
        createdBy: input.context.userId
      }
    });
    const entry = await getLedgerPort().post(tx, {
      organizationId,
      propertyId: input.propertyId,
      entryDate: data.date,
      sourceType: "expense",
      sourceId: row.id,
      description: `Gasto ${data.concept} — ${data.supplierName}`,
      reference: null,
      createdBy: input.context.userId,
      lines: buildExpenseLines({ ...computed, accountCode: data.accountCode, counterAccountCode, concept: data.concept, costCenterId: data.costCenterId ?? null })
    });
    await writeInputVatRows(tx, {
      organizationId,
      propertyId: input.propertyId,
      date: data.date,
      counterpartyNif: computed.supplierNif,
      counterpartyName: data.supplierName,
      sourceType: "expense",
      sourceId: row.id,
      deductible: computed.vatDeductible,
      rows: [{ rateCode: computed.rateCode, base: computed.base, quota: computed.quota, retention: dec(0), investmentGood: false }]
    });
    return tx.expense.update({ where: { id: row.id }, data: { journalEntryId: entry.id } });
  });
  const dto = await getExpense(input.propertyId, created.id);
  recordAuditEvent({
    organizationId,
    propertyId: input.propertyId,
    actorUserId: input.context.userId,
    actorType: "user",
    action: "EXPENSE_RECORDED",
    entityType: "expense",
    entityId: dto.id,
    afterJson: { concept: dto.concept, supplierName: dto.supplierName, total: dto.total, paidWith: dto.paidWith, vatDeductible: dto.vatDeductible, journalEntryId: dto.journalEntryId },
    correlationId: input.correlationId
  });
  recordDomainEvent({
    organizationId,
    propertyId: input.propertyId,
    entityType: "expense",
    entityId: dto.id,
    eventType: "ExpenseRecorded",
    payload: { total: dto.total, base: dto.base, quota: dto.quota, paidWith: dto.paidWith, counterAccountCode, journalEntryId: dto.journalEntryId, date: dto.date },
    actorType: "user",
    actorUserId: input.context.userId,
    correlationId: input.correlationId
  });
  return dto;
}

export async function reverseExpense(input: { context: UserContext; propertyId: string; expenseId: string; body: unknown; correlationId: string }): Promise<ExpenseDetailDto> {
  const data = parseOr400(reverseSchema, input.body ?? {}, "Anulación");
  const result = await prisma.$transaction(async (tx) => {
    const before = await requireExpense(tx, input.propertyId, input.expenseId);
    if (before.cancelledAt) return { row: before, reversal: null as LedgerEntryResult | null };
    let reversal: LedgerEntryResult | null = null;
    if (before.journalEntryId) {
      reversal = await getLedgerPort().reverse(tx, {
        organizationId: before.organizationId,
        journalEntryId: before.journalEntryId,
        entryDate: new Date(new Date().toISOString().slice(0, 10) + "T00:00:00.000Z"),
        sourceType: "reversal",
        sourceId: `expense_reversal:${before.id}`,
        description: `Anulación gasto ${before.concept}: ${data.reason}`,
        createdBy: input.context.userId
      });
    }
    await deleteInputVatRows(tx, before.organizationId, "expense", before.id);
    const row = await tx.expense.update({ where: { id: before.id }, data: { cancelledAt: new Date(), reversalJournalEntryId: reversal?.id ?? null } });
    return { row, reversal };
  });
  const dto = await getExpense(input.propertyId, result.row.id);
  recordAuditEvent({
    organizationId: dto.organizationId,
    propertyId: input.propertyId,
    actorUserId: input.context.userId,
    actorType: "user",
    action: "EXPENSE_REVERSED",
    entityType: "expense",
    entityId: dto.id,
    afterJson: { reason: data.reason, reversalJournalEntryId: dto.reversalJournalEntryId, total: dto.total },
    correlationId: input.correlationId
  });
  if (result.reversal) {
    recordDomainEvent({
      organizationId: dto.organizationId,
      propertyId: input.propertyId,
      entityType: "expense",
      entityId: dto.id,
      eventType: "ExpenseReversed",
      payload: { reversalJournalEntryId: result.reversal.id, reason: data.reason, total: dto.total },
      actorType: "user",
      actorUserId: input.context.userId,
      correlationId: input.correlationId
    });
  }
  return dto;
}

export { expenseSchema, reverseSchema as reverseExpenseSchema };
