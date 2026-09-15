// RateGridEditorScreen — orchestration of the rate grid v2 editor.
//
// Deep link: /backoffice/revenue/rate-grid?from&to&view&plan (URL kept in sync
// with replaceState, never pushState, so the browser back button leaves the
// screen instead of walking through every filter change).
//
// Flow
//   edit (inline / quick edit / bulk / recommendation) → DraftState (draft
//   entries + bulk ops, undo/redo, autosaved per property in localStorage)
//   → "Guardar sin enviar a canales" (bulk-update, no publish: rate_days are
//     written for real, the PMS sells the new value at once; the saved range
//     is remembered as `pendingPush` so it can still be sent to the channels)
//   → "Revisar y publicar" (bulk-update with publish.channelIds → deliveries
//     queued) or, with an empty draft and a pendingPush, "Enviar a canales"
//     (POST /rate-grid/push over the saved range)
//   → sync-status polled every 5 s while queued/sending (max 2 min)
//   → history drawer (journal with diff + revert; a revert restores rate_days
//     only, so its cells become a pendingPush of source "revert" and are shown
//     as "pendiente de reenvío" in the sync layer until sent).
//
// Failure policy: the grid is never replaced by an ErrorState. Load and save
// errors become inline notices and the draft is preserved (403 → permiso,
// 404 → the API has not been restarted with the v2 routes, 400 → toast with
// the API's Spanish message, 409 ALL_CELLS_CONFLICT → "Ninguna celda se
// aplicó" notice with the conflict list + grid reload so the current server
// values show under the kept draft; partial conflicts stay a 200 with
// `conflicts[]` and the conflicting cells stay in the draft).
//
// Optimistic concurrency (cierre 2026-09-15): every base-cell patch carries
// `expected: { price, lastModifiedAt }` from the cell's `before` snapshot;
// when someone else changed the cell meanwhile the API answers a conflict
// «la celda cambió desde que se cargó» and the flow above applies. After the
// reload the kept entries are RE-BASED on the fresh server values (draft
// action "rebase") so the diff reads server → draft and the next save no
// longer conflicts on the same stamp. A revert refused with 409
// JOURNAL_STALE opens JournalStaleDialog («Forzar reversión»).
//
// Channel prices: the API has no per-channel price override (a channel price
// is base × markup) and answers 400 when a patch/op carries channelId with a
// price. The UI therefore never sends that combination: price edits on a
// channel row (channels view) are dropped with a hint, the bulk sheet only
// applies restrictions when channels are selected, and «Precio visto por»
// (rates view with a channel filter) edits the BASE price under a visible
// notice.
//
// Ownership: this file (front-screen lot) wires services and state; the grid,
// sheets, drawers and pure helpers live in components/cocoa-rate-grid (core lot)
// and are consumed through the props contract in cocoa-rate-grid/types.ts.

import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode
} from "react";
import type {
  RateGridBulkUpdateRequest,
  RateGridCell,
  RateGridCellPatch,
  RateGridChannel,
  RateGridRatePlan,
  RateGridResponse,
  RateGridSyncStatusResponse,
  RateRecommendationsResponse
} from "@hotelos/shared";
import {
  ACTIVE_PROPERTY_EVENT,
  getActivePropertyId,
  getActivePropertyName
} from "../../services/activeProperty";
import { getUser } from "../../services/auth-storage";
import { HOTELOS_NAV_EVENT, navigateTo } from "../../lib/navigate";
import {
  ALL_CELLS_CONFLICT_CODE,
  RATE_GRID_BUSY_CODE,
  bulkUpdateRateGrid,
  classifyRateGridError,
  fetchJournalEntry,
  fetchRateGrid,
  fetchSyncStatus,
  newClientRequestId,
  pushRateGrid,
  type RateGridConflictDetail,
  type RateGridResponseWithMeta
} from "../../services/rateGridApi";
import { listChannels, listProductMappings } from "../../services/channelsApi";
import { applyRecommendations, fetchRecommendations, type ApplyRecommendationCell } from "../../services/recommendationsApi";
import { CocoaPageHeader } from "../../components/cocoa/CocoaPageHeader";
import { CocoaButton } from "../../components/cocoa/CocoaButton";
import { CocoaDatePicker } from "../../components/cocoa/CocoaDatePicker";
import { CocoaSelect } from "../../components/cocoa/CocoaSelect";
import { CocoaSegmentedControl } from "../../components/cocoa/CocoaSegmentedControl";
import { CocoaSwitch } from "../../components/cocoa/CocoaSwitch";
import { CocoaPopover } from "../../components/cocoa/CocoaPopover";
import { CocoaSheet } from "../../components/cocoa/CocoaSheet";
import { CocoaInput } from "../../components/cocoa/CocoaInput";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { useToast } from "../../components/Toast";
import { CocoaRateGrid } from "../../components/cocoa-rate-grid/CocoaRateGrid";
import { QuickEditPopover } from "../../components/cocoa-rate-grid/QuickEditPopover";
import { BulkEditSheet } from "../../components/cocoa-rate-grid/BulkEditSheet";
import { ReviewPublishDrawer } from "../../components/cocoa-rate-grid/ReviewPublishDrawer";
import { SyncStatusPanel } from "../../components/cocoa-rate-grid/SyncStatusPanel";
import { HistoryDrawer } from "../../components/cocoa-rate-grid/HistoryDrawer";
import { JournalStaleDialog } from "../../components/cocoa-rate-grid/JournalStaleDialog";
import { RecommendationPopover } from "../../components/cocoa-rate-grid/RecommendationPopover";
import { RateGridStatusBar } from "../../components/cocoa-rate-grid/RateGridStatusBar";
import {
  activeGridChannels,
  addDays,
  applyRestrictionsPatch,
  cellKey,
  clientId,
  diffDays,
  eachDay,
  expectedFromSnapshot,
  formatDateRange,
  indexCells,
  isAvailabilityKey,
  keyOfPatch,
  parseCellKey,
  pluralize,
  queuedDeliveriesSummary,
  snapshotBefore,
  summarizeRecommendations,
  todayIso,
  formatDateLong
} from "../../components/cocoa-rate-grid/helpers";
import { evaluateInput } from "../../components/cocoa-rate-grid/expressions";
import { mergePendingPush, pendingPushFromRequest } from "../../components/cocoa-rate-grid/rate-grid-utils";
import {
  canRedo,
  canUndo,
  deserializeDraft,
  draftChangeCount,
  draftIsEmpty,
  draftReducer,
  draftStorageKey,
  initialDraftStore,
  serializeDraft,
  type PatchWithBefore
} from "../../components/cocoa-rate-grid/draft-store";
import {
  AVAILABILITY_PLAN_ID,
  EMPTY_SELECTION,
  type BulkEditPrefill,
  type BulkEditSubmission,
  type CellBeforeSnapshot,
  type CellKey,
  type ChannelProductMappingLite,
  type DraftState,
  type PendingPush,
  type PublishState,
  type QuickEditResult,
  type RateGridLayers,
  type RateGridView,
  type RecommendationAction,
  type Selection,
  type SyncMatrixCell
} from "../../components/cocoa-rate-grid/types";
import { useRateJournal, type RateJournalRevertInfo } from "./RateJournalScreen";

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

const RANGE_PRESETS: ReadonlyArray<{ id: string; label: string; days: number | "quarter" }> = [
  { id: "7d", label: "7 d", days: 7 },
  { id: "14d", label: "14 d", days: 14 },
  { id: "30d", label: "30 d", days: 30 },
  { id: "90d", label: "90 d", days: 90 },
  { id: "quarter", label: "Trimestre", days: "quarter" }
];

const VIEW_OPTIONS: ReadonlyArray<{ value: RateGridView; label: string }> = [
  { value: "rates", label: "Tarifas" },
  { value: "restrictions", label: "Restricciones" },
  { value: "channels", label: "Canales" },
  { value: "recommendations", label: "Recomendaciones" }
];

/** One-line help per view (tooltip on the segmented control). */
const VIEW_HELP: Record<RateGridView, string> = {
  rates: "Tarifas: precio base por plan y tipo de habitación",
  restrictions: "Restricciones: estancia mínima, cierres a llegada/salida y cierres de venta por celda (precio atenuado)",
  channels: "Canales: precio que ve cada canal (base + recargo) y estado de envío",
  recommendations: "Recomendaciones: sugerencias de precio del motor de revenue por celda"
};

const REASON_PRESETS = ["Evento", "Compset", "Pickup lento", "Corrección", "Temporada", "Estrategia"];

const MAX_RANGE_DAYS = 366;
const SYNC_POLL_MS = 5_000;
const SYNC_POLL_MAX_MS = 120_000;

/* ------------------------------------------------------------------ */
/*  URL state                                                          */
/* ------------------------------------------------------------------ */

type UrlState = { from: string; to: string; view: RateGridView; planIds: string[] };

function isView(value: string | null): value is RateGridView {
  return VIEW_OPTIONS.some((o) => o.value === value);
}

function isIso(value: string | null): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function readUrlState(): UrlState {
  const today = todayIso();
  const fallback: UrlState = { from: today, to: addDays(today, 13), view: "rates", planIds: [] };
  if (typeof window === "undefined") return fallback;
  const params = new URLSearchParams(window.location.search);
  const from = params.get("from");
  const to = params.get("to");
  const view = params.get("view");
  const plan = params.get("plan");
  const validRange = isIso(from) && isIso(to) && from <= to && diffDays(from, to) < MAX_RANGE_DAYS;
  return {
    from: validRange ? from : fallback.from,
    to: validRange ? to : fallback.to,
    view: isView(view) ? view : "rates",
    planIds: plan ? plan.split(",").filter(Boolean) : []
  };
}

function writeUrlState(state: UrlState): void {
  if (typeof window === "undefined") return;
  const params = new URLSearchParams();
  params.set("from", state.from);
  params.set("to", state.to);
  if (state.view !== "rates") params.set("view", state.view);
  if (state.planIds.length > 0) params.set("plan", state.planIds.join(","));
  const next = `${window.location.pathname}?${params.toString()}${window.location.hash}`;
  if (`${window.location.pathname}${window.location.search}${window.location.hash}` !== next) {
    window.history.replaceState(window.history.state, "", next);
  }
}

function quarterRange(anchor: string): { from: string; to: string } {
  const [y, m] = anchor.split("-").map(Number);
  const qStartMonth = Math.floor(((m ?? 1) - 1) / 3) * 3; // 0-based
  const start = new Date(y, qStartMonth, 1);
  const end = new Date(y, qStartMonth + 3, 0);
  const iso = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  return { from: iso(start), to: iso(end) };
}

/* ------------------------------------------------------------------ */
/*  Draft persistence (localStorage per property + user; draft-store I/O) */
/* ------------------------------------------------------------------ */

function currentUserId(): string {
  return getUser()?.userId ?? "anonymous";
}

function persistDraft(propertyId: string, draft: DraftState): void {
  if (typeof window === "undefined") return;
  const key = draftStorageKey(propertyId, currentUserId());
  try {
    if (draftIsEmpty(draft)) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, serializeDraft(draft, propertyId, currentUserId()));
  } catch {
    // Quota / private mode: the in-memory draft is still the source of truth.
  }
}

function readPersistedDraft(propertyId: string): { draft: DraftState; savedAt: string } | null {
  if (typeof window === "undefined") return null;
  try {
    const userId = currentUserId();
    const parsed = deserializeDraft(window.localStorage.getItem(draftStorageKey(propertyId, userId)), propertyId, userId);
    return parsed && !draftIsEmpty(parsed.draft) ? parsed : null;
  } catch {
    return null;
  }
}

function clearPersistedDraft(propertyId: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(draftStorageKey(propertyId, currentUserId()));
  } catch {
    /* nothing to clear */
  }
}

// --- saved-but-unsent cells (pendingPush) --------------------------------
//
// A save without publish (or a revert) leaves rate_days updated while the
// channels keep the previous value. The range is kept per (property, user)
// next to the draft so an F5 does not lose the only path to send it.

function pendingPushStorageKey(propertyId: string): string {
  return `${draftStorageKey(propertyId, currentUserId())}.pending-push`;
}

function isPendingPush(value: unknown): value is PendingPush {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    (v.source === "save" || v.source === "revert") &&
    typeof v.count === "number" &&
    typeof v.from === "string" &&
    typeof v.to === "string" &&
    Array.isArray(v.ratePlanIds) &&
    Array.isArray(v.roomTypeIds) &&
    typeof v.at === "string"
  );
}

function readPendingPush(propertyId: string): PendingPush | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(pendingPushStorageKey(propertyId));
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return isPendingPush(parsed) && parsed.count > 0 ? parsed : null;
  } catch {
    return null;
  }
}

function persistPendingPush(propertyId: string, pending: PendingPush | null): void {
  if (typeof window === "undefined") return;
  try {
    if (!pending || pending.count === 0) window.localStorage.removeItem(pendingPushStorageKey(propertyId));
    else window.localStorage.setItem(pendingPushStorageKey(propertyId), JSON.stringify(pending));
  } catch {
    /* quota / private mode: the in-memory state still drives the UI */
  }
}

