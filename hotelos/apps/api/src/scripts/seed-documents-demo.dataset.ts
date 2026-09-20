// Documentos · Tanda T9 · lote T9-14 — dataset de demo FICTICIO del módulo de
// documentos (apps/api/src/scripts/seed-documents-demo.dataset.ts).
//
// Módulo PURO (patrón seed-reputation-demo.dataset.ts): sin Prisma, sin
// lecturas de entorno, sin red. Construye de forma DETERMINISTA (PRNG
// mulberry32 sembrado con `seed`; fechas relativas a `now` anclado a las
// 00:00 UTC) todo lo que el CLI seed-documents-demo.ts escribe:
//   · 3 proveedores inventados con CIF válido (letra de control calculada) y
//     cuenta 6xx por defecto: «Lavandería Cantábrica Demo SL» (628),
//     «Distribuciones Hosteleras Demo SA» (600), «Suministros Técnicos Demo SL»
//     (622); un profesional ficticio con retención IRPF 15 % que NO existe como
//     Supplier (la propuesta de alta la ve la oficina);
//   · 2 usuarios demo de la organización: documentos.centro@example.com
//     (plantilla receptionist, ámbito el centro) y documentos.oficina@example.com
//     (plantilla admin_clerk, ámbito la organización), contraseña hotelos-demo;
//   · 22 documentos con sus BYTES: 12 facturas (9 PDF nativos con pdf-writer,
//     3 PNG mínimos sin capa de texto —foto de móvil—, 1 XML Facturae 3.2.2),
//     6 albaranes PDF (4 casan con facturas, uno con +3 % de precio; 2 sin
//     factura) y 4 de correspondencia (carta, notificación con plazo, contrato,
//     otro); entre las facturas: una duplicada reenviada por correo (mismos
//     bytes), una que no cuadra (cuota impresa incorrecta), una con IVA 5 % y
//     una con retención 15 %;
//   · estado objetivo de cada documento (captured · sent_to_office · in_review ·
//     approved · posted · returned_to_centre · rejected · archived), la acción
//     de la oficina que lo lleva ahí, la valija (lote recibido / en tránsito)
//     y los cuerpos revisados que la aprobación envía al dominio;
//   · marcador demo: el título (nombre de fichero) empieza por
//     DEMO_TITLE_PREFIX y la nota de captura lleva DEMO_NOTE «(demo)»; los
//     usuarios se reconocen por e-mail y los proveedores por NIF: la purga solo
//     borra lo que cumple esos filtros;
//   · guardEnvFromFlags / explainSeedTarget: envoltorio puro de
//     evaluateDemoTarget (demo-guard.ts) con entorno EXPLÍCITO desde los flags;
//   · buildSeedPlan / buildPurgePlan: PlannedWrite[] para assertDemoTarget.
// Nada de aquí procede de la organización real ni de ninguna empresa o persona real.

import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import { z } from "zod";
import type { IncomingDocumentKind, IncomingDocumentSource, IncomingDocumentStatus } from "@hotelos/shared";
import { evaluateDemoTarget, type DemoGuardEnv, type PlannedWrite } from "../../../../packages/database/prisma/lib/demo-guard.js";
import { A4, PdfDocument, wrapText } from "../modules/invoicing/pdf/pdf-writer.js";

// ---------------------------------------------------------------------------
// Constantes públicas
// ---------------------------------------------------------------------------

/** Prefijo del título (nombre de fichero) de TODO documento demo: filtro de la purga. */
export const DEMO_TITLE_PREFIX = "demo-documentos-";
/** Nota de captura (searchText inicial + afterJson de DOCUMENT_CAPTURED). */
export const DEMO_NOTE = "(demo) seed documentos T9-14";
/** Contraseña ÚNICA de los dos usuarios demo (misma que reception@example.com del seed base). */
export const DEMO_PASSWORD = "hotelos-demo";
export const DEMO_DEFAULT_PROPERTY_ID = "prop_123";
export const DEMO_DEFAULT_SEED = 42;
export const DEMO_CENTRE_USER_EMAIL = "documentos.centro@example.com";
export const DEMO_OFFICE_USER_EMAIL = "documentos.oficina@example.com";
/** Remitentes ficticios de los documentos que llegan «por correo» (dominio reservado .example). */
export const DEMO_EMAIL_DOMAIN = "proveedores-demo.example";
/** Fecha de creación fija de los PDF (metadatos): los bytes solo dependen de `seed` y de las fechas del dataset. */
export const DEMO_PDF_CREATION_DATE = new Date("2026-09-20T08:00:00.000Z");

export const DEMO_INVOICES = 12;
export const DEMO_DELIVERY_NOTES = 6;
export const DEMO_CORRESPONDENCE = 4;
export const DEMO_DOCUMENTS = DEMO_INVOICES + DEMO_DELIVERY_NOTES + DEMO_CORRESPONDENCE;
export const DEMO_PNG_INVOICES = 3;

// ---------------------------------------------------------------------------
// NIF ficticios con letra de control válida
// ---------------------------------------------------------------------------

const CIF_CONTROL_LETTERS = "JABCDEFGHI";
const CIF_DIGIT_CONTROL_ONLY = "ABEH";
const CIF_LETTER_CONTROL_ONLY = "NPQRSW";
const DNI_LETTERS = "TRWAGMYFPDXBNJZSQVHLCKE";

/** CIF con carácter de control válido (Orden EHA/451/2008 art. 4) para 7 cifras inventadas. */
export function cifFor(organisationLetter: string, digits7: string): string {
  if (!/^\d{7}$/.test(digits7)) throw new Error("cifFor espera 7 dígitos");
  let sum = 0;
  for (let i = 0; i < 7; i++) {
    const n = Number(digits7[i]);
    if (i % 2 === 0) {
      const doubled = n * 2;
      sum += Math.floor(doubled / 10) + (doubled % 10);
    } else sum += n;
  }
  const control = (10 - (sum % 10)) % 10;
  const letter = organisationLetter.toUpperCase();
  const useLetter = CIF_LETTER_CONTROL_ONLY.includes(letter) && !CIF_DIGIT_CONTROL_ONLY.includes(letter);
  return `${letter}${digits7}${useLetter ? CIF_CONTROL_LETTERS[control] : String(control)}`;
}

/** NIF de persona física (8 cifras + letra) para un número inventado. */
export function nifFor(digits8: string): string {
  if (!/^\d{8}$/.test(digits8)) throw new Error("nifFor espera 8 dígitos");
  return `${digits8}${DNI_LETTERS[Number(digits8) % 23]}`;
}

// ---------------------------------------------------------------------------
// Proveedores y usuarios
// ---------------------------------------------------------------------------

export type DemoSupplierKey = "S1" | "S2" | "S3";

export type DemoSupplierSpec = {
  key: DemoSupplierKey;
  name: string;
  taxId: string;
  /** Cuenta 6xx por defecto de sus facturas. */
  defaultExpenseAccountCode: string;
  /** Tipo de IVA habitual de sus líneas (21 servicios, 10 alimentación). */
  taxRate: number;
  address: string;
  postalCode: string;
  city: string;
  province: string;
  email: string;
};

export const DEMO_SUPPLIERS: readonly DemoSupplierSpec[] = Object.freeze([
  { key: "S1", name: "Lavandería Cantábrica Demo SL", taxId: cifFor("B", "7654321"), defaultExpenseAccountCode: "628", taxRate: 21, address: "Polígono Industrial Demo, nave 7", postalCode: "15000", city: "A Coruña", province: "A Coruña", email: `facturacion.lavanderia@${DEMO_EMAIL_DOMAIN}` },
  { key: "S2", name: "Distribuciones Hosteleras Demo SA", taxId: cifFor("A", "2468013"), defaultExpenseAccountCode: "600", taxRate: 10, address: "Avenida del Puerto Demo, 21", postalCode: "36200", city: "Vigo", province: "Pontevedra", email: `pedidos.distribuciones@${DEMO_EMAIL_DOMAIN}` },
  { key: "S3", name: "Suministros Técnicos Demo SL", taxId: cifFor("B", "1357924"), defaultExpenseAccountCode: "622", taxRate: 21, address: "Calle de la Industria Demo, 4", postalCode: "33200", city: "Gijón", province: "Asturias", email: `soporte.suministros@${DEMO_EMAIL_DOMAIN}` }
]);

/** Profesional ficticio (autónomo): factura con retención 15 %; NO se da de alta como Supplier (la oficina ve la propuesta). */
export const DEMO_PROFESSIONAL = Object.freeze({
  name: "Gabinete Técnico Demo (profesional autónomo)",
  taxId: nifFor("87654321"),
  retentionRate: 15,
  expenseAccountCode: "623"
});

