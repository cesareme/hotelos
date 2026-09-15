// Ledger port of the invoicing / payments lote (finanzas 2026-09-15).
//
// Every journal entry written by invoicing (issue / rectify / cancel), folio
// payments (capture / refund / mark-paid), the PSP webhook and the TPV
// simplified invoice goes through this ONE port, inside the caller's
// transaction, so the fiscal document and its asiento commit together.
//
// The default implementation (`engineLedger`) delegates to the single
// posting service of the «asientos» lote — accounting.service.ts
// postJournalEntry / reverseJournalEntry — which owns numbering
// (pg_advisory_xact_lock per organisation + fiscal year), idempotency by
// (organizationId, sourceType, sourceId), the closed-period guard, account
// resolution (auto-provisioning the PGC Pymes hotelero template) and the
// JournalEntryPosted domain event. Because the accounting projection of that
// lote materialises the same events (InvoiceIssued, PaymentCaptured,
// PaymentRefunded, InvoiceCancelled) with the SAME source keys, the entry
// posted here in-transaction makes the projection a no-op replay — never a
// duplicate. `inlineLedger` is a self-contained fallback with the same data
// contract (docs/runbooks/finanzas-contabilidad.md §1.3) kept for isolated
// tests; `setLedgerPort` swaps the active engine.

import { Prisma as PrismaRuntime } from "@prisma/client";
import type { Prisma } from "@hotelos/database";
import { ConflictError } from "../../lib/http-error.js";
import { findJournalEntryBySource, localDateInTz, postJournalEntry as enginePostJournalEntry, reverseJournalEntry as engineReverseJournalEntry } from "../accounting/accounting.service.js";

export type LedgerDb = Prisma.TransactionClient;

/** Amounts are decimal strings ("12.50") so no float ever enters the ledger. */
export type LedgerLineInput = {
  accountCode: string;
  debit: string;
  credit: string;
  description?: string;
  /** "21" | "10" | "4" | "7" | "3" | "2" | "0" on VAT quota lines (477/472) and their base lines. */
  taxRateCode?: string | null;
  /** Taxable base behind a quota line (477/472), decimal string. */
  taxBase?: string | null;
  costCenterId?: string | null;
};

export type LedgerPostInput = {
  organizationId: string;
  propertyId: string | null;
  /** Values of docs/runbooks/finanzas-contabilidad.md §1.1 (invoice, payment, payment_refund, …). */
  sourceType: string;
  sourceId: string;
  /** Accounting date (devengo). */
  entryDate: Date;
  description: string;
  reference?: string | null;
  lines: LedgerLineInput[];
  createdBy?: string | null;
  entryKind?: "normal" | "reversal";
  currencyCode?: string;
  correlationId?: string;
};

export type LedgerPostResult = { journalEntryId: string; entryNumber: number | null; fiscalYearCode: string; created: boolean };

export type LedgerReverseInput = {
  organizationId: string;
  propertyId: string | null;
  /** The entry to reverse, by id or by its source key. */
  original: { journalEntryId: string } | { sourceType: string; sourceId: string };
  /** Source key of the reversal entry itself (idempotency). */
  sourceType: string;
  sourceId: string;
  entryDate: Date;
  description: string;
  reference?: string | null;
  createdBy?: string | null;
  correlationId?: string;
};

export type LedgerReverseResult =
  | { status: "reversed"; journalEntryId: string; reversedJournalEntryId: string; created: boolean }
  /** The original was never posted (legacy document): nothing to reverse, nothing invented. */
  | { status: "no_original"; journalEntryId: null; reversedJournalEntryId: null; created: false };

export type LedgerPort = {
  postJournalEntry(input: LedgerPostInput, tx: LedgerDb): Promise<LedgerPostResult>;
  reverseJournalEntry(input: LedgerReverseInput, tx: LedgerDb): Promise<LedgerReverseResult>;
};

export const LEDGER_ERROR_CODES = Object.freeze({
  CHART_NOT_PROVISIONED: "CHART_NOT_PROVISIONED",
  ACCOUNT_MISSING: "ACCOUNT_MISSING",
  JOURNAL_NOT_BALANCED: "JOURNAL_NOT_BALANCED"
} as const);