// --- wire translation ------------------------------------------------------

/** First plan that is not derived from another one (BAR by convention). */
function basePlanOf(ratePlans: RateGridRatePlan[]): RateGridRatePlan | null {
  return (
    ratePlans.find((p) => p.active && !p.parentRatePlanId && p.derivation.mode === "none") ??
    ratePlans.find((p) => !p.parentRatePlanId) ??
    ratePlans[0] ??
    null
  );
}

/** True when the patch carries any of the price-side fields the API refuses together with `channelId`. */
function hasPriceFields(p: RateGridCellPatch): boolean {
  return p.price !== undefined || p.occupancyPrices !== undefined || p.minPrice !== undefined || p.maxPrice !== undefined;
}

/** Drop the price-side fields of a channel patch (the API has no per-channel price: 400). */
function withoutPriceFields(p: RateGridCellPatch): RateGridCellPatch {
  const { price: _price, occupancyPrices: _occ, minPrice: _min, maxPrice: _max, convertToManual: _c, revertToDerived: _r, ...rest } = p;
  return rest;
}

/**
 * Draft → bulk-update request. Availability edits arrive keyed with the
 * sentinel plan "*" (the grid's "Disponibles" row); the wire patch needs a
 * real ratePlanId, so they are sent on the base plan carrying only
 * `available` (the backend applies availability to the room type).
 *
 * `stripped` counts channel-scoped prices removed from the wire (the editor
 * already refuses them at edit time; this is the last line of defence against
 * the API's 400 "los precios por canal se calculan con el markup del canal").
 *
 * Base-cell patches carry `expected` (price + lastModifiedAt as loaded) so a
 * concurrent edit by someone else is refused as a conflict instead of being
 * overwritten in silence. Channel restriction patches and availability
 * patches carry none: their `before` is not a RateDay snapshot.
 */
function buildBulkRequest(
  draft: DraftState,
  ratePlans: RateGridRatePlan[],
  reason: string,
  publish?: RateGridBulkUpdateRequest["publish"]
): { req: RateGridBulkUpdateRequest; stripped: number } {
  const basePlan = basePlanOf(ratePlans);
  const cells: RateGridCellPatch[] = [];
  let stripped = 0;
  for (const entry of draft.patches.values()) {
    const p = entry.patch;
    if (isAvailabilityKey(entry.key) || p.ratePlanId === AVAILABILITY_PLAN_ID) {
      if (p.available === undefined) continue;
      if (!basePlan) continue;
      cells.push({ ratePlanId: basePlan.id, roomTypeId: p.roomTypeId, date: p.date, available: p.available });
      continue;
    }
    // Ops already cover their preview cells on the server side; sending the
    // preview patches too would double-apply percent ops. Skip them.
    if (entry.origin === "bulk") continue;
    if (p.channelId && (hasPriceFields(p) || p.convertToManual || p.revertToDerived)) {
      stripped += 1;
      const rest = withoutPriceFields(p);
      if (rest.restrictions && Object.keys(rest.restrictions).length > 0) cells.push(rest);
      continue;
    }
    if (p.channelId) {
      cells.push(p);
      continue;
    }
    const expected = expectedFromSnapshot(entry.before);
    cells.push(expected ? { ...p, expected } : p);
  }
  const ops = draft.ops.map((o) => {
    if (o.op.price && o.op.scope.channelIds && o.op.scope.channelIds.length > 0) {
      stripped += 1;
      const { price: _price, ...rest } = o.op;
      return rest;
    }
    return o.op;
  });
  const req: RateGridBulkUpdateRequest = { reason, clientRequestId: newClientRequestId() };
  if (cells.length > 0) req.cells = cells;
  if (ops.length > 0) req.ops = ops;
  if (publish) req.publish = publish;
  return { req, stripped };
}

/** Draft entries that came from a recommendation keep this reason even after a manual re-edit (draft-store keeps `prev.reason`). */
const RECOMMENDATION_REASON_RE = /^Recomendación (aceptada|ajustada)/;

/** "Booking.com aplica +12 %" — hint for channel-scoped price edits. */
function channelMarkupLabel(channels: RateGridChannel[], channelId: string): string {
  const ch = channels.find((c) => c.id === channelId);
  if (!ch) return "el canal aplica su recargo";
  return `${ch.name} aplica ${ch.markupPercent >= 0 ? "+" : ""}${ch.markupPercent} %`;
}

/* ------------------------------------------------------------------ */
/*  Small UI pieces                                                    */
/* ------------------------------------------------------------------ */

type NoticeTone = "info" | "warning" | "danger" | "success";

const NOTICE_COLORS: Record<NoticeTone, { border: string; fg: string }> = {
  info: { border: "var(--cocoa-accent)", fg: "var(--cocoa-label)" },
  warning: { border: "var(--cocoa-warning, #b8860b)", fg: "var(--cocoa-label)" },
  danger: { border: "var(--cocoa-danger)", fg: "var(--cocoa-label)" },
  success: { border: "var(--cocoa-success)", fg: "var(--cocoa-label)" }
};

function InlineNotice(props: { tone: NoticeTone; title?: string; children: ReactNode; action?: ReactNode; onDismiss?: () => void }) {
  const colors = NOTICE_COLORS[props.tone];
  const style: CSSProperties = {
    display: "flex",
    alignItems: "flex-start",
    gap: "var(--cocoa-space-3)",
    padding: "var(--cocoa-space-3)",
    borderRadius: "var(--cocoa-radius-md)",
    border: "1px solid var(--cocoa-separator)",
    borderLeft: `4px solid ${colors.border}`,
    background: "var(--cocoa-background-content)",
    color: colors.fg,
    fontFamily: "var(--cocoa-font)",
    fontSize: "var(--cocoa-fs-body)"
  };
  return (
    <div role={props.tone === "danger" ? "alert" : "status"} style={style}>
      <div style={{ flex: 1, minWidth: 0 }}>
        {props.title ? <strong style={{ display: "block", marginBottom: 2 }}>{props.title}</strong> : null}
        <div>{props.children}</div>
      </div>
      {props.action}
      {props.onDismiss ? (
        <CocoaButton variant="plain" size="small" tone="neutral" onClick={props.onDismiss} aria-label="Cerrar aviso">
          ✕
        </CocoaButton>
      ) : null}
    </div>
  );
}

const chipStyle = (active: boolean): CSSProperties => ({
  padding: "3px 10px",
  borderRadius: "var(--cocoa-radius-full)",
  border: `1px solid ${active ? "var(--cocoa-accent)" : "var(--cocoa-separator)"}`,
  background: active ? "var(--cocoa-accent)" : "var(--cocoa-background-control)",
  color: active ? "var(--cocoa-accent-contrast, #fff)" : "var(--cocoa-label)",
  fontFamily: "var(--cocoa-font)",
  fontSize: "var(--cocoa-fs-subheadline)",
  cursor: "pointer",
  lineHeight: 1.4
});

const fieldLabelStyle: CSSProperties = {
  fontSize: "var(--cocoa-fs-caption)",
  fontWeight: 600,
  color: "var(--cocoa-label-secondary)",
  textTransform: "uppercase",
  letterSpacing: "var(--cocoa-tracking-wide)"
};

/** Multi-select with search (room types / rate plans filters). */
function MultiSelectFilter(props: {
  label: string;
  options: Array<{ id: string; label: string; hint?: string }>;
  value: string[];
  onChange: (ids: string[]) => void;
  emptyLabel: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const anchorRef = useRef<HTMLButtonElement>(null);
  const selectedSet = useMemo(() => new Set(props.value), [props.value]);
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? props.options.filter((o) => `${o.label} ${o.hint ?? ""}`.toLowerCase().includes(q)) : props.options;
  }, [props.options, query]);
  const summary =
    props.value.length === 0
      ? props.emptyLabel
      : props.value.length <= 2
        ? props.options
            .filter((o) => selectedSet.has(o.id))
            .map((o) => o.label)
            .join(", ")
        : `${props.value.length} seleccionados`;
  function toggle(id: string) {
    props.onChange(selectedSet.has(id) ? props.value.filter((v) => v !== id) : [...props.value, id]);
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 160 }}>
      <span style={fieldLabelStyle}>{props.label}</span>
      <button
        ref={anchorRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        style={{
          height: 28,
          padding: "0 10px",
          textAlign: "left",
          borderRadius: "var(--cocoa-radius-md)",
          border: "1px solid var(--cocoa-separator)",
          background: "var(--cocoa-background-control)",
          color: "var(--cocoa-label)",
          fontFamily: "var(--cocoa-font)",
          fontSize: "var(--cocoa-fs-body)",
          cursor: "pointer",
          maxWidth: 240,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap"
        }}
      >
        {summary} ▾
      </button>
      <CocoaPopover open={open} anchorEl={anchorRef.current} placement="bottom" onClose={() => setOpen(false)}>
        <div style={{ padding: 8, width: 260, display: "flex", flexDirection: "column", gap: 6 }}>
          <CocoaInput value={query} onChange={setQuery} placeholder="Buscar…" size="small" />
          <div role="listbox" aria-multiselectable style={{ maxHeight: 240, overflow: "auto", display: "flex", flexDirection: "column" }}>
            {visible.length === 0 ? (
              <span style={{ padding: 6, color: "var(--cocoa-label-tertiary)", fontSize: "var(--cocoa-fs-callout)" }}>Sin resultados</span>
            ) : (
              visible.map((o) => (
                <label
                  key={o.id}
                  role="option"
                  aria-selected={selectedSet.has(o.id)}
                  style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 6px", cursor: "pointer", fontSize: "var(--cocoa-fs-body)" }}
                >
                  <input type="checkbox" checked={selectedSet.has(o.id)} onChange={() => toggle(o.id)} />
                  <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>{o.label}</span>
                  {o.hint ? <span style={{ color: "var(--cocoa-label-tertiary)", fontSize: "var(--cocoa-fs-caption)" }}>{o.hint}</span> : null}
                </label>
              ))
            )}
          </div>
          <div style={{ display: "flex", justifyContent: "space-between" }}>
            <CocoaButton variant="plain" size="small" tone="neutral" onClick={() => props.onChange([])}>
              Todos
            </CocoaButton>
            <CocoaButton variant="tinted" size="small" tone="accent" onClick={() => setOpen(false)}>
              Listo
            </CocoaButton>
          </div>
        </div>
      </CocoaPopover>
    </div>
  );
}

/** Mandatory journal reason (presets + free text). */
function ReasonSheet(props: { open: boolean; initial: string; onConfirm: (reason: string) => void; onClose: () => void; title: string }) {
  const [text, setText] = useState(props.initial);
  useEffect(() => {
    if (props.open) setText(props.initial);
  }, [props.open, props.initial]);
  const value = text.trim();
  return (
    <CocoaSheet
      open={props.open}
      onClose={props.onClose}
      title={props.title}
      size="sm"
      footer={
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <CocoaButton variant="bordered" tone="neutral" onClick={props.onClose}>
            Cancelar
          </CocoaButton>
          <CocoaButton variant="filled" tone="accent" disabled={value.length === 0} onClick={() => props.onConfirm(value)}>
            Continuar
          </CocoaButton>
        </div>
      }
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <p style={{ margin: 0, color: "var(--cocoa-label-secondary)", fontSize: "var(--cocoa-fs-body)" }}>
          El motivo queda en el historial junto al diff de cada celda. Elige uno o escribe el tuyo.
        </p>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {REASON_PRESETS.map((preset) => (
            <button key={preset} type="button" style={chipStyle(text === preset)} onClick={() => setText(preset)}>
              {preset}
            </button>
          ))}
        </div>
        <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span style={fieldLabelStyle}>Motivo</span>
          <CocoaInput value={text} onChange={setText} placeholder="Motivo del cambio…" />
        </label>
      </div>
    </CocoaSheet>
  );
}

function NoChannelsPanel(props: { compact?: boolean }) {
  return (
    <InlineNotice
      tone="info"
      title="Sin canales conectados"
      action={
        <CocoaButton variant="tinted" size="small" tone="accent" onClick={() => navigateTo("ChannelAggregatorHub")}>
          Dar de alta un canal
        </CocoaButton>
      }
    >
      {props.compact
        ? "Los cambios se guardan en Anfitorio pero no se publican en ninguna OTA."
        : "Los cambios se guardan en Anfitorio pero no llegan a ninguna OTA hasta que conectes un canal. Puedes empezar en modo stub o sandbox (sin credenciales reales): las entregas se registran y simulan, nada sale a Internet hasta que actives el modo real con credenciales."}
    </InlineNotice>
  );
}

/* ------------------------------------------------------------------ */
/*  Screen                                                             */
/* ------------------------------------------------------------------ */

type LoadNotice = { tone: NoticeTone; title?: string; text: string; conflicts?: RateGridConflictDetail[]; id: number };

