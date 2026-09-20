// Convenios colectivos (CollectiveAgreement) y sus reglas (AgreementRule) ·
// Tanda RRHH · RRHH-2 (docs/design/RRHH-PLANTILLA-NOMINA.md §4 «CollectiveAgreement ·
// AgreementRule», §2.3 y §6.1; recon-delta §3.3).
//
//   listAgreements / getAgreement          hr.config.manage | hr.employee.read | hr.employee.manage
//   createAgreement / updateAgreement      hr.config.manage · código único por organización
//                                          (409 HR_AGREEMENT_CODE_DUPLICATE); reglas iniciales opcionales
//   listAgreementRules(asOf?)              todas las versiones, o solo las vigentes en `asOf`
//   putAgreementRules                      upsert por (agreementId, key, validFrom); clave ∈
//                                          HR_AGREEMENT_RULE_KEYS y valor con la forma de la clave
//                                          (400 HR_AGREEMENT_RULE_INVALID); audita HR_AGREEMENT_CHANGED
//   assignAgreementToProperty              Property.agreementId (hr.config.manage; centro de la
//                                          organización y dentro del ámbito → 404 opaco si no)
//   resolveAgreementForProperty            contrato > centro > null, con los valores vigentes en
//                                          `asOf` (una versión por clave: la de mayor validFrom ≤ asOf
//                                          cuyo validTo es null o ≥ asOf)
//   seedAgreementCatalog                   siembra HR_AGREEMENT_DEFAULTS (parámetros públicos del
//                                          convenio) en una organización; idempotente por código
//
// Las consultas van por `deps` inyectables (patrón payroll/staff-profiles.service)
// para los tests unitarios con fakes en memoria (__tests__/agreements.test.mts).
// Lectores previstos: payroll/contracts.service (payCount = 12 + extra_pay_count),
// hr/rules.engine (RRHH-4), hr/labor-forecast (RRHH-3: annual_hours), seed-hr (RRHH-7).

import { prisma } from "@hotelos/database";
import {
  HR_AGREEMENT_DEFAULTS,
  HR_AGREEMENT_RULE_KEYS,
  type AgreementRuleDto,
  type CollectiveAgreementDto,
  type HrAgreementCode,
  type HrAgreementRuleKey,
  type HrAgreementRuleValues,
  type PermissionKey
} from "@hotelos/shared";
import type { UserContext } from "../../lib/demo-store.js";
import { propertyWithinScope } from "../../lib/finance-scope.js";
import { recordAuditEvent } from "../audit/audit.service.js";
import { dayUtc, isoDay } from "../treasury/money.js";
import { requireAnyPermission } from "../treasury/permissions.js";
import { hrBadRequest, hrConflict, hrNotFound } from "./hr-errors.js";

export const AGREEMENT_READ_KEYS: PermissionKey[] = ["hr.config.manage", "hr.employee.read", "hr.employee.manage"];
export const AGREEMENT_WRITE_KEYS: PermissionKey[] = ["hr.config.manage"];

export const AGREEMENT_CODE_MAX = 32;
export const AGREEMENT_NAME_MAX = 160;

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
/** «HH:MM»; se admite «24:00» como fin de tramo (diseño §2.3: nocturnidad 22-24 h). */
const HHMM = /^(([01]\d|2[0-3]):[0-5]\d|24:00)$/;

// ---------------------------------------------------------------------------
// Filas y dependencias
// ---------------------------------------------------------------------------

export type AgreementRow = {
  id: string;
  organizationId: string;
  code: string;
  name: string;
  scope: string | null;
  publishedRef: string | null;
  validFrom: Date;
  validTo: Date | null;
  ultraactivity: boolean;
  createdAt: Date;
  updatedAt: Date;
};

export type AgreementRuleRow = {
  id: string;
  agreementId: string;
  key: string;
  valueJson: unknown;
  validFrom: Date;
  validTo: Date | null;
  createdAt: Date;
};

