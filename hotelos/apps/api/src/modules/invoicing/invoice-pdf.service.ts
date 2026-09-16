// Invoice PDF (finanzas · lote facturación-cobros, 2026-09-15; estructura
// societaria · L3, 2026-09-16).
//
// GET /invoices/:id/pdf renders the fiscal document from the issuance
// snapshot (Invoice.snapshotJson — never from the live folio): issuer block
// with the SOCIEDAD (razón social, NIF, domicilio fiscal — RD 1619/2012
// 6.1.c-d) and the ESTABLISHMENT that expedited it (nombre comercial, código,
// dirección — art. 6.1.e; design §5.2 R2), recipient, lines, VAT breakdown
// per rate, totals, series/number, the VeriFactu QR (Invoice.qrPayload, the
// exact URL that was hashed) and the legal texts of simplified / rectifying /
// cancelled invoices. Drafts render as "BORRADOR — sin validez fiscal" without
// number or QR. Invoices issued before the snapshot column existed fall back
// to their InvoiceLine rows and persisted breakdown; the establishment block
// comes from the snapshot when frozen there (issued after L3) and from the
// live property otherwise.
//
// `buildInvoicePdf` is pure (model → Buffer) and unit-tested;
// `renderInvoicePdf` loads the model.

import { prisma } from "@hotelos/database";
import { NotFoundError } from "../../lib/http-error.js";
import { parseInvoiceSnapshot } from "./invoice-snapshot.js";
import { getInvoice, RECTIFYING_REASON_LABELS, structureFromSnapshotJson, type InvoiceRecord, type RectifyingReasonCode } from "./invoice.service.js";
import { ISSUER_TAX_ID_PLACEHOLDER, resolveIssuerIdentity, type IssuerEstablishment } from "./issuer-identity.service.js";
import { encodeQr } from "./pdf/qr-encoder.js";
import { A4, PdfDocument, type PdfPage, textWidth } from "./pdf/pdf-writer.js";

export type InvoicePdfLine = {
  description: string;
  quantity: number;
  unitPrice: number;
  taxRate: number;
  calificacion: string;
  total: number;
};

export type InvoicePdfEstablishment = Pick<IssuerEstablishment, "code" | "tradeName" | "addressLine">;

/** «Establecimiento: Hotel Faranda Rías Altas (RA) · Paseo Marítimo 1, Perillo (Oleiros), A Coruña». Pure. */
export function establishmentLine(establishment: InvoicePdfEstablishment): string {
  const name = establishment.code ? `${establishment.tradeName} (${establishment.code})` : establishment.tradeName;
  return establishment.addressLine ? `Establecimiento: ${name} · ${establishment.addressLine}` : `Establecimiento: ${name}`;
}

export type InvoicePdfModel = {
  invoiceId: string;
  invoiceNumber: string | null;
  invoiceType: string;
  status: "draft" | "issued" | "cancelled" | "rectified";
  issuedAt: string | null;
  cancelledAt: string | null;
  simplified: boolean;
  currencyCode: string;
  issuer: {
    /** Razón social of the sociedad (issuer snapshot). */
    legalName: string;
    taxId: string | null;
    /** Printed under the NIF: the domicilio fiscal of the sociedad when known, else the establishment address (legacy). */
    address: string | null;
    propertyName: string;
    placeholder: boolean;
    legalFooter: string | null;
    /** Domicilio fiscal of the sociedad (null while it has none configured). Optional for older callers. */
    fiscalAddress?: string | null;
    /** Establishment block (art. 6.1.e RD 1619/2012): «Establecimiento: <nombre comercial> (<código>) · <dirección>». */
    establishment?: InvoicePdfEstablishment | null;
  };
  customer: { type: string; name: string | null; taxId: string | null };
  lines: InvoicePdfLine[];
  breakdown: Array<{ figure: string; calificacion: string; ratePercent: number; base: number; quota: number }>;
  totals: { base: number; tax: number; total: number };
  rectification: { originalNumber: string | null; reasonCode: string; reasonLabel: string; type: "I" | "S" | null } | null;
  payment: { paidTotal: number; balanceDue: number; status: string } | null;
  /** VeriFactu QR URL (Invoice.qrPayload); null on drafts. */
  qrUrl: string | null;
  verifactuHash: string | null;
  /** Why the document carries no VeriFactu record (sociedad in the SII, RD 1007/2023 art. 3.3); null / absent when it does. Frozen in the snapshot at issuance. */
  verifactuExclusion?: { code: string; motivo: string } | null;
  stay: { reservationCode: string | null; arrivalDate: string | null; departureDate: string | null } | null;
  warnings: string[];
};

