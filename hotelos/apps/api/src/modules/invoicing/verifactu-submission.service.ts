import {
  buildVerifactuRegistroAlta,
  submitVerifactuRegistro,
  type VerifactuLineBreakdown,
  type VerifactuRectificationInput
} from "@hotelos/compliance";
import { prisma } from "@hotelos/database";
import type { EventEnvelope } from "@hotelos/shared";
import { signSubmissionXml } from "../../lib/compliance-signing.js";
import { ConflictError, NotFoundError } from "../../lib/http-error.js";
import { recordAuditEvent } from "../audit/audit.service.js";
import { queueTbaiSubmission } from "./tbai-submission.service.js";
import { queueIgicSubmission } from "./igic-submission.service.js";
import { issuerForInvoice } from "./issuer-identity.service.js";

// Software producer block of the registro (SistemaInformatico). This is the NIF
// of the software PRODUCER (Anfitorio's legal owner), a different concept from
// the invoice issuer (Invoice.issuerTaxId, see issuer-identity.service.ts).
// VERIFACTU_SOFTWARE_NIF MUST be a real NIF before sending to AEAT — the
// all-zero placeholder is only tolerated in development. Keep in sync with
// apps/worker/src/scheduler.ts (same block, so a retry rebuilds the same XML).
const SOFTWARE = {
  nif: process.env.VERIFACTU_SOFTWARE_NIF ?? "B00000000",
  name: "Anfitorio",
  id: "ANFITORIO-VRF-01",
  version: process.env.APP_VERSION ?? "0.1.0",
  installNumber: process.env.VERIFACTU_INSTALL_NUMBER ?? "DEV-001"
};

let submissionChain: Promise<void> = Promise.resolve();

export function queueVerifactuSubmission(event: EventEnvelope): void {
  if (event.eventType !== "InvoiceIssued") return;
  submissionChain = submissionChain.then(async () => {
    try {
      await routeSubmissionByRegion(event);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[verifactu] failed to submit invoice ${event.entityId}: ${message}`);
    }
  });
}

async function routeSubmissionByRegion(event: EventEnvelope): Promise<void> {
  const invoiceId = event.entityId ?? "";
  if (!invoiceId) return;
  const invoice = await prisma.invoice.findUnique({ where: { id: invoiceId } });
  if (!invoice) return;
  const property = await prisma.property.findUnique({ where: { id: invoice.propertyId } });
  const region = property?.taxRegion ?? "mainland";
  if (region === "canary") {
    queueIgicSubmission(event);
    return;
  }
  if (region === "bizkaia" || region === "gipuzkoa" || region === "araba") {
    queueTbaiSubmission(event, region);
    return;
  }
  await submitForInvoice(invoiceId, event.organizationId, event.actorUserId);
}

// Manual retry (POST /verifactu/submissions/:id/retry). Unlike the sweep it
// also takes terminal rows — "failed" (MAX_ATTEMPTS exhausted) and "abandoned"
// — and gives them a fresh budget: attempts back to 0, status "retrying" (so a
// crash before the send is still recovered by the sweep) and no scheduled
// retry. A row whose invoice can no longer be sent answers 409 with the reason
// instead of being re-queued; an accepted one has nothing to retry.
export async function retryVerifactuSubmission(submissionId: string): Promise<void> {
  const row = await prisma.verifactuSubmission.findUnique({ where: { id: submissionId } });
  if (!row) throw new NotFoundError("Envío VeriFactu no encontrado.");
  if (row.status === "accepted") {
    throw new ConflictError("El envío ya fue aceptado por AEAT; no procede reintentarlo.");
  }
  const invoice = await prisma.invoice.findUnique({
    where: { id: row.invoiceId },
    select: { status: true, verifactuHash: true, invoiceNumber: true, deletedAt: true }
  });
  const reason = unsubmittableReason(invoice);
  if (reason) throw new ConflictError(`No se puede reintentar el envío: ${reason}.`);

  const property = await prisma.property.findUnique({ where: { id: row.propertyId }, select: { organizationId: true } });
  await prisma.verifactuSubmission.update({
    where: { id: row.id },
    data: { status: "retrying", attempts: 0, nextRetryAt: null }
  });
  submissionChain = submissionChain.then(async () => {
    try {
      await submitForInvoice(row.invoiceId, property?.organizationId ?? "", undefined);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[verifactu.retry] failed: ${message}`);
      await recordUncountedFailure(row.id, err);
    }
  });
}

