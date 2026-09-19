// CocoaDialog — confirmation dialog of Cocoa 22 (COCOA-22.md §3.9; the legacy
// confirm wrapper was retired in ola 11 and `window.confirm` is forbidden).
//
//   max 440 (sm) / 560 (md) · content bg · radius 12 · shadow modal · title-2 600
//   description body secondary · overlay `--cocoa-scrim` · z --cocoa-z-modal
//   role=dialog + aria-modal + aria-labelledby/-describedby · focus trap ·
//   Esc and overlay click cancel (never while busy) · initial focus on CANCEL
//   for destructive dialogs (Enter must not discard by accident) and on
//   CONFIRM otherwise · `onConfirm` may return a promise: the confirm button
//   spins and the cancel button is disabled until it settles · `confirmDisabled`
//   keeps Confirm disabled while a prompt's field is invalid (Cancel and Esc
//   still work; the initial focus falls back to Cancel) · `submitOnEnter`
//   (UX-1 · U5, F6, §4 «Enter envía», default true): Enter inside a ONE-LINE
//   field confirms — never in a <textarea>, never while busy/disabled, never in
//   a destructive dialog unless `initialFocus` put the caret in its reason
//   field, and never inside a <form> (the form owns Enter) · `confirmForm`:
//   the Confirm button becomes the submit button of that <form id> (Enter in
//   any of its fields submits natively; the form's onSubmit does the work and
//   `onConfirm` is not called by the dialog).
//
// Hooks for the css lot: overlay `c22-dialog-layer`, card `c22-dialog` +
// data-size/tone, parts `c22-dialog__title/__description/__body/__actions`
// (the stylesheet stacks the actions full-width on phones).

import { useCallback, useId, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { CocoaButton } from "./CocoaButton";
import { COCOA_SCRIM, useEscapeKey, useFocusTrap, useMountedTransition, useScrollLock } from "./cocoa-overlay";

export type CocoaDialogTone = "primary" | "destructive";
export type CocoaDialogSize = "sm" | "md";

export interface CocoaDialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  tone?: CocoaDialogTone;
  confirmLabel?: string;
  cancelLabel?: string;
  onConfirm: () => void | Promise<void>;
  /** External busy flag (the caller awaits its own request). */
  busy?: boolean;
  /** Keeps Confirm disabled (a prompt whose field is still invalid); Cancel, Esc and the overlay keep working. */
  confirmDisabled?: boolean;
  /** Extra content between the description and the buttons (lists, notes). */
  children?: ReactNode;
  size?: CocoaDialogSize;
  /** Single-button dialogs (acknowledgements). */
  hideCancel?: boolean;
  /** Element to focus on open (a field inside `children`, e.g. a one-line prompt); default: the safe button — Cancel for destructive dialogs, Confirm otherwise. */
  initialFocus?: () => HTMLElement | null | undefined;
  /** Enter in a one-line field confirms (default true; see `shouldSubmitOnEnter` for the guards). */
  submitOnEnter?: boolean;
  /** `id` of a <form> rendered in `children`: Confirm becomes its submit button (Enter submits natively; wire the work in the form's `onSubmit`). */
  confirmForm?: string;
}

export const DIALOG_WIDTH: Record<CocoaDialogSize, number> = { sm: 440, md: 560 };
const EXIT_MS = 200;

/** Which button takes the initial focus (pure): the safe one for destructive dialogs. */
export function dialogInitialFocus(tone: CocoaDialogTone, hideCancel = false): "confirm" | "cancel" {
  return tone === "destructive" && !hideCancel ? "cancel" : "confirm";
}

const NON_TEXT_INPUT_TYPES = new Set(["button", "submit", "reset", "checkbox", "radio", "file", "range", "color", "image", "hidden"]);

type FieldLike = { tagName?: string; type?: string; isContentEditable?: boolean; closest?: (selector: string) => unknown } | null | undefined;

/** A one-line text field (`<input>` of a text-like type): the only place where Enter means «confirm». */
export function isOneLineTextField(target: FieldLike): boolean {
  if (!target || typeof target !== "object") return false;
  if (target.isContentEditable) return false;
  if ((target.tagName ?? "").toUpperCase() !== "INPUT") return false;
  return !NON_TEXT_INPUT_TYPES.has((target.type ?? "text").toLowerCase());
}

