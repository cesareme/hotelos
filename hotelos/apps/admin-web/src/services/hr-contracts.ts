// RRHH · plantilla (Tanda RRHH · lote RRHH-8, 2026-09-20) — contratos del
// navegador para las rutas `/hr/*` (apps/api/src/modules/hr/hr.routes.ts) y el
// alta de contrato de `POST /payroll/contracts` (RRHH-2), con el patrón de
// finance-contracts.ts: sin red, sin React, sin `meta` de Vite, cargable con
// node --test. Los tipos wire viven en packages/shared/src/hr-types.ts (recon
// RRHH/recon-delta.md §3.3); aquí van los mensajes por `details.code`, los
// builders de consulta, las etiquetas en español y los cálculos puros que la
// pantalla Plantilla (screens/hr/HrEmployeesScreen.tsx) y su cajón
// (EmployeeDrawer.tsx) solo formatean.
//
// Privacidad: ninguna función de este fichero recibe ni devuelve NIF, NAF,
// correo, teléfono ni IBAN; el listado (`EmployeeSummaryDto`) no los lleva y el
// detalle solo los descifra con `?pii=1` (employeeDetailQuery) bajo la acción
// explícita «Mostrar» del cajón, auditada por el API (HR_PII_READ).

import {
  EMPLOYEE_GENDERS,
  EMPLOYEE_STATUS_LABELS_ES,
  HR_END_REASONS,
  HR_ERROR_MESSAGES_ES,
  HR_PII_FIELDS,
  HR_USALI_DEPARTMENT_LABELS_ES,
  HR_USALI_DEPARTMENTS,
  type AgreementRuleDto,
  type CollectiveAgreementDto,
  type EmployeeContractSummaryDto,
  type EmployeeGender,
  type EmployeeListQueryDto,
  type EmployeeStatus,
  type HrAgreementRuleKey,
  type HrAgreementRuleValues,
  type HrEndReason,
  type HrPiiField,
  type HrUsaliDepartment
} from "@hotelos/shared";
import { compactQuery, financeErrorCode, type FinanceQuery } from "./finance-contracts";

export type {
  AgreementRuleDto,
  CollectiveAgreementDto,
  EmployeeContractSummaryDto,
  EmployeeDetailDto,
  EmployeeGender,
  EmployeeListQueryDto,
  EmployeePiiDto,
  EmployeeStatus,
  EmployeeSummaryDto,
  HrAgreementRuleValues,
  HrEndReason,
  HrPiiField,
  HrUsaliDepartment
} from "@hotelos/shared";

// ---------------------------------------------------------------------------
// Errores (details.code ∈ HR_ERROR_CODES → HR_ERROR_MESSAGES_ES)
// ---------------------------------------------------------------------------

export const HR_ERROR_FALLBACK = "No se pudo completar la operación de RRHH. Inténtalo de nuevo.";

type ErrorLike = { message?: unknown };

/** `details.code` of a typed 4xx of the HR routes, or null. */
export function hrErrorCode(error: unknown): string | null {
  return financeErrorCode(error);
}

/**
 * Spanish message for an HR error: the sentence of HR_ERROR_MESSAGES_ES for
 * `details.code` — except VALIDATION_ERROR, whose API message already names
 * the rejected key —, otherwise the API message, otherwise `fallback`.
 */
export function hrErrorMessage(error: unknown, fallback: string = HR_ERROR_FALLBACK): string {
  const code = hrErrorCode(error);
  const apiMessage = typeof error === "object" && error !== null ? (error as ErrorLike).message : undefined;
  const text = typeof apiMessage === "string" && apiMessage.trim() ? apiMessage.trim() : typeof error === "string" && error.trim() ? error.trim() : null;
  if (code && code !== "VALIDATION_ERROR" && code in HR_ERROR_MESSAGES_ES) return HR_ERROR_MESSAGES_ES[code as keyof typeof HR_ERROR_MESSAGES_ES];
  return text ?? fallback;
}