type PropertyRow = { id: string; organizationId: string; agreementId: string | null };

/** Subconjunto del cliente Prisma que usa el módulo (los tests unitarios pasan fakes en memoria). */
export type AgreementDeps = {
  db: {
    collectiveAgreement: {
      findMany: (args: { where: { organizationId: string; id?: { in: string[] } }; orderBy?: unknown }) => Promise<AgreementRow[]>;
      findFirst: (args: { where: { organizationId: string; id?: string; code?: string } }) => Promise<AgreementRow | null>;
      create: (args: {
        data: { organizationId: string; code: string; name: string; scope: string | null; publishedRef: string | null; validFrom: Date; validTo: Date | null; ultraactivity: boolean };
      }) => Promise<AgreementRow>;
      update: (args: { where: { id: string }; data: Partial<Pick<AgreementRow, "name" | "scope" | "publishedRef" | "validTo" | "ultraactivity">> }) => Promise<AgreementRow>;
    };
    agreementRule: {
      findMany: (args: { where: { agreementId: string | { in: string[] } }; orderBy?: unknown }) => Promise<AgreementRuleRow[]>;
      upsert: (args: {
        where: { agreementId_key_validFrom: { agreementId: string; key: string; validFrom: Date } };
        create: { agreementId: string; key: string; valueJson: unknown; validFrom: Date; validTo: Date | null };
        update: { valueJson: unknown; validTo: Date | null };
      }) => Promise<AgreementRuleRow>;
    };
    property: {
      findMany: (args: { where: { organizationId: string; agreementId?: { not: null } }; select?: unknown }) => Promise<PropertyRow[]>;
      findFirst: (args: { where: { id: string; organizationId: string }; select?: unknown }) => Promise<PropertyRow | null>;
      update: (args: { where: { id: string }; data: { agreementId: string | null } }) => Promise<PropertyRow>;
    };
  };
  audit: typeof recordAuditEvent;
  now: () => Date;
};

export const defaultAgreementDeps: AgreementDeps = {
  db: prisma as unknown as AgreementDeps["db"],
  audit: recordAuditEvent,
  now: () => new Date()
};

// ---------------------------------------------------------------------------
// Reglas puras: validación de valores y resolución por fecha
// ---------------------------------------------------------------------------

type RuleShape = "number" | "nullable_number" | "boolean" | "hhmm" | "months" | "night_bands" | "it_rules";

const RULE_SHAPES: Record<HrAgreementRuleKey, RuleShape> = {
  annual_hours: "number",
  max_daily_hours: "number",
  rest_between_shifts_h: "number",
  weekly_rest_days: "number",
  break_minutes: "number",
  break_counts_as_work: "boolean",
  extra_pay_count: "number",
  extra_pay_months: "months",
  overtime_pct: "number",
  overtime_max_day: "nullable_number",
  overtime_max_month: "nullable_number",
  overtime_max_year: "number",
  night_from: "hhmm",
  night_to: "hhmm",
  night_pct_bands: "night_bands",
  vacation_days: "number",
  fd_call_notice_days: "number",
  fd_min_period_days: "nullable_number",
  fd_max_delay_days: "nullable_number",
  it_complement_rules: "it_rules",
  part_time_min_hours: "nullable_number"
};

const IT_ABSENCE_TYPES = new Set(["it_common", "it_accident"]);

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export function isAgreementRuleKey(key: string): key is HrAgreementRuleKey {
  return (HR_AGREEMENT_RULE_KEYS as readonly string[]).includes(key);
}

