// Bank reconciliation: candidates, suggestions, auto/manual matching and
// the accounting effects of a match (lote tesoreria-banca).
//
// A bank line is explained by ONE target:
//   payment            captured collection by transfer / online / payment link
//                      (the collection entry D 572 / H 430 belongs to the
//                      cobros lot; matching only records the reconciliation);
//   card_settlement    the acquirer's daily settlement of card_terminal
//                      payments: D 572 (net) / D 626 (fee) / H 5721 (gross);
//   supplier_bill      payment of a posted received invoice: D 400|410 / H 572
//                      (treasury/supplier-bill-payment hook);
//   payroll_period     payment of a calculated period: D 465 / H 572;
//   commission_accrual settlement to the channel: D 410 / H 572;
//   bank_fee           D 626 / H 572;   bank_interest  D 572 / H 769 (or D 662 / H 572);
//   manual             free explanation (note required), no accounting.
// Matches persist in reconciliation_matches (unique per bank line); the entry
// a match produced is kept in `notes` (JSON) so `unmatch` can reverse it —
// nothing is deleted from the journal. The pure rules live in matching.core.ts.

import { prisma } from "@hotelos/database";
import type { UserContext } from "../../lib/demo-store.js";
import { BadRequestError, ConflictError, NotFoundError } from "../../lib/http-error.js";
import { settleCommissionAccrual } from "../commissions/commission-accrual.service.js";
import { payPeriod } from "../payroll/periods.service.js";
import { ledger, type Db } from "../treasury/ledger-bridge.js";
import { addDays, dayUtc, dec, isoDay, money, moneyNumber, round2, sum, toCents, type Dec } from "../treasury/money.js";
import { TREASURY_WRITE_KEYS, requireAnyPermission } from "../treasury/permissions.js";
import { supplierBillPayer } from "../treasury/supplier-bill-payment.js";
import { DEFAULT_BANK_LEDGER_CODE } from "./bank-account.service.js";
import { parseMatchNotes } from "./bank-statement.service.js";
import { autoMatch as autoMatchLines, buildCardSettlementCandidates, suggest, type BankLineLike, type MatchCandidate, type Suggestion } from "./matching.core.js";

const BANK_FEES_CODE = "626";
const CARD_PENDING_CODE = "5721";
const FINANCIAL_INCOME_CODE = "769";
const INTEREST_EXPENSE_CODE = "662";
const CANDIDATE_WINDOW_DAYS = 15;

export type ReconcileTargetType = "payment" | "card_settlement" | "supplier_bill" | "payroll_period" | "commission_accrual" | "bank_fee" | "bank_interest" | "manual";

const TARGET_TYPES = new Set<ReconcileTargetType>(["payment", "card_settlement", "supplier_bill", "payroll_period", "commission_accrual", "bank_fee", "bank_interest", "manual"]);

export type SuggestionView = {
  kind: MatchCandidate["kind"];
  id: string;
  label: string;
  amount: number;
  date: string;
  confidence: Suggestion["confidence"];
  reason: string;
  fee: number;
  paymentIds?: string[];
};

type LineRow = NonNullable<Awaited<ReturnType<typeof prisma.bankStatementLine.findUnique>>>;
type AccountRow = NonNullable<Awaited<ReturnType<typeof prisma.bankAccount.findUnique>>>;

function lineText(line: LineRow): string {
  return [line.description, line.reference, line.counterparty].filter(Boolean).join(" ");
}

function toLineLike(line: LineRow): BankLineLike {
  return { id: line.id, txDate: line.txDate, amount: dec(line.amount), text: lineText(line) };
}

async function loadAccount(bankAccountId: string): Promise<AccountRow> {
  const account = await prisma.bankAccount.findUnique({ where: { id: bankAccountId } });
  if (!account) throw new NotFoundError("La cuenta bancaria no existe.");
  return account;
}

function bankLedgerCode(account: AccountRow): string {
  return account.ledgerAccountCode ?? DEFAULT_BANK_LEDGER_CODE;
}

// ---- Candidates -------------------------------------------------------------------

type CandidateSet = { candidates: MatchCandidate[]; cardBatches: Map<string, string[]> };

function isCiphertextLike(value: string | null): boolean {
  return Boolean(value && /^enc:|^v1:/.test(value));
}

