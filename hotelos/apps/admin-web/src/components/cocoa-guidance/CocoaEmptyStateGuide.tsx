import type { CSSProperties, ReactNode } from "react";
import { CocoaButton } from "../cocoa/CocoaButton";

export interface CocoaEmptyStateGuideStepAction {
  label: string;
  onClick: () => void;
}

export interface CocoaEmptyStateGuideStep {
  label: string;
  description: string;
  action?: CocoaEmptyStateGuideStepAction;
}

export interface CocoaEmptyStateGuideProps {
  illustration?: ReactNode;
  title: string;
  description: string;
  primarySteps?: CocoaEmptyStateGuideStep[];
  videoUrl?: string;
  docsUrl?: string;
  className?: string;
  style?: CSSProperties;
}

const containerStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "flex-start",
  textAlign: "center",
  width: "100%",
  maxWidth: 600,
  marginInline: "auto",
  paddingInline: "clamp(16px, 4vw, 32px)",
  paddingBlock: "clamp(24px, 5vw, 40px)",
  boxSizing: "border-box",
  fontFamily: "var(--cocoa-font)",
  gap: "var(--cocoa-space-4)"
};

const illustrationStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  width: 200,
  height: 150,
  maxWidth: "100%",
  flexShrink: 0,
  color: "var(--cocoa-label-tertiary)"
};

const textBlockStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  gap: "var(--cocoa-space-2)",
  width: "100%"
};

const titleStyle: CSSProperties = {
  color: "var(--cocoa-label)",
  fontSize: "var(--cocoa-fs-title-2)",
  fontWeight: "var(--cocoa-fw-semibold)" as unknown as number,
  letterSpacing: "var(--cocoa-tracking-tight)",
  lineHeight: 1.2,
  margin: 0
};

const descriptionStyle: CSSProperties = {
  color: "var(--cocoa-label-secondary)",
  fontSize: "var(--cocoa-fs-subheadline)",
  fontWeight: "var(--cocoa-fw-regular)" as unknown as number,
  letterSpacing: "var(--cocoa-tracking-tight)",
  lineHeight: 1.4,
  margin: 0
};

const stepsListStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--cocoa-space-3)",
  width: "100%",
  margin: 0,
  padding: 0,
  listStyle: "none"
};

const stepCardStyle: CSSProperties = {
  display: "flex",
  flexDirection: "row",
  alignItems: "flex-start",
  gap: "var(--cocoa-space-3)",
  textAlign: "left",
  background: "var(--cocoa-background-content)",
  border: "1px solid var(--cocoa-separator)",
  borderRadius: "var(--cocoa-radius-lg)",
  padding: "var(--cocoa-space-3)",
  width: "100%",
  boxSizing: "border-box"
};

const stepNumberStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: 28,
  height: 28,
  flexShrink: 0,
  borderRadius: "50%",
  background: "var(--cocoa-accent)",
  color: "var(--cocoa-accent-contrast)",
  fontSize: "var(--cocoa-fs-subheadline)",
  fontWeight: "var(--cocoa-fw-semibold)" as unknown as number,
  letterSpacing: "var(--cocoa-tracking-tight)",
  lineHeight: 1
};

const stepBodyStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--cocoa-space-1)",
  flex: 1,
  minWidth: 0
};

const stepLabelStyle: CSSProperties = {
  color: "var(--cocoa-label)",
  fontSize: "var(--cocoa-fs-body)",
  fontWeight: "var(--cocoa-fw-semibold)" as unknown as number,
  letterSpacing: "var(--cocoa-tracking-tight)",
  lineHeight: 1.3,
  margin: 0
};

const stepDescriptionStyle: CSSProperties = {
  color: "var(--cocoa-label-secondary)",
  fontSize: "var(--cocoa-fs-subheadline)",
  fontWeight: "var(--cocoa-fw-regular)" as unknown as number,
  letterSpacing: "var(--cocoa-tracking-tight)",
  lineHeight: 1.4,
  margin: 0
};

const stepActionRowStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  marginTop: "var(--cocoa-space-1)"
};

const videoThumbnailStyle: CSSProperties = {
  position: "relative",
  display: "block",
  width: "100%",
  aspectRatio: "16 / 9",
  borderRadius: "var(--cocoa-radius-lg)",
  overflow: "hidden",
  border: "1px solid var(--cocoa-separator)",
  background: "var(--cocoa-background-control)",
  cursor: "pointer",
  textDecoration: "none",
  color: "inherit"
};

