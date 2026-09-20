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
//
// Tanda 8a (RBAC · L2, design §4.7 «registrar ≠ aprobar (por importe) ≠
// pagar», H6): registering needs `payables.create` and stamps
// SupplierBill.createdByUserId; approving needs `payables.approve`, another
// person than the registrar and a tier (TEMPLATE_MAX_TIER of the approver's
// assignments in the property) that reaches the total — above it the
// supplier_bill approval of the L1 engine (double approval above
// secondApprovalAmount with an ownership second approver) or 403
// RBAC_LEVEL_EXCEEDED; paying needs `payables.pay` and a third person
// (creator ≠ payer, approver ≠ payer — the controller template may pay what
// someone else approved, design §4.7 «salvo controller»). Posting and
// cancelling keep accounting.journal.post at the route. A bill written
// before the migration (createdByUserId null) is «autor desconocido»: never
// blocks, annotated in the audit.
//
// Tanda T9 (documentos · lote T9-08, diseño §7.1): la factura puede nacer de
// un IncomingDocument (`incomingDocumentId`, `source digitized | e_invoice`,
// `receptionDate` = captura, `documentObjectKey` = clave `org/…` del almacén
// de documentos). `createSupplierBillInTx(tx, …)` expone el alta dentro de la
// transacción del approve del documento; el libro de recibidas fecha por
// `receptionDate ?? issueDate`; `postSupplierBill` pasa el documento enlazado
// approved → posted y `cancelSupplierBill` lo devuelve a in_review con aviso;
// `approveSupplierBill` gana la guarda opcional `requireMatchForApproval`
// (DocumentSettings) → 409 SUPPLIER_BILL_MATCH_REQUIRED. Las líneas llevan
// quantity / unitPrice / deliveryNoteRef (cotejo con albaranes, §7.2);
// `getSupplierBillAttachment` resuelve una clave `org/…` a la descarga binaria
// del documento (`downloadPath`) en vez de devolver un enlace muerto.

import { prisma } from "@hotelos/database";
import type { Prisma } from "@prisma/client";
import { SUPPLIER_BILL_SOURCES, type SupplierBillMatchStatus, type SupplierBillSource } from "@hotelos/shared";
import { z } from "zod";
import type { UserContext } from "../../lib/demo-store.js";
import { HttpError, NotFoundError, RbacForbiddenError } from "../../lib/http-error.js";
import { assignmentsFor } from "../../lib/rbac-scope.js";
import { recordAuditEvent, recordDomainEvent } from "../audit/audit.service.js";
import { requirePermissions } from "../auth/auth.service.js";
import { assertApprovedOrAuthorized, type AuthorizationOutcome } from "../rbac/approvals.service.js";
import { defaultRbacDeps, scopeOfContext, type RbacDeps } from "../rbac/assignments.service.js";
import { getThresholds, maxTierFor, tierFor, tierWithin } from "../rbac/thresholds.service.js";
import { assertSeparationOfDuties, sodAuditFields, type SodCheckOutcome } from "../treasury/permissions.js";
import { parseOr400 } from "../rate-manager/rate-grid.schemas.js";
import { registerFixedAssetFromBillLine } from "../fixed-assets/fixed-assets.service.js";
// Tanda T9 (corrector RV-04): retención del documento enlazado al pasar a posted (módulo puro, sin ciclo con actions.service.ts).
import { retentionKindOf, retentionUntilFor } from "../documents/retention-rules.js";
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

