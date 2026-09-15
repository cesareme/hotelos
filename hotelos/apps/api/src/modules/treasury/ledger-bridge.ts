// Ledger bridge of the treasury / banking / commissions / payroll lot.
//
// Every journal entry of this lot goes through the platform's ONE writer of
// the libro diario — accounting.service.ts `postJournalEntry` /
// `reverseJournalEntry` (lote ledger): numbering per (organisation, ejercicio)
// under the shared advisory lock, accounting date, denormalised accountCode,
// balanced positive lines, closed-period guard, marked reversals. This file
// is only the adapter the lot's services talk to (`ledger()`):
//   · the lot's inputs accept Decimal | string | number and Date entry dates;
//     zero-amount lines (a slip without IRPF) are dropped before posting;
//   · idempotency is per (organizationId, sourceType, sourceId) in the engine;
//     when the entry for that key was REVERSED (unmatched bank line, undone
//     payroll payment) the same document may post again, so the adapter posts
//     under `sourceId#<n>` — the engine never sees two live entries per key;
//   · `db` may be the root client (the engine opens its own transaction) or
//     the caller's interactive transaction (document + asiento commit together).
// `setLedgerEngine` swaps the engine for tests; `ledgerBalances` is the read
// helper the treasury position / bank balances use.

import type { Prisma } from "@prisma/client";
import { prisma } from "@hotelos/database";
// Relative until the integrator exports accounting-types from packages/shared/src/index.ts (same as accounting.service.ts).
import type { JournalEntryView } from "../../../../../packages/shared/src/accounting-types.js";
import { findJournalEntryBySource, postJournalEntry as postCanonical, reverseJournalEntry as reverseCanonical } from "../accounting/accounting.service.js";
import { BadRequestError } from "../../lib/http-error.js";
import { dayUtc, dec, isoDay, money, round2, type Dec } from "./money.js";

export type Db = Prisma.TransactionClient | typeof prisma;

export type LedgerLineInput = {
  accountCode: string;
  debit?: Dec | string | number;
  credit?: Dec | string | number;
  description?: string;
  costCenterId?: string | null;
  taxRateCode?: string | null;
  taxBase?: Dec | string | number | null;
};

export type PostLedgerEntryInput = {
  organizationId: string;
  propertyId?: string | null;
  /** Accounting date (devengo): invoice date, payment date, payroll period end… */
  entryDate: Date | string;
  /** Values of docs/runbooks/finanzas-contabilidad.md §1.1. */
  sourceType: string;
  /** Idempotency key together with (organizationId, sourceType). */
  sourceId: string;
  description: string;
  reference?: string | null;
  lines: LedgerLineInput[];
  createdBy?: string | null;
  entryKind?: "normal" | "regularization" | "closing" | "opening" | "reversal";
  /** Reuse the caller's interactive transaction (atomic with its own writes). */
  db?: Db;
};

export type LedgerLineRecord = {
  accountCode: string;
  accountId: string;
  debit: string;
  credit: string;
  description: string | null;
};

export type LedgerEntryRecord = {
  id: string;
  organizationId: string;
  propertyId: string | null;
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
  lines: LedgerLineRecord[];
  /** false when the (organization, sourceType, sourceId) entry already existed (idempotent re-run). */
  created: boolean;
};

export type ReverseLedgerEntryInput = {
  organizationId: string;
  journalEntryId: string;
  entryDate: Date | string;
  description: string;
  reference?: string | null;
  createdBy?: string | null;
  db?: Db;
};

export type LedgerEngine = {
  postJournalEntry(input: PostLedgerEntryInput): Promise<LedgerEntryRecord>;
  reverseJournalEntry(input: ReverseLedgerEntryInput): Promise<LedgerEntryRecord>;
};

// ---- Adapter over the canonical engine ---------------------------------------

function isRootClient(db: Db): db is typeof prisma {
  return typeof (db as { $transaction?: unknown }).$transaction === "function";
}

function txOf(db: Db | undefined): Prisma.TransactionClient | undefined {
  if (!db || isRootClient(db)) return undefined;
  return db;
}

function toRecord(view: JournalEntryView & { created: boolean }): LedgerEntryRecord {
  return {
    id: view.id,
    organizationId: view.organizationId,
    propertyId: view.propertyId,
    entryNumber: view.entryNumber,
    fiscalYearCode: view.fiscalYearCode,
    entryDate: view.entryDate,
    sourceType: String(view.sourceType),
    sourceId: view.sourceId,
    description: view.description,
    reference: view.reference,
    status: view.status,
    reversalOfId: view.reversalOfId,
    reversedById: view.reversedById,
    lines: view.lines.map((l) => ({ accountCode: l.accountCode, accountId: l.accountId, debit: l.debit, credit: l.credit, description: l.description })),
    created: view.created
  };
}

/** Drops zero lines and rounds; the engine enforces sides, signs and balance. */
function adaptLines(lines: LedgerLineInput[]): Array<{ accountCode: string; debit: Dec | null; credit: Dec | null; description: string | null; taxRateCode: string | null; taxBase: Dec | null; costCenterId: string | null }> {
  const out = [];
  for (const line of lines ?? []) {
    const debit = round2(dec(line.debit ?? 0));
    const credit = round2(dec(line.credit ?? 0));
    if (debit.isZero() && credit.isZero()) continue;
    out.push({
      accountCode: String(line.accountCode).trim(),
      debit: debit.isZero() ? null : debit,
      credit: credit.isZero() ? null : credit,
      description: line.description ?? null,
      taxRateCode: line.taxRateCode ?? null,
      taxBase: line.taxBase === null || line.taxBase === undefined ? null : round2(dec(line.taxBase)),
      costCenterId: line.costCenterId ?? null
    });
  }
  if (out.length < 2) {
    const error = new BadRequestError("Un asiento necesita al menos dos líneas con importe.");
    error.details = { code: "JOURNAL_TOO_FEW_LINES" };
    throw error;
  }
  return out;
}

