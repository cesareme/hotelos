// CocoaButton — the only button of the back office (COCOA-22.md §7: raw
// <button> → CocoaButton filled/tinted/bordered/plain × accent/neutral/
// destructive × small/regular/large).
//
//   - Heights 22 / 28 / 32 on a mouse; ≥ 44 px tap target on a coarse pointer.
//   - Radius 4 (small) / 8; Inter 500; transitions of 100 ms; press scale 0.97
//     gated on reduced motion; hover brightens filled, deepens tinted, fills
//     ghosts with the control background.
//   - Focus: the shared `.cocoa-focus-ring` (single Esmeralda ring).
//   - Text colour of tinted/bordered/plain: the AA-safe tone INK
//     (`--cocoa-tone-accent-text` = accent-strong 6.55:1, `--cocoa-tone-
//     danger-text`), never the hue (accent 4.36:1 at 11–13 px, §2.1); the hue
//     is only used for filled backgrounds.
//   - `loading` shows the spinner (keyframes in styles/cocoa-base.css) and
//     sets aria-busy; icon-only buttons MUST pass `aria-label`.
//   - React 19: `ref` is a plain prop (dialogs use it for the initial focus).

import { useMemo, type CSSProperties, type FocusEventHandler, type KeyboardEventHandler, type MouseEventHandler, type ReactNode, type Ref } from "react";
import { useCoarsePointer, TAP_TARGET_PX } from "../../lib/useCoarsePointer";

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
  onFocus?: FocusEventHandler<HTMLButtonElement>;
  onBlur?: FocusEventHandler<HTMLButtonElement>;
  onKeyDown?: KeyboardEventHandler<HTMLButtonElement>;
  children?: ReactNode;
  type?: "button" | "submit";
  className?: string;
  /** Layout escape hatch (width, flex); colours come from `variant`/`tone`. */
  style?: CSSProperties;
  id?: string;
  name?: string;
  form?: string;
  tabIndex?: number;
  autoFocus?: boolean;
  ref?: Ref<HTMLButtonElement>;
  /** Accessible name; REQUIRED for icon-only buttons. */
  "aria-label"?: string;
  "aria-describedby"?: string;
  "aria-expanded"?: boolean;
  "aria-pressed"?: boolean;
  "aria-controls"?: string;
  "aria-haspopup"?: boolean | "menu" | "dialog" | "listbox";
  "aria-current"?: boolean | "page" | "step";
  /** Native tooltip (callers used to wrap the button in <span title>). */
  title?: string;
  "data-cocoa"?: string;
  /** Passthroughs for the shell (guided tour anchors, test hooks) and for menu/listbox rows. */
  "data-tour"?: string;
  "data-testid"?: string;
  role?: "menuitem" | "option" | "tab" | "switch" | "link";
  "aria-selected"?: boolean;
}

const HEIGHT_BY_SIZE: Record<CocoaButtonSize, number> = { small: 22, regular: 28, large: 32 };
const PADDING_X_BY_SIZE: Record<CocoaButtonSize, number> = { small: 8, regular: 12, large: 16 };
const FONT_SIZE_BY_SIZE: Record<CocoaButtonSize, string> = {
  small: "var(--cocoa-fs-subheadline)",
  regular: "var(--cocoa-fs-body)",
  large: "var(--cocoa-fs-title-3)"
};
const ICON_SIZE_BY_SIZE: Record<CocoaButtonSize, number> = { small: 12, regular: 14, large: 16 };
const GAP_BY_SIZE: Record<CocoaButtonSize, number> = { small: 4, regular: 6, large: 8 };

interface ToneVars {
  /** Hue: filled background. */
  accent: string;
  /** Ink ON the filled hue. */
  accentContrast: string;
  /** AA-safe text colour of the ghost variants (tinted / bordered / plain). */
  text: string;
  tintedBg: string;
}

