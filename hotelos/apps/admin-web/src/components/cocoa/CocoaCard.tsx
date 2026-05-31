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
      return {
        background: "var(--cocoa-background-content)",
        boxShadow: "var(--cocoa-shadow-control)",
        borderRadius: "var(--cocoa-radius-lg)"
      };
    case "bordered":
      return {
        background: "var(--cocoa-background-content)",
        border: "1px solid var(--cocoa-separator)",
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

  const style: CSSProperties = {
    ...getVariantStyle(variant),
    padding: PADDING_MAP[padding],
    ...(isInteractive
      ? {
          cursor: "pointer",
          transition:
            "transform var(--cocoa-duration-fast) var(--cocoa-ease-out)"
        }
      : {})
  };

  const handleMouseEnter: MouseEventHandler<HTMLDivElement> | undefined =
    isInteractive
      ? (event) => {
          event.currentTarget.style.transform = "translateY(-1px)";
        }
      : undefined;

  const handleMouseLeave: MouseEventHandler<HTMLDivElement> | undefined =
    isInteractive
      ? (event) => {
          event.currentTarget.style.transform = "translateY(0)";
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
