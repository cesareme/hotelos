// Channel lifecycle for the rate grid v2 (lote api-channel-outbox).
//
// Owns the Channel row from the editor's point of view: list for the grid
// header (RateGridChannel), create/patch, credentials (write-only), test,
// reservation pull and the webhook secret check. Everything that talks to a
// provider goes through `toChannelContext()` so the adapters receive the
// DECRYPTED credentials and the EFFECTIVE mode (Channel.mode capped by
// CHANNEL_MAX_MODE) and never touch the database.
//
// Credentials at rest: `Channel.credentialsEncrypted` is a JSON string
// registered in PII_FIELDS (packages/database/src/crypto-fields.ts), so the
// Prisma extension AES-GCM-encrypts it on write and decrypts it on read. The
// API NEVER returns it: GET answers `hasCredentials` + the key names.
// Read-side migration: channels created by the v1 aggregator kept credentials
// in `configurationJson.credentials` (plaintext). When credentialsEncrypted is
// empty we still honour that blob, flag it (`legacyPlaintextCredentials`) and
// the seed / PATCH …/credentials move it. Debt, tracked in readiness.
// Undecryptable envelope (encryption key rotated without a backfill): the
// Prisma extension leaves the ciphertext untouched, the channel reads as "no
// credentials" (every push fails closed) and `undecryptable` tells readiness
// WHY, so the operator re-saves the credentials instead of hunting a ghost.
//
// Lifecycle: `DELETE /channel-manager/channels/:id` is a LOGICAL delete
// (`status: archived`): the editor list hides the channel, its deliveries and
// sync jobs stay as history, and creating the same provider again revives the
// row. Refused while deliveries are still pending (queued / sending / timeout).
// Every change of `mode` is audited (CHANNEL_MODE_CHANGED): switching to `real`
// is the go-live switch, it must leave a trace with the actor.

import { createHmac, timingSafeEqual } from "node:crypto";
import { isCiphertext, prisma } from "@hotelos/database";
import type { Prisma } from "@hotelos/database";
import type { ChannelMode as SharedChannelMode, RateGridChannel } from "@hotelos/shared";
import { BadRequestError, ConflictError, NotFoundError } from "../../lib/http-error.js";
import { recordAuditEvent } from "../audit/audit.service.js";
import type { ChannelContext, ChannelMode, ChannelProviderCode, SimulatorOptions } from "./adapter.types.js";
import { listProviderCodes, normalizeProviderCode, resolveAdapter } from "./adapters/index.js";
import { readChannelEnv } from "./env.partial.js";
import { readinessForGrid } from "./readiness.core.js";

/** Status of a logically deleted channel: hidden from the editor, deliveries and sync jobs kept as history. */
export const ARCHIVED_CHANNEL_STATUS = "archived";

/** Who performs a channel change (audit trail); absent for scripts. */
export type ChannelActor = { userId?: string; correlationId?: string };

export type ChannelRow = Prisma.ChannelGetPayload<Record<string, never>>;

const MODE_RANK: Record<ChannelMode, number> = { stub: 0, sandbox: 1, real: 2 };

export function parseChannelMode(value: unknown): ChannelMode {
  return value === "real" || value === "sandbox" ? value : "stub";
}

/** Channel.mode capped by CHANNEL_MAX_MODE (env). */
export function effectiveChannelMode(channelMode: unknown): ChannelMode {
  const wanted = parseChannelMode(channelMode);
  const max = readChannelEnv().maxMode;
  return MODE_RANK[wanted] > MODE_RANK[max] ? max : wanted;
}

export function unsupportedProviderError(providerCode: string): BadRequestError {
  return new BadRequestError(`Proveedor de canal no soportado: ${providerCode}. Válidos: ${listProviderCodes().join(", ")}.`);
}

/** Channel.channelType for a providerCode (same vocabulary as the revenue dashboards). */
export function channelTypeFor(providerCode: string): string {
  switch (normalizeProviderCode(providerCode) ?? providerCode.toLowerCase()) {
    case "hotelbeds":
      return "wholesaler";
    case "airbnb":
    case "vrbo":
      return "vacation_rental";
    case "channex":
      return "aggregator";
    case "google_hotels_mock":
      return "metasearch";
    case "direct_booking_engine":
      return "direct";
    case "manual_channel":
      return "manual";
    default:
      return "ota";
  }
}

