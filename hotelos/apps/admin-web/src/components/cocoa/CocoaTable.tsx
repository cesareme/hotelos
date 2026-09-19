// CocoaTable — the data table of Cocoa 22 (COCOA-22.md §3.7; replaces raw
// <table>, `v2/DataTable`, `.cm-table`, `.rev-report-table`, `DataPreview`).
//
//   thead   sticky on the sidebar background with `0 1px 0 separator, 0 2px 6px`
//           (NO blur); th caption 600 uppercase +0.012em secondary, aria-sort,
//           sortable headers are real buttons. It sticks to the NEAREST
//           SCROLLER: the page (`main.cocoa-content`) by default — the wrapper
//           is deliberately not a scroll container (`overflow-x: clip`) —, or
//           the wrapper itself when `maxHeight` is given. Only when the table
//           is measured wider than its container does the wrapper turn into a
//           horizontal scroller, and then the head no longer sticks to the
//           page (documented limitation; pass `maxHeight` for wide tables).
//           An ancestor with `overflow: hidden` is also a scroll container
//           and captures the sticky head: clip with `overflow: clip` instead.
//   td      body, padding by density (comfortable 8 12 → 36 px rows · compact
//           4 10 → 28 px), hairline bottom; right-aligned columns tabular
//   rows    zebra label 3 % · hover accent 8 % · selection accent 15 % + 3 px
//           inset bar (WCAG 1.4.1) · Enter/Space open when selectable. Zebra,
//           hover and selection are painted by the stylesheet from
//           `data-zebra`, `:hover` and `aria-selected` — no hover state in
//           React (a mouse move used to re-render every cell).
//   extras  `stickyFirstColumn`, `rowActions`, `footer` (totals row), `caption`,
//           `virtualize` (progressive rendering in chunks of 100 past 200 rows),
//           `maxHeight` (own scroller), horizontal scroll wrapper
//   loading CocoaSkeleton rows (no `.bo-*`) · empty centred secondary
//   sizing  `table-layout: auto`. A column with `fit` shrinks to its content on
//           one line (1 px width + nowrap, the trick the actions cell already
//           uses) so the free width goes to the text columns; right-aligned
//           (numeric) cells never wrap («2.595,00 / €»; `nowrap` overrides);
//           `showFrom` hides a secondary column below a viewport tier
//           (`"desktop"` = only ≥ 1200: qa#2 measured 7–9 columns at 1024
//           crushing the text column to 117 px) and `hideOnNarrow` is its
//           `"tablet"` case. `minWidth` on the text column is the floor below
//           which the wrapper scrolls horizontally instead of wrapping;
//           `truncate` caps a cell whose value length the screen does not
//           control (identifiers, tokens) with an ellipsis and a tooltip.
//   < 600   stacked label/value cards (radius 12, hairline, control shadow)
//
// Density can also be inherited from `CocoaPage density` (the
// `data-cocoa-density` attribute resolves `--cocoa-density-cell-padding-*`
// in cocoa-tokens.css) when the prop is omitted.
//
// Hooks for the css lot: wrapper `c22-table-wrap`, table `c22-table` +
// data-zebra/density/sticky-first-column, cells `data-align`, rows
// `data-interactive`/`aria-selected`, actions `c22-table__actions` (shown on
// hover/focus, always on touch, and always when the table carries
// `data-actions="always"` — `rowActionsVisible`), empty `data-empty`, tfoot on
// the inverse surface (stylesheet-owned). With `stickyFirstColumn` the first
// cell of every section takes its opaque background from the stylesheet too
// (content / sidebar / inverse surface): the component never paints it inline.
//
// Tanda UX-1 · U4 (docs/design/UX-RECEPCION-FEEL.md §4 «Selección múltiple»,
// «Columnas configurables», «Esqueleto con retardo»; F11, F25, D11):
//   keepDataWhileLoading  the current rows stay under an `aria-busy` overlay
//                         (`c22-table__busy`) instead of skeleton rows
//   selectable="multiple" a checkbox per row (`c22-table__check`, 44 px on a
//                         coarse pointer, ≥ 24 with a mouse), Shift+clic range,
//                         Ctrl/⌘A on the table, `aria-multiselectable`; a sticky
//                         CocoaActionBar with the count (`batchBar` slot) while
//                         rows are selected — independent of `onSelect` (open)
//   columnsPrefsKey       «Columnas ▾» (show / hide / ↑↓) saved in localStorage
//                         under `hotelos-table-columns:<key>` (pure helpers below)

import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { CocoaActionBar } from "./CocoaActionBar";
import { CocoaButton } from "./CocoaButton";
import { CocoaPopover } from "./CocoaPopover";
import { CocoaSkeleton } from "./CocoaState";
import { toneBg, type CocoaTone } from "./cocoa-tones";
import { useViewportTier, type CocoaViewportTier } from "./cocoa-viewport";

export type CocoaTableSortDirection = "asc" | "desc";
export type CocoaTableDensity = "comfortable" | "compact";

