// Frontend client for the per-property indirect-tax profile (Tanda 3 · lote iva).
//
// Backend contract (apps/api/src/modules/accounting/tax-rate.service.ts +
// server.ts routes registered by the routes lot):
//   GET  /backoffice/properties/:propertyId/taxes            → getPropertyTaxProfile
//   PUT  /backoffice/properties/:propertyId/taxes/rates      → upsertPropertyTaxRate
//   POST /backoffice/properties/:propertyId/taxes/provision  → ensurePropertyTaxes
//
// The enums below mirror packages/compliance/src/spain/indirect-tax.ts. They are
// duplicated here on purpose: admin-web does not import the compliance package
// (Vite bundle boundary), and the labels are UI copy anyway.
import { apiRequest } from "./api-client";
import { getActivePropertyId } from "./activeProperty";


export type TaxRegion = "ES_PENINSULA_BALEARES" | "ES_CANARIAS" | "ES_CEUTA" | "ES_MELILLA";
export type TaxFigure = "IVA" | "IGIC" | "IPSI";
export type VerifactuImpuesto = "01" | "02" | "03";
export type TaxCategory = "accommodation" | "food_beverage" | "general_services" | "transport" | "tourist_tax" | "not_subject";
export type Calificacion = "S1" | "N1";
export type TouristTaxTreatment = "included_10" | "not_subject" | "none";
export type FiscalTerritory = "common" | "bizkaia" | "gipuzkoa" | "araba" | "navarra";

export const TAX_REGIONS: readonly TaxRegion[] = ["ES_PENINSULA_BALEARES", "ES_CANARIAS", "ES_CEUTA", "ES_MELILLA"];

export const TAX_REGION_OPTIONS: ReadonlyArray<{ value: TaxRegion; label: string }> = [
  { value: "ES_PENINSULA_BALEARES", label: "Península y Baleares (IVA)" },
  { value: "ES_CANARIAS", label: "Canarias (IGIC)" },
  { value: "ES_CEUTA", label: "Ceuta (IPSI)" },
  { value: "ES_MELILLA", label: "Melilla (IPSI)" }
];

export const FISCAL_TERRITORY_OPTIONS: ReadonlyArray<{ value: FiscalTerritory; label: string }> = [
  { value: "common", label: "Territorio común (AEAT · VeriFactu)" },
  { value: "bizkaia", label: "Bizkaia (TicketBAI)" },
  { value: "gipuzkoa", label: "Gipuzkoa (TicketBAI)" },
  { value: "araba", label: "Álava (TicketBAI)" },
  { value: "navarra", label: "Navarra (Hacienda Foral)" }
];

export const TOURIST_TAX_TREATMENT_OPTIONS: ReadonlyArray<{ value: TouristTaxTreatment; label: string; hint: string }> = [
  {
    value: "included_10",
    label: "Incluida en la base del alojamiento (10 %)",
    hint: "IEET Cataluña / ITS Baleares: la tarifa oficial forma parte de la base del alojamiento (doctrina DGT)."
  },
  {
    value: "not_subject",
    label: "No sujeta (N1)",
    hint: "La tasa se repercute sin impuesto indirecto; en VeriFactu sale como operación no sujeta."
  },
  { value: "none", label: "No aplica (sin tasa turística)", hint: "El territorio no tiene tasa turística autonómica." }
];

/** Tourist-tax territory codes understood by the tourist-tax engine (TouristTaxRate.ccaaCode). */
export const TOURISM_TAX_REGION_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: "", label: "Ninguna" },
  { value: "CAT", label: "Cataluña (IEET)" },
  { value: "BAL", label: "Illes Balears (ITS)" },
  { value: "EUSK", label: "País Vasco" }
];

export const TAX_CATEGORY_LABELS: Record<TaxCategory, string> = {
  accommodation: "Alojamiento",
  food_beverage: "Restauración y F&B",
  general_services: "Servicios generales",
  transport: "Transporte de viajeros",
  tourist_tax: "Tasa turística",
  not_subject: "No sujeto (no-show, cancelación)"
};