export async function loadCandidates(account: AccountRow, from: Date, to: Date): Promise<CandidateSet> {
  const windowFrom = addDays(from, -CANDIDATE_WINDOW_DAYS);
  const windowTo = addDays(to, CANDIDATE_WINDOW_DAYS);
  const candidates: MatchCandidate[] = [];
  const cardBatches = new Map<string, string[]>();

  // Already reconciled targets on this bank account are never offered twice.
  const existingMatches = await prisma.reconciliationMatch.findMany({ where: { bankAccountId: account.id }, select: { matchType: true, matchedEntityId: true, notes: true } });
  const used = new Set(existingMatches.map((m) => `${m.matchType}:${m.matchedEntityId}`));
  const settledCardPaymentIds = new Set<string>();
  for (const m of existingMatches) {
    if (m.matchType !== "card_settlement") continue;
    for (const id of parseMatchNotes(m.notes).paymentIds ?? []) settledCardPaymentIds.add(id);
  }

  // Collections by bank transfer / online / payment link (inflows).
  const payments = await prisma.payment.findMany({
    where: {
      propertyId: account.propertyId,
      status: "captured",
      deletedAt: null,
      createdAt: { gte: windowFrom, lte: windowTo },
      OR: [{ methodCode: { in: ["bank_transfer", "card_online", "payment_link", "other"] } }, { methodCode: null, method: { in: ["bank_transfer", "payment_link", "ota_virtual_card"] } }]
    },
    select: { id: true, amount: true, createdAt: true, pspReference: true, invoiceId: true, method: true, methodCode: true }
  });
  const invoiceIds = Array.from(new Set(payments.map((p) => p.invoiceId).filter((id): id is string => Boolean(id))));
  const invoices = invoiceIds.length ? await prisma.invoice.findMany({ where: { id: { in: invoiceIds } }, select: { id: true, invoiceNumber: true, customerName: true, customerTaxId: true } }) : [];
  const invoiceById = new Map(invoices.map((i) => [i.id, i]));
  for (const payment of payments) {
    if (used.has(`payment:${payment.id}`)) continue;
    const invoice = payment.invoiceId ? invoiceById.get(payment.invoiceId) : undefined;
    const references = [payment.pspReference, invoice?.invoiceNumber, invoice?.customerTaxId, invoice?.customerName].filter((r): r is string => Boolean(r));
    if (payment.pspReference && isCiphertextLike(payment.pspReference)) references.shift();
    candidates.push({
      kind: "payment",
      id: payment.id,
      amount: round2(dec(payment.amount)),
      direction: "in",
      date: payment.createdAt,
      references,
      label: `Cobro ${payment.methodCode ?? payment.method} ${money(payment.amount)} €${invoice?.invoiceNumber ? ` · factura ${invoice.invoiceNumber}` : ""}`
    });
  }

  // Card terminal settlements (inflows, net of the acquirer fee).
  const cardPayments = await prisma.payment.findMany({
    where: {
      propertyId: account.propertyId,
      status: "captured",
      deletedAt: null,
      createdAt: { gte: windowFrom, lte: windowTo },
      OR: [{ methodCode: "card_terminal" }, { methodCode: null, method: "card" }]
    },
    select: { id: true, amount: true, createdAt: true }
  });
  const batches = buildCardSettlementCandidates(
    cardPayments.filter((p) => !settledCardPaymentIds.has(p.id)).map((p) => ({ id: p.id, amountCents: toCents(dec(p.amount)), capturedAt: p.createdAt }))
  );
  for (const batch of batches) {
    if (used.has(`card_settlement:${batch.id}`)) continue;
    const { paymentIds, ...candidate } = batch;
    candidates.push(candidate);
    cardBatches.set(batch.id, paymentIds);
  }

  // Received invoices pending payment (outflows).
  const bills = await prisma.supplierBill.findMany({
    where: {
      OR: [{ propertyId: account.propertyId }, { organizationId: account.organizationId }],
      status: { in: ["approved", "posted"] },
      paymentDate: null,
      cancelledAt: null
    },
    select: { id: true, total: true, dueDate: true, issueDate: true, createdAt: true, invoiceNumber: true, supplierName: true, supplierTaxId: true }
  });
  for (const bill of bills) {
    if (used.has(`supplier_bill:${bill.id}`)) continue;
    candidates.push({
      kind: "supplier_bill",
      id: bill.id,
      amount: round2(dec(bill.total)),
      direction: "out",
      date: bill.dueDate ?? bill.issueDate ?? bill.createdAt,
      references: [bill.invoiceNumber, bill.supplierTaxId, bill.supplierName].filter((r): r is string => Boolean(r)),
      label: `Factura ${bill.invoiceNumber ?? bill.id} · ${bill.supplierName ?? "proveedor"} · ${money(bill.total)} €`
    });
  }

  // Payroll periods calculated and unpaid (outflows).
  const periods = await prisma.payrollPeriod.findMany({
    where: { organizationId: account.organizationId, status: { in: ["calculated", "exported"] }, paidAt: null, totalNet: { gt: 0 } },
    select: { id: true, totalNet: true, endDate: true, periodCode: true }
  });
  for (const period of periods) {
    if (used.has(`payroll_period:${period.id}`)) continue;
    candidates.push({
      kind: "payroll_period",
      id: period.id,
      amount: round2(dec(period.totalNet)),
      direction: "out",
      date: period.endDate,
      references: [period.periodCode, "nomina", "nómina", "salario"],
      label: `Nóminas ${period.periodCode} · líquido ${money(period.totalNet)} €`
    });
  }

  // Channel commissions accrued and unsettled (outflows).
  const accruals = await prisma.commissionAccrual.findMany({
    where: { propertyId: account.propertyId, status: "accrued" },
    select: { id: true, commissionAmount: true, accruedAt: true, channelCode: true, channelId: true }
  });
  for (const accrual of accruals) {
    if (used.has(`commission_accrual:${accrual.id}`)) continue;
    candidates.push({
      kind: "commission_accrual",
      id: accrual.id,
      amount: round2(dec(accrual.commissionAmount)),
      direction: "out",
      date: accrual.accruedAt,
      references: [accrual.channelCode ?? ""].filter(Boolean),
      label: `Comisión ${accrual.channelCode ?? accrual.channelId ?? "canal"} · ${money(accrual.commissionAmount)} €`
    });
  }

  return { candidates, cardBatches };
}

