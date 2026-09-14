import { assertInvoiceMutable, buildVerifactuQrUrl, computeVerifactuHash, type VerifactuInvoiceType } from "@hotelos/compliance";
import { prisma } from "@hotelos/database";
import type { Prisma } from "@hotelos/database";
import { Prisma as PrismaRuntime } from "@prisma/client";
import type { UserContext } from "../../lib/demo-store.js";
import { BadRequestError, ConflictError, NotFoundError } from "../../lib/http-error.js";
import { buildPage, DEFAULT_PAGE_LIMIT, decodeCursor, MAX_PAGE_LIMIT, type Page } from "../../lib/pagination.js";
import { recordAuditEvent, recordDomainEvent } from "../audit/audit.service.js";
import { requirePermissions } from "../auth/auth.service.js";
import { buildTaxCode, resolveTaxRate } from "../accounting/tax-rate.service.js";
import { getExchangeRate } from "../accounting/currency.service.js";
import {
  ISSUER_TAX_ID_PLACEHOLDER,
  previewIssuerTaxId,
  requireIssuerIdentity,
  resolveIssuerIdentity,
  taxIdFromQrPayload,
  type IssuerIdentity
} from "./issuer-identity.service.js";

export type InvoiceLineDraft = {
  description: string;
  quantity: number;
  unitPrice: number;
  taxCode: string;
  taxRate: number;
  total: number;
};

export type InvoiceStatusValue = "draft" | "issued" | "cancelled" | "rectified";

// Payment state is DERIVED from captured payments (Tanda 2 · QC-03); the
// InvoiceStatus enum stays draft/issued/cancelled/rectified on purpose (the
// VeriFactu pipeline, cancelInvoice and createRectifyingInvoice compare
// status === "issued").
export type InvoicePaymentStatus = "unpaid" | "partial" | "paid" | "not_applicable";

// How paidTotal was attributed to the invoice:
//   linked      Σ captured payments with Payment.invoiceId = invoice.id
//   folio_match no linked payment, but the invoice's folio has an unlinked
//               captured payment whose amount equals the invoice total
//               (invoices issued before Payment.invoiceId existed — documented
//               heuristic, replaced by the linked value as soon as one exists)
//   none        nothing attributable
export type InvoicePaymentSource = "linked" | "folio_match" | "none";

export type InvoiceListItem = {
  id: string;
  propertyId: string;
  invoiceNumber?: string;
  invoiceType: "F1" | "F2" | "F3" | "R1" | "R2" | "R3" | "R4" | "R5";
  customerType: "guest" | "company" | "agency";
  customerTaxId?: string;
  status: InvoiceStatusValue;
  issuedAt?: string;
  total: number;
  taxTotal: number;
  currencyCode: string;
  fxRate?: number;
  baseTotal?: number;
  verifactuHash?: string;
  previousInvoiceHash?: string;
  qrPayload?: string;
  rectifyingForId?: string;
  rectifyingReasonCode?: string;
  createdAt: string;
  updatedAt: string;
  // Tanda 2 · FISC-04: source folio / reservation (null for manual drafts).
  folioId: string | null;
  reservationId: string | null;
  // Tanda 2 · QC-03: payment state derived from captured payments.
  paidTotal: number;
  balanceDue: number;
  paymentStatus: InvoicePaymentStatus;
  paymentSource: InvoicePaymentSource;
  paidAt: string | null;
  /** ISO timestamp of the cancellation (POST /invoices/:id/cancel); null while live. */
  cancelledAt?: string | null;
  // Tanda 2 · FISC-03: issuer snapshot taken at issuance (null on drafts).
  issuerTaxId: string | null;
  issuerLegalName: string | null;
  issuerTaxIdPlaceholder: boolean;
};

export type InvoiceRecord = InvoiceListItem & {
  lines: InvoiceLineDraft[];
  // Issuer branding/legal block for rendering the invoice (logo + legal
  // disclaimer footer configured per property, plus the issuer fiscal data).
  issuer?: InvoiceIssuer;
  // Non-blocking problems detected while building the invoice (only set by
  // createInvoiceFromFolio today: lines that resolved to no tax rate). Not
  // persisted — the audit event carries the same list.
  warnings?: string[];
};

export type InvoiceIssuer = {
  propertyName?: string;
  legalName?: string;
  // NIF the document carries: the issuance snapshot for issued invoices; for a
  // draft / the branding preview, what issuance WOULD stamp right now (the
  // valid configured NIF, or the sandbox placeholder — never an invalid NIF
  // shown as if it were going to be printed, FISC-03).
  taxId?: string;
  // True when taxId is the sandbox placeholder (issued, or to be issued, without a valid NIF).
  taxIdPlaceholder?: boolean;
  // Organization.taxId as configured (normalised), valid or not — so the UI can
  // say "NIF configurado X no válido" next to the placeholder. Null when not configured.
  taxIdConfigured: string | null;
  // Human-readable issuer problems (missing / invalid NIF, placeholder issuance). Empty when fine.
  warnings: string[];
  address?: string;
  logoUrl?: string;
  legalFooter?: string;
};

export type ListInvoicesOptions = {
  /** InvoiceStatus values, csv string or array; malformed → 400. */
  status?: string | string[];
  /** createdAt >= from (ISO date or datetime); malformed → 400. */
  from?: string;
  /** createdAt < to; a date-only value includes the whole day; malformed → 400. */
  to?: string;
  /** Case-insensitive match on invoiceNumber / customerTaxId. */
  q?: string;
  limit?: number;
  cursor?: string | null;
};

export type InvoiceListSummary = {
  /** Invoices matching the filters (all statuses). */
  count: number;
  issued: number;
  /** Issued invoices fully paid. */
  paid: number;
  /** Issued invoices with a balance due (unpaid or partial). */
  unpaid: number;
  /** Σ balanceDue of issued invoices. */
  totalDue: number;
};

export type InvoicePage = Page<InvoiceListItem> & { summary: InvoiceListSummary };

const INVOICE_STATUSES: readonly InvoiceStatusValue[] = ["draft", "issued", "cancelled", "rectified"];
const CENT_TOLERANCE = 0.005;

