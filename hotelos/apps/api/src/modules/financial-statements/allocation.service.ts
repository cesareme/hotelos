// Reparto informativo de la oficina central (Tanda 6b · L5 · design §5.2 R5).
//
// Inside ONE sociedad the head office is not a related party: its costs are
// booked once, on the `office` centre, and USALI / PyG por centro may SHOW them
// split over the hotels by a key — «Cluster Services / Corporate Office» in
// USALI terms. The split is reporting only: no journal entry is ever posted
// (`posted: false` is a constant of the wire contract and every row carries
// the label «Reparto corporativo (informativo · no contabilizado)»); the
// diario, the 303 and the cuentas anuales never see it. The key lives in
// `AccountingSetting.configurationJson.corporateAllocation` (contract:
// CorporateAllocation in packages/shared/src/legal-structure-types.ts):
//   none            → nothing allocated (default);
//   revenue         → by total operating revenue of each hotel in the period;
//   rooms_available → by rooms available (active rooms × nights);
//   headcount       → by staff with a payslip in the period, per centre;
//   manual          → stored weights (hotels only) that add up to 100.
// Money: Prisma.Decimal; the shares add up to the cost EXACTLY (the cent
// remainder of the rounding goes to the largest weight).
//
// ONE base for every statement (fix t6b#16): the amount split is the
// operating cost of the corporate centres = −GOP of their USALI statement
// (departmental + undistributed expenses − operating revenue), the level at
// which USALI 11th ed. places «Cluster Services / Corporate Office» in each
// hotel. The USALI comparison and the PyG por centro compute it from the same
// rows and mappings (`corporateCostFromGop`), so both show the same
// corporateCost for the same period. Below-GOP items of the office (financial
// income/expense, depreciation, rent, insurance, taxes) are never split, and a
// corporate GOP ≥ 0 (the office bills more than it spends) means there is no
// cost to allocate: `applied: false` with a Spanish warning instead of a
// negative «cost» booked as income in the hotels.

import { prisma } from "@hotelos/database";
import type {
  CorporateAllocation,
  CorporateAllocationBasis,
  CorporateAllocationMethod,
  CorporateAllocationResult,
  CorporateAllocationShare,
  CorporateAllocationView
} from "@hotelos/shared";
import type { UserContext } from "../../lib/demo-store.js";
import { resolveLedgerScope } from "../../lib/finance-scope.js";
import { BadRequestError } from "../../lib/http-error.js";
import { recordAuditEvent } from "../audit/audit.service.js";
import { requirePermissions } from "../auth/auth.service.js";
import { D, ZERO, money, round2, sameCents, sumDec, type Dec } from "./money.js";
import { isHotelCentre, prismaFinancialStatementsSource, toWorkCentre, type FinancialStatementsSource } from "./source.js";

export const CORPORATE_ALLOCATION_METHODS: readonly CorporateAllocationMethod[] = ["none", "revenue", "rooms_available", "headcount", "manual"];

export const ALLOCATION_LABEL = "Reparto corporativo (informativo · no contabilizado)" as const;

export const ALLOCATION_BASIS: CorporateAllocationBasis = "usali_corporate_gop";
export const ALLOCATION_BASIS_LABEL = "Coste operativo de los centros corporativos (−GOP USALI: gastos por encima del GOP menos ingresos operativos; sin partidas financieras, amortizaciones, alquileres, seguros ni impuestos)";

/** The cost-positive base from the USALI GOP of the corporate centres: −GOP (a positive GOP is a negative «cost» → nothing to allocate). */
export function corporateCostFromGop(gop: Dec): Dec {
  return gop.negated();
}

/**
 * Spanish warning when the corporate statement has P&L accounts with movements
 * and no USALI mapping: they are outside the base (neither USALI nor the PyG
 * por centro allocates them) until the mapping is completed.
 */
export function corporateBaseWarnings(corporate: { unassigned: { accounts: ReadonlyArray<{ code: string }> } } | null | undefined): string[] {
  const codes = corporate?.unassigned.accounts.map((a) => a.code) ?? [];
  if (codes.length === 0) return [];
  return [`${codes.length} cuenta(s) de los centros corporativos sin mapeo USALI (${codes.slice(0, 5).join(", ")}${codes.length > 5 ? "…" : ""}) quedan fuera de la base del reparto: completa el mapeo en Estados contables › USALI.`];
}

