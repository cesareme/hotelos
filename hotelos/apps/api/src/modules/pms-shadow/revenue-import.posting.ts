// OPERA Cloud · modo sombra (Tanda 7b · L2) — regla contable de los ingresos
// diarios, PURA (sin base de datos).
//
// Un asiento por (hotel, business date) con las mismas piezas que el resto de
// reglas canónicas (`signedLine` / `assertBalanced` de posting-rules.ts):
//
//   sourceType  pms_shadow_revenue
//   sourceId    <propertyId>:<YYYY-MM-DD>          (pmsShadowRevenueSourceId de @hotelos/shared)
//   entryDate   business date
//   descripción «Ingresos OPERA · <hotel> · <YYYY-MM-DD>», referencia = business date
//   líneas      por transaction code, en el orden del fichero:
//                 kind revenue → H 705.x (accountCode del mapeo o la cuenta por defecto
//                                del departamento USALI) «<code> · <description>» con
//                                costCenterId del CostCenter USALI del departamento
//                 kind tax     → H 477.xx (accountCode del mapeo o vatOutputAccount(taxRateCode))
//                                con taxRateCode
//               después:
//                 D 4300 = Σ ingresos + Σ impuestos                                   «Clientes · ingresos OPERA del día»
//               y, solo con `includePayments`:
//                 kind payment → D 570 / 572 / 5721 / 5722 por código (el importe del
//                                fichero es negativo en un cobro: se contabiliza −amount)
//                 H 4300 = Σ cobros                                                    «Clientes · cobros OPERA del día»
//               kind ignore (paid out, non revenue, internal, package) → sin línea, va a `totals.other`.
//
// `signedLine` devuelve null a 0 y cambia de lado un importe negativo (una
// corrección de OPERA del mismo día resta del ingreso); `assertBalanced`
// vuelve a comprobar el cuadre. Sin líneas con importe → 400
// PMS_SHADOW_REVENUE_EMPTY. Toda línea `mapped = false` → 400
// OPERA_TRX_CODE_UNMAPPED { codes: [{ code, description, amount }] }: un asiento
// parcial no cuadra con el Trial Balance (diseño §4.3), así que el día se bloquea.
//
// `resolveTrxMapping` aplica `PmsShadowProfile.trxMappingJson` (código plegado)
// a las líneas del parser: REVENUE (o tipo desconocido) con importe ≠ 0 y sin
// entrada → sin mapear; NON REVENUE · PAID OUT · PACKAGE · INTERNAL · PAYMENT sin
// entrada → kind ignore con aviso. `checkTrialBalance` compara Σ importes con el
// «Transaction Total Today» declarado (tolerancia PMS_SHADOW_RECON_TOLERANCES
// .revenueTotal). Las líneas 705.x / 477.x exigen centro de trabajo
// (assertWorkCenter del motor): el asiento SIEMPRE lleva el propertyId del hotel.

import { Prisma } from "@prisma/client";
import {
  PMS_SHADOW_RECON_TOLERANCES,
  PMS_SHADOW_REVENUE_SOURCE_TYPE,
  PMS_SHADOW_USALI_REVENUE_DEPARTMENTS,
  pmsShadowRevenueSourceId,
  type IsoDate,
  type MoneyString,
  type PmsShadowRevenueLine,
  type PmsShadowRevenueReconciliation,
  type PmsShadowRevenueTotals,
  type PmsShadowTrxCodeMapping,
  type PmsShadowUsaliRevenueDepartment
} from "@hotelos/shared";
import { ledgerBadRequest } from "../accounting/accounting.service.js";
import { USALI_DEPARTMENTS } from "../accounting/chart-of-accounts.service.js";
import {
  BANK_ACCOUNT,
  CARD_TERMINAL_ACCOUNT,
  CASH_ACCOUNT,
  CUSTOMER_ACCOUNT,
  PAYMENT_GATEWAY_ACCOUNT,
  REVENUE_ACCOUNT_BY_CATEGORY,
  assertBalanced,
  signedLine,
  vatOutputAccount,
  type RuleEntry,
  type RuleLine
} from "../accounting/posting-rules.js";
import { PAYROLL_COST_CENTRE_TYPE } from "../payroll/cost-import.posting.js";
import type { PmsShadowRevenueParsedLine } from "./revenue-import.parser.js";

