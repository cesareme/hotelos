// CocoaScreenInstructionsCard — Top-of-screen instructional card following Cocoa.
//
// A bordered card that surfaces context-sensitive onboarding/help copy at the
// top of a screen. Shows:
//   - A leading lightbulb icon (accent-tinted)
//   - An H3 title (headline)
//   - A short body description
//   - An optional numbered list of steps with accent dots
//   - An optional tip callout (subtle warning tint)
//   - An optional dismiss control that persists via localStorage
//
// Props:
//   - title       (required) Card heading
//   - description (required) Short explanatory paragraph
//   - steps?      Ordered string[] rendered as a numbered list
//   - tip?        Single tip line shown in a warning-toned callout
//   - dismissible?    When true, shows an "X" close button
//   - persistKey?     If provided, the dismissed state is saved to
//                     localStorage so the card stays hidden across reloads.
//                     Falls back to in-memory state when omitted.
//
// Visuals use cocoa-tokens (background, separator, radii, spacing, type
// scale) so light/dark themes flow automatically. The card uses the
// `bordered` CocoaCard variant.
//
// A11y:
//   - role="region" + aria-label = title
//   - Dismiss button has aria-label "Dismiss instructions"
//   - localStorage access is wrapped in try/catch to tolerate disabled
//     storage (private mode, SSR, etc.)

import {
  useCallback,
  useEffect,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent
} from "react";

import { CocoaCard } from "../cocoa/CocoaCard";

export interface CocoaScreenInstructionsCardProps {
  title: string;
  description: string;
  steps?: string[];
  tip?: string;
  dismissible?: boolean;
  persistKey?: string;
}

const STORAGE_PREFIX = "cocoa-screen-instructions:";

function readDismissed(persistKey: string | undefined): boolean {
  if (!persistKey) return false;
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(STORAGE_PREFIX + persistKey) === "1";
  } catch {
    return false;
  }
}

function writeDismissed(persistKey: string | undefined): void {
  if (!persistKey) return;
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_PREFIX + persistKey, "1");
  } catch {
    // Ignore storage failures (private mode, quota exceeded, etc.)
  }
}

const headerRowStyle: CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  gap: "var(--cocoa-space-3)",
  width: "100%"
};

const iconWrapStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: 28,
  height: 28,
  borderRadius: "var(--cocoa-radius-md)",
  background: "color-mix(in srgb, var(--cocoa-accent) 12%, transparent)",
  color: "var(--cocoa-accent)",
  flexShrink: 0,
  marginTop: 2
};

const bodyColumnStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--cocoa-space-2)",
  flex: "1 1 auto",
  minWidth: 0
};

const titleStyle: CSSProperties = {
  margin: 0,
  color: "var(--cocoa-label)",
  fontSize: "var(--cocoa-fs-headline)",
  fontWeight: "var(--cocoa-fw-semibold)" as unknown as number,
  letterSpacing: "var(--cocoa-tracking-tight)",
  lineHeight: 1.25
};

const descriptionStyle: CSSProperties = {
  margin: 0,
  color: "var(--cocoa-label-secondary)",
  fontSize: "var(--cocoa-fs-body)",
  fontWeight: "var(--cocoa-fw-regular)" as unknown as number,
  lineHeight: 1.45
};

const stepsListStyle: CSSProperties = {
  margin: 0,
  padding: 0,
  listStyle: "none",
  display: "flex",
  flexDirection: "column",
  gap: "var(--cocoa-space-2)",
  marginTop: "var(--cocoa-space-1)"
};

const stepItemStyle: CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  gap: "var(--cocoa-space-2)",
  color: "var(--cocoa-label)",
  fontSize: "var(--cocoa-fs-body)",
  lineHeight: 1.45
};

const stepDotStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: 20,
  height: 20,
  borderRadius: "50%",
  background: "var(--cocoa-accent)",
  color: "var(--cocoa-accent-contrast)",
  fontSize: "var(--cocoa-fs-caption-1)",
  fontWeight: "var(--cocoa-fw-semibold)" as unknown as number,
  lineHeight: 1,
  flexShrink: 0,
  marginTop: 1
};

const stepTextStyle: CSSProperties = {
  flex: "1 1 auto",
  minWidth: 0
};

const tipCalloutStyle: CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  gap: "var(--cocoa-space-2)",
  marginTop: "var(--cocoa-space-2)",
  padding: "var(--cocoa-space-3)",
  borderRadius: "var(--cocoa-radius-md)",
  background: "color-mix(in srgb, var(--cocoa-warning) 10%, transparent)",
  border:
    "1px solid color-mix(in srgb, var(--cocoa-warning) 24%, transparent)",
  color: "var(--cocoa-label)",
  fontSize: "var(--cocoa-fs-subheadline)",
  lineHeight: 1.4
};

