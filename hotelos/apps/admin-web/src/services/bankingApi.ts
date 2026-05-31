// Frontend client for Banking España endpoints (P2-3).
import { apiRequest } from "./api-client";

export type Csb43ImportResult = {
  accounts: Array<{
    bankCode: string;
    branchCode: string;
    accountNumber: string;
    fromDate: string;
    toDate: string;
    currency: string;
    initialBalance: number;
    finalBalance: number;
    movements: Array<{
      operationDate: string;
      valueDate: string;
      conceptCode: string;
      amount: number;
      descriptions: string[];
      referenceA: string | null;
      referenceB: string | null;
      runningBalance: number;
    }>;
    matches: Array<{ movementIndex: number; paymentId: string; confidence: "high" | "medium" | "low"; reason: string }>;
    unmatchedMovementIdxs: number[];
  }>;
  unmatchedPayments: string[];
};

export type SepaResult = {
  messageId: string;
  xml: string;
  totalAmount: number;
  transactions: number;
  warnings: string[];
};

export function importCsb43(propertyId: string, content: string): Promise<Csb43ImportResult> {
  return apiRequest(`/properties/${propertyId}/banking/csb43/import`, { method: "POST", body: { content } });
}

export function generateSepaRemittance(payload: unknown): Promise<SepaResult> {
  return apiRequest("/banking/sepa/remittances", { method: "POST", body: payload });
}

export function validateIban(iban: string): Promise<{ valid: boolean; iban: string }> {
  return apiRequest("/banking/iban/validate", { method: "POST", body: { iban } });
}
