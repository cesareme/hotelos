// Tanda RRHH · lote RRHH-7 · tenant de prueba de plantilla, previsión y nómina
// (docs/design/RRHH-PLANTILLA-NOMINA.md §12 como referencia; especificación
// exacta en scratchpad/RRHH/recon-delta.md §3.5; reglas: tenants aislados por
// producto, nunca Faranda).
//
// Crea y rearma un tenant AISLADO para toda verificación con escritura de la
// tanda: organización `org_hr`, sociedad `le_hr`, hotel `prop_hr` («Hotel HR
// (prueba)», 4 estrellas, 60 habitaciones, centros de coste USALI), doce
// usuarios `*@hr.test` con roles de plantilla — los cuatro principales del
// recon §3.5: direccion@hr.test (general_manager), rrhh@hr.test (payroll_hr),
// jefe.pisos@hr.test (housekeeping_manager) y camarera1@hr.test (housekeeper);
// además recepcion1-3, camarera2-3, sala1, cocina1 y mantenimiento1 — y los
// módulos pms_core + workforce_labor + housekeeping + maintenance activados:
//
//   · 24 expedientes `Employee` FICTICIOS repartidos en rooms / fnb / pom /
//     admin_general (nombres genéricos con apellidos griegos; NIE sintéticos
//     Z9999xxx con letra de control válida; NAF, correo, teléfono e IBAN
//     sintéticos) — el NIF, el NAF, el correo, el teléfono y el IBAN los cifra
//     la extensión del cliente (PII_FIELDS.Employee) y el hash de búsqueda lo
//     calcula ella (taxIdLookupHash): este seed nunca cifra a mano;
//   · 12 de ellos con usuario de la app + ficha de centro (StaffProfile con
//     employeeId, usaliDepartment, jobTitle) y contrato: 8 indefinidos, 2 fijos
//     discontinuos y 2 temporales que vencen dentro de 30 días;
//   · convenio ES-15-HOST (HR_AGREEMENT_DEFAULTS) con sus 21 reglas, asignado a
//     prop_hr y a todos los contratos; estándares de 4 estrellas
//     (HR_STANDARD_DEFAULTS) con origen sector_default;
//   · plantilla máxima del año en curso: dos StaffingPlan aprobados (alta abril-
//     octubre, baja noviembre-marzo) con una línea por departamento;
//   · 90 días de `revenue_daily_snapshots` top-level `demo` y 30
//     `revenue_forecasts` top-level (modelVersion seed-hr-demo) con una demanda
//     determinista por día de la semana y mes;
//   · 6 semanas de turnos (5 semanas pasadas + la próxima) y sus fichajes
//     (in/out por turno completado; solo «in» en los de hoy ya empezados);
//   · 3 ausencias: una pending (IT), una approved por OTRO usuario (vacaciones:
//     requestedBy ≠ approvedBy, CHECK absence_requests_requested_ne_approved) y
//     una rejected; los turnos de las vacaciones aprobadas no se generan;
//   · 28 días de LaborForecast por departamento USALI (rooms, fnb, pom,
//     admin_general) calculados con los estándares sembrados sobre la demanda
//     demo (source pms_forecast; el día de hoy, actual), con horas, FTE, coste
//     estimado y drivers;
//   · un PayrollPeriod del mes en curso `open` en modo externo.
//
// Idempotente: todo se escribe por id fijo (`hr_*`, `usr_hr_*`, `dep_hr_*`,
// `cc_hr_*`) con upsert o createMany + skipDuplicates; los turnos, fichajes y
// previsiones van indexados por fecha absoluta (repetir el seed el mismo día no
// duplica nada; otro día añade solo los días nuevos). Nunca toca nada fuera de
// org_hr / prop_hr y nunca borra nada de otro tenant: los únicos deleteMany son
// deleteScoped (SIEMPRE `propertyId: PROPERTY_ID`), deleteOrgScoped (SIEMPRE
// `organizationId: ORG_ID`) y los de las líneas hijas (staffing_plan_lines,
// agreement_rules) por los ids de sus padres, leídos antes en el ámbito.
//
//   --reset   borra SOLO la capa RRHH de prop_hr / org_hr (fichajes, turnos,
//             ausencias, previsiones, estándares, planes y líneas, contratos,
//             fichas, expedientes, reglas y convenio, periodos de nómina,
//             snapshots demo y previsiones demo) y la vuelve a sembrar; el
//             esqueleto del tenant (organización, sociedad, hotel, usuarios,
//             roles, habitaciones, módulos) se conserva y se reafirma.
//   --dry-run solo imprime el plan y sale 0 sin escribir.
//
//   cd packages/database && node --env-file=../../.env --import tsx prisma/seed-hr.ts [--reset]
//   corepack pnpm --filter @hotelos/database db:seed:hr -- --reset
//
// Guardado por assertDemoTarget (Tanda 4 · DATA-05): org_hr / prop_hr están en
// la allowlist demo (lib/demo-guard.ts). Es autónomo: NO importa de seed.ts ni
// de seed-operations.ts ni de seed-ux-day.ts ni de seed-checkin.ts. Los helpers
// del API (catálogo de permisos, plan contable, ajustes de la propiedad) se
// importan por ruta relativa como en tests/integration/helpers/l2-tenant.mts.
// Contrato: tests/seed-hr-contract.test.mjs.
import { Prisma } from "@prisma/client";
import { prisma } from "../src/client.js";
import { hashPassword } from "../src/password.js";
import { assertDemoTarget, type PlannedWrite } from "./lib/demo-guard.js";
import { applyRoleTemplate, provisionDefaultTemplateRoles, syncPermissionCatalog } from "../../../apps/api/src/lib/rbac-catalog.js";
import type { UserContext } from "../../../apps/api/src/lib/demo-store.js";
import { flushAuditQueues } from "../../../apps/api/src/modules/audit/audit.service.js";
// Corrector RRHH (SEC-08): estándares y previsión laboral los escriben SUS únicos escritores
// (standards.service / labor-forecast.service), nunca un cálculo propio del seed.
import { generateLaborForecast } from "../../../apps/api/src/modules/hr/labor-forecast.service.js";
import { mergeSameDriverStandards, resetLaborStandardDefaults } from "../../../apps/api/src/modules/hr/standards.service.js";
import { provisionOrganizationChart } from "../../../apps/api/src/modules/accounting/chart-of-accounts.service.js";
import { ensurePropertySettings } from "../../../apps/api/src/lib/tenant-hydration.js";
import {
  HR_AGREEMENT_DEFAULTS,
  HR_STANDARD_DEFAULTS,
  hrStarBandOf,
  type HrAgreementRuleKey,
  type HrUsaliDepartment
} from "../../shared/src/hr-types.js";

// ---------------------------------------------------------------------------
// Identificadores fijos del tenant (solo de prueba)
// ---------------------------------------------------------------------------

export const ORG_ID = "org_hr";
export const LEGAL_ENTITY_ID = "le_hr";
export const PROPERTY_ID = "prop_hr";
export const PROPERTY_CODE = "HR";
export const PROPERTY_NAME = "Hotel HR (prueba)";
export const EMAIL_DOMAIN = "hr.test";
/** Contraseña común de los usuarios de prueba (solo demo local; nunca real). `SEED_HR_PASSWORD` la sustituye. */
export const DEMO_PASSWORD = process.env.SEED_HR_PASSWORD?.trim() || "hr-demo";
/** Fecha fija de puesta en marcha del hotel de prueba (antes de cualquier turno sembrado). */
export const GO_LIVE_AT = new Date("2026-01-01T00:00:00.000Z");
export const STAR_RATING = 4;
export const TIME_ZONE = "Europe/Madrid";
/** Convenio parametrizado que se asigna al hotel de prueba (HR_AGREEMENT_DEFAULTS). */
export const AGREEMENT_CODE = "ES-15-HOST" as const;
export const AGREEMENT_ID = "hr_agr_es15";
/**
 * modelVersion de las previsiones demo (ámbito del deleteScoped de revenue_forecasts). Prefijo `pms_import:`
 * (SEC-08): drivers.service.ts (forecastKindOf) solo usa como driver las previsiones `pms_import:*`; una
 * `deterministic` sin OTB corroborante degrada el día, y el tenant de prueba no tiene un PMS detrás.
 */
export const FORECAST_MODEL_VERSION = "pms_import:seed-hr-demo";
/** modelVersion que escribía el seed hasta el corrector: sus filas (mismos ids `hr_rf_*`) se retiran al resembrar. */
export const LEGACY_FORECAST_MODEL_VERSION = "seed-hr-demo";
const FORECAST_MODEL_VERSIONS = [FORECAST_MODEL_VERSION, LEGACY_FORECAST_MODEL_VERSION];
/** Prefijo del código de las reservas demo (régimen conocido para los cubiertos de la previsión; ámbito del deleteScoped). */
export const DEMO_RESERVATION_PREFIX = "HRDEMO-";
/** Origen de los fichajes sembrados. */
export const CLOCK_SOURCE = "seed-hr";