function parseJsonObject(raw: unknown): Record<string, unknown> | null {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (typeof raw !== "string" || raw.trim() === "") return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    // Honest failure mode: an undecryptable envelope (key rotated without a
    // backfill) reads as "no credentials" instead of crashing every push.
    return null;
  }
}

export function readChannelCredentials(row: Pick<ChannelRow, "credentialsEncrypted" | "configurationJson">): {
  credentials: Record<string, unknown> | null;
  legacy: boolean;
  /** The stored blob is still an encryption envelope after the read: the current key cannot open it. */
  undecryptable: boolean;
} {
  const undecryptable = isCiphertext(row.credentialsEncrypted);
  const encrypted = undecryptable ? null : parseJsonObject(row.credentialsEncrypted);
  if (encrypted && Object.keys(encrypted).length > 0) return { credentials: encrypted, legacy: false, undecryptable: false };
  const config = parseJsonObject(row.configurationJson) ?? {};
  const legacy = parseJsonObject(config.credentials);
  if (legacy && Object.keys(legacy).length > 0) return { credentials: legacy, legacy: true, undecryptable };
  return { credentials: null, legacy: false, undecryptable };
}

function simulatorOptions(credentials: Record<string, unknown> | null): SimulatorOptions | undefined {
  const sim = credentials && parseJsonObject(credentials.simulator);
  if (!sim) return undefined;
  const out: SimulatorOptions = {};
  if (typeof sim.failEvery === "number" && sim.failEvery >= 0) out.failEvery = Math.floor(sim.failEvery);
  if (typeof sim.latencyMs === "number" && sim.latencyMs >= 0) out.latencyMs = Math.floor(sim.latencyMs);
  return out;
}

function externalPropertyCode(credentials: Record<string, unknown> | null): string | null {
  if (!credentials) return null;
  for (const key of ["hotelId", "hotel_id", "hotelCode", "propertyId", "property_id", "resortID", "resortId"]) {
    const v = credentials[key];
    if (typeof v === "string" && v.length > 0) return v;
    if (typeof v === "number") return String(v);
  }
  return null;
}

export function toChannelContext(row: Pick<ChannelRow, "id" | "propertyId" | "providerCode" | "mode" | "credentialsEncrypted" | "configurationJson">): ChannelContext {
  const { credentials, legacy } = readChannelCredentials(row);
  return {
    id: row.id,
    propertyId: row.propertyId,
    providerCode: (normalizeProviderCode(row.providerCode) ?? row.providerCode) as ChannelProviderCode,
    mode: effectiveChannelMode(row.mode),
    credentials,
    externalPropertyCode: externalPropertyCode(credentials),
    ...(simulatorOptions(credentials) ? { simulator: simulatorOptions(credentials) } : {}),
    ...(legacy ? { legacyPlaintextCredentials: true } : {})
  };
}

export async function channelOrThrow(channelId: string): Promise<ChannelRow> {
  const channel = await prisma.channel.findUnique({ where: { id: channelId } });
  if (!channel) throw new NotFoundError("Canal no encontrado.");
  return channel;
}

// ---------------------------------------------------------------- sync jobs

export async function logSyncJob(input: {
  propertyId: string;
  channelId: string | null;
  syncType: string;
  status: "success" | "partial" | "failed" | "queued";
  startedAt: Date;
  finishedAt: Date;
  errorMessage?: string;
  requestPayload?: Record<string, unknown>;
  responsePayload?: Record<string, unknown>;
  idempotencyKey?: string;
  dateRange?: { from: string; to: string };
}): Promise<{ id: string }> {
  const job = await prisma.channelSyncJob.create({
    data: {
      propertyId: input.propertyId,
      channelId: input.channelId,
      syncType: input.syncType,
      status: input.status,
      startedAt: input.startedAt,
      finishedAt: input.finishedAt,
      errorMessage: input.errorMessage ?? null,
      idempotencyKey: input.idempotencyKey ?? null,
      dateRangeStart: input.dateRange ? new Date(`${input.dateRange.from}T00:00:00Z`) : null,
      dateRangeEnd: input.dateRange ? new Date(`${input.dateRange.to}T00:00:00Z`) : null,
      requestPayloadJson: (input.requestPayload ?? {}) as Prisma.InputJsonValue,
      responsePayloadJson: (input.responsePayload ?? {}) as Prisma.InputJsonValue
    }
  });
  return { id: job.id };
}

