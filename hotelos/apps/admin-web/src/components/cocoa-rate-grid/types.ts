// CocoaRateGrid v2 — PROPS CONTRACT for the rate grid editor components.
//
// The wire types (`RateGridResponse`, `RateGridCell`, `RateGridCellPatch`,
// `RateGridBulkOp`, journal / sync / recommendation shapes) come from
// `@hotelos/shared` (rate-manager-types.ts) and are NOT redefined here. This
// file only fixes the UI-level contract that the screen (lot front-screen)
// wires against: cell keys, draft state, selection, and the props of every
// exported component. Keep it additive: new fields are optional.
//
// Cell keys
//   `${ratePlanId}|${roomTypeId}|${date}` for a base cell and
//   `${ratePlanId}|${roomTypeId}|${date}|${channelId}` for a channel override
//   (channels view). The availability row of a room type uses the sentinel
//   `AVAILABILITY_PLAN_ID` ("*") as ratePlanId — the screen must translate
//   those patches into `RateGridCellPatch.available` on the room type.

import type {
  CellSyncState,
  CellSyncStatus,
  RateChangeJournalEntry,
  RateChangeJournalItem,
  RateGridBulkOp,
  RateGridCell,
  RateGridCellPatch,
  RateGridCellRecommendation,
  RateGridChannel,
  RateGridDemandDay,
  RateGridRatePlan,
  RateGridResponse,
  RateGridRoomType,
  RateRestrictions,
  RateRestrictionsPatch
} from "@hotelos/shared";

/* ------------------------------------------------------------------ */
/*  Keys                                                               */
/* ------------------------------------------------------------------ */

export type CellKey = string;

/** Sentinel ratePlanId used by the editable "Disponibles" row (mirrors the DB "*" sentinel). */
export const AVAILABILITY_PLAN_ID = "*";

export interface ParsedCellKey {
  ratePlanId: string;
  roomTypeId: string;
  date: string;
  channelId?: string;
}

/* ------------------------------------------------------------------ */
/*  Draft (unpublished changes)                                        */
/* ------------------------------------------------------------------ */

/** Snapshot of the persisted values BEFORE the first draft edit of a cell. */
export interface CellBeforeSnapshot {
  basePrice: number | null;
  effectivePrice: number | null;
  restrictions: RateRestrictions;
  available?: number | null;
  source: RateGridCell["source"] | null;
  /**
   * `RateGridCell.lastModifiedAt` when the cell was loaded (cierre 2026-09-15):
   * travels as `RateGridCellPatch.expected.lastModifiedAt` so the API refuses
   * the patch when someone else changed the cell meanwhile (optimistic
   * concurrency). Absent on drafts saved before this field existed.
   */
  lastModifiedAt?: string | null;
}

export type DraftOrigin = "cell" | "quick" | "bulk" | "recommendation" | "paste" | "fill";

export interface DraftEntry {
  key: CellKey;
  /** Merged patch for the cell (later edits are merged over earlier ones). */
  patch: RateGridCellPatch;
  before: CellBeforeSnapshot;
  origin: DraftOrigin;
  /** ISO timestamp of the last edit. */
  at: string;
  /** Optional per-edit reason (bulk/recommendation carry one). */
  reason?: string | null;
}

export interface DraftBulkOp {
  id: string;
  op: RateGridBulkOp;
  reason: string;
  /** Cell keys the client preview expanded to (the backend expands for real). */
  previewKeys: CellKey[];
  at: string;
}

export interface DraftState {
  patches: Map<CellKey, DraftEntry>;
  /** Bulk operations applied to the draft, in order (sent as `ops` on save). */
  ops: DraftBulkOp[];
  /** Recommendations the user rejected in this draft (key → reason). */
  rejectedRecommendations: Map<CellKey, string>;
  /** ISO timestamp of the last mutation, null when empty. */
  updatedAt: string | null;
}

/* ------------------------------------------------------------------ */
/*  Selection                                                          */
/* ------------------------------------------------------------------ */

export interface Selection {
  /** Selected cell keys (order = insertion order). */
  keys: CellKey[];
  /** Cursor cell (keyboard focus). */
  active: CellKey | null;
  /** Start of the last range operation (shift / drag). */
  anchor: CellKey | null;
}