const D = PrismaRuntime.Decimal;
type Dec = InstanceType<typeof PrismaRuntime.Decimal>;
const MADRID_TZ = "Europe/Madrid";

function dec(value: string | number | Dec): Dec {
  return value instanceof D ? value : new D(value);
}

/** Σ debit − Σ credit must be 0.00 (to the cent). Pure. */
export function assertLedgerBalanced(lines: ReadonlyArray<Pick<LedgerLineInput, "debit" | "credit" | "accountCode">>): void {
  let debit = new D(0);
  let credit = new D(0);
  for (const line of lines) {
    const d = dec(line.debit);
    const c = dec(line.credit);
    if (d.isNegative() || c.isNegative()) {
      throw new ConflictError(`Apunte con importe negativo en la cuenta ${line.accountCode}: los importes del diario van siempre en positivo en el debe o en el haber.`, {
        code: LEDGER_ERROR_CODES.JOURNAL_NOT_BALANCED
      });
    }
    if (!d.isZero() && !c.isZero()) {
      throw new ConflictError(`Apunte con debe y haber a la vez en la cuenta ${line.accountCode}.`, { code: LEDGER_ERROR_CODES.JOURNAL_NOT_BALANCED });
    }
    debit = debit.plus(d);
    credit = credit.plus(c);
  }
  if (!debit.toDecimalPlaces(2).equals(credit.toDecimalPlaces(2))) {
    throw new ConflictError(`El asiento no cuadra: debe ${debit.toFixed(2)} ≠ haber ${credit.toFixed(2)}.`, {
      code: LEDGER_ERROR_CODES.JOURNAL_NOT_BALANCED,
      debit: debit.toFixed(2),
      credit: credit.toFixed(2)
    });
  }
}

/** Calendar year of an accounting date in Europe/Madrid ("2026"). Pure. */
export function calendarYearCode(date: Date): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: MADRID_TZ, year: "numeric" }).format(date);
}

/** Date-only value (UTC midnight of the Madrid calendar day) for the @db.Date column. Pure. */
export function accountingDate(date: Date): Date {
  return new Date(`${localDateInTz(date, MADRID_TZ)}T00:00:00.000Z`);
}

// ── Default: the accounting.service engine of the ledger lote ─────────────────

export const engineLedger: LedgerPort = {
  async postJournalEntry(input, tx) {
    assertLedgerBalanced(input.lines);
    const posted = await enginePostJournalEntry({
      organizationId: input.organizationId,
      propertyId: input.propertyId,
      entryDate: localDateInTz(input.entryDate, MADRID_TZ),
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      description: input.description,
      reference: input.reference ?? null,
      entryKind: input.entryKind ?? "normal",
      createdBy: input.createdBy ?? null,
      currencyCode: input.currencyCode ?? "EUR",
      correlationId: input.correlationId,
      tx,
      lines: input.lines.map((line) => ({
        accountCode: line.accountCode,
        debit: line.debit,
        credit: line.credit,
        description: line.description ?? null,
        taxRateCode: line.taxRateCode ?? null,
        taxBase: line.taxBase ?? null,
        costCenterId: line.costCenterId ?? null
      }))
    });
    return { journalEntryId: posted.id, entryNumber: posted.entryNumber, fiscalYearCode: posted.fiscalYearCode ?? calendarYearCode(input.entryDate), created: posted.created };
  },

  async reverseJournalEntry(input, tx) {
    const existing = await findJournalEntryBySource(tx, input.organizationId, input.sourceType, input.sourceId);
    const original =
      "journalEntryId" in input.original
        ? await tx.journalEntry.findFirst({ where: { id: input.original.journalEntryId, organizationId: input.organizationId }, select: { id: true } })
        : await findJournalEntryBySource(tx, input.organizationId, input.original.sourceType, input.original.sourceId);
    if (existing) {
      const row = await tx.journalEntry.findUnique({ where: { id: existing.id }, select: { reversalOfId: true } });
      return { status: "reversed", journalEntryId: existing.id, reversedJournalEntryId: row?.reversalOfId ?? original?.id ?? "", created: false };
    }
    if (!original) return { status: "no_original", journalEntryId: null, reversedJournalEntryId: null, created: false };
    const reversal = await engineReverseJournalEntry({
      organizationId: input.organizationId,
      journalEntryId: original.id,
      reason: input.description,
      entryDate: localDateInTz(input.entryDate, MADRID_TZ),
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      description: input.description,
      reference: input.reference,
      createdBy: input.createdBy ?? null,
      correlationId: input.correlationId,
      tx
    });
    return { status: "reversed", journalEntryId: reversal.id, reversedJournalEntryId: reversal.reversalOfId ?? original.id, created: reversal.created };
  }
};