const MARGIN = 40;
const CONTENT_WIDTH = A4.width - MARGIN * 2;
const LINE_HEIGHT = 14;
const CUSTOMER_TYPE_LABELS: Record<string, string> = { guest: "Huésped", company: "Empresa", agency: "Agencia" };

/** "1.234,56 €" (or the ISO code for non-EUR). Pure. */
export function formatMoney(value: number, currencyCode = "EUR"): string {
  const negative = value < 0;
  const fixed = Math.abs(value).toFixed(2);
  const [int, frac] = fixed.split(".");
  const grouped = int!.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  const symbol = currencyCode === "EUR" ? "€" : currencyCode;
  return `${negative ? "-" : ""}${grouped},${frac} ${symbol}`;
}

/** dd/mm/yyyy in Europe/Madrid. Pure. */
export function formatSpanishDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("es-ES", { timeZone: "Europe/Madrid", day: "2-digit", month: "2-digit", year: "numeric" }).format(date);
}

function documentTitle(model: InvoicePdfModel): string {
  if (model.invoiceType.startsWith("R")) return "FACTURA RECTIFICATIVA";
  if (model.simplified || model.invoiceType === "F2") return "FACTURA SIMPLIFICADA";
  return "FACTURA";
}

function rateLabel(group: { calificacion: string; ratePercent: number; figure: string }): string {
  if (group.calificacion === "N1") return "No sujeto";
  if (group.ratePercent === 0) return `${group.figure} 0 % (exento)`;
  return `${group.figure} ${String(group.ratePercent).replace(".", ",")} %`;
}

type Cursor = { page: PdfPage; y: number; pageNumber: number };

