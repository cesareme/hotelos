// RRHH · previsión de plantilla, estándares, plantilla máxima, KPIs y alertas
// (Tanda RRHH · RRHH-9). Cliente tipado de las rutas `/hr/*` que consumen
// HrForecastScreen y HrOverviewScreen (apps/api/src/modules/hr/hr.routes.ts;
// contrato packages/shared/src/hr-types.ts; recon RRHH/recon-delta.md §3.6):
//
//   GET  /hr/properties/:propertyId/standards?at                    listLaborStandards          workforce.read
//   PUT  /hr/properties/:propertyId/standards { validFrom?, standards[] }   putLaborStandards   hr.standards.manage
//   POST /hr/properties/:propertyId/standards/reset-defaults { validFrom? }  resetLaborStandardDefaults (HR_STANDARD_DEFAULTS por estrellas)
//   GET  /hr/properties/:propertyId/staffing-plans?year             listStaffingPlans           workforce.read
//   POST /hr/properties/:propertyId/staffing-plans { year, season, fromMonth, toMonth, lines[] }   createStaffingPlan (201; borrador)   hr.standards.manage
//   POST /hr/properties/:propertyId/staffing-plans/:id/approve      approveStaffingPlan (SoD: 409 APPROVAL_SELF_DECISION)   hr.staffing.approve
//   POST /hr/properties/:propertyId/labor-forecast/generate { from, to }   generateLaborForecast (único escritor; ≤ 92 días)   workforce.schedule.manage
//   GET  /hr/properties/:propertyId/labor-forecast?from&to          listLaborForecast           workforce.read
//   GET  /hr/kpis?propertyId&period                                 getHrKpis (sin propertyId = centros en ámbito)   workforce.labor_cost.view
//   GET  /hr/alerts?propertyId                                      listHrAlerts                workforce.read
//
// Los errores llegan como `details.code` (HR_ERROR_CODES) y se traducen aquí
// (hrForecastErrorMessage); las cifras no disponibles llegan como `null` más
// una entrada en `degraded[]` (nunca un 0 inventado). Nunca `fetch` directo:
// todo pasa por apiRequest (cabecera de propiedad activa, 401 → login).

import type {
  HrAlertDto,
  HrDegradedEntry,
  HrKpisDto,
  HrUsaliDepartment,
  LaborForecastDayDto,
  LaborStandardBand,
  LaborStandardDriver,
  LaborStandardDto,
  LaborStandardSource,
  LaborStandardUnit,
  StaffingPlanDto,
  StaffingSeason
} from "@hotelos/shared";
import { apiRequest } from "./api-client";

export type { HrAlertDto, HrDegradedEntry, HrKpisDto, LaborForecastDayDto, LaborStandardDto, StaffingPlanDto };

// ---------------------------------------------------------------------------
// Respuestas (espejo de los servicios de apps/api/src/modules/hr)
// ---------------------------------------------------------------------------

export type ForecastWindowQuery = { from: string; to: string };

export type LaborForecastListResponse = {
  propertyId: string;
  from: string;
  to: string;
  rows: LaborForecastDayDto[];
  degraded: HrDegradedEntry[];
};

export type LaborForecastGenerateResponse = LaborForecastListResponse & {
  generatedAt: string;
  days: number;
  written: number;
  deleted: number;
  degradedDays: number;
  annualHours: number;
  annualHoursSource: "agreement" | "default";
  costPeriodCode: string | null;
  warnings: string[];
};

export type HrStarBand = 2 | 3 | 4;

export type LaborStandardsResponse = {
  propertyId: string;
  at: string;
  standards: LaborStandardDto[];
  starBand: HrStarBand;
};

export type LaborStandardInput = {
  usaliDepartment: HrUsaliDepartment;
  driver: LaborStandardDriver;
  unit: LaborStandardUnit;
  /** Decimal como texto («32», «13.067»). */
  value: string;
  bands?: LaborStandardBand[] | null;
  allowancePct?: string | null;
  coverageFactor?: string | null;
  source?: LaborStandardSource | null;
};

