// Frontend client for Banking España endpoints (P2-3).
//
// Finanzas · Tanda 6 (lote nav-services): the CSB43 import is persisted and
// answers the shared `Csb43ImportResult` (packages/shared/src/treasury-types.ts):
// per account `statementId`, `persisted`, `newLines`, `duplicateLines`,
// `warnings` and `matches[].matchType`. The body may pin the bank account,
// skip auto-matching or refuse to create an unknown account. Line-level
// reconciliation and SEPA remittances with status live in treasuryApi.ts.
import type { Csb43ImportAccount, Csb43ImportResult, SepaNorma19Request, SepaNorma34Request } from "@hotelos/shared";
import { apiRequest } from "./api-client";

export type { Csb43ImportAccount, Csb43ImportResult } from "@hotelos/shared";

export type SepaResult = {
  messageId: string;
  xml: string;
  totalAmount: number;
  transactions: number;
  warnings: string[];
};

export type Csb43ImportOptions = {
  /** Pin the statement to a known bank account instead of matching by IBAN. */
  bankAccountId?: string | null;
  /** Default true: suggest payment / settlement matches for every new line. */
  autoMatch?: boolean;
  /** Default true: create the bank account when the IBAN of the file is unknown. */
  createMissingAccount?: boolean;
};

export function importCsb43(propertyId: string, content: string, options: Csb43ImportOptions = {}): Promise<Csb43ImportResult> {
  return apiRequest(`/properties/${propertyId}/banking/csb43/import`, { method: "POST", body: { content, ...options } });
}

/** Legacy one-shot generator (no persisted status); treasuryApi.createSepaRemittance keeps the remittance with its state. */
export function generateSepaRemittance(payload: SepaNorma19Request | SepaNorma34Request | unknown): Promise<SepaResult> {
  return apiRequest("/banking/sepa/remittances", { method: "POST", body: payload });
}

export function validateIban(iban: string): Promise<{ valid: boolean; iban: string }> {
  return apiRequest("/banking/iban/validate", { method: "POST", body: { iban } });
}
