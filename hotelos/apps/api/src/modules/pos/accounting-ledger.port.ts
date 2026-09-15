// Ledger port of the POS module — Finanzas (2026-09-15, lote «pos-noche»).
//
// EVERY journal entry this module writes (POS cash/card sale, cash-closure
// difference) goes through this port, and the port delegates to the ONE
// posting engine of the ledger lote: accounting.service.postJournalEntry /
// reverseJournalEntry (numbering per ejercicio under the advisory lock,
// entryDate, accountCode / taxRateCode / taxBase on every line, idempotent by
// (organizationId, sourceType, sourceId), closed-period guard, chart
// auto-provision). The indirection exists so the integration tests can spy
// on what the POS posts and so a future engine swap is one call
// (`setLedgerPort`) — the POS code never touches journal tables itself.
// Every call runs on the caller's transaction (`tx`), so the sale (or the
// closure) and its asiento commit together or not at all.
import type { Prisma } from "@hotelos/database";
import { postJournalEntry, reverseJournalEntry, type JournalLineInput } from "../accounting/accounting.service.js";

/** JournalEntry.sourceType values of the data contract (§1.1) this module writes. */
export type PosJournalSourceType = "pos_ticket" | "cash_closure" | "reversal";

export type LedgerLineInput = JournalLineInput;

export type LedgerPostInput = {
  organizationId: string;
  propertyId?: string | null;
  /** Accounting date (devengo), calendar day `YYYY-MM-DD`. */
  entryDate: string;
  sourceType: PosJournalSourceType;
  sourceId: string;
  description: string;
  reference?: string | null;
  createdBy?: string | null;
  correlationId?: string;
  lines: LedgerLineInput[];
};

export type LedgerPostResult = {
  id: string;
  entryNumber: number | null;
  fiscalYearCode: string | null;
  /** True when an entry for (organizationId, sourceType, sourceId) already existed. */
  replayed: boolean;
  totalDebit: string;
  totalCredit: string;
};

export type LedgerReverseInput = {
  organizationId: string;
  journalEntryId: string;
  entryDate: string;
  reason: string;
  sourceId: string;
  createdBy?: string | null;
  correlationId?: string;
};

export type LedgerPort = {
  postJournalEntry(tx: Prisma.TransactionClient, input: LedgerPostInput): Promise<LedgerPostResult>;
  reverseJournalEntry(tx: Prisma.TransactionClient, input: LedgerReverseInput): Promise<LedgerPostResult>;
};

/** Adapter to accounting.service (the engine of the ledger lote). */
export const accountingLedger: LedgerPort = {
  async postJournalEntry(tx, input) {
    const posted = await postJournalEntry({
      organizationId: input.organizationId,
      propertyId: input.propertyId ?? null,
      entryDate: input.entryDate,
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      description: input.description,
      reference: input.reference ?? null,
      createdBy: input.createdBy ?? null,
      correlationId: input.correlationId,
      lines: input.lines,
      tx
    });
    return { id: posted.id, entryNumber: posted.entryNumber, fiscalYearCode: posted.fiscalYearCode, replayed: !posted.created, totalDebit: posted.totalDebit, totalCredit: posted.totalCredit };
  },
  async reverseJournalEntry(tx, input) {
    const posted = await reverseJournalEntry({
      organizationId: input.organizationId,
      journalEntryId: input.journalEntryId,
      reason: input.reason,
      entryDate: input.entryDate,
      sourceType: "reversal",
      sourceId: input.sourceId,
      createdBy: input.createdBy ?? null,
      correlationId: input.correlationId,
      tx
    });
    return { id: posted.id, entryNumber: posted.entryNumber, fiscalYearCode: posted.fiscalYearCode, replayed: !posted.created, totalDebit: posted.totalDebit, totalCredit: posted.totalCredit };
  }
};

let activeLedger: LedgerPort = accountingLedger;

/** Swap the engine (tests: a spy; null restores the accounting.service adapter). */
export function setLedgerPort(port: LedgerPort | null): void {
  activeLedger = port ?? accountingLedger;
}

export function getLedgerPort(): LedgerPort {
  return activeLedger;
}
