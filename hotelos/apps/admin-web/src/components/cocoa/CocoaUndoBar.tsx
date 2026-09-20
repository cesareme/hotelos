// CocoaUndoBar — the «Deshacer» bar of Cocoa 22 (Tanda UX-1 · U4,
// docs/design/UX-RECEPCION-FEEL.md §4 «CocoaUndoBar», P4 «Deshacer antes que
// confirmar», R15). Generalised from the Live Timeline's TimelineUndoBar
// (Tanda TL · TL-2), which now re-exports this component.
//
// Callout of success (`role="status"`: it IS the announcement of the change —
// the screen neither fires a toast nor repeats the message in a live region,
// one live status per page) with the label of the change, the honest note of
// what undo does not revert, «Deshacer ⌘Z» and «Cerrar»; countdown of
// `seconds` (8 by default) that calls onDismiss at 0. The interval is cleared
// on unmount and when the entry changes; ⌘Z / Ctrl+Z undoes while an entry is
// alive (never inside a text field). One entry alive at a time: a new entry
// REPLACES the previous one and restarts the countdown (R15). No inline
// styles: `c22-undo-bar` on the callout.

import { useEffect, useRef, useState } from "react";
import { A11Y_LABELS, ACTIONS } from "../../content/actions";
import { CocoaButton } from "./CocoaButton";
import { CocoaCallout } from "./CocoaCallout";
import { CocoaKbd } from "./CocoaKbd";

export type CocoaUndoEntry = {
  /** Title of the bar («Reserva ABC123 movida a la 204»). */
  label: string;
  /** Reservation (or object) code the countdown names; optional. */
  code?: string;
  /** Own countdown text; replaces `undoHint(code, secondsLeft)` when given. */
  hint?: string;
  /** Honest note of what undo does NOT revert (in-house moves). */
  note?: string;
};

export type CocoaUndoBarProps = {
  entry: CocoaUndoEntry | null;
  onUndo(): Promise<void> | void;
  onDismiss(): void;
  /** Seconds of countdown (8 by default). */
  seconds?: number;
};

export const UNDO_LABEL = "Deshacer";
export const DEFAULT_UNDO_SECONDS = 8;

/** «Se puede deshacer el cambio en la reserva ABC123 durante 8 s» (pure); without code, «Se puede deshacer durante 8 s». */
export function undoHint(code: string | undefined, secondsLeft: number): string {
  const seconds = Math.max(0, secondsLeft);
  return code ? `Se puede deshacer el cambio en la reserva ${code} durante ${seconds} s` : `Se puede deshacer durante ${seconds} s`;
}

/** ⌘Z / Ctrl+Z (pure): never with Shift (redo) or Alt. */
export function isUndoShortcut(event: { key: string; metaKey: boolean; ctrlKey: boolean; shiftKey?: boolean; altKey?: boolean }): boolean {
  return (event.key === "z" || event.key === "Z") && (event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey;
}

/** Whether a key event target owns its own ⌘Z (text fields, editable nodes) (pure; no DOM needed). */
export function isEditableTarget(target: unknown): boolean {
  const node = target as { tagName?: string; isContentEditable?: boolean } | null | undefined;
  if (!node || typeof node !== "object") return false;
  if (node.isContentEditable) return true;
  const tag = (node.tagName ?? "").toUpperCase();
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

/** Label of the shortcut chip (pure): «⌘Z» on Apple platforms, «Ctrl+Z» elsewhere. */
export function undoShortcutLabel(isApple: boolean): string {
  return isApple ? "⌘Z" : "Ctrl+Z";
}

/** Apple platform detection (pure over the navigator fields). */
export function isApplePlatform(nav?: { platform?: string; userAgent?: string } | null): boolean {
  const platform = nav?.platform ?? "";
  const userAgent = nav?.userAgent ?? "";
  return /Mac|iPhone|iPad|iPod/.test(platform) || /Mac OS X|iPhone|iPad/.test(userAgent);
}

export function CocoaUndoBar({ entry, onUndo, onDismiss, seconds = DEFAULT_UNDO_SECONDS }: CocoaUndoBarProps) {
  // Countdown restart when the entry changes (state adjusted during render:
  // no frame with the previous value). A new entry replaces the previous one.
  const [tracked, setTracked] = useState<CocoaUndoEntry | null>(entry);
  const [left, setLeft] = useState(seconds);
  // Pausa con el ratón encima o el foco dentro (como el toast, UX1-REV-09). Se
  // declara antes del reinicio porque un cambio de entrada también la levanta:
  // al pulsar «Deshacer» la barra se desmonta bajo el puntero sin `mouseleave`
  // y la SIGUIENTE entrada nacía pausada para siempre (corrector UX2-REV-04).
  const [paused, setPaused] = useState(false);
  if (entry !== tracked) {
    setTracked(entry);
    setLeft(seconds);
    if (paused) setPaused(false);
  }

  const dismissRef = useRef(onDismiss);
  const undoRef = useRef(onUndo);
  useEffect(() => {
    dismissRef.current = onDismiss;
    undoRef.current = onUndo;
  }, [onDismiss, onUndo]);

  useEffect(() => {
    if (!entry || paused) return undefined;
    const timer = setInterval(() => setLeft((n) => Math.max(0, n - 1)), 1000);
    return () => clearInterval(timer);
  }, [entry, seconds, paused]);

  useEffect(() => {
    if (entry && left === 0) dismissRef.current();
  }, [entry, left]);

  // ⌘Z while the entry is alive (not inside a text field, not already handled).
  useEffect(() => {
    if (!entry || typeof window === "undefined") return undefined;
    const handler = (event: KeyboardEvent) => {
      if (event.defaultPrevented || !isUndoShortcut(event) || isEditableTarget(event.target)) return;
      event.preventDefault();
      void undoRef.current();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [entry]);

  if (!entry) return null;

  const shortcut = undoShortcutLabel(isApplePlatform(typeof navigator !== "undefined" ? navigator : null));

  return (
    <div className="c22-undo-bar__host" onMouseEnter={() => setPaused(true)} onMouseLeave={() => setPaused(false)} onFocus={() => setPaused(true)} onBlur={(event) => { if (!(event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget))) setPaused(false); }} data-paused={paused ? "true" : undefined}>
    <CocoaCallout
      tone="success"
      role="status"
      title={entry.label}
      className="c22-undo-bar"
      actions={
        <>
          <CocoaButton variant="tinted" tone="accent" size="small" className="c22-undo-bar__undo" title={`${UNDO_LABEL} (${shortcut})`} onClick={() => void onUndo()}>
            {UNDO_LABEL}
            <CocoaKbd>{shortcut}</CocoaKbd>
          </CocoaButton>
          <CocoaButton variant="plain" tone="neutral" size="small" aria-label={A11Y_LABELS.close} onClick={onDismiss}>
            {ACTIONS.close}
          </CocoaButton>
        </>
      }
    >
      {/* La cuenta atrás cambia cada segundo: fuera del anuncio (aria-hidden) para que el lector lea el título una sola vez (UX1-REV-09). */}
      <span aria-hidden="true">
        {entry.hint ?? undoHint(entry.code, left)}
        {entry.note ? ` · ${entry.note}` : ""}
      </span>
    </CocoaCallout>
    </div>
  );
}

export default CocoaUndoBar;