/** ¿Tiene `value` la forma que exige la clave (diseño §4 · AgreementRule / HrAgreementRuleValues)? */
export function isValidAgreementRuleValue(key: HrAgreementRuleKey, value: unknown): boolean {
  switch (RULE_SHAPES[key]) {
    case "number":
      return isFiniteNonNegative(value);
    case "nullable_number":
      return value === null || isFiniteNonNegative(value);
    case "boolean":
      return typeof value === "boolean";
    case "hhmm":
      return typeof value === "string" && HHMM.test(value);
    case "months":
      return Array.isArray(value) && value.every((month) => Number.isInteger(month) && month >= 1 && month <= 12);
    case "night_bands":
      return (
        Array.isArray(value) &&
        value.every(
          (band) =>
            typeof band === "object" && band !== null && HHMM.test(String((band as { from?: unknown }).from ?? "")) && HHMM.test(String((band as { to?: unknown }).to ?? "")) && isFiniteNonNegative((band as { pct?: unknown }).pct)
        )
      );
    case "it_rules":
      return (
        Array.isArray(value) &&
        value.every((rule) => {
          if (typeof rule !== "object" || rule === null) return false;
          const r = rule as { absenceType?: unknown; pct?: unknown; fromDay?: unknown; firstLeaveOnly?: unknown };
          return IT_ABSENCE_TYPES.has(String(r.absenceType)) && isFiniteNonNegative(r.pct) && Number.isInteger(r.fromDay) && (r.fromDay as number) >= 1 && (r.firstLeaveOnly === undefined || typeof r.firstLeaveOnly === "boolean");
        })
      );
    default:
      return false;
  }
}

/**
 * Valores vigentes en `asOf`: por clave, la versión con mayor `validFrom` ≤ asOf cuyo
 * `validTo` es null o ≥ asOf. Versiones futuras o caducadas no cuentan; una clave sin
 * versión vigente simplemente no aparece (el llamador decide el valor por defecto).
 */
export function effectiveRuleRows(rules: readonly AgreementRuleRow[], asOf: Date): Map<HrAgreementRuleKey, AgreementRuleRow> {
  const chosen = new Map<HrAgreementRuleKey, AgreementRuleRow>();
  for (const rule of rules) {
    if (!isAgreementRuleKey(rule.key)) continue;
    if (rule.validFrom.getTime() > asOf.getTime()) continue;
    if (rule.validTo && rule.validTo.getTime() < asOf.getTime()) continue;
    const current = chosen.get(rule.key);
    if (!current || rule.validFrom.getTime() > current.validFrom.getTime()) chosen.set(rule.key, rule);
  }
  return chosen;
}

export function effectiveRuleValues(rules: readonly AgreementRuleRow[], asOf: Date): Partial<HrAgreementRuleValues> {
  const values: Record<string, unknown> = {};
  for (const [key, rule] of effectiveRuleRows(rules, asOf)) values[key] = rule.valueJson;
  return values as Partial<HrAgreementRuleValues>;
}

/** Pagas anuales de un contrato: 12 mensuales + las extraordinarias del convenio; sin convenio, las 14 históricas. */
export function payCountFromRules(rules: Partial<HrAgreementRuleValues> | null | undefined): number {
  const extra = rules?.extra_pay_count;
  if (typeof extra === "number" && Number.isFinite(extra) && extra >= 0) return 12 + Math.round(extra);
  return 14;
}

// ---------------------------------------------------------------------------
// DTOs
// ---------------------------------------------------------------------------

function toAgreementDto(row: AgreementRow, rulesCount: number, propertyIds: string[]): CollectiveAgreementDto {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    scope: row.scope,
    publishedRef: row.publishedRef,
    validFrom: isoDay(row.validFrom),
    validTo: row.validTo ? isoDay(row.validTo) : null,
    ultraactivity: row.ultraactivity,
    rulesCount,
    propertyIds
  };
}

function toRuleDto(row: AgreementRuleRow): AgreementRuleDto {
  return {
    id: row.id,
    agreementId: row.agreementId,
    key: row.key as HrAgreementRuleKey,
    value: row.valueJson,
    validFrom: isoDay(row.validFrom),
    validTo: row.validTo ? isoDay(row.validTo) : null
  };
}

