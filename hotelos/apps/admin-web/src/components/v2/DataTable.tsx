import { useMemo, useState, type CSSProperties, type ReactNode } from "react";

export type SortDirection = "asc" | "desc";

export interface DataTableColumn<Row> {
  key: string;
  label: string;
  sortable?: boolean;
  align?: "left" | "right" | "center";
  width?: string;
  render?: (row: Row) => ReactNode;
}

export interface DataTableSort {
  key: string;
  direction: SortDirection;
}

export interface DataTableProps<Row> {
  columns: DataTableColumn<Row>[];
  rows: Row[];
  sortBy?: DataTableSort;
  onSort?: (sort: DataTableSort) => void;
  rowKey?: string;
  emptyState?: ReactNode;
  loading?: boolean;
  loadingRows?: number;
  density?: "comfortable" | "compact";
  onRowClick?: (row: Row) => void;
}

const CELL_PADDING_COMFORTABLE = "12px 16px";
const CELL_PADDING_COMPACT = "8px 12px";

function getRowKey<Row>(row: Row, rowKey: string | undefined, idx: number): string {
  if (!rowKey) return String(idx);
  const value = (row as Record<string, unknown>)[rowKey];
  return value !== undefined && value !== null ? String(value) : String(idx);
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
  const color =
    state === "none" ? "var(--ink-faint, #6f6e66)" : "var(--ink, #1a1a1a)";
  const rotation = state === "desc" ? 180 : 0;
  const opacity = state === "none" ? 0.5 : 1;
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 10 10"
      style={{
        marginLeft: 4,
        transform: `rotate(${rotation}deg)`,
        transition: "transform var(--duration, 180ms) var(--ease)",
        opacity
      }}
      aria-hidden="true"
    >
      <path d="M5 2 L8 7 L2 7 Z" fill={color} />
    </svg>
  );
}

export function DataTable<Row>({
  columns,
  rows,
  sortBy,
  onSort,
  rowKey,
  emptyState,
  loading = false,
  loadingRows = 5,
  density = "comfortable",
  onRowClick
}: DataTableProps<Row>) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  const cellPadding =
    density === "compact" ? CELL_PADDING_COMPACT : CELL_PADDING_COMFORTABLE;

  const wrapperStyle: CSSProperties = {
    background: "var(--surface-1, var(--surface, #ffffff))",
    border: "1px solid var(--line, #e8e5dd)",
    borderRadius: "var(--radius-lg, 16px)",
    overflow: "hidden",
    boxShadow: "var(--shadow-xs, 0 1px 2px rgba(26,26,26,0.04))"
  };

  const scrollStyle: CSSProperties = {
    overflowX: "auto",
    maxWidth: "100%"
  };

  const tableStyle: CSSProperties = {
    width: "100%",
    borderCollapse: "collapse",
    fontSize: "var(--fs-sm, 12px)"
  };

  const theadStyle: CSSProperties = {
    position: "sticky",
    top: 0,
    background: "var(--surface-sunken, #f1efe9)",
    zIndex: 1
  };

  const handleSortClick = (col: DataTableColumn<Row>) => {
    if (!col.sortable || !onSort) return;
    const nextDirection: SortDirection =
      sortBy?.key === col.key && sortBy.direction === "asc" ? "desc" : "asc";
    onSort({ key: col.key, direction: nextDirection });
  };

  const renderedRows = useMemo(() => {
    if (loading) {
      return Array.from({ length: loadingRows }).map((_, idx) => (
        <tr key={`skel-${idx}`}>
          {columns.map((col) => (
            <td
              key={col.key}
              style={{
                padding: cellPadding,
                borderTop: "1px solid var(--line-soft, #f1ede5)"
              }}
            >
              <div
                style={{
                  height: 14,
                  width: `${50 + ((idx * 7) % 40)}%`,
                  background: "var(--surface-sunken, #f1efe9)",
                  borderRadius: "var(--radius-sm, 8px)",
                  animation: "pulse 1.4s ease-in-out infinite"
                }}
              />
            </td>
          ))}
        </tr>
      ));
    }

    if (rows.length === 0) {
      return (
        <tr>
          <td
            colSpan={columns.length}
            style={{
              padding: "var(--space-8, 32px)",
              textAlign: "center",
              color: "var(--ink-muted, #6a6a6a)",
              fontSize: "var(--fs-sm, 12px)"
            }}
          >
            {emptyState ?? "No hay datos para mostrar"}
          </td>
        </tr>
      );
    }

    return rows.map((row, idx) => {
      const isHover = hoverIdx === idx;
      const isClickable = typeof onRowClick === "function";
      const trStyle: CSSProperties = {
        background: isHover
          ? "var(--surface-soft, #faf9f5)"
          : "var(--surface-1, var(--surface, #ffffff))",
        cursor: isClickable ? "pointer" : "default",
        transition: "background var(--duration, 180ms) var(--ease)"
      };
      return (
        <tr
          key={getRowKey(row, rowKey, idx)}
          style={trStyle}
          onMouseEnter={() => setHoverIdx(idx)}
          onMouseLeave={() => setHoverIdx((cur) => (cur === idx ? null : cur))}
          onClick={isClickable ? () => onRowClick?.(row) : undefined}
        >
          {columns.map((col) => {
            const align = col.align ?? "left";
            const tdStyle: CSSProperties = {
              padding: cellPadding,
              borderTop: "1px solid var(--line-soft, #f1ede5)",
              textAlign: align,
              color: "var(--ink, #1a1a1a)",
              verticalAlign: "middle",
              width: col.width
            };
            const content = col.render ? col.render(row) : defaultRender(row, col.key);
            return (
              <td key={col.key} style={tdStyle}>
                {content}
              </td>
            );
          })}
        </tr>
      );
    });
  }, [columns, rows, hoverIdx, loading, loadingRows, rowKey, emptyState, cellPadding, onRowClick]);

  return (
    <div style={wrapperStyle}>
      <div style={scrollStyle}>
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
                  padding: cellPadding,
                  textAlign: align,
                  fontWeight: 600,
                  fontSize: "var(--fs-xs, 11px)",
                  textTransform: "uppercase",
                  letterSpacing: "0.04em",
                  color: "var(--ink-soft, #4a4a4a)",
                  borderBottom: "1px solid var(--line, #e8e5dd)",
                  whiteSpace: "nowrap",
                  width: col.width,
                  userSelect: "none"
                };
                const labelStyle: CSSProperties = {
                  display: "inline-flex",
                  alignItems: "center",
                  background: "transparent",
                  border: "none",
                  font: "inherit",
                  textTransform: "inherit",
                  letterSpacing: "inherit",
                  color: "inherit",
                  padding: 0,
                  cursor: col.sortable ? "pointer" : "default"
                };
                return (
                  <th
                    key={col.key}
                    style={thStyle}
                    aria-sort={
                      isSorted
                        ? sortBy.direction === "asc"
                          ? "ascending"
                          : "descending"
                        : "none"
                    }
                  >
                    {col.sortable ? (
                      <button
                        type="button"
                        style={labelStyle}
                        onClick={() => handleSortClick(col)}
                      >
                        <span>{col.label}</span>
                        <SortIcon state={sortState} />
                      </button>
                    ) : (
                      <span>{col.label}</span>
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>{renderedRows}</tbody>
        </table>
      </div>
    </div>
  );
}

export default DataTable;
