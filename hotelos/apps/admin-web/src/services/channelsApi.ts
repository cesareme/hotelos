// Frontend client for the rate grid v2 channel layer (channel-manager module):
// channel CRUD + credentials, connection test, product mappings (roomType ×
// ratePlan → external codes), the delivery outbox and the drain job.
//
// Every call goes through `apiRequest` (tests/admin-web-no-raw-fetch.test.mjs).
//
// Real routes (apps/api/src/modules/channel-manager/channel-manager.routes.ts).
// Only the editor list hangs from the property; everything else is addressed
// by channel id (tenancy: `assertEntityAccess({ entity: "channel" })`):
//   GET    /properties/:id/channels                                   → { channels: RateGridChannel[], providers }
//   POST   /channel-manager/channels                                  { propertyId, providerCode, name, mode?, status?, defaultMarkupPercent?, autoPushOnSave?, credentials? }
//   GET    /channel-manager/channels/:channelId                       → ChannelDetail
//   PATCH  /channel-manager/channels/:channelId                       { name?, mode?, status?, defaultMarkupPercent?, autoPushOnSave? } (strict)
//   DELETE /channel-manager/channels/:channelId                       logical archive (status "archived", history kept);
//                                                                     409 CHANNEL_HAS_PENDING_DELIVERIES while deliveries are queued/in flight
//   PATCH  /channel-manager/channels/:channelId/credentials           { credentials, merge? } (write-only)
//   POST   /channel-manager/channels/:channelId/test
//   GET    /channel-manager/channels/:channelId/product-mappings      → { mappings }
//   POST   /channel-manager/channels/:channelId/product-mappings      ONE mapping (upsert by roomType+ratePlan)
//   DELETE /channel-manager/product-mappings/:id
//   POST   /channel-manager/channels/:channelId/product-mappings/migrate-legacy
//   GET    /channel-manager/channels/:channelId/product-coverage
//   GET    /channel-manager/channels/:channelId/readiness-v2
//   GET    /channel-manager/deliveries?propertyId&channelId&status&kind&from&to&limit&cursor
//   GET    /channel-manager/deliveries/:id
//   POST   /channel-manager/deliveries/:id/retry
//   POST   /channel-manager/deliveries/drain                          { channelId?, limit? } (permiso distribution.sync)
import { apiRequest } from "./api-client";
import { toArray } from "../utils/toArray";
import type { CellSyncStatus, ChannelMode, RateGridChannel } from "@hotelos/shared";

export type { ChannelMode, RateGridChannel };

/** Provider catalogue offered by the "Alta de canal" form (providerCode → label). */
export const CHANNEL_PROVIDER_CATALOG: ReadonlyArray<{
  code: string;
  label: string;
  channelType: "ota" | "aggregator" | "direct";
  /** Honest note shown next to the option. */
  note: string;
}> = [
  {
    code: "channex",
    label: "Channex (agregador)",
    channelType: "aggregator",
    note: "Vía realista a Booking/Expedia: API REST con sandbox self-service."
  },
  {
    code: "booking_com",
    label: "Booking.com (directo)",
    channelType: "ota",
    note: "Adaptador contract-ready validado contra simulador; Booking tiene pausadas las altas de nuevos proveedores."
  },
  {
    code: "expedia",
    label: "Expedia (EQC)",
    channelType: "ota",
    note: "Adaptador contract-ready (EQC AR XML) validado contra simulador local."
  },
  { code: "airbnb", label: "Airbnb", channelType: "ota", note: "Solo modo stub/sandbox." },
  { code: "hotelbeds", label: "Hotelbeds", channelType: "ota", note: "Solo modo stub/sandbox." },
  { code: "vrbo", label: "Vrbo", channelType: "ota", note: "Solo modo stub/sandbox." }
];

// Long labels of the mode <select>s live next to `channelModeLabel` (same
// vocabulary: «Simulado…», «Modo de pruebas…», «Real…»); re-exported here so
// the hub keeps one import for the channel API surface.
export { CHANNEL_MODE_LABELS } from "../components/cocoa-rate-grid/helpers";

/**
 * Channel row as the hub needs it. The property list returns the bare
 * `RateGridChannel`; the detail routes (GET/POST/PATCH by id) add the admin
 * fields (`ChannelDetail` in channels.service.ts).
 */
