// Importación contable desde Sage 200 (Tanda 7c · L1) — regla contable PURA.
//
// Convierte asientos Sage ya agrupados (`groupJournalRows`) en asientos Anfitorio
// listos para `postJournalEntry` (L2 los contabiliza dentro de su transacción):
//   (a) exclusión de documentos nativos (§5.1): Serie+Factura / SuFacturaNo /
//       Documento / Comentario normalizados contra `nativeIndex.invoiceKeys` →
//       `skipped_native` con el asiento nativo; cobros: número en documento /
//       comentario, o importe exacto + fecha ± 3 días contra `paymentAmounts`
//       [S heurística, siempre avisada]; cada cobro nativo se CONSUME una sola vez
//       (dos cobros de Sage del mismo importe no se excluyen por un único cobro
//       propio) y, a igualdad, gana el cobro cuya factura aparece en el asiento;
//   (b) entryKind: periodo «Cierre ejercicio» (`regularizacion`) → regularization;
//       «Cierre Contabilidad» (`cierre`) → closing; periodo 0 / «Apertura» → opening;
//       sin periodo especial: 6/7 contra 129 fechado a fin de ejercicio →
//       regularization, solo grupos 1-5 fechados a fin de ejercicio con concepto
//       «cierre» → closing, solo 1-5 fechados el primer día con concepto «apertura»
//       → opening [S]; en ambos casos el asiento debe tocar al menos DOS grupos
//       distintos de balance («Apertura cuenta bancaria nueva» 572/570 o «Cierre
//       de caja» 570/572 son asientos normales); el resto normal;
//   (c) reparto R4 (§4.5): líneas 6/7 de un solo centro → un asiento con ese
//       propertyId; varios centros → una parte por (asiento, centro) con las líneas
//       de balance repartidas en proporción al neto 6/7 de cada centro (≡ Σ|6/7|
//       cuando todos los centros van en el mismo sentido), céntimos residuales al
//       centro de mayor peso y corrección final al céntimo para que CADA parte cuadre
//       y el consolidado por cuenta sea exacto; taxBase con la misma proporción;
//       solo balance → centro común o null (sociedad); 6/7 sin analítica →
//       unassignedPolicy block · office · property:<id>;
//   (d) líneas con `signedLine` / `assertBalanced` (posting-rules), descripción
//       «Sage <cuenta> · <NIF> · <nombre>» si collapse con carryCounterparty; con
//       `ctx.isPostableCode` la cuenta destino del mapa (map / collapse / create /
//       map_by_rate resuelta) debe existir y admitir apuntes: si no, la cuenta Sage
//       queda `unmapped` con la propuesta (nunca llega al motor como ACCOUNT_NOT_FOUND);
//       `costCenterCode` (L2 lo resuelve a costCenterId) solo en 6/7, taxRateCode /
//       taxBase desde el bloque IVA en 472 / 477; > LEDGER_IMPORT_MAX_LINES_PER_ENTRY
//       líneas → error de asiento;
//   (e) sourceType sage200_journal y sourceId `<empresa>:<ejercicio>:<periodo>:
//       <asiento>[:<canal>][:<centro>]`; reference «Sage 200 · asiento E/N · periodo
//       P · diario D» (≤ 200); description ≤ 500;
//   (f) orden final por (entryDate, nº Sage, centro).
// `buildBalanceEntries` (§6): apertura (opening, 129 con el resultado anterior), un
// asiento normal por (ejercicio, periodo, centro | SOC) fechado el último día con
// Debe / Haber BRUTOS, y regularization / closing si el fichero trae los saldos de
// cierre; validación apertura(N+1) = cierre(N) al céntimo.
// `buildVatBookRows`: filas VatBookRow (sourceType sage200) con `period` recalculado
// por `periodCodeForDate`; con `nativeIndex` las facturas EMITIDAS por Anfitorio
// (serie + número) y las RECIBIDAS ya contabilizadas en Anfitorio (NIF + número del
// proveedor) se excluyen (`skippedNative`) para que el 303 / 347 / 390 no las cuente
// dos veces (§4.6, §5.1); en recibidas el sourceId lleva el NIF del proveedor.
// `buildReconciliationRows` (§5.2): Sage frente al diario por cuenta destino con
// tolerancias y clasificación amount_diff / native_only / missing_in_ledger; el saldo
// de Sage es el ACUMULADO de la última fila de cada cuenta (un balance mensual sobre
// un trimestre no suma tres saldos) y las cuentas de IVA por tipo (`map_by_rate` 472 /
// 477) se comparan por prefijo (4770000 ↔ Σ 477.xx del diario).
//
// Sin Prisma, sin red: entrada estructuras puras, salida estructuras puras. Importes
// siempre Decimal (`money` / `ZERO` / `sumMoney` del motor), nunca float.

import {
  LEDGER_IMPORT_MAX_LINES_PER_ENTRY,
  LEDGER_IMPORT_OPENING_PERIOD_CODE,
  LEDGER_IMPORT_SOCIETY_PROPERTY_CODE,
  LEDGER_IMPORT_SOURCE_TYPES,
  LEDGER_RECONCILIATION_TOLERANCES,
  LEDGER_UNASSIGNED_POLICY_PROPERTY_PREFIX,
  LEDGER_VAT_BOOK_SOURCE_TYPE,
  ledgerImportBalanceSourceId,
  ledgerImportJournalSourceId,
  ledgerImportVatBookSourceId,
  type IsoDate,
  type LedgerAccountMapDto,
  type LedgerAnalyticsDimension,
  type LedgerAnalyticsMapDto,
  type LedgerImportCentreRequiredRow,
  type LedgerImportClosingDetectedRow,
  type LedgerImportEntryKind,
  type LedgerImportNativeSkippedRow,
  type LedgerImportSourceType,
  type LedgerImportUnbalancedRow,
  type LedgerImportUnmappedAccount,
  type LedgerImportUnmappedAnalytics,
  type LedgerReconciliationClassification,
  type LedgerReconciliationRow,
  type LedgerReconciliationStatus,
  type LedgerUnassignedPolicy,
  type MoneyString,
  type VatPeriodicityCode
} from "@hotelos/shared";
import { HttpError } from "../../../lib/http-error.js";
import { BRAND } from "../../../lib/brand.js";
import { ZERO, money, sumMoney, type Decimal } from "../accounting.service.js";
import { accountGroup } from "../chart-of-accounts.service.js";
import { RESULT_ACCOUNT, assertBalanced, signedLine, type RuleLine } from "../posting-rules.js";
import { normalizeNif, periodCodeForDate, type VatBookRow } from "../vat-books.service.js";
import {
  SAGE_PERIOD_CODES,
  balancePeriodEndDate,
  sageEntryKeyString,
  type CanonicalBalanceRow,
  type CanonicalJournalRow,
  type CanonicalVatRow,
  type SageJournalEntry
} from "./ledger-import.canonical.js";
import { accountForRate, documentKeysInText, isPostableMapping, normalizeNativeDocumentKey } from "./ledger-import.mapping.js";

// ---------------------------------------------------------------------------
// Tipos
// ---------------------------------------------------------------------------

/** Línea planificada: RuleLine del motor + código de centro de coste USALI (L2 lo resuelve a costCenterId) + cuenta Sage de origen. */
export type PlannedLine = RuleLine & {
  costCenterCode: string | null;
  sourceAccount: string;
};

export type PlannedEntrySource = {
  companyCode: string;
  fiscalYear: string;
  period: string;
  entryNumber: string;
  channel: string | null;
};

export type PlannedEntry = {
  sourceType: LedgerImportSourceType;
  sourceId: string;
  entryDate: IsoDate;
  entryKind: LedgerImportEntryKind;
  /** ≤ 500 caracteres. */
  description: string;
  /** ≤ 200 caracteres. */
  reference: string;
  propertyId: string | null;
  /** Código del centro o "SOC". */
  propertyCode: string;
  fiscalYearCode: string;
  lines: PlannedLine[];
  totalDebit: MoneyString;
  totalCredit: MoneyString;
  /** Asiento Sage de origen (null en los asientos resumen de saldos). */
  source: PlannedEntrySource | null;
  /** Nº de partes en que se repartió el asiento Sage (1 si no hubo reparto). */
  splitParts: number;
  warnings: string[];
};

export type PostingProperty = { id: string; code: string | null; name?: string | null };

export type NativeEntryRef = {
  invoiceId?: string | null;
  /** Número impreso completo de la factura nativa. */
  invoiceNumber: string | null;
  /** Asiento nativo con el que colisiona. */
  sourceType: string;
  sourceId: string;
  /** Fecha del cobro (para la heurística importe + fecha). */
  date?: IsoDate | null;
};

export type NativeIndex = {
  /** Clave `normalizeNativeDocumentKey(invoiceNumber)` → factura nativa. */
  invoiceKeys: ReadonlyMap<string, NativeEntryRef>;
  /** Importe cobrado (MoneyString) → cobros nativos con fecha (heurística ± 3 días). */
  paymentAmounts?: ReadonlyMap<string, readonly NativeEntryRef[]>;
  /** `nativeSupplierBillKey(NIF, número del proveedor)` → factura recibida contabilizada en Anfitorio (libro de recibidas). */
  supplierBillKeys?: ReadonlyMap<string, NativeEntryRef>;
};

/** Clave de una factura recibida nativa (`SupplierBill`): NIF normalizado del proveedor + número del proveedor normalizado. */
export function nativeSupplierBillKey(taxId: string | null | undefined, invoiceNumber: string | null | undefined): string | null {
  const nif = normalizeNif(taxId ?? null);
  const number = normalizeNativeDocumentKey(invoiceNumber, null);
  if (!nif || !number) return null;
  return `${nif}|${number}`;
}

export type JournalAnalyticsContext = {
  centreDimension: LedgerAnalyticsDimension;
  costCentreDimension?: LedgerAnalyticsDimension | null;
  unassignedPolicy: LedgerUnassignedPolicy;
  map: readonly LedgerAnalyticsMapDto[];
};

export type FiscalYearWindow = { code: string; startDate: IsoDate; endDate: IsoDate };

export type JournalPostingContext = {
  /** Mapa de cuentas ya resuelto por cuenta Sage literal (reglas 1-7 aplicadas). */
  accountMap: ReadonlyMap<string, LedgerAccountMapDto>;
  analytics: JournalAnalyticsContext;
  properties: readonly PostingProperty[];
  officePropertyId: string | null;
  fiscalYear: FiscalYearWindow;
  nativeIndex?: NativeIndex;
  /** Título Sage por cuenta (mensajes de cuentas sin mapear). */
  accountNames?: ReadonlyMap<string, string>;
  /** Existencia y postabilidad de la cuenta destino en el plan (L2 pasa el plan de la organización); sin ella se confía en el mapa. */
  isPostableCode?: (accountCode: string) => boolean;
};

