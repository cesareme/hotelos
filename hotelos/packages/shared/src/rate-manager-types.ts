/**
 * Rate grid v2 · shared wire contract between the API (`apps/api`, module
 * rate-manager = canonical backend) and the admin-web editor.
 *
 * Design (rate grid v2, 2026-09-14):
 *   · ONE grid endpoint per property (`GET /properties/:id/rate-grid`) whose
 *     cells carry `ratePlanId` explicitly. The old revenue-module grid routes
 *     (`/revenue/properties/:id/rate-grid*`) had no consumer and are retired.
 *   · `basePrice` is the persisted RateDay price; `effectivePrice` is what the
 *     requested channel sees (base × (1 + markup)) or the base itself when no
 *     channel is requested. Both are `null` when there is no RateDay — the UI
 *     shows "sin tarifa", never a fake 0.
 *   · Restrictions are a single object (never flat `minStay`/`closedToArrival`
 *     fields) and `closed` is DISTINCT from `stopSell`: closed = the rate plan is
 *     not bookable that night; stopSell = the room type is pulled from sale.
 *   · Derived plans (BAR-NR = BAR −10 %) are materialised on write: the child's
 *     RateDay rows exist, carry `source: "derived"` and `derivedFrom`, and are
 *     read-only until the user converts a cell to manual (`convertToManual`).
 *   · Publishing to channels is asynchronous: bulk-update writes the draft and
 *     journal; push enqueues one delivery per (channel, kind, roomType, plan,
 *     date); the grid shows the delivery status per cell and channel.
 *
 * Money is expressed as plain numbers with 2 decimals in the property currency
 * (`currency` at the response root). Dates are calendar days `YYYY-MM-DD`.
 */

export type RateRestrictions = {
  /** Minimum length of stay when arriving that night (null/undefined = none). */
  minLos?: number | null;
  /** Maximum length of stay when arriving that night. */
  maxLos?: number | null;
  /** Minimum length of stay for any stay covering that night (min stay through). */
  minLosThrough?: number | null;
  /** Closed to arrival. */
  cta?: boolean;
  /** Closed to departure. */
  ctd?: boolean;
  /** The rate plan is not bookable for that night (plan-level). */
  closed?: boolean;
  /** The room type is pulled from sale for that night (room-level). */
  stopSell?: boolean;
  /** Bookings must be made at least N days in advance. */
  minAdvanceDays?: number | null;
  /** Bookings cannot be made more than N days in advance. */
  maxAdvanceDays?: number | null;
};

export const RATE_RESTRICTION_KEYS = [
  "minLos",
  "maxLos",
  "minLosThrough",
  "cta",
  "ctd",
  "closed",
  "stopSell",
  "minAdvanceDays",
  "maxAdvanceDays"
] as const satisfies ReadonlyArray<keyof RateRestrictions>;

export type RateCellSource = "manual" | "rms" | "derived" | "import";

/**
 * Delivery status of one cell on one channel (see ChannelDelivery).
 * `stale` (cierre 2026-09-15) is NOT a ChannelDelivery status: the outbox
 * reports it when the last confirmed delivery of the cell no longer matches
 * the current grid value (e.g. after a journal revert that was not published),
 * so the editor labels it «Pendiente de reenvío» instead of «Confirmado».
 */
export type CellSyncStatus = "never" | "queued" | "sending" | "sent" | "confirmed" | "rejected" | "timeout" | "superseded" | "stale";

export type CellSyncState = {
  status: CellSyncStatus;
  /** ISO timestamp of the last transition. */
  at?: string | null;
  /** Channel error code/message when rejected or timed out. */
  error?: string | null;
  deliveryId?: string | null;
};

export type RatePlanDerivation = {
  mode: "none" | "percent" | "amount";
  /** Signed value: −10 (percent) or −15 (amount in the property currency). */
  value: number;
  /** Rounding of the derived price: 0 = integer, 1 = one decimal, 0.99 = psychological (x.99). */
  roundTo?: 0 | 1 | 2 | 0.99;
};

