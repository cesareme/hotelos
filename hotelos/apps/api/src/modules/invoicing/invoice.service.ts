import {
  assertInvoiceMutable,
  buildVerifactuQrUrl,
  computeInvoiceTotals,
  computeVerifactuHash,
  normalizeTaxId,
  parseTaxBreakdown,
  parseTaxCode,
  roundMoney,
  type Calificacion,
  type InvoiceTotals,
  type InvoiceTotalsLine,
  type TaxBreakdownGroup,
  type TaxFigure,
  type TaxRegion,
  type VerifactuImpuesto,
  type VerifactuInvoiceType
} from "@hotelos/compliance";
import { prisma } from "@hotelos/database";
import type { Prisma } from "@hotelos/database";
import { Prisma as PrismaRuntime } from "@prisma/client";
import type { ApprovalRequestDto } from "@hotelos/shared";
import type { UserContext } from "../../lib/demo-store.js";
import { BadRequestError, ConflictError, NotFoundError } from "../../lib/http-error.js";
import { buildPage, DEFAULT_PAGE_LIMIT, decodeCursor, MAX_PAGE_LIMIT, type Page } from "../../lib/pagination.js";
import { recordAuditEvent, recordDomainEvent } from "../audit/audit.service.js";
import { requirePermissions } from "../auth/auth.service.js";
import { assertApprovedOrAuthorized, requestApproval, type AuthorizationOutcome } from "../rbac/approvals.service.js";
import { defaultRbacDeps, type RbacDeps } from "../rbac/assignments.service.js";
import { assertSeparationOfDuties, sodAuditFields, type SodCheckOutcome } from "../treasury/permissions.js";
import { getPropertyTaxProfile, resolveTaxRate, type PropertyTaxProfileRateSource, type ResolvedRate } from "../accounting/tax-rate.service.js";
import { getExchangeRate } from "../accounting/currency.service.js";
import {
  ISSUER_TAX_ID_PLACEHOLDER,
  LEGAL_IDENTITY_SCREEN,
  SERIES_SCREEN,
  WORK_CENTERS_SCREEN,
  adoptOrphanChainRecords,
  chainInvoiceWhere,
  lockVerifactuChainScope,
  previewIssuerTaxId,
  requireIssuerIdentity,
  resolveFiscalMode,
  resolveIssuerIdentity,
  resolveVerifactuChainScope,
  taxIdFromQrPayload,
  verifactuExclusionWarning,
  type IssuerEstablishment,
  type IssuerIdentity,
  type VerifactuChainScope,
  type VerifactuExclusion
} from "./issuer-identity.service.js";
import { defaultSeriesPrefix, findPrefixClash, normalizeSeriesPrefix, seriesPrefixClashError, type SeriesPrefixRow } from "./series-prefix.service.js";
import { prepareVerifactuAnulacion, queueVerifactuAnulacion } from "./verifactu-submission.service.js";
import type { InvoiceCancellationPayments, InvoiceDraftSnapshot, InvoiceSnapshotV1 } from "../../../../../packages/shared/src/payments-types.js";
import { PAYMENT_ERROR_CODES } from "../../../../../packages/shared/src/payments-types.js";
import { getLedgerPort } from "./ledger.port.js";
import {
  buildInvoiceJournalLines,
  buildInvoiceSnapshot,
  buildVatBookRows,
  customerRequiredFor,
  FISCAL_REFLECTION_LINE_TYPES,
  folioLinesFingerprint,
  parseInvoiceSnapshot,
  type SnapshotLineInput
} from "./invoice-snapshot.js";
import { writeIssuedVatBookRows } from "./vat-book.js";
import { invoiceSourceType } from "../accounting/vat-books.service.js";

export type InvoiceLineDraft = {
  description: string;
  quantity: number;
  unitPrice: number;
  taxCode: string;
  taxRate: number;
  total: number;
  // Tanda 3: fiscal category, VeriFactu calificación (S1/N1) and figure
  // (IVA/IGIC/IPSI) resolved when the line was created. Null on lines created
  // before Tanda 3 — lineTaxIdentity() derives them from taxCode then.
  taxCategory?: string | null;
  taxCalificacion?: string | null;
  taxFigure?: string | null;
};

/** TipoRectificativa (AEAT): "I" por diferencias (default), "S" sustitución (full replacement invoice). */
export type RectificationType = "I" | "S";

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
  // Tanda 3 (cierre): recipient name / legal name snapshot (Invoice.customerName)
  // — VeriFactu Destinatarios/NombreRazon for F1 invoices with a NIF. Null on
  // invoices created before the column or without an identified recipient.
  customerName: string | null;
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
  // Tanda 3: TipoRectificativa of a rectificativa ("I" por diferencias by
  // default, "S" only when the caller supplied the full substitute invoice);
  // null on non-rectifying invoices.
  rectificationType: RectificationType | null;
  // Tanda 3: huella of the RegistroAnulacion (set by cancelInvoice under the
  // chain lock); null while the invoice is live.
  cancellationHash: string | null;
  // Tanda 3: tax problems detected while building / issuing the invoice
  // (persisted in Invoice.warningsJson): lines without a configured rate,
  // catalogue fallback because the property has no fiscal region, IPSI rates
  // not confirmed against the ordinance, tourist-tax treatment, sandbox
  // issuance despite blocking problems. Empty when everything is fine.
  warnings: string[];
  // Tanda 3: VeriFactu desglose persisted in Invoice.taxBreakdownJson — the
  // single source for XML / PDF / UI. Empty on invoices created before Tanda 3.
  taxBreakdown: TaxBreakdownGroup[];
  // Finanzas (2026-09-15): series the number was allocated in (FAC / SIM /
  // REC), simplified-invoice flag (art. 4 RD 1619/2012) and whether the
  // recipient had to be identified. Null / defaults on legacy rows.
  seriesCode: string | null;
  simplified: boolean;
  customerRequired: boolean;
};

export type InvoiceRecord = InvoiceListItem & {
  lines: InvoiceLineDraft[];
  // Issuer branding/legal block for rendering the invoice (logo + legal
  // disclaimer footer configured per property, plus the issuer fiscal data).
  issuer?: InvoiceIssuer;
  // Finanzas (2026-09-15): the frozen document (Invoice.snapshotJson) of an
  // issued invoice; null on drafts and on invoices issued before the column.
  snapshot: InvoiceSnapshotV1 | null;
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
  /** Address line of the ESTABLISHMENT (kept for older clients; same as establishment.addressLine). */
  address?: string;
  logoUrl?: string;
  legalFooter?: string;
  // Tanda 6b (L3, design §5.2 R2): the issuer is the sociedad; the property is
  // the establishment block. Additive so older clients keep working.
  /** LegalEntity that issues (null for a tenant whose implicit sociedad is not backfilled yet). */
  legalEntityId?: string | null;
  /** Domicilio fiscal of the sociedad on one line. */
  fiscalAddress?: string;
  /** Establishment (centro de trabajo) that issued / will issue the document. */
  establishment?: IssuerEstablishment;
  /**
   * Why the document carries (or, for a draft, will carry) no VeriFactu record —
   * the sociedad is in the SII (R7/R8, fix t6b#2); null when VeriFactu applies.
   * Issued documents answer with the exclusion frozen in their snapshot.
   */
  verifactuExclusion?: VerifactuExclusion | null;
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

/** Invoice.warningsJson → string[] (never throws: a malformed value renders as no warnings). */
export function parseInvoiceWarnings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((w): w is string => typeof w === "string" && w.length > 0);
}

function uniqueStrings(values: Iterable<string>): string[] {
  return Array.from(new Set(values));
}

// ── Line tax identity (figure / impuesto / calificación) ─────────────────────

const IMPUESTO_BY_FIGURE: Record<TaxFigure, VerifactuImpuesto> = { IVA: "01", IPSI: "02", IGIC: "03" };

/** Persisted or resolved tax fields of a line, as computeInvoiceTotals and the readiness policy need them. */
export type InvoiceLineTaxFields = {
  taxCode: string;
  taxRate: number;
  taxCategory?: string | null;
  taxCalificacion?: string | null;
  taxFigure?: string | null;
};

export type LineTaxIdentity = {
  figure: TaxFigure;
  impuesto: VerifactuImpuesto;
  calificacion: Calificacion;
  category: string | null;
  /** True when the tax code is ES_UNKNOWN_* (no configured tax when the line was created). */
  unknown: boolean;
};

function isFigure(value: unknown): value is TaxFigure {
  return value === "IVA" || value === "IGIC" || value === "IPSI";
}

function isCalificacion(value: unknown): value is Calificacion {
  return value === "S1" || value === "N1";
}

/**
 * Figure / impuesto / calificación of a line: the Tanda 3 columns when
 * present, else parsed from the (legacy) tax code — "ES_IVA_10", "ES_IGIC_7",
 * "ES_IVA_N1", "ES_UNKNOWN_0". An unknown figure falls back to IVA so the
 * totals stay computable (rate 0 → quota 0 anyway); `unknown` is what the
 * readiness policy blocks on. Pure.
 */
export function lineTaxIdentity(line: InvoiceLineTaxFields): LineTaxIdentity {
  const parsed = parseTaxCode(line.taxCode);
  const unknown = parsed.figure === "UNKNOWN" && !isFigure(line.taxFigure);
  const figure: TaxFigure = isFigure(line.taxFigure) ? line.taxFigure : parsed.figure === "UNKNOWN" ? "IVA" : parsed.figure;
  const calificacion: Calificacion = isCalificacion(line.taxCalificacion) ? line.taxCalificacion : parsed.calificacion;
  return { figure, impuesto: IMPUESTO_BY_FIGURE[figure], calificacion, category: line.taxCategory ?? null, unknown };
}

/** computeInvoiceTotals over persisted / draft lines (gross totals). */
export function totalsForInvoiceLines(lines: Array<InvoiceLineTaxFields & { total: number }>): InvoiceTotals {
  return computeInvoiceTotals(
    lines.map((line): InvoiceTotalsLine => {
      const identity = lineTaxIdentity(line);
      return { total: line.total, ratePercent: line.taxRate, figure: identity.figure, impuesto: identity.impuesto, calificacion: identity.calificacion };
    })
  );
}

/** Prisma Json input for Invoice.taxBreakdownJson. */
export function breakdownJson(breakdown: TaxBreakdownGroup[]): Prisma.InputJsonValue {
  return breakdown as unknown as Prisma.InputJsonValue;
}

// ── Fiscal calendar (Europe/Madrid) ──────────────────────────────────────────

const MADRID_TZ = "Europe/Madrid";

/** Calendar year of `date` in Europe/Madrid (the series year: FISC-09). */
export function fiscalYearInMadrid(date: Date): number {
  const year = new Intl.DateTimeFormat("en-US", { timeZone: MADRID_TZ, year: "numeric" }).format(date);
  return Number(year);
}

// ── Invoice numbering (FISC-09: one series per year · R3: unique per sociedad) ──

export type InvoiceSeries = "FAC" | "SIM" | "REC";

/** Series of an invoice type: F1 → FAC, F2 → SIM, R1..R5 → REC (F3 falls in FAC). */
export function seriesForInvoiceType(invoiceType: string): InvoiceSeries {
  if (invoiceType === "F2") return "SIM";
  if (invoiceType.startsWith("R")) return "REC";
  return "FAC";
}

const SERIES_INVOICE_TYPE: Record<InvoiceSeries, string> = { FAC: "F1", SIM: "F2", REC: "R1" };
const SERIES_PADDING = 6;

/** 409 when the allocated number is already used by a sister centre of the same sociedad (stand-in for the deferred unique index). */
export const INVOICE_NUMBER_DUPLICATE_CODE = "INVOICE_NUMBER_DUPLICATE" as const;

/** The slice of a transaction client allocateInvoiceNumber needs (tests pass a mock); `$executeRaw` takes the series-opening advisory lock. */
export type InvoiceSequenceTx = Pick<Prisma.TransactionClient, "invoiceSequence" | "property" | "$executeRaw">;

/**
 * Series context of a billing centre inside its sociedad (design §5.2 R3):
 * who the sister centres are (same LegalEntity; same organization while the
 * tenant is not backfilled) and how many centres issue invoices, which decides
 * the default prefix (`FAC-2026-` with one, `FAC-RA-2026-` with several).
 */
export type SeriesScope = {
  propertyId: string;
  organizationId: string;
  legalEntityId: string | null;
  /** Property.code (RA, LT…); null until the centre is coded. */
  propertyCode: string | null;
  /** Sister centres of the same sociedad. */
  siblingPropertyIds: string[];
  /** Centres that issue invoices, this one included: hotels and `other`; an office only when it has an active series. */
  billingCentres: number;
};

type SeriesScopeRow = { id: string; kind: string };

/** Pure: billing centres = this centre + sister hotels/others + sister offices with an active series. */
export function countBillingCentres(siblings: readonly SeriesScopeRow[], officesWithActiveSeries: ReadonlySet<string>): number {
  let count = 1;
  for (const sibling of siblings) {
    if (sibling.kind !== "office" || officesWithActiveSeries.has(sibling.id)) count += 1;
  }
  return count;
}

/** Resolve the series scope of a property inside the transaction (one or two small queries). */
export async function resolveSeriesScope(tx: InvoiceSequenceTx, propertyId: string): Promise<SeriesScope> {
  const property = await tx.property.findUnique({
    where: { id: propertyId },
    select: { id: true, organizationId: true, legalEntityId: true, code: true, kind: true }
  });
  if (!property) throw new NotFoundError("Propiedad no encontrada.");
  const siblings = await tx.property.findMany({
    where: property.legalEntityId
      ? { legalEntityId: property.legalEntityId, id: { not: property.id } }
      : { organizationId: property.organizationId, id: { not: property.id } },
    select: { id: true, kind: true }
  });
  const offices = siblings.filter((row) => row.kind === "office").map((row) => row.id);
  const officesWithSeries = new Set<string>();
  if (offices.length > 0) {
    const active = await tx.invoiceSequence.findMany({ where: { propertyId: { in: offices }, active: true }, select: { propertyId: true } });
    for (const row of active) officesWithSeries.add(row.propertyId);
  }
  return {
    propertyId: property.id,
    organizationId: property.organizationId,
    legalEntityId: property.legalEntityId,
    propertyCode: property.code?.trim() ? property.code.trim().toUpperCase() : null,
    siblingPropertyIds: siblings.map((row) => row.id),
    billingCentres: countBillingCentres(siblings, officesWithSeries)
  };
}

/** Active series of the sister centres (the rows the clash guard compares against). */
async function loadSiblingSeries(tx: InvoiceSequenceTx, scope: SeriesScope): Promise<SeriesPrefixRow[]> {
  if (scope.siblingPropertyIds.length === 0) return [];
  return tx.invoiceSequence.findMany({
    where: { propertyId: { in: scope.siblingPropertyIds }, active: true },
    select: { id: true, propertyId: true, prefix: true, year: true, active: true }
  });
}

/** Warning (never a 409) for a series that ALREADY exists in two centres: the fix is to close one, never to renumber. Pure. */
export function legacySeriesClashWarning(prefix: string, year: number, clash: Pick<SeriesPrefixRow, "propertyId">): string {
  return `La serie ${prefix} (${year}) también está activa en otro centro de la misma sociedad (${clash.propertyId}): bajo un mismo NIF la numeración debe ser única. Cierra una de las dos series en Configuración › Estructura societaria › Series y VeriFactu; nunca se renumera una serie emitida.`;
}