export type LaborStandardsPutBody = { validFrom?: string; standards: LaborStandardInput[] };

export type LaborStandardsWriteResponse = {
  propertyId: string;
  validFrom: string;
  standards: LaborStandardDto[];
  written: number;
  closed: number;
  /** Solo en reset-defaults. */
  starBand?: HrStarBand;
};

export type StaffingPlansResponse = { propertyId: string; plans: StaffingPlanDto[] };

export type StaffingPlanCreateBody = {
  year: number;
  season: StaffingSeason;
  fromMonth: number;
  toMonth: number;
  lines: Array<{ usaliDepartment: HrUsaliDepartment; maxFte: string | number; maxHeadcount?: number | null; budgetMonthlyCost?: string | number | null }>;
};

export type HrAlertsResponse = {
  propertyId: string;
  from: string;
  to: string;
  alerts: HrAlertDto[];
  degraded: HrDegradedEntry[];
};

export type HrKpisQueryInput = { propertyId?: string | null; period?: string | null };

// ---------------------------------------------------------------------------
// Rutas y consultas (puras; las pantallas las pasan a useApiData)
// ---------------------------------------------------------------------------

export function laborForecastPath(propertyId: string): string {
  return `/hr/properties/${encodeURIComponent(propertyId)}/labor-forecast`;
}

export function laborStandardsPath(propertyId: string): string {
  return `/hr/properties/${encodeURIComponent(propertyId)}/standards`;
}

export function staffingPlansPath(propertyId: string): string {
  return `/hr/properties/${encodeURIComponent(propertyId)}/staffing-plans`;
}

/** `{ from, to }` tal cual (el API exige ambos, YYYY-MM-DD). */
export function laborForecastQuery(window: ForecastWindowQuery): Record<string, string> {
  return { from: window.from, to: window.to };
}

/** Consulta de KPIs sin claves vacías (`propertyId` ausente = toda la organización en ámbito). */
export function hrKpisQuery(input: HrKpisQueryInput = {}): Record<string, string | undefined> {
  return {
    propertyId: input.propertyId ?? undefined,
    period: input.period ?? undefined
  };
}

// ---------------------------------------------------------------------------
// Lecturas
// ---------------------------------------------------------------------------

export async function listLaborForecast(propertyId: string, window: ForecastWindowQuery): Promise<LaborForecastListResponse> {
  return apiRequest<LaborForecastListResponse>(laborForecastPath(propertyId), { query: laborForecastQuery(window) });
}

export async function listLaborStandards(propertyId: string, at?: string): Promise<LaborStandardsResponse> {
  return apiRequest<LaborStandardsResponse>(laborStandardsPath(propertyId), { query: { at } });
}

export async function listStaffingPlans(propertyId: string, year?: number): Promise<StaffingPlansResponse> {
  return apiRequest<StaffingPlansResponse>(staffingPlansPath(propertyId), { query: { year } });
}

export async function getHrKpis(input: HrKpisQueryInput = {}): Promise<HrKpisDto> {
  return apiRequest<HrKpisDto>("/hr/kpis", { query: hrKpisQuery(input) });
}

export async function listHrAlerts(propertyId: string): Promise<HrAlertsResponse> {
  return apiRequest<HrAlertsResponse>("/hr/alerts", { query: { propertyId } });
}

// ---------------------------------------------------------------------------
// Escrituras
// ---------------------------------------------------------------------------

/** Único escritor de LaborForecast: recalcula la ventana (≤ 92 días) y devuelve las filas ya persistidas. */
export async function generateLaborForecast(propertyId: string, window: ForecastWindowQuery): Promise<LaborForecastGenerateResponse> {
  return apiRequest<LaborForecastGenerateResponse>(`${laborForecastPath(propertyId)}/generate`, { method: "POST", body: { from: window.from, to: window.to } });
}

/** Cierra las versiones vigentes y escribe las nuevas desde `validFrom` (hoy por defecto); nunca borra. */
export async function putLaborStandards(propertyId: string, body: LaborStandardsPutBody): Promise<LaborStandardsWriteResponse> {
  return apiRequest<LaborStandardsWriteResponse>(laborStandardsPath(propertyId), { method: "PUT", body });
}