export const EMPTY_SELECTION: Selection = { keys: [], active: null, anchor: null };

/* ------------------------------------------------------------------ */
/*  Grid                                                               */
/* ------------------------------------------------------------------ */

export type RateGridView = "rates" | "restrictions" | "channels" | "recommendations";

export interface RateGridLayers {
  demand: boolean;
  recommendations: boolean;
  sync: boolean;
}

export type RateGridDensity = "compact" | "comfortable";

export type RecommendationAction = "accept" | "reject" | "adjust";

/**
 * Explicit (channel, roomType, ratePlan) mapping (active product mappings of
 * the channel). Authoritative only for the channels the list covers; a channel
 * absent from it falls back to `cell.sync` keys and then `mappedProducts`
 * (rate-grid-utils.isChannelMappedForProduct).
 */
export interface ChannelProductMappingLite {
  channelId: string;
  roomTypeId: string;
  ratePlanId: string;
}

export interface CocoaRateGridProps {
  response: RateGridResponse;
  /** Visible calendar days (YYYY-MM-DD), in order. */
  dates: string[];
  view: RateGridView;
  layers: RateGridLayers;
  draft: DraftState;
  selection: Selection;
  onSelectionChange: (selection: Selection) => void;
  /** One patch per edited cell (inline edit, Supr, paste, fill, convert/revert). */
  onCellEdit: (patch: RateGridCellPatch) => void;
  /** Fired when a drag-selection of ≥ 2 cells is released or on Ctrl/Cmd+Enter. */
  onOpenQuickEdit: (selection: Selection, anchorRect?: DOMRect) => void;
  /** Ctrl/Cmd+B or "Más opciones…" — prefilled from the selection when present. */
  onOpenBulkEdit: (prefill?: BulkEditPrefill) => void;
  onCellRecommendationAction: (cellKey: CellKey, action: RecommendationAction, value?: number) => void;
  /** Channel whose effective price the response was computed for (view "rates" with a channel filter). */
  channelIdForView?: string;
  readOnly?: boolean;
  density?: RateGridDensity;
  /** Property name used in the grid aria-label ("Tarifas de <propiedad>"). */
  propertyName?: string;
  /** Show the editable "Disponibles" row per room type (default: true when inventory is present). */
  showAvailability?: boolean;
  canEditAvailability?: boolean;
  /** Explicit channel mappings (channels view rows + publish counts). */
  channelMappings?: ChannelProductMappingLite[];
  /** Undo / redo requests coming from the keyboard (Ctrl/Cmd+Z / Shift+Z). */
  onUndo?: () => void;
  onRedo?: () => void;
  /** Supr on a non-derived cell: drop its draft entry (revert to persisted value). */
  onDiscardCells?: (keys: CellKey[]) => void;
  /** Row-group collapse state is internal by default; pass to control it. */
  collapsedRoomTypeIds?: string[];
  onCollapsedChange?: (ids: string[]) => void;
  /** Max height of the scroll container (CSS length). Default "70vh". */
  maxHeight?: string | number;
  /** Optional: today's date (YYYY-MM-DD) for the "hoy" marker; defaults to the local date. */
  today?: string;
  /** Click on a cell's "→ 132 €" recommendation arrow (the screen renders RecommendationPopover). */
  onOpenRecommendation?: (cellKey: CellKey, anchorRect: DOMRect) => void;
  /** Viewport size before the first layout pass (SSR / render benchmarks). */
  initialViewport?: { width: number; height: number };
  /**
   * The grid refused to open the inline editor (channel rows have no
   * per-channel price: base × markup). The screen explains it right away
   * instead of after the user typed a value.
   */
  onEditRefused?: (cellKey: CellKey, reason: "channel_price") => void;
  /**
   * GET /rate-grid answered `degraded: ["sync"]`: the per-cell sync map could
   * not be read, so every cell would look «Sin enviar». The grid hides the
   * sync dots instead and the screen explains why (cierre 2026-09-15).
   */
  syncUnavailable?: boolean;
}

