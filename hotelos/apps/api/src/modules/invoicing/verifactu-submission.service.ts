import {
  buildVerifactuRegistroAlta,
  buildVerifactuRegistroAnulacion,
  computeInvoiceTotals,
  computeVerifactuAnulacionHash,
  figureForRegion,
  isTransientVerifactuError,
  isVerifactuSimulatedEndpoint,
  normalizeTaxId,
  normalizeTaxRegion,
  parseTaxBreakdown,
  parseTaxCode,
  resolveVerifactuCredentials,
  resolveVerifactuMode,
  resolveVerifactuSoftware,
  submitVerifactuRegistro,
  sumDesgloseQuotas,
  VERIFACTU_ENDPOINTS,
  VERIFACTU_TRANSIENT_ERROR_CODES,
  type TaxFigure,
  type TaxRegion,
  type TbaiTerritory,
  type VerifactuDesgloseGroup,
  type VerifactuImpuesto,
  type VerifactuInvoiceType,
  type VerifactuPreviousRecord,
  type VerifactuRectificationInput,
  type VerifactuSoftwareBlock,
  type VerifactuSubmissionMode,
  type VerifactuSubmissionResponse
} from "@hotelos/compliance";
import { prisma } from "@hotelos/database";
import type { Prisma } from "@hotelos/database";
import type { EventEnvelope } from "@hotelos/shared";
import { signSubmissionXml } from "../../lib/compliance-signing.js";
import { BadRequestError, ConflictError, NotFoundError } from "../../lib/http-error.js";
import { buildPage, DEFAULT_PAGE_LIMIT, decodeCursor, MAX_PAGE_LIMIT, type Page } from "../../lib/pagination.js";
import { recordAuditEvent } from "../audit/audit.service.js";
import { queueTbaiSubmission } from "./tbai-submission.service.js";
import { issuerForInvoice } from "./issuer-identity.service.js";

// VeriFactu queue (Tanda 3). One row per (invoice, registroType) in
// verifactu_submissions: the RegistroAlta sent at issuance and, when the
// invoice is cancelled, the RegistroAnulacion. The API is the ONLY executor
// (the pg-boss `verifactu.retry` job was removed from apps/worker): live sends
// go through the in-memory `submissionChain`, and `runDueVerifactuRetries`
// (server.ts, every 120 s on the scheduler leader) retries, recovers orphaned
// rows and reconciles invoices that never got a row — under a Postgres
// advisory lock so two replicas can never sweep at once.
//
// Routing: Canarias reports IGIC through VeriFactu (Impuesto 03) like any
// common-territory property; only the foral territories (Bizkaia, Gipuzkoa,
// Araba — Property.fiscalTerritory, legacy Property.taxRegion) go to TicketBAI.

type ChainDb = Pick<Prisma.TransactionClient, "invoice" | "property" | "organization">;
type InvoiceRow = Prisma.InvoiceGetPayload<Record<string, never>>;
type InvoiceLineRow = Prisma.InvoiceLineGetPayload<Record<string, never>>;
type SubmissionRow = Prisma.VerifactuSubmissionGetPayload<Record<string, never>>;

export type VerifactuRegistroType = "alta" | "anulacion";
export type SubmissionRoute = "verifactu" | "tbai";

const ACCEPTED_STATUSES: ReadonlySet<string> = new Set(["accepted", "accepted_with_errors"]);
const TERMINAL_STATUSES: ReadonlySet<string> = new Set(["failed", "abandoned", "rejected"]);
const TBAI_TERRITORIES: ReadonlySet<string> = new Set<TbaiTerritory>(["bizkaia", "gipuzkoa", "araba"]);
const IMPUESTO_BY_FIGURE: Record<TaxFigure, VerifactuImpuesto> = { IVA: "01", IPSI: "02", IGIC: "03" };
// Same key the issuance path must take (see invoice.service.ts): one chain per property.
const CHAIN_LOCK_SUFFIX = ":verifactu-chain";
const SWEEP_LOCK_KEY = "verifactu.sweep";

const RETRY_BATCH_SIZE = 25;
// A row left in "submitting" longer than this was orphaned by a crash between
// the upsert and the AEAT response (the in-memory chain is lost on restart).
const STUCK_SUBMITTING_MS = 15 * 60_000;
const RETRY_BACKOFF_MS = 5 * 60_000;
// Configuration errors (no certificate / software block) are not AEAT
// failures: they wait longer and never exhaust MAX_ATTEMPTS.
const CONFIG_RETRY_BACKOFF_MS = 15 * 60_000;
// After this many attempts a row goes terminal ("failed") instead of being
// retried forever. Overridable per deployment with VERIFACTU_MAX_ATTEMPTS.
const MAX_ATTEMPTS = parseMaxAttempts(process.env.VERIFACTU_MAX_ATTEMPTS);
// Reconciliation (invoices with a huella but no row): no time window — a
// wrap-around cursor over (createdAt, id) scans the whole table a page at a
// time; the freshest invoices are left to the live chain (grace period).
const RECONCILE_GRACE_MS = 5 * 60_000;
const RECONCILE_BATCH_SIZE = 25;
const RECONCILE_SCAN_PAGE_SIZE = 200;
const RECONCILE_SCAN_MAX_PAGES = 10;
// The sweep runs inside one interactive transaction that only holds the
// advisory lock; the work itself uses the shared client. Generous timeout:
// 25 retries + 25 reconciled altas + anulaciones, each capped by the
// submitter's own network timeout.
const SWEEP_TX_TIMEOUT_MS = 30 * 60_000;

