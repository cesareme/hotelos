// Reusable confirmation dialog — replaces the native `confirm()` browser modal.
//
// Uses Aurora v2 design tokens so it's automatically theme-aware (light/dark).
// Two variants: `danger` (destructive red) and `primary` (accent green).
//
// Usage:
//   const [confirmOpen, setConfirmOpen] = useState(false);
//   <ConfirmDialog
//     open={confirmOpen}
//     title="¿Eliminar este recurso?"
//     description="Esta acción no se puede deshacer."
//     variant="danger"
//     onConfirm={async () => { await doDelete(); setConfirmOpen(false); }}
//     onCancel={() => setConfirmOpen(false)}
//   />
//
// A11y:
// - role="dialog" + aria-modal="true" + aria-labelledby on the title and
//   aria-describedby on the description (accessible name AND description).
// - ESC closes via onCancel.
// - Initial focus: the CONFIRM button for `primary`, the CANCEL button for
//   `danger` (cierre 2026-09-15, browser-ux#19): Enter on a freshly opened
//   destructive dialog must never revert / discard by accident.
// - `children` renders extra content (a list of affected cells…) between the
//   description and the buttons.

import { useEffect, useId, useRef } from "react";
import type { KeyboardEvent, ReactNode } from "react";

export type ConfirmDialogProps = {
  open: boolean;
  title: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: "danger" | "primary";
  onConfirm: () => void;
  onCancel: () => void;
  /** Extra content under the description (lists, notes); part of the dialog's description for screen readers. */
  children?: ReactNode;
};

export function ConfirmDialog(props: ConfirmDialogProps) {
  const {
    open,
    title,
    description,
    confirmLabel = "Confirmar",
    cancelLabel = "Cancelar",
    variant = "primary",
    onConfirm,
    onCancel,
    children,
  } = props;

  const titleId = useId();
  const descriptionId = useId();
  const confirmBtnRef = useRef<HTMLButtonElement | null>(null);
  const cancelBtnRef = useRef<HTMLButtonElement | null>(null);

  // Initial focus when the dialog opens: the safe action for destructive
  // dialogs, the confirm action otherwise.
  useEffect(() => {
    if (open) {
      // Defer to next tick so the button is mounted and visible.
      const id = window.setTimeout(() => {
        (variant === "danger" ? cancelBtnRef.current : confirmBtnRef.current)?.focus();
      }, 0);
      return () => window.clearTimeout(id);
    }
  }, [open, variant]);

  if (!open) return null;

  function handleKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === "Escape") {
      e.stopPropagation();
      onCancel();
    }
  }

  const confirmBg = variant === "danger" ? "#dc2626" : "var(--accent)";

  return (
    <div
      role="presentation"
      onKeyDown={handleKeyDown}
      onClick={(e) => {
        // Clicking the overlay (but not the card) cancels.
        if (e.target === e.currentTarget) onCancel();
      }}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 9999,
        background: "rgba(15, 23, 42, 0.55)",
        backdropFilter: "blur(2px)",
        WebkitBackdropFilter: "blur(2px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 16,
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description || children ? descriptionId : undefined}
        style={{
          background: "var(--surface-1, var(--surface-elevated, var(--surface)))",
          color: "var(--ink)",
          borderRadius: "var(--radius-md, 12px)",
          padding: "var(--space-5, 20px)",
          boxShadow: "var(--shadow-lg, 0 4px 14px rgba(26, 26, 26, 0.08), 0 24px 60px rgba(26, 26, 26, 0.10))",
          maxWidth: 440,
          width: "100%",
          display: "flex",
          flexDirection: "column",
          gap: 12,
        }}
      >
        <h2
          id={titleId}
          style={{
            margin: 0,
            color: "var(--ink)",
            fontSize: 18,
            fontWeight: 600,
            lineHeight: 1.3,
          }}
        >
          {title}
        </h2>

        {description || children ? (
          <div id={descriptionId} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {description ? (
              <p
                style={{
                  margin: 0,
                  color: "var(--ink-soft, var(--ink-muted, var(--ink)))",
                  fontSize: 14,
                  lineHeight: 1.5,
                }}
              >
                {description}
              </p>
            ) : null}
            {children}
          </div>
        ) : null}

        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            gap: 8,
            marginTop: 8,
          }}
        >
          <button
            ref={cancelBtnRef}
            type="button"
            onClick={onCancel}
            style={{
              background: "var(--surface-2, var(--surface-sunken, var(--surface)))",
              color: "var(--ink-2, var(--ink-soft, var(--ink)))",
              border: "1px solid var(--border, transparent)",
              borderRadius: "var(--radius-sm, 8px)",
              padding: "8px 16px",
              fontSize: 14,
              fontWeight: 500,
              cursor: "pointer",
            }}
          >
            {cancelLabel}
          </button>
          <button
            ref={confirmBtnRef}
            type="button"
            onClick={onConfirm}
            style={{
              background: confirmBg,
              color: "#ffffff",
              border: "none",
              borderRadius: "var(--radius-sm, 8px)",
              padding: "8px 16px",
              fontSize: 14,
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

export default ConfirmDialog;
