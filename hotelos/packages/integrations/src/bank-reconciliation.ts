export type BankTransaction = {
  id: string;
  amount: number;
  currency: string;
  counterparty?: string;
};

export type ReconciliationCandidate = {
  id: string;
  sourceType: "reservation" | "folio" | "payment" | "supplier_bill" | "invoice";
  amount: number;
  currency: string;
  reference: string;
};

export type ReconciliationMatch = ReconciliationCandidate & {
  confidence: number;
  reason: string;
};

export function suggestBankTransactionMatches(
  transaction: BankTransaction,
  candidates: ReconciliationCandidate[]
): ReconciliationMatch[] {
  return candidates
    .filter((candidate) => candidate.currency === transaction.currency)
    .map((candidate) => {
      const amountDelta = Math.abs(candidate.amount - transaction.amount);
      const confidence = amountDelta === 0 ? 0.97 : Math.max(0.35, 0.9 - amountDelta / Math.max(transaction.amount, 1));
      return {
        ...candidate,
        confidence: Number(confidence.toFixed(2)),
        reason: amountDelta === 0 ? "Exact amount and currency match." : "Partial amount and currency match."
      };
    })
    .filter((match) => match.confidence >= 0.5)
    .sort((a, b) => b.confidence - a.confidence);
}