// ── Series-opening lock and typed refusals (fix t6b#1) ───────────────────────

/** 409 when a series would be opened for an uncoded centre of a multi-centre sociedad (R3: the prefix needs the centre code). */
export const WORK_CENTER_CODE_REQUIRED_CODE = "WORK_CENTER_CODE_REQUIRED" as const;
/** 409 when the series of the year is closed (`active = false`): a closed series never numbers again (R3: never renumbered). */
export const SERIES_CLOSED_CODE = "SERIES_CLOSED" as const;

const SERIES_LOCK_PREFIX = "series-open:";
const INVOICE_NUMBER_LOCK_PREFIX = "invoice-number:";

/** Key of the sociedad a series scope belongs to (the organization while the tenant has no backfilled legal entity). Pure. */
export function seriesScopeKey(scope: Pick<SeriesScope, "legalEntityId" | "organizationId">): string {
  return scope.legalEntityId ? `entity:${scope.legalEntityId}` : `org:${scope.organizationId}`;
}

/** Advisory-lock key serialising the opening of series rows of one sociedad in one year. Pure. */
export function seriesOpeningLockKey(scope: Pick<SeriesScope, "legalEntityId" | "organizationId">, year: number): string {
  return `${SERIES_LOCK_PREFIX}${seriesScopeKey(scope)}:${year}`;
}

/** Advisory-lock key serialising the issuance of one invoice number under one sociedad (case-insensitive). Pure. */
export function invoiceNumberLockKey(scope: Pick<SeriesScope, "legalEntityId" | "organizationId">, invoiceNumber: string): string {
  return `${INVOICE_NUMBER_LOCK_PREFIX}${seriesScopeKey(scope)}:${invoiceNumber.trim().toUpperCase()}`;
}

/**
 * Serialise the OPENING of a series row across the centres of a sociedad
 * (pg_advisory_xact_lock, released with the transaction). The chain lock is
 * per installation / centre, so without this two hotels of one NIF could pass
 * `findPrefixClash` at the same time and both open the same prefix (t6b#1).
 * Taken after the chain lock and before the sister lookup: the loser waits
 * for the winner's commit and then sees its row. Exported for
 * patchBillingSettings (L2), which opens series outside the chain lock.
 */
export async function lockSeriesOpening(tx: Pick<Prisma.TransactionClient, "$executeRaw">, scope: Pick<SeriesScope, "legalEntityId" | "organizationId">, year: number): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${seriesOpeningLockKey(scope, year)}))`;
}

/** Pure: 409 WORK_CENTER_CODE_REQUIRED for an uncoded centre of a sociedad with several billing centres. */
export function workCenterCodeRequiredError(input: { propertyId: string; series: InvoiceSeries; year: number; billingCentres: number }): ConflictError {
  return new ConflictError(
    `No se puede abrir la serie ${input.series} de ${input.year}: la sociedad tiene ${input.billingCentres} centros que facturan y este centro no tiene código. Bajo un mismo NIF cada serie lleva el código del centro (${input.series}-<código>-${input.year}-) para que la numeración sea única (RD 1619/2012 art. 6.1.a). Asigna el código del centro en ${WORK_CENTERS_SCREEN} o define el prefijo de la serie en ${SERIES_SCREEN}.`,
    { code: WORK_CENTER_CODE_REQUIRED_CODE, propertyId: input.propertyId, series: input.series, year: input.year, billingCentres: input.billingCentres, screen: WORK_CENTERS_SCREEN }
  );
}

/** Pure: 409 SERIES_CLOSED when the series of the year exists but is closed. */
export function seriesClosedError(input: { propertyId: string; series: InvoiceSeries; year: number; prefix: string; sequenceId: string }): ConflictError {
  return new ConflictError(
    `La serie ${input.prefix} del ejercicio ${input.year} está cerrada: una serie cerrada no vuelve a numerar (nunca se renumera una serie emitida). Reábrela en ${SERIES_SCREEN} si el emisor no ha cambiado; si la sociedad cambió de NIF, la serie del nuevo emisor debe llevar otro prefijo.`,
    { code: SERIES_CLOSED_CODE, propertyId: input.propertyId, series: input.series, year: input.year, prefix: input.prefix, sequenceId: input.sequenceId, screen: SERIES_SCREEN }
  );
}

export type AllocatedInvoiceNumber = {
  invoiceNumber: string;
  year: number;
  sequenceId: string;
  /** Prefix as printed (FAC-2026- · FAC-RA-2026-). */
  prefix: string;
  /** True when this allocation opened the series row (first number of the year). */
  created: boolean;
  legalEntityId: string | null;
  scope: SeriesScope;
  /** Non-blocking findings (a pre-existing prefix collision with a sister centre). Persisted in Invoice.warningsJson by the callers. */
  warnings: string[];
};

/**
 * Allocate the next number of a series for the fiscal year of `issuedAt`
 * (Europe/Madrid): "FAC-2027-000001" on the first issuance of 2027, whatever
 * 2026 reached. One InvoiceSequence row per (property, series, year); the
 * increment holds the row lock for the transaction and every caller runs
 * under the chain advisory lock, so two allocations never race.
 *
 * Estructura societaria (design §5.2 R3): when the allocation OPENS a series
 * row its prefix is `${series}-${year}-` if the sociedad has one billing
 * centre and `${series}-${code}-${year}-` if it has several, and an active
 * series of a sister centre with the same prefix in that year is refused with
 * 409 SERIES_PREFIX_CLASH { conflictingPropertyId } — the same rule as
 * patchBillingSettings (L2), so two hotels under one NIF can never both open
 * FAC-2026-. A pre-existing collision (both rows already open, e.g. the
 * org_123 sandbox) is reported as a warning: an issued series is closed by
 * the operator, never renumbered (the number index of L8 is the safety net).
 *
 * Legacy tolerance: a row with year NULL (created before the column existed)
 * whose prefix ends in "-<year>-" for the requested year is adopted (year is
 * stamped on it) instead of starting a parallel series — so 2026 keeps
 * running on FAC-2026-000014 after the deploy without any backfill.
 *
 * Callers pass the SAME `issuedAt` that enters the huella. `scope` may be
 * pre-resolved (tests, callers that already hold it).
 */
export async function allocateInvoiceNumber(
  tx: InvoiceSequenceTx,
  input: { propertyId: string; series: InvoiceSeries; issuedAt: Date; scope?: SeriesScope }
): Promise<AllocatedInvoiceNumber> {
  const year = fiscalYearInMadrid(input.issuedAt);
  const scope = input.scope ?? (await resolveSeriesScope(tx, input.propertyId));
  const warnings: string[] = [];

  const legacy = await tx.invoiceSequence.findFirst({
    where: { propertyId: input.propertyId, sequenceCode: input.series, year: null },
    orderBy: { nextNumber: "desc" }
  });
  let sequence: { id: string; prefix: string | null; nextNumber: number; padding: number };
  let created = false;
  if (legacy && typeof legacy.prefix === "string" && legacy.prefix.endsWith(`-${year}-`)) {
    // A closed series never numbers again (R3): the operator reopens it or opens another prefix.
    if (!legacy.active) throw seriesClosedError({ propertyId: input.propertyId, series: input.series, year, prefix: legacy.prefix, sequenceId: legacy.id });
    sequence = await tx.invoiceSequence.update({
      where: { id: legacy.id },
      data: { year, nextNumber: { increment: 1 }, ...(legacy.legalEntityId === null && scope.legalEntityId ? { legalEntityId: scope.legalEntityId } : {}) }
    });
  } else {
    const existing = await tx.invoiceSequence.findUnique({
      where: { propertyId_sequenceCode_year: { propertyId: input.propertyId, sequenceCode: input.series, year } }
    });
    if (existing) {
      if (!existing.active) {
        throw seriesClosedError({ propertyId: input.propertyId, series: input.series, year, prefix: existing.prefix ?? `${input.series}-${year}-`, sequenceId: existing.id });
      }
      sequence = await tx.invoiceSequence.update({
        where: { id: existing.id },
        data: { nextNumber: { increment: 1 }, ...(existing.legalEntityId === null && scope.legalEntityId ? { legalEntityId: scope.legalEntityId } : {}) }
      });
    } else {
      // Opening a row: serialise against the sister centres of the sociedad
      // (t6b#1), refuse an uncoded centre when several centres bill under the
      // NIF (the plain FAC-<año>- would collide), then check the sisters.
      await lockSeriesOpening(tx, scope, year);
      if (scope.billingCentres > 1 && !scope.propertyCode) {
        throw workCenterCodeRequiredError({ propertyId: input.propertyId, series: input.series, year, billingCentres: scope.billingCentres });
      }
      const prefix = defaultSeriesPrefix({ series: input.series, year, propertyCode: scope.propertyCode, billingCentres: scope.billingCentres });
      const clash = findPrefixClash(await loadSiblingSeries(tx, scope), { propertyId: input.propertyId, prefix, year });
      if (clash) throw seriesPrefixClashError(clash, { propertyId: input.propertyId, prefix, year });
      sequence = await tx.invoiceSequence.create({
        data: {
          propertyId: input.propertyId,
          sequenceCode: input.series,
          year,
          prefix,
          nextNumber: 2,
          padding: SERIES_PADDING,
          invoiceType: SERIES_INVOICE_TYPE[input.series],
          legalEntityId: scope.legalEntityId
        }
      });
      created = true;
    }
  }

  const prefix = sequence.prefix ?? `${input.series}-${year}-`;
  if (!created) {
    // Pre-existing collision: report, never renumber (R3).
    const clash = findPrefixClash(await loadSiblingSeries(tx, scope), { propertyId: input.propertyId, prefix, year, excludeSequenceId: sequence.id });
    if (clash) warnings.push(legacySeriesClashWarning(normalizeSeriesPrefix(prefix), year, clash));
  }
  const number = sequence.nextNumber - 1;
  const padding = sequence.padding > 0 ? sequence.padding : SERIES_PADDING;
  return {
    invoiceNumber: `${prefix}${String(number).padStart(padding, "0")}`,
    year,
    sequenceId: sequence.id,
    prefix,
    created,
    legalEntityId: scope.legalEntityId,
    scope,
    warnings
  };
}

/**
 * Safety net under the prefix rule (design §5.1: the pair NIF + serie +
 * número is unique per obligado): 409 INVOICE_NUMBER_DUPLICATE when a sister
 * centre of the same sociedad already issued that number. Stands in for the
 * partial unique index (legal_entity_id, invoice_number) deferred to L8.
 * The number is locked under the sociedad first (pg_advisory_xact_lock): two
 * centres numbering a shared legacy prefix (org_123: FAC-2026- in both) at
 * the same instant are serialised, so the second one reads the first one's
 * committed row instead of passing in READ COMMITTED (t6b#1).
 */
export async function assertInvoiceNumberFreeInEntity(
  tx: Pick<Prisma.TransactionClient, "invoice" | "$executeRaw">,
  scope: Pick<SeriesScope, "propertyId" | "siblingPropertyIds" | "legalEntityId" | "organizationId">,
  invoiceNumber: string
): Promise<void> {
  if (scope.siblingPropertyIds.length === 0) return;
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${invoiceNumberLockKey(scope, invoiceNumber)}))`;
  const duplicate = await tx.invoice.findFirst({
    where: { propertyId: { in: scope.siblingPropertyIds }, invoiceNumber, deletedAt: null, status: { not: "draft" } },
    select: { id: true, propertyId: true }
  });
  if (!duplicate) return;
  throw new ConflictError(
    `El número ${invoiceNumber} ya existe en otro centro de la misma sociedad: bajo un mismo NIF cada número de factura es único. Cierra la serie duplicada y abre otra con el código del centro (nunca se renumera).`,
    { code: INVOICE_NUMBER_DUPLICATE_CODE, invoiceNumber, propertyId: scope.propertyId, conflictingPropertyId: duplicate.propertyId, conflictingInvoiceId: duplicate.id }
  );
}

// ── Structure snapshot (frozen with the document) ────────────────────────────

/**
 * Establishment and sociedad data frozen inside Invoice.snapshotJson at
 * issuance (design §5.2 R2: PDF shows sociedad + establecimiento as they were
 * when the document was expedited). Additive keys next to InvoiceSnapshotV1;
 * parseInvoiceSnapshot ignores them, structureFromSnapshotJson reads them.
 */
export type InvoiceSnapshotStructure = {
  establishment: IssuerEstablishment;
  /** Domicilio fiscal of the sociedad at issuance. */
  issuerFiscalAddress: string | null;
  legalEntityId: string | null;
  installationId: string | null;
  numeroInstalacion: string | null;
  /** Why the document carries no VeriFactu record (SII, R7/R8); null when it does. Frozen so the PDF and the cancel path never depend on the live flag. */
  verifactuExclusion: VerifactuExclusion | null;
};

export function structureSnapshot(
  issuer: Pick<IssuerIdentity, "establishment" | "fiscalAddress" | "legalEntityId" | "verifactuExclusion">,
  chain: Pick<VerifactuChainScope, "legalEntityId" | "installation">
): InvoiceSnapshotStructure {
  const excluded = issuer.verifactuExclusion !== null;
  return {
    establishment: issuer.establishment,
    issuerFiscalAddress: issuer.fiscalAddress,
    legalEntityId: chain.legalEntityId ?? issuer.legalEntityId,
    // No record, no chain: an excluded document is not linked to an installation.
    installationId: excluded ? null : chain.installation?.id ?? null,
    numeroInstalacion: excluded ? null : chain.installation?.numeroInstalacion ?? null,
    verifactuExclusion: issuer.verifactuExclusion
  };
}

/** Pure: the exclusion frozen in a snapshotJson value, or null / undefined (legacy snapshot without the key). */
function exclusionFromSnapshotValue(value: unknown): VerifactuExclusion | null | undefined {
  if (value === null) return null;
  if (!value || typeof value !== "object") return undefined;
  const v = value as { code?: unknown; motivo?: unknown };
  return v.code === "VERIFACTU_EXCLUDED_BY_SII" && typeof v.motivo === "string" ? { code: v.code, motivo: v.motivo } : undefined;
}

/** The structure keys of a stored snapshotJson (empty object on legacy snapshots). Pure. */
export function structureFromSnapshotJson(value: unknown): Partial<InvoiceSnapshotStructure> {
  if (!value || typeof value !== "object") return {};
  const v = value as Partial<InvoiceSnapshotStructure>;
  const establishment = v.establishment && typeof v.establishment === "object" && typeof (v.establishment as IssuerEstablishment).propertyId === "string" ? (v.establishment as IssuerEstablishment) : undefined;
  return {
    ...(establishment ? { establishment } : {}),
    ...(typeof v.issuerFiscalAddress === "string" || v.issuerFiscalAddress === null ? { issuerFiscalAddress: v.issuerFiscalAddress } : {}),
    ...(typeof v.legalEntityId === "string" || v.legalEntityId === null ? { legalEntityId: v.legalEntityId } : {}),
    ...(typeof v.installationId === "string" || v.installationId === null ? { installationId: v.installationId } : {}),
    ...(typeof v.numeroInstalacion === "string" || v.numeroInstalacion === null ? { numeroInstalacion: v.numeroInstalacion } : {}),
    ...(exclusionFromSnapshotValue(v.verifactuExclusion) !== undefined ? { verifactuExclusion: exclusionFromSnapshotValue(v.verifactuExclusion) as VerifactuExclusion | null } : {})
  };
}

