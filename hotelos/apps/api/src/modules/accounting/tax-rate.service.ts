// Per-property indirect-tax resolver (Tanda 3 · contract C).
//
// Before Tanda 3 this resolver looked Tax rows up by the free-text
// `Property.taxRegion` WITHOUT an organization filter (every tenant used the
// demo catalogue of org_123), treated '' as a valid region (→ "UNKNOWN" →
// invoice lines "ES_UNKNOWN_0" with 0 € of tax), answered 0 % for any line
// type without a seeded row, and cached forever. Now:
//
//   - region  = normalizeTaxRegion(property.taxRegion, property.province)
//               (canonical ES_PENINSULA_BALEARES | ES_CANARIAS | ES_CEUTA |
//               ES_MELILLA; null → ES_PENINSULA_BALEARES with a profile warning);
//   - category = categoryForLineType(lineType, taxCategory override);
//   - Tax row by (organizationId, canonical region) and the TaxRate valid on
//     the posting date: a row for the exact line type (appliesTo = lineType,
//     manual override or legacy seed) wins, then the category row
//     (category = X, appliesTo ∈ {X, '*'});
//   - no row → statutory rate from the catalogue (source "catalog"). The
//     resolver NEVER answers UNKNOWN: an unmapped concept gets the general
//     rate, never 0 %.
//
// The cache (property context + resolved rates) has a 60-second TTL and is
// invalidated explicitly by the writers (upsertPropertyTaxRate,
// ensurePropertyTaxes, the backfill, the property-profile / compliance
// PATCHes). Invalidation is LOCAL to the process: with several API replicas a
// write on one node leaves the others serving the previous answer until their
// entries expire (at most TAX_CACHE_TTL_MS); POST /taxes/provision on a node
// forces its own reload. The store is injectable so the money-path logic is
// unit-tested with an in-memory store (see __tests__/tax-rate.test.mts).

import { prisma } from "@hotelos/database";
import {
  ALLOWED_PERCENTS_BY_CATEGORY,
  TAX_CATEGORIES,
  TAX_CATEGORY_LABELS,
  TAX_FIGURE_NAMES,
  buildTaxCode as buildCanonicalTaxCode,
  categoryForLineType,
  defaultTouristTaxTreatment,
  figureForRegion,
  isCalificacion,
  isTaxCategory,
  isTaxRegion,
  normalizeTaxRegion,
  rateCodeFor,
  statutoryRate,
  type Calificacion,
  type TaxCategory,
  type TaxFigure,
  type TaxRegion,
  type TouristTaxTreatment,
  type VerifactuImpuesto
} from "@hotelos/compliance";
import { BadRequestError, NotFoundError } from "../../lib/http-error.js";
import { recordAuditEvent } from "../audit/audit.service.js";

// ---------------------------------------------------------------------------
// Public types (contract C)
// ---------------------------------------------------------------------------

export type ResolvedRate = {
  taxRegion: TaxRegion;
  figure: TaxFigure;
  impuesto: VerifactuImpuesto;
  category: TaxCategory;
  calificacion: Calificacion;
  ratePercent: number;
  rateCode: string;
  /** The tax figure ("IVA" | "IGIC" | "IPSI"): kept as `taxCode` for the pre-Tanda-3 callers. */
  taxCode: string;
  source: "db" | "catalog";
  verifyAgainstOrdinance: boolean;
  appliesTo: string;
  /** Canonical per-line code (buildTaxCode): "ES_IVA_10", "ES_IVA_N1"… */
  canonicalTaxCode: string;
  legalBasis: string | null;
};

export type RegionSource = "property" | "province" | "default";

/**
 * Where the effective rate of a category comes from:
 *   - "manual"  → a TaxRate row written by the property (upsertPropertyTaxRate);
 *   - "db"      → a TaxRate row provisioned from the statutory catalogue;
 *   - "catalog" → no row in force: the statutory catalogue answers directly.
 */
export type PropertyTaxProfileRateSource = "db" | "catalog" | "manual";

export type PropertyTaxProfileRate = {
  category: TaxCategory;
  ratePercent: number;
  calificacion: Calificacion;
  source: PropertyTaxProfileRateSource;
  /** True when the effective row is a manual override (source "manual"). */
  overridden: boolean;
  legalBasis: string;
  verifyAgainstOrdinance: boolean;
  validFrom: string | null;
};

