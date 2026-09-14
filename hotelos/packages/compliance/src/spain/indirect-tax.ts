// Spanish indirect-tax catalogue (IVA · IGIC · IPSI) for hotel folio concepts.
//
// Normative source: docs/compliance/IMPUESTOS-INDIRECTOS-ES-2026.md (statutory
// rates in force in September 2026). This module is pure and dependency-free
// so it can be consumed by the API resolver (tax-rate.service.ts), the tenant
// provisioning (ensurePropertyTaxes), the seeds and the backfill script, and
// unit-tested with `node --test` straight from source.
//
// Two concepts that used to share `Property.taxRegion` are kept apart:
//   - the tax FIGURE that applies to the invoice (this module: IVA / IGIC / IPSI
//     by geographic region), and
//   - the REPORTING territory (`Property.fiscalTerritory`: common → VeriFactu,
//     bizkaia/gipuzkoa/araba/navarra → TicketBAI/foral), which is NOT modelled
//     here — the foral territories apply IVA and normalise to
//     ES_PENINSULA_BALEARES.

// ---------------------------------------------------------------------------
// Regions, figures and categories
// ---------------------------------------------------------------------------

export const TAX_REGIONS = ["ES_PENINSULA_BALEARES", "ES_CANARIAS", "ES_CEUTA", "ES_MELILLA"] as const;
export type TaxRegion = (typeof TAX_REGIONS)[number];

export type TaxFigure = "IVA" | "IGIC" | "IPSI";
/** VeriFactu <Impuesto> code (L1): 01 IVA · 02 IPSI · 03 IGIC. */
export type VerifactuImpuesto = "01" | "02" | "03";

export const TAX_CATEGORIES = [
  "accommodation",
  "food_beverage",
  "general_services",
  "transport",
  "tourist_tax",
  "not_subject"
] as const;
export type TaxCategory = (typeof TAX_CATEGORIES)[number];

/** VeriFactu <CalificacionOperacion>: S1 sujeta y no exenta · N1 no sujeta. */
export type Calificacion = "S1" | "N1";

/** How the tourist tax line is treated on the invoice (per-property override of the regional default). */
export type TouristTaxTreatment = "included_10" | "not_subject" | "none";

/** Human labels for region selects (value/label pairs; the front must send the value). */
export const TAX_REGION_LABELS: Record<TaxRegion, string> = {
  ES_PENINSULA_BALEARES: "Península y Baleares (IVA)",
  ES_CANARIAS: "Canarias (IGIC)",
  ES_CEUTA: "Ceuta (IPSI)",
  ES_MELILLA: "Melilla (IPSI)"
};

export const TAX_CATEGORY_LABELS: Record<TaxCategory, string> = {
  accommodation: "Alojamiento",
  food_beverage: "Restauración y bebidas",
  general_services: "Servicios generales",
  transport: "Transporte de viajeros",
  tourist_tax: "Tasa turística repercutida",
  not_subject: "No sujeto (indemnizaciones)"
};

export const TAX_FIGURE_NAMES: Record<TaxFigure, string> = {
  IVA: "Impuesto sobre el Valor Añadido",
  IGIC: "Impuesto General Indirecto Canario",
  IPSI: "Impuesto sobre la Producción, los Servicios y la Importación"
};

export function isTaxRegion(value: unknown): value is TaxRegion {
  return typeof value === "string" && (TAX_REGIONS as readonly string[]).includes(value);
}

export function isTaxCategory(value: unknown): value is TaxCategory {
  return typeof value === "string" && (TAX_CATEGORIES as readonly string[]).includes(value);
}

export function isCalificacion(value: unknown): value is Calificacion {
  return value === "S1" || value === "N1";
}

// ---------------------------------------------------------------------------
// Folio line type → fiscal category
// ---------------------------------------------------------------------------

/**
 * Folio line types known to the product and their fiscal category. Unknown
 * types fall to `general_services` (the general rate — never 0 %): a new
 * concept posted without a mapping must not silently leave the invoice
 * without tax.
 */