export interface SubmitOnEnterEvent {
  key: string;
  shiftKey?: boolean;
  altKey?: boolean;
  metaKey?: boolean;
  ctrlKey?: boolean;
  isComposing?: boolean;
  target?: unknown;
}

export interface SubmitOnEnterContext {
  /** The overlay opted in (`submitOnEnter`). */
  enabled: boolean;
  tone: CocoaDialogTone;
  busy: boolean;
  /** Confirm is disabled (invalid prompt) — Enter must not bypass it. */
  confirmDisabled: boolean;
  /** `initialFocus` names a field: a destructive dialog only submits on Enter when its reason field took the focus on open. */
  hasInitialFocus: boolean;
}

/**
 * Enter confirms (pure, UX-1 · U5 · F6): plain Enter (no modifier, not composing)
 * inside a one-line text field of an enabled, non-busy overlay; never in a
 * <textarea>, never in a destructive dialog without `initialFocus`, and never
 * inside a <form> (the form's own submission owns Enter there).
 */
export function shouldSubmitOnEnter(event: SubmitOnEnterEvent, ctx: SubmitOnEnterContext): boolean {
  if (!ctx.enabled || ctx.busy || ctx.confirmDisabled) return false;
  if (event.key !== "Enter" || event.shiftKey || event.altKey || event.metaKey || event.ctrlKey || event.isComposing) return false;
  if (ctx.tone === "destructive" && !ctx.hasInitialFocus) return false;
  const target = event.target as FieldLike;
  if (!isOneLineTextField(target)) return false;
  if (typeof target?.closest === "function" && target.closest("form")) return false;
  return true;
}

