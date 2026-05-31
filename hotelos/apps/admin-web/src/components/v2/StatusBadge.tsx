import { type ReactNode, type CSSProperties } from "react";

export type StatusBadgeVariant = "success" | "warn" | "danger" | "info" | "neutral";
export type StatusBadgeSize = "sm" | "md";

export interface StatusBadgeProps {
  variant: StatusBadgeVariant;
  icon?: string;
  children: ReactNode;
  size?: StatusBadgeSize;
}

interface PaletteEntry {
  bg: string;
  fg: string;
  line: string;
}

const PALETTE: Record<StatusBadgeVariant, PaletteEntry> = {
  success: {
    bg: "var(--ok-bg, #e3f4eb)",
    fg: "var(--ok-ink, #0a6b46)",
    line: "var(--ok-line, #b8e0cb)"
  },
  warn: {
    bg: "var(--warn-bg, #fdf2dc)",
    fg: "var(--warn-ink, #8a4a09)",
    line: "var(--warn-line, #f3d59b)"
  },
  danger: {
    bg: "var(--danger-bg, #fce4e4)",
    fg: "var(--danger-ink, #8d1b1b)",
    line: "var(--danger-line, #f0b5b5)"
  },
  info: {
    bg: "var(--info-bg, #e4ecfa)",
    fg: "var(--info-ink, #1a3d8a)",
    line: "var(--info-line, #b3c4eb)"
  },
  neutral: {
    bg: "var(--neutral-bg, #f0eee8)",
    fg: "var(--neutral-ink, #424242)",
    line: "var(--neutral-line, #d8d4ca)"
  }
};

const SIZE_PADDING: Record<StatusBadgeSize, string> = {
  sm: "2px 8px",
  md: "4px 10px"
};

const SIZE_FS: Record<StatusBadgeSize, string> = {
  sm: "var(--fs-xs, 11px)",
  md: "var(--fs-sm, 12px)"
};

export function StatusBadge({
  variant,
  icon,
  children,
  size = "md"
}: StatusBadgeProps) {
  const palette = PALETTE[variant];
  const style: CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    background: palette.bg,
    color: palette.fg,
    border: `1px solid ${palette.line}`,
    borderRadius: "var(--radius-full, 999px)",
    padding: SIZE_PADDING[size],
    fontSize: SIZE_FS[size],
    fontWeight: 600,
    lineHeight: 1,
    whiteSpace: "nowrap",
    fontFamily: "inherit"
  };

  return (
    <span style={style}>
      {icon ? <span aria-hidden="true">{icon}</span> : null}
      <span>{children}</span>
    </span>
  );
}

export default StatusBadge;