/* ------------------------------------------------------------------ */
/*  Rows (internal model, exported for the screen's convenience)       */
/* ------------------------------------------------------------------ */

export type GridRow =
  | { kind: "group"; id: string; roomType: RateGridRoomType; collapsed: boolean }
  | { kind: "availability"; id: string; roomType: RateGridRoomType }
  | { kind: "plan"; id: string; roomType: RateGridRoomType; ratePlan: RateGridRatePlan; derived: boolean }
  | {
      kind: "channel";
      id: string;
      roomType: RateGridRoomType;
      ratePlan: RateGridRatePlan;
      channel: RateGridChannel;
    };

/* ------------------------------------------------------------------ */
/*  Header / demand strip                                              */
/* ------------------------------------------------------------------ */

export interface RateGridHeaderProps {
  dates: string[];
  today: string;
  demand?: RateGridDemandDay[];
  /** Column indexes fully selected (visual state). */
  selectedColumns: Set<number>;
  onSelectColumn: (colIndex: number, event: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean }) => void;
  cellWidth: number;
  labelWidth: number;
  headerHeight: number;
  /** Virtual window: first/last visible column index. */
  colStart: number;
  colEnd: number;
  totalWidth: number;
  showDemand: boolean;
  demandStripHeight: number;
}

export interface RateGridDemandStripProps {
  dates: string[];
  demand: RateGridDemandDay[];
  cellWidth: number;
  labelWidth: number;
  colStart: number;
  colEnd: number;
  height: number;
}

/* ------------------------------------------------------------------ */
/*  Quick edit                                                         */
/* ------------------------------------------------------------------ */

export type TriState = "unchanged" | "on" | "off";

export interface QuickEditResult {
  /** Raw expression typed ("132", "+10%", "-5", "=BAR-10%"); empty = no price change. */
  priceExpression: string;
  restrictions: RateRestrictionsPatch;
}

export interface QuickEditPopoverProps {
  open: boolean;
  /** Viewport rect to anchor to (bounding rect of the selection or active cell). */
  anchorRect: DOMRect | { top: number; left: number; width: number; height: number } | null;
  cellCount: number;
  /** True when a BAR plan exists in the grid → "=BAR…" expressions allowed. */
  hasBar: boolean;
  /** Current restriction values when the selection is homogeneous (used to preselect chips). */
  initialRestrictions?: RateRestrictions | null;
  onApply: (result: QuickEditResult) => void;
  onMoreOptions: () => void;
  onClose: () => void;
}

/* ------------------------------------------------------------------ */
/*  Bulk edit                                                          */
/* ------------------------------------------------------------------ */

export interface DateRange {
  from: string;
  to: string;
}

export interface BulkEditPrefill {
  ranges?: DateRange[];
  weekdays?: number[];
  roomTypeIds?: string[];
  ratePlanIds?: string[];
  channelIds?: string[];
}

export interface BulkEditPreviewRow {
  key: CellKey;
  roomTypeName: string;
  ratePlanCode: string;
  date: string;
  beforePrice: number | null;
  afterPrice: number | null;
  restrictionsSummary: string | null;
  derived: boolean;
  conflict: boolean;
}

export interface BulkEditPreview {
  affectedCells: number;
  roomTypes: number;
  days: number;
  ratePlans: number;
  /** Sample of the first N rows. */
  sample: BulkEditPreviewRow[];
  /** Cells that carry a manual override on a derived plan. */
  conflicts: CellKey[];
  derivedRecalculated: number;
  /** "BAR 118→130 € (+10 %)" style headline for the first affected plan. */
  headline: string | null;
}

export interface BulkEditSubmission {
  /** One op per date range (the contract scope has a single from/to). */
  ops: RateGridBulkOp[];
  reason: string;
  /** Client-side preview patches (before/after) so the draft can show them immediately. */
  patches: Array<{ patch: RateGridCellPatch; before: CellBeforeSnapshot }>;
  overwriteManual: boolean;
}