export type JournalEntryStatus = "planned" | "skipped_native" | "unmapped" | "unbalanced" | "centre_required" | "error";

export type JournalEntryError = { sourceEntryNumber: string; sourcePeriod: string; message: string };

export type JournalPostingResult = {
  entries: PlannedEntry[];
  skippedNative: LedgerImportNativeSkippedRow[];
  unmapped: LedgerImportUnmappedAccount[];
  unmappedAnalytics: LedgerImportUnmappedAnalytics[];
  /** Códigos de la dimensión de centro de coste sin mapa (informativo, no bloquea). */
  unmappedCostCentres: LedgerImportUnmappedAnalytics[];
  centreRequired: LedgerImportCentreRequiredRow[];
  unbalanced: LedgerImportUnbalancedRow[];
  closingDetected: LedgerImportClosingDetectedRow[];
  errors: JournalEntryError[];
  warnings: string[];
  /** Estado por clave de asiento Sage (`sageEntryKeyString`). */
  statuses: Map<string, JournalEntryStatus>;
};

export const NATIVE_PAYMENT_DATE_TOLERANCE_DAYS = 3;
export const MAX_DESCRIPTION_LENGTH = 500;
export const MAX_REFERENCE_LENGTH = 200;

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------

function clip(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function dayNumber(iso: IsoDate): number {
  return Math.floor(Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10))) / 86400000);
}

function compareCodes(a: string, b: string): number {
  const na = /^\d+$/.test(a) ? Number(a) : null;
  const nb = /^\d+$/.test(b) ? Number(b) : null;
  if (na !== null && nb !== null) return na - nb;
  return a < b ? -1 : a > b ? 1 : 0;
}

function isPnl(accountCode: string): boolean {
  const group = accountGroup(accountCode);
  return group === 6 || group === 7;
}

function propertyCodeOf(properties: readonly PostingProperty[], propertyId: string | null): string {
  if (!propertyId) return LEDGER_IMPORT_SOCIETY_PROPERTY_CODE;
  const property = properties.find((candidate) => candidate.id === propertyId);
  return property?.code?.trim() || propertyId;
}

function dimensionValue(row: CanonicalJournalRow, dimension: LedgerAnalyticsDimension): string | null {
  switch (dimension) {
    case "canal":
      return row.canal;
    case "delegacion":
      return row.delegacion;
    case "departamento":
      return row.departamento;
    case "seccion":
      return row.seccion;
    default:
      return row.proyecto;
  }
}

/** Reparte `amount` en proporción a `weights` (Σ ≠ 0): cada parte HALF_UP a 2 decimales y el residuo a `heaviest`. Σ partes = amount exactamente. */
export function splitProportionally(amount: Decimal, weights: readonly Decimal[], heaviest: number): Decimal[] {
  const total = weights.reduce((sum, weight) => sum.plus(weight), ZERO);
  if (total.isZero()) throw new Error("splitProportionally: la suma de pesos es cero");
  const shares: Decimal[] = weights.map(() => ZERO);
  let assigned: Decimal = ZERO;
  weights.forEach((weight, index) => {
    if (index === heaviest) return;
    const share = money(amount.times(weight).div(total));
    shares[index] = share;
    assigned = assigned.plus(share);
  });
  shares[heaviest] = money(amount.minus(assigned));
  return shares;
}

/** Línea compartida entre centros: importe con signo (positivo = debe) y base imponible a repartir con la misma proporción. */
export type SharedLine = { net: Decimal; taxBase: Decimal | null };

export type SharedSplit = {
  /** shares[l][c]: importe con signo de la línea compartida l en la parte c. */
  shares: Decimal[][];
  taxShares: Array<Decimal[] | null>;
  heaviest: number;
  warnings: string[];
};

/**
 * Reparte las líneas compartidas (balance) entre las partes en proporción al neto propio de
 * cada parte (`partNets`): cada línea se divide HALF_UP con el residuo en la parte de mayor
 * peso, y después se mueven céntimos entre cada parte y la de mayor peso sobre la línea
 * compartida de mayor importe hasta que CADA parte cuadra (neto propio + repartos = 0). El
 * consolidado por línea es exacto (Σ partes = línea). Σ partNets = 0 → null (no se puede
 * repartir: no hay líneas compartidas que absorban el neto).
 */
export function distributeSharedLines(partNets: readonly Decimal[], shared: readonly SharedLine[]): SharedSplit | null {
  const total = partNets.reduce((sum, net) => sum.plus(net), ZERO);
  if (total.isZero()) return null;
  const warnings: string[] = [];
  if (partNets.some((net) => net.isNegative()) && partNets.some((net) => net.greaterThan(0))) {
    warnings.push("Reparto entre centros con gastos e ingresos de signo distinto: las líneas de balance se reparten en proporción al neto 6/7 de cada centro.");
  }
  let heaviest = 0;
  partNets.forEach((net, index) => {
    if (net.abs().greaterThan(partNets[heaviest]!.abs())) heaviest = index;
  });
  const shares = shared.map((line) => splitProportionally(line.net, partNets, heaviest));
  const taxShares = shared.map((line) => (line.taxBase ? splitProportionally(line.taxBase, partNets, heaviest) : null));
  for (let c = 0; c < partNets.length; c += 1) {
    if (c === heaviest || shares.length === 0) continue;
    const delta = partNets[c]!.plus(shares.reduce((sum, share) => sum.plus(share[c]!), ZERO));
    if (delta.isZero()) continue;
    let best = 0;
    shares.forEach((share, index) => {
      if (share[c]!.abs().greaterThan(shares[best]![c]!.abs())) best = index;
    });
    shares[best]![c] = money(shares[best]![c]!.minus(delta));
    shares[best]![heaviest] = money(shares[best]![heaviest]!.plus(delta));
  }
  return { shares, taxShares, heaviest, warnings };
}

function ruleLine(accountCode: string, side: "debit" | "credit", amount: Decimal, extra: { description?: string | null; taxRateCode?: string | null; taxBase?: Decimal | null; costCenterCode?: string | null; sourceAccount: string }): PlannedLine | null {
  const line = signedLine(accountCode, side, amount, { description: extra.description ?? null, taxRateCode: extra.taxRateCode ?? null, taxBase: extra.taxBase ?? null, costCenterId: null });
  if (!line) return null;
  return { ...line, costCenterCode: extra.costCenterCode ?? null, sourceAccount: extra.sourceAccount };
}

function totals(lines: readonly RuleLine[]): { debit: Decimal; credit: Decimal } {
  return { debit: sumMoney(lines.map((line) => line.debit)), credit: sumMoney(lines.map((line) => line.credit)) };
}

// ---------------------------------------------------------------------------
// Diario (§4.5, §4.6, §5.1)
// ---------------------------------------------------------------------------

type MappedLine = {
  row: CanonicalJournalRow;
  accountCode: string;
  description: string | null;
  taxRateCode: string | null;
  taxBase: Decimal | null;
  /** Importe con signo: positivo = debe, negativo = haber. */
  net: Decimal;
  propertyId: string | null;
  costCenterCode: string | null;
  pnl: boolean;
};

function nativeKeysOf(lines: readonly CanonicalJournalRow[]): Array<{ key: string; series: string | null; number: string | null }> {
  const out = new Map<string, { key: string; series: string | null; number: string | null }>();
  const add = (key: string | null, series: string | null, number: string | null): void => {
    if (key && !out.has(key)) out.set(key, { key, series, number });
  };
  for (const line of lines) {
    if (line.factura) add(normalizeNativeDocumentKey(line.serie, line.factura), line.serie, line.factura);
    if (line.su_factura_no) add(normalizeNativeDocumentKey(line.su_factura_no, null), null, line.su_factura_no);
    if (line.documento) {
      add(normalizeNativeDocumentKey(line.documento, null), null, line.documento);
      for (const key of documentKeysInText(line.documento)) add(key, null, line.documento);
    }
    for (const key of documentKeysInText(line.concepto)) add(key, null, null);
  }
  return [...out.values()];
}

function detectEntryKind(entry: SageJournalEntry, mapped: readonly MappedLine[], fiscalYear: FiscalYearWindow): LedgerImportEntryKind {
  const period = entry.key.period;
  if (period === SAGE_PERIOD_CODES.regularization) return "regularization";
  if (period === SAGE_PERIOD_CODES.closing) return "closing";
  if (period === SAGE_PERIOD_CODES.opening) return "opening";
  const hasPnl = mapped.some((line) => line.pnl);
  const has129 = mapped.some((line) => line.accountCode === RESULT_ACCOUNT || line.accountCode.startsWith(`${RESULT_ACCOUNT}.`));
  const onlyPnlAnd129 = mapped.every((line) => line.pnl || line.accountCode === RESULT_ACCOUNT || line.accountCode.startsWith(`${RESULT_ACCOUNT}.`));
  const isYearEnd = entry.entryDate === fiscalYear.endDate;
  const isYearStart = entry.entryDate === fiscalYear.startDate;
  const concept = entry.lines.map((line) => line.concepto ?? "").join(" ").toLowerCase();
  if (hasPnl && has129 && isYearEnd && onlyPnlAnd129) return "regularization";
  // Un cierre / apertura de verdad mueve varios grupos de balance a la vez: un traspaso 572 → 570
  // («Apertura cuenta bancaria nueva») o un «Cierre de caja» 570 / 572 tocan un solo grupo.
  const balanceGroups = new Set(mapped.filter((line) => !line.pnl).map((line) => accountGroup(line.accountCode)));
  if (!hasPnl && isYearEnd && balanceGroups.size >= 2 && /cierre/.test(concept) && !/apertura/.test(concept)) return "closing";
  if (!hasPnl && isYearStart && balanceGroups.size >= 2 && /apertura/.test(concept)) return "opening";
  return "normal";
}

/**
 * Asientos Sage → asientos Anfitorio planificados (uno por (asiento, centro)), más las
 * listas que la previsualización muestra y que bloquean la contabilización.
 */