function parseDay(value: unknown, field: string, required: boolean): Date | null {
  if (value === undefined || value === null || value === "") {
    if (required) throw hrBadRequest("VALIDATION_ERROR", { field, message: `${field} es obligatoria (YYYY-MM-DD).` });
    return null;
  }
  if (typeof value !== "string" || !ISO_DAY.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    throw hrBadRequest("VALIDATION_ERROR", { field, message: `${field} debe ser una fecha YYYY-MM-DD.` });
  }
  return dayUtc(value);
}

function text(value: unknown, field: string, max: number, required: boolean): string | null {
  if (value === undefined || value === null) {
    if (required) throw hrBadRequest("VALIDATION_ERROR", { field, message: `${field} es obligatorio.` });
    return null;
  }
  if (typeof value !== "string") throw hrBadRequest("VALIDATION_ERROR", { field, message: `${field} debe ser un texto.` });
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    if (required) throw hrBadRequest("VALIDATION_ERROR", { field, message: `${field} es obligatorio.` });
    return null;
  }
  if (trimmed.length > max) throw hrBadRequest("VALIDATION_ERROR", { field, message: `${field} no puede superar ${max} caracteres.` });
  return trimmed;
}

async function requireAgreement(deps: AgreementDeps, organizationId: string, agreementId: string): Promise<AgreementRow> {
  const row = await deps.db.collectiveAgreement.findFirst({ where: { organizationId, id: agreementId } });
  if (!row) throw hrNotFound("HR_AGREEMENT_NOT_FOUND");
  return row;
}

async function propertyIdsByAgreement(deps: AgreementDeps, organizationId: string): Promise<Map<string, string[]>> {
  const properties = await deps.db.property.findMany({ where: { organizationId, agreementId: { not: null } }, select: { id: true, organizationId: true, agreementId: true } });
  const map = new Map<string, string[]>();
  for (const property of properties) {
    if (!property.agreementId) continue;
    const list = map.get(property.agreementId) ?? [];
    list.push(property.id);
    map.set(property.agreementId, list);
  }
  return map;
}

// ---------------------------------------------------------------------------
// Lecturas
// ---------------------------------------------------------------------------

export async function listAgreements(input: { context: UserContext }, deps: AgreementDeps = defaultAgreementDeps): Promise<CollectiveAgreementDto[]> {
  requireAnyPermission(input.context, AGREEMENT_READ_KEYS);
  const organizationId = input.context.organizationId;
  const rows = await deps.db.collectiveAgreement.findMany({ where: { organizationId }, orderBy: { code: "asc" } });
  if (rows.length === 0) return [];
  const [rules, byAgreement] = await Promise.all([
    deps.db.agreementRule.findMany({ where: { agreementId: { in: rows.map((row) => row.id) } } }),
    propertyIdsByAgreement(deps, organizationId)
  ]);
  const counts = new Map<string, number>();
  for (const rule of rules) counts.set(rule.agreementId, (counts.get(rule.agreementId) ?? 0) + 1);
  return rows
    .slice()
    .sort((a, b) => a.code.localeCompare(b.code))
    .map((row) => toAgreementDto(row, counts.get(row.id) ?? 0, byAgreement.get(row.id) ?? []));
}

export async function getAgreement(input: { context: UserContext; agreementId: string }, deps: AgreementDeps = defaultAgreementDeps): Promise<CollectiveAgreementDto> {
  requireAnyPermission(input.context, AGREEMENT_READ_KEYS);
  const organizationId = input.context.organizationId;
  const row = await requireAgreement(deps, organizationId, input.agreementId);
  const [rules, byAgreement] = await Promise.all([deps.db.agreementRule.findMany({ where: { agreementId: row.id } }), propertyIdsByAgreement(deps, organizationId)]);
  return toAgreementDto(row, rules.length, byAgreement.get(row.id) ?? []);
}