export type ChannelAdminRow = RateGridChannel & {
  propertyId?: string;
  /** Mode stored on the channel; `mode` is the EFFECTIVE one after the CHANNEL_MAX_MODE cap. */
  requestedMode?: ChannelMode;
  /** Cap applied by the instance (env CHANNEL_MAX_MODE). */
  maxMode?: ChannelMode;
  autoPushOnSave?: boolean;
  commissionPercent?: number | null;
  /** Credentials are write-only: the API only reports whether they exist (detail routes only). */
  hasCredentials?: boolean;
  credentialKeys?: string[];
  legacyPlaintextCredentials?: boolean;
  /** Credentials are stored but the current encryption key cannot open them (key rotated): re-save them. */
  credentialsUndecryptable?: boolean;
  createdAt?: string | null;
};

export type CreateChannelInput = {
  propertyId: string;
  providerCode: string;
  name: string;
  mode?: ChannelMode;
  status?: "active" | "inactive";
  defaultMarkupPercent?: number | null;
  autoPushOnSave?: boolean;
  /** Optional initial credential blob (encrypted server-side, never returned). */
  credentials?: Record<string, unknown> | null;
};

/** PATCH body is strict on the API: only these keys are accepted. */
export type PatchChannelInput = {
  name?: string;
  mode?: ChannelMode;
  status?: "active" | "inactive" | "error" | "paused";
  defaultMarkupPercent?: number | null;
  autoPushOnSave?: boolean;
};

/** POST /channel-manager/channels/:id/test → adapter `testCredentials` + channel context. */
export type ChannelTestResult = {
  channelId: string;
  providerCode: string;
  mode: ChannelMode;
  ok: boolean;
  error?: string | null;
  metadata?: Record<string, unknown> | null;
};

export type ChannelProductMappingRow = {
  id: string;
  channelId: string;
  propertyId?: string;
  roomTypeId: string;
  ratePlanId: string;
  externalRoomCode: string;
  externalRateCode: string;
  /** "los" (per stay) is not implemented: the API answers 400 and the UI no longer offers it. */
  pricingModel: "per_day" | "obp" | string;
  status: string;
  roomTypeName?: string | null;
  roomTypeCode?: string | null;
  ratePlanName?: string | null;
  ratePlanCode?: string | null;
  updatedAt?: string | null;
  /** Non-blocking findings about the saved mapping (e.g. a Channex rate plan code shared by several room types). */
  warnings?: string[];
};

export type ChannelProductMappingInput = {
  roomTypeId: string;
  ratePlanId: string;
  externalRoomCode: string;
  externalRateCode: string;
  pricingModel?: "per_day" | "obp";
  status?: "active" | "inactive";
};

/** DELETE /channel-manager/channels/:channelId → logical archive (`ArchiveChannelResult` in channels.service.ts). */
export type ArchiveChannelResult = { id: string; providerCode: string; status: "archived"; keptDeliveries: number };

/** GET …/product-coverage (`ProductCoverage` in mapping.service.ts). */
export type ChannelMappingCoverage = {
  channelId: string;
  roomTypesActive: number;
  ratePlansDistributable: number;
  productsTotal: number;
  productsMapped: number;
  /** 0-100 */
  coveragePct: number;
  complete: boolean;
  /** Products (roomType, ratePlan) without an active mapping. */
  missing: Array<{ roomTypeId: string; roomTypeCode: string; ratePlanId: string; ratePlanCode: string }>;
};

export type ChannelDeliveryRow = {
  id: string;
  propertyId?: string;
  channelId: string;
  kind: "rates" | "availability" | "restrictions" | string;
  roomTypeId: string;
  ratePlanId: string;
  date: string;
  status: CellSyncStatus | string;
  attempts: number;
  nextRetryAt?: string | null;
  lastError?: string | null;
  externalRef?: string | null;
  syncJobId?: string | null;
  journalId?: string | null;
  payloadHash?: string;
  payload?: unknown;
  sentAt?: string | null;
  confirmedAt?: string | null;
  createdAt: string;
  updatedAt?: string | null;
};

export type ListDeliveriesInput = {
  channelId?: string;
  status?: string;
  kind?: "rates" | "availability" | "restrictions";
  from?: string;
  to?: string;
  roomTypeId?: string;
  ratePlanId?: string;
  limit?: number;
  cursor?: string | null;
};

export type DeliveriesPage = { items: ChannelDeliveryRow[]; nextCursor: string | null };

/** One drain run (`DrainSummary` in drain.service.ts). */
export type DrainSummary = {
  startedAt: string;
  finishedAt: string;
  candidates: number;
  processed: number;
  byStatus: Partial<Record<CellSyncStatus, number>>;
  deferredRateLimit: number;
  batches: Array<{
    channelId: string;
    providerCode: string;
    kind: string;
    size: number;
    status: "success" | "partial" | "failed";
    latencyMs: number;
    syncJobId: string | null;
    errors: string[];
  }>;
  failed: Array<{ channelId: string; kind: string; deliveryIds: string[]; message: string }>;
};