export type DemoUserKey = "centre" | "office";

export type DemoUserSpec = {
  key: DemoUserKey;
  email: string;
  fullName: string;
  templateKey: "receptionist" | "admin_clerk";
  scopeType: "property" | "organization";
};

export const DEMO_USERS: readonly DemoUserSpec[] = Object.freeze([
  { key: "centre", email: DEMO_CENTRE_USER_EMAIL, fullName: "Recepción del centro (demo documentos)", templateKey: "receptionist", scopeType: "property" },
  { key: "office", email: DEMO_OFFICE_USER_EMAIL, fullName: "Oficina de administración (demo documentos)", templateKey: "admin_clerk", scopeType: "organization" }
]);

// ---------------------------------------------------------------------------
// Opciones y PRNG
// ---------------------------------------------------------------------------

export const DEMO_DATASET_OPTIONS_SCHEMA = z
  .object({
    propertyId: z.string().trim().min(1).max(64),
    organizationId: z.string().trim().min(1).max(64),
    propertyName: z.string().trim().min(1).max(200).optional(),
    /** Sociedad destinataria de las facturas (NIF del cliente impreso en los PDF). */
    customer: z.object({ legalName: z.string().trim().min(1).max(200), taxId: z.string().trim().min(1).max(20) }).optional(),
    now: z.date().optional(),
    seed: z.number().int().min(0).max(2_147_483_647).optional()
  })
  .strict();

export type DemoDatasetOptions = z.input<typeof DEMO_DATASET_OPTIONS_SCHEMA>;

/** mulberry32: PRNG de 32 bits, determinista por semilla, en [0, 1). */
export function createPrng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** Las 00:00 UTC del día de `now`: ancla de todas las fechas del dataset. */
export function datasetAnchor(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

export function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function daysBefore(anchor: Date, days: number): Date {
  return new Date(anchor.getTime() - days * 86_400_000);
}

export function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

const eur = (n: number): string => `${n.toFixed(2).replace(".", ",")} €`;

// ---------------------------------------------------------------------------
// Contenido de los documentos
// ---------------------------------------------------------------------------

export type DemoLine = { description: string; quantity: number; unitPrice: number; taxRate: number; deliveryNoteRef?: string };

export type DemoInvoiceContent = {
  kind: "invoice";
  supplier: DemoSupplierKey | "professional";
  number: string;
  /** Días antes del ancla. */
  issueDaysAgo: number;
  lines: DemoLine[];
  retentionRate?: number;
  /** Cuota impresa = cuota real + delta (factura «que no cuadra»). */
  quotaError?: number;
};

export type DemoDeliveryNoteContent = {
  kind: "delivery_note";
  supplier: DemoSupplierKey;
  number: string;
  deliveryDaysAgo: number;
  lines: Array<{ description: string; quantity: number; unitPrice: number; unit: string }>;
};

export type DemoTextContent = {
  kind: "letter" | "administrative_notice" | "contract" | "other";
  title: string;
  sender: string;
  senderTaxId?: string;
  reference?: string;
  daysAgo: number;
  paragraphs: string[];
};

export type DemoDocumentContent = DemoInvoiceContent | DemoDeliveryNoteContent | DemoTextContent;

export type DemoTotals = { base: number; tax: number; printedTax: number; retention: number; total: number; byRate: Array<{ rate: number; base: number; quota: number }> };

export function invoiceTotals(content: Pick<DemoInvoiceContent, "lines" | "retentionRate" | "quotaError">): DemoTotals {
  const byRateMap = new Map<number, { base: number; quota: number }>();
  for (const line of content.lines) {
    const base = round2(line.quantity * line.unitPrice);
    const entry = byRateMap.get(line.taxRate) ?? { base: 0, quota: 0 };
    entry.base = round2(entry.base + base);
    byRateMap.set(line.taxRate, entry);
  }
  const byRate = [...byRateMap.entries()].map(([rate, entry]) => ({ rate, base: entry.base, quota: round2((entry.base * rate) / 100) }));
  const base = round2(byRate.reduce((s, r) => s + r.base, 0));
  const tax = round2(byRate.reduce((s, r) => s + r.quota, 0));
  const printedTax = round2(tax + (content.quotaError ?? 0));
  const retention = round2((base * (content.retentionRate ?? 0)) / 100);
  return { base, tax, printedTax, retention, total: round2(base + printedTax - retention), byRate };
}

export type DemoOfficeAction =
  | { type: "none" }
  | { type: "assign" }
  | { type: "approve_supplier_bill"; post: boolean; reviewFirst: boolean; matchWith: string | null }
  | { type: "approve_goods_receipt" }
  | { type: "approve_task"; task: { kind: "respond" | "pay" | "file" | "forward" | "verify"; title: string; description: string } }
  | { type: "archive_from_centre" }
  | { type: "reject_return"; reason: "illegible" | "missing_pages" | "other"; note: string }
  | { type: "reject_duplicate"; duplicateOf: string; note: string };

export type DemoDispatch = "received" | "in_transit" | null;

export type DemoDocumentSpec = {
  /** Código estable (INV-01, AL-04, LET-01…): identidad lógica del documento dentro del dataset. */
  code: string;
  fileName: string;
  format: "pdf" | "png" | "xml";
  source: IncomingDocumentSource;
  kindHint?: IncomingDocumentKind;
  /** Mismos bytes que otro documento (factura reenviada): se captura con allowDuplicate. */
  duplicateOf?: string;
  content: DemoDocumentContent;
  /** Estado en el que debe quedar tras la siembra. */
  target: IncomingDocumentStatus;
  office: DemoOfficeAction;
  dispatch: DemoDispatch;
  /** Retraso (días antes del ancla) de sentAt / capturedAt para mostrar SLA vencidos. */
  backdate?: { capturedDaysAgo: number; sentDaysAgo: number };
  emailMeta?: { from: string; subject: string };
  note: string;
};

// ---------------------------------------------------------------------------
// Renderizado: PDF (pdf-writer), PNG mínimo, Facturae
// ---------------------------------------------------------------------------

export type DemoCustomer = { legalName: string; taxId: string; propertyName: string };

export const DEFAULT_DEMO_CUSTOMER: DemoCustomer = Object.freeze({ legalName: "Grupo Hotelero Demo SL", taxId: "B12345674", propertyName: "Hotel Demo Madrid Centro" });

const FOOTER = "Documento ficticio generado por el seed de demo de ehotelOS. No corresponde a ninguna empresa ni persona real.";

function supplierOf(key: DemoSupplierKey): DemoSupplierSpec {
  const found = DEMO_SUPPLIERS.find((supplier) => supplier.key === key);
  if (!found) throw new Error(`Proveedor demo desconocido: ${key}`);
  return found;
}

function issuerOf(content: DemoInvoiceContent): { name: string; taxId: string; address: string; town: string } {
  if (content.supplier === "professional") return { name: DEMO_PROFESSIONAL.name, taxId: DEMO_PROFESSIONAL.taxId, address: "Rúa Ficticia Demo, 12", town: "15002 A Coruña" };
  const supplier = supplierOf(content.supplier);
  return { name: supplier.name, taxId: supplier.taxId, address: supplier.address, town: `${supplier.postalCode} ${supplier.city}` };
}

/** Factura PDF nativa (capa de texto) con cabecera, NIF, número, fechas, líneas, desglose de IVA, retención y total. */
export function invoicePdf(content: DemoInvoiceContent, anchor: Date, customer: DemoCustomer): Buffer {
  const issuer = issuerOf(content);
  const totals = invoiceTotals(content);
  const issueDate = isoDay(daysBefore(anchor, content.issueDaysAgo));
  const dueDate = isoDay(daysBefore(anchor, content.issueDaysAgo - 30));
  const doc = new PdfDocument({ title: `Factura ${content.number} (demo)`, author: issuer.name, creationDate: DEMO_PDF_CREATION_DATE });
  const page = doc.addPage();
  const left = 50;
  const right = A4.width - 50;
  let y = 60;
  page.text(left, y, "FACTURA", { font: "bold", size: 20 });
  y += 30;
  page.text(left, y, issuer.name, { font: "bold", size: 11 });
  y += 14;
  page.text(left, y, `NIF: ${issuer.taxId}`);
  y += 14;
  page.text(left, y, `${issuer.address} · ${issuer.town}`);
  y += 24;
  page.text(left, y, `Nº factura: ${content.number}`, { font: "bold" });
  page.text(right, y, `Fecha: ${issueDate}`, { align: "right" });
  y += 14;
  page.text(right, y, `Vencimiento: ${dueDate}`, { align: "right" });
  y += 22;
  page.text(left, y, "Cliente:", { font: "bold" });
  y += 14;
  page.text(left, y, customer.legalName);
  y += 14;
  page.text(left, y, `NIF: ${customer.taxId} · Centro: ${customer.propertyName}`);
  const refs = [...new Set(content.lines.map((line) => line.deliveryNoteRef).filter((ref): ref is string => Boolean(ref)))];
  if (refs.length > 0) {
    y += 14;
    page.text(left, y, `Albarán ${refs.join(", Albarán ")}`);
  }
  y += 26;
  page.text(left, y, "Concepto", { font: "bold" });
  page.text(340, y, "Cantidad", { font: "bold", align: "right" });
  page.text(420, y, "Precio", { font: "bold", align: "right" });
  page.text(right, y, "Importe", { font: "bold", align: "right" });
  y += 6;
  page.line(left, y, right, y);
  y += 14;
  for (const line of content.lines) {
    const wrapped = wrapText(line.description, 240, 10);
    wrapped.forEach((text, index) => page.text(left, y + index * 12, text));
    page.text(340, y, String(line.quantity), { align: "right" });
    page.text(420, y, eur(line.unitPrice), { align: "right" });
    page.text(right, y, eur(round2(line.quantity * line.unitPrice)), { align: "right" });
    y += 12 * Math.max(1, wrapped.length) + 4;
  }
  y += 10;
  page.line(300, y, right, y);
  y += 16;
  page.text(300, y, "Base imponible");
  page.text(right, y, eur(totals.base), { align: "right" });
  for (const group of totals.byRate) {
    y += 14;
    const quota = totals.byRate.length === 1 ? totals.printedTax : group.quota;
    page.text(300, y, `IVA ${group.rate} %`);
    page.text(right, y, eur(quota), { align: "right" });
  }
  if ((content.retentionRate ?? 0) > 0) {
    y += 14;
    page.text(300, y, `Retención IRPF ${content.retentionRate} %`);
    page.text(right, y, `-${eur(totals.retention)}`, { align: "right" });
  }
  y += 18;
  page.text(300, y, "TOTAL", { font: "bold", size: 12 });
  page.text(right, y, eur(totals.total), { font: "bold", size: 12, align: "right" });
  y += 40;
  page.paragraph(left, y, FOOTER, A4.width - 100, { size: 8, gray: 0.4 });
  return doc.render();
}

/** Albarán PDF nativo: número, proveedor, fecha de entrega, centro receptor y líneas con cantidad y precio. */
export function deliveryNotePdf(content: DemoDeliveryNoteContent, anchor: Date, customer: DemoCustomer): Buffer {
  const supplier = supplierOf(content.supplier);
  const deliveryDate = isoDay(daysBefore(anchor, content.deliveryDaysAgo));
  const doc = new PdfDocument({ title: `Albarán ${content.number} (demo)`, author: supplier.name, creationDate: DEMO_PDF_CREATION_DATE });
  const page = doc.addPage();
  const left = 50;
  const right = A4.width - 50;
  let y = 60;
  page.text(left, y, `ALBARÁN Nº ${content.number}`, { font: "bold", size: 18 });
  y += 30;
  page.text(left, y, supplier.name, { font: "bold", size: 11 });
  y += 14;
  page.text(left, y, `NIF: ${supplier.taxId}`);
  y += 14;
  page.text(left, y, `${supplier.address} · ${supplier.postalCode} ${supplier.city}`);
  y += 24;
  page.text(left, y, `Fecha de entrega: ${deliveryDate}`, { font: "bold" });
  y += 14;
  page.text(left, y, `Entregado en: ${customer.propertyName} (${customer.legalName}, NIF ${customer.taxId})`);
  y += 26;
  page.text(left, y, "Artículo", { font: "bold" });
  page.text(340, y, "Cantidad", { font: "bold", align: "right" });
  page.text(420, y, "Precio", { font: "bold", align: "right" });
  page.text(right, y, "Importe", { font: "bold", align: "right" });
  y += 6;
  page.line(left, y, right, y);
  y += 14;
  let base = 0;
  for (const line of content.lines) {
    const amount = round2(line.quantity * line.unitPrice);
    base = round2(base + amount);
    page.text(left, y, `${line.description} (${line.unit})`);
    page.text(340, y, String(line.quantity), { align: "right" });
    page.text(420, y, eur(line.unitPrice), { align: "right" });
    page.text(right, y, eur(amount), { align: "right" });
    y += 16;
  }
  y += 10;
  page.line(300, y, right, y);
  y += 16;
  // Sin las palabras «factura» ni «IVA»: el clasificador por reglas (documents-ai.rules.ts) las puntúa como factura.
  page.text(300, y, "Importe de la mercancía entregada");
  page.text(right, y, eur(base), { align: "right" });
  y += 40;
  page.text(left, y, "Recibido por: ________________________", { size: 9 });
  page.text(A4.width / 2 + 10, y, "Firma del transportista: ______________", { size: 9 });
  y += 30;
  page.paragraph(left, y, FOOTER, A4.width - 100, { size: 8, gray: 0.4 });
  return doc.render();
}

/** Carta / notificación / contrato / otro: título, remitente, referencia, fecha y párrafos. */
export function textDocumentPdf(content: DemoTextContent, anchor: Date, customer: DemoCustomer): Buffer {
  const date = isoDay(daysBefore(anchor, content.daysAgo));
  const doc = new PdfDocument({ title: `${content.title} (demo)`, author: content.sender, creationDate: DEMO_PDF_CREATION_DATE });
  const page = doc.addPage();
  const left = 50;
  const width = A4.width - 100;
  let y = 60;
  page.text(left, y, content.title, { font: "bold", size: 16 });
  y += 26;
  page.text(left, y, content.sender, { font: "bold", size: 11 });
  if (content.senderTaxId) {
    y += 14;
    page.text(left, y, `NIF: ${content.senderTaxId}`);
  }
  if (content.reference) {
    y += 14;
    page.text(left, y, `Referencia: ${content.reference}`);
  }
  y += 14;
  page.text(left, y, `Fecha: ${date}`);
  y += 20;
  page.text(left, y, `A la atención de: ${customer.legalName} · ${customer.propertyName}`);
  y += 24;
  for (const paragraph of content.paragraphs) {
    y = page.paragraph(left, y, paragraph, width, { size: 10, lineHeight: 13 }) + 10;
  }
  y += 20;
  page.paragraph(left, y, FOOTER, width, { size: 8, gray: 0.4 });
  return doc.render();
}

let CRC_TABLE: Uint32Array | null = null;

function crc32(data: Buffer): number {
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const byte of data) crc = (CRC_TABLE[(crc ^ byte) & 0xff] as number) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typed = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed), 0);
  return Buffer.concat([length, typed, crc]);
}

