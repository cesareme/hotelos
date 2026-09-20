/**
 * RRHH · plantilla, convenio, estándares, previsión y nómina (Tanda RRHH · RRHH-1, 2026-09-20): contrato
 * wire entre el API (`apps/api/src/modules/hr/*`, `modules/payroll/*`) y el admin-web (pestañas
 * «RRHH y nóminas» de Finanzas y el panel de costes de personal de Dirección en Mi día).
 *
 * Reglas:
 *   · Los LISTADOS nunca llevan PII: `EmployeeSummaryDto` = nombre, número de empleado, centro, puesto,
 *     departamento USALI, estado y contrato vigente. El DETALLE (`EmployeeDetailDto`) solo descifra los
 *     campos que el ámbito permite (`piiFields`) y cuando se piden explícitamente (`pii` = null si no se
 *     pidió); cada lectura de PII se audita (`HR_PII_READ`). Nunca NIF ni IBAN en URL, logs ni CSV.
 *   · Dinero como `MoneyString` ("1234.56"), FTE y horas como cadena de dos decimales (`HeadcountString`),
 *     ratios y porcentajes como `RatioString`; fechas "YYYY-MM-DD" (`IsoDate`), meses "YYYY-MM"
 *     (`PeriodCode`), instantes `…At` en ISO. El API calcula con Prisma.Decimal; el front solo formatea.
 *   · Cifras no disponibles → `null` + entrada en `degraded[]`; nunca un 0 inventado (DegradedValue).
 *   · Vocabularios como `as const` + tipo derivado: el API los usa en zod, el front en selectores.
 *   · Datos de personas reales: ninguno en este fichero ni en sus tests; los valores por defecto de
 *     convenios y estándares son parámetros públicos (docs/design/RRHH-PLANTILLA-NOMINA.md §2.3 y §6).
 *
 * Diseño: docs/design/RRHH-PLANTILLA-NOMINA.md §4 (modelo), §5 (motor), §6 (parametrización), §7
 * (nómina), §9 (API y privacidad); panel: docs/design/PANEL-COSTES-DIRECCION.md §8.
 */

import type { IsoDate, MoneyString, RatioString, UsaliDepartmentKey } from "./financial-statements-types.js";
import type { HeadcountString } from "./payroll-cost-types.js";

/** Mes contable "YYYY-MM". */
export type HrPeriodCode = string;

// ---------------------------------------------------------------------------
// Vocabularios (espejo de los valores documentales del schema; columnas de texto)
// ---------------------------------------------------------------------------

/** Employee.status. */
export const EMPLOYEE_STATUSES = ["active", "inactive", "leave"] as const;
export type EmployeeStatus = (typeof EMPLOYEE_STATUSES)[number];

export const EMPLOYEE_STATUS_LABELS_ES: Record<EmployeeStatus, string> = {
  active: "Activo",
  inactive: "Baja",
  leave: "Excedencia"
};

/** Employee.gender (registro retributivo RD 902/2020; dato opcional). */
export const EMPLOYEE_GENDERS = ["female", "male", "other", "undisclosed"] as const;
export type EmployeeGender = (typeof EMPLOYEE_GENDERS)[number];

/** Campos PII de Employee cifrados en reposo: espejo de PII_FIELDS.Employee (packages/database/src/crypto-fields.ts). */
export const HR_PII_FIELDS = ["taxId", "socialSecurityNumber", "email", "phone", "iban"] as const;
export type HrPiiField = (typeof HR_PII_FIELDS)[number];

/** Departamentos USALI que admiten personal (subconjunto de UsaliDepartmentKey con línea `labor`). */
export const HR_USALI_DEPARTMENTS = ["rooms", "fnb", "other_operated", "admin_general", "it", "sales_marketing", "pom"] as const satisfies readonly UsaliDepartmentKey[];
export type HrUsaliDepartment = (typeof HR_USALI_DEPARTMENTS)[number];

export const HR_USALI_DEPARTMENT_LABELS_ES: Record<HrUsaliDepartment, string> = {
  rooms: "Habitaciones",
  fnb: "Alimentos y bebidas",
  other_operated: "Otros departamentos operativos",
  admin_general: "Administración y dirección",
  it: "Sistemas",
  sales_marketing: "Comercial y marketing",
  pom: "Mantenimiento"
};

/** LaborForecast.usaliDepartment: un departamento o la fila agregada heredada ("all"). */
export type LaborForecastDepartment = HrUsaliDepartment | "all";

/** Causa de fin de contrato / baja (EmploymentContract.endReason, Employee.terminationReason). */
export const HR_END_REASONS = [
  "end_of_term",
  "resignation",
  "probation",
  "dismissal_objective",
  "dismissal_disciplinary",
  "mutual_agreement",
  "retirement",
  "other"
] as const;
export type HrEndReason = (typeof HR_END_REASONS)[number];

/** AbsenceRequest.absenceType tasado (diseño §4). IT y maternidad son datos de salud: el cuadrante muestra «ausente». */
export const ABSENCE_TYPES = [
  "vacation",
  "it_common",
  "it_accident",
  "permit_paid",
  "permit_unpaid",
  "maternity",
  "unjustified",
  "strike",
  "compensatory_rest"
] as const;
export type AbsenceType = (typeof ABSENCE_TYPES)[number];

export const ABSENCE_TYPE_LABELS_ES: Record<AbsenceType, string> = {
  vacation: "Vacaciones",
  it_common: "IT enfermedad común",
  it_accident: "IT accidente de trabajo",
  permit_paid: "Permiso retribuido",
  permit_unpaid: "Permiso no retribuido",
  maternity: "Nacimiento y cuidado",
  unjustified: "Ausencia injustificada",
  strike: "Huelga",
  compensatory_rest: "Descanso compensatorio"
};