// ── VeriFactu chain (altas + anulaciones of an installation, under one lock) ──

export type ChainLinkKind = "alta" | "anulacion";

export type ChainLink = {
  invoiceId: string;
  invoiceNumber: string | null;
  kind: ChainLinkKind;
  hash: string;
  /** Generation timestamp of the record: issuedAt of an alta, cancelledAt of an anulación. */
  generatedAt: Date;
  /** Issuer NIF snapshot of that record (RegistroAnterior/IDEmisorFactura must use it, not the current NIF). */
  emitterTaxId: string | null;
};

/** Transaction slice the chain helpers need (a full TransactionClient satisfies it). */
export type ChainTx = Pick<Prisma.TransactionClient, "$executeRaw" | "invoice" | "verifactuSubmission" | "property" | "organization" | "legalEntity" | "verifactuInstallation">;

/**
 * Serialise every chain mutation (issue / rectify / cancel) for the rest of
 * the transaction: number allocation, previous-link lookup and the write
 * happen with no interleaving, so the chain cannot fork. Design §5.2 R7: the
 * chain — and therefore the lock — belongs to the (obligado; instalación):
 * `target` may be a propertyId (resolved to its installation here) or a scope
 * already resolved. Records of the chain's centres that predate the
 * installation are linked to it under the lock (adoptOrphanChainRecords).
 */
export async function lockVerifactuChain(tx: ChainTx, target: string | VerifactuChainScope): Promise<VerifactuChainScope> {
  const scope = typeof target === "string" ? await resolveVerifactuChainScope(tx, target) : target;
  await lockVerifactuChainScope(tx, scope);
  await adoptOrphanChainRecords(tx, scope);
  return scope;
}

/**
 * The previous link of the chain is the most recently GENERATED record —
 * alta or anulación — regardless of invoice status: the VeriFactu chain is a
 * chain of registros, not of live invoices (an alta of a later-cancelled
 * invoice still sits in the chain). Same rule as chainTailBefore in
 * verifactu-submission.service.ts (the anulación wins only when strictly
 * later), so the tail both modules compute for one instant is identical. Pure.
 */
export function pickPreviousChainLink(lastAlta: ChainLink | null, lastAnulacion: ChainLink | null): ChainLink | null {
  if (!lastAlta) return lastAnulacion;
  if (!lastAnulacion) return lastAlta;
  return lastAnulacion.generatedAt.getTime() > lastAlta.generatedAt.getTime() ? lastAnulacion : lastAlta;
}

const CHAIN_LINK_SELECT = {
  id: true,
  invoiceNumber: true,
  verifactuHash: true,
  cancellationHash: true,
  issuedAt: true,
  cancelledAt: true,
  issuerTaxId: true,
  qrPayload: true
} as const;

/** Previous link of the chain of `target` (a propertyId, resolved to its installation, or a resolved scope). */
export async function findPreviousChainLink(tx: Omit<ChainTx, "$executeRaw" | "verifactuSubmission">, target: string | VerifactuChainScope): Promise<ChainLink | null> {
  const scope = typeof target === "string" ? await resolveVerifactuChainScope(tx, target) : target;
  const chain = chainInvoiceWhere(scope);
  const lastAlta = await tx.invoice.findFirst({
    where: { AND: [chain, { deletedAt: null, verifactuHash: { not: null }, issuedAt: { not: null } }] },
    orderBy: [{ issuedAt: "desc" }, { id: "desc" }],
    select: CHAIN_LINK_SELECT
  });
  const lastAnulacion = await tx.invoice.findFirst({
    where: { AND: [chain, { deletedAt: null, cancellationHash: { not: null }, cancelledAt: { not: null } }] },
    orderBy: [{ cancelledAt: "desc" }, { id: "desc" }],
    select: CHAIN_LINK_SELECT
  });
  const alta: ChainLink | null =
    lastAlta && lastAlta.verifactuHash && lastAlta.issuedAt
      ? {
          invoiceId: lastAlta.id,
          invoiceNumber: lastAlta.invoiceNumber,
          kind: "alta",
          hash: lastAlta.verifactuHash,
          generatedAt: lastAlta.issuedAt,
          emitterTaxId: lastAlta.issuerTaxId ?? taxIdFromQrPayload(lastAlta.qrPayload)
        }
      : null;
  const anulacion: ChainLink | null =
    lastAnulacion && lastAnulacion.cancellationHash && lastAnulacion.cancelledAt
      ? {
          invoiceId: lastAnulacion.id,
          invoiceNumber: lastAnulacion.invoiceNumber,
          kind: "anulacion",
          hash: lastAnulacion.cancellationHash,
          generatedAt: lastAnulacion.cancelledAt,
          emitterTaxId: lastAnulacion.issuerTaxId ?? taxIdFromQrPayload(lastAnulacion.qrPayload)
        }
      : null;
  return pickPreviousChainLink(alta, anulacion);
}

/** Audit / event fields describing the previous chain link (null fields on the first record). */
export function previousLinkFields(previous: ChainLink | null): {
  previousInvoiceId: string | null;
  previousRegistroType: ChainLinkKind | null;
  previousInvoiceNumber: string | null;
  previousEmitterTaxId: string | null;
  previousInvoiceHash: string | null;
} {
  return {
    previousInvoiceId: previous?.invoiceId ?? null,
    previousRegistroType: previous?.kind ?? null,
    previousInvoiceNumber: previous?.invoiceNumber ?? null,
    previousEmitterTaxId: previous?.emitterTaxId ?? null,
    previousInvoiceHash: previous?.hash ?? null
  };
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
    customerName: row.customerName ?? null,
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
    issuerTaxIdPlaceholder: row.issuerTaxIdPlaceholder,
    rectificationType: row.rectificationType === "S" || row.rectificationType === "I" ? row.rectificationType : null,
    cancellationHash: row.cancellationHash ?? null,
    warnings: parseInvoiceWarnings(row.warningsJson),
    taxBreakdown: parseTaxBreakdown(row.taxBreakdownJson),
    seriesCode: row.seriesCode ?? null,
    simplified: row.simplified,
    customerRequired: row.customerRequired
  };
}

export const ISSUED_WITH_PLACEHOLDER_WARNING =
  `Factura emitida en sandbox con el NIF de relleno ${ISSUER_TAX_ID_PLACEHOLDER}: no es un documento fiscal válido.`;

function issuerBlock(identity: IssuerIdentity | null, row: Pick<InvoiceRow, "issuerTaxId" | "issuerLegalName" | "issuerTaxIdPlaceholder" | "qrPayload" | "status" | "verifactuHash" | "snapshotJson">): InvoiceIssuer | undefined {
  if (!identity && !row.issuerTaxId) return undefined;
  // Frozen exclusion of an issued document; the live sociedad for drafts and
  // for documents issued before the snapshot key (only when they have no huella).
  const frozenExclusion = row.status === "draft" ? undefined : structureFromSnapshotJson(row.snapshotJson).verifactuExclusion;
  const verifactuExclusion: VerifactuExclusion | null =
    frozenExclusion !== undefined ? frozenExclusion : row.status !== "draft" && row.verifactuHash ? null : (identity?.verifactuExclusion ?? null);
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
    legalFooter: identity?.legalFooter ?? undefined,
    legalEntityId: identity?.legalEntityId ?? null,
    fiscalAddress: identity?.fiscalAddress ?? undefined,
    establishment: identity?.establishment,
    verifactuExclusion
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
      total: dec(l.total),
      taxCategory: l.taxCategory ?? null,
      taxCalificacion: l.taxCalificacion ?? null,
      taxFigure: l.taxFigure ?? null
    });
    linesByInvoice.set(l.invoiceId, list);
  }
  return rows.map((row) => ({
    ...toListItem(row, paid.get(row.id)),
    issuer: issuerBlock(identities.get(row.propertyId) ?? null, row),
    lines: linesByInvoice.get(row.id) ?? [],
    snapshot: parseInvoiceSnapshot(row.snapshotJson)
  }));
}