export function buildJournalEntries(sageEntries: readonly SageJournalEntry[], ctx: JournalPostingContext): JournalPostingResult {
  const result: JournalPostingResult = {
    entries: [],
    skippedNative: [],
    unmapped: [],
    unmappedAnalytics: [],
    unmappedCostCentres: [],
    centreRequired: [],
    unbalanced: [],
    closingDetected: [],
    errors: [],
    warnings: [],
    statuses: new Map()
  };
  const unmappedByAccount = new Map<string, LedgerImportUnmappedAccount>();
  const unmappedCentres = new Map<string, LedgerImportUnmappedAnalytics>();
  const unmappedCost = new Map<string, LedgerImportUnmappedAnalytics>();
  const analyticsIndex = new Map<string, LedgerAnalyticsMapDto>();
  for (const entry of ctx.analytics.map) analyticsIndex.set(`${entry.dimension}:${entry.sourceCode.trim()}`, entry);
  const propertyIds = new Set(ctx.properties.map((property) => property.id));
  const policy = ctx.analytics.unassignedPolicy;
  const policyProperty = policy.startsWith(LEDGER_UNASSIGNED_POLICY_PROPERTY_PREFIX) ? policy.slice(LEDGER_UNASSIGNED_POLICY_PROPERTY_PREFIX.length) : null;
  if (policyProperty && !propertyIds.has(policyProperty)) result.warnings.push(`La política de apuntes sin analítica apunta a un centro que no es de la organización: se tratará como «block».`);
  if (policy === "office" && !ctx.officePropertyId) result.warnings.push("La política «office» necesita una oficina central: los apuntes 6/7 sin analítica quedarán bloqueados.");
  let paymentHeuristicCount = 0;
  /** Cobros nativos ya emparejados por la heurística de importe + fecha: cada uno excluye UN asiento de Sage como máximo. */
  const consumedPayments = new Set<string>();
  /** Pasada previa: el cobro cuya factura se cita en un asiento de Sage (documento / concepto) queda reservado para ESE asiento. */
  const reservedPayments = new Map<string, NativeEntryRef>();
  const isPaymentShaped = (entry: SageJournalEntry): boolean => entry.lines.every((line) => !isPnl(line.cuenta)) && entry.lines.some((line) => /^57/.test(line.cuenta)) && entry.lines.some((line) => /^43/.test(line.cuenta));
  const paymentRefKey = (ref: NativeEntryRef): string => `${ref.sourceType}/${ref.sourceId}`;
  if (ctx.nativeIndex?.paymentAmounts) {
    for (const entry of sageEntries) {
      if (!isPaymentShaped(entry)) continue;
      const amount = sumMoney(entry.lines.map((line) => line.debe)).toFixed(2);
      const day = dayNumber(entry.entryDate);
      const textKeys = new Set(nativeKeysOf(entry.lines).map((candidate) => candidate.key));
      const named = (ctx.nativeIndex.paymentAmounts.get(amount) ?? []).find((ref) => ref.date && !consumedPayments.has(paymentRefKey(ref)) && ref.invoiceNumber && textKeys.has(normalizeNativeDocumentKey(ref.invoiceNumber, null) ?? "") && Math.abs(dayNumber(ref.date) - day) <= NATIVE_PAYMENT_DATE_TOLERANCE_DAYS);
      if (named) {
        consumedPayments.add(paymentRefKey(named));
        reservedPayments.set(sageEntryKeyString(entry.key), named);
      }
    }
  }

  for (const entry of sageEntries) {
    const key = sageEntryKeyString(entry.key);
    const sourceEntryNumber = entry.key.entryNumber;
    const sourcePeriod = entry.key.period;
    const entryWarnings = [...entry.warnings];

    // Fecha dentro del ejercicio de destino.
    if (entry.entryDate < ctx.fiscalYear.startDate || entry.entryDate > ctx.fiscalYear.endDate) {
      result.errors.push({ sourceEntryNumber, sourcePeriod, message: `la fecha ${entry.entryDate} está fuera del ejercicio ${ctx.fiscalYear.code} (${ctx.fiscalYear.startDate} – ${ctx.fiscalYear.endDate})` });
      result.statuses.set(key, "error");
      continue;
    }

    // Cuadre del asiento Sage tal cual llega.
    const rawDebit = sumMoney(entry.lines.map((line) => line.debe));
    const rawCredit = sumMoney(entry.lines.map((line) => line.haber));
    if (!rawDebit.equals(rawCredit)) {
      result.unbalanced.push({ sourceEntryNumber, sourcePeriod, debit: rawDebit.toFixed(2), credit: rawCredit.toFixed(2) });
      result.statuses.set(key, "unbalanced");
      continue;
    }

    // (a) exclusión de documentos nativos.
    if (ctx.nativeIndex) {
      let skipped: LedgerImportNativeSkippedRow | null = null;
      for (const candidate of nativeKeysOf(entry.lines)) {
        const ref = ctx.nativeIndex.invoiceKeys.get(candidate.key);
        if (ref) {
          skipped = { sourceEntryNumber, sourcePeriod, sourceChannel: entry.key.channel, series: candidate.series, number: candidate.number, invoiceNumber: ref.invoiceNumber, sourceType: ref.sourceType, sourceId: ref.sourceId };
          break;
        }
      }
      if (!skipped && ctx.nativeIndex.paymentAmounts && isPaymentShaped(entry)) {
        const day = dayNumber(entry.entryDate);
        // El cobro reservado en la pasada previa (su factura se cita en el asiento) o, si no, el cobro libre más cercano en fecha.
        const reserved = reservedPayments.get(key);
        const match = reserved ?? [...(ctx.nativeIndex.paymentAmounts.get(rawDebit.toFixed(2)) ?? [])]
          .filter((ref) => ref.date && !consumedPayments.has(paymentRefKey(ref)) && Math.abs(dayNumber(ref.date) - day) <= NATIVE_PAYMENT_DATE_TOLERANCE_DAYS)
          .sort((a, b) => Math.abs(dayNumber(a.date!) - day) - Math.abs(dayNumber(b.date!) - day))[0];
        if (match) {
          consumedPayments.add(paymentRefKey(match));
          skipped = { sourceEntryNumber, sourcePeriod, sourceChannel: entry.key.channel, series: null, number: null, invoiceNumber: match.invoiceNumber, sourceType: match.sourceType, sourceId: match.sourceId };
          paymentHeuristicCount += 1;
        }
      }
      if (skipped) {
        result.skippedNative.push(skipped);
        result.statuses.set(key, "skipped_native");
        continue;
      }
    }

    // (c/d) mapa de cuentas apunte a apunte.
    const mapped: MappedLine[] = [];
    let entryUnmapped = false;
    for (const row of entry.lines) {
      const mapping = ctx.accountMap.get(row.cuenta);
      let accountCode: string | null = null;
      let reason: string | null = null;
      if (!mapping || !isPostableMapping(mapping)) reason = mapping ? "bloqueada en el mapa" : "sin entrada en el mapa";
      else if (mapping.action === "map_by_rate") {
        if (row.tipo_iva === null) reason = "cuenta de IVA por tipo sin tipo impositivo en el apunte";
        else accountCode = accountForRate(mapping.accountCode!, row.tipo_iva);
      } else accountCode = mapping.accountCode;
      if (accountCode && ctx.isPostableCode && !ctx.isPostableCode(accountCode)) {
        reason = mapping!.action === "create" ? `la subcuenta ${accountCode} aún no existe en el plan (guarda el mapa o importa el plan de cuentas antes)` : `la cuenta destino ${accountCode} no existe en el plan o no admite apuntes`;
        accountCode = null;
      }
      if (!accountCode) {
        entryUnmapped = true;
        const existing = unmappedByAccount.get(row.cuenta);
        if (existing) existing.lineCount += 1;
        else unmappedByAccount.set(row.cuenta, { sourceAccount: row.cuenta, sourceName: ctx.accountNames?.get(row.cuenta) ?? mapping?.sourceName ?? null, lineCount: 1, suggestion: mapping && mapping.action !== "block" ? mapping : null });
        if (reason && reason !== "sin entrada en el mapa" && reason !== "bloqueada en el mapa") entryWarnings.push(`Cuenta ${row.cuenta}: ${reason}.`);
        continue;
      }
      const pnl = isPnl(accountCode);
      const description = mapping!.action === "collapse" && mapping!.carryCounterparty
        ? clip(["Sage " + row.cuenta, row.nif, row.nombre].filter((part): part is string => !!part).join(" · "), MAX_DESCRIPTION_LENGTH)
        : row.concepto
          ? clip(row.concepto, MAX_DESCRIPTION_LENGTH)
          : null;
      const vatAccount = /^(472|477)(\.|$)/.test(accountCode);
      const taxRateCode = vatAccount && row.tipo_iva !== null ? String(Math.round(Number(row.tipo_iva))) : null;
      const taxBase = vatAccount && row.base_iva !== null ? money(row.base_iva) : null;
      // Analítica: centro de trabajo.
      let propertyId: string | null = null;
      const centreCode = dimensionValue(row, ctx.analytics.centreDimension);
      if (centreCode) {
        const analytics = analyticsIndex.get(`${ctx.analytics.centreDimension}:${centreCode}`);
        if (analytics?.propertyId && propertyIds.has(analytics.propertyId)) propertyId = analytics.propertyId;
        else {
          const existing = unmappedCentres.get(centreCode);
          if (existing) existing.lineCount += 1;
          else unmappedCentres.set(centreCode, { dimension: ctx.analytics.centreDimension, sourceCode: centreCode, sourceName: analytics?.sourceName ?? null, lineCount: 1 });
        }
      }
      // Analítica: centro de coste USALI (solo 6/7).
      let costCenterCode: string | null = null;
      if (pnl && ctx.analytics.costCentreDimension) {
        const costCode = dimensionValue(row, ctx.analytics.costCentreDimension);
        if (costCode) {
          const analytics = analyticsIndex.get(`${ctx.analytics.costCentreDimension}:${costCode}`);
          if (analytics?.costCentreCode) costCenterCode = analytics.costCentreCode;
          else {
            const existing = unmappedCost.get(costCode);
            if (existing) existing.lineCount += 1;
            else unmappedCost.set(costCode, { dimension: ctx.analytics.costCentreDimension, sourceCode: costCode, sourceName: analytics?.sourceName ?? null, lineCount: 1 });
          }
        }
      }
      mapped.push({ row, accountCode, description, taxRateCode, taxBase, net: money(row.debe).minus(money(row.haber)), propertyId, costCenterCode, pnl });
    }
    if (entryUnmapped) {
      result.statuses.set(key, "unmapped");
      continue;
    }

    // (b) tipo de asiento.
    const entryKind = detectEntryKind(entry, mapped, ctx.fiscalYear);
    if (entryKind !== "normal") result.closingDetected.push({ sourceEntryNumber, sourcePeriod, entryKind });

    // 6/7 sin centro → política (los tipos de cierre / apertura están exentos de R4).
    if (entryKind === "normal") {
      const missing = mapped.filter((line) => line.pnl && !line.propertyId);
      if (missing.length > 0) {
        let target: string | null = null;
        if (policy === "office") target = ctx.officePropertyId;
        else if (policyProperty && propertyIds.has(policyProperty)) target = policyProperty;
        if (!target) {
          result.centreRequired.push({ sourceEntryNumber, sourcePeriod, accounts: [...new Set(missing.map((line) => line.row.cuenta))] });
          result.statuses.set(key, "centre_required");
          continue;
        }
        for (const line of missing) line.propertyId = target;
        entryWarnings.push(`${missing.length} apuntes de gastos / ingresos sin analítica imputados por política a ${propertyCodeOf(ctx.properties, target)}.`);
      }
    }

    // (c) partes por centro.
    const pnlCentres = [...new Set(mapped.filter((line) => line.pnl && line.propertyId).map((line) => line.propertyId!))];
    const diario = entry.lines[0]?.diario ?? "0";
    const reference = clip(`Sage 200 · asiento ${entry.key.fiscalYear}/${sourceEntryNumber} · periodo ${sourcePeriod} · diario ${diario}`, MAX_REFERENCE_LENGTH);
    const description = clip(entry.lines.find((line) => line.concepto)?.concepto ?? `Asiento Sage 200 ${entry.key.fiscalYear}/${sourceEntryNumber}`, MAX_DESCRIPTION_LENGTH);
    const base = { entryDate: entry.entryDate, entryKind, description, reference, fiscalYearCode: ctx.fiscalYear.code, source: { companyCode: entry.key.companyCode, fiscalYear: entry.key.fiscalYear, period: sourcePeriod, entryNumber: sourceEntryNumber, channel: entry.key.channel } };

    const finish = (parts: Array<{ propertyId: string | null; lines: PlannedLine[]; warnings: string[] }>): void => {
      const planned: PlannedEntry[] = [];
      for (const part of parts) {
        if (part.lines.length > LEDGER_IMPORT_MAX_LINES_PER_ENTRY) {
          result.errors.push({ sourceEntryNumber, sourcePeriod, message: `el asiento tiene ${part.lines.length} líneas y el máximo es ${LEDGER_IMPORT_MAX_LINES_PER_ENTRY}` });
          result.statuses.set(key, "error");
          return;
        }
        if (part.lines.length < 2) {
          result.errors.push({ sourceEntryNumber, sourcePeriod, message: "el asiento queda con menos de dos líneas" });
          result.statuses.set(key, "error");
          return;
        }
        try {
          assertBalanced(part.lines);
        } catch (error) {
          const sums = totals(part.lines);
          result.unbalanced.push({ sourceEntryNumber, sourcePeriod, debit: sums.debit.toFixed(2), credit: sums.credit.toFixed(2) });
          result.statuses.set(key, "unbalanced");
          if (!(error instanceof HttpError)) throw error;
          return;
        }
        const sums = totals(part.lines);
        const propertyCode = propertyCodeOf(ctx.properties, part.propertyId);
        planned.push({
          ...base,
          sourceType: LEDGER_IMPORT_SOURCE_TYPES.journal,
          sourceId: ledgerImportJournalSourceId({ companyCode: entry.key.companyCode, fiscalYear: entry.key.fiscalYear, period: sourcePeriod, entryNumber: sourceEntryNumber, channel: entry.key.channel, propertyCode: parts.length > 1 ? propertyCode : null }),
          propertyId: part.propertyId,
          propertyCode,
          lines: part.lines,
          totalDebit: sums.debit.toFixed(2),
          totalCredit: sums.credit.toFixed(2),
          splitParts: parts.length,
          warnings: [...entryWarnings, ...part.warnings]
        });
      }
      result.entries.push(...planned);
      result.statuses.set(key, "planned");
    };

    const toLine = (line: MappedLine, amount: Decimal, extra: { taxBase?: Decimal | null } = {}): PlannedLine | null =>
      ruleLine(line.accountCode, "debit", amount, {
        description: line.description,
        taxRateCode: line.taxRateCode,
        taxBase: extra.taxBase === undefined ? line.taxBase : extra.taxBase,
        costCenterCode: line.pnl ? line.costCenterCode : null,
        sourceAccount: line.row.cuenta
      });

    if (pnlCentres.length <= 1 || entryKind !== "normal") {
      let propertyId: string | null = pnlCentres[0] ?? null;
      if (entryKind !== "normal") propertyId = null; // apertura / regularización / cierre: nivel sociedad
      else if (pnlCentres.length === 0) {
        const centres = new Set(mapped.map((line) => line.propertyId));
        propertyId = centres.size === 1 ? ([...centres][0] ?? null) : null;
      }
      const lines = mapped.map((line) => toLine(line, line.net)).filter((line): line is PlannedLine => line !== null);
      finish([{ propertyId, lines, warnings: [] }]);
      continue;
    }

    // Varios centros: reparto de las líneas de balance en proporción al neto 6/7 de cada centro.
    const weights = pnlCentres.map((centre) => mapped.filter((line) => line.pnl && line.propertyId === centre).reduce((sum, line) => sum.plus(line.net), ZERO));
    const balanceLines = mapped.filter((line) => !line.pnl);
    const split = distributeSharedLines(weights, balanceLines.map((line) => ({ net: line.net, taxBase: line.taxBase })));
    if (!split) {
      result.errors.push({ sourceEntryNumber, sourcePeriod, message: "el asiento reparte gastos / ingresos entre varios centros sin líneas de balance: no se puede dividir por centro" });
      result.statuses.set(key, "error");
      continue;
    }
    const parts = pnlCentres.map((centre, c) => {
      const lines: PlannedLine[] = [];
      for (const line of mapped) {
        if (!line.pnl) continue;
        if (line.propertyId !== centre) continue;
        const planned = toLine(line, line.net);
        if (planned) lines.push(planned);
      }
      balanceLines.forEach((line, index) => {
        const planned = toLine(line, split.shares[index]![c]!, { taxBase: split.taxShares[index] ? split.taxShares[index]![c]! : null });
        if (planned) lines.push(planned);
      });
      return { propertyId: centre, lines, warnings: [...split.warnings, `Asiento repartido entre ${pnlCentres.length} centros (parte ${c + 1}).`] };
    });
    finish(parts);
  }

  result.unmapped = [...unmappedByAccount.values()].sort((a, b) => compareCodes(a.sourceAccount, b.sourceAccount));
  result.unmappedAnalytics = [...unmappedCentres.values()].sort((a, b) => a.sourceCode.localeCompare(b.sourceCode));
  result.unmappedCostCentres = [...unmappedCost.values()].sort((a, b) => a.sourceCode.localeCompare(b.sourceCode));
  if (paymentHeuristicCount > 0) result.warnings.push(`${paymentHeuristicCount} cobros excluidos por coincidencia de importe y fecha (± ${NATIVE_PAYMENT_DATE_TOLERANCE_DAYS} días) con cobros propios de ${BRAND.name}: revísalos en la lista de excluidos.`);
  // (f) orden por fecha, nº Sage y centro.
  result.entries.sort((a, b) => (a.entryDate < b.entryDate ? -1 : a.entryDate > b.entryDate ? 1 : 0) || compareCodes(a.source?.entryNumber ?? "", b.source?.entryNumber ?? "") || a.propertyCode.localeCompare(b.propertyCode));
  return result;
}

