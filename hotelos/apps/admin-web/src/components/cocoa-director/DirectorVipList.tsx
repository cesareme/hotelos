import type { CSSProperties, KeyboardEvent, MouseEvent } from "react";
import { CocoaCard } from "../cocoa/CocoaCard";

export type DirectorVipTier =
  | "VIP"
  | "VVIP"
  | "Owner"
  | "Press"
  | "Influencer";

export type DirectorVipStatus = "pre-arrival" | "in-house" | "departing-today";

export interface DirectorVipListItem {
  guestId: string;
  name: string;
  vipTier: DirectorVipTier;
  roomNumber?: string;
  status: DirectorVipStatus;
  preferences?: string[];
  nextTouchpoint?: string;
}

export interface DirectorVipListProps {
  vips: DirectorVipListItem[];
  max?: number;
  onSelectGuest?: (guestId: string) => void;
}

interface BadgePalette {
  bg: string;
  fg: string;
  line: string;
}

const TIER_PALETTE: Record<DirectorVipTier, BadgePalette> = {
  VIP: {
    bg: "var(--cocoa-fill-tertiary, #efeaff)",
    fg: "var(--cocoa-accent, #6d4ed1)",
    line: "var(--cocoa-separator, #d8d4ca)"
  },
  VVIP: {
    bg: "var(--warn-bg, #fdf2dc)",
    fg: "var(--warn-ink, #8a4a09)",
    line: "var(--warn-line, #f3d59b)"
  },
  Owner: {
    bg: "var(--ai-soft, #efeaff)",
    fg: "var(--ai, #6d4ed1)",
    line: "var(--cocoa-separator, #d8d4ca)"
  },
  Press: {
    bg: "var(--info-bg, #e4ecfa)",
    fg: "var(--info-ink, #1a3d8a)",
    line: "var(--info-line, #b3c4eb)"
  },
  Influencer: {
    bg: "var(--ok-bg, #e3f4eb)",
    fg: "var(--ok-ink, #0a6b46)",
    line: "var(--ok-line, #b8e0cb)"
  }
};

const STATUS_PALETTE: Record<DirectorVipStatus, BadgePalette> = {
  "pre-arrival": {
    bg: "var(--info-bg, #e4ecfa)",
    fg: "var(--info-ink, #1a3d8a)",
    line: "var(--info-line, #b3c4eb)"
  },
  "in-house": {
    bg: "var(--ok-bg, #e3f4eb)",
    fg: "var(--ok-ink, #0a6b46)",
    line: "var(--ok-line, #b8e0cb)"
  },
  "departing-today": {
    bg: "var(--warn-bg, #fdf2dc)",
    fg: "var(--warn-ink, #8a4a09)",
    line: "var(--warn-line, #f3d59b)"
  }
};

const STATUS_LABEL: Record<DirectorVipStatus, string> = {
  "pre-arrival": "Pre-arrival",
  "in-house": "In-house",
  "departing-today": "Departing today"
};

const AVATAR_PALETTE: Array<{ bg: string; fg: string }> = [
  { bg: "var(--accent-soft, #e6f4ef)", fg: "var(--accent-strong, #086b48)" },
  { bg: "var(--info-bg, #e4ecfa)", fg: "var(--info-ink, #1a3d8a)" },
  { bg: "var(--warn-bg, #fdf2dc)", fg: "var(--warn-ink, #8a4a09)" },
  { bg: "var(--ai-soft, #efeaff)", fg: "var(--ai, #6d4ed1)" },
  { bg: "var(--ok-bg, #e3f4eb)", fg: "var(--ok-ink, #0a6b46)" }
];

function hashString(input: string): number {
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    hash = (hash * 31 + input.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

function getInitials(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return "?";
  const parts = trimmed.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) {
    return parts[0].slice(0, 2).toUpperCase();
  }
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

const headerStyle: CSSProperties = {
  display: "flex",
  alignItems: "baseline",
  justifyContent: "space-between",
  gap: "var(--cocoa-space-2, 8px)",
  marginBottom: "var(--cocoa-space-3, 12px)",
  fontFamily: "var(--cocoa-font, inherit)"
};

const headerTitleStyle: CSSProperties = {
  margin: 0,
  fontSize: "var(--cocoa-fs-headline, 15px)",
  fontWeight: 600,
  color: "var(--cocoa-label, #1a1a1a)",
  letterSpacing: "var(--cocoa-tracking-tight, -0.01em)"
};

const headerCountStyle: CSSProperties = {
  fontSize: "var(--cocoa-fs-subheadline, 13px)",
  fontWeight: 500,
  color: "var(--cocoa-label-secondary, #6a6a6a)",
  fontVariantNumeric: "tabular-nums"
};

const listStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--cocoa-space-2, 8px)",
  fontFamily: "var(--cocoa-font, inherit)"
};

