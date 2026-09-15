// Cuentas anuales PGC de Pymes (RD 1515/2007) from the ledger (Finanzas ·
// lote usali-cuentas): balance de situación, cuenta de pérdidas y ganancias,
// estado de cambios en el patrimonio neto and memoria, plus persisted
// snapshots (FinancialStatementSnapshot).
//
// Everything is a pure function over three ledger reads (see source.ts):
//   rowsAt        = balance_at(to)            cumulative balances at the close
//   rowsBefore    = balance_at(from − 1 day)  opening balances
//   rowsMovements = movements(from, to)       the period, without
//                                             regularization/closing/opening
// Presentation rules:
//   · balance lines are classified by PGC code prefix (longest prefix wins;
//     dots removed: 477.21 → 47721 → 477); assets are debit-natural amounts
//     (28x/29x/39x/49x contra accounts appear negative inside their line),
//     equity and liabilities credit-natural. Anything the tables do not cover
//     lands in a visible «sin clasificar» line of its side (by Account.kind),
//     never dropped, so activo = patrimonio neto + pasivo holds for ANY
//     balanced ledger (Σ debit − credit over every account is 0).
//   · «VII. Resultado del ejercicio» = income − expense of the period
//     (identical to the P&L result); 129 is presented as the carried
//     result of previous years (129 at from − 1 plus its non-regularisation
//     movements: the distribution entries), and P&L balances of entries
//     dated before the period that were never regularised go to their own
//     equity line with a warning. This keeps the identity whether or not
//     the year was closed with the regularization entry.
//   · P&L lines follow the PGC Pymes model; income positive, expenses
//     negative, so every subtotal is a plain sum.

import { prisma } from "@hotelos/database";
import type { UserContext } from "../../lib/demo-store.js";
import { BadRequestError, NotFoundError } from "../../lib/http-error.js";
import { recordAuditEvent } from "../audit/audit.service.js";
import { requirePermissions } from "../auth/auth.service.js";
import { accountDigits } from "../accounting/chart-of-accounts.service.js";
import type {
  AnnualAccounts,
  EcpnColumnKey,
  EcpnRow,
  FinancialStatementKindKey,
  FinancialStatementSnapshotDetail,
  FinancialStatementSnapshotRow,
  MemoriaNote,
  PgcBalanceSheet,
  PgcEquityChanges,
  PgcMemoria,
  PgcProfitAndLoss,
  StatementAccountAmount,
  StatementLine
} from "../../../../../packages/shared/src/financial-statements-types.js";
import { D, ZERO, money, round2, sameCents, sumDec, type Dec } from "./money.js";
import {
  addDays,
  isoDay,
  prismaFinancialStatementsSource,
  type AccountBalanceRow,
  type FinancialStatementsSource,
  type FixedAssetLite,
  type OrganizationLite,
  type PropertyLite,
  type VatTotalsRow
} from "./source.js";
import { buildUsaliPnl } from "./usali.service.js";

// ---------------------------------------------------------------------------
// Prefix tables
// ---------------------------------------------------------------------------

type Side = "asset" | "equity" | "liability";
type BalanceSection = "assets_nc" | "assets_c" | "equity" | "liab_nc" | "liab_c";

type BalanceLineDef = { id: string; label: string; section: BalanceSection; level: number; fallback?: boolean };

export const BALANCE_LINES: BalanceLineDef[] = [
  { id: "A_I", label: "I. Inmovilizado intangible", section: "assets_nc", level: 1 },
  { id: "A_II", label: "II. Inmovilizado material", section: "assets_nc", level: 1 },
  { id: "A_III", label: "III. Inversiones inmobiliarias", section: "assets_nc", level: 1 },
  { id: "A_IV", label: "IV. Inversiones en empresas del grupo y asociadas a largo plazo", section: "assets_nc", level: 1 },
  { id: "A_V", label: "V. Inversiones financieras a largo plazo", section: "assets_nc", level: 1 },
  { id: "A_VI", label: "VI. Activos por impuesto diferido", section: "assets_nc", level: 1 },
  { id: "B_I", label: "I. Existencias", section: "assets_c", level: 1 },
  { id: "B_II", label: "II. Deudores comerciales y otras cuentas a cobrar", section: "assets_c", level: 1 },
  { id: "B_III", label: "III. Inversiones en empresas del grupo y asociadas a corto plazo", section: "assets_c", level: 1 },
  { id: "B_IV", label: "IV. Inversiones financieras a corto plazo", section: "assets_c", level: 1 },
  { id: "B_V", label: "V. Periodificaciones a corto plazo", section: "assets_c", level: 1 },
  { id: "B_VI", label: "VI. Efectivo y otros activos líquidos equivalentes", section: "assets_c", level: 1 },
  { id: "B_X", label: "VII. Otros activos sin clasificar (revisar plan de cuentas)", section: "assets_c", level: 1, fallback: true },
  { id: "E_I", label: "I. Capital", section: "equity", level: 1 },
  { id: "E_II", label: "II. Prima de emisión", section: "equity", level: 1 },
  { id: "E_III", label: "III. Reservas", section: "equity", level: 1 },
  { id: "E_IV", label: "IV. (Acciones y participaciones en patrimonio propias)", section: "equity", level: 1 },
  { id: "E_V", label: "V. Resultados de ejercicios anteriores", section: "equity", level: 1 },
  { id: "E_VI", label: "VI. Otras aportaciones de socios", section: "equity", level: 1 },
  { id: "E_VII", label: "VII. Resultado del ejercicio", section: "equity", level: 1 },
  { id: "E_VIII", label: "VIII. (Dividendo a cuenta)", section: "equity", level: 1 },
  { id: "E_S", label: "A-2) Subvenciones, donaciones y legados recibidos", section: "equity", level: 1 },
  { id: "E_PR", label: "Resultados de ejercicios anteriores pendientes de regularizar", section: "equity", level: 1, fallback: true },
  { id: "E_X", label: "Otras partidas de patrimonio neto sin clasificar (revisar plan de cuentas)", section: "equity", level: 1, fallback: true },
  { id: "L_I", label: "I. Provisiones a largo plazo", section: "liab_nc", level: 1 },
  { id: "L_II", label: "II. Deudas a largo plazo", section: "liab_nc", level: 1 },
  { id: "L_III", label: "III. Deudas con empresas del grupo y asociadas a largo plazo", section: "liab_nc", level: 1 },
  { id: "L_IV", label: "IV. Pasivos por impuesto diferido", section: "liab_nc", level: 1 },
  { id: "L_V", label: "V. Periodificaciones a largo plazo", section: "liab_nc", level: 1 },
  { id: "C_I", label: "I. Provisiones a corto plazo", section: "liab_c", level: 1 },
  { id: "C_II", label: "II. Deudas a corto plazo", section: "liab_c", level: 1 },
  { id: "C_III", label: "III. Deudas con empresas del grupo y asociadas a corto plazo", section: "liab_c", level: 1 },
  { id: "C_IV", label: "IV. Acreedores comerciales y otras cuentas a pagar", section: "liab_c", level: 1 },
  { id: "C_V", label: "V. Periodificaciones a corto plazo", section: "liab_c", level: 1 },
  { id: "C_X", label: "VI. Otros pasivos sin clasificar (revisar plan de cuentas)", section: "liab_c", level: 1, fallback: true }
];

