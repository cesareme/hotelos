// RBAC por departamento (Tanda 8a · L1) · umbrales T1-T4 y tramo máximo por
// plantilla (design §4.7, decisión D2).
//
// Los importes son PARÁMETROS por organización (role_thresholds): filas sin rol
// ni nivel = límites de la organización por acción y tramo (T1..T4 en
// max_amount; porcentajes de descuento y banda de tarifa en max_pct; segunda
// aprobación de facturas de proveedor > secondApprovalAmount en ABOVE_T4). Sin
// filas, DEFAULT_THRESHOLDS del contrato compartido. El tramo que un usuario
// puede aprobar sale de la PLANTILLA de sus asignaciones (TEMPLATE_MAX_TIER;
// rol personalizado → LEVEL_MAX_TIER de Role.level o T1), nunca de sus claves,
// RECORTADO por los límites por rol / nivel de role_thresholds (`roleLimits`
// de PUT /rbac/thresholds: decisión D3 «subdirección = manager con umbrales
// T2» y §4.7 «parametrizables … por rol»; corrector 8a · FSOD-04): para la
// acción del kind, la fila (roleId | level, action) fija el tramo máximo y,
// si lleva maxAmount, el importe máximo que ese rol aprueba
// (`approvalCapOfScope`). Plataforma y break glass no tienen tope (el servicio
// de aprobaciones lo audita cuando lo usa). El llamante nunca modifica los
// umbrales de un rol o nivel que tenga asignado (409 RBAC_SELF_ASSIGNMENT).

import {
  DEFAULT_THRESHOLDS,
  LEVEL_MAX_TIER,
  ROLE_LEVELS,
  ROLE_TEMPLATE_LEVEL,
  TEMPLATE_MAX_TIER,
  THRESHOLD_ACTIONS,
  THRESHOLD_TIER_RANK,
  THRESHOLD_TIERS,
  thresholdTierForAmount,
  type RoleLevel,
  type RoleThresholdDto,
  type ThresholdAction,
  type ThresholdTier
} from "@hotelos/shared";
import type { UserContext } from "../../lib/demo-store.js";
import { BadRequestError, ConflictError } from "../../lib/http-error.js";
import { assignmentsFor, bumpRbacVersion, type UserScope } from "../../lib/rbac-scope.js";
import { requirePermissions } from "../auth/auth.service.js";
import { assertNotBreakGlass, defaultRbacDeps, isBreakGlassContext, scopeOfContext, type RbacDeps } from "./assignments.service.js";

export type ThresholdLimits = { T1: number; T2: number; T3: number; T4: number };

export type OrganizationThresholds = {
  organizationId: string;
  currency: string;
  /** Organisation-wide limits (the `refund` action rows, or the defaults). */
  limits: ThresholdLimits;
  /** Limits per action (every action falls back to `limits`). */
  perAction: Record<ThresholdAction, ThresholdLimits>;
  secondApprovalAmount: number;
  secondApprovalLevel: RoleLevel;
  rateBandPct: number;
  discountPctT1: number;
  discountPctT2: number;
  source: "defaults" | "organization";
  /** Every stored row (organisation limits + role / level overrides). */
  rows: RoleThresholdDto[];
  /** Role / level overrides (rows with roleId or level), parsed: the cap of that role or level for one action. */
  roleLimits: RoleLimit[];
};

/** One row of role_thresholds with roleId or level: the max tier (and optional max amount) of that role / level for `action`. */
export type RoleLimit = {
  roleId: string | null;
  level: RoleLevel | null;
  action: ThresholdAction;
  tier: ThresholdTier;
  maxAmount: number | null;
};

/** What a scope may approve for one action: the tier and, when a role limit says so, the amount. */
export type ApprovalCap = { maxTier: ThresholdTier; maxAmount: number | null };