export const TAX_CATEGORY_ORDER: readonly TaxCategory[] = [
  "accommodation",
  "food_beverage",
  "general_services",
  "transport",
  "tourist_tax",
  "not_subject"
];

export const TAX_CATEGORY_OPTIONS: ReadonlyArray<{ value: TaxCategory; label: string }> = TAX_CATEGORY_ORDER.map((value) => ({
  value,
  label: TAX_CATEGORY_LABELS[value]
}));

export const CALIFICACION_LABELS: Record<Calificacion, string> = {
  S1: "Sujeta (S1)",
  N1: "No sujeta (N1)"
};

export function taxRegionLabel(region: TaxRegion | string | null | undefined): string {
  const found = TAX_REGION_OPTIONS.find((option) => option.value === region);
  return found ? found.label : region ? String(region) : "Sin región fiscal";
}

export function figureForRegion(region: TaxRegion | null | undefined): { figure: TaxFigure; impuesto: VerifactuImpuesto } | null {
  switch (region) {
    case "ES_PENINSULA_BALEARES":
      return { figure: "IVA", impuesto: "01" };
    case "ES_CANARIAS":
      return { figure: "IGIC", impuesto: "03" };
    case "ES_CEUTA":
    case "ES_MELILLA":
      return { figure: "IPSI", impuesto: "02" };
    default:
      return null;
  }
}

/**
 * Client-side mirror of `normalizeTaxRegion` (contract A): maps the legacy
 * vocabularies still stored in Property.taxRegion ("mainland", "Madrid",
 * "Mainland Spain", "España peninsular", "canary", "bizkaia"…) and the province
 * to the canonical code, so selects can be pre-filled before the backfill runs.
 * Never used to WRITE: forms always submit the canonical value.
 */
export function normalizeTaxRegionClient(raw: string | null | undefined, province?: string | null): TaxRegion | null {
  const value = (raw ?? "").trim().toLowerCase();
  if (TAX_REGIONS.includes(value.toUpperCase() as TaxRegion)) return value.toUpperCase() as TaxRegion;
  if (["canary", "canarias", "canary islands", "islas canarias", "es_canarias"].includes(value)) return "ES_CANARIAS";
  if (value === "ceuta" || value === "es_ceuta") return "ES_CEUTA";
  if (value === "melilla" || value === "es_melilla") return "ES_MELILLA";
  if (
    [
      "mainland",
      "common",
      "peninsula",
      "península",
      "mainland spain",
      "españa peninsular",
      "espana peninsular",
      "baleares",
      "madrid",
      "andalucia",
      "andalucía",
      "bizkaia",
      "gipuzkoa",
      "araba",
      "navarra"
    ].includes(value)
  ) {
    return "ES_PENINSULA_BALEARES";
  }
  const prov = (province ?? "").trim().toLowerCase();
  if (!prov) return null;
  if (prov === "las palmas" || prov === "santa cruz de tenerife" || prov.includes("tenerife") || prov.includes("palmas")) return "ES_CANARIAS";
  if (prov === "ceuta") return "ES_CEUTA";
  if (prov === "melilla") return "ES_MELILLA";
  return "ES_PENINSULA_BALEARES";
}

/** Parses "ES_IVA_10" / "ES_IGIC_7" / "ES_IVA_N1" / legacy "ES_UNKNOWN_0" for badges. */
export function parseTaxCodeClient(code: string | null | undefined): { figure: TaxFigure | "UNKNOWN"; percent: number; calificacion: Calificacion } {
  const raw = (code ?? "").trim().toUpperCase();
  const match = /^ES_(IVA|IGIC|IPSI|UNKNOWN)_(N1|[0-9]+(?:[.,][0-9]+)?)$/.exec(raw);
  if (!match) {
    if (raw === "IVA" || raw.startsWith("IVA")) return { figure: "IVA", percent: Number(raw.replace(/[^0-9.]/g, "")) || 0, calificacion: "S1" };
    return { figure: "UNKNOWN", percent: 0, calificacion: "S1" };
  }
  const figure = match[1] as TaxFigure | "UNKNOWN";
  if (match[2] === "N1") return { figure, percent: 0, calificacion: "N1" };
  return { figure, percent: Number(match[2].replace(",", ".")) || 0, calificacion: "S1" };
}