function toSuggestionView(s: Suggestion, cardBatches: Map<string, string[]>): SuggestionView {
  return {
    kind: s.candidate.kind,
    id: s.candidate.id,
    label: s.candidate.label,
    amount: moneyNumber(s.candidate.amount),
    date: isoDay(s.candidate.date),
    confidence: s.confidence,
    reason: s.reason,
    fee: moneyNumber(s.fee),
    ...(s.candidate.kind === "card_settlement" ? { paymentIds: cardBatches.get(s.candidate.id) ?? [] } : {})
  };
}

/** Ranked explanations for one bank line (read-only). */
export async function suggestForLine(bankLineId: string): Promise<{ bankLineId: string; amount: number; txDate: string; suggestions: SuggestionView[] }> {
  const line = await prisma.bankStatementLine.findUnique({ where: { id: bankLineId } });
  if (!line) throw new NotFoundError("El movimiento bancario no existe.");
  const account = await loadAccount(line.bankAccountId);
  const { candidates, cardBatches } = await loadCandidates(account, line.txDate, line.txDate);
  const suggestions = suggest(toLineLike(line), candidates).map((s) => toSuggestionView(s, cardBatches));
  return { bankLineId: line.id, amount: moneyNumber(line.amount), txDate: isoDay(line.txDate), suggestions };
}

// ---- Effects -----------------------------------------------------------------------

type MatchEffect = { journalEntryId: string | null; paymentIds?: string[]; fee?: string; text?: string };

