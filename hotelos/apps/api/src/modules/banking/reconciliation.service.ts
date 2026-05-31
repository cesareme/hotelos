import { prisma } from "@hotelos/database";

// ---- Helpers ----

function num(value: unknown): number {
  if (value == null) return 0;
  return Number(typeof value === "object" && value !== null && "toString" in value ? value.toString() : value);
}

const DAY_MS = 24 * 60 * 60 * 1000;

function daysApart(a: Date, b: Date): number {
  return Math.abs(a.getTime() - b.getTime()) / DAY_MS;
}

function amountEquals(a: number, b: number): boolean {
  return Math.abs(a - b) < 0.01;
}

// ---- Auto match ----

export async function autoMatchStatement(statementId: string) {
  const statement = await prisma.bankStatement.findUnique({ where: { id: statementId } });
  if (!statement) throw new Error(`Statement ${statementId} not found.`);

  const lines = await prisma.bankStatementLine.findMany({ where: { statementId } });
  if (lines.length === 0) {
    return { statementId, scanned: 0, matched: 0, alreadyMatched: 0, details: [] };
  }

  const existingMatches = await prisma.reconciliationMatch.findMany({
    where: { bankLineId: { in: lines.map((l) => l.id) } },
    select: { bankLineId: true }
  });
  const alreadyMatchedIds = new Set(existingMatches.map((m) => m.bankLineId));

  // Pre-fetch payments + supplier bills for this property within a generous
  // window around the statement period.
  const windowStart = new Date(statement.periodStart.getTime() - 7 * DAY_MS);
  const windowEnd = new Date(statement.periodEnd.getTime() + 7 * DAY_MS);

  const payments = await prisma.payment.findMany({
    where: {
      propertyId: statement.propertyId,
      createdAt: { gte: windowStart, lte: windowEnd }
    }
  });

  const supplierBills = await prisma.supplierBill.findMany({
    where: { propertyId: statement.propertyId }
  });

  const usedPaymentIds = new Set<string>();
  const usedBillIds = new Set<string>();
  // Don't double-match against already-bound entities.
  const allMatches = await prisma.reconciliationMatch.findMany({
    where: { bankAccountId: statement.bankAccountId }
  });
  for (const m of allMatches) {
    if (m.matchType === "payment") usedPaymentIds.add(m.matchedEntityId);
    if (m.matchType === "supplier_bill") usedBillIds.add(m.matchedEntityId);
  }

  const details: Array<{
    bankLineId: string;
    matched: boolean;
    matchType?: string;
    matchedEntityId?: string;
    reason?: string;
  }> = [];
  let matched = 0;
  let alreadyMatched = 0;

  for (const line of lines) {
    if (alreadyMatchedIds.has(line.id)) {
      alreadyMatched++;
      details.push({ bankLineId: line.id, matched: false, reason: "already_matched" });
      continue;
    }
    const lineAmount = num(line.amount);

    // 1) Payment: amount matches (sign-agnostic to allow inflows), createdAt
    //    within ±3 days of txDate.
    let chosenPayment: { id: string } | null = null;
    for (const payment of payments) {
      if (usedPaymentIds.has(payment.id)) continue;
      const amt = num(payment.amount);
      if (!amountEquals(amt, Math.abs(lineAmount))) continue;
      if (daysApart(payment.createdAt, line.txDate) > 3) continue;
      chosenPayment = { id: payment.id };
      break;
    }
    if (chosenPayment) {
      await prisma.reconciliationMatch.create({
        data: {
          bankAccountId: line.bankAccountId,
          bankLineId: line.id,
          matchType: "payment",
          matchedEntityId: chosenPayment.id,
          amount: lineAmount,
          confidence: "auto_exact"
        }
      });
      await prisma.bankStatementLine.update({
        where: { id: line.id },
        data: { matchedTo: chosenPayment.id }
      });
      usedPaymentIds.add(chosenPayment.id);
      matched++;
      details.push({
        bankLineId: line.id,
        matched: true,
        matchType: "payment",
        matchedEntityId: chosenPayment.id
      });
      continue;
    }

    // 2) SupplierBill: total matches and dueDate within ±5 days of txDate.
    //    (Schema's paymentDate lives in the sidecar map; we proxy with
    //     dueDate, falling back to issueDate when dueDate is null.)
    let chosenBill: { id: string } | null = null;
    for (const bill of supplierBills) {
      if (usedBillIds.has(bill.id)) continue;
      const total = num(bill.total);
      if (!amountEquals(total, Math.abs(lineAmount))) continue;
      const ref = bill.dueDate ?? bill.issueDate ?? null;
      if (!ref) continue;
      if (daysApart(ref, line.txDate) > 5) continue;
      chosenBill = { id: bill.id };
      break;
    }
    if (chosenBill) {
      await prisma.reconciliationMatch.create({
        data: {
          bankAccountId: line.bankAccountId,
          bankLineId: line.id,
          matchType: "supplier_bill",
          matchedEntityId: chosenBill.id,
          amount: lineAmount,
          confidence: "auto_exact"
        }
      });
      await prisma.bankStatementLine.update({
        where: { id: line.id },
        data: { matchedTo: chosenBill.id }
      });
      usedBillIds.add(chosenBill.id);
      matched++;
      details.push({
        bankLineId: line.id,
        matched: true,
        matchType: "supplier_bill",
        matchedEntityId: chosenBill.id
      });
      continue;
    }

    details.push({ bankLineId: line.id, matched: false, reason: "needs_manual" });
  }

  // If everything is matched, flip the statement status.
  const allLines = await prisma.bankStatementLine.findMany({
    where: { statementId },
    select: { id: true }
  });
  const matchedNow = await prisma.reconciliationMatch.count({
    where: { bankLineId: { in: allLines.map((l) => l.id) } }
  });
  if (allLines.length > 0 && matchedNow === allLines.length) {
    await prisma.bankStatement.update({ where: { id: statementId }, data: { status: "reconciled" } });
  }

  return { statementId, scanned: lines.length, matched, alreadyMatched, details };
}

