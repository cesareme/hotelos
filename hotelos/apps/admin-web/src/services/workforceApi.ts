// Frontend client for interactive workforce actions (shifts, time clock, absences).
//
// Tanda RRHH · RRHH-10 (recon §3.10 «Personal»; RRHH-4 advanced-record-schemas.ts staffFields):
// the person of a shift or a time-clock entry is ALWAYS a ficha de personal (StaffProfile) of the
// active centre, sent as `{ staffProfileId }`. A free-text alias is no longer accepted by this client:
// the API answers 400 HR_EMPLOYEE_REQUIRED to anything that does not resolve to a ficha, and the
// screen offers a CocoaSelect of fichas.
//
// Corrector RRHH (SEC-02 / RF-01): the fichas come from GET /workforce/properties/:propertyId/staff-profiles
// (workforce.read; no hourly cost nor email), so the operational templates (housekeeper, maintenance, fnb,
// receptionist…) that clock in with workforce.timeclock.use but lack payroll.read can use the screen. The API
// lets a `timeclock.use`-only actor clock ONLY her own ficha (403 HR_TIMECLOCK_SELF_ONLY otherwise) and ignores
// `at` for her (server time); `workforce.timeclock.manage` clocks for others.
//
//   GET  /workforce/properties/:propertyId/staff-profiles                                     workforce.read
//   POST /workforce/time-clock/clock-in|clock-out { propertyId, staffProfileId, action, at }   workforce.timeclock.use
//   POST /workforce/properties/:propertyId/shifts { staffProfileId, role?, startAt, endAt }   workforce.schedule.manage
//     → the record plus `warnings` (rules engine: rest between shifts, daily cap, weekly rest, overtime; never blocks)
//   PATCH /workforce/absences/:id { status: "approved" }                                       workforce.schedule.manage
//     → 409 APPROVAL_SELF_DECISION when the approver is the requester (SoD), 409 HR_INVALID_TRANSITION when decided.
// Errors: `workforceErrorMessage` maps `details.code` (HR_ERROR_MESSAGES_ES of packages/shared/src/hr-types.ts,
// copied here because admin-web imports @hotelos/shared as types only) and falls back to the API message.

import { apiRequest } from "./api-client";
import { getActivePropertyId } from "./activeProperty";
import { financeErrorCode, financeErrorMessage } from "./finance-contracts";

import type { StaffProfileRecord } from "./payrollApi";

/** Ficha of the centre as the workforce list serves it (SEC-02): the payroll record without hourlyCost nor userEmail. */
export type WorkforceStaffProfile = Omit<StaffProfileRecord, "hourlyCost" | "userEmail">;

export function workforceStaffProfilesPath(propertyId: string): string {
  return `/workforce/properties/${encodeURIComponent(propertyId)}/staff-profiles`;
}

/** Fichas of a centre for the time clock and the shift drawer (workforce.read). */
export function listWorkforceStaffProfiles(propertyId = getActivePropertyId()): Promise<WorkforceStaffProfile[]> {
  return apiRequest<WorkforceStaffProfile[]>(workforceStaffProfilesPath(propertyId));
}

/** Mirror of ABSENCE_TYPE_LABELS_ES (packages/shared/src/hr-types.ts): admin-web imports @hotelos/shared as types only. */
export const ABSENCE_TYPE_LABELS_ES: Readonly<Record<string, string>> = Object.freeze({
  vacation: "Vacaciones",
  it_common: "IT enfermedad común",
  it_accident: "IT accidente de trabajo",
  permit_paid: "Permiso retribuido",
  permit_unpaid: "Permiso no retribuido",
  maternity: "Nacimiento y cuidado",
  unjustified: "Ausencia injustificada",
  strike: "Huelga",
  compensatory_rest: "Descanso compensatorio"
});

/** Health absence types (art. 9 RGPD) arrive as `type: null, restricted: true` without hr.employee.read (SEC-07). */
export const ABSENCE_RESTRICTED_LABEL = "Ausencia (tipo reservado)";