function dec(value: Prisma.Decimal | number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  return typeof value === "number" ? value : Number(value);
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

export function derivePaymentStatus(status: InvoiceStatusValue, total: number, paidTotal: number): InvoicePaymentStatus {
  if (status === "cancelled" || status === "rectified") return "not_applicable";
  if (total <= 0) return "not_applicable";
  if (paidTotal <= CENT_TOLERANCE) return "unpaid";
  if (paidTotal + CENT_TOLERANCE < total) return "partial";
  return "paid";
}

type InvoiceRow = Prisma.InvoiceGetPayload<Record<string, never>>;

type PaidSummary = { paidTotal: number; lastPaymentAt: Date | null; source: InvoicePaymentSource };

/** Refund statuses that never reduce the captured amount (mirrors folio.service REFUND_FAILED_STATUSES). */
const REFUND_FAILED_STATUSES: readonly string[] = ["failed", "rejected", "cancelled"];

/** Σ PaymentRefund.amount per payment id (only refunds that were not failed/rejected/cancelled). */
async function sumRefundsByPaymentId(paymentIds: string[]): Promise<Map<string, number>> {
  const totals = new Map<string, number>();
  if (paymentIds.length === 0) return totals;
  const refunds = await prisma.paymentRefund.findMany({
    where: { paymentId: { in: paymentIds }, status: { notIn: [...REFUND_FAILED_STATUSES] } },
    select: { paymentId: true, amount: true }
  });
  for (const refund of refunds) {
    totals.set(refund.paymentId, (totals.get(refund.paymentId) ?? 0) + dec(refund.amount));
  }
  return totals;
}

/**
 * Captured payments per invoice for a set of rows in two queries (no N+1):
 * a groupBy on Payment.invoiceId plus, for folio-issued invoices that still
 * have no linked payment, the unlinked captured payments of their folios
 * (folio_match heuristic, see InvoicePaymentSource).
 */
async function summarizePaidByInvoice(rows: Array<Pick<InvoiceRow, "id" | "folioId" | "total">>): Promise<Map<string, PaidSummary>> {
  const result = new Map<string, PaidSummary>();
  if (rows.length === 0) return result;
  // Linked captured payments NET of their refunds (a partial refund keeps the
  // payment "captured" and adds a PaymentRefund row; a full refund flips the
  // status). Same arithmetic as folio.service netCapturedTotal, so the list,
  // the folio balance and mark-paid agree after a devolución.
  const linkedPayments = await prisma.payment.findMany({
    where: { invoiceId: { in: rows.map((r) => r.id) }, status: "captured", deletedAt: null },
    select: { id: true, invoiceId: true, amount: true, createdAt: true }
  });
  const refundsByPayment = await sumRefundsByPaymentId(linkedPayments.map((p) => p.id));
  const linkedByInvoice = new Map<string, { net: number; lastPaymentAt: Date | null }>();
  for (const payment of linkedPayments) {
    if (!payment.invoiceId) continue;
    const net = Math.max(0, dec(payment.amount) - (refundsByPayment.get(payment.id) ?? 0));
    const acc = linkedByInvoice.get(payment.invoiceId) ?? { net: 0, lastPaymentAt: null };
    acc.net += net;
    if (!acc.lastPaymentAt || payment.createdAt > acc.lastPaymentAt) acc.lastPaymentAt = payment.createdAt;
    linkedByInvoice.set(payment.invoiceId, acc);
  }
  for (const [invoiceId, acc] of linkedByInvoice) {
    const paidTotal = round(acc.net);
    if (paidTotal <= 0) continue;
    result.set(invoiceId, { paidTotal, lastPaymentAt: acc.lastPaymentAt, source: "linked" });
  }
  const pending = rows.filter((r) => !result.has(r.id) && r.folioId);
  const folioIds = Array.from(new Set(pending.map((r) => r.folioId as string)));
  if (folioIds.length > 0) {
    const unlinked = await prisma.payment.findMany({
      where: { folioId: { in: folioIds }, invoiceId: null, status: "captured", deletedAt: null },
      select: { id: true, folioId: true, amount: true, createdAt: true },
      orderBy: { createdAt: "asc" }
    });
    const unlinkedRefunds = await sumRefundsByPaymentId(unlinked.map((p) => p.id));
    const byFolio = new Map<string, Array<{ amount: number; createdAt: Date }>>();
    for (const payment of unlinked) {
      const list = byFolio.get(payment.folioId) ?? [];
      list.push({ amount: dec(payment.amount) - (unlinkedRefunds.get(payment.id) ?? 0), createdAt: payment.createdAt });
      byFolio.set(payment.folioId, list);
    }
    for (const row of pending) {
      const total = dec(row.total);
      if (total <= 0) continue;
      const match = byFolio.get(row.folioId as string)?.find((p) => Math.abs(p.amount - total) < CENT_TOLERANCE);
      if (match) result.set(row.id, { paidTotal: round(total), lastPaymentAt: match.createdAt, source: "folio_match" });
    }
  }
  return result;
}

function toListItem(row: InvoiceRow, paid: PaidSummary | undefined): InvoiceListItem {
  const total = dec(row.total);
  const paidTotal = paid?.paidTotal ?? 0;
  const paymentStatus = derivePaymentStatus(row.status, total, paidTotal);
  const paidAt = row.paidAt ?? (paymentStatus === "paid" ? paid?.lastPaymentAt ?? null : null);
  return {
    id: row.id,
    propertyId: row.propertyId,
    invoiceNumber: row.invoiceNumber ?? undefined,
    invoiceType: (row.invoiceType as InvoiceListItem["invoiceType"]) ?? "F1",
    customerType: row.customerType as InvoiceListItem["customerType"],
    customerTaxId: row.customerTaxId ?? undefined,
    status: row.status,
    issuedAt: row.issuedAt?.toISOString(),
    total,
    taxTotal: dec(row.taxTotal),
    currencyCode: row.currencyCode ?? "EUR",
    fxRate: row.fxRate !== null && row.fxRate !== undefined ? dec(row.fxRate) : undefined,
    baseTotal: row.baseTotal !== null && row.baseTotal !== undefined ? dec(row.baseTotal) : undefined,
    verifactuHash: row.verifactuHash ?? undefined,
    previousInvoiceHash: row.previousInvoiceHash ?? undefined,
    qrPayload: row.qrPayload ?? undefined,
    rectifyingForId: row.rectifyingForId ?? undefined,
    rectifyingReasonCode: row.rectifyingReasonCode ?? undefined,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    folioId: row.folioId ?? null,
    reservationId: row.reservationId ?? null,
    paidTotal: round(paidTotal),
    balanceDue: paymentStatus === "not_applicable" ? 0 : round(Math.max(total - paidTotal, 0)),
    paymentStatus,
    paymentSource: paid?.source ?? "none",
    paidAt: paidAt ? paidAt.toISOString() : null,
    cancelledAt: row.cancelledAt ? row.cancelledAt.toISOString() : null,
    issuerTaxId: row.issuerTaxId ?? null,
    issuerLegalName: row.issuerLegalName ?? null,
    issuerTaxIdPlaceholder: row.issuerTaxIdPlaceholder
  };
}

export const ISSUED_WITH_PLACEHOLDER_WARNING =
  `Factura emitida en sandbox con el NIF de relleno ${ISSUER_TAX_ID_PLACEHOLDER}: no es un documento fiscal válido.`;

function issuerBlock(identity: IssuerIdentity | null, row: Pick<InvoiceRow, "issuerTaxId" | "issuerLegalName" | "issuerTaxIdPlaceholder" | "qrPayload">): InvoiceIssuer | undefined {
  if (!identity && !row.issuerTaxId) return undefined;
  // An issued invoice shows the identity it was issued with: the snapshot, or
  // for invoices issued before the snapshot columns the NIF inside their own
  // QR (same rule as issuerForInvoice, so document, QR and XML agree). A draft
  // shows what issuance WOULD snapshot right now (FISC-03): the valid
  // configured NIF, or the flagged placeholder when the configured one is
  // missing / invalid — never the invalid value as if it were going to print.
  const snapshotTaxId = row.issuerTaxId ?? taxIdFromQrPayload(row.qrPayload);
  const preview = identity ? previewIssuerTaxId(identity) : null;
  let taxId: string | undefined;
  let taxIdPlaceholder: boolean;
  const warnings: string[] = [];
  if (snapshotTaxId) {
    taxId = snapshotTaxId;
    // Legacy rows (pre-snapshot) never had the flag set; the QR value tells.
    taxIdPlaceholder = row.issuerTaxIdPlaceholder || snapshotTaxId === ISSUER_TAX_ID_PLACEHOLDER;
    if (taxIdPlaceholder) warnings.push(ISSUED_WITH_PLACEHOLDER_WARNING);
  } else {
    taxId = preview?.taxId;
    taxIdPlaceholder = preview?.placeholder ?? false;
    if (preview) warnings.push(...preview.warnings);
  }
  return {
    propertyName: identity?.propertyName,
    legalName: row.issuerLegalName ?? identity?.legalName,
    taxId,
    taxIdPlaceholder,
    taxIdConfigured: identity?.taxId ?? null,
    warnings,
    address: identity?.address ?? undefined,
    logoUrl: identity?.logoUrl ?? undefined,
    legalFooter: identity?.legalFooter ?? undefined
  };
}

/** Full records (lines + issuer + payment state) for a set of rows — batched, no per-row queries. */
async function hydrateInvoiceRecords(rows: InvoiceRow[]): Promise<InvoiceRecord[]> {
  if (rows.length === 0) return [];
  const [lineRows, paid] = await Promise.all([
    prisma.invoiceLine.findMany({ where: { invoiceId: { in: rows.map((r) => r.id) } } }),
    summarizePaidByInvoice(rows)
  ]);
  const identities = new Map<string, IssuerIdentity | null>();
  for (const propertyId of new Set(rows.map((r) => r.propertyId))) {
    identities.set(propertyId, await resolveIssuerIdentity(propertyId));
  }
  const linesByInvoice = new Map<string, InvoiceLineDraft[]>();
  for (const l of lineRows) {
    const list = linesByInvoice.get(l.invoiceId) ?? [];
    list.push({
      description: l.description,
      quantity: dec(l.quantity),
      unitPrice: dec(l.unitPrice),
      taxCode: l.taxCode,
      taxRate: dec(l.taxRate),
      total: dec(l.total)
    });
    linesByInvoice.set(l.invoiceId, list);
  }
  return rows.map((row) => ({
    ...toListItem(row, paid.get(row.id)),
    issuer: issuerBlock(identities.get(row.propertyId) ?? null, row),
    lines: linesByInvoice.get(row.id) ?? []
  }));
}

async function loadInvoice(invoiceId: string): Promise<InvoiceRecord> {
  const row = await prisma.invoice.findUnique({ where: { id: invoiceId } });
  if (!row) throw new NotFoundError("Factura no encontrada.");
  const [record] = await hydrateInvoiceRecords([row]);
  return record!;
}

function parseStatusFilter(status: ListInvoicesOptions["status"]): InvoiceStatusValue[] | undefined {
  if (status === undefined || status === null) return undefined;
  const values = (Array.isArray(status) ? status : String(status).split(","))
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (values.length === 0) return undefined;
  const invalid = values.find((v) => !INVOICE_STATUSES.includes(v as InvoiceStatusValue));
  if (invalid) {
    throw new BadRequestError(`Estado de factura no válido: «${invalid}». Valores admitidos: ${INVOICE_STATUSES.join(", ")}.`);
  }
  return Array.from(new Set(values)) as InvoiceStatusValue[];
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

function parseDateBound(value: string | undefined, param: "from" | "to"): Date | undefined {
  if (value === undefined || value === "") return undefined;
  const dateOnly = DATE_ONLY.test(value);
  const parsed = new Date(dateOnly ? `${value}T00:00:00.000Z` : value);
  if (Number.isNaN(parsed.getTime())) {
    throw new BadRequestError(`El parámetro ${param} no es una fecha válida (usa YYYY-MM-DD o ISO 8601).`);
  }
  // "to=2026-09-14" means the whole 14th: exclusive bound at the next midnight.
  if (param === "to" && dateOnly) parsed.setUTCDate(parsed.getUTCDate() + 1);
  return parsed;
}

type InvoiceFilters = {
  statuses?: InvoiceStatusValue[];
  from?: Date;
  to?: Date;
  q?: string;
};

function parseInvoiceFilters(options: ListInvoicesOptions): InvoiceFilters {
  const q = options.q?.trim();
  return {
    statuses: parseStatusFilter(options.status),
    from: parseDateBound(options.from, "from"),
    to: parseDateBound(options.to, "to"),
    q: q ? q.slice(0, 100) : undefined
  };
}

function buildInvoiceWhere(propertyId: string, filters: InvoiceFilters): Prisma.InvoiceWhereInput {
  return {
    propertyId,
    deletedAt: null,
    ...(filters.statuses ? { status: { in: filters.statuses } } : {}),
    ...(filters.from || filters.to ? { createdAt: { ...(filters.from ? { gte: filters.from } : {}), ...(filters.to ? { lt: filters.to } : {}) } } : {}),
    ...(filters.q
      ? {
          OR: [
            { invoiceNumber: { contains: filters.q, mode: "insensitive" } },
            { customerTaxId: { contains: filters.q, mode: "insensitive" } }
          ]
        }
      : {})
  };
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * Aggregate payment state over the WHOLE filtered set in one query (the page
 * only carries its own rows). Same attribution rule as summarizePaidByInvoice:
 * linked captured payments first, else the folio_match heuristic.
 */
async function summarizeInvoicePayments(propertyId: string, filters: InvoiceFilters): Promise<InvoiceListSummary> {
  const sql = PrismaRuntime.sql;
  const statusFragment = filters.statuses
    ? sql`AND i.status::text IN (${PrismaRuntime.join(filters.statuses)})`
    : PrismaRuntime.empty;
  const fromFragment = filters.from ? sql`AND i.created_at >= ${filters.from}` : PrismaRuntime.empty;
  const toFragment = filters.to ? sql`AND i.created_at < ${filters.to}` : PrismaRuntime.empty;
  const qFragment = filters.q
    ? sql`AND (i.invoice_number ILIKE ${`%${escapeLike(filters.q)}%`} OR i.customer_tax_id ILIKE ${`%${escapeLike(filters.q)}%`})`
    : PrismaRuntime.empty;
  const rows = await prisma.$queryRaw<Array<{ count: number; issued: number; paid: number; unpaid: number; total_due: number }>>`
    SELECT
      COUNT(*)::int AS count,
      COUNT(*) FILTER (WHERE i.status::text = 'issued')::int AS issued,
      COUNT(*) FILTER (WHERE i.status::text = 'issued' AND i.total > 0 AND e.paid_total + 0.005 >= i.total)::int AS paid,
      COUNT(*) FILTER (WHERE i.status::text = 'issued' AND i.total > 0 AND e.paid_total + 0.005 < i.total)::int AS unpaid,
      COALESCE(SUM(GREATEST(i.total - e.paid_total, 0)) FILTER (WHERE i.status::text = 'issued' AND i.total > 0), 0)::float8 AS total_due
    FROM invoices i
    CROSS JOIN LATERAL (
      SELECT CASE
        WHEN lp.paid IS NOT NULL AND lp.paid > 0 THEN lp.paid
        WHEN i.folio_id IS NOT NULL AND EXISTS (
          SELECT 1 FROM payments q
          WHERE q.folio_id = i.folio_id AND q.invoice_id IS NULL AND q.status::text = 'captured'
            AND q.deleted_at IS NULL AND q.amount = i.total
        ) THEN i.total
        ELSE 0
      END AS paid_total
      FROM (
        SELECT SUM(p.amount) AS paid FROM payments p
        WHERE p.invoice_id = i.id AND p.status::text = 'captured' AND p.deleted_at IS NULL
      ) lp
    ) e
    WHERE i.property_id = ${propertyId} AND i.deleted_at IS NULL
      ${statusFragment} ${fromFragment} ${toFragment} ${qFragment}
  `;
  const row = rows[0];
  return {
    count: Number(row?.count ?? 0),
    issued: Number(row?.issued ?? 0),
    paid: Number(row?.paid ?? 0),
    unpaid: Number(row?.unpaid ?? 0),
    totalDue: round(Number(row?.total_due ?? 0))
  };
}

/**
 * Paginated invoice list (createdAt desc, id desc; opaque cursor) with the
 * derived payment state per row and a summary over the whole filtered set.
 * No lines / issuer here — getInvoice serves the detail and the preview.
 */
export async function listInvoices(propertyId: string, options: ListInvoicesOptions = {}): Promise<InvoicePage> {
  const filters = parseInvoiceFilters(options);
  const limit = Math.min(Math.max(options.limit ?? DEFAULT_PAGE_LIMIT, 1), MAX_PAGE_LIMIT);
  const cursor = decodeCursor(options.cursor ?? null);
  if (cursor) {
    const cursorDate = new Date(cursor.k);
    if (Number.isNaN(cursorDate.getTime())) throw new BadRequestError("El cursor de paginación no es válido.");
  }
  const where = buildInvoiceWhere(propertyId, filters);
  const pageWhere: Prisma.InvoiceWhereInput = cursor
    ? {
        AND: [
          where,
          { OR: [{ createdAt: { lt: new Date(cursor.k) } }, { createdAt: new Date(cursor.k), id: { lt: cursor.id } }] }
        ]
      }
    : where;
  const [rows, total, summary] = await Promise.all([
    prisma.invoice.findMany({ where: pageWhere, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: limit + 1 }),
    prisma.invoice.count({ where }),
    summarizeInvoicePayments(propertyId, filters)
  ]);
  const paid = await summarizePaidByInvoice(rows);
  const items = rows.map((row) => toListItem(row, paid.get(row.id)));
  const page = buildPage(items, limit, total, (item) => item.createdAt);
  return { ...page, summary };
}

export type InvoiceStatusTotals = Record<InvoiceStatusValue, { count: number; total: number; taxTotal: number }> & {
  count: number;
  total: number;
  taxTotal: number;
};

/** Count / total / taxTotal per status over the whole filtered set (reports). */
export async function summarizeInvoicesByStatus(propertyId: string, options: ListInvoicesOptions = {}): Promise<InvoiceStatusTotals> {
  const filters = parseInvoiceFilters(options);
  const groups = await prisma.invoice.groupBy({
    by: ["status"],
    where: buildInvoiceWhere(propertyId, filters),
    _count: { _all: true },
    _sum: { total: true, taxTotal: true }
  });
  const empty = () => ({ count: 0, total: 0, taxTotal: 0 });
  const totals: InvoiceStatusTotals = { draft: empty(), issued: empty(), cancelled: empty(), rectified: empty(), count: 0, total: 0, taxTotal: 0 };
  for (const group of groups) {
    const bucket = { count: group._count._all, total: round(dec(group._sum.total)), taxTotal: round(dec(group._sum.taxTotal)) };
    totals[group.status] = bucket;
    totals.count += bucket.count;
    totals.total = round(totals.total + bucket.total);
    totals.taxTotal = round(totals.taxTotal + bucket.taxTotal);
  }
  return totals;
}

export async function getInvoice(invoiceId: string): Promise<InvoiceRecord> {
  return loadInvoice(invoiceId);
}

function identityToIssuer(identity: IssuerIdentity | null): InvoiceIssuer {
  if (!identity) return { taxIdConfigured: null, warnings: [] };
  // FISC-03: the branding preview shows what issuance would stamp (valid NIF
  // or flagged placeholder), plus the configured value and why it is not used.
  const preview = previewIssuerTaxId(identity);
  return {
    propertyName: identity.propertyName,
    legalName: identity.legalName,
    taxId: preview.taxId,
    taxIdPlaceholder: preview.placeholder,
    taxIdConfigured: preview.configured,
    warnings: preview.warnings,
    address: identity.address ?? undefined,
    logoUrl: identity.logoUrl ?? undefined,
    legalFooter: identity.legalFooter ?? undefined
  };
}

export async function getInvoiceBranding(propertyId: string): Promise<InvoiceIssuer> {
  return identityToIssuer(await resolveIssuerIdentity(propertyId));
}

export async function updateInvoiceBranding(input: {
  context: UserContext;
  propertyId: string;
  logoUrl?: string | null;
  legalFooter?: string | null;
  correlationId: string;
}): Promise<InvoiceIssuer> {
  requirePermissions(input.context, ["property.configure"]);
  await prisma.property.update({
    where: { id: input.propertyId },
    data: {
      ...(input.logoUrl !== undefined ? { invoiceLogoUrl: input.logoUrl || null } : {}),
      ...(input.legalFooter !== undefined ? { invoiceLegalFooter: input.legalFooter || null } : {})
    }
  });
  recordAuditEvent({
    organizationId: input.context.organizationId,
    propertyId: input.propertyId,
    actorUserId: input.context.userId,
    actorType: "user",
    action: "INVOICE_BRANDING_UPDATED",
    entityType: "property",
    entityId: input.propertyId,
    afterJson: { logoUrlSet: input.logoUrl !== undefined, legalFooterSet: input.legalFooter !== undefined },
    correlationId: input.correlationId
  });
  return identityToIssuer(await resolveIssuerIdentity(input.propertyId));
}

// FX rate (currency → EUR) for a non-EUR invoice, shared by the folio and the
// manual draft paths. getExchangeRate throws a plain "No FX rate available …"
// Error when the currency has no rate on file — a client error (400), not a
// 500; anything else (DB failure) keeps propagating.
export async function resolveInvoiceFxRate(currencyCode: string, organizationId: string): Promise<number> {
  try {
    return await getExchangeRate({ base: currencyCode, quote: "EUR", organizationId });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("No FX rate available")) {
      throw new BadRequestError(
        `Moneda sin tipo de cambio disponible: ${currencyCode}. ` +
          `Configura el tipo de cambio ${currencyCode}→EUR antes de facturar en esa moneda.`
      );
    }
    throw error;
  }
}

export const FOLIO_ALREADY_INVOICED_CODE = "FOLIO_ALREADY_INVOICED";

export type FolioInvoiceRow = {
  id: string;
  invoiceNumber: string | null;
  status: InvoiceStatusValue;
  total: number;
  rectifyingForId: string | null;
};

/**
 * DUP-FOLIO-INVOICE: the invoice that stops a folio from being invoiced
 * again, or null. Only live invoices (draft / issued) block; cancelled and
 * rectified never do, so a folio whose previous invoices were ALL cancelled /
 * rectified can be invoiced again. A rectificativa that fully reverses its
 * original (total = −original.total, credit-note style) does not block
 * either: the folio's charges are un-invoiced again and "credit note + new
 * invoice" is the normal correction flow. A partial rectificativa does block,
 * because original + delta still represent the folio's live invoice.
 * Pure; `rows` in the caller's preference order (most recent first).
 */
export function findBlockingFolioInvoice(rows: FolioInvoiceRow[]): FolioInvoiceRow | null {
  const byId = new Map(rows.map((row) => [row.id, row]));
  for (const row of rows) {
    if (row.status !== "draft" && row.status !== "issued") continue;
    if (row.rectifyingForId) {
      const original = byId.get(row.rectifyingForId);
      if (original && Math.abs(row.total + original.total) < CENT_TOLERANCE) continue;
    }
    return row;
  }
  return null;
}

/** 409 for a folio that already has a live invoice (details.code = FOLIO_ALREADY_INVOICED). Pure. */
export function folioAlreadyInvoicedError(existing: FolioInvoiceRow): ConflictError {
  const label = existing.invoiceNumber ?? `borrador ${existing.id}`;
  const message =
    existing.status === "draft"
      ? `El folio ya tiene una factura (${label}) en estado borrador; emítela en lugar de crear otra, o anúlala/rectifícala una vez emitida antes de facturar de nuevo.`
      : `El folio ya tiene una factura (${label}) en estado emitida; anúlala o rectifícala antes de facturar de nuevo.`;
  const error = new ConflictError(message);
  error.details = {
    code: FOLIO_ALREADY_INVOICED_CODE,
    invoiceId: existing.id,
    invoiceNumber: existing.invoiceNumber,
    status: existing.status
  };
  return error;
}

function toFolioInvoiceRow(row: Pick<InvoiceRow, "id" | "invoiceNumber" | "status" | "total" | "rectifyingForId">): FolioInvoiceRow {
  return { id: row.id, invoiceNumber: row.invoiceNumber, status: row.status, total: dec(row.total), rectifyingForId: row.rectifyingForId };
}

const FOLIO_INVOICE_SELECT = { id: true, invoiceNumber: true, status: true, total: true, rectifyingForId: true } as const;

type FolioInvoiceDb = Pick<Prisma.TransactionClient, "invoice">;

/** Live-or-not invoices of a folio by Invoice.folioId, most recent first. */
async function loadFolioInvoices(db: FolioInvoiceDb, folioId: string): Promise<FolioInvoiceRow[]> {
  const rows = await db.invoice.findMany({
    where: { folioId, deletedAt: null },
    select: FOLIO_INVOICE_SELECT,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }]
  });
  return rows.map(toFolioInvoiceRow);
}

