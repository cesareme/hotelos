// RateGridStatusBar — bottom bar of the rate grid editor, built on
// CocoaActionBar (Cocoa 22 · ola 5 · lote 5-A; plan §2.2 and R12: the local
// sticky bar and its mobile.css override are gone, the primitive owns the
// placement, the safe-area and the toast clearance).
//
//   status    «12 cambios sin guardar · 3 tipos · 2 planes» (aria-live so
//             screen readers hear the count change), the saved-but-unsent
//             chip with «Enviar a canales», the last save / publish and
//             «Estado de sincronización no disponible»
//   extra     Deshacer · Rehacer · Descartar (confirmation when > 20 changes)
//   secondary «Guardar sin enviar a canales»
//   primary   «Revisar y publicar», or «Enviar a canales» when the draft is
//             empty and saved cells were never sent — Ctrl/⌘+Enter runs it
//   restore   the autosaved-draft banner («Tienes N cambios sin guardar de
//             ayer · Restaurar / Descartar») is a CocoaCallout above the bar
//   phone     the bar is fixed with the two actions only (§4.2 D25): the
//             status and the history buttons move to a row in flow above it
//   toast     `publishToastOffset` writes `--hotelos-toast-offset` (Toast.tsx
//             reads it) so a two-row bar is never covered by a toast
//
// Wording: a save writes rate_days for real (the PMS sells the new price at
// once), so the bar never calls it "borrador" once saved. Saved-but-unsent
// cells (`pendingPush`) get their own chip, and "Revisar y publicar" stays
// enabled for them even with an empty draft.

import { useMemo, useState } from "react";
import { CocoaActionBar, CocoaBadge, CocoaButton, CocoaCallout, CocoaDialog, useIsNarrow } from "../cocoa";
import { describeSavedAt } from "./draft-store";
import { formatDateTime, pluralize } from "./helpers";
import { summarizeDraft } from "./rate-grid-utils";
import type { RateGridStatusBarProps } from "./types";

const DISCARD_CONFIRM_THRESHOLD = 20;

export function RateGridStatusBar(props: RateGridStatusBarProps) {
  const { draft, canUndo, canRedo, onUndo, onRedo, onDiscard, onSaveDraft, onReviewAndPublish, saving = false, lastSavedAt, lastPublishedAt, restorable, onRestore, onDiscardRestorable, readOnly = false, pendingPush, onSendPending, syncUnavailable = false } = props;
  const summary = useMemo(() => summarizeDraft(draft), [draft]);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const isNarrow = useIsNarrow();
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
  if (saved) meta.push(`Guardado en ehotelOS: ${saved}`);
  if (published) meta.push(`Última publicación: ${published}`);

  const handleDiscard = () => {
    if (summary.cells > DISCARD_CONFIRM_THRESHOLD) setConfirmDiscard(true);
    else onDiscard();
  };

  const status = (
    <span className="crg-bar" role="status" aria-live="polite" aria-atomic="true">
      {has ? (
        <CocoaBadge tone="warning" variant="tinted" uppercase={false}>
          {summary.cells > 0 ? summary.cells : rejected}
        </CocoaBadge>
      ) : null}
      <span className="crg-bar__text">{text}</span>
      {hasPending && pendingPush ? (
        <span className="crg-bar__pending" title="Guardadas en ehotelOS (ya vigentes en el PMS) pero los canales siguen con el valor anterior">
          {pluralize(pendingPush.count, "celda guardada sin enviar a canales", "celdas guardadas sin enviar a canales")}
          {onSendPending ? (
            <CocoaButton variant="plain" size="small" tone="accent" onClick={onSendPending} disabled={saving || readOnly}>
              Enviar a canales
            </CocoaButton>
          ) : null}
        </span>
      ) : null}
      {meta.map((m) => (
        <span key={m} className="crg-bar__meta">
          · {m}
        </span>
      ))}
      {syncUnavailable ? (
        <CocoaBadge tone="warning" title="El servidor no pudo leer el estado de las entregas por celda (respuesta degradada): las celdas no están «sin enviar», simplemente no se sabe. Recarga para volver a intentarlo.">
          Estado de sincronización no disponible
        </CocoaBadge>
      ) : null}
    </span>
  );

  const history = (
    <>
      <CocoaButton variant="plain" size="small" tone="neutral" onClick={onUndo} disabled={!canUndo || readOnly} title="Deshacer (Ctrl+Z)">
        Deshacer
      </CocoaButton>
      <CocoaButton variant="plain" size="small" tone="neutral" onClick={onRedo} disabled={!canRedo || readOnly} title="Rehacer (Ctrl+Mayús+Z)">
        Rehacer
      </CocoaButton>
      <CocoaButton variant="plain" size="small" tone="destructive" onClick={handleDiscard} disabled={!has || saving || readOnly}>
        Descartar
      </CocoaButton>
    </>
  );

  return (
    <>
      {restorable && restorable.count > 0 ? (
        <CocoaCallout
          tone="warning"
          role="status"
          actions={
            <>
              <CocoaButton variant="tinted" size="small" tone="accent" onClick={() => onRestore?.()}>
                Restaurar
              </CocoaButton>
              <CocoaButton variant="plain" size="small" tone="neutral" onClick={() => onDiscardRestorable?.()}>
                Descartar
              </CocoaButton>
            </>
          }
        >
          Tienes {pluralize(restorable.count, "cambio sin guardar", "cambios sin guardar")} {describeSavedAt(restorable.savedAt)}.
        </CocoaCallout>
      ) : null}
      {isNarrow ? (
        <div className="crg-bar__phone">
          {status}
          <div className="crg-bar__history">{history}</div>
        </div>
      ) : null}
      <CocoaActionBar
        aria-label="Guardado y publicación de la parrilla"
        status={isNarrow ? undefined : status}
        extra={isNarrow ? undefined : history}
        secondary={{
          label: "Guardar sin enviar a canales",
          onClick: onSaveDraft,
          disabled: !has || saving || readOnly,
          loading: saving,
          title: "Guarda los cambios en ehotelOS (el PMS vende el precio nuevo al momento) sin enviarlos a los canales"
        }}
        primary={{
          label: !has && hasPending ? "Enviar a canales" : "Revisar y publicar",
          onClick: onReviewAndPublish,
          disabled: (!has && !hasPending) || saving || readOnly,
          title: !has && hasPending ? "Enviar a los canales las celdas guardadas sin enviar" : "Revisa los cambios y publica en los canales"
        }}
        publishToastOffset
      />
      <CocoaDialog
        open={confirmDiscard}
        onClose={() => setConfirmDiscard(false)}
        tone="destructive"
        title={`¿Descartar ${pluralize(summary.cells, "cambio", "cambios")}?`}
        description="Se perderán todos los cambios sin guardar de este borrador. Esta acción no se puede deshacer."
        confirmLabel="Descartar cambios"
        cancelLabel="Cancelar"
        onConfirm={() => {
          setConfirmDiscard(false);
          onDiscard();
        }}
      />
    </>
  );
}

export default RateGridStatusBar;
