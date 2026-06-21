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

import { useState, type CSSProperties, type ReactNode } from "react";
import { LoadingBlock } from "../States";

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
    zIndex: 1
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
            if (isHover && !isSelected) {
              background = "color-mix(in srgb, var(--cocoa-accent) 8%, transparent)";
            }
            if (isSelected) {
              background = "var(--cocoa-background-selection)";
              color = "var(--cocoa-accent-contrast, #FFFFFF)";
            }

            const trStyle: CSSProperties = {
              background,
              color,
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
                    color: "inherit"
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
