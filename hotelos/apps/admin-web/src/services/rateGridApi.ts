// Frontend client for the Rate Manager grid v2 (rate-manager module, canonical
// backend: `/properties/:propertyId/rate-grid*`, `/rate-journal*`).
//
// Wire contract: `packages/shared/src/rate-manager-types.ts`, re-exported from
// the `@hotelos/shared` barrel (the tsconfig `paths` only maps the root).
//
// Every call goes through `apiRequest` (session JWT, tenant context, shared
// 401 handling — enforced by tests/admin-web-no-raw-fetch.test.mjs).
//
// Real routes (apps/api/src/modules/rate-manager/rate-grid.routes.ts, all
// under the property prefix so the global tenancy hook validates `propertyId`):
//   GET    /properties/:id/rate-grid?from&to&ratePlanIds&roomTypeIds&channelId&demand
//   POST   /properties/:id/rate-grid/bulk-update                 RateGridBulkUpdateRequest
//   POST   /properties/:id/rate-grid/push                        RateGridPushRequest
//   GET    /properties/:id/rate-grid/sync-status?from&to&channelIds
//   POST   /properties/:id/rate-plans/:ratePlanId/rederive?from&to   (no body)
//   GET    /properties/:id/rate-journal?limit&cursor
//   GET    /properties/:id/rate-journal/:journalId               (with items)
//   POST   /properties/:id/rate-journal/:journalId/revert        RateJournalRevertRequest { force?, reason? }
//   GET    /properties/:id/rate-plans
//
// Typed 4xx the editor understands (`details.code`, see classifyRateGridError):
//   400 NO_CELLS · TOO_MANY_CELLS · INACTIVE_RATE_PLANS · DERIVATION_CHAIN ·
//       DERIVATION_YIELDS_ZERO · UNKNOWN_IDS
//   409 ALL_CELLS_CONFLICT (every cell conflicted, nothing written) ·
//       JOURNAL_STALE (revert: the grid changed after the entry; `{ force: true }` overrides) ·
//       RATE_GRID_BUSY (another write holds the property lock: retry in a few seconds) ·
//       CHANNEL_HAS_PENDING_DELIVERIES (channel manager: archive refused)
import { ApiError, apiRequest } from "./api-client";
import { toArray } from "../utils/toArray";
import { RATE_GRID_ERROR_CODES, rateGridErrorMessage } from "../components/cocoa-rate-grid/helpers";
import type { JournalStaleCell } from "../components/cocoa-rate-grid/types";
import type {
  RateChangeJournalEntry,
  RateChangeJournalListResponse,
  RateGridBulkUpdateRequest,
  RateGridBulkUpdateResponse,
  RateGridCell,
  RateGridPushRequest,
  RateGridPushResponse,
  RateGridRatePlan,
  RateGridResponse,
  RateGridSyncStatusResponse,
  RateJournalRevertRequest,
  RatePlanDerivation
} from "@hotelos/shared";

export type FetchRateGridInput = {
  propertyId: string;
  from: string;
  to: string;
  ratePlanIds?: string[];
  roomTypeIds?: string[];
  channelId?: string;
  /** Include the demand strip (`?demand=1`). */
  demand?: boolean;
  signal?: AbortSignal;
};

/**
 * Client-side annotation (NOT part of the wire contract): set when the API
 * answered with the pre-v2 shape (a bare array of cells, no roomTypes /
 * ratePlans / channels). The editor shows an honest notice instead of an
 * empty grid, and keeps editing disabled because the v2 write routes are not
 * there either.
 */
export type RateGridResponseWithMeta = RateGridResponse & { legacyShape?: boolean };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isV2Response(value: unknown): value is RateGridResponse {
  return (
    isRecord(value) &&
    Array.isArray(value.cells) &&
    Array.isArray(value.roomTypes) &&
    Array.isArray(value.ratePlans) &&
    Array.isArray(value.channels)
  );
}

/**
 * Old rate-manager cell (server.ts GET /properties/:id/rate-grid before v2):
 * `{ roomTypeId, ratePlanId, date, price, currency, minStay, maxStay,
 * closedToArrival, closedToDeparture, stopSell }`. Mapped to the v2 cell so
 * the grid can at least display something while the API is not restarted.
 */