type Dec = Prisma.Decimal;
const D = Prisma.Decimal;
const ZERO = new D(0);

export { PMS_SHADOW_REVENUE_SOURCE_TYPE };

/** Tipo de los CostCenter USALI que reutiliza / crea el importador (el mismo que el coste de personal 6c). */
export const PMS_SHADOW_COST_CENTRE_TYPE = PAYROLL_COST_CENTRE_TYPE;

/** Departamento USALI → `CostCenter.code` («rooms» → «ROOMS»), como usaliCostCentreCode de 6c (misma convención, dominio de ingresos). */
export function pmsShadowCostCentreCode(department: PmsShadowUsaliRevenueDepartment): string {
  return department.toUpperCase();
}

/** Nombre en español del CostCenter (USALI_DEPARTMENTS), como usaliCostCentreName de 6c. */
export function pmsShadowCostCentreName(department: PmsShadowUsaliRevenueDepartment): string {
  return USALI_DEPARTMENTS[department];
}

/** Cuenta PGC por defecto de una línea de ingreso según su departamento USALI (§4.3). */
export const PMS_SHADOW_REVENUE_ACCOUNT_BY_DEPARTMENT: Readonly<Record<PmsShadowUsaliRevenueDepartment, string>> = Object.freeze({
  rooms: REVENUE_ACCOUNT_BY_CATEGORY.accommodation!,
  fnb: REVENUE_ACCOUNT_BY_CATEGORY.food_beverage!,
  other_operated: REVENUE_ACCOUNT_BY_CATEGORY.general_services!,
  misc_income: REVENUE_ACCOUNT_BY_CATEGORY.general_services!
});

/** Cuentas de tesorería admitidas en un mapeo `payment` (§4.3). */
export const PMS_SHADOW_PAYMENT_ACCOUNTS: readonly string[] = Object.freeze([CASH_ACCOUNT, BANK_ACCOUNT, CARD_TERMINAL_ACCOUNT, PAYMENT_GATEWAY_ACCOUNT]);

/** Transaction types del XML que, sin mapeo, se ignoran con aviso (no bloquean). */
const NON_BLOCKING_TYPES = new Set(["NON REVENUE", "PAID OUT", "PACKAGE", "INTERNAL", "PAYMENT"]);

function foldCode(code: unknown): string {
  return String(code ?? "")
    .trim()
    .toLowerCase();
}

function isDepartment(value: unknown): value is PmsShadowUsaliRevenueDepartment {
  return typeof value === "string" && (PMS_SHADOW_USALI_REVENUE_DEPARTMENTS as readonly string[]).includes(value);
}

function rateOf(taxRateCode: string | undefined): number | null {
  if (!taxRateCode) return null;
  const match = /^\s*(\d{1,2})(?:[.,]\d+)?\s*%?\s*$/.exec(taxRateCode);
  return match ? Number(match[1]) : null;
}

// ---------------------------------------------------------------------------
// Mapeo
// ---------------------------------------------------------------------------

export type ResolvedTrxMapping = {
  /** Todas las líneas, en el orden del fichero, con kind / cuenta / departamento resueltos (`mapped` true o false). */
  resolved: PmsShadowRevenueLine[];
  /** Subconjunto con `mapped = false` (bloquean la contabilización). */
  unmapped: PmsShadowRevenueLine[];
  /** Avisos en español (códigos ignorados, cuentas por defecto…). */
  warnings: string[];
};