/** PNG RGB 16×16 válido (filtro 0, IDAT deflate) con un patrón derivado de `key`: bytes distintos por documento, sin capa de texto. */
export function photoPng(key: string): Buffer {
  const width = 16;
  const height = 16;
  const seedBytes = createHash("sha256").update(`${DEMO_NOTE}:${key}`).digest();
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const rows: number[] = [];
  for (let y = 0; y < height; y++) {
    rows.push(0);
    for (let x = 0; x < width; x++) {
      const s = seedBytes[(x + y * width) % seedBytes.length] as number;
      rows.push((s + x * 9) & 255, (s + y * 13) & 255, (s ^ (x * y)) & 255);
    }
  }
  const idat = deflateSync(Buffer.from(rows));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), pngChunk("IHDR", ihdr), pngChunk("IDAT", idat), pngChunk("IEND", Buffer.alloc(0))]);
}

function esc(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const fixed = (n: number): string => n.toFixed(2);

/** Facturae 3.2.2 mínima e internamente coherente (sin firma): entra como e-factura sin OCR. */
export function facturaeXml(content: DemoInvoiceContent, anchor: Date, customer: DemoCustomer): string {
  const issuer = issuerOf(content);
  const totals = invoiceTotals(content);
  const issueDate = isoDay(daysBefore(anchor, content.issueDaysAgo));
  const taxOutputs = totals.byRate
    .map((g) => `<Tax><TaxTypeCode>01</TaxTypeCode><TaxRate>${fixed(g.rate)}</TaxRate><TaxableBase><TotalAmount>${fixed(g.base)}</TotalAmount></TaxableBase><TaxAmount><TotalAmount>${fixed(g.quota)}</TotalAmount></TaxAmount></Tax>`)
    .join("");
  const withheld =
    (content.retentionRate ?? 0) > 0
      ? `<TaxesWithheld><Tax><TaxTypeCode>04</TaxTypeCode><TaxRate>${fixed(content.retentionRate ?? 0)}</TaxRate><TaxableBase><TotalAmount>${fixed(totals.base)}</TotalAmount></TaxableBase><TaxAmount><TotalAmount>${fixed(totals.retention)}</TotalAmount></TaxAmount></Tax></TaxesWithheld>`
      : "";
  const items = content.lines
    .map((line) => {
      const base = round2(line.quantity * line.unitPrice);
      const quota = round2((base * line.taxRate) / 100);
      return `<InvoiceLine><ItemDescription>${esc(line.description)}</ItemDescription><Quantity>${line.quantity}</Quantity><UnitOfMeasure>01</UnitOfMeasure><UnitPriceWithoutTax>${line.unitPrice.toFixed(6)}</UnitPriceWithoutTax><TotalCost>${fixed(base)}</TotalCost><GrossAmount>${fixed(base)}</GrossAmount><TaxesOutputs><Tax><TaxTypeCode>01</TaxTypeCode><TaxRate>${fixed(line.taxRate)}</TaxRate><TaxableBase><TotalAmount>${fixed(base)}</TotalAmount></TaxableBase><TaxAmount><TotalAmount>${fixed(quota)}</TotalAmount></TaxAmount></Tax></TaxesOutputs></InvoiceLine>`;
    })
    .join("");
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<fe:Facturae xmlns:fe="http://www.facturae.gob.es/formato/Versiones/Facturaev3_2_2.xml" xmlns:ds="http://www.w3.org/2000/09/xmldsig#">` +
    `<FileHeader><SchemaVersion>3.2.2</SchemaVersion><Modality>I</Modality><InvoiceIssuerType>EM</InvoiceIssuerType><Batch><BatchIdentifier>${esc(issuer.taxId)}${esc(content.number)}</BatchIdentifier><InvoicesCount>1</InvoicesCount><TotalInvoicesAmount><TotalAmount>${fixed(totals.total)}</TotalAmount></TotalInvoicesAmount><TotalOutstandingAmount><TotalAmount>${fixed(totals.total)}</TotalAmount></TotalOutstandingAmount><TotalExecutableAmount><TotalAmount>${fixed(totals.total)}</TotalAmount></TotalExecutableAmount><InvoiceCurrencyCode>EUR</InvoiceCurrencyCode></Batch></FileHeader>` +
    `<Parties><SellerParty><TaxIdentification><PersonTypeCode>J</PersonTypeCode><ResidenceTypeCode>R</ResidenceTypeCode><TaxIdentificationNumber>${esc(issuer.taxId)}</TaxIdentificationNumber></TaxIdentification><LegalEntity><CorporateName>${esc(issuer.name)}</CorporateName><AddressInSpain><Address>${esc(issuer.address)}</Address><PostCode>${esc(issuer.town.slice(0, 5))}</PostCode><Town>${esc(issuer.town.slice(6))}</Town><Province>${esc(issuer.town.slice(6))}</Province><CountryCode>ESP</CountryCode></AddressInSpain></LegalEntity></SellerParty>` +
    `<BuyerParty><TaxIdentification><PersonTypeCode>J</PersonTypeCode><ResidenceTypeCode>R</ResidenceTypeCode><TaxIdentificationNumber>${esc(customer.taxId)}</TaxIdentificationNumber></TaxIdentification><LegalEntity><CorporateName>${esc(customer.legalName)}</CorporateName><AddressInSpain><Address>Calle Demo, 1</Address><PostCode>28001</PostCode><Town>Madrid</Town><Province>Madrid</Province><CountryCode>ESP</CountryCode></AddressInSpain></LegalEntity></BuyerParty></Parties>` +
    `<Invoices><Invoice><InvoiceHeader><InvoiceNumber>${esc(content.number)}</InvoiceNumber><InvoiceDocumentType>FC</InvoiceDocumentType><InvoiceClass>OO</InvoiceClass></InvoiceHeader>` +
    `<InvoiceIssueData><IssueDate>${issueDate}</IssueDate><InvoiceCurrencyCode>EUR</InvoiceCurrencyCode><TaxCurrencyCode>EUR</TaxCurrencyCode><LanguageName>es</LanguageName></InvoiceIssueData>` +
    `<TaxesOutputs>${taxOutputs}</TaxesOutputs>${withheld}` +
    `<InvoiceTotals><TotalGrossAmount>${fixed(totals.base)}</TotalGrossAmount><TotalGrossAmountBeforeTaxes>${fixed(totals.base)}</TotalGrossAmountBeforeTaxes><TotalTaxOutputs>${fixed(totals.tax)}</TotalTaxOutputs><TotalTaxesWithheld>${fixed(totals.retention)}</TotalTaxesWithheld><InvoiceTotal>${fixed(totals.total)}</InvoiceTotal><TotalOutstandingAmount>${fixed(totals.total)}</TotalOutstandingAmount><TotalExecutableAmount>${fixed(totals.total)}</TotalExecutableAmount></InvoiceTotals>` +
    `<Items>${items}</Items></Invoice></Invoices>` +
    `</fe:Facturae>`
  );
}

// ---------------------------------------------------------------------------
// Especificación de los 22 documentos
// ---------------------------------------------------------------------------

type Prng = () => number;

/** Cantidad base + 0..3 unidades según el PRNG (mismo seed → mismas cantidades). */
function qty(prng: Prng, base: number): number {
  return base + Math.floor(prng() * 4);
}

function fileNameOf(code: string, format: "pdf" | "png" | "xml"): string {
  return `${DEMO_TITLE_PREFIX}${code.toLowerCase()}.${format}`;
}

function laundryLines(prng: Prng, ref?: string): DemoLine[] {
  return [
    { description: "Lavado y planchado de sábanas (kg)", quantity: qty(prng, 120), unitPrice: 1.25, taxRate: 21, ...(ref ? { deliveryNoteRef: ref } : {}) },
    { description: "Toallas de baño (unidad)", quantity: qty(prng, 40), unitPrice: 0.5, taxRate: 21, ...(ref ? { deliveryNoteRef: ref } : {}) }
  ];
}

function foodLines(prng: Prng, ref?: string, taxRate = 10): DemoLine[] {
  return [
    { description: "Café en grano 1 kg", quantity: qty(prng, 24), unitPrice: 9.5, taxRate, ...(ref ? { deliveryNoteRef: ref } : {}) },
    { description: "Zumo de naranja 1 l", quantity: qty(prng, 60), unitPrice: 1.8, taxRate, ...(ref ? { deliveryNoteRef: ref } : {}) }
  ];
}

function technicalLines(prng: Prng, ref?: string, unitPrice = 45): DemoLine[] {
  return [
    { description: "Revisión de climatización (hora)", quantity: qty(prng, 6), unitPrice, taxRate: 21, ...(ref ? { deliveryNoteRef: ref } : {}) },
    { description: "Filtro de aire (unidad)", quantity: qty(prng, 4), unitPrice: 12.5, taxRate: 21, ...(ref ? { deliveryNoteRef: ref } : {}) }
  ];
}

/** Líneas del albarán a partir de las de la factura (misma descripción, cantidades y precios salvo `priceFactor`). */
function noteLinesOf(lines: DemoLine[], priceFactor = 1): DemoDeliveryNoteContent["lines"] {
  return lines.map((line) => ({ description: line.description, quantity: line.quantity, unitPrice: round2(line.unitPrice * priceFactor), unit: /\(kg\)/.test(line.description) ? "kg" : /\(hora\)/.test(line.description) ? "h" : "ud" }));
}

export function buildDocumentSpecs(prng: Prng): DemoDocumentSpec[] {
  const s1 = supplierOf("S1");
  const s2 = supplierOf("S2");
  const s3 = supplierOf("S3");
  const inv04 = foodLines(prng, "AL-2026-0204");
  const inv05 = technicalLines(prng, "AL-2026-0305");
  const inv06 = laundryLines(prng, "AL-2026-0106");
  const inv07 = foodLines(prng, "AL-2026-0207");
  const al08 = laundryLines(prng);
  const al09 = technicalLines(prng);
  const specs: DemoDocumentSpec[] = [
    {
      code: "INV-01",
      fileName: fileNameOf("INV-01", "png"),
      format: "png",
      source: "mobile",
      kindHint: "invoice",
      content: { kind: "invoice", supplier: "S1", number: "F-2026-0101", issueDaysAgo: 1, lines: laundryLines(prng) },
      target: "captured",
      office: { type: "none" },
      dispatch: null,
      note: "Foto hecha con el móvil en recepción: sin capa de texto, la oficina rellenará los campos a mano."
    },
    {
      code: "INV-02",
      fileName: fileNameOf("INV-02", "pdf"),
      format: "pdf",
      source: "upload",
      content: { kind: "invoice", supplier: "S1", number: "F-2026-0102", issueDaysAgo: 9, lines: laundryLines(prng) },
      target: "sent_to_office",
      office: { type: "none" },
      dispatch: "in_transit",
      backdate: { capturedDaysAgo: 2, sentDaysAgo: 1 },
      note: "Enviada a la oficina ayer; el papel viaja en la valija (lote en tránsito)."
    },
    {
      code: "INV-03",
      fileName: fileNameOf("INV-03", "png"),
      format: "png",
      source: "mobile",
      kindHint: "invoice",
      content: { kind: "invoice", supplier: "S3", number: "F-2026-0303", issueDaysAgo: 12, lines: technicalLines(prng) },
      target: "returned_to_centre",
      office: { type: "reject_return", reason: "illegible", note: "La foto está movida y no se lee el número de factura: vuelve a capturarla con el escáner." },
      dispatch: "received",
      note: "Foto ilegible: la oficina la devuelve al centro (notificación al capturador)."
    },
    {
      code: "INV-04",
      fileName: fileNameOf("INV-04", "pdf"),
      format: "pdf",
      source: "upload",
      content: { kind: "invoice", supplier: "S2", number: "F-2026-0204", issueDaysAgo: 20, lines: inv04 },
      target: "posted",
      office: { type: "approve_supplier_bill", post: true, reviewFirst: false, matchWith: "AL-04" },
      dispatch: "received",
      note: "Factura contabilizada; cotejo completo con el albarán AL-2026-0204."
    },
    {
      code: "INV-05",
      fileName: fileNameOf("INV-05", "pdf"),
      format: "pdf",
      source: "upload",
      content: { kind: "invoice", supplier: "S3", number: "F-2026-0305", issueDaysAgo: 18, lines: inv05 },
      target: "posted",
      office: { type: "approve_supplier_bill", post: true, reviewFirst: false, matchWith: "AL-05" },
      dispatch: "received",
      note: "Factura contabilizada; el albarán AL-2026-0305 trae un precio un 3 % superior (varianza fuera de la tolerancia del 2 %)."
    },
    {
      code: "INV-06",
      fileName: fileNameOf("INV-06", "png"),
      format: "png",
      source: "mobile",
      kindHint: "invoice",
      content: { kind: "invoice", supplier: "S1", number: "F-2026-0106", issueDaysAgo: 16, lines: inv06 },
      target: "posted",
      office: { type: "approve_supplier_bill", post: true, reviewFirst: true, matchWith: "AL-06" },
      dispatch: "received",
      note: "Foto sin capa de texto: la oficina tecleó los campos (review) y aprobó con override; cotejo completo con AL-2026-0106."
    },
    {
      code: "INV-07",
      fileName: fileNameOf("INV-07", "pdf"),
      format: "pdf",
      source: "upload",
      content: { kind: "invoice", supplier: "S2", number: "F-2026-0207", issueDaysAgo: 6, lines: inv07 },
      target: "approved",
      office: { type: "approve_supplier_bill", post: false, reviewFirst: false, matchWith: "AL-07" },
      dispatch: "received",
      note: "Aprobada por la oficina: factura de proveedor en borrador pendiente de aprobar y contabilizar (separación de funciones)."
    },
    {
      code: "INV-08",
      fileName: fileNameOf("INV-08", "pdf"),
      format: "pdf",
      source: "email",
      duplicateOf: "INV-02",
      content: { kind: "invoice", supplier: "S1", number: "F-2026-0102", issueDaysAgo: 9, lines: [] },
      target: "rejected",
      office: { type: "reject_duplicate", duplicateOf: "INV-02", note: "La misma factura llegó reenviada por correo: ya está registrada." },
      dispatch: null,
      emailMeta: { from: s1.email, subject: "Reenvío factura F-2026-0102" },
      note: "Misma factura reenviada por correo (mismos bytes, capturada con allowDuplicate): rechazada como duplicado."
    },
    {
      code: "INV-09",
      fileName: fileNameOf("INV-09", "pdf"),
      format: "pdf",
      source: "upload",
      content: { kind: "invoice", supplier: "S3", number: "F-2026-0309", issueDaysAgo: 7, lines: technicalLines(prng), quotaError: -10 },
      target: "in_review",
      office: { type: "assign" },
      dispatch: "received",
      note: "No cuadra: la cuota de IVA impresa es 10 € inferior a la calculada (checks.totals en fallo); en revisión."
    },
    {
      code: "INV-10",
      fileName: fileNameOf("INV-10", "pdf"),
      format: "pdf",
      source: "upload",
      content: { kind: "invoice", supplier: "S2", number: "F-2026-0210", issueDaysAgo: 11, lines: foodLines(prng, undefined, 5) },
      target: "sent_to_office",
      office: { type: "none" },
      dispatch: "in_transit",
      backdate: { capturedDaysAgo: 8, sentDaysAgo: 7 },
      note: "IVA 5 % (tipo no admitido: registro manual); enviada hace una semana → SLA de la oficina incumplido."
    },
    {
      code: "INV-11",
      fileName: fileNameOf("INV-11", "xml"),
      format: "xml",
      source: "e_invoice",
      content: { kind: "invoice", supplier: "S3", number: "F-2026-0311", issueDaysAgo: 3, lines: technicalLines(prng) },
      target: "in_review",
      office: { type: "assign" },
      dispatch: null,
      note: "Factura electrónica Facturae 3.2.2: extracción determinista (confianza 1), sin papel."
    },
    {
      code: "INV-12",
      fileName: fileNameOf("INV-12", "pdf"),
      format: "pdf",
      source: "upload",
      content: { kind: "invoice", supplier: "professional", number: "2026-017", issueDaysAgo: 4, lines: [{ description: "Informe técnico de eficiencia energética (hora)", quantity: qty(prng, 10), unitPrice: 60, taxRate: 21 }], retentionRate: 15 },
      target: "in_review",
      office: { type: "assign" },
      dispatch: "received",
      note: "Profesional autónomo con retención IRPF 15 %, proveedor desconocido: la oficina ve la propuesta de alta."
    },
    {
      code: "AL-04",
      fileName: fileNameOf("AL-04", "pdf"),
      format: "pdf",
      source: "upload",
      content: { kind: "delivery_note", supplier: "S2", number: "AL-2026-0204", deliveryDaysAgo: 22, lines: noteLinesOf(inv04) },
      target: "posted",
      office: { type: "approve_goods_receipt" },
      dispatch: "received",
      note: "Recepción de mercancía registrada; casa con la factura F-2026-0204."
    },
    {
      code: "AL-05",
      fileName: fileNameOf("AL-05", "pdf"),
      format: "pdf",
      source: "upload",
      content: { kind: "delivery_note", supplier: "S3", number: "AL-2026-0305", deliveryDaysAgo: 19, lines: noteLinesOf(inv05, 1.03) },
      target: "posted",
      office: { type: "approve_goods_receipt" },
      dispatch: "received",
      note: "Recepción con precio un 3 % superior al facturado: la factura queda con varianza."
    },
    {
      code: "AL-06",
      fileName: fileNameOf("AL-06", "pdf"),
      format: "pdf",
      source: "upload",
      content: { kind: "delivery_note", supplier: "S1", number: "AL-2026-0106", deliveryDaysAgo: 17, lines: noteLinesOf(inv06) },
      target: "posted",
      office: { type: "approve_goods_receipt" },
      dispatch: "received",
      note: "Recepción registrada; casa con la factura F-2026-0106."
    },
    {
      code: "AL-07",
      fileName: fileNameOf("AL-07", "pdf"),
      format: "pdf",
      source: "upload",
      content: { kind: "delivery_note", supplier: "S2", number: "AL-2026-0207", deliveryDaysAgo: 8, lines: noteLinesOf(inv07) },
      target: "posted",
      office: { type: "approve_goods_receipt" },
      dispatch: "received",
      note: "Recepción registrada; casa con la factura F-2026-0207 (aprobada, aún sin contabilizar)."
    },
    {
      code: "AL-08",
      fileName: fileNameOf("AL-08", "pdf"),
      format: "pdf",
      source: "upload",
      content: { kind: "delivery_note", supplier: "S1", number: "AL-2026-0108", deliveryDaysAgo: 5, lines: noteLinesOf(al08) },
      target: "posted",
      office: { type: "approve_goods_receipt" },
      dispatch: "received",
      note: "Albarán sin factura todavía (KPI «albaranes sin factura»)."
    },
    {
      code: "AL-09",
      fileName: fileNameOf("AL-09", "pdf"),
      format: "pdf",
      source: "upload",
      content: { kind: "delivery_note", supplier: "S3", number: "AL-2026-0309", deliveryDaysAgo: 2, lines: noteLinesOf(al09) },
      target: "posted",
      office: { type: "approve_goods_receipt" },
      dispatch: "received",
      note: "Albarán sin factura todavía."
    },
    {
      code: "LET-01",
      fileName: fileNameOf("LET-01", "pdf"),
      format: "pdf",
      source: "email",
      kindHint: "letter",
      content: {
        kind: "letter",
        title: "Comunicación de cambio de datos bancarios",
        sender: s1.name,
        senderTaxId: s1.taxId,
        reference: "CLI-DEMO-2026-041",
        daysAgo: 14,
        paragraphs: [
          "Les comunicamos que a partir del próximo mes los pagos de nuestras facturas deberán realizarse en la nueva cuenta bancaria terminada en 1234, abierta a nombre de la sociedad.",
          "Rogamos actualicen la ficha de proveedor en su sistema de administración. La cuenta anterior quedará cancelada al final del trimestre.",
          "Sin otro particular, reciban un cordial saludo. Departamento de administración."
        ]
      },
      target: "archived",
      office: { type: "archive_from_centre" },
      dispatch: null,
      emailMeta: { from: s1.email, subject: "Cambio de datos bancarios" },
      note: "Carta de proveedor llegada por correo: archivada desde el centro (retención de correspondencia, 6 años)."
    },
    {
      code: "NOT-01",
      fileName: fileNameOf("NOT-01", "pdf"),
      format: "pdf",
      source: "upload",
      content: {
        kind: "administrative_notice",
        title: "NOTIFICACIÓN · Inspección técnica de instalaciones",
        sender: "Ayuntamiento Demo · Área de Urbanismo (ficticio)",
        reference: "Expediente DEMO-2026-0147",
        daysAgo: 3,
        paragraphs: [
          "Se les notifica la apertura del expediente de referencia para la inspección técnica de las instalaciones del establecimiento. Dispone de un plazo de diez días naturales desde la recepción de la presente notificación para presentar alegaciones y la documentación acreditativa.",
          "Transcurrido el plazo sin alegaciones, se continuará la tramitación del procedimiento conforme a la normativa aplicable.",
          "Este documento es una simulación con fines de demostración y no tiene efectos administrativos."
        ]
      },
      target: "archived",
      office: { type: "approve_task", task: { kind: "respond", title: "Presentar alegaciones a la notificación (demo)", description: "Expediente DEMO-2026-0147: preparar la documentación de las instalaciones y responder dentro del plazo." } },
      dispatch: "received",
      note: "Notificación administrativa ficticia con plazo: archivada con una tarea abierta (dueAt +10 días naturales)."
    },
    {
      code: "CON-01",
      fileName: fileNameOf("CON-01", "pdf"),
      format: "pdf",
      source: "upload",
      kindHint: "contract",
      content: {
        kind: "contract",
        title: "CONTRATO de mantenimiento de ascensores",
        sender: s3.name,
        senderTaxId: s3.taxId,
        reference: "CTR-DEMO-2026-09",
        daysAgo: 30,
        paragraphs: [
          "Las partes acuerdan la prestación del servicio de mantenimiento preventivo de los dos ascensores del establecimiento, con una visita mensual y atención de averías en veinticuatro horas.",
          "Cláusula primera: duración de un año prorrogable. Cláusula segunda: precio mensual según tarifa anexa. Cláusula tercera: cualquiera de las partes puede resolver el contrato con un preaviso de dos meses.",
          "Firmado por duplicado en el lugar y fecha indicados. Documento ficticio de demostración."
        ]
      },
      target: "archived",
      office: { type: "archive_from_centre" },
      dispatch: null,
      note: "Contrato archivado directamente desde el centro (6 años de retención)."
    },
    {
      code: "OTH-01",
      fileName: fileNameOf("OTH-01", "pdf"),
      format: "pdf",
      source: "upload",
      kindHint: "other",
      content: {
        kind: "other",
        title: "Catálogo de temporada (documento informativo)",
        sender: s2.name,
        daysAgo: 1,
        paragraphs: ["Resumen de artículos disponibles para la próxima temporada con condiciones de entrega. Sin efecto contable ni fiscal: el capturador lo clasificó como «otro».", "Documento ficticio de demostración."]
      },
      target: "captured",
      office: { type: "none" },
      dispatch: null,
      note: "Documento informativo sin efecto fiscal, aún en la bandeja del centro."
    }
  ];
  return specs;
}

// ---------------------------------------------------------------------------
// Dataset construido (bytes incluidos)
// ---------------------------------------------------------------------------

export type DemoDocument = DemoDocumentSpec & {
  bytes: Buffer;
  mimeType: "application/pdf" | "image/png" | "application/xml";
  sha256: string;
  sizeBytes: number;
};

export type DemoDispatchBatch = { key: "A" | "B"; codes: string[]; receive: boolean };

export type DemoDatasetStats = {
  documents: number;
  invoices: number;
  deliveryNotes: number;
  correspondence: number;
  byFormat: Record<"pdf" | "png" | "xml", number>;
  bySource: Partial<Record<IncomingDocumentSource, number>>;
  byTarget: Partial<Record<IncomingDocumentStatus, number>>;
  supplierBills: number;
  postedBills: number;
  goodsReceipts: number;
  tasks: number;
  dispatchBatches: number;
};

export type DocumentsDemoDataset = {
  propertyId: string;
  organizationId: string;
  seed: number;
  anchor: Date;
  customer: DemoCustomer;
  suppliers: readonly DemoSupplierSpec[];
  users: readonly DemoUserSpec[];
  documents: DemoDocument[];
  dispatch: DemoDispatchBatch[];
  stats: DemoDatasetStats;
};

function mimeOf(format: DemoDocumentSpec["format"]): DemoDocument["mimeType"] {
  return format === "pdf" ? "application/pdf" : format === "png" ? "image/png" : "application/xml";
}

function renderBytes(spec: DemoDocumentSpec, anchor: Date, customer: DemoCustomer): Buffer {
  if (spec.format === "png") return photoPng(spec.code);
  if (spec.format === "xml") {
    if (spec.content.kind !== "invoice") throw new Error(`${spec.code}: solo las facturas se generan como XML`);
    return Buffer.from(facturaeXml(spec.content, anchor, customer), "utf8");
  }
  switch (spec.content.kind) {
    case "invoice":
      return invoicePdf(spec.content, anchor, customer);
    case "delivery_note":
      return deliveryNotePdf(spec.content, anchor, customer);
    default:
      return textDocumentPdf(spec.content, anchor, customer);
  }
}

export function buildDocumentsDemoDataset(input: DemoDatasetOptions): DocumentsDemoDataset {
  const options = DEMO_DATASET_OPTIONS_SCHEMA.parse(input);
  const seed = options.seed ?? DEMO_DEFAULT_SEED;
  const anchor = datasetAnchor(options.now ?? new Date());
  const customer: DemoCustomer = {
    legalName: options.customer?.legalName ?? DEFAULT_DEMO_CUSTOMER.legalName,
    taxId: options.customer?.taxId ?? DEFAULT_DEMO_CUSTOMER.taxId,
    propertyName: options.propertyName ?? DEFAULT_DEMO_CUSTOMER.propertyName
  };
  const prng = createPrng(seed);
  const specs = buildDocumentSpecs(prng);
  const bytesByCode = new Map<string, Buffer>();
  const documents: DemoDocument[] = [];
  for (const spec of specs) {
    const bytes = spec.duplicateOf ? bytesByCode.get(spec.duplicateOf) : renderBytes(spec, anchor, customer);
    if (!bytes) throw new Error(`${spec.code}: duplicateOf ${spec.duplicateOf} debe declararse antes`);
    bytesByCode.set(spec.code, bytes);
    documents.push({ ...spec, bytes, mimeType: mimeOf(spec.format), sha256: createHash("sha256").update(bytes).digest("hex"), sizeBytes: bytes.length });
  }
  validateDocuments(documents);
  const dispatch: DemoDispatchBatch[] = [
    { key: "A", codes: documents.filter((doc) => doc.dispatch === "received").map((doc) => doc.code), receive: true },
    { key: "B", codes: documents.filter((doc) => doc.dispatch === "in_transit").map((doc) => doc.code), receive: false }
  ];
  const byFormat = { pdf: 0, png: 0, xml: 0 };
  const bySource: DemoDatasetStats["bySource"] = {};
  const byTarget: DemoDatasetStats["byTarget"] = {};
  for (const doc of documents) {
    byFormat[doc.format] += 1;
    bySource[doc.source] = (bySource[doc.source] ?? 0) + 1;
    byTarget[doc.target] = (byTarget[doc.target] ?? 0) + 1;
  }
  const bills = documents.filter((doc) => doc.office.type === "approve_supplier_bill");
  const stats: DemoDatasetStats = {
    documents: documents.length,
    invoices: documents.filter((doc) => doc.content.kind === "invoice").length,
    deliveryNotes: documents.filter((doc) => doc.content.kind === "delivery_note").length,
    correspondence: documents.filter((doc) => doc.content.kind !== "invoice" && doc.content.kind !== "delivery_note").length,
    byFormat,
    bySource,
    byTarget,
    supplierBills: bills.length,
    postedBills: bills.filter((doc) => doc.office.type === "approve_supplier_bill" && doc.office.post).length,
    goodsReceipts: documents.filter((doc) => doc.office.type === "approve_goods_receipt").length,
    tasks: documents.filter((doc) => doc.office.type === "approve_task").length,
    dispatchBatches: dispatch.filter((batch) => batch.codes.length > 0).length
  };
  return { propertyId: options.propertyId, organizationId: options.organizationId, seed, anchor, customer, suppliers: DEMO_SUPPLIERS, users: DEMO_USERS, documents, dispatch, stats };
}

/** Invariantes del dataset (la tabla es datos: se comprueba antes de tocar la BD). */
export function validateDocuments(documents: readonly DemoDocument[]): void {
  if (documents.length !== DEMO_DOCUMENTS) throw new Error(`Se esperaban ${DEMO_DOCUMENTS} documentos, hay ${documents.length}.`);
  const codes = new Set<string>();
  const names = new Set<string>();
  for (const doc of documents) {
    if (codes.has(doc.code)) throw new Error(`Código repetido: ${doc.code}`);
    codes.add(doc.code);
    if (!doc.fileName.startsWith(DEMO_TITLE_PREFIX)) throw new Error(`${doc.code}: el título debe empezar por ${DEMO_TITLE_PREFIX}`);
    if (names.has(doc.fileName)) throw new Error(`Nombre de fichero repetido: ${doc.fileName}`);
    names.add(doc.fileName);
    if (doc.duplicateOf && !codes.has(doc.duplicateOf)) throw new Error(`${doc.code}: duplicateOf ${doc.duplicateOf} desconocido`);
    if ((doc.source === "email" || doc.source === "e_invoice") && doc.dispatch !== null) throw new Error(`${doc.code}: un documento sin papel no va en la valija`);
    if (doc.office.type === "approve_supplier_bill" && doc.content.kind !== "invoice") throw new Error(`${doc.code}: solo una factura crea SupplierBill`);
    if (doc.office.type === "approve_goods_receipt" && doc.content.kind !== "delivery_note") throw new Error(`${doc.code}: solo un albarán crea GoodsReceipt`);
  }
  const png = documents.filter((doc) => doc.format === "png").length;
  if (png !== DEMO_PNG_INVOICES) throw new Error(`Se esperaban ${DEMO_PNG_INVOICES} PNG, hay ${png}.`);
  for (const doc of documents) {
    if (doc.office.type === "approve_supplier_bill" && doc.office.matchWith && !codes.has(doc.office.matchWith)) throw new Error(`${doc.code}: cotejo con ${doc.office.matchWith} desconocido`);
    if (doc.office.type === "reject_duplicate" && !codes.has(doc.office.duplicateOf)) throw new Error(`${doc.code}: duplicado de ${doc.office.duplicateOf} desconocido`);
  }
}

// ---------------------------------------------------------------------------
// Cuerpos que la oficina envía al dominio (revisados = los datos del papel)
// ---------------------------------------------------------------------------

export type DemoSupplierIds = Partial<Record<DemoSupplierKey, string>>;

/** SupplierBillRequest de una factura demo (la aprobación añade incomingDocumentId, source y receptionDate). */
export function supplierBillBodyOf(doc: DemoDocument, anchor: Date, supplierIds: DemoSupplierIds): Record<string, unknown> {
  if (doc.content.kind !== "invoice") throw new Error(`${doc.code}: no es una factura`);
  const content = doc.content;
  const totals = invoiceTotals(content);
  const account = content.supplier === "professional" ? DEMO_PROFESSIONAL.expenseAccountCode : supplierOf(content.supplier).defaultExpenseAccountCode;
  const supplierId = content.supplier === "professional" ? null : (supplierIds[content.supplier] ?? null);
  const issuer = issuerOf(content);
  return {
    ...(supplierId ? { supplierId } : { supplierName: issuer.name, supplierTaxId: issuer.taxId }),
    invoiceNumber: content.number,
    issueDate: isoDay(daysBefore(anchor, content.issueDaysAgo)),
    dueDate: isoDay(daysBefore(anchor, content.issueDaysAgo - 30)),
    ...(content.retentionRate !== undefined ? { retentionRate: content.retentionRate, retentionRowCode: "02" } : {}),
    expectedTotal: totals.total.toFixed(2),
    lines: content.lines.map((line) => {
      const base = round2(line.quantity * line.unitPrice);
      return {
        description: line.description,
        expenseAccountCode: account,
        base: base.toFixed(2),
        taxRate: line.taxRate,
        quota: round2((base * line.taxRate) / 100).toFixed(2),
        quantity: line.quantity.toFixed(3),
        unitPrice: line.unitPrice.toFixed(4),
        ...(line.deliveryNoteRef ? { deliveryNoteRef: line.deliveryNoteRef } : {})
      };
    })
  };
}

/** GoodsReceiptRequest de un albarán demo. */
export function goodsReceiptBodyOf(doc: DemoDocument, anchor: Date, supplierIds: DemoSupplierIds, receivedBy: string): Record<string, unknown> {
  if (doc.content.kind !== "delivery_note") throw new Error(`${doc.code}: no es un albarán`);
  const content = doc.content;
  const supplier = supplierOf(content.supplier);
  const supplierId = supplierIds[content.supplier];
  return {
    ...(supplierId ? { supplierId } : { supplierName: supplier.name, supplierTaxId: supplier.taxId }),
    deliveryNoteNumber: content.number,
    deliveryDate: isoDay(daysBefore(anchor, content.deliveryDaysAgo)),
    receivedBy,
    note: `${DEMO_NOTE} · ${doc.code}`,
    lines: content.lines.map((line) => ({
      description: line.description,
      quantityReceived: line.quantity.toFixed(3),
      unit: line.unit,
      unitPrice: line.unitPrice.toFixed(4),
      base: round2(line.quantity * line.unitPrice).toFixed(2),
      taxRate: supplier.taxRate
    }))
  };
}

/** Campos que la oficina teclea sobre una foto sin capa de texto (review) antes de aprobar. */
export function reviewedFieldsOf(doc: DemoDocument, anchor: Date): Record<string, unknown> {
  if (doc.content.kind !== "invoice") throw new Error(`${doc.code}: no es una factura`);
  const content = doc.content;
  const totals = invoiceTotals(content);
  const issuer = issuerOf(content);
  return {
    supplierName: issuer.name,
    supplierTaxId: issuer.taxId,
    invoiceNumber: content.number,
    issueDate: isoDay(daysBefore(anchor, content.issueDaysAgo)),
    baseTotal: totals.base.toFixed(2),
    taxTotal: totals.tax.toFixed(2),
    total: totals.total.toFixed(2),
    lines: content.lines.map((line) => ({ description: line.description, quantity: line.quantity, unitPrice: line.unitPrice.toFixed(4), base: round2(line.quantity * line.unitPrice).toFixed(2), taxRate: line.taxRate, ...(line.deliveryNoteRef ? { deliveryNoteRef: line.deliveryNoteRef } : {}) }))
  };
}

// ---------------------------------------------------------------------------
// Guarda demo con entorno explícito (sin leer el entorno del proceso)
// ---------------------------------------------------------------------------

export type SeedTargetDecision = "allowlist" | "confirmed" | "refused";

export type SeedTargetInput = { propertyId: string; orgId: string | null; allowReal: boolean; confirm: readonly string[]; action?: string };

export function guardEnvFromFlags(flags: { allowReal: boolean; confirm: readonly string[] }): DemoGuardEnv {
  const confirm = flags.confirm.map((value) => value.trim()).filter((value) => value.length > 0);
  return {
    SEED_ALLOW_REAL: flags.allowReal ? "1" : undefined,
    SEED_CONFIRM: confirm.length > 0 ? confirm.join(",") : undefined
  };
}

/** Decisión pura: allowlist demo, confirmada por id de propiedad u organización, o rechazada (con motivo). */
export function explainSeedTarget(input: SeedTargetInput): { decision: SeedTargetDecision; reason: string | null } {
  const action = input.action ?? "seed-documents-demo";
  const guardEnv = guardEnvFromFlags(input);
  const full = evaluateDemoTarget({ orgId: input.orgId, propertyId: input.propertyId, action }, guardEnv);
  if (full.allowed && full.via === "allowlist") return { decision: "allowlist", reason: null };
  if (!input.allowReal) return { decision: "refused", reason: full.allowed ? "Falta --allow-real." : full.reason };
  const byProperty = evaluateDemoTarget({ propertyId: input.propertyId, action }, guardEnv);
  if (byProperty.allowed && byProperty.via === "confirmed") return { decision: "confirmed", reason: null };
  if (input.orgId) {
    const byOrg = evaluateDemoTarget({ orgId: input.orgId, action }, guardEnv);
    if (byOrg.allowed && byOrg.via === "confirmed") return { decision: "confirmed", reason: null };
  }
  return { decision: "refused", reason: full.allowed ? `Falta --confirm ${input.propertyId}${input.orgId ? ` (o --confirm ${input.orgId})` : ""}.` : full.reason };
}

// ---------------------------------------------------------------------------
// Planes de escritura (solo filtros demo)
// ---------------------------------------------------------------------------

export type ExistingDemoState = {
  users: number;
  suppliers: number;
  documents: number;
  /** Claves de plantilla que faltan en los roles de la organización (top-up aditivo). */
  missingRoleKeys: number;
};

export function buildSeedPlan(dataset: DocumentsDemoDataset, existing: ExistingDemoState): PlannedWrite[] {
  const { organizationId, propertyId, stats } = dataset;
  const pending = Math.max(0, stats.documents - existing.documents);
  return [
    { table: "role_permissions", op: "createMany", count: existing.missingRoleKeys, where: `top-up ADITIVO de receptionist / admin_clerk (ROLE_PERMISSION_MAP) y documents.* del superusuario local de ${organizationId}; nunca revoca` },
    { table: "users", op: "upsert", count: dataset.users.length, where: `email IN (${dataset.users.map((user) => `'${user.email}'`).join(", ")}) · organization_id = '${organizationId}' (${existing.users} ya existen)` },
    { table: "user_role_assignments", op: "create", count: dataset.users.length, where: "una por usuario demo (centro: property; oficina: organization); solo si falta" },
    { table: "user_property_roles", op: "create", count: 1, where: "espejo dual-read del usuario del centro (solo si falta)" },
    { table: "organizations", op: "update", count: 1, where: "rbac_version + 1" },
    { table: "suppliers", op: "upsert", count: dataset.suppliers.length, where: `organization_id = '${organizationId}' AND tax_id IN (${dataset.suppliers.map((supplier) => `'${supplier.taxId}'`).join(", ")}) (${existing.suppliers} ya existen)` },
    { table: "incoming_documents", op: "create", count: pending, where: `property_id = '${propertyId}' AND title LIKE '${DEMO_TITLE_PREFIX}%' (+ document_files, document_pages, document_extractions vía captureIncomingDocuments + runDocumentPipeline; ${existing.documents} ya existen y se saltan)` },
    { table: "document_dispatch_batches", op: "create", count: stats.dispatchBatches, where: "valija A recibida en la oficina · valija B en tránsito" },
    { table: "ai_human_review_items", op: "create", count: pending, where: "reviewType incoming_document (cola de la oficina), una por documento con extracción" },
    { table: "supplier_bills", op: "create", count: stats.supplierBills, where: `incoming_document_id ∈ documentos demo (${stats.postedBills} contabilizadas: journal_entries + vat_book_entries en ${organizationId})` },
    { table: "goods_receipts", op: "create", count: stats.goodsReceipts, where: "incoming_document_id ∈ documentos demo (+ goods_receipt_lines, bill_line_matches)" },
    { table: "document_actions", op: "create", count: stats.tasks, where: "tarea con plazo de la notificación demo" },
    { table: "notifications", op: "create", count: 1, where: "devolución al centro (usuario demo del centro)" },
    { table: "audit_events", op: "create", where: "DOCUMENT_* / SUPPLIER_BILL_* / GOODS_RECEIPT_* / DocumentsDemoSeeded (nunca se borran)" }
  ];
}

export type PurgePlanCounts = Partial<Record<"bill_line_matches" | "journal_entries" | "vat_book_entries" | "withholding_tax_records" | "supplier_bills" | "goods_receipts" | "stock_movements" | "ai_human_review_items" | "notifications" | "document_dispatch_batches" | "document_files" | "incoming_documents" | "user_role_assignments" | "user_property_roles" | "sessions" | "users" | "suppliers", number>>;

/** Plan de purga: deleteMany acotados a la organización y a filas marcadas demo (título, e-mail, NIF o enlace a un documento demo). */
export function buildPurgePlan(input: { organizationId: string; propertyId: string; counts?: PurgePlanCounts }): PlannedWrite[] {
  const { organizationId, propertyId } = input;
  const counts = input.counts ?? {};
  const withCount = (table: keyof PurgePlanCounts, write: PlannedWrite): PlannedWrite => (typeof counts[table] === "number" ? { ...write, count: counts[table] } : write);
  const docs = `incoming_documents(organization_id = '${organizationId}' AND title LIKE '${DEMO_TITLE_PREFIX}%')`;
  return [
    withCount("bill_line_matches", { table: "bill_line_matches", op: "deleteMany", where: `supplier_bill_line_id ∈ líneas de supplier_bills(incoming_document_id ∈ ${docs})` }),
    withCount("journal_entries", { table: "journal_entries", op: "deleteMany", where: `organization_id = '${organizationId}' AND source_type = 'supplier_bill' AND source_id ∈ supplier_bills demo (+ journal_lines)` }),
    withCount("vat_book_entries", { table: "vat_book_entries", op: "deleteMany", where: `organization_id = '${organizationId}' AND source_type = 'supplier_bill' AND source_id ∈ supplier_bills demo` }),
    withCount("withholding_tax_records", { table: "withholding_tax_records", op: "deleteMany", where: "source_type = 'vendor_invoice' AND source_id ∈ supplier_bills demo" }),
    withCount("supplier_bills", { table: "supplier_bills", op: "deleteMany", where: `organization_id = '${organizationId}' AND incoming_document_id ∈ ${docs} (+ supplier_bill_lines en cascada)` }),
    withCount("stock_movements", { table: "stock_movements", op: "deleteMany", where: "source_type = 'goods_receipt' AND source_id ∈ goods_receipts demo" }),
    withCount("goods_receipts", { table: "goods_receipts", op: "deleteMany", where: `organization_id = '${organizationId}' AND incoming_document_id ∈ ${docs} (+ goods_receipt_lines en cascada)` }),
    withCount("ai_human_review_items", { table: "ai_human_review_items", op: "deleteMany", where: `organization_id = '${organizationId}' AND related_entity_type = 'incoming_document' AND related_entity_id ∈ ${docs}` }),
    withCount("notifications", { table: "notifications", op: "deleteMany", where: `organization_id = '${organizationId}' AND user_id ∈ usuarios demo` }),
    withCount("document_files", { table: "document_files", op: "deleteMany", where: `document_id ∈ ${docs} (storage.delete de cada clave no inline antes de borrar la fila; cascada)` }),
    withCount("incoming_documents", { table: "incoming_documents", op: "deleteMany", where: `organization_id = '${organizationId}' AND property_id = '${propertyId}' AND title LIKE '${DEMO_TITLE_PREFIX}%' (+ document_pages, document_extractions, document_actions en cascada)` }),
    withCount("document_dispatch_batches", { table: "document_dispatch_batches", op: "deleteMany", where: `id ∈ dispatch_batch_id de ${docs}` }),
    withCount("user_role_assignments", { table: "user_role_assignments", op: "deleteMany", where: `organization_id = '${organizationId}' AND user_id ∈ usuarios demo` }),
    withCount("user_property_roles", { table: "user_property_roles", op: "deleteMany", where: "user_id ∈ usuarios demo" }),
    withCount("sessions", { table: "sessions", op: "deleteMany", where: "user_id ∈ usuarios demo (+ devices, mfa_challenges)" }),
    withCount("users", { table: "users", op: "deleteMany", where: `organization_id = '${organizationId}' AND email IN (${DEMO_USERS.map((user) => `'${user.email}'`).join(", ")})` }),
    withCount("suppliers", { table: "suppliers", op: "deleteMany", where: `organization_id = '${organizationId}' AND tax_id IN (${DEMO_SUPPLIERS.map((supplier) => `'${supplier.taxId}'`).join(", ")})` })
  ];
}