type LegacyCell = {
  roomTypeId: string;
  ratePlanId?: string;
  date: string;
  price?: number | null;
  basePrice?: number | null;
  currency?: string;
  minStay?: number | null;
  maxStay?: number | null;
  closedToArrival?: boolean;
  closedToDeparture?: boolean;
  stopSell?: boolean;
  restrictions?: RateGridCell["restrictions"];
};

function legacyToV2(input: FetchRateGridInput, raw: unknown): RateGridResponseWithMeta {
  const legacyCells = toArray<LegacyCell>(raw);
  const currency = legacyCells.find((c) => typeof c.currency === "string")?.currency ?? "EUR";
  const cells: RateGridCell[] = legacyCells.map((c) => {
    const price = typeof c.basePrice === "number" ? c.basePrice : typeof c.price === "number" ? c.price : null;
    return {
      ratePlanId: c.ratePlanId ?? "BAR",
      roomTypeId: c.roomTypeId,
      date: c.date,
      basePrice: price,
      effectivePrice: price,
      currency: c.currency ?? currency,
      restrictions: c.restrictions ?? {
        minLos: c.minStay ?? null,
        maxLos: c.maxStay ?? null,
        cta: Boolean(c.closedToArrival),
        ctd: Boolean(c.closedToDeparture),
        stopSell: Boolean(c.stopSell)
      },
      source: "manual"
    };
  });
  const roomTypeIds = Array.from(new Set(cells.map((c) => c.roomTypeId)));
  const ratePlanIds = Array.from(new Set(cells.map((c) => c.ratePlanId)));
  const noDerivation: RatePlanDerivation = { mode: "none", value: 0 };
  return {
    propertyId: input.propertyId,
    from: input.from,
    to: input.to,
    currency,
    roomTypes: roomTypeIds.map((id) => ({ id, code: id, name: id, rooms: 0 })),
    ratePlans: ratePlanIds.map((id) => ({
      id,
      code: id,
      name: id,
      ratePlanType: "BAR",
      derivation: noDerivation,
      active: true
    })),
    channels: [],
    cells,
    generatedAt: new Date().toISOString(),
    legacyShape: true
  };
}

/**
 * GET /properties/:propertyId/rate-grid
 * One grid per property; cells carry `ratePlanId` explicitly. `demand: true`
 * adds the demand strip (`?demand=1`).
 */
export async function fetchRateGrid(input: FetchRateGridInput): Promise<RateGridResponseWithMeta> {
  const { propertyId, from, to, ratePlanIds, roomTypeIds, channelId, demand, signal } = input;
  const query: Record<string, string | number | undefined> = { from, to };
  if (ratePlanIds && ratePlanIds.length > 0) query.ratePlanIds = ratePlanIds.join(",");
  if (roomTypeIds && roomTypeIds.length > 0) query.roomTypeIds = roomTypeIds.join(",");
  if (channelId) query.channelId = channelId;
  if (demand) query.demand = 1;
  const res = await apiRequest<unknown>(`/properties/${propertyId}/rate-grid`, { query, signal });
  if (isV2Response(res)) return res;
  return enrichLegacyNames(propertyId, legacyToV2(input, res));
}

/**
 * The legacy grid carries ids only; the catalogue routes that DO exist on the
 * old API (/room-types, /rate-plans) give the rows their names. Best effort:
 * a failure keeps the ids (the grid stays readable either way).
 */
async function enrichLegacyNames(propertyId: string, grid: RateGridResponseWithMeta): Promise<RateGridResponseWithMeta> {
  const [roomTypes, ratePlans] = await Promise.allSettled([
    apiRequest<unknown>(`/properties/${propertyId}/room-types`),
    fetchRatePlans(propertyId)
  ]);
  if (roomTypes.status === "fulfilled") {
    const byId = new Map(
      toArray<{ id: string; code?: string; name?: string; maxOccupancy?: number }>(roomTypes.value).map((rt) => [rt.id, rt])
    );
    grid.roomTypes = grid.roomTypes.map((rt) => {
      const row = byId.get(rt.id);
      return row ? { ...rt, code: row.code ?? rt.code, name: row.name ?? rt.name, maxOccupancy: row.maxOccupancy ?? null } : rt;
    });
  }
  if (ratePlans.status === "fulfilled") {
    const byId = new Map(ratePlans.value.map((p) => [p.id, p]));
    grid.ratePlans = grid.ratePlans.map((p) => byId.get(p.id) ?? p);
  }
  return grid;
}