/**
 * Aplica el mapeo del perfil a las líneas del parser. Código plegado (trim +
 * minúsculas). Sin entrada: REVENUE (o tipo vacío / desconocido) con importe ≠ 0
 * → `mapped: false`; el resto → kind ignore con aviso. Con entrada: kind del
 * mapeo, cuenta explícita o por defecto (revenue: por departamento; tax:
 * vatOutputAccount del tipo; payment: 570), departamento por defecto
 * `other_operated` con aviso.
 */
export function resolveTrxMapping(lines: readonly PmsShadowRevenueParsedLine[], mapping: readonly PmsShadowTrxCodeMapping[]): ResolvedTrxMapping {
  const byCode = new Map<string, PmsShadowTrxCodeMapping>();
  for (const entry of mapping) {
    const key = foldCode(entry.code);
    if (key === "" || byCode.has(key)) continue;
    byCode.set(key, entry);
  }
  const resolved: PmsShadowRevenueLine[] = [];
  const unmapped: PmsShadowRevenueLine[] = [];
  const warnings: string[] = [];
  for (const line of lines) {
    const amount = new D(line.amount);
    const type = line.transactionType.trim().toUpperCase();
    const entry = byCode.get(foldCode(line.code));
    const base: PmsShadowRevenueLine = {
      code: line.code,
      description: line.description || (entry?.description ?? ""),
      transactionType: line.transactionType,
      amount: line.amount,
      ...(line.ledgers ? { ledgers: line.ledgers } : {}),
      mapped: true
    };
    if (!entry) {
      if (NON_BLOCKING_TYPES.has(type)) {
        warnings.push(`código ${line.code} (${type}${line.description ? ` · ${line.description}` : ""}) sin mapeo: se ignora (${line.amount}).`);
        resolved.push({ ...base, kind: "ignore", accountCode: null, usaliDepartment: null });
        continue;
      }
      if (amount.isZero()) {
        resolved.push({ ...base, kind: "ignore", accountCode: null, usaliDepartment: null });
        continue;
      }
      const missing: PmsShadowRevenueLine = { ...base, kind: undefined, accountCode: null, usaliDepartment: null, mapped: false };
      resolved.push(missing);
      unmapped.push(missing);
      continue;
    }
    switch (entry.kind) {
      case "revenue": {
        let department: PmsShadowUsaliRevenueDepartment;
        if (isDepartment(entry.usaliDepartment)) {
          department = entry.usaliDepartment;
        } else {
          department = "other_operated";
          warnings.push(`código ${line.code}: el mapeo no indica departamento USALI válido; se usa «other_operated».`);
        }
        const accountCode = entry.accountCode?.trim() || PMS_SHADOW_REVENUE_ACCOUNT_BY_DEPARTMENT[department];
        resolved.push({ ...base, kind: "revenue", accountCode, usaliDepartment: department });
        break;
      }
      case "tax": {
        const rate = rateOf(entry.taxRateCode);
        const accountCode = entry.accountCode?.trim() || (rate !== null ? vatOutputAccount(rate) : null);
        if (!accountCode) {
          warnings.push(`código ${line.code}: mapeo de impuesto sin cuenta ni tipo (taxRateCode); complétalo.`);
          const missing: PmsShadowRevenueLine = { ...base, kind: "tax", accountCode: null, usaliDepartment: null, mapped: false };
          resolved.push(missing);
          unmapped.push(missing);
          break;
        }
        resolved.push({ ...base, kind: "tax", accountCode, usaliDepartment: null });
        break;
      }
      case "payment": {
        let accountCode = entry.accountCode?.trim() || "";
        if (accountCode === "") {
          accountCode = CASH_ACCOUNT;
          warnings.push(`código ${line.code}: mapeo de cobro sin cuenta; se usa ${CASH_ACCOUNT} (caja).`);
        } else if (!PMS_SHADOW_PAYMENT_ACCOUNTS.includes(accountCode)) {
          warnings.push(`código ${line.code}: cuenta de cobro ${accountCode} fuera de las habituales (${PMS_SHADOW_PAYMENT_ACCOUNTS.join(" / ")}).`);
        }
        resolved.push({ ...base, kind: "payment", accountCode, usaliDepartment: null });
        break;
      }
      case "ignore":
      default:
        resolved.push({ ...base, kind: "ignore", accountCode: null, usaliDepartment: null });
        break;
    }
  }
  return { resolved, unmapped, warnings };
}

