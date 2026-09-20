// Cerraduras y llave móvil del kiosco / portal (Tanda CHK · lote W3-C; diseño
// §2.4 «llaves, modelos (b) BLE y (c) Wallet»).
//
// Contrato + dos implementaciones sin proveedor:
//   · noneLock — provider "none": issueMobileKey() responde
//     { status: "unavailable", message: KEY_PICKUP_MESSAGE } y revoke() → false.
//     Sin proveedor configurado la llave se entrega en recepción, sin fingir.
//   · sandboxLock(provider) — emite llaves deterministas `sandbox_<provider>_<id>`
//     con un QR de demo (`demo://key/<keyId>`) y recuerda las emitidas para que
//     revoke() sea honesto: true solo si la llave existía y seguía activa.
//     Solo se resuelve con mode "sandbox" (adapters/index.ts).
//
// Puente con packages/integrations/src/adapters/locks/* (LockAdapter con
// issueKey/revokeKey/listActiveKeys/healthCheck, vendors salto | assa-abloy |
// dormakaba | tesa | generic-nfc y getLockAdapter(vendor, mode) en registry.ts):
// ese paquete NO se importa desde apps/api (no es dependencia de
// apps/api/package.json; diseño §2.4 [V grep]) y sus sandbox (`demo_salto_<id>`)
// hacen lo mismo que sandboxLock, así que no se duplican. Cuando César aporte
// un proveedor real: (1) añadir @hotelos/integrations a apps/api; (2) escribir
// `fromIntegrationsLock(adapter)` que mapee issueMobileKey({ reservationId,
// roomNumber, validFrom, validUntil }) → adapter.issueKey({ reservationId,
// roomId, validFrom, validUntil }) y revoke(keyId) → adapter.revokeKey(keyId);
// (3) resolverlo en index.ts por lockProvider con mode "production". El
// contrato de este fichero no cambia.

import { assertValidityWindow } from "./card-encoder.adapter.js";

export const LOCK_PROVIDERS = ["none", "salto_space", "assa_vostio", "dormakaba"] as const;
export type LockProvider = (typeof LOCK_PROVIDERS)[number];

/** Mensaje que ve el huésped cuando no hay llave móvil. */
export const KEY_PICKUP_MESSAGE = "Recoge tu llave en recepción.";

export type MobileKeyInput = {
  reservationId: string;
  roomNumber: string;
  /** Inicio de validez (ISO 8601). */
  validFrom: string;
  /** Fin de validez (ISO 8601); posterior a validFrom. */
  validUntil: string;
};

export type MobileKeyResult =
  | { status: "issued"; provider: Exclude<LockProvider, "none">; keyId: string; deliveryQr: string; roomNumber: string; validUntil: string; issuedAt: string }
  | { status: "unavailable"; provider: LockProvider; message: string };

export type LockAdapter = {
  provider: LockProvider;
  issueMobileKey(input: MobileKeyInput): Promise<MobileKeyResult>;
  /** true solo si la llave existía y estaba activa. */
  revoke(keyId: string): Promise<{ revoked: boolean }>;
};

function assertKeyInput(input: MobileKeyInput): void {
  if (typeof input.reservationId !== "string" || input.reservationId.length === 0) throw new Error("reservationId vacío.");
  if (typeof input.roomNumber !== "string" || input.roomNumber.trim().length === 0) throw new Error("Número de habitación vacío.");
  assertValidityWindow(input);
}

/** Sin proveedor de cerraduras: la llave se entrega en recepción. */
export const noneLock: LockAdapter = Object.freeze({
  provider: "none" as const,
  issueMobileKey: async (input: MobileKeyInput): Promise<MobileKeyResult> => {
    assertKeyInput(input);
    return { status: "unavailable", provider: "none", message: KEY_PICKUP_MESSAGE };
  },
  revoke: async () => ({ revoked: false })
});

export type SandboxLockDeps = {
  now?: () => Date;
  nextId?: () => string;
};

/** Cerradura de demo: llaves `sandbox_…` con QR de demo; revoca solo lo que emitió. */
export function sandboxLock(provider: Exclude<LockProvider, "none"> = "salto_space", deps: SandboxLockDeps = {}): LockAdapter & { activeKeys(): readonly string[] } {
  const now = deps.now ?? (() => new Date());
  let counter = 0;
  const nextId = deps.nextId ?? (() => String(++counter).padStart(4, "0"));
  const active = new Set<string>();
  return {
    provider,
    activeKeys: () => [...active],
    issueMobileKey: async (input) => {
      assertKeyInput(input);
      const keyId = `sandbox_${provider}_${nextId()}`;
      active.add(keyId);
      return { status: "issued", provider, keyId, deliveryQr: `demo://key/${keyId}`, roomNumber: input.roomNumber, validUntil: input.validUntil, issuedAt: now().toISOString() };
    },
    revoke: async (keyId) => ({ revoked: active.delete(keyId) })
  };
}
