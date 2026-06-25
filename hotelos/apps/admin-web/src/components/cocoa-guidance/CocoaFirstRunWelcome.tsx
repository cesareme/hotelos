// CocoaFirstRunWelcome — First login welcome modal for Anfitorio.
//
// A 560x420 modal shown on a user's first sign-in. It introduces the
// product, the user (by name and role), and three orientation cards:
//   - 'Lo que veras' (What you'll see) — high-level overview of the workspace
//   - 'Atajos' (Shortcuts) — keyboard shortcuts to move fast
//   - 'Donde pedir ayuda' (Where to ask for help) — support resources
//
// Layout, top-to-bottom:
//   - Brand mark (48x48 rounded square with accent → success gradient)
//   - 'Bienvenido a Anfitorio {userName}' large title
//   - Role subtitle (italic, secondary)
//   - 3-card grid (one row, three columns), each with title + helper text
//   - Filled accent CocoaButton 'Tour guiado 3min'
//   - Plain link to skip
//
// Visuals: blurred backdrop with fade, dialog container with
// var(--cocoa-radius-lg), var(--cocoa-shadow-modal), and a spring scale/
// translate entry powered by var(--cocoa-ease-spring). All colors resolve
// through cocoa-tokens so light/dark themes pick up automatically.
//
// A11y:
// - role="dialog" + aria-modal="true"
// - aria-labelledby on the title
// - ESC closes the modal (calls onClose)
// - Focus moves to the primary action ('Tour guiado 3min') on open and is
//   restored to the previously focused element on close; focus is trapped
//   within the dialog while open.
//
// Portal-mounted on document.body so it escapes any stacking context.

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent
} from "react";
import { createPortal } from "react-dom";

import { CocoaButton } from "../cocoa/CocoaButton";

export interface CocoaFirstRunWelcomeProps {
  open: boolean;
  onClose: () => void;
  userName?: string;
  userRole?: string;
  onStartTutorial: () => void;
  onSkip: () => void;
}

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "area[href]",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "button:not([disabled])",
  "iframe",
  "object",
  "embed",
  "[contenteditable='true']",
  "[tabindex]:not([tabindex='-1'])"
].join(",");

function getFocusableElements(root: HTMLElement | null): HTMLElement[] {
  if (!root) return [];
  const nodes = Array.from(
    root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)
  );
  return nodes.filter((node) => {
    if (node.hasAttribute("disabled")) return false;
    if (node.getAttribute("aria-hidden") === "true") return false;
    const style = window.getComputedStyle(node);
    if (style.visibility === "hidden" || style.display === "none") return false;
    return true;
  });
}

interface OrientationCard {
  title: string;
  body: string;
}

const ORIENTATION_CARDS: OrientationCard[] = [
  {
    title: "Lo que veras",
    body: "Reservas, ocupacion y tareas al instante en un panel unificado."
  },
  {
    title: "Atajos",
    body: "Cmd+K abre el panel de comandos. ? muestra todos los atajos."
  },
  {
    title: "Donde pedir ayuda",
    body: "Cocoa esta a un clic. El centro de ayuda y el equipo te respaldan."
  }
];