// ---------------------------------------------------------------------------
// Consultas
// ---------------------------------------------------------------------------

/** Segments of the Plantilla list (CocoaSegmentedControl Activos · Bajas · Fijos discontinuos). */
/** Segments of Plantilla: Activos · Excedencias (status leave, RF-08: a file on leave is reachable again) · Bajas · Fijos discontinuos. */
export const EMPLOYEE_SEGMENTS = ["active", "leave", "inactive", "fixed_discontinuous"] as const;
export type EmployeeSegment = (typeof EMPLOYEE_SEGMENTS)[number];

export const EMPLOYEE_SEGMENT_LABELS_ES: Readonly<Record<EmployeeSegment, string>> = Object.freeze({
  active: "Activos",
  leave: "Excedencias",
  inactive: "Bajas",
  fixed_discontinuous: "Fijos discontinuos"
});

export const EMPLOYEE_SEGMENT_OPTIONS: ReadonlyArray<{ value: EmployeeSegment; label: string }> = Object.freeze(
  EMPLOYEE_SEGMENTS.map((value) => ({ value, label: EMPLOYEE_SEGMENT_LABELS_ES[value] }))
);

export function isEmployeeSegment(value: string): value is EmployeeSegment {
  return (EMPLOYEE_SEGMENTS as readonly string[]).includes(value);
}

/** Query fragment of a segment: Activos = status active; Excedencias = status leave; Bajas = status inactive; Fijos discontinuos = contract flag (any status). */
export function employeeSegmentQuery(segment: EmployeeSegment): Pick<EmployeeListQueryDto, "status" | "fixedDiscontinuous"> {
  if (segment === "active") return { status: "active" };
  if (segment === "leave") return { status: "leave" };
  if (segment === "inactive") return { status: "inactive" };
  return { fixedDiscontinuous: true };
}

/** GET /hr/employees — never a NIF: the API searches by name, surname or employee number only. */
export function employeeListQuery(input: EmployeeListQueryDto = {}): FinanceQuery {
  const search = typeof input.search === "string" ? input.search.trim() : "";
  return compactQuery({
    propertyId: input.propertyId ?? undefined,
    legalEntityId: input.legalEntityId ?? undefined,
    status: input.status ?? undefined,
    fixedDiscontinuous: input.fixedDiscontinuous === true ? true : input.fixedDiscontinuous === false ? false : undefined,
    search: search.length > 0 ? search.slice(0, 120) : undefined
  });
}

/** GET /hr/employees/:id — `pii=1` only under the explicit «Mostrar» (audited HR_PII_READ); nothing otherwise. */
export function employeeDetailQuery(pii: boolean): FinanceQuery {
  return pii ? { pii: "1" } : {};
}

/** GET /hr/agreements/:id/rules?asOf — the version in force on the contract start date. */
export function agreementRulesQuery(asOf: string | null | undefined): FinanceQuery {
  return compactQuery({ asOf: asOf ?? undefined });
}

// ---------------------------------------------------------------------------
// Etiquetas en español
// ---------------------------------------------------------------------------

export type HrBadgeTone = "success" | "warning" | "danger" | "info" | "neutral";

export const EMPLOYEE_STATUS_TONES: Readonly<Record<EmployeeStatus, HrBadgeTone>> = Object.freeze({
  active: "success",
  inactive: "neutral",
  leave: "warning"
});

export function employeeStatusBadge(status: EmployeeStatus | string): { label: string; tone: HrBadgeTone } {
  if (status in EMPLOYEE_STATUS_LABELS_ES) {
    const key = status as EmployeeStatus;
    return { label: EMPLOYEE_STATUS_LABELS_ES[key], tone: EMPLOYEE_STATUS_TONES[key] };
  }
  return { label: status, tone: "neutral" };
}