/**
 * Invoices created from this folio before Invoice.folioId existed (folio_id
 * still NULL): found through their INVOICE_DRAFT_CREATED audit
 * (afterJson.folioId, written since day one). Bounded by the reservation's
 * createdAt on the (organizationId, propertyId, createdAt) index so the JSON
 * filter only scans the property's audit trail since the reservation was
 * made. Rows already linked by folioId are not returned twice.
 */
async function loadLegacyFolioInvoices(input: { organizationId: string; propertyId: string; folioId: string; since: Date }): Promise<FolioInvoiceRow[]> {
  const audits = await prisma.auditEvent.findMany({
    where: {
      organizationId: input.organizationId,
      propertyId: input.propertyId,
      createdAt: { gte: input.since },
      entityType: "invoice",
      action: "INVOICE_DRAFT_CREATED",
      afterJson: { path: ["folioId"], equals: input.folioId }
    },
    select: { entityId: true }
  });
  const ids = Array.from(new Set(audits.map((audit) => audit.entityId).filter((id): id is string => typeof id === "string" && id.length > 0)));
  if (ids.length === 0) return [];
  const rows = await prisma.invoice.findMany({
    where: { id: { in: ids }, folioId: null, deletedAt: null },
    select: FOLIO_INVOICE_SELECT,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }]
  });
  return rows.map(toFolioInvoiceRow);
}

