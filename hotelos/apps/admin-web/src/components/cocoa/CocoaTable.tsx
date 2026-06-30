// CocoaTable — Cocoa NSTableView styled data table.
//
// Mirrors AppKit NSTableView aesthetics:
//   - Sticky thead with sidebar background + uppercase caption labels.
//   - Sortable column headers with chevron indicator.
//   - Zebra-striped tbody (very subtle) with hover and selection states.
//   - Empty state row spanning all columns when rows are empty.
//   - LoadingBlock with shimmer when loading.
//
// Uses --cocoa-* design tokens for theme parity (light/dark).

import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { LoadingBlock } from "../States";

// Below this width a data table is unreadable; we render stacked label/value
// cards instead (the standard mobile pattern). Touch/phone only — desktop and
// tablet landscape keep the real table.
function useIsNarrow(breakpoint = 600): boolean {
  const query = `(max-width: ${breakpoint - 1}px)`;
  const get = (): boolean =>
    typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia(query).matches
      : false;
  const [narrow, setNarrow] = useState<boolean>(get);
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return undefined;
    }
    const mql = window.matchMedia(query);
    const handler = () => setNarrow(mql.matches);
    handler();
    mql.addEventListener?.("change", handler);
    return () => mql.removeEventListener?.("change", handler);
  }, [query]);
  return narrow;
}

export type CocoaTableSortDirection = "asc" | "desc";

export interface CocoaTableColumn<Row> {
  key: string;
  label: string;
  sortable?: boolean;
  align?: "left" | "right" | "center";
  width?: string;
  render?: (row: Row) => ReactNode;
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
}

