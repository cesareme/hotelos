// Importación contable desde Sage 200 (Tanda 7c · L2) — reconciliación del modo
// sombra (design §5.2): el balance de sumas y saldos de Sage del rango (nivel 0)
// frente al diario de Anfitorio por cuenta destino del mapa, con tolerancias y
// clasificación (`buildReconciliationRows`, L1). Persiste `LedgerReconciliation` y
// audita LEDGER_RECONCILIATION_RUN.
//
// Lado Anfitorio (`aggregateAccountBalances`, accounting.service.ts — lee el prisma raíz:
// por eso el lote `journal` la ejecuta DESPUÉS de su commit):
//   · Debe / Haber del periodo por cuenta = { from, to, excludeKinds: [regularization,
//     closing, opening] } — la misma regla que `movements` de financial-statements/source.ts
//     (status ≠ draft, sin parejas de reversión, sin los asientos de cierre);
//   · saldo a `to` de los grupos 1-5 = { to, closingCutoff: to, regularizationCutoff: to } (≡
//     `balance_at`: incluye la apertura y deja fuera el cierre Y la regularización fechados ese
//     día: el balance de Sage «hasta el periodo 12» tiene 129 sin el resultado del ejercicio),
//     filtrado por grupo en memoria;
//   · saldo de los grupos 6/7 = neto acumulado del ejercicio hasta `to` (lo que Sage llama
//     «saldo» en sus cuentas de gasto / ingreso), también sin regularization / closing / opening.
// Diferencia con «Sumas y saldos» (accounting/trial-balance.service.ts:97-103): ese informe NO
// excluye los `entryKind` de cierre (solo aplica `closingCutoff`); aquí se excluyen para que la
// comparación con el balance de Sage «hasta el periodo 12» no arrastre regularización ni
// cierre. El criterio se declara en `summary.criterion`.
// Tolerancias (LEDGER_RECONCILIATION_TOLERANCES): consolidado (sin propertyId) 0,00; por
// centro 0,01 × nº de asientos repartidos por centro que tocan la cuenta en el rango
// (LedgerImportEntry posted con propertyCode ≠ SOC y sourceId con el sufijo del centro).
// Clasificación: amount_diff · native_only (movimiento solo de sourceType no sage200_* en el
// rango) · missing_in_ledger (cuenta Sage sin mapear o sin contrapartida; además las filas
// unmapped / error / skipped_native del `importId` dado) · vat_diff (pendiente: exige adjuntar
// el libro de IVA de Sage; `summary.vatDiff` queda en 0).
// CSV: BOM UTF-8, separador «;», decimales con coma (como el diario para gestoría).

import { prisma } from "@hotelos/database";
import { Prisma } from "@prisma/client";
import {
  LEDGER_IMPORT_SOCIETY_PROPERTY_CODE,
  LEDGER_IMPORT_LIST_DEFAULT_LIMIT,
  LEDGER_IMPORT_LIST_MAX_LIMIT,
  LEDGER_RECONCILIATION_TOLERANCES,
  type LedgerImportEntryStatus,
  type LedgerImportFormat,
  type LedgerReconciliationBody,
  type LedgerReconciliationDto,
  type LedgerReconciliationListQuery,
  type LedgerReconciliationMissingEntry,
  type LedgerReconciliationRow,
  type LedgerReconciliationStatus,
  type LedgerReconciliationSummary,
  type MoneyString
} from "@hotelos/shared";
import type { UserContext } from "../../../lib/demo-store.js";
import { assertFinanceReadScopeMany, hasEntityReadScope, resolveLedgerScope } from "../../../lib/finance-scope.js";
import { isIsoDate } from "../../../lib/query-dates.js";
import { recordAuditEvent } from "../../audit/audit.service.js";
import { requirePermissions } from "../../auth/auth.service.js";
import { ZERO, aggregateAccountBalances, dateOnlyUtc, isoDay, ledgerBadRequest, ledgerNotFound, money, type Decimal } from "../accounting.service.js";
import { accountGroup } from "../chart-of-accounts.service.js";
import { balancePeriodEndDate, contentHashOf, normalizeRows, type CanonicalBalanceRow } from "./ledger-import.canonical.js";
import { buildReconciliationRows, type ReconciliationLedgerRow } from "./ledger-import.posting.js";
import { decodeImportContent, loadChartLookup, loadPersistedAccountMap, loadProperties, propertyCodeOf, resolveEffectiveAccountMap, toHttpError, type Db } from "./ledger-import.service.js";
import { parseLedgerImportFile } from "./sage200.parser.js";

