// Payables · ledger port (Finanzas 2026-09-15, lote proveedores-activos).
//
// Every journal entry of the payables and fixed-assets modules goes through
// this port. The default implementation below is the MINIMAL posting engine
// of the data contract (docs/runbooks/finanzas-contabilidad.md §1.3):
//   · lines with positive amounts in debit XOR credit, balanced to the cent,
//     `accountCode` resolved against the organisation's chart (postable only);
//   · `entryDate` (accrual date), `fiscalYearCode` (FiscalYear.code covering
//     the date, else the calendar year) and `entryNumber` = MAX+1 under
//     the canonical engine's advisory lock (journalNumberingLockKey of
//     accounting.service.ts: pg_advisory_xact_lock(hashtext(org || fiscalYearCode)));
//   · idempotent by (organizationId, sourceType, sourceId): a second call for
//     the same document returns the existing entry (`alreadyExisted: true`);
//   · closed fiscal periods / years and an organisation without a provisioned
//     chart fail LOUDLY with a typed 409 (never in silence);
//   · reversals create an inverse entry linked through `reversalOfId` /
//     `reversedById` (the original becomes `reversed`; nothing is deleted).
//
// The lote «asientos» owns the canonical engine
// (apps/api/src/modules/accounting/accounting.service.ts postJournalEntry /
// reverseJournalEntry). It did not exist in the working tree when this lote
// compiled, so the integrator swaps the implementation with ONE call:
//   setLedgerPort({ post: …, reverse: … })
// keeping the signatures below (handoff in the lote report).

import { Prisma } from "@prisma/client";
import { HttpError } from "../../lib/http-error.js";
import { journalNumberingLockKey } from "../accounting/accounting.service.js";
import { isPostingAllowed } from "../accounting/fiscal-period.service.js";
import { dec, money, round2, sum, ZERO, type Decimal } from "./money.js";

export type Tx = Prisma.TransactionClient;

export type LedgerLineInput = {
  accountCode: string;
  debit?: Decimal | string | number;
  credit?: Decimal | string | number;
  description?: string;
  costCenterId?: string | null;
  /** "21" | "10" | "4" | "7" | "3" | "2" | "0" on VAT quota lines (and the base line that accompanies them). */
  taxRateCode?: string | null;
  /** Taxable base behind a 472/477 quota line (so the 303 never rebuilds the base from the quota). */
  taxBase?: Decimal | string | number | null;
};

export type LedgerEntryInput = {
  organizationId: string;
  propertyId?: string | null;
  /** Accrual date (invoice date, payment date, period end…). */
  entryDate: Date;
  /** Contract values: supplier_bill · supplier_bill_payment · expense · depreciation · reversal … */
  sourceType: string;
  sourceId: string;
  description: string;
  reference?: string | null;
  createdBy?: string | null;
  entryKind?: "normal" | "reversal";
  reversalOfId?: string | null;
  lines: LedgerLineInput[];
};

export type LedgerLineResult = {
  id: string;
  accountId: string;
  accountCode: string;
  debit: string;
  credit: string;
  description: string | null;
  taxRateCode: string | null;
  taxBase: string | null;
  costCenterId: string | null;
};

export type LedgerEntryResult = {
  id: string;
  entryNumber: number | null;
  fiscalYearCode: string | null;
  entryDate: string;
  sourceType: string;
  sourceId: string | null;
  description: string | null;
  reference: string | null;
  status: string;
  reversalOfId: string | null;
  reversedById: string | null;
  totalDebit: string;
  totalCredit: string;
  lines: LedgerLineResult[];
  /** True when an entry for (organizationId, sourceType, sourceId) already existed and was returned as-is. */
  alreadyExisted: boolean;
};

export type LedgerReverseInput = {
  organizationId: string;
  journalEntryId: string;
  entryDate: Date;
  sourceType: string;
  sourceId: string;
  description: string;
  createdBy?: string | null;
};

export type LedgerPort = {
  post(tx: Tx, input: LedgerEntryInput): Promise<LedgerEntryResult>;
  reverse(tx: Tx, input: LedgerReverseInput): Promise<LedgerEntryResult>;
};