/**
 * POST /properties/:propertyId/rate-grid/bulk-update
 * Writes the draft (cells and/or ops) + journal entry. With `publish` the API
 * also enqueues deliveries (`queued` per channel). `clientRequestId` makes a
 * retry idempotent.
 */
export function bulkUpdateRateGrid(
  propertyId: string,
  body: RateGridBulkUpdateRequest
): Promise<RateGridBulkUpdateResponse> {
  return apiRequest<RateGridBulkUpdateResponse>(`/properties/${propertyId}/rate-grid/bulk-update`, {
    method: "POST",
    body
  });
}

/**
 * POST /properties/:propertyId/rate-grid/push
 * Enqueues one delivery per (channel, kind, roomType, plan, date) for the
 * persisted grid. Asynchronous: poll `fetchSyncStatus` afterwards.
 */
export function pushRateGrid(propertyId: string, body: RateGridPushRequest): Promise<RateGridPushResponse> {
  return apiRequest<RateGridPushResponse>(`/properties/${propertyId}/rate-grid/push`, {
    method: "POST",
    body
  });
}

export type FetchSyncStatusInput = {
  from: string;
  to: string;
  channelIds?: string[];
  signal?: AbortSignal;
};

/** GET /properties/:propertyId/rate-grid/sync-status?from&to&channelIds */
export function fetchSyncStatus(
  propertyId: string,
  input: FetchSyncStatusInput
): Promise<RateGridSyncStatusResponse> {
  const query: Record<string, string | number | undefined> = { from: input.from, to: input.to };
  if (input.channelIds && input.channelIds.length > 0) query.channelIds = input.channelIds.join(",");
  return apiRequest<RateGridSyncStatusResponse>(`/properties/${propertyId}/rate-grid/sync-status`, {
    query,
    signal: input.signal
  });
}

export type FetchJournalInput = {
  limit?: number;
  cursor?: string | null;
};

/**
 * GET /properties/:propertyId/rate-journal?limit&cursor
 * Tolerates the pre-v2 bare array (no cursor) so the history drawer keeps
 * working against an API that has not been restarted yet.
 */
export async function fetchJournal(
  propertyId: string,
  input: FetchJournalInput = {}
): Promise<RateChangeJournalListResponse> {
  const query: Record<string, string | number | undefined> = {};
  if (input.limit !== undefined) query.limit = input.limit;
  if (input.cursor) query.cursor = input.cursor;
  const res = await apiRequest<unknown>(`/properties/${propertyId}/rate-journal`, { query });
  if (isRecord(res) && Array.isArray(res.items)) {
    return {
      items: res.items as RateChangeJournalEntry[],
      nextCursor: typeof res.nextCursor === "string" ? res.nextCursor : null
    };
  }
  return { items: toArray<RateChangeJournalEntry>(res), nextCursor: null };
}

/** GET /properties/:propertyId/rate-journal/:journalId (with `items`). */
export function fetchJournalEntry(propertyId: string, journalId: string): Promise<RateChangeJournalEntry> {
  return apiRequest<RateChangeJournalEntry>(`/properties/${propertyId}/rate-journal/${journalId}`);
}

/**
 * POST /properties/:propertyId/rate-journal/:journalId/revert
 * Creates a compensating journal entry (status "reverted" on the original,
 * `revertedByJournalId` pointing at the new one). The API derives the reason
 * («Reversión: <motivo original>[ — <reason>]»; the reverted id travels in
 * `revertsJournalId` of the inverse entry, not in the text) and restores
 * rate_days ONLY: it does NOT push anything, so the channels keep the
 * reverted value until the editor sends the range again (`pushRateGrid` with
 * the new `journalId`).
 * 409 JOURNAL_STALE (details.cells = JournalStaleCell[]) when a later edit
 * changed any cell of the entry: nothing is written; `{ force: true }`
 * reverts anyway and overwrites those later edits.
 * 409 JOURNAL_ALREADY_REVERTED when reverted twice.
 */
