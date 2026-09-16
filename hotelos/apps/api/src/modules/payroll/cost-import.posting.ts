// Coste de personal importado (Tanda 6c · L1) — regla contable, PURA.
//
// Por cada celda (centro, mes) del plan construye UN `RuleEntry` con las
// mismas piezas que el resto de reglas canónicas (`signedLine` / `assertBalanced`
// de posting-rules.ts y las constantes SALARIES_ACCOUNT 640, EMPLOYER_SS_ACCOUNT
// 642, WAGES_PAYABLE_ACCOUNT 465, SOCIAL_SECURITY_ACCOUNT 476):
//
//   sourceType  payroll_cost_import
//   sourceId    <importId>:<propertyId>:<periodCode>   (nunca el sufijo `#n` del puente: cada lote lleva un importId nuevo)
//   entryDate   último día del mes (UTC; bisiestos: 2028-02 → 29)
//   descripción «Coste de personal MM/AAAA · <centro> (importado)», referencia = periodCode
//   líneas      por departamento USALI ordenado por clave:
//                 D 640 bruto  (costCenterId del CostCenter usali del centro) «Sueldos y salarios · <departamento>»
//               después, por departamento:
//                 D 642 SS empresa (mismo costCenterId)                       «Seguridad Social empresa · <departamento>»
//               y al final:
//                 H 465 Σ bruto  «Remuneraciones pendientes de pago · coste importado»
//                 H 476 Σ SS     «Seguridad Social acreedora · coste importado»
//
// Simplificación documentada (diseño §3.4): devengo del coste empresa; sin IRPF
// ni SS del trabajador (el pago y las retenciones se registran aparte por
// tesorería contra 465 / 476). Sin IVA → Modelo 303 invariante.
//
// Casos límite: `signedLine` devuelve null a 0 y cambia de lado un importe
// negativo (el parser ya rechaza negativos); celda toda a 0 → sin asiento +
// aviso; plan sin celdas (o todas a 0) → 400 PAYROLL_IMPORT_EMPTY.

import { Prisma } from "@prisma/client";
import type { PayrollCostUsaliDepartment } from "@hotelos/shared";
import { ledgerBadRequest } from "../accounting/accounting.service.js";
import { USALI_DEPARTMENTS } from "../accounting/chart-of-accounts.service.js";
import {
  EMPLOYER_SS_ACCOUNT,
  SALARIES_ACCOUNT,
  SOCIAL_SECURITY_ACCOUNT,
  WAGES_PAYABLE_ACCOUNT,
  assertBalanced,
  signedLine,
  type RuleEntry,
  type RuleLine
} from "../accounting/posting-rules.js";

type Dec = Prisma.Decimal;
const D = Prisma.Decimal;
const ZERO = new D(0);

export const PAYROLL_COST_SOURCE_TYPE = "payroll_cost_import";

/** Tipo de los CostCenter creados al vuelo por la importación (code = departamento USALI en mayúsculas). */
export const PAYROLL_COST_CENTRE_TYPE = "usali";

/** Departamento USALI → `CostCenter.code` («rooms» → «ROOMS», «admin_general» → «ADMIN_GENERAL»). */
export function usaliCostCentreCode(department: PayrollCostUsaliDepartment): string {
  return department.toUpperCase();
}

/** Nombre en español del CostCenter (USALI_DEPARTMENTS). */
export function usaliCostCentreName(department: PayrollCostUsaliDepartment): string {
  return USALI_DEPARTMENTS[department];
}

/** `<importId>:<propertyId>:<periodCode>`. */
export function payrollCostSourceId(importId: string, propertyId: string, periodCode: string): string {
  return `${importId}:${propertyId}:${periodCode}`;
}

function monthParts(periodCode: string): { year: number; month: number } {
  const match = /^(\d{4})-(\d{2})$/.exec(periodCode);
  if (!match) throw ledgerBadRequest("PAYROLL_IMPORT_INVALID", `Mes «${periodCode}» no válido: usa YYYY-MM.`, { errors: [{ line: null, message: `mes «${periodCode}» no válido` }] });
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (month < 1 || month > 12) throw ledgerBadRequest("PAYROLL_IMPORT_INVALID", `Mes «${periodCode}» no válido: el mes debe estar entre 01 y 12.`, { errors: [{ line: null, message: `mes «${periodCode}» no válido` }] });
  return { year, month };
}