// ---- Manual match ----

export async function manualMatch(input: {
  bankLineId: string;
  matchType: "payment" | "supplier_bill" | "manual";
  matchedEntityId: string;
  userId?: string;
  notes?: string;
}) {
  const line = await prisma.bankStatementLine.findUnique({ where: { id: input.bankLineId } });
  if (!line) throw new Error(`Bank line ${input.bankLineId} not found.`);

  // bankLineId is UNIQUE — upsert on that.
  const existing = await prisma.reconciliationMatch.findUnique({
    where: { bankLineId: input.bankLineId }
  });

  const data = {
    bankAccountId: line.bankAccountId,
    bankLineId: input.bankLineId,
    matchType: input.matchType,
    matchedEntityId: input.matchedEntityId,
    amount: line.amount,
    confidence: "manual",
    matchedByUserId: input.userId ?? null,
    notes: input.notes ?? null
  };

  const match = existing
    ? await prisma.reconciliationMatch.update({ where: { bankLineId: input.bankLineId }, data })
    : await prisma.reconciliationMatch.create({ data });

  await prisma.bankStatementLine.update({
    where: { id: input.bankLineId },
    data: { matchedTo: input.matchedEntityId }
  });

  // Re-check statement status.
  await refreshStatementStatus(line.statementId);

  return {
    id: match.id,
    bankLineId: match.bankLineId,
    matchType: match.matchType,
    matchedEntityId: match.matchedEntityId,
    amount: Number(match.amount.toString()),
    confidence: match.confidence,
    matchedAt: match.matchedAt.toISOString()
  };
}

// ---- Unmatch ----

export async function unmatch(bankLineId: string) {
  const line = await prisma.bankStatementLine.findUnique({ where: { id: bankLineId } });
  if (!line) throw new Error(`Bank line ${bankLineId} not found.`);
  await prisma.reconciliationMatch.deleteMany({ where: { bankLineId } });
  await prisma.bankStatementLine.update({
    where: { id: bankLineId },
    data: { matchedTo: null }
  });
  await refreshStatementStatus(line.statementId);
  return { bankLineId, unmatched: true };
}

async function refreshStatementStatus(statementId: string) {
  const lines = await prisma.bankStatementLine.findMany({
    where: { statementId },
    select: { id: true }
  });
  if (lines.length === 0) return;
  const matchedCount = await prisma.reconciliationMatch.count({
    where: { bankLineId: { in: lines.map((l) => l.id) } }
  });
  await prisma.bankStatement.update({
    where: { id: statementId },
    data: { status: matchedCount === lines.length ? "reconciled" : "pending" }
  });
}

// ---- Status snapshot ----

export async function reconciliationStatus(bankAccountId: string) {
  const lines = await prisma.bankStatementLine.findMany({
    where: { bankAccountId },
    select: { id: true }
  });
  const totalLines = lines.length;
  if (totalLines === 0) {
    return { bankAccountId, totalLines: 0, matched: 0, unmatched: 0, percentage: 0 };
  }
  const matched = await prisma.reconciliationMatch.count({
    where: { bankLineId: { in: lines.map((l) => l.id) } }
  });
  const unmatched = totalLines - matched;
  const percentage = Math.round((matched / totalLines) * 1000) / 10;
  return { bankAccountId, totalLines, matched, unmatched, percentage };
}