/** Tipos de ausencia que constituyen datos de salud (art. 9 RGPD): solo visibles con hr.employee.read. */
export const ABSENCE_HEALTH_TYPES: readonly AbsenceType[] = ["it_common", "it_accident", "maternity"];

/** AbsenceRequest.status. */
export const ABSENCE_STATUSES = ["pending", "approved", "rejected", "cancelled"] as const;
export type AbsenceStatus = (typeof ABSENCE_STATUSES)[number];

/** Códigos de convenio parametrizados por defecto (CollectiveAgreement.code). */
export const HR_AGREEMENT_CODES = ["ES-15-HOST", "ES-33-HOST", "ES-39-HOST", "ES-28-HOSP"] as const;
export type HrAgreementCode = (typeof HR_AGREEMENT_CODES)[number];

/** AgreementRule.key (diseño §4 · AgreementRule). */
export const HR_AGREEMENT_RULE_KEYS = [
  "annual_hours",
  "max_daily_hours",
  "rest_between_shifts_h",
  "weekly_rest_days",
  "break_minutes",
  "break_counts_as_work",
  "extra_pay_count",
  "extra_pay_months",
  "overtime_pct",
  "overtime_max_day",
  "overtime_max_month",
  "overtime_max_year",
  "night_from",
  "night_to",
  "night_pct_bands",
  "vacation_days",
  "fd_call_notice_days",
  "fd_min_period_days",
  "fd_max_delay_days",
  "it_complement_rules",
  "part_time_min_hours"
] as const;
export type HrAgreementRuleKey = (typeof HR_AGREEMENT_RULE_KEYS)[number];

/** LaborStandard.driver. */
export const LABOR_STANDARD_DRIVERS = [
  "occupied_rooms",
  "departures",
  "stayovers",
  "arrivals",
  "pax",
  "covers_breakfast",
  "covers_restaurant",
  "rooms_inventory",
  "fixed"
] as const;
export type LaborStandardDriver = (typeof LABOR_STANDARD_DRIVERS)[number];

/** LaborStandard.unit. */
export const LABOR_STANDARD_UNITS = ["minutes_per_unit", "units_per_shift", "fte_per_100", "posts_by_band"] as const;
export type LaborStandardUnit = (typeof LABOR_STANDARD_UNITS)[number];

/** LaborStandard.source. */
export const LABOR_STANDARD_SOURCES = ["sector_default", "measured", "agreement"] as const;
export type LaborStandardSource = (typeof LABOR_STANDARD_SOURCES)[number];

/** Tramo de `posts_by_band`: puestos mañana-tarde-noche hasta `maxOccupiedRooms` (null = sin tope). */
export interface LaborStandardBand {
  maxOccupiedRooms: number | null;
  /** [mañana, tarde, noche]; la noche ya incluye al auditor nocturno cuando procede. */
  posts: readonly [number, number, number];
}

/** StaffingPlan.season. */
export const STAFFING_SEASONS = ["high", "shoulder", "low"] as const;
export type StaffingSeason = (typeof STAFFING_SEASONS)[number];

export const STAFFING_SEASON_LABELS_ES: Record<StaffingSeason, string> = {
  high: "Temporada alta",
  shoulder: "Temporada media",
  low: "Temporada baja"
};

/** StaffingPlan.status. */
export const STAFFING_PLAN_STATUSES = ["draft", "approved"] as const;
export type StaffingPlanStatus = (typeof STAFFING_PLAN_STATUSES)[number];

/** LaborForecast.source: origen de los drivers del día. `deterministic` nunca sin OTB corroborante (diseño §1.1). */
export const LABOR_FORECAST_SOURCES = ["otb", "pms_forecast", "deterministic", "actual", "manual"] as const;
export type LaborForecastSource = (typeof LABOR_FORECAST_SOURCES)[number];

/** PayrollPeriod.mode. */
export const PAYROLL_PERIOD_MODES = ["external", "calculated"] as const;
export type PayrollPeriodMode = (typeof PAYROLL_PERIOD_MODES)[number];

export const PAYROLL_PERIOD_MODE_LABELS_ES: Record<PayrollPeriodMode, string> = {
  external: "Modo externo: la gestoría calcula; el ERP importa el agregado",
  calculated: "Modo calculado: preparación interna, validar con la gestoría"
};

/** Alertas calculadas (no persistidas) del panel RRHH y de la previsión (diseño §5). */
export const HR_ALERT_KINDS = [
  "overstaffed",
  "understaffed",
  "over_approved",
  "forecast_degraded",
  "contract_expiring",
  "rule_violation",
  "headcount_threshold"
] as const;
export type HrAlertKind = (typeof HR_ALERT_KINDS)[number];

export const HR_ALERT_SEVERITIES = ["info", "warning", "critical"] as const;
export type HrAlertSeverity = (typeof HR_ALERT_SEVERITIES)[number];

/** Reglas del motor puro `hr/rules.engine.ts` (RRHH-4). */
export const HR_RULE_KEYS = ["rest_between_shifts", "max_daily_hours", "weekly_rest", "overtime_annual"] as const;
export type HrRuleKey = (typeof HR_RULE_KEYS)[number];

/** Umbral de plantilla (RD 901/2020): plan de igualdad, auditoría retributiva, canal de denuncias, comité. */
export const HR_HEADCOUNT_THRESHOLD = 50;

/** Origen de las ventas usadas en los ratios (misma convención que el informe de coste). */
export type HrSalesSource = "ledger" | "reference";

/** Origen de una cifra de coste laboral del panel. */
export type LaborCostSource = "ledger" | "import";

/** Entrada de `degraded[]`: qué falta, dónde y por qué (nunca se sustituye por 0). */
export interface HrDegradedEntry {
  code: string;
  message: string;
  propertyId?: string | null;
  periodCode?: HrPeriodCode | null;
  date?: IsoDate | null;
}