/** Días del mes (UTC): 2028-02 → 29, 2026-02 → 28, 2026-04 → 30. */
export function daysInMonth(periodCode: string): number {
  const { year, month } = monthParts(periodCode);
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** "YYYY-MM-DD" del último día del mes (fecha contable del devengo). */
export function lastDayOfMonth(periodCode: string): string {
  return `${periodCode}-${String(daysInMonth(periodCode)).padStart(2, "0")}`;
}

/** "MM/AAAA" para descripciones. */
export function periodLabel(periodCode: string): string {
  const { year, month } = monthParts(periodCode);
  return `${String(month).padStart(2, "0")}/${year}`;
}

export type PayrollCostPostingDepartment = {
  usaliDepartment: PayrollCostUsaliDepartment;
  /** CostCenter { propertyId, code: USALI en mayúsculas, type "usali" } ya creado por el servicio. */
  costCenterId: string;
  gross: Dec | string | number;
  employerSs: Dec | string | number;
};

export type PayrollCostPostingCell = {
  propertyId: string;
  /** Property.code (RA, LT, OC…) o, si no hay, el nombre: va a la descripción del asiento. */
  propertyCode: string | null;
  propertyName: string | null;
  periodCode: string;
  departments: PayrollCostPostingDepartment[];
};

export type PayrollCostEntry = RuleEntry & {
  propertyId: string;
  periodCode: string;
  /** Σ D 640 = H 465 y Σ D 642 = H 476, a 2 decimales. */
  totalGross: string;
  totalEmployerSs: string;
};

function toDec(value: Dec | string | number): Dec {
  return value instanceof D ? value : new D(typeof value === "number" ? value.toString() : value);
}

function centreLabel(cell: Pick<PayrollCostPostingCell, "propertyCode" | "propertyName" | "propertyId">): string {
  return cell.propertyCode?.trim() || cell.propertyName?.trim() || cell.propertyId;
}

/**
 * Asiento de devengo de una celda (centro, mes); null cuando todos los importes
 * son 0 (la celda no genera asiento; el llamador avisa).
 */
export function buildPayrollCostEntry(input: { importId: string; cell: PayrollCostPostingCell }): PayrollCostEntry | null {
  const { importId, cell } = input;
  const departments = [...cell.departments].sort((a, b) => a.usaliDepartment.localeCompare(b.usaliDepartment));
  const lines: RuleLine[] = [];
  let totalGross: Dec = ZERO;
  let totalEmployerSs: Dec = ZERO;
  const salaryLines: RuleLine[] = [];
  const ssLines: RuleLine[] = [];
  for (const department of departments) {
    const gross = toDec(department.gross).toDecimalPlaces(2, D.ROUND_HALF_UP);
    const employerSs = toDec(department.employerSs).toDecimalPlaces(2, D.ROUND_HALF_UP);
    const label = usaliCostCentreName(department.usaliDepartment);
    const salary = signedLine(SALARIES_ACCOUNT, "debit", gross, { description: `Sueldos y salarios · ${label}`, costCenterId: department.costCenterId });
    if (salary) salaryLines.push(salary);
    const ss = signedLine(EMPLOYER_SS_ACCOUNT, "debit", employerSs, { description: `Seguridad Social empresa · ${label}`, costCenterId: department.costCenterId });
    if (ss) ssLines.push(ss);
    totalGross = totalGross.plus(gross);
    totalEmployerSs = totalEmployerSs.plus(employerSs);
  }
  lines.push(...salaryLines, ...ssLines);
  const wages = signedLine(WAGES_PAYABLE_ACCOUNT, "credit", totalGross, { description: "Remuneraciones pendientes de pago · coste importado" });
  if (wages) lines.push(wages);
  const socialSecurity = signedLine(SOCIAL_SECURITY_ACCOUNT, "credit", totalEmployerSs, { description: "Seguridad Social acreedora · coste importado" });
  if (socialSecurity) lines.push(socialSecurity);
  if (lines.length === 0) return null;
  assertBalanced(lines);
  return {
    sourceType: PAYROLL_COST_SOURCE_TYPE,
    sourceId: payrollCostSourceId(importId, cell.propertyId, cell.periodCode),
    entryDate: lastDayOfMonth(cell.periodCode),
    description: `Coste de personal ${periodLabel(cell.periodCode)} · ${centreLabel(cell)} (importado)`,
    reference: cell.periodCode,
    entryKind: "normal",
    lines,
    warnings: [],
    propertyId: cell.propertyId,
    periodCode: cell.periodCode,
    totalGross: totalGross.toFixed(2),
    totalEmployerSs: totalEmployerSs.toFixed(2)
  };
}

/**
 * Asientos de todas las celdas del plan, en orden (mes, centro). Las celdas a 0
 * no generan asiento y se avisan; sin celdas o todas a 0 → 400 PAYROLL_IMPORT_EMPTY.
 */
export function buildPayrollCostEntries(input: { importId: string; cells: readonly PayrollCostPostingCell[] }): { entries: PayrollCostEntry[]; warnings: string[] } {
  const warnings: string[] = [];
  const entries: PayrollCostEntry[] = [];
  const cells = [...input.cells].sort((a, b) => a.periodCode.localeCompare(b.periodCode) || a.propertyId.localeCompare(b.propertyId));
  for (const cell of cells) {
    const entry = buildPayrollCostEntry({ importId: input.importId, cell });
    if (!entry) {
      warnings.push(`${centreLabel(cell)} · ${cell.periodCode}: todos los importes son 0; no se genera asiento`);
      continue;
    }
    entries.push(entry);
  }
  if (entries.length === 0) {
    throw ledgerBadRequest("PAYROLL_IMPORT_EMPTY", "El lote no contiene líneas de coste con importe: nada que contabilizar.", { cells: cells.length });
  }
  return { entries, warnings };
}
