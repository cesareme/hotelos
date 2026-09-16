// Estructura societaria · L6 (Tanda 6b) — pure helpers of the
// Configuración › Estructura societaria screens (design
// docs/design/FINANZAS-ESTRUCTURA-SOCIETARIA.md §5.3): Spanish labels of the
// enums, the live NIF checksum the «Datos fiscales» form paints while typing
// (same rules as packages/compliance/src/spain/tax-id.ts — admin-web cannot
// depend on @hotelos/compliance, so the arithmetic is mirrored here and pinned
// by __tests__/structure-ui.test.mts), the centre-code suggestion of the
// «Añadir centro» wizard, the R3 series proposal, the client-side prefix clash
// count of the Centros KPI, the manual allocation weights check and the
// mapping of the typed 4xx of the structure routes to Spanish sentences.
//
// No React, no network, no import.meta: runs under `node --test`.

import type {
  CorporateAllocationMethod,
  LegalForm,
  PgcVariant,
  PropertyKind,
  StructureMode,
  VerifactuChainScope
} from "@hotelos/shared";
import { financeErrorCode, financeErrorDetails, financeErrorMessage } from "../../services/finance-contracts";

// ---------------------------------------------------------------------------
// Vocabulary (design §5.3: Sociedad · Centro de trabajo · Hotel / Oficina / Otro)
// ---------------------------------------------------------------------------

export const PROPERTY_KIND_LABELS: Readonly<Record<PropertyKind, string>> = Object.freeze({
  hotel: "Hotel",
  office: "Oficina",
  other: "Otro"
});

export const PROPERTY_KIND_OPTIONS: ReadonlyArray<{ value: PropertyKind; label: string }> = Object.freeze([
  { value: "hotel", label: "Hotel" },
  { value: "office", label: "Oficina" },
  { value: "other", label: "Otro" }
]);

export const LEGAL_FORM_LABELS: Readonly<Record<LegalForm, string>> = Object.freeze({
  sa: "Sociedad anónima (S.A.)",
  sl: "Sociedad limitada (S.L.)",
  slu: "Sociedad limitada unipersonal (S.L.U.)",
  coop: "Cooperativa",
  persona_fisica: "Persona física",
  otra: "Otra"
});

export const LEGAL_FORM_OPTIONS: ReadonlyArray<{ value: string; label: string }> = Object.freeze([
  { value: "", label: "Sin indicar" },
  ...(Object.entries(LEGAL_FORM_LABELS) as Array<[LegalForm, string]>).map(([value, label]) => ({ value, label }))
]);

export const PGC_VARIANT_LABELS: Readonly<Record<PgcVariant, string>> = Object.freeze({
  pymes: "PGC de Pymes",
  general: "PGC general"
});

export const PGC_VARIANT_OPTIONS: ReadonlyArray<{ value: PgcVariant; label: string }> = Object.freeze([
  { value: "pymes", label: "PGC de Pymes (activo ≤ 4 M€, cifra de negocios ≤ 8 M€, ≤ 50 empleados)" },
  { value: "general", label: "PGC general (supera los umbrales o audita)" }
]);

export const CHAIN_SCOPE_LABELS: Readonly<Record<VerifactuChainScope, string>> = Object.freeze({
  per_center: "Cadena por centro (una instalación por centro facturador)",
  per_entity: "Cadena por sociedad (una instalación para todo el NIF)"
});

export const CHAIN_SCOPE_SHORT_LABELS: Readonly<Record<VerifactuChainScope, string>> = Object.freeze({
  per_center: "Cadena por centro",
  per_entity: "Cadena por sociedad"
});

export const ALLOCATION_METHOD_LABELS: Readonly<Record<CorporateAllocationMethod, string>> = Object.freeze({
  none: "Ninguno",
  rooms_available: "Habitaciones",
  revenue: "Ingresos",
  headcount: "Plantilla",
  manual: "Porcentajes"
});

export const ALLOCATION_METHOD_ORDER: readonly CorporateAllocationMethod[] = Object.freeze(["none", "rooms_available", "revenue", "headcount", "manual"]);