/** PGC code prefix (digits only) → balance line id. Longest prefix wins. */
export const BALANCE_PREFIXES: Record<string, string> = {
  "20": "A_I", "280": "A_I", "290": "A_I",
  "21": "A_II", "23": "A_II", "281": "A_II", "291": "A_II",
  "22": "A_III", "282": "A_III", "292": "A_III",
  "24": "A_IV", "293": "A_IV", "294": "A_IV",
  "25": "A_V", "26": "A_V", "295": "A_V", "296": "A_V", "297": "A_V", "298": "A_V",
  "474": "A_VI",
  "3": "B_I", "407": "B_I",
  "43": "B_II", "44": "B_II", "460": "B_II", "470": "B_II", "471": "B_II", "472": "B_II", "473": "B_II", "49": "B_II", "544": "B_II",
  "53": "B_III",
  "54": "B_IV", "565": "B_IV", "566": "B_IV", "58": "B_IV", "59": "B_IV",
  "480": "B_V", "567": "B_V",
  "57": "B_VI",
  "100": "E_I", "101": "E_I", "102": "E_I", "103": "E_I", "104": "E_I",
  "110": "E_II",
  "11": "E_III",
  "108": "E_IV", "109": "E_IV",
  "120": "E_V", "121": "E_V", "129": "E_V",
  "118": "E_VI",
  "557": "E_VIII",
  "13": "E_S",
  "14": "L_I",
  "15": "L_II", "17": "L_II", "18": "L_II",
  "16": "L_III",
  "479": "L_IV",
  "181": "L_V",
  "499": "C_I", "529": "C_I",
  "50": "C_II", "51": "C_II", "52": "C_II", "55": "C_II", "560": "C_II", "561": "C_II",
  "40": "C_IV", "41": "C_IV", "438": "C_IV", "465": "C_IV", "466": "C_IV", "475": "C_IV", "476": "C_IV", "477": "C_IV",
  "485": "C_V", "568": "C_V"
};

const SECTION_SIDE: Record<BalanceSection, Side> = { assets_nc: "asset", assets_c: "asset", equity: "equity", liab_nc: "liability", liab_c: "liability" };

type PygLineDef = { id: string; label: string; block: "operating" | "financial" | "tax"; fallback?: boolean };

export const PYG_LINES: PygLineDef[] = [
  { id: "P1", label: "1. Importe neto de la cifra de negocios", block: "operating" },
  { id: "P2", label: "2. Variación de existencias de productos terminados y en curso de fabricación", block: "operating" },
  { id: "P3", label: "3. Trabajos realizados por la empresa para su activo", block: "operating" },
  { id: "P4", label: "4. Aprovisionamientos", block: "operating" },
  { id: "P5", label: "5. Otros ingresos de explotación", block: "operating" },
  { id: "P6", label: "6. Gastos de personal", block: "operating" },
  { id: "P7", label: "7. Otros gastos de explotación", block: "operating" },
  { id: "P8", label: "8. Amortización del inmovilizado", block: "operating" },
  { id: "P9", label: "9. Imputación de subvenciones de inmovilizado no financiero y otras", block: "operating" },
  { id: "P10", label: "10. Excesos de provisiones", block: "operating" },
  { id: "P11", label: "11. Deterioro y resultado por enajenaciones del inmovilizado", block: "operating" },
  { id: "P12", label: "12. Otros resultados", block: "operating" },
  { id: "P19", label: "Otras partidas de explotación sin clasificar (revisar plan de cuentas)", block: "operating", fallback: true },
  { id: "P13", label: "13. Ingresos financieros", block: "financial" },
  { id: "P14", label: "14. Gastos financieros", block: "financial" },
  { id: "P15", label: "15. Variación de valor razonable en instrumentos financieros", block: "financial" },
  { id: "P16", label: "16. Diferencias de cambio", block: "financial" },
  { id: "P17", label: "17. Deterioro y resultado por enajenaciones de instrumentos financieros", block: "financial" },
  { id: "P18", label: "18. Impuestos sobre beneficios", block: "tax" }
];

export const PYG_PREFIXES: Record<string, string> = {
  "70": "P1", "71": "P2", "73": "P3", "60": "P4", "61": "P4", "74": "P5", "75": "P5", "746": "P9",
  "64": "P6",
  "62": "P7", "631": "P7", "634": "P7", "636": "P7", "639": "P7", "65": "P7", "694": "P7", "695": "P7", "794": "P7", "7954": "P7",
  "68": "P8",
  "7951": "P10", "7952": "P10", "7955": "P10", "7956": "P10",
  "670": "P11", "671": "P11", "672": "P11", "690": "P11", "691": "P11", "692": "P11", "770": "P11", "771": "P11", "772": "P11", "790": "P11", "791": "P11", "792": "P11",
  "678": "P12", "778": "P12",
  "76": "P13", "66": "P14", "663": "P15", "763": "P15", "668": "P16", "768": "P16",
  "666": "P17", "667": "P17", "673": "P17", "675": "P17", "696": "P17", "697": "P17", "698": "P17", "699": "P17", "766": "P17", "773": "P17", "775": "P17", "796": "P17", "797": "P17", "798": "P17", "799": "P17",
  "630": "P18", "633": "P18", "638": "P18"
};