export const ALLOCATION_METHOD_LABELS_ES: Record<CorporateAllocationMethod, string> = {
  none: "Sin reparto",
  revenue: "Ingresos operativos",
  rooms_available: "Habitaciones disponibles",
  headcount: "Plantilla",
  manual: "Porcentajes manuales"
};

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function isMethod(value: unknown): value is CorporateAllocationMethod {
  return typeof value === "string" && (CORPORATE_ALLOCATION_METHODS as readonly string[]).includes(value);
}

/** Stored JSON → contract. Anything malformed reads as `none` (a read never throws; the PUT validates). */
export function parseCorporateAllocation(json: unknown): CorporateAllocation {
  if (!json || typeof json !== "object" || Array.isArray(json)) return { method: "none" };
  const raw = (json as { corporateAllocation?: unknown }).corporateAllocation;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { method: "none" };
  const method = (raw as { method?: unknown }).method;
  if (!isMethod(method)) return { method: "none" };
  if (method !== "manual") return { method };
  const weights = (raw as { weights?: unknown }).weights;
  if (!Array.isArray(weights)) return { method: "none" };
  const parsed = weights
    .filter((w): w is { propertyId: string; weight: number } => Boolean(w) && typeof w === "object" && typeof (w as { propertyId?: unknown }).propertyId === "string" && typeof (w as { weight?: unknown }).weight === "number" && Number.isFinite((w as { weight: number }).weight))
    .map((w) => ({ propertyId: w.propertyId, weight: w.weight }));
  return parsed.length > 0 ? { method: "manual", weights: parsed } : { method: "none" };
}

export type AllocationWeight = { propertyId: string; weight: Dec };

/**
 * Split `total` (cost-positive) over the weights. Shares are rounded to the
 * cent and add up to `total` exactly: the rounding remainder goes to the
 * largest weight (first on ties). Empty or all-zero weights → no shares.
 */
export function allocateAmount(total: Dec, weights: readonly AllocationWeight[]): CorporateAllocationShare[] {
  const positive = weights.filter((w) => w.weight.greaterThan(0));
  const sumWeights = sumDec(positive.map((w) => w.weight));
  if (positive.length === 0 || sumWeights.isZero()) return [];
  const shares = positive.map((w) => {
    const ratio = w.weight.div(sumWeights);
    return { propertyId: w.propertyId, basis: w.weight, ratio, amount: round2(total.times(ratio)) };
  });
  const remainder = total.minus(sumDec(shares.map((s) => s.amount)));
  if (!remainder.isZero()) {
    const largest = shares.reduce((best, current) => (current.basis.greaterThan(best.basis) ? current : best), shares[0]!);
    largest.amount = largest.amount.plus(remainder);
  }
  return shares.map((s) => ({ propertyId: s.propertyId, basis: money(s.basis), share: s.ratio.toDecimalPlaces(4).toFixed(4), amount: money(s.amount) }));
}

/** Facts the automatic keys read (one value per hotel; missing = 0). */
export type AllocationFacts = {
  revenue: ReadonlyMap<string, Dec>;
  roomsAvailable: ReadonlyMap<string, number>;
  headcount: ReadonlyMap<string, number>;
};

/** Pure: the weights of a key over the hotels, plus the Spanish warnings. */
export function weightsFor(method: CorporateAllocationMethod, hotelIds: readonly string[], facts: AllocationFacts, manual?: CorporateAllocation["weights"]): { weights: AllocationWeight[]; warnings: string[] } {
  const warnings: string[] = [];
  switch (method) {
    case "none":
      return { weights: [], warnings };
    case "revenue":
      return { weights: hotelIds.map((id) => ({ propertyId: id, weight: nonNegative(facts.revenue.get(id) ?? ZERO) })), warnings };
    case "rooms_available":
      return { weights: hotelIds.map((id) => ({ propertyId: id, weight: D(facts.roomsAvailable.get(id) ?? 0) })), warnings };
    case "headcount": {
      if (facts.headcount.size === 0) warnings.push("Clave «plantilla»: sin nóminas por centro en el periodo, no se reparte.");
      return { weights: hotelIds.map((id) => ({ propertyId: id, weight: D(facts.headcount.get(id) ?? 0) })), warnings };
    }
    case "manual": {
      const stored = manual ?? [];
      const unknown = stored.filter((w) => !hotelIds.includes(w.propertyId));
      if (unknown.length > 0) warnings.push(`Clave manual: ${unknown.length} peso(s) de centros que no son hoteles de la sociedad se ignoran.`);
      const known = stored.filter((w) => hotelIds.includes(w.propertyId));
      if (known.length === 0) warnings.push("Clave manual sin pesos válidos: no se reparte (configura los porcentajes en Estructura societaria › Reparto).");
      return { weights: known.map((w) => ({ propertyId: w.propertyId, weight: D(w.weight) })), warnings };
    }
  }
}