export type TaxResolutionLine = { lineType: string; taxCode: string; ratePercent: number };

/**
 * Non-blocking warnings for folio lines that will be invoiced without VAT
 * (TAX-UNKNOWN-0 is fixed in Tanda 3; this only makes it visible). One
 * warning per line type. `taxCode` is the resolver's raw code ("UNKNOWN" when
 * the property's region has no Tax row at all). Pure.
 */
export function taxResolutionWarnings(lines: TaxResolutionLine[]): string[] {
  const warnings: string[] = [];
  const seen = new Set<string>();
  for (const line of lines) {
    if (line.taxCode !== "UNKNOWN" && line.ratePercent !== 0) continue;
    const key = `${line.taxCode}::${line.lineType}`;
    if (seen.has(key)) continue;
    seen.add(key);
    warnings.push(
      line.taxCode === "UNKNOWN"
        ? `Sin tipo impositivo configurado para «${line.lineType}» (la región fiscal de la propiedad no tiene impuesto configurado, código ES_UNKNOWN_0): la factura sale sin IVA en esa línea.`
        : `Sin tipo impositivo configurado para «${line.lineType}» (tipo 0 % resuelto para ${line.taxCode}, sin tipo para ese concepto o tipo cero explícito): la factura sale sin IVA en esa línea.`
    );
  }
  return warnings;
}

