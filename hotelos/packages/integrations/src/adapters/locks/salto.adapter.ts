import type { LockAdapter, LockAdapterMode } from "./index.js";

/**
 * Salto KS lock adapter.
 *
 * Salto KS is a cloud-based access control platform from Salto Systems.
 * Production integrations use the Salto KS API to issue and revoke
 * digital keys distributed via the Salto JustIN Mobile app.
 *
 * Official documentation:
 *   - Salto KS:        https://saltoks.com/
 *   - Salto KS API:    https://saltoks.com/api/
 *   - Salto JustIN:    https://saltosystems.com/en/products/access-control/justin-mobile/
 *
 * Required environment for production mode: `SALTO_KS_CLIENT_ID`, `SALTO_KS_CLIENT_SECRET`.
 */
export class SaltoLockAdapter implements LockAdapter {
  public readonly vendor = "salto" as const;
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
      const keyId = `demo_salto_${input.reservationId}`;
      return { keyId, deliveryQr: `demo://qr/${keyId}` };
    }
    throw new Error("Salto KS production mode requires SALTO_KS_CLIENT_ID env var");
  }

  async revokeKey(_keyId: string): Promise<{ revoked: boolean }> {
    if (this.mode === "sandbox") {
      return { revoked: true };
    }
    throw new Error("Salto KS production mode requires SALTO_KS_CLIENT_ID env var");
  }

  async listActiveKeys(_reservationId: string): Promise<Array<{ keyId: string; validUntil: string }>> {
    if (this.mode === "sandbox") {
      return [];
    }
    throw new Error("Salto KS production mode requires SALTO_KS_CLIENT_ID env var");
  }

  async healthCheck(): Promise<{ ok: boolean; vendor: string; mode: "sandbox" | "production"; errorMessage?: string }> {
    if (this.mode === "sandbox") {
      return { ok: true, vendor: "salto", mode: "sandbox" };
    }
    return {
      ok: false,
      vendor: "salto",
      mode: "production",
      errorMessage: "Salto KS requires SALTO_KS_CLIENT_ID env var"
    };
  }
}
