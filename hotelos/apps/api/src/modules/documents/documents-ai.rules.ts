// Documentos · Tanda T9 · lote T9-06a — respaldo por reglas del puerto de IA
// (apps/api/src/modules/documents/documents-ai.rules.ts; diseño §5.1 «Sin
// proveedor»).
//
// Qué hace, sin modelo, sin OCR y sin red:
//   · clasificación por palabras sobre la capa de texto (FACTURA / INVOICE →
//     invoice; ALBARÁN / DELIVERY NOTE → delivery_note; TICKET / RECIBO →
//     receipt; NOTIFICACIÓN / REQUERIMIENTO / AGENCIA TRIBUTARIA / DGT →
//     administrative_notice; CONTRATO → contract); sin texto → unknown con
//     confianza 0 (o el kindHint del capturador con confianza baja);
//   · extracción por expresiones regulares: NIF/CIF validado con
//     checkSpanishNif (payables/validators.ts), fechas dd/mm/aaaa y aaaa-mm-dd,
//     «Nº factura» / «Factura n.º» / «Invoice», «Base imponible», «IVA xx %»,
//     retención IRPF, «TOTAL», líneas «descripción cantidad precio importe»
//     y referencias de albarán; cobertura limitada y marcada `text_rules`;
//   · XML Facturae / UBL → parseEInvoice con confianza 1 y source `e_invoice`.
// Etiqueta honesta: describe() → { configured: false, provider: "none" }.
// Puro: sin Prisma, sin entorno; importa solo validadores y parsers locales.

import type { IncomingDocumentKind } from "@hotelos/shared";
import { checkSpanishNif } from "../payables/validators.js";
import { parseEInvoice, type ParsedEInvoice } from "./einvoice-parser.js";
import type {
  ClassifyDocumentInput,
  ClassifyDocumentOutput,
  DocumentExtractedFields,
  DocumentsAiContext,
  DocumentsAiDescription,
  DocumentsAiPort,
  ExtractDocumentInput,
  ExtractDocumentOutput,
  ExtractedField
} from "./documents-ai.port.js";
import { EXTRACTION_SCHEMA_VERSION, schemaKindFor } from "./extraction-schemas.js";

export const RULES_PROVIDER = "none";

/** Texto máximo que se analiza (el resto se ignora: las cabeceras están al principio). */
export const RULES_MAX_TEXT = 200_000;

// --- Clasificación -----------------------------------------------------------

type KeywordRule = { kind: IncomingDocumentKind; pattern: RegExp; weight: number };

/** Palabras clave por tipo (sin acentos ni mayúsculas: el texto se normaliza antes). */
export const CLASSIFY_RULES: readonly KeywordRule[] = Object.freeze([
  { kind: "invoice", pattern: /\bfactura(?:s)?\b/g, weight: 3 },
  { kind: "invoice", pattern: /\binvoice\b/g, weight: 3 },
  { kind: "invoice", pattern: /\bbase imponible\b/g, weight: 2 },
  { kind: "invoice", pattern: /\biva\s*\d{1,2}\s*%/g, weight: 1 },
  { kind: "delivery_note", pattern: /\balbaran(?:es)?\b/g, weight: 3 },
  { kind: "delivery_note", pattern: /\bdelivery note\b/g, weight: 3 },
  { kind: "delivery_note", pattern: /\bnota de entrega\b/g, weight: 3 },
  { kind: "receipt", pattern: /\bticket\b/g, weight: 3 },
  { kind: "receipt", pattern: /\brecibo\b/g, weight: 3 },
  { kind: "receipt", pattern: /\bfactura simplificada\b/g, weight: 2 },
  { kind: "administrative_notice", pattern: /\bnotificacion\b/g, weight: 3 },
  { kind: "administrative_notice", pattern: /\brequerimiento\b/g, weight: 3 },
  { kind: "administrative_notice", pattern: /\bagencia tributaria\b/g, weight: 3 },
  { kind: "administrative_notice", pattern: /\baeat\b/g, weight: 2 },
  { kind: "administrative_notice", pattern: /\bdgt\b/g, weight: 3 },
  { kind: "administrative_notice", pattern: /\bdireccion general de trafico\b/g, weight: 3 },
  { kind: "administrative_notice", pattern: /\bseguridad social\b/g, weight: 2 },
  { kind: "administrative_notice", pattern: /\bexpediente\b/g, weight: 1 },
  { kind: "administrative_notice", pattern: /\bsancion\b/g, weight: 2 },
  { kind: "contract", pattern: /\bcontrato\b/g, weight: 3 },
  { kind: "contract", pattern: /\bclausula(?:s)?\b/g, weight: 1 },
  { kind: "contract", pattern: /\bpartes\b/g, weight: 1 }
]);