function resolveRowKey<Row>(
  row: Row,
  rowKey: string | ((row: Row) => string) | undefined,
  idx: number
): string {
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

function defaultRender<Row>(row: Row, key: string): ReactNode {
  const v = getCellValue(row, key);
  if (v === null || v === undefined) return "—";
  if (typeof v === "string" || typeof v === "number") return v;
  if (typeof v === "boolean") return v ? "Si" : "No";
  return null;
}

interface SortIconProps {
  state: "asc" | "desc" | "none";
}

function SortIcon({ state }: SortIconProps) {
  if (state === "none") return null;
  const rotation = state === "desc" ? 180 : 0;
  return (
    <svg
      width="8"
      height="8"
      viewBox="0 0 8 8"
      style={{
        marginLeft: 4,
        transform: `rotate(${rotation}deg)`,
        transition: "transform var(--cocoa-duration-fast, 100ms) var(--cocoa-ease-out)",
        flexShrink: 0
      }}
      aria-hidden="true"
    >
      <path d="M4 1.5 L7 6 L1 6 Z" fill="currentColor" />
    </svg>
  );
}

export function CocoaTable<Row>({
  columns,
  rows,
  sortBy,
  onSort,
  rowKey,
  selectedKey,
  onSelect,
  emptyState,
  loading = false
}: CocoaTableProps<Row>) {
  const [hoverKey, setHoverKey] = useState<string | null>(null);
  const isNarrow = useIsNarrow();

  const tableStyle: CSSProperties = {
    width: "100%",
    borderCollapse: "collapse",
    fontFamily: "var(--cocoa-font)",
    fontSize: "var(--cocoa-fs-body)",
    color: "var(--cocoa-label)",
    background: "var(--cocoa-background-content)"
  };

  const theadStyle: CSSProperties = {
    position: "sticky",
    top: 0,
    background: "var(--cocoa-background-sidebar)",
    zIndex: 1,
    // Subtle downward shadow so the header floats over scrolled rows. A solid
    // fill + 1px line, NOT backdrop blur (blur would smear the figures passing
    // underneath and cost GPU on iPad — reviewers rejected it).
    boxShadow: "0 1px 0 var(--cocoa-separator), 0 2px 6px rgb(0 0 0 / 0.04)"
  };

  const handleSortClick = (col: CocoaTableColumn<Row>) => {
    if (!col.sortable || !onSort) return;
    const nextDirection: CocoaTableSortDirection =
      sortBy?.key === col.key && sortBy.direction === "asc" ? "desc" : "asc";
    onSort({ key: col.key, direction: nextDirection });
  };

  if (loading) {
    return <LoadingBlock label="Cargando…" />;
  }

  // ── Phone: stacked label/value cards instead of an unreadable wide table ──
  if (isNarrow && rows.length > 0) {
    const isClickable = typeof onSelect === "function";
    return (
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "var(--cocoa-space-2, 8px)",
          fontFamily: "var(--cocoa-font)"
        }}
      >
        {rows.map((row, idx) => {
          const key = resolveRowKey(row, rowKey, idx);
          const isSelected = selectedKey !== undefined && selectedKey === key;
          const cardStyle: CSSProperties = {
            display: "flex",
            flexDirection: "column",
            gap: 6,
            padding: "12px 14px",
            borderRadius: "var(--cocoa-radius-lg)",
            border: "1px solid var(--cocoa-separator)",
            background: isSelected
              ? "color-mix(in srgb, var(--cocoa-accent) 8%, transparent)"
              : "var(--cocoa-background-content)",
            boxShadow: isSelected
              ? "inset 3px 0 0 var(--cocoa-accent), var(--cocoa-shadow-card)"
              : "var(--cocoa-shadow-control)",
            cursor: isClickable ? "pointer" : "default"
          };
          return (
            <div
              key={key}
              style={cardStyle}
              onClick={isClickable ? () => onSelect?.(row) : undefined}
              role={isClickable ? "button" : undefined}
              tabIndex={isClickable ? 0 : undefined}
              aria-selected={isSelected || undefined}
            >
              {columns.map((col) => {
                const content = col.render
                  ? col.render(row)
                  : defaultRender(row, col.key);
                return (
                  <div
                    key={col.key}
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "baseline",
                      gap: 12
                    }}
                  >
                    {col.label ? (
                      <span
                        style={{
                          fontSize: "var(--cocoa-fs-caption)",
                          textTransform: "uppercase",
                          letterSpacing: "var(--cocoa-tracking-wide)",
                          color: "var(--cocoa-label-secondary)",
                          flexShrink: 0
                        }}
                      >
                        {col.label}
                      </span>
                    ) : null}
                    <span
                      style={{
                        fontSize: "var(--cocoa-fs-body)",
                        color: "var(--cocoa-label)",
                        textAlign: "right",
                        marginLeft: "auto",
                        fontVariantNumeric: "tabular-nums lining-nums"
                      }}
                    >
                      {content}
                    </span>
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
    );
  }

  return (
    <table style={tableStyle}>
      <thead style={theadStyle}>
        <tr>
          {columns.map((col) => {
            const align = col.align ?? "left";
            const isSorted = sortBy?.key === col.key;
            const sortState: "asc" | "desc" | "none" = isSorted
              ? sortBy.direction
              : "none";
            const thStyle: CSSProperties = {
              padding: "8px 12px",
              textAlign: align,
              fontWeight: 600,
              fontSize: "var(--cocoa-fs-caption)",
              textTransform: "uppercase",
              letterSpacing: "var(--cocoa-tracking-wide)",
              color: "var(--cocoa-label-secondary)",
              borderBottom: "1px solid var(--cocoa-separator)",
              whiteSpace: "nowrap",
              width: col.width,
              userSelect: "none",
              cursor: col.sortable ? "pointer" : "default"
            };
            const innerStyle: CSSProperties = {
              display: "inline-flex",
              alignItems: "center",
              justifyContent:
                align === "right"
                  ? "flex-end"
                  : align === "center"
                    ? "center"
                    : "flex-start",
              gap: 0
            };
            return (
              <th
                key={col.key}
                style={thStyle}
                onClick={col.sortable ? () => handleSortClick(col) : undefined}
                aria-sort={
                  isSorted
                    ? sortBy.direction === "asc"
                      ? "ascending"
                      : "descending"
                    : col.sortable
                      ? "none"
                      : undefined
                }
                scope="col"
              >
                <span style={innerStyle}>
                  <span>{col.label}</span>
                  <SortIcon state={sortState} />
                </span>
              </th>
            );
          })}
        </tr>
      </thead>
      <tbody>
        {rows.length === 0 ? (
          <tr>
            <td
              colSpan={columns.length}
              style={{
                padding: "var(--cocoa-space-6, 32px)",
                textAlign: "center",
                color: "var(--cocoa-label-secondary)",
                fontSize: "var(--cocoa-fs-body)",
                borderBottom: "1px solid var(--cocoa-separator)"
              }}
            >
              {emptyState ?? "Sin datos"}
            </td>
          </tr>
        ) : (
          rows.map((row, idx) => {
            const key = resolveRowKey(row, rowKey, idx);
            const isSelected = selectedKey !== undefined && selectedKey === key;
            const isHover = hoverKey === key;
            const isClickable = typeof onSelect === "function";
            const isEven = idx % 2 === 0;

            // Audit 2026-06 · #6: dark-safe zebra + hover. The literal black/blue
            // rgba() were invisible on #1E1E1E; these derive from theme tokens.
            let background = isEven
              ? "var(--cocoa-background-content)"
              : "color-mix(in srgb, var(--cocoa-label) 3%, transparent)";
            let color: string | undefined;
            let boxShadow: string | undefined;
            if (isHover && !isSelected) {
              background = "color-mix(in srgb, var(--cocoa-accent) 8%, transparent)";
            }
            if (isSelected) {
              // A 100% accent fill is too loud for a financial table. Use a 15%
              // wash + the normal dark label (keeps text contrast) and an inset
              // accent bar as a second, non-colour selection cue (WCAG 1.4.1).
              background = "color-mix(in srgb, var(--cocoa-accent) 15%, transparent)";
              color = "var(--cocoa-label)";
              boxShadow = "inset 3px 0 0 var(--cocoa-accent)";
            }

            const trStyle: CSSProperties = {
              background,
              color,
              boxShadow,
              cursor: isClickable ? "pointer" : "default",
              transition:
                "background var(--cocoa-duration-fast, 100ms) var(--cocoa-ease-out)"
            };

            return (
              <tr
                key={key}
                style={trStyle}
                onMouseEnter={() => setHoverKey(key)}
                onMouseLeave={() =>
                  setHoverKey((cur) => (cur === key ? null : cur))
                }
                onClick={isClickable ? () => onSelect?.(row) : undefined}
                aria-selected={isSelected || undefined}
              >
                {columns.map((col) => {
                  const align = col.align ?? "left";
                  const tdStyle: CSSProperties = {
                    padding: "8px 12px",
                    borderBottom: "1px solid var(--cocoa-separator)",
                    textAlign: align,
                    verticalAlign: "middle",
                    fontSize: "var(--cocoa-fs-body)",
                    width: col.width,
                    color: "inherit",
                    // Right-aligned columns are numeric (amounts, counts) → tabular
                    // + lining figures so digits line up column-wise.
                    ...(align === "right"
                      ? {
                          fontVariantNumeric: "tabular-nums lining-nums",
                          fontFeatureSettings: '"tnum" 1, "lnum" 1'
                        }
                      : {})
                  };
                  const content = col.render
                    ? col.render(row)
                    : defaultRender(row, col.key);
                  return (
                    <td key={col.key} style={tdStyle}>
                      {content}
                    </td>
                  );
                })}
              </tr>
            );
          })
        )}
      </tbody>
    </table>
  );
}

export default CocoaTable;
