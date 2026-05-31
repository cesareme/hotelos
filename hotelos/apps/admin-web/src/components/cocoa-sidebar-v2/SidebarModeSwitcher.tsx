// SidebarModeSwitcher — top-of-sidebar selector for the four primary product
// "modes" the admin console exposes (PMS, ERP, Compliance, Developer).
//
// Visually this is a 4-item horizontal segmented control: a single rounded
// pill with a translucent selection highlight that slides between segments.
// We mirror the look of CocoaSegmentedControl (same tokens — radii, control
// background, inset shadow on the selected segment) but render the segments
// ourselves so each can be wrapped in a CocoaTooltip explaining the mode.
// CocoaSegmentedControl's public API only takes a flat `options` array and
// renders buttons internally, so wrapping each button in a per-option
// tooltip from the outside isn't possible without a refactor of that
// component. Re-rendering the segmented surface here, using the same Cocoa
// tokens, keeps the look in lockstep with the rest of the design system
// while letting us compose CocoaTooltip on each segment.
//
// The container background is intentionally pulled from
// `--cocoa-background-control` (the same subtle "control" surface used by
// CocoaSegmentedControl) so it reads as a chip rather than as a button row.
// Icons are required: this is an icon-+-label segmented control, intended
// to sit at the very top of the sidebar above the section list.
//
// Accessibility: the container is a `role="tablist"`, segments are
// `role="tab"` with `aria-selected`. Tooltip content is wired through
// CocoaTooltip's aria-describedby so screen readers announce the
// explanation when the segment receives focus.

import { useMemo, type CSSProperties, type ReactNode } from "react";
import { CocoaTooltip } from "../cocoa-guidance/CocoaTooltip";
import {
  BedIcon,
  ChartIcon,
  GearIcon,
  WrenchIcon,
} from "../cocoa-icons/NavigationIcons";

export type SidebarMode = "pms" | "erp" | "compliance" | "developer";

export interface SidebarModeSwitcherProps {
  /** Currently selected mode. The matching segment is highlighted. */
  currentMode: SidebarMode;
  /** Fired when the user picks a different mode. Not fired when the user
   *  clicks the already-selected segment (matches CocoaSegmentedControl). */
  onChange: (mode: SidebarMode) => void;
  /** Optional accessible label for the tablist. Defaults to a Spanish
   *  description that matches the surrounding admin UI copy. */
  "aria-label"?: string;
  /** Optional className passthrough for layout tweaks at the call site. */
  className?: string;
  /** Optional inline style passthrough — useful for spacing in the sidebar
   *  header. Style overrides container defaults via Object.assign. */
  style?: CSSProperties;
}

interface ModeDescriptor {
  value: SidebarMode;
  label: string;
  /** Short tooltip body explaining what the mode contains. Kept under
   *  ~80 chars so it reads as a tooltip and not a paragraph. */
  tooltip: string;
  Icon: (props: { size?: number; color?: string }) => ReactNode;
}

// Order matters: this is also the visual order of the segments.
const MODE_DESCRIPTORS: ReadonlyArray<ModeDescriptor> = [
  {
    value: "pms",
    label: "PMS",
    tooltip:
      "Property management: habitaciones, reservas, check-in/out y front desk.",
    Icon: BedIcon,
  },
  {
    value: "erp",
    label: "ERP",
    tooltip:
      "Operaciones internas: finanzas, cobros, nómina, compras e inventario.",
    Icon: ChartIcon,
  },
  {
    value: "compliance",
    label: "Compliance",
    tooltip:
      "Cumplimiento regulatorio: huéspedes, reportes legales y auditoría.",
    Icon: GearIcon,
  },
  {
    value: "developer",
    label: "Developer",
    tooltip:
      "Herramientas técnicas: API, webhooks, claves y apps del marketplace.",
    Icon: WrenchIcon,
  },
];

// Visual sizing — these mirror CocoaSegmentedControl's "small" preset, which
// is the right scale for a sidebar header chip. Pulled into constants so we
// can keep the styles below tidy.
const CONTAINER_PADDING = 2;
const ITEM_PADDING = "4px 10px";
const ITEM_GAP = 4;
const ICON_SIZE = 14;

export function SidebarModeSwitcher({
  currentMode,
  onChange,
  "aria-label": ariaLabel = "Cambiar de módulo",
  className,
  style,
}: SidebarModeSwitcherProps) {
  // Container — same subtle control surface as CocoaSegmentedControl, so it
  // reads as part of the same family. `display: grid` with equal-fr columns
  // ensures the four segments share width evenly regardless of label length.
  const containerStyle = useMemo<CSSProperties>(() => {
    const base: CSSProperties = {
      display: "grid",
      gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
      alignItems: "stretch",
      padding: CONTAINER_PADDING,
      background: "var(--cocoa-background-control)",
      borderRadius: "var(--cocoa-radius-md)",
      fontFamily: "var(--cocoa-font)",
      WebkitAppearance: "none",
      appearance: "none",
    };
    if (style) {
      Object.assign(base, style);
    }
    return base;
  }, [style]);

  // Selected segments use the elevated content surface + inset shadow that
  // CocoaSegmentedControl uses for its active item — that's what gives the
  // "pill slides under the active label" feel.
  const itemRadius = `calc(var(--cocoa-radius-md) - ${CONTAINER_PADDING}px)`;

  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      className={className}
      style={containerStyle}
    >
      {MODE_DESCRIPTORS.map((descriptor) => {
        const isActive = descriptor.value === currentMode;

        const itemStyle: CSSProperties = {
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          gap: ITEM_GAP,
          padding: ITEM_PADDING,
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
          fontSize: "var(--cocoa-fs-subheadline)",
          // Cast through unknown — these tokens resolve to numeric weights at
          // runtime via CSS custom properties; TS narrows fontWeight too far.
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
            "background var(--cocoa-duration-base) var(--cocoa-ease-out), color var(--cocoa-duration-base) var(--cocoa-ease-out), box-shadow var(--cocoa-duration-base) var(--cocoa-ease-out)",
        };

        const handleClick = () => {
          // Clicking the already-active segment is a no-op — matches the
          // CocoaSegmentedControl contract callers will be used to.
          if (isActive) return;
          onChange(descriptor.value);
        };

        const { Icon } = descriptor;

        // Tooltip placement: bottom, because the switcher sits at the top of
        // the sidebar — a "top" tooltip would clip against the window chrome.
        // Delay is left at the CocoaTooltip default (500ms) so quick hover
        // flickers between segments don't pop tooltips on every flicker.
        return (
          <CocoaTooltip
            key={descriptor.value}
            content={descriptor.tooltip}
            placement="bottom"
          >
            <button
              type="button"
              role="tab"
              aria-selected={isActive}
              tabIndex={isActive ? 0 : -1}
              className="cocoa-focus-ring"
              style={itemStyle}
              onClick={handleClick}
            >
              <span
                aria-hidden="true"
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  width: ICON_SIZE,
                  height: ICON_SIZE,
                  flexShrink: 0,
                }}
              >
                <Icon size={ICON_SIZE} color="currentColor" />
              </span>
              <span>{descriptor.label}</span>
            </button>
          </CocoaTooltip>
        );
      })}
    </div>
  );
}

export default SidebarModeSwitcher;