const TIERS: ReadonlyArray<keyof ThresholdLimits> = ["T1", "T2", "T3", "T4"];
const REFERENCE_ACTION: ThresholdAction = "refund";

function defaultLimits(): ThresholdLimits {
  return { T1: DEFAULT_THRESHOLDS.T1, T2: DEFAULT_THRESHOLDS.T2, T3: DEFAULT_THRESHOLDS.T3, T4: DEFAULT_THRESHOLDS.T4 };
}

function decimalToNumber(value: { toString(): string } | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value.toString());
  return Number.isFinite(parsed) ? parsed : null;
}

type ThresholdRow = {
  id: string;
  organizationId: string;
  roleId: string | null;
  level: RoleLevel | null;
  action: ThresholdAction;
  tier: string;
  maxAmount: { toString(): string } | null;
  maxPct: { toString(): string } | null;
  currency: string;
  requiresSecondApproval: boolean;
};

function toDto(row: ThresholdRow): RoleThresholdDto {
  return {
    id: row.id,
    organizationId: row.organizationId,
    roleId: row.roleId,
    level: row.level,
    action: row.action,
    tier: (row.tier as ThresholdTier) ?? "T1",
    maxAmount: row.maxAmount === null ? null : row.maxAmount.toString(),
    maxPct: row.maxPct === null ? null : row.maxPct.toString(),
    currency: row.currency,
    requiresSecondApproval: row.requiresSecondApproval
  };
}

/** Thresholds of an organisation: stored rows or DEFAULT_THRESHOLDS. */
export async function getThresholds(organizationId: string, deps: RbacDeps = defaultRbacDeps): Promise<OrganizationThresholds> {
  const rows = (await deps.db.roleThreshold.findMany({ where: { organizationId }, orderBy: [{ action: "asc" }, { tier: "asc" }] })) as ThresholdRow[];
  const organizationRows = rows.filter((row) => row.roleId === null && row.level === null);
  const base = defaultLimits();
  const perAction = {} as Record<ThresholdAction, ThresholdLimits>;
  for (const action of THRESHOLD_ACTIONS) perAction[action] = { ...base };
  let currency: string = DEFAULT_THRESHOLDS.currency;
  let secondApprovalAmount: number = DEFAULT_THRESHOLDS.secondApprovalAmount;
  let rateBandPct: number = DEFAULT_THRESHOLDS.rateBandPct;
  let discountPctT1: number = DEFAULT_THRESHOLDS.discountPctT1;
  let discountPctT2: number = DEFAULT_THRESHOLDS.discountPctT2;
  for (const row of organizationRows) {
    currency = row.currency || currency;
    const amount = decimalToNumber(row.maxAmount);
    const pct = decimalToNumber(row.maxPct);
    if ((TIERS as readonly string[]).includes(row.tier) && amount !== null) perAction[row.action][row.tier as keyof ThresholdLimits] = amount;
    if (row.action === DEFAULT_THRESHOLDS.secondApprovalAction && row.tier === "ABOVE_T4" && amount !== null) secondApprovalAmount = amount;
    if (row.action === "discount" && row.tier === "T1" && pct !== null) discountPctT1 = pct;
    if (row.action === "discount" && row.tier === "T2" && pct !== null) discountPctT2 = pct;
    if (row.action === "rate_change" && row.tier === "T1" && pct !== null) rateBandPct = pct;
  }
  return {
    organizationId,
    currency,
    limits: { ...perAction[REFERENCE_ACTION] },
    perAction,
    secondApprovalAmount,
    secondApprovalLevel: DEFAULT_THRESHOLDS.secondApprovalLevel,
    rateBandPct,
    discountPctT1,
    discountPctT2,
    source: organizationRows.length > 0 ? "organization" : "defaults",
    rows: rows.map(toDto),
    roleLimits: rows
      .filter((row) => (row.roleId !== null || row.level !== null) && (THRESHOLD_TIERS as readonly string[]).includes(row.tier))
      .map((row) => ({ roleId: row.roleId, level: row.level, action: row.action, tier: row.tier as ThresholdTier, maxAmount: decimalToNumber(row.maxAmount) }))
  };
}

