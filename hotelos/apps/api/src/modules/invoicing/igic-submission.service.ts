// LEGACY (Tanda 3): the "ATC registro de facturas" this service targets does
// not exist — Canarias is common territory and RD 1007/2023 applies to it:
// a Canarian property reports its invoices to AEAT through VeriFactu with
// Impuesto=03 (IGIC), which is what verifactu-submission.service.ts does now
// (routeSubmissionByRegion no longer has an "igic" branch). Nothing enqueues
// here any more; the read endpoints (list/get) keep serving the existing
// igic_submissions rows (0 in the demo) and the manual retry still works so
// an operator can drain leftovers. Do not wire new callers; remove together
// with packages/compliance/src/spain/igic once the table is empty.
import { buildIgicXml, submitIgicRegistro } from "@hotelos/compliance";
import { prisma } from "@hotelos/database";
import { signSubmissionXml } from "../../lib/compliance-signing.js";
import { recordAuditEvent } from "../audit/audit.service.js";
import { issuerForInvoice } from "./issuer-identity.service.js";

let igicChain: Promise<void> = Promise.resolve();

export async function submitIgicForInvoice(invoiceId: string, organizationId: string, actorUserId?: string): Promise<void> {
  if (!invoiceId) return;
  const invoice = await prisma.invoice.findUnique({ where: { id: invoiceId } });
  if (!invoice || invoice.status !== "issued" || !invoice.invoiceNumber || !invoice.verifactuHash) return;
  const existing = await prisma.igicSubmission.findUnique({ where: { invoiceId } });
  if (existing && existing.status === "accepted") return;

  // FISC-03: issuer identity from the invoice snapshot (see issuer-identity.service.ts).
  const issuer = await issuerForInvoice(invoice);
  const emitterTaxId = issuer.taxId;
  const emitterName = issuer.legalName;
  const lines = await prisma.invoiceLine.findMany({ where: { invoiceId } });

  const breakdowns = lines.map((line) => {
    const rate = Number(line.taxRate.toString());
    const total = Number(line.total.toString());
    const base = rate > 0 ? total / (1 + rate / 100) : total;
    const taxAmount = total - base;
    return { ratePercent: rate, taxableBase: Math.round(base * 100) / 100, taxAmount: Math.round(taxAmount * 100) / 100 };
  });

  const xml = buildIgicXml({
    emitterTaxId,
    emitterName,
    invoiceNumber: invoice.invoiceNumber,
    issuedAt: invoice.issuedAt?.toISOString() ?? new Date().toISOString(),
    invoiceType: (invoice.invoiceType as "F1" | "F2") ?? "F1",
    description: `Servicios hoteleros ${invoice.invoiceNumber}`,
    invoiceTotal: Number(invoice.total),
    vatTotal: Number(invoice.taxTotal),
    breakdowns,
    previousHash: invoice.previousInvoiceHash,
    currentHash: invoice.verifactuHash
  });

  const signed = await signSubmissionXml({
    xml,
    certPath: process.env.IGIC_CERT_PATH,
    certPassphrase: process.env.IGIC_CERT_PASSPHRASE
  });

  const submission = await prisma.igicSubmission.upsert({
    where: { invoiceId },
    update: { status: "submitting", xmlPayload: signed.signedXml, attempts: { increment: 1 }, submittedAt: new Date() },
    create: { invoiceId, propertyId: invoice.propertyId, status: "submitting", xmlPayload: signed.signedXml, attempts: 1, submittedAt: new Date() }
  });

  const response = await submitIgicRegistro({ invoiceId, invoiceNumber: invoice.invoiceNumber, emitterTaxId, xmlPayload: signed.signedXml });
  const finalStatus = response.status === "accepted" ? "accepted" : response.status === "rejected" ? "rejected" : "retrying";

  await prisma.igicSubmission.update({
    where: { id: submission.id },
    data: {
      status: finalStatus,
      endpoint: response.endpoint,
      csvCode: response.csvCode ?? null,
      errorCode: response.errorCode ?? null,
      errorMessage: response.errorMessage ?? null,
      responseAck: response.rawResponse ?? null,
      acknowledgedAt: finalStatus === "accepted" ? new Date() : null,
      nextRetryAt: finalStatus === "retrying" ? new Date(Date.now() + 5 * 60_000) : null
    }
  });

  recordAuditEvent({
    organizationId,
    propertyId: invoice.propertyId,
    actorUserId,
    actorType: "system",
    action: "IGIC_SUBMISSION",
    entityType: "invoice",
    entityId: invoiceId,
    afterJson: { submissionId: submission.id, status: finalStatus, csvCode: response.csvCode, errorCode: response.errorCode }
  });
}

export async function retryIgicSubmission(submissionId: string): Promise<void> {
  const row = await prisma.igicSubmission.findUnique({ where: { id: submissionId } });
  if (!row) throw new Error("IGIC submission was not found.");
  const property = await prisma.property.findUnique({ where: { id: row.propertyId }, select: { organizationId: true } });
  igicChain = igicChain.then(() => submitIgicForInvoice(row.invoiceId, property?.organizationId ?? "", undefined).catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[igic.retry] failed: ${message}`);
  }));
}

export async function getIgicSubmission(submissionId: string): Promise<unknown | null> {
  const row = await prisma.igicSubmission.findUnique({ where: { id: submissionId } });
  if (!row) return null;
  const invoice = await prisma.invoice.findUnique({ where: { id: row.invoiceId }, select: { invoiceNumber: true } });
  return {
    id: row.id,
    invoiceId: row.invoiceId,
    invoiceNumber: invoice?.invoiceNumber,
    status: row.status,
    endpoint: row.endpoint,
    csvCode: row.csvCode,
    errorCode: row.errorCode,
    errorMessage: row.errorMessage,
    attempts: row.attempts,
    xmlPayload: row.xmlPayload,
    responseAck: row.responseAck,
    submittedAt: row.submittedAt?.toISOString(),
    acknowledgedAt: row.acknowledgedAt?.toISOString(),
    nextRetryAt: row.nextRetryAt?.toISOString(),
    createdAt: row.createdAt.toISOString()
  };
}

export async function listIgicSubmissions(propertyId: string): Promise<unknown[]> {
  const rows = await prisma.igicSubmission.findMany({ where: { propertyId }, orderBy: { createdAt: "desc" }, take: 100 });
  return rows.map((r) => ({
    id: r.id,
    invoiceId: r.invoiceId,
    status: r.status,
    endpoint: r.endpoint,
    csvCode: r.csvCode,
    errorCode: r.errorCode,
    errorMessage: r.errorMessage,
    attempts: r.attempts,
    submittedAt: r.submittedAt?.toISOString(),
    acknowledgedAt: r.acknowledgedAt?.toISOString()
  }));
}
