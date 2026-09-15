// Go-live readiness checklist for a channel (rate grid v2).
//
// Before a hotelier flips a channel to `real`, they need one honest answer to
// "is this safe to publish?". The outbox fails at drain time when mappings or
// credentials are missing — this surfaces those gaps ahead of time.
//
// Checks:
//   (a) mode         — Channel.mode capped by CHANNEL_MAX_MODE. real = ok,
//                      sandbox = warn (validated locally, not live), stub = error
//                      for go-live (nothing leaves the box). The requested mode
//                      being higher than the cap is reported explicitly.
//   (b) credentials  — Channel.credentialsEncrypted present with the provider's
//                      required keys (stub: not required). Legacy plaintext
//                      credentials in configurationJson are a warn (debt).
//   (c) products     — ChannelProductMapping coverage over
//                      (active room types × distributable rate plans).
//   (d) last delivery — most recent ChannelDelivery confirmed (7 days), or a
//                      successful test_credentials sync job.
//   (e) adapter      — provider registered (Channex-routed providers cannot go
//                      real on their own: warn pointing at Channex).
//   (f) product codes — external codes shared by several room types of the
//                      channel (mapping.core.ts): a ROOM code on every
//                      provider (availability — and, on Booking / Expedia,
//                      prices — go by room, so two types would overwrite each
//                      other), a RATE code only on Channex-routed ones (a
//                      Channex rate plan belongs to ONE room type). Warn in
//                      stub/sandbox (seeded placeholders), error in real mode
//                      (only the last value of a batch would apply).
//
// The shape keeps the fields the admin-web hub renders (checks[], readyToGoLive,
// adapterMode) and adds the v2 ones.

import { prisma } from "@hotelos/database";
import type { ChannelMode } from "./adapter.types.js";
import { isDirectProvider, normalizeProviderCode, resolveAdapter } from "./adapters/index.js";
import { channelOrThrow, effectiveChannelMode, parseChannelMode, readChannelCredentials } from "./channels.service.js";
import { readChannelEnv } from "./env.partial.js";
import { productCoverage, sharedChannelProductCodes, type ProductCoverage } from "./mapping.service.js";
import { credentialsCheck as credentialsCheckCore, modeCheck, productCodesCheck, recentSuccessCheck, type ReadinessCheck, type ReadinessCheckStatus } from "./readiness.core.js";

export type { ReadinessCheck, ReadinessCheckStatus };
export { modeCheck };

/** Kept for callers that pass the raw providerCode (the core takes the normalised one). */
export function credentialsCheck(providerCode: string, credentials: Record<string, unknown> | null, legacy: boolean, mode: ChannelMode, undecryptable = false): ReadinessCheck {
  return credentialsCheckCore(normalizeProviderCode(providerCode), credentials, legacy, mode, undecryptable);
}

export type ChannelReadiness = {
  channelId: string;
  providerCode: string;
  /** Effective mode (capped). Kept under the v1 name for the hub screen. */
  adapterMode: ChannelMode;
  requestedMode: ChannelMode;
  maxMode: ChannelMode;
  hasCredentials: boolean;
  coverage: Pick<ProductCoverage, "productsTotal" | "productsMapped" | "coveragePct" | "complete">;
  lastConfirmedDeliveryAt: string | null;
  checks: ReadinessCheck[];
  /** Every check ok: safe to publish in mode real. */
  readyToGoLive: boolean;
  /** No error-level check for the CURRENT mode: the editor can enqueue. */
  readyToPush: boolean;
};

export async function channelReadiness(channelId: string): Promise<ChannelReadiness> {
  const channel = await channelOrThrow(channelId);
  const requestedMode = parseChannelMode(channel.mode);
  const effective = effectiveChannelMode(channel.mode);
  const maxMode = readChannelEnv().maxMode;
  const { credentials, legacy, undecryptable } = readChannelCredentials(channel);
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const [coverage, lastConfirmed, recentTest, sharedCodes] = await Promise.all([
    productCoverage(channelId),
    prisma.channelDelivery.findFirst({ where: { channelId, status: "confirmed" }, orderBy: { confirmedAt: "desc" }, select: { confirmedAt: true, kind: true } }),
    prisma.channelSyncJob.findFirst({ where: { channelId, status: "success", createdAt: { gte: sevenDaysAgo } }, orderBy: { createdAt: "desc" }, select: { syncType: true, createdAt: true } }),
    sharedChannelProductCodes(channelId)
  ]);
  const adapter = resolveAdapter(channel.providerCode);
  const direct = isDirectProvider(channel.providerCode);

  const checks: ReadinessCheck[] = [
    modeCheck(requestedMode, effective, maxMode),
    credentialsCheck(channel.providerCode, credentials, legacy, effective, undecryptable),
    {
      key: "product_mappings",
      label: "Productos mapeados",
      status: coverage.productsTotal === 0 ? "error" : coverage.complete ? "ok" : coverage.productsMapped > 0 ? "warn" : "error",
      detail:
        coverage.productsTotal === 0
          ? "No hay tipos activos × planes distribuibles que mapear."
          : `${coverage.productsMapped}/${coverage.productsTotal} productos (tipo × plan) mapeados (${coverage.coveragePct} %).`
    },
    recentSuccessCheck({
      lastConfirmed: lastConfirmed?.confirmedAt ? { kind: lastConfirmed.kind, confirmedAt: lastConfirmed.confirmedAt } : null,
      recentTest: recentTest ? { syncType: recentTest.syncType, createdAt: recentTest.createdAt } : null
    }),
    {
      key: "adapter",
      label: "Adaptador",
      status: !adapter ? "error" : direct ? "ok" : effective === "real" ? "error" : "warn",
      detail: !adapter
        ? "Proveedor sin adaptador registrado."
        : direct
          ? `Adaptador ${normalizeProviderCode(channel.providerCode)} en modo ${effective}.`
          : "Este proveedor se distribuye vía Channex: cree un canal channex y conecte la OTA allí; en stub/sandbox se simula localmente."
    },
    productCodesCheck({ providerCode: channel.providerCode, mode: effective, shared: sharedCodes })
  ];
  const hasError = checks.some((c) => c.status === "error");
  return {
    channelId,
    providerCode: channel.providerCode,
    adapterMode: effective,
    requestedMode,
    maxMode,
    hasCredentials: credentials !== null,
    coverage: { productsTotal: coverage.productsTotal, productsMapped: coverage.productsMapped, coveragePct: coverage.coveragePct, complete: coverage.complete },
    lastConfirmedDeliveryAt: lastConfirmed?.confirmedAt ? lastConfirmed.confirmedAt.toISOString() : null,
    checks,
    readyToGoLive: checks.every((c) => c.status === "ok"),
    readyToPush: !hasError || (effective === "stub" && coverage.productsMapped > 0 && Boolean(adapter))
  };
}
