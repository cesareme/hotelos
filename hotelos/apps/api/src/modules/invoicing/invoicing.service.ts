// Manual invoice drafts (Billing Center "Crear borrador"). Drafts created from
// a folio live in invoice.service.ts (createInvoiceFromFolio); this module
// covers drafts entered by hand with totals only, persisted with status
// "draft" so the regular issue/cancel/rectify flow applies afterwards.

import { prisma } from "@hotelos/database";
import { z } from "zod";
import type { UserContext } from "../../lib/demo-store.js";
import { BadRequestError, NotFoundError } from "../../lib/http-error.js";
import { recordAuditEvent } from "../audit/audit.service.js";
import { requirePermissions } from "../auth/auth.service.js";
import { buildTaxCode, resolveTaxRate, type ResolvedRate } from "../accounting/tax-rate.service.js";
import { getInvoice, resolveInvoiceFxRate, type InvoiceLineDraft, type InvoiceRecord } from "./invoice.service.js";

// Ceiling of the Decimal(12,2) columns (invoices.total, invoice_lines.*): the
// same bound Postgres enforces, surfaced as a 400 instead of a driver error.
const MAX_AMOUNT = 9_999_999_999.99;
const MAX_QUANTITY = 100_000;
const MAX_LINES = 500;
// Cent-rounding slack when comparing the tax implied by the lines with the
// declared taxTotal (one rounding step per side).
const TAX_TOLERANCE = 0.02;
// A summary-line rate may differ from a statutory rate by this many points
// (rounding of small amounts); beyond that the totals are inconsistent.
const RATE_TOLERANCE_POINTS = 0.5;
// Cent-rounding slack between quantity × unitPrice and the declared line total.
const LINE_ARITHMETIC_TOLERANCE = 0.02;

// Statutory rates per Spanish indirect-tax figure. IPSI (Ceuta/Melilla) has
// no closed list here — its rates vary by municipality and product — so for
// IPSI the implied rate is kept as entered (rounded to 2 decimals).
const VALID_RATES_BY_TAX: Record<string, readonly number[]> = {
  IVA: [0, 4, 10, 21],
  IGIC: [0, 3, 7, 9.5, 15, 20]
};

const money = z.number().finite().nonnegative().max(MAX_AMOUNT);
const signedAmount = z.number().finite().min(-MAX_AMOUNT).max(MAX_AMOUNT);

export const CreateInvoiceDraftSchema = z.object({
  propertyId: z.string().min(1),
  // admin-web sends "full" | "simplified"; AEAT codes are accepted too.
  invoiceType: z.enum(["F1", "F2", "full", "simplified", "rectifying", "credit_note"]).optional(),
  customerType: z.enum(["guest", "company", "agency"]).optional(),
  customerTaxId: z.string().max(40).optional(),
  total: money,
  taxTotal: money,
  currencyCode: z
    .string()
    .length(3)
    .regex(/^[A-Za-z]{3}$/, "must be a 3-letter ISO 4217 code")
    .optional(),
  lines: z
    .array(
      z.object({
        description: z.string().min(1).max(500),
        quantity: z.number().finite().positive().max(MAX_QUANTITY),
        unitPrice: signedAmount,
        // Optional: derived from the property's tax figure and the line's
        // rate ("ES_IVA_10") when omitted; validated against them when sent.
        taxCode: z.string().min(1).max(40).optional(),
        taxRate: z.number().finite().min(0).max(100),
        total: signedAmount
      })
    )
    .min(1)
    .max(MAX_LINES)
    .optional()
});

export type CreateInvoiceDraftBody = z.infer<typeof CreateInvoiceDraftSchema>;
type CreateInvoiceDraftLine = NonNullable<CreateInvoiceDraftBody["lines"]>[number];

const MANUAL_DRAFT_TYPES: Record<string, "F1" | "F2"> = { F1: "F1", F2: "F2", full: "F1", simplified: "F2" };

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

// Spanish number formatting for user-facing messages ("7,94").
function formatEs(n: number, decimals = 2): string {
  return n.toFixed(decimals).replace(".", ",");
}

// Rate as shown to the user: "21", "9,5", "12,75".
function formatRate(rate: number): string {
  return Number.isInteger(rate) ? String(rate) : formatEs(rate).replace(/0+$/, "");
}

// "0, 4, 10 o 21 %" for the statutory rates of a tax figure.
function formatRateList(rates: readonly number[]): string {
  const list = rates.map(formatRate);
  return `${list.slice(0, -1).join(", ")} o ${list[list.length - 1]} %`;
}

// Manual lines are gross, like folio lines and the VeriFactu desglose
// (aggregateBreakdownsByRate): the tax share of a line is
// total − total / (1 + rate / 100).
function lineTaxAmount(line: { total: number; taxRate: number }): number {
  return line.taxRate > 0 ? line.total - line.total / (1 + line.taxRate / 100) : 0;
}