// ---------------------------------------------------------------------------
// Constantes y tipos
// ---------------------------------------------------------------------------

const RECONCILIATION_NOT_FOUND = "Reconciliación no encontrada.";
/** entryKind que NO cuentan como movimiento del periodo (misma lista que `movements`, source.ts). */
export const RECONCILIATION_EXCLUDED_KINDS: readonly string[] = Object.freeze(["regularization", "closing", "opening"]);
/** Criterio de lectura declarado en `summary.criterion` (en español). */
export const RECONCILIATION_CRITERION_ES = "Movimientos del rango sin regularization / closing / opening (status ≠ draft, sin parejas de reversión); saldo a la fecha final sin el cierre ni la regularización del día (balance_at, con apertura) en grupos 1-5 y neto acumulado del ejercicio en 6/7; el saldo de Sage es el acumulado de la última fila de cada cuenta y las cuentas de IVA por tipo (472 / 477) se comparan por prefijo. Difiere de «Sumas y saldos», que no excluye los asientos de cierre.";
/** Estados de LedgerImportEntry que cuentan como «asiento Sage no importado». */
export const MISSING_ENTRY_STATUSES: readonly LedgerImportEntryStatus[] = Object.freeze(["unmapped", "error", "skipped_native"]);

type ReconciliationRow = NonNullable<Awaited<ReturnType<typeof prisma.ledgerReconciliation.findUnique>>>;

/** Balance de Sage adjunto (mismo contrato de contenido que la preview de un lote). */
export type ReconciliationBalanceInput = { content?: string | null; contentBase64?: string | null; format?: LedgerImportFormat; fileName?: string; sheetName?: string };

export type ReconciliationCsvRow = Pick<LedgerReconciliationRow, "accountCode" | "accountName" | "sourceAccounts" | "sourceDebit" | "sourceCredit" | "ledgerDebit" | "ledgerCredit" | "diffDebit" | "diffCredit" | "sourceBalance" | "ledgerBalance" | "diffBalance" | "tolerance" | "ok" | "classification" | "note">;

// ---------------------------------------------------------------------------
// Puros
// ---------------------------------------------------------------------------

/** Código de periodo de saldos que cubre exactamente [from, to]: mes «YYYY-MM», trimestre «YYYY-Qn», año «YYYY»; si no coincide con ninguno, el año de `to`. */
export function periodCodeForRange(from: string, to: string): string {
  const year = from.slice(0, 4);
  const month = Number(from.slice(5, 7));
  if (from.endsWith("-01")) {
    const monthly = `${year}-${String(month).padStart(2, "0")}`;
    if (balancePeriodEndDate(monthly) === to) return monthly;
    if ((month - 1) % 3 === 0) {
      const quarterly = `${year}-Q${Math.floor((month - 1) / 3) + 1}`;
      if (balancePeriodEndDate(quarterly) === to) return quarterly;
    }
    if (month === 1 && to === `${year}-12-31`) return year;
  }
  return to.slice(0, 4);
}

/** Filas del balance cuyo periodo cae dentro de [from, to] (fin de periodo) o es el ejercicio entero; si ninguna cae, se devuelven todas (el fichero es del rango por construcción). */
export function balanceRowsInRange(rows: readonly CanonicalBalanceRow[], from: string, to: string): { rows: CanonicalBalanceRow[]; filtered: boolean } {
  const year = to.slice(0, 4);
  const inRange = rows.filter((row) => {
    if (row.periodo === year) return true;
    const end = balancePeriodEndDate(row.periodo);
    return end !== null && end >= from && end <= to;
  });
  if (inRange.length === 0) return { rows: [...rows], filtered: false };
  return { rows: inRange, filtered: inRange.length !== rows.length };
}