const RETRY_BATCH_SIZE = 25;
// A row left in "submitting" longer than this was orphaned by a crash between
// the upsert and the AEAT response (the in-memory chain is lost on restart).
const STUCK_SUBMITTING_MS = 15 * 60_000;
const RETRY_BACKOFF_MS = 5 * 60_000;
// After this many attempts a row goes terminal ("failed") instead of being
// retried forever. Overridable per deployment with VERIFACTU_MAX_ATTEMPTS.
const MAX_ATTEMPTS = parseMaxAttempts(process.env.VERIFACTU_MAX_ATTEMPTS);
// Reconciliation of issued invoices that never got a submission row (crash
// between issueInvoice() and the upsert): scan the last 72h, but leave the
// freshest invoices to the live chain so the sweep does not race it.
const RECONCILE_WINDOW_MS = 72 * 60 * 60_000;
const RECONCILE_GRACE_MS = 5 * 60_000;
const RECONCILE_BATCH_SIZE = 25;
const RECONCILE_SCAN_PAGE_SIZE = 200;
const RECONCILE_SCAN_MAX_PAGES = 10;

function parseMaxAttempts(raw: string | undefined): number {
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 12;
}

let retrySweepInFlight = false;

export type VerifactuRetrySweepResult = {
  due: number;
  // Re-submitted through submitForInvoice (whatever AEAT answered).
  retried: number;
  // Threw during re-submission, or went terminal after MAX_ATTEMPTS.
  failed: number;
  // Went terminal because the invoice is gone / not issued / has no hash.
  abandoned: number;
  // Issued invoices with no submission row that were sent by reconciliation.
  reconciled: number;
};

type SubmissionRow = { id: string; invoiceId: string; propertyId: string; attempts: number };
type SubmissionRoute = "verifactu" | "igic" | "tbai";

// Mirrors routeSubmissionByRegion: Canarias reports IGIC through its own
// table and the foral territories through TicketBAI; everything else (mainland
// and an unset region) is VeriFactu.
function submissionRouteForRegion(region: string | null | undefined): SubmissionRoute {
  if (region === "canary") return "igic";
  if (region === "bizkaia" || region === "gipuzkoa" || region === "araba") return "tbai";
  return "verifactu";
}

// Why an invoice can no longer be sent to AEAT (null when it can). Shared by
// the live path and the sweep so both agree on what "submittable" means.
function unsubmittableReason(
  invoice: { status: string; verifactuHash: string | null; invoiceNumber: string | null; deletedAt: Date | null } | null
): string | null {
  if (!invoice) return "la factura ya no existe";
  if (invoice.deletedAt) return "la factura fue eliminada";
  if (invoice.status !== "issued") return `la factura está en estado '${invoice.status}', no emitida`;
  if (!invoice.verifactuHash) return "la factura no tiene huella VeriFactu";
  if (!invoice.invoiceNumber) return "la factura no tiene número";
  return null;
}

// Thrown by submitForInvoice for a failure after its upsert has already
// counted the attempt: callers log/park it but must not increment `attempts`
// a second time.
class AttemptAlreadyCountedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AttemptAlreadyCountedError";
  }
}