export async function loadInvoice(invoiceId: string): Promise<InvoiceRecord> {
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
    legalFooter: identity.legalFooter ?? undefined,
    legalEntityId: identity.legalEntityId,
    fiscalAddress: identity.fiscalAddress ?? undefined,
    establishment: identity.establishment
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

// ── Recipient (Destinatarios/NombreRazon, Tanda 3 cierre) ────────────────────

export const RECIPIENT_NAME_REQUIRED_CODE = "RECIPIENT_NAME_REQUIRED";
export const RECIPIENT_NAME_REQUIRED_MESSAGE = "Indica el nombre o razón social del destinatario";
const RECIPIENT_NAME_HINT =
  "Una factura completa (F1) con NIF del cliente lleva Destinatarios/NombreRazon en VeriFactu; el NIF nunca sustituye al nombre. Envía customerName al crear el borrador o al emitir.";

function cleanName(value: string | null | undefined): string | null {
  const trimmed = (value ?? "").trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** "firstName surname1 surname2" of a guest row, or null when it carries no usable name. Pure. */
export function guestFullName(guest: { firstName?: string | null; surname1?: string | null; surname2?: string | null } | null | undefined): string | null {
  if (!guest) return null;
  return cleanName([guest.firstName, guest.surname1, guest.surname2].map((part) => cleanName(part)).filter((part): part is string => part !== null).join(" "));
}

/**
 * Recipient name snapshot of a folio invoice: the caller's explicit
 * customerName first; else, by customer type, the reservation's razón social
 * (company), the travel agent (agency, falling back to the booker) or the
 * primary guest's full name (guest, falling back to the booker). A company
 * invoice never borrows a person's name: without a razón social it stays
 * null and issuance asks for it. Pure.
 */
export function resolveFolioCustomerName(input: {
  customerType: InvoiceListItem["customerType"];
  explicit?: string | null;
  reservation: { companyName?: string | null; travelAgentName?: string | null; bookerName?: string | null };
  guestName: string | null;
}): string | null {
  const explicit = cleanName(input.explicit);
  if (explicit) return explicit;
  switch (input.customerType) {
    case "company":
      return cleanName(input.reservation.companyName);
    case "agency":
      return cleanName(input.reservation.travelAgentName) ?? cleanName(input.reservation.bookerName);
    default:
      return cleanName(input.guestName) ?? cleanName(input.reservation.bookerName);
  }
}

/**
 * Whether the invoice cannot be created / issued for lack of a recipient
 * name: a full invoice (F1, or F3) whose recipient is identified by NIF must
 * carry the name that goes to Destinatarios/NombreRazon. Simplified invoices
 * (F2) and rectificativas (they copy the original's snapshot) are not held. Pure.
 */
export function recipientNameRequired(invoiceType: string, customerTaxId: string | null | undefined, customerName: string | null | undefined): boolean {
  if (invoiceType !== "F1" && invoiceType !== "F3") return false;
  if (!normalizeTaxId(customerTaxId)) return false;
  return cleanName(customerName) === null;
}

/** 400 for a full invoice with NIF and no recipient name (details.code = RECIPIENT_NAME_REQUIRED). Pure. */
export function recipientNameMissingError(): BadRequestError {
  const error = new BadRequestError(RECIPIENT_NAME_REQUIRED_MESSAGE);
  error.details = { code: RECIPIENT_NAME_REQUIRED_CODE, hint: RECIPIENT_NAME_HINT };
  return error;
}

const GUEST_NAME_SELECT = { firstName: true, surname1: true, surname2: true } as const;

/** Full name of the folio's guest, else of the reservation's primary (or first) guest; null when none is linked. */
async function resolvePrimaryGuestName(folioGuestId: string | null, reservationId: string): Promise<string | null> {
  if (folioGuestId) {
    const guest = await prisma.guest.findUnique({ where: { id: folioGuestId }, select: GUEST_NAME_SELECT });
    const name = guestFullName(guest);
    if (name) return name;
  }
  const link = await prisma.reservationGuest.findFirst({
    where: { reservationId, guest: { is: { deletedAt: null } } },
    orderBy: [{ isPrimary: "desc" }, { id: "asc" }],
    select: { guest: { select: GUEST_NAME_SELECT } }
  });
  return guestFullName(link?.guest ?? null);
}

export type TaxResolutionLine = { lineType: string; taxCode: string; ratePercent: number };

/**
 * Non-blocking warnings for lines that will be invoiced without VAT: an
 * UNKNOWN figure (no tax configured when the line was created) or a 0 % rate
 * on a subject (S1) operation. One warning per (code, line type). `taxCode`
 * is the resolver's raw figure ("UNKNOWN", "IVA", "IGIC", "IPSI"). Callers
 * must not feed N1 (not subject) lines: a penalty at 0 % is correct. Pure.
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

// ── Tax warnings / readiness (Tanda 3) ───────────────────────────────────────

/** The slice of getPropertyTaxProfile the warning / readiness policies read. */
export type PropertyTaxContext = {
  taxRegion: TaxRegion | null;
  regionSource: "property" | "province" | "default";
  figure: TaxFigure | null;
  touristTaxTreatment: string | null;
  ipsiOrdinanceConfirmedAt: string | null;
  warnings: string[];
};

/**
 * A line as resolved by resolveTaxRate (or by the manual-draft profile), for
 * invoiceTaxWarnings. `source` is where the rate came from: a manual override
 * of the property, a provisioned TaxRate row ("db") or the statutory catalogue.
 */
export type ResolvedInvoiceLine = {
  lineType: string;
  description: string;
  taxCode: string;
  ratePercent: number;
  figure: TaxFigure;
  calificacion: Calificacion;
  category: string;
  source: PropertyTaxProfileRateSource;
  verifyAgainstOrdinance: boolean;
};

const TOURIST_TAX_TREATMENT_NOTES: Record<string, string> = {
  included_10:
    "Tasa turística repercutida al 10 % dentro de la base del alojamiento (tarifas oficiales IVA incluido, doctrina DGT; configurable en Cumplimiento › Fiscal).",
  not_subject: "Tasa turística facturada como operación no sujeta (N1) según la configuración de la propiedad; revisa el criterio con el asesor fiscal.",
  none: "El folio contiene líneas de tasa turística pero la propiedad está configurada sin tasa turística: revisa la configuración fiscal."
};

/**
 * Warnings persisted with a draft (Invoice.warningsJson): lines without a
 * usable rate, catalogue rates applied because the property has no fiscal
 * region, IPSI rates not confirmed against the ordinance, tourist-tax
 * treatment, plus whatever getPropertyTaxProfile reports. Pure.
 */
export function invoiceTaxWarnings(lines: ResolvedInvoiceLine[], profile: PropertyTaxContext | null): string[] {
  const warnings: string[] = [];
  warnings.push(
    ...taxResolutionWarnings(
      lines
        .filter((line) => line.calificacion !== "N1")
        .map((line) => ({ lineType: line.lineType, taxCode: line.taxCode.startsWith("ES_UNKNOWN") ? "UNKNOWN" : line.figure, ratePercent: line.ratePercent }))
    )
  );
  // The profile already explains a missing region / unconfirmed IPSI in its
  // own words; add ours only when it did not (no two warnings for one fact).
  const profileMentions = (needle: string) => (profile?.warnings ?? []).some((w) => w.toLowerCase().includes(needle));
  if (profile && profile.regionSource === "default" && lines.some((line) => line.source === "catalog") && !profileMentions("región fiscal")) {
    const types = uniqueStrings(lines.filter((line) => line.source === "catalog").map((line) => line.lineType)).join(", ");
    warnings.push(
      `La propiedad no tiene región fiscal configurada: se han aplicado los tipos estatutarios de Península y Baleares por defecto (${types}). Configura la región fiscal en Cumplimiento › Fiscal antes de emitir en producción.`
    );
  }
  const ipsi = lines.some((line) => line.figure === "IPSI" || line.verifyAgainstOrdinance) || profile?.figure === "IPSI";
  if (ipsi && !profile?.ipsiOrdinanceConfirmedAt && !profileMentions("ipsi")) {
    warnings.push(
      "Tipos IPSI sin confirmar contra la ordenanza fiscal vigente (Ceuta/Melilla): confirma los tipos en Cumplimiento › Fiscal; en producción la emisión se bloquea hasta entonces."
    );
  }
  if (lines.some((line) => line.category === "tourist_tax")) {
    const note = TOURIST_TAX_TREATMENT_NOTES[profile?.touristTaxTreatment ?? "included_10"];
    if (note) warnings.push(note);
  }
  if (profile) warnings.push(...profile.warnings);
  return uniqueStrings(warnings);
}

export const TAX_NOT_CONFIGURED_CODE = "TAX_NOT_CONFIGURED";
const TAX_NOT_CONFIGURED_HINT = "Configura la región fiscal y los tipos en Cumplimiento › Fiscal (GET/PUT /backoffice/properties/:propertyId/taxes) y vuelve a generar el borrador.";

export type TaxReadiness = { ok: boolean; blocking: string[]; warnings: string[] };

export type TaxReadinessLine = InvoiceLineTaxFields & { description: string };

/**
 * Issuance policy (Tanda 3): what blocks a fiscal invoice in production.
 *  - a line with an ES_UNKNOWN_* tax code (no tax configured when created);
 *  - a subject (S1) line at 0 % whose category is not `not_subject`;
 *  - a property without a canonical fiscal region (catalogue default);
 *  - IPSI rates (Ceuta/Melilla) without ipsiOrdinanceConfirmedAt.
 * In sandbox the same list is issued as warnings. Pure.
 */
export function evaluateTaxReadiness(lines: TaxReadinessLine[], context: PropertyTaxContext | null): TaxReadiness {
  const blocking: string[] = [];
  const warnings = context ? [...context.warnings] : [];
  let ipsi = context?.figure === "IPSI";
  for (const line of lines) {
    const identity = lineTaxIdentity(line);
    if (identity.figure === "IPSI") ipsi = true;
    const label = line.description.length > 60 ? `${line.description.slice(0, 57)}…` : line.description;
    if (identity.unknown) {
      blocking.push(`Línea «${label}»: sin tipo impositivo configurado (${line.taxCode}).`);
      continue;
    }
    if (identity.calificacion === "S1" && line.taxRate === 0 && identity.category !== "not_subject") {
      blocking.push(
        `Línea «${label}»: tipo 0 % en una operación sujeta (${identity.figure}${identity.category ? `, ${identity.category}` : ", sin categoría fiscal"}); solo las operaciones no sujetas (N1) van sin cuota.`
      );
    }
  }
  if (!context || !context.taxRegion || context.regionSource === "default") {
    blocking.push("La propiedad no tiene región fiscal canónica (ES_PENINSULA_BALEARES, ES_CANARIAS, ES_CEUTA o ES_MELILLA).");
  }
  if (ipsi && !context?.ipsiOrdinanceConfirmedAt) {
    blocking.push("Los tipos IPSI no están confirmados contra la ordenanza fiscal vigente de Ceuta/Melilla (ipsiOrdinanceConfirmedAt).");
  }
  return { ok: blocking.length === 0, blocking: uniqueStrings(blocking), warnings: uniqueStrings(warnings) };
}

/** 409 for issuance in fiscal production mode with unconfigured tax (details.code = TAX_NOT_CONFIGURED). Pure. */
export function taxNotConfiguredError(readiness: TaxReadiness): ConflictError {
  const error = new ConflictError(
    `No se puede emitir la factura: impuestos sin configurar (${readiness.blocking.length} ${readiness.blocking.length === 1 ? "problema" : "problemas"}). ${TAX_NOT_CONFIGURED_HINT}`
  );
  error.details = { code: TAX_NOT_CONFIGURED_CODE, blocking: readiness.blocking, warnings: readiness.warnings, hint: TAX_NOT_CONFIGURED_HINT };
  return error;
}

/** The warning / readiness slice of a getPropertyTaxProfile answer. */
export function taxContextFromProfile(profile: Awaited<ReturnType<typeof getPropertyTaxProfile>>): PropertyTaxContext {
  return {
    taxRegion: profile.taxRegion,
    regionSource: profile.regionSource,
    figure: profile.figure,
    touristTaxTreatment: profile.touristTaxTreatment ?? null,
    ipsiOrdinanceConfirmedAt: profile.ipsiOrdinanceConfirmedAt,
    warnings: profile.warnings
  };
}

/**
 * Tax readiness of a persisted invoice (contract D): evaluateTaxReadiness over
 * its lines and the property's tax profile. issueInvoice blocks on it in
 * fiscal production mode; the UI disables "Emitir" with the same list.
 */
export async function taxReadinessForInvoice(invoiceId: string): Promise<TaxReadiness> {
  const invoice = await prisma.invoice.findUnique({ where: { id: invoiceId }, select: { propertyId: true } });
  if (!invoice) throw new NotFoundError("Factura no encontrada.");
  const lines = await prisma.invoiceLine.findMany({
    where: { invoiceId },
    select: { description: true, taxCode: true, taxRate: true, taxCategory: true, taxCalificacion: true, taxFigure: true }
  });
  const profile = taxContextFromProfile(await getPropertyTaxProfile(invoice.propertyId));
  return evaluateTaxReadiness(
    lines.map((line) => ({ ...line, taxRate: dec(line.taxRate) })),
    profile
  );
}

/** Persisted-line shape used by the folio / rectify paths before createMany. */
export type InvoiceLineData = {
  description: string;
  quantity: number;
  unitPrice: number;
  taxCode: string;
  taxRate: number;
  total: number;
  taxCategory: string | null;
  taxCalificacion: string | null;
  taxFigure: string | null;
};

/** InvoiceLine fields + warning input from a resolveTaxRate answer. */
export function lineFromResolvedRate(input: {
  lineType: string;
  description: string;
  quantity: number;
  unitPrice: number;
  total: number;
  resolved: ResolvedRate;
}): { data: InvoiceLineData; resolvedLine: ResolvedInvoiceLine } {
  const { resolved } = input;
  // ResolvedRate.taxCode is the figure ("IVA") for pre-Tanda-3 readers; the
  // per-line code persisted in InvoiceLine.taxCode is the canonical one
  // ("ES_IVA_10", "ES_IVA_N1"), which parseTaxCode understands.
  const taxCode = resolved.canonicalTaxCode;
  return {
    data: {
      description: input.description,
      quantity: input.quantity,
      unitPrice: input.unitPrice,
      taxCode,
      taxRate: resolved.ratePercent,
      total: input.total,
      taxCategory: resolved.category,
      taxCalificacion: resolved.calificacion,
      taxFigure: resolved.figure
    },
    resolvedLine: {
      lineType: input.lineType,
      description: input.description,
      taxCode,
      ratePercent: resolved.ratePercent,
      figure: resolved.figure,
      calificacion: resolved.calificacion,
      category: resolved.category,
      source: resolved.source,
      verifyAgainstOrdinance: resolved.verifyAgainstOrdinance
    }
  };
}

export async function createInvoiceFromFolio(input: {
  context: UserContext;
  folioId: string;
  customerType?: InvoiceRecord["customerType"];
  customerTaxId?: string;
  /** Recipient name / razón social; resolved from the guest / reservation when omitted (resolveFolioCustomerName). */
  customerName?: string;
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

  // Finanzas (2026-09-15): only live charges are invoiced — soft-deleted lines
  // used to be dragged into the draft — and the folio reflections of fiscal
  // documents (invoice_adjustment lines written by a rectificativa) are never
  // invoiced themselves.
  const folioLines = (await prisma.folioLine.findMany({ where: { folioId: folio.id, deletedAt: null }, orderBy: [{ postedAt: "asc" }, { id: "asc" }] })).filter(
    (line) => !FISCAL_REFLECTION_LINE_TYPES.includes(line.type)
  );
  if (folioLines.length === 0) throw new BadRequestError("El folio no tiene cargos que facturar.");

  // Tanda 3 (cierre): recipient snapshot for Destinatarios/NombreRazon. A
  // missing name does not block the draft (the folio flow may not know it
  // yet); issueInvoice refuses an F1 with NIF and no name (400) unless the
  // name is supplied then.
  const customerType = input.customerType ?? "guest";
  const customerName = resolveFolioCustomerName({
    customerType,
    explicit: input.customerName,
    reservation: reservation,
    guestName: await resolvePrimaryGuestName(folio.guestId, reservation.id)
  });

  // Tanda 3: every line resolves through the catalogue-backed resolver
  // (contract C, never UNKNOWN when a region is known): figure / impuesto /
  // category / calificación per line, with FolioLine.taxCategory as the
  // explicit override (POS food & beverage, tourist tax…).
  const resolvedLines: ResolvedInvoiceLine[] = [];
  const invoiceLinesData: InvoiceLineData[] = [];
  for (const line of folioLines) {
    const resolved = await resolveTaxRate({
      propertyId: reservation.propertyId,
      lineType: line.type,
      postingDate: line.postedAt,
      taxCategory: line.taxCategory ?? null
    });
    const built = lineFromResolvedRate({
      lineType: line.type,
      description: line.description,
      quantity: dec(line.quantity),
      unitPrice: dec(line.unitPrice),
      total: dec(line.total),
      resolved
    });
    invoiceLinesData.push(built.data);
    resolvedLines.push(built.resolvedLine);
  }
  // One grouping for header, desglose, PDF and UI (contract B).
  const totals = totalsForInvoiceLines(invoiceLinesData);
  const total = totals.total;
  const taxTotal = totals.taxTotal;
  // Tax problems are reported on the draft (persisted in warningsJson) and
  // block only at issuance in fiscal production mode (taxReadinessForInvoice).
  const profile = await getPropertyTaxProfile(reservation.propertyId);
  const warnings = invoiceTaxWarnings(resolvedLines, taxContextFromProfile(profile));
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
    baseTotal = round(total * fxRate);
  }

  const created = await prisma.$transaction(async (tx) => {
    // Serialise concurrent invoicing of the same folio: the row lock makes a
    // second transaction wait here and then see the invoice the first one
    // committed (read committed), so the re-check below is race-safe.
    await tx.$queryRaw`SELECT id FROM folios WHERE id = ${folio.id} FOR UPDATE`;
    const concurrent = findBlockingFolioInvoice(await loadFolioInvoices(tx, folio.id));
    if (concurrent) throw folioAlreadyInvoicedError(concurrent);
    // Draft-time freeze: the folio lines the draft was built from and their
    // fingerprint. issueInvoice recomputes the fingerprint over the live folio
    // and refuses (409 FOLIO_CHANGED_SINCE_DRAFT) when the charges moved.
    const draftSnapshot: InvoiceDraftSnapshot = {
      version: 1,
      status: "draft",
      folioLineIds: folioLines.map((line) => line.id),
      folioFingerprint: folioLinesFingerprint(folioLines.map((line) => ({ ...line, quantity: dec(line.quantity), unitPrice: dec(line.unitPrice), total: dec(line.total) })))
    };
    const invoice = await tx.invoice.create({
      data: {
        propertyId: reservation.propertyId,
        invoiceType: input.invoiceType ?? "F1",
        customerType,
        customerTaxId: input.customerTaxId ?? null,
        customerName,
        status: "draft",
        total,
        taxTotal,
        currencyCode,
        fxRate: fxRate !== null ? fxRate.toFixed(8) : null,
        baseTotal: baseTotal !== null ? baseTotal.toFixed(2) : null,
        // FISC-04: the source folio is the payment target of markInvoicePaid.
        folioId: folio.id,
        reservationId: folio.reservationId,
        taxBreakdownJson: breakdownJson(totals.breakdown),
        warningsJson: warnings,
        snapshotJson: draftSnapshot as unknown as Prisma.InputJsonValue,
        simplified: (input.invoiceType ?? "F1") === "F2"
      }
    });
    // Lines are inserted in folio order; their cuid ids are time-sortable, so
    // issueInvoice can pair InvoiceLine ↔ FolioLine by position (id asc).
    for (const l of invoiceLinesData) {
      await tx.invoiceLine.create({ data: { invoiceId: invoice.id, ...l } });
    }
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
    afterJson: {
      folioId: folio.id,
      reservationId: folio.reservationId,
      customerType,
      customerName,
      total,
      taxTotal,
      taxBreakdown: totals.breakdown,
      taxRegion: profile.taxRegion,
      regionSource: profile.regionSource,
      warnings
    },
    correlationId: input.correlationId
  });

  return loadInvoice(created.id);
}

/** Draft snapshot of an invoice row (folio lines it was built from), or null. Pure. */
export function parseDraftSnapshot(value: unknown): InvoiceDraftSnapshot | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Partial<InvoiceDraftSnapshot>;
  if (v.version !== 1 || v.status !== "draft" || !Array.isArray(v.folioLineIds) || typeof v.folioFingerprint !== "string") return null;
  return v as InvoiceDraftSnapshot;
}

/** 409 when the folio changed since the draft was generated (details.code = FOLIO_CHANGED_SINCE_DRAFT). Pure. */
export function folioChangedSinceDraftError(input: { invoiceId: string; folioId: string }): ConflictError {
  return new ConflictError(
    "Los cargos del folio han cambiado desde que se generó el borrador (líneas añadidas, modificadas o eliminadas): regenera el borrador antes de emitir.",
    { code: PAYMENT_ERROR_CODES.FOLIO_CHANGED_SINCE_DRAFT, invoiceId: input.invoiceId, folioId: input.folioId }
  );
}

/**
 * 409 when the recipient must be identified on a simplified invoice above the
 * art. 4 RD 1619/2012 limit (details.code = SIMPLIFIED_LIMIT_EXCEEDED). Pure.
 */
export function simplifiedLimitExceededError(input: { total: number; limit: number }): ConflictError {
  return new ConflictError(
    `Una factura simplificada sin identificar al cliente no puede superar ${input.limit.toFixed(2)} € (IVA incluido, art. 4 RD 1619/2012); esta suma ${input.total.toFixed(2)} €. Emite una factura completa (F1) o indica el NIF y nombre del cliente.`,
    { code: PAYMENT_ERROR_CODES.SIMPLIFIED_LIMIT_EXCEEDED, total: input.total, limit: input.limit }
  );
}

export type IssuerSeriesMismatch = {
  series: string;
  year: number;
  /** Prefix that identifies the series (FAC-RA-2026-): the unit the one-issuer rule applies to. */
  prefix: string;
  seriesTaxId: string;
  currentTaxId: string;
  lastInvoiceNumber: string | null;
};

/**
 * 409 when the series already carries invoices of another issuer NIF
 * (details.code = ISSUER_TAX_ID_SERIES_MISMATCH). A series belongs to ONE
 * issuer (RD 1619/2012 art. 6.1.a) and issued invoices keep their NIF
 * snapshot, so the message states the two real remedies (fix t6b#11): a
 * wrong NIF is corrected with rectificativas and in the sociedad's fiscal
 * data; a real change of issuer closes the series and opens another prefix.
 * Pure.
 */
export function issuerSeriesMismatchError(input: IssuerSeriesMismatch): ConflictError {
  return new ConflictError(
    `La serie ${input.prefix} ya tiene facturas emitidas con el NIF ${input.seriesTaxId} (última: ${input.lastInvoiceNumber ?? "—"}) y el emisor configurado es ${input.currentTaxId}: una serie pertenece a un único emisor (RD 1619/2012 art. 6.1.a) y las facturas emitidas conservan su NIF. ` +
      `Si el NIF anterior era erróneo, corrige esas facturas con rectificativas (art. 15) y revisa el NIF en ${LEGAL_IDENTITY_SCREEN}. ` +
      `Si la sociedad ha cambiado de NIF, cierra la serie ${input.prefix} y abre la del nuevo emisor con otro prefijo en ${SERIES_SCREEN}; nunca se renumera una serie emitida.`,
    { code: PAYMENT_ERROR_CODES.ISSUER_TAX_ID_SERIES_MISMATCH, ...input, legalIdentityScreen: LEGAL_IDENTITY_SCREEN, seriesScreen: SERIES_SCREEN }
  );
}

/** Pure: true when `invoiceNumber` belongs to the series `prefix` (prefix + digits only, so FAC-2026- never claims FAC-2026-B-000001). */
export function invoiceNumberBelongsToPrefix(invoiceNumber: string | null | undefined, prefix: string): boolean {
  if (!invoiceNumber || !invoiceNumber.startsWith(prefix)) return false;
  return /^\d+$/.test(invoiceNumber.slice(prefix.length));
}

/**
 * Most recent invoice of the series identified by `prefix` (FAC-RA-2026-)
 * issued with a real NIF (placeholder rows of the sandbox era are ignored),
 * to enforce one issuer per series. Keyed by the printed prefix — the series
 * itself — and not by `${series}-…-${year}-`, so a series opened with another
 * prefix after a change of NIF is not blocked by the old series' invoices.
 */
export async function findSeriesIssuerTaxId(db: Pick<Prisma.TransactionClient, "invoice">, propertyId: string, prefix: string): Promise<{ taxId: string; invoiceNumber: string | null } | null> {
  if (!prefix) return null;
  const rows = await db.invoice.findMany({
    where: {
      propertyId,
      deletedAt: null,
      issuedAt: { not: null },
      issuerTaxId: { not: null },
      issuerTaxIdPlaceholder: false,
      invoiceNumber: { startsWith: prefix }
    },
    orderBy: [{ issuedAt: "desc" }, { id: "desc" }],
    select: { issuerTaxId: true, invoiceNumber: true },
    take: 10
  });
  const row = rows.find((candidate) => invoiceNumberBelongsToPrefix(candidate.invoiceNumber, prefix));
  return row?.issuerTaxId ? { taxId: row.issuerTaxId, invoiceNumber: row.invoiceNumber } : null;
}

export type SeriesBlockedByIssuerChange = {
  propertyId: string;
  sequenceId: string;
  series: string;
  prefix: string;
  year: number | null;
  /** NIF the series' invoices were issued with. */
  seriesTaxId: string;
  lastInvoiceNumber: string | null;
};

/**
 * Active series of a sociedad whose issued invoices carry a NIF other than
 * `nextTaxId`: after the PATCH of the sociedad's NIF each of them answers 409
 * ISSUER_TAX_ID_SERIES_MISMATCH on the next issuance. patchLegalEntity (L2)
 * calls this to warn in its own 200 (fix t6b#11). Read-only; a tenant
 * without a backfilled legal entity is scoped by organization.
 */
export async function findSeriesBlockedByTaxIdChange(
  input: { organizationId: string; legalEntityId?: string | null; nextTaxId: string | null },
  db: Pick<Prisma.TransactionClient, "invoice" | "invoiceSequence" | "property"> = prisma
): Promise<SeriesBlockedByIssuerChange[]> {
  const nextTaxId = normalizeTaxId(input.nextTaxId);
  const properties = await db.property.findMany({
    where: input.legalEntityId ? { legalEntityId: input.legalEntityId } : { organizationId: input.organizationId },
    select: { id: true }
  });
  if (properties.length === 0) return [];
  const sequences = await db.invoiceSequence.findMany({
    where: { propertyId: { in: properties.map((row) => row.id) }, active: true, prefix: { not: null } },
    select: { id: true, propertyId: true, sequenceCode: true, prefix: true, year: true },
    orderBy: [{ propertyId: "asc" }, { sequenceCode: "asc" }, { year: "asc" }]
  });
  const blocked: SeriesBlockedByIssuerChange[] = [];
  for (const sequence of sequences) {
    if (!sequence.prefix) continue;
    const issuer = await findSeriesIssuerTaxId(db, sequence.propertyId, sequence.prefix);
    if (!issuer || issuer.taxId === nextTaxId) continue;
    blocked.push({ propertyId: sequence.propertyId, sequenceId: sequence.id, series: sequence.sequenceCode, prefix: sequence.prefix, year: sequence.year, seriesTaxId: issuer.taxId, lastInvoiceNumber: issuer.invoiceNumber });
  }
  return blocked;
}

/** Pure: Spanish warning for one blocked series (the PATCH of the NIF returns one per row). */
export function seriesBlockedByTaxIdChangeWarning(row: SeriesBlockedByIssuerChange, nextTaxId: string | null): string {
  return `La serie ${row.prefix}${row.year ? ` (${row.year})` : ""} tiene facturas emitidas con el NIF ${row.seriesTaxId} (última: ${row.lastInvoiceNumber ?? "—"}): con el emisor ${nextTaxId ?? "sin NIF"} no admite más facturas (ISSUER_TAX_ID_SERIES_MISMATCH). Cierra la serie y abre la del nuevo emisor con otro prefijo en ${SERIES_SCREEN}; las emitidas conservan su NIF y, si era erróneo, se corrigen con rectificativas.`;
}

/**
 * Audit trail of a document expedited or cancelled WITHOUT a VeriFactu record
 * because the sociedad is outside the RRSIF (R7: «desactivación con motivo»).
 */
function recordVerifactuExclusionAudit(input: { context: UserContext; invoice: Pick<InvoiceRecord, "id" | "propertyId" | "invoiceNumber">; exclusion: VerifactuExclusion; correlationId: string; action: "INVOICE_ISSUED" | "INVOICE_CANCELLED" }): void {
  recordAuditEvent({
    organizationId: input.context.organizationId,
    propertyId: input.invoice.propertyId,
    actorUserId: input.context.userId,
    actorType: "system",
    action: "VERIFACTU_EXCLUDED_BY_SII",
    entityType: "invoice",
    entityId: input.invoice.id,
    afterJson: { invoiceNumber: input.invoice.invoiceNumber ?? null, trigger: input.action, code: input.exclusion.code, motivo: input.exclusion.motivo },
    correlationId: input.correlationId
  });
}

export async function issueInvoice(input: {
  context: UserContext;
  invoiceId: string;
  /** Recipient name / razón social for a draft that has none (e.g. drafts created before Invoice.customerName). */
  customerName?: string;
  correlationId: string;
}): Promise<InvoiceRecord> {
  requirePermissions(input.context, ["invoice.issue"]);

  const existing = await prisma.invoice.findUnique({ where: { id: input.invoiceId } });
  if (!existing) throw new NotFoundError("Factura no encontrada.");
  if (existing.status !== "draft") {
    throw new ConflictError("Las facturas emitidas son inmutables: usa anulación, abono o rectificativa.");
  }

  // Tanda 3 (cierre): an F1 with an identified recipient (NIF) needs the
  // name that goes to Destinatarios/NombreRazon — the NIF never stands in.
  const customerName = cleanName(input.customerName) ?? cleanName(existing.customerName);
  if (recipientNameRequired(existing.invoiceType, existing.customerTaxId, customerName)) throw recipientNameMissingError();

  // FISC-03 (finanzas 2026-09-15): the issuer NIF is mandatory in every mode
  // — 409 ISSUER_TAX_ID_MISSING without a checksum-valid NIF, never the
  // B00000000 placeholder. Snapshotted below so hash / QR / XML stay
  // reproducible.
  const issuer = await requireIssuerIdentity(existing.propertyId);
  const emitterTaxId = issuer.taxId;
  const fiscalMode = resolveFiscalMode();
  // R7 / R8 (t6b#2): a sociedad in the SII is outside the RRSIF — the document
  // is expedited without huella, RegistroAnterior or QR, and nothing is queued.
  const exclusion = issuer.verifactuExclusion;

  // Tanda 3: tax readiness. Production → 409 TAX_NOT_CONFIGURED; sandbox →
  // issue with the problems recorded as warnings + a dedicated audit event.
  const readiness = await taxReadinessForInvoice(existing.id);
  if (!readiness.ok && fiscalMode === "production") throw taxNotConfiguredError(readiness);
  const issueWarnings = uniqueStrings([
    ...parseInvoiceWarnings(existing.warningsJson),
    ...readiness.warnings,
    ...(readiness.ok ? [] : readiness.blocking.map((problem) => `Emitida en sandbox con impuestos sin configurar: ${problem}`)),
    ...(exclusion ? [verifactuExclusionWarning(exclusion)] : [])
  ]);

  // Header totals and desglose from the SAME grouping (contract B), so the
  // CuotaTotal that enters the huella equals Σ CuotaRepercutida of the XML.
  // Drafts created before Tanda 3 (per-line rounding, no breakdown) get their
  // breakdown here; Tanda 3 drafts recompute to the identical values.
  const lineRows = await prisma.invoiceLine.findMany({ where: { invoiceId: existing.id }, orderBy: { id: "asc" } });
  const totals = totalsForInvoiceLines(lineRows.map((l) => ({ ...l, taxRate: dec(l.taxRate), total: dec(l.total) })));
  if (lineRows.length > 0 && Math.abs(totals.total - dec(existing.total)) > CENT_TOLERANCE) {
    throw new ConflictError(
      `El total del borrador (${dec(existing.total).toFixed(2)}) no coincide con la suma de sus líneas (${totals.total.toFixed(2)}); regenera el borrador antes de emitir.`
    );
  }
  const total = lineRows.length > 0 ? totals.total : dec(existing.total);
  const taxTotal = lineRows.length > 0 ? totals.taxTotal : dec(existing.taxTotal);

  // Simplified invoice (F2): the recipient may be omitted only up to the
  // art. 4 RD 1619/2012 limit (400 € · 3.000 € for pure F&B sales).
  const requirement = customerRequiredFor({ invoiceType: existing.invoiceType, total, lines: lineRows });
  if (requirement.required && existing.invoiceType === "F2" && !normalizeTaxId(existing.customerTaxId)) {
    throw simplifiedLimitExceededError({ total, limit: requirement.limit ?? 400 });
  }

  const series = seriesForInvoiceType(existing.invoiceType);
  const draftSnapshot = parseDraftSnapshot(existing.snapshotJson);

  const issued = await prisma.$transaction(async (tx) => {
    // Chain lock: number allocation + previous link + write are serialised per
    // property (no fork under concurrent issue / rectify / cancel).
    const chain = await lockVerifactuChain(tx, existing.propertyId);
    const fresh = await tx.invoice.findUnique({ where: { id: existing.id }, select: { status: true } });
    if (!fresh || fresh.status !== "draft") {
      throw new ConflictError("Las facturas emitidas son inmutables: usa anulación, abono o rectificativa.");
    }

    // Freeze check: the live folio must still match the draft (same lines,
    // same amounts, none deleted). The folio row lock serialises this against
    // concurrent charge posting for the rest of the transaction.
    let folioLineIds: string[] = [];
    if (existing.folioId && draftSnapshot) {
      await tx.$queryRaw`SELECT id FROM folios WHERE id = ${existing.folioId} FOR UPDATE`;
      const liveLines = (await tx.folioLine.findMany({ where: { folioId: existing.folioId, deletedAt: null } })).filter((line) => !FISCAL_REFLECTION_LINE_TYPES.includes(line.type));
      const fingerprint = folioLinesFingerprint(liveLines.map((line) => ({ ...line, quantity: dec(line.quantity), unitPrice: dec(line.unitPrice), total: dec(line.total) })));
      if (fingerprint !== draftSnapshot.folioFingerprint) throw folioChangedSinceDraftError({ invoiceId: existing.id, folioId: existing.folioId });
      folioLineIds = draftSnapshot.folioLineIds;
    }

    const issuedAt = new Date();
    const allocated = await allocateInvoiceNumber(tx, { propertyId: existing.propertyId, series, issuedAt });
    const invoiceNumber = allocated.invoiceNumber;
    // R3 safety net: the number must be unique under the sociedad's NIF.
    await assertInvoiceNumberFreeInEntity(tx, allocated.scope, invoiceNumber);
    const documentWarnings = uniqueStrings([...issueWarnings, ...allocated.warnings]);

    // One issuer per series (the printed prefix): the series may not mix NIFs.
    const seriesIssuer = await findSeriesIssuerTaxId(tx, existing.propertyId, allocated.prefix);
    if (seriesIssuer && seriesIssuer.taxId !== emitterTaxId) {
      throw issuerSeriesMismatchError({ series, year: allocated.year, prefix: allocated.prefix, seriesTaxId: seriesIssuer.taxId, currentTaxId: emitterTaxId, lastInvoiceNumber: seriesIssuer.invoiceNumber });
    }

    // Chain: previous record of the (obligado; instalación), never of another
    // centre's installation. A SII sociedad generates no record at all (R7/R8).
    const previous = exclusion ? null : await findPreviousChainLink(tx, chain);
    const record = exclusion
      ? null
      : computeVerifactuHash({
          emitterTaxId,
          invoiceNumber,
          issuedAt: issuedAt.toISOString(),
          invoiceType: existing.invoiceType as VerifactuInvoiceType,
          vatTotal: taxTotal,
          invoiceTotal: total,
          previousHash: previous?.hash ?? null
        });
    const qrUrl = exclusion
      ? null
      : buildVerifactuQrUrl({
          emitterTaxId,
          invoiceNumber,
          issuedAt: issuedAt.toISOString(),
          invoiceTotal: total,
          preProduction: issuer.fiscalMode !== "production"
        });

    // The frozen document: lines (with their folio line ids), totals and the
    // group breakdown. PDF, VAT books and the journal read this, never the folio.
    const snapshotLines: SnapshotLineInput[] = lineRows.map((l, index) => ({
      folioLineId: folioLineIds.length === lineRows.length ? (folioLineIds[index] ?? null) : null,
      description: l.description,
      quantity: dec(l.quantity),
      unitPrice: dec(l.unitPrice),
      total: dec(l.total),
      taxCode: l.taxCode,
      taxRate: dec(l.taxRate),
      taxCategory: l.taxCategory,
      taxCalificacion: l.taxCalificacion,
      taxFigure: l.taxFigure
    }));
    const snapshot = buildInvoiceSnapshot({
      issuedAt,
      currencyCode: existing.currencyCode ?? "EUR",
      lines: snapshotLines,
      totals: { total, taxTotal },
      breakdown: lineRows.length > 0 ? totals.breakdown : parseTaxBreakdown(existing.taxBreakdownJson),
      folioLineIds,
      issuer: { taxId: emitterTaxId, legalName: issuer.legalName },
      customer: { type: existing.customerType, taxId: normalizeTaxId(existing.customerTaxId), name: customerName }
    });

    const updated = await tx.invoice.update({
      where: { id: existing.id },
      data: {
        status: "issued",
        issuedAt,
        // Tanda 8a (SoD, RD 1007/2023 art. 11): the issuer never cancels its own invoice.
        issuedByUserId: input.context.userId,
        invoiceNumber,
        customerName,
        total,
        taxTotal,
        taxBreakdownJson: breakdownJson(lineRows.length > 0 ? totals.breakdown : parseTaxBreakdown(existing.taxBreakdownJson)),
        warningsJson: documentWarnings,
        verifactuHash: record?.hash ?? null,
        previousInvoiceHash: previous?.hash ?? null,
        qrPayload: qrUrl,
        issuerTaxId: emitterTaxId,
        issuerLegalName: issuer.legalName,
        issuerTaxIdPlaceholder: issuer.placeholder,
        // Estructura societaria: the frozen document also carries the sociedad
        // and the establishment as expedited (R2), and the record is linked to
        // its sociedad and VeriFactu installation (R7) — no installation when
        // the sociedad is excluded from the RRSIF (no record, no chain).
        snapshotJson: { ...snapshot, ...structureSnapshot(issuer, chain) } as unknown as Prisma.InputJsonValue,
        legalEntityId: chain.legalEntityId ?? issuer.legalEntityId,
        installationId: exclusion ? null : chain.installation?.id ?? null,
        seriesCode: series,
        simplified: existing.invoiceType === "F2",
        customerRequired: requirement.required
      }
    });

    // Libro de facturas emitidas (same transaction as the document).
    await writeIssuedVatBookRows(tx, {
      organizationId: input.context.organizationId,
      propertyId: existing.propertyId,
      // Corrector L3 (FC-7): same sourceType the rebuild derives (`invoiceSourceType`):
      // a rectificativa keeps `rectification` when it is issued or cancelled.
      sourceType: invoiceSourceType({ invoiceType: existing.invoiceType, rectifyingForId: existing.rectifyingForId ?? null, simplified: existing.simplified ?? existing.invoiceType === "F2" }) as "invoice" | "rectification" | "simplified",
      sourceId: existing.id,
      date: issuedAt,
      series,
      number: invoiceNumber,
      counterpartyNif: snapshot.customer.taxId,
      counterpartyName: customerName,
      rows: buildVatBookRows(snapshot.taxBreakdown)
    });

    // Canonical rule «Factura emitida»: D 4300 / H 705.x / H 477.tipo [/ H 4759].
    const posted = await getLedgerPort().postJournalEntry(
      {
        organizationId: input.context.organizationId,
        propertyId: existing.propertyId,
        sourceType: "invoice",
        sourceId: existing.id,
        entryDate: issuedAt,
        description: `Factura ${invoiceNumber} · ${customerName ?? existing.customerType}`,
        reference: invoiceNumber,
        createdBy: input.context.userId,
        currencyCode: existing.currencyCode ?? "EUR",
        lines: buildInvoiceJournalLines(snapshot, invoiceNumber)
      },
      tx
    );
    return { invoice: updated, canonical: record?.canonical ?? null, hash: record?.hash ?? null, previous, year: allocated.year, sequenceId: allocated.sequenceId, journalEntryId: posted.journalEntryId, snapshot, chain, allocated, documentWarnings };
  });

  const after = await loadInvoice(issued.invoice.id);
  const previousFields = previousLinkFields(issued.previous);

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
      series,
      sequenceYear: issued.year,
      sequenceId: issued.sequenceId,
      verifactuHash: after.verifactuHash,
      ...previousFields,
      total: after.total,
      taxTotal: after.taxTotal,
      taxBreakdown: after.taxBreakdown,
      hashCanonical: issued.canonical,
      issuerTaxId: emitterTaxId,
      issuerLegalName: issuer.legalName,
      issuerTaxIdPlaceholder: issuer.placeholder,
      legalEntityId: issued.chain.legalEntityId ?? issuer.legalEntityId,
      installationId: exclusion ? null : issued.chain.installation?.id ?? null,
      numeroInstalacion: exclusion ? null : issued.chain.installation?.numeroInstalacion ?? null,
      chainScope: issued.chain.policy,
      verifactuExclusion: exclusion,
      establishmentCode: issuer.establishment.code,
      seriesPrefix: issued.allocated.prefix,
      seriesOpened: issued.allocated.created,
      customerName,
      fiscalMode: issuer.fiscalMode,
      taxWarnings: issued.documentWarnings,
      journalEntryId: issued.journalEntryId,
      folioLineIds: issued.snapshot.folioLineIds,
      simplified: after.simplified,
      customerRequired: after.customerRequired
    },
    correlationId: input.correlationId
  });

  if (exclusion) recordVerifactuExclusionAudit({ context: input.context, invoice: after, exclusion, correlationId: input.correlationId, action: "INVOICE_ISSUED" });

  if (!readiness.ok) {
    recordAuditEvent({
      organizationId: input.context.organizationId,
      propertyId: existing.propertyId,
      actorUserId: input.context.userId,
      actorType: "user",
      action: "INVOICE_ISSUED_WITH_TAX_WARNINGS",
      entityType: "invoice",
      entityId: after.id,
      afterJson: { invoiceNumber: after.invoiceNumber, fiscalMode, blocking: readiness.blocking, warnings: readiness.warnings },
      correlationId: input.correlationId
    });
  }

  recordDomainEvent({
    organizationId: input.context.organizationId,
    propertyId: existing.propertyId,
    entityType: "invoice",
    entityId: after.id,
    eventType: "InvoiceIssued",
    payload: {
      invoiceNumber: after.invoiceNumber!,
      // Null for a document of a SII sociedad: the VeriFactu hook sees no record to queue.
      verifactuHash: after.verifactuHash ?? null,
      verifactuExclusion: exclusion?.code ?? null,
      total: after.total,
      taxTotal: after.taxTotal,
      reservationId: after.reservationId,
      folioId: after.folioId,
      journalEntryId: issued.journalEntryId,
      ...previousFields
    },
    actorType: "user",
    actorUserId: input.context.userId,
    correlationId: input.correlationId
  });

  return after;
}

