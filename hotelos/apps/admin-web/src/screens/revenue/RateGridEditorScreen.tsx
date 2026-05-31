// RateGridEditorScreen — Pantalla principal del editor de tarifas.
//
// Layout: CocoaPageHeader, toolbar (from/to + room-type multi-select + channel
// + BAR level + Refresh + journal link), CocoaRateGrid, RateGridBulkEditDrawer
// cuando hay seleccion, y RateGridStatusBar abajo. PropertyId desde el
// active-property context. Cambios se acumulan en `localPatches` (overlay
// sobre cells); push hace bulk-update + push API en secuencia.

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type ChangeEvent
} from "react";
import type {
  RateGridCell,
  RateGridBulkUpdateRequest,
  RateRestrictions
} from "@hotelos/shared";
import { getActivePropertyId } from "../../services/activeProperty";
import {
  fetchRateGrid,
  bulkUpdateRateGrid,
  pushRateGrid
} from "../../services/rateGridApi";
import { fetchRoomTypes, type AdminRoomType } from "../../services/pmsCommerceApi";
import { CocoaPageHeader } from "../../components/cocoa/CocoaPageHeader";
import { CocoaCard } from "../../components/cocoa/CocoaCard";
import { CocoaButton } from "../../components/cocoa/CocoaButton";
import { CocoaDatePicker } from "../../components/cocoa/CocoaDatePicker";
import { CocoaSelect } from "../../components/cocoa/CocoaSelect";
import { CocoaRateGrid } from "../../components/cocoa-rate-grid/CocoaRateGrid";
import {
  RateGridBulkEditDrawer,
  type BulkEditOperation,
  type RateGridChannelOption
} from "../../components/cocoa-rate-grid/RateGridBulkEditDrawer";
import { RateGridStatusBar } from "../../components/cocoa-rate-grid/RateGridStatusBar";
import type {
  CellId,
  RateGridCellPatch,
  RoomType
} from "../../components/cocoa-rate-grid/types";
import { ErrorState, LoadingBlock } from "../../components/States";

type LocalPatches = Map<CellId, RateGridCellPatch>;
type ToolbarFilters = {
  from: string;
  to: string;
  roomTypeIds: string[];
  channelId: string;
  barLevel: string;
};

const BAR_LEVELS = [
  { value: "BAR", label: "BAR (público)" },
  { value: "BAR_NR", label: "BAR No reembolsable" },
  { value: "BAR_FLEX", label: "BAR Flexible" },
  { value: "BAR_AAA", label: "BAR Corporativa" }
];

// Catálogo curado de canales (en producción vendría del channel-manager).
const DEFAULT_CHANNELS: RateGridChannelOption[] = [
  { id: "booking", name: "Booking.com", defaultMarkupPercent: 0 },
  { id: "expedia", name: "Expedia", defaultMarkupPercent: 0 },
  { id: "airbnb", name: "Airbnb", defaultMarkupPercent: 0 },
  { id: "direct", name: "Directo", defaultMarkupPercent: 0 }
];

// ---------- Helpers ----------

