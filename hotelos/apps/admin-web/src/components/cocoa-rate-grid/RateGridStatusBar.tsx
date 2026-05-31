import type { CSSProperties } from "react";
import { CocoaButton } from "../cocoa/CocoaButton";

export interface RateGridStatusBarProps {
  unsavedCount: number;
  lastPushAt?: string;
  onDiscard: () => void;
  onPushSelected: () => void;
  onPushAll: () => void;
  pushing?: boolean;
}

function formatLastPush(value: string | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  try {
    return new Intl.DateTimeFormat(undefined, {
      hour: "2-digit",
      minute: "2-digit",
      day: "2-digit",
      month: "short"
    }).format(date);
  } catch {
    return date.toISOString();
  }
}

export function RateGridStatusBar({
  unsavedCount,
  lastPushAt,
  onDiscard,
  onPushSelected,
  onPushAll,
  pushing = false
}: RateGridStatusBarProps) {
  const hasUnsaved = unsavedCount > 0;
  const lastPushLabel = formatLastPush(lastPushAt);

  const containerStyle: CSSProperties = {
    height: 40,
    minHeight: 40,
    padding: "0 16px",
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    background: "var(--cocoa-background-toolbar)",
    backdropFilter: "var(--cocoa-material-toolbar-blur)",
    WebkitBackdropFilter: "var(--cocoa-material-toolbar-blur)",
    borderTop: "1px solid var(--cocoa-separator)",
    fontFamily: "var(--cocoa-font)",
    boxSizing: "border-box"
  };

  const infoStyle: CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: 8,
    minWidth: 0,
    flex: 1
  };

  const unsavedLabelStyle: CSSProperties = {
    fontSize: "var(--cocoa-fs-subheadline)",
    fontWeight: "var(--cocoa-fw-medium)" as unknown as number,
    color: hasUnsaved
      ? "var(--cocoa-label)"
      : "var(--cocoa-label-secondary)",
    letterSpacing: "var(--cocoa-tracking-tight)",
    lineHeight: 1.2,
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis"
  };

  const lastPushStyle: CSSProperties = {
    fontSize: "var(--cocoa-fs-caption)",
    fontWeight: "var(--cocoa-fw-regular)" as unknown as number,
    color: "var(--cocoa-label-secondary)",
    lineHeight: 1.2,
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis"
  };

  const separatorStyle: CSSProperties = {
    width: 1,
    height: 14,
    background: "var(--cocoa-separator)",
    flexShrink: 0
  };

  const badgeStyle: CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    minWidth: 18,
    height: 18,
    paddingInline: 6,
    borderRadius: 9,
    background: "var(--cocoa-accent)",
    color: "var(--cocoa-accent-contrast)",
    fontSize: "var(--cocoa-fs-caption)",
    fontWeight: "var(--cocoa-fw-semibold)" as unknown as number,
    lineHeight: 1,
    flexShrink: 0
  };

  const actionsStyle: CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: 8,
    flexShrink: 0
  };

  const unsavedText =
    unsavedCount === 1
      ? "1 cambio sin guardar"
      : `${unsavedCount} cambios sin guardar`;

  return (
    <div role="status" aria-live="polite" style={containerStyle}>
      <div style={infoStyle}>
        {hasUnsaved ? <span style={badgeStyle}>{unsavedCount}</span> : null}
        <span style={unsavedLabelStyle}>
          {hasUnsaved ? unsavedText : "Sin cambios pendientes"}
        </span>
        {lastPushLabel ? (
          <>
            <span aria-hidden="true" style={separatorStyle} />
            <span style={lastPushStyle}>
              Última publicación: {lastPushLabel}
            </span>
          </>
        ) : null}
      </div>
      <div style={actionsStyle}>
        <CocoaButton
          variant="plain"
          size="small"
          tone="neutral"
          onClick={onDiscard}
          disabled={!hasUnsaved || pushing}
        >
          Descartar
        </CocoaButton>
        <CocoaButton
          variant="bordered"
          size="small"
          tone="accent"
          onClick={onPushSelected}
          disabled={!hasUnsaved || pushing}
          loading={pushing}
        >
          Publicar selección
        </CocoaButton>
        <CocoaButton
          variant="filled"
          size="small"
          tone="accent"
          onClick={onPushAll}
          disabled={!hasUnsaved || pushing}
          loading={pushing}
        >
          Publicar todo
        </CocoaButton>
      </div>
    </div>
  );
}

export default RateGridStatusBar;