export type RateGridCellRecommendation = {
  currentPrice: number | null;
  suggestedPrice: number | null;
  deltaPct: number | null;
  action: "raise" | "hold" | "lower" | "no_data";
  /** 0-100. Below 40 the action is degraded to "hold" (datos insuficientes). */
  confidence: number;
  reasons: Array<{ code: string; label: string; weight: number; value?: number | string | null }>;
  /** Signals that were not available (e.g. "compset", "events", "otb_empty"). */
  missing: string[];
  suggestedRestrictions?: RateRestrictions | null;
};

export type RateGridCell = {
  ratePlanId: string;
  roomTypeId: string;
  /** YYYY-MM-DD */
  date: string;
  /** Persisted RateDay price; null when the (plan, type, date) has no rate. */
  basePrice: number | null;
  /** Price as seen by `channelId` (base × (1 + markup)) or the base itself. */
  effectivePrice: number | null;
  currency: string;
  /** Occupancy-based prices when configured: { "1": 80, "2": 95, "extraAdult": 20, "extraChild": 10 }. */
  occupancyPrices?: Record<string, number> | null;
  minPrice?: number | null;
  maxPrice?: number | null;
  restrictions: RateRestrictions;
  /** Distribution inventory for the room type that day (null when not managed). */
  inventory?: { total: number; available: number; outOfOrder: number; stopSell: boolean } | null;
  source: RateCellSource;
  /** Present on derived plans (read-only cells). */
  derivedFrom?: { ratePlanId: string; ratePlanCode: string; derivation: RatePlanDerivation } | null;
  /** Channel the effectivePrice was computed for (null = base). */
  channelId?: string | null;
  /** Sync state per channel id (only channels mapped for this product). */
  sync?: Record<string, CellSyncState>;
  recommendation?: RateGridCellRecommendation | null;
  lastModifiedAt?: string | null;
  lastModifiedBy?: string | null;
};

export type RateGridRoomType = {
  id: string;
  code: string;
  name: string;
  /** Sellable rooms of the type (capacity for occupancy %). */
  rooms: number;
  baseCapacity?: number | null;
  maxOccupancy?: number | null;
  sortOrder?: number | null;
};

export type RateGridRatePlan = {
  id: string;
  code: string;
  name: string;
  ratePlanType: string;
  mealPlan?: string | null;
  parentRatePlanId?: string | null;
  derivation: RatePlanDerivation;
  active: boolean;
};

export type ChannelMode = "stub" | "sandbox" | "real";

export type RateGridChannel = {
  id: string;
  providerCode: string;
  name: string;
  channelType: string;
  /** Channel.status: inactive | active | error … */
  status: string;
  mode: ChannelMode;
  /** Markup applied to the base price for this channel (%). */
  markupPercent: number;
  /** Number of (roomType, ratePlan) products mapped on this channel. */
  mappedProducts: number;
  lastSyncAt?: string | null;
  /** True when credentials + mappings + adapter mode allow a real push. */
  readyToPush: boolean;
  readinessSummary?: string | null;
};

export type RateGridDemandDay = {
  date: string;
  /** Rooms on the books (confirmed + in house) for the night. */
  otbRooms: number;
  occPct: number;
  fcOccPct: number | null;
  fcSource: string | null;
  stlyOccPct: number | null;
  stlyAdr: number | null;
  pickup7: number | null;
  compsetMedian: number | null;
  events: Array<{ name: string; impact: string | null }>;
};

export type RateGridResponse = {
  propertyId: string;
  from: string;
  to: string;
  currency: string;
  roomTypes: RateGridRoomType[];
  ratePlans: RateGridRatePlan[];
  channels: RateGridChannel[];
  cells: RateGridCell[];
  /** Present when `?demand=1`. */
  demand?: RateGridDemandDay[];
  /**
   * QC-06: parts of the response that fell back to a default because a query
   * failed (today only "sync": the per-cell sync state could not be read, so
   * every cell looks «never»). The editor should say «estado de sincronización
   * no disponible» instead of trusting the fallback. Absent when nothing failed.
   */
  degraded?: string[];
  generatedAt: string;
};

