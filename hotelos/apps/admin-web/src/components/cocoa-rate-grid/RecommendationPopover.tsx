// RecommendationPopover — explains one cell's price recommendation.
//
// Headline in plain language ("Sugerido 132 € (+12 %)"), "Por qué:" factors
// with their weight as bars (negative weights in red), missing signals in
// yellow, and three actions: Aceptar · Aceptar con ajuste (± stepper) ·
// Rechazar (with a short reason). Actions go to `onAction(cellKey, action,
// value?, reason?)`; the screen turns them into draft recommendation ops.
//
// «hold» / «no_data» (helpers.recommendationChoices): the engine proposes no
// new price, so there is no «Aceptar» — applying the engine's raw
// `suggestedPrice` under that label changed the cell by −5 % after a «Mantener
// el precio actual» (browser-ux-final#3). The hotelier can still «Fijar otro
// precio» (stepper starting from the CURRENT price) or reject.

import { useEffect, useMemo, useState } from "react";
import { CocoaButton } from "../cocoa/CocoaButton";
import { RECOMMENDATION_MISSING_LABELS, formatDateLong, formatMoney, formatPercent, recommendationChoices } from "./helpers";
import { RateGridPopover } from "./shared-ui";
import type { RecommendationPopoverProps } from "./types";

const REJECT_REASONS = ["Evento local no contemplado", "Estrategia comercial", "Contrato / tarifa negociada", "Datos insuficientes", "Otro"];