function parseMaxAttempts(raw: string | undefined): number {
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 12;
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

export type RoutableProperty = {
  taxRegion: string | null | undefined;
  province?: string | null;
  fiscalTerritory?: string | null;
};

export type SubmissionRouteResolution = {
  route: SubmissionRoute;
  /** Set when route === "tbai". */
  territory: TbaiTerritory | null;
  /** Canonical common-territory region (contract A); null when unknown → treated as ES_PENINSULA_BALEARES. */
  taxRegion: TaxRegion | null;
};

/**
 * Where an invoice of this property is reported. Foral territories come from
 * Property.fiscalTerritory (Tanda 3) with a fallback to the legacy
 * Property.taxRegion values; everything else — Canarias included — is
 * VeriFactu/AEAT with the Impuesto of its canonical region.
 */
export function submissionRouteForProperty(property: RoutableProperty): SubmissionRouteResolution {
  const fiscal = (property.fiscalTerritory ?? "").trim().toLowerCase();
  const legacy = (property.taxRegion ?? "").trim().toLowerCase();
  const territory = TBAI_TERRITORIES.has(fiscal) ? (fiscal as TbaiTerritory) : TBAI_TERRITORIES.has(legacy) ? (legacy as TbaiTerritory) : null;
  if (territory) return { route: "tbai", territory, taxRegion: null };
  return { route: "verifactu", territory: null, taxRegion: normalizeTaxRegion(property.taxRegion, property.province) };
}

/** Legacy helper (string region only) kept for callers that predate fiscalTerritory. */
export function submissionRouteForRegion(region: string | null | undefined): SubmissionRoute {
  return submissionRouteForProperty({ taxRegion: region }).route;
}

// ---------------------------------------------------------------------------
// Queue entry points
// ---------------------------------------------------------------------------

let submissionChain: Promise<void> = Promise.resolve();

function enqueue(label: string, task: () => Promise<void>): Promise<void> {
  submissionChain = submissionChain.then(async () => {
    try {
      await task();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[verifactu] ${label}: ${message}`);
    }
  });
  return submissionChain;
}

/** Resolves when every step queued so far has run (integration tests, graceful shutdown). */
export function flushVerifactuQueue(): Promise<void> {
  return submissionChain;
}

/**
 * Domain-event hook (audit.service recordDomainEvent): InvoiceIssued queues
 * the RegistroAlta, InvoiceCancelled the RegistroAnulacion. Both are
 * idempotent on (invoiceId, registroType), so an explicit
 * queueVerifactuAnulacion() from cancelInvoice plus this hook is harmless.
 */
export function queueVerifactuSubmission(event: EventEnvelope): void {
  if (event.eventType === "InvoiceIssued") {
    void enqueue(`failed to submit invoice ${event.entityId}`, () => routeSubmissionByRegion(event));
    return;
  }
  if (event.eventType === "InvoiceCancelled" && event.entityId) {
    queueVerifactuAnulacion(event.entityId);
  }
}

async function routeSubmissionByRegion(event: EventEnvelope): Promise<void> {
  const invoiceId = event.entityId ?? "";
  if (!invoiceId) return;
  const invoice = await prisma.invoice.findUnique({ where: { id: invoiceId }, select: { propertyId: true } });
  if (!invoice) return;
  const property = await prisma.property.findUnique({
    where: { id: invoice.propertyId },
    select: { taxRegion: true, province: true, fiscalTerritory: true }
  });
  const resolution = submissionRouteForProperty(property ?? { taxRegion: null });
  if (resolution.route === "tbai" && resolution.territory) {
    queueTbaiSubmission(event, resolution.territory);
    return;
  }
  await submitForInvoice(invoiceId, event.organizationId, event.actorUserId);
}

/**
 * Contract E: build, sign and send the RegistroAnulacion of a cancelled
 * invoice. Runs after the alta in the serialized chain; if the alta is still
 * pending it is sent first and the anulación waits (parked as retrying with
 * errorCode ALTA_PENDING) until AEAT accepts it.
 */
export function queueVerifactuAnulacion(invoiceId: string): void {
  void enqueue(`failed to submit anulación for invoice ${invoiceId}`, async () => {
    const invoice = await prisma.invoice.findUnique({ where: { id: invoiceId }, select: { propertyId: true } });
    if (!invoice) return;
    const property = await prisma.property.findUnique({
      where: { id: invoice.propertyId },
      select: { organizationId: true, taxRegion: true, province: true, fiscalTerritory: true }
    });
    if (!property) return;
    if (submissionRouteForProperty(property).route !== "verifactu") {
      // TicketBAI cancellations (anulación TBAI) are a different record; the
      // foral service does not implement them yet — say so instead of
      // silently doing nothing.
      console.warn(`[verifactu] invoice ${invoiceId} is routed to TicketBAI; anulación TBAI is not implemented (no registro sent).`);
      return;
    }
    await submitAnulacionForInvoice(invoiceId, property.organizationId, undefined);
  });
}

// Manual retry (POST /verifactu/submissions/:id/retry). Unlike the sweep it
// also takes terminal rows — "failed" (MAX_ATTEMPTS exhausted), "abandoned",
// AEAT "rejected" — and gives them a fresh budget: attempts back to 0, status
// "retrying" (so a crash before the send is still recovered by the sweep) and
// no scheduled retry. A row whose registro can no longer be sent answers 409
// with the reason instead of being re-queued; an accepted one has nothing to retry.
export async function retryVerifactuSubmission(submissionId: string): Promise<void> {
  const row = await prisma.verifactuSubmission.findUnique({ where: { id: submissionId } });
  if (!row) throw new NotFoundError("Envío VeriFactu no encontrado.");
  if (ACCEPTED_STATUSES.has(row.status)) {
    throw new ConflictError("El envío ya fue aceptado por AEAT; no procede reintentarlo.");
  }
  const invoice = await prisma.invoice.findUnique({
    where: { id: row.invoiceId },
    select: { status: true, verifactuHash: true, invoiceNumber: true, deletedAt: true, cancelledAt: true }
  });
  const reason = unsubmittableReason(invoice, registroTypeOf(row));
  if (reason) throw new ConflictError(`No se puede reintentar el envío: ${reason}.`);

  const property = await prisma.property.findUnique({ where: { id: row.propertyId }, select: { organizationId: true } });
  await prisma.verifactuSubmission.update({
    where: { id: row.id },
    data: { status: "retrying", attempts: 0, nextRetryAt: null }
  });
  void enqueue(`manual retry of submission ${row.id} failed`, async () => {
    try {
      await dispatchRow(row, property?.organizationId ?? "");
    } catch (err) {
      await recordUncountedFailure(row.id, err);
      throw err;
    }
  });
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function registroTypeOf(row: { registroType: string }): VerifactuRegistroType {
  return row.registroType === "anulacion" ? "anulacion" : "alta";
}

// Why a registro can no longer be sent (null when it can). Shared by the live
// path, the manual retry and the sweep so all agree on "submittable". An alta
// stays sendable after the invoice is cancelled or rectified: the chain is
// made of records, not of live invoices, and the anulación needs it.
export function unsubmittableReason(
  invoice: { status: string; verifactuHash: string | null; invoiceNumber: string | null; deletedAt: Date | null; cancelledAt?: Date | null } | null,
  registroType: VerifactuRegistroType = "alta"
): string | null {
  if (!invoice) return "la factura ya no existe";
  if (invoice.deletedAt) return "la factura fue eliminada";
  if (invoice.status === "draft") return "la factura está en borrador, no emitida";
  if (!invoice.verifactuHash) return "la factura no tiene huella VeriFactu";
  if (!invoice.invoiceNumber) return "la factura no tiene número";
  if (registroType === "anulacion" && (invoice.status !== "cancelled" || !invoice.cancelledAt)) {
    return `la factura está en estado '${invoice.status}', no anulada`;
  }
  return null;
}

// Thrown by submit* for a failure after the upsert has already counted the
// attempt: callers log/park it but must not increment `attempts` a second time.
class AttemptAlreadyCountedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AttemptAlreadyCountedError";
  }
}

// After submit* threw for an existing row: a failure before the upsert (XML
// build, signing) has not been counted yet, so count it here with the regular
// backoff — a permanently broken row must still reach MAX_ATTEMPTS instead of
// retrying forever. A failure after the upsert was already counted.
async function recordUncountedFailure(submissionId: string, error: unknown): Promise<void> {
  if (error instanceof AttemptAlreadyCountedError) return;
  const message = error instanceof Error ? error.message : String(error);
  await prisma.verifactuSubmission
    .update({
      where: { id: submissionId },
      data: {
        status: "retrying",
        errorMessage: message,
        attempts: { increment: 1 },
        nextRetryAt: new Date(Date.now() + RETRY_BACKOFF_MS)
      }
    })
    .catch((persistError: unknown) => {
      // QC-06: the row keeps its previous state; say so instead of hiding it.
      const detail = persistError instanceof Error ? persistError.message : String(persistError);
      console.error(`[verifactu.retry] could not record failed attempt on submission ${submissionId}: ${detail}`);
    });
}

// Terminal states are never reselected by the sweep (status filter) and keep
// nextRetryAt null; the operator can still force a manual retry from the UI.
async function markTerminal(id: string, status: "abandoned" | "failed", errorMessage: string, errorCode?: string): Promise<void> {
  try {
    await prisma.verifactuSubmission.update({
      where: { id },
      data: { status, errorMessage, nextRetryAt: null, ...(errorCode ? { errorCode } : {}) }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[verifactu.retry] could not mark submission ${id} as ${status}: ${message}`);
  }
}

async function organizationByProperty(propertyIds: string[]): Promise<Map<string, string>> {
  const properties = await prisma.property.findMany({
    where: { id: { in: Array.from(new Set(propertyIds)) } },
    select: { id: true, organizationId: true }
  });
  return new Map(properties.map((p) => [p.id, p.organizationId]));
}

function isConfigurationError(errorCode: string | null | undefined): boolean {
  return !!errorCode && VERIFACTU_TRANSIENT_ERROR_CODES.includes(errorCode);
}

export type SubmissionOutcomeStatus = "accepted" | "accepted_with_errors" | "rejected" | "retrying";

/**
 * Persisted status for an AEAT/stub response. "rejected" is reserved for real
 * AEAT rejections (error code from the response); transport failures and
 * configuration gaps (NETWORK_*, CERT_NOT_CONFIGURED, SOFTWARE_NOT_CONFIGURED)
 * are retryable and get a backoff.
 */
export function finalStatusForResponse(response: Pick<VerifactuSubmissionResponse, "status" | "errorCode">, now = Date.now()): {
  status: SubmissionOutcomeStatus;
  nextRetryAt: Date | null;
} {
  if (response.status === "accepted") return { status: "accepted", nextRetryAt: null };
  if (response.status === "accepted_with_errors") return { status: "accepted_with_errors", nextRetryAt: null };
  if (response.status === "rejected" && !isTransientVerifactuError(response.errorCode)) return { status: "rejected", nextRetryAt: null };
  const backoff = isConfigurationError(response.errorCode) ? CONFIG_RETRY_BACKOFF_MS : RETRY_BACKOFF_MS;
  return { status: "retrying", nextRetryAt: new Date(now + backoff) };
}

/**
 * The SistemaInformatico block for this send. In sandbox an incomplete block
 * (labelled defaults) is tolerated so the stub pipeline keeps working; in
 * preproduction/production nothing is sent until the operator fixes the
 * environment (SOFTWARE_NOT_CONFIGURED, retried with the config backoff).
 */
function resolveSoftwareForSend(mode: VerifactuSubmissionMode): { software: VerifactuSoftwareBlock; blocking: VerifactuSubmissionResponse | null } {
  const resolution = resolveVerifactuSoftware();
  if (mode !== "sandbox" && !resolution.ok) {
    return {
      software: resolution.software,
      blocking: {
        status: "rejected",
        endpoint: VERIFACTU_ENDPOINTS[mode],
        mode,
        errorCode: "SOFTWARE_NOT_CONFIGURED",
        errorMessage: `Bloque SistemaInformatico incompleto para el modo '${mode}': ${resolution.errors.join(" ")}`
      }
    };
  }
  return { software: resolution.software, blocking: null };
}

/**
 * Desglose of an invoice (contract B): the breakdown persisted at issuance
 * (Invoice.taxBreakdownJson) is the single source; invoices issued before
 * Tanda 3 fall back to a per-line aggregation with the same grouping and
 * rounding, deriving figure/impuesto from the line's taxFigure, its taxCode
 * (ES_IVA_10 / ES_IGIC_7 / ES_IPSI_2 / ES_IVA_N1) or, last, the property's
 * region. Pure apart from its inputs; exported for unit tests.
 */
export function desgloseForInvoice(
  invoice: { taxBreakdownJson: unknown },
  lines: Array<Pick<InvoiceLineRow, "taxCode" | "taxRate" | "total"> & { taxFigure?: string | null; taxCalificacion?: string | null }>,
  taxRegion: TaxRegion | null
): { groups: VerifactuDesgloseGroup[]; source: "breakdown" | "lines" } {
  const persisted = parseTaxBreakdown(invoice.taxBreakdownJson);
  if (persisted.length > 0) return { groups: persisted, source: "breakdown" };
  const regionFigure = figureForRegion(taxRegion ?? "ES_PENINSULA_BALEARES");
  const totals = computeInvoiceTotals(
    lines.map((line) => {
      const parsed = parseTaxCode(line.taxCode);
      const lineFigure = line.taxFigure && line.taxFigure in IMPUESTO_BY_FIGURE ? (line.taxFigure as TaxFigure) : null;
      const figure: TaxFigure = lineFigure ?? (parsed.figure !== "UNKNOWN" ? parsed.figure : regionFigure.figure);
      const calificacion = line.taxCalificacion === "N1" || parsed.calificacion === "N1" ? "N1" : "S1";
      return {
        total: Number(line.total.toString()),
        ratePercent: Number(line.taxRate.toString()),
        figure,
        impuesto: IMPUESTO_BY_FIGURE[figure],
        calificacion
      };
    })
  );
  return { groups: totals.breakdown, source: "lines" };
}

export type VerifactuRecipientResolution = { recipient: { name: string; taxId: string } | null; warning: string | null };

/**
 * Destinatarios/IDDestinatario of an invoice: the recipient snapshot taken at
 * creation (Invoice.customerName) or, for invoices created before the column,
 * `legacyName` resolved from the folio / reservation. The NIF is NEVER used as
 * the name: without a usable name the block is omitted and the send is
 * flagged (AEAT marks an F1 without Destinatarios; a fabricated name would be
 * worse). Anonymous / simplified invoices have no recipient. Pure.
 */
export function resolveVerifactuRecipient(
  invoice: { customerTaxId: string | null; customerName?: string | null },
  legacyName: string | null
): VerifactuRecipientResolution {
  const taxId = normalizeTaxId(invoice.customerTaxId);
  if (!taxId) return { recipient: null, warning: null };
  const name = invoice.customerName?.trim() || legacyName?.trim() || null;
  if (!name || normalizeTaxId(name) === taxId) {
    return {
      recipient: null,
      warning: `Destinatario ${taxId} sin nombre o razón social (customerName vacío y no resoluble desde folio/reserva): se envía sin bloque Destinatarios; AEAT lo marcará en una factura completa. Indica el nombre o razón social del destinatario.`
    };
  }
  return { recipient: { name, taxId }, warning: null };
}

/** Legacy fallback (invoices created before Invoice.customerName): razón social of the reservation for company/agency invoices, else the folio guest's full name. */
async function legacyRecipientName(invoice: InvoiceRow): Promise<string | null> {
  const folio = invoice.folioId
    ? await prisma.folio.findUnique({ where: { id: invoice.folioId }, select: { guestId: true, reservationId: true } })
    : null;
  const reservationId = invoice.reservationId ?? folio?.reservationId ?? null;
  let name: string | null = null;
  if (invoice.customerType !== "guest" && reservationId) {
    const reservation = await prisma.reservation.findUnique({ where: { id: reservationId }, select: { companyName: true } });
    name = reservation?.companyName?.trim() || null;
  }
  if (!name && folio?.guestId) {
    const guest = await prisma.guest.findUnique({ where: { id: folio.guestId }, select: { firstName: true, surname1: true, surname2: true } });
    name = guest ? [guest.firstName, guest.surname1, guest.surname2].filter((part) => !!part && part.trim().length > 0).join(" ").trim() || null : null;
  }
  return name;
}

/** Destinatarios/IDDestinatario for an identified customer (null for anonymous / simplified invoices). */
async function recipientForInvoice(invoice: InvoiceRow): Promise<VerifactuRecipientResolution> {
  if (!normalizeTaxId(invoice.customerTaxId)) return { recipient: null, warning: null };
  const legacyName = invoice.customerName?.trim() ? null : await legacyRecipientName(invoice);
  return resolveVerifactuRecipient(invoice, legacyName);
}

/**
 * The record a huella points at. `previousInvoiceHash` may be an alta
 * (Invoice.verifactuHash) or an anulación (Invoice.cancellationHash): both are
 * links of the same chain. The IDEmisorFactura of the previous record is ITS
 * NIF snapshot, never the current issuer.
 */
async function previousRecordByHash(db: ChainDb, propertyId: string, hash: string | null): Promise<VerifactuPreviousRecord | null> {
  if (!hash) return null;
  const previous = await db.invoice.findFirst({
    where: { propertyId, OR: [{ verifactuHash: hash }, { cancellationHash: hash }] },
    orderBy: [{ issuedAt: "desc" }, { id: "desc" }]
  });
  if (!previous || !previous.invoiceNumber || !previous.issuedAt) return null;
  const issuer = await issuerForInvoice(previous, db);
  return { emitterTaxId: issuer.taxId, invoiceNumber: previous.invoiceNumber, issuedAt: previous.issuedAt.toISOString(), hash };
}

/**
 * Chain-tail rule shared by the anulación path and the legacy reconciliation:
 * between the latest alta and the latest anulación (each already the newest
 * of its kind), the anulación is the tail only when it was generated
 * STRICTLY later; ties and a missing anulación go to the alta. Mirrors
 * pickPreviousChainLink (invoice.service.ts) so both modules compute the same
 * tail for one instant. Pure.
 */
export function chainTailIsAnulacion(altaGeneratedAt: number | null, anulacionGeneratedAt: number | null): boolean {
  if (anulacionGeneratedAt === null) return false;
  if (altaGeneratedAt === null) return true;
  return anulacionGeneratedAt > altaGeneratedAt;
}

/**
 * Chain tail of a property at instant `before`: the latest alta (by issuedAt)
 * or anulación (by cancelledAt) generated up to that instant, excluding the
 * anulación of `excludeInvoiceId` itself. Deterministic, so the anulación's
 * RegistroAnterior is rebuilt identically on every retry.
 */
async function chainTailBefore(db: ChainDb, propertyId: string, before: Date, excludeInvoiceId: string): Promise<VerifactuPreviousRecord | null> {
  const [alta, anulacion] = await Promise.all([
    db.invoice.findFirst({
      where: { propertyId, deletedAt: null, verifactuHash: { not: null }, issuedAt: { lte: before } },
      orderBy: [{ issuedAt: "desc" }, { id: "desc" }]
    }),
    db.invoice.findFirst({
      where: { propertyId, deletedAt: null, cancellationHash: { not: null }, cancelledAt: { lte: before }, id: { not: excludeInvoiceId } },
      orderBy: [{ cancelledAt: "desc" }, { id: "desc" }]
    })
  ]);
  const tail = chainTailIsAnulacion(alta?.issuedAt?.getTime() ?? null, anulacion?.cancelledAt?.getTime() ?? null) ? anulacion : alta;
  if (!tail || !tail.invoiceNumber || !tail.issuedAt) return null;
  const hash = tail === anulacion ? tail.cancellationHash : tail.verifactuHash;
  if (!hash) return null;
  const issuer = await issuerForInvoice(tail, db);
  return { emitterTaxId: issuer.taxId, invoiceNumber: tail.invoiceNumber, issuedAt: tail.issuedAt.toISOString(), hash };
}

export class CancellationHashMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CancellationHashMismatchError";
  }
}

