// Plantilla máxima aprobada (StaffingPlan / StaffingPlanLine) · Tanda RRHH · RRHH-3 (diseño §4, §6.3, §9 :289).
//
//   listStaffingPlans({ context, propertyId, year? })                  workforce.read | hr.standards.manage | hr.staffing.approve | payroll.read
//   upsertStaffingPlan({ context, propertyId, body, correlationId })   hr.standards.manage
//     un plan por (centro, año, temporada); mientras está `draft` se puede reescribir (líneas
//     sustituidas; `createdBy` = quien preparó la versión vigente, base de la SoD); aprobado → 409
//     HR_STAFFING_PLAN_ALREADY_APPROVED. Validación pura `normaliseStaffingPlanInput`.
//   approveStaffingPlan({ context, propertyId, planId, correlationId })   hr.staffing.approve
//     SoD dinámica: quien preparó el plan no lo aprueba → 409 APPROVAL_SELF_DECISION (sin excepción de
//     plataforma: misma regla que el CHECK de ausencias); ya aprobado → 409; auditoría HR_STAFFING_PLAN_APPROVED.
//   checkStaffingHeadroom({ propertyId, usaliDepartment, date?, extraFte? })
//     position control (D §6.3): contratos activos ponderados por partTimePct (+ el alta prevista) frente a
//     maxFte del plan aprobado de la temporada → `exceeded` y aviso HR_STAFFING_EXCEEDED en `warnings`;
//     NUNCA bloquea (hr.staffing.enforce queda fuera de la tanda). Sin plan aprobado → sin aviso.
// Centro inexistente / ajeno / fuera de ámbito → 404 opaco PROPERTY_NOT_FOUND; plan ajeno → 404 HR_STAFFING_PLAN_NOT_FOUND.

import { prisma } from "@hotelos/database";
import {
  HR_ERROR_MESSAGES_ES,
  HR_USALI_DEPARTMENTS,
  STAFFING_SEASONS,
  type HrAuditAction,
  type HrUsaliDepartment,
  type StaffingPlanDto,
  type StaffingPlanLineDto,
  type StaffingPlanStatus,
  type StaffingSeason
} from "@hotelos/shared";
import type { UserContext } from "../../lib/demo-store.js";
import { recordAuditEvent } from "../audit/audit.service.js";
import { requirePermissions } from "../auth/auth.service.js";
import { dayUtc, isoDate } from "../revenue/actuals.js";
import { requireAnyPermission } from "../treasury/permissions.js";
import { hrForecastBadRequest, hrForecastConflict, hrForecastNotFound, requireHrProperty } from "./standards.service.js";

export const STAFFING_READ_KEYS = ["workforce.read", "hr.standards.manage", "hr.staffing.approve", "payroll.read"] as const;
export const STAFFING_MAX_FTE = 9999.99;

// ---------------------------------------------------------------------------
// Validación pura
// ---------------------------------------------------------------------------

export type StaffingPlanLineInput = { usaliDepartment: string; maxFte: number | string; maxHeadcount?: number | string | null; budgetMonthlyCost?: number | string | null };
export type StaffingPlanInput = { year: number | string; season: string; fromMonth: number | string; toMonth: number | string; lines: readonly StaffingPlanLineInput[] };

export type NormalisedStaffingPlan = {
  year: number;
  season: StaffingSeason;
  fromMonth: number;
  toMonth: number;
  lines: Array<{ usaliDepartment: HrUsaliDepartment; maxFte: string; maxHeadcount: number | null; budgetMonthlyCost: string | null }>;
};

function toNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "number" ? value : Number(String(value).trim().replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

function requireInt(value: unknown, field: string, min: number, max: number): number {
  const n = toNumber(value);
  if (n === null || !Number.isInteger(n) || n < min || n > max) throw hrForecastBadRequest("VALIDATION_ERROR", { field }, `${field} debe ser un entero entre ${min} y ${max}.`);
  return n;
}

export function normaliseStaffingPlanInput(input: StaffingPlanInput): NormalisedStaffingPlan {
  const year = requireInt(input.year, "year", 2000, 2100);
  const season = String(input.season ?? "").trim() as StaffingSeason;
  if (!STAFFING_SEASONS.includes(season)) throw hrForecastBadRequest("VALIDATION_ERROR", { field: "season" }, "season debe ser high, shoulder o low.");
  const fromMonth = requireInt(input.fromMonth, "fromMonth", 1, 12);
  const toMonth = requireInt(input.toMonth, "toMonth", 1, 12);
  if (!Array.isArray(input.lines) || input.lines.length === 0) throw hrForecastBadRequest("VALIDATION_ERROR", { field: "lines" }, "Indica al menos una línea de plantilla máxima.");
  if (input.lines.length > HR_USALI_DEPARTMENTS.length) throw hrForecastBadRequest("VALIDATION_ERROR", { field: "lines" }, "Una línea por departamento USALI como máximo.");
  const seen = new Set<string>();
  const lines = input.lines.map((line, index) => {
    const department = String(line.usaliDepartment ?? "").trim() as HrUsaliDepartment;
    if (!HR_USALI_DEPARTMENTS.includes(department)) throw hrForecastBadRequest("VALIDATION_ERROR", { field: `lines[${index}].usaliDepartment` }, "Departamento USALI no válido.");
    if (seen.has(department)) throw hrForecastBadRequest("VALIDATION_ERROR", { field: `lines[${index}].usaliDepartment` }, `Departamento repetido: ${department}.`);
    seen.add(department);
    const maxFte = toNumber(line.maxFte);
    if (maxFte === null || maxFte < 0 || maxFte > STAFFING_MAX_FTE) throw hrForecastBadRequest("VALIDATION_ERROR", { field: `lines[${index}].maxFte` }, "maxFte debe estar entre 0 y 9999,99.");
    const maxHeadcount = line.maxHeadcount === undefined || line.maxHeadcount === null || line.maxHeadcount === "" ? null : requireInt(line.maxHeadcount, `lines[${index}].maxHeadcount`, 0, 100_000);
    const budget = line.budgetMonthlyCost === undefined || line.budgetMonthlyCost === null || line.budgetMonthlyCost === "" ? null : toNumber(line.budgetMonthlyCost);
    if (budget !== null && (budget < 0 || budget > 999_999_999_999.99)) throw hrForecastBadRequest("VALIDATION_ERROR", { field: `lines[${index}].budgetMonthlyCost` }, "budgetMonthlyCost debe ser ≥ 0.");
    if (line.budgetMonthlyCost !== undefined && line.budgetMonthlyCost !== null && line.budgetMonthlyCost !== "" && budget === null) throw hrForecastBadRequest("VALIDATION_ERROR", { field: `lines[${index}].budgetMonthlyCost` }, "budgetMonthlyCost no es un importe válido.");
    return { usaliDepartment: department, maxFte: maxFte.toFixed(2), maxHeadcount, budgetMonthlyCost: budget === null ? null : budget.toFixed(2) };
  });
  return { year, season, fromMonth, toMonth, lines };
}

/** ¿El plan (año, fromMonth..toMonth, con vuelta de año si from > to) cubre la fecha? */
export function planCoversDate(plan: { year: number; fromMonth: number; toMonth: number }, date: string): boolean {
  const d = dayUtc(date);
  const year = d.getUTCFullYear();
  const month = d.getUTCMonth() + 1;
  if (plan.fromMonth <= plan.toMonth) return year === plan.year && month >= plan.fromMonth && month <= plan.toMonth;
  // Temporada que cruza el año (p. ej. baja nov→feb): nov-dic del año del plan o ene-feb del siguiente.
  return (year === plan.year && month >= plan.fromMonth) || (year === plan.year + 1 && month <= plan.toMonth);
}

// ---------------------------------------------------------------------------
// Mapeo
// ---------------------------------------------------------------------------

type PlanRow = { id: string; propertyId: string; year: number; season: string; fromMonth: number; toMonth: number; status: string; createdBy: string | null; approvedBy: string | null; approvedAt: Date | null };
type LineRow = { planId: string; usaliDepartment: string; maxFte: unknown; maxHeadcount: number | null; budgetMonthlyCost: unknown };

function decText(value: unknown): string {
  return (toNumber(value) ?? 0).toFixed(2);
}

export function mapStaffingPlan(plan: PlanRow, lines: readonly LineRow[]): StaffingPlanDto {
  const dto: StaffingPlanLineDto[] = lines
    .filter((line) => line.planId === plan.id)
    .map((line) => ({ usaliDepartment: line.usaliDepartment as HrUsaliDepartment, maxFte: decText(line.maxFte), maxHeadcount: line.maxHeadcount, budgetMonthlyCost: line.budgetMonthlyCost === null || line.budgetMonthlyCost === undefined ? null : decText(line.budgetMonthlyCost) }))
    .sort((a, b) => a.usaliDepartment.localeCompare(b.usaliDepartment));
  const total = dto.reduce((acc, line) => acc + (toNumber(line.maxFte) ?? 0), 0);
  return {
    id: plan.id,
    propertyId: plan.propertyId,
    year: plan.year,
    season: plan.season as StaffingSeason,
    fromMonth: plan.fromMonth,
    toMonth: plan.toMonth,
    status: plan.status as StaffingPlanStatus,
    createdBy: plan.createdBy,
    approvedBy: plan.approvedBy,
    approvedAt: plan.approvedAt ? plan.approvedAt.toISOString() : null,
    lines: dto,
    totalMaxFte: total.toFixed(2)
  };
}

async function loadPlans(where: { propertyId: string; year?: number; status?: string }): Promise<StaffingPlanDto[]> {
  const plans = await prisma.staffingPlan.findMany({ where, orderBy: [{ year: "desc" }, { fromMonth: "asc" }] });
  if (plans.length === 0) return [];
  const lines = await prisma.staffingPlanLine.findMany({ where: { planId: { in: plans.map((p) => p.id) } } });
  return plans.map((plan) => mapStaffingPlan(plan, lines));
}

// ---------------------------------------------------------------------------
// Servicio
// ---------------------------------------------------------------------------

export async function listStaffingPlans(input: { context: UserContext; propertyId: string; year?: number }): Promise<{ propertyId: string; plans: StaffingPlanDto[] }> {
  requireAnyPermission(input.context, [...STAFFING_READ_KEYS]);
  const property = await requireHrProperty(input.context, input.propertyId);
  const plans = await loadPlans({ propertyId: property.id, ...(input.year !== undefined ? { year: requireInt(input.year, "year", 2000, 2100) } : {}) });
  return { propertyId: property.id, plans };
}

export async function upsertStaffingPlan(input: { context: UserContext; propertyId: string; body: StaffingPlanInput; correlationId?: string }): Promise<StaffingPlanDto> {
  requirePermissions(input.context, ["hr.standards.manage"]);
  const property = await requireHrProperty(input.context, input.propertyId);
  const plan = normaliseStaffingPlanInput(input.body);
  const existing = await prisma.staffingPlan.findUnique({ where: { propertyId_year_season: { propertyId: property.id, year: plan.year, season: plan.season } } });
  if (existing && existing.status === "approved") throw hrForecastConflict("HR_STAFFING_PLAN_ALREADY_APPROVED", { planId: existing.id, approvedBy: existing.approvedBy, approvedAt: existing.approvedAt?.toISOString() ?? null });
  const saved = await prisma.$transaction(async (tx) => {
    const row = existing
      ? await tx.staffingPlan.update({ where: { id: existing.id }, data: { fromMonth: plan.fromMonth, toMonth: plan.toMonth, createdBy: input.context.userId, status: "draft" } })
      : await tx.staffingPlan.create({ data: { propertyId: property.id, year: plan.year, season: plan.season, fromMonth: plan.fromMonth, toMonth: plan.toMonth, status: "draft", createdBy: input.context.userId } });
    await tx.staffingPlanLine.deleteMany({ where: { planId: row.id } });
    await tx.staffingPlanLine.createMany({ data: plan.lines.map((line) => ({ planId: row.id, usaliDepartment: line.usaliDepartment, maxFte: line.maxFte, maxHeadcount: line.maxHeadcount, budgetMonthlyCost: line.budgetMonthlyCost })) });
    const lines = await tx.staffingPlanLine.findMany({ where: { planId: row.id } });
    return mapStaffingPlan(row, lines);
  });
  recordAuditEvent({
    organizationId: property.organizationId,
    propertyId: property.id,
    actorUserId: input.context.userId,
    actorType: "user",
    action: (existing ? "HR_STAFFING_PLAN_UPDATED" : "HR_STAFFING_PLAN_CREATED") satisfies HrAuditAction,
    entityType: "staffing_plan",
    entityId: saved.id,
    afterJson: { year: saved.year, season: saved.season, fromMonth: saved.fromMonth, toMonth: saved.toMonth, totalMaxFte: saved.totalMaxFte, lines: saved.lines.length },
    deviceId: input.context.deviceId,
    correlationId: input.correlationId
  });
  return saved;
}

/**
 * Guarda pura de la aprobación (SoD dinámica, D §6.3 «Regla de aprobación»): ya aprobado → 409
 * HR_STAFFING_PLAN_ALREADY_APPROVED; quien preparó la versión vigente (createdBy) no la aprueba → 409
 * APPROVAL_SELF_DECISION (sin excepción para plataforma ni break-glass: misma regla que el CHECK de
 * ausencias); createdBy null (fila heredada) → pasa.
 */
export function assertStaffingPlanApprovable(plan: { id: string; status: string; createdBy: string | null; approvedBy: string | null; approvedAt: Date | null }, context: Pick<UserContext, "userId">): void {
  if (plan.status === "approved") throw hrForecastConflict("HR_STAFFING_PLAN_ALREADY_APPROVED", { planId: plan.id, approvedBy: plan.approvedBy, approvedAt: plan.approvedAt?.toISOString() ?? null });
  if (plan.createdBy !== null && plan.createdBy === context.userId) throw hrForecastConflict("APPROVAL_SELF_DECISION", { planId: plan.id, rule: "preparer_ne_approver", authorUserId: plan.createdBy });
}

export async function approveStaffingPlan(input: { context: UserContext; propertyId: string; planId: string; correlationId?: string }): Promise<StaffingPlanDto> {
  requirePermissions(input.context, ["hr.staffing.approve"]);
  const property = await requireHrProperty(input.context, input.propertyId);
  const plan = await prisma.staffingPlan.findFirst({ where: { id: input.planId, propertyId: property.id } });
  if (!plan) throw hrForecastNotFound("HR_STAFFING_PLAN_NOT_FOUND");
  assertStaffingPlanApprovable(plan, input.context);
  const approvedAt = new Date();
  const updated = await prisma.staffingPlan.update({ where: { id: plan.id }, data: { status: "approved", approvedBy: input.context.userId, approvedAt } });
  const lines = await prisma.staffingPlanLine.findMany({ where: { planId: plan.id } });
  const dto = mapStaffingPlan(updated, lines);
  recordAuditEvent({
    organizationId: property.organizationId,
    propertyId: property.id,
    actorUserId: input.context.userId,
    actorType: "user",
    action: "HR_STAFFING_PLAN_APPROVED" satisfies HrAuditAction,
    entityType: "staffing_plan",
    entityId: plan.id,
    beforeJson: { status: plan.status, createdBy: plan.createdBy },
    afterJson: { status: "approved", approvedBy: input.context.userId, approvedAt: approvedAt.toISOString(), totalMaxFte: dto.totalMaxFte, sod: { rule: "preparer_ne_approver", authorUserId: plan.createdBy, authorUnknown: plan.createdBy === null } },
    deviceId: input.context.deviceId,
    correlationId: input.correlationId
  });
  return dto;
}

// ---------------------------------------------------------------------------
// Lecturas internas (previsión, KPIs, position control)
// ---------------------------------------------------------------------------

/** Plan aprobado que cubre la fecha (temporadas con vuelta de año incluidas) o null. */
export async function findApprovedStaffingPlan(propertyId: string, date: string): Promise<StaffingPlanDto | null> {
  const d = dayUtc(date);
  const years = [d.getUTCFullYear(), d.getUTCFullYear() - 1];
  const plans = await prisma.staffingPlan.findMany({ where: { propertyId, status: "approved", year: { in: years } } });
  const covering = plans.filter((plan) => planCoversDate(plan, isoDate(d)));
  if (covering.length === 0) return null;
  const chosen = covering.sort((a, b) => b.year - a.year || a.fromMonth - b.fromMonth)[0]!;
  const lines = await prisma.staffingPlanLine.findMany({ where: { planId: chosen.id } });
  return mapStaffingPlan(chosen, lines);
}

export type ActiveFteByDepartment = Map<HrUsaliDepartment, { fte: number; headcount: number; fixedDiscontinuous: number }>;

/** Contratos activos en la fecha (por ficha del centro) ponderados por partTimePct; fichas sin departamento en `unassigned`. */
export async function activeFteByDepartment(propertyId: string, date: string): Promise<{ byDepartment: ActiveFteByDepartment; unassigned: number; profiles: number }> {
  const day = dayUtc(date);
  const profiles = await prisma.staffProfile.findMany({ where: { propertyId }, select: { id: true, usaliDepartment: true } });
  const byDepartment: ActiveFteByDepartment = new Map();
  let unassigned = 0;
  if (profiles.length === 0) return { byDepartment, unassigned, profiles: 0 };
  const contracts = await prisma.employmentContract.findMany({
    where: { staffProfileId: { in: profiles.map((p) => p.id) }, active: true, startDate: { lte: day }, OR: [{ endDate: null }, { endDate: { gte: day } }] },
    select: { staffProfileId: true, partTimePct: true, fixedDiscontinuous: true }
  });
  const deptOf = new Map(profiles.map((p) => [p.id, p.usaliDepartment]));
  for (const contract of contracts) {
    const pct = toNumber(contract.partTimePct);
    const weight = pct === null ? 1 : Math.max(0, Math.min(1, pct / 100));
    const dept = deptOf.get(contract.staffProfileId) as HrUsaliDepartment | null | undefined;
    if (!dept || !HR_USALI_DEPARTMENTS.includes(dept)) {
      unassigned += weight;
      continue;
    }
    const cur = byDepartment.get(dept) ?? { fte: 0, headcount: 0, fixedDiscontinuous: 0 };
    cur.fte += weight;
    cur.headcount += 1;
    if (contract.fixedDiscontinuous) cur.fixedDiscontinuous += 1;
    byDepartment.set(dept, cur);
  }
  return { byDepartment, unassigned, profiles: profiles.length };
}

export type StaffingHeadroom = {
  propertyId: string;
  usaliDepartment: HrUsaliDepartment;
  date: string;
  planId: string | null;
  approvedMaxFte: string | null;
  activeFte: string;
  projectedFte: string;
  exceeded: boolean;
  /** Aviso HR_STAFFING_EXCEEDED (mensaje en español) cuando se supera; nunca bloquea. */
  warnings: string[];
};

/** Cálculo puro del position control: contratos activos + alta prevista frente a maxFte del plan aprobado. */
export function computeStaffingHeadroom(input: { propertyId: string; usaliDepartment: HrUsaliDepartment; date: string; activeFte: number; extraFte?: number; plan: Pick<StaffingPlanDto, "id" | "year" | "season" | "lines"> | null }): StaffingHeadroom {
  const extra = Math.max(0, input.extraFte ?? 0);
  const projected = input.activeFte + extra;
  const line = input.plan?.lines.find((l) => l.usaliDepartment === input.usaliDepartment) ?? null;
  const max = line ? toNumber(line.maxFte) : null;
  const exceeded = max !== null && projected > max + 1e-9;
  const warnings = exceeded ? [`${HR_ERROR_MESSAGES_ES.HR_STAFFING_EXCEEDED} (${input.usaliDepartment}: ${projected.toFixed(2)} FTE frente a ${max!.toFixed(2)} aprobados, plan ${input.plan!.year} ${input.plan!.season}).`] : [];
  return { propertyId: input.propertyId, usaliDepartment: input.usaliDepartment, date: input.date, planId: input.plan?.id ?? null, approvedMaxFte: max === null ? null : max.toFixed(2), activeFte: input.activeFte.toFixed(2), projectedFte: projected.toFixed(2), exceeded, warnings };
}

/** Position control: aviso (nunca bloqueo) cuando contratos activos + alta prevista superan maxFte del plan aprobado. */
export async function checkStaffingHeadroom(input: { propertyId: string; usaliDepartment: string; date?: string; extraFte?: number }): Promise<StaffingHeadroom> {
  const department = String(input.usaliDepartment ?? "").trim() as HrUsaliDepartment;
  if (!HR_USALI_DEPARTMENTS.includes(department)) throw hrForecastBadRequest("VALIDATION_ERROR", { field: "usaliDepartment" }, "Departamento USALI no válido.");
  const date = isoDate(dayUtc(input.date));
  const [plan, active] = await Promise.all([findApprovedStaffingPlan(input.propertyId, date), activeFteByDepartment(input.propertyId, date)]);
  return computeStaffingHeadroom({ propertyId: input.propertyId, usaliDepartment: department, date, activeFte: active.byDepartment.get(department)?.fte ?? 0, extraFte: input.extraFte, plan });
}

export const HR_STAFFING_EXCEEDED_CODE = "HR_STAFFING_EXCEEDED" as const;
