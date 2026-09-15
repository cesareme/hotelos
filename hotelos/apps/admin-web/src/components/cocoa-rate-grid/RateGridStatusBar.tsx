// RateGridStatusBar — bottom bar of the rate grid editor (sticky).
//
// "12 cambios sin guardar · 3 tipos · 2 planes" (aria-live so screen readers
// hear the count change), Deshacer / Rehacer, Descartar (confirmation when
// > 20 changes), "Guardar sin enviar a canales" and the primary "Revisar y
// publicar". Also hosts the restore banner for an autosaved draft found in
// localStorage: "Tienes N cambios sin guardar de ayer · Restaurar / Descartar".
//
// Wording: a save writes rate_days for real (the PMS sells the new price at
// once), so the bar never calls it "borrador" once saved. Saved-but-unsent
// cells (`pendingPush`) get their own chip with "Enviar a canales", and
// "Revisar y publicar" stays enabled for them even with an empty draft.
//
// Toast clearance: the bar publishes its rendered height as the CSS variable
// `--hotelos-toast-offset` (Toast.tsx reads it, helpers.toastOffsetForBar does
// the math) so a two-row bar is never covered by a toast; unmounting removes
// the variable and the host's 120 px fallback applies again.

import { useEffect, useMemo, useRef, useState } from "react";
import { CocoaButton } from "../cocoa/CocoaButton";
import { CocoaAlert } from "../cocoa-extras/CocoaAlert";
import { describeSavedAt } from "./draft-store";
import { formatDateTime, pluralize, toastOffsetForBar } from "./helpers";
import { summarizeDraft } from "./rate-grid-utils";
import type { RateGridStatusBarProps } from "./types";

const DISCARD_CONFIRM_THRESHOLD = 20;

