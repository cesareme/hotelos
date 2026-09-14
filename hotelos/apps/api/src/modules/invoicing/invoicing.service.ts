// Manual invoice drafts (Billing Center "Crear borrador"). Drafts created from
// a folio live in invoice.service.ts (createInvoiceFromFolio); this module
// covers drafts entered by hand with totals only, persisted with status
// "draft" so the regular issue/cancel/rectify flow applies afterwards.
//
// Tanda 3: rates are validated against the property's effective tax profile
// (catalogue-backed, contract C — IVA 10/21, IGIC 7/3, IPSI 1/2/4… plus N1
// for not-subject operations) instead of a hard-coded list per figure; lines
// may carry a `taxCategory` (accommodation, food_beverage…) from which the
// rate and calificación are derived; totals and the VeriFactu desglose come
// from computeInvoiceTotals (contract B) and are persisted with the draft.

import { buildTaxCode, statutoryRates, type Calificacion, type TaxCategory, type TaxFigure, type TaxRegion } from "@hotelos/compliance";
import { prisma } from "@hotelos/database";
import type { Prisma } from "@hotelos/database";
import { z } from "zod";
import type { UserContext } from "../../lib/demo-store.js";
import { BadRequestError, NotFoundError } from "../../lib/http-error.js";
import { TAX_CATEGORY_VALUES } from "../../schemas/folios.schemas.js";
import { recordAuditEvent } from "../audit/audit.service.js";
import { requirePermissions } from "../auth/auth.service.js";
import { getPropertyTaxProfile, type PropertyTaxProfileRateSource } from "../accounting/tax-rate.service.js";
import {
  getInvoice,
  invoiceTaxWarnings,
  recipientNameMissingError,
  recipientNameRequired,
  resolveInvoiceFxRate,
  taxContextFromProfile,
  totalsForInvoiceLines,
  type InvoiceRecord,
  type ResolvedInvoiceLine
} from "./invoice.service.js";

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
// Two rates are "the same" within this many points (2-decimal rate columns).
const RATE_EQUALITY_POINTS = 0.005;

// Single source of the category names at the HTTP boundary (folio lines and
// manual drafts share it): apps/api/src/schemas/folios.schemas.ts.
export const TAX_CATEGORIES = TAX_CATEGORY_VALUES;

// When a line only states a rate, the category is the first of these that
// carries that rate in the property's profile (a 10 % IVA line is
// accommodation unless the caller says otherwise).
const CATEGORY_PREFERENCE: readonly TaxCategory[] = ["accommodation", "food_beverage", "general_services", "transport", "tourist_tax", "not_subject"];

const DEFAULT_REGION: TaxRegion = "ES_PENINSULA_BALEARES";

const money = z.number().finite().nonnegative().max(MAX_AMOUNT);
const signedAmount = z.number().finite().min(-MAX_AMOUNT).max(MAX_AMOUNT);

