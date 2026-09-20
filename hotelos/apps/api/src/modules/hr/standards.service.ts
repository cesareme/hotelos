// Estándares de dotación por centro · Tanda RRHH · RRHH-3 (diseño §4 LaborStandard, §6.2, §9 :289).
//
//   listLaborStandards({ context, propertyId, at? })            workforce.read | hr.standards.manage
//     estándares vigentes en la fecha `at` (hoy por defecto): validFrom ≤ at y (validTo null o ≥ at).
//   putLaborStandards({ context, propertyId, standards, validFrom?, correlationId })   hr.standards.manage
//     conjunto completo del centro versionado por `validFrom` (hoy por defecto): los estándares
//     activos de la misma pareja (departamento, driver) con validFrom anterior se cierran con
//     validTo = validFrom − 1 día; los que no vienen en el conjunto también se cierran (PUT = foto
//     completa); la misma clave única (propertyId, departamento, driver, validFrom) se actualiza.
//     Validación pura `normaliseLaborStandardInput` (400 HR_STANDARD_INVALID: driver/unit incompatibles,
//     tramos mal formados, valor ≤ 0, suplementos fuera de 0-100, cobertura fuera de 0,5-3).
//   resetLaborStandardDefaults({ context, propertyId, correlationId })   hr.standards.manage
//     siembra HR_STANDARD_DEFAULTS según Property.starRating (hrStarBandOf) con source `sector_default`.
// Centro inexistente, de otra organización o fuera del ámbito → 404 opaco PROPERTY_NOT_FOUND.
// Auditoría HR_STANDARDS_CHANGED con recuentos (sin datos personales: aquí no los hay).

import { prisma } from "@hotelos/database";
import {
  HR_ERROR_MESSAGES_ES,
  HR_STANDARD_DEFAULTS,
  HR_USALI_DEPARTMENTS,
  LABOR_STANDARD_DRIVERS,
  LABOR_STANDARD_SOURCES,
  LABOR_STANDARD_UNITS,
  hrStarBandOf,
  type HrErrorCode,
  type HrUsaliDepartment,
  type LaborStandardBand,
  type LaborStandardDriver,
  type LaborStandardDto,
  type LaborStandardSource,
  type LaborStandardUnit
} from "@hotelos/shared";
import type { UserContext } from "../../lib/demo-store.js";
import { propertyWithinScope } from "../../lib/finance-scope.js";
import { BadRequestError, ConflictError, NotFoundError } from "../../lib/http-error.js";
import { recordAuditEvent } from "../audit/audit.service.js";
import { requirePermissions } from "../auth/auth.service.js";
import { addDays, dayUtc, isoDate } from "../revenue/actuals.js";
import { requireAnyPermission } from "../treasury/permissions.js";
import type { EngineStandard } from "./labor-forecast.engine.js";

// ---------------------------------------------------------------------------
// Errores con `details.code` (HR_ERROR_CODES) — locales al lote para no acoplar ficheros concurrentes
// ---------------------------------------------------------------------------

export function hrForecastBadRequest(code: HrErrorCode, extra: Record<string, unknown> = {}, message?: string): BadRequestError {
  const error = new BadRequestError(message ?? HR_ERROR_MESSAGES_ES[code]);
  error.details = { ...extra, code };
  return error;
}

export function hrForecastNotFound(code: HrErrorCode = "PROPERTY_NOT_FOUND"): NotFoundError {
  const error = new NotFoundError(HR_ERROR_MESSAGES_ES[code]);
  error.details = { code };
  return error;
}

export function hrForecastConflict(code: HrErrorCode, extra: Record<string, unknown> = {}): ConflictError {
  return new ConflictError(HR_ERROR_MESSAGES_ES[code], { ...extra, code });
}

export type HrPropertyRow = { id: string; organizationId: string; legalEntityId: string | null; starRating: number | null; agreementId: string | null; name: string };

/** Centro de la organización del actor y dentro de su ámbito, o 404 opaco (nunca un oráculo). */
export async function requireHrProperty(context: UserContext, propertyId: string): Promise<HrPropertyRow> {
  const row = await prisma.property.findFirst({
    where: { id: propertyId, organizationId: context.organizationId },
    select: { id: true, organizationId: true, legalEntityId: true, starRating: true, agreementId: true, name: true }
  });
  if (!row || !propertyWithinScope(context, row.id)) throw hrForecastNotFound("PROPERTY_NOT_FOUND");
  return row;
}

// ---------------------------------------------------------------------------
// Validación pura
// ---------------------------------------------------------------------------