export type PreparedAnulacion = {
  hash: string;
  canonical: string;
  generatedAt: Date;
  previous: VerifactuPreviousRecord | null;
  emitterTaxId: string;
  emitterName: string;
};

/**
 * Compute (once) and persist Invoice.cancellationHash for a cancelled invoice,
 * under the per-property chain lock. Rule: FechaHoraHusoGenRegistro =
 * cancelledAt, previous = chain tail at cancelledAt. Idempotent: a stored hash
 * that matches the rule is reused; one that does not (computed elsewhere with
 * another previous link) is replaced as long as nothing chains onto it,
 * otherwise CancellationHashMismatchError. cancelInvoice may call this inside
 * its own transaction (pass `tx`) so the hash is committed with the cancel.
 */
export async function prepareVerifactuAnulacion(db: Prisma.TransactionClient, invoiceId: string): Promise<PreparedAnulacion | null> {
  const current = await db.invoice.findUnique({ where: { id: invoiceId }, select: { propertyId: true } });
  if (!current) return null;
  await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${current.propertyId + CHAIN_LOCK_SUFFIX}))`;
  const invoice = await db.invoice.findUnique({ where: { id: invoiceId } });
  if (!invoice || !invoice.cancelledAt || !invoice.issuedAt || !invoice.invoiceNumber || !invoice.verifactuHash || invoice.deletedAt) return null;

  const issuer = await issuerForInvoice(invoice, db);
  const previous = await chainTailBefore(db, invoice.propertyId, invoice.cancelledAt, invoice.id);
  const computed = computeVerifactuAnulacionHash({
    emitterTaxId: issuer.taxId,
    invoiceNumber: invoice.invoiceNumber,
    issuedAt: invoice.issuedAt.toISOString(),
    previousHash: previous?.hash ?? null,
    generatedAt: invoice.cancelledAt.toISOString()
  });
  const base = { canonical: computed.canonical, generatedAt: invoice.cancelledAt, previous, emitterTaxId: issuer.taxId, emitterName: issuer.legalName };

  if (invoice.cancellationHash && invoice.cancellationHash !== computed.hash) {
    const linked = await db.invoice.findFirst({
      where: { propertyId: invoice.propertyId, previousInvoiceHash: invoice.cancellationHash },
      select: { id: true, invoiceNumber: true }
    });
    if (linked) {
      throw new CancellationHashMismatchError(
        `La huella de anulación de ${invoice.invoiceNumber} se calculó con un eslabón anterior distinto y ${linked.invoiceNumber ?? linked.id} ya encadena sobre ella; no se puede reconstruir el RegistroAnulacion.`
      );
    }
    console.warn(
      `[verifactu] invoice ${invoice.invoiceNumber}: stored cancellationHash does not follow the chain rule (previous=${previous?.invoiceNumber ?? "none"}); replaced before sending.`
    );
  }
  if (invoice.cancellationHash !== computed.hash) {
    await db.invoice.update({ where: { id: invoice.id }, data: { cancellationHash: computed.hash } });
  }
  return { hash: computed.hash, ...base };
}

async function persistAttempt(
  invoice: { id: string; propertyId: string },
  registroType: VerifactuRegistroType,
  signed: { signedXml: string; signatureMode: string; signedAt: string },
  mode: VerifactuSubmissionMode,
  software: VerifactuSoftwareBlock
): Promise<SubmissionRow> {
  const now = new Date();
  const softwareJson = software as unknown as Prisma.InputJsonValue;
  return prisma.verifactuSubmission.upsert({
    where: { invoiceId_registroType: { invoiceId: invoice.id, registroType } },
    update: {
      status: "submitting",
      xmlPayload: signed.signedXml,
      attempts: { increment: 1 },
      submittedAt: now,
      signatureMode: signed.signatureMode,
      signedAt: new Date(signed.signedAt),
      mode,
      softwareJson
    },
    create: {
      invoiceId: invoice.id,
      propertyId: invoice.propertyId,
      registroType,
      status: "submitting",
      xmlPayload: signed.signedXml,
      attempts: 1,
      submittedAt: now,
      signatureMode: signed.signatureMode,
      signedAt: new Date(signed.signedAt),
      mode,
      softwareJson
    }
  });
}

/**
 * Send a built registro and persist the outcome. From the upsert on the
 * attempt is counted, so every failure is re-thrown as
 * AttemptAlreadyCountedError; a transport failure parks the row with the
 * regular backoff, and a failure of the final update leaves it "submitting"
 * for the sweep's stuck-row path.
 */
async function sendRegistro(input: {
  invoice: InvoiceRow;
  registroType: VerifactuRegistroType;
  xmlPayload: string;
  mode: VerifactuSubmissionMode;
  software: VerifactuSoftwareBlock;
  blocking: VerifactuSubmissionResponse | null;
  emitterTaxId: string;
  organizationId: string;
  actorUserId?: string;
  warnings: string[];
}): Promise<void> {
  const { invoice, registroType } = input;
  const credentials = resolveVerifactuCredentials();
  const signed = await signSubmissionXml({
    xml: input.xmlPayload,
    certPath: credentials.signing?.certPath,
    certPassphrase: credentials.signing?.certPassphrase ?? undefined
  });
  const submission = await persistAttempt(invoice, registroType, signed, input.mode, input.software);

  let response: VerifactuSubmissionResponse | undefined;
  let outcome: ReturnType<typeof finalStatusForResponse> = { status: "retrying", nextRetryAt: null };
  try {
    response =
      input.blocking ??
      (await submitVerifactuRegistro({
        invoiceId: invoice.id,
        invoiceNumber: invoice.invoiceNumber ?? "",
        emitterTaxId: input.emitterTaxId,
        // One CSV per registro (sandbox stub): the anulación never shares the alta's.
        registroType,
        xmlPayload: signed.signedXml,
        transportXml: input.xmlPayload
      }));
    outcome = finalStatusForResponse(response);
    await prisma.verifactuSubmission.update({
      where: { id: submission.id },
      data: {
        status: outcome.status,
        endpoint: response.endpoint,
        mode: response.mode,
        csvCode: response.csvCode ?? null,
        acceptedHash: response.acceptedHash ?? null,
        errorCode: response.errorCode ?? null,
        errorMessage: response.errorMessage ?? null,
        responseAck: response.rawResponse ?? null,
        acknowledgedAt: ACCEPTED_STATUSES.has(outcome.status) ? new Date() : null,
        nextRetryAt: outcome.nextRetryAt
      }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!response) {
      await prisma.verifactuSubmission
        .update({
          where: { id: submission.id },
          data: { status: "retrying", errorMessage: message, nextRetryAt: new Date(Date.now() + RETRY_BACKOFF_MS) }
        })
        .catch((persistError: unknown) => {
          // QC-06: the row stays "submitting" and is rescued by the stuck-row sweep; log it.
          const detail = persistError instanceof Error ? persistError.message : String(persistError);
          console.error(`[verifactu] could not park submission ${submission.id} (invoice ${invoice.id}) as retrying: ${detail}`);
        });
    }
    throw new AttemptAlreadyCountedError(message);
  }

  for (const warning of input.warnings) console.warn(`[verifactu] invoice ${invoice.invoiceNumber} (${registroType}): ${warning}`);
  recordAuditEvent({
    organizationId: input.organizationId,
    propertyId: invoice.propertyId,
    actorUserId: input.actorUserId,
    actorType: "system",
    action: "VERIFACTU_SUBMISSION",
    entityType: "invoice",
    entityId: invoice.id,
    afterJson: {
      submissionId: submission.id,
      registroType,
      mode: response.mode,
      endpoint: response.endpoint,
      simulated: isVerifactuSimulatedEndpoint(response.endpoint),
      status: outcome.status,
      csvCode: response.csvCode,
      errorCode: response.errorCode,
      errorMessage: response.errorMessage,
      software: input.software,
      warnings: input.warnings,
      acknowledgedAt: ACCEPTED_STATUSES.has(outcome.status) ? new Date().toISOString() : undefined
    }
  });
}

// ---------------------------------------------------------------------------
// RegistroAlta
// ---------------------------------------------------------------------------

type SubmitOutcome = "submitted" | "already_accepted" | "not_submittable" | "alta_pending";

// Builds, signs and sends the RegistroAlta for one invoice. Reports what
// happened so the sweep can retire rows it must not retry.
async function submitForInvoice(invoiceId: string, organizationId: string, actorUserId?: string): Promise<SubmitOutcome> {
  if (!invoiceId) return "not_submittable";
  const invoice = await prisma.invoice.findUnique({ where: { id: invoiceId } });
  if (!invoice || !invoice.verifactuHash || !invoice.invoiceNumber || unsubmittableReason(invoice, "alta") !== null) {
    return "not_submittable";
  }
  const existing = await prisma.verifactuSubmission.findUnique({
    where: { invoiceId_registroType: { invoiceId, registroType: "alta" } },
    select: { status: true }
  });
  if (existing && ACCEPTED_STATUSES.has(existing.status)) return "already_accepted";

  const property = await prisma.property.findUnique({
    where: { id: invoice.propertyId },
    select: { taxRegion: true, province: true, fiscalTerritory: true }
  });
  const route = submissionRouteForProperty(property ?? { taxRegion: null });
  const mode = resolveVerifactuMode();
  const { software, blocking } = resolveSoftwareForSend(mode);
  const warnings: string[] = [];

  // FISC-03: the identity the invoice was issued with (snapshot; QR nif= for
  // legacy invoices; live resolver as the last resort). Never a regex over
  // the property name — the huella must be reproducible.
  const issuer = await issuerForInvoice(invoice);
  const lines = await prisma.invoiceLine.findMany({ where: { invoiceId } });
  const desglose = desgloseForInvoice(invoice, lines, route.taxRegion);
  if (desglose.source === "lines") warnings.push("Desglose reconstruido desde las líneas (factura sin taxBreakdownJson).");
  const quotaSum = sumDesgloseQuotas(desglose.groups);
  if (Math.abs(quotaSum - Number(invoice.taxTotal)) > 0.005) {
    warnings.push(`CuotaTotal hasheada (${Number(invoice.taxTotal).toFixed(2)}) difiere de la suma del desglose (${quotaSum.toFixed(2)}).`);
  }
  const previous = await previousRecordByHash(prisma, invoice.propertyId, invoice.previousInvoiceHash);
  if (invoice.previousInvoiceHash && !previous) {
    warnings.push("RegistroAnterior no localizable para previousInvoiceHash; se envía sin el eslabón (AEAT lo marcará).");
  }
  const { recipient, warning: recipientWarning } = await recipientForInvoice(invoice);
  if (recipientWarning) warnings.push(recipientWarning);

  // Rectificativa: TipoRectificativa from Invoice.rectificationType — "I"
  // (por diferencias) by default, which is what createRectifyingInvoice
  // produces (negative / delta lines); "S" only when the invoice was issued
  // as a full substitute, with the ORIGINAL's base/cuota as ImporteRectificacion.
  let rectifiedRef: { invoiceNumber: string | null } | null = null;
  let rectification: VerifactuRectificationInput | undefined;
  if (invoice.rectifyingForId) {
    const rectified = await prisma.invoice.findUnique({ where: { id: invoice.rectifyingForId } });
    rectifiedRef = { invoiceNumber: rectified?.invoiceNumber ?? null };
    if (rectified?.invoiceNumber && rectified.issuedAt) {
      const rectifiedIssuer = await issuerForInvoice(rectified);
      const type = invoice.rectificationType === "S" ? "S" : "I";
      const originalTax = Number(rectified.taxTotal);
      rectification = {
        type,
        rectifiedInvoices: [{ invoiceNumber: rectified.invoiceNumber, issueDate: rectified.issuedAt.toISOString(), emitterTaxId: rectifiedIssuer.taxId }],
        ...(type === "S"
          ? { importeRectificacion: { baseRectificada: Number(rectified.total) - originalTax, cuotaRectificada: originalTax } }
          : {})
      };
    } else {
      warnings.push("Factura rectificada sin número/fecha: se envía sin FacturasRectificadas.");
    }
  }
  const description = rectifiedRef
    ? `Factura rectificativa ${invoice.invoiceNumber} (rectifica ${rectifiedRef.invoiceNumber ?? "—"}, motivo ${invoice.rectifyingReasonCode ?? "R4"})`
    : `Servicios hoteleros ${invoice.invoiceNumber}`;

  const xmlPayload = buildVerifactuRegistroAlta({
    emitterTaxId: issuer.taxId,
    emitterName: issuer.legalName,
    invoiceNumber: invoice.invoiceNumber,
    issuedAt: invoice.issuedAt?.toISOString() ?? new Date().toISOString(),
    invoiceType: (invoice.invoiceType as VerifactuInvoiceType) ?? "F1",
    description,
    invoiceTotal: Number(invoice.total),
    vatTotal: Number(invoice.taxTotal),
    breakdowns: desglose.groups,
    previousHash: invoice.previousInvoiceHash,
    previousInvoiceNumber: previous?.invoiceNumber ?? null,
    previousIssuedAt: previous?.issuedAt ?? null,
    previousEmitterTaxId: previous?.emitterTaxId ?? null,
    currentHash: invoice.verifactuHash,
    rectification,
    recipient,
    software
  });

  await sendRegistro({
    invoice,
    registroType: "alta",
    xmlPayload,
    mode,
    software,
    blocking,
    emitterTaxId: issuer.taxId,
    organizationId,
    actorUserId,
    warnings
  });
  return "submitted";
}

// ---------------------------------------------------------------------------
// RegistroAnulacion
// ---------------------------------------------------------------------------

async function parkAnulacionBehindAlta(invoice: InvoiceRow, altaStatus: string | null): Promise<void> {
  const terminal = altaStatus !== null && TERMINAL_STATUSES.has(altaStatus);
  const message = terminal
    ? `El RegistroAlta de ${invoice.invoiceNumber} terminó en '${altaStatus}'; la anulación no puede enviarse hasta que el alta sea aceptada (reintento manual del alta).`
    : `El RegistroAlta de ${invoice.invoiceNumber} aún no ha sido aceptado por AEAT (${altaStatus ?? "sin envío"}); la anulación se enviará después.`;
  const data = {
    status: terminal ? "failed" : "retrying",
    errorCode: "ALTA_PENDING",
    errorMessage: message,
    nextRetryAt: terminal ? null : new Date(Date.now() + RETRY_BACKOFF_MS)
  };
  await prisma.verifactuSubmission.upsert({
    where: { invoiceId_registroType: { invoiceId: invoice.id, registroType: "anulacion" } },
    update: data,
    create: { invoiceId: invoice.id, propertyId: invoice.propertyId, registroType: "anulacion", attempts: 0, ...data }
  });
}

// Builds, signs and sends the RegistroAnulacion for a cancelled invoice, after
// making sure its alta was accepted (sending it first if needed).
async function submitAnulacionForInvoice(invoiceId: string, organizationId: string, actorUserId?: string): Promise<SubmitOutcome> {
  if (!invoiceId) return "not_submittable";
  const invoice = await prisma.invoice.findUnique({ where: { id: invoiceId } });
  if (!invoice || !invoice.verifactuHash || !invoice.invoiceNumber || !invoice.issuedAt || unsubmittableReason(invoice, "anulacion") !== null) {
    return "not_submittable";
  }
  const existing = await prisma.verifactuSubmission.findUnique({
    where: { invoiceId_registroType: { invoiceId, registroType: "anulacion" } },
    select: { status: true }
  });
  if (existing && ACCEPTED_STATUSES.has(existing.status)) return "already_accepted";

  const altaRow = () =>
    prisma.verifactuSubmission.findUnique({ where: { invoiceId_registroType: { invoiceId, registroType: "alta" } }, select: { status: true } });
  let alta = await altaRow();
  if (!alta || !ACCEPTED_STATUSES.has(alta.status)) {
    // The alta must reach AEAT before its anulación (chain order). Send it
    // now if it is not terminal; the anulación waits otherwise.
    if (!alta || !TERMINAL_STATUSES.has(alta.status)) {
      try {
        await submitForInvoice(invoiceId, organizationId, actorUserId);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[verifactu] alta before anulación of invoice ${invoiceId} failed: ${message}`);
      }
      alta = await altaRow();
    }
    if (!alta || !ACCEPTED_STATUSES.has(alta.status)) {
      await parkAnulacionBehindAlta(invoice, alta?.status ?? null);
      return "alta_pending";
    }
  }

  const mode = resolveVerifactuMode();
  const { software, blocking } = resolveSoftwareForSend(mode);
  let prepared: PreparedAnulacion | null;
  try {
    prepared = await prisma.$transaction((tx) => prepareVerifactuAnulacion(tx, invoiceId));
  } catch (error) {
    if (error instanceof CancellationHashMismatchError) {
      await prisma.verifactuSubmission.upsert({
        where: { invoiceId_registroType: { invoiceId, registroType: "anulacion" } },
        update: { status: "failed", errorCode: "CANCELLATION_HASH_MISMATCH", errorMessage: error.message, nextRetryAt: null },
        create: {
          invoiceId,
          propertyId: invoice.propertyId,
          registroType: "anulacion",
          status: "failed",
          errorCode: "CANCELLATION_HASH_MISMATCH",
          errorMessage: error.message,
          attempts: 0
        }
      });
      console.error(`[verifactu] ${error.message}`);
      return "not_submittable";
    }
    throw error;
  }
  if (!prepared) return "not_submittable";

  const xmlPayload = buildVerifactuRegistroAnulacion({
    emitterTaxId: prepared.emitterTaxId,
    emitterName: prepared.emitterName,
    invoiceNumber: invoice.invoiceNumber,
    issuedAt: invoice.issuedAt.toISOString(),
    previous: prepared.previous,
    currentHash: prepared.hash,
    generatedAt: prepared.generatedAt.toISOString(),
    software
  });

  await sendRegistro({
    invoice,
    registroType: "anulacion",
    xmlPayload,
    mode,
    software,
    blocking,
    emitterTaxId: prepared.emitterTaxId,
    organizationId,
    actorUserId,
    warnings: prepared.previous ? [] : ["RegistroAnulacion enviado como primer registro de la cadena (sin eslabón anterior)."]
  });
  return "submitted";
}