export const CreateInvoiceDraftSchema = z.object({
  propertyId: z.string().min(1),
  // admin-web sends "full" | "simplified"; AEAT codes are accepted too.
  invoiceType: z.enum(["F1", "F2", "full", "simplified", "rectifying", "credit_note"]).optional(),
  customerType: z.enum(["guest", "company", "agency"]).optional(),
  customerTaxId: z.string().max(40).optional(),
  // Tanda 3 (cierre): recipient name / razón social (Destinatarios/NombreRazon).
  // Required by the service when customerTaxId is present on an F1 (400
  // RECIPIENT_NAME_REQUIRED otherwise); persisted as Invoice.customerName.
  customerName: z.string().max(500).optional(),
  total: money,
  taxTotal: money,
  currencyCode: z
    .string()
    .length(3)
    .regex(/^[A-Za-z]{3}$/, "must be a 3-letter ISO 4217 code")
    .optional(),
  // Fiscal category of the summary line when no explicit lines are sent
  // (default accommodation). "not_subject" makes it an N1 line (taxTotal 0).
  taxCategory: z.enum(TAX_CATEGORIES).optional(),
  lines: z
    .array(
      z
        .object({
          description: z.string().min(1).max(500),
          quantity: z.number().finite().positive().max(MAX_QUANTITY),
          unitPrice: signedAmount,
          // Optional: derived from the property's tax figure and the line's
          // rate ("ES_IVA_10") when omitted; validated against them when sent.
          taxCode: z.string().min(1).max(40).optional(),
          // Either the rate (validated against the property's rates) or the
          // fiscal category (rate + calificación derived) — at least one.
          taxRate: z.number().finite().min(0).max(100).optional(),
          taxCategory: z.enum(TAX_CATEGORIES).optional(),
          total: signedAmount
        })
        .refine((line) => line.taxRate !== undefined || line.taxCategory !== undefined, {
          message: "each line needs taxRate or taxCategory"
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

// "10 o 21 %" for the statutory rates of a tax figure.
function formatRateList(rates: readonly number[]): string {
  const list = rates.map(formatRate);
  if (list.length === 1) return `${list[0]} %`;
  return `${list.slice(0, -1).join(", ")} o ${list[list.length - 1]} %`;
}

function sameRate(a: number, b: number): boolean {
  return Math.abs(a - b) <= RATE_EQUALITY_POINTS;
}

/** One effective rate of the property: a manual override, a provisioned row ("db") or the catalogue. */
export type DraftTaxRate = {
  category: TaxCategory;
  ratePercent: number;
  calificacion: Calificacion;
  source: PropertyTaxProfileRateSource;
  verifyAgainstOrdinance: boolean;
};

/** What the draft validation needs to know about the property's taxes. */
export type DraftTaxProfile = {
  taxRegion: TaxRegion;
  figure: TaxFigure;
  rates: DraftTaxRate[];
};

/** Distinct S1 rates of the profile, descending (the closed list a rate-only line may use). */
export function subjectRates(profile: DraftTaxProfile): number[] {
  const rates = new Set<number>();
  for (const rate of profile.rates) if (rate.calificacion === "S1" && rate.ratePercent > 0) rates.add(rate.ratePercent);
  return Array.from(rates).sort((a, b) => b - a);
}

/** Effective rate for a category, or null when the profile has none for it. Pure. */
export function rateForCategory(profile: DraftTaxProfile, category: TaxCategory): DraftTaxRate | null {
  return profile.rates.find((rate) => rate.category === category) ?? null;
}

/** First category (by preference) that carries `ratePercent` as an S1 rate; null when none does. Pure. */
export function categoryForRate(profile: DraftTaxProfile, ratePercent: number): DraftTaxRate | null {
  for (const category of CATEGORY_PREFERENCE) {
    const rate = rateForCategory(profile, category);
    if (rate && rate.calificacion === "S1" && sameRate(rate.ratePercent, ratePercent)) return rate;
  }
  return null;
}

/** Build the draft profile from getPropertyTaxProfile (catalogue fallback when the property has no rows at all). */
async function loadDraftTaxProfile(propertyId: string): Promise<{ draft: DraftTaxProfile; context: ReturnType<typeof taxContextFromProfile> }> {
  const profile = await getPropertyTaxProfile(propertyId);
  const taxRegion = profile.taxRegion ?? DEFAULT_REGION;
  const rates: DraftTaxRate[] =
    profile.rates.length > 0
      ? profile.rates.map((rate) => ({
          category: rate.category,
          ratePercent: rate.ratePercent,
          calificacion: rate.calificacion,
          source: rate.source,
          verifyAgainstOrdinance: rate.verifyAgainstOrdinance
        }))
      : statutoryRates(taxRegion).map((rate) => ({
          category: rate.category,
          ratePercent: rate.percent,
          calificacion: rate.calificacion,
          source: "catalog" as const,
          verifyAgainstOrdinance: rate.verifyAgainstOrdinance
        }));
  return { draft: { taxRegion, figure: profile.figure, rates }, context: taxContextFromProfile(profile) };
}

// A client-supplied tax code is coherent with the line when it is the
// canonical buildTaxCode() value for the line's rate ("ES_IVA_10") or just the
// figure itself ("IVA"); either way the canonical form is what gets stored.
function taxCodeMatches(code: string, taxFigure: string, canonical: string): boolean {
  const upper = code.toUpperCase();
  return upper === canonical.toUpperCase() || upper === taxFigure.toUpperCase();
}

/** Persisted shape of a manual draft line. */
export type ManualDraftLine = {
  description: string;
  quantity: number;
  unitPrice: number;
  taxCode: string;
  taxRate: number;
  total: number;
  taxCategory: TaxCategory;
  taxCalificacion: Calificacion;
  taxFigure: TaxFigure;
};

function resolvedLineOf(line: ManualDraftLine, rate: DraftTaxRate, lineType: string): ResolvedInvoiceLine {
  return {
    lineType,
    description: line.description,
    taxCode: line.taxCode,
    ratePercent: line.taxRate,
    figure: line.taxFigure,
    calificacion: line.taxCalificacion,
    category: line.taxCategory,
    source: rate.source,
    verifyAgainstOrdinance: rate.verifyAgainstOrdinance
  };
}

/**
 * Rate + calificación + category of an explicit line: from `taxCategory`
 * (profile lookup; a stated taxRate must agree) or from `taxRate` (must be a
 * statutory S1 rate of the property, category inferred by preference; 0 %
 * is only valid for not_subject / N1). Pure.
 */
export function resolveManualLineTax(
  line: { taxRate?: number; taxCategory?: TaxCategory },
  position: string,
  profile: DraftTaxProfile
): { rate: DraftTaxRate; ratePercent: number; calificacion: Calificacion; category: TaxCategory } {
  const validRates = subjectRates(profile);
  if (line.taxCategory !== undefined) {
    const rate = rateForCategory(profile, line.taxCategory);
    if (!rate) {
      throw new BadRequestError(`La categoría fiscal «${line.taxCategory}» no tiene tipo configurado para esta propiedad (${position}).`);
    }
    const ratePercent = rate.calificacion === "N1" ? 0 : rate.ratePercent;
    if (line.taxRate !== undefined && !sameRate(round(line.taxRate), ratePercent)) {
      throw new BadRequestError(
        `El tipo ${formatRate(round(line.taxRate))} % de la ${position} no corresponde a la categoría «${line.taxCategory}» ` +
          `(${rate.calificacion === "N1" ? "operación no sujeta, sin tipo" : `${formatRate(ratePercent)} % de ${profile.figure}`}).`
      );
    }
    return { rate, ratePercent, calificacion: rate.calificacion, category: line.taxCategory };
  }
  const taxRate = round(line.taxRate ?? 0);
  if (taxRate === 0) {
    const notSubject = rateForCategory(profile, "not_subject");
    if (notSubject && notSubject.calificacion === "N1") {
      return { rate: notSubject, ratePercent: 0, calificacion: "N1", category: "not_subject" };
    }
  }
  const match = categoryForRate(profile, taxRate);
  if (!match) {
    throw new BadRequestError(
      `Tipo impositivo no válido para esta propiedad: ${formatRate(taxRate)} % ` +
        `(${position}; ${profile.figure} admite ${formatRateList(validRates)}, o taxCategory «not_subject» para operaciones no sujetas).`
    );
  }
  return { rate: match, ratePercent: match.ratePercent, calificacion: "S1", category: match.category };
}

// Explicit lines: rate / category validated against the property's profile,
// a tax code that matches (derived when omitted) and a total that follows
// from quantity × unitPrice. Returns the normalized line (2-decimal amounts,
// canonical tax code) plus its resolution for the warnings.
function normalizeExplicitLine(
  line: CreateInvoiceDraftLine,
  index: number,
  profile: DraftTaxProfile
): { data: ManualDraftLine; resolved: ResolvedInvoiceLine } {
  const quantity = round(line.quantity);
  const unitPrice = round(line.unitPrice);
  const total = round(line.total);
  const position = `línea ${index + 1}`;

  const tax = resolveManualLineTax(line, position, profile);
  const canonicalTaxCode = buildTaxCode(profile.figure, tax.ratePercent, tax.calificacion);
  const suppliedTaxCode = line.taxCode?.trim();
  if (suppliedTaxCode && !taxCodeMatches(suppliedTaxCode, profile.figure, canonicalTaxCode)) {
    throw new BadRequestError(
      `El código de impuesto «${suppliedTaxCode}» de la ${position} no corresponde al tipo ${formatRate(tax.ratePercent)} % ` +
        `de ${profile.figure} de esta propiedad (se esperaba ${canonicalTaxCode}).`
    );
  }

  const expectedTotal = round(quantity * unitPrice);
  if (Math.abs(expectedTotal - total) > LINE_ARITHMETIC_TOLERANCE) {
    throw new BadRequestError(
      `La ${position} no cuadra: ${formatEs(quantity)} × ${formatEs(unitPrice)} = ${formatEs(expectedTotal)}, ` +
        `pero el total indicado es ${formatEs(total)} (diferencia máxima admitida ${formatEs(LINE_ARITHMETIC_TOLERANCE)}).`
    );
  }

  const data: ManualDraftLine = {
    description: line.description,
    quantity,
    unitPrice,
    taxCode: canonicalTaxCode,
    taxRate: tax.ratePercent,
    total,
    taxCategory: tax.category,
    taxCalificacion: tax.calificacion,
    taxFigure: profile.figure
  };
  return { data, resolved: resolvedLineOf(data, tax.rate, `manual:${tax.category}`) };
}

// Snap the rate implied by (total, taxTotal) to a statutory rate. A rate is
// accepted when it lies within RATE_TOLERANCE_POINTS of the implied one OR
// when the tax it would produce on the gross total matches taxTotal to the
// cent — the latter keeps tiny invoices (where cent rounding distorts the
// implied percentage) valid. Returns null when no statutory rate fits.
export function snapToValidRate(impliedRate: number, total: number, taxTotal: number, validRates: readonly number[]): number | null {
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
// validated against the property's statutory rates, and the category is the
// requested one (default accommodation — hotel invoices) or, when that
// category's rate does not match the implied one, the first category that
// carries the snapped rate.
export function buildSummaryLine(
  profile: DraftTaxProfile,
  total: number,
  taxTotal: number,
  requestedCategory: TaxCategory = "accommodation"
): { data: ManualDraftLine; resolved: ResolvedInvoiceLine } {
  const net = round(total - taxTotal);
  if (taxTotal > 0 && net <= 0) {
    throw new BadRequestError("El importe de impuestos deja la base imponible en cero: revisa el total y los impuestos.");
  }
  const impliedRate = net > 0 ? (taxTotal / net) * 100 : 0;

  let rate: DraftTaxRate | null;
  let ratePercent: number;
  let calificacion: Calificacion;
  let category: TaxCategory;
  if (requestedCategory === "not_subject") {
    rate = rateForCategory(profile, "not_subject");
    if (!rate || rate.calificacion !== "N1") {
      throw new BadRequestError("Esta propiedad no tiene configurada la categoría «not_subject» (operaciones no sujetas).");
    }
    if (taxTotal !== 0) {
      throw new BadRequestError("Una operación no sujeta (N1) no lleva cuota: el importe de impuestos debe ser 0.");
    }
    ratePercent = 0;
    calificacion = "N1";
    category = "not_subject";
  } else {
    const validRates = subjectRates(profile);
    const snapped = snapToValidRate(impliedRate, total, taxTotal, validRates);
    if (snapped === null) {
      throw new BadRequestError(
        `El tipo impositivo implícito (${formatEs(impliedRate)} %) no es un tipo de ${profile.figure} válido ` +
          `(${formatRateList(validRates)}). ` +
          "Indica las líneas con su tipo o categoría, o ajusta el total y los impuestos."
      );
    }
    const requested = rateForCategory(profile, requestedCategory);
    rate = requested && requested.calificacion === "S1" && sameRate(requested.ratePercent, snapped) ? requested : categoryForRate(profile, snapped);
    if (!rate) {
      throw new BadRequestError(`Ningún concepto de esta propiedad tributa al ${formatRate(snapped)} % de ${profile.figure}.`);
    }
    ratePercent = snapped;
    calificacion = "S1";
    category = rate.category;
  }
  const data: ManualDraftLine = {
    description: "Servicios hoteleros",
    quantity: 1,
    unitPrice: total,
    taxCode: buildTaxCode(profile.figure, ratePercent, calificacion),
    taxRate: ratePercent,
    total,
    taxCategory: category,
    taxCalificacion: calificacion,
    taxFigure: profile.figure
  };
  return { data, resolved: resolvedLineOf(data, rate, `manual:${category}`) };
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

  // Destinatarios/NombreRazon: an F1 with the customer's NIF needs the name
  // (the NIF never stands in for it). Trimmed; empty means "not given".
  const customerName = input.customerName?.trim() || null;
  if (recipientNameRequired(invoiceType, input.customerTaxId, customerName)) throw recipientNameMissingError();

  const declaredTotal = round(input.total);
  const declaredTaxTotal = round(input.taxTotal);
  if (declaredTaxTotal > declaredTotal) {
    throw new BadRequestError("El importe de impuestos no puede superar el total de la factura.");
  }

  const { draft: profile, context: taxContext } = await loadDraftTaxProfile(property.id);
  const lines: ManualDraftLine[] = [];
  const resolvedLines: ResolvedInvoiceLine[] = [];
  if (input.lines) {
    for (const [index, line] of input.lines.entries()) {
      const normalized = normalizeExplicitLine(line, index, profile);
      lines.push(normalized.data);
      resolvedLines.push(normalized.resolved);
    }
  } else {
    const summary = buildSummaryLine(profile, declaredTotal, declaredTaxTotal, input.taxCategory);
    lines.push(summary.data);
    resolvedLines.push(summary.resolved);
  }

  // One grouping for header, desglose, PDF and UI (contract B). The declared
  // totals must agree with it: Σ lines = total to the cent, and the tax the
  // lines carry (per-group rounding) = taxTotal within TAX_TOLERANCE.
  // Otherwise the VeriFactu desglose and the invoice header would disagree
  // once issued. What is persisted is the computed pair.
  const totals = totalsForInvoiceLines(lines);
  if (Math.abs(totals.total - declaredTotal) > 0.005) {
    throw new BadRequestError(
      `La suma de las líneas (${formatEs(totals.total)}) no coincide con el total de la factura (${formatEs(declaredTotal)}).`
    );
  }
  if (Math.abs(totals.taxTotal - declaredTaxTotal) > TAX_TOLERANCE) {
    throw new BadRequestError(
      `El impuesto implícito en las líneas (${formatEs(totals.taxTotal)} €) no coincide con el importe de impuestos ` +
        `indicado (${formatEs(declaredTaxTotal)} €); la diferencia máxima admitida es de ${formatEs(TAX_TOLERANCE)} €.`
    );
  }
  const total = totals.total;
  const taxTotal = totals.taxTotal;
  const warnings = invoiceTaxWarnings(resolvedLines, taxContext);

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
        customerName,
        status: "draft",
        total,
        taxTotal,
        currencyCode,
        fxRate: fxRate !== null ? fxRate.toFixed(8) : null,
        baseTotal: baseTotal !== null ? baseTotal.toFixed(2) : null,
        taxBreakdownJson: totals.breakdown as unknown as Prisma.InputJsonValue,
        warningsJson: warnings
      }
    });
    await tx.invoiceLine.createMany({
      data: lines.map((line) => ({ invoiceId: invoice.id, ...line }))
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
    afterJson: {
      source: "manual",
      invoiceType,
      customerType: input.customerType ?? "guest",
      customerName,
      total,
      taxTotal,
      declaredTaxTotal,
      taxRegion: profile.taxRegion,
      figure: profile.figure,
      taxBreakdown: totals.breakdown,
      lineCount: lines.length,
      warnings
    },
    correlationId: input.correlationId
  });

  return getInvoice(created.id);
}