/**
 * The idempotency key the engine will see: the plain sourceId, or
 * `sourceId#<n>` when every earlier entry of the key was reversed (a document
 * may be posted again after its entry was undone). A live entry keeps its key
 * so the engine answers `created: false`.
 */
async function resolveSourceKey(client: Db, organizationId: string, sourceType: string, sourceId: string): Promise<string> {
  for (let n = 0; n < 100; n++) {
    const candidate = n === 0 ? sourceId : `${sourceId}#${n}`;
    const existing = await findJournalEntryBySource(client, organizationId, sourceType, candidate);
    if (!existing) return candidate;
    if (existing.status !== "reversed") return candidate;
  }
  return `${sourceId}#${Date.now()}`;
}

export const accountingLedgerEngine: LedgerEngine = {
  async postJournalEntry(input) {
    const tx = txOf(input.db);
    const client: Db = tx ?? prisma;
    const sourceId = await resolveSourceKey(client, input.organizationId, input.sourceType, input.sourceId);
    const posted = await postCanonical({
      organizationId: input.organizationId,
      propertyId: input.propertyId ?? null,
      entryDate: isoDay(dayUtc(input.entryDate)),
      sourceType: input.sourceType,
      sourceId,
      description: input.description,
      reference: input.reference ?? null,
      entryKind: input.entryKind ?? "normal",
      lines: adaptLines(input.lines),
      createdBy: input.createdBy ?? null,
      tx
    });
    return toRecord(posted);
  },

  async reverseJournalEntry(input) {
    const reversed = await reverseCanonical({
      organizationId: input.organizationId,
      journalEntryId: input.journalEntryId,
      reason: input.description,
      description: input.description,
      entryDate: isoDay(dayUtc(input.entryDate)),
      ...(input.reference !== undefined ? { reference: input.reference } : {}),
      createdBy: input.createdBy ?? null,
      tx: txOf(input.db)
    });
    return toRecord(reversed);
  }
};

let engine: LedgerEngine = accountingLedgerEngine;

/** Test hook: swap the engine (null restores the canonical one). */
export function setLedgerEngine(next: LedgerEngine | null): void {
  engine = next ?? accountingLedgerEngine;
}

export function ledger(): LedgerEngine {
  return engine;
}

// ---- Read helpers (balances) -------------------------------------------------

export type LedgerBalanceOptions = {
  propertyId?: string | null;
  /** Inclusive accounting-date cut (entryDate ≤ asOf). */
  asOf?: Date;
  /** Match subaccounts too ("572" → 572, 5720, 572.1…). */
  includeChildren?: boolean;
};

/**
 * Debit − credit per account code from posted entries (reversed originals and
 * their reversal entries net to zero, drafts are ignored). Missing codes → 0.
 */
export async function ledgerBalances(
  organizationId: string,
  codes: string[],
  options: LedgerBalanceOptions = {},
  db: Db = prisma
): Promise<Map<string, Dec>> {
  const result = new Map<string, Dec>(codes.map((c) => [c, dec(0)]));
  if (codes.length === 0) return result;
  const asOf = options.asOf ? dayUtc(options.asOf) : undefined;
  const entryWhere: Prisma.JournalEntryWhereInput = {
    organizationId,
    status: { in: ["posted", "reversed"] },
    ...(asOf ? { entryDate: { lte: asOf } } : {}),
    ...(options.propertyId ? { OR: [{ propertyId: options.propertyId }, { propertyId: null }] } : {})
  };
  const accountWhere: Prisma.AccountWhereInput = options.includeChildren
    ? { organizationId, OR: codes.map((code) => ({ code: { startsWith: code } })) }
    : { organizationId, code: { in: codes } };
  const accounts = await db.account.findMany({ where: accountWhere, select: { id: true, code: true } });
  if (accounts.length === 0) return result;
  // JournalLine has no relation field to JournalEntry: filter entry ids first.
  const entries = await db.journalEntry.findMany({ where: entryWhere, select: { id: true } });
  const entryIds = new Set(entries.map((e) => e.id));
  if (entryIds.size === 0) return result;
  const lines = await db.journalLine.findMany({
    where: { accountId: { in: accounts.map((a) => a.id) }, journalEntryId: { in: Array.from(entryIds) } },
    select: { accountId: true, debit: true, credit: true }
  });
  const codeById = new Map(accounts.map((a) => [a.id, a.code]));
  for (const line of lines) {
    const code = codeById.get(line.accountId);
    if (!code) continue;
    const target = options.includeChildren ? codes.find((c) => code.startsWith(c)) : code;
    if (!target) continue;
    result.set(target, (result.get(target) ?? dec(0)).plus(dec(line.debit)).minus(dec(line.credit)));
  }
  return result;
}

/** Wire helper kept for callers that print a balance. */
export function balanceString(value: Dec | undefined): string {
  return money(value ?? dec(0));
}
