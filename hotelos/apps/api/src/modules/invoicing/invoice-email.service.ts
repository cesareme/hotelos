// Invoice by email (finanzas · lote facturación-cobros, 2026-09-15).
//
// POST /invoices/:id/send-email renders the invoice PDF, composes the Spanish
// system template below and delivers it through the configured email
// provider (EMAIL_PROVIDER = postmark | sendgrid, same credentials as the
// notifications module) WITH the PDF attached. When no provider is configured
// nothing leaves the box: the API answers `{ status: "simulated", simulated:
// true }` and the delivery row / audit event say SIMULADO — never «enviado».
// A provider failure is a 502 EMAIL_DELIVERY_FAILED with the provider's
// reason (the delivery row keeps it for a retry).
//
// Why the send is implemented here and not through notifications/dispatcher:
// the dispatcher's provider contract has no attachments and its template
// resolver only knows the organisation rows + SYSTEM_TEMPLATES (both outside
// this lote). The delivery is persisted in the same NotificationDelivery
// table (templateCode "invoice_email") so the admin UI lists it like any
// other message. Handoff: add `attachments` to ProviderSendInput /
// email.provider.send and INVOICE_EMAIL_SYSTEM_TEMPLATE to SYSTEM_TEMPLATES,
// then this module can delegate to dispatch().
//
// Permission (Tanda L3 · lote E, 2026-09-18): the route keeps `invoice.issue`
// (manifest entry `POST /invoices/:id/send-email`, medium) — the SAME key the
// service requires below, so the edge and the service never disagree.
// Decision §6.11 stays OPEN: a cashier profile that can download the PDF
// (`invoice.read`) cannot send it; lowering the gate to `invoice.read` /
// `payment.capture` changes the manifest (lote B owns it) and the department
// templates, so it is reported to the integrator, not decided here.
//
// Attachment (Tanda L3 · lote E): the rendered bytes are verified BEFORE the
// delivery row is written (`%PDF-` magic, `assertPdfAttachment`) in every
// mode — a simulated send never records an attachment that is not a PDF —
// and the delivery / audit payloads carry the attachment metadata
// (filename, contentType, bytes, breakdownSource: whether the «Desglose de
// IVA» came from the snapshot, the stored breakdown or the lines).

import { prisma } from "@hotelos/database";
import type { Prisma } from "@hotelos/database";
import type { UserContext } from "../../lib/demo-store.js";
import { BadRequestError, ConflictError, HttpError, NotFoundError } from "../../lib/http-error.js";
import { recordAuditEvent, recordDomainEvent } from "../audit/audit.service.js";
import { requirePermissions } from "../auth/auth.service.js";
import { emailStatus, type EmailStatus } from "../notifications/providers/email.provider.js";
import { renderTemplate } from "../notifications/template-renderer.service.js";
import { PAYMENT_ERROR_CODES, type InvoiceEmailResponse } from "../../../../../packages/shared/src/payments-types.js";
import { formatMoney, formatSpanishDate, renderInvoicePdf } from "./invoice-pdf.service.js";

export const INVOICE_EMAIL_TEMPLATE_CODE = "invoice_email";

/** System template (Spanish) — candidate for notifications/system-templates.ts SYSTEM_TEMPLATES. */
export const INVOICE_EMAIL_SYSTEM_TEMPLATE = Object.freeze({
  code: INVOICE_EMAIL_TEMPLATE_CODE,
  channel: "email" as const,
  language: "es",
  subject: "{{documentTitle}} {{invoiceNumber}} — {{issuerLegalName}}",
  body: [
    "Hola{{ recipientNameSuffix | default: \"\" }},",
    "",
    "Adjuntamos la {{documentTitleLower}} {{invoiceNumber}} de {{issuerLegalName}} (NIF {{issuerTaxId}}), expedida el {{issuedAt}}, por un importe total de {{total}}.",
    "",
    "{{ message | default: \"\" }}",
    "",
    "El documento adjunto en PDF incluye el desglose de IVA y el código QR de verificación de la AEAT.",
    "",
    "Si tiene cualquier duda sobre esta factura, responda a este correo.",
    "",
    "— {{issuerLegalName}}{{ propertyNameSuffix | default: \"\" }}"
  ].join("\n"),
  variables: ["documentTitle", "documentTitleLower", "invoiceNumber", "issuerLegalName", "issuerTaxId", "issuedAt", "total", "recipientNameSuffix", "message", "propertyNameSuffix"]
});