// ---------------------------------------------------------------------------
// Saldos sin diario (§6)
// ---------------------------------------------------------------------------

export type BalancePostingContext = {
  accountMap: ReadonlyMap<string, LedgerAccountMapDto>;
  fiscalYear: FiscalYearWindow;
  properties: readonly PostingProperty[];
  unassignedPolicy: LedgerUnassignedPolicy;
  officePropertyId?: string | null;
  /** Delegación / canal Sage → propertyId (mapa analítico de la dimensión de centro); sin entrada se casa por código de centro. */
  centreMap?: ReadonlyMap<string, string | null>;
  companyCode?: string;
  /** Saldos de cierre del ejercicio anterior (última fila de cada cuenta) para validar apertura(N+1) = cierre(N). */
  previousClosing?: readonly CanonicalBalanceRow[];
  /** Existencia y postabilidad de la cuenta destino en el plan (L2); sin ella se confía en el mapa. */
  isPostableCode?: (accountCode: string) => boolean;
};

export type BalanceUnbalancedRow = {
  periodCode: string;
  propertyCode: string;
  debit: MoneyString;
  credit: MoneyString;
  difference: MoneyString;
  /** Cuentas con mayor importe neto de la parte (pista de dónde está el descuadre). */
  accounts: Array<{ accountCode: string; amount: MoneyString }>;
};

export type BalanceContinuityDifference = { accountCode: string; closing: MoneyString; opening: MoneyString; delta: MoneyString };

export type BalanceImportRow = {
  fiscalYearCode: string;
  periodCode: string;
  propertyId: string | null;
  propertyCode: string;
  sourceAccount: string;
  sourceName: string | null;
  accountCode: string;
  openingDebit: MoneyString;
  openingCredit: MoneyString;
  periodDebit: MoneyString;
  periodCredit: MoneyString;
  closingBalance: MoneyString;
};

export type BalancePostingResult = {
  entries: PlannedEntry[];
  unmapped: LedgerImportUnmappedAccount[];
  centreRequired: Array<{ periodCode: string; propertyCode: string; accounts: string[] }>;
  unbalanced: BalanceUnbalancedRow[];
  /** null si no había saldos del ejercicio anterior con los que comparar. */
  continuity: { ok: boolean; differences: BalanceContinuityDifference[] } | null;
  /** Filas para LedgerImportBalance (histórico y drawer «Detalle Sage»). */
  balances: BalanceImportRow[];
  warnings: string[];
};

function isFirstPeriodOfYear(period: string, year: string): boolean {
  return period === `${year}-01` || period === `${year}-Q1` || period === year;
}

function isLastPeriodOfYear(period: string, year: string): boolean {
  return period === `${year}-12` || period === `${year}-Q4` || period === year;
}

function accountOfBalanceRow(row: CanonicalBalanceRow, accountMap: ReadonlyMap<string, LedgerAccountMapDto>, isPostableCode?: (accountCode: string) => boolean): string | null {
  const mapping = accountMap.get(row.cuenta);
  if (!mapping || !isPostableMapping(mapping)) return null;
  if (mapping.action === "map_by_rate") return null;
  if (isPostableCode && !isPostableCode(mapping.accountCode!)) return null;
  return mapping.accountCode;
}

/**
 * Propuesta que la preview muestra para una fila de saldos sin cuenta destino válida: un balance no
 * trae el tipo de IVA, así que `map_by_rate` no sirve (se ofrece elegir la subcuenta 477.xx / 472.xx a mano).
 */
function balanceSuggestionOf(mapping: LedgerAccountMapDto | undefined): LedgerAccountMapDto | null {
  if (!mapping || mapping.action === "block") return null;
  if (mapping.action === "map_by_rate") return { ...mapping, action: "map", accountCode: null, suggested: true };
  return mapping;
}