async function applyEffect(tx: Db, input: { line: LineRow; account: AccountRow; matchType: ReconcileTargetType; matchedEntityId: string; notes?: string | null; cardBatches: Map<string, string[]>; createdBy: string | null }): Promise<{ matchedEntityId: string; effect: MatchEffect }> {
  const { line, account } = input;
  const amount = round2(dec(line.amount));
  const magnitude = amount.abs();
  const bank = bankLedgerCode(account);
  const txDate = dayUtc(line.txDate);
  const reference = line.reference ?? line.description ?? line.id;

  switch (input.matchType) {
    case "payment": {
      const payment = await tx.payment.findFirst({ where: { id: input.matchedEntityId, propertyId: account.propertyId, deletedAt: null }, select: { id: true, amount: true, status: true } });
      if (!payment) throw new NotFoundError("El cobro no existe en esta propiedad.");
      if (payment.status !== "captured") throw new ConflictError("Solo se concilia un cobro capturado.", { code: "PAYMENT_NOT_CAPTURED", status: payment.status });
      if (amount.lte(0)) throw new ConflictError("Un cobro solo explica un abono (importe positivo).", { code: "DIRECTION_MISMATCH" });
      if (!round2(dec(payment.amount)).equals(magnitude)) {
        throw new ConflictError(`El importe del cobro (${money(payment.amount)}) no coincide con el movimiento (${money(magnitude)}).`, { code: "AMOUNT_MISMATCH" });
      }
      return { matchedEntityId: payment.id, effect: { journalEntryId: null, text: input.notes ?? undefined } };
    }
    case "card_settlement": {
      if (amount.lte(0)) throw new ConflictError("Una liquidación de datáfono es un abono (importe positivo).", { code: "DIRECTION_MISMATCH" });
      let paymentIds = input.cardBatches.get(input.matchedEntityId);
      if (!paymentIds) {
        // Manual batch: the caller names the day (card:YYYY-MM-DD) or the payment ids (comma separated).
        const day = /^card:(\d{4}-\d{2}-\d{2})$/.exec(input.matchedEntityId)?.[1];
        if (day) {
          const dayStart = dayUtc(day);
          const rows = await tx.payment.findMany({
            where: { propertyId: account.propertyId, status: "captured", deletedAt: null, createdAt: { gte: dayStart, lt: addDays(dayStart, 1) }, OR: [{ methodCode: "card_terminal" }, { methodCode: null, method: "card" }] },
            select: { id: true }
          });
          paymentIds = rows.map((r) => r.id);
        } else {
          paymentIds = input.matchedEntityId.split(",").map((s) => s.trim()).filter(Boolean);
        }
      }
      if (paymentIds.length === 0) throw new BadRequestError("La liquidación de datáfono no tiene cobros con tarjeta que liquidar.");
      const rows = await tx.payment.findMany({ where: { id: { in: paymentIds }, propertyId: account.propertyId, status: "captured", deletedAt: null }, select: { id: true, amount: true } });
      if (rows.length !== paymentIds.length) throw new NotFoundError("Alguno de los cobros con tarjeta no existe en esta propiedad.");
      const gross = round2(sum(rows.map((r) => dec(r.amount))));
      const fee = round2(gross.minus(magnitude));
      if (fee.isNegative()) {
        throw new ConflictError(`El abono (${money(magnitude)}) supera el bruto de los cobros con tarjeta (${money(gross)}).`, { code: "AMOUNT_MISMATCH", gross: money(gross) });
      }
      const description = `Liquidación datáfono ${isoDay(txDate)} · bruto ${money(gross)} € · comisión ${money(fee)} €`;
      const lines = [
        { accountCode: bank, debit: magnitude, description },
        ...(fee.gt(0) ? [{ accountCode: BANK_FEES_CODE, debit: fee, description: `${description} — comisión TPV` }] : []),
        { accountCode: CARD_PENDING_CODE, credit: gross, description: `${description} — datáfono pendiente de liquidar` }
      ];
      const entry = await ledger().postJournalEntry({ organizationId: account.organizationId, propertyId: account.propertyId, entryDate: txDate, sourceType: "card_settlement", sourceId: line.id, description, reference, createdBy: input.createdBy, lines, db: tx });
      const key = input.cardBatches.has(input.matchedEntityId) ? input.matchedEntityId : `card:${isoDay(txDate)}:${line.id}`;
      return { matchedEntityId: key, effect: { journalEntryId: entry.id, paymentIds: rows.map((r) => r.id), fee: money(fee), text: input.notes ?? undefined } };
    }
    case "bank_fee": {
      if (amount.gte(0)) throw new ConflictError("Una comisión bancaria es un cargo (importe negativo).", { code: "DIRECTION_MISMATCH" });
      const description = `Comisión bancaria · ${line.description ?? "extracto"} ${isoDay(txDate)}`;
      const entry = await ledger().postJournalEntry({
        organizationId: account.organizationId,
        propertyId: account.propertyId,
        entryDate: txDate,
        sourceType: "manual",
        sourceId: `bankline:${line.id}:fee`,
        description,
        reference,
        createdBy: input.createdBy,
        lines: [
          { accountCode: BANK_FEES_CODE, debit: magnitude, description },
          { accountCode: bank, credit: magnitude, description }
        ],
        db: tx
      });
      return { matchedEntityId: entry.id, effect: { journalEntryId: entry.id, text: input.notes ?? undefined } };
    }
    case "bank_interest": {
      if (amount.isZero()) throw new BadRequestError("El movimiento no tiene importe.");
      const income = amount.gt(0);
      const description = `${income ? "Intereses a favor" : "Intereses de deudas"} · ${line.description ?? "extracto"} ${isoDay(txDate)}`;
      const entry = await ledger().postJournalEntry({
        organizationId: account.organizationId,
        propertyId: account.propertyId,
        entryDate: txDate,
        sourceType: "manual",
        sourceId: `bankline:${line.id}:interest`,
        description,
        reference,
        createdBy: input.createdBy,
        lines: income
          ? [
              { accountCode: bank, debit: magnitude, description },
              { accountCode: FINANCIAL_INCOME_CODE, credit: magnitude, description }
            ]
          : [
              { accountCode: INTEREST_EXPENSE_CODE, debit: magnitude, description },
              { accountCode: bank, credit: magnitude, description }
            ],
        db: tx
      });
      return { matchedEntityId: entry.id, effect: { journalEntryId: entry.id, text: input.notes ?? undefined } };
    }
    case "supplier_bill": {
      if (amount.gte(0)) throw new ConflictError("El pago a un proveedor es un cargo (importe negativo).", { code: "DIRECTION_MISMATCH" });
      const bill = await tx.supplierBill.findFirst({ where: { id: input.matchedEntityId, OR: [{ propertyId: account.propertyId }, { organizationId: account.organizationId }] }, select: { id: true } });
      if (!bill) throw new NotFoundError("La factura de proveedor no existe en esta organización.");
      const paid = await supplierBillPayer().pay({ billId: bill.id, paidAt: txDate, amount: magnitude, bankLedgerCode: bank, reference, createdBy: input.createdBy, db: tx });
      return { matchedEntityId: bill.id, effect: { journalEntryId: paid.journalEntryId, text: input.notes ?? undefined } };
    }
    case "payroll_period": {
      if (amount.gte(0)) throw new ConflictError("El pago de nóminas es un cargo (importe negativo).", { code: "DIRECTION_MISMATCH" });
      const period = await tx.payrollPeriod.findFirst({ where: { id: input.matchedEntityId, organizationId: account.organizationId }, select: { id: true, totalNet: true } });
      if (!period) throw new NotFoundError("El periodo de nómina no existe en esta organización.");
      if (!round2(dec(period.totalNet)).equals(magnitude)) {
        throw new ConflictError(`El líquido del periodo (${money(period.totalNet)}) no coincide con el movimiento (${money(magnitude)}).`, { code: "AMOUNT_MISMATCH" });
      }
      const paid = await payPeriod({ periodId: period.id, paidAt: txDate, bankLedgerCode: bank, reference, db: tx });
      return { matchedEntityId: period.id, effect: { journalEntryId: paid.paymentJournalEntryId, text: input.notes ?? undefined } };
    }
    case "commission_accrual": {
      if (amount.gte(0)) throw new ConflictError("La liquidación de una comisión es un cargo (importe negativo).", { code: "DIRECTION_MISMATCH" });
      const accrual = await tx.commissionAccrual.findFirst({ where: { id: input.matchedEntityId, propertyId: account.propertyId }, select: { id: true, commissionAmount: true } });
      if (!accrual) throw new NotFoundError("El devengo de comisión no existe en esta propiedad.");
      if (!round2(dec(accrual.commissionAmount)).equals(magnitude)) {
        throw new ConflictError(`La comisión (${money(accrual.commissionAmount)}) no coincide con el movimiento (${money(magnitude)}).`, { code: "AMOUNT_MISMATCH" });
      }
      const settled = await settleCommissionAccrual({ accrualId: accrual.id, paidAt: txDate, bankLedgerCode: bank, reference, createdBy: input.createdBy, db: tx });
      return { matchedEntityId: accrual.id, effect: { journalEntryId: settled.settlementJournalEntryId, text: input.notes ?? undefined } };
    }
    case "manual": {
      if (!input.notes?.trim()) throw new BadRequestError("Una conciliación manual necesita una nota que la explique.");
      return { matchedEntityId: input.matchedEntityId || "manual", effect: { journalEntryId: null, text: input.notes.trim() } };
    }
    default:
      throw new BadRequestError(`Tipo de conciliación no admitido: ${String(input.matchType)}.`);
  }
}