/** Minúsculas sin acentos ni signos raros (las reglas se escriben ya normalizadas). */
export function normalizeForRules(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[º°]/g, "o")
    .replace(/\s+/g, " ");
}

/** Bonus por aparecer en las primeras 400 letras (título del documento). */
const HEAD_LENGTH = 400;

export function classifyByKeywords(input: ClassifyDocumentInput): ClassifyDocumentOutput {
  const raw = (input.text ?? "").slice(0, RULES_MAX_TEXT);
  const text = normalizeForRules(raw);
  if (text.trim().length === 0) {
    if (input.kindHint && input.kindHint !== "unknown") return { kind: input.kindHint, confidence: 0.3, source: "rules", note: "no_text_kind_hint" };
    return { kind: "unknown", confidence: 0, source: "rules", note: "no_text" };
  }
  const scores = new Map<IncomingDocumentKind, number>();
  const head = text.slice(0, HEAD_LENGTH);
  for (const rule of CLASSIFY_RULES) {
    const hits = text.match(rule.pattern)?.length ?? 0;
    if (hits === 0) continue;
    const inHead = head.match(rule.pattern) !== null ? 2 : 0;
    scores.set(rule.kind, (scores.get(rule.kind) ?? 0) + rule.weight * Math.min(hits, 3) + inHead);
  }
  // Nombre del fichero: pista débil («factura-2026-01.pdf»).
  if (input.fileName) {
    const name = normalizeForRules(input.fileName);
    for (const rule of CLASSIFY_RULES) {
      if (rule.weight >= 3 && name.match(rule.pattern)) scores.set(rule.kind, (scores.get(rule.kind) ?? 0) + 1);
    }
  }
  if (scores.size === 0) {
    if (input.kindHint && input.kindHint !== "unknown") return { kind: input.kindHint, confidence: 0.3, source: "rules", note: "no_keywords_kind_hint" };
    return { kind: "unknown", confidence: 0, source: "rules", note: "no_keywords" };
  }
  const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1]);
  const [kind, score] = ranked[0]!;
  const second = ranked[1]?.[1] ?? 0;
  // Confianza: 0,55 con una sola palabra; sube con la evidencia y baja cuando otro tipo compite.
  const margin = score - second;
  const confidence = Math.max(0.35, Math.min(0.95, 0.5 + score * 0.06 - (margin < 2 ? 0.15 : 0)));
  return { kind, confidence: Number(confidence.toFixed(2)), source: "rules" };
}

// --- Utilidades de extracción ---------------------------------------------------

/** Candidatos a NIF/NIE/CIF (9 caracteres, con o sin prefijo ES y separadores blandos). */
const NIF_CANDIDATE_RE = /\b(?:ES[-\s]?)?([A-Z]?[-\s.]?\d{7,8}[-\s.]?[A-Z0-9])\b/gi;

export type NifHit = { value: string; index: number };

/** NIF válidos en orden de aparición (dígito de control comprobado con checkSpanishNif); sin repetidos. */
export function findValidNifs(text: string): NifHit[] {
  const hits: NifHit[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(NIF_CANDIDATE_RE)) {
    const candidate = match[1]!.replace(/[-\s.]/g, "");
    const check = checkSpanishNif(candidate);
    if (!check.ok || seen.has(check.value)) continue;
    seen.add(check.value);
    hits.push({ value: check.value, index: match.index ?? 0 });
  }
  return hits;
}

/** Inicio del bloque del destinatario («Cliente:», «Facturar a», «Bill to»…); -1 si el documento no lo separa. */
const CUSTOMER_SECTION_RE = /\b(?:cliente|destinatario|facturar\s+a|bill\s+to|customer|comprador)\b/i;