export const ALLOCATION_METHOD_HELP: Readonly<Record<CorporateAllocationMethod, string>> = Object.freeze({
  none: "El coste de la oficina central se muestra como columna propia y no se reparte entre los hoteles.",
  rooms_available: "Cada hotel recibe una parte proporcional a sus habitaciones disponibles en el periodo.",
  revenue: "Cada hotel recibe una parte proporcional a sus ingresos de explotación del periodo.",
  headcount: "Cada hotel recibe una parte proporcional a su plantilla del periodo.",
  manual: "Fija tú el porcentaje de cada hotel; la suma tiene que ser 100."
});

/** Invoice type codes of the series (F1 · F2 · R…) as the hotelier reads them. */
export const INVOICE_TYPE_LABELS: Readonly<Record<string, string>> = Object.freeze({
  F1: "Completa (F1)",
  F2: "Simplificada (F2)",
  F3: "Sustitutiva de simplificadas (F3)",
  R: "Rectificativa (R)",
  R1: "Rectificativa (R1)",
  R2: "Rectificativa (R2)",
  R3: "Rectificativa (R3)",
  R4: "Rectificativa (R4)",
  R5: "Rectificativa simplificada (R5)",
  full: "Completa (F1)",
  simplified: "Simplificada (F2)",
  rectifying: "Rectificativa (R)",
  credit_note: "Abono (R)"
});

export function invoiceTypeLabel(code: string | null | undefined): string {
  if (!code) return "—";
  return INVOICE_TYPE_LABELS[code] ?? code;
}

export function propertyKindLabel(kind: PropertyKind | string | null | undefined): string {
  if (!kind) return "—";
  return (PROPERTY_KIND_LABELS as Record<string, string>)[kind] ?? kind;
}

/**
 * Title of the wizard's success state, agreeing in gender with the kind
 * («Oficina «X» creada», «Hotel «X» creado»; «Otro» reads as «Centro», qa#4).
 */
export function propertyCreatedTitle(kind: PropertyKind | string | null | undefined, name: string): string {
  if (kind === "office") return `Oficina «${name}» creada`;
  if (kind === "hotel") return `Hotel «${name}» creado`;
  return `Centro «${name}» creado`;
}

/** Only a hotel runs the lodging operation (rooms, rates, POS, tasa, SES): R6. */
export function isOperationalKind(kind: PropertyKind | string | null | undefined): boolean {
  return kind === "hotel";
}

export function legalFormLabel(form: LegalForm | string | null | undefined): string {
  if (!form) return "Sin indicar";
  return (LEGAL_FORM_LABELS as Record<string, string>)[form] ?? form;
}

export type StructureView = "fiscal" | "properties" | "series" | "vat" | "allocation";

/** Screen key of each tab in pilots/tanda5-nav-tree.csv (item = Datos fiscales). */
export const STRUCTURE_VIEW_SCREEN_KEYS: Readonly<Record<StructureView, string>> = Object.freeze({
  fiscal: "StructureScreen",
  properties: "StructurePropertiesTab",
  series: "StructureSeriesTab",
  vat: "StructureVatTab",
  allocation: "StructureAllocationTab"
});

/** Fallback titles when a key is not in the tree (the tree labels win, treeHeaderFor). */
export const STRUCTURE_VIEW_TITLES: Readonly<Record<StructureView, string>> = Object.freeze({
  fiscal: "Datos fiscales",
  properties: "Centros",
  series: "Series y VeriFactu",
  vat: "IVA y ejercicio",
  allocation: "Reparto"
});

export const STRUCTURE_MODE_LABELS: Readonly<Record<StructureMode, string>> = Object.freeze({
  single_hotel: "Hotel individual",
  multi_center: "Sociedad con varios centros",
  group: "Grupo de sociedades"
});

/** «7 hoteles · 1 oficina · 0 otros» — the footer of the Centros table. */
export function describeCentreCounts(counts: { hotels: number; offices: number; others: number }): string {
  const hotels = `${counts.hotels} ${counts.hotels === 1 ? "hotel" : "hoteles"}`;
  const offices = `${counts.offices} ${counts.offices === 1 ? "oficina" : "oficinas"}`;
  const others = `${counts.others} ${counts.others === 1 ? "otro" : "otros"}`;
  return `${hotels} · ${offices} · ${others}`;
}