async function dispatchRow(row: Pick<SubmissionRow, "invoiceId" | "registroType">, organizationId: string): Promise<SubmitOutcome> {
  return registroTypeOf(row) === "anulacion"
    ? submitAnulacionForInvoice(row.invoiceId, organizationId, undefined)
    : submitForInvoice(row.invoiceId, organizationId, undefined);
}

// ---------------------------------------------------------------------------
// Sweep (retries + reconciliation)
// ---------------------------------------------------------------------------

let retrySweepInFlight = false;

export type VerifactuRetrySweepResult = {
  due: number;
  // Re-submitted through submit* (whatever AEAT answered).
  retried: number;
  // Threw during re-submission, or went terminal after MAX_ATTEMPTS.
  failed: number;
  // Went terminal because the invoice is gone / not issued / has no hash.
  abandoned: number;
  // Invoices with no submission row that were sent by reconciliation (altas + anulaciones).
  reconciled: number;
  // Invoices cancelled before Tanda 3 (no cancellation_hash) whose anulación
  // huella was chained by reconcileLegacyCancellationHashes this tick.
  legacyChained: number;
  // Another replica holds the sweep lock (or this process is already sweeping).
  skipped: boolean;
};

type DueRow = Pick<SubmissionRow, "id" | "invoiceId" | "propertyId" | "attempts" | "registroType" | "errorCode">;

