// RateJournalScreen — standalone host of the rate grid HistoryDrawer.
//
// Rate grid v2 (2026-09): the history lives INSIDE the editor (drawer with
// diff + revert). This screen keeps the sidebar entry "Historial de tarifas"
// and the deep link /backoffice/revenue/... alive as a thin wrapper: it mounts
// the same drawer, backed by the same `useRateJournal` hook the editor uses,
// so there is a single implementation of paging, diff loading and revert.
//
// The hook is exported from here (not from a components/ file) because the
// front-screen lot only owns screen + service files; the drawer component
// itself belongs to the cocoa-rate-grid lot.
//
// Revert (cierre 2026-09-15): the API refuses with 409 JOURNAL_STALE when a
// later edit changed any cell of the entry; the hook turns that into
// `staleRevert` (cells + message) so both hosts render JournalStaleDialog
// («Forzar reversión» → `{ force: true }`). Deep link: /backoffice/revenue/rate-journal.

import { useTabHost } from "../tabs/TabHost";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type { RateChangeJournalEntry, RateChangeJournalItem, RateGridRatePlan, RateGridRoomType } from "@hotelos/shared";
import {
  JOURNAL_STALE_CODE,
  classifyRateGridError,
  fetchJournal,
  fetchJournalEntry,
  fetchRatePlans,
  revertJournal,
  type JournalStaleCell
} from "../../services/rateGridApi";
import { fetchRoomTypes } from "../../services/pmsCommerceApi";
import { listChannels } from "../../services/channelsApi";
import { pluralize } from "../../components/cocoa-rate-grid/helpers";
import type { RateGridChannel } from "@hotelos/shared";
import { getActivePropertyId } from "../../services/activeProperty";
import { navigateTo } from "../../lib/navigate";
import { CocoaPageHeader } from "../../components/cocoa/CocoaPageHeader";
import { CocoaButton } from "../../components/cocoa/CocoaButton";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { useToast } from "../../components/Toast";
import { HistoryDrawer } from "../../components/cocoa-rate-grid/HistoryDrawer";
import { JournalStaleDialog } from "../../components/cocoa-rate-grid/JournalStaleDialog";

const PAGE_SIZE = 50;

export type RateJournalState = {
  items: RateChangeJournalEntry[];
  hasMore: boolean;
  loading: boolean;
  /** Load/diff error (already humanised). */
  error: string | null;
  expandedId: string | null;
  expandedItems: RateChangeJournalItem[] | null;
  /** Journal id whose revert is being confirmed (ConfirmDialog owner). */
  pendingRevertId: string | null;
  reverting: boolean;
  /**
   * 409 JOURNAL_STALE of the last revert attempt: the grid changed after the
   * entry (cells listed). The screen shows JournalStaleDialog; `forceRevert`
   * re-sends `{ force: true }`, `cancelStaleRevert` drops it.
   */
  staleRevert: { journalId: string; cells: JournalStaleCell[]; message: string } | null;
  refresh: () => void;
  loadMore: () => void;
  showDiff: (journalId: string) => void;
  requestRevert: (journalId: string) => void;
  cancelRevert: () => void;
  /** Runs the revert of `pendingRevertId`; resolves true when the API accepted it. */
  confirmRevert: () => Promise<boolean>;
  forceRevert: () => Promise<boolean>;
  cancelStaleRevert: () => void;
};

/**
 * What a revert produced: the compensating entry id, the original entry (as
 * listed, with its `pushedTo` channels) and the number of cells restored. The
 * editor uses it to mark those cells as "pending re-send": the API restores
 * rate_days but never touches the channels, which keep the reverted value.
 */
export type RateJournalRevertInfo = {
  journalId: string;
  originalId: string;
  original: RateChangeJournalEntry | null;
  updated: number;
};

/**
 * Journal paging + diff + revert, shared by the editor and this screen.
 * `enabled: false` (drawer closed) skips the initial load until opened, and
 * every re-open reloads the first page: entries published or saved while the
 * drawer was closed showed up only after an F5 otherwise
 * (browser-ux-final#4). `refresh()` reloads on demand (the screen's
 * «Actualizar», the editor's «Recargar» and each successful save/publish).
 */
