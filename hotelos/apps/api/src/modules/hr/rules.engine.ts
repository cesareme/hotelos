// Tanda RRHH (RRHH-4 · diseño §8 «Cumplimiento laboral como reglas evaluables»):
// motor de reglas PURO (sin Prisma, sin fechas del sistema) sobre turnos de una
// persona. El almacén del motor genérico (advanced-record-store.ts) lo invoca
// al crear un turno y devuelve el resultado en `warnings`: las reglas AVISAN,
// nunca bloquean (el bloqueo al publicar cuadrante — SchedulePeriod — queda
// fuera de esta tanda).
//
// Reglas (HR_RULE_KEYS de packages/shared/src/hr-types.ts):
//   · rest_between_shifts · descanso mínimo entre jornadas (ET 34.3: 12 h);
//   · max_daily_hours     · tope diario del convenio (ET 34.3: 9 h; Asturias y
//                           Madrid 8 h) sobre las horas del día de inicio;
//   · weekly_rest         · descanso semanal continuo (ET 37.1: 1,5 días;
//                           Asturias/Cantabria/Madrid 2 días) por semana ISO;
//   · overtime_annual     · horas extra al año (ET 35.2: 80 h) = horas
//                           planificadas − jornada anual proporcional a la
//                           jornada del contrato.
// Umbral de plantilla (RD 901/2020 art. 3): `headcountThreshold` cuenta a las
// personas activas (parciales = 1) más una por cada 100 días (o fracción)
// trabajados por contratos temporales extinguidos en los 6 meses anteriores;
// ≥ 50 activa plan de igualdad, auditoría retributiva, canal de denuncias y
// comité (LAB-007/LAB-008 del Centro de cumplimiento).
//
// Los valores llegan como `Partial<RuleSet>` (AgreementRule.valueJson del
// convenio del contrato o de la propiedad); lo que falte toma el defecto del
// Estatuto de los Trabajadores. Las fechas se tratan en UTC (los turnos se
// guardan en UTC; el día y la semana se calculan sobre esa base).

import type { HrRuleKey } from "@hotelos/shared";
import { HR_HEADCOUNT_THRESHOLD } from "@hotelos/shared";

export type RuleShift = {
  id?: string;
  startAt: string | Date;
  endAt: string | Date;
};

/** Contrato de la persona: jornada semanal (h) o % de jornada; ambos ausentes = jornada completa. */
export type RuleContract = {
  weeklyHours?: number | null;
  partTimePct?: number | null;
};

/** Reglas evaluables (claves de AgreementRule; ver HR_AGREEMENT_RULE_KEYS). */
export type RuleSet = {
  annual_hours: number;
  max_daily_hours: number;
  rest_between_shifts_h: number;
  weekly_rest_days: number;
  overtime_max_year: number;
};

/** Defectos del Estatuto de los Trabajadores cuando el convenio no fija la regla. */
export const ET_DEFAULT_RULES: Readonly<RuleSet> = Object.freeze({
  annual_hours: 1826,
  max_daily_hours: 9,
  rest_between_shifts_h: 12,
  weekly_rest_days: 1.5,
  overtime_max_year: 80
});

export const HR_RULE_VIOLATION_CODE = "HR_RULE_VIOLATION";

export type RuleViolation = {
  code: typeof HR_RULE_VIOLATION_CODE;
  rule: HrRuleKey;
  severity: "warning";
  /** Mensaje en español para la pantalla. */
  message: string;
  /** Turnos implicados (ids conocidos). */
  shiftIds: string[];
  /** Día (YYYY-MM-DD), semana ISO (YYYY-Www) o año (YYYY) al que se refiere la regla. */
  period: string;
  /** Valor observado (horas) y límite aplicado (horas o días según la regla). */
  value: number;
  limit: number;
};

const FULL_TIME_WEEKLY_HOURS = 40;
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

