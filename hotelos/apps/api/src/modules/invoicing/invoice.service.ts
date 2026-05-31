import { assertInvoiceMutable, buildVerifactuQrUrl, computeVerifactuHash, type VerifactuInvoiceType } from "@hotelos/compliance";
import { prisma } from "@hotelos/database";
import type { Prisma } from "@hotelos/database";
import { demoStore, type UserContext } from "../../lib/demo-store.js";
import { recordAuditEvent, recordDomainEvent } from "../audit/audit.service.js";
import { requirePermissions } from "../auth/auth.service.js";
import { buildTaxCode, resolveTaxRate } from "../accounting/tax-rate.service.js";
import { getExchangeRate } from "../accounting/currency.service.js";

export type InvoiceLineDraft = {
  description: string;
  quantity: number;
  unitPrice: number;
  taxCode: string;
  taxRate: number;
  total: number;
};

export type InvoiceRecord = {
  id: string;
  propertyId: string;
  invoiceNumber?: string;
  invoiceType: "F1" | "F2" | "F3" | "R1" | "R2" | "R3" | "R4" | "R5";
  customerType: "guest" | "company" | "agency";
  customerTaxId?: string;
  status: "draft" | "issued" | "cancelled" | "rectified";
  issuedAt?: string;
  total: number;
  taxTotal: number;
  currencyCode: string;
  fxRate?: number;
  baseTotal?: number;
  verifactuHash?: string;
  previousInvoiceHash?: string;
  qrPayload?: string;
  createdAt: string;
  lines: InvoiceLineDraft[];
  // Issuer branding/legal block for rendering the invoice (logo + legal
  // disclaimer footer configured per property, plus the issuer fiscal data).
  issuer?: InvoiceIssuer;
};

export type InvoiceIssuer = {
  propertyName?: string;
  legalName?: string;
  taxId?: string;
  address?: string;
  logoUrl?: string;
  legalFooter?: string;
};

