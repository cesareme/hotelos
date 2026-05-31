import type { CSSProperties, ReactNode } from "react";
import { CocoaSegmentedControl } from "./CocoaSegmentedControl";

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
  className?: string;
  style?: CSSProperties;
}

const containerStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--cocoa-space-3)",
  paddingBottom: "var(--cocoa-space-5)",
  borderBottom: "1px solid var(--cocoa-separator)",
  fontFamily: "var(--cocoa-font)"
};

const topRowStyle: CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  justifyContent: "space-between",
  gap: "var(--cocoa-space-4)",
  width: "100%"
};

const headingBlockStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--cocoa-space-1)",
  minWidth: 0,
  flex: "1 1 auto"
};

const eyebrowStyle: CSSProperties = {
  color: "var(--cocoa-label-tertiary)",
  fontSize: "var(--cocoa-fs-caption)",
  fontWeight: "var(--cocoa-fw-semibold)" as unknown as number,
  letterSpacing: "var(--cocoa-tracking-wide)",
  textTransform: "uppercase",
  lineHeight: 1.2,
  margin: 0
};

const titleRowStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "var(--cocoa-space-2)",
  minWidth: 0
};

const titleIconStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  color: "var(--cocoa-label)",
  flexShrink: 0
};

const titleStyle: CSSProperties = {
  color: "var(--cocoa-label)",
  fontSize: "var(--cocoa-fs-large-title)",
  fontWeight: "var(--cocoa-fw-bold)" as unknown as number,
  letterSpacing: "var(--cocoa-tracking-tight)",
  lineHeight: 1.15,
  margin: 0,
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap"
};

const subtitleStyle: CSSProperties = {
  color: "var(--cocoa-label-secondary)",
  fontSize: "var(--cocoa-fs-body)",
  fontWeight: "var(--cocoa-fw-regular)" as unknown as number,
  letterSpacing: "var(--cocoa-tracking-tight)",
  lineHeight: 1.35,
  margin: 0
};

const actionsStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: "var(--cocoa-space-2)",
  flexShrink: 0
};

const tabsRowStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  marginTop: "var(--cocoa-space-2)"
};

export function CocoaPageHeader({
  eyebrow,
  title,
  subtitle,
  icon,
  actions,
  tabs,
  activeTab,
  onTabChange,
  className,
  style
}: CocoaPageHeaderProps) {
  const mergedContainerStyle: CSSProperties = style
    ? { ...containerStyle, ...style }
    : containerStyle;

  const hasTabs = Array.isArray(tabs) && tabs.length > 0;
  const segmentedValue = activeTab ?? (hasTabs ? tabs![0].value : "");

  const handleTabChange = (value: string) => {
    if (onTabChange) {
      onTabChange(value);
    }
  };

  return (
    <header className={className} style={mergedContainerStyle}>
      <div style={topRowStyle}>
        <div style={headingBlockStyle}>
          {eyebrow ? <p style={eyebrowStyle}>{eyebrow}</p> : null}
          <div style={titleRowStyle}>
            {icon ? (
              <span aria-hidden="true" style={titleIconStyle}>
                {icon}
              </span>
            ) : null}
            <h1 style={titleStyle}>{title}</h1>
          </div>
          {subtitle ? <p style={subtitleStyle}>{subtitle}</p> : null}
        </div>
        {actions ? <div style={actionsStyle}>{actions}</div> : null}
      </div>
      {hasTabs ? (
        <div style={tabsRowStyle}>
          <CocoaSegmentedControl
            value={segmentedValue}
            onChange={handleTabChange}
            options={tabs!}
            aria-label={`${title} sections`}
          />
        </div>
      ) : null}
    </header>
  );
}

export default CocoaPageHeader;