/** Unidades admitidas por driver (D §4 LaborStandard). */
export const LABOR_STANDARD_DRIVER_UNITS: Record<LaborStandardDriver, readonly LaborStandardUnit[]> = {
  occupied_rooms: ["minutes_per_unit", "units_per_shift", "posts_by_band"],
  departures: ["minutes_per_unit", "units_per_shift"],
  stayovers: ["minutes_per_unit", "units_per_shift"],
  arrivals: ["minutes_per_unit", "units_per_shift"],
  pax: ["minutes_per_unit", "units_per_shift"],
  covers_breakfast: ["minutes_per_unit", "units_per_shift"],
  covers_restaurant: ["minutes_per_unit", "units_per_shift"],
  rooms_inventory: ["fte_per_100"],
  fixed: ["units_per_shift"]
};

export type LaborStandardInput = {
  usaliDepartment: string;
  driver: string;
  unit: string;
  value: number | string;
  bands?: unknown;
  allowancePct?: number | string | null;
  coverageFactor?: number | string | null;
  source?: string | null;
};

export type NormalisedLaborStandard = {
  usaliDepartment: HrUsaliDepartment;
  driver: LaborStandardDriver;
  unit: LaborStandardUnit;
  /** "32.000" (3 decimales). */
  value: string;
  bands: LaborStandardBand[] | null;
  /** "12.00". */
  allowancePct: string;
  /** "1.40". */
  coverageFactor: string;
  source: LaborStandardSource;
};

function toNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "number" ? value : Number(String(value).trim().replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

function normaliseBands(raw: unknown, index: number): LaborStandardBand[] {
  if (!Array.isArray(raw) || raw.length === 0) throw hrForecastBadRequest("HR_STANDARD_INVALID", { index, field: "bands" }, "posts_by_band exige al menos un tramo.");
  const bands: LaborStandardBand[] = raw.map((entry, i) => {
    const e = (entry ?? {}) as { maxOccupiedRooms?: unknown; posts?: unknown };
    const max = e.maxOccupiedRooms === null || e.maxOccupiedRooms === undefined ? null : toNumber(e.maxOccupiedRooms);
    if (max !== null && (!Number.isInteger(max) || max < 0)) throw hrForecastBadRequest("HR_STANDARD_INVALID", { index, field: `bands[${i}].maxOccupiedRooms` });
    if (!Array.isArray(e.posts) || e.posts.length !== 3) throw hrForecastBadRequest("HR_STANDARD_INVALID", { index, field: `bands[${i}].posts` }, "Cada tramo lleva tres puestos: mañana, tarde y noche.");
    const posts = e.posts.map((p) => toNumber(p));
    if (posts.some((p) => p === null || !Number.isInteger(p) || p < 0)) throw hrForecastBadRequest("HR_STANDARD_INVALID", { index, field: `bands[${i}].posts` });
    return { maxOccupiedRooms: max, posts: [posts[0]!, posts[1]!, posts[2]!] as [number, number, number] };
  });
  if (!bands.some((b) => b.maxOccupiedRooms === null)) throw hrForecastBadRequest("HR_STANDARD_INVALID", { index, field: "bands" }, "El último tramo debe ser abierto (maxOccupiedRooms null).");
  return bands;
}

export function normaliseLaborStandardInput(input: LaborStandardInput, index = 0): NormalisedLaborStandard {
  const department = String(input.usaliDepartment ?? "").trim() as HrUsaliDepartment;
  if (!HR_USALI_DEPARTMENTS.includes(department)) throw hrForecastBadRequest("HR_STANDARD_INVALID", { index, field: "usaliDepartment" });
  const driver = String(input.driver ?? "").trim() as LaborStandardDriver;
  if (!LABOR_STANDARD_DRIVERS.includes(driver)) throw hrForecastBadRequest("HR_STANDARD_INVALID", { index, field: "driver" });
  const unit = String(input.unit ?? "").trim() as LaborStandardUnit;
  if (!LABOR_STANDARD_UNITS.includes(unit)) throw hrForecastBadRequest("HR_STANDARD_INVALID", { index, field: "unit" });
  if (!LABOR_STANDARD_DRIVER_UNITS[driver].includes(unit)) throw hrForecastBadRequest("HR_STANDARD_INVALID", { index, field: "unit", driver, unit }, `La unidad ${unit} no es compatible con el driver ${driver}.`);
  const value = toNumber(input.value);
  if (value === null || value <= 0 || value > 9_999_999) throw hrForecastBadRequest("HR_STANDARD_INVALID", { index, field: "value" });
  const allowance = input.allowancePct === undefined || input.allowancePct === null ? 0 : toNumber(input.allowancePct);
  if (allowance === null || allowance < 0 || allowance > 100) throw hrForecastBadRequest("HR_STANDARD_INVALID", { index, field: "allowancePct" });
  const coverage = input.coverageFactor === undefined || input.coverageFactor === null ? 1.4 : toNumber(input.coverageFactor);
  if (coverage === null || coverage < 0.5 || coverage > 3) throw hrForecastBadRequest("HR_STANDARD_INVALID", { index, field: "coverageFactor" });
  const source = (input.source ?? "measured") as LaborStandardSource;
  if (!LABOR_STANDARD_SOURCES.includes(source)) throw hrForecastBadRequest("HR_STANDARD_INVALID", { index, field: "source" });
  const bands = unit === "posts_by_band" ? normaliseBands(input.bands, index) : null;
  return { usaliDepartment: department, driver, unit, value: value.toFixed(3), bands, allowancePct: allowance.toFixed(2), coverageFactor: coverage.toFixed(2), source };
}

/**
 * Un conjunto no puede repetir (departamento, driver): la clave única de labor_standards es
 * (propertyId, usaliDepartment, driver, validFrom) — sin `unit` —, así que dos unidades del mismo
 * driver (sala + cocina sobre cubiertos de desayuno) deben fundirse en una línea equivalente
 * (`mergeSameDriverStandards`) antes de escribir.
 */
export function normaliseLaborStandardSet(inputs: readonly LaborStandardInput[]): NormalisedLaborStandard[] {
  if (!Array.isArray(inputs) || inputs.length === 0) throw hrForecastBadRequest("HR_STANDARD_INVALID", { field: "standards" }, "Indica al menos un estándar.");
  if (inputs.length > 200) throw hrForecastBadRequest("HR_STANDARD_INVALID", { field: "standards" }, "Máximo 200 estándares por centro.");
  const seen = new Set<string>();
  return inputs.map((input, index) => {
    const row = normaliseLaborStandardInput(input, index);
    const key = `${row.usaliDepartment}|${row.driver}`;
    if (seen.has(key)) throw hrForecastBadRequest("HR_STANDARD_INVALID", { index, field: "driver" }, `Estándar repetido: ${row.usaliDepartment} · ${row.driver} (un solo estándar por departamento y driver; funde sala y cocina en minutos por cubierto).`);
    seen.add(key);
    return row;
  });
}

/**
 * Funde las líneas de un mismo (departamento, driver) en UNA de `minutes_per_unit` con las mismas
 * horas totales: `units_per_shift` (driver ≠ fixed) equivale a horasPorTurno × 60 / cupo minutos por
 * unidad. Desayunos 4★: sala 2,4 min (25 cubiertos/camarero·h) + cocina 10,667 min (1/45 por turno de
 * 8 h) = 13,067 min por cubierto. Suplementos y cobertura: los de la primera línea (iguales en los
 * valores por defecto). Las líneas sin pareja se devuelven tal cual.
 */
export function mergeSameDriverStandards<T extends { usaliDepartment: string; driver: string; unit: string; value: string | number; bands: LaborStandardBand[] | null; allowancePct: string; coverageFactor: string; source?: string | null }>(rows: readonly T[], hoursPerShift = 8): T[] {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const key = `${row.usaliDepartment}|${row.driver}`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  const out: T[] = [];
  for (const group of groups.values()) {
    if (group.length === 1) {
      out.push(group[0]!);
      continue;
    }
    let minutes = 0;
    for (const row of group) {
      const value = toNumber(row.value) ?? 0;
      if (row.unit === "minutes_per_unit") minutes += value;
      else if (row.unit === "units_per_shift" && row.driver !== "fixed" && value > 0) minutes += (hoursPerShift * 60) / value;
      else throw hrForecastBadRequest("HR_STANDARD_INVALID", { field: "unit", driver: row.driver, unit: row.unit }, `No se pueden fundir dos estándares ${row.driver} con unidad ${row.unit}.`);
    }
    out.push({ ...group[0]!, unit: "minutes_per_unit", value: minutes.toFixed(3), bands: null });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Mapeo
// ---------------------------------------------------------------------------

type StandardRow = {
  id: string;
  propertyId: string;
  usaliDepartment: string;
  driver: string;
  unit: string;
  value: unknown;
  bandsJson: unknown;
  allowancePct: unknown;
  coverageFactor: unknown;
  validFrom: Date;
  validTo: Date | null;
  source: string;
};

function decText(value: unknown, decimals: number): string {
  const n = toNumber(value) ?? 0;
  return n.toFixed(decimals);
}

function bandsOf(raw: unknown): LaborStandardBand[] | null {
  if (!Array.isArray(raw)) return null;
  const bands: LaborStandardBand[] = [];
  for (const entry of raw) {
    const e = (entry ?? {}) as { maxOccupiedRooms?: unknown; posts?: unknown };
    if (!Array.isArray(e.posts) || e.posts.length !== 3) continue;
    const posts = e.posts.map((p) => toNumber(p) ?? 0);
    bands.push({ maxOccupiedRooms: e.maxOccupiedRooms === null || e.maxOccupiedRooms === undefined ? null : toNumber(e.maxOccupiedRooms), posts: [posts[0]!, posts[1]!, posts[2]!] });
  }
  return bands;
}

export function mapLaborStandard(row: StandardRow): LaborStandardDto {
  return {
    id: row.id,
    propertyId: row.propertyId,
    usaliDepartment: row.usaliDepartment as HrUsaliDepartment,
    driver: row.driver as LaborStandardDriver,
    unit: row.unit as LaborStandardUnit,
    value: decText(row.value, 3),
    bands: bandsOf(row.bandsJson),
    allowancePct: decText(row.allowancePct, 2),
    coverageFactor: decText(row.coverageFactor, 2),
    validFrom: isoDate(row.validFrom),
    validTo: row.validTo ? isoDate(row.validTo) : null,
    source: row.source as LaborStandardSource
  };
}

/** Estándar del cable → estándar del motor (números). */
export function toEngineStandard(dto: Pick<LaborStandardDto, "usaliDepartment" | "driver" | "unit" | "value" | "bands" | "allowancePct" | "coverageFactor">): EngineStandard {
  return {
    usaliDepartment: dto.usaliDepartment,
    driver: dto.driver,
    unit: dto.unit,
    value: toNumber(dto.value) ?? 0,
    bands: dto.bands,
    allowancePct: toNumber(dto.allowancePct) ?? 0,
    coverageFactor: toNumber(dto.coverageFactor) ?? 1
  };
}

/**
 * Estándares vigentes en `at` de entre todas las filas del centro (última versión por pareja
 * departamento × driver). Una fecha ANTERIOR a la primera versión de la pareja usa esa primera
 * versión (los estándares conocidos rigen hacia atrás para los días sin versión registrada: así
 * «Restablecer valores del sector» hoy cubre también la ventana pasada de la previsión); una fecha
 * posterior a una versión cerrada (validTo) sin sucesora queda sin estándar.
 */
export function activeStandardsAt(rows: readonly LaborStandardDto[], at: string): LaborStandardDto[] {
  const latest = new Map<string, LaborStandardDto>();
  const earliest = new Map<string, LaborStandardDto>();
  for (const row of rows) {
    const key = `${row.usaliDepartment}|${row.driver}`;
    const first = earliest.get(key);
    if (!first || row.validFrom < first.validFrom) earliest.set(key, row);
    if (row.validFrom > at) continue;
    if (row.validTo !== null && row.validTo < at) continue;
    const current = latest.get(key);
    if (!current || current.validFrom < row.validFrom) latest.set(key, row);
  }
  for (const [key, first] of earliest) {
    if (!latest.has(key) && first.validFrom > at) latest.set(key, first);
  }
  return Array.from(latest.values()).sort((a, b) => a.usaliDepartment.localeCompare(b.usaliDepartment) || a.driver.localeCompare(b.driver) || a.unit.localeCompare(b.unit));
}

// ---------------------------------------------------------------------------
// Servicio
// ---------------------------------------------------------------------------

export const STANDARDS_READ_KEYS = ["workforce.read", "hr.standards.manage", "workforce.schedule.manage"] as const;

export async function loadLaborStandards(propertyId: string): Promise<LaborStandardDto[]> {
  const rows = await prisma.laborStandard.findMany({ where: { propertyId }, orderBy: [{ usaliDepartment: "asc" }, { driver: "asc" }, { validFrom: "asc" }] });
  return rows.map(mapLaborStandard);
}

export async function listLaborStandards(input: { context: UserContext; propertyId: string; at?: string }): Promise<{ propertyId: string; at: string; standards: LaborStandardDto[]; starBand: 2 | 3 | 4 }> {
  requireAnyPermission(input.context, [...STANDARDS_READ_KEYS]);
  const property = await requireHrProperty(input.context, input.propertyId);
  const at = isoDate(dayUtc(input.at));
  const rows = await loadLaborStandards(property.id);
  return { propertyId: property.id, at, standards: activeStandardsAt(rows, at), starBand: hrStarBandOf(property.starRating) };
}

export async function putLaborStandards(input: { context: UserContext; propertyId: string; standards: readonly LaborStandardInput[]; validFrom?: string; correlationId?: string }): Promise<{ propertyId: string; validFrom: string; standards: LaborStandardDto[]; closed: number; written: number }> {
  requirePermissions(input.context, ["hr.standards.manage"]);
  const property = await requireHrProperty(input.context, input.propertyId);
  const set = normaliseLaborStandardSet(input.standards);
  const validFrom = dayUtc(input.validFrom);
  const validFromKey = isoDate(validFrom);
  const previousTo = addDays(validFrom, -1);
  const keys = new Set(set.map((s) => `${s.usaliDepartment}|${s.driver}`));

  const result = await prisma.$transaction(async (tx) => {
    // 1. Cerrar las versiones activas anteriores (pareja presente o ausente en la foto nueva).
    const active = await tx.laborStandard.findMany({ where: { propertyId: property.id, validTo: null, validFrom: { lt: validFrom } }, select: { id: true, usaliDepartment: true, driver: true } });
    let closed = 0;
    for (const row of active) {
      await tx.laborStandard.update({ where: { id: row.id }, data: { validTo: previousTo } });
      closed += 1;
    }
    // 2. Escribir la foto nueva (misma clave única → update).
    let written = 0;
    for (const s of set) {
      await tx.laborStandard.upsert({
        where: { propertyId_usaliDepartment_driver_validFrom: { propertyId: property.id, usaliDepartment: s.usaliDepartment, driver: s.driver, validFrom } },
        create: { propertyId: property.id, usaliDepartment: s.usaliDepartment, driver: s.driver, unit: s.unit, value: s.value, bandsJson: s.bands === null ? undefined : (s.bands as unknown as object), allowancePct: s.allowancePct, coverageFactor: s.coverageFactor, validFrom, validTo: null, source: s.source },
        update: { unit: s.unit, value: s.value, bandsJson: s.bands === null ? undefined : (s.bands as unknown as object), allowancePct: s.allowancePct, coverageFactor: s.coverageFactor, validTo: null, source: s.source }
      });
      written += 1;
    }
    // 3. Filas de la misma fecha que ya no están en la foto: se cierran ese mismo día.
    const sameDay = await tx.laborStandard.findMany({ where: { propertyId: property.id, validFrom, validTo: null }, select: { id: true, usaliDepartment: true, driver: true } });
    for (const row of sameDay) {
      if (!keys.has(`${row.usaliDepartment}|${row.driver}`)) {
        await tx.laborStandard.update({ where: { id: row.id }, data: { validTo: validFrom } });
        closed += 1;
      }
    }
    return { closed, written };
  });

  recordAuditEvent({
    organizationId: property.organizationId,
    propertyId: property.id,
    actorUserId: input.context.userId,
    actorType: "user",
    action: "HR_STANDARDS_CHANGED",
    entityType: "labor_standard",
    entityId: property.id,
    afterJson: { validFrom: validFromKey, written: result.written, closed: result.closed, departments: Array.from(new Set(set.map((s) => s.usaliDepartment))) },
    deviceId: input.context.deviceId,
    correlationId: input.correlationId
  });
  const rows = await loadLaborStandards(property.id);
  return { propertyId: property.id, validFrom: validFromKey, standards: activeStandardsAt(rows, validFromKey), ...result };
}

/** Restablece los valores del sector por categoría (D §6.2) desde HR_STANDARD_DEFAULTS. */
export async function resetLaborStandardDefaults(input: { context: UserContext; propertyId: string; validFrom?: string; correlationId?: string }): Promise<{ propertyId: string; validFrom: string; starBand: 2 | 3 | 4; standards: LaborStandardDto[]; written: number; closed: number }> {
  requirePermissions(input.context, ["hr.standards.manage"]);
  const property = await requireHrProperty(input.context, input.propertyId);
  const band = hrStarBandOf(property.starRating);
  const defaults = mergeSameDriverStandards(HR_STANDARD_DEFAULTS[band].map((d) => ({ usaliDepartment: d.usaliDepartment, driver: d.driver, unit: d.unit, value: d.value, bands: d.bands, allowancePct: d.allowancePct, coverageFactor: d.coverageFactor, source: "sector_default" as const })));
  const result = await putLaborStandards({ context: input.context, propertyId: property.id, standards: defaults, validFrom: input.validFrom, correlationId: input.correlationId });
  return { ...result, starBand: band };
}
