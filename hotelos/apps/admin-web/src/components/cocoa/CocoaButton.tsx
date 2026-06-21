import {
  useMemo,
  type CSSProperties,
  type MouseEventHandler,
  type ReactNode
} from "react";

export type CocoaButtonVariant = "filled" | "tinted" | "bordered" | "plain";
export type CocoaButtonSize = "small" | "regular" | "large";
export type CocoaButtonTone = "accent" | "neutral" | "destructive";

export interface CocoaButtonProps {
  variant?: CocoaButtonVariant;
  size?: CocoaButtonSize;
  tone?: CocoaButtonTone;
  icon?: ReactNode;
  iconPosition?: "left" | "right";
  loading?: boolean;
  disabled?: boolean;
  onClick?: MouseEventHandler<HTMLButtonElement>;
  children?: ReactNode;
  type?: "button" | "submit";
  className?: string;
  style?: CSSProperties;
  "aria-label"?: string;
}

const HEIGHT_BY_SIZE: Record<CocoaButtonSize, number> = {
  small: 22,
  regular: 28,
  large: 32
};

const PADDING_X_BY_SIZE: Record<CocoaButtonSize, number> = {
  small: 8,
  regular: 12,
  large: 16
};

const FONT_SIZE_BY_SIZE: Record<CocoaButtonSize, string> = {
  small: "var(--cocoa-fs-subheadline)",
  regular: "var(--cocoa-fs-body)",
  large: "var(--cocoa-fs-title-3)"
};

const ICON_SIZE_BY_SIZE: Record<CocoaButtonSize, number> = {
  small: 12,
  regular: 14,
  large: 16
};

const GAP_BY_SIZE: Record<CocoaButtonSize, number> = {
  small: 4,
  regular: 6,
  large: 8
};

interface ToneVars {
  accent: string;
  accentHover: string;
  accentPressed: string;
  accentContrast: string;
  tintedBg: string;
}

const TONE_VARS: Record<CocoaButtonTone, ToneVars> = {
  accent: {
    accent: "var(--cocoa-accent)",
    accentHover: "var(--cocoa-accent-hover)",
    accentPressed: "var(--cocoa-accent-pressed)",
    accentContrast: "var(--cocoa-accent-contrast)",
    // Audit 2026-06 · #5: tint now derives from --cocoa-accent (#0064E1), not a
    // second blue (#007AFF), so filled and tinted share the exact accent hue.
    tintedBg: "var(--cocoa-accent-bg)"
  },
  neutral: {
    accent: "var(--cocoa-label)",
    accentHover: "var(--cocoa-label)",
    accentPressed: "var(--cocoa-label)",
    accentContrast: "var(--cocoa-label)",
    // Audit 2026-06 · #6: dark-safe — derives from --cocoa-label so it stays
    // visible on #1E1E1E (the literal rgba(0,0,0,…) was invisible in dark).
    tintedBg: "color-mix(in srgb, var(--cocoa-label) 8%, transparent)"
  },
  destructive: {
    accent: "var(--cocoa-danger)",
    accentHover: "var(--cocoa-danger)",
    accentPressed: "var(--cocoa-danger)",
    accentContrast: "#FFFFFF",
    tintedBg: "var(--cocoa-danger-bg)"
  }
};

function Spinner({ size, color }: { size: number; color: string }) {
  const stroke = Math.max(1.5, Math.round(size / 8));
  return (
    <span
      aria-hidden="true"
      style={{
        display: "inline-block",
        width: size,
        height: size,
        borderRadius: "50%",
        border: `${stroke}px solid currentColor`,
        borderTopColor: "transparent",
        opacity: 0.85,
        color,
        animation: "cocoa-spinner-rotate 0.7s linear infinite",
        boxSizing: "border-box"
      }}
    />
  );
}