// ---------------------------------------------------------------------------
// Totales
// ---------------------------------------------------------------------------

function money(value: Dec): MoneyString {
  return value.toDecimalPlaces(2, D.ROUND_HALF_UP).toFixed(2);
}

/** Σ por naturaleza: revenue · tax (importes del fichero), payments (cobros en positivo = −importe), other (ignore y sin mapear). */
export function sumRevenueTotals(lines: readonly PmsShadowRevenueLine[]): PmsShadowRevenueTotals {
  let revenue: Dec = ZERO;
  let tax: Dec = ZERO;
  let payments: Dec = ZERO;
  let other: Dec = ZERO;
  for (const line of lines) {
    const amount = new D(line.amount);
    if (!line.mapped) {
      other = other.plus(amount);
      continue;
    }
    switch (line.kind) {
      case "revenue":
        revenue = revenue.plus(amount);
        break;
      case "tax":
        tax = tax.plus(amount);
        break;
      case "payment":
        payments = payments.plus(amount.negated());
        break;
      default:
        other = other.plus(amount);
        break;
    }
  }
  return { revenue: money(revenue), tax: money(tax), payments: money(payments), other: money(other) };
}

// ---------------------------------------------------------------------------
// Asiento
// ---------------------------------------------------------------------------

export type PmsShadowRevenueEntryInput = {
  propertyId: string;
  /** Property.code (RA, LT…) o el nombre: va a la descripción del asiento. */
  hotelLabel: string;
  businessDate: IsoDate;
  /** Líneas ya resueltas por `resolveTrxMapping` (todas `mapped = true`). */
  lines: readonly PmsShadowRevenueLine[];
  /** Contabiliza también los cobros (D 57x / H 4300); por defecto solo ingresos e impuestos. */
  includePayments?: boolean;
  /** Departamento USALI → id del CostCenter de la propiedad (creados por el servicio). */
  costCentreIds: ReadonlyMap<string, string>;
};

export type PmsShadowRevenueEntry = RuleEntry & {
  propertyId: string;
  businessDate: IsoDate;
  totals: PmsShadowRevenueTotals;
};

function lineLabel(line: PmsShadowRevenueLine): string {
  return line.description ? `${line.code} · ${line.description}` : line.code;
}

/**
 * Asiento diario. Lanza 400 OPERA_TRX_CODE_UNMAPPED si alguna línea no está
 * mapeada y 400 PMS_SHADOW_REVENUE_EMPTY si ninguna línea aporta importe.
 */