// ---------------------------------------------------------------------------
// Expediente (Employee) — listado sin PII; detalle con PII bajo demanda
// ---------------------------------------------------------------------------

export interface EmployeeContractSummaryDto {
  id: string;
  staffProfileId: string;
  propertyId: string | null;
  contractType: string;
  startDate: IsoDate;
  endDate: IsoDate | null;
  weeklyHours: HeadcountString | null;
  /** 100.00 = jornada completa. */
  partTimePct: RatioString | null;
  fixedDiscontinuous: boolean;
  contributionGroup: number | null;
  agreementId: string | null;
  agreementCode: string | null;
  payCount: number;
  active: boolean;
}

/** Fila del listado de plantilla: NUNCA lleva NIF, NAF, correo, teléfono ni IBAN. */
export interface EmployeeSummaryDto {
  id: string;
  employeeNumber: string;
  firstName: string;
  lastName: string;
  fullName: string;
  legalEntityId: string;
  primaryPropertyId: string | null;
  propertyCode: string | null;
  propertyName: string | null;
  usaliDepartment: HrUsaliDepartment | null;
  jobTitle: string | null;
  status: EmployeeStatus;
  hiredAt: IsoDate;
  terminatedAt: IsoDate | null;
  /** Usuario de la app enlazado (acceso); null si la persona no usa la app. */
  userId: string | null;
  /** Fichas de centro (StaffProfile) enlazadas por employeeId. */
  staffProfileIds: string[];
  /** Contrato activo más reciente, o null. */
  contract: EmployeeContractSummaryDto | null;
  /** Fin del contrato vigente (vencimientos a 30 días), o null si indefinido. */
  contractEndsAt: IsoDate | null;
}

/** PII descifrada campo a campo; `null` = no visible para el ámbito o no solicitado. */
export interface EmployeePiiDto {
  taxId: string | null;
  socialSecurityNumber: string | null;
  email: string | null;
  phone: string | null;
  iban: string | null;
}

export interface EmployeeDetailDto extends EmployeeSummaryDto {
  gender: EmployeeGender | null;
  terminationReason: HrEndReason | string | null;
  contracts: EmployeeContractSummaryDto[];
  /** Campos PII que el ámbito del usuario puede pedir (p. ej. taxId e iban solo payroll_hr / controller / dirección general). */
  piiFields: HrPiiField[];
  /** Solo cuando se pidió (`?pii=1`) y con auditoría HR_PII_READ; null en caso contrario. */
  pii: EmployeePiiDto | null;
  createdAt: string;
  updatedAt: string;
}

export interface EmployeeListQueryDto {
  propertyId?: string | null;
  legalEntityId?: string | null;
  status?: EmployeeStatus | null;
  fixedDiscontinuous?: boolean | null;
  /** Búsqueda por nombre, apellidos o número de empleado (nunca por NIF en el listado). */
  search?: string | null;
}

// ---------------------------------------------------------------------------
// Convenio, reglas y estándares
// ---------------------------------------------------------------------------

export interface CollectiveAgreementDto {
  id: string;
  code: string;
  name: string;
  scope: string | null;
  publishedRef: string | null;
  validFrom: IsoDate;
  validTo: IsoDate | null;
  ultraactivity: boolean;
  rulesCount: number;
  /** Centros con Property.agreementId = id. */
  propertyIds: string[];
}

export interface AgreementRuleDto {
  id: string;
  agreementId: string;
  key: HrAgreementRuleKey;
  value: unknown;
  validFrom: IsoDate;
  validTo: IsoDate | null;
}

export interface LaborStandardDto {
  id: string;
  propertyId: string;
  usaliDepartment: HrUsaliDepartment;
  driver: LaborStandardDriver;
  unit: LaborStandardUnit;
  /** Decimal(10,3) como cadena ("32.000"). */
  value: string;
  bands: LaborStandardBand[] | null;
  allowancePct: RatioString;
  coverageFactor: RatioString;
  validFrom: IsoDate;
  validTo: IsoDate | null;
  source: LaborStandardSource;
}

export interface StaffingPlanLineDto {
  usaliDepartment: HrUsaliDepartment;
  maxFte: HeadcountString;
  maxHeadcount: number | null;
  budgetMonthlyCost: MoneyString | null;
}

export interface StaffingPlanDto {
  id: string;
  propertyId: string;
  year: number;
  season: StaffingSeason;
  fromMonth: number;
  toMonth: number;
  status: StaffingPlanStatus;
  createdBy: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  lines: StaffingPlanLineDto[];
  totalMaxFte: HeadcountString;
}

// ---------------------------------------------------------------------------
// Previsión de plantilla, KPIs y alertas
// ---------------------------------------------------------------------------

export interface LaborForecastDriversDto {
  rooms: number | null;
  arrivals: number | null;
  departures: number | null;
  stayovers: number | null;
  pax: number | null;
  coversBreakfast: number | null;
  coversRestaurant: number | null;
  roomsInventory: number | null;
}

/** Fila día × departamento de la previsión: necesario vs planificado vs disponible vs máximo aprobado. */
export interface LaborForecastDayDto {
  propertyId: string;
  date: IsoDate;
  usaliDepartment: LaborForecastDepartment;
  drivers: LaborForecastDriversDto;
  requiredHours: HeadcountString | null;
  requiredFte: HeadcountString | null;
  /** Σ turnos del día (con pausas), o null sin cuadrante. */
  plannedHours: HeadcountString | null;
  /** Contratos activos × partTimePct − ausencias aprobadas del día. */
  availableFte: HeadcountString | null;
  /** StaffingPlanLine.maxFte de la temporada, o null sin plan aprobado. */
  approvedFte: HeadcountString | null;
  estimatedCost: MoneyString | null;
  source: LaborForecastSource | null;
  degraded: boolean;
  degradedReasons: string[];
  generatedAt: string | null;
}