export type LedgerErrorCode =
  | "UNBALANCED_ENTRY"
  | "INVALID_LEDGER_LINE"
  | "CHART_NOT_PROVISIONED"
  | "ACCOUNT_NOT_IN_CHART"
  | "ACCOUNT_NOT_POSTABLE"
  | "FISCAL_PERIOD_CLOSED"
  | "FISCAL_YEAR_CLOSED"
  | "ENTRY_ALREADY_REVERSED"
  | "ENTRY_NOT_FOUND";

function ledgerError(statusCode: number, code: LedgerErrorCode, message: string, extra: Record<string, unknown> = {}): HttpError {
  return new HttpError(statusCode, message, true, { code, ...extra });
}

// ---------------------------------------------------------------------------
// Pure validation (unit-tested without a database)
// ---------------------------------------------------------------------------

export type NormalizedLine = {
  accountCode: string;
  debit: Decimal;
  credit: Decimal;
  description: string | null;
  costCenterId: string | null;
  taxRateCode: string | null;
  taxBase: Decimal | null;
};

/**
 * Normalises and checks the lines of an entry: at least two lines, every
 * amount positive with 2 decimals in debit XOR credit, Σ debit = Σ credit to
 * the cent. Throws 400 UNBALANCED_ENTRY / INVALID_LEDGER_LINE.
 */
export function normalizeLedgerLines(lines: LedgerLineInput[]): { lines: NormalizedLine[]; totalDebit: Decimal; totalCredit: Decimal } {
  if (!Array.isArray(lines) || lines.length < 2) {
    throw ledgerError(400, "INVALID_LEDGER_LINE", "Un asiento necesita al menos dos líneas.");
  }
  const normalized: NormalizedLine[] = lines.map((line, index) => {
    const debit = round2(line.debit ?? ZERO);
    const credit = round2(line.credit ?? ZERO);
    if (debit.isNegative() || credit.isNegative()) {
      throw ledgerError(400, "INVALID_LEDGER_LINE", `Línea ${index + 1} (${line.accountCode}): los importes deben ser positivos; el sentido lo marca debe/haber.`);
    }
    if (debit.isZero() === credit.isZero()) {
      throw ledgerError(400, "INVALID_LEDGER_LINE", `Línea ${index + 1} (${line.accountCode}): exactamente uno de debe/haber debe ser mayor que cero.`);
    }
    if (!dec(line.debit ?? ZERO).equals(debit) || !dec(line.credit ?? ZERO).equals(credit)) {
      throw ledgerError(400, "INVALID_LEDGER_LINE", `Línea ${index + 1} (${line.accountCode}): los importes deben estar redondeados al céntimo.`);
    }
    if (typeof line.accountCode !== "string" || line.accountCode.trim().length === 0) {
      throw ledgerError(400, "INVALID_LEDGER_LINE", `Línea ${index + 1}: falta el código de cuenta.`);
    }
    return {
      accountCode: line.accountCode.trim(),
      debit,
      credit,
      description: line.description ?? null,
      costCenterId: line.costCenterId ?? null,
      taxRateCode: line.taxRateCode ?? null,
      taxBase: line.taxBase === undefined || line.taxBase === null ? null : round2(line.taxBase)
    };
  });
  const totalDebit = sum(normalized.map((l) => l.debit));
  const totalCredit = sum(normalized.map((l) => l.credit));
  if (!totalDebit.equals(totalCredit)) {
    throw ledgerError(400, "UNBALANCED_ENTRY", `El asiento no cuadra: debe ${money(totalDebit)} ≠ haber ${money(totalCredit)}.`, {
      totalDebit: money(totalDebit),
      totalCredit: money(totalCredit)
    });
  }
  return { lines: normalized, totalDebit, totalCredit };
}

/** Fiscal-year code used for numbering when no FiscalYear row covers the date: the calendar year of the accrual date. */
export function calendarYearCode(entryDate: Date): string {
  return String(entryDate.getUTCFullYear());
}

// ---------------------------------------------------------------------------
// Default Prisma implementation
// ---------------------------------------------------------------------------