// Tax figure for the summary line, following the folio-line convention
// (buildTaxCode(resolved.taxCode, rate) → "ES_IVA_10"). resolveTaxRate answers
// "UNKNOWN" when the property's region has no Tax row configured; for a
// Spanish property we derive the figure from the region instead so a manual
// draft never carries "ES_UNKNOWN_10" next to a folio draft's "ES_IVA_10".
// Assumption: country "ES" (the Property default) implies the Spanish
// indirect-tax family — Canarias → IGIC, Ceuta/Melilla → IPSI, everything
// else (mainland and the foral territories, which also apply IVA) → IVA.
function resolveSummaryTaxCode(resolved: ResolvedRate, country: string): string {
  if (resolved.taxCode !== "UNKNOWN") return resolved.taxCode;
  if (country.toUpperCase() !== "ES") return resolved.taxCode;
  if (resolved.taxRegion === "canary") return "IGIC";
  if (resolved.taxRegion === "ceuta" || resolved.taxRegion === "melilla") return "IPSI";
  return "IVA";
}

// Tax figure (IVA / IGIC / IPSI, or the configured Tax code) that governs the
// property's invoices; both the summary line and explicit lines validate
// their rates against it.
async function resolvePropertyTaxFigure(property: { id: string; country: string }): Promise<string> {
  const resolved = await resolveTaxRate({ propertyId: property.id, lineType: "room" });
  return resolveSummaryTaxCode(resolved, property.country);
}

// A client-supplied tax code is coherent with the line when it is the
// canonical buildTaxCode() value for the line's rate ("ES_IVA_10") or just the
// figure itself ("IVA"); either way the canonical form is what gets stored.
function taxCodeMatches(code: string, taxFigure: string, canonical: string): boolean {
  const upper = code.toUpperCase();
  return upper === canonical.toUpperCase() || upper === taxFigure.toUpperCase();
}

// Explicit lines: each one must carry a statutory rate of the property's tax
// figure (IPSI has no closed list, so its rates are kept as entered), a tax
// code that matches that rate (derived when omitted) and a total that follows
// from quantity × unitPrice. Returns the normalized line (2-decimal amounts,
// canonical tax code).
function normalizeExplicitLine(line: CreateInvoiceDraftLine, index: number, taxFigure: string): InvoiceLineDraft {
  const quantity = round(line.quantity);
  const unitPrice = round(line.unitPrice);
  const taxRate = round(line.taxRate);
  const total = round(line.total);
  const position = `línea ${index + 1}`;

  const validRates = VALID_RATES_BY_TAX[taxFigure];
  if (validRates && !validRates.includes(taxRate)) {
    throw new BadRequestError(
      `Tipo impositivo no válido para esta propiedad: ${formatRate(taxRate)} % ` +
        `(${position}; ${taxFigure} admite ${formatRateList(validRates)}).`
    );
  }

  const canonicalTaxCode = buildTaxCode(taxFigure, taxRate);
  const suppliedTaxCode = line.taxCode?.trim();
  if (suppliedTaxCode && !taxCodeMatches(suppliedTaxCode, taxFigure, canonicalTaxCode)) {
    throw new BadRequestError(
      `El código de impuesto «${suppliedTaxCode}» de la ${position} no corresponde al tipo ${formatRate(taxRate)} % ` +
        `de ${taxFigure} de esta propiedad (se esperaba ${canonicalTaxCode}).`
    );
  }

  const expectedTotal = round(quantity * unitPrice);
  if (Math.abs(expectedTotal - total) > LINE_ARITHMETIC_TOLERANCE) {
    throw new BadRequestError(
      `La ${position} no cuadra: ${formatEs(quantity)} × ${formatEs(unitPrice)} = ${formatEs(expectedTotal)}, ` +
        `pero el total indicado es ${formatEs(total)} (diferencia máxima admitida ${formatEs(LINE_ARITHMETIC_TOLERANCE)}).`
    );
  }

  return { description: line.description, quantity, unitPrice, taxCode: canonicalTaxCode, taxRate, total };
}

// Snap the rate implied by (total, taxTotal) to a statutory rate. A rate is
// accepted when it lies within RATE_TOLERANCE_POINTS of the implied one OR
// when the tax it would produce on the gross total matches taxTotal to the
// cent — the latter keeps tiny invoices (where cent rounding distorts the
// implied percentage) valid. Returns null when no statutory rate fits.
function snapToValidRate(impliedRate: number, total: number, taxTotal: number, validRates: readonly number[]): number | null {
  let best: number | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const rate of validRates) {
    const distance = Math.abs(rate - impliedRate);
    const expectedTax = round(total - total / (1 + rate / 100));
    const fits = distance <= RATE_TOLERANCE_POINTS || Math.abs(expectedTax - taxTotal) <= TAX_TOLERANCE;
    if (fits && distance < bestDistance) {
      best = rate;
      bestDistance = distance;
    }
  }
  return best;
}