export const HR_END_REASON_LABELS_ES: Readonly<Record<HrEndReason, string>> = Object.freeze({
  end_of_term: "Fin de contrato",
  resignation: "Baja voluntaria",
  probation: "No superación del periodo de prueba",
  dismissal_objective: "Despido objetivo",
  dismissal_disciplinary: "Despido disciplinario",
  mutual_agreement: "Mutuo acuerdo",
  retirement: "Jubilación",
  other: "Otra causa"
});

export const HR_END_REASON_OPTIONS: ReadonlyArray<{ value: string; label: string }> = Object.freeze([
  { value: "", label: "Sin especificar" },
  ...HR_END_REASONS.map((value) => ({ value, label: HR_END_REASON_LABELS_ES[value] }))
]);

export function endReasonLabel(reason: string | null | undefined): string | null {
  if (!reason) return null;
  return reason in HR_END_REASON_LABELS_ES ? HR_END_REASON_LABELS_ES[reason as HrEndReason] : reason;
}

export const HR_GENDER_LABELS_ES: Readonly<Record<EmployeeGender, string>> = Object.freeze({
  female: "Mujer",
  male: "Hombre",
  other: "Otro",
  undisclosed: "No indicado"
});

export const HR_GENDER_OPTIONS: ReadonlyArray<{ value: string; label: string }> = Object.freeze([
  { value: "", label: "Sin indicar" },
  ...EMPLOYEE_GENDERS.map((value) => ({ value, label: HR_GENDER_LABELS_ES[value] }))
]);

/** «Sin departamento» first (a real none choice), then the USALI labor departments in the shared order. */
export const HR_USALI_DEPARTMENT_OPTIONS: ReadonlyArray<{ value: string; label: string }> = Object.freeze([
  { value: "", label: "Sin departamento" },
  ...HR_USALI_DEPARTMENTS.map((value) => ({ value, label: HR_USALI_DEPARTMENT_LABELS_ES[value] }))
]);

export function usaliDepartmentLabel(department: HrUsaliDepartment | string | null | undefined): string | null {
  if (!department) return null;
  return department in HR_USALI_DEPARTMENT_LABELS_ES ? HR_USALI_DEPARTMENT_LABELS_ES[department as HrUsaliDepartment] : department;
}

/** Labels of the encrypted fields, in the order the detail paints them. */
export const HR_PII_FIELD_LABELS_ES: Readonly<Record<HrPiiField, string>> = Object.freeze({
  taxId: "NIF / NIE",
  socialSecurityNumber: "Número de afiliación (NAF)",
  email: "Correo electrónico",
  phone: "Teléfono",
  iban: "IBAN"
});

export const HR_PII_FIELD_ORDER: readonly HrPiiField[] = HR_PII_FIELDS;

/** Employment modalities of EmploymentContract.contractType (payroll-commissions.schemas.ts PAYROLL_CONTRACT_TYPES), in Spanish. */
export const HR_CONTRACT_TYPE_LABELS_ES: Readonly<Record<string, string>> = Object.freeze({
  indefinido: "Indefinido",
  temporal: "Temporal",
  fijo_discontinuo: "Fijo discontinuo",
  practicas: "Prácticas",
  formacion: "Formación",
  sustitucion: "Sustitución"
});

export const HR_CONTRACT_TYPES = Object.freeze(Object.keys(HR_CONTRACT_TYPE_LABELS_ES)) as readonly string[];

export const HR_CONTRACT_TYPE_OPTIONS: ReadonlyArray<{ value: string; label: string }> = Object.freeze(
  HR_CONTRACT_TYPES.map((value) => ({ value, label: HR_CONTRACT_TYPE_LABELS_ES[value]! }))
);

export function contractTypeLabel(contractType: string | null | undefined): string {
  if (!contractType) return "Sin contrato";
  return HR_CONTRACT_TYPE_LABELS_ES[contractType] ?? contractType;
}