export type ReconcileLineInput = {
  bankLineId: string;
  matchType: ReconcileTargetType;
  matchedEntityId?: string;
  notes?: string | null;
  context?: UserContext;
  userId?: string;
  confidence?: string;
};

export type ReconcileLineResult = {
  id: string;
  bankLineId: string;
  matchType: string;
  matchedEntityId: string;
  amount: number;
  confidence: string | null;
  matchedAt: string;
  journalEntryId: string | null;
  notes: string | null;
};

/** Manual (or auto) reconciliation of ONE bank line with its accounting effect, atomically. */
export async function reconcileLine(input: ReconcileLineInput): Promise<ReconcileLineResult> {
  if (input.context) requireAnyPermission(input.context, TREASURY_WRITE_KEYS);
  if (!TARGET_TYPES.has(input.matchType)) throw new BadRequestError(`matchType no admitido: ${String(input.matchType)}.`);
  const line = await prisma.bankStatementLine.findUnique({ where: { id: input.bankLineId } });
  if (!line) throw new NotFoundError("El movimiento bancario no existe.");
  const existing = await prisma.reconciliationMatch.findUnique({ where: { bankLineId: line.id } });
  if (existing) throw new ConflictError("El movimiento ya está conciliado: desconcílialo antes de cambiar la explicación.", { code: "LINE_ALREADY_MATCHED", matchId: existing.id });
  const account = await loadAccount(line.bankAccountId);
  const { cardBatches } = input.matchType === "card_settlement" ? await loadCandidates(account, line.txDate, line.txDate) : { cardBatches: new Map<string, string[]>() };
  const createdBy = input.context?.userId ?? input.userId ?? null;
  const matchedEntityId = input.matchedEntityId ?? (input.matchType === "manual" ? "manual" : "");
  if (!matchedEntityId && input.matchType !== "bank_fee" && input.matchType !== "bank_interest" && input.matchType !== "card_settlement") {
    throw new BadRequestError("matchedEntityId es obligatorio para este tipo de conciliación.");
  }

  const match = await prisma.$transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const applied = await applyEffect(tx, { line, account, matchType: input.matchType, matchedEntityId: matchedEntityId || `card:${isoDay(line.txDate)}`, notes: input.notes, cardBatches, createdBy });
    const created = await tx.reconciliationMatch.create({
      data: {
        bankAccountId: line.bankAccountId,
        bankLineId: line.id,
        matchType: input.matchType,
        matchedEntityId: applied.matchedEntityId,
        amount: round2(dec(line.amount)),
        confidence: input.confidence ?? "manual",
        matchedByUserId: createdBy,
        notes: JSON.stringify(applied.effect)
      }
    });
    await tx.bankStatementLine.update({ where: { id: line.id }, data: { matchedTo: applied.matchedEntityId } });
    return created;
  });
  await refreshStatementStatus(line.statementId);
  const effect = parseMatchNotes(match.notes);
  return {
    id: match.id,
    bankLineId: match.bankLineId,
    matchType: match.matchType,
    matchedEntityId: match.matchedEntityId,
    amount: moneyNumber(match.amount),
    confidence: match.confidence,
    matchedAt: match.matchedAt.toISOString(),
    journalEntryId: effect.journalEntryId ?? null,
    notes: effect.text ?? null
  };
}