export function revertJournal(
  propertyId: string,
  journalId: string,
  body: RateJournalRevertRequest = {}
): Promise<RateGridBulkUpdateResponse> {
  return apiRequest<RateGridBulkUpdateResponse>(`/properties/${propertyId}/rate-journal/${journalId}/revert`, {
    method: "POST",
    body
  });
}

/**
 * GET /properties/:propertyId/rate-plans → RateGridRatePlan[]
 * The existing route answers `{ items: RatePlan[] }` with Prisma rows
 * (`derivationJson`); the grid response already carries `ratePlans` in the v2
 * shape, so this helper is only used to fill selectors before the grid loads.
 */
export async function fetchRatePlans(propertyId: string): Promise<RateGridRatePlan[]> {
  const res = await apiRequest<unknown>(`/properties/${propertyId}/rate-plans`);
  type Row = Partial<RateGridRatePlan> & {
    id: string;
    code: string;
    name: string;
    ratePlanType?: string;
    derivationJson?: DerivationRaw | null;
  };
  return toArray<Row>(res).map((row) => ({
    id: row.id,
    code: row.code,
    name: row.name,
    ratePlanType: row.ratePlanType ?? "BAR",
    mealPlan: row.mealPlan ?? null,
    parentRatePlanId: row.parentRatePlanId ?? null,
    derivation: row.derivation ?? normalizeDerivation(row.derivationJson),
    active: row.active ?? true
  }));
}

type DerivationRaw = { mode?: string; type?: string; value?: number; roundTo?: number };

function normalizeDerivation(raw: DerivationRaw | null | undefined): RatePlanDerivation {
  if (!raw) return { mode: "none", value: 0 };
  const mode = raw.mode ?? (raw.type === "absolute" ? "amount" : raw.type);
  if (mode !== "percent" && mode !== "amount") return { mode: "none", value: 0 };
  const out: RatePlanDerivation = { mode, value: typeof raw.value === "number" ? raw.value : 0 };
  if (raw.roundTo === 0 || raw.roundTo === 1 || raw.roundTo === 2 || raw.roundTo === 0.99) out.roundTo = raw.roundTo;
  return out;
}

/**
 * POST /properties/:propertyId/rate-plans/:ratePlanId/rederive?from&to
 * Re-materialises the derived plan `ratePlanId` (or the children of a parent
 * plan) for the window; the window goes in the QUERY, there is no body. The
 * answer is a bulk-update response (journal entry + derivedUpdated /
 * skippedManual).
 */
export function rederiveRatePlan(
  propertyId: string,
  ratePlanId: string,
  window: { from?: string; to?: string } = {}
): Promise<RateGridBulkUpdateResponse> {
  const query: Record<string, string | number | undefined> = {};
  if (window.from) query.from = window.from;
  if (window.to) query.to = window.to;
  return apiRequest<RateGridBulkUpdateResponse>(`/properties/${propertyId}/rate-plans/${ratePlanId}/rederive`, {
    method: "POST",
    query,
    body: {}
  });
}

// ---------------------------------------------------------------------------
// Error helpers shared by the editor and the channel screens.
// ---------------------------------------------------------------------------

export type RateGridErrorKind = "forbidden" | "not_deployed" | "conflict" | "validation" | "network" | "other";

export type RateGridConflictDetail = { ratePlanId: string; roomTypeId: string; date: string; reason: string };