/** Todas las versiones de las reglas (orden clave, validFrom) o, con `asOf`, solo la vigente por clave. */
export async function listAgreementRules(input: { context: UserContext; agreementId: string; asOf?: string | null }, deps: AgreementDeps = defaultAgreementDeps): Promise<AgreementRuleDto[]> {
  requireAnyPermission(input.context, AGREEMENT_READ_KEYS);
  const agreement = await requireAgreement(deps, input.context.organizationId, input.agreementId);
  const rows = await deps.db.agreementRule.findMany({ where: { agreementId: agreement.id }, orderBy: [{ key: "asc" }, { validFrom: "asc" }] });
  const asOf = parseDay(input.asOf ?? null, "asOf", false);
  const selected = asOf ? [...effectiveRuleRows(rows, asOf).values()] : rows;
  return selected
    .slice()
    .sort((a, b) => a.key.localeCompare(b.key) || a.validFrom.getTime() - b.validFrom.getTime())
    .map(toRuleDto);
}

// ---------------------------------------------------------------------------
// Escrituras
// ---------------------------------------------------------------------------

export type AgreementInput = {
  code: string;
  name: string;
  scope?: string | null;
  publishedRef?: string | null;
  validFrom: string;
  validTo?: string | null;
  ultraactivity?: boolean;
  /** Reglas iniciales (valor por clave) vigentes desde `validFrom`. */
  rules?: Partial<HrAgreementRuleValues> | null;
};

export type AgreementRuleInput = { key: string; value: unknown; validFrom: string; validTo?: string | null };

function normaliseRules(rules: readonly AgreementRuleInput[]): Array<{ key: HrAgreementRuleKey; value: unknown; validFrom: Date; validTo: Date | null }> {
  if (!Array.isArray(rules)) throw hrBadRequest("HR_AGREEMENT_RULE_INVALID", { field: "rules" });
  return rules.map((rule, index) => {
    if (typeof rule !== "object" || rule === null || typeof rule.key !== "string" || !isAgreementRuleKey(rule.key)) {
      throw hrBadRequest("HR_AGREEMENT_RULE_INVALID", { field: `rules[${index}].key`, key: (rule as { key?: unknown })?.key ?? null });
    }
    if (!isValidAgreementRuleValue(rule.key, rule.value)) throw hrBadRequest("HR_AGREEMENT_RULE_INVALID", { field: `rules[${index}].value`, key: rule.key });
    const validFrom = parseDay(rule.validFrom, `rules[${index}].validFrom`, true)!;
    const validTo = parseDay(rule.validTo ?? null, `rules[${index}].validTo`, false);
    if (validTo && validTo.getTime() < validFrom.getTime()) throw hrBadRequest("VALIDATION_ERROR", { field: `rules[${index}].validTo`, message: "validTo debe ser igual o posterior a validFrom." });
    return { key: rule.key, value: rule.value, validFrom, validTo };
  });
}

async function upsertRules(deps: AgreementDeps, agreementId: string, rules: ReadonlyArray<{ key: HrAgreementRuleKey; value: unknown; validFrom: Date; validTo: Date | null }>): Promise<AgreementRuleRow[]> {
  const written: AgreementRuleRow[] = [];
  for (const rule of rules) {
    written.push(
      await deps.db.agreementRule.upsert({
        where: { agreementId_key_validFrom: { agreementId, key: rule.key, validFrom: rule.validFrom } },
        create: { agreementId, key: rule.key, valueJson: rule.value, validFrom: rule.validFrom, validTo: rule.validTo },
        update: { valueJson: rule.value, validTo: rule.validTo }
      })
    );
  }
  return written;
}

function rulesFromValues(values: Partial<HrAgreementRuleValues>, validFrom: string): AgreementRuleInput[] {
  return Object.entries(values)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => ({ key, value, validFrom, validTo: null }));
}