export function matchPrefix(code: string, table: Record<string, string>): string | null {
  const digits = accountDigits(code);
  for (let length = digits.length; length >= 1; length--) {
    const hit = table[digits.slice(0, length)];
    if (hit) return hit;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const debitNatural = (row: { debit: Dec; credit: Dec }): Dec => row.debit.minus(row.credit);
const creditNatural = (row: { debit: Dec; credit: Dec }): Dec => row.credit.minus(row.debit);
const groupOf = (code: string): number => Number(accountDigits(code).charAt(0)) || 0;
const isPl = (code: string): boolean => groupOf(code) === 6 || groupOf(code) === 7;
const is129 = (code: string): boolean => accountDigits(code) === "129";

type LineAcc = { amount: Dec; accounts: StatementAccountAmount[] };

function newAcc(): LineAcc {
  return { amount: ZERO, accounts: [] };
}

function addTo(acc: LineAcc, code: string, name: string, amount: Dec): void {
  if (amount.isZero()) return;
  acc.amount = acc.amount.plus(amount);
  acc.accounts.push({ code, name, amount: money(amount) });
}

function toLine(def: { id: string; label: string; level: number }, acc: LineAcc, previous?: LineAcc): StatementLine {
  const line: StatementLine = { id: def.id, label: def.label, level: def.level, amount: money(acc.amount), accounts: acc.accounts.sort((a, b) => a.code.localeCompare(b.code)) };
  if (previous) line.previousAmount = money(previous.amount);
  return line;
}

/** Income − expense of P&L rows (credit − debit over groups 6-7). */
export function plNet(rows: AccountBalanceRow[]): Dec {
  return sumDec(rows.filter((r) => isPl(r.code)).map(creditNatural));
}

// ---------------------------------------------------------------------------
// Balance de situación
// ---------------------------------------------------------------------------

export type BalanceInput = {
  organizationId: string;
  propertyId: string | null;
  period: { from: string; to: string };
  rowsAt: AccountBalanceRow[];
  rowsBefore: AccountBalanceRow[];
  rowsMovements: AccountBalanceRow[];
  previous?: { rowsAt: AccountBalanceRow[]; rowsBefore: AccountBalanceRow[]; rowsMovements: AccountBalanceRow[] } | null;
  generatedAt?: string;
};

type BalanceAccumulators = { lines: Map<string, LineAcc>; periodResult: Dec; prior: Dec; warnings: string[] };

function accumulateBalance(input: Pick<BalanceInput, "rowsAt" | "rowsBefore" | "rowsMovements">): BalanceAccumulators {
  const lines = new Map<string, LineAcc>();
  for (const def of BALANCE_LINES) lines.set(def.id, newAcc());
  const warnings: string[] = [];
  const get = (id: string): LineAcc => lines.get(id)!;

  for (const row of input.rowsAt) {
    if (isPl(row.code) || is129(row.code)) continue;
    const lineId = matchPrefix(row.code, BALANCE_PREFIXES);
    if (lineId) {
      const side = SECTION_SIDE[BALANCE_LINES.find((l) => l.id === lineId)!.section];
      addTo(get(lineId), row.code, row.name, side === "asset" ? debitNatural(row) : creditNatural(row));
      continue;
    }
    const amount = row.kind === "asset" ? debitNatural(row) : creditNatural(row);
    if (amount.isZero()) continue;
    const fallback = row.kind === "asset" ? "B_X" : row.kind === "equity" ? "E_X" : row.kind === "liability" ? "C_X" : null;
    if (!fallback) {
      warnings.push(`Cuenta ${row.code} (${row.kind}) fuera del balance: saldo ${money(amount)} no presentado`);
      continue;
    }
    addTo(get(fallback), row.code, row.name, amount);
    warnings.push(`Cuenta ${row.code} «${row.name}» sin epígrafe PGC: presentada en «sin clasificar» (${money(amount)})`);
  }

  // 129: carried result of previous years = balance at from − 1 + its movements of the period (distribution),
  // regularization excluded by the movements mode.
  const carried129 = sumDec(input.rowsBefore.filter((r) => is129(r.code)).map(creditNatural)).plus(
    sumDec(input.rowsMovements.filter((r) => is129(r.code)).map(creditNatural))
  );
  if (!carried129.isZero()) addTo(get("E_V"), "129", "Resultado de ejercicios anteriores pendiente de aplicación", carried129);

  const periodResult = plNet(input.rowsMovements);
  addTo(get("E_VII"), "129", "Resultado del periodo (ingresos − gastos)", periodResult);

  const prior = plNet(input.rowsBefore);
  if (!prior.isZero()) {
    for (const row of input.rowsBefore.filter((r) => isPl(r.code))) addTo(get("E_PR"), row.code, row.name, creditNatural(row));
    warnings.push(`Existen saldos de ingresos y gastos anteriores al periodo sin regularizar por ${money(prior)}: revisar el cierre del ejercicio anterior`);
  }
  return { lines, periodResult, prior, warnings };
}

export function computeBalance(input: BalanceInput): PgcBalanceSheet {
  const current = accumulateBalance(input);
  const previous = input.previous ? accumulateBalance(input.previous) : null;
  const section = (name: BalanceSection): StatementLine[] =>
    BALANCE_LINES.filter((def) => def.section === name)
      .filter((def) => !def.fallback || !current.lines.get(def.id)!.amount.isZero() || (previous ? !previous.lines.get(def.id)!.amount.isZero() : false))
      .map((def) => toLine(def, current.lines.get(def.id)!, previous?.lines.get(def.id)));
  const total = (lines: StatementLine[]): Dec => sumDec(lines.map((l) => D(l.amount)));

  const assetsNc = section("assets_nc");
  const assetsC = section("assets_c");
  const equity = section("equity");
  const liabNc = section("liab_nc");
  const liabC = section("liab_c");
  const totalAssets = total(assetsNc).plus(total(assetsC));
  const totalEquity = total(equity);
  const totalLiabilities = total(liabNc).plus(total(liabC));
  const totalEquityAndLiabilities = totalEquity.plus(totalLiabilities);
  const balanced = sameCents(totalAssets, totalEquityAndLiabilities);
  const warnings = [...current.warnings];
  if (!balanced) warnings.push(`El balance no cuadra: activo ${money(totalAssets)} ≠ patrimonio neto + pasivo ${money(totalEquityAndLiabilities)} (revisar asientos descuadrados o cuentas sin naturaleza)`);

  return {
    kind: "balance",
    organizationId: input.organizationId,
    propertyId: input.propertyId,
    period: input.period,
    asOf: input.period.to,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    assets: { nonCurrent: assetsNc, current: assetsC, totalNonCurrent: money(total(assetsNc)), totalCurrent: money(total(assetsC)), total: money(totalAssets) },
    equity: { lines: equity, total: money(totalEquity) },
    liabilities: { nonCurrent: liabNc, current: liabC, totalNonCurrent: money(total(liabNc)), totalCurrent: money(total(liabC)), total: money(totalLiabilities) },
    totalAssets: money(totalAssets),
    totalEquityAndLiabilities: money(totalEquityAndLiabilities),
    balanced,
    periodResult: money(current.periodResult),
    priorUnregularisedResult: money(current.prior),
    warnings
  };
}

// ---------------------------------------------------------------------------
// Cuenta de pérdidas y ganancias
// ---------------------------------------------------------------------------

export type PygInput = {
  organizationId: string;
  propertyId: string | null;
  period: { from: string; to: string };
  rowsMovements: AccountBalanceRow[];
  previousMovements?: AccountBalanceRow[] | null;
  generatedAt?: string;
};

function accumulatePyg(rows: AccountBalanceRow[]): { lines: Map<string, LineAcc>; warnings: string[]; revenue: Dec; expense: Dec } {
  const lines = new Map<string, LineAcc>();
  for (const def of PYG_LINES) lines.set(def.id, newAcc());
  const warnings: string[] = [];
  let revenue = ZERO;
  let expense = ZERO;
  for (const row of rows) {
    if (!isPl(row.code)) continue;
    if (row.kind === "income") revenue = revenue.plus(creditNatural(row));
    else expense = expense.plus(debitNatural(row));
    const lineId = matchPrefix(row.code, PYG_PREFIXES) ?? "P19";
    if (lineId === "P19" && !creditNatural(row).isZero()) warnings.push(`Cuenta ${row.code} «${row.name}» sin línea del modelo de PyG: presentada en «sin clasificar»`);
    addTo(lines.get(lineId)!, row.code, row.name, creditNatural(row));
  }
  return { lines, warnings, revenue, expense };
}

export function computePyg(input: PygInput): PgcProfitAndLoss {
  const current = accumulatePyg(input.rowsMovements);
  const previous = input.previousMovements ? accumulatePyg(input.previousMovements) : null;
  const lines = PYG_LINES.filter((def) => !def.fallback || !current.lines.get(def.id)!.amount.isZero() || (previous ? !previous.lines.get(def.id)!.amount.isZero() : false)).map((def) =>
    toLine({ ...def, level: 2 }, current.lines.get(def.id)!, previous?.lines.get(def.id))
  );
  const blockTotal = (block: PygLineDef["block"]): Dec =>
    sumDec(PYG_LINES.filter((def) => def.block === block).map((def) => current.lines.get(def.id)!.amount));
  const operatingResult = blockTotal("operating");
  const financialResult = blockTotal("financial");
  const resultBeforeTax = operatingResult.plus(financialResult);
  const incomeTax = blockTotal("tax");
  const netResult = resultBeforeTax.plus(incomeTax);
  const warnings = [...current.warnings];
  if (!sameCents(netResult, current.revenue.minus(current.expense))) {
    warnings.push(`El resultado de las líneas (${money(netResult)}) no coincide con ingresos − gastos (${money(current.revenue.minus(current.expense))})`);
  }
  return {
    kind: "pyg",
    organizationId: input.organizationId,
    propertyId: input.propertyId,
    period: input.period,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    lines,
    operatingResult: money(operatingResult),
    financialResult: money(financialResult),
    resultBeforeTax: money(resultBeforeTax),
    incomeTax: money(incomeTax),
    netResult: money(netResult),
    revenueTotal: money(current.revenue),
    expenseTotal: money(current.expense),
    warnings
  };
}

// ---------------------------------------------------------------------------
// Estado de cambios en el patrimonio neto
// ---------------------------------------------------------------------------

const ECPN_COLUMNS: Array<{ key: EcpnColumnKey; label: string }> = [
  { key: "capital", label: "Capital" },
  { key: "sharePremium", label: "Prima de emisión" },
  { key: "reserves", label: "Reservas" },
  { key: "priorResults", label: "Resultados de ejercicios anteriores" },
  { key: "otherContributions", label: "Otras aportaciones de socios" },
  { key: "periodResult", label: "Resultado del ejercicio" },
  { key: "interimDividend", label: "(Dividendo a cuenta)" },
  { key: "grants", label: "Subvenciones, donaciones y legados" },
  { key: "total", label: "TOTAL" }
];

const ECPN_PREFIXES: Record<string, EcpnColumnKey> = {
  "100": "capital", "101": "capital", "102": "capital", "103": "capital", "104": "capital",
  "110": "sharePremium",
  "11": "reserves", "108": "reserves", "109": "reserves",
  "120": "priorResults", "121": "priorResults", "129": "priorResults",
  "118": "otherContributions",
  "557": "interimDividend",
  "13": "grants"
};

type ColumnValues = Record<EcpnColumnKey, Dec>;

function emptyColumns(): ColumnValues {
  return { capital: ZERO, sharePremium: ZERO, reserves: ZERO, priorResults: ZERO, otherContributions: ZERO, periodResult: ZERO, interimDividend: ZERO, grants: ZERO, total: ZERO };
}

function columnsFromRows(rows: AccountBalanceRow[], predicate: (column: EcpnColumnKey) => boolean = () => true): ColumnValues {
  const values = emptyColumns();
  for (const row of rows) {
    if (isPl(row.code)) continue;
    const column = matchPrefix(row.code, ECPN_PREFIXES as Record<string, string>) as EcpnColumnKey | null;
    if (!column || !predicate(column)) continue;
    values[column] = values[column].plus(creditNatural(row));
  }
  return values;
}

function withTotal(values: ColumnValues): ColumnValues {
  const keys: EcpnColumnKey[] = ["capital", "sharePremium", "reserves", "priorResults", "otherContributions", "periodResult", "interimDividend", "grants"];
  return { ...values, total: sumDec(keys.map((k) => values[k])) };
}

function addColumns(a: ColumnValues, b: ColumnValues): ColumnValues {
  const out = emptyColumns();
  for (const key of Object.keys(out) as EcpnColumnKey[]) out[key] = a[key].plus(b[key]);
  return out;
}

function rowOf(id: string, label: string, level: number, values: ColumnValues): EcpnRow {
  const totalled = withTotal(values);
  const out = {} as Record<EcpnColumnKey, string>;
  for (const key of Object.keys(totalled) as EcpnColumnKey[]) out[key] = money(totalled[key]);
  return { id, label, level, values: out };
}

export function computeEcpn(input: BalanceInput): PgcEquityChanges {
  const warnings: string[] = [];
  const opening = columnsFromRows(input.rowsBefore);
  opening.periodResult = plNet(input.rowsBefore); // prior unregularised P&L, 0 in a clean ledger
  const periodResult = plNet(input.rowsMovements);
  const movements = input.rowsMovements;
  const recognised = emptyColumns();
  recognised.periodResult = periodResult;
  recognised.grants = columnsFromRows(movements, (c) => c === "grants").grants;
  const partners = columnsFromRows(movements, (c) => c === "capital" || c === "sharePremium" || c === "otherContributions" || c === "interimDividend");
  const other = columnsFromRows(movements, (c) => c === "reserves" || c === "priorResults");
  const adjustments = emptyColumns();
  const adjusted = addColumns(opening, adjustments);
  const closingComputed = addColumns(addColumns(addColumns(adjusted, recognised), partners), other);

  const closingLedger = columnsFromRows(input.rowsAt, (c) => c !== "priorResults");
  closingLedger.priorResults = sumDec(input.rowsAt.filter((r) => !is129(r.code) && matchPrefix(r.code, ECPN_PREFIXES as Record<string, string>) === "priorResults").map(creditNatural)).plus(
    sumDec(input.rowsBefore.filter((r) => is129(r.code)).map(creditNatural)).plus(sumDec(movements.filter((r) => is129(r.code)).map(creditNatural)))
  );
  closingLedger.periodResult = plNet(input.rowsBefore).plus(periodResult);
  let reconciled = true;
  for (const key of Object.keys(closingComputed) as EcpnColumnKey[]) {
    if (key === "total") continue;
    if (!sameCents(closingComputed[key], closingLedger[key])) {
      reconciled = false;
      warnings.push(`Columna «${ECPN_COLUMNS.find((c) => c.key === key)!.label}»: saldo final calculado ${money(closingComputed[key])} ≠ saldo del libro ${money(closingLedger[key])}`);
    }
  }
  if (!opening.periodResult.isZero()) warnings.push(`Saldo inicial de resultado del ejercicio distinto de 0 (${money(opening.periodResult)}): el ejercicio anterior no se regularizó`);

  const directly: StatementLine[] = [];
  const grantsMove = recognised.grants;
  directly.push({ id: "R_I", label: "I. Ingresos y gastos imputados directamente al patrimonio neto (subvenciones, donaciones y legados)", level: 1, amount: money(grantsMove), accounts: [] });
  const transfers: StatementLine[] = [{ id: "R_II", label: "II. Transferencias a la cuenta de pérdidas y ganancias", level: 1, amount: "0.00", accounts: [] }];

  return {
    kind: "ecpn",
    organizationId: input.organizationId,
    propertyId: input.propertyId,
    period: input.period,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    recognisedIncomeAndExpense: { periodResult: money(periodResult), directlyToEquity: directly, transfersToPnl: transfers, total: money(periodResult.plus(grantsMove)) },
    columns: ECPN_COLUMNS,
    rows: [
      rowOf("A", `A. SALDO, INICIO DEL PERIODO (${addDays(input.period.from, -1)})`, 0, opening),
      rowOf("A_I", "I. Ajustes por cambios de criterio y errores (no derivables del libro: cumplimentar)", 1, adjustments),
      rowOf("B", "B. SALDO AJUSTADO, INICIO DEL PERIODO", 0, adjusted),
      rowOf("B_I", "I. Total ingresos y gastos reconocidos", 1, recognised),
      rowOf("B_II", "II. Operaciones con socios o propietarios", 1, partners),
      rowOf("B_III", "III. Otras variaciones del patrimonio neto (incluye la distribución del resultado anterior)", 1, other),
      rowOf("C", `C. SALDO, FINAL DEL PERIODO (${input.period.to})`, 0, closingComputed)
    ],
    reconciled,
    warnings
  };
}

// ---------------------------------------------------------------------------
// Memoria
// ---------------------------------------------------------------------------

export type MemoriaInput = {
  organizationId: string;
  propertyId: string | null;
  period: { from: string; to: string };
  organization: OrganizationLite | null;
  properties: PropertyLite[];
  balance: PgcBalanceSheet;
  pyg: PgcProfitAndLoss;
  rowsAt: AccountBalanceRow[];
  rowsBefore: AccountBalanceRow[];
  rowsMovements: AccountBalanceRow[];
  fixedAssets: FixedAssetLite[];
  vatTotals: VatTotalsRow[];
  headcount: number | null;
  generatedAt?: string;
};

function sumWhere(rows: AccountBalanceRow[], predicate: (code: string) => boolean, natural: "debit" | "credit"): Dec {
  return sumDec(rows.filter((r) => predicate(r.code)).map((r) => (natural === "debit" ? debitNatural(r) : creditNatural(r))));
}

const startsWithAny = (prefixes: string[]) => (code: string): boolean => prefixes.some((p) => accountDigits(code).startsWith(p));

export function computeMemoria(input: MemoriaInput): PgcMemoria {
  const warnings: string[] = [];
  const org = input.organization;
  const name = org?.legalName ?? org?.name ?? input.organizationId;
  const props = input.properties.map((p) => ({ id: p.id, name: p.name, address: [p.address, p.municipality, p.province].filter(Boolean).join(", ") || null }));
  const period = `${input.period.from} a ${input.period.to}`;

  const assetGroups = [
    { key: "intangible", label: "Inmovilizado intangible", cost: ["20"], amort: ["280"] },
    { key: "material", label: "Inmovilizado material", cost: ["21", "23"], amort: ["281"] },
    { key: "inversiones", label: "Inversiones inmobiliarias", cost: ["22"], amort: ["282"] }
  ].map((g) => {
    const costOpening = sumWhere(input.rowsBefore, startsWithAny(g.cost), "debit");
    const costAdditions = sumDec(input.rowsMovements.filter((r) => startsWithAny(g.cost)(r.code)).map((r) => r.debit));
    const costDisposals = sumDec(input.rowsMovements.filter((r) => startsWithAny(g.cost)(r.code)).map((r) => r.credit));
    const costClosing = sumWhere(input.rowsAt, startsWithAny(g.cost), "debit");
    const amortOpening = sumWhere(input.rowsBefore, startsWithAny(g.amort), "credit");
    const amortCharge = sumDec(input.rowsMovements.filter((r) => startsWithAny(g.amort)(r.code)).map((r) => r.credit));
    const amortDisposals = sumDec(input.rowsMovements.filter((r) => startsWithAny(g.amort)(r.code)).map((r) => r.debit));
    const amortClosing = sumWhere(input.rowsAt, startsWithAny(g.amort), "credit");
    return {
      group: g.key,
      label: g.label,
      cost: { opening: money(costOpening), additions: money(costAdditions), disposals: money(costDisposals), closing: money(costClosing) },
      amortization: { opening: money(amortOpening), charge: money(amortCharge), disposals: money(amortDisposals), closing: money(amortClosing) },
      netBookValue: money(costClosing.minus(amortClosing))
    };
  });

  const registry = input.fixedAssets.map((asset) => ({
    id: asset.id,
    name: asset.name,
    category: asset.category,
    accountCode: asset.accountCode,
    acquisitionDate: asset.acquisitionDate,
    acquisitionCost: money(asset.acquisitionCost),
    accumulatedDepreciation: money(asset.accumulatedDepreciation),
    residualValue: money(asset.residualValue),
    coefficientPct: asset.coefficientPct === null ? null : asset.coefficientPct.toFixed(2),
    netBookValue: money(asset.acquisitionCost.minus(asset.accumulatedDepreciation)),
    status: asset.status
  }));

  const revenueByAccount = input.rowsMovements
    .filter((r) => accountDigits(r.code).startsWith("70"))
    .map((r) => ({ code: r.code, name: r.name, amount: money(creditNatural(r)) }))
    .sort((a, b) => a.code.localeCompare(b.code));
  const personnel = {
    salaries: money(sumWhere(input.rowsMovements, startsWithAny(["640", "641"]), "debit")),
    socialSecurity: money(sumWhere(input.rowsMovements, startsWithAny(["642"]), "debit")),
    otherSocial: money(sumWhere(input.rowsMovements, startsWithAny(["643", "644", "649"]), "debit")),
    total: money(sumWhere(input.rowsMovements, startsWithAny(["64"]), "debit"))
  };
  const purchases = money(sumWhere(input.rowsMovements, startsWithAny(["60", "61"]), "debit"));
  const otherOperating = money(sumWhere(input.rowsMovements, startsWithAny(["62", "63", "65"]), "debit").minus(sumWhere(input.rowsMovements, startsWithAny(["630", "633", "638"]), "debit")));

  const vat = input.vatTotals.map((t) => ({ book: t.book, rate: t.rate.toFixed(2), base: money(t.base), quota: money(t.quota), total: money(t.total), retention: money(t.retention), count: t.count }));
  const vatOut = sumDec(input.vatTotals.filter((t) => t.book === "emitidas").map((t) => t.quota));
  const vatIn = sumDec(input.vatTotals.filter((t) => t.book === "recibidas" || t.book === "bienes_inversion").map((t) => t.quota));
  const vatBalanceLedger = {
    repercutido477: money(sumWhere(input.rowsAt, startsWithAny(["477"]), "credit")),
    soportado472: money(sumWhere(input.rowsAt, startsWithAny(["472"]), "debit")),
    acreedora4750: money(sumWhere(input.rowsAt, (c) => accountDigits(c).startsWith("4750"), "credit")),
    deudora4700: money(sumWhere(input.rowsAt, (c) => accountDigits(c).startsWith("4700"), "debit")),
    retenciones4751: money(sumWhere(input.rowsAt, (c) => accountDigits(c).startsWith("4751"), "credit")),
    impuestoSociedades630: money(sumWhere(input.rowsMovements, startsWithAny(["630"]), "debit"))
  };

  const equity = {
    capital: money(sumWhere(input.rowsAt, startsWithAny(["100", "101", "102"]), "credit")),
    reserves: money(sumWhere(input.rowsAt, (c) => accountDigits(c).startsWith("11") && !accountDigits(c).startsWith("110") && !accountDigits(c).startsWith("118"), "credit")),
    priorResults: money(sumWhere(input.rowsAt, startsWithAny(["120", "121"]), "credit")),
    periodResult: input.pyg.netResult
  };

  const financialAssets = {
    clientes: money(sumWhere(input.rowsAt, startsWithAny(["43"]), "debit")),
    deudores: money(sumWhere(input.rowsAt, startsWithAny(["44"]), "debit")),
    haciendaDeudora: money(sumWhere(input.rowsAt, startsWithAny(["470", "471", "472", "473"]), "debit")),
    tesoreria: money(sumWhere(input.rowsAt, startsWithAny(["57"]), "debit"))
  };
  const financialLiabilities = {
    deudasLargoPlazo: money(sumWhere(input.rowsAt, startsWithAny(["17", "18"]), "credit")),
    deudasCortoPlazo: money(sumWhere(input.rowsAt, startsWithAny(["52", "55", "56"]), "credit")),
    proveedores: money(sumWhere(input.rowsAt, startsWithAny(["40"]), "credit")),
    acreedores: money(sumWhere(input.rowsAt, startsWithAny(["41"]), "credit")),
    haciendaAcreedora: money(sumWhere(input.rowsAt, startsWithAny(["475", "476", "477"]), "credit")),
    remuneracionesPendientes: money(sumWhere(input.rowsAt, startsWithAny(["465"]), "credit"))
  };
  const grants = money(sumWhere(input.rowsAt, startsWithAny(["13"]), "credit"));

  const notes: MemoriaNote[] = [
    {
      number: 1,
      title: "Actividad de la empresa",
      text: `${name}${org?.taxId ? ` (NIF ${org.taxId})` : ""} tiene por actividad la explotación de establecimientos de alojamiento turístico. Establecimientos registrados en el sistema: ${props.map((p) => `${p.name}${p.address ? ` (${p.address})` : ""}`).join("; ") || "ninguno"}. Completar con el domicilio social, el objeto social según los estatutos y la moneda funcional (euro).`,
      figures: { organization: org, properties: props },
      status: "requires_input"
    },
    {
      number: 2,
      title: "Bases de presentación de las cuentas anuales",
      text: `Las cuentas anuales del periodo ${period} se han formulado a partir de los registros contables de la sociedad con arreglo al Plan General de Contabilidad de Pequeñas y Medianas Empresas (RD 1515/2007 y modificaciones posteriores), mostrando la imagen fiel del patrimonio, de la situación financiera y de los resultados. Principios aplicados: empresa en funcionamiento, devengo, uniformidad, prudencia, no compensación e importancia relativa. Los importes se expresan en euros con dos decimales.${input.balance.balanced ? " El balance cuadra (activo = patrimonio neto + pasivo)." : " ATENCIÓN: el balance generado no cuadra; revisar antes de formular."}`,
      figures: { balanced: input.balance.balanced, totalAssets: input.balance.totalAssets, netResult: input.pyg.netResult },
      status: "auto"
    },
    {
      number: 3,
      title: "Aplicación de resultados",
      text: `Resultado del periodo: ${input.pyg.netResult} €. Propuesta de distribución pendiente de acuerdo del órgano de administración (base de reparto = resultado del ejercicio; destinos: reserva legal, reservas voluntarias, compensación de resultados negativos de ejercicios anteriores, dividendos).`,
      figures: { periodResult: input.pyg.netResult, priorResults: equity.priorResults },
      status: "requires_input"
    },
    {
      number: 4,
      title: "Normas de registro y valoración",
      text: "Inmovilizado material e intangible: coste de adquisición menos amortización acumulada; amortización lineal según coeficientes máximos de las tablas del art. 12 LIS (mobiliario 10 %, instalaciones 10 %, equipos informáticos 25 %, construcciones 3 %, vehículos 16 %). Existencias: precio de adquisición. Ingresos por prestación de servicios de alojamiento, restauración y otros: reconocidos en el devengo de la estancia o el servicio, netos de IVA, con la factura emitida como documento origen. Gastos: devengo, factura recibida como documento origen. IVA: régimen general, libros registro conforme al RD 1619/2012. Impuesto sobre beneficios: gasto devengado del periodo (cuenta 630).",
      figures: {},
      status: "auto"
    },
    {
      number: 5,
      title: "Inmovilizado material, intangible e inversiones inmobiliarias",
      text: `Movimientos del periodo por grupo de inmovilizado (coste y amortización acumulada) y registro de elementos (${registry.length} elementos en el registro de activos).`,
      figures: { groups: assetGroups, registry },
      status: "auto"
    },
    {
      number: 6,
      title: "Activos financieros",
      text: `Saldos al cierre: clientes ${financialAssets.clientes} €, deudores ${financialAssets.deudores} €, Hacienda Pública deudora ${financialAssets.haciendaDeudora} €, tesorería ${financialAssets.tesoreria} €.`,
      figures: financialAssets,
      status: "auto"
    },
    {
      number: 7,
      title: "Pasivos financieros",
      text: `Saldos al cierre: deudas a largo plazo ${financialLiabilities.deudasLargoPlazo} €, deudas a corto plazo ${financialLiabilities.deudasCortoPlazo} €, proveedores ${financialLiabilities.proveedores} €, acreedores ${financialLiabilities.acreedores} €, Hacienda Pública y Seguridad Social acreedoras ${financialLiabilities.haciendaAcreedora} €, remuneraciones pendientes ${financialLiabilities.remuneracionesPendientes} €.`,
      figures: financialLiabilities,
      status: "auto"
    },
    {
      number: 8,
      title: "Fondos propios",
      text: `Capital ${equity.capital} €, reservas ${equity.reserves} €, resultados de ejercicios anteriores ${equity.priorResults} €, resultado del periodo ${equity.periodResult} €.`,
      figures: equity,
      status: "auto"
    },
    {
      number: 9,
      title: "Situación fiscal",
      text:
        vat.length > 0
          ? `Libros registro de IVA del periodo: IVA repercutido ${money(vatOut)} €, IVA soportado ${money(vatIn)} € (${vat.length} combinaciones libro/tipo). Saldos contables al cierre: 477 ${vatBalanceLedger.repercutido477} €, 472 ${vatBalanceLedger.soportado472} €, 4750 ${vatBalanceLedger.acreedora4750} €, 4700 ${vatBalanceLedger.deudora4700} €, retenciones 4751 ${vatBalanceLedger.retenciones4751} €. Impuesto sobre beneficios devengado ${vatBalanceLedger.impuestoSociedades630} €.`
          : `Sin registros en los libros de IVA del periodo. Saldos contables al cierre: 477 ${vatBalanceLedger.repercutido477} €, 472 ${vatBalanceLedger.soportado472} €, 4750 ${vatBalanceLedger.acreedora4750} €, 4700 ${vatBalanceLedger.deudora4700} €. Impuesto sobre beneficios devengado ${vatBalanceLedger.impuestoSociedades630} €. Conciliar con el Modelo 303/390 antes de formular.`,
      figures: { vatBooks: vat, ledger: vatBalanceLedger },
      status: "auto"
    },
    {
      number: 10,
      title: "Ingresos y gastos",
      text: `Importe neto de la cifra de negocios por subcuenta (70x); aprovisionamientos ${purchases} €; gastos de personal ${personnel.total} € (sueldos ${personnel.salaries} €, Seguridad Social ${personnel.socialSecurity} €); otros gastos de explotación ${otherOperating} €.`,
      figures: { revenueByAccount, purchases, personnel, otherOperating },
      status: "auto"
    },
    {
      number: 11,
      title: "Subvenciones, donaciones y legados",
      text: grants === "0.00" ? "No hay subvenciones, donaciones ni legados registrados en el periodo." : `Saldo de subvenciones, donaciones y legados al cierre: ${grants} €.`,
      figures: { grants },
      status: "auto"
    },
    {
      number: 12,
      title: "Operaciones con partes vinculadas",
      text: "No derivable del libro: indicar las operaciones con socios, administradores y empresas del grupo (importes, saldos y retribuciones del órgano de administración).",
      figures: {},
      status: "requires_input"
    },
    {
      number: 13,
      title: "Otra información",
      text:
        input.headcount === null
          ? "Número medio de personas empleadas: no derivable (sin nóminas registradas en el periodo); cumplimentar. Periodo medio de pago a proveedores (Ley 15/2010): cumplimentar."
          : `Personas empleadas con nómina en el periodo: ${input.headcount} (calcular el número medio por categoría y sexo). Periodo medio de pago a proveedores (Ley 15/2010): cumplimentar.`,
      figures: { headcount: input.headcount },
      status: "requires_input"
    },
    {
      number: 14,
      title: "Hechos posteriores al cierre",
      text: "No derivable del libro: indicar los hechos posteriores relevantes o su ausencia.",
      figures: {},
      status: "requires_input"
    }
  ];
  if (!input.balance.balanced) warnings.push("El balance no cuadra: la memoria no debe formularse hasta corregirlo.");

  return {
    kind: "memoria",
    organizationId: input.organizationId,
    propertyId: input.propertyId,
    period: input.period,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    entity: { name: org?.name ?? input.organizationId, legalName: org?.legalName ?? null, taxId: org?.taxId ?? null, properties: props },
    notes,
    warnings
  };
}

// ---------------------------------------------------------------------------
// Period resolution + source-backed builders
// ---------------------------------------------------------------------------

export type ResolvedPeriod = { from: string; to: string; fiscalYear: { id: string; code: string; status: string } | null };

export async function resolvePeriod(input: { organizationId: string; fiscalYearId?: string | null; from?: string | null; to?: string | null }): Promise<ResolvedPeriod> {
  if (input.fiscalYearId) {
    const year = await prisma.fiscalYear.findFirst({ where: { id: input.fiscalYearId, organizationId: input.organizationId } });
    if (!year) throw new NotFoundError("Ejercicio fiscal no encontrado.");
    return { from: isoDay(year.startDate), to: isoDay(year.endDate), fiscalYear: { id: year.id, code: year.code, status: year.status } };
  }
  if (!input.from || !input.to) throw new BadRequestError("Indica fiscalYearId o el par from/to.");
  return { from: input.from, to: input.to, fiscalYear: null };
}

type LedgerSet = { rowsAt: AccountBalanceRow[]; rowsBefore: AccountBalanceRow[]; rowsMovements: AccountBalanceRow[] };

async function readLedgerSet(source: FinancialStatementsSource, organizationId: string, propertyId: string | null, from: string, to: string): Promise<LedgerSet> {
  const [rowsAt, rowsBefore, rowsMovements] = await Promise.all([
    source.accountBalances({ organizationId, propertyId, mode: "balance_at", to }),
    source.accountBalances({ organizationId, propertyId, mode: "balance_at", to: addDays(from, -1) }),
    source.accountBalances({ organizationId, propertyId, mode: "movements", from, to })
  ]);
  return { rowsAt, rowsBefore, rowsMovements };
}

/** The previous period of the same length ending the day before `from` (comparative column). */
export function previousPeriodOf(from: string, to: string): { from: string; to: string } {
  const length = Math.round((new Date(`${to}T00:00:00Z`).getTime() - new Date(`${from}T00:00:00Z`).getTime()) / 86_400_000);
  const prevTo = addDays(from, -1);
  return { from: addDays(prevTo, -length), to: prevTo };
}

async function ensureProperty(source: FinancialStatementsSource, organizationId: string, propertyId: string | null | undefined): Promise<PropertyLite[]> {
  const properties = await source.properties(organizationId);
  if (propertyId && !properties.some((p) => p.id === propertyId)) throw new NotFoundError("Propiedad no encontrada.");
  return properties;
}

export type AnnualAccountsRequest = {
  context: UserContext;
  fiscalYearId?: string | null;
  from?: string | null;
  to?: string | null;
  propertyId?: string | null;
  comparative?: boolean;
  source?: FinancialStatementsSource;
};

export async function buildBalanceSheet(input: AnnualAccountsRequest): Promise<PgcBalanceSheet> {
  requirePermissions(input.context, ["accounting.read"]);
  const source = input.source ?? prismaFinancialStatementsSource;
  const organizationId = input.context.organizationId;
  await ensureProperty(source, organizationId, input.propertyId);
  const period = await resolvePeriod({ organizationId, fiscalYearId: input.fiscalYearId, from: input.from, to: input.to });
  const propertyId = input.propertyId ?? null;
  const ledger = await readLedgerSet(source, organizationId, propertyId, period.from, period.to);
  let previous: LedgerSet | null = null;
  if (input.comparative) {
    const prev = previousPeriodOf(period.from, period.to);
    previous = await readLedgerSet(source, organizationId, propertyId, prev.from, prev.to);
  }
  return computeBalance({ organizationId, propertyId, period: { from: period.from, to: period.to }, ...ledger, previous });
}

export async function buildProfitAndLoss(input: AnnualAccountsRequest): Promise<PgcProfitAndLoss> {
  requirePermissions(input.context, ["accounting.read"]);
  const source = input.source ?? prismaFinancialStatementsSource;
  const organizationId = input.context.organizationId;
  await ensureProperty(source, organizationId, input.propertyId);
  const period = await resolvePeriod({ organizationId, fiscalYearId: input.fiscalYearId, from: input.from, to: input.to });
  const propertyId = input.propertyId ?? null;
  const rowsMovements = await source.accountBalances({ organizationId, propertyId, mode: "movements", from: period.from, to: period.to, groups: [6, 7] });
  let previousMovements: AccountBalanceRow[] | null = null;
  if (input.comparative) {
    const prev = previousPeriodOf(period.from, period.to);
    previousMovements = await source.accountBalances({ organizationId, propertyId, mode: "movements", from: prev.from, to: prev.to, groups: [6, 7] });
  }
  return computePyg({ organizationId, propertyId, period: { from: period.from, to: period.to }, rowsMovements, previousMovements });
}

export async function buildEquityChanges(input: AnnualAccountsRequest): Promise<PgcEquityChanges> {
  requirePermissions(input.context, ["accounting.read"]);
  const source = input.source ?? prismaFinancialStatementsSource;
  const organizationId = input.context.organizationId;
  await ensureProperty(source, organizationId, input.propertyId);
  const period = await resolvePeriod({ organizationId, fiscalYearId: input.fiscalYearId, from: input.from, to: input.to });
  const propertyId = input.propertyId ?? null;
  const ledger = await readLedgerSet(source, organizationId, propertyId, period.from, period.to);
  return computeEcpn({ organizationId, propertyId, period: { from: period.from, to: period.to }, ...ledger });
}

export async function buildMemoria(input: AnnualAccountsRequest): Promise<PgcMemoria> {
  return (await buildAnnualAccounts(input)).memoria;
}

export async function buildAnnualAccounts(input: AnnualAccountsRequest): Promise<AnnualAccounts> {
  requirePermissions(input.context, ["accounting.read"]);
  const source = input.source ?? prismaFinancialStatementsSource;
  const organizationId = input.context.organizationId;
  const properties = await ensureProperty(source, organizationId, input.propertyId);
  const period = await resolvePeriod({ organizationId, fiscalYearId: input.fiscalYearId, from: input.from, to: input.to });
  const propertyId = input.propertyId ?? null;
  const generatedAt = new Date().toISOString();
  const ledger = await readLedgerSet(source, organizationId, propertyId, period.from, period.to);
  let previous: LedgerSet | null = null;
  if (input.comparative) {
    const prev = previousPeriodOf(period.from, period.to);
    previous = await readLedgerSet(source, organizationId, propertyId, prev.from, prev.to);
  }
  const range = { from: period.from, to: period.to };
  const balance = computeBalance({ organizationId, propertyId, period: range, ...ledger, previous, generatedAt });
  const pyg = computePyg({ organizationId, propertyId, period: range, rowsMovements: ledger.rowsMovements, previousMovements: previous?.rowsMovements ?? null, generatedAt });
  const ecpn = computeEcpn({ organizationId, propertyId, period: range, ...ledger, generatedAt });
  const [organization, fixedAssets, vatTotals, headcount] = await Promise.all([
    source.organization(organizationId),
    source.fixedAssets(organizationId, propertyId),
    source.vatTotals(organizationId, period.from, period.to),
    source.headcount(organizationId, period.from, period.to)
  ]);
  const memoria = computeMemoria({
    organizationId,
    propertyId,
    period: range,
    organization,
    properties: propertyId ? properties.filter((p) => p.id === propertyId) : properties,
    balance,
    pyg,
    ...ledger,
    fixedAssets,
    vatTotals,
    headcount,
    generatedAt
  });
  const resultMatches = sameCents(D(balance.periodResult), D(pyg.netResult));
  return {
    kind: "annual_accounts",
    organizationId,
    propertyId,
    fiscalYear: period.fiscalYear,
    period: range,
    generatedAt,
    balance,
    pyg,
    ecpn,
    memoria,
    coherence: { balanceBalanced: balance.balanced, resultMatches, ecpnReconciled: ecpn.reconciled, ok: balance.balanced && resultMatches && ecpn.reconciled }
  };
}

// ---------------------------------------------------------------------------
// Snapshots (FinancialStatementSnapshot)
// ---------------------------------------------------------------------------

function snapshotRow(row: {
  id: string;
  organizationId: string;
  fiscalYearId: string | null;
  kind: string;
  periodFrom: Date;
  periodTo: Date;
  label: string | null;
  generatedAt: Date;
  generatedBy: string | null;
}): FinancialStatementSnapshotRow {
  return {
    id: row.id,
    organizationId: row.organizationId,
    fiscalYearId: row.fiscalYearId,
    kind: row.kind as FinancialStatementKindKey,
    periodFrom: isoDay(row.periodFrom),
    periodTo: isoDay(row.periodTo),
    label: row.label,
    generatedAt: row.generatedAt.toISOString(),
    generatedBy: row.generatedBy
  };
}

export async function createStatementSnapshot(input: {
  context: UserContext;
  kind: FinancialStatementKindKey;
  fiscalYearId?: string | null;
  from?: string | null;
  to?: string | null;
  propertyId?: string | null;
  label?: string | null;
  correlationId: string;
  source?: FinancialStatementsSource;
}): Promise<FinancialStatementSnapshotDetail> {
  requirePermissions(input.context, ["accounting.configure"]);
  const organizationId = input.context.organizationId;
  const period = await resolvePeriod({ organizationId, fiscalYearId: input.fiscalYearId, from: input.from, to: input.to });
  const request: AnnualAccountsRequest = { context: input.context, from: period.from, to: period.to, propertyId: input.propertyId ?? null, source: input.source };
  let json: unknown;
  switch (input.kind) {
    case "balance":
      json = await buildBalanceSheet(request);
      break;
    case "pyg":
      json = await buildProfitAndLoss(request);
      break;
    case "ecpn":
      json = await buildEquityChanges(request);
      break;
    case "memoria":
      json = await buildMemoria(request);
      break;
    case "usali":
      json = await buildUsaliPnl({ context: input.context, propertyId: input.propertyId ?? null, from: period.from, to: period.to, source: input.source });
      break;
  }
  const row = await prisma.financialStatementSnapshot.create({
    data: {
      organizationId,
      fiscalYearId: period.fiscalYear?.id ?? null,
      kind: input.kind,
      periodFrom: new Date(`${period.from}T00:00:00.000Z`),
      periodTo: new Date(`${period.to}T00:00:00.000Z`),
      json: json as object,
      label: input.label ?? null,
      generatedBy: input.context.userId
    }
  });
  recordAuditEvent({
    organizationId,
    propertyId: input.context.propertyId,
    actorUserId: input.context.userId,
    actorType: "user",
    action: "FINANCIAL_STATEMENT_SNAPSHOT_CREATED",
    entityType: "financial_statement_snapshot",
    entityId: row.id,
    afterJson: { kind: input.kind, periodFrom: period.from, periodTo: period.to, label: input.label ?? null, propertyId: input.propertyId ?? null },
    correlationId: input.correlationId
  });
  return { ...snapshotRow(row), json };
}

export async function listStatementSnapshots(input: {
  context: UserContext;
  kind?: FinancialStatementKindKey | null;
  fiscalYearId?: string | null;
  limit?: number;
}): Promise<FinancialStatementSnapshotRow[]> {
  requirePermissions(input.context, ["accounting.read"]);
  const rows = await prisma.financialStatementSnapshot.findMany({
    where: { organizationId: input.context.organizationId, ...(input.kind ? { kind: input.kind } : {}), ...(input.fiscalYearId ? { fiscalYearId: input.fiscalYearId } : {}) },
    orderBy: { generatedAt: "desc" },
    take: input.limit ?? 50,
    select: { id: true, organizationId: true, fiscalYearId: true, kind: true, periodFrom: true, periodTo: true, label: true, generatedAt: true, generatedBy: true }
  });
  return rows.map(snapshotRow);
}

export async function getStatementSnapshot(input: { context: UserContext; snapshotId: string }): Promise<FinancialStatementSnapshotDetail> {
  requirePermissions(input.context, ["accounting.read"]);
  const row = await prisma.financialStatementSnapshot.findFirst({ where: { id: input.snapshotId, organizationId: input.context.organizationId } });
  if (!row) throw new NotFoundError("Estado financiero guardado no encontrado.");
  return { ...snapshotRow(row), json: row.json };
}
