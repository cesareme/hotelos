/**
 * Common interface for hotel electronic lock vendor adapters.
 *
 * Each vendor adapter implements this contract, abstracting the differences
 * between Salto KS, Assa Abloy Vingcard, dormakaba ambiance, TESA SmartAir
 * and generic NFC providers. In sandbox mode, adapters return deterministic
 * stub data so the rest of the platform can be developed without real SDKs.
 */
export type LockAdapter = {
  vendor: "salto" | "assa-abloy" | "dormakaba" | "tesa" | "generic-nfc";
  issueKey(input: {
    reservationId: string;
    roomId: string;
    validFrom: string;
    validUntil: string;
    guestEmail?: string;
  }): Promise<{ keyId: string; deliveryUrl?: string; deliveryQr?: string }>;
  revokeKey(keyId: string): Promise<{ revoked: boolean }>;
  listActiveKeys(reservationId: string): Promise<Array<{ keyId: string; validUntil: string }>>;
  healthCheck(): Promise<{ ok: boolean; vendor: string; mode: "sandbox" | "production" }>;
};

export type LockAdapterMode = "sandbox" | "production";

export type LockHealthCheckResult =
  | { ok: true; vendor: string; mode: LockAdapterMode }
  | { ok: false; vendor: string; mode: LockAdapterMode; errorMessage: string };

export * from "./salto.adapter.js";
export * from "./assa-abloy.adapter.js";
export * from "./dormakaba.adapter.js";
export * from "./tesa.adapter.js";
export * from "./registry.js";