/** Normalised drain result: the API answers one summary (channelId given) or `{ runs }` (tenant-wide). */
export type DrainResult = {
  runs: DrainSummary[];
  /** Sum of `processed` over the runs. */
  processed: number;
  /** Sum of `candidates` over the runs. */
  candidates: number;
  /** Adapter exceptions across runs (`failed[].message`). */
  errors: string[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** GET /properties/:id/channels → `{ channels, providers }` (tolerates a bare array). */
export async function listChannels(propertyId: string): Promise<ChannelAdminRow[]> {
  const res = await apiRequest<unknown>(`/properties/${propertyId}/channels`);
  if (isRecord(res) && Array.isArray(res.channels)) return res.channels as ChannelAdminRow[];
  return toArray<ChannelAdminRow>(res);
}

/**
 * Property list enriched with the per-channel detail (hasCredentials,
 * credentialKeys, autoPushOnSave…): the list route only carries the grid
 * shape. Detail failures keep the bare row (the hub still renders).
 */
export async function listChannelsWithDetails(propertyId: string): Promise<ChannelAdminRow[]> {
  const rows = await listChannels(propertyId);
  const details = await Promise.allSettled(rows.map((row) => getChannel(row.id)));
  return rows.map((row, i) => {
    const d = details[i];
    return d.status === "fulfilled" ? { ...row, ...d.value } : row;
  });
}

/** POST /channel-manager/channels (permiso channel_manager.manage). 409 CHANNEL_PROVIDER_EXISTS cuando ya hay uno del proveedor. */
export function createChannel(body: CreateChannelInput): Promise<ChannelAdminRow> {
  return apiRequest<ChannelAdminRow>(`/channel-manager/channels`, { method: "POST", body });
}

/** GET /channel-manager/channels/:channelId → detail (hasCredentials, credentialKeys, autoPushOnSave…). */
export function getChannel(channelId: string): Promise<ChannelAdminRow> {
  return apiRequest<ChannelAdminRow>(`/channel-manager/channels/${channelId}`);
}

export function patchChannel(channelId: string, body: PatchChannelInput): Promise<ChannelAdminRow> {
  return apiRequest<ChannelAdminRow>(`/channel-manager/channels/${channelId}`, { method: "PATCH", body });
}

/**
 * DELETE /channel-manager/channels/:channelId (permiso channel_manager.manage).
 * Logical archive: the channel leaves the editor lists, its deliveries and
 * mappings are kept; 409 `CHANNEL_HAS_PENDING_DELIVERIES` while rows are
 * still queued / sending / timeout. A later POST with the same providerCode
 * revives it.
 */
export function archiveChannel(channelId: string): Promise<ArchiveChannelResult> {
  return apiRequest<ArchiveChannelResult>(`/channel-manager/channels/${channelId}`, { method: "DELETE" });
}

/**
 * PATCH /channel-manager/channels/:channelId/credentials — write-only. The API
 * encrypts the blob and never returns it; the detail only reports
 * `hasCredentials` + `credentialKeys`. `merge: true` keeps keys not sent.
 */
export function setChannelCredentials(
  channelId: string,
  credentials: Record<string, unknown>,
  options: { merge?: boolean } = {}
): Promise<ChannelAdminRow> {
  return apiRequest<ChannelAdminRow>(`/channel-manager/channels/${channelId}/credentials`, {
    method: "PATCH",
    body: { credentials, ...(options.merge !== undefined ? { merge: options.merge } : {}) }
  });
}

/** POST /channel-manager/channels/:channelId/test (permiso channel_manager.sync). */
export function testChannel(channelId: string): Promise<ChannelTestResult> {
  return apiRequest<ChannelTestResult>(`/channel-manager/channels/${channelId}/test`, { method: "POST", body: {} });
}

export async function listProductMappings(channelId: string): Promise<ChannelProductMappingRow[]> {
  const res = await apiRequest<unknown>(`/channel-manager/channels/${channelId}/product-mappings`);
  if (isRecord(res) && Array.isArray(res.mappings)) return res.mappings as ChannelProductMappingRow[];
  return toArray<ChannelProductMappingRow>(res);
}

/** POST one mapping; the API upserts by (channelId, roomTypeId, ratePlanId). */
export function upsertProductMapping(channelId: string, mapping: ChannelProductMappingInput): Promise<ChannelProductMappingRow> {
  return apiRequest<ChannelProductMappingRow>(`/channel-manager/channels/${channelId}/product-mappings`, {
    method: "POST",
    body: mapping
  });
}

/**
 * The API takes ONE mapping per request: this helper posts them in sequence
 * and stops at the first failure (the rows already saved stay saved; the
 * caller reloads the list either way).
 */
export async function upsertProductMappings(channelId: string, mappings: ChannelProductMappingInput[]): Promise<ChannelProductMappingRow[]> {
  const saved: ChannelProductMappingRow[] = [];
  for (const mapping of mappings) saved.push(await upsertProductMapping(channelId, mapping));
  return saved;
}

export function deleteProductMapping(mappingId: string): Promise<{ id: string; deleted: boolean }> {
  return apiRequest<{ id: string; deleted: boolean }>(`/channel-manager/product-mappings/${mappingId}`, { method: "DELETE" });
}

/**
 * POST …/product-mappings/migrate-legacy — derives product mappings from the
 * cross join of the old room-mappings × rate-mappings of the channel.
 */
export function migrateLegacyMappings(channelId: string): Promise<{ channelId: string; created: number; skippedExisting: number; pairs: number }> {
  return apiRequest<{ channelId: string; created: number; skippedExisting: number; pairs: number }>(
    `/channel-manager/channels/${channelId}/product-mappings/migrate-legacy`,
    { method: "POST", body: {} }
  );
}

export function fetchMappingCoverage(channelId: string): Promise<ChannelMappingCoverage> {
  return apiRequest<ChannelMappingCoverage>(`/channel-manager/channels/${channelId}/product-coverage`);
}

/** GET /channel-manager/deliveries?propertyId=… (the query is required: the API scopes by property). */
export async function listDeliveries(propertyId: string, input: ListDeliveriesInput = {}): Promise<DeliveriesPage> {
  const query: Record<string, string | number | undefined> = {
    propertyId,
    channelId: input.channelId || undefined,
    status: input.status || undefined,
    kind: input.kind || undefined,
    from: input.from || undefined,
    to: input.to || undefined,
    roomTypeId: input.roomTypeId || undefined,
    ratePlanId: input.ratePlanId || undefined,
    limit: input.limit,
    cursor: input.cursor || undefined
  };
  const res = await apiRequest<unknown>(`/channel-manager/deliveries`, { query });
  if (isRecord(res) && Array.isArray(res.items)) {
    return {
      items: res.items as ChannelDeliveryRow[],
      nextCursor: typeof res.nextCursor === "string" ? res.nextCursor : null
    };
  }
  return { items: toArray<ChannelDeliveryRow>(res), nextCursor: null };
}

export function getDelivery(deliveryId: string): Promise<ChannelDeliveryRow> {
  return apiRequest<ChannelDeliveryRow>(`/channel-manager/deliveries/${deliveryId}`);
}

/** POST /channel-manager/deliveries/:id/retry → back to `queued` (400 while `sending`). */
export function retryDelivery(deliveryId: string): Promise<ChannelDeliveryRow> {
  return apiRequest<ChannelDeliveryRow>(`/channel-manager/deliveries/${deliveryId}/retry`, { method: "POST", body: {} });
}

function summarizeRuns(runs: DrainSummary[]): DrainResult {
  return {
    runs,
    processed: runs.reduce((n, r) => n + (r.processed ?? 0), 0),
    candidates: runs.reduce((n, r) => n + (r.candidates ?? 0), 0),
    errors: runs.flatMap((r) => (r.failed ?? []).map((f) => f.message))
  };
}

/**
 * POST /channel-manager/deliveries/drain (permiso distribution.sync). The
 * body takes ONE `channelId`; with `channelIds` this helper drains them in
 * sequence. Without ids the API drains every channel of the caller's context
 * property (or everything for a platform admin) and answers `{ runs }`.
 */
export async function drainDeliveries(input: { channelIds?: string[]; limit?: number } = {}): Promise<DrainResult> {
  const ids = input.channelIds ?? [];
  if (ids.length > 0) {
    const runs: DrainSummary[] = [];
    for (const channelId of ids) {
      runs.push(await apiRequest<DrainSummary>(`/channel-manager/deliveries/drain`, { method: "POST", body: { channelId, limit: input.limit } }));
    }
    return summarizeRuns(runs);
  }
  const res = await apiRequest<unknown>(`/channel-manager/deliveries/drain`, { method: "POST", body: { limit: input.limit } });
  if (isRecord(res) && Array.isArray(res.runs)) return summarizeRuns(res.runs as DrainSummary[]);
  return summarizeRuns([res as DrainSummary]);
}