/**
 * Sweep entry point (server.ts, every 120 s on the scheduler leader):
 *   1. re-submit registros whose nextRetryAt elapsed — including rows parked
 *      as "rejected" with a transient code (CERT_NOT_CONFIGURED,
 *      SOFTWARE_NOT_CONFIGURED, NETWORK_*) — plus rows orphaned mid-send,
 *      retiring poisoned rows and rows past MAX_ATTEMPTS;
 *   2. chain the anulación huella of invoices cancelled before Tanda 3
 *      (cancellation_hash NULL) in cancelled_at order under the chain lock;
 *   3. reconcile invoices that never got their alta / anulación row.
 * Runs under pg_try_advisory_xact_lock(hashtext('verifactu.sweep')) held by
 * one interactive transaction, so a second replica (RUN_SCHEDULERS
 * misconfigured) skips instead of double-sending; the lock is released with
 * the transaction, also when the process dies.
 */
export async function runDueVerifactuRetries(now = new Date()): Promise<VerifactuRetrySweepResult> {
  const result: VerifactuRetrySweepResult = { due: 0, retried: 0, failed: 0, abandoned: 0, reconciled: 0, legacyChained: 0, skipped: false };
  if (retrySweepInFlight) {
    result.skipped = true;
    return result;
  }
  retrySweepInFlight = true;
  try {
    await prisma.$transaction(
      async (tx) => {
        const rows = await tx.$queryRaw<Array<{ locked: boolean }>>`SELECT pg_try_advisory_xact_lock(hashtext(${SWEEP_LOCK_KEY})) AS locked`;
        if (!rows[0]?.locked) {
          result.skipped = true;
          return;
        }
        await retryDueSubmissions(now, result);
        await reconcileLegacyCancellationHashes(now, result);
        await reconcileMissingSubmissions(now, result);
      },
      { timeout: SWEEP_TX_TIMEOUT_MS, maxWait: 5_000 }
    );
    return result;
  } finally {
    retrySweepInFlight = false;
  }
}