/** Eyebrow of every structure screen: «Configuración · <sociedad>» (design §5.3). */
export function structureEyebrow(legalName: string | null | undefined): string {
  const name = legalName?.trim();
  return name ? `Configuración · ${name}` : "Configuración";
}

// ---------------------------------------------------------------------------
// NIF (mirror of packages/compliance/src/spain/tax-id.ts — no runtime dependency)
// ---------------------------------------------------------------------------

const DNI_CONTROL_LETTERS = "TRWAGMYFPDXBNJZSQVHLCKE";
const CIF_CONTROL_LETTERS = "JABCDEFGHI";
const CIF_ORGANISATION_LETTERS = "ABCDEFGHJNPQRSUVW";
const CIF_DIGIT_CONTROL_ONLY = "ABEH";
const CIF_LETTER_CONTROL_ONLY = "NPQRSW";

export type TaxIdKind = "DNI" | "NIE" | "NIF_SPECIAL" | "CIF";

/** Canonical form: upper-case, no separators, without the «ES» VAT prefix; null when empty. */
export function normalizeTaxId(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  let value = String(raw).toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (value.length === 11 && value.startsWith("ES")) value = value.slice(2);
  return value.length > 0 ? value : null;
}

function dniControlLetter(digits: string): string {
  return DNI_CONTROL_LETTERS[Number(digits) % 23] ?? "";
}

function cifControl(digits: string): { digit: string; letter: string } {
  let sum = 0;
  for (let i = 0; i < digits.length; i += 1) {
    const n = Number(digits[i]);
    if (i % 2 === 0) {
      const doubled = n * 2;
      sum += Math.floor(doubled / 10) + (doubled % 10);
    } else {
      sum += n;
    }
  }
  const control = (10 - (sum % 10)) % 10;
  return { digit: String(control), letter: CIF_CONTROL_LETTERS[control] ?? "" };
}

export function classifyTaxId(raw: string | null | undefined): TaxIdKind | null {
  const value = normalizeTaxId(raw);
  if (!value || value.length !== 9) return null;
  if (/^\d{8}[A-Z]$/.test(value)) return "DNI";
  if (/^[XYZ]\d{7}[A-Z]$/.test(value)) return "NIE";
  if (/^[KLM]\d{7}[A-Z]$/.test(value)) return "NIF_SPECIAL";
  if (new RegExp(`^[${CIF_ORGANISATION_LETTERS}]\\d{7}[0-9A-J]$`).test(value)) return "CIF";
  return null;
}

/**
 * Spanish reason why the value is not a valid NIF, or null when it passes the
 * control character. Painted live under the NIF field; the API repeats the
 * check (400 TAX_ID_INVALID) and adds uniqueness (409 TAX_ID_IN_USE).
 */
export function taxIdValidationMessage(raw: string | null | undefined): string | null {
  const value = normalizeTaxId(raw);
  if (!value) return "El NIF está vacío.";
  if (value.length !== 9) return "El NIF debe tener 9 caracteres (letra o dígitos más carácter de control).";
  const kind = classifyTaxId(value);
  if (!kind) return "El formato no corresponde a un DNI, NIE o CIF español.";
  if (/^[A-Z]?0{7,8}[A-Z0-9]$/.test(value)) return "El NIF es un valor de relleno (todo ceros), no un identificador real.";
  if (kind === "DNI") return dniControlLetter(value.slice(0, 8)) === value[8] ? null : "La letra de control del DNI no coincide.";
  if (kind === "NIE") {
    const prefix = { X: "0", Y: "1", Z: "2" }[value[0] as "X" | "Y" | "Z"];
    return dniControlLetter(prefix + value.slice(1, 8)) === value[8] ? null : "La letra de control del NIE no coincide.";
  }
  if (kind === "NIF_SPECIAL") return dniControlLetter(value.slice(1, 8)) === value[8] ? null : "La letra de control del NIF no coincide.";
  const organisationLetter = value[0]!;
  const control = value[8]!;
  const expected = cifControl(value.slice(1, 8));
  const isDigit = /\d/.test(control);
  if (isDigit && CIF_LETTER_CONTROL_ONLY.includes(organisationLetter)) return `Los CIF que empiezan por ${organisationLetter} llevan letra de control, no dígito.`;
  if (!isDigit && CIF_DIGIT_CONTROL_ONLY.includes(organisationLetter)) return `Los CIF que empiezan por ${organisationLetter} llevan dígito de control, no letra.`;
  return (isDigit ? control === expected.digit : control === expected.letter) ? null : "El carácter de control del CIF no coincide.";
}

