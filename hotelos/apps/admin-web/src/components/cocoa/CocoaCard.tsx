// CocoaCard — the surface every Cocoa 22 card, KPI tile and section sits on
// (COCOA-22.md §3.5).
//
//   - `bordered` (default content card): content bg · 1 px separator · control
//     shadow · radius 12.
//   - `elevated`: content bg · --cocoa-shadow-card (ring + ambient + soft cast)
//     · radius 12. The canonical "lifted" card; hover → window shadow −2 px
//     when interactive.
//   - `plain`: content bg · radius 12 · no border, no shadow (Cocoa 22 gives it
//     the radius the canon lacked: the KPI tiles were painted as sharp white
//     rectangles on the canvas).
//
// Interactive cards (`onClick`) are real buttons for AT: role=button, tabIndex,
// Enter/Space activate (they dispatch a native click so `onClick` runs once).

import {
  useCallback,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEventHandler,
  type ReactNode
} from "react";

export type CocoaCardVariant = "plain" | "elevated" | "bordered";
export type CocoaCardPadding = "sm" | "md" | "lg" | "none";

export interface CocoaCardProps {
  variant?: CocoaCardVariant;
  padding?: CocoaCardPadding;
  children: ReactNode;
  onClick?: MouseEventHandler<HTMLDivElement>;
  className?: string;
  /** Layout escape hatch (min-height, grid placement, overflow); never colours. */
  style?: CSSProperties;
  /** ARIA role for non-interactive cards (`group`, `region`); interactive cards are always `button`. */
  role?: string;
  id?: string;
  "aria-label"?: string;
  "aria-labelledby"?: string;
  "aria-describedby"?: string;
  /** Toggle state of a selectable interactive card (room tile, filter card): the drawer being open is not a state a screen reader hears. */
  "aria-pressed"?: boolean;
  /** Contract marker; primitives built on the card override it (`kpi`, `section`). */
  "data-cocoa"?: string;
}

// `md` follows the page density (`--cocoa-density-card-padding`: 16 comfortable ·
// 12 compact, resolved by cocoa-tokens.css from `data-cocoa-density`).
const PADDING_MAP: Record<CocoaCardPadding, string> = {
  none: "0",
  sm: "var(--cocoa-space-3)",
  md: "var(--cocoa-density-card-padding, var(--cocoa-space-4))",
  lg: "var(--cocoa-space-5)"
};

function getVariantStyle(variant: CocoaCardVariant): CSSProperties {
  switch (variant) {
    case "elevated":
      return {
        background: "var(--cocoa-background-content)",
        boxShadow: "var(--cocoa-shadow-card)",
        borderRadius: "var(--cocoa-radius-lg)"
      };
    case "bordered":
      return {
        background: "var(--cocoa-background-content)",
        border: "1px solid var(--cocoa-separator)",
        boxShadow: "var(--cocoa-shadow-control)",
        borderRadius: "var(--cocoa-radius-lg)"
      };
    case "plain":
    default:
      return {
        background: "var(--cocoa-background-content)",
        borderRadius: "var(--cocoa-radius-lg)"
      };
  }
}

/** Resting shadow of a variant (what hover escalates from and mouse-leave restores). */
export function cardRestingShadow(variant: CocoaCardVariant): string {
  if (variant === "elevated") return "var(--cocoa-shadow-card)";
  if (variant === "bordered") return "var(--cocoa-shadow-control)";
  return "";
}

export function CocoaCard({
  variant = "plain",
  padding = "md",
  children,
  onClick,
  className,
  style,
  role,
  id,
  "aria-label": ariaLabel,
  "aria-labelledby": ariaLabelledBy,
  "aria-describedby": ariaDescribedBy,
  "aria-pressed": ariaPressed,
  "data-cocoa": dataCocoa = "card"
}: CocoaCardProps) {
  const isInteractive = typeof onClick === "function";
  const baseShadow = cardRestingShadow(variant);

  const merged: CSSProperties = {
    ...getVariantStyle(variant),
    padding: PADDING_MAP[padding],
    boxSizing: "border-box",
    minWidth: 0,
    fontFamily: "var(--cocoa-font)",
    color: "var(--cocoa-label)",
    ...(isInteractive
      ? {
          cursor: "pointer",
          transition:
            "transform var(--cocoa-duration-fast) var(--cocoa-ease-out), box-shadow var(--cocoa-duration-base) var(--cocoa-ease-out)"
        }
      : {}),
    ...style
  };

  const handleMouseEnter: MouseEventHandler<HTMLDivElement> | undefined = isInteractive
    ? (event) => {
        event.currentTarget.style.transform = "translateY(-2px)";
        if (baseShadow) event.currentTarget.style.boxShadow = "var(--cocoa-shadow-window)";
      }
    : undefined;

  const handleMouseLeave: MouseEventHandler<HTMLDivElement> | undefined = isInteractive
    ? (event) => {
        event.currentTarget.style.transform = "translateY(0)";
        if (baseShadow) event.currentTarget.style.boxShadow = baseShadow;
      }
    : undefined;

  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (!isInteractive) return;
      if (event.target !== event.currentTarget) return; // inner controls keep their keys
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        event.currentTarget.click();
      }
    },
    [isInteractive]
  );

  const composedClassName = [isInteractive ? "cocoa-focus-ring" : null, "cocoa-card", className].filter(Boolean).join(" ");

  return (
    <div
      id={id}
      className={composedClassName}
      style={merged}
      onClick={onClick}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      onKeyDown={isInteractive ? handleKeyDown : undefined}
      role={isInteractive ? "button" : role}
      tabIndex={isInteractive ? 0 : undefined}
      aria-label={ariaLabel}
      aria-labelledby={ariaLabelledBy}
      aria-describedby={ariaDescribedBy}
      aria-pressed={isInteractive ? ariaPressed : undefined}
      data-cocoa={dataCocoa}
      data-variant={variant}
      data-padding={padding}
    >
      {children}
    </div>
  );
}

export default CocoaCard;