async function retryDueSubmissions(now: Date, result: VerifactuRetrySweepResult): Promise<void> {
  const dueWindow = { OR: [{ nextRetryAt: null }, { nextRetryAt: { lte: now } }] };
  const due: DueRow[] = await prisma.verifactuSubmission.findMany({
    where: {
      OR: [
        { AND: [{ status: { in: ["retrying", "network_error"] } }, dueWindow] },
        {
          AND: [
            { status: "rejected" },
            { OR: [{ errorCode: { in: [...VERIFACTU_TRANSIENT_ERROR_CODES, "NETWORK"] } }, { errorCode: { startsWith: "NETWORK_" } }] },
            dueWindow
          ]
        },
        { status: "submitting", updatedAt: { lte: new Date(now.getTime() - STUCK_SUBMITTING_MS) } }
      ]
    },
    select: { id: true, invoiceId: true, propertyId: true, attempts: true, registroType: true, errorCode: true },
    orderBy: { createdAt: "asc" },
    take: RETRY_BATCH_SIZE
  });
  if (due.length === 0) return;
  result.due = due.length;

  // VerifactuSubmission has no Prisma relation to Invoice: a second query
  // decides which rows are still sendable. Rows that are not go terminal here
  // so they stop being reselected (oldest-first selection would otherwise let
  // a handful of poisoned rows starve every newer one).
  const invoices = await prisma.invoice.findMany({
    where: { id: { in: due.map((row) => row.invoiceId) } },
    select: { id: true, status: true, verifactuHash: true, invoiceNumber: true, deletedAt: true, cancelledAt: true }
  });
  const invoiceById = new Map(invoices.map((invoice) => [invoice.id, invoice]));

  const retryable: DueRow[] = [];
  for (const row of due) {
    const reason = unsubmittableReason(invoiceById.get(row.invoiceId) ?? null, registroTypeOf(row));
    if (reason) {
      await markTerminal(row.id, "abandoned", `Envío abandonado: ${reason}.`);
      result.abandoned += 1;
      continue;
    }
    if (row.attempts >= MAX_ATTEMPTS && !isConfigurationError(row.errorCode)) {
      await markTerminal(
        row.id,
        "failed",
        `Máximo de intentos alcanzado (${row.attempts}/${MAX_ATTEMPTS}) sin respuesta aceptada de AEAT. Puede reintentarse manualmente.`
      );
      result.failed += 1;
      continue;
    }
    retryable.push(row);
  }
  if (retryable.length === 0) return;

  const orgByProperty = await organizationByProperty(retryable.map((row) => row.propertyId));
  for (const row of retryable) {
    submissionChain = submissionChain.then(async () => {
      try {
        const outcome = await dispatchRow(row, orgByProperty.get(row.propertyId) ?? "");
        if (outcome === "not_submittable") {
          // The invoice changed between selection and execution: retire the
          // row instead of counting a retry.
          await markTerminal(row.id, "abandoned", "Envío abandonado: la factura dejó de ser enviable antes del reintento.");
          result.abandoned += 1;
          return;
        }
        if (outcome === "submitted") result.retried += 1;
      } catch (error) {
        result.failed += 1;
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[verifactu.retry] submission ${row.id} (${row.registroType}) failed: ${message}`);
        await recordUncountedFailure(row.id, error);
      }
    });
  }
  await submissionChain;
}

// ---------------------------------------------------------------------------
// Legacy cancellations (invoices cancelled before Tanda 3, no cancellation_hash)
// ---------------------------------------------------------------------------

// How many legacy cancellations one sweep tick chains (all properties); the
// rest wait for the next tick. Each one costs the prepareVerifactuAnulacion
// queries inside one transaction per property.
const LEGACY_CANCELLATION_BATCH_SIZE = 50;
const LEGACY_CANCELLATION_TX_TIMEOUT_MS = 60_000;

export type GeneratedRecord = { id: string; generatedAt: Date };

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Chain order of registros: generation instant (issuedAt of an alta,
 * cancelledAt of an anulación), then id as the tie-breaker. Stable copy. Pure.
 */
export function sortByGeneration<T extends GeneratedRecord>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => a.generatedAt.getTime() - b.generatedAt.getTime() || compareIds(a.id, b.id));
}

export type LegacyCancellation = { id: string; propertyId: string; cancelledAt: Date };

/**
 * Legacy cancellations grouped per property, each group in (cancelledAt asc,
 * id asc) order — the order their anulación huellas must be chained in, so
 * every anulación links to the record generated right before it and no two
 * anulaciones share a RegistroAnterior. Groups keep the order of their
 * earliest cancellation. Pure.
 */
export function orderLegacyCancellations<T extends LegacyCancellation>(rows: readonly T[]): Array<{ propertyId: string; rows: T[] }> {
  const sorted = [...rows].sort((a, b) => a.cancelledAt.getTime() - b.cancelledAt.getTime() || compareIds(a.id, b.id));
  const groups = new Map<string, T[]>();
  for (const row of sorted) {
    const group = groups.get(row.propertyId) ?? [];
    group.push(row);
    groups.set(row.propertyId, group);
  }
  return Array.from(groups, ([propertyId, group]) => ({ propertyId, rows: group }));
}

type LegacyCancellationRow = LegacyCancellation & { invoiceNumber: string | null };

/**
 * Invoices cancelled before cancelInvoice computed the anulación huella
 * (status cancelled, cancellation_hash NULL) get it here, BEFORE the
 * reconciliation below sends their RegistroAnulacion: per property, one
 * transaction under the chain advisory lock (the same key issue / rectify /
 * cancel take) walks them in cancelled_at order and lets
 * prepareVerifactuAnulacion chain each onto the latest record — alta or
 * anulación — generated before its cancelledAt, which now includes the
 * legacy anulaciones chained just before it. Processing them by invoice
 * creation order (what the row-less scan does) would let two anulaciones
 * point at the same RegistroAnterior. Invoices that already carry a hash are
 * never touched: what was sent stays as sent.
 */
async function reconcileLegacyCancellationHashes(now: Date, result: VerifactuRetrySweepResult): Promise<void> {
  const graceEnd = new Date(now.getTime() - RECONCILE_GRACE_MS);
  const rows = await prisma.invoice.findMany({
    where: {
      deletedAt: null,
      status: "cancelled",
      cancellationHash: null,
      verifactuHash: { not: null },
      invoiceNumber: { not: null },
      cancelledAt: { not: null, lte: graceEnd }
    },
    select: { id: true, propertyId: true, invoiceNumber: true, cancelledAt: true },
    orderBy: [{ cancelledAt: "asc" }, { id: "asc" }],
    take: LEGACY_CANCELLATION_BATCH_SIZE
  });
  const legacy = rows.filter((row): row is LegacyCancellationRow => row.cancelledAt !== null);
  if (legacy.length === 0) return;

  for (const group of orderLegacyCancellations(legacy)) {
    try {
      const chained = await prisma.$transaction(
        async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${group.propertyId + CHAIN_LOCK_SUFFIX}))`;
          let count = 0;
          for (const row of group.rows) {
            const prepared = await prepareVerifactuAnulacion(tx, row.id);
            if (!prepared) {
              console.warn(`[verifactu.reconcile] legacy cancellation ${row.invoiceNumber ?? row.id}: not chainable (missing number, huella or cancelledAt); skipped.`);
              continue;
            }
            count += 1;
            console.info(
              `[verifactu.reconcile] legacy cancellation ${row.invoiceNumber ?? row.id}: anulación huella chained after ${prepared.previous ? prepared.previous.invoiceNumber : "no previous record"} (cancelledAt=${row.cancelledAt.toISOString()}).`
            );
          }
          return count;
        },
        { timeout: LEGACY_CANCELLATION_TX_TIMEOUT_MS, maxWait: 5_000 }
      );
      result.legacyChained += chained;
    } catch (error) {
      // QC-06: the whole property group rolls back (nothing half-chained) and
      // is retried next tick; count and say why.
      result.failed += 1;
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[verifactu.reconcile] legacy cancellation hashes of property ${group.propertyId} (${group.rows.length} invoices) failed: ${message}`);
    }
  }
}

// Wrap-around scan position over invoices ordered by (createdAt, id). Reset
// to the start when a scan reaches the end, so every invoice — however old —
// is re-checked periodically without a time window.
let reconcileCursor: { createdAt: Date; id: string } | null = null;

/** Test hook: restart the reconciliation scan from the beginning. */
export function resetVerifactuReconcileCursor(): void {
  reconcileCursor = null;
}

// Recovery for the crash windows between issueInvoice()/cancelInvoice() and
// the submission upsert: such invoices carry a huella but have no row and no
// entry in the in-memory chain, so nothing would ever send them. Scan a page
// at a time from the cursor, skip the ones routed to TicketBAI (their own
// table) and (re)submit up to 25 per tick. The unique (invoiceId,
// registroType) keeps this idempotent against the live path; the grace period
// and the in-chain re-check avoid racing it.
async function reconcileMissingSubmissions(now: Date, result: VerifactuRetrySweepResult): Promise<void> {
  const graceEnd = new Date(now.getTime() - RECONCILE_GRACE_MS);
  const propertyCache = new Map<string, { organizationId: string; route: SubmissionRoute }>();
  const missing: Array<GeneratedRecord & { propertyId: string; registroType: VerifactuRegistroType }> = [];

  for (let page = 0; page < RECONCILE_SCAN_MAX_PAGES && missing.length < RECONCILE_BATCH_SIZE; page += 1) {
    const cursor = reconcileCursor;
    const candidates = await prisma.invoice.findMany({
      where: {
        deletedAt: null,
        verifactuHash: { not: null },
        invoiceNumber: { not: null },
        status: { in: ["issued", "cancelled", "rectified"] },
        issuedAt: { lte: graceEnd },
        ...(cursor ? { OR: [{ createdAt: { gt: cursor.createdAt } }, { createdAt: cursor.createdAt, id: { gt: cursor.id } }] } : {})
      },
      select: { id: true, propertyId: true, status: true, issuedAt: true, cancelledAt: true, createdAt: true },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: RECONCILE_SCAN_PAGE_SIZE
    });
    if (candidates.length === 0) {
      reconcileCursor = null;
      break;
    }
    const last = candidates[candidates.length - 1]!;
    reconcileCursor = { createdAt: last.createdAt, id: last.id };

    const unknownPropertyIds = Array.from(new Set(candidates.map((c) => c.propertyId))).filter((id) => !propertyCache.has(id));
    if (unknownPropertyIds.length > 0) {
      const properties = await prisma.property.findMany({
        where: { id: { in: unknownPropertyIds } },
        select: { id: true, organizationId: true, taxRegion: true, province: true, fiscalTerritory: true }
      });
      for (const property of properties) {
        propertyCache.set(property.id, { organizationId: property.organizationId, route: submissionRouteForProperty(property).route });
      }
    }

    const existingRows = await prisma.verifactuSubmission.findMany({
      where: { invoiceId: { in: candidates.map((c) => c.id) } },
      select: { invoiceId: true, registroType: true }
    });
    const covered = new Set(existingRows.map((row) => `${row.invoiceId}:${registroTypeOf(row)}`));
    for (const candidate of candidates) {
      // Unknown property → unroutable; TicketBAI regions live in their own table.
      if (propertyCache.get(candidate.propertyId)?.route !== "verifactu") continue;
      if (!covered.has(`${candidate.id}:alta`)) {
        missing.push({ id: candidate.id, propertyId: candidate.propertyId, registroType: "alta", generatedAt: candidate.issuedAt ?? candidate.createdAt });
      }
      if (candidate.status === "cancelled" && candidate.cancelledAt && candidate.cancelledAt <= graceEnd && !covered.has(`${candidate.id}:anulacion`)) {
        missing.push({ id: candidate.id, propertyId: candidate.propertyId, registroType: "anulacion", generatedAt: candidate.cancelledAt });
      }
      if (missing.length >= RECONCILE_BATCH_SIZE) break;
    }
    if (candidates.length < RECONCILE_SCAN_PAGE_SIZE) {
      reconcileCursor = null;
      break;
    }
  }
  if (missing.length === 0) return;

  // Send in chain order (generation instant, not invoice creation): altas by
  // issuedAt, anulaciones by cancelledAt. The huellas are already fixed
  // (issuance / cancelInvoice / the legacy pass above), so this only keeps
  // AEAT receiving each RegistroAnterior before the record that cites it.
  for (const entry of sortByGeneration(missing)) {
    const organizationId = propertyCache.get(entry.propertyId)?.organizationId ?? "";
    submissionChain = submissionChain.then(async () => {
      // The live chain may have created the row while this step waited its turn.
      const existing = await prisma.verifactuSubmission.findUnique({
        where: { invoiceId_registroType: { invoiceId: entry.id, registroType: entry.registroType } },
        select: { id: true }
      });
      if (existing) return;
      try {
        const outcome = await dispatchRow({ invoiceId: entry.id, registroType: entry.registroType }, organizationId);
        if (outcome === "submitted") result.reconciled += 1;
      } catch (error) {
        result.failed += 1;
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[verifactu.reconcile] invoice ${entry.id} (${entry.registroType}) failed: ${message}`);
        // A failure after the upsert already created and counted the row.
        if (error instanceof AttemptAlreadyCountedError) return;
        // Leave a "retrying" row behind so the regular retry loop (and its
        // MAX_ATTEMPTS cap) owns the registro from here on, instead of the
        // reconciliation re-scanning it on every pass.
        const nextRetryAt = new Date(Date.now() + RETRY_BACKOFF_MS);
        await prisma.verifactuSubmission
          .upsert({
            where: { invoiceId_registroType: { invoiceId: entry.id, registroType: entry.registroType } },
            update: { status: "retrying", errorMessage: message, attempts: { increment: 1 }, nextRetryAt },
            create: {
              invoiceId: entry.id,
              propertyId: entry.propertyId,
              registroType: entry.registroType,
              status: "retrying",
              errorMessage: message,
              attempts: 1,
              nextRetryAt
            }
          })
          .catch((persistError: unknown) => {
            // QC-06: without the row the invoice is re-scanned on every pass.
            const detail = persistError instanceof Error ? persistError.message : String(persistError);
            console.error(`[verifactu.reconcile] could not park invoice ${entry.id} (${entry.registroType}) as retrying: ${detail}`);
          });
      }
    });
  }
  await submissionChain;
}