/** Tri-state restriction patch: undefined = unchanged, null = clear, value = set. */
export type RateRestrictionsPatch = {
  [K in keyof RateRestrictions]?: RateRestrictions[K] | null;
};

export type RateGridCellPatch = {
  ratePlanId: string;
  roomTypeId: string;
  date: string;
  /**
   * Channel scope. Supported for `restrictions` (RestrictionDay per channel).
   * NOT supported yet for price fields: channel prices are base × markup
   * (RateDay has no channel dimension) and the API answers 400 when a
   * channelId comes with price/occupancyPrices/minPrice/maxPrice.
   */
  channelId?: string | null;
  price?: number | null;
  occupancyPrices?: Record<string, number> | null;
  minPrice?: number | null;
  maxPrice?: number | null;
  restrictions?: RateRestrictionsPatch;
  /** Distribution inventory (available rooms) for the room type that day. */
  available?: number | null;
  /** On a derived plan: break the derivation for this cell and keep the given price. */
  convertToManual?: boolean;
  /** On a manual cell of a derived plan: drop the override and re-derive. */
  revertToDerived?: boolean;
  /**
   * When the patched plan has derived children: false = overwrite children
   * that carry a manual override (default true = keep them, counted as
   * `skippedManual`). Set by the bulk-op expansion from `RateGridBulkOp`.
   */
  respectManualOverrides?: boolean;
  /**
   * Optimistic concurrency (api-fix, 2026-09-15): what the editor saw when the
   * cell was loaded. When the server's CURRENT value differs, the patch is not
   * applied and comes back as a conflict «la celda cambió desde que se cargó…»
   * (200 with `conflicts[]`, or 409 `ALL_CELLS_CONFLICT` when every patch is
   * stale). `price` compares the base price (null = no rate); `lastModifiedAt`
   * compares the cell's `lastModifiedAt` stamp. Omitted → last write wins.
   */
  expected?: { price?: number | null; lastModifiedAt?: string | null };
};

export type RateGridBulkScope = {
  from: string;
  to: string;
  /** 1 = Monday … 7 = Sunday (ISO). Empty/undefined = every day. */
  weekdays?: number[];
  roomTypeIds?: string[];
  ratePlanIds?: string[];
  /** Channel overrides scope; empty = base price. */
  channelIds?: string[];
};

export type RateGridPriceOp =
  | { mode: "set"; value: number }
  | { mode: "percent"; value: number }
  | { mode: "amount"; value: number }
  | { mode: "copyFrom"; fromDate: string; value?: undefined }
  | { mode: "floor"; value: number }
  | { mode: "ceiling"; value: number };

export type RateGridBulkOp = {
  scope: RateGridBulkScope;
  price?: RateGridPriceOp;
  restrictions?: RateRestrictionsPatch;
  available?: number | null;
  /** Skip cells that carry a manual override on a derived plan (default true). */
  respectManualOverrides?: boolean;
};

/**
 * Order of application: `ops` are expanded and applied first, then `cells`
 * (a manual cell edit wins over a bulk op on the same cell). Availability
 * patches may use `ratePlanId: "*"` (the «Disponibles» row). When EVERY patch
 * is a conflict the API answers 409 `{ details: { code: "ALL_CELLS_CONFLICT",
 * conflicts } }` and writes nothing; partial conflicts are a 200 with
 * `conflicts[]` in the response. Unknown ids inside an op scope are
 * `warnings` (non-fatal) — but when the ops expand to NO cell at all and there
 * are no `cells`, the request is a no-op and answers 400 `{ code: "NO_CELLS",
 * warnings, skipped }` instead of writing an empty journal entry. The
 * expansion (ops × cells) is capped at 5000 patches per request (400).
 * `publish` only enqueues the products the patches touched: room types and
 * plans of the patches (plus the derived children of a patched parent) and,
 * unless `publish.kinds` is given, the kinds the fields imply (price → rates,
 * available → availability, restrictions → restrictions, stopSell → also
 * availability). A repeated `clientRequestId` returns the stored response and
 * does NOT enqueue the publish again (a `warnings` line says so).
 */
