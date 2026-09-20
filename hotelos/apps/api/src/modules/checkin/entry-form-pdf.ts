// PDF del parte de entrada de viajeros (Tanda CHK · W2-B). Modelo de la
// Orden INT/1922/2003 (parte de entrada) con los campos del Anexo I A.3 del
// RD 933/2021, rendido con el escritor PDF 1.4 propio de
// financial-statements/pdf-writer.ts (PdfDocument: texto y reglas, fuentes
// estándar, sin imágenes). Como el escritor no admite imágenes, la firma NO se
// incrusta como bitmap: el PDF lleva el hash SHA-256 del PNG de la firma, la
// fecha/hora y el método (touch_portal · touch_kiosk · touch_reception ·
// paper_scanned), que son los que enlazan el documento con la fila
// `signatures` (objectKey). Una página; el hotel lo conserva 3 años (art. 5.3).

import { createHash } from "node:crypto";
import type { GuestRegisterRecord } from "../../lib/demo-store.js";
import { A4, PdfDocument, pdfFit, pdfTextWidth } from "../financial-statements/pdf-writer.js";

export const ENTRY_FORM_LEGAL_FOOTER = "Orden INT/1922/2003 · RD 933/2021";
export const ENTRY_FORM_TITLE = "Parte de entrada de viajeros";

/** Establecimiento (cabecera): nombre comercial y dirección postal. */
export type EntryFormProperty = {
  name: string;
  tradeName?: string | null;
  address?: string | null;
  postalCode?: string | null;
  municipality?: string | null;
  province?: string | null;
  country?: string | null;
  /** Código del establecimiento en SES.Hospedajes, si consta. */
  sesEstablishmentCode?: string | null;
};

export type EntryFormSignature = {
  /** Id de la fila `signatures` (el `signatureObjectKey` del parte). */
  id: string;
  /** SHA-256 (hex) del PNG de la firma. Si falta se calcula sobre `signaturePng`. */
  sha256?: string;
  signedAt: string | Date;
  method: string;
};

/** Campos del parte que imprime el PDF (subconjunto del GuestRegisterRecord del API). */
export type EntryFormRecord = Pick<
  GuestRegisterRecord,
  | "id"
  | "firstName"
  | "surname1"
  | "surname2"
  | "sex"
  | "nationality"
  | "dateOfBirth"
  | "documentType"
  | "documentNumber"
  | "documentSupportNumber"
  | "residenceFullAddress"
  | "residenceLocality"
  | "residenceCountry"
  | "phoneMobile"
  | "phoneLandline"
  | "email"
  | "travellerCount"
  | "isMinor"
  | "kinshipRelationIfMinor"
  | "contractReference"
  | "contractDate"
  | "checkinAt"
  | "checkoutAt"
  | "paymentType"
  | "signedAt"
>;

export type EntryFormInput = {
  record: EntryFormRecord;
  property: EntryFormProperty;
  signature: EntryFormSignature;
  /** Fecha de generación (por defecto ahora). */
  generatedAt?: Date;
};

const SEX_LABELS: Record<string, string> = { H: "Hombre", M: "Mujer", O: "Otro / no consta", F: "Mujer" };
const METHOD_LABELS: Record<string, string> = {
  touch_portal: "firma táctil en el portal del huésped",
  touch_kiosk: "firma táctil en el kiosco",
  touch_reception: "firma táctil en recepción",
  paper_scanned: "firma en papel digitalizada"
};

function dash(value: string | number | null | undefined): string {
  if (value === undefined || value === null) return "—";
  const text = String(value).trim();
  return text ? text : "—";
}

function day(value: string | Date | null | undefined): string {
  if (!value) return "—";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return dash(String(value));
  return date.toISOString().slice(0, 10);
}

function dateTime(value: string | Date | null | undefined): string {
  if (!value) return "—";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return dash(String(value));
  return `${date.toISOString().slice(0, 10)} ${date.toISOString().slice(11, 16)} UTC`;
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Divide un texto en líneas que caben en `maxWidth` (corte por palabras; la última línea se recorta con elipsis). */
function wrap(text: string, size: number, maxWidth: number, maxLines: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (pdfTextWidth(candidate, "regular", size) <= maxWidth) {
      line = candidate;
      continue;
    }
    if (line) lines.push(line);
    line = word;
    if (lines.length === maxLines) break;
  }
  if (line && lines.length < maxLines) lines.push(line);
  if (lines.length > maxLines) lines.length = maxLines;
  if (lines.length === maxLines && words.join(" ") !== lines.join(" ")) {
    lines[maxLines - 1] = pdfFit(lines[maxLines - 1]!, "regular", size, maxWidth);
  }
  return lines.length > 0 ? lines : ["—"];
}

/**
 * Parte de entrada (una página A4): cabecera del establecimiento, tabla con los
 * campos del viajero (Anexo I A.3), datos de la estancia, bloque de firma con
 * hash/fecha/método y pie legal. Devuelve los bytes del PDF.
 */