async function loadEntry(tx: Tx, journalEntryId: string, alreadyExisted: boolean): Promise<LedgerEntryResult> {
  const entry = await tx.journalEntry.findUnique({ where: { id: journalEntryId } });
  if (!entry) throw ledgerError(404, "ENTRY_NOT_FOUND", "Asiento no encontrado.");
  const rows = await tx.journalLine.findMany({ where: { journalEntryId }, orderBy: { id: "asc" } });
  const accountIds = Array.from(new Set(rows.map((r) => r.accountId)));
  const accounts = accountIds.length ? await tx.account.findMany({ where: { id: { in: accountIds } }, select: { id: true, code: true } }) : [];
  const codeById = new Map(accounts.map((a) => [a.id, a.code]));
  const lines: LedgerLineResult[] = rows.map((r) => ({
    id: r.id,
    accountId: r.accountId,
    accountCode: r.accountCode ?? codeById.get(r.accountId) ?? r.accountId,
    debit: money(r.debit),
    credit: money(r.credit),
    description: r.description ?? null,
    taxRateCode: r.taxRateCode ?? null,
    taxBase: r.taxBase === null || r.taxBase === undefined ? null : money(r.taxBase),
    costCenterId: r.costCenterId ?? null
  }));
  return {
    id: entry.id,
    entryNumber: entry.entryNumber ?? null,
    fiscalYearCode: entry.fiscalYearCode ?? null,
    entryDate: entry.entryDate.toISOString().slice(0, 10),
    sourceType: entry.sourceType,
    sourceId: entry.sourceId ?? null,
    description: entry.description ?? null,
    reference: entry.reference ?? null,
    status: entry.status,
    reversalOfId: entry.reversalOfId ?? null,
    reversedById: entry.reversedById ?? null,
    totalDebit: money(sum(rows.map((r) => r.debit))),
    totalCredit: money(sum(rows.map((r) => r.credit))),
    lines,
    alreadyExisted
  };
}

async function resolveFiscalYearCode(tx: Tx, organizationId: string, propertyId: string | null, entryDate: Date): Promise<string> {
  const year = await tx.fiscalYear.findFirst({
    where: {
      organizationId,
      OR: [{ propertyId: null }, ...(propertyId ? [{ propertyId }] : [])],
      startDate: { lte: entryDate },
      endDate: { gte: entryDate }
    },
    orderBy: { propertyId: "desc" },
    select: { code: true, status: true }
  });
  if (!year) return calendarYearCode(entryDate);
  if (year.status === "closed") {
    throw ledgerError(409, "FISCAL_YEAR_CLOSED", `El ejercicio ${year.code} está cerrado: no admite asientos con fecha ${entryDate.toISOString().slice(0, 10)}.`, { fiscalYearCode: year.code });
  }
  return year.code;
}