export function CocoaFirstRunWelcome({
  open,
  onClose,
  userName,
  userRole,
  onStartTutorial,
  onSkip
}: CocoaFirstRunWelcomeProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const primaryActionRef = useRef<HTMLButtonElement | null>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);
  const [isMounted, setIsMounted] = useState<boolean>(open);
  const [isVisible, setIsVisible] = useState<boolean>(false);
  const titleId = useId();
  const subtitleId = useId();

  // Manage mount/unmount with motion enter/exit.
  useEffect(() => {
    if (open) {
      setIsMounted(true);
      const raf = window.requestAnimationFrame(() => {
        setIsVisible(true);
      });
      return () => window.cancelAnimationFrame(raf);
    }

    setIsVisible(false);
    if (!isMounted) return undefined;
    const timeout = window.setTimeout(() => {
      setIsMounted(false);
    }, 400);
    return () => window.clearTimeout(timeout);
  }, [open, isMounted]);

  // Focus management — move focus to the primary action on open,
  // restore on close.
  useEffect(() => {
    if (!isMounted) return undefined;
    previouslyFocusedRef.current =
      (document.activeElement as HTMLElement | null) ?? null;

    const root = containerRef.current;
    const raf = window.requestAnimationFrame(() => {
      if (primaryActionRef.current) {
        primaryActionRef.current.focus({ preventScroll: true });
        return;
      }
      const focusables = getFocusableElements(root);
      const first = focusables[0] ?? root;
      first?.focus({ preventScroll: true });
    });

    return () => {
      window.cancelAnimationFrame(raf);
      const previous = previouslyFocusedRef.current;
      if (previous && typeof previous.focus === "function") {
        previous.focus({ preventScroll: true });
      }
    };
  }, [isMounted]);

  // Esc + body scroll lock.
  useEffect(() => {
    if (!isMounted) return undefined;

    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", handleKeyDown);

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [isMounted, onClose]);

  const handleBackdropClick = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      if (event.target === event.currentTarget) {
        onClose();
      }
    },
    [onClose]
  );

  const handleContainerKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (event.key !== "Tab") return;
      const root = containerRef.current;
      if (!root) return;

      const focusables = getFocusableElements(root);
      if (focusables.length === 0) {
        event.preventDefault();
        root.focus({ preventScroll: true });
        return;
      }

      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement as HTMLElement | null;

      if (event.shiftKey) {
        if (active === first || !root.contains(active)) {
          event.preventDefault();
          last.focus({ preventScroll: true });
        }
      } else if (active === last) {
        event.preventDefault();
        first.focus({ preventScroll: true });
      }
    },
    []
  );

  const handleStartTutorial = useCallback(() => {
    onStartTutorial();
  }, [onStartTutorial]);

  const handleSkip = useCallback(
    (event: ReactMouseEvent<HTMLAnchorElement>) => {
      event.preventDefault();
      onSkip();
    },
    [onSkip]
  );

  const backdropStyle = useMemo<CSSProperties>(
    () => ({
      position: "fixed",
      inset: 0,
      zIndex: 1100,
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      padding: 16,
      background: "rgba(0, 0, 0, 0.32)",
      backdropFilter: "blur(8px) saturate(180%)",
      WebkitBackdropFilter: "blur(8px) saturate(180%)",
      opacity: isVisible ? 1 : 0,
      transition: "opacity var(--cocoa-duration-base) var(--cocoa-ease-out)",
      pointerEvents: isVisible ? "auto" : "none"
    }),
    [isVisible]
  );

  const containerStyle = useMemo<CSSProperties>(
    () => ({
      position: "relative",
      width: 560,
      height: 420,
      maxWidth: "100%",
      maxHeight: "100%",
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      gap: 8,
      padding: "24px 28px 20px",
      background: "var(--cocoa-background-content)",
      borderRadius: "var(--cocoa-radius-lg)",
      boxShadow: "var(--cocoa-shadow-modal)",
      transform: isVisible
        ? "scale(1) translateY(0)"
        : "scale(0.94) translateY(-8px)",
      opacity: isVisible ? 1 : 0,
      transition:
        "transform var(--cocoa-duration-slow) var(--cocoa-ease-spring), opacity var(--cocoa-duration-base) var(--cocoa-ease-out)",
      outline: "none",
      fontFamily: "var(--cocoa-font)",
      color: "var(--cocoa-label)",
      boxSizing: "border-box"
    }),
    [isVisible]
  );

  const brandMarkStyle = useMemo<CSSProperties>(
    () => ({
      width: 48,
      height: 48,
      borderRadius: 12,
      background:
        "linear-gradient(135deg, var(--cocoa-accent) 0%, var(--cocoa-success) 100%)",
      boxShadow: "var(--cocoa-shadow-control)",
      marginBottom: 4,
      flexShrink: 0
    }),
    []
  );

  const titleStyle = useMemo<CSSProperties>(
    () => ({
      margin: 0,
      fontSize: "var(--cocoa-fs-title-1)",
      lineHeight: "var(--cocoa-lh-title-1)",
      fontWeight: "var(--cocoa-fw-semibold)" as unknown as number,
      letterSpacing: "var(--cocoa-tracking-tight)",
      color: "var(--cocoa-label)",
      textAlign: "center"
    }),
    []
  );

  const subtitleStyle = useMemo<CSSProperties>(
    () => ({
      margin: 0,
      fontSize: "var(--cocoa-fs-body)",
      fontStyle: "italic",
      fontWeight: "var(--cocoa-fw-regular)" as unknown as number,
      color: "var(--cocoa-label-secondary)",
      textAlign: "center"
    }),
    []
  );

  const cardsGridStyle = useMemo<CSSProperties>(
    () => ({
      display: "grid",
      gridTemplateColumns: "repeat(3, 1fr)",
      gap: 12,
      width: "100%",
      marginTop: 14
    }),
    []
  );

  const cardStyle = useMemo<CSSProperties>(
    () => ({
      display: "flex",
      flexDirection: "column",
      gap: 6,
      padding: 14,
      background: "var(--cocoa-background-control)",
      border: "1px solid var(--cocoa-separator)",
      borderRadius: "var(--cocoa-radius-md)",
      boxShadow: "var(--cocoa-shadow-control)",
      boxSizing: "border-box"
    }),
    []
  );

  const cardTitleStyle = useMemo<CSSProperties>(
    () => ({
      margin: 0,
      fontSize: "var(--cocoa-fs-subheadline)",
      lineHeight: "var(--cocoa-lh-subheadline)",
      fontWeight: "var(--cocoa-fw-semibold)" as unknown as number,
      color: "var(--cocoa-label)"
    }),
    []
  );

  const cardBodyStyle = useMemo<CSSProperties>(
    () => ({
      margin: 0,
      fontSize: "var(--cocoa-fs-footnote)",
      lineHeight: 1.4,
      color: "var(--cocoa-label-secondary)"
    }),
    []
  );

  const actionsColumnStyle = useMemo<CSSProperties>(
    () => ({
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      gap: 10,
      marginTop: "auto",
      paddingTop: 12,
      width: "100%"
    }),
    []
  );

  const skipLinkStyle = useMemo<CSSProperties>(
    () => ({
      fontSize: "var(--cocoa-fs-footnote)",
      color: "var(--cocoa-accent)",
      textDecoration: "none",
      cursor: "pointer",
      background: "transparent",
      border: "none",
      padding: 0
    }),
    []
  );

  if (!isMounted) return null;
  if (typeof document === "undefined") return null;

  const greeting = userName
    ? `Bienvenido a Anfitorio ${userName}`
    : "Bienvenido a Anfitorio";

  const node = (
    <div
      style={backdropStyle}
      onMouseDown={handleBackdropClick}
      aria-hidden={!isVisible}
    >
      <div
        ref={containerRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={userRole ? subtitleId : undefined}
        tabIndex={-1}
        style={containerStyle}
        onKeyDown={handleContainerKeyDown}
      >
        <div style={brandMarkStyle} aria-hidden="true" />

        <h1 id={titleId} style={titleStyle}>
          {greeting}
        </h1>

        {userRole ? (
          <p id={subtitleId} style={subtitleStyle}>
            {userRole}
          </p>
        ) : null}

        <div style={cardsGridStyle} role="list">
          {ORIENTATION_CARDS.map((card) => (
            <div key={card.title} style={cardStyle} role="listitem">
              <h2 style={cardTitleStyle}>{card.title}</h2>
              <p style={cardBodyStyle}>{card.body}</p>
            </div>
          ))}
        </div>

        <div style={actionsColumnStyle}>
          <CocoaButton
            variant="filled"
            tone="accent"
            size="large"
            onClick={handleStartTutorial}
            aria-label="Iniciar tour guiado de 3 minutos"
          >
            <span
              ref={(el) => {
                const btn = el?.closest("button") as HTMLButtonElement | null;
                primaryActionRef.current = btn;
              }}
            >
              Tour guiado 3min
            </span>
          </CocoaButton>

          <a
            href="#skip"
            onClick={handleSkip}
            style={skipLinkStyle}
            onMouseEnter={(event) => {
              event.currentTarget.style.textDecoration = "underline";
            }}
            onMouseLeave={(event) => {
              event.currentTarget.style.textDecoration = "none";
            }}
          >
            Saltar por ahora
          </a>
        </div>
      </div>
    </div>
  );

  return createPortal(node, document.body);
}

export default CocoaFirstRunWelcome;