/** Legacy signature kept for server.ts (POST /banking/lines/:id/match). */
export async function manualMatch(input: { bankLineId: string; matchType: ReconcileTargetType | string; matchedEntityId: string; userId?: string; notes?: string; context?: UserContext }): Promise<ReconcileLineResult> {
  const matchType = TARGET_TYPES.has(input.matchType as ReconcileTargetType) ? (input.matchType as ReconcileTargetType) : null;
  if (!matchType) throw new BadRequestError(`matchType no admitido: ${String(input.matchType)}.`);
  return reconcileLine({ bankLineId: input.bankLineId, matchType, matchedEntityId: input.matchedEntityId, notes: input.notes, userId: input.userId, context: input.context });
}

// ---- Auto match ---------------------------------------------------------------------

export type AutoMatchDetail = { bankLineId: string; matched: boolean; matchType?: string; matchedEntityId?: string; confidence?: string; reason?: string; error?: string; suggestions?: SuggestionView[] };

export type AutoMatchResult = { statementId: string; scanned: number; matched: number; alreadyMatched: number; unmatched: number; dryRun: boolean; details: AutoMatchDetail[] };

/** Applies the high/medium suggestions to every unmatched line of the statement (`dryRun` only reports). */
export async function autoMatchStatement(statementId: string, options: { dryRun?: boolean; context?: UserContext } = {}): Promise<AutoMatchResult> {
  if (options.context) requireAnyPermission(options.context, TREASURY_WRITE_KEYS);
  const statement = await prisma.bankStatement.findUnique({ where: { id: statementId } });
  if (!statement) throw new NotFoundError("El extracto no existe.");
  const account = await loadAccount(statement.bankAccountId);
  const lines = await prisma.bankStatementLine.findMany({ where: { statementId }, orderBy: [{ txDate: "asc" }, { id: "asc" }] });
  const dryRun = options.dryRun === true;
  if (lines.length === 0) return { statementId, scanned: 0, matched: 0, alreadyMatched: 0, unmatched: 0, dryRun, details: [] };
  const existing = await prisma.reconciliationMatch.findMany({ where: { bankLineId: { in: lines.map((l) => l.id) } }, select: { bankLineId: true } });
  const alreadyMatchedIds = new Set(existing.map((m) => m.bankLineId));
  const pending = lines.filter((l) => !alreadyMatchedIds.has(l.id));
  const { candidates, cardBatches } = await loadCandidates(account, statement.periodStart, statement.periodEnd);
  const result = autoMatchLines(pending.map(toLineLike), candidates);
  const details: AutoMatchDetail[] = lines.filter((l) => alreadyMatchedIds.has(l.id)).map((l) => ({ bankLineId: l.id, matched: false, reason: "already_matched" }));
  let matched = 0;

  for (const hit of result.matched) {
    const { suggestion } = hit;
    if (dryRun) {
      details.push({ bankLineId: hit.lineId, matched: false, matchType: suggestion.candidate.kind, matchedEntityId: suggestion.candidate.id, confidence: suggestion.confidence, reason: suggestion.reason });
      continue;
    }
    try {
      const applied = await reconcileLine({ bankLineId: hit.lineId, matchType: suggestion.candidate.kind, matchedEntityId: suggestion.candidate.id, confidence: `auto_${suggestion.confidence}`, userId: options.context?.userId });
      matched++;
      details.push({ bankLineId: hit.lineId, matched: true, matchType: applied.matchType, matchedEntityId: applied.matchedEntityId, confidence: suggestion.confidence, reason: suggestion.reason });
    } catch (error) {
      details.push({ bankLineId: hit.lineId, matched: false, matchType: suggestion.candidate.kind, matchedEntityId: suggestion.candidate.id, reason: suggestion.reason, error: error instanceof Error ? error.message : String(error) });
    }
  }
  for (const lineId of result.unmatched) {
    const line = pending.find((l) => l.id === lineId)!;
    const suggestions = suggest(toLineLike(line), candidates).slice(0, 5).map((s) => toSuggestionView(s, cardBatches));
    details.push({ bankLineId: lineId, matched: false, reason: suggestions.length > 0 ? "needs_review" : "needs_manual", suggestions });
  }
  if (!dryRun) await refreshStatementStatus(statementId);
  return { statementId, scanned: lines.length, matched, alreadyMatched: alreadyMatchedIds.size, unmatched: pending.length - matched, dryRun, details };
}

