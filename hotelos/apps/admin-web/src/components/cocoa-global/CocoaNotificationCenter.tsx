// Cocoa Notification Center
// -------------------------
// Slide-in panel docked to the right edge of the viewport, beneath the global
// toolbar. Displays a grouped, chronological list of notifications with optional
// per-item actions. The panel mirrors the macOS Notification Center: backdrop
// blur, subtle accent tint on unread items, and an empty-state acknowledgement
// when the user is caught up.
//
// Interaction contract:
//   - Opens via the `open` prop (controlled by the parent toolbar bell button).
//   - Closes via the X button, the Esc key, or a click on the dimmed backdrop.
//   - "Marcar todas como leidas" is a visual affordance only; the parent owns
//     notification state, so this component exposes the click via the optional
//     `onMarkAllAsRead` callback.
//
// Accessibility notes:
//   - Rendered as role="dialog" with aria-modal so screen readers announce it.
//   - Esc closes consistent with SidePanel / CommandPalette in this codebase.
//   - Icons inside notification cards are decorative (aria-hidden) because the
//     `type` is already conveyed via the title text.

import { useEffect, useId, useMemo, type CSSProperties, type ReactNode } from "react";

import {
  CheckCircleIcon,
  ExclamationCircleIcon,
  InfoCircleIcon,
  XCircleIcon
} from "../cocoa-icons/StatusIcons";

export type CocoaNotificationType = "info" | "success" | "warning" | "critical";

export interface CocoaNotificationAction {
  label: string;
  onClick: () => void;
}

export interface CocoaNotification {
  id: string;
  title: string;
  message?: string;
  type?: CocoaNotificationType;
  /** ISO-8601 timestamp. Used both for display and for "Hoy/Ayer" grouping. */
  timestamp: string;
  read?: boolean;
  actions?: Array<CocoaNotificationAction>;
}

export interface CocoaNotificationCenterProps {
  open: boolean;
  onClose: () => void;
  notifications: Array<CocoaNotification>;
  /**
   * Optional handler for the "Marcar todas como leidas" header button. If
   * omitted, the button is hidden because there would be no way for the parent
   * to react to it.
   */
  onMarkAllAsRead?: () => void;
}

// Buckets correspond to the three sections rendered in the list. Notifications
// older than the current week fall into a single "Anteriores" bucket so the
// panel never grows an unbounded list of day headers.
type NotificationBucket = "today" | "yesterday" | "thisWeek" | "earlier";

const BUCKET_LABELS: Record<NotificationBucket, string> = {
  today: "Hoy",
  yesterday: "Ayer",
  thisWeek: "Esta semana",
  earlier: "Anteriores"
};

// Fixed display order so buckets always appear newest-first regardless of the
// order in which the parent supplied the notifications.
const BUCKET_ORDER: ReadonlyArray<NotificationBucket> = [
  "today",
  "yesterday",
  "thisWeek",
  "earlier"
];

const TOOLBAR_HEIGHT = 48;
const PANEL_WIDTH = 380;

// Local accent tint for unread cards. We avoid var(--cocoa-accent) here so the
// tint stays subtle in both light and dark mode (the raw accent would dominate
// the card). A 6% alpha matches the macOS Notification Center treatment.
const UNREAD_BG = "rgba(10, 132, 255, 0.06)";

function startOfDay(value: Date): Date {
  const copy = new Date(value);
  copy.setHours(0, 0, 0, 0);
  return copy;
}

function bucketFor(timestamp: string, now: Date): NotificationBucket {
  const ts = new Date(timestamp);
  // Defensive: an invalid ISO string would otherwise place the item in a
  // misleading bucket. We treat unparseable dates as "earlier" so they still
  // render somewhere instead of disappearing.
  if (Number.isNaN(ts.getTime())) return "earlier";
  const today = startOfDay(now);
  const itemDay = startOfDay(ts);
  const diffDays = Math.round((today.getTime() - itemDay.getTime()) / 86_400_000);
  if (diffDays <= 0) return "today";
  if (diffDays === 1) return "yesterday";
  if (diffDays <= 6) return "thisWeek";
  return "earlier";
}