export function customerSectionStart(text: string): number {
  const match = CUSTOMER_SECTION_RE.exec(text);
  return match ? match.index : -1;
}

/** NIF etiquetado («NIF: …», «CIF …») cuyo dígito de control NO cuadra: se devuelve para que la validación lo marque `fail`. */
const LABELLED_NIF_RE = /\b(?:NIF|CIF|NIE|VAT)\s*[:.]?\s*(?:ES[-\s]?)?([A-Z]?\d{7,8}[A-Z0-9])\b/gi;

export function findInvalidLabelledNif(text: string, before = Number.POSITIVE_INFINITY): string | null {
  for (const match of text.matchAll(LABELLED_NIF_RE)) {
    if ((match.index ?? 0) >= before) break;
    const candidate = match[1]!.toUpperCase();
    if (!checkSpanishNif(candidate).ok) return candidate;
  }
  return null;
}

/** Emisor = primer NIF válido antes del bloque del destinatario; destinatario = el primero dentro de ese bloque. */
export function splitPartyNifs(text: string): { supplier: NifHit | null; customer: NifHit | null; invalidSupplier: string | null } {
  const hits = findValidNifs(text);
  const customerStart = customerSectionStart(text);
  const supplierHits = customerStart >= 0 ? hits.filter((hit) => hit.index < customerStart) : hits;
  const customerHits = customerStart >= 0 ? hits.filter((hit) => hit.index >= customerStart) : hits.slice(1);
  const supplier = supplierHits[0] ?? null;
  return {
    supplier,
    customer: customerHits.find((hit) => hit.value !== supplier?.value) ?? null,
    invalidSupplier: supplier ? null : findInvalidLabelledNif(text, customerStart >= 0 ? customerStart : Number.POSITIVE_INFINITY)
  };
}

/** Importe con formato español o internacional → cadena decimal con dos decimales ("1234.56"); null si no es un importe. */
export function parseAmount(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let s = raw.replace(/[€$\s]/g, "").replace(/EUR$/i, "");
  const negative = s.startsWith("-") || s.startsWith("(");
  s = s.replace(/^[-(]+|\)+$/g, "");
  if (!/^\d[\d.,]*$/.test(s)) return null;
  const lastComma = s.lastIndexOf(",");
  const lastDot = s.lastIndexOf(".");
  let normalized: string;
  if (lastComma >= 0 && lastDot >= 0) {
    normalized = lastComma > lastDot ? s.replace(/\./g, "").replace(",", ".") : s.replace(/,/g, "");
  } else if (lastComma >= 0) {
    const decimals = s.length - lastComma - 1;
    normalized = decimals === 3 && (s.match(/,/g)?.length ?? 0) > 0 && s.length > 4 && !/,\d{3}$/.test(s) ? s.replace(/,/g, "") : decimals <= 2 ? s.replace(",", ".") : s.replace(/,/g, "");
  } else if (lastDot >= 0) {
    const decimals = s.length - lastDot - 1;
    normalized = decimals <= 2 && (s.match(/\./g)?.length ?? 0) === 1 ? s : s.replace(/\./g, "");
  } else {
    normalized = s;
  }
  const value = Number(normalized);
  if (!Number.isFinite(value)) return null;
  return `${negative ? "-" : ""}${value.toFixed(2)}`;
}

const AMOUNT_TOKEN_RE = /-?\(?\d{1,3}(?:[.,]\d{3})*(?:[.,]\d{1,2})?\)?\s*(?:€|EUR)?|-?\d+(?:[.,]\d{1,2})?\s*(?:€|EUR)/g;

/** Importes de una línea en orden (solo tokens con separador decimal o con símbolo de moneda). */
export function amountsInLine(line: string): string[] {
  const out: string[] = [];
  for (const match of line.matchAll(AMOUNT_TOKEN_RE)) {
    const token = match[0].trim();
    if (!/[.,]\d{1,2}\b|€|EUR/.test(token)) continue;
    const parsed = parseAmount(token);
    if (parsed !== null) out.push(parsed);
  }
  return out;
}

const DATE_RE = /\b(\d{4})-(\d{2})-(\d{2})\b|\b(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})\b/g;