function balanceNet(row: CanonicalBalanceRow): Decimal {
  return money(row.saldo_deudor).minus(money(row.saldo_acreedor));
}

function openingNet(row: CanonicalBalanceRow): Decimal {
  return money(row.apertura_debe).minus(money(row.apertura_haber));
}

/**
 * Sumas y saldos por periodo → apertura + asientos resumen + (opcional) regularización y
 * cierre del ejercicio `ctx.fiscalYear`. Las filas de otros ejercicios se ignoran con aviso.
 */
export function buildBalanceEntries(balanceRows: readonly CanonicalBalanceRow[], ctx: BalancePostingContext): BalancePostingResult {
  const result: BalancePostingResult = { entries: [], unmapped: [], centreRequired: [], unbalanced: [], continuity: null, balances: [], warnings: [] };
  const year = ctx.fiscalYear.code;
  const rows = balanceRows.filter((row) => row.ejercicio === year);
  const ignored = balanceRows.length - rows.length;
  if (ignored > 0) result.warnings.push(`${ignored} filas de otros ejercicios se ignoran (el lote es del ejercicio ${year}).`);
  if (rows.length === 0) {
    result.warnings.push(`El fichero no tiene filas del ejercicio ${year}.`);
    return result;
  }
  const companyCode = ctx.companyCode ?? rows[0]!.empresa;
  const unmappedByAccount = new Map<string, LedgerImportUnmappedAccount>();
  const policy = ctx.unassignedPolicy;
  const policyProperty = policy.startsWith(LEDGER_UNASSIGNED_POLICY_PROPERTY_PREFIX) ? policy.slice(LEDGER_UNASSIGNED_POLICY_PROPERTY_PREFIX.length) : null;
  const propertyIds = new Set(ctx.properties.map((property) => property.id));

  const resolveCentre = (delegacion: string | null): string | null => {
    if (!delegacion) return null;
    if (ctx.centreMap?.has(delegacion)) return ctx.centreMap.get(delegacion) ?? null;
    const byCode = ctx.properties.find((property) => property.code && property.code.trim().toUpperCase() === delegacion.trim().toUpperCase());
    return byCode?.id ?? null;
  };

  // Mapa de cuentas de todas las filas.
  const mappedRows: Array<{ row: CanonicalBalanceRow; accountCode: string }> = [];
  for (const row of rows) {
    const accountCode = accountOfBalanceRow(row, ctx.accountMap, ctx.isPostableCode);
    if (!accountCode) {
      const mapping = ctx.accountMap.get(row.cuenta);
      const existing = unmappedByAccount.get(row.cuenta);
      if (existing) existing.lineCount += 1;
      else unmappedByAccount.set(row.cuenta, { sourceAccount: row.cuenta, sourceName: row.titulo, lineCount: 1, suggestion: balanceSuggestionOf(mapping) });
      if (mapping?.action === "map_by_rate") result.warnings.push(`Cuenta ${row.cuenta}: en un balance no se conoce el tipo de IVA de cada importe; mapéala a una subcuenta concreta (${mapping.accountCode}.xx).`);
      continue;
    }
    mappedRows.push({ row, accountCode });
    const propertyId = resolveCentre(row.delegacion);
    result.balances.push({
      fiscalYearCode: year,
      periodCode: row.periodo,
      propertyId,
      propertyCode: row.delegacion ? propertyCodeOf(ctx.properties, propertyId) === LEDGER_IMPORT_SOCIETY_PROPERTY_CODE ? row.delegacion : propertyCodeOf(ctx.properties, propertyId) : LEDGER_IMPORT_SOCIETY_PROPERTY_CODE,
      sourceAccount: row.cuenta,
      sourceName: row.titulo,
      accountCode,
      openingDebit: money(row.apertura_debe).toFixed(2),
      openingCredit: money(row.apertura_haber).toFixed(2),
      periodDebit: money(row.debe).toFixed(2),
      periodCredit: money(row.haber).toFixed(2),
      closingBalance: balanceNet(row).toFixed(2)
    });
  }
  result.unmapped = [...unmappedByAccount.values()].sort((a, b) => compareCodes(a.sourceAccount, b.sourceAccount));
  if (result.unmapped.length > 0) return result;

  const periods = [...new Set(mappedRows.map(({ row }) => row.periodo))].filter((period) => period !== LEDGER_IMPORT_OPENING_PERIOD_CODE).sort();
  const openingRows = mappedRows.filter(({ row }) => row.periodo === LEDGER_IMPORT_OPENING_PERIOD_CODE);
  const firstPeriod = periods[0] ?? null;

  // 1 · Apertura: filas «apertura» o las columnas de apertura del primer periodo del ejercicio.
  const openingByAccount = new Map<string, Decimal>();
  let openingSource: "rows" | "columns" | null = null;
  if (openingRows.length > 0) {
    openingSource = "rows";
    for (const { row, accountCode } of openingRows) {
      const net = balanceNet(row).isZero() ? money(row.debe).minus(money(row.haber)) : balanceNet(row);
      openingByAccount.set(accountCode, (openingByAccount.get(accountCode) ?? ZERO).plus(net));
    }
  } else if (firstPeriod && isFirstPeriodOfYear(firstPeriod, year)) {
    openingSource = "columns";
    for (const { row, accountCode } of mappedRows) {
      if (row.periodo !== firstPeriod) continue;
      openingByAccount.set(accountCode, (openingByAccount.get(accountCode) ?? ZERO).plus(openingNet(row)));
    }
  } else if (firstPeriod) {
    result.warnings.push(`El primer periodo del fichero es ${firstPeriod}: sin filas de apertura ni el primer periodo del ejercicio no se genera el asiento de apertura (las columnas de apertura se toman como «sumas anteriores»).`);
  }
  if (openingSource) {
    const lines: PlannedLine[] = [];
    let ignoredPnl = 0;
    let result129: Decimal = ZERO;
    for (const [accountCode, net] of openingByAccount) {
      if (net.isZero()) continue;
      if (isPnl(accountCode)) {
        ignoredPnl += 1;
        continue;
      }
      if (accountCode === RESULT_ACCOUNT) {
        result129 = result129.plus(net);
        continue;
      }
      const line = ruleLine(accountCode, "debit", net, { description: `Apertura ${year} (Sage 200)`, sourceAccount: accountCode });
      if (line) lines.push(line);
    }
    const sums = totals(lines);
    const gap = sums.debit.minus(sums.credit);
    // 129 = lo que cuadra la apertura (el resultado del ejercicio anterior); el 129 declarado solo se coteja.
    const resultLine = gap.negated();
    if (!result129.isZero() && !result129.equals(resultLine)) {
      result.warnings.push(`La apertura no cuadra con el 129 declarado (${result129.toFixed(2)}): se lleva a 129 el importe que cuadra (${resultLine.toFixed(2)}).`);
    } else if (result129.isZero() && !gap.isZero()) {
      result.warnings.push(`La apertura no trae saldo de 129: se lleva el descuadre (${resultLine.toFixed(2)}) a 129 como resultado del ejercicio anterior.`);
    }
    const line129 = ruleLine(RESULT_ACCOUNT, "debit", resultLine, { description: `Apertura ${year} (Sage 200) · resultado del ejercicio anterior`, sourceAccount: RESULT_ACCOUNT });
    if (line129) lines.push(line129);
    if (ignoredPnl > 0) result.warnings.push(`${ignoredPnl} cuentas de grupos 6/7 con saldo de apertura: se ignoran en la apertura.`);
    if (lines.length >= 2) {
      try {
        assertBalanced(lines);
        const totalsOpening = totals(lines);
        result.entries.push({
          sourceType: LEDGER_IMPORT_SOURCE_TYPES.balance,
          sourceId: ledgerImportBalanceSourceId({ companyCode, fiscalYear: year, period: LEDGER_IMPORT_OPENING_PERIOD_CODE, propertyCode: LEDGER_IMPORT_SOCIETY_PROPERTY_CODE }),
          entryDate: ctx.fiscalYear.startDate,
          entryKind: "opening",
          description: clip(`Apertura del ejercicio ${year} (saldos importados de Sage 200)`, MAX_DESCRIPTION_LENGTH),
          reference: clip(`Sage 200 · apertura ${year}`, MAX_REFERENCE_LENGTH),
          propertyId: null,
          propertyCode: LEDGER_IMPORT_SOCIETY_PROPERTY_CODE,
          fiscalYearCode: year,
          lines,
          totalDebit: totalsOpening.debit.toFixed(2),
          totalCredit: totalsOpening.credit.toFixed(2),
          source: null,
          splitParts: 1,
          warnings: []
        });
      } catch (error) {
        if (!(error instanceof HttpError)) throw error;
        const sums2 = totals(lines);
        result.unbalanced.push({ periodCode: LEDGER_IMPORT_OPENING_PERIOD_CODE, propertyCode: LEDGER_IMPORT_SOCIETY_PROPERTY_CODE, debit: sums2.debit.toFixed(2), credit: sums2.credit.toFixed(2), difference: sums2.debit.minus(sums2.credit).toFixed(2), accounts: topAccounts(lines) });
      }
    } else if (openingByAccount.size > 0) {
      result.warnings.push("La apertura no tiene importes: no se genera asiento de apertura.");
    }
  }

  // 2 · Movimiento bruto por periodo: las filas con delegación llevan su centro; las filas de balance
  //     de sociedad (sin delegación) se reparten entre los centros con 6/7 como en el diario (§4.5).
  const periodsToPost = [...new Set(mappedRows.filter(({ row }) => row.periodo !== LEDGER_IMPORT_OPENING_PERIOD_CODE).map(({ row }) => row.periodo))].sort();
  for (const period of periodsToPost) {
    const entryDate = balancePeriodEndDate(period);
    if (!entryDate || entryDate < ctx.fiscalYear.startDate || entryDate > ctx.fiscalYear.endDate) {
      result.warnings.push(`El periodo ${period} no cae dentro del ejercicio ${year}: se ignora.`);
      continue;
    }
    type Owned = { line: PlannedLine; net: Decimal; pnl: boolean; propertyId: string | null; delegacion: string | null };
    const owned: Owned[] = [];
    const missingCentre = new Set<string>();
    let blocked = false;
    for (const { row, accountCode } of mappedRows.filter(({ row }) => row.periodo === period)) {
      const pnl = isPnl(accountCode);
      let propertyId = resolveCentre(row.delegacion);
      if (row.delegacion && !propertyId) missingCentre.add(row.delegacion);
      if (pnl && !propertyId && (!money(row.debe).isZero() || !money(row.haber).isZero())) {
        let target: string | null = null;
        if (policy === "office") target = ctx.officePropertyId ?? null;
        else if (policyProperty && propertyIds.has(policyProperty)) target = policyProperty;
        if (!target) {
          blocked = true;
          result.centreRequired.push({ periodCode: period, propertyCode: row.delegacion ?? LEDGER_IMPORT_SOCIETY_PROPERTY_CODE, accounts: [row.cuenta] });
          continue;
        }
        propertyId = target;
      }
      const description = row.titulo ? clip(row.titulo, MAX_DESCRIPTION_LENGTH) : null;
      const debit = ruleLine(accountCode, "debit", money(row.debe), { description, sourceAccount: row.cuenta });
      const credit = ruleLine(accountCode, "credit", money(row.haber), { description, sourceAccount: row.cuenta });
      if (debit) owned.push({ line: debit, net: money(row.debe), pnl, propertyId, delegacion: row.delegacion });
      if (credit) owned.push({ line: credit, net: money(row.haber).negated(), pnl, propertyId, delegacion: row.delegacion });
    }
    if (missingCentre.size > 0) result.warnings.push(`Periodo ${period}: delegaciones sin centro en el mapa analítico (${[...missingCentre].join(", ")}); sus filas de balance van a nivel sociedad.`);
    if (blocked) {
      // Compacta las cuentas bloqueadas del periodo en una sola fila.
      const rows = result.centreRequired.filter((item) => item.periodCode === period);
      const accounts = [...new Set(rows.flatMap((item) => item.accounts))];
      result.centreRequired = result.centreRequired.filter((item) => item.periodCode !== period);
      result.centreRequired.push({ periodCode: period, propertyCode: rows[0]?.propertyCode ?? LEDGER_IMPORT_SOCIETY_PROPERTY_CODE, accounts });
      continue;
    }
    if (owned.length === 0) continue;
    const centres = [...new Set(owned.filter((item) => item.propertyId).map((item) => item.propertyId!))];
    const shared = owned.filter((item) => !item.propertyId);
    const pushPeriodEntry = (propertyId: string | null, lines: PlannedLine[], extraWarnings: string[]): void => {
      if (lines.length === 0) return;
      const sums = totals(lines);
      const propertyCode = propertyId ? propertyCodeOf(ctx.properties, propertyId) : LEDGER_IMPORT_SOCIETY_PROPERTY_CODE;
      if (!sums.debit.equals(sums.credit) || lines.length < 2) {
        result.unbalanced.push({ periodCode: period, propertyCode, debit: sums.debit.toFixed(2), credit: sums.credit.toFixed(2), difference: sums.debit.minus(sums.credit).toFixed(2), accounts: topAccounts(lines) });
        return;
      }
      result.entries.push({
        sourceType: LEDGER_IMPORT_SOURCE_TYPES.balance,
        sourceId: ledgerImportBalanceSourceId({ companyCode, fiscalYear: year, period, propertyCode }),
        entryDate,
        entryKind: "normal",
        description: clip(`Movimientos del periodo ${period}${propertyId ? ` · ${propertyCode}` : ""} (saldos importados de Sage 200)`, MAX_DESCRIPTION_LENGTH),
        reference: clip(`Sage 200 · saldos ${period.replace(/^(\d{4})-(\d{2})$/, "$1/$2")}${propertyId ? ` · ${propertyCode}` : ""}`, MAX_REFERENCE_LENGTH),
        propertyId,
        propertyCode,
        fiscalYearCode: year,
        lines,
        totalDebit: sums.debit.toFixed(2),
        totalCredit: sums.credit.toFixed(2),
        source: null,
        splitParts: centres.length > 1 ? centres.length : 1,
        warnings: extraWarnings
      });
    };
    if (centres.length === 0) {
      pushPeriodEntry(null, owned.map((item) => item.line), []);
      continue;
    }
    if (centres.length === 1) {
      pushPeriodEntry(centres[0]!, owned.map((item) => item.line), []);
      continue;
    }
    const partNets = centres.map((centre) => owned.filter((item) => item.propertyId === centre).reduce((sum, item) => sum.plus(item.net), ZERO));
    if (partNets.every((net) => net.isZero())) {
      // Fichero entero por delegación («Hoja adicional canales/delegaciones» con cada delegación cuadrada, o el
      // canónico con delegación en todas las filas): un asiento por centro y, si hay filas de sociedad, cuadran solas.
      centres.forEach((centre) => pushPeriodEntry(centre, owned.filter((item) => item.propertyId === centre).map((item) => item.line), []));
      if (shared.length > 0) pushPeriodEntry(null, shared.map((item) => item.line), [`Periodo ${period}: las filas sin delegación cuadran por sí solas y van a nivel sociedad.`]);
      continue;
    }
    const split = distributeSharedLines(partNets, shared.map((item) => ({ net: item.net, taxBase: null })));
    if (!split) {
      // Σ neto de los centros = 0 pero alguno no cuadra: no hay proporción con la que repartir; se señala cada parte descuadrada.
      centres.forEach((centre, c) => {
        if (partNets[c]!.isZero()) return;
        const lines = owned.filter((item) => item.propertyId === centre).map((item) => item.line);
        const sums = totals(lines);
        result.unbalanced.push({ periodCode: period, propertyCode: propertyCodeOf(ctx.properties, centre), debit: sums.debit.toFixed(2), credit: sums.credit.toFixed(2), difference: sums.debit.minus(sums.credit).toFixed(2), accounts: topAccounts(lines) });
      });
      continue;
    }
    centres.forEach((centre, c) => {
      const lines: PlannedLine[] = owned.filter((item) => item.propertyId === centre).map((item) => item.line);
      shared.forEach((item, index) => {
        const share = ruleLine(item.line.accountCode, "debit", split.shares[index]![c]!, { description: item.line.description, sourceAccount: item.line.sourceAccount });
        if (share) lines.push(share);
      });
      pushPeriodEntry(centre, lines, [...split.warnings, `Periodo repartido entre ${centres.length} centros (parte ${c + 1}): las cuentas de balance de sociedad van en proporción al neto 6/7 de cada centro.`]);
    });
  }

  // 3 · Regularización y cierre si el último periodo del ejercicio trae saldos de cierre.
  const lastPeriod = periods.length > 0 ? periods[periods.length - 1]! : null;
  if (lastPeriod && isLastPeriodOfYear(lastPeriod, year)) {
    const lastRows = mappedRows.filter(({ row }) => row.periodo === lastPeriod);
    const hasClosing = lastRows.some(({ row }) => !balanceNet(row).isZero());
    if (hasClosing) {
      const closingByAccount = new Map<string, Decimal>();
      for (const { row, accountCode } of lastRows) closingByAccount.set(accountCode, (closingByAccount.get(accountCode) ?? ZERO).plus(balanceNet(row)));
      // Cotejo con apertura + movimientos del ejercicio cuando el fichero es completo.
      if (openingSource && periods.every((period) => /^\d{4}-\d{2}$/.test(period)) && periods.length === 12) {
        const computed = new Map<string, Decimal>();
        for (const [accountCode, net] of openingByAccount) computed.set(accountCode, net);
        for (const { row, accountCode } of mappedRows) {
          if (row.periodo === LEDGER_IMPORT_OPENING_PERIOD_CODE) continue;
          computed.set(accountCode, (computed.get(accountCode) ?? ZERO).plus(money(row.debe)).minus(money(row.haber)));
        }
        const mismatches = [...closingByAccount].filter(([accountCode, net]) => !net.equals(computed.get(accountCode) ?? ZERO)).map(([accountCode]) => accountCode);
        if (mismatches.length > 0) result.warnings.push(`Los saldos de cierre declarados no coinciden con apertura + movimientos en ${mismatches.length} cuentas (${mismatches.slice(0, 5).join(", ")}${mismatches.length > 5 ? "…" : ""}): se usan los declarados.`);
      }
      // Regularización: 6/7 contra 129.
      const regLines: PlannedLine[] = [];
      let resultNet: Decimal = ZERO;
      for (const [accountCode, net] of closingByAccount) {
        if (!isPnl(accountCode) || net.isZero()) continue;
        const line = ruleLine(accountCode, "credit", net, { description: `Regularización ${year} (Sage 200)`, sourceAccount: accountCode });
        if (line) regLines.push(line);
        resultNet = resultNet.plus(net);
      }
      if (regLines.length > 0) {
        const line129 = ruleLine(RESULT_ACCOUNT, "debit", resultNet, { description: `Regularización ${year} (Sage 200) · resultado del ejercicio`, sourceAccount: RESULT_ACCOUNT });
        if (line129) regLines.push(line129);
        pushYearEndEntry(result, regLines, "regularization", SAGE_PERIOD_CODES.regularization, ctx, companyCode, `Regularización del ejercicio ${year} (saldos importados de Sage 200)`);
      }
      // Cierre: grupos 1-5 (129 con el resultado).
      const closeLines: PlannedLine[] = [];
      for (const [accountCode, net] of closingByAccount) {
        if (isPnl(accountCode)) continue;
        const adjusted = accountCode === RESULT_ACCOUNT ? net.plus(resultNet) : net;
        if (adjusted.isZero()) continue;
        const line = ruleLine(accountCode, "credit", adjusted, { description: `Cierre ${year} (Sage 200)`, sourceAccount: accountCode });
        if (line) closeLines.push(line);
      }
      if (!closingByAccount.has(RESULT_ACCOUNT) && !resultNet.isZero()) {
        const line = ruleLine(RESULT_ACCOUNT, "credit", resultNet, { description: `Cierre ${year} (Sage 200)`, sourceAccount: RESULT_ACCOUNT });
        if (line) closeLines.push(line);
      }
      if (closeLines.length > 0) pushYearEndEntry(result, closeLines, "closing", SAGE_PERIOD_CODES.closing, ctx, companyCode, `Cierre del ejercicio ${year} (saldos importados de Sage 200)`);
    }
  }

  // 4 · apertura(N+1) = cierre(N).
  if (ctx.previousClosing && ctx.previousClosing.length > 0 && openingSource) {
    const previous = new Map<string, Decimal>();
    let previousResult: Decimal = ZERO;
    for (const row of ctx.previousClosing) {
      const accountCode = accountOfBalanceRow(row, ctx.accountMap);
      if (!accountCode) continue;
      if (isPnl(accountCode)) {
        previousResult = previousResult.plus(balanceNet(row));
        continue;
      }
      previous.set(accountCode, (previous.get(accountCode) ?? ZERO).plus(balanceNet(row)));
    }
    // El cierre de N deja el resultado en 129: se compara con la apertura de N+1 tras la regularización.
    if (!previousResult.isZero()) previous.set(RESULT_ACCOUNT, (previous.get(RESULT_ACCOUNT) ?? ZERO).plus(previousResult));
    const differences: BalanceContinuityDifference[] = [];
    const accounts = new Set([...previous.keys(), ...[...openingByAccount.keys()].filter((code) => !isPnl(code))]);
    for (const accountCode of [...accounts].sort(compareCodes)) {
      const closing = previous.get(accountCode) ?? ZERO;
      const opening = openingByAccount.get(accountCode) ?? ZERO;
      if (!closing.equals(opening)) differences.push({ accountCode, closing: closing.toFixed(2), opening: opening.toFixed(2), delta: opening.minus(closing).toFixed(2) });
    }
    result.continuity = { ok: differences.length === 0, differences };
    if (differences.length > 0) result.warnings.push(`La apertura de ${year} no coincide con el cierre del ejercicio anterior en ${differences.length} cuentas.`);
  }

  result.entries.sort((a, b) => (a.entryDate < b.entryDate ? -1 : a.entryDate > b.entryDate ? 1 : 0) || kindOrder(a.entryKind) - kindOrder(b.entryKind) || a.propertyCode.localeCompare(b.propertyCode));
  return result;
}

