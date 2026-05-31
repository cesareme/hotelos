import { useState, type CSSProperties } from "react";

export type AvatarSize = "sm" | "md" | "lg";

export interface AvatarProps {
  name: string;
  image?: string;
  size?: AvatarSize;
  ariaLabel?: string;
}

const SIZE_PX: Record<AvatarSize, number> = {
  sm: 24,
  md: 32,
  lg: 44
};

const SIZE_FS: Record<AvatarSize, string> = {
  sm: "var(--fs-xs, 11px)",
  md: "var(--fs-sm, 12px)",
  lg: "var(--fs-md, 15px)"
};

// Deterministic palette — picked from Aurora status tones so they harmonize.
const PALETTE: Array<{ bg: string; fg: string }> = [
  { bg: "var(--accent-soft, #e6f4ef)", fg: "var(--accent-strong, #086b48)" },
  { bg: "var(--info-bg, #e4ecfa)", fg: "var(--info-ink, #1a3d8a)" },
  { bg: "var(--warn-bg, #fdf2dc)", fg: "var(--warn-ink, #8a4a09)" },
  { bg: "var(--danger-bg, #fce4e4)", fg: "var(--danger-ink, #8d1b1b)" },
  { bg: "var(--ok-bg, #e3f4eb)", fg: "var(--ok-ink, #0a6b46)" },
  { bg: "var(--ai-soft, #efeaff)", fg: "var(--ai, #6d4ed1)" },
  { bg: "var(--neutral-bg, #f0eee8)", fg: "var(--neutral-ink, #424242)" }
];

function hashString(input: string): number {
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    hash = (hash * 31 + input.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

export function getInitials(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return "?";
  const parts = trimmed.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) {
    return parts[0].slice(0, 2).toUpperCase();
  }
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

export function Avatar({ name, image, size = "md", ariaLabel }: AvatarProps) {
  const [imgFailed, setImgFailed] = useState(false);
  const px = SIZE_PX[size];
  const initials = getInitials(name);
  const palette = PALETTE[hashString(name) % PALETTE.length];

  const containerStyle: CSSProperties = {
    width: px,
    height: px,
    borderRadius: "var(--radius-full, 999px)",
    background: palette.bg,
    color: palette.fg,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    fontWeight: 600,
    fontSize: SIZE_FS[size],
    flexShrink: 0,
    overflow: "hidden",
    border: "1px solid var(--line-soft, #f1ede5)",
    userSelect: "none",
    fontFamily: "inherit"
  };

  const imgStyle: CSSProperties = {
    width: "100%",
    height: "100%",
    objectFit: "cover",
    display: "block"
  };

  const showImage = !!image && !imgFailed;

  return (
    <span
      role="img"
      aria-label={ariaLabel ?? name}
      title={name}
      style={containerStyle}
    >
      {showImage ? (
        <img
          src={image}
          alt=""
          style={imgStyle}
          onError={() => setImgFailed(true)}
        />
      ) : (
        <span aria-hidden="true">{initials}</span>
      )}
    </span>
  );
}

export default Avatar;