export function useRateJournal(propertyId: string, options: { enabled?: boolean; onReverted?: (info: RateJournalRevertInfo) => void } = {}): RateJournalState {
  const enabled = options.enabled ?? true;
  const { showToast } = useToast();
  const [items, setItems] = useState<RateChangeJournalEntry[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [expandedItems, setExpandedItems] = useState<RateChangeJournalItem[] | null>(null);
  const [pendingRevertId, setPendingRevertId] = useState<string | null>(null);
  const [reverting, setReverting] = useState(false);
  const [staleRevert, setStaleRevert] = useState<RateJournalState["staleRevert"]>(null);
  const [nonce, setNonce] = useState(0);
  const loadedForRef = useRef<string | null>(null);
  const onRevertedRef = useRef(options.onReverted);
  onRevertedRef.current = options.onReverted;

  const loadPage = useCallback(
    async (after: string | null, replace: boolean) => {
      setLoading(true);
      setError(null);
      try {
        const page = await fetchJournal(propertyId, { limit: PAGE_SIZE, cursor: after });
        setItems((prev) => (replace ? page.items : [...prev, ...page.items]));
        setCursor(page.nextCursor);
      } catch (err) {
        setError(classifyRateGridError(err).message);
      } finally {
        setLoading(false);
      }
    },
    [propertyId]
  );

  useEffect(() => {
    if (!enabled) {
      // Closed: forget the loaded token so the next open fetches page 1 again.
      loadedForRef.current = null;
      return;
    }
    const token = `${propertyId}:${nonce}`;
    if (loadedForRef.current === token) return;
    loadedForRef.current = token;
    setExpandedId(null);
    setExpandedItems(null);
    void loadPage(null, true);
  }, [enabled, propertyId, nonce, loadPage]);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);
  const loadMore = useCallback(() => {
    if (!cursor || loading) return;
    void loadPage(cursor, false);
  }, [cursor, loading, loadPage]);

  const showDiff = useCallback(
    (journalId: string) => {
      if (expandedId === journalId) {
        setExpandedId(null);
        setExpandedItems(null);
        return;
      }
      setExpandedId(journalId);
      setExpandedItems(null);
      fetchJournalEntry(propertyId, journalId)
        .then((entry) => {
          setExpandedItems(entry.items ?? []);
          setItems((prev) => prev.map((row) => (row.id === journalId ? { ...row, ...entry } : row)));
        })
        .catch((err: unknown) => {
          setError(classifyRateGridError(err).message);
        });
    },
    [expandedId, propertyId]
  );

  const requestRevert = useCallback((journalId: string) => setPendingRevertId(journalId), []);
  const cancelRevert = useCallback(() => setPendingRevertId(null), []);
  const cancelStaleRevert = useCallback(() => setStaleRevert(null), []);

  // One revert path for the confirmation dialog and for «Forzar reversión»:
  // a 409 JOURNAL_STALE is not an error toast but a second, explicit dialog
  // (the API wrote nothing); everything else keeps the toast + error notice.
  const runRevert = useCallback(
    async (journalId: string, force: boolean) => {
      setReverting(true);
      try {
        const original = items.find((row) => row.id === journalId) ?? null;
        const res = await revertJournal(propertyId, journalId, { reason: force ? "Reversión forzada desde el historial" : "Reversión desde el historial", ...(force ? { force: true } : {}) });
        showToast(`Cambio revertido en Anfitorio (${pluralize(res.updated, "celda restaurada", "celdas restauradas")}). Los canales conservan el valor anterior hasta que lo envíes.`, { variant: "success" });
        setPendingRevertId(null);
        setStaleRevert(null);
        refresh();
        onRevertedRef.current?.({ journalId: res.journalId, originalId: journalId, original, updated: res.updated });
        return true;
      } catch (err) {
        const info = classifyRateGridError(err);
        if (info.code === JOURNAL_STALE_CODE && !force) {
          setPendingRevertId(null);
          setStaleRevert({ journalId, cells: info.staleCells, message: info.message });
          return false;
        }
        showToast(info.message, { variant: "error" });
        setError(info.message);
        return false;
      } finally {
        setReverting(false);
      }
    },
    [propertyId, items, refresh, showToast]
  );

  const confirmRevert = useCallback(async () => {
    if (!pendingRevertId) return false;
    return runRevert(pendingRevertId, false);
  }, [pendingRevertId, runRevert]);

  const forceRevert = useCallback(async () => {
    if (!staleRevert) return false;
    return runRevert(staleRevert.journalId, true);
  }, [staleRevert, runRevert]);

  return {
    items,
    hasMore: Boolean(cursor),
    loading,
    error,
    expandedId,
    expandedItems,
    pendingRevertId,
    reverting,
    staleRevert,
    refresh,
    loadMore,
    showDiff,
    requestRevert,
    cancelRevert,
    confirmRevert,
    forceRevert,
    cancelStaleRevert
  };
}

const screenStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--cocoa-space-4)",
  fontFamily: "var(--cocoa-font)"
};

const JOURNAL_SUBTITLE = "Cada guardado o publicación del editor crea una entrada con su diff celda a celda. Desde aquí se revierte.";

