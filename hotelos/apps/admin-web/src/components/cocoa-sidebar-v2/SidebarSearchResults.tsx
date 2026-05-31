// SidebarSearchResults
// Flat search results view for the v2 sidebar. When `query` is non-empty, the
// caller should render this component INSTEAD of the normal grouped sections.
// We perform a fuzzy substring match (case-insensitive) against item labels
// over the pre-flattened `allItems` list, then render each match with its
// icon, label, optional caption and originating group label. The matched
// substring inside the label is wrapped in <strong> for highlight.

import {
  useMemo,
  useState,
  type CSSProperties,
  type ReactNode
} from "react";
import type { SidebarItem } from "./CocoaSidebarV2";

// Augment the canonical `SidebarItem` with the originating group label so the
// flat list can show provenance, and tolerate an optional `caption` since
// callers may attach extra context (e.g. a short description) without needing
// to widen the shared `SidebarItem` type.
export type SidebarSearchItem = SidebarItem & {
  groupLabel: string;
  caption?: string;
};

export interface SidebarSearchResultsProps {
  query: string;
  allItems: SidebarSearchItem[];
  onSelect: (itemId: string) => void;
}

const containerStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 4,
  padding: "var(--cocoa-space-3)",
  boxSizing: "border-box",
  width: "100%"
};

const headerStyle: CSSProperties = {
  padding: "8px 8px 4px",
  fontSize: "var(--cocoa-fs-caption)",
  fontWeight: "var(--cocoa-fw-semibold)" as unknown as number,
  letterSpacing: "var(--cocoa-tracking-wide)",
  textTransform: "uppercase",
  color: "var(--cocoa-label-secondary)",
  userSelect: "none"
};

const listStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 1
};

const itemBaseStyle: CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  gap: 8,
  padding: "6px 8px",
  borderRadius: "var(--cocoa-radius-sm)",
  cursor: "pointer",
  userSelect: "none",
  background: "transparent",
  border: "none",
  width: "100%",
  textAlign: "left",
  color: "inherit",
  font: "inherit",
  fontSize: "var(--cocoa-fs-body)",
  transition:
    "background-color var(--cocoa-duration-fast) var(--cocoa-ease-out)",
  boxSizing: "border-box"
};

const itemIconStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: 16,
  height: 16,
  flexShrink: 0,
  color: "inherit",
  marginTop: 2
};

const itemBodyStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 1,
  flex: "1 1 auto",
  minWidth: 0
};

const itemLabelStyle: CSSProperties = {
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap"
};

const itemCaptionStyle: CSSProperties = {
  fontSize: "var(--cocoa-fs-caption)",
  color: "var(--cocoa-label-secondary)",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap"
};

const itemGroupStyle: CSSProperties = {
  fontSize: "var(--cocoa-fs-caption)",
  color: "var(--cocoa-label-tertiary)",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap"
};

const emptyStateStyle: CSSProperties = {
  padding: "16px 8px",
  fontSize: "var(--cocoa-fs-body)",
  color: "var(--cocoa-label-secondary)",
  textAlign: "center",
  userSelect: "none"
};

// Render the label with the matched substring wrapped in <strong>. Match is
// case-insensitive but we preserve the original casing in the output. If the
// query is empty or not found we return the plain label.
function renderHighlightedLabel(label: string, query: string): ReactNode {
  if (query.length === 0) return label;
  const lowerLabel = label.toLowerCase();
  const lowerQuery = query.toLowerCase();
  const index = lowerLabel.indexOf(lowerQuery);
  if (index === -1) return label;
  const before = label.slice(0, index);
  const match = label.slice(index, index + query.length);
  const after = label.slice(index + query.length);
  return (
    <>
      {before}
      <strong style={{ fontWeight: "var(--cocoa-fw-semibold)" as unknown as number }}>
        {match}
      </strong>
      {after}
    </>
  );
}

interface ResultRowProps {
  item: SidebarSearchItem;
  query: string;
  onSelect: (itemId: string) => void;
}

function ResultRow({ item, query, onSelect }: ResultRowProps) {
  const [hovered, setHovered] = useState(false);

  const style: CSSProperties = useMemo(() => {
    const merged: CSSProperties = { ...itemBaseStyle };
    if (hovered) {
      merged.background = "rgba(0, 100, 225, 0.08)";
    }
    return merged;
  }, [hovered]);

  return (
    <button
      type="button"
      className="cocoa-focus-ring"
      style={style}
      onClick={() => onSelect(item.id)}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {item.icon !== undefined ? (
        <span style={itemIconStyle} aria-hidden="true">
          {item.icon}
        </span>
      ) : null}
      <span style={itemBodyStyle}>
        <span style={itemLabelStyle}>
          {renderHighlightedLabel(item.label, query)}
        </span>
        {item.caption !== undefined && item.caption !== "" ? (
          <span style={itemCaptionStyle}>{item.caption}</span>
        ) : null}
        <span style={itemGroupStyle}>{item.groupLabel}</span>
      </span>
    </button>
  );
}

export function SidebarSearchResults({
  query,
  allItems,
  onSelect
}: SidebarSearchResultsProps) {
  // Fuzzy substring, case-insensitive match against the label. We intentionally
  // keep this simple (no scoring, no token reordering) — the input is the
  // already-flattened list of all items across sections and the resulting
  // order preserves the navigation tree order.
  const matches = useMemo<SidebarSearchItem[]>(() => {
    const trimmed = query.trim();
    if (trimmed.length === 0) return [];
    const lowerQuery = trimmed.toLowerCase();
    return allItems.filter((item) =>
      item.label.toLowerCase().includes(lowerQuery)
    );
  }, [query, allItems]);

  const trimmedQuery = query.trim();
  if (trimmedQuery.length === 0) return null;

  return (
    <div style={containerStyle} role="region" aria-label="Resultados de busqueda">
      <div style={headerStyle}>{`Resultados para ${trimmedQuery}`}</div>
      {matches.length === 0 ? (
        <div style={emptyStateStyle}>Sin resultados</div>
      ) : (
        <div role="list" style={listStyle}>
          {matches.map((item) => (
            <ResultRow
              key={item.id}
              item={item}
              query={trimmedQuery}
              onSelect={onSelect}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export default SidebarSearchResults;