const videoPlayOverlayStyle: CSSProperties = {
  position: "absolute",
  inset: 0,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  background:
    "linear-gradient(180deg, rgba(0,0,0,0.0) 0%, rgba(0,0,0,0.35) 100%)"
};

const videoPlayButtonStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: 56,
  height: 56,
  borderRadius: "50%",
  background: "rgba(255, 255, 255, 0.92)",
  color: "var(--cocoa-accent)",
  boxShadow: "var(--cocoa-shadow-control)"
};

const docsLinkStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: "var(--cocoa-space-1)",
  color: "var(--cocoa-accent)",
  fontSize: "var(--cocoa-fs-subheadline)",
  fontWeight: "var(--cocoa-fw-medium)" as unknown as number,
  letterSpacing: "var(--cocoa-tracking-tight)",
  textDecoration: "none"
};

function getVideoThumbnailUrl(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./, "");

    if (host === "youtube.com" || host === "m.youtube.com") {
      const videoId = parsed.searchParams.get("v");
      if (videoId) {
        return `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`;
      }
    }
    if (host === "youtu.be") {
      const videoId = parsed.pathname.replace(/^\//, "").split("/")[0];
      if (videoId) {
        return `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`;
      }
    }
  } catch {
    return undefined;
  }
  return undefined;
}

export function CocoaEmptyStateGuide({
  illustration,
  title,
  description,
  primarySteps,
  videoUrl,
  docsUrl,
  className,
  style
}: CocoaEmptyStateGuideProps) {
  const mergedContainerStyle: CSSProperties = style
    ? { ...containerStyle, ...style }
    : containerStyle;

  const hasSteps = Array.isArray(primarySteps) && primarySteps.length > 0;
  const thumbnailUrl = videoUrl ? getVideoThumbnailUrl(videoUrl) : undefined;

  return (
    <div className={className} style={mergedContainerStyle} role="status">
      {illustration ? (
        <div aria-hidden="true" style={illustrationStyle}>
          {illustration}
        </div>
      ) : null}

      <div style={textBlockStyle}>
        <h2 style={titleStyle}>{title}</h2>
        <p style={descriptionStyle}>{description}</p>
      </div>

      {hasSteps ? (
        <ol style={stepsListStyle}>
          {primarySteps!.map((step, index) => (
            <li key={`${index}-${step.label}`} style={stepCardStyle}>
              <span aria-hidden="true" style={stepNumberStyle}>
                {index + 1}
              </span>
              <div style={stepBodyStyle}>
                <h3 style={stepLabelStyle}>{step.label}</h3>
                <p style={stepDescriptionStyle}>{step.description}</p>
                {step.action ? (
                  <div style={stepActionRowStyle}>
                    <CocoaButton
                      variant="tinted"
                      tone="accent"
                      size="small"
                      onClick={step.action.onClick}
                    >
                      {step.action.label}
                    </CocoaButton>
                  </div>
                ) : null}
              </div>
            </li>
          ))}
        </ol>
      ) : null}

      {videoUrl ? (
        <a
          href={videoUrl}
          target="_blank"
          rel="noreferrer noopener"
          style={{
            ...videoThumbnailStyle,
            ...(thumbnailUrl
              ? {
                  backgroundImage: `url(${thumbnailUrl})`,
                  backgroundSize: "cover",
                  backgroundPosition: "center"
                }
              : {})
          }}
          aria-label="Watch tutorial video"
        >
          <span style={videoPlayOverlayStyle}>
            <span style={videoPlayButtonStyle} aria-hidden="true">
              <svg
                width="20"
                height="20"
                viewBox="0 0 20 20"
                fill="none"
                xmlns="http://www.w3.org/2000/svg"
              >
                <path d="M6 4.5L15 10L6 15.5V4.5Z" fill="currentColor" />
              </svg>
            </span>
          </span>
        </a>
      ) : null}

      {docsUrl ? (
        <a
          href={docsUrl}
          target="_blank"
          rel="noreferrer noopener"
          style={docsLinkStyle}
        >
          <span>Read the documentation</span>
          <svg
            width="12"
            height="12"
            viewBox="0 0 12 12"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
            aria-hidden="true"
          >
            <path
              d="M4 2H10V8"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <path
              d="M10 2L3 9"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </a>
      ) : null}
    </div>
  );
}

export default CocoaEmptyStateGuide;