// ---- Unmatch --------------------------------------------------------------------------

export async function unmatch(bankLineId: string, options: { context?: UserContext } = {}): Promise<{ bankLineId: string; unmatched: boolean; reversalJournalEntryId: string | null }> {
  if (options.context) requireAnyPermission(options.context, TREASURY_WRITE_KEYS);
  const line = await prisma.bankStatementLine.findUnique({ where: { id: bankLineId } });
  if (!line) throw new NotFoundError("El movimiento bancario no existe.");
  const match = await prisma.reconciliationMatch.findUnique({ where: { bankLineId } });
  if (!match) return { bankLineId, unmatched: false, reversalJournalEntryId: null };
  const account = await loadAccount(line.bankAccountId);
  const effect = parseMatchNotes(match.notes);
  const createdBy = options.context?.userId ?? null;
  const today = new Date();

  const reversalId = await prisma.$transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    let reversalJournalEntryId: string | null = null;
    switch (match.matchType) {
      case "card_settlement":
      case "bank_fee":
      case "bank_interest": {
        if (effect.journalEntryId) {
          const reversal = await ledger().reverseJournalEntry({ organizationId: account.organizationId, journalEntryId: effect.journalEntryId, entryDate: today, description: `Reverso conciliación bancaria · ${line.description ?? line.id}`, createdBy, db: tx });
          reversalJournalEntryId = reversal.id;
        }
        break;
      }
      case "supplier_bill": {
        const undone = await supplierBillPayer().unpay({ billId: match.matchedEntityId, entryDate: today, createdBy, db: tx });
        reversalJournalEntryId = undone.reversalJournalEntryId;
        break;
      }
      case "payroll_period": {
        const period = await tx.payrollPeriod.findUnique({ where: { id: match.matchedEntityId } });
        if (period?.paymentJournalEntryId) {
          const reversal = await ledger().reverseJournalEntry({ organizationId: period.organizationId, journalEntryId: period.paymentJournalEntryId, entryDate: today, description: `Reverso pago nóminas ${period.periodCode} (desconciliación bancaria)`, createdBy, db: tx });
          reversalJournalEntryId = reversal.id;
          await tx.payrollPeriod.update({ where: { id: period.id }, data: { paymentJournalEntryId: null, paidAt: null } });
          await tx.payrollSlip.updateMany({ where: { periodId: period.id }, data: { status: "issued" } });
        }
        break;
      }
      case "commission_accrual": {
        const accrual = await tx.commissionAccrual.findUnique({ where: { id: match.matchedEntityId } });
        if (accrual?.settlementJournalEntryId) {
          const reversal = await ledger().reverseJournalEntry({ organizationId: account.organizationId, journalEntryId: accrual.settlementJournalEntryId, entryDate: today, description: `Reverso liquidación comisión ${accrual.channelCode ?? ""} (desconciliación bancaria)`, createdBy, db: tx });
          reversalJournalEntryId = reversal.id;
          await tx.commissionAccrual.update({ where: { id: accrual.id }, data: { status: "accrued", settledAt: null, settlementJournalEntryId: null } });
        }
        break;
      }
      default:
        break; // payment / manual: the match is the only effect
    }
    await tx.reconciliationMatch.delete({ where: { id: match.id } });
    await tx.bankStatementLine.update({ where: { id: bankLineId }, data: { matchedTo: null } });
    return reversalJournalEntryId;
  });
  await refreshStatementStatus(line.statementId);
  return { bankLineId, unmatched: true, reversalJournalEntryId: reversalId };
}