export type PropertyTaxProfile = {
  propertyId: string;
  /** Canonical region configured/derived for the property; null when nothing is configured (the default applies). */
  taxRegion: TaxRegion | null;
  regionSource: RegionSource;
  /** Region actually used by the resolver (ES_PENINSULA_BALEARES when taxRegion is null). */
  effectiveTaxRegion: TaxRegion;
  /** Raw value stored in Property.taxRegion (for the UI to show what needs fixing). */
  rawTaxRegion: string | null;
  figure: TaxFigure;
  impuesto: VerifactuImpuesto;
  touristTaxTreatment: TouristTaxTreatment;
  rates: PropertyTaxProfileRate[];
  /** Rates configured for a specific folio line type (manual overrides and legacy seed rows). */
  lineTypeOverrides: Array<{ lineType: string; ratePercent: number; calificacion: Calificacion; validFrom: string; source: string }>;
  /** True when a Tax row exists in the database for (organization, region). */
  provisioned: boolean;
  ipsiOrdinanceConfirmedAt: string | null;
  warnings: string[];
};

// ---------------------------------------------------------------------------
// Store (injectable persistence)
// ---------------------------------------------------------------------------

export type TaxPropertyRow = { id: string; organizationId: string; taxRegion: string | null; province: string | null; country: string };
export type TaxRow = { id: string; organizationId: string; code: string; taxRegion: string; verifactuImpuesto: string | null; source: string };
export type TaxRateRow = {
  id: string;
  taxId: string;
  rateCode: string;
  ratePercent: number;
  appliesTo: string;
  validFrom: Date;
  validTo: Date | null;
  active: boolean;
  category: string | null;
  calificacion: string;
  verifyAgainstOrdinance: boolean;
  source: string;
  legalBasis: string | null;
};
export type TaxSettingsRow = { touristTaxTreatment: string | null; ipsiOrdinanceConfirmedAt: Date | null };

export type NewTaxRateRow = Omit<TaxRateRow, "id">;

export type TaxRateStore = {
  findProperty(propertyId: string): Promise<TaxPropertyRow | null>;
  findTax(organizationId: string, taxRegion: string): Promise<TaxRow | null>;
  createTax(data: Omit<TaxRow, "id"> & { name: string; liabilityAccountCode: string | null }): Promise<TaxRow>;
  /** Active rates of a tax valid on `date` (UTC day), most recent validFrom first. */
  findRates(taxId: string, date: Date): Promise<TaxRateRow[]>;
  /** Every active row of a category (any date), for closing overlaps on upsert. */
  findCategoryRates(taxId: string, category: TaxCategory): Promise<TaxRateRow[]>;
  findRateByKey(key: { taxId: string; rateCode: string; appliesTo: string; validFrom: Date }): Promise<TaxRateRow | null>;
  createRate(data: NewTaxRateRow): Promise<TaxRateRow>;
  updateRate(id: string, data: Partial<Omit<TaxRateRow, "id" | "taxId">>): Promise<void>;
  findSettings(propertyId: string): Promise<TaxSettingsRow | null>;
};

type PrismaLike = Pick<typeof prisma, "property" | "tax" | "taxRate" | "propertyComplianceSetting">;

type PrismaTaxRateRow = NonNullable<Awaited<ReturnType<typeof prisma.taxRate.findFirst>>>;

function toRateRow(row: PrismaTaxRateRow): TaxRateRow {
  return {
    id: row.id,
    taxId: row.taxId,
    rateCode: row.rateCode,
    ratePercent: Number(row.ratePercent),
    appliesTo: row.appliesTo,
    validFrom: row.validFrom,
    validTo: row.validTo,
    active: row.active,
    category: row.category,
    calificacion: row.calificacion,
    verifyAgainstOrdinance: row.verifyAgainstOrdinance,
    source: row.source,
    legalBasis: row.legalBasis
  };
}

