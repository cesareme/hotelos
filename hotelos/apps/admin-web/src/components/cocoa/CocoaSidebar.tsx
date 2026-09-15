// CocoaSidebar — source-list navigation column (COCOA-22.md §3.1). Sidebar
// background (Cocoa 22: `--cocoa-background-sidebar` = `--surface`), hairline
// right, section captions uppercase, items 13 px with hover accent wash and
// selected accent fill. Only tokens: the old literal hover blue and the white
// badge tint are gone.

import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";

export interface CocoaSidebarItem {
  id: string;
  label: string;
  icon?: ReactNode;
  badge?: string | number;
  selected?: boolean;
}

export interface CocoaSidebarSection {
  title?: string;
  items: CocoaSidebarItem[];
  collapsible?: boolean;
  defaultOpen?: boolean;
}

export interface CocoaSidebarProps {
  sections: CocoaSidebarSection[];
  onSelect: (itemId: string) => void;
  width?: number;
  header?: ReactNode;
  footer?: ReactNode;
  className?: string;
  "aria-label"?: string;
}

const DEFAULT_WIDTH = 240;

const containerBaseStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  height: "100%",
  boxSizing: "border-box",
  background: "var(--cocoa-background-sidebar)",
  borderRight: "1px solid var(--cocoa-separator)",
  fontFamily: "var(--cocoa-font)",
  fontSize: "var(--cocoa-fs-body)",
  color: "var(--cocoa-label)"
};

const headerStyle: CSSProperties = { flex: "0 0 auto", padding: "var(--cocoa-space-3)", borderBottom: "1px solid var(--cocoa-separator)", boxSizing: "border-box" };
const footerStyle: CSSProperties = { flex: "0 0 auto", padding: "var(--cocoa-space-3)", borderTop: "1px solid var(--cocoa-separator)", boxSizing: "border-box", paddingBottom: "calc(var(--cocoa-space-3) + env(safe-area-inset-bottom))" };
const bodyStyle: CSSProperties = { flex: "1 1 auto", overflowY: "auto", overflowX: "hidden", padding: "var(--cocoa-space-3)", boxSizing: "border-box", WebkitOverflowScrolling: "touch" };
const sectionStyle: CSSProperties = { display: "flex", flexDirection: "column", marginBottom: 8 };

const sectionTitleBaseStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 4,
  padding: "8px 8px 4px",
  fontSize: "var(--cocoa-fs-caption)",
  fontWeight: "var(--cocoa-fw-semibold)" as CSSProperties["fontWeight"],
  letterSpacing: "var(--cocoa-tracking-wide)",
  textTransform: "uppercase",
  color: "var(--cocoa-label-secondary)",
  userSelect: "none",
  background: "transparent",
  border: "none",
  width: "100%",
  textAlign: "left",
  cursor: "default",
  font: "inherit"
};

const itemListStyle: CSSProperties = { display: "flex", flexDirection: "column", gap: 1 };

const itemBaseStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  padding: "6px 8px",
  minHeight: 32,
  borderRadius: "var(--cocoa-radius-md)",
  cursor: "pointer",
  userSelect: "none",
  background: "transparent",
  border: "none",
  width: "100%",
  textAlign: "left",
  color: "inherit",
  font: "inherit",
  fontSize: "var(--cocoa-fs-body)",
  transition: "background-color var(--cocoa-duration-fast) var(--cocoa-ease-out), color var(--cocoa-duration-fast) var(--cocoa-ease-out)",
  boxSizing: "border-box"
};

const itemIconStyle: CSSProperties = { display: "inline-flex", alignItems: "center", justifyContent: "center", width: 16, height: 16, flexShrink: 0, color: "inherit" };
const itemLabelStyle: CSSProperties = { flex: "1 1 auto", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };

const badgeBaseStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  minWidth: 18,
  height: 16,
  padding: "0 6px",
  borderRadius: "var(--cocoa-radius-full)",
  fontSize: "var(--cocoa-fs-caption)",
  fontWeight: "var(--cocoa-fw-semibold)" as CSSProperties["fontWeight"],
  lineHeight: 1,
  flexShrink: 0,
  background: "var(--cocoa-label-secondary)",
  color: "var(--cocoa-background-content)",
  fontVariantNumeric: "tabular-nums"
};

const badgeSelectedStyle: CSSProperties = { background: "color-mix(in srgb, var(--cocoa-accent-contrast) 25%, transparent)", color: "inherit" };