export async function createInvoiceFromFolio(input: {
  context: UserContext;
  folioId: string;
  customerType?: InvoiceRecord["customerType"];
  customerTaxId?: string;
  invoiceType?: InvoiceRecord["invoiceType"];
  currencyCode?: string;
  correlationId: string;
}): Promise<InvoiceRecord> {
  requirePermissions(input.context, ["invoice.issue"]);

  const folio = await prisma.folio.findUnique({ where: { id: input.folioId } });
  if (!folio) throw new NotFoundError("Folio no encontrado.");
  const reservation = await prisma.reservation.findUnique({ where: { id: folio.reservationId } });
  if (!reservation) throw new NotFoundError("Reserva del folio no encontrada.");

  // DUP-FOLIO-INVOICE: one live invoice per folio. Fast fail here (before tax
  // / FX work) over Invoice.folioId plus the audit heuristic for invoices
  // created before folio_id existed; re-checked under a folio row lock inside
  // the transaction below so two concurrent requests cannot both pass.
  const [linkedInvoices, legacyInvoices] = await Promise.all([
    loadFolioInvoices(prisma, folio.id),
    loadLegacyFolioInvoices({
      organizationId: input.context.organizationId,
      propertyId: reservation.propertyId,
      folioId: folio.id,
      since: reservation.createdAt
    })
  ]);
  const blocking = findBlockingFolioInvoice([...linkedInvoices, ...legacyInvoices]);
  if (blocking) throw folioAlreadyInvoicedError(blocking);

  const folioLines = await prisma.folioLine.findMany({ where: { folioId: folio.id } });
  if (folioLines.length === 0) throw new BadRequestError("El folio no tiene cargos que facturar.");

  let total = 0;
  let taxTotal = 0;
  const taxLines: TaxResolutionLine[] = [];
  const invoiceLinesData = await Promise.all(folioLines.map(async (line) => {
    const resolved = await resolveTaxRate({
      propertyId: reservation.propertyId,
      lineType: line.type,
      postingDate: line.postedAt
    });
    const ratePercent = resolved.ratePercent;
    taxLines.push({ lineType: line.type, taxCode: resolved.taxCode, ratePercent });
    const ratePct = ratePercent / 100;
    const lineTotal = dec(line.total);
    const net = ratePct > 0 ? round(lineTotal / (1 + ratePct)) : lineTotal;
    const vat = round(lineTotal - net);
    total += lineTotal;
    taxTotal += vat;
    return {
      description: line.description,
      quantity: dec(line.quantity),
      unitPrice: dec(line.unitPrice),
      taxCode: buildTaxCode(resolved.taxCode, ratePercent),
      taxRate: ratePercent,
      total: lineTotal
    };
  }));
  // Lines invoiced without VAT are reported, not blocked (TAX-UNKNOWN-0 → Tanda 3).
  const warnings = taxResolutionWarnings(taxLines);
  for (const warning of warnings) {
    console.warn(`[invoice.fromFolio] corr=${input.correlationId} folio=${folio.id} property=${reservation.propertyId}: ${warning}`);
  }

  // Multi-currency (Sprint 24). Default to EUR; when the caller passes a
  // non-EUR currency we look up the FX rate at creation time and persist
  // both `fxRate` and `baseTotal` (the EUR equivalent of `total`). Snapshot-
  // ing the rate at creation means a later reprint reproduces the same
  // numbers even if the rate table moves.
  const currencyCode = (input.currencyCode ?? "EUR").toUpperCase();
  let fxRate: number | null = null;
  let baseTotal: number | null = null;
  if (currencyCode !== "EUR") {
    fxRate = await resolveInvoiceFxRate(currencyCode, input.context.organizationId);
    baseTotal = round(round(total) * fxRate);
  }

  const created = await prisma.$transaction(async (tx) => {
    // Serialise concurrent invoicing of the same folio: the row lock makes a
    // second transaction wait here and then see the invoice the first one
    // committed (read committed), so the re-check below is race-safe.
    await tx.$queryRaw`SELECT id FROM folios WHERE id = ${folio.id} FOR UPDATE`;
    const concurrent = findBlockingFolioInvoice(await loadFolioInvoices(tx, folio.id));
    if (concurrent) throw folioAlreadyInvoicedError(concurrent);
    const invoice = await tx.invoice.create({
      data: {
        propertyId: reservation.propertyId,
        invoiceType: input.invoiceType ?? "F1",
        customerType: input.customerType ?? "guest",
        customerTaxId: input.customerTaxId ?? null,
        status: "draft",
        total: round(total),
        taxTotal: round(taxTotal),
        currencyCode,
        fxRate: fxRate !== null ? fxRate.toFixed(8) : null,
        baseTotal: baseTotal !== null ? baseTotal.toFixed(2) : null,
        // FISC-04: the source folio is the payment target of markInvoicePaid.
        folioId: folio.id,
        reservationId: folio.reservationId
      }
    });
    await tx.invoiceLine.createMany({
      data: invoiceLinesData.map((l) => ({
        invoiceId: invoice.id,
        description: l.description,
        quantity: l.quantity,
        unitPrice: l.unitPrice,
        taxCode: l.taxCode,
        taxRate: l.taxRate,
        total: l.total
      }))
    });
    return invoice;
  });

  recordAuditEvent({
    organizationId: input.context.organizationId,
    propertyId: reservation.propertyId,
    actorUserId: input.context.userId,
    actorType: "user",
    action: "INVOICE_DRAFT_CREATED",
    entityType: "invoice",
    entityId: created.id,
    afterJson: { folioId: folio.id, reservationId: folio.reservationId, total: round(total), taxTotal: round(taxTotal), warnings },
    correlationId: input.correlationId
  });

  const record = await loadInvoice(created.id);
  return { ...record, warnings };
}

