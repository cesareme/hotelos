// CocoaInfoPopover — Contextual information popover for inline guidance.
//
// Renders a small trigger (either a child element provided by the caller, or
// a default circular "i" info icon) which, when clicked, opens a
// CocoaPopover anchored to the trigger. The popover content is structured:
//   - Title in bold
//   - Description paragraph
//   - "Saber más" link (when learnMoreUrl is provided)
//
// Use this for short, in-context explanations next to form fields, table
// columns, settings rows, or any UI element that benefits from a brief
// "what does this mean?" affordance without overwhelming the layout.
//
// Visuals:
// - The default trigger is a 16px circle with the letter "i" centered,
//   styled with cocoa secondary content color and a hover state that
//   bumps the color to the primary accent.
// - The popover itself reuses CocoaPopover, so material blur, shadow,
//   radius, and spring entry animation are all consistent with the rest
//   of the Cocoa design system.
// - Title uses var(--cocoa-text-primary) at semibold weight; description
//   uses var(--cocoa-text-secondary) at the body size; link uses the
//   Cocoa accent color.
//
// Props:
// - title         : Bold heading inside the popover (required).
// - description   : Body text under the title (required).
// - learnMoreUrl  : Optional URL — when present, a "Saber más" link is
//                   rendered below the description. Opens in a new tab.
// - children      : Optional custom trigger. When omitted, the default
//                   inline info icon is rendered.

import {
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";

import CocoaPopover from "../cocoa/CocoaPopover";

export interface CocoaInfoPopoverProps {
  title: string;
  description: string;
  learnMoreUrl?: string;
  children?: ReactNode;
}

const defaultIconStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: 16,
  height: 16,
  borderRadius: "50%",
  border: "1px solid var(--cocoa-text-tertiary)",
  color: "var(--cocoa-text-tertiary)",
  background: "transparent",
  font: "italic 600 10px/1 var(--cocoa-font-family-text)",
  cursor: "pointer",
  padding: 0,
  verticalAlign: "middle",
  transition:
    "color var(--cocoa-duration-fast) var(--cocoa-ease-standard), border-color var(--cocoa-duration-fast) var(--cocoa-ease-standard)",
};

const triggerWrapperStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  cursor: "pointer",
};

const titleStyle: CSSProperties = {
  margin: 0,
  font: "var(--cocoa-text-headline)",
  fontWeight: 600,
  color: "var(--cocoa-text-primary)",
};

const descriptionStyle: CSSProperties = {
  margin: "var(--cocoa-space-2) 0 0 0",
  font: "var(--cocoa-text-body)",
  color: "var(--cocoa-text-secondary)",
  lineHeight: 1.4,
};

const learnMoreStyle: CSSProperties = {
  display: "inline-block",
  marginTop: "var(--cocoa-space-2)",
  font: "var(--cocoa-text-body)",
  color: "var(--cocoa-accent)",
  textDecoration: "none",
};

const contentStyle: CSSProperties = {
  maxWidth: 280,
  display: "flex",
  flexDirection: "column",
};

export function CocoaInfoPopover({
  title,
  description,
  learnMoreUrl,
  children,
}: CocoaInfoPopoverProps) {
  const [open, setOpen] = useState<boolean>(false);
  const anchorRef = useRef<HTMLSpanElement | null>(null);

  const toggle = (event: ReactMouseEvent<HTMLElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setOpen((prev) => !prev);
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      setOpen((prev) => !prev);
    }
  };

  const trigger =
    children === undefined ? (
      <button
        type="button"
        aria-label={title}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={toggle}
        style={defaultIconStyle}
      >
        i
      </button>
    ) : (
      <span
        role="button"
        tabIndex={0}
        aria-label={title}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={toggle}
        onKeyDown={handleKeyDown}
        style={triggerWrapperStyle}
      >
        {children}
      </span>
    );

  return (
    <>
      <span ref={anchorRef} style={{ display: "inline-flex" }}>
        {trigger}
      </span>
      <CocoaPopover
        open={open}
        anchorEl={anchorRef.current}
        placement="bottom"
        onClose={() => setOpen(false)}
      >
        <div style={contentStyle}>
          <h4 style={titleStyle}>{title}</h4>
          <p style={descriptionStyle}>{description}</p>
          {learnMoreUrl !== undefined && learnMoreUrl.length > 0 ? (
            <a
              href={learnMoreUrl}
              target="_blank"
              rel="noopener noreferrer"
              style={learnMoreStyle}
            >
              Saber más
            </a>
          ) : null}
        </div>
      </CocoaPopover>
    </>
  );
}

export default CocoaInfoPopover;
