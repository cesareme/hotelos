// Sandbox channels seed (rate grid v2 · lote api-channel-outbox).
//
// Creates, for ONE property, the three channels the editor demo needs —
// booking_com («Booking.com»), expedia («Expedia») and channex («Channex ·
// agregador») — in mode `sandbox` with SIMULATION credentials (encrypted at
// rest through the Prisma field-encryption extension: Channel.credentialsEncrypted
// is in PII_FIELDS) and one ChannelProductMapping per (active room type × BAR
// rate plan) with deterministic external codes:
//   booking_com  BK-<roomCode> / RP-<planCode>
//   expedia      EX-<roomCode> / RP-<planCode>
//   channex      CX-<roomCode> / RP-<planCode>-<roomCode>
// Channex addresses ARI by rate_plan_id, and on Channex a rate plan belongs
// to ONE room type: the placeholder rate code is therefore unique per room
// type there (a shared RP-<plan> across 4 types would make only the last
// price of a batch apply once real ids replace the placeholders; readiness
// flags shared codes as `product_codes`). Booking / Expedia address by
// (InvTypeCode, RatePlanCode) so a shared plan code is correct for them.
// It also moves any legacy plaintext `configurationJson.credentials` of the
// property's channels into credentialsEncrypted (read-side debt of
// channels.service).
//
// Usage (from apps/api, DATABASE_URL in env or ../../.env):
//   corepack pnpm --filter @hotelos/api channels:seed-sandbox -- --property <propertyId> [--dry-run]
//   corepack pnpm --filter @hotelos/api channels:seed-sandbox -- --property <propertyId> --apply --confirm <propertyId> [--json]
//
// Idempotent: existing channels keep their credentials (only filled when
// missing) and are only moved to sandbox/active when they are stub/inactive;
// mappings are upserted by (channel, roomType, ratePlan) and left untouched
// when the codes already match. A re-run reports 0 changes.
//
// Exit codes: 0 ok · 1 failure (property missing, DB error) · 2 flags.

import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { resolve as resolvePath } from "node:path";
import { prisma } from "@hotelos/database";
import type { Prisma } from "@hotelos/database";
import { readChannelCredentials } from "../modules/channel-manager/channels.service.js";
import { productKey } from "../modules/channel-manager/delivery.core.js";

export const CORRELATION_ID = "corr_channels_seed_sandbox";
export const SYSTEM_USER_ID = "usr_system_channels_seed";

export type SandboxChannelSpec = {
  providerCode: "booking_com" | "expedia" | "channex";
  name: string;
  channelType: string;
  roomPrefix: string;
  credentials: (propertyId: string, webhookSecret: string) => Record<string, unknown>;
};

export const SANDBOX_CHANNELS: readonly SandboxChannelSpec[] = [
  {
    providerCode: "booking_com",
    name: "Booking.com",
    channelType: "ota",
    roomPrefix: "BK",
    credentials: (propertyId, webhookSecret) => ({
      client_id: `sandbox-client-${propertyId.slice(-6)}`,
      client_secret: "sandbox-secret",
      hotelId: `SBX-${propertyId.slice(-6).toUpperCase()}`,
      webhookSecret,
      simulator: { failEvery: 0, latencyMs: 0 }
    })
  },
  {
    providerCode: "expedia",
    name: "Expedia",
    channelType: "ota",
    roomPrefix: "EX",
    credentials: (propertyId, webhookSecret) => ({
      username: `EQC-sandbox-${propertyId.slice(-6)}`,
      password: "sandbox",
      hotelId: `SBX-${propertyId.slice(-6).toUpperCase()}`,
      webhookSecret,
      simulator: { failEvery: 0, latencyMs: 0 }
    })
  },
  {
    providerCode: "channex",
    name: "Channex · agregador",
    channelType: "aggregator",
    roomPrefix: "CX",
    credentials: (propertyId, webhookSecret) => ({
      apiKey: "sandbox-user-api-key",
      propertyId: `sbx-${propertyId.slice(-6)}`,
      webhookSecret,
      simulator: { failEvery: 0, latencyMs: 0 }
    })
  }
];

export type SeedFlags = { propertyId: string; apply: boolean; confirm: string[]; json: boolean };

