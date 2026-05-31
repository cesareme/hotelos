import { buildTbaiXml, computeTbaiHash, submitTbaiRegistro, type TbaiTerritory } from "@hotelos/compliance";
import { prisma } from "@hotelos/database";
import type { EventEnvelope } from "@hotelos/shared";
import { signSubmissionXml } from "../../lib/compliance-signing.js";
import { recordAuditEvent } from "../audit/audit.service.js";

const TBAI_SOFTWARE = {
  nif: process.env.TBAI_SOFTWARE_NIF ?? "B00000000",
  name: "HotelOS",
  licenseKey: process.env.TBAI_LICENSE_KEY ?? "TBAI-LIC-HOTELOS-001",
  developerName: "HotelOS SL",
  softwareName: "HotelOS TicketBAI",
  version: "0.1.0"
};

let tbaiChain: Promise<void> = Promise.resolve();

export function queueTbaiSubmission(event: EventEnvelope, territory: TbaiTerritory): void {
  if (event.eventType !== "InvoiceIssued") return;
  tbaiChain = tbaiChain.then(async () => {
    try {
      await submitTbaiForInvoice(event.entityId ?? "", event.organizationId, event.actorUserId, territory);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[tbai] failed to submit invoice ${event.entityId}: ${message}`);
    }
  });
}

export async function submitTbaiForInvoice(invoiceId: string, organizationId: string, actorUserId: string | undefined, territory: TbaiTerritory): Promise<void> {
  if (!invoiceId) return;
  const invoice = await prisma.invoice.findUnique({ where: { id: invoiceId } });
  if (!invoice || invoice.status !== "issued" || !invoice.invoiceNumber) return;
  const existing = await prisma.tbaiSubmission.findUnique({ where: { invoiceId } });
  if (existing && existing.status === "accepted") return;

  const property = await prisma.property.findUnique({ where: { id: invoice.propertyId } });
  const lines = await prisma.invoiceLine.findMany({ where: { invoiceId } });
  const emitterTaxId = property?.legalName?.match(/[A-Z]?\d{8}[A-Z]?/i)?.[0] ?? "B00000000";
  const emitterName = property?.legalName ?? property?.name ?? "HotelOS Demo";

  // TBAI hash chain per territory & property.
  const previousTbai = await prisma.tbaiSubmission.findFirst({
    where: { propertyId: invoice.propertyId, territory, status: "accepted" },
    orderBy: { acknowledgedAt: "desc" },
    select: { tbaiHash: true, invoiceId: true }
  });
  let previousInvoiceMeta: { invoiceNumber: string; issuedAt: Date | null } | null = null;
  if (previousTbai?.invoiceId) {
    previousInvoiceMeta = await prisma.invoice.findUnique({
      where: { id: previousTbai.invoiceId },
      select: { invoiceNumber: true, issuedAt: true }
    }) as { invoiceNumber: string; issuedAt: Date | null } | null;
  }

  const { hash: currentHash } = computeTbaiHash({
    emitterTaxId,
    invoiceNumber: invoice.invoiceNumber,
    issuedAt: invoice.issuedAt?.toISOString() ?? new Date().toISOString(),
    invoiceType: (invoice.invoiceType as "F1" | "F2") ?? "F1",
    totalAmount: Number(invoice.total),
    previousHash: previousTbai?.tbaiHash ?? null,
    previousInvoiceNumber: previousInvoiceMeta?.invoiceNumber ?? null,
    previousIssuedAt: previousInvoiceMeta?.issuedAt?.toISOString() ?? null
  });

  const breakdowns = lines.map((line) => {
    const rate = Number(line.taxRate.toString());
    const total = Number(line.total.toString());
    const base = rate > 0 ? total / (1 + rate / 100) : total;
    const taxAmount = total - base;
    return { ratePercent: rate, taxableBase: Math.round(base * 100) / 100, taxAmount: Math.round(taxAmount * 100) / 100 };
  });

  const xml = buildTbaiXml({
    territory,
    emitterTaxId,
    emitterName,
    invoiceNumber: invoice.invoiceNumber,
    issuedAt: invoice.issuedAt?.toISOString() ?? new Date().toISOString(),
    invoiceType: (invoice.invoiceType as "F1" | "F2") ?? "F1",
    description: `Servicios hoteleros ${invoice.invoiceNumber}`,
    totalAmount: Number(invoice.total),
    vatTotal: Number(invoice.taxTotal),
    breakdowns,
    previousHash: previousTbai?.tbaiHash ?? null,
    previousInvoiceNumber: previousInvoiceMeta?.invoiceNumber ?? null,
    previousIssuedAt: previousInvoiceMeta?.issuedAt?.toISOString() ?? null,
    currentHash,
    software: TBAI_SOFTWARE
  });

  const signed = await signSubmissionXml({
    xml,
    certPath: process.env.TBAI_CERT_PATH,
    certPassphrase: process.env.TBAI_CERT_PASSPHRASE
  });

  const submission = await prisma.tbaiSubmission.upsert({
    where: { invoiceId },
    update: { status: "submitting", territory, xmlPayload: signed.signedXml, attempts: { increment: 1 }, submittedAt: new Date(), tbaiHash: currentHash, previousTbaiHash: previousTbai?.tbaiHash ?? null },
    create: { invoiceId, propertyId: invoice.propertyId, territory, status: "submitting", xmlPayload: signed.signedXml, attempts: 1, submittedAt: new Date(), tbaiHash: currentHash, previousTbaiHash: previousTbai?.tbaiHash ?? null }
  });

  const response = await submitTbaiRegistro({ territory, invoiceNumber: invoice.invoiceNumber, emitterTaxId, xmlPayload: signed.signedXml });
  const finalStatus = response.status === "accepted" ? "accepted" : response.status === "rejected" ? "rejected" : "retrying";

  await prisma.tbaiSubmission.update({
    where: { id: submission.id },
    data: {
      status: finalStatus,
      endpoint: response.endpoint,
      tbaiCode: response.tbaiCode ?? null,
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
    action: "TBAI_SUBMISSION",
    entityType: "invoice",
    entityId: invoiceId,
    afterJson: { submissionId: submission.id, territory, status: finalStatus, tbaiCode: response.tbaiCode, errorCode: response.errorCode }
  });
}

export async function retryTbaiSubmission(submissionId: string): Promise<void> {
  const row = await prisma.tbaiSubmission.findUnique({ where: { id: submissionId } });
  if (!row) throw new Error("TBAI submission was not found.");
  const property = await prisma.property.findUnique({ where: { id: row.propertyId }, select: { taxRegion: true, organizationId: true } });
  const territory = (row.territory ?? property?.taxRegion ?? "bizkaia") as TbaiTerritory;
  tbaiChain = tbaiChain.then(() => submitTbaiForInvoice(row.invoiceId, property?.organizationId ?? "", undefined, territory).catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[tbai.retry] failed: ${message}`);
  }));
}