function dec(value: Prisma.Decimal | number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  return typeof value === "number" ? value : Number(value);
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

async function buildIssuer(propertyId: string): Promise<InvoiceIssuer | undefined> {
  const property = await prisma.property.findUnique({
    where: { id: propertyId },
    select: {
      name: true,
      legalName: true,
      address: true,
      municipality: true,
      province: true,
      organizationId: true,
      invoiceLogoUrl: true,
      invoiceLegalFooter: true
    }
  });
  if (!property) return undefined;
  const org = await prisma.organization.findUnique({
    where: { id: property.organizationId },
    select: { taxId: true, legalName: true, name: true }
  });
  const addressParts = [property.address, property.municipality, property.province].filter(Boolean);
  return {
    propertyName: property.name,
    legalName: property.legalName ?? org?.legalName ?? org?.name ?? property.name,
    taxId: org?.taxId ?? undefined,
    address: addressParts.length > 0 ? addressParts.join(", ") : undefined,
    logoUrl: property.invoiceLogoUrl ?? undefined,
    legalFooter: property.invoiceLegalFooter ?? undefined
  };
}

async function loadInvoice(invoiceId: string): Promise<InvoiceRecord> {
  const row = await prisma.invoice.findUnique({ where: { id: invoiceId } });
  if (!row) throw new Error("Invoice was not found.");
  const lineRows = await prisma.invoiceLine.findMany({ where: { invoiceId: row.id } });
  const issuer = await buildIssuer(row.propertyId);
  return {
    issuer,
    id: row.id,
    propertyId: row.propertyId,
    invoiceNumber: row.invoiceNumber ?? undefined,
    invoiceType: (row.invoiceType as InvoiceRecord["invoiceType"]) ?? "F1",
    customerType: row.customerType as InvoiceRecord["customerType"],
    customerTaxId: row.customerTaxId ?? undefined,
    status: row.status,
    issuedAt: row.issuedAt?.toISOString(),
    total: dec(row.total),
    taxTotal: dec(row.taxTotal),
    currencyCode: row.currencyCode ?? "EUR",
    fxRate: row.fxRate !== null && row.fxRate !== undefined ? dec(row.fxRate) : undefined,
    baseTotal: row.baseTotal !== null && row.baseTotal !== undefined ? dec(row.baseTotal) : undefined,
    verifactuHash: row.verifactuHash ?? undefined,
    previousInvoiceHash: row.previousInvoiceHash ?? undefined,
    qrPayload: row.qrPayload ?? undefined,
    createdAt: row.createdAt.toISOString(),
    lines: lineRows.map((l) => ({
      description: l.description,
      quantity: dec(l.quantity),
      unitPrice: dec(l.unitPrice),
      taxCode: l.taxCode,
      taxRate: dec(l.taxRate),
      total: dec(l.total)
    }))
  };
}

export async function listInvoices(propertyId: string): Promise<InvoiceRecord[]> {
  const rows = await prisma.invoice.findMany({ where: { propertyId }, orderBy: { createdAt: "desc" } });
  return Promise.all(rows.map((r) => loadInvoice(r.id)));
}

export async function getInvoice(invoiceId: string): Promise<InvoiceRecord> {
  return loadInvoice(invoiceId);
}

export async function getInvoiceBranding(propertyId: string): Promise<InvoiceIssuer> {
  return (await buildIssuer(propertyId)) ?? {};
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
  return (await buildIssuer(input.propertyId)) ?? {};
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
  if (!folio) throw new Error("Folio was not found.");
  const reservation = await prisma.reservation.findUnique({ where: { id: folio.reservationId } });
  if (!reservation) throw new Error("Reservation was not found.");
  const folioLines = await prisma.folioLine.findMany({ where: { folioId: folio.id } });
  if (folioLines.length === 0) throw new Error("Folio has no lines to invoice.");

  let total = 0;
  let taxTotal = 0;
  const invoiceLinesData = await Promise.all(folioLines.map(async (line) => {
    const resolved = await resolveTaxRate({
      propertyId: reservation.propertyId,
      lineType: line.type,
      postingDate: line.postedAt
    });
    const ratePercent = resolved.ratePercent;
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

  // Multi-currency (Sprint 24). Default to EUR; when the caller passes a
  // non-EUR currency we look up the FX rate at creation time and persist
  // both `fxRate` and `baseTotal` (the EUR equivalent of `total`). Snapshot-
  // ing the rate at creation means a later reprint reproduces the same
  // numbers even if the rate table moves.
  const currencyCode = (input.currencyCode ?? "EUR").toUpperCase();
  let fxRate: number | null = null;
  let baseTotal: number | null = null;
  if (currencyCode !== "EUR") {
    fxRate = await getExchangeRate({
      base: currencyCode,
      quote: "EUR",
      organizationId: input.context.organizationId
    });
    baseTotal = round(round(total) * fxRate);
  }

  const created = await prisma.$transaction(async (tx) => {
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
        baseTotal: baseTotal !== null ? baseTotal.toFixed(2) : null
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
    afterJson: { folioId: input.folioId, total: round(total), taxTotal: round(taxTotal) },
    correlationId: input.correlationId
  });

  return loadInvoice(created.id);
}

export async function issueInvoice(input: {
  context: UserContext;
  invoiceId: string;
  correlationId: string;
}): Promise<InvoiceRecord> {
  requirePermissions(input.context, ["invoice.issue"]);

  const existing = await prisma.invoice.findUnique({ where: { id: input.invoiceId } });
  if (!existing) throw new Error("Invoice was not found.");
  assertInvoiceMutable(existing.status);

  const property = await prisma.property.findUnique({ where: { id: existing.propertyId } });
  if (!property) throw new Error("Property was not found.");
  const emitterTaxId = property.legalName?.match(/[A-Z]?\d{8}[A-Z]?/i)?.[0] ?? demoStore.organization.taxId ?? "B00000000";

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
      preProduction: process.env.VERIFACTU_MODE !== "production"
    });

    const updated = await tx.invoice.update({
      where: { id: existing.id },
      data: {
        status: "issued",
        issuedAt,
        invoiceNumber,
        verifactuHash: hash,
        previousInvoiceHash: previous?.verifactuHash ?? null,
        qrPayload: qrUrl
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
      hashCanonical: issued.canonical
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
  if (!existing) throw new Error("Invoice was not found.");
  if (existing.status !== "issued") {
    throw new Error("Only issued invoices use the cancellation workflow.");
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
    throw new Error("rectifyingReasonCode must be one of R1, R2, R3, R4, R5.");
  }

  const original = await prisma.invoice.findUnique({ where: { id: input.originalInvoiceId } });
  if (!original) throw new Error("Original invoice was not found.");
  if (original.status !== "issued") {
    throw new Error("Only issued invoices can be rectified.");
  }

  // Idempotency: refuse a duplicate rectifying for the same (original, reason).
  const duplicate = await prisma.invoice.findFirst({
    where: { rectifyingForId: original.id, rectifyingReasonCode: input.reasonCode },
    select: { id: true }
  });
  if (duplicate) return loadInvoice(duplicate.id);

  const originalLines = await prisma.invoiceLine.findMany({ where: { invoiceId: original.id } });
  if (originalLines.length === 0) {
    throw new Error("Original invoice has no lines to rectify.");
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
      throw new Error("lineAdjustments produced no net change; nothing to rectify.");
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

  const property = await prisma.property.findUnique({ where: { id: original.propertyId } });
  if (!property) throw new Error("Property was not found.");
  const emitterTaxId =
    property.legalName?.match(/[A-Z]?\d{8}[A-Z]?/i)?.[0] ?? demoStore.organization.taxId ?? "B00000000";

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
      preProduction: process.env.VERIFACTU_MODE !== "production"
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
        qrPayload: qrUrl
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
      hashCanonical: created.canonical
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
    where: { rectifyingForId: originalInvoiceId },
    orderBy: { createdAt: "desc" }
  });
  return Promise.all(rows.map((r) => loadInvoice(r.id)));
}