export function renderEntryFormPdf(input: EntryFormInput, signaturePng?: Uint8Array): Buffer {
  const { record, property } = input;
  const signatureSha256 = input.signature.sha256 ?? (signaturePng ? sha256Hex(signaturePng) : undefined);
  if (!signatureSha256) throw new Error("renderEntryFormPdf: falta el hash de la firma (sha256 o PNG).");

  const doc = new PdfDocument({ title: `${ENTRY_FORM_TITLE} · ${dash(record.contractReference)}` });
  const page = doc.addPage();
  const margin = 40;
  const width = A4.width - margin * 2;
  const labelWidth = 150;
  let y = doc.height - margin;

  // Cabecera del establecimiento
  const propertyName = property.tradeName?.trim() || property.name;
  doc.text(page, margin, y, pdfFit(propertyName, "bold", 14, width), "bold", 14);
  y -= 16;
  const addressParts = [property.address, [property.postalCode, property.municipality].filter(Boolean).join(" "), property.province, property.country]
    .map((part) => (part ?? "").trim())
    .filter(Boolean);
  if (addressParts.length > 0) {
    doc.text(page, margin, y, pdfFit(addressParts.join(" · "), "regular", 9, width), "regular", 9);
    y -= 12;
  }
  if (property.sesEstablishmentCode) {
    doc.text(page, margin, y, `Código de establecimiento SES.Hospedajes: ${property.sesEstablishmentCode}`, "regular", 9);
    y -= 12;
  }
  y -= 4;
  doc.rule(page, margin, y, margin + width, y, 0.8);
  y -= 18;
  doc.text(page, margin, y, ENTRY_FORM_TITLE, "bold", 13);
  doc.textRight(page, margin + width, y, `Parte nº ${record.id}`, "regular", 8);
  y -= 20;

  const section = (title: string): void => {
    doc.text(page, margin, y, title, "bold", 10);
    y -= 4;
    doc.rule(page, margin, y, margin + width, y, 0.5);
    y -= 13;
  };
  const row = (label: string, value: string, options: { lines?: number } = {}): void => {
    doc.text(page, margin, y, label, "bold", 8.5);
    const lines = wrap(value, 9, width - labelWidth, options.lines ?? 1);
    for (const line of lines) {
      doc.text(page, margin + labelWidth, y, line, "regular", 9);
      y -= 12;
    }
  };

  // Anexo I A.3 · datos del viajero
  section("Datos del viajero (RD 933/2021, Anexo I A.3)");
  row("Nombre", dash(record.firstName));
  row("Primer apellido", dash(record.surname1));
  row("Segundo apellido", dash(record.surname2));
  row("Sexo", record.sex ? (SEX_LABELS[record.sex] ?? record.sex) : "—");
  row("Nacionalidad", dash(record.nationality));
  row("Fecha de nacimiento", day(record.dateOfBirth));
  row("Tipo de documento", dash(record.documentType));
  row("Número de documento", dash(record.documentNumber));
  row("Número de soporte", dash(record.documentSupportNumber));
  row("Dirección de residencia", dash(record.residenceFullAddress), { lines: 2 });
  row("Localidad", dash(record.residenceLocality));
  row("País de residencia", dash(record.residenceCountry));
  row("Teléfono", dash(record.phoneMobile ?? record.phoneLandline));
  row("Correo electrónico", dash(record.email));
  if (record.isMinor) {
    row("Menor de edad", "Sí");
    row("Parentesco", dash(record.kinshipRelationIfMinor));
  }
  y -= 6;

  // Anexo I A.2 · contrato / estancia
  section("Datos de la estancia");
  row("Referencia del contrato", dash(record.contractReference));
  row("Fecha del contrato", day(record.contractDate));
  row("Entrada", dateTime(record.checkinAt));
  row("Salida", dateTime(record.checkoutAt));
  row("Número de viajeros", dash(record.travellerCount));
  row("Tipo de pago", dash(record.paymentType));
  y -= 6;

  // Firma: hash, fecha y método (el escritor no incrusta imágenes)
  section("Firma del viajero (art. 4.2 RD 933/2021)");
  row("Firmado el", dateTime(input.signature.signedAt));
  row("Método", METHOD_LABELS[input.signature.method] ?? input.signature.method);
  row("Identificador de la firma", input.signature.id);
  row("SHA-256 del trazo (PNG)", signatureSha256, { lines: 2 });
  doc.text(page, margin, y, "La firma manuscrita digital se conserva como imagen en el registro de firmas; este hash la identifica.", "regular", 7.5);
  y -= 14;

  // Pie legal
  const generated = input.generatedAt ?? new Date();
  doc.rule(page, margin, margin + 12, margin + width, margin + 12, 0.5);
  doc.text(page, margin, margin, `${ENTRY_FORM_LEGAL_FOOTER} · Conservación 3 años (art. 5.3) · Generado ${dateTime(generated)}`, "regular", 7);

  return doc.toBuffer();
}
