// CocoaProgressChecklist — Onboarding progress checklist following Cocoa.
//
// A bordered card that surfaces a progressive onboarding checklist with a
// header progress bar and an interactive list of items. Each item is rendered
// with a circular checkbox; completed items show a strikethrough and a
// reduced opacity to fade them into the background.
//
// Layout, top-to-bottom:
//   - Header row: title (h3) + progress bar (X/Y completed) + optional
//     chevron toggle (when collapsible)
//   - Item list (hidden when collapsed):
//       - Circular checkbox (accent-filled when done)
//       - Label + optional description
//       - Whole row is clickable when the item has onClick
//
// Props:
//   - title       (required) Card heading
//   - items       (required) Array of checklist entries
//                   { id, label, description?, done, onClick? }
//   - collapsible? When true, shows a chevron that toggles the list
//
// Visuals use cocoa-tokens (background, separator, radii, spacing, type
// scale) so light/dark themes flow automatically. The card uses the
// `bordered` CocoaCard variant with `md` padding.
//
// A11y:
//   - role="region" + aria-label = title
//   - Progress bar exposes role="progressbar" with aria-valuenow / valuemax
//   - Each clickable item is a real <button> so it is keyboard reachable
//   - Collapse toggle is a real <button> with aria-expanded + aria-controls

import {
  useCallback,
  useId,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent
} from "react";

import { CocoaCard } from "../cocoa/CocoaCard";

export interface CocoaProgressChecklistItem {
  id: string;
  label: string;
  description?: string;
  done: boolean;
  onClick?: () => void;
}

export interface CocoaProgressChecklistProps {
  title: string;
  items: CocoaProgressChecklistItem[];
  collapsible?: boolean;
}

const wrapperStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--cocoa-space-3)",
  width: "100%",
  fontFamily: "var(--cocoa-font)"
};

const headerRowStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "var(--cocoa-space-3)",
  width: "100%"
};

const headerTextColumnStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--cocoa-space-2)",
  flex: "1 1 auto",
  minWidth: 0
};

const titleRowStyle: CSSProperties = {
  display: "flex",
  alignItems: "baseline",
  justifyContent: "space-between",
  gap: "var(--cocoa-space-2)"
};

const titleStyle: CSSProperties = {
  margin: 0,
  color: "var(--cocoa-label)",
  fontSize: "var(--cocoa-fs-headline)",
  fontWeight: "var(--cocoa-fw-semibold)" as unknown as number,
  letterSpacing: "var(--cocoa-tracking-tight)",
  lineHeight: 1.25
};

const counterStyle: CSSProperties = {
  margin: 0,
  color: "var(--cocoa-label-secondary)",
  fontSize: "var(--cocoa-fs-footnote)",
  fontWeight: "var(--cocoa-fw-regular)" as unknown as number,
  lineHeight: 1,
  flexShrink: 0,
  fontVariantNumeric: "tabular-nums"
};

const progressTrackStyle: CSSProperties = {
  position: "relative",
  width: "100%",
  height: 6,
  borderRadius: 999,
  background:
    "color-mix(in srgb, var(--cocoa-label-secondary) 16%, transparent)",
  overflow: "hidden"
};

function getProgressFillStyle(percent: number): CSSProperties {
  return {
    position: "absolute",
    inset: 0,
    width: `${percent}%`,
    background: "var(--cocoa-accent)",
    borderRadius: 999,
    transition:
      "width var(--cocoa-duration-base) var(--cocoa-ease-out)"
  };
}

const chevronButtonStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: 28,
  height: 28,
  padding: 0,
  borderRadius: "var(--cocoa-radius-sm)",
  background: "transparent",
  border: "none",
  color: "var(--cocoa-label-secondary)",
  cursor: "pointer",
  flexShrink: 0,
  WebkitAppearance: "none",
  appearance: "none",
  transition:
    "background-color var(--cocoa-duration-fast) var(--cocoa-ease-out), color var(--cocoa-duration-fast) var(--cocoa-ease-out)"
};

const listStyle: CSSProperties = {
  margin: 0,
  padding: 0,
  listStyle: "none",
  display: "flex",
  flexDirection: "column",
  gap: "var(--cocoa-space-1)"
};

const itemRowBaseStyle: CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  gap: "var(--cocoa-space-3)",
  width: "100%",
  padding: "var(--cocoa-space-2)",
  background: "transparent",
  border: "none",
  borderRadius: "var(--cocoa-radius-md)",
  textAlign: "left",
  font: "inherit",
  color: "inherit",
  WebkitAppearance: "none",
  appearance: "none",
  transition:
    "background-color var(--cocoa-duration-fast) var(--cocoa-ease-out)"
};

const itemRowStaticStyle: CSSProperties = {
  ...itemRowBaseStyle,
  cursor: "default"
};

const itemRowInteractiveStyle: CSSProperties = {
  ...itemRowBaseStyle,
  cursor: "pointer"
};

const checkboxBaseStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: 20,
  height: 20,
  borderRadius: "50%",
  flexShrink: 0,
  marginTop: 2,
  transition:
    "background-color var(--cocoa-duration-fast) var(--cocoa-ease-out), border-color var(--cocoa-duration-fast) var(--cocoa-ease-out)"
};

function getCheckboxStyle(done: boolean): CSSProperties {
  if (done) {
    return {
      ...checkboxBaseStyle,
      background: "var(--cocoa-accent)",
      border: "1px solid var(--cocoa-accent)",
      color: "var(--cocoa-accent-contrast)"
    };
  }
  return {
    ...checkboxBaseStyle,
    background: "transparent",
    border: "1.5px solid var(--cocoa-separator)",
    color: "transparent"
  };
}

const itemTextColumnStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 2,
  flex: "1 1 auto",
  minWidth: 0
};

function getLabelStyle(done: boolean): CSSProperties {
  return {
    margin: 0,
    color: "var(--cocoa-label)",
    fontSize: "var(--cocoa-fs-body)",
    fontWeight: "var(--cocoa-fw-regular)" as unknown as number,
    lineHeight: 1.4,
    textDecoration: done ? "line-through" : "none",
    opacity: done ? 0.6 : 1,
    transition:
      "opacity var(--cocoa-duration-fast) var(--cocoa-ease-out)"
  };
}

function getDescriptionStyle(done: boolean): CSSProperties {
  return {
    margin: 0,
    color: "var(--cocoa-label-secondary)",
    fontSize: "var(--cocoa-fs-footnote)",
    fontWeight: "var(--cocoa-fw-regular)" as unknown as number,
    lineHeight: 1.4,
    opacity: done ? 0.6 : 1,
    transition:
      "opacity var(--cocoa-duration-fast) var(--cocoa-ease-out)"
  };
}

function CheckIcon({ size = 12 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 12 12"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      focusable="false"
    >
      <path
        d="M2.5 6.25L5 8.75L9.5 3.75"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ChevronIcon({
  size = 14,
  expanded
}: {
  size?: number;
  expanded: boolean;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      focusable="false"
      style={{
        transform: expanded ? "rotate(0deg)" : "rotate(-90deg)",
        transition:
          "transform var(--cocoa-duration-fast) var(--cocoa-ease-out)"
      }}
    >
      <path
        d="M4 6L8 10L12 6"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function CocoaProgressChecklist({
  title,
  items,
  collapsible = false
}: CocoaProgressChecklistProps) {
  const [expanded, setExpanded] = useState<boolean>(true);
  const listId = useId();

  const total = items.length;
  const completed = items.reduce(
    (count, item) => count + (item.done ? 1 : 0),
    0
  );
  const percent = total === 0 ? 0 : Math.round((completed / total) * 100);

  const handleToggleExpanded = useCallback(() => {
    setExpanded((current) => !current);
  }, []);

  const handleChevronMouseEnter = useCallback(
    (event: ReactMouseEvent<HTMLButtonElement>) => {
      event.currentTarget.style.backgroundColor =
        "var(--cocoa-background-control)";
      event.currentTarget.style.color = "var(--cocoa-label)";
    },
    []
  );

  const handleChevronMouseLeave = useCallback(
    (event: ReactMouseEvent<HTMLButtonElement>) => {
      event.currentTarget.style.backgroundColor = "transparent";
      event.currentTarget.style.color = "var(--cocoa-label-secondary)";
    },
    []
  );

  const handleItemMouseEnter = useCallback(
    (event: ReactMouseEvent<HTMLElement>) => {
      event.currentTarget.style.backgroundColor =
        "var(--cocoa-background-control)";
    },
    []
  );

  const handleItemMouseLeave = useCallback(
    (event: ReactMouseEvent<HTMLElement>) => {
      event.currentTarget.style.backgroundColor = "transparent";
    },
    []
  );

  return (
    <CocoaCard variant="bordered" padding="md" className="cocoa-font">
      <div
        role="region"
        aria-label={title}
        style={wrapperStyle}
      >
        <div style={headerRowStyle}>
          <div style={headerTextColumnStyle}>
            <div style={titleRowStyle}>
              <h3 style={titleStyle}>{title}</h3>
              <span style={counterStyle} aria-hidden="true">
                {completed}/{total}
              </span>
            </div>
            <div
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={total}
              aria-valuenow={completed}
              aria-label={`${completed} de ${total} completados`}
              style={progressTrackStyle}
            >
              <div style={getProgressFillStyle(percent)} aria-hidden="true" />
            </div>
          </div>

          {collapsible ? (
            <button
              type="button"
              aria-label={expanded ? "Colapsar lista" : "Expandir lista"}
              aria-expanded={expanded}
              aria-controls={listId}
              style={chevronButtonStyle}
              onClick={handleToggleExpanded}
              onMouseEnter={handleChevronMouseEnter}
              onMouseLeave={handleChevronMouseLeave}
            >
              <ChevronIcon expanded={expanded} />
            </button>
          ) : null}
        </div>

        {expanded ? (
          <ul id={listId} style={listStyle}>
            {items.map((item) => {
              const isInteractive = typeof item.onClick === "function";
              const rowStyle = isInteractive
                ? itemRowInteractiveStyle
                : itemRowStaticStyle;

              const content = (
                <>
                  <span style={getCheckboxStyle(item.done)} aria-hidden="true">
                    {item.done ? <CheckIcon /> : null}
                  </span>
                  <span style={itemTextColumnStyle}>
                    <span style={getLabelStyle(item.done)}>{item.label}</span>
                    {item.description ? (
                      <span style={getDescriptionStyle(item.done)}>
                        {item.description}
                      </span>
                    ) : null}
                  </span>
                </>
              );

              return (
                <li key={item.id}>
                  {isInteractive ? (
                    <button
                      type="button"
                      style={rowStyle}
                      onClick={item.onClick}
                      onMouseEnter={handleItemMouseEnter}
                      onMouseLeave={handleItemMouseLeave}
                      aria-pressed={item.done}
                    >
                      {content}
                    </button>
                  ) : (
                    <div style={rowStyle} aria-checked={item.done} role="checkbox">
                      {content}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        ) : null}
      </div>
    </CocoaCard>
  );
}

export default CocoaProgressChecklist;