export function absenceTypeLabel(type: string | null | undefined, restricted = false): string {
  if (restricted || type === null || type === undefined || type === "") return ABSENCE_RESTRICTED_LABEL;
  return ABSENCE_TYPE_LABELS_ES[type] ?? type;
}

/** Body of a shift: the ficha, the optional role label and the ISO window. */
export type CreateShiftRequest = { staffProfileId: string; role?: string; startAt: string; endAt: string };

/** Warning of the rules engine attached to a created shift (`code` HR_RULE_VIOLATION; never a block). */
export type WorkforceRuleWarning = { code: string; rule: string; severity: "warning"; message: string; shiftIds: string[]; period: string };

/** Board item the advanced-records store answers (payload resolved from the ficha: the name never travels in the body). */
export type WorkforceRecord = { id: string; status?: string; payload?: Record<string, unknown>; warnings?: WorkforceRuleWarning[] };

export function clockIn(staffProfileId: string, propertyId = getActivePropertyId()): Promise<WorkforceRecord> {
  return apiRequest<WorkforceRecord>(`/workforce/time-clock/clock-in`, { method: "POST", body: { propertyId, staffProfileId, action: "in", at: new Date().toISOString() } });
}

export function clockOut(staffProfileId: string, propertyId = getActivePropertyId()): Promise<WorkforceRecord> {
  return apiRequest<WorkforceRecord>(`/workforce/time-clock/clock-out`, { method: "POST", body: { propertyId, staffProfileId, action: "out", at: new Date().toISOString() } });
}

export function createShift(payload: CreateShiftRequest, propertyId = getActivePropertyId()): Promise<WorkforceRecord> {
  const body: CreateShiftRequest = { staffProfileId: payload.staffProfileId, startAt: payload.startAt, endAt: payload.endAt, ...(payload.role?.trim() ? { role: payload.role.trim() } : {}) };
  return apiRequest<WorkforceRecord>(`/workforce/properties/${encodeURIComponent(propertyId)}/shifts`, { method: "POST", body });
}

export function approveAbsence(id: string): Promise<WorkforceRecord> {
  return apiRequest<WorkforceRecord>(`/workforce/absences/${encodeURIComponent(id)}`, { method: "PATCH", body: { status: "approved" } });
}

/** Rule warnings of a created record, in the order the engine returned them (empty when the API sent none). */
export function recordWarnings(record: WorkforceRecord | null | undefined): WorkforceRuleWarning[] {
  return Array.isArray(record?.warnings) ? record.warnings.filter((warning) => typeof warning?.message === "string" && warning.message.trim() !== "") : [];
}

const WORKFORCE_ERROR_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  HR_EMPLOYEE_REQUIRED: "Elige una ficha de personal: los turnos y fichajes ya no admiten nombres libres.",
  HR_EMPLOYEE_NOT_FOUND: "No se encuentra la ficha de personal en este centro.",
  APPROVAL_SELF_DECISION: "Quien solicita no puede aprobar su propia solicitud: otra persona debe decidirla.",
  HR_INVALID_TRANSITION: "La solicitud ya fue decidida.",
  // The generic engine (advanced-record-schemas.ts) spells the same conflict INVALID_TRANSITION (RF-11).
  INVALID_TRANSITION: "La solicitud ya fue decidida.",
  HR_TIMECLOCK_SELF_ONLY: "Solo puedes fichar con tu propia ficha de personal.",
  HR_RULE_VIOLATION: "El cuadrante incumple una regla del convenio o del Estatuto de los Trabajadores.",
  HR_STAFFING_EXCEEDED: "El departamento supera la plantilla máxima aprobada.",
  PROPERTY_NOT_FOUND: "No se encuentra el centro."
});

/** Spanish message for a workforce error: `details.code` first, then the API message, then `fallback`. */
export function workforceErrorMessage(error: unknown, fallback = "No se pudo completar la acción."): string {
  const code = financeErrorCode(error);
  if (code && WORKFORCE_ERROR_MESSAGES[code]) return WORKFORCE_ERROR_MESSAGES[code];
  return financeErrorMessage(error, fallback);
}
