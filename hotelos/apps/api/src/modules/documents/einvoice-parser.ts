// Documents · deterministic EN16931 e-invoice parser (Tanda T9 · lote T9-03,
// design §3.3). Facturae 3.2.x and UBL 2.1 Invoice → a normalised structure
// with confidence 1 (structured data, no AI, no OCR). XAdES / XMLDSig is only
// detected structurally (a ds:Signature with SignedInfo); nothing is verified
// cryptographically here. Any other XML (or a malformed one) yields
// format = "unknown" with confidence 0 and a warning instead of throwing, so
// the capture pipeline can fall back to the manual form.
//
// Built on lib/xml-lite.ts (no DOCTYPE, size / depth / node limits). Element
// names are compared by local name: prefixes (fe:, cac:, cbc:, ds:) are
// stripped by the parser.

import { normalizeTaxId } from "@hotelos/compliance";
import { XmlLiteError, childText, childrenNamed, findFirst, parseXml, type XmlNode } from "../../lib/xml-lite.js";

export type EInvoiceFormat = "facturae" | "ubl" | "unknown";

export type EInvoiceParty = { name: string | null; taxId: string | null };

export type EInvoiceLine = {
  description: string;
  quantity: number;
  unitPrice: number;
  base: number;
  taxRate: number;
  quota: number;
};

export type EInvoiceTotals = { base: number; tax: number; total: number };

export type ParsedEInvoice = {
  format: EInvoiceFormat;
  schemaVersion: string | null;
  supplier: EInvoiceParty;
  customer: EInvoiceParty;
  invoiceNumber: string | null;
  issueDate: string | null;
  currency: string | null;
  lines: EInvoiceLine[];
  totals: EInvoiceTotals;
  retention?: { rate: number | null; amount: number };
  /** base + tax − retention equals total within ±0.01. */
  totalsConsistent: boolean;
  signaturePresent: boolean;
  /** 1 for a structured invoice, 0 when unknown. */
  confidence: 0 | 1;
  warnings: string[];
};

const EMPTY: ParsedEInvoice = Object.freeze({
  format: "unknown",
  schemaVersion: null,
  supplier: { name: null, taxId: null },
  customer: { name: null, taxId: null },
  invoiceNumber: null,
  issueDate: null,
  currency: null,
  lines: [],
  totals: { base: 0, tax: 0, total: 0 },
  totalsConsistent: false,
  signaturePresent: false,
  confidence: 0,
  warnings: []
}) as ParsedEInvoice;

export function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function num(text: string | null | undefined): number {
  if (text === null || text === undefined) return 0;
  const cleaned = text.trim().replace(/\s/g, "").replace(",", ".");
  const value = Number(cleaned);
  return Number.isFinite(value) ? value : 0;
}

function optNum(text: string | null | undefined): number | null {
  if (text === null || text === undefined || text.trim() === "") return null;
  const value = num(text);
  return Number.isFinite(value) ? value : null;
}

