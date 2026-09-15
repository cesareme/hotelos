// POS line taxation — pure core (no database).
//
// Finanzas (2026-09-15, lote «pos-noche»). A POS price is GROSS (tax included,
// as printed on the menu). Every line resolves to one fiscal category:
//   · food_beverage   → hostelería (IVA 10 %, IGIC 7 %, IPSI 2 %) — the default
//     of restaurant / bar / café / room-service / minibar / breakfast outlets;
//   · general_services → general rate (IVA 21 %, IGIC 7 %, IPSI 4 %) — spa,
//     shop, laundry… AND alcoholic beverages sold in an F&B outlet, when the
//     catalogue marks the product as such (PosProduct.category / taxCode).
// The percentages themselves are NOT hard-coded here: the caller resolves them
// through accounting/tax-rate.service (property region, catalogue or manual
// override) and passes a rate table, so IGIC/IPSI properties tax correctly.
//
// Rounding (contract B of the invoicing engine): the ticket breakdown is
// computed PER GROUP (category × rate) from the gross sum with
// computeInvoiceTotals — the same function that produces the invoice header,
// the VeriFactu CuotaTotal and the PDF — so the journal entry, the VAT book and
// the simplified invoice carry identical figures. Per-line base/quota are also
// exposed (half-away-from-zero, 2 decimals) for display; the group is the
// authoritative figure and Σ base + Σ quota = Σ gross to the cent by
// construction (quota = gross − base).
import { Prisma } from "@prisma/client";
import { computeInvoiceTotals, type Calificacion, type TaxFigure, type VerifactuImpuesto } from "@hotelos/compliance";

const Decimal = Prisma.Decimal;
type Decimal = Prisma.Decimal;

export type PosTaxCategory = "food_beverage" | "general_services";

/** What the caller resolved for one category through tax-rate.service. */
export type PosRateSpec = {
  ratePercent: number;
  /** Canonical per-line code persisted on InvoiceLine.taxCode ("ES_IVA_10"). */
  canonicalTaxCode: string;
  /** "21" | "10" | "7" | … — JournalLine.taxRateCode / VatBookEntry.rate. */
  rateCode: string;
  figure: TaxFigure;
  impuesto: VerifactuImpuesto;
  calificacion: Calificacion;
};

export type PosRateTable = Record<PosTaxCategory, PosRateSpec>;

export type PosTaxableLine = {
  name: string;
  quantity: number;
  unitPrice: number;
  /** Gross line amount (quantity × unitPrice, 2 decimals). */
  total: number;
  productId?: string | null;
  /** PosProduct.category of the matched catalogue product (free text). */
  productCategory?: string | null;
  /** PosProduct.taxCode of the matched catalogue product ("ES_IVA_21", "21"…). */
  productTaxCode?: string | null;
};

export type PosTaxedLine = PosTaxableLine & {
  taxCategory: PosTaxCategory;
  alcohol: boolean;
  ratePercent: number;
  taxCode: string;
  /** Informational per-line figures (decimal strings); the group breakdown is authoritative. */
  base: string;
  quota: string;
};

export type PosTaxGroup = {
  taxCategory: PosTaxCategory;
  ratePercent: number;
  rateCode: string;
  taxCode: string;
  figure: TaxFigure;
  impuesto: VerifactuImpuesto;
  calificacion: Calificacion;
  /** Decimal strings, 2 decimals. */
  base: string;
  quota: string;
  total: string;
  lines: PosTaxedLine[];
};

export type PosTicketTax = {
  lines: PosTaxedLine[];
  groups: PosTaxGroup[];
  baseTotal: string;
  taxTotal: string;
  total: string;
  /** True when every line is hostelería (art. 4.2 RD 1619/2012: simplified invoice up to 3.000 €). */
  allFoodBeverage: boolean;
};