const toDate = (value: string | Date): Date => (value instanceof Date ? value : new Date(value));
const round1 = (value: number): number => Math.round(value * 10) / 10;
const dayKey = (date: Date): string => date.toISOString().slice(0, 10);

type NormalizedShift = { id: string; start: Date; end: Date; hours: number };

function normalizeShifts(shifts: readonly RuleShift[]): NormalizedShift[] {
  const out: NormalizedShift[] = [];
  for (const shift of shifts) {
    const start = toDate(shift.startAt);
    const end = toDate(shift.endAt);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end.getTime() <= start.getTime()) continue;
    out.push({ id: shift.id ?? "", start, end, hours: (end.getTime() - start.getTime()) / HOUR_MS });
  }
  out.sort((a, b) => a.start.getTime() - b.start.getTime() || a.end.getTime() - b.end.getTime());
  return out;
}

/** Semana ISO (lunes-domingo) del instante, como `YYYY-Www`, y su lunes 00:00 UTC. */
function isoWeekOf(date: Date): { key: string; monday: Date } {
  const day = date.getUTCDay() === 0 ? 7 : date.getUTCDay();
  const monday = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() - (day - 1)));
  const thursday = new Date(monday.getTime() + 3 * DAY_MS);
  const isoYear = thursday.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(isoYear, 0, 4));
  const firstDay = firstThursday.getUTCDay() === 0 ? 7 : firstThursday.getUTCDay();
  const firstMonday = new Date(Date.UTC(isoYear, 0, 4 - (firstDay - 1)));
  const week = Math.floor((monday.getTime() - firstMonday.getTime()) / (7 * DAY_MS)) + 1;
  return { key: `${isoYear}-W${String(week).padStart(2, "0")}`, monday };
}

/** Reglas efectivas: lo que fije el convenio, con el defecto del ET para cada clave ausente o inválida. */
export function resolveRules(partial?: Partial<Record<keyof RuleSet, unknown>> | null): RuleSet {
  const pick = (key: keyof RuleSet): number => {
    const value = partial?.[key];
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : ET_DEFAULT_RULES[key];
  };
  return {
    annual_hours: pick("annual_hours"),
    max_daily_hours: pick("max_daily_hours"),
    rest_between_shifts_h: pick("rest_between_shifts_h"),
    weekly_rest_days: pick("weekly_rest_days"),
    overtime_max_year: pick("overtime_max_year")
  };
}

/** Fracción de jornada del contrato (1 = completa): partTimePct/100 si viene; si no, weeklyHours/40; si no, 1. */
export function contractFraction(contract?: RuleContract | null): number {
  const pct = contract?.partTimePct;
  if (typeof pct === "number" && Number.isFinite(pct) && pct > 0) return Math.min(pct, 100) / 100;
  const weekly = contract?.weeklyHours;
  if (typeof weekly === "number" && Number.isFinite(weekly) && weekly > 0) return Math.min(weekly, FULL_TIME_WEEKLY_HOURS) / FULL_TIME_WEEKLY_HOURS;
  return 1;
}

/**
 * Evalúa los turnos de UNA persona (cualquier orden; los inválidos se ignoran)
 * contra las reglas y devuelve las infracciones como avisos. Sin turnos, sin
 * avisos. Cada aviso lleva los ids de los turnos implicados para que la
 * pantalla los señale.
 */