function isoIfValid(y: number, m: number, d: number): string | null {
  if (m < 1 || m > 12 || d < 1 || d > 31 || y < 1990 || y > 2100) return null;
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
  return date.toISOString().slice(0, 10);
}

/** Fechas ISO en orden de aparición (dd/mm/aaaa, dd-mm-aaaa, dd.mm.aaaa y aaaa-mm-dd). */
export function findDates(text: string): string[] {
  const out: string[] = [];
  for (const match of text.matchAll(DATE_RE)) {
    const iso = match[1] ? isoIfValid(Number(match[1]), Number(match[2]), Number(match[3])) : isoIfValid(Number(match[6]), Number(match[5]), Number(match[4]));
    if (iso) out.push(iso);
  }
  return out;
}

function lines(text: string): string[] {
  return text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
}

function field<T>(value: T, confidence: number, page = 1): ExtractedField<T> {
  return { value, confidence, page };
}

function lineWith(all: string[], pattern: RegExp): string | undefined {
  return all.find((line) => pattern.test(line));
}

function lastAmount(line: string | undefined): string | null {
  if (!line) return null;
  const amounts = amountsInLine(line);
  return amounts.length > 0 ? amounts[amounts.length - 1]! : null;
}

const NUMBER_TOKEN = "(?=[A-Z0-9/\\-_.]*\\d)[A-Z0-9][A-Z0-9/\\-_.]*";
const INVOICE_NUMBER_RES: RegExp[] = [
  new RegExp(`(?:n[ºo°.]?\\s*(?:de\\s+)?factura|factura\\s*n[ºo°.]?\\s*(?:de)?|invoice\\s*(?:no\\.?|number|n[ºo°.]?|#))\\s*[:#]?\\s*(${NUMBER_TOKEN})`, "i"),
  new RegExp(`\\bfactura\\s*[:#]\\s*(${NUMBER_TOKEN})`, "i"),
  new RegExp(`\\binvoice\\s*[:#]?\\s*(${NUMBER_TOKEN})`, "i")
];
const DELIVERY_NUMBER_RE = new RegExp(`albar[aá]n(?:es)?\\s*(?:n[ºo°.]?)?\\s*(?:de)?\\s*[:#]?\\s*(${NUMBER_TOKEN})`, "gi");
const RECEIPT_NUMBER_RE = new RegExp(`(?:ticket|recibo|factura simplificada)\\s*(?:n[ºo°.]?)?\\s*[:#]?\\s*(${NUMBER_TOKEN})`, "i");
const REFERENCE_RE = new RegExp(`(?:ref(?:erencia)?\\.?|expediente|n[ºo°.]?\\s*exp(?:ediente)?\\.?)\\s*[:#]?\\s*(${NUMBER_TOKEN})`, "i");
const LINE_RE = /^(.+?)\s+(\d+(?:[.,]\d+)?)\s+(-?[\d.,]+)\s*€?\s+(-?[\d.,]+)\s*€?$/;

function taxRateOf(line: string): number | null {
  const match = /(\d{1,2}(?:[.,]\d+)?)\s*%/.exec(line);
  return match ? Number(match[1]!.replace(",", ".")) : null;
}

/** Nombre del emisor: la línea con letras justo antes de la que lleva su NIF (o la segunda línea del documento). */
function issuerNameOf(all: string[], nif: string | null): string | null {
  const isLabel = (line: string) => /^(factura|invoice|albar[aá]n|ticket|recibo|nif|cif|fecha|cliente|proveedor|total|base)/i.test(line);
  if (nif) {
    const index = all.findIndex((line) => line.replace(/[-\s.]/g, "").toUpperCase().includes(nif));
    for (let i = index - 1; i >= 0 && i >= index - 3; i -= 1) {
      const candidate = all[i]!;
      if (/[A-Za-zÁÉÍÓÚáéíóúñÑ]{3,}/.test(candidate) && !isLabel(candidate) && candidate.length <= 120) return candidate;
    }
  }
  const second = all.find((line, i) => i > 0 && /[A-Za-zÁÉÍÓÚáéíóúñÑ]{3,}/.test(line) && !isLabel(line));
  return second ?? null;
}

type TaxLine = { rate: number; base: string | null; quota: string | null };