export function parseFlags(argv: readonly string[]): SeedFlags {
  const flags: SeedFlags = { propertyId: "", apply: false, confirm: [], json: false };
  let sawDryRun = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dry-run") sawDryRun = true;
    else if (arg === "--apply") flags.apply = true;
    else if (arg === "--json") flags.json = true;
    else if (arg === "--property" || arg === "--confirm") {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("--")) throw new Error(`Flag "${arg}" requires a property id.`);
      if (arg === "--property") flags.propertyId = v;
      else flags.confirm.push(v);
      i++;
    } else if (arg === "--") continue;
    else throw new Error(`Unknown flag "${arg}". Known: --property <propertyId>, --dry-run, --apply, --confirm <propertyId>, --json.`);
  }
  if (!flags.propertyId) throw new Error("--property <propertyId> is required.");
  if (sawDryRun && flags.apply) throw new Error("--dry-run and --apply are mutually exclusive.");
  if (flags.apply && !flags.confirm.includes(flags.propertyId)) throw new Error("--apply requires --confirm <propertyId> naming the same property.");
  return flags;
}

export type SeedChange =
  | { entity: "channel"; providerCode: string; action: "create" | "activate" | "set-mode" | "fill-credentials" | "migrate-legacy-credentials"; detail: string }
  | { entity: "mapping"; providerCode: string; action: "create" | "update"; detail: string };

export type SeedSummary = {
  dryRun: boolean;
  propertyId: string;
  propertyName: string | null;
  roomTypes: number;
  barRatePlans: number;
  changes: SeedChange[];
  applied: boolean;
  error?: string;
  durationMs: number;
};

export function isBarPlan(plan: { code: string; ratePlanType: string }): boolean {
  return plan.ratePlanType.toLowerCase() === "bar" || plan.code.toUpperCase() === "BAR" || plan.code.toUpperCase().startsWith("BAR-");
}

/**
 * Placeholder external rate code of a sandbox mapping. Channex needs it
 * unique per room type (`RP-<plan>-<room>`, see header); Booking / Expedia
 * key by (room, plan) and keep the shared `RP-<plan>`.
 */
export function sandboxRateCode(providerCode: SandboxChannelSpec["providerCode"], planCode: string, roomCode: string): string {
  return providerCode === "channex" ? `RP-${planCode}-${roomCode}` : `RP-${planCode}`;
}