/** Prisma-backed store (the default). Exported so scripts can build a service on a transaction client. */
export function createPrismaTaxRateStore(db: PrismaLike): TaxRateStore {
  return {
    async findProperty(propertyId) {
      return db.property.findUnique({
        where: { id: propertyId },
        select: { id: true, organizationId: true, taxRegion: true, province: true, country: true }
      });
    },
    async findTax(organizationId, taxRegion) {
      return db.tax.findFirst({
        where: { organizationId, taxRegion },
        select: { id: true, organizationId: true, code: true, taxRegion: true, verifactuImpuesto: true, source: true },
        orderBy: { createdAt: "asc" }
      });
    },
    async createTax(data) {
      return db.tax.create({
        data: {
          organizationId: data.organizationId,
          code: data.code,
          name: data.name,
          country: "ES",
          taxRegion: data.taxRegion,
          liabilityAccountCode: data.liabilityAccountCode,
          verifactuImpuesto: data.verifactuImpuesto,
          source: data.source
        },
        select: { id: true, organizationId: true, code: true, taxRegion: true, verifactuImpuesto: true, source: true }
      });
    },
    async findRates(taxId, date) {
      const day = dayUtc(date);
      const rows = await db.taxRate.findMany({
        where: { taxId, active: true, validFrom: { lte: day }, OR: [{ validTo: null }, { validTo: { gte: day } }] },
        orderBy: [{ validFrom: "desc" }, { id: "asc" }]
      });
      return rows.map(toRateRow);
    },
    async findCategoryRates(taxId, category) {
      const rows = await db.taxRate.findMany({
        where: { taxId, active: true, category, appliesTo: { in: [category, "*"] } },
        orderBy: [{ validFrom: "desc" }, { id: "asc" }]
      });
      return rows.map(toRateRow);
    },
    async findRateByKey(key) {
      const row = await db.taxRate.findUnique({
        where: { taxId_rateCode_appliesTo_validFrom: { taxId: key.taxId, rateCode: key.rateCode, appliesTo: key.appliesTo, validFrom: key.validFrom } }
      });
      return row ? toRateRow(row) : null;
    },
    async createRate(data) {
      const row = await db.taxRate.create({ data });
      return toRateRow(row);
    },
    async updateRate(id, data) {
      await db.taxRate.update({ where: { id }, data });
    },
    async findSettings(propertyId) {
      return db.propertyComplianceSetting.findUnique({
        where: { propertyId },
        select: { touristTaxTreatment: true, ipsiOrdinanceConfirmedAt: true }
      });
    }
  };
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

export const DEFAULT_TAX_REGION: TaxRegion = "ES_PENINSULA_BALEARES";
/**
 * Cache TTL. Kept short because invalidation is per process: on a multi-replica
 * deployment a manual override or a provisioning run on node A is only seen by
 * node B once B's entries expire, so 60 s bounds the window in which two nodes
 * can tax the same concept differently. POST /taxes/provision forces a reload
 * on the node that serves it.
 */
export const TAX_CACHE_TTL_MS = 60 * 1000;
/** Catalogue rows are provisioned with this validFrom (same as the legacy seed). */
export const CATALOG_VALID_FROM = new Date("2000-01-01T00:00:00.000Z");
const MS_DAY = 86_400_000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function dayUtc(value: Date | string): Date {
  const d = typeof value === "string" ? new Date(`${value}T00:00:00.000Z`) : value;
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function parseValidFrom(value: string | undefined, today: Date): Date {
  if (value === undefined || value === "") return dayUtc(today);
  if (!DATE_RE.test(value) || Number.isNaN(new Date(`${value}T00:00:00.000Z`).getTime())) {
    throw new BadRequestError("La fecha de vigencia debe tener formato YYYY-MM-DD.");
  }
  return dayUtc(value);
}

/**
 * Region for a property row and where it came from: the stored value on its
 * own ("property"), the province when the stored value is empty or a
 * mainland-ish legacy label ("province"), or nothing ("default").
 */
export function resolvePropertyRegion(property: { taxRegion: string | null; province: string | null }): {
  region: TaxRegion;
  configured: TaxRegion | null;
  regionSource: RegionSource;
} {
  const fromRaw = normalizeTaxRegion(property.taxRegion);
  const full = normalizeTaxRegion(property.taxRegion, property.province);
  if (full === null) return { region: DEFAULT_TAX_REGION, configured: null, regionSource: "default" };
  return { region: full, configured: full, regionSource: fromRaw === full ? "property" : "province" };
}

/**
 * Pick the rate row for a line: exact line-type row first (manual override
 * or legacy seed row), then the category row. Rows must be sorted most
 * recent validFrom first.
 */
export function pickRateRow(rows: readonly TaxRateRow[], lineType: string, category: TaxCategory): TaxRateRow | null {
  const type = lineType.trim().toLowerCase();
  const byLineType = rows.find((row) => row.appliesTo.toLowerCase() === type && row.appliesTo !== "*" && !isTaxCategoryName(row.appliesTo, category));
  if (byLineType) return byLineType;
  return rows.find((row) => row.category === category && (row.appliesTo === category || row.appliesTo === "*")) ?? null;
}

// A row whose appliesTo is the category name itself is a category row, not a
// line-type override — except when the line type IS the category name
// ("transport", "tourist_tax"), where both readings agree anyway.
function isTaxCategoryName(appliesTo: string, category: TaxCategory): boolean {
  return isTaxCategory(appliesTo) && appliesTo !== category;
}

function toTreatment(value: string | null | undefined, region: TaxRegion): TouristTaxTreatment {
  return value === "included_10" || value === "not_subject" || value === "none" ? value : defaultTouristTaxTreatment(region);
}

function isCategoryRow(row: { category: string | null; appliesTo: string }, category: TaxCategory): boolean {
  return row.category === category && (row.appliesTo === category || row.appliesTo === "*");
}

/** Active TaxRate rows of a tax, as ensurePropertyTaxes reads them (any validity). */
export type CategoryCoverageRow = { category: string | null; appliesTo: string; validFrom: Date; validTo: Date | null };

export type CategoryProvisionPlan = {
  category: TaxCategory;
  /** CATALOG_VALID_FROM for a category that never had a row; `today` when it had one that is closed or starts later. */
  validFrom: Date;
  /** Day before the next future row of the category, so the two never overlap; null when there is none. */
  validTo: Date | null;
  /** True when the row replaces a closed (validTo in the past) or future-only history — the "closed statutory row" repair. */
  repair: boolean;
};

/**
 * Which categories have NO active row in force on `today` (validFrom <= today
 * and validTo null or >= today) and the validity window the catalogue row
 * provisioned for each of them must get. A category whose only rows are
 * closed (a statutory row ended by a manual override that was later
 * superseded and never replaced) or start in the future gets a row from
 * `today`, never from 2000-01-01: reopening the historic row would rewrite
 * the period the override covered.
 */
export function planCatalogProvisioning(rows: readonly CategoryCoverageRow[], today: Date): { covered: TaxCategory[]; missing: CategoryProvisionPlan[] } {
  const day = dayUtc(today);
  const covered: TaxCategory[] = [];
  const missing: CategoryProvisionPlan[] = [];
  for (const category of TAX_CATEGORIES) {
    const history = rows.filter((row) => isCategoryRow(row, category));
    const inForce = history.some((row) => row.validFrom.getTime() <= day.getTime() && (row.validTo === null || row.validTo.getTime() >= day.getTime()));
    if (inForce) {
      covered.push(category);
      continue;
    }
    const nextStart = history
      .map((row) => row.validFrom.getTime())
      .filter((start) => start > day.getTime())
      .sort((a, b) => a - b)[0];
    missing.push({
      category,
      validFrom: history.length > 0 ? day : CATALOG_VALID_FROM,
      validTo: nextStart === undefined ? null : new Date(nextStart - MS_DAY),
      repair: history.length > 0
    });
  }
  return { covered, missing };
}

// ---------------------------------------------------------------------------
// Service factory
// ---------------------------------------------------------------------------

type CacheEntry<T> = { value: T; expiresAt: number };

type PropertyTaxContext = {
  property: TaxPropertyRow;
  region: TaxRegion;
  configured: TaxRegion | null;
  regionSource: RegionSource;
  figure: TaxFigure;
  impuesto: VerifactuImpuesto;
  tax: TaxRow | null;
  settings: TaxSettingsRow | null;
  touristTaxTreatment: TouristTaxTreatment;
};

export type AuditSink = (event: {
  organizationId: string;
  propertyId: string;
  actorUserId: string | null;
  action: string;
  entityType: string;
  entityId: string;
  beforeJson?: unknown;
  afterJson?: unknown;
}) => void;

export type TaxRateServiceOptions = {
  ttlMs?: number;
  now?: () => Date;
  audit?: AuditSink;
};

export type UpsertPropertyTaxRateInput = {
  propertyId: string;
  category: TaxCategory;
  ratePercent: number;
  calificacion?: Calificacion;
  validFrom?: string;
  actorUserId: string;
};

export type UpsertPropertyTaxRateResult = {
  /** True when the requested rate/calificación already was the effective one on validFrom: nothing written, nothing audited. */
  unchanged: boolean;
  /** Row in force after the call (the pre-existing one when unchanged; null when the catalogue answers without a row). */
  rateId: string | null;
  validFrom: string;
};

/**
 * Reject a percentage the category cannot legally carry under the figure
 * (ALLOWED_PERCENTS_BY_CATEGORY): IVA 21 % on accommodation, IGIC 3 % on a
 * room, IPSI 3 %, a not-subject accommodation… An N1 request is checked as
 * 0 %, which is only listed where the concept can be outside the tax.
 */
function assertAllowedPercent(figure: TaxFigure, category: TaxCategory, ratePercent: number, calificacion: Calificacion): void {
  const allowed = ALLOWED_PERCENTS_BY_CATEGORY[figure][category];
  if (allowed.includes(ratePercent)) return;
  const admitted = allowed.map((percent) => `${percent} %`).join(" / ");
  const error = new BadRequestError(
    calificacion === "N1"
      ? `La calificación N1 (no sujeta) no es aplicable a «${TAX_CATEGORY_LABELS[category]}» (${category}) en ${figure} (admitidos: ${admitted}).`
      : `El ${ratePercent} % no es un tipo aplicable a «${TAX_CATEGORY_LABELS[category]}» (${category}) en ${figure} (admitidos: ${admitted}).`
  );
  error.details = { code: "TAX_RATE_NOT_ALLOWED", figure, category, ratePercent, calificacion, allowed };
  throw error;
}

export function createTaxRateService(store: TaxRateStore, options: TaxRateServiceOptions = {}) {
  const ttlMs = options.ttlMs ?? TAX_CACHE_TTL_MS;
  const now = options.now ?? (() => new Date());
  const audit: AuditSink = options.audit ?? defaultAuditSink;

  const contextCache = new Map<string, CacheEntry<PropertyTaxContext>>();
  const rateCache = new Map<string, CacheEntry<ResolvedRate>>();

  function invalidateTaxCache(propertyId?: string): void {
    if (!propertyId) {
      contextCache.clear();
      rateCache.clear();
      return;
    }
    contextCache.delete(propertyId);
    const prefix = `${propertyId}::`;
    for (const key of [...rateCache.keys()]) {
      if (key.startsWith(prefix)) rateCache.delete(key);
    }
  }

  async function loadContext(propertyId: string): Promise<PropertyTaxContext> {
    const property = await store.findProperty(propertyId);
    if (!property) throw new NotFoundError("Propiedad no encontrada.");
    const { region, configured, regionSource } = resolvePropertyRegion(property);
    const { figure, impuesto } = figureForRegion(region);
    const [tax, settings] = await Promise.all([store.findTax(property.organizationId, region), store.findSettings(propertyId)]);
    return {
      property,
      region,
      configured,
      regionSource,
      figure,
      impuesto,
      tax,
      settings,
      touristTaxTreatment: toTreatment(settings?.touristTaxTreatment, region)
    };
  }

  async function getContext(propertyId: string, fresh = false): Promise<PropertyTaxContext> {
    const nowMs = now().getTime();
    const cached = contextCache.get(propertyId);
    if (!fresh && cached && cached.expiresAt > nowMs) return cached.value;
    const value = await loadContext(propertyId);
    contextCache.set(propertyId, { value, expiresAt: nowMs + ttlMs });
    return value;
  }

  function fromRow(ctx: PropertyTaxContext, category: TaxCategory, row: TaxRateRow): ResolvedRate {
    const calificacion: Calificacion = isCalificacion(row.calificacion) ? row.calificacion : "S1";
    return {
      taxRegion: ctx.region,
      figure: ctx.figure,
      impuesto: ctx.impuesto,
      category,
      calificacion,
      ratePercent: row.ratePercent,
      rateCode: row.rateCode,
      taxCode: ctx.figure,
      source: "db",
      verifyAgainstOrdinance: row.verifyAgainstOrdinance,
      appliesTo: row.appliesTo,
      canonicalTaxCode: buildCanonicalTaxCode(ctx.figure, row.ratePercent, calificacion),
      legalBasis: row.legalBasis
    };
  }

  function fromCatalog(ctx: PropertyTaxContext, category: TaxCategory): ResolvedRate {
    const spec = statutoryRate(ctx.region, category);
    return {
      taxRegion: ctx.region,
      figure: ctx.figure,
      impuesto: ctx.impuesto,
      category,
      calificacion: spec.calificacion,
      ratePercent: spec.percent,
      rateCode: rateCodeFor(ctx.figure, spec.percent, spec.calificacion),
      taxCode: ctx.figure,
      source: "catalog",
      verifyAgainstOrdinance: spec.verifyAgainstOrdinance,
      appliesTo: category,
      canonicalTaxCode: buildCanonicalTaxCode(ctx.figure, spec.percent, spec.calificacion),
      legalBasis: spec.legalBasis
    };
  }

  // Per-property tourist-tax policy: "not_subject" turns the line into N1
  // whatever the catalogue/DB says; "included_10" / "none" keep the resolved rate.
  function applyTouristTaxTreatment(ctx: PropertyTaxContext, resolved: ResolvedRate): ResolvedRate {
    if (resolved.category !== "tourist_tax" || ctx.touristTaxTreatment !== "not_subject") return resolved;
    if (resolved.calificacion === "N1" && resolved.ratePercent === 0) return resolved;
    return {
      ...resolved,
      calificacion: "N1",
      ratePercent: 0,
      rateCode: rateCodeFor(ctx.figure, 0, "N1"),
      canonicalTaxCode: buildCanonicalTaxCode(ctx.figure, 0, "N1"),
      legalBasis: "Tasa turística tratada como no sujeta por configuración de la propiedad"
    };
  }

  async function resolveTaxRate(input: { propertyId: string; lineType: string; postingDate?: Date; taxCategory?: string | null }): Promise<ResolvedRate> {
    const category = categoryForLineType(input.lineType, input.taxCategory);
    const date = dayUtc(input.postingDate ?? now());
    const cacheKey = `${input.propertyId}::${input.lineType.trim().toLowerCase()}::${category}::${isoDay(date)}`;
    const nowMs = now().getTime();
    const cached = rateCache.get(cacheKey);
    if (cached && cached.expiresAt > nowMs) return cached.value;

    const ctx = await getContext(input.propertyId);
    let resolved: ResolvedRate | null = null;
    if (ctx.tax) {
      const rows = await store.findRates(ctx.tax.id, date);
      const row = pickRateRow(rows, input.lineType, category);
      if (row) resolved = fromRow(ctx, category, row);
    }
    resolved = applyTouristTaxTreatment(ctx, resolved ?? fromCatalog(ctx, category));
    rateCache.set(cacheKey, { value: resolved, expiresAt: nowMs + ttlMs });
    return resolved;
  }

  async function getPropertyTaxProfile(propertyId: string): Promise<PropertyTaxProfile> {
    // Always fresh: the profile is what the operator reads right after saving.
    const ctx = await getContext(propertyId, true);
    const today = dayUtc(now());
    const rows = ctx.tax ? await store.findRates(ctx.tax.id, today) : [];
    const warnings: string[] = [];

    const rates: PropertyTaxProfileRate[] = TAX_CATEGORIES.map((category) => {
      const row = rows.find((r) => isCategoryRow(r, category));
      const base = applyTouristTaxTreatment(ctx, row ? fromRow(ctx, category, row) : fromCatalog(ctx, category));
      const overridden = row?.source === "manual";
      return {
        category,
        ratePercent: base.ratePercent,
        calificacion: base.calificacion,
        source: row ? (overridden ? "manual" : "db") : "catalog",
        overridden,
        legalBasis: base.legalBasis ?? statutoryRate(ctx.region, category).legalBasis,
        verifyAgainstOrdinance: base.verifyAgainstOrdinance,
        validFrom: row ? isoDay(row.validFrom) : null
      };
    });

    const lineTypeOverrides = rows
      .filter((r) => r.appliesTo !== "*" && !isTaxCategory(r.appliesTo))
      .map((r) => ({
        lineType: r.appliesTo,
        ratePercent: r.ratePercent,
        calificacion: (isCalificacion(r.calificacion) ? r.calificacion : "S1") as Calificacion,
        validFrom: isoDay(r.validFrom),
        source: r.source
      }));

    if (ctx.regionSource === "default") {
      warnings.push(
        "La propiedad no tiene región fiscal configurada ni provincia de la que derivarla: se aplica IVA (Península y Baleares) por defecto. Configura la región fiscal en el perfil de la propiedad."
      );
    } else if (ctx.regionSource === "province") {
      warnings.push(
        `La región fiscal se ha derivado de la provincia «${ctx.property.province ?? ""}» (valor almacenado: «${ctx.property.taxRegion ?? ""}»). Guarda el perfil de la propiedad para fijarla como ${ctx.region}.`
      );
    } else if (ctx.property.taxRegion && !isTaxRegion(ctx.property.taxRegion)) {
      warnings.push(`La región fiscal almacenada «${ctx.property.taxRegion}» no es canónica; se interpreta como ${ctx.region}. Guarda el perfil para normalizarla.`);
    }
    if (!ctx.tax) {
      warnings.push("Los impuestos de esta propiedad no están provisionados en base de datos: se aplican los tipos del catálogo estatutario. Ejecuta la provisión para poder personalizarlos.");
    }
    if (ctx.figure === "IPSI" && !ctx.settings?.ipsiOrdinanceConfirmedAt) {
      warnings.push("Tipos IPSI pendientes de confirmar contra la ordenanza fiscal vigente de la ciudad autónoma (cambian cada ejercicio).");
    }
    const zeroSubject = rates.filter((r) => r.calificacion === "S1" && r.ratePercent === 0);
    for (const r of zeroSubject) {
      warnings.push(`La categoría «${r.category}» tiene un tipo del 0 % sujeto (S1): VeriFactu lo rechaza; márcala como no sujeta (N1) o corrige el tipo.`);
    }

    return {
      propertyId,
      taxRegion: ctx.configured,
      regionSource: ctx.regionSource,
      effectiveTaxRegion: ctx.region,
      rawTaxRegion: ctx.property.taxRegion,
      figure: ctx.figure,
      impuesto: ctx.impuesto,
      touristTaxTreatment: ctx.touristTaxTreatment,
      rates,
      lineTypeOverrides,
      provisioned: ctx.tax !== null,
      ipsiOrdinanceConfirmedAt: ctx.settings?.ipsiOrdinanceConfirmedAt ? ctx.settings.ipsiOrdinanceConfirmedAt.toISOString() : null,
      warnings
    };
  }

  async function upsertPropertyTaxRate(input: UpsertPropertyTaxRateInput): Promise<UpsertPropertyTaxRateResult> {
    if (!isTaxCategory(input.category)) {
      throw new BadRequestError(`Categoría fiscal no válida: «${String(input.category)}». Valores admitidos: ${TAX_CATEGORIES.join(", ")}.`);
    }
    const calificacion: Calificacion = input.calificacion ?? (input.category === "not_subject" ? "N1" : "S1");
    if (!isCalificacion(calificacion)) throw new BadRequestError("La calificación debe ser S1 (sujeta) o N1 (no sujeta).");
    const ratePercent = Math.round(Number(input.ratePercent) * 100) / 100;
    if (!Number.isFinite(ratePercent) || ratePercent < 0 || ratePercent > 100) {
      throw new BadRequestError("El tipo impositivo debe ser un porcentaje entre 0 y 100.");
    }
    if (calificacion === "N1" && ratePercent !== 0) {
      throw new BadRequestError("Una operación no sujeta (N1) no lleva tipo impositivo: indica 0 %.");
    }
    if (calificacion === "S1" && ratePercent === 0) {
      throw new BadRequestError("Un tipo del 0 % debe declararse como no sujeto (N1): VeriFactu no admite operaciones sujetas (S1) al 0 %.");
    }

    const ctx = await getContext(input.propertyId, true);
    if (ctx.regionSource === "default") {
      const error = new BadRequestError("Configura la región fiscal de la propiedad (o su provincia) antes de personalizar los tipos.");
      error.details = { code: "TAX_REGION_MISSING", propertyId: input.propertyId };
      throw error;
    }
    assertAllowedPercent(ctx.figure, input.category, ratePercent, calificacion);

    // Manual rows start today unless the caller says otherwise; the catalogue
    // sentinel (2000-01-01) is reserved to provisioning — writing it here would
    // turn the statutory row into a manual one and rewrite the whole history.
    const validFrom = parseValidFrom(input.validFrom, now());
    if (validFrom.getTime() <= CATALOG_VALID_FROM.getTime()) {
      const error = new BadRequestError(
        `La fecha de vigencia ${isoDay(validFrom)} está reservada a la provisión del catálogo: indica la fecha desde la que aplica el tipo (por defecto, hoy).`
      );
      error.details = { code: "TAX_VALID_FROM_RESERVED", validFrom: isoDay(validFrom), catalogValidFrom: isoDay(CATALOG_VALID_FROM) };
      throw error;
    }

    // Effective rate on validFrom (row in force, else the catalogue). When the
    // request matches it there is nothing to change: no row is written (a
    // statutory row is never converted into a manual one) and nothing is
    // audited — the PUT is idempotent.
    const effectiveBefore = ctx.tax ? ((await store.findRates(ctx.tax.id, validFrom)).find((row) => isCategoryRow(row, input.category)) ?? null) : null;
    const statutory = statutoryRate(ctx.region, input.category);
    const effective = effectiveBefore
      ? { ratePercent: effectiveBefore.ratePercent, calificacion: effectiveBefore.calificacion }
      : { ratePercent: statutory.percent, calificacion: statutory.calificacion };
    if (effective.ratePercent === ratePercent && effective.calificacion === calificacion) {
      return { unchanged: true, rateId: effectiveBefore?.id ?? null, validFrom: isoDay(validFrom) };
    }

    const tax =
      ctx.tax ??
      (await store.createTax({
        organizationId: ctx.property.organizationId,
        code: ctx.figure,
        name: TAX_FIGURE_NAMES[ctx.figure],
        taxRegion: ctx.region,
        verifactuImpuesto: ctx.impuesto,
        source: "manual",
        liabilityAccountCode: "477"
      }));

    // Close overlaps so exactly one row of the category is valid on any day:
    // rows starting on/after the new validFrom are superseded; rows starting
    // before it end the day before.
    const dayBefore = new Date(validFrom.getTime() - MS_DAY);
    for (const row of await store.findCategoryRates(tax.id, input.category)) {
      if (row.validFrom.getTime() >= validFrom.getTime()) {
        await store.updateRate(row.id, { active: false });
      } else if (row.validTo === null || row.validTo.getTime() >= validFrom.getTime()) {
        await store.updateRate(row.id, { validTo: dayBefore });
      }
    }

    const rateCode = rateCodeFor(ctx.figure, ratePercent, calificacion);
    const data: NewTaxRateRow = {
      taxId: tax.id,
      rateCode,
      ratePercent,
      appliesTo: input.category,
      validFrom,
      validTo: null,
      active: true,
      category: input.category,
      calificacion,
      verifyAgainstOrdinance: ctx.figure === "IPSI",
      source: "manual",
      legalBasis: `Tipo configurado manualmente por la propiedad (${ctx.figure})`
    };
    const existing = await store.findRateByKey({ taxId: tax.id, rateCode, appliesTo: input.category, validFrom });
    const saved = existing ? { ...existing, ...data, id: existing.id } : await store.createRate(data);
    if (existing) {
      const { taxId: _taxId, ...update } = data;
      await store.updateRate(existing.id, update);
    }

    invalidateTaxCache(input.propertyId);
    audit({
      organizationId: ctx.property.organizationId,
      propertyId: input.propertyId,
      actorUserId: input.actorUserId || null,
      action: "TAX_RATE_UPDATED",
      entityType: "tax_rate",
      entityId: saved.id,
      beforeJson: effectiveBefore
        ? { category: input.category, ratePercent: effectiveBefore.ratePercent, calificacion: effectiveBefore.calificacion, source: effectiveBefore.source, validFrom: isoDay(effectiveBefore.validFrom) }
        : { category: input.category, source: "catalog", ...statutory },
      afterJson: { category: input.category, ratePercent, calificacion, source: "manual", validFrom: isoDay(validFrom), taxRegion: ctx.region, figure: ctx.figure }
    });
    return { unchanged: false, rateId: saved.id, validFrom: isoDay(validFrom) };
  }

  return { resolveTaxRate, invalidateTaxCache, getPropertyTaxProfile, upsertPropertyTaxRate, getContext };
}

function defaultAuditSink(event: Parameters<AuditSink>[0]): void {
  recordAuditEvent({
    organizationId: event.organizationId,
    propertyId: event.propertyId,
    actorUserId: event.actorUserId ?? undefined,
    actorType: event.actorUserId ? "user" : "system",
    action: event.action,
    entityType: event.entityType,
    entityId: event.entityId,
    beforeJson: event.beforeJson,
    afterJson: event.afterJson
  });
}

// ---------------------------------------------------------------------------
// Default (Prisma-bound) instance and module-level API
// ---------------------------------------------------------------------------

const defaultService = createTaxRateService(createPrismaTaxRateStore(prisma));

export async function resolveTaxRate(input: { propertyId: string; lineType: string; postingDate?: Date; taxCategory?: string | null }): Promise<ResolvedRate> {
  return defaultService.resolveTaxRate(input);
}

export function invalidateTaxCache(propertyId?: string): void {
  defaultService.invalidateTaxCache(propertyId);
}

export async function getPropertyTaxProfile(propertyId: string): Promise<PropertyTaxProfile> {
  return defaultService.getPropertyTaxProfile(propertyId);
}

export async function upsertPropertyTaxRate(input: UpsertPropertyTaxRateInput): Promise<UpsertPropertyTaxRateResult> {
  return defaultService.upsertPropertyTaxRate(input);
}

/**
 * @deprecated Pre-Tanda-3 signature kept for the current callers
 * (invoice.service.ts / invoicing.service.ts): `buildTaxCode(resolved.taxCode, rate)`.
 * New code uses `buildTaxCode(figure, percent, calificacion)` from @hotelos/compliance
 * or `ResolvedRate.canonicalTaxCode`.
 */
export function buildTaxCode(figure: string, percent: number, calificacion: Calificacion = "S1"): string {
  if (figure === "IVA" || figure === "IGIC" || figure === "IPSI") return buildCanonicalTaxCode(figure, percent, calificacion);
  return `ES_${figure}_${Math.round(percent)}`;
}