function taxBreakdownOf(all: string[]): TaxLine[] {
  const out: TaxLine[] = [];
  for (const line of all) {
    if (!/\biva\b/i.test(line) || /total\s+iva/i.test(line)) continue;
    const rate = taxRateOf(line);
    if (rate === null) continue;
    const amounts = amountsInLine(line);
    const quota = amounts.length > 0 ? amounts[amounts.length - 1]! : null;
    const base = amounts.length > 1 ? amounts[amounts.length - 2]! : null;
    if (out.some((entry) => entry.rate === rate)) continue;
    out.push({ rate, base, quota });
  }
  return out;
}

function sumMoney(values: Array<string | null>): string | null {
  const present = values.filter((value): value is string => value !== null);
  if (present.length === 0) return null;
  return present.reduce((acc, value) => acc + Number(value), 0).toFixed(2);
}

type ParsedLine = { description: string; quantity: number | null; unitPrice: string | null; base: string | null; taxRate: number | null; quota: string | null; deliveryNoteRef: string | null };

function parseItemLines(all: string[], defaultRate: number | null): ParsedLine[] {
  const out: ParsedLine[] = [];
  for (const line of all) {
    if (/^(base imponible|total|iva|retenci|subtotal|importe)/i.test(line)) continue;
    const match = LINE_RE.exec(line);
    if (!match) continue;
    const description = match[1]!.trim();
    if (!/[A-Za-zÁÉÍÓÚáéíóúñÑ]{2,}/.test(description) || /^(concepto|descripci)/i.test(description)) continue;
    const quantity = Number(match[2]!.replace(",", "."));
    const unitPrice = parseAmount(match[3]!);
    const base = parseAmount(match[4]!);
    if (unitPrice === null || base === null) continue;
    const quota = defaultRate !== null ? ((Number(base) * defaultRate) / 100).toFixed(2) : null;
    out.push({ description, quantity: Number.isFinite(quantity) ? quantity : null, unitPrice, base, taxRate: defaultRate, quota, deliveryNoteRef: null });
  }
  return out;
}

function deliveryRefsOf(text: string): string[] {
  const refs = new Set<string>();
  for (const match of text.matchAll(DELIVERY_NUMBER_RE)) refs.add(match[1]!);
  return [...refs];
}

// --- Extracción por tipo --------------------------------------------------------

export type RulesExtraction = { fields: DocumentExtractedFields; warnings: string[] };