export async function runSeed(flags: SeedFlags): Promise<SeedSummary> {
  const start = Date.now();
  const summary: SeedSummary = { dryRun: !flags.apply, propertyId: flags.propertyId, propertyName: null, roomTypes: 0, barRatePlans: 0, changes: [], applied: false, durationMs: 0 };
  const property = await prisma.property.findUnique({ where: { id: flags.propertyId }, select: { id: true, name: true, organizationId: true } });
  if (!property) {
    summary.error = "propiedad no encontrada";
    summary.durationMs = Date.now() - start;
    return summary;
  }
  summary.propertyName = property.name;
  const [roomTypes, ratePlans, channels, mappings] = await Promise.all([
    prisma.roomType.findMany({ where: { propertyId: property.id, active: true }, select: { id: true, code: true }, orderBy: { displayOrder: "asc" } }),
    prisma.ratePlan.findMany({ where: { propertyId: property.id, active: true }, select: { id: true, code: true, ratePlanType: true } }),
    prisma.channel.findMany({ where: { propertyId: property.id } }),
    prisma.channelProductMapping.findMany({ where: { propertyId: property.id } })
  ]);
  const barPlans = ratePlans.filter(isBarPlan);
  summary.roomTypes = roomTypes.length;
  summary.barRatePlans = barPlans.length;
  const mappingByChannel = new Map<string, Map<string, (typeof mappings)[number]>>();
  for (const m of mappings) {
    const byProduct = mappingByChannel.get(m.channelId) ?? new Map();
    byProduct.set(productKey(m.roomTypeId, m.ratePlanId), m);
    mappingByChannel.set(m.channelId, byProduct);
  }

  type ChannelOp = { spec: SandboxChannelSpec; existing: (typeof channels)[number] | null; credentials: Record<string, unknown> | null; setMode: boolean; activate: boolean; legacyMigrate: Record<string, unknown> | null };
  const ops: ChannelOp[] = [];
  for (const spec of SANDBOX_CHANNELS) {
    const existing = channels.find((c) => c.providerCode === spec.providerCode) ?? null;
    const op: ChannelOp = { spec, existing, credentials: null, setMode: false, activate: false, legacyMigrate: null };
    if (!existing) {
      op.credentials = spec.credentials(property.id, randomBytes(16).toString("hex"));
      summary.changes.push({ entity: "channel", providerCode: spec.providerCode, action: "create", detail: `${spec.name} · mode sandbox · status active · credenciales de simulación cifradas` });
    } else {
      const { credentials, legacy } = readChannelCredentials(existing);
      if (credentials && legacy) {
        op.legacyMigrate = credentials;
        summary.changes.push({ entity: "channel", providerCode: spec.providerCode, action: "migrate-legacy-credentials", detail: "configurationJson.credentials → credentialsEncrypted" });
      } else if (!credentials) {
        op.credentials = spec.credentials(property.id, randomBytes(16).toString("hex"));
        summary.changes.push({ entity: "channel", providerCode: spec.providerCode, action: "fill-credentials", detail: "sin credenciales → credenciales de simulación cifradas" });
      }
      if (existing.mode === "stub") {
        op.setMode = true;
        summary.changes.push({ entity: "channel", providerCode: spec.providerCode, action: "set-mode", detail: "mode stub → sandbox" });
      }
      if (existing.status !== "active") {
        op.activate = true;
        summary.changes.push({ entity: "channel", providerCode: spec.providerCode, action: "activate", detail: `status ${existing.status} → active` });
      }
    }
    ops.push(op);
  }
  // Legacy plaintext credentials on OTHER channels of the property (debt migration).
  const otherLegacy = channels
    .filter((c) => !SANDBOX_CHANNELS.some((s) => s.providerCode === c.providerCode))
    .map((c) => ({ channel: c, read: readChannelCredentials(c) }))
    .filter((x) => x.read.legacy && x.read.credentials);
  for (const x of otherLegacy) {
    summary.changes.push({ entity: "channel", providerCode: x.channel.providerCode, action: "migrate-legacy-credentials", detail: "configurationJson.credentials → credentialsEncrypted" });
  }

  type MappingOp = { spec: SandboxChannelSpec; roomTypeId: string; ratePlanId: string; externalRoomCode: string; externalRateCode: string; existingId: string | null };
  const mappingOps: MappingOp[] = [];
  for (const op of ops) {
    const byProduct = op.existing ? mappingByChannel.get(op.existing.id) ?? new Map() : new Map();
    for (const rt of roomTypes) {
      for (const rp of barPlans) {
        const externalRoomCode = `${op.spec.roomPrefix}-${rt.code}`;
        const externalRateCode = sandboxRateCode(op.spec.providerCode, rp.code, rt.code);
        const current = byProduct.get(productKey(rt.id, rp.id));
        if (current && current.externalRoomCode === externalRoomCode && current.externalRateCode === externalRateCode && current.status === "active") continue;
        mappingOps.push({ spec: op.spec, roomTypeId: rt.id, ratePlanId: rp.id, externalRoomCode, externalRateCode, existingId: current?.id ?? null });
        summary.changes.push({
          entity: "mapping",
          providerCode: op.spec.providerCode,
          action: current ? "update" : "create",
          detail: `${rt.code} × ${rp.code} → ${externalRoomCode} / ${externalRateCode}`
        });
      }
    }
  }

  if (!flags.apply || summary.changes.length === 0) {
    summary.durationMs = Date.now() - start;
    return summary;
  }

  const audit = await import("../modules/audit/audit.service.js");
  await audit.hydrateAuditChainFromPostgres();
  try {
    const channelIdByProvider = new Map<string, string>();
    await prisma.$transaction(async (tx) => {
      for (const op of ops) {
        if (!op.existing) {
          const created = await tx.channel.create({
            data: {
              propertyId: property.id,
              providerCode: op.spec.providerCode,
              name: op.spec.name,
              channelType: op.spec.channelType,
              status: "active",
              mode: "sandbox",
              autoPushOnSave: false,
              credentialsEncrypted: JSON.stringify(op.credentials)
            }
          });
          channelIdByProvider.set(op.spec.providerCode, created.id);
          continue;
        }
        channelIdByProvider.set(op.spec.providerCode, op.existing.id);
        const data: Prisma.ChannelUpdateInput = {};
        if (op.setMode) data.mode = "sandbox";
        if (op.activate) data.status = "active";
        if (op.credentials) data.credentialsEncrypted = JSON.stringify(op.credentials);
        if (op.legacyMigrate) {
          data.credentialsEncrypted = JSON.stringify(op.legacyMigrate);
          const config = { ...((op.existing.configurationJson as Record<string, unknown> | null) ?? {}) };
          delete config.credentials;
          data.configurationJson = config as Prisma.InputJsonValue;
        }
        if (Object.keys(data).length > 0) await tx.channel.update({ where: { id: op.existing.id }, data });
      }
      for (const x of otherLegacy) {
        const config = { ...((x.channel.configurationJson as Record<string, unknown> | null) ?? {}) };
        delete config.credentials;
        await tx.channel.update({ where: { id: x.channel.id }, data: { credentialsEncrypted: JSON.stringify(x.read.credentials), configurationJson: config as Prisma.InputJsonValue } });
      }
      for (const m of mappingOps) {
        const channelId = channelIdByProvider.get(m.spec.providerCode);
        if (!channelId) continue;
        await tx.channelProductMapping.upsert({
          where: { channelId_roomTypeId_ratePlanId: { channelId, roomTypeId: m.roomTypeId, ratePlanId: m.ratePlanId } },
          update: { externalRoomCode: m.externalRoomCode, externalRateCode: m.externalRateCode, pricingModel: "per_day", status: "active" },
          create: { propertyId: property.id, channelId, roomTypeId: m.roomTypeId, ratePlanId: m.ratePlanId, externalRoomCode: m.externalRoomCode, externalRateCode: m.externalRateCode, pricingModel: "per_day", status: "active" }
        });
      }
    });
    summary.applied = true;
    audit.recordAuditEvent({
      organizationId: property.organizationId,
      propertyId: property.id,
      actorUserId: SYSTEM_USER_ID,
      actorType: "system",
      action: "CHANNEL_SANDBOX_SEEDED",
      entityType: "channel",
      afterJson: {
        channels: SANDBOX_CHANNELS.map((s) => s.providerCode),
        changes: summary.changes.length,
        mappings: mappingOps.length
      },
      correlationId: CORRELATION_ID
    });
  } catch (error) {
    summary.error = error instanceof Error ? error.message : String(error);
  }
  await audit.flushAuditQueues();
  summary.durationMs = Date.now() - start;
  return summary;
}