// After submitForInvoice threw for an existing row: a failure before the
// upsert (XML build, signing) has not been counted yet, so count it here with
// the regular backoff — a permanently broken row must still reach
// MAX_ATTEMPTS instead of retrying forever. A failure after the upsert was
// already counted (and, for transport errors, parked) by submitForInvoice.
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
// nextRetryAt null; the operator can still force a manual retry from the UI
// (retryVerifactuSubmission resets the attempt counter).
async function markTerminal(id: string, status: "abandoned" | "failed", errorMessage: string): Promise<void> {
  try {
    await prisma.verifactuSubmission.update({ where: { id }, data: { status, errorMessage, nextRetryAt: null } });
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

// In-process retry loop (same role as the pg-boss "verifactu.retry" job in
// apps/worker), wired every 120s from server.ts on the scheduler leader:
//   1. re-submit registros whose nextRetryAt elapsed plus rows orphaned
//      mid-send, retiring poisoned rows (invoice gone / not issued / no hash)
//      and rows past MAX_ATTEMPTS so they stop being reselected;
//   2. reconcile issued invoices that never got a submission row.
// Serialized through `submissionChain` so it never races a live submission of
// the same invoice.
export async function runDueVerifactuRetries(now = new Date()): Promise<VerifactuRetrySweepResult> {
  const result: VerifactuRetrySweepResult = { due: 0, retried: 0, failed: 0, abandoned: 0, reconciled: 0 };
  if (retrySweepInFlight) return result;
  retrySweepInFlight = true;
  try {
    await retryDueSubmissions(now, result);
    await reconcileMissingSubmissions(now, result);
    return result;
  } finally {
    retrySweepInFlight = false;
  }
}

async function retryDueSubmissions(now: Date, result: VerifactuRetrySweepResult): Promise<void> {
  const due: SubmissionRow[] = await prisma.verifactuSubmission.findMany({
    where: {
      OR: [
        { status: { in: ["retrying", "network_error"] }, OR: [{ nextRetryAt: null }, { nextRetryAt: { lte: now } }] },
        { status: "submitting", updatedAt: { lte: new Date(now.getTime() - STUCK_SUBMITTING_MS) } }
      ]
    },
    select: { id: true, invoiceId: true, propertyId: true, attempts: true },
    orderBy: { createdAt: "asc" },
    take: RETRY_BATCH_SIZE
  });
  if (due.length === 0) return;
  result.due = due.length;

  // VerifactuSubmission has no Prisma relation to Invoice, so "invoice still
  // issued with a hash" is a second query rather than a join. Rows that fail
  // it go terminal right here: before, submitForInvoice returned silently,
  // the row stayed "retrying" with an elapsed nextRetryAt and — selected
  // oldest-first — a handful of them could starve every newer row forever.
  const invoices = await prisma.invoice.findMany({
    where: { id: { in: due.map((row) => row.invoiceId) } },
    select: { id: true, status: true, verifactuHash: true, invoiceNumber: true, deletedAt: true }
  });
  const invoiceById = new Map(invoices.map((invoice) => [invoice.id, invoice]));

  const retryable: SubmissionRow[] = [];
  for (const row of due) {
    const reason = unsubmittableReason(invoiceById.get(row.invoiceId) ?? null);
    if (reason) {
      await markTerminal(row.id, "abandoned", `Envío abandonado: ${reason}.`);
      result.abandoned += 1;
      continue;
    }
    if (row.attempts >= MAX_ATTEMPTS) {
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
        const outcome = await submitForInvoice(row.invoiceId, orgByProperty.get(row.propertyId) ?? "", undefined);
        if (outcome === "not_submittable") {
          // The invoice changed between selection and execution (cancelled or
          // rectified meanwhile): retire the row instead of counting a retry.
          await markTerminal(row.id, "abandoned", "Envío abandonado: la factura dejó de estar emitida antes del reintento.");
          result.abandoned += 1;
          return;
        }
        if (outcome === "submitted") result.retried += 1;
      } catch (error) {
        result.failed += 1;
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[verifactu.retry] submission ${row.id} failed: ${message}`);
        await recordUncountedFailure(row.id, error);
      }
    });
  }
  await submissionChain;
}

// Recovery for the crash window between issueInvoice() and the submission
// upsert: after a restart such an invoice is issued (number + hash) but has no
// verifactu_submissions row and no entry in the in-memory chain, so nothing
// would ever send it. Scan issued invoices of the last 72h oldest-first, skip
// the ones routed to IGIC/TBAI (their own tables) and (re)submit up to 25 per
// tick. The unique invoiceId in the upsert keeps this idempotent against the
// live path; the grace period and the in-chain re-check avoid racing it.
// VERIFACTU_MODE (sandbox / preproduction / production) is applied inside
// submitVerifactuRegistro, so reconciled invoices follow the same mode.
async function reconcileMissingSubmissions(now: Date, result: VerifactuRetrySweepResult): Promise<void> {
  const windowStart = new Date(now.getTime() - RECONCILE_WINDOW_MS);
  const graceEnd = new Date(now.getTime() - RECONCILE_GRACE_MS);
  const propertyCache = new Map<string, { organizationId: string; route: SubmissionRoute }>();
  const missing: Array<{ id: string; propertyId: string }> = [];
  let cursor: string | undefined;

  for (let page = 0; page < RECONCILE_SCAN_MAX_PAGES && missing.length < RECONCILE_BATCH_SIZE; page += 1) {
    const candidates = await prisma.invoice.findMany({
      where: {
        status: "issued",
        deletedAt: null,
        verifactuHash: { not: null },
        invoiceNumber: { not: null },
        issuedAt: { gte: windowStart, lte: graceEnd }
      },
      select: { id: true, propertyId: true },
      orderBy: [{ issuedAt: "asc" }, { id: "asc" }],
      take: RECONCILE_SCAN_PAGE_SIZE,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {})
    });
    if (candidates.length === 0) break;
    cursor = candidates[candidates.length - 1]!.id;

    const unknownPropertyIds = Array.from(new Set(candidates.map((c) => c.propertyId))).filter((id) => !propertyCache.has(id));
    if (unknownPropertyIds.length > 0) {
      const properties = await prisma.property.findMany({
        where: { id: { in: unknownPropertyIds } },
        select: { id: true, organizationId: true, taxRegion: true }
      });
      for (const property of properties) {
        propertyCache.set(property.id, {
          organizationId: property.organizationId,
          route: submissionRouteForRegion(property.taxRegion)
        });
      }
    }

    const existingRows = await prisma.verifactuSubmission.findMany({
      where: { invoiceId: { in: candidates.map((c) => c.id) } },
      select: { invoiceId: true }
    });
    const covered = new Set(existingRows.map((row) => row.invoiceId));
    for (const candidate of candidates) {
      if (covered.has(candidate.id)) continue;
      // Unknown property → unroutable; IGIC/TBAI regions live in their own tables.
      if (propertyCache.get(candidate.propertyId)?.route !== "verifactu") continue;
      missing.push(candidate);
      if (missing.length >= RECONCILE_BATCH_SIZE) break;
    }
    if (candidates.length < RECONCILE_SCAN_PAGE_SIZE) break;
  }
  if (missing.length === 0) return;

  for (const invoice of missing) {
    const organizationId = propertyCache.get(invoice.propertyId)?.organizationId ?? "";
    submissionChain = submissionChain.then(async () => {
      // The live chain may have created the row while this step waited its turn.
      const existing = await prisma.verifactuSubmission.findUnique({ where: { invoiceId: invoice.id }, select: { id: true } });
      if (existing) return;
      try {
        const outcome = await submitForInvoice(invoice.id, organizationId, undefined);
        if (outcome === "submitted") result.reconciled += 1;
      } catch (error) {
        result.failed += 1;
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[verifactu.reconcile] invoice ${invoice.id} failed: ${message}`);
        // A failure after the upsert already created and counted the row.
        if (error instanceof AttemptAlreadyCountedError) return;
        // Leave a "retrying" row behind so the regular retry loop (and its
        // MAX_ATTEMPTS cap) owns the invoice from here on, instead of the
        // reconciliation re-scanning it every tick for 72h.
        const nextRetryAt = new Date(Date.now() + RETRY_BACKOFF_MS);
        await prisma.verifactuSubmission
          .upsert({
            where: { invoiceId: invoice.id },
            update: { status: "retrying", errorMessage: message, attempts: { increment: 1 }, nextRetryAt },
            create: {
              invoiceId: invoice.id,
              propertyId: invoice.propertyId,
              status: "retrying",
              errorMessage: message,
              attempts: 1,
              nextRetryAt
            }
          })
          .catch((persistError: unknown) => {
            // QC-06: without the row the invoice is re-scanned every tick for 72h.
            const detail = persistError instanceof Error ? persistError.message : String(persistError);
            console.error(`[verifactu.reconcile] could not park invoice ${invoice.id} as retrying: ${detail}`);
          });
      }
    });
  }
  await submissionChain;
}

