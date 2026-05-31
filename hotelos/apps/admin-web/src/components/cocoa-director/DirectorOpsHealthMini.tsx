// DirectorOpsHealthMini — Cocoa-style mini-health tile for cross-department ops.
//
// Compact tile that surfaces the health of a single operational module
// (housekeeping, maintenance, workforce, safety, pos) at a glance. Designed
// to live inside the Director Overview grid alongside the existing KPI tiles
// (see `DirectorKpiTile`).
//
// Layout (vertical):
//   - Header row: module icon + title + status dot (green / amber / red)
//   - Primary row: big tabular count + small primary label
//   - Breakdown row (optional): mini pills with sub-counts
//                               ("limpia 8 · sucia 12 · OOO 1")
//   - Delta row (optional, bottom-right): "Δ +3 vs ayer"
//
// Status dot colors:
//   - 'ok'        → var(--cocoa-success)
//   - 'warning'   → var(--cocoa-warning)
//   - 'critical'  → var(--cocoa-danger)
//
// Behaviour:
//   - The whole card is clickable when `onDrillDown` is provided. The parent
//     screen owns the navigation target per module — this component only
//     forwards the click.

import {
  useCallback,
  useMemo,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode
} from "react";

import { CocoaCard } from "../cocoa/CocoaCard";
import { WrenchIcon } from "../cocoa-icons/NavigationIcons";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type DirectorOpsHealthModule =
  | "housekeeping"
  | "maintenance"
  | "workforce"
  | "safety"
  | "pos";

export type DirectorOpsHealthStatus = "ok" | "warning" | "critical";

export interface DirectorOpsHealthBreakdownItem {
  label: string;
  count: number;
  color?: string;
}

export interface DirectorOpsHealthMiniProps {
  module: DirectorOpsHealthModule;
  title: string;
  primaryCount: number;
  primaryLabel: string;
  breakdown?: DirectorOpsHealthBreakdownItem[];
  status: DirectorOpsHealthStatus;
  deltaVsYesterday?: number;
  onDrillDown?: () => void;
}

// ---------------------------------------------------------------------------
// Module → status tokens
// ---------------------------------------------------------------------------

const STATUS_COLOR: Record<DirectorOpsHealthStatus, string> = {
  ok: "var(--cocoa-success)",
  warning: "var(--cocoa-warning)",
  critical: "var(--cocoa-danger)"
};

const STATUS_LABEL: Record<DirectorOpsHealthStatus, string> = {
  ok: "OK",
  warning: "Atención",
  critical: "Crítico"
};

// ---------------------------------------------------------------------------
// Inline icon set
//
// Only `WrenchIcon` already exists in the shared NavigationIcons catalog. The
// other four (broom, clipboard, shield, cup) are tile-local SVGs sized for the
// 14×14 header slot, matching the existing icon style (stroke="currentColor",
// 24×24 viewBox, rounded caps/joins).
// ---------------------------------------------------------------------------

interface MiniIconProps {
  size?: number;
}

function BroomIcon({ size = 14 }: MiniIconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M14 3.5l6.5 6.5" />
      <path d="M11 6.5l6.5 6.5-2 2-7-2-2-2 4.5-4.5z" />
      <path d="M6.5 11l-3.5 9.5 9.5-3.5" />
      <path d="M3 20.5l4-4" />
    </svg>
  );
}

function ClipboardIcon({ size = 14 }: MiniIconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      focusable="false"
    >
      <rect x="5.5" y="4.5" width="13" height="16" rx="2" />
      <rect x="9" y="2.5" width="6" height="4" rx="1" />
      <path d="M9 11h6" />
      <path d="M9 14.5h6" />
      <path d="M9 18h4" />
    </svg>
  );
}

function ShieldIcon({ size = 14 }: MiniIconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M12 3l8 3v6c0 4.5-3.4 8.4-8 9.5-4.6-1.1-8-5-8-9.5V6l8-3z" />
      <path d="M9 12l2 2 4-4" />
    </svg>
  );
}

function CupIcon({ size = 14 }: MiniIconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M4 7h13v6a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5V7z" />
      <path d="M17 9h2.5a2.5 2.5 0 0 1 0 5H17" />
      <path d="M8 3v2" />
      <path d="M11 3v2" />
      <path d="M14 3v2" />
    </svg>
  );
}

