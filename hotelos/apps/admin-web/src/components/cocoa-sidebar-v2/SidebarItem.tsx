import {
  useMemo,
  useState,
  type CSSProperties,
  type MouseEvent,
  type ReactNode
} from "react";

export interface SidebarItemProps {
  label: string;
  icon?: ReactNode;
  active?: boolean;
  badge?: string | number;
  shortcut?: string;
  favorite?: boolean;
  onToggleFavorite?: () => void;
  onClick?: () => void;
}

const rowBaseStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  padding: "6px 12px 6px 24px",
  position: "relative",
  cursor: "pointer",
  userSelect: "none",
  background: "transparent",
  border: "none",
  borderLeft: "3px solid transparent",
  width: "100%",
  textAlign: "left",
  color: "inherit",
  font: "inherit",
  fontFamily: "var(--cocoa-font)",
  fontSize: "var(--cocoa-fs-body)",
  boxSizing: "border-box",
  transition:
    "background-color var(--cocoa-duration-fast, 120ms) var(--cocoa-ease-out, ease-out), color var(--cocoa-duration-fast, 120ms) var(--cocoa-ease-out, ease-out)"
};

const iconStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: 18,
  height: 18,
  flexShrink: 0
};

const labelStyle: CSSProperties = {
  flex: "1 1 auto",
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap"
};

const badgeStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  minWidth: 18,
  height: 16,
  padding: "0 6px",
  borderRadius: "var(--cocoa-radius-full, 9999px)",
  background: "var(--cocoa-fill-quaternary, rgba(0, 0, 0, 0.05))",
  color: "var(--cocoa-label-secondary, rgba(0, 0, 0, 0.5))",
  fontSize: 10,
  fontWeight: 600,
  lineHeight: 1,
  flexShrink: 0
};

const shortcutStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  minWidth: 16,
  height: 16,
  padding: "0 4px",
  color: "var(--cocoa-label-tertiary, rgba(0, 0, 0, 0.26))",
  fontSize: "var(--cocoa-fs-caption, 10px)",
  fontFamily: "var(--cocoa-font-mono, ui-monospace, monospace)",
  fontWeight: 500,
  lineHeight: 1,
  flexShrink: 0
};

const favoriteButtonBaseStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: 16,
  height: 16,
  padding: 0,
  background: "transparent",
  border: "none",
  cursor: "pointer",
  color: "var(--cocoa-label-tertiary, rgba(0, 0, 0, 0.26))",
  flexShrink: 0,
  borderRadius: 2
};

function StarIcon({ filled }: { filled: boolean }) {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 12 12"
      fill={filled ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth="1.25"
      strokeLinecap="round"
      strokeLinejoin="round"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <path d="M6 1.5L7.39 4.32L10.5 4.77L8.25 6.96L8.78 10.05L6 8.59L3.22 10.05L3.75 6.96L1.5 4.77L4.61 4.32L6 1.5Z" />
    </svg>
  );
}

export function SidebarItem({
  label,
  icon,
  active = false,
  badge,
  shortcut,
  favorite = false,
  onToggleFavorite,
  onClick
}: SidebarItemProps) {
  const [hovered, setHovered] = useState(false);

  const rowStyle: CSSProperties = useMemo(() => {
    const merged: CSSProperties = { ...rowBaseStyle };
    if (active) {
      merged.background =
        "var(--cocoa-accent-tint, rgba(0, 100, 225, 0.12))";
      merged.borderLeft = "3px solid var(--cocoa-accent, #0064E1)";
      merged.color = "var(--cocoa-label, rgba(0, 0, 0, 0.85))";
    } else if (hovered) {
      merged.background =
        "var(--cocoa-fill-quinary, rgba(0, 0, 0, 0.03))";
    }
    return merged;
  }, [active, hovered]);

  const iconColorStyle: CSSProperties = useMemo(
    () => ({
      ...iconStyle,
      color: active
        ? "var(--cocoa-accent, #0064E1)"
        : "var(--cocoa-label-secondary, rgba(0, 0, 0, 0.5))"
    }),
    [active]
  );

  const hasBadge = badge !== undefined && badge !== null && badge !== "";
  const hasShortcut =
    shortcut !== undefined && shortcut !== null && shortcut !== "";
  const showFavorite =
    onToggleFavorite !== undefined && (favorite || hovered);

  const favoriteButtonStyle: CSSProperties = useMemo(() => {
    if (favorite) {
      return {
        ...favoriteButtonBaseStyle,
        color: "var(--cocoa-warning, #FF9500)"
      };
    }
    return favoriteButtonBaseStyle;
  }, [favorite]);

  const handleFavoriteClick = (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    if (onToggleFavorite !== undefined) {
      onToggleFavorite();
    }
  };

  return (
    <button
      type="button"
      className="cocoa-focus-ring"
      style={rowStyle}
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      aria-current={active ? "page" : undefined}
    >
      {icon !== undefined ? (
        <span style={iconColorStyle} aria-hidden="true">
          {icon}
        </span>
      ) : null}
      <span style={labelStyle}>{label}</span>
      {hasBadge ? <span style={badgeStyle}>{badge}</span> : null}
      {hasShortcut ? (
        <span style={shortcutStyle} aria-hidden="true">
          {shortcut}
        </span>
      ) : null}
      {showFavorite ? (
        <button
          type="button"
          style={favoriteButtonStyle}
          onClick={handleFavoriteClick}
          aria-label={favorite ? "Remove from favorites" : "Add to favorites"}
          aria-pressed={favorite}
        >
          <StarIcon filled={favorite} />
        </button>
      ) : null}
    </button>
  );
}

export default SidebarItem;