type SubmitOutcome = "submitted" | "already_accepted" | "not_submittable";

// Builds, signs and sends the registro for one invoice, upserting the
// verifactu_submissions row (unique invoiceId → never two rows per invoice).
// Reports what happened so the sweep can retire rows it must not retry; the
// inline null checks duplicate unsubmittableReason() on purpose to narrow
// `verifactuHash` / `invoiceNumber` for the payload below.
async function submitForInvoice(invoiceId: string, organizationId: string, actorUserId?: string): Promise<SubmitOutcome> {
  if (!invoiceId) return "not_submittable";
  const invoice = await prisma.invoice.findUnique({ where: { id: invoiceId } });
  if (!invoice || !invoice.verifactuHash || !invoice.invoiceNumber || unsubmittableReason(invoice) !== null) {
    return "not_submittable";
  }

  const existing = await prisma.verifactuSubmission.findUnique({ where: { invoiceId } });
  if (existing && existing.status === "accepted") return "already_accepted";

  // FISC-03: the identity the invoice was issued with (snapshot; QR nif= for
  // legacy invoices; live resolver as the last resort, which applies the
  // production 409 / sandbox placeholder policy). Never a regex over the
  // property name — the huella must be reproducible.
  const issuer = await issuerForInvoice(invoice);
  const emitterTaxId = issuer.taxId;
  const emitterName = issuer.legalName;
  const lines = await prisma.invoiceLine.findMany({ where: { invoiceId } });

  let previousInvoiceNumber: string | null = null;
  let previousIssuedAt: string | null = null;
  if (invoice.previousInvoiceHash) {
    const previous = await prisma.invoice.findFirst({
      where: { propertyId: invoice.propertyId, verifactuHash: invoice.previousInvoiceHash },
      select: { invoiceNumber: true, issuedAt: true }
    });
    previousInvoiceNumber = previous?.invoiceNumber ?? null;
    previousIssuedAt = previous?.issuedAt?.toISOString() ?? null;
  }

  const breakdowns: VerifactuLineBreakdown[] = aggregateBreakdownsByRate(lines);

  // Rectificativa support: if this invoice rectifies another, build the AEAT
  // `<sum1:TipoRectificativa>` + `<sum1:FacturasRectificadas>` payload and
  // also keep a human-readable mention in `DescripcionOperacion` for operator
  // correlation. We default to TipoRectificativa="S" (sustitución) because
  // our `createRectifyingInvoice` flow with fullReversal substitutes the
  // original invoice in full. If a future "by-differences" flow is added,
  // it should set type="I" and pass `importeRectificacion` deltas.
  let rectifiedRef: { invoiceNumber?: string | null; issuedAt?: string | null } | null = null;
  let rectification: VerifactuRectificationInput | undefined;
  if (invoice.rectifyingForId) {
    const rectified = await prisma.invoice.findUnique({
      where: { id: invoice.rectifyingForId },
      select: {
        invoiceNumber: true,
        issuedAt: true,
        propertyId: true,
        issuerTaxId: true,
        issuerLegalName: true,
        issuerTaxIdPlaceholder: true,
        qrPayload: true
      }
    });
    rectifiedRef = {
      invoiceNumber: rectified?.invoiceNumber ?? null,
      issuedAt: rectified?.issuedAt?.toISOString() ?? null
    };
    if (rectified?.invoiceNumber && rectified.issuedAt) {
      // IDEmisorFactura of the rectified invoice is ITS snapshot (it may
      // predate a NIF correction), not the current issuer.
      const rectifiedIssuer = await issuerForInvoice(rectified);
      rectification = {
        type: "S",
        rectifiedInvoices: [
          {
            invoiceNumber: rectified.invoiceNumber,
            issueDate: rectified.issuedAt.toISOString(),
            emitterTaxId: rectifiedIssuer.taxId
          }
        ]
      };
    }
  }
  const description = rectifiedRef
    ? `Factura rectificativa ${invoice.invoiceNumber} (rectifica ${rectifiedRef.invoiceNumber ?? "—"}, motivo ${invoice.rectifyingReasonCode ?? "R4"})`
    : `Servicios hoteleros ${invoice.invoiceNumber}`;

  const xmlPayload = buildVerifactuRegistroAlta({
    emitterTaxId,
    emitterName,
    invoiceNumber: invoice.invoiceNumber,
    issuedAt: invoice.issuedAt?.toISOString() ?? new Date().toISOString(),
    invoiceType: (invoice.invoiceType as "F1" | "F2" | "F3" | "R1" | "R2" | "R3" | "R4" | "R5") ?? "F1",
    description,
    invoiceTotal: Number(invoice.total),
    vatTotal: Number(invoice.taxTotal),
    breakdowns,
    previousHash: invoice.previousInvoiceHash,
    previousInvoiceNumber,
    previousIssuedAt,
    currentHash: invoice.verifactuHash,
    rectification,
    software: SOFTWARE
  });

  const signed = await signSubmissionXml({
    xml: xmlPayload,
    certPath: process.env.VERIFACTU_CERT_PATH,
    certPassphrase: process.env.VERIFACTU_CERT_PASSPHRASE
  });

  const submission = await prisma.verifactuSubmission.upsert({
    where: { invoiceId },
    update: { status: "submitting", xmlPayload: signed.signedXml, attempts: { increment: 1 }, submittedAt: new Date(), signatureMode: signed.signatureMode, signedAt: new Date(signed.signedAt) },
    create: {
      invoiceId,
      propertyId: invoice.propertyId,
      status: "submitting",
      xmlPayload: signed.signedXml,
      attempts: 1,
      submittedAt: new Date(),
      signatureMode: signed.signatureMode,
      signedAt: new Date(signed.signedAt)
    }
  });

  // From here on the attempt is counted (upsert above), so every failure is
  // re-thrown as AttemptAlreadyCountedError and callers do not count it
  // again. A transport failure also parks the row with the regular backoff;
  // a failure of the final update leaves it "submitting" for the sweep's
  // stuck-row path, whose next upsert counts the next attempt on its own.
  let response: Awaited<ReturnType<typeof submitVerifactuRegistro>> | undefined;
  let finalStatus = "retrying";
  try {
    response = await submitVerifactuRegistro({
      invoiceId,
      invoiceNumber: invoice.invoiceNumber,
      emitterTaxId,
      xmlPayload: signed.signedXml
    });

    finalStatus =
      response.status === "accepted"
        ? "accepted"
        : response.status === "accepted_with_errors"
          ? "accepted_with_errors"
          : response.status === "rejected"
            ? "rejected"
            : "retrying";

    const nextRetryAt = finalStatus === "retrying" ? new Date(Date.now() + RETRY_BACKOFF_MS) : null;

    await prisma.verifactuSubmission.update({
      where: { id: submission.id },
      data: {
        status: finalStatus,
        endpoint: response.endpoint,
        csvCode: response.csvCode ?? null,
        acceptedHash: response.acceptedHash ?? null,
        errorCode: response.errorCode ?? null,
        errorMessage: response.errorMessage ?? null,
        responseAck: response.rawResponse ?? null,
        acknowledgedAt: finalStatus === "accepted" ? new Date() : null,
        nextRetryAt
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
          console.error(`[verifactu] could not park submission ${submission.id} (invoice ${invoiceId}) as retrying: ${detail}`);
        });
    }
    throw new AttemptAlreadyCountedError(message);
  }

  recordAuditEvent({
    organizationId,
    propertyId: invoice.propertyId,
    actorUserId,
    actorType: "system",
    action: "VERIFACTU_SUBMISSION",
    entityType: "invoice",
    entityId: invoiceId,
    afterJson: {
      submissionId: submission.id,
      endpoint: response.endpoint,
      status: finalStatus,
      csvCode: response.csvCode,
      errorCode: response.errorCode,
      errorMessage: response.errorMessage,
      acknowledgedAt: finalStatus === "accepted" ? new Date().toISOString() : undefined
    }
  });
  return "submitted";
}