/** Ventanas relativas a HOY (Europe/Madrid). */
export const SNAPSHOT_DAYS = 90;
export const FORECAST_DAYS = 30;
export const LABOR_FORECAST_DAYS = 28;
export const SHIFT_DAYS_BEFORE = 35;
export const SHIFT_DAYS_AFTER = 6;
/** Días hasta el vencimiento de los dos contratos temporales. */
export const TEMPORARY_CONTRACT_ENDS_IN_DAYS = 30;

/** Módulos del producto activados en prop_hr (misma tabla property_modules que enableModules de tests/integration/helpers/l2-tenant.mts). */
export const ENABLED_MODULES = ["pms_core", "workforce_labor", "housekeeping", "maintenance"] as const;

export const ROOM_TYPES = [
  { id: "rt_hr_dbl", code: "DBL", name: "Doble", maxOccupancy: 2, displayOrder: 1, numbers: [...range(101, 120), ...range(201, 220)] },
  { id: "rt_hr_sup", code: "SUP", name: "Superior", maxOccupancy: 3, displayOrder: 2, numbers: range(301, 320) }
] as const;
export const ROOMS_TOTAL = ROOM_TYPES.reduce((sum, type) => sum + type.numbers.length, 0);

export type DeptCode = "REC" | "HSK" | "FNB" | "MNT" | "ADM";
/** Departamentos operativos del hotel (Department) y su departamento USALI. */
export const DEPARTMENTS: ReadonlyArray<{ id: string; code: DeptCode; name: string; usali: HrUsaliDepartment }> = [
  { id: "dep_hr_rec", code: "REC", name: "Recepción", usali: "rooms" },
  { id: "dep_hr_hsk", code: "HSK", name: "Pisos", usali: "rooms" },
  { id: "dep_hr_fnb", code: "FNB", name: "Restaurante y bar", usali: "fnb" },
  { id: "dep_hr_mnt", code: "MNT", name: "Mantenimiento", usali: "pom" },
  { id: "dep_hr_adm", code: "ADM", name: "Administración", usali: "admin_general" }
];
/** Centros de coste USALI (type "usali"; el código en mayúsculas nombra el departamento: routeByCostCentre). */
export const COST_CENTERS: ReadonlyArray<{ id: string; code: string; name: string; usali: HrUsaliDepartment }> = [
  { id: "cc_hr_rooms", code: "ROOMS", name: "Habitaciones", usali: "rooms" },
  { id: "cc_hr_fnb", code: "FNB", name: "Alimentos y bebidas", usali: "fnb" },
  { id: "cc_hr_pom", code: "POM", name: "Mantenimiento y operación de la propiedad", usali: "pom" },
  { id: "cc_hr_admin_general", code: "ADMIN_GENERAL", name: "Administración y general", usali: "admin_general" }
];
/** Departamentos USALI con previsión y línea de plantilla máxima. */
export const FORECAST_DEPARTMENTS: readonly HrUsaliDepartment[] = ["rooms", "fnb", "pom", "admin_general"];

export type ContractKind = "indefinido" | "fijo_discontinuo" | "temporal";
export type ShiftPattern = "office" | "morning" | "morning9" | "rotating" | "breakfast" | "kitchen";
export type UserSpec = {
  /** Parte local del correo `<local>@hr.test` y sufijo del id `usr_hr_<local>`. */
  local: string;
  templateKey: string;
  contract: ContractKind;
  pattern: ShiftPattern;
  /** Salario bruto MENSUAL (EmploymentContract.grossSalary, como en payroll-calc). */
  grossSalary: number;
  /** Grupo de cotización 1-11. */
  group: number;
  /** Jornada semanal; 25 h = parcial (partTimePct 62,50). */
  weeklyHours?: number;
};
export type EmployeeSpec = {
  n: number;
  dept: DeptCode;
  jobTitle: string;
  gender: "female" | "male" | "undisclosed";
  hiredMonthsAgo: number;
  status?: "active" | "leave";
  user?: UserSpec;
};

/**
 * 24 expedientes ficticios: 12 con usuario + ficha + contrato (8 indefinidos ·
 * 2 fijos discontinuos · 2 temporales) y 12 solo como expediente. Una línea por
 * persona (tests/seed-hr-contract.test.mjs cuenta `{ n:`).
 */
export const EMPLOYEES: readonly EmployeeSpec[] = [
  { n: 1, dept: "ADM", jobTitle: "Dirección de hotel", gender: "female", hiredMonthsAgo: 60, user: { local: "direccion", templateKey: "general_manager", contract: "indefinido", pattern: "office", grossSalary: 3400, group: 1 } },
  { n: 2, dept: "ADM", jobTitle: "Técnico/a de RRHH", gender: "male", hiredMonthsAgo: 30, user: { local: "rrhh", templateKey: "payroll_hr", contract: "indefinido", pattern: "office", grossSalary: 2100, group: 2 } },
  { n: 3, dept: "HSK", jobTitle: "Gobernanta", gender: "female", hiredMonthsAgo: 48, user: { local: "jefe.pisos", templateKey: "housekeeping_manager", contract: "indefinido", pattern: "morning9", grossSalary: 1900, group: 5 } },
  { n: 4, dept: "HSK", jobTitle: "Camarera de pisos", gender: "female", hiredMonthsAgo: 26, user: { local: "camarera1", templateKey: "housekeeper", contract: "indefinido", pattern: "morning", grossSalary: 1450, group: 10 } },
  { n: 5, dept: "HSK", jobTitle: "Camarera de pisos", gender: "female", hiredMonthsAgo: 18, user: { local: "camarera2", templateKey: "housekeeper", contract: "fijo_discontinuo", pattern: "morning", grossSalary: 1450, group: 10 } },
  { n: 6, dept: "HSK", jobTitle: "Camarera de pisos", gender: "undisclosed", hiredMonthsAgo: 14, user: { local: "camarera3", templateKey: "housekeeper", contract: "fijo_discontinuo", pattern: "morning", grossSalary: 1450, group: 10, weeklyHours: 25 } },
  { n: 7, dept: "REC", jobTitle: "Recepcionista", gender: "male", hiredMonthsAgo: 36, user: { local: "recepcion1", templateKey: "receptionist", contract: "indefinido", pattern: "rotating", grossSalary: 1650, group: 5 } },
  { n: 8, dept: "REC", jobTitle: "Recepcionista", gender: "female", hiredMonthsAgo: 20, user: { local: "recepcion2", templateKey: "receptionist", contract: "indefinido", pattern: "rotating", grossSalary: 1650, group: 5 } },
  { n: 9, dept: "REC", jobTitle: "Recepcionista", gender: "male", hiredMonthsAgo: 5, user: { local: "recepcion3", templateKey: "receptionist", contract: "temporal", pattern: "rotating", grossSalary: 1600, group: 5 } },
  { n: 10, dept: "FNB", jobTitle: "Camarero/a de sala", gender: "female", hiredMonthsAgo: 5, user: { local: "sala1", templateKey: "fnb", contract: "temporal", pattern: "breakfast", grossSalary: 1500, group: 8 } },
  { n: 11, dept: "FNB", jobTitle: "Cocinero/a", gender: "male", hiredMonthsAgo: 40, user: { local: "cocina1", templateKey: "fnb", contract: "indefinido", pattern: "kitchen", grossSalary: 1700, group: 8 } },
  { n: 12, dept: "MNT", jobTitle: "Técnico/a de mantenimiento", gender: "male", hiredMonthsAgo: 55, user: { local: "mantenimiento1", templateKey: "maintenance", contract: "indefinido", pattern: "morning", grossSalary: 1750, group: 8 } },
  { n: 13, dept: "REC", jobTitle: "Auditor/a nocturno", gender: "male", hiredMonthsAgo: 12 },
  { n: 14, dept: "HSK", jobTitle: "Camarera de pisos", gender: "female", hiredMonthsAgo: 9 },
  { n: 15, dept: "HSK", jobTitle: "Camarera de pisos", gender: "female", hiredMonthsAgo: 33 },
  { n: 16, dept: "HSK", jobTitle: "Camarera de pisos", gender: "undisclosed", hiredMonthsAgo: 7 },
  { n: 17, dept: "HSK", jobTitle: "Valet", gender: "male", hiredMonthsAgo: 16 },
  { n: 18, dept: "FNB", jobTitle: "Camarero/a de sala", gender: "male", hiredMonthsAgo: 22 },
  { n: 19, dept: "FNB", jobTitle: "Ayudante de cocina", gender: "female", hiredMonthsAgo: 11 },
  { n: 20, dept: "FNB", jobTitle: "Camarero/a de bar", gender: "male", hiredMonthsAgo: 29 },
  { n: 21, dept: "FNB", jobTitle: "Jefe/a de cocina", gender: "female", hiredMonthsAgo: 70 },
  { n: 22, dept: "MNT", jobTitle: "Ayudante de mantenimiento", gender: "male", hiredMonthsAgo: 8 },
  { n: 23, dept: "ADM", jobTitle: "Administrativo/a", gender: "female", hiredMonthsAgo: 44 },
  { n: 24, dept: "ADM", jobTitle: "Comercial", gender: "male", hiredMonthsAgo: 15, status: "leave" }
];