export function RateGridStatusBar(props: RateGridStatusBarProps) {
  const { draft, canUndo, canRedo, onUndo, onRedo, onDiscard, onSaveDraft, onReviewAndPublish, saving = false, lastSavedAt, lastPublishedAt, restorable, onRestore, onDiscardRestorable, readOnly = false, pendingPush, onSendPending, syncUnavailable = false } = props;
  const summary = useMemo(() => summarizeDraft(draft), [draft]);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  // Rejected recommendations are part of the draft too (cierre 2026-09-15):
  // a draft with rejections only has nothing to write, but «Guardar» must
  // still be reachable so the decisions get recorded (recommendations/apply
  // without a bulk-update); otherwise the bar reads «Sin cambios» and the
  // rejections are silently lost.
  const rejected = draft.rejectedRecommendations.size;
  const has = summary.cells > 0 || rejected > 0;
  const hasPending = Boolean(pendingPush && pendingPush.count > 0);

  const text =
    summary.cells > 0
      ? `${pluralize(summary.cells, "cambio sin guardar", "cambios sin guardar")} · ${pluralize(summary.roomTypes, "tipo", "tipos")} · ${pluralize(summary.ratePlans, "plan", "planes")}${rejected > 0 ? ` · ${pluralize(rejected, "recomendación rechazada", "recomendaciones rechazadas")}` : ""}`
      : rejected > 0
        ? `${pluralize(rejected, "recomendación rechazada", "recomendaciones rechazadas")} sin registrar`
        : hasPending
          ? "Sin cambios sin guardar"
          : "Sin cambios pendientes";

  const meta: string[] = [];
  const saved = formatDateTime(lastSavedAt);
  const published = formatDateTime(lastPublishedAt);
  if (saved) meta.push(`Guardado en Anfitorio: ${saved}`);
  if (published) meta.push(`Última publicación: ${published}`);

  const handleDiscard = () => {
    if (summary.cells > DISCARD_CONFIRM_THRESHOLD) setConfirmDiscard(true);
    else onDiscard();
  };

  const barRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = barRef.current;
    if (!el || typeof document === "undefined") return;
    const root = document.documentElement;
    const publish = () => root.style.setProperty("--hotelos-toast-offset", `${toastOffsetForBar(el.getBoundingClientRect().height)}px`);
    publish();
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(publish) : null;
    observer?.observe(el);
    return () => {
      observer?.disconnect();
      root.style.removeProperty("--hotelos-toast-offset");
    };
  }, []);

  return (
    <div className="crg-status" ref={barRef}>
      {restorable && restorable.count > 0 ? (
        <div className="crg-status__restore" role="status">
          <span>
            Tienes {pluralize(restorable.count, "cambio sin guardar", "cambios sin guardar")} {describeSavedAt(restorable.savedAt)}.
          </span>
          <CocoaButton variant="tinted" size="small" tone="accent" onClick={() => onRestore?.()}>
            Restaurar
          </CocoaButton>
          <CocoaButton variant="plain" size="small" tone="neutral" onClick={() => onDiscardRestorable?.()}>
            Descartar
          </CocoaButton>
        </div>
      ) : null}
      <div className="crg-status__info" role="status" aria-live="polite" aria-atomic="true">
        {has ? <span className="crg-status__count">{summary.cells > 0 ? summary.cells : rejected}</span> : null}
        <span className="crg-status__text">{text}</span>
        {hasPending && pendingPush ? (
          <span className="crg-status__pending" title="Guardadas en Anfitorio (ya vigentes en el PMS) pero los canales siguen con el valor anterior">
            {pluralize(pendingPush.count, "celda guardada sin enviar a canales", "celdas guardadas sin enviar a canales")}
            {onSendPending ? (
              <CocoaButton variant="plain" size="small" tone="accent" onClick={onSendPending} disabled={saving || readOnly}>
                Enviar a canales
              </CocoaButton>
            ) : null}
          </span>
        ) : null}
        {meta.map((m) => (
          <span key={m} className="crg-status__meta">
            · {m}
          </span>
        ))}
        {syncUnavailable ? (
          <span className="crg-status__meta crg-badge crg-badge--warn" title="El servidor no pudo leer el estado de las entregas por celda (respuesta degradada): las celdas no están «sin enviar», simplemente no se sabe. Recarga para volver a intentarlo.">
            Estado de sincronización no disponible
          </span>
        ) : null}
      </div>
      <div className="crg-status__actions">
        <CocoaButton variant="plain" size="small" tone="neutral" onClick={onUndo} disabled={!canUndo || readOnly} aria-label="Deshacer (Ctrl+Z)">
          ↶ Deshacer
        </CocoaButton>
        <CocoaButton variant="plain" size="small" tone="neutral" onClick={onRedo} disabled={!canRedo || readOnly} aria-label="Rehacer (Ctrl+Mayús+Z)">
          ↷ Rehacer
        </CocoaButton>
        <CocoaButton variant="plain" size="small" tone="destructive" onClick={handleDiscard} disabled={!has || saving || readOnly}>
          Descartar
        </CocoaButton>
        <span title="Guarda los cambios en Anfitorio (el PMS vende el precio nuevo al momento) sin enviarlos a los canales" style={{ display: "inline-flex" }}>
          <CocoaButton variant="bordered" size="small" tone="neutral" onClick={onSaveDraft} disabled={!has || saving || readOnly} loading={saving}>
            Guardar sin enviar a canales
          </CocoaButton>
        </span>
        <span title={!has && hasPending ? "Enviar a los canales las celdas guardadas sin enviar" : "Revisa el diff y publica en los canales"} style={{ display: "inline-flex" }}>
          <CocoaButton variant="filled" size="small" tone="accent" onClick={onReviewAndPublish} disabled={(!has && !hasPending) || saving || readOnly}>
            {!has && hasPending ? "Enviar a canales" : "Revisar y publicar"}
          </CocoaButton>
        </span>
      </div>
      <CocoaAlert
        open={confirmDiscard}
        type="warning"
        title={`¿Descartar ${summary.cells} cambios?`}
        message="Se perderán todos los cambios sin guardar de este borrador. Esta acción no se puede deshacer."
        primaryAction={{
          label: "Descartar cambios",
          destructive: true,
          onClick: () => {
            setConfirmDiscard(false);
            onDiscard();
          }
        }}
        cancelAction={{ label: "Cancelar", onClick: () => setConfirmDiscard(false) }}
        onClose={() => setConfirmDiscard(false)}
      />
    </div>
  );
}

export default RateGridStatusBar;