export function evaluateShifts(shifts: readonly RuleShift[], contract?: RuleContract | null, rules?: Partial<Record<keyof RuleSet, unknown>> | null): RuleViolation[] {
  const effective = resolveRules(rules);
  const rows = normalizeShifts(shifts);
  if (rows.length === 0) return [];
  const violations: RuleViolation[] = [];

  // rest_between_shifts: hueco entre el fin de un turno y el inicio del siguiente.
  for (let i = 1; i < rows.length; i += 1) {
    const prev = rows[i - 1]!;
    const next = rows[i]!;
    const gap = (next.start.getTime() - prev.end.getTime()) / HOUR_MS;
    if (gap < effective.rest_between_shifts_h) {
      violations.push({
        code: HR_RULE_VIOLATION_CODE,
        rule: "rest_between_shifts",
        severity: "warning",
        message: `Descanso entre jornadas de ${round1(Math.max(gap, 0))} h (mínimo ${effective.rest_between_shifts_h} h).`,
        shiftIds: [prev.id, next.id].filter(Boolean),
        period: dayKey(next.start),
        value: round1(Math.max(gap, 0)),
        limit: effective.rest_between_shifts_h
      });
    }
  }

  // max_daily_hours: horas del día (UTC) en que empieza cada turno.
  const byDay = new Map<string, { hours: number; ids: string[] }>();
  for (const row of rows) {
    const key = dayKey(row.start);
    const bucket = byDay.get(key) ?? { hours: 0, ids: [] };
    bucket.hours += row.hours;
    if (row.id) bucket.ids.push(row.id);
    byDay.set(key, bucket);
  }
  for (const [day, bucket] of byDay) {
    if (bucket.hours > effective.max_daily_hours + 1e-9) {
      violations.push({
        code: HR_RULE_VIOLATION_CODE,
        rule: "max_daily_hours",
        severity: "warning",
        message: `Jornada de ${round1(bucket.hours)} h el ${day} (tope diario ${effective.max_daily_hours} h).`,
        shiftIds: bucket.ids,
        period: day,
        value: round1(bucket.hours),
        limit: effective.max_daily_hours
      });
    }
  }

  // weekly_rest: en cada semana ISO con turnos debe existir un hueco continuo
  // ≥ weekly_rest_days × 24 h entre turnos consecutivos que toque la semana.
  // Un borde sin turno vecino (principio o fin de los datos) se considera
  // descanso desconocido → sin aviso (los avisos no inventan infracciones).
  const requiredRest = effective.weekly_rest_days * 24;
  const weeks = new Map<string, { monday: Date; ids: string[] }>();
  for (const row of rows) {
    const week = isoWeekOf(row.start);
    const bucket = weeks.get(week.key) ?? { monday: week.monday, ids: [] };
    if (row.id) bucket.ids.push(row.id);
    weeks.set(week.key, bucket);
  }
  for (const [key, bucket] of weeks) {
    const weekStart = bucket.monday.getTime();
    const weekEnd = weekStart + 7 * DAY_MS;
    let firstIndex = -1;
    let lastIndex = -1;
    for (let i = 0; i < rows.length; i += 1) {
      const start = rows[i]!.start.getTime();
      if (start >= weekStart && start < weekEnd) {
        if (firstIndex === -1) firstIndex = i;
        lastIndex = i;
      }
    }
    if (firstIndex === -1) continue;
    if (firstIndex === 0 || lastIndex === rows.length - 1) continue; // borde sin vecino: descanso desconocido
    let longest = 0;
    for (let i = firstIndex - 1; i <= lastIndex; i += 1) {
      const gap = (rows[i + 1]!.start.getTime() - rows[i]!.end.getTime()) / HOUR_MS;
      if (gap > longest) longest = gap;
    }
    if (longest < requiredRest) {
      violations.push({
        code: HR_RULE_VIOLATION_CODE,
        rule: "weekly_rest",
        severity: "warning",
        message: `Sin descanso semanal de ${effective.weekly_rest_days} días en la semana ${key} (mayor hueco ${round1(Math.max(longest, 0))} h).`,
        shiftIds: bucket.ids,
        period: key,
        value: round1(Math.max(longest, 0)),
        limit: effective.weekly_rest_days
      });
    }
  }

  // overtime_annual: horas planificadas del año − jornada anual proporcional.
  const fraction = contractFraction(contract);
  const annualLimit = effective.annual_hours * fraction;
  const byYear = new Map<string, { hours: number; ids: string[] }>();
  for (const row of rows) {
    const key = String(row.start.getUTCFullYear());
    const bucket = byYear.get(key) ?? { hours: 0, ids: [] };
    bucket.hours += row.hours;
    if (row.id) bucket.ids.push(row.id);
    byYear.set(key, bucket);
  }
  for (const [year, bucket] of byYear) {
    const overtime = bucket.hours - annualLimit;
    if (overtime > effective.overtime_max_year + 1e-9) {
      violations.push({
        code: HR_RULE_VIOLATION_CODE,
        rule: "overtime_annual",
        severity: "warning",
        message: `${round1(overtime)} h extra en ${year} sobre una jornada anual de ${round1(annualLimit)} h (máximo ${effective.overtime_max_year} h).`,
        shiftIds: bucket.ids,
        period: year,
        value: round1(overtime),
        limit: effective.overtime_max_year
      });
    }
  }

  return violations;
}