/** Render the model into a PDF buffer. Pure. */
export function buildInvoicePdf(model: InvoicePdfModel): Buffer {
  const doc = new PdfDocument({
    title: `${documentTitle(model)} ${model.invoiceNumber ?? "(borrador)"}`,
    author: model.issuer.legalName,
    subject: `${documentTitle(model)} ${model.invoiceNumber ?? ""} · ${model.issuer.legalName}`.trim()
  });
  const cursor: Cursor = { page: doc.addPage(), y: MARGIN, pageNumber: 1 };
  const isDraft = model.status === "draft";
  const title = documentTitle(model);

  const drawHeader = (): void => {
    const page = cursor.page;
    let y = MARGIN;
    // Sociedad first (razón social · NIF · domicilio fiscal), then the
    // establishment that expedited the document (R2). Without an
    // establishment block (legacy callers) the property name is printed as before.
    page.text(MARGIN, y + 12, model.issuer.legalName, { font: "bold", size: 14 });
    page.text(A4.width - MARGIN, y + 12, title, { font: "bold", size: 16, align: "right" });
    y += 18;
    if (!model.issuer.establishment && model.issuer.propertyName && model.issuer.propertyName !== model.issuer.legalName) {
      page.text(MARGIN, y + 10, model.issuer.propertyName, { size: 10 });
      y += LINE_HEIGHT;
    }
    page.text(MARGIN, y + 10, `NIF: ${model.issuer.taxId ?? "— sin NIF —"}`, { size: 10 });
    page.text(A4.width - MARGIN, y + 10, isDraft ? "BORRADOR — sin validez fiscal" : `Nº ${model.invoiceNumber ?? "—"}`, { font: "bold", size: 11, align: "right" });
    y += LINE_HEIGHT;
    // With an establishment block the address under the NIF is the sociedad's
    // domicilio fiscal only (the centre's address goes in its own line).
    const fiscalLine = model.issuer.fiscalAddress ?? (model.issuer.establishment ? null : model.issuer.address);
    if (fiscalLine) {
      page.text(MARGIN, y + 10, model.issuer.fiscalAddress ? `Domicilio fiscal: ${fiscalLine}` : fiscalLine, { size: 9, gray: 0.25 });
    }
    page.text(A4.width - MARGIN, y + 10, `Fecha de expedición: ${isDraft ? "—" : formatSpanishDate(model.issuedAt)}`, { size: 10, align: "right" });
    y += LINE_HEIGHT;
    if (model.issuer.establishment) {
      let line = establishmentLine(model.issuer.establishment);
      while (textWidth(line, 9) > CONTENT_WIDTH - 200 && line.length > 8) line = `${line.slice(0, -2).trimEnd()}…`;
      page.text(MARGIN, y + 10, line, { size: 9 });
      y += LINE_HEIGHT;
    }
    if (model.status === "cancelled") {
      page.text(A4.width - MARGIN, y + 10, `ANULADA el ${formatSpanishDate(model.cancelledAt)}`, { font: "bold", size: 11, align: "right" });
      y += LINE_HEIGHT;
    } else if (model.status === "rectified") {
      page.text(A4.width - MARGIN, y + 10, "RECTIFICADA (ver factura rectificativa)", { font: "bold", size: 10, align: "right" });
      y += LINE_HEIGHT;
    }
    y += 6;
    page.line(MARGIN, y, A4.width - MARGIN, y, 0.8);
    cursor.y = y + 12;
  };

  const drawFooter = (page: PdfPage, pageNumber: number): void => {
    page.text(A4.width - MARGIN, A4.height - 22, `Página ${pageNumber}`, { size: 8, gray: 0.4, align: "right" });
    page.text(MARGIN, A4.height - 22, `${title} ${model.invoiceNumber ?? "borrador"} · ${model.issuer.legalName} · NIF ${model.issuer.taxId ?? "—"}`, { size: 8, gray: 0.4 });
  };

  /** Start a new page when `height` does not fit; returns true when a page break happened. */
  const ensureSpace = (height: number): boolean => {
    if (cursor.y + height <= A4.height - MARGIN - 30) return false;
    drawFooter(cursor.page, cursor.pageNumber);
    cursor.page = doc.addPage();
    cursor.pageNumber += 1;
    drawHeader();
    return true;
  };

  drawHeader();

  // Recipient block.
  const page0 = cursor.page;
  page0.text(MARGIN, cursor.y + 10, "Destinatario", { font: "bold", size: 10 });
  cursor.y += LINE_HEIGHT;
  const recipientLines: string[] = [];
  if (model.customer.name) recipientLines.push(model.customer.name);
  if (model.customer.taxId) recipientLines.push(`NIF: ${model.customer.taxId}`);
  if (recipientLines.length === 0) recipientLines.push(model.simplified ? "Cliente no identificado (factura simplificada, art. 4 RD 1619/2012)" : "— destinatario no identificado —");
  recipientLines.push(`Tipo: ${CUSTOMER_TYPE_LABELS[model.customer.type] ?? model.customer.type}`);
  for (const line of recipientLines) {
    cursor.page.text(MARGIN, cursor.y + 10, line, { size: 10 });
    cursor.y += LINE_HEIGHT;
  }
  if (model.stay && (model.stay.reservationCode || model.stay.arrivalDate)) {
    const stay = [model.stay.reservationCode ? `Reserva ${model.stay.reservationCode}` : null, model.stay.arrivalDate ? `estancia ${formatSpanishDate(model.stay.arrivalDate)} – ${formatSpanishDate(model.stay.departureDate)}` : null]
      .filter(Boolean)
      .join(" · ");
    cursor.page.text(MARGIN, cursor.y + 10, stay, { size: 9, gray: 0.3 });
    cursor.y += LINE_HEIGHT;
  }
  if (model.rectification) {
    cursor.y += 4;
    cursor.page.text(MARGIN, cursor.y + 10, `Rectifica la factura ${model.rectification.originalNumber ?? "—"} · ${model.rectification.reasonLabel}`, { font: "bold", size: 9 });
    cursor.y += LINE_HEIGHT;
    cursor.page.text(
      MARGIN,
      cursor.y + 10,
      model.rectification.type === "S"
        ? "Rectificación por sustitución: este documento sustituye íntegramente a la factura rectificada (art. 15 RD 1619/2012)."
        : "Rectificación por diferencias: los importes indican la variación respecto a la factura rectificada (art. 15 RD 1619/2012).",
      { size: 8.5, gray: 0.25 }
    );
    cursor.y += LINE_HEIGHT;
  }
  cursor.y += 8;

  // Lines table.
  const cols = { description: MARGIN, qty: MARGIN + 300, unit: MARGIN + 360, rate: MARGIN + 430, total: A4.width - MARGIN };
  const drawTableHeader = (): void => {
    const page = cursor.page;
    page.rect(MARGIN, cursor.y, CONTENT_WIDTH, LINE_HEIGHT + 2, { fill: true, gray: 0.92 });
    const baseline = cursor.y + 11;
    page.text(cols.description + 4, baseline, "Concepto", { font: "bold", size: 9 });
    page.text(cols.qty + 20, baseline, "Cant.", { font: "bold", size: 9, align: "right" });
    page.text(cols.unit + 50, baseline, "Precio (IVA incl.)", { font: "bold", size: 9, align: "right" });
    page.text(cols.rate + 40, baseline, "IVA", { font: "bold", size: 9, align: "right" });
    page.text(cols.total - 4, baseline, "Importe", { font: "bold", size: 9, align: "right" });
    cursor.y += LINE_HEIGHT + 4;
  };
  ensureSpace(LINE_HEIGHT * 3);
  drawTableHeader();
  for (const line of model.lines) {
    const maxDescription = cols.qty - cols.description - 10;
    let description = line.description;
    while (textWidth(description, 9) > maxDescription && description.length > 4) description = `${description.slice(0, -2).trimEnd()}…`;
    if (ensureSpace(LINE_HEIGHT)) drawTableHeader();
    const page = cursor.page;
    const baseline = cursor.y + 10;
    page.text(cols.description + 4, baseline, description, { size: 9 });
    page.text(cols.qty + 20, baseline, String(line.quantity).replace(".", ","), { size: 9, align: "right" });
    page.text(cols.unit + 50, baseline, formatMoney(line.unitPrice, model.currencyCode), { size: 9, align: "right" });
    page.text(cols.rate + 40, baseline, line.calificacion === "N1" ? "N/S" : `${String(line.taxRate).replace(".", ",")} %`, { size: 9, align: "right" });
    page.text(cols.total - 4, baseline, formatMoney(line.total, model.currencyCode), { size: 9, align: "right" });
    cursor.y += LINE_HEIGHT;
  }
  cursor.page.line(MARGIN, cursor.y + 2, A4.width - MARGIN, cursor.y + 2, 0.5, 0.5);
  cursor.y += 10;

  // Tax breakdown + totals.
  ensureSpace(LINE_HEIGHT * (model.breakdown.length + 5));
  const bx = MARGIN;
  const tx = A4.width - MARGIN - 200;
  cursor.page.text(bx, cursor.y + 10, "Desglose de IVA", { font: "bold", size: 9 });
  cursor.page.text(bx + 150, cursor.y + 10, "Base", { font: "bold", size: 9, align: "right" });
  cursor.page.text(bx + 230, cursor.y + 10, "Cuota", { font: "bold", size: 9, align: "right" });
  let by = cursor.y + LINE_HEIGHT;
  for (const group of model.breakdown) {
    cursor.page.text(bx, by + 10, rateLabel(group), { size: 9 });
    cursor.page.text(bx + 150, by + 10, formatMoney(group.base, model.currencyCode), { size: 9, align: "right" });
    cursor.page.text(bx + 230, by + 10, formatMoney(group.quota, model.currencyCode), { size: 9, align: "right" });
    by += LINE_HEIGHT;
  }
  let ty = cursor.y;
  const totalRow = (label: string, value: number, bold = false): void => {
    cursor.page.text(tx, ty + 10, label, { size: bold ? 11 : 9.5, font: bold ? "bold" : "regular" });
    cursor.page.text(A4.width - MARGIN, ty + 10, formatMoney(value, model.currencyCode), { size: bold ? 11 : 9.5, font: bold ? "bold" : "regular", align: "right" });
    ty += LINE_HEIGHT + (bold ? 2 : 0);
  };
  totalRow("Base imponible", model.totals.base);
  totalRow("Cuota IVA", model.totals.tax);
  cursor.page.line(tx, ty + 1, A4.width - MARGIN, ty + 1, 0.8);
  ty += 4;
  totalRow("TOTAL", model.totals.total, true);
  if (model.payment && model.status === "issued" && model.totals.total > 0) {
    cursor.page.text(tx, ty + 10, `Cobrado: ${formatMoney(model.payment.paidTotal, model.currencyCode)} · Pendiente: ${formatMoney(model.payment.balanceDue, model.currencyCode)}`, { size: 8.5, gray: 0.3 });
    ty += LINE_HEIGHT;
  }
  cursor.y = Math.max(by, ty) + 12;

  // QR + legal block.
  const qrSize = 99; // ≈ 35 mm, inside the 30–40 mm VeriFactu range
  ensureSpace(qrSize + LINE_HEIGHT * 4);
  const qrY = cursor.y;
  if (model.qrUrl && !isDraft) {
    try {
      const qr = encodeQr(model.qrUrl, "M");
      cursor.page.qr(MARGIN, qrY, qr.modules, qrSize);
    } catch {
      cursor.page.rect(MARGIN, qrY, qrSize, qrSize, { gray: 0.5 });
    }
    cursor.page.text(MARGIN + qrSize + 10, qrY + 12, "QR tributario", { font: "bold", size: 9 });
    cursor.page.text(MARGIN + qrSize + 10, qrY + 12 + LINE_HEIGHT, "Factura verificable en la sede electrónica de la AEAT", { size: 8.5 });
    cursor.page.text(MARGIN + qrSize + 10, qrY + 12 + LINE_HEIGHT * 2, "VERI*FACTU", { font: "bold", size: 8.5 });
    cursor.page.paragraph(MARGIN + qrSize + 10, qrY + 12 + LINE_HEIGHT * 3, model.qrUrl, CONTENT_WIDTH - qrSize - 10, { size: 7, gray: 0.35, lineHeight: 9 });
    if (model.verifactuHash) {
      cursor.page.text(MARGIN + qrSize + 10, qrY + qrSize - 2, `Huella: ${model.verifactuHash.slice(0, 32)}…`, { size: 6.5, gray: 0.45 });
    }
    cursor.y = qrY + qrSize + 10;
  } else if (!isDraft && model.verifactuExclusion) {
    // Sociedad outside the RRSIF: no huella, no QR, no VERI*FACTU legend — the reason is printed instead.
    const drawn = cursor.page.paragraph(MARGIN, qrY + 10, `Sin QR tributario: ${model.verifactuExclusion.motivo}`, CONTENT_WIDTH, { size: 8.5, gray: 0.3, lineHeight: 11 });
    cursor.y = qrY + drawn * 11 + 6;
  } else {
    cursor.page.text(MARGIN, qrY + 10, isDraft ? "Documento borrador: sin número, sin huella ni código QR hasta su emisión." : "Sin QR tributario (factura emitida sin registro VeriFactu).", { size: 8.5, gray: 0.3 });
    cursor.y = qrY + LINE_HEIGHT + 4;
  }

  const legal: string[] = [];
  if (model.simplified || model.invoiceType === "F2") {
    legal.push("Factura simplificada expedida al amparo del art. 4 del RD 1619/2012. Para deducir el IVA soportado solicite factura completa con sus datos fiscales.");
  }
  if (model.invoiceType.startsWith("R")) {
    legal.push(`Factura rectificativa (art. 15 RD 1619/2012) — causa ${model.rectification?.reasonLabel ?? model.invoiceType}.`);
  }
  if (model.status === "cancelled") {
    legal.push(
      model.verifactuExclusion
        ? "Este documento ha sido ANULADO: no produce efectos fiscales."
        : "Este documento ha sido ANULADO: no produce efectos fiscales. Registro de anulación comunicado según el sistema VeriFactu."
    );
  }
  if (model.issuer.placeholder) legal.push(`Emitida en sandbox con el NIF de relleno ${ISSUER_TAX_ID_PLACEHOLDER}: no es un documento fiscal válido.`);
  if (model.issuer.legalFooter) legal.push(model.issuer.legalFooter);
  for (const paragraph of legal) {
    const lines = Math.ceil(textWidth(paragraph, 7.5) / CONTENT_WIDTH) + 1;
    ensureSpace(lines * 10 + 4);
    const drawn = cursor.page.paragraph(MARGIN, cursor.y + 8, paragraph, CONTENT_WIDTH, { size: 7.5, gray: 0.3, lineHeight: 10 });
    cursor.y += drawn * 10 + 4;
  }
  drawFooter(cursor.page, cursor.pageNumber);
  return doc.render();
}

