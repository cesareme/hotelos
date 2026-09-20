import { useCallback, useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { t } from "../checkin/wizard";
import type { Lang } from "../checkin/wizard";

// Tanda CHK · W4-C (diseño §4a paso 5): canvas táctil de firma. Mismo contrato
// de salida que el SignaturePad de admin-web (`components/cocoa-extras/SignaturePad.tsx`,
// lote W4-B) pero fichero propio del portal: `SignaturePayload { pngBase64, svg,
// strokeMeta { points, durationMs, bbox } }`, que es exactamente el cuerpo de
// POST /guest-portal/check-in/guests/:id/signature (GuestSignatureSchema).
// Pointer events con `t`, `x`, `y` (sin presión); el trazo se exporta a PNG por
// `canvas.toDataURL` y a SVG por polilíneas.

export type SignaturePayload = {
  pngBase64: string;
  svg: string;
  strokeMeta: { points: number; durationMs: number; bbox: { x: number; y: number; width: number; height: number } };
};

type Point = { t: number; x: number; y: number };

export type SignaturePadProps = {
  lang: Lang;
  disabled?: boolean;
  /** null cuando el lienzo está vacío. */
  onChange: (payload: SignaturePayload | null) => void;
  height?: number;
};

const STROKE_WIDTH = 2.2;

function buildSvg(strokes: Point[][], width: number, height: number): string {
  const paths = strokes
    .filter((stroke) => stroke.length > 0)
    .map((stroke) => {
      const points = stroke.map((point) => `${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(" ");
      return stroke.length === 1 ? `<circle cx="${stroke[0]!.x.toFixed(1)}" cy="${stroke[0]!.y.toFixed(1)}" r="${STROKE_WIDTH / 2}" fill="#1a1a1a"/>` : `<polyline points="${points}" fill="none" stroke="#1a1a1a" stroke-width="${STROKE_WIDTH}" stroke-linecap="round" stroke-linejoin="round"/>`;
    })
    .join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${paths}</svg>`;
}

function buildMeta(strokes: Point[][]): SignaturePayload["strokeMeta"] {
  const all = strokes.flat();
  if (all.length === 0) return { points: 0, durationMs: 0, bbox: { x: 0, y: 0, width: 0, height: 0 } };
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let minT = Infinity;
  let maxT = -Infinity;
  for (const point of all) {
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
    minT = Math.min(minT, point.t);
    maxT = Math.max(maxT, point.t);
  }
  return { points: all.length, durationMs: Math.max(0, Math.round(maxT - minT)), bbox: { x: Math.round(minX), y: Math.round(minY), width: Math.round(maxX - minX), height: Math.round(maxY - minY) } };
}

export function SignaturePad({ lang, disabled = false, onChange, height = 180 }: SignaturePadProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const strokesRef = useRef<Point[][]>([]);
  const drawingRef = useRef(false);
  const [empty, setEmpty] = useState(true);

  // Resize the backing store to the CSS size × devicePixelRatio and redraw.
  const redraw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const ratio = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
    const width = Math.max(1, Math.round(rect.width));
    if (canvas.width !== width * ratio || canvas.height !== height * ratio) {
      canvas.width = width * ratio;
      canvas.height = height * ratio;
    }
    const context = canvas.getContext("2d");
    if (!context) return;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, width, height);
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, width, height);
    context.lineWidth = STROKE_WIDTH;
    context.lineCap = "round";
    context.lineJoin = "round";
    context.strokeStyle = "#1a1a1a";
    for (const stroke of strokesRef.current) {
      if (stroke.length === 0) continue;
      context.beginPath();
      context.moveTo(stroke[0]!.x, stroke[0]!.y);
      for (const point of stroke.slice(1)) context.lineTo(point.x, point.y);
      if (stroke.length === 1) context.lineTo(stroke[0]!.x + 0.1, stroke[0]!.y + 0.1);
      context.stroke();
    }
  }, [height]);

  useEffect(() => {
    redraw();
    if (typeof window === "undefined") return;
    const onResize = () => redraw();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [redraw]);

  function emit() {
    const canvas = canvasRef.current;
    const strokes = strokesRef.current;
    const hasInk = strokes.some((stroke) => stroke.length > 0);
    setEmpty(!hasInk);
    if (!canvas || !hasInk) {
      onChange(null);
      return;
    }
    const rect = canvas.getBoundingClientRect();
    const dataUrl = canvas.toDataURL("image/png");
    const pngBase64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
    onChange({ pngBase64, svg: buildSvg(strokes, Math.round(rect.width), height), strokeMeta: buildMeta(strokes) });
  }

  function pointOf(event: ReactPointerEvent<HTMLCanvasElement>): Point {
    const rect = event.currentTarget.getBoundingClientRect();
    return { t: event.timeStamp, x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  function onPointerDown(event: ReactPointerEvent<HTMLCanvasElement>) {
    if (disabled) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    drawingRef.current = true;
    strokesRef.current.push([pointOf(event)]);
    redraw();
  }

  function onPointerMove(event: ReactPointerEvent<HTMLCanvasElement>) {
    if (!drawingRef.current || disabled) return;
    event.preventDefault();
    const stroke = strokesRef.current[strokesRef.current.length - 1];
    if (!stroke) return;
    stroke.push(pointOf(event));
    redraw();
  }

  function onPointerUp(event: ReactPointerEvent<HTMLCanvasElement>) {
    if (!drawingRef.current) return;
    event.preventDefault();
    drawingRef.current = false;
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // ignore
    }
    emit();
  }

  function clear() {
    strokesRef.current = [];
    redraw();
    emit();
  }

  return (
    <div className={`gp-signature${disabled ? " is-disabled" : ""}`}>
      <canvas
        ref={canvasRef}
        className="gp-signature-canvas"
        height={height}
        role="img"
        aria-label={t(lang, "signHere")}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onPointerLeave={onPointerUp}
      />
      {empty ? <span className="gp-signature-placeholder" aria-hidden>{t(lang, "signHere")}</span> : null}
      <div className="gp-signature-tools">
        <button type="button" className="gp-link" onClick={clear} disabled={disabled || empty}>
          {t(lang, "clearSignature")}
        </button>
      </div>
    </div>
  );
}
