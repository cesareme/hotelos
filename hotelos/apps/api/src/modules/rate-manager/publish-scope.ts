// Rate grid v2 · scope of the publish that follows a bulk-update (pure).
//
// Before this (cierre 2026-09-15, browser-ux#8) `bulk-update` with `publish`
// enqueued the whole window × every room type × every plan × every kind: one
// edited cell became 8+ deliveries per channel. The outbox already accepts
// `roomTypeIds` / `ratePlanIds` / `kinds` (RateGridPushRequest), so the
// service derives them from the patches it just wrote:
//   · roomTypeIds = the types the patches touch;
//   · ratePlanIds = the plans the patches touch plus the ACTIVE derived
//     children of a patched parent (a BAR write re-materialises BAR-NR, whose
//     rates must travel too); a room-level ("*") restriction applies to every
//     plan's product, so it lifts the plan filter;
//   · kinds = what the fields imply: a price-side field (or a derivation
//     trigger) → rates; `available` → availability; `restrictions` →
//     restrictions, and `stopSell` also availability (the outbox sends 0 for a
//     stop-sold night, so the availability delivery must be refreshed).
// Unchanged products are harmless anyway (the outbox de-duplicates by payload
// hash) — the point is not to fan out to products nobody edited.

import type { RateGridPushKind } from "./channel-outbox.bridge.js";

export type PublishScopePatch = {
  ratePlanId: string;
  roomTypeId: string;
  price?: number | null;
  occupancyPrices?: Record<string, number> | null;
  minPrice?: number | null;
  maxPrice?: number | null;
  restrictions?: Record<string, unknown> | null;
  available?: number | null;
  convertToManual?: boolean;
  revertToDerived?: boolean;
  rematerializeOnly?: boolean;
  restoreSource?: string;
};

export type PublishScope = {
  roomTypeIds: string[];
  /** Undefined = every plan (a room-level restriction touches every product). */
  ratePlanIds: string[] | undefined;
  /** Empty when no field of any patch reaches a channel (nothing to publish). */
  kinds: RateGridPushKind[];
};

const KIND_ORDER: RateGridPushKind[] = ["rates", "availability", "restrictions"];
const STAR = "*";

export function touchesRates(patch: PublishScopePatch): boolean {
  return (
    patch.price !== undefined ||
    patch.occupancyPrices !== undefined ||
    patch.minPrice !== undefined ||
    patch.maxPrice !== undefined ||
    Boolean(patch.convertToManual) ||
    Boolean(patch.revertToDerived) ||
    Boolean(patch.rematerializeOnly) ||
    patch.restoreSource !== undefined
  );
}

/**
 * Derive (roomTypeIds, ratePlanIds, kinds) from the patches of ONE write.
 * `childrenOf` is the catalogue's parent → active children map so the
 * materialised children of a patched parent are published as well.
 */
export function derivePushScope(patches: PublishScopePatch[], childrenOf: Map<string, Array<{ id: string }>>): PublishScope {
  const roomTypeIds = new Set<string>();
  const ratePlanIds = new Set<string>();
  const kinds = new Set<RateGridPushKind>();
  let everyPlan = false;
  for (const patch of patches) {
    roomTypeIds.add(patch.roomTypeId);
    const restrictionKeys = patch.restrictions ? Object.keys(patch.restrictions) : [];
    if (patch.ratePlanId === STAR) {
      // Room-level row: restrictions there apply to every plan's product.
      if (restrictionKeys.length > 0) everyPlan = true;
    } else {
      ratePlanIds.add(patch.ratePlanId);
      for (const child of childrenOf.get(patch.ratePlanId) ?? []) ratePlanIds.add(child.id);
    }
    if (touchesRates(patch) && patch.ratePlanId !== STAR) kinds.add("rates");
    if (patch.available !== undefined) kinds.add("availability");
    if (restrictionKeys.length > 0) {
      kinds.add("restrictions");
      if (restrictionKeys.includes("stopSell")) kinds.add("availability");
    }
  }
  return {
    roomTypeIds: [...roomTypeIds].sort(),
    ratePlanIds: everyPlan ? undefined : [...ratePlanIds].sort(),
    kinds: KIND_ORDER.filter((k) => kinds.has(k))
  };
}