// ── Fallback: self-contained implementation of the same contract ─────────────

async function resolveFiscalYearCode(tx: LedgerDb, organizationId: string, entryDate: Date): Promise<{ code: string; fiscalYearId: string | null }> {
  const day = accountingDate(entryDate);
  const fiscalYear = await tx.fiscalYear.findFirst({
    where: { organizationId, propertyId: null, startDate: { lte: day }, endDate: { gte: day } },
    select: { id: true, code: true },
    orderBy: { startDate: "desc" }
  });
  if (fiscalYear) return { code: fiscalYear.code, fiscalYearId: fiscalYear.id };
  return { code: calendarYearCode(entryDate), fiscalYearId: null };
}

async function resolveAccounts(tx: LedgerDb, organizationId: string, codes: string[]): Promise<Map<string, string>> {
  const unique = Array.from(new Set(codes));
  const rows = await tx.account.findMany({ where: { organizationId, code: { in: unique } }, select: { id: true, code: true, isPostable: true } });
  const byCode = new Map(rows.map((row) => [row.code, row]));
  const missing = unique.filter((code) => !byCode.has(code));
  if (missing.length > 0) {
    const anyAccount = await tx.account.count({ where: { organizationId } });
    if (anyAccount === 0) {
      throw new ConflictError(
        "La organización no tiene plan de cuentas provisionado: ejecuta accounting-provision-chart (plantilla «PGC Pymes hotelero») antes de contabilizar.",
        { code: LEDGER_ERROR_CODES.CHART_NOT_PROVISIONED, organizationId }
      );
    }
    throw new ConflictError(`Faltan cuentas en el plan de la organización: ${missing.join(", ")}. Provisiona la plantilla «PGC Pymes hotelero» o crea las subcuentas.`, {
      code: LEDGER_ERROR_CODES.ACCOUNT_MISSING,
      organizationId,
      missing
    });
  }
  const headers = rows.filter((row) => !row.isPostable).map((row) => row.code);
  if (headers.length > 0) {
    throw new ConflictError(`Las cuentas ${headers.join(", ")} son cabeceras (grupo/subgrupo) y no admiten apuntes.`, { code: LEDGER_ERROR_CODES.ACCOUNT_MISSING, missing: headers });
  }
  return new Map(rows.map((row) => [row.code, row.id]));
}

/**
 * Inline engine (contract §1.3) with the SAME numbering lock key as
 * accounting.service (`organizationId + fiscalYearCode`), so both can never
 * hand out the same entry number. No fiscal-period guard here.
 */