function aggregateBreakdownsByRate(lines: Array<{ taxRate: { toString(): string }; total: { toString(): string }; taxCode: string }>): VerifactuLineBreakdown[] {
  const grouped = new Map<string, VerifactuLineBreakdown>();
  for (const line of lines) {
    const ratePercent = Number(line.taxRate.toString());
    const total = Number(line.total.toString());
    const taxableBase = ratePercent > 0 ? total / (1 + ratePercent / 100) : total;
    const taxAmount = total - taxableBase;
    const key = `${line.taxCode}::${ratePercent}`;
    const existing = grouped.get(key);
    if (existing) {
      existing.taxableBase += taxableBase;
      existing.taxAmount += taxAmount;
    } else {
      grouped.set(key, { taxCode: line.taxCode, ratePercent, taxableBase, taxAmount });
    }
  }
  return Array.from(grouped.values()).map((b) => ({
    ...b,
    taxableBase: Math.round(b.taxableBase * 100) / 100,
    taxAmount: Math.round(b.taxAmount * 100) / 100
  }));
}

export async function listVerifactuSubmissions(propertyId: string): Promise<Array<{
  id: string;
  invoiceId: string;
  invoiceNumber?: string;
  status: string;
  endpoint?: string;
  csvCode?: string;
  errorCode?: string;
  errorMessage?: string;
  attempts: number;
  submittedAt?: string;
  acknowledgedAt?: string;
}>> {
  const rows = await prisma.verifactuSubmission.findMany({
    where: { propertyId },
    orderBy: { createdAt: "desc" },
    take: 100
  });
  if (rows.length === 0) return [];
  const invoiceIds = rows.map((r) => r.invoiceId);
  const invoices = await prisma.invoice.findMany({ where: { id: { in: invoiceIds } }, select: { id: true, invoiceNumber: true } });
  const numByInvoice = new Map(invoices.map((i) => [i.id, i.invoiceNumber ?? undefined]));
  return rows.map((row) => ({
    id: row.id,
    invoiceId: row.invoiceId,
    invoiceNumber: numByInvoice.get(row.invoiceId),
    status: row.status,
    endpoint: row.endpoint ?? undefined,
    csvCode: row.csvCode ?? undefined,
    errorCode: row.errorCode ?? undefined,
    errorMessage: row.errorMessage ?? undefined,
    attempts: row.attempts,
    submittedAt: row.submittedAt?.toISOString(),
    acknowledgedAt: row.acknowledgedAt?.toISOString()
  }));
}