export type CancelInvoiceResult = InvoiceRecord & { cancellation: InvoiceCancellationPayments };

// ---------------------------------------------------------------------------
// Tanda 8a (RBAC · L2): cancellation with separation of duties
// ---------------------------------------------------------------------------

/** Catálogo de motivos de anulación (cancel_reason): obligatorio en la solicitud. */
export const CANCEL_REASON_CODES = {
  data_error: "Error en los datos de la factura",
  duplicate: "Factura duplicada",
  wrong_recipient: "Destinatario incorrecto",
  service_not_provided: "Servicio no prestado",
  customer_request: "Petición del cliente",
  other: "Otro motivo (indicar en el texto)"
} as const;
export type CancelReasonCode = keyof typeof CANCEL_REASON_CODES;

/**
 * The cancellation gate, separated so it can be unit-tested with a fake
 * context and a fake Prisma of the rbac tables. Order: `invoice.cancel` on
 * the actor (checked by the caller), issuer ≠ canceller (409
 * RBAC_SOD_CONFLICT { rule: "issuer_ne_canceller" }; null issuer = «autor
 * desconocido», never blocks), then the engine (kind invoice_cancel, amount =
 * total, base author = issuer).
 */
export async function assertInvoiceCancellationAuthorized(
  input: {
    context: UserContext;
    invoice: { id: string; propertyId: string; issuedByUserId: string | null; total: Prisma.Decimal | number | string | null };
    supervisorAuthorizationId?: string | null;
  },
  deps: RbacDeps = defaultRbacDeps
): Promise<{ sod: SodCheckOutcome; outcome: AuthorizationOutcome }> {
  const sod = assertSeparationOfDuties(input.context, input.invoice.issuedByUserId, "issuer_ne_canceller", { invoiceId: input.invoice.id });
  const total = new PrismaRuntime.Decimal(input.invoice.total ?? 0).abs().toFixed(2);
  const outcome = await assertApprovedOrAuthorized(
    {
      context: input.context,
      kind: "invoice_cancel",
      entityType: "invoice",
      entityId: input.invoice.id,
      propertyId: input.invoice.propertyId,
      amount: total,
      baseAuthorUserId: input.invoice.issuedByUserId,
      supervisorAuthorizationId: input.supervisorAuthorizationId ?? null
    },
    deps
  );
  return { sod, outcome };
}