export function isValidTaxId(raw: string | null | undefined): boolean {
  return taxIdValidationMessage(raw) === null;
}

// ---------------------------------------------------------------------------
// Codes (LegalEntity.code / Property.code: 2-6 upper-case letters or digits)
// ---------------------------------------------------------------------------

export const STRUCTURE_CODE_PATTERN = /^[A-Z0-9]{2,6}$/;

export function normalizeStructureCode(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
}

export function structureCodeError(raw: string): string | null {
  const value = raw.trim();
  if (value === "") return null;
  return STRUCTURE_CODE_PATTERN.test(value) ? null : "Código de 2 a 6 letras o dígitos en mayúsculas (p. ej. RA, LT, OC).";
}

const CODE_STOP_WORDS = new Set(["de", "del", "la", "el", "los", "las", "y", "e", "by", "the", "hotel", "hoteles", "collection", "ascend", "sl", "sa", "slu"]);

function stripDiacritics(value: string): string {
  return value.normalize("NFD").replace(/[̀-ͯ]/g, "");
}

/**
 * Centre code proposed from its name: initials of the meaningful words
 * («Faranda Rías Altas» → RA when «Faranda» is a brand token of the sociedad,
 * else FRA), «Oficina central» → OC; padded to 2 characters and made unique
 * against the codes already taken (numeric suffix). Mirrors the derivation of
 * the API loosely — the API always has the last word (dryRun returns `code`).
 */
export function suggestCentreCode(name: string, taken: readonly string[] = [], brandTokens: readonly string[] = []): string {
  const brand = new Set(brandTokens.map((token) => stripDiacritics(token).toLowerCase()));
  const words = stripDiacritics(name)
    .toUpperCase()
    .replace(/[^A-Z0-9 ]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length > 0 && !CODE_STOP_WORDS.has(word.toLowerCase()) && !brand.has(word.toLowerCase()));
  let base = words.map((word) => word[0]).join("");
  if (base.length < 2) base = (words[0] ?? stripDiacritics(name).toUpperCase().replace(/[^A-Z0-9]/g, "")).slice(0, 3);
  if (base.length < 2) base = (base + "XX").slice(0, 2);
  base = base.slice(0, 6);
  const used = new Set(taken.map((code) => code.toUpperCase()));
  if (!used.has(base)) return base;
  for (let suffix = 2; suffix < 100; suffix += 1) {
    const candidate = `${base.slice(0, 6 - String(suffix).length)}${suffix}`;
    if (!used.has(candidate)) return candidate;
  }
  return base;
}

// ---------------------------------------------------------------------------
// Series (R3: `${serie}-${año}-` with one billing centre, `${serie}-${código}-${año}-` with several)
// ---------------------------------------------------------------------------

export type ProposedSeries = {
  sequenceCode: string;
  invoiceType: "F1" | "F2" | "R1";
  label: string;
  prefix: string;
  /** Series every billing centre gets by default; the rectificativa is optional but recommended. */
  recommended: boolean;
};

/** The three series a new billing centre opens (FAC · FS · R) with their R3 prefix. */
export function proposeSeries(input: { code: string; year: number; codedPrefix: boolean }): ProposedSeries[] {
  const code = input.code.trim().toUpperCase();
  const prefixOf = (serie: string) => (input.codedPrefix && code ? `${serie}-${code}-${input.year}-` : `${serie}-${input.year}-`);
  return [
    { sequenceCode: "FAC", invoiceType: "F1", label: "Facturas completas", prefix: prefixOf("FAC"), recommended: true },
    { sequenceCode: "FS", invoiceType: "F2", label: "Facturas simplificadas", prefix: prefixOf("FS"), recommended: true },
    { sequenceCode: "R", invoiceType: "R1", label: "Rectificativas", prefix: prefixOf("R"), recommended: true }
  ];
}