/** True when a line is taxed as "unknown" or as S1 at 0 % (invalid in VeriFactu). */
export function isSuspiciousTaxLine(line: { taxCode?: string | null; taxRate?: number | null; taxCalificacion?: string | null; taxCategory?: string | null }): boolean {
  const parsed = parseTaxCodeClient(line.taxCode);
  if (parsed.figure === "UNKNOWN") return true;
  const calificacion = (line.taxCalificacion as Calificacion | undefined) ?? parsed.calificacion;
  const rate = Number(line.taxRate ?? parsed.percent) || 0;
  return calificacion === "S1" && rate === 0 && line.taxCategory !== "not_subject";
}

// ---------------------------------------------------------------------------
// API shapes (contract C · getPropertyTaxProfile / upsertPropertyTaxRate / ensurePropertyTaxes)

/**
 * Where the effective rate of a category comes from (contract C ·
 * PropertyTaxProfileRateSource in apps/api/src/modules/accounting/tax-rate.service.ts):
 *   - "manual"  → a TaxRate row written by the property (PUT …/taxes/rates);
 *                 it overrides the statutory rate of the category;
 *   - "db"      → a TaxRate row provisioned from the statutory catalogue
 *                 (POST …/taxes/provision / ensurePropertyTaxes);
 *   - "catalog" → no row in force: the statutory catalogue answers directly.
 * "db" and "catalog" are both catalogue (statutory) rates; only "manual" is a
 * property override. Any other value is rendered verbatim, never guessed.
 */
export type PropertyTaxRateSource = "manual" | "db" | "catalog";

export type PropertyTaxRateRow = {
  category: TaxCategory;
  ratePercent: number;
  calificacion: Calificacion;
  source: PropertyTaxRateSource;
  /** True when the effective row is a manual override (source "manual"); absent on older APIs. */
  overridden?: boolean;
  legalBasis: string;
  verifyAgainstOrdinance: boolean;
  validFrom: string | null;
};

/** Only an explicit "manual" is a property-configured rate. */
export function isManualTaxSource(source: PropertyTaxRateSource | string | null | undefined): boolean {
  return source === "manual";
}

/** Statutory rate, whether provisioned into the database ("db") or answered by the catalogue directly ("catalog"). */
export function isCatalogTaxSource(source: PropertyTaxRateSource | string | null | undefined): boolean {
  return source === "db" || source === "catalog";
}

/** Catalogue rate materialised as a TaxRate row of the property (POST …/taxes/provision). */
export function isProvisionedTaxSource(source: PropertyTaxRateSource | string | null | undefined): boolean {
  return source === "db";
}

/** UI badge of a rate source: «Manual» / «Catálogo»; an unknown value is shown as-is. */
export function taxRateSourceLabel(source: PropertyTaxRateSource | string | null | undefined): string {
  if (source === "manual") return "Manual";
  if (source === "db" || source === "catalog") return "Catálogo";
  return source ? String(source) : "—";
}

/** Tooltip / detail of a rate source, distinguishing provisioned rows from direct catalogue answers. */
export function taxRateSourceDetail(source: PropertyTaxRateSource | string | null | undefined): string {
  if (source === "manual") return "Tipo configurado por la propiedad: prevalece sobre el catálogo estatutario para este concepto.";
  if (source === "db") return "Tipo estatutario provisionado del catálogo (fila propia en la base de datos).";
  if (source === "catalog") return "Tipo estatutario del catálogo: la propiedad no tiene fila para este concepto y el resolutor responde con el tipo legal.";
  return `Origen no reconocido por esta versión del panel («${source ? String(source) : ""}»).`;
}

/** Rate configured for a specific folio line type (manual override or legacy seed row), as the profile reports it. */
export type PropertyTaxLineTypeOverride = {
  lineType: string;
  ratePercent: number;
  calificacion: Calificacion;
  validFrom: string;
  source: string;
};

