// Bank accounts: list, create and balance (ledger vs. last statement).
//
// Lote tesoreria-banca: the ledger balance is read from the journal through
// the treasury ledger bridge (posted entries, accounting date ≤ asOf) on the
// account's PGC code — `572` when none is configured (Bancos c/c) — so the
// "drift" is the real difference between the bank's closing balance and the
// books, never a comparison against an empty 0. Money is Decimal; the wire
// keeps numbers for the existing screen.

import { prisma } from "@hotelos/database";
import type { UserContext } from "../../lib/demo-store.js";
import { BadRequestError, NotFoundError } from "../../lib/http-error.js";
import { ledgerBalances } from "../treasury/ledger-bridge.js";
import { dec, moneyNumber, round2, type Dec } from "../treasury/money.js";
import { validateIban } from "../banking-spain/sepa-norma19.generator.js";

export const DEFAULT_BANK_LEDGER_CODE = "572";

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
  /** Code actually used for the ledger balance (`ledgerAccountCode` or 572). */
  effectiveLedgerAccountCode: string;
  openingBalance: number;
  active: boolean;
  statementClosing: number | null;
  ledgerBalance: number;
  drift: number;
  latestStatementId: string | null;
  latestStatementPeriodEnd: string | null;
};

export function normaliseIban(value: string | null | undefined): string | null {
  if (!value) return null;
  const cleaned = value.replace(/\s+/g, "").toUpperCase();
  return cleaned || null;
}

async function computeLedgerBalance(organizationId: string, ledgerAccountCode: string | null, asOf?: Date): Promise<Dec> {
  const code = ledgerAccountCode ?? DEFAULT_BANK_LEDGER_CODE;
  const balances = await ledgerBalances(organizationId, [code], { asOf });
  return round2(balances.get(code) ?? dec(0));
}

async function latestStatementClosing(bankAccountId: string, asOf?: Date): Promise<{ closing: Dec | null; statementId: string | null; periodEnd: string | null }> {
  const statement = await prisma.bankStatement.findFirst({
    where: { bankAccountId, ...(asOf ? { periodEnd: { lte: asOf } } : {}) },
    orderBy: { periodEnd: "desc" }
  });
  if (!statement) return { closing: null, statementId: null, periodEnd: null };
  return { closing: dec(statement.closingBalance), statementId: statement.id, periodEnd: statement.periodEnd.toISOString() };
}

export async function listBankAccounts(propertyId: string): Promise<BankAccountRow[]> {
  const accounts = await prisma.bankAccount.findMany({ where: { propertyId }, orderBy: [{ active: "desc" }, { name: "asc" }] });
  const rows: BankAccountRow[] = [];
  for (const account of accounts) {
    const ledgerBalance = await computeLedgerBalance(account.organizationId, account.ledgerAccountCode);
    const { closing, statementId, periodEnd } = await latestStatementClosing(account.id);
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
      effectiveLedgerAccountCode: account.ledgerAccountCode ?? DEFAULT_BANK_LEDGER_CODE,
      openingBalance: moneyNumber(account.openingBalance),
      active: account.active,
      statementClosing: closing === null ? null : moneyNumber(closing),
      ledgerBalance: moneyNumber(ledgerBalance),
      drift: closing === null ? 0 : moneyNumber(closing.minus(ledgerBalance)),
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
  openingBalance?: number | string;
}) {
  const propertyId = input.propertyId ?? input.context.propertyId;
  const organizationId = input.organizationId ?? input.context.organizationId;
  if (!input.name?.trim()) throw new BadRequestError("El nombre de la cuenta bancaria es obligatorio.");
  const iban = normaliseIban(input.iban);
  if (iban && !validateIban(iban)) throw new BadRequestError("El IBAN no es válido.");
  const ledgerAccountCode = input.ledgerAccountCode?.trim() || null;
  if (ledgerAccountCode) {
    const account = await prisma.account.findUnique({ where: { organizationId_code: { organizationId, code: ledgerAccountCode } }, select: { isPostable: true } });
    if (!account) throw new BadRequestError(`La cuenta contable ${ledgerAccountCode} no existe en el plan de la organización.`);
    if (!account.isPostable) throw new BadRequestError(`La cuenta contable ${ledgerAccountCode} es una cabecera: elige una subcuenta de 572.`);
  }
  const created = await prisma.bankAccount.create({
    data: {
      propertyId,
      organizationId,
      name: input.name.trim(),
      bankName: input.bankName?.trim() || null,
      iban,
      bic: input.bic?.trim().toUpperCase() || null,
      currencyCode: input.currencyCode ?? "EUR",
      ledgerAccountCode,
      openingBalance: round2(dec(input.openingBalance ?? 0)),
      active: true
    }
  });
  return { ...created, openingBalance: moneyNumber(created.openingBalance), effectiveLedgerAccountCode: created.ledgerAccountCode ?? DEFAULT_BANK_LEDGER_CODE };
}

export async function getBankAccountBalance(id: string, asOf?: string): Promise<{
  bankAccountId: string;
  asOf: string | null;
  ledgerAccountCode: string;
  openingBalance: number;
  statementClosing: number | null;
  ledgerBalance: number;
  drift: number;
}> {
  const account = await prisma.bankAccount.findUnique({ where: { id } });
  if (!account) throw new NotFoundError("La cuenta bancaria no existe.");
  const asOfDate = asOf ? new Date(asOf) : undefined;
  if (asOfDate && Number.isNaN(asOfDate.getTime())) throw new BadRequestError(`Fecha asOf no válida: ${asOf}`);
  const ledgerBalance = await computeLedgerBalance(account.organizationId, account.ledgerAccountCode, asOfDate);
  const { closing } = await latestStatementClosing(account.id, asOfDate);
  return {
    bankAccountId: account.id,
    asOf: asOfDate?.toISOString() ?? null,
    ledgerAccountCode: account.ledgerAccountCode ?? DEFAULT_BANK_LEDGER_CODE,
    openingBalance: moneyNumber(account.openingBalance),
    statementClosing: closing === null ? null : moneyNumber(closing),
    ledgerBalance: moneyNumber(ledgerBalance),
    drift: closing === null ? 0 : moneyNumber(closing.minus(ledgerBalance))
  };
}

/** Bank account of a property matched by IBAN (CSB43 import) — null when none. */
export async function findBankAccountByIban(propertyId: string, iban: string) {
  const normalised = normaliseIban(iban);
  if (!normalised) return null;
  const accounts = await prisma.bankAccount.findMany({ where: { propertyId, active: true }, select: { id: true, iban: true } });
  return accounts.find((a) => normaliseIban(a.iban) === normalised) ?? null;
}
