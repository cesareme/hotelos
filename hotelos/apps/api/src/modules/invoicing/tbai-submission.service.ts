import { buildTbaiXml, computeTbaiHash, resolveVerifactuSoftware, submitTbaiRegistro, type TbaiTerritory } from "@hotelos/compliance";
import { prisma } from "@hotelos/database";
import type { EventEnvelope } from "@hotelos/shared";
import { signSubmissionXml } from "../../lib/compliance-signing.js";
import { recordAuditEvent } from "../audit/audit.service.js";
import { issuerForInvoice, resolveVerifactuChainScope, type VerifactuChainScope } from "./issuer-identity.service.js";

// TicketBAI <Software> block. The producer identity (NIF, razón social,
// product name, version) is the SAME declared for VeriFactu — one
// resolveVerifactuSoftware() for both (contract E) — plus the two TBAI-only
// values, validated against the TicketBAI XSD lengths:
//   TBAI_LICENSE_KEY     LicenciaTBAI granted by the diputación foral (≤20)   required in TBAI_MODE=production
//   TBAI_DEVICE_SERIAL   NumSerieDispositivo of this installation (≤30)      env fallback
// NumSerieDispositivo (Tanda 6b · L3, design §5.2 R7): the declared
// VerifactuInstallation of the billing centre with route `tbai` — one per
// hotel with `per_center`, one per sociedad with `per_entity` — supplies the
// serial; TBAI_DEVICE_SERIAL / VERIFACTU_INSTALL_NUMBER are the fallback for a
// centre without one (an error in TBAI_MODE=production, tolerated in sandbox).
// <Emisor> is the SOCIEDAD (issuerForInvoice → snapshot of the razón social).
// Blank values count as absent. In production a missing/invalid value blocks
// the send (row parked as rejected with SOFTWARE_NOT_CONFIGURED); sandbox
// tolerates the labelled defaults so the stub pipeline keeps working.
const TBAI_LICENSE_MAX = 20;
const TBAI_DEVICE_SERIAL_MAX = 30;
const TBAI_LICENSE_DEFAULT = "TBAI-LIC-SIN-CONFIGURAR";

export type TbaiSoftwareBlock = {
  nif: string;
  name: string;
  licenseKey: string;
  developerName: string;
  softwareName: string;
  version: string;
  /** NumSerieDispositivo: the declared TBAI installation of the centre, else TBAI_DEVICE_SERIAL / VERIFACTU_INSTALL_NUMBER. */
  deviceSerial: string;
};

export type TbaiSoftwareOptions = {
  /** Declared installation (route `tbai`) of the chain; `null` = none declared. `undefined` keeps the env-only behaviour. */
  installation?: Pick<NonNullable<VerifactuChainScope["installation"]>, "id" | "numeroInstalacion"> | null;
  /** TBAI_MODE=production: a missing installation is an error, never a fallback to the env. */
  requireInstallation?: boolean;
};

function readEnv(env: NodeJS.ProcessEnv, name: string): string | null {
  const raw = env[name];
  if (raw === undefined || raw === null) return null;
  const trimmed = String(raw).trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function resolveTbaiSoftware(env: NodeJS.ProcessEnv = process.env, options: TbaiSoftwareOptions = {}): { ok: boolean; errors: string[]; software: TbaiSoftwareBlock } {
  // The producer block is shared with VeriFactu; the installation (if any) decides the serial.
  const base = resolveVerifactuSoftware(env, options.installation === undefined ? {} : { installation: options.installation, requireInstallation: options.requireInstallation });
  const errors = [...base.errors];
  const licenseKey = readEnv(env, "TBAI_LICENSE_KEY");
  if (!licenseKey) errors.push("Falta TBAI_LICENSE_KEY (licencia TicketBAI concedida por la diputación foral).");
  else if (licenseKey.length > TBAI_LICENSE_MAX) errors.push(`TBAI_LICENSE_KEY supera los ${TBAI_LICENSE_MAX} caracteres del XSD (${licenseKey.length}).`);
  // Declared installation first (its number IS the device serial); the env only when none is declared.
  const deviceSerial = options.installation ? options.installation.numeroInstalacion : (readEnv(env, "TBAI_DEVICE_SERIAL") ?? base.software.numeroInstalacion);
  if (deviceSerial.length > TBAI_DEVICE_SERIAL_MAX) {
    errors.push(`${options.installation ? "La instalación TicketBAI declarada" : "TBAI_DEVICE_SERIAL"} (NumSerieDispositivo) supera los ${TBAI_DEVICE_SERIAL_MAX} caracteres del XSD (${deviceSerial.length}).`);
  }
  return {
    ok: errors.length === 0,
    errors,
    software: {
      nif: base.software.nif,
      name: base.software.nombreSistema,
      licenseKey: licenseKey ?? TBAI_LICENSE_DEFAULT,
      developerName: base.software.nombreRazon,
      softwareName: base.software.nombreSistema,
      version: base.software.version,
      deviceSerial
    }
  };
}

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

  // FISC-03: issuer identity from the invoice snapshot (see issuer-identity.service.ts).
  const issuer = await issuerForInvoice(invoice);
  const emitterTaxId = issuer.taxId;
  const emitterName = issuer.legalName;
  const lines = await prisma.invoiceLine.findMany({ where: { invoiceId } });

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

  const tbaiMode = process.env.TBAI_MODE === "production" ? "production" : "sandbox";
  // R7: the declared TBAI installation of the centre (per centre or per sociedad) is the NumSerieDispositivo.
  const chain = await resolveVerifactuChainScope(prisma, invoice.propertyId, "tbai");
  const tbaiSoftware = resolveTbaiSoftware(process.env, { installation: chain.installation, requireInstallation: tbaiMode === "production" });

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
    software: tbaiSoftware.software
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

  // Production sends need the real producer block; a half-configured one is
  // an operator error, not a hacienda rejection — park it as retryable.
  const response =
    tbaiMode === "production" && !tbaiSoftware.ok
      ? {
          status: "rejected" as const,
          territory,
          endpoint: `tbai:${territory}`,
          errorCode: "SOFTWARE_NOT_CONFIGURED",
          errorMessage: `Bloque Software TicketBAI incompleto: ${tbaiSoftware.errors.join(" ")}`
        }
      : await submitTbaiRegistro({ territory, invoiceNumber: invoice.invoiceNumber, emitterTaxId, xmlPayload: signed.signedXml });
  const finalStatus =
    response.status === "accepted"
      ? "accepted"
      : response.status === "rejected" && response.errorCode !== "SOFTWARE_NOT_CONFIGURED"
        ? "rejected"
        : "retrying";

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
    afterJson: {
      submissionId: submission.id,
      territory,
      status: finalStatus,
      tbaiCode: response.tbaiCode,
      errorCode: response.errorCode,
      installationId: chain.installation?.id ?? null,
      deviceSerial: tbaiSoftware.software.deviceSerial,
      emitterTaxId,
      emitterName
    }
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