const TONE_VARS: Record<CocoaButtonTone, ToneVars> = {
  accent: {
    accent: "var(--cocoa-accent)",
    accentContrast: "var(--cocoa-accent-contrast)",
    text: "var(--cocoa-tone-accent-text)",
    tintedBg: "var(--cocoa-accent-bg)"
  },
  neutral: {
    accent: "var(--cocoa-label)",
    accentContrast: "var(--cocoa-label)",
    text: "var(--cocoa-label)",
    // Dark-safe: derives from --cocoa-label so it stays visible on #1E1E1E.
    tintedBg: "color-mix(in srgb, var(--cocoa-label) 8%, transparent)"
  },
  destructive: {
    accent: "var(--cocoa-danger)",
    // Same ink as the accent button: white in light, deep ink in dark (≥ 3.5:1 on the danger hue in both).
    accentContrast: "var(--cocoa-accent-contrast)",
    text: "var(--cocoa-tone-danger-text)",
    tintedBg: "var(--cocoa-danger-bg)"
  }
};

// The CSS transition collapses its DURATION under reduced motion, but an
// inline transform would still snap: gate it here.
function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

function Spinner({ size, color }: { size: number; color: string }) {
  const stroke = Math.max(1.5, Math.round(size / 8));
  return (
    <span
      aria-hidden="true"
      style={{
        display: "inline-block",
        width: size,
        height: size,
        borderRadius: "var(--cocoa-radius-full)",
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

/** Text colour of a variant/tone pair (exported for the action bar's status text and tests): filled → ink on the hue; ghosts → AA tone ink. */
export function buttonForeground(variant: CocoaButtonVariant, tone: CocoaButtonTone): string {
  const vars = TONE_VARS[tone];
  if (variant === "filled") return tone === "neutral" ? "var(--cocoa-label)" : vars.accentContrast;
  return vars.text;
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
  onFocus,
  onBlur,
  onKeyDown,
  children,
  type = "button",
  className,
  style,
  id,
  name,
  form,
  tabIndex,
  autoFocus,
  ref,
  "aria-label": ariaLabel,
  "aria-describedby": ariaDescribedBy,
  "aria-expanded": ariaExpanded,
  "aria-pressed": ariaPressed,
  "aria-controls": ariaControls,
  "aria-haspopup": ariaHasPopup,
  "aria-current": ariaCurrent,
  title,
  "data-cocoa": dataCocoa = "button",
  "data-tour": dataTour,
  "data-testid": dataTestId,
  role,
  "aria-selected": ariaSelected
}: CocoaButtonProps) {
  const isDisabled = disabled || loading;
  const coarse = useCoarsePointer();
  const height = HEIGHT_BY_SIZE[size];
  const paddingX = PADDING_X_BY_SIZE[size];
  const fontSize = FONT_SIZE_BY_SIZE[size];
  const iconSize = ICON_SIZE_BY_SIZE[size];
  const gap = GAP_BY_SIZE[size];
  const radius = size === "small" ? "var(--cocoa-radius-sm)" : "var(--cocoa-radius-md)";
  const toneVars = TONE_VARS[tone];

  const styles = useMemo<CSSProperties>(() => {
    const base: CSSProperties = {
      position: "relative",
      display: "inline-flex",
      alignItems: "center",
      justifyContent: "center",
      gap,
      height,
      // Touch: grow to a ≥ 44 px tap target; minHeight/minWidth win over `height`.
      minHeight: coarse ? TAP_TARGET_PX : height,
      minWidth: coarse ? TAP_TARGET_PX : undefined,
      paddingInline: paddingX,
      paddingBlock: 0,
      borderRadius: radius,
      fontFamily: "var(--cocoa-font)",
      fontSize,
      fontWeight: "var(--cocoa-fw-medium)" as CSSProperties["fontWeight"],
      letterSpacing: "var(--cocoa-tracking-tight)",
      lineHeight: 1,
      whiteSpace: "nowrap",
      cursor: isDisabled ? "not-allowed" : "pointer",
      opacity: isDisabled ? 0.4 : 1,
      transition: `background-color var(--cocoa-duration-fast) var(--cocoa-ease-out), color var(--cocoa-duration-fast) var(--cocoa-ease-out), border-color var(--cocoa-duration-fast) var(--cocoa-ease-out), box-shadow var(--cocoa-duration-fast) var(--cocoa-ease-out), filter var(--cocoa-duration-fast) var(--cocoa-ease-out), transform var(--cocoa-duration-fast) var(--cocoa-ease-out)`,
      border: "1px solid transparent",
      userSelect: "none",
      WebkitAppearance: "none",
      appearance: "none",
      boxSizing: "border-box"
    };

    if (variant === "filled" && (tone === "accent" || tone === "destructive")) {
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
      base.color = toneVars.text;
      base.borderColor = "transparent";
    } else if (variant === "bordered") {
      base.background = "transparent";
      base.color = toneVars.text;
      base.borderColor = "var(--cocoa-separator)";
    } else if (variant === "plain") {
      base.background = "transparent";
      base.color = toneVars.text;
      base.borderColor = "transparent";
    }

    if (style) Object.assign(base, style);
    return base;
  }, [variant, tone, toneVars, height, paddingX, radius, fontSize, gap, isDisabled, coarse, style]);

  // Hover: filled brightens (light moves toward the cursor), tinted deepens
  // slightly, ghost variants gain a control fill.
  const applyHover = (target: HTMLButtonElement) => {
    if (variant === "filled") target.style.filter = "brightness(1.04)";
    else if (variant === "tinted") target.style.filter = "brightness(0.97)";
    else target.style.backgroundColor = "var(--cocoa-background-control)";
  };

  const handleMouseEnter = (event: React.MouseEvent<HTMLButtonElement>) => {
    if (isDisabled) return;
    applyHover(event.currentTarget);
  };

  const handleMouseLeave = (event: React.MouseEvent<HTMLButtonElement>) => {
    if (isDisabled) return;
    const target = event.currentTarget;
    target.style.filter = "";
    target.style.transform = "";
    if (variant === "bordered" || variant === "plain") target.style.backgroundColor = "transparent";
  };

  // Press: compositor-only scale on every variant, gated on reduced motion.
  const handleMouseDown = (event: React.MouseEvent<HTMLButtonElement>) => {
    if (isDisabled || prefersReducedMotion()) return;
    event.currentTarget.style.transform = "scale(0.97)";
  };

  const handleMouseUp = (event: React.MouseEvent<HTMLButtonElement>) => {
    if (isDisabled) return;
    const target = event.currentTarget;
    target.style.transform = "";
    applyHover(target); // cursor is still over the button
  };

  const iconNode = icon ? (
    <span
      aria-hidden="true"
      style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: iconSize, height: iconSize, flexShrink: 0 }}
    >
      {icon}
    </span>
  ) : null;

  const spinnerColor = buttonForeground(variant, tone);
  const composedClassName = ["cocoa-focus-ring", className].filter(Boolean).join(" ");

  return (
    <button
      ref={ref}
      id={id}
      name={name}
      form={form}
      type={type}
      className={composedClassName}
      style={styles}
      disabled={isDisabled}
      tabIndex={tabIndex}
      autoFocus={autoFocus}
      aria-busy={loading || undefined}
      aria-disabled={isDisabled || undefined}
      aria-label={ariaLabel}
      aria-describedby={ariaDescribedBy}
      aria-expanded={ariaExpanded}
      aria-pressed={ariaPressed}
      aria-controls={ariaControls}
      aria-haspopup={ariaHasPopup}
      aria-current={ariaCurrent}
      aria-selected={ariaSelected}
      role={role}
      title={title}
      data-cocoa={dataCocoa}
      data-tour={dataTour}
      data-testid={dataTestId}
      data-variant={variant}
      data-tone={tone}
      data-size={size}
      onClick={onClick}
      onFocus={onFocus}
      onBlur={onBlur}
      onKeyDown={onKeyDown}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      onMouseDown={handleMouseDown}
      onMouseUp={handleMouseUp}
    >
      {loading ? <Spinner size={iconSize} color={spinnerColor} /> : null}
      {!loading && iconNode && iconPosition === "left" ? iconNode : null}
      {children != null ? <span>{children}</span> : null}
      {!loading && iconNode && iconPosition === "right" ? iconNode : null}
    </button>
  );
}

export default CocoaButton;