export function RecommendationPopover(props: RecommendationPopoverProps) {
  const { open, anchorRect, cellKey, recommendation: rec, currency, roomTypeName, ratePlanCode, date, onAction, onClose } = props;
  const choices = useMemo(() => recommendationChoices(rec), [rec]);
  const [mode, setMode] = useState<"main" | "adjust" | "reject">("main");
  const [adjusted, setAdjusted] = useState<number>(choices.adjustStart);
  const [reason, setReason] = useState(REJECT_REASONS[0]);
  const [reasonText, setReasonText] = useState("");

  useEffect(() => {
    if (!open) return;
    setMode("main");
    setAdjusted(choices.adjustStart);
    setReason(REJECT_REASONS[0]);
    setReasonText("");
  }, [open, choices.adjustStart]);

  const headline = useMemo(() => {
    if (rec.action === "no_data") return "Sin datos suficientes para recomendar";
    if (rec.action === "hold") return `Mantener el precio actual${rec.confidence < 40 ? " (confianza insuficiente para sugerir un cambio)" : ""}`;
    if (rec.suggestedPrice === null) return "Sin datos suficientes para recomendar";
    const verb = rec.action === "raise" ? "Subir" : "Bajar";
    const pct = rec.deltaPct !== null ? ` (${formatPercent(rec.deltaPct)})` : "";
    return `${verb} a ${formatMoney(rec.suggestedPrice, currency)}${pct}`;
  }, [rec, currency]);

  const maxWeight = Math.max(1, ...rec.reasons.map((r) => Math.abs(r.weight)));
  const confidenceTone = rec.confidence >= 70 ? "ok" : rec.confidence >= 40 ? "warn" : "danger";
  const step = Math.max(1, Math.round((choices.adjustStart || 100) * 0.01));

  return (
    <RateGridPopover open={open} anchorRect={anchorRect} onClose={onClose} ariaLabel={`Recomendación para ${roomTypeName} ${ratePlanCode} ${formatDateLong(date)}`} wide>
      <p className="crg-pop__title" style={{ marginBottom: 2 }}>
        {rec.action === "hold" || rec.suggestedPrice === null ? "Sin cambio sugerido" : `Sugerido ${formatMoney(rec.suggestedPrice, currency)}${rec.deltaPct !== null ? ` (${formatPercent(rec.deltaPct)})` : ""}`}
      </p>
      <p className="crg-pop__hint" style={{ margin: 0 }}>
        {roomTypeName} · {ratePlanCode} · {formatDateLong(date)} · ahora {formatMoney(rec.currentPrice, currency)}
      </p>
      <p style={{ margin: "8px 0 4px", fontSize: "var(--cocoa-fs-subheadline)" }}>
        {headline}{" "}
        <span className={`crg-badge crg-badge--${confidenceTone}`} title="Confianza de la recomendación">
          confianza {Math.round(rec.confidence)} %
        </span>
      </p>

      {rec.reasons.length ? (
        <div style={{ marginTop: 6 }}>
          <span className="crg-field__label">Por qué:</span>
          {rec.reasons.map((r) => (
            <div key={r.code} className="crg-factor">
              <span>
                {r.label}
                {r.value !== undefined && r.value !== null ? <span className="crg-before"> · {String(r.value)}</span> : null}
              </span>
              <span className="crg-before">{r.weight > 0 ? "+" : ""}{Math.round(r.weight * 100) / 100}</span>
              <span className={`crg-factor__bar${r.weight < 0 ? " crg-factor__bar--neg" : ""}`} aria-hidden="true">
                <i style={{ width: `${Math.round((Math.abs(r.weight) / maxWeight) * 100)}%` }} />
              </span>
            </div>
          ))}
        </div>
      ) : null}

      {rec.missing.length ? (
        <div style={{ marginTop: 6 }}>
          {rec.missing.map((m) => (
            <span key={m} className="crg-missing" title="Señal no disponible">
              ⚠ {RECOMMENDATION_MISSING_LABELS[m] ?? m}
            </span>
          ))}
        </div>
      ) : null}

      {rec.suggestedRestrictions && Object.keys(rec.suggestedRestrictions).length ? (
        <p className="crg-note" style={{ marginTop: 6 }}>
          También sugiere restricciones: {Object.entries(rec.suggestedRestrictions).filter(([, v]) => v).map(([k, v]) => `${k}${typeof v === "number" ? ` ${v}` : ""}`).join(", ")}
        </p>
      ) : null}

      <div className="crg-hr" />

      {mode === "main" ? (
        <div>
          {choices.holdLike ? (
            <p className="crg-note" style={{ margin: "0 0 6px" }}>
              No propone un precio nuevo: la celda se queda como está. Si quieres cambiarla, fija el precio a mano.
            </p>
          ) : null}
          <div className="crg-pop__row" style={{ justifyContent: "flex-end" }}>
            <CocoaButton variant="plain" size="small" tone="destructive" onClick={() => setMode("reject")}>
              Rechazar
            </CocoaButton>
            <CocoaButton variant="bordered" size="small" tone="neutral" onClick={() => setMode("adjust")} disabled={!choices.canAdjust}>
              {choices.adjustLabel}
            </CocoaButton>
            {choices.canAccept ? (
              <CocoaButton
                variant="filled"
                size="small"
                tone="accent"
                onClick={() => {
                  if (rec.suggestedPrice !== null) onAction(cellKey, "accept", rec.suggestedPrice);
                  onClose();
                }}
              >
                Aceptar
              </CocoaButton>
            ) : null}
          </div>
        </div>
      ) : mode === "adjust" ? (
        <div>
          <span className="crg-field__label">Precio ajustado</span>
          <div className="crg-pop__row" style={{ marginTop: 4 }}>
            <CocoaButton variant="bordered" size="small" tone="neutral" onClick={() => setAdjusted((v) => Math.max(0, Math.round((v - step) * 100) / 100))} aria-label={`Bajar ${step}`}>
              −{step}
            </CocoaButton>
            <input
              className="crg-input crg-input--big"
              style={{ width: 120, textAlign: "right" }}
              type="number"
              min={0}
              step="0.01"
              value={adjusted}
              aria-label="Precio ajustado"
              onChange={(e) => setAdjusted(Number(e.target.value))}
            />
            <CocoaButton variant="bordered" size="small" tone="neutral" onClick={() => setAdjusted((v) => Math.round((v + step) * 100) / 100)} aria-label={`Subir ${step}`}>
              +{step}
            </CocoaButton>
            <span className="crg-note">
              {rec.currentPrice ? formatPercent(((adjusted - rec.currentPrice) / rec.currentPrice) * 100) : ""} vs. actual
            </span>
          </div>
          <div className="crg-pop__actions">
            <button type="button" className="crg-pop__link" onClick={() => setMode("main")}>
              Volver
            </button>
            <CocoaButton
              variant="filled"
              size="small"
              tone="accent"
              disabled={!Number.isFinite(adjusted) || adjusted < 0}
              onClick={() => {
                onAction(cellKey, "adjust", Math.round(adjusted * 100) / 100);
                onClose();
              }}
            >
              Aplicar {formatMoney(adjusted, currency)}
            </CocoaButton>
          </div>
        </div>
      ) : (
        <div>
          <label className="crg-field">
            <span className="crg-field__label">Motivo del rechazo</span>
            <select className="crg-input" value={reason} onChange={(e) => setReason(e.target.value)}>
              {REJECT_REASONS.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </label>
          {reason === "Otro" ? (
            <label className="crg-field">
              <span className="crg-field__label">Detalle</span>
              <input className="crg-input" value={reasonText} onChange={(e) => setReasonText(e.target.value)} placeholder="Explica brevemente por qué" />
            </label>
          ) : null}
          <div className="crg-pop__actions">
            <button type="button" className="crg-pop__link" onClick={() => setMode("main")}>
              Volver
            </button>
            <CocoaButton
              variant="filled"
              size="small"
              tone="destructive"
              disabled={reason === "Otro" && reasonText.trim() === ""}
              onClick={() => {
                onAction(cellKey, "reject", undefined, reason === "Otro" ? reasonText.trim() : reason);
                onClose();
              }}
            >
              Rechazar recomendación
            </CocoaButton>
          </div>
        </div>
      )}
    </RateGridPopover>
  );
}

export default RecommendationPopover;