export const LINE_TYPE_CATEGORY: Record<string, TaxCategory> = {
  // accommodation
  room: "accommodation",
  extra_night: "accommodation",
  late_checkout: "accommodation",
  early_checkin: "accommodation",
  night: "accommodation",
  accommodation: "accommodation",
  // food & beverage
  breakfast: "food_beverage",
  half_board: "food_beverage",
  full_board: "food_beverage",
  restaurant: "food_beverage",
  bar: "food_beverage",
  room_service: "food_beverage",
  minibar: "food_beverage",
  fb: "food_beverage",
  // general services (general rate)
  spa: "general_services",
  parking: "general_services",
  laundry: "general_services",
  phone: "general_services",
  internet: "general_services",
  phone_internet: "general_services",
  meeting_room: "general_services",
  misc: "general_services",
  extra: "general_services",
  charge: "general_services",
  adjustment: "general_services",
  // passenger transport
  transport: "transport",
  transfer: "transport",
  // tourist tax passed on to the guest
  city_tax: "tourist_tax",
  tourist_tax: "tourist_tax",
  // indemnities (not subject, N1)
  no_show: "not_subject",
  no_show_fee: "not_subject",
  cancellation: "not_subject",
  cancellation_fee: "not_subject"
};

export const FOLIO_LINE_TYPES: readonly string[] = Object.freeze(Object.keys(LINE_TYPE_CATEGORY));

export const DEFAULT_TAX_CATEGORY: TaxCategory = "general_services";

/**
 * Fiscal category for a folio line: an explicit (valid) category override
 * wins, then the line-type map, then `general_services`.
 */