export async function issueInvoice(input: {
  context: UserContext;
  invoiceId: string;
  correlationId: string;
}): Promise<InvoiceRecord> {
  requirePermissions(input.context, ["invoice.issue"]);

  const existing = await prisma.invoice.findUnique({ where: { id: input.invoiceId } });
  if (!existing) throw new NotFoundError("Factura no encontrada.");
  if (existing.status !== "draft") {
    throw new ConflictError("Las facturas emitidas son inmutables: usa anulación, abono o rectificativa.");
  }

  // FISC-03: single source of the issuer NIF (409 in fiscal production mode
  // without a valid NIF; flagged placeholder in sandbox). Snapshotted below so
  // hash / QR / XML stay reproducible.
  const issuer = await requireIssuerIdentity(existing.propertyId);
  const emitterTaxId = issuer.taxId;

  const sequenceCode = existing.invoiceType === "F1" ? "FAC" : existing.invoiceType === "F2" ? "SIM" : existing.invoiceType.startsWith("R") ? "REC" : "FAC";

  const issued = await prisma.$transaction(async (tx) => {
    const sequence = await tx.invoiceSequence.upsert({
      where: { propertyId_sequenceCode: { propertyId: existing.propertyId, sequenceCode } },
      update: { nextNumber: { increment: 1 } },
      create: {
        propertyId: existing.propertyId,
        sequenceCode,
        prefix: `${sequenceCode}-${new Date().getUTCFullYear()}-`,
        nextNumber: 2,
        padding: 6,
        invoiceType: existing.invoiceType
      }
    });
    const number = sequence.nextNumber - 1;
    const prefix = sequence.prefix ?? `${sequenceCode}-${new Date().getUTCFullYear()}-`;
    const invoiceNumber = `${prefix}${String(number).padStart(sequence.padding, "0")}`;

    const previous = await tx.invoice.findFirst({
      where: { propertyId: existing.propertyId, status: "issued" },
      orderBy: { issuedAt: "desc" },
      select: { verifactuHash: true }
    });
    const issuedAt = new Date();
    const { canonical, hash } = computeVerifactuHash({
      emitterTaxId,
      invoiceNumber,
      issuedAt: issuedAt.toISOString(),
      invoiceType: existing.invoiceType as VerifactuInvoiceType,
      vatTotal: dec(existing.taxTotal),
      invoiceTotal: dec(existing.total),
      previousHash: previous?.verifactuHash ?? null
    });
    const qrUrl = buildVerifactuQrUrl({
      emitterTaxId,
      invoiceNumber,
      issuedAt: issuedAt.toISOString(),
      invoiceTotal: dec(existing.total),
      preProduction: issuer.fiscalMode !== "production"
    });

    const updated = await tx.invoice.update({
      where: { id: existing.id },
      data: {
        status: "issued",
        issuedAt,
        invoiceNumber,
        verifactuHash: hash,
        previousInvoiceHash: previous?.verifactuHash ?? null,
        qrPayload: qrUrl,
        issuerTaxId: emitterTaxId,
        issuerLegalName: issuer.legalName,
        issuerTaxIdPlaceholder: issuer.placeholder
      }
    });
    return { invoice: updated, canonical, hash };
  });

  const after = await loadInvoice(issued.invoice.id);

  recordAuditEvent({
    organizationId: input.context.organizationId,
    propertyId: existing.propertyId,
    actorUserId: input.context.userId,
    actorType: "user",
    action: "INVOICE_ISSUED",
    entityType: "invoice",
    entityId: after.id,
    afterJson: {
      invoiceNumber: after.invoiceNumber,
      verifactuHash: after.verifactuHash,
      previousInvoiceHash: after.previousInvoiceHash,
      total: after.total,
      taxTotal: after.taxTotal,
      hashCanonical: issued.canonical,
      issuerTaxId: emitterTaxId,
      issuerLegalName: issuer.legalName,
      issuerTaxIdPlaceholder: issuer.placeholder,
      fiscalMode: issuer.fiscalMode
    },
    correlationId: input.correlationId
  });

  recordDomainEvent({
    organizationId: input.context.organizationId,
    propertyId: existing.propertyId,
    entityType: "invoice",
    entityId: after.id,
    eventType: "InvoiceIssued",
    payload: { invoiceNumber: after.invoiceNumber!, verifactuHash: after.verifactuHash!, total: after.total },
    actorType: "user",
    actorUserId: input.context.userId,
    correlationId: input.correlationId
  });

  return after;
}

export async function cancelInvoice(input: {
  context: UserContext;
  invoiceId: string;
  reason: string;
  correlationId: string;
}): Promise<InvoiceRecord> {
  requirePermissions(input.context, ["invoice.cancel"]);
  const existing = await prisma.invoice.findUnique({ where: { id: input.invoiceId } });
  if (!existing) throw new NotFoundError("Factura no encontrada.");
  if (existing.status !== "issued") {
    throw new ConflictError("Solo las facturas emitidas admiten anulación.");
  }
  const before = await loadInvoice(existing.id);
  await prisma.invoice.update({
    where: { id: existing.id },
    data: { status: "cancelled", cancelledAt: new Date() }
  });
  const after = await loadInvoice(existing.id);

  // Post reversal journal entry (DR revenue + DR VAT-output, CR customer A/R).
  // Idempotent by (sourceType="invoice_cancellation", sourceId=invoiceId).
  await postCancellationReversal({
    organizationId: input.context.organizationId,
    propertyId: existing.propertyId,
    invoiceId: existing.id,
    total: before.total,
    taxTotal: before.taxTotal,
    invoiceNumber: before.invoiceNumber,
    actorUserId: input.context.userId,
    reason: input.reason
  });

  recordAuditEvent({
    organizationId: input.context.organizationId,
    propertyId: existing.propertyId,
    actorUserId: input.context.userId,
    actorType: "user",
    action: "INVOICE_CANCELLED",
    entityType: "invoice",
    entityId: existing.id,
    beforeJson: before,
    afterJson: { ...after, reason: input.reason },
    correlationId: input.correlationId
  });

  recordDomainEvent({
    organizationId: input.context.organizationId,
    propertyId: existing.propertyId,
    entityType: "invoice",
    entityId: existing.id,
    eventType: "InvoiceCancelled",
    payload: {
      invoiceNumber: before.invoiceNumber ?? null,
      reason: input.reason,
      total: before.total,
      taxTotal: before.taxTotal
    },
    actorType: "user",
    actorUserId: input.context.userId,
    correlationId: input.correlationId
  });

  return after;
}

/**
 * Best-effort reversal posting for a cancelled invoice. Mirrors the original
 * revenue posting in reverse (DR 705 net, DR 477 VAT, CR 4300 total).
 * Idempotent on (sourceType="invoice_cancellation", sourceId=invoiceId).
 * Silently degrades if the organization's chart of accounts is incomplete —
 * the cancellation itself still succeeds; the reversal is logged for follow-up.
 */