export interface HrKpisDto {
  propertyId: string | null;
  legalEntityId: string | null;
  periodCode: HrPeriodCode;
  activeHeadcount: number;
  activeFte: HeadcountString;
  fixedDiscontinuousHeadcount: number;
  availableFte: HeadcountString | null;
  approvedMaxFte: HeadcountString | null;
  requiredFte: HeadcountString | null;
  monthLaborCost: MoneyString | null;
  /**
   * Origen del coste del mes (D §10 «importado o calculado»; corrector RRHH · RF-09): `import` = lote de
   * coste contabilizado (informe de coste, con ventas y % s/ ventas); `payroll` = nómina calculada del
   * ERP (recibos del periodo del mes: bruto + SS empresa; sin ventas); null sin ninguno.
   */
  monthLaborCostSource: HrLaborCostKpiSource | null;
  laborCostPctOfSales: RatioString | null;
  salesSource: HrSalesSource | null;
  costPerEmployee: MoneyString | null;
  contractsEndingIn30Days: number;
  alertsCount: number;
  degraded: HrDegradedEntry[];
}

/** Origen del KPI «Coste del mes» del panel RRHH. */
export type HrLaborCostKpiSource = "import" | "payroll";

export interface HrAlertDto {
  kind: HrAlertKind;
  severity: HrAlertSeverity;
  propertyId: string;
  usaliDepartment: HrUsaliDepartment | null;
  date: IsoDate | null;
  /** Texto en español para la tabla de alertas (sin datos personales). */
  message: string;
  value: string | null;
  threshold: string | null;
  /** Solo para contract_expiring / rule_violation; el front resuelve el nombre por el listado. */
  employeeId: string | null;
}

// ---------------------------------------------------------------------------
// Nómina: incidencias del mes (CSV a la gestoría; sin NIF)
// ---------------------------------------------------------------------------

export const PAYROLL_INCIDENCE_KINDS = ["hire", "termination", "contract_change", "absence", "overtime"] as const;
export type PayrollIncidenceKind = (typeof PAYROLL_INCIDENCE_KINDS)[number];

export const PAYROLL_INCIDENCE_KIND_LABELS_ES: Record<PayrollIncidenceKind, string> = {
  hire: "Alta",
  termination: "Baja",
  contract_change: "Cambio de contrato",
  absence: "Ausencia",
  overtime: "Horas extra"
};

/** Fila de `GET /payroll/incidences?period&propertyId`: identifica a la persona por número de empleado, nunca por NIF. */
export interface PayrollIncidenceRow {
  propertyId: string;
  propertyCode: string | null;
  employeeId: string;
  employeeNumber: string;
  employeeName: string;
  kind: PayrollIncidenceKind;
  /** Subtipo: contractType, AbsenceType, HrEndReason… */
  code: string;
  from: IsoDate;
  to: IsoDate | null;
  days: number | null;
  hours: HeadcountString | null;
  detail: string | null;
}

export interface PayrollIncidencesDto {
  periodCode: HrPeriodCode;
  propertyId: string | null;
  rows: PayrollIncidenceRow[];
  generatedAt: string;
}

// ---------------------------------------------------------------------------
// Panel de costes de personal (Dirección · Mi día › Costes de personal)
// ---------------------------------------------------------------------------

/** Departamento del panel; `sin_desglose` = 64x del diario sin centro de coste (ene-jul 2026 en Faranda). */
export type LaborCostPanelDepartment = HrUsaliDepartment | "sin_desglose";

export const LABOR_COST_PANEL_NO_BREAKDOWN = "sin_desglose" as const;
export const LABOR_COST_PANEL_NO_BREAKDOWN_LABEL_ES = "Sin desglose";

export interface LaborCostPanelDepartmentDto {
  usaliDepartment: LaborCostPanelDepartment;
  label: string;
  laborCost: MoneyString;
  /** Ingreso del departamento (rooms / fnb vía USALI), o null. */
  revenue: MoneyString | null;
  pctOfSales: RatioString | null;
  headcount: HeadcountString | null;
  costPerEmployee: MoneyString | null;
  source: LaborCostSource;
}

export interface LaborCostPanelMonthDto {
  periodCode: HrPeriodCode;
  laborCost: MoneyString;
  sales: MoneyString | null;
  salesSource: HrSalesSource | null;
  pctOfSales: RatioString | null;
  roomNights: number | null;
  /** CPOR laboral = coste / habitaciones ocupadas; null (degraded) sin RN reales. */
  laborCostPerOccupiedRoom: MoneyString | null;
  headcount: HeadcountString | null;
  costPerEmployee: MoneyString | null;
  source: LaborCostSource | null;
  /** Diario 64x y lote posted en el mismo mes: prevalece el diario. */
  overlap: boolean;
  /** Todo el coste del mes en `sin_desglose`. */
  noBreakdown: boolean;
  departments: LaborCostPanelDepartmentDto[];
}

export interface LaborCostPanelTotalsDto {
  laborCost: MoneyString;
  sales: MoneyString | null;
  pctOfSales: RatioString | null;
  roomNights: number | null;
  laborCostPerOccupiedRoom: MoneyString | null;
  headcount: HeadcountString | null;
  costPerEmployee: MoneyString | null;
  /** Δ coste frente al periodo anterior de la misma longitud, o null. */
  deltaPrevious: RatioString | null;
  byDepartment: LaborCostPanelDepartmentDto[];
}

export interface LaborCostPanelCentreDto {
  propertyId: string;
  propertyCode: string | null;
  propertyName: string;
  legalEntityId: string | null;
  months: LaborCostPanelMonthDto[];
  totals: LaborCostPanelTotalsDto;
}