export async function getTbaiSubmission(submissionId: string): Promise<unknown | null> {
  const row = await prisma.tbaiSubmission.findUnique({ where: { id: submissionId } });
  if (!row) return null;
  const invoice = await prisma.invoice.findUnique({ where: { id: row.invoiceId }, select: { invoiceNumber: true } });
  return {
    id: row.id,
    invoiceId: row.invoiceId,
    invoiceNumber: invoice?.invoiceNumber,
    territory: row.territory,
    status: row.status,
    endpoint: row.endpoint,
    tbaiCode: row.tbaiCode,
    tbaiHash: row.tbaiHash,
    previousTbaiHash: row.previousTbaiHash,
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

export async function listTbaiSubmissions(propertyId: string): Promise<unknown[]> {
  const rows = await prisma.tbaiSubmission.findMany({ where: { propertyId }, orderBy: { createdAt: "desc" }, take: 100 });
  return rows.map((r) => ({
    id: r.id,
    invoiceId: r.invoiceId,
    territory: r.territory,
    status: r.status,
    endpoint: r.endpoint,
    tbaiCode: r.tbaiCode,
    tbaiHash: r.tbaiHash,
    errorCode: r.errorCode,
    errorMessage: r.errorMessage,
    attempts: r.attempts,
    submittedAt: r.submittedAt?.toISOString(),
    acknowledgedAt: r.acknowledgedAt?.toISOString()
  }));
}