function kindOrder(kind: LedgerImportEntryKind): number {
  return kind === "opening" ? 0 : kind === "normal" ? 1 : kind === "regularization" ? 2 : 3;
}

function topAccounts(lines: readonly PlannedLine[]): Array<{ accountCode: string; amount: MoneyString }> {
  const byAccount = new Map<string, Decimal>();
  for (const line of lines) byAccount.set(line.accountCode, (byAccount.get(line.accountCode) ?? ZERO).plus(money(line.debit)).minus(money(line.credit)));
  return [...byAccount]
    .sort((a, b) => b[1].abs().comparedTo(a[1].abs()))
    .slice(0, 5)
    .map(([accountCode, amount]) => ({ accountCode, amount: amount.toFixed(2) }));
}

function pushYearEndEntry(result: BalancePostingResult, lines: PlannedLine[], entryKind: LedgerImportEntryKind, periodCode: string, ctx: BalancePostingContext, companyCode: string, description: string): void {
  const sums = totals(lines);
  if (!sums.debit.equals(sums.credit) || lines.length < 2) {
    result.unbalanced.push({ periodCode, propertyCode: LEDGER_IMPORT_SOCIETY_PROPERTY_CODE, debit: sums.debit.toFixed(2), credit: sums.credit.toFixed(2), difference: sums.debit.minus(sums.credit).toFixed(2), accounts: topAccounts(lines) });
    return;
  }
  assertBalanced(lines);
  result.entries.push({
    sourceType: LEDGER_IMPORT_SOURCE_TYPES.balance,
    sourceId: ledgerImportBalanceSourceId({ companyCode, fiscalYear: ctx.fiscalYear.code, period: periodCode, propertyCode: LEDGER_IMPORT_SOCIETY_PROPERTY_CODE }),
    entryDate: ctx.fiscalYear.endDate,
    entryKind,
    description: clip(description, MAX_DESCRIPTION_LENGTH),
    reference: clip(`Sage 200 · ${periodCode} ${ctx.fiscalYear.code}`, MAX_REFERENCE_LENGTH),
    propertyId: null,
    propertyCode: LEDGER_IMPORT_SOCIETY_PROPERTY_CODE,
    fiscalYearCode: ctx.fiscalYear.code,
    lines,
    totalDebit: sums.debit.toFixed(2),
    totalCredit: sums.credit.toFixed(2),
    source: null,
    splitParts: 1,
    warnings: []
  });
}