export interface LaborCostPanelSourcesDto {
  /** Asientos del diario leídos (status ≠ draft, sin reversos), cuentas 64x/70x. */
  ledger: { entries: number; accounts: string[] };
  imports: Array<{ importId: string; fileName: string; periodFrom: HrPeriodCode; periodTo: HrPeriodCode; postedAt: string | null }>;
  roomNights: Array<{ propertyId: string; source: "snapshot" | "night_audit" | "reservations" | "degraded" }>;
}

export interface LaborCostPanelRankingRowDto {
  propertyId: string;
  propertyCode: string | null;
  propertyName: string;
  laborCost: MoneyString;
  pctOfSales: RatioString | null;
}

export interface LaborCostPanelDto {
  from: HrPeriodCode;
  to: HrPeriodCode;
  scope: "entity" | "property";
  legalEntityId: string | null;
  centres: LaborCostPanelCentreDto[];
  totals: LaborCostPanelTotalsDto;
  /** Centros ordenados por % s/ ventas (solo con ámbito sociedad). */
  ranking: LaborCostPanelRankingRowDto[];
  sources: LaborCostPanelSourcesDto;
  degraded: HrDegradedEntry[];
  generatedAt: string;
}

// ---------------------------------------------------------------------------
// Valores por defecto: convenios (diseño §2.3 y §6.1) y estándares por estrellas (§6.2)
// ---------------------------------------------------------------------------

export interface HrNightBand {
  from: string;
  to: string;
  pct: number;
}

export interface HrItComplementRule {
  /** it_common · it_accident */
  absenceType: Extract<AbsenceType, "it_common" | "it_accident">;
  /** % de complemento hasta el salario real. */
  pct: number;
  /** Día de la baja desde el que aplica. */
  fromDay: number;
  /** Solo primera baja del año (A Coruña). */
  firstLeaveOnly?: boolean;
}

/** Valores de las reglas del convenio (valueJson por clave). */
export interface HrAgreementRuleValues {
  annual_hours: number;
  max_daily_hours: number;
  rest_between_shifts_h: number;
  weekly_rest_days: number;
  break_minutes: number;
  break_counts_as_work: boolean;
  /** Pagas extraordinarias al año (además de las 12 mensuales). */
  extra_pay_count: number;
  /** Mes de abono de cada paga extra (repetido si hay dos en el mismo mes, p. ej. julio + Santa Marta). */
  extra_pay_months: number[];
  /** Recargo de la hora extra sobre la ordinaria (25 = +25 %). */
  overtime_pct: number;
  overtime_max_day: number | null;
  overtime_max_month: number | null;
  overtime_max_year: number;
  night_from: string;
  night_to: string;
  night_pct_bands: HrNightBand[];
  vacation_days: number;
  fd_call_notice_days: number;
  fd_min_period_days: number | null;
  fd_max_delay_days: number | null;
  it_complement_rules: HrItComplementRule[];
  part_time_min_hours: number | null;
}

export interface HrAgreementDefault {
  code: HrAgreementCode;
  name: string;
  scope: string;
  publishedRef: string;
  validFrom: IsoDate;
  validTo: IsoDate | null;
  ultraactivity: boolean;
  rules: HrAgreementRuleValues;
}

/**
 * Convenios de hostelería parametrizados por defecto [diseño §2.3 «Convenios de Faranda» y §6.1; V salvo
 * marcado S en el comentario]. Son parámetros públicos del convenio, no datos de personas. El asesor
 * laboral revisa los valores marcados S antes de sembrarlos en un tenant real.
 */