export interface BulkEditSheetProps {
  open: boolean;
  response: RateGridResponse;
  draft: DraftState;
  prefill?: BulkEditPrefill;
  /** Default range when no prefill: the visible dates. */
  defaultRange: DateRange;
  /** Reason presets shown in the list. */
  reasonPresets?: string[];
  onApply: (submission: BulkEditSubmission) => void;
  onClose: () => void;
}

/* ------------------------------------------------------------------ */
/*  Review & publish                                                   */
/* ------------------------------------------------------------------ */

export interface DiffItem {
  key: CellKey;
  ratePlanId: string;
  roomTypeId: string;
  date: string;
  channelId?: string | null;
  field: string;
  before: unknown;
  after: unknown;
  who?: string | null;
  at?: string | null;
}

export interface DiffRange {
  ratePlanId: string;
  roomTypeId: string;
  field: string;
  from: string;
  to: string;
  count: number;
  before: unknown;
  after: unknown;
  who?: string | null;
}

export interface DiffGroup {
  roomTypeId: string;
  roomTypeName: string;
  plans: Array<{
    ratePlanId: string;
    ratePlanCode: string;
    ratePlanName: string;
    ranges: DiffRange[];
    cellCount: number;
  }>;
  cellCount: number;
}

export type ChannelPublishProgress = {
  channelId: string;
  status: "idle" | "queued" | "sending" | "done" | "error";
  queued?: number;
  confirmed?: number;
  rejected?: number;
  message?: string | null;
};

export interface PublishState {
  phase: "idle" | "saving" | "publishing" | "done" | "error";
  byChannel: ChannelPublishProgress[];
  error?: string | null;
  journalId?: string | null;
  /** Cells the publish/push covered (single unit for the drawer's copy). */
  cells?: number;
}

/**
 * Cells already persisted in Anfitorio but never sent to the channels: a
 * «Guardar sin enviar» or a revert leaves the PMS selling the new value while
 * every channel keeps the old one. The status bar and the sync panel expose
 * this so there is a path to POST /rate-grid/push without re-editing.
 */
export interface PendingPush {
  source: "save" | "revert";
  count: number;
  from: string;
  to: string;
  ratePlanIds: string[];
  roomTypeIds: string[];
  /** Journal entry the push belongs to (stamps pushedTo/pushStatus on the API). */
  journalId: string | null;
  /** ISO timestamp of the save/revert. */
  at: string;
  /** Channels the reverted entry had been published to (revert only). */
  channelIds?: string[];
}

export interface ReviewPublishDrawerProps {
  open: boolean;
  response: RateGridResponse;
  draft: DraftState;
  channels: RateGridChannel[];
  channelMappings?: ChannelProductMappingLite[];
  /** Initially selected channel ids (default: all with mappings and readyToPush). */
  initialChannelIds?: string[];
  publishState: PublishState;
  currentUserLabel?: string | null;
  /** Publish the draft (bulk-update + publish.channelIds). No scheduling: the API has no `scheduleAt`. */
  onPublish: (args: { channelIds: string[] }) => void;
  onSaveDraftOnly?: () => void;
  onClose: () => void;
  /** With an empty draft the drawer offers to send these already-saved cells (POST /rate-grid/push). */
  pendingPush?: PendingPush | null;
  onPushPending?: (args: { channelIds: string[] }) => void;
}

/* ------------------------------------------------------------------ */
/*  Sync status                                                        */
/* ------------------------------------------------------------------ */

export interface SyncMatrixCell {
  key: CellKey;
  ratePlanId: string;
  roomTypeId: string;
  date: string;
  byChannel: Record<string, CellSyncState>;
}

export interface SyncStatusPanelProps {
  open: boolean;
  channels: RateGridChannel[];
  cells: SyncMatrixCell[];
  roomTypes: RateGridRoomType[];
  ratePlans: RateGridRatePlan[];
  summary?: Record<string, Partial<Record<CellSyncStatus, number>>>;
  onRetry: (args: { channelId: string; keys: CellKey[] }) => void;
  onShowInHistory: (deliveryId: string | null, key: CellKey) => void;
  onClose: () => void;
  loading?: boolean;
  /** Saved-but-unsent cells (see PendingPush) with the action that opens the send flow. */
  pendingPush?: PendingPush | null;
  onSendPending?: () => void;
  /** The API could not read the sync map (`degraded: ["sync"]`): the matrix is not trustworthy. */
  degraded?: boolean;
}

