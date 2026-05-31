import { useState } from "react";
import type { CSSProperties, ReactNode } from "react";

export interface CocoaFormFieldsetProps {
  title: string;
  description?: string;
  children: ReactNode;
  collapsible?: boolean;
  defaultOpen?: boolean;
}

const containerStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  background: "var(--cocoa-background-content)",
  border: "1px solid var(--cocoa-separator)",
  borderRadius: "var(--cocoa-radius-lg)",
  fontFamily: "var(--cocoa-font)",
  overflow: "hidden"
};

const headerStyle: CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  gap: "var(--cocoa-space-3)",
  padding: "var(--cocoa-space-4)"
};

const headerInteractiveStyle: CSSProperties = {
  ...headerStyle,
  cursor: "pointer",
  background: "transparent",
  border: "none",
  width: "100%",
  textAlign: "left",
  font: "inherit",
  color: "inherit"
};

const headingBlockStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--cocoa-space-1)",
  flex: "1 1 auto",
  minWidth: 0
};

const titleStyle: CSSProperties = {
  color: "var(--cocoa-label)",
  fontSize: "var(--cocoa-fs-headline)",
  fontWeight: "var(--cocoa-fw-semibold)" as unknown as number,
  letterSpacing: "var(--cocoa-tracking-tight)",
  lineHeight: 1.25,
  margin: 0
};

const descriptionStyle: CSSProperties = {
  color: "var(--cocoa-label-secondary)",
  fontSize: "var(--cocoa-fs-subheadline)",
  fontWeight: "var(--cocoa-fw-regular)" as unknown as number,
  lineHeight: 1.35,
  margin: 0
};

const chevronWrapperStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: "16px",
  height: "16px",
  marginTop: "2px",
  color: "var(--cocoa-label-secondary)",
  flexShrink: 0,
  transition:
    "transform var(--cocoa-duration-base) var(--cocoa-ease-out)"
};

const separatorStyle: CSSProperties = {
  height: "1px",
  background: "var(--cocoa-separator)",
  width: "100%"
};

const contentStyle: CSSProperties = {
  padding: "var(--cocoa-space-4)"
};

function Chevron() {
  return (
    <svg
      aria-hidden="true"
      width="10"
      height="10"
      viewBox="0 0 10 10"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        d="M3 1.5L6.5 5L3 8.5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function CocoaFormFieldset({
  title,
  description,
  children,
  collapsible = false,
  defaultOpen = true
}: CocoaFormFieldsetProps) {
  const [open, setOpen] = useState<boolean>(defaultOpen);

  const isOpen = collapsible ? open : true;

  const headerContent = (
    <>
      {collapsible ? (
        <span
          aria-hidden="true"
          style={{
            ...chevronWrapperStyle,
            transform: isOpen ? "rotate(90deg)" : "rotate(0deg)"
          }}
        >
          <Chevron />
        </span>
      ) : null}
      <div style={headingBlockStyle}>
        <p style={titleStyle}>{title}</p>
        {description ? <p style={descriptionStyle}>{description}</p> : null}
      </div>
    </>
  );

  return (
    <section style={containerStyle}>
      {collapsible ? (
        <button
          type="button"
          style={headerInteractiveStyle}
          onClick={() => setOpen((prev) => !prev)}
          aria-expanded={isOpen}
        >
          {headerContent}
        </button>
      ) : (
        <div style={headerStyle}>{headerContent}</div>
      )}
      {isOpen ? (
        <>
          <div style={separatorStyle} aria-hidden="true" />
          <div style={contentStyle}>{children}</div>
        </>
      ) : null}
    </section>
  );
}

export default CocoaFormFieldset;
