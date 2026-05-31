import type { LockAdapter, LockAdapterMode } from "./index.js";

/**
 * dormakaba ambiance lock adapter.
 *
 * dormakaba's ambiance line covers RFID, BLE and mobile keys for hotels.
 * Production integrations interact with dormakaba Community / Saflok cloud
 * services and dormakaba Mobile Access SDKs.
 *
 * Official documentation:
 *   - dormakaba hospitality:    https://www.dormakaba.com/com-en/solutions/markets/hotels
 *   - dormakaba ambiance:       https://www.dormakaba.com/com-en/products-solutions/electronic-access-data/hospitality/ambiance
 *   - dormakaba Community:      https://www.dormakaba.com/com-en/products-solutions/services/dormakaba-community
 *
 * Required environment for production mode: `DORMAKABA_AMBIANCE_API_KEY`, `DORMAKABA_PROPERTY_CODE`.
 */
export class DormakabaLockAdapter implements LockAdapter {
  public readonly vendor = "dormakaba" as const;
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
      const keyId = `demo_dormakaba_${input.reservationId}`;
      return { keyId, deliveryQr: `demo://qr/${keyId}` };
    }
    throw new Error("dormakaba ambiance production mode requires DORMAKABA_AMBIANCE_API_KEY env var");
  }

  async revokeKey(_keyId: string): Promise<{ revoked: boolean }> {
    if (this.mode === "sandbox") {
      return { revoked: true };
    }
    throw new Error("dormakaba ambiance production mode requires DORMAKABA_AMBIANCE_API_KEY env var");
  }

  async listActiveKeys(_reservationId: string): Promise<Array<{ keyId: string; validUntil: string }>> {
    if (this.mode === "sandbox") {
      return [];
    }
    throw new Error("dormakaba ambiance production mode requires DORMAKABA_AMBIANCE_API_KEY env var");
  }

  async healthCheck(): Promise<{ ok: boolean; vendor: string; mode: "sandbox" | "production"; errorMessage?: string }> {
    if (this.mode === "sandbox") {
      return { ok: true, vendor: "dormakaba", mode: "sandbox" };
    }
    return {
      ok: false,
      vendor: "dormakaba",
      mode: "production",
      errorMessage: "dormakaba ambiance requires DORMAKABA_AMBIANCE_API_KEY env var"
    };
  }
}