export function RateGridEditorScreen() {
  const { showToast } = useToast();
  const [propertyId, setPropertyId] = useState(() => getActivePropertyId());
  const propertyName = getActivePropertyName();
  const currentUser = useMemo(() => getUser(), []);

  // --- URL-backed filters ---
  const [urlState, setUrlState] = useState<UrlState>(() => readUrlState());
  const { from, to, view, planIds } = urlState;
  const [roomTypeIds, setRoomTypeIds] = useState<string[]>([]);
  const [channelIdForView, setChannelIdForView] = useState<string>("");
  const [layers, setLayers] = useState<RateGridLayers>({ demand: false, recommendations: false, sync: false });
  // Secondary filters (types / plans / channel price) live in a second row
  // that is collapsed by default: at 1024×768 six toolbar groups wrapped into
  // five rows and pushed the grid below the fold.
  const [filtersOpen, setFiltersOpen] = useState<boolean>(() => {
    const initial = readUrlState();
    return initial.planIds.length > 0;
  });
  useEffect(() => writeUrlState(urlState), [urlState]);

  const setRange = useCallback((nextFrom: string, nextTo: string) => {
    setUrlState((s) => ({ ...s, from: nextFrom, to: nextTo }));
  }, []);
  const setView = useCallback((next: RateGridView) => setUrlState((s) => ({ ...s, view: next })), []);
  const setPlanIds = useCallback((ids: string[]) => setUrlState((s) => ({ ...s, planIds: ids })), []);

  const rangeDays = diffDays(from, to) + 1;
  const dates = useMemo(() => eachDay(from, to), [from, to]);
  const today = todayIso();

  // --- grid data ---
  const [response, setResponse] = useState<RateGridResponseWithMeta | null>(null);
  const [loading, setLoading] = useState(true);
  const [notices, setNotices] = useState<LoadNotice[]>([]);
  const noticeSeq = useRef(0);
  const pushNotice = useCallback((n: Omit<LoadNotice, "id">) => {
    noticeSeq.current += 1;
    const id = noticeSeq.current;
    setNotices((prev) => [...prev.filter((p) => !(p.tone === n.tone && p.text === n.text)), { ...n, id }]);
    return id;
  }, []);
  const dismissNotice = useCallback((id: number) => setNotices((prev) => prev.filter((p) => p.id !== id)), []);
  const loadSeq = useRef(0);

  /** Reloads the grid; resolves the fresh response (null when superseded by a newer load or failed). */
  const loadGrid = useCallback(async (): Promise<RateGridResponseWithMeta | null> => {
    loadSeq.current += 1;
    const seq = loadSeq.current;
    setLoading(true);
    try {
      const res = await fetchRateGrid({
        propertyId,
        from,
        to,
        ratePlanIds: planIds.length > 0 ? planIds : undefined,
        roomTypeIds: roomTypeIds.length > 0 ? roomTypeIds : undefined,
        channelId: channelIdForView || undefined,
        demand: layers.demand
      });
      if (seq !== loadSeq.current) return null;
      setResponse(res);
      setNotices((prev) => prev.filter((n) => n.title !== "No se pudo cargar la parrilla"));
      if (res.legacyShape) {
        pushNotice({
          tone: "warning",
          title: "El API responde con el formato antiguo",
          text: "Se muestra la parrilla en solo lectura. Para editar hace falta reiniciar el API con el módulo rate-manager v2 (rutas /properties/:id/rate-grid v2)."
        });
      }
      return res;
    } catch (err) {
      if (seq !== loadSeq.current) return null;
      const info = classifyRateGridError(err);
      pushNotice({
        tone: info.kind === "forbidden" ? "warning" : "danger",
        title: "No se pudo cargar la parrilla",
        text:
          info.kind === "forbidden"
            ? "No tienes permiso para ver las tarifas de esta propiedad (revenue.read)."
            : info.message
      });
      return null;
    } finally {
      if (seq === loadSeq.current) setLoading(false);
    }
  }, [propertyId, from, to, planIds, roomTypeIds, channelIdForView, layers.demand, pushNotice]);

  useEffect(() => {
    void loadGrid();
  }, [loadGrid]);

  // --- channels (admin list: mappedProducts / readiness for the publish drawer) ---
  const [channels, setChannels] = useState<RateGridChannel[] | null>(null);
  const [channelsError, setChannelsError] = useState<string | null>(null);
  const loadChannels = useCallback(async () => {
    try {
      const rows = await listChannels(propertyId);
      setChannels(rows);
      setChannelsError(null);
    } catch (err) {
      const info = classifyRateGridError(err);
      // The grid response also carries channels; the notice only matters when both fail.
      setChannelsError(info.kind === "not_deployed" ? "La lista de canales v2 (GET /properties/:id/channels) no está disponible en este API." : info.message);
      setChannels(null);
    }
  }, [propertyId]);
  useEffect(() => {
    void loadChannels();
  }, [loadChannels]);

  // Every channel of the property (names for the history) vs. the ones the
  // editor lists: inactive/paused channels are noise in «Precio visto por»,
  // the channels view and the publish drawer.
  const allChannels: RateGridChannel[] = useMemo(() => channels ?? response?.channels ?? [], [channels, response]);
  const effectiveChannels: RateGridChannel[] = useMemo(() => activeGridChannels(allChannels), [allChannels]);

  // --- product mappings per channel (channels view rows + publish counts) ---
  //
  // The REAL mappings (GET /channel-manager/channels/:id/product-mappings,
  // active rows) of every channel the editor lists. They used to be inferred
  // from the `cell.sync` keys of the loaded window, which only proves a
  // delivery happened: after publishing one IND cell the drawer offered «0
  // canales» for a DBL draft in the same window (browser-ux-final#1). A
  // channel whose request fails stays out of the list and the grid falls back
  // to its `mappedProducts` count (rate-grid-utils.isChannelMappedForProduct).
  const [productMappings, setProductMappings] = useState<ChannelProductMappingLite[] | null>(null);
  const mappingsSeq = useRef(0);
  const effectiveChannelIds = useMemo(() => effectiveChannels.map((c) => c.id).sort().join(","), [effectiveChannels]);
  const loadProductMappings = useCallback(async () => {
    const ids = effectiveChannelIds ? effectiveChannelIds.split(",") : [];
    mappingsSeq.current += 1;
    const seq = mappingsSeq.current;
    if (ids.length === 0) {
      setProductMappings(null);
      return;
    }
    const results = await Promise.allSettled(ids.map((id) => listProductMappings(id)));
    if (seq !== mappingsSeq.current) return;
    const out: ChannelProductMappingLite[] = [];
    results.forEach((r, i) => {
      if (r.status !== "fulfilled") return;
      for (const m of r.value) {
        if (m.status !== "active") continue;
        out.push({ channelId: ids[i], roomTypeId: m.roomTypeId, ratePlanId: m.ratePlanId });
      }
    });
    setProductMappings(out);
  }, [effectiveChannelIds]);
  useEffect(() => {
    void loadProductMappings();
  }, [loadProductMappings]);

  // --- draft (core draft-store reducer: merge rules, undo/redo, no-op pruning) ---
  const [store, dispatch] = useReducer(draftReducer, undefined, () => initialDraftStore());
  const draft = store.present;
  const [restorable, setRestorable] = useState<{ count: number; savedAt: string; draft: DraftState } | null>(() => {
    const persisted = readPersistedDraft(getActivePropertyId());
    return persisted ? { count: draftChangeCount(persisted.draft), savedAt: persisted.savedAt, draft: persisted.draft } : null;
  });
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const propertyRef = useRef(propertyId);
  propertyRef.current = propertyId;

  // Autosave per (property, user) so a reload (property switch, F5) can offer to restore it.
  useEffect(() => {
    if (restorable) {
      // Never overwrite a restorable draft with the (empty) fresh one; once the
      // user starts editing without restoring, the new draft wins.
      if (draftIsEmpty(draft)) return;
      setRestorable(null);
    }
    persistDraft(propertyId, draft);
  }, [draft, propertyId, restorable]);

  const undo = useCallback(() => dispatch({ type: "undo" }), []);
  const redo = useCallback(() => dispatch({ type: "redo" }), []);

  const discardDraft = useCallback(() => {
    dispatch({ type: "clear" });
    clearPersistedDraft(propertyId);
  }, [propertyId]);

  const restoreDraft = useCallback(() => {
    if (!restorable) return;
    dispatch({ type: "restore", draft: restorable.draft });
    setRestorable(null);
    showToast(`Cambios recuperados: ${pluralize(restorable.count, "celda", "celdas")}.`, { variant: "info" });
  }, [restorable, showToast]);

  const discardRestorable = useCallback(() => {
    clearPersistedDraft(propertyId);
    setRestorable(null);
  }, [propertyId]);

  // --- active property changes (switcher reloads the page; keep the draft first) ---
  useEffect(() => {
    function onPropertyChange() {
      persistDraft(propertyRef.current, draftRef.current);
      const next = getActivePropertyId();
      if (next !== propertyRef.current) {
        setPropertyId(next);
        dispatch({ type: "restore", draft: initialDraftStore().present });
        setResponse(null);
        const persisted = readPersistedDraft(next);
        setRestorable(persisted ? { count: draftChangeCount(persisted.draft), savedAt: persisted.savedAt, draft: persisted.draft } : null);
        setPendingPush(readPendingPush(next));
        setResendKeys(new Set());
      }
    }
    window.addEventListener(ACTIVE_PROPERTY_EVENT, onPropertyChange);
    window.addEventListener("storage", onPropertyChange);
    return () => {
      window.removeEventListener(ACTIVE_PROPERTY_EVENT, onPropertyChange);
      window.removeEventListener("storage", onPropertyChange);
    };
  }, []);

  // --- navigation guard ---
  const [pendingNav, setPendingNav] = useState<string | null>(null);
  const bypassGuardRef = useRef(false);
  useEffect(() => {
    function onBeforeUnload(event: BeforeUnloadEvent) {
      if (draftIsEmpty(draftRef.current)) return;
      persistDraft(propertyRef.current, draftRef.current);
      event.preventDefault();
      event.returnValue = "";
    }
    function onNav(event: Event) {
      if (bypassGuardRef.current || draftIsEmpty(draftRef.current)) return;
      const detail = (event as CustomEvent<string>).detail;
      if (!detail || detail.startsWith("RateGridEditorScreen")) return;
      // Sidebar / ⌘K go through App.selectScreen, which dispatches a cancelable
      // event: veto it and keep the other emitters (non-cancelable) from
      // reaching App's listener too.
      event.preventDefault();
      event.stopImmediatePropagation();
      setPendingNav(detail);
    }
    window.addEventListener("beforeunload", onBeforeUnload);
    // Capture phase: runs before App.tsx's bubble listener on the same target.
    window.addEventListener(HOTELOS_NAV_EVENT, onNav, true);
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
      window.removeEventListener(HOTELOS_NAV_EVENT, onNav, true);
    };
  }, []);

  const confirmLeave = useCallback(() => {
    if (!pendingNav) return;
    persistDraft(propertyId, draftRef.current);
    bypassGuardRef.current = true;
    window.dispatchEvent(new CustomEvent<string>(HOTELOS_NAV_EVENT, { detail: pendingNav }));
    bypassGuardRef.current = false;
    setPendingNav(null);
  }, [pendingNav, propertyId]);

  // --- selection / quick edit / bulk edit ---
  const [selection, setSelection] = useState<Selection>(EMPTY_SELECTION);
  const [quickEdit, setQuickEdit] = useState<{ open: boolean; anchorRect: DOMRect | null; keys: CellKey[] }>({ open: false, anchorRect: null, keys: [] });
  const [bulkEdit, setBulkEdit] = useState<{ open: boolean; prefill?: BulkEditPrefill }>({ open: false });

  const cellIndex = useMemo(() => indexCells(response?.cells ?? []), [response]);
  const barPlan = useMemo(() => (response ? basePlanOf(response.ratePlans) : null), [response]);
  const readOnly = Boolean(response?.legacyShape) || !response;

  const beforeFor = useCallback((key: CellKey): CellBeforeSnapshot => {
    const existing = draftRef.current.patches.get(key);
    if (existing) return existing.before;
    return snapshotBefore(cellIndex.get(key));
  }, [cellIndex]);

  /**
   * After a conflict the grid is reloaded and the kept base-cell entries get
   * a fresh `before` (price + lastModifiedAt now on the server): the diff
   * reads server → draft and the next save carries a current `expected`.
   * Availability and channel entries keep theirs (no RateDay snapshot).
   */
  const rebaseDraftOn = useCallback((fresh: RateGridResponse) => {
    const idx = indexCells(fresh.cells);
    const snapshots = new Map<CellKey, CellBeforeSnapshot>();
    for (const key of draftRef.current.patches.keys()) {
      if (isAvailabilityKey(key) || parseCellKey(key).channelId) continue;
      snapshots.set(key, snapshotBefore(idx.get(key)));
    }
    if (snapshots.size > 0) dispatch({ type: "rebase", snapshots });
  }, []);

  const effectiveChannelsRef = useRef(effectiveChannels);
  effectiveChannelsRef.current = effectiveChannels;

  const handleCellEdit = useCallback(
    (patch: RateGridCellPatch) => {
      if (readOnly) return;
      let next = patch;
      if (patch.channelId && (hasPriceFields(patch) || patch.convertToManual || patch.revertToDerived)) {
        // Channel rows (channels view) only take restrictions: the API has no
        // per-channel price (base × markup) and answers 400 otherwise.
        next = withoutPriceFields(patch);
        showToast(
          `Los precios por canal se calculan con el recargo del canal (${channelMarkupLabel(effectiveChannelsRef.current, patch.channelId)}). Edita el precio en la fila del plan; en la fila del canal solo se editan restricciones.`,
          { variant: "info" }
        );
        if (!next.restrictions || Object.keys(next.restrictions).length === 0) return;
      }
      dispatch({ type: "cell", patch: next, before: beforeFor(keyOfPatch(next)) });
    },
    [readOnly, beforeFor, showToast]
  );

  // The grid refuses the inline editor on channel rows BEFORE any typing:
  // explain it right away (the old flow only warned after Enter).
  const handleEditRefused = useCallback(
    (key: CellKey) => {
      const parsed = parseCellKey(key);
      const label = parsed.channelId ? channelMarkupLabel(effectiveChannelsRef.current, parsed.channelId) : "el canal aplica su recargo";
      showToast(`El precio de una fila de canal se calcula con el recargo del canal (${label}) y no se edita aquí: cambia el precio en la fila del plan. Para las restricciones del canal usa la edición rápida (selecciona celdas) o la masiva.`, { variant: "info" });
    },
    [showToast]
  );

  const handleDiscardCells = useCallback((keys: CellKey[]) => dispatch({ type: "discardCells", keys }), []);

  const handleOpenQuickEdit = useCallback((sel: Selection, anchorRect?: DOMRect) => {
    if (sel.keys.length === 0) return;
    setQuickEdit({ open: true, anchorRect: anchorRect ?? null, keys: sel.keys });
  }, []);

  const applyQuickEdit = useCallback(
    (result: QuickEditResult) => {
      if (!response) return;
      const entries: PatchWithBefore[] = [];
      const skipped: string[] = [];
      let channelPriceSkipped = 0;
      for (const key of quickEdit.keys) {
        if (isAvailabilityKey(key)) continue;
        const parsed = parseCellKey(key);
        const cell = cellIndex.get(key);
        const entry = draftRef.current.patches.get(key);
        const current = entry?.patch.price ?? cell?.basePrice ?? null;
        const patch: RateGridCellPatch = { ratePlanId: parsed.ratePlanId, roomTypeId: parsed.roomTypeId, date: parsed.date };
        if (parsed.channelId) patch.channelId = parsed.channelId;
        if (parsed.channelId && result.priceExpression.trim() !== "") {
          // No per-channel price on the API (400): the restrictions still apply to the channel row.
          channelPriceSkipped += 1;
        } else if (result.priceExpression.trim() !== "") {
          const barCell = barPlan ? cellIndex.get(cellKey(barPlan.id, parsed.roomTypeId, parsed.date)) : undefined;
          const evaluated = evaluateInput(result.priceExpression, { current, bar: barCell?.basePrice ?? null, hasBar: Boolean(barPlan) });
          if (!evaluated.ok) {
            skipped.push(`${parsed.date}: ${evaluated.error}`);
            continue;
          }
          patch.price = evaluated.value;
          if (cell?.derivedFrom && cell.source === "derived") patch.convertToManual = true;
        }
        if (Object.keys(result.restrictions).length > 0) patch.restrictions = result.restrictions;
        if (patch.price === undefined && !patch.restrictions) continue;
        entries.push({ patch, before: beforeFor(key) });
      }
      dispatch({ type: "quick", patches: entries });
      setQuickEdit({ open: false, anchorRect: null, keys: [] });
      if (skipped.length > 0) showToast(`${skipped.length} celdas sin aplicar (${skipped[0]}).`, { variant: "info" });
      if (channelPriceSkipped > 0) {
        showToast(
          `${channelPriceSkipped} celdas de canal sin precio: los precios por canal se calculan con el markup del canal. Edita el precio en la fila del plan.`,
          { variant: "info" }
        );
      }
    },
    [response, quickEdit.keys, cellIndex, barPlan, beforeFor, showToast]
  );

  const handleOpenBulkEdit = useCallback(
    (prefill?: BulkEditPrefill) => {
      const fromSelection: BulkEditPrefill | undefined =
        !prefill && selection.keys.length > 0
          ? (() => {
              const parsed = selection.keys.filter((k) => !isAvailabilityKey(k)).map(parseCellKey);
              const ds = parsed.map((p) => p.date).sort();
              return {
                ranges: ds.length > 0 ? [{ from: ds[0], to: ds[ds.length - 1] }] : undefined,
                roomTypeIds: Array.from(new Set(parsed.map((p) => p.roomTypeId))),
                ratePlanIds: Array.from(new Set(parsed.map((p) => p.ratePlanId)))
              };
            })()
          : undefined;
      setBulkEdit({ open: true, prefill: prefill ?? fromSelection });
    },
    [selection.keys]
  );

  const applyBulkSubmission = useCallback(
    (submission: BulkEditSubmission) => {
      // One undo step per op; the preview patches ride on the first op.
      submission.ops.forEach((op, index) => {
        dispatch({
          type: "bulk",
          op: { ...op, respectManualOverrides: !submission.overwriteManual },
          reason: submission.reason,
          patches: index === 0 ? submission.patches : []
        });
      });
      setBulkEdit({ open: false });
      showToast(`Edición masiva añadida al borrador (${submission.patches.length} celdas previstas).`, { variant: "success" });
    },
    [showToast]
  );

  // --- recommendations layer ---
  const [recommendations, setRecommendations] = useState<RateRecommendationsResponse | null>(null);
  const [recPopover, setRecPopover] = useState<{ key: CellKey; anchorRect: DOMRect | null } | null>(null);
  const recPlanId = planIds[0] ?? barPlan?.id ?? null;
  useEffect(() => {
    if (!layers.recommendations || !recPlanId) {
      setRecommendations(null);
      return;
    }
    let alive = true;
    fetchRecommendations(propertyId, { from, to, ratePlanId: recPlanId })
      .then((res) => {
        if (alive) setRecommendations(res);
      })
      .catch((err: unknown) => {
        if (!alive) return;
        const info = classifyRateGridError(err);
        setRecommendations(null);
        pushNotice({
          tone: "warning",
          title: "Recomendaciones no disponibles",
          text: info.kind === "not_deployed" ? "La ruta /properties/:id/rate-grid/recommendations no existe en este API todavía." : info.message
        });
      });
    return () => {
      alive = false;
    };
  }, [layers.recommendations, recPlanId, propertyId, from, to, pushNotice]);

  const recommendationByKey = useMemo(() => {
    const map = new Map<CellKey, RateGridCell["recommendation"]>();
    if (!recommendations) return map;
    for (const day of recommendations.days) {
      for (const row of day.byRoomType) {
        const { roomTypeId, ...rec } = row;
        map.set(cellKey(recommendations.ratePlanId, roomTypeId, day.date), rec);
      }
    }
    return map;
  }, [recommendations]);

  // Empty state of the layer: with everything on "hold" the cells show no
  // arrow, so the layer must say WHY nothing is suggested instead of looking
  // broken (see the notice in the render tree).
  const recSummary = useMemo(() => summarizeRecommendations(recommendationByKey.values()), [recommendationByKey]);

  const handleRecommendationAction = useCallback(
    (key: CellKey, action: RecommendationAction, value?: number, reason?: string) => {
      const rec = recommendationByKey.get(key) ?? cellIndex.get(key)?.recommendation ?? null;
      if (action === "reject") {
        dispatch({ type: "recommendation", key, action: "reject", reason: reason ?? "Rechazada" });
        setRecPopover(null);
        return;
      }
      // A «hold» / «no_data» recommendation proposes NO new price: «Aceptar»
      // without an explicit value opens the popover (which offers «Fijar otro
      // precio» / «Rechazar») instead of applying the engine's raw
      // suggestedPrice — coherent with acceptAllVisibleRecommendations and
      // the API's own skip (browser-ux-final#3).
      const holdLike = rec?.action === "hold" || rec?.action === "no_data";
      const price = action === "adjust" ? value : (value ?? (holdLike ? undefined : rec?.suggestedPrice) ?? undefined);
      if (price === undefined || price === null) {
        setRecPopover({ key, anchorRect: null });
        return;
      }
      const parsed = parseCellKey(key);
      const cell = cellIndex.get(key);
      const patch: RateGridCellPatch = { ratePlanId: parsed.ratePlanId, roomTypeId: parsed.roomTypeId, date: parsed.date, price };
      if (cell?.derivedFrom && cell.source === "derived") patch.convertToManual = true;
      if (rec?.suggestedRestrictions) patch.restrictions = { ...rec.suggestedRestrictions };
      dispatch({ type: "recommendation", key, action: action === "adjust" ? "adjust" : "accept", patch: { patch, before: beforeFor(key) }, reason });
      setRecPopover(null);
    },
    [recommendationByKey, cellIndex, beforeFor]
  );

  const acceptAllVisibleRecommendations = useCallback(() => {
    const entries: Array<{ key: CellKey; item: PatchWithBefore }> = [];
    for (const [key, rec] of recommendationByKey) {
      if (!rec || rec.suggestedPrice === null || rec.action === "hold" || rec.action === "no_data") continue;
      if (draftRef.current.rejectedRecommendations.has(key)) continue;
      const parsed = parseCellKey(key);
      if (roomTypeIds.length > 0 && !roomTypeIds.includes(parsed.roomTypeId)) continue;
      const cell = cellIndex.get(key);
      const patch: RateGridCellPatch = { ratePlanId: parsed.ratePlanId, roomTypeId: parsed.roomTypeId, date: parsed.date, price: rec.suggestedPrice };
      if (cell?.derivedFrom && cell.source === "derived") patch.convertToManual = true;
      entries.push({ key, item: { patch, before: beforeFor(key) } });
    }
    if (entries.length === 0) {
      showToast("No hay recomendaciones aplicables en esta vista.", { variant: "info" });
      return;
    }
    // Individual steps keep each acceptance undoable on its own.
    for (const e of entries) dispatch({ type: "recommendation", key: e.key, action: "accept", patch: e.item, reason: "Recomendación aceptada (todas las de la vista)" });
    showToast(`${entries.length} recomendaciones añadidas al borrador.`, { variant: "success" });
  }, [recommendationByKey, roomTypeIds, cellIndex, beforeFor, showToast]);

  // --- sync status (layer + polling after publish) ---
  const [syncStatus, setSyncStatus] = useState<RateGridSyncStatusResponse | null>(null);
  const [syncPanelOpen, setSyncPanelOpen] = useState(false);
  const pollRef = useRef<{ timer: number | null; startedAt: number; channelIds: string[] }>({ timer: null, startedAt: 0, channelIds: [] });
  const [publishState, setPublishState] = useState<PublishState>({ phase: "idle", byChannel: [] });

  // Saved-but-unsent cells (see pendingPush helpers above) and, after a
  // revert, the keys whose channel state must read "pendiente de reenvío"
  // instead of the stale "Confirmado" the API still reports (the last
  // delivery is confirmed, but it carries the value that was just reverted).
  const [pendingPush, setPendingPush] = useState<PendingPush | null>(() => readPendingPush(getActivePropertyId()));
  const [resendKeys, setResendKeys] = useState<Set<CellKey>>(() => new Set());
  useEffect(() => persistPendingPush(propertyId, pendingPush), [propertyId, pendingPush]);
  useEffect(() => {
    if (!pendingPush) setResendKeys((prev) => (prev.size === 0 ? prev : new Set()));
  }, [pendingPush]);

  const stopPolling = useCallback(() => {
    if (pollRef.current.timer !== null) {
      window.clearInterval(pollRef.current.timer);
      pollRef.current.timer = null;
    }
  }, []);

  const refreshSync = useCallback(
    async (channelIds: string[]): Promise<RateGridSyncStatusResponse | null> => {
      try {
        const res = await fetchSyncStatus(propertyId, { from, to, channelIds: channelIds.length > 0 ? channelIds : undefined });
        setSyncStatus(res);
        return res;
      } catch (err) {
        const info = classifyRateGridError(err);
        if (info.kind !== "not_deployed") {
          pushNotice({ tone: "warning", title: "Estado de envío no disponible", text: info.message });
        }
        return null;
      }
    },
    [propertyId, from, to, pushNotice]
  );

  const pendingCount = (summary: RateGridSyncStatusResponse["summary"], channelId: string) =>
    (summary[channelId]?.queued ?? 0) + (summary[channelId]?.sending ?? 0);

  const startPolling = useCallback(
    (channelIds: string[]) => {
      stopPolling();
      pollRef.current = { timer: null, startedAt: Date.now(), channelIds };
      const tick = async () => {
        const res = await refreshSync(channelIds);
        const elapsed = Date.now() - pollRef.current.startedAt;
        if (!res) {
          stopPolling();
          setPublishState((s) => (s.phase === "publishing" ? { ...s, phase: "done" } : s));
          return;
        }
        const byChannel = channelIds.map((channelId) => {
          const sum = res.summary[channelId] ?? {};
          const pending = pendingCount(res.summary, channelId);
          const confirmed = (sum.confirmed ?? 0) + (sum.sent ?? 0);
          const rejected = (sum.rejected ?? 0) + (sum.timeout ?? 0);
          const status: PublishState["byChannel"][number]["status"] =
            pending > 0 ? "sending" : rejected > 0 && confirmed === 0 ? "error" : "done";
          // sync-status counts CELLS (× channel) of the visible range, not deliveries.
          return { channelId, status, confirmed, rejected, message: pending > 0 ? pluralize(pending, "celda pendiente", "celdas pendientes") : null };
        });
        const anyPending = byChannel.some((c) => c.status === "sending");
        if (!anyPending) {
          stopPolling();
          setPublishState((s) => ({ ...s, phase: "done", byChannel }));
          return;
        }
        if (elapsed >= SYNC_POLL_MAX_MS) {
          stopPolling();
          setPublishState((s) => ({
            ...s,
            phase: "done",
            byChannel: byChannel.map((c) => (c.status === "sending" ? { ...c, message: "Sigue en cola: consulta el log de entregas del Channel Manager." } : c))
          }));
          return;
        }
        setPublishState((s) => ({ ...s, byChannel }));
      };
      void tick();
      pollRef.current.timer = window.setInterval(() => void tick(), SYNC_POLL_MS);
    },
    [refreshSync, stopPolling]
  );

  useEffect(() => () => stopPolling(), [stopPolling]);

  useEffect(() => {
    if (!layers.sync) return;
    void refreshSync(effectiveChannels.map((c) => c.id));
  }, [layers.sync, refreshSync, effectiveChannels]);

  // --- save / publish ---
  // The journal hook is mounted further down (it needs handleReverted, which
  // needs loadGrid/refreshSync); a ref lets the write flows refresh it.
  const journalRef = useRef<{ refresh: () => void }>({ refresh: () => undefined });
  const [reason, setReason] = useState("");
  const [reasonSheet, setReasonSheet] = useState<{ open: boolean; next: "save" | "review" }>({ open: false, next: "save" });
  const [reviewOpen, setReviewOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [lastSavedAt, setLastSavedAt] = useState<string | null>(null);
  const [lastPublishedAt, setLastPublishedAt] = useState<string | null>(null);

  /**
   * Traceability of the user's decisions on recommendations, cell by cell
   * (POST …/rate-grid/recommendations/apply, `cells` form), in two steps:
   *   1. `collectRecommendationTrace` reads the DRAFT snapshot before the
   *      write: `currentPrice` = the price the hotelier saw when deciding
   *      (the entry's `before`), `suggestedPrice` = the suggestion shown,
   *      `appliedPrice` = the FINAL price that goes to bulk-update;
   *   · accept → the final price equals the suggestion;
   *   · adjust → the user changed it (popover stepper or a later inline edit:
   *     the draft entry keeps the "Recomendación …" reason, see draft-store);
   *   · reject → status "rejected" with the reason, no patch.
   *   2. `sendRecommendationTrace` is called AFTER a successful bulk-update
   *      with its `journalId` (cierre 2026-09-15): a failed write (400/409)
   *      leaves no orphan «applied» rows. A draft with rejections only has no
   *      write, so it is recorded on its own without journalId.
   * The engine's patches are ignored: the draft already carries the price and
   * goes through bulk-update like any manual edit. Apply never writes
   * rate_days, so a failure here never blocks the save (informative toast).
   */
  const collectRecommendationTrace = useCallback(
    (snapshot: DraftState): { cells: ApplyRecommendationCell[]; rejected: number } => {
      if (!recPlanId) return { cells: [], rejected: 0 };
      const suggestedFor = (key: CellKey): number | null => {
        const rec = recommendationByKey.get(key) ?? cellIndex.get(key)?.recommendation ?? null;
        return rec?.suggestedPrice ?? null;
      };
      const cells: ApplyRecommendationCell[] = [];
      for (const e of snapshot.patches.values()) {
        const p = e.patch;
        if (p.ratePlanId !== recPlanId || p.channelId || typeof p.price !== "number") continue;
        const fromRecommendation = e.origin === "recommendation" || (typeof e.reason === "string" && RECOMMENDATION_REASON_RE.test(e.reason));
        if (!fromRecommendation) continue;
        const suggested = suggestedFor(e.key);
        const accepted = suggested !== null && Math.abs(suggested - p.price) < 0.005;
        cells.push({
          roomTypeId: p.roomTypeId,
          date: p.date,
          action: accepted ? "accept" : "adjust",
          currentPrice: e.before.basePrice,
          suggestedPrice: suggested,
          appliedPrice: p.price,
          reason: (e.reason ?? null)?.slice(0, 200) ?? null
        });
      }
      let rejected = 0;
      for (const [key, why] of snapshot.rejectedRecommendations) {
        const parsed = parseCellKey(key);
        if (parsed.ratePlanId !== recPlanId || parsed.channelId) continue;
        rejected += 1;
        cells.push({
          roomTypeId: parsed.roomTypeId,
          date: parsed.date,
          action: "reject",
          currentPrice: cellIndex.get(key)?.basePrice ?? null,
          suggestedPrice: suggestedFor(key),
          reason: (why || "Rechazada").slice(0, 200)
        });
      }
      return { cells, rejected };
    },
    [recPlanId, recommendationByKey, cellIndex]
  );

  const sendRecommendationTrace = useCallback(
    async (cells: ApplyRecommendationCell[], reasonText: string, journalId: string | null): Promise<{ attempted: number; recorded: number; rejected: number; error?: string }> => {
      if (cells.length === 0 || !recPlanId) return { attempted: 0, recorded: 0, rejected: 0 };
      const dates = cells.map((c) => c.date).sort();
      const rejectedCount = cells.filter((c) => c.action === "reject").length;
      try {
        const res = await applyRecommendations(propertyId, {
          from: dates[0],
          to: dates[dates.length - 1],
          ratePlanId: recPlanId,
          reason: reasonText.slice(0, 200),
          journalId,
          cells
        });
        const rejected = res.rejected ?? 0;
        const recorded = res.recorded ?? res.applied + rejected;
        if (recorded < cells.length) {
          const why = res.skipped
            .slice(0, 3)
            .map((sk) => `${sk.date}: ${sk.reason}`)
            .join(" · ");
          showToast(`Recomendaciones registradas: ${recorded} de ${cells.length}${why ? ` (${why})` : ""}.`, { variant: "info" });
        }
        return { attempted: cells.length, recorded, rejected };
      } catch (err) {
        // Traceability only: the caller decides how loud to be (the prices are
        // already written, or nothing was to be written and the draft is kept).
        const info = classifyRateGridError(err);
        return { attempted: cells.length, recorded: 0, rejected: rejectedCount, error: info.kind === "not_deployed" ? undefined : info.message };
      }
    },
    [recPlanId, propertyId]
  );

  const runBulkUpdate = useCallback(
    async (mode: "save" | "publish", channelIds: string[], reasonOverride?: string) => {
      if (!response || draftIsEmpty(draft)) return;
      const snapshot = draft;
      const reasonText = (reasonOverride ?? reason).trim() || "Edición en el editor de tarifas";
      const { req: body, stripped } = buildBulkRequest(snapshot, response.ratePlans, reasonText, mode === "publish" ? { channelIds } : undefined);
      const hasWrites = (body.cells?.length ?? 0) + (body.ops?.length ?? 0) > 0;
      setSaving(true);
      setPublishState({
        phase: "saving",
        byChannel: channelIds.map((channelId) => ({ channelId, status: "idle" as const }))
      });
      try {
        if (stripped > 0) {
          showToast(`${stripped} precios por canal no se envían: los precios por canal se calculan con el markup del canal.`, { variant: "info" });
        }
        // Decisions are read from the draft now and recorded AFTER the write
        // succeeds (with its journalId); a draft with nothing to write records
        // them on its own.
        const traceCells = collectRecommendationTrace(snapshot);
        if (!hasWrites) {
          // Only rejected recommendations (or stripped channel prices): nothing
          // to write; record the decisions and the draft is done. When the
          // recording itself fails the draft is KEPT so the decisions are not
          // lost (retry after the API is back).
          const trace = await sendRecommendationTrace(traceCells.cells, reasonText, null);
          const failed = trace.attempted > 0 && trace.recorded === 0;
          setPublishState({ phase: "idle", byChannel: [] });
          setReviewOpen(false);
          if (failed) {
            showToast(
              `${trace.attempted === 1 ? "No se pudo registrar la decisión sobre la recomendación" : `No se pudieron registrar las ${trace.attempted} decisiones sobre las recomendaciones`}${trace.error ? `: ${trace.error}` : ""}. El borrador se conserva para reintentarlo.`,
              { variant: "error" }
            );
            return;
          }
          dispatch({ type: "restore", draft: initialDraftStore().present });
          clearPersistedDraft(propertyId);
          setReason("");
          showToast(
            trace.attempted > 0
              ? `${pluralize(trace.recorded, "decisión registrada", "decisiones registradas")} (${pluralize(trace.rejected, "recomendación rechazada", "recomendaciones rechazadas")}); no hay precios que guardar.`
              : "No hay cambios que enviar al servidor.",
            { variant: "info" }
          );
          return;
        }
        const res = await bulkUpdateRateGrid(propertyId, body);
        const now = new Date().toISOString();
        setLastSavedAt(now);
        // Partial conflicts (200 + conflicts[]): the written cells leave the
        // draft; the conflicting ones stay so the hotelier can review them
        // over the reloaded server values (re-based below) instead of typing
        // them again.
        const conflictKeys = new Set(res.conflicts.map((c) => cellKey(c.ratePlanId, c.roomTypeId, c.date)));
        const keptEntries = [...snapshot.patches.values()].filter((e) => e.origin !== "bulk" && !e.patch.channelId && conflictKeys.has(e.key));
        const keptDraft: DraftState = { patches: new Map(keptEntries.map((e) => [e.key, e])), ops: [], rejectedRecommendations: new Map(), updatedAt: keptEntries.length ? now : null };
        dispatch({ type: "restore", draft: keptDraft });
        if (keptEntries.length === 0) clearPersistedDraft(propertyId);
        void sendRecommendationTrace(traceCells.cells, reasonText, res.journalId).then((trace) => {
          if (trace.error) showToast(`Precios guardados, pero no se pudo registrar la trazabilidad de las recomendaciones: ${trace.error}`, { variant: "info" });
        });
        if (res.conflicts.length > 0) {
          pushNotice({
            tone: "warning",
            title: `${pluralize(res.conflicts.length, "celda no se aplicó", "celdas no se aplicaron")}`,
            text: keptEntries.length
              ? `Conflictos devueltos por el servidor (p. ej. la celda cambió desde que se cargó, o una sobrescritura manual en un plan derivado). ${pluralize(keptEntries.length, "celda se conserva", "celdas se conservan")} en el borrador sobre los valores actuales del servidor: revísalas y vuelve a guardar, o descártalas.`
              : "Conflictos devueltos por el servidor (p. ej. sobrescritura manual en un plan derivado).",
            conflicts: res.conflicts
          });
        }
        if (res.warnings && res.warnings.length > 0) {
          pushNotice({ tone: "info", title: "Avisos del guardado", text: res.warnings.join(" · ") });
        }
        const savedCells = res.updated + res.derivedUpdated;
        const scope = pendingPushFromRequest(body, savedCells, res.journalId, now);
        // The history drawer lists the new entry without an F5 (browser-ux-final#4).
        journalRef.current.refresh();
        const derivedNote = res.derivedUpdated ? ` (${pluralize(res.derivedUpdated, "celda derivada recalculada", "celdas derivadas recalculadas")})` : "";
        if (mode === "publish") {
          setLastPublishedAt(now);
          const byChannel = channelIds.map((channelId) => ({
            channelId,
            status: "queued" as const,
            queued: res.queued?.[channelId] ?? 0
          }));
          setPublishState({ phase: "publishing", byChannel, journalId: res.journalId, cells: savedCells });
          // The push fans out over the whole date range of the patches for
          // every type/plan, so earlier unsent cells inside that window are
          // sent too; anything outside stays pending.
          if (scope) setPendingPush((prev) => (prev && (prev.from < scope.from || prev.to > scope.to) ? prev : null));
          showToast(`Guardado en Anfitorio: ${pluralize(res.updated, "celda", "celdas")}${derivedNote}. Publicación en cola.`, { variant: "success" });
          startPolling(channelIds);
        } else {
          // No "done" here: that phase belongs to a publish (the drawer would
          // open on "Publicación enviada" for the NEXT draft otherwise).
          setPublishState({ phase: "idle", byChannel: [] });
          if (scope) setPendingPush((prev) => mergePendingPush(prev, scope));
          showToast(`Guardado en Anfitorio sin enviar a canales: ${pluralize(res.updated, "celda", "celdas")}${derivedNote}. El PMS ya vende el valor nuevo; usa «Enviar a canales» cuando quieras actualizarlos.`, { variant: "success" });
          setReviewOpen(false);
        }
        setReason("");
        const fresh = await loadGrid();
        if (fresh && keptEntries.length > 0) rebaseDraftOn(fresh);
      } catch (err) {
        const info = classifyRateGridError(err);
        setPublishState({ phase: "error", byChannel: [], error: info.message });
        if (info.kind === "validation") {
          // 400 with the API's Spanish message (channel price override,
          // NO_CELLS, TOO_MANY_CELLS, INACTIVE_RATE_PLANS…): toast, draft kept.
          showToast(`${info.message} El borrador se conserva.`, { variant: "error" });
          return;
        }
        if (info.kind === "conflict" && (info.code === ALL_CELLS_CONFLICT_CODE || info.conflicts.length > 0)) {
          // 409 ALL_CELLS_CONFLICT: the server rolled back (no journal entry).
          // Keep the draft, list the conflicts and reload so the grid shows the
          // server's current values under the pending draft; then re-base the
          // draft on those values so the next save carries a current stamp.
          const n = info.conflicts.length;
          pushNotice({
            tone: "warning",
            title: `Ninguna celda se aplicó: ${n} ${n === 1 ? "conflicto" : "conflictos"}`,
            text: "El servidor no escribió nada (sin entrada en el historial). El borrador se conserva sobre los valores actuales del servidor (la parrilla se ha recargado): revisa las celdas en conflicto y vuelve a guardar, o descártalas.",
            conflicts: info.conflicts
          });
          setReviewOpen(false);
          const fresh = await loadGrid();
          if (fresh) rebaseDraftOn(fresh);
          return;
        }
        pushNotice({
          tone: info.kind === "forbidden" || info.kind === "conflict" ? "warning" : "danger",
          title:
            info.kind === "forbidden"
              ? "Sin permiso para guardar tarifas"
              : info.code === RATE_GRID_BUSY_CODE
                ? "La parrilla está ocupada"
                : info.kind === "conflict"
                  ? "Conflicto al guardar"
                  : "No se pudo guardar",
          text:
            info.kind === "forbidden"
              ? "Tu usuario no tiene revenue.manage_rates. El borrador se conserva en esta pestaña."
              : `${info.message} El borrador se conserva.`,
          conflicts: info.conflicts
        });
      } finally {
        setSaving(false);
      }
    },
    [response, draft, reason, propertyId, pushNotice, collectRecommendationTrace, sendRecommendationTrace, showToast, startPolling, loadGrid, rebaseDraftOn]
  );

  const requestSave = useCallback(() => {
    if (draftIsEmpty(draft) || readOnly) return;
    if (!reason.trim()) {
      setReasonSheet({ open: true, next: "save" });
      return;
    }
    void runBulkUpdate("save", []);
  }, [draft, readOnly, reason, runBulkUpdate]);

  // Opening the drawer always starts from a clean publish state: a previous
  // publish's "done" (or a failed one) must not be shown over a new draft.
  const openReview = useCallback(() => {
    setPublishState((s) => (s.phase === "publishing" || s.phase === "saving" ? s : { phase: "idle", byChannel: [] }));
    setReviewOpen(true);
  }, []);

  const requestReview = useCallback(() => {
    if (readOnly) return;
    if (draftIsEmpty(draft)) {
      // Nothing to publish, but saved cells never sent: the drawer opens in
      // "Enviar a canales" mode (POST /rate-grid/push).
      if (pendingPush && pendingPush.count > 0) openReview();
      return;
    }
    if (!reason.trim()) {
      setReasonSheet({ open: true, next: "review" });
      return;
    }
    openReview();
  }, [draft, readOnly, reason, pendingPush, openReview]);

  const onReasonConfirmed = useCallback(
    (value: string) => {
      setReason(value);
      setReasonSheet((s) => ({ ...s, open: false }));
      if (reasonSheet.next === "review") openReview();
      // The state update above is not visible inside runBulkUpdate's closure yet: pass it explicitly.
      else void runBulkUpdate("save", [], value);
    },
    [reasonSheet.next, runBulkUpdate, openReview]
  );

  const handlePublish = useCallback(
    (args: { channelIds: string[] }) => {
      if (args.channelIds.length === 0) {
        void runBulkUpdate("save", []);
        return;
      }
      void runBulkUpdate("publish", args.channelIds);
    },
    [runBulkUpdate]
  );

  /**
   * Send already persisted cells (a save without publish, or a revert) to the
   * chosen channels: POST /rate-grid/push over the remembered range. The API
   * fans out to every type/plan of those days; idempotent payloads are
   * skipped, so channels already up to date receive nothing.
   */
  const handlePushPending = useCallback(
    async (args: { channelIds: string[] }) => {
      const pending = pendingPush;
      if (!pending || pending.count === 0 || args.channelIds.length === 0) return;
      setSaving(true);
      setPublishState({
        phase: "publishing",
        byChannel: args.channelIds.map((channelId) => ({ channelId, status: "queued" as const, queued: 0 })),
        journalId: pending.journalId ?? null,
        cells: pending.count
      });
      try {
        const res = await pushRateGrid(propertyId, {
          from: pending.from,
          to: pending.to,
          channelIds: args.channelIds,
          ratePlanIds: pending.ratePlanIds.length > 0 ? pending.ratePlanIds : undefined,
          roomTypeIds: pending.roomTypeIds.length > 0 ? pending.roomTypeIds : undefined,
          journalId: pending.journalId ?? undefined
        });
        const now = new Date().toISOString();
        setLastPublishedAt(now);
        setPendingPush(null);
        setPublishState({
          phase: "publishing",
          byChannel: args.channelIds.map((channelId) => ({ channelId, status: "queued" as const, queued: res.byChannel[channelId]?.queued ?? 0 })),
          journalId: pending.journalId ?? null,
          cells: pending.count
        });
        showToast(queuedDeliveriesSummary(res.queued, pending.count, args.channelIds.length), { variant: "success" });
        if (res.warnings.length > 0) pushNotice({ tone: "info", title: "Avisos del envío", text: res.warnings.join(" · ") });
        journalRef.current.refresh();
        startPolling(args.channelIds);
      } catch (err) {
        const info = classifyRateGridError(err);
        setPublishState({ phase: "error", byChannel: [], error: info.message });
        showToast(`No se pudo enviar a los canales: ${info.message}`, { variant: "error" });
      } finally {
        setSaving(false);
      }
    },
    [pendingPush, propertyId, showToast, pushNotice, startPolling]
  );

  /** Re-push already persisted cells (sync panel retry). */
  const handleSyncRetry = useCallback(
    async (args: { channelId: string; keys: CellKey[] }) => {
      const parsed = args.keys.map(parseCellKey);
      if (parsed.length === 0) return;
      const ds = parsed.map((p) => p.date).sort();
      try {
        const res = await pushRateGrid(propertyId, {
          from: ds[0],
          to: ds[ds.length - 1],
          channelIds: [args.channelId],
          ratePlanIds: Array.from(new Set(parsed.map((p) => p.ratePlanId).filter((id) => id !== AVAILABILITY_PLAN_ID))),
          roomTypeIds: Array.from(new Set(parsed.map((p) => p.roomTypeId)))
        });
        showToast(`${pluralize(res.queued, "entrega reencolada", "entregas reencoladas")}.`, { variant: "success" });
        if (res.warnings.length > 0) pushNotice({ tone: "info", title: "Avisos del envío", text: res.warnings.join(" · ") });
        startPolling([args.channelId]);
      } catch (err) {
        showToast(classifyRateGridError(err).message, { variant: "error" });
      }
    },
    [propertyId, showToast, pushNotice, startPolling]
  );

  // A new edit after a finished publish retires the "Publicación procesada"
  // banner: it described the previous draft, not this one.
  useEffect(() => {
    if (publishState.phase === "done" && !draftIsEmpty(draft)) setPublishState({ phase: "idle", byChannel: [] });
  }, [draft, publishState.phase]);

  // --- history ---
  const [historyOpen, setHistoryOpen] = useState(false);

  /**
   * After a revert the API restores rate_days but never touches the channels
   * (revertRateJournal runs the write without publish): the last delivery of
   * each cell is still "confirmed" with the value that was just reverted. Mark
   * those cells as pending re-send and offer the push from the notice.
   */
  const layersRef = useRef(layers);
  layersRef.current = layers;
  const handleReverted = useCallback(
    async (info: RateJournalRevertInfo) => {
      setPublishState({ phase: "idle", byChannel: [] });
      void loadGrid();
      // The outbox now reports the reverted cells as «stale» on its own: refresh
      // the layer so the server state (not only the session overlay) shows.
      if (layersRef.current.sync) void refreshSync(effectiveChannelsRef.current.map((c) => c.id));
      const at = new Date().toISOString();
      const pushedTo = info.original?.pushedTo ?? [];
      try {
        const entry = await fetchJournalEntry(propertyId, info.journalId);
        const keys = new Set<CellKey>();
        const dates: string[] = [];
        const plans = new Set<string>();
        const types = new Set<string>();
        for (const it of entry.items ?? []) {
          keys.add(cellKey(it.ratePlanId, it.roomTypeId, it.date));
          dates.push(it.date);
          if (it.ratePlanId !== AVAILABILITY_PLAN_ID) plans.add(it.ratePlanId);
          types.add(it.roomTypeId);
        }
        dates.sort();
        if (keys.size > 0) {
          setResendKeys((prev) => new Set([...prev, ...keys]));
          setPendingPush((prev) =>
            mergePendingPush(prev, {
              source: "revert",
              count: keys.size,
              from: dates[0],
              to: dates[dates.length - 1],
              ratePlanIds: [...plans],
              roomTypeIds: [...types],
              journalId: info.journalId,
              at,
              channelIds: pushedTo
            })
          );
        }
      } catch (err) {
        // The revert itself succeeded; without the item list we still know the count.
        const info2 = classifyRateGridError(err);
        pushNotice({ tone: "warning", title: "Cambio revertido en Anfitorio", text: `No se pudo leer el detalle de la reversión (${info2.message}). Los canales conservan el valor anterior: publica de nuevo el rango afectado para actualizarlos.` });
      }
    },
    [propertyId, loadGrid, pushNotice, refreshSync]
  );

  const journal = useRateJournal(propertyId, { enabled: historyOpen, onReverted: (info) => void handleReverted(info) });
  journalRef.current = journal;

  // --- response for the grid: merge sync + recommendations into cells ---
  // Channel state overlay for reverted cells (session fallback): «stale»
  // («Pendiente de reenvío») until they are sent again. The API's sync map
  // reports the same `stale` on its own once the outbox compares the last
  // confirmed delivery with the grid value; the overlay only fills channels
  // the server still shows as confirmed/sent/never and never hides a delivery
  // that is queued or in flight (which will resolve the staleness).
  const RESEND_REASON = "tras revertir el cambio; el canal conserva el valor anterior";
  const resendOverlay = useCallback(
    (key: CellKey, sync: SyncMatrixCell["byChannel"] | undefined): SyncMatrixCell["byChannel"] | undefined => {
      if (!resendKeys.has(key)) return sync;
      const out: SyncMatrixCell["byChannel"] = { ...(sync ?? {}) };
      for (const ch of effectiveChannels) {
        const server = out[ch.id]?.status;
        if (server === "stale" || server === "queued" || server === "sending" || server === "rejected" || server === "timeout") continue;
        out[ch.id] = { ...(out[ch.id] ?? {}), status: "stale", error: RESEND_REASON };
      }
      return out;
    },
    [resendKeys, effectiveChannels]
  );

  // GET /rate-grid could not read the per-cell sync map (`degraded: ["sync"]`):
  // every cell would look «Sin enviar». Unless the sync-status route filled
  // the gap, the grid hides the dots and the bar/panel say why.
  const syncUnavailable = Boolean(response?.degraded?.includes("sync")) && syncStatus === null;

  const gridResponse: RateGridResponse | null = useMemo(() => {
    if (!response) return null;
    const syncByKey = new Map<CellKey, SyncMatrixCell["byChannel"]>();
    if (syncStatus) for (const c of syncStatus.cells) syncByKey.set(cellKey(c.ratePlanId, c.roomTypeId, c.date), c.byChannel);
    if (syncByKey.size === 0 && recommendationByKey.size === 0 && resendKeys.size === 0) return response;
    const cells = response.cells.map((cell) => {
      const key = cellKey(cell.ratePlanId, cell.roomTypeId, cell.date);
      const sync = resendOverlay(key, syncByKey.get(key));
      const rec = recommendationByKey.get(key);
      if (!sync && rec === undefined) return cell;
      return { ...cell, sync: sync ? { ...(cell.sync ?? {}), ...sync } : cell.sync, recommendation: rec ?? cell.recommendation ?? null };
    });
    return { ...response, cells, channels: effectiveChannels.length > 0 ? effectiveChannels : response.channels };
  }, [response, syncStatus, recommendationByKey, effectiveChannels, resendKeys, resendOverlay]);

  const syncMatrix: SyncMatrixCell[] = useMemo(() => {
    const rows: SyncMatrixCell[] = syncStatus ? syncStatus.cells.map((c) => ({ key: cellKey(c.ratePlanId, c.roomTypeId, c.date), ...c })) : [];
    if (resendKeys.size === 0) return rows;
    const seen = new Set(rows.map((r) => r.key));
    const out = rows.map((r) => ({ ...r, byChannel: resendOverlay(r.key, r.byChannel) ?? r.byChannel }));
    for (const key of resendKeys) {
      if (seen.has(key)) continue;
      const k = parseCellKey(key);
      out.push({ key, ratePlanId: k.ratePlanId, roomTypeId: k.roomTypeId, date: k.date, byChannel: resendOverlay(key, undefined) ?? {} });
    }
    return out;
  }, [syncStatus, resendKeys, resendOverlay]);

  // --- toolbar handlers ---
  const activePreset = useMemo(() => {
    const q = quarterRange(from);
    if (from === q.from && to === q.to) return "quarter";
    return RANGE_PRESETS.find((p) => p.days === rangeDays)?.id ?? null;
  }, [from, to, rangeDays]);

  const applyPreset = useCallback(
    (id: string) => {
      const preset = RANGE_PRESETS.find((p) => p.id === id);
      if (!preset) return;
      if (preset.days === "quarter") {
        const q = quarterRange(from);
        setRange(q.from, q.to);
      } else {
        setRange(from, addDays(from, preset.days - 1));
      }
    },
    [from, setRange]
  );
  const shiftRange = useCallback((direction: -1 | 1) => setRange(addDays(from, direction * rangeDays), addDays(to, direction * rangeDays)), [from, to, rangeDays, setRange]);
  const goToday = useCallback(() => setRange(today, addDays(today, rangeDays - 1)), [today, rangeDays, setRange]);

  const roomTypeOptions = useMemo(() => (response?.roomTypes ?? []).map((rt) => ({ id: rt.id, label: rt.name, hint: rt.code })), [response]);
  const planOptions = useMemo(
    () => (response?.ratePlans ?? []).map((p) => ({ id: p.id, label: p.name, hint: p.derivation.mode === "none" ? p.code : `${p.code} · derivado` })),
    [response]
  );
  const channelOptions = useMemo(
    () => [{ value: "", label: "Precio base (sin canal)" }, ...effectiveChannels.map((c) => ({ value: c.id, label: `${c.name} (+${c.markupPercent} %)` }))],
    [effectiveChannels]
  );

  const activeFilterCount = (roomTypeIds.length > 0 ? 1 : 0) + (planIds.length > 0 ? 1 : 0) + (channelIdForView ? 1 : 0);

  // Real per-channel product mappings (see loadProductMappings); undefined
  // while loading / when every request failed → `mappedProducts` fallback.
  const channelMappingsLite = productMappings ?? undefined;

  const recPopoverData = useMemo(() => {
    if (!recPopover || !response) return null;
    const rec = recommendationByKey.get(recPopover.key) ?? cellIndex.get(recPopover.key)?.recommendation ?? null;
    if (!rec) return null;
    const parsed = parseCellKey(recPopover.key);
    return {
      rec,
      parsed,
      roomTypeName: response.roomTypes.find((r) => r.id === parsed.roomTypeId)?.name ?? parsed.roomTypeId,
      ratePlanCode: response.ratePlans.find((p) => p.id === parsed.ratePlanId)?.code ?? parsed.ratePlanId
    };
  }, [recPopover, response, recommendationByKey, cellIndex]);

  const noChannels = !loading && response !== null && !response.legacyShape && effectiveChannels.length === 0;

  // --- render ---
  const screenStyle: CSSProperties = { display: "flex", flexDirection: "column", gap: "var(--cocoa-space-3)", fontFamily: "var(--cocoa-font)", minHeight: 0 };
  const toolbarStyle: CSSProperties = {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "flex-end",
    gap: "var(--cocoa-space-3)",
    padding: "var(--cocoa-space-3)",
    border: "1px solid var(--cocoa-separator)",
    borderRadius: "var(--cocoa-radius-md)",
    background: "var(--cocoa-background-content)"
  };

  return (
    <section style={screenStyle} aria-busy={loading}>
      <CocoaPageHeader
        eyebrow="Revenue · Tarifas"
        title="Editor de tarifas"
        subtitle={`${propertyName} · ${formatDateRange(from, to)} · ${rangeDays} noches${response?.legacyShape ? " · solo lectura" : ""}`}
        actions={
          <>
            <CocoaButton variant="bordered" size="small" tone="neutral" onClick={() => setHistoryOpen(true)}>
              Historial
            </CocoaButton>
            <CocoaButton
              variant="bordered"
              size="small"
              tone="neutral"
              onClick={() => {
                void loadGrid();
                void loadProductMappings();
                journal.refresh();
              }}
              loading={loading}
              disabled={loading}
            >
              Recargar
            </CocoaButton>
          </>
        }
      />

      <div style={toolbarStyle} role="toolbar" aria-label="Rango, vista y filtros">
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span style={fieldLabelStyle}>Rango</span>
          <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
            {RANGE_PRESETS.map((p) => (
              <button
                key={p.id}
                type="button"
                style={chipStyle(activePreset === p.id)}
                onClick={() => applyPreset(p.id)}
                aria-pressed={activePreset === p.id}
                title={p.days === "quarter" ? "Trimestre natural de la fecha inicial" : `${p.days} noches desde la fecha inicial`}
              >
                {p.label}
              </button>
            ))}
            <span title="Rango anterior" style={{ display: "inline-flex" }}>
              <CocoaButton variant="bordered" size="small" tone="neutral" onClick={() => shiftRange(-1)} aria-label="Rango anterior">
                ‹
              </CocoaButton>
            </span>
            <label style={{ display: "inline-flex", alignItems: "center", gap: 4 }} title="Primera noche del rango">
              <span style={{ fontSize: "var(--cocoa-fs-caption)", color: "var(--cocoa-label-secondary)" }}>Desde</span>
              <CocoaDatePicker value={from} onChange={(v) => v && setRange(v, addDays(v, rangeDays - 1))} size="small" />
            </label>
            <label style={{ display: "inline-flex", alignItems: "center", gap: 4 }} title="Última noche del rango (hasta 365 noches)">
              <span style={{ fontSize: "var(--cocoa-fs-caption)", color: "var(--cocoa-label-secondary)" }}>Hasta</span>
              <CocoaDatePicker
                value={to}
                min={from}
                max={addDays(from, MAX_RANGE_DAYS - 1)}
                onChange={(v) => {
                  if (!v || v < from || diffDays(from, v) >= MAX_RANGE_DAYS) return;
                  setRange(from, v);
                }}
                size="small"
              />
            </label>
            <span title="Rango siguiente" style={{ display: "inline-flex" }}>
              <CocoaButton variant="bordered" size="small" tone="neutral" onClick={() => shiftRange(1)} aria-label="Rango siguiente">
                ›
              </CocoaButton>
            </span>
            <span title="Empezar el rango hoy" style={{ display: "inline-flex" }}>
              <CocoaButton variant="plain" size="small" tone="accent" onClick={goToday}>
                Hoy
              </CocoaButton>
            </span>
          </div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }} title={VIEW_HELP[view]}>
          <span style={fieldLabelStyle}>Vista</span>
          <CocoaSegmentedControl value={view} onChange={(v) => setView(v as RateGridView)} options={VIEW_OPTIONS.map((o) => ({ value: o.value, label: o.label }))} size="small" aria-label="Vista de la parrilla" />
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span style={fieldLabelStyle}>Filtros</span>
          <span title="Tipos de habitación, planes y precio visto por canal" style={{ display: "inline-flex" }}>
            <CocoaButton
              variant={activeFilterCount > 0 ? "tinted" : "bordered"}
              size="small"
              tone={activeFilterCount > 0 ? "accent" : "neutral"}
              onClick={() => setFiltersOpen((v) => !v)}
              aria-label={`${filtersOpen ? "Ocultar" : "Mostrar"} filtros de tipos, planes y precio visto por`}
            >
              {activeFilterCount > 0 ? `Filtros (${activeFilterCount})` : "Filtros"} {filtersOpen ? "▴" : "▾"}
            </CocoaButton>
          </span>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span style={fieldLabelStyle}>Capas</span>
          <div style={{ display: "flex", gap: 12, alignItems: "center", height: 28 }}>
            <span title="Capa Demanda: ocupación en libros, previsión y pickup por día bajo las fechas">
              <CocoaSwitch size="small" label="Demanda" checked={layers.demand} onChange={(v) => setLayers((l) => ({ ...l, demand: v }))} />
            </span>
            <span title="Capa Recomendaciones: sugerencias de subida o bajada del motor de revenue en cada celda">
              <CocoaSwitch size="small" label="Recomendaciones" checked={layers.recommendations} onChange={(v) => setLayers((l) => ({ ...l, recommendations: v }))} />
            </span>
            <span title="Capa Estado de envío: punto por celda con el estado de la última entrega a cada canal">
              <CocoaSwitch size="small" label="Estado de envío" checked={layers.sync} onChange={(v) => setLayers((l) => ({ ...l, sync: v }))} />
            </span>
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "flex-end", marginLeft: "auto" }}>
          {layers.recommendations && recommendationByKey.size > 0 ? (
            <span title={recSummary.actionable === 0 ? "No hay recomendaciones de subida o bajada en el rango visible" : "Añade al borrador todas las recomendaciones de subida o bajada del rango visible"} style={{ display: "inline-flex" }}>
              <CocoaButton variant="tinted" size="small" tone="accent" onClick={acceptAllVisibleRecommendations} disabled={readOnly || recSummary.actionable === 0}>
                Aceptar todas las recomendaciones visibles{recSummary.actionable > 0 ? ` (${recSummary.actionable})` : ""}
              </CocoaButton>
            </span>
          ) : null}
          {layers.sync ? (
            <CocoaButton variant="bordered" size="small" tone="neutral" onClick={() => setSyncPanelOpen(true)}>
              Ver estado por canal
            </CocoaButton>
          ) : null}
          <CocoaButton variant="bordered" size="small" tone="accent" onClick={() => handleOpenBulkEdit()} disabled={readOnly || !response}>
            Edición masiva…
          </CocoaButton>
        </div>
      </div>

      {filtersOpen ? (
        <div id="crg-filters-row" style={{ ...toolbarStyle, alignItems: "flex-end" }} role="group" aria-label="Filtros de la parrilla">
          <MultiSelectFilter label="Tipos de habitación" options={roomTypeOptions} value={roomTypeIds} onChange={setRoomTypeIds} emptyLabel="Todos los tipos" />
          <MultiSelectFilter label="Planes" options={planOptions} value={planIds} onChange={setPlanIds} emptyLabel="Todos los planes" />
          <div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 180 }} title="Precio base, o el precio que ve cada canal con su recargo (base + recargo)">
            <span style={fieldLabelStyle}>Precio visto por</span>
            <CocoaSelect value={channelIdForView} onChange={setChannelIdForView} options={channelOptions} size="small" />
          </div>
          {activeFilterCount > 0 ? (
            <CocoaButton
              variant="plain"
              size="small"
              tone="neutral"
              onClick={() => {
                setRoomTypeIds([]);
                setPlanIds([]);
                setChannelIdForView("");
              }}
            >
              Quitar filtros
            </CocoaButton>
          ) : null}
        </div>
      ) : null}

      {channelIdForView && !readOnly ? (
        <InlineNotice tone="info" title={`Precio visto por ${effectiveChannels.find((c) => c.id === channelIdForView)?.name ?? "canal"}`}>
          Editas el precio base; {channelMarkupLabel(effectiveChannels, channelIdForView)} sobre ese precio (los precios por canal se calculan con el recargo del canal y no se
          guardan por celda).
        </InlineNotice>
      ) : null}

      {view === "restrictions" ? (
        <InlineNotice tone="info" title="Vista de restricciones">
          Cada celda muestra sus restricciones (MÍN estancia mínima, CTA cerrado a llegada, CTD cerrado a salida, CERR cerrado, STOP cierre de venta, ANT antelación) o «—» si no
          tiene ninguna; el precio queda atenuado. Para cambiarlas, selecciona una o varias celdas y usa la edición rápida (Ctrl/Cmd+Enter) o «Edición masiva…».
        </InlineNotice>
      ) : null}

      {layers.recommendations && recommendations && recSummary.total > 0 && recSummary.actionable === 0 ? (
        <InlineNotice
          tone="info"
          title={`Sin recomendaciones accionables en ${formatDateRange(from, to)}`}
          action={
            <CocoaButton variant="plain" size="small" tone="accent" onClick={() => navigateTo("RevenueRules")}>
              Reglas y recomendaciones
            </CocoaButton>
          }
        >
          El motor sugiere mantener el precio en las {pluralize(recSummary.total, "celda", "celdas")} del rango
          {recSummary.avgConfidence !== null ? ` (confianza media ${recSummary.avgConfidence} %)` : ""}
          {recSummary.missing.length > 0 ? `: faltan señales — ${recSummary.missing.slice(0, 4).join(", ")}` : ""}. Pulsa «= mantener» en una celda para ver sus factores.
        </InlineNotice>
      ) : layers.recommendations && recommendations && recSummary.total === 0 ? (
        <InlineNotice tone="info" title="Sin recomendaciones en este rango">
          El motor no ha devuelto recomendaciones para {formatDateRange(from, to)}{recPlanId ? "" : ": no hay un plan base (BAR) sobre el que calcularlas"}.
        </InlineNotice>
      ) : null}

      {pendingPush && pendingPush.source === "revert" && pendingPush.count > 0 ? (
        <InlineNotice
          tone="warning"
          title="Cambio revertido en Anfitorio · los canales conservan el valor anterior"
          action={
            <CocoaButton variant="tinted" size="small" tone="accent" onClick={openReview} disabled={readOnly || saving}>
              Enviar a canales
            </CocoaButton>
          }
          onDismiss={() => setPendingPush(null)}
        >
          {pluralize(pendingPush.count, "celda restaurada", "celdas restauradas")} del {formatDateRange(pendingPush.from, pendingPush.to)} ya {pendingPush.count === 1 ? "se vende" : "se venden"} al
          precio anterior en el PMS, pero {pendingPush.channelIds && pendingPush.channelIds.length > 0 ? `${pendingPush.channelIds.map((id) => allChannels.find((c) => c.id === id)?.name ?? id).join(", ")} ${pendingPush.channelIds.length === 1 ? "sigue" : "siguen"}` : "los canales siguen"} con
          el precio revertido hasta que lo envíes. Cerrar este aviso deja los canales como están.
        </InlineNotice>
      ) : null}

      {notices.map((n) => (
        <InlineNotice key={n.id} tone={n.tone} title={n.title} onDismiss={() => dismissNotice(n.id)}>
          {n.text}
          {n.conflicts && n.conflicts.length > 0 ? (
            <ul style={{ margin: "6px 0 0", paddingLeft: 18, fontSize: "var(--cocoa-fs-callout)" }}>
              {n.conflicts.slice(0, 12).map((c, i) => {
                const rt = response?.roomTypes.find((r) => r.id === c.roomTypeId)?.name ?? c.roomTypeId;
                const plan = response?.ratePlans.find((p) => p.id === c.ratePlanId)?.code ?? c.ratePlanId;
                return (
                  <li key={`${c.ratePlanId}-${c.roomTypeId}-${c.date}-${i}`}>
                    {plan} · {rt} · {formatDateLong(c.date)}: {c.reason}
                  </li>
                );
              })}
              {n.conflicts.length > 12 ? <li>… y {n.conflicts.length - 12} más</li> : null}
            </ul>
          ) : null}
        </InlineNotice>
      ))}

      {channelsError && effectiveChannels.length === 0 && response && !response.legacyShape ? (
        <InlineNotice tone="info" title="Canales">
          {channelsError}
        </InlineNotice>
      ) : null}

      {noChannels && !channelsError ? <NoChannelsPanel /> : null}

      {publishState.phase === "publishing" || (publishState.phase === "done" && publishState.byChannel.length > 0) ? (
        <InlineNotice
          tone={publishState.byChannel.some((c) => c.status === "error") ? "warning" : publishState.phase === "done" ? "success" : "info"}
          title={publishState.phase === "publishing" ? "Publicando en canales…" : "Publicación procesada"}
          onDismiss={() => setPublishState({ phase: "idle", byChannel: [] })}
          action={
            <CocoaButton variant="plain" size="small" tone="accent" onClick={() => setSyncPanelOpen(true)}>
              Detalle por canal
            </CocoaButton>
          }
        >
          {publishState.byChannel
            .map((c) => {
              const name = effectiveChannels.find((ch) => ch.id === c.channelId)?.name ?? c.channelId;
              // «en cola» = deliveries the API queued; the rest = cells of the
              // visible range as sync-status reports them (see ReviewPublishDrawer).
              const state =
                c.status === "queued"
                  ? `${pluralize(c.queued ?? 0, "entrega en cola", "entregas en cola")}`
                  : c.status === "sending"
                    ? c.message ?? "enviando…"
                    : c.status === "error"
                      ? `${pluralize(c.rejected ?? 0, "celda rechazada", "celdas rechazadas")}`
                      : `${pluralize(c.confirmed ?? 0, "celda confirmada", "celdas confirmadas")}${c.rejected ? `, ${pluralize(c.rejected, "rechazada", "rechazadas")}` : ""}${c.message ? ` · ${c.message}` : ""}`;
              return `${name}: ${state}`;
            })
            .join(" · ")}
          {publishState.byChannel.some((c) => c.status === "done" || c.status === "sending") ? " (recuento del rango visible)" : ""}
        </InlineNotice>
      ) : null}

      {gridResponse ? (
        <CocoaRateGrid
          response={gridResponse}
          dates={dates}
          view={view}
          layers={layers}
          draft={draft}
          selection={selection}
          onSelectionChange={setSelection}
          onCellEdit={handleCellEdit}
          onOpenQuickEdit={handleOpenQuickEdit}
          onOpenBulkEdit={handleOpenBulkEdit}
          onCellRecommendationAction={(key, action, value) => {
            if (action === "accept" && value === undefined) setRecPopover({ key, anchorRect: null });
            else handleRecommendationAction(key, action, value);
          }}
          channelIdForView={channelIdForView || undefined}
          readOnly={readOnly}
          propertyName={propertyName}
          channelMappings={channelMappingsLite}
          onUndo={undo}
          onRedo={redo}
          onDiscardCells={handleDiscardCells}
          today={today}
          onOpenRecommendation={(key, anchorRect) => setRecPopover({ key, anchorRect })}
          onEditRefused={handleEditRefused}
          syncUnavailable={syncUnavailable}
        />
      ) : (
        <div
          style={{
            minHeight: 240,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            border: "1px dashed var(--cocoa-separator)",
            borderRadius: "var(--cocoa-radius-md)",
            color: "var(--cocoa-label-secondary)",
            fontSize: "var(--cocoa-fs-body)"
          }}
        >
          {loading ? "Cargando parrilla…" : "La parrilla no se ha podido cargar. Revisa el aviso de arriba y vuelve a intentarlo."}
        </div>
      )}

      <RateGridStatusBar
        draft={draft}
        roomTypeCount={response?.roomTypes.length ?? 0}
        ratePlanCount={response?.ratePlans.length ?? 0}
        canUndo={canUndo(store)}
        canRedo={canRedo(store)}
        onUndo={undo}
        onRedo={redo}
        onDiscard={discardDraft}
        onSaveDraft={requestSave}
        onReviewAndPublish={requestReview}
        saving={saving}
        lastSavedAt={lastSavedAt}
        lastPublishedAt={lastPublishedAt}
        restorable={restorable ? { count: restorable.count, savedAt: restorable.savedAt } : null}
        onRestore={restoreDraft}
        onDiscardRestorable={discardRestorable}
        readOnly={readOnly}
        pendingPush={pendingPush}
        onSendPending={draftIsEmpty(draft) ? openReview : undefined}
        syncUnavailable={syncUnavailable}
      />

      <QuickEditPopover
        open={quickEdit.open}
        anchorRect={quickEdit.anchorRect}
        cellCount={quickEdit.keys.length}
        hasBar={Boolean(barPlan)}
        initialRestrictions={
          quickEdit.keys.length > 0
            ? (() => {
                const first = quickEdit.keys[0];
                const entry = draft.patches.get(first);
                const base = cellIndex.get(first)?.restrictions ?? null;
                return entry?.patch.restrictions ? applyRestrictionsPatch(base, entry.patch.restrictions) : base;
              })()
            : null
        }
        onApply={applyQuickEdit}
        onMoreOptions={() => {
          setQuickEdit({ open: false, anchorRect: null, keys: [] });
          handleOpenBulkEdit();
        }}
        onClose={() => setQuickEdit({ open: false, anchorRect: null, keys: [] })}
      />

      {response ? (
        <BulkEditSheet
          open={bulkEdit.open}
          response={response}
          draft={draft}
          prefill={bulkEdit.prefill}
          defaultRange={{ from, to }}
          reasonPresets={REASON_PRESETS}
          onApply={applyBulkSubmission}
          onClose={() => setBulkEdit({ open: false })}
        />
      ) : null}

      {response ? (
        <ReviewPublishDrawer
          open={reviewOpen}
          response={response}
          draft={draft}
          channels={effectiveChannels}
          channelMappings={channelMappingsLite}
          publishState={publishState}
          currentUserLabel={currentUser?.email ?? currentUser?.fullName ?? null}
          onPublish={handlePublish}
          onSaveDraftOnly={() => void runBulkUpdate("save", [])}
          onClose={() => setReviewOpen(false)}
          pendingPush={pendingPush}
          onPushPending={(args) => void handlePushPending(args)}
        />
      ) : null}

      <SyncStatusPanel
        open={syncPanelOpen}
        channels={effectiveChannels}
        cells={syncMatrix}
        roomTypes={response?.roomTypes ?? []}
        ratePlans={response?.ratePlans ?? []}
        summary={syncStatus?.summary}
        onRetry={(args) => void handleSyncRetry(args)}
        onShowInHistory={() => {
          setSyncPanelOpen(false);
          setHistoryOpen(true);
        }}
        onClose={() => setSyncPanelOpen(false)}
        loading={publishState.phase === "publishing"}
        degraded={syncUnavailable}
        pendingPush={pendingPush}
        onSendPending={
          draftIsEmpty(draft) && !readOnly
            ? () => {
                setSyncPanelOpen(false);
                openReview();
              }
            : undefined
        }
      />

      <HistoryDrawer
        open={historyOpen}
        items={journal.items}
        hasMore={journal.hasMore}
        loading={journal.loading}
        roomTypes={response?.roomTypes ?? []}
        ratePlans={response?.ratePlans ?? []}
        channels={allChannels}
        expandedId={journal.expandedId}
        expandedItems={journal.expandedItems}
        onLoadMore={journal.loadMore}
        onRevert={journal.requestRevert}
        onShowDiff={journal.showDiff}
        onClose={() => setHistoryOpen(false)}
      />

      {recPopoverData && recPopover ? (
        <RecommendationPopover
          open
          anchorRect={recPopover.anchorRect}
          cellKey={recPopover.key}
          recommendation={recPopoverData.rec}
          currency={response?.currency ?? "EUR"}
          roomTypeName={recPopoverData.roomTypeName}
          ratePlanCode={recPopoverData.ratePlanCode}
          date={recPopoverData.parsed.date}
          onAction={handleRecommendationAction}
          onClose={() => setRecPopover(null)}
        />
      ) : null}

      <ReasonSheet
        open={reasonSheet.open}
        initial={reason}
        title={reasonSheet.next === "review" ? "Motivo del cambio antes de publicar" : "Motivo del cambio"}
        onConfirm={onReasonConfirmed}
        onClose={() => setReasonSheet((s) => ({ ...s, open: false }))}
      />

      <ConfirmDialog
        open={journal.pendingRevertId !== null}
        title="Revertir este cambio"
        description="Se crea una entrada nueva que restaura en Anfitorio los valores anteriores de todas las celdas de este cambio. Los canales no se tocan: al terminar podrás enviarles las celdas revertidas desde el aviso «Enviar a canales»."
        confirmLabel={journal.reverting ? "Revirtiendo…" : "Revertir"}
        cancelLabel="Cancelar"
        variant="danger"
        onConfirm={() => void journal.confirmRevert()}
        onCancel={journal.cancelRevert}
      />

      <JournalStaleDialog
        open={journal.staleRevert !== null}
        cells={journal.staleRevert?.cells ?? []}
        message={journal.staleRevert?.message}
        roomTypes={response?.roomTypes ?? []}
        ratePlans={response?.ratePlans ?? []}
        channels={allChannels}
        reverting={journal.reverting}
        onForce={() => void journal.forceRevert()}
        onCancel={journal.cancelStaleRevert}
      />

      <ConfirmDialog
        open={pendingNav !== null}
        title="Tienes cambios sin guardar"
        description={`Hay ${pluralize(draftChangeCount(draft), "celda editada", "celdas editadas")} sin guardar. Se conservarán en esta pestaña para que puedas recuperarlas al volver, pero no se guardarán en Anfitorio.`}
        confirmLabel="Salir igualmente"
        cancelLabel="Seguir editando"
        variant="danger"
        onConfirm={confirmLeave}
        onCancel={() => setPendingNav(null)}
      />
    </section>
  );
}

export default RateGridEditorScreen;