/** Valores del sector por estrellas del centro (HR_STANDARD_DEFAULTS · Property.starRating). */
export async function resetLaborStandardDefaults(propertyId: string, validFrom?: string): Promise<LaborStandardsWriteResponse> {
  return apiRequest<LaborStandardsWriteResponse>(`${laborStandardsPath(propertyId)}/reset-defaults`, { method: "POST", body: validFrom ? { validFrom } : {} });
}

/** Crea o reescribe el borrador (año × temporada); un plan aprobado no se reescribe (409). */
export async function createStaffingPlan(propertyId: string, body: StaffingPlanCreateBody): Promise<StaffingPlanDto> {
  return apiRequest<StaffingPlanDto>(staffingPlansPath(propertyId), { method: "POST", body });
}

/** Aprobación con separación de funciones: quien preparó la versión no la aprueba (409 APPROVAL_SELF_DECISION). */
export async function approveStaffingPlan(propertyId: string, planId: string): Promise<StaffingPlanDto> {
  return apiRequest<StaffingPlanDto>(`${staffingPlansPath(propertyId)}/${encodeURIComponent(planId)}/approve`, { method: "POST", body: {} });
}

// ---------------------------------------------------------------------------
// Errores: mensajes propios por `details.code` (hr-errors de RRHH-6)
// ---------------------------------------------------------------------------

export const HR_FORECAST_ERROR_MESSAGES_ES: Readonly<Record<string, string>> = Object.freeze({
  VALIDATION_ERROR: "Revisa los campos marcados.",
  PROPERTY_NOT_FOUND: "No se encuentra el centro o no está en tu ámbito.",
  HR_STANDARD_INVALID: "El estándar de dotación no es válido: revisa el valor, la unidad y los tramos.",
  HR_STAFFING_PLAN_NOT_FOUND: "No se encuentra el plan de plantilla.",
  HR_STAFFING_PLAN_ALREADY_APPROVED: "El plan de plantilla ya está aprobado.",
  APPROVAL_SELF_DECISION: "Quien preparó el plan no puede aprobarlo: pídeselo a dirección.",
  HR_INVALID_TRANSITION: "El plan ya no admite ese cambio.",
  INVALID_TRANSITION: "La solicitud ya fue decidida.",
  HR_AGREEMENT_NOT_FOUND: "No se encuentra el convenio del centro.",
  ENTITY_SCOPE_REQUIRED: "Necesitas ámbito de sociedad para ver toda la organización."
});

export const HR_FORECAST_ERROR_FALLBACK = "No se pudo completar la operación. Inténtalo de nuevo.";
export const HR_FORECAST_FORBIDDEN = "No tienes permiso para esta acción en el centro.";

type ErrorLike = { message?: unknown; details?: unknown; status?: unknown };

function errorLike(error: unknown): ErrorLike | null {
  return typeof error === "object" && error !== null ? (error as ErrorLike) : null;
}

/** `details.code` de un 4xx tipado del API (ApiError o cualquier `{ details: { code } }`), o null. */
export function hrForecastErrorCode(error: unknown): string | null {
  const details = errorLike(error)?.details;
  const code = typeof details === "object" && details !== null ? (details as { code?: unknown }).code : null;
  return typeof code === "string" && code.length > 0 ? code : null;
}

/** Mensaje en español: el del código; si no, el 403 de permisos; si no, el del API; si no, `fallback`. */
export function hrForecastErrorMessage(error: unknown, fallback: string = HR_FORECAST_ERROR_FALLBACK): string {
  const code = hrForecastErrorCode(error);
  if (code && HR_FORECAST_ERROR_MESSAGES_ES[code]) return HR_FORECAST_ERROR_MESSAGES_ES[code];
  const like = errorLike(error);
  if (like?.status === 403) return HR_FORECAST_FORBIDDEN;
  if (typeof like?.message === "string" && like.message.trim()) return like.message.trim();
  if (typeof error === "string" && error.trim()) return error.trim();
  return fallback;
}