/**
 * POST /invoices/:id/cancel-request — the maker side of the anulación
 * (invoice.cancel_request in the property of the invoice): opens the
 * invoice_cancel approval request with the reason code of the catalogue.
 * The decision (invoice.cancel_approve) lives in /approvals and the
 * execution in POST /invoices/:id/cancel (invoice.cancel + the gate above).
 */
export async function requestInvoiceCancellation(input: {
  context: UserContext;
  invoiceId: string;
  reasonCode: string;
  reasonText?: string;
  correlationId: string;
  rbac?: RbacDeps;
}): Promise<ApprovalRequestDto> {
  if (!(input.reasonCode in CANCEL_REASON_CODES)) {
    throw new BadRequestError(`reasonCode no válido: usa uno de ${Object.keys(CANCEL_REASON_CODES).join(", ")}.`);
  }
  const existing = await prisma.invoice.findUnique({ where: { id: input.invoiceId }, select: { id: true, propertyId: true, status: true, invoiceNumber: true, total: true, currencyCode: true, issuedByUserId: true } });
  if (!existing) throw new NotFoundError("Factura no encontrada.");
  if (existing.status !== "issued") throw new ConflictError("Solo las facturas emitidas admiten anulación.");
  return requestApproval(
    {
      context: input.context,
      kind: "invoice_cancel",
      entityType: "invoice",
      entityId: existing.id,
      propertyId: existing.propertyId,
      amount: new PrismaRuntime.Decimal(existing.total ?? 0).abs().toFixed(2),
      currency: existing.currencyCode ?? undefined,
      reasonCode: input.reasonCode,
      reasonText: input.reasonText,
      payload: { invoiceNumber: existing.invoiceNumber, issuedByUserId: existing.issuedByUserId ?? null, correlationId: input.correlationId }
    },
    input.rbac ?? defaultRbacDeps
  );
}

