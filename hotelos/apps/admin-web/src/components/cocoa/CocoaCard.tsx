import type { CSSProperties, MouseEventHandler, ReactNode } from "react";

export type CocoaCardVariant = "plain" | "elevated" | "bordered";
export type CocoaCardPadding = "sm" | "md" | "lg" | "none";

export interface CocoaCardProps {
  variant?: CocoaCardVariant;
  padding?: CocoaCardPadding;
  children: ReactNode;
  onClick?: MouseEventHandler<HTMLDivElement>;
  className?: string;
}

const PADDING_MAP: Record<CocoaCardPadding, string> = {
  none: "0",
  sm: "12px",
  md: "16px",
  lg: "24px"
};

function getVariantStyle(variant: CocoaCardVariant): CSSProperties {
  switch (variant) {
    case "elevated":
      // Real canvas→card lift (was --cocoa-shadow-control, a control-sized
      // shadow that's imperceptible on a full card → the whole app read flat).
      return {
        background: "var(--cocoa-background-content)",
        boxShadow: "var(--cocoa-shadow-card)",
        borderRadius: "var(--cocoa-radius-lg)"
      };
    case "bordered":
      // Keep the hairline border but add the minimal control shadow so even
      // secondary cards detach from the canvas instead of being mere outlines.
      return {
        background: "var(--cocoa-background-content)",
        border: "1px solid var(--cocoa-separator)",
        boxShadow: "var(--cocoa-shadow-control)",
        borderRadius: "var(--cocoa-radius-lg)"
      };
    case "plain":
    default:
      return {
        background: "var(--cocoa-background-content)"
      };
  }
}

export function CocoaCard({
  variant = "plain",
  padding = "md",
  children,
  onClick,
  className
}: CocoaCardProps) {
  const isInteractive = typeof onClick === "function";

  // The shadow this variant rests at, so hover can escalate and mouse-leave can
  // restore it. Empty for plain (no shadow to manage).
  const baseShadow =
    variant === "elevated"
      ? "var(--cocoa-shadow-card)"
      : variant === "bordered"
        ? "var(--cocoa-shadow-control)"
        : "";

  const style: CSSProperties = {
    ...getVariantStyle(variant),
    padding: PADDING_MAP[padding],
    ...(isInteractive
      ? {
          cursor: "pointer",
          transition:
            "transform var(--cocoa-duration-fast) var(--cocoa-ease-out), box-shadow var(--cocoa-duration-base) var(--cocoa-ease-out)"
        }
      : {})
  };

  const handleMouseEnter: MouseEventHandler<HTMLDivElement> | undefined =
    isInteractive
      ? (event) => {
          event.currentTarget.style.transform = "translateY(-2px)";
          if (baseShadow) {
            event.currentTarget.style.boxShadow = "var(--cocoa-shadow-window)";
          }
        }
      : undefined;

  const handleMouseLeave: MouseEventHandler<HTMLDivElement> | undefined =
    isInteractive
      ? (event) => {
          event.currentTarget.style.transform = "translateY(0)";
          if (baseShadow) {
            event.currentTarget.style.boxShadow = baseShadow;
          }
        }
      : undefined;

  return (
    <div
      className={className}
      style={style}
      onClick={onClick}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      role={isInteractive ? "button" : undefined}
      tabIndex={isInteractive ? 0 : undefined}
    >
      {children}
    </div>
  );
}

export default CocoaCard;