export type PropertyTaxProfile = {
  propertyId: string;
  taxRegion: TaxRegion | null;
  regionSource: "property" | "province" | "default";
  /** Region the resolver actually uses (ES_PENINSULA_BALEARES when taxRegion is null); absent on older APIs. */
  effectiveTaxRegion?: TaxRegion;
  /** Raw Property.taxRegion value, for showing what needs fixing; absent on older APIs. */
  rawTaxRegion?: string | null;
  figure: TaxFigure;
  impuesto: VerifactuImpuesto;
  touristTaxTreatment: TouristTaxTreatment;
  rates: PropertyTaxRateRow[];
  /** Rates bound to a folio line type instead of a category; absent on older APIs. */
  lineTypeOverrides?: PropertyTaxLineTypeOverride[];
  /** True when a Tax row exists for (organization, region); absent on older APIs. */
  provisioned?: boolean;
  ipsiOrdinanceConfirmedAt: string | null;
  warnings: string[];
};

/** `details.code` values PUT …/taxes/rates and POST …/taxes/provision answer with (400). */
export const TAX_RATE_ERROR_CODES = {
  /** The percentage is not a statutory rate of the category under the figure; details.allowed lists the legal ones. */
  notAllowed: "TAX_RATE_NOT_ALLOWED",
  /** The property has no fiscal region (nor a province to derive it from). */
  regionMissing: "TAX_REGION_MISSING",
  /** validFrom collides with the catalogue's own validity start. */
  validFromReserved: "TAX_VALID_FROM_RESERVED"
} as const;

/** Typed reading of a tax-rate 400: code plus, for TAX_RATE_NOT_ALLOWED, the admitted percentages. */
export function taxRateErrorDetails(details: unknown): { code: string | null; allowed: number[] } {
  const record = (details && typeof details === "object" ? details : {}) as { code?: unknown; allowed?: unknown };
  const code = typeof record.code === "string" ? record.code : null;
  const allowed = Array.isArray(record.allowed) ? record.allowed.filter((value): value is number => typeof value === "number" && Number.isFinite(value)) : [];
  return { code, allowed };
}

export type UpsertPropertyTaxRateInput = {
  category: TaxCategory;
  ratePercent: number;
  calificacion?: Calificacion;
  validFrom?: string;
};

/**
 * POST …/taxes/provision (ensurePropertyTaxes): creates the statutory rates
 * of the categories that have no active row; categories that already have one
 * (manual or catalogue) are counted in `skipped` and left untouched. The
 * server also returns the fresh profile.
 */
export type ProvisionPropertyTaxesResult = {
  taxRegion: TaxRegion | null;
  provisioned: number;
  skipped: number;
  profile?: PropertyTaxProfile;
};

export function fetchPropertyTaxes(propertyId = getActivePropertyId()): Promise<PropertyTaxProfile> {
  return apiRequest<PropertyTaxProfile>(`/backoffice/properties/${propertyId}/taxes`);
}

export function upsertPropertyTaxRate(propertyId: string, input: UpsertPropertyTaxRateInput): Promise<void> {
  return apiRequest<void>(`/backoffice/properties/${propertyId}/taxes/rates`, { method: "PUT", body: input });
}

export function provisionPropertyTaxes(propertyId: string): Promise<ProvisionPropertyTaxesResult> {
  return apiRequest<ProvisionPropertyTaxesResult>(`/backoffice/properties/${propertyId}/taxes/provision`, { method: "POST", body: {} });
}

/** Rate (percent) and calificación the profile assigns to a category; null when the profile lacks it. */
export function rateForCategory(profile: PropertyTaxProfile | null | undefined, category: TaxCategory): PropertyTaxRateRow | null {
  if (!profile) return null;
  return profile.rates.find((row) => row.category === category) ?? null;
}

/** Builds the canonical tax code the API expects for a resolved rate ("ES_IVA_10", "ES_IVA_N1"). */
export function buildTaxCodeClient(figure: TaxFigure, percent: number, calificacion: Calificacion): string {
  if (calificacion === "N1") return `ES_${figure}_N1`;
  const rounded = Math.round(percent * 100) / 100;
  return `ES_${figure}_${Number.isInteger(rounded) ? rounded : rounded.toString()}`;
}