function isoDate(text: string | null): string | null {
  if (!text) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(text.trim());
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

function nonEmpty(text: string | null | undefined): string | null {
  const value = (text ?? "").trim();
  return value.length ? value : null;
}

function path(node: XmlNode | null, ...names: string[]): XmlNode | null {
  let current: XmlNode | null = node;
  for (const name of names) {
    if (!current) return null;
    current = current.children.find((child) => child.name === name) ?? null;
  }
  return current;
}

function pathText(node: XmlNode | null, ...names: string[]): string | null {
  const found = path(node, ...names);
  return found ? nonEmpty(found.text) : null;
}

function signaturePresent(root: XmlNode): boolean {
  const signature = findFirst(root, "Signature");
  return signature !== null && path(signature, "SignedInfo") !== null;
}

function consistent(totals: EInvoiceTotals, retention: number): boolean {
  return Math.abs(round2(totals.base + totals.tax - retention) - round2(totals.total)) <= 0.01;
}

// ---------------------------------------------------------------------------
// Facturae 3.2.x
// ---------------------------------------------------------------------------

function facturaeParty(party: XmlNode | null): EInvoiceParty {
  if (!party) return { name: null, taxId: null };
  const legal = pathText(party, "LegalEntity", "CorporateName");
  const individual = path(party, "Individual");
  const personName = individual ? [childText(individual, "Name"), childText(individual, "FirstSurname"), childText(individual, "SecondSurname")].filter((p) => p && p.trim()).join(" ") : null;
  return {
    name: legal ?? nonEmpty(personName),
    taxId: normalizeTaxId(pathText(party, "TaxIdentification", "TaxIdentificationNumber"))
  };
}

function facturaeTaxes(container: XmlNode | null): Array<{ rate: number | null; base: number; amount: number }> {
  if (!container) return [];
  return childrenNamed(container, "Tax").map((tax) => ({
    rate: optNum(childText(tax, "TaxRate")),
    base: num(pathText(tax, "TaxableBase", "TotalAmount")),
    amount: num(pathText(tax, "TaxAmount", "TotalAmount"))
  }));
}

function parseFacturae(root: XmlNode): ParsedEInvoice {
  const warnings: string[] = [];
  const schemaVersion = pathText(root, "FileHeader", "SchemaVersion");
  const parties = path(root, "Parties");
  const invoice = path(root, "Invoices", "Invoice");
  if (!invoice) {
    return { ...EMPTY, format: "facturae", schemaVersion, warnings: ["FACTURAE_SIN_INVOICE"], signaturePresent: signaturePresent(root) };
  }
  const invoicesCount = childrenNamed(path(root, "Invoices")!, "Invoice").length;
  if (invoicesCount > 1) warnings.push(`FACTURAE_LOTE_${invoicesCount}_FACTURAS`);

  const lines: EInvoiceLine[] = childrenNamed(path(invoice, "Items") ?? { name: "", attrs: {}, children: [], text: "" }, "InvoiceLine").map((line) => {
    const quantity = num(childText(line, "Quantity"));
    const unitPrice = num(childText(line, "UnitPriceWithoutTax"));
    const base = optNum(childText(line, "TotalCost")) ?? optNum(childText(line, "GrossAmount")) ?? round2(quantity * unitPrice);
    const taxes = facturaeTaxes(path(line, "TaxesOutputs"));
    const taxRate = taxes[0]?.rate ?? 0;
    const quota = taxes.length ? round2(taxes.reduce((sum, t) => sum + t.amount, 0)) : round2((base * taxRate) / 100);
    return { description: nonEmpty(childText(line, "ItemDescription")) ?? "", quantity, unitPrice, base: round2(base), taxRate, quota };
  });

  const outputs = facturaeTaxes(path(invoice, "TaxesOutputs"));
  const withheld = facturaeTaxes(path(invoice, "TaxesWithheld"));
  const totalsNode = path(invoice, "InvoiceTotals");
  const base = optNum(pathText(totalsNode, "TotalGrossAmountBeforeTaxes")) ?? optNum(pathText(totalsNode, "TotalGrossAmount")) ?? round2(lines.reduce((s, l) => s + l.base, 0));
  const tax = optNum(pathText(totalsNode, "TotalTaxOutputs")) ?? round2(outputs.reduce((s, t) => s + t.amount, 0));
  const retentionAmount = optNum(pathText(totalsNode, "TotalTaxesWithheld")) ?? round2(withheld.reduce((s, t) => s + t.amount, 0));
  const total = optNum(pathText(totalsNode, "InvoiceTotal")) ?? round2(base + tax - retentionAmount);
  const totals: EInvoiceTotals = { base: round2(base), tax: round2(tax), total: round2(total) };
  if (!totalsNode) warnings.push("FACTURAE_SIN_INVOICETOTALS");

  const result: ParsedEInvoice = {
    format: "facturae",
    schemaVersion,
    supplier: facturaeParty(path(parties, "SellerParty")),
    customer: facturaeParty(path(parties, "BuyerParty")),
    invoiceNumber: nonEmpty([pathText(invoice, "InvoiceHeader", "InvoiceSeriesCode"), pathText(invoice, "InvoiceHeader", "InvoiceNumber")].filter(Boolean).join("")) ?? null,
    issueDate: isoDate(pathText(invoice, "InvoiceIssueData", "IssueDate")),
    currency: pathText(invoice, "InvoiceIssueData", "InvoiceCurrencyCode"),
    lines,
    totals,
    totalsConsistent: consistent(totals, retentionAmount),
    signaturePresent: signaturePresent(root),
    confidence: 1,
    warnings
  };
  if (retentionAmount > 0) result.retention = { rate: withheld[0]?.rate ?? null, amount: round2(retentionAmount) };
  if (!result.totalsConsistent) warnings.push("TOTALES_NO_CUADRAN");
  return result;
}

// ---------------------------------------------------------------------------
// UBL 2.1 Invoice (EN16931 / Peppol BIS 3)
// ---------------------------------------------------------------------------

function ublParty(partyWrapper: XmlNode | null): EInvoiceParty {
  const party = path(partyWrapper, "Party");
  if (!party) return { name: null, taxId: null };
  const name = pathText(party, "PartyLegalEntity", "RegistrationName") ?? pathText(party, "PartyName", "Name");
  const taxSchemes = childrenNamed(party, "PartyTaxScheme");
  const vat = taxSchemes.find((scheme) => (pathText(scheme, "TaxScheme", "ID") ?? "VAT").toUpperCase() === "VAT") ?? taxSchemes[0] ?? null;
  const taxId = pathText(vat, "CompanyID") ?? pathText(party, "PartyLegalEntity", "CompanyID") ?? pathText(party, "PartyIdentification", "ID");
  return { name, taxId: normalizeTaxId(taxId) };
}

function parseUbl(root: XmlNode): ParsedEInvoice {
  const warnings: string[] = [];
  const lines: EInvoiceLine[] = childrenNamed(root, "InvoiceLine").map((line) => {
    const item = path(line, "Item");
    const quantity = num(childText(line, "InvoicedQuantity"));
    const unitPrice = num(pathText(line, "Price", "PriceAmount"));
    const base = optNum(childText(line, "LineExtensionAmount")) ?? round2(quantity * unitPrice);
    const taxRate = optNum(pathText(item, "ClassifiedTaxCategory", "Percent")) ?? 0;
    const lineTax = optNum(pathText(line, "TaxTotal", "TaxAmount"));
    return {
      description: pathText(item, "Name") ?? pathText(item, "Description") ?? "",
      quantity,
      unitPrice,
      base: round2(base),
      taxRate,
      quota: lineTax ?? round2((base * taxRate) / 100)
    };
  });

  const taxTotals = childrenNamed(root, "TaxTotal");
  const taxFromTotals = taxTotals.length ? round2(taxTotals.reduce((sum, t) => sum + num(childText(t, "TaxAmount")), 0)) : null;
  const monetary = path(root, "LegalMonetaryTotal");
  const base = optNum(pathText(monetary, "TaxExclusiveAmount")) ?? optNum(pathText(monetary, "LineExtensionAmount")) ?? round2(lines.reduce((s, l) => s + l.base, 0));
  const tax = taxFromTotals ?? round2(lines.reduce((s, l) => s + l.quota, 0));
  const withholding = childrenNamed(root, "WithholdingTaxTotal");
  const retentionAmount = round2(withholding.reduce((sum, t) => sum + num(childText(t, "TaxAmount")), 0));
  const retentionRate = optNum(pathText(withholding[0] ?? null, "TaxSubtotal", "TaxCategory", "Percent"));
  const total = optNum(pathText(monetary, "PayableAmount")) ?? optNum(pathText(monetary, "TaxInclusiveAmount")) ?? round2(base + tax - retentionAmount);
  const totals: EInvoiceTotals = { base: round2(base), tax: round2(tax), total: round2(total) };
  if (!monetary) warnings.push("UBL_SIN_LEGALMONETARYTOTAL");

  const result: ParsedEInvoice = {
    format: "ubl",
    schemaVersion: pathText(root, "CustomizationID") ?? pathText(root, "UBLVersionID"),
    supplier: ublParty(path(root, "AccountingSupplierParty")),
    customer: ublParty(path(root, "AccountingCustomerParty")),
    invoiceNumber: pathText(root, "ID"),
    issueDate: isoDate(pathText(root, "IssueDate")),
    currency: pathText(root, "DocumentCurrencyCode"),
    lines,
    totals,
    totalsConsistent: consistent(totals, retentionAmount),
    signaturePresent: signaturePresent(root),
    confidence: 1,
    warnings
  };
  if (retentionAmount > 0) result.retention = { rate: retentionRate, amount: retentionAmount };
  if (!result.totalsConsistent) warnings.push("TOTALES_NO_CUADRAN");
  return result;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function detectEInvoiceFormat(root: XmlNode): EInvoiceFormat {
  if (root.name === "Facturae") return "facturae";
  if (root.name === "Invoice" && (path(root, "AccountingSupplierParty") !== null || path(root, "LegalMonetaryTotal") !== null)) return "ubl";
  return "unknown";
}

/** Bytes (or text) of an XML → ParsedEInvoice; never throws for content reasons. */
export function parseEInvoice(input: Uint8Array | string): ParsedEInvoice {
  let root: XmlNode;
  try {
    root = parseXml(input);
  } catch (error) {
    const code = error instanceof XmlLiteError ? error.code : "XML_LITE_MALFORMED";
    return { ...EMPTY, warnings: [code] };
  }
  switch (detectEInvoiceFormat(root)) {
    case "facturae":
      return parseFacturae(root);
    case "ubl":
      return parseUbl(root);
    default:
      return { ...EMPTY, signaturePresent: signaturePresent(root), warnings: [`XML_NO_RECONOCIDO:${root.name}`] };
  }
}