export const HR_AGREEMENT_DEFAULTS: Record<HrAgreementCode, HrAgreementDefault> = {
  "ES-15-HOST": {
    code: "ES-15-HOST",
    name: "Hostelería de la provincia de A Coruña 2019-2024",
    scope: "provincial",
    publishedRef: "BOP A Coruña (ultraactividad; preacuerdo 12/8/2026 pendiente de BOP)",
    validFrom: "2019-01-01",
    validTo: null,
    ultraactivity: true,
    rules: {
      annual_hours: 1792,
      max_daily_hours: 9,
      rest_between_shifts_h: 12,
      weekly_rest_days: 1.5,
      break_minutes: 15,
      break_counts_as_work: false,
      extra_pay_count: 3,
      extra_pay_months: [7, 9, 12],
      overtime_pct: 25,
      overtime_max_day: null,
      overtime_max_month: null,
      overtime_max_year: 80,
      night_from: "22:00",
      night_to: "06:00",
      night_pct_bands: [
        { from: "22:00", to: "24:00", pct: 1 },
        { from: "00:00", to: "06:00", pct: 25 }
      ],
      vacation_days: 30,
      fd_call_notice_days: 10,
      fd_min_period_days: 150,
      fd_max_delay_days: null,
      it_complement_rules: [
        { absenceType: "it_common", pct: 100, fromDay: 1, firstLeaveOnly: true },
        { absenceType: "it_accident", pct: 100, fromDay: 1 }
      ],
      part_time_min_hours: null
    }
  },
  "ES-33-HOST": {
    code: "ES-33-HOST",
    name: "Hostelería del Principado de Asturias 2023-2027",
    scope: "provincial",
    publishedRef: "BOPA (tablas 2026: BOPA 5/3/2026)",
    validFrom: "2023-01-01",
    validTo: "2027-12-31",
    ultraactivity: false,
    rules: {
      annual_hours: 1782,
      max_daily_hours: 8,
      rest_between_shifts_h: 12,
      weekly_rest_days: 2,
      break_minutes: 30,
      break_counts_as_work: true,
      extra_pay_count: 3,
      // julio, Santa Marta (29 de julio) y diciembre.
      extra_pay_months: [7, 7, 12],
      overtime_pct: 75,
      overtime_max_day: 2,
      overtime_max_month: 15,
      overtime_max_year: 80,
      night_from: "22:00",
      night_to: "08:00",
      night_pct_bands: [{ from: "22:00", to: "08:00", pct: 25 }],
      vacation_days: 30,
      fd_call_notice_days: 7,
      fd_min_period_days: null,
      fd_max_delay_days: null,
      it_complement_rules: [
        { absenceType: "it_common", pct: 100, fromDay: 30 },
        { absenceType: "it_accident", pct: 100, fromDay: 1 }
      ],
      part_time_min_hours: null
    }
  },
  "ES-39-HOST": {
    code: "ES-39-HOST",
    name: "Hostelería de Cantabria 2026-2029",
    scope: "provincial",
    publishedRef: "BOC 8/9/2026",
    validFrom: "2026-01-01",
    validTo: "2029-12-31",
    ultraactivity: false,
    rules: {
      annual_hours: 1766,
      max_daily_hours: 9,
      rest_between_shifts_h: 12,
      weekly_rest_days: 2,
      // 20 min (30 en jornada partida) [S computabilidad].
      break_minutes: 20,
      break_counts_as_work: false,
      extra_pay_count: 3,
      extra_pay_months: [6, 10, 12],
      // Hora extra ≥ 175 % de la ordinaria = recargo 75.
      overtime_pct: 75,
      overtime_max_day: null,
      overtime_max_month: null,
      overtime_max_year: 80,
      night_from: "22:00",
      night_to: "06:00",
      night_pct_bands: [{ from: "22:00", to: "06:00", pct: 25 }],
      vacation_days: 32,
      fd_call_notice_days: 7,
      fd_min_period_days: null,
      fd_max_delay_days: null,
      // Complemento desde el 4.º día si el índice de IT del centro es < 4 % [S].
      it_complement_rules: [
        { absenceType: "it_common", pct: 100, fromDay: 4 },
        { absenceType: "it_accident", pct: 100, fromDay: 1 }
      ],
      part_time_min_hours: null
    }
  },
  "ES-28-HOSP": {
    code: "ES-28-HOSP",
    name: "Hospedaje de la Comunidad de Madrid 2025-2028",
    scope: "autonómico",
    publishedRef: "BOCM 23/5/2026",
    validFrom: "2025-01-01",
    validTo: "2028-12-31",
    ultraactivity: false,
    rules: {
      annual_hours: 1800,
      max_daily_hours: 8,
      rest_between_shifts_h: 12,
      weekly_rest_days: 2,
      break_minutes: 30,
      break_counts_as_work: true,
      extra_pay_count: 2,
      extra_pay_months: [7, 12],
      overtime_pct: 100,
      overtime_max_day: null,
      overtime_max_month: null,
      overtime_max_year: 80,
      night_from: "22:00",
      night_to: "06:00",
      // 20 % / 25 % según franja [S: se toma el tramo general].
      night_pct_bands: [{ from: "22:00", to: "06:00", pct: 20 }],
      vacation_days: 30,
      // [S] preaviso de llamamiento no fijado en el diseño: 7 días como el resto de convenios.
      fd_call_notice_days: 7,
      fd_min_period_days: null,
      fd_max_delay_days: 20,
      it_complement_rules: [
        { absenceType: "it_common", pct: 100, fromDay: 4 },
        { absenceType: "it_accident", pct: 100, fromDay: 1 }
      ],
      part_time_min_hours: 4
    }
  }
};

/** Banda de estrellas para los estándares por defecto: 2 (≤ 2★), 3 o 4 (≥ 4★). */
export type HrStarBand = 2 | 3 | 4;

export function hrStarBandOf(starRating: number | null | undefined): HrStarBand {
  if (starRating === null || starRating === undefined || !Number.isFinite(starRating)) return 3;
  if (starRating <= 2) return 2;
  if (starRating >= 4) return 4;
  return 3;
}

export interface HrStandardDefault {
  usaliDepartment: HrUsaliDepartment;
  driver: LaborStandardDriver;
  unit: LaborStandardUnit;
  /** Decimal como cadena (hasta 3 decimales). */
  value: string;
  bands: LaborStandardBand[] | null;
  allowancePct: string;
  coverageFactor: string;
  /** Etiqueta en español para la tabla de estándares. */
  label: string;
}

const COVERAGE_FACTOR_DEFAULT = "1.40";

function roomsStandards(stayover: number, departure: number, arrival: number, allowance: number): HrStandardDefault[] {
  return [
    { usaliDepartment: "rooms", driver: "stayovers", unit: "minutes_per_unit", value: String(stayover), bands: null, allowancePct: allowance.toFixed(2), coverageFactor: COVERAGE_FACTOR_DEFAULT, label: "Pisos · minutos por habitación cliente" },
    { usaliDepartment: "rooms", driver: "departures", unit: "minutes_per_unit", value: String(departure), bands: null, allowancePct: allowance.toFixed(2), coverageFactor: COVERAGE_FACTOR_DEFAULT, label: "Pisos · minutos por salida" },
    { usaliDepartment: "rooms", driver: "arrivals", unit: "minutes_per_unit", value: String(arrival), bands: null, allowancePct: allowance.toFixed(2), coverageFactor: COVERAGE_FACTOR_DEFAULT, label: "Pisos · minutos de repaso por llegada" }
  ];
}

function receptionStandard(bands: LaborStandardBand[]): HrStandardDefault {
  // value = horas por puesto y turno; los puestos por tramo (mañana, tarde, noche) van en bands.
  return { usaliDepartment: "rooms", driver: "occupied_rooms", unit: "posts_by_band", value: "8", bands, allowancePct: "0.00", coverageFactor: COVERAGE_FACTOR_DEFAULT, label: "Recepción · puestos por tramo de habitaciones ocupadas" };
}