const rowBaseStyle: CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  gap: "var(--cocoa-space-3, 12px)",
  padding: "var(--cocoa-space-3, 12px)",
  borderRadius: "var(--cocoa-radius-md, 10px)",
  background: "transparent",
  border: "1px solid transparent",
  transition:
    "background var(--cocoa-duration-fast, 150ms) var(--cocoa-ease-out, ease), border-color var(--cocoa-duration-fast, 150ms) var(--cocoa-ease-out, ease)",
  textAlign: "left",
  width: "100%",
  minWidth: 0
};

const avatarStyle: CSSProperties = {
  width: 32,
  height: 32,
  borderRadius: "var(--cocoa-radius-full, 999px)",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  fontWeight: 600,
  fontSize: "var(--cocoa-fs-footnote, 12px)",
  flexShrink: 0,
  userSelect: "none",
  border: "1px solid var(--cocoa-separator, #f1ede5)"
};

const rowBodyStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 4,
  minWidth: 0,
  flex: 1
};

const rowTitleRowStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "var(--cocoa-space-2, 8px)",
  flexWrap: "wrap",
  minWidth: 0
};

const nameStyle: CSSProperties = {
  fontSize: "var(--cocoa-fs-subheadline, 13px)",
  fontWeight: 600,
  color: "var(--cocoa-label, #1a1a1a)",
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
  minWidth: 0
};

const metaRowStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "var(--cocoa-space-2, 8px)",
  flexWrap: "wrap",
  minWidth: 0
};

const roomStyle: CSSProperties = {
  fontSize: "var(--cocoa-fs-footnote, 12px)",
  fontWeight: 500,
  color: "var(--cocoa-label-secondary, #6a6a6a)",
  fontVariantNumeric: "tabular-nums"
};

const prefRowStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: 4,
  marginTop: 2
};

const prefPillStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  fontSize: "var(--cocoa-fs-caption, 11px)",
  fontWeight: 500,
  color: "var(--cocoa-label-secondary, #6a6a6a)",
  background: "var(--cocoa-fill-quaternary, #f0eee8)",
  border: "1px solid var(--cocoa-separator, #d8d4ca)",
  borderRadius: "var(--cocoa-radius-full, 999px)",
  padding: "2px 8px",
  lineHeight: 1.2,
  whiteSpace: "nowrap"
};

const touchpointStyle: CSSProperties = {
  fontSize: "var(--cocoa-fs-caption, 11px)",
  fontWeight: 500,
  color: "var(--cocoa-label-tertiary, #8a8a8a)",
  marginTop: 2
};

const footerStyle: CSSProperties = {
  marginTop: "var(--cocoa-space-3, 12px)",
  display: "flex",
  justifyContent: "flex-end",
  fontFamily: "var(--cocoa-font, inherit)"
};

const footerLinkStyle: CSSProperties = {
  background: "transparent",
  border: 0,
  padding: 0,
  fontSize: "var(--cocoa-fs-footnote, 12px)",
  fontWeight: 600,
  color: "var(--cocoa-accent, #086b48)",
  cursor: "pointer",
  fontFamily: "inherit"
};

const emptyStyle: CSSProperties = {
  padding: "var(--cocoa-space-4, 16px) var(--cocoa-space-2, 8px)",
  textAlign: "center",
  fontSize: "var(--cocoa-fs-subheadline, 13px)",
  color: "var(--cocoa-label-secondary, #6a6a6a)",
  fontFamily: "var(--cocoa-font, inherit)"
};

function makeBadgeStyle(palette: BadgePalette): CSSProperties {
  return {
    display: "inline-flex",
    alignItems: "center",
    gap: 4,
    background: palette.bg,
    color: palette.fg,
    border: `1px solid ${palette.line}`,
    borderRadius: "var(--cocoa-radius-full, 999px)",
    padding: "2px 8px",
    fontSize: "var(--cocoa-fs-caption, 11px)",
    fontWeight: 600,
    lineHeight: 1,
    whiteSpace: "nowrap"
  };
}

