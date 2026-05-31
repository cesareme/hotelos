import type { LockAdapter, LockAdapterMode } from "./index.js";

/**
 * Assa Abloy Vingcard lock adapter.
 *
 * Vingcard (an Assa Abloy Global Solutions brand) is one of the most widely
 * deployed hotel locking systems. Production integrations talk to the
 * Vostio Access Management cloud and Vingcard Mobile Access SDKs to issue
 * Bluetooth-based mobile keys.
 *
 * Official documentation:
 *   - Assa Abloy Global Solutions: https://www.assaabloyglobalsolutions.com/
 *   - Vingcard:                    https://www.assaabloyglobalsolutions.com/en/solutions/products/vingcard
 *   - Vostio Access Management:    https://www.assaabloyglobalsolutions.com/en/solutions/products/vostio
 *
 * Required environment for production mode: `ASSA_ABLOY_VOSTIO_API_KEY`, `ASSA_ABLOY_PROPERTY_ID`.
 */
export class AssaAbloyLockAdapter implements LockAdapter {
  public readonly vendor = "assa-abloy" as const;
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
      const keyId = `demo_assa-abloy_${input.reservationId}`;
      return { keyId, deliveryQr: `demo://qr/${keyId}` };
    }
    throw new Error("Assa Abloy Vingcard production mode requires ASSA_ABLOY_VOSTIO_API_KEY env var");
  }

  async revokeKey(_keyId: string): Promise<{ revoked: boolean }> {
    if (this.mode === "sandbox") {
      return { revoked: true };
    }
    throw new Error("Assa Abloy Vingcard production mode requires ASSA_ABLOY_VOSTIO_API_KEY env var");
  }

  async listActiveKeys(_reservationId: string): Promise<Array<{ keyId: string; validUntil: string }>> {
    if (this.mode === "sandbox") {
      return [];
    }
    throw new Error("Assa Abloy Vingcard production mode requires ASSA_ABLOY_VOSTIO_API_KEY env var");
  }

  async healthCheck(): Promise<{ ok: boolean; vendor: string; mode: "sandbox" | "production"; errorMessage?: string }> {
    if (this.mode === "sandbox") {
      return { ok: true, vendor: "assa-abloy", mode: "sandbox" };
    }
    return {
      ok: false,
      vendor: "assa-abloy",
      mode: "production",
      errorMessage: "Assa Abloy Vingcard requires ASSA_ABLOY_VOSTIO_API_KEY env var"
    };
  }
}