export type SendInvoiceByEmailInput = {
  context: UserContext;
  invoiceId: string;
  recipient: string;
  subject?: string;
  message?: string;
  correlationId: string;
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type EmailAttachment = { filename: string; contentType: string; content: Buffer };

const PDF_MAGIC = "%PDF-";

/** True when the buffer starts with the PDF magic (`%PDF-`) and has a body. Pure. */
export function isPdfAttachment(content: Buffer): boolean {
  return content.length > PDF_MAGIC.length && content.subarray(0, PDF_MAGIC.length).toString("latin1") === PDF_MAGIC;
}

/** 500 `INVOICE_PDF_INVALID` when the rendered bytes are not a PDF: nothing else is ever attached or recorded as sent. */
export function assertPdfAttachment(attachment: EmailAttachment, invoiceId: string): void {
  if (attachment.contentType === "application/pdf" && isPdfAttachment(attachment.content)) return;
  throw new HttpError(500, "No se pudo generar el PDF de la factura para adjuntarlo al correo.", true, {
    code: "INVOICE_PDF_INVALID",
    invoiceId,
    filename: attachment.filename,
    bytes: attachment.content.length
  });
}

/** Real HTTP delivery with attachment (Postmark / SendGrid), mirroring email.provider.send. */
export async function sendEmailWithAttachment(
  input: { recipient: string; subject: string; body: string; attachments: EmailAttachment[] },
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch
): Promise<{ status: "sent"; providerMessageId: string | null } | { status: "failed"; error: string }> {
  const provider = (env.EMAIL_PROVIDER ?? "").trim().toLowerCase();
  const key = (env.EMAIL_PROVIDER_KEY ?? "").trim();
  const from = (env.EMAIL_FROM ?? "").trim();
  try {
    if (provider === "postmark") {
      const response = await fetchImpl("https://api.postmarkapp.com/email", {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json", "X-Postmark-Server-Token": key },
        body: JSON.stringify({
          From: from,
          To: input.recipient,
          Subject: input.subject,
          TextBody: input.body,
          Attachments: input.attachments.map((a) => ({ Name: a.filename, Content: a.content.toString("base64"), ContentType: a.contentType }))
        })
      });
      const json = (await response.json().catch(() => ({}))) as { MessageID?: string };
      if (!response.ok) return { status: "failed", error: `Postmark HTTP ${response.status}: ${JSON.stringify(json).slice(0, 200)}` };
      return { status: "sent", providerMessageId: json.MessageID ?? null };
    }
    if (provider === "sendgrid") {
      const response = await fetchImpl("https://api.sendgrid.com/v3/mail/send", {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          personalizations: [{ to: [{ email: input.recipient }] }],
          from: { email: from },
          subject: input.subject,
          content: [{ type: "text/plain", value: input.body }],
          attachments: input.attachments.map((a) => ({ content: a.content.toString("base64"), type: a.contentType, filename: a.filename, disposition: "attachment" }))
        })
      });
      if (!response.ok) return { status: "failed", error: `SendGrid HTTP ${response.status}: ${(await response.text()).slice(0, 200)}` };
      return { status: "sent", providerMessageId: response.headers.get("x-message-id") };
    }
    return { status: "failed", error: `EMAIL_PROVIDER desconocido «${provider}» (usa postmark o sendgrid).` };
  } catch (error) {
    return { status: "failed", error: error instanceof Error ? error.message : String(error) };
  }
}