export function categoryForLineType(lineType: string, override?: string | null): TaxCategory {
  if (isTaxCategory(override)) return override;
  const key = (lineType ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  return LINE_TYPE_CATEGORY[key] ?? DEFAULT_TAX_CATEGORY;
}

// ---------------------------------------------------------------------------
// Statutory catalogue
// ---------------------------------------------------------------------------

export type StatutoryRateSpec = {
  percent: number;
  calificacion: Calificacion;
  legalBasis: string;
  /** IPSI rates change with each municipal ordinance: readiness demands explicit confirmation. */
  verifyAgainstOrdinance?: boolean;
};

export type RegionCatalog = {
  figure: TaxFigure;
  impuesto: VerifactuImpuesto;
  rates: Record<TaxCategory, StatutoryRateSpec>;
};

const IVA_RATES: Record<TaxCategory, StatutoryRateSpec> = {
  accommodation: { percent: 10, calificacion: "S1", legalBasis: "Ley 37/1992 art. 91.Uno.2.2º (servicios de hostelería)" },
  food_beverage: { percent: 10, calificacion: "S1", legalBasis: "Ley 37/1992 art. 91.Uno.2.2º (restauración; Ley 3/2017 servicios mixtos)" },
  general_services: { percent: 21, calificacion: "S1", legalBasis: "Ley 37/1992 art. 90 (tipo general)" },
  transport: { percent: 10, calificacion: "S1", legalBasis: "Ley 37/1992 art. 91.Uno.2.1º (transporte de viajeros)" },
  tourist_tax: { percent: 10, calificacion: "S1", legalBasis: "Doctrina DGT: la tasa repercutida forma parte de la base del alojamiento (IEET/ITS)" },
  not_subject: { percent: 0, calificacion: "N1", legalBasis: "Ley 37/1992 art. 78.Tres.1º (indemnizaciones no sujetas)" }
};

const IGIC_RATES: Record<TaxCategory, StatutoryRateSpec> = {
  accommodation: { percent: 7, calificacion: "S1", legalBasis: "Ley 4/2012 (Canarias) art. 51.1: hostelería al tipo general" },
  food_beverage: { percent: 7, calificacion: "S1", legalBasis: "Ley 4/2012 (Canarias) art. 51.1: restauración al tipo general" },
  general_services: { percent: 7, calificacion: "S1", legalBasis: "Ley 4/2012 (Canarias) art. 51.1: tipo general" },
  transport: { percent: 3, calificacion: "S1", legalBasis: "Ley 4/2012 (Canarias) art. 54: transporte terrestre al tipo reducido" },
  tourist_tax: { percent: 0, calificacion: "N1", legalBasis: "No aplica: Canarias no tiene tasa turística autonómica (2026)" },
  not_subject: { percent: 0, calificacion: "N1", legalBasis: "Indemnizaciones no sujetas (no-show / cancelación)" }
};

function ipsiRates(city: "Ceuta" | "Melilla"): Record<TaxCategory, StatutoryRateSpec> {
  const ordinance = `Ordenanza fiscal del IPSI de ${city} (verificar tipos vigentes cada ejercicio)`;
  return {
    accommodation: { percent: 2, calificacion: "S1", legalBasis: `${ordinance}: hostelería al 2 %`, verifyAgainstOrdinance: true },
    food_beverage: { percent: 2, calificacion: "S1", legalBasis: `${ordinance}: restauración al 2 % (bar de categoría no especial 1 %)`, verifyAgainstOrdinance: true },
    general_services: { percent: 4, calificacion: "S1", legalBasis: `${ordinance}: prestaciones de servicios al tipo general del 4 %`, verifyAgainstOrdinance: true },
    transport: { percent: 4, calificacion: "S1", legalBasis: `${ordinance}: prestaciones de servicios al tipo general del 4 %`, verifyAgainstOrdinance: true },
    tourist_tax: { percent: 0, calificacion: "N1", legalBasis: `No aplica: ${city} no tiene tasa turística (2026)` },
    not_subject: { percent: 0, calificacion: "N1", legalBasis: "Indemnizaciones no sujetas (no-show / cancelación)" }
  };
}

export const INDIRECT_TAX_CATALOG: Record<TaxRegion, RegionCatalog> = {
  ES_PENINSULA_BALEARES: { figure: "IVA", impuesto: "01", rates: IVA_RATES },
  ES_CANARIAS: { figure: "IGIC", impuesto: "03", rates: IGIC_RATES },
  ES_CEUTA: { figure: "IPSI", impuesto: "02", rates: ipsiRates("Ceuta") },
  ES_MELILLA: { figure: "IPSI", impuesto: "02", rates: ipsiRates("Melilla") }
};

export function figureForRegion(region: TaxRegion): { figure: TaxFigure; impuesto: VerifactuImpuesto } {
  const entry = INDIRECT_TAX_CATALOG[region];
  return { figure: entry.figure, impuesto: entry.impuesto };
}

export type StatutoryRate = {
  percent: number;
  calificacion: Calificacion;
  legalBasis: string;
  verifyAgainstOrdinance: boolean;
};

export function statutoryRate(region: TaxRegion, category: TaxCategory): StatutoryRate {
  const spec = INDIRECT_TAX_CATALOG[region].rates[category];
  return {
    percent: spec.percent,
    calificacion: spec.calificacion,
    legalBasis: spec.legalBasis,
    verifyAgainstOrdinance: spec.verifyAgainstOrdinance === true
  };
}

export type StatutoryRateRow = StatutoryRate & { category: TaxCategory };

export function statutoryRates(region: TaxRegion): StatutoryRateRow[] {
  return TAX_CATEGORIES.map((category) => ({ category, ...statutoryRate(region, category) }));
}

/** Distinct S1 percentages of a region (e.g. IVA → [10, 21]) for validating manually entered rates. */
export function statutoryPercents(region: TaxRegion): number[] {
  const set = new Set<number>();
  for (const row of statutoryRates(region)) {
    if (row.calificacion === "S1") set.add(row.percent);
  }
  return [...set].sort((a, b) => a - b);
}

/**
 * Percentages a per-property override may legally give each fiscal category
 * under each figure (docs/compliance/IMPUESTOS-INDIRECTOS-ES-2026.md). A
 * statutory tier that exists but never applies to the category is NOT listed
 * (IVA 4 % superreducido, IGIC 9.5/15/20 % incrementado, IVA 21 % on
 * accommodation…): the resolver rejects it with 400 instead of letting a typo
 * or a wrong tier reach an invoice. `0` stands for the not-subject (N1) case
 * and is only legal where the concept can be outside the tax (tourist tax in
 * territories without one, indemnities).
 *
 *   IVA  — hostelería / restauración / transporte at 10 %; general services at
 *          21 % (10 % kept for balneario-type services); the tourist tax is
 *          part of the accommodation base at 10 %.
 *   IGIC — hostelería at the general 7 %; land transport 3 % (or 7 %); no
 *          regional tourist tax (0 = N1) but 7 % if a hotel passes one on.
 *   IPSI — ordinance tiers 1 % / 2 % (hostelería) / 4 % (general services);
 *          every category may sit on any of them because each city's
 *          ordinance draws the lines differently (and changes yearly).
 */
export const ALLOWED_PERCENTS_BY_CATEGORY: Record<TaxFigure, Record<TaxCategory, number[]>> = {
  IVA: {
    accommodation: [10],
    food_beverage: [10],
    general_services: [10, 21],
    transport: [10, 21],
    tourist_tax: [10],
    not_subject: [0]
  },
  IGIC: {
    accommodation: [7],
    food_beverage: [7],
    general_services: [7],
    transport: [3, 7],
    tourist_tax: [0, 7],
    not_subject: [0]
  },
  IPSI: {
    accommodation: [1, 2, 4],
    food_beverage: [1, 2, 4],
    general_services: [1, 2, 4],
    transport: [1, 2, 4],
    tourist_tax: [0, 4],
    not_subject: [0]
  }
};

/** Regional default for the tourist-tax treatment (IVA regions include it at 10 %; IGIC/IPSI have no such tax). */
export function defaultTouristTaxTreatment(region: TaxRegion): TouristTaxTreatment {
  return INDIRECT_TAX_CATALOG[region].rates.tourist_tax.calificacion === "S1" ? "included_10" : "not_subject";
}

// ---------------------------------------------------------------------------
// Region normalisation (legacy values, front labels, province derivation)
// ---------------------------------------------------------------------------

/** Lower-case, accent-free, single-spaced key. */
function fold(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[\s_\-./]+/g, " ")
    .trim();
}