/** Saldos de cierre del ejercicio N (últimas filas de cada cuenta) frente a la apertura del N+1: diferencias al céntimo por cuenta (cuentas Sage literales, sin mapa). */
export function checkOpeningContinuity(closingOfPreviousYear: readonly CanonicalBalanceRow[], openingOfNextYear: readonly CanonicalBalanceRow[]): { ok: boolean; differences: BalanceContinuityDifference[] } {
  const closing = new Map<string, Decimal>();
  let previousResult: Decimal = ZERO;
  let resultAccount: string | null = null;
  for (const row of closingOfPreviousYear) {
    if (/^[67]/.test(row.cuenta)) {
      previousResult = previousResult.plus(balanceNet(row));
      continue;
    }
    if (/^129/.test(row.cuenta) && resultAccount === null) resultAccount = row.cuenta;
    closing.set(row.cuenta, (closing.get(row.cuenta) ?? ZERO).plus(balanceNet(row)));
  }
  // El resultado del ejercicio N queda en 129 tras la regularización de Sage.
  if (!previousResult.isZero()) {
    const account = resultAccount ?? [...openingOfNextYear].find((row) => /^129/.test(row.cuenta))?.cuenta ?? "129";
    closing.set(account, (closing.get(account) ?? ZERO).plus(previousResult));
  }
  const opening = new Map<string, Decimal>();
  for (const row of openingOfNextYear) {
    if (/^[67]/.test(row.cuenta)) continue;
    const net = row.periodo === LEDGER_IMPORT_OPENING_PERIOD_CODE ? (balanceNet(row).isZero() ? money(row.debe).minus(money(row.haber)) : balanceNet(row)) : openingNet(row);
    opening.set(row.cuenta, (opening.get(row.cuenta) ?? ZERO).plus(net));
  }
  const differences: BalanceContinuityDifference[] = [];
  for (const account of [...new Set([...closing.keys(), ...opening.keys()])].sort(compareCodes)) {
    const a = closing.get(account) ?? ZERO;
    const b = opening.get(account) ?? ZERO;
    if (!a.equals(b)) differences.push({ accountCode: account, closing: a.toFixed(2), opening: b.toFixed(2), delta: b.minus(a).toFixed(2) });
  }
  return { ok: differences.length === 0, differences };
}

// ---------------------------------------------------------------------------
// Libros de IVA
// ---------------------------------------------------------------------------

export type VatBookRowsContext = {
  periodicity: VatPeriodicityCode;
  organizationId: string;
  propertyId?: string | null;
  companyCode?: string;
  /** IVA por defecto; las filas con tipo de IGIC / IPSI se marcan igual (el libro no distingue la figura). */
  taxFigure?: string;
  /** Documentos nativos de Anfitorio (§5.1): sus filas del libro de Sage se excluyen (los escritores propios ya las materializan). */
  nativeIndex?: NativeIndex;
};

/**
 * Filas canónicas del libro → VatBookRow (sourceType sage200, sourceId
 * `<empresa>:<ejercicio factura>:<serie>:<factura>[:<NIF>][:R]` — el NIF solo en recibidas,
 * donde el número es el del proveedor —, period por periodCodeForDate). Varias filas de la
 * misma factura con tipos distintos comparten sourceId (la clave única del libro incluye
 * `rate`). Con `nativeIndex`, una emitida cuya serie + número es una factura de Anfitorio, o
 * una recibida ya contabilizada en Anfitorio (NIF + número del proveedor), va a `skippedNative`.
 */
export function buildVatBookRows(vatRows: readonly CanonicalVatRow[], ctx: VatBookRowsContext): { rows: VatBookRow[]; warnings: string[]; skippedNative: LedgerImportNativeSkippedRow[] } {
  const rows: VatBookRow[] = [];
  const warnings: string[] = [];
  const skippedNative: LedgerImportNativeSkippedRow[] = [];
  const seen = new Map<string, number>();
  const skippedKeys = new Set<string>();
  for (const row of vatRows) {
    const companyCode = ctx.companyCode ?? row.empresa;
    const counterpartyNif = normalizeNif(row.nif);
    const sourceId = ledgerImportVatBookSourceId({ companyCode, fiscalYear: row.ejercicio, series: row.serie ?? "", number: row.numero, rectification: row.rectificativa, counterpartyNif: row.libro === "recibidas" ? counterpartyNif : null });
    const native = ctx.nativeIndex ? nativeRefOfVatRow(row, counterpartyNif, ctx.nativeIndex) : null;
    if (native) {
      const skipKey = `${row.libro}|${sourceId}`;
      if (!skippedKeys.has(skipKey)) {
        skippedKeys.add(skipKey);
        skippedNative.push({ sourceEntryNumber: row.numero, sourcePeriod: periodCodeForDate(row.fecha, ctx.periodicity), sourceChannel: row.libro, series: row.serie, number: row.numero, invoiceNumber: native.invoiceNumber, sourceType: native.sourceType, sourceId: native.sourceId });
      }
      continue;
    }
    const key = `${row.libro}|${sourceId}|${row.tipo_iva}`;
    const times = (seen.get(key) ?? 0) + 1;
    seen.set(key, times);
    if (times > 1) {
      warnings.push(`Factura ${row.serie ? `${row.serie}/` : ""}${row.numero} (${row.libro}) repetida con el mismo tipo ${row.tipo_iva} %: se suman las bases y cuotas.`);
      const existing = rows.find((candidate) => candidate.book === row.libro && candidate.sourceId === sourceId && candidate.rate.equals(money(row.tipo_iva)));
      if (existing) {
        existing.base = existing.base.plus(money(row.base));
        existing.quota = existing.quota.plus(money(row.cuota));
        existing.total = existing.total.plus(money(row.total));
        existing.retention = existing.retention.plus(money(row.retencion ?? 0));
        if (row.cuota_recargo) existing.surchargeQuota = (existing.surchargeQuota ?? ZERO).plus(money(row.cuota_recargo));
        continue;
      }
    }
    rows.push({
      id: null,
      organizationId: ctx.organizationId,
      propertyId: ctx.propertyId ?? null,
      book: row.libro,
      date: row.fecha,
      series: row.serie,
      number: row.numero,
      counterpartyNif: normalizeNif(row.nif),
      counterpartyName: row.nombre,
      base: money(row.base),
      rate: money(row.tipo_iva),
      quota: money(row.cuota),
      total: money(row.total),
      retention: money(row.retencion ?? 0),
      taxFigure: ctx.taxFigure ?? "IVA",
      surchargeRate: row.tipo_recargo !== null ? money(row.tipo_recargo) : null,
      surchargeQuota: row.cuota_recargo !== null ? money(row.cuota_recargo) : null,
      sourceType: LEDGER_VAT_BOOK_SOURCE_TYPE,
      sourceId,
      period: periodCodeForDate(row.fecha, ctx.periodicity),
      deductible: row.libro === "recibidas" ? !(row.cuota_deducible !== null && money(row.cuota_deducible).isZero() && !money(row.cuota).isZero()) : true
    });
  }
  if (skippedNative.length > 0) warnings.push(`Modo sombra: ${skippedNative.length} factura(s) del libro de Sage son documentos propios de ${BRAND.name} (ya materializados en los libros) y se omiten.`);
  return { rows, warnings, skippedNative };
}