/** Tier of an amount under the organisation's limits (per action when given). */
export function tierFor(amount: number, thresholds: Pick<OrganizationThresholds, "limits" | "perAction">, action?: ThresholdAction): ThresholdTier {
  return thresholdTierForAmount(amount, action ? thresholds.perAction[action] : thresholds.limits);
}

export function tierRank(tier: ThresholdTier): number {
  return THRESHOLD_TIER_RANK[tier];
}

/** True when `tier` is within `max` (T1 ≤ T2 ≤ T3 ≤ T4 ≤ ABOVE_T4). */
export function tierWithin(tier: ThresholdTier, max: ThresholdTier): boolean {
  return THRESHOLD_TIER_RANK[tier] <= THRESHOLD_TIER_RANK[max];
}

function tierOfAssignment(assignment: { templateKey: string | null; level: RoleLevel | null }): ThresholdTier {
  if (assignment.templateKey && assignment.templateKey in TEMPLATE_MAX_TIER) return TEMPLATE_MAX_TIER[assignment.templateKey as keyof typeof TEMPLATE_MAX_TIER];
  if (assignment.level) return LEVEL_MAX_TIER[assignment.level];
  return "T1";
}

function maxTier(tiers: readonly ThresholdTier[]): ThresholdTier {
  return tiers.reduce<ThresholdTier>((best, tier) => (THRESHOLD_TIER_RANK[tier] > THRESHOLD_TIER_RANK[best] ? tier : best), "T1");
}

function minTier(tiers: readonly ThresholdTier[]): ThresholdTier {
  if (tiers.length === 0) return "T1";
  return tiers.reduce<ThresholdTier>((best, tier) => (THRESHOLD_TIER_RANK[tier] < THRESHOLD_TIER_RANK[best] ? tier : best), tiers[0]);
}

/** Level of an assignment: the template's level, else the custom role's level. */
function levelOfAssignment(assignment: { templateKey: string | null; level: RoleLevel | null }): RoleLevel | null {
  if (assignment.templateKey && assignment.templateKey in ROLE_TEMPLATE_LEVEL) return ROLE_TEMPLATE_LEVEL[assignment.templateKey as keyof typeof ROLE_TEMPLATE_LEVEL];
  return assignment.level;
}

/** The role limit that caps `assignment` for `action`: by roleId first, then by level (the narrowest tier wins when both exist). */
function roleLimitOf(assignment: { roleId: string; templateKey: string | null; level: RoleLevel | null }, limits: readonly RoleLimit[], action: ThresholdAction): RoleLimit | null {
  const level = levelOfAssignment(assignment);
  const candidates = limits.filter((limit) => limit.action === action && ((limit.roleId !== null && limit.roleId === assignment.roleId) || (limit.roleId === null && limit.level !== null && limit.level === level)));
  if (candidates.length === 0) return null;
  return candidates.reduce((best, limit) => (THRESHOLD_TIER_RANK[limit.tier] < THRESHOLD_TIER_RANK[best.tier] ? limit : best));
}

/** Cap of ONE assignment for an action: the template / level tier, cut by its role limit (tier and amount). */
function capOfAssignment(assignment: { roleId: string; templateKey: string | null; level: RoleLevel | null }, thresholds: Pick<OrganizationThresholds, "roleLimits"> | undefined, action: ThresholdAction | undefined): ApprovalCap {
  const base = tierOfAssignment(assignment);
  if (!thresholds || !action) return { maxTier: base, maxAmount: null };
  const limit = roleLimitOf(assignment, thresholds.roleLimits, action);
  if (!limit) return { maxTier: base, maxAmount: null };
  return { maxTier: THRESHOLD_TIER_RANK[limit.tier] < THRESHOLD_TIER_RANK[base] ? limit.tier : base, maxAmount: limit.maxAmount };
}