function fnbStandards(coversPerWaiterHour: number, coversPerCook: number, restaurantCoversPerWaiter: number | null): HrStandardDefault[] {
  const rows: HrStandardDefault[] = [
    { usaliDepartment: "fnb", driver: "covers_breakfast", unit: "minutes_per_unit", value: (60 / coversPerWaiterHour).toFixed(3), bands: null, allowancePct: "0.00", coverageFactor: COVERAGE_FACTOR_DEFAULT, label: "Desayunos · minutos de sala por cubierto" },
    { usaliDepartment: "fnb", driver: "covers_breakfast", unit: "units_per_shift", value: String(coversPerCook), bands: null, allowancePct: "0.00", coverageFactor: COVERAGE_FACTOR_DEFAULT, label: "Cocina · cubiertos por cocinero y turno" }
  ];
  if (restaurantCoversPerWaiter !== null) {
    rows.push({ usaliDepartment: "fnb", driver: "covers_restaurant", unit: "minutes_per_unit", value: (60 / restaurantCoversPerWaiter).toFixed(3), bands: null, allowancePct: "0.00", coverageFactor: COVERAGE_FACTOR_DEFAULT, label: "Restaurante y bar · minutos de sala por comensal" });
    rows.push({ usaliDepartment: "fnb", driver: "fixed", unit: "units_per_shift", value: "1", bands: null, allowancePct: "0.00", coverageFactor: COVERAGE_FACTOR_DEFAULT, label: "Bar · puestos fijos por turno" });
  }
  return rows;
}

function pomStandard(ftePer100: number): HrStandardDefault {
  return { usaliDepartment: "pom", driver: "rooms_inventory", unit: "fte_per_100", value: ftePer100.toFixed(2), bands: null, allowancePct: "0.00", coverageFactor: "1.00", label: "Mantenimiento · FTE por 100 habitaciones" };
}

function adminStandard(posts: number): HrStandardDefault {
  return { usaliDepartment: "admin_general", driver: "fixed", unit: "units_per_shift", value: String(posts), bands: null, allowancePct: "0.00", coverageFactor: "1.00", label: "Dirección y administración · puestos fijos" };
}

/**
 * Estándares por defecto por categoría (diseño §6.2, `LaborStandard.source = sector_default`). Se siembran con
 * `POST /hr/properties/:propertyId/standards/reset-defaults` según `Property.starRating` (hrStarBandOf).
 */
export const HR_STANDARD_DEFAULTS: Record<HrStarBand, readonly HrStandardDefault[]> = {
  4: [
    ...roomsStandards(20, 32, 5, 12),
    receptionStandard([
      { maxOccupiedRooms: 60, posts: [1, 1, 1] },
      { maxOccupiedRooms: 150, posts: [2, 2, 1] },
      { maxOccupiedRooms: 250, posts: [2, 2, 2] },
      { maxOccupiedRooms: null, posts: [3, 3, 3] }
    ]),
    ...fnbStandards(25, 45, 20),
    pomStandard(1.4),
    adminStandard(2)
  ],
  3: [
    ...roomsStandards(18, 30, 5, 12),
    receptionStandard([
      { maxOccupiedRooms: 45, posts: [1, 1, 1] },
      { maxOccupiedRooms: 80, posts: [2, 1, 1] },
      { maxOccupiedRooms: null, posts: [2, 2, 1] }
    ]),
    ...fnbStandards(25, 45, 20),
    pomStandard(1.2),
    adminStandard(1)
  ],
  2: [
    ...roomsStandards(16, 28, 4, 10),
    receptionStandard([
      { maxOccupiedRooms: 50, posts: [1, 1, 1] },
      { maxOccupiedRooms: null, posts: [2, 1, 1] }
    ]),
    ...fnbStandards(30, 50, null),
    pomStandard(1.0),
    adminStandard(1)
  ]
};

/** Ocupación de planificación alta / baja por banda (diseño §6.2, «Todos»). */
export const HR_PLANNING_OCCUPANCY_PCT: Record<HrStarBand, { high: number; low: number }> = {
  4: { high: 85, low: 30 },
  3: { high: 85, low: 35 },
  2: { high: 85, low: 35 }
};

// ---------------------------------------------------------------------------
// Cotización 2026 (Orden PJC/297/2026; diseño §7.2) — sustituye a SS_EMPLOYEE_PCT 6,35 / SS_EMPLOYER_PCT 30,5
// ---------------------------------------------------------------------------

export const PAYROLL_RATES_2026 = {
  year: 2026,
  /** Trabajador, contrato indefinido o fijo discontinuo: CC 4,70 + desempleo 1,55 + FP 0,10 + MEI 0,15. */
  employeePct: "6.50",
  /** Empresa, indefinido o fijo discontinuo: CC 23,60 + desempleo 5,50 + FOGASA 0,20 + FP 0,60 + MEI 0,75 + AT/EP 1,50 (CNAE 55). */
  employerPct: "32.15",
  /** Trabajador, contrato temporal (desempleo 1,60). */
  employeeTemporaryPct: "6.55",
  /** Empresa, contrato temporal (desempleo 6,70). */
  employerTemporaryPct: "33.35",
  maxBaseMonthly: "5101.20",
  minBaseMonthly: "1424.40",
  /** Cuota adicional por contrato de duración ≤ 30 días. */
  shortContractFee: "33.62",
  source: "Orden PJC/297/2026"
} as const;

/**
 * Modalidades de duración determinada (EmploymentContract.contractType) que cotizan con los tipos
 * `employeeTemporaryPct` / `employerTemporaryPct` (desempleo 1,60 / 6,70; corrector RRHH · RF-06).
 * Prácticas y formación en alternancia tienen cuotas propias (bonificadas) que la gestoría recalcula:
 * aquí siguen con los tipos generales y `validateWithAdvisor`.
 */
export const PAYROLL_TEMPORARY_CONTRACT_TYPES = ["temporal", "sustitucion"] as const;

// ---------------------------------------------------------------------------
// Errores de dominio (`details.code`, mensajes en español) y acciones de auditoría
// ---------------------------------------------------------------------------

