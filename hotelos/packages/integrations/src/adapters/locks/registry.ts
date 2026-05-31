import type { LockAdapter, LockAdapterMode } from "./index.js";
import { SaltoLockAdapter } from "./salto.adapter.js";
import { AssaAbloyLockAdapter } from "./assa-abloy.adapter.js";
import { DormakabaLockAdapter } from "./dormakaba.adapter.js";
import { TesaLockAdapter } from "./tesa.adapter.js";

/**
 * Returns the lock adapter implementation for the given vendor string.
 *
 * Defaults to sandbox mode so the platform can be exercised end-to-end
 * without real SDK credentials. Pass `mode: "production"` to switch the
 * returned adapter into production behaviour, which will surface the
 * missing-SDK error contract documented on each adapter.
 *
 * @throws Error when an unknown vendor is requested.
 */
export function getLockAdapter(
  vendor: string,
  mode: LockAdapterMode = "sandbox"
): LockAdapter {
  switch (vendor) {
    case "salto":
      return new SaltoLockAdapter(mode);
    case "assa-abloy":
      return new AssaAbloyLockAdapter(mode);
    case "dormakaba":
      return new DormakabaLockAdapter(mode);
    case "tesa":
      return new TesaLockAdapter(mode);
    default:
      throw new Error(`Unknown lock vendor: ${vendor}`);
  }
}

export const SUPPORTED_LOCK_VENDORS = ["salto", "assa-abloy", "dormakaba", "tesa"] as const;
export type SupportedLockVendor = (typeof SUPPORTED_LOCK_VENDORS)[number];
