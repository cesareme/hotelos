// CocoaThemeToggle — Cocoa-styled theme picker (light / dark / auto).
//
// Renders a small button that displays the current theme as an inline SVG icon
// (sun=light, moon=dark, monitor=auto). Clicking the button opens a
// CocoaPopover with three radio options. Selecting an option applies the
// chosen theme to <html data-theme=...> (auto -> empty attr so the OS-level
// media query in styles/cocoa-tokens.css takes over) and notifies the caller
// via onChange so they can persist the preference to the backend.
//
// The button itself is styled to match the other cocoa-global widgets:
// rounded square hit target, control background, separator border, and the
// shared focus ring class so keyboard users get a visible halo.

import {
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import CocoaPopover from "../cocoa/CocoaPopover";

export type CocoaThemeValue = "light" | "dark" | "auto";

export interface CocoaThemeToggleProps {
  value: CocoaThemeValue;
  onChange: (value: CocoaThemeValue) => void;
  size?: "small" | "regular";
}

interface SizeMetrics {
  button: number;
  icon: number;
  optionIcon: number;
  optionFontSize: string;
  optionLineHeight: string;
  optionPadY: number;
  optionPadX: number;
  optionGap: number;
}

const SIZE_METRICS: Record<NonNullable<CocoaThemeToggleProps["size"]>, SizeMetrics> = {
  small: {
    button: 22,
    icon: 12,
    optionIcon: 14,
    optionFontSize: "var(--cocoa-fs-subheadline)",
    optionLineHeight: "var(--cocoa-lh-subheadline)",
    optionPadY: 4,
    optionPadX: 8,
    optionGap: 6,
  },
  regular: {
    button: 28,
    icon: 16,
    optionIcon: 16,
    optionFontSize: "var(--cocoa-fs-body)",
    optionLineHeight: "var(--cocoa-lh-body)",
    optionPadY: 6,
    optionPadX: 10,
    optionGap: 8,
  },
};

const OPTION_LABELS: Record<CocoaThemeValue, string> = {
  light: "Claro",
  dark: "Oscuro",
  auto: "Automatico",
};

function SunIcon({ size }: { size: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
    >
      <circle
        cx="8"
        cy="8"
        r="3"
        stroke="currentColor"
        strokeWidth="1.5"
      />
      <path
        d="M8 1.5v1.5M8 13v1.5M1.5 8h1.5M13 8h1.5M3.4 3.4l1.1 1.1M11.5 11.5l1.1 1.1M3.4 12.6l1.1-1.1M11.5 4.5l1.1-1.1"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

function MoonIcon({ size }: { size: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M13.5 9.5A5.5 5.5 0 0 1 6.5 2.5a5.5 5.5 0 1 0 7 7Z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function MonitorIcon({ size }: { size: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
    >
      <rect
        x="1.5"
        y="2.5"
        width="13"
        height="9"
        rx="1.5"
        stroke="currentColor"
        strokeWidth="1.5"
      />
      <path
        d="M5.5 14h5M8 11.5V14"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

function iconFor(value: CocoaThemeValue, size: number): ReactNode {
  switch (value) {
    case "light":
      return <SunIcon size={size} />;
    case "dark":
      return <MoonIcon size={size} />;
    case "auto":
    default:
      return <MonitorIcon size={size} />;
  }
}

// Apply the chosen theme to the document root. For "auto" we clear the
// attribute so CSS @media (prefers-color-scheme: dark) in cocoa-tokens.css
// takes over and the page tracks the OS setting.
function applyThemeToDocument(value: CocoaThemeValue): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  if (value === "auto") {
    root.setAttribute("data-theme", "");
  } else {
    root.setAttribute("data-theme", value);
  }
}

export function CocoaThemeToggle({
  value,
  onChange,
  size = "regular",
}: CocoaThemeToggleProps) {
  const metrics = SIZE_METRICS[size];
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [pressed, setPressed] = useState(false);

  const handleToggle = () => {
    setOpen((prev) => !prev);
  };

  const handleSelect = (next: CocoaThemeValue) => {
    applyThemeToDocument(next);
    onChange(next);
    setOpen(false);
  };

  const radius =
    size === "small" ? "var(--cocoa-radius-sm)" : "var(--cocoa-radius-md)";

  const buttonStyle: CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: metrics.button,
    height: metrics.button,
    padding: 0,
    border: "1px solid var(--cocoa-separator)",
    borderRadius: radius,
    background: pressed
      ? "var(--cocoa-fill-secondary, rgba(0, 0, 0, 0.08))"
      : hovered
        ? "var(--cocoa-fill-tertiary, rgba(0, 0, 0, 0.04))"
        : "var(--cocoa-background-control)",
    color: "var(--cocoa-label)",
    boxShadow: "var(--cocoa-shadow-control)",
    cursor: "pointer",
    transition:
      "background-color var(--cocoa-duration-fast) var(--cocoa-ease-out), border-color var(--cocoa-duration-fast) var(--cocoa-ease-out), transform var(--cocoa-duration-fast) var(--cocoa-ease-out)",
    transform: pressed ? "scale(0.97)" : "scale(1)",
    WebkitAppearance: "none",
    appearance: "none",
  };

  const listStyle: CSSProperties = {
    display: "flex",
    flexDirection: "column",
    minWidth: 160,
    margin: 0,
    padding: 0,
    listStyle: "none",
  };

  const options: ReadonlyArray<CocoaThemeValue> = ["light", "dark", "auto"];

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className="cocoa-focus-ring"
        aria-label={`Tema: ${OPTION_LABELS[value]}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={handleToggle}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => {
          setHovered(false);
          setPressed(false);
        }}
        onMouseDown={() => setPressed(true)}
        onMouseUp={() => setPressed(false)}
        style={buttonStyle}
      >
        {iconFor(value, metrics.icon)}
      </button>
      <CocoaPopover
        open={open}
        anchorEl={buttonRef.current}
        placement="bottom"
        onClose={() => setOpen(false)}
      >
        <ul style={listStyle} role="radiogroup" aria-label="Apariencia">
          {options.map((opt) => {
            const selected = opt === value;
            return (
              <ThemeOption
                key={opt}
                value={opt}
                label={OPTION_LABELS[opt]}
                selected={selected}
                metrics={metrics}
                onSelect={handleSelect}
              />
            );
          })}
        </ul>
      </CocoaPopover>
    </>
  );
}

interface ThemeOptionProps {
  value: CocoaThemeValue;
  label: string;
  selected: boolean;
  metrics: SizeMetrics;
  onSelect: (value: CocoaThemeValue) => void;
}

function ThemeOption({
  value,
  label,
  selected,
  metrics,
  onSelect,
}: ThemeOptionProps) {
  const [hovered, setHovered] = useState(false);

  const rowStyle: CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: metrics.optionGap,
    width: "100%",
    padding: `${metrics.optionPadY}px ${metrics.optionPadX}px`,
    border: "none",
    borderRadius: "var(--cocoa-radius-sm)",
    background: hovered
      ? "var(--cocoa-accent)"
      : selected
        ? "var(--cocoa-fill-tertiary, rgba(0, 0, 0, 0.04))"
        : "transparent",
    color: hovered ? "var(--cocoa-accent-contrast)" : "var(--cocoa-label)",
    fontFamily: "var(--cocoa-font)",
    fontSize: metrics.optionFontSize,
    lineHeight: metrics.optionLineHeight,
    textAlign: "left",
    cursor: "pointer",
    WebkitAppearance: "none",
    appearance: "none",
  };

  const checkStyle: CSSProperties = {
    width: 14,
    height: 14,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
    color: hovered
      ? "var(--cocoa-accent-contrast)"
      : "var(--cocoa-accent)",
    opacity: selected ? 1 : 0,
  };

  const iconStyle: CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: metrics.optionIcon,
    height: metrics.optionIcon,
    flexShrink: 0,
  };

  return (
    <li role="presentation" style={{ margin: 0, padding: 0 }}>
      <button
        type="button"
        role="radio"
        aria-checked={selected}
        onClick={() => onSelect(value)}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        style={rowStyle}
      >
        <span aria-hidden="true" style={checkStyle}>
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <path
              d="M2.5 6.5l2.5 2.5 4.5-5"
              stroke="currentColor"
              strokeWidth="1.75"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </span>
        <span style={iconStyle}>{iconFor(value, metrics.optionIcon)}</span>
        <span style={{ flex: 1 }}>{label}</span>
      </button>
    </li>
  );
}

export default CocoaThemeToggle;