export const HR_ERROR_CODES = [
  /** 400 · issues zod. */
  "VALIDATION_ERROR",
  /** 400 · turno o fichaje sin ficha resoluble (staffProfileId o alias de empleado). */
  "HR_EMPLOYEE_REQUIRED",
  /** 400 · NIF/NIE con letra de control inválida. */
  "HR_TAXID_INVALID",
  /** 404 opaco · expediente inexistente o de otra organización / fuera del ámbito. */
  "HR_EMPLOYEE_NOT_FOUND",
  /** 409 · mismo NIF (hash) ya existe en la sociedad. */
  "HR_EMPLOYEE_TAXID_DUPLICATE",
  /** 409 · mismo número de empleado en la sociedad. */
  "HR_EMPLOYEE_NUMBER_DUPLICATE",
  /** 409 · alta o baja sobre un expediente ya dado de baja. */
  "HR_EMPLOYEE_TERMINATED",
  /** 404 opaco · convenio inexistente o de otra organización. */
  "HR_AGREEMENT_NOT_FOUND",
  /** 409 · código de convenio ya existente en la organización. */
  "HR_AGREEMENT_CODE_DUPLICATE",
  /** 400 · clave de regla fuera de HR_AGREEMENT_RULE_KEYS o valor incompatible. */
  "HR_AGREEMENT_RULE_INVALID",
  /** 400 · estándar con driver/unit incompatibles o tramos mal formados. */
  "HR_STANDARD_INVALID",
  /** 404 opaco · plan de plantilla inexistente. */
  "HR_STAFFING_PLAN_NOT_FOUND",
  /** 409 · aprobación de un plan ya aprobado. */
  "HR_STAFFING_PLAN_ALREADY_APPROVED",
  /** Aviso en `warnings` (nunca bloquea): el departamento supera maxFte del plan aprobado. */
  "HR_STAFFING_EXCEEDED",
  /** 409 · quien solicita no aprueba (ausencias, planes): SoD dinámica. */
  "APPROVAL_SELF_DECISION",
  /** 409 · transición de estado no permitida (ausencia decidida, plan aprobado…). */
  "HR_INVALID_TRANSITION",
  /** Aviso en `warnings`: el motor de reglas detectó una infracción (descanso, tope diario, horas extra). */
  "HR_RULE_VIOLATION",
  /** 503 · la clave de cifrado no está configurada y se pidió PII descifrada. */
  "HR_PII_KEY_MISSING",
  /** 404 opaco · centro inexistente o fuera del ámbito. */
  "PROPERTY_NOT_FOUND",
  /** 404 opaco · sin ámbito de sociedad (informe de toda la sociedad sin accounting.entity.read). */
  "ENTITY_SCOPE_REQUIRED"
] as const;
export type HrErrorCode = (typeof HR_ERROR_CODES)[number];

export const HR_ERROR_MESSAGES_ES: Record<HrErrorCode, string> = {
  VALIDATION_ERROR: "Revisa los campos marcados.",
  HR_EMPLOYEE_REQUIRED: "Elige una ficha de personal: los turnos y fichajes ya no admiten nombres libres.",
  HR_TAXID_INVALID: "El NIF/NIE no es válido (letra de control incorrecta).",
  HR_EMPLOYEE_NOT_FOUND: "No se encuentra el expediente.",
  HR_EMPLOYEE_TAXID_DUPLICATE: "Ya existe un expediente con ese NIF en la sociedad.",
  HR_EMPLOYEE_NUMBER_DUPLICATE: "Ya existe un expediente con ese número de empleado en la sociedad.",
  HR_EMPLOYEE_TERMINATED: "El expediente está dado de baja.",
  HR_AGREEMENT_NOT_FOUND: "No se encuentra el convenio.",
  HR_AGREEMENT_CODE_DUPLICATE: "Ya existe un convenio con ese código.",
  HR_AGREEMENT_RULE_INVALID: "La regla del convenio no es válida.",
  HR_STANDARD_INVALID: "El estándar de dotación no es válido.",
  HR_STAFFING_PLAN_NOT_FOUND: "No se encuentra el plan de plantilla.",
  HR_STAFFING_PLAN_ALREADY_APPROVED: "El plan de plantilla ya está aprobado.",
  HR_STAFFING_EXCEEDED: "El departamento supera la plantilla máxima aprobada.",
  APPROVAL_SELF_DECISION: "Quien solicita no puede aprobar su propia solicitud.",
  HR_INVALID_TRANSITION: "La solicitud ya fue decidida.",
  HR_RULE_VIOLATION: "El cuadrante incumple una regla del convenio o del Estatuto de los Trabajadores.",
  HR_PII_KEY_MISSING: "No se pueden mostrar los datos personales: falta la clave de cifrado.",
  PROPERTY_NOT_FOUND: "No se encuentra el centro.",
  ENTITY_SCOPE_REQUIRED: "Necesitas ámbito de sociedad para ver toda la organización."
};

/** Acciones de auditoría del módulo (AuditEvent.action). */
export const HR_AUDIT_ACTIONS = [
  "HR_EMPLOYEE_CREATED",
  "HR_EMPLOYEE_UPDATED",
  "HR_EMPLOYEE_TERMINATED",
  "HR_PII_READ",
  "HR_AGREEMENT_CHANGED",
  "HR_STANDARDS_CHANGED",
  "HR_STAFFING_PLAN_APPROVED",
  "HR_FORECAST_GENERATED",
  "HR_ABSENCE_DECIDED",
  // Corrector RRHH (SEC-11): acciones que ya emitían los servicios como cadena libre.
  "HR_STAFFING_PLAN_CREATED",
  "HR_STAFFING_PLAN_UPDATED",
  "PAYROLL_INCIDENCES_EXPORTED"
] as const;
export type HrAuditAction = (typeof HR_AUDIT_ACTIONS)[number];