/** Usuarios «principales» de la demo (los cuatro del recon §3.5) — deben existir entre los EMPLOYEES con usuario. */
export const PRINCIPAL_USERS: ReadonlyArray<{ local: string; templateKey: string }> = [
  { local: "direccion", templateKey: "general_manager" },
  { local: "rrhh", templateKey: "payroll_hr" },
  { local: "jefe.pisos", templateKey: "housekeeping_manager" },
  { local: "camarera1", templateKey: "housekeeper" }
];

/** Ausencias: una pending, una approved por OTRO usuario, una rejected. Fechas relativas a hoy. */
export const ABSENCES = [
  { id: "hr_abs_01", n: 5, absenceType: "vacation", fromOffset: 2, toOffset: 8, status: "approved", decidedByLocal: "jefe.pisos", reason: "Vacaciones pactadas en el cuadrante de pisos" },
  { id: "hr_abs_02", n: 8, absenceType: "it_common", fromOffset: -1, toOffset: 2, status: "pending", decidedByLocal: null, reason: "Parte de baja pendiente de registrar" },
  { id: "hr_abs_03", n: 11, absenceType: "permit_paid", fromOffset: 3, toOffset: 3, status: "rejected", decidedByLocal: "direccion", reason: "Permiso solicitado sin preaviso; se propone otra fecha" }
] as const;

/** Líneas de la plantilla máxima por temporada (FTE máximo, personas máximas, presupuesto mensual). */
export const STAFFING_LINES: Record<"high" | "low", Record<HrUsaliDepartment, { maxFte: string; maxHeadcount: number; budgetMonthlyCost: string } | undefined>> = {
  high: {
    rooms: { maxFte: "14.00", maxHeadcount: 16, budgetMonthlyCost: "33000.00" },
    fnb: { maxFte: "7.00", maxHeadcount: 9, budgetMonthlyCost: "16000.00" },
    pom: { maxFte: "2.00", maxHeadcount: 2, budgetMonthlyCost: "5600.00" },
    admin_general: { maxFte: "4.00", maxHeadcount: 4, budgetMonthlyCost: "12000.00" },
    other_operated: undefined,
    it: undefined,
    sales_marketing: undefined
  },
  low: {
    rooms: { maxFte: "9.00", maxHeadcount: 11, budgetMonthlyCost: "21000.00" },
    fnb: { maxFte: "4.00", maxHeadcount: 5, budgetMonthlyCost: "9500.00" },
    pom: { maxFte: "2.00", maxHeadcount: 2, budgetMonthlyCost: "5600.00" },
    admin_general: { maxFte: "4.00", maxHeadcount: 4, budgetMonthlyCost: "12000.00" },
    other_operated: undefined,
    it: undefined,
    sales_marketing: undefined
  }
};
/** Temporadas del plan: alta abril-octubre, baja noviembre-marzo (rango que cruza el año). */
export const STAFFING_SEASONS = [
  { id: "hr_plan_high", season: "high", fromMonth: 4, toMonth: 10 },
  { id: "hr_plan_low", season: "low", fromMonth: 11, toMonth: 3 }
] as const;

/** Coste hora estimado por departamento USALI (LaborForecast.estimatedCost y StaffProfile.hourlyCost). */
export const HOURLY_COST: Record<HrUsaliDepartment, string> = {
  rooms: "14.50",
  fnb: "15.00",
  pom: "17.00",
  admin_general: "22.00",
  other_operated: "14.00",
  it: "20.00",
  sales_marketing: "18.00"
};

// Nombres genéricos + apellidos griegos: ninguna combinación corresponde a una persona real.
const FIRST_NAMES = ["Ana", "Luis", "Marta", "Pablo", "Elena", "Jorge", "Lucía", "Diego", "Sara", "Iván", "Nuria", "Raúl", "Clara", "Mario"];
// Solo letras griegas de varias sílabas (las cortas —Mu, Xi, Pi…— coinciden con apellidos reales).
const GREEK_SURNAMES = ["Alfa", "Beta", "Gamma", "Delta", "Épsilon", "Theta", "Kappa", "Lambda", "Sigma", "Omega", "Ómicron", "Ípsilon"];

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------

function range(from: number, to: number): number[] {
  const out: number[] = [];
  for (let n = from; n <= to; n += 1) out.push(n);
  return out;
}

const pad2 = (n: number): string => String(n).padStart(2, "0");

/** CIF con letra de control válida (mismo algoritmo que tests/integration/helpers/l2-tenant.mts cifFor). */
export function cifFor(letter: string, seed: number): string {
  const digits = String(Math.abs(seed) % 10_000_000).padStart(7, "0");
  let even = 0;
  let odd = 0;
  for (let i = 0; i < 7; i += 1) {
    const d = Number(digits[i]);
    if (i % 2 === 1) even += d;
    else {
      const doubled = d * 2;
      odd += doubled >= 10 ? doubled - 9 : doubled;
    }
  }
  const control = (10 - ((even + odd) % 10)) % 10;
  return `${letter}${digits}${control}`;
}

/** NIF de la sociedad de prueba (número fijo → siempre el mismo CIF; distinto del de CHK y UXDAY). */
export const LEGAL_ENTITY_TAX_ID = cifFor("B", 2026_0921);

const NIF_LETTERS = "TRWAGMYFPDXBNJZSQVHLCKE";

/**
 * NIE sintético `Z9999nnnL` con letra de control válida (Z → 2 para el módulo 23).
 * La banda Z9999xxx está muy por encima de la numeración NIE en uso: nunca una persona real.
 */
export function syntheticNieFor(n: number): string {
  const digits = String(9_999_000 + n).padStart(7, "0");
  const letter = NIF_LETTERS[Number(`2${digits}`) % 23];
  return `Z${digits}${letter}`;
}

/** Número de afiliación sintético (provincia 15 + secuencia 9999xxxx + control módulo 97). */
export function syntheticNafFor(n: number): string {
  const body = `15${String(99_990_000 + n).padStart(8, "0")}`;
  return `${body}${pad2(Number(body) % 97)}`;
}

/** IBAN sintético ES + dígitos de control válidos (módulo 97) sobre un BBAN 9999-9999-99-… inexistente. */
export function syntheticIbanFor(n: number): string {
  const bban = `9999999999${String(9_000_000_000 + n).slice(-10)}`;
  const rearranged = `${bban}142800`;
  let remainder = 0;
  for (const ch of rearranged) remainder = (remainder * 10 + Number(ch)) % 97;
  return `ES${pad2(98 - remainder)}${bban}`;
}

/** Nombre y apellidos ficticios por número de expediente (deterministas). */
export function employeeNameFor(n: number): { firstName: string; lastName: string } {
  const first = FIRST_NAMES[(n - 1) % FIRST_NAMES.length]!;
  const s1 = GREEK_SURNAMES[(n - 1) % GREEK_SURNAMES.length]!;
  let s2 = GREEK_SURNAMES[(n * 5 + 3) % GREEK_SURNAMES.length]!;
  if (s2 === s1) s2 = GREEK_SURNAMES[(n * 5 + 4) % GREEK_SURNAMES.length]!;
  return { firstName: first, lastName: `${s1} ${s2}` };
}

export const employeeNumberFor = (n: number): string => `HR-${String(n).padStart(3, "0")}`;
export const employeeIdFor = (n: number): string => `hr_emp_${String(n).padStart(3, "0")}`;
export const staffProfileIdFor = (n: number): string => `hr_sp_${String(n).padStart(3, "0")}`;
export const contractIdFor = (n: number): string => `hr_ct_${String(n).padStart(3, "0")}`;
export const userIdFor = (local: string): string => `usr_hr_${local.replace(/\./g, "_")}`;
export const emailFor = (local: string): string => `${local}@${EMAIL_DOMAIN}`;