async function refreshStatementStatus(statementId: string): Promise<void> {
  const lines = await prisma.bankStatementLine.findMany({ where: { statementId }, select: { id: true } });
  if (lines.length === 0) return;
  const matchedCount = await prisma.reconciliationMatch.count({ where: { bankLineId: { in: lines.map((l) => l.id) } } });
  await prisma.bankStatement.update({ where: { id: statementId }, data: { status: matchedCount === lines.length ? "reconciled" : "pending" } });
}

// ---- Status snapshot ------------------------------------------------------------------

export async function reconciliationStatus(bankAccountId: string): Promise<{ bankAccountId: string; totalLines: number; matched: number; unmatched: number; percentage: number; unmatchedAmount: number }> {
  const lines = await prisma.bankStatementLine.findMany({ where: { bankAccountId }, select: { id: true, amount: true } });
  const totalLines = lines.length;
  if (totalLines === 0) return { bankAccountId, totalLines: 0, matched: 0, unmatched: 0, percentage: 0, unmatchedAmount: 0 };
  const matches = await prisma.reconciliationMatch.findMany({ where: { bankLineId: { in: lines.map((l) => l.id) } }, select: { bankLineId: true } });
  const matchedIds = new Set(matches.map((m) => m.bankLineId));
  const unmatchedAmount = sum(lines.filter((l) => !matchedIds.has(l.id)).map((l) => dec(l.amount)));
  const matched = matchedIds.size;
  const unmatched = totalLines - matched;
  return { bankAccountId, totalLines, matched, unmatched, percentage: Math.round((matched / totalLines) * 1000) / 10, unmatchedAmount: moneyNumber(unmatchedAmount) };
}

/** Exported for tests / the treasury forecast: bank movements not yet explained. */
export async function unmatchedLines(bankAccountId: string): Promise<Array<{ id: string; txDate: Date; amount: Dec; description: string | null }>> {
  const lines = await prisma.bankStatementLine.findMany({ where: { bankAccountId }, select: { id: true, txDate: true, amount: true, description: true } });
  const matches = await prisma.reconciliationMatch.findMany({ where: { bankLineId: { in: lines.map((l) => l.id) } }, select: { bankLineId: true } });
  const matchedIds = new Set(matches.map((m) => m.bankLineId));
  return lines.filter((l) => !matchedIds.has(l.id)).map((l) => ({ id: l.id, txDate: l.txDate, amount: dec(l.amount), description: l.description }));
}