// ---------------------------------------------------------------------------
// Read model
// ---------------------------------------------------------------------------

export type VerifactuSubmissionView = {
  id: string;
  invoiceId: string;
  invoiceNumber?: string;
  registroType: VerifactuRegistroType;
  status: string;
  /** sandbox · preproduction · production at send time (null for rows older than Tanda 3). */
  mode: string | null;
  endpoint?: string;
  /** True when the ACK came from the local stub (endpoint stub://…), never from AEAT. */
  simulated: boolean;
  signatureMode?: string;
  signedAt?: string;
  csvCode?: string;
  acceptedHash?: string;
  errorCode?: string;
  errorMessage?: string;
  xmlPayload?: string;
  responseAck?: string;
  attempts: number;
  submittedAt?: string;
  acknowledgedAt?: string;
  nextRetryAt?: string;
  /** SistemaInformatico block the XML was built with. */
  software: VerifactuSoftwareBlock | null;
  /** Row creation (ISO); the list cursor key. */
  createdAt: string;
};

export type VerifactuSubmissionListItem = Omit<VerifactuSubmissionView, "xmlPayload" | "responseAck" | "software"> & {
  software: Pick<VerifactuSoftwareBlock, "nombreSistema" | "version" | "numeroInstalacion"> | null;
};