export async function createAgreement(input: { context: UserContext; body: AgreementInput; correlationId: string }, deps: AgreementDeps = defaultAgreementDeps): Promise<CollectiveAgreementDto> {
  requireAnyPermission(input.context, AGREEMENT_WRITE_KEYS);
  const organizationId = input.context.organizationId;
  const body = input.body ?? ({} as AgreementInput);
  const code = text(body.code, "code", AGREEMENT_CODE_MAX, true)!.toUpperCase();
  const name = text(body.name, "name", AGREEMENT_NAME_MAX, true)!;
  const scope = text(body.scope, "scope", 64, false);
  const publishedRef = text(body.publishedRef, "publishedRef", 200, false);
  const validFrom = parseDay(body.validFrom, "validFrom", true)!;
  const validTo = parseDay(body.validTo ?? null, "validTo", false);
  if (validTo && validTo.getTime() < validFrom.getTime()) throw hrBadRequest("VALIDATION_ERROR", { field: "validTo", message: "validTo debe ser igual o posterior a validFrom." });
  const ultraactivity = body.ultraactivity === undefined ? false : body.ultraactivity === true;
  const rules = body.rules ? normaliseRules(rulesFromValues(body.rules, isoDay(validFrom))) : [];

  const duplicate = await deps.db.collectiveAgreement.findFirst({ where: { organizationId, code } });
  if (duplicate) throw hrConflict("HR_AGREEMENT_CODE_DUPLICATE", { agreementId: duplicate.id, agreementCode: code });

  const created = await deps.db.collectiveAgreement.create({ data: { organizationId, code, name, scope, publishedRef, validFrom, validTo, ultraactivity } });
  const written = await upsertRules(deps, created.id, rules);

  deps.audit({
    organizationId,
    actorUserId: input.context.userId,
    actorType: "user",
    action: "HR_AGREEMENT_CHANGED",
    entityType: "collective_agreement",
    entityId: created.id,
    afterJson: { change: "created", code, name, validFrom: isoDay(validFrom), validTo: validTo ? isoDay(validTo) : null, rules: written.map((rule) => rule.key) },
    deviceId: input.context.deviceId,
    correlationId: input.correlationId
  });

  return toAgreementDto(created, written.length, []);
}

export async function updateAgreement(
  input: { context: UserContext; agreementId: string; body: Partial<Pick<AgreementInput, "name" | "scope" | "publishedRef" | "validTo" | "ultraactivity">>; correlationId: string },
  deps: AgreementDeps = defaultAgreementDeps
): Promise<CollectiveAgreementDto> {
  requireAnyPermission(input.context, AGREEMENT_WRITE_KEYS);
  const organizationId = input.context.organizationId;
  const existing = await requireAgreement(deps, organizationId, input.agreementId);
  const body = input.body ?? {};
  const data: Partial<Pick<AgreementRow, "name" | "scope" | "publishedRef" | "validTo" | "ultraactivity">> = {};
  if (body.name !== undefined) data.name = text(body.name, "name", AGREEMENT_NAME_MAX, true)!;
  if (body.scope !== undefined) data.scope = text(body.scope, "scope", 64, false);
  if (body.publishedRef !== undefined) data.publishedRef = text(body.publishedRef, "publishedRef", 200, false);
  if (body.validTo !== undefined) {
    const validTo = parseDay(body.validTo, "validTo", false);
    if (validTo && validTo.getTime() < existing.validFrom.getTime()) throw hrBadRequest("VALIDATION_ERROR", { field: "validTo", message: "validTo debe ser igual o posterior a validFrom." });
    data.validTo = validTo;
  }
  if (body.ultraactivity !== undefined) data.ultraactivity = body.ultraactivity === true;
  const updated = Object.keys(data).length > 0 ? await deps.db.collectiveAgreement.update({ where: { id: existing.id }, data }) : existing;
  const [rules, byAgreement] = await Promise.all([deps.db.agreementRule.findMany({ where: { agreementId: updated.id } }), propertyIdsByAgreement(deps, organizationId)]);
  if (Object.keys(data).length > 0) {
    deps.audit({
      organizationId,
      actorUserId: input.context.userId,
      actorType: "user",
      action: "HR_AGREEMENT_CHANGED",
      entityType: "collective_agreement",
      entityId: updated.id,
      beforeJson: { name: existing.name, scope: existing.scope, publishedRef: existing.publishedRef, validTo: existing.validTo ? isoDay(existing.validTo) : null, ultraactivity: existing.ultraactivity },
      afterJson: { change: "updated", ...data, validTo: updated.validTo ? isoDay(updated.validTo) : null },
      deviceId: input.context.deviceId,
      correlationId: input.correlationId
    });
  }
  return toAgreementDto(updated, rules.length, byAgreement.get(updated.id) ?? []);
}