export type SeriesLike = { propertyId: string; prefix: string | null; year: number | null; active: boolean };

/** Rows whose active prefix + year is used by another centre (case-insensitive), as the API's markSeriesClashes. */
export function findPrefixClashes<T extends SeriesLike>(rows: readonly T[]): T[] {
  const byKey = new Map<string, T[]>();
  for (const row of rows) {
    if (!row.active || !row.prefix) continue;
    const key = `${row.prefix.toUpperCase()}|${row.year ?? "any"}`;
    const list = byKey.get(key) ?? [];
    list.push(row);
    byKey.set(key, list);
  }
  const clashing: T[] = [];
  for (const list of byKey.values()) {
    const properties = new Set(list.map((row) => row.propertyId));
    if (properties.size > 1) clashing.push(...list);
  }
  return clashing;
}

/** Number of billing centres of the sociedad (centres with at least one active series): decides the R3 prefix of the next one. */
export function countBillingCentres(properties: ReadonlyArray<{ series: ReadonlyArray<{ active: boolean }> }>): number {
  return properties.filter((property) => property.series.some((series) => series.active)).length;
}

/** «FAC-RA · FS-RA» — the series column of the Centros table (sequence codes, active first). */
export function seriesSummary(series: ReadonlyArray<{ sequenceCode: string; active: boolean }>): string {
  const active = series.filter((row) => row.active).map((row) => row.sequenceCode);
  if (active.length === 0) return "—";
  return [...new Set(active)].join(" · ");
}

// ---------------------------------------------------------------------------
// Reparto informativo (R5)
// ---------------------------------------------------------------------------

export type WeightDraft = { propertyId: string; weight: string };

export function parseWeight(raw: string): number | null {
  const trimmed = raw.trim().replace(",", ".");
  if (trimmed === "") return null;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : null;
}

/** Total of the manual weights (invalid cells count as 0) rounded to 2 decimals. */
export function weightsTotal(weights: readonly WeightDraft[]): number {
  const sum = weights.reduce((acc, row) => acc + (parseWeight(row.weight) ?? 0), 0);
  return Math.round(sum * 100) / 100;
}

/** Spanish error of the manual key, or null when every weight is 0-100 and they add up to 100. */
export function manualWeightsError(weights: readonly WeightDraft[]): string | null {
  if (weights.length === 0) return "El reparto por porcentajes necesita al menos un hotel.";
  for (const row of weights) {
    const value = parseWeight(row.weight);
    if (value === null || value < 0 || value > 100) return "Cada peso debe ser un número entre 0 y 100.";
  }
  const total = weightsTotal(weights);
  if (Math.abs(total - 100) > 0.001) return `Los pesos suman ${String(total).replace(".", ",")} y tienen que sumar 100.`;
  return null;
}

// ---------------------------------------------------------------------------
// PGC / régimen (R8, R9)
// ---------------------------------------------------------------------------

/** Warning under the PGC variant control (LSC arts. 257-258 thresholds). */
export function pgcVariantWarning(variant: PgcVariant, largeCompany: boolean): string | null {
  if (variant === "pymes" && largeCompany) {
    return "La sociedad está marcada como gran empresa: el formato de cuentas anuales de Pymes no es depositable (LSC arts. 257-258). Cambia a PGC general o revisa la marca.";
  }
  if (variant === "pymes") {
    return "Pymes solo si durante dos ejercicios seguidos no se superan dos de los tres umbrales: activo 4 M€, cifra de negocios 8 M€, 50 empleados.";
  }
  return "El PGC general exige la memoria normal y los formatos normales de balance, PyG, ECPN y EFE; la plantilla general hotelera aún no está disponible en Cuentas anuales.";
}

