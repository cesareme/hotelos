import {
  useMemo,
  type CSSProperties,
  type ReactNode
} from "react";

export type CocoaSegmentedControlSize = "small" | "regular";

export interface CocoaSegmentedControlOption {
  value: string;
  label: string;
  icon?: ReactNode;
}

export interface CocoaSegmentedControlProps {
  value: string;
  onChange: (value: string) => void;
  options: Array<CocoaSegmentedControlOption>;
  size?: CocoaSegmentedControlSize;
  className?: string;
  style?: CSSProperties;
  "aria-label"?: string;
}

const ITEM_PADDING_BY_SIZE: Record<CocoaSegmentedControlSize, string> = {
  small: "4px 12px",
  regular: "6px 16px"
};

const FONT_SIZE_BY_SIZE: Record<CocoaSegmentedControlSize, string> = {
  small: "var(--cocoa-fs-subheadline)",
  regular: "var(--cocoa-fs-body)"
};

const ICON_SIZE_BY_SIZE: Record<CocoaSegmentedControlSize, number> = {
  small: 12,
  regular: 14
};

const ITEM_GAP_BY_SIZE: Record<CocoaSegmentedControlSize, number> = {
  small: 4,
  regular: 6
};

export function CocoaSegmentedControl({
  value,
  onChange,
  options,
  size = "regular",
  className,
  style,
  "aria-label": ariaLabel
}: CocoaSegmentedControlProps) {
  const itemPadding = ITEM_PADDING_BY_SIZE[size];
  const fontSize = FONT_SIZE_BY_SIZE[size];
  const iconSize = ICON_SIZE_BY_SIZE[size];
  const itemGap = ITEM_GAP_BY_SIZE[size];

  const containerStyle = useMemo<CSSProperties>(() => {
    const base: CSSProperties = {
      display: "flex",
      alignItems: "stretch",
      padding: 2,
      background: "var(--cocoa-background-control)",
      borderRadius: "var(--cocoa-radius-md)",
      fontFamily: "var(--cocoa-font)",
      WebkitAppearance: "none",
      appearance: "none"
    };
    if (style) {
      Object.assign(base, style);
    }
    return base;
  }, [style]);

  const itemRadius = "calc(var(--cocoa-radius-md) - 2px)";

  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      className={className}
      style={containerStyle}
    >
      {options.map((opt) => {
        const isActive = opt.value === value;

        const itemStyle: CSSProperties = {
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          gap: itemGap,
          padding: itemPadding,
          borderRadius: itemRadius,
          border: "1px solid transparent",
          background: isActive
            ? "var(--cocoa-background-content)"
            : "transparent",
          boxShadow: isActive ? "inset var(--cocoa-shadow-control)" : "none",
          color: isActive
            ? "var(--cocoa-label)"
            : "var(--cocoa-label-secondary)",
          fontFamily: "inherit",
          fontSize,
          fontWeight: isActive
            ? ("var(--cocoa-fw-semibold)" as unknown as number)
            : ("var(--cocoa-fw-medium)" as unknown as number),
          letterSpacing: "var(--cocoa-tracking-tight)",
          lineHeight: 1,
          whiteSpace: "nowrap",
          cursor: isActive ? "default" : "pointer",
          userSelect: "none",
          WebkitAppearance: "none",
          appearance: "none",
          transition:
            "background var(--cocoa-duration-base) var(--cocoa-ease-out), color var(--cocoa-duration-base) var(--cocoa-ease-out), box-shadow var(--cocoa-duration-base) var(--cocoa-ease-out)"
        };

        const handleClick = () => {
          if (isActive) return;
          onChange(opt.value);
        };

        const iconNode = opt.icon ? (
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
            {opt.icon}
          </span>
        ) : null;

        return (
          <button
            key={opt.value}
            type="button"
            role="tab"
            aria-selected={isActive}
            tabIndex={isActive ? 0 : -1}
            className="cocoa-focus-ring"
            style={itemStyle}
            onClick={handleClick}
          >
            {iconNode}
            <span>{opt.label}</span>
          </button>
        );
      })}
    </div>
  );
}

export default CocoaSegmentedControl;
