// CocoaPageHeader — the page head of Cocoa 22 (COCOA-22.md §3.2):
//
//   <header>            padding-bottom 24 · hairline bottom · gap 12
//     <p eyebrow>       caption 600 uppercase +0.012em · label-secondary (was
//                       tertiary: 1.9:1, failed AA)
//     <h1>              large-title 26/1.15 700 −0.011em · nowrap + ellipsis
//                       (phone: title-1 22 px, wraps to two lines)
//     <p subtitle>      body 13/1.35 · label-secondary
//     <div actions>     inline-flex gap 8, top-right (phone: below, wrapping)
//     <tabs>            CocoaSegmentedControl, margin-top 8
//
// One h1 per page: hosted screens (`useTabHost() !== null`) never render this
// component — they paint `HostedHead` (or use `CocoaPage`, which decides).

import type { CSSProperties, ReactNode } from "react";
import { CocoaSegmentedControl } from "./CocoaSegmentedControl";
import { useIsNarrow } from "./cocoa-viewport";

export interface CocoaPageHeaderTab {
  value: string;
  label: string;
  icon?: ReactNode;
}

export interface CocoaPageHeaderProps {
  eyebrow?: string;
  title: string;
  subtitle?: string;
  icon?: ReactNode;
  actions?: ReactNode;
  tabs?: Array<CocoaPageHeaderTab>;
  activeTab?: string;
  onTabChange?: (value: string) => void;
  /** id of the `role="tabpanel"` the active inner view controls (forwarded to CocoaSegmentedControl `panelId`); CocoaPage makes its body that panel when the screen passes none. */
  panelId?: string;
  /** Let the title wrap on desktop too (narrow containers such as the 440 px auth card); default: one line with ellipsis. */
  wrap?: boolean;
  className?: string;
  style?: CSSProperties;
}

const containerStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--cocoa-space-3)",
  paddingBottom: "var(--cocoa-space-5)",
  borderBottom: "1px solid var(--cocoa-separator)",
  fontFamily: "var(--cocoa-font)",
  minWidth: 0
};

const headingBlockStyle: CSSProperties = { display: "flex", flexDirection: "column", gap: "var(--cocoa-space-1)", minWidth: 0, flex: "1 1 auto" };

const eyebrowStyle: CSSProperties = {
  color: "var(--cocoa-label-secondary)",
  fontSize: "var(--cocoa-fs-caption)",
  fontWeight: "var(--cocoa-fw-semibold)" as CSSProperties["fontWeight"],
  letterSpacing: "var(--cocoa-tracking-wide)",
  textTransform: "uppercase",
  lineHeight: 1.2,
  margin: 0
};

const titleIconStyle: CSSProperties = { display: "inline-flex", alignItems: "center", justifyContent: "center", color: "var(--cocoa-label)", flexShrink: 0 };

const subtitleStyle: CSSProperties = {
  color: "var(--cocoa-label-secondary)",
  fontSize: "var(--cocoa-fs-body)",
  fontWeight: "var(--cocoa-fw-regular)" as CSSProperties["fontWeight"],
  letterSpacing: "var(--cocoa-tracking-tight)",
  lineHeight: 1.35,
  margin: 0
};

/** Title metrics by tier (pure): 26 px nowrap on desktop, 22 px wrapping on phones; `wrap` keeps the 26 px and lets it wrap. */
export function headerTitleStyle(isNarrow: boolean, wrap = false): CSSProperties {
  const wraps = isNarrow || wrap;
  return {
    color: "var(--cocoa-label)",
    fontSize: isNarrow ? "var(--cocoa-fs-title-1)" : "var(--cocoa-fs-large-title)",
    fontWeight: "var(--cocoa-fw-bold)" as CSSProperties["fontWeight"],
    letterSpacing: "var(--cocoa-tracking-tight)",
    lineHeight: 1.15,
    margin: 0,
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: wraps ? "normal" : "nowrap",
    overflowWrap: wraps ? "anywhere" : undefined
  };
}

export function CocoaPageHeader({ eyebrow, title, subtitle, icon, actions, tabs, activeTab, onTabChange, panelId, wrap = false, className, style }: CocoaPageHeaderProps) {
  const isNarrow = useIsNarrow();
  const mergedContainerStyle: CSSProperties = style ? { ...containerStyle, ...style } : containerStyle;
  const hasTabs = Array.isArray(tabs) && tabs.length > 0;
  const segmentedValue = activeTab ?? (hasTabs ? tabs![0].value : "");

  const topRowStyle: CSSProperties = {
    display: "flex",
    flexDirection: isNarrow ? "column" : "row",
    alignItems: isNarrow ? "stretch" : "flex-start",
    justifyContent: "space-between",
    gap: isNarrow ? "var(--cocoa-space-3)" : "var(--cocoa-space-4)",
    width: "100%",
    minWidth: 0
  };

  const actionsStyle: CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    flexWrap: "wrap",
    gap: "var(--cocoa-space-2)",
    flexShrink: 0,
    justifyContent: isNarrow ? "flex-start" : "flex-end"
  };

  return (
    <header className={["cocoa-page-header", className].filter(Boolean).join(" ")} style={mergedContainerStyle} data-cocoa="page-header">
      <div style={topRowStyle}>
        <div style={headingBlockStyle}>
          {eyebrow ? <p style={eyebrowStyle}>{eyebrow}</p> : null}
          <div style={{ display: "flex", alignItems: "center", gap: "var(--cocoa-space-2)", minWidth: 0 }}>
            {icon ? (
              <span aria-hidden="true" style={titleIconStyle}>
                {icon}
              </span>
            ) : null}
            <h1 style={headerTitleStyle(isNarrow, wrap)}>{title}</h1>
          </div>
          {subtitle ? <p style={subtitleStyle}>{subtitle}</p> : null}
        </div>
        {actions ? <div style={actionsStyle}>{actions}</div> : null}
      </div>
      {hasTabs ? (
        <div style={{ display: "flex", alignItems: "center", marginTop: "var(--cocoa-space-2)", minWidth: 0 }}>
          <CocoaSegmentedControl value={segmentedValue} onChange={(value) => onTabChange?.(value)} options={tabs!} fullWidth={isNarrow} panelId={panelId} aria-label={`Secciones de ${title}`} />
        </div>
      ) : null}
    </header>
  );
}

export default CocoaPageHeader;