/** Crea o sustituye versiones de reglas por (clave, validFrom); nunca borra versiones anteriores. */
export async function putAgreementRules(
  input: { context: UserContext; agreementId: string; rules: readonly AgreementRuleInput[]; correlationId: string },
  deps: AgreementDeps = defaultAgreementDeps
): Promise<AgreementRuleDto[]> {
  requireAnyPermission(input.context, AGREEMENT_WRITE_KEYS);
  const organizationId = input.context.organizationId;
  const agreement = await requireAgreement(deps, organizationId, input.agreementId);
  const rules = normaliseRules(input.rules);
  if (rules.length === 0) throw hrBadRequest("HR_AGREEMENT_RULE_INVALID", { field: "rules", message: "Indica al menos una regla." });
  const written = await upsertRules(deps, agreement.id, rules);
  deps.audit({
    organizationId,
    actorUserId: input.context.userId,
    actorType: "user",
    action: "HR_AGREEMENT_CHANGED",
    entityType: "collective_agreement",
    entityId: agreement.id,
    afterJson: { change: "rules", code: agreement.code, rules: written.map((rule) => ({ key: rule.key, validFrom: isoDay(rule.validFrom), validTo: rule.validTo ? isoDay(rule.validTo) : null })) },
    deviceId: input.context.deviceId,
    correlationId: input.correlationId
  });
  return written.map(toRuleDto);
}

/** Convenio aplicable al centro (Property.agreementId); `null` lo desasigna. */
export async function assignAgreementToProperty(
  input: { context: UserContext; propertyId: string; agreementId: string | null; correlationId: string },
  deps: AgreementDeps = defaultAgreementDeps
): Promise<{ propertyId: string; agreementId: string | null }> {
  requireAnyPermission(input.context, AGREEMENT_WRITE_KEYS);
  const organizationId = input.context.organizationId;
  const property = await deps.db.property.findFirst({ where: { id: input.propertyId, organizationId }, select: { id: true, organizationId: true, agreementId: true } });
  if (!property || !propertyWithinScope(input.context, input.propertyId)) throw hrNotFound("PROPERTY_NOT_FOUND");
  const agreement = input.agreementId ? await requireAgreement(deps, organizationId, input.agreementId) : null;
  const updated = await deps.db.property.update({ where: { id: property.id }, data: { agreementId: agreement?.id ?? null } });
  deps.audit({
    organizationId,
    propertyId: property.id,
    actorUserId: input.context.userId,
    actorType: "user",
    action: "HR_AGREEMENT_CHANGED",
    entityType: "property",
    entityId: property.id,
    beforeJson: { agreementId: property.agreementId },
    afterJson: { change: "property_assignment", agreementId: updated.agreementId, code: agreement?.code ?? null },
    deviceId: input.context.deviceId,
    correlationId: input.correlationId
  });
  return { propertyId: property.id, agreementId: updated.agreementId };
}

// ---------------------------------------------------------------------------
// Resolución (contrato > centro > null) y siembra del catálogo
// ---------------------------------------------------------------------------

export type ResolvedAgreement = {
  agreement: CollectiveAgreementDto | null;
  /** Valores vigentes en `asOf` (vacío sin convenio). */
  rules: Partial<HrAgreementRuleValues>;
  source: "contract" | "property" | null;
};

/**
 * Convenio aplicable: el del contrato (`contractAgreementId`) si es de la organización,
 * si no el del centro (Property.agreementId), si no ninguno. Sin permisos: es una
 * consulta interna (contratos, motor de reglas, previsión); las rutas ya gatearon.
 */
