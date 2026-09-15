// Rate grid v2 · bridge to the channel outbox (lote channel-outbox).
//
// The grid never talks to an OTA adapter: publishing is asynchronous. The
// outbox module (apps/api/src/modules/channel-manager/delivery.service.ts)
// exports `enqueueRateGridPush` and `getCellSyncMap`; this bridge holds the
// contract the grid needs and a resolver that, when that module is not wired
// (parallel lots, or a build without it), falls back to a HONEST local
// implementation: the sync map is read straight from `ChannelDelivery` (the
// same table the outbox writes) and `enqueueRateGridPush` queues nothing and
// says so in `warnings`.
//
// Integrator: call `setRateGridOutbox({ enqueueRateGridPush, getCellSyncMap })`
// once at boot (or pass `{ outbox }` to registerRateGridRoutes) so the grid uses
// the real outbox without a dynamic import.

import { prisma } from "@hotelos/database";
import type { RateGridPushResponse } from "@hotelos/shared";
import { dayUtc } from "./bulk-ops.js";
import { mergeCellSync, type CellSyncMap } from "./rate-grid.merge.js";

export type RateGridPushKind = "rates" | "availability" | "restrictions";

export type EnqueueRateGridPushInput = {
  propertyId: string;
  from: string;
  to: string;
  channelIds: string[];
  kinds?: RateGridPushKind[];
  ratePlanIds?: string[];
  roomTypeIds?: string[];
  journalId?: string | null;
  actorUserId?: string;
};

export type RateGridOutbox = {
  enqueueRateGridPush(input: EnqueueRateGridPushInput): Promise<RateGridPushResponse>;
  getCellSyncMap(propertyId: string, from: string, to: string): Promise<CellSyncMap>;
};

/** Fallback used until the outbox module is wired (see file header). */
export const localOutboxFallback: RateGridOutbox = {
  async enqueueRateGridPush(input) {
    return {
      queued: 0,
      byChannel: Object.fromEntries(input.channelIds.map((id) => [id, { queued: 0, mode: "stub" as const, skippedUnmapped: 0 }])),
      warnings: ["outbox no disponible: el módulo channel-manager/delivery.service no está cableado; no se ha encolado nada"]
    };
  },
  async getCellSyncMap(propertyId, from, to) {
    const rows = await prisma.channelDelivery.findMany({
      where: { propertyId, kind: { in: ["rates", "restrictions"] }, date: { gte: dayUtc(from), lte: dayUtc(to) } },
      select: {
        id: true,
        channelId: true,
        kind: true,
        roomTypeId: true,
        ratePlanId: true,
        date: true,
        status: true,
        lastError: true,
        updatedAt: true,
        createdAt: true
      }
    });
    return mergeCellSync(rows);
  }
};

let configured: RateGridOutbox | null = null;
let resolving: Promise<RateGridOutbox> | null = null;

export function setRateGridOutbox(outbox: RateGridOutbox | null): void {
  configured = outbox;
  resolving = null;
}

/**
 * Resolve the outbox once: explicit configuration wins; otherwise try the
 * delivery module by a NON-literal specifier (so this file type-checks when
 * the module does not exist yet) and keep the fallback when it is missing or
 * does not export the two functions.
 */
export async function getRateGridOutbox(): Promise<RateGridOutbox> {
  if (configured) return configured;
  if (!resolving) {
    resolving = (async () => {
      const specifier = "../channel-manager/delivery.service.js";
      try {
        const mod = (await import(specifier)) as Partial<RateGridOutbox>;
        if (typeof mod.enqueueRateGridPush === "function" && typeof mod.getCellSyncMap === "function") {
          return { enqueueRateGridPush: mod.enqueueRateGridPush, getCellSyncMap: mod.getCellSyncMap };
        }
        return {
          enqueueRateGridPush: typeof mod.enqueueRateGridPush === "function" ? mod.enqueueRateGridPush : localOutboxFallback.enqueueRateGridPush,
          getCellSyncMap: typeof mod.getCellSyncMap === "function" ? mod.getCellSyncMap : localOutboxFallback.getCellSyncMap
        };
      } catch {
        // Honest catch: the module is simply not there (parallel lot) — the
        // fallback reports "outbox no disponible" instead of pretending.
        return localOutboxFallback;
      }
    })();
  }
  return resolving;
}