// ---------------------------------------------------------------- readiness summary (light)

// The summary text lives in readiness.core.ts (pure, tested there) so the
// grid header and the readiness checklist word the sandbox mode the same way.
export { readinessForGrid };

// ---------------------------------------------------------------- listing

export async function listRateGridChannels(propertyId: string): Promise<RateGridChannel[]> {
  const channels = await prisma.channel.findMany({ where: { propertyId, status: { not: ARCHIVED_CHANNEL_STATUS } }, orderBy: [{ createdAt: "asc" }] });
  if (channels.length === 0) return [];
  const counts = await prisma.channelProductMapping.groupBy({
    by: ["channelId"],
    where: { channelId: { in: channels.map((c) => c.id) }, status: "active" },
    _count: { _all: true }
  });
  const mapped = new Map(counts.map((c) => [c.channelId, c._count._all] as const));
  return channels.map((c) => toRateGridChannel(c, mapped.get(c.id) ?? 0));
}

export function toRateGridChannel(c: ChannelRow, mappedProducts: number): RateGridChannel {
  const mode = effectiveChannelMode(c.mode);
  const { credentials } = readChannelCredentials(c);
  const readiness = readinessForGrid({
    status: c.status,
    mode,
    hasCredentials: credentials !== null,
    mappedProducts,
    hasAdapter: resolveAdapter(c.providerCode) !== null
  });
  return {
    id: c.id,
    providerCode: c.providerCode,
    name: c.name,
    channelType: c.channelType,
    status: c.status,
    mode: mode as SharedChannelMode,
    markupPercent: c.defaultMarkupPercent !== null ? Number(c.defaultMarkupPercent) : 0,
    mappedProducts,
    lastSyncAt: c.lastSyncAt ? c.lastSyncAt.toISOString() : null,
    readyToPush: readiness.readyToPush,
    readinessSummary: readiness.summary
  };
}

export type ChannelDetail = RateGridChannel & {
  propertyId: string;
  requestedMode: ChannelMode;
  maxMode: ChannelMode;
  autoPushOnSave: boolean;
  commissionPercent: number | null;
  hasCredentials: boolean;
  credentialKeys: string[];
  legacyPlaintextCredentials: boolean;
  /** Credentials are stored but the current encryption key cannot open them: re-save them. */
  credentialsUndecryptable: boolean;
  createdAt: string;
};

export async function getChannelDetail(channelId: string): Promise<ChannelDetail> {
  const c = await channelOrThrow(channelId);
  const mappedProducts = await prisma.channelProductMapping.count({ where: { channelId, status: "active" } });
  const { credentials, legacy, undecryptable } = readChannelCredentials(c);
  return {
    ...toRateGridChannel(c, mappedProducts),
    propertyId: c.propertyId,
    requestedMode: parseChannelMode(c.mode),
    maxMode: readChannelEnv().maxMode,
    autoPushOnSave: c.autoPushOnSave,
    commissionPercent: c.commissionPercent !== null ? Number(c.commissionPercent) : null,
    hasCredentials: credentials !== null,
    credentialKeys: credentials ? Object.keys(credentials).filter((k) => k !== "simulator").sort() : [],
    legacyPlaintextCredentials: legacy,
    credentialsUndecryptable: undecryptable,
    createdAt: c.createdAt.toISOString()
  };
}

async function auditChannelChange(channel: Pick<ChannelRow, "id" | "propertyId">, action: string, actor: ChannelActor | undefined, beforeJson: unknown, afterJson: unknown): Promise<void> {
  const property = await prisma.property.findUnique({ where: { id: channel.propertyId }, select: { organizationId: true } });
  if (!property) return;
  recordAuditEvent({
    organizationId: property.organizationId,
    propertyId: channel.propertyId,
    actorUserId: actor?.userId,
    actorType: actor?.userId ? "user" : "system",
    action,
    entityType: "channel",
    entityId: channel.id,
    beforeJson,
    afterJson,
    correlationId: actor?.correlationId
  });
}

// ---------------------------------------------------------------- create / patch