export interface CocoaTableColumn<Row> {
  key: string;
  label: string;
  sortable?: boolean;
  align?: "left" | "right" | "center";
  width?: string;
  minWidth?: number;
  /**
   * Shrink the column to its content on one line (dates, numbers, identifiers,
   * badges, short enums): the free width goes to the text columns instead of
   * being shared out. Implies `nowrap`; an explicit `width` still wins.
   */
  fit?: boolean;
  /** Keep the cells on one line. Default: `true` for `fit` and for `align: "right"` (a number never splits). */
  nowrap?: boolean;
  /**
   * Cap the cell at this many pixels and cut its text with an ellipsis (an
   * inline-block `.cocoa-truncate` around the rendered content; the full text
   * goes to the native tooltip when the cell renders a string or a number).
   * For identifiers, tokens and addresses whose length the screen does not
   * control: with `fit` the column still shrinks to its content, but never
   * past the cap (qa#1 8-A: an 83-character document token made «Documento»
   * 667 px and the table 1610 px inside a 1150 px wrapper). Also applied in
   * the phone cards, where an unbreakable value would otherwise widen the card.
   */
  truncate?: number;
  render?: (row: Row) => ReactNode;
  /** Cell of the totals row (`footer` prop must be true or an object). */
  footer?: ReactNode;
  /** Hide on phones (secondary columns). Same as `showFrom: "tablet"`. */
  hideOnNarrow?: boolean;
  /**
   * First viewport tier that shows the column (`"tablet"` ≥ 600 · `"laptop"`
   * ≥ 900 · `"desktop"` ≥ 1200): secondary columns of wide tables (7+ columns)
   * that would crush the text column on a 1024 laptop.
   */
  showFrom?: CocoaViewportTier;
}

export interface CocoaTableSort {
  key: string;
  direction: CocoaTableSortDirection;
}

export interface CocoaTableProps<Row> {
  columns: CocoaTableColumn<Row>[];
  rows: Row[];
  sortBy?: CocoaTableSort;
  onSort?: (sort: CocoaTableSort) => void;
  rowKey?: string | ((row: Row) => string);
  selectedKey?: string;
  onSelect?: (row: Row) => void;
  /**
   * `multiple`: a checkbox per row (44 px on a coarse pointer), Shift+clic
   * selects a range, Ctrl/⌘A every rendered row, `aria-multiselectable`.
   * Independent of `onSelect` (opens the row) and `selectedKey` (the open row).
   */
  selectable?: "multiple";
  /** Keys of the selected rows (controlled). */
  selectedKeys?: ReadonlyArray<string>;
  onSelectionChange?: (keys: string[]) => void;
  /** Extra controls of the sticky batch bar shown while rows are selected («Check-out de N con saldo 0»); the bar itself paints the count and «Quitar selección». */
  batchBar?: (selection: CocoaTableSelection) => ReactNode;
  emptyState?: ReactNode;
  loading?: boolean;
  /** Keep the current rows under an `aria-busy` overlay while `loading` (a search, a tab change) instead of skeleton rows; skeleton rows still paint when there is nothing to keep. */
  keepDataWhileLoading?: boolean;
  density?: CocoaTableDensity;
  stickyFirstColumn?: boolean;
  /** Trailing actions cell per row (CocoaButton plain/small). */
  rowActions?: (row: Row) => ReactNode;
  /**
   * When the row actions show on a fine pointer: `hover` (default: hover, focus
   * and selection; always on touch and in the phone cards) or `always` — for
   * tables whose actions ARE the interaction (channels: probar · mapeos ·
   * desactivar · archivar) and must be discoverable without a mouse move.
   */
  rowActionsVisible?: "hover" | "always";
  /** Tone wash of a row (`data-tone` on the <tr>, tone-bg on the phone card; hover and selection still win): low stock, overdue… */
  rowTone?: (row: Row) => CocoaTone | undefined;
  /** Native tooltip of a row («Abrir el detalle de la propiedad»). */
  rowTitle?: (row: Row) => string | undefined;
  /** Totals row: `true` uses each column's `footer`; an object maps column key → cell. */
  footer?: boolean | Record<string, ReactNode>;
  /** Progressive rendering for long lists (chunks of 100 once past 200 rows). */
  virtualize?: boolean;
  /** Visually hidden <caption> (accessible name of the table). */
  caption?: string;
  "aria-label"?: string;
  /** Own vertical scroller (the sticky head needs it). */
  maxHeight?: number;
  /** «Columnas ▾» menu (show / hide / reorder with ↑↓) saved in localStorage under this key (D11: per person and browser). */
  columnsPrefsKey?: string;
  className?: string;
  style?: CSSProperties;
}

export interface CocoaTableSelection {
  count: number;
  keys: string[];
  clear: () => void;
}

export interface CocoaTableColumnPrefs {
  /** Column keys in display order (unknown keys dropped, new keys appended). */
  order: string[];
  /** Hidden column keys (never all of them). */
  hidden: string[];
}

export const VIRTUALIZE_THRESHOLD = 200;
export const VIRTUALIZE_CHUNK = 100;

/** Next sort for a header click (pure): asc → desc on the same key, asc on a new key. */
export function nextSort(current: CocoaTableSort | undefined, key: string): CocoaTableSort {
  const direction: CocoaTableSortDirection = current?.key === key && current.direction === "asc" ? "desc" : "asc";
  return { key, direction };
}

/** Rows rendered so far under progressive rendering (pure). */
export function visibleRowCount(total: number, pages: number, threshold = VIRTUALIZE_THRESHOLD, chunk = VIRTUALIZE_CHUNK): number {
  if (total <= threshold) return total;
  return Math.min(total, threshold + Math.max(0, pages - 1) * chunk);
}

/**
 * Overflow of the wrapper (pure). The head can only stick to a scroller it
 * lives in: without `maxHeight` the wrapper must NOT be a scroll container
 * (`clip` clips without scrolling, unlike `hidden`), so the page scroller
 * keeps the head; `overflowing` (table wider than the wrapper) trades the
 * sticky head for a horizontal scroller; `maxHeight` makes the wrapper the
 * scroller and the head sticks inside it.
 */
export function wrapOverflowStyle(input: { maxHeight?: number; overflowing: boolean }): CSSProperties {
  if (input.maxHeight !== undefined) return { overflow: "auto", maxHeight: input.maxHeight };
  if (input.overflowing) return { overflowX: "auto", overflowY: "hidden" };
  return { overflowX: "clip", overflowY: "visible" };
}