// Without explicit lines the draft carries one summary line so the VeriFactu
// desglose is not empty when it is issued. Amounts are gross (same convention
// as folio-derived lines); the rate is the one implied by the entered totals,
// validated against the statutory rates of the property's tax figure.
function buildSummaryLine(taxCode: string, total: number, taxTotal: number): InvoiceLineDraft {
  const net = round(total - taxTotal);
  if (taxTotal > 0 && net <= 0) {
    throw new BadRequestError(
      "El importe de impuestos deja la base imponible en cero: revisa el total y los impuestos."
    );
  }
  const impliedRate = net > 0 ? (taxTotal / net) * 100 : 0;
  const validRates = VALID_RATES_BY_TAX[taxCode];
  const ratePercent = validRates ? snapToValidRate(impliedRate, total, taxTotal, validRates) : round(impliedRate);
  if (ratePercent === null) {
    throw new BadRequestError(
      `El tipo impositivo implícito (${formatEs(impliedRate)} %) no es un tipo de ${taxCode} válido ` +
        `(${formatRateList(validRates!)}). ` +
        "Indica las líneas con su tipo o ajusta el total y los impuestos."
    );
  }
  return {
    description: "Servicios hoteleros",
    quantity: 1,
    unitPrice: total,
    taxCode: buildTaxCode(taxCode, ratePercent),
    taxRate: ratePercent,
    total
  };
}

export async function createInvoiceDraft(
  input: CreateInvoiceDraftBody & { context: UserContext; correlationId: string }
): Promise<InvoiceRecord> {
  requirePermissions(input.context, ["invoice.issue"]);

  const property = await prisma.property.findUnique({
    where: { id: input.propertyId },
    select: { id: true, organizationId: true, country: true }
  });
  // 404 (not 403) on a foreign property so other tenants' ids are not confirmed.
  if (!property || property.organizationId !== input.context.organizationId) {
    throw new NotFoundError("Propiedad no encontrada.");
  }

  const invoiceType = MANUAL_DRAFT_TYPES[input.invoiceType ?? "F1"];
  if (!invoiceType) {
    throw new BadRequestError(
      "Las facturas rectificativas y los abonos se crean desde la factura original (POST /invoices/:id/rectify)."
    );
  }

  const total = round(input.total);
  const taxTotal = round(input.taxTotal);
  if (taxTotal > total) {
    throw new BadRequestError("El importe de impuestos no puede superar el total de la factura.");
  }

  const taxFigure = await resolvePropertyTaxFigure(property);
  let lines: InvoiceLineDraft[];
  if (input.lines) {
    lines = input.lines.map((line, index) => normalizeExplicitLine(line, index, taxFigure));
    const linesTotal = round(lines.reduce((sum, line) => sum + line.total, 0));
    if (Math.abs(linesTotal - total) > 0.005) {
      throw new BadRequestError(
        `La suma de las líneas (${formatEs(linesTotal)}) no coincide con el total de la factura (${formatEs(total)}).`
      );
    }
    // The tax carried by the lines (Σ line total − base) must match the
    // declared taxTotal; otherwise the VeriFactu desglose and the invoice
    // header would disagree once issued.
    const impliedTax = round(lines.reduce((sum, line) => sum + lineTaxAmount(line), 0));
    if (Math.abs(impliedTax - taxTotal) > TAX_TOLERANCE) {
      throw new BadRequestError(
        `El impuesto implícito en las líneas (${formatEs(impliedTax)} €) no coincide con el importe de impuestos ` +
          `indicado (${formatEs(taxTotal)} €); la diferencia máxima admitida es de ${formatEs(TAX_TOLERANCE)} €.`
      );
    }
  } else {
    lines = [buildSummaryLine(taxFigure, total, taxTotal)];
  }

  const currencyCode = (input.currencyCode ?? "EUR").toUpperCase();
  let fxRate: number | null = null;
  let baseTotal: number | null = null;
  if (currencyCode !== "EUR") {
    fxRate = await resolveInvoiceFxRate(currencyCode, input.context.organizationId);
    baseTotal = round(total * fxRate);
  }

  const created = await prisma.$transaction(async (tx) => {
    const invoice = await tx.invoice.create({
      data: {
        propertyId: property.id,
        invoiceType,
        customerType: input.customerType ?? "guest",
        customerTaxId: input.customerTaxId ?? null,
        status: "draft",
        total,
        taxTotal,
        currencyCode,
        fxRate: fxRate !== null ? fxRate.toFixed(8) : null,
        baseTotal: baseTotal !== null ? baseTotal.toFixed(2) : null
      }
    });
    await tx.invoiceLine.createMany({
      data: lines.map((line) => ({
        invoiceId: invoice.id,
        description: line.description,
        quantity: line.quantity,
        unitPrice: line.unitPrice,
        taxCode: line.taxCode,
        taxRate: line.taxRate,
        total: line.total
      }))
    });
    return invoice;
  });

  recordAuditEvent({
    organizationId: input.context.organizationId,
    propertyId: property.id,
    actorUserId: input.context.userId,
    actorType: "user",
    action: "INVOICE_DRAFT_CREATED",
    entityType: "invoice",
    entityId: created.id,
    afterJson: { source: "manual", invoiceType, total, taxTotal, lineCount: lines.length },
    correlationId: input.correlationId
  });

  return getInvoice(created.id);
}