export type CreateChannelInput = {
  propertyId: string;
  providerCode: string;
  name: string;
  mode?: ChannelMode;
  status?: "active" | "inactive";
  defaultMarkupPercent?: number | null;
  autoPushOnSave?: boolean;
  credentials?: Record<string, unknown> | null;
};

export async function createChannel(input: CreateChannelInput): Promise<ChannelDetail> {
  const normalized = normalizeProviderCode(input.providerCode);
  if (!normalized || !resolveAdapter(input.providerCode)) throw unsupportedProviderError(input.providerCode);
  // Stored code: keep the caller's alias (the seed uses `booking_com`, the
  // legacy hub `booking`) so existing rows and dashboards keep matching.
  const providerCode = input.providerCode.trim().toLowerCase();
  const existing = await prisma.channel.findUnique({ where: { propertyId_providerCode: { propertyId: input.propertyId, providerCode } }, select: { id: true, status: true } });
  if (existing && existing.status !== ARCHIVED_CHANNEL_STATUS) {
    throw new ConflictError(`Ya existe un canal ${providerCode} en esta propiedad.`, { code: "CHANNEL_PROVIDER_EXISTS", channelId: existing.id });
  }
  if (existing) {
    // (propertyId, providerCode) is unique: an archived channel of the same
    // provider is revived with the new settings (its history stays attached).
    await prisma.channel.update({
      where: { id: existing.id },
      data: {
        name: input.name.trim(),
        status: input.status ?? "inactive",
        mode: input.mode ?? "stub",
        defaultMarkupPercent: input.defaultMarkupPercent ?? null,
        autoPushOnSave: input.autoPushOnSave ?? false,
        ...(input.credentials !== undefined ? { credentialsEncrypted: input.credentials && Object.keys(input.credentials).length > 0 ? JSON.stringify(input.credentials) : null } : {}),
        lastSyncAt: null
      }
    });
    return getChannelDetail(existing.id);
  }
  const created = await prisma.channel.create({
    data: {
      propertyId: input.propertyId,
      providerCode,
      name: input.name.trim(),
      channelType: channelTypeFor(providerCode),
      status: input.status ?? "inactive",
      mode: input.mode ?? "stub",
      defaultMarkupPercent: input.defaultMarkupPercent ?? null,
      autoPushOnSave: input.autoPushOnSave ?? false,
      credentialsEncrypted: input.credentials && Object.keys(input.credentials).length > 0 ? JSON.stringify(input.credentials) : null
    }
  });
  return getChannelDetail(created.id);
}

export type PatchChannelInput = {
  name?: string;
  mode?: ChannelMode;
  status?: string;
  defaultMarkupPercent?: number | null;
  autoPushOnSave?: boolean;
};

export async function patchChannel(channelId: string, patch: PatchChannelInput, actor?: ChannelActor): Promise<ChannelDetail> {
  const channel = await channelOrThrow(channelId);
  const data: Prisma.ChannelUpdateInput = {};
  if (patch.name !== undefined) data.name = patch.name.trim();
  if (patch.mode !== undefined) data.mode = patch.mode;
  if (patch.status !== undefined) data.status = patch.status;
  if (patch.defaultMarkupPercent !== undefined) data.defaultMarkupPercent = patch.defaultMarkupPercent;
  if (patch.autoPushOnSave !== undefined) data.autoPushOnSave = patch.autoPushOnSave;
  if (Object.keys(data).length > 0) await prisma.channel.update({ where: { id: channelId }, data });
  if (patch.mode !== undefined && patch.mode !== parseChannelMode(channel.mode)) {
    // The requested mode is persisted as asked (CHANNEL_MAX_MODE caps it at run
    // time — documented double key); the change itself is what the trail keeps.
    await auditChannelChange(channel, "CHANNEL_MODE_CHANGED", actor, { mode: parseChannelMode(channel.mode) }, { mode: patch.mode, effectiveMode: effectiveChannelMode(patch.mode), maxMode: readChannelEnv().maxMode });
  }
  return getChannelDetail(channelId);
}

export type ArchiveChannelResult = { id: string; providerCode: string; status: typeof ARCHIVED_CHANNEL_STATUS; keptDeliveries: number };

/**
 * Logical delete. History (deliveries, sync jobs, external reservations)
 * is kept; the channel disappears from the editor and cannot push. Refused
 * (409 CHANNEL_HAS_PENDING_DELIVERIES) while rows are still queued / in flight /
 * waiting for a retry, so an archive never orphans a publish in progress.
 */