function Chevron({ open }: { open: boolean }) {
  return (
    <span aria-hidden="true" style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 10, height: 10, transform: open ? "rotate(90deg)" : "rotate(0deg)", transition: "transform var(--cocoa-duration-fast) var(--cocoa-ease-out)", color: "var(--cocoa-label-secondary)" }}>
      <svg width="10" height="10" viewBox="0 0 10 10" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M3.5 2L6.5 5L3.5 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </span>
  );
}

function SidebarItem({ item, onSelect }: { item: CocoaSidebarItem; onSelect: (itemId: string) => void }) {
  const [hovered, setHovered] = useState(false);
  const isSelected = item.selected === true;

  const style: CSSProperties = useMemo(() => {
    const merged: CSSProperties = { ...itemBaseStyle };
    if (isSelected) {
      merged.background = "var(--cocoa-accent)";
      merged.color = "var(--cocoa-accent-contrast)";
      merged.fontWeight = "var(--cocoa-fw-semibold)" as CSSProperties["fontWeight"];
    } else if (hovered) {
      merged.background = "var(--cocoa-accent-bg)";
    }
    return merged;
  }, [hovered, isSelected]);

  const badgeStyle: CSSProperties = useMemo(() => (isSelected ? { ...badgeBaseStyle, ...badgeSelectedStyle } : badgeBaseStyle), [isSelected]);
  const hasBadge = item.badge !== undefined && item.badge !== null;

  return (
    <button type="button" className="cocoa-focus-ring" style={style} onClick={() => onSelect(item.id)} onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)} aria-current={isSelected ? "page" : undefined}>
      {item.icon !== undefined ? (
        <span style={itemIconStyle} aria-hidden="true">
          {item.icon}
        </span>
      ) : null}
      <span style={itemLabelStyle}>{item.label}</span>
      {hasBadge ? <span style={badgeStyle}>{item.badge}</span> : null}
    </button>
  );
}

function SidebarSection({ section, onSelect, sectionIndex }: { section: CocoaSidebarSection; onSelect: (itemId: string) => void; sectionIndex: number }) {
  const isCollapsible = section.collapsible === true;
  const initialOpen = section.defaultOpen !== false;
  const [open, setOpen] = useState<boolean>(initialOpen);

  useEffect(() => {
    if (!isCollapsible) setOpen(true);
  }, [isCollapsible]);

  const sectionId = `cocoa-sidebar-section-${sectionIndex}`;
  const titleStyle: CSSProperties = useMemo(() => (isCollapsible ? { ...sectionTitleBaseStyle, cursor: "pointer" } : sectionTitleBaseStyle), [isCollapsible]);
  const showTitle = section.title !== undefined && section.title !== "";

  const titleNode = showTitle ? (
    isCollapsible ? (
      <button type="button" className="cocoa-focus-ring" style={titleStyle} onClick={() => setOpen((prev) => !prev)} aria-expanded={open} aria-controls={sectionId}>
        <Chevron open={open} />
        <span>{section.title}</span>
      </button>
    ) : (
      <div style={titleStyle}>
        <span>{section.title}</span>
      </div>
    )
  ) : null;

  return (
    <div style={sectionStyle}>
      {titleNode}
      {open ? (
        <div id={sectionId} role="list" style={itemListStyle}>
          {section.items.map((item) => (
            <SidebarItem key={item.id} item={item} onSelect={onSelect} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function CocoaSidebar({ sections, onSelect, width = DEFAULT_WIDTH, header, footer, className, "aria-label": ariaLabel = "Barra lateral" }: CocoaSidebarProps) {
  const containerStyle: CSSProperties = useMemo(() => ({ ...containerBaseStyle, width, minWidth: width }), [width]);

  return (
    <aside className={["cocoa-sidebar", className].filter(Boolean).join(" ")} style={containerStyle} role="navigation" aria-label={ariaLabel} data-cocoa="sidebar">
      {header !== undefined ? <div style={headerStyle}>{header}</div> : null}
      <div style={bodyStyle}>
        {sections.map((section, index) => (
          <SidebarSection key={section.title ?? `section-${index}`} section={section} onSelect={onSelect} sectionIndex={index} />
        ))}
      </div>
      {footer !== undefined ? <div style={footerStyle}>{footer}</div> : null}
    </aside>
  );
}

export default CocoaSidebar;