async function postCancellationReversal(input: {
  organizationId: string;
  propertyId: string;
  invoiceId: string;
  total: number;
  taxTotal: number;
  invoiceNumber?: string;
  actorUserId?: string;
  reason: string;
}): Promise<void> {
  const sourceType = "invoice_cancellation";
  try {
    const existing = await prisma.journalEntry.findFirst({
      where: { organizationId: input.organizationId, sourceType, sourceId: input.invoiceId },
      select: { id: true }
    });
    if (existing) return;

    const net = round(input.total - input.taxTotal);
    const vat = round(input.taxTotal);
    const total = round(input.total);
    if (total === 0) return;

    const lines: Array<{ accountCode: string; debit: number; credit: number; description: string }> = [];
    if (net !== 0) {
      lines.push({
        accountCode: "705",
        debit: net,
        credit: 0,
        description: `Reverse revenue (cancellation ${input.invoiceNumber ?? input.invoiceId})`
      });
    }
    if (vat !== 0) {
      lines.push({
        accountCode: "477",
        debit: vat,
        credit: 0,
        description: `Reverse VAT output (cancellation ${input.invoiceNumber ?? input.invoiceId})`
      });
    }
    lines.push({
      accountCode: "4300",
      debit: 0,
      credit: total,
      description: `Reverse A/R (cancellation ${input.invoiceNumber ?? input.invoiceId})`
    });

    const codes = Array.from(new Set(lines.map((l) => l.accountCode)));
    const accounts = await prisma.account.findMany({
      where: { organizationId: input.organizationId, code: { in: codes } },
      select: { id: true, code: true }
    });
    const codeToId = new Map(accounts.map((a) => [a.code, a.id]));
    if (lines.some((l) => !codeToId.get(l.accountCode))) {
      console.warn(
        `[invoice.cancel] skipping reversal journal for invoice ${input.invoiceId}: chart accounts missing for org ${input.organizationId}`
      );
      return;
    }

    await prisma.$transaction(async (tx) => {
      const entry = await tx.journalEntry.create({
        data: {
          organizationId: input.organizationId,
          propertyId: input.propertyId,
          sourceType,
          sourceId: input.invoiceId,
          status: "posted",
          postedAt: new Date(),
          createdBy: input.actorUserId ?? null,
          entryKind: "reversal"
        }
      });
      await tx.journalLine.createMany({
        data: lines.map((line) => ({
          journalEntryId: entry.id,
          accountId: codeToId.get(line.accountCode)!,
          debit: line.debit,
          credit: line.credit,
          currency: "EUR",
          description: line.description
        }))
      });
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(
      `[invoice.cancel] reversal posting failed for invoice ${input.invoiceId}: ${message}`
    );
  }
}

export type RectifyingReasonCode = "R1" | "R2" | "R3" | "R4" | "R5";

export const RECTIFYING_REASON_LABELS: Record<RectifyingReasonCode, string> = {
  R1: "R1 — Error fundado en derecho (art. 80.1, 80.2 LIVA / art. 13 RD 1496/2003)",
  R2: "R2 — Concurso de acreedores (art. 80.3 LIVA)",
  R3: "R3 — Créditos incobrables (art. 80.4 LIVA)",
  R4: "R4 — Otras causas",
  R5: "R5 — Factura rectificativa en facturas simplificadas"
};

export type RectifyingLineAdjustment = {
  lineId: string;
  quantity?: number;
  unitPrice?: number;
};

/**
 * Create a *factura rectificativa* (RD 1496/2003 art. 13–15, RD 87/2005).
 *
 * - The original invoice must be in `issued` status (cannot rectify a draft,
 *   an already-rectified invoice, or a cancelled invoice).
 * - The new invoice carries `invoiceType` set to the rectifying reason code
 *   (R1..R5), which is what VeriFactu / AEAT consume as `TipoFactura`.
 * - `fullReversal` copies every original line negated (full credit-note style).
 * - `lineAdjustments` produces delta lines = (new qty × unitPrice) − (orig qty × unitPrice),
 *   so the resulting rectificativa reflects only the *change* from the original.
 * - The VeriFactu hash chain is extended: the new invoice's `previousInvoiceHash`
 *   points at the most recent issued invoice's hash; the rectifying record gets
 *   its own hash so AEAT can audit the chain.
 * - Idempotent: a second call with the same (originalInvoiceId, reasonCode)
 *   returns the existing rectifying invoice instead of creating a duplicate.
 */
export async function createRectifyingInvoice(input: {
  context: UserContext;
  originalInvoiceId: string;
  reasonCode: RectifyingReasonCode;
  lineAdjustments?: RectifyingLineAdjustment[];
  fullReversal?: boolean;
  correlationId: string;
}): Promise<InvoiceRecord> {
  requirePermissions(input.context, ["invoice.issue"]);

  if (!["R1", "R2", "R3", "R4", "R5"].includes(input.reasonCode)) {
    throw new BadRequestError("rectifyingReasonCode debe ser R1, R2, R3, R4 o R5.");
  }

  const original = await prisma.invoice.findUnique({ where: { id: input.originalInvoiceId } });
  if (!original) throw new NotFoundError("Factura original no encontrada.");
  if (original.status !== "issued") {
    throw new ConflictError("Solo las facturas emitidas admiten rectificación.");
  }

  // Idempotency: refuse a duplicate rectifying for the same (original, reason).
  const duplicate = await prisma.invoice.findFirst({
    where: { rectifyingForId: original.id, rectifyingReasonCode: input.reasonCode },
    select: { id: true }
  });
  if (duplicate) return loadInvoice(duplicate.id);

  const originalLines = await prisma.invoiceLine.findMany({ where: { invoiceId: original.id } });
  if (originalLines.length === 0) {
    throw new ConflictError("La factura original no tiene líneas que rectificar.");
  }

  // Build the rectifying lines.
  type RectLine = {
    description: string;
    quantity: number;
    unitPrice: number;
    taxCode: string;
    taxRate: number;
    total: number;
  };
  const rectLines: RectLine[] = [];

  if (input.fullReversal || !input.lineAdjustments || input.lineAdjustments.length === 0) {
    // Full reversal: negate every original line.
    for (const line of originalLines) {
      const qty = dec(line.quantity);
      const unitPrice = dec(line.unitPrice);
      const total = dec(line.total);
      rectLines.push({
        description: `Reversión: ${line.description}`,
        quantity: -qty,
        unitPrice,
        taxCode: line.taxCode,
        taxRate: dec(line.taxRate),
        total: round(-total)
      });
    }
  } else {
    const adjustmentMap = new Map(input.lineAdjustments.map((a) => [a.lineId, a]));
    for (const line of originalLines) {
      const adj = adjustmentMap.get(line.id);
      if (!adj) continue;
      const origQty = dec(line.quantity);
      const origUnitPrice = dec(line.unitPrice);
      const newQty = adj.quantity ?? origQty;
      const newUnitPrice = adj.unitPrice ?? origUnitPrice;
      const ratePercent = dec(line.taxRate);
      const ratePct = ratePercent / 100;
      const origGross = round(origQty * origUnitPrice * (1 + ratePct));
      const newGross = round(newQty * newUnitPrice * (1 + ratePct));
      const deltaTotal = round(newGross - origGross);
      if (deltaTotal === 0) continue;
      rectLines.push({
        description: `Rectificación: ${line.description}`,
        quantity: round(newQty - origQty),
        unitPrice: newUnitPrice,
        taxCode: line.taxCode,
        taxRate: ratePercent,
        total: deltaTotal
      });
    }
    if (rectLines.length === 0) {
      throw new BadRequestError("lineAdjustments no produce ningún cambio neto; no hay nada que rectificar.");
    }
  }

  // Sum totals and VAT.
  let total = 0;
  let taxTotal = 0;
  for (const line of rectLines) {
    const ratePct = line.taxRate / 100;
    const net = ratePct > 0 ? line.total / (1 + ratePct) : line.total;
    const vat = line.total - net;
    total += line.total;
    taxTotal += vat;
  }
  total = round(total);
  taxTotal = round(taxTotal);

  // FISC-03: the rectificativa is a new fiscal record, so it takes the CURRENT
  // issuer identity (same 409 / placeholder policy as issueInvoice). The
  // reference to the rectified invoice keeps that invoice's own snapshot
  // (verifactu-submission reads it from the original row).
  const issuer = await requireIssuerIdentity(original.propertyId);
  const emitterTaxId = issuer.taxId;

  const sequenceCode = "REC";

  const created = await prisma.$transaction(async (tx) => {
    // Allocate next number from a dedicated rectifying sequence.
    const sequence = await tx.invoiceSequence.upsert({
      where: { propertyId_sequenceCode: { propertyId: original.propertyId, sequenceCode } },
      update: { nextNumber: { increment: 1 } },
      create: {
        propertyId: original.propertyId,
        sequenceCode,
        prefix: `${sequenceCode}-${new Date().getUTCFullYear()}-`,
        nextNumber: 2,
        padding: 6,
        invoiceType: input.reasonCode
      }
    });
    const number = sequence.nextNumber - 1;
    const prefix = sequence.prefix ?? `${sequenceCode}-${new Date().getUTCFullYear()}-`;
    const invoiceNumber = `${prefix}${String(number).padStart(sequence.padding, "0")}`;

    // Hash chain: link to the latest issued invoice in this property.
    const previous = await tx.invoice.findFirst({
      where: { propertyId: original.propertyId, status: "issued" },
      orderBy: { issuedAt: "desc" },
      select: { verifactuHash: true }
    });
    const issuedAt = new Date();
    const { canonical, hash } = computeVerifactuHash({
      emitterTaxId,
      invoiceNumber,
      issuedAt: issuedAt.toISOString(),
      invoiceType: input.reasonCode as VerifactuInvoiceType,
      vatTotal: taxTotal,
      invoiceTotal: total,
      previousHash: previous?.verifactuHash ?? null
    });
    const qrUrl = buildVerifactuQrUrl({
      emitterTaxId,
      invoiceNumber,
      issuedAt: issuedAt.toISOString(),
      invoiceTotal: total,
      preProduction: issuer.fiscalMode !== "production"
    });

    const invoice = await tx.invoice.create({
      data: {
        propertyId: original.propertyId,
        invoiceNumber,
        invoiceType: input.reasonCode,
        customerType: original.customerType,
        customerTaxId: original.customerTaxId,
        currencyCode: original.currencyCode,
        status: "issued",
        issuedAt,
        total,
        taxTotal,
        rectifyingForId: original.id,
        rectifyingReasonCode: input.reasonCode,
        verifactuHash: hash,
        previousInvoiceHash: previous?.verifactuHash ?? null,
        qrPayload: qrUrl,
        // Same folio / reservation as the original so payments and reports
        // can follow the chain.
        folioId: original.folioId,
        reservationId: original.reservationId,
        issuerTaxId: emitterTaxId,
        issuerLegalName: issuer.legalName,
        issuerTaxIdPlaceholder: issuer.placeholder
      }
    });

    await tx.invoiceLine.createMany({
      data: rectLines.map((l) => ({
        invoiceId: invoice.id,
        description: l.description,
        quantity: l.quantity,
        unitPrice: l.unitPrice,
        taxCode: l.taxCode,
        taxRate: l.taxRate,
        total: l.total
      }))
    });

    // Mark the original as rectified.
    await tx.invoice.update({
      where: { id: original.id },
      data: { status: "rectified" }
    });

    return { invoice, canonical, hash };
  });

  const after = await loadInvoice(created.invoice.id);

  recordAuditEvent({
    organizationId: input.context.organizationId,
    propertyId: original.propertyId,
    actorUserId: input.context.userId,
    actorType: "user",
    action: "INVOICE_RECTIFIED",
    entityType: "invoice",
    entityId: after.id,
    afterJson: {
      rectifyingForId: original.id,
      rectifyingReasonCode: input.reasonCode,
      invoiceNumber: after.invoiceNumber,
      verifactuHash: after.verifactuHash,
      previousInvoiceHash: after.previousInvoiceHash,
      total: after.total,
      taxTotal: after.taxTotal,
      fullReversal: !!input.fullReversal,
      hashCanonical: created.canonical,
      issuerTaxId: emitterTaxId,
      issuerLegalName: issuer.legalName,
      issuerTaxIdPlaceholder: issuer.placeholder,
      fiscalMode: issuer.fiscalMode
    },
    correlationId: input.correlationId
  });

  // Emit InvoiceIssued so VeriFactu submission picks the rectificativa up
  // and propagates it through the same submission pipeline. The payload
  // carries the rectifying linkage so downstream consumers can audit it.
  recordDomainEvent({
    organizationId: input.context.organizationId,
    propertyId: original.propertyId,
    entityType: "invoice",
    entityId: after.id,
    eventType: "InvoiceIssued",
    payload: {
      invoiceNumber: after.invoiceNumber!,
      verifactuHash: after.verifactuHash!,
      total: after.total,
      rectifyingForId: original.id,
      rectifyingReasonCode: input.reasonCode
    },
    actorType: "user",
    actorUserId: input.context.userId,
    correlationId: input.correlationId
  });

  return after;
}

export async function listRectifyingInvoices(originalInvoiceId: string): Promise<InvoiceRecord[]> {
  const rows = await prisma.invoice.findMany({
    where: { rectifyingForId: originalInvoiceId, deletedAt: null },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: MAX_PAGE_LIMIT
  });
  return hydrateInvoiceRecords(rows);
}

export type InvoiceFolioBackfillResult = {
  scanned: number;
  linked: number;
  /** Of `linked`: from the INVOICE_DRAFT_CREATED audit (invoices created from a folio). */
  fromAudit: number;
  /** Of `linked`: rectificativas inheriting the folio of the invoice they rectify. */
  fromRectified: number;
  /** Manual drafts (no audit folioId, not a rectificativa of a linked invoice) or folio gone. */
  skipped: number;
  dryRun: boolean;
};

export type FolioLinkCandidate = { folioId: string; source: "audit" | "rectified" };

/**
 * Folio per invoice for one backfill batch. Audit first; then rectificativas
 * (rectifyingForId) inherit the folio of the invoice they rectify — from the
 * database, or from a link resolved earlier in this run (`resolved`, shared
 * across batches so a dry run counts chains the same way a real run would).
 * Iterates until stable so REC-of-REC chains resolve within one batch. Pure.
 */
export function resolveFolioLinkCandidates(input: {
  rows: Array<{ id: string; rectifyingForId: string | null }>;
  auditFolioByInvoice: Map<string, string>;
  originalFolioById: Map<string, string | null>;
  resolved: Map<string, string>;
}): Map<string, FolioLinkCandidate> {
  const candidates = new Map<string, FolioLinkCandidate>();
  for (const row of input.rows) {
    const folioId = input.auditFolioByInvoice.get(row.id);
    if (folioId) {
      candidates.set(row.id, { folioId, source: "audit" });
      input.resolved.set(row.id, folioId);
    }
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of input.rows) {
      if (candidates.has(row.id) || !row.rectifyingForId) continue;
      const folioId = input.resolved.get(row.rectifyingForId) ?? input.originalFolioById.get(row.rectifyingForId) ?? null;
      if (!folioId) continue;
      candidates.set(row.id, { folioId, source: "rectified" });
      input.resolved.set(row.id, folioId);
      changed = true;
    }
  }
  return candidates;
}

/**
 * One-shot backfill of Invoice.folioId / reservationId for invoices created
 * before the columns existed: from the INVOICE_DRAFT_CREATED audit event
 * (afterJson.folioId, written by createInvoiceFromFolio since day one), and
 * for rectificativas (REC-…, which have no such audit) from the invoice they
 * rectify. Manual drafts have no folio and stay null. Payments are NOT
 * relinked here: markInvoicePaid used to pick an arbitrary folio, so any
 * (folio, amount) match must be reviewed by hand — the list's folio_match
 * heuristic covers the display meanwhile. Idempotent; dry-run by default.
 *
 *   cd apps/api && node --env-file=../../.env --import tsx -e \
 *     "import('./src/modules/invoicing/invoice.service.ts').then(m => m.backfillInvoiceFolioLinks({ dryRun: false })).then(r => { console.log(r); process.exit(0); })"
 */
export async function backfillInvoiceFolioLinks(options: { dryRun?: boolean; propertyId?: string; batchSize?: number } = {}): Promise<InvoiceFolioBackfillResult> {
  const dryRun = options.dryRun ?? true;
  const batchSize = options.batchSize ?? 200;
  const result: InvoiceFolioBackfillResult = { scanned: 0, linked: 0, fromAudit: 0, fromRectified: 0, skipped: 0, dryRun };
  // invoiceId → folioId resolved in this run (in-batch or earlier batches).
  const resolved = new Map<string, string>();
  let cursor: string | undefined;
  for (;;) {
    const rows = await prisma.invoice.findMany({
      where: { folioId: null, ...(options.propertyId ? { propertyId: options.propertyId } : {}) },
      select: { id: true, rectifyingForId: true },
      orderBy: { id: "asc" },
      take: batchSize,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {})
    });
    if (rows.length === 0) break;
    cursor = rows[rows.length - 1]!.id;
    result.scanned += rows.length;
    const audits = await prisma.auditEvent.findMany({
      where: { action: "INVOICE_DRAFT_CREATED", entityType: "invoice", entityId: { in: rows.map((r) => r.id) } },
      select: { entityId: true, afterJson: true },
      orderBy: { createdAt: "asc" }
    });
    const auditFolioByInvoice = new Map<string, string>();
    for (const audit of audits) {
      const folioId = (audit.afterJson as { folioId?: unknown } | null)?.folioId;
      if (audit.entityId && typeof folioId === "string" && folioId) auditFolioByInvoice.set(audit.entityId, folioId);
    }
    const originalIds = Array.from(new Set(rows.map((r) => r.rectifyingForId).filter((id): id is string => !!id)));
    const originals = originalIds.length
      ? await prisma.invoice.findMany({ where: { id: { in: originalIds } }, select: { id: true, folioId: true } })
      : [];
    const originalFolioById = new Map(originals.map((o) => [o.id, o.folioId]));
    const candidates = resolveFolioLinkCandidates({ rows, auditFolioByInvoice, originalFolioById, resolved });
    const folioIds = Array.from(new Set(Array.from(candidates.values()).map((c) => c.folioId)));
    const folios = folioIds.length
      ? await prisma.folio.findMany({ where: { id: { in: folioIds } }, select: { id: true, reservationId: true } })
      : [];
    const reservationByFolio = new Map(folios.map((f) => [f.id, f.reservationId]));
    for (const row of rows) {
      const candidate = candidates.get(row.id);
      const reservationId = candidate ? reservationByFolio.get(candidate.folioId) : undefined;
      if (!candidate || !reservationId) {
        result.skipped += 1;
        continue;
      }
      if (!dryRun) await prisma.invoice.update({ where: { id: row.id }, data: { folioId: candidate.folioId, reservationId } });
      result.linked += 1;
      if (candidate.source === "audit") result.fromAudit += 1;
      else result.fromRectified += 1;
    }
    if (rows.length < batchSize) break;
  }
  return result;
}
