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
//   < 600   stacked label/value cards (radius 12, hairline, control shadow)
//
// Density can also be inherited from `CocoaPage density` (the
// `data-cocoa-density` attribute resolves `--cocoa-density-cell-padding-*`
// in cocoa-tokens.css) when the prop is omitted.
//
// Hooks for the css lot: wrapper `c22-table-wrap`, table `c22-table` +
// data-zebra/density/sticky-first-column, cells `data-align`, rows
// `data-interactive`/`aria-selected`, actions `c22-table__actions` (shown on
// hover/focus, always on touch), empty `data-empty`, tfoot on the inverse
// surface (stylesheet-owned).

import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { CocoaButton } from "./CocoaButton";
import { CocoaSkeleton } from "./CocoaState";
import { toneBg, type CocoaTone } from "./cocoa-tones";
import { useIsNarrow } from "./cocoa-viewport";

export type CocoaTableSortDirection = "asc" | "desc";
export type CocoaTableDensity = "comfortable" | "compact";

export interface CocoaTableColumn<Row> {
  key: string;
  label: string;
  sortable?: boolean;
  align?: "left" | "right" | "center";
  width?: string;
  minWidth?: number;
  render?: (row: Row) => ReactNode;
  /** Cell of the totals row (`footer` prop must be true or an object). */
  footer?: ReactNode;
  /** Hide on phones (secondary columns). */
  hideOnNarrow?: boolean;
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
  emptyState?: ReactNode;
  loading?: boolean;
  density?: CocoaTableDensity;
  stickyFirstColumn?: boolean;
  /** Trailing actions cell per row (CocoaButton plain/small). */
  rowActions?: (row: Row) => ReactNode;
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
  className?: string;
  style?: CSSProperties;
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
  emptyState,
  loading = false,
  density,
  stickyFirstColumn = false,
  rowActions,
  rowTone,
  rowTitle,
  footer,
  virtualize = false,
  caption,
  "aria-label": ariaLabel,
  maxHeight,
  className,
  style
}: CocoaTableProps<Row>) {
  const [pages, setPages] = useState(1);
  const [overflowing, setOverflowing] = useState(false);
  const sentinelRef = useRef<HTMLTableRowElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const tableRef = useRef<HTMLTableElement | null>(null);
  const isNarrow = useIsNarrow();
  const isClickable = typeof onSelect === "function";
  const hasSelection = selectedKey !== undefined;
  const cellPadding = densityRowPadding(density);

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
  }, [maxHeight, loading, isNarrow, rows.length, columns.length]);

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

  if (loading) {
    return (
      <div role="status" aria-busy="true" aria-label="Cargando…" style={{ display: "flex", flexDirection: "column", gap: "var(--cocoa-space-2)", padding: "var(--cocoa-space-2) 0" }} data-cocoa="table-loading">
        {Array.from({ length: 5 }, (_, index) => (
          <CocoaSkeleton key={index} variant="row" height={density === "compact" ? 28 : 36} />
        ))}
      </div>
    );
  }

  const visibleColumns = isNarrow ? columns.filter((col) => !col.hideOnNarrow) : columns;
  const shownRows = rows.slice(0, shownCount);
  const footerCells: Record<string, ReactNode> | null =
    footer === true ? Object.fromEntries(columns.map((col) => [col.key, col.footer])) : footer && typeof footer === "object" ? footer : null;

  // ── Phone: stacked label/value cards ──────────────────────────────────────
  if (isNarrow && rows.length > 0) {
    return (
      <div className={["c22-table-cards", "cocoa-table", className].filter(Boolean).join(" ")} style={{ display: "flex", flexDirection: "column", gap: "var(--cocoa-space-2)", fontFamily: "var(--cocoa-font)", ...style }} data-cocoa="table-cards" data-layout="cards" aria-label={ariaLabel ?? caption}>
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
              {visibleColumns.map((col) => {
                const content = col.render ? col.render(row) : defaultRender(row, col.key);
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
      </div>
    );
  }

  const stickyFirst = (index: number, extra: CSSProperties = {}): CSSProperties =>
    stickyFirstColumn && index === 0 ? { position: "sticky", left: 0, zIndex: 1, background: "inherit", boxShadow: "1px 0 0 var(--cocoa-separator)", ...extra } : extra;

  const colSpanAll = visibleColumns.length + (rowActions ? 1 : 0);

  return (
    <div
      ref={wrapRef}
      className={["c22-table-wrap", "cocoa-table-wrap", className].filter(Boolean).join(" ")}
      style={{ position: "relative", ...wrapOverflowStyle({ maxHeight, overflowing }), WebkitOverflowScrolling: "touch", minWidth: 0, ...style }}
      data-cocoa="table-wrap"
      data-cocoa-density={density}
      data-overflowing={overflowing ? "true" : undefined}
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
      >
        {caption ? <caption style={srOnly}>{caption}</caption> : null}
        <thead style={{ position: "sticky", top: 0, background: "var(--cocoa-background-sidebar)", zIndex: 2, boxShadow: "var(--cocoa-shadow-sticky)" }}>
          <tr style={{ background: "var(--cocoa-background-sidebar)" }}>
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
                whiteSpace: "nowrap",
                width: col.width,
                minWidth: col.minWidth,
                userSelect: "none",
                zIndex: stickyFirstColumn && index === 0 ? 3 : undefined
              });
              const inner: CSSProperties = { display: "inline-flex", alignItems: "center", justifyContent: align === "right" ? "flex-end" : align === "center" ? "center" : "flex-start" };
              return (
                <th key={col.key} style={thStyle} scope="col" data-align={align} aria-sort={isSorted ? (sortBy.direction === "asc" ? "ascending" : "descending") : col.sortable ? "none" : undefined}>
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
                  aria-selected={hasSelection ? isSelected : undefined}
                  data-interactive={isClickable ? "true" : undefined}
                  data-tone={rowTone?.(row)}
                  title={rowTitle?.(row)}
                >
                  {visibleColumns.map((col, index) => {
                    const align = col.align ?? "left";
                    const tdStyle: CSSProperties = stickyFirst(index, {
                      padding: cellPadding,
                      borderBottom: "1px solid var(--cocoa-separator)",
                      textAlign: align,
                      verticalAlign: "middle",
                      fontSize: "var(--cocoa-fs-body)",
                      width: col.width,
                      minWidth: col.minWidth,
                      color: "inherit",
                      ...(align === "right" ? numericCell : {})
                    });
                    return (
                      <td key={col.key} style={tdStyle} data-align={align}>
                        {col.render ? col.render(row) : defaultRender(row, col.key)}
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
              {visibleColumns.map((col, index) => {
                const align = col.align ?? "left";
                return (
                  <td key={col.key} data-align={align} style={stickyFirst(index, { padding: cellPadding, textAlign: align, ...(align === "right" ? numericCell : {}) })}>
                    {footerCells[col.key] ?? null}
                  </td>
                );
              })}
              {rowActions ? <td style={{ padding: cellPadding }} /> : null}
            </tr>
          </tfoot>
        ) : null}
      </table>
    </div>
  );
}

export default CocoaTable;