/** Nº de asientos repartidos por centro (sourceId con el sufijo del centro) que tocan cada cuenta; la tolerancia por centro es 0,01 × ese nº. */
export function splitEntriesByAccountOf(entries: ReadonlyArray<{ journalEntryId: string; sourceId: string | null; propertyCode: string }>, lines: ReadonlyArray<{ journalEntryId: string; accountCode: string | null }>): Map<string, number> {
  const split = new Set<string>();
  for (const entry of entries) {
    if (entry.propertyCode === LEDGER_IMPORT_SOCIETY_PROPERTY_CODE || !entry.sourceId) continue;
    const key = entry.sourceId.replace(/#\d+$/, "");
    if (key.endsWith(`:${entry.propertyCode}`)) split.add(entry.journalEntryId);
  }
  const byAccount = new Map<string, Set<string>>();
  for (const line of lines) {
    if (!line.accountCode || !split.has(line.journalEntryId)) continue;
    const set = byAccount.get(line.accountCode) ?? new Set<string>();
    set.add(line.journalEntryId);
    byAccount.set(line.accountCode, set);
  }
  return new Map([...byAccount].map(([accountCode, set]) => [accountCode, set.size]));
}

/** Tolerancia base según el ámbito: consolidado 0,00; por centro la base es 0,00 más 0,01 × asientos repartidos (que añade L1 por cuenta). */
export function baseToleranceFor(propertyId: string | null | undefined): MoneyString {
  return propertyId ? "0.00" : LEDGER_RECONCILIATION_TOLERANCES.consolidated;
}

function csvAmount(value: MoneyString): string {
  return money(value).toFixed(2).replace(".", ",");
}

function csvCell(value: string): string {
  return /[";\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export const RECONCILIATION_CSV_HEADER = ["cuenta", "nombre", "cuentas_sage", "debe_sage", "haber_sage", "debe_anfitorio", "haber_anfitorio", "dif_debe", "dif_haber", "saldo_sage", "saldo_anfitorio", "dif_saldo", "tolerancia", "estado", "clasificacion", "nota"] as const;

/** CSV de la reconciliación: BOM UTF-8, «;», decimales con coma, una fila por cuenta destino y una de totales. */
export function buildReconciliationCsv(rows: readonly ReconciliationCsvRow[]): string {
  const lines: string[] = [RECONCILIATION_CSV_HEADER.join(";")];
  let sourceDebit: Decimal = ZERO;
  let sourceCredit: Decimal = ZERO;
  let ledgerDebit: Decimal = ZERO;
  let ledgerCredit: Decimal = ZERO;
  for (const row of rows) {
    sourceDebit = sourceDebit.plus(row.sourceDebit);
    sourceCredit = sourceCredit.plus(row.sourceCredit);
    ledgerDebit = ledgerDebit.plus(row.ledgerDebit);
    ledgerCredit = ledgerCredit.plus(row.ledgerCredit);
    lines.push(
      [
        row.accountCode,
        row.accountName ?? "",
        row.sourceAccounts.join(" "),
        csvAmount(row.sourceDebit),
        csvAmount(row.sourceCredit),
        csvAmount(row.ledgerDebit),
        csvAmount(row.ledgerCredit),
        csvAmount(row.diffDebit),
        csvAmount(row.diffCredit),
        csvAmount(row.sourceBalance),
        csvAmount(row.ledgerBalance),
        csvAmount(row.diffBalance),
        csvAmount(row.tolerance),
        row.ok ? "cuadra" : "diferencia",
        row.classification ?? "",
        row.note ?? ""
      ]
        .map(csvCell)
        .join(";")
    );
  }
  lines.push(["TOTAL", "", "", csvAmount(sourceDebit.toFixed(2)), csvAmount(sourceCredit.toFixed(2)), csvAmount(ledgerDebit.toFixed(2)), csvAmount(ledgerCredit.toFixed(2)), csvAmount(ledgerDebit.minus(sourceDebit).toFixed(2)), csvAmount(ledgerCredit.minus(sourceCredit).toFixed(2)), "", "", "", "", "", "", ""].join(";"));
  return `\uFEFF${lines.join("\r\n")}\r\n`;
}

export function reconciliationCsvFileName(dto: Pick<LedgerReconciliationDto, "periodFrom" | "periodTo" | "propertyCode">): string {
  return `reconciliacion-sage200-${dto.periodFrom}-${dto.periodTo}${dto.propertyCode !== LEDGER_IMPORT_SOCIETY_PROPERTY_CODE ? `-${dto.propertyCode.toLowerCase()}` : ""}.csv`;
}

// ---------------------------------------------------------------------------
// Lado Anfitorio
// ---------------------------------------------------------------------------

function isBalanceGroup(accountCode: string): boolean {
  const group = accountGroup(accountCode);
  return group >= 1 && group <= 5;
}

/** sourceType de los asientos que mueven cada cuenta en el rango (misma regla de lectura que `movements`). */
async function sourceTypesByAccount(organizationId: string, propertyId: string | null, from: string, to: string): Promise<Map<string, string[]>> {
  const conditions: Prisma.Sql[] = [
    Prisma.sql`je.organization_id = ${organizationId}`,
    Prisma.sql`je.status <> 'draft'`,
    Prisma.sql`je.reversed_by_id IS NULL`,
    Prisma.sql`je.reversal_of_id IS NULL`,
    Prisma.sql`je.entry_date >= ${dateOnlyUtc(from)}::date`,
    Prisma.sql`je.entry_date <= ${dateOnlyUtc(to)}::date`,
    Prisma.sql`je.entry_kind <> ALL(${RECONCILIATION_EXCLUDED_KINDS as string[]}::text[])`
  ];
  if (propertyId) conditions.push(Prisma.sql`je.property_id = ${propertyId}`);
  const rows = await prisma.$queryRaw<Array<{ code: string; source_type: string }>>`
    SELECT a.code, je.source_type
    FROM journal_lines jl
    JOIN journal_entries je ON je.id = jl.journal_entry_id
    JOIN accounts a ON a.id = jl.account_id
    WHERE ${Prisma.join(conditions, " AND ")}
    GROUP BY a.code, je.source_type
    ORDER BY a.code`;
  const out = new Map<string, string[]>();
  for (const row of rows) out.set(row.code, [...(out.get(row.code) ?? []), row.source_type]);
  return out;
}

export type LedgerAggregateRow = { accountCode: string; accountName?: string | null; debit: Decimal; credit: Decimal };

/**
 * Puro: fusiona las tres lecturas del diario en las filas de `buildReconciliationRows`. Movimientos del
 * rango por cuenta; saldo a `to` en grupos 1-5 (`balance_at`); neto acumulado del ejercicio en 6/7. Una
 * cuenta SIN movimiento en el rango pero con saldo (1-5) o con neto acumulado del ejercicio (6/7) entra
 * igualmente con Debe / Haber 0,00: el balance de Sage «hasta el periodo» la trae con su saldo, y sin la
 * fila la reconciliación de un mes suelto la clasificaba como «falta en Anfitorio» (integración L6: la
 * prima de seguros trimestral de enero en la reconciliación de febrero).
 */
export function mergeLedgerRows(input: { movements: readonly LedgerAggregateRow[]; balanceAt: readonly LedgerAggregateRow[]; yearToDate: readonly LedgerAggregateRow[]; sourceTypes: ReadonlyMap<string, string[]> }): ReconciliationLedgerRow[] {
  const byAccount = new Map<string, ReconciliationLedgerRow>();
  for (const row of input.movements) byAccount.set(row.accountCode, { accountCode: row.accountCode, accountName: row.accountName, debit: row.debit, credit: row.credit, balance: null, sourceTypes: input.sourceTypes.get(row.accountCode) ?? [] });
  for (const row of input.balanceAt) {
    if (!isBalanceGroup(row.accountCode)) continue;
    const balance = row.debit.minus(row.credit);
    const existing = byAccount.get(row.accountCode);
    if (existing) existing.balance = balance;
    else if (!balance.isZero()) byAccount.set(row.accountCode, { accountCode: row.accountCode, accountName: row.accountName, debit: ZERO, credit: ZERO, balance, sourceTypes: [] });
  }
  for (const row of input.yearToDate) {
    if (isBalanceGroup(row.accountCode)) continue;
    const balance = row.debit.minus(row.credit);
    const existing = byAccount.get(row.accountCode);
    if (existing) existing.balance = balance;
    else if (!balance.isZero()) byAccount.set(row.accountCode, { accountCode: row.accountCode, accountName: row.accountName, debit: ZERO, credit: ZERO, balance, sourceTypes: [] });
  }
  return [...byAccount.values()].sort((a, b) => a.accountCode.localeCompare(b.accountCode));
}

/** Filas del diario por cuenta para `buildReconciliationRows`: movimientos del rango, saldo a `to` (1-5) o neto del ejercicio (6/7), sourceType. */
export async function ledgerRowsForRange(input: { organizationId: string; propertyId: string | null; from: string; to: string }): Promise<ReconciliationLedgerRow[]> {
  const { organizationId, propertyId, from, to } = input;
  const yearStart = `${to.slice(0, 4)}-01-01`;
  const [movements, balanceAt, yearToDate, sourceTypes] = await Promise.all([
    aggregateAccountBalances({ organizationId, propertyId, from, to, excludeKinds: RECONCILIATION_EXCLUDED_KINDS }),
    aggregateAccountBalances({ organizationId, propertyId, to, closingCutoff: to, regularizationCutoff: to }),
    aggregateAccountBalances({ organizationId, propertyId, from: yearStart, to, excludeKinds: RECONCILIATION_EXCLUDED_KINDS }),
    sourceTypesByAccount(organizationId, propertyId, from, to)
  ]);
  return mergeLedgerRows({ movements, balanceAt, yearToDate, sourceTypes });
}

async function splitEntriesByAccount(db: Db, organizationId: string, propertyId: string, from: string, to: string): Promise<Map<string, number>> {
  const entries = await db.ledgerImportEntry.findMany({
    where: { organizationId, status: "posted", propertyId, journalEntryId: { not: null }, entryDate: { gte: dateOnlyUtc(from), lte: dateOnlyUtc(to) }, propertyCode: { not: LEDGER_IMPORT_SOCIETY_PROPERTY_CODE } },
    select: { journalEntryId: true, sourceId: true, propertyCode: true }
  });
  const typed = entries.filter((entry): entry is { journalEntryId: string; sourceId: string | null; propertyCode: string } => !!entry.journalEntryId);
  if (typed.length === 0) return new Map();
  const lines = await db.journalLine.findMany({ where: { journalEntryId: { in: typed.map((entry) => entry.journalEntryId) } }, select: { journalEntryId: true, accountCode: true } });
  return splitEntriesByAccountOf(typed, lines);
}

async function missingEntriesOf(db: Db, organizationId: string, importId: string | undefined): Promise<LedgerReconciliationMissingEntry[]> {
  if (!importId) return [];
  const row = await db.ledgerImport.findUnique({ where: { id: importId }, select: { organizationId: true } });
  if (!row || row.organizationId !== organizationId) throw ledgerNotFound("LEDGER_IMPORT_NOT_FOUND", "Lote de importación no encontrado.");
  const entries = await db.ledgerImportEntry.findMany({ where: { importId, status: { in: [...MISSING_ENTRY_STATUSES] } }, select: { sourceEntryNumber: true, sourcePeriod: true, status: true }, orderBy: [{ entryDate: "asc" }, { sourceEntryNumber: "asc" }] });
  return entries.map((entry) => ({ sourceEntryNumber: entry.sourceEntryNumber, sourcePeriod: entry.sourcePeriod, status: entry.status as LedgerImportEntryStatus }));
}

// ---------------------------------------------------------------------------
// DTO
// ---------------------------------------------------------------------------

function toDto(row: ReconciliationRow, properties: readonly { id: string; code: string | null }[]): LedgerReconciliationDto {
  const summaryJson = (row.summaryJson ?? {}) as Record<string, unknown>;
  const missing = Array.isArray(summaryJson.missingEntries) ? (summaryJson.missingEntries as LedgerReconciliationMissingEntry[]) : [];
  const summary: LedgerReconciliationSummary = {
    nativeOnly: Number(summaryJson.nativeOnly ?? 0),
    missingInLedger: Number(summaryJson.missingInLedger ?? 0),
    amountDiff: Number(summaryJson.amountDiff ?? 0),
    vatDiff: Number(summaryJson.vatDiff ?? 0),
    tolerance: typeof summaryJson.tolerance === "string" ? summaryJson.tolerance : LEDGER_RECONCILIATION_TOLERANCES.consolidated,
    criterion: typeof summaryJson.criterion === "string" ? summaryJson.criterion : RECONCILIATION_CRITERION_ES
  };
  return {
    id: row.id,
    importId: row.importId,
    periodFrom: isoDay(row.periodFrom),
    periodTo: isoDay(row.periodTo),
    propertyId: row.propertyId,
    propertyCode: row.propertyId ? properties.find((property) => property.id === row.propertyId)?.code?.trim() || row.propertyId : LEDGER_IMPORT_SOCIETY_PROPERTY_CODE,
    status: row.status as LedgerReconciliationStatus,
    accountsCompared: row.accountsCompared,
    differenceCount: row.differenceCount,
    rows: Array.isArray(row.rowsJson) ? (row.rowsJson as unknown as LedgerReconciliationRow[]) : [],
    summary,
    missingEntries: missing,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString()
  };
}

async function loadReconciliationOrThrow(organizationId: string, reconciliationId: string): Promise<ReconciliationRow> {
  const row = await prisma.ledgerReconciliation.findUnique({ where: { id: reconciliationId } });
  if (!row || row.organizationId !== organizationId) throw ledgerNotFound("LEDGER_RECONCILIATION_NOT_FOUND", RECONCILIATION_NOT_FOUND);
  return row;
}

// ---------------------------------------------------------------------------
// Ejecución
// ---------------------------------------------------------------------------

export async function reconcileLedger(input: { context: UserContext; body: LedgerReconciliationBody; createdBy?: string | null; correlationId?: string; actorType?: "user" | "system" }): Promise<LedgerReconciliationDto> {
  requirePermissions(input.context, ["accounting.journal.post"]);
  const organizationId = input.context.organizationId;
  const { body } = input;
  if (!isIsoDate(body.from) || !isIsoDate(body.to) || body.from > body.to) throw ledgerBadRequest("VALIDATION_ERROR", "Indica un rango de fechas válido (from ≤ to, formato YYYY-MM-DD).", { field: "from" });
  const propertyId = body.propertyId?.trim() || null;
  const scope = await resolveLedgerScope(input.context, { propertyId });
  assertFinanceReadScopeMany(input.context, propertyId ? [propertyId] : []);
  const createdBy = input.createdBy === undefined ? input.context.userId : input.createdBy;

  const decoded = decodeImportContent(body);
  let parsed;
  try {
    parsed = parseLedgerImportFile({ kind: "balances", format: body.format, fileName: undefined, bytes: decoded.bytes, content: decoded.content, sheetName: body.sheetName, fiscalYearCode: body.to.slice(0, 4), periodCode: periodCodeForRange(body.from, body.to) });
  } catch (error) {
    toHttpError(error);
  }
  if (parsed.rows.length === 0) throw ledgerBadRequest("LEDGER_IMPORT_EMPTY", "El balance de Sage no contiene filas.");
  const normalized = normalizeRows("balances", parsed.rows);
  const sourceHash = contentHashOf("balances", normalized);
  const { rows: sageRows, filtered } = balanceRowsInRange(normalized, body.from, body.to);
  const warnings = [...parsed.warnings];
  if (filtered) warnings.push(`El balance trae periodos fuera del rango ${body.from} – ${body.to}: solo se comparan los del rango.`);

  const [properties, chart, persisted] = await Promise.all([loadProperties(prisma, organizationId), loadChartLookup(prisma, organizationId), loadPersistedAccountMap(prisma, organizationId)]);
  const accountMap = resolveEffectiveAccountMap(sageRows.map((row) => ({ account: row.cuenta, name: row.titulo })), persisted, chart.lookup);
  const accountNames = new Map(chart.rows.map((row) => [row.code, row.name]));
  const ledgerRows = await ledgerRowsForRange({ organizationId, propertyId, from: body.from, to: body.to });
  const splitEntries = propertyId ? await splitEntriesByAccount(prisma, organizationId, propertyId, body.from, body.to) : undefined;
  const missingEntries = await missingEntriesOf(prisma, organizationId, body.importId);
  const result = buildReconciliationRows(sageRows, ledgerRows, { accountMap, tolerance: baseToleranceFor(propertyId), splitEntriesByAccount: splitEntries, accountNames });
  // Los apuntes excluidos por ser documentos propios (skipped_native) se listan pero no son diferencia:
  // Sage y Anfitorio tienen ambos la factura (el asiento nativo cuadra con el balance de Sage).
  const blockingMissing = missingEntries.filter((entry) => entry.status !== "skipped_native");
  const summary: LedgerReconciliationSummary & { missingEntries: LedgerReconciliationMissingEntry[]; warnings: string[]; sourceRows: number } = {
    nativeOnly: result.summary.nativeOnly,
    missingInLedger: result.summary.missingInLedger + blockingMissing.length,
    amountDiff: result.summary.amountDiff,
    vatDiff: 0,
    tolerance: result.summary.tolerance,
    criterion: RECONCILIATION_CRITERION_ES,
    missingEntries,
    warnings,
    sourceRows: sageRows.length
  };
  const status: LedgerReconciliationStatus = result.differenceCount === 0 && blockingMissing.length === 0 ? "ok" : "differences";
  const row = await prisma.ledgerReconciliation.create({
    data: {
      organizationId,
      importId: body.importId ?? null,
      periodFrom: dateOnlyUtc(body.from),
      periodTo: dateOnlyUtc(body.to),
      propertyId,
      sourceHash,
      status,
      accountsCompared: result.accountsCompared,
      differenceCount: result.differenceCount + blockingMissing.length,
      rowsJson: result.rows as unknown as Prisma.InputJsonValue,
      summaryJson: summary as unknown as Prisma.InputJsonValue,
      createdBy
    }
  });
  recordAuditEvent({
    organizationId,
    actorUserId: input.context.userId,
    actorType: input.actorType ?? "user",
    action: "LEDGER_RECONCILIATION_RUN",
    entityType: "ledger_reconciliation",
    entityId: row.id,
    afterJson: { reconciliationId: row.id, importId: body.importId ?? null, legalEntityId: scope.legalEntityId, periodFrom: body.from, periodTo: body.to, propertyId, propertyCode: propertyCodeOf(properties, propertyId), sourceHash, status, accountsCompared: result.accountsCompared, differenceCount: row.differenceCount, nativeOnly: summary.nativeOnly, missingInLedger: summary.missingInLedger, amountDiff: summary.amountDiff },
    correlationId: input.correlationId
  });
  return toDto(row, properties);
}

export async function listReconciliations(input: { context: UserContext; query?: LedgerReconciliationListQuery }): Promise<LedgerReconciliationDto[]> {
  requirePermissions(input.context, ["accounting.read"]);
  const organizationId = input.context.organizationId;
  const query = input.query ?? {};
  const limit = Math.min(Math.max(Math.trunc(query.limit ?? LEDGER_IMPORT_LIST_DEFAULT_LIMIT), 1), LEDGER_IMPORT_LIST_MAX_LIMIT);
  const propertyId = query.propertyId?.trim() || null;
  if (propertyId) assertFinanceReadScopeMany(input.context, [propertyId]);
  const rows = await prisma.ledgerReconciliation.findMany({
    where: {
      organizationId,
      ...(propertyId ? { propertyId } : {}),
      ...(query.to && isIsoDate(query.to) ? { periodFrom: { lte: dateOnlyUtc(query.to) } } : {}),
      ...(query.from && isIsoDate(query.from) ? { periodTo: { gte: dateOnlyUtc(query.from) } } : {})
    },
    orderBy: { createdAt: "desc" },
    take: limit
  });
  const properties = await loadProperties(prisma, organizationId);
  // R11: la reconciliación consolidada (sin centro) lleva los saldos de toda la sociedad: exige accounting.entity.read, como el detalle.
  const entityScope = hasEntityReadScope(input.context);
  return rows.filter((row) => (row.propertyId ? assertScopeSilently(input.context, row.propertyId) : entityScope)).map((row) => toDto(row, properties));
}

function assertScopeSilently(context: UserContext, propertyId: string): boolean {
  try {
    assertFinanceReadScopeMany(context, [propertyId]);
    return true;
  } catch {
    return false;
  }
}

export async function getReconciliation(input: { context: UserContext; reconciliationId: string }): Promise<LedgerReconciliationDto> {
  requirePermissions(input.context, ["accounting.read"]);
  const row = await loadReconciliationOrThrow(input.context.organizationId, input.reconciliationId);
  assertFinanceReadScopeMany(input.context, row.propertyId ? [row.propertyId] : []);
  return toDto(row, await loadProperties(prisma, input.context.organizationId));
}

export async function reconciliationCsv(input: { context: UserContext; reconciliationId: string }): Promise<{ fileName: string; content: string; contentType: string }> {
  const dto = await getReconciliation(input);
  return { fileName: reconciliationCsvFileName(dto), content: buildReconciliationCsv(dto.rows), contentType: "text/csv; charset=utf-8" };
}