/** Revenue below zero (a period of rectificativas) weighs 0: never a negative share. */
function nonNegative(value: Dec): Dec {
  return value.lessThan(0) ? ZERO : value;
}

export type CorporateAllocationInput = {
  method: CorporateAllocationMethod;
  /** Cost-positive amount to split: −GOP (USALI) of the corporate centres, the same in every statement (`corporateCostFromGop`). */
  corporateCost: Dec;
  hotelIds: readonly string[];
  facts: AllocationFacts;
  manualWeights?: CorporateAllocation["weights"];
};

/**
 * Pure: the whole informative allocation block of a statement. A negative
 * corporate cost (the corporate centres have an operating profit) is never
 * split — a «cost» below zero would land in the hotels as income — so the
 * block reports it and stays `applied: false`.
 */
export function computeCorporateAllocation(input: CorporateAllocationInput): CorporateAllocationResult {
  const base = { method: input.method, corporateCost: money(input.corporateCost), label: ALLOCATION_LABEL, basis: ALLOCATION_BASIS, basisLabel: ALLOCATION_BASIS_LABEL, posted: false as const };
  if (input.method === "none") return { ...base, allocated: "0.00", shares: [], applied: false, warnings: [] };
  if (input.corporateCost.lessThan(0)) {
    return {
      ...base,
      allocated: "0.00",
      shares: [],
      applied: false,
      warnings: [`Los centros corporativos tienen resultado operativo positivo en el periodo (GOP ${money(input.corporateCost.negated())}): no hay coste que repartir.`]
    };
  }
  const { weights, warnings } = weightsFor(input.method, input.hotelIds, input.facts, input.manualWeights);
  const shares = allocateAmount(input.corporateCost, weights);
  if (shares.length === 0) {
    warnings.push(`Clave «${ALLOCATION_METHOD_LABELS_ES[input.method]}» sin base en el periodo (todos los pesos son 0): no se reparte.`);
    return { ...base, allocated: "0.00", shares: [], applied: false, warnings };
  }
  if (input.corporateCost.isZero()) warnings.push("Los centros corporativos no tienen coste neto en el periodo: el reparto es 0,00 en todos los hoteles.");
  const allocated = sumDec(shares.map((s) => D(s.amount)));
  if (!sameCents(allocated, input.corporateCost)) warnings.push(`El reparto (${money(allocated)}) no suma el coste corporativo (${money(input.corporateCost)}).`);
  return { ...base, allocated: money(allocated), shares, applied: true, warnings };
}

// ---------------------------------------------------------------------------
// Stored key (AccountingSetting.configurationJson.corporateAllocation)
// ---------------------------------------------------------------------------

/** The stored key of the organisation (= sociedad in this tanda); `none` when nothing is stored. */
export async function getCorporateAllocation(organizationId: string, source: FinancialStatementsSource = prismaFinancialStatementsSource): Promise<{ allocation: CorporateAllocation; persisted: boolean }> {
  const configuration = await source.accountingConfiguration(organizationId);
  const allocation = parseCorporateAllocation(configuration);
  const persisted = Boolean(configuration && typeof configuration === "object" && (configuration as { corporateAllocation?: unknown }).corporateAllocation);
  return { allocation, persisted };
}

function allocationBadRequest(code: string, message: string, extra: Record<string, unknown> = {}): BadRequestError {
  const error = new BadRequestError(message);
  error.details = { code, ...extra };
  return error;
}

/** GET /accounting/allocation. */
export async function getCorporateAllocationView(input: { context: UserContext; source?: FinancialStatementsSource }): Promise<CorporateAllocationView> {
  requirePermissions(input.context, ["accounting.read"]);
  const source = input.source ?? prismaFinancialStatementsSource;
  const scope = await resolveLedgerScope(input.context);
  const [properties, stored] = await Promise.all([source.properties(scope.organizationId), getCorporateAllocation(scope.organizationId, source)]);
  return {
    organizationId: scope.organizationId,
    legalEntityId: scope.legalEntityId,
    method: stored.allocation.method,
    weights: stored.allocation.method === "manual" ? (stored.allocation.weights ?? []) : [],
    hotels: properties.filter(isHotelCentre).map(toWorkCentre),
    corporateCentres: properties.filter((p) => !isHotelCentre(p)).map(toWorkCentre),
    persisted: stored.persisted
  };
}