/** Hoy (YYYY-MM-DD) en la zona horaria del hotel. */
export function todayIn(timeZone: string, now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

function isoPlus(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function dateOnly(iso: string): Date {
  return new Date(`${iso}T00:00:00.000Z`);
}

function monthsBefore(iso: string, months: number): string {
  const d = new Date(`${iso}T00:00:00.000Z`);
  d.setUTCMonth(d.getUTCMonth() - months);
  return d.toISOString().slice(0, 10);
}

/** Desfase (minutos) de la zona horaria en un instante. */
function tzOffsetMinutes(date: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(date);
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? "0");
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return Math.round((asUtc - date.getTime()) / 60_000);
}

/** Instante UTC de la hora de pared `hh:mm` del día `iso` en la zona del hotel. */
export function zoned(iso: string, hh: number, mm = 0, timeZone = TIME_ZONE): Date {
  const guess = new Date(`${iso}T${pad2(hh)}:${pad2(mm)}:00.000Z`);
  return new Date(guess.getTime() - tzOffsetMinutes(guess, timeZone) * 60_000);
}

const dowOf = (iso: string): number => dateOnly(iso).getUTCDay();
const dayNumberOf = (iso: string): number => Math.floor(dateOnly(iso).getTime() / 86_400_000);

/** Ruido determinista en [-0,5, 0,5) a partir de un entero (sin aleatoriedad: el seed es reproducible). */
function noise(seed: number): number {
  const x = Math.abs(Math.imul(seed | 0, 2654435761) >>> 0);
  return (x % 10_000) / 10_000 - 0.5;
}

const round2 = (value: number): number => Math.round(value * 100) / 100;
const money = (value: number): string => value.toFixed(2);
const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

const log = (line: string) => console.log(line);

// ---------------------------------------------------------------------------
// Demanda demo determinista por día (snapshots, previsiones de ingresos y drivers de la previsión laboral)
// ---------------------------------------------------------------------------

export type DemandDay = { occ: number; roomsSold: number; arrivals: number; departures: number; stayovers: number; pax: number; adr: number };

export function demandFor(iso: string): DemandDay {
  const dow = dowOf(iso);
  const month = dateOnly(iso).getUTCMonth();
  const weekend = dow === 5 || dow === 6;
  const dowAdj = weekend ? 0.12 : dow === 0 ? -0.05 : dow >= 2 && dow <= 4 ? 0.03 : 0;
  const seasonal = 0.08 * Math.sin(((month - 3) / 12) * 2 * Math.PI);
  const occ = clamp(0.72 + dowAdj + seasonal + noise(dayNumberOf(iso)) * 0.08, 0.35, 0.98);
  const roomsSold = Math.round(ROOMS_TOTAL * occ);
  const arrivals = clamp(Math.round(roomsSold * (dow === 5 ? 0.42 : 0.3)), 0, roomsSold);
  const departures = clamp(Math.round(roomsSold * (dow === 0 ? 0.45 : 0.3)), 0, roomsSold);
  const adr = round2(118 * (1 + (weekend ? 0.1 : 0) + noise(dayNumberOf(iso) + 7) * 0.06));
  return { occ, roomsSold, arrivals, departures, stayovers: roomsSold - arrivals, pax: Math.round(roomsSold * 1.8), adr };
}

// ---------------------------------------------------------------------------
// Estándares y previsión laboral: los escriben sus servicios (SEC-08)
// ---------------------------------------------------------------------------

/**
 * Estándares efectivos del centro de prueba (4★): los defaults del sector fundidos por
 * (departamento, driver) exactamente como los escribe resetLaborStandardDefaults
 * (mergeSameDriverStandards: la clave única de labor_standards no lleva `unit`).
 */
export function effectiveStandardCount(): number {
  return mergeSameDriverStandards(HR_STANDARD_DEFAULTS[hrStarBandOf(STAR_RATING)].map((d) => ({ usaliDepartment: d.usaliDepartment, driver: d.driver, unit: d.unit, value: d.value, bands: d.bands, allowancePct: d.allowancePct, coverageFactor: d.coverageFactor, source: "sector_default" as const }))).length;
}

/** Contexto con el que el seed llama a los servicios de RRHH: el técnico de RRHH del tenant, ámbito de organización. */
function seedContext(): UserContext {
  return {
    organizationId: ORG_ID,
    propertyId: PROPERTY_ID,
    userId: userIdFor("rrhh"),
    fullName: "seed-hr",
    deviceId: "seed-hr",
    permissions: ["hr.standards.manage", "workforce.schedule.manage"],
    orgScope: true
  } as UserContext;
}

// ---------------------------------------------------------------------------
// Turnos por patrón (fechas relativas; sin turno en los descansos ni en las vacaciones aprobadas)
// ---------------------------------------------------------------------------

export type PlannedShift = { n: number; iso: string; startAt: Date; endAt: Date; roleLabel: string };

function restDaysFor(spec: EmployeeSpec): ReadonlySet<number> {
  if (spec.user?.pattern === "office") return new Set([0, 6]);
  return new Set([spec.n % 7, (spec.n + 1) % 7]);
}

/** Turno del día `iso` según el patrón (null = descanso). weekIndex rota el turno de recepción. */
export function shiftFor(spec: EmployeeSpec, iso: string, weekIndex: number): PlannedShift | null {
  const user = spec.user;
  if (!user) return null;
  if (restDaysFor(spec).has(dowOf(iso))) return null;
  const next = isoPlus(iso, 1);
  switch (user.pattern) {
    case "office":
      return { n: spec.n, iso, startAt: zoned(iso, 9), endAt: zoned(iso, 17), roleLabel: spec.jobTitle };
    case "morning":
      return user.weeklyHours === 25
        ? { n: spec.n, iso, startAt: zoned(iso, 9), endAt: zoned(iso, 14), roleLabel: spec.jobTitle }
        : { n: spec.n, iso, startAt: zoned(iso, 8), endAt: zoned(iso, 16), roleLabel: spec.jobTitle };
    case "morning9":
      return { n: spec.n, iso, startAt: zoned(iso, 9), endAt: zoned(iso, 17), roleLabel: spec.jobTitle };
    case "breakfast":
      return { n: spec.n, iso, startAt: zoned(iso, 6, 30), endAt: zoned(iso, 14, 30), roleLabel: "Desayunos y sala" };
    case "kitchen":
      return { n: spec.n, iso, startAt: zoned(iso, 12), endAt: zoned(iso, 20), roleLabel: "Cocina" };
    case "rotating": {
      const slot = (spec.n + weekIndex) % 3;
      if (slot === 0) return { n: spec.n, iso, startAt: zoned(iso, 7), endAt: zoned(iso, 15), roleLabel: "Recepción mañana" };
      if (slot === 1) return { n: spec.n, iso, startAt: zoned(iso, 15), endAt: zoned(iso, 23), roleLabel: "Recepción tarde" };
      return { n: spec.n, iso, startAt: zoned(iso, 23), endAt: zoned(next, 7), roleLabel: "Recepción noche" };
    }
  }
}

/** Días (ISO) cubiertos por las ausencias aprobadas de un expediente (sin turno). */
function approvedAbsenceDays(today: string): Map<number, Set<string>> {
  const out = new Map<number, Set<string>>();
  for (const absence of ABSENCES) {
    if (absence.status !== "approved") continue;
    const days = out.get(absence.n) ?? new Set<string>();
    for (let offset = absence.fromOffset; offset <= absence.toOffset; offset += 1) days.add(isoPlus(today, offset));
    out.set(absence.n, days);
  }
  return out;
}

export function buildShiftPlan(today: string): PlannedShift[] {
  const out: PlannedShift[] = [];
  const absent = approvedAbsenceDays(today);
  for (let offset = -SHIFT_DAYS_BEFORE; offset <= SHIFT_DAYS_AFTER; offset += 1) {
    const iso = isoPlus(today, offset);
    const weekIndex = Math.floor((offset + SHIFT_DAYS_BEFORE) / 7);
    for (const spec of EMPLOYEES) {
      if (absent.get(spec.n)?.has(iso)) continue;
      const shift = shiftFor(spec, iso, weekIndex);
      if (shift) out.push(shift);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// deleteMany acotados
// ---------------------------------------------------------------------------

type ScopedModel = "timeClockEntry" | "shift" | "absenceRequest" | "laborForecast" | "laborStandard" | "staffingPlan" | "staffProfile" | "revenueDailySnapshot" | "revenueForecast" | "reservation";
type OrgScopedModel = "employee" | "employmentContract" | "collectiveAgreement" | "payrollPeriod";
type DeleteManyDelegate = { deleteMany: (args: { where: Record<string, unknown> }) => Promise<{ count: number }> };

/** Borra filas del modelo SOLO dentro de prop_hr (`propertyId: PROPERTY_ID` siempre). */
async function deleteScoped(model: ScopedModel, extraWhere: Record<string, unknown> = {}): Promise<number> {
  const where = { ...extraWhere, propertyId: PROPERTY_ID };
  const delegate = prisma[model] as unknown as DeleteManyDelegate;
  const result = await delegate.deleteMany({ where });
  return result.count;
}

/** Borra filas del modelo SOLO dentro de org_hr (`organizationId: ORG_ID` siempre). */
async function deleteOrgScoped(model: OrgScopedModel, extraWhere: Record<string, unknown> = {}): Promise<number> {
  const where = { ...extraWhere, organizationId: ORG_ID };
  const delegate = prisma[model] as unknown as DeleteManyDelegate;
  const result = await delegate.deleteMany({ where });
  return result.count;
}

// ---------------------------------------------------------------------------
// Tenant (idempotente)
// ---------------------------------------------------------------------------

const withUser = (): EmployeeSpec[] => EMPLOYEES.filter((e) => e.user !== undefined);

async function ensureTenant(today: string): Promise<void> {
  const clash = await prisma.legalEntity.findFirst({ where: { taxId: LEGAL_ENTITY_TAX_ID, NOT: { id: LEGAL_ENTITY_ID } }, select: { id: true, organizationId: true } });
  if (clash) {
    throw new Error(`El NIF ${LEGAL_ENTITY_TAX_ID} ya pertenece a la sociedad ${clash.id} (organización ${clash.organizationId}); no se puede crear ${LEGAL_ENTITY_ID}.`);
  }
  for (const principal of PRINCIPAL_USERS) {
    const match = withUser().find((e) => e.user!.local === principal.local && e.user!.templateKey === principal.templateKey);
    if (!match) throw new Error(`El usuario principal ${principal.local} (${principal.templateKey}) no figura entre los EMPLOYEES con usuario.`);
  }

  await prisma.organization.upsert({
    where: { id: ORG_ID },
    update: {},
    create: { id: ORG_ID, name: "HR (pruebas de plantilla y nómina)", legalName: "HR Pruebas SL", taxId: LEGAL_ENTITY_TAX_ID, country: "ES" }
  });
  await prisma.legalEntity.upsert({
    where: { id: LEGAL_ENTITY_ID },
    update: {},
    create: {
      id: LEGAL_ENTITY_ID,
      organizationId: ORG_ID,
      code: "HR",
      legalName: "HR Pruebas SL",
      taxId: LEGAL_ENTITY_TAX_ID,
      legalForm: "sl",
      fiscalAddress: "Rúa da Plantilla 4",
      fiscalPostalCode: "15002",
      fiscalMunicipality: "A Coruña",
      fiscalProvince: "A Coruña",
      cnae: "5510",
      isDefault: true
    }
  });
  await prisma.property.upsert({
    where: { id: PROPERTY_ID },
    update: { starRating: STAR_RATING, agreementId: AGREEMENT_ID },
    create: {
      id: PROPERTY_ID,
      organizationId: ORG_ID,
      legalEntityId: LEGAL_ENTITY_ID,
      code: PROPERTY_CODE,
      kind: "hotel",
      name: PROPERTY_NAME,
      tradeName: PROPERTY_NAME,
      address: "Rúa da Plantilla 4",
      municipality: "A Coruña",
      province: "A Coruña",
      postalCode: "15002",
      ineMunicipalityCode: "15030",
      country: "ES",
      taxRegion: "ES_PENINSULA_BALEARES",
      fiscalTerritory: "common",
      timezone: TIME_ZONE,
      currency: "EUR",
      status: "open",
      goLiveAt: GO_LIVE_AT,
      sesHospedajesEnabled: false,
      verifactuEnabled: false,
      starRating: STAR_RATING,
      bedCapacity: ROOMS_TOTAL * 2,
      openingMonths: 12,
      agreementId: AGREEMENT_ID
    }
  });
  await prisma.businessDate.upsert({
    where: { propertyId: PROPERTY_ID },
    update: { currentDate: dateOnly(today), closedAt: null, closedBy: null },
    create: { propertyId: PROPERTY_ID, currentDate: dateOnly(today) }
  });

  for (const dept of DEPARTMENTS) {
    await prisma.department.upsert({
      where: { id: dept.id },
      update: { name: dept.name, code: dept.code, active: true },
      create: { id: dept.id, propertyId: PROPERTY_ID, name: dept.name, code: dept.code, active: true }
    });
  }
  for (const centre of COST_CENTERS) {
    await prisma.costCenter.upsert({
      where: { id: centre.id },
      update: { name: centre.name, code: centre.code, type: "usali", active: true },
      create: { id: centre.id, propertyId: PROPERTY_ID, code: centre.code, name: centre.name, type: "usali", active: true }
    });
  }

  // Catálogo de permisos + roles de plantilla (22 de organización).
  await syncPermissionCatalog();
  const roles: Record<string, string> = {};
  for (const role of await provisionDefaultTemplateRoles(ORG_ID)) roles[role.templateKey] = role.id;
  const templateKeys = [...new Set(withUser().map((e) => e.user!.templateKey))];
  for (const templateKey of templateKeys) {
    const roleId = roles[templateKey];
    if (!roleId) throw new Error(`Sin rol de plantilla «${templateKey}» en ${ORG_ID}.`);
    // Reaplica la plantilla por si el catálogo ha cambiado desde la última pasada.
    await applyRoleTemplate(roleId, templateKey);
  }

  for (const spec of withUser()) {
    const user = spec.user!;
    const email = emailFor(user.local);
    const name = employeeNameFor(spec.n);
    const existing = await prisma.user.findUnique({ where: { email }, select: { id: true, organizationId: true } });
    if (existing && existing.organizationId !== ORG_ID) {
      throw new Error(`El correo ${email} ya existe en otra organización (${existing.organizationId}); el seed no lo toca.`);
    }
    await prisma.user.upsert({
      where: { email },
      update: {},
      create: {
        id: userIdFor(user.local),
        organizationId: ORG_ID,
        email,
        fullName: `${name.firstName} ${name.lastName}`,
        status: "active",
        passwordHash: hashPassword(DEMO_PASSWORD),
        mustChangePassword: false,
        passwordChangedAt: new Date()
      }
    });
    const roleId = roles[user.templateKey]!;
    const userId = existing?.id ?? userIdFor(user.local);
    const assignment = await prisma.userRoleAssignment.findFirst({ where: { userId, roleId, scopeType: "property", propertyId: PROPERTY_ID, revokedAt: null }, select: { id: true } });
    if (!assignment) {
      await prisma.userRoleAssignment.create({
        data: { userId, roleId, scopeType: "property", propertyId: PROPERTY_ID, organizationId: ORG_ID, reason: "seed hr (tenant de prueba)" }
      });
    }
  }

  // Plan contable (devengo de nómina) y ajustes/impuestos de la propiedad.
  await provisionOrganizationChart(ORG_ID);
  await ensurePropertySettings(PROPERTY_ID);

  // Módulos del producto activados en la propiedad (filas property_modules `enabled`).
  const modules = await prisma.module.findMany({ where: { code: { in: [...ENABLED_MODULES] } }, select: { id: true, code: true } });
  const missing = ENABLED_MODULES.filter((code) => !modules.some((module) => module.code === code));
  if (missing.length > 0) throw new Error(`Módulos sin fila en modules: ${missing.join(", ")} (arranca el API una vez para persistir el catálogo).`);
  const now = new Date();
  for (const module of modules) {
    await prisma.propertyModule.upsert({
      where: { propertyId_moduleId: { propertyId: PROPERTY_ID, moduleId: module.id } },
      update: { status: "enabled", enabledAt: now, disabledAt: null },
      create: { propertyId: PROPERTY_ID, moduleId: module.id, status: "enabled", enabledAt: now }
    });
  }

  // Tipos y 60 habitaciones (inventario de los snapshots y del estándar rooms_inventory).
  for (const type of ROOM_TYPES) {
    await prisma.roomType.upsert({
      where: { id: type.id },
      update: { displayOrder: type.displayOrder, maxOccupancy: type.maxOccupancy },
      create: { id: type.id, propertyId: PROPERTY_ID, code: type.code, name: type.name, maxOccupancy: type.maxOccupancy, baseCapacity: 2, displayOrder: type.displayOrder, active: true, sellable: true }
    });
    for (const number of type.numbers) {
      await prisma.room.upsert({
        where: { id: `hr_room_${number}` },
        update: {},
        create: {
          id: `hr_room_${number}`,
          propertyId: PROPERTY_ID,
          roomTypeId: type.id,
          number: String(number),
          floor: String(Math.floor(number / 100)),
          maxOccupancy: type.maxOccupancy,
          status: "clean",
          housekeepingStatus: "clean",
          maintenanceStatus: "ok",
          sellable: true,
          active: true,
          sortOrder: number
        }
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Reset de la capa RRHH (solo prop_hr / org_hr)
// ---------------------------------------------------------------------------

async function resetHr(): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  counts.timeClockEntry = await deleteScoped("timeClockEntry");
  counts.shift = await deleteScoped("shift");
  counts.absenceRequest = await deleteScoped("absenceRequest");
  counts.laborForecast = await deleteScoped("laborForecast");
  counts.laborStandard = await deleteScoped("laborStandard");
  const planIds = (await prisma.staffingPlan.findMany({ where: { propertyId: PROPERTY_ID }, select: { id: true } })).map((p) => p.id);
  counts.staffingPlanLine = (await prisma.staffingPlanLine.deleteMany({ where: { planId: { in: planIds } } })).count;
  counts.staffingPlan = await deleteScoped("staffingPlan");
  counts.employmentContract = await deleteOrgScoped("employmentContract");
  counts.staffProfile = await deleteScoped("staffProfile");
  counts.employee = await deleteOrgScoped("employee");
  const agreementIds = (await prisma.collectiveAgreement.findMany({ where: { organizationId: ORG_ID }, select: { id: true } })).map((a) => a.id);
  counts.agreementRule = (await prisma.agreementRule.deleteMany({ where: { agreementId: { in: agreementIds } } })).count;
  counts.collectiveAgreement = await deleteOrgScoped("collectiveAgreement");
  counts.payrollPeriod = await deleteOrgScoped("payrollPeriod");
  counts.revenueDailySnapshot = await deleteScoped("revenueDailySnapshot", { dataSource: "demo" });
  counts.revenueForecast = await deleteScoped("revenueForecast", { modelVersion: { in: FORECAST_MODEL_VERSIONS } });
  counts.reservation = await deleteScoped("reservation", { code: { startsWith: DEMO_RESERVATION_PREFIX } });
  return counts;
}

// ---------------------------------------------------------------------------
// Capa RRHH (idempotente por id fijo)
// ---------------------------------------------------------------------------

const jsonOf = (value: unknown): Prisma.InputJsonValue | typeof Prisma.JsonNull => (value === null ? Prisma.JsonNull : (value as Prisma.InputJsonValue));

async function ensureAgreement(): Promise<{ rules: number }> {
  const spec = HR_AGREEMENT_DEFAULTS[AGREEMENT_CODE];
  await prisma.collectiveAgreement.upsert({
    where: { id: AGREEMENT_ID },
    update: { name: spec.name, scope: spec.scope, publishedRef: spec.publishedRef, ultraactivity: spec.ultraactivity },
    create: {
      id: AGREEMENT_ID,
      organizationId: ORG_ID,
      code: spec.code,
      name: spec.name,
      scope: spec.scope,
      publishedRef: spec.publishedRef,
      validFrom: dateOnly(spec.validFrom),
      validTo: spec.validTo ? dateOnly(spec.validTo) : null,
      ultraactivity: spec.ultraactivity
    }
  });
  let rules = 0;
  for (const [key, value] of Object.entries(spec.rules) as Array<[HrAgreementRuleKey, unknown]>) {
    await prisma.agreementRule.upsert({
      where: { id: `${AGREEMENT_ID}_${key}` },
      update: { valueJson: jsonOf(value) },
      create: { id: `${AGREEMENT_ID}_${key}`, agreementId: AGREEMENT_ID, key, valueJson: jsonOf(value), validFrom: dateOnly(spec.validFrom), validTo: spec.validTo ? dateOnly(spec.validTo) : null }
    });
    rules += 1;
  }
  return { rules };
}

async function ensureStandards(year: number): Promise<{ written: number; closed: number }> {
  // Único escritor de labor_standards (standards.service.ts): defaults del sector por estrellas, vigentes desde el 1 de enero.
  const result = await resetLaborStandardDefaults({ context: seedContext(), propertyId: PROPERTY_ID, validFrom: `${year}-01-01`, correlationId: "seed-hr:standards" });
  return { written: result.written, closed: result.closed };
}

async function ensureEmployees(today: string): Promise<{ employees: number; profiles: number; contracts: number }> {
  let employees = 0;
  let profiles = 0;
  let contracts = 0;
  const deptById = new Map(DEPARTMENTS.map((d) => [d.code, d] as const));
  const centreByUsali = new Map(COST_CENTERS.map((c) => [c.usali, c.id] as const));
  for (const spec of EMPLOYEES) {
    const dept = deptById.get(spec.dept)!;
    const name = employeeNameFor(spec.n);
    const user = spec.user;
    const hiredAt = dateOnly(monthsBefore(today, spec.hiredMonthsAgo));
    const userId = user ? userIdFor(user.local) : null;
    const local = user ? user.local : `empleado${spec.n}`;
    await prisma.employee.upsert({
      where: { id: employeeIdFor(spec.n) },
      // Sin PII en el update: la extensión cifra con IV nuevo en cada escritura y el seed debe converger.
      update: { userId, primaryPropertyId: PROPERTY_ID, usaliDepartment: dept.usali, jobTitle: spec.jobTitle, status: spec.status ?? "active", gender: spec.gender },
      create: {
        id: employeeIdFor(spec.n),
        organizationId: ORG_ID,
        legalEntityId: LEGAL_ENTITY_ID,
        employeeNumber: employeeNumberFor(spec.n),
        userId,
        firstName: name.firstName,
        lastName: name.lastName,
        // Cifrados por PII_FIELDS.Employee (taxIdLookupHash lo calcula la extensión).
        taxId: syntheticNieFor(spec.n),
        socialSecurityNumber: syntheticNafFor(spec.n),
        email: emailFor(local),
        phone: `+34600001${String(spec.n).padStart(3, "0")}`,
        iban: syntheticIbanFor(spec.n),
        gender: spec.gender,
        primaryPropertyId: PROPERTY_ID,
        usaliDepartment: dept.usali,
        jobTitle: spec.jobTitle,
        status: spec.status ?? "active",
        hiredAt
      }
    });
    employees += 1;
    if (!user) continue;

    const weeklyHours = user.weeklyHours ?? 40;
    const partTime = weeklyHours < 40;
    await prisma.staffProfile.upsert({
      where: { id: staffProfileIdFor(spec.n) },
      update: { employeeId: employeeIdFor(spec.n), usaliDepartment: dept.usali, jobTitle: spec.jobTitle, departmentId: dept.id, employeeCode: employeeNumberFor(spec.n), active: true },
      create: {
        id: staffProfileIdFor(spec.n),
        userId: userIdFor(user.local),
        propertyId: PROPERTY_ID,
        employeeCode: employeeNumberFor(spec.n),
        departmentId: dept.id,
        employmentType: partTime ? "part_time" : "full_time",
        hourlyCost: HOURLY_COST[dept.usali],
        active: true,
        employeeId: employeeIdFor(spec.n),
        usaliDepartment: dept.usali,
        jobTitle: spec.jobTitle
      }
    });
    profiles += 1;

    const temporary = user.contract === "temporal";
    const contract = {
      staffProfileId: staffProfileIdFor(spec.n),
      propertyId: PROPERTY_ID,
      organizationId: ORG_ID,
      contractType: user.contract,
      startDate: hiredAt,
      endDate: temporary ? dateOnly(isoPlus(today, TEMPORARY_CONTRACT_ENDS_IN_DAYS)) : null,
      grossSalary: money(user.grossSalary),
      payFrequency: "monthly",
      // 12 mensualidades + 3 pagas extraordinarias del convenio ES-15-HOST.
      payCount: 12 + HR_AGREEMENT_DEFAULTS[AGREEMENT_CODE].rules.extra_pay_count,
      irpfRatePct: user.grossSalary >= 3000 ? "19.00" : user.grossSalary >= 2000 ? "15.00" : "12.00",
      costCenterId: centreByUsali.get(dept.usali) ?? null,
      active: true,
      agreementId: AGREEMENT_ID,
      weeklyHours: money(weeklyHours),
      partTimePct: money((weeklyHours / 40) * 100),
      fixedDiscontinuous: user.contract === "fijo_discontinuo",
      contributionGroup: user.group
    };
    await prisma.employmentContract.upsert({ where: { id: contractIdFor(spec.n) }, update: contract, create: { id: contractIdFor(spec.n), ...contract } });
    contracts += 1;
  }
  return { employees, profiles, contracts };
}

async function ensureStaffingPlans(year: number): Promise<{ plans: number; lines: number }> {
  let lines = 0;
  for (const season of STAFFING_SEASONS) {
    await prisma.staffingPlan.upsert({
      where: { id: season.id },
      update: { status: "approved", approvedBy: userIdFor("direccion") },
      create: {
        id: season.id,
        propertyId: PROPERTY_ID,
        year,
        season: season.season,
        fromMonth: season.fromMonth,
        toMonth: season.toMonth,
        status: "approved",
        createdBy: userIdFor("rrhh"),
        approvedBy: userIdFor("direccion"),
        approvedAt: new Date()
      }
    });
    for (const department of FORECAST_DEPARTMENTS) {
      const line = STAFFING_LINES[season.season][department];
      if (!line) continue;
      await prisma.staffingPlanLine.upsert({
        where: { planId_usaliDepartment: { planId: season.id, usaliDepartment: department } },
        update: line,
        create: { id: `${season.id}_${department}`, planId: season.id, usaliDepartment: department, ...line }
      });
      lines += 1;
    }
  }
  return { plans: STAFFING_SEASONS.length, lines };
}

async function ensureRevenueDemo(today: string): Promise<{ snapshots: number; forecasts: number }> {
  const topLevel = { roomTypeId: null, ratePlanId: null, channelId: null, segment: null, market: null };
  const windowStart = dateOnly(isoPlus(today, -(SNAPSHOT_DAYS - 1)));
  // Ídem seed-revenue-snapshots: los demo de la ventana se reemplazan; cualquier cierre real (night_audit) se conserva.
  await deleteScoped("revenueDailySnapshot", { dataSource: "demo", snapshotDate: { gte: windowStart, lte: dateOnly(today) }, ...topLevel });
  const taken = new Set(
    (await prisma.revenueDailySnapshot.findMany({ where: { propertyId: PROPERTY_ID, snapshotDate: { gte: windowStart, lte: dateOnly(today) }, ...topLevel }, select: { snapshotDate: true } })).map((s) =>
      s.snapshotDate.toISOString().slice(0, 10)
    )
  );
  const snapshotRows = [];
  for (let offset = -(SNAPSHOT_DAYS - 1); offset <= 0; offset += 1) {
    const iso = isoPlus(today, offset);
    if (taken.has(iso)) continue;
    const d = demandFor(iso);
    const roomRevenue = round2(d.roomsSold * d.adr);
    const totalRevenue = round2(roomRevenue * 1.28);
    const gop = round2(totalRevenue * 0.38);
    snapshotRows.push({
      propertyId: PROPERTY_ID,
      snapshotDate: dateOnly(iso),
      totalOcc: d.roomsSold,
      arrivalRooms: d.arrivals,
      departureRooms: d.departures,
      adultsChildren: d.pax,
      roomRevenue: money(roomRevenue),
      totalRevenue: money(totalRevenue),
      netRoomRevenue: money(round2(roomRevenue * 0.91)),
      grossOperatingProfit: money(gop),
      adr: money(d.adr),
      revpar: money(round2(roomRevenue / ROOMS_TOTAL)),
      trevpar: money(round2(totalRevenue / ROOMS_TOTAL)),
      goppar: money(round2(gop / ROOMS_TOTAL)),
      occupancyPercent: money(round2((d.roomsSold / ROOMS_TOTAL) * 100)),
      dataSource: "demo"
    });
  }
  await prisma.revenueDailySnapshot.createMany({ data: snapshotRows, skipDuplicates: true });

  await deleteScoped("revenueForecast", { modelVersion: { in: FORECAST_MODEL_VERSIONS } });
  const forecastRows = [];
  // Desde hoy (offset 0): el día en curso también necesita driver (OTB o previsión) para la previsión laboral.
  for (let offset = 0; offset < FORECAST_DAYS; offset += 1) {
    const iso = isoPlus(today, offset);
    const d = demandFor(iso);
    const roomRevenue = round2(d.roomsSold * d.adr);
    forecastRows.push({
      id: `hr_rf_${iso.replace(/-/g, "")}`,
      propertyId: PROPERTY_ID,
      forecastDate: dateOnly(iso),
      expectedOccupancy: money(round2((d.roomsSold / ROOMS_TOTAL) * 100)),
      expectedRoomsSold: money(d.roomsSold),
      expectedAdr: money(d.adr),
      expectedRevpar: money(round2(roomRevenue / ROOMS_TOTAL)),
      expectedRoomRevenue: money(roomRevenue),
      expectedTotalRevenue: money(round2(roomRevenue * 1.28)),
      confidence: "70.00",
      modelVersion: FORECAST_MODEL_VERSION,
      driversJson: [{ driver: "seed-hr demanda determinista por día de la semana y mes" }] as Prisma.InputJsonValue
    });
  }
  await prisma.revenueForecast.createMany({ data: forecastRows, skipDuplicates: true });
  return { snapshots: snapshotRows.length, forecasts: forecastRows.length };
}

/**
 * Reservas demo (SEC-08): una por día en [hoy − 28, hoy + FORECAST_DAYS) con régimen BB entre semana y HB en fin de
 * semana; dan a drivers.service.ts la mezcla de régimen de los cubiertos (sin ella la previsión de A&B queda
 * `covers_unknown`) y OTB corroborante. Sin huésped ni datos personales; se reemplazan enteras en cada ejecución.
 */
async function ensureDemoReservations(today: string): Promise<number> {
  await deleteScoped("reservation", { code: { startsWith: DEMO_RESERVATION_PREFIX } });
  const rows = [];
  for (let offset = -LABOR_FORECAST_DAYS; offset < FORECAST_DAYS; offset += 1) {
    const iso = isoPlus(today, offset);
    const d = demandFor(iso);
    const dow = dateOnly(iso).getUTCDay();
    const roomsCount = Math.max(1, Math.round(d.roomsSold * 0.3));
    rows.push({
      propertyId: PROPERTY_ID,
      code: `${DEMO_RESERVATION_PREFIX}${iso.replace(/-/g, "")}`,
      channel: "direct",
      status: offset < 0 ? "checked_out" : "confirmed",
      arrivalDate: dateOnly(iso),
      departureDate: dateOnly(isoPlus(iso, 2)),
      adults: 2,
      children: 0,
      roomsCount,
      boardType: dow === 5 || dow === 6 ? "HB" : "BB",
      totalAmount: money(round2(roomsCount * d.adr * 2)),
      currency: "EUR"
    });
  }
  await prisma.reservation.createMany({ data: rows as never, skipDuplicates: true });
  return rows.length;
}

async function ensureShiftsAndClocks(today: string, now: Date): Promise<{ shifts: number; clocks: number }> {
  const plan = buildShiftPlan(today);
  const deptByCode = new Map(DEPARTMENTS.map((d) => [d.code, d.id] as const));
  const specByN = new Map(EMPLOYEES.map((e) => [e.n, e] as const));
  // Días sin fichaje: ausencias no aprobadas todavía pero reales (la IT pendiente) y las aprobadas.
  const noClock = new Map<number, Set<string>>();
  for (const absence of ABSENCES) {
    if (absence.status === "rejected") continue;
    const days = noClock.get(absence.n) ?? new Set<string>();
    for (let offset = absence.fromOffset; offset <= absence.toOffset; offset += 1) days.add(isoPlus(today, offset));
    noClock.set(absence.n, days);
  }
  const shiftRows = [];
  const clockRows = [];
  for (const shift of plan) {
    const spec = specByN.get(shift.n)!;
    const past = shift.iso < today;
    const started = shift.startAt.getTime() <= now.getTime();
    const status = past ? "completed" : shift.iso === today && started ? "confirmed" : "scheduled";
    const id = `hr_shift_${String(shift.n).padStart(3, "0")}_${shift.iso.replace(/-/g, "")}`;
    shiftRows.push({
      id,
      propertyId: PROPERTY_ID,
      staffProfileId: staffProfileIdFor(shift.n),
      departmentId: deptByCode.get(spec.dept) ?? null,
      shiftDate: dateOnly(shift.iso),
      startAt: shift.startAt,
      endAt: shift.endAt,
      status,
      roleLabel: shift.roleLabel
    });
    if (!started || noClock.get(shift.n)?.has(shift.iso)) continue;
    const seed = shift.n * 1000 + dayNumberOf(shift.iso);
    const inAt = new Date(shift.startAt.getTime() + Math.round(noise(seed) * 8) * 60_000);
    clockRows.push({ id: `${id.replace("hr_shift_", "hr_tc_")}_in`, propertyId: PROPERTY_ID, staffProfileId: staffProfileIdFor(shift.n), clockType: "in", clockAt: inAt, source: CLOCK_SOURCE, metadataJson: {} });
    if (shift.endAt.getTime() <= now.getTime()) {
      const outAt = new Date(shift.endAt.getTime() + (Math.round(noise(seed + 1) * 10) + 5) * 60_000);
      clockRows.push({ id: `${id.replace("hr_shift_", "hr_tc_")}_out`, propertyId: PROPERTY_ID, staffProfileId: staffProfileIdFor(shift.n), clockType: "out", clockAt: outAt, source: CLOCK_SOURCE, metadataJson: {} });
    }
  }
  await prisma.shift.createMany({ data: shiftRows, skipDuplicates: true });
  await prisma.timeClockEntry.createMany({ data: clockRows, skipDuplicates: true });
  return { shifts: shiftRows.length, clocks: clockRows.length };
}

async function ensureAbsences(today: string): Promise<number> {
  for (const absence of ABSENCES) {
    const requestedBy = userIdFor(EMPLOYEES.find((e) => e.n === absence.n)!.user!.local);
    const decided = absence.status !== "pending";
    // Solo la aprobación fija approvedBy (otro usuario: CHECK absence_requests_requested_ne_approved).
    const approvedBy = absence.status === "approved" && absence.decidedByLocal ? userIdFor(absence.decidedByLocal) : null;
    const data = {
      staffProfileId: staffProfileIdFor(absence.n),
      absenceType: absence.absenceType,
      startDate: dateOnly(isoPlus(today, absence.fromOffset)),
      endDate: dateOnly(isoPlus(today, absence.toOffset)),
      status: absence.status,
      approvedBy,
      requestedBy,
      decidedAt: decided ? new Date() : null,
      reason: absence.reason
    };
    await prisma.absenceRequest.upsert({ where: { id: absence.id }, update: data, create: { id: absence.id, propertyId: PROPERTY_ID, ...data } });
  }
  return ABSENCES.length;
}

async function ensureLaborForecasts(today: string): Promise<{ written: number; degradedDays: number }> {
  // Único escritor de labor_forecasts (labor-forecast.service.ts): drivers reales del tenant (snapshots demo de los
  // últimos 28 días para LOS y pax, previsión pms_import:* y reservas demo con régimen para los cubiertos).
  const result = await generateLaborForecast({ context: seedContext(), propertyId: PROPERTY_ID, from: today, to: isoPlus(today, LABOR_FORECAST_DAYS - 1), correlationId: "seed-hr:labor-forecast", today: dateOnly(today) });
  return { written: result.written, degradedDays: result.degradedDays };
}

export function periodCodeOf(iso: string): string {
  return iso.slice(0, 7);
}

async function ensurePayrollPeriod(today: string): Promise<string> {
  const periodCode = periodCodeOf(today);
  const start = dateOnly(`${periodCode}-01`);
  const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0));
  const id = `hr_pp_${periodCode.replace("-", "")}`;
  await prisma.payrollPeriod.upsert({
    where: { id },
    update: {},
    create: { id, organizationId: ORG_ID, propertyId: PROPERTY_ID, periodCode, startDate: start, endDate: end, status: "open", mode: "external" }
  });
  return periodCode;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const reset = args.includes("--reset");
  const dryRun = args.includes("--dry-run");
  // El seed crea usuarios con contraseña conocida y expedientes ficticios: nunca contra una base de
  // producción (la allowlist de demo-guard permite org_hr en cualquier BD).
  if (process.env.NODE_ENV === "production" && process.env.SEED_HR_ALLOW_PRODUCTION !== "1") {
    throw new Error("[seed-hr] NODE_ENV=production: el tenant de prueba HR (usuarios con contraseña conocida) no se siembra en producción. Exporta SEED_HR_ALLOW_PRODUCTION=1 solo para una demo aislada.");
  }
  const now = new Date();
  const today = todayIn(TIME_ZONE, now);
  const year = Number(today.slice(0, 4));
  const users = withUser();
  const shiftPlan = buildShiftPlan(today);
  const standardCount = effectiveStandardCount();

  const planned: PlannedWrite[] = [
    { table: "organizations / legal_entities / properties / business_dates", op: "upsert", where: `id = ${ORG_ID} / ${LEGAL_ENTITY_ID} / ${PROPERTY_ID}`, count: 4 },
    { table: "departments / cost_centers", op: "upsert", where: `property_id = ${PROPERTY_ID}`, count: DEPARTMENTS.length + COST_CENTERS.length },
    { table: "users + user_role_assignments", op: "upsert", where: `*@${EMAIL_DOMAIN}`, count: users.length },
    { table: "property_modules", op: "upsert", where: `property_id = ${PROPERTY_ID} AND code IN (${ENABLED_MODULES.join(", ")})`, count: ENABLED_MODULES.length },
    { table: "room_types / rooms", op: "upsert", where: `property_id = ${PROPERTY_ID}`, count: ROOM_TYPES.length + ROOMS_TOTAL },
    { table: "collective_agreements + agreement_rules", op: "upsert", where: `organization_id = ${ORG_ID} AND code = ${AGREEMENT_CODE}`, count: 1 + Object.keys(HR_AGREEMENT_DEFAULTS[AGREEMENT_CODE].rules).length },
    { table: "labor_standards (resetLaborStandardDefaults)", op: "upsert", where: `property_id = ${PROPERTY_ID} (sector_default ${STAR_RATING}★)`, count: standardCount },
    { table: "employees (PII cifrada por la extensión)", op: "upsert", where: `organization_id = ${ORG_ID} AND id LIKE 'hr_emp_%'`, count: EMPLOYEES.length },
    { table: "staff_profiles / employment_contracts", op: "upsert", where: `property_id = ${PROPERTY_ID}`, count: users.length * 2 },
    { table: "staffing_plans + staffing_plan_lines", op: "upsert", where: `property_id = ${PROPERTY_ID} AND year = ${year}`, count: STAFFING_SEASONS.length + STAFFING_SEASONS.length * FORECAST_DEPARTMENTS.length },
    { table: "revenue_daily_snapshots (top-level demo, ventana reemplazada) / revenue_forecasts (modelVersion pms_import:seed-hr-demo)", op: "createMany", where: `property_id = ${PROPERTY_ID}`, count: SNAPSHOT_DAYS + FORECAST_DAYS },
    { table: "reservations (demo, régimen conocido; reemplazadas)", op: "createMany", where: `property_id = ${PROPERTY_ID} AND code LIKE '${DEMO_RESERVATION_PREFIX}%'`, count: LABOR_FORECAST_DAYS + FORECAST_DAYS },
    { table: "shifts / time_clock_entries", op: "createMany", where: `property_id = ${PROPERTY_ID} AND id LIKE 'hr_%' (${SHIFT_DAYS_BEFORE + SHIFT_DAYS_AFTER + 1} días)`, count: shiftPlan.length },
    { table: "absence_requests", op: "upsert", where: `property_id = ${PROPERTY_ID}`, count: ABSENCES.length },
    { table: "labor_forecasts (generateLaborForecast)", op: "upsert", where: `property_id = ${PROPERTY_ID} (${LABOR_FORECAST_DAYS} días × ${FORECAST_DEPARTMENTS.length} departamentos)`, count: LABOR_FORECAST_DAYS * FORECAST_DEPARTMENTS.length },
    { table: "payroll_periods", op: "upsert", where: `organization_id = ${ORG_ID} AND period_code = ${periodCodeOf(today)}`, count: 1 }
  ];
  if (reset) {
    planned.unshift(
      { table: "time_clock_entries / shifts / absence_requests / labor_forecasts / labor_standards / staffing_plans / staff_profiles", op: "deleteMany", where: `property_id = ${PROPERTY_ID}` },
      { table: "staffing_plan_lines / agreement_rules", op: "deleteMany", where: `plan_id / agreement_id IN (los de ${PROPERTY_ID} / ${ORG_ID})` },
      { table: "employment_contracts / employees / collective_agreements / payroll_periods", op: "deleteMany", where: `organization_id = ${ORG_ID}` },
      { table: "revenue_daily_snapshots (dataSource demo) / revenue_forecasts (modelVersion pms_import:seed-hr-demo) / reservations (HRDEMO-*)", op: "deleteMany", where: `property_id = ${PROPERTY_ID}` }
    );
  }

  log(
    `[seed-hr] hoy (${TIME_ZONE}) = ${today} · ${EMPLOYEES.length} expedientes (${users.length} con usuario, ficha y contrato) · ${ROOMS_TOTAL} habitaciones · ` +
      `${shiftPlan.length} turnos en ${SHIFT_DAYS_BEFORE + SHIFT_DAYS_AFTER + 1} días · ${ABSENCES.length} ausencias · ${LABOR_FORECAST_DAYS}×${FORECAST_DEPARTMENTS.length} previsiones${reset ? " · --reset" : ""}${dryRun ? " · --dry-run" : ""}`
  );
  if (dryRun) {
    for (const p of planned) log(`  ${p.op.padEnd(10)} ${p.table}${typeof p.count === "number" ? ` ×${p.count}` : ""}${p.where ? ` — ${p.where}` : ""}`);
    log("[seed-hr] dry-run: nada escrito.");
    return;
  }

  assertDemoTarget({ orgId: ORG_ID, propertyId: PROPERTY_ID, action: `seed-hr (${reset ? "reset" : "ensure"})`, planned });

  await ensureTenant(today);
  if (reset) {
    const removed = await resetHr();
    log(`[seed-hr] reset: ${Object.entries(removed).map(([k, v]) => `${k}=${v}`).join(" · ")}`);
  }
  const agreement = await ensureAgreement();
  const seededStandards = await ensureStandards(year);
  const people = await ensureEmployees(today);
  const plans = await ensureStaffingPlans(year);
  const revenue = await ensureRevenueDemo(today);
  const reservations = await ensureDemoReservations(today);
  const shifts = await ensureShiftsAndClocks(today, now);
  const absences = await ensureAbsences(today);
  const forecasts = await ensureLaborForecasts(today);
  const period = await ensurePayrollPeriod(today);
  // Los servicios de RRHH auditan (HR_STANDARDS_CHANGED, HR_FORECAST_GENERATED): la cola se vacía antes de cerrar.
  await flushAuditQueues();

  log(
    `[seed-hr] listo · ${PROPERTY_NAME} (${PROPERTY_ID}) · sociedad ${LEGAL_ENTITY_TAX_ID} · convenio ${AGREEMENT_CODE} (${agreement.rules} reglas) · ` +
      `estándares ${seededStandards.written} (${seededStandards.closed} versiones cerradas)`
  );
  log(`[seed-hr] expedientes ${people.employees} · fichas ${people.profiles} · contratos ${people.contracts} · planes ${plans.plans} (${plans.lines} líneas) · snapshots demo ${revenue.snapshots} · previsiones de ingresos ${revenue.forecasts} · reservas demo ${reservations}`);
  log(`[seed-hr] turnos ${shifts.shifts} · fichajes ${shifts.clocks} · ausencias ${absences} · previsiones laborales ${forecasts.written} (${forecasts.degradedDays} días degradados) · periodo de nómina ${period} open (external)`);
  log(`[seed-hr] usuarios ${users.map((u) => emailFor(u.user!.local)).join(", ")} (contraseña ${DEMO_PASSWORD})`);
}

main()
  .catch((error) => {
    console.error("[seed-hr] ERROR:", error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