export async function postLedgerEntryWithPrisma(tx: Tx, input: LedgerEntryInput): Promise<LedgerEntryResult> {
  const { lines } = normalizeLedgerLines(input.lines);
  const propertyId = input.propertyId ?? null;

  const existing = await tx.journalEntry.findFirst({
    where: { organizationId: input.organizationId, sourceType: input.sourceType, sourceId: input.sourceId },
    select: { id: true }
  });
  if (existing) return loadEntry(tx, existing.id, true);

  const setting = await tx.accountingSetting.findFirst({
    where: { organizationId: input.organizationId, propertyId: null, chartTemplate: { not: null } },
    select: { id: true }
  });
  if (!setting) {
    throw ledgerError(409, "CHART_NOT_PROVISIONED", "La organización no tiene plan de cuentas provisionado (ejecuta accounting-provision-chart).");
  }

  const codes = Array.from(new Set(lines.map((l) => l.accountCode)));
  const accounts = await tx.account.findMany({
    where: { organizationId: input.organizationId, code: { in: codes } },
    select: { id: true, code: true, isPostable: true }
  });
  const byCode = new Map(accounts.map((a) => [a.code, a]));
  const missing = codes.filter((c) => !byCode.has(c));
  if (missing.length > 0) {
    throw ledgerError(409, "ACCOUNT_NOT_IN_CHART", `Cuentas inexistentes en el plan de la organización: ${missing.join(", ")}.`, { codes: missing });
  }
  const headers = codes.filter((c) => byCode.get(c)!.isPostable === false);
  if (headers.length > 0) {
    throw ledgerError(400, "ACCOUNT_NOT_POSTABLE", `Las cuentas ${headers.join(", ")} son cabeceras (grupo/subgrupo) y no admiten apuntes.`, { codes: headers });
  }

  const period = await isPostingAllowed(input.organizationId, propertyId ?? undefined, input.entryDate);
  if (!period.allowed) {
    throw ledgerError(409, "FISCAL_PERIOD_CLOSED", `El periodo ${period.closedPeriodCode ?? ""} está cerrado: no admite asientos.`, { periodCode: period.closedPeriodCode ?? null });
  }
  const fiscalYearCode = await resolveFiscalYearCode(tx, input.organizationId, propertyId, input.entryDate);

  // MAX+1 numbering is safe under concurrency only behind the advisory lock,
  // released at COMMIT/ROLLBACK of the caller's transaction. Integration
  // 2026-09-16: the key is the canonical engine's (accounting.service), so
  // both writers serialise on the same (organisation, fiscal year) lock.
  const lockKey = journalNumberingLockKey(input.organizationId, fiscalYearCode);
  await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`);
  const rows = await tx.$queryRaw<Array<{ max: unknown }>>(
    Prisma.sql`SELECT COALESCE(MAX(entry_number), 0) AS max FROM journal_entries WHERE organization_id = ${input.organizationId} AND fiscal_year_code = ${fiscalYearCode}`
  );
  const entryNumber = Number(rows[0]?.max ?? 0) + 1;

  const entry = await tx.journalEntry.create({
    data: {
      organizationId: input.organizationId,
      propertyId,
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      status: "posted",
      postedAt: new Date(),
      createdBy: input.createdBy ?? null,
      entryKind: input.entryKind ?? "normal",
      entryDate: input.entryDate,
      entryNumber,
      fiscalYearCode,
      description: input.description,
      reference: input.reference ?? null,
      reversalOfId: input.reversalOfId ?? null
    },
    select: { id: true }
  });
  await tx.journalLine.createMany({
    data: lines.map((line) => ({
      journalEntryId: entry.id,
      accountId: byCode.get(line.accountCode)!.id,
      accountCode: line.accountCode,
      debit: line.debit,
      credit: line.credit,
      currency: "EUR",
      description: line.description,
      costCenterId: line.costCenterId,
      taxRateCode: line.taxRateCode,
      taxBase: line.taxBase
    }))
  });
  return loadEntry(tx, entry.id, false);
}

export async function reverseLedgerEntryWithPrisma(tx: Tx, input: LedgerReverseInput): Promise<LedgerEntryResult> {
  const original = await tx.journalEntry.findFirst({ where: { id: input.journalEntryId, organizationId: input.organizationId } });
  if (!original) throw ledgerError(404, "ENTRY_NOT_FOUND", "Asiento no encontrado.");
  if (original.reversedById) {
    throw ledgerError(409, "ENTRY_ALREADY_REVERSED", "El asiento ya está anulado.", { reversedById: original.reversedById });
  }
  const lines = await tx.journalLine.findMany({ where: { journalEntryId: original.id }, orderBy: { id: "asc" } });
  const accountIds = Array.from(new Set(lines.map((l) => l.accountId)));
  const accounts = await tx.account.findMany({ where: { id: { in: accountIds } }, select: { id: true, code: true } });
  const codeById = new Map(accounts.map((a) => [a.id, a.code]));
  const reversal = await postLedgerEntryWithPrisma(tx, {
    organizationId: input.organizationId,
    propertyId: original.propertyId,
    entryDate: input.entryDate,
    sourceType: input.sourceType,
    sourceId: input.sourceId,
    description: input.description,
    reference: original.reference ?? null,
    createdBy: input.createdBy ?? null,
    entryKind: "reversal",
    reversalOfId: original.id,
    lines: lines.map((l) => ({
      accountCode: l.accountCode ?? codeById.get(l.accountId) ?? l.accountId,
      debit: l.credit,
      credit: l.debit,
      description: l.description ?? undefined,
      costCenterId: l.costCenterId,
      taxRateCode: l.taxRateCode,
      taxBase: l.taxBase
    }))
  });
  if (!reversal.alreadyExisted) {
    await tx.journalEntry.update({ where: { id: original.id }, data: { reversedById: reversal.id, status: "reversed" } });
  }
  return reversal;
}

let activePort: LedgerPort = { post: postLedgerEntryWithPrisma, reverse: reverseLedgerEntryWithPrisma };

/** The engine every payables / fixed-assets posting uses. */
export function getLedgerPort(): LedgerPort {
  return activePort;
}

/** Integrator hook: replace the default engine with the lote «asientos» one (same signatures). */
export function setLedgerPort(port: Partial<LedgerPort>): void {
  activePort = { ...activePort, ...port };
}

export function resetLedgerPort(): void {
  activePort = { post: postLedgerEntryWithPrisma, reverse: reverseLedgerEntryWithPrisma };
}