/** Documento nativo con el que coincide una fila del libro de Sage: emitidas por serie + número (o el número impreso completo); recibidas por NIF + número del proveedor. */
function nativeRefOfVatRow(row: CanonicalVatRow, counterpartyNif: string | null, index: NativeIndex): NativeEntryRef | null {
  if (row.libro === "emitidas") {
    for (const key of [normalizeNativeDocumentKey(row.serie, row.numero), normalizeNativeDocumentKey(row.numero, null)]) {
      const ref = key ? index.invoiceKeys.get(key) : undefined;
      if (ref) return ref;
    }
    return null;
  }
  const key = nativeSupplierBillKey(counterpartyNif, row.numero);
  return key ? index.supplierBillKeys?.get(key) ?? null : null;
}

// ---------------------------------------------------------------------------
// Reconciliación (§5.2)
// ---------------------------------------------------------------------------

export type ReconciliationLedgerRow = {
  accountCode: string;
  accountName?: string | null;
  debit: MoneyString | Decimal;
  credit: MoneyString | Decimal;
  /** Saldo a la fecha final (grupos 1-5); si falta se toma debit − credit. */
  balance?: MoneyString | Decimal | null;
  /** sourceType de los asientos que mueven la cuenta en el rango (para native_only). */
  sourceTypes?: readonly string[];
};

export type ReconciliationContext = {
  accountMap: ReadonlyMap<string, LedgerAccountMapDto>;
  /** Tolerancia base (MoneyString); por defecto LEDGER_RECONCILIATION_TOLERANCES.consolidated. */
  tolerance?: MoneyString;
  /** Nº de asientos repartidos por centro que tocan cada cuenta destino en el rango (suma 0,01 × n a la tolerancia; solo por centro). */
  splitEntriesByAccount?: ReadonlyMap<string, number>;
  /** Nombres de cuenta destino (para la tabla). */
  accountNames?: ReadonlyMap<string, string>;
};

export type ReconciliationResult = {
  rows: LedgerReconciliationRow[];
  status: LedgerReconciliationStatus;
  accountsCompared: number;
  differenceCount: number;
  summary: { nativeOnly: number; missingInLedger: number; amountDiff: number; vatDiff: number; tolerance: MoneyString; criterion: string };
};

const IMPORTED_SOURCE_TYPES: readonly string[] = [LEDGER_IMPORT_SOURCE_TYPES.journal, LEDGER_IMPORT_SOURCE_TYPES.balance];

export const RECONCILIATION_CRITERION = `Diario de ${BRAND.name} con status ≠ draft, sin parejas de reversión; movimientos del rango sin regularization / closing / opening; saldo a la fecha final con apertura (balance_at) y sin la regularización ni el cierre fechados ese día. Sage: sumas y saldos nivel 0 agrupadas por cuenta destino del mapa; saldo = el acumulado de la última fila de cada cuenta; IVA por tipo (472 / 477) comparado por prefijo.`;

/**
 * Balance de Sage (filas del periodo) frente al diario de Anfitorio por cuenta destino:
 * delta = Anfitorio − Sage; ok si |delta| ≤ tolerancia; clasificación amount_diff /
 * native_only (movimiento solo nativo en Anfitorio) / missing_in_ledger (Sage sin
 * contrapartida en el diario, o cuenta sin mapear).
 */
export function buildReconciliationRows(sageBalanceRows: readonly CanonicalBalanceRow[], ledgerRows: readonly ReconciliationLedgerRow[], ctx: ReconciliationContext): ReconciliationResult {
  const baseTolerance = money(ctx.tolerance ?? LEDGER_RECONCILIATION_TOLERANCES.consolidated);
  const perSplit = money(LEDGER_RECONCILIATION_TOLERANCES.perCentrePerSplitEntry);
  type SourceAgg = { sourceAccounts: Set<string>; debit: Decimal; credit: Decimal; balance: Decimal; unmapped: boolean };
  const source = new Map<string, SourceAgg>();
  // El saldo de Sage («saldo_deudor / saldo_acreedor») es el ACUMULADO al cierre de cada periodo: con un balance
  // mensual sobre un rango mayor se toma la ÚLTIMA fila de cada (cuenta, delegación), nunca la suma de los saldos.
  const lastByAccount = new Map<string, { row: CanonicalBalanceRow; end: string }>();
  for (const row of sageBalanceRows) {
    if (row.periodo === LEDGER_IMPORT_OPENING_PERIOD_CODE) continue;
    const key = `${row.cuenta}|${row.delegacion ?? ""}`;
    const end = balancePeriodEndDate(row.periodo) ?? row.periodo;
    const current = lastByAccount.get(key);
    if (!current || end >= current.end) lastByAccount.set(key, { row, end });
  }
  const byRatePrefixes = new Set<string>();
  for (const row of sageBalanceRows) {
    if (row.periodo === LEDGER_IMPORT_OPENING_PERIOD_CODE) continue;
    const mapping = ctx.accountMap.get(row.cuenta);
    const mapped = !!mapping && isPostableMapping(mapping);
    // Cuentas de IVA por tipo (regla 5): la cuenta Sage 4770000 se compara con la suma de las 477.xx del diario.
    if (mapped && mapping!.action === "map_by_rate") byRatePrefixes.add(mapping!.accountCode!);
    const target = mapped ? mapping!.accountCode! : row.cuenta;
    const agg = source.get(target) ?? { sourceAccounts: new Set<string>(), debit: ZERO, credit: ZERO, balance: ZERO, unmapped: !mapped };
    agg.sourceAccounts.add(row.cuenta);
    agg.debit = agg.debit.plus(money(row.debe));
    agg.credit = agg.credit.plus(money(row.haber));
    if (lastByAccount.get(`${row.cuenta}|${row.delegacion ?? ""}`)?.row === row) agg.balance = agg.balance.plus(balanceNet(row));
    agg.unmapped = agg.unmapped || !mapped;
    source.set(target, agg);
  }
  const ledger = new Map<string, { debit: Decimal; credit: Decimal; balance: Decimal; sourceTypes: readonly string[]; name: string | null }>();
  const ledgerKeyOf = (accountCode: string): string => {
    if (source.has(accountCode)) return accountCode;
    for (const prefix of byRatePrefixes) if (accountCode === prefix || accountCode.startsWith(`${prefix}.`)) return prefix;
    return accountCode;
  };
  for (const row of ledgerRows) {
    const debit = money(row.debit);
    const credit = money(row.credit);
    const balance = row.balance === null || row.balance === undefined ? debit.minus(credit) : money(row.balance);
    const key = ledgerKeyOf(row.accountCode);
    const existing = ledger.get(key);
    if (existing) {
      existing.debit = existing.debit.plus(debit);
      existing.credit = existing.credit.plus(credit);
      existing.balance = existing.balance.plus(balance);
      existing.sourceTypes = [...new Set([...existing.sourceTypes, ...(row.sourceTypes ?? [])])];
      if (!existing.name && row.accountName) existing.name = row.accountName;
    } else ledger.set(key, { debit, credit, balance, sourceTypes: row.sourceTypes ?? [], name: key === row.accountCode ? row.accountName ?? null : ctx.accountNames?.get(key) ?? null });
  }

  const rows: LedgerReconciliationRow[] = [];
  const accounts = [...new Set([...source.keys(), ...ledger.keys()])].sort(compareCodes);
  let nativeOnly = 0;
  let missingInLedger = 0;
  let amountDiff = 0;
  for (const accountCode of accounts) {
    const s = source.get(accountCode);
    const l = ledger.get(accountCode);
    const splits = ctx.splitEntriesByAccount?.get(accountCode) ?? 0;
    const tolerance = baseTolerance.plus(perSplit.times(splits));
    const sourceDebit = s?.debit ?? ZERO;
    const sourceCredit = s?.credit ?? ZERO;
    const sourceBalance = s?.balance ?? ZERO;
    const ledgerDebit = l?.debit ?? ZERO;
    const ledgerCredit = l?.credit ?? ZERO;
    const ledgerBalance = l?.balance ?? ZERO;
    const diffDebit = ledgerDebit.minus(sourceDebit);
    const diffCredit = ledgerCredit.minus(sourceCredit);
    const diffBalance = ledgerBalance.minus(sourceBalance);
    const within = diffDebit.abs().lte(tolerance) && diffCredit.abs().lte(tolerance) && diffBalance.abs().lte(tolerance);
    let classification: LedgerReconciliationClassification | null = null;
    let note: string | undefined;
    const sourceHasAmounts = !sourceDebit.isZero() || !sourceCredit.isZero() || !sourceBalance.isZero();
    const ledgerHasAmounts = !ledgerDebit.isZero() || !ledgerCredit.isZero() || !ledgerBalance.isZero();
    if (s?.unmapped && sourceHasAmounts) {
      classification = "missing_in_ledger";
      note = "cuenta Sage sin mapear: no llega al diario";
      missingInLedger += 1;
    } else if (!within) {
      if (!s && l && ledgerHasAmounts && l.sourceTypes.length > 0 && !l.sourceTypes.some((type) => IMPORTED_SOURCE_TYPES.includes(type))) {
        classification = "native_only";
        note = `movimiento solo en ${BRAND.name} (${l.sourceTypes.join(", ")})`;
        nativeOnly += 1;
      } else if (s && sourceHasAmounts && (!l || !ledgerHasAmounts)) {
        classification = "missing_in_ledger";
        note = `Sage tiene movimiento y el diario de ${BRAND.name} no`;
        missingInLedger += 1;
      } else {
        classification = "amount_diff";
        amountDiff += 1;
      }
    }
    rows.push({
      accountCode,
      sourceAccounts: [...(s?.sourceAccounts ?? [])].sort(compareCodes),
      accountName: ctx.accountNames?.get(accountCode) ?? l?.name ?? null,
      sourceDebit: sourceDebit.toFixed(2),
      sourceCredit: sourceCredit.toFixed(2),
      ledgerDebit: ledgerDebit.toFixed(2),
      ledgerCredit: ledgerCredit.toFixed(2),
      diffDebit: diffDebit.toFixed(2),
      diffCredit: diffCredit.toFixed(2),
      sourceBalance: sourceBalance.toFixed(2),
      ledgerBalance: ledgerBalance.toFixed(2),
      diffBalance: diffBalance.toFixed(2),
      classification,
      tolerance: tolerance.toFixed(2),
      ok: classification === null,
      ...(note ? { note } : {})
    });
  }
  const differenceCount = rows.filter((row) => !row.ok).length;
  return {
    rows,
    status: differenceCount === 0 ? "ok" : "differences",
    accountsCompared: rows.length,
    differenceCount,
    summary: { nativeOnly, missingInLedger, amountDiff, vatDiff: 0, tolerance: baseTolerance.toFixed(2), criterion: RECONCILIATION_CRITERION }
  };
}
