import { buildIgicXml, submitIgicRegistro } from "@hotelos/compliance";
import { prisma } from "@hotelos/database";
import type { EventEnvelope } from "@hotelos/shared";
import { signSubmissionXml } from "../../lib/compliance-signing.js";
import { recordAuditEvent } from "../audit/audit.service.js";

let igicChain: Promise<void> = Promise.resolve();

export function queueIgicSubmission(event: EventEnvelope): void {
  if (event.eventType !== "InvoiceIssued") return;
  igicChain = igicChain.then(async () => {
    try {
      await submitIgicForInvoice(event.entityId ?? "", event.organizationId, event.actorUserId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[igic] failed to submit invoice ${event.entityId}: ${message}`);
    }
  });
}

export async function submitIgicForInvoice(invoiceId: string, organizationId: string, actorUserId?: string): Promise<void> {
  if (!invoiceId) return;
  const invoice = await prisma.invoice.findUnique({ where: { id: invoiceId } });
  if (!invoice || invoice.status !== "issued" || !invoice.invoiceNumber || !invoice.verifactuHash) return;
  const existing = await prisma.igicSubmission.findUnique({ where: { invoiceId } });
  if (existing && existing.status === "accepted") return;

  const property = await prisma.property.findUnique({ where: { id: invoice.propertyId } });
  const lines = await prisma.invoiceLine.findMany({ where: { invoiceId } });
  const emitterTaxId = property?.legalName?.match(/[A-Z]?\d{8}[A-Z]?/i)?.[0] ?? "B00000000";
  const emitterName = property?.legalName ?? property?.name ?? "HotelOS Demo";

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