/** True when the table needs more width than its wrapper offers (pure; 0.5 px tolerance for subpixel layouts). */
export function isTableOverflowing(tableWidth: number, wrapWidth: number): boolean {
  return tableWidth > wrapWidth + 0.5;
}

const TIER_RANK: Record<CocoaViewportTier, number> = { phone: 0, tablet: 1, laptop: 2, desktop: 3 };

/** Whether a column is shown at a viewport tier (pure): `hideOnNarrow` hides it on phones, `showFrom` below that tier. */
export function isColumnVisible(column: Pick<CocoaTableColumn<unknown>, "hideOnNarrow" | "showFrom">, tier: CocoaViewportTier): boolean {
  if (column.hideOnNarrow && tier === "phone") return false;
  if (column.showFrom && TIER_RANK[tier] < TIER_RANK[column.showFrom]) return false;
  return true;
}

/**
 * Sizing of a column's cells (pure). `fit` shrinks the column to its content
 * on one line — a 1 px `width` in `table-layout: auto` resolves to the
 * min-content width, the trick the actions cell already uses — unless an
 * explicit `width` is given; `nowrap` defaults to true for `fit` and for
 * right-aligned (numeric) columns. Only the keys that apply are returned so
 * the caller can spread it under its own `whiteSpace`.
 */
export function columnSizingStyle(column: Pick<CocoaTableColumn<unknown>, "width" | "minWidth" | "fit" | "nowrap" | "align">): CSSProperties {
  const style: CSSProperties = {};
  const width = column.width ?? (column.fit ? 1 : undefined);
  if (width !== undefined) style.width = width;
  if (column.minWidth !== undefined) style.minWidth = column.minWidth;
  const nowrap = column.nowrap ?? (column.fit === true || column.align === "right");
  if (nowrap) style.whiteSpace = "nowrap";
  return style;
}

/** Cell padding for a density (pure); undefined → inherited page density or comfortable. */
export function densityRowPadding(density: CocoaTableDensity | undefined): string {
  if (density === "compact") return "var(--cocoa-space-1) 10px";
  if (density === "comfortable") return "var(--cocoa-space-2) var(--cocoa-space-3)";
  return "var(--cocoa-density-cell-padding-y, var(--cocoa-space-2)) var(--cocoa-density-cell-padding-x, var(--cocoa-space-3))";
}

export function resolveRowKey<Row>(row: Row, rowKey: string | ((row: Row) => string) | undefined, idx: number): string {
  if (typeof rowKey === "function") return rowKey(row);
  if (typeof rowKey === "string") {
    const value = (row as Record<string, unknown>)[rowKey];
    return value !== undefined && value !== null ? String(value) : String(idx);
  }
  return String(idx);
}

function getCellValue<Row>(row: Row, key: string): unknown {
  return (row as Record<string, unknown>)[key];
}

export function defaultRender<Row>(row: Row, key: string): ReactNode {
  const v = getCellValue(row, key);
  if (v === null || v === undefined) return "—";
  if (typeof v === "string" || typeof v === "number") return v;
  if (typeof v === "boolean") return v ? "Sí" : "No";
  return null;
}

/** Native tooltip of a truncated cell (pure): the full text when the cell renders a string or a number, nothing otherwise. */
export function truncatedCellTitle(content: ReactNode): string | undefined {
  return typeof content === "string" || typeof content === "number" ? String(content) : undefined;
}

// ---------------------------------------------------------------- U4 · column prefs (pure)

export const COLUMN_PREFS_STORAGE_PREFIX = "hotelos-table-columns:";

/** localStorage key of a table's column prefs (pure). */
export function columnPrefsStorageKey(prefsKey: string): string {
  return `${COLUMN_PREFS_STORAGE_PREFIX}${prefsKey}`;
}

/**
 * Prefs reconciled with the real columns (pure): unknown keys dropped, new
 * keys appended in their declared order, duplicates removed, and never every
 * column hidden (the first in order comes back).
 */
export function normalizeColumnPrefs(prefs: Partial<CocoaTableColumnPrefs> | null | undefined, keys: ReadonlyArray<string>): CocoaTableColumnPrefs {
  const known = new Set(keys);
  const order = (prefs?.order ?? []).filter((key, index, all) => known.has(key) && all.indexOf(key) === index);
  for (const key of keys) if (!order.includes(key)) order.push(key);
  let hidden = (prefs?.hidden ?? []).filter((key, index, all) => known.has(key) && all.indexOf(key) === index);
  if (keys.length > 0 && hidden.length >= keys.length) hidden = hidden.filter((key) => key !== order[0]);
  return { order, hidden };
}

/** Columns in the user's order without the hidden ones (pure); no prefs → the declared columns. */
export function applyColumnPrefs<Row>(columns: CocoaTableColumn<Row>[], prefs: Partial<CocoaTableColumnPrefs> | null | undefined): CocoaTableColumn<Row>[] {
  if (!prefs) return columns;
  const byKey = new Map(columns.map((column) => [column.key, column]));
  const normalized = normalizeColumnPrefs(prefs, columns.map((column) => column.key));
  return normalized.order.filter((key) => !normalized.hidden.includes(key)).flatMap((key) => {
    const column = byKey.get(key);
    return column ? [column] : [];
  });
}

/** Order with `key` moved one step up (−1) or down (+1) (pure); out of range → unchanged copy. */
export function moveColumn(order: ReadonlyArray<string>, key: string, direction: -1 | 1): string[] {
  const next = [...order];
  const index = next.indexOf(key);
  const target = index + direction;
  if (index < 0 || target < 0 || target >= next.length) return next;
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}

/** Prefs with `key` shown ↔ hidden (pure); the last visible column cannot be hidden. */
export function toggleColumnHidden(prefs: CocoaTableColumnPrefs, key: string, keys: ReadonlyArray<string>): CocoaTableColumnPrefs {
  const hidden = prefs.hidden.includes(key) ? prefs.hidden.filter((candidate) => candidate !== key) : [...prefs.hidden, key];
  return normalizeColumnPrefs({ order: prefs.order, hidden }, keys);
}