export async function archiveChannel(channelId: string, actor?: ChannelActor): Promise<ArchiveChannelResult> {
  const channel = await channelOrThrow(channelId);
  const keptDeliveries = await prisma.channelDelivery.count({ where: { channelId } });
  if (channel.status === ARCHIVED_CHANNEL_STATUS) return { id: channel.id, providerCode: channel.providerCode, status: ARCHIVED_CHANNEL_STATUS, keptDeliveries };
  const pending = await prisma.channelDelivery.count({ where: { channelId, status: { in: ["queued", "sending", "timeout"] } } });
  if (pending > 0) {
    throw new ConflictError("El canal tiene entregas pendientes de envío: espere al drenaje o reintente más tarde antes de archivarlo.", { code: "CHANNEL_HAS_PENDING_DELIVERIES", pending });
  }
  await prisma.channel.update({ where: { id: channelId }, data: { status: ARCHIVED_CHANNEL_STATUS, autoPushOnSave: false } });
  await auditChannelChange(channel, "CHANNEL_ARCHIVED", actor, { status: channel.status }, { status: ARCHIVED_CHANNEL_STATUS, keptDeliveries });
  return { id: channel.id, providerCode: channel.providerCode, status: ARCHIVED_CHANNEL_STATUS, keptDeliveries };
}

/** Write-only: replaces the whole credential blob (merge=true keeps unknown keys). */
export async function setChannelCredentials(channelId: string, credentials: Record<string, unknown>, options: { merge?: boolean } = {}): Promise<ChannelDetail> {
  const channel = await channelOrThrow(channelId);
  const current = options.merge ? readChannelCredentials(channel).credentials ?? {} : {};
  const next = { ...current, ...credentials };
  for (const [k, v] of Object.entries(credentials)) if (v === null) delete next[k];
  const config = parseJsonObject(channel.configurationJson) ?? {};
  if ("credentials" in config) delete config.credentials; // legacy plaintext blob retired on first write
  await prisma.channel.update({
    where: { id: channelId },
    data: {
      credentialsEncrypted: Object.keys(next).length > 0 ? JSON.stringify(next) : null,
      configurationJson: config as Prisma.InputJsonValue
    }
  });
  return getChannelDetail(channelId);
}

// ---------------------------------------------------------------- test

export async function testChannel(channelId: string) {
  const channel = await channelOrThrow(channelId);
  const adapter = resolveAdapter(channel.providerCode);
  if (!adapter) throw unsupportedProviderError(channel.providerCode);
  const context = toChannelContext(channel);
  const startedAt = new Date();
  const result = await adapter.testCredentials({ channel: context });
  const finishedAt = new Date();
  await logSyncJob({
    propertyId: channel.propertyId,
    channelId: channel.id,
    syncType: "test_credentials",
    status: result.ok ? "success" : "failed",
    startedAt,
    finishedAt,
    errorMessage: result.ok ? undefined : result.error,
    responsePayload: { ok: result.ok, mode: context.mode, metadata: result.metadata ?? null, error: result.error ?? null }
  });
  if (result.ok) await prisma.channel.update({ where: { id: channel.id }, data: { lastSyncAt: finishedAt } });
  return { channelId: channel.id, providerCode: channel.providerCode, mode: context.mode, ...result };
}

// ---------------------------------------------------------------- reservations pull

/**
 * Pulls the provider's reservations into the ExternalReservation inbox (no
 * PMS Reservation is created, see the P2 note below). In stub/sandbox every
 * adapter fabricates 0-3 deterministic reservations per pull (keyed on the
 * channel, `since` and the provider — adapters/stub-utils.ts), so a pull
 * triggered by the hub button or by an authenticated webhook on such a
 * channel DOES add simulated rows («Stub Guest N») and a pull_reservations
 * sync job; only mode `real` reads a feed. Documented in runbook §1.8.
 */