/**
 * PUT /accounting/allocation. `manual` weights must name hotels of the sociedad
 * (no duplicates, every weight > 0) and add up to 100 (±0,005); the other
 * methods accept no weights. Writes ONLY configurationJson.corporateAllocation
 * of the organisation-level AccountingSetting (the rest of the JSON is kept).
 */
export async function putCorporateAllocation(input: { context: UserContext; body: { method: CorporateAllocationMethod; weights?: Array<{ propertyId: string; weight: number }> }; correlationId: string; source?: FinancialStatementsSource }): Promise<CorporateAllocationView> {
  requirePermissions(input.context, ["accounting.configure"]);
  const source = input.source ?? prismaFinancialStatementsSource;
  const scope = await resolveLedgerScope(input.context);
  const organizationId = scope.organizationId;
  const properties = await source.properties(organizationId);
  const hotelIds = new Set(properties.filter(isHotelCentre).map((p) => p.id));
  const weights = input.body.weights ?? [];
  let allocation: CorporateAllocation;
  if (input.body.method === "manual") {
    if (weights.length === 0) throw allocationBadRequest("ALLOCATION_WEIGHTS_REQUIRED", "La clave manual necesita los porcentajes por hotel (weights).");
    const seen = new Set<string>();
    for (const weight of weights) {
      if (seen.has(weight.propertyId)) throw allocationBadRequest("ALLOCATION_DUPLICATE_PROPERTY", "Cada hotel aparece una sola vez en los porcentajes.", { propertyId: weight.propertyId });
      seen.add(weight.propertyId);
      if (!properties.some((p) => p.id === weight.propertyId)) throw allocationBadRequest("ALLOCATION_UNKNOWN_PROPERTY", "Uno de los centros de los porcentajes no pertenece a la sociedad.", { propertyId: weight.propertyId });
      if (!hotelIds.has(weight.propertyId)) throw allocationBadRequest("ALLOCATION_TARGET_NOT_HOTEL", "El reparto se hace sobre los hoteles: la oficina central y los centros no alojativos son el origen del coste, no un destino.", { propertyId: weight.propertyId });
      if (!(weight.weight > 0)) throw allocationBadRequest("ALLOCATION_WEIGHT_INVALID", "Cada porcentaje debe ser mayor que 0.", { propertyId: weight.propertyId });
    }
    const total = sumDec(weights.map((w) => D(w.weight)));
    if (!sameCents(total, D(100))) throw allocationBadRequest("ALLOCATION_WEIGHTS_SUM", `Los porcentajes deben sumar 100 (suman ${money(total)}).`, { total: money(total) });
    allocation = { method: "manual", weights: weights.map((w) => ({ propertyId: w.propertyId, weight: w.weight })) };
  } else {
    if (weights.length > 0) throw allocationBadRequest("ALLOCATION_WEIGHTS_NOT_ALLOWED", `La clave «${ALLOCATION_METHOD_LABELS_ES[input.body.method]}» no admite porcentajes manuales.`);
    allocation = { method: input.body.method };
  }
  const before = await getCorporateAllocation(organizationId, source);
  await prisma.$transaction(async (tx) => {
    const setting = await tx.accountingSetting.findFirst({ where: { organizationId, propertyId: null }, orderBy: { updatedAt: "asc" }, select: { id: true, configurationJson: true } });
    const current = setting?.configurationJson && typeof setting.configurationJson === "object" && !Array.isArray(setting.configurationJson) ? (setting.configurationJson as Record<string, unknown>) : {};
    const configurationJson = { ...current, corporateAllocation: allocation };
    if (setting) await tx.accountingSetting.update({ where: { id: setting.id }, data: { configurationJson } });
    else await tx.accountingSetting.create({ data: { organizationId, propertyId: null, configurationJson } });
  });
  recordAuditEvent({
    organizationId,
    propertyId: input.context.propertyId,
    actorUserId: input.context.userId,
    actorType: "user",
    action: "CORPORATE_ALLOCATION_UPDATED",
    entityType: "accounting_setting",
    entityId: organizationId,
    beforeJson: before.allocation,
    afterJson: allocation,
    correlationId: input.correlationId
  });
  return getCorporateAllocationView({ context: input.context, source });
}