export async function cancelInvoice(input: {
  context: UserContext;
  invoiceId: string;
  reason: string;
  /**
   * Finanzas (2026-09-15): the payments linked to the invoice are ALWAYS
   * unlinked (they stay on the folio, available for the replacing invoice);
   * with `refundPayments: true` every captured one is also refunded in full
   * through the payments service (reversal payment + inverse entry).
   */
  refundPayments?: boolean;
  /** Tanda 8a: single-use supervisor PIN authorisation for invoice.cancel_approve (design §5.6). */
  supervisorAuthorizationId?: string | null;
  correlationId: string;
  /** Injectable rbac collaborators (tests). */
  rbac?: RbacDeps;
}): Promise<CancelInvoiceResult> {
  requirePermissions(input.context, ["invoice.cancel"]);
  const existing = await prisma.invoice.findUnique({ where: { id: input.invoiceId } });
  if (!existing) throw new NotFoundError("Factura no encontrada.");
  if (existing.status !== "issued") {
    throw new ConflictError("Solo las facturas emitidas admiten anulación.");
  }
  if (!existing.invoiceNumber || !existing.issuedAt) {
    throw new ConflictError("La factura no tiene número o fecha de expedición; no se puede anular.");
  }
  // Tanda 8a (design §4.7, RD 1007/2023 art. 11): the anulación is a record
  // another person makes — issuer ≠ canceller over Invoice.issuedByUserId
  // (null = pre-migration document: «autor desconocido», annotated) — and it
  // needs the invoice_cancel authorisation of the L1 engine (an approved
  // request of another person, the actor's own invoice.cancel_approve within
  // its tier, a supervisor PIN or a privileged session; every path audited).
  // The VeriFactu RegistroAnulacion below is untouched by this gate.
  const cancelGate = await assertInvoiceCancellationAuthorized(
    { context: input.context, invoice: { id: existing.id, propertyId: existing.propertyId, issuedByUserId: existing.issuedByUserId ?? null, total: existing.total }, supervisorAuthorizationId: input.supervisorAuthorizationId ?? null },
    input.rbac ?? defaultRbacDeps
  );
  // A document expedited without a VeriFactu record (sociedad in the SII, R7/R8)
  // is cancelled without a RegistroAnulacion: the exclusion frozen in its
  // snapshot decides, the live flag only for documents issued before the key.
  const frozenExclusion = structureFromSnapshotJson(existing.snapshotJson).verifactuExclusion;
  const exclusion: VerifactuExclusion | null = existing.verifactuHash
    ? null
    : frozenExclusion !== undefined
      ? frozenExclusion
      : ((await resolveIssuerIdentity(existing.propertyId))?.verifactuExclusion ?? null);
  if (!existing.verifactuHash && !exclusion) {
    throw new ConflictError("La factura no tiene huella de alta; no se puede generar el registro de anulación.");
  }
  const before = await loadInvoice(existing.id);
  const invoiceNumber = existing.invoiceNumber;

  // Tanda 3: the anulación is a chain record of its own. Under the same
  // property lock as issue / rectify: mark the invoice cancelled, then let
  // prepareVerifactuAnulacion (verifactu-submission.service, the one
  // implementation of the anulación huella rule — FechaHoraHusoGenRegistro =
  // cancelledAt, previous = chain tail at that instant, NIF snapshot of the
  // invoice) compute and persist Invoice.cancellationHash inside the SAME
  // transaction, so the cancel and its huella commit together and the send
  // path reuses the stored hash instead of recomputing a different one.
  // Finanzas (2026-09-15): the same transaction unlinks the payments, writes
  // the counter-rows of the libro de emitidas and posts the inverse entry of
  // the issuance entry (canonical rule «Anulación: inverso total»).
  const cancelled = await prisma.$transaction(async (tx) => {
    await lockVerifactuChain(tx, existing.propertyId);
    const fresh = await tx.invoice.findUnique({ where: { id: existing.id }, select: { status: true } });
    if (!fresh || fresh.status !== "issued") throw new ConflictError("Solo las facturas emitidas admiten anulación.");
    const cancelledAt = new Date();
    // Tanda 8a: the canceller is recorded next to the issuer (SoD trace).
    await tx.invoice.update({ where: { id: existing.id }, data: { status: "cancelled", cancelledAt, cancelledByUserId: input.context.userId } });
    const prepared = exclusion ? null : await prepareVerifactuAnulacion(tx, existing.id);
    if (!exclusion && !prepared) {
      throw new ConflictError("No se pudo generar el registro de anulación VeriFactu de la factura; revisa que esté emitida con número y huella.");
    }

    // Payments never stay attached to a cancelled document: they go back to
    // the folio (visible in its balance) so they can be reassigned or refunded.
    const linked = await tx.payment.findMany({ where: { invoiceId: existing.id, deletedAt: null }, select: { id: true, status: true } });
    if (linked.length > 0) {
      await tx.payment.updateMany({ where: { invoiceId: existing.id, deletedAt: null }, data: { invoiceId: null } });
    }
    await tx.invoice.update({ where: { id: existing.id }, data: { paidAt: null } });

    const snapshot = parseInvoiceSnapshot(existing.snapshotJson);
    const breakdown = snapshot ? snapshot.taxBreakdown : parseTaxBreakdown(existing.taxBreakdownJson);
    await writeIssuedVatBookRows(tx, {
      organizationId: input.context.organizationId,
      propertyId: existing.propertyId,
      // Corrector L3 (FC-7): same sourceType the rebuild derives (`invoiceSourceType`):
      // a rectificativa keeps `rectification` when it is issued or cancelled.
      sourceType: invoiceSourceType({ invoiceType: existing.invoiceType, rectifyingForId: existing.rectifyingForId ?? null, simplified: existing.simplified ?? existing.invoiceType === "F2" }) as "invoice" | "rectification" | "simplified",
      sourceId: `${existing.id}#anulacion`,
      date: cancelledAt,
      series: existing.seriesCode ?? seriesForInvoiceType(existing.invoiceType),
      number: invoiceNumber,
      counterpartyNif: normalizeTaxId(existing.customerTaxId),
      counterpartyName: existing.customerName,
      rows: buildVatBookRows(breakdown),
      negate: true
    });

    const reversal = await getLedgerPort().reverseJournalEntry(
      {
        organizationId: input.context.organizationId,
        propertyId: existing.propertyId,
        original: { sourceType: "invoice", sourceId: existing.id },
        sourceType: "invoice_cancellation",
        sourceId: existing.id,
        entryDate: cancelledAt,
        description: `Anulación factura ${invoiceNumber} · ${input.reason}`,
        reference: invoiceNumber,
        createdBy: input.context.userId
      },
      tx
    );
    return {
      hash: prepared?.hash ?? null,
      canonical: prepared?.canonical ?? null,
      cancelledAt,
      previous: prepared?.previous ?? null,
      emitterTaxId: prepared?.emitterTaxId ?? existing.issuerTaxId ?? null,
      unlinkedPaymentIds: linked.map((p) => p.id),
      capturedPaymentIds: linked.filter((p) => p.status === "captured").map((p) => p.id),
      reversal
    };
  });

  // Optional refunds run AFTER the commit through the payments service (each
  // one is its own transaction, idempotent by clientRequestId): a refund that
  // fails never un-cancels the invoice, it is reported and can be retried.
  const refundedPaymentIds: string[] = [];
  if (input.refundPayments && cancelled.capturedPaymentIds.length > 0) {
    const { refundFolioPayment } = await import("../payments/payments.service.js");
    for (const paymentId of cancelled.capturedPaymentIds) {
      try {
        const refunded = await refundFolioPayment({
          context: input.context,
          paymentId,
          reason: `Anulación de la factura ${invoiceNumber}: ${input.reason}`,
          clientRequestId: `invoice-cancel:${existing.id}:${paymentId}`,
          correlationId: input.correlationId
        });
        refundedPaymentIds.push(refunded.reversal.id);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[invoice.cancel] corr=${input.correlationId} invoice=${existing.id} payment=${paymentId}: refund failed: ${message}`);
        recordAuditEvent({
          organizationId: input.context.organizationId,
          propertyId: existing.propertyId,
          actorUserId: input.context.userId,
          actorType: "system",
          action: "INVOICE_CANCELLATION_REFUND_FAILED",
          entityType: "payment",
          entityId: paymentId,
          afterJson: { invoiceId: existing.id, invoiceNumber, error: message },
          correlationId: input.correlationId
        });
      }
    }
  }

  const after = await loadInvoice(existing.id);
  const emitterTaxId = cancelled.emitterTaxId;
  const previousFields = {
    previousInvoiceNumber: cancelled.previous?.invoiceNumber ?? null,
    previousEmitterTaxId: cancelled.previous?.emitterTaxId ?? null,
    previousInvoiceHash: cancelled.previous?.hash ?? null
  };
  let folioBalanceDue: number | null = null;
  if (existing.folioId) {
    const { getFolioBalance } = await import("../folio/folio.service.js");
    folioBalanceDue = (await getFolioBalance(existing.folioId)).balanceDue;
  }
  const cancellation: InvoiceCancellationPayments = {
    unlinkedPaymentIds: cancelled.unlinkedPaymentIds,
    refundedPaymentIds,
    folioId: existing.folioId ?? null,
    folioBalanceDue
  };

  if (cancelled.reversal.status === "no_original") {
    // Legacy invoice issued before issuance posted an entry: there is nothing
    // to reverse and nothing is invented (the old code posted a blind reversal
    // that left the ledger negative).
    recordAuditEvent({
      organizationId: input.context.organizationId,
      propertyId: existing.propertyId,
      actorUserId: input.context.userId,
      actorType: "system",
      action: "INVOICE_CANCELLATION_WITHOUT_ISSUE_ENTRY",
      entityType: "invoice",
      entityId: existing.id,
      afterJson: { invoiceNumber, note: "La factura no tenía asiento de emisión: no se genera asiento de anulación." },
      correlationId: input.correlationId
    });
  }

  recordAuditEvent({
    organizationId: input.context.organizationId,
    propertyId: existing.propertyId,
    actorUserId: input.context.userId,
    actorType: "user",
    action: "INVOICE_CANCELLED",
    entityType: "invoice",
    entityId: existing.id,
    beforeJson: before,
    afterJson: {
      ...after,
      reason: input.reason,
      cancellationHash: cancelled.hash,
      cancellationHashCanonical: cancelled.canonical,
      cancellationEmitterTaxId: emitterTaxId,
      journalEntryId: cancelled.reversal.journalEntryId,
      cancellation,
      ...previousFields,
      cancelledByUserId: input.context.userId,
      ...sodAuditFields(cancelGate.sod),
      authorization: { mode: cancelGate.outcome.mode, tier: cancelGate.outcome.tier, requestId: cancelGate.outcome.requestId ?? null, supervisorAuthorizationId: cancelGate.outcome.supervisorAuthorizationId ?? null }
    },
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
      taxTotal: before.taxTotal,
      cancellationHash: cancelled.hash,
      cancelledAt: cancelled.cancelledAt.toISOString(),
      unlinkedPaymentIds: cancellation.unlinkedPaymentIds,
      refundedPaymentIds,
      ...previousFields
    },
    actorType: "user",
    actorUserId: input.context.userId,
    correlationId: input.correlationId
  });

  // RegistroAnulacion goes to AEAT after the commit, through the VeriFactu
  // queue (contract E), which sends it after the alta of the same invoice —
  // a pending alta is never abandoned because the invoice was cancelled. The
  // cancellation itself is already committed: a queue failure is logged with
  // correlation (QC-06) and recovered by the submission sweep. A document of a
  // SII sociedad has no record to cancel: audited, never queued (R7/R8).
  if (exclusion) {
    recordVerifactuExclusionAudit({ context: input.context, invoice: after, exclusion, correlationId: input.correlationId, action: "INVOICE_CANCELLED" });
    return { ...after, cancellation };
  }
  try {
    await queueVerifactuAnulacion(existing.id);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(
      `[invoice.cancel] corr=${input.correlationId} invoice=${existing.id} (${invoiceNumber}): could not queue the VeriFactu anulación: ${message}`
    );
    recordAuditEvent({
      organizationId: input.context.organizationId,
      propertyId: existing.propertyId,
      actorUserId: input.context.userId,
      actorType: "system",
      action: "VERIFACTU_ANULACION_QUEUE_FAILED",
      entityType: "invoice",
      entityId: existing.id,
      afterJson: { invoiceNumber, cancellationHash: cancelled.hash, error: message },
      correlationId: input.correlationId
    });
  }

  return { ...after, cancellation };
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
 * A line of a substitute invoice (TipoRectificativa "S"): gross unit price,
 * tax resolved from the catalogue by category (default accommodation, as the
 * manual draft's summary line) or by folio line type.
 */
export type RectifyingSubstituteLine = {
  description: string;
  quantity: number;
  /** Gross unit price (tax included), like folio lines. */
  unitPrice: number;
  lineType?: string;
  taxCategory?: string | null;
};

/** Folio / payment side effects of a rectificativa (finanzas 2026-09-15). */
export type RectifyInvoiceResult = InvoiceRecord & {
  rectification: {
    idempotent: boolean;
    /** Amount reflected on the folio as an invoice_adjustment line (0 = none). */
    folioDelta: number;
    folioAdjustmentLineId: string | null;
    relinkedPaymentIds: string[];
    unlinkedPaymentIds: string[];
    journalEntryId: string | null;
  };
};

const DEFAULT_SUBSTITUTE_LINE_TYPE = "room";
const DEFAULT_SUBSTITUTE_CATEGORY = "accommodation";

/**
 * Lines of a rectificativa por diferencias ("I"): the full reversal negates
 * every original line; adjustments produce deltas. Prices are GROSS (folio
 * convention): delta = round(newQty × newUnitPrice) − round(origQty ×
 * origUnitPrice) — no tax added on top (the pre-Tanda-3 version treated
 * unitPrice as net and inflated the delta by the rate). Tax identity is
 * copied from the original line so the desglose mirrors it. Pure.
 */
export function buildDifferenceLines(
  originalLines: Array<InvoiceLineTaxFields & { id: string; description: string; quantity: number; unitPrice: number; total: number }>,
  adjustments: RectifyingLineAdjustment[] | undefined,
  fullReversal: boolean
): InvoiceLineData[] {
  const copyTax = (line: InvoiceLineTaxFields) => {
    const identity = lineTaxIdentity(line);
    return {
      taxCode: line.taxCode,
      taxRate: line.taxRate,
      taxCategory: line.taxCategory ?? null,
      taxCalificacion: line.taxCalificacion ?? identity.calificacion,
      taxFigure: line.taxFigure ?? (identity.unknown ? null : identity.figure)
    };
  };
  const lines: InvoiceLineData[] = [];
  if (fullReversal || !adjustments || adjustments.length === 0) {
    for (const line of originalLines) {
      lines.push({
        description: `Reversión: ${line.description}`,
        quantity: roundMoney(-line.quantity),
        unitPrice: line.unitPrice,
        total: roundMoney(-line.total),
        ...copyTax(line)
      });
    }
    return lines;
  }
  const adjustmentMap = new Map(adjustments.map((a) => [a.lineId, a]));
  for (const line of originalLines) {
    const adj = adjustmentMap.get(line.id);
    if (!adj) continue;
    const newQty = adj.quantity ?? line.quantity;
    const newUnitPrice = adj.unitPrice ?? line.unitPrice;
    const origGross = roundMoney(line.quantity * line.unitPrice);
    const newGross = roundMoney(newQty * newUnitPrice);
    const deltaTotal = roundMoney(newGross - origGross);
    if (deltaTotal === 0) continue;
    lines.push({
      description: `Rectificación: ${line.description}`,
      quantity: roundMoney(newQty - line.quantity),
      unitPrice: newUnitPrice,
      total: deltaTotal,
      ...copyTax(line)
    });
  }
  if (lines.length === 0) {
    throw new BadRequestError("lineAdjustments no produce ningún cambio neto; no hay nada que rectificar.");
  }
  return lines;
}

/**
 * Create a *factura rectificativa* (RD 1496/2003 art. 13–15, RD 87/2005).
 *
 * - The original invoice must be in `issued` status (cannot rectify a draft,
 *   an already-rectified invoice, or a cancelled invoice).
 * - The new invoice carries `invoiceType` set to the rectifying reason code
 *   (R1..R5), which is what VeriFactu / AEAT consume as `TipoFactura`.
 * - `rectificationType` "I" (por diferencias, default): `fullReversal` copies
 *   every original line negated (credit-note style); `lineAdjustments`
 *   produces gross delta lines = round(new qty × unitPrice) − round(orig qty ×
 *   unitPrice). Tax identity is copied from the original, so a reversal of an
 *   invoice issued without tax is always possible (it is the correction path).
 * - `rectificationType` "S" (sustitución): the caller supplies the COMPLETE
 *   substitute invoice in `substituteLines`; each line resolves its tax from
 *   the catalogue and the readiness policy applies as for a new invoice.
 * - Totals and desglose come from computeInvoiceTotals (contract B) and are
 *   persisted in taxBreakdownJson; rectificationType is persisted for the XML.
 * - The VeriFactu chain is extended under the property lock: the new record
 *   links to the most recent record (alta or anulación); the number comes
 *   from the REC series of the fiscal year of `issuedAt`.
 * - Idempotent: a second call with the same (originalInvoiceId, reasonCode)
 *   returns the existing rectifying invoice instead of creating a duplicate.
 */
export async function createRectifyingInvoice(input: {
  context: UserContext;
  originalInvoiceId: string;
  reasonCode: RectifyingReasonCode;
  lineAdjustments?: RectifyingLineAdjustment[];
  fullReversal?: boolean;
  rectificationType?: RectificationType;
  substituteLines?: RectifyingSubstituteLine[];
  correlationId: string;
}): Promise<RectifyInvoiceResult> {
  requirePermissions(input.context, ["invoice.issue"]);

  if (!["R1", "R2", "R3", "R4", "R5"].includes(input.reasonCode)) {
    throw new BadRequestError("rectifyingReasonCode debe ser R1, R2, R3, R4 o R5.");
  }
  const rectificationType: RectificationType = input.rectificationType ?? "I";
  if (rectificationType !== "I" && rectificationType !== "S") {
    throw new BadRequestError("rectificationType debe ser «I» (por diferencias) o «S» (sustitución).");
  }
  if (rectificationType === "S" && (!input.substituteLines || input.substituteLines.length === 0)) {
    throw new BadRequestError("Una rectificativa por sustitución («S») requiere la factura sustitutiva completa en substituteLines.");
  }
  if (rectificationType === "I" && input.substituteLines && input.substituteLines.length > 0) {
    throw new BadRequestError("substituteLines solo se admite con rectificationType «S»; para diferencias usa lineAdjustments o fullReversal.");
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
  if (duplicate) return { ...(await loadInvoice(duplicate.id)), rectification: { idempotent: true, folioDelta: 0, folioAdjustmentLineId: null, relinkedPaymentIds: [], unlinkedPaymentIds: [], journalEntryId: null } };

  const originalLines = await prisma.invoiceLine.findMany({ where: { invoiceId: original.id } });
  if (originalLines.length === 0) {
    throw new ConflictError("La factura original no tiene líneas que rectificar.");
  }

  const profile = await getPropertyTaxProfile(original.propertyId);
  const taxContext = taxContextFromProfile(profile);
  const fiscalMode = resolveFiscalMode();

  let rectLines: InvoiceLineData[];
  let warnings: string[];
  if (rectificationType === "S") {
    const resolvedLines: ResolvedInvoiceLine[] = [];
    rectLines = [];
    for (const [index, line] of (input.substituteLines ?? []).entries()) {
      const description = line.description?.trim();
      if (!description) throw new BadRequestError(`La línea ${index + 1} de la factura sustitutiva no tiene descripción.`);
      if (!Number.isFinite(line.quantity) || line.quantity <= 0) {
        throw new BadRequestError(`La línea ${index + 1} de la factura sustitutiva debe tener una cantidad positiva.`);
      }
      if (!Number.isFinite(line.unitPrice)) throw new BadRequestError(`La línea ${index + 1} de la factura sustitutiva no tiene un precio válido.`);
      const quantity = roundMoney(line.quantity);
      const unitPrice = roundMoney(line.unitPrice);
      const lineType = line.lineType?.trim() || DEFAULT_SUBSTITUTE_LINE_TYPE;
      const resolved = await resolveTaxRate({
        propertyId: original.propertyId,
        lineType,
        taxCategory: line.taxCategory ?? (line.lineType ? null : DEFAULT_SUBSTITUTE_CATEGORY)
      });
      const built = lineFromResolvedRate({ lineType, description, quantity, unitPrice, total: roundMoney(quantity * unitPrice), resolved });
      rectLines.push(built.data);
      resolvedLines.push(built.resolvedLine);
    }
    warnings = invoiceTaxWarnings(resolvedLines, taxContext);
    // A substitute invoice is a new fiscal document: same readiness policy as issueInvoice.
    const readiness = evaluateTaxReadiness(rectLines.map((l) => ({ ...l })), taxContext);
    if (!readiness.ok && fiscalMode === "production") throw taxNotConfiguredError(readiness);
    if (!readiness.ok) warnings.push(...readiness.blocking.map((problem) => `Emitida en sandbox con impuestos sin configurar: ${problem}`));
  } else {
    rectLines = buildDifferenceLines(
      originalLines.map((l) => ({
        id: l.id,
        description: l.description,
        quantity: dec(l.quantity),
        unitPrice: dec(l.unitPrice),
        total: dec(l.total),
        taxCode: l.taxCode,
        taxRate: dec(l.taxRate),
        taxCategory: l.taxCategory,
        taxCalificacion: l.taxCalificacion,
        taxFigure: l.taxFigure
      })),
      input.lineAdjustments,
      !!input.fullReversal
    );
    // Differences mirror the original's tax identity: never blocked (it is the
    // correction path for invoices issued without tax), but the problems the
    // original carried are made visible on the rectificativa.
    const readiness = evaluateTaxReadiness(rectLines.map((l) => ({ ...l })), taxContext);
    warnings = uniqueStrings([
      ...parseInvoiceWarnings(original.warningsJson),
      ...readiness.warnings,
      ...readiness.blocking.map((problem) => `Rectificativa por diferencias que hereda un problema fiscal de la factura original: ${problem}`)
    ]);
  }
  warnings = uniqueStrings(warnings);

  const totals = totalsForInvoiceLines(rectLines);
  const total = totals.total;
  const taxTotal = totals.taxTotal;

  // FISC-03: the rectificativa is a new fiscal record, so it takes the CURRENT
  // issuer identity (same 409 / placeholder policy as issueInvoice). The
  // reference to the rectified invoice keeps that invoice's own snapshot
  // (verifactu-submission reads it from the original row).
  const issuer = await requireIssuerIdentity(original.propertyId);
  const emitterTaxId = issuer.taxId;
  // R7 / R8 (t6b#2): no VeriFactu record for a sociedad in the SII.
  const exclusion = issuer.verifactuExclusion;
  if (exclusion) warnings = uniqueStrings([...warnings, verifactuExclusionWarning(exclusion)]);

  // Folio reflection of the rectificativa (finanzas 2026-09-15):
  //   · "I" with line adjustments → an `invoice_adjustment` folio line for the
  //     delta (credit when negative), so the guest's balance follows the
  //     corrected charges and a refund is due when it goes negative — visible,
  //     never hidden; the payments stay on the rectified original;
  //   · "S" (substitute) → the delta between substitute and original, and the
  //     original's payments are relinked to the substitute (it is the live
  //     document for the same charges);
  //   · "I" full reversal (credit note) → no folio line: the charges are
  //     un-invoiced (findBlockingFolioInvoice) and re-invoiced by the next
  //     invoice; the original's payments are unlinked so the next invoice can
  //     take them.
  const fullReversal = rectificationType === "I" && (!!input.fullReversal || !input.lineAdjustments || input.lineAdjustments.length === 0);
  const folioDelta = rectificationType === "S" ? round(total - dec(original.total)) : fullReversal ? 0 : total;

  const created = await prisma.$transaction(async (tx) => {
    const chain = await lockVerifactuChain(tx, original.propertyId);
    const fresh = await tx.invoice.findUnique({ where: { id: original.id }, select: { status: true } });
    if (!fresh || fresh.status !== "issued") throw new ConflictError("Solo las facturas emitidas admiten rectificación.");
    const issuedAt = new Date();
    const allocated = await allocateInvoiceNumber(tx, { propertyId: original.propertyId, series: "REC", issuedAt });
    const invoiceNumber = allocated.invoiceNumber;
    await assertInvoiceNumberFreeInEntity(tx, allocated.scope, invoiceNumber);
    const documentWarnings = uniqueStrings([...warnings, ...allocated.warnings]);
    const seriesIssuer = await findSeriesIssuerTaxId(tx, original.propertyId, allocated.prefix);
    if (seriesIssuer && seriesIssuer.taxId !== emitterTaxId) {
      throw issuerSeriesMismatchError({ series: "REC", year: allocated.year, prefix: allocated.prefix, seriesTaxId: seriesIssuer.taxId, currentTaxId: emitterTaxId, lastInvoiceNumber: seriesIssuer.invoiceNumber });
    }

    // Hash chain: link to the most recent record (alta or anulación) of the
    // installation — none for a sociedad outside the RRSIF (SII).
    const previous = exclusion ? null : await findPreviousChainLink(tx, chain);
    const record = exclusion
      ? null
      : computeVerifactuHash({
          emitterTaxId,
          invoiceNumber,
          issuedAt: issuedAt.toISOString(),
          invoiceType: input.reasonCode as VerifactuInvoiceType,
          vatTotal: taxTotal,
          invoiceTotal: total,
          previousHash: previous?.hash ?? null
        });
    const qrUrl = exclusion
      ? null
      : buildVerifactuQrUrl({
          emitterTaxId,
          invoiceNumber,
          issuedAt: issuedAt.toISOString(),
          invoiceTotal: total,
          preProduction: issuer.fiscalMode !== "production"
        });

    const snapshot = buildInvoiceSnapshot({
      issuedAt,
      currencyCode: original.currencyCode ?? "EUR",
      lines: rectLines.map((l) => ({ ...l, folioLineId: null })),
      totals: { total, taxTotal },
      breakdown: totals.breakdown,
      folioLineIds: [],
      issuer: { taxId: emitterTaxId, legalName: issuer.legalName },
      customer: { type: original.customerType, taxId: normalizeTaxId(original.customerTaxId), name: original.customerName }
    });

    const invoice = await tx.invoice.create({
      data: {
        propertyId: original.propertyId,
        invoiceNumber,
        invoiceType: input.reasonCode,
        customerType: original.customerType,
        customerTaxId: original.customerTaxId,
        // Same recipient as the rectified invoice (Destinatarios of the R* registro).
        customerName: original.customerName,
        currencyCode: original.currencyCode,
        status: "issued",
        issuedAt,
        // Tanda 8a (SoD): the rectifying document has its own issuer.
        issuedByUserId: input.context.userId,
        total,
        taxTotal,
        taxBreakdownJson: breakdownJson(totals.breakdown),
        warningsJson: documentWarnings,
        rectifyingForId: original.id,
        rectifyingReasonCode: input.reasonCode,
        rectificationType,
        verifactuHash: record?.hash ?? null,
        previousInvoiceHash: previous?.hash ?? null,
        qrPayload: qrUrl,
        // Same folio / reservation as the original so payments and reports
        // can follow the chain.
        folioId: original.folioId,
        reservationId: original.reservationId,
        issuerTaxId: emitterTaxId,
        issuerLegalName: issuer.legalName,
        issuerTaxIdPlaceholder: issuer.placeholder,
        snapshotJson: { ...snapshot, ...structureSnapshot(issuer, chain) } as unknown as Prisma.InputJsonValue,
        legalEntityId: chain.legalEntityId ?? issuer.legalEntityId,
        installationId: exclusion ? null : chain.installation?.id ?? null,
        seriesCode: "REC",
        simplified: false,
        customerRequired: true
      }
    });

    for (const l of rectLines) {
      await tx.invoiceLine.create({ data: { invoiceId: invoice.id, ...l } });
    }

    // Mark the original as rectified.
    await tx.invoice.update({
      where: { id: original.id },
      data: { status: "rectified" }
    });

    // Libro de emitidas: negative rows on a credit rectificativa, deltas otherwise.
    await writeIssuedVatBookRows(tx, {
      organizationId: input.context.organizationId,
      propertyId: original.propertyId,
      sourceType: "rectification",
      sourceId: invoice.id,
      date: issuedAt,
      series: "REC",
      number: invoiceNumber,
      counterpartyNif: snapshot.customer.taxId,
      counterpartyName: original.customerName,
      rows: buildVatBookRows(snapshot.taxBreakdown)
    });

    // A substitute invoice ("S") replaces the original document entirely: the
    // original's issue entry is reversed and its VAT rows countered, then the
    // substitute posts its own full lines (no double revenue).
    if (rectificationType === "S") {
      const originalSnapshot = parseInvoiceSnapshot(original.snapshotJson);
      await writeIssuedVatBookRows(tx, {
        organizationId: input.context.organizationId,
        propertyId: original.propertyId,
        // Corrector L3 (FC-7): same sourceType the rebuild derives for the original (`invoiceSourceType`).
        sourceType: invoiceSourceType({ invoiceType: original.invoiceType, rectifyingForId: original.rectifyingForId ?? null, simplified: original.simplified ?? original.invoiceType === "F2" }) as "invoice" | "rectification" | "simplified",
        sourceId: `${original.id}#sustituida`,
        date: issuedAt,
        series: original.seriesCode ?? seriesForInvoiceType(original.invoiceType),
        number: original.invoiceNumber,
        counterpartyNif: normalizeTaxId(original.customerTaxId),
        counterpartyName: original.customerName,
        rows: buildVatBookRows(originalSnapshot ? originalSnapshot.taxBreakdown : parseTaxBreakdown(original.taxBreakdownJson)),
        negate: true
      });
      await getLedgerPort().reverseJournalEntry(
        {
          organizationId: input.context.organizationId,
          propertyId: original.propertyId,
          original: { sourceType: "invoice", sourceId: original.id },
          // Same key the accounting projection uses for a superseded invoice.
          sourceType: "invoice_rectification",
          sourceId: `${invoice.id}:supersedes:${original.id}`,
          entryDate: issuedAt,
          description: `Reversión factura ${original.invoiceNumber ?? original.id} sustituida por ${invoiceNumber}`,
          reference: original.invoiceNumber,
          createdBy: input.context.userId
        },
        tx
      );
    }

    // Canonical rule «Rectificativa»: the same lines in the opposite direction
    // (negative amounts flip the side), proportional to the rectified amounts;
    // a substitute posts its full lines after the original was reversed above.
    const posted = await getLedgerPort().postJournalEntry(
      {
        organizationId: input.context.organizationId,
        propertyId: original.propertyId,
        sourceType: "invoice_rectification",
        sourceId: invoice.id,
        entryDate: issuedAt,
        description: `Rectificativa ${invoiceNumber} (${input.reasonCode}) de ${original.invoiceNumber ?? original.id}`,
        reference: invoiceNumber,
        createdBy: input.context.userId,
        currencyCode: original.currencyCode ?? "EUR",
        lines: buildInvoiceJournalLines(snapshot, invoiceNumber)
      },
      tx
    );

    // Folio reflection + payment linkage (see the note above the transaction).
    let folioAdjustmentLineId: string | null = null;
    let relinkedPaymentIds: string[] = [];
    let unlinkedPaymentIds: string[] = [];
    if (original.folioId) {
      if (folioDelta !== 0) {
        const line = await tx.folioLine.create({
          data: {
            folioId: original.folioId,
            type: "invoice_adjustment",
            description: `${folioDelta < 0 ? "Abono" : "Cargo"} por factura rectificativa ${invoiceNumber} (rectifica ${original.invoiceNumber ?? original.id})`,
            quantity: 1,
            unitPrice: folioDelta,
            total: folioDelta,
            taxCode: null,
            taxCategory: null,
            postedBy: input.context.userId
          }
        });
        folioAdjustmentLineId = line.id;
      }
      const linked = await tx.payment.findMany({ where: { invoiceId: original.id, deletedAt: null }, select: { id: true } });
      if (linked.length > 0 && rectificationType === "S") {
        await tx.payment.updateMany({ where: { invoiceId: original.id, deletedAt: null }, data: { invoiceId: invoice.id } });
        relinkedPaymentIds = linked.map((p) => p.id);
      } else if (linked.length > 0 && fullReversal) {
        await tx.payment.updateMany({ where: { invoiceId: original.id, deletedAt: null }, data: { invoiceId: null } });
        unlinkedPaymentIds = linked.map((p) => p.id);
      }
    }

    return { invoice, canonical: record?.canonical ?? null, hash: record?.hash ?? null, previous, year: allocated.year, sequenceId: allocated.sequenceId, journalEntryId: posted.journalEntryId, folioAdjustmentLineId, relinkedPaymentIds, unlinkedPaymentIds, chain, allocated, documentWarnings };
  });

  const after = await loadInvoice(created.invoice.id);
  const previousFields = previousLinkFields(created.previous);

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
      rectificationType,
      invoiceNumber: after.invoiceNumber,
      series: "REC",
      sequenceYear: created.year,
      sequenceId: created.sequenceId,
      verifactuHash: after.verifactuHash,
      ...previousFields,
      total: after.total,
      taxTotal: after.taxTotal,
      taxBreakdown: after.taxBreakdown,
      fullReversal,
      hashCanonical: created.canonical,
      issuerTaxId: emitterTaxId,
      issuerLegalName: issuer.legalName,
      issuerTaxIdPlaceholder: issuer.placeholder,
      legalEntityId: created.chain.legalEntityId ?? issuer.legalEntityId,
      installationId: exclusion ? null : created.chain.installation?.id ?? null,
      numeroInstalacion: exclusion ? null : created.chain.installation?.numeroInstalacion ?? null,
      chainScope: created.chain.policy,
      verifactuExclusion: exclusion,
      establishmentCode: issuer.establishment.code,
      seriesPrefix: created.allocated.prefix,
      seriesOpened: created.allocated.created,
      fiscalMode: issuer.fiscalMode,
      taxWarnings: created.documentWarnings,
      journalEntryId: created.journalEntryId,
      folioDelta,
      folioAdjustmentLineId: created.folioAdjustmentLineId,
      relinkedPaymentIds: created.relinkedPaymentIds,
      unlinkedPaymentIds: created.unlinkedPaymentIds
    },
    correlationId: input.correlationId
  });
  if (exclusion) recordVerifactuExclusionAudit({ context: input.context, invoice: after, exclusion, correlationId: input.correlationId, action: "INVOICE_ISSUED" });

  // Emit InvoiceIssued so VeriFactu submission picks the rectificativa up
  // and propagates it through the same submission pipeline. The payload
  // carries the rectifying linkage so downstream consumers can audit it
  // (no record to queue for a sociedad in the SII: verifactuHash null).
  recordDomainEvent({
    organizationId: input.context.organizationId,
    propertyId: original.propertyId,
    entityType: "invoice",
    entityId: after.id,
    eventType: "InvoiceIssued",
    payload: {
      invoiceNumber: after.invoiceNumber!,
      verifactuHash: after.verifactuHash ?? null,
      verifactuExclusion: exclusion?.code ?? null,
      total: after.total,
      taxTotal: after.taxTotal,
      rectifyingForId: original.id,
      rectifyingReasonCode: input.reasonCode,
      rectificationType,
      ...previousFields
    },
    actorType: "user",
    actorUserId: input.context.userId,
    correlationId: input.correlationId
  });

  return {
    ...after,
    rectification: {
      idempotent: false,
      folioDelta,
      folioAdjustmentLineId: created.folioAdjustmentLineId,
      relinkedPaymentIds: created.relinkedPaymentIds,
      unlinkedPaymentIds: created.unlinkedPaymentIds,
      journalEntryId: created.journalEntryId
    }
  };
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