/** Subject / body of the invoice email from the system template. Pure. */
export function composeInvoiceEmail(input: {
  invoiceNumber: string;
  invoiceType: string;
  simplified: boolean;
  issuerLegalName: string;
  issuerTaxId: string | null;
  propertyName: string | null;
  issuedAt: string | null;
  total: number;
  currencyCode: string;
  customerName: string | null;
  subject?: string;
  message?: string;
}): { subject: string; body: string } {
  const documentTitle = input.invoiceType.startsWith("R") ? "Factura rectificativa" : input.simplified || input.invoiceType === "F2" ? "Factura simplificada" : "Factura";
  const rendered = renderTemplate({
    template: { subject: INVOICE_EMAIL_SYSTEM_TEMPLATE.subject, body: INVOICE_EMAIL_SYSTEM_TEMPLATE.body },
    variables: {
      documentTitle,
      documentTitleLower: documentTitle.toLowerCase(),
      invoiceNumber: input.invoiceNumber,
      issuerLegalName: input.issuerLegalName,
      issuerTaxId: input.issuerTaxId ?? "—",
      issuedAt: formatSpanishDate(input.issuedAt),
      total: formatMoney(input.total, input.currencyCode),
      recipientNameSuffix: input.customerName ? ` ${input.customerName}` : "",
      message: input.message?.trim() ?? "",
      propertyNameSuffix: input.propertyName && input.propertyName !== input.issuerLegalName ? ` · ${input.propertyName}` : ""
    }
  });
  return { subject: input.subject?.trim() || rendered.subject, body: rendered.body.replace(/\n{3,}/g, "\n\n") };
}