export async function pullChannelReservations(input: { channelId: string; since?: Date }) {
  const channel = await channelOrThrow(input.channelId);
  const adapter = resolveAdapter(channel.providerCode);
  if (!adapter) throw unsupportedProviderError(channel.providerCode);
  const context = toChannelContext(channel);
  const config = parseJsonObject(channel.configurationJson) ?? {};
  const cursor = typeof config.pullCursor === "string" ? config.pullCursor : null;
  const since = input.since ?? channel.lastSyncAt ?? new Date(Date.now() - 24 * 60 * 60 * 1000);
  const startedAt = new Date();
  const pulled = await adapter.pullReservations({ channel: context, since, cursor });
  const finishedAt = new Date();

  let imported = 0;
  const importedIds: string[] = [];
  if (pulled.ok) {
    for (const r of pulled.reservations) {
      const payload = r.payloadJson;
      const arrival = typeof payload.arrivalDate === "string" ? new Date(payload.arrivalDate) : null;
      const departure = typeof payload.departureDate === "string" ? new Date(payload.departureDate) : null;
      // P2: no PMS Reservation is created here — ExternalReservation is the
      // inbox the front reconciles; creating Reservation rows needs product
      // mapping in reverse plus guest/folio rules (out of this lote).
      await prisma.externalReservation.upsert({
        where: { propertyId_externalReservationId: { propertyId: channel.propertyId, externalReservationId: r.externalReference } },
        update: { status: r.status, channelId: channel.id, payloadJson: payload as Prisma.InputJsonValue },
        create: {
          propertyId: channel.propertyId,
          channelId: channel.id,
          externalReservationId: r.externalReference,
          status: r.status,
          guestName: typeof payload.guestName === "string" ? payload.guestName : null,
          arrivalDate: arrival && !Number.isNaN(arrival.getTime()) ? arrival : null,
          departureDate: departure && !Number.isNaN(departure.getTime()) ? departure : null,
          payloadJson: payload as Prisma.InputJsonValue
        }
      });
      imported++;
      importedIds.push(r.externalReference);
    }
    if (adapter.acknowledgeReservations && importedIds.length > 0) {
      const ack = await adapter.acknowledgeReservations({ channel: context, ids: importedIds });
      if (!ack.ok) pulled.errors = [...(pulled.errors ?? []), ...(ack.errors ?? ["ack failed"])];
    }
  }

  await logSyncJob({
    propertyId: channel.propertyId,
    channelId: channel.id,
    syncType: "pull_reservations",
    status: pulled.ok ? "success" : "failed",
    startedAt,
    finishedAt,
    errorMessage: pulled.errors?.join("; "),
    requestPayload: { since: since.toISOString(), cursor },
    responsePayload: { ok: pulled.ok, imported, nextCursor: pulled.nextCursor, mode: context.mode }
  });
  if (pulled.ok) {
    await prisma.channel.update({
      where: { id: channel.id },
      data: {
        lastSyncAt: finishedAt,
        configurationJson: { ...config, pullCursor: pulled.nextCursor ?? null } as Prisma.InputJsonValue
      }
    });
  }
  return { channelId: channel.id, providerCode: channel.providerCode, mode: context.mode, ok: pulled.ok, imported, nextCursor: pulled.nextCursor, errors: pulled.errors ?? [] };
}

// ---------------------------------------------------------------- webhook secret

/**
 * Verifies an inbound provider webhook: `X-Anfitorio-Webhook-Secret: <secret>`
 * (constant-time compare) or `X-Anfitorio-Signature: sha256=<hex HMAC of body>`.
 * The secret lives in the channel credentials (`webhookSecret`). No secret →
 * every webhook is refused (fail closed). The payload is never trusted: the
 * caller only triggers a pull.
 */
export function verifyWebhookSecret(channel: Pick<ChannelRow, "credentialsEncrypted" | "configurationJson">, headers: Record<string, unknown>, rawBody: string): boolean {
  const { credentials } = readChannelCredentials(channel);
  const secret = credentials?.webhookSecret ?? credentials?.webhook_secret;
  if (typeof secret !== "string" || secret.length === 0) return false;
  const header = (name: string): string | null => {
    const v = headers[name];
    return typeof v === "string" ? v : Array.isArray(v) && typeof v[0] === "string" ? v[0] : null;
  };
  const plain = header("x-anfitorio-webhook-secret");
  if (plain !== null) return safeEqual(plain, secret);
  const sig = header("x-anfitorio-signature");
  if (sig !== null) {
    const expected = `sha256=${createHmac("sha256", secret).update(rawBody, "utf8").digest("hex")}`;
    return safeEqual(sig, expected);
  }
  return false;
}

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}