export function printHuman(summary: SeedSummary): void {
  const lines = [`[channels:seed-sandbox] ${summary.dryRun ? "DRY-RUN (no writes)" : "APPLIED"} · ${summary.durationMs} ms`];
  lines.push(`  propiedad ${summary.propertyId}${summary.propertyName ? ` (${summary.propertyName})` : ""}: ${summary.roomTypes} tipos activos × ${summary.barRatePlans} planes BAR`);
  if (summary.error) lines.push(`  ERROR ${summary.error}`);
  if (summary.changes.length === 0) lines.push("  sin cambios (ya sembrado)");
  for (const c of summary.changes) lines.push(`  ${c.entity} ${c.providerCode} · ${c.action}: ${c.detail}`);
  if (summary.dryRun) lines.push(`  Nada escrito. Repite con --apply --confirm ${summary.propertyId}. Reinicia el API después si tenía la lista de canales en memoria.`);
  console.log(lines.join("\n"));
}

const entryFile = resolvePath(fileURLToPath(import.meta.url));
const argFile = process.argv[1] ? resolvePath(process.argv[1]) : "";
if (entryFile === argFile) {
  let flags: SeedFlags;
  try {
    flags = parseFlags(process.argv.slice(2));
  } catch (error) {
    console.error(`[channels:seed-sandbox] ${(error as Error).message}`);
    process.exit(2);
  }
  runSeed(flags)
    .then(async (summary) => {
      if (flags.json) console.log(JSON.stringify(summary, null, 2));
      else printHuman(summary);
      await prisma.$disconnect();
      return summary.error ? 1 : 0;
    })
    .then((code) => process.exit(code))
    .catch(async (error) => {
      console.error("[channels:seed-sandbox] failed:", error);
      await prisma.$disconnect().catch(() => undefined);
      process.exit(1);
    });
}