function todayIso(): string {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

function plusDaysIso(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const date = new Date(y, (m ?? 1) - 1, d ?? 1);
  date.setDate(date.getDate() + days);
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${mm}-${dd}`;
}

function buildDateRange(from: string, to: string): Date[] {
  const [yf, mf, df] = from.split("-").map(Number);
  const [yt, mt, dt] = to.split("-").map(Number);
  const start = new Date(yf, (mf ?? 1) - 1, df ?? 1);
  const end = new Date(yt, (mt ?? 1) - 1, dt ?? 1);
  const out: Date[] = [];
  for (const c = new Date(start); c.getTime() <= end.getTime(); c.setDate(c.getDate() + 1)) {
    out.push(new Date(c));
    if (out.length > 366) break;
  }
  return out;
}

function makeCellId(roomTypeId: string, isoDate: string): CellId {
  return `${roomTypeId}__${isoDate}`;
}

function parseCellId(id: CellId): { roomTypeId: string; date: string } | null {
  const [roomTypeId, date] = id.split("__");
  return roomTypeId && date ? { roomTypeId, date } : null;
}

/** Overlay de patches sobre cells antes de renderizar el grid. */
function mergeCellsWithPatches(cells: RateGridCell[], patches: LocalPatches): RateGridCell[] {
  if (patches.size === 0) return cells;
  return cells.map((cell) => {
    const patch = patches.get(makeCellId(cell.roomTypeId, cell.date));
    if (!patch) return cell;
    const next: RateGridCell = { ...cell };
    if (patch.price !== undefined && Number.isFinite(patch.price)) {
      next.basePrice = patch.price;
      next.effectivePrice = patch.price;
    }
    if (patch.restrictions) {
      next.restrictions = { ...(cell.restrictions ?? {}), ...patch.restrictions };
    }
    return next;
  });
}

/** Traduce un BulkEditOperation en patches por celda. */
function bulkOpToPatches(
  op: BulkEditOperation,
  selectedIds: CellId[],
  cellById: Map<CellId, RateGridCell>
): Array<[CellId, RateGridCellPatch]> {
  const out: Array<[CellId, RateGridCellPatch]> = [];
  for (const id of selectedIds) {
    const cell = cellById.get(id);
    if (!cell) continue;
    const patch: RateGridCellPatch = {};
    if (op.value) {
      switch (op.value.mode) {
        case "fixed":
          patch.price = op.value.value;
          break;
        case "deltaPercent":
          patch.price = Math.round(cell.basePrice * (1 + op.value.value / 100));
          break;
        case "deltaAbsolute":
          patch.price = Math.round(cell.basePrice + op.value.value);
          break;
        case "copyFrom": {
          for (const c of cellById.values()) {
            if (c.roomTypeId === cell.roomTypeId && c.date === op.value.sourceDate) {
              patch.price = c.basePrice;
              break;
            }
          }
          break;
        }
      }
    }
    if (op.restrictions && Object.keys(op.restrictions).length > 0) {
      patch.restrictions = op.restrictions as Partial<RateRestrictions>;
    }
    if (patch.price !== undefined || patch.restrictions !== undefined) {
      out.push([id, patch]);
    }
  }
  return out;
}

/** Convierte el LocalPatches en RateGridBulkUpdateRequest. */
function patchesToBulkRequest(
  patches: LocalPatches,
  channelId: string | undefined,
  reason: string
): RateGridBulkUpdateRequest {
  const cells: RateGridBulkUpdateRequest["cells"] = [];
  for (const [id, patch] of patches) {
    const parsed = parseCellId(id);
    if (!parsed) continue;
    const entry: RateGridBulkUpdateRequest["cells"][number] = {
      roomTypeId: parsed.roomTypeId,
      date: parsed.date
    };
    if (channelId) entry.channelId = channelId;
    if (patch.price !== undefined) entry.price = patch.price;
    if (patch.restrictions) entry.restrictions = patch.restrictions;
    cells.push(entry);
  }
  return { cells, reason };
}

// ---------- Styles ----------

const screenStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--cocoa-space-4)",
  fontFamily: "var(--cocoa-font)",
  minHeight: 0
};

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

const fieldStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 4,
  minWidth: 140
};

const labelStyle: CSSProperties = {
  fontSize: "var(--cocoa-fs-caption)",
  fontWeight: 600,
  color: "var(--cocoa-label-secondary)",
  textTransform: "uppercase",
  letterSpacing: "var(--cocoa-tracking-wide)"
};

const multiSelectStyle: CSSProperties = {
  height: 64,
  padding: "0 8px",
  fontSize: "var(--cocoa-fs-body)",
  fontFamily: "var(--cocoa-font)",
  color: "var(--cocoa-label)",
  background: "var(--cocoa-background-control)",
  border: "1px solid var(--cocoa-separator)",
  borderRadius: "var(--cocoa-radius-md)",
  outline: "none",
  minWidth: 180,
  maxWidth: 240
};

const historyLinkStyle: CSSProperties = {
  fontSize: "var(--cocoa-fs-body)",
  color: "var(--cocoa-accent)",
  cursor: "pointer",
  fontFamily: "var(--cocoa-font)",
  padding: "4px 0",
  background: "transparent",
  border: "none"
};

// ---------- Componente ----------

export function RateGridEditorScreen() {
  // Snapshot al montar: setActiveProperty hace reload, no necesitamos reactividad.
  const propertyId = useMemo(() => getActivePropertyId(), []);

  const [filters, setFilters] = useState<ToolbarFilters>(() => ({
    from: todayIso(),
    to: plusDaysIso(todayIso(), 13),
    roomTypeIds: [],
    channelId: "",
    barLevel: "BAR"
  }));

  const [cells, setCells] = useState<RateGridCell[]>([]);
  const [roomTypes, setRoomTypes] = useState<AdminRoomType[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [selectedCells, setSelectedCells] = useState<CellId[]>([]);
  const [localPatches, setLocalPatches] = useState<LocalPatches>(() => new Map());
  const [pushing, setPushing] = useState(false);
  const [showJournal, setShowJournal] = useState(false);
  const [lastPushAt, setLastPushAt] = useState<string | undefined>(undefined);
  const [pushBanner, setPushBanner] = useState<string | null>(null);

  // Cargar catalogo de room types una vez.
  useEffect(() => {
    let alive = true;
    fetchRoomTypes(propertyId)
      .then((rt) => {
        if (alive) setRoomTypes(rt);
      })
      .catch(() => {
        /* El fetch del grid reporta el error principal */
      });
    return () => {
      alive = false;
    };
  }, [propertyId]);

  const loadCells = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const items = await fetchRateGrid({
        propertyId,
        from: filters.from,
        to: filters.to,
        roomTypeIds: filters.roomTypeIds.length > 0 ? filters.roomTypeIds : undefined,
        channelId: filters.channelId || undefined
      });
      setCells(items);
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudo cargar el rate grid.");
    } finally {
      setLoading(false);
    }
  }, [propertyId, filters.from, filters.to, filters.roomTypeIds, filters.channelId]);

  useEffect(() => {
    void loadCells();
  }, [loadCells]);

  // ---------- Derived ----------

  const dates = useMemo(() => buildDateRange(filters.from, filters.to), [filters.from, filters.to]);

  const visibleRoomTypes: RoomType[] = useMemo(() => {
    const baseList = roomTypes.length > 0
      ? roomTypes
      : Array.from(new Set(cells.map((c) => c.roomTypeId))).map((id) => ({
          id, propertyId, name: id, code: id, maxOccupancy: 0
        }));
    const filtered = filters.roomTypeIds.length > 0
      ? baseList.filter((rt) => filters.roomTypeIds.includes(rt.id))
      : baseList;
    return filtered.map((rt) => ({
      id: rt.id, code: rt.code, name: rt.name, baseOccupancy: rt.maxOccupancy
    }));
  }, [roomTypes, cells, filters.roomTypeIds, propertyId]);

  const mergedCells = useMemo(
    () => mergeCellsWithPatches(cells, localPatches),
    [cells, localPatches]
  );

  const cellById = useMemo(() => {
    const m = new Map<CellId, RateGridCell>();
    for (const c of cells) m.set(makeCellId(c.roomTypeId, c.date), c);
    return m;
  }, [cells]);

  const selectedCellObjects: RateGridCell[] = useMemo(() => {
    const out: RateGridCell[] = [];
    for (const id of selectedCells) {
      const cell = cellById.get(id);
      if (cell) out.push(cell);
    }
    return out;
  }, [selectedCells, cellById]);

  const unsavedCount = localPatches.size;

  // ---------- Handlers ----------

  const handleFilterFrom = useCallback((v: string) => setFilters((p) => ({ ...p, from: v })), []);
  const handleFilterTo = useCallback((v: string) => setFilters((p) => ({ ...p, to: v })), []);
  const handleFilterChannel = useCallback((v: string) => setFilters((p) => ({ ...p, channelId: v })), []);
  const handleFilterBar = useCallback((v: string) => setFilters((p) => ({ ...p, barLevel: v })), []);

  const handleFilterRoomTypes = useCallback((event: ChangeEvent<HTMLSelectElement>) => {
    const opts = Array.from(event.target.selectedOptions).map((o) => o.value);
    setFilters((p) => ({ ...p, roomTypeIds: opts }));
  }, []);

  const handleRefresh = useCallback(() => { void loadCells(); }, [loadCells]);

  const handleCellChange = useCallback((cellId: CellId, patch: RateGridCellPatch) => {
    setLocalPatches((prev) => {
      const next = new Map(prev);
      const existing = next.get(cellId) ?? {};
      const merged: RateGridCellPatch = {
        price: patch.price !== undefined ? patch.price : existing.price,
        restrictions: patch.restrictions || existing.restrictions
          ? { ...(existing.restrictions ?? {}), ...(patch.restrictions ?? {}) }
          : undefined
      };
      if (merged.price === undefined) delete merged.price;
      if (!merged.restrictions || Object.keys(merged.restrictions).length === 0) {
        delete merged.restrictions;
      }
      if (merged.price === undefined && merged.restrictions === undefined) next.delete(cellId);
      else next.set(cellId, merged);
      return next;
    });
  }, []);

  const handleSelectionChange = useCallback((ids: CellId[]) => setSelectedCells(ids), []);

  const handleBulkApply = useCallback((op: BulkEditOperation) => {
    const entries = bulkOpToPatches(op, selectedCells, cellById);
    if (entries.length === 0) { setSelectedCells([]); return; }
    setLocalPatches((prev) => {
      const next = new Map(prev);
      for (const [id, patch] of entries) {
        const existing = next.get(id) ?? {};
        next.set(id, {
          price: patch.price !== undefined ? patch.price : existing.price,
          restrictions: patch.restrictions
            ? { ...(existing.restrictions ?? {}), ...patch.restrictions }
            : existing.restrictions
        });
      }
      return next;
    });
    setSelectedCells([]);
  }, [selectedCells, cellById]);

  const handleDiscard = useCallback(() => {
    setLocalPatches(new Map());
    setPushBanner(null);
  }, []);

  const handleCancelDrawer = useCallback(() => setSelectedCells([]), []);

  const submitAndPush = useCallback(async (channelIds: string[]) => {
    if (localPatches.size === 0) return;
    setPushing(true);
    setPushBanner(null);
    setError(null);
    try {
      const bulkBody = patchesToBulkRequest(
        localPatches,
        filters.channelId || undefined,
        `RateGridEditor · ${filters.barLevel}`
      );
      await bulkUpdateRateGrid(propertyId, bulkBody);
      const pushRes = await pushRateGrid(propertyId, {
        from: filters.from,
        to: filters.to,
        channelIds,
        roomTypeIds: filters.roomTypeIds.length > 0 ? filters.roomTypeIds : undefined
      });
      setLocalPatches(new Map());
      setLastPushAt(new Date().toISOString());
      setPushBanner(
        pushRes.failedChannels.length > 0
          ? `Publicado en ${pushRes.pushed} canales · Fallaron: ${pushRes.failedChannels.join(", ")}`
          : `Publicado en ${pushRes.pushed} canales.`
      );
      await loadCells();
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudo publicar.");
    } finally {
      setPushing(false);
    }
  }, [
    localPatches, filters.channelId, filters.barLevel, filters.from, filters.to,
    filters.roomTypeIds, propertyId, loadCells
  ]);

  const handlePushAll = useCallback(() => {
    void submitAndPush(DEFAULT_CHANNELS.map((c) => c.id));
  }, [submitAndPush]);

  const handlePushSelected = useCallback(() => {
    // El status bar no expone selector de canales; usamos el channel activo
    // del toolbar si lo hay, si no caemos en pushAll (semánticamente idem).
    const channels = filters.channelId ? [filters.channelId] : DEFAULT_CHANNELS.map((c) => c.id);
    void submitAndPush(channels);
  }, [filters.channelId, submitAndPush]);

  const handleOpenJournal = useCallback(() => {
    setShowJournal(true);
    window.dispatchEvent(new CustomEvent("hotelos-nav", { detail: "RateJournalScreen" }));
  }, []);

  // Selecciona TODAS las celdas visibles (visibleRoomTypes × dates) y abre el
  // drawer de bulk edit. Permite operar en masa sin tener que arrastrar selec-
  // cion en el grid.
  const handleOpenBulkEdit = useCallback(() => {
    const ids: CellId[] = [];
    for (const rt of visibleRoomTypes) {
      for (const d of dates) {
        const y = d.getFullYear();
        const m = String(d.getMonth() + 1).padStart(2, "0");
        const day = String(d.getDate()).padStart(2, "0");
        const iso = `${y}-${m}-${day}`;
        const id = makeCellId(rt.id, iso);
        if (cellById.has(id)) ids.push(id);
      }
    }
    setSelectedCells(ids);
  }, [visibleRoomTypes, dates, cellById]);

  const visibleCellsCount = useMemo(() => {
    let n = 0;
    for (const rt of visibleRoomTypes) {
      for (const d of dates) {
        const y = d.getFullYear();
        const m = String(d.getMonth() + 1).padStart(2, "0");
        const day = String(d.getDate()).padStart(2, "0");
        if (cellById.has(makeCellId(rt.id, `${y}-${m}-${day}`))) n += 1;
      }
    }
    return n;
  }, [visibleRoomTypes, dates, cellById]);

  const channelOptions = useMemo(
    () => [
      { value: "", label: "BAR base (sin canal)" },
      ...DEFAULT_CHANNELS.map((c) => ({ value: c.id, label: c.name }))
    ],
    []
  );

  // ---------- Render ----------

  return (
    <section style={screenStyle}>
      <CocoaPageHeader
        eyebrow="Revenue · Distribution"
        title="Rate Grid Editor"
        subtitle="Edita tarifas y restricciones por celda. Push selectivo a canales OTA."
        actions={
          <CocoaButton
            variant="bordered" size="small" tone="neutral"
            onClick={handleRefresh} disabled={loading}
          >
            Recargar
          </CocoaButton>
        }
      />

      <div style={toolbarStyle}>
        <div style={fieldStyle}>
          <label style={labelStyle}>Desde</label>
          <CocoaDatePicker value={filters.from} onChange={handleFilterFrom} size="small" />
        </div>
        <div style={fieldStyle}>
          <label style={labelStyle}>Hasta</label>
          <CocoaDatePicker value={filters.to} onChange={handleFilterTo} size="small" />
        </div>
        <div style={{ ...fieldStyle, minWidth: 180 }}>
          <label style={labelStyle}>Tipos de habitación</label>
          <select
            multiple value={filters.roomTypeIds}
            onChange={handleFilterRoomTypes} style={multiSelectStyle}
          >
            {roomTypes.map((rt) => (
              <option key={rt.id} value={rt.id}>{rt.code} · {rt.name}</option>
            ))}
          </select>
        </div>
        <div style={{ ...fieldStyle, minWidth: 160 }}>
          <label style={labelStyle}>Canal</label>
          <CocoaSelect
            value={filters.channelId} onChange={handleFilterChannel}
            options={channelOptions} size="small"
          />
        </div>
        <div style={{ ...fieldStyle, minWidth: 160 }}>
          <label style={labelStyle}>BAR level</label>
          <CocoaSelect
            value={filters.barLevel} onChange={handleFilterBar}
            options={BAR_LEVELS} size="small"
          />
        </div>
        <div style={{ ...fieldStyle, justifyContent: "flex-end", minWidth: 100 }}>
          <CocoaButton
            variant="tinted" size="small" tone="accent"
            onClick={handleRefresh} disabled={loading} loading={loading}
          >
            Refresh
          </CocoaButton>
        </div>
        <div style={{ ...fieldStyle, justifyContent: "flex-end", minWidth: 160 }}>
          <CocoaButton
            variant="bordered" size="small" tone="accent"
            onClick={handleOpenBulkEdit}
            disabled={loading || visibleCellsCount === 0}
            aria-label="Editar en masa todas las celdas visibles"
          >
            Editar en masa…
          </CocoaButton>
        </div>
        <div style={{ ...fieldStyle, justifyContent: "flex-end", minWidth: 140 }}>
          <button
            type="button" onClick={handleOpenJournal}
            style={historyLinkStyle} aria-label="Ver historial de cambios"
          >
            Ver historial →
          </button>
        </div>
      </div>

      {pushBanner ? (
        <CocoaCard padding="sm" variant="bordered">
          <p style={{ margin: 0, fontSize: "var(--cocoa-fs-body)", color: "var(--cocoa-label)" }}>
            {pushBanner}
          </p>
        </CocoaCard>
      ) : null}

      {loading ? (
        <LoadingBlock label="Cargando rate grid…" />
      ) : error ? (
        <ErrorState title="No se pudo cargar" message={error} onRetry={handleRefresh} />
      ) : (
        <CocoaRateGrid
          cells={mergedCells}
          roomTypes={visibleRoomTypes}
          dates={dates}
          selectedChannelId={filters.channelId || undefined}
          onCellChange={handleCellChange}
          onSelectionChange={handleSelectionChange}
        />
      )}

      <RateGridStatusBar
        unsavedCount={unsavedCount}
        lastPushAt={lastPushAt}
        onDiscard={handleDiscard}
        onPushSelected={handlePushSelected}
        onPushAll={handlePushAll}
        pushing={pushing}
      />

      {selectedCells.length > 0 ? (
        <RateGridBulkEditDrawer
          selectedCells={selectedCellObjects}
          onApply={handleBulkApply}
          onCancel={handleCancelDrawer}
          channels={DEFAULT_CHANNELS}
        />
      ) : null}

      {/* showJournal queda en estado para futuras integraciones inline (modal). */}
      {showJournal ? null : null}
    </section>
  );
}

export default RateGridEditorScreen;