export function buildPmsShadowRevenueEntry(input: PmsShadowRevenueEntryInput): PmsShadowRevenueEntry {
  const unmapped = input.lines.filter((line) => !line.mapped);
  if (unmapped.length > 0) {
    throw ledgerBadRequest("OPERA_TRX_CODE_UNMAPPED", `${unmapped.length} transaction code(s) sin mapear: complétalos en el perfil antes de contabilizar el día.`, {
      codes: unmapped.map((line) => ({ code: line.code, description: line.description, amount: line.amount }))
    });
  }
  const warnings: string[] = [];
  const revenueLines: RuleLine[] = [];
  const taxLines: RuleLine[] = [];
  const paymentLines: RuleLine[] = [];
  let revenueTotal: Dec = ZERO;
  let taxTotal: Dec = ZERO;
  let paymentTotal: Dec = ZERO;
  for (const line of input.lines) {
    const amount = new D(line.amount).toDecimalPlaces(2, D.ROUND_HALF_UP);
    if (line.kind === "revenue") {
      const department = line.usaliDepartment && isDepartment(line.usaliDepartment) ? line.usaliDepartment : "other_operated";
      const accountCode = line.accountCode || PMS_SHADOW_REVENUE_ACCOUNT_BY_DEPARTMENT[department];
      const costCenterId = input.costCentreIds.get(department) ?? null;
      if (!costCenterId) warnings.push(`código ${line.code}: sin centro de coste USALI para «${department}»; la línea 705 va sin centro.`);
      const rule = signedLine(accountCode, "credit", amount, { description: lineLabel(line), costCenterId });
      if (rule) revenueLines.push(rule);
      revenueTotal = revenueTotal.plus(amount);
    } else if (line.kind === "tax") {
      const accountCode = line.accountCode || vatOutputAccount(21);
      const rateMatch = /^477\.(\d{2})$/.exec(accountCode);
      const rule = signedLine(accountCode, "credit", amount, { description: lineLabel(line), taxRateCode: rateMatch ? String(Number(rateMatch[1])) : null });
      if (rule) taxLines.push(rule);
      taxTotal = taxTotal.plus(amount);
    } else if (line.kind === "payment") {
      if (!input.includePayments) continue;
      const received = amount.negated();
      const rule = signedLine(line.accountCode || CASH_ACCOUNT, "debit", received, { description: lineLabel(line) });
      if (rule) paymentLines.push(rule);
      paymentTotal = paymentTotal.plus(received);
    }
  }
  const lines: RuleLine[] = [...revenueLines, ...taxLines];
  const customerDebit = signedLine(CUSTOMER_ACCOUNT, "debit", revenueTotal.plus(taxTotal), { description: `Clientes · ingresos OPERA del día ${input.businessDate}` });
  if (customerDebit) lines.push(customerDebit);
  if (input.includePayments && paymentLines.length > 0) {
    lines.push(...paymentLines);
    const customerCredit = signedLine(CUSTOMER_ACCOUNT, "credit", paymentTotal, { description: `Clientes · cobros OPERA del día ${input.businessDate}` });
    if (customerCredit) lines.push(customerCredit);
  }
  if (lines.length === 0) {
    throw ledgerBadRequest("PMS_SHADOW_REVENUE_EMPTY", "Ninguna línea del fichero aporta importe contabilizable (ingresos, impuestos o cobros): nada que contabilizar.");
  }
  assertBalanced(lines);
  return {
    sourceType: PMS_SHADOW_REVENUE_SOURCE_TYPE,
    sourceId: pmsShadowRevenueSourceId(input.propertyId, input.businessDate),
    entryDate: input.businessDate,
    description: `Ingresos OPERA · ${input.hotelLabel} · ${input.businessDate}`,
    reference: input.businessDate,
    entryKind: "normal",
    lines,
    warnings,
    propertyId: input.propertyId,
    businessDate: input.businessDate,
    totals: sumRevenueTotals(input.lines)
  };
}

// ---------------------------------------------------------------------------
// Cuadre con el Trial Balance
// ---------------------------------------------------------------------------

/**
 * Σ total_amount del fichero frente al «Transaction Total Today» declarado
 * (regla de Oracle para el XML de Revenue). Sin valor declarado → ok (nada que
 * comparar). Tolerancia PMS_SHADOW_RECON_TOLERANCES.revenueTotal.
 */
export function checkTrialBalance(sumTotalAmount: MoneyString, declared?: MoneyString | null): PmsShadowRevenueReconciliation {
  const sum = new D(sumTotalAmount);
  if (declared === undefined || declared === null || String(declared).trim() === "") {
    return { sumTotalAmount: money(sum), delta: "0.00", ok: true };
  }
  const expected = new D(String(declared).trim().replace(",", "."));
  const delta = sum.minus(expected);
  const tolerance = new D(PMS_SHADOW_RECON_TOLERANCES.revenueTotal);
  return { transactionTotalToday: money(expected), sumTotalAmount: money(sum), delta: money(delta), ok: delta.abs().lte(tolerance) };
}