/** zod input for a positive decimal with at most `scale` decimals (quantities 12,3 · unit prices 12,4), parsed as Decimal. */
export function decimalInput(scale: number): z.ZodType<Decimal, z.ZodTypeDef, string | number> {
  return z
    .union([z.number().finite(), z.string().regex(/^-?\d{1,9}(\.\d{1,6})?$/, "número no válido")])
    .transform((raw, ctx) => {
      const value = dec(raw);
      if (value.decimalPlaces() > scale) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `el valor no puede tener más de ${scale} decimales` });
        return z.NEVER;
      }
      if (value.lt(ZERO)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "el valor no puede ser negativo" });
        return z.NEVER;
      }
      return value;
    });
}

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
    investmentGood: z.boolean().optional(),
    /** Tanda T9 (albaranes): cantidad (3 decimales) y precio unitario (4 decimales) informativos; la base sigue mandando. */
    quantity: decimalInput(3).nullable().optional(),
    unitPrice: decimalInput(4).nullable().optional(),
    /** Nº de albarán citado en la línea (cotejo por proveedor + albarán). */
    deliveryNoteRef: z.string().trim().min(1).max(60).nullable().optional()
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
    /** Tanda T9: fecha de recepción (el libro de recibidas usa receptionDate ?? issueDate). */
    receptionDate: dayInput().nullable().optional(),
    /** Tanda T9: documento entrante del que nace la factura (lo fija el flujo de documentos). */
    incomingDocumentId: z.string().trim().min(1).max(64).nullable().optional(),
    /** Tanda T9: manual (por defecto) · digitized · e_invoice. */
    source: z.enum(SUPPLIER_BILL_SOURCES).optional(),
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

/** Tanda 8a: the only field of the approval body is the optional supervisor PIN authorisation (payables.approve). */
const approveSchema = z.object({ supervisorAuthorizationId: z.string().trim().min(1).max(64).optional() }).strict().optional();

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
  /** Tanda T9: informativos (cotejo con albaranes); null cuando la factura no detalla unidades. */
  quantity: Decimal | null;
  unitPrice: Decimal | null;
  deliveryNoteRef: string | null;
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
      investmentGood: line.investmentGood === true,
      quantity: line.quantity ?? null,
      unitPrice: line.unitPrice ?? null,
      deliveryNoteRef: line.deliveryNoteRef ?? null
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
  /** Tanda T9: cadena decimal (3 / 4 decimales) o null en facturas sin albarán. */
  quantity: string | null;
  unitPrice: string | null;
  deliveryNoteRef: string | null;
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
  /** Tanda T9 (documentos): recepción, documento origen, procedencia y cotejo con albaranes. */
  receptionDate: string | null;
  incomingDocumentId: string | null;
  source: SupplierBillSource;
  matchStatus: SupplierBillMatchStatus;
  /** true con adjunto en línea (data:) o con clave `org/…` del almacén de documentos. */
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
    fixedAssetId: row.fixedAssetId ?? null,
    quantity: row.quantity === null || row.quantity === undefined ? null : dec(row.quantity).toFixed(3),
    unitPrice: row.unitPrice === null || row.unitPrice === undefined ? null : dec(row.unitPrice).toFixed(4),
    deliveryNoteRef: row.deliveryNoteRef ?? null
  };
}

/** Catálogo cerrado de payables-types: una fila con un valor fuera de catálogo (nunca escrito por el API) se lee como el valor por defecto. */
function sourceOf(value: string | null | undefined): SupplierBillSource {
  return (SUPPLIER_BILL_SOURCES as readonly string[]).includes(value ?? "") ? (value as SupplierBillSource) : "manual";
}

const MATCH_STATUSES: readonly SupplierBillMatchStatus[] = ["none", "partial", "full", "variance"];