function VipRow({
  vip,
  onSelectGuest
}: {
  vip: DirectorVipListItem;
  onSelectGuest?: (guestId: string) => void;
}) {
  const isInteractive = typeof onSelectGuest === "function";
  const initials = getInitials(vip.name);
  const avatarPalette =
    AVATAR_PALETTE[hashString(vip.name) % AVATAR_PALETTE.length];
  const tierPalette = TIER_PALETTE[vip.vipTier];
  const statusPalette = STATUS_PALETTE[vip.status];
  const visiblePrefs = (vip.preferences ?? []).slice(0, 3);
  const extraPrefCount = Math.max(
    0,
    (vip.preferences?.length ?? 0) - visiblePrefs.length
  );

  const handleClick = (event: MouseEvent<HTMLDivElement>) => {
    if (!isInteractive) return;
    event.preventDefault();
    onSelectGuest?.(vip.guestId);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!isInteractive) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onSelectGuest?.(vip.guestId);
    }
  };

  const handleMouseEnter = (event: MouseEvent<HTMLDivElement>) => {
    if (!isInteractive) return;
    event.currentTarget.style.background =
      "var(--cocoa-fill-quaternary, #f0eee8)";
    event.currentTarget.style.borderColor =
      "var(--cocoa-separator, #d8d4ca)";
  };

  const handleMouseLeave = (event: MouseEvent<HTMLDivElement>) => {
    if (!isInteractive) return;
    event.currentTarget.style.background = "transparent";
    event.currentTarget.style.borderColor = "transparent";
  };

  return (
    <div
      style={{
        ...rowBaseStyle,
        cursor: isInteractive ? "pointer" : "default"
      }}
      role={isInteractive ? "button" : undefined}
      tabIndex={isInteractive ? 0 : undefined}
      onClick={isInteractive ? handleClick : undefined}
      onKeyDown={isInteractive ? handleKeyDown : undefined}
      onMouseEnter={isInteractive ? handleMouseEnter : undefined}
      onMouseLeave={isInteractive ? handleMouseLeave : undefined}
      aria-label={isInteractive ? `Open ${vip.name}` : undefined}
    >
      <span
        aria-hidden="true"
        style={{
          ...avatarStyle,
          background: avatarPalette.bg,
          color: avatarPalette.fg
        }}
      >
        {initials}
      </span>
      <div style={rowBodyStyle}>
        <div style={rowTitleRowStyle}>
          <span style={nameStyle} title={vip.name}>
            {vip.name}
          </span>
          <span style={makeBadgeStyle(tierPalette)}>{vip.vipTier}</span>
        </div>
        <div style={metaRowStyle}>
          {vip.roomNumber ? (
            <span style={roomStyle}>Room {vip.roomNumber}</span>
          ) : null}
          <span style={makeBadgeStyle(statusPalette)}>
            {STATUS_LABEL[vip.status]}
          </span>
        </div>
        {visiblePrefs.length > 0 ? (
          <div style={prefRowStyle}>
            {visiblePrefs.map((pref) => (
              <span key={pref} style={prefPillStyle}>
                {pref}
              </span>
            ))}
            {extraPrefCount > 0 ? (
              <span style={prefPillStyle}>+{extraPrefCount}</span>
            ) : null}
          </div>
        ) : null}
        {vip.nextTouchpoint ? (
          <div style={touchpointStyle}>{vip.nextTouchpoint}</div>
        ) : null}
      </div>
    </div>
  );
}

export function DirectorVipList({
  vips,
  max = 5,
  onSelectGuest
}: DirectorVipListProps) {
  const total = vips.length;
  const visible = vips.slice(0, max);
  const hasOverflow = total > visible.length;

  const handleSeeAll = () => {
    if (vips.length === 0) return;
    onSelectGuest?.(vips[0].guestId);
  };

  return (
    <CocoaCard variant="bordered" padding="md">
      <header style={headerStyle}>
        <h3 style={headerTitleStyle}>VIPs in-house</h3>
        <span style={headerCountStyle} aria-label={`${total} VIPs`}>
          {total}
        </span>
      </header>

      {total === 0 ? (
        <div style={emptyStyle} role="status">
          Sin VIPs in-house ahora
        </div>
      ) : (
        <div style={listStyle} role="list">
          {visible.map((vip) => (
            <div role="listitem" key={vip.guestId}>
              <VipRow vip={vip} onSelectGuest={onSelectGuest} />
            </div>
          ))}
        </div>
      )}

      {hasOverflow ? (
        <div style={footerStyle}>
          <button
            type="button"
            style={footerLinkStyle}
            onClick={handleSeeAll}
          >
            Ver todos →
          </button>
        </div>
      ) : null}
    </CocoaCard>
  );
}

export default DirectorVipList;