type VerifactuSubmissionView = {
  id: string;
  invoiceId: string;
  invoiceNumber?: string;
  status: string;
  endpoint?: string;
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
};

function rowToView(row: any): VerifactuSubmissionView {
  return {
    id: row.id,
    invoiceId: row.invoiceId,
    invoiceNumber: row.invoiceNumber ?? undefined,
    status: row.status,
    endpoint: row.endpoint ?? undefined,
    csvCode: row.csvCode ?? undefined,
    acceptedHash: row.acceptedHash ?? undefined,
    errorCode: row.errorCode ?? undefined,
    errorMessage: row.errorMessage ?? undefined,
    xmlPayload: row.xmlPayload ?? undefined,
    responseAck: row.responseAck ?? undefined,
    attempts: row.attempts,
    submittedAt: row.submittedAt?.toISOString(),
    acknowledgedAt: row.acknowledgedAt?.toISOString(),
    nextRetryAt: row.nextRetryAt?.toISOString?.()
  };
}

async function attachInvoiceNumber(row: any | null): Promise<VerifactuSubmissionView | null> {
  if (!row) return null;
  const invoice = await prisma.invoice.findUnique({
    where: { id: row.invoiceId },
    select: { invoiceNumber: true }
  });
  return rowToView({ ...row, invoiceNumber: invoice?.invoiceNumber ?? undefined });
}

export async function getVerifactuSubmission(invoiceId: string): Promise<VerifactuSubmissionView | null> {
  const row = await prisma.verifactuSubmission.findUnique({ where: { invoiceId } });
  return attachInvoiceNumber(row);
}

export async function getVerifactuSubmissionById(id: string): Promise<VerifactuSubmissionView | null> {
  const row = await prisma.verifactuSubmission.findUnique({ where: { id } });
  return attachInvoiceNumber(row);
}