export type RateGridBulkUpdateRequest = {
  cells?: RateGridCellPatch[];
  ops?: RateGridBulkOp[];
  /** Mandatory, shown in the journal: "Evento", "Compset", "Pickup lento", "Corrección", free text… */
  reason: string;
  /** When present the update is followed by a push to these channels. */
  publish?: { channelIds: string[]; kinds?: Array<"rates" | "availability" | "restrictions"> };
  /** Client-generated id to make retries idempotent (uuid). */
  clientRequestId?: string;
};

export type RateGridBulkUpdateResponse = {
  journalId: string;
  /** Cells written on the requested plans. */
  updated: number;
  /** Cells re-materialised on derived plans. */
  derivedUpdated: number;
  /** Cells skipped because of a manual override on a derived plan. */
  skippedManual: number;
  conflicts: Array<{ ratePlanId: string; roomTypeId: string; date: string; reason: string }>;
  /** Deliveries queued per channel when `publish` was requested. */
  queued?: Record<string, number>;
  /** Cells a bulk op could not price (no base rate, missing copyFrom day…); informative. */
  skipped?: Array<{ ratePlanId: string; roomTypeId: string; date: string; reason: string }>;
  /** Non-fatal diagnostics (unknown ids in an op scope, outbox unavailable…). */
  warnings?: string[];
  /** Number of journal items (before/after) written for this update. */
  changesCount?: number;
};

export type RateGridPushRequest = {
  from: string;
  to: string;
  channelIds: string[];
  ratePlanIds?: string[];
  roomTypeIds?: string[];
  kinds?: Array<"rates" | "availability" | "restrictions">;
  /** Journal entry this push belongs to (stamps pushedTo/pushStatus). */
  journalId?: string | null;
};

export type RateGridPushResponse = {
  /** Total deliveries queued. */
  queued: number;
  byChannel: Record<string, { queued: number; mode: ChannelMode; skippedUnmapped: number }>;
  /** When the channel has no mapping for a product, why nothing was queued. */
  warnings: string[];
};

export type RateGridSyncStatusResponse = {
  from: string;
  to: string;
  channels: RateGridChannel[];
  cells: Array<{
    ratePlanId: string;
    roomTypeId: string;
    date: string;
    byChannel: Record<string, CellSyncState>;
  }>;
  /** Count of cells per channel per status. */
  summary: Record<string, Partial<Record<CellSyncStatus, number>>>;
};

export type RateChangeJournalItem = {
  ratePlanId: string;
  roomTypeId: string;
  date: string;
  channelId?: string | null;
  /** "price" | "occupancyPrices" | "minPrice" | "maxPrice" | "available" | a restriction key. */
  field: string;
  before: unknown;
  after: unknown;
};

/**
 * Publish state of a journal entry, derived from the deliveries it produced:
 *   · draft      — never sent to the outbox (or the enqueue queued nothing);
 *   · queued     — deliveries queued/sending/timeout still pending (optimistic
 *                  stamp at enqueue time; the drain recomputes it);
 *   · pushed     — every delivery confirmed;
 *   · partial    — some rejected, some confirmed;
 *   · failed     — every delivery rejected;
 *   · superseded — every delivery of the entry was replaced by a later value
 *                  before reaching the channel (nothing of this entry is live).
 */
export type RateJournalPushStatus = "draft" | "queued" | "pushed" | "partial" | "failed" | "superseded";

export type RateChangeJournalEntry = {
  id: string;
  propertyId: string;
  userId: string;
  userEmail: string | null;
  timestamp: string;
  changesCount: number;
  /** Free text of the edit; a revert entry reads «Reversión: <motivo original>[ — <texto del usuario>]». */
  reason: string | null;
  pushedTo: string[];
  pushStatus: RateJournalPushStatus;
  status: "draft" | "published" | "reverted";
  /** On the ORIGINAL entry: id of the inverse entry that reverted it. */
  revertedByJournalId?: string | null;
  /** On the INVERSE entry (a revert): id of the entry it reverted. */
  revertsJournalId?: string | null;
  /** Present on GET /rate-journal/:id. */
  items?: RateChangeJournalItem[];
};