// ---------------------------------------------------------------------------
// Umbral de plantilla (RD 901/2020)
// ---------------------------------------------------------------------------

export type HeadcountEmployee = {
  /** active · inactive · leave (Employee.status). */
  status: string;
  hiredAt?: string | Date | null;
  terminatedAt?: string | Date | null;
  /** Contrato temporal (o fijo discontinuo inactivo): cuenta por días trabajados si se extinguió en los 6 meses previos. */
  temporary?: boolean;
  /** Informativo: los parciales cuentan como 1 (RD 901/2020 art. 3.1). */
  partTimePct?: number | null;
};

export type HeadcountResult = {
  headcount: number;
  threshold: number;
  reached: boolean;
  /** Personas activas (o en excedencia/IT) = 1 cada una, incluidas las parciales. */
  active: number;
  /** Personas adicionales por temporales extinguidos en los 6 meses previos (100 días o fracción = 1). */
  temporaryTerminated: number;
  asOf: string;
};

const SIX_MONTHS_DAYS = 182;

/**
 * RD 901/2020 art. 3: todas las personas en plantilla a la fecha (parciales = 1)
 * más, por cada contrato temporal extinguido en los 6 meses anteriores, una
 * persona por cada 100 días trabajados o fracción dentro de esos 6 meses.
 */
export function headcountThreshold(employees: readonly HeadcountEmployee[], asOf: string | Date = new Date(), threshold = HR_HEADCOUNT_THRESHOLD): HeadcountResult {
  const at = toDate(asOf);
  const windowStart = new Date(at.getTime() - SIX_MONTHS_DAYS * DAY_MS);
  let active = 0;
  let temporaryTerminated = 0;
  for (const employee of employees) {
    const terminatedAt = employee.terminatedAt ? toDate(employee.terminatedAt) : null;
    const hiredAt = employee.hiredAt ? toDate(employee.hiredAt) : null;
    const terminated = terminatedAt !== null && !Number.isNaN(terminatedAt.getTime()) && terminatedAt.getTime() <= at.getTime();
    const inactive = employee.status === "inactive";
    if (!terminated && !inactive) {
      active += 1;
      continue;
    }
    if (!employee.temporary || !terminatedAt || Number.isNaN(terminatedAt.getTime())) continue;
    if (terminatedAt.getTime() < windowStart.getTime()) continue;
    const from = Math.max(hiredAt && !Number.isNaN(hiredAt.getTime()) ? hiredAt.getTime() : windowStart.getTime(), windowStart.getTime());
    const to = Math.min(terminatedAt.getTime(), at.getTime());
    const days = Math.max(0, Math.ceil((to - from) / DAY_MS));
    if (days > 0) temporaryTerminated += Math.ceil(days / 100);
  }
  const headcount = active + temporaryTerminated;
  return { headcount, threshold, reached: headcount >= threshold, active, temporaryTerminated, asOf: at.toISOString() };
}
