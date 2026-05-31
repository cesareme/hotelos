import {
  buildVerifactuRegistroAlta,
  submitVerifactuRegistro,
  type VerifactuLineBreakdown,
  type VerifactuRectificationInput
} from "@hotelos/compliance";
import { prisma } from "@hotelos/database";
import type { EventEnvelope } from "@hotelos/shared";
import { signSubmissionXml } from "../../lib/compliance-signing.js";
import { recordAuditEvent } from "../audit/audit.service.js";
import { queueTbaiSubmission } from "./tbai-submission.service.js";
import { queueIgicSubmission } from "./igic-submission.service.js";

const SOFTWARE = {
  nif: process.env.VERIFACTU_SOFTWARE_NIF ?? "B00000000",
  name: "HotelOS",
  id: "HOTELOS-VRF-01",
  version: "0.1.0",
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

export async function retryVerifactuSubmission(submissionId: string): Promise<void> {
  const row = await prisma.verifactuSubmission.findUnique({ where: { id: submissionId } });
  if (!row) throw new Error("VeriFactu submission was not found.");
  const property = await prisma.property.findUnique({ where: { id: row.propertyId }, select: { organizationId: true } });
  submissionChain = submissionChain.then(() => submitForInvoice(row.invoiceId, property?.organizationId ?? "", undefined).catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[verifactu.retry] failed: ${message}`);
  }));
}

async function submitForInvoice(invoiceId: string, organizationId: string, actorUserId?: string): Promise<void> {
  if (!invoiceId) return;
  const invoice = await prisma.invoice.findUnique({ where: { id: invoiceId } });
  if (!invoice || invoice.status !== "issued" || !invoice.verifactuHash || !invoice.invoiceNumber) return;

  const existing = await prisma.verifactuSubmission.findUnique({ where: { invoiceId } });
  if (existing && existing.status === "accepted") return;

  const property = await prisma.property.findUnique({ where: { id: invoice.propertyId } });
  const lines = await prisma.invoiceLine.findMany({ where: { invoiceId } });
  const emitterTaxId = property?.legalName?.match(/[A-Z]?\d{8}[A-Z]?/i)?.[0] ?? "B00000000";
  const emitterName = property?.legalName ?? property?.name ?? "HotelOS Demo";

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
      select: { invoiceNumber: true, issuedAt: true, propertyId: true }
    });
    rectifiedRef = {
      invoiceNumber: rectified?.invoiceNumber ?? null,
      issuedAt: rectified?.issuedAt?.toISOString() ?? null
    };
    if (rectified?.invoiceNumber && rectified.issuedAt) {
      rectification = {
        type: "S",
        rectifiedInvoices: [
          {
            invoiceNumber: rectified.invoiceNumber,
            issueDate: rectified.issuedAt.toISOString(),
            emitterTaxId
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

  const response = await submitVerifactuRegistro({
    invoiceId,
    invoiceNumber: invoice.invoiceNumber,
    emitterTaxId,
    xmlPayload: signed.signedXml
  });

  const finalStatus =
    response.status === "accepted"
      ? "accepted"
      : response.status === "accepted_with_errors"
        ? "accepted_with_errors"
        : response.status === "rejected"
          ? "rejected"
          : "retrying";

  const nextRetryAt = finalStatus === "retrying" ? new Date(Date.now() + 5 * 60_000) : null;

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