/** Prefs read from storage (pure over the storage API): null when absent, corrupt or unreadable. */
export function readColumnPrefs(storage: Pick<Storage, "getItem"> | null | undefined, prefsKey: string, keys: ReadonlyArray<string>): CocoaTableColumnPrefs | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(columnPrefsStorageKey(prefsKey));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<Record<keyof CocoaTableColumnPrefs, unknown>> | null;
    if (!parsed || typeof parsed !== "object") return null;
    const strings = (value: unknown) => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []);
    return normalizeColumnPrefs({ order: strings(parsed.order), hidden: strings(parsed.hidden) }, keys);
  } catch {
    return null;
  }
}

/** Prefs written to storage (null removes them); a full or blocked storage keeps the session's in-memory prefs. */
export function writeColumnPrefs(storage: Pick<Storage, "setItem" | "removeItem"> | null | undefined, prefsKey: string, prefs: CocoaTableColumnPrefs | null): void {
  if (!storage) return;
  try {
    if (prefs) storage.setItem(columnPrefsStorageKey(prefsKey), JSON.stringify(prefs));
    else storage.removeItem(columnPrefsStorageKey(prefsKey));
  } catch {
    // Quota exceeded / private mode: nothing to do, the prefs live in React state until reload.
  }
}

function safeLocalStorage(): Storage | null {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- U4 · multiple selection (pure)

/** Selection with `key` added or removed (pure). */
export function toggleSelection(selected: ReadonlyArray<string>, key: string): string[] {
  return selected.includes(key) ? selected.filter((candidate) => candidate !== key) : [...selected, key];
}

/**
 * Shift+clic (pure): every rendered row between the anchor (the last row
 * toggled) and the target joins the selection; without an anchor the target
 * simply toggles.
 */
export function rangeSelection(input: { selected: ReadonlyArray<string>; keys: ReadonlyArray<string>; anchorIndex: number | null; targetIndex: number }): string[] {
  const { selected, keys, anchorIndex, targetIndex } = input;
  if (targetIndex < 0 || targetIndex >= keys.length) return [...selected];
  if (anchorIndex === null || anchorIndex < 0 || anchorIndex >= keys.length) return toggleSelection(selected, keys[targetIndex]);
  const [from, to] = anchorIndex <= targetIndex ? [anchorIndex, targetIndex] : [targetIndex, anchorIndex];
  const next = new Set(selected);
  for (let index = from; index <= to; index += 1) next.add(keys[index]);
  return [...next];
}

/** Selection plus every rendered row (pure): Ctrl/⌘A and the header checkbox. */
export function selectAllRows(selected: ReadonlyArray<string>, keys: ReadonlyArray<string>): string[] {
  return [...new Set([...selected, ...keys])];
}

/** Selection without the rendered rows (pure): the header checkbox when everything shown is selected. */
export function deselectRows(selected: ReadonlyArray<string>, keys: ReadonlyArray<string>): string[] {
  const shown = new Set(keys);
  return selected.filter((key) => !shown.has(key));
}

/** Ctrl/⌘A (pure): never with Shift or Alt. */
export function isSelectAllShortcut(event: { key: string; metaKey: boolean; ctrlKey: boolean; shiftKey?: boolean; altKey?: boolean }): boolean {
  return (event.key === "a" || event.key === "A") && (event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey;
}

/** State of the header checkbox (pure): none · some (indeterminate) · all, over the rendered rows. */
export function headerCheckboxState(selectedShown: number, shown: number): "none" | "some" | "all" {
  if (shown === 0 || selectedShown === 0) return "none";
  return selectedShown >= shown ? "all" : "some";
}

/** «1 fila seleccionada» / «N filas seleccionadas» (pure). */
export function selectionStatusLabel(count: number): string {
  return count === 1 ? "1 fila seleccionada" : `${count} filas seleccionadas`;
}

/** Text-editing targets keep their own Ctrl/⌘A (pure; checkboxes are not text). */
function ownsSelectAll(target: unknown): boolean {
  const node = target as { tagName?: string; type?: string; isContentEditable?: boolean } | null;
  if (!node || typeof node !== "object") return false;
  if (node.isContentEditable) return true;
  const tag = (node.tagName ?? "").toUpperCase();
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  return tag === "INPUT" && node.type !== "checkbox" && node.type !== "radio";
}

const noop = () => undefined;

function ColumnsMenu<Row>({ columns, prefs, onChange }: { columns: CocoaTableColumn<Row>[]; prefs: CocoaTableColumnPrefs; onChange: (next: CocoaTableColumnPrefs | null) => void }) {
  const keys = columns.map((column) => column.key);
  const byKey = new Map(columns.map((column) => [column.key, column]));
  return (
    <div className="c22-table__columns" data-cocoa="table-columns">
      <ul className="c22-table__columns-list">
        {prefs.order.map((key, index) => {
          const column = byKey.get(key);
          if (!column) return null;
          const label = column.label || key;
          const hidden = prefs.hidden.includes(key);
          return (
            <li key={key} className="c22-table__columns-item">
              <label className="c22-table__columns-toggle">
                <input type="checkbox" className="c22-table__check-input" checked={!hidden} onChange={() => onChange(toggleColumnHidden(prefs, key, keys))} />
                <span>{label}</span>
              </label>
              <span className="c22-table__columns-move">
                <CocoaButton variant="plain" tone="neutral" size="small" aria-label={`Subir ${label}`} disabled={index === 0} onClick={() => onChange(normalizeColumnPrefs({ ...prefs, order: moveColumn(prefs.order, key, -1) }, keys))}>
                  ↑
                </CocoaButton>
                <CocoaButton variant="plain" tone="neutral" size="small" aria-label={`Bajar ${label}`} disabled={index === prefs.order.length - 1} onClick={() => onChange(normalizeColumnPrefs({ ...prefs, order: moveColumn(prefs.order, key, 1) }, keys))}>
                  ↓
                </CocoaButton>
              </span>
            </li>
          );
        })}
      </ul>
      <div className="c22-table__columns-foot">
        <CocoaButton variant="plain" tone="neutral" size="small" onClick={() => onChange(null)}>
          Restablecer
        </CocoaButton>
      </div>
    </div>
  );
}

/** Rendered content of a column, wrapped in the truncation cap when the column asks for it (`truncate`). */
function cellContent<Row>(row: Row, col: CocoaTableColumn<Row>): ReactNode {
  const content = col.render ? col.render(row) : defaultRender(row, col.key);
  if (col.truncate === undefined) return content;
  // `vertical-align: bottom`: an inline-block with `overflow: hidden` moves its
  // baseline to its bottom edge, which would lift the value above the sibling text.
  return (
    <span className="cocoa-truncate c22-table__truncate" style={{ display: "inline-block", maxWidth: col.truncate, verticalAlign: "bottom" }} title={truncatedCellTitle(content)}>
      {content}
    </span>
  );
}

function SortIcon({ state }: { state: "asc" | "desc" | "none" }) {
  if (state === "none") return null;
  return (
    <svg width="8" height="8" viewBox="0 0 8 8" style={{ marginLeft: 4, transform: `rotate(${state === "desc" ? 180 : 0}deg)`, transition: "transform var(--cocoa-duration-fast) var(--cocoa-ease-out)", flexShrink: 0 }} aria-hidden="true">
      <path d="M4 1.5 L7 6 L1 6 Z" fill="currentColor" />
    </svg>
  );
}

const srOnly: CSSProperties = { position: "absolute", width: 1, height: 1, padding: 0, margin: -1, overflow: "hidden", clip: "rect(0 0 0 0)", whiteSpace: "nowrap", border: 0 };

const numericCell: CSSProperties = { fontVariantNumeric: "tabular-nums lining-nums", fontFeatureSettings: "var(--cocoa-font-numeric-tabular)" };

export function CocoaTable<Row>({
  columns,
  rows,
  sortBy,
  onSort,
  rowKey,
  selectedKey,
  onSelect,
  selectable,
  selectedKeys,
  onSelectionChange,
  batchBar,
  emptyState,
  loading = false,
  keepDataWhileLoading = false,
  density,
  stickyFirstColumn = false,
  rowActions,
  rowActionsVisible = "hover",
  rowTone,
  rowTitle,
  footer,
  virtualize = false,
  caption,
  "aria-label": ariaLabel,
  maxHeight,
  columnsPrefsKey,
  className,
  style
}: CocoaTableProps<Row>) {
  const [pages, setPages] = useState(1);
  const [overflowing, setOverflowing] = useState(false);
  const sentinelRef = useRef<HTMLTableRowElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const tableRef = useRef<HTMLTableElement | null>(null);
  const tier = useViewportTier();
  const isNarrow = tier === "phone";
  const isClickable = typeof onSelect === "function";
  const hasSelection = selectedKey !== undefined;
  const cellPadding = densityRowPadding(density);

  // U4 · column prefs («Columnas ▾»): read once from localStorage, written on every change.
  const columnKeys = columns.map((column) => column.key);
  const [prefs, setPrefsState] = useState<CocoaTableColumnPrefs | null>(() => (columnsPrefsKey ? readColumnPrefs(safeLocalStorage(), columnsPrefsKey, columnKeys) : null));
  const [columnsOpen, setColumnsOpen] = useState(false);
  const [columnsAnchor, setColumnsAnchor] = useState<HTMLElement | null>(null);
  const setPrefs = (next: CocoaTableColumnPrefs | null) => {
    setPrefsState(next);
    if (columnsPrefsKey) writeColumnPrefs(safeLocalStorage(), columnsPrefsKey, next);
  };
  const effectiveColumns = columnsPrefsKey ? applyColumnPrefs(columns, prefs) : columns;
  const visibleColumns = effectiveColumns.filter((col) => isColumnVisible(col, tier));

  // U4 · multiple selection and «keep the rows while loading».
  const hasMulti = selectable === "multiple";
  const selectedList: ReadonlyArray<string> = selectedKeys ?? [];
  const selectedSet = new Set(selectedList);
  const anchorIndex = useRef<number | null>(null);
  const changeSelection = (next: string[]) => onSelectionChange?.(next);
  const keepRows = loading && keepDataWhileLoading && rows.length > 0;

  // Progressive rendering: reset when the data changes, grow when the sentinel shows.
  useEffect(() => {
    setPages(1);
  }, [rows]);

  const shownCount = virtualize ? visibleRowCount(rows.length, pages) : rows.length;
  const hasMore = shownCount < rows.length;

  // Wide table? Measure wrapper and table (ResizeObserver) so the wrapper
  // becomes a horizontal scroller only when it has to (see wrapOverflowStyle).
  useEffect(() => {
    if (maxHeight !== undefined || loading || isNarrow || typeof ResizeObserver === "undefined") return undefined;
    const wrap = wrapRef.current;
    const table = tableRef.current;
    if (!wrap || !table) return undefined;
    const measure = () => setOverflowing(isTableOverflowing(table.offsetWidth, wrap.clientWidth));
    const observer = new ResizeObserver(measure);
    observer.observe(wrap);
    observer.observe(table);
    measure();
    return () => observer.disconnect();
  }, [maxHeight, loading, isNarrow, rows.length, visibleColumns.length]);

  useEffect(() => {
    if (!virtualize || !hasMore || typeof IntersectionObserver === "undefined") return undefined;
    const element = sentinelRef.current;
    if (!element) return undefined;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) setPages((p) => p + 1);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [virtualize, hasMore, shownCount]);

  if (loading && !keepRows) {
    return (
      <div role="status" aria-busy="true" aria-label="Cargando…" style={{ display: "flex", flexDirection: "column", gap: "var(--cocoa-space-2)", padding: "var(--cocoa-space-2) 0" }} data-cocoa="table-loading">
        {Array.from({ length: 5 }, (_, index) => (
          <CocoaSkeleton key={index} variant="row" height={density === "compact" ? 28 : 36} />
        ))}
      </div>
    );
  }

  const shownRows = rows.slice(0, shownCount);
  const footerCells: Record<string, ReactNode> | null =
    footer === true ? Object.fromEntries(columns.map((col) => [col.key, col.footer])) : footer && typeof footer === "object" ? footer : null;

  // U4 · selection over the RENDERED rows (the same keys the rows carry).
  const shownKeys = shownRows.map((row, idx) => resolveRowKey(row, rowKey, idx));
  const selectedShown = shownKeys.filter((key) => selectedSet.has(key)).length;
  const headerState = headerCheckboxState(selectedShown, shownKeys.length);
  const handleCheckClick = (event: ReactMouseEvent<HTMLInputElement>, index: number, key: string) => {
    event.stopPropagation();
    const next = event.shiftKey ? rangeSelection({ selected: selectedList, keys: shownKeys, anchorIndex: anchorIndex.current, targetIndex: index }) : toggleSelection(selectedList, key);
    anchorIndex.current = index;
    changeSelection(next);
  };
  const handleHeaderCheck = () => {
    anchorIndex.current = null;
    changeSelection(headerState === "all" ? deselectRows(selectedList, shownKeys) : selectAllRows(selectedList, shownKeys));
  };
  const handleTableKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (!hasMulti || !isSelectAllShortcut(event) || ownsSelectAll(event.target)) return;
    event.preventDefault();
    changeSelection(selectAllRows(selectedList, shownKeys));
  };
  const rowCheckbox = (index: number, key: string) => (
    <input type="checkbox" className="c22-table__check-input" aria-label={`Seleccionar fila ${index + 1}`} checked={selectedSet.has(key)} onClick={(event) => handleCheckClick(event, index, key)} onChange={noop} />
  );
  const selection: CocoaTableSelection = { count: selectedList.length, keys: [...selectedList], clear: () => changeSelection([]) };
  const batchBarNode =
    hasMulti && selection.count > 0 ? (
      <CocoaActionBar className="c22-table__batch" aria-label="Acciones sobre la selección" status={selectionStatusLabel(selection.count)} extra={batchBar?.(selection)} secondary={{ label: "Quitar selección", onClick: selection.clear }} publishToastOffset />
    ) : null;
  // `aria-busy` on the wrapper says it; the veil itself is decorative.
  const busyOverlay = keepRows ? <div className="c22-table__busy" aria-hidden="true" data-cocoa="table-busy" /> : null;
  const toolsRow = columnsPrefsKey ? (
    <div className="c22-table__tools" data-cocoa="table-tools">
      <CocoaButton ref={setColumnsAnchor} variant="bordered" tone="neutral" size="small" aria-haspopup="dialog" aria-expanded={columnsOpen} onClick={() => setColumnsOpen((open) => !open)}>
        Columnas
      </CocoaButton>
      <CocoaPopover open={columnsOpen} anchorEl={columnsAnchor} placement="bottom" onClose={() => setColumnsOpen(false)} role="dialog" aria-label="Columnas de la tabla">
        <ColumnsMenu columns={columns} prefs={normalizeColumnPrefs(prefs, columnKeys)} onChange={setPrefs} />
      </CocoaPopover>
    </div>
  ) : null;

  // ── Phone: stacked label/value cards ──────────────────────────────────────
  if (isNarrow && rows.length > 0) {
    return (
      <>
      {toolsRow}
      <div className={["c22-table-cards", "cocoa-table", className].filter(Boolean).join(" ")} style={{ position: "relative", display: "flex", flexDirection: "column", gap: "var(--cocoa-space-2)", fontFamily: "var(--cocoa-font)", ...style }} data-cocoa="table-cards" data-layout="cards" aria-label={ariaLabel ?? caption} aria-busy={keepRows || undefined} aria-multiselectable={hasMulti || undefined} onKeyDown={hasMulti ? handleTableKeyDown : undefined}>
        {shownRows.map((row, idx) => {
          const key = resolveRowKey(row, rowKey, idx);
          const isSelected = hasSelection && selectedKey === key;
          const tone = rowTone?.(row);
          const cardStyle: CSSProperties = {
            display: "flex",
            flexDirection: "column",
            gap: 6,
            padding: "var(--cocoa-space-3) 14px",
            borderRadius: "var(--cocoa-radius-lg)",
            border: "1px solid var(--cocoa-separator)",
            background: isSelected ? "color-mix(in srgb, var(--cocoa-accent) 8%, transparent)" : tone ? toneBg(tone) : "var(--cocoa-background-content)",
            boxShadow: isSelected ? "inset 3px 0 0 var(--cocoa-accent), var(--cocoa-shadow-card)" : "var(--cocoa-shadow-control)",
            cursor: isClickable ? "pointer" : "default"
          };
          return (
            <div
              key={key}
              className={isClickable ? "cocoa-focus-ring" : undefined}
              style={cardStyle}
              onClick={isClickable ? () => onSelect?.(row) : undefined}
              onKeyDown={
                isClickable
                  ? (event: ReactKeyboardEvent<HTMLDivElement>) => {
                      if (event.target !== event.currentTarget) return;
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        onSelect?.(row);
                      }
                    }
                  : undefined
              }
              role={isClickable ? "button" : undefined}
              tabIndex={isClickable ? 0 : undefined}
              aria-pressed={isClickable ? isSelected : undefined}
              title={rowTitle?.(row)}
              data-tone={tone}
            >
              {hasMulti ? (
                <label className="c22-table__check c22-table__check--card" onClick={(event) => event.stopPropagation()}>
                  {rowCheckbox(idx, key)}
                  <span>Seleccionar</span>
                </label>
              ) : null}
              {visibleColumns.map((col) => {
                const content = cellContent(row, col);
                return (
                  <div key={col.key} style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: "var(--cocoa-space-3)" }}>
                    {col.label ? (
                      <span style={{ fontSize: "var(--cocoa-fs-caption)", textTransform: "uppercase", letterSpacing: "var(--cocoa-tracking-wide)", color: "var(--cocoa-label-secondary)", flexShrink: 0 }}>{col.label}</span>
                    ) : null}
                    <span style={{ fontSize: "var(--cocoa-fs-body)", color: "var(--cocoa-label)", textAlign: "right", marginLeft: "auto", ...numericCell }}>{content}</span>
                  </div>
                );
              })}
              {rowActions ? (
                <div className="c22-table__actions" style={{ display: "flex", justifyContent: "flex-end", gap: "var(--cocoa-space-2)", marginTop: "var(--cocoa-space-1)", opacity: 1 }}>
                  {rowActions(row)}
                </div>
              ) : null}
            </div>
          );
        })}
        {hasMore ? (
          <div style={{ display: "flex", justifyContent: "center", padding: "var(--cocoa-space-2) 0" }}>
            <CocoaButton variant="bordered" tone="neutral" size="small" onClick={() => setPages((p) => p + 1)}>
              Mostrar más ({rows.length - shownCount})
            </CocoaButton>
          </div>
        ) : null}
        {busyOverlay}
      </div>
      {batchBarNode}
      </>
    );
  }

  // The sticky cell's background is stylesheet-owned per section (content in
  // the body, sidebar in the head, inverse surface in the foot:
  // `.c22-table[data-sticky-first-column="true"] …:first-child`). An inline
  // `background: inherit` used to win over those rules and resolved to the
  // row's (absent) background, so the sticky «Total» cell painted transparent
  // over the page (qa#3).
  const stickyFirst = (index: number, extra: CSSProperties = {}): CSSProperties =>
    stickyFirstColumn && index === 0 ? { position: "sticky", left: 0, zIndex: 1, boxShadow: "1px 0 0 var(--cocoa-separator)", ...extra } : extra;

  const colSpanAll = visibleColumns.length + (rowActions ? 1 : 0) + (hasMulti ? 1 : 0);

  return (
    <>
    {toolsRow}
    <div
      ref={wrapRef}
      className={["c22-table-wrap", "cocoa-table-wrap", className].filter(Boolean).join(" ")}
      style={{ position: "relative", ...wrapOverflowStyle({ maxHeight, overflowing }), WebkitOverflowScrolling: "touch", minWidth: 0, ...style }}
      data-cocoa="table-wrap"
      data-cocoa-density={density}
      data-overflowing={overflowing ? "true" : undefined}
      aria-busy={keepRows || undefined}
    >
      <table
        ref={tableRef}
        className="c22-table cocoa-table"
        aria-label={ariaLabel}
        style={{ width: "100%", borderCollapse: "separate", borderSpacing: 0, fontFamily: "var(--cocoa-font)", fontSize: "var(--cocoa-fs-body)", color: "var(--cocoa-label)", background: "var(--cocoa-background-content)" }}
        data-cocoa="table"
        data-zebra="true"
        data-density={density}
        data-sticky-first-column={stickyFirstColumn ? "true" : undefined}
        data-actions={rowActionsVisible === "always" ? "always" : undefined}
        aria-multiselectable={hasMulti || undefined}
        onKeyDown={hasMulti ? handleTableKeyDown : undefined}
      >
        {caption ? <caption style={srOnly}>{caption}</caption> : null}
        <thead style={{ position: "sticky", top: 0, background: "var(--cocoa-background-sidebar)", zIndex: 2, boxShadow: "var(--cocoa-shadow-sticky)" }}>
          <tr style={{ background: "var(--cocoa-background-sidebar)" }}>
            {hasMulti ? (
              <th scope="col" className="c22-table__check-cell" data-cocoa="table-check">
                <label className="c22-table__check">
                  <input
                    type="checkbox"
                    className="c22-table__check-input"
                    aria-label="Seleccionar todas las filas visibles"
                    checked={headerState === "all"}
                    ref={(element) => {
                      if (element) element.indeterminate = headerState === "some";
                    }}
                    onChange={handleHeaderCheck}
                  />
                </label>
              </th>
            ) : null}
            {visibleColumns.map((col, index) => {
              const align = col.align ?? "left";
              const isSorted = sortBy?.key === col.key;
              const sortState: "asc" | "desc" | "none" = isSorted ? sortBy.direction : "none";
              const thStyle: CSSProperties = stickyFirst(index, {
                padding: cellPadding,
                textAlign: align,
                fontWeight: "var(--cocoa-fw-semibold)" as CSSProperties["fontWeight"],
                fontSize: "var(--cocoa-fs-caption)",
                textTransform: "uppercase",
                letterSpacing: "var(--cocoa-tracking-wide)",
                color: "var(--cocoa-label-secondary)",
                borderBottom: "1px solid var(--cocoa-separator)",
                ...columnSizingStyle(col),
                whiteSpace: "nowrap",
                userSelect: "none",
                zIndex: stickyFirstColumn && index === 0 ? 3 : undefined
              });
              const inner: CSSProperties = { display: "inline-flex", alignItems: "center", justifyContent: align === "right" ? "flex-end" : align === "center" ? "center" : "flex-start" };
              return (
                <th key={col.key} style={thStyle} scope="col" data-align={align} data-fit={col.fit ? "true" : undefined} aria-sort={isSorted ? (sortBy.direction === "asc" ? "ascending" : "descending") : col.sortable ? "none" : undefined}>
                  {col.sortable && onSort ? (
                    <button
                      type="button"
                      className="cocoa-focus-ring"
                      onClick={() => onSort(nextSort(sortBy, col.key))}
                      style={{ ...inner, background: "transparent", border: 0, padding: 0, margin: 0, font: "inherit", color: "inherit", letterSpacing: "inherit", textTransform: "inherit", cursor: "pointer", borderRadius: "var(--cocoa-radius-sm)" }}
                    >
                      <span>{col.label}</span>
                      <SortIcon state={sortState} />
                    </button>
                  ) : (
                    <span style={inner}>{col.label}</span>
                  )}
                </th>
              );
            })}
            {rowActions ? (
              <th scope="col" style={{ padding: cellPadding, borderBottom: "1px solid var(--cocoa-separator)", width: 1 }}>
                <span style={srOnly}>Acciones</span>
              </th>
            ) : null}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={colSpanAll} className="c22-table__empty" data-empty="true" style={{ padding: "var(--cocoa-space-6)", textAlign: "center", color: "var(--cocoa-label-secondary)", fontSize: "var(--cocoa-fs-body)", borderBottom: "1px solid var(--cocoa-separator)" }}>
                {emptyState ?? "Sin datos"}
              </td>
            </tr>
          ) : (
            shownRows.map((row, idx) => {
              const key = resolveRowKey(row, rowKey, idx);
              const isSelected = hasSelection && selectedKey === key;

              // Zebra / hover / selection: `.c22-table[data-zebra] tr:nth-child(even) td`,
              // `tr:hover td` and `tr[aria-selected="true"] td` in styles/cocoa-22.css.
              return (
                <tr
                  key={key}
                  className={isClickable ? "cocoa-focus-ring" : undefined}
                  style={{ color: "var(--cocoa-label)", cursor: isClickable ? "pointer" : "default" }}
                  onClick={isClickable ? () => onSelect?.(row) : undefined}
                  onKeyDown={
                    isClickable
                      ? (event: ReactKeyboardEvent<HTMLTableRowElement>) => {
                          if (event.target !== event.currentTarget) return;
                          if (event.key === "Enter" || event.key === " ") {
                            event.preventDefault();
                            onSelect?.(row);
                          }
                        }
                      : undefined
                  }
                  tabIndex={isClickable ? 0 : undefined}
                  aria-selected={hasMulti ? selectedSet.has(key) : hasSelection ? isSelected : undefined}
                  data-interactive={isClickable ? "true" : undefined}
                  data-tone={rowTone?.(row)}
                  title={rowTitle?.(row)}
                >
                  {hasMulti ? (
                    <td className="c22-table__check-cell" data-cocoa="table-check" onClick={(event) => event.stopPropagation()}>
                      <label className="c22-table__check">{rowCheckbox(idx, key)}</label>
                    </td>
                  ) : null}
                  {visibleColumns.map((col, index) => {
                    const align = col.align ?? "left";
                    const tdStyle: CSSProperties = stickyFirst(index, {
                      padding: cellPadding,
                      borderBottom: "1px solid var(--cocoa-separator)",
                      textAlign: align,
                      verticalAlign: "middle",
                      fontSize: "var(--cocoa-fs-body)",
                      ...columnSizingStyle(col),
                      color: "inherit",
                      ...(align === "right" ? numericCell : {})
                    });
                    return (
                      <td key={col.key} style={tdStyle} data-align={align} data-fit={col.fit ? "true" : undefined}>
                        {cellContent(row, col)}
                      </td>
                    );
                  })}
                  {rowActions ? (
                    <td style={{ padding: cellPadding, borderBottom: "1px solid var(--cocoa-separator)", textAlign: "right", whiteSpace: "nowrap" }} onClick={(event) => event.stopPropagation()}>
                      <span className="c22-table__actions" style={{ display: "inline-flex", gap: "var(--cocoa-space-1)", alignItems: "center" }}>
                        {rowActions(row)}
                      </span>
                    </td>
                  ) : null}
                </tr>
              );
            })
          )}
          {hasMore ? (
            <tr ref={sentinelRef} data-cocoa="table-sentinel">
              <td colSpan={colSpanAll} style={{ padding: "var(--cocoa-space-2)", textAlign: "center", borderBottom: "1px solid var(--cocoa-separator)" }}>
                <CocoaButton variant="plain" tone="accent" size="small" onClick={() => setPages((p) => p + 1)}>
                  Mostrar más ({rows.length - shownCount})
                </CocoaButton>
              </td>
            </tr>
          ) : null}
        </tbody>
        {footerCells ? (
          <tfoot>
            {/* Totals on the inverse surface: colours and weight come from `.c22-table tfoot td` (stylesheet). */}
            <tr>
              {hasMulti ? <td className="c22-table__check-cell" data-cocoa="table-check" /> : null}
              {visibleColumns.map((col, index) => {
                const align = col.align ?? "left";
                return (
                  <td key={col.key} data-align={align} data-fit={col.fit ? "true" : undefined} style={stickyFirst(index, { padding: cellPadding, textAlign: align, ...columnSizingStyle(col), ...(align === "right" ? numericCell : {}) })}>
                    {footerCells[col.key] ?? null}
                  </td>
                );
              })}
              {rowActions ? <td style={{ padding: cellPadding }} /> : null}
            </tr>
          </tfoot>
        ) : null}
      </table>
      {busyOverlay}
    </div>
    {batchBarNode}
    </>
  );
}

export default CocoaTable;
