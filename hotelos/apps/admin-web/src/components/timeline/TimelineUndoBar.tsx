// Live Timeline · barra de deshacer tras un arrastre (Tanda TL · lote TL-2).
//
// Callout de éxito (`role="status"`: ES el anuncio del cambio, la pantalla no
// lanza además un toast ni repite el mensaje en su live region) con la
// etiqueta del cambio (undoEntryFor del motor), la nota honesta de lo que
// deshacer no revierte (traslados en casa), «Deshacer» y Cerrar; cuenta atrás
// de `seconds` (8 por defecto) que al llegar a 0 llama a onDismiss. El
// intervalo se limpia al desmontar y al cambiar de entrada. Sin estilos inline.

import { useEffect, useRef, useState } from "react";
import { CocoaButton, CocoaCallout } from "../cocoa";
import { A11Y_LABELS, ACTIONS } from "../../content/actions";
import type { UndoEntry } from "../../screens/timeline/timeline-engine";

export type TimelineUndoBarProps = {
  entry: UndoEntry | null;
  onUndo(): Promise<void> | void;
  onDismiss(): void;
  /** Segundos de cuenta atrás (por defecto 8). */
  seconds?: number;
};

export const UNDO_LABEL = "Deshacer";
export const DEFAULT_UNDO_SECONDS = 8;

/** «Se puede deshacer el cambio en la reserva ABC123 durante 8 s». */
export function undoHint(code: string, secondsLeft: number): string {
  return `Se puede deshacer el cambio en la reserva ${code} durante ${Math.max(0, secondsLeft)} s`;
}

export function TimelineUndoBar({ entry, onUndo, onDismiss, seconds = DEFAULT_UNDO_SECONDS }: TimelineUndoBarProps) {
  // Reinicio de la cuenta atrás al cambiar de entrada (ajuste de estado
  // durante el render, sin un frame con el valor anterior).
  const [tracked, setTracked] = useState<UndoEntry | null>(entry);
  const [left, setLeft] = useState(seconds);
  if (entry !== tracked) {
    setTracked(entry);
    setLeft(seconds);
  }

  const dismissRef = useRef(onDismiss);
  useEffect(() => {
    dismissRef.current = onDismiss;
  }, [onDismiss]);

  useEffect(() => {
    if (!entry) return undefined;
    const timer = setInterval(() => setLeft((n) => Math.max(0, n - 1)), 1000);
    return () => clearInterval(timer);
  }, [entry, seconds]);

  useEffect(() => {
    if (entry && left === 0) dismissRef.current();
  }, [entry, left]);

  if (!entry) return null;

  return (
    <CocoaCallout
      tone="success"
      role="status"
      title={entry.label}
      actions={
        <>
          <CocoaButton variant="tinted" tone="accent" size="small" onClick={() => void onUndo()}>
            {UNDO_LABEL}
          </CocoaButton>
          <CocoaButton variant="plain" tone="neutral" size="small" aria-label={A11Y_LABELS.close} onClick={onDismiss}>
            {ACTIONS.close}
          </CocoaButton>
        </>
      }
    >
      {undoHint(entry.code, left)}
      {entry.note ? ` · ${entry.note}` : ""}
    </CocoaCallout>
  );
}

export default TimelineUndoBar;