/** `details.code` of the 409 bulk-update answers when EVERY cell conflicted (nothing written, no journal). */
export const ALL_CELLS_CONFLICT_CODE = RATE_GRID_ERROR_CODES.ALL_CELLS_CONFLICT;
/** `details.code` of the 409 revert answer when the grid changed after the entry (`{ force: true }` overrides). */
export const JOURNAL_STALE_CODE = RATE_GRID_ERROR_CODES.JOURNAL_STALE;
/** `details.code` of the 409 when another write holds the property's grid lock (retry in a few seconds). */
export const RATE_GRID_BUSY_CODE = RATE_GRID_ERROR_CODES.RATE_GRID_BUSY;
/** `details.code` of the 409 when archiving a channel that still has queued/in-flight deliveries. */
export const CHANNEL_HAS_PENDING_DELIVERIES_CODE = RATE_GRID_ERROR_CODES.CHANNEL_HAS_PENDING_DELIVERIES;

export type { JournalStaleCell };

function isStaleCell(value: unknown): value is JournalStaleCell {
  return isRecord(value) && typeof value.date === "string" && Array.isArray(value.fields);
}

/**
 * Classifies an API failure for the editor banners: 403 → permiso; 404 on a
 * v2 route → the API has not been restarted with the new routes ("not
 * deployed", honest message instead of a red card); 409 → conflicts (cells
 * listed in `details.conflicts` when the backend attaches them; `code` is
 * `ALL_CELLS_CONFLICT` when bulk-update rolled back because every cell
 * conflicted, `JOURNAL_STALE` on a revert whose cells changed afterwards —
 * `staleCells` lists them —, `RATE_GRID_BUSY` while another write holds the
 * property lock); 400/422 → validation with the API's Spanish message. The
 * typed codes (NO_CELLS, TOO_MANY_CELLS, INACTIVE_RATE_PLANS,
 * DERIVATION_CHAIN, DERIVATION_YIELDS_ZERO, UNKNOWN_IDS…) get the «what now»
 * copy of `rateGridErrorMessage`.
 */
export function classifyRateGridError(err: unknown): {
  kind: RateGridErrorKind;
  message: string;
  conflicts: RateGridConflictDetail[];
  /** 409 JOURNAL_STALE: the cells whose current value no longer matches the entry's `after`. */
  staleCells: JournalStaleCell[];
  /** Machine-readable `details.code` of typed 4xx answers (e.g. ALL_CELLS_CONFLICT), when present. */
  code?: string;
} {
  if (err instanceof ApiError) {
    const details = isRecord(err.details) ? err.details : {};
    const code = typeof details.code === "string" ? details.code : undefined;
    const staleCells = code === JOURNAL_STALE_CODE ? toArray<unknown>(details.cells).filter(isStaleCell) : [];
    // `details.cells` doubles as the conflict list of older answers; a
    // JOURNAL_STALE cell has `fields`, not `reason`, so it is kept apart.
    const conflicts = toArray<RateGridConflictDetail>(details.conflicts ?? (code === JOURNAL_STALE_CODE ? [] : details.cells)).filter(
      (c) => isRecord(c) && typeof c.date === "string"
    );
    const message = rateGridErrorMessage(code, err.message, details);
    if (err.status === 403) {
      return { kind: "forbidden", message: message || "No tienes permiso para esta operación.", conflicts, staleCells, code };
    }
    if (err.status === 404) {
      return {
        kind: "not_deployed",
        message:
          "El API no expone todavía esta ruta del editor v2 (404). Hace falta reiniciar el API con el módulo rate-manager v2 cableado.",
        conflicts,
        staleCells,
        code
      };
    }
    if (err.status === 409) {
      return { kind: "conflict", message: message || "Conflicto al guardar.", conflicts, staleCells, code };
    }
    if (err.status === 400 || err.status === 422) {
      return { kind: "validation", message: message || "Datos no válidos.", conflicts, staleCells, code };
    }
    return { kind: "other", message: message || `HTTP ${err.status}`, conflicts, staleCells, code };
  }
  if (err instanceof Error) {
    const network = /failed to fetch|networkerror|load failed/i.test(err.message);
    return { kind: network ? "network" : "other", message: err.message, conflicts: [], staleCells: [] };
  }
  return { kind: "other", message: String(err), conflicts: [], staleCells: [] };
}

/** Generates the idempotency id sent as `clientRequestId` (uuid v4 when available). */
export function newClientRequestId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}