export function CocoaButton({
  variant = "filled",
  size = "regular",
  tone = "accent",
  icon,
  iconPosition = "left",
  loading = false,
  disabled = false,
  onClick,
  children,
  type = "button",
  className,
  style,
  "aria-label": ariaLabel
}: CocoaButtonProps) {
  const isDisabled = disabled || loading;
  const height = HEIGHT_BY_SIZE[size];
  const paddingX = PADDING_X_BY_SIZE[size];
  const fontSize = FONT_SIZE_BY_SIZE[size];
  const iconSize = ICON_SIZE_BY_SIZE[size];
  const gap = GAP_BY_SIZE[size];
  const radius =
    size === "small" ? "var(--cocoa-radius-sm)" : "var(--cocoa-radius-md)";

  const toneVars = TONE_VARS[tone];

  const styles = useMemo<CSSProperties>(() => {
    const base: CSSProperties = {
      position: "relative",
      display: "inline-flex",
      alignItems: "center",
      justifyContent: "center",
      gap,
      height,
      minHeight: height,
      paddingInline: paddingX,
      paddingBlock: 0,
      borderRadius: radius,
      fontFamily: "var(--cocoa-font)",
      fontSize,
      fontWeight: "var(--cocoa-fw-medium)" as unknown as number,
      letterSpacing: "var(--cocoa-tracking-tight)",
      lineHeight: 1,
      whiteSpace: "nowrap",
      cursor: isDisabled ? "not-allowed" : "pointer",
      opacity: isDisabled ? 0.4 : 1,
      transition: `background-color var(--cocoa-duration-fast) var(--cocoa-ease-out), color var(--cocoa-duration-fast) var(--cocoa-ease-out), border-color var(--cocoa-duration-fast) var(--cocoa-ease-out), box-shadow var(--cocoa-duration-fast) var(--cocoa-ease-out), filter var(--cocoa-duration-fast) var(--cocoa-ease-out), transform var(--cocoa-duration-fast) var(--cocoa-ease-out)`,
      border: "1px solid transparent",
      userSelect: "none",
      WebkitAppearance: "none",
      appearance: "none"
    };

    if (variant === "filled" && tone === "accent") {
      base.background = toneVars.accent;
      base.color = toneVars.accentContrast;
      base.borderColor = "transparent";
    } else if (variant === "filled" && tone === "destructive") {
      base.background = toneVars.accent;
      base.color = toneVars.accentContrast;
      base.borderColor = "transparent";
    } else if (variant === "filled" && tone === "neutral") {
      base.background = "var(--cocoa-background-control)";
      base.color = "var(--cocoa-label)";
      base.borderColor = "var(--cocoa-separator)";
      base.boxShadow = "var(--cocoa-shadow-control)";
    } else if (variant === "tinted") {
      base.background = toneVars.tintedBg;
      base.color = toneVars.accent;
      base.borderColor = "transparent";
    } else if (variant === "bordered") {
      base.background = "transparent";
      base.color = tone === "neutral" ? "var(--cocoa-label)" : toneVars.accent;
      base.borderColor = "var(--cocoa-separator)";
    } else if (variant === "plain") {
      base.background = "transparent";
      base.color = tone === "neutral" ? "var(--cocoa-label)" : toneVars.accent;
      base.borderColor = "transparent";
    }

    if (style) {
      Object.assign(base, style);
    }

    return base;
  }, [
    variant,
    tone,
    toneVars,
    height,
    paddingX,
    radius,
    fontSize,
    gap,
    isDisabled,
    style
  ]);

  const handleMouseEnter = (event: React.MouseEvent<HTMLButtonElement>) => {
    if (isDisabled) return;
    const target = event.currentTarget;
    if (variant === "filled") {
      target.style.filter = "brightness(0.95)";
    } else if (variant === "bordered" || variant === "plain") {
      target.style.backgroundColor = "var(--cocoa-background-control)";
    } else if (variant === "tinted") {
      target.style.filter = "brightness(0.97)";
    }
  };

  const handleMouseLeave = (event: React.MouseEvent<HTMLButtonElement>) => {
    if (isDisabled) return;
    const target = event.currentTarget;
    target.style.filter = "";
    if (variant === "bordered" || variant === "plain") {
      target.style.backgroundColor = "transparent";
    }
    target.style.transform = "";
  };

  const handleMouseDown = (event: React.MouseEvent<HTMLButtonElement>) => {
    if (isDisabled) return;
    const target = event.currentTarget;
    if (variant === "filled" || variant === "tinted") {
      target.style.filter = "brightness(0.85)";
    } else {
      target.style.transform = "scale(0.98)";
    }
  };

  const handleMouseUp = (event: React.MouseEvent<HTMLButtonElement>) => {
    if (isDisabled) return;
    const target = event.currentTarget;
    if (variant === "filled" || variant === "tinted") {
      target.style.filter = "brightness(0.95)";
    } else {
      target.style.transform = "";
    }
  };

  const iconNode = icon ? (
    <span
      aria-hidden="true"
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: iconSize,
        height: iconSize,
        flexShrink: 0
      }}
    >
      {icon}
    </span>
  ) : null;

  const spinnerColor =
    variant === "filled" && (tone === "accent" || tone === "destructive")
      ? toneVars.accentContrast
      : toneVars.accent;

  const composedClassName = ["cocoa-focus-ring", className]
    .filter(Boolean)
    .join(" ");

  return (
    <button
      type={type}
      className={composedClassName}
      style={styles}
      disabled={isDisabled}
      aria-busy={loading || undefined}
      aria-disabled={isDisabled || undefined}
      aria-label={ariaLabel}
      onClick={onClick}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      onMouseDown={handleMouseDown}
      onMouseUp={handleMouseUp}
    >
      <style>{`@keyframes cocoa-spinner-rotate { to { transform: rotate(360deg); } }`}</style>
      {loading ? <Spinner size={iconSize} color={spinnerColor} /> : null}
      {!loading && iconNode && iconPosition === "left" ? iconNode : null}
      {children != null ? <span>{children}</span> : null}
      {!loading && iconNode && iconPosition === "right" ? iconNode : null}
    </button>
  );
}

export default CocoaButton;