const MODULE_ICON: Record<DirectorOpsHealthModule, (p: MiniIconProps) => ReactNode> = {
  housekeeping: BroomIcon,
  maintenance: ({ size = 14 }) => <WrenchIcon size={size} />,
  workforce: ClipboardIcon,
  safety: ShieldIcon,
  pos: CupIcon
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatDelta(delta: number): string {
  const abs = Math.abs(delta);
  if (Number.isInteger(abs)) return abs.toString();
  return abs.toFixed(1);
}

function getDeltaColor(delta: number): string {
  if (delta === 0) return "var(--cocoa-label-secondary)";
  // Higher counts day-over-day are typically bad for ops backlog tiles
  // (more dirty rooms, more incidents, more open tickets). Polarity is
  // therefore negative-good.
  return delta > 0 ? "var(--cocoa-danger)" : "var(--cocoa-success)";
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function DirectorOpsHealthMini({
  module,
  title,
  primaryCount,
  primaryLabel,
  breakdown,
  status,
  deltaVsYesterday,
  onDrillDown
}: DirectorOpsHealthMiniProps) {
  const isInteractive = typeof onDrillDown === "function";
  const statusColor = STATUS_COLOR[status];
  const statusLabel = STATUS_LABEL[status];

  const ModuleIcon = MODULE_ICON[module];

  const containerStyle = useMemo<CSSProperties>(
    () => ({
      display: "flex",
      flexDirection: "column",
      gap: 8,
      minHeight: 44,
      fontFamily: "var(--cocoa-font)",
      color: "var(--cocoa-label)"
    }),
    []
  );

  const headerRowStyle: CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: 6,
    color: "var(--cocoa-label-secondary)"
  };

  const iconStyle: CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: 14,
    height: 14,
    flexShrink: 0
  };

  const titleStyle: CSSProperties = {
    fontSize: "var(--cocoa-fs-caption)",
    fontWeight: "var(--cocoa-fw-medium)" as unknown as number,
    letterSpacing: "var(--cocoa-tracking-wide)",
    textTransform: "uppercase",
    color: "var(--cocoa-label-secondary)",
    lineHeight: 1,
    flex: 1,
    minWidth: 0,
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis"
  };

  const statusDotStyle: CSSProperties = {
    display: "inline-block",
    width: 8,
    height: 8,
    borderRadius: 999,
    background: statusColor,
    flexShrink: 0
  };

  const primaryRowStyle: CSSProperties = {
    display: "flex",
    alignItems: "baseline",
    gap: 6
  };

  const primaryCountStyle: CSSProperties = {
    fontSize: 32,
    fontWeight: "var(--cocoa-fw-semibold)" as unknown as number,
    letterSpacing: "var(--cocoa-tracking-tight)",
    color: "var(--cocoa-label)",
    lineHeight: 1.05,
    fontVariantNumeric: "tabular-nums",
    fontFeatureSettings: '"tnum"'
  };

  const primaryLabelStyle: CSSProperties = {
    fontSize: "var(--cocoa-fs-callout)",
    fontWeight: "var(--cocoa-fw-medium)" as unknown as number,
    color: "var(--cocoa-label-secondary)",
    lineHeight: 1.2,
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap"
  };

  const breakdownRowStyle: CSSProperties = {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: 4,
    rowGap: 4
  };

  const breakdownSeparatorStyle: CSSProperties = {
    fontSize: "var(--cocoa-fs-footnote)",
    color: "var(--cocoa-label-tertiary)",
    lineHeight: 1
  };

  function breakdownPillStyle(color?: string): CSSProperties {
    const tone = color ?? "var(--cocoa-label-secondary)";
    return {
      display: "inline-flex",
      alignItems: "baseline",
      gap: 4,
      padding: "2px 6px",
      borderRadius: "var(--cocoa-radius-sm)",
      background: "var(--cocoa-background-control)",
      fontSize: "var(--cocoa-fs-footnote)",
      fontWeight: "var(--cocoa-fw-medium)" as unknown as number,
      color: tone,
      fontVariantNumeric: "tabular-nums",
      fontFeatureSettings: '"tnum"',
      lineHeight: 1.2,
      whiteSpace: "nowrap"
    };
  }

  const breakdownPillCountStyle: CSSProperties = {
    fontWeight: "var(--cocoa-fw-semibold)" as unknown as number
  };

  const bottomRowStyle: CSSProperties = {
    display: "flex",
    alignItems: "center",
    justifyContent: "flex-end",
    gap: 6,
    marginTop: "auto",
    minHeight: 14
  };

  const deltaTextStyle = useMemo<CSSProperties>(
    () => ({
      display: "inline-flex",
      alignItems: "center",
      gap: 4,
      fontSize: "var(--cocoa-fs-footnote)",
      fontWeight: "var(--cocoa-fw-medium)" as unknown as number,
      color: deltaVsYesterday === undefined ? "transparent" : getDeltaColor(deltaVsYesterday),
      fontVariantNumeric: "tabular-nums",
      fontFeatureSettings: '"tnum"',
      lineHeight: 1.2,
      whiteSpace: "nowrap"
    }),
    [deltaVsYesterday]
  );

  const deltaLabelStyle: CSSProperties = {
    fontSize: "var(--cocoa-fs-footnote)",
    fontWeight: "var(--cocoa-fw-regular)" as unknown as number,
    color: "var(--cocoa-label-secondary)",
    fontVariantNumeric: "tabular-nums",
    fontFeatureSettings: '"tnum"'
  };

  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (!isInteractive) return;
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        onDrillDown?.();
      }
    },
    [isInteractive, onDrillDown]
  );

  const hasBreakdown = Boolean(breakdown && breakdown.length > 0);
  const hasDelta = typeof deltaVsYesterday === "number";

  const ariaLabel = useMemo(() => {
    const parts: string[] = [
      title,
      `${primaryCount} ${primaryLabel}`,
      statusLabel
    ];
    if (hasBreakdown && breakdown) {
      breakdown.forEach((item) => parts.push(`${item.label} ${item.count}`));
    }
    if (hasDelta && deltaVsYesterday !== undefined) {
      const sign = deltaVsYesterday > 0 ? "+" : deltaVsYesterday < 0 ? "−" : "";
      parts.push(`Δ ${sign}${formatDelta(deltaVsYesterday)} vs ayer`);
    }
    return parts.join(", ");
  }, [
    title,
    primaryCount,
    primaryLabel,
    statusLabel,
    hasBreakdown,
    breakdown,
    hasDelta,
    deltaVsYesterday
  ]);

  const deltaArrow = hasDelta
    ? deltaVsYesterday === 0
      ? "•"
      : (deltaVsYesterday as number) > 0
      ? "▲"
      : "▼"
    : null;

  const deltaSign = hasDelta
    ? (deltaVsYesterday as number) > 0
      ? "+"
      : (deltaVsYesterday as number) < 0
      ? "−"
      : ""
    : "";

  return (
    <CocoaCard
      variant="plain"
      padding="sm"
      onClick={onDrillDown}
      className={isInteractive ? "cocoa-focus-ring" : undefined}
    >
      <div
        style={containerStyle}
        role={isInteractive ? "button" : "group"}
        tabIndex={isInteractive ? 0 : undefined}
        onKeyDown={isInteractive ? handleKeyDown : undefined}
        aria-label={isInteractive ? ariaLabel : undefined}
      >
        <div style={headerRowStyle}>
          <span style={iconStyle} aria-hidden="true">
            <ModuleIcon size={14} />
          </span>
          <span style={titleStyle}>{title}</span>
          <span
            style={statusDotStyle}
            role="img"
            aria-label={statusLabel}
            title={statusLabel}
          />
        </div>

        <div style={primaryRowStyle}>
          <span style={primaryCountStyle}>{primaryCount}</span>
          <span style={primaryLabelStyle}>{primaryLabel}</span>
        </div>

        {hasBreakdown && breakdown ? (
          <div style={breakdownRowStyle}>
            {breakdown.map((item, index) => (
              <span key={`${item.label}-${index}`} style={breakdownRowStyle}>
                {index > 0 ? (
                  <span style={breakdownSeparatorStyle} aria-hidden="true">
                    ·
                  </span>
                ) : null}
                <span style={breakdownPillStyle(item.color)}>
                  <span>{item.label}</span>
                  <span style={breakdownPillCountStyle}>{item.count}</span>
                </span>
              </span>
            ))}
          </div>
        ) : null}

        <div style={bottomRowStyle}>
          {hasDelta && deltaVsYesterday !== undefined ? (
            <span style={deltaTextStyle}>
              <span aria-hidden="true">Δ</span>
              {deltaArrow ? <span aria-hidden="true">{deltaArrow}</span> : null}
              <span>
                {deltaSign}
                {formatDelta(deltaVsYesterday)}
              </span>
              <span style={deltaLabelStyle}>vs ayer</span>
            </span>
          ) : null}
        </div>
      </div>
    </CocoaCard>
  );
}

export default DirectorOpsHealthMini;