// ---------------------------------------------------------------------------
// Errors (details.code → Spanish; the dictionary lives in services/finance-contracts.ts)
// ---------------------------------------------------------------------------

export const STRUCTURE_ERROR_FALLBACK = "No se pudo completar la operación. Inténtalo de nuevo.";

/** `details.code` of a structure error, or null. */
export function structureErrorCode(error: unknown): string | null {
  return financeErrorCode(error);
}

export function structureErrorDetails(error: unknown): Record<string, unknown> | null {
  return financeErrorDetails(error);
}

/**
 * Spanish sentence for a structure error, enriched with the details the API
 * sends: the clashing prefix and sister centre (SERIES_PREFIX_CLASH), the
 * reason of an invalid NIF (TAX_ID_INVALID), the fields of a high-risk change
 * (HIGH_RISK_CONFIRMATION_REQUIRED keeps the API's worded message).
 */
export function structureErrorMessage(error: unknown, fallback: string = STRUCTURE_ERROR_FALLBACK, context: { propertyNames?: Readonly<Record<string, string>> } = {}): string {
  const code = structureErrorCode(error);
  const details = structureErrorDetails(error);
  const base = financeErrorMessage(error, fallback);
  if (code === "SERIES_PREFIX_CLASH" && details) {
    const prefix = typeof details.prefix === "string" ? details.prefix : null;
    const sister = typeof details.conflictingPropertyId === "string" ? context.propertyNames?.[details.conflictingPropertyId] ?? null : null;
    const where = sister ? ` Ya lo usa ${sister}.` : "";
    return prefix ? `El prefijo «${prefix}» ya está en uso en otro centro de la sociedad este año.${where} Elige otro prefijo, por ejemplo con el código del centro.` : `${base}${where}`;
  }
  if (code === "TAX_ID_INVALID" && details && typeof details.reason === "string" && details.reason.trim()) {
    return `${base} ${details.reason.trim()}`;
  }
  if (code === "HIGH_RISK_CONFIRMATION_REQUIRED" || code === "VERIFACTU_SUBMISSIONS_PENDING" || code === "CHAIN_ALREADY_STARTED" || code === "PROPERTY_KIND_CHANGE_BLOCKED") {
    const message = (error as { message?: unknown } | null)?.message;
    if (typeof message === "string" && message.trim()) return message.trim();
  }
  return base;
}

export type HighRiskChange = { field: string; from: unknown; to: unknown };

/** `details.changes` of a 409 HIGH_RISK_CONFIRMATION_REQUIRED as a list (empty when absent). */
export function highRiskChangesOf(error: unknown): HighRiskChange[] {
  const details = structureErrorDetails(error);
  const changes = details?.changes;
  if (!changes || typeof changes !== "object") return [];
  return Object.entries(changes as Record<string, unknown>).map(([field, change]) => {
    const pair = change && typeof change === "object" ? (change as { from?: unknown; to?: unknown }) : {};
    return { field, from: pair.from ?? null, to: pair.to ?? null };
  });
}

/** Field a typed 4xx points at inside the «Datos fiscales» form (null → general callout). */
export function fiscalDataFieldOf(code: string | null): "taxId" | "code" | "legalName" | null {
  switch (code) {
    case "TAX_ID_INVALID":
    case "TAX_ID_IN_USE":
      return "taxId";
    case "CODE_IN_USE":
      return "code";
    default:
      return null;
  }
}

export const HIGH_RISK_FIELD_LABELS: Readonly<Record<string, string>> = Object.freeze({
  taxId: "NIF",
  legalName: "Razón social",
  siiEnabled: "Sociedad en el SII",
  largeCompany: "Gran empresa",
  pgcVariant: "Variante del PGC",
  fiscalYearStartMonth: "Inicio del ejercicio"
});

export function highRiskFieldLabel(field: string): string {
  return HIGH_RISK_FIELD_LABELS[field] ?? field;
}

/** Human text of a high-risk change value (booleans and nulls in Spanish). */
export function describeChangeValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return "sin valor";
  if (value === true) return "sí";
  if (value === false) return "no";
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return (PGC_VARIANT_LABELS as Record<string, string>)[value] ?? value;
  return String(value);
}