const CANONICAL_BY_KEY: Record<string, TaxRegion> = Object.fromEntries(TAX_REGIONS.map((r) => [fold(r), r]));

// Explicit island / autonomous-city labels: they name the region unambiguously.
const SPECIFIC_ALIASES: Record<string, TaxRegion> = {
  canary: "ES_CANARIAS",
  canarias: "ES_CANARIAS",
  "canary islands": "ES_CANARIAS",
  "islas canarias": "ES_CANARIAS",
  igic: "ES_CANARIAS",
  ceuta: "ES_CEUTA",
  melilla: "ES_MELILLA"
};

// Mainland-ish labels: they mean "IVA territory" but say nothing about the
// island / autonomous-city exceptions, so a province (more specific) wins.
const MAINLAND_ALIASES: ReadonlySet<string> = new Set(
  [
    "mainland",
    "common",
    "madrid",
    "andalucia",
    "mainland spain",
    "espana peninsular",
    "peninsula",
    "peninsular",
    "peninsula y baleares",
    "peninsula baleares",
    "baleares",
    "illes balears",
    "islas baleares",
    "balearic islands",
    "bizkaia",
    "gipuzkoa",
    "araba",
    "alava",
    "navarra",
    "euskadi",
    "pais vasco",
    "cataluna",
    "catalonia",
    "catalunya",
    "iva"
  ].map(fold)
);

const CANARY_PROVINCES: ReadonlySet<string> = new Set(
  [
    "Las Palmas",
    "Santa Cruz de Tenerife",
    "Tenerife",
    "Gran Canaria",
    "Lanzarote",
    "Fuerteventura",
    "La Palma",
    "La Gomera",
    "El Hierro"
  ].map(fold)
);

/** Region implied by a Spanish province name (null when the province is empty). */
export function regionForProvince(province: string | null | undefined): TaxRegion | null {
  const key = fold(province ?? "");
  if (key === "") return null;
  if (CANARY_PROVINCES.has(key)) return "ES_CANARIAS";
  if (key === "ceuta") return "ES_CEUTA";
  if (key === "melilla") return "ES_MELILLA";
  return "ES_PENINSULA_BALEARES";
}