/** Model of an invoice for the PDF: snapshot first, InvoiceLine rows for legacy invoices. */
export async function loadInvoicePdfModel(invoiceId: string): Promise<InvoicePdfModel> {
  const record: InvoiceRecord = await getInvoice(invoiceId);
  const row = await prisma.invoice.findUnique({ where: { id: invoiceId }, select: { snapshotJson: true, simplified: true, reservationId: true, invoiceType: true } });
  if (!row) throw new NotFoundError("Factura no encontrada.");
  const snapshot = parseInvoiceSnapshot(row.snapshotJson);
  // Sociedad + establishment as frozen at issuance (L3); live property for older documents.
  const structure = structureFromSnapshotJson(row.snapshotJson);
  const identity = await resolveIssuerIdentity(record.propertyId);
  const establishment = structure.establishment ?? identity?.establishment ?? null;
  const fiscalAddress = structure.issuerFiscalAddress !== undefined ? structure.issuerFiscalAddress : (identity?.fiscalAddress ?? null);
  const original = record.rectifyingForId ? await prisma.invoice.findUnique({ where: { id: record.rectifyingForId }, select: { invoiceNumber: true } }) : null;
  const reservation = row.reservationId
    ? await prisma.reservation.findUnique({ where: { id: row.reservationId }, select: { code: true, arrivalDate: true, departureDate: true } })
    : null;
  const lines: InvoicePdfLine[] = (snapshot ? snapshot.lines : record.lines).map((line) => ({
    description: line.description,
    quantity: line.quantity,
    unitPrice: line.unitPrice,
    taxRate: line.taxRate,
    calificacion: line.taxCalificacion ?? "S1",
    total: line.total
  }));
  const breakdown = (snapshot ? snapshot.taxBreakdown : record.taxBreakdown).map((group) => ({
    figure: group.figure,
    calificacion: group.calificacion,
    ratePercent: group.ratePercent,
    base: group.base,
    quota: group.quota
  }));
  const total = snapshot ? snapshot.totals.total : record.total;
  const tax = snapshot ? snapshot.totals.taxTotal : record.taxTotal;
  const reasonCode = record.rectifyingReasonCode as RectifyingReasonCode | undefined;
  return {
    invoiceId: record.id,
    invoiceNumber: record.invoiceNumber ?? null,
    invoiceType: record.invoiceType,
    status: record.status,
    issuedAt: record.issuedAt ?? null,
    cancelledAt: record.cancelledAt ?? null,
    simplified: row.simplified || row.invoiceType === "F2",
    currencyCode: record.currencyCode,
    issuer: {
      legalName: record.issuer?.legalName ?? identity?.legalName ?? "",
      taxId: record.issuer?.taxId ?? null,
      address: fiscalAddress ?? establishment?.addressLine ?? identity?.address ?? null,
      propertyName: identity?.propertyName ?? "",
      placeholder: record.issuerTaxIdPlaceholder || record.issuer?.taxIdPlaceholder === true,
      legalFooter: identity?.legalFooter ?? null,
      fiscalAddress,
      establishment: establishment ? { code: establishment.code, tradeName: establishment.tradeName, addressLine: establishment.addressLine } : null
    },
    customer: { type: record.customerType, name: record.customerName, taxId: record.customerTaxId ?? null },
    lines,
    breakdown,
    totals: { base: Number((total - tax).toFixed(2)), tax, total },
    rectification: record.rectifyingForId
      ? {
          originalNumber: original?.invoiceNumber ?? null,
          reasonCode: reasonCode ?? record.invoiceType,
          reasonLabel: (reasonCode && RECTIFYING_REASON_LABELS[reasonCode]) ?? record.invoiceType,
          type: record.rectificationType
        }
      : null,
    payment: record.paymentStatus === "not_applicable" ? null : { paidTotal: record.paidTotal, balanceDue: record.balanceDue, status: record.paymentStatus },
    qrUrl: record.qrPayload ?? null,
    verifactuHash: record.verifactuHash ?? null,
    verifactuExclusion: structure.verifactuExclusion ?? null,
    stay: reservation
      ? { reservationCode: reservation.code, arrivalDate: reservation.arrivalDate.toISOString(), departureDate: reservation.departureDate.toISOString() }
      : null,
    warnings: record.warnings
  };
}

/** File name of the PDF: "FAC-2026-000016.pdf" (drafts: "borrador-<id>.pdf"). Pure. */
export function invoicePdfFilename(model: Pick<InvoicePdfModel, "invoiceNumber" | "invoiceId">): string {
  const base = (model.invoiceNumber ?? `borrador-${model.invoiceId}`).replace(/[^A-Za-z0-9._-]+/g, "_");
  return `${base}.pdf`;
}

export async function renderInvoicePdf(invoiceId: string): Promise<{ buffer: Buffer; filename: string; model: InvoicePdfModel }> {
  const model = await loadInvoicePdfModel(invoiceId);
  return { buffer: buildInvoicePdf(model), filename: invoicePdfFilename(model), model };
}