const tipIconStyle: CSSProperties = {
  color: "var(--cocoa-warning)",
  flexShrink: 0,
  marginTop: 1
};

const tipLabelStyle: CSSProperties = {
  fontWeight: "var(--cocoa-fw-semibold)" as unknown as number,
  marginRight: 4,
  color: "var(--cocoa-label)"
};

const dismissButtonStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: 24,
  height: 24,
  padding: 0,
  marginTop: -2,
  marginRight: -4,
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

function LightbulbIcon({ size = 18 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      focusable="false"
    >
      <path
        d="M5.25 9.5C4.42 8.74 3.9 7.66 3.9 6.45C3.9 4.18 5.74 2.35 8 2.35C10.26 2.35 12.1 4.18 12.1 6.45C12.1 7.66 11.58 8.74 10.75 9.5C10.36 9.86 10.13 10.37 10.13 10.9V11.25H5.87V10.9C5.87 10.37 5.64 9.86 5.25 9.5Z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <path
        d="M6.25 12.5H9.75"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      <path
        d="M6.75 13.75H9.25"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

function CloseIcon({ size = 12 }: { size?: number }) {
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
        d="M3 3L9 9M9 3L3 9"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

function TipIcon({ size = 14 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      focusable="false"
      style={tipIconStyle}
    >
      <circle cx="8" cy="8" r="6.25" stroke="currentColor" strokeWidth="1.5" />
      <path
        d="M8 7.5V11.25"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      <circle cx="8" cy="5.25" r="0.85" fill="currentColor" />
    </svg>
  );
}

export function CocoaScreenInstructionsCard({
  title,
  description,
  steps,
  tip,
  dismissible = false,
  persistKey
}: CocoaScreenInstructionsCardProps) {
  const [dismissed, setDismissed] = useState<boolean>(() =>
    readDismissed(persistKey)
  );

  // Re-evaluate persisted state when the persistKey changes.
  useEffect(() => {
    setDismissed(readDismissed(persistKey));
  }, [persistKey]);

  const handleDismiss = useCallback(() => {
    setDismissed(true);
    writeDismissed(persistKey);
  }, [persistKey]);

  const handleDismissMouseEnter = useCallback(
    (event: ReactMouseEvent<HTMLButtonElement>) => {
      event.currentTarget.style.backgroundColor =
        "var(--cocoa-background-control)";
      event.currentTarget.style.color = "var(--cocoa-label)";
    },
    []
  );

  const handleDismissMouseLeave = useCallback(
    (event: ReactMouseEvent<HTMLButtonElement>) => {
      event.currentTarget.style.backgroundColor = "transparent";
      event.currentTarget.style.color = "var(--cocoa-label-secondary)";
    },
    []
  );

  if (dismissed) return null;

  const hasSteps = Array.isArray(steps) && steps.length > 0;

  return (
    <CocoaCard variant="bordered" padding="md" className="cocoa-font">
      <div style={{ fontFamily: "var(--cocoa-font)" }}>
        <div
          role="region"
          aria-label={title}
          style={headerRowStyle}
        >
          <span style={iconWrapStyle} aria-hidden="true">
            <LightbulbIcon />
          </span>

          <div style={bodyColumnStyle}>
            <h3 style={titleStyle}>{title}</h3>
            <p style={descriptionStyle}>{description}</p>

            {hasSteps ? (
              <ol style={stepsListStyle}>
                {steps!.map((step, index) => (
                  <li key={index} style={stepItemStyle}>
                    <span style={stepDotStyle} aria-hidden="true">
                      {index + 1}
                    </span>
                    <span style={stepTextStyle}>{step}</span>
                  </li>
                ))}
              </ol>
            ) : null}

            {tip ? (
              <div style={tipCalloutStyle} role="note">
                <TipIcon />
                <span>
                  <span style={tipLabelStyle}>Tip:</span>
                  {tip}
                </span>
              </div>
            ) : null}
          </div>

          {dismissible ? (
            <button
              type="button"
              aria-label="Dismiss instructions"
              style={dismissButtonStyle}
              onClick={handleDismiss}
              onMouseEnter={handleDismissMouseEnter}
              onMouseLeave={handleDismissMouseLeave}
            >
              <CloseIcon />
            </button>
          ) : null}
        </div>
      </div>
    </CocoaCard>
  );
}

export default CocoaScreenInstructionsCard;