export const inlineLedger: LedgerPort = {
  async postJournalEntry(input, tx) {
    if (input.lines.length < 2) throw new ConflictError("Un asiento necesita al menos dos apuntes.", { code: LEDGER_ERROR_CODES.JOURNAL_NOT_BALANCED });
    assertLedgerBalanced(input.lines);
    const existing = await tx.journalEntry.findFirst({
      where: { organizationId: input.organizationId, sourceType: input.sourceType, sourceId: input.sourceId },
      select: { id: true, entryNumber: true, fiscalYearCode: true }
    });
    if (existing) {
      return { journalEntryId: existing.id, entryNumber: existing.entryNumber, fiscalYearCode: existing.fiscalYearCode ?? calendarYearCode(input.entryDate), created: false };
    }
    const accounts = await resolveAccounts(tx, input.organizationId, input.lines.map((line) => line.accountCode));
    const { code: fiscalYearCode, fiscalYearId } = await resolveFiscalYearCode(tx, input.organizationId, input.entryDate);
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`${input.organizationId}${fiscalYearCode}`}::text))`;
    const last = await tx.journalEntry.aggregate({ where: { organizationId: input.organizationId, fiscalYearCode }, _max: { entryNumber: true } });
    const entryNumber = (last._max.entryNumber ?? 0) + 1;
    const entry = await tx.journalEntry.create({
      data: {
        organizationId: input.organizationId,
        propertyId: input.propertyId,
        sourceType: input.sourceType,
        sourceId: input.sourceId,
        status: "posted",
        postedAt: new Date(),
        createdBy: input.createdBy ?? null,
        currencyCode: input.currencyCode ?? "EUR",
        fiscalYearId,
        entryKind: input.entryKind ?? "normal",
        entryDate: accountingDate(input.entryDate),
        entryNumber,
        fiscalYearCode,
        description: input.description,
        reference: input.reference ?? null
      }
    });
    await tx.journalLine.createMany({
      data: input.lines.map((line) => ({
        journalEntryId: entry.id,
        accountId: accounts.get(line.accountCode)!,
        accountCode: line.accountCode,
        debit: dec(line.debit).toFixed(2),
        credit: dec(line.credit).toFixed(2),
        currency: input.currencyCode ?? "EUR",
        description: line.description ?? input.description,
        taxRateCode: line.taxRateCode ?? null,
        taxBase: line.taxBase != null ? dec(line.taxBase).toFixed(2) : null,
        costCenterId: line.costCenterId ?? null
      }))
    });
    return { journalEntryId: entry.id, entryNumber, fiscalYearCode, created: true };
  },

  async reverseJournalEntry(input, tx) {
    const existingReversal = await tx.journalEntry.findFirst({
      where: { organizationId: input.organizationId, sourceType: input.sourceType, sourceId: input.sourceId },
      select: { id: true, reversalOfId: true }
    });
    if (existingReversal) {
      return { status: "reversed", journalEntryId: existingReversal.id, reversedJournalEntryId: existingReversal.reversalOfId ?? "", created: false };
    }
    const original =
      "journalEntryId" in input.original
        ? await tx.journalEntry.findFirst({ where: { id: input.original.journalEntryId, organizationId: input.organizationId } })
        : await tx.journalEntry.findFirst({
            where: { organizationId: input.organizationId, sourceType: input.original.sourceType, sourceId: input.original.sourceId },
            orderBy: { postedAt: "asc" }
          });
    if (!original) return { status: "no_original", journalEntryId: null, reversedJournalEntryId: null, created: false };
    const lines = await tx.journalLine.findMany({ where: { journalEntryId: original.id }, orderBy: { id: "asc" } });
    if (lines.length === 0) return { status: "no_original", journalEntryId: null, reversedJournalEntryId: null, created: false };
    const accountRows = await tx.account.findMany({ where: { id: { in: lines.map((line) => line.accountId) } }, select: { id: true, code: true } });
    const codeById = new Map(accountRows.map((row) => [row.id, row.code]));
    const posted = await inlineLedger.postJournalEntry(
      {
        organizationId: input.organizationId,
        propertyId: input.propertyId ?? original.propertyId,
        sourceType: input.sourceType,
        sourceId: input.sourceId,
        entryDate: input.entryDate,
        description: input.description,
        reference: input.reference ?? original.reference,
        createdBy: input.createdBy ?? null,
        entryKind: "reversal",
        currencyCode: original.currencyCode,
        lines: lines.map((line) => ({
          accountCode: line.accountCode ?? codeById.get(line.accountId) ?? line.accountId,
          debit: dec(line.credit).toFixed(2),
          credit: dec(line.debit).toFixed(2),
          description: line.description ?? undefined,
          taxRateCode: line.taxRateCode,
          taxBase: line.taxBase != null ? dec(line.taxBase).toFixed(2) : null,
          costCenterId: line.costCenterId
        }))
      },
      tx
    );
    await tx.journalEntry.update({ where: { id: posted.journalEntryId }, data: { reversalOfId: original.id } });
    await tx.journalEntry.update({ where: { id: original.id }, data: { reversedById: posted.journalEntryId, status: "reversed" } });
    return { status: "reversed", journalEntryId: posted.journalEntryId, reversedJournalEntryId: original.id, created: true };
  }
};

let activeLedger: LedgerPort = engineLedger;

/** Swap the active engine (tests); `null` restores the accounting.service engine. */
export function setLedgerPort(port: LedgerPort | null): void {
  activeLedger = port ?? engineLedger;
}

export function getLedgerPort(): LedgerPort {
  return activeLedger;
}