// Compact relative-time string. macOS uses "Ahora / hace 5 min / 14:32 / ayer
// 14:32 / 23 may", so we approximate that progression here.
function formatTimestamp(timestamp: string, now: Date): string {
  const ts = new Date(timestamp);
  if (Number.isNaN(ts.getTime())) return "";
  const diffMs = now.getTime() - ts.getTime();
  const diffMinutes = Math.round(diffMs / 60_000);
  if (diffMinutes < 1) return "Ahora";
  if (diffMinutes < 60) return `Hace ${diffMinutes} min`;
  const sameDay = startOfDay(ts).getTime() === startOfDay(now).getTime();
  if (sameDay) {
    return ts.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  }
  return ts.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

interface TypeStyle {
  icon: ReactNode;
  color: string;
}

function styleFor(type: CocoaNotificationType | undefined): TypeStyle {
  switch (type) {
    case "success":
      return { icon: <CheckCircleIcon size={18} />, color: "var(--cocoa-success, #34C759)" };
    case "warning":
      return { icon: <ExclamationCircleIcon size={18} />, color: "var(--cocoa-warning, #FF9F0A)" };
    case "critical":
      return { icon: <XCircleIcon size={18} />, color: "var(--cocoa-danger, #FF3B30)" };
    case "info":
    default:
      return { icon: <InfoCircleIcon size={18} />, color: "var(--cocoa-accent)" };
  }
}

export function CocoaNotificationCenter(props: CocoaNotificationCenterProps) {
  const { open, onClose, notifications, onMarkAllAsRead } = props;
  const headingId = useId();

  // Esc closes the panel — parity with SidePanel and CommandPalette so keyboard
  // users have a uniform exit across the app's overlays.
  useEffect(() => {
    if (!open) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // Recompute buckets only when the input list or open state changes. We pin
  // `now` to render-time per open cycle so timestamps don't shift mid-render.
  const grouped = useMemo(() => {
    const now = new Date();
    const buckets: Record<NotificationBucket, Array<CocoaNotification>> = {
      today: [],
      yesterday: [],
      thisWeek: [],
      earlier: []
    };
    for (const item of notifications) {
      buckets[bucketFor(item.timestamp, now)].push(item);
    }
    // Sort each bucket newest-first. Invalid dates sort to the end so they
    // don't crowd out real notifications at the top of the panel.
    for (const key of BUCKET_ORDER) {
      buckets[key].sort((a, b) => {
        const aMs = new Date(a.timestamp).getTime();
        const bMs = new Date(b.timestamp).getTime();
        if (Number.isNaN(aMs)) return 1;
        if (Number.isNaN(bMs)) return -1;
        return bMs - aMs;
      });
    }
    return { buckets, now };
  }, [notifications, open]);

  const hasUnread = notifications.some((n) => !n.read);

  // Backdrop is a transparent, full-viewport click target. Pointer events flip
  // off when closed so the rest of the UI stays interactive — without this the
  // panel would silently steal clicks even when hidden.
  const backdropStyle: CSSProperties = {
    position: "fixed",
    inset: 0,
    background: "transparent",
    pointerEvents: open ? "auto" : "none",
    zIndex: 80
  };

  const panelStyle: CSSProperties = {
    position: "fixed",
    top: TOOLBAR_HEIGHT,
    right: 0,
    bottom: 0,
    width: PANEL_WIDTH,
    maxWidth: "94vw",
    background: "var(--cocoa-background-sidebar)",
    backdropFilter: "blur(20px) saturate(180%)",
    WebkitBackdropFilter: "blur(20px) saturate(180%)",
    borderLeft: "1px solid var(--cocoa-separator)",
    boxShadow: "-12px 0 36px rgba(0, 0, 0, 0.18)",
    color: "var(--cocoa-label)",
    display: "flex",
    flexDirection: "column",
    transform: open ? "translateX(0)" : "translateX(100%)",
    transition: "transform var(--cocoa-duration-slow) var(--cocoa-ease-out)",
    willChange: "transform",
    zIndex: 81,
    pointerEvents: open ? "auto" : "none"
  };

  const headerStyle: CSSProperties = {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "var(--cocoa-space-2)",
    padding: "var(--cocoa-space-3) var(--cocoa-space-4)",
    borderBottom: "1px solid var(--cocoa-separator)",
    flexShrink: 0
  };

  const titleStyle: CSSProperties = {
    fontSize: "var(--cocoa-fs-title-3)",
    fontWeight: 600,
    margin: 0,
    color: "var(--cocoa-label)"
  };

  const headerActionsStyle: CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: "var(--cocoa-space-1)"
  };

  // Reusable "plain" header button — mirrors CocoaButton variant="plain"
  // without importing it, since the bell/close affordance only needs minimal
  // styling and avoids a circular dependency with the global components.
  const headerButtonStyle: CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    height: 24,
    padding: "0 var(--cocoa-space-2)",
    background: "transparent",
    border: "none",
    color: "var(--cocoa-accent)",
    cursor: "pointer",
    fontSize: "var(--cocoa-fs-subheadline)",
    borderRadius: "var(--cocoa-radius-sm)",
    fontFamily: "inherit"
  };

  const closeButtonStyle: CSSProperties = {
    ...headerButtonStyle,
    width: 24,
    color: "var(--cocoa-label-secondary)",
    padding: 0,
    fontSize: 14
  };

  const listStyle: CSSProperties = {
    overflowY: "auto",
    flex: 1,
    padding: "var(--cocoa-space-2) 0",
    display: "flex",
    flexDirection: "column",
    gap: "var(--cocoa-space-3)"
  };

  // The list is hidden from AT when there's nothing to read; the empty-state
  // block below is announced instead via aria-live so users learn they're done.
  const totalCount = notifications.length;

  return (
    <>
      <div
        style={backdropStyle}
        onClick={onClose}
        aria-hidden="true"
        data-testid="cocoa-notification-backdrop"
      />
      <aside
        role="dialog"
        aria-modal="false"
        aria-labelledby={headingId}
        aria-hidden={!open}
        style={panelStyle}
        onClick={(event) => event.stopPropagation()}
        data-testid="cocoa-notification-center"
      >
        <header style={headerStyle}>
          <h2 id={headingId} style={titleStyle}>
            Notificaciones
          </h2>
          <div style={headerActionsStyle}>
            {onMarkAllAsRead && hasUnread ? (
              <button
                type="button"
                style={headerButtonStyle}
                onClick={onMarkAllAsRead}
                data-testid="cocoa-notification-mark-all"
              >
                Marcar todas como leidas
              </button>
            ) : null}
            <button
              type="button"
              style={closeButtonStyle}
              onClick={onClose}
              aria-label="Cerrar notificaciones"
              title="Cerrar (Esc)"
              data-testid="cocoa-notification-close"
            >
              {"✕"}
            </button>
          </div>
        </header>

        {totalCount === 0 ? (
          <EmptyState />
        ) : (
          <div style={listStyle} role="list" aria-label="Notificaciones agrupadas por fecha">
            {BUCKET_ORDER.map((bucket) => {
              const items = grouped.buckets[bucket];
              if (items.length === 0) return null;
              return (
                <section key={bucket} aria-label={BUCKET_LABELS[bucket]}>
                  <SectionHeader>{BUCKET_LABELS[bucket]}</SectionHeader>
                  <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
                    {items.map((item) => (
                      <NotificationCard key={item.id} notification={item} now={grouped.now} />
                    ))}
                  </div>
                </section>
              );
            })}
          </div>
        )}
      </aside>
    </>
  );
}

function SectionHeader({ children }: { children: ReactNode }) {
  const style: CSSProperties = {
    fontSize: "var(--cocoa-fs-caption)",
    fontWeight: 600,
    textTransform: "uppercase",
    letterSpacing: 0.5,
    color: "var(--cocoa-label-secondary)",
    padding: "var(--cocoa-space-1) var(--cocoa-space-4)",
    marginBottom: "var(--cocoa-space-1)"
  };
  return <div style={style}>{children}</div>;
}

interface NotificationCardProps {
  notification: CocoaNotification;
  now: Date;
}

function NotificationCard({ notification, now }: NotificationCardProps) {
  const { title, message, type, timestamp, read, actions } = notification;
  const { icon, color } = styleFor(type);
  const isUnread = !read;

  const cardStyle: CSSProperties = {
    position: "relative",
    display: "flex",
    gap: "var(--cocoa-space-3)",
    padding: "var(--cocoa-space-3) var(--cocoa-space-4)",
    background: isUnread ? UNREAD_BG : "transparent",
    borderBottom: "1px solid var(--cocoa-separator)"
  };

  // 4px-wide accent stripe pinned to the left edge of unread cards. This is the
  // macOS-style "dot indicator" the spec asks for, scaled to fit a list item.
  const unreadIndicatorStyle: CSSProperties = {
    position: "absolute",
    left: 0,
    top: 0,
    bottom: 0,
    width: 3,
    background: "var(--cocoa-accent)"
  };

  const iconWrapStyle: CSSProperties = {
    display: "inline-flex",
    alignItems: "flex-start",
    justifyContent: "center",
    color,
    flexShrink: 0,
    paddingTop: 2
  };

  const bodyStyle: CSSProperties = {
    display: "flex",
    flexDirection: "column",
    gap: 2,
    minWidth: 0,
    flex: 1
  };

  const headerRowStyle: CSSProperties = {
    display: "flex",
    alignItems: "baseline",
    justifyContent: "space-between",
    gap: "var(--cocoa-space-2)"
  };

  const titleTextStyle: CSSProperties = {
    fontSize: "var(--cocoa-fs-body)",
    fontWeight: 600,
    color: "var(--cocoa-label)",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    minWidth: 0
  };

  const timestampStyle: CSSProperties = {
    fontSize: "var(--cocoa-fs-caption)",
    color: "var(--cocoa-label-tertiary)",
    flexShrink: 0
  };

  const messageStyle: CSSProperties = {
    fontSize: "var(--cocoa-fs-subheadline)",
    color: "var(--cocoa-label-secondary)",
    margin: 0,
    lineHeight: 1.4,
    // Allow up to two lines of message text before truncating; matches the
    // macOS Notification Center's tight vertical rhythm.
    display: "-webkit-box",
    WebkitLineClamp: 2,
    WebkitBoxOrient: "vertical",
    overflow: "hidden"
  };

  const actionsRowStyle: CSSProperties = {
    display: "flex",
    gap: "var(--cocoa-space-2)",
    marginTop: "var(--cocoa-space-1)",
    flexWrap: "wrap"
  };

  // Same "plain" button language as the header — kept inline so the file is
  // self-contained and Storybook-friendly without a CocoaButton import.
  const actionButtonStyle: CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    height: 22,
    padding: "0 var(--cocoa-space-2)",
    background: "transparent",
    border: "none",
    color: "var(--cocoa-accent)",
    cursor: "pointer",
    fontSize: "var(--cocoa-fs-subheadline)",
    borderRadius: "var(--cocoa-radius-sm)",
    fontFamily: "inherit"
  };

  return (
    <article role="listitem" style={cardStyle} data-testid="cocoa-notification-card" data-unread={isUnread || undefined}>
      {isUnread ? <span aria-label="Sin leer" style={unreadIndicatorStyle} /> : null}
      <span style={iconWrapStyle} aria-hidden="true">
        {icon}
      </span>
      <div style={bodyStyle}>
        <div style={headerRowStyle}>
          <span style={titleTextStyle} title={title}>
            {title}
          </span>
          <time style={timestampStyle} dateTime={timestamp}>
            {formatTimestamp(timestamp, now)}
          </time>
        </div>
        {message ? <p style={messageStyle}>{message}</p> : null}
        {actions && actions.length > 0 ? (
          <div style={actionsRowStyle}>
            {actions.map((action, idx) => (
              <button
                key={`${action.label}-${idx}`}
                type="button"
                style={actionButtonStyle}
                onClick={action.onClick}
              >
                {action.label}
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </article>
  );
}

function EmptyState() {
  const wrapStyle: CSSProperties = {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: "var(--cocoa-space-3)",
    flex: 1,
    padding: "var(--cocoa-space-5)",
    color: "var(--cocoa-label-secondary)",
    textAlign: "center"
  };
  const messageStyle: CSSProperties = {
    fontSize: "var(--cocoa-fs-title-3)",
    fontWeight: 500,
    color: "var(--cocoa-label)"
  };
  const subStyle: CSSProperties = {
    fontSize: "var(--cocoa-fs-subheadline)",
    color: "var(--cocoa-label-secondary)"
  };
  return (
    <div role="status" aria-live="polite" style={wrapStyle} data-testid="cocoa-notification-empty">
      <span style={{ color: "var(--cocoa-success, #34C759)" }} aria-hidden="true">
        <CheckCircleIcon size={48} />
      </span>
      <div style={messageStyle}>Estas al dia</div>
      <div style={subStyle}>No hay notificaciones pendientes.</div>
    </div>
  );
}