/* ------------------------------------------------------------------ */
/*  History                                                            */
/* ------------------------------------------------------------------ */

/**
 * One cell of a 409 `JOURNAL_STALE` answer to POST …/rate-journal/:id/revert:
 * the grid no longer holds the `after` the entry wrote (a later edit changed
 * it). `fields` lists what differs; the dialog offers «Forzar reversión»
 * (body `{ force: true }`) which overwrites those later edits.
 */
export interface JournalStaleCell {
  ratePlanId: string;
  roomTypeId: string;
  date: string;
  channelId?: string | null;
  fields: Array<{ field: string; expected: unknown; actual: unknown }>;
}

export interface JournalStaleDialogProps {
  open: boolean;
  cells: JournalStaleCell[];
  /** API message of the 409 (Spanish), shown under the title. */
  message?: string | null;
  roomTypes: RateGridRoomType[];
  ratePlans: RateGridRatePlan[];
  channels?: RateGridChannel[];
  reverting?: boolean;
  onForce: () => void;
  onCancel: () => void;
}

export interface HistoryDrawerProps {
  open: boolean;
  items: RateChangeJournalEntry[];
  hasMore: boolean;
  loading?: boolean;
  roomTypes: RateGridRoomType[];
  ratePlans: RateGridRatePlan[];
  /** Channels of the property: `pushedTo` ids are rendered with their names (ids stay as fallback). */
  channels?: RateGridChannel[];
  /** Items of the expanded entry (loaded on demand via onShowDiff). */
  expandedId?: string | null;
  expandedItems?: RateChangeJournalItem[] | null;
  onLoadMore: () => void;
  onRevert: (journalId: string) => void;
  onShowDiff: (journalId: string) => void;
  onClose: () => void;
}

/* ------------------------------------------------------------------ */
/*  Recommendations                                                    */
/* ------------------------------------------------------------------ */

export interface RecommendationPopoverProps {
  open: boolean;
  anchorRect: DOMRect | { top: number; left: number; width: number; height: number } | null;
  cellKey: CellKey;
  recommendation: RateGridCellRecommendation;
  currency: string;
  roomTypeName: string;
  ratePlanCode: string;
  date: string;
  onAction: (cellKey: CellKey, action: RecommendationAction, value?: number, reason?: string) => void;
  onClose: () => void;
}

/* ------------------------------------------------------------------ */
/*  Status bar                                                         */
/* ------------------------------------------------------------------ */

export interface RateGridStatusBarProps {
  draft: DraftState;
  roomTypeCount: number;
  ratePlanCount: number;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  onDiscard: () => void;
  onSaveDraft: () => void;
  onReviewAndPublish: () => void;
  saving?: boolean;
  lastSavedAt?: string | null;
  lastPublishedAt?: string | null;
  /** Restore banner: shown when a persisted draft was found (draft-store autosave). */
  restorable?: { count: number; savedAt: string } | null;
  onRestore?: () => void;
  onDiscardRestorable?: () => void;
  readOnly?: boolean;
  /** Saved-but-unsent cells: "N celdas guardadas sin enviar · Enviar a canales". */
  pendingPush?: PendingPush | null;
  onSendPending?: () => void;
  /** GET /rate-grid answered `degraded: ["sync"]`: show «Estado de sincronización no disponible». */
  syncUnavailable?: boolean;
}

/* ------------------------------------------------------------------ */
/*  Re-exported wire types (so the screen can import everything here)   */
/* ------------------------------------------------------------------ */

export type {
  CellSyncState,
  CellSyncStatus,
  RateChangeJournalEntry,
  RateChangeJournalItem,
  RateGridBulkOp,
  RateGridCell,
  RateGridCellPatch,
  RateGridCellRecommendation,
  RateGridChannel,
  RateGridDemandDay,
  RateGridRatePlan,
  RateGridResponse,
  RateGridRoomType,
  RateRestrictions,
  RateRestrictionsPatch
};
