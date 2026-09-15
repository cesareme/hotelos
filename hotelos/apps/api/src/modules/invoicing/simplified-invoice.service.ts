// Simplified invoice for cash / terminal sales (TPV al contado) — finanzas
// lote facturación-cobros, 2026-09-15. Called by the TPV lote when a POS
// ticket is settled in the act (settlement cash | card); room charges never
// come here (they stay on the folio until the folio invoice).
//
// Canonical rules: factura simplificada F2 in the SIM series (art. 4 RD
// 1619/2012: no recipient needed up to 400 € — 3.000 € for pure F&B sales),
// snapshot frozen at issuance, row per rate in the libro de emitidas and the
// entry D 570 | 5721 / H 705.x / H 477.tipo (no 4300: the receivable is
// settled in the act). Idempotent by (propertyId, posOrderId) when the
// caller passes the ticket id.

import { buildVerifactuQrUrl, computeVerifactuHash, normalizeTaxId, roundMoney, type VerifactuInvoiceType } from "@hotelos/compliance";
import { prisma } from "@hotelos/database";
import type { Prisma } from "@hotelos/database";
import type { UserContext } from "../../lib/demo-store.js";
import { BadRequestError, NotFoundError } from "../../lib/http-error.js";
import { recordAuditEvent, recordDomainEvent } from "../audit/audit.service.js";
import { requirePermissions } from "../auth/auth.service.js";
import { getPropertyTaxProfile, resolveTaxRate } from "../accounting/tax-rate.service.js";
import { PAYMENT_METHOD_ACCOUNT_CODES, type PaymentMethodCode } from "../../../../../packages/shared/src/payments-types.js";
import { buildCashSaleJournalLines, buildInvoiceSnapshot, buildVatBookRows, customerRequiredFor } from "./invoice-snapshot.js";
import {
  allocateInvoiceNumber,
  breakdownJson,
  evaluateTaxReadiness,
  findPreviousChainLink,
  invoiceTaxWarnings,
  lineFromResolvedRate,
  loadInvoice,
  lockVerifactuChain,
  previousLinkFields,
  recipientNameRequired,
  simplifiedLimitExceededError,
  taxContextFromProfile,
  taxNotConfiguredError,
  totalsForInvoiceLines,
  type InvoiceLineData,
  type InvoiceRecord,
  type ResolvedInvoiceLine
} from "./invoice.service.js";
import { requireIssuerIdentity, resolveFiscalMode } from "./issuer-identity.service.js";
import { getLedgerPort } from "./ledger.port.js";
import { writeIssuedVatBookRows } from "./vat-book.js";

export type SimplifiedInvoiceLineInput = {
  description: string;
  quantity: number;
  /** Gross unit price (tax included). */
  unitPrice: number;
  /** Folio-style line type used by the tax resolver (default "pos"). */
  lineType?: string;
  /** Fiscal category override (food_beverage for restaurant sales…). */
  taxCategory?: string | null;
};

export type CreateSimplifiedInvoiceInput = {
  context: UserContext;
  propertyId: string;
  lines: SimplifiedInvoiceLineInput[];
  /** How the sale was settled: cash → 570, card_terminal → 5721. */
  paidWith: Extract<PaymentMethodCode, "cash" | "card_terminal">;
  customerTaxId?: string | null;
  customerName?: string | null;
  /** PosOrder.id (idempotency key and journal sourceId); the TPV lote links PosOrder.invoiceId / journalEntryId. */
  posOrderId?: string | null;
  /** Business date of the sale (default now). */
  soldAt?: Date;
  correlationId: string;
};

export type SimplifiedInvoiceResult = { invoice: InvoiceRecord; journalEntryId: string; idempotent: boolean };

/**
 * Issue a simplified invoice (F2, series SIM) for a sale settled in the act
 * and post D 570|5721 / H 705.x / H 477.tipo in the same transaction.
 */
