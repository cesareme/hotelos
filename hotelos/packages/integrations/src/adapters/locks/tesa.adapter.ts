import type { LockAdapter, LockAdapterMode } from "./index.js";

/**
 * TESA SmartAir lock adapter.
 *
 * TESA Assa Abloy's SmartAir is a wireless online/offline access control
 * system common in Spanish and southern European hotels. Production
 * integrations use the SmartAir TS1000 management software API and the
 * SmartAir Openow mobile credential service.
 *
 * Official documentation:
 *   - TESA SmartAir:           https://www.tesa.es/en/smartair
 *   - SmartAir TS1000:         https://www.tesa.es/en/smartair/ts1000
 *   - SmartAir Openow mobile:  https://www.tesa.es/en/smartair/openow
 *
 * Required environment for production mode: `TESA_SMARTAIR_API_KEY`, `TESA_SMARTAIR_SITE_ID`.
 */
export class TesaLockAdapter implements LockAdapter {
  public readonly vendor = "tesa" as const;
  private readonly mode: LockAdapterMode;

  constructor(mode: LockAdapterMode = "sandbox") {
    this.mode = mode;
  }

  async issueKey(input: {
    reservationId: string;
    roomId: string;
    validFrom: string;
    validUntil: string;
    guestEmail?: string;
  }): Promise<{ keyId: string; deliveryUrl?: string; deliveryQr?: string }> {
    if (this.mode === "sandbox") {
      const keyId = `demo_tesa_${input.reservationId}`;
      return { keyId, deliveryQr: `demo://qr/${keyId}` };
    }
    throw new Error("TESA SmartAir production mode requires TESA_SMARTAIR_API_KEY env var");
  }

  async revokeKey(_keyId: string): Promise<{ revoked: boolean }> {
    if (this.mode === "sandbox") {
      return { revoked: true };
    }
    throw new Error("TESA SmartAir production mode requires TESA_SMARTAIR_API_KEY env var");
  }

  async listActiveKeys(_reservationId: string): Promise<Array<{ keyId: string; validUntil: string }>> {
    if (this.mode === "sandbox") {
      return [];
    }
    throw new Error("TESA SmartAir production mode requires TESA_SMARTAIR_API_KEY env var");
  }

  async healthCheck(): Promise<{ ok: boolean; vendor: string; mode: "sandbox" | "production"; errorMessage?: string }> {
    if (this.mode === "sandbox") {
      return { ok: true, vendor: "tesa", mode: "sandbox" };
    }
    return {
      ok: false,
      vendor: "tesa",
      mode: "production",
      errorMessage: "TESA SmartAir requires TESA_SMARTAIR_API_KEY env var"
    };
  }
}