/** Grupos de cotización del régimen general (1-11), como los nombra la TGSS. */
export const CONTRIBUTION_GROUP_LABELS_ES: Readonly<Record<number, string>> = Object.freeze({
  1: "Ingenieros, licenciados y alta dirección",
  2: "Ingenieros técnicos, peritos y ayudantes titulados",
  3: "Jefes administrativos y de taller",
  4: "Ayudantes no titulados",
  5: "Oficiales administrativos",
  6: "Subalternos",
  7: "Auxiliares administrativos",
  8: "Oficiales de primera y segunda",
  9: "Oficiales de tercera y especialistas",
  10: "Peones",
  11: "Trabajadores menores de 18 años"
});

export const CONTRIBUTION_GROUP_OPTIONS: ReadonlyArray<{ value: string; label: string }> = Object.freeze([
  { value: "", label: "Sin indicar" },
  ...Object.entries(CONTRIBUTION_GROUP_LABELS_ES).map(([group, label]) => ({ value: group, label: `Grupo ${group} · ${label}` }))
]);

export function contributionGroupLabel(group: number | null | undefined): string | null {
  if (group === null || group === undefined) return null;
  const label = CONTRIBUTION_GROUP_LABELS_ES[group];
  return label ? `Grupo ${group} · ${label}` : `Grupo ${group}`;
}

// ---------------------------------------------------------------------------
// Formato de cifras del contrato (puro: Intl es-ES; el screen no recalcula)
// ---------------------------------------------------------------------------

const hoursFormat = new Intl.NumberFormat("es-ES", { maximumFractionDigits: 2 });
const pctFormat = new Intl.NumberFormat("es-ES", { maximumFractionDigits: 2 });

function decimalOf(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const parsed = typeof value === "number" ? value : Number(String(value).replace(",", "."));
  return Number.isFinite(parsed) ? parsed : null;
}

/** «40.00» → «40 h»; null → null. */
export function hoursLabel(value: string | number | null | undefined): string | null {
  const parsed = decimalOf(value);
  return parsed === null ? null : `${hoursFormat.format(parsed)} h`;
}

/** «62.50» → «62,5 %»; null → null. */
export function pctLabel(value: string | number | null | undefined): string | null {
  const parsed = decimalOf(value);
  return parsed === null ? null : `${pctFormat.format(parsed)} %`;
}

/**
 * Column «Contrato / jornada» of the list: modality · weekly hours · % of
 * full time (only when partial) · «FD» for a fixed-discontinuous contract;
 * «Sin contrato» when the file has no active contract.
 */
export function contractSummaryLabel(contract: Pick<EmployeeContractSummaryDto, "contractType" | "weeklyHours" | "partTimePct" | "fixedDiscontinuous"> | null | undefined): string {
  if (!contract) return "Sin contrato";
  const parts = [contractTypeLabel(contract.contractType)];
  const hours = hoursLabel(contract.weeklyHours);
  if (hours) parts.push(hours);
  const pct = decimalOf(contract.partTimePct);
  if (pct !== null && pct < 100) parts.push(pctLabel(pct)!);
  if (contract.fixedDiscontinuous && contract.contractType !== "fijo_discontinuo") parts.push("FD");
  return parts.join(" · ");
}

// ---------------------------------------------------------------------------
// Vencimientos
// ---------------------------------------------------------------------------

/** Window of the «Vencimiento» column and of the panel («Vencimientos 30 días»). */
export const CONTRACT_EXPIRY_WINDOW_DAYS = 30;

const DAY_MS = 86_400_000;

/** Whole days from `today` (YYYY-MM-DD) to `iso` (YYYY-MM-DD); null when either is not a date. */
export function daysUntil(iso: string | null | undefined, today: string): number | null {
  if (!iso) return null;
  const target = Date.parse(`${iso}T00:00:00Z`);
  const base = Date.parse(`${today}T00:00:00Z`);
  if (Number.isNaN(target) || Number.isNaN(base)) return null;
  return Math.round((target - base) / DAY_MS);
}

