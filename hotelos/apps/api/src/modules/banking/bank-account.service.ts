import { prisma } from "@hotelos/database";
import type { UserContext } from "../../lib/demo-store.js";

// ---- Shape returned for list views ----

export type BankAccountRow = {
  id: string;
  propertyId: string;
  organizationId: string;
  name: string;
  bankName: string | null;
  iban: string | null;
  bic: string | null;
  currencyCode: string;
  ledgerAccountCode: string | null;
  openingBalance: number;
  active: boolean;
  statementClosing: number | null;
  ledgerBalance: number;
  drift: number;
  latestStatementId: string | null;
  latestStatementPeriodEnd: string | null;
};

// ---- Helpers ----

function num(value: unknown): number {
  if (value == null) return 0;
  // Prisma Decimal serialises via .toString()
  return Number(typeof value === "object" && value !== null && "toString" in value ? value.toString() : value);
}

async function computeLedgerBalance(
  organizationId: string,
  ledgerAccountCode: string | null,
  asOf?: Date
): Promise<number> {
  if (!ledgerAccountCode) return 0;
  const account = await prisma.account.findUnique({
    where: { organizationId_code: { organizationId, code: ledgerAccountCode } },
    select: { id: true }
  });
  if (!account) return 0;
  // Sum debit-credit across posted journal lines on this account.
  // The JournalEntry model does not have an `entryDate` column today — we use
  // postedAt as the as-of cut. When postedAt is null (drafts), the line is
  // ignored. Drafts shouldn't enter the bank ledger anyway.
  const where: { accountId: string; journalEntry?: { postedAt: { lte: Date } } } = {
    accountId: account.id
  };
  if (asOf) where.journalEntry = { postedAt: { lte: asOf } };
  const lines = await prisma.journalLine.findMany({
    where,
    select: { debit: true, credit: true }
  });
  let balance = 0;
  for (const line of lines) {
    balance += num(line.debit) - num(line.credit);
  }
  // Round to cents to avoid Decimal/Number drift.
  return Math.round(balance * 100) / 100;
}

async function latestStatementClosing(bankAccountId: string, asOf?: Date) {
  const statement = await prisma.bankStatement.findFirst({
    where: {
      bankAccountId,
      ...(asOf ? { periodEnd: { lte: asOf } } : {})
    },
    orderBy: { periodEnd: "desc" }
  });
  if (!statement) return { closing: null as number | null, statementId: null, periodEnd: null as string | null };
  return {
    closing: num(statement.closingBalance),
    statementId: statement.id,
    periodEnd: statement.periodEnd.toISOString()
  };
}

// ---- Public API ----

export async function listBankAccounts(propertyId: string): Promise<BankAccountRow[]> {
  const accounts = await prisma.bankAccount.findMany({
    where: { propertyId },
    orderBy: [{ active: "desc" }, { name: "asc" }]
  });

  const rows: BankAccountRow[] = [];
  for (const account of accounts) {
    const ledgerBalance = await computeLedgerBalance(account.organizationId, account.ledgerAccountCode);
    const { closing, statementId, periodEnd } = await latestStatementClosing(account.id);
    const statementClosing = closing;
    const drift =
      statementClosing == null
        ? 0
        : Math.round((statementClosing - ledgerBalance) * 100) / 100;
    rows.push({
      id: account.id,
      propertyId: account.propertyId,
      organizationId: account.organizationId,
      name: account.name,
      bankName: account.bankName,
      iban: account.iban,
      bic: account.bic,
      currencyCode: account.currencyCode,
      ledgerAccountCode: account.ledgerAccountCode,
      openingBalance: num(account.openingBalance),
      active: account.active,
      statementClosing,
      ledgerBalance,
      drift,
      latestStatementId: statementId,
      latestStatementPeriodEnd: periodEnd
    });
  }
  return rows;
}

export async function createBankAccount(input: {
  context: UserContext;
  propertyId?: string;
  organizationId?: string;
  name: string;
  bankName?: string;
  iban?: string;
  bic?: string;
  currencyCode?: string;
  ledgerAccountCode?: string;
  openingBalance?: number;
}) {
  const propertyId = input.propertyId ?? input.context.propertyId;
  const organizationId = input.organizationId ?? input.context.organizationId;
  if (!input.name?.trim()) throw new Error("Bank account name is required.");

  const created = await prisma.bankAccount.create({
    data: {
      propertyId,
      organizationId,
      name: input.name.trim(),
      bankName: input.bankName ?? null,
      iban: input.iban ?? null,
      bic: input.bic ?? null,
      currencyCode: input.currencyCode ?? "EUR",
      ledgerAccountCode: input.ledgerAccountCode ?? null,
      openingBalance: input.openingBalance ?? 0,
      active: true
    }
  });
  return {
    ...created,
    openingBalance: num(created.openingBalance)
  };
}

export async function getBankAccountBalance(
  id: string,
  asOf?: string
): Promise<{
  bankAccountId: string;
  asOf: string | null;
  openingBalance: number;
  statementClosing: number | null;
  ledgerBalance: number;
  drift: number;
}> {
  const account = await prisma.bankAccount.findUnique({ where: { id } });
  if (!account) throw new Error(`Bank account ${id} not found.`);

  const asOfDate = asOf ? new Date(asOf) : undefined;
  if (asOfDate && Number.isNaN(asOfDate.getTime())) {
    throw new Error(`Invalid asOf date: ${asOf}`);
  }

  const ledgerBalance = await computeLedgerBalance(account.organizationId, account.ledgerAccountCode, asOfDate);
  const { closing } = await latestStatementClosing(account.id, asOfDate);
  const drift = closing == null ? 0 : Math.round((closing - ledgerBalance) * 100) / 100;

  return {
    bankAccountId: account.id,
    asOf: asOfDate?.toISOString() ?? null,
    openingBalance: num(account.openingBalance),
    statementClosing: closing,
    ledgerBalance,
    drift
  };
}
