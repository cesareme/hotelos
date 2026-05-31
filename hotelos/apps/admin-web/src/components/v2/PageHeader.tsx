import { type ReactNode, type CSSProperties } from "react";

export interface PageHeaderTab {
  value: string;
  label: string;
  badge?: number | string;
}

export interface PageHeaderProps {
  eyebrow?: string;
  title: string;
  subtitle?: string;
  actions?: ReactNode;
  tabs?: PageHeaderTab[];
  activeTab?: string;
  onTabChange?: (value: string) => void;
}

export function PageHeader({
  eyebrow,
  title,
  subtitle,
  actions,
  tabs,
  activeTab,
  onTabChange
}: PageHeaderProps) {
  const headerStyle: CSSProperties = {
    display: "flex",
    flexDirection: "column",
    gap: "var(--space-4, 16px)",
    paddingBottom: "var(--space-4, 16px)",
    borderBottom: tabs && tabs.length > 0 ? "none" : "1px solid var(--line, #e8e5dd)",
    marginBottom: "var(--space-5, 20px)"
  };

  const topRowStyle: CSSProperties = {
    display: "flex",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: "var(--space-4, 16px)",
    flexWrap: "wrap"
  };

  const titleBlockStyle: CSSProperties = {
    display: "flex",
    flexDirection: "column",
    gap: 4,
    minWidth: 0,
    flex: 1
  };

  const eyebrowStyle: CSSProperties = {
    fontSize: "var(--fs-xs, 11px)",
    color: "var(--ink-muted, #6a6a6a)",
    textTransform: "uppercase",
    letterSpacing: "0.06em",
    fontWeight: 600
  };

  const titleStyle: CSSProperties = {
    fontSize: "var(--fs-2xl, 24px)",
    fontWeight: 600,
    color: "var(--ink, #1a1a1a)",
    lineHeight: "var(--lh-tight, 1.15)",
    margin: 0
  };

  const subtitleStyle: CSSProperties = {
    fontSize: "var(--fs-sm, 12px)",
    color: "var(--ink-muted, #6a6a6a)",
    lineHeight: "var(--lh-snug, 1.35)"
  };

  const actionsStyle: CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    gap: "var(--space-2, 8px)",
    flexShrink: 0
  };

  const tabsContainerStyle: CSSProperties = {
    display: "flex",
    gap: "var(--space-1, 4px)",
    borderBottom: "1px solid var(--line, #e8e5dd)",
    marginTop: "var(--space-1, 4px)"
  };

  return (
    <header style={headerStyle}>
      <div style={topRowStyle}>
        <div style={titleBlockStyle}>
          {eyebrow ? <div style={eyebrowStyle}>{eyebrow}</div> : null}
          <h1 style={titleStyle}>{title}</h1>
          {subtitle ? <p style={subtitleStyle}>{subtitle}</p> : null}
        </div>
        {actions ? <div style={actionsStyle}>{actions}</div> : null}
      </div>
      {tabs && tabs.length > 0 ? (
        <div role="tablist" style={tabsContainerStyle}>
          {tabs.map((tab) => {
            const isActive = tab.value === activeTab;
            const tabBtnStyle: CSSProperties = {
              background: "transparent",
              border: "none",
              padding: "8px 14px",
              cursor: "pointer",
              fontSize: "var(--fs-sm, 12px)",
              fontWeight: isActive ? 600 : 500,
              color: isActive ? "var(--ink, #1a1a1a)" : "var(--ink-muted, #6a6a6a)",
              borderBottom: `2px solid ${
                isActive ? "var(--accent, #0d8a5f)" : "transparent"
              }`,
              marginBottom: -1,
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              fontFamily: "inherit",
              transition: "color var(--duration, 180ms) var(--ease), border-color var(--duration, 180ms) var(--ease)"
            };
            return (
              <button
                key={tab.value}
                role="tab"
                aria-selected={isActive}
                type="button"
                style={tabBtnStyle}
                onClick={() => onTabChange?.(tab.value)}
              >
                <span>{tab.label}</span>
                {tab.badge !== undefined ? (
                  <span
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      justifyContent: "center",
                      minWidth: 18,
                      height: 18,
                      padding: "0 6px",
                      fontSize: "var(--fs-xs, 11px)",
                      fontWeight: 600,
                      background: "var(--surface-sunken, #f1efe9)",
                      color: "var(--ink-muted, #6a6a6a)",
                      borderRadius: "var(--radius-full, 999px)"
                    }}
                  >
                    {tab.badge}
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
      ) : null}
    </header>
  );
}

export default PageHeader;