/**
 * Canonical region for any value ever stored in `Property.taxRegion`
 * (legacy `mainland|canary|ceuta|melilla`, seed `common|Madrid|Andalucia`,
 * wizard labels `Mainland Spain|Canary Islands|…`, front labels
 * `España peninsular|Islas Canarias|…`, foral territories, '' / null).
 *
 * Rules:
 *   - canonical codes are returned as they are;
 *   - island / autonomous-city labels resolve on their own;
 *   - mainland-ish labels, '' and null resolve by `province` when given
 *     (Las Palmas / Santa Cruz de Tenerife → ES_CANARIAS, Ceuta, Melilla,
 *     anything else → ES_PENINSULA_BALEARES); a mainland-ish label with no
 *     province → ES_PENINSULA_BALEARES;
 *   - unknown labels resolve by province; without province → null. The
 *     caller decides the default (the resolver uses ES_PENINSULA_BALEARES
 *     and reports it as a warning; provisioning never persists a guess).
 */
export function normalizeTaxRegion(raw: string | null | undefined, province?: string | null): TaxRegion | null {
  const key = fold(raw ?? "");
  const byProvince = regionForProvince(province);
  if (key === "") return byProvince;
  const canonical = CANONICAL_BY_KEY[key];
  if (canonical) return canonical;
  const specific = SPECIFIC_ALIASES[key];
  if (specific) return specific;
  if (MAINLAND_ALIASES.has(key)) return byProvince ?? "ES_PENINSULA_BALEARES";
  return byProvince;
}

// ---------------------------------------------------------------------------
// Tax codes on invoice / folio lines
// ---------------------------------------------------------------------------

function formatPercent(percent: number): string {
  const rounded = Math.round(percent * 100) / 100;
  return String(rounded);
}

/**
 * Canonical per-line tax code: `ES_IVA_10`, `ES_IGIC_7`, `ES_IGIC_9.5`,
 * `ES_IPSI_2`; not-subject lines carry `ES_IVA_N1` (no rate).
 */
export function buildTaxCode(figure: TaxFigure, percent: number, calificacion: Calificacion): string {
  if (calificacion === "N1") return `ES_${figure}_N1`;
  return `ES_${figure}_${formatPercent(percent)}`;
}

export type ParsedTaxCode = { figure: TaxFigure | "UNKNOWN"; percent: number; calificacion: Calificacion };

const TAX_CODE_RE = /^(?:ES[_-])?(IVA|IGIC|IPSI)[_-]?(N1|\d+(?:[.,]\d+)?)$/i;

/**
 * Inverse of buildTaxCode, tolerant with legacy spellings (`IVA_10`, `IVA10`,
 * `ES_UNKNOWN_0`, `X`, `EXENTO`): anything not recognised is `UNKNOWN` at 0 %.
 */
export function parseTaxCode(code: string | null | undefined): ParsedTaxCode {
  const match = TAX_CODE_RE.exec((code ?? "").trim());
  if (!match) return { figure: "UNKNOWN", percent: 0, calificacion: "S1" };
  const figure = match[1].toUpperCase() as TaxFigure;
  if (match[2].toUpperCase() === "N1") return { figure, percent: 0, calificacion: "N1" };
  const percent = Number(match[2].replace(",", "."));
  return { figure, percent: Number.isFinite(percent) ? percent : 0, calificacion: "S1" };
}

/**
 * Human rate code stored in TaxRate.rateCode (kept for the accounting
 * description and the legacy readers): general / reducido / superreducido /
 * incrementado / zero / no_sujeto / custom.
 */
export function rateCodeFor(figure: TaxFigure, percent: number, calificacion: Calificacion): string {
  if (calificacion === "N1") return "no_sujeto";
  if (percent === 0) return "zero";
  switch (figure) {
    case "IVA":
      return percent === 21 ? "general" : percent === 10 ? "reducido" : percent === 4 ? "superreducido" : "custom";
    case "IGIC":
      return percent === 7 ? "general" : percent === 3 ? "reducido" : percent > 7 ? "incrementado" : "custom";
    case "IPSI":
      return percent === 4 ? "general" : percent < 4 ? "reducido" : "incrementado";
    default:
      return "custom";
  }
}