/**
 * Cap of a loaded scope for an action (pure): union over the assignments
 * covering the property (the best one decides; its amount cap applies only if
 * every assignment reaching that tier is capped), the minimum over the narrow
 * ones for the organisation routes. Without `thresholds` / `action` it is the
 * template tier alone (the legacy `maxTierOfScope`).
 */
export function approvalCapOfScope(scope: Pick<UserScope, "assignments">, propertyId: string | null, thresholds?: Pick<OrganizationThresholds, "roleLimits">, action?: ThresholdAction): ApprovalCap {
  const selected = assignmentsFor(scope, propertyId);
  const caps = selected.assignments.map((assignment) => capOfAssignment(assignment, thresholds, action));
  if (caps.length === 0) return { maxTier: "T1", maxAmount: null };
  if (selected.mode === "union") {
    const best = maxTier(caps.map((cap) => cap.maxTier));
    const winners = caps.filter((cap) => cap.maxTier === best);
    const uncapped = winners.some((cap) => cap.maxAmount === null);
    return { maxTier: best, maxAmount: uncapped ? null : Math.max(...winners.map((cap) => cap.maxAmount as number)) };
  }
  const lowest = minTier(caps.map((cap) => cap.maxTier));
  const capped = caps.map((cap) => cap.maxAmount).filter((amount): amount is number => amount !== null);
  return { maxTier: lowest, maxAmount: capped.length === 0 ? null : Math.min(...capped) };
}

/** Max tier from a loaded scope (pure); with `thresholds` + `action` the role limits cut it. */
export function maxTierOfScope(scope: Pick<UserScope, "assignments">, propertyId: string | null, thresholds?: Pick<OrganizationThresholds, "roleLimits">, action?: ThresholdAction): ThresholdTier {
  return approvalCapOfScope(scope, propertyId, thresholds, action).maxTier;
}

/** True when `amount` (null = no amount) stays within the amount cap (null = no cap). */
export function amountWithin(amount: number | null, maxAmount: number | null): boolean {
  if (maxAmount === null || amount === null) return true;
  return amount <= maxAmount;
}

/**
 * Highest tier the context may approve in the scope: TEMPLATE_MAX_TIER of the
 * templates of the assignments covering the property (wide ones for null;
 * the minimum over the narrow ones otherwise, like the permission
 * intersection); custom roles → LEVEL_MAX_TIER of Role.level or T1; platform
 * admins and break-glass sessions → ABOVE_T4 (unlimited — the caller audits).
 */
export async function maxTierFor(context: UserContext, propertyId: string | null, deps: RbacDeps = defaultRbacDeps): Promise<ThresholdTier> {
  return (await approvalCapFor(context, propertyId, deps)).maxTier;
}

/**
 * Cap of the context for an action: `maxTierFor` cut by the role / level
 * limits of `thresholds` (loaded when not given) — tier AND amount. Platform
 * admins and break-glass sessions have no cap.
 */
export async function approvalCapFor(context: UserContext, propertyId: string | null, deps: RbacDeps = defaultRbacDeps, options: { action?: ThresholdAction; thresholds?: OrganizationThresholds } = {}): Promise<ApprovalCap> {
  if (context.isPlatformAdmin === true || isBreakGlassContext(context)) return { maxTier: "ABOVE_T4", maxAmount: null };
  const scope = context.assignments ? { assignments: context.assignments.map((assignment) => ({ ...assignment, propertyIds: assignment.propertyIds })) } : await scopeOfContext(context, deps);
  const thresholds = options.action ? (options.thresholds ?? (await getThresholds(context.organizationId, deps))) : undefined;
  return approvalCapOfScope(scope as Pick<UserScope, "assignments">, propertyId, thresholds, options.action);
}