export type RateChangeJournalListResponse = {
  items: RateChangeJournalEntry[];
  nextCursor: string | null;
};

/**
 * Body of POST /properties/:id/rate-journal/:journalId/revert. A revert only
 * applies when every cell still holds the `after` the entry wrote: if a later
 * edit changed any of them the API answers 409 `{ code: "JOURNAL_STALE",
 * cells }` and writes nothing. `force: true` reverts anyway (the later edits
 * on those cells are overwritten and journaled as the inverse entry).
 */
export type RateJournalRevertRequest = {
  force?: boolean;
  /** Optional free text appended to the generated reason («Reversión: <motivo original> — <texto>»). */
  reason?: string;
};

/**
 * Machine-readable `details.code` of the 4xx answers of the rate-manager
 * routes (the editor maps them to Spanish copy; the message is Spanish too):
 *   400 VALIDATION_ERROR      — body/query rejected by the zod schema (`details.issues`);
 *   400 NO_CELLS              — ops expanded to no cell and no `cells` (`warnings`, `skipped`);
 *   400 TOO_MANY_CELLS        — ops expandidas + cells > 5000 (`count`, `max`);
 *   400 UNKNOWN_IDS           — plans/types/channels of another property (`ratePlanIds`, `roomTypeIds`, `channelIds`);
 *   400 INACTIVE_RATE_PLANS   — a soft-deleted plan («reactívalos», `ratePlanIds`); only a revert may write it.
 *                               Raised by a `cells` patch on such a plan and by `ops` whose scopes name ONLY
 *                               inactive plans (0 patches); an inactive plan next to active ones in an op
 *                               scope is a `warnings` line («plan tarifario inactivo <código>»), like unknown ids;
 *   400 DERIVATION_CHAIN      — a plan with active children cannot become derived (`codes`);
 *   400 DERIVATION_YIELDS_ZERO — the rule yields ≤ 0 € on the parent's minimum price;
 *   409 RATE_GRID_BUSY        — per-property write lock not obtained in 30 s («reintenta en unos segundos»);
 *   409 ALL_CELLS_CONFLICT    — every patch conflicted, nothing written (`conflicts`, `skipped`, `warnings`);
 *   409 JOURNAL_STALE         — a revert would overwrite later edits (`cells`); `force: true` overrides;
 *   409 JOURNAL_ALREADY_REVERTED — the entry was reverted before (`revertedByJournalId`);
 *   409 CHANNEL_HAS_PENDING_DELIVERIES — DELETE of a channel with queued/sending/timeout deliveries (channel-manager).
 */
export type RateGridErrorCode =
  | "VALIDATION_ERROR"
  | "NO_CELLS"
  | "TOO_MANY_CELLS"
  | "UNKNOWN_IDS"
  | "INACTIVE_RATE_PLANS"
  | "DERIVATION_CHAIN"
  | "DERIVATION_YIELDS_ZERO"
  | "RATE_GRID_BUSY"
  | "ALL_CELLS_CONFLICT"
  | "JOURNAL_STALE"
  | "JOURNAL_ALREADY_REVERTED"
  | "CHANNEL_HAS_PENDING_DELIVERIES";

export type RateRecommendationsResponse = {
  propertyId: string;
  ratePlanId: string;
  from: string;
  to: string;
  generatedAt: string;
  /** Provenance of each signal: "reservations", "pms_forecast", "deterministic-v1", "snapshots", "rate_shopper:demo", "none"… */
  sources: Record<string, string>;
  days: Array<{
    date: string;
    daysOut: number;
    signals: RateGridDemandDay & { budgetGapPct?: number | null };
    byRoomType: Array<{ roomTypeId: string } & RateGridCellRecommendation>;
  }>;
};