export async function resolveAgreementForProperty(
  input: { organizationId: string; propertyId?: string | null; contractAgreementId?: string | null; asOf?: Date | string | null },
  deps: AgreementDeps = defaultAgreementDeps
): Promise<ResolvedAgreement> {
  const asOf = input.asOf ? dayUtc(input.asOf) : dayUtc(deps.now());
  let source: ResolvedAgreement["source"] = null;
  let row: AgreementRow | null = null;
  if (input.contractAgreementId) {
    row = await deps.db.collectiveAgreement.findFirst({ where: { organizationId: input.organizationId, id: input.contractAgreementId } });
    if (row) source = "contract";
  }
  if (!row && input.propertyId) {
    const property = await deps.db.property.findFirst({ where: { id: input.propertyId, organizationId: input.organizationId }, select: { id: true, organizationId: true, agreementId: true } });
    if (property?.agreementId) {
      row = await deps.db.collectiveAgreement.findFirst({ where: { organizationId: input.organizationId, id: property.agreementId } });
      if (row) source = "property";
    }
  }
  if (!row) return { agreement: null, rules: {}, source: null };
  const rules = await deps.db.agreementRule.findMany({ where: { agreementId: row.id } });
  return { agreement: toAgreementDto(row, rules.length, []), rules: effectiveRuleValues(rules, asOf), source };
}

export type SeedAgreementCatalogResult = { created: Array<{ id: string; code: string }>; skipped: string[] };

/**
 * Siembra los convenios de HR_AGREEMENT_DEFAULTS (parámetros públicos: jornada, pagas, topes,
 * preavisos) con todas sus reglas vigentes desde `validFrom`. Idempotente: un código ya
 * existente se salta (sus reglas no se tocan). Sin contexto de usuario (seed y rutas de
 * administración lo llaman tras su propio gate); con `actorUserId` audita como usuario.
 */
export async function seedAgreementCatalog(
  input: { organizationId: string; codes?: readonly HrAgreementCode[]; actorUserId?: string; correlationId?: string },
  deps: AgreementDeps = defaultAgreementDeps
): Promise<SeedAgreementCatalogResult> {
  const codes = input.codes ?? (Object.keys(HR_AGREEMENT_DEFAULTS) as HrAgreementCode[]);
  const existing = await deps.db.collectiveAgreement.findMany({ where: { organizationId: input.organizationId } });
  const byCode = new Map(existing.map((row) => [row.code, row]));
  const result: SeedAgreementCatalogResult = { created: [], skipped: [] };
  for (const code of codes) {
    const template = HR_AGREEMENT_DEFAULTS[code];
    if (!template) throw hrBadRequest("VALIDATION_ERROR", { field: "codes", message: `Convenio por defecto desconocido: ${String(code)}.` });
    if (byCode.has(code)) {
      result.skipped.push(code);
      continue;
    }
    const validFrom = dayUtc(template.validFrom);
    const created = await deps.db.collectiveAgreement.create({
      data: {
        organizationId: input.organizationId,
        code: template.code,
        name: template.name,
        scope: template.scope,
        publishedRef: template.publishedRef,
        validFrom,
        validTo: template.validTo ? dayUtc(template.validTo) : null,
        ultraactivity: template.ultraactivity
      }
    });
    const rules = normaliseRules(rulesFromValues(template.rules, template.validFrom));
    const written = await upsertRules(deps, created.id, rules);
    byCode.set(code, created);
    result.created.push({ id: created.id, code: created.code });
    deps.audit({
      organizationId: input.organizationId,
      actorUserId: input.actorUserId,
      actorType: input.actorUserId ? "user" : "system",
      action: "HR_AGREEMENT_CHANGED",
      entityType: "collective_agreement",
      entityId: created.id,
      afterJson: { change: "seeded", code: created.code, rules: written.length, source: "HR_AGREEMENT_DEFAULTS" },
      correlationId: input.correlationId
    });
  }
  return result;
}