// ---------------------------------------------------------------------------
// PUT /rbac/thresholds
// ---------------------------------------------------------------------------

export type ThresholdsPutBody = {
  currency?: string;
  T1: string;
  T2: string;
  T3: string;
  T4: string;
  secondApprovalAmount?: string;
  rateBandPct?: string;
  discountPctT1?: string;
  discountPctT2?: string;
  roleLimits?: Array<{ roleId?: string; level?: RoleLevel; action: ThresholdAction; tier: ThresholdTier; maxAmount?: string; maxPct?: string; requiresSecondApproval?: boolean }>;
  confirmHighRisk: true;
};

function money(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new BadRequestError(`${label} debe ser un importe ≥ 0.`);
  return Math.round(parsed * 100) / 100;
}

export async function putThresholds(input: { context: UserContext; body: ThresholdsPutBody }, deps: RbacDeps = defaultRbacDeps): Promise<OrganizationThresholds> {
  const { context, body } = input;
  assertNotBreakGlass(context);
  requirePermissions(context, ["accounting.configure", "ai.high_risk.confirm"]);
  if (body.confirmHighRisk !== true) throw new BadRequestError("Cambiar los umbrales exige confirmHighRisk: true.");
  const limits: ThresholdLimits = { T1: money(body.T1, "T1"), T2: money(body.T2, "T2"), T3: money(body.T3, "T3"), T4: money(body.T4, "T4") };
  if (!(limits.T1 < limits.T2 && limits.T2 < limits.T3 && limits.T3 < limits.T4)) {
    throw new BadRequestError("Los umbrales deben cumplir T1 < T2 < T3 < T4.");
  }
  const secondApprovalAmount = body.secondApprovalAmount !== undefined ? money(body.secondApprovalAmount, "secondApprovalAmount") : DEFAULT_THRESHOLDS.secondApprovalAmount;
  if (secondApprovalAmount < limits.T4) throw new BadRequestError("secondApprovalAmount debe ser ≥ T4 (la doble aprobación solo aplica por encima de T4).");
  const pct = (value: string | undefined, fallback: number, label: string): number => {
    if (value === undefined) return fallback;
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) throw new BadRequestError(`${label} debe ser un porcentaje entre 0 y 100.`);
    return parsed;
  };
  const rateBandPct = pct(body.rateBandPct, DEFAULT_THRESHOLDS.rateBandPct, "rateBandPct");
  const discountPctT1 = pct(body.discountPctT1, DEFAULT_THRESHOLDS.discountPctT1, "discountPctT1");
  const discountPctT2 = pct(body.discountPctT2, DEFAULT_THRESHOLDS.discountPctT2, "discountPctT2");
  if (discountPctT1 > discountPctT2) throw new BadRequestError("discountPctT1 debe ser ≤ discountPctT2.");
  const currency = body.currency ?? DEFAULT_THRESHOLDS.currency;

  // Role / level overrides: never for a role or level the caller holds (self-service escalation).
  const roleLimits = body.roleLimits ?? [];
  const scope = await scopeOfContext(context, deps);
  const ownRoleIds = new Set(scope.assignments.map((assignment) => assignment.roleId));
  const ownLevels = new Set<RoleLevel>();
  for (const assignment of scope.assignments) {
    if (assignment.level) ownLevels.add(assignment.level);
    if (assignment.templateKey) ownLevels.add(ROLE_TEMPLATE_LEVEL[assignment.templateKey]);
  }
  for (const limit of roleLimits) {
    if ((limit.roleId && ownRoleIds.has(limit.roleId)) || (limit.level && ownLevels.has(limit.level))) {
      throw new ConflictError("No puedes modificar los umbrales de un rol o nivel que tienes asignado.", { code: "RBAC_SELF_ASSIGNMENT", roleId: limit.roleId ?? null, level: limit.level ?? null });
    }
    if (limit.requiresSecondApproval && limit.tier !== "ABOVE_T4") throw new BadRequestError("La doble aprobación solo se configura por encima de T4 (tier ABOVE_T4).");
    if (limit.level && !(ROLE_LEVELS as readonly string[]).includes(limit.level)) throw new BadRequestError("Nivel desconocido.");
    if (limit.roleId) {
      const role = await deps.db.role.findFirst({ where: { id: limit.roleId, organizationId: context.organizationId }, select: { id: true } });
      if (!role) throw new BadRequestError("roleId desconocido en la organización.");
    }
  }

  const before = await getThresholds(context.organizationId, deps);
  const rowsToWrite: Array<{ organizationId: string; roleId: string | null; level: RoleLevel | null; action: ThresholdAction; tier: string; maxAmount: string | null; maxPct: string | null; currency: string; requiresSecondApproval: boolean }> = [];
  for (const action of THRESHOLD_ACTIONS) {
    for (const tier of TIERS) rowsToWrite.push({ organizationId: context.organizationId, roleId: null, level: null, action, tier, maxAmount: limits[tier].toFixed(2), maxPct: null, currency, requiresSecondApproval: false });
  }
  rowsToWrite.push({ organizationId: context.organizationId, roleId: null, level: null, action: DEFAULT_THRESHOLDS.secondApprovalAction, tier: "ABOVE_T4", maxAmount: secondApprovalAmount.toFixed(2), maxPct: null, currency, requiresSecondApproval: true });
  const pctRow = (action: ThresholdAction, tier: string, value: number) => ({ organizationId: context.organizationId, roleId: null, level: null, action, tier, maxAmount: null, maxPct: value.toFixed(2), currency, requiresSecondApproval: false });
  // Percentage rows share the (action, tier) of the amount rows: keep the amount and add the pct on the same row.
  for (const [action, tier, value] of [["discount", "T1", discountPctT1], ["discount", "T2", discountPctT2], ["rate_change", "T1", rateBandPct]] as const) {
    const row = rowsToWrite.find((candidate) => candidate.roleId === null && candidate.level === null && candidate.action === action && candidate.tier === tier);
    if (row) row.maxPct = value.toFixed(2);
    else rowsToWrite.push(pctRow(action, tier, value));
  }
  for (const limit of roleLimits) {
    rowsToWrite.push({
      organizationId: context.organizationId,
      roleId: limit.roleId ?? null,
      level: limit.level ?? null,
      action: limit.action,
      tier: limit.tier,
      maxAmount: limit.maxAmount !== undefined ? money(limit.maxAmount, "maxAmount").toFixed(2) : null,
      maxPct: limit.maxPct !== undefined ? pct(limit.maxPct, 0, "maxPct").toFixed(2) : null,
      currency,
      requiresSecondApproval: limit.requiresSecondApproval === true
    });
  }
  await deps.db.roleThreshold.deleteMany({ where: { organizationId: context.organizationId } });
  await deps.db.roleThreshold.createMany({ data: rowsToWrite });
  const after = await getThresholds(context.organizationId, deps);
  deps.audit({
    organizationId: context.organizationId,
    actorUserId: context.userId,
    actorType: "user",
    action: "THRESHOLDS_UPDATED",
    entityType: "role_thresholds",
    entityId: context.organizationId,
    beforeJson: { limits: before.limits, secondApprovalAmount: before.secondApprovalAmount, rateBandPct: before.rateBandPct, discountPctT1: before.discountPctT1, discountPctT2: before.discountPctT2, source: before.source, rows: before.rows.length },
    afterJson: { limits: after.limits, secondApprovalAmount: after.secondApprovalAmount, rateBandPct: after.rateBandPct, discountPctT1: after.discountPctT1, discountPctT2: after.discountPctT2, roleLimits: roleLimits.length, rows: after.rows.length },
    deviceId: context.deviceId
  });
  await bumpRbacVersion(context.organizationId, deps.db);
  return after;
}