// Outlet types whose consumption is hostelería (IVA 10 %).
export const FOOD_BEVERAGE_OUTLET_TYPES: ReadonlySet<string> = new Set([
  "restaurant",
  "bar",
  "cafe",
  "cafeteria",
  "roomservice",
  "room_service",
  "minibar",
  "breakfast"
]);

// Catalogue categories that mean "alcoholic beverage" (general rate even in a
// restaurant). Matched after lower-casing and stripping accents, so «Bebidas
// alcohólicas», «Vinos» or «alcohol» all qualify.
const ALCOHOL_CATEGORY_TOKENS: readonly string[] = [
  "alcohol",
  "alcoholic",
  "alcoholica",
  "alcoholicas",
  "bebidas alcoholicas",
  "bebida alcoholica",
  "vino",
  "vinos",
  "wine",
  "cerveza",
  "cervezas",
  "beer",
  "licor",
  "licores",
  "destilado",
  "destilados",
  "spirits",
  "cocktail",
  "coctel",
  "cocteles",
  "cava",
  "champagne"
];

function normalize(value: string | null | undefined): string {
  return (value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

/** True when the catalogue marks the product as an alcoholic beverage (category tokens or a 21 % tax code). Pure. */
export function isAlcoholProduct(product: { productCategory?: string | null; productTaxCode?: string | null } | null | undefined): boolean {
  if (!product) return false;
  const category = normalize(product.productCategory);
  if (category && ALCOHOL_CATEGORY_TOKENS.some((token) => category === token || category.split(/[\s/,_-]+/).includes(token))) return true;
  const code = normalize(product.productTaxCode);
  // "ES_IVA_21" (canonical) or a bare "21" written by hand on the product.
  return /(^|_)21$/.test(code) || code === "general" || code === "general_services";
}

/** Whether the outlet's default consumption is hostelería. Pure. */
export function isFoodBeverageOutlet(outletType: string | null | undefined): boolean {
  return FOOD_BEVERAGE_OUTLET_TYPES.has(normalize(outletType));
}

/**
 * Fiscal category of one POS line: alcoholic beverages are always the general
 * rate; otherwise the outlet decides (F&B outlets → 10 %, anything else →
 * general). A product category that names a non-F&B service (spa, tienda,
 * lavandería…) inside an F&B outlet also goes to the general rate. Pure.
 */
export function posLineTaxCategory(outletType: string | null | undefined, line: PosTaxableLine): { taxCategory: PosTaxCategory; alcohol: boolean } {
  if (isAlcoholProduct(line)) return { taxCategory: "general_services", alcohol: true };
  const category = normalize(line.productCategory);
  if (category && ["spa", "tienda", "shop", "lavanderia", "laundry", "parking", "servicios", "general", "general_services"].includes(category)) {
    return { taxCategory: "general_services", alcohol: false };
  }
  return { taxCategory: isFoodBeverageOutlet(outletType) ? "food_beverage" : "general_services", alcohol: false };
}

function money(value: number | string | Decimal): Decimal {
  return new Decimal(value).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
}

/** Gross → base at a percentage, half away from zero to cents. Pure. */
export function baseFromGross(gross: Decimal, ratePercent: number): Decimal {
  if (ratePercent <= 0) return money(gross);
  return gross.div(new Decimal(1).plus(new Decimal(ratePercent).div(100))).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
}

/**
 * Taxes a closed ticket. `rates` comes from tax-rate.service for the property
 * (one spec per category). Throws on a non-finite or negative line total: a
 * ticket with an invalid amount must never reach an invoice.
 */
export function computePosTicketTax(lines: readonly PosTaxableLine[], outletType: string | null | undefined, rates: PosRateTable): PosTicketTax {
  if (lines.length === 0) throw new Error("computePosTicketTax: the ticket has no lines");
  const taxed: PosTaxedLine[] = lines.map((line) => {
    if (!Number.isFinite(line.total) || line.total < 0) throw new Error(`computePosTicketTax: invalid line total (${String(line.total)})`);
    const { taxCategory, alcohol } = posLineTaxCategory(outletType, line);
    const spec = rates[taxCategory];
    const gross = money(line.total);
    const base = baseFromGross(gross, spec.ratePercent);
    return {
      ...line,
      taxCategory,
      alcohol,
      ratePercent: spec.ratePercent,
      taxCode: spec.canonicalTaxCode,
      base: base.toFixed(2),
      quota: gross.minus(base).toFixed(2)
    };
  });

  // Group figures through the invoicing engine (contract B).
  const totals = computeInvoiceTotals(
    taxed.map((line) => {
      const spec = rates[line.taxCategory];
      return { total: money(line.total).toNumber(), ratePercent: spec.ratePercent, figure: spec.figure, impuesto: spec.impuesto, calificacion: spec.calificacion };
    })
  );
  const groups: PosTaxGroup[] = [];
  for (const category of ["food_beverage", "general_services"] as const) {
    const spec = rates[category];
    const members = taxed.filter((line) => line.taxCategory === category);
    if (members.length === 0) continue;
    const gross = members.reduce((sum, line) => sum.plus(money(line.total)), new Decimal(0));
    const group = totals.breakdown.find((g) => g.figure === spec.figure && g.calificacion === spec.calificacion && g.ratePercent === (spec.calificacion === "N1" ? 0 : spec.ratePercent));
    // computeInvoiceTotals groups by (figure, calificación, rate); two of our
    // categories can only share a group when they share the rate (IGIC 7 %
    // for both) — then the engine's group is the union and we split the base
    // proportionally by gross so Σ still squares to the cent.
    let base: Decimal;
    let quota: Decimal;
    if (group && members.length === taxed.filter((line) => rates[line.taxCategory].ratePercent === spec.ratePercent).length) {
      base = money(group.base);
      quota = money(group.quota);
    } else {
      base = baseFromGross(gross, spec.ratePercent);
      quota = gross.minus(base);
    }
    groups.push({
      taxCategory: category,
      ratePercent: spec.ratePercent,
      rateCode: spec.rateCode,
      taxCode: spec.canonicalTaxCode,
      figure: spec.figure,
      impuesto: spec.impuesto,
      calificacion: spec.calificacion,
      base: base.toFixed(2),
      quota: quota.toFixed(2),
      total: gross.toFixed(2),
      lines: members
    });
  }
  const total = groups.reduce((sum, g) => sum.plus(new Decimal(g.total)), new Decimal(0));
  const baseTotal = groups.reduce((sum, g) => sum.plus(new Decimal(g.base)), new Decimal(0));
  const taxTotal = groups.reduce((sum, g) => sum.plus(new Decimal(g.quota)), new Decimal(0));
  if (!baseTotal.plus(taxTotal).equals(total)) {
    throw new Error(`computePosTicketTax: breakdown does not square (${baseTotal.toFixed(2)} + ${taxTotal.toFixed(2)} ≠ ${total.toFixed(2)})`);
  }
  return {
    lines: taxed,
    groups,
    baseTotal: baseTotal.toFixed(2),
    taxTotal: taxTotal.toFixed(2),
    total: total.toFixed(2),
    allFoodBeverage: taxed.every((line) => line.taxCategory === "food_beverage")
  };
}

/** Folio line type of a room-charged POS ticket, keyed on the outlet (LINE_TYPE_CATEGORY of the catalogue). Pure. */
export function folioLineTypeForOutlet(outletType: string | null | undefined): string {
  switch (normalize(outletType)) {
    case "restaurant":
    case "cafe":
    case "cafeteria":
    case "breakfast":
      return "restaurant";
    case "bar":
      return "bar";
    case "roomservice":
    case "room_service":
      return "room_service";
    case "minibar":
      return "minibar";
    case "spa":
      return "spa";
    case "parking":
      return "parking";
    case "laundry":
    case "lavanderia":
      return "laundry";
    default:
      return "misc";
  }
}