function matchStatusOf(value: string | null | undefined): SupplierBillMatchStatus {
  return (MATCH_STATUSES as readonly string[]).includes(value ?? "") ? (value as SupplierBillMatchStatus) : "none";
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
    receptionDate: dayOf(row.receptionDate),
    incomingDocumentId: row.incomingDocumentId ?? null,
    source: sourceOf(row.source),
    matchStatus: matchStatusOf(row.matchStatus),
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

export type SupplierBillAttachment = {
  inline: boolean;
  documentObjectKey: string | null;
  mimeType: string | null;
  fileName: string | null;
  base64: string | null;
  /** Tanda T9: clave `org/…` del almacén de documentos → documento y ruta de descarga binaria (GET …/documents/:id/file). */
  documentId?: string;
  downloadPath?: string;
};

/** Documento de una clave del almacén `org/<org>/prop/<prop>/doc/<doc>/<sha>.<ext>` (null si no tiene esa forma). */
export function documentIdOfStorageKey(key: string): string | null {
  const match = /^org\/[^/]+\/prop\/([^/]+)\/doc\/([^/]+)\/[a-f0-9]{64}\.[a-z]+$/.exec(key);
  return match ? match[2]! : null;
}

export function documentDownloadPath(propertyId: string, documentId: string): string {
  return `/properties/${propertyId}/documents/${documentId}/file`;
}

export async function getSupplierBillAttachment(propertyId: string, billId: string): Promise<SupplierBillAttachment> {
  const row = await requireBill(prisma, propertyId, billId);
  const key = row.documentObjectKey ?? null;
  if (!key) return { inline: false, documentObjectKey: null, mimeType: null, fileName: null, base64: null };
  const match = /^data:([^;]+);name=([^;]*);base64,(.*)$/s.exec(key);
  if (!match) {
    // Tanda T9: la clave del almacén de documentos no se sirve aquí (los bytes salen por la
    // descarga binaria auditada del módulo de documentos); se devuelve el documento y su ruta.
    const documentId = row.incomingDocumentId ?? documentIdOfStorageKey(key);
    if (documentId) return { inline: false, documentObjectKey: key, mimeType: null, fileName: null, base64: null, documentId, downloadPath: documentDownloadPath(row.propertyId, documentId) };
    return { inline: false, documentObjectKey: key, mimeType: null, fileName: null, base64: null };
  }
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

type CommandInput = { context: UserContext; propertyId: string; correlationId: string; /** Injectable rbac collaborators (tests). */ rbac?: RbacDeps };

// ---------------------------------------------------------------------------
// Tanda 8a · separation-of-duties gates (unit-testable with a fake context)
// ---------------------------------------------------------------------------

export type SupplierBillApprovalGate = {
  sod: SodCheckOutcome;
  tier: ReturnType<typeof tierFor>;
  maxTier: ReturnType<typeof tierFor>;
  /** null when the approver's own tier reaches the total (implicit approval). */
  authorization: AuthorizationOutcome | null;
};

/**
 * Approve gate: `payables.approve` on the actor; registrar ≠ approver (409
 * RBAC_SOD_CONFLICT creator_ne_approver); tier(total) within the approver's
 * tier → implicit; otherwise the engine (kind supplier_bill: an approved
 * request of another person, double approval above secondApprovalAmount,
 * supervisor PIN, privileged session) and, when nothing authorises it, 403
 * RBAC_LEVEL_EXCEEDED { tier, maxTier } instead of the engine's 409.
 */
export async function assertSupplierBillApprovalAuthorized(
  input: { context: UserContext; bill: { id: string; propertyId: string; createdByUserId: string | null; total: Decimal | number | string }; supervisorAuthorizationId?: string | null },
  deps: RbacDeps = defaultRbacDeps
): Promise<SupplierBillApprovalGate> {
  requirePermissions(input.context, ["payables.approve"]);
  const sod = assertSeparationOfDuties(input.context, input.bill.createdByUserId, "creator_ne_approver", { billId: input.bill.id });
  const total = dec(input.bill.total).abs();
  const thresholds = await getThresholds(input.context.organizationId, deps);
  const tier = tierFor(total.toNumber(), thresholds, "supplier_bill");
  const maxTier = await maxTierFor(input.context, input.bill.propertyId, deps);
  if (tierWithin(tier, maxTier) && tier !== "ABOVE_T4") return { sod, tier, maxTier, authorization: null };
  try {
    const authorization = await assertApprovedOrAuthorized(
      {
        context: input.context,
        kind: "supplier_bill",
        entityType: "supplier_bill",
        entityId: input.bill.id,
        propertyId: input.bill.propertyId,
        amount: total.toFixed(2),
        baseAuthorUserId: input.bill.createdByUserId,
        supervisorAuthorizationId: input.supervisorAuthorizationId ?? null
      },
      deps
    );
    return { sod, tier, maxTier, authorization };
  } catch (error) {
    const code = (error as { details?: { code?: string; requestId?: string } }).details?.code;
    if (code !== "APPROVAL_REQUIRED") throw error;
    const pendingRequestId = (error as { details?: { requestId?: string } }).details?.requestId ?? null;
    throw new RbacForbiddenError("El importe supera el tramo que puedes aprobar.", "RBAC_LEVEL_EXCEEDED", { tier, maxTier, kind: "supplier_bill", ...(pendingRequestId ? { requestId: pendingRequestId } : {}) });
  }
}

/** True when some live assignment of the actor covering the property is the `controller` template (pays what someone else approved). */
async function isControllerIn(context: UserContext, propertyId: string, deps: RbacDeps): Promise<boolean> {
  const scope = await scopeOfContext(context, deps);
  return assignmentsFor(scope, propertyId).assignments.some((assignment) => assignment.templateKey === "controller");
}

/**
 * Pay gate: `payables.pay` on the actor; registrar ≠ payer (409
 * creator_ne_payer); approver ≠ payer (409 approver_ne_payer) unless the actor
 * is a controller in the property (audited `controllerException`).
 */
export async function assertSupplierBillPaymentAuthorized(
  input: { context: UserContext; bill: { id: string; propertyId: string; createdByUserId: string | null; approvedBy: string | null } },
  deps: RbacDeps = defaultRbacDeps
): Promise<{ creator: SodCheckOutcome; approver: SodCheckOutcome | null; controllerException: boolean }> {
  requirePermissions(input.context, ["payables.pay"]);
  const creator = assertSeparationOfDuties(input.context, input.bill.createdByUserId, "creator_ne_payer", { billId: input.bill.id });
  const controllerException = input.bill.approvedBy === input.context.userId && (await isControllerIn(input.context, input.bill.propertyId, deps));
  const approver = controllerException ? null : assertSeparationOfDuties(input.context, input.bill.approvedBy, "approver_ne_payer", { billId: input.bill.id });
  return { creator, approver, controllerException };
}

function lineCreateData(l: ComputedBillLine): Prisma.SupplierBillLineCreateWithoutSupplierBillInput {
  return {
    lineNo: l.lineNo,
    description: l.description,
    expenseAccountCode: l.expenseAccountCode,
    base: l.base,
    taxRate: l.taxRate,
    quota: l.quota,
    retention: l.retention,
    costCenterId: l.costCenterId,
    investmentGood: l.investmentGood,
    quantity: l.quantity,
    unitPrice: l.unitPrice,
    deliveryNoteRef: l.deliveryNoteRef
  };
}

export type CreateSupplierBillInTxInput = {
  context: UserContext;
  propertyId: string;
  /** Organización del centro (se resuelve en la transacción si falta). */
  organizationId?: string;
  body: unknown;
  /** Tanda T9: `null` para altas sin persona (decisión autónoma); por defecto context.userId (SoD: registrador). */
  createdByUserId?: string | null;
  /**
   * Tanda T9 (corrector SEC-01): solo el flujo de documentos (actions.service.ts) enlaza un
   * IncomingDocument y fija `source` digitized | e_invoice; por HTTP ambos campos se rechazan
   * (400) y el documento enlazado se recomprueba SIEMPRE contra la organización y el centro
   * de la factura (404 opaco DOCUMENT_NOT_FOUND).
   */
  origin?: "documents";
};

type LinkedDocumentFields = { incomingDocumentId?: string | null; source?: SupplierBillSource };

/** SEC-01: por HTTP `incomingDocumentId` y `source` (salvo manual) no se aceptan: los fija el flujo de documentos. */
export function assertLinkedDocumentFieldsAllowed(data: LinkedDocumentFields, origin: "documents" | undefined): void {
  if (origin === "documents") return;
  if (data.incomingDocumentId) {
    throw typed(400, "VALIDATION_ERROR", "incomingDocumentId lo fija el flujo de documentos (aprobar el documento entrante): no se admite en el cuerpo.", { field: "incomingDocumentId" });
  }
  if (data.source !== undefined && data.source !== "manual") {
    throw typed(400, "VALIDATION_ERROR", "source solo admite «manual» al registrar a mano; digitized y e_invoice los fija el flujo de documentos.", { field: "source", value: data.source });
  }
}

/** SEC-01: el documento enlazado debe existir, no estar purgado y colgar de la organización y del centro de la factura. */
async function assertLinkedDocumentOwned(tx: Tx, input: { organizationId: string; propertyId: string; incomingDocumentId: string | null | undefined }): Promise<void> {
  if (!input.incomingDocumentId) return;
  const document = await tx.incomingDocument.findFirst({ where: { id: input.incomingDocumentId, organizationId: input.organizationId, propertyId: input.propertyId, deletedAt: null }, select: { id: true } });
  if (!document) throw typed(404, "DOCUMENT_NOT_FOUND", "Documento no encontrado.", { incomingDocumentId: input.incomingDocumentId });
}

/**
 * Tanda T9 (documentos): alta de la factura DENTRO de una transacción ajena
 * (approve del documento: factura + transición del documento en el mismo
 * commit). Mismas validaciones que createSupplierBill (cabecera, totales,
 * cuentas, duplicado); NO audita: el llamante registra SUPPLIER_BILL_REGISTERED
 * tras el commit con `auditSupplierBillRegistered`.
 */
export async function createSupplierBillInTx(tx: Tx, input: CreateSupplierBillInTxInput): Promise<SupplierBillDto> {
  requirePermissions(input.context, ["payables.create"]);
  const data = parseOr400(billSchema, input.body ?? {}, "Factura recibida");
  assertLinkedDocumentFieldsAllowed(data, input.origin);
  const organizationId = input.organizationId ?? (await organizationOfProperty(tx, input.propertyId));
  await assertLinkedDocumentOwned(tx, { organizationId, propertyId: input.propertyId, incomingDocumentId: data.incomingDocumentId });
  const header = await resolveHeader(tx, organizationId, data);
  const totals = computeBillTotals(data.lines, header.retentionRate, data.expectedTotal ?? null);
  await assertLineAccounts(tx, organizationId, totals.lines);
  await assertNotDuplicate(tx, { organizationId, supplierId: header.supplierId, supplierTaxId: header.supplierTaxId, invoiceNumber: data.invoiceNumber, issueDate: data.issueDate });
  const documentObjectKey = data.attachment ? inlineAttachmentUri(data.attachment) : (data.documentObjectKey ?? null);
  const row = await tx.supplierBill.create({
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
      // Tanda 8a (SoD): the registrar never approves nor pays its own bill.
      createdByUserId: input.createdByUserId === undefined ? input.context.userId : input.createdByUserId,
      // Tanda T9 (documentos): recepción, documento origen y procedencia.
      receptionDate: data.receptionDate ?? null,
      incomingDocumentId: data.incomingDocumentId ?? null,
      source: data.source ?? "manual",
      lines: { create: totals.lines.map(lineCreateData) }
    },
    include: { lines: true }
  });
  return toDto(row);
}

/** Auditoría del alta (tras el commit): la usan createSupplierBill y el approve del documento (T9-08). */
export function auditSupplierBillRegistered(dto: SupplierBillDto, input: { context: UserContext; propertyId: string; correlationId: string; extra?: Record<string, unknown> }): void {
  recordAuditEvent({
    organizationId: dto.organizationId,
    propertyId: input.propertyId,
    actorUserId: input.context.userId,
    actorType: "user",
    action: "SUPPLIER_BILL_REGISTERED",
    entityType: "supplier_bill",
    entityId: dto.id,
    afterJson: { supplierName: dto.supplierName, supplierTaxId: dto.supplierTaxId, invoiceNumber: dto.invoiceNumber, total: dto.total, status: dto.status, source: dto.source, incomingDocumentId: dto.incomingDocumentId, ...(input.extra ?? {}) },
    correlationId: input.correlationId
  });
}

export async function createSupplierBill(input: CommandInput & { body: unknown }): Promise<SupplierBillDto> {
  requirePermissions(input.context, ["payables.create"]);
  const organizationId = await organizationOfProperty(prisma, input.propertyId);
  const dto = await prisma.$transaction((tx) => createSupplierBillInTx(tx, { context: input.context, propertyId: input.propertyId, organizationId, body: input.body }));
  auditSupplierBillRegistered(dto, { context: input.context, propertyId: input.propertyId, correlationId: input.correlationId });
  return dto;
}

export async function updateSupplierBill(input: CommandInput & { billId: string; body: unknown }): Promise<SupplierBillDto> {
  requirePermissions(input.context, ["payables.create"]);
  const data = parseOr400(billSchema, input.body ?? {}, "Factura recibida");
  // SEC-01: por HTTP el enlace al documento y la procedencia no se tocan (400); el PATCH conserva los valores.
  assertLinkedDocumentFieldsAllowed(data, undefined);
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
        // Tanda T9 (documentos): un cliente que no envía el campo conserva el valor; el enlace al
        // documento y la procedencia nunca cambian por PATCH (SEC-01: los fija el flujo de documentos).
        receptionDate: data.receptionDate === undefined ? before.receptionDate : data.receptionDate,
        incomingDocumentId: before.incomingDocumentId,
        source: before.source,
        lines: { create: totals.lines.map(lineCreateData) }
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

export type MatchGuardBill = { matchStatus: string; lines: ReadonlyArray<{ expenseAccountCode: string }> };

/**
 * Tanda T9 (§7.1): decisión pura de la guarda `requireMatchForApproval`:
 * `variance` bloquea siempre; `none` bloquea solo con líneas de compra (60x) y
 * albaranes del proveedor pendientes de cotejar (`pendingReceipts` > 0).
 * Devuelve el motivo o null cuando la aprobación puede seguir.
 */
export function matchGuardReason(bill: MatchGuardBill, settings: { requireMatchForApproval: boolean } | null | undefined, pendingReceipts: number): "variance" | "pending_receipts" | null {
  if (!settings?.requireMatchForApproval) return null;
  if (bill.matchStatus === "variance") return "variance";
  if (bill.matchStatus === "none" && bill.lines.some((line) => line.expenseAccountCode.startsWith("60")) && pendingReceipts > 0) return "pending_receipts";
  return null;
}

async function assertMatchForApproval(db: Tx | typeof prisma, bill: BillRow): Promise<void> {
  const organizationId = bill.organizationId;
  if (!organizationId) return;
  const settings = await db.documentSettings.findUnique({ where: { organizationId }, select: { requireMatchForApproval: true } });
  if (!settings?.requireMatchForApproval) return;
  const supplierFilter: Prisma.GoodsReceiptWhereInput[] = [...(bill.supplierId ? [{ supplierId: bill.supplierId }] : []), ...(bill.supplierTaxId ? [{ supplierTaxId: bill.supplierTaxId }] : [])];
  const pending = supplierFilter.length > 0 ? await db.goodsReceipt.count({ where: { organizationId, status: { in: ["received", "matched"] }, OR: supplierFilter } }) : 0;
  const reason = matchGuardReason({ matchStatus: bill.matchStatus, lines: bill.lines }, settings, pending);
  if (!reason) return;
  throw typed(
    409,
    "SUPPLIER_BILL_MATCH_REQUIRED",
    reason === "variance"
      ? "El cotejo con los albaranes tiene diferencias fuera de tolerancia: resuélvelas antes de aprobar la factura."
      : `El proveedor tiene ${pending} albarán(es) pendientes de cotejar y la factura tiene líneas de compra: coteja antes de aprobar.`,
    { matchStatus: bill.matchStatus, reason, pendingReceipts: pending }
  );
}

export async function approveSupplierBill(input: CommandInput & { billId: string; body?: unknown }): Promise<SupplierBillDto> {
  const body = parseOr400(approveSchema, input.body ?? {}, "Aprobación");
  // Tanda 8a: the gate runs on the loaded bill BEFORE the transaction (the
  // engine consumes an approved request; nothing is written if it refuses).
  const loaded = await requireBill(prisma, input.propertyId, input.billId);
  assertStatus(loaded, ["draft"], "aprobar");
  const gate = await assertSupplierBillApprovalAuthorized(
    { context: input.context, bill: { id: loaded.id, propertyId: loaded.propertyId, createdByUserId: loaded.createdByUserId ?? null, total: loaded.total }, supervisorAuthorizationId: body?.supervisorAuthorizationId ?? null },
    input.rbac ?? defaultRbacDeps
  );
  // Tanda T9 (§7.1): guarda opcional por organización (DocumentSettings.requireMatchForApproval).
  await assertMatchForApproval(prisma, loaded);
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
    afterJson: {
      status: dto.status,
      total: dto.total,
      approvedBy: input.context.userId,
      tier: gate.tier,
      maxTier: gate.maxTier,
      ...sodAuditFields(gate.sod),
      authorization: gate.authorization
        ? { mode: gate.authorization.mode, tier: gate.authorization.tier, requestId: gate.authorization.requestId ?? null, supervisorAuthorizationId: gate.authorization.supervisorAuthorizationId ?? null }
        : { mode: "implicit", tier: gate.tier, requestId: null, supervisorAuthorizationId: null }
    },
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
      investmentGood: l.investmentGood,
      quantity: l.quantity === null || l.quantity === undefined ? null : dec(l.quantity),
      unitPrice: l.unitPrice === null || l.unitPrice === undefined ? null : dec(l.unitPrice),
      deliveryNoteRef: l.deliveryNoteRef ?? null
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
      // Tanda T9 (§7.1): el libro de recibidas fecha por la recepción cuando se conoce (deuda de la Tanda 6).
      date: before.receptionDate ?? before.issueDate,
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
    // Tanda T9 (§6.1 fila approved → posted): el documento enlazado sigue a la factura en el mismo commit,
    // acotado a la organización y al centro de la factura (SEC-01) y con su retentionUntil (§3.2: 31/12 del
    // ejercicio + 6 años; RV-04: sin ella el job de retención nunca lo bloquearía ni purgaría).
    if (before.incomingDocumentId) {
      const document = await tx.incomingDocument.findFirst({
        where: { id: before.incomingDocumentId, organizationId, propertyId: input.propertyId, status: "approved", deletedAt: null },
        select: { id: true, kind: true, documentDate: true, capturedAt: true, extendedRetention: true, guestId: true }
      });
      if (document) {
        const settings = await tx.documentSettings.findUnique({ where: { organizationId }, select: { retentionYearsDefault: true, letterRetentionYears: true, extendedRetentionYears: true } });
        const retentionUntil = retentionUntilFor({
          kind: retentionKindOf(document.kind),
          documentDate: before.issueDate ?? document.documentDate ?? document.capturedAt,
          extendedRetention: document.extendedRetention,
          personalData: document.guestId !== null,
          settings: settings ? { retentionYears: settings.retentionYearsDefault, letterRetentionYears: settings.letterRetentionYears, extendedRetentionYears: settings.extendedRetentionYears } : null
        });
        await tx.incomingDocument.updateMany({ where: { id: document.id, status: "approved" }, data: { status: "posted", postedAt: row.postedAt, retentionUntil } });
      }
    }
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
  // Tanda 8a: payables.pay + a third person (creator ≠ payer, approver ≠
  // payer unless controller). An already paid bill is returned as-is only
  // after the key check (never an oracle for a user without the pay key).
  requirePermissions(input.context, ["payables.pay"]);
  const loaded = await requireBill(prisma, input.propertyId, input.billId);
  const payGate = loaded.status === "paid"
    ? null
    : await assertSupplierBillPaymentAuthorized(
        { context: input.context, bill: { id: loaded.id, propertyId: loaded.propertyId, createdByUserId: loaded.createdByUserId ?? null, approvedBy: loaded.approvedBy ?? null } },
        input.rbac ?? defaultRbacDeps
      );
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
      afterJson: {
        status: dto.status,
        paymentDate: dto.paymentDate,
        paidJournalEntryId: dto.paidJournalEntryId,
        total: dto.total,
        counterAccountCode,
        paidByUserId: input.context.userId,
        sod: payGate
          ? { creator: { rule: payGate.creator.rule, authorUserId: payGate.creator.authorUserId, authorUnknown: payGate.creator.authorUnknown, privileged: payGate.creator.privileged }, approver: payGate.approver ? { rule: payGate.approver.rule, authorUserId: payGate.approver.authorUserId, authorUnknown: payGate.approver.authorUnknown, privileged: payGate.approver.privileged } : null, controllerException: payGate.controllerException }
          : null
      },
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
    if (before.status === "cancelled") return { row: before, reversal: null as LedgerEntryResult | null, documentReturned: null as { id: string; registryNumber: string } | null };
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
    // Tanda T9 (§6.1 fila approved · posted → in_review [S]): el documento enlazado (de la misma organización
    // y centro, SEC-01) vuelve a revisión sin la factura anulada (supplierBillId null, RV-19), con la razón en
    // rejectNote y aviso in-app a quien lo decidió; la retención vuelve a fijarse al decidir de nuevo.
    let documentReturned: { id: string; registryNumber: string } | null = null;
    if (before.incomingDocumentId) {
      const document = await tx.incomingDocument.findFirst({
        where: { id: before.incomingDocumentId, organizationId, propertyId: input.propertyId, status: { in: ["approved", "posted"] }, deletedAt: null },
        select: { id: true, registryNumber: true, decidedBy: true, propertyId: true, organizationId: true }
      });
      if (document) {
        const note = `Factura ${before.invoiceNumber ?? before.id} anulada: ${data.reason}`.slice(0, 2000);
        await tx.incomingDocument.update({ where: { id: document.id }, data: { status: "in_review", postedAt: null, decidedAt: null, decidedBy: null, supplierBillId: null, retentionUntil: null, rejectReason: null, rejectNote: note } });
        if (document.decidedBy) {
          await tx.notification.create({
            data: {
              organizationId: document.organizationId,
              propertyId: document.propertyId,
              userId: document.decidedBy,
              type: "system",
              title: `Factura anulada: el documento ${document.registryNumber} vuelve a revisión`,
              body: `La factura ${before.invoiceNumber ?? before.id} se ha anulado (${data.reason}). El documento ${document.registryNumber} vuelve a «en revisión» para decidir de nuevo.`,
              status: "unread"
            }
          });
        }
        documentReturned = { id: document.id, registryNumber: document.registryNumber };
      }
    }
    return { row, reversal, documentReturned };
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
    afterJson: { status: dto.status, reason: data.reason, reversalJournalEntryId: result.reversal?.id ?? null, incomingDocumentId: dto.incomingDocumentId, documentReturnedToReview: result.documentReturned },
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