export function extractInvoiceFieldsFromText(text: string): RulesExtraction {
  const all = lines(text);
  const warnings: string[] = [];
  const fields: DocumentExtractedFields = {};
  const parties = splitPartyNifs(text);
  const supplierNif = parties.supplier?.value ?? null;
  const customerNif = parties.customer?.value ?? null;
  if (supplierNif) fields.supplierTaxId = field(supplierNif, 0.9);
  else if (parties.invalidSupplier) {
    // Dígito de control incorrecto: se entrega con confianza baja para que checks.nif quede en fail con el valor leído.
    fields.supplierTaxId = field(parties.invalidSupplier, 0.3);
    warnings.push("nif_invalid");
  } else warnings.push("nif_not_found");
  if (customerNif) fields.customerTaxId = field(customerNif, 0.7);
  const issuer = issuerNameOf(all, supplierNif ?? parties.invalidSupplier);
  if (issuer) fields.supplierName = field(issuer, 0.5);

  let number: string | null = null;
  for (const re of INVOICE_NUMBER_RES) {
    const match = re.exec(text);
    if (match) {
      number = match[1]!;
      break;
    }
  }
  if (number) fields.invoiceNumber = field(number, 0.8);
  else warnings.push("invoice_number_not_found");

  const dateLine = lineWith(all, /\bfecha\b|\bdate\b/i);
  const dates = findDates(dateLine ?? "");
  const anyDates = findDates(text);
  if (dates.length > 0) fields.issueDate = field(dates[0]!, 0.8);
  else if (anyDates.length > 0) fields.issueDate = field(anyDates[0]!, 0.4);
  else warnings.push("issue_date_not_found");
  const dueLine = lineWith(all, /vencimiento|due date/i);
  const dueDates = findDates(dueLine ?? "");
  if (dueDates.length > 0) fields.dueDate = field(dueDates[0]!, 0.7);

  const breakdown = taxBreakdownOf(all);
  const base = lastAmount(lineWith(all, /base imponible|subtotal|taxable/i)) ?? sumMoney(breakdown.map((entry) => entry.base));
  if (base !== null) fields.base = field(base, 0.8);
  if (breakdown.length > 0) {
    fields.taxBreakdown = field(breakdown, 0.8);
    const totalTax = lastAmount(lineWith(all, /total\s+iva|cuota\s+iva/i)) ?? sumMoney(breakdown.map((entry) => entry.quota));
    if (totalTax !== null) fields.tax = field(totalTax, 0.8);
  } else {
    warnings.push("vat_not_found");
  }
  const retentionLine = lineWith(all, /retenci[oó]n|irpf/i);
  if (retentionLine) {
    const rate = taxRateOf(retentionLine);
    const amount = lastAmount(retentionLine);
    if (rate !== null) fields.retentionRate = field(rate, 0.8);
    if (amount !== null) fields.retention = field(amount.replace(/^-/, ""), 0.8);
  }
  const totalLine = [...all].reverse().find((line) => /^total\b(?!\s+iva)|total\s+(factura|a\s+pagar)|importe\s+total|total amount/i.test(line));
  const total = lastAmount(totalLine);
  if (total !== null) fields.total = field(total, 0.8);
  else warnings.push("total_not_found");
  fields.currency = field(/\$|usd/i.test(text) && !/€|eur/i.test(text) ? "USD" : "EUR", 0.6);

  const refs = deliveryRefsOf(text);
  if (refs.length > 0) fields.deliveryNoteRefs = field(refs, 0.7);
  const defaultRate = breakdown.length === 1 ? breakdown[0]!.rate : null;
  const items = parseItemLines(all, defaultRate);
  if (items.length > 0) {
    fields.lines = field(items, 0.5);
    if (base !== null && Math.abs(Number(sumMoney(items.map((item) => item.base))) - Number(base)) > 0.01) warnings.push("lines_do_not_add_up");
  } else {
    warnings.push("lines_not_extracted");
  }
  return { fields, warnings };
}