export type ContractExpiry = { days: number; tone: HrBadgeTone; label: string };

/**
 * Expiry cue of a contract end date: `danger` once expired, `warning` within
 * the window, `neutral` further away; null without an end date (indefinite).
 */
export function contractExpiry(contractEndsAt: string | null | undefined, today: string, windowDays: number = CONTRACT_EXPIRY_WINDOW_DAYS): ContractExpiry | null {
  const days = daysUntil(contractEndsAt, today);
  if (days === null) return null;
  if (days < 0) return { days, tone: "danger", label: "Vencido" };
  if (days === 0) return { days, tone: "danger", label: "Vence hoy" };
  if (days <= windowDays) return { days, tone: "warning", label: days === 1 ? "Vence mañana" : `Vence en ${days} días` };
  return { days, tone: "neutral", label: `Vence en ${days} días` };
}

// ---------------------------------------------------------------------------
// Convenio → valores por defecto del contrato
// ---------------------------------------------------------------------------

/**
 * Jornada semanal de referencia a tiempo completo (ET art. 34.1: 40 horas de
 * promedio anual; los convenios de hostelería fijan la jornada ANUAL —
 * `annual_hours` — y el cómputo semanal ordinario es el máximo legal).
 */
export const HR_FULL_TIME_WEEKLY_HOURS = 40;

/** Monthly pays + the extra pays of the agreement (mirror of agreements.service.ts payCountFromRules): 14 without agreement. */
export function payCountFromRules(rules: Partial<HrAgreementRuleValues> | null | undefined): number {
  const extra = rules?.extra_pay_count;
  if (typeof extra !== "number" || !Number.isFinite(extra)) return 14;
  return 12 + Math.max(0, Math.round(extra));
}

/** The values in force of GET /hr/agreements/:id/rules, keyed by rule. */
export function ruleValuesFrom(rules: readonly Pick<AgreementRuleDto, "key" | "value">[]): Partial<HrAgreementRuleValues> {
  const out: Partial<Record<HrAgreementRuleKey, unknown>> = {};
  for (const rule of rules) out[rule.key] = rule.value;
  return out as Partial<HrAgreementRuleValues>;
}

export type ContractDefaults = {
  payCount: number;
  weeklyHours: number;
  annualHours: number | null;
  vacationDays: number | null;
};

/** What the agreement fills in the contract form: pays, weekly hours (full time) and the annual hours / vacation days it explains. */
export function contractDefaultsFromRules(rules: Partial<HrAgreementRuleValues> | null | undefined): ContractDefaults {
  const annual = rules?.annual_hours;
  const vacation = rules?.vacation_days;
  return {
    payCount: payCountFromRules(rules),
    weeklyHours: HR_FULL_TIME_WEEKLY_HOURS,
    annualHours: typeof annual === "number" && Number.isFinite(annual) ? annual : null,
    vacationDays: typeof vacation === "number" && Number.isFinite(vacation) ? vacation : null
  };
}

/** Options of the «Convenio» select: the centre's agreement first (a real none choice), then code · name. */
export function agreementOptions(agreements: readonly Pick<CollectiveAgreementDto, "id" | "code" | "name">[]): Array<{ value: string; label: string }> {
  return [
    { value: "", label: "El del centro de trabajo" },
    ...[...agreements].sort((a, b) => a.code.localeCompare(b.code, "es")).map((agreement) => ({ value: agreement.id, label: `${agreement.code} · ${agreement.name}` }))
  ];
}

export function agreementLabel(agreements: readonly Pick<CollectiveAgreementDto, "id" | "code">[], agreementId: string | null | undefined, agreementCode?: string | null): string {
  if (agreementCode) return agreementCode;
  if (!agreementId) return "Del centro";
  return agreements.find((agreement) => agreement.id === agreementId)?.code ?? agreementId;
}