export async function createSimplifiedInvoice(input: CreateSimplifiedInvoiceInput): Promise<SimplifiedInvoiceResult> {
  // Integration 2026-09-16: a cashier closing a ticket in the act holds
  // pos.order.pay (or folio.charge.post, the key of POST /pos/tickets/:id/close)
  // but not necessarily invoice.issue; any of the three lets the F2 be issued.
  const held = new Set(input.context.permissions ?? []);
  if (!held.has("pos.order.pay") && !held.has("folio.charge.post")) requirePermissions(input.context, ["invoice.issue"]);
  if (!input.lines || input.lines.length === 0) throw new BadRequestError("La venta no tiene líneas que facturar.");
  if (input.paidWith !== "cash" && input.paidWith !== "card_terminal") {
    throw new BadRequestError("paidWith debe ser cash (efectivo) o card_terminal (datáfono): una venta al contado no admite otros medios.");
  }
  const property = await prisma.property.findUnique({ where: { id: input.propertyId }, select: { id: true, organizationId: true, currency: true } });
  if (!property) throw new NotFoundError("Propiedad no encontrada.");

  if (input.posOrderId) {
    const existing = await prisma.invoice.findFirst({
      where: { propertyId: input.propertyId, deletedAt: null, invoiceType: "F2", snapshotJson: { path: ["posOrderId"], equals: input.posOrderId } },
      select: { id: true }
    });
    if (existing) {
      const entry = await prisma.journalEntry.findFirst({ where: { organizationId: property.organizationId, sourceType: "pos_ticket", sourceId: input.posOrderId }, select: { id: true } });
      return { invoice: await loadInvoice(existing.id), journalEntryId: entry?.id ?? "", idempotent: true };
    }
  }

  const resolvedLines: ResolvedInvoiceLine[] = [];
  const lineData: InvoiceLineData[] = [];
  for (const [index, line] of input.lines.entries()) {
    const description = line.description?.trim();
    if (!description) throw new BadRequestError(`La línea ${index + 1} no tiene descripción.`);
    if (!Number.isFinite(line.quantity) || line.quantity <= 0) throw new BadRequestError(`La línea ${index + 1} debe tener una cantidad positiva.`);
    if (!Number.isFinite(line.unitPrice) || line.unitPrice < 0) throw new BadRequestError(`La línea ${index + 1} no tiene un precio válido.`);
    const quantity = roundMoney(line.quantity);
    const unitPrice = roundMoney(line.unitPrice);
    const lineType = line.lineType?.trim() || "pos";
    const resolved = await resolveTaxRate({ propertyId: input.propertyId, lineType, postingDate: input.soldAt, taxCategory: line.taxCategory ?? null });
    const built = lineFromResolvedRate({ lineType, description, quantity, unitPrice, total: roundMoney(quantity * unitPrice), resolved });
    lineData.push(built.data);
    resolvedLines.push(built.resolvedLine);
  }
  const totals = totalsForInvoiceLines(lineData);
  if (totals.total <= 0) throw new BadRequestError("El total de la venta debe ser positivo.");

  const profile = taxContextFromProfile(await getPropertyTaxProfile(input.propertyId));
  const fiscalMode = resolveFiscalMode();
  const readiness = evaluateTaxReadiness(lineData, profile);
  if (!readiness.ok && fiscalMode === "production") throw taxNotConfiguredError(readiness);
  const warnings = Array.from(new Set([...invoiceTaxWarnings(resolvedLines, profile), ...(readiness.ok ? [] : readiness.blocking.map((p) => `Emitida en sandbox con impuestos sin configurar: ${p}`))]));

  const customerTaxId = normalizeTaxId(input.customerTaxId);
  const customerName = input.customerName?.trim() || null;
  const requirement = customerRequiredFor({ invoiceType: "F2", total: totals.total, lines: lineData });
  if (requirement.required && !customerTaxId) throw simplifiedLimitExceededError({ total: totals.total, limit: requirement.limit ?? 400 });
  if (customerTaxId && recipientNameRequired("F1", customerTaxId, customerName)) {
    throw new BadRequestError("Indica el nombre del cliente cuando la factura simplificada lleva su NIF.");
  }

  const issuer = await requireIssuerIdentity(input.propertyId);
  const soldAt = input.soldAt ?? new Date();
  const paidWithAccount = PAYMENT_METHOD_ACCOUNT_CODES[input.paidWith];

  const created = await prisma.$transaction(async (tx) => {
    await lockVerifactuChain(tx, input.propertyId);
    const issuedAt = new Date();
    const allocated = await allocateInvoiceNumber(tx, { propertyId: input.propertyId, series: "SIM", issuedAt });
    const invoiceNumber = allocated.invoiceNumber;
    const previous = await findPreviousChainLink(tx, input.propertyId);
    const { canonical, hash } = computeVerifactuHash({
      emitterTaxId: issuer.taxId,
      invoiceNumber,
      issuedAt: issuedAt.toISOString(),
      invoiceType: "F2" as VerifactuInvoiceType,
      vatTotal: totals.taxTotal,
      invoiceTotal: totals.total,
      previousHash: previous?.hash ?? null
    });
    const qrUrl = buildVerifactuQrUrl({ emitterTaxId: issuer.taxId, invoiceNumber, issuedAt: issuedAt.toISOString(), invoiceTotal: totals.total, preProduction: issuer.fiscalMode !== "production" });
    const snapshot = buildInvoiceSnapshot({
      issuedAt,
      currencyCode: property.currency ?? "EUR",
      lines: lineData.map((l) => ({ ...l, folioLineId: null })),
      totals,
      breakdown: totals.breakdown,
      folioLineIds: [],
      issuer: { taxId: issuer.taxId, legalName: issuer.legalName },
      customer: { type: "guest", taxId: customerTaxId, name: customerName }
    });
    const invoice = await tx.invoice.create({
      data: {
        propertyId: input.propertyId,
        invoiceNumber,
        invoiceType: "F2",
        customerType: "guest",
        customerTaxId,
        customerName,
        currencyCode: property.currency ?? "EUR",
        status: "issued",
        issuedAt,
        total: totals.total,
        taxTotal: totals.taxTotal,
        taxBreakdownJson: breakdownJson(totals.breakdown),
        warningsJson: warnings,
        verifactuHash: hash,
        previousInvoiceHash: previous?.hash ?? null,
        qrPayload: qrUrl,
        issuerTaxId: issuer.taxId,
        issuerLegalName: issuer.legalName,
        issuerTaxIdPlaceholder: issuer.placeholder,
        snapshotJson: { ...snapshot, posOrderId: input.posOrderId ?? null, paidWith: input.paidWith } as unknown as Prisma.InputJsonValue,
        seriesCode: "SIM",
        simplified: true,
        customerRequired: requirement.required
      }
    });
    for (const l of lineData) await tx.invoiceLine.create({ data: { invoiceId: invoice.id, ...l } });
    await writeIssuedVatBookRows(tx, {
      organizationId: property.organizationId,
      propertyId: input.propertyId,
      sourceType: "simplified",
      sourceId: invoice.id,
      date: issuedAt,
      series: "SIM",
      number: invoiceNumber,
      counterpartyNif: customerTaxId,
      counterpartyName: customerName,
      rows: buildVatBookRows(snapshot.taxBreakdown)
    });
    const posted = await getLedgerPort().postJournalEntry(
      {
        organizationId: property.organizationId,
        propertyId: input.propertyId,
        sourceType: "pos_ticket",
        sourceId: input.posOrderId ?? invoice.id,
        entryDate: soldAt,
        description: `Venta al contado ${invoiceNumber} (${input.paidWith === "cash" ? "efectivo" : "datáfono"})`,
        reference: invoiceNumber,
        createdBy: input.context.userId,
        currencyCode: property.currency ?? "EUR",
        lines: buildCashSaleJournalLines(snapshot, paidWithAccount, invoiceNumber)
      },
      tx
    );
    return { invoice, canonical, hash, previous, year: allocated.year, journalEntryId: posted.journalEntryId };
  });

  const after = await loadInvoice(created.invoice.id);
  recordAuditEvent({
    organizationId: property.organizationId,
    propertyId: input.propertyId,
    actorUserId: input.context.userId,
    actorType: "user",
    action: "INVOICE_ISSUED",
    entityType: "invoice",
    entityId: after.id,
    afterJson: {
      invoiceNumber: after.invoiceNumber,
      series: "SIM",
      simplified: true,
      sequenceYear: created.year,
      verifactuHash: created.hash,
      hashCanonical: created.canonical,
      ...previousLinkFields(created.previous),
      total: after.total,
      taxTotal: after.taxTotal,
      taxBreakdown: after.taxBreakdown,
      paidWith: input.paidWith,
      posOrderId: input.posOrderId ?? null,
      journalEntryId: created.journalEntryId,
      taxWarnings: warnings
    },
    correlationId: input.correlationId
  });
  recordDomainEvent({
    organizationId: property.organizationId,
    propertyId: input.propertyId,
    entityType: "invoice",
    entityId: after.id,
    eventType: "InvoiceIssued",
    payload: { invoiceNumber: after.invoiceNumber!, verifactuHash: after.verifactuHash!, total: after.total, taxTotal: after.taxTotal, simplified: true, posOrderId: input.posOrderId ?? null, ...previousLinkFields(created.previous) },
    actorType: "user",
    actorUserId: input.context.userId,
    correlationId: input.correlationId
  });
  return { invoice: after, journalEntryId: created.journalEntryId, idempotent: false };
}
