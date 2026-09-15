// CocoaSection — card with a header (COCOA-22.md §3.5; replaces `.bo-card` +
// `.bo-section` + the local `cardHeadStyle/cardTitleStyle` of the canon).
//
//   <header>  h3 title-3 600  ·  meta caption secondary  ·  action (CocoaButton plain small)
//   <body>    children (optionally scrolling on x/y)
//   <footer>  optional, separated by a hairline
//
// Header: flex space-between center, gap 12, margin-bottom 12. With
// `padding="none"` (tables, charts that bleed) the header and footer keep
// their own 16 px inset so the content can touch the card edges.
// Hooks for the css lot: root `c22-section` (+ data-variant/data-padding from
// CocoaCard), parts `c22-section__head/__heading/__title/__meta/__action/
// __body[data-scroll]/__footer`.

import { useId, type CSSProperties, type ReactNode } from "react";
import { CocoaCard, type CocoaCardProps } from "./CocoaCard";

export interface CocoaSectionProps extends Pick<CocoaCardProps, "variant" | "padding" | "onClick"> {
  title?: string;
  /** Caption at the right of the title («OTB · Forecast · LY», «datos a 08:12»). */
  meta?: ReactNode;
  /** Action at the right («Ver detalle»); a CocoaButton plain/small. */
  action?: ReactNode;
  headingLevel?: 2 | 3;
  footer?: ReactNode;
  /** Scroll axis of the body (tables → "x"). */
  scroll?: "x" | "y";
  /** Fixed body height when `scroll="y"`. */
  maxHeight?: number;
  children: ReactNode;
  id?: string;
  className?: string;
  /** Layout escape hatch only. */
  style?: CSSProperties;
  "aria-label"?: string;
}

export function CocoaSection({
  variant = "bordered",
  padding = "md",
  onClick,
  title,
  meta,
  action,
  headingLevel = 3,
  footer,
  scroll,
  maxHeight,
  children,
  id,
  className,
  style,
  "aria-label": ariaLabel
}: CocoaSectionProps) {
  const headingId = useId();
  const hasHeader = Boolean(title || meta || action);
  const inset = padding === "none" ? "var(--cocoa-space-4)" : undefined;
  const Heading = headingLevel === 2 ? "h2" : "h3";

  const headerStyle: CSSProperties = {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    gap: "var(--cocoa-space-3)",
    marginBottom: padding === "none" ? 0 : "var(--cocoa-space-3)",
    padding: inset ? `${inset} ${inset} var(--cocoa-space-3)` : undefined,
    minWidth: 0
  };

  const titleStyle: CSSProperties = {
    margin: 0,
    fontSize: "var(--cocoa-fs-title-3)",
    fontWeight: "var(--cocoa-fw-semibold)" as CSSProperties["fontWeight"],
    letterSpacing: "var(--cocoa-tracking-tight)",
    lineHeight: "var(--cocoa-leading-title)",
    color: "var(--cocoa-label)",
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap"
  };

  const metaStyle: CSSProperties = {
    margin: 0,
    fontSize: "var(--cocoa-fs-caption)",
    color: "var(--cocoa-label-secondary)",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
    flexShrink: 0
  };

  const bodyStyle: CSSProperties = {
    minWidth: 0,
    flex: "1 1 auto",
    overflowX: scroll === "x" ? "auto" : undefined,
    overflowY: scroll === "y" ? "auto" : undefined,
    maxHeight: scroll === "y" ? maxHeight : undefined,
    WebkitOverflowScrolling: scroll ? "touch" : undefined
  };

  const footerStyle: CSSProperties = {
    marginTop: padding === "none" ? 0 : "var(--cocoa-space-3)",
    padding: inset ? `var(--cocoa-space-3) ${inset}` : `var(--cocoa-space-3) 0 0`,
    borderTop: "1px solid var(--cocoa-separator)",
    fontSize: "var(--cocoa-fs-callout)",
    color: "var(--cocoa-label-secondary)"
  };

  return (
    <CocoaCard
      variant={variant}
      padding={padding}
      onClick={onClick}
      id={id}
      className={["c22-section", "cocoa-section", className].filter(Boolean).join(" ")}
      style={{ display: "flex", flexDirection: "column", height: "100%", ...style }}
      aria-labelledby={title ? headingId : undefined}
      aria-label={title ? undefined : ariaLabel}
      data-cocoa="section"
    >
      {hasHeader ? (
        <header className="c22-section__head cocoa-section-head" style={headerStyle}>
          <div className="c22-section__heading" style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0, flex: "1 1 auto" }}>
            {title ? (
              <Heading id={headingId} className="c22-section__title" style={titleStyle}>
                {title}
              </Heading>
            ) : null}
          </div>
          {meta || action ? (
            <div className="c22-section__action" style={{ display: "inline-flex", alignItems: "center", gap: "var(--cocoa-space-2)", flexShrink: 0 }}>
              {meta ? (
                <span className="c22-section__meta" style={metaStyle}>
                  {meta}
                </span>
              ) : null}
              {action}
            </div>
          ) : null}
        </header>
      ) : null}
      <div className="c22-section__body cocoa-section-body" style={bodyStyle} data-scroll={scroll}>
        {children}
      </div>
      {footer ? (
        <footer className="c22-section__footer cocoa-section-foot" style={footerStyle}>
          {footer}
        </footer>
      ) : null}
    </CocoaCard>
  );
}

export default CocoaSection;