export function extractDeliveryNoteFieldsFromText(text: string): RulesExtraction {
  const all = lines(text);
  const warnings: string[] = [];
  const fields: DocumentExtractedFields = {};
  const parties = splitPartyNifs(text);
  if (parties.supplier) fields.supplierTaxId = field(parties.supplier.value, 0.9);
  else if (parties.invalidSupplier) {
    fields.supplierTaxId = field(parties.invalidSupplier, 0.3);
    warnings.push("nif_invalid");
  } else warnings.push("nif_not_found");
  const issuer = issuerNameOf(all, parties.supplier?.value ?? parties.invalidSupplier);
  if (issuer) fields.supplierName = field(issuer, 0.5);
  const refs = deliveryRefsOf(text);
  if (refs[0]) fields.deliveryNoteNumber = field(refs[0], 0.8);
  else warnings.push("delivery_note_number_not_found");
  const dateLine = lineWith(all, /\bfecha\b|\bdate\b/i);
  const dates = findDates(dateLine ?? text);
  if (dates[0]) fields.deliveryDate = field(dates[0], dateLine ? 0.8 : 0.4);
  else warnings.push("delivery_date_not_found");
  const order = /pedido\s*(?:n[ºo°.]?)?\s*[:#]?\s*([A-Z0-9][A-Z0-9/\-_.]*\d[A-Z0-9/\-_.]*)/i.exec(text);
  if (order) fields.purchaseOrderRef = field(order[1]!, 0.7);
  const items = parseItemLines(all, null).map((item) => ({ description: item.description, quantity: item.quantity, unit: null, unitPrice: item.unitPrice, base: item.base, taxRate: item.taxRate }));
  if (items.length > 0) fields.lines = field(items, 0.5);
  else warnings.push("lines_not_extracted");
  return { fields, warnings };
}

export function extractReceiptFieldsFromText(text: string): RulesExtraction {
  const all = lines(text);
  const warnings: string[] = [];
  const fields: DocumentExtractedFields = {};
  const nifs = findValidNifs(text);
  if (nifs[0]) fields.merchantTaxId = field(nifs[0].value, 0.9);
  const issuer = issuerNameOf(all, nifs[0]?.value ?? null) ?? all[0] ?? null;
  if (issuer) fields.merchantName = field(issuer, 0.5);
  const number = RECEIPT_NUMBER_RE.exec(text);
  if (number) fields.receiptNumber = field(number[1]!, 0.7);
  const dates = findDates(text);
  if (dates[0]) fields.date = field(dates[0], 0.6);
  else warnings.push("date_not_found");
  const breakdown = taxBreakdownOf(all);
  if (breakdown[0]) {
    fields.taxRate = field(breakdown[0].rate, 0.8);
    if (breakdown[0].quota) fields.tax = field(breakdown[0].quota, 0.7);
    if (breakdown[0].base) fields.base = field(breakdown[0].base, 0.7);
  }
  const base = lastAmount(lineWith(all, /base imponible|subtotal/i));
  if (base !== null) fields.base = field(base, 0.8);
  const totalLine = [...all].reverse().find((line) => /^total\b|importe\s+total|total\s+a\s+pagar/i.test(line));
  const total = lastAmount(totalLine);
  if (total !== null) fields.total = field(total, 0.8);
  else warnings.push("total_not_found");
  const paid = /\b(efectivo|cash|tarjeta|card|visa|mastercard|transferencia)\b/i.exec(text);
  if (paid) fields.paidWith = field(/efectivo|cash/i.test(paid[1]!) ? "cash" : /transferencia/i.test(paid[1]!) ? "transfer" : "card", 0.6);
  return { fields, warnings };
}

export function extractLetterFieldsFromText(text: string, kind: IncomingDocumentKind): RulesExtraction {
  const all = lines(text);
  const warnings: string[] = [];
  const fields: DocumentExtractedFields = {};
  const nifs = findValidNifs(text);
  const notice = schemaKindFor(kind) === "administrative_notice";
  const senderKey = notice ? "issuer" : "sender";
  const senderTaxKey = notice ? "issuerTaxId" : "senderTaxId";
  const dateKey = notice ? "noticeDate" : "date";
  if (nifs[0]) fields[senderTaxKey] = field(nifs[0].value, 0.9);
  const issuer = issuerNameOf(all, nifs[0]?.value ?? null) ?? all[0] ?? null;
  if (issuer) fields[senderKey] = field(issuer, 0.4);
  const subject = lineWith(all, /^(asunto|subject|ref\.?)\s*[:.]/i);
  if (subject) fields.subject = field(subject.replace(/^(asunto|subject|ref\.?)\s*[:.]\s*/i, ""), 0.7);
  const reference = REFERENCE_RE.exec(text);
  if (reference) fields.reference = field(reference[1]!, 0.7);
  const dates = findDates(text);
  if (dates[0]) fields[dateKey] = field(dates[0], 0.5);
  else warnings.push("date_not_found");
  const deadlineLine = lineWith(all, /plazo|antes del|hasta el|fecha l[ií]mite|deadline/i);
  const deadlineDates = findDates(deadlineLine ?? "");
  if (deadlineDates[0]) fields.deadlineDate = field(deadlineDates[0], 0.6);
  const amount = lastAmount(lineWith(all, /importe|total|cuant[ií]a|sanci[oó]n/i));
  if (amount !== null) fields.amount = field(amount, 0.5);
  if (all[0]) fields.summary = field(all.slice(0, 2).join(" · ").slice(0, 200), 0.3);
  return { fields, warnings };
}

/** Extracción por reglas según el tipo (contract / other / unknown → esquema de carta). */
export function extractFieldsFromText(kind: IncomingDocumentKind, text: string): RulesExtraction {
  switch (schemaKindFor(kind)) {
    case "invoice":
      return extractInvoiceFieldsFromText(text);
    case "delivery_note":
      return extractDeliveryNoteFieldsFromText(text);
    case "receipt":
      return extractReceiptFieldsFromText(text);
    default:
      return extractLetterFieldsFromText(text, kind);
  }
}

// --- E-factura ---------------------------------------------------------------

const toMoney = (value: number): string => value.toFixed(2);

/** ParsedEInvoice (confianza 1) → campos del esquema de factura. */
export function eInvoiceToFields(parsed: ParsedEInvoice): DocumentExtractedFields {
  const fields: DocumentExtractedFields = {};
  const put = <T>(key: string, value: T | null | undefined) => {
    if (value !== null && value !== undefined && value !== "") fields[key] = field(value, 1);
  };
  put("supplierName", parsed.supplier.name);
  put("supplierTaxId", parsed.supplier.taxId);
  put("customerName", parsed.customer.name);
  put("customerTaxId", parsed.customer.taxId);
  put("invoiceNumber", parsed.invoiceNumber);
  put("issueDate", parsed.issueDate);
  put("base", toMoney(parsed.totals.base));
  put("tax", toMoney(parsed.totals.tax));
  put("total", toMoney(parsed.totals.total));
  put("currency", parsed.currency ?? "EUR");
  const byRate = new Map<number, { base: number; quota: number }>();
  for (const line of parsed.lines) {
    const entry = byRate.get(line.taxRate) ?? { base: 0, quota: 0 };
    entry.base += line.base;
    entry.quota += line.quota;
    byRate.set(line.taxRate, entry);
  }
  put(
    "taxBreakdown",
    [...byRate.entries()].map(([rate, entry]) => ({ rate, base: toMoney(entry.base), quota: toMoney(entry.quota) }))
  );
  if (parsed.retention && parsed.retention.amount > 0) {
    put("retentionRate", parsed.retention.rate);
    put("retention", toMoney(parsed.retention.amount));
  }
  put(
    "lines",
    parsed.lines.map((line) => ({
      description: line.description,
      quantity: line.quantity,
      unitPrice: line.unitPrice.toFixed(4),
      base: toMoney(line.base),
      taxRate: line.taxRate,
      quota: toMoney(line.quota),
      deliveryNoteRef: null
    }))
  );
  return fields;
}

function isXmlInput(input: { xml?: string; mimeType?: string; fileName?: string; text?: string | null }): boolean {
  if (input.xml) return true;
  if (input.mimeType && /xml/i.test(input.mimeType)) return true;
  return typeof input.text === "string" && /^\s*<\?xml/i.test(input.text);
}

// --- Puerto ------------------------------------------------------------------

export class RulesDocumentsAi implements DocumentsAiPort {
  describe(): DocumentsAiDescription {
    return { configured: false, provider: RULES_PROVIDER };
  }

  async classify(input: ClassifyDocumentInput, _ctx: DocumentsAiContext): Promise<ClassifyDocumentOutput> {
    if (isXmlInput(input) && input.text) {
      const parsed = parseEInvoice(input.text);
      if (parsed.confidence === 1) return { kind: "invoice", confidence: 1, source: "rules", note: `e_invoice:${parsed.format}` };
      return { kind: input.kindHint && input.kindHint !== "unknown" ? input.kindHint : "other", confidence: input.kindHint ? 0.3 : 0.2, source: "rules", note: "xml_not_e_invoice" };
    }
    return classifyByKeywords(input);
  }

  async extract(input: ExtractDocumentInput, _ctx: DocumentsAiContext): Promise<ExtractDocumentOutput> {
    const base = { provider: null, model: null, schemaVersion: EXTRACTION_SCHEMA_VERSION, telemetry: null } as const;
    const xml = input.xml ?? (isXmlInput(input) ? (input.text ?? undefined) : undefined);
    if (xml) {
      const parsed = parseEInvoice(xml);
      if (parsed.confidence === 1) {
        const warnings = [...parsed.warnings];
        if (!parsed.totalsConsistent) warnings.push("e_invoice_totals_inconsistent");
        return { ...base, fields: eInvoiceToFields(parsed), source: "e_invoice", warnings };
      }
      return { ...base, fields: {}, source: "text_rules", warnings: ["xml_not_e_invoice", ...parsed.warnings] };
    }
    const text = (input.text ?? "").slice(0, RULES_MAX_TEXT);
    if (text.trim().length === 0) {
      return { ...base, fields: {}, source: "text_rules", warnings: [input.pages && input.pages.length > 0 ? "image_without_provider" : "no_text_layer"] };
    }
    const { fields, warnings } = extractFieldsFromText(input.kind, text);
    return { ...base, fields, source: "text_rules", warnings: ["text_rules_limited_coverage", ...warnings] };
  }
}