// Embedded as the «Historial» tab of Parrilla de tarifas: the container paints
// the page header, so only the subtitle and the actions stay, in one row.
const embeddedBarStyle: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  gap: "var(--cocoa-space-3)",
  flexWrap: "wrap"
};
const embeddedSubtitleStyle: CSSProperties = { color: "var(--cocoa-label-secondary)", fontSize: "var(--cocoa-fs-body)" };
const embeddedActionsStyle: CSSProperties = { display: "inline-flex", gap: "var(--cocoa-space-2)", flexShrink: 0 };

const noticeStyle: CSSProperties = {
  padding: "var(--cocoa-space-3)",
  borderRadius: "var(--cocoa-radius-md)",
  border: "1px solid var(--cocoa-separator)",
  background: "var(--cocoa-background-content)",
  color: "var(--cocoa-label)",
  fontSize: "var(--cocoa-fs-body)"
};

export function RateJournalScreen() {
  // Hosted inside a routed tab container (Tanda 5): the container paints the page header.
  const embedded = useTabHost() !== null;
  // Snapshot at mount: setActiveProperty reloads the page, so no subscription needed here.
  const propertyId = useMemo(() => getActivePropertyId(), []);
  const journal = useRateJournal(propertyId);
  const [roomTypes, setRoomTypes] = useState<RateGridRoomType[]>([]);
  const [ratePlans, setRatePlans] = useState<RateGridRatePlan[]>([]);
  const [channels, setChannels] = useState<RateGridChannel[]>([]);
  const [open, setOpen] = useState(true);

  // Names for the diff rows and for `pushedTo`. The three catalogues are
  // best-effort: the drawer falls back to ids when a lookup fails (the
  // failure is not the user's).
  useEffect(() => {
    let alive = true;
    fetchRoomTypes(propertyId)
      .then((rows) => {
        if (alive) setRoomTypes(rows.map((r) => ({ id: r.id, code: r.code, name: r.name, rooms: 0, maxOccupancy: r.maxOccupancy })));
      })
      .catch(() => {
        /* ids shown instead of names; the journal itself reports its own errors */
      });
    fetchRatePlans(propertyId)
      .then((rows) => {
        if (alive) setRatePlans(rows);
      })
      .catch(() => {
        /* same: names are cosmetic here */
      });
    listChannels(propertyId)
      .then((rows) => {
        if (alive) setChannels(rows);
      })
      .catch(() => {
        /* channel ids shown instead of names */
      });
    return () => {
      alive = false;
    };
  }, [propertyId]);

  const openEditor = useCallback(() => navigateTo("RateGridEditorScreen"), []);

  const headerActions = (
    <>
      <CocoaButton variant="bordered" tone="neutral" size="small" onClick={journal.refresh} loading={journal.loading}>
        Actualizar
      </CocoaButton>
      <CocoaButton variant="filled" tone="accent" size="small" onClick={openEditor}>
        Abrir el editor de tarifas
      </CocoaButton>
    </>
  );

  return (
    <div style={screenStyle}>
      {embedded ? (
        <div style={embeddedBarStyle}>
          <span style={embeddedSubtitleStyle}>{JOURNAL_SUBTITLE}</span>
          <span style={embeddedActionsStyle}>{headerActions}</span>
        </div>
      ) : (
        <CocoaPageHeader eyebrow="Revenue · Parrilla de tarifas" title="Historial de cambios de tarifas" subtitle={JOURNAL_SUBTITLE} actions={headerActions} />
      )}

      {journal.error ? (
        <div role="status" style={noticeStyle}>
          {journal.error}
        </div>
      ) : null}

      {!open ? (
        <div style={noticeStyle}>
          El historial se ha cerrado.{" "}
          <button type="button" className="bo-button-link" onClick={() => setOpen(true)}>
            Volver a abrirlo
          </button>{" "}
          o{" "}
          <button type="button" className="bo-button-link" onClick={openEditor}>
            ir al editor
          </button>
          .
        </div>
      ) : null}

      <HistoryDrawer
        open={open}
        items={journal.items}
        hasMore={journal.hasMore}
        loading={journal.loading}
        roomTypes={roomTypes}
        ratePlans={ratePlans}
        channels={channels}
        expandedId={journal.expandedId}
        expandedItems={journal.expandedItems}
        onLoadMore={journal.loadMore}
        onRevert={journal.requestRevert}
        onShowDiff={journal.showDiff}
        onClose={() => setOpen(false)}
      />

      <ConfirmDialog
        open={journal.pendingRevertId !== null}
        title="Revertir este cambio"
        description="Se crea una entrada nueva que restaura en Anfitorio los valores anteriores de todas las celdas de este cambio. Los canales no se tocan: desde el editor de tarifas podrás enviarles las celdas revertidas."
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
        roomTypes={roomTypes}
        ratePlans={ratePlans}
        channels={channels}
        reverting={journal.reverting}
        onForce={() => void journal.forceRevert()}
        onCancel={journal.cancelStaleRevert}
      />
    </div>
  );
}

export default RateJournalScreen;