export function CocoaDialog({
  open,
  onClose,
  title,
  description,
  tone = "primary",
  confirmLabel = "Confirmar",
  cancelLabel = "Cancelar",
  onConfirm,
  busy = false,
  confirmDisabled = false,
  children,
  size = "sm",
  hideCancel = false,
  initialFocus,
  // Opt-in (corrector UX1-REV-05): Intro en un campo solo confirma en los overlays de recepción que lo declaran
  // (§4 «Enter envía»: PaymentDialog vía confirmForm, LifecycleDialog, RefundDialog…); los 60+ diálogos restantes conservan el clic.
  submitOnEnter = false,
  confirmForm
}: CocoaDialogProps) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const confirmRef = useRef<HTMLButtonElement | null>(null);
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const titleId = useId();
  const descriptionId = useId();
  const [pending, setPending] = useState(false);
  const isBusy = busy || pending;
  const { mounted, visible } = useMountedTransition(open, EXIT_MS);

  // A disabled Confirm cannot take the focus: fall back to Cancel (or the dialog itself).
  const onKeyDown = useFocusTrap(dialogRef, mounted, () => initialFocus?.() ?? (dialogInitialFocus(tone, hideCancel) === "cancel" || confirmDisabled ? cancelRef.current : confirmRef.current));
  const close = useCallback(() => {
    if (!isBusy) onClose();
  }, [isBusy, onClose]);
  useEscapeKey(mounted, close);
  useScrollLock(mounted);

  const handleConfirm = useCallback(() => {
    if (isBusy || confirmDisabled) return;
    const result = onConfirm();
    if (result && typeof (result as Promise<void>).then === "function") {
      setPending(true);
      (result as Promise<void>).finally(() => setPending(false));
    }
  }, [isBusy, confirmDisabled, onConfirm]);

  // Enter in a one-line field = Confirm (F6); the focus trap keeps Tab.
  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      const submits = shouldSubmitOnEnter(
        { key: event.key, shiftKey: event.shiftKey, altKey: event.altKey, metaKey: event.metaKey, ctrlKey: event.ctrlKey, isComposing: event.nativeEvent.isComposing, target: event.target },
        { enabled: submitOnEnter, tone, busy: isBusy, confirmDisabled, hasInitialFocus: Boolean(initialFocus) }
      );
      if (submits) {
        event.preventDefault();
        if (confirmForm) {
          // The dialog's Confirm is the form's submit button: let the form do the work.
          confirmRef.current?.click();
        } else {
          handleConfirm();
        }
        return;
      }
      onKeyDown(event);
    },
    [submitOnEnter, tone, isBusy, confirmDisabled, initialFocus, confirmForm, handleConfirm, onKeyDown]
  );

  if (!mounted || typeof document === "undefined") return null;

  const hasDescription = Boolean(description || children);

  const overlayStyle: CSSProperties = {
    position: "fixed",
    inset: 0,
    zIndex: "var(--cocoa-z-modal)" as CSSProperties["zIndex"],
    background: COCOA_SCRIM,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: "var(--cocoa-space-4)",
    boxSizing: "border-box",
    opacity: visible ? 1 : 0,
    transition: "opacity var(--cocoa-duration-base) var(--cocoa-ease-out)",
    pointerEvents: visible ? "auto" : "none"
  };

  const cardStyle: CSSProperties = {
    width: "100%",
    maxWidth: DIALOG_WIDTH[size],
    maxHeight: "calc(100dvh - 32px)",
    overflow: "auto",
    background: "var(--cocoa-background-content)",
    color: "var(--cocoa-label)",
    borderRadius: "var(--cocoa-radius-lg)",
    boxShadow: "var(--cocoa-shadow-modal)",
    padding: "var(--cocoa-space-5)",
    display: "flex",
    flexDirection: "column",
    gap: "var(--cocoa-space-3)",
    fontFamily: "var(--cocoa-font)",
    outline: "none",
    boxSizing: "border-box",
    animation: visible ? "cocoa-scale-in var(--cocoa-duration-base) var(--cocoa-ease-out) both" : undefined
  };

  const node = (
    <div
      role="presentation"
      className="c22-dialog-layer"
      style={overlayStyle}
      onMouseDown={(event) => (event.target === event.currentTarget ? close() : undefined)}
      aria-hidden={!visible}
      data-cocoa="dialog-layer"
      data-open={visible ? "true" : "false"}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={hasDescription ? descriptionId : undefined}
        tabIndex={-1}
        className="c22-dialog cocoa-dialog"
        style={cardStyle}
        onKeyDown={handleKeyDown}
        data-cocoa="dialog"
        data-tone={tone}
        data-size={size}
      >
        <h2 id={titleId} className="c22-dialog__title" style={{ margin: 0, fontSize: "var(--cocoa-fs-title-2)", fontWeight: "var(--cocoa-fw-semibold)" as CSSProperties["fontWeight"], letterSpacing: "var(--cocoa-tracking-tight)", lineHeight: 1.25 }}>
          {title}
        </h2>
        {hasDescription ? (
          <div id={descriptionId} className="c22-dialog__body" style={{ display: "flex", flexDirection: "column", gap: "var(--cocoa-space-2)" }}>
            {description ? (
              <p className="c22-dialog__description" style={{ margin: 0, fontSize: "var(--cocoa-fs-body)", lineHeight: 1.5, color: "var(--cocoa-label-secondary)" }}>
                {description}
              </p>
            ) : null}
            {children}
          </div>
        ) : null}
        <div className="c22-dialog__actions" style={{ display: "flex", justifyContent: "flex-end", flexWrap: "wrap", gap: "var(--cocoa-space-2)", marginTop: "var(--cocoa-space-2)" }}>
          {hideCancel ? null : (
            <CocoaButton ref={cancelRef} variant="bordered" tone="neutral" onClick={close} disabled={isBusy}>
              {cancelLabel}
            </CocoaButton>
          )}
          <CocoaButton
            ref={confirmRef}
            variant="filled"
            tone={tone === "destructive" ? "destructive" : "accent"}
            type={confirmForm ? "submit" : "button"}
            form={confirmForm}
            onClick={confirmForm ? undefined : handleConfirm}
            loading={isBusy}
            disabled={confirmDisabled}
          >
            {confirmLabel}
          </CocoaButton>
        </div>
      </div>
    </div>
  );

  return createPortal(node, document.body);
}

export default CocoaDialog;
