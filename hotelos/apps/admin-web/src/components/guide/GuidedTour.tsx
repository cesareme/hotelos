import { useCallback, useEffect, useState, type CSSProperties } from "react";
import type { TourStep } from "./guideContent";

type Rect = { top: number; left: number; width: number; height: number };

function getRect(selector?: string): Rect | null {
  if (!selector) return null;
  const el = document.querySelector(selector) as HTMLElement | null;
  if (!el) return null;
  const r = el.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) return null;
  const style = window.getComputedStyle(el);
  if (style.visibility === "hidden" || style.display === "none" || Number(style.opacity) === 0) return null;
  if (r.bottom < 0 || r.right < 0 || r.left > window.innerWidth || r.top > window.innerHeight) return null;
  return { top: r.top, left: r.left, width: r.width, height: r.height };
}

function navigate(screen: string) {
  window.dispatchEvent(new CustomEvent("hotelos-nav", { detail: screen }));
}

/**
 * A focused, dismissible guided tour. Each step can: spotlight a real element
 * (dims the rest), open a screen first (navigateTo) and narrate it without
 * dimming, or show a centered intro card. Robust on responsive layouts: if a
 * target isn't found, the step degrades gracefully to a pinned callout.
 */
export function GuidedTour(props: {
  steps: TourStep[];
  tourTitle?: string;
  onClose: () => void;
  onComplete: () => void;
}) {
  const { steps, tourTitle, onClose, onComplete } = props;
  const [index, setIndex] = useState(0);
  const [rect, setRect] = useState<Rect | null>(null);
  const step = steps[index];
  const isLast = index >= steps.length - 1;

  // On each step: optionally navigate, then locate the spotlight target. We poll
  // briefly because navigation renders the destination screen asynchronously.
  useEffect(() => {
    if (!step) return undefined;
    let cancelled = false;
    if (step.navigateTo) navigate(step.navigateTo);
    setRect(null);
    if (!step.selector) return undefined;

    let tries = 0;
    function tick() {
      if (cancelled) return;
      const r = getRect(step!.selector);
      if (r) {
        setRect(r);
        return;
      }
      tries += 1;
      if (tries < 18) setTimeout(tick, 100);
    }
    const t = setTimeout(tick, step.navigateTo ? 140 : 0);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [step]);

  const recompute = useCallback(() => {
    if (step?.selector) setRect(getRect(step.selector));
  }, [step]);

  useEffect(() => {
    window.addEventListener("resize", recompute);
    window.addEventListener("scroll", recompute, true);
    return () => {
      window.removeEventListener("resize", recompute);
      window.removeEventListener("scroll", recompute, true);
    };
  }, [recompute]);

  const next = useCallback(() => {
    if (isLast) {
      onComplete();
      return;
    }
    setIndex((i) => Math.min(i + 1, steps.length - 1));
  }, [isLast, onComplete, steps.length]);

  const prev = useCallback(() => setIndex((i) => Math.max(i - 1, 0)), []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowRight") next();
      else if (e.key === "ArrowLeft") prev();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [next, prev, onClose]);

  if (!step) return null;

  const pad = 8;
  const spotlight: Rect | null = rect
    ? { top: rect.top - pad, left: rect.left - pad, width: rect.width + pad * 2, height: rect.height + pad * 2 }
    : null;

  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const calloutW = Math.min(360, vw - 32);

  // Mode: centered intro (dim), spotlight (dim hole), or narrate (no dim, pinned).
  const mode: "center" | "spotlight" | "narrate" = step.center ? "center" : spotlight ? "spotlight" : "narrate";

  const calloutStyle: CSSProperties = { width: calloutW };
  if (mode === "spotlight" && spotlight) {
    const below = spotlight.top + spotlight.height + 12;
    const roomBelow = vh - below > 220;
    let left = spotlight.left + spotlight.width / 2 - calloutW / 2;
    left = Math.max(16, Math.min(left, vw - calloutW - 16));
    calloutStyle.left = left;
    if (roomBelow) calloutStyle.top = below;
    else calloutStyle.bottom = vh - spotlight.top + 12;
  } else if (mode === "narrate") {
    calloutStyle.left = "50%";
    calloutStyle.bottom = 24;
    calloutStyle.transform = "translateX(-50%)";
  } else {
    calloutStyle.left = "50%";
    calloutStyle.top = "50%";
    calloutStyle.transform = "translate(-50%, -50%)";
  }

  return (
    <div className="guide-tour-root" role="dialog" aria-modal="true" aria-label={tourTitle ?? "Recorrido guiado"}>
      {/* Click-guard blocks accidental interaction; dims only for center/spotlight modes. */}
      <div className={`guide-clickguard${mode === "center" ? " dim" : ""}`} />
      {mode === "spotlight" && spotlight ? (
        <div
          className="guide-spotlight"
          style={{ top: spotlight.top, left: spotlight.left, width: spotlight.width, height: spotlight.height }}
        />
      ) : null}
      <div className={`guide-callout guide-callout-${mode}`} style={calloutStyle}>
        <div className="guide-callout-head">
          <span className="guide-callout-step">
            {tourTitle ? <span className="guide-callout-tour">{tourTitle}</span> : null}
            Paso {index + 1} de {steps.length}
          </span>
          <button type="button" className="guide-callout-skip" onClick={onClose}>Saltar</button>
        </div>
        <h3 className="guide-callout-title">{step.title}</h3>
        <p className="guide-callout-body">{step.body}</p>
        <div className="guide-callout-foot">
          <div className="guide-dots" aria-hidden>
            {steps.map((_, i) => (
              <span key={i} className={`guide-dot${i === index ? " active" : ""}`} />
            ))}
          </div>
          <div className="guide-callout-actions">
            {index > 0 ? (
              <button type="button" className="ghost" onClick={prev}>Atrás</button>
            ) : null}
            <button type="button" className="primary" onClick={next}>
              {isLast ? "Entendido" : "Siguiente"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