export async function sendInvoiceByEmail(input: SendInvoiceByEmailInput, deps: { status?: EmailStatus; send?: typeof sendEmailWithAttachment } = {}): Promise<InvoiceEmailResponse> {
  requirePermissions(input.context, ["invoice.issue"]);
  const invoice = await prisma.invoice.findUnique({ where: { id: input.invoiceId } });
  if (!invoice || invoice.deletedAt) throw new NotFoundError("Factura no encontrada.");
  const recipient = input.recipient?.trim().toLowerCase();
  if (!recipient || !EMAIL_RE.test(recipient)) throw new BadRequestError("recipient debe ser una dirección de correo válida.");
  if (invoice.status === "draft" || !invoice.invoiceNumber) {
    throw new ConflictError("La factura es un borrador sin número: emítela antes de enviarla.", { code: PAYMENT_ERROR_CODES.INVOICE_NOT_ISSUED, invoiceId: invoice.id });
  }
  const property = await prisma.property.findUnique({ where: { id: invoice.propertyId }, select: { organizationId: true } });
  const organizationId = property?.organizationId ?? input.context.organizationId;

  const { buffer, filename, model } = await renderInvoicePdf(invoice.id);
  const { subject, body } = composeInvoiceEmail({
    invoiceNumber: invoice.invoiceNumber,
    invoiceType: invoice.invoiceType,
    simplified: invoice.simplified,
    issuerLegalName: model.issuer.legalName,
    issuerTaxId: model.issuer.taxId,
    propertyName: model.issuer.propertyName,
    issuedAt: model.issuedAt,
    total: model.totals.total,
    currencyCode: model.currencyCode,
    customerName: model.customer.name,
    subject: input.subject,
    message: input.message
  });
  const status = deps.status ?? emailStatus();
  const attachment: EmailAttachment = { filename, contentType: "application/pdf", content: buffer };
  assertPdfAttachment(attachment, invoice.id);
  const attachmentMeta = { filename, contentType: attachment.contentType, bytes: buffer.length, breakdownSource: model.breakdownSource ?? null };

  const delivery = await prisma.notificationDelivery.create({
    data: {
      organizationId,
      propertyId: invoice.propertyId,
      notificationId: null,
      templateCode: INVOICE_EMAIL_TEMPLATE_CODE,
      channel: "email",
      recipient,
      status: "queued",
      subject,
      bodyRendered: body,
      payloadJson: { invoiceId: invoice.id, invoiceNumber: invoice.invoiceNumber, attachment: attachmentMeta } as Prisma.InputJsonValue,
      attempts: 0
    }
  });

  const now = new Date();
  if (status.mode !== "real") {
    const simulated = status.mode === "simulated";
    await prisma.notificationDelivery.update({
      where: { id: delivery.id },
      data: simulated
        ? { status: "sent", sentAt: now, attempts: 1, providerMessageId: `simulated_eml_${Date.now().toString(36)}`, errorMessage: "SIMULADO: proveedor de email no configurado; no se envió de verdad." }
        : { status: "failed", failedAt: now, attempts: 1, errorMessage: "Email deshabilitado en producción: configura EMAIL_PROVIDER, EMAIL_PROVIDER_KEY y EMAIL_FROM." }
    });
    recordAuditEvent({
      organizationId,
      propertyId: invoice.propertyId,
      actorUserId: input.context.userId,
      actorType: "user",
      action: simulated ? "INVOICE_EMAIL_SIMULATED" : "INVOICE_EMAIL_FAILED",
      entityType: "invoice",
      entityId: invoice.id,
      afterJson: { recipient, subject, deliveryId: delivery.id, simulated, emailMode: status.mode, attachment: attachmentMeta },
      correlationId: input.correlationId
    });
    if (!simulated) {
      throw new HttpError(502, "No se pudo enviar la factura: el proveedor de email no está configurado en producción (EMAIL_PROVIDER, EMAIL_PROVIDER_KEY, EMAIL_FROM).", true, {
        code: PAYMENT_ERROR_CODES.EMAIL_DELIVERY_FAILED,
        deliveryId: delivery.id
      });
    }
    return {
      invoiceId: invoice.id,
      invoiceNumber: invoice.invoiceNumber,
      recipient,
      status: "simulated",
      simulated: true,
      deliveryId: delivery.id,
      providerMessageId: null,
      attachment: { filename, contentType: "application/pdf", bytes: buffer.length },
      sentAt: now.toISOString()
    };
  }

  const result = await (deps.send ?? sendEmailWithAttachment)({ recipient, subject, body, attachments: [attachment] });
  if (result.status === "failed") {
    await prisma.notificationDelivery.update({ where: { id: delivery.id }, data: { status: "failed", failedAt: now, attempts: 1, errorMessage: result.error } });
    recordAuditEvent({
      organizationId,
      propertyId: invoice.propertyId,
      actorUserId: input.context.userId,
      actorType: "user",
      action: "INVOICE_EMAIL_FAILED",
      entityType: "invoice",
      entityId: invoice.id,
      afterJson: { recipient, subject, deliveryId: delivery.id, error: result.error },
      correlationId: input.correlationId
    });
    throw new HttpError(502, `No se pudo enviar la factura por email: ${result.error}`, true, { code: PAYMENT_ERROR_CODES.EMAIL_DELIVERY_FAILED, deliveryId: delivery.id });
  }
  await prisma.notificationDelivery.update({ where: { id: delivery.id }, data: { status: "sent", sentAt: now, attempts: 1, providerMessageId: result.providerMessageId, errorMessage: null } });
  recordAuditEvent({
    organizationId,
    propertyId: invoice.propertyId,
    actorUserId: input.context.userId,
    actorType: "user",
    action: "INVOICE_EMAIL_SENT",
    entityType: "invoice",
    entityId: invoice.id,
    afterJson: { recipient, subject, deliveryId: delivery.id, providerMessageId: result.providerMessageId, provider: status.provider, attachment: attachmentMeta },
    correlationId: input.correlationId
  });
  recordDomainEvent({
    organizationId,
    propertyId: invoice.propertyId,
    entityType: "invoice",
    entityId: invoice.id,
    eventType: "InvoiceEmailSent",
    payload: { recipient, deliveryId: delivery.id, providerMessageId: result.providerMessageId },
    actorType: "user",
    actorUserId: input.context.userId,
    correlationId: input.correlationId
  });
  return {
    invoiceId: invoice.id,
    invoiceNumber: invoice.invoiceNumber,
    recipient,
    status: "sent",
    simulated: false,
    deliveryId: delivery.id,
    providerMessageId: result.providerMessageId,
    attachment: { filename, contentType: "application/pdf", bytes: buffer.length },
    sentAt: now.toISOString()
  };
}