function softwareOf(row: { softwareJson: unknown }): VerifactuSoftwareBlock | null {
  const raw = row.softwareJson;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  return raw as VerifactuSoftwareBlock;
}

function rowToView(row: SubmissionRow, invoiceNumber?: string | null): VerifactuSubmissionView {
  return {
    id: row.id,
    invoiceId: row.invoiceId,
    invoiceNumber: invoiceNumber ?? undefined,
    registroType: registroTypeOf(row),
    status: row.status,
    mode: row.mode ?? null,
    endpoint: row.endpoint ?? undefined,
    simulated: isVerifactuSimulatedEndpoint(row.endpoint),
    signatureMode: row.signatureMode ?? undefined,
    signedAt: row.signedAt?.toISOString(),
    csvCode: row.csvCode ?? undefined,
    acceptedHash: row.acceptedHash ?? undefined,
    errorCode: row.errorCode ?? undefined,
    errorMessage: row.errorMessage ?? undefined,
    xmlPayload: row.xmlPayload ?? undefined,
    responseAck: row.responseAck ?? undefined,
    attempts: row.attempts,
    submittedAt: row.submittedAt?.toISOString(),
    acknowledgedAt: row.acknowledgedAt?.toISOString(),
    nextRetryAt: row.nextRetryAt?.toISOString(),
    software: softwareOf(row),
    createdAt: row.createdAt.toISOString()
  };
}

function toListItem(view: VerifactuSubmissionView): VerifactuSubmissionListItem {
  const { xmlPayload: _xml, responseAck: _ack, software, ...rest } = view;
  return {
    ...rest,
    software: software ? { nombreSistema: software.nombreSistema, version: software.version, numeroInstalacion: software.numeroInstalacion } : null
  };
}

export type ListVerifactuSubmissionsOptions = {
  /** Page size; defaults to DEFAULT_PAGE_LIMIT (100), clamped to MAX_PAGE_LIMIT (500). */
  limit?: number;
  /** Opaque cursor from a previous page's nextCursor (apps/api/src/lib/pagination.ts; malformed → 400). */
  cursor?: string | null;
  registroType?: VerifactuRegistroType;
  status?: string;
};

export type VerifactuSubmissionPage = Page<VerifactuSubmissionListItem>;

/**
 * Submissions of a property (altas and anulaciones), newest first, without
 * the XML bodies — paginated per the shared cursor contract (createdAt desc,
 * id desc; `{ items, nextCursor, total }`, `total` over the filtered set).
 * The route decides the body shape (pageBody: bare array unless the client
 * asked for the envelope) and sets the X-Total-Count / X-Next-Cursor headers.
 */
export async function listVerifactuSubmissions(propertyId: string, options: ListVerifactuSubmissionsOptions = {}): Promise<VerifactuSubmissionPage> {
  const limit = Math.min(Math.max(1, Math.trunc(options.limit ?? DEFAULT_PAGE_LIMIT)), MAX_PAGE_LIMIT);
  const cursor = decodeCursor(options.cursor ?? null);
  const cursorDate = cursor ? new Date(cursor.k) : null;
  if (cursorDate && Number.isNaN(cursorDate.getTime())) throw new BadRequestError("El cursor de paginación no es válido.");
  const where: Prisma.VerifactuSubmissionWhereInput = {
    propertyId,
    ...(options.registroType ? { registroType: options.registroType } : {}),
    ...(options.status ? { status: options.status } : {})
  };
  const pageWhere: Prisma.VerifactuSubmissionWhereInput =
    cursor && cursorDate
      ? { AND: [where, { OR: [{ createdAt: { lt: cursorDate } }, { createdAt: cursorDate, id: { lt: cursor.id } }] }] }
      : where;
  const [rows, total] = await Promise.all([
    prisma.verifactuSubmission.findMany({ where: pageWhere, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: limit + 1 }),
    prisma.verifactuSubmission.count({ where })
  ]);
  const invoiceIds = Array.from(new Set(rows.map((r) => r.invoiceId)));
  const invoices = invoiceIds.length
    ? await prisma.invoice.findMany({ where: { id: { in: invoiceIds } }, select: { id: true, invoiceNumber: true } })
    : [];
  const numByInvoice = new Map(invoices.map((i) => [i.id, i.invoiceNumber]));
  const items = rows.map((row) => toListItem(rowToView(row, numByInvoice.get(row.invoiceId))));
  return buildPage(items, limit, total, (item) => item.createdAt);
}

export type VerifactuInvoiceSubmissionView = VerifactuSubmissionView & {
  /** The RegistroAnulacion of the same invoice, when one exists. */
  anulacion: VerifactuSubmissionView | null;
};

/** The alta of an invoice (plus its anulación, if any); null when nothing was ever queued. */
export async function getVerifactuSubmission(invoiceId: string): Promise<VerifactuInvoiceSubmissionView | null> {
  const rows = await prisma.verifactuSubmission.findMany({ where: { invoiceId } });
  if (rows.length === 0) return null;
  const invoice = await prisma.invoice.findUnique({ where: { id: invoiceId }, select: { invoiceNumber: true } });
  const alta = rows.find((row) => registroTypeOf(row) === "alta") ?? null;
  const anulacion = rows.find((row) => registroTypeOf(row) === "anulacion") ?? null;
  const primary = alta ?? anulacion;
  if (!primary) return null;
  return {
    ...rowToView(primary, invoice?.invoiceNumber),
    anulacion: alta && anulacion ? rowToView(anulacion, invoice?.invoiceNumber) : null
  };
}

export async function getVerifactuSubmissionById(id: string): Promise<VerifactuSubmissionView | null> {
  const row = await prisma.verifactuSubmission.findUnique({ where: { id } });
  if (!row) return null;
  const invoice = await prisma.invoice.findUnique({ where: { id: row.invoiceId }, select: { invoiceNumber: true } });
  return rowToView(row, invoice?.invoiceNumber);
}
